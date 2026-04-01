---
name: inspect-carrier
description: Look up a carrier by ID and show all data sources, report output, and diagnose issues.
argument-hint: <carrier-id>
allowed-tools: Bash, Read, Grep
---

Full investigation of a carrier across all data sources.

## Steps

1. **Load from carrier-db.json** using `node -e` with `readCarrierDb()`:
   - SMP tags, company, balance, credit_limit
   - Zoho application_date, stage
   - Derived: is_debtor, account_status, PHP, dates, credit_score

2. **Check CMP data:**
   - Invoices (count, statuses, amounts, due dates)
   - Billing history (last 5 transactions)

3. **Check collection-placement-db.json:**
   - Match via debtor-master-db company name → normalized key
   - Show: delinquency date, collection_cases.date_placed, invoice agency dates
   - Invoice statuses and remaining amounts

4. **Check other sources:**
   - payment-verifications-db.json (last_invoice_date)
   - accounting-client-db.json (date_filled)
   - data/dob.json

5. **Check report output:**
   - Is it in LOC report? Debtor report? Neither?
   - Show carrierToRow output: PHP month-by-month, status, dates, balance

6. **Diagnose issues:**
   - Wrong PHP codes (D after G, repeated 6, delinq after G)
   - Wrong status (11 for closed, 13 for active, 93)
   - Missing from report (why filtered out?)
   - Missing DOB

## Example

```
/inspect-carrier 5747293
```
