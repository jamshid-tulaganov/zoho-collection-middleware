import fs from "fs";
import { env } from "../config/env.js";

let smpToken = "";
// Serialises concurrent token refreshes: if 50 workers all hit 401 at the same
// time, only one actual auth request is made; the other 49 await the same promise.
let _refreshPromise = null;

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

async function smpRefreshOnce() {
    if (!_refreshPromise) {
        _refreshPromise = refreshSmpToken().finally(() => { _refreshPromise = null; });
    }
    return _refreshPromise;
}

async function smpGet(path) {
    if (!smpToken) await smpRefreshOnce();

    const doFetch = () =>
        fetch(`${env.SMP_BASE_URL}/api/${path}`, {
            headers: {
                Authorization: `Bearer ${smpToken}`,
                "Content-Type": "application/json",
            },
        });

    let response = await doFetch();
    if (response.status === 401 || response.status === 403) {
        // Serialised: all concurrent workers share one refresh, not 50 parallel ones
        await smpRefreshOnce();
        response = await doFetch();
    }
    return response.json();
}

/**
 * True N-way concurrent work pool.
 *
 * Unlike Promise.allSettled batching (which idles N-1 workers while waiting for
 * the slowest in the batch), this pool immediately assigns the next item to any
 * worker that becomes free.  Throughput approaches (N_items × avg_latency) / concurrency
 * regardless of per-item variance.
 *
 * JavaScript's single-threaded event loop makes `cursor++` atomic — no mutex needed.
 *
 * @param {Array}    items
 * @param {number}   concurrency
 * @param {Function} fn  async (item, index) => result
 * @returns {Promise<Array>}
 */
async function workPool(items, concurrency, fn) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch (err) {
                results[i] = { _poolError: err.message };
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
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
const BILLING_RETAIN_MONTHS  = 6;    // only keep transactions within last 6 months (dateOfLastPayment + close detection)

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
        carrierId:  txn.carrierId,
        amount:     txn.amount,
        createDate: txn.createDate,
        refNum:     txn.refNum,
    };
}

// Derive a stable unique key for a billing transaction.
// The API does not return an `id` field — use refNum, fall back to a composite.
function billingTxnKey(txn) {
    const ref = String(txn.refNum || "").trim();
    if (ref) return ref;
    return `${txn.carrierId || ""}_${txn.contractId || ""}_${String(txn.createDate || "").slice(0, 19)}`;
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
            billingLastPaymentDate: data.billingLastPaymentDate || {},
        };
    }

    // Fall back to legacy single file
    const data = loadJsonFile(basePath, {});
    return {
        billingLastFetchedAt: data.billingLastFetchedAt || null,
        billing: data.billing || {},
        billingPartialCarrierIds: new Set(),
        billingCarrierFetchedAt: {},
        billingLastPaymentDate: {},
    };
}

