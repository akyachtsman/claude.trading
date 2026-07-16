# Spec — E*TRADE Roth IRA as Account C

*Phase 1 (WHAT & WHY). Reads `brief.md`. Stack/architecture decisions live in
`plan.md`, not here.*

## Why
The owner's retirement savings sit in an E*TRADE Roth IRA that the desk can't
see, so the "multi-account" dashboard is really showing two of three accounts.
Every portfolio-level number (total net liquidation, consolidated equity curve,
cash %) is understated and the owner has to reconcile in their head against the
E*TRADE app.

## Users & context
Single user (the owner), on desktop or iPad browser, already authenticated with
the desk PIN. They import from E*TRADE occasionally (a Roth changes rarely), not
on a schedule.

## User stories
1. **See the whole portfolio.** As the owner, I want Account C shown beside A
   and B with the same information, so the desk reflects my entire net worth in
   markets at a glance.
2. **Import without friction.** As the owner, I want to paste my current E*TRADE
   holdings into the desk and confirm a preview, so my Roth data is current
   without storing any E*TRADE credentials anywhere.
3. **Trust the freshness.** As the owner, I want Account C to visibly show *when*
   it was last imported, so I'm never misled into thinking a stale figure is
   live.
4. **Roll up correctly.** As the owner, I want Account C folded into the
   Consolidate toggle and the equity-curves panel, so portfolio totals and the
   combined curve include the Roth.

## Functional requirements
Each is written to be verifiable (demo path via `?demo=1`; live path via the PIN
flow against the dedicated backend).

- **FR-C1 — Roster.** Account C is added to the account roster and renders as a
  third account card in the Accounts section, using series slot 3
  (`--color-series-3`, already CVD-validated — no reorder). Verify: three cards
  render in demo; C's series color matches slot 3.
- **FR-C2 — Card parity.** Account C's card shows the same elements as A/B: net
  liquidation (NAV), day P&L (value + %), cash, positions count, a positions
  table, a sparkline, and a data-state lamp + as-of stamp. Verify: every A/B
  card element is present on C in demo.
- **FR-C3 — Positions table.** Account C's positions table shows the same
  columns A/B use (symbol, market value, day %, unrealized P&L) and is sortable
  by header like A/B (S6 parity). Verify: header click sorts C's rows and flips
  `aria-sort`. `[NEEDS CLARIFICATION: E*TRADE's export may not carry per-position
  day % or unrealized P&L in the same shape — which columns are authoritative
  from the import vs. derived vs. shown blank?]`
- **FR-C4 — Manual import (live).** In the unlocked (PIN-authenticated) state,
  the owner can open an "Import Account C" flow, paste their E*TRADE holdings
  export, see a parsed preview (positions, NAV, cash, as-of date), and confirm.
  On confirm, Account C's snapshot + positions are persisted through the desk's
  existing PIN-gated write boundary. Verify (live): paste → preview → confirm →
  card reflects the imported values; no credentials entered.
- **FR-C5 — Import validation.** A malformed or unrecognized paste fails to the
  preview with a clear message and commits nothing — it never guesses or
  silently drops rows. Verify: a garbage paste shows an error and leaves prior
  data unchanged.
- **FR-C6 — Freshness lamp.** Account C's lamp/stamp reflects *import recency*,
  never "LIVE": a recent import reads as current-with-date, an old import lamps
  stale with the import date shown. Verify: import date drives lamp state; C's
  lamp is never the LIVE state A/B can show intraday.
  `[NEEDS CLARIFICATION: how many days since last import before C lamps "stale"?]`
- **FR-C7 — Consolidation.** Account C is included in the Consolidate-accounts
  rollup (total NAV, cash %) and its value carries at the last-import figure,
  stamped as such — the consolidated view must not fabricate a combined "today"
  across A/B's nightly sync and C's ad-hoc import. Verify: consolidated total
  equals A+B+C; combined view discloses C's as-of date.
- **FR-C8 — Equity curve.** Account C appears in the equity-curves panel as a
  third series that begins at the first import and gains one point per
  subsequent import date. Verify: C's curve renders; legend count is 3; C starts
  sparse and extends per import.
- **FR-C9 — Demo dataset.** `?demo=1` includes a deterministic Account C so all
  of the above are exercisable without the backend, matching the S5/S7/S8-style
  demo determinism. Verify: demo shows three accounts with stable seeded values.
- **FR-C10 — Security boundary unchanged.** Real Roth balances never enter the
  repo, the served files, or any committed artifact; the import writes only
  through the dedicated project's PIN-checked, RLS-guarded path. A/B's IBKR Flex
  sync is untouched. Verify: no balances in git; import blocked without valid
  PIN; A/B sync path unchanged.

## Success criteria
- The owner opens the desk and sees three accounts; the masthead/consolidated
  total includes the Roth.
- The owner completes an import from a real E*TRADE export in under a couple of
  minutes, from an iPad, with a preview they trust.
- At a glance the owner can tell how stale Account C is.
- No E*TRADE credential is ever stored, and no real balance ever lands in the
  repo.

## Non-goals (this feature)
- Automated/scheduled E*TRADE sync (their OAuth tokens expire nightly — out of
  scope per brief).
- Third-party aggregators (SnapTrade/Plaid) — rejected on privacy.
- Historical backfill of C's equity curve (grows from first import).
- E*TRADE trade history, tax lots, or accounts other than this Roth.
- Changing A/B's behavior, sync, or appearance.

## Constitution check (inherited directives)
- **data.md:** anon key public by design; RLS default-deny + PIN SECURITY
  DEFINER RPC is the only write path; dedicated Supabase project ONLY
  (`learnings: dedicated-supabase-project-only`). ✅ reflected in FR-C4/FR-C10.
- **global.md:** browser-only (import must work on iPad — FR-C4); feature branch
  + PR lifecycle.
- **design.md:** every panel carries a data-state lamp + as-of stamp (FR-C2,
  FR-C6); series colors not reordered (FR-C1).
- **Backend changes require explicit owner approval per instance** before any
  migration/RPC is applied (enforced at `implement`, noted here so `plan` treats
  it as a gate).

## Open clarifications (resolve at `/sdd-loop clarify` before `plan`)
1. **FR-C3** — E*TRADE export column mapping: which per-position fields are
   authoritative from the paste, which are derived, which shown blank?
2. **FR-C6** — staleness threshold: days-since-import before C lamps stale.
3. **Import source format** — what exactly does the owner paste (E*TRADE CSV
   download? on-screen positions copy? a specific report)? Determines the parser
   contract.
4. **Day P&L semantics** — for an ad-hoc import, is "day P&L" the value E*TRADE
   reported at import time (shown as-of that date), or omitted for C?
5. **Account code display** — masked identifier format for the E*TRADE account
   (A/B use `U***NNNN`).
