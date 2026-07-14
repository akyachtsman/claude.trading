# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.js >> S1: page loads without JS errors
- Location: tests/app.spec.js:215:1

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
      - generic [ref=e8]: Stale
      - generic [ref=e9]: Live feed unreachable
  - region "Market summary" [ref=e10]:
    - generic [ref=e11]:
      - generic [ref=e12]: S&P 500
      - generic [ref=e13]:
        - generic [ref=e14]:
          - generic [ref=e15]: 6,318.42
          - generic [ref=e16]: +0.54%
        - img [ref=e17]
    - generic [ref=e20]:
      - generic [ref=e21]: Nasdaq 100
      - generic [ref=e22]:
        - generic [ref=e23]:
          - generic [ref=e24]: 23,104.88
          - generic [ref=e25]: +0.81%
        - img [ref=e26]
    - generic [ref=e29]:
      - generic [ref=e30]: Dow Jones
      - generic [ref=e31]:
        - generic [ref=e32]:
          - generic [ref=e33]: 44,912.30
          - generic [ref=e34]: +0.12%
        - img [ref=e35]
    - generic [ref=e38]:
      - generic [ref=e39]: IWM (R2K proxy)
      - generic [ref=e40]:
        - generic [ref=e41]:
          - generic [ref=e42]: "228.12"
          - generic [ref=e43]: −0.33%
        - img [ref=e44]
    - generic [ref=e47]:
      - generic [ref=e48]: VIX
      - generic [ref=e49]:
        - generic [ref=e50]:
          - generic [ref=e51]: "14.82"
          - generic [ref=e52]: −4.20%
        - img [ref=e53]
    - generic [ref=e56]:
      - generic [ref=e57]: US 10Y
      - generic [ref=e58]:
        - generic [ref=e59]:
          - generic [ref=e60]: 4.31%
          - generic [ref=e61]: +0.05%
        - img [ref=e62]
  - generic [ref=e65]:
    - generic [ref=e66]:
      - region "Accounts" [ref=e67]:
        - heading "Accounts" [level=2] [ref=e69]
        - generic [ref=e71]:
          - generic [ref=e72]:
            - heading "Accounts" [level=3] [ref=e73]
            - generic [ref=e74]: Locked
          - generic [ref=e75]:
            - paragraph [ref=e76]: Account balances, charts, and the AI brief are private — enter the desk PIN to unlock.
            - generic [ref=e77]:
              - textbox "Desk PIN" [ref=e78]
              - button "Unlock" [ref=e79] [cursor=pointer]
      - region "S&P 500 — heat" [ref=e80]:
        - generic [ref=e81]:
          - heading "S&P 500 — heat" [level=2] [ref=e82]
          - generic [ref=e83]: Demo
          - generic [ref=e84]: As of 2026-07-14
        - generic [ref=e85]:
          - generic [ref=e86]:
            - complementary "Map filter" [ref=e87]:
              - paragraph [ref=e88]: Map filter
              - navigation "Heatmap universe" [ref=e89]:
                - button "S&P 500" [ref=e90] [cursor=pointer]
                - button "Dow Jones 30" [ref=e91] [cursor=pointer]
                - button "Nasdaq 100" [ref=e92] [cursor=pointer]
                - button "ETFs" [ref=e93] [cursor=pointer]
                - button "Themes" [ref=e94] [cursor=pointer]
                - button "World" [ref=e95] [cursor=pointer]
                - button "Crypto" [ref=e96] [cursor=pointer]
                - button "Futures" [ref=e97] [cursor=pointer]
                - button "Russell 2000" [ref=e98] [cursor=pointer]
              - combobox "Performance period" [ref=e99]:
                - option "1-Day Performance" [selected]
                - option "1-Week Performance" [disabled]
                - option "1-Month Performance" [disabled]
                - option "YTD Performance" [disabled]
            - 'img "Market heatmap: tile size is market cap, color is performance; a movers table follows" [ref=e101]':
              - generic: INFORMATION TECHNOLOGY
              - generic: SEMICONDUCTORS
              - generic: NVDA
              - generic: −0.67%
              - generic: AVGO
              - generic: −1.07%
              - generic: AMD
              - generic: +1.15%
              - generic: SOFTWARE - INFRASTRU
              - generic: MSFT
              - generic: −0.79%
              - generic: ORCL
              - generic: CONSUMER ELECTRO
              - generic: AAPL
              - generic: −1.49%
              - generic: COMMUNICATION SERVICE
              - generic: INTERNET CONTENT
              - generic: GOOGL
              - generic: +0.32%
              - generic: META
              - generic: −0.42%
              - generic: NFLX
              - generic: DIS
              - generic: T
              - generic: CONSUMER DISCRETIONAR
              - generic: INTERNET RETAIL
              - generic: AMZN
              - generic: −1.20%
              - generic: AUTO MANUFACT
              - generic: TSLA
              - generic: −1.57%
              - generic: HD
              - generic: −0.44%
              - generic: MCD
              - generic: +1.16%
              - generic: FINANCIALS
              - generic: BRK.B
              - generic: +0.77%
              - generic: BANKS - DIV
              - generic: JPM
              - generic: −1.17%
              - generic: BAC
              - generic: +0.66%
              - generic: WFC
              - generic: V
              - generic: −0.65%
              - generic: MA
              - generic: +1.38%
              - generic: HEALTH CAR
              - generic: LLY
              - generic: −0.96%
              - generic: UNH
              - generic: +1.10%
              - generic: JNJ
              - generic: +1.10%
              - generic: ABBV
              - generic: +1.58%
              - generic: MRK
              - generic: −1.46%
              - generic: CONSUMER S
              - generic: WMT
              - generic: −0.74%
              - generic: COST
              - generic: −0.82%
              - generic: PG
              - generic: +0.09%
              - generic: KO
              - generic: PEP
              - generic: XOM
              - generic: +0.66%
              - generic: CVX
              - generic: +1.11%
              - generic: GE
              - generic: CAT
              - generic: RTX
              - generic: BA
              - generic: LIN
              - generic: SO
              - generic: PLD
          - generic [ref=e167]:
            - generic [ref=e168]: −3%
            - generic [ref=e182]: +3%
            - generic [ref=e183]: · tile size = market cap
          - group [ref=e184]:
            - generic "View movers table" [ref=e185] [cursor=pointer]
          - paragraph [ref=e186]: Sized by market cap · colored by day % change
      - region "Watchlist charts" [ref=e187]:
        - generic [ref=e188]:
          - heading "Watchlist charts" [level=2] [ref=e189]
          - generic [ref=e190]: Demo
          - generic [ref=e191]: As of 2026-07-14
        - generic [ref=e192]:
          - generic [ref=e193]:
            - generic [ref=e194]:
              - combobox "Chart symbol — type any ticker" [ref=e195]: SPY
              - button "Load" [ref=e196] [cursor=pointer]
            - generic [ref=e197]:
              - generic [ref=e198]: PANE
              - group "Pane layout" [ref=e199]:
                - button "Split" [pressed] [ref=e200] [cursor=pointer]
                - button "Pro 1" [ref=e201] [cursor=pointer]
                - button "Pro 2" [ref=e202] [cursor=pointer]
                - button "Pro 3" [ref=e203] [cursor=pointer]
          - generic [ref=e204]:
            - navigation "Watchlist symbols" [ref=e205]:
              - button "SPY −0.39%" [ref=e206] [cursor=pointer]:
                - generic [ref=e207]: SPY
                - generic [ref=e208]: −0.39%
              - button "QQQ −0.86%" [ref=e209] [cursor=pointer]:
                - generic [ref=e210]: QQQ
                - generic [ref=e211]: −0.86%
              - button "DIA +0.75%" [ref=e212] [cursor=pointer]:
                - generic [ref=e213]: DIA
                - generic [ref=e214]: +0.75%
              - button "IWM +0.97%" [ref=e215] [cursor=pointer]:
                - generic [ref=e216]: IWM
                - generic [ref=e217]: +0.97%
              - button "SMH +0.51%" [ref=e218] [cursor=pointer]:
                - generic [ref=e219]: SMH
                - generic [ref=e220]: +0.51%
              - button "XLF +0.02%" [ref=e221] [cursor=pointer]:
                - generic [ref=e222]: XLF
                - generic [ref=e223]: +0.02%
              - button "XLE −0.57%" [ref=e224] [cursor=pointer]:
                - generic [ref=e225]: XLE
                - generic [ref=e226]: −0.57%
              - button "GLD +0.76%" [ref=e227] [cursor=pointer]:
                - generic [ref=e228]: GLD
                - generic [ref=e229]: +0.76%
              - button "TLT +0.46%" [ref=e230] [cursor=pointer]:
                - generic [ref=e231]: TLT
                - generic [ref=e232]: +0.46%
              - button "VXX −0.06%" [ref=e233] [cursor=pointer]:
                - generic [ref=e234]: VXX
                - generic [ref=e235]: −0.06%
            - generic [ref=e236]:
              - generic [ref=e237]:
                - generic [ref=e238]:
                  - generic [ref=e239]: PRO 1
                  - group "Pro 1 daily timeframe" [ref=e240]:
                    - button "1M" [ref=e241] [cursor=pointer]
                    - button "3M" [pressed] [ref=e242] [cursor=pointer]
                    - button "6M" [ref=e243] [cursor=pointer]
                    - button "YTD" [ref=e244] [cursor=pointer]
                    - button "1Y" [ref=e245] [cursor=pointer]
                    - button "All" [ref=e246] [cursor=pointer]
                  - button "Pro 1 chart settings" [ref=e247] [cursor=pointer]: ⚙
                - generic [ref=e248]:
                  - generic [ref=e249]: PRO 2
                  - group "Pro 2 weekly timeframe" [ref=e250]:
                    - button "6M" [ref=e251] [cursor=pointer]
                    - button "1Y" [ref=e252] [cursor=pointer]
                    - button "All" [pressed] [ref=e253] [cursor=pointer]
                  - button "Pro 2 chart settings" [ref=e254] [cursor=pointer]: ⚙
                - generic [ref=e255]:
                  - generic [ref=e256]: PRO 3
                  - group "Pro 3 day-trading window" [ref=e257]:
                    - button "5D" [ref=e258] [cursor=pointer]
                    - button "10D" [pressed] [ref=e259] [cursor=pointer]
                    - button "1M" [ref=e260] [cursor=pointer]
                  - button "Pro 3 chart settings" [ref=e261] [cursor=pointer]: ⚙
              - 'img "Three-pane workbench: Pro 1 daily, Pro 2 weekly, and Pro 3 day-trading charts with volume and 13-period stochastics, doctrine signal markers circled" [ref=e262]':
                - generic: PRO 1 · DAILY · SPY
                - generic: "580.00"
                - generic: "600.00"
                - generic: "620.00"
                - generic: "640.00"
                - generic: R3 645.55
                - generic: R1 611.15
                - generic: P 596.21
                - generic: S1 576.75
                - generic: VOL
                - generic: "20"
                - generic: "80"
                - generic: STOCH 13-3-3 · DAILY
                - generic: 2026-05
                - generic: 2026-07
                - generic: PRO 2 · WEEKLY · SPY
                - generic: "540.00"
                - generic: "560.00"
                - generic: "580.00"
                - generic: "600.00"
                - generic: "620.00"
                - generic: "640.00"
                - generic: VOL
                - generic: "20"
                - generic: "80"
                - generic: STOCH 13-3-3 · WEEKLY (13)
                - generic: 2025-04
                - generic: 2025-12
                - generic: PRO 3 · DAY TRADING · SPY EOD
                - generic: "580.00"
                - generic: "590.00"
                - generic: "600.00"
                - generic: "610.00"
                - generic: VOL
                - generic: "20"
                - generic: "80"
                - generic: STOCH 13-3-3 · DAILY (INTRADAY PENDING)
                - generic: 2026-07
          - paragraph [ref=e566]: Pro 1 (daily · short-term), Pro 2 (weekly · long-term), and Pro 3 (day trading — real 5-minute bars when the desk is unlocked live; EOD otherwise) per the stochastic-investing doctrine — ◯ marks bottom-crosses and top-rolls · drag a chart to pan
      - region "Equity curves" [ref=e567]:
        - generic [ref=e568]:
          - heading "Equity curves" [level=2] [ref=e569]
          - generic [ref=e570]: Locked
          - group "Timeframe" [ref=e572]:
            - button "1M" [ref=e573] [cursor=pointer]
            - button "3M" [ref=e574] [cursor=pointer]
            - button "6M" [pressed] [ref=e575] [cursor=pointer]
            - button "1Y" [ref=e576] [cursor=pointer]
        - paragraph [ref=e578]: Unlocks with the desk PIN.
    - complementary "Desk tools" [ref=e579]:
      - region "AI daily brief" [ref=e580]:
        - generic [ref=e581]:
          - heading "AI daily brief" [level=2] [ref=e582]
          - generic [ref=e583]: Locked
          - generic [ref=e584]: —
        - paragraph [ref=e586]: Unlocks with the desk PIN.
      - region "Ask the desk" [ref=e587]:
        - generic [ref=e588]:
          - heading "Ask the desk" [level=2] [ref=e589]
          - generic [ref=e590]: Locked
        - paragraph [ref=e592]: Unlocks with the desk PIN.
    - complementary "Market news" [ref=e593]:
      - region "News — holdings first" [ref=e594]:
        - generic [ref=e595]:
          - heading "News — holdings first" [level=2] [ref=e596]
          - generic [ref=e597]: Stale
        - generic [ref=e598]:
          - generic [ref=e599]:
            - generic [ref=e600]: 15:58
            - generic [ref=e601]:
              - paragraph [ref=e602]: S&P 500 ends higher as megacap tech extends rally
              - generic [ref=e603]:
                - generic [ref=e604]: Reuters
                - generic [ref=e605]:
                  - generic [ref=e606]: SPY
                  - generic [ref=e607]: +0.54%
          - generic [ref=e608]:
            - generic [ref=e609]: 15:41
            - generic [ref=e610]:
              - paragraph [ref=e611]: Nvidia supplier checks point to firm data-center demand
              - generic [ref=e612]:
                - generic [ref=e613]: Bloomberg
                - generic [ref=e614]:
                  - generic [ref=e615]: NVDA
                  - generic [ref=e616]: +1.84%
          - generic [ref=e617]:
            - generic [ref=e618]: 14:55
            - generic [ref=e619]:
              - paragraph [ref=e620]: Microsoft to detail AI capex plans at next earnings call
              - generic [ref=e621]:
                - generic [ref=e622]: CNBC
                - generic [ref=e623]:
                  - generic [ref=e624]: MSFT
                  - generic [ref=e625]: +0.92%
          - generic [ref=e626]:
            - generic [ref=e627]: 14:02
            - generic [ref=e628]:
              - paragraph [ref=e629]: Treasury yields edge up ahead of CPI report
              - generic [ref=e630]:
                - generic [ref=e631]: Reuters
                - generic [ref=e632]:
                  - generic [ref=e633]: TLT
                  - generic [ref=e634]: −0.65%
          - generic [ref=e635]:
            - generic [ref=e636]: 13:20
            - generic [ref=e637]:
              - paragraph [ref=e638]: Apple services growth seen slowing this quarter, analysts say
              - generic [ref=e639]:
                - generic [ref=e640]: Bloomberg
                - generic [ref=e641]:
                  - generic [ref=e642]: AAPL
                  - generic [ref=e643]: −0.34%
          - generic [ref=e644]:
            - generic [ref=e645]: 11:47
            - generic [ref=e646]:
              - paragraph [ref=e647]: Small caps lag as rate-cut bets get pushed out
              - generic [ref=e648]:
                - generic [ref=e649]: Reuters
                - generic [ref=e650]:
                  - generic [ref=e651]: IWM
                  - generic [ref=e652]: −0.41%
          - generic [ref=e653]:
            - generic [ref=e654]: 10:15
            - generic [ref=e655]:
              - paragraph [ref=e656]: Amazon Prime Day sales tracking ahead of last year
              - generic [ref=e657]:
                - generic [ref=e658]: CNBC
                - generic [ref=e659]:
                  - generic [ref=e660]: AMZN
                  - generic [ref=e661]: +1.12%
          - generic [ref=e662]:
            - generic [ref=e663]: 09:36
            - generic [ref=e664]:
              - paragraph [ref=e665]: Volatility drifts lower; VIX under 15 for third session
              - generic [ref=e666]:
                - generic [ref=e667]: Bloomberg
                - generic [ref=e668]:
                  - generic [ref=e669]: VIX
                  - generic [ref=e670]: −4.20%
  - contentinfo [ref=e671]:
    - paragraph [ref=e672]: "Data: IBKR Flex reports (accounts) · market and news snapshots committed by scheduled jobs. Every panel shows its own as-of stamp — this dashboard renders snapshots, not live quotes."
    - paragraph [ref=e673]: Nothing here is investment, tax, or legal advice. Past performance is not a guarantee of future results.
