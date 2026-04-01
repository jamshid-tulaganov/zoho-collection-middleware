---
name: sync-and-report
description: Sync carrier-db and generate an Array Credit Report, optionally sending to Telegram. Use when user says "generate report", "send report", "sync and report".
argument-hint: [--debtors] [--sync] [--dry-run]
allowed-tools: Bash, Read, Glob, Grep
---

Generate an Array Credit Report from the carrier database.

## Steps

1. **Parse flags from $ARGUMENTS:**
   - `--debtors` or `collections` → debtor/collection report (adds `--debtors` flag)
   - `--sync` → refresh carrier-db.json before building report
   - `--dry-run` → build report locally without sending to Telegram

2. **If `--sync` requested:** run `npm run sync:carrier-db` first and wait for completion.

3. **If `--dry-run`:** use Node to load carrier-db.json, call `loadReportCarriers()` and `writeArrayReportFile()` to write the Excel to `/tmp/`, then report the file path and row count. Do NOT send to Telegram.

4. **If NOT `--dry-run`:** run `npm run report:send` with the appropriate flags (`--debtors`, `--sync`). This sends to Telegram automatically.

5. **Report results:** carrier count, row count, any errors or missing-DOB warnings.

## Examples

```
/sync-and-report                     # LOC report → Telegram
/sync-and-report --debtors           # Debtor report → Telegram
/sync-and-report --sync --debtors    # Refresh first, then debtor report
/sync-and-report --dry-run           # Build LOC report locally, no Telegram
```
