#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = path.resolve(__dirname, "../data/isoftpull-candidates.json");
const DOB_PATH = path.resolve(__dirname, "../data/dob.json");
const JSON_OUTPUT_PATH = path.resolve(__dirname, "../data/isoftpull-no-reason-candidates.json");
const CSV_OUTPUT_PATH = path.resolve(__dirname, "../data/isoftpull-no-reason-candidates.csv");

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function csvEscape(value) {
    const raw = String(value ?? "");
    if (/[",\n]/.test(raw)) {
        return `"${raw.replace(/"/g, "\"\"")}"`;
    }
    return raw;
}

const candidates = readJson(CANDIDATES_PATH);
const dobMap = readJson(DOB_PATH);

const rows = candidates
    .filter((candidate) => !dobMap[candidate.carrierId])
    .filter((candidate) => !candidate.reason || candidate.reason === "no_reason")
    .map((candidate) => ({
        carrierId: candidate.carrierId,
        firstName: candidate.firstName || "",
        lastName: candidate.lastName || "",
        fullName: [candidate.firstName, candidate.lastName].filter(Boolean).join(" "),
        address: candidate.address || "",
        city: candidate.city || "",
        state: candidate.state || "",
        zip: candidate.zip || "",
        reason: candidate.reason || "no_reason",
    }));

const csvHeader = [
    "carrierId",
    "firstName",
    "lastName",
    "fullName",
    "address",
    "city",
    "state",
    "zip",
    "reason",
];

const csvLines = [
    csvHeader.join(","),
    ...rows.map((row) => csvHeader.map((key) => csvEscape(row[key])).join(",")),
];

fs.writeFileSync(JSON_OUTPUT_PATH, JSON.stringify(rows, null, 2));
fs.writeFileSync(CSV_OUTPUT_PATH, `${csvLines.join("\n")}\n`);

console.log(
    JSON.stringify(
        {
            count: rows.length,
            json: JSON_OUTPUT_PATH,
            csv: CSV_OUTPUT_PATH,
        },
        null,
        2
    )
);
