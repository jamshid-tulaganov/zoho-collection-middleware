# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Node.js Express middleware service ("collection-middleware") that aggregates debtor data from SMP/CMP API, Zoho CRM, and spreadsheet-derived JSON databases, computes Metro 2 Array credit report fields for each carrier, and generates Excel reports for submission to Array (credit bureau). Reports are delivered via REST API and Telegram bot.

Part of the Octane ecosystem alongside the parent repo's Zoho Deluge scripts, `sales-report-bot`, and `zoho-octane`.

## Commands

```bash
npm run dev                          # Start with --watch (hot reload), port 3001
npm start                            # Production start (--max-old-space-size=512)
npm run sync:carrier-db              # One-off file-based carrier sync (no server)
npm run report:send                  # Generate LOC Array report → Telegram
npm run report:send -- --debtors     # Generate debtors/collection report → Telegram
npm run report:send -- --sync        # Refresh carrier-db first, then generate
npm run report:send-collections      # Alias for --collections flag
npm run report:financial-risk        # Financial risk report → Telegram
npm run import:tss-collection        # Dry-run TSS bad-debtor Excel import
npm run import:tss-collection:apply  # Apply TSS import to debtor-master-db.json
```

No test runner — verify by running the server and hitting endpoints or using Telegram commands.

## Architecture

### Dual Sync Paths

The service maintains two parallel data pipelines that compute the same Metro 2 fields:

1. **MongoDB sync** (`src/services/sync.js`) — runs at midnight UTC via cron. Fetches SMP companies + Zoho deals, computes Metro 2, upserts to `Client` collection. Used by webhook-based updates (`/hooks/zoho`).

2. **File-based sync** (`src/services/syncCarrierDb.js`) — runs at 7am ET (12:00 UTC) via cron. Produces `data/carrier-db.json` (~26MB), the **primary data source** for report generation. Supports incremental fetching via SMP caches (`db/smp-data-cache.json`, `db/smp-data-cache-billing.json`).

Reports always read from `carrier-db.json`, not MongoDB.

### Metro 2 Computation

`src/services/metro2.js` → `computeMetro2()` is the core function. It takes a carrier ID plus data from SMP, Zoho, and the master DB, and produces all 48 Array credit report fields (SSN, name, address, account status codes, 24-char payment history profile, amounts, dates).

`src/services/arrayReport.js` orchestrates report generation: loads carrier-db.json, filters carriers, calls `buildReportRows()` to produce 48-column rows, and creates an ExcelJS workbook.

### Data Flow

```
SMP API (companies, invoices, billing)
  + Zoho CRM (deals at "Card Swiped" stage)
  + db/debtor-master-db.json (debtor timelines, billing cycles)
  + db/collection-placement-db.json (collection cases by invoice)
  + data/dob.json (DOB lookup map)
  → syncCarrierDb merges all into data/carrier-db.json
  → arrayReport reads carrier-db.json → Excel (.xlsx)
  → Telegram bot delivers to chat
```

### Key API Endpoints

- `GET /` — health check with sync status
- `POST /carrier-db/sync` — trigger file-based sync (background)
- `GET /carrier-db/status` — sync progress
- `GET /reports/generate?debtor_report=true&sync=true&compact=false` — download Excel
- `GET /reports/json` — JSON version of report data
- `POST /hooks/zoho` — Zoho webhook receiver (updates MongoDB `Client` on Debtor changes)
- `POST /telegram/webhook` — Telegram bot commands (`/report`, `/report collections`, `/financial-risk`)

### External API Integrations

- **SMP/CMP** (`src/services/smp.js`) — TSS Fuel Manager API. Token-based auth with automatic refresh. Fetches companies (by tag), invoices, billing history. Token refresh serializes concurrent requests.
- **Zoho CRM** (`src/services/zoho.js`) — OAuth token refresh (45min expiry). Fetches deals. Auto-retries on 401 (re-auth) and 429 (rate limit).
- **Telegram** (`src/routes/telegram.js`) — Webhook-based bot for report delivery and commands.
- **WEX / iSoftPull** — Playwright-based DOB scraping (local-only, requires `playwright` devDependency).

## Data Files

| Directory | Purpose |
|-----------|---------|
| `db/` | Reference/static JSON databases (master carrier list, debtor timelines, accounting contacts, collection placements). Checked into git. |
| `data/` | Generated/runtime files (carrier-db.json, dob.json, telegram-users.json). Not in git. On Render, `data/` is a persistent disk. |
| `spreadsheets/` | Generated Excel reports (Array_Credit_Report_*.xlsx). |

## Business Domain

### Metro 2 Account Status Codes

- `11` = current/open account
- `62` = paid in full / closed
- Payment history profile: 24-char string where each char = one month. `1`–`6` = months delinquent, `G` = collection/chargeoff, `0` = current.

### Collection Escalation (from parent CLAUDE.md)

Overdue days counted from oldest `Due_Date` across unpaid invoices:
- Day 0–14: tag only
- Day 15–29: First Type if < 25% paid
- Day 30–44: Second Type if < 50% paid
- Day 45+: Third Type if < 100% paid; Charged + deactivate if fully paid

### Debtor Sources

`debtor-master-db.json` tracks debtor timeline entries with sources: `soft` (soft delinquency), `hard` (hard delinquency), `GGR` (gone/grossly delinquent). The `collection-placement-db.json` maps invoice numbers to collection agency placements.

## Environment

- **Runtime**: Node.js 22, ES modules (`"type": "module"`)
- **MongoDB**: Optional — service works fully with just file-based carrier-db.json
- **Deployment**: Render.com (`render.yaml`) with 1GB persistent disk at `/opt/render/project/src/data/`
- **`.env` loading**: `src/config/env.js` loads from `collections/.env`, falls back to `../telegram-bot/.env` and `../servercrm/.env` for shared credentials
- See `.env.example` for all environment variables

## Cron Schedule

| Time | Job | Function |
|------|-----|----------|
| Midnight UTC | MongoDB full sync | `runFullSync()` |
| 12:00 UTC (7am ET) | File-based carrier-db sync | `runCarrierDbSync()` |
