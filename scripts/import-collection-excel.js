#!/usr/bin/env node
/**
 * Import/update collection-placement-db.json from an Excel file.
 *
 * Usage:
 *   node scripts/import-collection-excel.js --generate-template       # create blank template
 *   node scripts/import-collection-excel.js <file.xlsx>                # dry-run
 *   node scripts/import-collection-excel.js <file.xlsx> --apply        # update db
 *
 * Template columns:
 *   Carrier ID | Company Name | First Delinquency Date | Collection Sent Date
 *
 * On import, merges into db/collection-placement-db.json:
 *   - New carriers are added
 *   - Existing carriers: dates are updated if provided
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLLECTION_DB_PATH = path.resolve(__dirname, "../db/collection-placement-db.json");

const args = process.argv.slice(2);
const generateTemplate = args.includes("--generate-template");
const apply = args.includes("--apply");
const filePath = args.find(a => !a.startsWith("--"));

const COLUMNS = [
    { key: "carrier_id", header: "Carrier ID", width: 16, required: true },
    { key: "company", header: "Company Name", width: 35, required: true },
    { key: "date_of_delinquency", header: "First Delinquency Date", width: 22, required: true },
    { key: "collection_sent_date", header: "Collection Sent Date", width: 22 },
];

function normalizeKey(v) {
    return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function toIso(v) {
    if (!v) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return "";
}

// ── Generate template ────────────────────────────────────────────────────────

async function generateExcelTemplate() {
    const wb = new ExcelJS.Workbook();
    wb.creator = "collection-middleware";

    const sheet = wb.addWorksheet("Debtors", { views: [{ state: "frozen", ySplit: 2 }] });
    sheet.columns = COLUMNS.map(c => ({ key: c.key, header: c.header, width: c.width }));

    // Header row
    const headerRow = sheet.getRow(1);
    COLUMNS.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.header;
        cell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
    });
    headerRow.height = 22;

    // Description row
    const descRow = sheet.getRow(2);
    const descriptions = ["Required", "Required", "Required (MM/DD/YYYY)", "MM/DD/YYYY (if sent to agency)"];
    descriptions.forEach((desc, i) => {
        const cell = descRow.getCell(i + 1);
        cell.value = desc;
        cell.font = { italic: true, size: 9, color: { argb: "FF666666" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF3F8" } };
    });

    // Example row
    const exRow = sheet.getRow(3);
    const exData = ["5807320", "LONGHORN LLC", "03/12/2026", "03/25/2026"];
    exData.forEach((val, i) => { exRow.getCell(i + 1).value = val; });
    exRow.font = { size: 10, color: { argb: "FF999999" } };

    const outPath = path.resolve(__dirname, "../spreadsheets/Collection_Import_Template.xlsx");
    await wb.xlsx.writeFile(outPath);
    console.log("Template generated →", outPath);
}

// ── Import logic ─────────────────────────────────────────────────────────────

async function importExcel(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    let collDb = {};
    try { collDb = JSON.parse(fs.readFileSync(COLLECTION_DB_PATH, "utf-8")); } catch {}

    const sheet = wb.worksheets[0];
    if (!sheet) throw new Error("No sheet found");

    // Find header columns
    const headers = {};
    const hRow = sheet.getRow(1);
    for (let c = 1; c <= sheet.columnCount; c++) {
        const h = String(hRow.getCell(c).value || "").trim();
        const col = COLUMNS.find(dc => dc.header === h);
        if (col) headers[col.key] = c;
    }

    if (!headers.carrier_id || !headers.company) {
        throw new Error("Missing required columns: Carrier ID, Company Name");
    }

    const getVal = (row, key) => {
        const col = headers[key];
        return col ? row.getCell(col).value : null;
    };

    let added = 0, updated = 0, skipped = 0;

    for (let r = 2; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const carrierId = String(getVal(row, "carrier_id") || "").trim();
        const company = String(getVal(row, "company") || "").trim();
        if (!carrierId || !company) { skipped++; continue; }
        // Skip description/example rows
        if (carrierId.toLowerCase() === "required" || carrierId.toLowerCase().includes("carrier")) { continue; }

        const key = normalizeKey(company);
        if (!key) { skipped++; continue; }

        const delinqDate = toIso(getVal(row, "date_of_delinquency"));
        const sentDate = toIso(getVal(row, "collection_sent_date"));

        if (!collDb[key]) {
            // New entry
            collDb[key] = {
                company,
                debtor_type: "BadDebtor",
                date_of_delinquency: delinqDate,
                sent_to_collection_date: sentDate || delinqDate,
                collection_source: "import",
                invoices: [{
                    invoice_status: "Pending",
                    debtor_type: "BadDebtor",
                    collections_agent: null,
                    billing_cycle: null,
                    invoice_number: null,
                    invoice_date: delinqDate,
                    total_amount: 0,
                    total_paid: null,
                    remaining_amount: 0,
                    fee_25pct: null,
                    total_remaining: null,
                    placement_date: sentDate || delinqDate,
                    owner_name: null,
                    dob: null,
                    id_number: Number(carrierId) || carrierId,
                    commercial_consumer: "Commercial",
                    phone: null, email: null, address: null, state: null,
                    county: null, city: null, zip: null, sales_agent: null,
                    language: null, usdot: null, mn: null,
                    collection_dustin: null, collection_status_dustin: null,
                    amt_collected_agency_dustin: null, collection_transferred_date_dustin: null,
                    collection_condition_45_days_dustin: null, collection_deadline_dustin: null,
                    collection_trustaltus: null, collection_status_trustaltus: null,
                    amt_collected_agency_trustaltus: null, collection_transferred_date_trustaltus: null,
                    collection_condition_120_days_trustaltus: null, collection_deadline_trustaltus: null,
                    collection_ic_system: null, collection_status_ic_system: null,
                    amt_collected_agency_ic_system: null, collection_transferred_date_ic_system: null,
                    collection_condition_120_days_ic_system: null, collection_deadline_ic_system: null,
                    jennifer_hoover: null, jennifer_chrestman: null,
                    via_alla: null, transferred_date_alla: null,
                    sueing_status_alla: null, credit_beraue_reporting: null,
                    wage_garnishment: null, bank_levy: null, property_lien: null,
                    overall_status: null,
                }],
                collection_cases: sentDate ? [{
                    company: "TSS",
                    account_executive: "N/A",
                    operating_unit: null,
                    debtor_name: company,
                    cust_ref: null,
                    service_date: delinqDate,
                    debtor_id: Number(carrierId) || carrierId,
                    date_placed: sentDate,
                    principal: 0, interest: 0, other: 0, client_fee: 0,
                    total_dues: 0, amt_collected: 0, balance: 0, age: null,
                    last_pay_date: null, last_pay_amnt: null,
                    date_closed: null, status: "Open", description: null,
                }] : [],
            };
            added++;
            console.log(`  + ${carrierId} ${company} delinq:${delinqDate} sent:${sentDate || "none"}`);
        } else {
            // Update existing
            const entry = collDb[key];
            let changed = false;

            if (delinqDate && delinqDate !== entry.date_of_delinquency) {
                entry.date_of_delinquency = delinqDate;
                changed = true;
            }
            if (sentDate && sentDate !== entry.sent_to_collection_date) {
                entry.sent_to_collection_date = sentDate;
                // Add collection case if date_placed doesn't exist
                const cases = entry.collection_cases || [];
                if (!cases.some(c => c.date_placed === sentDate)) {
                    cases.push({
                        company: "TSS", account_executive: "N/A", operating_unit: null,
                        debtor_name: company, cust_ref: null, service_date: delinqDate || entry.date_of_delinquency,
                        debtor_id: Number(carrierId) || carrierId, date_placed: sentDate,
                        principal: 0, interest: 0, other: 0, client_fee: 0,
                        total_dues: 0, amt_collected: 0, balance: 0, age: null,
                        last_pay_date: null, last_pay_amnt: null,
                        date_closed: null, status: "Open", description: null,
                    });
                    entry.collection_cases = cases;
                }
                changed = true;
            }

            if (changed) {
                updated++;
                console.log(`  ~ ${carrierId} ${company} delinq:${delinqDate} sent:${sentDate || "none"}`);
            } else {
                skipped++;
            }
        }
    }

    console.log(`\n[import] Results: added=${added} updated=${updated} skipped=${skipped} total=${Object.keys(collDb).length}`);

    if (apply) {
        fs.writeFileSync(COLLECTION_DB_PATH, JSON.stringify(collDb, null, 2), "utf-8");
        console.log(`[import] Saved → ${COLLECTION_DB_PATH}`);
    } else {
        console.log(`[import] DRY-RUN — run with --apply to save.`);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (generateTemplate) {
    await generateExcelTemplate();
} else if (filePath) {
    if (!fs.existsSync(filePath)) { console.error("File not found:", filePath); process.exit(1); }
    await importExcel(filePath);
} else {
    console.log("Usage:");
    console.log("  node scripts/import-collection-excel.js --generate-template");
    console.log("  node scripts/import-collection-excel.js <file.xlsx>");
    console.log("  node scripts/import-collection-excel.js <file.xlsx> --apply");
}
