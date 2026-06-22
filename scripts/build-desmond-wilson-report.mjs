/**
 * Build an Array credit report scoped to the Desmond Wilson Insurance roster
 * (the carriers we currently insure through Desmond Wilson).
 *
 * Scope: every carrier from the roster that ALSO validates LOC + Card Swiped:
 *   - hasCmpTag(carrier, 2)                   → active LOC card in SMP
 *   - zoho.stage === "Card Swiped"            → active Card Swiped deal in Zoho
 *
 * Carriers failing either check are skipped — they're not current TSS clients
 * (closed, deactivated, or pending). Same rule used by src/services/arrayReport.js
 * for the legacy LOC report.
 *
 * Classification per validated carrier:
 *   - Active LOC, no debt           → status 11, PHP via buildPhpLOC
 *   - Active LOC + unpaid CMP / cp  → debtor (status 71-84 from days-past-due,
 *                                     PHP via buildPhpDebtor with G logic)
 *   - Active LOC + balance == 0 but had a debt → status 13, PHP via buildPhpClosed
 *
 * Date Open: "Carrier ID Added" column from the roster xlsx is the
 * authoritative TSS-card-issued date — higher priority than Zoho
 * Application_Date or accounting date_filled.
 *
 * Output:
 *   final-array-report/ArrayReport-DesmondWilson.xlsx     (26-col flat layout)
 *   final-array-report/desmond-wilson-skipped.json        (carriers failing the
 *                                                          LOC+CS check, for audit)
 *   final-array-report/desmond-wilson-missing-dob.json    (in-scope carriers
 *                                                          needing WEX DOB lookup)
 *
 * Usage:
 *   node scripts/build-desmond-wilson-report.mjs
 *   node scripts/build-desmond-wilson-report.mjs --xlsx=path/to/roster.xlsx
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    isoToMetro,
    buildPhpDebtor, buildPhpClosed, buildPhpLOC,
    statusFromDaysPastDue,
    findOldestUnpaidDueDate,
    findLastPaidPeriodEnd,
} from "./lib/php-builder.mjs";
import { refreshSmpToken, fetchAllInvoicesGlobal, fetchInvoicesByStage, indexInvoicesByCarrier } from "../src/services/smp.js";

/**
 * Map a live CMP invoice object into the field names the rest of this script
 * (and php-builder helpers) expects. The live CMP response uses camelCase
 * (`totalPaid`, `dateTo`, …) and does not include a precomputed `remaining`,
 * while carrier-db.json uses snake_case (`total_paid`, `date_to`) and stores
 * `remaining` directly.
 */
function normalizeCmpInvoice(inv) {
    const totalAmount = Number(inv.totalAmount ?? inv.total_amount ?? 0);
    const totalPaid   = Number(inv.totalPaid   ?? inv.total_paid   ?? 0);
    const remaining   = Math.max(0, +(totalAmount - totalPaid).toFixed(2));
    const isoDay = (v) => String(v || "").slice(0, 10);
    return {
        invoice_number: String(inv.invoiceNumber ?? inv.invoice_number ?? ""),
        status:         String(inv.status ?? ""),
        stage:          String(inv.stage ?? ""),
        total_amount:   totalAmount,
        total_paid:     totalPaid,
        remaining,
        date_from:      isoDay(inv.dateFrom ?? inv.date_from ?? inv.periodFrom),
        date_to:        isoDay(inv.dateTo   ?? inv.date_to   ?? inv.periodTo),
        due_date:       isoDay(inv.dueDate  ?? inv.due_date),
    };
}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(projectDir, "final-array-report");

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const m = a.match(/^--([^=]+)=(.*)$/);
        return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
    }),
);

const DEFAULT_XLSX = "/Users/jamshid/Desktop/Desmond Wilson Insurance-2026-04-29-15-39-20 (7) 2.xlsx";
const XLSX_PATH   = args.xlsx   || DEFAULT_XLSX;
const OUT_XLSX    = args.output || path.join(REPORT_DIR, "ArrayReport-DesmondWilson.xlsx");
const SKIP_PATH   = path.join(REPORT_DIR, "desmond-wilson-skipped.json");
const MISSING_DOB = path.join(REPORT_DIR, "desmond-wilson-missing-dob.json");
const EXCLUDED_NO_INVS = path.join(REPORT_DIR, "desmond-wilson-no-cmp-invoices.json");

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

