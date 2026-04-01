#!/usr/bin/env node
/**
 * Import/update collection-placement-db.json from an Excel template.
 *
 * Usage:
 *   node scripts/import-collection-excel.js <file.xlsx>                # dry-run
 *   node scripts/import-collection-excel.js <file.xlsx> --apply        # update db
 *   node scripts/import-collection-excel.js --generate-template       # create blank template
 *
 * The Excel template has two sheets:
 *   1. "Debtors" — company-level debtor info + invoice rows
 *   2. "Collection Cases" — agency placement records
 *
 * On import, data is merged into db/collection-placement-db.json:
 *   - New carriers are added
 *   - Existing carriers are updated (invoices merged, dates updated)
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

// ── Template columns ─────────────────────────────────────────────────────────

const DEBTOR_COLUMNS = [
    { key: "carrier_id", header: "Carrier ID", width: 14, required: true, description: "CMP carrier ID number" },
    { key: "company", header: "Company Name", width: 30, required: true, description: "Legal company name" },
    { key: "debtor_type", header: "Debtor Type", width: 14, description: "BadDebtor or Fraud" },
    { key: "owner_name", header: "Owner Name", width: 25, description: "Owner full name" },
    { key: "dob", header: "DOB", width: 12, description: "Date of birth (MM/DD/YYYY)" },
    { key: "phone", header: "Phone", width: 16, description: "Contact phone" },
    { key: "email", header: "Email", width: 28, description: "Contact email" },
    { key: "address", header: "Address", width: 30, description: "Street address" },
    { key: "city", header: "City", width: 16 },
    { key: "state", header: "State", width: 8 },
    { key: "zip", header: "Zip", width: 10 },
    { key: "date_of_delinquency", header: "Delinquency Date", width: 16, required: true, description: "First delinquency date (MM/DD/YYYY)" },
    { key: "invoice_number", header: "Invoice Number", width: 14 },
    { key: "invoice_date", header: "Invoice Date", width: 14, description: "Invoice date (MM/DD/YYYY)" },
    { key: "invoice_status", header: "Invoice Status", width: 14, description: "Pending, Partially_Paid, Paid" },
    { key: "total_amount", header: "Total Amount", width: 14 },
    { key: "total_paid", header: "Total Paid", width: 14 },
    { key: "remaining_amount", header: "Remaining Amount", width: 16 },
    { key: "collections_agent", header: "Collections Agent", width: 18, description: "Agent handling the case" },
    { key: "overall_status", header: "Overall Status", width: 22, description: "Hard Collection Stage1, Payment Plan, TrustAltus, etc." },
];

const CASES_COLUMNS = [
    { key: "carrier_id", header: "Carrier ID", width: 14, required: true, description: "CMP carrier ID (links to Debtors sheet)" },
    { key: "debtor_name", header: "Debtor Name", width: 25, required: true },
    { key: "date_placed", header: "Date Placed", width: 14, required: true, description: "Date sent to collection agency (MM/DD/YYYY)" },
    { key: "agency", header: "Agency", width: 16, description: "dustin, trustaltus, ic_system" },
    { key: "principal", header: "Principal", width: 14 },
    { key: "amt_collected", header: "Amount Collected", width: 16 },
    { key: "balance", header: "Balance", width: 14 },
    { key: "status", header: "Status", width: 14, description: "Open, Closed, etc." },
    { key: "service_date", header: "Service Date", width: 14 },
    { key: "last_pay_date", header: "Last Payment Date", width: 16 },
    { key: "last_pay_amnt", header: "Last Payment Amount", width: 16 },
];

// ── Generate template ────────────────────────────────────────────────────────

async function generateExcelTemplate() {
    const wb = new ExcelJS.Workbook();
    wb.creator = "collection-middleware";

    // Sheet 1: Debtors
    const debtorSheet = wb.addWorksheet("Debtors", { views: [{ state: "frozen", ySplit: 2 }] });
    debtorSheet.columns = DEBTOR_COLUMNS.map(c => ({ key: c.key, header: c.header, width: c.width }));

    // Header row
    const headerRow = debtorSheet.getRow(1);
    DEBTOR_COLUMNS.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.header;
        cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // Description row
    const descRow = debtorSheet.getRow(2);
    DEBTOR_COLUMNS.forEach((col, i) => {
        const cell = descRow.getCell(i + 1);
        cell.value = col.required ? "Required" : (col.description || "");
        cell.font = { italic: true, size: 8, color: { argb: "FF666666" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF3F8" } };
    });

    // Example row
    const exRow = debtorSheet.getRow(3);
    const exData = {
        carrier_id: "5807320", company: "LONGHORN LLC", debtor_type: "BadDebtor",
        owner_name: "John Smith", dob: "01/15/1985", phone: "(518) 258-3453",
        email: "example@email.com", address: "123 Main St", city: "Olathe", state: "KS", zip: "66061",
        date_of_delinquency: "03/12/2026", invoice_number: "140820", invoice_date: "03/12/2026",
        invoice_status: "Pending", total_amount: 3962.99, total_paid: 0, remaining_amount: 3962.99,
        collections_agent: "Farrux", overall_status: "Hard Collection Stage1",
    };
    DEBTOR_COLUMNS.forEach((col, i) => {
        exRow.getCell(i + 1).value = exData[col.key] ?? "";
    });
    exRow.font = { size: 9, color: { argb: "FF999999" } };

    // Sheet 2: Collection Cases
    const casesSheet = wb.addWorksheet("Collection Cases", { views: [{ state: "frozen", ySplit: 2 }] });
    casesSheet.columns = CASES_COLUMNS.map(c => ({ key: c.key, header: c.header, width: c.width }));

    const cHeaderRow = casesSheet.getRow(1);
    CASES_COLUMNS.forEach((col, i) => {
        const cell = cHeaderRow.getCell(i + 1);
        cell.value = col.header;
        cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF8B0000" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    const cDescRow = casesSheet.getRow(2);
    CASES_COLUMNS.forEach((col, i) => {
        const cell = cDescRow.getCell(i + 1);
        cell.value = col.required ? "Required" : (col.description || "");
        cell.font = { italic: true, size: 8, color: { argb: "FF666666" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE8E8" } };
    });

    // Example row
    const cExRow = casesSheet.getRow(3);
    const cExData = {
        carrier_id: "5807320", debtor_name: "LONGHORN LLC", date_placed: "03/25/2026",
        agency: "trustaltus", principal: 3962.99, amt_collected: 0, balance: 3962.99,
        status: "Open", service_date: "03/12/2026",
    };
    CASES_COLUMNS.forEach((col, i) => {
        cExRow.getCell(i + 1).value = cExData[col.key] ?? "";
    });
    cExRow.font = { size: 9, color: { argb: "FF999999" } };

    const outPath = path.resolve(__dirname, "../spreadsheets/Collection_Import_Template.xlsx");
    await wb.xlsx.writeFile(outPath);
    console.log("Template generated →", outPath);
}

// ── Import logic ─────────────────────────────────────────────────────────────

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

async function importExcel(filePath) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);

    // Load existing DB
    let collDb = {};
    try { collDb = JSON.parse(fs.readFileSync(COLLECTION_DB_PATH, "utf-8")); } catch {}

    // Parse Debtors sheet
    const debtorSheet = wb.getWorksheet("Debtors");
    if (!debtorSheet) throw new Error("Sheet 'Debtors' not found");

    const debtorHeaders = {};
    const hRow = debtorSheet.getRow(1);
    for (let c = 1; c <= debtorSheet.columnCount; c++) {
        const h = String(hRow.getCell(c).value || "").trim();
        const col = DEBTOR_COLUMNS.find(dc => dc.header === h);
        if (col) debtorHeaders[col.key] = c;
    }

    const getVal = (row, key) => {
        const col = debtorHeaders[key];
        return col ? row.getCell(col).value : null;
    };

    let added = 0, updated = 0, skipped = 0;
    const processed = new Set();

    for (let r = 3; r <= debtorSheet.rowCount; r++) {
        const row = debtorSheet.getRow(r);
        const carrierId = String(getVal(row, "carrier_id") || "").trim();
        const company = String(getVal(row, "company") || "").trim();
        if (!carrierId || !company) { skipped++; continue; }

        const key = normalizeKey(company);
        if (!key) { skipped++; continue; }

        const delinqDate = toIso(getVal(row, "date_of_delinquency"));

        // Build invoice entry
        const invoice = {
            invoice_status: String(getVal(row, "invoice_status") || "Pending"),
            debtor_type: String(getVal(row, "debtor_type") || "BadDebtor"),
            collections_agent: String(getVal(row, "collections_agent") || ""),
            billing_cycle: null,
            invoice_number: getVal(row, "invoice_number") ? Number(getVal(row, "invoice_number")) : null,
            invoice_date: toIso(getVal(row, "invoice_date")) || delinqDate,
            total_amount: Number(getVal(row, "total_amount")) || 0,
            total_paid: Number(getVal(row, "total_paid")) || null,
            remaining_amount: Number(getVal(row, "remaining_amount")) || Number(getVal(row, "total_amount")) || 0,
            fee_25pct: null,
            total_remaining: null,
            placement_date: delinqDate,
            owner_name: String(getVal(row, "owner_name") || ""),
            dob: String(getVal(row, "dob") || "").replace(/\//g, "") || null,
            id_number: Number(carrierId) || carrierId,
            commercial_consumer: "Commercial",
            phone: String(getVal(row, "phone") || ""),
            email: String(getVal(row, "email") || ""),
            address: String(getVal(row, "address") || ""),
            state: String(getVal(row, "state") || ""),
            county: null,
            city: String(getVal(row, "city") || ""),
            zip: getVal(row, "zip") ? Number(getVal(row, "zip")) || String(getVal(row, "zip")) : null,
            sales_agent: null,
            language: null,
            usdot: null,
            mn: null,
            collection_dustin: null,
            collection_status_dustin: null,
            amt_collected_agency_dustin: null,
            collection_transferred_date_dustin: null,
            collection_condition_45_days_dustin: null,
            collection_deadline_dustin: null,
            collection_trustaltus: null,
            collection_status_trustaltus: null,
            amt_collected_agency_trustaltus: null,
            collection_transferred_date_trustaltus: null,
            collection_condition_120_days_trustaltus: null,
            collection_deadline_trustaltus: null,
            collection_ic_system: null,
            collection_status_ic_system: null,
            amt_collected_agency_ic_system: null,
            collection_transferred_date_ic_system: null,
            collection_condition_120_days_ic_system: null,
            collection_deadline_ic_system: null,
            jennifer_hoover: null,
            jennifer_chrestman: null,
            via_alla: null,
            transferred_date_alla: null,
            sueing_status_alla: null,
            credit_beraue_reporting: null,
            wage_garnishment: null,
            bank_levy: null,
            property_lien: null,
            overall_status: String(getVal(row, "overall_status") || ""),
        };

        if (!collDb[key]) {
            // New entry
            collDb[key] = {
                company: company,
                debtor_type: String(getVal(row, "debtor_type") || "BadDebtor"),
                date_of_delinquency: delinqDate,
                sent_to_collection_date: delinqDate,
                collection_source: "import",
                invoices: [invoice],
                collection_cases: [],
            };
            added++;
        } else {
            // Update existing — merge invoice if new invoice number
            const existing = collDb[key];
            if (delinqDate && (!existing.date_of_delinquency || delinqDate < existing.date_of_delinquency)) {
                existing.date_of_delinquency = delinqDate;
            }
            const invNum = invoice.invoice_number;
            const existingInv = invNum ? existing.invoices.find(i => i.invoice_number === invNum) : null;
            if (existingInv) {
                // Update existing invoice
                Object.assign(existingInv, invoice);
            } else {
                existing.invoices.push(invoice);
            }
            if (!processed.has(key)) updated++;
        }
        processed.add(key);
    }

    // Parse Collection Cases sheet
    const casesSheet = wb.getWorksheet("Collection Cases");
    let casesAdded = 0;
    if (casesSheet) {
        const cHeaders = {};
        const cHRow = casesSheet.getRow(1);
        for (let c = 1; c <= casesSheet.columnCount; c++) {
            const h = String(cHRow.getCell(c).value || "").trim();
            const col = CASES_COLUMNS.find(cc => cc.header === h);
            if (col) cHeaders[col.key] = c;
        }

        const getCVal = (row, key) => {
            const col = cHeaders[key];
            return col ? row.getCell(col).value : null;
        };

        for (let r = 3; r <= casesSheet.rowCount; r++) {
            const row = casesSheet.getRow(r);
            const carrierId = String(getCVal(row, "carrier_id") || "").trim();
            const datePlaced = toIso(getCVal(row, "date_placed"));
            if (!carrierId || !datePlaced) continue;

            // Find the collection entry by carrier_id in invoices
            let targetKey = null;
            for (const [key, entry] of Object.entries(collDb)) {
                if (entry.invoices?.some(inv => String(inv.id_number) === carrierId)) {
                    targetKey = key;
                    break;
                }
            }
            // Fallback: search by company name
            if (!targetKey) {
                const name = String(getCVal(row, "debtor_name") || "");
                targetKey = normalizeKey(name);
            }

            if (!targetKey || !collDb[targetKey]) continue;

            const agency = String(getCVal(row, "agency") || "").toLowerCase();
            const caseEntry = {
                company: "TSS",
                account_executive: "N/A",
                operating_unit: null,
                debtor_name: String(getCVal(row, "debtor_name") || ""),
                cust_ref: null,
                service_date: toIso(getCVal(row, "service_date")) || "",
                debtor_id: Number(carrierId) || carrierId,
                date_placed: datePlaced,
                principal: Number(getCVal(row, "principal")) || 0,
                interest: 0,
                other: 0,
                client_fee: 0,
                total_dues: Number(getCVal(row, "principal")) || 0,
                amt_collected: Number(getCVal(row, "amt_collected")) || 0,
                balance: Number(getCVal(row, "balance")) || 0,
                age: null,
                last_pay_date: toIso(getCVal(row, "last_pay_date")) || null,
                last_pay_amnt: Number(getCVal(row, "last_pay_amnt")) || null,
                date_closed: null,
                status: String(getCVal(row, "status") || "Open"),
                description: null,
            };

            // Also set agency transfer date on invoices
            if (agency && collDb[targetKey].invoices) {
                const agencyField = {
                    dustin: "collection_transferred_date_dustin",
                    trustaltus: "collection_transferred_date_trustaltus",
                    ic_system: "collection_transferred_date_ic_system",
                }[agency];
                if (agencyField) {
                    for (const inv of collDb[targetKey].invoices) {
                        if (!inv[agencyField]) inv[agencyField] = datePlaced;
                    }
                }
            }

            // Add case if not duplicate
            const cases = collDb[targetKey].collection_cases || [];
            const isDup = cases.some(c => c.date_placed === datePlaced && String(c.debtor_id) === String(carrierId));
            if (!isDup) {
                cases.push(caseEntry);
                collDb[targetKey].collection_cases = cases;
                casesAdded++;
            }
        }
    }

    console.log(`\n[import] Results:`);
    console.log(`  New debtors: ${added}`);
    console.log(`  Updated debtors: ${updated}`);
    console.log(`  Skipped rows: ${skipped}`);
    console.log(`  Collection cases added: ${casesAdded}`);
    console.log(`  Total in DB: ${Object.keys(collDb).length}`);

    if (apply) {
        fs.writeFileSync(COLLECTION_DB_PATH, JSON.stringify(collDb, null, 2), "utf-8");
        console.log(`\n[import] Saved → ${COLLECTION_DB_PATH}`);
    } else {
        console.log(`\n[import] DRY-RUN — run with --apply to save changes.`);
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (generateTemplate) {
    await generateExcelTemplate();
} else if (filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }
    await importExcel(filePath);
} else {
    console.log("Usage:");
    console.log("  node scripts/import-collection-excel.js --generate-template");
    console.log("  node scripts/import-collection-excel.js <file.xlsx>");
    console.log("  node scripts/import-collection-excel.js <file.xlsx> --apply");
}
