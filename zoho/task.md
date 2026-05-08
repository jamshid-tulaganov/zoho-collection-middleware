# Zoho Blueprint Update Tasks

**Target:** Apply 14 fixes to the Collection_Cases blueprint in Zoho CRM Sandbox.

**Blueprint URL:**
https://crmsandbox.zoho.com/crm/sandboxrmp/settings/blueprint/6101605000132443407?module=CustomModule2

**Module:** Collection_Cases (CustomModule2)
**Stage field used by blueprint:** `Collection_Stage` (NOT `Stage`)

---

## ⚠ Before You Start

1. **Take a screenshot** of the current blueprint state (for rollback reference)
2. **Verify** these picklist values exist on `Collection_Stage`:
   - USPS Letter ✓ (added via API)
   - Credit Bureau ✓ (added via API)
   - Cooperated, Did Not Cooperate, Failed Promise, Not Connected 1/2/3, Civil Court (existing)
3. **Verify** the `Loss_Reason` picklist field exists (added via API)

---

## Setup — Open the Blueprint Editor

1. Navigate to:
   `https://crmsandbox.zoho.com/crm/sandboxrmp/settings/blueprint/6101605000132443407?module=CustomModule2`
2. Wait for the blueprint canvas to load
3. The canvas shows existing stages connected by arrows (transitions)

---

## Task 1 — Remove the back-to-Intake loop

**What to remove:** Transition `RetryContact` from `Not Connected` → `Intake`

**Steps:**
1. Find the arrow labeled `RetryContact` going from **Not Connected** back to **Intake**
2. Click the arrow to select it
3. Click the delete (trash) icon
4. Confirm deletion

---

## Task 2 — Add USPS Letter stage to the flow

**Note:** The `USPS Letter` value already exists in the picklist. You just need to add it to the blueprint canvas.

**Steps:**
1. From the left sidebar, find or drag the **USPS Letter** stage onto the canvas
2. Position it between `Escalation` and `GG&R Collection Agency`
3. Save

---

## Task 3 — Add Credit Bureau stage to the flow

**Steps:**
1. Drag the **Credit Bureau** stage onto the canvas
2. Position it between `Agency Monitoring - Trust Altus` and `Skip Tracing`
3. Save

---

## Task 4 — Add transition `SendUSPSLetter`

**From:** `Escalation` → **To:** `USPS Letter`

**Steps:**
1. Click the **Escalation** stage
2. Click `+ Add Transition` (or similar button)
3. Name the transition: **`SendUSPSLetter`**
4. Set destination stage: **USPS Letter**
5. Required fields (optional): mark these as mandatory at this transition:
   - `Escalation_Date`
   - `Escalation_Required` (checkbox)
6. Save

---

## Task 5 — Add transition `NoResponse-SendToGGR`

**From:** `USPS Letter` → **To:** `GG&R Collection Agency`

**Steps:**
1. Click the **USPS Letter** stage
2. Add new transition: **`NoResponse-SendToGGR`**
3. Destination: **GG&R Collection Agency**
4. Save

---

## Task 6 — Add transition `ReportToCredit`

**From:** `Agency Monitoring - Trust Altus` → **To:** `Credit Bureau`

**Steps:**
1. Click **Agency Monitoring - Trust Altus**
2. Add transition: **`ReportToCredit`**
3. Destination: **Credit Bureau**
4. Save

---

## Task 7 — Add transition `NoPayment-SkipTrace`

**From:** `Credit Bureau` → **To:** `Skip Tracing`

**Steps:**
1. Click **Credit Bureau**
2. Add transition: **`NoPayment-SkipTrace`**
3. Destination: **Skip Tracing**
4. Save

---

## Task 8 — Add transition `ReinstatePaymentPlan`

**From:** `Failed Promise` → **To:** `Payment Plan` (recovery loop)

**Steps:**
1. Click **Failed Promise**
2. Add transition: **`ReinstatePaymentPlan`**
3. Destination: **Payment Plan**
4. Required fields: `Promise_to_Pay_Date`, `Weekly_Payment_Amount`
5. Save

---

## Task 9 — Add transition `PaymentReceived-GGR` (direct)

**From:** `GG&R Collection Agency` → **To:** `Debt Closed`

**Steps:**
1. Click **GG&R Collection Agency**
2. Add transition: **`PaymentReceived-GGR`**
3. Destination: **Debt Closed**
4. Required fields: `Payment_Received_Date`, `Payment_Received` (checkbox)
5. Save

---

## Task 10 — Add transition `PaymentReceived-TrustAltus` (direct)

**From:** `Trust Altus Collection Agency` → **To:** `Debt Closed`

**Steps:**
1. Click **Trust Altus Collection Agency**
2. Add transition: **`PaymentReceived-TrustAltus`**
3. Destination: **Debt Closed**
4. Required fields: `Payment_Received_Date`, `Payment_Received` (checkbox)
5. Save

---

## Task 11 — Add transition `ContactFound`

**From:** `Skip Tracing` → **To:** `Connected`

**Steps:**
1. Click **Skip Tracing**
2. Add transition: **`ContactFound`**
3. Destination: **Connected**
4. Required fields: `Verified_Phone`, `Verified_Address`, `Verified_Email` (at least one)
5. Save

---

## Task 12 — Add transition `BankruptcyFound`

