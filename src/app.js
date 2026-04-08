import fs from "fs";
import path from "path";
import express from "express";
import hooksRouter from "./routes/hooks.js";
import reportsRouter from "./routes/reports.js";
import carrierDbRouter from "./routes/carrierDb.js";
import telegramRouter from "./routes/telegram.js";
// wex routes loaded conditionally (requires playwright — local only)
let wexRouter = null;
try {
    wexRouter = (await import("./routes/wex.js")).default;
} catch (_) {}
import { runFullSync, runDebtorSync, getSyncStatus } from "./services/sync.js";
import {
    getCarrierDbSyncStatus,
    getCarrierDbStatusSnapshot,
    runCarrierDbSync,
} from "./services/syncCarrierDb.js";
import { isDatabaseReady } from "./config/db.js";
import { env } from "./config/env.js";
import Carrier from "./models/Carrier.js";
import Invoice from "./models/Invoice.js";
import DebtorPeriod from "./models/DebtorPeriod.js";
import PaymentMonth from "./models/PaymentMonth.js";
import Transaction from "./models/Transaction.js";

export function createApp() {
    const app = express();

    app.use(express.json({ limit: "5mb" }));

    // ── Health check ──
    app.get("/", async (req, res) => {
        const counts = {};
        if (isDatabaseReady()) {
            counts.carriers = await Carrier.countDocuments();
            counts.invoices = await Invoice.countDocuments();
            counts.debtorPeriods = await DebtorPeriod.countDocuments();
            counts.paymentMonths = await PaymentMonth.countDocuments();
            counts.transactions = await Transaction.countDocuments();
        }
        res.json({
            status: "ok",
            service: "collection-middleware",
            collections: counts,
            sync: getSyncStatus(),
            carrierDbSync: getCarrierDbSyncStatus(),
        });
    });

    // ── Webhook routes ──
    app.use("/hooks", hooksRouter);

    // ── Report routes ──
    app.use("/reports", reportsRouter);

    // ── Carrier DB (file-based cache) ──
    app.use("/carrier-db", carrierDbRouter);

    // ── Telegram webhook / bot-driven report delivery ──
    app.use("/telegram", telegramRouter);

    // ── WEX DOB lookup (local only — requires playwright) ──
    if (wexRouter) app.use("/wex", wexRouter);

    // Convenience aliases matching the carrier-db plan
    const triggerCarrierDbSync = async (req, res) => {
        const status = getCarrierDbSyncStatus();
        if (status.inProgress) {
            return res.status(409).json({ message: "Sync already in progress", status });
        }

        res.json({ message: "Carrier DB sync started", status: "running" });
        runCarrierDbSync().catch((err) =>
            console.error("[carrier-db] Background sync error:", err.message)
        );
    };

    app.get("/sync-carrier-db", triggerCarrierDbSync);
    app.post("/sync-carrier-db", triggerCarrierDbSync);

    app.get("/carrier-db-status", (req, res) => {
        res.json(getCarrierDbStatusSnapshot());
    });

    // ── Sync triggers ──

    app.post("/sync/full", async (req, res) => {
        try {
            res.json({ message: "Full sync started", status: "running" });
            runFullSync().catch((err) => console.error("[sync] Background full sync error:", err.message));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/sync/debtors", async (req, res) => {
        try {
            res.json({ message: "Debtor sync started", status: "running" });
            runDebtorSync().catch((err) => console.error("[sync] Background debtor sync error:", err.message));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/sync/status", (req, res) => {
        res.json(getSyncStatus());
    });

    // ── Import debtor-master-db.json → separate MongoDB collections ──
    app.post("/sync/import-master-db", async (req, res) => {
        try {
            if (!isDatabaseReady()) {
                return res.status(503).json({ error: "Database not connected" });
            }

            const dbPath = path.resolve(env.MASTER_DB_PATH);
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: `debtor-master-db.json not found at ${dbPath}` });
            }

            console.log("[import] Loading debtor-master-db.json...");
            const masterDb = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
            const cids = Object.keys(masterDb);

            const stats = { carriers: 0, invoices: 0, debtorPeriods: 0, paymentMonths: 0 };

            // Batch arrays for bulk inserts
            const invoiceBatch = [];
            const debtorPeriodBatch = [];
            const paymentMonthBatch = [];

            for (const cid of cids) {
                const entry = masterDb[cid];

                // 1) Upsert Carrier
                await Carrier.findOneAndUpdate(
                    { carrierId: cid },
                    {
                        $set: {
                            carrierId: cid,
                            company: entry.company || "",
                            billingCycle: entry.billing_cycle || "",
                            creditScore: entry.credit_score || 0,
                            debtorSources: entry.debtor_sources || [],
                            isDebtor: (entry.debtor_sources || []).length > 0,
                            earliestDelinquencyPeriodEnd: entry.earliest_delinquency_period_end || null,
                            totalDebt: entry.total_debt || 0,
                            totalCollected: entry.total_collected || 0,
                        },
                    },
                    { upsert: true }
                );
                stats.carriers++;

                // 2) Collect Invoices
                for (const inv of entry.invoices || []) {
                    invoiceBatch.push({
                        carrierId: cid,
                        invoiceDate: inv.invoice_date || null,
                        invoiceNumber: inv.invoice_number || null,
                        invoiceAmount: inv.invoice_amount || 0,
                        openingBalance: inv.opening_balance || 0,
                        paymentDate: inv.payment_date || null,
                        paymentAmount: inv.payment_amount || 0,
                        endingBalance: inv.ending_balance || 0,
                        source: inv.source || "full_verification",
                    });
                }

                // 3) Collect DebtorPeriods
                for (const dp of entry.debtor_periods || []) {
                    debtorPeriodBatch.push({
                        carrierId: cid,
                        source: dp.source || "",
                        period: dp.period || null,
                        periodStart: dp.period_start || null,
                        periodEnd: dp.period_end || null,
                        amount: dp.amount || 0,
                        amountCollected: dp.amount_collected || 0,
                    });
                }

                // 4) Collect PaymentMonths
                for (const [ym, pm] of Object.entries(entry.payment_months || {})) {
                    paymentMonthBatch.push({
                        carrierId: cid,
                        yearMonth: ym,
                        totalInvoiced: pm.total_invoiced || 0,
                        totalPaid: pm.total_paid || 0,
                        unpaidCount: pm.unpaid_count || 0,
                    });
                }

                if (stats.carriers % 500 === 0) {
                    console.log(`[import] ... ${stats.carriers} carriers processed`);
                }
            }

            // Bulk write invoices (drop old + insert fresh)
            console.log(`[import] Writing ${invoiceBatch.length} invoices...`);
            await Invoice.deleteMany({});
            if (invoiceBatch.length) {
                // Insert in chunks of 5000 to avoid memory issues
                for (let i = 0; i < invoiceBatch.length; i += 5000) {
                    const chunk = invoiceBatch.slice(i, i + 5000);
                    await Invoice.insertMany(chunk, { ordered: false });
                    stats.invoices += chunk.length;
                    console.log(`[import]   invoices: ${stats.invoices}/${invoiceBatch.length}`);
                }
            }

            // Bulk write debtor periods
            console.log(`[import] Writing ${debtorPeriodBatch.length} debtor periods...`);
            await DebtorPeriod.deleteMany({});
            if (debtorPeriodBatch.length) {
                await DebtorPeriod.insertMany(debtorPeriodBatch, { ordered: false });
                stats.debtorPeriods = debtorPeriodBatch.length;
            }

            // Bulk write payment months
            console.log(`[import] Writing ${paymentMonthBatch.length} payment months...`);
            await PaymentMonth.deleteMany({});
            if (paymentMonthBatch.length) {
                for (let i = 0; i < paymentMonthBatch.length; i += 5000) {
                    const chunk = paymentMonthBatch.slice(i, i + 5000);
                    await PaymentMonth.insertMany(chunk, { ordered: false });
                    stats.paymentMonths += chunk.length;
                }
            }

            console.log("[import] Done.", stats);

            res.json({
                success: true,
                ...stats,
                debtors: cids.filter((c) => (masterDb[c].debtor_sources || []).length > 0).length,
            });
        } catch (err) {
            console.error("[import] Error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Query endpoints for individual collections ──

    // GET /carriers?debtors=true&limit=50
    app.get("/carriers", async (req, res) => {
        if (!isDatabaseReady()) return res.status(503).json({ error: "DB not connected" });
        const filter = {};
        if (req.query.debtors === "true") filter.isDebtor = true;
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const carriers = await Carrier.find(filter).sort({ carrierId: 1 }).limit(limit).lean();
        res.json({ count: carriers.length, data: carriers });
    });

    // GET /carriers/:id — full carrier detail with related data
    app.get("/carriers/:id", async (req, res) => {
        if (!isDatabaseReady()) return res.status(503).json({ error: "DB not connected" });
        const cid = req.params.id;
        const [carrier, invoices, periods, months, txns] = await Promise.all([
            Carrier.findOne({ carrierId: cid }).lean(),
            Invoice.find({ carrierId: cid }).sort({ invoiceDate: -1 }).lean(),
            DebtorPeriod.find({ carrierId: cid }).sort({ periodEnd: -1 }).lean(),
            PaymentMonth.find({ carrierId: cid }).sort({ yearMonth: -1 }).lean(),
            Transaction.find({ carrierId: cid }).sort({ createDate: -1 }).lean(),
        ]);
        if (!carrier) return res.status(404).json({ error: "Carrier not found" });
        res.json({ carrier, invoices, debtorPeriods: periods, paymentMonths: months, transactions: txns });
    });

    return app;
}
