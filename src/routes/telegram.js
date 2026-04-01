import fs from "fs/promises";
import os from "os";
import path from "path";
import { Router } from "express";
import { env } from "../config/env.js";
import { buildArrayReportFilename, loadReportCarriers, writeArrayReportFile } from "../services/arrayReport.js";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";
// WEX lookup — loaded lazily since it requires Playwright (not available on all servers)
let _lookupAndSaveDob = null;
async function getWexLookup() {
    if (!_lookupAndSaveDob) {
        try {
            const mod = await import("../services/wexHttp.js");
            _lookupAndSaveDob = mod.lookupAndSaveDob;
        } catch (err) {
            throw new Error("WEX lookup not available on this server (Playwright not installed)");
        }
    }
    return _lookupAndSaveDob;
}

const router = Router();

let commandsRegistered = false;

function hasTelegramConfig() {
    return Boolean(env.TELEGRAM_BOT_TOKEN);
}

// ── Auth system ──────────────────────────────────────────────────────────────

const AUTH_DB_PATH = path.resolve(process.cwd(), "db/telegram-auth.json");

async function loadAuthDb() {
    try {
        return JSON.parse(await fs.readFile(AUTH_DB_PATH, "utf-8"));
    } catch {
        return { roles: {}, users: {}, pending: {} };
    }
}

