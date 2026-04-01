import fs from "fs";
import ExcelJS from "exceljs";
import { env } from "../config/env.js";
import { loadDobMap, loadMergedMasterDb } from "./dob.js";
import { readCarrierDb } from "./syncCarrierDb.js";

function normalizeCompanyKey(v) {
    return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function loadJsonFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return {};
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return {};
    }
}

/**
 * Parse a date string in various formats to YYYY-MM-DD.
 * Handles: YYYY-MM-DD, MM/DD/YYYY, MM/D/YYYY, M/DD/YYYY
 */
function parseDateToIso(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    // MM/DD/YYYY or M/D/YYYY
    const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
        const mm = slashMatch[1].padStart(2, "0");
        const dd = slashMatch[2].padStart(2, "0");
        return `${slashMatch[3]}-${mm}-${dd}`;
    }
    return "";
}

/**
 * Build carrier_id → { date_filled, dob } index from accounting-client-db.
 * Parses date_filled from MM/DD/YYYY or YYYY-MM-DD to ISO.
 */
let _accountingIndex = null;
function getAccountingIndex() {
    if (_accountingIndex) return _accountingIndex;
    const accDb = loadJsonFile(env.ACCOUNTING_DB_PATH);
    _accountingIndex = {};
    for (const entries of Object.values(accDb)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const cid = String(entry.carrier_id || "").trim();
            if (!cid) continue;
            _accountingIndex[cid] = {
                date_filled: parseDateToIso(entry.date_filled),
                dob: entry.dob || "",
            };
        }
    }
    return _accountingIndex;
}

/**
 * Load payment-verifications-db.json — provides last_invoice_date for closed carriers.
 * Carriers whose last verification activity predates CMP (no CMP invoices) use this
 * as their close date for D-code boundary.
 */
let _verificationsIndex = null;
function getVerificationsIndex() {
    if (_verificationsIndex) return _verificationsIndex;
    const verifPath = env.COLLECTION_DB_PATH
        ? env.COLLECTION_DB_PATH.replace("collection-placement-db.json", "payment-verifications-db.json")
        : "";
    const altPath = env.MASTER_DB_PATH
        ? env.MASTER_DB_PATH.replace("debtor-master-db.json", "payment-verifications-db.json")
        : "";
    _verificationsIndex = loadJsonFile(verifPath) || loadJsonFile(altPath) || {};
    return _verificationsIndex;
}

/**
 * Build a 24-char Payment History Profile for a debtor/collection company.
 *
 * Rules:
 * - Before account open → B
 * - After account close → D
 * - From earliest agency transfer month onward → G (in collection)
 * - 1–6 months past delinquency (pre-transfer) → escalating code 1–6
 * - All other months → 0 (current)
 */
function rebuildCollectionPhp(delinquencyDate, dateOpen, agencyTransferDates = [], closedDate = "") {
    const today = new Date();
    const RY = today.getFullYear();
    const RM = today.getMonth() + 1;

    const parseAbs = (iso) => {
        if (!iso || iso.length < 7) return 0;
        const y = parseInt(iso.slice(0, 4));
        const m = parseInt(iso.slice(5, 7));
        return isNaN(y) || isNaN(m) ? 0 : y * 12 + m;
    };

    const openAbs   = parseAbs(dateOpen);
    const delinqAbs = parseAbs(delinquencyDate);
    const closedAbs = parseAbs(closedDate);

    // Find the earliest agency transfer month — G applies from this month onward
    let earliestTransferAbs = 0;
    for (const d of agencyTransferDates) {
        const abs = parseAbs(d);
        if (abs && (!earliestTransferAbs || abs < earliestTransferAbs)) {
            earliestTransferAbs = abs;
        }
    }

    let php = "";
    for (let n = 0; n < 24; n++) {
        const totalMonths = RY * 12 + RM - 1 - n;
        const mYear  = Math.floor(totalMonths / 12);
        const mMonth = (totalMonths % 12) + 1;
        const mAbs   = mYear * 12 + mMonth;

        let code;
        if (openAbs && mAbs < openAbs) {
            code = "B";
        } else if (earliestTransferAbs && mAbs >= earliestTransferAbs) {
            // Once transferred to collection, stays G — even if account is closed
            code = "G";
        } else if (closedAbs && mAbs > closedAbs) {
            code = "D";
        } else if (delinqAbs && mAbs > delinqAbs) {
            // Pre-transfer delinquency: escalate 1–6, then G at 7+ months
            const monthsPast = mAbs - delinqAbs;
            code = monthsPast >= 7 ? "G" : String(monthsPast);
        } else {
            code = "0";
        }
        php += code;
    }
    return php;
}

/**
 * Compute account status code from months overdue since delinquency date.
 * Maps to Metro 2 delinquent status codes (71–84).
 */
