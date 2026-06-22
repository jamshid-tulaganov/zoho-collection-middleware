/**
 * Build an Array credit report for the bad-debtor companies in
 *   /Users/jamshid/Desktop/Book3.xlsx
 *
 * Book3 is an authoritative debt ledger — each row is one unpaid invoice
 * for a carrier with the invoice's due date in the last column. Multiple
 * rows per carrier are summed.
 *
 * Field rules mirror the Desmond Wilson report (Portfolio Type 0, Account
 * Type 18, ZIP format XXXXX-XXXX, Highest Credit walk-down strictly < Credit
 * Limit, Current Balance capped at Highest Credit). The PHP rules differ:
 *
 *   - If the carrier is in Book1 (collection db), the PHP "G" code starts at
 *     the Book1 placement date — the same as the Desmond Wilson report. The
 *     row's Account Status becomes 93.
 *   - Otherwise, PHP shows the natural delinquency progression based on the
 *     Book3 invoice due date. Each month-end gets a code from days past due:
 *       30–59 → 1, 60–89 → 2, …, 180–209 → 6, 210+ → G.
 *     A G anywhere in PHP still flips the row to Account Status 93.
 *
 * Output:
 *   final-array-report/ArrayReport-BadDebtors.xlsx
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    isoToMetro,
    buildPhpDebtor,
    statusFromDaysPastDue,
} from "./lib/php-builder.mjs";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(projectDir, "final-array-report");

const BOOK3_PATH = "/Users/jamshid/Desktop/Book3.xlsx";
const BOOK1_PATH = "/Users/jamshid/Desktop/Book1   12.05.2026 (2).xlsx";
const OUT_XLSX   = path.join(REPORT_DIR, "ArrayReport-BadDebtors.xlsx");

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

// ── Helpers ─────────────────────────────────────────────────────────────────
// Splits a raw single-line address into line1 + line2 by scanning for unit
// indicators (apt/suite/ste/unit/bldg/rm/#, or "fl/floor" adjacent to a digit)
// anywhere in the string. line1 ends just before the indicator; line2 is the
// indicator and everything after.
function splitAddress(raw) {
    if (!raw) return { line1: "", line2: "" };
    const s = String(raw).trim();
    const patterns = [
        /\b(?:apt|suite|ste|unit|bldg|rm)\b\.?/i,
        /#\s*\w/,
        /\b\d+(?:st|nd|rd|th)?[-\s]*(?:fl|floor)\b/i,
        /\b(?:fl|floor)\s*\d/i,
    ];
    let idx = -1;
    for (const p of patterns) {
        const m = s.match(p);
        if (m && (idx === -1 || m.index < idx)) idx = m.index;
    }
    if (idx === -1) return { line1: s, line2: "" };
    const line1 = s.slice(0, idx).trim().replace(/[,;\s]+$/, "");
    const line2 = s.slice(idx).trim().replace(/^[,;:\s]+/, "")
                  .replace(/^apt\.?:?\s*/i, "apt ")
                  .replace(/^ste\.?:?\s*/i, "ste ")
                  .replace(/\s+/g, " ").trim();
    if (!line1) return { line1: s, line2: "" };
    return { line1, line2 };
}
function normPhone(v) {
    const d = String(v || "").replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) return d.slice(1);
    return d.length === 10 ? d : d.slice(-10);
}
function parseDobToMetro(v) {
    if (!v) return "";
    const s = String(v).trim();
    if (/^\d{8}$/.test(s) && s !== "00000000") return s;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}${m[3]}${m[1]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[1].padStart(2,"0")}${m[2].padStart(2,"0")}${m[3]}`;
    return "";
}
function metroToUtc(s) {
    if (!s || !/^\d{8}$/.test(s)) return null;
    return new Date(`${s.slice(4)}-${s.slice(0,2)}-${s.slice(2,4)}T00:00:00Z`);
}

// Book3 amount parser. The sheet has two mixed formats:
//   - Plain JS numbers: 300, 728.75, 3139.19 — already correct.
//   - European-styled strings with $ prefix: "$3.393.32" = $3,393.32, where
//     every "." but the last is a thousands separator and the last is the
//     decimal mark.
function parseAmount(v) {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).trim().replace(/[$\s,]/g, "");
    const parts = s.split(".");
    if (parts.length <= 2) return parseFloat(s) || 0;
    return parseFloat(parts.slice(0, -1).join("") + "." + parts.at(-1)) || 0;
}

// Book3 date parser. The Excel column G holds the invoice period end (or
// equivalently the period_to date). The actual invoice / due_date is the
// NEXT calendar day after the period ends (e.g. period 08.14-08.20.2025 →
// invoice/due date 2025-08-21). This function returns the due_date.
//
// Formats observed:
//   - JS Date objects (Excel-native dates).
//   - ISO strings: "2026-04-20T00:00:00.000Z".
//   - "Nov 5. 2024", "Jan 1. 2026", "Dec 19. 2025".
//   - Week-range: "08.14 - 08.20.2025" (take the end date and +1 day).
const MONTHS = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06",
                 Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };
function parseBook3DueDate(v) {
    if (!v) return null;
    const periodTo = (() => {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = String(v).trim();
        let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[1]}-${m[2]}-${m[3]}`;
        m = s.match(/^([A-Za-z]{3})\.?\s+(\d{1,2})\.?\s*(\d{4})/);
        if (m && MONTHS[m[1]]) return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2,"0")}`;
        const all = [...s.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{4})/g)];
        if (all.length) {
            const last = all[all.length - 1];
            return `${last[3]}-${last[1].padStart(2,"0")}-${last[2].padStart(2,"0")}`;
        }
        return null;
    })();
    if (!periodTo) return null;
    // Add 1 calendar day to get the due_date.
    const d = new Date(`${periodTo}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

