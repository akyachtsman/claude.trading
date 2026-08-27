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

/* A blocked cross-origin call to the desk's own feed layer.

   One blocked fetch emits a PAIR and only the second names the URL:
     "Origin http://localhost:8080 is not allowed by Access-Control-Allow-Origin…"
     "…/functions/v1/quote-proxy due to access control checks."
   so a feed-origin test alone drops half of it. The first is matched on the
   REFUSED ORIGIN being the one this run is served from — quote-proxy's guard is
   an allowlist holding exactly the Pages origin, so a localhost run is SUPPOSED
   to be refused: the control working, not a defect.

   Deliberately strict, and the reason this is a predicate rather than a regex:
   a message must be CORS-PHRASED **and** name either the feed origin or a LOCAL
   test origin. Everything else still fails. In particular the own-origin half
   never extends to `Failed to load resource` — on a local server a genuinely
   broken asset reference reports the run's own origin too, and swallowing that
   would turn a missing script into a green run.

   `src` is the console location URL when there is one; pageerror carries none,
   which is why it is optional rather than a second predicate. Passing the two
   as one haystack is safe — both halves demand the CORS phrasing first. */
const benignCors = (text, src) => {
  const t = `${text || ''} ${src || ''}`;
  return FEED_CORS.test(text || '') &&
    (t.includes(FEED_ORIGIN) || (LOCAL_ORIGIN && t.includes(OWN_ORIGIN)));
};
/* WebKit raises a blocked cross-origin fetch as a pageerror where Chromium only
   logs it, so this is the iphone project's half of the same rule. */
