# Array Credit Report Rules

Source workbook: `spreadsheets/Array_Credit_Reporting_Workbook_General.xlsx`

These rules define how we build the Array credit report file and validate fields before export.

---

## 1) General Rules (Instructions Sheet)

- Do not delete template fields or columns. If not using, leave blank.
- Most fields: **alphanumeric only** (`0-9`, `A-Z`). No special characters.
  - Exception: address fields allow `/`, `-`, `.`
- All dates must be formatted as **`MMDDYYYY`** (8 digits, no separators).
- Do not report multiple people in `First Name` or `Last Name`.

---

## 2) File Layout (File Reporting Template Sheet)

Column order (48 data columns, 1-indexed from Col 2):

| Col | Field Name | Required |
|-----|-----------|---------|
| 2 | Association Code | R |
| 3 | First Name | R |
| 4 | Middle Name | — |
| 5 | Last Name | R |
| 6 | Generation Code | — |
| 7 | First Line of Address | R |
| 8 | Second Line of Address | — |
| 9 | City | R |
| 10 | State | R |
| 11 | Zip Code | R |
| 12 | Social Security Number | R |
| 13 | Telephone Number | — |
| 14 | Date of Birth | R |
| 15 | Consumer Information Indicator | When applicable |
| 16–28 | Joint fields (same pattern) | If joint account |
| 29 | Customer Account Number | R |
| 30 | Portfolio Type | R |
| 31 | Account Type | R |
| 32 | Date Open | R |
| 33 | Date of First Delinquency | When applicable |
| 34 | Date of Last Payment | When applicable |
| 35 | Date Closed | When applicable |
| 36 | Account Status | R |
| 37 | Payment Rating | When applicable |
| 38 | Special Comment Code | When applicable |
| 39 | Compliance Condition Code | When applicable |
| 40 | Credit Limit | When applicable |
| 41 | Highest Credit | R |
| 42 | Current Balance | R |
| 43 | Amount Past Due | When applicable |
| 44 | Monthly Payment | When applicable |
| 45 | Actual Payment | When applicable |
| 46 | Terms Frequency | When applicable |
| 47 | Terms | R |
| 48 | Original Charge Off Amount | When applicable |
| 49 | Payment History Profile | R |

---

## 3) Generation Codes

| Code | Description |
|------|------------|
| J | Junior |
| S | Senior |
| 2 | II |
| 3 | III |
| 4 | IV |
| 5 | V |
| 6 | VI |
| 7 | VII |
| 8 | VIII |
| 9 | IX |

---

## 4) ECOA (Association) Codes

| Code | Name | Description |
|------|------|------------|
| 1 | Individual | Has contractual responsibility; primarily responsible for payment |
| 2 | Joint Contractual Liability | Both customer and joint borrower contractually liable |
| 5 | Co-Maker or Guarantor | Liable if maker defaults |
| 7 | Maker | Subject is liable; co-maker liable if maker defaults |
| T | Terminated | Association with account terminated |
| X | Deceased | Consumer deceased |

**Our usage:** `"1"` (Individual) — the owner/guarantor of the commercial account.

---

## 5) Portfolio Types

| Code | Name | Description |
|------|------|------------|
| C | Line of Credit | Agreement to lend up to credit limit; revolving payments |
| I | Installment | Loan repayable in set monthly installments |
| M | Mortgage | Real estate conveyance with payment conditions |
| O | Open | Credit based on ability to pay; **entire balance due on demand** |
| R | Revolving | Maximum credit limit; monthly payments revolving on balance |

**Our usage rules:**
- Active LOC carrier (not debtor, not collection) → `"C"` (Line of Credit)
- Debtor or collection account (active or closed) → `"O"` (Open — entire balance due on demand)

---

## 6) Account Type Codes

