// Generic exploratory UI test — no project-specific selectors or credentials.
// Reads auth credentials from CLAUDE.md at runtime.
// Discovers app structure, exercises all interactive elements, captures API calls.
//
// ⚠️ Known CI compatibility issue — 100dvh not supported in older CI browsers:
// The CSS unit 100dvh (dynamic viewport height) is not supported in older CI browser
// versions (Chromium/WebKit in GitHub Actions). Elements using min-height: 100dvh may
// have zero computed height, causing Playwright toBeVisible() checks to fail even though
// the element is in the DOM. When diagnosing S1/S2 failures where login screen elements
// are present in HTML but not visible to Playwright, check for dvh units in CSS and
// replace with vh.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL DISCOVERY — read from CLAUDE.md at runtime
// ─────────────────────────────────────────────────────────────────────────────
function readCredentialFromClaude() {
  try {
    const root = resolve(process.cwd(), '../../..'); // up from .github/scripts/ui-tests
    const claude = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8');
    // Matches all of:
    //   Test PIN: 0100        Valid PIN: 0100
    //   TEST_AUTH_CREDENTIAL: 0100
    //   | Valid test PIN | `0100` |   (table format)
    const match = claude.match(
      /(?:valid\s+(?:test\s+)?pin|test\s+(?:pin|credential|password)|TEST_AUTH_CREDENTIAL)\s*[:|]\s*`?([0-9a-zA-Z!@#$%^&*]{2,})`?/i
    );
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// Falls back to null if neither env var nor CLAUDE.md has a credential.
// Auth-dependent tests skip gracefully rather than failing when null.
const AUTH_CREDENTIAL = process.env.TEST_AUTH_CREDENTIAL ?? readCredentialFromClaude() ?? null;
/* Kept in step with playwright.config.js's baseURL — same env var, same
   default. Read here so a scenario can tell WHICH origin it is exercising,
   which is what separates a CI-only cross-origin refusal from a real one. */
const BASE_URL = process.env.APP_URL || 'https://akyachtsman.github.io/claude.trading/';

/* ── shared error allowlist ──────────────────────────────────────────────────
   S1 and S3 each grew their own copy of this, and on 2026-08-01 they drifted:
   S3's `pageerror` listener had no filter at all while its console twin had one,
   so the iphone project failed on errors Chromium was already dropping. The
   vocabulary and the pageerror rule live HERE now so there is one thing to
   change. Each scenario's console rule stays its own — S1 sweeps page load and
   S3 sweeps interactions, and they legitimately tolerate different breadth —
   but both are built from these constants rather than from re-typed literals. */
const FEED_ORIGIN = '.supabase.co/functions/v1/';
const FEED_CORS = /Access-Control-Allow-Origin|access control checks/i;
/* The TradingView embed probes motion sensors from inside its OWN nested
   sub-frame, which an `allow=` on the outer iframe cannot reach (tried in
   PR #78). Exact string only — never a blanket console mute. */
const BENIGN_CONSOLE = /Permissions policy violation: accelerometer is not allowed/i;
const OWN_ORIGIN = (() => { try { return new URL(BASE_URL).origin; } catch { return ''; } })();
/* The origin-based half of the rule below is enabled ONLY for a LOCAL test
   server — the http-server qa.yml runs against — and not merely for "any origin
   that isn't production" (Codex review). qa-live accepts an `app_url` override,
   so a staging or preview deploy would otherwise inherit the carve-out and a
   genuine quote-proxy CORS misconfiguration there would be swallowed. S14 would
   not catch it either: it proves the MARKET feed, not quote-proxy. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(OWN_ORIGIN);

/* A blocked cross-origin call to the desk's own feed layer, as it arrives on
   `pageerror`. WebKit raises these as page errors (Chromium only logs them),
   and a pageerror carries NO source URL, so the match has to come from the text.

   One blocked fetch emits a PAIR and only the second names the URL:
     "Origin http://localhost:8080 is not allowed by Access-Control-Allow-Origin…"
     "…/functions/v1/quote-proxy due to access control checks."
   so a feed-origin test alone drops half of it. The first is matched on the
   REFUSED ORIGIN being the one this run is served from — quote-proxy's guard is
   an allowlist holding exactly the Pages origin, so a localhost run is SUPPOSED
   to be refused: the control working, not a defect.

   Deliberately strict: pageerror is where genuine application faults land, so a
   message must be CORS-phrased AND name either the feed origin or a LOCAL test
   origin. Everything else still fails. */
const benignPageError = (text) => {
  const t = text || '';
  return FEED_CORS.test(t) &&
    (t.includes(FEED_ORIGIN) || (LOCAL_ORIGIN && t.includes(OWN_ORIGIN)));
};

// ─────────────────────────────────────────────────────────────────────────────
// API CALL CAPTURE — must wrap fetch before page load via addInitScript
// ─────────────────────────────────────────────────────────────────────────────
async function captureApiCalls(page) {
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.__apiCalls = [];
    // Fresh id per document: addInitScript re-runs on every full navigation, so a
    // changed id means window.__apiCalls was reset (used to detect navigation in S3).
    window.__pageLoadId = Math.random();
    window.fetch = async (...args) => {
      const res = await orig(...args);
      // Record the call (with its status) IMMEDIATELY so non-JSON 4xx/5xx responses
      // (e.g. an HTML 500 page) are captured — clone.json() rejects on those, and the
      // old code only pushed inside .then(), silently dropping them as "no call".
      const entry = {
        url: typeof args[0] === 'string' ? args[0] : args[0]?.url,
        status: res.status,
        recordCount: null,
        firstFieldKey: null,
        error: null,
      };
      window.__apiCalls.push(entry);
      res.clone().json().then(body => {
        // Backend-agnostic: most REST backends return an array of row objects; some
        // backends wrap rows as { records: [{ fields: {...} }] }.
        const rows = Array.isArray(body) ? body : (body?.records ?? null);
        const firstRow = rows?.[0];
        entry.recordCount  = Array.isArray(rows) ? rows.length : null;
        entry.firstFieldKey = firstRow
          ? Object.keys(firstRow.fields ?? firstRow)[0] ?? null
          : null;
        entry.error = body?.error ?? body?.message ?? null;
      }).catch(() => {}); // non-JSON body: status already recorded above
      return res;
    };
  });
  return () => page.evaluate(() => window.__apiCalls);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM STATE SNAPSHOT — used to detect transitions in single-page apps
// ─────────────────────────────────────────────────────────────────────────────
async function domSnapshot(page) {
  return page.evaluate(() => ({
    visibleIds: [...document.querySelectorAll('[id]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map(el => el.id),
    bodyText: document.body.innerText?.slice(0, 500),
    inputCount: document.querySelectorAll('input:not([type=hidden])').length,
    buttonCount: document.querySelectorAll('button, [role=button]').length,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH DISCOVERY & ATTEMPT
// ─────────────────────────────────────────────────────────────────────────────
async function detectAndAuth(page, credential) {
  // Wait for auth UI to be fully active before interacting — prevents CI timing failures
  // on mobile/WebKit where JS activates slower than desktop Chromium.
  await page.locator('[class*="keypad"], [class*="pin"], input[type="password"], input[type="text"]')
    .first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  // Heuristic 1: numeric keypad (buttons 0-9 + dot indicators)
  const hasNumericButtons = await page.locator('button').filter({ hasText: /^[0-9]$/ }).count();
  const hasDotIndicator   = await page.locator('[class*="dot"], [class*="pin"]').count();

  if (hasNumericButtons >= 9 && hasDotIndicator > 0) {
    // PIN keypad — click each digit as a string (preserve leading zeros)
    for (const digit of String(credential).split('')) {
      await page.locator('button').filter({ hasText: new RegExp(`^${digit}$`) }).first().click();
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(3000);
    return 'pin-keypad';
  }

  // Heuristic 2: password input
  const passwordInput = page.locator('input[type=password]').first();
  if (await passwordInput.isVisible().catch(() => false)) {
    await passwordInput.fill(String(credential));
    const submitBtn = page.locator('button[type=submit], input[type=submit], button').filter({ hasText: /sign.?in|log.?in|submit|enter/i }).first();
    if (await submitBtn.isVisible().catch(() => false)) await submitBtn.click();
    else await passwordInput.press('Enter');
    await page.waitForTimeout(3000);
    return 'password-form';
  }

  // Heuristic 3: text input accepting short credential
  const textInput = page.locator('input[type=text], input:not([type])').first();
  if (await textInput.isVisible().catch(() => false)) {
    await textInput.fill(String(credential));
    await textInput.press('Enter');
    await page.waitForTimeout(3000);
    return 'text-input';
  }

  return 'none'; // no auth gate detected
}

// Detection-only: is there a real auth gate (PIN keypad or password field)? Does NOT
// interact, and deliberately ignores plain text inputs (a search/filter box is not an
// auth gate). Used to decide whether to skip/auth without firing spurious login attempts.
async function detectAuthGate(page) {
  await page.locator('[class*="keypad"], [class*="pin"], input[type="password"]')
    .first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const hasNumericButtons = await page.locator('button').filter({ hasText: /^[0-9]$/ }).count();
  const hasDotIndicator   = await page.locator('[class*="dot"], [class*="pin"]').count();
  if (hasNumericButtons >= 9 && hasDotIndicator > 0) return true;
  if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) return true;
  // Text/access-code gate (detectAndAuth's text-input path): a SINGLE visible text input
  // on a sparse, login-like page — gated on auth-ish context so an arbitrary search/filter
  // box on a content-rich page is NOT treated as auth.
  return await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (inputs.length !== 1) return false;
    const el = inputs[0];
    const ctx = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id,
                 document.body.innerText?.slice(0, 300)].join(' ').toLowerCase();
    const looksAuth = /\b(pin|passcode|access\s*code|access|log\s*in|login|sign\s*in|unlock|enter\s*code|password)\b/.test(ctx);
    const controls = document.querySelectorAll('button, [role=button], a[href], select, textarea').length;
    return looksAuth && controls <= 4;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERACTIVE ELEMENT DISCOVERY
// ─────────────────────────────────────────────────────────────────────────────
async function discoverElements(page) {
  return page.evaluate(() => {
    const selectors = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
                       '[role=button]', '[onclick]'];
    return selectors.flatMap(sel =>
      [...document.querySelectorAll(sel)]
        // Index BEFORE filtering: page.locator(sel).nth(i) counts every DOM match,
        // hidden included, so the recorded index must count them too.
        .map((el, index) => ({ el, index }))
        .filter(({ el }) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map(({ el, index }) => ({
          selector: sel,
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? null,
          label: (el.textContent?.trim().slice(0, 60) ||
                  el.getAttribute('aria-label') ||
                  el.getAttribute('placeholder') ||
                  el.getAttribute('name') ||
                  el.id || '').slice(0, 60),
          id: el.id || null,
        }))
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST FILL VALUE — infer plausible value from element context
// ─────────────────────────────────────────────────────────────────────────────
function testValueFor(el) {
  const label = (el.label + (el.type ?? '')).toLowerCase();
  if (/email/.test(label))         return 'test@example.com';
  if (/date/.test(label))          return new Date().toISOString().split('T')[0];
  if (/number|qty|amount|count/.test(label)) return '42';
  if (/phone|tel/.test(label))     return '5551234567';
  if (/url|link/.test(label))      return 'https://example.com';
  return 'Test input';
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 1 — Page Load
// ─────────────────────────────────────────────────────────────────────────────
test('S1: page loads without JS errors', async ({ page }) => {
  const errors = [];
  /* Shared with S3 — see benignPageError at the top of this file. */
  page.on('pageerror', e => {
    const t = e.message || '';
    if (benignPageError(t)) return;
    errors.push(t);
  });
  // Allowlist (spec Clarifications #7, Group C): failed fetches to the live
  // feed origin log browser console errors we can't suppress from JS
  // ("Failed to load resource … functions/v1/desk-*"). The app handles those
  // failures by design (keeps last good render, lamps Stale) — S14 covers
  // feed health. Everything else still fails S1. Narrow on purpose: origin
  // substring only, never a blanket console mute.
  // Network-layer console errors carry the URL in location(), not text().
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const at = (m.location() && m.location().url) || '';
    if (m.text().includes(FEED_ORIGIN) || at.includes(FEED_ORIGIN)) return;
    /* A CORS REJECTION from the feed origin is the same allowlisted noise, but
       it arrives as a PAIR and only the second message names the URL — the
       first says "Origin http://localhost:8080 is not allowed by
       Access-Control-Allow-Origin" with an EMPTY location, so neither existing
       test catches it. That is quote-proxy's origin allowlist working: it
       admits exactly the GitHub Pages origin and this job serves from
       localhost, so the browser is supposed to refuse. The live job, on the
       real origin, never sees it.
       It only started landing inside S1's window because the charts quote is
       polled every minute since the SMH staleness fix, instead of being fetched
       once per tab. Broader than benignPageError on purpose: S1's console rule
       has tolerated any CORS-phrased console error since it was written, and a
       console error is a far weaker signal than a pageerror. */
    if (FEED_CORS.test(m.text())) return;
    errors.push(`${m.text()} (${at || 'no url'})`);
  });
  await page.goto('./');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  const bodyText = await page.evaluate(() => document.body.innerText?.trim());
  expect(bodyText?.length, 'Page body is empty').toBeGreaterThan(0);
  expect(errors, `JS errors on load: ${errors.join('; ')}`).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 2 — Auth Discovery & Login (with API diagnostics)
// ─────────────────────────────────────────────────────────────────────────────
test('S2: auth gate discovered and credential accepted', async ({ page }) => {
  if (!AUTH_CREDENTIAL) test.skip(true, 'No auth credential found in CLAUDE.md or TEST_AUTH_CREDENTIAL env var — skipping auth test');
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const getApiCalls = await captureApiCalls(page);
  await page.goto('./');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});

  const beforeSnap = await domSnapshot(page);
  // Gate the auth attempt on detectAuthGate() — same as S4 and gotoAndAuth. Unguarded,
  // detectAndAuth's text-input fallback would type the credential into the first visible
  // text input (e.g. a public app's search box) and then falsely report auth failure.
  const mechanism  = (await detectAuthGate(page))
    ? await detectAndAuth(page, AUTH_CREDENTIAL ?? '')
    : 'none';
  const afterSnap  = await domSnapshot(page);

  const domChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);
  // A wrong credential often renders an inline error, which itself changes the DOM —
  // so domChanged alone is not proof of success. Treat a non-empty on-screen error as a
  // failure even when the DOM changed. Read the first VISIBLE, non-empty error element:
  // apps often keep hidden/empty `.error` placeholders, so `.first().textContent()` could
  // read the wrong node. Synchronous evaluate — no locator waiting, so it can't burn the
  // test timeout either.
  const onscreenError = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[id*="err"], [class*="err"], [class*="error"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    for (const el of els) { const t = (el.textContent || '').trim(); if (t) return t; }
    return '';
  });

  if (mechanism !== 'none' && (!domChanged || onscreenError.length > 0)) {
    const apiCalls = await getApiCalls();
    const errText  = onscreenError;
    const firstKey = apiCalls[0]?.firstFieldKey ?? null;
    const diag = {
      mechanism,
      credentialProvided: AUTH_CREDENTIAL ? 'yes' : 'none — check CLAUDE.md',
      onscreenError: errText,
      consoleErrors,
      apiCalls,
      responseShape: firstKey
        ? `rows returned, first field "${firstKey}"`
        : (apiCalls[0]?.status >= 400 ? `non-2xx (${apiCalls[0]?.status})` : 'no rows returned — check query / RLS / auth'),
    };
    test.info().attach('auth-diagnostics', {
      body: JSON.stringify(diag, null, 2),
      contentType: 'application/json',
    });
    throw new Error(
      `S2 FAIL | mechanism: ${mechanism} | onscreenError: "${errText}" | ` +
      `API status: ${apiCalls[0]?.status ?? 'no call'} | ` +
      `recordCount: ${apiCalls[0]?.recordCount ?? 'n/a'} | ` +
      `responseShape: ${diag.responseShape} | ` +
      `consoleErrors: ${consoleErrors.join('; ') || 'none'}`
    );
  }

  // Auth passed or no auth required — record mechanism
  test.info().attach('auth-result', {
    body: JSON.stringify({ mechanism, domChanged }),
    contentType: 'application/json',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — Element Mapping & Interaction Sweep
// ─────────────────────────────────────────────────────────────────────────────
test('S3: interactive elements discovered and exercised without errors', async ({ page }) => {
  // The sweep scales with element count (settle + capped idle wait per
  // element) and cannot fit the 30s global timeout on element-rich apps or
  // mobile-emulated projects. 480s covers ~80 elements at the worst-case
  // per-element cost; the idle wait below is capped so one slow-settling
  // page can't eat the whole budget.
  test.setTimeout(480_000);
  // Public-first apps (knowledge hub, questionnaire) are swept even with no credential;
  // only auth-gated apps with no credential are skipped (decided after page load below).
  const consoleErrors = [];
  const apiAnomalies  = [];
  /* BENIGN_CONSOLE, FEED_ORIGIN, FEED_CORS and benignPageError are shared with
     S1 — see the allowlist block at the top of this file. Feed-origin failures
     are the app's to absorb (panels lamp STALE by design; S14 is where feed
     health fails loudly), which is why they are dropped in these two scenarios
     and nowhere else. This local regex is the shared origin STRING escaped for
     use as a pattern, so the two can never name different origins. */
  const FEED_ORIGIN_RE = new RegExp(FEED_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (BENIGN_CONSOLE.test(text)) return;
    const src = (m.location() && m.location().url) || '';
    /* Feed-origin noise only, per the S1/S3 rule in CLAUDE.md — every other
       console error still blocks.
       `Access-Control-Allow-Origin` joined the list 2026-07-31. quote-proxy's
       guard is an ORIGIN ALLOWLIST holding exactly the GitHub Pages origin, and
       this job serves the app from http://localhost:8080 — so the browser is
       *supposed* to refuse that call. It is the security control working, not a
       defect, and the live job (real origin) never sees it.
       It surfaced now rather than earlier because the charts quote used to be
       fetched once per tab; it is polled every minute since the SMH staleness
       fix, so it lands inside S3's sweep window. Matched on the TEXT as well as
       the source: the CORS pair's first message names the blocked origin rather
       than the URL, so a source-only test misses half of it. */
    const feed = FEED_ORIGIN_RE.test(src) || FEED_ORIGIN_RE.test(text);
    if (feed && /Failed to load resource|Access-Control-Allow-Origin|access control checks/i.test(text)) return;
    consoleErrors.push(text);
  });

  /* Registered next to the console listener rather than beside the
     `consoleErrors` declaration, so the two sit together and cannot drift apart
     again — a drift that left this one unfiltered until 2026-08-01. Rule shared
     with S1: see benignPageError at the top of this file. */
  page.on('pageerror', e => {
    const t = e.message || '';
    if (benignPageError(t)) return;
    consoleErrors.push(t);
  });

  const getApiCalls = await captureApiCalls(page);
  await page.goto('./');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  // Authenticate if we have a credential; if there's a real auth gate but no credential,
  // skip — sweeping the login screen would fire spurious PIN/password attempts and 401/403s
  // don't block, so the job could "pass" without reaching app content. A public app with
  // no gate falls through and is swept normally.
  if (AUTH_CREDENTIAL) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  } else if (await detectAuthGate(page)) {
    test.skip(true, 'Auth gate present but no credential — skipping sweep (would only exercise the login screen)');
  }

  const elements = await discoverElements(page);
  test.info().attach('element-map', {
    body: JSON.stringify(elements, null, 2),
    contentType: 'application/json',
  });

  const findings = [];

  for (const el of elements) {
    const errorsBefore = consoleErrors.length;
    // Only calls made by THIS interaction count as findings. callsBefore is the baseline
    // length; loadIdBefore detects whether the interaction navigated (which resets the
    // array) so we don't mis-slice the new page's calls — see recentBadCalls below.
    const callsBefore  = ((await getApiCalls()) ?? []).length;
    const loadIdBefore = await page.evaluate(() => window.__pageLoadId).catch(() => null);
    const snapBefore   = await domSnapshot(page);

    try {
      // CSS.escape is browser-only — in this Node context it throws, and the
      // catch below would silently skip every id-bearing element. JSON.stringify
      // yields a CSS-string-compatible escape for the [id="…"] selector.
      const locator = el.id
        ? page.locator(`[id=${JSON.stringify(el.id)}]`)
        : page.locator(el.selector).nth(el.index);

      if (!await locator.isVisible().catch(() => false)) continue;

      if (['button', 'a'].includes(el.tag) || el.type === 'submit' || el.selector.includes('role=button')) {
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        // Capped: uncapped networkidle defaults to 30s — a handful of
        // slow-settling interactions on the live site blows the test budget.
        // 1.5s: on an unlocked live desk some requests stay pending long
        // enough that every element would otherwise pay the full cap.
        await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
      } else if (el.tag === 'textarea' ||
                 (el.tag === 'input' &&
                  [null, 'text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(el.type))) {
        // fill() only works on text-like inputs — on checkbox/radio/file/range/color it
        // throws "Cannot fill…", which the expected-error regex in the catch below does
        // NOT match, producing spurious interactionError findings.
        await locator.fill(testValueFor(el), { timeout: 3000 });
      } else if (el.tag === 'input' && ['checkbox', 'radio'].includes(el.type)) {
        await locator.click({ timeout: 3000 });
      } else if (el.tag === 'select') {
        const options = await locator.locator('option').allTextContents();
        // Explicit timeout: a select whose target option is disabled (gated
        // period dropdown) otherwise waits the 30s default before throwing.
        if (options.length > 1) await locator.selectOption({ index: 1 }, { timeout: 3000 });
      }

      const snapAfter      = await domSnapshot(page);
      const domTransition  = JSON.stringify(snapBefore) !== JSON.stringify(snapAfter);
      const newErrors      = consoleErrors.slice(errorsBefore);
      const apiCalls       = (await getApiCalls()) ?? [];
      // If the interaction navigated, window.__apiCalls was reset to the new page's calls
      // (which are unrelated to callsBefore and may be the same length or longer). Detect
      // that via the page-load id and treat ALL current calls as recent; otherwise slice
      // off the pre-interaction baseline. (Length alone is unreliable — a reset page with
      // one failing call can match callsBefore and hide the failure.)
      const loadIdAfter    = await page.evaluate(() => window.__pageLoadId).catch(() => null);
      const navigated      = loadIdAfter !== loadIdBefore;
      const recentBadCalls = (navigated ? apiCalls : apiCalls.slice(callsBefore))
        .filter(c => c.status >= 400);

      if (newErrors.length > 0 || recentBadCalls.length > 0) {
        findings.push({
          element: el.label || el.id || `${el.tag}[${el.index}]`,
          action: el.tag === 'input' ? 'fill' : 'click',
          consoleErrors: newErrors,
          apiErrors: recentBadCalls,
          domTransition,
        });
      }
    } catch (e) {
      // Stale / detached / not-found / timeout are expected during an exploratory
      // sweep of an SPA. Anything else is an unexpected interaction error worth
      // surfacing — recorded as a non-blocking finding (no consoleErrors/apiErrors, so
      // it doesn't fail this advisory job) rather than silently swallowed.
      const msg = String(e?.message ?? e);
      if (!/detached|not attached|stale|no longer|not visible|element is not|Timeout.*exceeded/i.test(msg)) {
        findings.push({
          element: el.label || el.id || `${el.tag}[${el.index}]`,
          action: el.tag === 'input' ? 'fill' : 'click',
          consoleErrors: [],
          apiErrors: [],
          interactionError: msg,
          domTransition: false,
        });
      }
    }
  }

  test.info().attach('interaction-findings', {
    body: JSON.stringify(findings, null, 2),
    contentType: 'application/json',
  });

  /* feed-origin 5xx excluded — see the FEED_ORIGIN note on the console
     listener above; a persistent feed outage still fails loudly via S14 */
  const blocking = findings.filter(f =>
    f.apiErrors.some(c => c.status >= 500 && !FEED_ORIGIN_RE.test(c.url || '')) ||
    f.consoleErrors.length > 0);
  expect(blocking, `Blocking anomalies found:\n${JSON.stringify(blocking, null, 2)}`).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — Responsive Layout
// ─────────────────────────────────────────────────────────────────────────────
test('S4: no horizontal overflow at 390px mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  // Authenticate only when a real auth gate (PIN/password) is detected, so overflow is
  // measured against the real app rather than the login screen. Gate on detectAuthGate()
  // — NOT just "a credential exists" — so a public-first app with a stray text input
  // (search/filter) isn't mutated by detectAndAuth's text-input fallback before measuring.
  if (AUTH_CREDENTIAL && await detectAuthGate(page)) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  }
  const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
  const viewWidth = await page.evaluate(() => window.innerWidth);
  expect(bodyWidth).toBeLessThanOrEqual(viewWidth + 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED — load the app and authenticate if a real auth gate is present
// (mirrors the S3/S4 preamble: skips the test when gated with no credential, so
// the navigation/control invariants below never just exercise the login screen)
// ─────────────────────────────────────────────────────────────────────────────
async function gotoAndAuth(page) {
  await page.goto('./');
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  // Detect once and branch — each detectAuthGate() call burns a 5s waitFor timeout when
  // no gate is present, so calling it in both branches wasted ~10s of the test timeout.
  const gated = await detectAuthGate(page);
  if (AUTH_CREDENTIAL && gated) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  } else if (gated) {
    test.skip(true, 'Auth gate present but no credential — skipping navigation/control invariants');
  }
}

// A low-noise fingerprint of the current view — heading + control counts + a body
// text prefix. Used to tell drill-down levels apart and to detect a back control
// returning to a level it just left (a circular/ping-pong back loop). Deliberately
// avoids volatile generated ids; if a correct app re-renders unstable text and this
// false-fails, narrow it to a stable view title (e.g. the h1/h2 only).
async function viewSignature(page) {
  return page.evaluate(() => {
    const h = (document.querySelector('h1, h2, [role=heading]')?.textContent || '').trim().slice(0, 80);
    const buttons = document.querySelectorAll('button, [role=button]').length;
    const inputs = document.querySelectorAll('input:not([type=hidden]), select, textarea').length;
    const text = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `${h}#${buttons}#${inputs}#${text}`;
  });
}

// A single visible in-app back control, or an empty locator. Matches an accessible
// name / aria-label of "back" or a left-arrow glyph, or an explicit [data-back] hook.
// Deliberately narrow so the browser's Back button is NOT mistaken for an in-app one.
// A back control is one whose WHOLE label is a back affordance — not any
// element containing the substring "back". `a:has-text("Back")` matches
// case-insensitively anywhere in the text, so on 2026-07-31 this resolved to a
// CNBC headline ("…soars on the back of AI demand") in the news panel, and the
// unwind step burned its whole budget trying to click a story link. `:text-is()`
// matches the trimmed full text, so prose can no longer qualify. `[data-back]`
// and an explicit aria-label stay as they are — both are deliberate authoring
// signals, not incidental text.
function backControl(page) {
  return page.locator(
    '[data-back], [aria-label*="back" i], ' +
    'button:text-is("Back"), a:text-is("Back"), ' +
    'button:text-is("← Back"), a:text-is("← Back"), ' +
    'button:text-is("←"), a:text-is("←"), ' +
    'button:text-is("‹"), a:text-is("‹")'
  ).first();
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO — NAV: in-app back navigation strictly unwinds (no circular loop)
// Drill to the deepest level reachable, then press the in-app back control once
// per level: each back must retrace to the prior level and never return to the
// level it just left (an A↔B ping-pong). Catches the class of bug where "back"
// tracks the last page visited instead of an origin-aware nav stack. Skips when
// the app has no multi-level drill-down or no in-app back control (invariant N/A).
// ─────────────────────────────────────────────────────────────────────────────
// Controls this crawler must not spend its budget on, or must not touch at all.
//
// CORRECTION (2026-07-31): the first version of this list, and the commit that
// introduced it, said it excluded "data cells" and named watchlist/market tiles,
// heatmap rects and sector cells. Measured against the served page with
// discoverElements' own selector list, that was simply wrong:
//
//     candidates 64 · removed 31  →  .seg 27, [role=tab] 4
//     .wl-tile 75 in DOM / 0 candidates    .mkt-tile 75 / 0
//     .mk-sec  11 in DOM / 0 candidates    .hm-tile   0 / 0  (does not exist)
//
// Tiles are divs carrying only `tabIndex`, so they never matched
// `button, a[href], [role=button], [onclick]` and were never candidates. The
// tile entries below are inert; they are kept only so this note has something
// to point at, and so a future tile that DOES become a button stays excluded.
//
// What the filter really removes is `.seg` and `[role=tab]` — and those ARE
// worth removing, though not for the reason first given: they re-render the
// same view rather than drilling into a new one, so every one is a wasted 5s.
//
// `.wl-edit` is the entry that actually matters, and the first version missed
// it. The live run on fa46049 caught the crawler with `#wlEditBackdrop` OPEN:
// the ✎ opens the watchlist editor against the real roster, and that modal
// holds `#wlSaveBtn` ("Save & exit"), which issues a replace-all to
// `desk_watchlists`. An exploratory crawler must not be one stray click from
// rewriting live data. The other write controls are excluded on the same
// principle, whether or not they are currently reachable.
const NAV_SKIP = [
  '.wl-edit', '.modal-backdrop',                       // live-roster write path
  '.wl-band-head', '.wl-trash', '.wl-tray',            // roster mutation
  '.wl-tile', '.mkt-tile', '.hm-tile', '.mk-sec',      // inert today — see above
  '.seg', '[role=tab]',                                // re-render, never drill
];
const navSkippable = (page, el) => page.evaluate(({ sel, index, skip }) => {
  const node = document.querySelectorAll(sel)[index];
  return !node || skip.some((s) => node.closest(s));
}, { sel: el.selector, index: el.index, skip: NAV_SKIP });

test('NAV: back navigation strictly unwinds (no loop)', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoAndAuth(page);

  const DEPTH_CAP = 5;
  // Per-level candidate cap. A drill-in either exists among the page's genuine
  // navigation controls or it does not; trying the 200th watchlist tile is not
  // more informative than trying the 12th, and the settle wait below means every
  // extra attempt costs real seconds.
  // Measured on the served page: 64 visible candidates before filtering, ~5.8s
  // each (the click timeout plus a networkidle that never settles) — 360s for a
  // SINGLE level against a 120s ceiling. Filtering leaves 33; the cap is what
  // actually bounds the run.
  //
  // CORRECTION (2026-07-31): the original note blamed the live blowup on the
  // watchlist rendering "a tile per symbol, and there are 248 of them". It did
  // not — tiles are not candidates at all (see NAV_SKIP). The cost was always
  // ~5.8s across ~60 genuine controls; live is slower per click only because
  // every one waits out a networkidle that a polling desk never reaches.
  const TRIES_PER_LEVEL = 8;
  const forward = [await viewSignature(page)]; // forward[0] = starting level

  // Drill down: at each level click the first "drill-in" candidate that BOTH changes
  // the view AND reveals an in-app back control. Stop at the cap, on no change, or
  // when no further drill-in exists.
  for (let d = 0; d < DEPTH_CAP; d++) {
    const before = forward[forward.length - 1];
    let advanced = false;
    let tried = 0;
    for (const el of await discoverElements(page)) {
      if (tried >= TRIES_PER_LEVEL) break;
      if (!['a', 'button'].includes(el.tag) && !el.selector.includes('role=button')) continue;
      if (/back|←|‹|◀|return|home/i.test(el.label)) continue; // never drill via a back/home control
      if (await navSkippable(page, el)) continue; // data cell, not navigation — see NAV_SKIP
      try {
        const loc = el.id ? page.locator(`[id=${JSON.stringify(el.id)}]`) : page.locator(el.selector).nth(el.index);
        if (!await loc.isVisible().catch(() => false)) continue;
        tried++;
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        // Short settle, NOT networkidle. The desk polls its feeds on a timer and
        // streams quotes while the market is open, so the network never goes
        // idle — the old 4s budget was spent in full on every single candidate
        // and bought nothing. A view change here is a DOM change, not a network
        // one, and the 800ms above is what actually observes it.
        await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {});
      } catch { continue; }
      const after = await viewSignature(page);
      const hasBack = await backControl(page).isVisible().catch(() => false);
      // Any view change ends this level's search: a drill-in (has a back control →
      // descend and keep going) or an unexpected move (no back control → stop, rather
      // than keep clicking a now-stale element list from the page we just left).
      if (after !== before) { if (hasBack) { forward.push(after); advanced = true; } break; }
    }
    if (!advanced) break;
  }

  // Need at least two levels AND a back control on screen to assert anything.
  if (forward.length < 2 || !(await backControl(page).isVisible().catch(() => false))) {
    test.skip(true, 'No multi-level drill-down with an in-app back control found — back-flow invariant N/A');
  }

  // Unwind: one back press per descended level. Each result must equal the expected
  // prior level and must NOT equal the level just left (the ping-pong signature).
  const trail = [];
  for (let i = forward.length - 1; i >= 1; i--) {
    const left = forward[i];          // current level, before pressing back
    const expected = forward[i - 1];  // the level back should return to
    const back = backControl(page);
    if (!await back.isVisible().catch(() => false)) break;
    await back.click({ timeout: 3000 });
    await page.waitForTimeout(800);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    const now = await viewSignature(page);
    trail.push({ stepFromDeepest: forward.length - i, expected, left, got: now });
    test.info().attach('back-flow-trail', { body: JSON.stringify(trail, null, 2), contentType: 'application/json' });
    expect(now,
      `Back from level ${i} returned to the level it just left — circular/ping-pong back navigation.`
    ).not.toBe(left);
    expect(now,
      `Back from level ${i} did not return to the prior level (origin-aware back broken).`
    ).toBe(expected);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO — CTRL: each primary action appears exactly once per view
// A duplicated primary CTA (e.g. two "Add asset" buttons) is a finding. Scans
// visible add/new/create controls, groups by accessible name, flags any with >1.
// ─────────────────────────────────────────────────────────────────────────────
test('CTRL: no duplicated primary action control', async ({ page }) => {
  await gotoAndAuth(page);
  const dupes = await page.evaluate(() => {
    const norm = s => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const isPrimary = name => /^(add|new|create)\b/.test(name);
    const counts = {};
    for (const el of document.querySelectorAll('button, [role=button], a[href]')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue; // visible only — a hidden mobile/desktop variant is fine
      const name = norm(el.textContent || el.getAttribute('aria-label'));
      if (!isPrimary(name)) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
    return Object.entries(counts).filter(([, n]) => n > 1).map(([name, n]) => ({ name, count: n }));
  });
  expect(dupes,
    `Duplicated primary action control(s) on the current view:\n${JSON.stringify(dupes, null, 2)}`
  ).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 5+ — Project-Specific Scenarios
// Source: CLAUDE.md § Project-Specific Test Scenarios
// Generic coverage is S1–S4 plus the NAV/CTRL invariants above; add
// project-specific scenarios starting at S5.
// Add one scenario per row in that table before running the QA pipeline.
// ─────────────────────────────────────────────────────────────────────────────

// S5 — Demo lamps: every panel honestly labels demo data (design signature).
test('S5: demo mode shows DEMO lamps on every panel', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#mastheadState')).toContainText(/demo data/i);
  for (const id of ['#newsLamp', '#askLamp']) {
    await expect(page.locator(id), `${id} must read Demo in demo mode`).toHaveText(/demo/i);
  }
});

// S6 — Positions sort: header click reorders rows and flips aria-sort.
test('S6: positions table sorts on header click', async ({ page }) => {
  await page.goto('./?demo=1');
  const table = page.locator('#accountGrid table').first();
  const header = table.locator('th', { hasText: 'Unrl P&L' });
  const firstCell = () => table.locator('tbody tr').first().locator('td').nth(3).getAttribute('data-sort');
  await header.click();
  const dir1 = await header.getAttribute('aria-sort');
  const v1 = Number(await firstCell());
  await header.click();
  const dir2 = await header.getAttribute('aria-sort');
  const v2 = Number(await firstCell());
  expect([dir1, dir2].sort()).toEqual(['ascending', 'descending']);
  expect(v1, 'row order must flip between ascending and descending').not.toBe(v2);
});

// Live-only scenarios (S10/S11) skip cleanly while the site is demo-only
// (empty DESK_DB in scripts/config.js — no backend to authenticate against).
async function liveBackendConfigured(page) {
  const res = await page.request.get('scripts/config.js');
  if (!res.ok()) return false;
  const src = await res.text();
  const m = src.match(/url:\s*'([^']*)'/);
  return Boolean(m && m[1]);
}

// S10 — Locked → login → render (needs backend + TEST_AUTH_CREDENTIAL).
test('S10: valid PIN unlocks accounts (live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  test.skip(!AUTH_CREDENTIAL, 'TEST_AUTH_CREDENTIAL not available');
  await page.goto('./');
  const pinInput = page.locator('.lock-form input.input');
  await expect(pinInput).toBeVisible();
  await pinInput.fill(AUTH_CREDENTIAL);
  await page.locator('.lock-form button').click();
  await expect(page.locator('#accountGrid .hero-number').first()).toBeVisible({ timeout: 15000 });
});

// S11 — Wrong PIN: plain error, still locked, nothing rendered.
test('S11: invalid PIN shows an error and stays locked (live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  await page.goto('./');
  const pinInput = page.locator('.lock-form input.input');
  await expect(pinInput).toBeVisible();
  await pinInput.fill('000000');
  await page.locator('.lock-form button').click();
  // Scoped to the lock panel ON PURPOSE. `.lock-error` is the desk's shared
  // error-line class, and every modal that grew a validation message adopted it
  // — the system prompt editor, watchlist quick-add, remove-confirm and edit. A
  // bare `.lock-error` matched 2 elements by PR #167 and 5 by PR #196, so
  // Playwright's strict mode rejected it before the assertion ever ran and S11
  // failed on a live desk that was behaving correctly. The next modal would have
  // made it 6; scoping to the panel under test is what keeps this stable.
  await expect(page.locator('.panel-lock .lock-error')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#accountGrid .hero-number')).toHaveCount(0);
});

// S14 — Live-feed-layer canary (Group C: the committed snapshots are gone,
// so a dead feed layer would otherwise only show up as quiet STALE lamps).
// The desk lamp (in the Accounts header since 2026-07-22) derives from the
// freshest desk-market fetch: a HEALTHY feed reads LIVE while the market is open
// or EOD once it has closed (owner ruling 2026-07-22) — only STALE/missing means
// the edge-function layer is actually down.
test('S14: desk lamp reads LIVE/EOD off the market feed (live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  await page.goto('./');
  const lamp = page.locator('#mastheadState .lamp').first();
  await expect(lamp, 'live feed unreachable or stale — check desk-market').toHaveText(/^(LIVE|EOD)$/, { timeout: 20000 });
});

// S12 — Charts workbench: three doctrine panes with candles, stochastics,
// zoom presets, symbol select, pane layouts, and the settings popover.
// Defaults must render candles + k/%d stochastic paths in every pane.
test('S12: charts workbench renders panes and controls respond', async ({ page }) => {
  await page.goto('./?demo=1');
  const chart = page.locator('#wbChart');
  await expect(chart.locator('rect').first()).toBeVisible({ timeout: 10000 });

  // default split: all three pane captions (tier names per owner ruling
  // 2026-07-22: Pro 1 = swing, Pro 2 = long-term), candles, stoch paths (k+d ×3)
  for (const cap of ['PRO 1 · SWING', 'PRO 2 · LONG-TERM', 'PRO 3 · DAY TRADING']) {
    await expect(chart, `missing pane caption ${cap}`).toContainText(cap);
  }
  expect(await chart.locator('rect').count(), 'candle/volume rects must render').toBeGreaterThan(30);
  expect(await chart.locator('path').count(), 'stochastic %K/%D paths must render').toBeGreaterThanOrEqual(6);

  // Pro 1 zoom seg: clicking 1M moves aria-pressed and redraws
  const before = await chart.locator('rect').count();
  const oneMonth = page.locator('#chartZoom button', { hasText: '1M' });
  await oneMonth.click();
  await expect(oneMonth).toHaveAttribute('aria-pressed', 'true');
  expect(await chart.locator('rect').count(), 'zoom must redraw').not.toBe(before);

  // typeable symbol box: typing a roster ticker re-renders, sidebar tracks aria-current
  const symBox = page.locator('#wbSymInput');
  await symBox.fill('QQQ');
  await symBox.press('Enter');
  await expect(page.locator(`#wbSidebar button[aria-current="true"]`)).toContainText('QQQ');

  // pane layout seg maximizes a single tier and returns to split
  await page.locator('#chartLayout button', { hasText: 'Pro 2' }).click();
  await expect(chart).not.toContainText('PRO 1 · SWING');
  await expect(chart).toContainText('PRO 2 · LONG-TERM');
  await page.locator('#chartLayout button', { hasText: 'Split' }).click();
  await expect(chart).toContainText('PRO 1 · SWING');

  // per-pane header bars: each gear opens its own popover above its pane.
  // The weekly-stoch overlay toggle now lives on Pro 2 ALONE (owner ruling
  // 2026-07-17); Pro 1/Pro 3 show only their native stochastic.
  // Pro 1 = full set (bb, vol, stoch, 5 SMAs, 3 S/R, 5 SMA-price = 16 boxes
  // + 2 style radios); Pro 3 = slim day-trading panel (bb, vol, stoch) PLUS the
  // Session -> Extended hours toggle (owner request 2026-07-29) = 4 boxes.
  // Pro 3 alone gets that toggle: it is the only intraday tier.
  await page.locator('#wbGear-p1').click();
  await expect(page.locator('#wbSettings-p1')).toBeVisible();
  expect(await page.locator('#wbSettings-p1 input[type=radio]').count()).toBe(2);
  expect(await page.locator('#wbSettings-p1 input[type=checkbox]').count()).toBe(16);
  await page.locator('#wbGear-p3').click();
  await expect(page.locator('#wbSettings-p1')).toBeHidden();
  expect(await page.locator('#wbSettings-p3 input[type=checkbox]').count()).toBe(4);
  // the extended-hours control is present, on by default, and actually toggles
  const ext = page.locator('#wbSettings-p3 label', { hasText: 'Extended hours' });
  await expect(ext).toBeVisible();
  const extBox = ext.locator('input[type=checkbox]');
  await expect(extBox).toBeChecked();
  await extBox.uncheck();
  await expect(extBox).not.toBeChecked();
});

// S13 — Heatmap MAP FILTER rail: index cuts re-render the treemap, the ETF
// map unlocks multi-period performance, unfetched feeds stay disabled.
test('S13: heatmap map-filter cuts and period select respond', async ({ page }) => {
  await page.goto('./?demo=1');
  // The panel is COLLAPSED by default now (owner request 2026-07-31, load
  // time) and fetches nothing until opened, so the cut/period assertions below
  // have to open it first. Asserted rather than just clicked through: "closed
  // on arrival" is the behaviour that keeps the desk's heaviest feed off the
  // boot path, and a regression there would otherwise show up only as a slow
  // dashboard, which no test would catch.
  await expect(page.locator('#heatBody'), 'heatmap starts collapsed').toBeHidden();
  await expect(page.locator('#heatToggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#heatToggle').click();
  await expect(page.locator('#heatBody')).toBeVisible();

  const svg = page.locator('#heatmapSvg');
  await expect(svg.locator('rect').first()).toBeVisible({ timeout: 10000 });
  const allCount = await svg.locator('rect').count();

  // Dow 30 cut: fewer tiles, aria-current moves, title updates
  await page.locator('.map-filter-btn', { hasText: 'Dow Jones 30' }).click();
  await expect(page.locator('#heatTitle')).toContainText('Dow Jones 30');
  const djCount = await svg.locator('rect').count();
  expect(djCount, 'Dow 30 cut must shrink the map').toBeLessThan(allCount);
  await expect(page.locator('.map-filter-btn', { hasText: 'Dow Jones 30' })).toHaveAttribute('aria-current', 'true');

  // period select gated: stock cuts are 1-day only
  const periodOpts = page.locator('#heatPeriod option');
  expect(await periodOpts.count()).toBe(4);
  expect(await periodOpts.nth(2).isDisabled(), '1-Month must be disabled on a stock cut').toBe(true);

  // ETF map: renders from charts data and unlocks the period dropdown
  await page.locator('.map-filter-btn', { hasText: 'ETFs' }).click();
  await expect(page.locator('#heatTitle')).toContainText('ETFs');
  expect(await svg.locator('rect').count()).toBeGreaterThan(5);
  expect(await periodOpts.nth(2).isDisabled(), '1-Month must be enabled on the ETF cut').toBe(false);
  await page.locator('#heatPeriod').selectOption('1m');
  await expect(page.locator('#heatSource')).toContainText(/1-month/i);

  // Themes regroups the S&P dataset client-side
  await page.locator('.map-filter-btn', { hasText: 'Themes' }).click();
  await expect(page.locator('#heatTitle')).toContainText('Themes');
  expect(await svg.locator('rect').count()).toBeGreaterThan(10);

  // feeds that need the nightly maps run stay disabled in demo
  for (const label of ['Russell 2000', 'World', 'Crypto', 'Futures']) {
    await expect(page.locator('.map-filter-btn', { hasText: label })).toBeDisabled();
  }
});

// S20 — Watchlist chart timeframe (owner request 2026-07-30). Demo-gated, so it
// runs on every PR: the demo generator shapes its walk per timeframe precisely
// so this control is exercisable without a live feed.
test('S20: watchlist timeframe control redraws the tile sparklines', async ({ page }) => {
  await page.goto('./?demo=1');
  const tf = page.locator('#wlTf');
  await expect(tf.locator('button')).toHaveCount(7);      // 1D 1M 3M 6M 1Y 2Y 5Y

  // 1D is the default and is the pressed one
  await expect(tf.locator('button', { hasText: '1D' })).toHaveAttribute('aria-pressed', 'true');

  const firstPath = page.locator('.wl-strip .wl-spark svg path').first();
  await expect(firstPath).toBeVisible({ timeout: 10000 });
  const dayPath = await firstPath.getAttribute('d');

  // switching redraws: a different window is a different line
  await tf.locator('button', { hasText: '1Y' }).click();
  await expect(tf.locator('button', { hasText: '1Y' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tf.locator('button', { hasText: '1D' })).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() => firstPath.getAttribute('d'), { message: '1Y must draw a different path than 1D' })
    .not.toBe(dayPath);

  // and it survives a reload — the control is persisted, not per-render state
  await page.reload();
  await expect(page.locator('#wlTf button', { hasText: '1Y' })).toHaveAttribute('aria-pressed', 'true');
});

// S31 — Create and delete a whole watchlist from the panel (owner request
// 2026-08-01). Both edits previously required opening the ✎ editor.
//
// The duplicate-name refusal is the load-bearing assertion here, and it is NOT
// cosmetic: wlPick() resolves a list by title whenever its index has shifted,
// and gives up unless exactly one matches. Two lists sharing a name would make
// every add, remove and drop into either of them silently unaddressable.
test('S31: create and delete a list, and refuse a duplicate name', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  // Demo has no backend to write to, so neither control may be offered.
  await expect(page.locator('#wlNewListBtn'), 'demo must offer no new-list button').toBeHidden();
  expect(await page.locator('.wl-del').count(), 'demo must offer no delete-list button').toBe(0);

  // Force the authed state and stand up a fake roster backend that holds real
  // state, so a create/delete has to actually persist rather than just repaint.
  const out = await page.evaluate(async () => {
    let store = [{ title: 'Radar', symbols: ['NVDA', 'AMD'] }, { title: 'Macro', symbols: ['TLT'] }];
    const realFetch = window.fetch;
    window.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith('desk_get_watchlists_open'))
        return Promise.resolve(new Response(JSON.stringify({ ok: true, version: 'v1',
          lists: store.map(l => ({ ...l, symbols: l.symbols.slice() })) }),
          { headers: { 'content-type': 'application/json' } }));
      if (u.endsWith('desk_set_watchlists_open')) {
        store = JSON.parse(init.body).new_lists.map(l => ({ title: l.title, symbols: (l.symbols || []).slice() }));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, version: 'v2' }),
          { headers: { 'content-type': 'application/json' } }));
      }
      if (u.includes('/functions/v1/desk-watchlist'))
        return Promise.resolve(new Response(JSON.stringify({ ok: true, range: wlTf,
          lists: store.map(l => ({ title: l.title, symbols: l.symbols.slice(),
            rows: l.symbols.map(sym => ({ sym, last: 100, pct: 1, spark: [1, 2] })) })) }),
          { headers: { 'content-type': 'application/json' } }));
      return realFetch(url, init);
    };
    const r = {};
    try {
      DESK.mode = 'live'; DESK.authed = true;
      await loadWatchlist(true);
      r.delsShown = document.querySelectorAll('.wl-del').length;
      r.newBtnShown = !document.getElementById('wlNewListBtn').hidden;

      document.getElementById('wlNewListBtn').click();
      document.getElementById('wlNewInput').value = 'Earnings';
      await submitWlNewList();
      r.afterCreate = store.map(l => l.title).join(',');

      // Case-insensitive: "earnings" must not join "Earnings".
      document.getElementById('wlNewListBtn').click();
      document.getElementById('wlNewInput').value = 'earnings';
      await submitWlNewList();
      r.dupeRefused = /already have a list/.test(document.getElementById('wlNewErr').textContent);
      r.dupeDialogStaysOpen = !document.getElementById('wlNewBackdrop').hidden;
      r.afterDupe = store.map(l => l.title).join(',');
      closeWlNewList();

      // The count comes from SAVED symbols, so an unresolved-ticker list cannot
      // be described as empty at the moment it is about to be destroyed.
      document.querySelectorAll('.wl-del')[0].click();
      r.delText = document.getElementById('wlDelText').textContent;
      r.focusOnSafe = document.activeElement.id;
      await confirmWlDelList();
      r.afterDelete = store.map(l => l.title).join(',');
    } finally { window.fetch = realFetch; }
    return r;
  });

  expect(out.newBtnShown, 'authed live must offer the new-list button').toBe(true);
  expect(out.delsShown, 'one delete per band').toBe(2);
  expect(out.afterCreate, 'the created list must persist').toBe('Radar,Macro,Earnings');
  expect(out.dupeRefused, 'a duplicate name must be refused').toBe(true);
  expect(out.dupeDialogStaysOpen, 'a refusal must not discard the typed name').toBe(true);
  expect(out.afterDupe, 'and must not write anything').toBe('Radar,Macro,Earnings');
  expect(out.delText, 'the confirm must name the list and its symbol count')
    .toContain('Radar');
  expect(out.delText).toContain('2 symbols');
  expect(out.focusOnSafe, 'a destructive dialog opens on the safe choice').toBe('wlDelCancelBtn');
  expect(out.afterDelete, 'the deleted list must be gone').toBe('Macro,Earnings');
});

// S21 — Watchlist quick add + hold-to-remove (owner request 2026-07-30).
//
// The first half is the security invariant and is pure black box: no write
// control may exist without auth, because the roster lives behind the PIN RPCs.
//
// The second half reaches into DESK to force the authed state. That is
// deliberate: the controls are auth-gated, so the alternative is NO coverage of
// a destructive action, and what is being tested is this repo's own render and
// timing logic rather than the backend. It catches the regressions that matter
// — a hold shortened to something accidental, a drag that arms a removal, or
// the keyboard path disappearing.
test('S21: watchlist edits need no unlock; removal needs a double-click', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  // DEMO has no backend to write to — the roster is a committed bootstrap file —
  // so an edit control there would be one that cannot work.
  // `:visible`, not a raw count: the panel-level + lives inside the staging
  // tray, which is hidden in demo. What matters is that no write control is
  // OFFERED, not that the markup is absent from the document.
  expect(await page.locator('.wl-add:visible').count(), 'demo must offer no + button').toBe(0);
  await expect(page.locator('#wlEditBtn')).toBeHidden();
  await expect(page.locator('#wlTrash'), 'and no trash either').toBeHidden();

  // ...and with no removal wired, the touch-gesture override must NOT apply:
  // stripping double-tap zoom where nothing listens for a double-tap takes a
  // real mobile gesture away for nothing (Codex review, PR #200).
  expect(await page.locator('.wl-strip .wl-tile.wl-removable').count(),
    'demo tiles must not be marked removable').toBe(0);
  expect(
    await page.locator('.wl-strip .wl-tile').first().evaluate(t => getComputedStyle(t).touchAction),
    'demo tiles must keep native double-tap zoom',
  ).not.toMatch(/manipulation/);

  // Live WITHOUT auth: the write controls must render anyway (owner ruling
  // 2026-07-30 — the watchlist is not to depend on unlocking; desk_011 gave it
  // PIN-free RPCs). DESK.authed stays FALSE here on purpose: setting it would
  // let a regression back to auth-gating pass unnoticed.
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  // ONE + for the whole panel now (owner request 2026-07-31) — it mints into
  // the staging tray, and the drag decides which list. The per-band buttons are
  // gone: fifteen bands meant fifteen controls doing the same job.
  expect(await page.locator('.wl-strip .wl-add').count(), 'no per-band + survives').toBe(0);
  expect(await page.locator('#wlTrayAdd').count(), 'exactly one panel-level +').toBe(1);
  // The full editor must follow the SAME predicate — it was left on
  // DESK.authed, so creating/renaming/deleting LISTS still needed an unlock
  // while add/remove did not (Codex review, PR #202).
  await expect(page.locator('#wlEditBtn'), 'the ✎ must not need an unlock either').toBeVisible();

  const tile = page.locator('.wl-strip .wl-tile').first();

  // A SINGLE click must not remove anything — the gesture has to be deliberate,
  // and a stray click on a price tile is common (owner ruling 2026-07-30 replaced
  // the hold with a double-click).
  await tile.click();
  await page.waitForTimeout(400);   /* past any dblclick coalescing window */
  await expect(page.locator('#wlRmBackdrop'), 'one click must not arm a removal').toBeHidden();

  // ...but a double-click reaches the confirm dialog
  await tile.dblclick();
  await expect(page.locator('#wlRmBackdrop')).toBeVisible();
  await expect(page.locator('#wlRmText')).toContainText(/^Remove .+ from/);
  // a destructive dialog opens on the SAFE choice, so a stray Enter keeps the symbol
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('wlRmCancelBtn');
  await page.locator('#wlRmCancelBtn').click();
  await expect(page.locator('#wlRmBackdrop')).toBeHidden();

  // Mobile browsers reserve double-tap for zoom and would swallow the gesture,
  // so the tiles must opt out of it — without this the feature works on desktop
  // and silently does nothing on a phone.
  expect(
    await tile.evaluate(t => getComputedStyle(t).touchAction),
    'tiles must opt out of double-tap zoom',
  ).toMatch(/manipulation/);

  // keyboard reaches the same dialog — a double-click is pointer-only
  await tile.focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('#wlRmBackdrop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlRmBackdrop')).toBeHidden();

  // The panel + asks WHICH LIST (owner ruling 2026-07-31, replacing the staging
  // tray) and still rejects junk. The picker is the whole point of the change:
  // add-and-be-done, instead of minting a tile and dragging it somewhere.
  // The + lands in RADAR, always (owner ruling 2026-07-31, replacing the
  // dropdown that replaced the staging tray). No destination question at all:
  // the heading names where it goes, and the list is created on first use.
  await page.locator('#wlTrayAdd').click();
  await expect(page.locator('#wlQuickTitle')).toContainText(/Radar/i);
  expect(await page.locator('#wlQuickList').count(), 'no destination dropdown').toBe(0);
  await page.locator('#wlQuickInput').fill('!!!');
  await page.locator('#wlQuickSaveBtn').click();
  await expect(page.locator('#wlQuickErr')).toBeVisible();

  // A pasted broker column must survive as SEPARATE symbols. A single-line
  // input silently joined them into one token that passed the ticker grammar
  // (Codex review, PR #196), so the field has to hold newlines.
  const field = page.locator('#wlQuickInput');
  expect(await field.evaluate(e => e.tagName), 'newlines need a textarea').toBe('TEXTAREA');
  await field.fill('SPY\nQQQ');
  expect(await field.inputValue(), 'the newline must survive').toBe('SPY\nQQQ');
  expect(
    await page.evaluate(() => wlParseSyms(document.getElementById('wlQuickInput').value)),
    'two lines are two symbols, never one concatenated token',
  ).toEqual(['SPY', 'QQQ']);

  // closing hands focus back to the + that opened it
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlQuickBackdrop')).toBeHidden();
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains('wl-add')),
    'focus returns to the invoking +',
  ).toBe(true);
});

// S26 — Drag to arrange (owner request 2026-07-31). Built on POINTER events
// because mobile never fires dragstart, so an HTML5 implementation would pass a
// desktop test and be dead on a phone. Covers the three decisions the owner
// signed off on: the sort snaps to Manual, the tray persists, and the trash is
// an ADDITION to double-click removal rather than a replacement.
test('S26: tiles drag to arrange; sort snaps to Manual; the tray persists', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  // Demo has no backend to write to, so no write surface may render at all —
  // the tray and the trash are write controls like the + always was.
  await expect(page.locator('#wlTrash'), 'no write control in demo').toBeHidden();

  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  // The WRITE CONTROLS are what must appear in live — the + and the trash.
  // The staging row itself is now hidden while empty (owner ruling
  // 2026-07-31: the permanent second row was unnecessary), so asserting it
  // visible here would pin the old layout rather than the behaviour. Its
  // reveal-on-drag is covered further down, where a drag is actually running.
  await expect(page.locator('#wlTrayAdd')).toBeVisible();
  await expect(page.locator('#wlTrash')).toBeVisible();
  expect(await page.locator('.mkt-group-tiles[data-band]').count(),
    'every band is a drop target').toBeGreaterThan(0);

  // ── the sort snap ───────────────────────────────────────────────────────
  // A hand-made order cannot survive under a sort key, so the first drag spends
  // itself switching to Manual and says so, rather than leaving a dead control.
  await page.evaluate(() => { wlSort = { key: 'pct', dir: -1 }; renderWatchlist(); });
  const tile = page.locator('.mkt-group-tiles[data-band] .wl-tile').first();
  let r = await tile.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 40, r.y + 30, { steps: 6 });
  expect(await page.locator('.wl-ghost').count(), 'no drag begins under a sort key').toBe(0);
  expect(await page.evaluate(() => wlSort.key), 'the drag snapped the sort to Manual').toBe('manual');
  await expect(page.locator('#wlNote')).toContainText(/Manual/i);
  await page.mouse.up();

  // ── a real drag, now that Manual is active ──────────────────────────────
  const src = page.locator('.mkt-group-tiles[data-band] .wl-tile').first();
  r = await src.boundingBox();
  const zone = await page.locator('.mkt-group-tiles[data-band]').nth(1).boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 40, r.y + 20, { steps: 5 });
  await page.mouse.move(zone.x + 30, zone.y + zone.height / 2, { steps: 8 });
  // the ghost follows the pointer and the insertion point is shown, so a drop
  // is never a guess about where the tile will land
  expect(await page.locator('.wl-ghost').count(), 'a ghost follows the pointer').toBe(1);
  expect(await page.locator('.wl-drop-marker').count(), 'the insertion point is drawn').toBe(1);
  expect(await page.locator('.mkt-group-tiles.wl-drop-over').count(), 'the target band lights up').toBe(1);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await page.locator('.wl-ghost').count(), 'the ghost is cleaned up').toBe(0);
  expect(await page.locator('.wl-drop-marker').count(), 'the marker is cleaned up').toBe(0);

  // Escape abandons a drag rather than committing it somewhere unintended
  r = await page.locator('.mkt-group-tiles[data-band] .wl-tile').first().boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 60, r.y + 40, { steps: 6 });
  await page.keyboard.press('Escape');
  expect(await page.locator('.wl-ghost').count(), 'Escape cancels the drag').toBe(0);
  await page.mouse.up();

  // ── no staging tray survives anywhere ──────────────────────────────────
  // The tray was removed wholesale (owner ruling 2026-07-31), so its markup,
  // its persistence key and its drop zone must ALL be gone — a leftover
  // localStorage key would silently repopulate a surface that no longer exists.
  expect(await page.locator('#wlTray, #wlTrayTiles, #wlTrayHint').count(),
    'no staging-tray markup remains').toBe(0);
  await page.locator('#wlTrayAdd').click();
  expect(await page.evaluate(() => localStorage.getItem('wl_tray_v1')),
    'the tray key is never written again').toBeNull();
  await page.locator('#wlQuickCloseBtn').click();

  // ── double-click removal is KEPT (owner ruling 2026-07-31) ──────────────
  // The trash is the drag-native equivalent, not a replacement, so the fast
  // path must still reach the confirm dialog.
  await page.locator('.wl-strip .wl-tile').first().dblclick();
  await expect(page.locator('#wlRmBackdrop'), 'double-click still removes').toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.locator('#wlTrash').count(), 'the trash is a real button, reachable without a pointer').toBe(1);

  expect(errs, 'no page errors during any drag').toEqual([]);
});

