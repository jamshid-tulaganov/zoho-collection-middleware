/**
 * Pre-submit validation for Array credit report.
 * Catches errors that would be rejected by the bureau before sending.
 */

/**
 * Validate a single report row against Array/bureau rules.
 * @param {object} row - Output from carrierToRow()
 * @returns {string[]} Array of error messages (empty = valid)
 */
export function validateRow(row) {
    const errors = [];
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    // Format: MMddYYYY → comparable as YYYYMMDD
    const toComparable = (mmddyyyy) => {
        if (!mmddyyyy || mmddyyyy.length !== 8) return "";
        return mmddyyyy.slice(4, 8) + mmddyyyy.slice(0, 2) + mmddyyyy.slice(2, 4);
    };

    const status = row["Account Status"];
    const php = row["Payment History Profile"] || "";
    const dateOpen = row["Date Open"];
    const dateClosed = row["Date Closed"];
    const dateDelinq = row["Date of First Delinquency"];
    const highestCredit = Number(row["Highest Credit"] || 0);
    const creditLimit = Number(row["Credit Limit"] || 0);
    const dob = row["Date of Birth"];
    const firstName = row["First Name"];
    const lastName = row["Last Name"];
    const carrierId = row["Customer Account Number"];

    // 1. Account Status 93 — never allowed (TSS is creditor, not agency)
    if (status === "93") {
        errors.push(`Status 93 not allowed (use 71-84 for delinquent)`);
    }

    // 2. Date Closed must not be in the future
    if (dateClosed) {
        const closedComp = toComparable(dateClosed);
        if (closedComp > todayStr) {
            errors.push(`Date Closed in future: ${dateClosed}`);
        }
    }

    // 3. Delinquency date must be blank when status is 11 (current)
    if (status === "11" && dateDelinq) {
        errors.push(`Delinquency date must be blank when status is 11 (current)`);
    }

    // 4. Delinquency date required when status is delinquent (71-84)
    if (["71", "78", "80", "82", "83", "84"].includes(status) && !dateDelinq) {
        errors.push(`Delinquency date required for status ${status}`);
    }

    // 5. Delinquency date must be in the past
    if (dateDelinq) {
        const delinqComp = toComparable(dateDelinq);
        if (delinqComp > todayStr) {
            errors.push(`Delinquency date in future: ${dateDelinq}`);
        }
    }

    // 6. Highest Credit required (warning-level but we flag it)
    if (highestCredit <= 0) {
        errors.push(`Highest Credit is 0 (required by bureau)`);
    }

    // 7. DOB required
    if (!dob) {
        errors.push(`DOB is missing`);
    }

    // 8. Date Open required
    if (!dateOpen) {
        errors.push(`Date Open is missing`);
    }

    // 9. First + Last name required
    if (!firstName || !lastName) {
        errors.push(`Name incomplete: "${firstName} ${lastName}"`);
    }

    // 10. PHP length must be 24
    if (php && php.length !== 24) {
        errors.push(`PHP length ${php.length} (must be 24)`);
    }

    // 11. PHP should not have invalid characters
    if (php && /[^B0-6GDL]/.test(php)) {
        errors.push(`PHP has invalid characters: ${php}`);
    }

    return errors;
}

/**
 * Validate all report rows and return a summary.
 * @param {object[]} rows - Array of row objects from buildReportRows()
 * @returns {{ valid: number, invalid: number, errors: Array<{carrierId, errors}>, summary: object }}
 */
export function validateReport(rows) {
    let valid = 0;
    let invalid = 0;
    const errorRows = [];
    const summary = {};

    for (const row of rows) {
        const rowErrors = validateRow(row);
        if (rowErrors.length === 0) {
            valid++;
        } else {
            invalid++;
            errorRows.push({
                carrierId: row["Customer Account Number"],
                errors: rowErrors,
            });
            for (const err of rowErrors) {
                const key = err.split(":")[0].trim();
                summary[key] = (summary[key] || 0) + 1;
            }
        }
    }

    return { valid, invalid, errors: errorRows, summary };
}

/**
 * Format validation results as a human-readable Telegram message.
 */
export function formatValidationMessage(validation, totalCarriers) {
    const { valid, invalid, summary } = validation;
    const lines = [
        `Validation: ${valid} valid, ${invalid} errors (${totalCarriers} total)`,
    ];

    if (invalid === 0) {
        lines.push("All carriers passed validation.");
    } else {
        lines.push("");
        for (const [error, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
            lines.push(`  ${error}: ${count}`);
        }
    }

    return lines.join("\n");
}
