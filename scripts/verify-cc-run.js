// scripts/verify-cc-run.js
// Read-only verification of Collection_Cases after a findDebtorsFromCMP run.
// Pulls counts + a sample of records and checks the new fields are populated.

import { env, validateEnvironment } from "../src/config/env.js";

validateEnvironment();

let _bearer = "";
async function bearer() {
    if (_bearer) return _bearer;
    const params = new URLSearchParams({
        refresh_token: env.ZOHO_REFRESH_TOKEN,
        client_id: env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        grant_type: "refresh_token",
    });
    const r = await fetch(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token?${params}`, { method: "POST" });
    const d = await r.json();
    if (!d.access_token) throw new Error("zoho refresh failed: " + JSON.stringify(d));
    _bearer = d.access_token;
    return _bearer;
}

async function zfetch(path) {
    const tok = await bearer();
    const r = await fetch(`${env.ZOHO_BASE_URL}${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${tok}` },
    });
    if (r.status === 204) return { data: [] };
    return r.json();
}

async function coql(query) {
    const tok = await bearer();
    const r = await fetch(`${env.ZOHO_BASE_URL}/crm/v2/coql`, {
        method: "POST",
        headers: {
            Authorization: `Zoho-oauthtoken ${tok}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ select_query: query }),
    });
    if (r.status === 204) return { data: [] };
    return r.json();
}

function pad(s, n) { return String(s ?? "").padEnd(n); }