```

# Test source

```ts
  136 |   }
  137 | 
  138 |   return 'none'; // no auth gate detected
  139 | }
  140 | 
  141 | // Detection-only: is there a real auth gate (PIN keypad or password field)? Does NOT
  142 | // interact, and deliberately ignores plain text inputs (a search/filter box is not an
  143 | // auth gate). Used to decide whether to skip/auth without firing spurious login attempts.
  144 | async function detectAuthGate(page) {
  145 |   await page.locator('[class*="keypad"], [class*="pin"], input[type="password"]')
  146 |     .first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  147 |   const hasNumericButtons = await page.locator('button').filter({ hasText: /^[0-9]$/ }).count();
  148 |   const hasDotIndicator   = await page.locator('[class*="dot"], [class*="pin"]').count();
  149 |   if (hasNumericButtons >= 9 && hasDotIndicator > 0) return true;
  150 |   if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) return true;
  151 |   // Text/access-code gate (detectAndAuth's text-input path): a SINGLE visible text input
  152 |   // on a sparse, login-like page — gated on auth-ish context so an arbitrary search/filter
  153 |   // box on a content-rich page is NOT treated as auth.
  154 |   return await page.evaluate(() => {
  155 |     const inputs = [...document.querySelectorAll('input[type=text], input:not([type])')]
  156 |       .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  157 |     if (inputs.length !== 1) return false;
  158 |     const el = inputs[0];
  159 |     const ctx = [el.placeholder, el.getAttribute('aria-label'), el.name, el.id,
  160 |                  document.body.innerText?.slice(0, 300)].join(' ').toLowerCase();
  161 |     const looksAuth = /\b(pin|passcode|access\s*code|access|log\s*in|login|sign\s*in|unlock|enter\s*code|password)\b/.test(ctx);
  162 |     const controls = document.querySelectorAll('button, [role=button], a[href], select, textarea').length;
  163 |     return looksAuth && controls <= 4;
  164 |   });
  165 | }
  166 | 
  167 | // ─────────────────────────────────────────────────────────────────────────────
  168 | // INTERACTIVE ELEMENT DISCOVERY
  169 | // ─────────────────────────────────────────────────────────────────────────────
  170 | async function discoverElements(page) {
  171 |   return page.evaluate(() => {
  172 |     const selectors = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
  173 |                        '[role=button]', '[onclick]'];
  174 |     return selectors.flatMap(sel =>
  175 |       [...document.querySelectorAll(sel)]
  176 |         // Index BEFORE filtering: page.locator(sel).nth(i) counts every DOM match,
  177 |         // hidden included, so the recorded index must count them too.
  178 |         .map((el, index) => ({ el, index }))
  179 |         .filter(({ el }) => {
  180 |           const r = el.getBoundingClientRect();
  181 |           return r.width > 0 && r.height > 0;
  182 |         })
  183 |         .map(({ el, index }) => ({
  184 |           selector: sel,
  185 |           index,
  186 |           tag: el.tagName.toLowerCase(),
  187 |           type: el.getAttribute('type') ?? null,
  188 |           label: (el.textContent?.trim().slice(0, 60) ||
  189 |                   el.getAttribute('aria-label') ||
  190 |                   el.getAttribute('placeholder') ||
  191 |                   el.getAttribute('name') ||
  192 |                   el.id || '').slice(0, 60),
  193 |           id: el.id || null,
  194 |         }))
  195 |     );
  196 |   });
  197 | }
  198 | 
  199 | // ─────────────────────────────────────────────────────────────────────────────
  200 | // TEST FILL VALUE — infer plausible value from element context
  201 | // ─────────────────────────────────────────────────────────────────────────────
  202 | function testValueFor(el) {
  203 |   const label = (el.label + (el.type ?? '')).toLowerCase();
  204 |   if (/email/.test(label))         return 'test@example.com';
  205 |   if (/date/.test(label))          return new Date().toISOString().split('T')[0];
  206 |   if (/number|qty|amount|count/.test(label)) return '42';
  207 |   if (/phone|tel/.test(label))     return '5551234567';
  208 |   if (/url|link/.test(label))      return 'https://example.com';
  209 |   return 'Test input';
  210 | }
  211 | 
  212 | // ─────────────────────────────────────────────────────────────────────────────
  213 | // SCENARIO 1 — Page Load
  214 | // ─────────────────────────────────────────────────────────────────────────────
  215 | test('S1: page loads without JS errors', async ({ page }) => {
  216 |   const errors = [];
  217 |   page.on('pageerror', e => errors.push(e.message));
  218 |   // Allowlist (spec Clarifications #7, Group C): failed fetches to the live
  219 |   // feed origin log browser console errors we can't suppress from JS
  220 |   // ("Failed to load resource … functions/v1/desk-*"). The app handles those
  221 |   // failures by design (keeps last good render, lamps Stale) — S14 covers
  222 |   // feed health. Everything else still fails S1. Narrow on purpose: origin
  223 |   // substring only, never a blanket console mute.
  224 |   // Network-layer console errors carry the URL in location(), not text().
  225 |   const FEED_ORIGIN = '.supabase.co/functions/v1/';
  226 |   page.on('console', m => {
  227 |     if (m.type() !== 'error') return;
  228 |     const at = (m.location() && m.location().url) || '';
  229 |     if (m.text().includes(FEED_ORIGIN) || at.includes(FEED_ORIGIN)) return;
  230 |     errors.push(`${m.text()} (${at || 'no url'})`);
  231 |   });
  232 |   await page.goto('./');
  233 |   await page.waitForLoadState('networkidle').catch(() => {});
  234 |   const bodyText = await page.evaluate(() => document.body.innerText?.trim());
  235 |   expect(bodyText?.length, 'Page body is empty').toBeGreaterThan(0);
> 236 |   expect(errors, `JS errors on load: ${errors.join('; ')}`).toHaveLength(0);
      |                                                             ^ Error: JS errors on load: Failed to load resource: net::ERR_CONNECTION_RESET (https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap)
  237 | });
  238 | 
  239 | // ─────────────────────────────────────────────────────────────────────────────
  240 | // SCENARIO 2 — Auth Discovery & Login (with API diagnostics)
  241 | // ─────────────────────────────────────────────────────────────────────────────
  242 | test('S2: auth gate discovered and credential accepted', async ({ page }) => {
  243 |   if (!AUTH_CREDENTIAL) test.skip(true, 'No auth credential found in CLAUDE.md or TEST_AUTH_CREDENTIAL env var — skipping auth test');
  244 |   const consoleErrors = [];
  245 |   page.on('pageerror', e => consoleErrors.push(e.message));
  246 |   page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  247 | 
  248 |   const getApiCalls = await captureApiCalls(page);
  249 |   await page.goto('./');
  250 |   await page.waitForLoadState('networkidle').catch(() => {});
  251 | 
  252 |   const beforeSnap = await domSnapshot(page);
  253 |   // Gate the auth attempt on detectAuthGate() — same as S4 and gotoAndAuth. Unguarded,
  254 |   // detectAndAuth's text-input fallback would type the credential into the first visible
  255 |   // text input (e.g. a public app's search box) and then falsely report auth failure.
  256 |   const mechanism  = (await detectAuthGate(page))
  257 |     ? await detectAndAuth(page, AUTH_CREDENTIAL ?? '')
  258 |     : 'none';
  259 |   const afterSnap  = await domSnapshot(page);
  260 | 
  261 |   const domChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);
  262 |   // A wrong credential often renders an inline error, which itself changes the DOM —
  263 |   // so domChanged alone is not proof of success. Treat a non-empty on-screen error as a
  264 |   // failure even when the DOM changed. Read the first VISIBLE, non-empty error element:
  265 |   // apps often keep hidden/empty `.error` placeholders, so `.first().textContent()` could
  266 |   // read the wrong node. Synchronous evaluate — no locator waiting, so it can't burn the
  267 |   // test timeout either.
  268 |   const onscreenError = await page.evaluate(() => {
  269 |     const els = [...document.querySelectorAll('[id*="err"], [class*="err"], [class*="error"]')]
  270 |       .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  271 |     for (const el of els) { const t = (el.textContent || '').trim(); if (t) return t; }
  272 |     return '';
  273 |   });
  274 | 
  275 |   if (mechanism !== 'none' && (!domChanged || onscreenError.length > 0)) {
  276 |     const apiCalls = await getApiCalls();
  277 |     const errText  = onscreenError;
  278 |     const firstKey = apiCalls[0]?.firstFieldKey ?? null;
  279 |     const diag = {
  280 |       mechanism,
  281 |       credentialProvided: AUTH_CREDENTIAL ? 'yes' : 'none — check CLAUDE.md',
  282 |       onscreenError: errText,
  283 |       consoleErrors,
  284 |       apiCalls,
  285 |       responseShape: firstKey
  286 |         ? `rows returned, first field "${firstKey}"`
  287 |         : (apiCalls[0]?.status >= 400 ? `non-2xx (${apiCalls[0]?.status})` : 'no rows returned — check query / RLS / auth'),
  288 |     };
  289 |     test.info().attach('auth-diagnostics', {
  290 |       body: JSON.stringify(diag, null, 2),
  291 |       contentType: 'application/json',
  292 |     });
  293 |     throw new Error(
  294 |       `S2 FAIL | mechanism: ${mechanism} | onscreenError: "${errText}" | ` +
  295 |       `API status: ${apiCalls[0]?.status ?? 'no call'} | ` +
  296 |       `recordCount: ${apiCalls[0]?.recordCount ?? 'n/a'} | ` +
  297 |       `responseShape: ${diag.responseShape} | ` +
  298 |       `consoleErrors: ${consoleErrors.join('; ') || 'none'}`
  299 |     );
  300 |   }
  301 | 
  302 |   // Auth passed or no auth required — record mechanism
  303 |   test.info().attach('auth-result', {
  304 |     body: JSON.stringify({ mechanism, domChanged }),
  305 |     contentType: 'application/json',
  306 |   });
  307 | });
  308 | 
  309 | // ─────────────────────────────────────────────────────────────────────────────
  310 | // SCENARIO 3 — Element Mapping & Interaction Sweep
  311 | // ─────────────────────────────────────────────────────────────────────────────
  312 | test('S3: interactive elements discovered and exercised without errors', async ({ page }) => {
  313 |   // The sweep scales with element count (settle + capped idle wait per
  314 |   // element) and cannot fit the 30s global timeout on element-rich apps or
  315 |   // mobile-emulated projects. 480s covers ~80 elements at the worst-case
  316 |   // per-element cost; the idle wait below is capped so one slow-settling
  317 |   // page can't eat the whole budget.
  318 |   test.setTimeout(480_000);
  319 |   // Public-first apps (knowledge hub, questionnaire) are swept even with no credential;
  320 |   // only auth-gated apps with no credential are skipped (decided after page load below).
  321 |   const consoleErrors = [];
  322 |   const apiAnomalies  = [];
  323 |   page.on('pageerror', e => consoleErrors.push(e.message));
  324 |   page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  325 | 
  326 |   const getApiCalls = await captureApiCalls(page);
  327 |   await page.goto('./');
  328 |   await page.waitForLoadState('networkidle').catch(() => {});
  329 |   // Authenticate if we have a credential; if there's a real auth gate but no credential,
  330 |   // skip — sweeping the login screen would fire spurious PIN/password attempts and 401/403s
  331 |   // don't block, so the job could "pass" without reaching app content. A public app with
  332 |   // no gate falls through and is swept normally.
  333 |   if (AUTH_CREDENTIAL) {
  334 |     await detectAndAuth(page, AUTH_CREDENTIAL);
  335 |     await page.waitForLoadState('networkidle').catch(() => {});
  336 |   } else if (await detectAuthGate(page)) {
```