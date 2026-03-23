/**
 * syncCarrierDb.js — File-based carrier database sync.
 *
 * Builds/updates carrier-db.json daily from:
 *   1. Zoho CRM Deals (Card Swiped)  → zoho block
 *   2. SMP LOC companies (tagIds=2)  → smp block
 *   3. SMP invoices + billing        → invoices[], billing_history[]
 *   4. debtor-master-db.json         → billing_cycle, credit_score_tss, ggr_data, debtor_periods
 *   5. collection-placement-db.json  → collection month / G-profile start
 *   6. metro2.js engine              → derived block (all 48 Array fields)
 *
 * No MongoDB dependency — reads/writes a single carrier-db.json file.
 * DOB = zoho.dob_raw only.  Credit score = zoho.credit_score_raw || credit_score_tss.
 */

import fs from "fs";
import path from "path";
import { env } from "../config/env.js";
import {
    fetchCompanies,
    fetchAllInvoicesGlobal,
    indexInvoicesByCarrier,
    getCarrierInvoicesFromIndex,
    fetchAllBillingHistoryGlobal,
    indexBillingHistoryByCarrier,
    getCarrierBillingFromGlobal,
} from "./smp.js";
import { fetchDeals, ensureZohoToken } from "./zoho.js";
import { computeMetro2, parseDate } from "./metro2.js";

// ── Paths ────────────────────────────────────────────────────────────────────

const CARRIER_DB_PATH = env.CARRIER_DB_PATH;
const MASTER_DB_PATH  = env.MASTER_DB_PATH;
const ACCOUNTING_DB_PATH = env.ACCOUNTING_DB_PATH;
const COLLECTION_DB_PATH = env.COLLECTION_DB_PATH;

// ── State ────────────────────────────────────────────────────────────────────

let syncInProgress = false;
let lastSyncResult = null;
let syncPromise = null;
let syncProgress = null;

export function getCarrierDbSyncStatus() {
    return { inProgress: syncInProgress, lastResult: lastSyncResult, progress: syncProgress };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadCarrierDb() {
    if (fs.existsSync(CARRIER_DB_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CARRIER_DB_PATH, "utf-8"));
        } catch {
            console.warn("[carrier-db] Could not parse existing carrier-db.json — starting fresh.");
        }
    }
    return {};
}

function saveCarrierDb(db) {
    const dir = path.dirname(CARRIER_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CARRIER_DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    console.log(`[carrier-db] Saved ${Object.keys(db).length} carriers → ${CARRIER_DB_PATH}`);
}

function loadMasterDb() {
    if (!MASTER_DB_PATH || !fs.existsSync(MASTER_DB_PATH)) {
        console.warn("[carrier-db] debtor-master-db.json not found — offline data unavailable.");
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(MASTER_DB_PATH, "utf-8"));
    } catch {
        console.warn("[carrier-db] Could not parse debtor-master-db.json.");
        return {};
    }
}

function loadAccountingDb() {
    if (!ACCOUNTING_DB_PATH || !fs.existsSync(ACCOUNTING_DB_PATH)) {
        console.warn("[carrier-db] accounting-client-db.json not found — accounting fallback unavailable.");
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(ACCOUNTING_DB_PATH, "utf-8"));
    } catch {
        console.warn("[carrier-db] Could not parse accounting-client-db.json.");
        return {};
    }
}

function loadCollectionDb() {
    if (!COLLECTION_DB_PATH || !fs.existsSync(COLLECTION_DB_PATH)) {
        console.warn("[carrier-db] collection-placement-db.json not found — collection fallback unavailable.");
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(COLLECTION_DB_PATH, "utf-8"));
    } catch {
        console.warn("[carrier-db] Could not parse collection-placement-db.json.");
        return {};
    }
}

function getCarrierDbStatusSnapshot() {
    const syncStatus = getCarrierDbSyncStatus();
    let fileMeta = null;

    if (fs.existsSync(CARRIER_DB_PATH)) {
        const stat = fs.statSync(CARRIER_DB_PATH);
        fileMeta = {
            path: CARRIER_DB_PATH,
            sizeKb: Math.round(stat.size / 1024),
            lastModified: stat.mtime.toISOString(),
        };

        try {
            const db = JSON.parse(fs.readFileSync(CARRIER_DB_PATH, "utf-8"));
            const carriers = Object.values(db);
            fileMeta.totalCarriers = carriers.length;
            fileMeta.debtors = carriers.filter((c) => c.derived?.is_debtor).length;
            fileMeta.withDob = carriers.filter((c) => c.derived?.dob).length;
            fileMeta.withDelinquency = carriers.filter((c) => c.derived?.date_first_delinquency).length;
            fileMeta.withGgr = carriers.filter((c) => c.ggr_data).length;
            fileMeta.missingDob = carriers.filter((c) => !c.derived?.dob).length;
        } catch {
            fileMeta.parseError = true;
        }
    }

    return {
        sync: syncStatus,
        file: fileMeta,
        now: new Date().toISOString(),
    };
}

