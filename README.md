# Collections Service

Node.js service for the collection department workflow.

## What it does

- Maintains a cached `carrier-db.json` from Zoho CRM, SMP, and offline debtor data
- Exposes sync and status endpoints for the carrier database
- Generates Array / Metro 2 report output from the local carrier DB cache

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