function computeDelinquentStatus(delinquencyDate) {
    if (!delinquencyDate || delinquencyDate.length < 7) return "11";
    const today = new Date();
    const currentAbs = today.getFullYear() * 12 + (today.getMonth() + 1);
    const y = parseInt(delinquencyDate.slice(0, 4));
    const m = parseInt(delinquencyDate.slice(5, 7));
    if (isNaN(y) || isNaN(m)) return "11";
    const delinqAbs = y * 12 + m;
    const monthsPast = currentAbs - delinqAbs;
    if (monthsPast <= 0) return "11";
    if (monthsPast === 1) return "71";
    if (monthsPast === 2) return "78";
    if (monthsPast === 3) return "80";
    if (monthsPast === 4) return "82";
    if (monthsPast === 5) return "83";
    return "84";
}

/**
 * Build a map of carrier_id → collection-placement-db entry
 * using MASTER_DB_PATH (common-carriers-db.json) company names matched
 * against collection-placement-db.json keys.
 */
function isInsuranceEntry(entry) {
    const invoices = entry.invoices || [];
    // No invoices (nothing to report) or any invoice marked as insurance
    if (!invoices.length) return true;
    return invoices.some((inv) => String(inv.language || "").toLowerCase() === "insurance");
}

function buildCollectionDbIndex() {
    const commonDb  = loadJsonFile(env.MASTER_DB_PATH);     // common-carriers-db.json
    const collectionDb = loadJsonFile(env.COLLECTION_DB_PATH); // collection-placement-db.json
    if (!Object.keys(collectionDb).length) return {};

    const index = {};
    for (const [cid, entry] of Object.entries(commonDb)) {
        const key = normalizeCompanyKey(entry.company);
        if (key && collectionDb[key] && !isInsuranceEntry(collectionDb[key])) {
            index[String(cid)] = collectionDb[key];
        }
    }
    return index;
}

const HEADERS = [
    "Association Code", "First Name", "Middle Name", "Last Name", "Generation Code",
    "First Line of Address", "Second Line of Address", "City", "State", "Zip Code",
    "Social Security Number", "Telephone Number", "Date of Birth", "Consumer Information Indicator",
    "JointAssociationCode", "JointFirstName", "JointMiddleName", "JointLastName",
    "JointAddress1", "JointAddress2", "JointCity", "JointState", "JointZipCode",
    "JointSocialSecurityNumber", "JointPhoneNumber", "JointDateOfBirth",
    "JointConsumerInformationIndicator", "Customer Account Number", "Portfolio Type",
    "Account Type", "Date Open", "Date of First Delinquency", "Date of Last Payment",
    "Date Closed", "Account Status", "Payment Rating", "Special Comment Code",
    "Compliance Condition Code", "Credit Limit", "Highest Credit", "Current Balance",
    "Monthly Payment", "Actual Payment", "Terms Frequency", "Terms",
    "Original Charge Off Amount", "Payment History Profile",
];

const DESC_ROW = [
    "Consumer / Joint indicator", "Consumer first name", "Consumer middle name",
    "Consumer last name", "Jr/Sr/II etc.", "Street address line 1", "Street address line 2",
    "City", "2-letter state code", "5-digit zip code", "SSN (no dashes)", "10-digit phone",
    "MMddyyyy", "Bankruptcy/ECOA codes", "Joint consumer indicator", "Joint first name",
    "Joint middle name", "Joint last name", "Joint address line 1", "Joint address line 2",
    "Joint city", "Joint state", "Joint zip", "Joint SSN", "Joint phone", "Joint DOB MMddyyyy",
    "Joint CII", "Carrier ID (unique key)", "C=Credit Card O=Open", "15=Credit Line",
    "Account open MMddyyyy", "First delinquency MMddyyyy", "Last payment MMddyyyy",
    "Account closed MMddyyyy", "11=Current 13=Closed 84=Collection", "0=Current 1-6=Past due",
    "AH=Paying under arrangement", "XB=Account in dispute", "Weekly credit limit $",
    "Credit score or highest balance", "Outstanding balance $",
    "Scheduled monthly payment", "Actual payment received", "W=Weekly M=Monthly",
    "Number of payments (001)", "Charge-off amount $", "24-char Metro 2 history B/0-6/G/D",
];

const REQUIRED_ROW = [
    "R", "R", null, "R", null, "R", null, "R", "R", "R", null, null, null, null,
    null, null, null, null, null, null, null, null, null, null, null, null, null,
    "R", "R", "R", "R", null, "R", null, "R", null, null, null, null, null, "R",
    null, null, "R", "R", null, "R",
];

const WIDTH_ROW = [
    "1", "20", "20", "25", "2", "32", "32", "20", "2", "5", "9", "10", "8", "2",
    "1", "20", "20", "25", "32", "32", "20", "2", "5", "9", "10", "8", "2", "30",
    "1", "2", "8", "8", "8", "8", "2", "1", "2", "2", "9", "9", "9", "9", "9",
    "1", "3", "9", "24",
];

export const REPORT_COLUMNS = HEADERS.map((header, index) => ({
    header,
    description: DESC_ROW[index] || "",
    required: REQUIRED_ROW[index] === "R",
    templateWidth: Number(WIDTH_ROW[index]) || 14,
}));

function isoToMmddyyyy(value) {
    const raw = String(value || "").trim();
    if (/^\d{8}$/.test(raw)) return raw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
    return raw.slice(5, 7) + raw.slice(8, 10) + raw.slice(0, 4);
}

