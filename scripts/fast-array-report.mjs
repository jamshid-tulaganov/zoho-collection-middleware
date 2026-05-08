/**
 * FAST Array credit report — fetches live from CMP + Zoho Deals for a list of
 * carrier IDs and writes a SIMPLE Excel (just header row + data rows).
 *
 * Doesn't depend on Zoho Array_Reports module being populated. Computes
 * Metro 2 fields directly in Node.
 *
 * Usage:
 *   node scripts/fast-array-report.mjs \
 *     --input="<path-to-People-Names.xlsx>" \
 *     --output="<path-to-output.xlsx>"
 *
 * The input must have a "Carrier ID" column and a "Carrier ID Added" column
 * (the LOC opening date — overrides any computed Date_Open).
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

const INPUT_PATH  = args.input;
const OUTPUT_PATH = args.output || path.resolve(projectRoot, "FastArrayReport.xlsx");
const PERIOD      = args.period || (() => {
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const d = new Date();
    return `${M[d.getMonth()]} ${d.getFullYear()}`;
})();

if (!INPUT_PATH || !fs.existsSync(INPUT_PATH)) {
    console.error("Usage: --input=<People-Names.xlsx> [--output=<out.xlsx>]");
    process.exit(1);
}

const env = process.env;
if (!env.ZOHO_REFRESH_TOKEN || !env.SMP_USERNAME || !env.SMP_PASSWORD) {
    console.error("Missing ZOHO_REFRESH_TOKEN / SMP_USERNAME / SMP_PASSWORD in .env");
    process.exit(1);
}
const SMP = env.SMP_BASE_URL || "https://tssfuelmanager.com:8443";

// ─── 1. Read input xlsx ─────────────────────────────────────────────────────
console.log(`[fast] Reading ${INPUT_PATH}`);
const inWb = new ExcelJS.Workbook();
await inWb.xlsx.readFile(INPUT_PATH);
const inWs = inWb.worksheets[0];
const headerMap = {};
inWs.getRow(1).eachCell((c, i) => { headerMap[String(c.value || "").trim()] = i; });
const colCarrierId = headerMap["Carrier ID"] || 2;
const colDateAdded = headerMap["Carrier ID Added"] || 6;
const colAppId     = headerMap["Application ID"] || 1;
const colCompany   = headerMap["Legal Business Name"] || 5;

const inputs = [];
inWs.eachRow((row, rowIdx) => {
    if (rowIdx === 1) return;
    const cId = String(row.getCell(colCarrierId).value || "").trim();
    if (!cId) return;
    const raw = row.getCell(colDateAdded).value;
    let iso = "";
    if (raw instanceof Date) iso = raw.toISOString().slice(0, 10);
    else if (typeof raw === "string") {
        const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) iso = `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
        else if (/^\d{4}-\d{2}-\d{2}/.test(raw)) iso = raw.slice(0, 10);
    }
    inputs.push({
        carrierId: cId,
        dateOpenIso: iso,
        appId: String(row.getCell(colAppId).value || "").trim(),
        company: String(row.getCell(colCompany).value || "").trim(),
    });
});
const idSet = new Set(inputs.map(r => r.carrierId));
console.log(`[fast] ${inputs.length} input carriers`);

// ─── 2. Auth: CMP token ─────────────────────────────────────────────────────
console.log("[fast] Authenticating CMP…");
const authR = await fetch(`${SMP}/api/authenticate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: env.SMP_USERNAME, password: env.SMP_PASSWORD }),
});
const authD = await authR.json();
if (!authD.token) { console.error("CMP auth failed:", authD); process.exit(1); }
const cmpToken = authD.token;
const cmpHdr   = { Authorization: `Bearer ${cmpToken}`, "Content-Type": "application/json" };

// ─── 3. Fetch CMP companies (LOC + Debtor tags) ─────────────────────────────
async function fetchCompanies(tagIds) {
    const out = new Map();
    for (let page = 0; page < 5; page++) {
        const r = await fetch(`${SMP}/api/companies?page=${page}&size=1000&sort=createDate,desc&tagIds=${tagIds}`, { headers: cmpHdr });
        const d = await r.json();
        const list = d.content || [];
        for (const comp of list) {
            const cid = String(comp.carrierId || "").trim();
            if (cid) out.set(cid, comp);
        }
        if (list.length < 1000) break;
    }
    return out;
}
console.log("[fast] Fetching CMP LOC carriers…");
const locMap = await fetchCompanies(2);
console.log(`[fast]   LOC: ${locMap.size}`);
console.log("[fast] Fetching CMP debtor-tagged carriers…");
const debtorMap = await fetchCompanies(1);
console.log(`[fast]   Debtor-tagged: ${debtorMap.size}`);

// ─── 4. Fetch CMP invoices (paginated, stop at 24-month cutoff) ─────────────
console.log("[fast] Fetching CMP invoices…");
const invByCarrier = new Map();
const cutoffDate   = new Date(); cutoffDate.setMonth(cutoffDate.getMonth() - 24);
const cutoffIso    = cutoffDate.toISOString().slice(0, 10);
let totalInv = 0;
for (let page = 0; page < 60; page++) {
    const r = await fetch(`${SMP}/api/invoices?page=${page}&size=200&sort=createDate,desc`, { headers: cmpHdr });
    const d = await r.json();
    const list = d.content || [];
    if (!list.length) break;
    let pageOldest = "";
    for (const inv of list) {
        const cid = String(inv.carrierId || "").trim();
        if (cid && idSet.has(cid)) {
            if (!invByCarrier.has(cid)) invByCarrier.set(cid, []);
            invByCarrier.get(cid).push(inv);
        }
        const cd = String(inv.createDate || "").slice(0, 10);
        if (cd && (pageOldest === "" || cd < pageOldest)) pageOldest = cd;
    }
    totalInv += list.length;
    if (pageOldest && pageOldest < cutoffIso) break;
    if (list.length < 200) break;
    if (page % 10 === 0) console.log(`[fast]   ... page ${page}, ${totalInv} invoices, ${invByCarrier.size} carriers matched`);
}
console.log(`[fast]   ${totalInv} invoices total, ${invByCarrier.size} carriers from input have invoice activity`);

// ─── 5. Auth: Zoho token + fetch Card Swiped Deals ─────────────────────────
console.log("[fast] Authenticating Zoho…");
const zohoTokenR = await fetch(`${env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com"}/oauth/v2/token?` + new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN, client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET, grant_type: "refresh_token",
}), { method: "POST" });
const zohoTokenD = await zohoTokenR.json();
if (!zohoTokenD.access_token) { console.error("Zoho auth failed:", zohoTokenD); process.exit(1); }
const zohoToken = zohoTokenD.access_token;

console.log("[fast] Fetching Card Swiped Deals…");
const dealMap = new Map();
const ZOHO_API = env.ZOHO_BASE_URL || "https://www.zohoapis.com";
for (let off = 0; off < 5000; off += 200) {
    const q = { select_query: `SELECT id, Carrier_ID, First_name, Last_Name, Address, City, State, Zip_Code, Phone, Email, Birth_Of_Date, Application_Date, Status, First_Transaction, Last_Transaction FROM Deals WHERE Stage = 'Card Swiped' LIMIT 200 OFFSET ${off}` };
    const r = await fetch(`${ZOHO_API}/crm/v2/coql`, {
        method: "POST",
        headers: { Authorization: `Zoho-oauthtoken ${zohoToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(q),
    });
    const d = await r.json();
    const page = d.data || [];
    if (!page.length) break;
    for (const deal of page) {
        const cid = String(deal.Carrier_ID || "").trim();
        if (cid) dealMap.set(cid, deal);
    }
    if (page.length < 200) break;
}
console.log(`[fast]   Card Swiped deals indexed: ${dealMap.size}`);

// ─── 6. Helpers ─────────────────────────────────────────────────────────────
function isoToMMDDYYYY(iso) {
    if (!iso) return "";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return "";
    return `${m[2]}${m[3]}${m[1]}`;
}
function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }
function monthsBetween(d1, d2) {
    return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
}
function daysBetween(d1, d2) {
    return Math.floor((d2 - d1) / 86400000);
}

// ─── 7. Per-carrier classify + payload ──────────────────────────────────────
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const thirtyDaysAgo = new Date(today); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
const thirtyDaysAgoIso = thirtyDaysAgo.toISOString().slice(0, 10);
const ZEROS = "000000000000000000000000";
const Bs    = "BBBBBBBBBBBBBBBBBBBBBBBB";
const Ds    = "DDDDDDDDDDDDDDDDDDDDDDDD";

function buildRow(inp) {
    const cid = inp.carrierId;
    const comp = locMap.get(cid);
    const deal = dealMap.get(cid);
    const isDebtorTag = debtorMap.has(cid);
    const invoices = invByCarrier.get(cid) || [];

    // Walk invoices
    let hasIssue = isDebtorTag;
    let paidAll = true;
    let oldestUnpaidIso = "";
    let latestActiv = "";
    let lastInvDate = "", lastInvBalance = 0;
    let highestCredMo = 0;
    let dateLastPay = "";
    const curMonthKey = todayIso.slice(0, 7);
    for (const inv of invoices) {
        const st = String(inv.status || "");
        const ta = Number(inv.totalAmount) || 0;
        const tp = Number(inv.totalPaid) || 0;
        const rem = ta - tp;
        const cd = String(inv.createDate || "").slice(0, 10);
        const dt = String(inv.dateTo || "").slice(0, 10);
        if (cd && cd.slice(0, 7) === curMonthKey && ta > highestCredMo) highestCredMo = ta;
        if (cd && (lastInvDate === "" || cd > lastInvDate)) {
            lastInvDate = cd; lastInvBalance = rem;
        }
        if (tp > 0 && cd && (dateLastPay === "" || cd > dateLastPay)) dateLastPay = cd;
        if (st !== "PAID" && st !== "CANCELLED") {
            paidAll = false;
            if (st === "PAYMENT_ISSUES") hasIssue = true;
            if (dt && (oldestUnpaidIso === "" || dt < oldestUnpaidIso)) oldestUnpaidIso = dt;
        }
        if (cd && (latestActiv === "" || cd > latestActiv)) latestActiv = cd;
    }

    // Determine date_open (priority: input file → Zoho Application_Date → first transaction)
    const dealAppDate = deal ? String(deal.Application_Date || "").slice(0, 10) : "";
    const dealFirstTx = deal ? String(deal.First_Transaction || "").slice(0, 10) : "";
    const dateOpen = inp.dateOpenIso || dealAppDate || dealFirstTx || latestActiv || "";

    // Determine date_closed
    const dealStatus = deal ? String(deal.Status || "") : "";
    let dateClosed = "";
    let isClosed = false;
    if (!hasIssue && paidAll && (dealStatus === "Inactive" || (latestActiv && latestActiv < thirtyDaysAgoIso))) {
        isClosed = true;
        const dealLastTx = deal ? String(deal.Last_Transaction || "").slice(0, 10) : "";
        dateClosed = dealLastTx || latestActiv || "";
    }

    // Classify
    const dealDob = deal ? String(deal.Birth_Of_Date || "").slice(0, 10) : "";
    let carrierType = "", excludedReason = "", acctStatus = "", payRating = "";
    if (!deal) { carrierType = "Excluded"; excludedReason = "no Card Swiped Deal"; }
    else if (!dealDob || dealDob.length < 10) { carrierType = "Excluded"; excludedReason = "missing Birth_Of_Date"; }
    else if (hasIssue) { carrierType = "Debtor"; acctStatus = "93"; payRating = "G"; }
    else if (isClosed) { carrierType = "Closed"; acctStatus = "13"; payRating = "0"; }
    else { carrierType = "LOC"; acctStatus = "11"; payRating = ""; }

    // PHP
    let php = "";
    if (carrierType === "Excluded" || !dateOpen) {
        php = Bs;
    } else {
        const openD = new Date(dateOpen);
        let activeMo = monthsBetween(openD, today) + 1;
        if (activeMo < 0) activeMo = 0;
        if (activeMo > 24) activeMo = 24;

        if (carrierType === "LOC") {
            php = ZEROS.slice(0, activeMo) + Bs.slice(activeMo);
        } else if (carrierType === "Closed") {
            let dMonths = 0;
            if (dateClosed) {
                dMonths = monthsBetween(new Date(dateClosed), today);
                if (dMonths < 0) dMonths = 0;
                if (dMonths > activeMo) dMonths = activeMo;
            }
            php = Ds.slice(0, dMonths) + ZEROS.slice(0, activeMo - dMonths) + Bs.slice(activeMo);
        } else if (carrierType === "Debtor") {
            php = "G";
            const oldestD = oldestUnpaidIso ? new Date(oldestUnpaidIso) : null;
            for (let i = 1; i < 24; i++) {
                let ch = "0";
                const monthDate = new Date(today); monthDate.setMonth(monthDate.getMonth() - i);
                if (i >= activeMo) ch = "B";
                else if (oldestD) {
                    const days = monthDate >= oldestD ? daysBetween(oldestD, monthDate) : 0;
                    if (days >= 180) ch = "6";
                    else if (days >= 150) ch = "5";
                    else if (days >= 120) ch = "4";
                    else if (days >= 90) ch = "3";
                    else if (days >= 60) ch = "2";
                    else if (days >= 30) ch = "1";
                    else ch = "0";
                }
                php += ch;
            }
        }
    }

    // Money
    const cmpCreditLimit = comp ? (Number(comp.creditLimit) || 0) : 0;
    const currentBalance = (carrierType === "Debtor") ? lastInvBalance : (carrierType === "Closed" ? 0 : lastInvBalance);

    return {
        carrierId: cid,
        companyName: (comp && comp.name) || inp.company || "",
        firstName: deal ? truncate(deal.First_name, 20) : "",
        lastName:  deal ? truncate(deal.Last_Name, 25) : "",
        address:   deal ? truncate(deal.Address, 32) : "",
        city:      deal ? truncate(deal.City, 20) : "",
        state:     deal ? truncate(deal.State, 2) : "",
        zip:       deal ? truncate(deal.Zip_Code, 9) : "",
        phone:     deal ? truncate(deal.Phone, 10) : "",
        dob:       dealDob,
        portfolioType: "C",
        accountType: "15",
        dateOpen, dateFirstDelinq: oldestUnpaidIso, dateLastPay, dateClosed,
        accountStatus: acctStatus, payRating,
        creditLimit: cmpCreditLimit, highestCred: highestCredMo, currentBalance,
        amountPastDue: carrierType === "Debtor" ? currentBalance : 0,
        php, carrierType, excludedReason,
        appId: inp.appId,
    };
}

console.log("[fast] Building rows…");
const rows = inputs.map(buildRow);

// ─── 8. Write SIMPLE Excel (header + data rows, no template) ────────────────
const outWb = new ExcelJS.Workbook();
const outWs = outWb.addWorksheet("Array Report");

const COLS = [
    { key: "carrierId",     header: "Carrier ID" },
    { key: "appId",         header: "Application ID" },
    { key: "companyName",   header: "Company Name" },
    { key: "carrierType",   header: "Carrier Type" },
    { key: "excludedReason",header: "Excluded Reason" },
    { key: "firstName",     header: "First Name" },
    { key: "lastName",      header: "Last Name" },
    { key: "address",       header: "Address" },
    { key: "city",          header: "City" },
    { key: "state",         header: "State" },
    { key: "zip",           header: "Zip Code" },
    { key: "phone",         header: "Phone" },
    { key: "dob",           header: "Date of Birth" },
    { key: "portfolioType", header: "Portfolio Type" },
    { key: "accountType",   header: "Account Type" },
    { key: "dateOpen",      header: "Date Open" },
    { key: "dateFirstDelinq", header: "First Delinquency" },
    { key: "dateLastPay",   header: "Last Payment" },
    { key: "dateClosed",    header: "Date Closed" },
    { key: "accountStatus", header: "Account Status" },
    { key: "payRating",     header: "Pay Rating" },
    { key: "creditLimit",   header: "Credit Limit" },
    { key: "highestCred",   header: "Highest Credit" },
    { key: "currentBalance",header: "Current Balance" },
    { key: "amountPastDue", header: "Amount Past Due" },
    { key: "php",           header: "Payment History Profile" },
];
outWs.columns = COLS.map(c => ({ header: c.header, key: c.key, width: c.key === "php" ? 28 : 14 }));
outWs.getRow(1).font = { bold: true };
outWs.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };

for (const r of rows) {
    outWs.addRow({
        ...r,
        dob: isoToMMDDYYYY(r.dob),
        dateOpen: isoToMMDDYYYY(r.dateOpen),
        dateFirstDelinq: isoToMMDDYYYY(r.dateFirstDelinq),
        dateLastPay: isoToMMDDYYYY(r.dateLastPay),
        dateClosed: isoToMMDDYYYY(r.dateClosed),
    });
}
outWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };

await outWb.xlsx.writeFile(OUTPUT_PATH);

// ─── 9. Summary + Qualifying Carriers list ─────────────────────────────────
const counts = { LOC: 0, Debtor: 0, Closed: 0, Excluded: 0 };
const excludedReasons = {};
const noDealCarriers = [];
const noDobCarriers  = [];
const noCmpCarriers  = [];

// Qualifying set: in CMP LOC tag (tagIds=2) AND has a Card Swiped Zoho Deal.
// (Independent of DOB — DOB is a data-quality issue, not an eligibility issue.)
const qualifying       = [];
const failsLOC         = [];   // carrier_id NOT in CMP LOC list
const failsCardSwiped  = [];   // in LOC but no Card Swiped Deal

for (const r of rows) {
    counts[r.carrierType] = (counts[r.carrierType] || 0) + 1;
    if (r.carrierType === "Excluded") {
        excludedReasons[r.excludedReason] = (excludedReasons[r.excludedReason] || 0) + 1;
        if (r.excludedReason === "no Card Swiped Deal") noDealCarriers.push(r.carrierId);
        if (r.excludedReason === "missing Birth_Of_Date") noDobCarriers.push(r.carrierId);
    }
    if (!locMap.has(r.carrierId)) noCmpCarriers.push(r.carrierId);

    // Qualification logic
    const inLOC = locMap.has(r.carrierId);
    const hasCS = dealMap.has(r.carrierId);
    if (inLOC && hasCS) qualifying.push(r);
    else if (!inLOC) failsLOC.push(r.carrierId);
    else if (!hasCS) failsCardSwiped.push(r.carrierId);
}

console.log("");
console.log("=== Summary ===");
console.log(`Input carriers:  ${inputs.length}`);
console.log(`LOC:             ${counts.LOC}`);
console.log(`Debtor:          ${counts.Debtor}`);
console.log(`Closed:          ${counts.Closed}`);
console.log(`Excluded:        ${counts.Excluded}`);

console.log("");
console.log("=== Eligibility check (in CMP LOC tag + has Card Swiped Deal) ===");
console.log(`Qualifying:      ${qualifying.length} / ${inputs.length}`);
console.log(`  ↳ in LOC + Card Swiped Deal exists`);
console.log(`Fails LOC tag:   ${failsLOC.length}      (carrier not tagged LOC in CMP)`);
console.log(`Fails Card Swp:  ${failsCardSwiped.length}     (no Card Swiped Deal in Zoho)`);

console.log("");
console.log("=== Excluded breakdown (data-quality reasons within qualifying set) ===");
for (const [reason, n] of Object.entries(excludedReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(30)} ${n}`);
}
if (noDobCarriers.length) {
    console.log(`First 15 carriers with Card Swiped Deal but missing Birth_Of_Date:`);
    console.log(`  ${noDobCarriers.slice(0, 15).join(", ")}${noDobCarriers.length > 15 ? `, ... +${noDobCarriers.length - 15} more` : ""}`);
}

// Write a SECOND simple Excel: just the qualifying carrier IDs
const QUAL_PATH = OUTPUT_PATH.replace(/\.xlsx$/i, "-qualifying.xlsx");
const qWb = new ExcelJS.Workbook();
const qWs = qWb.addWorksheet("Qualifying Carriers");
qWs.columns = [
    { header: "Carrier ID",     key: "carrierId",     width: 14 },
    { header: "Application ID", key: "appId",         width: 16 },
    { header: "Company Name",   key: "companyName",   width: 30 },
    { header: "Carrier Type",   key: "carrierType",   width: 12 },
    { header: "Has DOB",        key: "hasDob",        width: 10 },
];
qWs.getRow(1).font = { bold: true };
qWs.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE7E6E6" } };
for (const r of qualifying) {
    qWs.addRow({
        carrierId: r.carrierId,
        appId: r.appId,
        companyName: r.companyName,
        carrierType: r.carrierType,
        hasDob: r.dob ? "yes" : "no",
    });
}
qWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
await qWb.xlsx.writeFile(QUAL_PATH);

console.log("");
console.log(`Main Excel:        ${OUTPUT_PATH}`);
console.log(`Qualifying list:   ${QUAL_PATH}   (${qualifying.length} carriers)`);
console.log("");
console.log(`Quick copy-paste — qualifying Carrier IDs (${qualifying.length}):`);
console.log(qualifying.map(r => r.carrierId).join(", "));
