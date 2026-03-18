import { Router } from "express";
import { isDatabaseReady } from "../config/db.js";
import Client from "../models/Client.js";
import { computeMetro2, cleanPhone, fmtMmddyyyy } from "../services/metro2.js";

const router = Router();

/**
 * POST /hooks/zoho
 * Receives webhook from Zoho CRM workflow rules when a Debtor record updates.
 * Upserts the client in MongoDB with fresh zohoData.
 * Expects the Zoho Entity ID or Carrier_ID as the key.
 */
router.post("/zoho", async (req, res) => {
    try {
        const payload = req.body;
        const clientId = String(
            payload.Carrier_ID || payload.id || payload.entity_id || ""
        ).trim();

        if (!clientId || ["null", "None", "0"].includes(clientId)) {
            return res.status(400).json({ error: "Missing clientId (Carrier_ID, id, or entity_id)" });
        }

        // Parse Zoho Debtor webhook into Metro 2 compatible fields
        const update = {
            clientId,
            companyName: payload.Name || payload.Account_Name || "",
            lastSyncedAt: new Date(),
            syncSource: "webhook",
        };

        // Map Zoho Debtor fields if present
        if (payload.Debt_Amount !== undefined) {
            update.amountPastDue = parseFloat(payload.Debt_Amount) || 0;
        }
        if (payload.Balance !== undefined) {
            update.currentBalance = Math.max(0, parseFloat(payload.Balance) || 0);
        }
        if (payload.Weekly_Credit_Limit !== undefined) {
            update.highestCredit = Math.floor(parseFloat(payload.Weekly_Credit_Limit) || 0);
            update.creditLimit = update.highestCredit;
        }
        if (payload.Phone) {
            update.phone = cleanPhone(payload.Phone);
        }
        if (payload.Active) {
            const isActive = payload.Active === "active";
            if (!isActive && payload.Fee_Types === "Charged") {
                update.accountStatus = "62"; // paid — was collection
                update.isClosed = true;
            }
        }
        if (payload.Fee_Types === "Charged") {
            update.accountStatus = "62";
        }

        // Unpaid_Invoices subform — find oldest Due_Date for delinquency
        if (Array.isArray(payload.Unpaid_Invoices) && payload.Unpaid_Invoices.length) {
            const dueDates = payload.Unpaid_Invoices
                .map((inv) => String(inv.Due_Date || "").trim())
                .filter((d) => d.length >= 10)
                .sort();
            if (dueDates.length) {
                update.dateFirstDelinquencyIso = dueDates[0];
                update.dateFirstDelinquency = fmtMmddyyyy(dueDates[0]);
                update.dateOpenIso = dueDates[0];
                update.dateOpen = fmtMmddyyyy(dueDates[0]);
            }
        }

        if (!isDatabaseReady()) {
            return res.status(503).json({ error: "Database not connected" });
        }

        await Client.findOneAndUpdate(
            { clientId },
            { $set: update },
            { upsert: true, new: true }
        );

        res.status(200).json({ success: true, clientId });
    } catch (err) {
        console.error("[webhook] Zoho hook error:", err.message);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