function buildDateStamp(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function isMeaningfulOptionalValue(value) {
    if (value === null || value === undefined) return false;
    const raw = String(value).trim();
    if (!raw) return false;
    return !["0", "0.0", "0.00", "00000000"].includes(raw);
}

function normalizeAddressText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .replace(/\s+,/g, ",")
        .trim()
        .replace(/^[,\s]+|[,\s]+$/g, "");
}

function separateGluedAddressWords(value) {
    return String(value || "")
        .replace(/([0-9])([A-Z][a-z])/g, "$1 $2")
        .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeEmbeddedAddressLine(line1, line2) {
    const primary = normalizeAddressText(line1);
    const secondary = normalizeAddressText(line2);
    if (!primary || !secondary) return primary;

    return normalizeAddressText(
        separateGluedAddressWords(primary.replace(
            new RegExp(`(?:,?\\s+)${escapeRegExp(secondary)}(?=\\s|$|[A-Z])`, "i"),
            " "
        ))
    );
}

function splitSecondaryAddress(line1) {
    let primary = normalizeAddressText(line1);
    let secondary = "";
    if (!primary) return { line1: primary, line2: secondary };

    const upper = primary.toUpperCase();
    const markers = [
        [" SUITE", "SUITE"],
        [" APT", "APT"],
        [" APT.", "APT."],
        [" UNIT", "UNIT"],
        [" STE", "STE"],
        [" FLOOR", "FLOOR"],
        [" FL ", "FL "],
        [" #", "#"],
    ];

    for (const [search, marker] of markers) {
        if (!upper.includes(search)) continue;

        const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const street = primary.replace(new RegExp(` ${escapedMarker}.*`, "i"), "").trim();
        const unit = primary.replace(new RegExp(`^.*? ${escapedMarker}`, "i"), marker).trim();

        if (street && unit && street.length < primary.length) {
            primary = street;
            secondary = unit;
        }
        break;
    }

    return {
        line1: normalizeAddressText(primary),
        line2: normalizeAddressText(secondary),
    };
}

function stripTrailingFragment(value, fragment, { minRemainingLength = 6, allowPrefix = false } = {}) {
    let current = normalizeAddressText(value);
    const target = normalizeAddressText(fragment);
    if (!current || !target) return current;

    const currentLower = current.toLowerCase();
    const targetLower = target.toLowerCase();

    const removeMatch = (length) => {
        if (current.length - length < minRemainingLength) return current;
        return normalizeAddressText(current.slice(0, current.length - length));
    };

    const exactMatch = currentLower.match(new RegExp(`(?:[\\s,]+)${escapeRegExp(targetLower)}$`, "i"));
    if (exactMatch) {
        return removeMatch(exactMatch[0].length);
    }

    if (!allowPrefix) return current;

    for (let len = Math.min(targetLower.length, currentLower.length); len >= 4; len--) {
        const prefix = targetLower.slice(0, len);
        const match = currentLower.match(new RegExp(`(?:[\\s,]+)${escapeRegExp(prefix)}$`, "i"));
        if (match) {
            return removeMatch(match[0].length);
        }
    }

    return current;
}

function cleanLocationOnlyAddressLine2(line2, city, state, zip) {
    const current = normalizeAddressText(line2);
    if (!current) return "";

    const normalizedCity = normalizeAddressText(city);
    const normalizedState = normalizeAddressText(state);
    const normalizedZip = normalizeAddressText(zip);
    const normalizedStateZip = normalizeAddressText([normalizedState, normalizedZip].filter(Boolean).join(" "));
    const normalizedCityStateZip = normalizeAddressText([normalizedCity, normalizedState, normalizedZip].filter(Boolean).join(" "));

    const locationOnlyValues = [
        normalizedCityStateZip,
        normalizedStateZip,
        normalizedCity,
        normalizedZip,
    ].filter(Boolean);

    const currentLower = current.toLowerCase();
    if (locationOnlyValues.some((value) => currentLower === value.toLowerCase())) {
        return "";
    }

    return current;
}

function normalizeReportAddress(carrier = {}) {
    const derived = carrier.derived || {};
    const accountingAddress = carrier.accounting?.address || {};
    const smpAddress = carrier.smp?.address || {};

    const city = normalizeAddressText(derived.city || accountingAddress.city || smpAddress.city || carrier.zoho?.city || "");
    const state = normalizeAddressText(derived.state || accountingAddress.state || smpAddress.state || carrier.zoho?.state || "");
    const zip = normalizeAddressText(derived.zip || accountingAddress.zip || smpAddress.zip || carrier.zoho?.zip || "");

    let line1 = normalizeAddressText(
        accountingAddress.line1 || smpAddress.line1 || derived.addr1 || carrier.zoho?.address || ""
    );
    let line2 = normalizeAddressText(
        accountingAddress.line2 || smpAddress.line2 || derived.addr2 || ""
    );

    line2 = cleanLocationOnlyAddressLine2(line2, city, state, zip);

    if (line2) {
        line1 = removeEmbeddedAddressLine(line1, line2);
        const split = splitSecondaryAddress(line1);
        if (split.line2) {
            line1 = split.line1;
        }
    } else {
        const split = splitSecondaryAddress(line1);
        line1 = split.line1;
        line2 = split.line2;
    }

    let previousLine1 = null;
    while (line1 && line1 !== previousLine1) {
        previousLine1 = line1;
        line1 = stripTrailingFragment(line1, [city, state, zip].filter(Boolean).join(" "), { minRemainingLength: 6 });
        line1 = stripTrailingFragment(line1, [state, zip].filter(Boolean).join(" "), { minRemainingLength: 6 });
        line1 = stripTrailingFragment(line1, zip, { minRemainingLength: 6 });
        line1 = stripTrailingFragment(line1, state, { minRemainingLength: 6 });
        line1 = stripTrailingFragment(line1, city, { minRemainingLength: 6, allowPrefix: true });
    }

    line2 = cleanLocationOnlyAddressLine2(line2, city, state, zip);

    return { line1, line2 };
}

/**
 * Determine if a carrier is "closed" at report time using the 30-day rule:
 * if no unpaid invoices AND max(last invoice date_to, last transaction create_date)
 * is older than 30 days, the company is considered closed.
 * This overrides the stored derived.is_closed for carriers synced before this rule.
 */
function isCarrierClosed(carrier = {}) {
    const derived = carrier.derived || {};
    // Already explicitly closed → keep it
    if (derived.is_closed) return true;

    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    // Has unpaid invoices → not closed
    const invoices = carrier.invoices || [];
    const hasUnpaid = invoices.some((inv) => {
        const status = String(inv.status || inv.invoice_status || "").toUpperCase();
        return status !== "PAID" && Number(inv.remaining_amount ?? inv.total_amount ?? 0) > 0;
    });
    if (hasUnpaid) return false;

    // Compute last activity date from invoices and billing history
    const invDates = invoices
        .map((inv) => String(inv.date_to || "").slice(0, 10))
        .filter((d) => d.length === 10);
    const txnDates = (carrier.billing_history || [])
        .map((txn) => String(txn.create_date || "").slice(0, 10))
        .filter((d) => d.length === 10);

    const lastActivity = [...invDates, ...txnDates].sort().pop() || "";

    // No billing data at all → closed
    if (!lastActivity) return true;
    // Inactive for 30+ days → closed
    return lastActivity < cutoff;
}

export function carrierToRow(carrier) {
    const derived = carrier.derived || {};
    const creditScore = derived.credit_score || derived.highest_credit || "";
    // Active debtor = flagged as debtor AND has unpaid CMP invoices
    const cmpInvoices = carrier.invoices || [];
    const allCmpPaid = cmpInvoices.length > 0 && cmpInvoices.every((inv) => String(inv.status || "").toUpperCase() === "PAID");
    const isActiveDebtor = derived.is_debtor && !allCmpPaid;
    // Closed detection: CMP-based close OR verification-based close (old clients with no CMP data)
    const verifEntry = getVerificationsIndex()[String(carrier.carrier_id)];
    const hasCmpActivity = cmpInvoices.length > 0 || (carrier.billing_history || []).length > 0;
    const verifCloseDate = (verifEntry && !hasCmpActivity) ? (verifEntry.last_invoice_date || "") : "";
    // Don't mark as closed if CMP shows paid/active and not an active debtor — they just paid up
    const hasCmpBilling = (carrier.billing_history || []).length > 0;
    const cmpSettled = (allCmpPaid || (cmpInvoices.length === 0 && hasCmpBilling)) && !isActiveDebtor;
    const cmpBasedClose = cmpSettled ? false : isCarrierClosed(carrier);
    const isClosed = cmpBasedClose || derived.was_former_debtor || Boolean(verifCloseDate);
    // Date Open: Zoho Application_Date → accounting date_filled → derived fallback
    const accEntry = getAccountingIndex()[String(carrier.carrier_id)] || {};
    const dateOpen = carrier.zoho?.application_date || accEntry.date_filled || carrier.accounting?.application_date || derived.date_open || "";
    // Debtors (is_debtor=true): always show delinquency date regardless of closed status.
    // LOC clients (is_debtor=false): suppress if closed — they are not collection accounts.
    const hasDelinquency = Boolean(derived.date_first_delinquency && isActiveDebtor);
    // Close date: CMP-derived or verification last_invoice_date for old clients
    const reportCloseDate = hasDelinquency ? "" : (isClosed ? (verifCloseDate || derived.date_last_payment || derived.date_closed || "") : "");
    // Debtors: always show last payment from CMP billing history.
    // LOC clients: blank when delinquent or closed.
    const reportLastPayment = derived.is_debtor
        ? (derived.date_last_payment || "")
        : ((hasDelinquency || isClosed) ? "" : derived.date_last_payment);
    const firstDelinquencyDate = hasDelinquency ? derived.date_first_delinquency : "";
    const address = normalizeReportAddress(carrier);

    // Rebuild PHP B/D codes using the correct Date Open (Zoho app date).
    // The sync engine may have computed PHP without proper B boundaries.
    // Also strip D codes from sync if carrier is not actually closed at report time.
    let php = derived.payment_history_profile || "";
    if (!isClosed && php.includes("D")) {
        php = php.replace(/D/g, "0");
    }
    if (dateOpen && php) {
        const today = new Date();
        const RY = today.getFullYear();
        const RM = today.getMonth() + 1;
        const oy = parseInt(dateOpen.slice(0, 4));
        const om = parseInt(dateOpen.slice(5, 7));
        if (!isNaN(oy) && !isNaN(om)) {
            const openAbs = oy * 12 + om;
            const cy = reportCloseDate ? parseInt(reportCloseDate.slice(0, 4)) : 0;
            const cm = reportCloseDate ? parseInt(reportCloseDate.slice(5, 7)) : 0;
            const closedAbs = (cy && cm) ? cy * 12 + cm : 0;
            let newPhp = "";
            for (let n = 0; n < 24; n++) {
                const totalMonths = RY * 12 + RM - 1 - n;
                const mYear = Math.floor(totalMonths / 12);
                const mMonth = (totalMonths % 12) + 1;
                const mAbs = mYear * 12 + mMonth;
                const existingCode = php[n] || "0";
                if (mAbs < openAbs) {
                    newPhp += "B";
                } else if (closedAbs && mAbs > closedAbs && existingCode !== "G") {
                    // D for closed months — but never overwrite G (collection stays on record)
                    newPhp += "D";
                } else {
                    newPhp += existingCode;
                }
            }
            php = newPhp;
        }
    }

    return {
        "Association Code": "1",
        "First Name": derived.first_name || "",
        "Middle Name": "",
        "Last Name": derived.last_name || "",
        "Generation Code": "",
        "First Line of Address": address.line1,
        "Second Line of Address": address.line2,
        "City": derived.city || "",
        "State": derived.state || "",
        "Zip Code": derived.zip || "",
        "Social Security Number": "",
        "Telephone Number": derived.phone || "",
        "Date of Birth": derived.dob || "",
        "Consumer Information Indicator": "",
        "JointAssociationCode": "",
        "JointFirstName": "",
        "JointMiddleName": "",
        "JointLastName": "",
        "JointAddress1": "",
        "JointAddress2": "",
        "JointCity": "",
        "JointState": "",
        "JointZipCode": "",
        "JointSocialSecurityNumber": "",
        "JointPhoneNumber": "",
        "JointDateOfBirth": "",
        "JointConsumerInformationIndicator": "",
        "Customer Account Number": carrier.carrier_id,
        "Portfolio Type": "C",
        "Account Type": "15",
        "Date Open": isoToMmddyyyy(dateOpen),
        "Date of First Delinquency": isoToMmddyyyy(firstDelinquencyDate),
        "Date of Last Payment": isoToMmddyyyy(reportLastPayment),
        "Date Closed": isoToMmddyyyy(reportCloseDate),
        "Account Status": php.includes("D") ? "13" : (isClosed ? "13" : ((derived.account_status === "13" ? "11" : derived.account_status) || "11")),
        "Payment Rating": "",
        "Special Comment Code": "",
        "Compliance Condition Code": "",
        "Credit Limit": (isClosed || isActiveDebtor) ? "0" : String(derived.credit_limit || 0),
        "Highest Credit": String(derived.highest_credit || creditScore || 0),
        "Current Balance": (isClosed || isActiveDebtor) ? "0" : String(derived.current_balance || 0),
        "Monthly Payment": "",
        "Actual Payment": "",
        "Terms Frequency": "W",
        "Terms": "001",
        "Original Charge Off Amount": "0",
        "Payment History Profile": php,
    };
}

function hasCmpTag(carrier = {}, tagId) {
    const tagIds = carrier?.smp?.tag_ids;
    if (!Array.isArray(tagIds)) return false;
    return tagIds.map(String).includes(String(tagId));
}

function hasZohoCardSwiped(carrier = {}) {
    return String(carrier?.zoho?.stage || "").trim() === "Card Swiped";
}

export function loadReportCarriers(query = {}) {
    const db = readCarrierDb();
    const dobMap = loadDobMap({ logPrefix: "[report]" });
    const masterDb = loadMergedMasterDb(env.MASTER_DB_PATH, { logPrefix: "[report]", dobMap });
    let carriers = Object.values(db);

    if (query.debtor_report === "true") {
        // Rule: a carrier is a debtor for the Array report ONLY IF they appear in
        // collection-placement-db.json (matched by company name via common-carriers-db).
        // Carriers with only the SMP tagId=1 (fuel-card block) are excluded.
        const collectionIndex = buildCollectionDbIndex(); // carrier_id → collection entry

        carriers = carriers.filter((carrier) => {
            const cid = String(carrier.carrier_id);
            // Must be in collection-placement-db
            const collEntry = collectionIndex[cid];
            if (!collEntry) return false;
            // Must be an LOC client (tagIds=2 + Card Swiped deal)
            if (!hasCmpTag(carrier, 2) || !hasZohoCardSwiped(carrier)) return false;
            // No CMP data (old closed client) — goes to LOC report
            const cmpInvoices = carrier.invoices || [];
            if (cmpInvoices.length === 0 && (carrier.billing_history || []).length === 0) return false;
            // All CMP invoices PAID — goes to LOC report
            if (cmpInvoices.length > 0 && cmpInvoices.every((inv) => String(inv.status || "").toUpperCase() === "PAID")) {
                return false;
            }
            // Collection-db invoices all paid + no agency assigned → debt resolved, goes to LOC
            const collInvoices = collEntry.invoices || [];
            const collCases = collEntry.collection_cases || [];
            const collAllPaid = collInvoices.length > 0 && collInvoices.every(
                (inv) => String(inv.invoice_status || "").toLowerCase() === "paid"
                    || (Number(inv.remaining_amount) || 0) <= 0
            );
            const hasAgency = collCases.length > 0 || collInvoices.some((inv) =>
                inv.collection_transferred_date_dustin || inv.collection_transferred_date_trustaltus
                || inv.collection_transferred_date_ic_system || inv.transferred_date_alla
            );
            if (collAllPaid && !hasAgency) return false;
            return true;
        });

        if (query.include_inactive !== "true") {
            carriers = carriers.filter((carrier) => !isCarrierClosed(carrier));
        }

        carriers = carriers.map((carrier) => {
            const cid = String(carrier.carrier_id);
            const derived = carrier.derived || {};
            const collEntry = collectionIndex[cid];
            // Use the report-layer closed determination (30-day rule)
            const carrierIsClosed = isCarrierClosed(carrier);

            // Augment from collection-placement-db when sync missed the data
            let augmented = derived;
            if (collEntry) {
                const invoices = collEntry.invoices || [];
                const totalRemaining = invoices.reduce(
                    (sum, inv) => sum + (Number(inv.remaining_amount) || 0), 0
                );
                const collInvoicesPaid = invoices.length > 0 && invoices.every(
                    (inv) => String(inv.invoice_status || "").toLowerCase() === "paid"
                        || (Number(inv.remaining_amount) || 0) <= 0
                );
                // Also check CMP — if any CMP invoice is unpaid, carrier is NOT closed
                const cmpInvoices = carrier.invoices || [];
                const hasCmpUnpaid = cmpInvoices.some(
                    (inv) => String(inv.status || "").toUpperCase() !== "PAID"
                );
                const allPaid = carrierIsClosed || (collInvoicesPaid && !hasCmpUnpaid);

                const toDate10 = (v) => { const s = String(v || "").slice(0, 10); return s.length === 10 ? s : ""; };

                // G-code start date priority:
                // 1. collection_cases.date_placed (authoritative — actual agency placement)
                // 2. invoice-level agency transfer dates (fallback if no collection_cases)
                // NOTE: sent_to_collection_date is NOT used — it's the spreadsheet entry date, not agency date
                const caseDates = (collEntry.collection_cases || [])
                    .map((c) => toDate10(c.date_placed))
                    .filter(Boolean);
                let agencyTransferDates;
                if (caseDates.length) {
                    agencyTransferDates = caseDates;
                } else {
                    agencyTransferDates = invoices.flatMap((inv) => [
                        inv.collection_transferred_date_dustin,
                        inv.collection_transferred_date_trustaltus,
                        inv.collection_transferred_date_ic_system,
                        inv.transferred_date_alla,
                    ]).map(toDate10).filter(Boolean);
                }

                // Delinquency date: earliest invoice_date across collection DB invoices.
                // Fallback to company-level date_of_delinquency when no invoice dates exist.
                const invoiceDelinqDate = invoices
                    .map((inv) => toDate10(inv.invoice_date))
                    .filter(Boolean)
                    .sort()[0] || "";
                const delinqDate = invoiceDelinqDate || toDate10(collEntry.date_of_delinquency) || "";

                const changes = {};

                changes.is_debtor = true;

                // Last payment date from CMP billing history (most recent create_date).
                const lastPaymentDate = (carrier.billing_history || [])
                    .map((txn) => toDate10(txn.create_date))
                    .filter(Boolean)
                    .sort()
                    .pop() || "";
                if (lastPaymentDate) changes.date_last_payment = lastPaymentDate;

                if (delinqDate) {
                    changes.date_first_delinquency = delinqDate;
                }

                // Balance: use collection DB when carrier shows 0
                if (!(derived.current_balance > 0) && totalRemaining > 0) {
                    changes.current_balance = Math.round(totalRemaining);
                }

                // Rebuild PHP for ALL debtors: G at agency transfer months,
                // 1-6 escalation from delinquency date, 7+ months = G
                if (delinqDate) {
                    const closedDate = allPaid ? (lastPaymentDate || derived.date_closed || "") : "";
                    const correctDateOpen = carrier.zoho?.application_date || derived.date_open || "";
                    changes.payment_history_profile = rebuildCollectionPhp(
                        delinqDate,
                        correctDateOpen,
                        agencyTransferDates,
                        closedDate,
                    );
                }

                // Account status: closed → 13, delinquent → 71-84 based on months overdue
                if (allPaid) {
                    changes.account_status = "13";
                    changes.is_closed = true;
                } else if (delinqDate) {
                    changes.account_status = computeDelinquentStatus(delinqDate);
                }

                if (Object.keys(changes).length) {
                    augmented = { ...derived, ...changes };
                }
            }

            // DOB fallback
            const dob = augmented.dob || masterDb[carrier.carrier_id]?.dob || dobMap[carrier.carrier_id] || "";
            if (dob !== augmented.dob) augmented = { ...augmented, dob };

            if (augmented === derived) return carrier;
            return { ...carrier, derived: augmented };
        });

        if (query.missing_dob === "true") {
            carriers = carriers.filter((carrier) => !carrier.derived?.dob);
        } else {
            // DOB is required for Array reporting
            carriers = carriers.filter((carrier) => carrier.derived?.dob);
        }
        carriers.sort((a, b) => String(a.carrier_id || "").localeCompare(String(b.carrier_id || "")));
        return carriers;
    }

    const wantsDebtors = query.type === "debtor" || query.debtors === "true";

    if (wantsDebtors) {
        // Explicit debtor-only request
        carriers = carriers.filter((carrier) =>
            carrier.derived?.is_debtor || hasCmpTag(carrier, 1)
        );
    } else {
        // LOC report (default): SMP tagIds=2 AND Zoho Card Swiped deal
        // Exclude active debtors — they belong in the debtor report only
        // But allow paid debtors back (all CMP invoices PAID = no longer a debtor)
        const collectionIndex = buildCollectionDbIndex();
        carriers = carriers.filter((carrier) => {
            if (!hasCmpTag(carrier, 2) || !hasZohoCardSwiped(carrier)) return false;
            const cid = String(carrier.carrier_id);
            const isInCollection = collectionIndex[cid] || hasCmpTag(carrier, 1);
            if (!isInCollection) return true;
            // Allow back if:
            // - all CMP invoices are paid
            // - no CMP data (old closed client)
            // - collection debt resolved (paid + no agency assigned)
            const cmpInvoices = carrier.invoices || [];
            if (cmpInvoices.length === 0 && (carrier.billing_history || []).length === 0) {
                // No CMP data — only allow if has verification data (real old client)
                return Boolean(getVerificationsIndex()[String(carrier.carrier_id)]);
            }
            if (cmpInvoices.length > 0 && cmpInvoices.every((inv) => String(inv.status || "").toUpperCase() === "PAID")) return true;
            // Check collection-db: debt paid + no agency → resolved, allow back
            const collEntry = collectionIndex[cid];
            if (collEntry) {
                const collInvoices = collEntry.invoices || [];
                const collCases = collEntry.collection_cases || [];
                const collAllPaid = collInvoices.length > 0 && collInvoices.every(
                    (inv) => String(inv.invoice_status || "").toLowerCase() === "paid"
                        || (Number(inv.remaining_amount) || 0) <= 0
                );
                const hasAgency = collCases.length > 0 || collInvoices.some((inv) =>
                    inv.collection_transferred_date_dustin || inv.collection_transferred_date_trustaltus
                    || inv.collection_transferred_date_ic_system || inv.transferred_date_alla
                );
                if (collAllPaid && !hasAgency) return true;
            }
            return false;
        });
    }

    if (query.include_inactive !== "true") {
        carriers = carriers.filter((carrier) => !isCarrierClosed(carrier));
    }

    // Exclude carriers with no billing data anywhere (never used the card)
    // Keep if: has CMP invoices OR CMP billing OR verification spreadsheet data
    const verifIndex = getVerificationsIndex();
    carriers = carriers.filter((carrier) => {
        if (hasCmpTag(carrier, 1)) return true;
        const hasInv = (carrier.invoices || []).length > 0;
        const hasBilling = (carrier.billing_history || []).length > 0;
        const hasVerif = Boolean(verifIndex[String(carrier.carrier_id)]);
        return hasInv || hasBilling || hasVerif;
    });

    // Remove carriers without first or last name
    carriers = carriers.filter((carrier) => {
        const d = carrier.derived || {};
        return d.first_name && d.last_name;
    });

    // Skip active carriers with 0 highest credit
    carriers = carriers.filter((carrier) => {
        const d = carrier.derived || {};
        if (isCarrierClosed(carrier) || d.is_debtor) return true; // keep closed/debtors regardless
        const hc = Number(d.highest_credit || d.credit_score || 0);
        return hc > 0;
    });

    carriers = carriers.map((carrier) => {
        const derived = carrier.derived || {};
        if (derived.dob) return carrier;

        const fallbackDob = masterDb[carrier.carrier_id]?.dob || dobMap[carrier.carrier_id] || "";
        if (!fallbackDob) return carrier;

        return {
            ...carrier,
            derived: {
                ...derived,
                dob: fallbackDob,
            },
        };
    });

    if (query.missing_dob === "true") {
        carriers = carriers.filter((carrier) => !carrier.derived?.dob);
    } else {
        // DOB is required for Array reporting — exclude carriers without it
        carriers = carriers.filter((carrier) => carrier.derived?.dob);
    }

    carriers.sort((a, b) => String(a.carrier_id || "").localeCompare(String(b.carrier_id || "")));
    return carriers;
}

export function buildReportRows(carriers = []) {
    return carriers.map((carrier) => carrierToRow(carrier));
}

export function selectReportColumns(rows = [], { compactOptional = true } = {}) {
    if (!compactOptional) return REPORT_COLUMNS;

    return REPORT_COLUMNS.filter((column) => {
        if (column.required) return true;
        return rows.some((row) => isMeaningfulOptionalValue(row[column.header]));
    });
}

function styleHeaderRow(row) {
    row.height = 22;
    row.eachCell((cell) => {
        cell.font = { bold: true, size: 10, color: { argb: "FF1F2937" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6DCE4" } };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.border = {
            top: { style: "thin", color: { argb: "FFB0B8C4" } },
            left: { style: "thin", color: { argb: "FFB0B8C4" } },
            bottom: { style: "thin", color: { argb: "FFB0B8C4" } },
            right: { style: "thin", color: { argb: "FFB0B8C4" } },
        };
    });
}

function styleMetaRow(row, fillArgb, font = {}) {
    row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillArgb } };
        cell.font = { size: 8, color: { argb: "FF374151" }, ...font };
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = {
            top: { style: "hair", color: { argb: "FFD9D9D9" } },
            left: { style: "hair", color: { argb: "FFD9D9D9" } },
            bottom: { style: "hair", color: { argb: "FFD9D9D9" } },
            right: { style: "hair", color: { argb: "FFD9D9D9" } },
        };
    });
}

