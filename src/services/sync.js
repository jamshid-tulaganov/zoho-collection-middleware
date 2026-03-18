/**
 * Full sync orchestrator.
 * Port of scripts/run-full-sync.py — fetches all LOC clients from SMP,
 * matches with Zoho CRM Deals, reads from MongoDB tables (Carrier, Invoice,
 * DebtorPeriod, PaymentMonth), computes Metro 2 fields, and upserts into
 * the Client (Metro2Records) collection.
 *
 * Data source priority:
 *   1. MongoDB tables (populated by POST /sync/import-master-db)
 *   2. debtor-master-db.json file (fallback if MongoDB is empty)
 */
import fs from "fs";
import path from "path";

import { env } from "../config/env.js";
import { isDatabaseReady } from "../config/db.js";
import Client from "../models/Client.js";
import Carrier from "../models/Carrier.js";
import Invoice from "../models/Invoice.js";
import DebtorPeriod from "../models/DebtorPeriod.js";
import PaymentMonth from "../models/PaymentMonth.js";
import Transaction from "../models/Transaction.js";
import { fetchCompanies, fetchAllInvoices, fetchUnpaidInvoices, fetchBillingHistory } from "./smp.js";
import { fetchDeals, fetchExistingStation, ensureZohoToken } from "./zoho.js";
import { computeMetro2, parseDate } from "./metro2.js";

let lastSyncResult = null;
let syncInProgress = false;

export function getSyncStatus() {
    return { inProgress: syncInProgress, lastResult: lastSyncResult };
}

// ── Load carrier data from MongoDB or JSON fallback ──

/**
 * Build a dbEntry object for a carrier from MongoDB tables.
 * Returns the same shape as a debtor-master-db.json entry.
 */
async function loadCarrierFromDb(cid) {
    const [carrier, invoices, periods, months] = await Promise.all([
        Carrier.findOne({ carrierId: cid }).lean(),
        Invoice.find({ carrierId: cid }).lean(),
        DebtorPeriod.find({ carrierId: cid }).lean(),
        PaymentMonth.find({ carrierId: cid }).lean(),
    ]);

    if (!carrier) return null;

    // Reconstruct the shape expected by computeInvoiceData / computeMetro2
    const paymentMonths = {};
    for (const pm of months) {
        paymentMonths[pm.yearMonth] = {
            total_invoiced: pm.totalInvoiced,
            total_paid: pm.totalPaid,
            unpaid_count: pm.unpaidCount,
        };
    }

    return {
        carrier_id: carrier.carrierId,
        company: carrier.company,
        billing_cycle: carrier.billingCycle,
        credit_score: carrier.creditScore,
        debtor_sources: carrier.debtorSources,
        debtor_periods: periods.map((dp) => ({
            source: dp.source,
            period: dp.period,
            period_start: dp.periodStart,
            period_end: dp.periodEnd,
            amount: dp.amount,
            amount_collected: dp.amountCollected,
        })),
        earliest_delinquency_period_end: carrier.earliestDelinquencyPeriodEnd,
        invoices: invoices.map((inv) => ({
            invoice_date: inv.invoiceDate,
            invoice_number: inv.invoiceNumber,
            invoice_amount: inv.invoiceAmount,
            opening_balance: inv.openingBalance,
            payment_date: inv.paymentDate,
            payment_amount: inv.paymentAmount,
            ending_balance: inv.endingBalance,
            source: inv.source,
        })),
        payment_months: paymentMonths,
        total_debt: carrier.totalDebt,
        total_collected: carrier.totalCollected,
    };
}

/**
 * Load the master DB: prefer MongoDB tables, fall back to JSON file.
 * Returns a function that fetches a single carrier's dbEntry.
 */
