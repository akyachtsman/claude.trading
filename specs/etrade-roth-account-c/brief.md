# Brief — E*TRADE Roth IRA as Account C

## Problem (one sentence)
The owner's E*TRADE Roth IRA lives outside the desk, so seeing the whole
portfolio means opening the E*TRADE app alongside the dashboard.

## Users & current alternative
Single user (the owner). Today: checks the Roth in the E*TRADE app/site and
mentally adds it to the desk's A/B totals.

## Definition of done (smallest useful)
Account C renders with **full parity to Accounts A and B**: its own card
(NAV, day P&L, cash, positions table, sparkline, LIVE/EOD lamp + as-of
stamp), joins the **Consolidate accounts** toggle and the **equity-curves
panel**, and appears in the demo dataset. Data arrives via **manual
PIN-gated import** (owner pastes E*TRADE positions + values); the equity
curve **starts at the first import** and grows with each subsequent one.
The as-of stamp reflects the last import (an old import lamps stale, by the
desk's existing two-tier staleness idiom).

## Risks
- **Import ergonomics:** if pasting is fiddly, the account silently goes
  stale — the stamp/lamp must make "last imported N days ago" impossible to
  miss. (Riskiest part: a wrong-but-plausible manual import shows wrong
  money; mitigations: parse-preview before commit, and the lamp shows the
  import date, never "live".)
- **CSV drift:** E*TRADE can change its export columns; the parser must
  fail loudly to the preview, never guess silently.
- **Consolidation math:** mixed as-of dates (A/B synced nightly, C imported
  ad hoc) must not fabricate a combined "today" — the consolidated view
  carries C at its last-import value, stamped as such.

## Constraints / non-negotiables
- **Real balances never enter this repo, the served files, or chat** — the
  import flows browser → PIN-checked SECURITY DEFINER RPC → RLS
  (default-deny) tables in the **dedicated Supabase project only**
  (learnings: `dedicated-supabase-project-only`).
- The A/B IBKR Flex sync (`desk-ibkr-sync`, pg_cron) is untouched.
- Demo mode (`?demo=1`) keeps working and gains a deterministic Account C.
- Design signature: the new card carries a data-state lamp + as-of stamp.
- Browser-only workflows (import must work from an iPad).
- Supabase backend changes (tables/RPCs/migrations) require explicit owner
  approval per instance before applying.

## Out of scope (for now)
- Any automated E*TRADE sync (their OAuth tokens expire nightly at midnight
  ET — unattended cron is impossible without daily re-auth).
- Aggregators (SnapTrade/Plaid) — rejected: third party sees the account.
- Historical backfill of the Roth's curve (owner chose grow-from-first-import).
- Other E*TRADE accounts, trade history, tax lots.

## Chosen approach & why
**PIN-gated import panel in the desk.** In the unlocked state, an "Import
Account C" flow accepts a pasted E*TRADE positions export (plus
typed/parsed NAV & cash), parses it **client-side**, shows a preview
(positions count, NAV, cash, as-of date), and on confirm calls a new
PIN-checked SECURITY DEFINER RPC that upserts Account C's snapshot +
positions into the same RLS-guarded shape A/B use, appending one NAV
history point per import date. Why: keeps the existing security boundary
(anon key public, RLS deny-all, PIN RPC as the only write path), zero
credentials stored, works from any browser, and a Roth's low churn makes
manual cadence acceptable.

## Alternatives considered
- **E*TRADE official API + daily re-auth:** freshest data, but their tokens
  die at midnight ET every day — the owner would have to re-authorize daily
  or the sync silently breaks; key approval also takes weeks. Rejected.
- **Aggregator (SnapTrade/Plaid Investments):** automated like IBKR, but a
  third party holds the E*TRADE login and sees the account; likely paid.
  Rejected on privacy grounds.
- **Supabase Studio manual table entry:** zero code, but error-prone
  many-column typing with no preview/validation, and it bypasses the
  PIN-RPC write path. Rejected.

*Decisions taken 2026-07-16 via /diagnose Q&A with the owner (parity: "similar
to accounts A and B"; data path: manual import; history: grows from first
import).*
