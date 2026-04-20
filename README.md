# Paragon MLS MCP Server

An MCP (Model Context Protocol) server that interfaces with the Paragon MLS real estate API to fetch property listings and perform four-square rental investment analysis.

## Features

- **`fetch_listings`** — Fetch all listings from a Paragon MLS listing GUID
- **`fetch_property`** — Fetch a single property by MLS number
- **`analyze_deal`** — Spreadsheet-compatible Four-Square analysis with the major columns from the Google Sheet, including NOI, DSCR, principal paydown, appreciation, depreciation, ROI, ROE, and IRR
- **`vb_calc`** — Velocity banking comparison across amortized debt, extra payments, chunking/basic acceleration, and advanced debt acceleration
- **`raw_listings`** — Raw JSON data from the Paragon API for custom analysis

## Installation

```bash
cd paragon-mls-mcp
npm install
npm run build
```

## Usage with OpenClaw

The server is already wired into the OpenClaw gateway config (`mcp.servers.paragon-mls`). After restart, the four tools will be available to all agents.

You can also call it directly:

```bash
# Via mcporter
mcporter call paragon-mls.fetch_property mlsNumber="201918514" systemId="globalmls"
mcporter call paragon-mls.analyze_deal mlsNumbers="201918514" systemId="globalmls" holdingPeriodYears:5 downPaymentPct:0.25
mcporter call paragon-mls.vb_calc debtBalance:350000 interestRate:0.05 loanTermYears:30 monthlyIncome:8000 monthlyExpenses:4878.875681 extraPayment:1000

# Via MCP inspector
npx @modelcontextprotocol/inspector dist/index.js
```

## System IDs

Common Paragon MLS system IDs (the subdomain before `.paragonrels.com`):

| Region | System ID |
|--------|-----------|
| Eastern NY / Southern Adirondack | `globalmls` |
| InterMountain (Idaho) | `imls` |
| SW Colorado | `cren` |
| Hudson County, NJ | `hudson` |
| Georgia | `gamls` |
| Triangle Region, NC | `triangle` |

## Architecture

The original Python/Flask app was rewritten as a TypeScript MCP server with these hardening improvements:

- **No Flask/web server** — runs as a pure stdio MCP server
- **No filesystem writes** — all output is returned as structured JSON
- **No Google OAuth dependency** — removed the Google Sheets integration, but mirrored the spreadsheet's analysis formulas directly in the MCP server
- **Spreadsheet-compatible analysis** — `analyze_deal` now tracks the Four-Square Analysis tab structure instead of a simplified summary
- **Velocity banking support** — `vb_calc` compares amortized debt, extra payments, chunking/basic acceleration, and advanced VB
- **Input validation** — all tool inputs validated via Zod schemas
- **Timeout guards** — all HTTP requests have configurable timeouts
- **Error sanitization** — no secrets or auth tokens in error messages
- **Sequential processing** — listings processed one at a time to respect rate limits

## License

MIT (derived from the original repo by earlvanze)