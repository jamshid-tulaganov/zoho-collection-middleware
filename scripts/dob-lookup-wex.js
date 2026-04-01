#!/usr/bin/env node
/**
 * WEX DOB Lookup — Middleware Automation Script
 * ─────────────────────────────────────────────
 * Looks up Date of Birth for a carrier from WEX (Salesforce Experience Cloud).
 *
 * HOW IT WORKS:
 *   1. Logs into WEX Community portal via Playwright (headless Chrome)
 *   2. Extracts the Salesforce Aura CSRF token from the page
 *   3. Uses Aura REST API chain to find DOB:
 *      a. searchResultsKeyword  → find OnlineApplication by company name
 *      b. getRecordWithFields   → get BOE (Beneficial Owner Entity) ID
 *      c. getRelatedListRecords → get DOB from Beneficial Owner Prong
 *
 * USAGE (CLI):
 *   node scripts/dob-lookup-wex.js --carrierId 5753849 --company "KIWI EXPRESS INC" --firstName Dmitrijs --lastName Borisikovs
 *   node scripts/dob-lookup-wex.js --carrierId 5753849 --company "KIWI EXPRESS INC"
 *
 * USAGE (Module — import into middleware):
 *   import { lookupDOBFromWEX, WEXSession } from './scripts/dob-lookup-wex.js';
 *
 *   // Single lookup
 *   const result = await lookupDOBFromWEX({
 *     carrierId: '5753849',
 *     companyName: 'KIWI EXPRESS INC',
 *     firstName: 'Dmitrijs',
 *     lastName: 'Borisikovs'
 *   });
 *   // result → { dob: '06/21/1978', firstName: 'Dmitrijs', lastName: 'Borisikovs', source: 'wex' }
 *
 *   // Batch with persistent session (efficient for many lookups)
 *   const session = new WEXSession();
 *   await session.init();
 *   for (const carrier of carriers) {
 *     const result = await session.lookup(carrier);
 *   }
 *   await session.close();
 *
 * ENVIRONMENT VARIABLES:
 *   WEX_EMAIL     — WEX portal login email (default: customerservice@tsst.ai.wex)
 *   WEX_PASSWORD  — WEX portal password   (default: @dminteamtss24)
 *   WEX_HEADLESS  — "false" to show browser (default: true)
 */

import { chromium } from "playwright";
import { env } from "../src/config/env.js";

// ── Constants ────────────────────────────────────────────────────────────────

const WEX_URL     = "https://wexinc.my.site.com/communities/s";
const WEX_EMAIL   = process.env.WEX_EMAIL    || "customerservice@tsst.ai.wex";
const WEX_PASSWORD= process.env.WEX_PASSWORD || "@dminteamtss24";
const WEX_HEADLESS= process.env.WEX_HEADLESS !== "false";

// Aura framework values (stable across sessions)
const AURA_FWUID  = "VEhtaDlVRkdCeTJiZFhuOTVYYjRJQTJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4tMjE0NzQ4MzY0OC4xMzEwNzIwMA";
const AURA_APP    = "siteforce:communityApp";
const AURA_LOADED = { "APPLICATION@markup://siteforce:communityApp": "1533_ez-GoXD6UAAJ6rtTbHErdw" };

// ── WEXSession class ─────────────────────────────────────────────────────────

export class WEXSession {
  constructor() {
    this.browser = null;
    this.page    = null;
    this.token   = null;
    this._reqNum = 1;
  }

