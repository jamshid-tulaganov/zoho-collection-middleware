import pkg from "xlsx";
const { readFile, utils } = pkg;

function readSheet(path) {
    const wb = readFile(path);
    const rows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", range: 1 });
    const map = new Map();
    for (const row of rows) {
        const cid = String(row["Customer Account Number"] || "").trim();
        if (!cid) continue;
        map.set(cid, {
            php: String(row["Payment History Profile"] ?? "").trim(),
            status: String(row["Account Status"] ?? "").trim(),
            delinq: String(row["Date of First Delinquency"] ?? "").trim(),
            closed: String(row["Date Closed"] ?? "").trim(),
            lastPay: String(row["Date of Last Payment"] ?? "").trim(),
            creditLimit: String(row["Credit Limit"] ?? "").trim(),
            balance: String(row["Current Balance"] ?? "").trim(),
            dateOpen: String(row["Date Open"] ?? "").trim(),
        });
    }
    return map;
}

const map1 = readSheet("generated-reports/Array_Credit_Report_2026-04-01 8.xlsx");
const map2 = readSheet("generated-reports/Array_Credit_Report_2026-04-02_v2.xlsx");

// Month labels (position 0 = most recent month, position 23 = 24 months ago)
// Report date: April 2026, so position 0 = March 2026 (last complete month)
const months = [];
const baseDate = new Date(2026, 2, 1); // March 2026 = most recent
for (let i = 0; i < 24; i++) {
    const d = new Date(baseDate);
    d.setMonth(d.getMonth() - i);
    months.push(`${d.toLocaleString('default', { month: 'short' })} ${d.getFullYear()}`);
}

console.log("=== PHP CHARACTER-BY-CHARACTER ANALYSIS ===\n");
console.log("Position mapping (0=most recent → 23=oldest):");
console.log(months.map((m, i) => `  ${i}: ${m}`).join("\n"));

// 1. For ALL carriers in BOTH reports, analyze position-by-position differences
const charDiffs = Array(24).fill(null).map(() => ({}));
let totalCompared = 0;
const phpDiffCarriers = [];

for (const [cid, d1] of map1) {
    const d2 = map2.get(cid);
    if (!d2) continue;
    totalCompared++;

    const php1 = d1.php.padEnd(24, " ");
    const php2 = d2.php.padEnd(24, " ");

    if (php1 !== php2) {
        const diffs = [];
        for (let i = 0; i < 24; i++) {
            const c1 = php1[i] || " ";
            const c2 = php2[i] || " ";
            if (c1 !== c2) {
                const key = `${c1}→${c2}`;
                charDiffs[i][key] = (charDiffs[i][key] || 0) + 1;
                diffs.push({ pos: i, month: months[i], from: c1, to: c2 });
            }
        }
        phpDiffCarriers.push({ cid, php1: php1.trim(), php2: php2.trim(), status1: d1.status, status2: d2.status, diffs });
    }
}

console.log(`\nTotal carriers compared: ${totalCompared}`);
console.log(`Carriers with PHP diffs: ${phpDiffCarriers.length}`);

