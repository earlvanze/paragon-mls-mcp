---
name: paragon-mls
description: "Fetch real estate listings from Paragon MLS (paragonrels.com / fnimls.com) APIs and perform four-square rental property analysis. Use when: (1) looking up MLS property details by MLS number or listing ID, (2) analyzing rental properties for cash flow and cash-on-cash return, (3) comparing multiple investment properties, (4) extracting structured data from Paragon MLS listings. Supports any Paragon-backed MLS region (globalmls, imls, hudson, gamls, triangle, etc.)."
metadata:
  openclaw:
    requires:
      bins:
        - node
    mcp:
      paragon-mls:
        command: node
        args:
          - dist/index.js
        cwd: ..
---

# Paragon MLS

Fetch real estate listings from Paragon MLS APIs and analyze rental investment properties.

## Quick Start

1. Build and configure the MCP server once:

```bash
cd paragon-mls-mcp && npm install && npm run build
```

2. Add to `mcporter` config (or your MCP client config):

```bash
mcporter config add paragon-mls --command "node /home/umbrel/.openclaw/workspace/deal-analyst/paragon-mls-mcp/dist/index.js" --transport stdio
```

3. Use the tools:

```bash
# Fetch all listings from a shared MLS link
mcporter call paragon-mls.fetch_listings mlsId="6d70b762-36a4-4ac0-bedd-d0dae2920867" systemId="globalmls"

# Fetch a single property by MLS number
mcporter call paragon-mls.fetch_property mlsNumber="201918514" systemId="globalmls"

# Analyze a deal with four-square method
mcporter call paragon-mls.analyze_deal mlsNumbers="201918514" systemId="globalmls"

# Analyze multiple properties with custom assumptions
mcporter call paragon-mls.analyze_deal mlsNumbers="201918514,202012345" systemId="globalmls" downPaymentPct:0.25 interestRate:0.065

# Get raw JSON data
mcporter call paragon-mls.raw_listings mlsNumbers="201918514" systemId="globalmls"
```

## Tools

### `fetch_listings`
Fetch all property listings from a Paragon MLS listing GUID. Returns parsed property data for all active listings.

- **mlsId** (required): Paragon MLS listing GUID from the URL
- **systemId** (default: `globalmls`): MLS region ID (subdomain of paragonrels.com)

### `fetch_property`
Fetch a single property by its MLS number. Returns structured property data.

- **mlsNumber** (required): MLS number for the property
- **systemId** (default: `globalmls`): MLS region ID
- **mlsId** (optional): Listing GUID for link generation

### `analyze_deal`
Perform a full four-square rental analysis on one or more properties. Computes monthly income, expenses, cash flow, cash-on-cash return, and cap rate.

- **mlsNumbers** (required): Comma-separated MLS numbers
- **systemId** (default: `globalmls`): MLS region ID
- **mlsId** (optional): Listing GUID
- **downPaymentPct** (default: 0.20): Down payment percentage
- **interestRate** (default: 0.07): Mortgage interest rate
- **loanTermYears** (default: 30): Loan term in years
- **vacancyRate** (default: 0.05): Vacancy rate estimate
- **repairPct** (default: 0.05): Repair budget as % of income
- **capexPct** (default: 0.05): CapEx budget as % of income
- **mgmtPct** (default: 0.08): Property management as % of income

### `raw_listings`
Fetch raw JSON data from the Paragon API for custom analysis. Returns unprocessed listing data.

- **mlsNumbers** (required): Comma-separated MLS numbers
- **systemId** (default: `globalmls`): MLS region ID

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

Check your local MLS website URL to find the correct system ID.

## How It Works

The server calls Paragon's public CollabLink API endpoints:

1. **CreateGuid** — generates a session GUID for API calls
2. **GetNotificationAppData** — resolves a listing GUID into MLS numbers
3. **GetListingDetails** — fetches property data for each MLS number

Property data is parsed from Paragon's nested JSON structure, handling both the "new" format (section-based `DetailOptions`) and "old" format (array-based).

## Limitations

- Paragon's API is public but unofficial; it may change without notice
- Each MLS region may format listing data differently; the parser handles common formats but edge cases may require custom handling
- No authentication is required for public listing data
- The API returns data over HTTP (not HTTPS) for some regions
- Rate limiting may apply; the server processes listings sequentially with no intentional delay