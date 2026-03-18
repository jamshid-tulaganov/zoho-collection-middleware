import { env } from "../config/env.js";

let zohoToken = "";
let tokenTime = 0;

export async function refreshZohoToken() {
    const params = new URLSearchParams({
        refresh_token: env.ZOHO_REFRESH_TOKEN,
        client_id: env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
    });

    const response = await fetch(
        `${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`,
        { method: "POST" }
    );
    const data = await response.json();

    if (!data.access_token) {
        // Retry once on rate limit
        if (response.status === 429) {
            console.log("[Zoho] Rate-limited, waiting 10s...");
            await new Promise((r) => setTimeout(r, 10000));
            const retry = await fetch(
                `${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`,
                { method: "POST" }
            );
            const retryData = await retry.json();
            if (!retryData.access_token) {
                throw new Error(`Zoho token refresh failed after retry: ${JSON.stringify(retryData)}`);
            }
            zohoToken = retryData.access_token;
            tokenTime = Date.now();
            console.log("[Zoho] Token refreshed (after retry).");
            return;
        }
        throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
    }

    zohoToken = data.access_token;
    tokenTime = Date.now();
    console.log("[Zoho] Token refreshed.");
}

export async function ensureZohoToken() {
    // Refresh every 45 minutes (tokens expire in ~60 min)
    if (!zohoToken || Date.now() - tokenTime > 45 * 60 * 1000) {
        await refreshZohoToken();
    }
}

async function zohoRequest(endpoint, options = {}) {
    await ensureZohoToken();

    const doFetch = () =>
        fetch(`${env.ZOHO_BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                Authorization: `Zoho-oauthtoken ${zohoToken}`,
                ...options.headers,
            },
        });

    let response = await doFetch();
    if (response.status === 401) {
        await refreshZohoToken();
        response = await doFetch();
    }
    if (response.status === 429) {
        console.log("[Zoho] 429 rate-limited, waiting 10s...");
        await new Promise((r) => setTimeout(r, 10000));
        response = await doFetch();
    }

    return response.json();
}

/**
 * Fetch all Card Swiped deals (paginated).
 */
export async function fetchDeals() {
    const deals = [];
    for (let page = 1; page <= 50; page++) {
        const data = await zohoRequest(
            `/crm/v2/Deals/search?criteria=(Stage:equals:Card%20Swiped)&page=${page}&per_page=200`
        );
        const batch = data.data || [];
        if (!batch.length) break;
        deals.push(...batch);
        if (batch.length < 200) break;
    }
    return deals;
}

/**
 * COQL query to fetch existing CMP_Fund_Stations record for a carrier.
 */
export async function fetchExistingStation(carrierId) {
    try {
        const data = await zohoRequest("/crm/v2/coql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                select_query: `SELECT id, Date_of_First_Delinquency, Date_of_Birth, Credit_Score, Payment_History_Profile FROM CMP_Fund_Stations WHERE Customer_Account_Number = '${carrierId}' LIMIT 1`,
            }),
        });
        return (data.data || [])[0] || null;
    } catch {
        return null;
    }
}
