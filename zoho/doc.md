# How the Collection Cases Blueprint Works

## 1. What is a Zoho Blueprint?

A Blueprint is a **state machine** that controls how a record moves through a process. Instead of letting users freely change fields, the Blueprint **forces records to follow a defined path** with specific rules at each step.

Think of it like a board game:
- **Stages** = squares on the board (Intake, Connected, Payment Plan, etc.)
- **Transitions** = legal moves between squares (e.g., "DebtorCooperated" is the only way to go from `Connected` → `Cooperated`)
- **Rules** = what you must fill in before making a move (e.g., "before you can move to Payment Plan, you must enter the Weekly Payment Amount")

The current stage is stored in the **`Collection_Stage`** field.

---

## 2. The Big Picture — 8 Phases

The blueprint moves a debtor case through 8 phases. Each phase has 1+ stages and 1+ transitions out of it.

```
1. CONTACT      Intake → Connected | Not Connected
2. COOPERATION  Connected → Cooperated | Did Not Cooperate
3. PAYMENT      Cooperated → Payment Plan → Debt Closed (or Failed Promise)
4. ESCALATION   Failed/Refused → Escalation → USPS Letter
5. AGENCIES     USPS Letter → GG&R → Trust Altus
6. ENFORCEMENT  Trust Altus → Credit Bureau → Skip Tracing
7. LEGAL        Skip Tracing → Legal Action → Small Claims | Civil Court
8. OUTCOME      Court → Debt Closed ✓ | Case Lost ✗
```

---

## 3. Phase-by-Phase Walkthrough

### Phase 1: Contact (Goal — reach the debtor)

| Stage | What happens | How to leave |
|---|---|---|
| **Intake** | New case created. Record the debtor info. **First contact attempt happens here.** | Try to call → if reached, hit `DebtorConnected`; if not, hit `DebtorNotReached` |
| **Not Connected** | First contact attempt failed. | Hit `NotConnected1` to record a second attempt. If reached: `DebtorConnected` → Connected. |
| **Not Connected 1** | Second attempt failed. | `NotConnected2` for third attempt, or `DebtorConnected` → Connected if reached. |
| **Not Connected 2** | Third attempt failed. | `NotConnected3` for fourth attempt, or `DebtorConnected` → Connected if reached. |
| **Not Connected 3** | Fourth (final) attempt failed. End of contact phase. | `Escalate-NoContact` → Escalation, or `DebtorConnected` → Connected if reached. |

> **No "back to Intake" loop.** Each NC stage *is* a retry attempt. The chain `Not Connected → NC1 → NC2 → NC3` linearly records how many tries you made. From any NC stage, if you eventually reach the debtor, jump straight to `Connected`.

### Phase 2: Cooperation (Goal — agreement to pay)

| Stage | What happens | How to leave |
|---|---|---|
| **Connected** | You're talking to the debtor. | `DebtorCooperated` → Cooperated, or `DebtorRefused` → Did Not Cooperate |
| **Cooperated** | They agreed to work with you. | `SetUpPaymentPlan` → Payment Plan |
| **Did Not Cooperate** | They refused. | `Escalate-NoCooperation` → Escalation, or **`ChangedMind`** → Cooperated (NEW — debtor calls back later wanting to pay) |

### Phase 3: Payment (Goal — collect the money)

| Stage | What happens | How to leave |
|---|---|---|
| **Payment Plan** | Active payment arrangement. Track `Weekly_Payment_Amount`, `Next_Payment_Due_Date`. | `PaymentCompleted` ✓ → Debt Closed, or `MissedPayment` → Failed Promise |
| **Failed Promise** | They missed a payment. | `ReinstatePaymentPlan` (NEW) → back to Payment Plan, or `EscalateToAgency` → Escalation |

### Phase 4: Escalation (Goal — formal warning)

| Stage | What happens | How to leave |
|---|---|---|
| **Escalation** | Internal collection efforts have failed. | `SendUSPSLetter` (NEW) → USPS Letter |
| **USPS Letter** (NEW) | Official written demand mailed. Wait for response. | `NoResponse-SendToGGR` → GG&R Collection Agency |

### Phase 5: Agencies (Goal — third-party collection)

| Stage | What happens | How to leave |
|---|---|---|
| **GG&R Collection Agency** | Case placed with first agency. | `MonitorGGR` → Agency Monitoring GG&R, or `PaymentReceived-GGR` (NEW) ✓ → Debt Closed |
| **Agency Monitoring GG&R** | GG&R is working it. Update `Agency_Response_Status`. | `PaymentReceived-GGR` ✓ → Debt Closed, or `NoPayment-NextAgency` → Trust Altus |
| **Trust Altus Collection Agency** | Second agency takes over. | `MonitorTrustAltus`, or `PaymentReceived-TrustAltus` (NEW) ✓ → Debt Closed |
| **Agency Monitoring Trust Altus** | Trust Altus is working it. | `PaymentReceived-TrustAltus` ✓ → Debt Closed, or `ReportToCredit` → Credit Bureau |

### Phase 6: Enforcement (Goal — pressure via credit + locate debtor)

| Stage | What happens | How to leave |
|---|---|---|
| **Credit Bureau** (NEW) | Reported delinquency to Array Metro 2. | `NoPayment-SkipTrace` → Skip Tracing |
| **Skip Tracing** | Locate debtor's new address/phone. Update `Verified_Address`, `Verified_Phone`. | `ContactFound` (NEW) → Connected · `BankruptcyFound` (NEW) → Case Lost · `DebtorDeceased` (NEW) → Case Lost · `ProceedToLegal` → Legal Action |

