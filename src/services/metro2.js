/**
 * Metro 2 computation engine.
 * Port of run-full-sync.py — computes all 48 Array credit report fields
 * for a single carrier given SMP company, Zoho Deal, and master_db entry.
 */

import dayjs from "dayjs"; // <-- NEW: date helper
import { normalizeDob } from "./dob.js";

/* ── Helpers ──────────────────────────────────────────────────────── */

export function parseDate(s) {
    if (!s) return null;
    const str = String(s).trim().split(".")[0].split("T")[0];
    if (!str || ["null", "None", "0"].includes(str)) return null;
    if (str.length >= 10 && str[4] === "-") {
        const y = parseInt(str.slice(0, 4));
        const m = parseInt(str.slice(5, 7));
        const d = parseInt(str.slice(8, 10));
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            return { year: y, month: m, day: d, iso: `${str.slice(0, 10)}` };
        }
    }
    return null;
}

export function fmtMmddyyyy(isoDate) {
    if (!isoDate || isoDate.length < 10) return "";
    return isoDate.slice(5, 7) + isoDate.slice(8, 10) + isoDate.slice(0, 4);
}

export function cleanPhone(val) {
    const s = String(val || "").split(".")[0];
    let digits = s.replace(/[^0-9]/g, "");
    if (digits.length > 10) digits = digits.slice(-10);
    return digits.length === 10 ? digits : "";
}

function splitAddress(address) {
    let a1 = (address || "").trim();
    let a2 = "";
    if (!a1) return { a1, a2 };

    const upper = a1.toUpperCase();
    const markers = [
        [" SUITE", "SUITE"],
        [" APT", "APT"],
        [" UNIT", "UNIT"],
        [" STE", "STE"],
        [" FLOOR", "FLOOR"],
        [" FL ", "FL "],
        [" #", "#"],
    ];

    for (const [search, marker] of markers) {
        if (upper.includes(search)) {
            const re = new RegExp(
                ` ${marker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}.*`,
                "i",
            );
            const street = a1.replace(re, "").trim();
            const reApt = new RegExp(
                `^.*? ${marker.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`,
                "i",
            );
            const apt = a1.replace(reApt, marker).trim();
            if (street.length > 0 && street.length < a1.length) {
                a1 = street;
                a2 = apt;
            }
            break;
        }
    }
    return { a1, a2 };
}

/* ── Main computation ─────────────────────────────────────────────── */

