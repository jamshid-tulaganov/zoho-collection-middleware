#!/usr/bin/env node
/**
 * import-tss-collection-sheet.js
 *
 * Reads TSS collection spreadsheet rows and merges debtor markers into
 * db/debtor-master-db.json (same shape as existing master entries).
 *
 * Default sheet: "Dec Collection Cases (Dustin)"
 * Default file: data/TSS_Bad_Debtors_New_25.02.2026.xlsx
 *
 * Column mapping (row 3 = headers, data from row 4):
 *   A Company, D Debtor Name, E Cust Ref, F Service Date, G Debtor ID (carrier), H Date Placed, ...
 *
 * Usage:
 *   node scripts/import-tss-collection-sheet.js --dry-run
 *   node scripts/import-tss-collection-sheet.js --apply
 *   node scripts/import-tss-collection-sheet.js --check-cmp
 *   node scripts/import-tss-collection-sheet.js --apply --excel path/to/file.xlsx --sheet "Dec Collection Cases (Dustin)"
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { env } from "../src/config/env.js";
import { fetchCompanies } from "../src/services/smp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_EXCEL = path.resolve(__dirname, "../data/TSS_Bad_Debtors_New_25.02.2026.xlsx");
const DEFAULT_SHEET = "Dec Collection Cases (Dustin)";

/** Stable tag so we can grep / avoid duplicate imports */
const DEBTOR_SOURCE_TAG = "tss_dec_collection_dustin_20260225";

function parseArgs(argv) {
    const out = {
        dryRun: false,
        apply: false,
        checkCmp: false,
        excelPath: DEFAULT_EXCEL,
        sheetName: DEFAULT_SHEET,
        masterPath: env.MASTER_DB_PATH,
        reportPath: path.resolve(__dirname, "../data/tss-collection-import-report.json"),
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") out.dryRun = true;
        if (a === "--apply") out.apply = true;
        if (a === "--check-cmp") out.checkCmp = true;
        if (a === "--excel") out.excelPath = path.resolve(argv[++i] || "");
        if (a === "--sheet") out.sheetName = argv[++i] || DEFAULT_SHEET;
        if (a === "--master") out.masterPath = path.resolve(argv[++i] || "");
        if (a === "--report") out.reportPath = path.resolve(argv[++i] || "");
    }
    if (!out.apply && !out.dryRun && !out.checkCmp) {
        out.dryRun = true;
    }
    return out;
}

function cellStr(row, col) {
    const v = row.getCell(col).value;
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && v.text) return String(v.text).trim();
    return String(v).trim();
}

function cellNum(row, col) {
    const v = row.getCell(col).value;
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isNaN(n) ? null : n;
}

/** Column H — Date Placed (sent to collections) → YYYY-MM-DD for Metro2 G-profile start */
function cellDateIso(row, col) {
    const v = row.getCell(col).value;
    if (v === null || v === undefined) return "";
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        return v.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return "";
}

function normCid(raw) {
    const s = String(raw ?? "").trim();
    if (!s || s === "0" || s.toLowerCase() === "null") return null;
    return s;
}

function defaultMasterEntry(cid, companyName) {
    return {
        carrier_id: cid,
        company: companyName || "",
        billing_cycle: "",
        credit_score: 0,
        debtor_sources: [],
        debtor_periods: [],
        ggr_submission_date: null,
        ggr_data: null,
        earliest_delinquency_period_end: null,
        invoices: [],
        payment_months: {},
        total_debt: 0,
        total_collected: 0,
        collection_placement_date: null,
    };
}

function mergeDebtorSource(entry) {
    const sources = Array.isArray(entry.debtor_sources) ? [...entry.debtor_sources] : [];
    if (!sources.includes(DEBTOR_SOURCE_TAG)) {
        sources.push(DEBTOR_SOURCE_TAG);
    }
    entry.debtor_sources = sources;
    return entry;
}

async function readSheetRows(excelPath, sheetName) {
    if (!fs.existsSync(excelPath)) {
        throw new Error(`Excel not found: ${excelPath}`);
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(excelPath);
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
        const names = wb.worksheets.map((w) => w.name).join(", ");
        throw new Error(`Sheet "${sheetName}" not found. Available: ${names}`);
    }

    const rows = [];
    for (let r = 4; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const carrierId = normCid(cellStr(row, 7));
        if (!carrierId) continue;

        const companyName = cellStr(row, 4);
        const custRef = cellStr(row, 5);
        const principal = cellNum(row, 9);
        const totalDues = cellNum(row, 13);
        const amtCollected = cellNum(row, 14);
        const datePlaced = cellDateIso(row, 8);

        rows.push({
            rowIndex: r,
            carrier_id: carrierId,
            company: companyName,
            cust_ref: custRef,
            date_placed: datePlaced,
            principal,
            total_dues: totalDues,
            amt_collected: amtCollected,
        });
    }
    return rows;
}