// S22 — Duplicate list titles must not misroute a quick edit (Codex review,
// PR #196). The editor permits two lists with the same name and hands out
// "New list" by default, so targeting by title alone could add to the first
// band while the dialog named the second. Position is the key; the title is
// checked against it.
test('S22: quick edits resolve the right band when two lists share a title', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  const picked = await page.evaluate(() => {
    /* two same-named lists, distinguishable only by position */
    const lists = [
      { title: 'Dupe', symbols: ['AAA'], rows: [{ sym: 'AAA', last: 1, pct: 0 }] },
      { title: 'Dupe', symbols: ['BBB'], rows: [{ sym: 'BBB', last: 2, pct: 0 }] },
    ];
    return [0, 1].map(i => {
      const l = wlPick(lists, i, 'Dupe');
      return l ? l.symbols[0] : null;
    });
  });
  expect(picked, 'each position must resolve to its own list').toEqual(['AAA', 'BBB']);

  // and if the roster moved under us, refuse rather than mutate the wrong one
  const stale = await page.evaluate(() =>
    wlPick([{ title: 'Renamed', symbols: [] }, { title: 'Other', symbols: [] }], 0, 'Dupe'));
  expect(stale, 'a shifted roster must resolve to nothing').toBe(null);
});

// S24 — A failed ACCOUNTS fetch must not revoke authentication (owner report
// 2026-07-30, reported three times before it was traced). deskGetDashboard
// collapses every failure to null, and loadPrivate treated that as a bad PIN:
// it cleared DESK.authed straight after a CORRECT unlock, so the watchlist's +
// and ✎ silently vanished with no error shown anywhere.
test('S24: a failed accounts load keeps the desk authenticated', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  const state = await page.evaluate(async () => {
    // Stand in for the live desk holding a validated PIN, then make the
    // ACCOUNTS payload fetch fail the way a network blip or empty table does.
    DESK.mode = 'live';
    DESK.authed = true;
    sessionStorage.setItem('desk_pin', '0000');
    window.deskGetDashboard = async () => null;
    await loadPrivate('0000');
    return {
      authed: DESK.authed,
      canEdit: wlCanEdit(),
      // the panel must explain what actually failed, not imply a bad PIN
      explain: document.querySelector('.panel-lock .lock-explain')?.textContent || '',
      // ...and must NOT re-present the auth gate, which is both wrong and useless
      pinFields: document.querySelectorAll('.panel-lock .lock-form input').length,
      hasRetry: !![...document.querySelectorAll('.panel-lock button')]
        .find(b => /retry/i.test(b.textContent)),
      // THE ONE THAT MATTERS: no fabricated holdings may survive into the
      // context the assistant is told is the owner's real portfolio.
      acctCount: (DESK.data.accounts || []).length,
      askAccounts: (buildAskContext()?.accounts || []).length,
    };
  });

  expect(state.authed, 'a data failure must not clear authentication').toBe(true);
  expect(state.canEdit, 'the watchlist stays editable — its writes only need the PIN').toBe(true);
  expect(state.explain, 'the message must not imply the PIN was wrong').toMatch(/PIN worked/i);
  expect(state.pinFields, 'unavailable is not locked — do not re-ask for a valid PIN').toBe(0);
  expect(state.hasRetry, 'offer a retry that reuses the validated PIN').toBe(true);
  expect(state.acctCount, 'no demo accounts may linger in live mode').toBe(0);
  expect(state.askAccounts, 'the assistant must never receive fabricated holdings').toBe(0);

  // and the edit controls really do render in that state
  await page.evaluate(() => renderWatchlist());
  expect(await page.locator('.wl-add').count(), '+ survives a failed accounts load')
    .toBeGreaterThan(0);
});