(async function main() {
    console.log("─".repeat(95));
    console.log("Verifying Collection_Cases after findDebtorsFromCMP run");
    console.log("─".repeat(95));

    // ── 1. Total count via COQL ──
    let totalCases = 0;
    let allCarrierIds = new Set();
    let withZohoSync = 0;
    for (let off = 0; off <= 4000; off += 200) {
        const r = await coql(`SELECT id, Carrier_ID, Stage, Case_Source FROM Collection_Cases WHERE Carrier_ID > 0 LIMIT 200 OFFSET ${off}`);
        const data = r.data || [];
        if (!data.length) break;
        totalCases += data.length;
        for (const c of data) {
            if (c.Carrier_ID) allCarrierIds.add(String(c.Carrier_ID));
            if (c.Case_Source === "Zoho Sync") withZohoSync++;
        }
        if (data.length < 200) break;
    }
    console.log(`\nTotal Collection_Cases (Carrier_ID > 0):  ${totalCases}`);
    console.log(`  unique Carrier_IDs:                     ${allCarrierIds.size}`);
    console.log(`  Case_Source = "Zoho Sync":              ${withZohoSync}`);
    if (totalCases !== allCarrierIds.size) {
        console.log(`  ⚠ DUPLICATE WARNING: ${totalCases - allCarrierIds.size} duplicates by Carrier_ID`);
    } else {
        console.log(`  ✓ no duplicate Carrier_IDs`);
    }

    // ── 2. Pull a sample of recent cases with full record details (incl. subform) ──
    const sampleResp = await zfetch(`/crm/v2/Collection_Cases?fields=id,Name,Carrier_ID,Stage,Case_Source,Case_Status,Case_Created_Date,Days_Past_Due,First_Delinquent_Date,Total_Debt_Amount,Total_Invoice_Amount,Total_Amount_Paid,Issue_Invoice_Count,Tag,Currency,Debtor_Company_Name,Debtor_Full_Name,Debtor_Email,Debtor_Phone_Number,Debtor_Date_of_Birth,Related_Deal,Invoice_Issues&sort_order=desc&sort_by=Created_Time&per_page=10`);
    const samples = sampleResp.data || [];
    console.log(`\nFetched ${samples.length} most-recent Collection_Cases for spot-check.\n`);

    // ── 3. Field-fill audit on the sample ──
    const fillCounts = {
        Name: 0, Carrier_ID: 0, Stage: 0, Case_Source: 0, Case_Status: 0,
        Case_Created_Date: 0, Days_Past_Due: 0, First_Delinquent_Date: 0,
        Total_Debt_Amount: 0, Total_Invoice_Amount: 0, Total_Amount_Paid: 0,
        Issue_Invoice_Count: 0, Tag: 0, Currency: 0,
        Debtor_Company_Name: 0, Debtor_Full_Name: 0, Debtor_Email: 0,
        Debtor_Phone_Number: 0, Debtor_Date_of_Birth: 0, Related_Deal: 0,
    };
    for (const c of samples) {
        for (const k of Object.keys(fillCounts)) {
            const v = c[k];
            if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) {
                fillCounts[k]++;
            }
        }
    }
    console.log("Field-fill rates on sample of " + samples.length + " cases:");
    for (const [k, n] of Object.entries(fillCounts)) {
        const mark = n === samples.length ? "✓" : (n === 0 ? "✗" : "•");
        console.log(`  ${mark} ${pad(k, 28)} ${n}/${samples.length}`);
    }

    // ── 4. Detailed dump of first 3 records ──
    console.log("\n── Detailed sample (first 3 records) ──");
    for (let i = 0; i < Math.min(3, samples.length); i++) {
        const c = samples[i];
        console.log(`\n[${i + 1}] ${c.Name}`);
        console.log(`    id              = ${c.id}`);
        console.log(`    Carrier_ID      = ${c.Carrier_ID}`);
        console.log(`    Stage           = ${c.Stage}`);
        console.log(`    Case_Source     = ${c.Case_Source}`);
        console.log(`    Case_Status     = ${c.Case_Status}`);
        console.log(`    Days_Past_Due   = ${c.Days_Past_Due}  ${typeof c.Days_Past_Due === "number" && c.Days_Past_Due > 1000000 ? "  ⚠ LOOKS LIKE MILLISECONDS" : ""}`);
        console.log(`    First_Delinq    = ${c.First_Delinquent_Date}`);
        console.log(`    Total_Debt      = $${c.Total_Debt_Amount}`);
        console.log(`    Total_Invoice   = $${c.Total_Invoice_Amount}`);
        console.log(`    Total_Paid      = $${c.Total_Amount_Paid}`);
        console.log(`    Issue_Inv_Count = ${c.Issue_Invoice_Count}`);
        console.log(`    Tag             = ${c.Tag === undefined ? "(undefined)" : JSON.stringify(c.Tag)}`);
        console.log(`    Currency        = ${c.Currency}`);
        console.log(`    Company         = ${c.Debtor_Company_Name}`);
        console.log(`    Debtor_Name     = ${c.Debtor_Full_Name}`);
        console.log(`    Debtor_Email    = ${c.Debtor_Email}`);
        console.log(`    Debtor_Phone    = ${c.Debtor_Phone_Number}`);
        console.log(`    Debtor_DOB      = ${c.Debtor_Date_of_Birth}  ${c.Debtor_Date_of_Birth ? "✓" : "✗ MISSING"}`);
        console.log(`    Related_Deal    = ${c.Related_Deal?.id || c.Related_Deal || "(none)"}`);
        const subform = c.Invoice_Issues || [];
        console.log(`    Invoice_Issues  = ${subform.length} rows`);
        if (subform.length > 0) {
            const statusCounts = {};
            for (const r of subform) {
                statusCounts[r.Status || "(blank)"] = (statusCounts[r.Status || "(blank)"] || 0) + 1;
            }
            console.log(`        status mix: ${JSON.stringify(statusCounts)}`);
            console.log(`        first row:  Invoice_Number=${subform[0].Invoice_Number} Status=${subform[0].Status} Total=${subform[0].Total_Amount} Paid=${subform[0].Total_Paid} Remaining=${subform[0].Remaining_Amount} Due=${subform[0].Due_Date}`);
            // Sanity check: do the subform totals match the parent totals?
            const subTotalAmt = subform.reduce((s, r) => s + Number(r.Total_Amount || 0), 0);
            const subTotalPaid = subform.reduce((s, r) => s + Number(r.Total_Paid || 0), 0);
            const subTotalRem = subform.reduce((s, r) => s + Number(r.Remaining_Amount || 0), 0);
            const okAmt = Math.abs(subTotalAmt - Number(c.Total_Invoice_Amount || 0)) < 0.01;
            const okPaid = Math.abs(subTotalPaid - Number(c.Total_Amount_Paid || 0)) < 0.01;
            const okRem = Math.abs(subTotalRem - Number(c.Total_Debt_Amount || 0)) < 0.01;
            console.log(`        subform-vs-parent totals match: amt=${okAmt ? "✓" : "✗"} paid=${okPaid ? "✓" : "✗"} remaining=${okRem ? "✓" : "✗"}`);
            if (!okAmt) console.log(`            sub_amt=$${subTotalAmt.toFixed(2)} parent=$${c.Total_Invoice_Amount}`);
            if (!okPaid) console.log(`            sub_paid=$${subTotalPaid.toFixed(2)} parent=$${c.Total_Amount_Paid}`);
            if (!okRem) console.log(`            sub_rem=$${subTotalRem.toFixed(2)} parent=$${c.Total_Debt_Amount}`);
        }
    }

    // ── 5. Days_Past_Due sanity scan across all sampled cases ──
    console.log("\n── Days_Past_Due sanity scan ──");
    const allDays = samples.map((c) => c.Days_Past_Due).filter((d) => d !== null && d !== undefined);
    if (allDays.length) {
        const min = Math.min(...allDays);
        const max = Math.max(...allDays);
        const overflowed = allDays.filter((d) => d > 999999999);
        console.log(`  min=${min}  max=${max}  count=${allDays.length}`);
        if (overflowed.length) console.log(`  ⚠ ${overflowed.length} records have Days_Past_Due > 999,999,999 (the 9-digit overflow bug — should be FIXED now)`);
        if (max > 10000) console.log(`  ⚠ max=${max} looks too large for "days" — possible ms→days bug remaining`);
        else console.log(`  ✓ all values within reasonable day range`);
    }

    // ── 6. DOB fill audit across all sampled ──
    console.log("\n── Debtor_Date_of_Birth fill audit ──");
    const withDob = samples.filter((c) => c.Debtor_Date_of_Birth).length;
    console.log(`  ${withDob}/${samples.length} have a DOB (${samples.length ? Math.round(withDob/samples.length*100) : 0}%)`);

    // ── 7. Re-fetch the first sample by ID without fields filter — confirms whether subform really has rows ──
    if (samples.length) {
        const id = samples[0].id;
        console.log(`\n── Full record fetch (no fields filter) for sample[0] id=${id} ──`);
        const full = await zfetch(`/crm/v2/Collection_Cases/${id}`);
        const rec = (full.data || [])[0];
        if (!rec) {
            console.log("  no record returned");
        } else {
            const sub = rec.Invoice_Issues || [];
            console.log(`  Invoice_Issues rows (full fetch): ${sub.length}`);
            if (sub.length > 0) {
                console.log(`  → SUBFORM EXISTS, the earlier '0 rows' was a fields-filter limitation`);
                const statusCounts = {};
                for (const r of sub) statusCounts[r.Status || "(blank)"] = (statusCounts[r.Status || "(blank)"] || 0) + 1;
                console.log(`  status mix: ${JSON.stringify(statusCounts)}`);
                console.log(`  first row: ${JSON.stringify(sub[0], null, 2)}`);
            } else {
                console.log(`  → SUBFORM REALLY IS EMPTY for this record (potential bug)`);
            }
            console.log(`  Tag (full): ${JSON.stringify(rec.Tag)}`);
        }
    }

    console.log("\nDone.");
})().catch((e) => { console.error(e); process.exit(1); });