// ── Load sources ────────────────────────────────────────────────────────────
console.log("[desmond-wilson] Loading sources...");

// CMP fetch is slow (~30-60s for 28K invoices), so we cache the result to
// data/cmp-invoices-cache.json. Subsequent runs reuse the cache when it's
// fresher than CACHE_TTL_MS unless --refresh-cmp is passed.
const CACHE_PATH = path.join(projectDir, "data/cmp-invoices-cache.json");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const forceCmpRefresh = "refresh-cmp" in args || "no-cache" in args;

let liveCmpInvoices = null;
if (!forceCmpRefresh && fs.existsSync(CACHE_PATH)) {
    const stat = fs.statSync(CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < CACHE_TTL_MS) {
        const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
        liveCmpInvoices = cached.invoices || [];
        const ageMin = Math.round(ageMs / 60000);
        console.log(`[desmond-wilson] Using cached CMP invoices (${liveCmpInvoices.length}, age ${ageMin}m, ttl 60m)`);
    } else {
        const ageMin = Math.round(ageMs / 60000);
        console.log(`[desmond-wilson] CMP cache is ${ageMin}m old (> 60m ttl), refetching`);
    }
}
if (!liveCmpInvoices) {
    console.log("[desmond-wilson] Fetching live CMP invoices (stage=ACTIVE + PAYMENT_ISSUES + DEBTORS)...");
    await refreshSmpToken();
    // The default global feed returns only stage=ACTIVE. PAYMENT_ISSUES and
    // DEBTORS stages live behind separate queries — these are the queues
    // that actually identify a carrier as a debtor in CMP, so we must merge
    // them in. Dedupe by invoice ID; PAYMENT_ISSUES/DEBTORS records win on
    // collision so the stage is preserved.
    const [active, paymentIssues, debtors] = await Promise.all([
        fetchAllInvoicesGlobal(),
        fetchInvoicesByStage("PAYMENT_ISSUES"),
        fetchInvoicesByStage("DEBTORS"),
    ]);
    const byId = new Map();
    for (const inv of active)         byId.set(inv.id, inv);
    for (const inv of paymentIssues)  byId.set(inv.id, inv);
    for (const inv of debtors)        byId.set(inv.id, inv);
    liveCmpInvoices = [...byId.values()];
    console.log(`[desmond-wilson]   ACTIVE: ${active.length} | PAYMENT_ISSUES: ${paymentIssues.length} | DEBTORS: ${debtors.length} | merged: ${liveCmpInvoices.length}`);
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
        fetched_at: new Date().toISOString(),
        count: liveCmpInvoices.length,
        invoices: liveCmpInvoices,
    }));
    console.log(`[desmond-wilson] Saved CMP cache: ${CACHE_PATH}`);
}
const liveCmpByCarrier = indexInvoicesByCarrier(liveCmpInvoices);
console.log(`[desmond-wilson] Live CMP invoices: ${liveCmpInvoices.length} | carriers: ${liveCmpByCarrier.size}`);
const zDeals    = JSON.parse(fs.readFileSync(path.join(projectDir, "db/zoho-deals.json"), "utf8"));
const carrierDb = JSON.parse(fs.readFileSync(path.join(projectDir, "data/carrier-db.json"), "utf8"));
const dobMap    = JSON.parse(fs.readFileSync(path.join(projectDir, "data/dob.json"), "utf8"));
// collection-placement-db (cp-db), frt-debtor-stage-invoices.json and
// data/collection-placed-dates.json are NO LONGER read. Their data was
// confirmed incorrect (cross-wired carrier IDs, stale agent records). The
// only collection-placement source we trust now is Book1.xlsx — loaded below.

