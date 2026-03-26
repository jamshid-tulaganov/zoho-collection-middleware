import ExcelJS from "exceljs";
import { env } from "../config/env.js";
import { loadDobMap, loadMergedMasterDb } from "./dob.js";
import { readCarrierDb } from "./syncCarrierDb.js";

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
    "Amount Past Due", "Monthly Payment", "Actual Payment", "Terms Frequency", "Terms",
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
    "Credit score or highest balance", "Outstanding balance $", "Past-due amount $",
    "Scheduled monthly payment", "Actual payment received", "W=Weekly M=Monthly",
    "Number of payments (001)", "Charge-off amount $", "24-char Metro 2 history B/0-6/G/D",
];

const REQUIRED_ROW = [
    "R", "R", null, "R", null, "R", null, "R", "R", "R", null, null, null, null,
    null, null, null, null, null, null, null, null, null, null, null, null, null,
    "R", "R", "R", "R", null, null, null, "R", null, null, null, null, null, "R",
    null, null, null, "R", "R", null, "R",
];

const WIDTH_ROW = [
    "1", "20", "20", "25", "2", "32", "32", "20", "2", "5", "9", "10", "8", "2",
    "1", "20", "20", "25", "32", "32", "20", "2", "5", "9", "10", "8", "2", "30",
    "1", "2", "8", "8", "8", "8", "2", "1", "2", "2", "9", "9", "9", "9", "9", "9",
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

export function carrierToRow(carrier) {
    const derived = carrier.derived || {};
    const creditScore = derived.credit_score || derived.highest_credit || "";
    const reportCloseDate = derived.is_debtor
        ? derived.date_last_payment
        : ((derived.is_closed || derived.was_former_debtor) ? derived.date_closed : "");
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
        "Portfolio Type": "C",
        "Account Type": "15",
        "Date Open": isoToMmddyyyy(derived.date_open),
        "Date of First Delinquency": isoToMmddyyyy(derived.date_first_delinquency),
        "Date of Last Payment": isoToMmddyyyy(derived.date_last_payment),
        "Date Closed": isoToMmddyyyy(reportCloseDate),
        "Account Status": derived.account_status || "11",
        "Payment Rating": "",
        "Special Comment Code": "",
        "Compliance Condition Code": "",
        "Credit Limit": String(derived.credit_limit || 0),
        "Highest Credit": String(derived.highest_credit || creditScore || 0),
        "Current Balance": String(derived.current_balance || 0),
        "Amount Past Due": "",
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
    const wantsDebtors = query.type === "debtor" || query.debtors === "true";
    const wantsLoc = query.type === "loc" || query.debtors === "false";

    if (query.scope !== "all") {
        if (wantsDebtors) {
            carriers = carriers.filter((carrier) => hasCmpTag(carrier, 1));
        } else {
            carriers = carriers.filter((carrier) => hasCmpTag(carrier, 2) && hasZohoCardSwiped(carrier));
        }
    }

    if (query.scope === "all") {
        if (wantsDebtors) {
            carriers = carriers.filter((carrier) => carrier.derived?.is_debtor);
        }
        if (wantsLoc) {
            carriers = carriers.filter((carrier) => !carrier.derived?.is_debtor);
        }
    }

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

export function buildArrayReportFilename(date = new Date()) {
    return `Array_Credit_Report_${buildDateStamp(date)}.xlsx`;
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
