---
name: inspect-carrier
description: Look up a carrier in carrier-db.json by ID or company name and display their full record including Metro 2 fields, invoices, billing history, and debtor status.
argument-hint: <carrier-id or company-name>
allowed-tools: Bash, Read, Grep
---

Look up a specific carrier in the data and display their full record.

## Steps

1. **Load carrier-db.json** from `data/carrier-db.json`.

2. **Search for $ARGUMENTS:**
   - If numeric → match by `carrierId` (exact)
   - If text → match by company name (case-insensitive substring)
   - If multiple matches found, list them and ask user to pick one

3. **Display the carrier record** in a readable format, organized into sections:
   - **Identity:** carrierId, company name, contact name, phone, email
   - **SMP data:** balance, tags, billing cycle, address
   - **Zoho data:** deal name, DOB, SSN (masked), credit score, address
   - **Debtor status:** debtor flag, debtor_periods (soft/hard/GGR sources), debt_amount
   - **Metro 2 derived fields:** Account_Status, Payment_History_Profile, Date_of_First_Delinquency, Amount_Past_Due, Credit_Limit, Account_Type
   - **Invoices:** count, oldest due date, total amount, total paid, statuses
   - **Billing history:** recent transactions (last 5)
   - **Collection placement:** if present in collection-placement-db

4. **Flag issues:** missing DOB, missing SSN, missing address, no invoices, stale data.

Use `node -e` to load and query the JSON — do NOT read the full 26MB file with the Read tool.

## Example

```
/inspect-carrier 12345
/inspect-carrier "ABC Trucking"
```