const benignPageError = (text) => benignCors(text);

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
    /* Counted, not silently dropped: a sweep that quietly stops covering 30
       controls per list reads as "everything passed" when it is not what
       passed. S3 attaches this alongside the element map. */
    window.__clippedSkipped = 0;
    const selectors = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
                       '[role=button]', '[onclick]'];
    return selectors.flatMap(sel =>
      [...document.querySelectorAll(sel)]
        // Index BEFORE filtering: page.locator(sel).nth(i) counts every DOM match,
        // hidden included, so the recorded index must count them too.
        .map((el, index) => ({ el, index }))
        .filter(({ el }) => {
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return false;
          /* Also drop anything CLIPPED OUT of an `overflow: hidden` ancestor.
             Such an element still reports a real rect — it is laid out, just
             not on screen — so the size test above passes and the sweep
             faithfully tries to click something no pointer can reach. Since
             the watchlist columns became paged rather than scrolled
             (2026-08-20) that is ~30 tiles per long list, and against the LIVE
             roster of 12 lists it took S3 from ~2 minutes to past its 480s
             timeout on both projects, which then blew the job's own 20-minute
             budget. Each one costs a full action timeout, and Playwright's
             scroll-into-view shifts the column under every other queued handle
             while it tries.
             Deliberately `hidden`/`clip` ONLY. An `auto`/`scroll` ancestor —
             the news reel, the ask thread — CAN be scrolled to the element, and
             those have always swept fine; excluding them too would quietly drop
             real coverage. */
          for (let p = el.parentElement; p; p = p.parentElement) {
            const o = getComputedStyle(p);
            const hides = /hidden|clip/.test(o.overflowY) || /hidden|clip/.test(o.overflowX);
            if (!hides) continue;
            const b = p.getBoundingClientRect();
            if (r.bottom <= b.top || r.top >= b.bottom || r.right <= b.left || r.left >= b.right) {
              window.__clippedSkipped++;
              return false;
            }
          }
          return true;
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
  /* TEST_AUTH_EMAIL IS PLUMBED THROUGH BUT NOT WIRED IN THIS KIT — say so, loudly.

     qa.yml / qa-live.yml / qa-response.yml all pass `test-auth-email` into the
     ui-suite composite, which exports TEST_AUTH_EMAIL into this process
     (directives#304). Nothing here reads it: detectAuthGate() does not look for
     input[type=email] and detectAndAuth() is handed only the credential.

     Upstream's S2 rewrite carries the identifier-first logic. This repo took the
     fails-open DEFECT fix from it and not the helper layer, deliberately — and
     that decision is what leaves this input inert, so this guard is its cost,
     paid openly rather than left as a trap.

     Porting the logic instead would be dead code: this desk's only gate is a
     6-digit PIN in .lock-form, single-step, with no identifier screen to detect.

     So the failure mode Codex named (#283 P2) is real but narrow — set the
     secret expecting split-step support and you get the password-only path with
     no indication. Throwing converts that into a message naming the exact cause.
     It fires BEFORE the credential skip on purpose: TEST_AUTH_EMAIL set without
     TEST_AUTH_CREDENTIAL would otherwise skip this scenario and report nothing. */
  if ((process.env.TEST_AUTH_EMAIL ?? '').trim()) {
    throw new Error(
      'S2 FAIL | TEST_AUTH_EMAIL is set, but this test kit has no identifier-first ' +
      '(split-step) login path — detectAuthGate() ignores input[type=email] and ' +
      'detectAndAuth() receives only the credential. Setting it therefore changes ' +
      'nothing and the suite silently stays on the password-only path. This desk ' +
      "uses a single-step PIN gate, so there is no identifier screen to reach: " +
      'unset the TEST_AUTH_EMAIL secret. If the desk ever gains an email step, ' +
      "port upstream's identifier-first detection before re-setting it."
    );
  }
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

  /* S2 MUST DISCRIMINATE — it used to fail OPEN. Ported from the upstream kit
     (claude.directives, 2026-08-26) as the defect only, not the rewrite: taking
     upstream's S2 whole would pull in awaitAuthReady/watchPageErrors/
     credentialFor and the split-step login discovery, which is the take-the-kit-
     wholesale move the refresh rules forbid for this per-project file.

     The defect: a credential IS configured (we did not skip at the top), yet no
     gate was found — so `mechanism` is 'none', every assertion above is skipped,
     and the scenario passes having exercised no authentication at all. That is
     the same shape as a guard that fails open: indistinguishable in the output
     from a real pass.

     This desk HAS a gate (the PIN lock) and the credential is set in CI, so this
     never fires today — which is exactly why it is worth adding. It fires the
     day gate detection silently breaks, instead of going green. */
  if (mechanism === 'none') {
    throw new Error(
      'S2 FAIL | a credential is configured but NO auth gate was found. ' +
      'This desk has a PIN lock, so either detectAuthGate() has stopped seeing ' +
      'it or the lock stopped rendering. Passing here would mean reporting green ' +
      'on authentication that was never exercised.'
    );
  }

  // Auth passed — record mechanism
  test.info().attach('auth-result', {
    body: JSON.stringify({ mechanism, domChanged }),
    contentType: 'application/json',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 3 — Element Mapping & Interaction Sweep
// ─────────────────────────────────────────────────────────────────────────────
test('S3: interactive elements discovered and exercised without errors', async ({ page }) => {
  // The sweep scales with ELEMENT COUNT (settle + capped idle wait per
  // element), and element count scales with VIEWPORT WIDTH — a wider layout
  // exposes more controls to discover and click. So this budget is driven by
  // the widest project in the matrix, not by the app.
  //
  // ⚠️ 900s, and the margin is deliberate. At 480s this measured 7.8m on both
  // phone projects — 97.5% of its own budget — and passed, while the tablet
  // project crossed it and failed at 8.1m with "Test timeout of 480000ms
  // exceeded" (CI run 32655955615, the first run after desktop+tablet were
  // added). Nothing was wrong with the app: three of four projects passed the
  // same assertions. The bound was simply sized against a two-phone matrix and
  // never revisited when wider viewports arrived.
  //
  // Do NOT tune this back down to just-above-observed. A bound set at ~1.03x
  // the work it bounds is what produced the failure above, and it fails on a
  // schedule rather than on a defect — the same shape as the 40-minute job
  // ceiling this suite also outgrew. 900s is ~1.9x the measured worst case.
  //
  // The projects run in parallel, so this does not multiply into wall-clock:
  // the full 4-project run measured 29.5m against a 60-minute job bound.
  test.setTimeout(900_000);
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
    /* The rule above demands the FEED ORIGIN appear in the text or the location,
       which the first message of WebKit's CORS pair supplies in neither — it
       names only the refused origin. So `[iphone]` failed on 2026-08-01 against
       0bfb372 on exactly what `[mobile-chrome]` was dropping, one layer below
       the pageerror drift fixed earlier that day: the shared rule had been
       applied to the pageerror listener and not to its console twin. Reuse the
       predicate rather than restating it — that restating is the whole bug. */
    if (benignCors(text, src)) return;
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
  const clippedSkipped = await page.evaluate(() => window.__clippedSkipped || 0);
  test.info().attach('element-map', {
    body: JSON.stringify({ swept: elements.length, clippedSkipped, elements }, null, 2),
    contentType: 'application/json',
  });
  // Named out loud rather than left in the attachment alone — these are real
  // controls the sweep did not exercise, and the number moving is the signal
  // that a panel started hiding things.
  if (clippedSkipped) console.log(`S3: ${clippedSkipped} control(s) clipped out of an overflow:hidden box — not swept`);

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
  // Positions collapse closed by default (2026-08-07, the accounts-area cut),
  // so the table has to be disclosed before it can be sorted. Asserting the
  // toggle is CLOSED first is the point: it guards the cut itself, and a
  // regression that reopened positions by default would silently give the
  // accounts area its 176px back.
  const posBtn = page.locator('#accountGrid .acct-pos-toggle').first();
  await expect(posBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#accountGrid table').first()).toBeHidden();
  await posBtn.click();
  const table = page.locator('#accountGrid table').first();
  await expect(table).toBeVisible();
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
  /* STALE is a THIRD legitimate state for a few minutes after the closing bell,
     and this canary asserted only two — so any run crossing 16:00 ET failed here
     on whichever projects happened to execute after it. main went red on 1e3db75
     exactly that way: desktop and tablet ran S14 at 19:50Z and read LIVE, while
     mobile-chrome and iphone ran at 20:00:29Z and 20:02:08Z — 29 seconds and two
     minutes past the close — and read STALE. Same commit, same code; the only
     variable was the clock.
     The lamp is RIGHT and the assertion was wrong. liveLampFor refuses to claim
     EOD while the newest snapshot still predates the close instant, because EOD
     asserts the number IS the closing print and desk-market is briefly still
     serving a body it cached at 15:59 (scripts/data.js, Codex review PR #193).
     Its own comment calls STALE "the honest one" for that state.
     The tolerance is bounded by the desk's OWN concept — withinCloseSettleGrace,
     the 15-minute window in which desk-market polls every minute to pick up the
     settle print — rather than some duration invented here. OUTSIDE that window
     STALE still fails loudly, which is the entire point of the canary: do not
     widen this to accept STALE unconditionally.
     The window is evaluated PER ATTEMPT, against the instant the lamp was
     actually read — never chosen once up front. Two earlier cuts got this
     wrong and both are worth recording, because the second failed in the more
     dangerous direction:
       - a 20s assertion followed by a re-check inside a catch. That overran the
         30s per-test budget and the page was torn down mid-evaluate.
       - selecting the matcher once from EITHER endpoint, `withinCloseSettleGrace()
         || withinCloseSettleGrace(now + 20s)`, to cover the bell passing mid-wait.
         That PRE-AUTHORISES STALE: in the last 20 seconds before 16:00 ET the
         future operand is already true while the market is still OPEN, so a
         genuinely stalled open-hours feed matches the permissive pattern
         immediately and the canary reports a FALSE SUCCESS — the bell never has
         to pass at all. (Verified: at 15:59:45 ET now=false, now+20s=true.) The
         same cached boolean also stays permissive if polling runs past 16:15.
         A canary that passes while the feed is dead is worse than one that
         fails spuriously, which is what makes this the wrong trade (Codex P2).
     Coupling acceptance to the observation's own instant fixes both: STALE is
     accepted only when the desk is in the settle window at the moment it was
     read, and the retry loop still tolerates the bell passing mid-wait because
     a later attempt re-evaluates.
     THE WINDOW ALONE IS NOT ENOUGH, though (Codex P2, round 2). Inside 16:00-16:15
     a STALE lamp has two very different causes and only one is benign: a HEALTHY
     feed whose newest quote happens to predate the close, or a feed that actually
     died earlier — one that stopped at 15:45 shows the same unchanged STALE and
     would sail through, which is precisely the outage this canary exists to
     catch. So the exception additionally requires the POLLER to be alive, tested
     on DESK.liveStamp.generatedAt — the very value the masthead lamp is built
     from (scripts/app.js, the liveLampFor call) — against the desk's own
     freshness bound rather than one invented here: liveLampFor calls a feed fresh
     at generatedAt age <= 6 minutes (scripts/data.js). Benign case passes (the
     poller is running, it simply has no post-close print yet); real outage fails,
     window or no window. */
  const SETTLE_POLL_MS = 20000;
  const LAMP_FRESH_MS = 6 * 60000;   // mirrors liveLampFor's own freshness bound
  await expect(async () => {
    const text = ((await lamp.textContent()) || '').trim();
    if (/^(LIVE|EOD)$/.test(text)) return;
    const settling = text === 'STALE' && await page.evaluate((freshMs) => {
      if (typeof withinCloseSettleGrace !== 'function' || !withinCloseSettleGrace()) return false;
      const gen = typeof DESK !== 'undefined' && DESK.liveStamp && DESK.liveStamp.generatedAt;
      const age = gen ? Date.now() - new Date(gen).getTime() : NaN;
      return Number.isFinite(age) && age <= freshMs;
    }, LAMP_FRESH_MS);
    if (settling) return;
    throw new Error('desk lamp reads "' + text + '" — live feed unreachable or stale '
      + '(check desk-market). STALE passes only inside withinCloseSettleGrace() AND '
      + 'with a poller that is still fetching.');
  }).toPass({ timeout: SETTLE_POLL_MS });
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
  for (const cap of ['PRO 1 · LONG-TERM', 'PRO 2 · SWING', 'PRO 3 · DAY TRADING']) {
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
  // The rail is TWO columns since 2026-08-17, and a typed roster ticker lands in
  // BOTH — the manual stack it was typed into and the roster it already belongs
  // to. Two current markers is correct here rather than a bug: they are separate
  // sets, and each marks its own current item. So assert what actually matters —
  // at least one marker exists and EVERY one of them names the picked symbol.
  // That is strictly stronger than the single-rail assertion it replaces, which
  // could not have caught a stale marker left on another symbol.
  const railCurrent = page.locator('#wbSidebar button[aria-current="true"]');
  await expect(railCurrent.first()).toContainText('QQQ');
  const currentLabels = await railCurrent.allTextContents();
  expect(currentLabels.length, 'the picked symbol is marked in the rail').toBeGreaterThan(0);
  for (const label of currentLabels) {
    expect(label, 'no stale current marker on another symbol').toContain('QQQ');
  }

  // pane layout seg maximizes a single tier and returns to split
  /* THE HEADER BARS MUST SIT ABOVE THEIR OWN PANES. Each bar's zoom seg, lock
     and gear mutate the config named by its ID, so a bar over the wrong chart
     silently retimes the wrong pane — and that is not hypothetical: reordering
     the panes without reordering these bars left the LEFT header driving the
     SWING config while attached to the LONG-TERM chart (Codex P1). The previous
     S12 missed it because it only checked that clicking #chartZoom changed the
     chart's rect count, which is true whichever pane it retimed.
     Asserted three ways: the visible tags read PRO 1/2/3 in DOM order; the FIRST
     bar is the long-term one (id wbBar-p2, the deliberate label/id crossing);
     and that first bar owns #chartZoom2, the control that drives the long-term
     window — which is what actually proves the leftmost controls belong to the
     leftmost chart. */
  const bars = await page.evaluate(() => [...document.querySelectorAll('#wbPaneBars .wb-pane-bar')]
    .map(b => ({ id: b.id, tag: b.querySelector('.wb-seg-tag')?.textContent.trim(),
                 segs: [...b.querySelectorAll('.seg')].map(s => s.id) })));
  expect(bars.map(b => b.tag), 'header bars are numbered left to right').toEqual(['PRO 1', 'PRO 2', 'PRO 3']);
  expect(bars.map(b => b.id), 'the long-term bar (wbBar-p2) leads, matching the pane order')
    .toEqual(['wbBar-p2', 'wbBar-p1', 'wbBar-p3']);
  expect(bars[0].segs, 'the leftmost bar owns the LONG-TERM zoom control, not the swing one')
    .toContain('chartZoom2');

  /* The seg label is POSITIONAL, so "Pro 2" maximises the SWING pane — which
     is cfg.p1. That crossing is deliberate and lives in wireCharts; asserting
     it here is what proves the seg follows the on-screen numbering rather than
     the config key. */
  await page.locator('#chartLayout button', { hasText: 'Pro 2' }).click();
  await expect(chart).not.toContainText('PRO 1 · LONG-TERM');
  await expect(chart).toContainText('PRO 2 · SWING');
  await page.locator('#chartLayout button', { hasText: 'Split' }).click();
  await expect(chart).toContainText('PRO 1 · LONG-TERM');

  // per-pane header bars: each gear opens its own popover above its pane.
  // The weekly-stoch overlay toggle now lives on Pro 2 ALONE (owner ruling
  // 2026-07-17); Pro 1/Pro 3 show only their native stochastic.
  // Pro 1 = full set (bb, vol, stoch, 5 SMAs, 3 S/R = 11 boxes + 2 style
  // radios); Pro 3 = slim day-trading panel (bb, vol, stoch) PLUS the
  // Session -> Extended hours toggle (owner request 2026-07-29) = 4 boxes.
  // Pro 3 alone gets that toggle: it is the only intraday tier.
  // 16 -> 11 on 2026-08-08: the SMA price display group (5 boxes, a price tag
  // at each enabled SMA's right edge) was removed from all three panes by owner
  // request. The group's ABSENCE is asserted by name below, so a silent return
  // of the feature fails here rather than only moving a count nobody reads.
  await page.locator('#wbGear-p1').click();
  await expect(page.locator('#wbSettings-p1')).toBeVisible();
  expect(await page.locator('#wbSettings-p1 input[type=radio]').count()).toBe(2);
  expect(await page.locator('#wbSettings-p1 input[type=checkbox]').count()).toBe(12);
  /* 12 rather than 11 since "S/R from → Prior peaks & troughs" was added. The
     count alone is a magic number nobody reads, so the control is also
     asserted BY NAME and by default state: it must be OFF, because pivots
     measure better (+8.34 vs +6.58 like-for-like) and this is an opt-in for
     reading the chart the way the reference terminal frames it. A default
     flipped by accident would silently change what every S/R line means. */
  const srSrc = page.locator('#wbSettings-p1 label', { hasText: 'Prior peaks & troughs' });
  await expect(srSrc).toBeVisible();
  expect(await srSrc.locator('input[type=checkbox]').isChecked(),
    'prior-peaks S/R is opt-in — pivots remain the default').toBe(false);
  // the SMA LINES stay — only their price tags went
  await expect(page.locator('#wbSettings-p1', { hasText: 'Moving averages' })).toBeVisible();
  expect(await page.locator('#wbSettings-p1 .wb-set-group', { hasText: 'SMA price display' }).count(),
    'SMA price display was removed from every pane').toBe(0);
  await page.locator('#wbGear-p3').click();
  await expect(page.locator('#wbSettings-p1')).toBeHidden();
  expect(await page.locator('#wbSettings-p3 input[type=checkbox]').count()).toBe(4);
  // The extended-hours control is present, OFF by default, and actually toggles.
  // Off since 2026-08-20 — owner: "remove the off market candles, I just wanna
  // see open sessions candles in pro three". It was on from 2026-07-29 until
  // then, and this assertion carried that default; it is the default that
  // changed, not the control. Asserting the state in BOTH directions is what
  // makes this a test of the toggle rather than of whichever default is current.
  const ext = page.locator('#wbSettings-p3 label', { hasText: 'Extended hours' });
  await expect(ext).toBeVisible();
  const extBox = ext.locator('input[type=checkbox]');
  await expect(extBox, 'extended hours is off by default').not.toBeChecked();
  await extBox.check();
  await expect(extBox, 'and the toggle turns it on').toBeChecked();
  await extBox.uncheck();
  await expect(extBox, 'and off again').not.toBeChecked();
});

// S13 — Heatmap MAP FILTER rail: index cuts re-render the treemap, the ETF cut
// draws one tile per banded ETF and unlocks multi-period performance,
// unfetched feeds stay disabled.
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

  // ETF map: its own desk-heatmap universe since 2026-08-06 (was assembled
  // client-side from the charts payload, which could only draw the names that
  // panel happened to carry — 25 of 35 banded ETFs, for its whole life).
  //
  // The assertion that guards that bug is EVERY BANDED ETF GETS A TILE, read
  // off the dataset rather than counted in the SVG: tiles are bare <rect>s
  // with no class, sub-3px tiles are skipped by design, and the gloss overlay
  // adds a second rect per tile — so a DOM count would be both ambiguous and
  // flaky at small viewports, exactly where a dropped tile matters least and a
  // false failure matters most.
  await page.locator('.map-filter-btn', { hasText: 'ETFs' }).click();
  await expect(page.locator('#heatTitle')).toContainText('ETFs');
  await expect(svg.locator('rect').first()).toBeVisible();
  const etf = await page.evaluate(() => ({
    roster: Object.keys((mapView.filters || {}).etfCats || {}).length,
    tiles: heatEtf ? heatEtf.hm.sectors.reduce((a, s) => a + s.tiles.length, 0) : 0,
    bands: heatEtf ? heatEtf.hm.sectors.map(s => s.name) : [],
    withPeriods: heatEtf
      ? heatEtf.hm.sectors.reduce((a, s) => a + s.tiles.filter(t => Number.isFinite(t.pctW)).length, 0)
      : 0,
  }));
  expect(etf.roster, 'etfCats roster must be non-empty').toBeGreaterThan(0);
  expect(etf.tiles, 'every banded ETF must get a tile — this is the 2026-08-06 fix')
    .toBe(etf.roster);
  // No catch-all band. The old client build grouped unknown symbols under a
  // literal 'ETFs' bucket, so a roster/band mismatch hid inside a junk drawer
  // instead of failing visibly.
  const known = await page.evaluate(() => [...new Set(Object.values((mapView.filters || {}).etfCats || {}))]);
  expect(etf.bands.filter(b => !known.includes(b)), 'no catch-all band').toEqual([]);
  expect(etf.withPeriods, 'ETF tiles must carry sweep periods').toBe(etf.roster);

  expect(await periodOpts.nth(2).isDisabled(), '1-Month must be enabled on the ETF cut').toBe(false);
  await page.locator('#heatPeriod').selectOption('1m');
  await expect(page.locator('#heatSource')).toContainText(/1-month/i);
  await expect(page.locator('#heatSource')).toContainText(/dollar volume/i);
  await page.locator('#heatPeriod').selectOption('1d');

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
// Delete is gated on the arrangement lock (owner ruling 2026-08-01, revising
// the first cut, which left it ungated behind its confirm dialog). Creating a
// list is not — the lock covers arrangement and the one irreversible act.
//
// The duplicate-name refusal is the load-bearing assertion here, and it is NOT
// cosmetic: wlPick() resolves a list by title whenever its index has shifted,
// and gives up unless exactly one matches. Two lists sharing a name would make
// every add, remove and drop into either of them silently unaddressable.
test('S31: create and delete a list; delete is behind the lock', async ({ page }) => {
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
      // LOCKED: the × must be disabled, and the guard must hold even when the
      // dialog is opened directly — a disabled button is a hint, not the rule
      // (owner ruling 2026-08-01).
      wlLocked = true;
      renderWatchlist();
      r.lockedDisabled = document.querySelectorAll('.wl-del')[0].disabled;
      r.lockedNewListStillOffered = !document.getElementById('wlNewListBtn').hidden;
      openWlDelList(0, store[0].title, null);
      r.lockedDialogRefused = document.getElementById('wlDelBackdrop').hidden;
      wlLocked = false;
      renderWatchlist();

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
  expect(out.lockedDisabled, 'the × must be disabled under the lock').toBe(true);
  expect(out.lockedDialogRefused, 'and the dialog must refuse to open even when called directly').toBe(true);
  expect(out.lockedNewListStillOffered, 'the lock covers destruction, not creating a list').toBe(true);
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

  /* A lone single click DOES open the symbol detail window now (owner request
     2026-08-06, S35) — its backdrop then covers the panel, so it has to be
     dismissed before the tile can be reached again. Asserted rather than merely
     stepped past: this is a real consequence of the gesture, and a silent
     `Escape` here would hide it if the window ever stopped opening. */
  await expect(page.locator('#wlDetailBackdrop'), 'a lone click opens the detail window').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlDetailBackdrop')).toBeHidden();

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
  // Scroll it into view before taking coordinates. boundingBox() is
  // VIEWPORT-relative, and the Watchlists panel moved from the top of the page
  // to just above the charts (2026-08-17) — on a phone viewport its tiles now
  // sit thousands of pixels down, so page.mouse.move() to those coordinates
  // lands nowhere and no drag ever starts. toBeVisible() does not catch this:
  // an element below the fold is still "visible" to Playwright.
  await tile.scrollIntoViewIfNeeded();
  let r = await tile.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  // Relative to the CENTRE the pointer is actually on, not to the tile's
  // corner. `r.x + 40, r.y + 30` was a 7.6px move away from a 66px tile's
  // centre — barely over the 6px WL_DRAG_SLOP — so when the tile grew to 74px
  // for the column layout the same target became a 3.4px move and the drag
  // never began. The assertion then failed for a reason that had nothing to do
  // with what it was testing. An offset from the grab point says "drag it a
  // clear distance" and stays true whatever the tile measures.
  await page.mouse.move(r.x + r.width / 2 + 40, r.y + r.height / 2 + 30, { steps: 6 });
  expect(await page.locator('.wl-ghost').count(), 'no drag begins under a sort key').toBe(0);
  expect(await page.evaluate(() => wlSort.key), 'the drag snapped the sort to Manual').toBe('manual');
  await expect(page.locator('#wlNote')).toContainText(/Manual/i);
  await page.mouse.up();

  // ── a real drag, now that Manual is active ──────────────────────────────
  // The drop target is CHOSEN IN THE PAGE, not computed from bounding boxes.
  // Since lists became vertical columns a band can be taller than the viewport,
  // so a fixed offset into "the next band" lands off-screen — elementFromPoint
  // returns null, no drop zone is found, and the marker assertion fails for a
  // reason unrelated to what it tests. That is also true of the real gesture:
  // you cannot drag to somewhere you cannot see.
  // Picking the point by asking the DOM what is actually under it makes this
  // independent of viewport height, which matters because the two mobile
  // projects differ by ~60px and a hand-tuned offset passes on one and fails on
  // the other. The point returned is guaranteed to hit a band that is not the
  // source's, or the test says so plainly instead of failing downstream.
  // Scroll to the BOUNDARY between two bands first. On a phone a single list can
  // be ~700px tall in a 664px viewport — that is the content, not the styling:
  // at 390px only about four sub-columns fit across, so a 41-symbol list cannot
  // be shorter without overflowing sideways. So no two whole bands are ever on
  // screen together there, and the drag has to happen where they meet: the last
  // tile of one band into the top of the next.
  await page.locator('.mkt-group-tiles[data-band]').nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  // BOTH ENDS are chosen by hit-testing the page, not from bounding boxes.
  // Two reasons, both learned the hard way. A band can now be taller than the
  // viewport — on a phone a single list runs ~700px in a 664px window, which is
  // the content rather than the styling, since at 390px only about four
  // sub-columns fit across and a 41-symbol list cannot be shorter without
  // overflowing sideways. And because the tiles WRAP into sub-columns, the last
  // tile in DOM order sits at the foot of the last sub-column, which is not the
  // lowest point on screen — picking it by index put the grab off-screen and no
  // drag began at all. Asking the DOM what is actually under a point is the only
  // form that holds on both mobile projects, whose viewports differ by ~60px.
  const pts = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const visible = (el) => {
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < 0 || x > vw || y < 0 || y > vh) return null;
      const hit = document.elementFromPoint(x, y);
      return hit && el.contains(hit) ? { x, y } : null;
    };
    const zones = [...document.querySelectorAll('.mkt-group-tiles[data-band]')];
    for (const z of zones) {
      const tile = [...z.querySelectorAll('.wl-tile')].map(visible).find(Boolean);
      if (!tile) continue;
      for (const other of zones) {
        if (other === z) continue;
        const b = other.getBoundingClientRect();
        for (const fy of [0.5, 0.2, 0.8, 0.05, 0.95]) {
          const y = b.top + b.height * fy, x = b.left + Math.min(30, b.width / 2);
          if (x < 0 || x > vw || y < 0 || y > vh) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit && hit.closest('.mkt-group-tiles[data-band]') === other) {
            return { from: tile, to: { x, y } };
          }
        }
      }
    }
    return null;
  });
  expect(pts, 'a tile and a different band are both on screen for the drag').not.toBeNull();
  await page.mouse.move(pts.from.x, pts.from.y);
  await page.mouse.down();
  await page.mouse.move(pts.from.x + 40, pts.from.y + 20, { steps: 5 });
  await page.mouse.move(pts.to.x, pts.to.y, { steps: 8 });
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
  await page.locator('.mkt-group-tiles[data-band] .wl-tile').first().scrollIntoViewIfNeeded();
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
test('S25: long-term candles follow the weekly stochastic; swing follows open/close', async ({ page }) => {
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
      /* Located by DOCTRINE NAME, never by the pane number. The number is
         positional and the panes were reordered on 2026-08-25 (long-term first);
         matching /^PRO 2/ silently pointed these probes at the wrong pane, which
         is how a rule about the weekly stochastic came to be checked against the
         swing pane. The doctrine name is the stable identity. */
      weekly: read(/LONG-TERM/, /CANDLE COLOUR/),     // the rule
      daily: read(/LONG-TERM/, /· DAILY$/),           // must NOT be what drives it
      swing: read(/SWING/, /· DAILY$/),               // must still follow price
    };
  });

  for (const [key, r] of Object.entries(probe)) expect(r.err, `${key} located`).toBeUndefined();
  expect(probe.weekly.agree, 'long-term candles sampled').toBeGreaterThan(40);
  expect(probe.swing.agree + probe.swing.disagree, 'swing candles sampled').toBeGreaterThan(20);

  // Pro 2: EVERY candle must match the WEEKLY crossover — no exceptions.
  expect(probe.weekly.disagree, 'every long-term candle matches the weekly %K vs %D').toBe(0);

  // ...and must NOT be explainable by the fast daily strip in the same pane —
  // otherwise this passes whichever series the code happens to use.
  expect(probe.daily.disagree, 'long-term colour is the weekly series, not the daily one')
    .toBeGreaterThan(probe.daily.agree * 0.2);

  // Pro 1 is the control: it follows open/close, so it must contradict its own
  // stochastic on a real share of bars. Zero here would mean the rule leaked.
  expect(probe.swing.disagree, 'the swing pane still follows open/close, not the stochastic')
    .toBeGreaterThan(probe.swing.agree * 0.1);
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

  // Sector ETFs genuinely trade after the bell, so they need no proxy, and the
  // print is VISIBLE on every row — it was briefly tooltip-only while the
  // column was 258px, and the column was widened to 311px (2026-08-07)
  // specifically to bring it back, so a regression to the tooltip would undo
  // the width as well as the number.
  const secRows = page.locator('#mktSectors .mk-sec');
  expect(await secRows.count(), 'all 11 sectors render').toBe(11);
  expect(await page.locator('#mktSectors .mk-sec-ext').count(),
    'every sector shows its own after-hours move').toBe(11);
  // The whole point of the widening is that BOTH fit: a sparkline on every row
  // and the after-hours figure beside the day-%. Losing either silently is the
  // regression this guards.
  expect(await page.locator('#mktSectors .mk-sec .wl-spark').count(),
    'and keeps its sparkline').toBe(11);
  // Nothing may be clipped to make that fit — a crushed label is how the first
  // attempt failed, and it fails silently.
  const clipped = await page.evaluate(() => [...document.querySelectorAll('#mktSectors .mk-sec *')]
    .filter(e => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0).length);
  expect(clipped, 'no sector row element is clipped').toBe(0);

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
// SCENARIO 29 — Scheduled asks: the roster round-trips to the SERVER, and the
// guards that bound cost hold at the write boundary.
//
// The roster moved out of localStorage into desk_ask_schedule (desk_017) so
// pg_cron could fire it with the page shut — which makes `id` load-bearing in
// exactly the way the watchlist's `version` is (S30). The write is an
// upsert-by-id and the cron stamps `last_run_at` on those same rows, so a save
// that dropped the id would INSERT a duplicate and reset the timer, re-firing
// whatever was already answered today. Exercised against a stateful fake store,
// since the real refusal lives in the RPC.
// ─────────────────────────────────────────────────────────────────────────────
test('S29: the scheduled-ask roster round-trips by id, and the row cap holds', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#askBody')).toBeVisible({ timeout: 15000 });

  // Demo has no backend to write to, so no roster control is offered at all.
  await expect(page.locator('.ask-sched-btn'), 'no ⏱ in demo').toHaveCount(0);

  await page.evaluate(() => {
    let seq = 1;
    window.__store = [];
    window.__writes = [];
    window.deskGetAskSchedule = async () => ({ ok: true, rows: window.__store.map(r => ({ ...r })) });
    window.deskSetAskSchedule = async (_pin, rows) => {
      window.__writes.push(JSON.parse(JSON.stringify(rows)));
      const next = [];
      for (const r of rows.slice(0, 10)) {
        if (!String(r.prompt || '').trim()) continue;
        const known = r.id != null && window.__store.some(s => s.id === r.id);
        const id = known ? r.id : seq++;
        const prev = window.__store.find(s => s.id === id);
        // The real RPC updates in place and never touches the timer.
        next.push({ ...r, id, lastRunAt: prev ? prev.lastRunAt : null, lastStatus: prev ? prev.lastStatus : null });
      }
      window.__store = next;
      return { ok: true, rows: next.length };
    };
    DESK.mode = 'live'; DESK.authed = true; renderAsk();
  });

  await expect(page.locator('.ask-sched-btn'), 'the ⏱ opens the roster in live mode').toHaveCount(1);
  await page.locator('.ask-sched-btn').click();
  await expect(page.locator('#askSchedBackdrop')).toBeVisible();
  await expect(page.locator('#askSchedList .lock-explain'), 'an empty roster says so').toHaveText(/Nothing scheduled/);

  await page.locator('#askSchedAdd').click();
  await expect(page.locator('.ask-sched-row')).toHaveCount(1);
  await page.locator('.ask-sched-q').fill('Summarise the market and my watchlist');

  // A daily row offers a clock; an at-the-hour cadence offers minutes only —
  // a clock there would let you set 08:00 and watch it fire at midnight.
  await expect(page.locator('.ask-sched-time'), 'daily gets a clock').toHaveCount(1);
  await page.locator('.ask-sched-cad').selectOption('h4');
  await expect(page.locator('.ask-sched-time'), 'every-4-hours has no meaningful hour').toHaveCount(0);
  await expect(page.locator('.ask-sched-min'), 'it gets a minutes-past-the-hour picker').toHaveCount(1);
  await page.locator('.ask-sched-cad').selectOption('daily');
  await page.locator('.ask-sched-time').fill('08:00');

  await page.locator('#askSchedSave').click();
  await expect(page.locator('#askSchedNote')).toHaveText('Saved');

  const first = await page.evaluate(() => ({
    stored: window.__store.length,
    id: window.__store[0].id,
    prompt: window.__store[0].prompt,
    cadence: window.__store[0].cadence,
    atHour: window.__store[0].atHour,
    sentId: window.__writes[0][0].id,
    drawn: askSched[0].id,
  }));
  expect(first.stored, 'the row reached the store').toBe(1);
  expect(first.prompt).toBe('Summarise the market and my watchlist');
  expect(first.cadence).toBe('daily');
  expect(first.atHour, '08:00 PT is what was set').toBe(8);
  expect(first.sentId, 'a brand-new row has no id to send').toBeNull();
  expect(first.drawn, 'the saved id is read back, or the next save inserts a twin').toBe(first.id);

  // A second save of the SAME row must carry its id back, not mint another.
  await page.locator('.ask-sched-q').fill('Summarise the market, my watchlist and the heatmap');
  await page.locator('#askSchedSave').click();
  await expect(page.locator('#askSchedNote')).toHaveText('Saved');
  const second = await page.evaluate(() => ({
    stored: window.__store.length,
    id: window.__store[0].id,
    sentId: window.__writes[1][0].id,
  }));
  expect(second.sentId, 'an existing row sends its id').toBe(first.id);
  expect(second.stored, 'an edit updates in place').toBe(1);
  expect(second.id, 'and keeps its identity, so its timer survives').toBe(first.id);

  // The 10-row cap is a cost guard: every firing is a real Claude tool loop.
  // Asserted on a DIRECT assignment, because that is where it has to hold —
  // not only when the rows came through the + button.
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) askSched.push(askSchedRow({ prompt: 'row ' + i, cadence: 'daily' }));
  });
  await page.locator('#askSchedSave').click();
  await expect(page.locator('#askSchedNote')).toHaveText('Saved');
  const capped = await page.evaluate(() => ({ sent: window.__writes[2].length, stored: window.__store.length }));
  expect(capped.sent, 'the cap holds on the wire, not just server-side').toBeLessThanOrEqual(10);
  expect(capped.stored, 'and in the store').toBeLessThanOrEqual(10);

  // Closing with unsaved edits must not discard them silently — the first ✕
  // warns, the second obeys.
  await page.locator('.ask-sched-q').first().fill('an unsaved edit');
  await page.locator('#askSchedCloseBtn').click();
  await expect(page.locator('#askSchedBackdrop'), 'the first ✕ warns instead of discarding').toBeVisible();
  await expect(page.locator('#askSchedNote')).toHaveText(/Unsaved changes/);
  await page.locator('#askSchedCloseBtn').click();
  await expect(page.locator('#askSchedBackdrop')).toBeHidden();
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

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 32 — Interrupting a question in flight (owner request 2026-08-01).
// The desk-ask tool loop can run to 12 tool calls, so "wait it out" is not an
// answer. Stop severs THIS TAB's wait only — the server run completes and its
// answer still reaches desk_chat_memory — so the two things that must hold are
// that the composer comes back immediately, and that the thread SAYS the answer
// is still coming. A silent stop would look like a lost question on reload.
// ─────────────────────────────────────────────────────────────────────────────
test('S32: a question can be interrupted, and the stop is not silent', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#askBody')).toBeVisible({ timeout: 15000 });

  // Demo has no backend to ask, so no Stop should exist to press.
  await expect(page.locator('.ask-stop'), 'no Stop in demo — there is nothing in flight').toHaveCount(0);

  /* Forced live+authed with deskAsk replaced by a request that never settles on
     its own, so the ONLY way out is the abort — exactly the state the owner is
     in when a research question stalls. The stub honours the signal itself
     because that is the contract runAsk depends on. */
  await page.evaluate(() => {
    DESK.mode = 'live'; DESK.authed = true;
    sessionStorage.setItem('desk_pin', '0000');
    /* renderAsk holds the composer disabled until the stored conversation
       replays, so the history RPC is stubbed empty — otherwise this test waits
       on a real backend call it is not about. */
    window.deskChatHistory = () => Promise.resolve([]);
    window.deskAsk = (pin, q, ctx, signal) => new Promise((_res, rej) => {
      if (signal) signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    });
    renderAsk();
  });

  const form = page.locator('#askBody form');
  await form.locator('input.input').fill('what is SMH doing?');
  await expect(page.locator('.ask-stop'), 'Stop stays hidden until a question is in flight').toBeHidden();
  await form.locator('button[type=submit]').click();

  // In flight: Stop offered, and the composer is NOT taken away.
  await expect(page.locator('.ask-stop')).toBeVisible();
  await expect(page.locator('#askBody form button[type=submit]')).toHaveText('Asking…');
  await expect(page.locator('#askBody form input.input'),
    'the composer stays usable — someone reaching for Stop wants to retype').toBeEnabled();

  await page.locator('.ask-stop').click();

  // After the stop: composer restored, Stop gone, and the outcome is stated.
  await expect(page.locator('#askBody form button[type=submit]')).toHaveText('Ask');
  await expect(page.locator('.ask-stop')).toBeHidden();
  await expect(page.locator('#askBody form input.input')).toBeEnabled();
  const note = page.locator('.ask-a--stopped');
  await expect(note, 'a stop must say the answer is still coming').toHaveCount(1);
  await expect(note).toContainText(/still|appear|history|reload/i);
  /* A deliberate stop is not a failure: the red error line must stay hidden, or
     the owner reads their own action as a fault. */
  await expect(page.locator('#askBody ~ .lock-error, #askBody .lock-error')).toBeHidden();

  // And the panel is genuinely reusable, not wedged behind a stuck askBusy.
  const busy = await page.evaluate(() => askBusy);
  expect(busy, 'askBusy must clear on abort or the panel is dead').toBe(false);
});

test('S33: verify is armed per question and disarms itself after an answer', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#askBody')).toBeVisible({ timeout: 15000 });

  // Demo has no backend, so there is no answer to check and no control to offer.
  await expect(page.locator('.ask-verify'), 'no verify toggle in demo').toHaveCount(0);

  /* Forced live+authed. deskAsk is stubbed to RECORD the verify argument it was
     handed and answer immediately — the toggle's whole job is what reaches the
     wire, so asserting on aria-pressed alone would pass even if the flag were
     never sent. */
  await page.evaluate(() => {
    DESK.mode = 'live'; DESK.authed = true;
    sessionStorage.setItem('desk_pin', '0000');
    window.deskChatHistory = () => Promise.resolve([]);
    window.__verifyArgs = [];
    window.__askFails = false;
    window.deskAsk = (pin, q, ctx, signal, verify) => {
      window.__verifyArgs.push(verify);
      return Promise.resolve(window.__askFails
        ? { ok: false, error: 'boom' }
        : { ok: true, answer: 'answered', sources: [] });
    };
    renderAsk();
  });

  const form = page.locator('#askBody form');
  const verify = page.locator('.ask-verify');
  const send = async (text) => {
    await form.locator('input.input').fill(text);
    await form.locator('button[type=submit]').click();
  };

  await expect(verify, 'off by default — the check costs quota').toHaveAttribute('aria-pressed', 'false');

  // Armed, then sent: the flag must actually reach deskAsk.
  await verify.click();
  await expect(verify).toHaveAttribute('aria-pressed', 'true');
  await send('is HOOD oversold?');
  await expect.poll(() => page.evaluate(() => window.__verifyArgs)).toEqual([true]);

  // Disarms itself once an answer lands, so the next question isn't billed for it.
  await expect(verify, 'auto-off after an answer').toHaveAttribute('aria-pressed', 'false');
  await send('and NVDA?');
  await expect.poll(() => page.evaluate(() => window.__verifyArgs),
    'the second question goes unverified — the reset is real, not cosmetic').toEqual([true, false]);

  /* A FAILED question keeps the arm. Nothing was checked, the owner is about to
     re-send, and dropping their choice in between is how it gets lost silently. */
  await page.evaluate(() => { window.__askFails = true; });
  await verify.click();
  await send('third question');
  await expect(verify, 'an error must not disarm — no answer was ever checked')
    .toHaveAttribute('aria-pressed', 'true');
});

