import fs from "fs/promises";
import os from "os";
import path from "path";
import { Router } from "express";
import { env } from "../config/env.js";
import { buildArrayReportFilename, loadReportCarriers, writeArrayReportFile } from "../services/arrayReport.js";
import { runCarrierDbSync } from "../services/syncCarrierDb.js";

const router = Router();

let commandsRegistered = false;

function hasTelegramConfig() {
    return Boolean(env.TELEGRAM_BOT_TOKEN);
}

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

async function registerTelegramUser(message) {
    const chatId = message?.chat?.id;
    if (!chatId) return null;

    const users = await loadTelegramUsers();
    const key = String(chatId);
    users[key] = {
        chat_id: key,
        type: message?.chat?.type || "",
        first_name: message?.from?.first_name || "",
        last_name: message?.from?.last_name || "",
        username: message?.from?.username || "",
        started_at: users[key]?.started_at || new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
    };
    await saveTelegramUsers(users);
    return users[key];
}

router.get("/users", async (_req, res) => {
    try {
        const users = await loadTelegramUsers();
        const data = Object.values(users).sort((a, b) =>
            String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""))
        );
        res.json({
            count: data.length,
            data,
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

async function generateAndSendArrayReport(chatId, { syncFirst = false } = {}) {
    if (syncFirst) {
        await sendTelegramMessage(chatId, "Refreshing carrier-db.json before building the report...");
        const syncResult = await runCarrierDbSync();
        if (!syncResult?.success) {
            throw new Error(syncResult?.error || "Carrier DB sync failed");
        }
    } else {
        await sendTelegramMessage(chatId, "Generating the Array report from carrier-db.json...");
    }

    const carriers = loadReportCarriers({});
    if (!carriers.length) {
        throw new Error("carrier-db.json is empty. Run a sync first.");
    }

    const fileName = buildArrayReportFilename(new Date());
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
            `Array report ready: ${result.rowCount} carriers, ${result.columnCount} columns`
        );
        return result;
    } finally {
        await fs.rm(filePath, { force: true }).catch(() => {});
    }
}

async function handleReportCommand(chatId, text) {
    try {
        await generateAndSendArrayReport(chatId, {
            syncFirst: commandRequestsSync(text),
        });
    } catch (err) {
        console.error("[telegram] report failed:", err.message);
        await sendTelegramMessage(chatId, `Report failed: ${err.message}`).catch(() => {});
    }
}

async function setTelegramCommands() {
    if (!hasTelegramConfig() || commandsRegistered) return;
    await callTelegram("setMyCommands", {
        commands: [
            { command: "start", description: "Register for report delivery" },
            { command: "report", description: "Generate Array credit report" },
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

    if (text.toLowerCase().startsWith("/start")) {
        res.json({ ok: true, status: "registered" });
        try {
            const user = await registerTelegramUser(message);
            await sendTelegramMessage(
                chatId,
                `You are registered. Your chat ID is ${user.chat_id}. Send /report anytime and I will send the file here.`
            );
        } catch (err) {
            console.error("[telegram] start failed:", err.message);
            await sendTelegramMessage(chatId, `Registration failed: ${err.message}`).catch(() => {});
        }
        return;
    }

    if (!text.toLowerCase().startsWith("/report")) {
        return res.json({ ok: true, ignored: true });
    }

    res.json({ ok: true, status: "started" });
    void handleReportCommand(chatId, text);
});

export default router;