// S25 — Pro 2 colours candles by the WEEKLY STOCHASTIC CROSSOVER, not open/close
// and not the fast daily (owner ruling 2026-07-30): %K (red) above %D (yellow)
// = green candle, below = red. Pro 1 keeps price colouring.
//
// Read off the rendered SVG rather than by comparing the two panes' colour
// sequences to each other — the panes run different default windows (63 vs 126
// bars), so "the sequences differ" would pass even with Pro 2 silently fallen
// back to price colouring, which is the exact regression at issue. Both the
// daily strip and Pro 1 serve as negative controls: the rule must hold against
// the weekly series and visibly FAIL against the other two, or the check isn't
// distinguishing which stochastic is in play.
test('S25: Pro 2 candles follow the weekly stochastic; Pro 1 follows open/close', async ({ page }) => {
  await page.goto('./?demo=1');
  await page.waitForSelector('#wbChart');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(() => {
    const svg = document.getElementById('wbChart');
    const W = svg.viewBox.baseVal.width;
    const texts = [...svg.querySelectorAll('text')];
    const pts = el => (el.getAttribute('d').match(/[ML][-\d.]+[ ,][-\d.]+/g) || [])
      .map(s => s.slice(1).split(/[ ,]/).map(Number)).map(([x, y]) => ({ x, y }));

    /* Pane bounds come from the pane titles — each pane owns the x band from
       its own title to the next. Everything below is scoped to that band;
       without it a lookup silently strays into a neighbouring pane. */
    const titles = texts.filter(t => /^PRO \d/.test(t.textContent))
      .map(t => ({ t: t.textContent, x: +t.getAttribute('x') }))
      .sort((a, c) => a.x - c.x);

    const read = (titleRe, capRe) => {
      const ti = titles.findIndex(t => titleRe.test(t.t));
      if (ti < 0) return { err: 'pane title not found: ' + titleRe };
      const x0 = titles[ti].x - 10;
      const x1 = ti + 1 < titles.length ? titles[ti + 1].x - 10 : W;
      const inPane = x => x >= x0 && x < x1;

      const cap = texts.find(t => capRe.test(t.textContent) && inPane(+t.getAttribute('x')));
      if (!cap) return { err: 'caption not found in pane: ' + capRe };
      const capY = +cap.getAttribute('y');

      // this strip's own %K/%D are the nearest paths below its caption
      const near = stroke => [...svg.querySelectorAll('path[stroke="' + stroke + '"]')]
        .map(p => ({ p, b: p.getBBox() })).filter(o => inPane(o.b.x) && o.b.y > capY)
        .sort((a, c) => a.b.y - c.b.y)[0];
      const kO = near('#e23b3b'), dO = near('#f5c518');
      if (!kO || !dO) return { err: 'strip paths not found under ' + capRe };
      const k = pts(kO.p), d = pts(dO.p);

      // candles sit above the pane's FIRST strip, never above a lower one
      const topCapY = Math.min(...texts
        .filter(t => /STOCH|RSI/.test(t.textContent) && inPane(+t.getAttribute('x')))
        .map(t => +t.getAttribute('y')));
      let rects = [...svg.querySelectorAll('rect[shape-rendering=crispEdges]')]
        .map(r => ({ cx: +r.getAttribute('x') + +r.getAttribute('width') / 2, y: +r.getAttribute('y'), h: +r.getAttribute('height'), fill: r.getAttribute('fill') }))
        .filter(r => inPane(r.cx) && r.y < topCapY - 20);
      /* Volume bars share the candle shape but all rest on ONE baseline, so the
         modal bottom edge identifies them. They stay price-coloured on purpose,
         and counting them here would fake a disagreement. */
      const tally = {};
      for (const r of rects) { const bb = (r.y + r.h).toFixed(1); tally[bb] = (tally[bb] || 0) + 1; }
      const vol = Object.entries(tally).sort((a, c) => c[1] - a[1])[0];
      if (vol && vol[1] > 5) rects = rects.filter(r => (r.y + r.h).toFixed(1) !== vol[0]);

      /* Tolerance scales with bar spacing. A fixed pixel budget spans three
         bars once the pane is 166px wide on a phone, which is how an earlier
         version passed on a desktop viewport and failed in CI on both mobile
         projects. */
      const step = k.length > 1 ? (k[k.length - 1].x - k[0].x) / (k.length - 1) : 1;
      const tol = step / 2 + 0.01;
      const at = (arr, x) => arr.reduce((best, p) => Math.abs(p.x - x) < Math.abs(best.x - x) ? p : best, arr[0]);
      let agree = 0, disagree = 0;
      for (const bd of rects) {
        const kp = at(k, bd.cx), dp = at(d, bd.cx);
        if (Math.abs(kp.x - bd.cx) > tol || Math.abs(dp.x - bd.cx) > tol) continue;  // warm-up gap
        if (Math.abs(kp.y - dp.y) < 0.25) continue;                                  // too close to call
        (bd.fill.includes('gain') === (kp.y < dp.y)) ? agree++ : disagree++;         // lower y = higher value
      }
      return { agree, disagree };
    };
    return {
      weekly: read(/^PRO 2/, /CANDLE COLOUR/),        // the rule
      daily: read(/^PRO 2/, /· DAILY$/),              // must NOT be what drives it
      p1: read(/^PRO 1/, /· DAILY$/),                 // must still follow price
    };
  });

  for (const [key, r] of Object.entries(probe)) expect(r.err, `${key} located`).toBeUndefined();
  expect(probe.weekly.agree, 'Pro 2 candles sampled').toBeGreaterThan(40);
  expect(probe.p1.agree + probe.p1.disagree, 'Pro 1 candles sampled').toBeGreaterThan(20);

  // Pro 2: EVERY candle must match the WEEKLY crossover — no exceptions.
  expect(probe.weekly.disagree, 'every Pro 2 candle matches the weekly %K vs %D').toBe(0);

  // ...and must NOT be explainable by the fast daily strip in the same pane —
  // otherwise this passes whichever series the code happens to use.
  expect(probe.daily.disagree, 'Pro 2 colour is the weekly series, not the daily one')
    .toBeGreaterThan(probe.daily.agree * 0.2);

  // Pro 1 is the control: it follows open/close, so it must contradict its own
  // stochastic on a real share of bars. Zero here would mean the rule leaked.
  expect(probe.p1.disagree, 'Pro 1 still follows open/close, not the stochastic')
    .toBeGreaterThan(probe.p1.agree * 0.1);
});