async function runCheckCmp(sheetCarrierIds) {
    console.log("[import-tss] Fetching CMP companies with debtor tag (tagIds=1)...");
    const debtorMap = await fetchCompanies(1);
    const cmpDebtorIds = new Set([...debtorMap.keys()].map(String));

    const inCmp = [];
    const notInCmpDebtorList = [];
    for (const id of sheetCarrierIds) {
        if (cmpDebtorIds.has(String(id))) {
            const comp = debtorMap.get(String(id));
            inCmp.push({
                carrier_id: id,
                cmp_name: comp?.name || "",
                tag_ids: (comp?.tags || []).map((t) => t.id),
            });
        } else {
            notInCmpDebtorList.push(id);
        }
    }

    console.log(`[import-tss] Sheet unique carrier IDs: ${sheetCarrierIds.size}`);
    console.log(`[import-tss] Found in CMP as debtor (tag 1): ${inCmp.length}`);
    console.log(`[import-tss] NOT in CMP debtor list: ${notInCmpDebtorList.length}`);
    if (notInCmpDebtorList.length && notInCmpDebtorList.length <= 40) {
        console.log("[import-tss] Missing from debtor-tagged list:", notInCmpDebtorList.join(", "));
    } else if (notInCmpDebtorList.length) {
        console.log("[import-tss] First 25 missing:", notInCmpDebtorList.slice(0, 25).join(", "));
    }

    return { inCmp, notInCmpDebtorList, cmpDebtorCount: debtorMap.size };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    console.log(`[import-tss] Excel: ${opts.excelPath}`);
    console.log(`[import-tss] Sheet: ${opts.sheetName}`);
    console.log(`[import-tss] Master DB: ${opts.masterPath}`);

    const sheetRows = await readSheetRows(opts.excelPath, opts.sheetName);
    const byId = new Map();
    for (const row of sheetRows) {
        if (!byId.has(row.carrier_id)) {
            byId.set(row.carrier_id, row);
        }
    }
    const uniqueIds = [...byId.keys()];
    console.log(`[import-tss] Data rows (with ID): ${sheetRows.length}, unique carrier IDs: ${uniqueIds.length}`);

    const sheetCarrierIds = new Set(uniqueIds);

    let cmpCheck = null;
    if (opts.checkCmp) {
        cmpCheck = await runCheckCmp(sheetCarrierIds);
    }

    if (!opts.apply) {
        console.log("[import-tss] Dry run — no changes written. Use --apply to update debtor-master-db.json");
    }

    if (!fs.existsSync(opts.masterPath)) {
        throw new Error(`Master DB not found: ${opts.masterPath}`);
    }

    const raw = fs.readFileSync(opts.masterPath, "utf-8");
    const master = JSON.parse(raw);

    const report = {
        generatedAt: new Date().toISOString(),
        excelPath: opts.excelPath,
        sheetName: opts.sheetName,
        debtorSourceTag: DEBTOR_SOURCE_TAG,
        sheetRowCount: sheetRows.length,
        uniqueCarrierIds: uniqueIds.length,
        updated: [],
        created: [],
        skipped: [],
        cmp: cmpCheck,
    };

    for (const cid of uniqueIds) {
        const row = byId.get(cid);
        const placementIso = row.date_placed || "";
        const existing = master[cid];
        if (existing) {
            const beforeSources = JSON.stringify(existing.debtor_sources || []);
            const beforePlacement = String(existing.collection_placement_date || "");
            const merged = mergeDebtorSource({ ...existing });
            if (placementIso) {
                merged.collection_placement_date = placementIso;
            }
            const sourcesChanged = JSON.stringify(merged.debtor_sources) !== beforeSources;
            const placementChanged = String(merged.collection_placement_date || "") !== beforePlacement;
            if (!sourcesChanged && !placementChanged) {
                report.skipped.push({ carrier_id: cid, reason: "unchanged" });
                continue;
            }
            if (opts.apply) {
                master[cid] = merged;
            }
            report.updated.push({
                carrier_id: cid,
                company_before: existing.company || "",
                company_sheet: row.company,
                collection_placement_date: placementIso || beforePlacement,
            });
        } else {
            const entry = defaultMasterEntry(cid, row.company);
            mergeDebtorSource(entry);
            if (placementIso) {
                entry.collection_placement_date = placementIso;
            }
            if (opts.apply) {
                master[cid] = entry;
            }
            report.created.push({
                carrier_id: cid,
                company: row.company,
                collection_placement_date: placementIso || null,
            });
        }
    }

    fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`[import-tss] Report written: ${opts.reportPath}`);

    if (opts.apply) {
        fs.writeFileSync(opts.masterPath, JSON.stringify(master, null, 4), "utf-8");
        console.log(`[import-tss] Master DB updated: ${opts.masterPath}`);
        console.log(`[import-tss] Created: ${report.created.length}, updated: ${report.updated.length}, skipped: ${report.skipped.length}`);
    } else {
        console.log(`[import-tss] Would create: ${report.created.length}, would update: ${report.updated.length}, skipped: ${report.skipped.length}`);
    }
}

main().catch((err) => {
    console.error("[import-tss] Fatal:", err.message);
    process.exit(1);
});
