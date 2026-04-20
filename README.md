# Paragon MLS MCP Server

An MCP (Model Context Protocol) server that interfaces with the Paragon MLS real estate API to fetch property listings and perform four-square rental investment analysis.

## Features

- **`fetch_listings`** — Fetch all listings from a Paragon MLS listing GUID
- **`fetch_property`** — Fetch a single property by MLS number
- **`analyze_deal`** — Full four-square rental analysis with customizable assumptions (down payment %, interest rate, vacancy, etc.)
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
- **No Google OAuth dependency** — removed the Google Sheets integration (that can be added via other MCP tools)
- **Input validation** — all tool inputs validated via Zod schemas
- **Timeout guards** — all HTTP requests have configurable timeouts
- **Error sanitization** — no secrets or auth tokens in error messages
- **Sequential processing** — listings processed one at a time to respect rate limits

## License

MIT (derived from the original repo by earlvanze)