# Spec — Multi-Account Trading Dashboard (v1)

WHAT and WHY only. HOW lives in `plan.md`. Constitution: the four imported
directives. Inputs: `brief.md` (approved ambition: terminal-grade),
`research.md` (binding polish bar), `design.md` (approved daylight-ledger
contract; reference page live on main).

## Problem
The owner holds several Interactive Brokers accounts and has no single screen
showing them side by side with charts, market context, news, and analysis.

## Users
- **Owner (only user):** checks the desk one or more times daily — pre-open,
  after close — on desktop and iPad Safari.

## User stories
- **US1 — Morning glance:** As the owner, I open the dashboard and within one
  screen know each account's value, yesterday's damage/gain, and what the
  market is doing — without logging into IBKR.
- **US2 — Account drill:** For any single account I see its NAV, day and
  total P&L, cash, and every position with market value, day move, and
  unrealized P&L, sortable by any column.
- **US3 — Trend read:** I see each account's equity curve over selectable
  timeframes, separately or consolidated into one portfolio line.
- **US4 — Context read:** I see a market summary (major indices, volatility,
  rates) and a news feed where headlines that touch my holdings are marked
  with their tickers.
- **US5 — Analyst read:** I read a short AI-written daily brief about MY
  portfolio — state, key levels, scenarios — clearly labeled as generated and
  not advice.
- **US6 — Trust check:** On every panel I can see how fresh its data is
  (as-of time + state lamp) and where it came from, so I never mistake a
  snapshot for live quotes.

## Functional requirements

### Accounts (FR-A)
- FR-A1: One window per configured IBKR account showing: account label +
  masked/short id, NAV, day P&L ($ and %), total unrealized P&L, cash,
  position count, an equity sparkline, and a positions table.
- FR-A2: Positions table columns: symbol (with quantity), market value, day
  %, unrealized P&L; sortable per the design directive's table standard.
- FR-A3: Account identity is color-coded consistently everywhere (window
  header, chart series, legend) using the contract's series tokens.
- FR-A4: The set of accounts is configuration-driven — adding a fourth
  account requires a config change, not code surgery.
  [NEEDS CLARIFICATION: how many real IBKR accounts, and what labels?]

### Consolidation (FR-C)
- FR-C1: An explicit "Consolidate accounts" toggle rolls all accounts into
  one aggregate view (summed equity curve; aggregate NAV/day P&L visible);
  never merged silently. Toggling back restores per-account view.

### Charts (FR-CH)
- FR-CH1: A combined equity chart plots each account's equity curve with
  direct end-labels + legend, and supports timeframes 1M / 3M / 6M / 1Y.
- FR-CH2: Hovering (or tapping) the chart shows a crosshair and per-series
  values for the nearest date.
- FR-CH3: A non-graphical data table of the plotted values is available
  (accessibility fallback).
- FR-CH4: Each account window carries its own equity sparkline.

### Market summary (FR-M)
- FR-M1: A summary strip shows at least: S&P 500, Nasdaq 100, Dow, Russell
  2000, VIX, US 10Y — last value, change %, and a mini-trend sparkline.
- FR-M2: Change direction is encoded by the contract's gain/loss colors and
  by the printed sign (never color alone).

### News (FR-N)
- FR-N1: A news panel lists recent headlines with source and time.
- FR-N2: Headlines mentioning a held symbol carry a ticker chip with that
  symbol's day change; holdings-relevant items rank first.
- FR-N3: News refreshes on the same cadence as the rest of the data; its
  as-of state is visible.
  [NEEDS CLARIFICATION: preferred news source(s)/API — free tier acceptable?]

### AI daily brief (FR-AI)
- FR-AI1: A generated brief covers: portfolio state (with real numbers from
  the latest snapshot), key levels/facts, and scenarios/risks ahead.
- FR-AI2: The brief is grounded ONLY in the dashboard's own committed
  account + market + news snapshots — never fabricated positions.