async function createDbLoader() {
    // Check if MongoDB has carriers imported
    if (isDatabaseReady()) {
        const count = await Carrier.countDocuments();
        if (count > 0) {
            console.log(`[sync] Using MongoDB tables (${count} carriers in DB)`);
            return {
                source: "mongodb",
                count,
                getEntry: (cid) => loadCarrierFromDb(cid),
                getDebtorCids: async () => {
                    const debtors = await Carrier.find({ isDebtor: true }).select("carrierId").lean();
                    return new Set(debtors.map((d) => d.carrierId));
                },
            };
        }
    }

    // Fallback: load JSON file
    const dbPath = path.resolve(env.MASTER_DB_PATH);
    if (!fs.existsSync(dbPath)) {
        console.warn(`[sync] No MongoDB data and no debtor-master-db.json at ${dbPath}`);
        return {
            source: "empty",
            count: 0,
            getEntry: () => null,
            getDebtorCids: async () => new Set(),
        };
    }

    const raw = fs.readFileSync(dbPath, "utf-8");
    const data = JSON.parse(raw);
    console.log(`[sync] Using debtor-master-db.json (${Object.keys(data).length} carriers)`);
    return {
        source: "json-file",
        count: Object.keys(data).length,
        getEntry: async (cid) => data[cid] || null,
        getDebtorCids: async () => new Set(
            Object.entries(data)
                .filter(([, e]) => e.debtor_sources && e.debtor_sources.length > 0)
                .map(([cid]) => cid)
        ),
    };
}

/**
 * Store live SMP company + Deal data into the Carrier table,
 * and SMP invoices + transactions into their own tables.
 */
async function storeLiveData(cid, comp, deal) {
    if (!isDatabaseReady()) return;

    // Update Carrier with live SMP company fields + Deal fields
    const carrierUpdate = { lastSmpSync: new Date() };

    if (comp) {
        carrierUpdate.company = (comp.name || "").trim();
        carrierUpdate.contractId = comp.contractId || null;
        carrierUpdate.balance = comp.balance || 0;
        carrierUpdate.debtAmount = comp.debtAmount || 0;
        carrierUpdate.creditLimit = comp.creditLimit || 0;
        carrierUpdate.creditScore = comp.creditScore || 0;
        carrierUpdate.billingCycle = comp.billingCycle || "";
        carrierUpdate.feesType = comp.feesType || "";
        carrierUpdate.contactEmail = comp.contactEmail || "";
        carrierUpdate.contactPhone = comp.contactPhone || "";
        carrierUpdate.mcDotNumber = comp.mcDotNumber || "";
        carrierUpdate.agent = comp.agent || "";
        carrierUpdate.smpCreateDate = comp.createDate || "";
        carrierUpdate.smpTagIds = (comp.tags || []).map((t) => t.id);

        const addr = comp.address || {};
        carrierUpdate.addressLine1 = (addr.addressLine1 || "").trim();
        carrierUpdate.addressLine2 = (addr.addressLine2 || "").trim();
        carrierUpdate.city = (addr.city || "").trim();
        carrierUpdate.state = (addr.state || "").trim();
        carrierUpdate.postalCode = (addr.postalCode || "").trim();

        const owners = comp.owners || [];
        if (owners.length) {
            carrierUpdate.ownerFirstName = (owners[0].firstName || "").trim();
            carrierUpdate.ownerLastName = (owners[0].lastName || "").trim();
        }
    }

    if (deal) {
        carrierUpdate.dealFirstName = (deal.First_name || "").trim();
        carrierUpdate.dealLastName = (deal.Last_Name || "").trim();
        carrierUpdate.dealAddress = (deal.Address || "").trim();
        carrierUpdate.dealCity = (deal.City || "").trim();
        carrierUpdate.dealState = (deal.State || "").trim();
        carrierUpdate.dealZipCode = (deal.Zip_Code || "").trim();
        carrierUpdate.dealBirthOfDate = String(deal.Birth_Of_Date || "").trim();
        carrierUpdate.dealCreditScore = String(deal.Credit_Score || "").trim();
        carrierUpdate.dealApplicationDate = String(deal.Application_Date || "").trim();
        carrierUpdate.lastDealSync = new Date();
    }

    await Carrier.findOneAndUpdate(
        { carrierId: cid },
        { $set: carrierUpdate },
        { upsert: true }
    );

    // Store SMP invoices (all statuses)
    try {
        const smpInvoices = await fetchAllInvoices(cid);
        if (smpInvoices.length) {
            // Remove old SMP invoices for this carrier, keep spreadsheet ones
            await Invoice.deleteMany({ carrierId: cid, source: "smp" });
            const docs = smpInvoices.map((inv) => ({
                carrierId: cid,
                source: "smp",
                smpInvoiceId: String(inv.id || ""),
                invoiceNumber: String(inv.invoiceNumber || inv.id || ""),
                status: inv.status || "",
                totalAmount: inv.totalAmount || 0,
                totalPaid: inv.totalPaid || 0,
                dateFrom: (inv.dateFrom || "").slice(0, 10),
                dateTo: (inv.dateTo || "").slice(0, 10),
                dueDate: (inv.dueDate || "").slice(0, 10),
                createDate: inv.createDate || "",
                invoiceDate: (inv.createDate || "").slice(0, 10),
                invoiceAmount: inv.totalAmount || 0,
            }));
            await Invoice.insertMany(docs, { ordered: false });
        }
    } catch { /* ignore invoice storage errors */ }

    // Store SMP transactions (billing-history)
    try {
        const txns = await fetchBillingHistory(cid);
        if (txns.length) {
            await Transaction.deleteMany({ carrierId: cid });
            const docs = txns.map((txn) => ({
                carrierId: cid,
                refNum: txn.refNum || "",
                companyName: txn.companyName || "",
                contractId: txn.contractId || "",
                amount: txn.amount || 0,
                balanceBefore: txn.balanceBefore || 0,
                balanceAfter: txn.balanceAfter || 0,
                createDate: txn.createDate || "",
            }));
            await Transaction.insertMany(docs, { ordered: false });
        }
    } catch { /* ignore transaction storage errors */ }
}

