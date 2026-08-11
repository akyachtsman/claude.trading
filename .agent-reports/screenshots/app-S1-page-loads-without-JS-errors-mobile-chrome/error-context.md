# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.js >> S1: page loads without JS errors
- Location: tests/app.spec.js:271:1

# Error details

```
Error: JS errors on load: Failed to load resource: net::ERR_CONNECTION_RESET (https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap)

expect(received).toHaveLength(expected)

Expected length: 0
Received length: 1
Received array:  ["Failed to load resource: net::ERR_CONNECTION_RESET (https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap)"]
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - banner [ref=e3]:
    - generic [ref=e4]:
      - heading "claude.trading" [level=1] [ref=e5]
      - paragraph [ref=e6]: Private multi-account desk
  - generic [ref=e7]:
    - complementary "Markets" [ref=e8]:
      - region "Markets" [ref=e9]:
        - generic [ref=e10]:
          - heading "Markets" [level=2] [ref=e11]
          - generic [ref=e12]: Demo
          - generic [ref=e13]: —
        - generic [ref=e14]:
          - tablist "Region" [ref=e15]
          - img "Index performance — S&P 500, NASDAQ and Russell normalized to percent change over the selected window" [ref=e17]
          - generic [ref=e18]:
            - group "Chart timeframe"
          - heading "Performance by Sector" [level=3] [ref=e19]
    - complementary "Watchlists" [ref=e20]:
      - region "Watchlists" [ref=e21]:
        - generic [ref=e22]:
          - heading "Watchlists" [level=2] [ref=e23]
          - generic [ref=e24]: Demo
          - button "Edit watchlists" [ref=e25] [cursor=pointer]: ✎
          - group "Sort watchlist symbols" [ref=e26]
          - group "Chart timeframe" [ref=e27]
          - button "New symbol tile" [ref=e28] [cursor=pointer]: +
          - button "Remove the focused symbol, or drag one here" [ref=e29] [cursor=pointer]: 🗑
          - button "New watchlist" [ref=e30] [cursor=pointer]: + list
          - button "Lock the arrangement" [ref=e31] [cursor=pointer]: 🔓
          - generic [ref=e32]: —
    - complementary "Market news" [ref=e34]:
      - region "News" [ref=e35]:
        - generic [ref=e36]:
          - heading "News" [level=2] [ref=e37]
          - generic [ref=e38]: Demo
          - generic [ref=e39]: —
        - region "News headlines — scrollable" [ref=e40]
  - generic [ref=e41]:
    - region "Accounts" [ref=e42]:
      - heading "Accounts" [level=2] [ref=e45]
    - complementary "Desk tools" [ref=e46]:
      - region "Ask the desk" [ref=e47]:
        - generic [ref=e48]:
          - heading "Ask the desk" [level=2] [ref=e49]
          - generic [ref=e50]: Demo
  - region "Stochastic charts" [ref=e52]:
    - generic [ref=e53]:
      - heading "Stochastic charts" [level=2] [ref=e54]
      - generic [ref=e55]: Demo
      - generic [ref=e56]:
        - combobox "Chart symbol — type any ticker" [ref=e57]
        - button "Load" [ref=e58] [cursor=pointer]
      - generic [ref=e59]:
        - generic [ref=e60]: PANE
        - group "Pane layout" [ref=e61]:
          - button "Split" [pressed] [ref=e62] [cursor=pointer]
          - button "Pro 1" [ref=e63] [cursor=pointer]
          - button "Pro 2" [ref=e64] [cursor=pointer]
          - button "Pro 3" [ref=e65] [cursor=pointer]
      - generic [ref=e66]: —
    - generic [ref=e68]:
      - navigation "Watchlist symbols" [ref=e69]
      - generic [ref=e70]:
        - generic [ref=e71]:
          - generic [ref=e72]:
            - generic [ref=e73]: PRO 1
            - group "Pro 1 daily timeframe" [ref=e74]:
              - button "1M" [ref=e75] [cursor=pointer]
              - button "3M" [pressed] [ref=e76] [cursor=pointer]
              - button "6M" [ref=e77] [cursor=pointer]
              - button "YTD" [ref=e78] [cursor=pointer]
              - button "1Y" [ref=e79] [cursor=pointer]
              - button "All" [ref=e80] [cursor=pointer]
            - generic [ref=e81]:
              - button "Lock Pro 1 scroll-wheel zoom" [ref=e82] [cursor=pointer]: 🔓
              - button "Pro 1 chart settings" [ref=e83] [cursor=pointer]: ⚙
          - generic [ref=e84]:
            - generic [ref=e85]: PRO 2
            - group "Pro 2 daily timeframe" [ref=e86]:
              - button "1M" [ref=e87] [cursor=pointer]
              - button "3M" [ref=e88] [cursor=pointer]
              - button "6M" [pressed] [ref=e89] [cursor=pointer]
              - button "YTD" [ref=e90] [cursor=pointer]
              - button "1Y" [ref=e91] [cursor=pointer]
              - button "All" [ref=e92] [cursor=pointer]
            - generic [ref=e93]:
              - button "Lock Pro 2 scroll-wheel zoom" [ref=e94] [cursor=pointer]: 🔓
              - button "Pro 2 chart settings" [ref=e95] [cursor=pointer]: ⚙
          - generic [ref=e96]:
            - generic [ref=e97]: PRO 3
            - generic [ref=e98]: Day trading · drag the range slider below
            - generic [ref=e99]:
              - button "Lock Pro 3 scroll-wheel zoom" [ref=e100] [cursor=pointer]: 🔓
              - button "Pro 3 chart settings" [ref=e101] [cursor=pointer]: ⚙
        - 'img "Three-pane workbench: Pro 1 swing (daily), Pro 2 long-term (daily candles with a weekly-scale stochastic), and Pro 3 day-trading (15-minute bars) charts with volume and slow stochastics — 14-3-3 daily, 10-3-3 intraday, 92-15-15 weekly scale — doctrine signal markers circled" [ref=e102]'
  - region "Heatmap — S&P 500" [ref=e103]:
    - generic [ref=e104]:
      - heading "Heatmap — S&P 500" [level=2] [ref=e105]
      - generic [ref=e106]: Demo
      - button "Show" [ref=e107] [cursor=pointer]
      - generic [ref=e108]: —
  - contentinfo [ref=e109]:
    - paragraph [ref=e110]: "Data: IBKR Flex reports (accounts) · market and news snapshots committed by scheduled jobs. Every panel shows its own as-of stamp — this dashboard renders snapshots, not live quotes."
    - paragraph [ref=e111]: Nothing here is investment, tax, or legal advice. Past performance is not a guarantee of future results.
```

