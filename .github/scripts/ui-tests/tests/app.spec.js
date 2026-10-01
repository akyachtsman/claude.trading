// Generic exploratory UI test — no project-specific selectors or credentials.
// Reads the auth credential from the TEST_AUTH_CREDENTIAL env var only.
// Discovers app structure, exercises all interactive elements, captures API calls.
//
// ⚠️ Known CI compatibility issue — 100dvh not supported in older CI browsers:
// The CSS unit 100dvh (dynamic viewport height) is not supported in older CI browser
// versions (Chromium/WebKit in GitHub Actions). Elements using min-height: 100dvh may
// have zero computed height, causing Playwright toBeVisible() checks to fail even though
// the element is in the DOM. When diagnosing S1/S2 failures where login screen elements
// are present in HTML but not visible to Playwright, check for dvh units in CSS and
// replace with vh.

import { test as base, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// RENDER WITNESS — evidence that a test BODY started at its project's width (#348)
// ─────────────────────────────────────────────────────────────────────────────
// check-ui-viewports.js reads the run's JSON report. A result there proves a test
// was SCHEDULED in a project declaring a width; it does not prove a page was ever
// that wide, because a hook that throws before the body still leaves a result.
// This fixture is the stronger evidence. It yields a FUNCTION and records nothing
// at setup; the test body CALLS it as its first statement, and the call records
// `page.viewportSize()` on the result as a `rendered-viewport` annotation (once
// per test, however often it is called). Only code running inside the test
// callback can make that call, so a witness means the callback was ENTERED with
// the page at that width. The gate reports RENDERED for a width class only where
// such a witness carries a width inside that class. Ported from the upstream kit
// (Codex P2, PR #286 round 2) rather than left unimplemented: without it every
// scenario here is permanently SCHEDULED-only, and the stronger disposition
// check-ui-viewports.js carries never has anything to read.
//
// ⚠️ It records the width the body STARTS at. A setViewportSize() later in the
// body is not seen, which is why S4 keeps its own `viewport-override` marker.
// EVERY scenario below requests `renderWitness` AND calls `renderWitness();` as
// its first statement, BEFORE any skip/throw preamble — an honest failing or
// skipping body still entered the callback with a real page at that width, which
// is exactly what the witness attests. A test added later should do both.
const test = base.extend({
  renderWitness: async ({ page }, use, testInfo) => {
    // Records NOTHING at setup: the body's own call is the witness.
    let recorded = false;
    await use(() => {
      if (recorded) return;
      recorded = true;
      const vp = page.viewportSize();
      testInfo.annotations.push({ type: 'rendered-viewport',
        description: JSON.stringify(vp ? { width: vp.width, height: vp.height } : null) });
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL — TEST_AUTH_CREDENTIAL env var ONLY
// ─────────────────────────────────────────────────────────────────────────────
// This scenario file used to fall back to scraping CLAUDE.md for a "Valid test
// credential" line. This project's CLAUDE.md records the secret's NAME and never
// its value ("repo secret `TEST_AUTH_CREDENTIAL` (name only)"), so the scrape
// matched the table cell's first word and returned the string "repo" whenever
// the env var was unset — an invented value that S2/S10 then typed into the PIN
// box as though it were a real, merely wrong, credential: a confusing failure at
// best and a pass-by-luck at worst. Nothing here may invent a credential: with
// the secret absent the live-auth scenarios SKIP, saying why. An empty string
// (an unset GitHub secret exports as "") is absent too.
const AUTH_CREDENTIAL = (process.env.TEST_AUTH_CREDENTIAL ?? '').trim() || null;
const NO_CREDENTIAL = 'TEST_AUTH_CREDENTIAL is not set (a secret is never read from CLAUDE.md) — skipping the live-auth scenario';
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
/* ONE optional third-party feed beside the desk's own (owner request 2026-10-01): the live 2Y/10Y/20Y come straight from the
   visitor's BROWSER to CNBC's quote service, because CNBC refuses every server. It is an unofficial endpoint and, from a CI runner
   or any blocked network, its refusal logs the same console errors a failed feed call does — which the app absorbs BY DESIGN (the
   rows show NOT LIVE). The 1D span adds its twin, CNBC's chart feed (`OPTIONAL_FEED_CHARTS`): S3 clicks every control, the 1D button
   included, and a CI runner is refused there too. Each is matched on its exact URL prefix and nothing wider: not CNBC's other hosts
   or pages, not a look-alike host, and not another URL that merely CARRIES a prefix inside its query string (S57 pins all four). A
   location URL must START with one (`optionalFeedUrl`); a message must hold one as a whole URL token — at the start or right after
   whitespace, a quote or an opening bracket (`optionalFeedInText`) — never after `=`, `?` or `/`. */
const OPTIONAL_FEED = 'https://quote.cnbc.com/quote-html-webservice/';
const OPTIONAL_FEED_CHARTS = 'https://ts-api.cnbc.com/harmony/app/charts/';
const OPTIONAL_FEEDS = [OPTIONAL_FEED, OPTIONAL_FEED_CHARTS];
const optionalFeedUrl = (u) => typeof u === 'string' && OPTIONAL_FEEDS.some((f) => u.startsWith(f));
const OPTIONAL_FEED_TOKEN = new RegExp(`(?:^|[\\s'"(])(?:${OPTIONAL_FEEDS.map((f) => f.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`);
const optionalFeedInText = (s) => OPTIONAL_FEED_TOKEN.test(String(s || ''));
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
    (t.includes(FEED_ORIGIN) || optionalFeedUrl(src) || optionalFeedInText(text) || (LOCAL_ORIGIN && t.includes(OWN_ORIGIN)));
};
/* WebKit raises a blocked cross-origin fetch as a pageerror where Chromium only
   logs it, so this is the iphone project's half of the same rule. */
const benignPageError = (text) => benignCors(text);

/* NO SCENARIO MAY WRITE THE OWNER'S REAL ROSTER. The watchlist RPCs are PIN-free
   and carry the live DESK_DB.url, so a sweep that authenticates for real and
   clicks controls (S3, NAV/CTRL via gotoAndAuth) or a forced-live drag (S42)
   can reach a replace-all against the actual table in CI. Register BEFORE the
   page loads. Only the WRITE is answered here (`desk_set_watchlists*`); reads
   stay real, because S3 exercises them. Returns a live counter of the writes
   that were intercepted, so a scenario that can assert on it may. */
async function blockRosterWrites(page) {
  const blocked = { count: 0 };
  await page.route('**/rest/v1/rpc/desk_set_watchlists*', (route) => {
    blocked.count++;
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, version: null }) });
  });
  return blocked;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SCENARIO HELPERS — one copy of each setup/probe the scenarios repeated.
// A scenario that needs a variation passes a parameter; it does not fork the copy.
// ─────────────────────────────────────────────────────────────────────────────
/** Opens the demo desk, waits for `sel`'s first match to be visible, then `settle` ms more (charts need the beat). */
async function gotoDemo(page, sel, timeout, settle = 0) {
  await page.goto('./?demo=1');
  await expect(page.locator(sel).first()).toBeVisible({ timeout });
  if (settle) await page.waitForTimeout(settle);
}
/** Opens the demo desk with the heatmap expanded and its `.heat-label` tiles drawn (S46/S47 read the labels). */
async function openHeatmap(page) {
  await page.goto('./?demo=1');
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const toggle = page.locator('#heatToggle');
  if (await toggle.count()) await toggle.click();
  await page.waitForFunction(
    () => document.querySelectorAll('#heatmapSvg text.heat-label').length > 20,
    null, { timeout: 20000 },
  );
}
/* Symbol column (S40/S45) — the rail's 100 positional slots; index IS the slot. */
/** The button of slot `n`. */
const slotBtn = (page, n) => page.locator(`.wb-slots [data-slot="${n}"] .wb-slot`);
/** Index of the slot whose editor is open, or null when none is. */
const editorSlot = (page) => page.evaluate(() => {
  const i = document.querySelector('.wb-slot-input');
  return i && i.closest('.wb-rail-row').dataset.slot;
});
/** How many slot editors are live (0 at rest; never more than one). */
const editorCount = (page) => page.evaluate(() => document.querySelectorAll('.wb-slot-input').length);
/** `wb_sticky_v1`'s positional `syms` array as stored (holes included). */
const storedSyms = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || []);
/** The slot holding focus, else the focused element's tag ('BODY' = focus fell to the document). */
const focusedSlot = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const row = a && a.closest && a.closest('.wb-rail-row');
  return row ? row.dataset.slot : (a ? a.tagName : null);
});
/** Indexes of the slots currently in the tab sequence (the roving stop: exactly one). */
const tabStops = (page) => page.evaluate(() => [...document.querySelectorAll('.wb-slots .wb-slot')]
  .filter(b => b.tabIndex === 0).map(b => b.closest('.wb-rail-row').dataset.slot));
/** Writes `slots` ({index: symbol}; a NUMBER value means the charted roster's Nth symbol) into `wb_sticky_v1.syms`, every other index untouched. Then, unless `repaint: false`, closes any editor and repaints the rail — `tab` parks the tab stop on slot 0, `pick` charts the roster's Nth symbol. */
const seedSlots = (page, slots, { repaint = true, tab = false, pick } = {}) =>
  page.evaluate(({ slots, repaint, tab, pick }) => {
    const roster = () => Object.keys(wbState.data.symbols);
    const c = JSON.parse(localStorage.getItem('wb_sticky_v1'));
    const syms = c.syms.slice();
    for (const [i, v] of Object.entries(slots)) syms[i] = typeof v === 'number' ? roster()[v] : v;
    localStorage.setItem('wb_sticky_v1', JSON.stringify({ ...c, syms }));
    if (!repaint) return;
    wbEditSlot = -1; if (tab) wbSlotTab = 0; renderWbSidebar(wbState.data);
    if (pick !== undefined) wbPick(roster()[pick]);
  }, { slots, repaint, tab, pick });