| Code | Description |
|------|------------|
| 0 | Auto |
| 1 | Unsecured |
| 2 | Secured |
| 3 | Partially Secured |
| 4 | Home Improvement |
| 5 | FHA Home Improvement |
| 6 | Installment Sales Contract |
| 7 | Charge Account |
| 8 | Real estate, specific type unknown |
| 10 | Business Loan |
| 11 | Recreational Merchandise |
| 12 | Education |
| **13** | **Lease** ← **NOT "paid/closed"** |
| 15 | Line of Credit |
| 17 | Manufactured Housing |
| 18 | Credit Card |
| 19 | FHA Real Estate Mortgage |
| 20 | Note Loan |
| 25 | VA Real Estate Mortgage |
| 26 | Conventional Real Estate Mortgage |
| 29 | Rental Agreement |
| 37 | Combined Credit Plan |
| 43 | Debit Card |
| 47 | Credit Line Secured |
| **48** | **Collection Agency/Attorney** |
| 50 | Family Support |
| 65 | Government Unsecured Guaranteed Loan |
| 66 | Government Secured Guaranteed Loan |
| 67 | Government Unsecured Direct Loan |
| 68 | Government Secured Direct Loan |
| 69 | Government Grant |
| 70 | Government Overpayment |
| 71 | Government Fine |
| 72 | Government Fee for Services |
| 73 | Government Employee Advance |
| 74 | Government Misc. Debt |
| 75 | Government Benefit |
| 77 | Returned Check |
| 89 | Home Equity Line of Credit |
| 90 | Medical Debt |
| 91 | Debt Consolidation |
| 92 | Utility Company |
| 93 | Child Support |
| 95 | Attorney Fees |
| 0C | Debt Buyer |
| 0F | Construction Loan |
| 0G | Flexible Spending Credit Card |
| 6A | Commercial Installment Loan |
| 6B | Commercial Mortgage Loan |
| 6D | Home Equity |
| 7A | Commercial Line of Credit |
| 7B | Agricultural |
| 8A | Business Credit Card |
| 8B | Deposit Account with Overdraft Protection |
| 9B | Business Line Personally Guaranteed |

**Our usage rules:**
- LOC carrier (active **or** closed, not debtor/collection) → `"15"` (Line of Credit)
- Debtor or collection account (active **or** closed) → `"48"` (Collection Agency/Attorney)
- **IMPORTANT:** Account Type `13` means **Lease**, not "closed". Do NOT use `13` for closed accounts.
  The closed/paid state is captured entirely in **Account Status**, not Account Type.

---

## 7) Account Status Codes

| Code | Description |
|------|------------|
| 11 | Current account (0–29 days past the due date) |
| 13 | Paid or closed account / zero balance |
| 61 | Account paid in full; was a voluntary surrender |
| **62** | **Account paid in full; was a collection account** |
| 63 | Account paid in full; was a repossession |
| 64 | Account paid in full; was a charge-off |
| 65 | Account paid in full; foreclosure started |
| 71 | Account 30–59 days past due |
| 78 | Account 60–89 days past due |
| 80 | Account 90–119 days past due |
| 82 | Account 120–149 days past due |
| 83 | Account 150–179 days past due |
| 84 | Account 180+ days past due |
| 88 | Claim filed with government (insured portion of defaulted loan) |
| 89 | Deed received in lieu of foreclosure; balance may be due |
| 93 | Account assigned to internal or external collections |
| 94 | Foreclosure completed; balance may be due |
| 95 | Voluntary surrender; balance may be due |
| 96 | Merchandise repossessed; balance may be due |
| 97 | Unpaid balance reported as a loss (charge-off) |
| DA | Delete entire account (non-fraud) |
| DF | Delete entire account due to confirmed fraud |

**Our usage rules:**
- Active LOC (0-29d) → `"11"`
- Active LOC delinquent (30-59d to 180d+) → `"71"`, `"78"`, `"80"`, `"82"`, `"83"`, `"84"`
- In collection (active) → `"93"`
- Closed LOC (not collection) → `"13"`
- Closed collection account → `"62"` (paid in full; was a collection account)

**Derive Account Status from the first character of Payment History Profile:**

| PHP[0] | Account Status |
|--------|---------------|
| 0 or B | 11 (Current) |
| 1 | 71 (30-59d) |
| 2 | 78 (60-89d) |
| 3 | 80 (90-119d) |
| 4 | 82 (120-149d) |
| 5 | 83 (150-179d) |
| 6 | 84 (180d+) |
| G | 93 (Collection) |
| D | 13 (Closed/no data) |

Override for closed accounts:
- `isClosed && wasCollection` → `"62"`
- `isClosed && !wasCollection` → `"13"`

---

## 8) Payment History Profile Rules

**Length:** 24 characters (most recent → least recent, left to right).

**Rule:** Position 1 = Account Status code reported in the **previous** month's reporting period (mapped to PHP code). Fill from left (most recent) to right (oldest).

