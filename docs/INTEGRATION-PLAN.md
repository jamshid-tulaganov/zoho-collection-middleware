# Comprehensive Integration & Automation Plan
## Collections Middleware — WEX, iSoftPull, CMP, Zoho, Merchant

**Date**: March 26, 2026
**Author**: Claude (Opus)
**Status**: Planning — implementation with Sonnet

---

## Executive Summary

This plan solves a production-critical issue (Playwright crashes on Render), fixes an architectural regression (metro2.js address resolution), redesigns WEX integration, and builds an automated DOB pipeline connecting 5 apps. 7 phases, ~3-4 weeks.

---

## PHASE 1: Fix Production Playwright Crash (P0 — CRITICAL)

**Problem**: Render kills Playwright browser processes. Error: `browserType.launch: Target page, context or browser has been closed`

**Root Cause**: Render's container limits (memory/CPU) kill Chromium. Both WEX and iSoftPull need Playwright but can't run it on Render.

### Solution: Local Daemon Architecture

```
+-------------------------------------------------------+
| Render (collections server) — PORT 3001                |
|  /isoftpull/* -> proxy to daemon:9002/isoftpull        |
|  /wex/*       -> proxy to daemon:9002/wex              |
|  NO Playwright — only HTTP/REST clients                |
+-------------------------------------------------------+
                        | HTTPS
+-------------------------------------------------------+
| Local Daemon (team machine) — PORT 9002                |
|  Single persistent Chromium instance                   |
|  /api/isoftpull/search -> browser.newPage() + scrape   |
|  /api/wex/lookup -> browser.newPage() + Aura capture   |
|  Health check + auto-restart on crash                  |
+-------------------------------------------------------+
```

### Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `daemon/index.js` | CREATE | Local Playwright daemon (~300 lines) |
| `daemon/package.json` | CREATE | Daemon dependencies |
| `daemon/.env.example` | CREATE | Daemon config template |
| `src/clients/daemonClient.js` | CREATE | HTTP client with circuit breaker (~150 lines) |
| `src/services/wex.js` | MODIFY | Replace chromium.launch() with daemon calls |
| `src/services/isoftpull.js` | MODIFY | Replace chromium.launch() with daemon calls |
| `.env` | MODIFY | Add DAEMON_URL, DAEMON_ENABLED |

### Daemon Design

- Single `chromium` instance (lazy-launched on first request)
- Page pool: max 5 concurrent pages
- Queue per request type (WEX vs iSoftPull)
- Health endpoint: `GET /health` returns `{ isConnected, pageCount, memMB, uptime }`
- Graceful shutdown: flush page queue before close
- Auto-restart browser on crash

### Client Library Design

- Exponential backoff + circuit breaker if daemon unreachable
- Fallback: return `{ status: "daemon_unavailable" }` instead of crash
- Request timeout: 35s (5s buffer over daemon 30s)
- Auto-retry on 503

### Trade-offs

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Local Daemon | Reliable, resource-controlled | Requires always-on machine | **SELECTED** |
| BrowserBase Cloud | Fully managed | $$$ per request, vendor lock-in | Fallback |
| Dedicated VM | Full control | OPS overhead, cost | Alternative |
| Render Paid Plan | Simpler | Doesn't guarantee Playwright stability | Not viable |

**Complexity**: M | **Dependencies**: None | **Duration**: 3-4 days

---

## PHASE 2: Fix WEX Service (P1)

**Problem**: Current `wex.js` uses hard-coded Aura API descriptors that are likely wrong. The descriptors (`aura://SearchUiController/ACTION$searchResultsKeyword`, etc.) were guessed, not captured from actual network traffic.

### Solution: Network Interception Approach

Instead of guessing Aura descriptors, navigate URLs and intercept the portal's own Aura API responses.

### Flow

1. Navigate to `wexinc.my.site.com/communities/s/global-search/{companyName}`
2. Intercept all responses to `/sfsites/aura` endpoint
3. Parse captured Aura actions — extract search results
4. Navigate to application detail URL `/communities/s/detail/{appId}`
5. Intercept record data from Aura responses
6. Navigate to BOE detail → BOP records → extract DOB
7. Fall back to DOM extraction if interception fails