// ── Load sources ────────────────────────────────────────────────────────────
console.log("[bad-debtors] Loading sources...");
const carrierDb = JSON.parse(fs.readFileSync(path.join(projectDir, "data/carrier-db.json"), "utf8"));
const zDeals    = JSON.parse(fs.readFileSync(path.join(projectDir, "db/zoho-deals.json"), "utf8"));
const dobMap    = JSON.parse(fs.readFileSync(path.join(projectDir, "data/dob.json"), "utf8"));

// accounting-client-db.json is structured as { "<sheetName>": [carrierRec, …] }
// — build a flat carrier_id → record index. Records carry the authoritative
// `date_filled` (TSS card-issued date) which we use as the primary Date Open.
// Index accounting-db by carrier_id AND cust_id. The Comdata billing-cycle
// sheets use `cust_id` for short legacy IDs; main sheets use `carrier_id`.
const accRaw = JSON.parse(fs.readFileSync(path.join(projectDir, "db/accounting-client-db.json"), "utf8"));
const accByCid = new Map();
for (const arr of Object.values(accRaw)) {
    if (!Array.isArray(arr)) continue;
    for (const rec of arr) {
        for (const idField of ["carrier_id", "cust_id"]) {
            const id = String(rec[idField] || "").replace(/\D/g, "");
            if (/^\d{4,}$/.test(id) && !accByCid.has(id)) accByCid.set(id, rec);
        }
    }
}
console.log(`[bad-debtors] Accounting-client-db carriers: ${accByCid.size}`);

// ── Book1 (collection db) ──────────────────────────────────────────────────
const book1ByCid = new Map();
if (fs.existsSync(BOOK1_PATH)) {
    const wb1 = new ExcelJS.Workbook();
    await wb1.xlsx.readFile(BOOK1_PATH);
    const ws = wb1.worksheets[0];
    const yzByName = new Map();
    for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r).values;
        if (!row[25] || row[26] == null) continue;
        const k = String(row[25]).toLowerCase().replace(/\s+/g, " ").trim();
        if (/^\d+$/.test(String(row[26]))) yzByName.set(k, String(row[26]));
    }
    for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r).values;
        const name = row[1];
        const idCell = row[2];
        const dCell  = row[4];
        if (!name || !dCell) continue;
        let id = idCell && typeof idCell === "object" ? idCell.result : idCell;
        if (typeof id === "object" || !/^\d+$/.test(String(id))) {
            const fb = yzByName.get(String(name).toLowerCase().replace(/\s+/g, " ").trim());
            if (fb) id = fb;
        }
        if (!id || !/^\d{4,}$/.test(String(id))) continue;
        const iso = dCell instanceof Date ? dCell.toISOString().slice(0, 10)
            : (String(dCell).match(/^(\d{4})-(\d{2})-(\d{2})/)?.slice(1).join("-") || null);
        if (!iso) continue;
        const prev = book1ByCid.get(String(id));
        if (!prev || iso < prev) book1ByCid.set(String(id), iso);
    }
}
console.log(`[bad-debtors] Book1 carriers: ${book1ByCid.size}`);

