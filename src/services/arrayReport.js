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
 * Build a 24-char Payment History Profile for a collection company.
 * - Months >= sent_to_collection_date → G (always, paid or not)
 * - Months before account open → B
 * - Months between open and collection → use syncPhp (actual payment history
 *   from the sync engine), falling back to "0" if unavailable.
 *
 * Passing syncPhp avoids artificially injecting 1-6 escalation codes for months
 * when the carrier was actually current/paying before being placed in collection.
 */
function rebuildCollectionPhp(collectionStartDate, dateOpen, syncPhp = "") {
    const today = new Date();
    const RY = today.getFullYear();
    const RM = today.getMonth() + 1;

    const parseAbs = (iso) => {
        if (!iso || iso.length < 7) return 0;
        const y = parseInt(iso.slice(0, 4));
        const m = parseInt(iso.slice(5, 7));
        return isNaN(y) || isNaN(m) ? 0 : y * 12 + m;
    };

    const openAbs       = parseAbs(dateOpen);
    const collectionAbs = parseAbs(collectionStartDate);

    let php = "";
    for (let n = 0; n < 24; n++) {
        const totalMonths = RY * 12 + RM - 1 - n;
        const mYear  = Math.floor(totalMonths / 12);
        const mMonth = (totalMonths % 12) + 1;
        const mAbs   = mYear * 12 + mMonth;

        let code;
        if (openAbs && mAbs < openAbs) {
            code = "B";
        } else if (collectionAbs && mAbs >= collectionAbs) {
            // In collection: always G
            code = "G";
        } else {
            // Pre-collection: use actual sync-computed history, not artificial escalation
            code = (syncPhp && syncPhp[n]) || "0";
        }
        php += code;
    }
    return php;
}

/**
 * Build a map of carrier_id → collection-placement-db entry
 * using MASTER_DB_PATH (common-carriers-db.json) company names matched
 * against collection-placement-db.json keys.
 */