// S34 — Pro 2 "steady" candle colour (owner ruling 2026-08-05). Steady mode
// acts on a crossover INSIDE the 30–80 band and ignores one out in the
// extremes, where the doctrine says the turn has not confirmed yet. Measured
// over ~2y across the 25 charted symbols: 650 colour changes -> 413, with all
// 269 mid-band crossovers still acted on and 381 extreme ones dropped.
//
// A separation threshold flickers less (305 changes, 2 short runs against the
// band's 56) and is REJECTED, so nothing here may reward one: it silently
// skips a real mid-band crossover whenever the lines cross and stay close,
// which is the event this pane exists to show.
//
// Two things are checked, and the second is the one that matters. The toggle
// must genuinely change the render, not just the stored flag — but far more
// important, the state machine runs over the WHOLE series, so a bar's colour
// must not depend on where the viewport happens to start. Seeded at the visible
// window instead, the same candle would change colour as you zoom, which is the
// kind of fault that quietly destroys trust in the pane.
test('S34: steady mode repaints the long-term pane, and a bar keeps its colour across a zoom', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  /* Colours of the RIGHTMOST candles in Pro 2, newest first. Keyed from the
     right edge on purpose: the last N bars are the same N bars at any zoom, so
     two reads stay comparable while every x-coordinate has moved. */
  const colours = n => page.evaluate(count => {
    const svg = document.getElementById('wbChart');
    const texts = [...svg.querySelectorAll('text')];
    const titles = texts.filter(t => /^PRO \d/.test(t.textContent))
      .map(t => ({ t: t.textContent, x: +t.getAttribute('x') })).sort((a, c) => a.x - c.x);
    const ti = titles.findIndex(t => /LONG-TERM/.test(t.t));   // by doctrine, not by number
    if (ti < 0) return { err: 'no Pro 2 pane' };
    const x0 = titles[ti].x - 10;
    const x1 = ti + 1 < titles.length ? titles[ti + 1].x - 10 : svg.viewBox.baseVal.width;
    const inPane = x => x >= x0 && x < x1;
    const topCapY = Math.min(...texts.filter(t => /STOCH|RSI/.test(t.textContent) && inPane(+t.getAttribute('x')))
      .map(t => +t.getAttribute('y')));
    let rects = [...svg.querySelectorAll('rect[shape-rendering=crispEdges]')]
      .map(r => ({ cx: +r.getAttribute('x') + +r.getAttribute('width') / 2, y: +r.getAttribute('y'), h: +r.getAttribute('height'), fill: r.getAttribute('fill') }))
      .filter(r => inPane(r.cx) && r.y < topCapY - 20);
    // volume bars share the candle shape but rest on one baseline — and stay
    // price-coloured, so counting them would fake a disagreement
    const tally = {};
    for (const r of rects) { const bb = (r.y + r.h).toFixed(1); tally[bb] = (tally[bb] || 0) + 1; }
    const vol = Object.entries(tally).sort((a, c) => c[1] - a[1])[0];
    if (vol && vol[1] > 5) rects = rects.filter(r => (r.y + r.h).toFixed(1) !== vol[0]);
    return rects.sort((a, c) => c.cx - a.cx).slice(0, count).map(r => r.fill.includes('gain'));
  }, n);

  const cap = () => page.evaluate(() => {
    const t = [...document.getElementById('wbChart').querySelectorAll('text')]
      .find(x => /CANDLE COLOUR/.test(x.textContent));
    return t ? t.textContent : null;
  });
  const changes = a => a.reduce((n, v, i) => n + (i && v !== a[i - 1] ? 1 : 0), 0);

  const plain = await colours(60);
  expect(plain.err, 'long-term candles located').toBeUndefined();
  expect(plain.length, 'enough candles sampled').toBeGreaterThan(40);
  expect(await cap(), 'steady is off by default — it recolours ~23% of bars')
    .not.toContain('STEADY');

  /* Arm it through the gear popover's own checkbox rather than by poking
     wbState — the control is what the owner touches, and a state-only test
     would still pass if the checkbox were never wired to the redraw. */
  await page.locator('#wbGear-p2').click();
  await page.getByLabel(/Steady \(ignore crosses in the extremes\)/i).check();
  await page.waitForTimeout(400);

  const steady = await colours(60);
  expect(steady.length, 'same bars still drawn').toBe(plain.length);

  /* The caption has to say so: with steady armed the strip can show the lines
     crossed while the candles hold the old regime, and an unexplained
     divergence in this pane reads as a stale render. */
  expect(await cap(), 'the pane names the mode it is in').toContain('STEADY');

  // The toggle must reach the pixels, and in the direction claimed.
  expect(steady).not.toEqual(plain);
  expect(changes(steady), 'steady must flip less often, not merely differently')
    .toBeLessThanOrEqual(changes(plain));
  /* ...but it must still TURN. A rule that suppressed crossovers generally —
     rather than only the ones out in the extremes — would sail through the
     assertion above by never changing colour at all, and that is the failure
     mode the owner ruled against: a mid-band cross has to act. */
  expect(changes(steady), 'steady still follows crossovers inside the band').toBeGreaterThan(0);

  /* The real hazard: zoom and the SAME bars must keep the SAME colours. The
     state carries forward bar to bar, so a machine seeded at the visible
     window instead of the whole series answers differently — measured on the
     25 charted symbols, that bug repaints 20 of them, up to 77 bars each.
     Read the NARROW window first and compare its OLDEST bars: the divergence
     sits where the seed is, at the left edge, so sampling only the newest bars
     misses it (this test did, until it was checked against the bug). */
  const zoom = async wdays => {
    await page.evaluate(w => { wbState.wdays = w; wbState.woff = 0; renderCharts(wbState.data, wbState.lamp); }, wdays);
    await page.waitForTimeout(400);
    return colours(9999);
  };
  const narrow = await zoom(21);
  expect(narrow.length, 'the narrow window drew candles').toBeGreaterThan(10);
  const wide = await zoom(252);
  expect(wide.length, 'the wide window drew more').toBeGreaterThan(narrow.length);
  // colours() reads newest-first, so the same bars are the same leading slice
  expect(wide.slice(0, narrow.length), 'a candle means the same thing at every zoom')
    .toEqual(narrow);
});