| Code | Meaning |
|------|---------|
| 0 | 0–29 days past due (current) |
| 1 | 30–59 days past due |
| 2 | 60–89 days past due |
| 3 | 90–119 days past due |
| 4 | 120–149 days past due |
| 5 | 150–179 days past due |
| 6 | 180+ days past due |
| B | No payment history prior to this time (account not open, or history cannot be furnished). **B may NOT be embedded within other values** — only at the right end. |
| D | No payment history available this month (closed account). D **may** be embedded. **Do not use D as a default to remove valid history.** |
| E | Zero balance + Account Status 11 (current). Applies to Credit Cards and Lines of Credit only. |
| G | Collection |
| H | Foreclosure Completed |
| J | Voluntary Surrender |
| K | Repossession |
| L | Charge-off |

**Example from workbook:**
```
Date 03/15/2023 → Status 78 (60-89d) → PHP = "1000000000000"
  (position 1 = "1" because prior month status was 71=30-59d → maps to code 1)

Date 04/15/2023 → Status 80 (90-119d) → PHP = "2100000000000"
  (position 1 = "2" because prior month status was 78=60-89d → maps to code 2)

Date 05/15/2023 → Status 11 (current) → PHP = "3210000000000"
  (position 1 = "3" because prior month status was 80=90-119d → maps to code 3)
```

**Our profile build logic:**
1. Before account open: `B`
2. After close grace period: `D` (closed, no activity)
3. From collection start month onward: `G`
4. 6 months leading up to collection: `1` (oldest, 6 months before) → `6` (newest, 1 month before G)
5. After delinquency date: escalate `1→2→3→4→5→6→G` each month
6. Default (current, paying): `0`

---

## 9) Payment Rating Codes

| Code | Description |
|------|------------|
| 0 | Current (0-29 days past due) |
| 1 | 30-59 days past due |
| 2 | 60-89 days past due |
| 3 | 90-119 days past due |
| 4 | 120-149 days past due |
| 5 | 150-179 days past due |
| 6 | 180+ days past due |
| G | Collection |
| L | Charge-off |

**Our usage:** Leave blank (Payment History Profile and Account Status are sufficient for our use case).

---

## 10) Special Comment Codes

| Code | Description |
|------|------------|
| Blank | Removes previous code / none applies |
| AB | Debt being paid through insurance |
| AC | Paying under a partial payment agreement |
| AH | Purchased by another company |
| AI | Recalled to active military duty |
| AM | Account payments assured by wage garnishment |
| AN | Account acquired by FDIC/NCUA |
| AO | Voluntarily surrendered – then redeemed or reinstated |
| AP | Credit line suspended |
| AS | Account closed due to refinance |
| AT | Account closed due to transfer |
| AU | Account paid in full for less than full balance (short sale) |
| AX | Account paid from collateral |
| AV | First payment never received (may indicate fraud) |
| AW | Affected by natural or declared disaster |
| AZ | Redeemed or reinstated repossession |
| BA | Transferred to recovery |
| BB | Full termination/status pending |
| BC | Full termination/obligation satisfied |
| BD | Full termination/balance owing |
| BE | Early termination/status pending |
| BF | Early termination/obligation satisfied |
| BG | Early termination/balance owing |
| BH | Early termination/insurance loss |
| BI | Involuntary repossession |
| BJ | Involuntary repossession/obligation satisfied |
| BK | Involuntary repossession/balance owing |
| BL | Credit card lost or stolen |
| BN | Paid by company which originally sold the merchandise |
| BO | Foreclosure proceedings started |
| BP | Paid through insurance |
| BT | Principal deferred/interest payment only |
| B | Account payments managed by financial counseling program |
| C | Paid by co-maker or guarantor |
| H | Loan assumed by another party |
| I | Election of remedy |
| M | Account closed at credit grantor's request |
| O | Account transferred to another company/servicer |
| S | Special handling – contact credit grantor |
| V | Adjustment pending |
| CI | Account closed due to inactivity |
| CJ | Credit line no longer available – in repayment phase |
| CK | Credit line reduced due to collateral depreciation |
| CL | Credit line suspended due to collateral depreciation |
| CM | Collateral released by creditor – balance owing |
| CN | Loan modified under a federal government plan |
| CO | Loan modified (non-government plan) |
| CP | Account in forbearance |
| CS | Used by Child Support Agencies for delinquent/collection accounts |
| DE | Debt extinguished under state law |

---

## 11) Consumer Information Indicators

