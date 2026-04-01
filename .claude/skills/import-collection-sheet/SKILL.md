---
name: import-collection-sheet
description: Import a TSS bad-debtor Excel spreadsheet into debtor-master-db.json. Supports dry-run preview and CMP cross-check.
argument-hint: [--apply] [--check-cmp] [path-to-xlsx]
disable-model-invocation: true
allowed-tools: Bash, Read, Glob
---

Import a TSS collection Excel spreadsheet into the debtor master database.

## Steps

1. **Parse flags from $ARGUMENTS:**
   - `--apply` → actually write changes to `db/debtor-master-db.json`
   - `--check-cmp` → cross-check against SMP companies
   - A file path → use that spreadsheet instead of the default
   - No flags → dry-run preview (default, safe)

2. **If a custom spreadsheet path is provided**, verify the file exists. If not provided, the script uses the default path configured in `scripts/import-tss-collection-sheet.js`.

3. **Run the import script:**
   - Dry-run: `npm run import:tss-collection`
   - Apply: `npm run import:tss-collection:apply`
   - CMP check: `npm run import:tss-collection:cmp`

4. **Review output:** show how many records were matched, merged, and any that failed to match a carrier ID.

5. **If `--apply` was used**, verify `db/debtor-master-db.json` was updated by checking its modification time and diffing the changes.

## Examples

```
/import-collection-sheet                          # Dry-run preview
/import-collection-sheet --apply                  # Apply changes
/import-collection-sheet --check-cmp              # Cross-check with SMP
```