/** Normalize a carrier ID to string, return null if invalid. */
function normCid(raw) {
    const s = String(raw || "").trim();
    return s && !["0", "null", "None"].includes(s) ? s : null;
}

/** Safely parse a float, return 0 on failure. */
function safeNum(v) {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
}

function normalizeCompanyKey(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
}

function normalizePhone10(v) {
    const digits = String(v || "").replace(/[^0-9]/g, "");
    if (digits.length >= 10) return digits.slice(-10);
    return "";
}

function mmddyyyyToIso(value) {
    const raw = String(value || "").trim();
    if (/^\d{8}$/.test(raw)) {
        return `${raw.slice(4, 8)}-${raw.slice(0, 2)}-${raw.slice(2, 4)}`;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw;
    }
    return "";
}

function ensureDebtorTag(tags = [], isDebtor = false) {
    const normalized = tags.map((tag) => ({
        ...tag,
        id: Number(tag.id),
    }));

    if (isDebtor && !normalized.some((tag) => tag.id === 1)) {
        normalized.push({ id: 1, name: "Debtor" });
    }

    return normalized;
}

function buildCompanyFromCachedEntry(cid, entry = {}) {
    if (!entry?.smp) return null;

    return {
        id: entry.smp.company_id ?? null,
        carrierId: cid,
        name: entry.company || "",
        createDate: entry.smp.create_date || "",
        creditLimit: entry.smp.credit_limit || 0,
        contactPhone: entry.smp.contact_phone || "",
        address: {
            addressLine1: entry.smp.address?.line1 || "",
            addressLine2: entry.smp.address?.line2 || "",
            city: entry.smp.address?.city || "",
            state: entry.smp.address?.state || "",
            postalCode: entry.smp.address?.zip || "",
        },
        owners: (entry.smp.owners || []).map((owner) => ({
            firstName: owner.first_name || "",
            lastName: owner.last_name || "",
        })),
        tags: ensureDebtorTag(
            (entry.smp.tag_ids || []).map((id) => ({ id: Number(id) })),
            Boolean(entry.smp.is_debtor)
        ),
    };
}

function buildDealFromCachedEntry(entry = {}) {
    if (!entry?.zoho) return null;

    return {
        id: entry.zoho.deal_id || "",
        Stage: entry.zoho.stage || "Card Swiped",
        First_name: entry.zoho.first_name || "",
        Last_Name: entry.zoho.last_name || "",
        Address: entry.zoho.address || "",
        City: entry.zoho.city || "",
        State: entry.zoho.state || "",
        Zip_Code: entry.zoho.zip || "",
        Application_Date: entry.zoho.application_date || "",
        Birth_Of_Date: mmddyyyyToIso(entry.zoho.dob_raw),
        Credit_Score: entry.zoho.credit_score_raw || "",
    };
}

function buildDefaultDerived(entry = {}) {
    return {
        first_name: "",
        last_name: "",
        addr1: "",
        addr2: "",
        city: "",
        state: "",
        zip: "",
        phone: "",
        dob: "",
        credit_score: "",
        date_open: "",
        date_first_delinquency: "",
        date_last_payment: "",
        date_closed: "",
        account_status: "",
        payment_history_profile: "",
        credit_limit: 0,
        highest_credit: 0,
        current_balance: 0,
        amount_past_due: 0,
        actual_payment: 0,
        is_debtor: false,
        is_closed: false,
        was_former_debtor: false,
        ...(entry.derived || {}),
    };
}

function buildAccountingFromCachedEntry(entry = {}) {
    return entry?.accounting || null;
}

function applyAccountingFallbacks(comp, deal, accountingEntry = null) {
    if (!accountingEntry) {
        return { comp, deal };
    }

    const fallbackComp = comp
        ? {
            ...comp,
            name: comp.name || accountingEntry.company || "",
            contactPhone: comp.contactPhone || accountingEntry.phone_raw || accountingEntry.phone || "",
            creditScore: comp.creditScore || accountingEntry.credit_score || "",
            address: {
                ...(comp.address || {}),
                addressLine1: comp.address?.addressLine1 || accountingEntry.address?.line1 || "",
                addressLine2: comp.address?.addressLine2 || "",
                city: comp.address?.city || accountingEntry.address?.city || "",
                state: comp.address?.state || accountingEntry.address?.state || "",
                postalCode: comp.address?.postalCode || accountingEntry.address?.zip || "",
            },
            owners: (comp.owners && comp.owners.length)
                ? comp.owners
                : [{
                    firstName: accountingEntry.first_name || "",
                    lastName: accountingEntry.last_name || "",
                }],
        }
        : null;

    const fallbackDeal = deal
        ? {
            ...deal,
            First_name: deal.First_name || accountingEntry.first_name || "",
            Last_Name: deal.Last_Name || accountingEntry.last_name || "",
            Address: deal.Address || accountingEntry.address?.line1 || accountingEntry.address?.raw || "",
            City: deal.City || accountingEntry.address?.city || "",
            State: deal.State || accountingEntry.address?.state || "",
            Zip_Code: deal.Zip_Code || accountingEntry.address?.zip || "",
            Credit_Score: deal.Credit_Score || accountingEntry.credit_score || "",
        }
        : null;

    return { comp: fallbackComp, deal: fallbackDeal };
}