| Code | Description |
|------|------------|
| Blank | Removes previously reported value, or none applies |
| A | Petition for Chapter 7 Bankruptcy |
| B | Petition for Chapter 11 Bankruptcy |
| C | Petition for Chapter 12 Bankruptcy |
| D | Petition for Chapter 13 Bankruptcy |
| E | Discharged through Bankruptcy Chapter 7 |
| F | Discharged through Bankruptcy Chapter 11 |
| G | Discharged through Bankruptcy Chapter 12 |
| H | Discharged/Completed through Bankruptcy Chapter 13 |
| Q | Removes previously reported Bankruptcy Indicator |
| R | Chapter 7 Reaffirmation of Debt |
| V | Chapter 7 Reaffirmation of Debt Rescinded |
| S | Removes Reaffirmation of Debt indicators |
| T | Credit grantor cannot locate consumer |
| U | Consumer now located |
| 1A | Personal Receivership |
| 2A | Lease Assumption |

---

## 12) Compliance Condition Codes

| Code | Description |
|------|------------|
| Blank | Retains previously reported code |
| XA | Account closed at consumer's request |
| XB | Account information disputed by consumer (FCRA) |
| XC | Investigation completed – consumer disagrees |
| XD | Account closed and in dispute under FCRA |
| XE | Account closed, dispute investigation completed, consumer disagrees |
| XF | Account in dispute under FCBA |
| XG | FCBA dispute resolved – consumer disagrees |
| XH | Account previously in dispute – now resolved |
| XJ | Account closed and in dispute under FCBA |
| XR | Removes the most recently reported Compliance Condition Code |

---

## 13) Terms Frequency Codes

| Code | Description |
|------|------------|
| D | Deferred |
| P | Single Payment Loan |
| W | Weekly |
| B | Biweekly |
| E | Semimonthly |
| M | Monthly |
| L | Bimonthly |
| Q | Quarterly |
| T | Triannually |
| S | Semiannually |
| Y | Annually |

**Our usage:** `"W"` (Weekly) — carriers are billed weekly.

---

## 14) Implementation Verification

### metro2.js — Known Issues Fixed

| Field | Old (Wrong) | New (Correct) | Reason |
|-------|------------|---------------|--------|
| Account Type (closed) | `"13"` (Lease) | `"15"` (LOC) or `"48"` (Collection) | `13` in Account Type = Lease, not closed |
| Portfolio Type | `"C"` (hardcoded) | `"C"` or `"O"` based on debtor status | `O` = Open for collection/debtor accounts |
| Account Status (closed collection) | `"13"` | `"62"` | `62` = paid in full; was collection |

### Current Correct Mapping

```
Portfolio Type:
  active LOC               → "C" (Line of Credit)
  debtor or collection     → "O" (Open, entire balance due on demand)

Account Type:
  LOC (active or closed)   → "15" (Line of Credit)
  debtor or collection     → "48" (Collection Agency/Attorney)
  [NEVER use "13" — that is Lease]

Account Status:
  derived from PHP[0]:
    0/B → "11"  (current)
    1   → "71"  (30-59d)
    2   → "78"  (60-89d)
    3   → "80"  (90-119d)
    4   → "82"  (120-149d)
    5   → "83"  (150-179d)
    6   → "84"  (180d+)
    G   → "93"  (collection)
    D   → "13"  (closed/no data)
  override:
    isClosed && !wasCollection → "13"
    isClosed && wasCollection  → "62"
```

### Data Priority Rules

- Identity fields (name, DOB, SSN, address): `accounting-client-db.json` > Zoho deal > SMP owners
- Account open date: Zoho `Application_Date`
- Collection placement date: `db/collection-placement-db.json` `sent_to_collection_date`
  - Priority: Dustin `date_placed` > TrustAltus `collection_transferred_date` > Dataset `placement_date`
- Date of First Delinquency: set to 6 months before collection start (or earliest unpaid invoice date)

### Validation Checklist Before Export

- [ ] All required columns present and non-empty
- [ ] Dates are `MMDDYYYY` (8 digits)
- [ ] All coded fields use valid workbook-defined values
- [ ] Payment History Profile is exactly 24 characters
- [ ] PHP contains only valid codes: `0-6`, `B`, `D`, `E`, `G`, `H`, `J`, `K`, `L`
- [ ] `B` codes appear only at the right end (not embedded)
- [ ] No special characters in non-address fields
- [ ] Account Type is never `"13"` (Lease) for our accounts
- [ ] Closed collection accounts use Status `"62"`, not `"13"`
- [ ] Portfolio Type `"O"` for all collection/debtor accounts
