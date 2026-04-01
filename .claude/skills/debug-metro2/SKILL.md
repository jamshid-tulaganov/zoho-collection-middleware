---
name: debug-metro2
description: Debug Payment History Profile (PHP) for a carrier — trace how each code is computed month by month.
argument-hint: <carrier-id>
allowed-tools: Bash, Read, Grep, Glob
---

Trace PHP computation for a specific carrier.

## Steps

1. **Load carrier data** from carrier-db.json, collection-placement-db.json, payment-verifications-db.json.

2. **Identify report path:** LOC or debtor? Show why.

3. **Trace PHP month by month (24 months):**
   - Show each month's code and WHY:
     - `B`: month < dateOpen (Zoho app date / accounting date_filled)
     - `0`: active, before delinquency
     - `1-6`: months past delinquency date
     - `G`: collection (from collection_cases.date_placed or 7+ months delinquent)
     - `D`: after close date (verification last_invoice_date for old clients)

4. **Verify rules:**
   - No D after G (G stays forever once in collection)
   - No repeated 6 (escalates to G at month 7)
   - No delinquency codes (1-6) after G position
   - Status matches PHP: D→13, G/1-6→71-84, 0→11

5. **Show data sources for key dates:**
   - Date Open: Zoho app date → accounting date_filled → derived
   - Delinquency: collection-placement-db earliest invoice_date
   - G start: collection_cases.date_placed → invoice agency dates
   - Close: verification last_invoice_date (if no CMP data)

## Example

```
/debug-metro2 5760497
```
