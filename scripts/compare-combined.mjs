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
const map2 = readSheet("generated-reports/Array_Credit_Report_2026-04-02_v3.xlsx");

console.log("Approved:", map1.size, "| New combined:", map2.size);

const missing = [...map1.keys()].filter(k => !map2.has(k));
const added = [...map2.keys()].filter(k => !map1.has(k));
console.log("Missing from new:", missing.length, "| Added in new:", added.length);

// Count diffs by column
const diffs = {};
let identical = 0, diffCount = 0;
const statusChanges = {};
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    let hasDiff = false;
    for (const col of KEY_COLS) {
        if (d1[col] !== d2[col]) {
            diffs[col] = (diffs[col] || 0) + 1;
            hasDiff = true;
            if (col === "Account Status") {
                const k = d1[col] + " → " + d2[col];
                statusChanges[k] = (statusChanges[k] || 0) + 1;
            }
        }
    }
    if (hasDiff) diffCount++;
    else identical++;
}

console.log(`\nIdentical: ${identical} | With diffs: ${diffCount}`);
console.log("\n=== DIFFS BY COLUMN ===");
for (const col of KEY_COLS) {
    if (diffs[col]) console.log(`  ${col}: ${diffs[col]}`);
}

console.log("\n=== ACCOUNT STATUS TRANSITIONS ===");
for (const [k, v] of Object.entries(statusChanges).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
}

// PHP diffs detail
const phpDiffs = [];
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Payment History Profile"] !== d2["Payment History Profile"]) {
        phpDiffs.push({ cid, a: d1["Payment History Profile"], n: d2["Payment History Profile"], s1: d1["Account Status"], s2: d2["Account Status"] });
    }
}

// Categorize
const cats = { "0→1": [], "G→D": [], "D→0": [], "num→D": [], "B_shift": [], "other": [] };
for (const d of phpDiffs) {
    const a = d.a.padEnd(24), n = d.n.padEnd(24);
    const changes = [];
    for (let i = 0; i < 24; i++) {
        if (a[i] !== n[i]) changes.push({ pos: i, from: a[i], to: n[i] });
    }
    d.changes = changes;
    if (changes.some(c => c.from === "0" && "123456".includes(c.to))) cats["0→1"].push(d);
    else if (changes.some(c => c.from === "G" && c.to === "D")) cats["G→D"].push(d);
    else if (changes.some(c => c.from === "D" && c.to === "0")) cats["D→0"].push(d);
    else if (changes.some(c => "123456".includes(c.from) && c.to === "D")) cats["num→D"].push(d);
    else if (changes.every(c => (c.from === "B" && c.to === "0") || (c.from === "0" && c.to === "B"))) cats["B_shift"].push(d);
    else cats["other"].push(d);
}

console.log(`\n=== PHP DIFFS (${phpDiffs.length} total) ===`);
for (const [cat, items] of Object.entries(cats)) {
    if (!items.length) continue;
    console.log(`\n  --- ${cat}: ${items.length} ---`);
    for (const d of items.slice(0, 8)) {
        console.log(`    ${d.cid} [${d.s1}→${d.s2}]`);
        console.log(`      A: ${d.a}`);
        console.log(`      N: ${d.n}`);
    }
    if (items.length > 8) console.log(`    ... and ${items.length - 8} more`);
}

// Delinquency diffs
console.log("\n=== DATE OF FIRST DELINQUENCY DIFFS ===");
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Date of First Delinquency"] !== d2["Date of First Delinquency"]) {
        console.log(`  ${cid} | status: ${d1["Account Status"]}→${d2["Account Status"]} | delinq: "${d1["Date of First Delinquency"]}" → "${d2["Date of First Delinquency"]}" | closed: "${d1["Date Closed"]}" → "${d2["Date Closed"]}"`);
    }
}

// Date Closed diffs
console.log("\n=== DATE CLOSED DIFFS ===");
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Date Closed"] !== d2["Date Closed"]) {
        console.log(`  ${cid} | status: ${d1["Account Status"]}→${d2["Account Status"]} | closed: "${d1["Date Closed"]}" → "${d2["Date Closed"]}"`);
    }
}

// Missing by status
console.log("\n=== MISSING CARRIERS BY STATUS ===");
const missingByStatus = {};
for (const cid of missing) {
    const s = map1.get(cid)["Account Status"];
    missingByStatus[s] = (missingByStatus[s] || 0) + 1;
}
for (const [s, c] of Object.entries(missingByStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  Status ${s}: ${c}`);
}
