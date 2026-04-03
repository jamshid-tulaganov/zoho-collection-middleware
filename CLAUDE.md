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
npm run report:send-debtors          # Generate debtors-only report → Telegram
npm run report:send-combined         # Generate LOC + debtors combined → Telegram
npm run report:send-sync             # Refresh carrier-db first, then LOC report
npm run report:financial-risk        # Financial risk report → Telegram
npm run import:tss-collection        # Dry-run TSS bad-debtor Excel import
npm run import:tss-collection:apply  # Apply TSS import to debtor-master-db.json
npm run db:migrate                   # Migrate all JSON databases → MongoDB
```

No test runner — verify by running the server and hitting endpoints or using Telegram commands.

## Architecture

### Report Generation (`src/services/arrayReport.js`)

The default Array report combines **LOC + debtor** carriers in one file. Key rules:

**Carrier classification:**
- **LOC**: SMP tag 2 + Zoho Card Swiped + NOT debtor tag 1 + NOT in collection-placement-db
- **Debtor**: in collection-placement-db + has unpaid CMP invoices + has agency assigned
- **Paid debtor → LOC**: collection-db paid + no agency, OR all CMP invoices PAID → returns to LOC
- **Excluded**: no data from any source (no CMP, no verification, no collection data)

**Required for all carriers:**
- DOB (carriers without DOB are excluded)
- Portfolio Type always `C`, Account Type always `15` (TSS is the creditor)
- Billing data from at least one source (CMP invoices, CMP billing, or verification spreadsheet)

**Payment History Profile (PHP) rules:**
- `B` = before account open (uses Zoho Application_Date, fallback to accounting date_filled)
- `0` = current / paid on time
- `1-6` = months delinquent (from date_of_delinquency in collection-placement-db)
- `G` = in collection. Starts from `collection_cases.date_placed` (primary) or invoice agency transfer dates (fallback). Once G starts, stays G — never replaced by D. After 7+ months delinquency without agency → also G.
- `D` = after account closed. Only for truly closed carriers (no CMP activity). Active carriers with paid invoices do NOT get D codes.

**Account Status:**
- `11` = active/current
- `13` = closed (has D codes in PHP)
- `71-84` = delinquent (months overdue: 71=30d, 78=60d, 80=90d, 82=120d, 83=150d, 84=180d+)
- Never use `93` (collection agency status — TSS is creditor, not agency)

**Balance/Credit Limit:**
- Active LOC: show actual values from CMP
- Debtors: both 0
- Closed: both 0

### Dual Sync Paths

1. **MongoDB sync** (`src/services/sync.js`) — runs at midnight UTC via cron.
2. **File-based sync** (`src/services/syncCarrierDb.js`) — runs at 7am ET (12:00 UTC) via cron. Produces `data/carrier-db.json`, the **primary data source** for report generation.

Reports always read from `carrier-db.json`, not MongoDB.

### WEX DOB Lookup (`src/services/wexHttp.js`)

Playwright-based DOB lookup from WEX (Salesforce Experience Cloud). Persistent browser session — opens once, reuses for all lookups. Lazy import — server starts without Playwright on Render.

- **Telegram**: `/wex <carrierId> <companyName>` — looks up DOB and saves to `dob.json`
- **HTTP**: `POST /telegram/wex-lookup` with `{carrierId, companyName}`
- **Batch**: `node scripts/batch-dob-wex.js --apply` — bulk lookup with resume support
- **G-code source priority**: `collection_cases.date_placed` → invoice agency transfer dates. `sent_to_collection_date` is NOT used (unreliable spreadsheet entry date).

### Data Flow

```
SMP API (companies, invoices, billing)
  + Zoho CRM (deals at "Card Swiped" stage)
  + db/collection-placement-db.json (debtors, agency placements)
  + db/payment-verifications-db.json (historical invoice data, close dates)
  + data/dob.json (DOB lookup map from WEX)
  → syncCarrierDb merges all into data/carrier-db.json
  → arrayReport filters, augments, builds Excel
  → Telegram bot delivers to chat
```

### Key API Endpoints

- `GET /` — health check with sync status
- `POST /carrier-db/sync` — trigger file-based sync (background)
- `GET /reports/generate` — download Excel
- `POST /telegram/webhook` — Telegram bot commands (`/report`, `/wex`)
- `POST /telegram/wex-lookup` — WEX DOB lookup via HTTP
- `POST /hooks/zoho` — Zoho webhook receiver

## Data Storage

### MongoDB Collections (primary)

| Collection | Model | Source | Purpose |
|------------|-------|--------|---------|
| `carrierdatas` | `CarrierData` | syncCarrierDb.js | Merged carrier records (SMP + Zoho + accounting + collection) |
| `collectionplacements` | `CollectionPlacement` | collection-placement-db.json import | Debtor agency placements + collection cases |
| `paymentverifications` | `PaymentVerification` | payment-verifications-db.json import | Historical invoice data for closed carriers |
| `accountingclients` | `AccountingClient` | accounting-client-db.json import | Application dates, contact info |
| `mastercarriers` | `MasterCarrier` | debtor-master-db.json import | Basic carrier identity + DOB |
| `dobentries` | `DobEntry` | WEX/iSoftPull lookups | DOB cache |

### File Directories

| Directory | Purpose |
|-----------|---------|
| `db/` | JSON database files (legacy, migrated to MongoDB via `npm run db:migrate`) |
| `data/` | Runtime files. `dob.json`, `wex-dob-progress.json`. Not in git. |
| `scripts/` | CLI scripts for sync, reports, imports, migration |
| `spreadsheets/` | Template + source Excel files. `Array_Credit_Reporting_Workbook_General.xlsx` is the Metro 2 reference. |

## Business Domain

### Date Open Priority

1. Zoho `Application_Date` (TSS card application date)
2. Accounting `date_filled` (from `accounting-client-db.json`, parsed from MM/DD/YYYY)
3. `derived.date_open` from sync (fallback)

Never use `oldest_open_date` from accounting — that's the company founding date, not the TSS card date.

### Closed Carrier Detection

- **CMP-based**: no unpaid invoices + last activity > 30 days ago
- **Verification-based**: carrier has no CMP data but has `payment-verifications-db.json` entry → use `last_invoice_date` as close date
- **Paid debtors**: all CMP invoices PAID or all CMP paid + no agency → NOT closed, returns to LOC as active
- Active carriers (billing history or paid invoices, not active debtors) → never marked as closed

## Environment

- **Runtime**: Node.js 22, ES modules (`"type": "module"`)
- **MongoDB**: Required — primary data store for all collections (Atlas `collectiondb`)
- **Deployment**: Render.com (`render.yaml`) with 1GB persistent disk at `/opt/render/project/src/data/`
- **Playwright**: devDependency, required for WEX DOB lookup (local only)
- See `.env.example` for all environment variables

## Cron Schedule

| Time | Job | Function |
|------|-----|----------|
| Midnight UTC | MongoDB full sync | `runFullSync()` |
| 12:00 UTC (7am ET) | File-based carrier-db sync | `runCarrierDbSync()` |
