import fs from "fs";
import { env } from "../config/env.js";

let smpToken = "";

function normalizeCarrierId(value) {
    const cid = String(value || "").trim();
    return cid && cid !== "0" ? cid : "";
}

function extractCarrierIdFromTxn(txn = {}, companyIdToCarrierId = new Map()) {
    const directCarrierId = normalizeCarrierId(
        txn.carrierId
        || txn.carrier_id
        || txn.companyCarrierId
        || txn.company?.carrierId
    );
    if (directCarrierId) return directCarrierId;

    const rawCompanyId = txn.companyId || txn.company?.id || txn.company_id;
    const companyId = String(rawCompanyId || "").trim();
    if (companyId && companyIdToCarrierId.has(companyId)) {
        return companyIdToCarrierId.get(companyId);
    }

    return "";
}

function enrichBillingTxn(txn = {}, companyIdToCarrierId = new Map()) {
    const carrierId = extractCarrierIdFromTxn(txn, companyIdToCarrierId);
    return carrierId ? { ...txn, carrierId } : txn;
}

export async function refreshSmpToken() {
    const response = await fetch(`${env.SMP_BASE_URL}/api/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: env.SMP_USERNAME,
            password: env.SMP_PASSWORD,
        }),
    });
    const data = await response.json();
    if (!data.token) {
        throw new Error(`SMP auth failed: ${JSON.stringify(data)}`);
    }
    smpToken = data.token;
    console.log("[SMP] Token refreshed.");
}

async function smpGet(path) {
    if (!smpToken) await refreshSmpToken();

    const doFetch = () =>
        fetch(`${env.SMP_BASE_URL}/api/${path}`, {
            headers: {
                Authorization: `Bearer ${smpToken}`,
                "Content-Type": "application/json",
            },
        });

    let response = await doFetch();
    if (response.status === 401 || response.status === 403) {
        await refreshSmpToken();
        response = await doFetch();
    }
    return response.json();
}

/**
 * Fetch all companies with given tagIds (paginated).
 * tagIds=2 → LOC clients, tagIds=1 → Debtor-tagged companies
 */
export async function fetchCompanies(tagIds = 2) {
    const companies = new Map();
    for (let page = 0; page <= 20; page++) {
        const data = await smpGet(
            `companies?page=${page}&size=1000&sort=createDate,desc&tagIds=${tagIds}`
        );
        const content = data.content || [];
        if (!content.length) break;

        for (const c of content) {
            const cid = String(c.carrierId || "").trim();
            if (cid && cid !== "0") companies.set(cid, c);
        }
        if (content.length < 1000) break;
    }
    return companies;
}

/**
 * Fetch ALL invoices globally (any status), paginated.
 */
export async function fetchAllInvoicesGlobal() {
    const invoices = [];
    for (let page = 0; page <= 500; page++) {
        const data = await smpGet(
            `invoices?page=${page}&size=200&sort=createDate,desc`
        );
        const content = data.content || [];
        if (!content.length) break;
        invoices.push(...content);
        if (content.length < 200) break;
    }
    return invoices;
}

/**
 * Index invoices by carrierId for O(1) lookup.
 * Call once after fetchAllInvoicesGlobal, then use getCarrierInvoicesFromIndex.
 */
export function indexInvoicesByCarrier(invoices) {
    const map = new Map();
    for (const inv of invoices) {
        const cid = String(inv.carrierId || "").trim();
        if (!cid || cid === "0") continue;
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push(inv);
    }
    // Sort each carrier's invoices by createDate desc
    for (const [, arr] of map) {
        arr.sort((a, b) => String(b.createDate || "").localeCompare(String(a.createDate || "")));
    }
    return map;
}

/**
 * Get invoices for a carrier from a pre-indexed Map. O(1) lookup.
 */
export function getCarrierInvoicesFromIndex(invoiceIndex, carrierId) {
    return invoiceIndex.get(String(carrierId)) || [];
}

/**
 * Fetch invoices for a single carrier from a preloaded global invoice list.
 * @deprecated Use indexInvoicesByCarrier + getCarrierInvoicesFromIndex instead.
 */
export function getCarrierInvoicesFromGlobal(invoices, carrierId) {
    return invoices
        .filter((invoice) => String(invoice.carrierId || "").trim() === String(carrierId))
        .sort((a, b) => String(b.createDate || "").localeCompare(String(a.createDate || "")));
}

/**
 * Fetch unpaid invoices (PENDING/PARTIALLY_PAID) for a single carrier
 * from a preloaded global invoice list.
 */
export function getCarrierUnpaidInvoicesFromGlobal(invoices, carrierId) {
    return getCarrierInvoicesFromGlobal(invoices, carrierId)
        .filter((invoice) => ["PENDING", "PARTIALLY_PAID"].includes(String(invoice.status || "")))
        .sort((a, b) => String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
}

/**
 * Fetch most recent PAID invoice.
 */
export function getCarrierLastPaidInvoiceFromGlobal(invoices, carrierId) {
    return getCarrierInvoicesFromGlobal(invoices, carrierId)
        .filter((invoice) => String(invoice.status || "") === "PAID")
        .sort((a, b) => String(b.dueDate || "").localeCompare(String(a.dueDate || "")))[0] || null;
}

// Legacy helpers kept for the older Mongo sync flow.
export async function fetchAllInvoices(carrierId) {
    const invoices = await fetchAllInvoicesGlobal();
    return getCarrierInvoicesFromGlobal(invoices, carrierId);
}

export async function fetchUnpaidInvoices(carrierId) {
    const invoices = await fetchAllInvoicesGlobal();
    return getCarrierUnpaidInvoicesFromGlobal(invoices, carrierId);
}

export async function fetchLastPaidInvoice(carrierId) {
    const invoices = await fetchAllInvoicesGlobal();
    return getCarrierLastPaidInvoiceFromGlobal(invoices, carrierId);
}

/**
 * Fetch ALL billing history globally (paginated).
 * Returns flat array of all transactions across all carriers.
 *
 * Tries the global endpoint first (/billing-history without carrierId).
 * If that returns empty (API may require carrierId), falls back to
 * batched per-company fetches using the provided companyMap.
 *
 * @param {Map<string,object>} [companyMap] — Map<carrierId, companyObj> for fallback
 * @param {number} [concurrency=15] — parallel requests for fallback mode
 */
export async function fetchAllBillingHistoryGlobal(companyMap = new Map(), concurrency = 15) {
    // ── Attempt 1: global endpoint (no carrierId filter) ──
    try {
        const firstPage = await smpGet(
            `billing-history?page=0&size=200&sort=createDate,desc`
        );
        const firstContent = firstPage.content || [];
        if (firstContent.length > 0) {
            // Global endpoint works — paginate all
            const transactions = [...firstContent];
            if (firstContent.length >= 200) {
                for (let page = 1; page <= 500; page++) {
                    const data = await smpGet(
                        `billing-history?page=${page}&size=200&sort=createDate,desc`
                    );
                    const content = data.content || [];
                    if (!content.length) break;
                    transactions.push(...content);
                    if (content.length < 200) break;
                }
            }
            console.log(`[SMP] Global billing-history returned ${transactions.length} transactions.`);
            return transactions;
        }
    } catch (err) {
        console.warn(`[SMP] Global billing-history failed: ${err.message} — using per-company fallback.`);
    }

    // ── Attempt 2: batched per-company fetches ──
    if (!companyMap.size) {
        console.warn("[SMP] No companies provided for billing-history fallback — returning empty.");
        return [];
    }

    console.log(`[SMP] Fetching billing-history per-company for ${companyMap.size} companies (concurrency=${concurrency})...`);
    const transactions = [];
    const entries = [...companyMap.entries()];

    for (let i = 0; i < entries.length; i += concurrency) {
        const batch = entries.slice(i, i + concurrency);
        const results = await Promise.allSettled(
            batch.map(async ([carrierId, comp]) => {
                const companyId = comp?.id;
                if (!companyId) return [];
                try {
                    const data = await smpGet(
                        `companies/${companyId}/billing-history?page=0&size=100&sort=createDate,desc`
                    );
                    const content = data.content || [];
                    // Tag each transaction with carrierId for indexing
                    return content.map((txn) => ({ ...txn, carrierId }));
                } catch {
                    return [];
                }
            })
        );
        for (const r of results) {
            if (r.status === "fulfilled" && r.value.length) {
                transactions.push(...r.value);
            }
        }
        if ((i + concurrency) % 150 === 0) {
            console.log(`[SMP]   ... billing-history: ${i + concurrency}/${entries.length} companies`);
        }
    }

    console.log(`[SMP] Per-company billing-history returned ${transactions.length} transactions.`);
    return transactions;
}

/**
 * Index billing-history transactions by carrierId for O(1) lookup.
 */
export function indexBillingHistoryByCarrier(transactions) {
    const map = new Map();
    for (const txn of transactions) {
        const cid = String(txn.carrierId || "").trim();
        if (!cid || cid === "0") continue;
        if (!map.has(cid)) map.set(cid, []);
        map.get(cid).push(txn);
    }
    // Keep newest first so downstream "latest payment" logic is deterministic.
    for (const [, arr] of map) {
        arr.sort((a, b) => String(b.createDate || "").localeCompare(String(a.createDate || "")));
    }
    return map;
}

/**
 * Get billing history for a single carrier from pre-indexed map.
 */
export function getCarrierBillingFromGlobal(billingMap, carrierId) {
    return billingMap.get(String(carrierId)) || [];
}

/**
 * Fetch billing history (recent transactions) via company-specific endpoint.
 * @deprecated Use fetchAllBillingHistoryGlobal + getCarrierBillingFromGlobal instead.
 */
export async function fetchBillingHistory(companyId) {
    if (!companyId) return [];

    const companyScoped = await smpGet(
        `companies/${companyId}/billing-history?page=0&size=100&sort=createDate,desc`
    );
    if (Array.isArray(companyScoped.content)) {
        return companyScoped.content;
    }

    const legacyScoped = await smpGet(
        `billing-history?page=0&size=100&sort=createDate,desc&carrierId=${companyId}`
    );
    return legacyScoped.content || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental SMP cache — split-file design
//
// Two separate files derived from the base cache path:
//   smp-data-cache.json          → legacy / invoices  (invoicesLastFetchedAt, invoices)
//   smp-data-cache-billing.json  → billing only        (billingLastFetchedAt, billing,
//                                                        billingPartialCarrierIds)
//
// Invoice cache schema:
//   { invoicesLastFetchedAt: ISO | null, invoices: { [id]: invoice } }
//
// Billing cache schema:
//   {
//     billingLastFetchedAt: ISO | null,
//     billing: { [id]: transaction },
//     billingPartialCarrierIds: string[]   // carriers already done in partial full-fetch
//   }
//
// Strategy:
//   • First run (no cache):
//       – Invoices : full paginated global fetch, saved immediately.
//       – Billing  : per-company in batches of BILLING_CONCURRENCY, with a
//         progressive save every BILLING_SAVE_INTERVAL companies so that an
//         interrupted run resumes from where it left off on the next start.
//   • Re-syncs (cache exists):
//       – Invoices : fetch pages desc, stop when every record predates lastFetchedAt
//         (72 h overlap window to catch late-arriving updates).
//       – Billing global: same early-stop approach if global endpoint works.
//       – Billing per-company: only carriers not seen in the last BILLING_REFRESH_DAYS
//         days are re-fetched; the rest are served from cache.
// ─────────────────────────────────────────────────────────────────────────────

const BILLING_CONCURRENCY    = 50;   // parallel company requests
const BILLING_SAVE_INTERVAL  = 50;   // save progress every N companies
const BILLING_REFRESH_DAYS   = 7;    // re-fetch a carrier's billing if >7 days old
const BILLING_RETAIN_MONTHS  = 26;   // only keep transactions within this many months (payment history = 24)

function billingCachePath(basePath) {
    if (!basePath) return "";
    return basePath.replace(/\.json$/i, "-billing.json");
}

function loadJsonFile(filePath, fallback) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }
    } catch {
        console.warn(`[SMP-cache] Could not read ${filePath} — starting fresh.`);
    }
    return fallback;
}

// Compact JSON (no indentation) to minimise in-memory string size during stringify.
function saveJsonFile(filePath, data) {
    if (!filePath) return;
    try {
        fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
    } catch (err) {
        console.warn(`[SMP-cache] Could not save ${filePath}: ${err.message}`);
    }
}

// Only store the 5 fields we actually use — drops 80-90 % of raw SMP payload size.
function slimBillingTxn(txn) {
    return {
        id:         txn.id,
        carrierId:  txn.carrierId,
        amount:     txn.amount,
        createDate: txn.createDate,
        refNum:     txn.refNum,
    };
}

function billingRetainCutoff() {
    const d = new Date();
    d.setMonth(d.getMonth() - BILLING_RETAIN_MONTHS);
    return d.toISOString().slice(0, 7); // "YYYY-MM"
}

// ── Invoice cache helpers ────────────────────────────────────────────────────

function loadInvoiceCache(cachePath) {
    // Support legacy single-file format (invoicesLastFetchedAt + invoices at top level)
    const data = loadJsonFile(cachePath, {});
    return {
        invoicesLastFetchedAt: data.invoicesLastFetchedAt || null,
        invoices: data.invoices || {},
    };
}

function saveInvoiceCache(cachePath, cache) {
    // Keep legacy keys in the same file so old readers still work
    const existing = loadJsonFile(cachePath, {});
    saveJsonFile(cachePath, {
        ...existing,
        invoicesLastFetchedAt: cache.invoicesLastFetchedAt,
        invoices: cache.invoices,
    });
}

// ── Billing cache helpers ────────────────────────────────────────────────────

function loadBillingCache(basePath) {
    const bPath = billingCachePath(basePath);

    // Prefer the dedicated billing file
    if (bPath && fs.existsSync(bPath)) {
        const data = loadJsonFile(bPath, {});
        return {
            billingLastFetchedAt: data.billingLastFetchedAt || null,
            billing: data.billing || {},
            billingPartialCarrierIds: new Set(data.billingPartialCarrierIds || []),
            billingCarrierFetchedAt: data.billingCarrierFetchedAt || {},
        };
    }

    // Fall back to legacy single file
    const data = loadJsonFile(basePath, {});
    return {
        billingLastFetchedAt: data.billingLastFetchedAt || null,
        billing: data.billing || {},
        billingPartialCarrierIds: new Set(),
        billingCarrierFetchedAt: {},
    };
}

function saveBillingCache(basePath, cache) {
    const bPath = billingCachePath(basePath);
    // Prune transactions older than BILLING_RETAIN_MONTHS before writing
    const cutoff = billingRetainCutoff();
    const pruned = {};
    for (const [key, txn] of Object.entries(cache.billing)) {
        if (String(txn.createDate || "") >= cutoff) pruned[key] = txn;
    }
    saveJsonFile(bPath, {
        billingLastFetchedAt: cache.billingLastFetchedAt,
        billing: pruned,
        billingPartialCarrierIds: [...cache.billingPartialCarrierIds],
        billingCarrierFetchedAt: cache.billingCarrierFetchedAt,
    });
}

// Legacy shim — kept so any external callers don't break
function loadSmpCache(cachePath) {
    const inv = loadInvoiceCache(cachePath);
    const bil = loadBillingCache(cachePath);
    return {
        invoicesLastFetchedAt: inv.invoicesLastFetchedAt,
        billingLastFetchedAt:  bil.billingLastFetchedAt,
        invoices: inv.invoices,
        billing:  bil.billing,
    };
}

function saveSmpCache(cachePath, cache) {
    saveInvoiceCache(cachePath, cache);
    saveBillingCache(cachePath, cache);
}

/**
 * Fetch all invoices using an incremental cache.
 * Full fetch on first run; incremental (72h overlap) on re-syncs.
 *
 * @param {string} cachePath - Absolute path to smp-data-cache.json
 * @returns {Promise<Array>} Full invoice list
 */
export async function fetchInvoicesIncremental(cachePath) {
    const cache = loadInvoiceCache(cachePath);
    const since = cache.invoicesLastFetchedAt || null;
    const fetchedAt = new Date().toISOString();
    const newInvoices = [];
    const overlapSince = since
        ? new Date(new Date(since).getTime() - 72 * 60 * 60 * 1000).toISOString()
        : null;

    console.log(
        since
            ? `[SMP-cache] Incremental invoice fetch — since ${since} (72h overlap)`
            : "[SMP-cache] Full invoice fetch (no cache)"
    );

    for (let page = 0; page <= 500; page++) {
        const data = await smpGet(`invoices?page=${page}&size=200&sort=createDate,desc`);
        const content = data.content || [];
        if (!content.length) break;

        if (overlapSince) {
            const hasNew = content.some((inv) => String(inv.createDate || "") >= overlapSince);
            if (!hasNew) break;
            newInvoices.push(...content.filter((inv) => String(inv.createDate || "") >= overlapSince));
        } else {
            newInvoices.push(...content);
        }

        if (content.length < 200) break;
    }

    for (const inv of newInvoices) {
        const key = String(inv.id || inv.invoiceId || "");
        if (key) cache.invoices[key] = inv;
    }
    cache.invoicesLastFetchedAt = fetchedAt;
    saveInvoiceCache(cachePath, cache);

    const all = Object.values(cache.invoices);
    console.log(`[SMP-cache] Invoices — ${newInvoices.length} new/updated, ${all.length} total`);
    return all;
}

/**
 * Fetch all billing-history using a split incremental cache.
 *
 * First run  : per-company with concurrency 50, progressive save every 50 companies,
 *              resume from partial if a previous run was interrupted.
 * Re-syncs   : global endpoint with early-stop; falls back to per-company only for
 *              carriers not fetched within the last BILLING_REFRESH_DAYS days.
 *
 * @param {string} cachePath  - Base path (smp-data-cache.json)
 * @param {Map}    companyMap - Map<carrierId, companyObj> for per-company fallback
 * @param {number} [_concurrency] - Ignored; uses BILLING_CONCURRENCY constant
 * @returns {Promise<Array>} Full billing transaction list
 */
export async function fetchBillingIncremental(cachePath, companyMap = new Map(), _concurrency) {
    const cache = loadBillingCache(cachePath);
    const since = cache.billingLastFetchedAt || null;
    const fetchedAt = new Date().toISOString();
    const companyIdToCarrierId = new Map(
        [...companyMap.entries()]
            .filter(([, comp]) => comp?.id)
            .map(([carrierId, comp]) => [String(comp.id), String(carrierId)])
    );

    const isFullFetch = !since;
    const isResume = isFullFetch && cache.billingPartialCarrierIds.size > 0;

    console.log(
        isResume
            ? `[SMP-cache] Resuming full billing fetch (${cache.billingPartialCarrierIds.size} carriers already done)`
            : since
                ? `[SMP-cache] Incremental billing fetch — since ${since}`
                : "[SMP-cache] Full billing fetch (no cache)"
    );

    // ── Attempt global endpoint ──────────────────────────────────────────────
    let usedGlobal = false;
    try {
        const firstPage = await smpGet(`billing-history?page=0&size=200&sort=createDate,desc`);
        const firstContent = firstPage.content || [];

        if (firstContent.length > 0) {
            usedGlobal = true;
            const newTxns = [];

            const processPage = (content) => {
                const enriched = content.map((t) => enrichBillingTxn(t, companyIdToCarrierId));
                if (since) {
                    const hasNew = enriched.some((t) => String(t.createDate || "") >= since);
                    if (!hasNew) return false;
                    newTxns.push(...enriched.filter((t) => String(t.createDate || "") >= since));
                } else {
                    newTxns.push(...enriched);
                }
                return true;
            };

            if (processPage(firstContent) && firstContent.length >= 200) {
                for (let page = 1; page <= 500; page++) {
                    const data = await smpGet(`billing-history?page=${page}&size=200&sort=createDate,desc`);
                    const content = data.content || [];
                    if (!content.length) break;
                    if (!processPage(content)) break;
                    if (content.length < 200) break;
                }
            }

            const cutoffGlobal = billingRetainCutoff();
            for (const txn of newTxns) {
                const key = String(txn.id || "");
                if (key && String(txn.createDate || "") >= cutoffGlobal) {
                    cache.billing[key] = slimBillingTxn(txn);
                }
            }
            cache.billingLastFetchedAt = fetchedAt;
            cache.billingPartialCarrierIds = new Set();
            saveBillingCache(cachePath, cache);

            const all = Object.values(cache.billing);
            console.log(`[SMP-cache] Billing (global) — ${newTxns.length} new/updated, ${all.length} total`);
            return all;
        }
    } catch (err) {
        console.warn(`[SMP-cache] Global billing endpoint failed: ${err.message} — using per-company fallback`);
    }

    // ── Per-company fallback ─────────────────────────────────────────────────
    if (!companyMap.size) {
        console.warn("[SMP-cache] No companies available for billing fallback — returning cached data.");
        return Object.values(cache.billing);
    }

    // On incremental runs, skip carriers fetched within BILLING_REFRESH_DAYS
    const cutoff = since
        ? new Date(new Date(since).getTime() - BILLING_REFRESH_DAYS * 86400000).toISOString()
        : null;

    const entries = [...companyMap.entries()].filter(([carrierId]) => {
        // Resume: skip carriers already completed in a partial full-fetch
        if (cache.billingPartialCarrierIds.has(carrierId)) return false;
        // Incremental: skip carriers refreshed recently
        if (cutoff && (cache.billingCarrierFetchedAt[carrierId] || "") >= cutoff) return false;
        return true;
    });

    const totalToFetch = entries.length;
    const skipped = companyMap.size - totalToFetch;
    console.log(
        `[SMP-cache] Per-company billing: ${totalToFetch} to fetch, ${skipped} skipped (cache fresh / already done)`
    );

    let fetched = 0;
    for (let i = 0; i < entries.length; i += BILLING_CONCURRENCY) {
        const batch = entries.slice(i, i + BILLING_CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(async ([carrierId, comp]) => {
                const companyId = comp?.id;
                if (!companyId) return { carrierId, txns: [] };
                try {
                    const txns = [];
                    const maxPages = since ? 50 : 200;
                    for (let page = 0; page <= maxPages; page++) {
                        const data = await smpGet(
                            `companies/${companyId}/billing-history?page=${page}&size=100&sort=createDate,desc`
                        );
                        const content = (data.content || []).map((t) => ({ ...t, carrierId }));
                        if (!content.length) break;

                        if (since) {
                            const hasNew = content.some((t) => String(t.createDate || "") >= since);
                            if (!hasNew) break;
                            txns.push(...content.filter((t) => String(t.createDate || "") >= since));
                        } else {
                            txns.push(...content);
                        }

                        if (content.length < 100) break;
                    }
                    return { carrierId, txns };
                } catch {
                    return { carrierId, txns: [] };
                }
            })
        );

        for (const r of results) {
            if (r.status !== "fulfilled") continue;
            const { carrierId, txns } = r.value;
            const cutoffPerCo = billingRetainCutoff();
            for (const txn of txns) {
                const key = String(txn.id || "");
                if (key && String(txn.createDate || "") >= cutoffPerCo) {
                    cache.billing[key] = slimBillingTxn(txn);
                }
            }
            cache.billingCarrierFetchedAt[carrierId] = fetchedAt;
            if (isFullFetch) cache.billingPartialCarrierIds.add(carrierId);
            fetched++;
        }

        // Progressive save every BILLING_SAVE_INTERVAL companies
        if (fetched % BILLING_SAVE_INTERVAL === 0 || i + BILLING_CONCURRENCY >= entries.length) {
            saveBillingCache(cachePath, cache);
            console.log(`[SMP-cache]   ... billing: ${fetched}/${totalToFetch} companies saved`);
        }
    }

    // Full fetch complete — clear partial-progress marker and stamp the timestamp
    if (isFullFetch) {
        cache.billingPartialCarrierIds = new Set();
    }
    cache.billingLastFetchedAt = fetchedAt;
    saveBillingCache(cachePath, cache);

    const all = Object.values(cache.billing);
    console.log(`[SMP-cache] Billing (per-company) — ${fetched} carriers fetched, ${all.length} total in cache`);
    return all;
}