> **About BankruptcyFound and DebtorDeceased:** These are real outcomes you can discover during skip tracing. If the debtor filed for bankruptcy, federal law (automatic stay) **prohibits all collection efforts** — you must stop immediately. If the debtor died, the debt typically goes to their estate (often uncollectable for small carriers). Both transitions go directly to `Case Lost` with the appropriate `Loss_Reason` set.

### Phase 7: Legal (Goal — court enforcement)

| Stage | What happens | How to leave |
|---|---|---|
| **Legal Action** | Filing legal claim. Set `Legal_Filing_Date`, attach documents. | `SettlementReached` (NEW) ✓ → Debt Closed, `Under10K` → Small Claims, `Over10K` → Civil Court |
| **Small Claims Court** | For debts < $10K. | `CourtSuccess-SmallClaims` ✓ → Debt Closed, or `CourtFailed-SmallClaims` → Case Lost |
| **Civil Court** | For debts ≥ $10K. | `CourtSuccess-Civil` ✓ → Debt Closed, or `CourtFailed-Civil` → Case Lost |

### Phase 8: Outcome

| Stage | Meaning |
|---|---|
| **Debt Closed** ✓ | Money collected. Case successful. Terminal. |
| **Case Lost** ✗ | All options exhausted. Can be reopened via `ReopenCase` → Intake. |

---

## 4. How a User Actually Uses It (Day-to-Day)

When a Collection Case is open in Zoho CRM, the user sees:

1. **The current stage** displayed at the top (e.g., "Payment Plan")
2. **Transition buttons** for the only allowed next moves (e.g., `[ Payment Completed ]` `[ Missed Payment ]`)
3. **Required fields** that must be filled before clicking the button (e.g., before `PaymentCompleted`, the user must fill `Payment_Received_Date`)
4. **Read-only fields** locked at this stage to prevent tampering

The user **cannot freely change `Collection_Stage`** — they must click a transition button. This guarantees:
- Every case follows the documented process
- Required data is captured at each step
- Audit trail of who moved the case and when

---

## 5. How It's Triggered Automatically

The blueprint is also driven by the daily Deluge scripts in `scripts/`:

| Script | What it does |
|---|---|
| `sync-collections.dg` | Creates new Collection Cases at `Intake` when a debtor crosses the 15-day threshold. Sets `Case_Source = "Zoho Sync"`. |
| `sync-debtors.dg` | Updates debtor info that the case references. |
| Auto-transitions (recommended) | When `Days_Past_Due > 30` and no payment, auto-fire `EscalateToAgency`. When `Promise_to_Pay_Date` passes without payment, auto-fire `MissedPayment`. |

---

## 6. The Two Field Confusion (Important)

**Use `Collection_Stage`, not `Stage`.**

- `Stage` is the legacy field — it's missing failure branches and shouldn't be used.
- `Collection_Stage` is what the blueprint reads/writes.
- Live records still have `Stage` populated from before — those records are now deleted, so it's a clean slate.
- All Deluge code should reference `Collection_Stage`.

---

## 7. New Tracking Fields

These fields were added to the `Collection_Cases` module via API to support the blueprint:

| Field | Type | What it tracks |
|---|---|---|
| `Total_Contact_Attempts` | integer | Counter — incremented on every NotConnected1/2/3 transition. Tells you how many times you tried to reach the debtor. |
| `Total_Amount_Paid` | currency | Running total of all payments received on this case (separate from invoice amounts). |
| `Total_Cost_Incurred` | currency | All costs spent pursuing this case — agency fees, mailing, legal fees. Used for ROI analysis. |
| `Reopen_Count` | integer | How many times this case has been reopened from `Case Lost`. |
| `Last_Activity_Date` | datetime | When the most recent transition happened. Used for SLA monitoring. |
| `Last_Stage_Change_Date` | date | When the case entered its current stage. |
| `Days_In_Current_Stage` | integer | How long the case has been at the current stage. Updated by automation. |
| `Loss_Reason` | picklist | Required when transitioning to `Case Lost`. Values: Bankruptcy, Deceased, Statute of Limitations Expired, Cannot Locate, Court Loss (Small Claims), Court Loss (Civil), Settled (Lost Outright), Wrong Debtor |

### How they get populated

| Field | When updated | How |
|---|---|---|
| `Total_Contact_Attempts` | On NotConnected1/2/3 transitions | Workflow rule: increment by 1 |
| `Total_Amount_Paid` | When `Payment_Received = true` | Workflow rule: add `Weekly_Payment_Amount` |
| `Total_Cost_Incurred` | Manual entry by collections team | At Agency Transfer, Legal Filing, etc. |
| `Reopen_Count` | On `ReopenCase` transition | Workflow rule: increment by 1 |
| `Last_Activity_Date` | On every blueprint transition | Workflow rule: set to `now` |
| `Last_Stage_Change_Date` | On every blueprint transition | Workflow rule: set to `today` |
| `Days_In_Current_Stage` | Daily cron | `today - Last_Stage_Change_Date` |
| `Loss_Reason` | Required field on transitions to `Case Lost` | User picks from picklist |

---

## 8. Where to See the Visual Diagram

Open these files in your browser to explore the blueprint:

| File | Use |
|---|---|
| `zoho/blueprint-fixed.html` | **Interactive simulator** — pick a scenario and watch a case journey through the stages |
| `zoho/blueprint-presentation.html` | **Presentation slide** — clean swim-lane diagram for showing to others |
| `zoho/blueprint-fixed.md` | Mermaid text diagram + change list |

---

## TL;DR

> A debtor enters at **Intake**. The user works the case through stages by clicking transition buttons. Each stage represents a real-world status (called, refused, paying, in court, etc.). The case ends at **Debt Closed** (we got paid) or **Case Lost** (we didn't). Every move is logged, every required field is enforced, and the daily Deluge scripts keep it in sync with the rest of the Octane data sources.
