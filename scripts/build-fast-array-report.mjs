/**
 * Build a focused Array credit report Excel for a specific list of carriers.
 *
 * Inputs:
 *   - An xlsx file with columns: Application ID, Carrier ID, MC #, DOT #,
 *     Legal Business Name, Carrier ID Added (the LOC open date), Type of Business
 *   - The official Array template (uploaded earlier) used as the output structure
 *   - Zoho Array_Reports records (already populated by the Deluge sync)
 *
 * For each input carrier:
 *   - Look up matching Zoho Array_Reports record by Carrier_ID + Report_Period
 *   - Override Date_Open with the input file's "Carrier ID Added" value
 *   - Format all dates as MMDDYYYY (Array submission format)
 *   - Write to the "File Reporting Template" sheet of the output xlsx
 *
 * Usage (from collections/ project root):
 *   node scripts/build-fast-array-report.mjs \
 *     --input="/Users/jamshid/.../People-Names-Oct2025.xlsx" \
 *     --template="/Users/jamshid/.../Array_Credit_Reporting_Workbook_General_4_21_2026_CorrectedFile.xlsx" \
 *     --period="May 2026" \
 *     --output="/Users/jamshid/Public/Octane/.../FastArrayReport-May2026.xlsx"
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(projectRoot, ".env") });

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    })
);

function currentPeriod() {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = new Date();
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

const PERIOD     = args.period   || currentPeriod();
const INPUT_PATH = args.input    || path.resolve(projectRoot, "../../../Library/Application Support/Claude/local-agent-mode-sessions/f1f35ca5-7d94-4c1c-bbc6-d69d5bec0a2f/32ebe03e-f012-45e6-9a44-4fe2da56baa7/local_daf3d1e7-b986-45d5-a7f1-6f8366dea333/uploads/People-Names-Oct2025.xlsx");
const TEMPLATE_PATH = args.template || path.resolve(projectRoot, "spreadsheets/Array_Credit_Reporting_Workbook_General.xlsx");
const OUTPUT_PATH   = args.output   || path.resolve(projectRoot, `FastArrayReport-${PERIOD.replace(" ","-")}.xlsx`);

const ZOHO_BASE_URL    = process.env.ZOHO_BASE_URL    || "https://www.zohoapis.com";
const ZOHO_ACCOUNTS_URL= process.env.ZOHO_ACCOUNTS_URL|| "https://accounts.zoho.com";
const ZOHO_CLIENT_ID   = process.env.ZOHO_CLIENT_ID   || "";
const ZOHO_CLIENT_SECRET=process.env.ZOHO_CLIENT_SECRET||"";
const ZOHO_REFRESH_TOKEN=process.env.ZOHO_REFRESH_TOKEN||"";

if (!ZOHO_CLIENT_ID || !ZOHO_REFRESH_TOKEN) {
    console.error("[fast-report] Missing Zoho credentials in collections/.env");
    process.exit(1);
}
if (!fs.existsSync(INPUT_PATH)) {
    console.error(`[fast-report] Input file not found: ${INPUT_PATH}`);
    process.exit(1);
}
if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`[fast-report] Template file not found: ${TEMPLATE_PATH}`);
    console.error(`Tip: copy the Array template into collections/spreadsheets/, OR pass --template=<full-path>`);
    process.exit(1);
}

console.log(`[fast-report] Period:    ${PERIOD}`);
console.log(`[fast-report] Input:     ${INPUT_PATH}`);
console.log(`[fast-report] Template:  ${TEMPLATE_PATH}`);
console.log(`[fast-report] Output:    ${OUTPUT_PATH}`);

// ──────────────────────────────────────────────────────────────────────────
// STEP 1: Read input xlsx → list of {carrierId, dateOpenIso}
// ──────────────────────────────────────────────────────────────────────────
async function readInput() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(INPUT_PATH);
    const ws = wb.worksheets[0];
    const rows = [];
    let headerMap = {};
    ws.eachRow((row, rowIdx) => {
        if (rowIdx === 1) {
            row.eachCell((cell, colIdx) => {
                headerMap[String(cell.value || "").trim()] = colIdx;
            });
        } else {
            const cId = String(row.getCell(headerMap["Carrier ID"] || 2).value || "").trim();
            const cAddedRaw = row.getCell(headerMap["Carrier ID Added"] || 6).value;
            if (!cId) return;
            // Parse date — could be Date object or string MM/DD/YYYY
            let iso = "";
            if (cAddedRaw instanceof Date) {
                iso = cAddedRaw.toISOString().slice(0, 10);
            } else if (typeof cAddedRaw === "string" && cAddedRaw.length >= 8) {
                const m = cAddedRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
                if (m) iso = `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
                else iso = cAddedRaw.slice(0, 10);
            }
            rows.push({
                carrierId: cId,
                dateOpenIso: iso,
                appId: String(row.getCell(headerMap["Application ID"] || 1).value || "").trim(),
                companyName: String(row.getCell(headerMap["Legal Business Name"] || 5).value || "").trim(),
            });
        }
    });
    return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// STEP 2: Pull matching Array_Reports records from Zoho via COQL
// ──────────────────────────────────────────────────────────────────────────
async function getAccessToken() {
    const params = new URLSearchParams({
        refresh_token: ZOHO_REFRESH_TOKEN,
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
    });
    const r = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: "POST" });
    const d = await r.json();
    if (!d.access_token) throw new Error("Token refresh failed: " + JSON.stringify(d));
    return d.access_token;
}

async function fetchArrayReportsForPeriod(token, period, carrierIdsSet) {
    // Pull ALL records for the period (chunked) then filter to the input set in-memory.
    // Cleaner than building a giant IN (...) clause and risking COQL length limits.
    const FIELDS = [
        "id", "Carrier_ID", "Customer_Account_Number", "Company_Name", "Carrier_Type",
        "Excluded_Reason",
        "Association_Code", "First_Name", "Middle_Name", "Last_Name", "Generation_Code",
        "First_Line_of_Address", "Second_Line_of_Address", "City", "State", "Zip_Code",
        "Social_Security_Number", "Telephone_Number", "Date_of_Birth",
        "Consumer_Information_Indicator",
        "Joint_Association_Code", "Joint_First_Name", "Joint_Middle_Name", "Joint_Last_Name",
        "Joint_Address_1", "Joint_Address_2", "Joint_City", "Joint_State", "Joint_Zip_Code",
        "Joint_SSN", "Joint_Phone_Number", "Joint_Date_of_Birth",
        "Joint_Consumer_Information_Indicator",
        "Portfolio_Type", "Account_Type", "Date_Open", "Date_of_First_Delinquency",
        "Date_of_Last_Payment", "Date_Closed", "Account_Status", "Payment_Rating",
        "Special_Comment_Code", "Compliance_Condition_Code",
        "Credit_Limit", "Highest_Credit", "Current_Balance", "Monthly_Payment",
        "Actual_Payment", "Terms_Frequency", "Terms",
        "Original_Charge_Off_Amount", "Payment_History_Profile",
        "Validation_Errors",
    ].join(", ");

    const all = [];
    for (let off = 0; off < 5000; off += 200) {
        const q = { select_query: `SELECT ${FIELDS} FROM Array_Reports WHERE Report_Period = '${period}' LIMIT 200 OFFSET ${off}` };
        const r = await fetch(`${ZOHO_BASE_URL}/crm/v2/coql`, {
            method: "POST",
            headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(q),
        });
        const data = await r.json();
        const page = data.data || [];
        if (!page.length) break;
        all.push(...page);
        if (page.length < 200) break;
    }

    // Index by Carrier_ID (string-normalized)
    const map = new Map();
    for (const rec of all) {
        const cid = String(rec.Carrier_ID || "").trim();
        if (cid && carrierIdsSet.has(cid)) {
            map.set(cid, rec);
        }
    }
    return map;
}

// ──────────────────────────────────────────────────────────────────────────
// STEP 3: Format helpers
// ──────────────────────────────────────────────────────────────────────────
function isoToMMDDYYYY(iso) {
    if (!iso) return "";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    return `${m[2]}${m[3]}${m[1]}`;
}

function moneyOrZero(v) {
    if (v === null || v === undefined || v === "") return 0;
    const n = Number(v);
    return isNaN(n) ? 0 : n;
}

// ──────────────────────────────────────────────────────────────────────────
// STEP 4: Build output xlsx using template as base
// ──────────────────────────────────────────────────────────────────────────
//
// Column index map for the "File Reporting Template" sheet (1-indexed):
// matches the official template's 49-column layout.
const COL = {
    Association_Code: 2, First_Name: 3, Middle_Name: 4, Last_Name: 5, Generation_Code: 6,
    First_Line_of_Address: 7, Second_Line_of_Address: 8, City: 9, State: 10, Zip_Code: 11,
    Social_Security_Number: 12, Telephone_Number: 13, Date_of_Birth: 14,
    Consumer_Information_Indicator: 15,
    Joint_Association_Code: 16, Joint_First_Name: 17, Joint_Middle_Name: 18, Joint_Last_Name: 19,
    Joint_Address_1: 20, Joint_Address_2: 21, Joint_City: 22, Joint_State: 23, Joint_Zip_Code: 24,
    Joint_SSN: 25, Joint_Phone_Number: 26, Joint_Date_of_Birth: 27,
    Joint_Consumer_Information_Indicator: 28,
    Customer_Account_Number: 29, Portfolio_Type: 30, Account_Type: 31,
    Date_Open: 32, Date_of_First_Delinquency: 33, Date_of_Last_Payment: 34, Date_Closed: 35,
    Account_Status: 36, Payment_Rating: 37, Special_Comment_Code: 38, Compliance_Condition_Code: 39,
    Credit_Limit: 40, Highest_Credit: 41, Current_Balance: 42, Amount_Past_Due: 43,
    Monthly_Payment: 44, Actual_Payment: 45,
    Terms_Frequency: 46, Terms: 47, Original_Charge_Off_Amount: 48, Payment_History_Profile: 49,
};

function writeRow(ws, rowIdx, rec, dateOpenIsoOverride) {
    if (!rec) return false;
    const dateOpenIso = dateOpenIsoOverride || rec.Date_Open || "";
    const set = (col, val) => { if (val !== undefined && val !== null && val !== "") ws.getCell(rowIdx, col).value = val; };

    set(COL.Association_Code, rec.Association_Code || "1");
    set(COL.First_Name, rec.First_Name);
    set(COL.Middle_Name, rec.Middle_Name);
    set(COL.Last_Name, rec.Last_Name);
    set(COL.Generation_Code, rec.Generation_Code);
    set(COL.First_Line_of_Address, rec.First_Line_of_Address);
    set(COL.Second_Line_of_Address, rec.Second_Line_of_Address);
    set(COL.City, rec.City);
    set(COL.State, rec.State);
    set(COL.Zip_Code, rec.Zip_Code);
    set(COL.Social_Security_Number, rec.Social_Security_Number);
    set(COL.Telephone_Number, rec.Telephone_Number);
    set(COL.Date_of_Birth, isoToMMDDYYYY(rec.Date_of_Birth));
    set(COL.Consumer_Information_Indicator, rec.Consumer_Information_Indicator);

    set(COL.Customer_Account_Number, rec.Customer_Account_Number || rec.Carrier_ID);
    set(COL.Portfolio_Type, rec.Portfolio_Type || "C");
    set(COL.Account_Type, rec.Account_Type || "15");
    set(COL.Date_Open, isoToMMDDYYYY(dateOpenIso));
    set(COL.Date_of_First_Delinquency, isoToMMDDYYYY(rec.Date_of_First_Delinquency));
    set(COL.Date_of_Last_Payment, isoToMMDDYYYY(rec.Date_of_Last_Payment));
    set(COL.Date_Closed, isoToMMDDYYYY(rec.Date_Closed));
    set(COL.Account_Status, rec.Account_Status);
    set(COL.Payment_Rating, rec.Payment_Rating);
    set(COL.Special_Comment_Code, rec.Special_Comment_Code);
    set(COL.Compliance_Condition_Code, rec.Compliance_Condition_Code);
    set(COL.Credit_Limit, moneyOrZero(rec.Credit_Limit));
    set(COL.Highest_Credit, moneyOrZero(rec.Highest_Credit));
    set(COL.Current_Balance, moneyOrZero(rec.Current_Balance));
    set(COL.Amount_Past_Due, moneyOrZero(rec.Amount_Past_Due));
    set(COL.Monthly_Payment, moneyOrZero(rec.Monthly_Payment));
    set(COL.Actual_Payment, moneyOrZero(rec.Actual_Payment));
    set(COL.Terms_Frequency, rec.Terms_Frequency);
    set(COL.Terms, rec.Terms);
    set(COL.Original_Charge_Off_Amount, moneyOrZero(rec.Original_Charge_Off_Amount));
    set(COL.Payment_History_Profile, rec.Payment_History_Profile);
    return true;
}

// ──────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────
const inputRows = await readInput();
console.log(`[fast-report] Input rows:    ${inputRows.length}`);

const carrierIds = new Set(inputRows.map(r => r.carrierId));
console.log(`[fast-report] Unique IDs:    ${carrierIds.size}`);

const token = await getAccessToken();
console.log(`[fast-report] Got Zoho token`);

const recordMap = await fetchArrayReportsForPeriod(token, PERIOD, carrierIds);
console.log(`[fast-report] Found in Zoho: ${recordMap.size} / ${carrierIds.size}`);

const missing = [];
for (const c of carrierIds) {
    if (!recordMap.has(c)) missing.push(c);
}
if (missing.length) {
    console.log(`[fast-report] Missing from Zoho (first 10): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? `, ... +${missing.length - 10} more` : ""}`);
}

// Load template
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(TEMPLATE_PATH);
const ws = wb.getWorksheet("File Reporting Template");
if (!ws) {
    console.error("[fast-report] Could not find 'File Reporting Template' sheet in template");
    process.exit(1);
}

// Clear existing data rows (keep rows 1-6 = headers + example tradeline reference + max-length)
// The template has data starting at row 7. We'll clear rows 7+ and rewrite.
const lastRow = ws.actualRowCount;
for (let r = 7; r <= lastRow; r++) {
    ws.getRow(r).eachCell((cell) => { cell.value = null; });
}

// Write our rows
let written = 0;
let skipped = 0;
let excludedCount = 0;
let outRow = 7;
for (const inp of inputRows) {
    const rec = recordMap.get(inp.carrierId);
    if (!rec) { skipped++; continue; }
    if (rec.Carrier_Type === "Excluded") { excludedCount++; continue; }
    ws.getCell(outRow, 1).value = `Tradeline ${written + 1}`;   // Field Name col
    writeRow(ws, outRow, rec, inp.dateOpenIso);
    written++;
    outRow++;
}

await wb.xlsx.writeFile(OUTPUT_PATH);

console.log("");
console.log("=== Summary ===");
console.log(`Input carriers:      ${inputRows.length}`);
console.log(`Found in Zoho:       ${recordMap.size}`);
console.log(`Excluded (skipped):  ${excludedCount}`);
console.log(`Missing from Zoho:   ${skipped}`);
console.log(`Written to Excel:    ${written}`);
console.log(`Output:              ${OUTPUT_PATH}`);
