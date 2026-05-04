#!/usr/bin/env node
/**
 * Discover every WEX OnlineApplication__c field for one carrier.
 *
 * Usage:
 *   node scripts/wex-discover-fields.js --carrierId 5753849 --company "KIWI EXPRESS INC"
 *   node scripts/wex-discover-fields.js -c 5753849 -n "KIWI EXPRESS INC" --out data/wex-discovery.json
 *
 * Output:
 *   Pretty-prints to stdout: object schema (every field defined on
 *   OnlineApplication__c), the matched record's actual field values, the
 *   linked Beneficial Owner Entity record, and all Beneficial Owner Prong
 *   children. Optionally writes the same payload to --out as JSON.
 *
 * Use the printed schema to pick which fields to wire into lookupWexCompany().
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { discoverWexCompany, closeWexSession } from "../src/services/wexHttp.js";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--carrierId" || a === "-c") out.carrierId = argv[++i];
        else if (a === "--company" || a === "-n") out.company = argv[++i];
        else if (a === "--out" || a === "-o") out.outPath = argv[++i];
        else if (a === "--help" || a === "-h") out.help = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.carrierId || !args.company) {
    console.log(`Usage: node scripts/wex-discover-fields.js --carrierId <id> --company "<name>" [--out <path>]`);
    process.exit(args.help ? 0 : 1);
}

(async () => {
    console.log(`[discover] carrierId=${args.carrierId} company="${args.company}"`);
    const result = await discoverWexCompany({ carrierId: args.carrierId, companyName: args.company });

    if (result.status !== "found") {
        console.error(`[discover] status=${result.status}`, result.error || "");
        if (result.candidates) console.error(`[discover] candidates:`, result.candidates);
        await closeWexSession();
        process.exit(2);
    }

    console.log(`\n=== Matched OnlineApplication__c ===`);
    console.log(`recordId:  ${result.recordId}`);
    console.log(`legalName: ${result.legalName}`);
    console.log(`boeId:     ${result.boeId || "(none)"}`);

    console.log(`\n=== Object schema (${result.objectFields.length} fields on OnlineApplication__c) ===`);
    for (const f of result.objectFields) {
        const ref = f.referenceToInfos?.[0]?.apiName ? ` → ${f.referenceToInfos[0].apiName}` : "";
        console.log(`  ${f.apiName.padEnd(45)}  ${f.dataType.padEnd(12)}  ${f.label}${ref}`);
    }

    console.log(`\n=== Record values (${Object.keys(result.recordFields).length} fields populated) ===`);
    for (const [k, v] of Object.entries(result.recordFields)) {
        const display = v === null ? "(null)" : typeof v === "object" ? JSON.stringify(v) : String(v);
        console.log(`  ${k.padEnd(45)}  ${display}`);
    }

    if (result.boeRecordFields) {
        console.log(`\n=== Beneficial_Owner_Information__c record (${Object.keys(result.boeRecordFields).length} fields) ===`);
        for (const [k, v] of Object.entries(result.boeRecordFields)) {
            const display = v === null ? "(null)" : typeof v === "object" ? JSON.stringify(v) : String(v);
            console.log(`  ${k.padEnd(45)}  ${display}`);
        }
    }

    if (result.boeOwners?.length) {
        console.log(`\n=== Beneficial_Owner_Prong__c children (${result.boeOwners.length}) ===`);
        result.boeOwners.forEach((o, i) => {
            console.log(`  [${i}]`);
            for (const [k, v] of Object.entries(o)) {
                const display = v === null ? "(null)" : typeof v === "object" ? JSON.stringify(v) : String(v);
                console.log(`      ${k.padEnd(41)}  ${display}`);
            }
        });
    }

    if (args.outPath) {
        const abs = path.resolve(process.cwd(), args.outPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(result, null, 2));
        console.log(`\n[discover] full payload written to ${abs}`);
    }

    await closeWexSession();
})().catch(async (err) => {
    console.error("[discover] failed:", err);
    await closeWexSession().catch(() => {});
    process.exit(1);
});
