/**
 * Standalone script: generate the Array Credit Report and send it to Telegram.
 *
 * Usage:
 *   node send-array-report.js                   # LOC report (default)
 *   node send-array-report.js --debtors          # debtors / collection accounts report
 *   node send-array-report.js --sync             # sync carrier-db first, then send
 *   node send-array-report.js --sync --debtors
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in collections/.env
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { env, validateEnvironment } from "./src/config/env.js";
import { buildArrayReportFilename, loadReportCarriers, writeArrayReportFile } from "./src/services/arrayReport.js";
import { runCarrierDbSync } from "./src/services/syncCarrierDb.js";

const args = process.argv.slice(2);
const syncFirst = args.includes("--sync");
const isDebtors = args.includes("--debtors");

function telegramUrl(method) {
    return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendMessage(text) {
    const res = await fetch(telegramUrl("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(env.TELEGRAM_CHAT_ID), text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `sendMessage failed (${res.status})`);
    return data;
}

async function sendDocument(filePath, fileName, caption) {
    const form = new FormData();
    const fileBuffer = await fs.readFile(filePath);
    const blob = new Blob(
        [fileBuffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    );
    form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
    if (caption) form.append("caption", caption);
    form.append("document", blob, fileName);

    const res = await fetch(telegramUrl("sendDocument"), { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `sendDocument failed (${res.status})`);
    return data;
}

async function main() {
    validateEnvironment();

    if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("[send-array-report] TELEGRAM_BOT_TOKEN is not set — cannot send.");
        process.exit(1);
    }
    if (!env.TELEGRAM_CHAT_ID) {
        console.error("[send-array-report] TELEGRAM_CHAT_ID is not set — cannot send.");
        process.exit(1);
    }

    if (syncFirst) {
        console.log("[send-array-report] Syncing carrier-db...");
        await sendMessage("Refreshing carrier-db.json before building the report...");
        const result = await runCarrierDbSync();
        if (!result?.success) {
            throw new Error(result?.error || "Carrier DB sync failed");
        }
        console.log(`[send-array-report] Sync done: ${result.processed} processed, ${result.errors} errors`);
    } else {
        console.log("[send-array-report] Using existing carrier-db.json (pass --sync to refresh first).");
        await sendMessage("Generating the Array report from carrier-db.json...");
    }

    let carriers = isDebtors
        ? loadReportCarriers({ debtor_report: "true", include_inactive: "true" })
        : loadReportCarriers({ include_inactive: "true" });

    if (!carriers.length) {
        const msg = isDebtors
            ? "No debtor/collection carriers found."
            : "No carriers found. Run with --sync first.";
        console.error(`[send-array-report] ${msg}`);
        await sendMessage(`Report failed: ${msg}`);
        process.exit(1);
    }

    const modeLabel = isDebtors ? "debtors" : "";
    const fileName = buildArrayReportFilename(new Date(), modeLabel);
    const filePath = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);

    try {
        console.log(`[send-array-report] Building report for ${carriers.length} carriers...`);
        const result = await writeArrayReportFile({ carriers, filePath, compactOptional: true });
        console.log(`[send-array-report] Sending ${result.rowCount} rows, ${result.columnCount} columns...`);

        await sendDocument(
            filePath,
            fileName,
            `Array ${isDebtors ? "debtors" : "LOC"} report: ${result.rowCount} carriers, ${result.columnCount} columns`
        );
        console.log("[send-array-report] Sent successfully.");
    } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
    }
}

main().catch((err) => {
    console.error("[send-array-report] Fatal error:", err.message);
    process.exit(1);
});
