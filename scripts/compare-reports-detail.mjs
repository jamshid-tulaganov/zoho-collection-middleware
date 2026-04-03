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
        data["Portfolio Type"] = String(row["Portfolio Type"] ?? "").trim();
        data["Account Type"] = String(row["Account Type"] ?? "").trim();
        data["Date Open"] = String(row["Date Open"] ?? "").trim();
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

// ===== FOCUS ANALYSIS: Account Status, PHP, Delinquency, Date Closed =====

// 1. ALL Account Status transitions
const statusDiffs = [];
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Account Status"] !== d2["Account Status"]) {
        statusDiffs.push({ cid, approved: d1["Account Status"], newVal: d2["Account Status"], php1: d1["Payment History Profile"], php2: d2["Payment History Profile"] });
    }
}
console.log("\n========================================");
console.log("=== ALL ACCOUNT STATUS DIFFS (" + statusDiffs.length + ") ===");
console.log("========================================");
const statusGroups = {};
for (const d of statusDiffs) {
    const key = d.approved + " → " + d.newVal;
    if (!statusGroups[key]) statusGroups[key] = [];
    statusGroups[key].push(d);
}
for (const [transition, items] of Object.entries(statusGroups).sort((a,b) => b[1].length - a[1].length)) {
    console.log(`\n  ${transition} (${items.length} carriers):`);
    for (const d of items.slice(0, 10)) {
        console.log(`    ${d.cid} | PHP approved: ${d.php1.slice(0, 12)}... | PHP new: ${d.php2.slice(0, 12)}...`);
    }
    if (items.length > 10) console.log(`    ... and ${items.length - 10} more`);
}

// 2. ALL PHP diffs
const phpDiffs = [];
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Payment History Profile"] !== d2["Payment History Profile"]) {
        phpDiffs.push({ cid, a: d1["Payment History Profile"], n: d2["Payment History Profile"], s1: d1["Account Status"], s2: d2["Account Status"] });
    }
}
console.log("\n========================================");
console.log("=== ALL PHP DIFFS (" + phpDiffs.length + ") ===");
console.log("========================================");
// Categorize PHP changes
const phpCategories = { "0_to_delinq": [], "delinq_change": [], "G_code_change": [], "D_code_change": [], "other": [] };
for (const d of phpDiffs) {
    const a0 = d.a[0], n0 = d.n[0];
    const aHasG = d.a.includes("G"), nHasG = d.n.includes("G");
    const aHasD = d.a.includes("D"), nHasD = d.n.includes("D");
    if (a0 === "0" && "123456".includes(n0)) phpCategories["0_to_delinq"].push(d);
    else if (aHasG !== nHasG || (aHasG && d.a !== d.n)) phpCategories["G_code_change"].push(d);
    else if (aHasD !== nHasD || (aHasD && d.a !== d.n)) phpCategories["D_code_change"].push(d);
    else if ("123456".includes(a0) || "123456".includes(n0)) phpCategories["delinq_change"].push(d);
    else phpCategories["other"].push(d);
}
for (const [cat, items] of Object.entries(phpCategories)) {
    if (!items.length) continue;
    console.log(`\n  --- ${cat} (${items.length}) ---`);
    for (const d of items.slice(0, 20)) {
        console.log(`    ${d.cid} [${d.s1}→${d.s2}]`);
        console.log(`      A: ${d.a}`);
        console.log(`      N: ${d.n}`);
    }
    if (items.length > 20) console.log(`    ... and ${items.length - 20} more`);
}

// 3. ALL Delinquency date diffs
const delinqDiffs = [];
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Date of First Delinquency"] !== d2["Date of First Delinquency"]) {
        delinqDiffs.push({ cid, a: d1["Date of First Delinquency"], n: d2["Date of First Delinquency"], s1: d1["Account Status"], s2: d2["Account Status"], dc1: d1["Date Closed"], dc2: d2["Date Closed"] });
    }
}
console.log("\n========================================");
console.log("=== ALL DELINQUENCY DATE DIFFS (" + delinqDiffs.length + ") ===");
console.log("========================================");
for (const d of delinqDiffs) {
    console.log(`  ${d.cid} | status: ${d.s1}→${d.s2} | delinq: "${d.a}" → "${d.n}" | closed: "${d.dc1}" → "${d.dc2}"`);
}

// 4. ALL Date Closed diffs
const closedDiffs = [];
for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    if (d1["Date Closed"] !== d2["Date Closed"]) {
        closedDiffs.push({ cid, a: d1["Date Closed"], n: d2["Date Closed"], s1: d1["Account Status"], s2: d2["Account Status"], php1: d1["Payment History Profile"], php2: d2["Payment History Profile"] });
    }
}
console.log("\n========================================");
console.log("=== ALL DATE CLOSED DIFFS (" + closedDiffs.length + ") ===");
console.log("========================================");
for (const d of closedDiffs) {
    console.log(`  ${d.cid} | status: ${d.s1}→${d.s2} | closed: "${d.a}" → "${d.n}"`);
    console.log(`    PHP A: ${d.php1}`);
    console.log(`    PHP N: ${d.php2}`);
}

// 5. Missing carriers: sample with full data
console.log("\n========================================");
console.log("=== MISSING CARRIERS SAMPLE (first 30) ===");
console.log("========================================");
const missingByStatus = {};
for (const cid of missing) {
    const d = map1.get(cid);
    const s = d["Account Status"];
    if (!missingByStatus[s]) missingByStatus[s] = [];
    missingByStatus[s].push({ cid, ...d });
}
for (const [status, items] of Object.entries(missingByStatus).sort((a,b) => b[1].length - a[1].length)) {
    console.log(`\n  Status ${status} (${items.length} carriers):`);
    for (const d of items.slice(0, 5)) {
        console.log(`    ${d.cid} | PHP: ${d["Payment History Profile"].slice(0,12)}... | Delinq: ${d["Date of First Delinquency"]} | Closed: ${d["Date Closed"]} | DOpen: ${d["Date Open"]}`);
    }
}