function buildCollectionDbIndex() {
    const commonDb  = loadJsonFile(env.MASTER_DB_PATH);     // common-carriers-db.json
    const collectionDb = loadJsonFile(env.COLLECTION_DB_PATH); // collection-placement-db.json
    if (!Object.keys(collectionDb).length) return {};

    const index = {};
    for (const [cid, entry] of Object.entries(commonDb)) {
        const key = normalizeCompanyKey(entry.company);
        if (key && collectionDb[key]) {
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
    const isClosed = isCarrierClosed(carrier) || derived.was_former_debtor;
    const hasDelinquency = Boolean(derived.date_first_delinquency && derived.is_debtor && !isClosed);
    // If delinquent: show delinquency date, blank close_date and last_payment
    // If closed: close_date = last_payment, blank last_payment
    const reportCloseDate = hasDelinquency ? "" : (isClosed ? (derived.date_last_payment || derived.date_closed || "") : "");
    const reportLastPayment = (hasDelinquency || isClosed) ? "" : derived.date_last_payment;
    const firstDelinquencyDate = hasDelinquency ? derived.date_first_delinquency : "";
    const address = normalizeReportAddress(carrier);

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
        "Portfolio Type": derived.portfolio_type || "C",
        "Account Type": derived.account_type || "15",
        "Date Open": isoToMmddyyyy(derived.date_open),
        "Date of First Delinquency": isoToMmddyyyy(firstDelinquencyDate),
        "Date of Last Payment": isoToMmddyyyy(reportLastPayment),
        "Date Closed": isoToMmddyyyy(reportCloseDate),
        "Account Status": derived.account_status || "11",
        "Payment Rating": "",
        "Special Comment Code": "",
        "Compliance Condition Code": "",
        "Credit Limit": (isClosed || derived.is_debtor) ? "0" : String(derived.credit_limit || 0),
        "Highest Credit": String(derived.highest_credit || creditScore || 0),
        "Current Balance": isClosed ? "0" : String(derived.current_balance || 0),
        "Monthly Payment": "0",
        "Actual Payment": "",
        "Terms Frequency": "W",
        "Terms": "001",
        "Original Charge Off Amount": "0",
        "Payment History Profile": derived.payment_history_profile || "",
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
            if (!collectionIndex[cid]) return false;
            // Must be an LOC client (tagIds=2 + Card Swiped deal)
            return hasCmpTag(carrier, 2) && hasZohoCardSwiped(carrier);
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
                const allPaid = carrierIsClosed || (invoices.length > 0 && invoices.every(
                    (inv) => String(inv.invoice_status || "").toLowerCase() === "paid"
                        || (Number(inv.remaining_amount) || 0) <= 0
                ));

                // Determine if carrier was formally placed with a collection agency.
                // G codes only apply when placement_date, TrustAltus condition/transfer,
                // IC System transfer, or Jennifer Hoover column is set on any invoice.
                // Carriers tracked as debtors but not yet placed with an agency get no G.
                const agencyDates = invoices.flatMap((inv) => [
                    inv.placement_date,
                    inv.collection_transferred_date_trustaltus,
                    inv.collection_condition_120_days_trustaltus,
                    inv.collection_transferred_date_ic_system,
                    inv.collection_condition_120_days_ic_system,
                    inv.jennifer_hoover,
                ]).filter(Boolean).map((d) => String(d).slice(0, 10)).filter((d) => d.length === 10).sort();

                // Use earliest agency date as collection start (G codes begin here)
                const collectionStart = agencyDates[0] || "";
                const delinqDate      = collEntry.date_of_delinquency || "";

                const changes = {};

                // Balance: use collection DB when carrier shows 0
                if (!(derived.current_balance > 0) && totalRemaining > 0) {
                    changes.current_balance = Math.round(totalRemaining);
                    changes.amount_past_due = Math.round(totalRemaining);
                }

                const isCurrent = derived.account_status === "11";

                if (collectionStart) {
                    // Formally placed with agency: G codes apply to ALL carriers,
                    // including status=11 (current). G starts from agency placement date.
                    changes.payment_history_profile = rebuildCollectionPhp(
                        collectionStart,
                        derived.date_open || "",
                        derived.payment_history_profile || ""
                    );
                    changes.account_status = allPaid ? "62" : "93";
                    changes.is_closed      = carrierIsClosed || allPaid;
                    changes.portfolio_type = "O";
                    changes.account_type   = "48";

                    if (isCurrent) {
                        // Active client in collection: no delinquency date shown,
                        // and blank last_payment / date_closed per reporting rules.
                        changes.date_first_delinquency = "";
                        changes.date_last_payment      = "";
                        changes.date_closed            = "";
                    } else {
                        // Delinquency date from collection DB (source of truth)
                        if (delinqDate) {
                            changes.date_first_delinquency = delinqDate;
                        } else if (!derived.date_first_delinquency) {
                            changes.date_first_delinquency = "";
                        }
                    }
                } else if (isCurrent) {
                    // In collection-db, no agency placement, status=11:
                    // no delinquency date, blank last_payment.
                    if (derived.date_first_delinquency) changes.date_first_delinquency = "";
                    changes.date_last_payment = "";
                } else {
                    // In collection-db but NOT yet placed with any agency: no G codes.
                    // Strip any G the sync engine may have placed (from SMP debtor tag).
                    const php = derived.payment_history_profile || "";
                    if (php.includes("G")) {
                        // Replace each G with the delinquency escalation code for that month
                        const parseAbs = (iso) => {
                            if (!iso || iso.length < 7) return 0;
                            const y = parseInt(iso.slice(0, 4));
                            const m = parseInt(iso.slice(5, 7));
                            return isNaN(y) || isNaN(m) ? 0 : y * 12 + m;
                        };
                        const delinqAbs = parseAbs(delinqDate);
                        const today = new Date();
                        const RY = today.getFullYear(), RM = today.getMonth() + 1;
                        changes.payment_history_profile = php.split("").map((ch, n) => {
                            if (ch !== "G") return ch;
                            if (!delinqAbs) return "6";
                            const totalMonths = RY * 12 + RM - 1 - n;
                            const mYear = Math.floor(totalMonths / 12);
                            const mMonth = (totalMonths % 12) + 1;
                            const mAbs = mYear * 12 + mMonth;
                            return String(Math.min(6, Math.max(1, mAbs - delinqAbs + 1)));
                        }).join("");
                    }
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
        // LOC report (default): SMP tagIds=2 AND Zoho Card Swiped deal (matched carrier IDs)
        carriers = carriers.filter((carrier) =>
            hasCmpTag(carrier, 2) && hasZohoCardSwiped(carrier)
        );
    }

    if (query.include_inactive !== "true") {
        carriers = carriers.filter((carrier) => !isCarrierClosed(carrier));
    }

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