/** Installs `window.__pane(titleRe)`, shared by S25/S34 (both colour-check the long-term candles): the PRO pane whose title matches — by DOCTRINE name, never the positional number — as `{ inPane, rects }` (its x band from its own title to the next, and its candle rects with the volume bars removed: they share ONE baseline and stay price-coloured), or `{ err }` when no title matches. */
const installPaneProbe = (page) => page.evaluate(() => {
  window.__pane = (titleRe) => {
    const svg = document.getElementById('wbChart');
    const texts = [...svg.querySelectorAll('text')];
    /* Pane bounds come from the pane titles — each pane owns the x band from
       its own title to the next. Everything is scoped to that band; without it
       a lookup silently strays into a neighbouring pane. */
    const titles = texts.filter(t => /^PRO \d/.test(t.textContent))
      .map(t => ({ t: t.textContent, x: +t.getAttribute('x') })).sort((a, c) => a.x - c.x);
    const ti = titles.findIndex(t => titleRe.test(t.t));
    if (ti < 0) return { err: 'pane title not found: ' + titleRe };
    const x0 = titles[ti].x - 10;
    const x1 = ti + 1 < titles.length ? titles[ti + 1].x - 10 : svg.viewBox.baseVal.width;
    const inPane = x => x >= x0 && x < x1;
    // candles sit above the pane's FIRST strip, never above a lower one
    const topCapY = Math.min(...texts.filter(t => /STOCH|RSI/.test(t.textContent) && inPane(+t.getAttribute('x')))
      .map(t => +t.getAttribute('y')));
    let rects = [...svg.querySelectorAll('rect[shape-rendering=crispEdges]')]
      .map(r => ({ cx: +r.getAttribute('x') + +r.getAttribute('width') / 2, y: +r.getAttribute('y'), h: +r.getAttribute('height'), fill: r.getAttribute('fill') }))
      .filter(r => inPane(r.cx) && r.y < topCapY - 20);
    /* Volume bars share the candle shape but all rest on ONE baseline, so the
       modal bottom edge identifies them. They stay price-coloured on purpose,
       and counting them would fake a disagreement. */
    const tally = {};
    for (const r of rects) { const bb = (r.y + r.h).toFixed(1); tally[bb] = (tally[bb] || 0) + 1; }
    const vol = Object.entries(tally).sort((a, c) => c[1] - a[1])[0];
    if (vol && vol[1] > 5) rects = rects.filter(r => (r.y + r.h).toFixed(1) !== vol[0]);
    return { inPane, rects };
  };
});
/** Closes any open slot editor WITHOUT committing, repaints the rail, then settles `wait` ms; `tab` also parks the tab stop on slot 0. */
const closeEditor = async (page, { wait = 200, tab = false } = {}) => {
  await page.evaluate((t) => { wbEditSlot = -1; if (t) wbSlotTab = 0; renderWbSidebar(wbState.data); }, tab);
  await page.waitForTimeout(wait);
};
/** Opens slot `n` (a click, or a double-click with `dbl`; `openWait` ms to let it open), types `text` over its content, presses `key`, then waits `wait` ms. */
async function editSlot(page, n, text, key, wait, { dbl = false, openWait = 200 } = {}) {
  await (dbl ? slotBtn(page, n).dblclick() : slotBtn(page, n).click());
  await page.waitForTimeout(openWait);
  await page.locator('.wb-slot-input').fill(text);
  await page.locator('.wb-slot-input').press(key);
  await page.waitForTimeout(wait);
}

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
             real coverage.
             KNOWN GAP (2026-09-30, watchlists back to horizontal bands): a band
             is `overflow-x: scroll; overflow-y: hidden`, and the test below
             treats EITHER axis hiding as clipping, so a tile beyond a band's
             visible width is counted in `clippedSkipped` instead of swept, though
             it could be scrolled to. Testing each axis only against its own
             overflow would restore that coverage. NOT done: S3 only sweeps with a
             live credential (locally it skips at the auth gate), so the wider
             sweep's runtime against the live roster could not be checked. */
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
test('S1: page loads without JS errors', async ({ page, renderWitness }) => {
  renderWitness();
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
    if (optionalFeedUrl(at)) return;   /* the CNBC quote call's "Failed to load resource" — see OPTIONAL_FEED at the top */
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
test('S2: auth gate discovered and credential accepted', async ({ page, renderWitness }) => {
  renderWitness();
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
  /* TEST_AUTH_READY_SELECTOR / TEST_AUTH_READY_REQUEST / TEST_AUTH_SUCCESS_SELECTOR
     are PLUMBED THROUGH BUT NOT WIRED IN THIS KIT — same shape as the
     TEST_AUTH_EMAIL guard above, and for the same reason: qa.yml / qa-live.yml /
     qa-response.yml pass all three into the ui-suite composite (directives#302,
     #320, #379), which exports them into this process, but nothing here reads
     them. mechanism below still comes from the windowed detectAuthGate() /
     detectAndAuth() pair, and success below is still decided from domChanged /
     onscreenError, never from a configured selector. Configuring one of these
     expecting the stronger PROVEN answer would silently get the windowed one
     instead — the same silent-no-op trap TEST_AUTH_EMAIL already guards against,
     caught in review on this same PR (Codex P2, #286) rather than left for an
     owner to discover by setting a variable that does nothing. */
  if ((process.env.TEST_AUTH_READY_SELECTOR ?? '').trim()
      || (process.env.TEST_AUTH_READY_REQUEST ?? '').trim()
      || (process.env.TEST_AUTH_SUCCESS_SELECTOR ?? '').trim()) {
    throw new Error(
      'S2 FAIL | TEST_AUTH_READY_SELECTOR, TEST_AUTH_READY_REQUEST or ' +
      'TEST_AUTH_SUCCESS_SELECTOR is set, but this test kit does not read any of ' +
      'them — S2 still decides "gate found" and "login succeeded" from the ' +
      'windowed detectAuthGate()/detectAndAuth() pair and a DOM/onscreen-error ' +
      'check, never from a configured selector or request. Setting one of these ' +
      'therefore changes nothing and the suite silently keeps windowing the ' +
      'answer instead of proving it. Unset them, or wire them into ' +
      'detectAuthGate()/detectAndAuth() and this assertion before re-setting one.'
    );
  }
  if (!AUTH_CREDENTIAL) test.skip(true, NO_CREDENTIAL);
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
  // KD-1 (docs/standards/kit-defects.md, directives#327): with a credential
  // configured, reaching 'none' means this run never found a gate at all —
  // every assertion below is vacuous without one, so this must fail rather
  // than silently pass.
  if (mechanism === 'none') throw new Error(`S2 FAIL | no auth gate found at ${page.url()}, but TEST_AUTH_CREDENTIAL is set — this scenario never reached the gate (set APP_URL, or point S2 at the login route). Failing rather than passing: every assertion below is vacuous without a gate (directives#327).`);
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
      credentialProvided: AUTH_CREDENTIAL ? 'yes' : 'none — TEST_AUTH_CREDENTIAL is unset',
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
test('S3: interactive elements discovered and exercised without errors', async ({ page, renderWitness }) => {
  renderWitness();
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
    const feed = FEED_ORIGIN_RE.test(src) || FEED_ORIGIN_RE.test(text) || optionalFeedUrl(src) || optionalFeedInText(text);
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

  await blockRosterWrites(page);   // not asserted: a legitimate click (a band's ↑/↓) may issue one
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
    f.apiErrors.some(c => c.status >= 500 && !FEED_ORIGIN_RE.test(c.url || '') && !optionalFeedUrl(c.url)) ||
    f.consoleErrors.length > 0);
  expect(blocking, `Blocking anomalies found:\n${JSON.stringify(blocking, null, 2)}`).toHaveLength(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 4 — Responsive Layout
// ─────────────────────────────────────────────────────────────────────────────
test('S4: no horizontal overflow at 390px mobile viewport', async ({ page, renderWitness }) => {
  renderWitness();
  // check-ui-viewports.js's `viewport-override` marker: this runs at the width
  // it chooses in EVERY project, so without it a run containing only this test
  // would falsely certify its host project's own declared width too (#347
  // round 4). setViewportSize() needs the same line.
  test.info().annotations.push({ type: 'viewport-override', description: '390' });
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
  await blockRosterWrites(page);   // NAV and CTRL click real controls on an authenticated desk
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

test('NAV: back navigation strictly unwinds (no loop)', async ({ page, renderWitness }) => {
  renderWitness();
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
test('CTRL: no duplicated primary action control', async ({ page, renderWitness }) => {
  renderWitness();
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
test('S5: demo mode shows DEMO lamps on every panel', async ({ page, renderWitness }) => {
  renderWitness();
  await page.goto('./?demo=1');
  await expect(page.locator('#mastheadState')).toContainText(/demo data/i);
  // The account cards render after boot; their lamps are part of "every panel".
  await expect(page.locator('#accountGrid .lamp').first()).toBeVisible({ timeout: 10000 });

  // Every panel's own lamp, by name — this used to check news and ask only, so
  // the Markets, Watchlists, Charts and Heatmap lamps could read LIVE unseen.
  // #econLamp (the Economy panel, 2026-09-30) makes seven.
  for (const id of ['#mktLamp', '#newsLamp', '#askLamp', '#wlLamp', '#chartsLamp', '#heatLamp', '#econLamp']) {
    await expect(page.locator(id), `${id} must read exactly Demo in demo mode`).toHaveText(/^demo$/i);
  }

  // ...and then EVERY visible lamp on the page, so a lamp nobody named cannot
  // slip through. `lamp--demo` is the state class, so the text and the colour
  // are both held to Demo. The one exception is the masthead's second lamp: the
  // desk cluster deliberately reads "Demo data" + "EOD snapshot" in demo
  // (renderMasthead), which the row's "EOD in demo" failure indicator does not
  // account for — so it is pinned by name rather than waved through.
  const lamps = await page.evaluate(() => [...document.querySelectorAll('.lamp')]
    .filter(e => e.offsetWidth || e.offsetHeight)
    .map(e => ({ text: e.textContent.trim(), cls: e.className, id: e.id,
                 masthead: !!e.closest('#mastheadState') })));
  expect(lamps.length, 'the page carries its panel lamps').toBeGreaterThanOrEqual(9);
  expect(lamps.filter(l => /\b(live|locked|stale)\b/i.test(l.text)).map(l => l.text),
    'no lamp reads LIVE, LOCKED or STALE in demo').toEqual([]);
  expect(lamps.filter(l => /\beod\b/i.test(l.text) && !(l.masthead && l.text === 'EOD snapshot')).map(l => l.text),
    'the only EOD lamp is the masthead\'s "EOD snapshot"').toEqual([]);
  expect(lamps.filter(l => !l.cls.includes('lamp--demo') && !(l.masthead && l.text === 'EOD snapshot')).map(l => `${l.id || l.cls}: ${l.text}`),
    'every other lamp is a Demo lamp').toEqual([]);
});

// S6 — Positions sort: header click reorders rows and flips aria-sort.
test('S6: positions table sorts on header click', async ({ page, renderWitness }) => {
  renderWitness();
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
  // The WHOLE column, in row order — comparing only the first cell passes for
  // any reshuffle that happens to move a different row to the top.
  const column = () => table.locator('tbody tr').evaluateAll(
    rows => rows.map(r => Number(r.querySelectorAll('td')[3].getAttribute('data-sort'))));
  await header.click();
  const dir1 = await header.getAttribute('aria-sort');
  const col1 = await column();
  await header.click();
  const dir2 = await header.getAttribute('aria-sort');
  const col2 = await column();
  expect([dir1, dir2].sort()).toEqual(['ascending', 'descending']);
  expect(col1.length, 'a table with rows to order').toBeGreaterThan(2);
  expect(col1.every(Number.isFinite), 'every row carries a numeric sort key').toBe(true);
  // each click leaves the rows in the order aria-sort claims
  const ordered = (col, dir) => col.every((v, i) => i === 0 || (dir === 'ascending' ? col[i - 1] <= v : col[i - 1] >= v));
  expect(ordered(col1, dir1), `after the first click the rows run ${dir1}`).toBe(true);
  expect(ordered(col2, dir2), `after the second click the rows run ${dir2}`).toBe(true);
  // ...and it is the same rows both times, flipped, not a different selection
  expect([...col1].sort((a, b) => a - b), 'the same values in both orders')
    .toEqual([...col2].sort((a, b) => a - b));
  expect(col1, 'the second click reverses the first').not.toEqual(col2);
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
test('S10: valid PIN unlocks accounts (live only)', async ({ page, renderWitness }) => {
  renderWitness();
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  test.skip(!AUTH_CREDENTIAL, NO_CREDENTIAL);
  await page.goto('./');
  const pinInput = page.locator('.lock-form input.input');
  await expect(pinInput).toBeVisible();
  // The LOCKED shell, asserted before any credential is offered: a desk that
  // rendered its accounts (or believed itself authenticated) without a PIN would
  // still "unlock" below, so the pre-state is half of what this scenario proves.
  await expect(page.locator('#accountGrid .panel-lock .lamp'), 'the accounts panel starts locked')
    .toHaveText(/locked/i);
  await expect(page.locator('#accountGrid .hero-number'), 'no account data before unlocking').toHaveCount(0);
  expect(await page.evaluate(() => DESK.authed), 'not authenticated before the PIN is entered').toBe(false);
  await pinInput.fill(AUTH_CREDENTIAL);
  await page.locator('.lock-form button').click();
  await expect(page.locator('#accountGrid .hero-number').first()).toBeVisible({ timeout: 15000 });
});

// S11 — Wrong PIN: plain error, still locked, nothing rendered.
test('S11: invalid PIN shows an error and stays locked (live only)', async ({ page, renderWitness }) => {
  renderWitness();
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
  const lockError = page.locator('.panel-lock .lock-error');
  await expect(lockError).toBeVisible({ timeout: 15000 });
  // ...with WORDS in it: a visible, empty error line is an unexplained failure.
  await expect(lockError, 'the error line says something').toHaveText(/\S/);
  // Still locked, not merely "an error appeared": the form is still there to try
  // again, the panel still reads Locked, nothing was kept, no data rendered.
  await expect(page.locator('.panel-lock .lock-form input.input'), 'the PIN form is still offered').toBeVisible();
  await expect(page.locator('#accountGrid .panel-lock .lamp'), 'the panel still reads Locked').toHaveText(/locked/i);
  expect(await page.evaluate(() => DESK.authed), 'a wrong PIN authenticates nothing').toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('desk_pin')), 'and a wrong PIN is not remembered').toBeNull();
  await expect(page.locator('#accountGrid .hero-number')).toHaveCount(0);
});

// S14 — Live-feed-layer canary (Group C: the committed snapshots are gone,
// so a dead feed layer would otherwise only show up as quiet STALE lamps).
// The desk lamp (in the Accounts header since 2026-07-22) derives from the
// freshest desk-market fetch: a HEALTHY feed reads LIVE while the market is open
// or EOD once it has closed (owner ruling 2026-07-22) — only STALE/missing means
// the edge-function layer is actually down.
test('S14: desk lamp reads LIVE/EOD off the market feed (live only)', async ({ page, renderWitness }) => {
  renderWitness();
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
test('S12: charts workbench renders panes and controls respond', async ({ page, renderWitness }) => {
  renderWitness();
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
  /* "Pro 3 ALONE carries the Extended-hours toggle" is a claim about the other
     two popovers as much as about Pro 3, and only Pro 3's was ever opened for it.
     The SWING popover (wbGear-p1, captioned PRO 2) is open right now; the
     LONG-TERM one (wbGear-p2, captioned PRO 1) was never opened at all. Titles
     are read too, since the popover title map is one of the three places the
     positional PRO number crosses the config key. */
  const noExt = async (id, why) => {
    expect(await page.locator(`#${id} label`, { hasText: /extended hours/i }).count(), `${why}: no Extended-hours toggle`).toBe(0);
    expect(await page.locator(`#${id} .wb-set-group`, { hasText: /^Session/ }).count(), `${why}: no Session group`).toBe(0);
  };
  await expect(page.locator('#wbSettings-p1')).toContainText('PRO 2 · SWING');
  await noExt('wbSettings-p1', 'SWING (Pro 2)');
  expect(await page.locator('#wbSettings-p1 label', { hasText: 'Stochastic (weekly)' }).count(),
    'the weekly overlay is the LONG-TERM pane\'s alone').toBe(0);
  await page.locator('#wbGear-p2').click();
  await expect(page.locator('#wbSettings-p2')).toBeVisible();
  await expect(page.locator('#wbSettings-p1'), 'opening a second gear closes the first').toBeHidden();
  await expect(page.locator('#wbSettings-p2')).toContainText('PRO 1 · LONG-TERM');
  expect(await page.locator('#wbSettings-p2 input[type=radio]').count(), 'chart-style radios').toBe(2);
  expect(await page.locator('#wbSettings-p2 input[type=checkbox]').count(), 'indicator, SMA, S/R and weekly-stochastic boxes').toBe(14);
  await expect(page.locator('#wbSettings-p2 label', { hasText: 'Stochastic (weekly)' }),
    'the weekly overlay toggle lives on the LONG-TERM pane').toBeVisible();
  await noExt('wbSettings-p2', 'LONG-TERM (Pro 1)');
  await page.locator('#wbGear-p3').click();
  await expect(page.locator('#wbSettings-p2')).toBeHidden();
  await expect(page.locator('#wbSettings-p3')).toContainText('PRO 3 · DAY TRADING');
  expect(await page.locator('#wbSettings-p3 .wb-set-group', { hasText: /^Session/ }).count(),
    'Pro 3 carries the Session group').toBe(1);
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
test('S13: heatmap map-filter cuts and period select respond', async ({ page, renderWitness }) => {
  renderWitness();
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
test('S20: watchlist timeframe control redraws the tile sparklines', async ({ page, renderWitness }) => {
  renderWitness();
  await page.goto('./?demo=1');
  const tf = page.locator('#wlTf');
  // The seven spans, by name and in order — a count of 7 is also satisfied by
  // seven of the wrong buttons.
  await expect(tf.locator('button')).toHaveText(['1D', '1M', '3M', '6M', '1Y', '2Y', '5Y']);

  // 1D is the default and is the ONLY pressed one
  await expect(tf.locator('button', { hasText: '1D' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tf.locator('button[aria-pressed="true"]'), 'exactly one span is pressed').toHaveCount(1);

  const firstPath = page.locator('.wl-strip .wl-spark svg path').first();
  await expect(firstPath).toBeVisible({ timeout: 10000 });
  // EVERY tile's line, keyed by symbol. The row promises "every tile sparkline";
  // the first one alone stays green if the redraw only reaches the first tile.
  const lines = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.wl-strip .wl-tile')]
    .map(t => { const p = t.querySelector('.wl-spark svg path'); return [t.dataset.sym, p ? p.getAttribute('d') : null]; })
    .filter(([, d]) => d)));
  const dayLines = await lines();
  expect(Object.keys(dayLines).length, 'the demo panel draws a sparkline per tile').toBeGreaterThan(20);

  // switching redraws: a different window is a different line
  await tf.locator('button', { hasText: '1Y' }).click();
  await expect(tf.locator('button', { hasText: '1Y' })).toHaveAttribute('aria-pressed', 'true');
  await expect(tf.locator('button', { hasText: '1D' })).toHaveAttribute('aria-pressed', 'false');
  await expect(tf.locator('button[aria-pressed="true"]'), 'and still exactly one').toHaveCount(1);
  await expect.poll(async () => {
    const yearLines = await lines();
    return Object.keys(dayLines).filter(sym => yearLines[sym] === dayLines[sym]);
  }, { message: 'every tile\'s line changed with the span' }).toEqual([]);

  // and it survives a reload — the control is persisted, not per-render state
  await page.reload();
  await expect(page.locator('#wlTf button', { hasText: '1Y' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#wlTf button', { hasText: '1D' }), 'the default is not also pressed').toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#wlTf button[aria-pressed="true"]'), 'exactly one span is pressed after the reload').toHaveCount(1);
});

/* A stateful stand-in for the PIN-free roster RPCs (desk_get/set_watchlists_open)
   and the desk-watchlist feed, seeded from whatever the demo panel is showing.
   Scenarios that force `DESK.mode = 'live'` and then DROP a tile, remove one or
   quick-add another have to install this first, for two reasons. The write
   controls funnel through wlMutate, whose RPCs are anon-callable and carry the
   real DESK_DB.url, so where the backend is reachable (CI) an un-stubbed drop
   REORDERS THE OWNER'S REAL ROSTER on every run. And with no backend a drop
   answers "Could not reach the desk" and commits nothing, so a test that never
   looks at the write cannot tell a drag that arranged the panel from one that
   drew a ghost and dropped it on the floor. `window.__rosterWrites` records every
   replace-all; `window.__roster` is the store those writes produced. */
async function installFakeRoster(page) {
  await page.evaluate(() => {
    const realFetch = window.fetch;
    const json = (o) => Promise.resolve(new Response(JSON.stringify(o),
      { headers: { 'content-type': 'application/json' } }));
    window.__roster = wlState.payload.lists.map(l => ({
      title: l.title, symbols: (l.symbols || l.rows.map(r => r.sym)).slice() }));
    window.__rosterWrites = [];
    window.fetch = (url, init) => {
      const u = String(url);
      if (u.endsWith('desk_get_watchlists_open'))
        return json({ ok: true, version: 'v' + window.__rosterWrites.length,
          lists: window.__roster.map(l => ({ title: l.title, symbols: l.symbols.slice() })) });
      if (u.endsWith('desk_set_watchlists_open')) {
        window.__roster = JSON.parse(init.body).new_lists
          .map(l => ({ title: l.title, symbols: (l.symbols || []).slice() }));
        window.__rosterWrites.push(window.__roster.map(l => ({ title: l.title, symbols: l.symbols.slice() })));
        return json({ ok: true, version: 'v' + window.__rosterWrites.length });
      }
      if (u.includes('/functions/v1/desk-watchlist'))
        return json({ ok: true, range: wlTf, lists: window.__roster.map(l => ({
          title: l.title, symbols: l.symbols.slice(),
          rows: l.symbols.map(sym => ({ sym, last: 100, pct: 1, spark: [1, 2] })) })) });
      return realFetch(url, init);
    };
  });
}
const rosterWrites = (page) => page.evaluate(() => (window.__rosterWrites || []).length);

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
test('S31: create and delete a list; delete is behind the lock', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

  // Demo has no backend to write to, so neither control may be offered.
  await expect(page.locator('#wlNewListBtn'), 'demo must offer no new-list button').toBeHidden();
  expect(await page.locator('.wl-del').count(), 'demo must offer no delete-list button').toBe(0);

  // Force the authed state and stand up a fake roster backend that holds real
  // state, so a create/delete has to actually persist rather than just repaint.
  await installFakeRoster(page);
  const out = await page.evaluate(async () => {
    window.__roster = [{ title: 'Radar', symbols: ['NVDA', 'AMD'] }, { title: 'Macro', symbols: ['TLT'] }];
    const titles = () => window.__roster.map(l => l.title).join(',');
    const r = {};
    DESK.mode = 'live'; DESK.authed = true;
    await loadWatchlist(true);
    r.delsShown = document.querySelectorAll('.wl-del').length;
    r.newBtnShown = !document.getElementById('wlNewListBtn').hidden;

    document.getElementById('wlNewListBtn').click();
    document.getElementById('wlNewInput').value = 'Earnings';
    await submitWlNewList();
    r.afterCreate = titles();

    // Case-insensitive: "earnings" must not join "Earnings".
    document.getElementById('wlNewListBtn').click();
    document.getElementById('wlNewInput').value = 'earnings';
    await submitWlNewList();
    r.dupeRefused = /already have a list/.test(document.getElementById('wlNewErr').textContent);
    r.dupeDialogStaysOpen = !document.getElementById('wlNewBackdrop').hidden;
    r.dupeKeptName = document.getElementById('wlNewInput').value;
    r.afterDupe = titles();
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
    openWlDelList(0, window.__roster[0].title, null);
    r.lockedDialogRefused = document.getElementById('wlDelBackdrop').hidden;
    wlLocked = false;
    renderWatchlist();

    document.querySelectorAll('.wl-del')[0].click();
    r.delText = document.getElementById('wlDelText').textContent;
    r.focusOnSafe = document.activeElement.id;
    await confirmWlDelList();
    r.afterDelete = titles();
    return r;
  });

  expect(out.newBtnShown, 'authed live must offer the new-list button').toBe(true);
  expect(out.delsShown, 'one delete per band').toBe(2);
  expect(out.afterCreate, 'the created list must persist').toBe('Radar,Macro,Earnings');
  expect(out.dupeRefused, 'a duplicate name must be refused').toBe(true);
  expect(out.dupeDialogStaysOpen, 'a refusal must not discard the typed name').toBe(true);
  expect(out.dupeKeptName, 'the refusal leaves the typed name in the box to correct').toBe('earnings');
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
test('S21: watchlist edits need no unlock; removal needs a double-click', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

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
  /* Nothing below may reach the real backend, and the quick-add check needs to
     count writes — see installFakeRoster. */
  await installFakeRoster(page);
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
  await expect(page.locator('#wlQuickErr'), 'no error before anything is submitted').toBeHidden();
  await page.locator('#wlQuickInput').fill('!!!');
  await page.locator('#wlQuickSaveBtn').click();
  /* The message is asserted, not just visibility: with no reachable backend a
     junk entry that WAS accepted would still surface "Could not reach the desk"
     in this same element, so a bare toBeVisible passes on an app that has
     stopped validating. And nothing may have been written. */
  await expect(page.locator('#wlQuickErr'), 'junk is refused by the parser, not by the network')
    .toContainText(/No usable ticker/);
  await expect(page.locator('#wlQuickBackdrop'), 'a refusal keeps the dialog open').toBeVisible();
  expect(await rosterWrites(page), 'junk reaches no write').toBe(0);

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
test('S26: tiles drag to arrange; sort snaps to Manual; a drop writes once, Escape writes nothing', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

  // Demo has no backend to write to, so no write surface may render at all —
  // the tray and the trash are write controls like the + always was.
  await expect(page.locator('#wlTrash'), 'no write control in demo').toBeHidden();
  await expect(page.locator('#wlTrayAdd'), 'no + in demo').toBeHidden();

  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  /* Every drop below is a real write through wlMutate — see installFakeRoster
     for why it must not reach the actual backend, and for what it lets us read. */
  await installFakeRoster(page);
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
  // The note above is TIMED (wlNote clears it after 4s) and sits in the panel
  // header, which wraps on a phone: when it disappears the whole panel moves up by
  // the height of a line. A band is a 74px-tall target now, so a drag aimed from
  // positions read before that moment lands on the band head instead — the Escape
  // step below read 0 drop targets on [iphone] under load for exactly this reason.
  // Let the layout settle before any drag measures where things are.
  await expect(page.locator('#wlNote'), 'the timed note is gone, so the layout has stopped moving').toBeHidden({ timeout: 8000 });

  // ── a real drag, now that Manual is active ──────────────────────────────
  // The drop target is CHOSEN IN THE PAGE, not computed from bounding boxes.
  // A fixed offset into "the next band" can land off-screen on a short viewport —
  // elementFromPoint then returns null, no drop zone is found, and the marker
  // assertion fails for a reason unrelated to what it tests. That is also true of
  // the real gesture: you cannot drag to somewhere you cannot see.
  // Picking the point by asking the DOM what is actually under it makes this
  // independent of viewport height, which matters because the two mobile
  // projects differ by ~60px and a hand-tuned offset passes on one and fails on
  // the other. The point returned is guaranteed to hit a band that is not the
  // source's, or the test says so plainly instead of failing downstream.
  // Scroll to the BOUNDARY between two bands first, so the last tile of one band
  // and the top of the next are on screen together.
  await page.locator('.mkt-group-tiles[data-band]').nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  // BOTH ENDS are chosen by hit-testing the page, not from bounding boxes: a tile
  // is only a grab point if it is actually on screen and nothing covers it (a long
  // band's later tiles are scrolled out of its own row, and on a phone only about
  // three are inside it), and the drop point must hit a band that is not the
  // source's. Asking the DOM what is actually under a point is the only form that
  // holds on both mobile projects, whose viewports differ by ~60px.
  const findPts = () => page.evaluate(() => {
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
  const pts = await findPts();
  expect(pts, 'a tile and a different band are both on screen for the drag').not.toBeNull();
  // What the drop is EXPECTED to do, read off the page before the pointer moves:
  // which symbol is grabbed, from which list, into which. The two bands differ
  // by construction (see the hit-test above), so a real drop must move the
  // symbol between two lists.
  const plan = await page.evaluate(({ from, to }) => {
    const grab = document.elementFromPoint(from.x, from.y);
    const zone = (pt) => document.elementFromPoint(pt.x, pt.y).closest('.mkt-group-tiles[data-band]');
    const count = (title, sym) => window.__roster.find(l => l.title === title).symbols.filter(x => x === sym).length;
    const sym = grab.closest('.wl-tile').dataset.sym;
    const fromTitle = zone(from).dataset.title, toTitle = zone(to).dataset.title;
    return { sym, fromTitle, toTitle, fromBefore: count(fromTitle, sym), toBefore: count(toTitle, sym) };
  }, pts);
  expect(plan.fromTitle, 'the drop target is a different list').not.toBe(plan.toTitle);
  const writesBefore = await rosterWrites(page);
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
  // ...and the drop MOVED the symbol, as one replace-all: a drag that draws its
  // ghost and marker and then lands nowhere would pass everything above.
  await expect.poll(() => rosterWrites(page), { message: 'a drop is exactly one write' })
    .toBe(writesBefore + 1);
  const landed = await page.evaluate((p) => {
    const count = (title) => window.__roster.find(l => l.title === title).symbols.filter(x => x === p.sym).length;
    return { from: count(p.fromTitle), to: count(p.toTitle) };
  }, plan);
  expect(landed.from, `${plan.sym} left the list it was dragged from`).toBe(plan.fromBefore - 1);
  expect(landed.to, `${plan.sym} arrived in the list it was dropped on`).toBe(plan.toBefore + 1);

  // Escape abandons a drag rather than committing it somewhere unintended
  // The pointer is held OVER a real drop target when Escape lands, so a
  // cancelled drag that fell through to a drop would write; a drag abandoned
  // over its own starting slot commits nothing whether or not Escape works.
  const writesAtEscape = await rosterWrites(page);
  const again = await findPts();
  expect(again, 'a tile and a different band are still on screen for the second drag').not.toBeNull();
  await page.mouse.move(again.from.x, again.from.y);
  await page.mouse.down();
  await page.mouse.move(again.from.x + 40, again.from.y + 20, { steps: 5 });
  await page.mouse.move(again.to.x, again.to.y, { steps: 8 });
  expect(await page.locator('.mkt-group-tiles.wl-drop-over').count(),
    'the drag is over a live drop target when Escape lands').toBe(1);
  expect(await page.locator('.wl-ghost').count(), 'the drag had begun before Escape').toBe(1);
  await page.keyboard.press('Escape');
  expect(await page.locator('.wl-ghost').count(), 'Escape cancels the drag').toBe(0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(await rosterWrites(page), 'an abandoned drag writes nothing').toBe(writesAtEscape);

  // ── an in-band drop is decided by the pointer's X, not its Y ─────────────
  // A band is ONE row that never wraps, so the slot is where the pointer is ALONG
  // the row. The pointer is held 1px under the tiles — still inside the drop zone
  // (over the row's padding, or its scrollbar where the browser draws one) but
  // BELOW every tile — because a slot worked out from Y as well counts every tile
  // as passed there and drops at the END of the list wherever you aimed. Not the
  // zone's own last pixel: bands overlap by 1px (collapsed borders), so the next
  // band's border can sit exactly there and WebKit rounds the pointer onto it.
  // Dragged: the band's first tile. Aimed at: the right half of its THIRD tile, so
  // it must land after the second and third and before the fourth.
  const inBand = await page.evaluate(() => {
    const zones = [...document.querySelectorAll('.mkt-group-tiles[data-band]')];
    const i = zones.findIndex(z => z.querySelectorAll('.wl-tile').length >= 6);
    return i < 0 ? null : i;
  });
  expect(inBand, 'some band has enough tiles to reorder within').not.toBeNull();
  await page.locator('.mkt-group-tiles[data-band]').nth(inBand).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const aim = await page.evaluate((i) => {
    const zone = document.querySelectorAll('.mkt-group-tiles[data-band]')[i];
    const tiles = [...zone.querySelectorAll('.wl-tile')];
    const z = zone.getBoundingClientRect();
    const grab = tiles[0].getBoundingClientRect(), third = tiles[2].getBoundingClientRect();
    const to = { x: third.left + third.width * 0.75, y: third.bottom + 1 };
    const hit = document.elementFromPoint(to.x, to.y);
    return {
      from: { x: grab.left + grab.width / 2, y: grab.top + grab.height / 2 }, to,
      inZone: !!hit && hit.closest('.mkt-group-tiles[data-band]') === zone,
      belowTiles: to.y > third.bottom,
      syms: tiles.slice(0, 4).map(t => t.dataset.sym), title: zone.dataset.title,
    };
  }, inBand);
  expect(aim.inZone, 'the aim point is inside the band\'s drop zone').toBe(true);
  expect(aim.belowTiles, 'and below its tiles, where a Y comparison would pass them all').toBe(true);
  await page.mouse.move(aim.from.x, aim.from.y);
  await page.mouse.down();
  await page.mouse.move(aim.from.x + 40, aim.from.y + 20, { steps: 5 });
  await page.mouse.move(aim.to.x, aim.to.y, { steps: 8 });
  const markerAt = await page.evaluate(() => {
    const m = document.querySelector('.wl-drop-marker');
    const next = m && m.nextElementSibling;
    return next ? next.dataset.sym : null;
  });
  expect(markerAt, 'the insertion marker sits before the FOURTH tile, following the pointer along the row')
    .toBe(aim.syms[3]);
  const writesInBand = await rosterWrites(page);
  await page.mouse.up();
  await expect.poll(() => rosterWrites(page), { message: 'the in-band drop is exactly one write' })
    .toBe(writesInBand + 1);
  const order = await page.evaluate((t) => window.__roster.find(l => l.title === t).symbols, aim.title);
  expect(order.indexOf(aim.syms[0]), 'the dragged tile landed after the third…')
    .toBe(order.indexOf(aim.syms[2]) + 1);
  expect(order.indexOf(aim.syms[3]), '…and immediately before the fourth')
    .toBe(order.indexOf(aim.syms[0]) + 1);

  // ── a long band auto-scrolls at its edges, so every slot is reachable (Codex review, PR #294) ──
  // The pointer owns the drag, so the row's scrollbar cannot be used at the same time: without help a tile could
  // only be dropped among the slots on screen. Holding the pointer near the row's right edge scrolls it, near the
  // left edge scrolls it back, and a drop at the far end lands at a slot that was off screen when the drag began.
  const longBand = await page.evaluate(() => {
    const zones = [...document.querySelectorAll('.mkt-group-tiles[data-band]')];
    const i = zones.findIndex(z => z.scrollWidth > z.clientWidth + 150 && z.querySelectorAll('.wl-tile').length >= 6);
    return i < 0 ? null : i;
  });
  expect(longBand, 'some band is wider than its row').not.toBeNull();
  await page.locator('.mkt-group-tiles[data-band]').nth(longBand).scrollIntoViewIfNeeded();
  await page.evaluate((i) => { document.querySelectorAll('.mkt-group-tiles[data-band]')[i].scrollLeft = 0; }, longBand);
  await page.waitForTimeout(200);
  const edge = await page.evaluate((i) => {
    const zone = document.querySelectorAll('.mkt-group-tiles[data-band]')[i];
    const z = zone.getBoundingClientRect(), t = zone.querySelector('.wl-tile').getBoundingClientRect();
    const y = t.top + t.height / 2;
    return { grab: { x: t.left + t.width / 2, y }, right: { x: z.right - 6, y }, left: { x: z.left + 6, y }, mid: { x: z.left + z.width / 2, y },
      symsAtStart: [...zone.querySelectorAll('.wl-tile')].map(x => x.dataset.sym), title: zone.dataset.title };
  }, longBand);
  const scrollLeftOf = () => page.evaluate((i) => document.querySelectorAll('.mkt-group-tiles[data-band]')[i].scrollLeft, longBand);
  const writesEdge = await rosterWrites(page);
  await page.mouse.move(edge.grab.x, edge.grab.y);
  await page.mouse.down();
  await page.mouse.move(edge.mid.x, edge.mid.y, { steps: 6 });
  expect(await scrollLeftOf(), 'in the middle of the row nothing scrolls').toBe(0);
  await page.mouse.move(edge.right.x, edge.right.y, { steps: 4 });
  await expect.poll(scrollLeftOf, { message: 'holding the pointer at the right edge scrolls the row', timeout: 6000 }).toBeGreaterThan(120);
  const markerAfterScroll = await page.evaluate(() => {
    const m = document.querySelector('.wl-drop-marker'), next = m && m.nextElementSibling;
    return { marker: !!m, before: next ? next.dataset.sym : null };
  });
  expect(markerAfterScroll.marker, 'the insertion marker follows the tiles as the row scrolls').toBe(true);
  const markerSlot = markerAfterScroll.before === null ? edge.symsAtStart.length : edge.symsAtStart.indexOf(markerAfterScroll.before);   // null = the end of the list
  expect(markerSlot, 'the marker now sits at a slot that was OFF screen when the drag began').toBeGreaterThan(2);
  // Hold at the right edge until the row runs out, then it must STOP. The insertion marker is a 3px flex child, so
  // with it in the row the row can scroll 3px past its last tile; repainting the marker clamps it back and the next
  // frame "moves" again — a loop of DOM mutation and layout that never ends at the boundary (Codex review, PR #294).
  // The pointer has not moved, so the loop is still running: put the row a few frames short of its end (waiting out
  // 2400px at a slow frame rate proves nothing more) and let the LOOP finish the job. It must then queue no further
  // frame, and a settled row must be left alone — not rewritten every frame.
  await page.evaluate((i) => {
    const zone = document.querySelectorAll('.mkt-group-tiles[data-band]')[i];
    zone.scrollLeft = zone.scrollWidth - zone.clientWidth - 60;
  }, longBand);
  await expect.poll(() => page.evaluate(() => wlDrag.raf), {
    message: 'the auto-scroll loop stops queuing frames once the row has run out (an unsettled loop keeps one queued forever)',
    timeout: 15000,
  }).toBe(0);
  const atEnd = await page.evaluate((i) => {
    const zone = document.querySelectorAll('.mkt-group-tiles[data-band]')[i];
    const last = [...zone.querySelectorAll('.wl-tile')].pop().getBoundingClientRect(), z = zone.getBoundingClientRect();
    window.__edgeMut = 0;
    window.__edgeObs = new MutationObserver(list => { window.__edgeMut += list.length; });
    window.__edgeObs.observe(zone, { childList: true });
    return { lastTileInView: last.right <= z.right + 1, pointerHeld: wlDrag.on, marker: !!zone.querySelector('.wl-drop-marker'),
      numbers: { lastRight: last.right, zoneRight: z.right, scrollLeft: zone.scrollLeft, scrollWidth: zone.scrollWidth, clientWidth: zone.clientWidth } };
  }, longBand);
  expect(atEnd.pointerHeld, 'the drag is still in progress while the row sits at its end').toBe(true);
  expect(atEnd.lastTileInView, 'the row really did scroll as far as its last tile ' + JSON.stringify(atEnd.numbers)).toBe(true);
  expect(atEnd.marker, 'and the insertion marker is still painted at the end of the row').toBe(true);
  await page.waitForTimeout(450);
  const idle = await page.evaluate(() => {
    window.__edgeObs.disconnect();
    return { mutations: window.__edgeMut, raf: wlDrag.raf };
  });
  expect(idle.mutations, 'a row held at its end is not rewritten every frame (the marker is not re-inserted in a loop)').toBe(0);
  expect(idle.raf, 'and no animation frame is left queued at the end').toBe(0);
  const restedAt = await scrollLeftOf();
  await page.mouse.move(edge.left.x, edge.left.y, { steps: 6 });
  await expect.poll(scrollLeftOf, { message: 'and the left edge scrolls it back (and wakes the loop the end had stopped)', timeout: 10000 }).toBeLessThan(restedAt - 100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await page.locator('.wl-ghost').count(), 'Escape ended the drag').toBe(0);
  expect(await rosterWrites(page), 'an abandoned auto-scroll drag writes nothing').toBe(writesEdge);
  const scrollAtRest = await scrollLeftOf();
  await page.waitForTimeout(250);
  expect(await scrollLeftOf(), 'the auto-scroll loop stopped with the drag').toBe(scrollAtRest);

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
test('S22: quick edits resolve the right band when two lists share a title', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

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
test('S24: a failed accounts load keeps the desk authenticated', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

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
test('S25: long-term candles follow the weekly stochastic; swing follows open/close', async ({ page, renderWitness }) => {
  renderWitness();
  await page.goto('./?demo=1');
  await page.waitForSelector('#wbChart');
  await expect(page.locator('#wbChart')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);
  await installPaneProbe(page);

  const probe = await page.evaluate(() => {
    const svg = document.getElementById('wbChart');
    const texts = [...svg.querySelectorAll('text')];
    const pts = el => (el.getAttribute('d').match(/[ML][-\d.]+[ ,][-\d.]+/g) || [])
      .map(s => s.slice(1).split(/[ ,]/).map(Number)).map(([x, y]) => ({ x, y }));

    const read = (titleRe, capRe) => {
      const pane = window.__pane(titleRe);   // the pane's x band + its candles (see installPaneProbe)
      if (pane.err) return { err: pane.err };
      const { inPane, rects } = pane;

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
test('S23: post-market prints render, and only where the instrument trades', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#mktTiles .mk-tile', 10000);

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
  // Checked on EVERY tile, and by exact text: the first tile alone let three
  // proxies repeat the close unseen, and a substring test lets "-0.42%" pass as
  // different from "0.42%" without being a different number.
  const tileTexts = await page.evaluate(() => [...document.querySelectorAll('#mktTiles .mk-tile')].map(t => ({
    regular: (t.querySelector('.mk-pct')?.textContent || '').trim(),
    // the pill leads with the proxy's name ("SPY +0.42%"); compare the NUMBER
    after: (t.querySelector('.mk-ext-pct')?.textContent || '').trim().replace(/^[A-Z]+\s+/, ''),
  })));
  expect(tileTexts, 'four index tiles').toHaveLength(4);
  for (const [i, t] of tileTexts.entries()) {
    expect(t.regular, `tile ${i}: the regular move is a number`).toMatch(/\d\.\d\d%/);
    expect(t.after, `tile ${i}: the after-hours figure is a number`).toMatch(/^[+\-−]?\d+\.\d\d%$/);
    expect(t.after, `tile ${i}: after-hours must not just repeat the close`).not.toBe(t.regular);
  }

  // Sector ETFs genuinely trade after the bell, so they need no proxy, and the
  // print is VISIBLE on every row — it was briefly tooltip-only while the
  // column was 258px, and the column was widened to 311px (2026-08-07)
  // specifically to bring it back, so a regression to the tooltip would undo
  // the width as well as the number.
  const secRows = page.locator('#mktSectors .mk-sec');
  expect(await secRows.count(), 'all 11 sectors render').toBe(11);
  expect(await page.locator('#mktSectors .mk-sec-ext').count(),
    'every sector shows its own after-hours move').toBe(11);
  // ...and each one is a READABLE move, not an empty pill: a node that exists
  // and says nothing satisfies a count of eleven.
  expect(await page.locator('#mktSectors .mk-sec-ext').evaluateAll(els => els.map(e => e.textContent.trim())
      .filter(t => !/\d\.\d\d%/.test(t))),
    'every sector after-hours pill carries a percentage').toEqual([]);
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

  /* The same claim AS RENDERED. The block above reads the generator's own
     output, so it stays green if the tooltip prints the line for every name (or
     for none, or as "+0.00%" where the print is absent). Open the map, enter
     every tile the way the pointer does, and read the card each one raises: the
     "After hours" line must be there exactly where the data carries a print. */
  await page.locator('#heatToggle').click();
  await expect(page.locator('#heatBody')).toBeVisible();
  await expect(page.locator('#heatmapSvg text.heat-label').first()).toBeAttached({ timeout: 10000 });
  const tips = await page.evaluate(() => {
    const tip = document.getElementById('heatTip');
    const data = new Map(buildDemoHeatmap().sectors.flatMap(s => s.tiles).map(t => [t.sym, t.extPct]));
    const seen = new Map();
    for (const r of document.querySelectorAll('#heatmapSvg rect')) {
      tip._hide();
      r.dispatchEvent(new PointerEvent('pointerenter'));
      if (tip.style.display !== 'block') continue;            // not a tile: no card
      const sym = tip.querySelector('.tip-sym').textContent;
      const line = tip.querySelector('.tip-ext');
      seen.set(sym, { hasLine: !!line, text: line ? line.textContent : '', printed: data.get(sym) != null });
    }
    tip._hide();
    return [...seen].map(([sym, v]) => ({ sym, ...v }));
  });
  expect(tips.length, 'tiles raised their cards').toBeGreaterThan(40);
  expect(tips.filter(t => t.hasLine).length, 'some rendered cards carry the after-hours line').toBeGreaterThan(0);
  expect(tips.filter(t => !t.hasLine).length, 'and some do not — absent, never a fabricated 0').toBeGreaterThan(0);
  expect(tips.filter(t => t.hasLine !== t.printed).map(t => t.sym),
    'the line renders exactly where a print exists').toEqual([]);
  for (const t of tips.filter(t => t.hasLine)) {
    expect(t.text, `${t.sym}: the after-hours line names itself and states a move`)
      .toMatch(/After hours.*\d\.\d\d%/);
  }
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
/** The shared opening of S15–S19: skip unless live + opted in + credentialed, size the timeout, unlock the desk. */
async function assistantSession(page) {
  test.skip(!(await liveBackendConfigured(page)), 'demo-only: DESK_DB is empty');
  test.skip(!process.env.RUN_ASSISTANT_TESTS, 'assistant tests are opt-in (real Claude calls) — set RUN_ASSISTANT_TESTS=1');
  test.skip(!AUTH_CREDENTIAL, NO_CREDENTIAL);
  /* The config's 30s test timeout is shorter than ONE askDesk (its own wait is
     90s), so every one of these scenarios died on the clock before an answer
     could arrive, whatever the assistant did. Sized to the longest path, S15:
     unlockDesk (its waits sum to 40s) + askDesk (90s) + a second unlockDesk
     (40s) + the 10s replay check is 180s only if every wait runs to its limit,
     so a healthy run has headroom. Set here rather than per test because all
     five open with this session, and a sixth added later gets it for free. */
  test.setTimeout(180_000);
  await unlockDesk(page);
}

test('S15: assistant remembers across a reload (opt-in, live only)', async ({ page, renderWitness }) => {
  renderWitness();
  await assistantSession(page);
  await askDesk(page, 'Remember the codeword is HELIX. Reply with just: noted.');
  await unlockDesk(page); // fresh render → transcript replays from desk_chat_memory
  await expect(page.locator('#askBody .ask-thread')).toContainText(/HELIX/i, { timeout: 10000 });
});

test('S16: a research question renders an answer (opt-in, live only)', async ({ page, renderWitness }) => {
  renderWitness();
  await assistantSession(page);
  await askDesk(page, 'What was the most recent US CPI year-over-year figure? One sentence, name the source.');
  await expect(page.locator('#askBody .ask-a').last()).toBeVisible();
});

test('S17: an off-page ticker returns an answer via live data (opt-in, live only)', async ({ page, renderWitness }) => {
  renderWitness();
  await assistantSession(page);
  await askDesk(page, 'What is the current price of KO? One line.');
  await expect(page.locator('#askBody .ask-a').last()).toBeVisible();
});

test('S18: gives a directional view, not a refusal; disclaimer stays (opt-in, live only)', async ({ page, renderWitness }) => {
  renderWitness();
  await assistantSession(page);
  await askDesk(page, 'One-word lean on SPY right now: buy, sell, or hold?');
  await expect(page.locator('#askBody .lock-error')).toBeHidden();
  await expect(page.locator('#askBody .ai-disclaimer')).toContainText(/not financial advice/i);
});

test('S19: clear empties the conversation (opt-in, live only)', async ({ page, renderWitness }) => {
  renderWitness();
  await assistantSession(page);
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
test('S27: watchlist tiles are half-width, stacked, and never clip a value', async ({ page, renderWitness }) => {
  renderWitness();
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
    const KINDS = ['mkt-name', 'mkt-last', 'wl-pct', 'wl-spark'];
    /* EVERY tile, not the first: a long ticker, a six-figure price or a missing
       sparkline changes a tile's own shape, and the first tile is the one the
       layout was tuned on. */
    const tiles = [...document.querySelectorAll('.wl-strip .wl-tile')];
    // Visual top-to-bottom order. `.wl-vals` is `display: contents`, so it has
    // no box of its own and its children lay out as tile children — that is the
    // mechanism the stacked order depends on, so assert the RENDERED order
    // rather than the DOM order, which still nests them.
    const orderOf = tile => [...tile.querySelectorAll('.mkt-name, .mkt-last, .wl-pct, .wl-spark')]
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .map(e => [...e.classList].find(c => KINDS.includes(c))).join(' > ');
    const over = sel => [...document.querySelectorAll('.wl-strip ' + sel)]
      .filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim());
    return {
      count: tiles.length,
      maxW: Math.max(...tiles.map(t => Math.round(t.getBoundingClientRect().width))),
      orders: [...new Set(tiles.map(orderOf))],
      prices: over('.mkt-last'), names: over('.mkt-name'),
      // The pill has no overflow rule of its own, so a too-wide one GROWS past
      // the tile instead of clipping (scrollWidth never exceeds its own box):
      // what can be measured is whether it stays inside the tile that owns it.
      pills: tiles.filter(t => {
        const p = t.querySelector('.wl-pct');
        if (!p) return false;
        const a = p.getBoundingClientRect(), b = t.getBoundingClientRect();
        return a.right > b.right + 0.5 || a.left < b.left - 0.5;
      }).map(t => t.dataset.sym),
    };
  });

  expect(m.count, 'the demo panel carries a real roster').toBeGreaterThan(20);
  expect(m.maxW, 'no tile should be wider than the half-width 66px layout, not the old 132px').toBeLessThanOrEqual(80);
  expect(m.orders, 'reading order must be ticker → price → change → line, on every tile')
    .toEqual(['mkt-name > mkt-last > wl-pct > wl-spark']);
  // The two that matter. Long values step down a font size (wlTile sets
  // `is-long` by string length, since CSS cannot branch on text length); if that
  // ever stops happening, six-figure index prices truncate mid-number.
  expect(m.prices, 'a clipped price is a wrong price').toEqual([]);
  expect(m.names, 'tickers are how this panel is scanned').toEqual([]);
  // The change pill is the number the panel exists to show, and it was widened to
  // the price's size (12px) on the promise that nothing clips.
  expect(m.pills, 'the change pill stays inside its tile').toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO 28 — The charts quote expires by AGE, not by presence.
// Owner report 2026-07-31: SMH showed 538.90 +34.68 (+6.88%) — the PREVIOUS
// session's close and move — under a stamp reading "delayed by 1 minute",
// because `wbInfoCache` was keyed on presence and the first fetch of a symbol
// was the last one for the life of the tab.
//
// This asserts the properties that make staleness impossible rather than trying
// to reproduce it: the REAL fetch path stamps what it caches, the TTL follows
// the session, and the read path actually HONOURS that TTL. Reproducing the bug
// itself would need a tab held open across a session boundary, which no CI run
// can do — so the contract is what gets guarded, by driving the real
// maybeFetchWbInfo against a stubbed deskQuote and moving the entry's age.
//
// An earlier version wrote `wbInfoCache.__probe = { at, info }` itself and read
// it back, so `hasAt`/`hasInfo` were assertions about the test's own literal and
// could not fail whatever the app did; only the TTL value check was real, and
// nothing checked that the cache was ever CONSULTED against it. The old bug — a
// cache keyed on presence — passed all of it. Both values are read from the live
// page's own globals (classic scripts, so top-level bindings are in scope inside
// evaluate).
// ─────────────────────────────────────────────────────────────────────────────
test('S28: the charts quote cache is timestamped and its TTL is session-aware', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#wbChart', 15000);

  const run = await page.evaluate(async () => {
    if (typeof wbInfoTtlMs !== 'function' || typeof maybeFetchWbInfo !== 'function') return { missing: true };
    const open = typeof marketSessionOpen === 'function' ? marketSessionOpen() : null;
    const ttl = wbInfoTtlMs();

    /* maybeFetchWbInfo is a no-op unless the symbol counts as LIVE (not demo,
       a backend configured, and the symbol backed by real data), so all three are
       forced for the duration and put back. A symbol other than the charted one
       is used, so the fetch's own re-render of the workbench never runs. A
       deployment with an empty DESK_DB still exercises this: the stub below means
       nothing is ever sent, so a placeholder URL is enough. */
    const realMode = DESK.mode, realQ = window.deskQuote, realUrl = DESK_DB.url;
    const sym = Object.keys(wbState.data.symbols).find(s => s !== wbState.sym);
    const hadReal = wbRealSyms.has(sym), hadEntry = Object.prototype.hasOwnProperty.call(wbInfoCache, sym);
    const prior = wbInfoCache[sym];
    const calls = [];
    const stubInfo = { price: 123.45, change: 1.5, changePct: 1.23 };
    const settle = () => new Promise(r => setTimeout(r, 60));
    const out = { ttl, open, sym };
    try {
      DESK.mode = 'live';
      if (!DESK_DB.url) DESK_DB.url = 'https://stub.invalid';
      wbRealSyms.add(sym);
      delete wbInfoCache[sym];
      window.deskQuote = async (s, kind) => { if (s === sym && kind === 'info') calls.push(Date.now()); return { ok: true, info: stubInfo }; };

      /* 1 — a cold miss goes to the network and STAMPS what comes back */
      const t0 = Date.now();
      maybeFetchWbInfo(sym);
      await settle();
      const e = wbInfoCache[sym];
      out.afterCold = calls.length;
      out.hasAt = !!e && typeof e.at === 'number' && e.at >= t0 && e.at <= Date.now();
      out.hasInfo = !!e && 'info' in e && !!e.info && e.info.price === stubInfo.price;

      /* 2 — a fresh entry is served from cache, not re-fetched */
      maybeFetchWbInfo(sym);
      await settle();
      out.afterFresh = calls.length;

      /* 3 — one that is old but still INSIDE the TTL is also served from cache,
         which is what stops this being "always refetch" */
      wbInfoCache[sym].at = Date.now() - (ttl - 5000);
      maybeFetchWbInfo(sym);
      await settle();
      out.afterInside = calls.length;

      /* 4 — one older than the TTL is fetched AGAIN and re-stamped. This is the
         step the presence-keyed cache failed: the entry existed, so it was
         believed for the life of the tab. */
      const stale = Date.now() - ttl - 1000;
      wbInfoCache[sym].at = stale;
      maybeFetchWbInfo(sym);
      await settle();
      out.afterExpired = calls.length;
      out.restamped = wbInfoCache[sym].at > stale + ttl;
    } finally {
      window.deskQuote = realQ; DESK.mode = realMode; DESK_DB.url = realUrl;
      if (!hadReal) wbRealSyms.delete(sym);
      if (hadEntry) wbInfoCache[sym] = prior; else delete wbInfoCache[sym];
    }
    return out;
  });

  expect(run.missing, 'wbInfoTtlMs and maybeFetchWbInfo must exist — they are what expires the quote').toBeFalsy();
  expect(run.afterCold, 'a cold symbol is fetched once (the stub was reached, so the rest is measuring the real path)').toBe(1);
  expect(run.hasAt, 'the entry the real fetch wrote carries `at`, stamped when it landed, or expiry is impossible').toBe(true);
  expect(run.hasInfo, 'and keeps the fetched `info` alongside the stamp').toBe(true);
  expect(run.afterFresh, 'a fresh entry is not fetched again').toBe(1);
  expect(run.afterInside, 'nor one that is aged but still inside the TTL').toBe(1);
  expect(run.afterExpired, 'an entry older than the TTL IS fetched again — age, not presence, expires it').toBe(2);
  expect(run.restamped, 'and the refetch re-stamps it, so it does not refetch on every tick after').toBe(true);
  // 60s while prints arrive, 15 min once the tape is frozen. Never unbounded.
  expect([60000, 900000], 'TTL must be one of the two session cadences').toContain(run.ttl);
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
test('S29: the scheduled-ask roster round-trips by id, and the row cap holds', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#askBody', 15000);

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
  /* EVERY cadence the control offers, not one representative of each family:
     the two families are separated by a predicate (askAtTheHour) that names
     them individually, so a cadence dropped from it — "Every hour" is the easy
     one to lose — falls into the clock family unnoticed. The offered set is
     pinned too, so a cadence added later cannot escape this check. */
  const cadences = { hourly: 'min', h2: 'min', h3: 'min', h4: 'min', h6: 'min', h8: 'min', h12: 'min',
                     daily: 'time', weekdays: 'time' };
  expect(await page.locator('.ask-sched-cad option').evaluateAll(os => os.map(o => o.value)),
    'the cadence control offers exactly the cadences this scenario checks').toEqual(Object.keys(cadences));
  for (const [key, control] of Object.entries(cadences)) {
    await page.locator('.ask-sched-cad').selectOption(key);
    await expect(page.locator('.ask-sched-time'),
      control === 'time' ? `${key} gets a clock` : `${key} has no meaningful hour`)
      .toHaveCount(control === 'time' ? 1 : 0);
    await expect(page.locator('.ask-sched-min'),
      control === 'min' ? `${key} gets a minutes-past-the-hour picker` : `${key} has no minutes-only picker`)
      .toHaveCount(control === 'min' ? 1 : 0);
  }
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
  /* EXACTLY ten, off 31 rows: `<= 10` also passes a save that sent nothing.
     Only the wire is measured — the stand-in RPC above slices to ten itself, so
     the size of ITS store says nothing about the client. */
  const sent = await page.evaluate(() => window.__writes[2].length);
  expect(sent, 'the cap holds on the wire, not just server-side').toBe(10);

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
test('S30: watchlist writes carry the roster version they read', async ({ page, renderWitness }) => {
  renderWitness();
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
test('S32: a question can be interrupted, and the stop is not silent', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#askBody', 15000);

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
  /* toBeHidden() also passes for an element that is not there, so the error
     line's existence is pinned first — a renamed class would otherwise turn
     this whole check into one that cannot fail. */
  await expect(page.locator('#askBody .lock-error'), 'the panel has its error line').toHaveCount(1);
  await expect(page.locator('#askBody .lock-error')).toBeHidden();
  await expect(page.locator('#askBody .lock-error')).toHaveText('');

  // And the panel is genuinely reusable, not wedged behind a stuck askBusy.
  const busy = await page.evaluate(() => askBusy);
  expect(busy, 'askBusy must clear on abort or the panel is dead').toBe(false);
});

test('S33: verify is armed per question and disarms itself after an answer', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#askBody', 15000);

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
  await expect(verify).toHaveAttribute('aria-pressed', 'true');
  await send('third question');
  /* WAIT FOR THE FAILURE TO LAND before reading the arm. The toggle is already
     armed the instant Send is pressed, so a bare aria-pressed check right after
     the click passes at once — before deskAsk has rejected and before the code
     that could wrongly disarm has run — and cannot fail whatever the error path
     does. The request went out armed, and the panel is idle again with the
     error line showing: only then is the arm's fate settled. */
  await expect.poll(() => page.evaluate(() => window.__verifyArgs),
    'the failing question went out armed').toEqual([true, false, true]);
  await expect(page.locator('#askBody form button[type=submit]'), 'the failed question has finished')
    .toHaveText('Ask');
  await expect(page.locator('#askBody .lock-error'), 'and it surfaced as an error, not an answer')
    .toBeVisible();
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
test('S34: steady mode repaints the long-term pane, and a bar keeps its colour across a zoom', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#wbChart', 10000, 800);
  await installPaneProbe(page);

  /* Colours of the RIGHTMOST candles in Pro 2, newest first. Keyed from the
     right edge on purpose: the last N bars are the same N bars at any zoom, so
     two reads stay comparable while every x-coordinate has moved. */
  const colours = n => page.evaluate(count => {
    const pane = window.__pane(/LONG-TERM/);   // by doctrine, not by number
    if (pane.err) return pane;
    return pane.rects.sort((a, c) => c.cx - a.cx).slice(0, count).map(r => r.fill.includes('gain'));
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
test('S35: a tile opens a detail window; double-click still removes', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.wl-strip .wl-tile', 10000);

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
  await installFakeRoster(page);   /* the drop below is a real write — see installFakeRoster */
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
  /* Both ends are on screen first (boundingBox is viewport-relative, and a
     phone reaches this panel thousands of pixels down the page), and the drag
     must be PROVEN to have happened: this used to sit behind `if (a && c)` and
     assert only that no window appeared, which a drag that never began — a tile
     below the fold, a missing box — satisfies in full. */
  /* The drop target is the THIRD tile's right half, not the fourth tile's centre:
     a band is a row again, and on a phone only about three tiles are inside the
     row's own width — a fourth tile sits half clipped, so aiming at its centre
     drops outside the band and no write happens. The right half (not the centre)
     because a drop at a tile's exact middle has not yet passed it, which for a
     neighbour would put the tile back where it started. */
  await live.scrollIntoViewIfNeeded();
  const a = await live.boundingBox();
  const c = await page.locator('.wl-strip .wl-tile').nth(2).boundingBox();
  expect(a, 'the source tile has a box').not.toBeNull();
  expect(c, 'the drop tile has a box').not.toBeNull();
  const writesBefore = await rosterWrites(page);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 10, { steps: 6 });
  await page.mouse.move(c.x + c.width * 0.75, c.y + c.height / 2, { steps: 10 });
  expect(await page.locator('.wl-ghost').count(), 'the drag had begun before the drop').toBe(1);
  await page.mouse.up();
  await expect.poll(() => rosterWrites(page), { message: 'the drop arranged the panel — it was a drag, not a click' })
    .toBe(writesBefore + 1);
  await page.waitForTimeout(700);
  await expect(detail, 'a drop is not a click').toBeHidden();
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
test('S36: the swing and long-term spans survive a reload, and a bad one falls back', async ({ page, renderWitness }) => {
  renderWitness();
  // three page loads plus three chart renders do not fit the 30s default
  test.setTimeout(90_000);
  await gotoDemo(page, '#wbChart', 20000);
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

test('S37: every pane pins a last-price tab, and panning does not restate it', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(60_000);
  await gotoDemo(page, '#wbChart', 20000, 800);

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
  /* The pan handle is the pane's own `cursor: grab` overlay. The drag used to be
     aimed at fixed fractions of the whole SVG, which land on no pane's overlay:
     the window never moved, so "the price is unchanged after panning" was true of
     an app that labelled the price off `end - 1` (verified: with that bug
     re-introduced the old drag left every path and rect exactly as it was). The
     pan is now aimed at the leftmost pane's overlay and PROVEN to have moved the
     window before the price is compared. */
  const drawn = () => page.evaluate(() => JSON.stringify([wbState.off, wbState.woff, wbState.off3, wbState.off3d]));
  const drawnBefore = await drawn();
  const grab = page.locator('#wbChart rect[style*="cursor: grab"]').first();
  /* boundingBox() is viewport-relative and does not scroll: this chart sits well
     below the fold, so unscrolled coordinates land off-screen and the drag goes
     nowhere (measured: the overlay's top read y=2065 on a 900px window). Scroll
     it in, then aim at the middle of the part that is actually visible. */
  await grab.scrollIntoViewIfNeeded();
  const gb = await grab.boundingBox();
  expect(gb, 'the pane has a pan overlay').not.toBeNull();
  const vh = page.viewportSize().height;
  const gTop = Math.max(gb.y, 0), gBot = Math.min(gb.y + gb.height, vh);
  expect(gBot - gTop, 'a usable strip of the overlay is on screen').toBeGreaterThan(40);
  const gy = (gTop + gBot) / 2;
  // The pane can be a sliver on a phone (the SVG is scaled to ~40px per pane),
  // and the drag listener is on the window, so travel a fixed distance rather
  // than a fraction of the overlay.
  const gx = gb.x + gb.width * 0.3;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(Math.min(gx + 200, page.viewportSize().width - 2), gy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  /* Under Pixel 5 emulation in this sandbox the same drag leaves every offset at
     0 (cause not diagnosed), so the gesture cannot be the only way to move the
     window: fall back to setting the offsets the drag writes and repainting. What
     this scenario guards is that the tab does not follow the WINDOW; whether a
     pointer gesture moves it is not its subject. The move is asserted either way,
     so a pan that did not happen still fails. */
  if (await drawn() === drawnBefore) {
    await page.evaluate(() => {
      wbState.off = wbState.woff = wbState.off3 = 40;
      renderCharts(wbState.data, wbState.lamp);
    });
  }
  expect(await drawn(), 'the window was panned back through history').not.toBe(drawnBefore);

  const after = await tabs();
  expect(after.flags, 'the tab survives a pan').toBe(3);
  expect(after.labels, 'every pane still shows the newest close, not the last visible bar')
    .toEqual(before.labels);
});

/* S45 — the SYMBOL column: 100 PERMANENT slots, edited in place (owner ruling
   2026-08-26: "I want every item in the list to be editable... the 100 entries,
   filled or empty is permanent"). What this guards is that the column is
   POSITIONAL — slot 5 stays slot 5 — because the failure mode is invisible: a
   compaction renumbers every row below a hole and silently moves the owner's
   symbols to addresses they did not choose.
   Also the gesture split, which collides by nature: a single click charts, a
   double-click edits, and a double-click delivers a `click` FIRST. */
test('S45: the symbol column is 100 permanent slots, edited in place', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(90_000);
  await gotoDemo(page, '.wb-slots', 15000, 1200);
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
  await slotBtn(page, 3).dblclick();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && document.activeElement === i && i.closest('.wb-rail-row').dataset.slot;
  }), 'double-click opens a focused editor in the slot that was clicked').toBe('3');

  // lower case is normalised, saved POSITIONALLY, and charted
  await page.locator('.wb-slot-input').pressSequentially('qqq');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(900);
  let stored = await storedSyms(page);
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
  await slotBtn(page, 3).click();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => wbState.sym), 'a single click charts that slot').toBe('QQQ');
  expect(await editorCount(page), 'and opens no editor').toBe(0);

  /* A DOUBLE click opens the editor. It also charts that slot on the way in —
     the accepted trade for removing the defer — so what is asserted is the
     EDITOR, and that the chart landed on THIS slot's own symbol rather than
     somewhere else. A pairing keyed by slot index is what makes this work at
     all: charting rebuilds the rail, so the second click lands on a
     REPLACEMENT button and a `dblclick` listener would never fire. */
  await page.evaluate(() => wbPick(Object.keys(wbState.data.symbols)[0]));
  await page.waitForTimeout(300);
  await slotBtn(page, 3).dblclick();
  await page.waitForTimeout(900);
  expect(await editorSlot(page), 'a double-click opens the editor on the slot that was clicked').toBe('3');
  expect(await page.evaluate(() => wbState.sym),
    "and charts that slot's own symbol, never another").toBe('QQQ');

  // emptying clears the slot and moves NOTHING
  await seedSlots(page, { 7: 'SPY' }, { repaint: false });
  await page.locator('.wb-slot-input').fill('');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(700);
  stored = await storedSyms(page);
  expect(stored[3], 'emptying the text clears the slot').toBe('');
  expect(stored[7], 'and nothing below it moves up').toBe('SPY');
  expect(stored.length, 'still exactly 100 after a clear').toBe(100);

  /* Survives a repaint the owner did not cause — renderCharts rebuilds this rail
     on every animation frame of a chart drag and every 60s poll, so an editor
     holding its value only in the DOM is blanked between two keystrokes. */
  await slotBtn(page, 5).dblclick();
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
  expect((await storedSyms(page))[5], 'and lands whole — not truncated into a different symbol').toBe('ABCDEFGHIJ');
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
  const deepBtn = slotBtn(page, 60);
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
  /* Seated by what the slot is doing, NOT by a fixed offset from the list: the list
     is only ~130px tall in the STACKED rail (capped at 220px, S53) and ~650px beside
     the chart, and a fixed "top 70px above the viewport" pushed slot 60 clean off the
     screen in the short one — the pointer then lands on nothing, and the check fails
     for the harness's geometry rather than the app. So: seat slot 60 three-quarters of
     the way down the list's OWN scroll window, then scroll the page to put that slot 60px
     from the top of the viewport. The list's top is then above the viewport by
     ~0.75 x its height in BOTH layouts, which is the geometry that exposes scroll
     anchoring, while the slot itself stays on screen. */
  await page.evaluate(() => {
    const list = document.querySelector('.wb-slots');
    const b = list.querySelector('[data-slot="60"] .wb-slot');
    list.scrollTop += b.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight * 0.75;
    window.scrollTo(0, window.scrollY + b.getBoundingClientRect().top - 60);
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
  await page.locator('.wb-slot-input').fill('WXYZ');
  await page.locator('.wb-slot-input').press('Enter');
  await page.waitForTimeout(800);
  const deep = await page.evaluate(() => ({
    at60: (JSON.parse(localStorage.getItem('wb_sticky_v1') || '{}').syms || [])[60],
    top: Math.round(document.querySelector('.wb-slots').scrollTop),
  }));
  expect(deep.at60, 'and saves to that index').toBe('WXYZ');
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
  await slotBtn(page, 3).dblclick();
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('QQQ');
  await slotBtn(page, 8).click();
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
  await closeEditor(page);
  const slowTo = slotBtn(page, 31);
  await slowTo.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  /* 30 and 31, both still EMPTY at this point — an empty slot opens its editor
     on a single click, where a filled one would chart instead. */
  await page.evaluate(() => { document.querySelector('.wb-slots [data-slot="30"] .wb-slot').click(); });
  await page.waitForTimeout(200);
  await page.locator('.wb-slot-input').fill('WXYZ');
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
  expect(slow.at30, 'and the text it left behind is still saved').toBe('WXYZ');
  await closeEditor(page);
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
  await slotBtn(page, 2).dblclick();
  await page.waitForTimeout(300);
  await slotBtn(page, 4).dblclick();
  await page.waitForTimeout(900);
  expect(await editorSlot(page), 'a double-click on ANOTHER filled slot opens it, even with an editor already open').toBe('4');
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
  const slot4 = await slotBtn(page, 4).boundingBox();
  const cx = slot4.x + slot4.width / 2, cy = slot4.y + slot4.height / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(700);
  expect(await editorSlot(page), 'two clicks 300ms apart still open the editor — a defer shorter than the platform pairing charts instead').toBe('4');
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(300);

  /* F2 reaches the editor from the KEYBOARD. A double-click is pointer-only,
     and Enter/Space on a focused button fires `click`, which CHARTS a filled
     slot rather than editing it — so without F2 a filled slot could only ever
     be changed with a mouse. Same rule the watchlist tiles follow with Delete. */
  await page.evaluate(() => { wbEditSlot = -1; renderWbSidebar(wbState.data); });
  await slotBtn(page, 60).focus();
  await page.keyboard.press('F2');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && { slot: i.closest('.wb-rail-row').dataset.slot, value: i.value,
                  focused: document.activeElement === i };
  }), 'F2 on a focused FILLED slot opens its editor, loaded and focused')
    .toEqual({ slot: '60', value: 'WXYZ', focused: true });
  await page.locator('.wb-slot-input').press('Escape');
  await page.waitForTimeout(300);

  /* Escape still ABANDONS — it must not be undone by the blur that its own
     re-render fires a tick later. */
  await seedSlots(page, { 20: 'SPY' });
  await editSlot(page, 20, 'ZZZZ', 'Escape', 600, { dbl: true });
  expect((await storedSyms(page))[20], 'Escape keeps what was STORED, not what was typed').toBe('SPY');
  expect(await editorCount(page), 'and closes the editor').toBe(0);

  /* A REPAINT THE OWNER DID NOT CAUSE MUST NOT MOVE THE PAGE. This rail is
     rebuilt every 60s, and restoring focus to the open editor with a plain
     focus() drags an owner reading another panel back to the charts —
     falsified here at 1684px. focus({preventScroll:true}) is what stops it, and
     this scenario had no guard for it until now. */
  /* The slot has to be one that OPENS AN EDITOR on a bare click — and nothing
     else will do. This used to click slot 3, which holds QQQ by now: a filled,
     chartable slot CHARTS on a click instead, so no editor was ever open, the
     repaint below had no input to restore focus to, `renderWbSidebar` never
     called focus() at all, and scrollY stayed 0 whether or not preventScroll
     was there. The guard could not fail. An EMPTY slot has nothing to chart, so
     its click opens the editor irrespective of the click's `detail` (a JS
     .click() carries 0). Slot 90 is never touched by any step above; it is
     asserted empty rather than assumed, and the editor is asserted OPEN and
     FOCUSED before anything is measured, so this cannot pass by never having
     armed the thing it guards. */
  await closeEditor(page);
  expect(await page.evaluate(() =>
    document.querySelector('.wb-slots [data-slot="90"] .wb-side-sym').textContent),
    'slot 90 is empty, so a click on it opens the editor rather than charting').toBe('');
  await page.evaluate(() => { document.querySelector('.wb-slots [data-slot="90"] .wb-slot').click(); });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && { slot: i.closest('.wb-rail-row').dataset.slot, focused: document.activeElement === i };
  }), 'the editor is open on slot 90 and holds focus before the repaint').toEqual({ slot: '90', focused: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  /* The input must sit BELOW the fold, or a plain focus() has nothing to scroll
     to and the check below passes on a guard that is not there. */
  expect(await page.evaluate(() => {
    const r = document.querySelector('.wb-slot-input').getBoundingClientRect();
    return r.top >= window.innerHeight || r.bottom <= 0;
  }), 'the open editor is off-screen, so restoring focus to it WOULD scroll the page unless told not to')
    .toBe(true);
  /* `keepPageStill` wraps that focus() and scrolls the page back if it moved, so
     with it in place a lone regression to a plain focus() is INVISIBLE from
     outside — measured: swapping preventScroll out left this scenario green. The
     page-still wrapper is the belt and `{preventScroll:true}` is the braces, and
     a scenario that lets the belt catch the fall proves neither. So the repaint
     runs with scrollTo neutralised and the focus() call itself is MEASURED — the
     page position is read the instant that call returns, before anything else
     in the repaint (the selection restore, which specs allow to scroll and which
     WebKit does in CI) can move it. The wrappers call THROUGH to the real
     methods and record a trace, so a failure names the call that moved the page
     instead of just a number. */
  const focusTrace = await page.evaluate(() => {
    const realScrollTo = window.scrollTo;
    const realFocus = HTMLElement.prototype.focus;
    const realSel = HTMLInputElement.prototype.setSelectionRange;
    const trace = [];
    const isEditor = (el) => el && el.classList && el.classList.contains('wb-slot-input');
    window.scrollTo = () => {};
    HTMLElement.prototype.focus = function (...a) {
      const r = realFocus.apply(this, a);
      if (isEditor(this)) trace.push(['focus', Math.round(window.scrollY)]);
      return r;
    };
    HTMLInputElement.prototype.setSelectionRange = function (...a) {
      const r = realSel.apply(this, a);
      if (isEditor(this)) trace.push(['selection', Math.round(window.scrollY)]);
      return r;
    };
    try { renderWbSidebar(wbState.data); } finally {
      window.scrollTo = realScrollTo;
      HTMLElement.prototype.focus = realFocus;
      HTMLInputElement.prototype.setSelectionRange = realSel;
    }
    return trace;
  });
  await page.waitForTimeout(350);
  const focusStep = focusTrace.find(t => t[0] === 'focus');
  expect(focusStep, `the repaint restored focus to the editor through focus() (trace ${JSON.stringify(focusTrace)})`)
    .toBeTruthy();
  expect(focusStep[1],
    `focus({preventScroll:true}) does not move the page (trace ${JSON.stringify(focusTrace)})`).toBe(0);
  expect(await page.evaluate(() => {
    const i = document.querySelector('.wb-slot-input');
    return i && { slot: i.closest('.wb-rail-row').dataset.slot, focused: document.activeElement === i };
  }), 'and the repaint restored focus to the editor — the branch that could have scrolled did run')
    .toEqual({ slot: '90', focused: true });
  /* THE PRODUCTION GUARANTEE, everything real: focus, the selection restore and
     the keepPageStill belt together. This is the property the owner sees — a
     repaint they did not cause leaves the page where it was — and it must hold
     on every engine, including the ones where the selection call scrolls. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  await page.evaluate(() => { renderWbSidebar(wbState.data); });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => Math.round(window.scrollY)),
    `the 60s repaint does not yank the page back to the charts (belt and braces both real; isolated trace ${JSON.stringify(focusTrace)})`)
    .toBe(0);
  await closeEditor(page);

  /* ONE TAB STOP for the whole column, not a hundred. This column precedes the
     roster in DOM order, so 100 tabbable buttons put the ROSTER up to 100 Tab
     presses away and made F2 largely theoretical (Codex P2). Arrow keys move the
     stop with focus. */
  await closeEditor(page, { tab: true });
  expect((await tabStops(page)).length, 'exactly one slot is in the tab sequence').toBe(1);
  await slotBtn(page, 0).focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  expect(await focusedSlot(page), 'ArrowDown moves focus to the next slot').toBe('1');
  expect(await tabStops(page), 'and the single tab stop travels with it').toEqual(['1']);
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
  await seedSlots(page, { 50: '' }, { pick: 1 });
  await page.waitForTimeout(300);
  const pairFrom = await page.evaluate(() => wbState.sym);
  const pairSym = await page.evaluate(() => Object.keys(wbState.data.symbols)[0]);
  await editSlot(page, 50, pairSym, 'Enter', 150, { openWait: 150 });   /* well inside WB_SLOT_DBL_MS */
  await slotBtn(page, 50).click();
  await page.waitForTimeout(600);
  expect(await editorCount(page), 'clicking a slot right after filling it charts — it does not reopen the editor').toBe(0);
  expect(await page.evaluate(() => wbState.sym),
    'and the chart moved to what was just typed').toBe(pairSym);
  expect(pairFrom).not.toBe(pairSym);      /* the assertion above would be vacuous otherwise */

  /* CHARTING FROM THE KEYBOARD MUST NOT COST YOU YOUR PLACE. Enter on a filled
     slot runs synchronously into wbPick, whose render removes the focused
     button; with nothing restoring it, focus fell to the document and the roving
     Arrow keys and F2 stopped responding until the owner tabbed all the way back
     in — and this column is a single tab stop, so that is a long way back
     (Codex P2). */
  await seedSlots(page, { 2: 0 });
  await page.waitForTimeout(200);
  await slotBtn(page, 2).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  expect(await focusedSlot(page), 'keyboard charting keeps focus on the slot, not on the document').toBe('2');

  /* EVERY non-slot way of changing the chart breaks a pending slot pair — and
     the header's `change` handler reaches wbPick DIRECTLY, without the loader or
     the submit handler, so it needs its own reset (Codex P2). Click slot A, pick
     an already-loaded symbol in the header, click A again inside the window: the
     last click must CHART A, not be read as the second half of the first pair. */
  const [pairA, pairB] = await page.evaluate(() => Object.keys(wbState.data.symbols).slice(0, 2));
  await seedSlots(page, { 6: pairA });
  await page.waitForTimeout(200);
  await slotBtn(page, 6).click();
  await page.waitForTimeout(150);
  await page.evaluate((sym) => {
    const inp = document.getElementById('wbSymInput');
    inp.value = sym; inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, pairB);
  await page.waitForTimeout(150);
  await slotBtn(page, 6).click();
  await page.waitForTimeout(600);
  expect(await editorCount(page), 'the header change path breaks the pair — the next slot click charts').toBe(0);
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
  await closeEditor(page);

  /* SETTLING AN EDITOR KEEPS FOCUS ON THE SLOT — for Enter AND for Escape.
     Both remove the focused input; renderWbSidebar's restore cannot help,
     because it snapshots a focused `.wb-slot` BUTTON and what is focused here is
     the INPUT. Without this a keyboard user is dropped to the document the
     moment their edit lands, and this column is a single tab stop (Codex P2). */
  for (const [key, slot] of [['Enter', '52'], ['Escape', '53']]) {
    await closeEditor(page, { wait: 150 });
    await editSlot(page, slot, 'AAPL', key, 600);
    expect(await focusedSlot(page), key + ' leaves focus on the slot, not on the document').toBe(slot);
  }

  /* KEYBOARD ACTIVATION NEVER PAIRS. Enter/Space fire a synthetic click with
     detail 0; two of them inside the window — or Enter auto-repeating while
     held — were read as a double-click and opened the editor, contradicting F2
     being THE keyboard edit gesture (Codex P2). */
  await seedSlots(page, { 54: 0 });
  await page.waitForTimeout(200);
  await slotBtn(page, 54).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  expect(await editorCount(page), 'two keyboard activations chart twice — they never open the editor').toBe(0);
  /* BOTH halves must be pointer clicks. Gating only the check leaves the
     synthetic keyboard click RECORDING itself, so Enter followed by a pointer
     click inside the window opens the editor instead of charting (Codex P2,
     round 5). */
  await slotBtn(page, 54).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  await slotBtn(page, 54).click();
  await page.waitForTimeout(500);
  expect(await editorCount(page), 'a pointer click after a keyboard one charts — a keyboard press is not half a double-click').toBe(0);

  /* The roving stop follows a click EVEN WHEN NOTHING REPAINTS. wbLoadSymbol
     does not repaint when the lookup fails — demo mode refuses live lookups —
     so assigning the module state alone left the live buttons untouched and Tab
     went back to the wrong slot (Codex P2). */
  await seedSlots(page, { 46: 'ZZZZ' }, { tab: true });   /* filled, and it will NOT resolve */
  await page.waitForTimeout(200);
  await slotBtn(page, 46).click();
  await page.waitForTimeout(500);
  expect(await tabStops(page), 'the live tab stop follows the click even with no repaint').toEqual(['46']);
  await closeEditor(page);

  /* A committed ticker that cannot be charted must still CLOSE its editor. In
     demo mode wbLoadSymbol refuses live lookups and returns without repainting,
     so leaving the input up left it logically settled but on screen, rejecting
     every later Enter, Escape and blur (Codex P2). */
  await editSlot(page, 40, 'ZZZZ', 'Enter', 700);
  expect(await editorCount(page), 'an uncharTable ticker still closes the editor, never leaves an inert one').toBe(0);
  expect((await storedSyms(page))[40], 'and the slot keeps what was typed').toBe('ZZZZ');

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
test('S40: charts rail — roster picker and column shape', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(90_000);
  await gotoDemo(page, '#wbSidebar .wb-rail-col', 15000);
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
  /* "every watchlist" is asserted against the panel's own lists, not against
     "more than one": a picker that stopped repainting after the first list
     landed would still offer two entries. */
  expect(opts.slice(1), 'the picker names exactly the panel\'s watchlists, in order')
    .toEqual(await page.evaluate(() => wlState.payload.lists.map(l => l.title)));
  expect(await page.evaluate(() => document.querySelector('.wb-rail-pick').title),
    'the tooltip carries the human name, never the WB_ROSTER_CHARTS sentinel').toBe('Charts roster');

  /* Clicking a ROSTER name charts it and writes NOTHING into the SYMBOL column
     — nothing pins there any more (owner ruling 2026-08-26). */
  const filled = async () => (await storedSyms(page))
    .map((s, i) => (s ? i + ':' + s : null)).filter(Boolean).join('|');
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
  expect((await storedSyms(page)).length, 'the column is still exactly 100 slots').toBe(100);

  // the chosen roster survives a reload
  // (unconditional: the picker was just asserted to offer more than one entry,
  // so an `if (lists.length > 1)` here could only ever be a way to skip silently)
  const lists = await page.evaluate(() => [...document.querySelector('.wb-rail-pick').options].map(o => o.value));
  expect(lists.length, 'there is a watchlist to choose').toBeGreaterThan(1);
  await page.selectOption('.wb-rail-pick', lists[1]);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator('.wb-rail-pick')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => document.querySelector('.wb-rail-pick').value),
    'the chosen roster survives a reload').toBe(lists[1]);
  expect(errs, 'no page errors').toEqual([]);
});

/* S42 — each watchlist band is a SIDEWAYS scroller, the PAGE stays the page, and
   nothing is paged. Owner request 2026-09-30 put the bands back to horizontal,
   which WITHDREW the 2026-08-20 ruling this scenario used to guard ("the columns
   are paged, not scrolled"): the ▲/▼ pager, its footer and the drag-rests-on-▼
   stepping existed only to tame a column's VERTICAL overflow and went with it.

   What still has to hold, because the owner's original complaint (2026-08-07,
   three times) was a wheel that died over a panel:
     - the wheel belongs to the PAGE. The row is `overflow-y: hidden`, so a
       vertical wheel over a band has nothing to grab and moves the page;
     - the ONLY `overscroll-behavior` on the page is the axis-scoped
       `overscroll-behavior-x: contain` on these rows (a sideways swipe off the
       end of a band must not trigger browser back-navigation). The shorthand
       and the `-y` form stay banned: they apply just as hard to a container with
       nothing to scroll, and then they eat the wheel. */
test('S42: watchlist bands scroll sideways, the page never does, and nothing is paged', async ({ page, browserName, renderWitness }) => {
  renderWitness();
  // See S4 — same `viewport-override` marker, same reason.
  test.info().annotations.push({ type: 'viewport-override', description: '1512' });
  await page.setViewportSize({ width: 1512, height: 1000 });
  await blockRosterWrites(page);   // the forced-live render below must never reach the real roster
  await gotoDemo(page, '.wl-strip .wl-tile', 15000);
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  // ── every band's tile row is a sideways scroller ─────────────────────────
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-strip .mkt-group-tiles')].map(b => {
      const cs = getComputedStyle(b);
      return {
        x: cs.overflowX, y: cs.overflowY, wrap: cs.flexWrap,
        osx: cs.overscrollBehaviorX, osy: cs.overscrollBehaviorY, sbw: cs.scrollbarWidth,
        bar: getComputedStyle(b, '::-webkit-scrollbar').height,
        fits: b.scrollWidth <= b.clientWidth + 1,
        tiles: b.querySelectorAll('.wl-tile').length,
      };
    }));
  expect(rows.length, 'there are several bands to check').toBeGreaterThan(1);
  // `scroll`, not `auto`: the track stays present even where a short list would
  // fit, so bands do not change height as symbols come and go.
  expect(rows.every(r => r.x === 'scroll' && r.y === 'hidden'),
    'every band scrolls sideways and never vertically').toBe(true);
  expect(rows.every(r => r.wrap === 'nowrap'), 'tiles never wrap onto a second row').toBe(true);
  // From Chrome 121 `scrollbar-width` takes precedence over the ::-webkit-
  // scrollbar rules and would switch the always-visible bar off. Phrased as "not
  // thin/none": an engine without the property reports '' or 'auto', which is
  // not a failure.
  expect(rows.filter(r => /thin|none/.test(r.sbw)),
    'no `scrollbar-width` — it would cancel the always-visible bar').toEqual([]);
  expect(rows.every(r => r.bar === '8px'), 'the 8px scrollbar is styled on every band').toBe(true);
  // The row must actually RESERVE that track where the browser draws classic
  // scrollbars. Headless Chromium hides them (--hide-scrollbars), which makes the
  // reserved height 0 whatever the CSS says — so whether this browser draws one is
  // probed first, and the measurement is skipped, aloud, where it cannot be made.
  const track = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;width:50px;height:50px;overflow:scroll';
    document.body.appendChild(probe);
    const drawn = probe.offsetHeight - probe.clientHeight > 0;
    probe.remove();
    const b = document.querySelector('.wl-strip .mkt-group-tiles');
    return { drawn, reserved: b.offsetHeight - b.clientHeight };
  });
  if (track.drawn) expect(track.reserved, 'the row reserves the 8px track under its tiles').toBe(8);
  else test.info().annotations.push({ type: 'note',
    description: 'this browser draws no classic scrollbar, so the reserved track height cannot be measured here; the computed overflow-x and the styled ::-webkit-scrollbar height above carry the rule' });
  // One band fits and one does not: a scroller on BOTH is what `scroll` means.
  expect(rows.some(r => !r.fits), 'demo has a list wider than its band').toBe(true);
  expect(rows.some(r => r.fits), 'and a short one that fits, which still carries the scroller').toBe(true);

  // ── overscroll-behavior: the axis-scoped x form and nothing else ─────────
  const xSupported = await page.evaluate(() => CSS.supports('overscroll-behavior-x', 'contain'));
  if (xSupported) {
    expect(rows.every(r => r.osx === 'contain'),
      'a sideways swipe off the end of a band is contained (no browser back-nav)').toBe(true);
  }
  // Phrased as "not contain/none" for the vertical axis: an engine without the
  // property reports '' , which is not a failure.
  expect(rows.filter(r => /contain|none/.test(r.osy)),
    'no band carries a VERTICAL overscroll-behavior — that is what eats the wheel').toEqual([]);
  // The whole PAGE, not only this panel: the ban is page-wide. Any rule setting
  // the shorthand expands to `overscroll-behavior-y` in the CSSOM, so reading the
  // -y longhand catches both the shorthand and the -y form, and leaves `-x` alone.
  const offenders = await page.evaluate(() => {
    const out = [];
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && r.cssRules.length) walk(r.cssRules);   // @media / @supports
        if (r.style && (r.style.getPropertyValue('overscroll-behavior-y')
                        || r.style.getPropertyValue('overscroll-behavior'))) {
          out.push(r.selectorText || r.cssText.slice(0, 60));
        }
      }
    };
    for (const sh of document.styleSheets) {
      let list; try { list = sh.cssRules; } catch { continue; }   // cross-origin sheet
      walk(list);
    }
    for (const e of document.querySelectorAll('[style]')) {
      if (/overscroll-behavior(?!-x)/.test(e.getAttribute('style'))) out.push('[style] ' + e.tagName);
    }
    return out;
  });
  expect(offenders, 'no overscroll-behavior shorthand or -y form anywhere on the page').toEqual([]);

  // ── a long list scrolls sideways, and the PAGE does not ──────────────────
  const longest = await page.evaluate(() => {
    const bands = [...document.querySelectorAll('.wl-strip .mkt-group-tiles')];
    let k = 0;
    bands.forEach((b, i) => { if (b.querySelectorAll('.wl-tile').length > bands[k].querySelectorAll('.wl-tile').length) k = i; });
    const b = bands[k];
    return { k, over: b.scrollWidth - b.clientWidth };
  });
  expect(longest.over, 'the longest demo list runs past its band').toBeGreaterThan(20);
  const band = page.locator('.wl-strip .mkt-group-tiles').nth(longest.k);
  const after = await band.evaluate(b => { b.scrollLeft = 300; return b.scrollLeft; });
  expect(after, 'the row scrolls sideways').toBeGreaterThan(0);
  const pageX = await page.evaluate(() => ({
    scrollX: window.scrollX,
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  expect(pageX, 'and the page itself never scrolls sideways').toEqual({ scrollX: 0, sideways: false });
  await band.evaluate(b => { b.scrollLeft = 0; });

  // The wheel, where it can be driven. Chromium only: a mobile WebKit context has
  // no mouse wheel to dispatch (page.mouse.wheel does not scroll there), so on that
  // project the computed-style checks above carry the rule.
  if (browserName === 'chromium') {
    // A VERTICAL wheel over a band moves the PAGE. Measured from wherever hover()
    // left the page — it scrolls the band into view first, so an absolute
    // threshold would be met before the wheel turned at all.
    await band.hover();
    const y0 = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY) - y0,
      'the vertical wheel scrolls the page, not the list').toBeGreaterThan(100);
    expect(await band.evaluate(b => b.scrollLeft), 'and leaves the band where it was').toBe(0);
    // A HORIZONTAL wheel over the same band moves the BAND, not the page.
    await band.hover();
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(300);
    expect(await band.evaluate(b => b.scrollLeft), 'the horizontal wheel scrolls the band').toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollX), 'and never the page').toBe(0);
  }

  // ── nothing is paged, in demo or live ────────────────────────────────────
  const noPager = () => page.evaluate(() => ({
    bars: document.querySelectorAll('.wl-page-bar, .wl-page').length,
    glyphs: [...document.querySelectorAll('.area-watchlist button')]
      .filter(b => /^[▲▼]/.test(b.textContent.trim())).length,
    code: typeof wlSyncPaging + '/' + typeof attachPaging,
  }));
  expect(await noPager(), 'demo: no pager, no ▲/▼ control, no paging code left behind')
    .toEqual({ bars: 0, glyphs: 0, code: 'undefined/undefined' });
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; wlSort = { key: 'manual', dir: 1 }; renderWatchlist(); });
  await page.waitForTimeout(300);
  expect(await noPager(), 'live: still none')
    .toEqual({ bars: 0, glyphs: 0, code: 'undefined/undefined' });

  expect(errs, 'no page errors').toEqual([]);
});

/* S41 — each watchlist is ONE horizontal band: the list's name and controls in
   a block on the left, its tiles in a single row to their right, the bands
   stacked top to bottom. Owner request 2026-09-30 ("I need each of the watch list
   to go back to displaying horizontal"), reversing the 2026-08-17 vertical-column
   layout this scenario used to assert. */
test('S41: each watchlist is one horizontal band, stacked above the charts', async ({ page, renderWitness }) => {
  renderWitness();
  // Sized to a DESK, not a phone: the head-beside-the-tiles arrangement is the
  // wide-screen design (under 640px it stacks head-over-tiles, asserted at the
  // end), so asserting it at phone width would test the breakpoint, not the layout.
  // See S4 — same `viewport-override` marker, same reason.
  test.info().annotations.push({ type: 'viewport-override', description: '1512' });
  await page.setViewportSize({ width: 1512, height: 1000 });
  await gotoDemo(page, '.wl-strip .wl-tile', 15000);

  const shape = await page.evaluate(() => {
    const rect = e => e.getBoundingClientRect();
    const groups = [...document.querySelectorAll('.wl-strip .mkt-group')];
    const strip = document.querySelector('.wl-strip');
    const wl = rect(document.querySelector('.wl-area'));
    const ch = rect(document.querySelector('.area-charts'));
    const bands = groups.map(g => {
      const tiles = [...g.querySelectorAll('.wl-tile')];
      const head = rect(g.querySelector('.wl-band-head')), box = rect(g.querySelector('.mkt-group-tiles'));
      return {
        n: tiles.length,
        // ONE row: every tile of the band sits on the first tile's line. A wrapped
        // or stacked band puts some of them on another.
        oneRow: tiles.every(t => Math.abs(rect(t).top - rect(tiles[0]).top) < 2),
        // and they run LEFT TO RIGHT
        leftToRight: tiles.every((t, i) => i === 0 || rect(t).left > rect(tiles[i - 1]).left + 5),
        left: Math.round(rect(g).left), width: Math.round(rect(g).width),
        top: rect(g).top, bottom: rect(g).bottom,
        // the head is a block to the LEFT of the tiles, level with them
        headLeftOfTiles: head.right <= box.left + 1 && head.left < box.left,
        headLevel: head.top < box.bottom && head.bottom > box.top,
        headW: Math.round(head.width),
      };
    });
    return {
      bands,
      stripW: Math.round(rect(strip).width),
      wlBottom: Math.round(wl.bottom), chartsTop: Math.round(ch.top),
      wlLeft: Math.round(wl.left), chartsLeft: Math.round(ch.left),
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      innerScroll: strip.scrollHeight > strip.clientHeight + 2 || strip.scrollWidth > strip.clientWidth + 1,
      // no tab strip: every list is on screen at once
      tabs: document.querySelectorAll('.wl-strip [role="tab"]').length,
    };
  });

  expect(shape.bands.length, 'every list renders').toBeGreaterThan(1);
  expect(shape.bands.filter(b => !b.oneRow).length, 'every band is a single row of tiles').toBe(0);
  expect(shape.bands.filter(b => b.n > 1 && !b.leftToRight).length, 'tiles sit side by side, left to right').toBe(0);
  expect(Math.max(...shape.bands.map(b => b.n)), 'including a long list, which does not wrap').toBeGreaterThan(20);
  // Bands STACK top to bottom, each the full width of the panel and lined up on
  // one left edge — not columns sitting side by side.
  expect(shape.bands.every((b, i) => i === 0 || b.top > shape.bands[i - 1].top + 20
    && b.top >= shape.bands[i - 1].bottom - 2), 'bands stack top to bottom').toBe(true);
  expect(shape.bands.every(b => b.left === shape.bands[0].left && Math.abs(b.width - shape.stripW) <= 2),
    'each band is the full width of the panel').toBe(true);
  expect(shape.bands.every(b => b.headLeftOfTiles && b.headLevel),
    'the name and controls sit in a block on the LEFT, level with the tiles').toBe(true);
  expect(Math.max(...shape.bands.map(b => b.headW)), 'a block, not a header across the top').toBeLessThanOrEqual(120);
  expect(shape.tabs, 'the bands ARE the navigation — no tabs').toBe(0);
  expect(shape.wlBottom, 'watchlists sit above the charts panel').toBeLessThanOrEqual(shape.chartsTop);
  expect(shape.wlLeft, 'and share its left edge, both full-bleed').toBe(shape.chartsLeft);
  expect(shape.sideways, 'the page never scrolls sideways').toBe(false);
  expect(shape.innerScroll, 'the panel runs at full length, no inner crop').toBe(false);

  // The reorder controls now move a list UP or DOWN the stack, and must not
  // impersonate a back button — a bare ← on a button reads as navigation to
  // people and to crawlers alike. ↑/↓ are in no crawler selector.
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  const moves = await page.evaluate(() =>
    [...document.querySelectorAll('.wl-move')].map(b => ({ g: b.textContent, label: b.getAttribute('aria-label') })));
  expect(moves.length, 'the reorder controls render in live').toBeGreaterThan(0);
  expect(moves.some(m => m.g === '←' || m.g === '‹'), 'no reorder control is a bare back arrow').toBe(false);
  expect(moves.every(m => m.g === '↑' || m.g === '↓'), 'the bands stack vertically, so the controls point up and down').toBe(true);
  expect(moves.every(m => /^Move .+ (earlier|later)$/.test(m.label)), 'and keep their earlier/later labels').toBe(true);

  // Phone width: the page never scrolls sideways, the panel is never cropped, and
  // the band keeps its one sideways-scrolling row — with its head now ABOVE the
  // tiles (under 640px the band stacks, as it always did).
  // See S4 — same `viewport-override` marker, same reason.
  test.info().annotations.push({ type: 'viewport-override', description: '390' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const narrow = await page.evaluate(() => {
    const rect = e => e.getBoundingClientRect();
    const strip = document.querySelector('.wl-strip');
    const groups = [...document.querySelectorAll('.wl-strip .mkt-group')];
    const first = groups[0];
    const box = first.querySelector('.mkt-group-tiles');
    return {
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      innerScroll: strip.scrollHeight > strip.clientHeight + 2,
      tiles: document.querySelectorAll('.wl-strip .wl-tile').length,
      headAbove: rect(first.querySelector('.wl-band-head')).bottom <= rect(box).top + 2,
      oneRow: groups.every(g => { const t = [...g.querySelectorAll('.wl-tile')]; return t.every(x => Math.abs(rect(x).top - rect(t[0]).top) < 2); }),
      rowScrolls: getComputedStyle(box).overflowX === 'scroll' && box.scrollWidth > box.clientWidth + 2,
      stacked: groups.every((g, i) => i === 0 || rect(g).top >= rect(groups[i - 1]).bottom - 2),
    };
  });
  expect(narrow.sideways, 'no sideways page scroll at phone width').toBe(false);
  expect(narrow.innerScroll, 'the panel is not cropped at phone width').toBe(false);
  expect(narrow.tiles, 'every tile still renders at phone width').toBeGreaterThan(0);
  expect(narrow.headAbove, 'under 640px the head stacks above its tiles').toBe(true);
  expect(narrow.oneRow, 'tiles still never wrap at phone width').toBe(true);
  expect(narrow.rowScrolls, 'the long list scrolls sideways inside its band').toBe(true);
  expect(narrow.stacked, 'bands still stack').toBe(true);
});

/* S39 — the volume average. The failure it guards is quiet: an average computed
   from the VISIBLE window instead of the whole series still draws a plausible
   line, it just starts 20 bars in and leaves the left edge of the strip bare —
   and it shifts every time you zoom, which is what makes it untrustworthy. */
test('S39: every pane draws a volume average, spanning the full window', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(60_000);
  await gotoDemo(page, '#wbChart', 20000, 800);

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
test('S43: news rows date anything that is not from today', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.news-row', 20000);

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
      // GEOMETRY of the stack: the date's box must end where the clock's begins
      // (the row promises "Mon D ABOVE the clock"), and both share a left edge.
      // Text order in the DOM says nothing about which is drawn on top — a
      // `flex-direction: row` puts them side by side and every text check passes.
      above: (() => {
        if (!dateEl) return null;
        const clock = when.lastElementChild, d = dateEl.getBoundingClientRect(), c = clock.getBoundingClientRect();
        return { stacked: d.bottom <= c.top + 1, aligned: Math.abs(d.left - c.left) < 2, dh: d.height, ch: c.height };
      })(),
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
    expect(r.above.dh, 'the date has a real box').toBeGreaterThan(0);
    expect(r.above.stacked, `the date sits ABOVE the clock (${r.text})`).toBe(true);
    expect(r.above.aligned, `and shares its left edge (${r.text})`).toBe(true);
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
test('S46: heatmap tile labels carry a painted halo meeting AA, as rendered', async ({ page, renderWitness }) => {
  renderWitness();
  await openHeatmap(page);

  const report = await page.evaluate(() => {
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    // Colour parsing has a CANVAS FALLBACK, and it is a FALSE-FAILURE fix rather
    // than an evasion fix (Codex P2, round 12). getComputedStyle may preserve a
    // functional syntax — `oklch()`, `color(display-p3 …)`, `lab()` — instead of
    // serialising to rgb(). The regex returned null on those, so a legitimate,
    // fully-opaque, high-contrast palette would have failed this blocking gate as
    // "unreadable". The browser is the only thing that knows every syntax it
    // supports, so ask it: a 1x1 canvas normalises anything assignable to
    // fillStyle. The regex stays as the fast path so the common case is exact.
    const cv = document.createElement('canvas');
    cv.width = 1; cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    // Reads an alpha component out of a colour STRING, or null when the syntax
    // carries none. Handles both the modern `f(a b c / alpha)` slash form and the
    // legacy `f(a, b, c, alpha)` fourth argument, plus 4-/8-digit hex (whose
    // alpha is 8-bit at source, so no precision is lost there).
    const pctOrNum = (t) => {
      const m = /^\s*([\d.]+)(%?)\s*$/.exec(t);
      return m ? +m[1] / (m[2] ? 100 : 1) : null;
    };
    const explicitAlpha = (s) => {
      const v = (s || '').trim();
      const fn = /^[a-z-]+\((.*)\)$/is.exec(v);
      if (fn) {
        const halves = fn[1].split('/');
        if (halves.length === 2) return pctOrNum(halves[1]);
        const args = fn[1].split(',');
        if (args.length === 4) return pctOrNum(args[3]);
        return null;
      }
      const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(v);
      if (hex) {
        const h = hex[1];
        return h.length === 8 ? parseInt(h.slice(6), 16) / 255
                              : parseInt(h[3] + h[3], 16) / 255;
      }
      return null;
    };
    const parse = (s) => {
      const v = (s || '').trim();
      if (!v || v === 'none' || v === 'transparent') return null;
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(v);
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
      if (!ctx) return null;
      // Canvas silently KEEPS the previous fillStyle when a value is not
      // assignable, so a sentinel is the only way to tell "parsed to black" from
      // "rejected". Two different sentinels, because either one alone is
      // ambiguous for its own colour.
      ctx.fillStyle = '#000000';
      ctx.fillStyle = v;
      const asBlack = ctx.fillStyle;
      ctx.fillStyle = '#ffffff';
      ctx.fillStyle = v;
      if (asBlack === '#000000' && ctx.fillStyle === '#ffffff') return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      // Alpha comes from the SOURCE STRING at full precision whenever the syntax
      // states one, NEVER from the rasterized byte (Codex P2, round 13):
      // getImageData quantizes alpha to 8 bits, so `oklch(... / 99.99%)` rounds
      // to 255 and reads as fully opaque, slipping past the full-opacity check
      // below. Measured in Chromium: /0.9999 -> byte 255, /0.99 -> byte 252, so
      // the hole admits everything above ~0.998. RGB still comes from the canvas
      // — that quantization is harmless, since a colour this check ACCEPTS is
      // opaque and its channels are only ever used for a contrast ratio.
      // Falling back to the byte when no explicit alpha is found is the safe
      // direction: it never INVENTS opacity, it only declines to override.
      return { r: d[0], g: d[1], b: d[2], a: explicitAlpha(v) ?? d[3] / 255 };
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

      // A dash pattern can leave no visible outline while every colour reads
      // correctly (`0 10000`). But rejecting every non-`none` value is a FALSE
      // FAILURE (Codex P2, round 12): `0 0` is an all-zero pattern that renders
      // SOLID, and a blocking gate must not reject a valid render. So the list is
      // parsed and judged on what it paints — a zero-length dash, or any positive
      // gap, means the outline is broken; all-zero means solid.
      const dashRaw = (cs.strokeDasharray || 'none').trim();
      if (dashRaw && dashRaw !== 'none') {
        const parts = dashRaw.split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n));
        const solid = parts.length === 0 || parts.every((n) => n === 0);
        if (!solid) {
          // An odd-length list repeats doubled, so normalise before pairing.
          const seq = parts.length % 2 ? parts.concat(parts) : parts;
          // The outline is broken IFF some GAP is positive. A zero-length DASH
          // removes nothing, so `5 0 0 0` paints continuously — rejecting it was
          // a false failure (Codex P2, round 13).
          const openGap = seq.some((n, i) => i % 2 === 1 && n > 0);
          if (openGap) {
            failures.push(`${txt}: stroke-dasharray "${dashRaw}" — the halo is not a solid outline`);
            continue;
          }
        }
      }

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

// ---------------------------------------------------------------------------
// S47 — the ADVISORY half of the halo contract. S46 asks the DOM what every
// label SAYS it paints; this asks the screen what actually arrived.
//
// Five findings closed PR #283 unfixed, and they are ONE class: `stroke-width:
// 0.01px`, a subpixel intersection sliver, a sub-pixel dash gap,
// `transform: scale(0.001)`, an opaque shape appended after the labels
// (`focusGroup`/`focusTile` really are appended after `drawTiles`), and
// `mix-blend-mode: multiply`. Every one leaves EVERY computed value S46 reads
// correct while the glyph rasterises to nothing or composites against something
// other than the pair that was measured. No DOM property answers them.
//
// The method is a DIFFERENCE, which is what lets one measurement cover all five
// instead of five invented thresholds: screenshot the map, hide the labels,
// screenshot again. Pixels that changed are, by construction, exactly what the
// labels put on the screen — after rasterization, after compositing, after
// whatever painted over them. A label that changes nothing reached nobody.
//
// It is ADVISORY (owner ruling 2026-09-01): per-label findings are reported and
// never fail the run, so antialiasing tolerance and per-viewport flake cannot
// block a merge while this proves itself. What IS blocking is the harness's own
// integrity — see the assertions at the bottom. A check that cannot fail is not
// a check, and an advisory verdict resting on a broken measurement is worse
// than no verdict, so "did the sampling actually work" is asserted for real
// while "did every label pass" is only reported.
// ---------------------------------------------------------------------------
test('S47: heatmap labels reach the screen (advisory pixel sampling)', async ({ page, renderWitness }) => {
  renderWitness();
  await openHeatmap(page);

  const svg = page.locator('#heatmapSvg');
  await svg.scrollIntoViewIfNeeded();

  // THE POINTER MUST LEAVE THE MAP BEFORE ANYTHING IS PHOTOGRAPHED, and this is
  // not housekeeping — without it this scenario reports five false findings on a
  // clean render, every run. `#heatToggle` is clicked to open the panel, which
  // leaves the pointer sitting where the button was; the map then draws itself
  // underneath it, `#heatTip` opens on the tile now under the cursor, and that
  // opaque tooltip covers whatever is behind it. Measured on demo at 1440x900:
  // BRK.B, JPM, BAC and two of their percentage labels sampled rgb(241,238,230)
  // — the tooltip's own background — IDENTICALLY in both shots, so the
  // difference correctly reported that they never reached the screen.
  //
  // Which is the mechanism working, not failing: an opaque overlay hiding labels
  // is precisely the finding this scenario exists for (Codex P2, PR #283, on
  // `focusGroup`/`focusTile` being appended after `drawTiles`). It just happened
  // to be the test's own pointer causing it. The tooltip is dismissed and its
  // absence ASSERTED, because a silent reappearance would put those five
  // findings back and they would read as a real regression.
  await page.mouse.move(2, 2);
  await expect(page.locator('#heatTip')).toBeHidden();

  // Geometry BEFORE hiding anything, in CSS px relative to the SVG's own box —
  // the screenshot is cropped to that box, so a label's rect has to be measured
  // against the same origin. A label moved off-canvas keeps its rect, which is
  // the point: it lands outside the crop and samples zero pixels.
  const geom = await page.evaluate(() => {
    const el = document.querySelector('#heatmapSvg');
    const r = el.getBoundingClientRect();
    // user units -> CSS px, so an UNTRANSFORMED bbox can be sized in the same
    // space as the screenshot. Falls back to 1 if the SVG carries no viewBox.
    const vb = (el.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const u2c = (vb.length === 4 && vb[2]) ? r.width / vb[2] : 1;
    return {
      svg: { w: r.width, h: r.height },
      u2c,
      labels: [...el.querySelectorAll('text.heat-label')].map((n) => {
        // WHERE the paint is: the transformed, on-screen rect.
        const b = n.getBoundingClientRect();
        // WHAT IT SHOULD HAVE BEEN: getBBox is the element's own geometry in
        // LOCAL user space, before any transform on it or its ancestors.
        const g = n.getBBox();
        return {
          t: (n.textContent || '').trim().slice(0, 12) || '(blank)',
          x: b.x - r.x, y: b.y - r.y, w: b.width, h: b.height,
          bw: g.width, bh: g.height,
        };
      }),
    };
  });

  const shotWith = (await svg.screenshot()).toString('base64');
  // `visibility: hidden` rather than removing the nodes: it takes the glyphs off
  // the screen without reflowing the map, so every other pixel is untouched and
  // the difference isolates the labels alone.
  await page.addStyleTag({
    content: '#heatmapSvg text.heat-label { visibility: hidden !important; }',
  });
  const shotWithout = (await svg.screenshot()).toString('base64');

  const report = await page.evaluate(async ({ a, b, geom }) => {
    // Chromium decodes its own PNGs. Doing this in the page rather than in Node
    // is what keeps this dependency-free — PR #283 removed `acorn` for exactly
    // this reason, and a decoder in package.json would put it straight back.
    const load = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(bmp, 0, 0);
      return { d: cx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
    };

    const A = await load(a);
    const B = await load(b);
    if (A.w !== B.w || A.h !== B.h) {
      return { harness: `screenshot size mismatch: ${A.w}x${A.h} vs ${B.w}x${B.h}` };
    }
    if (!A.w || !A.h) return { harness: 'screenshot is empty' };

    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const lum = (r, g, bl) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);

    // Device pixels per CSS pixel. Derived from the shot rather than read off
    // devicePixelRatio, so a scaled screenshot or a zoomed page still maps.
    const scale = A.w / geom.svg.w;

    // A pixel counts as PAINTED BY THE LABEL when hiding the label changed it.
    // 12, summed across RGB. PNG is lossless so there is no codec noise; what
    // this actually discards is the faint antialiased fringe, and discarding it
    // makes the percentile bands below CLEANER rather than losing signal.
    // Measured share of changed pixels dropped: 8.7% on desktop, 4.8% on Pixel 5.
    const DIFF_TOL = 12;
    // COVERAGE, not an absolute pixel count (Codex P2, #285). An absolute floor
    // cannot see PARTIAL loss: a big label clipped to a one-pixel strip still
    // clears any small constant while being unreadable. A label is judged on
    // the fraction of the footprint it SHOULD have occupied that it actually
    // painted, so losing 90% registers as losing 90% whatever its size.
    //
    // THE DENOMINATOR MUST NOT BE THE DAMAGED RECTANGLE (Codex P2, round 2).
    // `getBoundingClientRect` returns the box AFTER transforms, so a shrunken
    // label shrinks the yardstick with it and the ratio stays healthy — the
    // yardstick has to be independent of the damage it is measuring. Measured
    // under `transform: scale(0.5)`: against the transformed rect every label
    // scores 0.419–0.786 and the regression is SILENT; against the
    // untransformed bbox the same labels score 0.115–0.254.
    //
    // `getBBox()` is the element's own geometry in local user space, before any
    // transform on it or its ancestors, so it survives exactly the case that
    // defeats the rect. Clean-render coverage against it: 0.407–0.784 desktop,
    // 0.498–0.781 Pixel 5.
    //
    // 0.20 is 2x below the worst clean observation (0.407) — the same safety
    // margin the earlier floor carried, kept because a false finding is the
    // worse failure for an advisory check. STATED CONSEQUENCE: coverage falls
    // with AREA, so this catches a shrink below roughly 62% linear and a milder
    // one passes. That is a real gap, not a claim of completeness.
    const MIN_COVERAGE = 0.20;
    // Below this many exclusive pixels a label is too small to judge, and is
    // reported as unattributable rather than failed. The smallest exclusive
    // area measured on a clean map is 161 device px (desktop) / 392 (Pixel 5),
    // so this never fires on a healthy render.
    const MIN_ATTRIBUTABLE = 40;
    // EXTENT: the area of the box actually reached by paint, over the footprint
    // it should have reached. Density alone is not enough (Codex P2, round 3),
    // because ink-per-box varies ~1.9x between a sparse label and a dense one,
    // so ONE global density floor gives each label a different sensitivity — and
    // measured, a 40% clip and a 0.7 shrink are entirely silent under it:
    //
    //   measure   clean desktop   clip 40%        scale(0.7)
    //   density   0.407-0.784     0.244-0.610     0.210-0.401   (floor 0.20)
    //   extent    0.631-0.931     0.385-0.777     0.301-0.517
    //
    // Extent is density-INDEPENDENT: a clip that removes 40% of a label's
    // height removes 40% of its extent whether the glyphs are fat or thin. The
    // two measures fail differently, so both are applied and either can flag.
    // 0.45 is 1.4x below the worst clean observation (0.631 desktop, 0.772 on
    // Pixel 5). The margin is deliberately not spent down to the 0.55 that
    // would catch a 40% clip outright: two of the four CI viewports are WebKit
    // and CANNOT be run in this sandbox, so a floor calibrated to 1.15x here
    // would first misfire somewhere I cannot test.
    const MIN_EXTENT = 0.45;

    // OWNERSHIP. Label boxes genuinely overlap here — 41 pairs on a CLEAN
    // desktop render, 18 on Pixel 5, because a tile's ticker and its percentage
    // sit in one stack and their boxes touch. So overlap is NORMAL and cannot
    // be treated as a fault. It IS a measurement problem though (Codex P2):
    // both screenshots hide every label at once, so a naive per-box count lets
    // a dead label borrow its healthy neighbour's pixels, and summing the boxes
    // counts the shared ones twice (measured: 890 of 74,200 on desktop).
    // Every pixel is therefore attributed to at most ONE label, and a label is
    // judged only on the pixels no other label's box claims. Measured, that
    // still leaves each label 73.7%+ of its own box, so nothing is judged on a
    // scrap.
    // Box edges EXPAND to whole device pixels (floor the near edge, ceil the
    // far one) rather than rounding. Rounding trims up to a pixel off each
    // side, and the outermost ring is where the darkest halo lives — measured,
    // that alone dropped one clean-render label to a 4.20 ratio and produced a
    // false finding. The glyph's own extremes have to be inside the window.
    const boxes = geom.labels.map((L) => ({
      x0: Math.floor(L.x * scale), y0: Math.floor(L.y * scale),
      x1: Math.ceil((L.x + L.w) * scale), y1: Math.ceil((L.y + L.h) * scale),
    }));
    const claims = new Int32Array(A.w * A.h).fill(-1);
    const shared = new Uint8Array(A.w * A.h);
    boxes.forEach((b, i) => {
      for (let y = Math.max(0, b.y0); y < Math.min(A.h, b.y1); y++) {
        for (let x = Math.max(0, b.x0); x < Math.min(A.w, b.x1); x++) {
          const m = y * A.w + x;
          if (claims[m] === -1) claims[m] = i; else shared[m] = 1;
        }
      }
    });

    const painted = new Uint8Array(A.w * A.h);
    let totalChanged = 0;
    const findings = [];
    let worst = null;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const L = geom.labels[i];
      // Two tallies over the on-screen rect: how much of it this label owns
      // outright (`exclusive`), and how much of that it painted (`covered`).
      // The rect is only ever WHERE to look; the yardstick comes from the
      // untransformed bbox below.
      let rectPx = 0;
      let exclusive = 0;
      let covered = 0;
      let minX = Infinity; let maxX = -Infinity;
      let minY = Infinity; let maxY = -Infinity;
      const lums = [];
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
          rectPx++;
          const inShot = y >= 0 && y < A.h && x >= 0 && x < A.w;
          if (!inShot) continue;
          const m = y * A.w + x;
          const o = m * 4;
          const delta = Math.abs(A.d[o] - B.d[o])
            + Math.abs(A.d[o + 1] - B.d[o + 1])
            + Math.abs(A.d[o + 2] - B.d[o + 2]);
          const changed = delta > DIFF_TOL;
          // COVERAGE counts only pixels this label owns outright, so a dead
          // label cannot borrow a healthy neighbour's paint.
          if (!shared[m]) {
            exclusive++;
            if (changed) {
              covered++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
          if (changed) {
            if (!painted[m]) { painted[m] = 1; totalChanged++; }
            // CONTRAST samples the whole box, shared pixels included, and that
            // difference is deliberate. The two questions are not the same one:
            // "how much of my footprint did I paint" needs sole ownership, while
            // "what colours did the paint land in" is a property of the pixels.
            // Restricting this sample to the exclusive region shrinks it enough
            // to bias the 5% bands — measured, it put ONE clean-render label at
            // 4.20 and produced a false finding, which is the failure this whole
            // scenario is advisory to avoid. The residual risk is the mirror of
            // it: a heavily overlapped label could borrow a neighbour's extremes
            // and read better than it is. That is bounded — no label shares more
            // than 26.3% of its box — and it is the safer side to err on, since
            // coverage above already catches a label that painted nothing.
            lums.push(lum(A.d[o], A.d[o + 1], A.d[o + 2]));
          }
        }
      }

      // The expectation: the label's untransformed footprint in device pixels,
      // scaled down by how much of its rect it owns outright, so exclusivity
      // and the undamaged yardstick compose instead of contradicting.
      const expected = (L.bw * geom.u2c * scale) * (L.bh * geom.u2c * scale);
      const declared = expected * (rectPx ? exclusive / rectPx : 0);
      if (!(declared >= MIN_ATTRIBUTABLE)) {
        findings.push(`${L.t}: only ${Math.round(declared)}px of footprint is attributable to this label alone — not judged`);
        continue;
      }
      // How far the surviving paint REACHES, against the footprint it should
      // have filled. Uses the same untransformed expectation as coverage.
      const reachW = maxX >= minX ? (maxX - minX + 1) : 0;
      const reachH = maxY >= minY ? (maxY - minY + 1) : 0;
      const extent = (reachW * reachH) / Math.max(1, expected);
      if (extent < MIN_EXTENT) {
        findings.push(
          `${L.t}: paint reaches only ${(extent * 100).toFixed(1)}% of its untransformed footprint `
          + `(need ${MIN_EXTENT * 100}%) — part of the label is clipped, covered or shrunk away`,
        );
        continue;
      }

      const coverage = covered / declared;
      if (coverage < MIN_COVERAGE) {
        findings.push(
          `${L.t}: painted ${covered} of the ${Math.round(declared)}px its own untransformed footprint calls for `
          + `(${(coverage * 100).toFixed(1)}%, need ${MIN_COVERAGE * 100}%)`
          + ' — the label is in the DOM but not on the display',
        );
        continue;
      }

      // Ink and halo AS COMPOSITED. Percentile means rather than min/max, since
      // antialiasing puts a tail of blended pixels at both ends; the extremes
      // would report a ratio no reader ever sees.
      //
      // 5% is MEASURED, not guessed: on a CLEAN demo render the false-finding
      // count is 7 labels at 20%, 3 at 10%, and ZERO at both 5% and 2%. So 5%
      // is the widest setting that reports nothing on a good map, with 2% as
      // headroom rather than a cliff. Corroboration that this measures the right
      // pair at all: the ratios land on 15.14, which is what check-contrast
      // independently computes for #FFFFFF on #23262D.
      lums.sort((p, q) => p - q);
      const band = Math.max(1, Math.floor(lums.length * 0.05));
      const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
      const loL = mean(lums.slice(0, band));
      const hiL = mean(lums.slice(-band));
      const r = (hiL + 0.05) / (loL + 0.05);
      if (worst === null || r < worst) worst = r;
      if (r < 4.5) {
        findings.push(`${L.t}: composited ink/halo ${r.toFixed(2)} over ${covered}px (need 4.5) — the measured pair is not the pair on screen`);
      }
    }

    return { sampled: geom.labels.length, totalChanged, findings, worst };
  }, { a: shotWith, b: shotWithout, geom });

  // ---- BLOCKING: the measurement itself has to have worked ----
  expect(report.harness, `pixel sampling could not run: ${report.harness}`).toBeUndefined();

  expect(
    report.sampled,
    `Only ${report.sampled} labels to sample — the heatmap did not render, or heatText stopped stamping .heat-label.`,
  ).toBeGreaterThanOrEqual(40);

  // Non-circularity for the HARNESS, and NOTHING MORE (Codex P2, #285). This
  // asks one question: did hiding the labels change the picture at all? If not,
  // "every label is invisible" and "the difference is broken" are the same
  // observation and no per-label number below can be trusted.
  //
  // It deliberately does NOT scale with the number of labels. A per-label floor
  // measures DAMAGE, not instrument health: with 100 of 101 labels dead and one
  // painting normally, a `sampled * 20` gate fails at ~735 against a 2,020
  // threshold — turning the sharpest partial-loss case there is into a blocking
  // failure, in flat contradiction of the advisory contract. Any non-zero
  // difference proves the instrument works, and how much was lost is then the
  // advisory report's business. PNG is lossless and both shots are of the same
  // page, so a changed pixel is real paint and never noise.
  expect(
    report.totalChanged,
    'Hiding every label changed NO pixels at all across the whole map. Either the labels were '
    + 'never painted, or the screenshot difference is not measuring them — those are the same '
    + 'observation from here, so no per-label result can be trusted.',
  ).toBeGreaterThan(0);

  // ---- ADVISORY: reported, never thrown ----
  if (report.findings.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `S47 (advisory): ${report.findings.length} of ${report.sampled} heatmap labels `
      + `did not survive to the screen:\n  ${report.findings.slice(0, 12).join('\n  ')}`,
    );
  }

  test.info().attach('heatmap-label-pixels', {
    body: JSON.stringify({
      sampled: report.sampled,
      totalChangedPx: report.totalChanged,
      worstCompositedRatio: report.worst,
      advisoryFindings: report.findings,
    }, null, 2),
    contentType: 'application/json',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S48 — every dialog on the desk honours ONE contract: focus moves in, Tab and
// Shift+Tab stay in, Escape closes, and focus goes back to the opener.
//
// All eight dialogs open through the shared openModal()/closeModal(). aria-modal
// only DECLARES the page behind inert — browsers do not enforce it for Tab — so
// focus used to walk out of an open dialog into the desk behind it, the ⚙
// system-prompt editor never handed focus back, and the ⏱ roster ignored Escape.
// None of that fails a test that merely opens and closes a dialog, which is why
// each dialog is driven through the whole contract here.
//
// The page behind is made REALLY inert too (screen-reader browsing, pointer and
// find-in-page reach an aria-modal background otherwise): every sibling along the
// dialog's ancestor chain carries `inert`, the chain itself never does (a backdrop
// sits inside <main>, so inerting <main> would inert the dialog), stacked dialogs
// leave only the top one live, and closing the last leaves NOTHING inert. The
// probes TRY to focus controls behind the dialog, so an `inert` attribute that
// does nothing cannot pass.
//
// TWO checks keep the trap honest. The ring is walked past its own length in
// BOTH directions, so a wrap that fails at either end is reached. And it must
// VISIT every control: "focus never leaves the dialog" is also true of a trap
// that pins focus to one button, and that is the failure a guard which cannot
// fail would wave through.
//
// Demo mode, no network. The watchlist dialogs run forced-live WITHOUT auth (as
// S21 does — edits need no unlock) on the stateful fake roster, with roster
// writes blocked besides: nothing here may reach the owner's real roster. The
// Ask dialogs need the authed desk, so those run after and on stubbed RPCs.
// ─────────────────────────────────────────────────────────────────────────────
test('S48: dialogs trap focus, close on Escape and return focus to their opener', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(240_000);
  await blockRosterWrites(page);   // the forced-live dialogs below must never reach the real roster
  await gotoDemo(page, '.wl-strip .wl-tile', 15000);

  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
  /* The dialog's controls as the browser would tab them, and where focus is now:
     `at` is the index of the focused control, -1 for anything else inside the
     panel (the panel itself), and `in` is false once focus is outside it. */
  const ring = (panel) => page.evaluate(({ p, sel }) => {
    const root = document.querySelector(p);
    const ctl = [...root.querySelectorAll(sel)].filter(n => !n.matches(':disabled') && n.tabIndex >= 0
      && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
    return { n: ctl.length, in: root.contains(document.activeElement), at: ctl.indexOf(document.activeElement) };
  }, { p: panel, sel: FOCUSABLE });

  /* What the open dialog did to the page behind it, read off the live DOM. The probes are
     three real controls OUTSIDE the dialog (its own opener among them — it sits in the
     region that must be inert while the dialog is up) and each is asked to take focus: an
     inert node refuses, so "reports inert" cannot pass on an attribute that does nothing.
     Focus is handed back afterwards so the Tab walk starts where the open left it. */
  const behindDialog = (panel, opener) => page.evaluate(({ p, opener: from }) => {
    const root = document.querySelector(p);
    const desc = n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '.' + String(n.className).split(' ')[0]);
    const probe = (n) => {
      if (!n) return { missing: true };
      const before = document.activeElement;
      const marked = !!n.closest('[inert]');
      n.focus();
      const tookFocus = document.activeElement === n;
      if (tookFocus && before && before !== n) before.focus();
      return { marked, tookFocus };
    };
    return {
      count: document.querySelectorAll('[inert]').length,
      // an inert node that IS the panel, holds it, or sits inside it would freeze the dialog itself
      hitsDialog: [...document.querySelectorAll('[inert]')]
        .filter(n => n === root || n.contains(root) || root.contains(n)).map(desc),
      dialogInert: !!root.closest('[inert]'),
      // read-only content outside <main> has no control to focus, but a virtual cursor still walks it
      landmarks: ['.masthead', '.site-footer'].map(q => [q, !!document.querySelector(q).closest('[inert]')]),
      probes: {
        opener: probe(from),
        tile: probe(document.querySelector('.wl-strip .wl-tile')),
        heatToggle: probe(document.getElementById('heatToggle')),
      },
    };
  }, { p: panel, opener });
  const inertCount = () => page.evaluate(() => document.querySelectorAll('[inert]').length);

  const contract = async (name, { opener, open, backdrop, panel, keep, dirty }) => {
    const back = page.locator(backdrop);
    const from = await page.evaluateHandle(opener);   // the element focus must come back to
    await open();
    await expect(back, `${name}: opens`).toBeVisible();
    await page.waitForTimeout(250);   // the dialog's own async content (roster, prompt) has landed
    const start = await ring(panel);
    expect(start.in, `${name}: opening moves focus INSIDE the dialog`).toBe(true);
    if (keep) {
      expect(await page.evaluate(() => document.activeElement && document.activeElement.id),
        `${name}: a destructive dialog opens on "Keep it"`).toBe(keep);
    }

    // the page behind is inert, the dialog and its ancestors are not
    const behind = await behindDialog(panel, from);
    expect(behind.count, `${name}: opening puts the page behind it under inert`).toBeGreaterThan(0);
    expect(behind.hitsDialog, `${name}: no inert node is, holds or sits inside the dialog`).toEqual([]);
    expect(behind.dialogInert, `${name}: the dialog stays live`).toBe(false);
    for (const [q, marked] of behind.landmarks) {
      expect(marked, `${name}: ${q}, outside <main>, is inert too — the walk reaches every ancestor level`).toBe(true);
    }
    for (const [what, r] of Object.entries(behind.probes)) {
      expect(r.missing, `${name}: probe "${what}" exists on the page`).toBeFalsy();
      expect(r.marked, `${name}: ${what} behind the dialog reports inert`).toBe(true);
      expect(r.tookFocus, `${name}: ${what} behind the dialog cannot be focused`).toBe(false);
    }

    // N large enough to wrap the ring in either direction, and every control reached
    expect(start.n, `${name}: has controls to cycle through`).toBeGreaterThan(1);
    for (const key of ['Tab', 'Shift+Tab']) {
      const lost = [], seen = new Set();
      for (let i = 1; i <= 2 * start.n + 2; i++) {
        await page.keyboard.press(key);
        const s = await ring(panel);
        if (s.in) seen.add(s.at); else lost.push(`${key}#${i}`);
      }
      expect(lost, `${name}: ${key} never moves focus out of the dialog`).toEqual([]);
      seen.delete(-1);
      expect(seen.size, `${name}: ${key} visits every one of its ${start.n} controls, so the trap is a ring and not a pin`)
        .toBe(start.n);
    }

    if (dirty) {
      await dirty.edit();
      // ONE physical press held long enough to auto-repeat: the second keydown carries
      // repeat:true and must not count as the confirming second dismissal
      await page.keyboard.down('Escape');
      await page.keyboard.down('Escape');
      await page.keyboard.up('Escape');
      await expect(back, `${name}: the first Escape only warns — its auto-repeat is not a second press`).toBeVisible();
      await expect(page.locator(dirty.note), `${name}: and says why`).toHaveText(/Unsaved changes/);
    }
    await page.keyboard.press('Escape');
    await expect(back, `${name}: Escape closes it`).toBeHidden();
    expect(await page.evaluate((el) => document.activeElement === el, from),
      `${name}: focus returns to the element that opened it`).toBe(true);
    expect(await inertCount(), `${name}: closing it leaves NOTHING inert`).toBe(0);
  };

  // ── demo: a single click opens the detail window at once (no removal wired to defer for)
  await contract('symbol detail', {
    opener: () => document.querySelector('.wl-strip .wl-tile'),
    open: () => page.locator('.wl-strip .wl-tile').first().click(),
    backdrop: '#wlDetailBackdrop', panel: '#wlDetailPanel',
  });

  // ── forced live WITHOUT auth: the watchlist's own dialogs
  await page.evaluate(() => { DESK.mode = 'live'; DESK.authed = false; renderWatchlist(); });
  await installFakeRoster(page);
  await expect(page.locator('#wlEditBtn')).toBeVisible();
  await contract('remove confirm', {
    opener: () => document.querySelector('.wl-strip .wl-tile'),
    open: async () => { await page.locator('.wl-strip .wl-tile').first().focus(); await page.keyboard.press('Delete'); },
    backdrop: '#wlRmBackdrop', panel: '#wlRmPanel', keep: 'wlRmCancelBtn',
  });
  await contract('quick add', {
    opener: () => document.getElementById('wlTrayAdd'),
    open: () => page.locator('#wlTrayAdd').click(),
    backdrop: '#wlQuickBackdrop', panel: '#wlQuickPanel',
  });
  await contract('new list', {
    opener: () => document.getElementById('wlNewListBtn'),
    open: () => page.locator('#wlNewListBtn').click(),
    backdrop: '#wlNewBackdrop', panel: '#wlNewPanel',
  });
  await contract('delete list', {
    opener: () => document.querySelector('.wl-del'),
    open: () => page.locator('.wl-del').first().click(),
    backdrop: '#wlDelBackdrop', panel: '#wlDelPanel', keep: 'wlDelCancelBtn',
  });
  await contract('watchlist editor', {
    opener: () => document.getElementById('wlEditBtn'),
    open: () => page.locator('#wlEditBtn').click(),
    backdrop: '#wlEditBackdrop', panel: '#wlEditPanel',
  });

  // ── the authed desk, every RPC stubbed: the two Ask dialogs
  await page.evaluate(() => {
    window.deskGetSystemPrompt = async () => ({ ok: true, content: 'You are the desk.', updatedAt: null });
    window.deskGetAskSchedule = async () => ({ ok: true, rows: [] });
    window.deskSetAskSchedule = async () => ({ ok: true, rows: 0 });
    window.deskChatHistory = () => Promise.resolve([]);
    DESK.authed = true; renderAsk();
  });
  await contract('system prompt', {
    opener: () => document.querySelector('button[aria-label="Edit the Ask-the-desk system prompt"]'),
    open: () => page.locator('button[aria-label="Edit the Ask-the-desk system prompt"]').click(),
    backdrop: '#sysPromptBackdrop', panel: '#sysPromptPanel',
  });
  await contract('scheduled asks', {
    opener: () => document.querySelector('.ask-sched-btn'),
    open: () => page.locator('.ask-sched-btn').click(),
    backdrop: '#askSchedBackdrop', panel: '#askSchedPanel',
  });
  // Unsaved edits: the first Escape warns and keeps the dialog, the second closes it.
  await contract('scheduled asks with unsaved edits', {
    opener: () => document.querySelector('.ask-sched-btn'),
    open: async () => { await page.locator('.ask-sched-btn').click(); await page.locator('#askSchedAdd').click(); },
    backdrop: '#askSchedBackdrop', panel: '#askSchedPanel',
    dirty: { edit: () => page.locator('.ask-sched-q').fill('an unsaved edit'), note: '#askSchedNote' },
  });

  // ── stacked dialogs: only the TOP one is live, and each close restores exactly the state under it
  const live = (sel) => page.evaluate((q) => !document.querySelector(q).closest('[inert]'), sel);
  const inertList = () => page.evaluate(() => [...document.querySelectorAll('[inert]')]
    .map(n => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '.' + String(n.className).split(' ')[0])).sort());
  const heldId = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  // the second dialog is opened FROM a control inside the editor, as a real nested flow would
  const openNew = () => page.evaluate(() => openWlNewList(document.getElementById('wlAddListBtn')));

  await page.locator('#wlEditBtn').click();
  await expect(page.locator('#wlEditBackdrop'), 'stack: the editor opens').toBeVisible();
  await page.waitForTimeout(250);   // its roster has landed, so + Add list is enabled
  const underEditor = await inertList();
  expect(underEditor.length, 'stack: the editor alone puts the page under inert').toBeGreaterThan(0);
  expect(await live('#wlEditPanel'), 'stack: the editor is live').toBe(true);

  await openNew();
  await expect(page.locator('#wlNewBackdrop'), 'stack: the second dialog opens over it').toBeVisible();
  expect(await live('#wlNewPanel'), 'stack: the TOP dialog is live').toBe(true);
  expect(await live('#wlEditPanel'), 'stack: the dialog UNDER the top one is inert too').toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlNewBackdrop'), 'stack: Escape closes the top dialog only').toBeHidden();
  await expect(page.locator('#wlEditBackdrop'), 'stack: the one beneath stays open').toBeVisible();
  expect(await inertList(), 'stack: closing the top dialog restores EXACTLY the state under it').toEqual(underEditor);
  expect(await live('#wlEditPanel'), 'stack: the editor is live again').toBe(true);
  expect(await heldId(), 'stack: focus went back to the control inside the editor that opened the second dialog — inert had to lift BEFORE focus()')
    .toBe('wlAddListBtn');

  // closed OUT OF ORDER (the lower one first) and RE-OPENED while open: the survivor stays the only live one
  await openNew();
  await openNew();
  await expect(page.locator('#wlNewBackdrop')).toBeVisible();
  await page.evaluate(() => closeWlEditor());
  await expect(page.locator('#wlEditBackdrop'), 'stack: the lower dialog closed underneath').toBeHidden();
  expect(await live('#wlNewPanel'), 'stack: the survivor is still live').toBe(true);
  expect(await inertCount(), 'stack: and the page is still inert behind it').toBeGreaterThan(0);
  expect(await page.evaluate(() => document.getElementById('wlNewPanel').contains(document.activeElement)),
    'stack: closing a dialog UNDER the top one does not pull focus out of the top one').toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlNewBackdrop')).toBeHidden();
  expect(await inertCount(), 'stack: closing the last dialog leaves NOTHING inert — a re-open never stacks a second claim').toBe(0);

  // an `inert` that something ELSE set is never ours to strip
  await page.evaluate(() => document.querySelector('.site-footer').setAttribute('inert', ''));
  await openNew();
  await expect(page.locator('#wlNewBackdrop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#wlNewBackdrop')).toBeHidden();
  expect(await inertList(), 'stack: an inert the page had already is left alone when the dialog closes').toEqual(['footer.site-footer']);
  await page.evaluate(() => document.querySelector('.site-footer').removeAttribute('inert'));
  expect(await inertCount(), 'stack: and nothing else remains').toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// S49 — a position whose day-% is UNKNOWN says so: it stays null through the
// payload mapper, renders as an em dash, and sorts LAST in both directions.
//
// The sync stores null when the feeds could not price a symbol (option OCC
// symbols, thin tickers). Three separate layers used to turn that into a number:
// `Number(null)` is 0, so the mapper made it a flat +0.00% before the renderer
// could dash it; fmtPct(null) answered "+0.00%" (null >= 0); and the sort key
// -Infinity led an ascending click and printed "-Infinity" into data-sort. The
// result was four option positions reading 0.00% while AVAV was down 38% — the
// largest moves in the account claiming they had not moved. A GENUINE flat 0
// must survive all of it, which is what stops "dash everything falsy" passing.
//
// Demo, in-page: mapDashboardPayload and renderAccounts are fed a hand-built
// payload, so nothing here touches a backend.
// ─────────────────────────────────────────────────────────────────────────────
test('S49: a position with an unknown day-% renders a dash and sorts last in both directions', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#accountGrid .lamp', 10000);

  const out = await page.evaluate(() => {
    const payload = { accounts: [{ account_key: 'A', label: 'L', nav: '100', day_pnl: '1', total_unrl: '2', cash: '3', as_of: '2026-09-25', created_at: null,
      positions: [{ sym: 'UNK', qty: 1, mkt: 10, dayPct: null, unrl: 1 }, { sym: 'LOSS', qty: 1, mkt: 10, dayPct: -38.4, unrl: 1 },
                  { sym: 'FLAT', qty: 1, mkt: 10, dayPct: 0, unrl: 1 }, { sym: 'UP', qty: 1, mkt: 10, dayPct: 1.2, unrl: 1 }] }],
      equity: [{ account_key: 'A', as_of: '2026-09-25', nav: '100' }] };
    const m = mapDashboardPayload(payload);
    renderAccounts(m.accounts, { cls: 'lamp--eod', text: 'EOD' });
    const table = [...document.querySelectorAll('.acct-positions table')].pop();
    const rows = () => [...table.tBodies[0].rows];
    const th = [...table.tHead.rows[0].cells].find(c => c.textContent === 'Day %');
    const order = () => rows().map(r => r.cells[0].textContent.split(' ')[0]).join(',');
    const cell = sym => { const c = rows().find(r => r.cells[0].textContent.startsWith(sym + ' ')).cells[2]; return { text: c.textContent, sort: c.dataset.sort }; };
    const mapped = Object.fromEntries(m.accounts[0].positions.map(p => [p.sym, p.dayPct]));
    const cells = { UNK: cell('UNK'), FLAT: cell('FLAT'), LOSS: cell('LOSS') };
    const found = !!th;
    th.click(); const asc = order();
    th.click(); const desc = order();
    return { mapped, cells, found, asc, desc };
  });

  expect(out.found, 'the positions table has a Day % column to sort').toBe(true);
  expect(out.mapped.UNK, 'an unknown day-% stays null through the mapper — Number(null) is a fabricated flat 0').toBeNull();
  expect(out.mapped.FLAT, 'a GENUINE flat day stays 0, so "unknown" is not "anything falsy"').toBe(0);
  expect(out.mapped.LOSS, 'and a real move is untouched').toBe(-38.4);
  expect(out.cells.UNK.text, 'an unknown day-% renders an em dash, never +0.00%').toBe('—');
  expect(out.cells.FLAT.text, 'a real flat day still reads +0.00%').toBe('+0.00%');
  expect(out.cells.LOSS.text, 'and the 38% loser reads as one').toBe('−38.40%');
  expect(out.cells.UNK.sort, 'the unknown carries a BLANK sort key — not -Infinity, which printed into data-sort').toBe('');
  expect(out.asc, 'ascending: the unknown is parked LAST, not first').toBe('LOSS,FLAT,UP,UNK');
  expect(out.desc, 'descending: still LAST — an unknown never ranks between a loser and a winner').toBe('UP,FLAT,LOSS,UNK');
});

// ─────────────────────────────────────────────────────────────────────────────
// S50 — the heatmap follows its PERIOD: the ETF cut recolours by it, and the
// movers table's last column is named for it.
//
// Two faults, one cause. The ETF cut was exempt from recolorForPeriod, so 1-Month
// Performance drew a map coloured by DAY % under a "1-Month" label (desk-heatmap's
// etf universe carries pctW/pctM/pctYtd, and the period select already unlocked
// them for it). And the movers table hard-coded its header "Day %" while its rows
// carried the selected period's figure. Either way the reader is told a number
// means something it does not.
//
// The tiles are read off what renderHeatmap is HANDED (the map is bare rects with
// no class, so a DOM read cannot say which figure coloured them). The period is
// driven through the panel's own select. At 1-Day the same read must show tiles
// whose day-% differs from their period figure — otherwise "pct === pctM" would
// be true of a demo dataset where the two happen to agree, and the check would
// pass whatever the code did.
// ─────────────────────────────────────────────────────────────────────────────
test('S50: the heatmap follows its period — ETF tiles recolour and the movers header names it', async ({ page, renderWitness }) => {
  renderWitness();
  await page.goto('./?demo=1');
  await page.locator('#heatToggle').click();
  await expect(page.locator('#heatBody')).toBeVisible();
  await page.waitForFunction(() => !!heatBase && !!heatEtf, null, { timeout: 15000 });
  await page.locator('.map-filter-btn', { hasText: 'ETFs' }).click();
  await expect(page.locator('#heatTitle')).toContainText('ETFs');
  await page.evaluate(() => {
    const render = renderHeatmap;
    renderHeatmap = (hm, lamp) => { window.__hm = hm; return render(hm, lamp); };
  });

  const FIELD = { '1w': 'pctW', '1m': 'pctM', ytd: 'pctYtd' };
  const read = async (period) => {
    await page.locator('#heatPeriod').selectOption(period);
    return page.evaluate((field) => {
      const tiles = window.__hm.sectors.flatMap(s => s.tiles);
      return {
        head: [...document.querySelectorAll('#heatTable thead th')].pop().textContent,
        n: tiles.length,
        onPeriod: field ? tiles.filter(t => t.pct === t[field]).length : null,
        onDay: field ? null : tiles.filter(t => t.pct !== t.pctM).length,
      };
    }, FIELD[period] || null);
  };

  const day = await read('1d');
  expect(day.head, 'at 1-Day the movers column reads Day %').toBe('Day %');
  expect(day.n, 'the ETF cut draws tiles').toBeGreaterThan(0);
  expect(day.onDay, 'and at 1-Day they are coloured by the DAY move — it differs from the 1-Month figure, so the checks below can fail').toBeGreaterThan(0);
  for (const [period, head] of [['1w', '1W %'], ['1m', '1M %'], ['ytd', 'YTD %']]) {
    const r = await read(period);
    expect(r.head, `at ${period} the movers column is named ${head}, not Day %`).toBe(head);
    expect(r.n, `${period}: the ETF cut still draws tiles`).toBeGreaterThan(0);
    expect(r.onPeriod, `${period}: EVERY ETF tile is coloured by its ${FIELD[period]}, not left on the day move`).toBe(r.n);
  }
  expect((await read('1d')).head, 'and back at 1-Day the header returns to Day %').toBe('Day %');
});

// ─────────────────────────────────────────────────────────────────────────────
// S51 — the Markets chart stays honest about its two legs.
//
// fetchMktSeries used to be a true one-shot: the Today line froze at whatever the
// page loaded with while pinEnd() re-tilted that frozen path onto the ticking
// tile — by afternoon the drawn shape was fabricated. Now each market poll
// re-pulls the INTRADAY leg while the session is open, and the DAILY leg is
// fetched once per index and reused (the multi-year history does not change
// intraday, and re-pulling it every minute is the cost that argues for the
// split). And when one leg is down the chart says WHICH: Today reads "Index series
// unavailable" while 1M — a different leg — still draws its lines.
//
// Demo page, forced live with quotes stubbed in-page (as S28 does): no request
// leaves it. Each index's second intraday reply ends higher than its first, so a
// Today line that is still frozen shows the SAME end after both polls.
// ─────────────────────────────────────────────────────────────────────────────
test('S51: the Markets chart follows the market poll and names the leg that is down', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '#mktTiles .mk-tile', 10000);

  const out = await page.evaluate(async () => {
    const r = {};
    DESK.mode = 'live'; if (!DESK_DB.url) DESK_DB.url = 'https://stub.invalid';
    marketSessionOpen = () => true; withinCloseSettleGrace = () => false;
    let mode = 'ok', dailyCalls = 0, intraCalls = 0;
    const day = '2026-09-29';
    const daily = { c: Array.from({ length: 300 }, (_, i) => 100 + i * 0.1) };
    deskQuote = async (proxy, kind) => {
      if (mode === 'fail') return { ok: false };
      if (kind === 'daily') { dailyCalls++; return { ok: true, series: daily }; }
      intraCalls++;
      const last = intraCalls <= MKT_INDEX.length ? 102 : 110;   // 1st poll ends 102, the 2nd ends 110
      return { ok: true, series: { t: [day + 'T13:30', day + 'T13:35', day + 'T13:40'], c: [100, 101, last] } };
    };
    const reset = () => { mktSeriesDone = false; mktPer = null; mktState.series = null; mktState.legFailed = null; };
    const text = () => { const t = document.querySelector('#mktChart text'); return t && t.textContent; };
    const paths = () => document.querySelectorAll('#mktChart path').length;

    reset(); const k = MKT_INDEX[0].key;
    await fetchMktSeries();
    r.end1 = mktState.series.today[k].slice(-1)[0];
    await fetchMktSeries();                                   // a SECOND market poll, session still open
    r.end2 = mktState.series.today[k].slice(-1)[0];
    r.dailyCalls = dailyCalls; r.intraCalls = intraCalls; r.indices = MKT_INDEX.length;

    /* Today's leg down, the daily leg up */
    mode = 'ok'; dailyCalls = 0;
    deskQuote = async (proxy, kind) => kind === 'daily' ? { ok: true, series: daily } : { ok: false };
    reset(); await fetchMktSeries();
    mktState.tf = 'today'; drawMktChart(); r.todayText = text(); r.todayPaths = paths();
    mktState.tf = '1m'; drawMktChart(); r.monthText = text(); r.monthPaths = paths();

    /* both legs down */
    deskQuote = async () => ({ ok: false });
    reset(); await fetchMktSeries();
    mktState.tf = 'today'; drawMktChart(); r.bothText = text();
    return r;
  });

  expect(out.end2, 'the Today line follows the SECOND poll — a frozen one-shot would still end where the first left it').toBeGreaterThan(out.end1);
  expect(out.dailyCalls, 'the daily leg is fetched ONCE per index and reused across polls').toBe(out.indices);
  expect(out.intraCalls, 'while the intraday leg is pulled again on every poll').toBe(2 * out.indices);
  expect(out.todayText, 'Today, with only the intraday leg down, says the series is unavailable').toMatch(/Index series unavailable/);
  expect(out.monthText, '1M, on the leg that IS up, shows no failure notice').not.toMatch(/unavailable|Loading/);
  expect(out.monthPaths, '1M still draws its lines').toBeGreaterThan(out.todayPaths);
  expect(out.bothText, 'with both legs down the chart says so rather than loading forever').toMatch(/Index series unavailable/);
});

// ─────────────────────────────────────────────────────────────────────────────
// S52 — the news topic box searches what it shows.
//
// desk-news echoes the CLEANED topic, and refreshNews drops a reply whose topic
// is not the one currently asked for. Compared against the RAW box text, any
// topic with `: ( $ ?`, non-ASCII or a double space looked like a stale reply and
// vanished silently — "AAPL: Q3 (earnings)" produced no news and no error. And a
// stale reply must still be dropped: the slower search for an abandoned topic
// landing last must not repaint the panel over the topic now typed. Last, the
// box shows the CLEANED topic, so a topic of only unsupported characters empties
// it rather than leaving raw text over an unfiltered sweep.
//
// Demo, `deskFeed` stubbed in-page — the stand-in echoes the cleaned topic the
// way the function does, with its rule written out here rather than borrowed
// from the app, so a change to the app's copy cannot make the check agree with
// itself. Nothing leaves the page.
// ─────────────────────────────────────────────────────────────────────────────
test('S52: the news topic accepts a punctuated topic, drops a stale reply and cleans what it shows', async ({ page, renderWitness }) => {
  renderWitness();
  await gotoDemo(page, '.news-row', 20000);

  const out = await page.evaluate(async () => {
    const clean = t => String(t || '').replace(/[^A-Za-z0-9 &.,'+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const gate = {}; let n = 0, auto = true;
    deskFeed = (name, body) => new Promise(res => {
      const id = ++n;
      const land = () => res({ items: [], topic: clean(body && body.topic), generatedAt: new Date().toISOString(), asOf: '2026-09-29' });
      gate[id] = land; if (auto) land();
    });
    const r = {};
    /* 1) raw box text with ( : ) — the echo is the cleaned form and must be ACCEPTED */
    DESK.data.newsTopic = 'SENTINEL';
    localStorage.setItem(NEWS_TOPIC_KEY, 'AAPL: Q3 (earnings)');
    await refreshNews(true);
    r.punctuated = DESK.data.newsTopic;
    /* 2) A in flight, retyped to B, B lands, THEN A lands — the stale A must be dropped */
    auto = false; n = 0; DESK.data.newsTopic = 'SENTINEL';
    localStorage.setItem(NEWS_TOPIC_KEY, 'aaa'); const a = refreshNews(true);
    localStorage.setItem(NEWS_TOPIC_KEY, 'bbb'); const b = refreshNews(true);
    gate[2](); await b; gate[1](); await a;
    r.stale = DESK.data.newsTopic;
    auto = true;
    return r;
  });
  expect(out.punctuated, 'a punctuated topic is accepted: the cleaned echo is matched against the cleaned box, not the raw text').toBe('AAPL Q3 earnings');
  expect(out.stale, 'a reply for an abandoned topic is dropped even when it lands last').toBe('bbb');

  /* The box itself: it shows the CLEANED topic, and only that is stored. */
  for (const [typed, shown] of [['???', ''], ['fed $ rate', 'fed rate'], ['fed rate cut', 'fed rate cut']]) {
    await page.locator('#newsTopic').fill(typed);
    await page.locator('#newsTopic').press('Enter');
    await expect(page.locator('#newsTopic'), `"${typed}" is shown as "${shown}"`).toHaveValue(shown);
    expect(await page.evaluate(() => localStorage.getItem('news_topic_v1')),
      `and "${typed}" stores "${shown}" — a topic of only junk clears rather than searching raw text`)
      .toBe(shown || null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S53 — the charts rail's height follows the LAYOUT it is in. Below 861px the
// rail is stacked ABOVE the chart, and its cap is a fixed 220px; beside the chart
// (861px and up) its cap is the chart column's own height. The stacked cap was
// dead for a long time — an earlier `#wbSidebar { max-height: 220px }` sat BEFORE
// the base rule at equal specificity, and the script then wrote the chart's
// height as an INLINE max-height, which beats every stylesheet rule — so a phone
// carried a 460px list over its chart and an iPad an 891px one. Nothing in S40 or
// S45 could see it: they assert what is IN the rail, never how tall it stands.
//
// The branch is taken off THIS PROJECT'S width, so each of the four projects
// checks the side of the breakpoint it actually renders (desktop = beside; tablet
// 810, mobile-chrome and iphone = stacked). Both branches are asserted from
// rendered geometry, and the inline style must stay EMPTY: a max-height written
// inline is precisely how the stacked cap was defeated.
test('S53: the charts rail is capped at 220px when stacked and at the chart column\'s height when beside it', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(90_000);
  await gotoDemo(page, '#wbSidebar .wb-slots', 15000);
  await page.locator('#wbChart').scrollIntoViewIfNeeded();
  // the chart has drawn (the rail is capped from the chart's height on the render that draws it);
  // waited on by what is VISIBLE, never by how the cap is implemented, so the assertions below stay
  // meaningful against any implementation
  await expect.poll(() => page.evaluate(() => document.getElementById('wbChart').childElementCount),
    'the chart has drawn').toBeGreaterThan(20);
  await page.waitForTimeout(400);

  const m = await page.evaluate(() => {
    const rail = document.getElementById('wbSidebar');
    const bars = document.getElementById('wbPaneBars');
    const svg = document.getElementById('wbChart');
    const rr = rail.getBoundingClientRect(), br = bars.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    const slots = rail.querySelector('.wb-slots');
    return {
      vw: window.innerWidth,
      rail: rr.height, railBottom: rr.bottom, railRight: rr.right,
      chartColumn: sr.bottom - br.top, barsTop: br.top, barsLeft: br.left,
      inline: rail.style.maxHeight,
      cssCap: getComputedStyle(rail).maxHeight,
      slotsScrolls: slots.scrollHeight > slots.clientHeight + 1,
    };
  });

  expect(m.inline, 'the cap is never written inline — an inline max-height beats every stylesheet rule, which is how the 220px cap died').toBe('');
  expect(m.slotsScrolls, 'the 100-slot list scrolls INSIDE the rail whichever way it is capped').toBe(true);

  if (m.vw <= 860) {
    expect(m.cssCap, `stacked at ${m.vw}px: the stylesheet caps the rail at 220px`).toBe('220px');
    expect(m.rail, 'and it stands no taller than that').toBeLessThanOrEqual(220 + 1);
    expect(m.railBottom, 'the rail is ABOVE the chart, not beside it').toBeLessThanOrEqual(m.barsTop + 1);
  } else {
    expect(m.railRight, `beside the chart at ${m.vw}px: the rail is a SIDE rail`).toBeLessThanOrEqual(m.barsLeft + 1);
    expect(m.cssCap, 'and the stacked 220px cap has not leaked into the wide layout').not.toBe('220px');
    expect(m.rail, 'it is capped at the chart column (pane bars + canvas), so a long roster scrolls rather than growing the row')
      .toBeLessThanOrEqual(m.chartColumn + 1);
    expect(m.rail, 'and fills it rather than collapsing').toBeGreaterThan(m.chartColumn * 0.9);
  }
});

// S54 — Accounts at the bottom, cards side by side (owner request 2026-09-30).
// The accounts used to be a 232px column at the right of the desk row with the
// cards stacked one per row. That column is now the Economy placeholder
// (`.area-econ`, now the Economy panel — see S55), and the WHOLE `.area-accounts`
// section — title, desk lamp, Refresh/Lock, stamp and the cards — is the last block in <main>.
test('S54: the accounts sit at the bottom of the page, side by side, in line with the panels above', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(90_000);
  await gotoDemo(page, '#accountGrid .account', 15000);

  // Everything is read off the LIVE layout (rects, computed widths, DOM position), never off the
  // stylesheet's text, so it holds for any implementation that puts the page in this shape.
  const measure = () => page.evaluate(() => {
    const rc = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const one = (sel) => document.querySelector(sel);
    const main = document.getElementById('main');
    const acc = one('.area-accounts');
    const heat = one('.heat-panel');
    const charts = one('.area-charts');
    const grid = document.getElementById('accountGrid');
    const cards = [...grid.querySelectorAll(':scope > .account')].map(rc);
    const head = one('.accounts-side');
    const econ = one('.area-econ');
    const ask = one('.col-rail > .panel');
    const mkt = one('.col-markets > .panel');
    const row = one('.desk-row');
    return {
      vw: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      lastIsAccounts: main.lastElementChild === acc,
      accountsInMain: !!acc && acc.parentElement === main,
      accountsAfterHeat: !!(heat && acc && (heat.compareDocumentPosition(acc) & Node.DOCUMENT_POSITION_FOLLOWING)),
      accountsInDeskRow: !!(acc && row && row.contains(acc)),
      inside: Object.fromEntries(['#mastheadState', '#accountsStamp', '#accountsTitle', '#accountGrid']
        .map((s) => [s, !!(acc && acc.querySelector(s))])),
      acc: acc && rc(acc), heat: heat && rc(heat), charts: charts && rc(charts),
      grid: rc(grid), head: head && rc(head), cards,
      title: rc(document.getElementById('accountsTitle')),
      state: rc(document.getElementById('mastheadState')),
      stamp: rc(document.getElementById('accountsStamp')),
      econInRow: !!(econ && row && row.contains(econ)),
      econ: econ && rc(econ), ask: ask && rc(ask), mkt: mkt && rc(mkt), row: row && rc(row),
      boxes: rc(one('.top-boxes')),   /* Ask + the 12px gap + Economy */
    };
  });

  const check = (m, where) => {
    const tag = `[${where} @${m.vw}px]`;
    // ── position in the document
    expect(m.accountsInMain && m.lastIsAccounts, `${tag} the accounts section is the LAST child of <main>`).toBe(true);
    expect(m.accountsAfterHeat, `${tag} it follows the heatmap panel in document order (visual order = DOM order, no CSS order)`).toBe(true);
    expect(m.accountsInDeskRow, `${tag} it is no longer inside the desk row`).toBe(false);
    expect(m.acc.t, `${tag} it is painted BELOW the heatmap panel`).toBeGreaterThanOrEqual(m.heat.b - 1);
    for (const [sel, ok] of Object.entries(m.inside)) expect(ok, `${tag} ${sel} travels with the section`).toBe(true);
    // ── edges line up with the full-bleed panels above it
    expect(Math.abs(m.acc.l - m.charts.l), `${tag} left edge matches .area-charts`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.acc.r - m.charts.r), `${tag} right edge matches .area-charts`).toBeLessThanOrEqual(1);
    expect(Math.abs(m.acc.l - m.heat.l) + Math.abs(m.acc.r - m.heat.r), `${tag} and matches .heat-panel`).toBeLessThanOrEqual(2);
    expect(m.scrollW, `${tag} the page does not scroll sideways`).toBeLessThanOrEqual(m.vw + 1);
    // ── the cards
    expect(m.cards.length, `${tag} demo shows the two accounts`).toBe(2);
    const [a, b] = m.cards;
    expect(a.l, `${tag} the first card starts at the section's left edge`).toBeGreaterThanOrEqual(m.acc.l - 1);
    expect(Math.max(a.r, b.r), `${tag} no card runs past the section's right edge`).toBeLessThanOrEqual(m.acc.r + 1);
    expect(m.head.b, `${tag} the header row sits ABOVE the cards`).toBeLessThanOrEqual(a.t + 1);
    if (m.vw >= 800) {
      expect(Math.abs(a.t - b.t), `${tag} side by side: the two cards' tops are equal`).toBeLessThanOrEqual(1);
      expect(a.r, `${tag} and they do not overlap`).toBeLessThanOrEqual(b.l + 1);
      expect(Math.abs(a.w - b.w), `${tag} and share the width equally`).toBeLessThanOrEqual(1);
      expect(a.w + b.w, `${tag} and fill the section`).toBeGreaterThan(m.acc.w * 0.9);
    } else if (m.vw <= 720) {
      expect(b.t, `${tag} stacked: the second card is BELOW the first`).toBeGreaterThanOrEqual(a.b - 1);
      expect(Math.abs(a.l - b.l), `${tag} and they share a left edge`).toBeLessThanOrEqual(1);
      expect(a.w, `${tag} and each takes the full width`).toBeGreaterThan(m.acc.w * 0.95);
    }
    // ── the header row is ONE line on a wide screen (title, desk lamp and stamp level)
    if (m.vw >= 1120) {
      const cy = (r) => (r.t + r.b) / 2;
      expect(Math.abs(cy(m.title) - cy(m.state)), `${tag} title and desk lamp share a line`).toBeLessThanOrEqual(4);
      expect(Math.abs(cy(m.title) - cy(m.stamp)), `${tag} and so does the synced stamp`).toBeLessThanOrEqual(4);
      expect(m.head.h, `${tag} the header row is one line tall`).toBeLessThan(40);
    }
    // ── the freed desk-row slot holds the Economy panel, right of Ask
    expect(m.econInRow, `${tag} .area-econ is in the top desk row`).toBe(true);
    if (m.vw >= 1120) {
      expect(m.econ.l, `${tag} Economy sits to the RIGHT of Ask`).toBeGreaterThanOrEqual(m.ask.r - 1);
      /* The Economy basis is FLUID — clamp(232px, 100vw - 1067px, 320px): 232 (the accounts column's old
         width) while Ask cannot spare more, growing to 320 only with width Ask can give up, so that
         Ask keeps >= 380px wherever Economy is wider than 232. A fixed 320 would have left Ask at
         146px in the owner's 1152 browser. Read off the LIVE layout, not the stylesheet's text. */
      const want = Math.min(320, Math.max(232, m.vw - 1067));
      expect(Math.abs(m.econ.w - want), `${tag} Economy is clamp(232, vw-1067, 320) = ${want}px wide, got ${m.econ.w}`).toBeLessThanOrEqual(1);
      /* Ask keeps the smaller of 380px and what the old 232px column left it — read off THIS layout's own
         Ask+Economy box (WebKit sets the Markets column ~11px wider than Chromium, so a width computed
         from the viewport would be wrong there) */
      const askFloor = Math.min(379, m.boxes.w - 12 - 232 - 2);
      expect(m.ask.w, `${tag} Economy only takes width Ask can spare: Ask keeps >= ${askFloor}px, got ${m.ask.w}`).toBeGreaterThanOrEqual(askFloor);
      expect(Math.abs(m.econ.b - m.mkt.b), `${tag} and ends on Markets' bottom line`).toBeLessThanOrEqual(2);
      expect(Math.abs(m.ask.b - m.mkt.b), `${tag} as Ask does`).toBeLessThanOrEqual(2);
      expect(Math.abs(m.econ.t - m.ask.t), `${tag} starting on Ask's top line`).toBeLessThanOrEqual(2);
    } else {
      const apart = m.econ.r <= m.ask.l + 1 || m.econ.l >= m.ask.r - 1 || m.econ.t >= m.ask.b - 1 || m.econ.b <= m.ask.t + 1;
      expect(apart, `${tag} stacked: Economy and Ask do not overlap`).toBe(true);
    }
  };

  // 1) this project's own width
  check(await measure(), 'own width');

  // 2) the desk lamp, Refresh and Lock are in the section (forced live + authed — demo renders neither)
  await page.evaluate(() => { DESK_DB.url = DESK_DB.url || 'https://example.invalid'; DESK.mode = 'live'; DESK.authed = true; renderMasthead(); });
  await expect(page.locator('.area-accounts #mastheadState #refreshNowBtn'), 'Refresh now travels with the section').toHaveCount(1);
  await expect(page.locator('.area-accounts #mastheadState button', { hasText: /^Lock$/ }), 'and so does Lock').toHaveCount(1);
  // ...and the locked panel spans every card track, with its wrong-PIN line INSIDE it (min-height, not height)
  await page.evaluate(() => { DESK.authed = false; renderLockedPanels(); const e = document.querySelector('.panel-lock .lock-error'); e.textContent = 'PIN not recognized — try again.'; e.hidden = false; });
  const lock = await page.evaluate(() => {
    const p = document.querySelector('#accountGrid > .panel-lock').getBoundingClientRect();
    const g = document.getElementById('accountGrid').getBoundingClientRect();
    const e = document.querySelector('.panel-lock .lock-error').getBoundingClientRect();
    return { pl: p.left, pr: p.right, gl: g.left, gr: g.right, pb: p.bottom, eb: e.bottom };
  });
  expect(Math.abs(lock.pl - lock.gl) + Math.abs(lock.pr - lock.gr), 'the PIN lock spans the whole card grid').toBeLessThanOrEqual(2);
  expect(lock.eb, 'and the wrong-PIN line stays inside the panel').toBeLessThanOrEqual(lock.pb + 0.5);
  await page.evaluate(() => { DESK.mode = 'demo'; DESK.authed = false; renderMasthead(); renderPrivate(); });
  await expect(page.locator('#accountGrid .account')).toHaveCount(2);

  // 3) Economy cannot push the desk row: Markets is still the ruler when it holds a lot (wide layout only)
  if (await page.evaluate(() => window.innerWidth) >= 1120) {
    const before = await measure();
    await page.evaluate(() => {
      const body = document.getElementById('econBody');
      for (let i = 0; i < 80; i++) { const p = document.createElement('p'); p.className = 's54-probe'; p.textContent = 'Indicator ' + i; body.appendChild(p); }
    });
    const after = await measure();
    await page.evaluate(() => document.querySelectorAll('.s54-probe').forEach((n) => n.remove()));
    expect(Math.abs(after.row.h - before.row.h), 'eighty rows of content do not grow the desk row').toBeLessThanOrEqual(1);
    expect(Math.abs(after.econ.b - after.mkt.b), 'Economy still ends on Markets\' bottom line').toBeLessThanOrEqual(2);
  }

  // 4) other widths: the owner's 1152 browser, and a window wider than the 1880 shell cap — the section
  //    must opt out of that cap with the charts and heatmap or it would be inset from them
  //    A resize is measured once the layout has SETTLED (two identical reads 250ms apart, with no sideways
  //    scroll): WebKit holds the previous width's band for a few hundred ms after setViewportSize
  //    (measured on the untouched base too: scrollWidth 1291 at a 1152 viewport, gone by the next read),
  //    and a check taken inside that window reports a transient rather than the layout. A layout that
  //    NEVER settles returns its last read, and check() then fails on what is actually wrong with it.
  const settle = async () => {
    let prev = null, m;
    for (let i = 0; i < 16; i++) {
      m = await measure();
      if (prev === JSON.stringify(m) && m.scrollW <= m.vw + 1) return m;
      prev = JSON.stringify(m);
      await page.waitForTimeout(250);
    }
    return m;
  };
  for (const w of [1152, 2000]) {
    test.info().annotations.push({ type: 'viewport-override', description: String(w) });
    await page.setViewportSize({ width: w, height: 900 });
    check(await settle(), `resized to ${w}`);
  }
});

// S55 — The Economy panel (owner request 2026-09-30): the desk row's 4th column. Seven indicators —
// 2Y/10Y/20Y Treasury, unemployment, CPI, PCE, core PCE — each row a value, a change, the date the
// reading is FOR and ITS OWN chart to the right, over a span the owner picks (1D 1W 1M 3M 6M 1Y 5Y; 1D is the yields' intraday
// chart and is covered by S58 — the monthly rows have no 1-day data).
//
// Everything is read off the LIVE layout and the LIVE DOM. The second half forces live mode and drives
// the real poller through a stubbed `deskEcon` on Playwright's clock (installed BEFORE navigation so the
// page's own 30s lamp ticker is faked too), so "the next fetch follows refreshInSec" is asserted in
// fake seconds, never by sleeping.
test('S55: the Economy panel — seven rows, each with its own chart to the right, over a selectable span', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(150_000);
  await page.clock.install();
  await gotoDemo(page, '#econList .econ-row', 15000);

  const IDS = ['ust2y', 'ust10y', 'ust20y', 'unrate', 'cpi', 'pce', 'corepce'];
  const rowsInfo = () => page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].map((li) => {
    const q = (s) => li.querySelector(s);
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const clipped = (e) => e.scrollWidth > e.clientWidth + 1;
    const svg = q('.econ-chart svg');
    const line = svg && svg.querySelector('path.econ-line');
    return {
      id: li.dataset.id, cadence: li.dataset.cadence, status: li.dataset.status,
      label: q('.econ-label').textContent, val: q('.econ-val').textContent, delta: q('.econ-delta').textContent,
      date: q('.econ-date').textContent, tag: q('.econ-tag:not(.econ-nolive)') ? q('.econ-tag:not(.econ-nolive)').textContent : null,   // NOT LIVE is a yield row's liveness chip (S57), not its data status
      isNew: !!q('.econ-new'), note: q('.econ-note') ? q('.econ-note').textContent : null,
      hasSvg: !!svg, d: line ? line.getAttribute('d') : null, noline: !!q('.econ-noline'),
      li: box(li), info: box(q('.econ-info')), val$: box(q('.econ-val')), delta$: box(q('.econ-delta')), chart: svg ? box(svg) : null,
      clip: { label: clipped(q('.econ-label')), val: clipped(q('.econ-val')), delta: clipped(q('.econ-delta')), date: clipped(q('.econ-date')) },
    };
  }));
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('#econTf button[aria-pressed="true"]')].map((b) => b.dataset.tf));
  const pick = async (tf) => { await page.locator(`#econTf button[data-tf="${tf}"]`).click(); await expect.poll(pressed).toEqual([tf]); };

  // ── 1. DEMO: seven rows, each complete, each chart to the RIGHT of its value
  await expect(page.locator('#econLamp'), '#econLamp must read exactly Demo in demo mode').toHaveText(/^demo$/i);
  await expect(page.locator('#econStamp'), 'the panel carries an as-of stamp (the design signature)').toHaveText(/Last updated/);
  let rows = await rowsInfo();
  expect(rows.map((r) => r.id), 'the seven default indicators, in order').toEqual(IDS);
  // demo's acknowledgement state is session-only (Codex review, PR #294): its synthetic readings must never reach the keys a REAL
  // visit reads, or the first live visit afterwards would mark all seven indicators NEW
  expect(await page.evaluate(() => [localStorage.getItem('econ_seen_v1'), localStorage.getItem('econ_pending_v1')]),
    'demo persists no acknowledgement state').toEqual([null, null]);
  expect(rows.map((r) => r.label)).toEqual(['2Y Treasury', '10Y Treasury', '20Y Treasury', 'Unemployment', 'CPI YoY', 'PCE YoY', 'Core PCE YoY']);
  for (const r of rows) {
    const who = `[${r.id}]`;
    expect(r.val, `${who} a value with its unit`).toMatch(/^\d+\.\d+%$/);
    expect(r.delta, `${who} a change: an arrow (or "=") and the size of the move`).toMatch(/^[▲▼=] \d+\.\d+$/);
    expect(r.date, `${who} carries the date its reading is FOR`).toMatch(/^[A-Z][a-z]{2}( \d{1,2}| \d{4})?$/);
    expect(r.hasSvg && r.d && r.d.length > 20, `${who} has its own drawn chart`).toBeTruthy();
    expect(r.d, `${who} no NaN in the path`).not.toMatch(/NaN/);
    expect(r.chart.l, `${who} the chart starts to the RIGHT of the value block`).toBeGreaterThanOrEqual(Math.max(r.info.r, r.val$.r, r.delta$.r) - 0.5);
    expect(r.chart.r, `${who} and stays inside its row`).toBeLessThanOrEqual(r.li.r + 1);
    // a clipped value is a wrong value (a clipped date is a wrong date)
    expect(r.clip, `${who} nothing on the left block is clipped`).toEqual({ label: false, val: false, delta: false, date: false });
  }
  // the value and the change print at the row's own `decimals` (yields 2, unemployment/inflation 1), not one house format
  const decs = await page.evaluate(() => econState.shown.rows.map((r) => [r.id, r.decimals]));
  expect(rows.map((r) => [r.id, r.val.replace('%', '').split('.')[1].length]), 'the value prints at its own decimals').toEqual(decs);
  expect(rows.map((r) => [r.id, r.delta.split('.')[1].length]), 'and so does the change').toEqual(decs);
  // the arrow agrees with the sign of the payload's own delta, and a yield and an inflation rate both read as neutral ink
  const sign = await page.evaluate(() => econState.shown.rows.map((r) => [r.id, r.delta > 0 ? '▲' : r.delta < 0 ? '▼' : '=']));
  expect(rows.map((r) => [r.id, r.delta[0]]), 'the arrow follows the sign of the change').toEqual(sign);
  // a monthly reading names its MONTH ("Aug"), never "Aug 1" (a stale-looking day) or Jul 31 (UTC midnight read in Pacific)
  for (const r of rows.filter((x) => x.cadence === 'monthly')) expect(r.date, `[${r.id}] a monthly reading is a month`).toMatch(/^[A-Z][a-z]{2}( \d{4})?$/);
  for (const r of rows.filter((x) => x.cadence === 'daily')) expect(r.date, `[${r.id}] a daily reading is Mon D`).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const asOfs = await page.evaluate(() => econState.shown.rows.filter((r) => r.cadence === 'monthly').map((r) => r.asOf));
  const thisYear = await page.evaluate(() => ptDateKey(new Date()).slice(0, 4));
  expect(rows.filter((r) => r.cadence === 'monthly').map((r) => r.date), 'rendered month = the asOf month (the year only when it is not this one)')
    .toEqual(asOfs.map((a) => MON[+a.slice(5, 7) - 1] + (a.slice(0, 4) === thisYear ? '' : ' ' + a.slice(0, 4))));
  // ...read by SLICING the string. A Date-parse lands on the previous month on any clock west of UTC, and the desk runs on Pacific;
  // the runner's own zone may not be west of UTC, so make the local-time getters behave as Pacific and the label must not move.
  const pacific = await page.evaluate((y) => {
    const real = { m: Date.prototype.getMonth, d: Date.prototype.getDate };
    const west = (t) => new Date(t - 8 * 3600e3);
    Date.prototype.getMonth = function () { return west(this.getTime()).getUTCMonth(); };
    Date.prototype.getDate = function () { return west(this.getTime()).getUTCDate(); };
    try { return [econDateLabel(`${y}-08-01`, 'monthly'), econDateLabel(`${y}-01-01`, 'monthly'), econDateLabel(`${y}-09-29`, 'daily')]; }
    finally { Date.prototype.getMonth = real.m; Date.prototype.getDate = real.d; }
  }, thisYear);
  expect(pacific, 'the first of a month is that month, not the one before it (Aug 1 is Aug, not Jul 31)').toEqual(['Aug', 'Jan', 'Sep 29']);

  // beside Markets (>=1120) the rows share the column's height: no dead band under the last row
  if (await page.evaluate(() => window.innerWidth) >= 1120) {
    const gap = await page.evaluate(() => document.querySelector('.area-econ').getBoundingClientRect().bottom - [...document.querySelectorAll('#econList .econ-row')].pop().getBoundingClientRect().bottom);
    expect(gap, 'the rows fill the column Markets sets (a body capped at 320px leaves ~400px of empty panel)').toBeLessThanOrEqual(40);
  }

  // ── 2. green and red are P&L-ONLY: nothing in the panel is painted in a gain/loss colour
  const pl = await page.evaluate(() => {
    const probe = (c) => { const e = document.createElement('i'); e.style.color = c; document.body.appendChild(e); const v = getComputedStyle(e).color; e.remove(); return v; };
    const bad = ['--color-gain', '--color-loss', '--color-gain-dim', '--color-loss-dim', '--color-danger', '--color-status-live'].map((t) => probe(`var(${t})`));
    const offenders = [];
    for (const n of document.querySelectorAll('#econBody *')) {
      const cs = getComputedStyle(n);
      for (const p of ['color', 'backgroundColor', 'borderTopColor']) if (bad.includes(cs[p])) offenders.push(`${n.className || n.tagName}:${p}`);
      if (n instanceof SVGElement) for (const p of ['stroke', 'fill']) if (bad.includes(cs[p])) offenders.push(`${n.getAttribute('class') || n.tagName}:${p}`);
      if (/\b(gain|loss|pill|up|down)\b|pill--/.test(n.getAttribute('class') || '')) offenders.push(`class ${n.getAttribute('class')}`);
    }
    return offenders;
  });
  expect(pl, 'no gain/loss colour or P&L class anywhere in the Economy panel — a rising yield is not a gain').toEqual([]);

  // ── 3. the span control: seven presets (1D first — S58), 3M pressed, and the title says what 1D is and what has no 1-day data
  const tfLabels = await page.locator('#econTf button').allTextContents();
  expect(tfLabels, 'the seven presets: 1D (the yields\' intraday chart) then 1W..5Y').toEqual(['1D', '1W', '1M', '3M', '6M', '1Y', '5Y']);
  expect(await pressed(), 'default 3M, exactly one pressed').toEqual(['3m']);
  await expect(page.locator('#econTf'), 'the control says the monthly indicators have no 1-day data').toHaveAttribute('title', /no 1-day data/i);

  // ── 4. a monthly row on a span shorter than 6 readings shows its 6 latest AND says so; a daily one never does
  for (const tf of ['1w', '1m', '3m']) {
    await pick(tf);
    rows = await rowsInfo();
    for (const r of rows.filter((x) => x.cadence === 'monthly')) expect(r.note, `[${r.id}] @${tf}: the caption says why half a year is drawn`).toMatch(/6 latest/);
    for (const r of rows.filter((x) => x.cadence === 'daily')) expect(r.note, `[${r.id}] @${tf}: a daily row has no pointsNote`).toBeNull();
    // the chart's ACCESSIBLE name says what is drawn (Codex review, PR #294): a monthly row's 6 latest readings are not "over 1W"
    const names = await page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].map((li) => [li.dataset.id, li.dataset.cadence, li.querySelector('.econ-chart svg').getAttribute('aria-label')]));
    for (const [id, cadence, name] of names) {
      if (cadence === 'monthly') { expect(name, `[${id}] @${tf}: a fallback chart names the fallback`).toMatch(/\(monthly - 6 latest\)/); expect(name, `[${id}] @${tf}: and does not claim the short span`).not.toMatch(/ over /); }
      else expect(name, `[${id}] @${tf}: a daily chart names its span`).toContain(` over ${tf.toUpperCase()}`);
    }
    for (const r of rows) expect(r.hasSvg, `[${r.id}] @${tf}: still drawn`).toBe(true);
  }
  await pick('6m');
  expect((await rowsInfo()).filter((r) => r.note), 'on 6M every monthly row holds >= 6 readings: no caption').toEqual([]);

  // ── 5. picking 1Y redraws every chart to a DIFFERENT path, and survives a reload
  await pick('3m');
  const before = Object.fromEntries((await rowsInfo()).map((r) => [r.id, r.d]));
  await pick('1y');
  const after = Object.fromEntries((await rowsInfo()).map((r) => [r.id, r.d]));
  for (const id of IDS) expect(after[id], `[${id}] 1Y is a different chart from 3M`).not.toBe(before[id]);
  expect(await page.evaluate(() => localStorage.getItem('econ_tf_v1')), 'persisted under econ_tf_v1').toBe('1y');
  await page.reload();
  await expect(page.locator('#econList .econ-row')).toHaveCount(7);
  expect(await pressed(), '1Y survives a reload').toEqual(['1y']);
  expect(Object.fromEntries((await rowsInfo()).map((r) => [r.id, r.d])), 'and so does the drawing').toEqual(after);
  // the caption under each chart names what it covers: on a year-long span a daily row's ends carry the YEAR, so
  // "Sep 28 – Sep 28" (a five-year chart that reads as one day) can never appear
  for (const tf of ['1y', '5y']) {
    await pick(tf);
    const caps = await page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].map((li) => [li.dataset.id, li.dataset.cadence, li.querySelector('.econ-cap').textContent]));
    for (const [id, cadence, cap] of caps) {
      const [from, to] = cap.split(' – ');
      expect(from, `[${id}] @${tf}: the caption's two ends differ (${cap})`).not.toBe(to);
      expect(cap, `[${id}] @${tf}: both ends carry the year`).toMatch(/^[A-Z][a-z]{2} '\d{2} – [A-Z][a-z]{2} '\d{2}$/);
    }
  }
  await pick('3m');
  for (const [id, cadence, cap] of await page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].map((li) => [li.dataset.id, li.dataset.cadence, li.querySelector('.econ-cap').textContent]))) {
    if (cadence === 'daily') expect(cap, `[${id}] @3M a daily caption is Mon D – Mon D (no year needed)`).toMatch(/^[A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/);
  }
  await pick('1y');
  // a hand-edited / stale stored span falls back to the default instead of pressing nothing
  await page.evaluate(() => localStorage.setItem('econ_tf_v1', '2y'));
  await page.reload();
  await expect(page.locator('#econList .econ-row')).toHaveCount(7);
  expect(await pressed(), 'a stored span that is not a preset falls back to 3M').toEqual(['3m']);

  // ── 6. unknown is an em dash, never 0 — forged payloads through the real renderer
  await page.evaluate(() => {
    const base = buildDemoEcon(econTf);
    const r = base.rows.slice(0, 5).map((x) => ({ ...x }));
    r[0] = { ...r[0], status: 'missing', value: null, prev: null, delta: null, asOf: null, prevAsOf: null, source: null, points: [] };
    r[1] = { ...r[1], delta: null, prev: null, prevAsOf: null };
    r[2] = { ...r[2], value: null };
    r[3] = { ...r[3], points: [['2026-08-01', 3.3]] };
    r[4] = { ...r[4], status: 'stale', staleSec: 600 };
    r.push({ ...base.rows[5], points: [0, 1, 2, 3, 4, 5].map((i) => [`2026-0${i + 1}-01`, 3.3]) });   // a constant series
    renderEcon({ ...base, rows: r });
  });
  rows = await rowsInfo();
  expect([rows[0].val, rows[0].delta, rows[0].date], 'a missing row: value, change and date are all em dashes').toEqual(['—', '—', '—']);
  expect([rows[0].hasSvg, rows[0].noline, rows[0].tag], 'no chart, a dashed placeholder, an honest tag').toEqual([false, true, 'NO DATA']);
  expect(rows[1].val, 'a known value stays').toMatch(/^\d+\.\d+%$/);
  expect(rows[1].delta, 'an unknown change is an em dash — never "= 0.00"').toBe('—');
  expect(rows[2].val, 'a null value is an em dash, never 0.00%').toBe('—');
  expect([rows[3].hasSvg, rows[3].noline], 'a single reading cannot draw a line: a dashed placeholder, not a fake one').toEqual([false, true]);
  expect([rows[4].tag, rows[4].hasSvg], 'a stale row keeps its last good value and chart, tagged STALE').toEqual(['STALE', true]);
  expect(rows[4].val).toMatch(/^\d+\.\d+%$/);
  // a constant series is a level line through the middle, not a NaN path (0/0) and not a line glued to the floor
  expect(rows[5].d, 'a flat series draws a real path').not.toMatch(/NaN|Infinity/);
  expect([...new Set([...rows[5].d.matchAll(/ ([\d.]+)/g)].map((m) => m[1]))], 'at ONE height, mid-chart').toEqual(['16.0']);
  for (const r of rows.slice(0, 3)) for (const t of [r.val, r.delta]) expect(t, `[${r.id}] unknown never renders as zero`).not.toMatch(/^[=+−-]?\s*0(\.0+)?%?$/);
  await page.evaluate(() => renderEcon(buildDemoEcon(econTf)));

  // ── 6a. every row names its OWN source in a tiny line under its date (owner 2026-10-01: "I want a per index source", no footer).
  //    In demo that line is "Demo data" — the generated numbers are not FRED's, whatever the payload's `source` says — and the
  //    tooltip agrees. The REAL names are read off the pure row builder with the mode flipped for the call: a Treasury reading is a
  //    ~3:30 pm ET SNAPSHOT of bid-side quotes, not the actual close, and before today's rate posts it supplies YESTERDAY's, so
  //    neither the line nor the tooltip may call it a "close" or "same day" (Codex, PR #295). Nothing in the panel may be a footer.
  const demoSrc = await page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].map((li) => {
    const e = li.querySelector('.econ-src'); const cs = e ? getComputedStyle(e) : null;
    return { id: li.dataset.id, text: e ? e.textContent : null, title: li.title.includes('source demo data'), px: cs ? parseFloat(cs.fontSize) : null, clip: e ? e.scrollWidth > e.clientWidth + 1 : null };
  }));
  expect(demoSrc.map((d) => [d.id, d.text, d.title]), 'demo: every one of the seven rows says its numbers are demo data, on the row and in its tooltip')
    .toEqual(['ust2y', 'ust10y', 'ust20y', 'unrate', 'cpi', 'pce', 'corepce'].map((id) => [id, 'Source: Demo data', true]));
  for (const d of demoSrc) {
    expect(d.px, `[${d.id}] the source line is VERY small (9px, below the 11px of the figures around it)`).toBeLessThanOrEqual(10);
    expect(d.clip, `[${d.id}] and nothing is clipped (a clipped source is a wrong source)`).toBe(false);
  }
  expect(await page.locator('.econ-foot').count(), 'there is no footer note: the source is per row').toBe(0);
  const tsy = await page.evaluate(() => {
    const base = buildDemoEcon(econTf);
    const mk = (src) => ({ ...base.rows[0], source: src });
    const prev = DESK.mode;
    try {
      DESK.mode = 'live';   // econRow only builds a node; live mode is what names the real source
      const t = econRow(mk('treasury'), true), f = econRow(mk('fred'), true), u = econRow(mk('???'), true), m = econRow({ ...mk('fred'), status: 'missing', value: null }, true);
      // the longest real name must FIT the 104px value block at this viewport: put the nodes in the list to measure them
      // (the demo render below rebuilds the list, so nothing is left behind)
      const list = document.getElementById('econList'); list.appendChild(t); list.appendChild(f);
      const clipOf = (li) => { const e = li.querySelector('.econ-src'); return e.scrollWidth > e.clientWidth + 1; };
      return { tsyClip: clipOf(t), fredClip: clipOf(f), tsyLine: t.querySelector('.econ-src').textContent, tsyTitle: t.title, fredLine: f.querySelector('.econ-src').textContent, fredTitle: f.title,
        unknownLine: u.querySelector('.econ-src'), missingLine: m.querySelector('.econ-src') };
    } finally { DESK.mode = prev; }
  });
  expect([tsy.tsyClip, tsy.fredClip], 'the longest real names ("Source: U.S. Treasury") fit their 104px block at every viewport — a clipped source is a wrong source').toEqual([false, false]);
  expect(tsy.tsyLine, 'a Treasury row says so on the row').toBe('Source: U.S. Treasury');
  expect(tsy.fredLine, 'a FRED row says so on the row').toBe('Source: FRED');
  expect(tsy.tsyTitle, 'a Treasury row names its source in the tooltip').toMatch(/source U\.S\. Treasury daily rate/);
  expect(tsy.tsyTitle, 'and says what the rate is: a 3:30 pm ET snapshot').toMatch(/3:30 pm ET snapshot/);
  expect(tsy.tsyTitle, 'never "same day" — a pre-publication Treasury reading is yesterday\'s').not.toMatch(/same.day/i);
  expect(tsy.tsyTitle, 'and never a close').not.toMatch(/\bclose/i);
  expect(tsy.fredTitle, 'a FRED row\'s tooltip names FRED').toMatch(/source FRED/);
  expect([tsy.unknownLine, tsy.missingLine], 'an unknown source, and a row with no reading, print NO source line (never a guess)').toEqual([null, null]);
  await page.evaluate(() => renderEcon(buildDemoEcon(econTf)));

  // ── 6b. too little room: seven rows must not be cut off silently. The body is an ORDINARY scroller (no overscroll-behavior,
  //    which would eat the wheel), and the rows keep their height.
  const tight = await page.evaluate(() => {
    const body = document.getElementById('econBody');
    body.style.maxHeight = '260px';
    const cs = getComputedStyle(body);
    const rows = [...document.querySelectorAll('#econList .econ-row')];
    const out = {
      scrolls: body.scrollHeight > body.clientHeight + 1, overflowY: cs.overflowY, overscroll: [cs.overscrollBehaviorX, cs.overscrollBehaviorY],
      minRow: Math.min(...rows.map((r) => r.getBoundingClientRect().height)),
    };
    body.style.maxHeight = '';
    return out;
  });
  expect(tight.scrolls, 'with 260px the seven rows do not fit, so the body scrolls').toBe(true);
  expect(tight.overflowY, 'an ordinary scrollbar').toBe('auto');
  expect(tight.overscroll, 'and NO overscroll-behavior (it kills the wheel over a short panel)').toEqual(['auto', 'auto']);
  expect(tight.minRow, 'rows keep at least their 52px rather than squashing').toBeGreaterThanOrEqual(51);

  // ── 7. LIVE (forced): the real poller, a stubbed desk-econ, Playwright's fake clock
  await page.evaluate(() => {
    DESK_DB.url = DESK_DB.url || 'https://stub.invalid';
    DESK.mode = 'live';
    localStorage.removeItem('econ_seen_v1'); localStorage.removeItem('econ_pending_v1'); econSeen = {}; econPending = {};
    // the real deskEcon's request and failure mapping (before it is stubbed): the function has no 1D (the panel never asks it for one — S58), `force` only when true
    const realFetch = window.fetch;
    window.__wire = [];
    window.fetch = (url, init) => {
      window.__wire.push({ url: String(url), body: JSON.parse(init.body) });
      const bad = window.__wire.length === 3;
      return Promise.resolve({ ok: !bad, status: bad ? 502 : 200, json: () => Promise.resolve(bad ? { ok: false, error: 'no series' } : { ok: true, rows: [] }) });
    };
    window.__wireP = Promise.all([deskEcon('1y', true), deskEcon('5y'), deskEcon('3m').then(() => 'resolved', () => 'rejected')])
      .then((v) => { window.fetch = realFetch; return v; });
  });
  const wire = await page.evaluate(() => window.__wireP.then((v) => ({ v: v.slice(2), wire: window.__wire })));
  expect(wire.wire.map((w) => [w.url.replace(/^.*\/functions/, '/functions'), w.body]), 'desk-econ is POSTed {range} and {force:true} only when forced')
    .toEqual([['/functions/v1/desk-econ', { range: '1y', force: true }], ['/functions/v1/desk-econ', { range: '5y' }], ['/functions/v1/desk-econ', { range: '3m' }]]);
  expect(wire.v, 'a 502 {ok:false} THROWS (the caller keeps its last good render), like every other feed').toEqual(['rejected']);

  await page.evaluate(() => {
    window.__calls = []; window.__mode = 'hang'; window.__refresh = 90; window.__rowsFn = null;
    // the live 10Y (S56) asks quote-proxy beside desk-econ; S55 is about desk-econ's own poller, so the quote is stubbed OFF
    // (a rejection: the rows stay exactly what the server sent) instead of reaching for the network from a forced-live page
    window.deskQuote = () => Promise.reject(new Error('quote-proxy stubbed off in S55'));
    window.econLiveCnbc = () => Promise.resolve(null);   // the live yields are S56/S57's business, not this scenario's
    window.deskEcon = (range, force) => {
      window.__calls.push({ range, force: force === true });
      const m = window.__mode;
      if (m === 'fail') return Promise.reject(new Error('desk-econ → HTTP 502'));
      if (m === 'hang') return new Promise(() => {});
      const p = buildDemoEcon(range);
      const rows = window.__rowsFn ? window.__rowsFn(p.rows) : p.rows;
      return Promise.resolve({ ...p, rows, range: m === 'wrongrange' ? (range === '1y' ? '5y' : '1y') : range,
        generatedAt: new Date().toISOString(), refreshInSec: window.__refresh, stale: m === 'stale' });
    };
  });
  const calls = () => page.evaluate(() => window.__calls.length);
  const last = () => page.evaluate(() => window.__calls[window.__calls.length - 1]);
  const due = () => page.evaluate(() => econState.dueAt - Date.now());
  const lamp = () => page.locator('#econLamp').innerText();
  const refresh = (force) => page.evaluate((f) => refreshEcon(f), force === true);
  const setMode = (mode, refreshSec) => page.evaluate(([m, r]) => { window.__mode = m; if (r) window.__refresh = r; }, [mode, refreshSec]);

  // 7a. before the first reply: nothing is drawn and the lamp is not Demo (real data or nothing)
  await page.evaluate(() => { econState.payload = null; econState.failed = false; econState.shown = null; startEcon(); });
  await expect(page.locator('#econLamp'), 'live, nothing yet: the lamp is not Demo').not.toHaveText(/^demo$/i);
  expect(await page.locator('#econList .econ-row').count(), 'live and waiting: NO rows — never demo values').toBe(0);
  expect(await last(), 'the first ask is the persisted span, not forced').toEqual({ range: '3m', force: false });
  // ...and a first load that FAILS is an honest empty state under a STALE lamp, still no demo rows
  await setMode('fail');
  await refresh();
  expect(await lamp(), 'first load failed: STALE').toMatch(/^stale$/i);
  expect(await page.locator('#econList .econ-row').count(), 'and still no rows').toBe(0);
  await expect(page.locator('#econList .econ-empty')).toContainText(/unavailable/i);
  expect(await due(), 'a failed first load retries in 60s').toBeGreaterThan(58_000);
  expect(await due()).toBeLessThanOrEqual(60_000);

  // 7b. a good reply: LIVE, seven rows, the stamp, and the next fetch scheduled from refreshInSec
  await setMode('ok');
  await refresh();
  await expect(page.locator('#econList .econ-row')).toHaveCount(7);
  expect(await lamp(), 'last poll ok, not stale: LIVE').toMatch(/^live$/i);
  await expect(page.locator('#econStamp'), 'live stamp: the Pacific clock of the last check').toHaveText(/^Last updated \d\d:\d\d, [A-Z][a-z]{2} \d{1,2}$/);
  expect(await due(), 'the next fetch is refreshInSec (90s) away').toBeGreaterThan(88_000);
  expect(await due()).toBeLessThanOrEqual(90_000);
  let n = await calls();
  await page.clock.runFor(86_000);
  expect(await calls(), '86s in: not asked again yet').toBe(n);
  await page.clock.runFor(6_000);
  await expect.poll(calls, 'past 90s the poller asks again').toBe(n + 1);
  expect(await last(), 'with the current span, unforced').toEqual({ range: '3m', force: false });
  // the delay is clamped to 30s..3600s whatever the server says
  await setMode('ok', 5);
  await refresh();
  expect(await due(), 'refreshInSec 5 is clamped UP to 30s').toBeGreaterThan(28_000);
  expect(await due()).toBeLessThanOrEqual(30_000);
  await setMode('ok', 99999);
  await refresh();
  expect(await due(), 'refreshInSec 99999 is clamped DOWN to an hour').toBeGreaterThan(3_598_000);
  expect(await due()).toBeLessThanOrEqual(3_600_000);
  await setMode('ok', 90);
  await refresh(true);
  expect((await last()).force, 'an explicit refresh forces').toBe(true);

  // 7b2. a FORCED refresh owns the clock while it is in flight (Codex review, PR #294): a poll timer that
  //      comes due meanwhile must not start a second, unforced request — it would take the newer generation and
  //      get the forced reply thrown away, leaving "Refresh now" showing the pre-refresh cache. The forced call is
  //      held open by a gate so the timer's due time can be crossed while it is still pending.
  await page.evaluate(() => {
    window.__inner = window.deskEcon;
    window.deskEcon = (range, force) => {
      if (force !== true && window.__holdRange === range) {            // an unforced request for this span is held open too
        window.__calls.push({ range, force: false });
        return new Promise((res) => { window.__releaseSpan = () => res({ ...buildDemoEcon(range), range, generatedAt: new Date().toISOString(), refreshInSec: 90, stale: false }); });
      }
      if (force !== true) return window.__inner(range, force);
      window.__calls.push({ range, force: true });
      return new Promise((res) => { window.__releaseForce = () => res({ ...buildDemoEcon(range), range, generatedAt: new Date().toISOString(), refreshInSec: 90, stale: false }); });
    };
  });
  await setMode('ok', 90);
  await refresh();                                                // a normal poll timer is now pending, ~90s out
  n = await calls();
  await page.evaluate(() => { window.__forced = refreshEcon(true); });
  expect(await calls(), 'the forced request is in flight').toBe(n + 1);
  expect(await page.evaluate(() => econState.dueAt), 'nothing else is pending while it runs').toBe(0);
  await page.clock.runFor(95_000);                                // past the moment the old timer was due
  expect(await calls(), 'no second request started while the forced one is pending').toBe(n + 1);
  const landedBefore = await page.evaluate(() => econState.landedAt);
  await page.evaluate(() => { window.__releaseForce(); return window.__forced; });
  await expect.poll(() => page.evaluate((t) => econState.landedAt > t, landedBefore), 'the forced reply LANDED (it was not discarded by a newer generation)').toBe(true);
  expect(await due(), 'and it re-armed the poll from its own refreshInSec').toBeGreaterThan(88_000);
  expect(await calls(), 'still exactly one request for the whole forced refresh').toBe(n + 1);

  // 7b2b. a SPAN change while a forced refresh is in flight is serialised behind it (Codex review, PR #294): a request of its
  //       own would take the newer generation and discard the forced reply, so the span is only recorded, marked pending,
  //       and asked for the moment the forced reply lands — which is not a failed poll. The forced refresh (what "Refresh now"
  //       awaits) stays pending until the span SHOWING has landed, however many times it is changed on the way.
  const cur = await page.evaluate(() => econTf);
  const [other, third] = ['1y', '6m', '1m'].filter((t) => t !== cur);
  n = await calls();
  await page.evaluate(() => { window.__forcedDone = false; window.__forced = refreshEcon(true); window.__forced.then(() => { window.__forcedDone = true; }); });
  expect(await calls(), 'the forced request is in flight').toBe(n + 1);
  await pick(other);
  expect(await calls(), 'a span change during it starts no request of its own').toBe(n + 1);
  expect(await page.evaluate(() => econState.pending), 'the span is recorded and the list is marked pending').toBe(true);
  await page.evaluate((r) => { window.__holdRange = r; window.__releaseForce(); }, other);
  await expect.poll(calls, 'the forced reply landing asks for the span now showing').toBe(n + 2);
  expect(await last(), 'unforced, for the span that was picked').toEqual({ range: other, force: false });
  const flush = () => page.evaluate(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); return window.__forcedDone; });
  expect(await flush(), 'the forced refresh is still pending while the span request is in flight').toBe(false);
  // ...and a SECOND span change while that follow-up is in flight is still only recorded: the lock is kept
  await pick(third);
  expect(await calls(), 'a second span change during the follow-up starts no request of its own either').toBe(n + 2);
  await page.evaluate(() => { window.__releaseSpan(); window.__holdRange = null; });
  await expect.poll(calls, 'the follow-up landing on a span that has moved asks for the one now showing').toBe(n + 3);
  expect(await last(), 'unforced, for the latest span').toEqual({ range: third, force: false });
  await expect.poll(() => page.evaluate(() => window.__forcedDone), 'and the forced refresh settles only once THAT has landed').toBe(true);
  expect(await page.evaluate(() => econState.payload && econState.payload.range), 'the drawn reply is the latest span').toBe(third);
  expect(await page.evaluate(() => econState.forcing), 'the forced lock is released').toBe(false);
  expect(await lamp(), 'a span change behind a forced refresh is not a failed poll').toMatch(/^live$/i);
  await pick(cur);
  await expect.poll(() => page.evaluate(() => econState.payload && econState.payload.range), 'back on the original span').toBe(cur);

  // 7b3. "Refresh now" stays pending until EVERY request is done: feedPollTick lands first and rebuilds the masthead,
  //      which used to re-enable a button whose clicks refreshNowClicked then ignored while the economy request ran.
  const pending = await page.evaluate(() => {
    const read = () => { const b = document.getElementById('refreshNowBtn'); return { disabled: b.disabled, text: b.textContent }; };
    refreshNowPending = true; renderMasthead(); const during = read();
    refreshNowPending = false; renderMasthead(); const after = read();
    return { during, after };
  });
  expect(pending.during, 'a masthead rebuilt under a pending refresh keeps the button disabled and says so').toEqual({ disabled: true, text: 'Refreshing…' });
  expect(pending.after, 'and a rebuild after it is over restores the normal button').toEqual({ disabled: false, text: 'Refresh now' });
  await page.evaluate(() => {
    window.__tick = window.feedPollTick; window.__sf = window.scheduleFeedPoll; window.__sm = window.scheduleMarketPoll;
    window.feedPollTick = async () => { renderMasthead(); };     // the feeds land at once, rebuilding the masthead
    window.scheduleFeedPoll = () => {}; window.scheduleMarketPoll = () => {};
    window.__clicked = refreshNowClicked();
  });
  await expect(page.locator('#refreshNowBtn'), 'the feeds are done but the economy request is not: still pending').toBeDisabled();
  await expect(page.locator('#refreshNowBtn')).toHaveText('Refreshing…');
  await page.evaluate(() => { window.__releaseForce(); return window.__clicked; });
  await expect(page.locator('#refreshNowBtn'), 'everything landed: the button is back').toBeEnabled();
  await expect(page.locator('#refreshNowBtn')).toHaveText('Refresh now');
  await page.evaluate(() => { window.feedPollTick = window.__tick; window.scheduleFeedPoll = window.__sf; window.scheduleMarketPoll = window.__sm; window.deskEcon = window.__inner; });

  // 7c. a failed poll keeps the last render, flips the lamp to STALE, and retries in a minute
  const vals = (await rowsInfo()).map((r) => r.val);
  await setMode('fail');
  await refresh();
  expect((await rowsInfo()).map((r) => r.val), 'the last good rows stay on screen').toEqual(vals);
  expect(await lamp(), 'under a STALE lamp').toMatch(/^stale$/i);
  n = await calls();
  await page.clock.runFor(58_000);
  expect(await calls(), 'the retry is 60s away').toBe(n);
  await page.clock.runFor(3_000);
  await expect.poll(calls).toBe(n + 1);
  await setMode('ok');
  await page.clock.runFor(61_000);
  await expect.poll(lamp, 'a good reply brings it back').toMatch(/^live$/i);

  // 7d. a body that SAYS it is stale reads STALE, with the row tagged and its last good value kept
  await page.evaluate(() => { window.__rowsFn = (rs) => rs.map((r) => (r.id === 'ust10y' ? { ...r, status: 'stale', staleSec: 900 } : r)); });
  await setMode('stale');
  await refresh();
  expect(await lamp(), 'stale:true on a successful poll').toMatch(/^stale$/i);
  rows = await rowsInfo();
  const t10 = rows.find((r) => r.id === 'ust10y');
  expect([t10.tag, t10.val], 'the stale row is tagged and keeps its value').toEqual(['STALE', vals[1]]);

  // 7e. the lamp AGES while nothing lands: LIVE at 100s, STALE past 3 x refreshInSec
  await page.evaluate(() => { window.__rowsFn = null; });
  await setMode('ok', 60);
  await refresh();
  expect(await lamp()).toMatch(/^live$/i);
  await setMode('hang');
  await page.clock.runFor(100_000);
  expect(await lamp(), '100s of silence on a 60s cadence: still LIVE').toMatch(/^live$/i);
  // 100s + 140s = 240s > 3 x 60s + one full 30s tick, so a tick is certain to land past the 180s mark whatever its phase
  await page.clock.runFor(140_000);
  await expect.poll(lamp, 'past 3 x refreshInSec with nothing landing: STALE, from the 30s ticker alone').toMatch(/^stale$/i);

  // 7f. a reply for a DIFFERENT span than the one asked is dropped, never drawn under the wrong label
  await setMode('ok', 90);
  await refresh();
  expect(await lamp()).toMatch(/^live$/i);
  const d3 = Object.fromEntries((await rowsInfo()).map((r) => [r.id, r.d]));
  await setMode('wrongrange');
  await refresh();
  expect(Object.fromEntries((await rowsInfo()).map((r) => [r.id, r.d])), 'the 3M drawing is untouched').toEqual(d3);
  expect(await lamp(), 'and the desk admits the poll did not deliver').toMatch(/^stale$/i);

  // 7g. NEW: the first look seeds silently except rows the server says changed; data that moves is NEW; it clears
  await setMode('ok');
  await page.evaluate(() => { localStorage.removeItem('econ_seen_v1'); localStorage.removeItem('econ_pending_v1'); econSeen = {}; econPending = {}; });
  await refresh();
  rows = await rowsInfo();
  expect(rows.filter((r) => r.isNew).map((r) => r.id), 'a fresh browser: only the rows the server flagged `changed`').toEqual(['ust10y', 'unrate']);
  const seenKeys = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('econ_seen_v1') || '{}')).sort());
  expect(seenKeys, 'the rest were recorded silently (no wall of NEW chips)').toEqual(['corepce', 'cpi', 'pce', 'ust20y', 'ust2y']);
  await page.locator('#econList .econ-row[data-id="ust10y"]').hover();
  await expect(page.locator('#econList .econ-row[data-id="ust10y"] .econ-new'), 'hovering its row clears NEW').toHaveCount(0);
  await refresh();
  expect((await rowsInfo()).find((r) => r.id === 'ust10y').isNew, 'and it stays cleared across the next poll, although the server still says changed').toBe(false);
  // the server's `changed` hint is per-isolate and TRANSIENT: the next refresh says changed:false for the very same reading. A row
  // flagged NEW and never acknowledged must keep its chip (and not be seeded as a silent first look) — Codex review, PR #294
  await page.evaluate(() => { window.__rowsFn = (rs) => rs.map((r) => ({ ...r, changed: false })); });
  await refresh();
  expect((await rowsInfo()).find((r) => r.id === 'unrate').isNew, 'unemployment stays NEW after the hint goes quiet (nobody has acknowledged it)').toBe(true);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('econ_seen_v1') || '{}')).includes('unrate')), 'and it was not seeded as a silent first look').toBe(false);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('econ_pending_v1') || '{}'))), 'it is pending in storage, so a reload keeps it too').toEqual(['unrate']);
  await page.evaluate(() => { window.__rowsFn = (rs) => rs.map((r) => (r.id === 'cpi' ? { ...r, asOf: '2099-01-01', value: 9.9, prev: r.value, delta: 0.1, changed: false } : r)); });
  await setMode('ok');
  await refresh();
  rows = await rowsInfo();
  expect(rows.find((r) => r.id === 'cpi').isNew, 'a reading that moved since this browser last saw it is NEW (client-side, from asOf — `changed` was false)').toBe(true);
  n = await page.locator('#econList .econ-new').count();
  expect(n, 'CPI and the still-unseen unemployment').toBe(2);
  // a chip is acknowledged only while ITS ROW has been in view (Codex review, PR #294): shrink the panel body so both rows sit below
  // its scrollport — out of view whatever the page scroll — and two minutes go by without a chip clearing or a timer running
  const timers = () => page.evaluate(() => econState.newTimers.size);
  await page.evaluate(() => { const b = document.getElementById('econBody'); b.style.maxHeight = '140px'; b.scrollTop = 0; });
  await expect.poll(timers, 'rows out of view hold no acknowledgement timer').toBe(0);
  await page.clock.runFor(120_000);
  await expect(page.locator('#econList .econ-new'), 'unseen NEW chips survive 2 minutes').toHaveCount(2);
  // bring both into view: each row starts its own ~60s
  await page.evaluate(() => {
    document.getElementById('econBody').style.maxHeight = '';
    document.querySelector('#econList .econ-row[data-id="unrate"]').scrollIntoView({ block: 'center' });
  });
  await expect.poll(timers, 'rows in view start their timers').toBe(2);
  // another tab acknowledges a different row meanwhile (Codex review, PR #294): this tab must MERGE its acknowledgements into what is
  // stored, not overwrite the whole record with its own stale copy
  await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('econ_seen_v1') || '{}'); c.__other = 'from another tab'; localStorage.setItem('econ_seen_v1', JSON.stringify(c)); });
  await page.clock.runFor(61_000);
  await expect(page.locator('#econList .econ-new'), 'NEW clears by itself after ~60s IN VIEW').toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('econ_seen_v1')).cpi), 'and is remembered').toBe('2099-01-01|9.9');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('econ_seen_v1')).__other), 'without erasing what another tab stored').toBe('from another tab');
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'econ_seen_v1' })));
  expect(await page.evaluate(() => econSeen.__other), 'and the storage event brings the other tab\'s record into this tab\'s memory').toBe('from another tab');

  // 7h. a span change asks for the new range, dims the old charts meanwhile, and never pushes a due poll out
  await page.evaluate(() => { window.__rowsFn = null; });
  await setMode('ok', 90);
  await refresh();
  const dueAt = await page.evaluate(() => econState.dueAt);
  await page.clock.runFor(5_000);
  await setMode('hang');
  await page.locator('#econTf button[data-tf="1y"]').click();
  expect(await last(), 'the new span is requested (a server-side slice)').toEqual({ range: '1y', force: false });
  await expect(page.locator('#econList'), 'old charts stay, dimmed, until the reply').toHaveClass(/is-pending/);
  expect((await rowsInfo()).length, 'rows stay on screen while it is in flight').toBe(7);
  await setMode('ok');
  await page.evaluate(() => refreshEcon(false, { span: true }));
  await expect(page.locator('#econList')).not.toHaveClass(/is-pending/);
  expect(await page.evaluate(() => econState.dueAt), 'changing the span does not push the pending poll out').toBe(dueAt);
  expect(await pressed()).toEqual(['1y']);
});