// Book1: the authoritative "sent to collection" list. If a carrier ID appears
// here, they ARE in collection and the date is when PHP "G" should start.
// We index by carrier ID (resolved through the spreadsheet's own Y/Z lookup
// when col B's VLOOKUP failed). collection-placement-db is unreliable —
// e.g. the abdulbositabdurasulov entry has invoices tagged with carrier ID
// 5799057 which actually belongs to Mukhammadkodir Abdugafforov — so we only
// trust Book1 for collection-placement, not cp-db.
const BOOK1_PATH = "/Users/jamshid/Desktop/Book1   12.05.2026 (2).xlsx";
const book1ByCid = new Map();
if (fs.existsSync(BOOK1_PATH)) {
    const book1Wb = new ExcelJS.Workbook();
    await book1Wb.xlsx.readFile(BOOK1_PATH);
    const b1ws = book1Wb.worksheets[0];
    const yzByName = new Map();
    for (let r = 1; r <= b1ws.rowCount; r++) {
        const row = b1ws.getRow(r).values;
        if (!row[25] || row[26] == null) continue;
        const norm = String(row[25]).toLowerCase().replace(/\s+/g, " ").trim();
        if (/^\d+$/.test(String(row[26]))) yzByName.set(norm, String(row[26]));
    }
    for (let r = 1; r <= b1ws.rowCount; r++) {
        const row = b1ws.getRow(r).values;
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
        const iso = dCell instanceof Date
            ? dCell.toISOString().slice(0,10)
            : (String(dCell).match(/^(\d{4})-(\d{2})-(\d{2})/)?.slice(1).join("-") || null);
        if (!iso) continue;
        // Keep the EARLIEST placement date if a carrier appears multiple times.
        const prev = book1ByCid.get(String(id));
        if (!prev || iso < prev) book1ByCid.set(String(id), iso);
    }
}
console.log(`[desmond-wilson] Book1 carriers in collection: ${book1ByCid.size}`);

