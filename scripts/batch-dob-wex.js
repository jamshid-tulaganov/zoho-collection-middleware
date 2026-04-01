#!/usr/bin/env node
/**
 * Batch WEX DOB lookup for ALL carriers missing DOB.
 * Uses carrier ID for searching WEX (more reliable than company name).
 *
 * Usage:
 *   node scripts/batch-dob-wex.js                    # dry-run, all missing
 *   node scripts/batch-dob-wex.js --apply             # save to dob.json
 *   node scripts/batch-dob-wex.js --apply --limit 50  # first 50 only
 *   node scripts/batch-dob-wex.js --apply --resume     # skip already in dob.json
 *
 * Progress is saved to data/wex-dob-progress.json after each lookup
 * so you can safely Ctrl+C and resume later with --resume.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WEXSession } from "./dob-lookup-wex.js";
import { env } from "../src/config/env.js";
import { readCarrierDb } from "../src/services/syncCarrierDb.js";
import { loadDobMap } from "../src/services/dob.js";
import { loadReportCarriers, carrierToRow } from "../src/services/arrayReport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../data/dob.json");
const PROGRESS_PATH = path.resolve(__dirname, "../data/wex-dob-progress.json");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const resume = args.includes("--resume");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : 0;

function loadProgress() {
    try { return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8")); }
    catch { return { found: {}, notFound: [], errors: [] }; }
}

function saveProgress(progress) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf-8");
}

async function main() {
    const db = readCarrierDb();

    // Collect ALL carriers missing DOB from both reports
    const loc = loadReportCarriers({ include_inactive: "true" });
    const debtors = loadReportCarriers({ debtor_report: "true", include_inactive: "true" });

    const seen = new Set();
    const candidates = [];

    for (const c of [...loc, ...debtors]) {
        const cid = String(c.carrier_id);
        if (seen.has(cid)) continue;
        seen.add(cid);

        const row = carrierToRow(c);
        if (row["Date of Birth"]) continue; // already has DOB

        const d = c.derived || {};
        candidates.push({
            carrierId: cid,
            companyName: c.accounting?.company || c.zoho?.company || d.company_name || "",
            firstName: d.first_name || "",
            lastName: d.last_name || "",
        });
    }

    // Load existing dob.json and progress
    let dobMap = {};
    try { dobMap = JSON.parse(fs.readFileSync(DOB_PATH, "utf-8")); } catch {}
    const progress = resume ? loadProgress() : { found: {}, notFound: [], errors: [] };

    // Filter out already-processed carriers if resuming
    let toProcess = candidates;
    if (resume) {
        const done = new Set([
            ...Object.keys(progress.found),
            ...progress.notFound,
            ...progress.errors,
        ]);
        toProcess = candidates.filter(c => !done.has(c.carrierId));
    }

    if (limit > 0) toProcess = toProcess.slice(0, limit);

    console.log(`[batch-dob] Total missing DOB: ${candidates.length}`);
    console.log(`[batch-dob] To process: ${toProcess.length}${resume ? " (resumed)" : ""}`);
    console.log(`[batch-dob] Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
    console.log();

    if (!toProcess.length) {
        console.log("[batch-dob] Nothing to process.");
        return;
    }

    const session = new WEXSession();
    let found = 0, notFound = 0, errors = 0;

    try {
        await session.init();

        for (let i = 0; i < toProcess.length; i++) {
            const { carrierId, companyName, firstName, lastName } = toProcess[i];
            const pct = Math.round(((i + 1) / toProcess.length) * 100);
            process.stdout.write(`[${i + 1}/${toProcess.length} ${pct}%] ${carrierId} "${companyName.slice(0, 25)}"... `);

            let result = await session.lookup({ carrierId, companyName, firstName, lastName });

            if (result.status === "found") {
                found++;
                console.log(`DOB: ${result.dob}`);
                progress.found[carrierId] = result.dobISO;
                if (apply) dobMap[carrierId] = result.dobISO;
            } else {
                if (result.status === "error") {
                    errors++;
                    progress.errors.push(carrierId);
                    console.log(`ERROR: ${result.error}`);
                } else {
                    notFound++;
                    progress.notFound.push(carrierId);
                    console.log(result.status);
                }
            }

            // Save progress every lookup (safe to Ctrl+C)
            saveProgress(progress);

            // Delay between lookups
            await new Promise(r => setTimeout(r, 800));
        }
    } catch (err) {
        console.error("\n[batch-dob] Session error:", err.message);
        console.log("[batch-dob] Progress saved — run with --resume to continue.");
    } finally {
        await session.close();
    }

    console.log();
    console.log(`[batch-dob] Results: found=${found} notFound=${notFound} errors=${errors}`);
    console.log(`[batch-dob] Total in progress: found=${Object.keys(progress.found).length} notFound=${progress.notFound.length}`);

    if (apply && found > 0) {
        fs.writeFileSync(DOB_PATH, JSON.stringify(dobMap, null, 2), "utf-8");
        console.log(`[batch-dob] Saved ${Object.keys(dobMap).length} total DOBs → ${DOB_PATH}`);
    }

    saveProgress(progress);
    console.log(`[batch-dob] Progress saved → ${PROGRESS_PATH}`);
}

main().catch(err => {
    console.error("[batch-dob] Fatal:", err.message);
    process.exit(1);
});
