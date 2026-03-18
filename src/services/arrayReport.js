import ExcelJS from "exceljs";
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

export function carrierToRow(carrier) {
    const derived = carrier.derived || {};
    const creditScore = derived.credit_score || derived.highest_credit || "";

    return {
        "Association Code": "1",
        "First Name": derived.first_name || "",
        "Middle Name": "",
        "Last Name": derived.last_name || "",
        "Generation Code": "",
        "First Line of Address": derived.addr1 || "",
        "Second Line of Address": derived.addr2 || "",
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
        "Date Closed": isoToMmddyyyy(derived.date_closed),
        "Account Status": derived.account_status || "11",
        "Payment Rating": "",
        "Special Comment Code": "",
        "Compliance Condition Code": "",
        "Credit Limit": String(derived.credit_limit || 0),
        "Highest Credit": String(derived.highest_credit || creditScore || 0),
        "Current Balance": String(derived.current_balance || 0),
        "Amount Past Due": String(derived.amount_past_due || 0),
        "Monthly Payment": "0",
        "Actual Payment": String(derived.actual_payment || 0),
        "Terms Frequency": "W",
        "Terms": "001",
        "Original Charge Off Amount": "0",
        "Payment History Profile": derived.payment_history_profile || "",
    };
}

export function loadReportCarriers(query = {}) {
    const db = readCarrierDb();
    let carriers = Object.values(db);

    if (query.type === "debtor" || query.debtors === "true") {
        carriers = carriers.filter((carrier) => carrier.derived?.is_debtor);
    }
    if (query.type === "loc" || query.debtors === "false") {
        carriers = carriers.filter((carrier) => !carrier.derived?.is_debtor);
    }
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
