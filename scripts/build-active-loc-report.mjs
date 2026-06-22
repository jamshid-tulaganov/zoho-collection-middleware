/**
 * Filter the Desmond Wilson report down to active LOC carriers only
 * (Account Status = 11). Skips debtors (71/78/80/82/83/84/93) and any rows
 * already excluded for missing DOB. Adds the same red-row highlighting
 * used in the Collection Agency report when the strict ordering
 *   Credit Limit > Highest Credit > Current Balance
 * is broken, and audits CRRG field constraints specific to active LOC:
 *   - DOFD MUST be blank for Status 11
 *   - Amount Past Due MUST be 0 for Status 11
 *
 * Input:  final-array-report/ArrayReport-DesmondWilson.xlsx
 * Output: final-array-report/ArrayReport-Active.xlsx
 */
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const SRC = path.join(projectDir, "final-array-report/ArrayReport-DesmondWilson.xlsx");
const OUT = path.join(projectDir, "final-array-report/ArrayReport-Active.xlsx");

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const ws = wb.worksheets[0];
const headers = ws.getRow(1).values.slice(1);

// Pick out the source rows where Account Status == "11".
const idx = (name) => headers.indexOf(name);
const stI = idx("Account Status");
const activeRows = [];
for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r).values.slice(1);
    if (String(row[stI]) === "11") activeRows.push(row);
}

const outWb = new ExcelJS.Workbook();
const outWs = outWb.addWorksheet("Active LOC");
outWs.addRow(headers);
outWs.getRow(1).font = { bold: true };
outWs.getRow(1).alignment = { horizontal: "center" };

const RED_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
let n = 0;
const flagged = [];
for (const r of activeRows) {
    n++;
    // Re-stamp the Tradeline N so the filtered output starts at 1 and is contiguous.
    const out = [...r];
    out[idx("Field Name")] = `Tradeline ${n}`;
    const excelRow = outWs.addRow(out);
    const cl = Number(r[idx("Credit Limit")]) || 0;
    const hc = Number(r[idx("Highest Credit")]) || 0;
    const cb = Number(r[idx("Current Balance")]) || 0;
    const flag = (cb > hc && hc > 0) || (cl > 0 && (cb > cl || hc > cl));
    if (flag) {
        excelRow.eachCell({ includeEmpty: true }, (cell) => { cell.fill = RED_FILL; });
        flagged.push({ cid: r[idx("Customer Account Number")], cl, hc, cb });
    }
}

const widths = [12, 5, 16, 16, 30, 20, 18, 6, 12, 13, 12, 14, 5, 6, 12, 14, 14, 12, 8, 10, 12, 12, 12, 6, 8, 28];
widths.forEach((w, i) => outWs.getColumn(i + 1).width = w);

await outWb.xlsx.writeFile(OUT);
console.log(`[active-loc] Source rows in Desmond Wilson: ${ws.rowCount - 1}`);
console.log(`[active-loc] Active LOC (Status 11) rows:   ${activeRows.length}`);
console.log(`[active-loc] Rows highlighted red:          ${flagged.length}`);
for (const f of flagged) console.log(`   ${f.cid} | CL=${f.cl} HC=${f.hc} CB=${f.cb}`);
console.log(`[active-loc] Wrote: ${OUT}`);

// ── Field-by-field audit, with Status-11-specific rules ────────────────────
const todayStr = new Date().toISOString().slice(0, 10);
const checks = [
    ["Field Name",                'starts "Tradeline "',          v => /^Tradeline \d+$/.test(String(v||""))],
    ["Association Code",          '== "1"',                       v => String(v) === "1"],
    ["First Name",                "non-empty, ≤20",               v => v && String(v).length <= 20],
    ["Last Name",                 "non-empty, ≤25",               v => v && String(v).length <= 25],
    ["First Line of Address",     "non-empty, ≤32",               v => v && String(v).trim().length > 0 && String(v).length <= 32],
    ["Second Line of Address",    "≤32 (may be blank)",           v => !v || String(v).length <= 32],
    ["City",                      "non-empty, ≤20",               v => v && String(v).length <= 20],
    ["State",                     "2-char USPS",                  v => /^[A-Z]{2}$/.test(String(v||"").trim().toUpperCase())],
    ["Zip Code",                  "XXXXX-XXXX",                   v => /^\d{5}-\d{4}$/.test(String(v||""))],
    ["Telephone Number",          "10 digits",                    v => /^\d{10}$/.test(String(v||""))],
    ["Date of Birth",             "8 digits MMDDYYYY",            v => /^\d{8}$/.test(String(v||"")) && String(v) !== "00000000"],
    ["Customer Account Number",   "numeric, non-empty",           v => /^\d+$/.test(String(v||""))],
    ["Portfolio Type",            'should be "C"',                v => String(v) === "C"],
    ["Account Type",              'should be "18"',               v => String(v) === "18"],
    ["Date Open",                 "8 digits, ≤ today",             (v) => {
        const s = String(v||"");
        if (!/^\d{8}$/.test(s)) return false;
        const iso = `${s.slice(4)}-${s.slice(0,2)}-${s.slice(2,4)}`;
        return iso <= todayStr;
    }],
    ["Date of First Delinquency", "BLANK (Status 11 required)",   v => !v || String(v) === ""],
    ["Date of Last Payment",      "may be blank or 8 digits",     v => !v || /^\d{8}$/.test(String(v||""))],
    ["Date Closed",               "BLANK for Status 11",          v => !v || String(v) === ""],
    ["Account Status",            '== "11"',                      v => String(v) === "11"],
    ["Credit Limit",              "whole $ > 0",                  v => Number(v) > 0 && Number.isInteger(Number(v))],
    ["Highest Credit",            "≤ Credit Limit (may be 0)",    (v, row) => Number(v) <= Number(row[idx("Credit Limit")])],
    ["Current Balance",           "≥ 0",                          v => Number(v) >= 0],
    ["Amount Past Due",           "== 0 (Status 11 required)",    v => Number(v) === 0],
    ["Terms Frequency",           '== "W"',                       v => String(v) === "W"],
    ["Terms",                     '== "001"',                     v => String(v) === "001"],
    ["Payment History Profile",   "24 chars, no G",               v => {
        const s = String(v||""); return s.length === 24 && !s.includes("G");
    }],
];

console.log("");
console.log("=== Field audit (Active LOC, Status 11) ===");
let failed = 0;
for (const [field, rule, test] of checks) {
    let pass = 0, fail = 0, samples = [];
    for (const row of activeRows) {
        const val = row[idx(field)];
        try {
            if (test(val, row)) pass++;
            else {
                fail++;
                if (samples.length < 3) samples.push({ cid: row[idx("Customer Account Number")], val });
            }
        } catch { fail++; }
    }
    const tag = fail === 0 ? "✓" : "✗";
    console.log(`${tag} ${field.padEnd(26)} | ${rule.padEnd(42)} | pass=${pass}/${activeRows.length}` + (fail ? ` FAIL=${fail}` : ""));
    if (fail > 0) {
        failed++;
        for (const s of samples) console.log(`   cid=${s.cid}  value=${JSON.stringify(s.val)}`);
    }
}
console.log("");
console.log(failed === 0 ? "✓ ALL FIELDS PASS" : `✗ ${failed} fields have failures`);
