/**
 * Metro 2 computation engine.
 * Port of run-full-sync.py — computes all 48 Array credit report fields
 * for a single carrier given SMP company, Zoho Deal, and master_db entry.
 */

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

    // ── Contact priority: accounting/Zoho(deal) → SMP owners → common-carriers-db ──
    let fn = deal ? (deal.First_name || "").trim() : "";
    let ln = deal ? (deal.Last_Name || "").trim() : "";
    if (comp && (!fn || !ln)) {
        const owners = comp.owners || [];
        if (owners.length) {
            const sf = (owners[0].firstName || "").trim();
            const sl = (owners[0].lastName || "").trim();
            if (!fn && sf) fn = sf;
            if (!ln && sl) ln = sl;
        }
    }
    if (!fn) fn = String(dbEntry?.first_name || "").trim();
    if (!ln) ln = String(dbEntry?.last_name || "").trim();

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
    if (!sCity && smpCity) sCity = smpCity;
    if (!sState && smpState) sState = smpState;
    if (!sZip && smpZip) sZip = smpZip;
    // Fall back to common-carriers-db flat fields if no SMP/Deal address
    if (!a1) a1 = String(dbEntry?.address || "").trim();
    if (!sCity) sCity = String(dbEntry?.city || "").trim();
    if (!sState) sState = String(dbEntry?.state || "").trim();
    if (!sZip) sZip = String(dbEntry?.zip_code || "").trim();

    // ── DOB + Credit Score from Deal / master DB ──
    let dealDobRaw = deal ? String(deal.Birth_Of_Date || "").trim() : "";
    let dealCreditScore = deal ? String(deal.Credit_Score || "").trim() : "";
    let dobFormatted = normalizeDob(dealDobRaw) || normalizeDob(dbEntry?.dob);

    // ── SMP financial fields ──
    const phone = comp ? cleanPhone(comp.contactPhone) : "";
    const creditLimit = comp ? Math.floor(Number(comp.creditLimit || 0)) : 0;
    const smpCreditScore = comp ? String(comp.creditScore || "").trim() : "";

    // Account open date: Deal Application_Date (= date_filled from accounting, or Zoho Application_Date)
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

    // Collection start — also sets delinquency to 6 months before collection
    let hasCollectionStart = false;
    let collectionStartAbs = 0;
    if (collectionStartDate && collectionStartDate.length >= 7) {
        const collectionYear = parseInt(collectionStartDate.slice(0, 4));
        const collectionMonth = parseInt(collectionStartDate.slice(5, 7));
        if (!isNaN(collectionYear) && !isNaN(collectionMonth)) {
            hasCollectionStart = true;
            collectionStartAbs = collectionYear * 12 + collectionMonth;
            // Date of First Delinquency = 6 months before collection placement
            const dAbs = collectionStartAbs - 6;
            const dY = Math.floor((dAbs - 1) / 12);
            const dM = ((dAbs - 1) % 12) + 1;
            dateFirstDelinquency = `${dY}-${String(dM).padStart(2, "0")}-01`;
        }
    }

    const openAbs = hasOpenDate ? openYear * 12 + openMonth : 0;
    let hasLastPaymentDate = false;
    let lastPaymentAbs = 0;
    if (dateOfLastPayment && dateOfLastPayment.length >= 7) {
        const lpYear = parseInt(dateOfLastPayment.slice(0, 4));
        const lpMonth = parseInt(dateOfLastPayment.slice(5, 7));
        if (!isNaN(lpYear) && !isNaN(lpMonth)) {
            hasLastPaymentDate = true;
            lastPaymentAbs = lpYear * 12 + lpMonth;
        }
    }

    // All closed accounts with a known date show D codes — no 30-day restriction.
    const useDProfile = Boolean(isClosed && (hasClosedDate || hasLastPaymentDate));

    // Parse delinquency absolute month for 2/3/4/5 codes
    const delinqAbs = hasDelinqDate ? delinqYear * 12 + delinqMonth : 0;

    let paymentHistoryProfile = "";
    for (let n = 0; n < 24; n++) {
        const totalMonths = RY * 12 + RM - 1 - n;
        const mYear = Math.floor(totalMonths / 12);
        const mMonth = (totalMonths % 12) + 1;
        const mAbs = mYear * 12 + mMonth;

        // Per Array spec: 0=current(0-29d), 1=30-59d, 2=60-89d, 3=90-119d,
        //                 4=120-149d, 5=150-179d, 6=180d+
        //                 B=before open, D=no history (closed), G=collection, L=charge-off
        let code = "0"; // default: current / pays as agreed

        // Before account opened → B (no payment history prior to open)
        if (hasOpenDate && mAbs < openAbs) {
            code = "B";
        }
        // Closed account: months at/after close grace period → D (no data after closure)
        else if (useDProfile && mAbs >= closeDStartAbs) {
            code = "D";
        }
        // Collection: G from placement month onward, 6→5→4→3→2→1 for 6 months before
        // Profile reads: ...GGGG654321000... (G=in collection, delinquency escalated to placement)
        else if (hasCollectionStart && mAbs >= collectionStartAbs) {
            code = "G";
        }
        else if (hasCollectionStart && mAbs >= collectionStartAbs - 6) {
            // 6 months leading up to collection: 1(oldest) → 6(newest, month before G)
            const monthsBefore = collectionStartAbs - mAbs; // 1..6
            code = String(7 - monthsBefore); // 1→6, 2→5, 3→4, 4→3, 5→2, 6→1
        }
        // Delinquency: month 0=current, then 1→2→3→4→5→6→G
        // Same month as delinquency = still within 30 days = "0" (current)
        else if (hasDelinqDate && mAbs > delinqAbs) {
            const monthsPastDue = mAbs - delinqAbs;
            if (monthsPastDue >= 7) code = "G";
            else if (monthsPastDue >= 6) code = "6";
            else if (monthsPastDue >= 5) code = "5";
            else if (monthsPastDue >= 4) code = "4";
            else if (monthsPastDue >= 3) code = "3";
            else if (monthsPastDue >= 2) code = "2";
            else code = "1";
        }
        paymentHistoryProfile += code;
    }

    // ── Account Status — derived from current month's profile code ──
    // 0→11, 1→71, 2→78, 3→80, 4→82, 5→83, 6→84, G→93, D→13
    const currentCode = paymentHistoryProfile[0] || "0";
    const statusMap = { "0": "11", "1": "71", "2": "78", "3": "80", "4": "82", "5": "83", "6": "84", "G": "93", "D": "13", "B": "11" };
    let acctStatus = statusMap[currentCode] || "11";
    const wasCollection = hasCollectionStart || paymentHistoryProfile.includes("G");
    if (isClosed) acctStatus = wasCollection ? "62" : "13";
    if (wasFormer && hasClosedDate) acctStatus = wasCollection ? "62" : "13";

    // portfolioType: O=Open (collection/debtor, entire balance due on demand), C=Line of Credit (active LOC)
    const portfolioType = (isDebtor || wasCollection) ? "O" : "C";

    // accountType: 48=Collection Agency/Attorney (debtor), 13=closed, 15=Line of Credit (active)
    const accountType = isClosed ? "13" : (isDebtor || wasCollection) ? "48" : "15";

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
        portfolioType,
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
