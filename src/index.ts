#!/usr/bin/env node

/**
 * Paragon MLS MCP Server
 *
 * Fetches real estate listings from Paragon MLS (paragonrels.com / fnimls.com)
 * APIs and provides tools for property analysis, four-square rental analysis,
 * and structured data extraction.
 *
 * Security hardening:
 *   - Input validation via Zod schemas on all tool inputs
 *   - No secrets in responses (addresses/MLS numbers only, never auth tokens)
 *   - Timeout guards on all HTTP requests
 *   - No filesystem writes — all output is returned as structured data
 *   - Sanitized URLs in error messages
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface PropertyInfo {
  address: string;
  city: string;
  state: string;
  zip: string;
  fullAddress: string;
  mlsNumber: string;
  priceCurrent: number | null;
  pricePrev: number | null;
  offerPriceDefault: number | null;
  beds: number | null;
  bathsFull: number | null;
  bathsPart: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  style: string | null;
  type: string | null;
  status: string | null;
  publicRemarks: string | null;
  rents: Array<number | null>;
  laundryIncome: number | null;
  storageIncome: number | null;
  miscIncome: number | null;
  totalTaxes: number | null;
  schoolTaxes: number | null;
  hoa: number | null;
  unitCount: number | null;
  styleTypeBedBath: string | null;
  mlsLink: string;
  googleMapsLink: string;
}

interface FourSquareRow {
  address: string;
  mlsNumber: string;
  offerPrice: number;
  totalMonthlyCashFlow: number;
  cashOnCashReturn: number;
  capitalizationRate: number;
  debtServiceCoverageRatio: number | null;
  totalAnnualizedReturn: number;
  returnOnInvestment: number;
  returnOnEquity: number;
  internalRateOfReturn: number | null;
  sheetColumns: Record<string, string | number | null>;
}

interface VbScenario {
  monthsToPayoff: number | null;
  yearsToPayoff: number | null;
  totalInterestPaid: number;
  effectiveInterestRate: number | null;
}

interface VbComparison {
  amortizedDebt: VbScenario;
  amortizedDebtWithExtraPayments: VbScenario;
  debtWithBasicAcceleration: VbScenario;
  advancedDebtAcceleration: VbScenario;
  savings: {
    extraPaymentsVsAmortized: number;
    basicAccelerationVsAmortized: number;
    advancedVsAmortized: number;
  };
  recommendation: {
    bestStrategy: "amortized" | "extra_payments" | "basic_acceleration" | "advanced_acceleration";
    rationale: string;
    chunkingMakesSense: boolean;
    advancedMakesSense: boolean;
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PARAGON_API_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/BlazeGetRequest?ApiAction=listing%2FGetListingDetails%2F&UrlData={mlsNumber}%2F0%2F2%2Ffalse%2F{guid}";
const PARAGON_GUID_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/CreateGuid";
const PARAGON_NOTIFICATION_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/BlazePublicGetRequest?ApiAction=GetNotificationAppData%2F&UrlData={mlsId}";

function dictQuery(obj: unknown, path: string, defaultValue: unknown = null): unknown {
  const keys = path.split("/");
  let val: unknown = obj;
  for (const key of keys) {
    if (val == null || typeof val !== "object") return defaultValue;
    if (Array.isArray(val)) {
      val = val.map((v: Record<string, unknown>) => v?.[key] ?? defaultValue);
    } else {
      val = (val as Record<string, unknown>)[key] ?? defaultValue;
    }
    if (val == null) return defaultValue;
  }
  return val;
}

function str(val: unknown): string {
  if (val == null) return "";
  return String(val);
}

function num(val: unknown): number | null {
  if (val == null || val === "") return null;
  const n = Number(String(val).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseMoney(val: unknown): number | null {
  if (val == null || val === "") return null;
  const cleaned = String(val).replace(/[$,%\s,]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function stripNonNumeric(s: string): string {
  return s.replace(/[^0-9.\-]/g, "");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function safeDivide(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function pmt(ratePerPeriod: number, periods: number, presentValue: number): number {
  if (periods <= 0) return 0;
  if (ratePerPeriod === 0) return presentValue / periods;
  const factor = Math.pow(1 + ratePerPeriod, periods);
  return (presentValue * ratePerPeriod * factor) / (factor - 1);
}

function cumulativePrincipal(ratePerPeriod: number, periods: number, presentValue: number, startPeriod: number, endPeriod: number): number {
  if (presentValue <= 0 || periods <= 0 || endPeriod < startPeriod) return 0;
  let balance = presentValue;
  const payment = pmt(ratePerPeriod, periods, presentValue);
  let totalPrincipal = 0;
  for (let period = 1; period <= periods && balance > 0.000001; period++) {
    const interest = balance * ratePerPeriod;
    const principal = Math.min(balance, payment - interest);
    if (period >= startPeriod && period <= endPeriod) {
      totalPrincipal += principal;
    }
    balance = Math.max(0, balance - principal);
  }
  return totalPrincipal;
}

function irr(cashflows: number[]): number | null {
  if (cashflows.length < 2) return null;
  const hasPositive = cashflows.some((v) => v > 0);
  const hasNegative = cashflows.some((v) => v < 0);
  if (!hasPositive || !hasNegative) return null;

  let guess = 0.1;
  for (let i = 0; i < 100; i++) {
    let npv = 0;
    let derivative = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const denom = Math.pow(1 + guess, t);
      npv += cashflows[t] / denom;
      if (t > 0) derivative -= (t * cashflows[t]) / Math.pow(1 + guess, t + 1);
    }
    if (Math.abs(npv) < 1e-8) return guess;
    if (Math.abs(derivative) < 1e-12) break;
    const next = guess - npv / derivative;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    guess = next;
  }

  let low = -0.9999;
  let high = 10;
  const npvAt = (rate: number) => cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + rate, t), 0);
  let lowNpv = npvAt(low);
  let highNpv = npvAt(high);
  if (lowNpv * highNpv > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const midNpv = npvAt(mid);
    if (Math.abs(midNpv) < 1e-8) return mid;
    if (lowNpv * midNpv <= 0) {
      high = mid;
      highNpv = midNpv;
    } else {
      low = mid;
      lowNpv = midNpv;
    }
  }
  return (low + high) / 2;
}

function inferUnitCount(rents: Array<number | null>, notes: string, fallback: number | null = null): number | null {
  const populated = rents.filter((r) => (r ?? 0) > 0).length;
  if (populated > 0) return populated;
  const match = notes.match(/(\d+)\s*(unit|family|plex|condo)/i);
  if (match) return Number(match[1]);
  return fallback;
}

function buildStyleTypeBedBath(p: { style: string | null; type: string | null; beds: number | null; bathsFull: number | null; bathsPart: number | null; yearBuilt: number | null; }): string | null {
  const lines: string[] = [];
  if (p.style) lines.push(p.style);
  if (p.type && p.type !== p.style) lines.push(p.type);
  if (p.beds != null || p.bathsFull != null || p.bathsPart != null) {
    const baths = p.bathsFull != null || p.bathsPart != null ? `${p.bathsFull ?? 0}.${p.bathsPart ?? 0}` : "?";
    lines.push(`${p.beds ?? "?"}BD/${baths}BA`);
  }
  if (p.yearBuilt != null) lines.push(`Built ${p.yearBuilt}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

async function paragonFetch(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        ...options.headers,
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from Paragon API (url pattern: ${url.replace(/https?:\/\/[^/]+/, "...")})`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getGuid(systemId: string, headers: Record<string, string>): Promise<string> {
  const url = PARAGON_GUID_URL_TEMPLATE.replace("{systemId}", encodeURIComponent(systemId));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`Failed to get GUID (HTTP ${resp.status})`);
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function getMlsNumbers(
  mlsId: string,
  systemId: string
): Promise<{ mlsNumbers: string[]; agentId: string; officeId: string }> {
  const url = PARAGON_NOTIFICATION_URL_TEMPLATE
    .replace("{systemId}", encodeURIComponent(systemId))
    .replace("{mlsId}", encodeURIComponent(mlsId));

  const data = (await paragonFetch(url)) as Record<string, unknown>;
  const agentId = String(dictQuery(data, "Agent/AgentId") ?? "1");
  const officeId = String(dictQuery(data, "Agent/OfficeId") ?? "1");

  let listings: Array<{ Id: string }> = [];
  try {
    const raw = JSON.stringify(data);
    const cleaned = raw.includes("[]") ? raw.split("[]")[0] : raw;
    const parsed = JSON.parse(cleaned);
    listings = parsed?.listings ?? [];
  } catch {
    listings = [];
  }

  return { mlsNumbers: listings.map((l) => l.Id), agentId, officeId };
}

async function getProperties(
  mlsNumbers: string[],
  systemId: string,
  mlsId: string,
  agentId: string,
  officeId: string
): Promise<unknown[]> {
  const headers = {
    "User-Agent": DEFAULT_USER_AGENT,
    Cookie: `psystemid=${systemId.toUpperCase()};pagentid=${agentId};pofficeid=${officeId};`,
  };

  const guid = await getGuid(systemId, headers);
  const results: unknown[] = [];

  for (const mlsNumber of mlsNumbers) {
    const url = PARAGON_API_URL_TEMPLATE
      .replace("{systemId}", encodeURIComponent(systemId))
      .replace("{mlsNumber}", encodeURIComponent(mlsNumber))
      .replace("{guid}", encodeURIComponent(guid));

    try {
      const data = await paragonFetch(url, { headers });
      results.push(data);
    } catch (err) {
      results.push({ error: String(err), mlsNumber });
    }
  }

  return results;
}

function parseProperty(data: Record<string, unknown>, systemId: string, mlsId: string): PropertyInfo | null {
  try {
    const propInfo = (dictQuery(data, "PROP_INFO") ?? {}) as Record<string, unknown>;
    const histData = (dictQuery(data, "HISTDATA") ?? []) as Array<Record<string, unknown>>;

    const address = str(dictQuery(propInfo, "ADDRESS"));
    const city = str(dictQuery(propInfo, "CITY"));
    const state = str(dictQuery(propInfo, "STATE"));
    const zip = str(dictQuery(propInfo, "ZIP"));
    const fullAddress = `${address}, ${city}, ${state} ${zip}`.trim();

    const mlsNumber = histData.length > 0 ? str(histData[0]?.MLS_NUMBER) : "";
    const priceCurrent = parseMoney(dictQuery(propInfo, "PRICE_CURRENT"));
    const pricePrev = parseMoney(dictQuery(propInfo, "PRICE_PREV"));
    const offerPriceDefault = priceCurrent;
    const beds = num(dictQuery(propInfo, "BDRMS"));
    const bathsFull = num(dictQuery(propInfo, "BATHS_FULL"));
    const bathsPart = num(dictQuery(propInfo, "BATHS_PART"));
    const publicRemarks = str(dictQuery(propInfo, "REMARKS_GENERAL"));
    const status = str(dictQuery(propInfo, "STATUS_LONG"));

    let sqft: number | null = null;
    let yearBuilt: number | null = null;
    let style: string | null = null;
    let type: string | null = str(dictQuery(propInfo, "PROP_TYPE_LONG")) || null;
    const rents: Array<number | null> = [null, null, null, null, null, null, null];
    let laundryIncome: number | null = null;
    let storageIncome: number | null = null;
    let miscIncome: number | null = null;
    let totalTaxes: number | null = null;
    let schoolTaxes: number | null = null;
    let hoa: number | null = null;

    const detailOptions = dictQuery(propInfo, "DetailOptions");

    const readKvFromSection = (sectionData: Array<Record<string, unknown>>): Record<string, string> => {
      const kv: Record<string, string> = {};
      for (const item of sectionData) {
        const label = str(item.Label ?? item.label);
        const value = str(item.Value ?? item.value);
        if (label) kv[label] = value;
      }
      return kv;
    };

    if (Array.isArray(detailOptions)) {
      for (const section of detailOptions) {
        const sectionName = str(dictQuery(section, "SectionName"));
        const sectionData = dictQuery(section, "Data") as Array<Record<string, unknown>> | null;
        if (!Array.isArray(sectionData)) continue;
        const kv = readKvFromSection(sectionData);

        if (sectionName === "Property Information") {
          yearBuilt = num(kv["Year Built"]);
          type = kv["Type"] ?? type;
        } else if (sectionName === "Features") {
          style = kv["STYLE"] ?? style;
          sqft = parseMoney(kv["Above Ground SQFT"]) ?? sqft;
        } else if (sectionName === "Miscellaneous") {
          sqft = parseMoney(kv["Above Ground SQFT"]) ?? sqft;
          const taxStr = stripNonNumeric(kv["Total Taxes"] ?? "");
          totalTaxes = taxStr ? Math.round(Number(taxStr) / 12) : totalTaxes;
          const hoaStr = stripNonNumeric(kv["HOA Fees"] ?? "");
          hoa = hoaStr ? Number(hoaStr) : hoa;
          const laundryStr = stripNonNumeric(kv["Laundry Income"] ?? "");
          laundryIncome = laundryStr ? Number(laundryStr) : laundryIncome;
          const storageStr = stripNonNumeric(kv["Storage Income"] ?? "");
          storageIncome = storageStr ? Number(storageStr) : storageIncome;
          const miscStr = stripNonNumeric(kv["Misc Income"] ?? kv["Miscellaneous Income"] ?? "");
          miscIncome = miscStr ? Number(miscStr) : miscIncome;
          for (let u = 1; u <= 7; u++) {
            const rentVal = kv[`Unit ${u} Monthly Rent`] ?? kv[`Unit ${u} Rent`];
            if (rentVal) rents[u - 1] = parseMoney(rentVal);
          }
        } else if (sectionName === "Schools") {
          const stStr = stripNonNumeric(kv["School Taxes"] ?? "");
          schoolTaxes = stStr ? Math.round(Number(stStr) / 12) : schoolTaxes;
        }
      }
    }

    if (detailOptions != null && !Array.isArray(detailOptions)) {
      const dataArr = dictQuery(detailOptions, "Data") as Array<Array<Record<string, string>>> | null;
      if (Array.isArray(dataArr)) {
        const flatKv: Record<string, string> = {};
        for (const group of dataArr) {
          for (const item of group ?? []) {
            flatKv[item.Label ?? item.label] = item.Value ?? item.value ?? "";
          }
        }
        yearBuilt = num(flatKv["Year Built"]) ?? yearBuilt;
        type = flatKv["Type"] ?? type;
        style = flatKv["STYLE"] ?? style;
        sqft = parseMoney(flatKv["Above Ground SQFT"]) ?? sqft;
        const taxStr = stripNonNumeric(flatKv["Total Taxes"] ?? "");
        totalTaxes = taxStr ? Math.round(Number(taxStr) / 12) : totalTaxes;
        const schoolStr = stripNonNumeric(flatKv["School Taxes"] ?? "");
        schoolTaxes = schoolStr ? Math.round(Number(schoolStr) / 12) : schoolTaxes;
        const hoaStr = stripNonNumeric(flatKv["HOA Fees"] ?? "");
        hoa = hoaStr ? Number(hoaStr) : hoa;
        for (let u = 1; u <= 7; u++) {
          const rentVal = flatKv[`Unit ${u} Monthly Rent`] ?? flatKv[`Unit ${u} Rent`];
          if (rentVal) rents[u - 1] = parseMoney(rentVal);
        }
      }
    }

    const unitCount = inferUnitCount(rents, `${type ?? ""}\n${publicRemarks}`);
    const styleTypeBedBath = buildStyleTypeBedBath({ style, type, beds, bathsFull, bathsPart, yearBuilt });
    const guidForLink = mlsId || mlsNumber;
    const mlsLink = `http://${systemId}.paragonrels.com/publink/Report.aspx?GUID=${guidForLink}&ListingID=${mlsNumber}:0&layout_id=3`;
    const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;

    if (status && !/Active|New|Price Change|Pend/i.test(status)) {
      return null;
    }

    return {
      address,
      city,
      state,
      zip,
      fullAddress,
      mlsNumber,
      priceCurrent,
      pricePrev,
      offerPriceDefault,
      beds,
      bathsFull,
      bathsPart,
      sqft,
      yearBuilt,
      style,
      type,
      status,
      publicRemarks,
      rents,
      laundryIncome,
      storageIncome,
      miscIncome,
      totalTaxes,
      schoolTaxes,
      hoa,
      unitCount,
      styleTypeBedBath,
      mlsLink,
      googleMapsLink,
    };
  } catch {
    return null;
  }
}

const optionalMoney = z.number().nullable().optional();

const analyzeDealSchema = {
  mlsNumbers: z.string().describe("Comma-separated MLS numbers to analyze (e.g. '201918514,202012345')"),
  systemId: z.string().default("globalmls").describe("MLS system/region ID"),
  mlsId: z.string().optional().describe("Optional listing GUID for link generation"),
  holdingPeriodYears: z.number().default(5).describe("Holding period in years, like the spreadsheet's B2 value"),
  offerPricePct: z.number().default(1).describe("Multiply list price by this to produce Offer Price. Default 1.0 = use list price as offer."),
  downPaymentPct: z.number().default(0.20).describe("Down payment percentage (sheet column D)"),
  interestRate: z.number().default(0.07).describe("Mortgage interest rate (sheet column E)"),
  loanTermYears: z.number().default(30).describe("Mortgage term in years"),
  vacancyRate: z.number().default(0.05).describe("Vacancy rate used for monthly Vacancy expense"),
  repairsPct: z.number().default(0.05).describe("Monthly Repairs expense as percent of monthly income"),
  capexPct: z.number().default(0.05).describe("Monthly Capital Expenditures expense as percent of monthly income"),
  mgmtPct: z.number().default(0.08).describe("Monthly Property Management expense as percent of monthly income"),
  appreciationRate: z.number().default(0.03).describe("Annual appreciation assumption"),
  marginalTaxRate: z.number().default(0.35).describe("Marginal tax rate used for depreciation tax savings"),
  annualInsuranceRate: z.number().default(0.005).describe("Default annual insurance as a percent of offer price when monthly insurance is not overridden"),
  closingCosts: z.number().default(0).describe("Upfront closing costs (sheet column AV)"),
  repairBudget: z.number().default(0).describe("Upfront repair budget / rehab (sheet column AW)"),
  reservePrepaid: optionalMoney.describe("Override Reserve / Prepaid (sheet column AX). If omitted, use the spreadsheet-compatible formula."),
  privateMoneyLender: z.number().default(0).describe("Private money lender cost or contribution (sheet column AY)"),
  landValue: z.number().default(0).describe("Land value used to reduce depreciation basis (sheet column BG)"),
  monthlyPropertyTaxes: optionalMoney.describe("Override monthly property taxes (sheet column Y)"),
  monthlySchoolTaxes: optionalMoney.describe("Override monthly school taxes (sheet column Z)"),
  monthlyInsurance: optionalMoney.describe("Override monthly insurance (sheet column AA)"),
  monthlyWater: z.number().default(0).describe("Monthly Water expense (AB)"),
  monthlySewer: z.number().default(0).describe("Monthly Sewer expense (AC)"),
  monthlyGarbage: z.number().default(0).describe("Monthly Garbage expense (AD)"),
  monthlyElectric: z.number().default(0).describe("Monthly Electric expense (AE)"),
  monthlyGas: z.number().default(0).describe("Monthly Gas expense (AF)"),
  monthlyHoa: optionalMoney.describe("Override monthly HOA fees (AG)"),
  monthlyLawnSnow: z.number().default(0).describe("Monthly Lawn/Snow expense (AH)"),
  monthlyLegalAccounting: z.number().default(0).describe("Monthly Legal & Accounting expense (AM)"),
  laundryIncome: optionalMoney.describe("Override Laundry Income (U)"),
  storageIncome: optionalMoney.describe("Override Storage Income (V)"),
  miscIncome: optionalMoney.describe("Override Misc Income (W)"),
  unitRent1: optionalMoney.describe("Override Rental (Unit 1)"),
  unitRent2: optionalMoney.describe("Override Rental (Unit 2)"),
  unitRent3: optionalMoney.describe("Override Rental (Unit 3)"),
  unitRent4: optionalMoney.describe("Override Rental (Unit 4)"),
  unitRent5: optionalMoney.describe("Override Rental (Unit 5)"),
  unitRent6: optionalMoney.describe("Override Rental (Unit 6)"),
  unitRent7: optionalMoney.describe("Override Rental (Unit 7)"),
};

function buildFourSquareRow(
  property: PropertyInfo,
  inputs: z.infer<z.ZodObject<typeof analyzeDealSchema>>
): FourSquareRow {
  const offerPrice = round2((property.priceCurrent ?? 0) * inputs.offerPricePct);
  const downPaymentPct = inputs.downPaymentPct;
  const interestRate = inputs.interestRate;
  const loanTermMonths = Math.round(inputs.loanTermYears * 12);
  const rents = [
    inputs.unitRent1 ?? property.rents[0],
    inputs.unitRent2 ?? property.rents[1],
    inputs.unitRent3 ?? property.rents[2],
    inputs.unitRent4 ?? property.rents[3],
    inputs.unitRent5 ?? property.rents[4],
    inputs.unitRent6 ?? property.rents[5],
    inputs.unitRent7 ?? property.rents[6],
  ].map((v) => v ?? null);

  const laundryIncome = inputs.laundryIncome ?? property.laundryIncome ?? 0;
  const storageIncome = inputs.storageIncome ?? property.storageIncome ?? 0;
  const miscIncome = inputs.miscIncome ?? property.miscIncome ?? 0;
  const totalMonthlyIncome = round2(
    rents.reduce<number>((sum, v) => sum + (v ?? 0), 0) + laundryIncome + storageIncome + miscIncome
  );

  const monthlyPropertyTaxes = round2(inputs.monthlyPropertyTaxes ?? property.totalTaxes ?? 0);
  const monthlySchoolTaxes = round2(inputs.monthlySchoolTaxes ?? property.schoolTaxes ?? 0);
  const monthlyInsurance = round2(inputs.monthlyInsurance ?? (offerPrice * inputs.annualInsuranceRate) / 12);
  const monthlyWater = round2(inputs.monthlyWater);
  const monthlySewer = round2(inputs.monthlySewer);
  const monthlyGarbage = round2(inputs.monthlyGarbage);
  const monthlyElectric = round2(inputs.monthlyElectric);
  const monthlyGas = round2(inputs.monthlyGas);
  const monthlyHoa = round2(inputs.monthlyHoa ?? property.hoa ?? 0);
  const monthlyLawnSnow = round2(inputs.monthlyLawnSnow);
  const vacancy = round2(totalMonthlyIncome * inputs.vacancyRate);
  const repairsMonthly = round2(totalMonthlyIncome * inputs.repairsPct);
  const capexMonthly = round2(totalMonthlyIncome * inputs.capexPct);
  const propertyManagement = round2(totalMonthlyIncome * inputs.mgmtPct);
  const legalAccounting = round2(inputs.monthlyLegalAccounting);

  const loanAmount = Math.max(offerPrice * (1 - downPaymentPct), 0);
  const mortgage = round2(pmt(interestRate / 12, loanTermMonths, loanAmount));
  const totalMonthlyExpenses = round2(
    monthlyPropertyTaxes +
      monthlySchoolTaxes +
      monthlyInsurance +
      monthlyWater +
      monthlySewer +
      monthlyGarbage +
      monthlyElectric +
      monthlyGas +
      monthlyHoa +
      monthlyLawnSnow +
      vacancy +
      repairsMonthly +
      capexMonthly +
      propertyManagement +
      legalAccounting +
      mortgage
  );
  const netOperatingIncome = round2(totalMonthlyIncome - totalMonthlyExpenses + mortgage);
  const totalMonthlyCashFlow = round2(totalMonthlyIncome - totalMonthlyExpenses);
  const totalAnnualCashFlow = round2(totalMonthlyCashFlow * 12);
  const downPaymentAmount = round2(downPaymentPct * offerPrice);
  const closingCosts = round2(inputs.closingCosts);
  const repairBudget = round2(inputs.repairBudget);
  const reservePrepaid = round2(
    inputs.reservePrepaid ??
      (((monthlyPropertyTaxes + monthlySchoolTaxes + monthlyInsurance) * (12 + 2)) +
        (((offerPrice - downPaymentPct) * interestRate) / 365) * 30)
  );
  const privateMoneyLender = round2(inputs.privateMoneyLender);
  const totalInvestment = round2(downPaymentAmount + closingCosts + repairBudget + reservePrepaid + privateMoneyLender);
  const cashOnCashReturn = round6((safeDivide(totalAnnualCashFlow, totalInvestment) ?? 0));
  const debtServiceCoverageRatio = round6(safeDivide(netOperatingIncome, mortgage) ?? 0);
  const principalPaydownNoVb = round2(
    cumulativePrincipal(interestRate / 12, loanTermMonths, loanAmount, 1, Math.round(inputs.holdingPeriodYears * 12))
  );
  const projectedAppreciation = round2(offerPrice * Math.pow(1 + inputs.appreciationRate, inputs.holdingPeriodYears) - offerPrice);
  const totalEquityOverHoldingPeriod = round2(downPaymentAmount + principalPaydownNoVb + projectedAppreciation);
  const annualReturnDueToEquity = round6(
    safeDivide((principalPaydownNoVb + projectedAppreciation) / inputs.holdingPeriodYears, totalInvestment) ?? 0
  );
  const landValue = round2(inputs.landValue);
  const depreciationBasis = round2(offerPrice + closingCosts + repairBudget + reservePrepaid - landValue);
  const annualDepreciation = round2(0.03636 * depreciationBasis);
  const taxSavingsAtMarginalRate = round2(inputs.marginalTaxRate * annualDepreciation);
  const annualReturnDueToTaxSavings = round6(safeDivide(taxSavingsAtMarginalRate, totalInvestment) ?? 0);
  const totalAnnualizedReturn = round2(
    totalAnnualCashFlow * Math.pow(1 + inputs.appreciationRate, inputs.holdingPeriodYears) +
      principalPaydownNoVb / inputs.holdingPeriodYears +
      projectedAppreciation / inputs.holdingPeriodYears +
      taxSavingsAtMarginalRate
  );
  const returnOnInvestment = round6(safeDivide(totalAnnualizedReturn, totalInvestment) ?? 0);
  const returnOnEquity = round6(safeDivide(totalAnnualizedReturn, totalEquityOverHoldingPeriod) ?? 0);

  const annualCashflowAndTaxSavingsYear1 = totalAnnualCashFlow + taxSavingsAtMarginalRate;
  const annualCashflowSeries: number[] = [];
  for (let year = 0; year < inputs.holdingPeriodYears; year++) {
    annualCashflowSeries.push(annualCashflowAndTaxSavingsYear1 * Math.pow(1 + inputs.appreciationRate, year));
  }
  const internalRateOfReturn = irr([-totalInvestment, ...annualCashflowSeries, totalEquityOverHoldingPeriod]);

  const capitalizationRate = round6((safeDivide(netOperatingIncome * 12, offerPrice) ?? 0));
  const sheetColumns: Record<string, string | number | null> = {
    "Address": property.fullAddress,
    "MLS #": property.mlsNumber,
    "Offer Price": offerPrice,
    "Down Payment": downPaymentPct,
    "Mortgage Interest Rate": interestRate,
    "Total Investment": totalInvestment,
    "Total Monthly Cash Flow": totalMonthlyCashFlow,
    "Cash on Cash Return": cashOnCashReturn,
    "Capitalization Rate": capitalizationRate,
    "Square Footage Above Ground": property.sqft,
    "Style, Type, Bed/Bath": property.styleTypeBedBath,
    "Number of Units": property.unitCount,
    "Notes": property.publicRemarks,
    "Rental (Unit 1)": rents[0],
    "Rental (Unit 2)": rents[1],
    "Rental (Unit 3)": rents[2],
    "Rental (Unit 4)": rents[3],
    "Rental (Unit 5)": rents[4],
    "Rental (Unit 6)": rents[5],
    "Rental (Unit 7)": rents[6],
    "Laundry Income": laundryIncome,
    "Storage Income": storageIncome,
    "Misc Income": miscIncome,
    "Total Monthly Income": totalMonthlyIncome,
    "Property Taxes (Monthly)": monthlyPropertyTaxes,
    "School Taxes (Monthly)": monthlySchoolTaxes,
    "Insurance": monthlyInsurance,
    "Water": monthlyWater,
    "Sewer": monthlySewer,
    "Garbage": monthlyGarbage,
    "Electric": monthlyElectric,
    "Gas": monthlyGas,
    "HOA Fees": monthlyHoa,
    "Lawn/Snow": monthlyLawnSnow,
    "Vacancy": vacancy,
    "Repairs": repairsMonthly,
    "Capital Expenditures": capexMonthly,
    "Property Management": propertyManagement,
    "Legal & Accounting": legalAccounting,
    "Mortgage": mortgage,
    "Total Monthly Expenses": totalMonthlyExpenses,
    "NOI Total Monthly Income": totalMonthlyIncome,
    "NOI Total Monthly Expenses": totalMonthlyExpenses,
    "Net Operating Income": netOperatingIncome,
    "CF Total Monthly Cash Flow": totalMonthlyCashFlow,
    "Total Annual Cash Flow": totalAnnualCashFlow,
    "Down Payment Amount": downPaymentAmount,
    "Closing Costs": closingCosts,
    "Repairs Budget": repairBudget,
    "Reserve / Prepaid": reservePrepaid,
    "Private Money Lender": privateMoneyLender,
    "Spreadsheet Total Investment": totalInvestment,
    "Spreadsheet Cash on Cash Return": cashOnCashReturn,
    "Debt Service Coverage Ratio": debtServiceCoverageRatio,
    "Principal Paydown (No VB)": principalPaydownNoVb,
    "Projected Appreciation at 3% per year": projectedAppreciation,
    "Total Equity Over Holding Period": totalEquityOverHoldingPeriod,
    "Annual Return Due to Equity": annualReturnDueToEquity,
    "Land Value": landValue,
    "Depreciation Basis": depreciationBasis,
    "Annual Depreciation": annualDepreciation,
    [`Tax Savings at ${(inputs.marginalTaxRate * 100).toFixed(0)}% Marginal Tax Rate`]: taxSavingsAtMarginalRate,
    "Annual Return Due to Tax Savings": annualReturnDueToTaxSavings,
    "Total Annualized Return": totalAnnualizedReturn,
    "Return on Investment": returnOnInvestment,
    "Return On Equity": returnOnEquity,
    "Internal Rate of Return": internalRateOfReturn,
  };

  return {
    address: property.fullAddress,
    mlsNumber: property.mlsNumber,
    offerPrice,
    totalMonthlyCashFlow,
    cashOnCashReturn,
    capitalizationRate,
    debtServiceCoverageRatio,
    totalAnnualizedReturn,
    returnOnInvestment,
    returnOnEquity,
    internalRateOfReturn,
    sheetColumns,
  };
}

function simulateAmortizedDebt(balance: number, annualRate: number, termMonths: number, extraPayment = 0): VbScenario {
  const payment = pmt(annualRate / 12, termMonths, balance);
  let remaining = balance;
  let months = 0;
  let interestPaid = 0;
  while (remaining > 0.01 && months < 1200) {
    const interest = remaining * annualRate / 12;
    const totalPayment = Math.min(remaining + interest, payment + extraPayment);
    const principal = Math.max(0, totalPayment - interest);
    interestPaid += interest;
    remaining = Math.max(0, remaining - principal);
    months += 1;
  }
  return {
    monthsToPayoff: months < 1200 ? months : null,
    yearsToPayoff: months < 1200 ? months / 12 : null,
    totalInterestPaid: round2(interestPaid),
    effectiveInterestRate: annualRate,
  };
}

function simulateBasicAcceleration(params: {
  debtBalance: number;
  interestRate: number;
  termMonths: number;
  helocRate: number;
  helocLimit: number;
  freeCashflow: number;
  chunkMonths: number;
}): VbScenario {
  const payment = pmt(params.interestRate / 12, params.termMonths, params.debtBalance);
  let mortgageBalance = params.debtBalance;
  let helocBalance = 0;
  let months = 0;
  let totalInterest = 0;
  const recurringChunk = Math.max(0, params.freeCashflow * params.chunkMonths);
  const initialChunk = Math.min(mortgageBalance, Math.max(0, params.helocLimit + recurringChunk));
  if (initialChunk > 0) {
    mortgageBalance -= initialChunk;
    helocBalance += initialChunk;
  }

  while ((mortgageBalance > 0.01 || helocBalance > 0.01) && months < 1200) {
    months += 1;

    if (mortgageBalance > 0.01) {
      const mortgageInterest = mortgageBalance * params.interestRate / 12;
      totalInterest += mortgageInterest;
      const mortgagePayment = Math.min(mortgageBalance + mortgageInterest, payment);
      const mortgagePrincipal = Math.max(0, mortgagePayment - mortgageInterest);
      mortgageBalance = Math.max(0, mortgageBalance - mortgagePrincipal);
    }

    const helocInterest = helocBalance > 0 ? helocBalance * params.helocRate / 12 : 0;
    totalInterest += helocInterest;
    helocBalance += helocInterest;

    if (params.freeCashflow > 0 && helocBalance > 0) {
      const payHeloc = Math.min(helocBalance, params.freeCashflow);
      helocBalance -= payHeloc;
    }

    if (mortgageBalance > 0.01 && recurringChunk > 0 && months % (params.chunkMonths + 1) === 0) {
      const chunk = Math.min(mortgageBalance, recurringChunk);
      mortgageBalance -= chunk;
      helocBalance += chunk;
    }
  }

  return {
    monthsToPayoff: months < 1200 ? months : null,
    yearsToPayoff: months < 1200 ? months / 12 : null,
    totalInterestPaid: round2(totalInterest),
    effectiveInterestRate: params.interestRate,
  };
}

function simulateAdvancedAcceleration(params: {
  debtBalance: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlyDebtPayment: number;
  locRate: number;
}): VbScenario {
  const locCashflow = Math.max(0, params.monthlyIncome - params.monthlyExpenses + params.monthlyDebtPayment);
  let balance = params.debtBalance;
  let months = 0;
  let totalInterest = 0;

  while (balance > 0.01 && months < 1200) {
    const effectiveAverageBalance = Math.max(0, balance - locCashflow / 2);
    const interest = effectiveAverageBalance * params.locRate / 12;
    totalInterest += interest;
    const principal = Math.max(0, locCashflow - interest);
    if (principal <= 0.01) {
      months = 1200;
      break;
    }
    balance = Math.max(0, balance + interest - locCashflow);
    months += 1;
  }

  return {
    monthsToPayoff: months < 1200 ? months : null,
    yearsToPayoff: months < 1200 ? months / 12 : null,
    totalInterestPaid: round2(totalInterest),
    effectiveInterestRate: params.locRate,
  };
}

function buildVbComparison(params: {
  debtBalance: number;
  interestRate: number;
  termMonths: number;
  extraPayment: number;
  monthlyIncome: number;
  monthlyExpenses: number;
  helocRate: number;
  advancedRate: number;
  helocLimit: number;
  chunkMonths: number;
}): VbComparison {
  const amortizedDebt = simulateAmortizedDebt(params.debtBalance, params.interestRate, params.termMonths, 0);
  const amortizedDebtWithExtraPayments = simulateAmortizedDebt(params.debtBalance, params.interestRate, params.termMonths, params.extraPayment);
  const freeCashflow = Math.max(0, params.monthlyIncome - params.monthlyExpenses);
  const basicAcceleration = simulateBasicAcceleration({
    debtBalance: params.debtBalance,
    interestRate: params.interestRate,
    termMonths: params.termMonths,
    helocRate: params.helocRate,
    helocLimit: params.helocLimit,
    freeCashflow,
    chunkMonths: params.chunkMonths,
  });
  const payment = pmt(params.interestRate / 12, params.termMonths, params.debtBalance);
  const advancedDebtAcceleration = simulateAdvancedAcceleration({
    debtBalance: params.debtBalance,
    monthlyIncome: params.monthlyIncome,
    monthlyExpenses: params.monthlyExpenses,
    monthlyDebtPayment: payment,
    locRate: params.advancedRate,
  });

  const savings = {
    extraPaymentsVsAmortized: round2(amortizedDebt.totalInterestPaid - amortizedDebtWithExtraPayments.totalInterestPaid),
    basicAccelerationVsAmortized: round2(amortizedDebt.totalInterestPaid - basicAcceleration.totalInterestPaid),
    advancedVsAmortized: round2(amortizedDebt.totalInterestPaid - advancedDebtAcceleration.totalInterestPaid),
  };

  const strategies = [
    { key: "amortized" as const, scenario: amortizedDebt, savings: 0 },
    { key: "extra_payments" as const, scenario: amortizedDebtWithExtraPayments, savings: savings.extraPaymentsVsAmortized },
    { key: "basic_acceleration" as const, scenario: basicAcceleration, savings: savings.basicAccelerationVsAmortized },
    { key: "advanced_acceleration" as const, scenario: advancedDebtAcceleration, savings: savings.advancedVsAmortized },
  ];

  strategies.sort((a, b) => {
    const aMonths = a.scenario.monthsToPayoff ?? 999999;
    const bMonths = b.scenario.monthsToPayoff ?? 999999;
    if (aMonths !== bMonths) return aMonths - bMonths;
    return b.savings - a.savings;
  });

  const best = strategies[0];
  const chunkingMakesSense = freeCashflow > 0 && basicAcceleration.monthsToPayoff != null && amortizedDebt.monthsToPayoff != null
    ? basicAcceleration.monthsToPayoff < amortizedDebt.monthsToPayoff && savings.basicAccelerationVsAmortized > 0
    : false;
  const advancedMakesSense = freeCashflow > 0 && advancedDebtAcceleration.monthsToPayoff != null && amortizedDebt.monthsToPayoff != null
    ? advancedDebtAcceleration.monthsToPayoff < amortizedDebt.monthsToPayoff && savings.advancedVsAmortized > 0
    : false;

  let rationale = "Standard amortization remains the baseline.";
  if (best.key === "extra_payments") {
    rationale = `Extra monthly principal wins because it shortens payoff with $${savings.extraPaymentsVsAmortized.toLocaleString()} less interest than plain amortization.`;
  } else if (best.key === "basic_acceleration") {
    rationale = `Chunking/basic acceleration wins because free cashflow and chunk capacity reduce payoff time and save about $${savings.basicAccelerationVsAmortized.toLocaleString()} in interest.`;
  } else if (best.key === "advanced_acceleration") {
    rationale = `Advanced VB wins because cycling income through the lower-rate acceleration line beats plain amortization by about $${savings.advancedVsAmortized.toLocaleString()} in interest.`;
  }

  return {
    amortizedDebt,
    amortizedDebtWithExtraPayments,
    debtWithBasicAcceleration: basicAcceleration,
    advancedDebtAcceleration,
    savings,
    recommendation: {
      bestStrategy: best.key,
      rationale,
      chunkingMakesSense,
      advancedMakesSense,
    },
  };
}

function formatAnalyzeSummary(rows: FourSquareRow[]): string {
  let out = "## Four-Square Spreadsheet-Compatible Analysis\n\n";
  out += "| # | Address | MLS# | Offer | Cash Flow | CoC | Cap | DSCR | ROI | IRR |\n";
  out += "|---|---------|------|-------|-----------|-----|-----|------|-----|-----|\n";
  rows.forEach((row, idx) => {
    out += `| ${idx + 1} | ${row.address} | ${row.mlsNumber} | $${row.offerPrice.toLocaleString()} | $${row.totalMonthlyCashFlow.toLocaleString()}/mo | ${(row.cashOnCashReturn * 100).toFixed(2)}% | ${(row.capitalizationRate * 100).toFixed(2)}% | ${row.debtServiceCoverageRatio != null ? row.debtServiceCoverageRatio.toFixed(2) : "—"} | ${(row.returnOnInvestment * 100).toFixed(2)}% | ${row.internalRateOfReturn != null ? (row.internalRateOfReturn * 100).toFixed(2) + "%" : "—"} |\n`;
  });
  out += `\n### Full rows (sheet-compatible columns)\n\n`;
  out += "```json\n" + JSON.stringify(rows, null, 2) + "\n```";
  return out;
}

function formatVbSummary(result: VbComparison): string {
  const row = (name: string, scenario: VbScenario, savings = 0) =>
    `| ${name} | ${scenario.yearsToPayoff != null ? scenario.yearsToPayoff.toFixed(2) : "—"} | $${scenario.totalInterestPaid.toLocaleString()} | ${scenario.effectiveInterestRate != null ? (scenario.effectiveInterestRate * 100).toFixed(2) + "%" : "—"} | $${savings.toLocaleString()} |`;

  let out = "## Velocity Banking Comparison\n\n";
  out += "| Strategy | Years to Pay Off | Total Interest | Effective Rate | Savings vs Amortized |\n";
  out += "|----------|------------------|----------------|----------------|----------------------|\n";
  out += row("Amortized Debt", result.amortizedDebt, 0) + "\n";
  out += row("Amortized Debt w/ Extra Pmts", result.amortizedDebtWithExtraPayments, result.savings.extraPaymentsVsAmortized) + "\n";
  out += row("Debt w/ Basic Acceleration", result.debtWithBasicAcceleration, result.savings.basicAccelerationVsAmortized) + "\n";
  out += row("Advanced Debt Acceleration", result.advancedDebtAcceleration, result.savings.advancedVsAmortized) + "\n\n";
  out += `- **Best strategy:** ${result.recommendation.bestStrategy}\n`;
  out += `- **Chunking makes sense:** ${result.recommendation.chunkingMakesSense ? "yes" : "no"}\n`;
  out += `- **Advanced VB makes sense:** ${result.recommendation.advancedMakesSense ? "yes" : "no"}\n`;
  out += `- **Why:** ${result.recommendation.rationale}\n\n`;
  out += "```json\n" + JSON.stringify(result, null, 2) + "\n```";
  return out;
}

const server = new McpServer({
  name: "paragon-mls",
  version: "1.1.0",
  description: "Paragon MLS real estate API — fetch listings, parse property data, analyze deals with the Four-Square spreadsheet model, and compare velocity banking scenarios",
});

server.tool(
  "fetch_listings",
  "Fetch property listings from a Paragon MLS system by listing GUID (MLS ID). Returns parsed property data including all available listing fields that the parser can extract.",
  {
    mlsId: z.string().describe("Paragon MLS listing GUID from paragonrels.com/fnimls.com URL (e.g. '6d70b762-36a4-4ac0-bedd-d0dae2920867')"),
    systemId: z.string().default("globalmls").describe("MLS system/region ID (subdomain of paragonrels.com, e.g. 'globalmls', 'imls', 'hudson')"),
  },
  async ({ mlsId, systemId }) => {
    try {
      const { mlsNumbers, agentId, officeId } = await getMlsNumbers(mlsId, systemId);
      if (mlsNumbers.length === 0) {
        return { content: [{ type: "text" as const, text: `No listings found for MLS ID: ${mlsId} on system ${systemId}` }] };
      }
      const rawProperties = await getProperties(mlsNumbers, systemId, mlsId, agentId, officeId);
      const parsed = rawProperties
        .map((data) => parseProperty(data as Record<string, unknown>, systemId, mlsId))
        .filter((p): p is PropertyInfo => p != null);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: parsed.length, properties: parsed }, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching listings: ${String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "fetch_property",
  "Fetch a single property by MLS number and system ID. Returns parsed property data with address, price, beds, baths, rents, taxes, and sheet-friendly descriptors.",
  {
    mlsNumber: z.string().describe("MLS number for the property (e.g. '201918514')"),
    systemId: z.string().default("globalmls").describe("MLS system/region ID (subdomain of paragonrels.com)"),
    mlsId: z.string().optional().describe("Optional listing GUID for link generation"),
  },
  async ({ mlsNumber, systemId, mlsId }) => {
    try {
      const guid = mlsId ?? "";
      const rawProperties = await getProperties([mlsNumber], systemId, guid || mlsNumber, "1", "1");
      if (rawProperties.length === 0) {
        return { content: [{ type: "text" as const, text: `No data returned for MLS #${mlsNumber}` }] };
      }

      const parsed = parseProperty(rawProperties[0] as Record<string, unknown>, systemId, guid);
      if (!parsed) {
        return { content: [{ type: "text" as const, text: `Could not parse property data for MLS #${mlsNumber}. Raw data returned instead.` }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching property: ${String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "analyze_deal",
  "Perform a spreadsheet-compatible Four-Square rental analysis using the Google Sheet model. Returns all major columns from the Four-Square Analysis tab, including NOI, DSCR, principal paydown, appreciation, depreciation, ROI, ROE, and IRR.",
  analyzeDealSchema,
  async (input) => {
    try {
      const numbers = input.mlsNumbers.split(",").map((s) => s.trim()).filter(Boolean);
      const guid = input.mlsId ?? "";
      const rawProperties = await getProperties(numbers, input.systemId, guid, "1", "1");

      const rows: FourSquareRow[] = [];
      for (const raw of rawProperties) {
        const parsed = parseProperty(raw as Record<string, unknown>, input.systemId, guid);
        if (!parsed) continue;
        rows.push(buildFourSquareRow(parsed, input));
      }

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No active properties found for the given MLS numbers." }] };
      }

      return { content: [{ type: "text" as const, text: formatAnalyzeSummary(rows) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error analyzing deal: ${String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "vb_calc",
  "Compare amortized debt, extra payments, chunking/basic acceleration, and advanced velocity banking. This is designed to pair with the Four-Square spreadsheet outputs so you can decide if chunking or advanced VB makes sense for a deal.",
  {
    debtBalance: z.number().describe("Starting debt or mortgage balance"),
    interestRate: z.number().describe("Amortized debt annual interest rate, e.g. 0.07 for 7%"),
    loanTermYears: z.number().default(30).describe("Debt term in years"),
    extraPayment: z.number().default(0).describe("Extra monthly principal payment for the extra-payment scenario"),
    monthlyIncome: z.number().describe("Monthly income feeding the debt strategy"),
    monthlyExpenses: z.number().describe("Monthly expenses, typically including the current debt payment when mirroring the spreadsheet"),
    helocRate: z.number().default(0.2399).describe("Rate for the chunking / basic acceleration account"),
    advancedRate: z.number().default(0.08).describe("Rate for the advanced debt acceleration / VB account"),
    helocLimit: z.number().default(20000).describe("Line limit available for chunking"),
    chunkMonths: z.number().default(6).describe("Chunk frequency in months"),
  },
  async ({ debtBalance, interestRate, loanTermYears, extraPayment, monthlyIncome, monthlyExpenses, helocRate, advancedRate, helocLimit, chunkMonths }) => {
    try {
      const comparison = buildVbComparison({
        debtBalance,
        interestRate,
        termMonths: Math.round(loanTermYears * 12),
        extraPayment,
        monthlyIncome,
        monthlyExpenses,
        helocRate,
        advancedRate,
        helocLimit,
        chunkMonths,
      });
      return { content: [{ type: "text" as const, text: formatVbSummary(comparison) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error running vb_calc: ${String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "raw_listings",
  "Fetch raw JSON data from the Paragon MLS API for one or more MLS numbers. Returns unprocessed listing data for custom analysis.",
  {
    mlsNumbers: z.string().describe("Comma-separated MLS numbers (e.g. '201918514,202012345')"),
    systemId: z.string().default("globalmls").describe("MLS system/region ID"),
  },
  async ({ mlsNumbers, systemId }) => {
    try {
      const numbers = mlsNumbers.split(",").map((s) => s.trim()).filter(Boolean);
      const rawProperties = await getProperties(numbers, systemId, "", "1", "1");
      const sanitized = rawProperties.map((p) => JSON.parse(JSON.stringify(p).replace(/"Cookie"[^\"]*"/g, "")));
      return { content: [{ type: "text" as const, text: JSON.stringify(sanitized, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching raw listings: ${String(err)}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Paragon MLS MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});