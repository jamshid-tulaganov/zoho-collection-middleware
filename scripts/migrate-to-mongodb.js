/**
 * Migrate all JSON databases to MongoDB.
 *
 * Usage:
 *   node scripts/migrate-to-mongodb.js              # migrate all
 *   node scripts/migrate-to-mongodb.js --only=carrier-db,dob   # migrate specific
 *   node scripts/migrate-to-mongodb.js --drop        # drop existing collections first
 *
 * Requires MONGODB_URI in .env
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load env
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(projectRoot, ".env") });

// Import models
import CarrierData from "../src/models/CarrierData.js";
import CollectionPlacement from "../src/models/CollectionPlacement.js";
import PaymentVerification from "../src/models/PaymentVerification.js";
import AccountingClient from "../src/models/AccountingClient.js";
import MasterCarrier from "../src/models/MasterCarrier.js";
import DobEntry from "../src/models/DobEntry.js";

const BATCH_SIZE = 500;
const args = process.argv.slice(2);
const dropFirst = args.includes("--drop");
const onlyFlag = args.find((a) => a.startsWith("--only="));
const onlyDbs = onlyFlag ? onlyFlag.split("=")[1].split(",") : null;

function shouldMigrate(name) {
    return !onlyDbs || onlyDbs.includes(name);
}

function readJson(relPath) {
    const full = path.resolve(projectRoot, relPath);
    if (!fs.existsSync(full)) {
        console.log(`  [SKIP] ${relPath} not found`);
        return null;
    }
    const raw = fs.readFileSync(full, "utf8");
    return JSON.parse(raw);
}

async function bulkUpsert(Model, docs, keyField, label) {
    if (!docs.length) {
        console.log(`  [${label}] No documents to insert.`);
        return;
    }

    if (dropFirst) {
        await Model.deleteMany({});
        console.log(`  [${label}] Dropped existing collection.`);
    }

    let inserted = 0;
    let updated = 0;
    let errors = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const batch = docs.slice(i, i + BATCH_SIZE);
        const ops = batch.map((doc) => ({
            updateOne: {
                filter: { [keyField]: doc[keyField] },
                update: { $set: doc },
                upsert: true,
            },
        }));

        try {
            const result = await Model.bulkWrite(ops, { ordered: false });
            inserted += result.upsertedCount || 0;
            updated += result.modifiedCount || 0;
        } catch (err) {
            // Count individual write errors but continue
            if (err.writeErrors) {
                errors += err.writeErrors.length;
                inserted += (err.result?.nUpserted || 0);
                updated += (err.result?.nModified || 0);
            } else {
                throw err;
            }
        }

        const progress = Math.min(i + BATCH_SIZE, docs.length);
        process.stdout.write(`\r  [${label}] ${progress}/${docs.length}...`);
    }

    console.log(
        `\r  [${label}] Done: ${inserted} inserted, ${updated} updated, ${errors} errors. Total: ${docs.length}`
    );
}

// ── Migration functions ──────────────────────────────────────────

async function migrateCarrierDb() {
    console.log("\n1. carrier-db.json → CarrierData (active only)");
    const data = readJson("data/carrier-db.json");
    if (!data) return;

    const today = new Date();
    const fifteenDaysAgo = new Date(today);
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    const cutoff = fifteenDaysAgo.toISOString().slice(0, 10);

    let total = 0;
    let active = 0;
    const docs = [];

    for (const [cid, carrier] of Object.entries(data)) {
        total++;
        const stage = String(carrier.zoho?.stage || "").trim();
        if (stage !== "Card Swiped") continue;

        // Active = has CMP activity within 15 days OR is debtor OR has unpaid invoices
        const invDates = (carrier.invoices || [])
            .map((inv) => String(inv.date_to || "").slice(0, 10))
            .filter((d) => d.length === 10);
        const txnDates = (carrier.billing_history || [])
            .map((txn) => String(txn.create_date || "").slice(0, 10))
            .filter((d) => d.length === 10);
        const lastActivity = [...invDates, ...txnDates].sort().pop() || "";
        const isRecentlyActive = lastActivity >= cutoff;
        const isDebtor = carrier.derived?.is_debtor;
        const hasUnpaid = (carrier.invoices || []).some((inv) =>
            String(inv.status || "").toUpperCase() !== "PAID"
        );

        if (isRecentlyActive || isDebtor || hasUnpaid) {
            active++;
            docs.push({ carrier_id: cid, ...carrier });
        }
    }

    console.log(`  Total: ${total}, Active (Card Swiped + recent/debtor/unpaid): ${active}`);
    await bulkUpsert(CarrierData, docs, "carrier_id", "CarrierData");
}

async function migrateCollectionPlacement() {
    console.log("\n2. collection-placement-db.json → CollectionPlacement");
    const data = readJson("db/collection-placement-db.json");
    if (!data) return;

    const docs = Object.entries(data).map(([key, entry]) => ({
        key,
        ...entry,
    }));

    console.log(`  Found ${docs.length} entries`);
    await bulkUpsert(CollectionPlacement, docs, "key", "CollectionPlacement");
}

async function migratePaymentVerifications() {
    console.log("\n3. payment-verifications-db.json → PaymentVerification");
    const data = readJson("db/payment-verifications-db.json");
    if (!data) return;

    const docs = Object.entries(data).map(([cid, entry]) => ({
        carrier_id: cid,
        ...entry,
    }));

    console.log(`  Found ${docs.length} entries`);
    await bulkUpsert(PaymentVerification, docs, "carrier_id", "PaymentVerification");
}

async function migrateAccountingClients() {
    console.log("\n4. accounting-client-db.json → AccountingClient");
    const data = readJson("db/accounting-client-db.json");
    if (!data) return;

    const docs = [];
    for (const [group, carriers] of Object.entries(data)) {
        for (const carrier of carriers) {
            const cid = String(carrier.carrier_id || "").trim();
            if (!cid) continue;
            docs.push({
                carrier_id: cid,
                billing_cycle_group: group,
                ...carrier,
            });
        }
    }

    console.log(`  Found ${docs.length} clients across ${Object.keys(data).length} billing cycle groups`);
    await bulkUpsert(AccountingClient, docs, "carrier_id", "AccountingClient");
}

async function migrateMasterCarriers() {
    console.log("\n5. debtor-master-db.json → MasterCarrier");
    const data = readJson("db/debtor-master-db.json");
    if (!data) return;

    const docs = Object.entries(data).map(([cid, entry]) => ({
        carrier_id: cid,
        ...entry,
    }));

    console.log(`  Found ${docs.length} carriers`);
    await bulkUpsert(MasterCarrier, docs, "carrier_id", "MasterCarrier");
}

async function migrateDob() {
    console.log("\n6. dob.json → DobEntry");
    const data = readJson("data/dob.json");
    if (!data) return;

    const docs = Object.entries(data).map(([cid, dob]) => ({
        carrier_id: cid,
        dob: String(dob || ""),
    }));

    console.log(`  Found ${docs.length} DOB entries`);
    await bulkUpsert(DobEntry, docs, "carrier_id", "DobEntry");
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.error("MONGODB_URI not set in .env");
        process.exit(1);
    }

    console.log("Connecting to MongoDB...");
    await mongoose.connect(uri);
    console.log("Connected to MongoDB Atlas.");

    if (dropFirst) {
        console.log("--drop flag: will clear collections before inserting.");
    }

    const migrations = [
        ["carrier-db", migrateCarrierDb],
        ["collection-placement", migrateCollectionPlacement],
        ["payment-verifications", migratePaymentVerifications],
        ["accounting-clients", migrateAccountingClients],
        ["master-carriers", migrateMasterCarriers],
        ["dob", migrateDob],
    ];

    for (const [name, fn] of migrations) {
        if (shouldMigrate(name)) {
            await fn();
        }
    }

    // Print summary
    console.log("\n=== MIGRATION SUMMARY ===");
    const counts = await Promise.all([
        CarrierData.countDocuments(),
        CollectionPlacement.countDocuments(),
        PaymentVerification.countDocuments(),
        AccountingClient.countDocuments(),
        MasterCarrier.countDocuments(),
        DobEntry.countDocuments(),
    ]);
    const labels = [
        "CarrierData",
        "CollectionPlacement",
        "PaymentVerification",
        "AccountingClient",
        "MasterCarrier",
        "DobEntry",
    ];
    for (let i = 0; i < labels.length; i++) {
        console.log(`  ${labels[i].padEnd(25)} ${counts[i]} documents`);
    }

    await mongoose.disconnect();
    console.log("\nDone. MongoDB connection closed.");
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
