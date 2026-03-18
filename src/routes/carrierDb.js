/**
 * carrierDb.js — HTTP endpoints for carrier-db.json sync and status.
 *
 * POST /carrier-db/sync        — trigger a full sync (runs in background)
 * GET  /carrier-db/status      — sync status + coverage stats
 * GET  /carrier-db/carriers    — read carrier-db.json (paginated / filtered)
 * GET  /carrier-db/carriers/:id — single carrier entry
 */

import { Router } from "express";
import {
    runCarrierDbSync,
    getCarrierDbSyncStatus,
    getCarrierDbStatusSnapshot,
    readCarrierDb,
} from "../services/syncCarrierDb.js";

const router = Router();

// ── POST /carrier-db/sync ────────────────────────────────────────────────────

router.post("/sync", async (req, res) => {
    const status = getCarrierDbSyncStatus();
    if (status.inProgress) {
        return res.status(409).json({ message: "Sync already in progress", status });
    }

    // Respond immediately — run sync in background
    res.json({ message: "Carrier DB sync started", status: "running" });

    runCarrierDbSync().catch((err) =>
        console.error("[carrier-db] Background sync error:", err.message)
    );
});

// ── GET /carrier-db/status ───────────────────────────────────────────────────

router.get("/status", (req, res) => {
    res.json(getCarrierDbStatusSnapshot());
});

// ── GET /carrier-db/carriers ─────────────────────────────────────────────────

router.get("/carriers", (req, res) => {
    let db;
    try {
        db = readCarrierDb();
    } catch (err) {
        return res.status(500).json({ error: "Failed to read carrier-db.json: " + err.message });
    }

    let entries = Object.values(db);
    const total = entries.length;

    // Filter
    if (req.query.debtors === "true")  entries = entries.filter((c) => c.derived?.is_debtor);
    if (req.query.debtors === "false") entries = entries.filter((c) => !c.derived?.is_debtor);
    if (req.query.ggr === "true")      entries = entries.filter((c) => c.ggr_data);
    if (req.query.missing_dob === "true") entries = entries.filter((c) => !c.derived?.dob);

    // Sort by carrier_id
    entries.sort((a, b) => a.carrier_id.localeCompare(b.carrier_id));

    // Paginate
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const start = (page - 1) * limit;
    const paged = entries.slice(start, start + limit);

    res.json({
        total,
        filtered: entries.length,
        page,
        limit,
        data: paged,
    });
});

// ── GET /carrier-db/carriers/:id ─────────────────────────────────────────────

router.get("/carriers/:id", (req, res) => {
    let db;
    try {
        db = readCarrierDb();
    } catch (err) {
        return res.status(500).json({ error: "Failed to read carrier-db.json: " + err.message });
    }

    const cid = req.params.id;
    const entry = db[cid];
    if (!entry) {
        return res.status(404).json({ error: `Carrier ${cid} not found in carrier-db.json` });
    }

    res.json(entry);
});

export default router;
