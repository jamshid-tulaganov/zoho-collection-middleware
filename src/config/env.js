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

    // Master DB (offline spreadsheet data)
    MASTER_DB_PATH: resolveFromProjectRoot(
        process.env.MASTER_DB_PATH,
        path.resolve(projectRoot, "db/debtor-master-db.json")
    ),

    // Carrier DB (live file-based cache — updated daily by syncCarrierDb.js)
    // Default: collections/data/carrier-db.json  (override with CARRIER_DB_PATH env var)
    CARRIER_DB_PATH: resolveFromProjectRoot(
        process.env.CARRIER_DB_PATH,
        path.resolve(projectRoot, "data/carrier-db.json")
    ),

    // Zoho Sheet
    ZOHO_SHEET_WORKBOOK_ID: process.env.ZOHO_SHEET_WORKBOOK_ID || "",
    ZOHO_SHEET_NAME: process.env.ZOHO_SHEET_NAME || "Octane Array Report - New",
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