// ── Book3 (bad debtors) ─────────────────────────────────────────────────────
const wb3 = new ExcelJS.Workbook();
await wb3.xlsx.readFile(BOOK3_PATH);
const ws3 = wb3.worksheets[0];
const book3ByCid = new Map(); // cid → { name, invoices: [{amount, dueIso}] }
const badRows = [];
for (let r = 1; r <= ws3.rowCount; r++) {
    const row = ws3.getRow(r).values;
    // Columns (1-indexed in ExcelJS row.values, with values[0] = null):
    //   A=carrierId, B=company, D=amount, G=due_date
    const cidRaw = row[1];
    const name   = String(row[2] || "").trim();
    const amt    = parseAmount(row[4]);
    const dueIso = parseBook3DueDate(row[7]);
    const cid = String(cidRaw || "").replace(/\D/g, "");
    if (!/^\d{4,}$/.test(cid) || !dueIso || amt <= 0) {
        badRows.push({ row: r, cid: cidRaw, name, amt, dueIso });
        continue;
    }
    if (!book3ByCid.has(cid)) book3ByCid.set(cid, { name, invoices: [] });
    book3ByCid.get(cid).invoices.push({ amount: amt, dueIso });
}
console.log(`[bad-debtors] Book3 unique carriers: ${book3ByCid.size}`);
console.log(`[bad-debtors] Book3 unparseable rows: ${badRows.length}`);
for (const b of badRows) console.log(`  row ${b.row}: cid=${b.cid} amt=${b.amt} dueIso=${b.dueIso}`);

// ── Build tradelines ────────────────────────────────────────────────────────
const rows = [];
const missingIdentity = [];
const statusCounts = {};