// ── Helpers ─────────────────────────────────────────────────────────────────
function hasCmpTag(c, tagId) {
    const t = c?.smp?.tag_ids;
    return Array.isArray(t) && t.some(id => Number(id) === tagId);
}
function hasZohoCardSwiped(c) {
    return String(c?.zoho?.stage || "").trim() === "Card Swiped";
}
function normPhone(v) {
    const digits = String(v || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return digits.length === 10 ? digits : digits.slice(-10);
}
function parseDobToMetro(v) {
    if (!v) return "";
    const s = String(v).trim();
    if (/^\d{8}$/.test(s) && s !== "00000000") return s;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}${m[3]}${m[1]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}${m[3]}`;
    return "";
}
function parseDateToMetro(v) {
    if (!v) return "";
    if (v instanceof Date) {
        const m = String(v.getUTCMonth() + 1).padStart(2, "0");
        const d = String(v.getUTCDate()).padStart(2, "0");
        return `${m}${d}${v.getUTCFullYear()}`;
    }
    const s = String(v).trim();
    if (/^\d{8}$/.test(s) && s !== "00000000") return s;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}${m[3]}${m[1]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}${m[3]}`;
    return "";
}
function metroToUtc(s) {
    if (!s || !/^\d{8}$/.test(s)) return null;
    return new Date(`${s.slice(4)}-${s.slice(0, 2)}-${s.slice(2, 4)}T00:00:00Z`);
}
function splitAddress(raw) {
    if (!raw) return { line1: "", line2: "" };
    let s = String(raw).trim();

    // Find the FIRST occurrence of a unit indicator anywhere in the string.
    // Indicator list kept unambiguous: apt/suite/ste/unit/bldg/rm/# are
    // safe; "fl/floor" only when adjacent to a digit (avoids matching "fl" =
    // Florida in mid-address). Anything before the indicator → line1,
    // indicator and everything after → line2.
    const patterns = [
        /\b(?:apt|suite|ste|unit|bldg|rm)\b\.?/i,
        /#\s*\w/,                                       // "#416"
        /\b\d+(?:st|nd|rd|th)?[-\s]*(?:fl|floor)\b/i,   // "1st fl", "2-floor"
        /\b(?:fl|floor)\s*\d/i,                         // "fl 2"
    ];
    let idx = -1;
    for (const p of patterns) {
        const match = s.match(p);
        if (match && (idx === -1 || match.index < idx)) idx = match.index;
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
// getCollectionPlacedDate removed: cp-db and data/collection-placed-dates.json
// were the historical sources and both have been confirmed incorrect. Book1
// is now the single source of truth for placement dates — read directly via
// book1ByCid above.

// ── Read Desmond Wilson roster ──────────────────────────────────────────────
console.log(`[desmond-wilson] Reading roster: ${XLSX_PATH}`);
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(XLSX_PATH);
const ws = wb.worksheets[0];
const roster = [];
for (let r = 10; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // Column layout in the Desmond Wilson roster xlsx (data starts row 10):
    //   2 = Application Id, 4 = Carrier ID Number, 7 = Legal Business Name,
    //   8 = Carrier ID Added, 9 = Type of Business.
    const cid = String(row.getCell(4).value || "").replace(/\D/g, "").trim();
    if (!/^\d+$/.test(cid)) continue;
    const appId  = String(row.getCell(2).value || "").trim();
    const name   = String(row.getCell(7).value || "").trim();
    const added  = row.getCell(8).value;
    const btype  = String(row.getCell(9).value || "").trim();
    const addedIso = (() => {
        if (added instanceof Date) return added.toISOString().slice(0, 10);
        const s = String(added || "").trim();
        let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? m[0] : "";
    })();
    roster.push({ cid, appId, name, addedIso, btype });
}
console.log(`[desmond-wilson] Roster carriers: ${roster.length}`);

// ── Filter: must validate LOC + Card Swiped ────────────────────────────────
const inScope = [];
const skipped = [];
for (const r of roster) {
    const c = carrierDb[r.cid];
    if (!c) {
        skipped.push({ ...r, reason: "not in carrier-db (newer than last sync)" });
        continue;
    }
    const t2 = hasCmpTag(c, 2);
    const cs = hasZohoCardSwiped(c);
    if (!t2 || !cs) {
        skipped.push({ ...r, reason: !t2 && !cs ? "missing SMP tag 2 AND Card Swiped"
                                        : !t2     ? "missing SMP tag 2"
                                        :           "missing Card Swiped" });
        continue;
    }
    inScope.push(r);
}
console.log(`[desmond-wilson] In-scope (LOC + Card Swiped):  ${inScope.length}`);
console.log(`[desmond-wilson] Skipped:                       ${skipped.length}`);

// ── Build a tradeline per in-scope carrier ─────────────────────────────────
const rows = [];
const missingDob = [];
const excludedNoInvoices = [];
const statusCounts = {};

for (const r of inScope) {
    const cid = r.cid;
    const c   = carrierDb[cid] || {};
    const der = c.derived || {};
    const z   = c.zoho     || zDeals[cid] || {};
    const acc = c.accounting || {};

    // Identity — sourced from carrier-db / zoho / accounting only. cp-db and
    // collection-placed-dates.json are not consulted (their identity data was
    // unreliable along with their placement data).
    const nameParts = r.name.split(/\s+/).filter(Boolean);
    const firstName = (der.first_name || z.First_Name || acc.first_name
        || nameParts[0] || "").trim();
    const lastName  = (der.last_name || z.Last_Name || acc.last_name
        || nameParts.slice(1).join(" ") || "").trim();

    const rawAddr = der.addr1 || acc.address?.raw || "";
    const split   = splitAddress(rawAddr);
    const addr1   = split.line1 || rawAddr || "";
    const addr2   = der.addr2 || split.line2 || "";
    const city    = (der.city  || acc.address?.city  || "").toString().trim();
    const state   = (der.state || acc.address?.state || "").toString().trim().toUpperCase();
    // ZIP: report as the full 9-digit ZIP+4 format with hyphen
    // (XXXXX-XXXX). When only the 5-digit base ZIP is on file, left-justify
    // and zero-fill the +4 portion (e.g. 02472 → "02472-0000"). Per CRRG:
    // "If not reporting the entire 9 digit zip code, left justify and zero
    // fill the field (example 12345-0000)".
    const zipDigits = String(der.zip || acc.address?.zip || "").replace(/\D/g, "").slice(0, 9);
    const zip = zipDigits === ""
        ? ""
        : (zipDigits.length <= 5
            ? `${zipDigits.padStart(5, "0")}-0000`
            : `${zipDigits.padStart(9, "0").slice(0,5)}-${zipDigits.padStart(9, "0").slice(5)}`);
    const phone   = normPhone(der.phone || z.Phone || acc.phone);

    // DOB priority: dob.json (WEX) → carrier-db derived.dob
    const dobMetro = parseDobToMetro(dobMap[cid]) || parseDobToMetro(der.dob);

    // Date Open priority:
    //   1. Roster "Carrier ID Added" (authoritative TSS card-issued date)
    //   2. accounting `date_filled` / `application_date` (TSS card-issued
    //      date as recorded in the accounting ledger)
    //   3. Zoho `Application_Date` (application filing date — fallback)
    //   4. carrier-db `derived.date_open`
    // We do NOT use Zoho `Carrier_ID_Added_Date` — that's a CRM bookkeeping
    // timestamp (when the card was added on the CRM side), not the actual
    // account-open date.
    let dateOpenMetro = "";
    if (r.addedIso) dateOpenMetro = isoToMetro(r.addedIso);
    if (!dateOpenMetro) dateOpenMetro = parseDateToMetro(acc.date_filled);
    if (!dateOpenMetro) dateOpenMetro = parseDateToMetro(acc.application_date);
    if (!dateOpenMetro) dateOpenMetro = parseDateToMetro(z.Application_Date);
    if (!dateOpenMetro) dateOpenMetro = parseDateToMetro(der.date_open);
    const dateOpen = metroToUtc(dateOpenMetro);

    // Oldest unpaid Due Date — derived from the LIVE CMP invoice history.
    // We pull invoices directly from CMP at script start (28K most recent)
    // rather than reading carrier-db.json (which is only synced once/day and
    // can lag by days), so a carrier who paid yesterday isn't still flagged
    // as a debtor today. Carriers not in the live feed (older debt outside
    // CMP's recent view) fall back to carrier-db.
    //
    // We also do not consult the cmpStages snapshot or cp-db for the
    // delinquency anchor — cp-db has cross-wired carrier IDs that bleed one
    // carrier's debt into another's report row.
    const liveInvs = liveCmpByCarrier.get(cid) || [];
    const book1PlacedIso = book1ByCid.get(cid) || null;
    const book1PlacedDate = book1PlacedIso ? new Date(`${book1PlacedIso}T00:00:00Z`) : null;

    // Exclude carriers with no CMP invoices in any of the three stages
    // (ACTIVE / PAYMENT_ISSUES / DEBTORS). Without invoices we can't compute
    // PHP, DOFD, or money fields — the row would be a placeholder with no
    // credit-reportable activity. Book1 carriers are retained even without
    // CMP invoices (we synthesize their DOFD from the placement date).
    if (liveInvs.length === 0 && !book1PlacedDate) {
        excludedNoInvoices.push({ carrierId: cid, name: r.name, addedIso: r.addedIso });
        continue;
    }
    const invHistoryAll = liveInvs.map(normalizeCmpInvoice);
    let oldestUnpaidDueIso = findOldestUnpaidDueDate(invHistoryAll);

    // If Book1 says this carrier is in collection but CMP shows no unpaid
    // invoices (carrier has no CMP record, or paid all of them off after
    // being placed), synthesize a Due Date 15 days before the placement
    // date — DOFD then sits placement-date + 15 days, which keeps the
    // delinquency anchor consistent with the collection placement.
    if (!oldestUnpaidDueIso && book1PlacedDate) {
        const due = new Date(book1PlacedDate.getTime() - 15 * 86400000);
        oldestUnpaidDueIso = due.toISOString().slice(0, 10);
    }

    const dueD     = oldestUnpaidDueIso ? new Date(`${oldestUnpaidDueIso}T00:00:00Z`) : null;
    const dofdD    = dueD ? new Date(dueD.getTime() + 30 * 86400000) : null;
    const dofdMetro= dofdD ? isoToMetro(dofdD.toISOString().slice(0, 10)) : "";

    // Date of Last Payment — periodTo of the most recent PAID invoice.
    // Approximation; refined later by ingesting billing-history transactions.
    const lastPaidIso = findLastPaidPeriodEnd(invHistoryAll);
    const lastPayMetro = lastPaidIso ? isoToMetro(lastPaidIso) : "";

    // ── Metro 2 money fields (per the agreed rules) ────────────────────────
    // Current Balance = remaining_amount on the MOST RECENT CMP invoice
    //                   (today's outstanding, not lifetime debt).
    // Credit Limit    = the weekly limit set in SMP (smp.credit_limit).
    // Highest Credit  = lifetime sum of total_paid across all CMP invoices
    //                   (total amount ever billed and paid via the LOC).
    // Amount Past Due = total unpaid across debtor stages / cp-db / xlsx
    //                   (only used for debtor / status-13 rows; 0 for LOC).
    const invHistory = invHistoryAll;
    const invSortKey = (inv) => String(inv?.date_to || inv?.due_date
                                       || inv?.date_from || inv?.invoice_number || "");
    const sortedHistory = [...invHistory].sort((a, b) => invSortKey(b).localeCompare(invSortKey(a)));
    const latestInv = sortedHistory[0] || null;

    // Current Balance = remaining on the MOST RECENT pending invoice
    // (single invoice, latest by date_to). Amount Past Due (reported
    // separately) covers the SUM across all pending + partially_paid.
    const pendingInvs = invHistory
        .filter(i => ["PENDING", "PARTIALLY_PAID"].includes(String(i.status || "").toUpperCase()))
        .sort((a, b) => String(b.date_to || b.due_date || "").localeCompare(String(a.date_to || a.due_date || "")));
    const currentBalanceFromLatest = pendingInvs.length
        ? Math.round(Math.max(0, Number(pendingInvs[0].remaining) || 0) * 100) / 100
        : 0;

    // Highest Credit = MAX `total_amount` across PAID / PENDING /
    // PARTIALLY_PAID invoices, walked down to be strictly less than CL.
    const smpCreditLimitWeekly = Math.floor(Number(c?.smp?.credit_limit) || 0);
    const billableStatuses = new Set(["PAID", "PENDING", "PARTIALLY_PAID"]);
    const billableAmounts = invHistory
        .filter(i => billableStatuses.has(String(i.status || "").toUpperCase()))
        .map(i => Number(i.total_amount) || 0)
        .filter(v => v > 0)
        .sort((a, b) => b - a);
    let highestCreditLifetime = 0;
    if (smpCreditLimitWeekly > 0) {
        for (const v of billableAmounts) if (v < smpCreditLimitWeekly) { highestCreditLifetime = Math.round(v); break; }
    } else if (billableAmounts.length) {
        highestCreditLifetime = Math.round(billableAmounts[0]);
    }

    // Total past-due — sourced ONLY from live CMP invoices. cp-db is no
    // longer consulted because it has cross-wired carrier IDs that bleed one
    // carrier's debt into another's report row. Carriers listed in Book1
    // but with no CMP unpaid invoices keep pastDueTotal = 0 (the placement
    // is real, but we have no dollar figure to report as past-due).
    const liveUnpaid = invHistoryAll.filter(i =>
        !["PAID", "CANCELLED"].includes(String(i.status || "")));
    const pastDueTotal = Math.round(
        liveUnpaid.reduce((s, i) => s + Math.max(0, Number(i.remaining) || 0), 0) * 100,
    ) / 100;

    // CMP also exposes PAYMENT_ISSUES and DEBTORS as separate invoice stages
    // — the queues where a carrier's overdue invoices land. Only an UNPAID
    // invoice at one of those stages makes the carrier a debtor; an invoice
    // that landed in the DEBTORS queue and was later paid off (status=PAID)
    // is historical, not current debt.
    const cmpDebtorStage = invHistoryAll.some(i => {
        const stage  = String(i.stage  || "").toUpperCase();
        const status = String(i.status || "").toUpperCase();
        return (stage === "PAYMENT_ISSUES" || stage === "DEBTORS")
            && status !== "PAID" && status !== "CANCELLED";
    });

    // Placement date for PHP "G" code start: ONLY Book1.xlsx is used.
    // cp-db and data/collection-placed-dates.json have historically held
    // incorrect placement data (cross-wired carrier IDs, stale agent
    // records), so they are no longer consulted. A carrier is in collection
    // for credit-report purposes iff Book1 lists them.
    const placedIso  = book1PlacedIso;
    const placedDate = placedIso ? new Date(`${placedIso}T00:00:00Z`) : null;
    const inCollection = !!book1PlacedDate;

    // Classification:
    //   in Book1                  → debtor, status from days past due, G from
    //                               placedDate (or 84 if no CMP unpaid data)
    //   not in Book1, CMP unpaid 30+ days → debtor 71..84 from days past due
    //   not in Book1, CMP unpaid <30 days → active LOC (status 11), pending
    //                               invoice not yet past CRRG's 30-day clock
    //   not in Book1, CMP all paid→ active LOC (status 11)
    //
    // CRRG rule: DOFD (Field 16) and Amount Past Due (Field 23) MUST be blank
    // / zero for status 11. They are only populated for delinquent statuses
    // (71/78/80/82/83/84) and for collection placements (in Book1).
    let status, php, dateClosedMetro = "";
    let amountPastDue = 0;

    if (inCollection || cmpDebtorStage || (pastDueTotal > 0 && !!dueD)) {
        const daysPastDue = dueD ? Math.floor((today - dueD) / 86400000) : 0;
        status = statusFromDaysPastDue(daysPastDue);
        if (status === "11" && !inCollection && !cmpDebtorStage) {
            // Pending invoice exists but it's <30 days past Due Date AND CMP
            // hasn't flagged the carrier to a debtor queue → genuinely
            // current. Drop debtor-only markers.
            php = dateOpen ? buildPhpLOC(today, dateOpen) : "B".repeat(24);
            amountPastDue = 0;
        } else {
            // CMP-queued debtors (PAYMENT_ISSUES / DEBTORS) or Book1 placements
            // are debtors by definition; CRRG status 11 (current) is invalid
            // for them — force to the minimum delinquent code 71.
            if (status === "11" && (inCollection || cmpDebtorStage)) status = "71";
            php = (dofdD)
                ? buildPhpDebtor(today, dateOpen, dofdD, placedDate)
                : (dateOpen ? buildPhpLOC(today, dateOpen) : "B".repeat(24));
            // Strict Book1-only G rule: php-builder emits natural-G when a
            // delinquency reaches 210+ days, but we only want G to come from
            // an explicit Book1 placement. Downgrade naturally-emitted G's to
            // "6" (180+ bucket) when the carrier isn't in Book1.
            if (!inCollection) php = php.replace(/G/g, "6");
            // CRRG Account Status 93 = "Account assigned to internal or
            // external collections". Every Book1 carrier is in collection by
            // definition; their Account Status is 93 regardless of whether
            // any PHP month-end has yet crossed the placement date. For
            // non-Book1 carriers, only an actual G in PHP (natural-G from
            // 210+ days past due that we kept) triggers 93.
            if (inCollection) status = "93";
            else if (php.includes("G")) status = "93";
            amountPastDue = Math.round(pastDueTotal);
        }
    } else {
        // Active LOC — paid up (or no debt history at all)
        status = "11";
        php = dateOpen ? buildPhpLOC(today, dateOpen) : "B".repeat(24);
        amountPastDue = 0;
    }
    const creditLimit    = smpCreditLimitWeekly;
    // Current Balance is raw (no cap). If CB > HC, bump HC up to Credit
    // Limit — carrier is effectively maxed-out. HC never exceeds CL since
    // the walk-down keeps it strictly below.
    let highestCredit = highestCreditLifetime;
    if (currentBalanceFromLatest > highestCredit) highestCredit = creditLimit;
    const currentBalance = currentBalanceFromLatest;
    if (!dobMetro) {
        // CRRG requires DOB when SSN isn't reported. Skip the row from the
        // submitted report but log the carrier for follow-up.
        missingDob.push({
            carrierId: cid,
            name: r.name,
            company: c.company || "",
            phone, state,
            reason: "Date of Birth missing — required by CRRG when SSN is not reported. Run WEX DOB lookup.",
        });
        continue;
    }
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    rows.push({
        cid,
        association: "1",
        firstName, lastName,
        addr1, addr2, city, state, zip, phone,
        dob:            dobMetro,
        dateOpen:       dateOpenMetro,
        dofd:           status === "11" ? "" : dofdMetro,
        lastPay:        lastPayMetro,
        dateClosed:     dateClosedMetro,
        status,
        creditLimit, highestCredit, currentBalance, amountPastDue,
        termsFreq:      "W",
        terms:          "001",
        php,
    });
}

console.log(`[desmond-wilson] Built ${rows.length} tradelines`);
console.log(`[desmond-wilson] Excluded (no CMP invoices): ${excludedNoInvoices.length}`);
console.log(`[desmond-wilson] Status counts:`, statusCounts);
console.log(`[desmond-wilson] Missing DOB:   ${missingDob.length}`);

// ── Write Excel ────────────────────────────────────────────────────────────
const outWb = new ExcelJS.Workbook();
const outWs = outWb.addWorksheet("Desmond Wilson");
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
        `Tradeline ${n}`, r.association,
        r.firstName, r.lastName,
        r.addr1, r.addr2, r.city, r.state, r.zip, r.phone,
        r.dob, r.cid, (String(r.status) === "11" || String(r.status) === "13") ? "C" : "O", "18",
        r.dateOpen, r.dofd, r.lastPay, r.dateClosed,
        Number(r.status) || r.status,
        "",
        r.creditLimit, r.highestCredit, r.currentBalance, r.amountPastDue,
        r.termsFreq, r.terms, r.php,
    ]);
}

