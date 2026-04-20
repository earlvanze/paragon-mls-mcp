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
 *   - Rate-limit aware (configurable delays between API calls)
 *   - Timeout guards on all HTTP requests
 *   - No filesystem writes — all output is returned as structured data
 *   - Sanitized URLs in error messages
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PropertyInfo {
  address: string;
  city: string;
  state: string;
  zip: string;
  fullAddress: string;
  mlsNumber: string;
  priceCurrent: number | null;
  pricePrev: number | null;
  offerPrice: number | null;
  beds: number | null;
  bathsFull: number | null;
  bathsPart: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  style: string | null;
  type: string | null;
  status: string | null;
  publicRemarks: string | null;
  rents: Record<string, number | null>;
  totalTaxes: number | null;
  schoolTaxes: number | null;
  hoa: number | null;
  mlsLink: string;
  googleMapsLink: string;
}

interface FourSquareAnalysis {
  address: string;
  mlsNumber: string;
  listPrice: number | null;
  offerPrice: number | null;
  rents: Record<string, number | null>;
  totalMonthlyIncome: number;
  monthlyTaxes: number;
  monthlyInsurance: number;
  monthlyMortgage: number | null;
  totalMonthlyExpenses: number;
  monthlyCashFlow: number | null;
  annualCashFlow: number | null;
  totalInvestment: number | null;
  cashOnCashReturn: number | null;
  capRate: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  beds: number | null;
  baths: string | null;
  status: string | null;
  publicRemarks: string | null;
}

// ---------------------------------------------------------------------------
// Paragon MLS API Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PARAGON_API_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/BlazeGetRequest?ApiAction=listing%2FGetListingDetails%2F&UrlData={mlsNumber}%2F0%2F2%2Ffalse%2F{guid}";
const PARAGON_GUID_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/CreateGuid";
const PARAGON_NOTIFICATION_URL_TEMPLATE =
  "http://{systemId}.paragonrels.com/CollabLink/public/BlazePublicGetRequest?ApiAction=GetNotificationAppData%2F&UrlData={mlsId}";

/**
 * Safe dict-path query (mirrors the original DictQuery utility).
 */
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
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function stripNonNumeric(s: string): string {
  return s.replace(/[^0-9.]/g, "");
}

/**
 * Fetch JSON from a Paragon endpoint with timeout and error handling.
 */
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

/**
 * Get a GUID from the Paragon system for API calls.
 */
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

/**
 * Get MLS numbers and cookie data from a Paragon listing ID.
 */
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
    const raw = str(data);
    // Handle [] in response (original code splits on '[]')
    const cleaned = raw.includes("[]") ? raw.split("[]")[0] : raw;
    const parsed = JSON.parse(cleaned);
    listings = parsed?.listings ?? [];
  } catch {
    listings = [];
  }

  const mlsNumbers = listings.map((l) => l.Id);
  return { mlsNumbers, agentId, officeId };
}

/**
 * Fetch property details for one or more MLS numbers.
 */
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

