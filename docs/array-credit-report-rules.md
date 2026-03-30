# Array Credit Report Rules

Source workbook: `spreadsheets/Array_Credit_Reporting_Workbook_General.xlsx`

These rules define how we should build the Array credit report file and how to validate fields before export.

## 1) General Rules

- Keep the template structure intact; do not delete columns/fields.
- If a field is unused, leave it blank (do not add placeholders/symbols).
- Use only allowed characters:
  - Most fields: alphanumeric (`0-9`, `A-Z`)
  - Address fields may include limited punctuation (slash, dash, period)
- Dates must be formatted as `MMDDYYYY`.
- Do not put multiple people in `First Name` or `Last Name`.

## 2) File Layout Rules

- Reporting sheet is based on `File Reporting Template`.
- Primary account profile fields must be generated in the same order as template columns.
- Required fields must always be present and non-empty.

## 3) Required Core Fields (Primary Profile)

At minimum, enforce:

- `Association Code` (required)
- `First Name` (required)
- `Last Name` (required)
- `First Line of Address` (required)
- `City` (required)
- `State` (required, 2 letters)
- `Zip Code` (required, numeric)
- `Social Security Number` (required by template; numeric, no hyphens)
- `Customer Account Number` (required)
- `Portfolio Type` (required)
- `Account Type` (required)
- `Date Open` (required, `MMDDYYYY`)
- `Date of Last Payment` (required, `MMDDYYYY`)
- `Account Status` (required)
- `Current Balance` (required)
- `Terms Frequency` (required)
- `Terms` (required)
- `Payment History Profile` (required)

## 4) Code Set Rules (Use Workbook Tabs)

- `Generation Code`: use values from `Generation Codes` tab.
- `Association Code`: use `ECOA (Association) Codes` tab.
- `Account Type`: use `Account Type Codes` tab.
- `Account Status`: use `Account Status Codes` tab.
- `Portfolio Type`: use `Portfolio Types` tab.
- `Special Comment Code`: use `Special Comment Codes` tab.
- `Consumer Information Indicator`: use `Consumer Information Indicators` tab.
- `Compliance Condition Code`: use `Compliance Condition Code` tab.
- `Terms Frequency`: use `Terms Frequency` tab.
- `Payment Rating`: use `Payment Rating` tab.

## 5) Payment History Profile Rules

- Report months from **most recent to least recent** (left to right).
- Position `1` should correspond to prior period account status context.
- Allowed symbols include `0-6` and special codes such as `B`, `D`, `G`, `L` (per workbook table).
- Meanings:
  - `0` = current (0-29 days)
  - `1-6` = progressive delinquency buckets
  - `B` = no history before account open / cannot furnish prior history
  - `D` = no payment history available for this month
  - `G` = collection
  - `L` = charge-off
- Never use `D` as a blind default to wipe valid historical data.

## 6) Field Formatting Rules

- `State`: uppercase 2-letter code.
- `Zip Code`: numeric; if 5-digit zip is used, left justify/zero-fill as required by bureau format.
- `Phone`: numeric only (10 digits preferred for US phone normalization).
- `SSN`: numeric only, no hyphens.
- Numeric money fields: no symbols/commas in final export values.

## 7) Data Priority Rules (Current Project)

For this repository’s generation logic:

- Primary profile identity/location/open date fields should prefer `db/accounting-client-db.json`.
- Fallback order after accounting is Zoho deal data, then CMP/SMP data.
- Collection month should come from `db/collection-placement-db.json` placement date.

## 8) Validation Checklist Before Export

- Confirm all required columns are present.
- Confirm date fields are `MMDDYYYY`.
- Confirm all coded fields use valid tab-defined values.
- Confirm `Payment History Profile` length and symbol validity.
- Confirm no special characters in restricted fields.
- Confirm no unintended blank required fields.