function buildPreferredContactData(deal, accountingEntry, comp, existingDerived = {}) {
    const owner = comp?.owners?.[0] || {};
    const addr = comp?.address || {};

    return {
        first_name: String(
            deal?.First_name
            || accountingEntry?.first_name
            || owner.firstName
            || existingDerived.first_name
            || ""
        ).trim(),
        last_name: String(
            deal?.Last_Name
            || accountingEntry?.last_name
            || owner.lastName
            || existingDerived.last_name
            || ""
        ).trim(),
        addr1: String(
            deal?.Address
            || accountingEntry?.address?.line1
            || addr.addressLine1
            || existingDerived.addr1
            || ""
        ).trim(),
        city: String(
            deal?.City
            || accountingEntry?.address?.city
            || addr.city
            || existingDerived.city
            || ""
        ).trim(),
        state: String(
            deal?.State
            || accountingEntry?.address?.state
            || addr.state
            || existingDerived.state
            || ""
        ).trim(),
        zip: String(
            deal?.Zip_Code
            || accountingEntry?.address?.zip
            || addr.postalCode
            || existingDerived.zip
            || ""
        ).trim(),
        phone: normalizePhone10(
            accountingEntry?.phone
            || comp?.contactPhone
            || existingDerived.phone
            || ""
        ),
    };
}

// ── Build smp block from SMP company object ───────────────────────────────────

function buildSmpBlock(comp) {
    const addr = comp.address || {};
    const owners = comp.owners || [];
    return {
        company_id: comp.id ?? null,
        create_date: String(comp.createDate || "").slice(0, 10),
        credit_limit: Math.floor(safeNum(comp.creditLimit)),
        contact_phone: String(comp.contactPhone || ""),
        address: {
            line1: String(addr.addressLine1 || "").trim(),
            line2: String(addr.addressLine2 || "").trim(),
            city:  String(addr.city || "").trim(),
            state: String(addr.state || "").trim(),
            zip:   String(addr.postalCode || "").trim(),
        },
        owners: owners.slice(0, 2).map((o) => ({
            first_name: String(o.firstName || "").trim(),
            last_name:  String(o.lastName || "").trim(),
        })),
        is_debtor: (comp.tags || []).some((t) => t.id === 1),
        tag_ids:   (comp.tags || []).map((t) => String(t.id)),
        last_synced: new Date().toISOString(),
    };
}

// ── Build zoho block from Zoho Deal object ────────────────────────────────────

function buildZohoBlock(deal) {
    const dobRaw = String(deal.Birth_Of_Date || "").trim();
    // Normalise DOB: YYYY-MM-DD → MMddYYYY (8-digit)
    let dobFormatted = "";
    if (dobRaw && !["null", "None"].includes(dobRaw)) {
        if (/^\d{4}-\d{2}-\d{2}/.test(dobRaw)) {
            dobFormatted = dobRaw.slice(5, 7) + dobRaw.slice(8, 10) + dobRaw.slice(0, 4);
        } else {
            dobFormatted = dobRaw; // already formatted or unknown
        }
    }
    return {
        deal_id:          String(deal.id || ""),
        stage:            String(deal.Stage || "Card Swiped"),
        first_name:       String(deal.First_name || "").trim(),
        last_name:        String(deal.Last_Name || "").trim(),
        address:          String(deal.Address || "").trim(),
        city:             String(deal.City || "").trim(),
        state:            String(deal.State || "").trim(),
        zip:              String(deal.Zip_Code || "").trim(),
        application_date: String(deal.Application_Date || "").trim(),
        dob_raw:          dobFormatted,
        credit_score_raw: String(deal.Credit_Score || "").trim(),
        last_synced:      new Date().toISOString(),
    };
}

// ── Compute invoiceData object expected by computeMetro2 ─────────────────────
// Now fully synchronous — uses pre-indexed maps instead of API calls.

