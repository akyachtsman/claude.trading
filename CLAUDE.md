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
  SECURITY DEFINER PIN RPCs + the `desk-ask` edge function are deployed and
  the pipeline upserts nightly. Demo remains reachable via `?demo=1`.
- `scripts/data.js` — formatters, seeded demo generator, trading-day calendar,
  mode resolution, public JSON loaders (cache-busted), staleness lamps,
  Supabase RPC + edge-function fetch wrappers.
- `scripts/app.js` — all rendering + interactions (accounts, chart, brief with
  FR-AI4 staleness, news, ask-the-desk panel, PIN lock/unlock flow).
- `data/*.json` — public market/news/meta snapshots, committed daily by the
  pipeline (never edited by hand).
- `config/news-feeds.json` — owner-editable news source roster; merged over
  built-in defaults by the pipeline.
- `.github/scripts/refresh/` — the data pipeline (Node 20, `fast-xml-parser`
  only): Stooq→Yahoo quote chain, FRED 10Y, RSS news, IBKR Flex, Anthropic
  brief, watchlist OHLC histories (`fetch-charts.js` → `data/charts.json`;
  roster override in `config/chart-watchlist.json`, NEVER derived from
  holdings — public repo), meta writer. Fixture tests via `node --test`.
- `.github/workflows/data-refresh.yml` — dual cron (22:30 UTC + 09:30 UTC
  retry) + dispatch (`backfill`, `force_fail_market`).
- `supabase/functions/desk-ask/` — versioned source of the PIN-gated Claude
  Q&A edge function (deployed only to the desk's dedicated project).
- `specs/multi-account-trading-dashboard/` — the SDD artifact chain
  (brief/spec/plan/tasks/design/analysis).

## Required Commands
| Purpose | Command |
|---|---|
| Validate HTML | `npx html-validate index.html` |
| Contrast gate (WCAG AA) | `node .github/scripts/check-contrast.js` |
| Pipeline fixture tests | `cd .github/scripts/refresh && npm ci && npm test` |
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
  session. Real balances never enter this repo or the served files.
- **Bot-data-commit exception:** `data-refresh.yml` pushes `data/*.json` to
  `main` directly with `[skip ci]` (same standing as `keepalive.yml`); code
  changes still go through PRs.
- Server-side keys (`DB_SERVICE_KEY`, `ANTHROPIC_API_KEY`, IBKR tokens) live
  only in Actions/edge-function secrets — never client-side, never committed.
- **Supabase free-tier auto-pause runbook:** if live login suddenly fails after
  ~1 week of pipeline inactivity, the project likely auto-paused — restore it
  from the Supabase dashboard; the pipeline's upsert-failure email is the
  early-warning signal.

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
