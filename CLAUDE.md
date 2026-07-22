# CLAUDE.md — claude.trading

## Imported Directives
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/global.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/git.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/design.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/test.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/data.md

---

## Project Overview
- **Project name:** claude.trading — multi-account trading dashboard
- **Live URL:** https://akyachtsman.github.io/claude.trading/
- **Stack:** Static tier — plain HTML + CSS + vanilla JS on GitHub Pages (no
  build), confirmed. Dynamic data arrives two ways: public JSON committed by a
  scheduled pipeline, and (when live mode is enabled) private data behind
  PIN-validated Supabase RPCs.
- **Branch policy:** Develop on a `claude/<name>` feature branch; PRs target `main`

## Design
This project's look is its own — established at kickoff via `/design-intake`
(per `directives/design.md`), not a shared company theme. It lives in:
- `styles/tokens.css` — brand primitives (color, type, spacing, radius, shadow)
- `styles/components.css` — reusable components
- **Reference page:** `index.html` on demo data (see `specs/multi-account-trading-dashboard/design.md` — "Daylight desk ledger")

## Application Architecture
- `index.html` — markup only + 3 script tags; all render-blocking assets share
  ONE `?v=` cache-bust token (bump them together on every asset change).
- `scripts/config.js` — account roster (`DESK_ACCOUNTS`) + backend endpoints
  (`DESK_DB`). **Empty `DESK_DB.url` ⇒ the whole site runs in DEMO mode.**
  Current state: **LIVE** on the dedicated Supabase project ("trading
  dashboard", `kwugzhyfjevzwgplhtsd`, wired in PR #19) — RLS tables +
  SECURITY DEFINER PIN RPCs + the edge-function data layer below.
  Demo remains reachable via `?demo=1`.
- `scripts/data.js` — formatters, seeded demo generator, trading-day calendar,
  mode resolution, `deskFeed()` live-feed wrapper, `marketSessionOpen()`,
  two-tier `liveLampFor` staleness lamps; every panel stamp renders one uniform
  terse format via `fmtUpdated` — `Updated {time} · {Mon D}` (clock dropped when
  only a trading-day as-of exists), Supabase RPC fetch wrappers.
  `buildDemoMarkets()` seeds the Markets window's normalized %-change series —
  a detrended random walk per index (S&P/Nasdaq/Russell/Dow) per timeframe,
  pinned to 0 at the start and the index's end-% at the right edge.
- `scripts/app.js` — all rendering + interactions (accounts with per-card
  equity sparklines, brief with FR-AI4 staleness, news, ask-the-desk panel,
  the Markets window, stochastic charts workbench, PIN lock/unlock flow) + the
  session-aware feed poller (5 min market-open / 60 min closed, paused
  while the tab is hidden). The **Markets window** (`renderMarkets()` +
  `drawMktChart()` + `mktSecTint()`, owner request 2026-07-20) is a compact
  trading-app-style panel beside Ask-the-desk: region tabs (U.S. live; Europe/
  Asia/FX disabled placeholders), four index tiles (S&P 500 / Nasdaq 100 /
  Russell 2000 / Dow Jones — day-% + last, read from the shared `desk-market`
  feed by tile name), a normalized multi-index %-change SVG chart with
  Today/5D/1M/1Y/2Y timeframe toggles (series demo-generated or live via the
  index ETF proxies SPY/QQQ/IWM/DIA), and an 11-cell **Performance by Sector**
  grid (SPDR sector ETFs XLK…XLRE, heatmap-tinted by day-%). Carries its own
  `#mktLamp` data-state lamp + `#mktStamp` as-of stamp like every panel.
- `config/news-feeds.json` / `config/chart-watchlist.json` /
  `config/map-filters.json` — owner-editable rosters read by the edge
  functions at runtime (watchlist NEVER derived from holdings — public repo).
- `config/widgets.json` — owner-editable roster of embedded third-party
  widgets from TWO providers — **TradingView** (economic calendar) and **FRED**
  (`fred-glance` = the St. Louis Fed "Economy at a glance" widget). Each is
  rendered by `loadWidgets()` as a bare sandboxed **cross-origin** iframe
  (`widgetFrameSrc` builds a `tradingview-widget.com` URL for TV widgets, or the
  provider URL for `fred-glance` — `spec.src` overrides for a configure-generated
  FRED set). (The TradingView **ticker tape** — the former `slot:'strip'` widget
  — was removed 2026-07-16; its symbols became half-size market-strip tiles fed
  by `desk-market`, owner ruling.) Widgets render — panel-less, captionless — in
  the compact left-packed **`#acctWidgets` row inside the Accounts section**,
  directly under the account cards, sized by per-spec `width`/`height`
  (both 245×305 — matched to the half-width account cards they stack under,
  owner ruling 2026-07-16; the two former widget panels were removed the same
  day). Everything third-party is above the fold now, so
  ALL frames hydrate on **first user interaction** (a scroll-observer would
  run vendor JS on paint and trip the S1 gate). One shared static stamp under
  the row ("TradingView + FRED · live · sandboxed from the desk") replaces the
  former per-panel lamps; CSS hides row + stamp when nothing renders. Read
  CLIENT-side (`fetchPublic`), not by an edge function. Mode-independent (live
  external data in demo + live).
- `supabase/functions/` — versioned sources of the edge-function data layer
  (deployed only to the dedicated project). Anon-callable public feeds:
  `desk-market` (Stooq→Yahoo tiles + FRED 10Y for the core 6, plus
  Bitcoin/Gold/US Dollar as **best-effort** extras — a flaky extra drops only
  its tile, never gating the core; owner request 2026-07-16), `desk-heatmap` (Nasdaq
  screener→Yahoo), `desk-charts` (watchlist OHLC), `desk-news`
  (holdings-first RSS), `desk-maps` (Crypto/Futures/World cuts) — all
  session-aware cached + single-flight. PIN-gated: `desk-ask` — an **agentic**
  desk assistant (not plain Q&A): replays prior exchanges from `desk_chat_memory`
  (≤20 turns / ≤30d / ~8k-char budget), runs a bounded tool loop (≤6 calls,
  ≤3 pause resumes) with `web_search`/`web_fetch` + a `get_quote` tool that calls
  `quote-proxy kind:'info'` server-side, gives **directional** views on the
  owner's positions (owner opt-in 2026-07-21; the "not financial advice" label
  stays), attributes provenance, and appends each exchange back to memory. The
  conversation table `desk_chat_memory` (`desk_008`, RLS deny-all) is reachable
  only via the service-key `desk-ask` path or the PIN RPCs `desk_chat_history` /
  `desk_chat_clear`. **Residual:** web-query privacy (never sending real position
  sizes to search) is system-prompt-enforced, not hard-filtered.
  Origin-guarded anon: `quote-proxy` (OHLC for any ticker — no PIN, restricted
  to the site origin + in-memory cache; owner ruling 2026-07-14, paid plan).
  `kind:'info'` also returns a per-symbol live-quote line (last / day change /
  bid / ask) plus fundamentals (next earnings date + market cap / P/E /
  52-week range / dividend yield) from Yahoo v7/quote via a cached cookie+crumb
  handshake — powers the charts panel's quote readout + fundamentals strip
  (bid/ask are market-hours-only; Yahoo returns 0 when closed).
  Cron-secret-gated: `desk-ibkr-sync`
  (Flex → tables), `desk-brief` (Opus brief with the FR-AI4 grounding
  guard). Scheduled by pg_cron (`desk_005` migration): sync 22:35/09:35,
  brief 23:05/10:05 UTC — dual-slot because IBKR statements roll overnight.
