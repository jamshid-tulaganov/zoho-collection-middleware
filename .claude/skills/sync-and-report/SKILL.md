---
name: sync-and-report
description: Generate Array Credit Report (combined LOC + debtors) and send to Telegram. Use when user says "generate report", "send report", "array report".
argument-hint: [--debtors] [--sync] [--dry-run]
allowed-tools: Bash, Read, Glob, Grep
---

Generate an Array Credit Report from the carrier database.

The default report combines LOC + debtor carriers in one file. Only `--debtors` produces a debtors-only report.

## Steps

1. **Parse flags from $ARGUMENTS:**
   - `--debtors` → debtor/collection report only
   - `--sync` → refresh carrier-db.json before building report
   - `--dry-run` → build report locally without sending to Telegram

2. **If `--sync` requested:** run `npm run sync:carrier-db` first.

3. **Generate and send:**
   - Default: `node send-array-report.js`
   - With flags: `node send-array-report.js --debtors` or `--sync`

4. **Report rules (from CLAUDE.md):**
   - All carriers must have DOB
   - Portfolio=C, AccountType=15 always
   - PHP: B before open, 0 current, 1-6 delinquent, G collection (continuous), D closed
   - G source: collection_cases.date_placed (primary), invoice agency dates (fallback)
   - Status: 11 active, 13 closed, 71-84 delinquent
   - Paid debtors (no agency) go to LOC, not debtor report

## Examples

```
/sync-and-report                     # Combined LOC + debtors → Telegram
/sync-and-report --debtors           # Debtors only → Telegram
/sync-and-report --sync              # Refresh first, then combined report
```