function buildInvoiceData(cid, comp, dbEntry = {}, existingEntry = {}, invoiceIndex, billingIndex, collectionStartDate = "") {
    const today = new Date();
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const isDebtor = comp
        ? (comp.tags || []).some((t) => t.id === 1)
        : (dbEntry.debtor_sources || []).length > 0;

    let dateFirstDelinquency = "";
    let dateOfLastPayment = "";
    let dateClosed = "";
    let isClosed = false;
    const invoiceMonths      = {};
    let lastInvDate = "";
    let amountPastDue = 0;
    let actualPayment = 0;

    // ── Invoice months map (from master db) ──
    if (dbEntry) {
        for (const inv of dbEntry.invoices || []) {
            const invDt = String(inv.invoice_date || "");
            if (invDt.length >= 7) invoiceMonths[invDt.slice(0, 7)] = true;
            const payDt = String(inv.payment_date || "");
            if (payDt.length >= 7) invoiceMonths[payDt.slice(0, 7)] = true;
        }
        for (const pmKey of Object.keys(dbEntry.payment_months || {})) {
            if (String(pmKey).length >= 7) invoiceMonths[String(pmKey)] = true;
        }
        const dbDates = (dbEntry.invoices || [])
            .map((i) => String(i.invoice_date || ""))
            .filter((d) => d.length >= 10);
        if (dbDates.length) lastInvDate = dbDates.sort().reverse()[0];
    }

    // SMP invoices are the primary source of truth for invoice-driven calculations.
    const carrierInvoices = getCarrierInvoicesFromIndex(invoiceIndex, cid);
    const sortedInvoices = [...carrierInvoices].sort((a, b) =>
        String(b.dueDate || b.dateTo || b.createDate || "").localeCompare(
            String(a.dueDate || a.dateTo || a.createDate || "")
        )
    );

    for (const inv of carrierInvoices) {
        for (const raw of [inv.createDate, inv.dateFrom, inv.dateTo, inv.dueDate]) {
            const dt = String(raw || "");
            if (dt.length >= 7) invoiceMonths[dt.slice(0, 7)] = true;
            if (dt.length >= 10 && (!lastInvDate || dt.slice(0, 10) > lastInvDate)) {
                lastInvDate = dt.slice(0, 10);
            }
        }
    }

    const unpaidInvoices = sortedInvoices.filter((inv) => {
        const status = String(inv.status || "");
        const remaining = Math.max(0, safeNum(inv.totalAmount) - safeNum(inv.totalPaid));
        return ["PENDING", "PARTIALLY_PAID"].includes(status) && remaining > 0;
    });

    if (unpaidInvoices.length) {
        amountPastDue = unpaidInvoices.reduce(
            (sum, inv) => sum + Math.max(0, safeNum(inv.totalAmount) - safeNum(inv.totalPaid)),
            0
        );
    }

    // Calculate delinquency only from current CMP unpaid invoices.
    if (isDebtor && unpaidInvoices.length) {
        const oldestUnpaid = [...unpaidInvoices].sort((a, b) =>
            String(a.dueDate || a.dateTo || a.createDate || "").localeCompare(
                String(b.dueDate || b.dateTo || b.createDate || "")
            )
        )[0];
        const firstDue = String(
            oldestUnpaid?.dueDate || oldestUnpaid?.dateTo || oldestUnpaid?.createDate || ""
        );
        if (firstDue.length >= 10) {
            dateFirstDelinquency = firstDue.slice(0, 10);
        }
    }

    // Latest positive CMP transaction determines the last payment signal.
    const txns = getCarrierBillingFromGlobal(billingIndex, cid);
    for (const txn of txns) {
        const amt = safeNum(txn.amount);
        const dt = String(txn.createDate || "");
        if (amt > 0 && dt.length >= 7) {
            invoiceMonths[dt.slice(0, 7)] = true;
        }
        if (amt > 0 && dt.length >= 10) {
            dateOfLastPayment = dt.slice(0, 10);
            actualPayment = amt;
            break;
        }
    }

    // ── Closed? ──
    if (!isDebtor) {
        collectionStartDate = "";
        if (lastInvDate) {
            isClosed = new Date(lastInvDate) < fourWeeksAgo;
        } else {
            isClosed = true;
        }
        if (isClosed && dateOfLastPayment) {
            dateClosed = dateOfLastPayment;
        }
        // Fallback: most recent paid CMP invoice if there was no payment transaction.
        if (!dateClosed) {
            const paidInvoices = sortedInvoices
                .filter((inv) => String(inv.status || "") === "PAID")
                .sort((a, b) => String(b.dueDate || "").localeCompare(String(a.dueDate || "")));
            if (paidInvoices.length) {
                dateClosed = String(paidInvoices[0].dueDate || "").slice(0, 10);
            }
        }
    }

    return {
        isDebtor,
        dateFirstDelinquency,
        dateOfLastPayment,
        isClosed,
        dateClosed,
        invoiceMonths,
        lastInvDate,
        amountPastDue,
        actualPayment,
        collectionStartDate,
    };
}

function isActiveCollectionRow(row = {}) {
    const status = String(row.status || row.invoice_status || "").trim().toLowerCase();
    const remaining = safeNum(
        row.remaining_amount
        ?? row.amount_remaining
        ?? (safeNum(row.amount_submitted) - safeNum(row.amount_collected))
    );

    if (status === "paid") return false;
    return remaining > 0;
}

