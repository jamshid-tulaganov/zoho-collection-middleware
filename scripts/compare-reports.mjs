import pkg from "xlsx";
const { readFile, utils } = pkg;
const KEY_COLS = ["Account Status","Payment History Profile","Date of First Delinquency","Date Closed","Date of Last Payment","Credit Limit","Current Balance"];
function readSheet(path) {
    const wb = readFile(path);
    const rows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", range: 1 });
    const map = new Map();
    for (const row of rows) {
        const cid = String(row["Customer Account Number"] || "").trim();
        if (!cid) continue;
        const data = {};
        for (const col of KEY_COLS) data[col] = String(row[col] ?? "").trim();
        map.set(cid, data);
    }
    return map;
}
const map1 = readSheet("generated-reports/Array_Credit_Report_2026-04-01 8.xlsx");
const map2 = readSheet("generated-reports/Array_Credit_Report_2026-04-02_v2.xlsx");
console.log("Approved:", map1.size, "| New:", map2.size);
const missing = [...map1.keys()].filter(k => !map2.has(k));
const added = [...map2.keys()].filter(k => !map1.has(k));
console.log("Missing from new:", missing.length, "| Added in new:", added.length);
const diffs = { total: 0 };
const statusChanges = {};
const phpDiffs = [], delinqDiffs = [], closedDiffs = [], lastPayDiffs = [];
let identical = 0;
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    let hasDiff = false;
    for (const col of KEY_COLS) {
        if (d1[col] !== d2[col]) {
            diffs[col] = (diffs[col] || 0) + 1; hasDiff = true;
            if (col === "Account Status") { const k = d1[col]+" -> "+d2[col]; statusChanges[k]=(statusChanges[k]||0)+1; }
            if (col === "Payment History Profile" && phpDiffs.length < 15) phpDiffs.push({cid, a:d1[col], n:d2[col]});
            if (col === "Date of First Delinquency" && delinqDiffs.length < 15) delinqDiffs.push({cid, a:d1[col], n:d2[col]});
            if (col === "Date Closed" && closedDiffs.length < 15) closedDiffs.push({cid, a:d1[col], n:d2[col]});
            if (col === "Date of Last Payment" && lastPayDiffs.length < 5) lastPayDiffs.push({cid, a:d1[col], n:d2[col]});
        }
    }
    if (!hasDiff) identical++; else diffs.total++;
}
console.log("\nIdentical:", identical, "| With diffs:", diffs.total);
console.log("\n=== DIFFS BY COLUMN ===");
for (const col of KEY_COLS) { if (diffs[col]) console.log(" ", col+":", diffs[col]); }
console.log("\n=== ACCOUNT STATUS TRANSITIONS ===");
for (const [k,v] of Object.entries(statusChanges).sort((a,b)=>b[1]-a[1])) console.log(" ", k+":", v);
console.log("\n=== PHP DIFFS (first 15) ===");
for (const d of phpDiffs) { console.log(d.cid); console.log("  approved:", d.a); console.log("  new:     ", d.n); }
console.log("\n=== DELINQUENCY DIFFS (first 15) ===");
for (const d of delinqDiffs) console.log(" ", d.cid, "| approved:", d.a, "| new:", d.n);
console.log("\n=== DATE CLOSED DIFFS (first 15) ===");
for (const d of closedDiffs) console.log(" ", d.cid, "| approved:", d.a, "| new:", d.n);
console.log("\n=== DATE LAST PAYMENT DIFFS (first 5) ===");
for (const d of lastPayDiffs) console.log(" ", d.cid, "| approved:", d.a, "| new:", d.n);
const missingByStatus = {};
for (const cid of missing) { const s = map1.get(cid)["Account Status"]; missingByStatus[s]=(missingByStatus[s]||0)+1; }
console.log("\n=== MISSING CARRIERS (by approved status) ===");
for (const [s,c] of Object.entries(missingByStatus).sort((a,b)=>b[1]-a[1])) console.log("  Status "+s+":", c);