async function saveAuthDb(db) {
    await fs.writeFile(AUTH_DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function isAdmin(authDb, chatId) {
    const id = String(chatId);
    // First registered user or TELEGRAM_CHAT_ID is always admin
    if (id === String(env.TELEGRAM_CHAT_ID)) return true;
    const user = authDb.users[id];
    return user?.role === "admin";
}

function getUserPermissions(authDb, chatId) {
    const id = String(chatId);
    if (id === String(env.TELEGRAM_CHAT_ID)) return ["report", "import", "wex", "manage_users"];
    const user = authDb.users[id];
    if (!user) return [];
    const role = authDb.roles[user.role];
    return role?.permissions || [];
}

function hasPermission(authDb, chatId, permission) {
    return getUserPermissions(authDb, chatId).includes(permission);
}

// Map commands to required permissions
const COMMAND_PERMISSIONS = {
    "/report": "report",
    "/report_update": "report",
    "/report_collections": "report",
    "/wex": "wex",
};

async function loadTelegramUsers() {
    try {
        const raw = await fs.readFile(env.TELEGRAM_USERS_PATH, "utf-8");
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function saveTelegramUsers(users) {
    await fs.mkdir(path.dirname(env.TELEGRAM_USERS_PATH), { recursive: true });
    await fs.writeFile(env.TELEGRAM_USERS_PATH, JSON.stringify(users, null, 2), "utf-8");
}

/**
 * Handle /start — register user as pending, notify admin for approval.
 */
async function handleStart(chatId, message) {
    const authDb = await loadAuthDb();
    const id = String(chatId);

    // Already approved
    if (authDb.users[id]) {
        const user = authDb.users[id];
        await sendTelegramMessage(chatId, `You are approved as "${user.role}". Commands:\n/report — generate Array report\n/wex <id> <company> — DOB lookup`);
        return;
    }

    // Auto-approve if TELEGRAM_CHAT_ID (owner)
    if (id === String(env.TELEGRAM_CHAT_ID)) {
        authDb.users[id] = {
            chat_id: id,
            role: "admin",
            first_name: message?.from?.first_name || "",
            last_name: message?.from?.last_name || "",
            username: message?.from?.username || "",
            approved_at: new Date().toISOString(),
            approved_by: "system",
        };
        await saveAuthDb(authDb);
        await sendTelegramMessage(chatId, "You are the admin. Full access granted.");
        return;
    }

    // Add to pending
    authDb.pending[id] = {
        chat_id: id,
        first_name: message?.from?.first_name || "",
        last_name: message?.from?.last_name || "",
        username: message?.from?.username || "",
        requested_at: new Date().toISOString(),
    };
    await saveAuthDb(authDb);

    await sendTelegramMessage(chatId, "Access requested. An admin will approve you.");

    // Notify admin
    if (env.TELEGRAM_CHAT_ID) {
        const name = [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ");
        const username = message?.from?.username ? `@${message.from.username}` : "";
        await sendTelegramMessage(
            env.TELEGRAM_CHAT_ID,
            `New access request:\n` +
            `Name: ${name} ${username}\n` +
            `Chat ID: ${id}\n\n` +
            `To approve:\n/approve ${id} admin\n/approve ${id} manager\n/approve ${id} viewer`
        ).catch(() => {});
    }

    // Also save to telegram-users.json for backward compat
    const users = await loadTelegramUsers();
    users[id] = {
        chat_id: id,
        type: message?.chat?.type || "",
        first_name: message?.from?.first_name || "",
        last_name: message?.from?.last_name || "",
        username: message?.from?.username || "",
        started_at: users[id]?.started_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
    };
    await saveTelegramUsers(users);
}

/**
 * Handle /approve <chatId> <role> — admin approves a pending user.
 */
async function handleApprove(chatId, text) {
    const authDb = await loadAuthDb();
    if (!isAdmin(authDb, chatId)) {
        await sendTelegramMessage(chatId, "Only admins can approve users.");
        return;
    }

    const parts = text.replace(/^\/approve\s*/i, "").trim().split(/\s+/);
    const targetId = parts[0];
    const role = parts[1] || "viewer";

    if (!targetId) {
        // List pending users
        const pending = Object.values(authDb.pending);
        if (!pending.length) {
            await sendTelegramMessage(chatId, "No pending requests.");
            return;
        }
        let msg = "Pending requests:\n\n";
        for (const p of pending) {
            const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
            msg += `${p.chat_id} — ${name} ${p.username ? "@" + p.username : ""}\n`;
        }
        msg += "\nUsage: /approve <chatId> <role>\nRoles: admin, manager, viewer";
        await sendTelegramMessage(chatId, msg);
        return;
    }

    if (!authDb.roles[role]) {
        await sendTelegramMessage(chatId, `Unknown role "${role}". Available: ${Object.keys(authDb.roles).join(", ")}`);
        return;
    }

    const pending = authDb.pending[targetId];
    authDb.users[targetId] = {
        chat_id: targetId,
        role,
        first_name: pending?.first_name || "",
        last_name: pending?.last_name || "",
        username: pending?.username || "",
        approved_at: new Date().toISOString(),
        approved_by: String(chatId),
    };
    delete authDb.pending[targetId];
    await saveAuthDb(authDb);

    const name = [pending?.first_name, pending?.last_name].filter(Boolean).join(" ") || targetId;
    await sendTelegramMessage(chatId, `Approved ${name} as "${role}".`);
    await sendTelegramMessage(targetId, `You have been approved as "${role}". You can now use the bot.`).catch(() => {});
}

/**
 * Handle /revoke <chatId> — admin removes a user.
 */
async function handleRevoke(chatId, text) {
    const authDb = await loadAuthDb();
    if (!isAdmin(authDb, chatId)) {
        await sendTelegramMessage(chatId, "Only admins can revoke users.");
        return;
    }

    const targetId = text.replace(/^\/revoke\s*/i, "").trim();
    if (!targetId) {
        await sendTelegramMessage(chatId, "Usage: /revoke <chatId>");
        return;
    }

    if (authDb.users[targetId]) {
        const name = [authDb.users[targetId].first_name, authDb.users[targetId].last_name].filter(Boolean).join(" ");
        delete authDb.users[targetId];
        await saveAuthDb(authDb);
        await sendTelegramMessage(chatId, `Revoked access for ${name || targetId}.`);
        await sendTelegramMessage(targetId, "Your access has been revoked.").catch(() => {});
    } else {
        await sendTelegramMessage(chatId, `User ${targetId} not found.`);
    }
}

/**
 * Handle /users — admin lists all users.
 */
async function handleUsers(chatId) {
    const authDb = await loadAuthDb();
    if (!isAdmin(authDb, chatId)) {
        await sendTelegramMessage(chatId, "Only admins can list users.");
        return;
    }

    const approved = Object.values(authDb.users);
    const pending = Object.values(authDb.pending);

    let msg = `Approved users (${approved.length}):\n`;
    for (const u of approved) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
        msg += `  ${u.chat_id} — ${name} [${u.role}]\n`;
    }

    if (pending.length) {
        msg += `\nPending (${pending.length}):\n`;
        for (const p of pending) {
            const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
            msg += `  ${p.chat_id} — ${name}\n`;
        }
    }

    await sendTelegramMessage(chatId, msg);
}

router.get("/users", async (_req, res) => {
    try {
        const authDb = await loadAuthDb();
        res.json({
            approved: Object.values(authDb.users),
            pending: Object.values(authDb.pending),
            roles: authDb.roles,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function telegramUrl(method) {
    return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function callTelegram(method, payload) {
    if (!hasTelegramConfig()) {
        throw new Error("Telegram bot is not configured");
    }

    const response = await fetch(telegramUrl(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.description || `Telegram ${method} failed (${response.status})`);
    }
    return data;
}

async function sendTelegramMessage(chatId, text) {
    return callTelegram("sendMessage", {
        chat_id: String(chatId),
        text,
    });
}

async function sendTelegramDocument(chatId, filePath, fileName, caption) {
    if (!hasTelegramConfig()) {
        throw new Error("Telegram bot is not configured");
    }

    const form = new FormData();
    const fileBuffer = await fs.readFile(filePath);
    const blob = new Blob(
        [fileBuffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    );

    form.append("chat_id", String(chatId));
    if (caption) form.append("caption", caption);
    form.append("document", blob, fileName);

    const response = await fetch(telegramUrl("sendDocument"), {
        method: "POST",
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
        throw new Error(data.description || `Telegram sendDocument failed (${response.status})`);
    }
    return data;
}

function commandRequestsSync(text = "") {
    return /\b(sync|refresh|fresh|update)\b/i.test(String(text || ""));
}

function parseReportCommand(text = "") {
    const normalized = String(text || "").trim().toLowerCase();
    const command = normalized.split(/\s+/)[0];

    if (command === "/report_update") {
        return { mode: "report", syncFirst: true };
    }
    if (command === "/report_collections") {
        return { mode: "collections", syncFirst: false };
    }

    return {
        mode: "report",
        syncFirst: commandRequestsSync(normalized),
    };
}

async function generateAndSendArrayReport(chatId, { syncFirst = false, mode = "active" } = {}) {
    if (syncFirst) {
        await sendTelegramMessage(chatId, "Refreshing carrier-db.json before building the report...");
        const syncResult = await runCarrierDbSync();
        if (!syncResult?.success) {
            throw new Error(syncResult?.error || "Carrier DB sync failed");
        }
    } else {
        await sendTelegramMessage(chatId, "Generating the Array report from carrier-db.json...");
    }

    let carriers;
    if (mode === "collections") {
        // Carriers that have been sent to collections (collection_placement_date is set)
        carriers = loadReportCarriers({ include_inactive: "true" });
        carriers = carriers.filter((carrier) =>
            Boolean(carrier.collection_placement_date)
            || (Array.isArray(carrier.collection_placement_dates) && carrier.collection_placement_dates.length > 0)
        );
    } else {
        // LOC report: active + inactive, debtors excluded by loadReportCarriers default
        carriers = loadReportCarriers({ include_inactive: "true" });
    }
    if (!carriers.length) {
        throw new Error(
            mode === "collections"
                ? "No carriers with a collection date found in carrier-db.json."
                : "No carriers found in carrier-db.json. Run a sync first."
        );
    }

    const modeLabel = mode === "collections" ? "collections" : "";
    const fileName = buildArrayReportFilename(new Date(), modeLabel);
    const filePath = path.join(os.tmpdir(), `${Date.now()}-${fileName}`);

    try {
        const result = await writeArrayReportFile({
            carriers,
            filePath,
            compactOptional: true,
        });
        await sendTelegramDocument(
            chatId,
            filePath,
            fileName,
            `Array ${mode} report: ${result.rowCount} carriers, ${result.columnCount} columns`
        );
        return result;
    } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
    }
}

async function handleReportCommand(chatId, text) {
    try {
        const parsed = parseReportCommand(text);
        await generateAndSendArrayReport(chatId, {
            syncFirst: parsed.syncFirst,
            mode: parsed.mode,
        });
    } catch (err) {
        console.error("[telegram] report failed:", err.message);
        await sendTelegramMessage(chatId, `Report failed: ${err.message}`).catch(() => {});
    }
}

/**
 * Handle /wex command — look up DOB from WEX and save to dob.json.
 *
 * Usage:
 *   /wex <carrierId> <companyName>
 *   /wex 5798345 L&A Torres Trucking LLC
 */
async function handleWexCommand(chatId, text) {
    try {
        // Parse: /wex <carrierId> <rest is company name>
        const parts = text.replace(/^\/wex\s*/i, "").trim().split(/\s+/);
        const carrierId = parts[0] || "";
        const companyName = parts.slice(1).join(" ");

        if (!carrierId || !companyName) {
            await sendTelegramMessage(chatId, "Usage: /wex <carrierId> <companyName>\nExample: /wex 5798345 L&A Torres Trucking LLC");
            return;
        }

        await sendTelegramMessage(chatId, `Looking up DOB for carrier ${carrierId}: "${companyName}"...`);

        const lookupFn = await getWexLookup();
        const result = await lookupFn({ carrierId, companyName });

        if (result.status === "found") {
            await sendTelegramMessage(
                chatId,
                `DOB found for carrier ${carrierId}:\n` +
                `Name: ${result.firstName} ${result.lastName}\n` +
                `DOB: ${result.dob}\n` +
                `Source: WEX\n` +
                `Saved to dob.json`
            );
        } else {
            await sendTelegramMessage(
                chatId,
                `WEX lookup for ${carrierId} "${companyName}": ${result.status}` +
                (result.error ? `\nError: ${result.error}` : "")
            );
        }
    } catch (err) {
        console.error("[telegram] wex command failed:", err.message);
        await sendTelegramMessage(chatId, `WEX lookup failed: ${err.message}`).catch(() => {});
    }
}

/**
 * Handle document upload — if user sends an .xlsx file, import it as collection data.
 */
async function handleDocumentUpload(chatId, document) {
    try {
        const fileName = document.file_name || "";
        if (!fileName.toLowerCase().endsWith(".xlsx")) {
            await sendTelegramMessage(chatId, "Please send an .xlsx Excel file.");
            return;
        }

        await sendTelegramMessage(chatId, `Received "${fileName}". Importing...`);

        // Download file from Telegram
        const fileInfo = await callTelegram("getFile", { file_id: document.file_id });
        const filePath = fileInfo.result?.file_path;
        if (!filePath) throw new Error("Could not get file path from Telegram");

        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // Save to temp file
        const tmpPath = path.join(os.tmpdir(), `import-${Date.now()}-${fileName}`);
        await fs.writeFile(tmpPath, buffer);

        // Import using ExcelJS
        const ExcelJS = (await import("exceljs")).default;
        const collDbPath = path.resolve(process.cwd(), "db/collection-placement-db.json");

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(tmpPath);

        const sheet = wb.worksheets[0];
        if (!sheet) throw new Error("No sheet found in file");

        // Find columns
        const hRow = sheet.getRow(1);
        const colMap = {};
        for (let c = 1; c <= sheet.columnCount; c++) {
            const h = String(hRow.getCell(c).value || "").trim().toLowerCase();
            if (h.includes("carrier")) colMap.carrier_id = c;
            else if (h.includes("company")) colMap.company = c;
            else if (h.includes("delinq")) colMap.delinq = c;
            else if (h.includes("collection") || h.includes("sent")) colMap.sent = c;
        }

        if (!colMap.carrier_id || !colMap.company) {
            throw new Error("Missing columns: need 'Carrier ID' and 'Company Name'");
        }

        // Load existing DB
        let collDb = {};
        try { collDb = JSON.parse(await fs.readFile(collDbPath, "utf-8")); } catch {}

        const toIso = (v) => {
            if (!v) return "";
            if (v instanceof Date) return v.toISOString().slice(0, 10);
            const s = String(v).trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
            const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
            return "";
        };
        const normalizeKey = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

        let added = 0, updated = 0, skipped = 0;

        for (let r = 2; r <= sheet.rowCount; r++) {
            const row = sheet.getRow(r);
            const carrierId = String(row.getCell(colMap.carrier_id).value || "").trim();
            const company = String(row.getCell(colMap.company).value || "").trim();
            if (!carrierId || !company || carrierId.toLowerCase() === "required") continue;

            const key = normalizeKey(company);
            if (!key) { skipped++; continue; }

            const delinqDate = colMap.delinq ? toIso(row.getCell(colMap.delinq).value) : "";
            const sentDate = colMap.sent ? toIso(row.getCell(colMap.sent).value) : "";

            if (!collDb[key]) {
                collDb[key] = {
                    company,
                    debtor_type: "BadDebtor",
                    date_of_delinquency: delinqDate,
                    sent_to_collection_date: sentDate || delinqDate,
                    collection_source: "telegram-import",
                    invoices: [{
                        invoice_status: "Pending", debtor_type: "BadDebtor",
                        collections_agent: null, billing_cycle: null,
                        invoice_number: null, invoice_date: delinqDate,
                        total_amount: 0, total_paid: null, remaining_amount: 0,
                        fee_25pct: null, total_remaining: null,
                        placement_date: sentDate || delinqDate,
                        owner_name: null, dob: null,
                        id_number: Number(carrierId) || carrierId,
                        commercial_consumer: "Commercial",
                        phone: null, email: null, address: null, state: null,
                        county: null, city: null, zip: null, sales_agent: null,
                        language: null, usdot: null, mn: null,
                        collection_dustin: null, collection_status_dustin: null,
                        amt_collected_agency_dustin: null, collection_transferred_date_dustin: null,
                        collection_condition_45_days_dustin: null, collection_deadline_dustin: null,
                        collection_trustaltus: null, collection_status_trustaltus: null,
                        amt_collected_agency_trustaltus: null, collection_transferred_date_trustaltus: null,
                        collection_condition_120_days_trustaltus: null, collection_deadline_trustaltus: null,
                        collection_ic_system: null, collection_status_ic_system: null,
                        amt_collected_agency_ic_system: null, collection_transferred_date_ic_system: null,
                        collection_condition_120_days_ic_system: null, collection_deadline_ic_system: null,
                        jennifer_hoover: null, jennifer_chrestman: null,
                        via_alla: null, transferred_date_alla: null,
                        sueing_status_alla: null, credit_beraue_reporting: null,
                        wage_garnishment: null, bank_levy: null, property_lien: null,
                        overall_status: null,
                    }],
                    collection_cases: sentDate ? [{
                        company: "TSS", account_executive: "N/A", operating_unit: null,
                        debtor_name: company, cust_ref: null, service_date: delinqDate,
                        debtor_id: Number(carrierId) || carrierId, date_placed: sentDate,
                        principal: 0, interest: 0, other: 0, client_fee: 0,
                        total_dues: 0, amt_collected: 0, balance: 0, age: null,
                        last_pay_date: null, last_pay_amnt: null,
                        date_closed: null, status: "Open", description: null,
                    }] : [],
                };
                added++;
            } else {
                const entry = collDb[key];
                let changed = false;
                if (delinqDate && delinqDate !== entry.date_of_delinquency) {
                    entry.date_of_delinquency = delinqDate;
                    changed = true;
                }
                if (sentDate) {
                    const cases = entry.collection_cases || [];
                    if (!cases.some(c => c.date_placed === sentDate)) {
                        cases.push({
                            company: "TSS", account_executive: "N/A", operating_unit: null,
                            debtor_name: company, cust_ref: null,
                            service_date: delinqDate || entry.date_of_delinquency,
                            debtor_id: Number(carrierId) || carrierId, date_placed: sentDate,
                            principal: 0, interest: 0, other: 0, client_fee: 0,
                            total_dues: 0, amt_collected: 0, balance: 0, age: null,
                            last_pay_date: null, last_pay_amnt: null,
                            date_closed: null, status: "Open", description: null,
                        });
                        entry.collection_cases = cases;
                        changed = true;
                    }
                }
                if (changed) updated++;
                else skipped++;
            }
        }

        // Save
        await fs.writeFile(collDbPath, JSON.stringify(collDb, null, 2), "utf-8");

        // Cleanup temp file
        await fs.rm(tmpPath, { force: true }).catch(() => {});

        await sendTelegramMessage(
            chatId,
            `Import complete:\n` +
            `  Added: ${added}\n` +
            `  Updated: ${updated}\n` +
            `  Skipped: ${skipped}\n` +
            `  Total in DB: ${Object.keys(collDb).length}`
        );
    } catch (err) {
        console.error("[telegram] import failed:", err.message);
        await sendTelegramMessage(chatId, `Import failed: ${err.message}`).catch(() => {});
    }
}

async function setTelegramCommands() {
    if (!hasTelegramConfig() || commandsRegistered) return;
    await callTelegram("setMyCommands", {
        commands: [
            { command: "start", description: "Register for report delivery" },
            { command: "report", description: "Generate Array report (all carriers)" },
            { command: "report_update", description: "Sync data, then generate report" },
            { command: "report_collections", description: "Carriers with a collection sent date" },
            { command: "wex", description: "WEX DOB lookup: /wex <carrierId> <companyName>" },
            { command: "approve", description: "Admin: approve user /approve <chatId> <role>" },
            { command: "revoke", description: "Admin: revoke user /revoke <chatId>" },
            { command: "users", description: "Admin: list all users" },
        ],
    });
    commandsRegistered = true;
    console.log("[telegram] Bot commands registered.");
}

export async function bootTelegramBot() {
    try {
        await setTelegramCommands();
    } catch (err) {
        console.warn("[telegram] Could not register bot commands:", err.message);
    }
}

router.get("/register-webhook", async (req, res) => {
    if (!hasTelegramConfig()) {
        return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not set" });
    }

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.query.host || `${proto}://${req.get("host")}`;
    const webhookUrl = new URL("/telegram/webhook", host).toString();
    const body = {
        url: webhookUrl,
        allowed_updates: ["message"],
    };
    if (env.TELEGRAM_SECRET_TOKEN) {
        body.secret_token = env.TELEGRAM_SECRET_TOKEN;
    }

    try {
        const response = await callTelegram("setWebhook", body);
        res.json({ webhookUrl, telegram: response });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/webhook-info", async (_req, res) => {
    if (!hasTelegramConfig()) {
        return res.status(500).json({ error: "TELEGRAM_BOT_TOKEN not set" });
    }

    try {
        const response = await fetch(telegramUrl("getWebhookInfo"));
        res.json(await response.json());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/report", async (req, res) => {
    const chatId = req.body?.chatId || env.TELEGRAM_CHAT_ID;
    if (!chatId) {
        return res.status(400).json({ error: "chatId is required or TELEGRAM_CHAT_ID must be set" });
    }

    res.json({ ok: true, status: "started" });
    void handleReportCommand(chatId, req.body?.text || "");
});

// Direct HTTP endpoint for WEX lookup (can be called without Telegram)
router.post("/wex-lookup", async (req, res) => {
    const { carrierId, companyName, firstName, lastName } = req.body || {};
    if (!carrierId || !companyName) {
        return res.status(400).json({ error: "carrierId and companyName are required" });
    }
    try {
        const lookupFn = await getWexLookup();
        const result = await lookupFn({ carrierId, companyName, firstName, lastName });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/webhook", async (req, res) => {
    if (env.TELEGRAM_SECRET_TOKEN) {
        const token = req.headers["x-telegram-bot-api-secret-token"];
        if (token !== env.TELEGRAM_SECRET_TOKEN) {
            return res.status(401).json({ error: "Unauthorized" });
        }
    }

    const message = req.body?.message;
    const text = String(message?.text || "").trim();
    const chatId = message?.chat?.id;

    if (!chatId) {
        return res.json({ ok: true, ignored: true });
    }

    const authDb = await loadAuthDb();
    const commandToken = text.toLowerCase().split(/\s+/)[0];

    // /start — request access (no auth required)
    if (commandToken === "/start") {
        res.json({ ok: true, status: "started" });
        void handleStart(chatId, message);
        return;
    }

    // Admin commands — no permission check beyond isAdmin
    if (commandToken === "/approve") {
        res.json({ ok: true, status: "started" });
        void handleApprove(chatId, text);
        return;
    }
    if (commandToken === "/revoke") {
        res.json({ ok: true, status: "started" });
        void handleRevoke(chatId, text);
        return;
    }
    if (commandToken === "/users") {
        res.json({ ok: true, status: "started" });
        void handleUsers(chatId);
        return;
    }

    // Auth check — must be approved user
    if (!authDb.users[String(chatId)] && String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
        await sendTelegramMessage(chatId, "Not authorized. Send /start to request access.").catch(() => {});
        return res.json({ ok: true, status: "unauthorized" });
    }

    // Document upload — needs "import" permission
    const document = message?.document;
    if (document) {
        if (!hasPermission(authDb, chatId, "import")) {
            await sendTelegramMessage(chatId, "You don't have import permission. Ask an admin to upgrade your role.").catch(() => {});
            return res.json({ ok: true, status: "forbidden" });
        }
        res.json({ ok: true, status: "importing" });
        void handleDocumentUpload(chatId, document);
        return;
    }

    // Command permission check
    const requiredPerm = COMMAND_PERMISSIONS[commandToken];
    if (requiredPerm && !hasPermission(authDb, chatId, requiredPerm)) {
        await sendTelegramMessage(chatId, `You don't have "${requiredPerm}" permission.`).catch(() => {});
        return res.json({ ok: true, status: "forbidden" });
    }

    const supportedCommands = ["/report", "/report_update", "/report_collections", "/wex"];
    if (!supportedCommands.includes(commandToken)) {
        return res.json({ ok: true, ignored: true });
    }

    if (commandToken === "/wex") {
        res.json({ ok: true, status: "started" });
        void handleWexCommand(chatId, text);
        return;
    }

    res.json({ ok: true, status: "started" });
    void handleReportCommand(chatId, text);
});

export default router;