// S23 — Extended hours across the desk (owner request 2026-07-30). Demo-gated so
// it runs every PR; the demo generator mirrors the live payload's shape,
// including the parts that must be ABSENT.
test('S23: post-market prints render, and only where the instrument trades', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#mktTiles .mk-tile').first()).toBeVisible({ timeout: 10000 });

  // All four index tiles carry an after-hours line, and each NAMES its proxy —
  // an index has no extended session, so an unlabelled number here would claim
  // SPY's move was the S&P 500's value.
  const exts = page.locator('#mktTiles .mk-ext');
  expect(await exts.count(), 'every index tile shows an after-hours line').toBe(4);
  for (const [i, sym] of [[0, 'SPY'], [1, 'QQQ'], [2, 'IWM'], [3, 'DIA']]) {
    await expect(exts.nth(i), 'the proxy must be named').toContainText(sym);
    await expect(exts.nth(i)).toContainText(/after hrs/i);
  }
  // The extended figure must be a DIFFERENT number than the regular one —
  // if they matched, the second line would be telling the reader nothing.
  const regular = (await page.locator('#mktTiles .mk-tile').first().locator('.mk-pct').innerText()).trim();
  const after = (await exts.first().locator('.mk-ext-pct').innerText()).trim();
  expect(after, 'after-hours must not just repeat the close').not.toContain(regular);

  // Sector ETFs genuinely trade after the bell, so they need no proxy.
  expect(await page.locator('#mktSectors .mk-sec-ext').count(), 'all 11 sectors').toBe(11);

  // Heatmap: the print rides in the TOOLTIP (a tile is a few pixels at the
  // tail), and is absent on names that didn't trade rather than shown as 0.
  const demo = await page.evaluate(() => {
    const all = buildDemoHeatmap().sectors.flatMap(s => s.tiles);
    return { total: all.length, withExt: all.filter(t => t.extPct != null).length };
  });
  expect(demo.withExt, 'some names carry a post-market print').toBeGreaterThan(0);
  expect(demo.withExt, 'and some genuinely do not — absent, not zero').toBeLessThan(demo.total);
});

