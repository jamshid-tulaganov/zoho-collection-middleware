/**
 * Standalone script: generate the Financial Risk Report from collection-placement-db.json
 * as an Excel file and send it to Telegram.
 *
 * Usage:
 *   node send-financial-risk-report.js
 *   npm run report:financial-risk
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in collections/.env
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { env } from "./src/config/env.js";

// ── Constants ────────────────────────────────────────────────────────────────

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

const COLLECTION_DATE_FIELDS = [
    "collection_transferred_date_dustin",
    "collection_transferred_date_trustaltus",
    "collection_transferred_date_ic_system",
];

const DELINQUENT_STATUSES = new Set(["pending", "baddebtor"]);

// ── Date helpers ─────────────────────────────────────────────────────────────

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}

function firstOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
    return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function safeAmount(value) {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
}

// ── Rule 2: Collection sent date ─────────────────────────────────────────────

function getInvoiceCollectionDate(invoice) {
    for (const field of COLLECTION_DATE_FIELDS) {
        const d = parseDate(invoice[field]);
        if (d) return d;
    }
    return null;
}

function resolveCollectionSentDate(invoice, companyCollectionDate) {
    return getInvoiceCollectionDate(invoice) ?? companyCollectionDate ?? null;
}

// ── Rule 3: Billing history ───────────────────────────────────────────────────

function buildBillingHistory(delinquencyDate, collectionSentDate) {
    if (!delinquencyDate) return "N/A";

    const start = firstOfMonth(delinquencyDate);
    const end = firstOfMonth(TODAY);
    const collectionStart = collectionSentDate ? firstOfMonth(collectionSentDate) : null;

    const entries = [];
    let cursor = start;
    let month = 1;

    while (cursor <= end) {
        entries.push(collectionStart && cursor >= collectionStart ? "G" : String(month));
        cursor = addMonths(cursor, 1);
        month++;
    }

    return entries.join(", ") || "N/A";
}

// ── Rule 4: Hard-lock ─────────────────────────────────────────────────────────

function hasActiveDelinquency(invoices) {
    return invoices.some((inv) => {
        const status = String(inv.invoice_status || "").toLowerCase();
        return DELINQUENT_STATUSES.has(status) && safeAmount(inv.remaining_amount) > 0;
    });
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateReportRows(data) {
    const rows = [];

    for (const [, company] of Object.entries(data)) {
        const invoices = Array.isArray(company.invoices) ? company.invoices : [];
        const delinquencyDate = parseDate(company.date_of_delinquency);
        const companyCollectionDate = parseDate(company.sent_to_collection_date);
        const hardLock = hasActiveDelinquency(invoices);

        for (const inv of invoices) {
            const sentDate = resolveCollectionSentDate(inv, companyCollectionDate);
            const classification = sentDate ? "In Collections" : "Standard Debtor";
            const remaining = safeAmount(inv.remaining_amount);

            rows.push({
                "Company":                  company.company || "",
                "Debtor Type":              company.debtor_type || "",
                "Date of Delinquency":      company.date_of_delinquency || "",
                "Sent to Collection":        company.sent_to_collection_date || "",
                "Collection Source":         company.collection_source || "",
                "Invoice #":                inv.invoice_number ?? "",
                "Invoice Status":           inv.invoice_status || "",
                "Overall Status":           inv.overall_status || "",
                "Classification":           classification,
                "Agency Date":              sentDate ? sentDate.toISOString().slice(0, 10) : "",
                "Total Amount":             safeAmount(inv.total_amount),
                "Total Paid":               safeAmount(inv.total_paid),
                "Remaining Amount":         remaining,
                "Hard Lock":                hardLock ? "YES" : "",
                "Current Balance":          hardLock ? 0 : safeAmount(company.current_balance),
                "Weekly Credit Limit":      hardLock ? 0 : safeAmount(company.weekly_credit_limit),
                "Billing History":          buildBillingHistory(delinquencyDate, sentDate),
            });
        }
    }

    return rows;
}

// ── Excel workbook ────────────────────────────────────────────────────────────

const COLUMNS = [
    { key: "Company",               width: 28 },
    { key: "Debtor Type",           width: 14 },
    { key: "Date of Delinquency",   width: 18 },
    { key: "Sent to Collection",    width: 18 },
    { key: "Collection Source",     width: 16 },
    { key: "Invoice #",             width: 12 },
    { key: "Invoice Status",        width: 14 },
    { key: "Overall Status",        width: 24 },
    { key: "Classification",        width: 18 },
    { key: "Agency Date",           width: 14 },
    { key: "Total Amount",          width: 14, currency: true },
    { key: "Total Paid",            width: 12, currency: true },
    { key: "Remaining Amount",      width: 16, currency: true },
    { key: "Hard Lock",             width: 10 },
    { key: "Current Balance",       width: 16, currency: true },
    { key: "Weekly Credit Limit",   width: 18, currency: true },
    { key: "Billing History",       width: 42 },
];

function buildWorkbook(rows, generatedAt = new Date()) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "collection-middleware";
    wb.created = generatedAt;

    const ws = wb.addWorksheet("Financial Risk Report", {
        views: [{ state: "frozen", ySplit: 2 }],
    });

    ws.columns = COLUMNS.map((c) => ({ key: c.key, width: c.width }));

    // Title row
    ws.mergeCells(1, 1, 1, COLUMNS.length);
    const title = ws.getCell("A1");
    const dateStr = generatedAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    title.value = `Financial Risk Report — ${dateStr} — ${rows.length} invoices`;
    title.font = { bold: true, size: 13, color: { argb: "FF0F172A" } };
    title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
    title.alignment = { vertical: "middle", horizontal: "left" };
    ws.getRow(1).height = 22;

    // Header row
    const headerRow = ws.getRow(2);
    COLUMNS.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.key;
        cell.font = { bold: true, size: 10, color: { argb: "FF1F2937" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6DCE4" } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = {
            top: { style: "thin", color: { argb: "FFB0B8C4" } },
            bottom: { style: "thin", color: { argb: "FFB0B8C4" } },
            left: { style: "thin", color: { argb: "FFB0B8C4" } },
            right: { style: "thin", color: { argb: "FFB0B8C4" } },
        };
    });
    headerRow.height = 20;

    // Data rows
    rows.forEach((rowData, idx) => {
        const row = ws.getRow(3 + idx);
        const isEven = idx % 2 === 0;
        const bgArgb = isEven ? "FFFFFFFF" : "FFF5F7FA";
        const isHardLock = rowData["Hard Lock"] === "YES";

        COLUMNS.forEach((col, colIdx) => {
            const cell = row.getCell(colIdx + 1);
            cell.value = rowData[col.key] ?? "";

            cell.fill = isHardLock
                ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF0F0" } }
                : { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };

            cell.font = {
                size: 10,
                color: { argb: isHardLock ? "FFC0392B" : "FF111827" },
                bold: col.key === "Hard Lock" && isHardLock,
            };
            cell.alignment = { vertical: "middle" };
            cell.border = {
                top: { style: "hair", color: { argb: "FFE5E7EB" } },
                bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
                left: { style: "hair", color: { argb: "FFE5E7EB" } },
                right: { style: "hair", color: { argb: "FFE5E7EB" } },
            };

            if (col.currency && typeof cell.value === "number") {
                cell.numFmt = '"$"#,##0.00';
            }
        });
    });

    ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLUMNS.length } };

    return wb;
}

// ── Telegram send ─────────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("[financial-risk] TELEGRAM_BOT_TOKEN is not set.");
        process.exit(1);
    }
    if (!env.TELEGRAM_CHAT_ID) {
        console.error("[financial-risk] TELEGRAM_CHAT_ID is not set.");
        process.exit(1);
    }

    console.log(`[financial-risk] Reading ${env.COLLECTION_DB_PATH} ...`);
    const raw = await fs.readFile(env.COLLECTION_DB_PATH, "utf-8");
    const data = JSON.parse(raw);

    const rows = generateReportRows(data);
    const hardLockCount = rows.filter((r) => r["Hard Lock"] === "YES").length;
    const inCollectionCount = rows.filter((r) => r["Classification"] === "In Collections").length;

    console.log(`[financial-risk] ${rows.length} invoices, ${hardLockCount} hard locks, ${inCollectionCount} in collections.`);
    await sendMessage(`Generating Financial Risk Report (${rows.length} invoices)...`);

    const generatedAt = new Date();
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const fileName = `Financial_Risk_Report_${dateStamp}.xlsx`;
    const filePath = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);

    try {
        const wb = buildWorkbook(rows, generatedAt);
        await wb.xlsx.writeFile(filePath);

        const caption = `Financial Risk Report ${dateStamp} — ${rows.length} invoices | ${hardLockCount} hard locks | ${inCollectionCount} in collections`;
        await sendDocument(filePath, fileName, caption);
        console.log("[financial-risk] Sent successfully.");
    } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
    }
}

main().catch((err) => {
    console.error("[financial-risk] Fatal:", err.message);
    process.exit(1);
});
