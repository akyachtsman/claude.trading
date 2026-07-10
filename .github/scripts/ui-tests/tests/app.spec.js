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
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('./');
  await page.waitForLoadState('networkidle').catch(() => {});
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
  await page.waitForLoadState('networkidle').catch(() => {});

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
  // The sweep scales with element count (~1.5s settle per element plus
  // navigation waits) and cannot fit the 30s global timeout on element-rich
  // apps or mobile-emulated projects.
  test.setTimeout(240_000);
  // Public-first apps (knowledge hub, questionnaire) are swept even with no credential;
  // only auth-gated apps with no credential are skipped (decided after page load below).
  const consoleErrors = [];
  const apiAnomalies  = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const getApiCalls = await captureApiCalls(page);
  await page.goto('./');
  await page.waitForLoadState('networkidle').catch(() => {});
  // Authenticate if we have a credential; if there's a real auth gate but no credential,
  // skip — sweeping the login screen would fire spurious PIN/password attempts and 401/403s
  // don't block, so the job could "pass" without reaching app content. A public app with
  // no gate falls through and is swept normally.
  if (AUTH_CREDENTIAL) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle').catch(() => {});
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
        await page.waitForTimeout(1500);
        await page.waitForLoadState('networkidle').catch(() => {});
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
        if (options.length > 1) await locator.selectOption({ index: 1 });
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

  const blocking = findings.filter(f => f.apiErrors.some(c => c.status >= 500) || f.consoleErrors.length > 0);
  expect(blocking, `Blocking anomalies found:\n${JSON.stringify(blocking, null, 2)}`).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — Responsive Layout
// ─────────────────────────────────────────────────────────────────────────────
test('S4: no horizontal overflow at 390px mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.waitForLoadState('networkidle').catch(() => {});
  // Authenticate only when a real auth gate (PIN/password) is detected, so overflow is
  // measured against the real app rather than the login screen. Gate on detectAuthGate()
  // — NOT just "a credential exists" — so a public-first app with a stray text input
  // (search/filter) isn't mutated by detectAndAuth's text-input fallback before measuring.
  if (AUTH_CREDENTIAL && await detectAuthGate(page)) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle').catch(() => {});
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
  await page.waitForLoadState('networkidle').catch(() => {});
  // Detect once and branch — each detectAuthGate() call burns a 5s waitFor timeout when
  // no gate is present, so calling it in both branches wasted ~10s of the test timeout.
  const gated = await detectAuthGate(page);
  if (AUTH_CREDENTIAL && gated) {
    await detectAndAuth(page, AUTH_CREDENTIAL);
    await page.waitForLoadState('networkidle').catch(() => {});
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
function backControl(page) {
  return page.locator(
    '[data-back], [aria-label*="back" i], button:has-text("Back"), a:has-text("Back"), ' +
    'button:has-text("←"), a:has-text("←")'
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
test('NAV: back navigation strictly unwinds (no loop)', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoAndAuth(page);

  const DEPTH_CAP = 5;
  const forward = [await viewSignature(page)]; // forward[0] = starting level

  // Drill down: at each level click the first "drill-in" candidate that BOTH changes
  // the view AND reveals an in-app back control. Stop at the cap, on no change, or
  // when no further drill-in exists.
  for (let d = 0; d < DEPTH_CAP; d++) {
    const before = forward[forward.length - 1];
    let advanced = false;
    for (const el of await discoverElements(page)) {
      if (!['a', 'button'].includes(el.tag) && !el.selector.includes('role=button')) continue;
      if (/back|←|‹|◀|return|home/i.test(el.label)) continue; // never drill via a back/home control
      try {
        const loc = el.id ? page.locator(`[id=${JSON.stringify(el.id)}]`) : page.locator(el.selector).nth(el.index);
        if (!await loc.isVisible().catch(() => false)) continue;
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        await page.waitForLoadState('networkidle').catch(() => {});
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
    await page.waitForLoadState('networkidle').catch(() => {});
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
  for (const id of ['#equityLamp', '#briefLamp', '#newsLamp', '#askLamp']) {
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

// S7 — Consolidate toggle: 2 series ⇄ 1 "All accounts" series.
test('S7: consolidate toggle collapses and restores the chart series', async ({ page }) => {
  await page.goto('./?demo=1');
  const legendItems = page.locator('#equityLegend > span');
  await expect(legendItems).toHaveCount(2);
  const btn = page.locator('#consolidateBtn');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(legendItems).toHaveCount(1);
  await expect(page.locator('#equityLegend')).toContainText('All accounts');
  await btn.click();
  await expect(legendItems).toHaveCount(2);
});

// S8 — Timeframe guard: full demo history enables every window; click redraws.
test('S8: all timeframes enabled in demo and selection moves', async ({ page }) => {
  await page.goto('./?demo=1');
  for (const b of await page.locator('#timeframeSeg button').all()) {
    await expect(b).toBeEnabled();
  }
  const oneMonth = page.locator('#timeframeSeg button', { hasText: '1M' });
  await oneMonth.click();
  await expect(oneMonth).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#timeframeSeg button', { hasText: '6M' })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.locator('#equityChart path').count()).toBeGreaterThan(0);
});

// S9 — Brief structure: sections + disclaimer + stamp always present.
test('S9: demo brief renders its three sections and the disclaimer', async ({ page }) => {
  await page.goto('./?demo=1');
  const brief = page.locator('#briefBody');
  for (const title of ['Portfolio state', 'Key levels', 'Scenarios']) {
    await expect(brief.locator('h3', { hasText: title })).toBeVisible();
  }
  await expect(brief.locator('.ai-disclaimer')).toContainText(/not financial advice/i);
  await expect(page.locator('#briefStamp')).not.toHaveText('—');
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
test('S10: valid PIN unlocks accounts, chart and brief (live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  test.skip(!AUTH_CREDENTIAL, 'TEST_AUTH_CREDENTIAL not available');
  await page.goto('./');
  const pinInput = page.locator('.lock-form input.input');
  await expect(pinInput).toBeVisible();
  await expect(page.locator('#equityLamp')).toHaveText(/locked/i);
  await pinInput.fill(AUTH_CREDENTIAL);
  await page.locator('.lock-form button').click();
  await expect(page.locator('#accountGrid .hero-number').first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#equityLamp')).not.toHaveText(/locked/i);
});

// S11 — Wrong PIN: plain error, still locked, nothing rendered.
test('S11: invalid PIN shows an error and stays locked (live only)', async ({ page }) => {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  await page.goto('./');
  const pinInput = page.locator('.lock-form input.input');
  await expect(pinInput).toBeVisible();
  await pinInput.fill('000000');
  await page.locator('.lock-form button').click();
  await expect(page.locator('.lock-error')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#equityLamp')).toHaveText(/locked/i);
  await expect(page.locator('#accountGrid .hero-number')).toHaveCount(0);
});