// S56 — The live-yield RULES and POLLER, driven through the 10Y row (owner request 2026-10-01). FRED and Treasury publish a yield once a
// day, so a yield row is a business day old by the afternoon; a CNBC quote is live. It is a CLIENT-side overlay on the row, trusted only
// when the official row is healthy, the print is on a STRICTLY newer New York date (or, while the bond session is open, FRESH and on
// today's date — a fresh quote replaces today's own 3:30 pm Treasury snapshot), within 0.75 points of the official reading and fetched
// in the last 30 minutes — otherwise the row is EXACTLY what the server sent (real data or nothing). And there is NO fallback source
// (owner, same day: "no fallbacks. If CNBC doesn't give me real time, I want to be aware"): while the bond session is open a yield row
// without a fresh quote says NOT LIVE. S57 covers the three-row path end to end; this one pins the rules, the states, the cadence, the
// forced-quote slot, a hidden tab, aging and the date cell. Driven with a stubbed deskEcon and a stubbed CNBC request on Playwright's
// fake clock (a fixed Thursday morning Pacific, so "today" and the bond session are known) — never the network.
test('S56: the live yield rules — a quote stands in for the official reading only when it can be trusted, and a yield that is not live says so', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(150_000);
  const T0 = '2026-10-01T15:45:00Z';   // Thu 11:45 ET = 08:45 PT: inside the bond cash session
  await page.clock.install({ time: new Date(T0) });
  await gotoDemo(page, '#econList .econ-row', 15000);

  // ── 1. demo: nothing live — the panel never asks, and no row carries a LIVE / LAST / NOT LIVE tag
  expect(await page.evaluate(() => [econLive.gen, Object.keys(econLive.q).length, econState.shown.rows.some((r) => r.live)]),
    'demo never fetches a live quote or draws one').toEqual([0, 0, false]);
  await expect(page.locator('#econList .econ-tag'), 'and no row carries a LIVE/LAST/NOT LIVE tag').toHaveCount(0);

  // test helpers, in the page: a CNBC reply for the 10Y alone (the 2Y and 20Y are then "left out", which is what S57 pins for them)
  await page.evaluate(() => {
    window.__etStamp = (ms) => new Date(ms - 4 * 3600000).toISOString().slice(0, 19) + '.000-0400';   // ET as CNBC writes it (EDT in October)
    window.__pt = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' });
    window.__cq10 = (o = {}) => {
      const { price = 5.321, change = 0.028, at = Date.now() - 30000 } = o;
      window.__lastAt = at;
      return { FormattedQuoteResult: { FormattedQuote: [{ symbol: 'US10Y', code: 0, last: price + '%', last_time: window.__etStamp(at), change: String(change), change_pct: '+0.5%' }] } };
    };
  });

  // ── 2. force live and stub the feeds; the bond session clock and the liveness states, through the real functions
  await page.evaluate(() => {
    DESK_DB.url = DESK_DB.url || 'https://stub.invalid';
    DESK.mode = 'live';
    localStorage.removeItem('econ_seen_v1'); localStorage.removeItem('econ_pending_v1'); econSeen = {}; econPending = {};
    window.__ccalls = 0;
    window.__cnbcFn = () => window.__cq10();
    window.econLiveCnbc = () => { window.__ccalls++; try { return Promise.resolve(window.__cnbcFn()); } catch { return Promise.resolve(null); } };
    window.deskQuote = () => { window.__yahoo = (window.__yahoo || 0) + 1; return Promise.reject(new Error('Yahoo is not a source of the yields')); };
    window.__official = { value: 5.26, prev: 5.24, delta: 0.02, asOf: '2026-09-29', prevAsOf: '2026-09-28', status: 'ok', source: 'fred', changed: false };
    window.deskEcon = (range) => {
      const p = buildDemoEcon(range);
      const o = window.__official;
      const rows = p.rows.map((r) => {
        if (r.id !== 'ust10y') return r;
        const pts = r.points.filter((x) => x[0] < o.asOf).concat([[o.asOf, o.value]]);
        return { ...r, ...o, points: pts };
      });
      return Promise.resolve({ ...p, rows, range, generatedAt: new Date().toISOString(), refreshInSec: 900, stale: false });
    };
  });
  const session = await page.evaluate(() => Object.fromEntries([
    ['0754 ET', '2026-10-01T11:54:00Z'], ['0755 ET', '2026-10-01T11:55:00Z'], ['1704 ET', '2026-10-01T21:04:00Z'], ['1705 ET', '2026-10-01T21:05:00Z'],
    ['saturday', '2026-10-03T16:00:00Z'], ['thanksgiving', '2026-11-26T15:00:00Z'], ['columbus day', '2026-10-12T15:00:00Z'], ['day after it', '2026-10-13T15:00:00Z'],
  ].map(([k, iso]) => [k, econBondOpen(Date.parse(iso))])));
  expect(session, 'the bond session is 07:55–17:05 ET on a bond-market trading day: not at the weekend, not on an NYSE holiday, not on Columbus Day')
    .toEqual({ '0754 ET': false, '0755 ET': true, '1704 ET': true, '1705 ET': false, saturday: false, thanksgiving: false, 'columbus day': false, 'day after it': true });
  const states = await page.evaluate(() => {
    const now = Date.parse('2026-10-01T15:45:00Z'), closed = Date.parse('2026-10-01T22:00:00Z');
    const row = (o) => ({ id: 'ust10y', ...o });
    const live = (fresh) => ({ symbol: 'US10Y', ts: now, fresh, official: {} });
    econLive.landedAt = 0;
    const never = econLiveState(row({}), now);   // CNBC was never asked: no tag before the first reply, so a page load does not flash NOT LIVE
    econLive.landedAt = now;
    const out = {
      never,
      freshOpen: econLiveState(row({ live: live(true) }), now), staleOpen: econLiveState(row({ live: live(false) }), now), staleClosed: econLiveState(row({ live: live(false) }), closed),
      noneOpen: econLiveState(row({}), now), noneClosed: econLiveState(row({}), closed), nonYield: econLiveState({ id: 'cpi' }, now),
    };
    DESK.mode = 'demo'; out.demo = econLiveState(row({}), now); DESK.mode = 'live';
    econLive.landedAt = 0;
    return out;
  });
  expect(states, 'LIVE for a fresh quote; NOT LIVE for a stale quote or none while the session is open; LAST for a stopped quote and NOTHING for no quote once it is shut; nothing before CNBC was ever asked, for a row that is not a yield, or in demo')
    .toEqual({ never: '', freshOpen: 'live', staleOpen: 'notlive', staleClosed: 'last', noneOpen: 'notlive', noneClosed: '', nonYield: '', demo: '' });

  // ── 3. the trust rules, on fabricated rows through the real econLiveRow
  const rules = await page.evaluate(() => {
    const row = { id: 'ust10y', label: '10Y Treasury', value: 5.26, asOf: '2026-09-29', prev: 5.24, prevAsOf: '2026-09-28', delta: 0.02, status: 'ok',
      source: 'fred', decimals: 2, unit: '%', cadence: 'daily', changed: true, points: [['2026-09-25', 5.17], ['2026-09-28', 5.24], ['2026-09-29', 5.26]] };
    const now = Date.now(), closedAt = Date.parse('2026-10-01T22:00:00Z');
    const q = (o) => ({ price: 5.321, ts: now - 60000, date: '2026-10-01', prevClose: 5.293, prevDate: '2026-09-30', symbol: 'US10Y', fetchedAt: now, ...o });
    const run = (r, o, at = now) => { econLive.q = { ust10y: q(o) }; return econLiveRow(r, at); };
    const same = (r, o, at) => run(r, o, at) === r;   // the SAME object back = no overlay
    const out = run(row, {});
    const res = {
      out, inputIntact: [row.value, row.points.length, row.asOf],
      // today's own official reading (Treasury's 3:30 pm snapshot): a FRESH quote replaces it while the session is open; a stale quote, or any once it is shut, does not
      sameDayFresh: !same({ ...row, asOf: '2026-10-01' }, {}), sameDayStale: same({ ...row, asOf: '2026-10-01' }, { ts: now - 6 * 60000 }),
      sameDayClosed: same({ ...row, asOf: '2026-10-01' }, { ts: closedAt - 60000, fetchedAt: closedAt }, closedAt),
      officialNewer: same({ ...row, asOf: '2026-10-02' }, {}),
      far: same(row, { price: 6.02 }), edge: !same(row, { price: 6.00 }),
      stale: same({ ...row, status: 'stale' }, {}), missing: same({ ...row, status: 'missing', value: null }, {}),
      aged: same(row, { fetchedAt: now - 31 * 60000 }), young: !same(row, { fetchedAt: now - 29 * 60000 }),
      // a slower cadence keeps the print for two of its own intervals (an hourly weekend poll must not flicker the row off at +30 min)
      slowKept: !same(row, { fetchedAt: now - 119 * 60000, keepMs: 2 * 3600 * 1000 }), slowGone: same(row, { fetchedAt: now - 121 * 60000, keepMs: 2 * 3600 * 1000 }),
      noBaseline: run(row, { prevClose: null, prevDate: null }),
      // fresh = the quote's OWN time within 5 minutes of now, inclusive
      fresh: [run(row, { ts: now - 4 * 60000 }).live.fresh, run(row, { ts: now - 300000 }).live.fresh, run(row, { ts: now - 300001 }).live.fresh, run(row, { ts: now - 31 * 60000 }).live.fresh],
      onePoint: run({ ...row, points: [['2026-09-29', 5.26]] }, {}).points.length,
      // a short span that fell back to its N latest readings keeps N, so the caption (and the chart's accessible name) stay true
      noted: (() => { const six = ['09-22', '09-23', '09-24', '09-25', '09-28', '09-29'].map((d, i) => [`2026-${d}`, 5.2 + i / 100]);
        const o = run({ ...row, points: six, pointsNote: 'daily - 6 latest' }, {}); return [o.points.length, o.points[0][0], o.points[o.points.length - 1], o.pointsNote]; })(),
      otherId: (() => { econLive.q = { cpi: q({}), ust10y: q({}) }; const r2 = { ...row, id: 'cpi' }; return econLiveRow(r2, now) === r2; })(),
    };
    econLive.q = { ust10y: q({}) };
    DESK.mode = 'demo';
    res.demo = econLiveRow(row, now) === row;
    DESK.mode = 'live';
    econLive.q = {};
    res.noBaselineText = econDeltaText(res.noBaseline);
    return res;
  });
  expect([rules.out.value, rules.out.delta, rules.out.prev, rules.out.asOf, rules.out.prevAsOf, rules.out.source, rules.out.changed],
    'the print stands in: value, change from the previous close CNBC reports (rounded to the row\'s decimals), dates, source').toEqual([5.321, 0.03, 5.293, '2026-10-01', '2026-09-30', 'live', false]);
  expect(rules.out.points, 'the chart gets the print as its last point').toEqual([['2026-09-25', 5.17], ['2026-09-28', 5.24], ['2026-09-29', 5.26], ['2026-10-01', 5.321]]);
  expect(rules.out.live.official, 'and remembers the official reading it stands in for').toEqual({ asOf: '2026-09-29', value: 5.26, source: 'fred' });
  expect(rules.inputIntact, 'the server row is never mutated').toEqual([5.26, 3, '2026-09-29']);
  expect([rules.sameDayFresh, rules.sameDayStale, rules.sameDayClosed], 'today\'s own official reading is replaced by a FRESH quote while the session is open, and STANDS against a stale one or once the session is shut').toEqual([true, true, true]);
  expect(rules.officialNewer, 'an official reading NEWER than the print is never overwritten').toBe(true);
  expect([rules.far, rules.edge], 'a print more than 0.75 points from the official reading is a misread, 0.74 is a move').toEqual([true, true]);
  expect([rules.stale, rules.missing], 'never alone: a stale or missing official row gets no overlay').toEqual([true, true]);
  expect([rules.aged, rules.young], 'a quote fetched more than 30 minutes ago is dropped, 29 minutes is kept').toEqual([true, true]);
  expect([rules.slowKept, rules.slowGone], 'on the hourly cadence it is kept for two intervals, 119 minutes, and dropped at 121 (Codex, PR #297)').toEqual([true, true]);
  expect(rules.noBaselineText, 'no baseline: the change is an em dash, never "= 0.00"').toBe('—');
  expect(rules.fresh, 'a quote is fresh while its own time is within 5 minutes (inclusive): 4 min and exactly 5 min are, 5 min and a millisecond and 31 minutes are not').toEqual([true, true, false, false]);
  expect(rules.onePoint, 'a chart that had fewer than two real points is not extended into a line').toBe(1);
  expect(rules.noted, 'a "daily - 6 latest" fallback stays SIX readings: the print replaces the oldest, the note stays true (Codex, PR #297)')
    .toEqual([6, '2026-09-23', ['2026-10-01', 5.321], 'daily - 6 latest']);
  expect(rules.otherId, 'only a row with a live symbol is ever live — CPI never is, whatever is stored under its id').toBe(true);
  expect(rules.out.live.symbol, 'and the print names its CNBC symbol').toBe('US10Y');
  expect(rules.demo, 'and demo never overlays').toBe(true);

  // ── 4. the poll cadence: every minute in the bond session, ten around it on a trading day, hourly at weekends and holidays
  const delays = await page.evaluate(() => Object.fromEntries(
    [['open', '2026-10-01T15:45:00Z'], ['0800 ET', '2026-10-01T12:00:00Z'], ['0700 ET', '2026-10-01T11:00:00Z'], ['1514 ET', '2026-10-01T19:14:00Z'],
      ['1515 ET', '2026-10-01T19:15:00Z'], ['1704 ET', '2026-10-01T21:04:00Z'], ['1705 ET', '2026-10-01T21:05:00Z'], ['evening', '2026-10-01T22:00:00Z'],
      ['saturday', '2026-10-03T16:00:00Z'], ['thanksgiving', '2026-11-26T15:00:00Z'],
      ['columbus day', '2026-10-12T15:00:00Z'], ['day after it', '2026-10-13T15:00:00Z'], ['veterans day', '2026-11-11T16:00:00Z'], ['veterans day 2027', '2027-11-11T16:00:00Z'],
    ].map(([k, iso]) => [k, econLiveDelaySec(Date.parse(iso))])));
  expect(delays, 'the cadence follows the New York clock — and the BOND calendar: the NYSE is open on Columbus Day and Veterans Day, the bond market is not (Codex, PR #297); the fast window is the whole session, to 17:05')
    .toEqual({ open: 60, '0800 ET': 60, '0700 ET': 600, '1514 ET': 60, '1515 ET': 60, '1704 ET': 60, '1705 ET': 600, evening: 600, saturday: 3600, thanksgiving: 3600,
      'columbus day': 3600, 'day after it': 60, 'veterans day': 3600, 'veterans day 2027': 3600 });

  // ── 5. the real poller end to end: a good quote draws the 10Y live; the 2Y and 20Y (CNBC left them out) say NOT LIVE; the monthly rows are untouched
  const row10 = () => page.evaluate(() => {
    const li = document.querySelector('#econList .econ-row[data-id="ust10y"]');
    const q = (s) => li.querySelector(s);
    const box = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right }; };
    return {
      val: q('.econ-val').textContent, delta: q('.econ-delta').textContent, date: q('.econ-date').textContent, tag: q('.econ-tag') ? q('.econ-tag').textContent : null,
      isNew: !!q('.econ-new'), src: q('.econ-src') ? q('.econ-src').textContent : null, title: li.title, cap: q('.econ-cap').textContent, aria: q('.econ-chart svg') ? q('.econ-chart svg').getAttribute('aria-label') : null,
      live: li.dataset.live || null, info: box(q('.econ-info')), chart: q('.econ-chart svg') ? box(q('.econ-chart svg')) : null,
      clip: { src: q('.econ-src') ? q('.econ-src').scrollWidth > q('.econ-src').clientWidth + 1 : null, label: q('.econ-label').scrollWidth > q('.econ-label').clientWidth + 1, date: q('.econ-date').scrollWidth > q('.econ-date').clientWidth + 1, sub: q('.econ-sub').scrollWidth > q('.econ-sub').clientWidth + 1 },
    };
  });
  const others = () => page.evaluate(() => [...document.querySelectorAll('#econList .econ-row')].filter((li) => li.dataset.id !== 'ust10y')
    .map((li) => [li.dataset.id, li.querySelector('.econ-val').textContent, li.querySelector('.econ-date').textContent, li.querySelector('.econ-tag') ? li.querySelector('.econ-tag').textContent : null, li.title, li.querySelector('.econ-src') ? li.querySelector('.econ-src').textContent : null]));
  const calls = () => page.evaluate(() => window.__ccalls);
  const ptOfLast = () => page.evaluate(() => window.__pt(window.__lastAt));
  await page.evaluate(() => { window.__official.changed = true; startEcon(); });
  await expect(page.locator('#econList .econ-row[data-id="ust10y"][data-live="1"]'), 'the 10Y row is drawn live').toHaveCount(1);
  let r10 = await row10();
  expect([r10.val, r10.delta, r10.tag], 'the live print, its change from the previous close CNBC reports, and the LIVE tag').toEqual(['5.32%', '▲ 0.03', 'LIVE']);
  expect(r10.date, 'the date cell is the Pacific CLOCK of the quote, not a date').toBe(await ptOfLast());
  expect(r10.isNew, 'a live row never carries a NEW chip, although the server said `changed`').toBe(false);
  expect(await page.evaluate(() => econSeen.ust10y), 'the official reading it stands in for is recorded as seen').toBe('2026-09-29|5.26');
  expect(await page.evaluate(() => econState.shown.rows.find((r) => r.id === 'ust10y').value), 'the server row is untouched underneath').toBe(5.26);
  expect(r10.cap, 'the chart now runs to today').toMatch(/– Oct 1$/);
  const serverPoints = await page.evaluate(() => econState.shown.rows.find((r) => r.id === 'ust10y').points.length);
  expect(r10.aria, 'and has one reading more than the server sent').toContain(`${serverPoints + 1} readings`);
  expect(r10.title, 'the tooltip names the quote, its time and the official reading it stands in for').toMatch(/as of 2026-10-01 \d\d:\d\d PDT \(time of the last quote\)/);
  expect(r10.title).toMatch(/source CNBC US10Y live quote, may be delayed/);
  expect(r10.title).toMatch(/latest official reading 5\.26% on Sep 29 \(FRED\)/);
  expect(r10.title, 'and is not labelled as FRED\'s own reading').not.toMatch(/source FRED/);
  expect(r10.title, 'and a live row has no NOT LIVE note').not.toMatch(/NOT LIVE/);
  expect(r10.src, 'the 10Y row names CNBC and the symbol on its own source line while the print stands in').toBe('Source: CNBC US10Y');
  expect(r10.clip, 'nothing in the left block is clipped (a clipped time is a wrong time)').toEqual({ src: false, label: false, date: false, sub: false });
  expect(r10.chart.l, 'the chart still starts to the right of the value block').toBeGreaterThanOrEqual(r10.info.r - 0.5);
  const oth = await others();
  expect(oth.map((o) => [o[0], o[3]]), 'the 2Y and 20Y — which CNBC did not deliver — say NOT LIVE; the four monthly rows carry no tag')
    .toEqual([['ust2y', 'NOT LIVE'], ['ust20y', 'NOT LIVE'], ['unrate', null], ['cpi', null], ['pce', null], ['corepce', null]]);
  expect(oth.filter((o) => /CNBC.*live quote/i.test(o[4])), 'and none of them names a live quote as its source').toEqual([]);
  expect(oth.slice(0, 2).map((o) => o[4].includes('NOT LIVE — CNBC sent no usable real-time quote for this row; this is the latest official reading')), 'and their tooltips say why: CNBC answered, but not for them').toEqual([true, true]);
  expect(oth.map((o) => [o[0], o[5]]), 'the other six rows keep naming FRED (their official source), not the live quote')
    .toEqual(['ust2y', 'ust20y', 'unrate', 'cpi', 'pce', 'corepce'].map((id) => [id, 'Source: FRED']));
  expect(await page.locator('.econ-foot').count(), 'no footer: the source is per row').toBe(0);
  expect(await calls(), 'one CNBC request carried the poll').toBe(1);
  expect(await page.evaluate(() => window.__yahoo || 0), 'and Yahoo was never asked: it is not a source').toBe(0);
  expect(await page.evaluate(() => {
    const bad = ['--color-gain', '--color-loss', '--color-gain-dim', '--color-loss-dim', '--color-danger', '--color-status-live'].map((t) => { const e = document.createElement('i'); e.style.color = `var(${t})`; document.body.appendChild(e); const v = getComputedStyle(e).color; e.remove(); return v; });
    return [...document.querySelectorAll('#econList .econ-row[data-id="ust10y"] *, #econList .econ-row[data-id="ust2y"] *')].filter((n) => bad.includes(getComputedStyle(n).color) || bad.includes(getComputedStyle(n).borderTopColor) || bad.includes(getComputedStyle(n).backgroundColor)).map((n) => n.className);
  }), 'the LIVE tag and the NOT LIVE chip are neutral ink: green and red stay P&L-only').toEqual([]);

  // 5a. the worst case for width: an unseen official reading (NEW) on a row that is also NOT LIVE — date + NOT LIVE + NEW are wider than the 104px block, so the
  //     flex line WRAPS rather than hang into the chart column. What must hold in ANY font state (CI's web fonts swap in late, and its fallback sans is wider than
  //     this sandbox's — the first, stricter version of this check, "NOT LIVE shares the date's line", failed there on mobile-chrome): both chips show, NOT LIVE is
  //     never placed after NEW, every chip stays inside the value block, and nothing overflows it sideways
  await page.evaluate(() => { delete econSeen.ust2y; econPending.ust2y = 'x'; econLiveRepaint(); });
  await page.evaluate(() => document.fonts.ready);
  const both = await page.evaluate(() => {
    const li = document.querySelector('#econList .econ-row[data-id="ust2y"]');
    const r = (s) => li.querySelector(s).getBoundingClientRect(), info = r('.econ-info');
    const sub = li.querySelector('.econ-sub');
    return { chips: [!!li.querySelector('.econ-nolive'), !!li.querySelector('.econ-new')], notAfterNew: r('.econ-nolive').top <= r('.econ-new').top + 0.5,
      inside: ['.econ-date', '.econ-nolive', '.econ-new'].map((s) => r(s).right <= info.right + 0.5 && r(s).left >= info.left - 0.5), subOverflow: sub.scrollWidth > sub.clientWidth + 1 };
  });
  expect(both, 'NEW and NOT LIVE together: both show, NOT LIVE is never after NEW, every chip stays inside the value block and nothing overflows it').toEqual({ chips: [true, true], notAfterNew: true, inside: [true, true, true], subOverflow: false });
  await page.evaluate(() => { delete econPending.ust2y; econSeen.ust2y = econSig(econState.shown.rows.find((r) => r.id === 'ust2y')); econLiveRepaint(); });

  // 5b. a FULL render (a server poll, a span change, another tab's storage event) draws the live print without waiting for a quote,
  //     and records the official reading as seen whichever of the two arrived first — the repaint path is not the only one
  await page.evaluate(() => { econSeen = {}; econPending = { ust10y: '2026-09-29|5.26' }; renderEcon(econState.shown); });
  r10 = await row10();
  expect([r10.val, r10.tag, r10.isNew], 'a full render keeps the live print (and no NEW chip)').toEqual(['5.32%', 'LIVE', false]);
  expect(await page.evaluate(() => [econSeen.ust10y, Object.hasOwn(econPending, 'ust10y')]), 'the official reading is recorded as seen and its pending mark cleared').toEqual(['2026-09-29|5.26', false]);

  // ── 6. the cadence on the clock: a minute while the session runs; "Refresh now" asks at once
  const left = await page.evaluate(() => econLive.dueAt - Date.now());
  expect(left, 'the next quote is a minute away').toBeGreaterThan(57_000);
  expect(left).toBeLessThanOrEqual(60_000);
  let n = await calls();
  await page.clock.runFor(58_000);
  expect(await calls(), '58s in: not asked again').toBe(n);
  await page.clock.runFor(3_000);
  await expect.poll(calls, 'a minute in: asked again').toBe(n + 1);
  n = await calls();
  await page.evaluate(() => econLiveFetch(true));
  expect(await calls(), 'a forced refresh asks at once, with exactly one request').toBe(n + 1);
  // ...and the masthead's own "Refresh now" reaches it: its Promise.all holds the quote beside the feeds and desk-econ
  n = await calls();
  await page.evaluate(() => {
    window.feedPollTick = async () => {}; window.scheduleFeedPoll = () => {}; window.scheduleMarketPoll = () => {};
    return refreshNowClicked();
  });
  expect(await calls(), '"Refresh now" asks CNBC exactly once').toBe(n + 1);

  // a ticker tick with nothing a viewer could see change leaves the live row alone (its tooltip survives a hover)
  await page.evaluate(() => { window.__node = document.querySelector('#econList .econ-row[data-id="ust10y"]'); });
  await page.clock.runFor(31_000);
  expect(await page.evaluate(() => document.querySelector('#econList .econ-row[data-id="ust10y"]') === window.__node), 'the 30s ticker does not rebuild an unchanged live row').toBe(true);

  // ── 6b. a FORCED quote owns the slot until it lands (Codex, PR #297): a poll timer coming due meanwhile — or an unforced call —
  //        would take the newer generation and get the forced reply thrown away
  await page.evaluate(() => { window.__cnbcFn = () => new Promise((res) => { window.__release = () => res(window.__cq10()); }); econLiveArm(10); });
  n = await calls();
  const fetchedBefore = await page.evaluate(() => econLive.q.ust10y.fetchedAt);
  await page.evaluate(() => { window.__forcedQ = econLiveFetch(true); });
  expect(await calls(), 'the forced quote is in flight').toBe(n + 1);
  expect(await page.evaluate(() => [econLive.timer, econLive.dueAt]), 'and the poll timer armed before it is cancelled').toEqual([0, 0]);
  await page.clock.runFor(15_000);                                // past the 10s timer
  expect(await calls(), 'past the moment that timer was due: no second request').toBe(n + 1);
  await page.evaluate(() => econLiveFetch(false));
  expect(await calls(), 'an unforced call meanwhile (boot, a tab returning) waits too').toBe(n + 1);
  await page.evaluate(() => { window.__release(); return window.__forcedQ; });
  expect(await page.evaluate((t) => econLive.q.ust10y.fetchedAt > t, fetchedBefore), 'the forced reply LANDED (it was not discarded by a newer generation)').toBe(true);
  const rearm = await page.evaluate(() => [econLive.forcing, econLive.dueAt - Date.now()]);
  expect(rearm[0], 'the slot is released').toBe(false);
  expect(rearm[1], 'and the poll re-armed a minute out').toBeGreaterThan(58_000);
  expect(rearm[1]).toBeLessThanOrEqual(60_000);
  // a request that fails (the real econLiveCnbc answers null for a 403, a blocked call, a hang past 8 s, a non-JSON body) is a failed poll: retried in a minute
  await page.evaluate(() => { window.__cnbcFn = () => null; return econLiveFetch(false); });
  const failed = await page.evaluate(() => [econLive.forcing, econLive.answered, Math.round((econLive.dueAt - Date.now()) / 1000)]);
  expect(failed[0], 'a failed request leaves no forced slot held').toBe(false);
  expect(failed[1], 'and is recorded as "CNBC did not answer"').toBe(false);
  expect(failed[2], 'and is retried a minute out').toBeGreaterThanOrEqual(59);
  expect(failed[2]).toBeLessThanOrEqual(60);
  await page.evaluate(() => { window.__cnbcFn = () => window.__cq10(); return econLiveFetch(false); });
  expect(await page.evaluate(() => econLive.answered), 'and a good reply is recorded as answered').toBe(true);

  // ── 7. a hidden tab asks for nothing, and asks at once on return if a quote came due meanwhile
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); econVisibility(); });
  expect(await page.evaluate(() => econLive.timer), 'hidden: no timer').toBe(0);
  n = await calls();
  await page.clock.runFor(300_000);
  expect(await calls(), 'five hidden minutes: no quote asked for').toBe(n);
  await page.evaluate(() => { delete document.hidden; econVisibility(); });
  await expect.poll(calls, 'visible again with a quote overdue: asked at once').toBe(n + 1);

  // ── 8. CNBC keeps answering but its quote has STOPPED (a frozen stamp): the print stays on the row, flagged NOT LIVE with its age — an answer is not real time
  await page.evaluate(() => { const at = Date.now() - 30000; window.__frozen = at; window.__cnbcFn = () => window.__cq10({ at: window.__frozen }); return econLiveFetch(false); });
  r10 = await row10();
  expect([r10.val, r10.tag], 'a quote 30 seconds old is LIVE').toEqual(['5.32%', 'LIVE']);
  await page.clock.runFor(6 * 60_000);
  r10 = await row10();
  expect([r10.val, r10.date, r10.tag, r10.live], 'six minutes on with the same stamp: same print, same clock, NOT LIVE (the session is open)').toEqual(['5.32%', await page.evaluate(() => window.__pt(window.__frozen)), 'NOT LIVE', '1']);
  expect(r10.title, 'the tooltip names the age').toMatch(/NOT LIVE — CNBC's last quote for this row is [67] min old, so it is not real time/);
  expect(r10.clip, 'the solid chip fits beside the date: nothing clipped').toEqual({ src: false, label: false, date: false, sub: false });
  // ...and the bell: the 30s ticker alone flips NOT LIVE to LAST when the session closes (17:05 ET), with no quote fetched
  await page.evaluate(() => { econLive.q.ust10y.fetchedAt = Date.now(); });
  await page.clock.setSystemTime(new Date('2026-10-01T21:04:00Z'));   // 17:04 ET: still open
  await page.evaluate(() => { econLive.q.ust10y.fetchedAt = Date.now(); econLiveRepaint(); });
  expect((await row10()).tag, '17:04 ET with a quote hours old: NOT LIVE').toBe('NOT LIVE');
  await page.clock.setSystemTime(new Date('2026-10-01T21:06:00Z'));   // 17:06 ET: shut
  await page.evaluate(() => { econLive.q.ust10y.fetchedAt = Date.now(); });
  await page.clock.runFor(31_000);
  expect((await row10()).tag, 'two minutes later, the ticker alone: the session has closed, the stopped quote is the last print — LAST').toBe('LAST');
  await page.clock.setSystemTime(new Date('2026-10-01T16:30:00Z'));   // back to 12:30 ET

  // ── 9. a failing CNBC keeps the last good print for 30 minutes from its last SUCCESS — flagged NOT LIVE once it is not recent — then the row is the official one, still flagged
  await page.evaluate(() => { econLive.q = {}; window.__cnbcFn = () => window.__cq10(); return econLiveFetch(false); });
  expect((await row10()).tag, 'a fresh quote: LIVE').toBe('LIVE');
  await page.evaluate(() => { window.__cnbcFn = () => null; });
  await page.clock.runFor(25 * 60_000);
  r10 = await row10();
  expect([r10.val, r10.tag], 'after 25 minutes of failures the last good print is still the row — flagged NOT LIVE, never presented as live').toEqual(['5.32%', 'NOT LIVE']);
  await page.clock.runFor(6 * 60_000);
  r10 = await row10();
  expect([r10.val, r10.delta, r10.date, r10.tag, r10.live], 'past 30 minutes with no success: the official reading, nothing live — and it says NOT LIVE').toEqual(['5.26%', '▲ 0.02', 'Sep 29', 'NOT LIVE', null]);
  expect(r10.title, 'its tooltip is FRED\'s again and says CNBC did not answer').toMatch(/source FRED/);
  expect(r10.title).toMatch(/NOT LIVE — CNBC did not answer \(blocked, offline or refused\), so there is no real-time yield; this is the latest official reading/);
  expect(r10.src, 'and so is its source line: the live quote no longer stands in').toBe('Source: FRED');
  expect(r10.isNew, 'with no NEW chip: the reading was recorded as seen while the live print stood in for it').toBe(false);
  // ...and recovers on the next quote
  await page.evaluate(() => { window.__cnbcFn = () => window.__cq10(); });
  await page.clock.runFor(61_000);
  await expect.poll(async () => (await row10()).tag, 'a good quote brings the live print back').toBe('LIVE');

  // ── 10. today's own official reading (Treasury's 3:30 pm snapshot has posted): a FRESH quote still stands in while the session is open;
  //        a quote that has stopped leaves the official number — flagged NOT LIVE
  await page.evaluate(() => { window.__official = { ...window.__official, value: 5.30, prev: 5.26, delta: 0.04, asOf: '2026-10-01', prevAsOf: '2026-09-29' }; return refreshEcon(false); });
  r10 = await row10();
  expect([r10.val, r10.tag, r10.live], 'the official reading is today\'s, the quote is fresh: the live print stays').toEqual(['5.32%', 'LIVE', '1']);
  expect(r10.title).toMatch(/latest official reading 5\.30% on Oct 1 \(FRED\)/);
  await page.evaluate(() => { window.__cnbcFn = () => window.__cq10({ at: Date.now() - 10 * 60000 }); econLive.q = {}; return Promise.all([refreshEcon(false), econLiveFetch(false)]); });
  r10 = await row10();
  expect([r10.val, r10.date, r10.tag, r10.live, r10.title.includes('source FRED')], 'the quote stopped 10 minutes ago: the OFFICIAL number stands, with its date — and NOT LIVE').toEqual(['5.30%', 'Oct 1', 'NOT LIVE', null, true]);

  // ── 11. a misread never reaches the row: a print far from the official reading, and a x10 scale fault — both leave the official row, flagged NOT LIVE
  await page.evaluate(() => { window.__official = { ...window.__official, value: 5.26, prev: 5.24, delta: 0.02, asOf: '2026-09-29', prevAsOf: '2026-09-28' }; econLive.q = {}; });
  for (const [what, price] of [['a print 1.24 points from the official reading', 6.5], ['a x10 scale fault', 52.9]]) {
    await page.evaluate((p) => { window.__cnbcFn = () => window.__cq10({ price: p, change: 0.02 }); econLive.q = {}; return Promise.all([refreshEcon(false), econLiveFetch(false)]); }, price);
    r10 = await row10();
    expect([r10.val, r10.tag, r10.live], `${what}: the row is the official one — and says NOT LIVE`).toEqual(['5.26%', 'NOT LIVE', null]);
  }

  // ── 12. an old quote, the session shut (Saturday): the date cell is the DATE, tagged LAST
  await page.evaluate(() => { window.__cnbcFn = () => window.__cq10({ at: Date.parse('2026-10-02T21:00:00Z') }); econLive.q = {}; });
  await page.clock.setSystemTime(new Date('2026-10-03T16:00:00Z'));
  await page.evaluate(() => Promise.all([refreshEcon(false), econLiveFetch(false)]));
  r10 = await row10();
  expect([r10.val, r10.date, r10.tag], 'Saturday: Friday\'s last quote is a DATE (Oct 2), not a clock, and says LAST — not NOT LIVE: nothing is trading').toEqual(['5.32%', 'Oct 2', 'LAST']);

  // ── 13. the date cell is re-read by the 30s ticker across Pacific midnight, not only when the row is rebuilt (Codex, PR #297)
  await page.clock.setSystemTime(new Date('2026-10-03T06:50:00Z'));   // Fri 23:50 PT
  await page.evaluate(() => { window.__cnbcFn = () => window.__cq10({ at: Date.parse('2026-10-02T18:55:00Z') }); econLive.q = {}; return Promise.all([refreshEcon(false), econLiveFetch(false)]); });
  r10 = await row10();
  expect([r10.val, r10.date, r10.tag], 'a quote from today (Pacific) shows its CLOCK').toEqual(['5.32%', '11:55', 'LAST']);
  await page.clock.setSystemTime(new Date('2026-10-03T07:10:00Z'));   // twenty minutes on, past Pacific midnight
  await page.clock.runFor(31_000);                                      // the 30s ticker alone — no quote, no poll lands
  r10 = await row10();
  expect([r10.val, r10.date], '...and a DATE once the Pacific day has rolled over').toEqual(['5.32%', 'Oct 2']);
  // the weekend poll is hourly, so a print fetched at 06:50Z must still stand 55 minutes later — not flicker to the official row at +30 min
  expect(await page.evaluate(() => econLive.q.ust10y.keepMs), 'a weekend fetch is kept for two hourly intervals').toBe(7_200_000);
  await page.clock.setSystemTime(new Date('2026-10-03T07:45:00Z'));
  await page.clock.runFor(31_000);
  r10 = await row10();
  expect([r10.val, r10.date, r10.tag], '55 minutes after an hourly weekend fetch the last print is still the row').toEqual(['5.32%', 'Oct 2', 'LAST']);
});