/* S35 — the symbol detail window (owner request 2026-08-06).

   The scenario this exists for is the COLLISION. Double-click already removes a
   tile (owner ruling 2026-07-30), and a double-click delivers a `click` first,
   so a naive single-click handler opens the detail window underneath every
   removal and then swallows the second click. Asserting "single click opens it"
   alone would pass with that bug fully present, which is why the double-click
   and drag cases below are the load-bearing half of this test. */
test('S35: a tile opens a detail window; double-click still removes', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 10000 });

  const detail = page.locator('#wlDetailBackdrop');
  await expect(detail, 'the window starts closed').toBeHidden();

  // ── demo: no removal is wired, so the open is immediate rather than deferred
  const tile = page.locator('.wl-strip .wl-tile').first();
  const sym = await tile.getAttribute('data-sym');
  await tile.click();
  await expect(detail).toBeVisible();
  await expect(page.locator('#wlDetailTitle')).toHaveText(sym);

  // The chart must actually draw — an empty <svg> is the failure this catches.
  const chart = page.locator('#wlDetailChart');
  await expect(chart).toBeVisible();
  expect(await chart.locator('rect').count(), 'candles + volume render').toBeGreaterThan(20);

  /* The window opens on the PANEL's span, so the chart is the tile's own line
     made bigger. Adjusting it here must NOT retime the panel — wlTf is what
     every tile sparkline reads, and moving it would repaint the whole panel
     from a control inside a modal. */
  expect(await page.evaluate(() => wlTf), 'opens on the panel span').toBe('1d');
  await expect(page.locator('#wlDetailTf button[data-tf="1d"]')).toHaveAttribute('aria-pressed', 'true');
  const before = await chart.innerHTML();
  await page.locator('#wlDetailTf button[data-tf="1y"]').click();
  await expect(page.locator('#wlDetailTf button[data-tf="1y"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => chart.innerHTML(), { timeout: 5000 })
    .not.toBe(before);                                    /* the span redrew the chart */
  expect(await page.evaluate(() => wlTf), 'the panel span is untouched by the modal').toBe('1d');

  await page.keyboard.press('Escape');
  await expect(detail, 'Escape closes').toBeHidden();

  /* ── live: the removal IS wired, and now the gestures have to coexist.
     DESK.authed stays false — opening a detail window READS a symbol, so it
     must not depend on an unlock any more than the edits do. */
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  await expect(page.locator('.wl-strip .wl-tile.wl-removable').first()).toBeVisible();
  const live = page.locator('.wl-strip .wl-tile').first();

  // A double-click removes, and must NOT leave a detail window behind it.
  await live.dblclick();
  await expect(page.locator('#wlRmBackdrop'), 'double-click still reaches removal').toBeVisible();
  // Waited past the deferred-open window: a leaked timer would have fired by now.
  await page.waitForTimeout(600);
  await expect(detail, 'the removal gesture must not open the detail window').toBeHidden();
  await page.locator('#wlRmCancelBtn').click();
  await expect(page.locator('#wlRmBackdrop')).toBeHidden();

  // A single click still opens it — and does not reach the removal dialog.
  await live.click();
  await expect(detail, 'a single click opens the window under live too').toBeVisible();
  await expect(page.locator('#wlRmBackdrop'), 'and never the removal dialog').toBeHidden();
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();

  /* A drop delivers a `click` to the tile it started from, so arranging the
     panel would pop a window open on every drag without the suppression. */
  const a = await live.boundingBox();
  const c = await page.locator('.wl-strip .wl-tile').nth(3).boundingBox();
  if (a && c) {
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 10, { steps: 6 });
    await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    await expect(detail, 'a drop is not a click').toBeHidden();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 36 — Pro 1 / Pro 2 spans are sticky (owner request 2026-08-09: they
// reset to 3M/6M on every refresh). Two things have to hold and only one is
// obvious. The spans must survive a reload INDEPENDENTLY — restoring Pro 1 to
// its own default would look like success while doing nothing — and a corrupt
// stored value must fall back rather than size a window no preset matches,
// which would leave every seg button unpressed and the pane at a width nothing
// in the UI explains.
// ─────────────────────────────────────────────────────────────────────────────
test('S36: the swing and long-term spans survive a reload, and a bad one falls back', async ({ page }) => {
  // three page loads plus three chart renders do not fit the 30s default
  test.setTimeout(90_000);
  await page.goto('./?demo=1');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 20000 });
  const pressed = async () => page.evaluate(() => ({
    p1: [...document.querySelectorAll('#chartZoom button')].find(b => b.getAttribute('aria-pressed') === 'true')?.textContent,
    p2: [...document.querySelectorAll('#chartZoom2 button')].find(b => b.getAttribute('aria-pressed') === 'true')?.textContent,
  }));
  // defaults
  expect(await pressed()).toEqual({ p1: '3M', p2: '6M' });

  // pick spans that BOTH differ from the defaults, so a reload that silently
  // ignored the store could not accidentally match
  await page.locator('#chartZoom button', { hasText: '1M' }).click();
  await page.locator('#chartZoom2 button', { hasText: '1Y' }).click();
  await page.waitForTimeout(600);
  expect(await pressed()).toEqual({ p1: '1M', p2: '1Y' });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  expect(await pressed(), 'both spans restore, independently').toEqual({ p1: '1M', p2: '1Y' });

  // a hand-edited / corrupt value is not trusted
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}');
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...raw, z1: 4242, z2: 'nonsense' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  expect(await pressed(), 'an unrecognised span falls back to the default').toEqual({ p1: '3M', p2: '6M' });
});

test('S37: every pane pins a last-price tab, and panning does not restate it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('./?demo=1');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);

  // The tab is a filled pentagon + its inverted label; read both so a flag
  // drawn with no number (or a number with no flag) fails rather than passes.
  //
  // :not([data-cross]) is load-bearing. The CROSSHAIR tag is deliberately the
  // same pentagon in the same ink (2026-08-13, matching the reference terminal,
  // which uses one tag idiom for both), so a bare fill filter now collects it
  // too — and it carries no `d` and no text until the pointer is over a pane,
  // which made this read null and throw rather than fail with a useful message.
  // data-cross is the marker the crosshair parts already carry for hide/show,
  // so it is the honest discriminator: this scenario is about the LAST-PRICE
  // tab, not about every pentagon on the axis.
  const tabs = async () => page.evaluate(() => {
    const svg = document.getElementById('wbChart');
    const flags = [...svg.querySelectorAll('path:not([data-cross])')]
      .filter(e => e.getAttribute('fill') === 'var(--color-text-primary)');
    const labels = [...svg.querySelectorAll('text:not([data-cross])')]
      .filter(e => e.getAttribute('fill') === 'var(--color-bg)');
    return {
      flags: flags.length,
      labels: labels.map(e => e.textContent),
      // y of each flag's tip, to confirm it is inside its own pane
      ys: flags.map(e => Number(/M[\d.]+ ([\d.]+)/.exec(e.getAttribute('d'))[1])),
      height: svg.viewBox.baseVal.height,
    };
  });

  const before = await tabs();
  expect(before.flags, 'one tab per pane — Pro 1, Pro 2, Pro 3').toBe(3);
  expect(before.labels).toHaveLength(3);
  // all three panes chart the same symbol, so they must agree on its price;
  // a per-pane number would mean the tab is reading the visible window
  expect(new Set(before.labels).size, 'all three panes show the same price').toBe(1);
  expect(before.labels[0]).toMatch(/^[\d,]+\.\d\d$/);
  for (const y of before.ys) {
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(before.height);
  }

  // Pan Pro 1 back through history. The newest bar leaves the viewport, but
  // "the last price" is a fact about now, not about the right edge — if the
  // tab were drawn from the last VISIBLE bar it would now label an old close
  // as the current price.
  const box = await page.locator('#wbChart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.30, box.y + box.height * 0.2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const after = await tabs();
  expect(after.flags, 'the tab survives a pan').toBe(3);
  expect(after.labels[0], 'the price is the newest close, not the last visible bar')
    .toBe(before.labels[0]);
});

/* S45 — the SYMBOL column: 100 PERMANENT slots, edited in place (owner ruling
   2026-08-26: "I want every item in the list to be editable... the 100 entries,
   filled or empty is permanent"). What this guards is that the column is
   POSITIONAL — slot 5 stays slot 5 — because the failure mode is invisible: a
   compaction renumbers every row below a hole and silently moves the owner's
   symbols to addresses they did not choose.
   Also the gesture split, which collides by nature: a single click charts, a
   double-click edits, and a double-click delivers a `click` FIRST. */
