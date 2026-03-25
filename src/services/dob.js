import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOB_PATH = path.resolve(__dirname, "../../data/dob.json");

export function normalizeDob(value) {
    const raw = String(value || "").trim();
    if (!raw || ["null", "None"].includes(raw)) return "";

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return raw.slice(5, 7) + raw.slice(8, 10) + raw.slice(0, 4);
    }

    const digits = raw.replace(/\D/g, "");
    return digits.length === 8 ? digits : "";
}

export function loadDobMap({ logPrefix = "[dob]" } = {}) {
    if (!fs.existsSync(DOB_PATH)) return {};

    try {
        const rawMap = JSON.parse(fs.readFileSync(DOB_PATH, "utf-8"));
        const normalized = {};

        for (const [carrierId, dob] of Object.entries(rawMap || {})) {
            const normalizedDob = normalizeDob(dob);
            if (normalizedDob) {
                normalized[String(carrierId)] = normalizedDob;
            }
        }

        return normalized;
    } catch {
        console.warn(`${logPrefix} Could not parse dob.json.`);
        return {};
    }
}

export function mergeDobIntoMasterDb(masterDb = {}, dobMap = {}) {
    const merged = {};

    for (const [carrierId, entry] of Object.entries(masterDb || {})) {
        const normalizedCarrierId = String(carrierId);
        const mergedEntry = entry && typeof entry === "object" ? { ...entry } : {};
        const normalizedDob = dobMap[normalizedCarrierId] || normalizeDob(mergedEntry.dob);

        if (normalizedDob) {
            mergedEntry.dob = normalizedDob;
            mergedEntry.dob_source = mergedEntry.dob_source || "dob.json";
        }

        merged[normalizedCarrierId] = mergedEntry;
    }

    return merged;
}

export function loadMergedMasterDb(masterDbPath, { logPrefix = "[master-db]", dobMap = null } = {}) {
    if (!masterDbPath || !fs.existsSync(masterDbPath)) {
        console.warn(`${logPrefix} debtor-master-db.json not found — offline data unavailable.`);
        return {};
    }

    try {
        const masterDb = JSON.parse(fs.readFileSync(masterDbPath, "utf-8"));
        return mergeDobIntoMasterDb(masterDb, dobMap || loadDobMap({ logPrefix }));
    } catch {
        console.warn(`${logPrefix} Could not parse debtor-master-db.json.`);
        return {};
    }
}