/**
 * Compute invoice-related data for a single carrier.
 * Mirrors run-full-sync.py lines 223-384.
 */
async function computeInvoiceData(cid, comp, dbEntry) {
    const today = new Date();
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const isDebtor = comp
        ? (comp.tags || []).some((t) => t.id === 1)
        : false;

    let dateFirstDelinquency = "";
    let dateClosed = "";
    let dateOfLastPayment = "";
    let isClosed = false;

    // Build invoice months map
    const invoiceMonths = {};
    let lastInvDate = "";

    // From master DB entry
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
        const dbInvoices = dbEntry.invoices || [];
        if (dbInvoices.length) {
            const dates = dbInvoices.map((i) => String(i.invoice_date || "")).filter((d) => d.length >= 10);
            if (dates.length) lastInvDate = dates.sort().reverse()[0];
        }
    }

    // Supplement from SMP API
    try {
        const allInv = await fetchAllInvoices(cid);
        for (const inv of allInv) {
            const createRaw = String(inv.createDate || "");
            if (createRaw.length >= 7) {
                invoiceMonths[createRaw.slice(0, 7)] = true;
                if (!lastInvDate && createRaw.length >= 10) {
                    lastInvDate = createRaw.slice(0, 10);
                }
            }
        }
    } catch { /* ignore */ }

    // ── Date of First Delinquency ──
    if (isDebtor && dbEntry) {
        // Priority 1: earliest_delinquency_period_end + 1 day
        const edpe = dbEntry.earliest_delinquency_period_end;
        if (edpe && String(edpe).length >= 10) {
            try {
                const d = new Date(edpe);
                d.setDate(d.getDate() + 1);
                dateFirstDelinquency = d.toISOString().slice(0, 10);
            } catch { /* ignore */ }
        }

        // Priority 2: unpaid invoices
        if (!dateFirstDelinquency) {
            const unpaidDates = [];
            for (const inv of dbEntry.invoices || []) {
                if (!inv.payment_date) {
                    const invDt = String(inv.invoice_date || "");
                    if (invDt.length >= 10) {
                        const d = parseDate(invDt);
                        if (d) unpaidDates.push(new Date(`${d.iso}T00:00:00Z`));
                    }
                }
            }
            if (unpaidDates.length) {
                const earliest = new Date(Math.min(...unpaidDates.map((d) => d.getTime())));
                const pyWeekday = (earliest.getUTCDay() + 6) % 7;
                const dToSun = 6 - pyWeekday;
                const periodEnd = new Date(earliest);
                periodEnd.setUTCDate(periodEnd.getUTCDate() + dToSun);
                const delinq = new Date(periodEnd);
                delinq.setUTCDate(delinq.getUTCDate() + 1);
                dateFirstDelinquency = delinq.toISOString().slice(0, 10);
            }
        }
    }

    // Priority 3: SMP API fallback
    if (isDebtor && !dateFirstDelinquency) {
        try {
            const unpaid = await fetchUnpaidInvoices(cid);
            if (unpaid.length) {
                const firstDue = String(unpaid[0].dueDate || "");
                if (firstDue.length >= 10) {
                    dateFirstDelinquency = firstDue.slice(0, 10);
                }
            }
        } catch { /* ignore */ }
    }

    // ── Last payment date ──
    if (dbEntry) {
        const paidDates = (dbEntry.invoices || [])
            .map((inv) => String(inv.payment_date || ""))
            .filter((d) => d.length >= 10)
            .map((d) => d.slice(0, 10))
            .sort()
            .reverse();
        if (paidDates.length) dateOfLastPayment = paidDates[0];
    }

    if (!dateOfLastPayment) {
        try {
            const txns = await fetchBillingHistory(cid);
            for (const txn of txns) {
                const amt = Number(txn.amount || 0);
                const txnDate = String(txn.createDate || "");
                if (amt > 0 && txnDate.length >= 10) {
                    dateOfLastPayment = txnDate.slice(0, 10);
                    break;
                }
            }
        } catch { /* ignore */ }
    }

    // ── Closed check ──
    if (!isDebtor) {
        if (lastInvDate) {
            const lid = new Date(lastInvDate);
            if (lid < fourWeeksAgo) isClosed = true;
        } else {
            isClosed = true;
        }
        if (isClosed && dateOfLastPayment) {
            dateClosed = dateOfLastPayment;
        }
    }

    return { isDebtor, dateFirstDelinquency, dateOfLastPayment, isClosed, dateClosed, invoiceMonths, lastInvDate };
}