- FR-AI3: Every brief displays: generation timestamp, "AI-generated — can
  make mistakes," and "informational only, not financial advice."
- FR-AI4: If generation fails or is stale (> 1 cycle old), the panel says so
  plainly rather than showing an undated brief.
  [NEEDS CLARIFICATION: which LLM provider/key will the owner supply as a
  repo secret?]

### Data pipeline & freshness (FR-D)
- FR-D1: Account, market, and news data refresh automatically on a schedule
  with no manual steps; the owner's credentials/tokens are never present in
  the browser-served code or repo files.
- FR-D2: Every panel shows an as-of timestamp and a data-state lamp
  (LIVE/EOD/DEMO per the design contract); the masthead shows the overall
  snapshot time.
- FR-D3: Until real credentials are configured, the dashboard runs fully on
  labeled DEMO data — the demo state must be visually unmistakable.
- FR-D4: If a scheduled refresh fails, the dashboard keeps serving the last
  good snapshot with its true (older) as-of time; the failure is surfaced to
  the owner (notification per repo standards), not hidden.
  [NEEDS CLARIFICATION: snapshot cadence — daily after US close only, or
  also intraday refreshes?]
  [NEEDS CLARIFICATION: the repo is public — committed account snapshots
  (balances, positions) would be world-readable. Acceptable, redact, make
  repo private, or gate the data behind a backend?]

### Devices, accessibility, quality (FR-Q)
- FR-Q1: Fully usable on iPad Safari and desktop; all interactive elements
  meet the design directive's tap-target rules.
- FR-Q2: WCAG AA contrast per the committed tokens (CI-enforced); status
  never conveyed by color alone; `prefers-reduced-motion` honored.
- FR-Q3: All dynamic text rendered via `textContent` (constitution rule).
- FR-Q4: The page renders meaningful content immediately on load (no blank
  shell), including on a cold cache.

## Success criteria (testable)
1. Opening the live URL shows: market strip, all account windows, combined
   chart, news, AI brief — populated, each with as-of stamp + lamp (US1, US6).
2. Sorting any positions column reorders rows correctly, both directions,
   "—" values sinking last (FR-A2).
3. Consolidate toggle switches chart + summary between per-account and
   aggregate and back, with legend/labels updating (FR-C1).
4. Timeframe buttons re-render the chart to the selected window; hover shows
   correct per-series values for a known date (FR-CH1/2).
5. With demo data: DEMO lamps visible on masthead and every panel (FR-D3).
6. With real data configured: fresh snapshot appears after the scheduled run
   with updated as-of stamps, and no secret appears in any served file or
   commit (FR-D1/2 — verified by inspection + the security grep).
7. A simulated failed refresh leaves the previous snapshot serving with its
   older stamp visible (FR-D4).
8. AI brief shows timestamp + both disclaimers; its numbers match the
   snapshot it cites (FR-AI1–3).
9. Playwright suite (S1–S4 + project scenarios) green against the live URL.

## Non-goals (v1)
- No order placement or any trade execution.
- No real-time/streaming quotes; snapshot cadence only.
- No multi-user support, sharing, or per-user auth.
- No brokers other than Interactive Brokers.
- No native apps; responsive web only.
- No historical trade analytics (win rate, per-trade stats) — candidate v2.

## Open clarifications (blocking `plan`)
1. [NEEDS CLARIFICATION] Account inventory: how many IBKR accounts, their
   labels, and are all under one IBKR login?
2. [NEEDS CLARIFICATION] Public-repo privacy: commit real balances/positions
   to the public repo, redact values, make the repo private, or gate data
   behind a backend?
3. [NEEDS CLARIFICATION] Snapshot cadence: daily after US close, or intraday
   too?
4. [NEEDS CLARIFICATION] News/market data source preference (free tiers ok?).
5. [NEEDS CLARIFICATION] LLM provider + key for the AI brief.