test('S45: the symbol column is 100 permanent slots, edited in place', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('./?demo=1');
  await expect(page.locator('.wb-slots')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const slots = () => page.evaluate(() =>
    [...document.querySelectorAll('.wb-slots .wb-rail-row .wb-side-sym')].map(e => e.textContent));

  // shape: 100 rows, their own scroller, no delete control, no editor at rest
  const shape = await page.evaluate(() => {
    const box = document.querySelector('.wb-slots');
    return { rows: box.querySelectorAll('.wb-rail-row').length,
             overflowY: getComputedStyle(box).overflowY,
             scrolls: box.scrollHeight > box.clientHeight + 2,
             x: document.querySelectorAll('.wb-rail-x').length,
             editors: document.querySelectorAll('.wb-slot-input').length,
             headOutside: !document.querySelector('.wb-slots .wb-rail-head') };
  });
  expect(shape.rows, 'exactly 100 slots, filled or empty').toBe(100);
  expect(shape.scrolls && shape.overflowY === 'auto', 'the LIST scrolls on its own').toBe(true);
  expect(shape.headOutside, 'and the SYMBOL/ACTIVE head stays put above it').toBe(true);
  expect(shape.x, 'no × — a slot is cleared by emptying it').toBe(0);
  expect(shape.editors, 'no live input until a slot is opened — 100 would repaint every frame').toBe(0);

  // double-click opens THAT slot, focused
  await page.locator('.wb-slots .wb-rail-row').nth(3).locator('.wb-slot').dblclick();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && document.activeElement === i && i.closest('.wb-rail-row').dataset.slot;
  }), 'double-click opens a focused editor in the slot that was clicked').toBe('3');

  // lower case is normalised, saved POSITIONALLY, and charted
  await page.locator('.wb-slot-input').pressSequentially('qqq');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(900);
  let stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || []);
  expect(stored[3], 'normalised into slot 3').toBe('QQQ');
  expect(stored[0], 'slot 0 untouched — nothing was pushed anywhere').toBe('');
  expect(stored.length, 'still exactly 100').toBe(100);
  expect((await slots())[3], 'and rendered there').toBe('QQQ');

  /* A SINGLE click charts and opens no editor. Nothing is deferred, so the
     chart is immediate — the 250ms wait this used to take was the source of
     three separate races (Codex P2 ×3, PR #282), all of them the platform's
     double-click threshold and ours being two independent numbers. */
  await page.evaluate(() => wbPick(Object.keys(wbState.data.symbols)[0]));
  await page.waitForTimeout(300);
  await page.locator('.wb-slots .wb-rail-row').nth(3).locator('.wb-slot').click();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => wbState.sym), 'a single click charts that slot').toBe('QQQ');
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'and opens no editor').toBe(0);

  /* A DOUBLE click opens the editor. It also charts that slot on the way in —
     the accepted trade for removing the defer — so what is asserted is the
     EDITOR, and that the chart landed on THIS slot's own symbol rather than
     somewhere else. A pairing keyed by slot index is what makes this work at
     all: charting rebuilds the rail, so the second click lands on a
     REPLACEMENT button and a `dblclick` listener would never fire. */
  await page.evaluate(() => wbPick(Object.keys(wbState.data.symbols)[0]));
  await page.waitForTimeout(300);
  await page.locator('.wb-slots .wb-rail-row').nth(3).locator('.wb-slot').dblclick();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && i.closest('.wb-rail-row').dataset.slot;
  }), 'a double-click opens the editor on the slot that was clicked').toBe('3');
  expect(await page.evaluate(() => wbState.sym),
    "and charts that slot's own symbol, never another").toBe('QQQ');

  // emptying clears the slot and moves NOTHING
  await page.evaluate(() => {
    const cur = JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}');
    const syms = cur.syms.slice(); syms[7] = 'SPY';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...cur, syms }));
  });
  await page.locator('.wb-slot-input').fill('');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(700);
  stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || []);
  expect(stored[3], 'emptying the text clears the slot').toBe('');
  expect(stored[7], 'and nothing below it moves up').toBe('SPY');
  expect(stored.length, 'still exactly 100 after a clear').toBe(100);

  /* Survives a repaint the owner did not cause — renderCharts rebuilds this rail
     on every animation frame of a chart drag and every 60s poll, so an editor
     holding its value only in the DOM is blanked between two keystrokes. */
  await page.locator('.wb-slots .wb-rail-row').nth(5).locator('.wb-slot').dblclick();
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').pressSequentially('AVA');
  const survived = await page.evaluate(() => {
    renderWbSidebar(wbState.data);
    const i = document.querySelector('.wb-slot-input');
    return { value: i && i.value, focused: !!i && document.activeElement === i,
             slot: i && i.closest('.wb-rail-row').dataset.slot };
  });
  expect(survived.value, 'a half-typed slot survives a repaint').toBe('AVA');
  expect(survived.focused, 'and keeps focus — otherwise typing stops mid-word').toBe(true);
  expect(survived.slot, 'in the same slot').toBe('5');

  /* And it must still be there a TICK LATER. Tearing the input out fires blur,
     whose commit is deferred by design — so a repaint would otherwise save the
     half-typed text, chart it and close the editor one task after the checks
     above all pass. The synchronous read cannot see that; only this can. */
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return { open: !!i, value: i && i.value, focused: !!i && document.activeElement === i,
             slot5: (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[5] };
  });
  expect(still.open, 'the editor is still open a tick after the repaint').toBe(true);
  expect(still.value, 'still holding the half-typed text').toBe('AVA');
  expect(still.focused, 'and still focused').toBe(true);
  expect(still.slot5, 'and the repaint committed NOTHING — the owner is mid-word').toBe('');

  /* maxLength is 24, NOT the validator's 10 (Codex P2). It caps the RAW value
     and the browser applies it BEFORE any handler runs, so a 10-cap truncates a
     pasted " ABCDEFGHIJ " to nine characters — a real but DIFFERENT instrument.
     Typed through real key events on purpose: assigning el.value from script
     bypasses maxlength entirely, which is how this assertion sat INERT once
     already (it stayed green with the cap regressed to 10). */
  await page.locator('.wb-slot-input').fill('');
  await page.locator('.wb-slot-input').pressSequentially(' ABCDEFGHIJ ');
  expect(await page.locator('.wb-slot-input').inputValue(),
    'a PADDED ten-character symbol survives the raw cap').toBe(' ABCDEFGHIJ ');
  /* The padding is the whole point and this assertion was INERT without it:
     a bare 'ABCDEFGHIJ' is exactly ten, so a regressed 10-cap does not truncate
     it and the check stays green. With the padding a 10-cap yields
     ' ABCDEFGHI', which TRIMS to a real but DIFFERENT instrument — the
     wrong-number-wearing-a-plausible-face fault itself. Assert the committed
     slot too, since that is what the owner would actually be charting. */
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[5]),
    'and lands whole — not truncated into a different symbol').toBe('ABCDEFGHIJ');
  /* Reopen it holding that value — the selection check below needs something to
     select, and an empty input clamps every range to 0,0. */
  await page.evaluate(() => { wbEditSlot = 5; wbEditDraft = 'ABCDEFGHIJ'; renderWbSidebar(wbState.data); });
  await page.locator('.wb-slot-input').focus();

  /* The WHOLE selection survives a repaint — both offsets AND the direction.
     A collapsed caret makes the next keystroke INSERT where it should REPLACE,
     and a lost direction changes which end Shift+Arrow extends: a repaint the
     owner did not cause quietly changing what typing does. BACKWARD on purpose
     — asserting the offsets alone left the direction capture deletable. */
  const selKept = await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    i.setSelectionRange(2, 6, 'backward');
    renderWbSidebar(wbState.data);
    const n = document.querySelector('.wb-slot-input');
    return n && { start: n.selectionStart, end: n.selectionEnd, dir: n.selectionDirection };
  });
  expect(selKept && [selKept.start, selKept.end], 'the selected RANGE survives, not just a caret').toEqual([2, 6]);
  expect(selKept && selKept.dir, 'and which end it extends from').toBe('backward');
  await page.waitForTimeout(300);
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(200);

  // reload: the holes are preserved by INDEX
  await page.reload();
  await expect(page.locator('.wb-slots')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  const back = await slots();
  expect(back.length, '100 slots after a reload').toBe(100);
  expect(back[7], 'a filled slot returns to its own index').toBe('SPY');
  expect(back[6], 'and the hole above it is still a hole').toBe('');

  /* A DEEP slot — the whole point of a 100-row scroller, and the case rows 3/5/7
     above cannot reach. renderWbSidebar rebuilds `.wb-slots`, resetting its
     scrollTop, so without the restore the list jumps to the top on every
     repaint. That breaks the gesture outright rather than merely annoying: the
     first click of a double-click opens the editor, the re-render scrolls the
     list away under the second click, and the editor lands on a DIFFERENT slot
     than the one clicked (measured: clicking 30 opened 28). */
  /* ONE click, and what is asserted is what is under the POINTER before and
     after it. That is the invariant directly: the click opens the row it landed
     on, and that row is still there afterwards because neither the list nor the
     page moved. Deliberately not a second click that has to land — Playwright
     re-scrolls during its own actionability checks, and with this rail's top
     above the viewport that scroll arrives between the two clicks of a
     `dblclick`, moving slot 58 under a pointer aimed at 60. That is the harness
     moving the page, not the app (isolated: driven directly the app holds still
     every time), and a guard that flakes 1 run in 3 on harness behaviour is
     worse than one that measures the thing it cares about. The pairing across a
     rebuilt node is covered by the slot-to-slot case below. */
  const deepBtn = page.locator('.wb-slots .wb-rail-row').nth(60).locator('.wb-slot');
  await deepBtn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  /* Force the rail's TOP above the viewport — ordinary, since this panel sits
     far down the page — and hold it there. This geometry is the one that
     exposes Chromium's scroll anchoring: emptying and rebuilding #wbSidebar
     makes the browser compensate by scrolling the PAGE (measured 31px), which
     puts a different row under the pointer. It is set explicitly rather than
     left to wherever earlier steps happened to leave the page, which is what
     made this check pass or fail by luck: it failed only on the runs that had
     drifted to that geometry, 1 to 2 runs in 3. */
  await page.evaluate(() => {
    const r = document.querySelector('.wb-slots').getBoundingClientRect();
    window.scrollTo(0, window.scrollY + r.top + 70);
  });
  await page.waitForTimeout(250);
  const deepBox = await deepBtn.boundingBox();
  const dx = deepBox.x + deepBox.width / 2, dy = deepBox.y + deepBox.height / 2;
  const at = ({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest('.wb-rail-row');
    const inp = document.querySelector('.wb-slot-input');
    return { under: row && row.dataset.slot,
             editor: inp && inp.closest('.wb-rail-row').dataset.slot,
             listTop: Math.round(document.querySelector('.wb-slots').scrollTop),
             pageY: Math.round(window.scrollY) };
  };
  const before = await page.evaluate(at, { x: dx, y: dy });
  expect(before.under, 'the pointer is over the deep slot to begin with').toBe('60');
  await page.mouse.click(dx, dy);
  await page.waitForTimeout(250);
  const after = await page.evaluate(at, { x: dx, y: dy });
  expect(after.editor, 'a deep slot opens the slot that was CLICKED').toBe('60');
  expect(after.under, 'and that row is STILL under the pointer — the list did not jump').toBe('60');
  expect(after.listTop, 'the slot list keeps its scroll across the repaint').toBe(before.listTop);
  expect(after.pageY, 'and the PAGE does not move — the owner may be reading elsewhere').toBe(before.pageY);
  await page.locator('.wb-slot-input').fill('AVAV');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(800);
  const deep = await page.evaluate(() => ({
    at60: (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[60],
    top: Math.round(document.querySelector('.wb-slots').scrollTop),
  }));
  expect(deep.at60, 'and saves to that index').toBe('AVAV');
  expect(deep.top, 'with the list still scrolled where the owner left it').toBeGreaterThan(0);
  await page.evaluate(() => renderWbSidebar(wbState.data));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => Math.round(document.querySelector('.wb-slots').scrollTop)),
    'and a repaint the owner did not cause does not move it either — this rail repaints every 60s')
    .toBe(deep.top);

  /* Blur is NOT one outcome but three, and telling them apart is the whole job.
     Here: the owner clicks straight from an open editor to ANOTHER slot. The
     text must be KEPT (that is what the blur handler exists for), the clicked
     slot must open, and the abandoned one must NOT be charted — their attention
     has moved. An isConnected check alone reads this as a repaint and DISCARDS
     the edit, which is what it did before it was measured. */
  const symWas = await page.evaluate(() => wbState.sym);
  await page.locator('.wb-slots .wb-rail-row').nth(3).locator('.wb-slot').dblclick();
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('QQQ');
  await page.locator('.wb-slots .wb-rail-row').nth(8).locator('.wb-slot').click();
  await page.waitForTimeout(800);
  const moved = await page.evaluate(() => ({
    at3: (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[3],
    open: (document.querySelector('.wb-slot-input') || {}).closest
      ? document.querySelector('.wb-slot-input').closest('.wb-rail-row').dataset.slot : null,
    sym: wbState.sym,
  }));
  /* Now the same move with the press and the release SEPARATED, which is what a
     machine slower than a warm laptop does on its own — this failed on all three
     CI viewports while passing locally every time. The blur's commit is deferred
     a tick; give that tick room and it lands BEFORE the click is delivered. If
     it rebuilds the whole rail there, the button under the pointer is detached
     and the click event is never dispatched: no editor opens anywhere, and the
     owner's click simply does nothing. Closing only the edited ROW is what makes
     it survive. Falsified: with a full rebuild in the blur this returns
     editor=null, exactly as CI reported. */
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);
  const slowTo = page.locator('.wb-slots [data-slot="31"] .wb-slot');
  await slowTo.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  /* 30 and 31, both still EMPTY at this point — an empty slot opens its editor
     on a single click, where a filled one would chart instead. */
  await page.evaluate(() => { document.querySelector('.wb-slots [data-slot="30"] .wb-slot').click(); });
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('AVAV');
  const toBox = await slowTo.boundingBox();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);        /* the deferred blur commit runs in here */
  await page.mouse.up();
  await page.waitForTimeout(500);
  const slow = await page.evaluate(() => ({
    open: (document.querySelector('.wb-slot-input') || {}).closest
      ? document.querySelector('.wb-slot-input').closest('.wb-rail-row').dataset.slot : null,
    at30: (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[30],
  }));
  expect(slow.open, 'a SLOW press still opens the slot — the blur must not rebuild the rail under it').toBe('31');
  expect(slow.at30, 'and the text it left behind is still saved').toBe('AVAV');
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);
  expect(moved.at3, 'clicking to another slot KEEPS what was typed').toBe('QQQ');
  expect(moved.open, 'and opens the slot that was clicked').toBe('8');
  expect(moved.sym, 'without charting the one they left').toBe(symWas);

  /* SWITCHING DIRECTLY BETWEEN TWO FILLED SLOTS (Codex P2, PR #282). The first
     click charts, which REBUILDS the rail, so the second click lands on a
     replacement button — a `dblclick` listener needs both clicks on the same
     node and would never fire, leaving the slot charted but never opened. The
     pairing is keyed by slot INDEX in module state for exactly this reason. */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[2] = 'QQQ'; syms[4] = 'SPY';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
  });
  await page.locator('.wb-slots .wb-rail-row').nth(2).locator('.wb-slot').dblclick();
  await page.waitForTimeout(300);
  await page.locator('.wb-slots .wb-rail-row').nth(4).locator('.wb-slot').dblclick();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && i.closest('.wb-rail-row').dataset.slot;
  }), 'a double-click on ANOTHER filled slot opens it, even with an editor already open').toBe('4');
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(300);

  /* A SLOW double-click still edits (Codex P2, PR #282). This is the finding
     that bites the owner: they are on macOS, where the double-click speed is
     user-configurable well past the 250ms this row used to defer by. Under that
     design the first click's timer had already charted, and the pair opened
     nothing — measured here at a 300ms gap, which produced no editor at all.
     Our own 500ms window governs both halves now, so they cannot disagree.
     Driven through raw mouse clicks, not `dblclick()`: Playwright's dblclick
     sends the pair as fast as it can and could never express this gap. */
  const slot4 = await page.locator('.wb-slots .wb-rail-row').nth(4).locator('.wb-slot').boundingBox();
  const cx = slot4.x + slot4.width / 2, cy = slot4.y + slot4.height / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && i.closest('.wb-rail-row').dataset.slot;
  }), 'two clicks 300ms apart still open the editor — a defer shorter than the platform pairing charts instead').toBe('4');
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(300);

  /* F2 reaches the editor from the KEYBOARD. A double-click is pointer-only,
     and Enter/Space on a focused button fires `click`, which CHARTS a filled
     slot rather than editing it — so without F2 a filled slot could only ever
     be changed with a mouse. Same rule the watchlist tiles follow with Delete. */
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.locator('.wb-slots .wb-rail-row').nth(60).locator('.wb-slot').focus();
  await page.keyboard.press('F2');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && { slot: i.closest('.wb-rail-row').dataset.slot, value: i.value,
                  focused: document.activeElement === i };
  }), 'F2 on a focused FILLED slot opens its editor, loaded and focused')
    .toEqual({ slot: '60', value: 'AVAV', focused: true });
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(300);

  /* Escape still ABANDONS — it must not be undone by the blur that its own
     re-render fires a tick later. */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[20] = 'SPY';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
  });
  await page.locator('.wb-slots .wb-rail-row').nth(20).locator('.wb-slot').dblclick();
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('ZZZZ');
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[20]),
    'Escape keeps what was STORED, not what was typed').toBe('SPY');
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'and closes the editor').toBe(0);

  /* A REPAINT THE OWNER DID NOT CAUSE MUST NOT MOVE THE PAGE. This rail is
     rebuilt every 60s, and restoring focus to the open editor with a plain
     focus() drags an owner reading another panel back to the charts —
     falsified here at 1684px. focus({preventScroll:true}) is what stops it, and
     this scenario had no guard for it until now. */
  await page.evaluate(() => { document.querySelector('.wb-slots [data-slot="3"] .wb-slot').click(); });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.evaluate(() => renderWbSidebar(wbState.data));
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => Math.round(window.scrollY)),
    'the 60s repaint does not yank the page back to the charts').toBe(0);
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);

  /* ONE TAB STOP for the whole column, not a hundred. This column precedes the
     roster in DOM order, so 100 tabbable buttons put the ROSTER up to 100 Tab
     presses away and made F2 largely theoretical (Codex P2). Arrow keys move the
     stop with focus. */
  await page.evaluate(() => { wbEditSlot = -1; wbSlotTab = 0; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('.wb-slots .wb-slot')].filter(b => b.tabIndex === 0).length),
    'exactly one slot is in the tab sequence').toBe(1);
  await page.locator('.wb-slots [data-slot="0"] .wb-slot').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.closest('.wb-rail-row') && a.closest('.wb-rail-row').dataset.slot;
  }), 'ArrowDown moves focus to the next slot').toBe('1');
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('.wb-slots .wb-slot')].filter(b => b.tabIndex === 0)
      .map(b => b.closest('.wb-rail-row').dataset.slot)),
    'and the single tab stop travels with it').toEqual(['1']);
  /* A slot is edited by DOUBLE-TAP on a touch-only phone, where F2 does not
     exist — so the browser must not eat that gesture as a zoom (Codex P1, the
     same rule .wl-tile follows). */
  expect(await page.evaluate(() =>
    getComputedStyle(document.querySelector('.wb-slots .wb-slot')).touchAction),
    'slots keep the double-tap gesture on touch — it is the only way to edit one there').toBe('manipulation');

  /* AN EDIT ENDS A PENDING PAIR. Click an empty slot (which records that click),
     type a ticker, commit it — then click the now-filled row straight away. That
     click must CHART. Without clearing the pair on open it is read as the second
     half of the original one and reopens the editor instead, so a slot could not
     be charted immediately after filling it (Codex P2). */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[50] = '';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
    wbPick(Object.keys(wbState.data.symbols)[1]);
  });
  await page.waitForTimeout(300);
  const pairFrom = await page.evaluate(() => wbState.sym);
  const pairSym = await page.evaluate(() => Object.keys(wbState.data.symbols)[0]);
  await page.locator('.wb-slots [data-slot="50"] .wb-slot').click();
  await page.waitForTimeout(150);
  await page.locator('.wb-slot-input').fill(pairSym);
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(150);          /* well inside WB_SLOT_DBL_MS */
  await page.locator('.wb-slots [data-slot="50"] .wb-slot').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'clicking a slot right after filling it charts — it does not reopen the editor').toBe(0);
  expect(await page.evaluate(() => wbState.sym),
    'and the chart moved to what was just typed').toBe(pairSym);
  expect(pairFrom).not.toBe(pairSym);      /* the assertion above would be vacuous otherwise */

  /* CHARTING FROM THE KEYBOARD MUST NOT COST YOU YOUR PLACE. Enter on a filled
     slot runs synchronously into wbPick, whose render removes the focused
     button; with nothing restoring it, focus fell to the document and the roving
     Arrow keys and F2 stopped responding until the owner tabbed all the way back
     in — and this column is a single tab stop, so that is a long way back
     (Codex P2). */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[2] = Object.keys(wbState.data.symbols)[0];
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
  });
  await page.waitForTimeout(200);
  await page.locator('.wb-slots [data-slot="2"] .wb-slot').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => {
    const a = document.activeElement;
    const row = a && a.closest && a.closest('.wb-rail-row');
    return row ? row.dataset.slot : (a ? a.tagName : null);
  }), 'keyboard charting keeps focus on the slot, not on the document').toBe('2');

  /* EVERY non-slot way of changing the chart breaks a pending slot pair — and
     the header's `change` handler reaches wbPick DIRECTLY, without the loader or
     the submit handler, so it needs its own reset (Codex P2). Click slot A, pick
     an already-loaded symbol in the header, click A again inside the window: the
     last click must CHART A, not be read as the second half of the first pair. */
  const [pairA, pairB] = await page.evaluate(() => Object.keys(wbState.data.symbols).slice(0, 2));
  await page.evaluate((sym) => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[6] = sym;
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
  }, pairA);
  await page.waitForTimeout(200);
  await page.locator('.wb-slots [data-slot="6"] .wb-slot').click();
  await page.waitForTimeout(150);
  await page.evaluate((sym) => {
    const inp = document.getElementById('wbSymInput');
    inp.value = sym; inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, pairB);
  await page.waitForTimeout(150);
  await page.locator('.wb-slots [data-slot="6"] .wb-slot').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'the header change path breaks the pair — the next slot click charts').toBe(0);
  expect(await page.evaluate(() => wbState.sym), 'and lands on that slot').toBe(pairA);

  /* A SLOT HOLDING AN UNRESOLVABLE DRAFT IS NEVER CHARTED. The owner can reach
     that state deliberately — a slot keeps whatever was typed even when it does
     not resolve — and clicking it used to post the value to quote-proxy, which
     the Enter path and the restore queue both already declined to do (Codex P2,
     round 6). The editor opens instead, holding the bad text for correction. */
  const junkCalls = await page.evaluate(async () => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[58] = '!!';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
    const realMode = DESK.mode, realQ = window.deskQuote;
    const seen = [];
    DESK.mode = 'live';
    window.deskQuote = async (sym) => { seen.push(sym); return { ok: false }; };
    document.querySelector('.wb-slots [data-slot="58"] .wb-slot').click();
    await new Promise(r => setTimeout(r, 300));
    window.deskQuote = realQ; DESK.mode = realMode;
    return { seen, editor: (document.querySelector('.wb-slot-input') || {}).closest
      ? document.querySelector('.wb-slot-input').closest('.wb-rail-row').dataset.slot : null,
      value: (document.querySelector('.wb-slot-input') || {}).value };
  });
  expect(junkCalls.seen, 'an unresolvable draft is never sent to the proxy').toEqual([]);
  expect(junkCalls.editor, 'clicking it opens the editor instead').toBe('58');
  expect(junkCalls.value, 'holding the bad text, ready to correct').toBe('!!');
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);

  /* SETTLING AN EDITOR KEEPS FOCUS ON THE SLOT — for Enter AND for Escape.
     Both remove the focused input; renderWbSidebar's restore cannot help,
     because it snapshots a focused `.wb-slot` BUTTON and what is focused here is
     the INPUT. Without this a keyboard user is dropped to the document the
     moment their edit lands, and this column is a single tab stop (Codex P2). */
  for (const [key, slot] of [['Enter', '52'], ['Escape', '53']]) {
    await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
    await page.waitForTimeout(150);
    await page.locator('.wb-slots [data-slot="' + slot + '"] .wb-slot').click();
    await page.waitForTimeout(200);
    await page.locator('.wb-slot-input').fill('AAPL');
    await page.locator('.wb-slot-input').press(key);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => {
      const a = document.activeElement;
      const row = a && a.closest && a.closest('.wb-rail-row');
      return row ? row.dataset.slot : (a ? a.tagName : null);
    }), key + ' leaves focus on the slot, not on the document').toBe(slot);
  }

  /* KEYBOARD ACTIVATION NEVER PAIRS. Enter/Space fire a synthetic click with
     detail 0; two of them inside the window — or Enter auto-repeating while
     held — were read as a double-click and opened the editor, contradicting F2
     being THE keyboard edit gesture (Codex P2). */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[54] = Object.keys(wbState.data.symbols)[0];
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; renderWbSidebar(wbState.data);
  });
  await page.waitForTimeout(200);
  await page.locator('.wb-slots [data-slot="54"] .wb-slot').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'two keyboard activations chart twice — they never open the editor').toBe(0);
  /* BOTH halves must be pointer clicks. Gating only the check leaves the
     synthetic keyboard click RECORDING itself, so Enter followed by a pointer
     click inside the window opens the editor instead of charting (Codex P2,
     round 5). */
  await page.locator('.wb-slots [data-slot="54"] .wb-slot').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await page.locator('.wb-slots [data-slot="54"] .wb-slot').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'a pointer click after a keyboard one charts — a keyboard press is not half a double-click').toBe(0);

  /* The roving stop follows a click EVEN WHEN NOTHING REPAINTS. wbLoadSymbol
     does not repaint when the lookup fails — demo mode refuses live lookups —
     so assigning the module state alone left the live buttons untouched and Tab
     went back to the wrong slot (Codex P2). */
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice(); syms[46] = 'ZZZZ';   /* filled, and it will NOT resolve */
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    wbEditSlot = -1; wbSlotTab = 0; renderWbSidebar(wbState.data);
  });
  await page.waitForTimeout(200);
  await page.locator('.wb-slots [data-slot="46"] .wb-slot').click();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('.wb-slots .wb-slot')].filter(b => b.tabIndex === 0)
      .map(b => b.closest('.wb-rail-row').dataset.slot)),
    'the live tab stop follows the click even with no repaint').toEqual(['46']);
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await page.waitForTimeout(200);

  /* A committed ticker that cannot be charted must still CLOSE its editor. In
     demo mode wbLoadSymbol refuses live lookups and returns without repainting,
     so leaving the input up left it logically settled but on screen, rejecting
     every later Enter, Escape and blur (Codex P2). */
  await page.locator('.wb-slots [data-slot="40"] .wb-slot').click();
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('ZZZZ');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.querySelectorAll('.wb-slot-input').length),
    'an uncharTable ticker still closes the editor, never leaves an inert one').toBe(0);
  expect(await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[40]),
    'and the slot keeps what was typed').toBe('ZZZZ');

  /* The boot re-fetch asks for the FILLED slots and nothing else. `syms` is 100
     positional entries now, mostly empty on any real desk, so feeding it
     straight into restoreStickySymbols' serial loop would fire ~100
     deskQuote('') calls at quote-proxy on every live boot. Forced live because
     the restore is a no-op in demo. */
  const asked = await page.evaluate(async () => {
    /* Seeded with the three things that must NOT reach the proxy alongside the
       one that must: a hole, a draft that fails WL_SYM_RE (a slot deliberately
       KEEPS unresolvable text, owner ruling), and a duplicate. */
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}');
    const syms = new Array(100).fill('');
    syms[1] = 'SPY'; syms[2] = 'NOT A TICKER'; syms[3] = 'ABCDEFGHIJKLM'; syms[4] = 'SPY';
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms, sel: '' }));
    const realMode = DESK.mode, realQ = window.deskQuote;
    const seen = [];
    DESK.mode = 'live';
    window.deskQuote = async (sym) => { seen.push(sym); return { ok: false }; };
    try { wbRealSyms.clear(); await restoreStickySymbols(); }
    finally { window.deskQuote = realQ; DESK.mode = realMode; }
    return seen;
  });
  expect(asked.filter(s => !s), 'no empty slot is ever sent upstream').toEqual([]);
  expect(asked, 'and neither is an invalid draft or a duplicate — only the one real ticker')
    .toEqual(['SPY']);
  expect(asked.length, 'only the filled slots are re-fetched, not all 100').toBeLessThan(10);
  expect(errs, 'no page errors').toEqual([]);
});

