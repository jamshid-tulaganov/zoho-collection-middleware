import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

function resolveFromProjectRoot(value, fallbackAbsolutePath) {
    const raw = value && String(value).trim();
    if (!raw) return fallbackAbsolutePath;
    return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

// Load .env from project root (collections/.env)
const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

// Also try loading from telegram-bot/.env for shared credentials
const telegramEnvPath = path.resolve(__dirname, "../../../telegram-bot/.env");
if (fs.existsSync(telegramEnvPath)) {
    dotenv.config({ path: telegramEnvPath, override: false });
}

// Also try loading from servercrm/.env for shared Telegram credentials
const serverCrmEnvPath = path.resolve(__dirname, "../../../servercrm/.env");
if (fs.existsSync(serverCrmEnvPath)) {
    dotenv.config({ path: serverCrmEnvPath, override: false });
}

export const env = {
    PORT: Number(process.env.PORT || 3001),
    MONGODB_URI: process.env.MONGODB_URI || "",

    // Zoho CRM
    ZOHO_BASE_URL: process.env.ZOHO_BASE_URL || "https://www.zohoapis.com",
    ZOHO_ACCOUNTS_URL: process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com",
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID || "",
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET || "",
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN || "",
    ZOHO_ACCESS_TOKEN: process.env.ZOHO_ACCESS_TOKEN || "",

    // SMP (CMP)
    SMP_BASE_URL: process.env.SMP_BASE_URL || "https://tssfuelmanager.com:8443",
    SMP_USERNAME: process.env.SMP_USERNAME || "cmpadmin",
    SMP_PASSWORD: process.env.SMP_PASSWORD || "",

    // Telegram bot
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
    TELEGRAM_SECRET_TOKEN: process.env.TELEGRAM_SECRET_TOKEN || "",

    // Master DB (common carriers — replaces debtor-master-db.json)
    MASTER_DB_PATH: resolveFromProjectRoot(
        process.env.MASTER_DB_PATH,
        path.resolve(projectRoot, "db/common-carriers-db.json")
    ),

    // Live snapshot of fetched SMP (CMP) companies — written on each sync
    CMP_DATA_PATH: resolveFromProjectRoot(
        process.env.CMP_DATA_PATH,
        path.resolve(projectRoot, "db/cmp-data.json")
    ),

    // Live snapshot of fetched Zoho deals — written on each sync
    ZOHO_DEALS_PATH: resolveFromProjectRoot(
        process.env.ZOHO_DEALS_PATH,
        path.resolve(projectRoot, "db/zoho-deals.json")
    ),

    // Accounting spreadsheet data converted to JSON for contact fallback
    ACCOUNTING_DB_PATH: resolveFromProjectRoot(
        process.env.ACCOUNTING_DB_PATH,
        path.resolve(projectRoot, "db/accounting-client-db.json")
    ),

    // SMP incremental-sync cache — stores all invoices + billing history between full resyncs.
    // On each sync only today's new records are fetched and merged in, cutting sync time from
    // ~10 min down to seconds after the first full fetch.
    SMP_CACHE_PATH: resolveFromProjectRoot(
        process.env.SMP_CACHE_PATH,
        path.resolve(projectRoot, "db/smp-data-cache.json")
    ),

    // Collection / bad-debtor spreadsheet data converted to JSON by invoice number
    COLLECTION_DB_PATH: resolveFromProjectRoot(
        process.env.COLLECTION_DB_PATH,
        path.resolve(projectRoot, "db/collection-placement-db.json")
    ),

    // Carrier DB (live file-based cache — updated daily by syncCarrierDb.js)
    // Default: collections/data/carrier-db.json  (override with CARRIER_DB_PATH env var)
    CARRIER_DB_PATH: resolveFromProjectRoot(
        process.env.CARRIER_DB_PATH,
        path.resolve(projectRoot, "data/carrier-db.json")
    ),

    TELEGRAM_USERS_PATH: resolveFromProjectRoot(
        process.env.TELEGRAM_USERS_PATH,
        path.resolve(projectRoot, "data/telegram-users.json")
    ),

    // Zoho Sheet
    ZOHO_SHEET_WORKBOOK_ID: process.env.ZOHO_SHEET_WORKBOOK_ID || "",
    ZOHO_SHEET_NAME: process.env.ZOHO_SHEET_NAME || "Octane Array Report - New",

    // iSoftPull (Playwright login)
    ISOFTPULL_EMAIL: process.env.ISOFTPULL_EMAIL || "",
    ISOFTPULL_PASSWORD: process.env.ISOFTPULL_PASSWORD || "",

    // WEX (Salesforce Experience Cloud)
    WEX_EMAIL: process.env.WEX_EMAIL || "",
    WEX_PASSWORD: process.env.WEX_PASSWORD || "",
    WEX_HEADLESS: process.env.WEX_HEADLESS !== "false",

    // Browserless.io (remote Chrome for WEX token on Render)
    BROWSERLESS_TOKEN: process.env.BROWSERLESS_TOKEN || "",
};

export function validateEnvironment() {
    const missing = [];
    if (!env.SMP_PASSWORD) missing.push("SMP_PASSWORD");
    if (!env.ZOHO_CLIENT_ID) missing.push("ZOHO_CLIENT_ID");
    if (!env.ZOHO_CLIENT_SECRET) missing.push("ZOHO_CLIENT_SECRET");
    if (!env.ZOHO_REFRESH_TOKEN) missing.push("ZOHO_REFRESH_TOKEN");
    if (missing.length) {
        console.warn(`[env] Missing: ${missing.join(", ")} — some features may not work.`);
    }
}
