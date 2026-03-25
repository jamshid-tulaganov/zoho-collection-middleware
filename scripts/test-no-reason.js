#!/usr/bin/env node
// Quick smoke test: pick the first 5 untried (no_reason) candidates and attempt DOB lookup.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDobByName, closeBrowser } from "../src/services/isoftpull.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = path.resolve(__dirname, "../data/isoftpull-candidates.json");
const DOB_PATH = path.resolve(__dirname, "../data/dob.json");

const candidates = JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8"));
const dobMap = JSON.parse(fs.readFileSync(DOB_PATH, "utf-8"));

const unresolved = candidates.filter((c) => !dobMap[c.carrierId]);
const noReason = unresolved.filter((c) => !c.reason || c.reason === "no_reason").slice(0, 5);

console.log(`Testing ${noReason.length} untried no_reason candidates...`);

let fetched = 0;
let notFound = 0;

for (const c of noReason) {
    const { carrierId, firstName, lastName, address, city, state, zip } = c;
    console.log(`\n→ [${carrierId}] ${firstName} ${lastName} (${city}, ${state} ${zip})`);
    try {
        const result = await getDobByName(firstName, lastName, { address, city, state, zip });
        if (result.dob) {
            console.log(`  ✓ DOB: ${result.dob} (applicantId: ${result.applicantId})`);
            fetched++;
        } else {
            console.log(`  ✗ Not found: ${result.reason} (checked: ${result.checked})`);
            notFound++;
        }
    } catch (err) {
        console.error(`  ! Error: ${err.message}`);
        notFound++;
    }
}

await closeBrowser();
console.log(`\nSmoke test done: fetched=${fetched}, notFound=${notFound}`);