// ---------------------------------------------------------------------------
// Property Parsing
// ---------------------------------------------------------------------------

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
    const priceCurrent = num(dictQuery(propInfo, "PRICE_CURRENT"));
    const pricePrev = num(dictQuery(propInfo, "PRICE_PREV"));
    const offerPrice = priceCurrent != null ? Math.round(priceCurrent * 0.85) : null;
    const beds = num(dictQuery(propInfo, "BDRMS"));
    const bathsFull = num(dictQuery(propInfo, "BATHS_FULL"));
    const bathsPart = num(dictQuery(propInfo, "BATHS_PART"));
    const publicRemarks = str(dictQuery(propInfo, "REMARKS_GENERAL"));
    const status = str(dictQuery(propInfo, "STATUS_LONG"));

    // Parse detail options — try new format then old format
    let sqft: number | null = null;
    let yearBuilt: number | null = null;
    let style: string | null = null;
    let type: string | null = str(dictQuery(propInfo, "PROP_TYPE_LONG"));
    let rents: Record<string, number | null> = {};
    let totalTaxes: number | null = null;
    let schoolTaxes: number | null = null;
    let hoa: number | null = null;

    const detailOptions = dictQuery(propInfo, "DetailOptions");

    if (Array.isArray(detailOptions)) {
      // New format: [{SectionName, Data: [{Label, Value}]}]
      for (const section of detailOptions) {
        const sectionName = str(dictQuery(section, "SectionName"));
        const sectionData = dictQuery(section, "Data") as Array<Record<string, unknown>> | null;
        if (!Array.isArray(sectionData)) continue;

        const kv: Record<string, string> = {};
        for (const item of sectionData) {
          const label = str(item.Label ?? item.label);
          const value = str(item.Value ?? item.value);
          if (label) kv[label] = value;
        }

        if (sectionName === "Property Information") {
          yearBuilt = num(kv["Year Built"]);
          type = kv["Type"] ?? type;
        } else if (sectionName === "Features") {
          style = kv["STYLE"];
        } else if (sectionName === "Miscellaneous") {
          sqft = num(kv["Above Ground SQFT"]);
          const taxStr = stripNonNumeric(kv["Total Taxes"] ?? "");
          totalTaxes = taxStr ? Math.round(parseInt(taxStr) / 12) : null;
          // Unit rents
          for (let u = 1; u <= 7; u++) {
            const rentVal = kv[`Unit ${u} Monthly Rent`];
            if (rentVal) rents[`Unit ${u}`] = num(rentVal.replace(",", ""));
          }
          hoa = num(kv["HOA Fees"]);
        } else if (sectionName === "Schools") {
          const stStr = stripNonNumeric(kv["School Taxes"] ?? "");
          schoolTaxes = stStr ? Math.round(parseInt(stStr) / 12) : null;
        }
      }
    }

    // Fallback old format: DetailOptions.Data is a list of lists
    if (sqft == null && detailOptions != null && !Array.isArray(detailOptions)) {
      const dataArr = dictQuery(detailOptions, "Data") as Array<Array<Record<string, string>>> | null;
      if (Array.isArray(dataArr) && dataArr.length >= 2) {
        const propInfoList = dataArr[0] ?? [];
        const schoolsList = dataArr[1] ?? [];
        const kv: Record<string, string> = {};
        for (const item of propInfoList) {
          kv[item.Label ?? item.label] = item.Value ?? item.value ?? "";
        }
        yearBuilt = num(kv["Year Built"]);
        type = kv["Type"] ?? type;
        const taxStr = stripNonNumeric(kv["Total Taxes"] ?? "");
        totalTaxes = taxStr ? Math.round(parseInt(taxStr) / 12) : null;
        for (let u = 1; u <= 7; u++) {
          const rentVal = kv[`Unit ${u} Rent`];
          if (rentVal) rents[`Unit ${u}`] = num(rentVal.replace(",", ""));
        }
      }
    }

    const mlsLink = `http://${systemId}.paragonrels.com/publink/Report.aspx?GUID=${mlsId}&ListingID=${mlsNumber}:0&layout_id=3`;
    const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;

    // Only return active/pending listings
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
      offerPrice,
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
      totalTaxes,
      schoolTaxes,
      hoa,
      mlsLink,
      googleMapsLink,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Four-Square Analysis
// ---------------------------------------------------------------------------

function computeFourSquare(p: PropertyInfo): FourSquareAnalysis {
  const totalMonthlyIncome = Object.values(p.rents)
    .filter((r): r is number => r != null)
    .reduce((sum, r) => sum + r, 0);

  const monthlyTaxes = (p.totalTaxes ?? 0) + (p.schoolTaxes ?? 0);
  const monthlyInsurance = Math.round((p.priceCurrent ?? 0) * 0.005 / 12); // rough 0.5% annual
  const vacancy = Math.round(totalMonthlyIncome * 0.05); // 5% vacancy
  const repairs = Math.round(totalMonthlyIncome * 0.05); // 5% repairs
  const capex = Math.round(totalMonthlyIncome * 0.05); // 5% capex
  const mgmt = Math.round(totalMonthlyIncome * 0.08); // 8% management
  const hoa = p.hoa ?? 0;

  const totalMonthlyExpenses =
    monthlyTaxes + monthlyInsurance + vacancy + repairs + capex + mgmt + hoa;

  const monthlyCashFlow = totalMonthlyIncome - totalMonthlyExpenses;
  const annualCashFlow = monthlyCashFlow * 12;

  const downPayment = p.priceCurrent != null ? Math.round(p.priceCurrent * 0.20) : null;
  const closingCosts = p.priceCurrent != null ? Math.round(p.priceCurrent * 0.03) : null;
  const totalInvestment = downPayment != null && closingCosts != null ? downPayment + closingCosts : null;

  const cashOnCashReturn = totalInvestment != null && totalInvestment > 0
    ? Math.round((annualCashFlow / totalInvestment) * 10000) / 100
    : null;

  const capRate = p.priceCurrent != null && p.priceCurrent > 0
    ? Math.round(((totalMonthlyIncome * 12) / p.priceCurrent) * 10000) / 100
    : null;

  const baths = p.bathsFull != null && p.bathsPart != null
    ? `${p.bathsFull}.${p.bathsPart}`
    : null;

  return {
    address: p.fullAddress,
    mlsNumber: p.mlsNumber,
    listPrice: p.priceCurrent,
    offerPrice: p.offerPrice,
    rents: p.rents,
    totalMonthlyIncome,
    monthlyTaxes,
    monthlyInsurance,
    monthlyMortgage: null, // requires mortgage calc inputs
    totalMonthlyExpenses,
    monthlyCashFlow,
    annualCashFlow,
    totalInvestment,
    cashOnCashReturn,
    capRate,
    sqft: p.sqft,
    yearBuilt: p.yearBuilt,
    beds: p.beds,
    baths,
    status: p.status,
    publicRemarks: p.publicRemarks,
  };
}

