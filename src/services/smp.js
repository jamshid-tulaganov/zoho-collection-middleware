import { env } from "../config/env.js";

let smpToken = "";

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