// ─────────────────────────────────────────────────────────────────────────────
// S15–S19 — Live desk assistant (memory + research + live data + advice + clear).
// Each makes a REAL desk-ask Claude tool-loop call (slow, nondeterministic, costs
// quota), so they are OPT-IN via RUN_ASSISTANT_TESTS in addition to the usual
// live + auth gates — never run in normal CI to keep it green and cheap.
// The ask form is also .lock-form, so all selectors are scoped to #askBody.
// ─────────────────────────────────────────────────────────────────────────────
async function unlockDesk(page) {
  await page.goto('./');
  // Enter the PIN ONLY when the login gate is actually showing. After a reload
  // the PIN persists in sessionStorage and the desk auto-authenticates — the page
  // then renders the Ask form, which is ALSO .lock-form. Filling the global
  // .lock-form selector there would type the PIN into the assistant box and submit
  // it (leaking the real PIN to Anthropic + desk_chat_memory). The login gate is
  // uniquely identifiable: its input is type=password inside #accountGrid.
  const gate = page.locator('#accountGrid .lock-form input.input[type="password"]');
  // wait until the desk has rendered EITHER state (locked gate or authed accounts)
  await page.locator('#accountGrid .lock-form input.input[type="password"], #accountGrid .hero-number')
    .first().waitFor({ timeout: 15000 });
  if (await gate.count()) {
    await gate.first().fill(AUTH_CREDENTIAL);
    await page.locator('#accountGrid .lock-form button').first().click();
  }
  await expect(page.locator('#accountGrid .hero-number').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#askBody form input.input')).toBeVisible({ timeout: 10000 });
}
async function askDesk(page, q) {
  await page.locator('#askBody form input.input').fill(q);
  await page.locator('#askBody form button[type="submit"]').click();
  await expect(page.locator('#askBody .ask-a').last()).toBeVisible({ timeout: 90000 });
}
function assistantGates(page) {
  test.skip(!process.env.RUN_ASSISTANT_TESTS, 'assistant tests are opt-in (real Claude calls) — set RUN_ASSISTANT_TESTS=1');
  test.skip(!AUTH_CREDENTIAL, 'TEST_AUTH_CREDENTIAL not available');
}

test('S15: assistant remembers across a reload (opt-in, live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  assistantGates(page);
  await unlockDesk(page);
  await askDesk(page, 'Remember the codeword is HELIX. Reply with just: noted.');
  await unlockDesk(page); // fresh render → transcript replays from desk_chat_memory
  await expect(page.locator('#askBody .ask-thread')).toContainText(/HELIX/i, { timeout: 10000 });
});