### URL Patterns (from wex-data-map.json)

```
Search:       /communities/s/global-search/{query}
App detail:   /communities/s/onlineapplication/{id}/{name}
Record detail: /communities/s/detail/{id}
Related list:  /communities/s/relatedlist/{parent_id}/{relationship}
```

### Improved Matching

Since WEX has NO carrierId field, matching must use:
- Company name fuzzy match (Levenshtein, 85% threshold)
- Address match (street + city + state)
- Owner name match (first + last name)
- Confidence scoring: name + 2+ address fields = high confidence

### Error Statuses

| Status | Meaning | Next Action |
|--------|---------|-------------|
| `found` | DOB found + company matched | Use DOB |
| `notFound` | No search results | Try iSoftPull |
| `searchFailed` | Network error | Retry later |
| `noMatch` | Results but no carrier match | Manual review |
| `noBOE` | App found, no BOE link | Try iSoftPull |
| `noBOP` | BOE exists, no BOP records | Escalate |
| `noDOB` | Owners exist, no DOB | Try iSoftPull |
| `tokenExpired` | Aura token invalid | Auto-refresh |
| `loginFailed` | Credentials rejected | Telegram alert |

### Files

| File | Action | Purpose |
|------|--------|---------|
| `daemon/wex-automation.js` | CREATE | Rewritten WEX with network interception (~400 lines) |
| `daemon/index.js` | MODIFY | Add WEX routes + session management |
| `src/services/wex.js` | MODIFY | Proxy to daemon (strip browser logic) |

**Complexity**: M | **Dependencies**: Phase 1 | **Duration**: 2-3 days

---

## PHASE 3: Fix metro2.js Address Resolution (P1)

**Problem**: Linter auto-changed address resolution logic, removing SMP address as primary.

### Bug Location

`src/services/metro2.js` line 125:
```javascript
// CURRENT (BUG — introduced by linter):
let a1 = dealAddr;

// CORRECT (original intent):
let a1 = smpAddr1 || dealAddr;
```

Also line 126:
```javascript
// CURRENT (BUG):
let a2 = null;

// CORRECT:
let a2 = smpAddr2 || null;
```

### Impact

- Affects ALL carrier records in Metro 2 reports
- SMP addresses are more recent/accurate than Zoho Deal addresses
- Requires full carrier-db re-sync after fix

### Files

| File | Action | Purpose |
|------|--------|---------|
| `src/services/metro2.js` | MODIFY | Fix lines 125-126 |

**Complexity**: S | **Dependencies**: None | **Duration**: 30 minutes

---

## PHASE 4: DOB Sync Pipeline Orchestrator (P2)

**Problem**: Three DOB sources exist (WEX, Zoho, iSoftPull) but no master orchestrator. DOB logic is scattered across syncCarrierDb.js.

### Solution: Master DOB Orchestrator

**File**: `src/services/dobOrchestrator.js` (~250 lines)

### Source Priority Chain

1. Zoho Deal `dob_raw` field (already in carrier-db sync)
2. debtor-master-db.json + dob.json
3. Existing cached value in carrier-db
4. **WEX** (via daemon) — PRIMARY new lookup
5. **iSoftPull** (via daemon) — FALLBACK lookup

### Features

- `lookupDobSequential(carrierId, companyName, firstName, lastName)` — tries sources in order
- `batchLookupMissing(db, dobMap, { limit, force, sources })` — batch processing
- Checkpoint-based recovery: save progress to `data/dob-sync-checkpoint.json`
- Rate limiting: WEX 1req/2s, iSoftPull 1req/1.5s
- Skip daemon-dependent sources if daemon unavailable
- Track source attribution (which source found each DOB)

### Checkpoint Format

```json
{
  "startedAt": "2026-03-26T12:00:00Z",
  "lastProcessedCid": "14187",
  "processed": 150,
  "toProcess": 800,
  "found": { "wex": 45, "zoho": 55, "isoftpull": 12 },
  "errors": { "wex": 2, "daemon": 1 }
}
```

### Files

| File | Action | Purpose |
|------|--------|---------|
| `src/services/dobOrchestrator.js` | CREATE | Master DOB orchestrator |
| `src/services/syncCarrierDb.js` | MODIFY | Integrate orchestrator |