/* S40 — the charts rail's ROSTER half: the full-width picker over two columns
   that start on the same line, every watchlist offered, a click charting
   without writing anything into the SYMBOL column, and the chosen roster
   surviving a reload. The SYMBOL column's own behaviour is S45's — the two were
   one scenario until 2026-08-26, when that column stopped being a stack the
   Load box pushed into and became 100 slots edited in place. */
test('S40: charts rail — roster picker and column shape', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('./?demo=1');
  await expect(page.locator('#wbSidebar .wb-rail-col').first()).toBeVisible({ timeout: 15000 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // two columns, side by side, under a full-width picker
  expect(await page.locator('#wbSidebar .wb-rail-col').count(), 'two rail columns').toBe(2);
  const geom = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('#wbSidebar .wb-rail-col')].map(c => c.getBoundingClientRect());
    const top = document.querySelector('.wb-rail-top').getBoundingClientRect();
    return { left0: cols[0].left, left1: cols[1].left, top0: cols[0].top, top1: cols[1].top,
             pickAbove: top.bottom <= cols[0].top + 1, pickW: top.width, railW: cols[0].width + cols[1].width };
  });
  expect(geom.left1, 'the columns sit side by side, not stacked').toBeGreaterThan(geom.left0);
  expect(Math.abs(geom.top0 - geom.top1) < 2, 'and both start on the same line').toBe(true);
  expect(geom.pickAbove, 'the picker spans the rail ABOVE them — at 68px it could not name its own list').toBe(true);
  expect(geom.pickW, 'so it is wider than either column').toBeGreaterThan(geom.railW / 2);

  /* THE WIDTH BUDGET — the rule the whole rail width is derived from: a ticker
     never abbreviates. Budgeted against the VALIDATOR's ten characters, never
     against demo's three-letter names: a budget that admits less than
     WL_SYM_RE accepts is not a budget, and DX-Y.NYB (8) is already in the
     roster. The font is read off the LIVE element rather than hardcoded, so a
     type-size change re-derives the expectation instead of needing a test
     edit. */
  const budget = await page.evaluate(() => {
    const cv = document.createElement('canvas').getContext('2d');
    const room = sel => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const c = getComputedStyle(e);
      return e.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight);
    };
    const probe = document.querySelector('.wb-slots .wb-side-sym');
    const f = getComputedStyle(probe);
    cv.font = `${f.fontWeight} ${f.fontSize} ${f.fontFamily}`;
    const clipped = [...document.querySelectorAll('#wbSidebar .wb-side-sym')]
      .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
    return { ten: cv.measureText('WWWWWWWWWW').width,
             symbol: room('.wb-slots .wb-slot'),
             roster: room('.wb-rail-roster .wb-side-btn'),
             clipped };
  });
  expect(budget.symbol, `a 10-char ticker needs ${budget.ten.toFixed(1)}px in the SYMBOL column`)
    .toBeGreaterThanOrEqual(budget.ten);
  expect(budget.roster, `and ${budget.ten.toFixed(1)}px in the ROSTER column`)
    .toBeGreaterThanOrEqual(budget.ten);
  expect(budget.clipped, 'and no rendered ticker is clipped — a clipped symbol names no instrument').toEqual([]);

  /* The picker offers the charts roster AND every watchlist. The watchlist feed
     lands after the charts one, so a picker with a single entry means the rail
     never repainted when the lists arrived. */
  const opts = await page.evaluate(() => [...document.querySelector('.wb-rail-pick').options].map(o => o.textContent));
  expect(opts[0], 'the charts roster is first').toBe('Charts roster');
  expect(opts.length, 'and every watchlist follows it').toBeGreaterThan(1);
  expect(await page.evaluate(() => document.querySelector('.wb-rail-pick').title),
    'the tooltip carries the human name, never the WB_ROSTER_CHARTS sentinel').toBe('Charts roster');

  /* Clicking a ROSTER name charts it and writes NOTHING into the SYMBOL column
     — nothing pins there any more (owner ruling 2026-08-26). */
  const filled = () => page.evaluate(() =>
    (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])
      .map((s, i) => (s ? i + ':' + s : null)).filter(Boolean).join('|'));
  /* Read the FILLED slots, not the raw array: the store is written lazily (the
     click itself persists the selected roster), so the array goes from absent
     to 100 empty strings without a slot gaining anything. Comparing the raw
     join would fail on that alone and say nothing about the guarantee. */
  const slotsBefore = await filled();
  const pick = page.locator('.wb-rail-roster .wb-side-btn').nth(1);
  const picked = (await pick.textContent()).trim();
  await pick.click();
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => wbState.sym), 'a roster click charts it').toBe(picked);
  expect(await filled(), 'and leaves the SYMBOL slots untouched').toBe(slotsBefore);
  expect(await page.evaluate(() =>
    (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || []).length),
    'the column is still exactly 100 slots').toBe(100);

  // the chosen roster survives a reload
  const lists = await page.evaluate(() => [...document.querySelector('.wb-rail-pick').options].map(o => o.value));
  if (lists.length > 1) {
    await page.selectOption('.wb-rail-pick', lists[1]);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.wb-rail-pick')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => document.querySelector('.wb-rail-pick').value),
      'the chosen roster survives a reload').toBe(lists[1]);
  }
  expect(errs, 'no page errors').toEqual([]);
});

