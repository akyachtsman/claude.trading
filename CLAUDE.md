# CLAUDE.md — claude.trading

## Imported Directives
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/global.md
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
  two-tier `liveLampFor` staleness lamps, Supabase RPC fetch wrappers.
- `scripts/app.js` — all rendering + interactions (accounts, chart, brief with
  FR-AI4 staleness, news, ask-the-desk panel, PIN lock/unlock flow) + the
  session-aware feed poller (5 min market-open / 60 min closed, paused
  while the tab is hidden).
- `config/news-feeds.json` / `config/chart-watchlist.json` /
  `config/map-filters.json` — owner-editable rosters read by the edge
  functions at runtime (watchlist NEVER derived from holdings — public repo).
- `supabase/functions/` — versioned sources of the edge-function data layer
  (deployed only to the dedicated project). Anon-callable public feeds:
  `desk-market` (Stooq→Yahoo tiles + FRED 10Y), `desk-heatmap` (Nasdaq
  screener→Yahoo), `desk-charts` (watchlist OHLC), `desk-news`
  (holdings-first RSS), `desk-maps` (Crypto/Futures/World cuts) — all
  session-aware cached + single-flight. PIN-gated: `desk-ask` (Claude Q&A),
  `quote-proxy` (OHLC for any ticker). Cron-secret-gated: `desk-ibkr-sync`
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
  session-aware caches + single-flight. `desk-news` holds the service key to
  read held tickers for ranking, but only public headlines and Stooq day-%
  ever leave it — payload byte-shape-identical to the formerly-committed
  public news.json.
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
6. Open PR to `main`

## UI Test Configuration
Read by `ui-tester` and the Playwright kit at runtime — fill in before invoking agents:
| Key | Value |
|---|---|
| App URL | `https://akyachtsman.github.io/claude.trading/` (demo state: append `?demo=1` for deterministic data) |
| Valid test credential | repo secret `TEST_AUTH_CREDENTIAL` (name only — never commit the value; set — S10 exercises the live unlock path in CI) |
| Invalid test credential | `000000` |
| Primary nav button | `Consolidate accounts` |
| Primary content selector | `.account .hero-number` |
| Nav cards | n/a — single-page dashboard (panels: Accounts, Equity curves, AI daily brief, Ask the desk, News) |
| Playwright test directory | `.github/scripts/ui-tests` |
| Key selectors | lock form: `.lock-form input.input` + button `Unlock` · error: `.lock-error` · lamps: `#equityLamp #briefLamp #newsLamp #askLamp` · chart: `#equityChart` · news rows: `.news-row` |

## Project-Specific Test Scenarios
Authoritative list of coverage beyond the generic S1–S4 suite — one
`app.spec.js` scenario per row, numbered from S5. Live-gated rows skip
cleanly while `DESK_DB` is empty; with the desk LIVE (current state) S10/S11
run for real against the dedicated project on every PR.
| # | Feature | What to verify | Failure indicator |
|---|---|---|---|
| S5 | Demo lamps | With `?demo=1`, masthead shows "Demo data" and every panel lamp (equity, brief, news, ask) reads Demo | Any lamp shows LIVE/EOD/LOCKED in demo |
| S6 | Positions sort | Clicking a positions header sorts rows and flips `aria-sort`; first-row value order changes accordingly | Order/aria-sort unchanged after click |
| S7 | Consolidate toggle | Button collapses the chart to one "All accounts" series (legend 2→1) and back; `aria-pressed` tracks | Legend count wrong or toggle text stuck |
| S8 | Timeframe guard | All four seg buttons enabled on 260-day demo history; clicking 1M moves `aria-pressed` and redraws | Disabled buttons in demo, or pressed state stuck |
| S9 | Brief structure | Demo brief renders Portfolio state / Key levels / Scenarios sections + disclaimer + stamp | Missing section or missing disclaimer |
| S10 | Locked → login → render (live only) | With a backend configured + `TEST_AUTH_CREDENTIAL`: locked shells pre-auth, valid PIN renders accounts/chart/brief | Skips while demo-only; fails if unlock doesn't render |
| S12 | Charts workbench | With `?demo=1`, `#wbChart` renders all three pane captions (Pro 1 daily / Pro 2 weekly / Pro 3 day-trading EOD) with candles + 6 stochastic paths; zoom segs and symbol select redraw; PANE seg maximizes a tier; settings popover opens with per-pane chart-style radios + indicator/SMA/S-R checkboxes | Missing pane, empty SVG, dead controls, or popover missing controls |
| S11 | Wrong-PIN error (live only) | Invalid PIN shows `.lock-error` text, stays locked, no data leaks | Skips while demo-only; fails if error absent or data renders |
| S13 | Heatmap map filter | With `?demo=1`, the MAP FILTER rail cuts the treemap (Dow 30 shrinks tile count, ETFs re-source from charts data and unlock the period dropdown); Themes regroups the S&P dataset; live-fed universes (World/Crypto/Futures — `desk-maps` delayed quotes, live mode only) and Russell 2000 render disabled in demo | Cut doesn't re-render, period gating wrong, or pending rows clickable |
| S14 | Live-feed canary (live only) | Masthead lamp reads LIVE with a "Fetched" stamp < 6 min — proves the edge-function feed layer end-to-end (there is no snapshot fallback anymore); skips while demo-only. Note: S1 allowlists console errors from the feed origin ONLY (`.supabase.co/functions/v1/`) — the app handles feed failures by design; S14 is where feed health fails loudly | Lamp STALE/missing on a healthy backend, or S1 allowlist widened beyond the feed origin |

## Owner Communication Preferences
- **Explanations of how things work (data flows, architecture, processes):
  lead with a simple table** — one row per component, plain-language columns
  (what / where it comes from / when it updates / how it reaches the user) —
  followed by at most two takeaway sentences. No jargon in the cells;
  mechanism detail only if asked. (Owner preference, 2026-07-13.)

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