for (const [cid, b3] of book3ByCid) {
    const c   = carrierDb[cid] || {};
    const der = c.derived || {};
    const z   = c.zoho     || zDeals[cid] || {};
    // Prefer the freshly-indexed accounting record; fall back to whatever
    // carrier-db's earlier sync embedded (typically the same data).
    const accRec = accByCid.get(cid) || {};
    const acc = Object.keys(accRec).length > 0 ? accRec : (c.accounting || {});

    const nameParts = b3.name.split(/\s+/).filter(Boolean);
    // Zoho uses both First_Name and First_name (lowercase n); accept either.
    const zohoFirst = z.First_Name || z.First_name;
    const zohoLast  = z.Last_Name;
    const firstName = (der.first_name || zohoFirst || acc.first_name
        || nameParts[0] || "").trim();
    const lastName  = (der.last_name || zohoLast || acc.last_name
        || nameParts.slice(1).join(" ") || "").trim();

    // Address: split raw line into line1+line2 by unit indicator, and if
    // carrier-db already supplies a separate addr2, strip that substring
    // from line1 so it doesn't appear twice. Zoho Deal fields fill in for
    // carriers not yet in carrier-db (new placements).
    const rawAddr = (der.addr1 || acc.address?.raw || z.Address || "").toString();
    const split = splitAddress(rawAddr);
    let addr1 = split.line1 || rawAddr;
    let addr2 = (der.addr2 || split.line2 || "").toString();
    if (addr2 && addr1) {
        const lc1 = addr1.toLowerCase();
        const lc2 = addr2.toLowerCase();
        const idx = lc1.lastIndexOf(lc2);
        if (idx >= 0) {
            addr1 = (addr1.slice(0, idx) + addr1.slice(idx + addr2.length))
                .trim().replace(/[,;\s]+$/, "");
        }
    }
    const city  = (der.city  || acc.address?.city  || z.City || "").toString().trim();
    const state = (der.state || acc.address?.state || z.State || "").toString().trim().toUpperCase();
    const phone = normPhone(der.phone || z.Phone || acc.phone);

    const zipDigits = String(der.zip || acc.address?.zip || z.Zip_Code || "")
                      .replace(/\D/g, "").slice(0, 9);
    const zip = zipDigits === "" ? ""
        : (zipDigits.length <= 5
            ? `${zipDigits.padStart(5, "0")}-0000`
            : `${zipDigits.padStart(9, "0").slice(0,5)}-${zipDigits.padStart(9, "0").slice(5)}`);

    const dobMetro = parseDobToMetro(dobMap[cid])
                  || parseDobToMetro(der.dob)
                  || parseDobToMetro(z.Birth_Of_Date);

    // Date Open priority:
    //   1. accounting-client-db `date_filled` — the authoritative TSS
    //      card-issued / account-opened date sourced from the accounting
    //      ledger. We DO NOT use Zoho `Carrier_ID_Added_Date` — that field
    //      is a CRM bookkeeping timestamp, not the actual account-open date.
    //   2. accounting `application_date` (if present on the record).
    //   3. Zoho `Application_Date` (application filing date — last resort
    //      when accounting has no record for the carrier).
    //   4. carrier-db `derived.date_open`.
    // accounting `date_filled` is stored as either ISO yyyy-mm-dd or
    // MM/DD/YYYY; handle both.
    const isoOrMdyToMetro = (v) => {
        if (!v) return "";
        const s = String(v).trim();
        let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[2]}${m[3]}${m[1]}`;
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return `${m[1].padStart(2,"0")}${m[2].padStart(2,"0")}${m[3]}`;
        return "";
    };
    let dateOpenMetro = isoOrMdyToMetro(acc.date_filled)
                     || isoOrMdyToMetro(acc.application_date)
                     || isoOrMdyToMetro(z.Application_Date)
                     || isoOrMdyToMetro(der.date_open);
    // Last-resort fallback: when the carrier has no Date Open in carrier-db
    // / zoho / accounting (typical for brand-new bad debtors not yet in our
    // sync), use the earliest Book3 invoice due_date as a proxy. This is the
    // earliest record of the carrier transacting with us.
    if (!dateOpenMetro) {
        const earliestDue = b3.invoices.map(i => i.dueIso).sort()[0];
        if (earliestDue) {
            const m = earliestDue.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) dateOpenMetro = `${m[2]}${m[3]}${m[1]}`;
        }
    }
    const dateOpen = metroToUtc(dateOpenMetro);

    // Oldest unpaid Due Date from Book3.
    const oldestDueIso = b3.invoices
        .map(i => i.dueIso)
        .sort()[0];
    const dueD  = oldestDueIso ? new Date(`${oldestDueIso}T00:00:00Z`) : null;
    const dofdD = dueD ? new Date(dueD.getTime() + 30 * 86400000) : null;
    const dofdMetro = dofdD ? isoToMetro(dofdD.toISOString().slice(0, 10)) : "";

    // Book1 placement (G start) if listed.
    const book1Iso  = book1ByCid.get(cid) || null;
    const book1Date = book1Iso ? new Date(`${book1Iso}T00:00:00Z`) : null;
    const inCollection = !!book1Date;

    // Total past-due across Book3 rows for this carrier.
    const pastDueTotal = Math.round(
        b3.invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100,
    ) / 100;

    // Status from days-past-due on oldest unpaid Due.
    const daysPastDue = dueD ? Math.floor((today - dueD) / 86400000) : 0;
    let status = statusFromDaysPastDue(daysPastDue);

    // PHP: in-collection → G from Book1 placement. Otherwise natural-G
    // escalation via the php-builder helper (210+ days delinquency → G).
    let php = dofdD
        ? buildPhpDebtor(today, dateOpen, dofdD, inCollection ? book1Date : null)
        : "B".repeat(24);

    // G in PHP overrides status to 93. Also force 93 when the carrier is
    // listed in Book1 (sent to collection) even if no PHP month-end has yet
    // crossed the placement date.
    if (inCollection) status = "93";
    else if (php.includes("G")) status = "93";
    else if (status === "11") status = "71"; // Book3 is by definition delinquent

    // Money fields.
    // Credit Limit: from SMP if available, else null (use Book3 total as
    // fallback so HC/CB rules still produce sensible values).
    const smpCreditLimitWeekly = Math.floor(Number(c?.smp?.credit_limit) || 0);
    const creditLimit = smpCreditLimitWeekly || Math.ceil(pastDueTotal * 1.5);

    // Highest Credit: walk-down rule (strictly < CL). When Book3 only has
    // raw unpaid amounts (no payment history), use those as the peak signal.
    // Highest Credit = MAX `amount` on any single Book3 invoice (Book3
    // doesn't carry a status field — every row is an unpaid bad-debt entry).
    let highestCredit = Math.round(
        b3.invoices.reduce((m, i) => Math.max(m, Number(i.amount) || 0), 0),
    );
    if (highestCredit === 0 && pastDueTotal > 0) highestCredit = Math.round(pastDueTotal);

    // Current Balance = amount on the MOST RECENT Book3 invoice (by due
    // date). Amount Past Due covers the sum across all Book3 invoices.
    const latestB3 = [...b3.invoices].sort((a, b) =>
        String(b.dueIso || "").localeCompare(String(a.dueIso || "")))[0];
    const cbRaw = latestB3 ? Number(latestB3.amount) || 0 : 0;
    if (cbRaw > highestCredit) highestCredit = creditLimit;
    const currentBalance = Math.round(cbRaw * 100) / 100;

    if (!dobMetro) {
        missingIdentity.push({ carrierId: cid, name: b3.name, reason: "missing DOB" });
        continue;
    }
    if (!dateOpenMetro) {
        missingIdentity.push({ carrierId: cid, name: b3.name, reason: "missing Date Open" });
        continue;
    }

    statusCounts[status] = (statusCounts[status] || 0) + 1;
    rows.push({
        cid,
        firstName, lastName,
        addr1, addr2, city, state, zip, phone,
        dob: dobMetro,
        dateOpen: dateOpenMetro,
        dofd: dofdMetro,
        lastPay: "",
        dateClosed: "",
        status,
        creditLimit, highestCredit, currentBalance,
        amountPastDue: Math.round(pastDueTotal),
        php,
    });
}

console.log(`[bad-debtors] Built ${rows.length} tradelines`);
console.log(`[bad-debtors] Status counts:`, statusCounts);
console.log(`[bad-debtors] Missing identity (skipped): ${missingIdentity.length}`);
for (const m of missingIdentity) console.log(`  ${m.carrierId}  ${m.name}  ${m.reason}`);

// ── Write Excel ─────────────────────────────────────────────────────────────
const outWb = new ExcelJS.Workbook();
const outWs = outWb.addWorksheet("Bad Debtors");
const HEADERS = [
    "Field Name", "Association Code", "First Name", "Last Name",
    "First Line of Address", "Second Line of Address", "City", "State",
    "Zip Code", "Telephone Number", "Date of Birth",
    "Customer Account Number", "Portfolio Type", "Account Type",
    "Date Open", "Date of First Delinquency", "Date of Last Payment",
    "Date Closed", "Account Status", "Payment Rating",
    "Credit Limit", "Highest Credit",
    "Current Balance", "Amount Past Due", "Terms Frequency", "Terms",
    "Payment History Profile",
];
outWs.addRow(HEADERS);
let n = 0;
for (const r of rows) {
    n++;
    outWs.addRow([
        `Tradeline ${n}`, "1",
        r.firstName, r.lastName,
        r.addr1, r.addr2, r.city, r.state, r.zip, r.phone,
        r.dob, r.cid, "O", "18",
        r.dateOpen, r.dofd, r.lastPay, r.dateClosed,
        Number(r.status) || r.status,
        "",
        r.creditLimit, r.highestCredit, r.currentBalance, r.amountPastDue,
        "W", "001", r.php,
    ]);
}
outWs.getRow(1).font = { bold: true };
outWs.getRow(1).alignment = { horizontal: "center" };
const widths = [12, 5, 16, 16, 30, 20, 18, 6, 12, 13, 12, 14, 5, 6, 12, 14, 14, 12, 8, 8, 10, 12, 12, 12, 6, 8, 28];
widths.forEach((w, i) => outWs.getColumn(i + 1).width = w);

await outWb.xlsx.writeFile(OUT_XLSX);
console.log(`[bad-debtors] Wrote: ${OUT_XLSX}`);