function saveBillingCache(basePath, cache) {
    const bPath = billingCachePath(basePath);
    // Prune transactions older than 26 months to prevent unbounded cache growth
    const cutoff = billingRetainCutoff();
    const billing = cache.billing;
    let pruned = 0;
    for (const key of Object.keys(billing)) {
        const d = String(billing[key].createDate || "").slice(0, 7);
        if (d && d < cutoff) { delete billing[key]; pruned++; }
    }
    if (pruned > 0) console.log(`[smp] Pruned ${pruned} billing transactions older than ${cutoff}`);
    saveJsonFile(bPath, {
        billingLastFetchedAt: cache.billingLastFetchedAt,
        billing,
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

    // Stamp stage onto invoices — bulk endpoint doesn't return stage
    await stampInvoiceStages(cache);

    saveInvoiceCache(cachePath, cache);

    const all = Object.values(cache.invoices);
    console.log(`[SMP-cache] Invoices — ${newInvoices.length} new/updated, ${all.length} total`);
    return all;
}

/**
 * Fetch all invoice IDs for a given stage (e.g. PAYMENT_ISSUES, DEBTORS).
 * Returns a Set of invoice IDs belonging to that stage.
 */
async function fetchInvoiceIdsByStage(stage) {
    const ids = new Set();
    for (let page = 0; page <= 500; page++) {
        const data = await smpGet(`invoices?page=${page}&size=200&sort=createDate,desc&stage=${stage}`);
        const content = data.content || [];
        if (!content.length) break;
        for (const inv of content) {
            const key = String(inv.id || inv.invoiceId || "");
            if (key) ids.add(key);
        }
        if (content.length < 200) break;
    }
    return ids;
}

/**
 * Stamp stage field onto cached invoices by fetching PAYMENT_ISSUES and DEBTORS stage endpoints.
 * The bulk invoice endpoint does not return stage, so we fetch each stage separately
 * and mark matching invoice IDs.
 *
 * @param {Object} cache - The invoice cache object (cache.invoices keyed by id)
 */
export async function stampInvoiceStages(cache) {
    console.log("[SMP-cache] Fetching invoice stages (PAYMENT_ISSUES, DEBTORS)...");
    const [paymentIssueIds, debtorIds] = await Promise.all([
        fetchInvoiceIdsByStage("PAYMENT_ISSUES"),
        fetchInvoiceIdsByStage("DEBTORS"),
    ]);
    // Clear existing stage stamps — stage can change between syncs
    for (const inv of Object.values(cache.invoices)) {
        inv.stage = "";
    }
    for (const id of paymentIssueIds) {
        if (cache.invoices[id]) cache.invoices[id].stage = "PAYMENT_ISSUES";
    }
    for (const id of debtorIds) {
        if (cache.invoices[id]) cache.invoices[id].stage = "DEBTORS";
    }
    console.log(`[SMP-cache] Stages stamped — PAYMENT_ISSUES: ${paymentIssueIds.size}, DEBTORS: ${debtorIds.size}`);
}

/**
 * Fetch recent billing history per-company (1 page each = latest 200 txns).
 *
 * We only need the most recent transactions per carrier for:
 *   - dateOfLastPayment (latest positive txn)
 *   - hasCmpActivity (boolean)
 *   - billing_history in carrier-db (top 20)
 *
 * Skips carriers already fetched within BILLING_REFRESH_DAYS.
 *
 * @param {string} cachePath  - Base path (smp-data-cache.json)
 * @param {Map}    companyMap - Map<carrierId, companyObj>
 * @returns {Promise<Array>} Billing transaction list
 */
export async function fetchBillingIncremental(cachePath, companyMap = new Map()) {
    const cache = loadBillingCache(cachePath);
    const since = cache.billingLastFetchedAt || null;
    const fetchedAt = new Date().toISOString();

    if (!companyMap.size) {
        console.warn("[SMP-cache] No companies available for billing — returning cached data.");
        return Object.values(cache.billing);
    }

    // Skip carriers fetched within BILLING_REFRESH_DAYS
    const staleCutoff = since
        ? new Date(new Date(since).getTime() - BILLING_REFRESH_DAYS * 86400000).toISOString()
        : null;

    const entries = [...companyMap.entries()].filter(([carrierId]) => {
        if (staleCutoff && (cache.billingCarrierFetchedAt[carrierId] || "") >= staleCutoff) return false;
        return true;
    });

    const totalToFetch = entries.length;
    const skipped = companyMap.size - totalToFetch;
    const startedAt = Date.now();
    let fetched = 0;
    let lastSaveAt = 0;

    console.log(
        `[SMP-cache] Per-company billing (1 page each): ${totalToFetch} to fetch, ${skipped} skipped (cache fresh)`
    );

    await workPool(entries, BILLING_CONCURRENCY, async ([carrierId, comp]) => {
        const companyId = comp?.id;
        if (!companyId) return;

        try {
            const data = await smpGet(
                `companies/${companyId}/billing-history?page=0&size=200&sort=createDate,desc`
            );
            const content = (data.content || []).map((t) => ({ ...t, carrierId }));

            for (const txn of content) {
                const key = billingTxnKey(txn);
                if (key) cache.billing[key] = slimBillingTxn(txn);
            }
        } catch {
            // Individual company failure — skip, keep cached data
        }

        cache.billingCarrierFetchedAt[carrierId] = fetchedAt;
        fetched++;

        if (fetched - lastSaveAt >= BILLING_SAVE_INTERVAL) {
            lastSaveAt = fetched;
            saveBillingCache(cachePath, cache);
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
            const rate = fetched / ((Date.now() - startedAt) / 1000);
            const eta = rate > 0 ? Math.ceil((totalToFetch - fetched) / rate) : "?";
            console.log(
                `[SMP-cache]   billing: ${fetched}/${totalToFetch} companies — ${elapsed}s elapsed, ~${eta}s remaining`
            );
        }
    });

    cache.billingLastFetchedAt = fetchedAt;
    saveBillingCache(cachePath, cache);

    const all = Object.values(cache.billing);
    const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
        `[SMP-cache] Billing done — ${fetched} carriers in ${totalSec}s, ${all.length} transactions cached`
    );
    return all;
}