// 2. Position-by-position summary
console.log("\n========================================");
console.log("=== POSITION-BY-POSITION DIFF SUMMARY ===");
console.log("========================================");
for (let i = 0; i < 24; i++) {
    const transitions = charDiffs[i];
    const total = Object.values(transitions).reduce((s, n) => s + n, 0);
    if (total === 0) continue;
    console.log(`\n  Position ${i} (${months[i]}): ${total} diffs`);
    for (const [trans, count] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${trans}: ${count}`);
    }
}

// 3. Categorize the diffs by pattern type
console.log("\n========================================");
console.log("=== PHP DIFF PATTERNS ===");
console.log("========================================");

// Category: 0→1 at position 0 (new delinquency)
const newDelinq = phpDiffCarriers.filter(d => d.diffs.some(x => x.from === "0" && "123456".includes(x.to)));
console.log(`\n--- NEW DELINQUENCY (0→1-6): ${newDelinq.length} carriers ---`);
for (const d of newDelinq.slice(0, 5)) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    for (const diff of d.diffs) {
        console.log(`    pos ${diff.pos} (${diff.month}): ${diff.from}→${diff.to}`);
    }
}

// Category: G→D or delinq→D (closed replacing collection/delinquent)
const gToD = phpDiffCarriers.filter(d => d.diffs.some(x => x.from === "G" && x.to === "D"));
console.log(`\n--- G→D TRANSITIONS: ${gToD.length} carriers ---`);
for (const d of gToD) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    for (const diff of d.diffs) {
        console.log(`    pos ${diff.pos} (${diff.month}): ${diff.from}→${diff.to}`);
    }
}

// Category: delinq num→D
const numToD = phpDiffCarriers.filter(d => d.diffs.some(x => "123456".includes(x.from) && x.to === "D"));
console.log(`\n--- NUM→D TRANSITIONS: ${numToD.length} carriers ---`);
for (const d of numToD.slice(0, 5)) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    for (const diff of d.diffs) {
        console.log(`    pos ${diff.pos} (${diff.month}): ${diff.from}→${diff.to}`);
    }
}

// Category: 0→G or num→G (new G codes)
const toG = phpDiffCarriers.filter(d => d.diffs.some(x => x.to === "G" && x.from !== "G"));
console.log(`\n--- *→G TRANSITIONS: ${toG.length} carriers ---`);
for (const d of toG.slice(0, 5)) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    for (const diff of d.diffs) {
        console.log(`    pos ${diff.pos} (${diff.month}): ${diff.from}→${diff.to}`);
    }
}

// Category: D→0 (was closed, now current)
const dToOpen = phpDiffCarriers.filter(d => d.diffs.some(x => x.from === "D" && x.to === "0"));
console.log(`\n--- D→0 TRANSITIONS (closed→current): ${dToOpen.length} carriers ---`);
for (const d of dToOpen) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    for (const diff of d.diffs) {
        console.log(`    pos ${diff.pos} (${diff.month}): ${diff.from}→${diff.to}`);
    }
}

// Category: B count changes (different Date Open)
const bChanges = phpDiffCarriers.filter(d => d.diffs.some(x => (x.from === "B" && x.to !== "B") || (x.to === "B" && x.from !== "B")));
console.log(`\n--- B-CODE CHANGES (Date Open shift): ${bChanges.length} carriers ---`);
for (const d of bChanges.slice(0, 10)) {
    console.log(`  ${d.cid} [${d.status1}→${d.status2}]`);
    console.log(`    A: ${d.php1}`);
    console.log(`    N: ${d.php2}`);
    const bCountA = (d.php1.match(/B/g) || []).length;
    const bCountN = (d.php2.match(/B/g) || []).length;
    console.log(`    B-count: ${bCountA} → ${bCountN} (Date Open shifted)`);
}

// 4. Check all carriers in new report: distribution of PHP codes at each position
console.log("\n========================================");
console.log("=== NEW REPORT PHP CODE DISTRIBUTION ===");
console.log("========================================");
const codeCounts = Array(24).fill(null).map(() => ({}));
let newTotal = 0;
for (const [cid, d2] of map2) {
    newTotal++;
    const php = d2.php.padEnd(24, " ");
    for (let i = 0; i < 24; i++) {
        const c = php[i];
        codeCounts[i][c] = (codeCounts[i][c] || 0) + 1;
    }
}
console.log(`Total carriers: ${newTotal}`);
for (let i = 0; i < 24; i++) {
    const codes = Object.entries(codeCounts[i]).sort((a,b) => b[1] - a[1]);
    console.log(`  Pos ${i.toString().padStart(2)} (${months[i].padEnd(8)}): ${codes.map(([c,n]) => `${c}:${n}`).join("  ")}`);
}

// 5. Check for any carrier with delinquency code (1-6) or G in new report
const delinqInNew = [];
for (const [cid, d2] of map2) {
    if (/[1-6G]/.test(d2.php)) {
        delinqInNew.push({ cid, php: d2.php, status: d2.status, delinq: d2.delinq, closed: d2.closed });
    }
}
console.log(`\n=== CARRIERS WITH DELINQUENCY/G IN NEW REPORT: ${delinqInNew.length} ===`);
const byStatus = {};
for (const d of delinqInNew) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
}
console.log("By status:", JSON.stringify(byStatus));
for (const d of delinqInNew.slice(0, 10)) {
    console.log(`  ${d.cid} | status: ${d.status} | delinq: ${d.delinq} | closed: ${d.closed} | PHP: ${d.php}`);
}