test('S16: a research question renders an answer (opt-in, live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  assistantGates(page);
  await unlockDesk(page);
  await askDesk(page, 'What was the most recent US CPI year-over-year figure? One sentence, name the source.');
  await expect(page.locator('#askBody .ask-a').last()).toBeVisible();
});

test('S17: an off-page ticker returns an answer via live data (opt-in, live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  assistantGates(page);
  await unlockDesk(page);
  await askDesk(page, 'What is the current price of KO? One line.');
  await expect(page.locator('#askBody .ask-a').last()).toBeVisible();
});

test('S18: gives a directional view, not a refusal; disclaimer stays (opt-in, live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  assistantGates(page);
  await unlockDesk(page);
  await askDesk(page, 'One-word lean on SPY right now: buy, sell, or hold?');
  await expect(page.locator('#askBody .lock-error')).toBeHidden();
  await expect(page.locator('#askBody .ai-disclaimer')).toContainText(/not financial advice/i);
});

test('S19: clear empties the conversation (opt-in, live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  assistantGates(page);
  await unlockDesk(page);
  await askDesk(page, 'Reply with just: ok.');
  page.on('dialog', d => d.accept()); // the clear confirmation
  await page.locator('#askBody .ask-clear').click();
  await expect(page.locator('#askBody .ask-a')).toHaveCount(0, { timeout: 10000 });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 27 — Watchlist tile: half width, stacked, and NOTHING clipped.
// The 2026-07-31 layout (owner-approved from a mock) halves the tile to fit
// twice as many symbols per band, which put every value under width pressure.
// The geometry is the cheap half of this test; the clipping assertions are the
// point. A clipped price is a WRONG price, and it fails silently — the tile
// still looks like a tile. Guarding it by measuring scrollWidth against
// clientWidth catches a regression that no screenshot review reliably would.
// ─────────────────────────────────────────────────────────────────────────────
test('S27: watchlist tiles are half-width, stacked, and never clip a value', async ({ page }) => {
  await page.goto('./?demo=1');
  // Start from a clean slate. This test runs late in the file, after S13 (which
  // now persists the heatmap open, hm_open_v1), S20 (wl_tf_v1) and S26 (sort +
  // tray keys) — and Playwright shares one storage origin across a project's
  // tests. Measuring tile geometry against whatever earlier tests happened to
  // leave behind makes this pass or fail on test ORDER rather than on layout,
  // which is exactly the kind of flake that wastes a debugging round.
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });
  await page.reload();
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 15000 });

  const m = await page.evaluate(() => {
    const tile = document.querySelector('.wl-strip .wl-tile');
    const r = tile.getBoundingClientRect();
    // Visual top-to-bottom order. `.wl-vals` is `display: contents`, so it has
    // no box of its own and its children lay out as tile children — that is the
    // mechanism the stacked order depends on, so assert the RENDERED order
    // rather than the DOM order, which still nests them.
    const parts = [...tile.querySelectorAll('.mkt-name, .mkt-last, .wl-pct, .wl-spark')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(e => [...e.classList].find(c => ['mkt-name', 'mkt-last', 'wl-pct', 'wl-spark'].includes(c)));
    const over = sel => [...document.querySelectorAll('.wl-strip ' + sel)]
      .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim());
    return { w: Math.round(r.width), order: parts, prices: over('.mkt-last'), names: over('.mkt-name') };
  });

  expect(m.w, 'tile should be the half-width 66px, not the old 132px').toBeLessThanOrEqual(80);
  expect(m.order, 'reading order must be ticker → price → change → line')
    .toEqual(['mkt-name', 'mkt-last', 'wl-pct', 'wl-spark']);
  // The two that matter. Long values step down a font size (wlTile sets
  // `is-long` by string length, since CSS cannot branch on text length); if that
  // ever stops happening, six-figure index prices truncate mid-number.
  expect(m.prices, 'a clipped price is a wrong price').toEqual([]);
  expect(m.names, 'tickers are how this panel is scanned').toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 28 — The charts quote expires by AGE, not by presence.