function styleDataRow(row, index) {
    const fill = index % 2 === 0
        ? { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } }
        : { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F7FA" } };

    row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = fill;
        cell.font = { size: 10, color: { argb: "FF111827" } };
        cell.alignment = { vertical: "middle", wrapText: false };
        cell.border = {
            top: { style: "hair", color: { argb: "FFE5E7EB" } },
            left: { style: "hair", color: { argb: "FFE5E7EB" } },
            bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
            right: { style: "hair", color: { argb: "FFE5E7EB" } },
        };
    });
}

export function buildArrayReportFilename(date = new Date(), suffix = "") {
    const extra = suffix ? `_${suffix}` : "";
    return `Array_Credit_Report_${buildDateStamp(date)}${extra}.xlsx`;
}

export function buildArrayReportWorkbook({
    carriers = [],
    generatedAt = new Date(),
    compactOptional = true,
} = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "collection-middleware";
    workbook.created = generatedAt;

    const worksheet = workbook.addWorksheet("Array Credit Report", {
        views: [{ state: "frozen", ySplit: 4 }],
    });

    const rows = buildReportRows(carriers);
    const activeColumns = selectReportColumns(rows, { compactOptional });

    worksheet.columns = activeColumns.map((column) => ({
        key: column.header,
        width: Math.max(12, Math.min(36, Math.max(column.templateWidth + 2, column.header.length + 2))),
    }));

    if (activeColumns.length > 0) {
        worksheet.mergeCells(1, 1, 1, activeColumns.length);
    }

    const titleCell = worksheet.getCell("A1");
    titleCell.value = `Octane Array Credit Report — ${buildDateStamp(generatedAt)} — ${carriers.length} carriers`;
    titleCell.font = { bold: true, size: 14, color: { argb: "FF0F172A" } };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF7" } };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };
    worksheet.getRow(1).height = 24;

    const headerRow = worksheet.getRow(2);
    activeColumns.forEach((column, index) => {
        headerRow.getCell(index + 1).value = column.header;
    });
    styleHeaderRow(headerRow);

    const descRow = worksheet.getRow(3);
    activeColumns.forEach((column, index) => {
        descRow.getCell(index + 1).value = column.description || "";
    });
    styleMetaRow(descRow, "FFEAF2FF", { italic: true });

    const reqRow = worksheet.getRow(4);
    activeColumns.forEach((column, index) => {
        reqRow.getCell(index + 1).value = column.required ? "R" : "";
    });
    styleMetaRow(reqRow, "FFFFF4E5", { bold: true, color: { argb: "FFB45309" } });

    rows.forEach((rowData, rowIndex) => {
        const row = worksheet.getRow(5 + rowIndex);
        activeColumns.forEach((column, colIndex) => {
            row.getCell(colIndex + 1).value = rowData[column.header] || "";
        });
        styleDataRow(row, rowIndex);
    });

    worksheet.autoFilter = {
        from: { row: 2, column: 1 },
        to: { row: 2, column: Math.max(1, activeColumns.length) },
    };

    return { workbook, worksheet, rows, activeColumns };
}

export async function writeArrayReportFile({
    carriers = [],
    filePath,
    generatedAt = new Date(),
    compactOptional = true,
} = {}) {
    const { workbook, rows, activeColumns } = buildArrayReportWorkbook({
        carriers,
        generatedAt,
        compactOptional,
    });

    await workbook.xlsx.writeFile(filePath);
    return {
        filePath,
        rowCount: rows.length,
        columnCount: activeColumns.length,
    };
}
