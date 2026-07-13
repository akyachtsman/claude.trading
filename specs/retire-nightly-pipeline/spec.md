# Spec: Retire the Nightly Pipeline — Live-Delayed Data Everywhere

**Status:** Phase 1 (specify) — awaiting clarification
**Owner ruling:** 2026-07-13 — "I want this whole nightly fetch function gone,
completely deleted," confirmed as the FULL Data Refresh pipeline after an
explicit everything-it-feeds warning. Supersedes the nightly-batch design in
`specs/multi-account-trading-dashboard/` for data delivery; that spec's panel
definitions, demo mode, and privacy architecture remain authoritative.

## Why

1. **The batch model keeps breaking.** The nightly fetch has been the desk's
   least reliable component (source throttling against shared CI egress,
   partial-failure states, red runs demanding owner attention). The map
   universes never shipped a single successful batch.
2. **The owner wants fresher data.** EOD snapshots make every panel a day old
   by design. The desk should show delayed-live market state whenever it is
   opened, not yesterday's close.
3. **One delivery model.** The dashboard already proves the on-demand pattern
   in production (Pro 3 intraday, ask-the-desk, and now the extra map
   universes). Running batch and on-demand side by side doubles the surface
   the owner has to reason about.

## User stories

- **US-1 (visitor, live mode):** Opening the dashboard shows the market strip,
  S&P heatmap, watchlist charts, and news with delayed-live data and a lamp +
  stamp telling me exactly how fresh each panel is — no panel silently serving
  yesterday's snapshot.
- **US-2 (owner):** I never triage a failed nightly run again. There is no
  nightly run. A feed having a bad moment degrades one panel gracefully
  (last-good or an honest unavailable state), never the whole site.
- **US-3 (owner, private data):** My account snapshots and daily AI brief keep
  arriving on their daily cadence without any GitHub Actions involvement, with
  the same privacy boundaries as today.
- **US-4 (visitor, demo):** `?demo=1` behaves exactly as today — deterministic
  seeded data, no network, every scenario testable.

## Functional requirements

| # | Requirement | Verifiable by |
|---|---|---|
| FR-R1 | Market strip data is served on demand in live mode with staleness ≤ 5 min under normal operation | Stamp/lamp on panel; repeat visits within window share a cached payload |
| FR-R2 | S&P 500 heatmap (and its derived Dow/Nasdaq/Themes cuts) is served on demand, full ~500-tile coverage preserved | Tile count parity with today's `heatmap.json`; S13 |
| FR-R3 | Watchlist charts (current roster, ≥ 330 daily bars, weekly derivation, multi-period ETF performance) are served on demand | S12 renders all panes; ETF map period dropdown still works |
| FR-R4 | News list is served on demand from the owner-editable feed roster (`config/news-feeds.json` semantics preserved) | News rows render; roster edit takes effect without code change |
| FR-R5 | IBKR account snapshots continue on a daily schedule with **no GitHub Actions dependency**; same tables, same RLS/privacy boundaries | Accounts panel serves next-day data after unlock; no Actions run involved |
| FR-R6 | The daily AI brief continues on schedule with **no GitHub Actions dependency**; the FR-AI4 grounding guard is preserved verbatim | Brief renders with sections + disclaimer; ungrounded drafts still refused |
| FR-R7 | Every panel lamp/stamp derives from its own feed's embedded freshness (`asOf`/`generatedAt`); the shared `meta.json` mechanism is retired | Lamps correct with no `data/meta.json` present |
| FR-R8 | No feed is fetched during initial page load in a way that can log a console error when unreachable (S1 gate); loads are lazy or gracefully gated | S1 green with all live feeds down |
| FR-R9 | A feed failure degrades to last-good data (when the tab has any) or an honest per-panel unavailable state — never a blank site | Kill one feed; other panels unaffected |
| FR-R10 | The nightly pipeline is fully deleted: workflow, refresh scripts, fixtures, committed `data/*.json`, and bot data-commits to `main` cease | Repo tree; Actions list; no `[skip ci]` commits after cutover |
| FR-R11 | Migration is additive per feed — the live replacement is verified in production before its nightly step/file is removed | Cutover checklist per feed in tasks.md |
| FR-R12 | Demo mode is byte-for-byte unaffected in behavior | S5–S9, S12, S13 pass unchanged |

## Success criteria

- Every public panel shows a LIVE-class lamp in live mode; no panel depends on
  a committed snapshot.
- `data-refresh.yml` and `.github/scripts/refresh/` no longer exist; the
  Actions tab shows no scheduled data workflow.
- Both QA suites (local + live) green after cutover.
- Accounts + brief cadence uninterrupted across the migration (no missed day).
- The 60-day Actions scheduler clock remains protected once daily data commits
  stop (keepalive is the only remaining writer).

## Non-goals

- Real-time streaming (websockets, sub-minute updates) — delayed quotes on
  open/interaction are the bar.
- Paid market-data subscriptions (standing owner ruling).
- Russell 2000 universe (separately deferred — "later I will ask").
- Any change to the PIN/RLS privacy architecture, demo generator, or the
  design contract.
- Intraday history retention/archival of the retired `data/*.json` snapshots.

## Clarifications (Phase 2 — owner, 2026-07-13)

1. **Freshness bar (owner, verbatim intent):** "All news and data should be
   coming in real time. Updated every 5 minutes instead of overnight." →
   Every public feed (market strip, heatmap + derived cuts, watchlist charts,
   news, extra map universes) refreshes on a **≤ 5-minute cycle while the
   dashboard is open** — not merely on page load. FR-R1's 5-minute staleness
   bound generalizes to FR-R1..R4.
   **Recorded carve-out (owner may override):** IBKR account snapshots and
   the AI brief stay **daily** — Flex statements are a once-daily product
   (intraday NAV would require persistent gateway infrastructure, outside
   the free-tier constraint), and a 5-minute Claude regeneration cycle
   spends real API budget on an editorial artifact. Their schedule question
   resolves to: one daily run + one retry, mirroring today's cadence.
2. **Failure alerting:** lamps on the dashboard + platform logs are the
   alerting surface (the old email step was never configured — no regression).
   Recorded as an accepted residual; an alert channel can be added later
   without re-architecture.
3. **Invocation budget:** accepted residual, desk-maps precedent. Bounded by
   short server-side caches; an always-open tab polling 4 feeds at 5-minute
   cadence ≈ 35K invocations/month — comfortably inside the free tier.
4. **Pipeline-adjacent monitors:** retire `cron-notify.yml` with the
   pipeline; `ci-monitor.yml` / `pages-monitor.yml` / `keepalive.yml` stay
   (they watch surfaces that still exist, and keepalive becomes load-bearing).
5. **Heatmap upstream source:** delegated to the plan phase (source choice is
   HOW, not WHAT; the requirement is fixed at full-coverage tiles at 5-minute
   freshness).