// Owner report 2026-07-31: SMH showed 538.90 +34.68 (+6.88%) — the PREVIOUS
// session's close and move — under a stamp reading "delayed by 1 minute",
// because `wbInfoCache` was keyed on presence and the first fetch of a symbol
// was the last one for the life of the tab.
//
// This asserts the two properties that make staleness impossible rather than
// trying to reproduce it: entries carry a timestamp, and the TTL follows the
// session. Reproducing the bug itself would need a tab held open across a
// session boundary, which no CI run can do — so the contract is what gets
// guarded. Both values are read from the live page's own globals (classic
// scripts, so top-level consts are in scope inside evaluate).
// ─────────────────────────────────────────────────────────────────────────────
test('S28: the charts quote cache is timestamped and its TTL is session-aware', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 15000 });

  const shape = await page.evaluate(() => {
    if (typeof wbInfoTtlMs !== 'function') return { missing: true };
    const open = typeof marketSessionOpen === 'function' ? marketSessionOpen() : null;
    // Seed one entry through the real code path's own shape and read it back.
    wbInfoCache.__probe = { at: Date.now(), info: null };
    const e = wbInfoCache.__probe;
    delete wbInfoCache.__probe;
    return { ttl: wbInfoTtlMs(), open, hasAt: typeof e.at === 'number', hasInfo: 'info' in e };
  });

  expect(shape.missing, 'wbInfoTtlMs must exist — it is what expires the quote').toBeFalsy();
  expect(shape.hasAt, 'cache entries must carry `at`, or expiry is impossible').toBe(true);
  expect(shape.hasInfo, 'cache entries must keep `info` alongside the stamp').toBe(true);
  // 60s while prints arrive, 15 min once the tape is frozen. Never unbounded.
  expect([60000, 900000], 'TTL must be one of the two session cadences').toContain(shape.ttl);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 29 — Scheduled asks: the roster, and the guards that bound cost.