  /** Launch browser and authenticate with WEX */
  async init() {
    this.browser = await chromium.launch({
      headless: WEX_HEADLESS,
      args: ["--disable-gpu", "--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await this.browser.newContext();
    this.page = await context.newPage();

    // Navigate to WEX and let it load Aura
    await this.page.goto(
      `${WEX_URL}/onlineapplication/OnlineApplication__c/Default`,
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    // Extract Aura token
    this.token = await this.page.evaluate(() => {
      return window.$A && window.$A.Hi && window.$A.Hi.client
        ? window.$A.Hi.client.Ac
        : null;
    });

    if (!this.token) {
      // May need to log in first — check if login page appeared
      const url = this.page.url();
      if (url.includes("login") || url.includes("?ec=")) {
        await this._login();
        this.token = await this.page.evaluate(() => {
          return window.$A && window.$A.Hi && window.$A.Hi.client
            ? window.$A.Hi.client.Ac
            : null;
        });
      }
    }

    if (!this.token) {
      throw new Error("Failed to obtain Aura token from WEX — check credentials");
    }

    console.log("[WEX] Session initialized, token obtained");
  }

  async _login() {
    console.log("[WEX] Logging in...");
    // Salesforce Experience Cloud login
    await this.page.fill('input[type="email"], input[name="username"]', WEX_EMAIL);
    await this.page.fill('input[type="password"], input[name="password"]', WEX_PASSWORD);
    await this.page.click('button[type="submit"], input[type="submit"]');
    // Salesforce never fully stops background requests — wait for URL change + DOM load instead
    await this.page.waitForURL("**/communities/s/**", { timeout: 60000 });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    // Give Aura framework time to initialize
    await this.page.waitForTimeout(3000);
  }

  /** Make an Aura API POST call */
  async _auraPost(actionKey, descriptor, params) {
    const reqNum = this._reqNum++;
    const message = JSON.stringify({
      actions: [{
        id: "1;a",
        descriptor,
        callingDescriptor: "UNKNOWN",
        params,
      }],
    });
    const context = JSON.stringify({
      mode: "PROD",
      fwuid: AURA_FWUID,
      app: AURA_APP,
      loaded: AURA_LOADED,
      dn: [],
      globals: {},
      uad: true,
    });

    // Execute fetch inside the browser page (same origin as WEX)
    const result = await this.page.evaluate(
      async ({ url, message, context, token }) => {
        const body = `message=${encodeURIComponent(message)}&aura.context=${encodeURIComponent(context)}&aura.pageURI=%2Fcommunities%2Fs%2Fonlineapplication%2FOnlineApplication__c%2FDefault&aura.token=${encodeURIComponent(token)}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body,
        });
        return r.json();
      },
      {
        url: `/communities/s/sfsites/aura?r=${reqNum}&${actionKey}=1`,
        message,
        context,
        token: this.token,
      }
    );

    const action = result.actions && result.actions[0];
    if (!action) throw new Error("No action in Aura response");
    if (action.state !== "SUCCESS") {
      throw new Error(`Aura ${actionKey} failed [${action.state}]: ${JSON.stringify(action.error || "").substring(0, 200)}`);
    }
    return action.returnValue;
  }

  /**
   * Step 1: Search for OnlineApplication records by company name.
   * Uses global SOSL search — searches ALL records (not just recently viewed).
   */
  async searchApplication(companyName) {
    const rv = await this._auraPost(
      "SearchUiController.searchResultsKeyword",
      "aura://SearchUiController/ACTION$searchResultsKeyword",
      { q: companyName, objectApiName: "OnlineApplication__c", language: "en_US", options: {} }
    );
    const records = (rv.keywordSearchResult && rv.keywordSearchResult.records) || [];
    return records.map(r => ({
      id: r.record.id,
      legalName: r.record.fields.Legal_Business_Name__c && r.record.fields.Legal_Business_Name__c.value,
    }));
  }

  /**
   * Step 2: Get carrier ID + BOE (Beneficial Owner Entity) ID from an application record.
   */
  async getApplicationRecord(appId) {
    const rv = await this._auraPost(
      "RecordUiController.getRecordWithFields",
      "aura://RecordUiController/ACTION$getRecordWithFields",
      {
        recordId: appId,
        fields: [
          "OnlineApplication__c.Carrier_ID_Number__c",
          "OnlineApplication__c.Beneficial_Owner_Information__c",
        ],
      }
    );
    const f = rv.fields;
    return {
      carrierId: f.Carrier_ID_Number__c && f.Carrier_ID_Number__c.value,
      boeId:     f.Beneficial_Owner_Information__c && f.Beneficial_Owner_Information__c.value,
    };
  }

  /**
   * Step 3: Get Beneficial Owner Prong DOBs from a BOE record.
   */
  async getBeneficialOwnerDOBs(boeId) {
    const rv = await this._auraPost(
      "RelatedListUiController.getRelatedListRecords",
      "aura://RelatedListUiController/ACTION$getRelatedListRecords",
      {
        parentRecordId: boeId,
        relatedListId:  "Beneficial_Owners__r",
        fields: [
          "Beneficial_Owner_Prong__c.Id",
          "Beneficial_Owner_Prong__c.First_Name__c",
          "Beneficial_Owner_Prong__c.Last_Name__c",
          "Beneficial_Owner_Prong__c.Date_Of_Birth__c",
        ],
      }
    );
    return (rv.records || []).map(r => ({
      id:        r.id,
      firstName: r.fields.First_Name__c  && r.fields.First_Name__c.value,
      lastName:  r.fields.Last_Name__c   && r.fields.Last_Name__c.value,
      dob:       r.fields.Date_Of_Birth__c && r.fields.Date_Of_Birth__c.value, // "YYYY-MM-DD"
    }));
  }

  /**
   * Full DOB lookup chain for one carrier.
   *
   * @param {object} candidate
   * @param {string} candidate.carrierId   — carrier ID number
   * @param {string} candidate.companyName — legal business name to search
   * @param {string} [candidate.firstName] — owner first name (for best-match DOB selection)
   * @param {string} [candidate.lastName]  — owner last name
   *
   * @returns {object} result
   *   { status, carrierId, companyName, dob?, firstName?, lastName?, matchedCarrierId? }
   *   status values: 'found' | 'notFound' | 'noMatch' | 'noBOP' | 'noDOB' | 'error'
   *   dob format: 'MM/DD/YYYY'
   */
  async lookup({ carrierId, companyName, firstName = "", lastName = "" }) {
    if (!companyName || !companyName.trim()) {
      return { status: "error", carrierId, companyName, error: "companyName is required for WEX search" };
    }

    try {
      // Step 1: Find matching application(s)
      const apps = await this.searchApplication(companyName);
      if (!apps.length) {
        return { status: "notFound", carrierId, companyName };
      }

      // Step 2: Find app that matches our carrier ID (check up to 5 results)
      let matched = null;
      for (const app of apps.slice(0, 5)) {
        const rec = await this.getApplicationRecord(app.id).catch(() => null);
        if (!rec) continue;
        if (rec.carrierId === String(carrierId)) {
          matched = { ...rec, legalName: app.legalName };
          break;
        }
        // If only 1 search result, use it even if carrierId differs
        if (!matched && apps.length === 1) {
          matched = { ...rec, legalName: app.legalName };
        }
      }

      if (!matched || !matched.boeId) {
        return { status: "noMatch", carrierId, companyName, searchResults: apps.length };
      }

      // Step 3: Get DOBs from Beneficial Owner Prongs
      const owners = await this.getBeneficialOwnerDOBs(matched.boeId);
      if (!owners.length) {
        return { status: "noBOP", carrierId, companyName };
      }

      const ownersWithDOB = owners.filter(o => o.dob);
      if (!ownersWithDOB.length) {
        return { status: "noDOB", carrierId, companyName };
      }

      // Pick best DOB — prefer name match, else take first
      let best = ownersWithDOB[0];
      if (firstName || lastName) {
        const target = `${firstName} ${lastName}`.toLowerCase();
        for (const o of ownersWithDOB) {
          const name = `${o.firstName || ""} ${o.lastName || ""}`.toLowerCase();
          if (name.includes(firstName.toLowerCase()) || name.includes(lastName.toLowerCase())) {
            best = o;
            break;
          }
        }
      }

      // Convert YYYY-MM-DD → MM/DD/YYYY
      const dob = this._formatDOB(best.dob);

      return {
        status:           "found",
        carrierId,
        companyName,
        dob,                              // "MM/DD/YYYY"
        dobISO:           best.dob,       // "YYYY-MM-DD"
        firstName:        best.firstName,
        lastName:         best.lastName,
        matchedCarrierId: matched.carrierId,
        source:           "wex",
      };
    } catch (err) {
      return { status: "error", carrierId, companyName, error: err.message };
    }
  }

  _formatDOB(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page    = null;
      this.token   = null;
    }
  }
}

// ── Convenience wrapper for single-shot lookups ──────────────────────────────

/**
 * Look up a single carrier's DOB from WEX.
 * Opens and closes its own browser session.
 *
 * For batch/daily runs, prefer WEXSession directly (reuses the same session).
 */
export async function lookupDOBFromWEX(candidate) {
  const session = new WEXSession();
  try {
    await session.init();
    return await session.lookup(candidate);
  } finally {
    await session.close();
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("dob-lookup-wex.js")) {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

  const carrierId   = get("--carrierId");
  const companyName = get("--company");
  const firstName   = get("--firstName") || "";
  const lastName    = get("--lastName")  || "";

  if (!carrierId || !companyName) {
    console.error("Usage: node dob-lookup-wex.js --carrierId <id> --company <name> [--firstName <fn>] [--lastName <ln>]");
    process.exit(1);
  }

  console.log(`[WEX] Looking up DOB for carrier ${carrierId}: "${companyName}" (${firstName} ${lastName})`);

  lookupDOBFromWEX({ carrierId, companyName, firstName, lastName })
    .then(result => {
      console.log("\n[WEX] Result:", JSON.stringify(result, null, 2));
      if (result.status === "found") {
        console.log(`\n✓ DOB found: ${result.dob}`);
      } else {
        console.log(`\n✗ Not found: ${result.status}`);
        process.exit(2);
      }
    })
    .catch(err => {
      console.error("[WEX] Fatal error:", err.message);
      process.exit(1);
    });
}