function deriveCollectionStartDate(ggrData, ggrSubmissionDate) {
    const activeRows = (ggrData?.ggr_invoices || []).filter((item) => isActiveCollectionRow(item));
    if (!activeRows.length) return "";

    if (String(ggrSubmissionDate || "").length >= 10) {
        return String(ggrSubmissionDate).slice(0, 10);
    }
    const invoiceDates = activeRows
        .map((item) => String(item.ggr_submission_date || item.placement_date || ""))
        .filter((value) => value.length >= 10)
        .sort();
    return invoiceDates[0] ? invoiceDates[0].slice(0, 10) : "";
}

function buildCollectionDataForCarrier(
    collectionDb = {},
    carrierCompanies = [],
    invoiceData = {},
    fallbackGgrData = null,
    fallbackSubmissionDate = null
) {
    const currentIsDebtor = Boolean(invoiceData.isDebtor);
    const lastPaymentDate = String(invoiceData.dateOfLastPayment || "").slice(0, 10);

    const matched = [];
    const seen = new Set();

    for (const company of carrierCompanies) {
        const key = normalizeCompanyKey(company);
        if (!key) continue;
        const rows = collectionDb[key] || [];
        for (const row of rows) {
            if (String(row.debtor_type || "").trim().toLowerCase() === "fraud") {
                continue;
            }
            const rowKey = `${key}:${row.invoice_number || ""}:${row.placement_date || ""}:${row.invoice_date || ""}`;
            if (seen.has(rowKey)) continue;
            seen.add(rowKey);
            matched.push(row);
        }
        if (matched.length) break;
    }

    if (!matched.length) {
        let collectionStartDate = currentIsDebtor
            ? deriveCollectionStartDate(fallbackGgrData, fallbackSubmissionDate)
            : "";
        if (collectionStartDate && lastPaymentDate && lastPaymentDate >= collectionStartDate) {
            collectionStartDate = "";
        }
        return {
            ggrData: fallbackGgrData || null,
            ggrSubmissionDate: fallbackSubmissionDate || fallbackGgrData?.ggr_submission_date || null,
            collectionStartDate,
        };
    }

    matched.sort((a, b) =>
        String(a.placement_date || a.invoice_date || "").localeCompare(
            String(b.placement_date || b.invoice_date || "")
        )
    );

    const ggrSubmissionDate = matched
        .map((row) => row.placement_date)
        .find((value) => String(value || "").length >= 10)
        || fallbackSubmissionDate
        || null;

    const ggrInvoices = matched.map((row) => ({
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date || null,
        amount_submitted: safeNum(row.total_amount),
        amount_collected: safeNum(row.total_paid),
        remaining_amount: safeNum(row.remaining_amount),
        ggr_submission_date: row.placement_date || null,
        status: row.invoice_status || "",
        comments: row.comments_billing || "",
        collections_agent: row.collections_agent || "",
        company: row.company || "",
    }));

    const totalSubmitted = ggrInvoices.reduce((sum, row) => sum + safeNum(row.amount_submitted), 0);
    const totalCollected = ggrInvoices.reduce((sum, row) => sum + safeNum(row.amount_collected), 0);
    const totalRemaining = ggrInvoices.reduce((sum, row) => sum + safeNum(row.remaining_amount), 0);
    const activeGgrInvoices = ggrInvoices.filter((row) => isActiveCollectionRow(row));
    const eligibleGgrInvoices = currentIsDebtor
        ? activeGgrInvoices.filter((row) => {
            const placementDate = String(row.ggr_submission_date || "").slice(0, 10);
            if (!placementDate || !lastPaymentDate) return true;
            return lastPaymentDate < placementDate;
        })
        : [];
    const eligibleSubmissionDate = eligibleGgrInvoices
        .map((row) => row.ggr_submission_date)
        .find((value) => String(value || "").length >= 10)
        || null;
    const collectionStartDate = deriveCollectionStartDate(
        { ggr_invoices: eligibleGgrInvoices },
        eligibleSubmissionDate
    );

    return {
        ggrData: {
            ggr_submission_date: ggrSubmissionDate,
            ggr_agent: matched.find((row) => row.collections_agent)?.collections_agent || "",
            total_submitted: Math.round(totalSubmitted * 100) / 100,
            total_collected: Math.round(totalCollected * 100) / 100,
            total_remaining: Math.round(totalRemaining * 100) / 100,
            status: totalRemaining > 0 ? "active" : "paid",
            source: "collections_dataset",
            ggr_invoices: ggrInvoices,
        },
        ggrSubmissionDate,
        collectionStartDate,
    };
}

// ── Main sync ────────────────────────────────────────────────────────────────