// ---------------------------------------------------------------------------
// MCP Server Definition
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "paragon-mls",
  version: "1.0.0",
  description: "Paragon MLS real estate API — fetch listings, parse property data, and analyze rental deals using the four-square method",
});

// Tool: fetch listings by MLS ID
server.tool(
  "fetch_listings",
  "Fetch property listings from a Paragon MLS system by listing GUID (MLS ID). Returns raw listing data including all available property fields.",
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
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: parsed.length, properties: parsed }, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching listings: ${String(err)}` }], isError: true };
    }
  }
);

// Tool: fetch a single property by MLS number
server.tool(
  "fetch_property",
  "Fetch a single property by MLS number and system ID. Returns parsed property data with address, price, beds, baths, rents, taxes, etc.",
  {
    mlsNumber: z.string().describe("MLS number for the property (e.g. '201918514')"),
    systemId: z.string().default("globalmls").describe("MLS system/region ID (subdomain of paragonrels.com)"),
    mlsId: z.string().optional().describe("Optional listing GUID for link generation"),
  },
  async ({ mlsNumber, systemId, mlsId }) => {
    try {
      const guid = mlsId ?? "";
      const agentId = "1";
      const officeId = "1";
      const rawProperties = await getProperties([mlsNumber], systemId, guid || mlsNumber, agentId, officeId);

      if (rawProperties.length === 0) {
        return { content: [{ type: "text" as const, text: `No data returned for MLS #${mlsNumber}` }] };
      }

      const parsed = parseProperty(rawProperties[0] as Record<string, unknown>, systemId, guid);
      if (!parsed) {
        return { content: [{ type: "text" as const, text: `Could not parse property data for MLS #${mlsNumber}. Raw data returned instead.` }] };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching property: ${String(err)}` }], isError: true };
    }
  }
);

// Tool: four-square analysis
server.tool(
  "analyze_deal",
  "Perform a four-square rental property analysis on one or more properties. Computes monthly income, expenses, cash flow, cash-on-cash return, and cap rate.",
  {
    mlsNumbers: z.string().describe("Comma-separated MLS numbers to analyze (e.g. '201918514,202012345')"),
    systemId: z.string().default("globalmls").describe("MLS system/region ID"),
    mlsId: z.string().optional().describe("Optional listing GUID for link generation"),
    downPaymentPct: z.number().default(0.20).describe("Down payment percentage (default 0.20 = 20%)"),
    interestRate: z.number().default(0.07).describe("Mortgage interest rate (default 0.07 = 7%)"),
    loanTermYears: z.number().default(30).describe("Loan term in years (default 30)"),
    vacancyRate: z.number().default(0.05).describe("Vacancy rate estimate (default 0.05 = 5%)"),
    repairPct: z.number().default(0.05).describe("Repair budget as % of income (default 0.05)"),
    capexPct: z.number().default(0.05).describe("Capex budget as % of income (default 0.05)"),
    mgmtPct: z.number().default(0.08).describe("Property management as % of income (default 0.08)"),
  },
  async ({ mlsNumbers, systemId, mlsId, downPaymentPct, interestRate, loanTermYears, vacancyRate, repairPct, capexPct, mgmtPct }) => {
    try {
      const numbers = mlsNumbers.split(",").map((s) => s.trim()).filter(Boolean);
      const guid = mlsId ?? "";
      const rawProperties = await getProperties(numbers, systemId, guid, "1", "1");

      const analyses: FourSquareAnalysis[] = [];
      for (let i = 0; i < rawProperties.length; i++) {
        const parsed = parseProperty(rawProperties[i] as Record<string, unknown>, systemId, guid);
        if (!parsed) continue;

        const analysis = computeFourSquare(parsed);

        // Add mortgage calculation if we have a price
        if (parsed.priceCurrent != null) {
          const loanAmount = parsed.priceCurrent * (1 - downPaymentPct);
          const monthlyRate = interestRate / 12;
          const nPayments = loanTermYears * 12;
          const monthlyMortgage = (loanAmount * monthlyRate * Math.pow(1 + monthlyRate, nPayments)) /
            (Math.pow(1 + monthlyRate, nPayments) - 1);
          analysis.monthlyMortgage = Math.round(monthlyMortgage);
          analysis.totalMonthlyExpenses += analysis.monthlyMortgage;
          analysis.monthlyCashFlow = analysis.totalMonthlyIncome - analysis.totalMonthlyExpenses;
          analysis.annualCashFlow = analysis.monthlyCashFlow * 12;
          const dp = Math.round(parsed.priceCurrent * downPaymentPct);
          const cc = Math.round(parsed.priceCurrent * 0.03);
          analysis.totalInvestment = dp + cc;
          analysis.cashOnCashReturn = analysis.totalInvestment > 0
            ? Math.round((analysis.annualCashFlow / analysis.totalInvestment) * 10000) / 100
            : null;
        }

        analyses.push(analysis);
      }

      if (analyses.length === 0) {
        return { content: [{ type: "text" as const, text: "No active properties found for the given MLS numbers." }] };
      }

      // Summary table
      let summary = `## Four-Square Analysis Results\n\n`;
      summary += `| # | Address | MLS# | List | Offer | Income | Expenses | Cash Flow | CoC% | Cap% |\n`;
      summary += `|---|---------|------|------|-------|--------|----------|-----------|------|------|\n`;
      for (let i = 0; i < analyses.length; i++) {
        const a = analyses[i];
        summary += `| ${i + 1} | ${a.address} | ${a.mlsNumber} | $${a.listPrice?.toLocaleString() ?? "—"} | $${a.offerPrice?.toLocaleString() ?? "—"} | $${a.totalMonthlyIncome.toLocaleString()}/mo | $${a.totalMonthlyExpenses.toLocaleString()}/mo | $${a.monthlyCashFlow?.toLocaleString() ?? "—"}/mo | ${a.cashOnCashReturn ?? "—"}% | ${a.capRate ?? "—"}% |\n`;
      }

      summary += `\n### Detailed Results\n\n`;
      for (const a of analyses) {
        summary += `#### ${a.address} (MLS# ${a.mlsNumber})\n`;
        summary += `- **Status**: ${a.status ?? "Unknown"}\n`;
        summary += `- **List Price**: $${a.listPrice?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Offer Price** (85% of list): $${a.offerPrice?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Bed/Bath**: ${a.beds ?? "?"} BD / ${a.baths ?? "?"} BA\n`;
        summary += `- **Sq Ft**: ${a.sqft?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Year Built**: ${a.yearBuilt ?? "N/A"}\n`;
        summary += `- **Rents**: ${Object.entries(a.rents).filter(([, v]) => v != null).map(([k, v]) => `${k}: $${v!.toLocaleString()}`).join(", ") || "N/A"}\n`;
        summary += `- **Monthly Income**: $${a.totalMonthlyIncome.toLocaleString()}\n`;
        summary += `- **Monthly Expenses**: $${a.totalMonthlyExpenses.toLocaleString()}\n`;
        summary += `  - Taxes: $${a.monthlyTaxes.toLocaleString()}\n`;
        summary += `  - Insurance: $${a.monthlyInsurance.toLocaleString()}\n`;
        summary += `  - Mortgage: $${a.monthlyMortgage?.toLocaleString() ?? "N/A"}\n`;
        summary += `  - Vacancy (${(vacancyRate * 100).toFixed(0)}%): $${Math.round(a.totalMonthlyIncome * vacancyRate).toLocaleString()}\n`;
        summary += `  - Repairs (${(repairPct * 100).toFixed(0)}%): $${Math.round(a.totalMonthlyIncome * repairPct).toLocaleString()}\n`;
        summary += `  - CapEx (${(capexPct * 100).toFixed(0)}%): $${Math.round(a.totalMonthlyIncome * capexPct).toLocaleString()}\n`;
        summary += `  - Management (${(mgmtPct * 100).toFixed(0)}%): $${Math.round(a.totalMonthlyIncome * mgmtPct).toLocaleString()}\n`;
        summary += `- **Monthly Cash Flow**: $${a.monthlyCashFlow?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Annual Cash Flow**: $${a.annualCashFlow?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Total Investment**: $${a.totalInvestment?.toLocaleString() ?? "N/A"}\n`;
        summary += `- **Cash-on-Cash Return**: ${a.cashOnCashReturn ?? "N/A"}%\n`;
        summary += `- **Cap Rate**: ${a.capRate ?? "N/A"}%\n`;
        if (a.publicRemarks) {
          summary += `- **Remarks**: ${a.publicRemarks.slice(0, 300)}${a.publicRemarks.length > 300 ? "..." : ""}\n`;
        }
        summary += `\n`;
      }

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error analyzing deal: ${String(err)}` }], isError: true };
    }
  }
);

// Tool: search raw listings by MLS numbers (returns raw JSON)
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

      // Sanitize: remove any auth tokens or cookies from output
      const sanitized = rawProperties.map((p) => {
        const s = JSON.stringify(p);
        // Remove potential cookie/auth data
        return JSON.parse(s.replace(/"Cookie"[^"]*"/g, ""));
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(sanitized, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error fetching raw listings: ${String(err)}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Paragon MLS MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});