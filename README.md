# Collections Service

Node.js service for the collection department workflow.

## What it does

- Maintains a cached `carrier-db.json` from Zoho CRM, SMP, and offline debtor data
- Uses `db/accounting-client-db.json` as a fallback source for missing contact fields
- Exposes sync and status endpoints for the carrier database
- Generates Array / Metro 2 report output from the local carrier DB cache
- Supports Telegram bot delivery of the Array report via `/telegram/webhook`
- Ships with `db/debtor-master-db.json` so the offline debtor source lives inside this repo

## Local development

```bash
npm install
npm run dev
```

## Key commands

```bash
npm run start
npm run sync:carrier-db
```

## Environment

Copy `.env.example` to `.env` and fill in the required Zoho and SMP credentials.
`MASTER_DB_PATH` defaults to `./db/debtor-master-db.json`.
`ACCOUNTING_DB_PATH` defaults to `./db/accounting-client-db.json`.

## Telegram

- Register webhook: `GET /telegram/register-webhook`
- Inspect webhook: `GET /telegram/webhook-info`
- Telegram command: `/report`
- Optional command variant: `/report sync` to refresh `carrier-db.json` before building the file