/* S42 — the watchlist columns are PAGED, not scrolled (owner request
   2026-08-20: reaching the end of a list carried straight on into the page).
   The rule this guards is that the wheel belongs to the PAGE everywhere on this
   panel, which is why the fix is `overflow: hidden` and not `overscroll-
   behavior: contain` — the property this project has banned outright after it
   ate the mouse wheel three times. */
test('S42: watchlist columns page instead of scrolling', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 15000 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // No column may be wheel-scrollable, and none may carry overscroll-behavior
  // in ANY form — the axis-scoped variants included, since a future edit that
  // reaches for the vertical one re-creates the dead-wheel fault exactly.
  const rules = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-strip .mkt-group-tiles')].map(b => {
      const cs = getComputedStyle(b);
      return { y: cs.overflowY, x: cs.overflowX, os: cs.overscrollBehaviorY + '/' + cs.overscrollBehaviorX };
    }));
  expect(rules.every(r => r.y === 'hidden' && r.x === 'hidden'), 'no column scrolls under the wheel').toBe(true);
  // Phrased as "not contain", not "=== auto". A browser that does not implement
  // the property reports an empty string, which is not a failure — it cannot be
  // containing anything — and asserting the positive value would fail on the
  // engine rather than on the page.
  expect(rules.filter(r => /contain|none/.test(r.os)), 'no column carries overscroll-behavior').toEqual([]);

  // The wheel over a column moves the PAGE. This is the owner's actual
  // complaint, so where it can be driven it is asserted on the GESTURE, not on
  // the CSS above.
  // Chromium only: the other project is Mobile Safari, and a mobile WebKit
  // context has no mouse wheel to dispatch — page.mouse.wheel there does not
  // scroll, so the assertion would be measuring the emulated input device
  // rather than the panel. The CSS check above is what carries the rule on that
  // project, and it is the stronger half anyway: `overflow: hidden` cannot
  // chain on any engine.
  if (browserName === 'chromium') {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.wl-strip .mkt-group-tiles').first().hover();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY), 'the wheel scrolls the page, not the list')
      .toBeGreaterThan(100);
  }

  // Controls appear ONLY where a column overflows. A pair on every column would
  // be the clutter the owner asked to avoid, and one on a column that fits
  // would be a control that does nothing.
  const state = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-strip .mkt-group')].map(g => {
      const b = g.querySelector('.mkt-group-tiles');
      return { over: b.scrollHeight - b.clientHeight > 2, bars: g.querySelectorAll('.wl-page-bar').length };
    }));
  expect(state.some(s => s.over), 'demo has a list long enough to page').toBe(true);
  expect(state.every(s => s.bars === (s.over ? 1 : 0)), 'a bar exactly where one is needed').toBe(true);

  // A paged column must not push the other columns' tiles down — every column's
  // tiles start on the same line, so a control that grew the band head would
  // cost all seven of them for the sake of one. That is why the bar is a footer.
  const heads = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-strip .wl-band-head')].map(h => Math.round(h.getBoundingClientRect().height)));
  const paged = state.findIndex(s => s.over);
  expect(heads[paged], 'the paged column\'s head is no taller than its neighbours')
    .toBeLessThanOrEqual(Math.max(...heads));

  // Stepping: ▲ dead at the top, the ▼ states how many are still below, and the
  // count FALLS as you step — a static number would mean it counts the list
  // rather than what is hidden.
  const col = page.locator('.wl-strip .mkt-group').nth(paged);
  const up = col.locator('.wl-page').nth(0), down = col.locator('.wl-page').nth(1);
  /* Read the pair's state in one shot rather than through `expect(locator)
     .toBeDisabled()`. Those retry for the full expect timeout before reporting,
     so one wrong state costs 5s per assertion and the message names only the
     selector — whereas this fails instantly and prints the scroll position and
     both labels, which is what a diagnosis actually needs. */
  const pager = () => page.evaluate(i => {
    const g = [...document.querySelectorAll('.wl-strip .mkt-group')][i];
    const [u, d] = g.querySelectorAll('.wl-page');
    return {
      up: u.disabled, down: d.disabled, label: d.textContent,
      below: Number((d.textContent || '').replace(/\D/g, '') || 0),
      top: Math.round(g.querySelector('.mkt-group-tiles').scrollTop),
    };
  }, paged);

  const atTop = await pager();
  expect(atTop, 'the ▲ is dead at the top and the ▼ names how many are below')
    .toMatchObject({ up: true, down: false });
  expect(atTop.below, 'the ▼ names how many are still below').toBeGreaterThan(0);

  await down.click();
  await page.waitForTimeout(200);
  const stepped = await pager();
  expect(stepped.below, `the count falls as you step (was ${atTop.below})`).toBeLessThan(atTop.below);
  expect(stepped.up, 'the ▲ comes alive once there is something above').toBe(false);

  // The end is reachable and terminal in both directions.
  for (let i = 0; i < 12 && !(await pager()).down; i++) { await down.click(); await page.waitForTimeout(120); }
  const atEnd = await pager();
  expect(atEnd, 'the ▼ dies at the bottom and claims nothing is left below')
    .toMatchObject({ down: true, label: '▼' });
  const tiles = await col.locator('.wl-tile').count();
  const seen = await page.evaluate(i => {
    const b = [...document.querySelectorAll('.wl-strip .mkt-group')][i].querySelector('.mkt-group-tiles');
    const r = b.getBoundingClientRect();
    return [...b.querySelectorAll('.wl-tile')].filter(t => {
      const q = t.getBoundingClientRect();
      return q.bottom > r.top + 1 && q.top < r.bottom - 1;
    }).map(t => t.textContent);
  }, paged);
  expect(seen.length, 'the last tiles are on screen at the bottom').toBeGreaterThan(0);
  expect(tiles, 'and nothing was removed to get there').toBeGreaterThan(seen.length);

  // A DRAG must be able to reach the part of a list that is off-box. With no
  // wheel and no scrollbar this is the only way, so a tile could otherwise only
  // ever be dropped among the rows that happen to be showing. Driven from
  // wlDragMove, not from a listener on the button: a drag owns the pointer, so
  // the button gets no pointer events of its own — a `pointerenter` handler was
  // tried here and fired exactly never.
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; wlSort = { key: 'manual', dir: 1 }; renderWatchlist(); });
  await page.waitForTimeout(400);
  // The bar and a tile must be on screen TOGETHER: elementFromPoint returns
  // null outside the viewport, so a below-the-fold button reports no hover and
  // the check passes or fails on where the page happens to be scrolled.
  /* SCOPED to the watchlist strip. `.wl-page-bar` is no longer unique to this
     panel: the accounts positions table pages with the same shared control, so
     a bare selector resolves to two elements and strict mode rejects it. This
     scenario is about the watchlist columns, so it must say so. */
  await page.locator('.wl-strip .wl-page-bar').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const bar = await page.locator('.wl-strip .wl-page-bar .wl-page').nth(1).boundingBox();
  const grab = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.wl-strip .mkt-group .wl-tile')]
      .find(e => { const r = e.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; });
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  expect(grab, 'a tile and the pager are both on screen').not.toBeNull();
  const startTop = await page.evaluate(() => document.querySelector('.wl-strip .mkt-group-tiles').scrollTop);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 30, grab.y + 30, { steps: 6 });
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => wlDrag.on), 'the drag started').toBe(true);
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(bar.x + bar.width / 2 + (i % 2), bar.y + bar.height / 2, { steps: 2 });
    await page.waitForTimeout(170);
  }
  const dragTop = await page.evaluate(() => document.querySelector('.wl-strip .mkt-group-tiles').scrollTop);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(dragTop, 'resting on the ▼ mid-drag steps the column').toBeGreaterThan(startTop);

  expect(errs, 'no page errors').toEqual([]);
});

test('S41: watchlists are vertical columns above the charts', async ({ page }) => {
  // Sized to a DESK, not a phone. Columns-side-by-side is the wide-screen
  // design; at 393px a long list legitimately spreads its own sub-columns
  // across the full width and pushes the next list onto a row below, which is
  // the readable arrangement there and not a failure of this rule. Asserting it
  // at phone width tested the breakpoint, not the layout. The narrow behaviour
  // that actually matters — no sideways page scroll — is checked separately
  // below, at the project's own viewport.
  await page.setViewportSize({ width: 1512, height: 1000 });
  await page.goto('./?demo=1');
  await expect(page.locator('.wl-strip .wl-tile').first()).toBeVisible({ timeout: 15000 });

  const shape = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.wl-strip .mkt-group')];
    const tiles = [...groups[0].querySelectorAll('.wl-tile')];
    const wl = document.querySelector('.wl-area').getBoundingClientRect();
    const ch = document.querySelector('.area-charts').getBoundingClientRect();
    return {
      groups: groups.length,
      // a column: its own tiles stack downward
      tilesStack: tiles.length > 1 && tiles[1].getBoundingClientRect().top > tiles[0].getBoundingClientRect().top + 5,
      // and the lists sit beside each other
      sideBySide: groups.length > 1
        && groups[1].getBoundingClientRect().left > groups[0].getBoundingClientRect().left + 5,
      wlBottom: Math.round(wl.bottom), chartsTop: Math.round(ch.top),
      wlLeft: Math.round(wl.left), chartsLeft: Math.round(ch.left),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      innerScroll: (() => { const s = document.querySelector('.wl-strip'); return s.scrollHeight > s.clientHeight + 2; })(),
      // no tab strip: every list is on screen at once
      tabs: document.querySelectorAll('.wl-strip [role="tab"]').length,
    };
  });

  expect(shape.groups, 'every list renders').toBeGreaterThan(1);
  expect(shape.tilesStack, 'tiles stack downward inside a category').toBe(true);
  expect(shape.sideBySide, 'categories sit side by side as columns').toBe(true);
  expect(shape.tabs, 'the columns ARE the navigation — no tabs').toBe(0);
  expect(shape.wlBottom, 'watchlists sit above the charts panel').toBeLessThanOrEqual(shape.chartsTop);
  expect(shape.wlLeft, 'and share its left edge, both full-bleed').toBe(shape.chartsLeft);
  expect(shape.sideways, 'the page never scrolls sideways').toBe(false);
  expect(shape.innerScroll, 'the panel runs at full length, no inner crop').toBe(false);

  // The reorder control must not impersonate a back button — a bare ← on a
  // button reads as navigation to people and to crawlers alike.
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  const glyphs = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-move')].map(b => b.textContent));
  expect(glyphs.length, 'the reorder controls render in live').toBeGreaterThan(0);
  expect(glyphs.some(g => g === '←' || g === '‹'), 'no reorder control is a bare back arrow').toBe(false);

  // Narrow width: the columns may wrap onto more than one row, but the PAGE
  // must never scroll sideways and the panel must never be cropped.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    innerScroll: (() => { const s = document.querySelector('.wl-strip'); return s.scrollHeight > s.clientHeight + 2; })(),
    tiles: document.querySelectorAll('.wl-strip .wl-tile').length,
  }));
  expect(narrow.sideways, 'no sideways page scroll at phone width').toBe(false);
  expect(narrow.innerScroll, 'the panel is not cropped at phone width').toBe(false);
  expect(narrow.tiles, 'every tile still renders at phone width').toBeGreaterThan(0);
});

/* S39 — the volume average. The failure it guards is quiet: an average computed
   from the VISIBLE window instead of the whole series still draws a plausible
   line, it just starts 20 bars in and leaves the left edge of the strip bare —
   and it shifts every time you zoom, which is what makes it untrustworthy. */
test('S39: every pane draws a volume average, spanning the full window', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('./?demo=1');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);

  /* Each average is attributed to ITS OWN pane by x-band, the same way S25 and
     S34 locate panes, because a bare set assertion does not enforce the claim
     its message makes: if the swing and long-term panes swapped their 63- and
     126-bar windows, `arrayContaining([126, 63])` still passes — and that quiet
     window/config swap is exactly what reordering the panes risks, so it is the
     one thing this must catch (Codex P2). */
  const ma = await page.evaluate(() => {
    const svg = document.getElementById('wbChart');
    const titles = [...svg.querySelectorAll('text')]
      .filter(t => /^PRO \d/.test(t.textContent))
      .map(t => ({ t: t.textContent, x: t.getBBox().x }))
      .sort((a, b) => a.x - b.x);
    const bandOf = (x) => {
      let hit = null;
      for (const ti of titles) if (ti.x - 10 <= x) hit = ti;
      return hit ? hit.t : null;
    };
    return [...svg.querySelectorAll('path[data-volma]')].map(e => {
      const d = e.getAttribute('d') || '';
      const firstX = parseFloat((d.match(/M\s*(-?[\d.]+)/) || [])[1]);
      return {
        pts: (d.match(/L/g) || []).length + 1,
        nan: d.includes('NaN'),
        stroke: e.getAttribute('stroke'),
        pane: bandOf(firstX),
      };
    });
  });
  expect(ma.length, 'one volume average per pane').toBe(3);
  expect(ma.every(m => !m.nan), 'no NaN coordinates').toBe(true);
  // yellow, matching the reference platform and the %D signal line
  expect(ma.every(m => m.stroke === '#f5c518')).toBe(true);

  // Each daily pane's average must cover its FULL window: it is computed from
  // the whole series, so the leading visible bars carry a real 20-period value.
  // Computed from the visible window instead, the lines would start 20 bars in
  // (106 and 44 points) and the left edge of each strip would be bare.
  // Asserted as a SET, not by index: the panes were reordered on 2026-08-25 and
  // ma[0] silently became the long-term pane, so an index-based check was
  // measuring a different window than its own message claimed.
  const byPane = Object.fromEntries(ma.filter(m => m.pane).map(m => [m.pane.replace(/ · .*/, '') + '|' + (/LONG-TERM/.test(m.pane) ? 'LONG' : /SWING/.test(m.pane) ? 'SWING' : 'DAY'), m.pts]));
  const ptsFor = (doc) => {
    const k = Object.keys(byPane).find(k => k.endsWith('|' + doc));
    return k ? byPane[k] : null;
  };
  expect(ptsFor('LONG'), 'the LONG-TERM pane opens on 6M and its average covers all 126 bars '
    + '(computed from the visible window it would be 106, and the strip would start bare)').toBe(126);
  expect(ptsFor('SWING'), 'the SWING pane opens on 3M and its average covers all 63 bars '
    + '(computed from the visible window it would be 44)').toBe(63);
});

