# Metro 2 Rules — CRRG 2025 Reference

Source: 2025 Credit Reporting Resource Guide (CDIA)

## TSS Account Classification

TSS reports carriers as **Line of Credit (LOC)**:
- Portfolio Type (Field 8) = `C`
- Account Type (Field 9) = `15`
- Terms Duration (Field 13) = constant `LOC`

---

## Payment History Profile (PHP) — Field 18

24 positions, **most recent → least recent** (left to right).
Position 1 = status code from the PREVIOUS month's reporting period.

### Valid codes

| Code | Meaning |
|------|---------|
| `0`  | 0–29 days past due date (current) |
| `1`  | 30–59 days past due date |
| `2`  | 60–89 days past due date |
| `3`  | 90–119 days past due date |
| `4`  | 120–149 days past due date |
| `5`  | 150–179 days past due date |
| `6`  | 180+ days past due date |
| `B`  | No history available — account not yet open OR history cannot be furnished |
| `D`  | No payment history reported/available this month |
| `E`  | Zero balance **and** Account Status 11 (applies to Lines of Credit & Credit Cards) |
| `G`  | Collection |
| `H`  | Foreclosure Completed |
| `J`  | Voluntary Surrender |
| `K`  | Repossession |
| `L`  | Charge-off |

**No other values are acceptable.**

### Key PHP rules (CRRG)

- **`B` may NOT be embedded** within other values. All `B`s must be the rightmost (oldest) positions, representing months before account open. Once an account is open, no `B` can appear to the left of any non-B code.
- **`D` may be embedded** (scattered months with no data available).
- **Do NOT use `D` as a default** or to remove accurately-reported history.
- If fewer than 24 months of history exist, B-fill the ending (oldest) positions.
- The first position should represent the Account Status Code from the **previous** month's report.

### Delinquency clock

> The 30-day delinquency clock starts **30 days after the due date**, not the billing date.

Example (due date = 15th of each month):
| Date of Acct Info | Days Past Due Date | Metro 2 Status |
|---|---|---|
| Jan 1 | 0 | 11 |
| Feb 1 | 17 | 11 |
| Mar 1 | 45 | 71 |
| Apr 1 | 76 | 78 |

---

## Account Status — Field 17A

Valid codes for **Line of Credit (Portfolio Type C)**:

| Code | Meaning | PHP equivalent |
|------|---------|----------------|
| `11` | Current (0–29 days past due) | `0` |
| `13` | Paid or closed / zero balance — **final status** | (payment rating required) |
| `62` | Paid in full, was collection account | — |
| `64` | Paid in full with settlement | — |
| `71` | 30–59 days past due | `1` |
| `78` | 60–89 days past due | `2` |
| `80` | 90–119 days past due | `3` |
| `82` | 120–149 days past due | `4` |
| `83` | 150–179 days past due | `5` |
| `84` | 180+ days past due | `6` |
| `93` | Assigned to internal/external collections | `G` |
| `97` | Unpaid balance reported as loss | — |
| `DA` | Delete account (used to remove invalid tradeline) | — |
| `DF` | Delete account (fraud) | — |

> **Note on `93`:** Code 93 is for accounts assigned to a collection agency. Since TSS is the **original creditor** (not a third-party agency), status `93` should NOT be used. TSS is the data furnisher, not a debt buyer or collection agency.

---

## Payment Rating — Field 17B

Required when Account Status is `13`, `65`, `88`, `89`, `94`, or `95`.
Blank for all other status codes.

| Value | Meaning |
|-------|---------|
| `0`   | Current (0–29 days past due at time of final payment) |
| `1`   | 30–59 days |
| `2`   | 60–89 days |
| `3`   | 90–119 days |
| `4`   | 120–149 days |
| `5`   | 150–179 days |
| `6`   | 180+ days |
| `G`   | Collection |
| `L`   | Charge-off |

---

## Credit Limit / Highest Credit — Fields 11 & 12

For **Line of Credit**:
- **Credit Limit** (Field 11) = assigned credit limit. For closed accounts, continue to report the **last assigned** credit limit (do not zero it out after close).
- **Highest Credit** (Field 12) = highest amount of credit **utilized** by the consumer (not the limit itself).

For active debtors in our system: both are `0` (no LOC extended).

---

## Date of First Delinquency — Field 25 (FCRA Compliance)

The date the first delinquency occurred **with the original creditor** that led to collection placement. This date freezes once set — it drives the 7-year reporting window under FCRA.

For TSS: use `collection_cases.date_of_first_delinquency` if available, otherwise the oldest unpaid invoice due date.

---

## Date Closed — Field 26

Date the account was closed to further use / paid in full. Only populate when Account Status = `13`.

---

## Special Comment — Field 19

For closed LOC accounts: codes `M`, `AP`, `CI`, `CJ`, `CL`.
For active LOC: blank unless legal action (`AM`), refinanced (`AS`), sold (`AH`), special payment arrangements, or transferred.

---

## Industry Standard: Reporting Account Delinquency

All accounts with Status 11, 71, 78, 80, 82–84, 88–89, 93–97 must be reported **at least once per month**.

A **final Account Status Code** must be reported when the account is ultimately paid or closed with a zero balance.

---

## PHP vs Account Status Consistency Rules

| Account Status | Expected PHP pattern |
|---|---|
| `11` (current) | `0` in current position |
| `71`–`84` (delinquent) | `1`–`6` in current position matching days overdue |
| `93` (collection) | `G` in current position (and all subsequent) |
| `13` (closed/paid) | Last active code before closure |
| Closed with D codes | Status `13` |

Once a `G` appears in the PHP, **it stays G** — no subsequent delinquency codes (1–6) or status downgrades are acceptable.
