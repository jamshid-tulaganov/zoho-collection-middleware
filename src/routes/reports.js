import { Router } from "express";
import ExcelJS from "exceljs";
import { readCarrierDb, runCarrierDbSync } from "../services/syncCarrierDb.js";

const router = Router();

// ── Metro 2 column definitions (48 fields, exact Array workbook order) ──

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

function carrierToRow(carrier) {
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

function isoToMmddyyyy(value) {
    const raw = String(value || "").trim();
    if (/^\d{8}$/.test(raw)) return raw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
    return raw.slice(5, 7) + raw.slice(8, 10) + raw.slice(0, 4);
}

async function maybeSyncCarrierDb(query) {
    if (query.sync !== "true") return null;
    const result = await runCarrierDbSync();
    if (result && result.success === false) {
        throw new Error(result.error || "Carrier DB sync failed");
    }
    return result;
}

function loadReportCarriers(query) {
    const db = readCarrierDb();
    let carriers = Object.values(db);

    if (query.type === "debtor") {
        carriers = carriers.filter((carrier) => carrier.derived?.is_debtor);
    }
    if (query.type === "loc") {
        carriers = carriers.filter((carrier) => !carrier.derived?.is_debtor);
    }
    if (query.missing_dob === "true") {
        carriers = carriers.filter((carrier) => !carrier.derived?.dob);
    }

    carriers.sort((a, b) => String(a.carrier_id || "").localeCompare(String(b.carrier_id || "")));
    return carriers;
}

/**
 * GET /reports/generate
 * Streams an Excel file in Metro 2 / Array format from carrier-db.json.
 * Optional: ?sync=true to refresh the cache before generating.
 */
router.get("/generate", async (req, res) => {
    try {
        await maybeSyncCarrierDb(req.query);
        const carriers = loadReportCarriers(req.query);

        if (!carriers.length) {
            return res.status(404).json({ error: "No records found in carrier-db.json" });
        }

        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `Array_Credit_Report_${dateStr}.xlsx`;
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

        const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
        const ws = workbook.addWorksheet("Octane Array Report");

        ws.getCell("A1").value = `Octane Array Report (Metro 2 Export) — ${dateStr}`;
        ws.getCell("A1").font = { bold: true, size: 14 };
        ws.getRow(1).commit();

        const headerRow = ws.getRow(2);
        for (let c = 0; c < HEADERS.length; c++) {
            const cell = headerRow.getCell(c + 1);
            cell.value = HEADERS[c];
            cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
            cell.alignment = { wrapText: true };
        }
        headerRow.commit();

        const descRow = ws.getRow(3);
        for (let c = 0; c < DESC_ROW.length; c++) {
            const cell = descRow.getCell(c + 1);
            cell.value = DESC_ROW[c];
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
            cell.font = { size: 8, italic: true };
        }
        descRow.commit();

        const reqRow = ws.getRow(4);
        for (let c = 0; c < REQUIRED_ROW.length; c++) {
            if (REQUIRED_ROW[c]) {
                const cell = reqRow.getCell(c + 1);
                cell.value = REQUIRED_ROW[c];
                cell.font = { bold: true, color: { argb: "FFFF0000" } };
            }
        }
        reqRow.commit();

        const widthRow = ws.getRow(5);
        for (let c = 0; c < WIDTH_ROW.length; c++) {
            widthRow.getCell(c + 1).value = WIDTH_ROW[c];
        }
        widthRow.commit();

        const peachOdd = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
        const peachEven = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE9D9" } };

        for (let i = 0; i < carriers.length; i++) {
            const rowData = carrierToRow(carriers[i]);
            const fill = i % 2 === 0 ? peachOdd : peachEven;
            const dataRow = ws.getRow(6 + i);

            for (let c = 0; c < HEADERS.length; c++) {
                const cell = dataRow.getCell(c + 1);
                cell.value = rowData[HEADERS[c]] || "";
                cell.fill = fill;
            }
            dataRow.commit();
        }

        for (let c = 0; c < HEADERS.length; c++) {
            ws.getColumn(c + 1).width = Math.max(12, HEADERS[c].length + 2);
        }

        ws.commit();
        await workbook.commit();
    } catch (err) {
        console.error("[report] Generation error:", err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to generate report" });
        }
    }
});

/**
 * GET /reports/json
 * Returns the report payload as JSON from carrier-db.json.
 * Optional: ?sync=true to refresh the cache first.
 */
router.get("/json", async (req, res) => {
    try {
        const syncResult = await maybeSyncCarrierDb(req.query);
        const carriers = loadReportCarriers(req.query);

        const rows = {};
        for (const carrier of carriers) {
            rows[carrier.carrier_id] = carrierToRow(carrier);
        }

        res.json({
            count: carriers.length,
            generatedAt: new Date().toISOString(),
            source: "carrier-db.json",
            sync: syncResult,
            data: rows,
        });
    } catch (err) {
        console.error("[report] JSON error:", err.message);
        res.status(500).json({ error: "Failed to generate report" });
    }
});

export default router;