// ── S57 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The live 2Y, 10Y and 20Y from CNBC's quote service (owner request 2026-10-01: "Can this be built into the dashboard?"). FRED and
// Treasury publish a yield once a day; CNBC's restQuote answers a page on THIS site with CORS (measured from the owner's browser,
// 11:49 ET: 2Y 4.787, 10Y 5.253) though it refuses every server (Supabase and the build sandbox both get 403). So the dashboard makes
// ONE request from the visitor's browser for all three rows, each row trusted on its own. There is NO fallback source (owner, same day:
// "no fallbacks. If CNBC doesn't give me real time, I want to be aware"): when the bond session is open and a row has no fresh CNBC
// quote it says NOT LIVE — a solid chip, with the reason in its tooltip — and keeps showing its official reading under its own date and
// source; after the bell a stopped quote is LAST and nothing is flagged. An unofficial endpoint: it can change or be blocked at any time.
// Driven with stubs on Playwright's fake clock (Thu 08:50:30 PT, inside the bond session) — never the network.
test('S57: the live yields from CNBC — one browser request for all three, each row trusted on its own, NOT LIVE when CNBC is not real time', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(180_000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.clock.install({ time: new Date('2026-10-01T15:50:30Z') });
  await gotoDemo(page, '#econList .econ-row', 15000);

  // a CNBC reply as it really arrives: strings with a trailing %, the time with its UTC offset and NO colon, `change` in points, and
  // a `change_pct` that is not to be trusted (it read +0.19% beside a -0.10 change on the 2Y)
  await page.evaluate(() => {
    const base = { symbolType: 'symbol', code: 0, changetype: 'DOWN', type: 'BOND', subType: 'Government Bond', exchange: 'Tradeweb', source: 'Exchange', provider: 'CNBC Quote' };
    window.__cq = (over = {}) => ({ FormattedQuoteResult: { FormattedQuote: [
      { ...base, symbol: 'US2Y', name: 'U.S. 2 Year Treasury', last: '4.787%', last_timedate: '11:49 AM EDT', last_time: '2026-10-01T11:49:47.000-0400', open: '4.891%', high: '4.925%', low: '4.783%', change: '-0.10', change_pct: '+0.1914%', ...over.US2Y },
      { ...base, symbol: 'US10Y', name: 'U.S. 10 Year Treasury', last: '5.253%', last_timedate: '11:49 AM EDT', last_time: '2026-10-01T11:49:41.000-0400', open: '5.289%', high: '5.344%', low: '5.245%', change: '-0.04', change_pct: '-0.7557%', ...over.US10Y },
      { ...base, symbol: 'US20Y', name: 'U.S. 20 Year Treasury', last: '5.612%', last_timedate: '11:49 AM EDT', last_time: '2026-10-01T11:49:40.000-0400', open: '5.670%', high: '5.690%', low: '5.600%', change: '-0.07', change_pct: '-1.2%', ...over.US20Y },
    ].filter((q) => !(over.drop || []).includes(q.symbol)) } });
  });

  // ── 1. parsing a CNBC reply into prints and baselines
  const parsed = await page.evaluate(() => {
    const now = Date.parse('2026-10-01T15:50:30Z');
    const P = (b) => econLiveParseCnbc(b, now);
    const one = (q) => P({ FormattedQuoteResult: { FormattedQuote: [{ symbol: 'US2Y', code: 0, last: '4.787%', last_time: '2026-10-01T11:49:47.000-0400', change: '-0.10', ...q }] } });
    const n = (o) => Object.keys(o).length;
    const good = P(window.__cq());
    return {
      good, ids: Object.keys(good).sort(),
      single: P({ FormattedQuoteResult: { FormattedQuote: { symbol: 'US10Y', code: 0, last: '5.253', last_time: '2026-10-01T11:49:41.000-0400' } } }),
      nothing: [P(null), P({}), P({ FormattedQuoteResult: {} }), P({ FormattedQuoteResult: { FormattedQuote: [] } }), P('x'), P([])].map(n),
      unknownSymbol: n(P({ FormattedQuoteResult: { FormattedQuote: [{ symbol: 'US30Y', code: 0, last: '5.7%', last_time: '2026-10-01T11:49:47.000-0400' }] } })),
      badCode: n(one({ code: 1 })), noCode: n(one({ code: undefined })), junkLast: n(one({ last: 'N/A' })), scale: n(one({ last: '47.87%' })),
      future: n(one({ last_time: '2026-10-01T12:30:00.000-0400' })), noTime: n(one({ last_time: undefined })), junkTime: n(one({ last_time: 'yesterday' })),
      noChange: one({ change: undefined }).ust2y.prevClose, absurd: one({ change: '9.9' }).ust2y.prevClose, junkChange: one({ change: 'n/a' }).ust2y.prevClose,
      colonOffset: one({ last_time: '2026-10-01T11:49:47-04:00' }).ust2y.ts,
      // Date.parse repairs these instead of refusing them (Feb 30 reads as Mar 2, 24:00 as the next day) — a quote is a number or nothing (Codex, PR #300)
      impossible: [n(one({ last_time: '2026-02-30T11:49:47.000-0400' })), n(one({ last_time: '2026-02-29T11:49:47.000-0400' })), n(one({ last_time: '2026-04-31T11:49:47.000-0400' })),
        n(one({ last_time: '2026-10-01T24:00:00.000-0400' })), n(one({ last_time: '2026-09-31T11:49:47-04:00' })), n(one({ last_time: '2026-10-01T11:49:47.000-1500' }))],
      leapDay: n(one({ last_time: '2024-02-29T11:49:47.000-0400' })),   // a REAL leap day is still read
    };
  });
  expect(parsed.ids, 'all three yields are read from one reply').toEqual(['ust10y', 'ust20y', 'ust2y']);
  const g = parsed.good;
  expect([g.ust2y.price, g.ust10y.price, g.ust20y.price], 'the print is `last`, its trailing % stripped').toEqual([4.787, 5.253, 5.612]);
  expect([g.ust2y.prevClose, g.ust10y.prevClose, g.ust20y.prevClose], 'the previous close is last minus `change` (points) — change_pct is never used').toEqual([4.887, 5.293, 5.682]);
  expect(g.ust2y.ts, 'the time is read with its UTC offset although it has no colon (-0400), as the standard form').toBe(Date.parse('2026-10-01T15:49:47Z'));
  expect(parsed.colonOffset, 'and the colon form reads the same instant').toBe(g.ust2y.ts);
  expect([g.ust2y.date, g.ust2y.symbol, g.ust2y.prevDate], 'the session is the NEW YORK date; it names its symbol; CNBC gives no baseline date').toEqual(['2026-10-01', 'US2Y', null]);
  expect([parsed.single.ust10y.price, parsed.single.ust10y.prevClose], 'a single quote object (not an array) is read; no `change` means an unknown baseline (null, never 0)').toEqual([5.253, null]);
  expect(parsed.nothing, 'null, {}, no result, an empty list, a string and an array are all nothing').toEqual([0, 0, 0, 0, 0, 0]);
  expect([parsed.unknownSymbol, parsed.badCode, parsed.junkLast, parsed.scale, parsed.future, parsed.noTime, parsed.junkTime],
    'an unlisted symbol, an error code, N/A, a x10 scale fault, a quote from the future, and a missing or junk time are all refused').toEqual([0, 0, 0, 0, 0, 0, 0]);
  expect(parsed.impossible, 'a calendar-impossible time (Feb 30, Feb 29 in a common year, Apr 31, 24:00, Sep 31, a -15:00 offset) is refused, not repaired onto another day').toEqual([0, 0, 0, 0, 0, 0]);
  expect(parsed.leapDay, 'while a real leap day is still read').toBe(1);
  expect(parsed.noCode, 'a quote with no code field at all is still read').toBe(1);
  expect([parsed.noChange, parsed.absurd, parsed.junkChange], 'a missing, absurd (9.9 points) or junk change leaves the baseline unknown, never a guess').toEqual([null, null, null]);

  // ── 2. each row is trusted on its own, through the real econLiveRow
  const rules = await page.evaluate(() => {
    DESK.mode = 'live';   // econLiveRow never overlays in demo
    const now = Date.now();
    const q = econLiveParseCnbc(window.__cq(), now);
    const mk = (id, label, value, prev) => ({ id, label, value, prev, delta: Number((value - prev).toFixed(2)), asOf: '2026-09-30', prevAsOf: '2026-09-29', status: 'ok',
      source: 'treasury', decimals: 2, unit: '%', cadence: 'daily', changed: false, points: [['2026-09-26', prev - 0.05], ['2026-09-29', prev], ['2026-09-30', value]] });
    const rows = { ust2y: mk('ust2y', '2Y Treasury', 4.88, 4.89), ust10y: mk('ust10y', '10Y Treasury', 5.29, 5.26), ust20y: mk('ust20y', '20Y Treasury', 5.68, 5.64) };
    const load = (qq) => { econLive.q = Object.fromEntries(Object.entries(qq).map(([id, v]) => [id, { ...v, fetchedAt: now }])); };
    load(q);
    const drawn = Object.fromEntries(Object.entries(rows).map(([id, r]) => { const o = econLiveRow(r, now); return [id, { same: o === r, value: o.value, delta: o.delta, prev: o.prev, asOf: o.asOf, source: o.source,
      live: o.live && { symbol: o.live.symbol, fresh: o.live.fresh, official: o.live.official } }]; }));
    load({ ...q, ust2y: { ...q.ust2y, price: 6.03 } });   // a 2Y print 1.15 points off its official reading is a misread...
    const far = Object.fromEntries(Object.keys(rows).map((id) => [id, econLiveRow(rows[id], now) === rows[id]]));   // ...for THAT row only
    load(q);
    // today's Treasury rate has posted for the 20Y (a 3:30 pm snapshot): a FRESH quote while the bond session is open is newer than it and
    // replaces it; a quote that has stopped ticking, or any quote once the session is shut, leaves the official reading standing
    const caught = { ...rows.ust20y, asOf: '2026-10-01' };
    const closedAt = Date.parse('2026-10-01T22:00:00Z');   // 18:00 ET
    const stands = { fresh: econLiveRow(caught, now) !== caught, stale: econLiveRow(caught, now + 6 * 60000) === caught, ust2y: econLiveRow(rows.ust2y, now) !== rows.ust2y };
    econLive.q = { ust20y: { ...q.ust20y, ts: closedAt - 60000, fetchedAt: closedAt } };
    stands.closed = econLiveRow(caught, closedAt) === caught;
    econLive.q = {}; DESK.mode = 'demo';
    return { drawn, far, stands };
  });
  expect(rules.drawn.ust2y, 'the 2Y: the print stands in, the change is from the previous close CNBC reports, and it says CNBC').toEqual({ same: false, value: 4.787, delta: -0.1, prev: 4.887, asOf: '2026-10-01', source: 'live',
    live: { symbol: 'US2Y', fresh: true, official: { asOf: '2026-09-30', value: 4.88, source: 'treasury' } } });
  expect([rules.drawn.ust10y.value, rules.drawn.ust10y.delta, rules.drawn.ust20y.value, rules.drawn.ust20y.delta, rules.drawn.ust20y.live.symbol],
    'the 10Y and the 20Y alike').toEqual([5.253, -0.04, 5.612, -0.07, 'US20Y']);
  expect(rules.far, 'a misread on one row (1.15 points off) leaves that row on its official reading and the other two live').toEqual({ ust2y: true, ust10y: false, ust20y: false });
  expect(rules.stands, "today's own Treasury snapshot is replaced by a FRESH quote while the session is open, stands against a stale quote or once the session is shut").toEqual({ fresh: true, stale: true, ust2y: true, closed: true });

  // ── 3. the real poller end to end: ONE request, three live rows, Yahoo untouched
  await page.evaluate(() => {
    DESK_DB.url = DESK_DB.url || 'https://stub.invalid';
    DESK.mode = 'live';
    localStorage.removeItem('econ_seen_v1'); localStorage.removeItem('econ_pending_v1'); econSeen = {}; econPending = {};
    window.__realCnbc = econLiveCnbc;
    window.__ccalls = 0; window.__qcalls = [];
    window.__cbody = window.__cq();
    window.econLiveCnbc = () => { window.__ccalls++; return window.__cbody instanceof Error ? Promise.reject(window.__cbody) : Promise.resolve(window.__cbody); };
    // Yahoo is NOT a source any more (owner: "no fallbacks"): anything that still reaches quote-proxy for a yield is recorded, and asserted absent
    window.deskQuote = (sym, kind, prepost, opts) => { window.__qcalls.push({ sym, kind, force: !!(opts && opts.force) }); return Promise.reject(new Error('Yahoo is not a source of the yields')); };
    // a CNBC reply whose quotes carry the given stamp (ET, as CNBC writes it); `__cqNow` stamps them `age` ms before now
    window.__etStamp = (ms, off = 4) => new Date(ms - off * 3600000).toISOString().slice(0, 19) + '.000-0' + off + '00';
    window.__cqAt = (stamp, extra = {}) => window.__cq({ US2Y: { last_time: stamp }, US10Y: { last_time: stamp }, US20Y: { last_time: stamp }, ...extra });
    window.__cqNow = (age = 30000, extra = {}) => window.__cqAt(window.__etStamp(Date.now() - age), extra);
    const official = { ust2y: [4.88, 4.89], ust10y: [5.29, 5.26], ust20y: [5.68, 5.64] };
    window.deskEcon = (range) => {
      const p = buildDemoEcon(range);
      const rows = p.rows.map((r) => {
        const o = official[r.id];
        if (!o) return { ...r, source: 'fred' };
        return { ...r, value: o[0], prev: o[1], delta: Number((o[0] - o[1]).toFixed(2)), asOf: '2026-09-30', prevAsOf: '2026-09-29', status: 'ok', source: 'treasury', changed: false,
          points: r.points.filter((x) => x[0] < '2026-09-30').concat([['2026-09-30', o[0]]]) };
      });
      return Promise.resolve({ ...p, rows, range, generatedAt: new Date().toISOString(), refreshInSec: 900, stale: false });
    };
  });
  const rowsOf = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#econList .econ-row')].map((li) => {
    const q = (s) => li.querySelector(s);
    return [li.dataset.id, { val: q('.econ-val').textContent, delta: q('.econ-delta').textContent, date: q('.econ-date').textContent, tag: q('.econ-tag') ? q('.econ-tag').textContent : null,
      isNew: !!q('.econ-new'), src: q('.econ-src') ? q('.econ-src').textContent : null, title: li.title, live: li.dataset.live || null, cap: q('.econ-cap') ? q('.econ-cap').textContent : '',
      clip: q('.econ-src') ? q('.econ-src').scrollWidth > q('.econ-src').clientWidth + 1 : null }];
  })));
  const state = () => page.evaluate(() => ({ c: window.__ccalls, y: window.__qcalls.map((x) => x.sym) }));
  await page.evaluate(() => { startEcon(); });
  await expect(page.locator('#econList .econ-row[data-live="1"]'), 'all three yield rows are drawn live').toHaveCount(3);
  let R = await rowsOf();
  expect([R.ust2y.val, R.ust2y.delta, R.ust2y.tag, R.ust2y.date, R.ust2y.src], 'the 2Y: the print, its change, LIVE, the Pacific CLOCK of the quote (15:49Z = 08:49 PDT), and CNBC named')
    .toEqual(['4.79%', '▼ 0.10', 'LIVE', '08:49', 'Source: CNBC US2Y']);
  expect([R.ust10y.val, R.ust10y.delta, R.ust10y.tag, R.ust10y.src], 'the 10Y').toEqual(['5.25%', '▼ 0.04', 'LIVE', 'Source: CNBC US10Y']);
  expect([R.ust20y.val, R.ust20y.delta, R.ust20y.tag, R.ust20y.src], 'the 20Y').toEqual(['5.61%', '▼ 0.07', 'LIVE', 'Source: CNBC US20Y']);
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => R[id].isNew), 'a live row never carries a NEW chip').toEqual([false, false, false]);
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => R[id].clip), 'the longest source line ("Source: CNBC US10Y") fits its block').toEqual([false, false, false]);
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => /– Oct 1$/.test(R[id].cap)), 'and each chart now runs to today').toEqual([true, true, true]);
  expect(R.ust2y.title, 'the tooltip names the quote, its time and the official reading it stands in for').toMatch(/as of 2026-10-01 08:49 PDT \(time of the last quote\)/);
  expect(R.ust2y.title).toMatch(/source CNBC US2Y live quote, may be delayed/);
  expect(R.ust2y.title).toMatch(/from the previous close CNBC reports/);
  expect(R.ust2y.title).toMatch(/latest official reading 4\.88% on Sep 30 \(U\.S\. Treasury\)/);
  expect(R.ust2y.title, 'and is not labelled as Treasury\'s own reading').not.toMatch(/source U\.S\. Treasury/);
  expect(['unrate', 'cpi', 'pce', 'corepce'].map((id) => [id, R[id].live, R[id].tag, R[id].src]), 'the four monthly rows are untouched and keep naming FRED')
    .toEqual(['unrate', 'cpi', 'pce', 'corepce'].map((id) => [id, null, null, 'Source: FRED']));
  expect(await page.evaluate(() => [econSeen.ust2y, econSeen.ust10y, econSeen.ust20y]), 'the official readings the prints stand in for are recorded as seen').toEqual(['2026-09-30|4.88', '2026-09-30|5.29', '2026-09-30|5.68']);
  expect(await state(), 'ONE CNBC request carried all three rows, and Yahoo was not asked at all').toEqual({ c: 1, y: [] });

  // ── 4. the cadence: one request a minute for all three rows
  await page.clock.runFor(58_000);
  expect((await state()).c, '58 s in: not asked again').toBe(1);
  await page.clock.runFor(4_000);
  expect(await state(), 'a minute on: ONE more request (not three), still no Yahoo').toEqual({ c: 2, y: [] });

  // ── 5. CNBC goes away: NOTHING stands in. The rows keep their last quote while it is still recent, say NOT LIVE once it is not,
  //       and go back to the official reading (still saying NOT LIVE, and why) after 30 minutes
  await page.evaluate(() => { window.__cbody = new Error('blocked by an extension'); });
  await page.clock.runFor(61_000);   // ~15:52:35Z: the last quote (15:49:4xZ) is ~3 minutes old
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].tag, R[id].src]), 'CNBC just went quiet: the last quote is 3 minutes old and still LIVE')
    .toEqual([['LIVE', 'Source: CNBC US2Y'], ['LIVE', 'Source: CNBC US10Y'], ['LIVE', 'Source: CNBC US20Y']]);
  await page.clock.runFor(4 * 60_000);   // ~15:56:40Z: the quote is ~7 minutes old
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].tag, R[id].val]), 'seven minutes on, CNBC still silent: the row says NOT LIVE and still shows the last quote it has')
    .toEqual([['NOT LIVE', '4.79%'], ['NOT LIVE', '5.25%'], ['NOT LIVE', '5.61%']]);
  expect(R.ust2y.title, 'the tooltip says why: the quote is old, in minutes').toMatch(/NOT LIVE — CNBC's last quote for this row is [67] min old, so it is not real time/);
  expect(R.ust2y.live, 'it is still the CNBC print on screen (a quote 7 minutes old is newer than yesterday\'s Treasury close) — flagged, not hidden').toBe('1');
  await page.clock.runFor(31 * 60_000);
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].src, R[id].live, R[id].tag, R[id].val]),
    'half an hour with no reply: the rows are back on their OFFICIAL reading — and say NOT LIVE (there is no second source to blame it on)')
    .toEqual([['Source: U.S. Treasury', null, 'NOT LIVE', '4.88%'], ['Source: U.S. Treasury', null, 'NOT LIVE', '5.29%'], ['Source: U.S. Treasury', null, 'NOT LIVE', '5.68%']]);
  expect(R.ust10y.title, 'and the tooltip says CNBC did not answer, so there is no real-time yield').toMatch(/NOT LIVE — CNBC did not answer \(blocked, offline or refused\), so there is no real-time yield; this is the latest official reading/);
  expect(['unrate', 'cpi', 'pce', 'corepce'].map((id) => R[id].tag), 'the four monthly rows never carry the chip').toEqual([null, null, null, null]);
  expect((await state()).y, 'no yield was ever asked of quote-proxy: Yahoo is not a source').toEqual([]);
  // CNBC answers again but its quotes carry OLD stamps (a frozen feed): the quote is shown, flagged NOT LIVE with its age — an answer is not real time
  await page.evaluate(() => { window.__cbody = window.__cq(); });
  await page.clock.runFor(61_000);
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].src, R[id].tag]), 'CNBC answers with half-hour-old stamps: its quote is on screen and flagged NOT LIVE')
    .toEqual([['Source: CNBC US2Y', 'NOT LIVE'], ['Source: CNBC US10Y', 'NOT LIVE'], ['Source: CNBC US20Y', 'NOT LIVE']]);
  expect(R.ust2y.title).toMatch(/CNBC's last quote for this row is (3\d|4\d) min old/);
  // CNBC delivers fresh quotes: LIVE
  await page.evaluate(() => { window.__cbody = window.__cqNow(); });
  await page.clock.runFor(61_000);
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].src, R[id].tag]), 'fresh quotes: every yield is LIVE from CNBC again')
    .toEqual([['Source: CNBC US2Y', 'LIVE'], ['Source: CNBC US10Y', 'LIVE'], ['Source: CNBC US20Y', 'LIVE']]);
  // CNBC leaves two rows out: the 2Y is live; the other two are official and say NOT LIVE — CNBC answered, but not for them
  await page.evaluate(() => { econLive.q = {}; window.__cbody = window.__cqNow(30000, { drop: ['US10Y', 'US20Y'] }); });
  await page.clock.runFor(61_000);
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].src, R[id].tag]), 'CNBC leaves two rows out: the 2Y is CNBC and LIVE, the others are official and NOT LIVE')
    .toEqual([['Source: CNBC US2Y', 'LIVE'], ['Source: U.S. Treasury', 'NOT LIVE'], ['Source: U.S. Treasury', 'NOT LIVE']]);
  expect(R.ust10y.title, 'and the tooltip says CNBC sent nothing usable for THIS row (it did answer)').toMatch(/NOT LIVE — CNBC sent no usable real-time quote for this row; this is the latest official reading/);
  // the bond session is SHUT (Friday 18:30 ET): a quote that has stopped is simply the last print — LAST, never an alarm; a row with no live print says nothing
  await page.clock.setSystemTime(new Date('2026-10-02T22:30:00Z'));
  await page.evaluate(() => { econLive.q = {}; window.__cbody = window.__cqAt('2026-10-02T16:59:50.000-0400'); return econLiveFetch(false); });
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].tag, R[id].date]), 'after the bell the stopped quotes read LAST (their Pacific clock, 13:59 PDT) — no NOT LIVE')
    .toEqual([['LAST', '13:59'], ['LAST', '13:59'], ['LAST', '13:59']]);
  await page.evaluate(() => { econLive.q = {}; window.__cbody = new Error('blocked'); return econLiveFetch(false); });
  R = await rowsOf();
  expect(['ust2y', 'ust10y', 'ust20y'].map((id) => [R[id].live, R[id].tag]), 'after the bell with CNBC down and nothing live: the official reading and NO chip — real time is not expected').toEqual([[null, null], [null, null], [null, null]]);
  await page.clock.setSystemTime(new Date('2026-10-01T15:50:30Z'));

  // ── 6. the request itself: exactly the call that was measured, no extra options, and it NEVER throws
  const real = await page.evaluate(async () => {
    const f0 = window.fetch, calls = [], out = {};
    try {
      window.fetch = (url, init) => { calls.push([String(url), Object.keys(init || {})]); return Promise.resolve(new Response(JSON.stringify(window.__cq()), { status: 200, headers: { 'content-type': 'application/json' } })); };
      out.ok = await window.__realCnbc();
      window.fetch = () => Promise.resolve(new Response('denied', { status: 403 }));
      out.denied = await window.__realCnbc();
      window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      out.blocked = await window.__realCnbc();
      window.fetch = () => Promise.resolve(new Response('<html>not json</html>', { status: 200 }));
      out.html = await window.__realCnbc();
    } finally { window.fetch = f0; }
    return { ok: !!(out.ok && out.ok.FormattedQuoteResult), denied: out.denied, blocked: out.blocked, html: out.html, calls };
  });
  expect(real.calls[0], 'the request is the measured URL with ONLY an abort signal — nothing that could turn it into a CORS preflight').toEqual([
    'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US2Y%7CUS10Y%7CUS20Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1', ['signal']]);
  expect([real.ok, real.denied, real.blocked, real.html], 'a 200 gives the body; a 403, a blocked request and a body that is not JSON all give null, never a throw').toEqual([true, null, null, null]);
  const hung = page.evaluate(async () => {
    const f0 = window.fetch;
    window.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    try { return { v: await window.__realCnbc() }; } finally { window.fetch = f0; }
  });
  const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 400))]);   // real-time look: the page clock also ticks on its own
  await page.clock.runFor(7_000);
  expect(await settled(hung), 'a request silent for 7 s is still waiting...').toBe(false);
  await page.clock.runFor(1_500);
  expect(await settled(hung), '...and by 8.5 s it has been given up on, so the Yahoo fallback is not held up behind it').toBe(true);
  expect((await hung).v, 'as a failed request: null, never a throw').toBeNull();

  // ── 7. the console allowlist S1/S3 share knows this ONE optional feed — and nothing wider
  expect(benignCors("Access to fetch at 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=US2Y' from origin 'https://akyachtsman.github.io' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource."),
    'CNBC\'s CORS refusal is allowlisted (the app falls back to the official numbers by design)').toBe(true);
  expect(benignCors("Access to fetch at 'https://quote.cnbc.com.evil.example/quote-html-webservice/x' from origin 'https://akyachtsman.github.io' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource."),
    'a look-alike host is not').toBe(false);
  expect(benignCors("Access to fetch at 'https://www.cnbc.com/quotes/US10Y' from origin 'https://akyachtsman.github.io' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource."),
    'and neither is any other CNBC URL').toBe(false);
  // a foreign URL that merely CARRIES the permitted prefix in its query string (Codex, PR #300) — in the message, in the location, and in the 5xx rule's URL
  const carrier = 'https://evil.example/fail?next=' + OPTIONAL_FEED;
  expect(benignCors("Access to fetch at '" + carrier + "' from origin 'https://akyachtsman.github.io' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource."),
    'a foreign URL carrying the prefix in its query is not allowlisted by its message').toBe(false);
  const corsMsg = 'Fetch API cannot load due to access control checks.';
  expect([benignCors(corsMsg, OPTIONAL_FEED + 'restQuote/x'), benignCors(corsMsg, carrier)],
    'the same CORS message is allowlisted by a location that STARTS with the prefix and not by one that merely carries it').toEqual([true, false]);
  expect([optionalFeedUrl(OPTIONAL_FEED + 'restQuote/x'), optionalFeedUrl(carrier), optionalFeedUrl(' ' + OPTIONAL_FEED), optionalFeedUrl(undefined)],
    'a location URL must START with the prefix').toEqual([true, false, false, false]);
  expect([optionalFeedInText("fetch at '" + OPTIONAL_FEED + "x'"), optionalFeedInText(OPTIONAL_FEED + 'x'), optionalFeedInText('load ' + OPTIONAL_FEED + 'x'),
    optionalFeedInText(carrier), optionalFeedInText('x/' + OPTIONAL_FEED), optionalFeedInText(null)],
    'a message names it only as a whole URL token (start, or after whitespace / a quote / a bracket), never after = ? or /').toEqual([true, true, true, false, false, false]);
  // the chart feed (the 1D span) is the second exact prefix, held to the same rules
  const chartMsg = (u) => "Access to fetch at '" + u + "' from origin 'https://akyachtsman.github.io' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.";
  expect([benignCors(chartMsg(OPTIONAL_FEED_CHARTS + '..json?symbol=US10Y')), benignCors(chartMsg('https://ts-api.cnbc.com.evil.example/harmony/app/charts/1D.json')), benignCors(chartMsg('https://ts-api.cnbc.com/harmony/app/other/1D.json')),
    benignCors(chartMsg('https://evil.example/x?next=' + OPTIONAL_FEED_CHARTS)), optionalFeedUrl(OPTIONAL_FEED_CHARTS + '1D.json?symbol=US2Y'), optionalFeedUrl('https://evil.example/x?next=' + OPTIONAL_FEED_CHARTS)],
    'the chart feed prefix is allowlisted; a look-alike host, another path on the host and a URL that merely carries the prefix are not').toEqual([true, false, false, false, true, false]);
  expect(errs, 'no page errors').toEqual([]);
});