/* S43 — a news row says WHICH DAY when it is not today.
 *
 * The failure this guards is silent by construction. The feed applies no
 * maximum age, so a quiet topic fills its 20 slots with whatever exists, and
 * the payload used to carry a bare UTC "HH:mm" with the date discarded. A
 * Jun 29 story therefore rendered as "14:19" — indistinguishable from this
 * afternoon — and, being sorted by recency, sat fourth in an August feed where
 * position itself implies freshness. The owner read it as current news.
 *
 * Asserting "a date is present" alone is not enough: dating EVERY row would
 * satisfy that while destroying the signal, since twenty identical "Aug 24"
 * labels make the one old row stop standing out. So this checks BOTH states —
 * today's rows carry no date, older rows do. Demo seeds both deliberately. */
test('S43: news rows date anything that is not from today', async ({ page }) => {
  await page.goto('./?demo=1');
  await expect(page.locator('.news-row').first()).toBeVisible({ timeout: 20000 });

  const rows = await page.evaluate(() => [...document.querySelectorAll('.news-row')].map((r) => {
    const when = r.querySelector('.news-time');
    const dateEl = when && when.querySelector('.news-date');
    return {
      date: dateEl ? dateEl.textContent.trim() : '',
      // the clock must survive alongside the date, not be replaced by it
      text: when ? when.textContent.trim() : '',
      title: when ? (when.getAttribute('title') || '') : '',
      // a clipped date is a wrong date: it must fit its own column
      clipped: when ? when.scrollWidth > when.clientWidth + 1 : false,
    };
  }));

  expect(rows.length, 'demo renders news rows').toBeGreaterThan(2);

  const dated = rows.filter((r) => r.date);
  const undated = rows.filter((r) => !r.date);

  expect(dated.length, 'at least one row is older than today and says so').toBeGreaterThan(0);
  expect(undated.length,
    'today\'s rows stay undated — dating every row destroys the signal it exists to give')
    .toBeGreaterThan(0);

  for (const r of dated) {
    expect(r.date, 'the date reads as "Mon D"').toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(r.text, 'the clock is kept alongside the date').toMatch(/\d\d:\d\d/);
    expect(r.title, 'the exact instant is recoverable from the tooltip').toMatch(/\d{4}-\d{2}-\d{2}/);
  }
  for (const r of rows) {
    expect(r.clipped, `the when-column does not clip (${r.text})`).toBe(false);
  }

  /* The date is a comparison against NOW, so it goes stale while the tab sits
     open — a row mapped at 23:30 keeps saying "today" after Pacific midnight,
     and the off-hours feed poll is hourly (Codex P2 on PR #276). The fix is to
     recompute per paint rather than bake it at map time, and to repaint on the
     rollover. This checks the recompute half and the wiring the tick needs.
     NOT COVERED: the midnight flip itself, which needs clock control the demo
     page cannot supply — newsDateLabel is exercised directly instead. */
  const live = await page.evaluate(() => {
    /* Fixtures must be PACIFIC-safe. The first version built these with
       setHours(), which works in the BROWSER's zone — UTC on CI — while
       newsDateLabel decides "today" in America/Los_Angeles. Those calendars
       disagree between 00:00 and 07:00 UTC, so the "today" fixture landed on
       the NEXT Pacific date and this scenario failed against a correct app
       (Codex P2, PR #276) — the same UTC-vs-Pacific confusion the scenario
       exists to guard. The current instant is today in every zone, and a whole
       number of days back is a different Pacific date in every zone. */
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 3 * 86400000).toISOString();
    window.renderNews([
      { ts: nowIso, t: '09:30', src: 'Reuters', h: 'A headline from today', chips: [] },
      { ts: oldIso, t: '14:30', src: 'Reuters', h: 'A headline from three days ago', chips: [] },
    ], { cls: 'lamp--demo', text: 'Demo' });
    const cols = [...document.querySelectorAll('.news-row .news-time')];
    return {
      stamped: cols.filter((c) => c.dataset.newsTs).length,
      dates: cols.map((c) => { const d = c.querySelector('.news-date'); return d ? d.textContent.trim() : ''; }),
      todayLabel: window.newsDateLabel(nowIso),
      oldLabel: window.newsDateLabel(oldIso),
      retickSurvives: (() => { try { window.retickStamps(); return true; } catch { return false; } })(),
    };
  });

  expect(live.stamped, 'every ts-bearing row exposes data-news-ts for the rollover tick').toBe(2);
  expect(live.dates[0], "today's row renders no date").toBe('');
  expect(live.dates[1], 'the three-day-old row renders one').toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  expect(live.todayLabel, 'newsDateLabel is empty for today').toBe('');
  expect(live.oldLabel, 'newsDateLabel dates an older instant').toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  expect(live.retickSurvives, 'the stamp reticker drives the news rollover without throwing').toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 46 — heatmap label halo, measured on the RENDERED page
//
// WHY THIS IS A BROWSER TEST. Heatmap tile labels sit on a DYNAMIC colour ramp,
// so AA is carried by a halo stroke under each glyph rather than by a token
// pair. check-contrast.js asserted that by READING scripts/app.js, and over five
// review rounds on PR #283 that produced seventeen ways for valid source to
// satisfy the check while the rendered labels lost their halo — ending with an
// entirely UNUSED object literal of the right shape, and a `stroke-width: 0`
// that specifies a perfect halo and paints nothing. No source analysis closes
// either: a check satisfied by dead code is not a check.
//
// SELECTION IS BY MARKER, NEVER BY THE PROPERTY UNDER TEST. The first version
// selected "labels that have a stroke" and asserted they have a halo — which
// passes vacuously when the halo is deleted, and (Codex P2, round 7) still
// passed when SOME labels regressed: changing fill and stroke TOGETHER on half
// of them kept the survivors satisfying every clause, because the inferred ink
// was tallied from the haloed set itself. `heatText` now stamps `.heat-label`,
// so membership is decided by the renderer and cannot move with the colours.
// Sector and industry captions are correctly excluded — they sit on a FIXED band
// fill and are covered by the token gate.
//
// A HALO IS ONLY A HALO IF IT PAINTS A SOLID OUTLINE UNDER THE GLYPH. Each of
// these was a separate way to keep every colour reading correctly while
// rendering no halo (rounds 6-7):
//   * stroke-width 0                → nothing drawn
//   * stroke-opacity, opacity or fill-opacity, or alpha in either colour
//   * stroke-dasharray '0 10000'    → a dash pattern with no visible dash
//   * paint-order 'fill stroke'     → contains "stroke", paints it OVER the glyph
//   * display:none, visibility:hidden, empty text, a zero-size box, a transform
//     putting the label off-canvas → every
//     computed colour still reads correctly on an element painting nothing
// Opacity is required to be FULL rather than merely non-zero, on the same rule
// check-contrast.js applies to tokens: a translucent colour has no contrast
// ratio of its own, and compositing needs a background this page does not have
// (the tile beneath is the dynamic ramp — which is the whole reason the halo
// exists).
//
// RESIDUAL, stated rather than implied: this asserts the properties that decide
// whether a stroke paints a solid outline. It does not sample pixels, so a
// mechanism that defeats all of them at once (a filter, a mask, a clip) would
// pass. Pixel sampling is the only thing above this rung.
test('S46: heatmap tile labels carry a painted halo meeting AA, as rendered', async ({ page }) => {
  await page.goto('./?demo=1');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  const toggle = page.locator('#heatToggle');
  if (await toggle.count()) await toggle.click();
  await page.waitForFunction(
    () => document.querySelectorAll('#heatmapSvg text.heat-label').length > 20,
    null, { timeout: 20000 },
  );

  const report = await page.evaluate(() => {
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const parse = (s) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(s || '');
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

    const svgBox = document.querySelector('#heatmapSvg').getBoundingClientRect();
    const labels = [...document.querySelectorAll('#heatmapSvg text.heat-label')];
    const failures = [];
    let worst = null;

    for (const el of labels) {
      const cs = getComputedStyle(el);
      const raw = (el.textContent || '').trim();
      const txt = raw.slice(0, 12) || '(blank)';
      const fill = parse(cs.fill);
      const stroke = parse(cs.stroke);

      // A marked element that paints NO GLYPH has no halo either, and every
      // computed-style assertion below would still pass on it (Codex P2, round 9).
      // Each of these is DOM state the render already resolved — no pixel
      // sampling — which is the line these checks are drawn on.
      if (!raw) { failures.push('(blank): a marked label with no text content paints no glyph'); continue; }
      if (cs.display === 'none') { failures.push(`${txt}: display:none — nothing is painted`); continue; }
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
        failures.push(`${txt}: visibility:${cs.visibility} — nothing is painted`); continue;
      }
      // Zero-size covers the remaining geometric ways to paint nothing (a zero
      // font-size, a degenerate transform) without reaching for pixels. Measured,
      // not inferred: a label scrolled out of view still has a box.
      const box = el.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) {
        failures.push(`${txt}: renders a ${box.width}x${box.height} box — nothing is painted`); continue;
      }
      // A box with real dimensions can still be nowhere near the map: a transform
      // on the label or any group above it (`translateX(10000px)`) preserves the
      // size and every paint property while putting the glyph off-canvas (Codex
      // P2, round 11). Tested as INTERSECTION with #heatmapSvg, not containment —
      // a label may legitimately straddle the edge of its own tile — and against
      // the SVG rather than the viewport, so a heatmap scrolled below the fold
      // still passes: both rects move together.
      const onMap = box.right > svgBox.left && box.left < svgBox.right
                 && box.bottom > svgBox.top && box.top < svgBox.bottom;
      if (!onMap) {
        failures.push(
          `${txt}: renders outside #heatmapSvg — label x[${Math.round(box.left)},${Math.round(box.right)}] ` +
          `vs map x[${Math.round(svgBox.left)},${Math.round(svgBox.right)}]`);
        continue;
      }

      // ANCESTOR OPACITY (Codex P2, round 10, and the case that proved my
      // boundary was in the wrong place). `opacity` does NOT inherit and does
      // NOT appear in a descendant's computed value, so `#heatmapSvg { opacity:
      // 0 }` paints the whole subtree transparently while every label below it
      // still reports opacity 1, a valid box, and correct colours. Every other
      // check in this loop reads the ELEMENT; this is the only one that has to
      // walk up. Note the neighbouring hazards do NOT need it and are already
      // covered: `visibility` inherits, and an ancestor `display: none` collapses
      // the descendant's box to 0x0.
      let anc = el.parentElement, faded = null;
      while (anc) {
        const acs = getComputedStyle(anc);
        const av = acs.opacity === '' ? 1 : num(acs.opacity);
        if (av !== null && av !== 1) {
          faded = { on: anc.tagName.toLowerCase() + (anc.id ? '#' + anc.id : ''), v: av };
          break;
        }
        anc = anc.parentElement;
      }
      if (faded) {
        failures.push(`${txt}: ancestor <${faded.on}> has opacity ${faded.v} — the subtree is not fully painted`);
        continue;
      }

      if (!fill) { failures.push(`${txt}: unreadable fill "${cs.fill}"`); continue; }
      if (!stroke) { failures.push(`${txt}: no halo — stroke is "${cs.stroke}"`); continue; }

      // Opacity, in all three places it can be lost.
      if (fill.a !== 1) { failures.push(`${txt}: fill is translucent (alpha ${fill.a})`); continue; }
      if (stroke.a !== 1) { failures.push(`${txt}: halo colour is translucent (alpha ${stroke.a}) — it has no contrast ratio of its own`); continue; }
      const so = cs.strokeOpacity === '' ? 1 : num(cs.strokeOpacity);
      if (so !== 1) { failures.push(`${txt}: stroke-opacity ${so} — the halo is not fully painted`); continue; }
      // `opacity` and `fill-opacity` are the remaining ways to make the label or
      // its ink invisible while every colour above still reads as opaque RGB
      // (Codex P2, round 8). Same computed style, no pixel sampling needed.
      const op = cs.opacity === '' ? 1 : num(cs.opacity);
      if (op !== 1) { failures.push(`${txt}: opacity ${op} — the label is not fully painted`); continue; }
      const fo = cs.fillOpacity === '' ? 1 : num(cs.fillOpacity);
      if (fo !== 1) { failures.push(`${txt}: fill-opacity ${fo} — the ink is not fully painted`); continue; }

      // Width.
      const sw = num(cs.strokeWidth) ?? 0;
      if (!(sw > 0)) { failures.push(`${txt}: stroke-width ${cs.strokeWidth} — nothing is drawn`); continue; }

      // A dash pattern can leave no visible outline while every colour reads correctly.
      const dash = (cs.strokeDasharray || 'none').trim();
      if (dash && dash !== 'none') { failures.push(`${txt}: stroke-dasharray "${dash}" — the halo is not a solid outline`); continue; }

      // paint-order must put the stroke FIRST: "fill stroke" still contains
      // "stroke" but paints it OVER the glyph, which is the opposite mechanism.
      const first = (cs.paintOrder || 'normal').trim().split(/\s+/)[0];
      if (first !== 'stroke') { failures.push(`${txt}: paint-order "${cs.paintOrder}" — the halo paints OVER the glyph`); continue; }

      const r = ratio(fill, stroke);
      if (worst === null || r < worst) worst = r;
      if (r < 4.5) failures.push(`${txt}: ink/halo contrast ${r.toFixed(2)} (need 4.5)`);
    }

    return { marked: labels.length, failures, worst };
  });

  // The panel must actually have rendered. Demo draws ~101 marked labels; 40
  // leaves room for a narrower viewport without admitting "the heatmap is gone".
  // This is a FLOOR on the panel, not a sample — every marked label is asserted.
  expect(
    report.marked,
    `Only ${report.marked} labels carry the .heat-label marker. Either the heatmap ` +
    'did not render, or heatText stopped stamping the class the selector depends on.',
  ).toBeGreaterThanOrEqual(40);

  expect(
    report.failures,
    `${report.failures.length} of ${report.marked} heatmap labels fail the halo contract:\n  ` +
    report.failures.slice(0, 12).join('\n  '),
  ).toEqual([]);

  test.info().attach('heatmap-label-halo', {
    body: JSON.stringify({ marked: report.marked, worstRatio: report.worst }, null, 2),
    contentType: 'application/json',
  });
});