**Complexity**: M | **Dependencies**: Phase 1 | **Duration**: 2 days

---

## PHASE 5: Automated DOB Sync Scheduler (P2)

Add cron job in `src/cron/scheduler.js`:

- **Schedule**: 9 AM ET (2 hours after carrier-db sync at 7 AM ET)
- **Action**: Run `dobOrchestrator.batchLookupMissing()` with limit 200
- **Report**: Send summary to Telegram (found count by source, errors)
- **Guard**: Skip if daemon unavailable; log warning

### Files

| File | Action | Purpose |
|------|--------|---------|
| `src/cron/scheduler.js` | MODIFY | Add DOB sync cron |

**Complexity**: S | **Dependencies**: Phase 4 | **Duration**: 1 day

---

## PHASE 6: Merchant Integration (P3 — Discovery Required)

### Questions to Answer First

1. What is Merchant? (fuel card processor? vendor? system?)
2. API available? (REST, SOAP, file export, manual spreadsheet)
3. What data? (company info, DOB, credit, invoices)
4. Auth method? (API key, OAuth, VPN, credentials)
5. Data quality? (completeness, freshness, accuracy)

### Proposed Structure (after discovery)

| File | Action | Purpose |
|------|--------|---------|
| `src/services/merchant.js` | CREATE | Merchant integration |
| `src/services/dobOrchestrator.js` | MODIFY | Add Merchant to source chain |

**Complexity**: TBD | **Dependencies**: Phase 4, discovery | **Duration**: TBD

---

## PHASE 7: Monitoring & Alerting (P2)

### Enhancements

- Daemon health alerts (Telegram if unreachable >1 hour)
- DOB sync failure notifications with error categories
- Carrier-db coverage warnings (>100 missing DOBs after sync)
- Metro 2 report generation failure alerts

### Files

| File | Action | Purpose |
|------|--------|---------|
| `src/services/alerts.js` | CREATE | Unified alert dispatch (~100 lines) |
| `src/routes/telegram.js` | MODIFY | Integrate alerts |
| `src/cron/scheduler.js` | MODIFY | Wrap jobs with error alerting |

**Complexity**: S | **Dependencies**: None | **Duration**: 1 day

---

## Implementation Sequence

### Critical Path

```
Week 1:
  Phase 3 [####]                    (metro2 fix — quick, unblocked)
  Phase 1 [########........]        (daemon setup)

Week 2:
  Phase 1 [........########]        (daemon testing)
  Phase 2 [############]            (WEX rewrite)
  Phase 4 [####........]            (DOB orchestrator start)

Week 3:
  Phase 2 [........####]            (WEX testing)
  Phase 4 [........########]        (DOB orchestrator complete)
  Phase 5 [####]                    (cron scheduler)

Week 4:
  Phase 6 [########........]        (Merchant discovery)
  Phase 7 [########]                (alerts)
  QA + Deploy [........########]    (Render + daemon)
```

### Parallel Work

- Phase 3 (metro2 fix) — start immediately, no dependencies
- Phase 7 (alerts) — can start anytime
- Phase 6 (Merchant) — can start after Phase 4

---

## Risk Assessment

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Daemon machine offline | WEX/iSoftPull unavailable | M | Health check, Telegram alert, restart docs |
| Render-Daemon latency | Request timeouts | L-M | 35s timeout, exponential backoff |
| Aura version change | WEX interception fails | L | DOM fallback, auto-alert on empty results |
| iSoftPull geo-block | No DOB fallback | M | VPN on daemon machine, Telegram alert |
| carrier-db/dob.json desync | Inconsistent DOB state | L-M | Atomic writes, weekly audit |

---

## Scope Summary

- **7 phases**, 3-4 weeks active development
- **~2000 lines** new code (daemon, orchestrator, automation, clients)
- **3 major rewrites** (wex.js, metro2.js line fix, isoftpull.js)
- **No breaking API changes** (all interfaces preserved)
- **Clear dependency chain** (Phase 1 -> 2 -> 4 -> 5)
- Production-ready with checkpoint resilience, health checks, fallbacks