export function computeMetro2(cid, comp, deal, dbEntry, existing, invoiceData) {
    const today = new Date();
    const RY = today.getFullYear();
    const RM = today.getMonth() + 1;
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    // ── Contact: SMP owners → Deal fallback ──
    let fn = deal ? (deal.First_name || "").trim() : "";
    let ln = deal ? (deal.Last_Name || "").trim() : "";
    if (comp) {
        const owners = comp.owners || [];
        if (owners.length) {
            const sf = (owners[0].firstName || "").trim();
            const sl = (owners[0].lastName || "").trim();
            if (sf) fn = sf;
            if (sl) ln = sl;
        }
    }

    // ── Address: SMP primary → Deal fallback ──
    let smpAddr1 = "",
        smpAddr2 = "",
        smpCity = "",
        smpState = "",
        smpZip = "";
    if (comp) {
        const ao = comp.address || {};
        smpAddr1 = (ao.addressLine1 || "").trim();
        smpAddr2 = (ao.addressLine2 || "").trim();
        smpCity = (ao.city || "").trim();
        smpState = (ao.state || "").trim();
        smpZip = (ao.postalCode || "").trim();
    }

    let dealAddr = deal ? (deal.Address || "").trim() : "";
    let a1 = dealAddr;
    let a2 = null;

    if (!a2) {
        const split = splitAddress(a1);
        a1 = split.a1;
        a2 = split.a2;
    }

    let sCity = deal ? (deal.City || "").trim() : "";
    let sState = deal ? (deal.State || "").trim() : "";
    let sZip = deal ? (deal.Zip_Code || "").trim() : "";
    if (smpCity) sCity = smpCity;
    if (smpState) sState = smpState;
    if (smpZip) sZip = smpZip;

    // ── DOB + Credit Score from Deal / master DB ──
    let dealDobRaw = deal ? String(deal.Birth_Of_Date || "").trim() : "";
    let dealCreditScore = deal ? String(deal.Credit_Score || "").trim() : "";
    let dobFormatted = normalizeDob(dealDobRaw) || normalizeDob(dbEntry?.dob);

    // ── SMP financial fields ──
    const phone = comp ? cleanPhone(comp.contactPhone) : "";
    const creditLimit = comp ? Math.floor(Number(comp.creditLimit || 0)) : 0;
    const smpCreditScore = comp ? String(comp.creditScore || "").trim() : "";

    // Account open date = Deal Application_Date
    let acctOpenDate = "";
    if (deal) {
        const appDate = String(deal.Application_Date || "").trim();
        if (
            appDate &&
            !["null", "None"].includes(appDate) &&
            appDate.length >= 10
        ) {
            acctOpenDate = appDate.slice(0, 10);
        }
    }

    // ── Debtor check ──
    const isDebtor = invoiceData.isDebtor;

    // ── Dates & other numbers from invoiceData ──
    let {
        dateFirstDelinquency,
        dateOfLastPayment,
        isClosed,
        dateClosed,
        invoiceMonths = {},
        collectionStartDate = "",
        amountPastDue = 0,
        actualPayment = 0,
    } = invoiceData;

    // ── COQL existing record fallback ──
    let existingDelinqDate = "";
    const wasFormerDebtor = false;
    if (existing) {
        existingDelinqDate = String(existing.Date_of_First_Delinquency || "");
        const existingDob = String(existing.Date_of_Birth || "");
        const existingCreditScore = String(existing.Credit_Score || "");

        if (
            !dobFormatted &&
            existingDob &&
            !["null", "None", ""].includes(existingDob)
        ) {
            dobFormatted = normalizeDob(existingDob);
        }
        if (
            ["", "null", "None", "0"].includes(dealCreditScore) &&
            !["", "null", "None", "0"].includes(existingCreditScore)
        ) {
            dealCreditScore = existingCreditScore;
        }
    }

    // Former debtor = not debtor now, but has stored delinq date
    const wasFormer =
        !isDebtor && !["", "null", "None"].includes(existingDelinqDate);

    // ── Highest Credit = Credit Score ──
    let highestCredit = 0;
    if (dealCreditScore && !["null", "None", "0"].includes(dealCreditScore)) {
        highestCredit = Math.floor(Number(dealCreditScore)) || 0;
    } else if (
        smpCreditScore &&
        !["null", "None", "0"].includes(smpCreditScore)
    ) {
        highestCredit = Math.floor(Number(smpCreditScore)) || 0;
    }
    if (!highestCredit && dbEntry.credit_score) {
        highestCredit = parseInt(dbEntry.credit_score) || 0;
    }

    // ── Current Balance ──
    let currentBalance = 0;
    if (!isDebtor && !isClosed) {
        currentBalance = creditLimit;
    } else if (isDebtor) {
        currentBalance = Math.min(Math.round(amountPastDue), 999999999);
    }

    // ── Payment History Profile (24‑char) ──
    const hasOpenDate = acctOpenDate !== "";
    let openYear = 0,
        openMonth = 0;
    if (hasOpenDate) {
        openYear = parseInt(acctOpenDate.slice(0, 4));
        openMonth = parseInt(acctOpenDate.slice(5, 7));
    }

    // Parse delinquency date
    let hasDelinqDate = false;
    let delinqYear = 0,
        delinqMonth = 0;
    if (dateFirstDelinquency && dateFirstDelinquency.length >= 7) {
        hasDelinqDate = true;
        delinqYear = parseInt(dateFirstDelinquency.slice(0, 4));
        delinqMonth = parseInt(dateFirstDelinquency.slice(5, 7));
    } else if (
        existingDelinqDate &&
        !["null", "None", ""].includes(existingDelinqDate)
    ) {
        if (
            existingDelinqDate.includes("-") &&
            existingDelinqDate.length >= 7
        ) {
            hasDelinqDate = true;
            delinqYear = parseInt(existingDelinqDate.slice(0, 4));
            delinqMonth = parseInt(existingDelinqDate.slice(5, 7));
        } else if (existingDelinqDate.length >= 8) {
            hasDelinqDate = true;
            delinqMonth = parseInt(existingDelinqDate.slice(0, 2));
            delinqYear = parseInt(existingDelinqDate.slice(4, 8));
        }
    }

    // Parse closed date
    let hasClosedDate = false;
    let closedYear = 0,
        closedMonth = 0;
    if (dateClosed && dateClosed.length >= 7) {
        hasClosedDate = true;
        closedYear = parseInt(dateClosed.slice(0, 4));
        closedMonth = parseInt(dateClosed.slice(5, 7));
    }

    // Active non-debtors with a recent last payment (1-2 months ago)
    // are treated as recently closed for reporting.
    let recentPaymentClosed = false;
    if (!isDebtor && !isClosed && dateOfLastPayment && dateOfLastPayment.length >= 10) {
        const monthsSinceLastPayment =
            (RY - parseInt(dateOfLastPayment.slice(0, 4))) * 12 +
            (RM - parseInt(dateOfLastPayment.slice(5, 7)));
        if (monthsSinceLastPayment >= 1 && monthsSinceLastPayment <= 2) {
            recentPaymentClosed = true;
            isClosed = true;
            if (!dateClosed) {
                dateClosed = dateOfLastPayment.slice(0, 10);
                hasClosedDate = true;
                closedYear = parseInt(dateClosed.slice(0, 4));
                closedMonth = parseInt(dateClosed.slice(5, 7));
            }
        }
    }

    // Close grace: regular closes keep grace; recent-payment closes start D immediately.
    let closeDStartAbs = 0;
    if (hasClosedDate) {
        closeDStartAbs = closedYear * 12 + closedMonth + (recentPaymentClosed ? 0 : 2);
    }

    // Collection start
    let hasCollectionStart = false;
    let collectionStartAbs = 0;
    if (collectionStartDate && collectionStartDate.length >= 7) {
        const collectionYear = parseInt(collectionStartDate.slice(0, 4));
        const collectionMonth = parseInt(collectionStartDate.slice(5, 7));
        if (!isNaN(collectionYear) && !isNaN(collectionMonth)) {
            hasCollectionStart = true;
            collectionStartAbs = collectionYear * 12 + collectionMonth;
        }
    }

    const coveredMonths = invoiceMonths || {};
    const coveredMonthKeys = Object.keys(coveredMonths).filter((k) => /^\d{4}-\d{2}$/.test(k));
    const hasCoverageData = coveredMonthKeys.length > 0;
    let firstCoveredAbs = 0;
    for (const key of coveredMonthKeys) {
        const year = parseInt(key.slice(0, 4));
        const month = parseInt(key.slice(5, 7));
        if (isNaN(year) || isNaN(month)) continue;
        const abs = year * 12 + month;
        if (!firstCoveredAbs || abs < firstCoveredAbs) firstCoveredAbs = abs;
    }
    const openAbs = hasOpenDate ? openYear * 12 + openMonth : 0;

    let paymentHistoryProfile = "";
    for (let n = 0; n < 24; n++) {
        const totalMonths = RY * 12 + RM - 1 - n;
        const mYear = Math.floor(totalMonths / 12);
        const mMonth = (totalMonths % 12) + 1;
        const mAbs = mYear * 12 + mMonth;
        const monthKey = `${mYear}-${String(mMonth).padStart(2, "0")}`;

        let code = "0";

        // Before account opened → B
        if (
            hasOpenDate &&
            (mYear < openYear || (mYear === openYear && mMonth < openMonth))
        ) {
            code = "B";
        }
        // After close + grace → D
        else if (
            hasClosedDate &&
            closeDStartAbs > 0 &&
            mAbs >= closeDStartAbs
        ) {
            code = "D";
        }
        // Collection / GGR placement means the account is in collections
        // starting that month, regardless of invoice coverage.
        else if (hasCollectionStart && mAbs >= collectionStartAbs) {
            code = "G";
        }
        // No invoice/payment evidence for the month:
        // - gap between open date and first observed invoice/payment month → O
        // - otherwise → B
        else if (!coveredMonths[monthKey]) {
            const inOpenToFirstCoverageGap =
                hasCoverageData &&
                hasOpenDate &&
                firstCoveredAbs > 0 &&
                mAbs >= openAbs &&
                mAbs < firstCoveredAbs;
            code = inOpenToFirstCoverageGap ? "0" : "B";
        }
        // Delinquent period → graduated codes (with 2026‑special rule)
        else if (
            hasDelinqDate &&
            (mYear > delinqYear ||
                (mYear === delinqYear && mMonth >= delinqMonth))
        ) {
            // Closed accounts still win the "D" code (grace period applies)
            if (hasClosedDate && closeDStartAbs > 0 && mAbs >= closeDStartAbs) {
                code = "D";
            } else {
                // How many months have passed since the first‑delinquency month?
                const monthsPast =
                    (mYear - delinqYear) * 12 + (mMonth - delinqMonth);

                // ── NEW SPECIAL CASE ────────────────────────────────────────
                // - First delinquency is in the year 2026
                // - The delinquency is 0‑2 months old (monthsPast ≤ 2)
                // - There is a recorded last‑payment date that occurs AFTER the
                //   first‑delinquency date (i.e. a payment was made)
                // If all of the above are true we treat the month as "1"
                // (the normal 30‑day delinquency) instead of falling into the
                // generic "G" (greater‑than‑6‑months) bucket.
                if (
                    delinqYear === 2026 && // first delinquency in 2026
                    monthsPast <= 2 && // not longer than 2 months
                    dateOfLastPayment && // we have a last‑payment date
                    dateOfLastPayment.length >= 10 && // quick sanity check
                    dayjs(dateOfLastPayment).isAfter(
                        dayjs(dateFirstDelinquency),
                    )
                ) {
                    code = "1"; // 30‑day delinquency
                }
                // ── END OF SPECIAL CASE ────────────────────────────────────────
                else if (monthsPast <= 0) {
                    code = "0";
                } else if (monthsPast <= 6) {
                    code = String(monthsPast);
                } else {
                    code = "G";
                }
            }
        }
        paymentHistoryProfile += code;
    }

    // ── Account Status (graduated) ──
    let acctStatus = "11";
    if (hasDelinqDate && (isDebtor || (hasDelinqDate && !hasClosedDate))) {
        const monthsPastNow = (RY - delinqYear) * 12 + (RM - delinqMonth);
        if (monthsPastNow >= 6) acctStatus = "84";
        else if (monthsPastNow >= 5) acctStatus = "83";
        else if (monthsPastNow >= 4) acctStatus = "82";
        else if (monthsPastNow >= 3) acctStatus = "80";
        else if (monthsPastNow >= 2) acctStatus = "78";
        else if (monthsPastNow >= 1) acctStatus = "71";
    }
    if (isClosed && acctStatus === "11") acctStatus = "13";
    if (wasFormer && hasClosedDate) acctStatus = "13";
    const accountType = isClosed ? "13" : "15";

    // ── Field truncation ──
    if (fn.length > 20) fn = fn.slice(0, 20);
    if (ln.length > 25) ln = ln.slice(0, 25);
    if (a1.length > 32) a1 = a1.slice(0, 32);
    if (a2.length > 32) a2 = a2.slice(0, 32);
    if (sCity.length > 20) sCity = sCity.slice(0, 20);
    if (highestCredit > 999999999) highestCredit = 999999999;

    // ── Date formatting: yyyy-MM-dd → MMddyyyy ──
    let acctOpenFmt = fmtMmddyyyy(acctOpenDate);
    let dateFirstDelinqFmt = fmtMmddyyyy(dateFirstDelinquency);
    let dateClosedFmt = "";
    if ((wasFormer || isClosed || acctStatus === "13") && dateClosed) {
        dateClosedFmt = fmtMmddyyyy(dateClosed);
    }
    let dateLastPaymentFmt = fmtMmddyyyy(dateOfLastPayment);

    // Zip: 5 digits only
    let postal = sZip.replace(/[^0-9]/g, "");
    if (postal.length > 5) postal = postal.slice(0, 5);

    return {
        clientId: cid,
        companyName: comp ? (comp.name || "").trim() : dbEntry.company || "",

        // Section A
        associationCode: "1",
        firstName: fn,
        middleName: "",
        lastName: ln,
        generationCode: "",
        address1: a1,
        address2: a2,
        city: sCity,
        state: sState,
        zipCode: postal,
        ssn: "",
        phone,
        dateOfBirth: dobFormatted,
        consumerInfoIndicator: "",

        // Section C
        portfolioType: "C",
        accountType,
        dateOpen: acctOpenFmt,
        dateFirstDelinquency: dateFirstDelinqFmt,
        dateLastPayment: dateLastPaymentFmt,
        dateClosed: dateClosedFmt,
        accountStatus: acctStatus,
        paymentRating: "",
        specialCommentCode: "",
        complianceConditionCode: "",
        creditLimit,
        highestCredit,
        currentBalance,
        amountPastDue: Math.min(Math.round(amountPastDue), 999999999),
        monthlyPayment: 0,
        actualPayment: Math.min(Math.round(actualPayment), 999999999),
        termsFrequency: "W",
        terms: "001",
        originalChargeOffAmount: 0,
        paymentHistoryProfile,

        // ISO dates (for internal use)
        dateOpenIso: acctOpenDate,
        dateFirstDelinquencyIso: dateFirstDelinquency || "",
        dateLastPaymentIso: dateOfLastPayment || "",
        dateClosedIso: dateClosed || "",
        acctOpenDateIso: acctOpenDate,

        // Source flags
        isDebtor,
        isClosed,
        wasFormerDebtor: wasFormer,

        lastSyncedAt: new Date(),
    };
}
