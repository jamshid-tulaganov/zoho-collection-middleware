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
 * Fetch invoices for a single carrier from a preloaded global invoice list.
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
 * Fetch billing history (recent transactions) via company-specific endpoint.
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
