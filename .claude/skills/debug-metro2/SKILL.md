---
name: debug-metro2
description: Debug Metro 2 field computation for a specific carrier — trace how each of the 48 Array fields is derived from SMP, Zoho, and master-db data sources.
argument-hint: <carrier-id>
allowed-tools: Bash, Read, Grep, Glob
---

Trace and debug how Metro 2 fields are computed for a specific carrier.

## Steps

1. **Load the carrier record** from `data/carrier-db.json` for carrier ID $ARGUMENTS.

2. **Read the computation logic** in `src/services/metro2.js` (`computeMetro2` function).

3. **Trace each field's derivation:**
   - **Name fields:** which source won (Zoho deal → SMP contact → accounting fallback)?
   - **SSN/DOB:** where did it come from (zoho.ssn_raw, zoho.dob_raw, dob.json, master-db)?
   - **Address:** which address source was used and why?
   - **Account_Status:** is it 11 (open) or 62 (closed)? Based on what condition?
   - **Payment_History_Profile:** explain each of the 24 characters — which months are G (collection), 1-6 (delinquent), 0 (current), B (before open)?
   - **Date_of_First_Delinquency:** how was this date determined?
   - **Amount_Past_Due / Credit_Limit / Highest_Credit:** source values

4. **Check for problems:**
   - Fields that are empty or defaulted when they shouldn't be
   - Payment history profile inconsistencies (e.g., G codes before collection date)
   - Missing delinquency date when account is delinquent
   - Address field truncation issues

5. **Show the raw data** from each source (SMP block, Zoho block, master-db entry) alongside the computed Metro 2 output.

## Example

```
/debug-metro2 12345
```