/**
 * Run the full sync: SMP → Zoho → MongoDB/JSON → Metro 2 → Client collection.
 */
export async function runFullSync() {
    if (syncInProgress) {
        console.log("[sync] Already in progress, skipping.");
        return lastSyncResult;
    }

    syncInProgress = true;
    const startTime = Date.now();
    let processed = 0, skipped = 0, errors = 0;

    try {
        console.log(`[sync] Starting full sync at ${new Date().toISOString()}`);

        // Initialize data loader (MongoDB → JSON fallback)
        const loader = await createDbLoader();

        // Step 1: Fetch LOC companies from SMP (tagIds=2)
        console.log("[sync] Step 1: Fetching LOC companies (tagIds=2)...");
        const companyMap = await fetchCompanies(2);
        console.log(`[sync]   LOC companies: ${companyMap.size}`);

        // Step 2: Fetch Card Swiped deals from Zoho
        console.log("[sync] Step 2: Fetching Card Swiped deals...");
        await ensureZohoToken();
        const deals = await fetchDeals();
        console.log(`[sync]   Deals: ${deals.length}`);

        // Step 3: Process each deal/carrier
        console.log(`[sync] Step 3: Processing carriers (data source: ${loader.source})...`);

        for (const deal of deals) {
            const cid = String(deal.Carrier_ID || "").trim();
            if (!cid || ["None", "0", "null"].includes(cid)) { skipped++; continue; }

            const comp = companyMap.get(cid);
            if (!comp) { skipped++; continue; }

            const companyName = (comp.name || "").trim();
            if (!companyName) { skipped++; continue; }

            try {
                // Store live SMP + Deal data into separate tables
                await storeLiveData(cid, comp, deal);

                // Load carrier data from MongoDB tables or JSON
                const dbEntry = await loader.getEntry(cid) || {};

                const invoiceData = await computeInvoiceData(cid, comp, dbEntry);

                let existing = null;
                try { existing = await fetchExistingStation(cid); } catch { /* ignore */ }

                const record = computeMetro2(cid, comp, deal, dbEntry, existing, invoiceData);
                record.syncSource = "full-sync";

                if (isDatabaseReady()) {
                    await Client.findOneAndUpdate(
                        { clientId: cid },
                        { $set: record },
                        { upsert: true }
                    );
                }

                processed++;
                if (processed % 50 === 0) {
                    console.log(`[sync]   ... ${processed} processed (skip=${skipped})`);
                }

                await ensureZohoToken();
            } catch (err) {
                errors++;
                console.error(`[sync] Error processing carrier ${cid}:`, err.message);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        lastSyncResult = {
            success: true,
            type: "full-sync",
            dataSource: loader.source,
            processed, skipped, errors,
            totalCompanies: companyMap.size,
            totalDeals: deals.length,
            masterDbSize: loader.count,
            duration: `${duration}s`,
            completedAt: new Date().toISOString(),
        };

        console.log(`[sync] Done. Processed=${processed} | Skipped=${skipped} | Errors=${errors} | Duration=${duration}s`);
        return lastSyncResult;
    } catch (err) {
        console.error("[sync] Fatal error:", err.message);
        lastSyncResult = { success: false, error: err.message, processed, skipped, errors, completedAt: new Date().toISOString() };
        return lastSyncResult;
    } finally {
        syncInProgress = false;
    }
}

/**
 * Run debtor-only sync: targets real debtors from TSS Debtor List sheets.
 */
export async function runDebtorSync() {
    if (syncInProgress) {
        console.log("[sync] Already in progress, skipping.");
        return lastSyncResult;
    }

    syncInProgress = true;
    const startTime = Date.now();
    let processed = 0, skipped = 0, errors = 0;

    try {
        console.log(`[sync] Starting debtor sync at ${new Date().toISOString()}`);

        const loader = await createDbLoader();
        const targetCids = await loader.getDebtorCids();
        console.log(`[sync] Target debtors: ${targetCids.size} (source: ${loader.source})`);

        const companyMap = await fetchCompanies(1);
        console.log(`[sync] CMP debtors (tagIds=1): ${companyMap.size}`);

        await ensureZohoToken();
        const deals = await fetchDeals();
        const dealByCid = new Map();
        for (const d of deals) {
            const dcid = String(d.Carrier_ID || "").trim();
            if (dcid && !["None", "0", "null"].includes(dcid)) dealByCid.set(dcid, d);
        }
        console.log(`[sync] Deals: ${deals.length}`);

        for (const cid of [...targetCids].sort()) {
            const comp = companyMap.get(cid) || null;
            const deal = dealByCid.get(cid) || null;
            const dbEntry = await loader.getEntry(cid) || {};

            let companyName = comp ? (comp.name || "").trim() : "";
            if (!companyName) companyName = (dbEntry.company || "").trim();
            if (!companyName) { skipped++; continue; }

            try {
                // Store live data into separate tables
                await storeLiveData(cid, comp, deal);

                const invoiceData = await computeInvoiceData(cid, comp, dbEntry);
                invoiceData.isDebtor = true;

                let existing = null;
                try { existing = await fetchExistingStation(cid); } catch { /* ignore */ }

                const record = computeMetro2(cid, comp, deal, dbEntry, existing, invoiceData);
                record.syncSource = "debtor-sync";

                if (isDatabaseReady()) {
                    await Client.findOneAndUpdate(
                        { clientId: cid },
                        { $set: record },
                        { upsert: true }
                    );
                }

                processed++;
                if (processed % 50 === 0) {
                    console.log(`[sync]   ... ${processed} processed (skip=${skipped})`);
                }
                await ensureZohoToken();
            } catch (err) {
                errors++;
                console.error(`[sync] Error processing debtor ${cid}:`, err.message);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        lastSyncResult = {
            success: true, type: "debtor-sync", dataSource: loader.source,
            processed, skipped, errors, targetDebtors: targetCids.size,
            duration: `${duration}s`, completedAt: new Date().toISOString(),
        };

        console.log(`[sync] Debtor sync done. Processed=${processed} | Skipped=${skipped} | Errors=${errors}`);
        return lastSyncResult;
    } catch (err) {
        console.error("[sync] Fatal error:", err.message);
        lastSyncResult = { success: false, error: err.message, completedAt: new Date().toISOString() };
        return lastSyncResult;
    } finally {
        syncInProgress = false;
    }
}