# Test source

```ts
  210 |   return await page.evaluate(() => {
  211 |     const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')]
  212 |       .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  213 |     if (inputs.length !== 1) return false;
  214 |     const el = inputs[0];
  215 |     const ctx = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id,
  216 |                  document.body.innerText?.slice(0, 300)].join(' ').toLowerCase();
  217 |     const looksAuth = /\b(pin|passcode|access\s*code|access|log\s*in|login|sign\s*in|unlock|enter\s*code|password)\b/.test(ctx);
  218 |     const controls = document.querySelectorAll('button, [role=button], a[href], select, textarea').length;
  219 |     return looksAuth && controls <= 4;
  220 |   });
  221 | }
  222 | 
  223 | // ─────────────────────────────────────────────────────────────────────────────
  224 | // INTERACTIVE ELEMENT DISCOVERY
  225 | // ─────────────────────────────────────────────────────────────────────────────
  226 | async function discoverElements(page) {
  227 |   return page.evaluate(() => {
  228 |     const selectors = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
  229 |                        '[role=button]', '[onclick]'];
  230 |     return selectors.flatMap(sel =>
  231 |       [...document.querySelectorAll(sel)]
  232 |         // Index BEFORE filtering: page.locator(sel).nth(i) counts every DOM match,
  233 |         // hidden included, so the recorded index must count them too.
  234 |         .map((el, index) => ({ el, index }))
  235 |         .filter(({ el }) => {
  236 |           const r = el.getBoundingClientRect();
  237 |           return r.width > 0 && r.height > 0;
  238 |         })
  239 |         .map(({ el, index }) => ({
  240 |           selector: sel,
  241 |           index,
  242 |           tag: el.tagName.toLowerCase(),
  243 |           type: el.getAttribute('type') ?? null,
  244 |           label: (el.textContent?.trim().slice(0, 60) ||
  245 |                   el.getAttribute('aria-label') ||
  246 |                   el.getAttribute('placeholder') ||
  247 |                   el.getAttribute('name') ||
  248 |                   el.id || '').slice(0, 60),
  249 |           id: el.id || null,
  250 |         }))
  251 |     );
  252 |   });
  253 | }
  254 | 
  255 | // ─────────────────────────────────────────────────────────────────────────────
  256 | // TEST FILL VALUE — infer plausible value from element context
  257 | // ─────────────────────────────────────────────────────────────────────────────
  258 | function testValueFor(el) {
  259 |   const label = (el.label + (el.type ?? '')).toLowerCase();
  260 |   if (/email/.test(label))         return 'test@example.com';
  261 |   if (/date/.test(label))          return new Date().toISOString().split('T')[0];
  262 |   if (/number|qty|amount|count/.test(label)) return '42';
  263 |   if (/phone|tel/.test(label))     return '5551234567';
  264 |   if (/url|link/.test(label))      return 'https://example.com';
  265 |   return 'Test input';
  266 | }
  267 | 
  268 | // ─────────────────────────────────────────────────────────────────────────────
  269 | // SCENARIO 1 — Page Load
  270 | // ─────────────────────────────────────────────────────────────────────────────
  271 | test('S1: page loads without JS errors', async ({ page }) => {
  272 |   const errors = [];
  273 |   /* Shared with S3 — see benignPageError at the top of this file. */
  274 |   page.on('pageerror', e => {
  275 |     const t = e.message || '';
  276 |     if (benignPageError(t)) return;
  277 |     errors.push(t);
  278 |   });
  279 |   // Allowlist (spec Clarifications #7, Group C): failed fetches to the live
  280 |   // feed origin log browser console errors we can't suppress from JS
  281 |   // ("Failed to load resource … functions/v1/desk-*"). The app handles those
  282 |   // failures by design (keeps last good render, lamps Stale) — S14 covers
  283 |   // feed health. Everything else still fails S1. Narrow on purpose: origin
  284 |   // substring only, never a blanket console mute.
  285 |   // Network-layer console errors carry the URL in location(), not text().
  286 |   page.on('console', m => {
  287 |     if (m.type() !== 'error') return;
  288 |     const at = (m.location() && m.location().url) || '';
  289 |     if (m.text().includes(FEED_ORIGIN) || at.includes(FEED_ORIGIN)) return;
  290 |     /* A CORS REJECTION from the feed origin is the same allowlisted noise, but
  291 |        it arrives as a PAIR and only the second message names the URL — the
  292 |        first says "Origin http://localhost:8080 is not allowed by
  293 |        Access-Control-Allow-Origin" with an EMPTY location, so neither existing
  294 |        test catches it. That is quote-proxy's origin allowlist working: it
  295 |        admits exactly the GitHub Pages origin and this job serves from
  296 |        localhost, so the browser is supposed to refuse. The live job, on the
  297 |        real origin, never sees it.
  298 |        It only started landing inside S1's window because the charts quote is
  299 |        polled every minute since the SMH staleness fix, instead of being fetched
  300 |        once per tab. Broader than benignPageError on purpose: S1's console rule
  301 |        has tolerated any CORS-phrased console error since it was written, and a
  302 |        console error is a far weaker signal than a pageerror. */
  303 |     if (FEED_CORS.test(m.text())) return;
  304 |     errors.push(`${m.text()} (${at || 'no url'})`);
  305 |   });
  306 |   await page.goto('./');
  307 |   await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  308 |   const bodyText = await page.evaluate(() => document.body.innerText?.trim());
  309 |   expect(bodyText?.length, 'Page body is empty').toBeGreaterThan(0);
> 310 |   expect(errors, `JS errors on load: ${errors.join('; ')}`).toHaveLength(0);
      |                                                             ^ Error: JS errors on load: Failed to load resource: net::ERR_CONNECTION_RESET (https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap)
  311 | });
  312 | 
  313 | // ─────────────────────────────────────────────────────────────────────────────
  314 | // SCENARIO 2 — Auth Discovery & Login (with API diagnostics)
  315 | // ─────────────────────────────────────────────────────────────────────────────
  316 | test('S2: auth gate discovered and credential accepted', async ({ page }) => {
  317 |   if (!AUTH_CREDENTIAL) test.skip(true, 'No auth credential found in CLAUDE.md or TEST_AUTH_CREDENTIAL env var — skipping auth test');
  318 |   const consoleErrors = [];
  319 |   page.on('pageerror', e => consoleErrors.push(e.message));
  320 |   page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  321 | 
  322 |   const getApiCalls = await captureApiCalls(page);
  323 |   await page.goto('./');
  324 |   await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  325 | 
  326 |   const beforeSnap = await domSnapshot(page);
  327 |   // Gate the auth attempt on detectAuthGate() — same as S4 and gotoAndAuth. Unguarded,
  328 |   // detectAndAuth's text-input fallback would type the credential into the first visible
  329 |   // text input (e.g. a public app's search box) and then falsely report auth failure.
  330 |   const mechanism  = (await detectAuthGate(page))
  331 |     ? await detectAndAuth(page, AUTH_CREDENTIAL ?? '')
  332 |     : 'none';
  333 |   const afterSnap  = await domSnapshot(page);
  334 | 
  335 |   const domChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);
  336 |   // A wrong credential often renders an inline error, which itself changes the DOM —
  337 |   // so domChanged alone is not proof of success. Treat a non-empty on-screen error as a
  338 |   // failure even when the DOM changed. Read the first VISIBLE, non-empty error element:
  339 |   // apps often keep hidden/empty `.error` placeholders, so `.first().textContent()` could
  340 |   // read the wrong node. Synchronous evaluate — no locator waiting, so it can't burn the
  341 |   // test timeout either.
  342 |   const onscreenError = await page.evaluate(() => {
  343 |     const els = [...document.querySelectorAll('[id*="err"], [class*="err"], [class*="error"]')]
  344 |       .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  345 |     for (const el of els) { const t = (el.textContent || '').trim(); if (t) return t; }
  346 |     return '';
  347 |   });
  348 | 
  349 |   if (mechanism !== 'none' && (!domChanged || onscreenError.length > 0)) {
  350 |     const apiCalls = await getApiCalls();
  351 |     const errText  = onscreenError;
  352 |     const firstKey = apiCalls[0]?.firstFieldKey ?? null;
  353 |     const diag = {
  354 |       mechanism,
  355 |       credentialProvided: AUTH_CREDENTIAL ? 'yes' : 'none — check CLAUDE.md',
  356 |       onscreenError: errText,
  357 |       consoleErrors,
  358 |       apiCalls,
  359 |       responseShape: firstKey
  360 |         ? `rows returned, first field "${firstKey}"`
  361 |         : (apiCalls[0]?.status >= 400 ? `non-2xx (${apiCalls[0]?.status})` : 'no rows returned — check query / RLS / auth'),
  362 |     };
  363 |     test.info().attach('auth-diagnostics', {
  364 |       body: JSON.stringify(diag, null, 2),
  365 |       contentType: 'application/json',
  366 |     });
  367 |     throw new Error(
  368 |       `S2 FAIL | mechanism: ${mechanism} | onscreenError: "${errText}" | ` +
  369 |       `API status: ${apiCalls[0]?.status ?? 'no call'} | ` +
  370 |       `recordCount: ${apiCalls[0]?.recordCount ?? 'n/a'} | ` +
  371 |       `responseShape: ${diag.responseShape} | ` +
  372 |       `consoleErrors: ${consoleErrors.join('; ') || 'none'}`
  373 |     );
  374 |   }
  375 | 
  376 |   // Auth passed or no auth required — record mechanism
  377 |   test.info().attach('auth-result', {
  378 |     body: JSON.stringify({ mechanism, domChanged }),
  379 |     contentType: 'application/json',
  380 |   });
  381 | });
  382 | 
  383 | // ─────────────────────────────────────────────────────────────────────────────
  384 | // SCENARIO 3 — Element Mapping & Interaction Sweep
  385 | // ─────────────────────────────────────────────────────────────────────────────
  386 | test('S3: interactive elements discovered and exercised without errors', async ({ page }) => {
  387 |   // The sweep scales with element count (settle + capped idle wait per
  388 |   // element) and cannot fit the 30s global timeout on element-rich apps or
  389 |   // mobile-emulated projects. 480s covers ~80 elements at the worst-case
  390 |   // per-element cost; the idle wait below is capped so one slow-settling
  391 |   // page can't eat the whole budget.
  392 |   test.setTimeout(480_000);
  393 |   // Public-first apps (knowledge hub, questionnaire) are swept even with no credential;
  394 |   // only auth-gated apps with no credential are skipped (decided after page load below).
  395 |   const consoleErrors = [];
  396 |   const apiAnomalies  = [];
  397 |   /* BENIGN_CONSOLE, FEED_ORIGIN, FEED_CORS and benignPageError are shared with
  398 |      S1 — see the allowlist block at the top of this file. Feed-origin failures
  399 |      are the app's to absorb (panels lamp STALE by design; S14 is where feed
  400 |      health fails loudly), which is why they are dropped in these two scenarios
  401 |      and nowhere else. This local regex is the shared origin STRING escaped for
  402 |      use as a pattern, so the two can never name different origins. */
  403 |   const FEED_ORIGIN_RE = new RegExp(FEED_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  404 |   page.on('console', m => {
  405 |     if (m.type() !== 'error') return;
  406 |     const text = m.text();
  407 |     if (BENIGN_CONSOLE.test(text)) return;
  408 |     const src = (m.location() && m.location().url) || '';
  409 |     /* Feed-origin noise only, per the S1/S3 rule in CLAUDE.md — every other
  410 |        console error still blocks.
```