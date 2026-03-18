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
 * Fetch ALL invoices for a carrier (any status) to build monthly activity map.
 */
export async function fetchAllInvoices(carrierId) {
    const invoices = [];
    for (let page = 0; page < 4; page++) {
        const data = await smpGet(
            `invoices?page=${page}&size=200&sort=createDate,desc&carrierId=${carrierId}`
        );
        const content = data.content || [];
        if (!content.length) break;
        invoices.push(...content);
        if (content.length < 200) break;
    }
    return invoices;
}

/**
 * Fetch unpaid invoices (PENDING/PARTIALLY_PAID) sorted by dueDate ascending.
 */
export async function fetchUnpaidInvoices(carrierId) {
    const data = await smpGet(
        `invoices?page=0&size=25&sort=dueDate,asc&statuses=PENDING&statuses=PARTIALLY_PAID&carrierId=${carrierId}`
    );
    return data.content || [];
}

/**
 * Fetch most recent PAID invoice.
 */
export async function fetchLastPaidInvoice(carrierId) {
    const data = await smpGet(
        `invoices?page=0&size=1&sort=dueDate,desc&statuses=PAID&carrierId=${carrierId}`
    );
    return (data.content || [])[0] || null;
}

/**
 * Fetch billing history (recent transactions).
 */
export async function fetchBillingHistory(carrierId) {
    const data = await smpGet(
        `billing-history?page=0&size=10&sort=createDate,desc&carrierId=${carrierId}`
    );
    return data.content || [];
}