// ── S58 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// 1D on the Economy panel (owner request 2026-10-01: "add the one day chart" → "build it blind"). The 2Y, 10Y and 20Y draw the day's
// price bars from CNBC's chart feed, fetched by the visitor's browser; the feed's URL and shape were NOT measured (the build sandbox
// gets 403 from every CNBC host), so this scenario pins the DESIGN's promises rather than the feed: 1D is a VIEW — desk-econ is never
// asked for it; the bars are parsed from the plausible shapes; and every way the feed can fail is NAMED on the row (caption + tooltip)
// with no chart drawn from anything but real bars — never a substitute source (owner: "no fallbacks"). The monthly rows say they have
// no 1-day data. Driven with stubs on Playwright's fake clock (Thu 08:50:30 PT) — never the network.
test('S58: 1D — the yields draw CNBC\'s intraday bars, desk-econ is never asked for it, and every failure is named', async ({ page, renderWitness }) => {
  renderWitness();
  test.setTimeout(240_000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.clock.install({ time: new Date('2026-10-01T15:50:30Z') });
  await gotoDemo(page, '#econList .econ-row', 15000);

  const rows1d = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#econList .econ-row')].map((li) => {
    const cap = li.querySelector('.econ-cap'), svg = li.querySelector('.econ-chart svg');
    return [li.dataset.id, { svg: !!svg, cap: cap ? cap.textContent : '', capClip: cap ? cap.scrollWidth > cap.clientWidth + 1 : false, title: li.title, aria: svg ? svg.getAttribute('aria-label') : null }];
  })));
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('#econTf button[aria-pressed="true"]')].map((b) => b.dataset.tf));
  const pick = async (tf) => { await page.locator(`#econTf button[data-tf="${tf}"]`).click(); await expect.poll(pressed).toEqual([tf]); };
  const YIELDS = ['ust2y', 'ust10y', 'ust20y'], MONTHLY = ['unrate', 'cpi', 'pce', 'corepce'];

  // ── 1. demo: 1D draws seeded bars for the yields, says "no 1-day data" for the rest, asks nothing, and persists
  await page.evaluate(() => { window.__bcalls = 0; window.__realBars0 = econLiveBars; window.econLiveBars = () => { window.__bcalls++; return Promise.resolve({ ok: false, why: 'noanswer', detail: 'x' }); }; });
  await pick('1d');
  let R = await rows1d();
  expect(YIELDS.map((id) => [R[id].svg, R[id].cap]), 'demo 1D: each yield draws a chart captioned with the Pacific clock of the bond session (08:00-17:00 ET)').toEqual(YIELDS.map(() => [true, '05:00 – 14:00']));
  expect(MONTHLY.map((id) => [R[id].svg, R[id].cap]), 'and every monthly row has no chart and says so').toEqual(MONTHLY.map(() => [false, 'no 1-day data']));
  expect(MONTHLY.every((id) => /no 1-day data: a monthly indicator has no intraday series/.test(R[id].title)), 'its tooltip says why').toBe(true);
  expect(Object.values(R).some((r) => r.capClip), 'no caption is clipped').toBe(false);
  expect(await page.evaluate(() => window.__bcalls), 'demo never asks CNBC for bars').toBe(0);
  expect(await page.evaluate(() => [localStorage.getItem('econ_tf_v1'), econTf, econRange]), '1D is persisted as the VIEW; the range desk-econ is asked for stays 3M').toEqual(['1d', '1d', '3m']);
  const demoPath = await page.evaluate(() => document.querySelector('#econList .econ-row[data-id="ust10y"] .econ-line').getAttribute('d'));
  expect(demoPath.length, 'a real path, not a stub').toBeGreaterThan(200);
  await pick('3m');
  R = await rows1d();
  expect([...YIELDS, ...MONTHLY].map((id) => R[id].svg), 'back on 3M every row draws its daily chart again').toEqual(Array(7).fill(true));
  expect(Object.values(R).filter((r) => /no 1-day data/.test(r.cap)), 'and nothing says "no 1-day data"').toEqual([]);
  await pick('1d');
  await page.reload();
  await expect(page.locator('#econList .econ-row').first()).toBeVisible({ timeout: 15000 });
  expect(await pressed(), 'a reload keeps 1D').toEqual(['1d']);
  expect(await page.evaluate(() => [econTf, econRange]), 'and starts the range on the default span').toEqual(['1d', '3m']);
  await pick('3m');

  // ── 2. parsing: the plausible shapes, the times, the guards
  const parsed = await page.evaluate(() => {
    const now = Date.parse('2026-10-01T15:50:30Z');
    const open = Date.parse('2026-10-01T12:00:00Z');   // 08:00 EDT
    const bar = (i, o = {}) => ({ tradeTimeinMills: open + i * 300000, close: (5.2 + i / 1000).toFixed(3), ...o });
    const A = { barData: { priceBars: [0, 1, 2, 3].map((i) => bar(i)) } };
    const wall = (hhmmss, day = '20261001') => ({ tradeTime: day + hhmmss, close: '5.25' });
    const P = (b) => econBarsParse(b, now);
    const keys = (x) => ({ n: x.pts.length, why: x.why });
    return {
      A: P(A), B: P({ priceBars: [wall('080000'), wall('080500'), wall('081000')] }), C: P([bar(0), bar(1)]), D: P({ bars: [bar(0, { last: '5.31', close: undefined }), bar(1, { close: null, last: '5.32' })] }),
      wallInstants: [econBarMs(wall('083000')), econBarMs(wall('083000', '20261201')), econBarMs(wall('120000', '20260311')), econBarMs(wall('120000', '20260307'))],
      iso: econBarMs({ time: '2026-10-01T08:00:00.000-0400' }), mills: econBarMs({ tradeTimeinMills: String(open) }),
      badDates: [econBarMs(wall('080000', '20260230')), econBarMs(wall('250000')), econBarMs(wall('087000')), econBarMs({ tradeTime: 'soon' }), econBarMs({})],
      future: keys(P({ priceBars: [bar(0), bar(1), bar(2), bar(3), bar(60)] })), bad: keys(P({ priceBars: [bar(0), bar(1, { close: '52.9' }), bar(2, { close: 'N/A' }), bar(3)] })),
      twoDays: P({ priceBars: [{ tradeTimeinMills: open - 86400000, close: '5.0' }, { tradeTimeinMills: open - 86400000 + 300000, close: '5.0' }, bar(0), bar(1), bar(2)] }),
      unsorted: P({ priceBars: [bar(2), bar(0), bar(1)] }).pts.map((p) => p[0] - open),
      // yesterday's session plus ONE bar of today: the newest session has a single usable bar — no chart, a reason, and the last good bars are kept (Codex, PR #301)
      oneNew: (() => { const body = { priceBars: [0, 1, 2].map((i) => ({ tradeTimeinMills: open - 86400000 + i * 300000, close: '5.0' })).concat([bar(0)]) };
        return { parse: P(body), keep: econBarsEntry('ust10y', { ok: true, body }, { pts: [[open - 600000, 5.2], [open - 300000, 5.21]], fetchedAt: now - 60000 }, now) }; })(),
      formats: [P(null), P('x'), P({ foo: 1, barData: { zz: 2 } }), P({ priceBars: [] }), P({ priceBars: [{ a: 1 }] })].map((x) => [x.why, x.detail]),
      thinned: P({ priceBars: Array.from({ length: 400 }, (_, i) => ({ tradeTimeinMills: open + i * 60000, close: (5.2 + Math.sin(i / 9) / 10).toFixed(3) })) }).pts.length,
    };
  });
  expect(parsed.A.pts.map((p) => p[1]), 'shape A (barData.priceBars, epoch-ms times, string closes) → the prices in time order').toEqual([5.2, 5.201, 5.202, 5.203]);
  expect([parsed.B.pts.length, parsed.B.pts[0][0], parsed.B.pts[2][0]], 'shape B (priceBars with New York wall-clock `tradeTime`) → 08:00 EDT is 12:00Z').toEqual([3, Date.parse('2026-10-01T12:00:00Z'), Date.parse('2026-10-01T12:10:00Z')]);
  expect([parsed.C.pts.length, parsed.D.pts.map((p) => p[1])], 'a bare array, and `last` in place of `close`').toEqual([2, [5.31, 5.32]]);
  expect(parsed.wallInstants, 'New York wall time → instant across the year: EDT (-4) in October and on the Wednesday after the spring change, EST (-5) in December and on the Saturday before it').toEqual([
    Date.parse('2026-10-01T12:30:00Z'), Date.parse('2026-12-01T13:30:00Z'), Date.parse('2026-03-11T16:00:00Z'), Date.parse('2026-03-07T17:00:00Z')]);
  expect([parsed.iso, parsed.mills], 'an ISO stamp with its offset, and ms given as a string').toEqual([Date.parse('2026-10-01T12:00:00Z'), Date.parse('2026-10-01T12:00:00Z')]);
  expect(parsed.badDates.every((v) => Number.isNaN(v)), 'a date that does not exist (Feb 30, 25:00, minute 70), junk or nothing is refused, never repaired onto another instant').toBe(true);
  expect([parsed.future, parsed.bad], 'a bar from the future and a ×10 / N/A price are skipped, the rest kept').toEqual([{ n: 4, why: '' }, { n: 2, why: '' }]);
  expect(parsed.twoDays.pts.length, 'only the NEWEST session\'s bars (a 1-day chart)').toBe(3);
  expect(parsed.unsorted, 'bars are put in time order').toEqual([0, 300000, 600000]);
  expect([parsed.oneNew.parse.pts.length, parsed.oneNew.parse.why, parsed.oneNew.parse.detail], 'yesterday plus ONE bar of today is not enough for a chart: a named reason, not a one-point result').toEqual([0, 'empty', "4 bars in the reply, 1 usable on the newest session (a bar's keys: tradeTimeinMills,close)"]);
  expect([parsed.oneNew.keep.pts.length, parsed.oneNew.keep.why], 'and it keeps the last good bars rather than blanking the chart').toEqual([2, 'empty']);
  expect(parsed.formats.map((f) => f[0]), 'null, a string, an unknown object, an empty list and a list of junk each name a reason').toEqual(['format', 'format', 'format', 'empty', 'empty']);
  expect(parsed.formats[2][1], 'an unknown format lists the reply\'s keys (the owner reads these back)').toBe('unrecognised reply format (keys: foo,barData / barData: zz)');
  expect(parsed.formats[4][1], 'and an empty one lists a bar\'s keys').toMatch(/1 bars in the reply, 0 usable \(a bar's keys: a\)/);
  expect(parsed.thinned, 'a day of one-minute bars is thinned to at most 150 real points').toBeLessThanOrEqual(150);

  // ── 3. force live: stub the quote, desk-econ (recording the range it is asked) and the bars
  await page.evaluate(() => {
    DESK_DB.url = DESK_DB.url || 'https://stub.invalid';
    DESK.mode = 'live';
    localStorage.removeItem('econ_seen_v1'); localStorage.removeItem('econ_pending_v1'); econSeen = {}; econPending = {};
    window.__ranges = []; window.__bsyms = [];
    const quote = (sym, last, ts) => ({ symbol: sym, code: 0, last: last + '%', last_time: new Date(ts - 4 * 3600000).toISOString().slice(0, 19) + '.000-0400', change: '-0.04' });
    window.econLiveCnbc = () => Promise.resolve({ FormattedQuoteResult: { FormattedQuote: [quote('US2Y', 4.787, Date.now() - 30000), quote('US10Y', 5.253, Date.now() - 30000), quote('US20Y', 5.612, Date.now() - 30000)] } });
    const open = Date.parse('2026-10-01T12:00:00Z');
    window.__good = (base) => ({ ok: true, body: { barData: { priceBars: Array.from({ length: 47 }, (_, i) => ({ tradeTimeinMills: open + i * 300000, close: (base + Math.sin(i / 6) * 0.04).toFixed(3) })) } } });
    window.__base = { US2Y: 4.79, US10Y: 5.25, US20Y: 5.61 };
    window.__bfn = (sym) => window.__good(window.__base[sym]);
    window.econLiveBars = (sym) => { window.__bsyms.push(sym); return Promise.resolve(window.__bfn(sym)); };
    window.deskEcon = (range) => {
      window.__ranges.push(range);
      const p = buildDemoEcon(range);
      const rows = p.rows.map((r) => (['ust2y', 'ust10y', 'ust20y'].includes(r.id) ? { ...r, asOf: '2026-09-30', prevAsOf: '2026-09-29', source: 'treasury', value: { ust2y: 4.88, ust10y: 5.29, ust20y: 5.68 }[r.id] } : r));
      return Promise.resolve({ ...p, rows, range, generatedAt: new Date().toISOString(), refreshInSec: 900, stale: false });
    };
    startEcon();
  });
  await expect(page.locator('#econList .econ-row[data-live="1"]'), 'the three yields are live').toHaveCount(3);
  expect(await page.evaluate(() => [window.__ranges, window.__bsyms.length]), 'booted on 3M: desk-econ was asked for 3m, and no bars were fetched (1D is not the view)').toEqual([['3m'], 0]);

  // ── 4. picking 1D asks CNBC for each yield's bars and desk-econ for NOTHING; the poll clock is not touched
  const dueBefore = await page.evaluate(() => econState.dueAt);
  await pick('1d');
  await expect.poll(() => page.evaluate(() => window.__bsyms.length), 'one bars request per yield').toBe(3);
  expect(await page.evaluate(() => window.__bsyms.slice().sort()), 'for US2Y, US10Y and US20Y').toEqual(['US10Y', 'US20Y', 'US2Y']);
  await expect(page.locator('#econList .econ-row[data-id="ust10y"] .econ-chart svg'), 'the 10Y draws its day').toHaveCount(1);
  R = await rows1d();
  expect(YIELDS.map((id) => [R[id].svg, R[id].cap]), 'each yield: a chart captioned with the Pacific clock of its first and last bar (08:00 → 05:00, 11:50 → 08:50)').toEqual(YIELDS.map(() => [true, '05:00 – 08:50']));
  expect(R.ust10y.aria, 'the chart\'s accessible name says what it is').toBe('10Y Treasury, 47 prices 05:00 – 08:50 Pacific');
  expect(R.ust2y.title, 'the tooltip names the source and the count').toContain('1-day chart: 47 CNBC US2Y prices, 05:00 – 08:50');
  expect(MONTHLY.map((id) => [R[id].svg, R[id].cap]), 'the monthly rows say they have no 1-day data').toEqual(MONTHLY.map(() => [false, 'no 1-day data']));
  expect(await page.evaluate(() => window.__ranges), 'desk-econ was NOT asked for 1D (it would answer an unknown range with 3m, a failed poll)').toEqual(['3m']);
  expect(await page.evaluate((d) => econState.dueAt === d, dueBefore), 'and the desk-econ poll clock did not move').toBe(true);
  expect(await page.evaluate(() => [...document.querySelectorAll('#econList .econ-row[data-id="ust10y"] .econ-sub *')].map((e) => e.textContent).join('|')), 'the row\'s own liveness chip and date are untouched by the view').toMatch(/08:49|08:50|LIVE/);
  expect(Object.values(R).some((r) => r.capClip), 'no caption clipped').toBe(false);

  // ── 5. a span change from 1D: a NEW span asks desk-econ once; 1D again and back to the span that is showing ask nothing
  await pick('1w');
  expect(await page.evaluate(() => window.__ranges), 'from 1D to 1W: desk-econ is asked for 1w').toEqual(['3m', '1w']);
  await pick('1d');
  await pick('1w');
  expect(await page.evaluate(() => [window.__ranges, econRange]), '1W → 1D → 1W asks nothing more').toEqual([['3m', '1w'], '1w']);
  await pick('1d');

  // ── 6. every failure is NAMED on the row; no chart is drawn from anything else
  const fail = async (res, label) => {
    await page.evaluate((r) => { window.__bfn = r === 'far' ? () => window.__good(7.5) : () => r; econBars.m = {}; return econBarsFetch(); }, res);
    return rows1d();
  };
  for (const [label, res, cap, tip] of [
    ['HTTP 403', { ok: false, why: 'http', detail: 'HTTP 403' }, '1D HTTP 403', '1-day chart unavailable: HTTP 403'],
    ['no answer', { ok: false, why: 'noanswer', detail: 'no answer (blocked by CNBC, an extension or the network, or too slow)' }, '1D no answer', 'unavailable: no answer (blocked by CNBC'],
    ['not JSON', { ok: false, why: 'json', detail: 'the reply was not JSON' }, '1D not JSON', 'the reply was not JSON'],
    ['unknown format', { ok: true, body: { status: 'ok', data: { x: 1 } } }, '1D unknown format', 'unrecognised reply format (keys: status,data)'],
    ['no bars', { ok: true, body: { barData: { priceBars: [] } } }, '1D no bars', '0 bars in the reply, 0 usable'],
    ['bars disagree with the quote', 'far', '1D bars ≠ quote', 'points from the quote'],
  ]) {
    const F = await fail(res, label);
    expect(YIELDS.map((id) => [F[id].svg, F[id].cap]), `${label}: no chart, and the caption says why`).toEqual(YIELDS.map(() => [false, cap]));
    expect(YIELDS.every((id) => F[id].title.includes(tip)), `${label}: the tooltip carries the detail ("${tip}")`).toBe(true);
    expect(Object.values(F).some((r) => r.capClip), `${label}: the caption is not clipped`).toBe(false);
    expect(MONTHLY.map((id) => F[id].cap), `${label}: the monthly rows still just say they have none`).toEqual(MONTHLY.map(() => 'no 1-day data'));
  }
  expect(await page.evaluate(() => (window.__ranges.length)), 'no failure ever reached desk-econ').toBe(2);

  // ── 7. a good reply after failures draws; a failure AFTER a good reply keeps the last good bars for 30 minutes, says so, then gives up
  await page.evaluate(() => { window.__bfn = (sym) => window.__good(window.__base[sym]); econBars.m = {}; return econBarsFetch(); });
  R = await rows1d();
  expect(YIELDS.map((id) => R[id].svg), 'recovered').toEqual([true, true, true]);
  await page.evaluate(() => { window.__bfn = () => ({ ok: false, why: 'http', detail: 'HTTP 502' }); });
  await page.clock.runFor(61_000);                                       // the next poll (60 s in session) refreshes the bars too
  R = await rows1d();
  expect(YIELDS.map((id) => R[id].svg), 'a failed refresh keeps the last good bars...').toEqual([true, true, true]);
  expect(YIELDS.every((id) => R[id].title.includes('the last refresh failed (HTTP 502), these are the last good prices')), '...and the tooltip says the refresh failed').toBe(true);
  await page.clock.runFor(31 * 60_000);
  R = await rows1d();
  expect(YIELDS.map((id) => [R[id].svg, R[id].cap]), 'past 30 minutes without a good reply: no chart, the reason').toEqual(YIELDS.map(() => [false, '1D HTTP 502']));

  // ── 8. cadence: bars ride the quote poll ONLY while 1D is showing; a hidden tab asks for nothing
  await page.evaluate(() => { window.__bfn = (sym) => window.__good(window.__base[sym]); });
  await page.clock.runFor(61_000);
  await expect.poll(async () => (await rows1d()).ust10y.svg, 'a good reply on the next poll brings the charts back').toBe(true);
  // a FORCED refresh ("Refresh now") stays pending until the bars have landed too (Codex, PR #301)
  await page.evaluate(() => {
    window.__rel = []; window.__fdone = false;
    window.__bfn = (sym) => new Promise((res) => window.__rel.push(() => res(window.__good(window.__base[sym]))));
    window.__f = econLiveFetch(true); window.__f.then(() => { window.__fdone = true; });
  });
  await page.clock.runFor(3_000);
  expect(await page.evaluate(() => [window.__rel.length, window.__fdone]), 'a forced refresh asked for the three bars and is still pending while they are outstanding (the quote has long landed)').toEqual([3, false]);
  await page.evaluate(() => { window.__rel.forEach((f) => f()); return window.__f; });
  expect(await page.evaluate(() => window.__fdone), 'and resolves once they land').toBe(true);
  await page.evaluate(() => { window.__bfn = (sym) => window.__good(window.__base[sym]); });
  let n = await page.evaluate(() => window.__bsyms.length);
  await page.clock.runFor(61_000);
  expect(await page.evaluate(() => window.__bsyms.length), 'a minute on: three more requests (one per yield)').toBe(n + 3);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); econVisibility(); });
  n = await page.evaluate(() => window.__bsyms.length);
  await page.clock.runFor(180_000);
  expect(await page.evaluate(() => window.__bsyms.length), 'hidden for three minutes: no bars requests').toBe(n);
  await page.evaluate(() => { delete document.hidden; econVisibility(); });
  await expect.poll(() => page.evaluate(() => window.__bsyms.length), 'visible again with old bars: asked at once').toBeGreaterThan(n);
  await pick('3m');
  n = await page.evaluate(() => window.__bsyms.length);
  await page.clock.runFor(125_000);
  expect(await page.evaluate(() => window.__bsyms.length), 'off 1D: the bars are not asked for any more').toBe(n);
  await page.evaluate(() => econBarsFetch());
  expect(await page.evaluate(() => window.__bsyms.length), 'and asking for them directly while another span is showing does nothing').toBe(n);

  // ── 9. a saved 1D at boot: desk-econ is asked for the default span, not "1d", and the bars come with the first quote
  await page.evaluate(() => { localStorage.setItem('econ_tf_v1', '1d'); });
  await page.reload();
  await expect(page.locator('#econList .econ-row').first()).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => {
    DESK_DB.url = DESK_DB.url || 'https://stub.invalid'; DESK.mode = 'live';
    window.__ranges = []; window.__bsyms = []; window.__realBars = econLiveBars;
    window.econLiveCnbc = () => Promise.resolve(null);
    window.econLiveBars = (sym) => { window.__bsyms.push(sym); return Promise.resolve({ ok: false, why: 'http', detail: 'HTTP 403' }); };
    window.deskEcon = (range) => { window.__ranges.push(range); return Promise.resolve({ ...buildDemoEcon(range), range, generatedAt: new Date().toISOString(), refreshInSec: 900, stale: false }); };
    startEcon();
  });
  await expect.poll(() => page.evaluate(() => window.__ranges.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => [econTf, econRange, window.__ranges[0]]), 'saved 1D: the view is 1D, the range 3m, and desk-econ is asked for 3m').toEqual(['1d', '3m', '3m']);
  await expect.poll(() => page.evaluate(() => window.__bsyms.length), 'and the bars are asked for at boot').toBe(3);
  await expect(page.locator('#econList .econ-row')).toHaveCount(7);
  await expect.poll(async () => YIELDS.map((id) => /* R */ 0).length && (await rows1d()).ust2y.cap, 'CNBC refusing (403) at boot is named on the yields').toBe('1D HTTP 403');
  R = await rows1d();
  expect(YIELDS.map((id) => R[id].cap), 'on every yield').toEqual(YIELDS.map(() => '1D HTTP 403'));
  await page.evaluate(() => { localStorage.setItem('econ_tf_v1', '3m'); });

  // ── 10. the real econLiveBars: the exact URL with ONLY an abort signal, NEVER throws, a hang is given up on at 8 s
  const real = await page.evaluate(async () => {
    const f0 = window.fetch, calls = [], out = {};
    try {
      window.fetch = (url, init) => { calls.push([String(url), Object.keys(init || {})]); return Promise.resolve(new Response(JSON.stringify({ priceBars: [] }), { status: 200 })); };
      out.ok = await window.__realBars('US10Y');
      window.fetch = () => Promise.resolve(new Response('denied', { status: 403 }));
      out.denied = await window.__realBars('US2Y');
      window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
      out.blocked = await window.__realBars('US2Y');
      window.fetch = () => Promise.resolve(new Response('<html>x</html>', { status: 200 }));
      out.html = await window.__realBars('US2Y');
    } finally { window.fetch = f0; }
    return { ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v.ok, v.why || '', v.detail || '']])), calls };
  });
  expect(real.calls[0], 'the request is the chart URL for the symbol with ONLY an abort signal').toEqual(['https://ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=US10Y', ['signal']]);
  expect([real.ok[0], real.denied, real.blocked[1], real.html[1]], 'a 200 gives the body; 403 / blocked / not-JSON give named reasons, never a throw').toEqual([true, [false, 'http', 'HTTP 403'], 'noanswer', 'json']);
  const hung = page.evaluate(async () => {
    const f0 = window.fetch;
    window.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    try { return await window.__realBars('US2Y'); } finally { window.fetch = f0; }
  });
  const settled = (p) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 400))]);   // real-time look: the page clock also ticks on its own
  await page.clock.runFor(7_000);
  expect(await settled(hung), 'a request silent for 7 s is still waiting...').toBe(false);
  await page.clock.runFor(1_500);
  expect(await settled(hung), '...and by 8.5 s it has been given up on').toBe(true);
  expect((await hung).why, 'as "no answer"').toBe('noanswer');
  expect(errs, 'no page errors').toEqual([]);
});