**From:** `Skip Tracing` → **To:** `Case Lost`

**Steps:**
1. Click **Skip Tracing**
2. Add transition: **`BankruptcyFound`**
3. Destination: **Case Lost**
4. Required field: `Loss_Reason` = "Bankruptcy" (set this as default value too)
5. Save

---

## Task 13 — Add transition `DebtorDeceased`

**From:** `Skip Tracing` → **To:** `Case Lost`

**Steps:**
1. Click **Skip Tracing**
2. Add transition: **`DebtorDeceased`**
3. Destination: **Case Lost**
4. Required field: `Loss_Reason` = "Deceased"
5. Save

---

## Task 14 — Add transition `SettlementReached`

**From:** `Legal Action` → **To:** `Debt Closed`

**Steps:**
1. Click **Legal Action**
2. Add transition: **`SettlementReached`**
3. Destination: **Debt Closed**
4. Required fields: `Payment_Received_Date`
5. Save

---

## Task 15 — Add transition `ReopenCase`

**From:** `Case Lost` → **To:** `Intake`

**Steps:**
1. Click **Case Lost**
2. Add transition: **`ReopenCase`**
3. Destination: **Intake**
4. Required field: must enter a reason note
5. Save

---

## Task 16 — Add `ChangedMind` transition

**From:** `Did Not Cooperate` → **To:** `Cooperated`

**Steps:**
1. Click **Did Not Cooperate**
2. Add transition: **`ChangedMind`**
3. Destination: **Cooperated**
4. Save

---

## Task 17 — Add `DebtorConnected` transitions from NC1, NC2, NC3

**From:** `Not Connected 1` → `Connected`
**From:** `Not Connected 2` → `Connected`
**From:** `Not Connected 3` → `Connected`

**Steps for each:**
1. Click on the source stage (NC1, NC2, or NC3)
2. Add transition: **`DebtorConnected`**
3. Destination: **Connected**
4. Save

---

## Task 18 — Add `Escalate-NoContact` from NC3

**From:** `Not Connected 3` → **To:** `Escalation`

**Steps:**
1. Click **Not Connected 3**
2. Add transition: **`Escalate-NoContact`**
3. Destination: **Escalation**
4. Save

---

## Task 19 — Make sure each NC stage has the right outgoing transition

**Verify:**
- `Not Connected` → `NotConnected1` → `Not Connected 1`
- `Not Connected 1` → `NotConnected2` → `Not Connected 2`
- `Not Connected 2` → `NotConnected3` → `Not Connected 3`

Add any missing ones.

---

## Final Step — Publish the Blueprint

1. Click the **Save** or **Publish** button at the top right of the blueprint editor
2. Confirm the publish dialog
3. Verify the blueprint is now Active

---

## Verification Checklist

After all changes, the blueprint should have:

- [ ] **22 stages** total (including USPS Letter and Credit Bureau)
- [ ] **NO** `RetryContact` transition from Not Connected → Intake
- [ ] **NotConnected1/2/3** chain with `DebtorConnected` exit at each level
- [ ] **`ChangedMind`** from Did Not Cooperate → Cooperated
- [ ] **`ReinstatePaymentPlan`** from Failed Promise → Payment Plan
- [ ] **`SendUSPSLetter`** from Escalation → USPS Letter
- [ ] **`NoResponse-SendToGGR`** from USPS Letter → GG&R
- [ ] **`PaymentReceived-GGR`** direct from GG&R → Debt Closed
- [ ] **`PaymentReceived-TrustAltus`** direct from Trust Altus → Debt Closed
- [ ] **`ReportToCredit`** from Mon Trust Altus → Credit Bureau
- [ ] **`NoPayment-SkipTrace`** from Credit Bureau → Skip Tracing
- [ ] **`ContactFound`** from Skip Tracing → Connected
- [ ] **`BankruptcyFound`** from Skip Tracing → Case Lost (Loss_Reason=Bankruptcy)
- [ ] **`DebtorDeceased`** from Skip Tracing → Case Lost (Loss_Reason=Deceased)
- [ ] **`SettlementReached`** from Legal Action → Debt Closed
- [ ] **`ReopenCase`** from Case Lost → Intake

---

## Test the Blueprint

After publishing:

1. Go to **Collection Cases** module
2. Click **+ Create Case**
3. Fill in basic info, save
4. The case should land at **Intake** stage
5. Click the transition button — only valid transitions should appear
6. Walk through 2-3 happy paths to confirm everything works:
   - Path 1: Intake → Connected → Cooperated → Payment Plan → Debt Closed
   - Path 2: Intake → Not Connected → NC1 → NC2 → NC3 → Escalation → USPS Letter → GG&R → ... → Skip Tracing → BankruptcyFound → Case Lost
   - Path 3: Intake → Connected → Did Not Cooperate → ChangedMind → Cooperated → Payment Plan → Debt Closed

If any path is blocked or shows the wrong transitions, go back and fix that transition.

---

## Rollback

If something breaks, you can:
1. **Undo individual changes** in the blueprint editor (Ctrl+Z works in some Zoho UIs)
2. **Restore from screenshot** — recreate the original blueprint by hand
3. **Restore the deleted records** from Zoho's recycle bin (records you deleted earlier are recoverable for ~60 days)

---

## Need Help?

If you get stuck on a particular task, share a screenshot with me and I'll help identify the next step.