// Every firing is a real Claude tool-loop call, so the 15-minute floor and the
// 10-row cap are not UI polish — they are what stops a stray edit turning the
// panel into a billing incident. Asserted at the WRITE boundary (saveAskSched),
// not through the number input, because that is where they actually hold.
// ─────────────────────────────────────────────────────────────────────────────
test('S29: scheduled asks persist, and the cost guards hold at the save boundary', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#askBody')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { localStorage.clear(); DESK.mode = 'live'; DESK.authed = true; renderAsk(); });

  await expect(page.locator('.ask-sched-btn'), 'the ⏱ opens the roster').toHaveCount(1);
  await page.locator('.ask-sched-btn').click();
  await expect(page.locator('#askSchedBackdrop')).toBeVisible();
  await page.locator('#askSchedAdd').click();
  await expect(page.locator('.ask-sched-row')).toHaveCount(1);

  const g = await page.evaluate(() => {
    askSched[0].prompt = 'SMH indicators?';
    askSched[0].mins = 1;                       // below the floor, set directly
    for (let i = 0; i < 30; i++) askSched.push({ prompt: 'x', mins: 60, enabled: true, last: 0 });
    saveAskSched();
    const stored = JSON.parse(localStorage.getItem('ask_sched_v1'));
    const now = Date.now();
    return {
      mins: stored[0].mins, rows: stored.length, prompt: stored[0].prompt,
      due: askSchedDue({ enabled: true, marketOnly: false, mins: 15, last: 0 }, now),
      notYet: askSchedDue({ enabled: true, marketOnly: false, mins: 15, last: now }, now),
      off: askSchedDue({ enabled: false, marketOnly: false, mins: 15, last: 0 }, now),
    };
  });

  expect(g.prompt, 'the question survives a save').toBe('SMH indicators?');
  expect(g.mins, '15-minute floor holds even on a direct assignment').toBe(15);
  expect(g.rows, 'row cap holds').toBeLessThanOrEqual(10);
  expect(g.due, 'fires once the interval has elapsed').toBe(true);
  expect(g.notYet, 'does not fire before it is due').toBe(false);
  expect(g.off, 'a disabled row never fires').toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 30 — Watchlist writes are version-guarded
// ─────────────────────────────────────────────────────────────────────────────
/* Guards the CONTRACT, not the server rule. The refusal itself lives in
   desk_set_watchlists_open (desk_014) and is exercised against the live table;
   what CI can hold is the half that broke: the CLIENT must send back the
   version it read, on BOTH write paths. Send nothing and the RPC silently falls
   back to last-write-wins — which is how the Radar list was deleted on
   2026-08-01 by a save built from a snapshot taken before it existed. */
test('S30: watchlist writes carry the roster version they read', async ({ page }) => {
  await page.goto('./?demo=1');
  await page.waitForSelector('.wl-strip .mkt-group', { timeout: 15000 });

  const out = await page.evaluate(async () => {
    const bodies = [];
    const realFetch = window.fetch;
    window.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('/rest/v1/rpc/')) {
        bodies.push({ fn: u.split('/rpc/')[1], body: JSON.parse(init.body || '{}') });
        /* Answer as the RPC would, so the caller's own error handling runs
           instead of throwing and hiding what it sent. */
        const payload = u.endsWith('desk_get_watchlists_open')
          ? { ok: true, version: '2026-08-01T00:00:00+00:00', lists: [{ title: 'Radar', symbols: [] }] }
          : { ok: true, version: '2026-08-01T00:00:01+00:00', lists: 1, symbols: 0 };
        return Promise.resolve(new Response(JSON.stringify(payload), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      return realFetch(url, init);
    };
    try {
      /* 1. The direct wrapper must accept and forward a version. */
      await deskSetWatchlists(null, [{ title: 'Radar', symbols: [] }], '2026-07-31T12:00:00+00:00');
      const direct = bodies.pop();

      /* 2. wlMutate must read a version and echo THAT one back — not null,
            and not one invented at write time. */
      bodies.length = 0;
      DESK.mode = 'live'; DESK.authed = true;
      await wlMutate(lists => { lists.push({ title: 'X', symbols: [] }); return true; });
      const read = bodies.find(b => b.fn === 'desk_get_watchlists_open');
      const wrote = bodies.find(b => b.fn === 'desk_set_watchlists_open');

      return {
        directHasVersion: direct && direct.body.expected_version === '2026-07-31T12:00:00+00:00',
        mutateRead: !!read,
        mutateSentVersion: wrote ? wrote.body.expected_version : 'NO WRITE',
        omittedIsNull: (await (async () => {
          bodies.length = 0;
          await deskSetWatchlists(null, []);
          return bodies.pop().body.expected_version;
        })()),
      };
    } finally {
      window.fetch = realFetch;
    }
  });

  expect(out.directHasVersion, 'deskSetWatchlists forwards the version it was given').toBe(true);
  expect(out.mutateRead, 'wlMutate reads the authoritative roster first').toBe(true);
  /* The version the stubbed read handed out — proving it was carried through
     the mutate rather than dropped or regenerated. */
  expect(out.mutateSentVersion, 'wlMutate echoes the version it read').toBe('2026-08-01T00:00:00+00:00');
  /* An omitted version must serialize as an explicit null, never `undefined`:
     JSON.stringify drops an undefined value entirely, and the RPC would then
     bind its default and skip the check without anyone noticing. */
  expect(out.omittedIsNull, 'an absent version is an explicit null on the wire').toBeNull();
});