export async function runCarrierDbSync() {
    if (syncInProgress) {
        console.log("[carrier-db] Sync already in progress — waiting for active run.");
        return syncPromise;
    }

    syncInProgress = true;
    syncProgress = {
        phase: "starting",
        startedAt: new Date().toISOString(),
        processed: 0,
        skipped: 0,
        errors: 0,
        totalPlanned: null,
        currentCarrierId: null,
        lastHeartbeatAt: new Date().toISOString(),
    };
    syncPromise = (async () => {
        const t0 = Date.now();
        let processed = 0, skipped = 0, errors = 0;

        try {
            console.log(`[carrier-db] Sync started at ${new Date().toISOString()}`);

            // ── Step 1: Load existing carrier-db + master-db ─────────────────
            syncProgress.phase = "loading_sources";
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            const carrierDb = loadCarrierDb();
            const masterDb = loadMasterDb();
            const accountingDb = loadAccountingDb();
            const collectionDb = loadCollectionDb();
            console.log(`[carrier-db] Loaded existing: ${Object.keys(carrierDb).length} carriers`);
            console.log(`[carrier-db] Master DB: ${Object.keys(masterDb).length} carriers`);
            console.log(`[carrier-db] Accounting DB: ${Object.keys(accountingDb).length} carriers`);

            // ── Step 2: Fetch Zoho Deals (Card Swiped) ───────────────────────
            syncProgress.phase = "fetching_zoho_deals";
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            console.log("[carrier-db] Step 2: Fetching Zoho Deals...");
            await ensureZohoToken();
            const deals = await fetchDeals();
            const dealByCid = new Map();
            for (const deal of deals) {
                const cid = normCid(deal.Carrier_ID);
                if (cid) dealByCid.set(cid, deal);
            }
            console.log(`[carrier-db]   Deals: ${deals.length} (${dealByCid.size} with valid cid)`);

            // ── Step 3: Fetch SMP companies ──────────────────────────────────
            syncProgress.phase = "fetching_smp_companies";
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            console.log("[carrier-db] Step 3: Fetching SMP LOC companies (tagIds=2)...");
            const locMap = await fetchCompanies(2);
            console.log(`[carrier-db]   LOC companies: ${locMap.size}`);

            console.log("[carrier-db] Step 3b: Fetching SMP Debtor companies (tagIds=1)...");
            const debtorMap = await fetchCompanies(1);
            console.log(`[carrier-db]   Debtor companies: ${debtorMap.size}`);

            const debtorCids = new Set(debtorMap.keys());
            const allCompanies = new Map([...locMap, ...debtorMap]);
            console.log(`[carrier-db]   Total unique companies: ${allCompanies.size}`);

            // ── Step 3c: Fetch all SMP invoices globally + index ──────────
            syncProgress.phase = "fetching_smp_invoices";
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            console.log("[carrier-db] Step 3c: Fetching all SMP invoices...");
            const allInvoices = await fetchAllInvoicesGlobal();
            const invoiceIndex = indexInvoicesByCarrier(allInvoices);
            console.log(`[carrier-db]   Total invoices fetched: ${allInvoices.length} (${invoiceIndex.size} carriers)`);

            // ── Step 3d: Fetch all billing history globally + index ────────
            // Tries global endpoint first; falls back to batched per-company if API requires carrierId
            syncProgress.phase = "fetching_smp_billing";
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            console.log("[carrier-db] Step 3d: Fetching all SMP billing history...");
            const allBilling = await fetchAllBillingHistoryGlobal(allCompanies, 15);
            const billingIndex = indexBillingHistoryByCarrier(allBilling);
            console.log(`[carrier-db]   Total billing txns fetched: ${allBilling.length} (${billingIndex.size} carriers)`);

            // ── Step 4: Process union of all sources ────────────────────────
            const carrierIds = new Set([
                ...Object.keys(carrierDb),
                ...Object.keys(masterDb),
                ...Object.keys(accountingDb),
                ...dealByCid.keys(),
                ...allCompanies.keys(),
            ]);
            const orderedCarrierIds = [...carrierIds].sort((a, b) => a.localeCompare(b));
            syncProgress.phase = "processing_carriers";
            syncProgress.totalPlanned = orderedCarrierIds.length;
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            console.log(`[carrier-db] Step 4: Processing ${orderedCarrierIds.length} carriers...`);

            for (const cid of orderedCarrierIds) {
                syncProgress.currentCarrierId = cid;
                syncProgress.lastHeartbeatAt = new Date().toISOString();
                try {
                    const existingEntry = carrierDb[cid] || {};
                    const dbEntry = masterDb[cid] || {};
                    const accountingEntry = accountingDb[cid] || buildAccountingFromCachedEntry(existingEntry) || null;
                    const liveComp = allCompanies.get(cid) || null;
                    const liveDeal = dealByCid.get(cid) || null;

                    const baseComp = liveComp
                        ? {
                            ...liveComp,
                            tags: ensureDebtorTag(liveComp.tags || [], debtorCids.has(cid)),
                        }
                        : buildCompanyFromCachedEntry(cid, existingEntry);
                    const baseDeal = liveDeal || buildDealFromCachedEntry(existingEntry);
                    const { comp, deal } = applyAccountingFallbacks(baseComp, baseDeal, accountingEntry);

                    if (!comp && !deal && !Object.keys(dbEntry).length && !Object.keys(existingEntry).length && !accountingEntry) {
                        skipped++;
                        syncProgress.skipped = skipped;
                        continue;
                    }

                    const smpBlock = comp ? buildSmpBlock(comp) : (existingEntry.smp || null);
                    const zohoBlock = liveDeal ? buildZohoBlock(liveDeal) : (existingEntry.zoho || null);
                    const existingDerived = buildDefaultDerived(existingEntry);
                    const preferredContact = buildPreferredContactData(deal, accountingEntry, comp, existingDerived);
                    const nowIso = new Date().toISOString();
                    const carrierCompanies = [
                        accountingEntry?.company,
                        comp?.name,
                        dbEntry.company,
                        existingEntry.company,
                    ];

                    // ── Offline / spreadsheet data ────────────────────────
                    const billingCycle = dbEntry.billing_cycle || existingEntry.billing_cycle || "";
                    const creditScoreTss = dbEntry.credit_score || existingEntry.credit_score_tss || 0;
                    const debtorSources = dbEntry.debtor_sources || existingEntry.debtor_sources || [];
                    const debtorPeriods = dbEntry.debtor_periods || existingEntry.debtor_periods || [];
                    // ── Invoice / billing from pre-indexed maps (no API calls) ──
                    const smpInvoices = getCarrierInvoicesFromIndex(invoiceIndex, cid);
                    const smpBillingHistory = getCarrierBillingFromGlobal(billingIndex, cid);
                    const fallbackGgrData = dbEntry.ggr_data || existingEntry.ggr_data || null;
                    const fallbackGgrSubmissionDate = dbEntry.ggr_submission_date || existingEntry.ggr_submission_date || null;
                    const invoiceData = buildInvoiceData(
                        cid,
                        comp,
                        dbEntry,
                        existingEntry,
                        invoiceIndex,
                        billingIndex,
                        ""
                    );
                    const {
                        ggrData,
                        ggrSubmissionDate,
                        collectionStartDate,
                    } = buildCollectionDataForCarrier(
                        collectionDb,
                        carrierCompanies,
                        invoiceData,
                        fallbackGgrData,
                        fallbackGgrSubmissionDate
                    );
                    const earliestDelinquencyPeriodEnd =
                        dbEntry.earliest_delinquency_period_end
                        || existingEntry.earliest_delinquency_period_end
                        || null;

                    // ── Derived data recomputation (fully synchronous now) ──
                    invoiceData.collectionStartDate = collectionStartDate;
                    const metro2 = computeMetro2(cid, comp, deal, dbEntry, null, invoiceData);

                    let creditScore = metro2.highestCredit;
                    if (!creditScore && creditScoreTss) creditScore = creditScoreTss;
                    if (!creditScore && existingDerived.credit_score) {
                        creditScore = safeNum(existingDerived.credit_score);
                    }

                    carrierDb[cid] = {
                        carrier_id: cid,
                        company: accountingEntry?.company || comp?.name?.trim() || dbEntry.company || existingEntry.company || "",
                        smp: smpBlock,
                        zoho: zohoBlock,
                        accounting: accountingEntry,
                        invoices: smpInvoices.map((inv) => ({
                                invoice_number: String(inv.invoiceNumber || inv.id || ""),
                                total_amount: safeNum(inv.totalAmount),
                                total_paid: safeNum(inv.totalPaid),
                                remaining: safeNum(inv.totalAmount) - safeNum(inv.totalPaid),
                                status: inv.status || "",
                                due_date: String(inv.dueDate || "").slice(0, 10),
                                date_from: String(inv.dateFrom || "").slice(0, 10),
                                date_to: String(inv.dateTo || "").slice(0, 10),
                            })),
                        invoices_last_synced: nowIso,
                        billing_history: smpBillingHistory.slice(0, 20).map((txn) => ({
                                amount: safeNum(txn.amount),
                                create_date: String(txn.createDate || "").slice(0, 10),
                                reference: String(txn.refNum || ""),
                            })),
                        billing_last_synced: nowIso,
                        billing_cycle: billingCycle,
                        credit_score_tss: creditScoreTss,
                        debtor_sources: debtorSources,
                        debtor_periods: debtorPeriods,
                        ggr_data: ggrData,
                        ggr_submission_date: ggrSubmissionDate,
                        earliest_delinquency_period_end: earliestDelinquencyPeriodEnd,
                        derived: {
                            first_name: preferredContact.first_name,
                            last_name: preferredContact.last_name,
                            addr1: preferredContact.addr1,
                            addr2: metro2.address2 || existingDerived.addr2 || "",
                            city: preferredContact.city,
                            state: preferredContact.state,
                            zip: preferredContact.zip,
                            phone: preferredContact.phone,
                            dob: metro2.dateOfBirth || existingDerived.dob || "",
                            credit_score: String(creditScore || accountingEntry?.credit_score || existingDerived.credit_score || ""),
                            date_open: metro2.dateOpenIso || existingDerived.date_open || "",
                            date_first_delinquency: metro2.dateFirstDelinquencyIso || "",
                            date_last_payment: metro2.dateLastPaymentIso || "",
                            date_closed: metro2.dateClosedIso || "",
                            account_status: metro2.accountStatus || "11",
                            payment_history_profile: metro2.paymentHistoryProfile || "",
                            credit_limit: metro2.creditLimit ?? existingDerived.credit_limit ?? 0,
                            highest_credit: metro2.highestCredit ?? existingDerived.highest_credit ?? 0,
                            current_balance: metro2.currentBalance ?? 0,
                            amount_past_due: metro2.amountPastDue ?? 0,
                            actual_payment: metro2.actualPayment ?? 0,
                            is_debtor: invoiceData.isDebtor,
                            is_closed: invoiceData.isClosed,
                            was_former_debtor: metro2.wasFormerDebtor || existingDerived.was_former_debtor || false,
                        },
                        last_full_sync: nowIso,
                        ...(existingEntry.seeded_at ? { seeded_at: existingEntry.seeded_at } : {}),
                    };

                    processed++;
                    syncProgress.processed = processed;
                    syncProgress.skipped = skipped;
                    syncProgress.errors = errors;
                    if (processed % 50 === 0) {
                        console.log(`[carrier-db]   ... ${processed} done (skip=${skipped} err=${errors})`);
                        syncProgress.lastHeartbeatAt = new Date().toISOString();
                        await ensureZohoToken();
                    }
                } catch (err) {
                    errors++;
                    syncProgress.errors = errors;
                    syncProgress.lastHeartbeatAt = new Date().toISOString();
                    console.error(`[carrier-db] Error for carrier ${cid}:`, err.message);
                }
            }

            // ── Step 5: Save + summarize ───────────────────────────────────
            syncProgress.phase = "saving_cache";
            syncProgress.currentCarrierId = null;
            syncProgress.processed = processed;
            syncProgress.skipped = skipped;
            syncProgress.errors = errors;
            syncProgress.lastHeartbeatAt = new Date().toISOString();
            saveCarrierDb(carrierDb);

            const total = Object.keys(carrierDb).length;
            const withDob = Object.values(carrierDb).filter((c) => c.derived?.dob).length;
            const withDelinq = Object.values(carrierDb).filter((c) => c.derived?.date_first_delinquency).length;
            const isDebtors = Object.values(carrierDb).filter((c) => c.derived?.is_debtor).length;
            const withGgr = Object.values(carrierDb).filter((c) => c.ggr_data).length;
            const duration = ((Date.now() - t0) / 1000).toFixed(1);

            lastSyncResult = {
                success: true,
                processed,
                skipped,
                errors,
                totalInDb: total,
                debtors: isDebtors,
                withDob,
                withDelinquency: withDelinq,
                withGgrData: withGgr,
                duration: `${duration}s`,
                completedAt: new Date().toISOString(),
                path: CARRIER_DB_PATH,
            };
            syncProgress = {
                phase: "completed",
                startedAt: syncProgress.startedAt,
                processed,
                skipped,
                errors,
                totalPlanned: syncProgress.totalPlanned,
                currentCarrierId: null,
                lastHeartbeatAt: new Date().toISOString(),
                completedAt: lastSyncResult.completedAt,
            };

            console.log(`[carrier-db] Sync complete — ${processed} processed | ${skipped} skipped | ${errors} errors | ${duration}s`);
            console.log(`[carrier-db]   Total: ${total} | Debtors: ${isDebtors} | With DOB: ${withDob} | With delinquency: ${withDelinq}`);
            return lastSyncResult;
        } catch (err) {
            console.error("[carrier-db] Fatal sync error:", err.message);
            lastSyncResult = {
                success: false,
                error: err.message,
                completedAt: new Date().toISOString(),
            };
            syncProgress = {
                ...(syncProgress || {}),
                phase: "failed",
                currentCarrierId: syncProgress?.currentCarrierId || null,
                lastHeartbeatAt: new Date().toISOString(),
                completedAt: lastSyncResult.completedAt,
                error: err.message,
            };
            return lastSyncResult;
        } finally {
            syncInProgress = false;
            syncPromise = null;
        }
    })();

    return syncPromise;
}

// ── Read carrier-db.json (for report generation) ──────────────────────────────

export function readCarrierDb() {
    return loadCarrierDb();
}

export function getCarrierDbPath() {
    return CARRIER_DB_PATH;
}

export { getCarrierDbStatusSnapshot };