- `.github/workflows/keepalive.yml` — monthly empty commit; **the only
  writer resetting GitHub's 60-day Actions scheduler clock** now that the
  nightly pipeline is retired (PRs #54/#55/#56, 2026-07-13).
- `specs/multi-account-trading-dashboard/` — the SDD artifact chain
  (brief/spec/plan/tasks/design/analysis).

## Required Commands
| Purpose | Command |
|---|---|
| Validate HTML | `npx html-validate index.html` |
| Contrast gate (WCAG AA) | `node .github/scripts/check-contrast.js` |
| Validate workflow YAML | `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/qa.yml'))"` |

## Project-Specific Security Constraints
- **Dedicated Supabase project ONLY** (owner ruling, 2026-07-10; see
  `learnings.jsonl`): never place desk tables/RPCs/functions in any existing
  project. If no slot exists, stop and ask the owner. Any resource decision
  outside this repo needs explicit owner approval first.
- The Supabase **anon key is public by design**; RLS default-deny + SECURITY
  DEFINER PIN RPCs are the enforcement boundary (data.md pattern).
- **Accepted residuals (live mode):** the PIN space is brute-forceable through
  the RPC (RLS cannot rate-limit); the PIN sits in sessionStorage for the tab
  session. Real balances never enter this repo or the served files. The five
  public feed functions are anon-callable by design (public market data,
  rosters fixed server-side / in committed config — not open proxies);
  unauthenticated invocations can burn free-tier quota, bounded by
  session-aware caches + single-flight. `quote-proxy` (owner ruling
  2026-07-14) takes an **arbitrary** ticker, so it is not roster-bounded like
  the five feeds; its guard is an **Origin allowlist** (site origin only) plus
  an in-memory cache — browser-enforced and unspoofable from page JS, but a
  non-browser client can forge the Origin header, so this is an abuse
  speed-bump on the paid plan's egress IP, not a hard auth wall. `desk-news`
  holds the service key to
  read held tickers for ranking, but only public headlines and Stooq day-%
  ever leave it — payload byte-shape-identical to the formerly-committed
  public news.json. `desk-heatmap` holds it too, solely for the
  `desk_feed_cache` table (`desk_006`, RLS deny-all) that persists its daily
  multi-period sweep — public market percentages only.
- **Third-party widget embeds (owner request 2026-07-15; panels removed in
  favour of the accounts-row layout 2026-07-16):** the desk embeds TradingView
  widgets — the one place it runs vendor JS. Each widget is a **direct cross-origin iframe** on
  `tradingview-widget.com` (NOT a `srcdoc` doc — a srcdoc frame inherits the
  PARENT origin, so `allow-same-origin` there would put the vendor script
  same-origin with the desk and expose `sessionStorage`/the PIN; this was
  caught in PR #72 review and fixed). A real cross-origin `src` gives the frame
  TradingView's own origin, so the browser same-origin policy walls it off from
  the desk — it cannot read the page DOM, the PIN, or account data. The
  `sandbox` (`allow-scripts allow-same-origin allow-popups ...`) is
  defence-in-depth; `allow-same-origin` there refers to TradingView's origin,
  not the desk's. The frame also carries a tight Permissions-Policy
  `allow="accelerometer; gyroscope; magnetometer"` — motion sensors ONLY (the
  set TradingView's own official embed grants), deliberately NOT camera/
  microphone/geolocation/clipboard/payment, and scoped to the frame's own vendor
  origin. Historical note: the grant reaches only the DIRECT vendor frame — the
  now-removed **ticker tape**'s accelerometer probe fired inside a TradingView
  **nested sub-frame** the outer `allow` couldn't propagate into, so hydrate
  logged one benign `accelerometer is not allowed` violation (PR #78). With the
  ticker gone (2026-07-16) that warning no longer fires; the tightly-scoped
  **S3** accelerometer allowlist (exact-string match only; every other console
  error still fails) is now dormant but retained in case a future TV widget
  probes the same sensor — NOT to be widened, and never widen S1. **FRED (`fred-glance`, owner request 2026-07-15) is a SECOND
  embed provider on the same footing** — a direct cross-origin iframe on
  `research.stlouisfed.org` (self-contained, no parent-page vendor script),
  sandboxed identically; `allow-same-origin` there refers to FRED's origin.
  Every widget frame (the accounts-row calendar/FRED) sits
  **above the fold**, so all loads defer to the **first user interaction**
  (pointer/scroll/key/touch, PR #76 pattern) — S1's load-time check never
  interacts, so nothing third-party runs on initial paint and the S1 console
  gate stays clean (do NOT widen the S1 allowlist for widget origins; the
  deferred hydration is the containment). Residual:
  each vendor sees the viewer's IP/UA and sets its own cookies in its own frame;
  no desk data crosses the boundary. Roster is owner-controlled
  (`config/widgets.json`).
- Server-side keys (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, IBKR
  token/query-id, `CRON_SECRET`) live only in edge-function secrets;
  `cron_secret`/`anon_key` also sit in Vault for pg_cron header assembly —
  never client-side, never committed. GitHub keeps only `KEEPALIVE_PAT` +
  `TEST_AUTH_CREDENTIAL`.
- **Supabase free-tier auto-pause runbook:** if live panels lamp STALE and
  login fails, the project likely auto-paused — restore it from the Supabase
  dashboard. Early-warning signals: the S14 canary failing in CI and
  `cron.job_run_details` gaps. The IBKR Flex token expires **2027-06-14**
  (renew in Client Portal → update the `IBKR_FLEX_TOKEN` function secret).

## Project-Specific Coding Standards
- Price-change percentages use **2 decimals** (finance convention) — a
  deliberate exception to the editorial whole-number rule; allocation-style
  percentages stay whole.
- All dynamic DOM text via `textContent` — never `innerHTML`.
- Series colors/order are CVD-validated (`--color-series-1..3`): do not reorder.
- Gain/loss colors are P&L-only, never decorative.
- Every panel carries a data-state lamp + as-of stamp (the design signature);
  new panels must too.

## Agent Workflow
1. Use a `claude/<name>` feature branch
2. For a non-trivial feature, run `/sdd-loop` (`specify` → `clarify` → `plan` → `tasks`) before coding — separate WHAT from HOW; trivial changes skip to step 3
3. Implement changes per the Application Architecture map above — or `/sdd-loop analyze` then `/sdd-loop implement` to check consistency and work the task list
4. Run Required Commands above — all must pass
5. Prefer `qa-pipeline`; run steps individually only if it fails:
   `test-verifier` → `pr-review-toolkit:code-reviewer` → `/security-review` (if security-relevant) → `pr-readiness-reviewer`
6. Open PR to `main`; merging follows the inherited rules in
   `directives/git.md` (*PR Lifecycle*, *Conditional Auto-Merge on Green*,
   *Repo-settings preflight*) — do not restate them here.

## UI Test Configuration
Read by `ui-tester` and the Playwright kit at runtime — fill in before invoking agents:
| Key | Value |
|---|---|
| App URL | `https://akyachtsman.github.io/claude.trading/` (demo state: append `?demo=1` for deterministic data) |
| Valid test credential | repo secret `TEST_AUTH_CREDENTIAL` (name only — never commit the value; set — S10 exercises the live unlock path in CI) |
| Invalid test credential | `000000` |
| Primary nav button | `Load` (charts-workbench symbol loader) |
| Primary content selector | `.account .hero-number` |
| Nav cards | n/a — single-page dashboard (panels: Accounts, Markets, Heatmap, Stochastic charts, AI daily brief, Ask the desk, News) |
| Playwright test directory | `.github/scripts/ui-tests` |
| Key selectors | lock form: `.lock-form input.input` + button `Unlock` · error: `.lock-error` · lamps: `#briefLamp #newsLamp #askLamp #mktLamp` · chart: `#wbChart` · Markets chart: `#mktChart` · news rows: `.news-row` |

## Project-Specific Test Scenarios
Authoritative list of coverage beyond the generic S1–S4 suite — one
`app.spec.js` scenario per row, numbered from S5. Live-gated rows skip
cleanly while `DESK_DB` is empty; with the desk LIVE (current state) S10/S11
run for real against the dedicated project on every PR.
| # | Feature | What to verify | Failure indicator |
|---|---|---|---|
| S5 | Demo lamps | With `?demo=1`, masthead shows "Demo data" and every panel lamp (brief, news, ask) reads Demo | Any lamp shows LIVE/EOD/LOCKED in demo |
| S6 | Positions sort | Clicking a positions header sorts rows and flips `aria-sort`; first-row value order changes accordingly | Order/aria-sort unchanged after click |
| S9 | Brief structure | Demo brief renders Portfolio state / Key levels / Scenarios sections + disclaimer + stamp | Missing section or missing disclaimer |
| S10 | Locked → login → render (live only) | With a backend configured + `TEST_AUTH_CREDENTIAL`: locked shells pre-auth, valid PIN renders accounts + brief | Skips while demo-only; fails if unlock doesn't render |
| S12 | Charts workbench | With `?demo=1`, `#wbChart` renders all three pane captions (Pro 1 swing / Pro 2 long-term / Pro 3 day-trading EOD) with candles + 6 stochastic paths; zoom segs and symbol select redraw; PANE seg maximizes a tier; settings popover opens with per-pane chart-style radios + indicator/SMA/S-R checkboxes | Missing pane, empty SVG, dead controls, or popover missing controls |
| S11 | Wrong-PIN error (live only) | Invalid PIN shows `.lock-error` text, stays locked, no data leaks | Skips while demo-only; fails if error absent or data renders |
| S13 | Heatmap map filter | With `?demo=1`, the MAP FILTER bar cuts the treemap (Dow 30 shrinks tile count, ETFs re-source from charts data and unlock the period dropdown); Themes regroups the S&P dataset; live-fed universes (World/Crypto/Futures — `desk-maps`; Russell 2000 — `desk-heatmap` r2k universe) render disabled in demo. Live mode additionally unlocks 1W/1M/YTD on stock cuts once the feed's daily 1y period sweep lands (tiles carry `pctW/pctM/pctYtd`) | Cut doesn't re-render, period gating wrong, or disabled rows clickable |
| S14 | Live-feed canary (live only) | Masthead lamp reads LIVE with an "Updated" stamp < 6 min — proves the edge-function feed layer end-to-end (there is no snapshot fallback anymore); skips while demo-only. Note: S1 and S3 allowlist errors from the feed origin ONLY (`.supabase.co/functions/v1/`) — the app handles feed failures by design (panels lamp STALE); S14 is where feed health fails loudly | Lamp STALE/missing on a healthy backend, or the S1/S3 allowlist widened beyond the feed origin |
| S15 | Assistant memory (opt-in, live) | With `RUN_ASSISTANT_TESTS=1` + live backend: ask, reload, prior exchange replays from `desk_chat_memory` (transcript contains the earlier text) | Transcript empty after reload despite a stored exchange |
| S16 | Assistant research (opt-in, live) | A snapshot-absent question renders an answer (web tools available) | No answer bubble renders |
| S17 | Assistant live data (opt-in, live) | An off-page ticker returns an answer (the `get_quote` path) | No answer bubble renders |
| S18 | Assistant advice posture (opt-in, live) | A buy/sell/hold question returns an answer, NOT `.lock-error`; the "not financial advice" disclaimer stays | A refusal error, or the disclaimer missing |
| S19 | Assistant clear (opt-in, live) | The Clear control (confirmed) empties `.ask-thread` | Thread still shows exchanges after clear |

**S15–S19 are OPT-IN** (gated on `RUN_ASSISTANT_TESTS` on top of the live+auth
gates) — each makes a real `desk-ask` Claude tool-loop call (slow, nondeterministic,
costs quota), so they never run in normal CI; run them on demand.

## Owner Communication Preferences
- **Explanations of how things work (data flows, architecture, processes):
  lead with a simple table** — one row per component, plain-language columns
  (what / where it comes from / when it updates / how it reaches the user) —
  followed by at most two takeaway sentences. No jargon in the cells;
  mechanism detail only if asked. (Owner preference, 2026-07-13.)
- **Never silently shrink an expected scope.** When a feature has an obvious
  reference (finviz map = ALL ~2000 names), build the full expected thing or
  surface the trade-off BEFORE shipping and let the owner choose. A caption
  disclosing the cut is not consent. (Owner ruling, 2026-07-14.)
- **Aesthetic/sizing changes: one decisive change; mock ONLY on request.**
  Make one decisive larger adjustment rather than pixel-nudging increments
  across many rounds, and ship it — do NOT produce a mock first unless the
  owner explicitly asks for one (owner update 2026-07-16, superseding the
  2026-07-15 mock-first rule). Corollary: vendor widget iframes render blank
  in the sandbox, so measure sizes from the owner's screenshots, not a local
  render.

## Reporting Requirements
Agents write evidence to `.agent-reports/`:
- `implementation-summary.md`, `test-report.md`, `ui-test-report.md`
- `playwright-results.json`, `screenshots/` (on failure)
- `code-review-report.md`, `test-coverage-report.md`, `security-review-report.md`, `pr-readiness-report.md`

## Safety Rules for Agents
- Reviewer agents must not edit code unless explicitly instructed.
- Test commands must not require production credentials.
- Destructive commands, data resets, migrations, or deploys require explicit approval.
- If a check can't run locally, explain why and name the closest substitute.

## Session Start
1. Read all Imported Directive URLs above fully
2. Verify the directives-toolkit plugin attached (commands/agents resolve) per global.md → Skill Bootstrap
3. Confirm active branch: `git branch --show-current`
4. Run `/env-chk` and report status