outWs.getRow(1).font = { bold: true };
outWs.getRow(1).alignment = { horizontal: "center" };
const widths = [12, 5, 16, 16, 30, 20, 18, 6, 11, 13, 12, 14, 5, 6, 12, 14, 14, 12, 8, 8, 10, 12, 12, 12, 6, 8, 28];
widths.forEach((w, i) => outWs.getColumn(i + 1).width = w);

await outWb.xlsx.writeFile(OUT_XLSX);
console.log(`[desmond-wilson] Wrote: ${OUT_XLSX}`);

// ── Side logs ──────────────────────────────────────────────────────────────
if (skipped.length) {
    skipped.sort((a, b) => a.cid.localeCompare(b.cid));
    fs.writeFileSync(SKIP_PATH, JSON.stringify(skipped, null, 2));
    console.log(`[desmond-wilson] Skipped list:    ${SKIP_PATH}  (${skipped.length})`);
}
if (missingDob.length) {
    missingDob.sort((a, b) => a.carrierId.localeCompare(b.carrierId));
    fs.writeFileSync(MISSING_DOB, JSON.stringify(missingDob, null, 2));
    console.log(`[desmond-wilson] Missing-DOB list: ${MISSING_DOB}  (${missingDob.length})`);
}
if (excludedNoInvoices.length) {
    excludedNoInvoices.sort((a, b) => String(a.carrierId).localeCompare(String(b.carrierId)));
    fs.writeFileSync(EXCLUDED_NO_INVS, JSON.stringify(excludedNoInvoices, null, 2));
    console.log(`[desmond-wilson] No-CMP-invoices list: ${EXCLUDED_NO_INVS}  (${excludedNoInvoices.length})`);
}
