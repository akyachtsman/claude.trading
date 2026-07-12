# Brief: PIN-gated positions treemap

## Problem (one sentence)
The owner can see real holdings as a sortable table, but has no at-a-glance
picture of how portfolio weight and daily movement are distributed across
positions — the way the S&P 500 heatmap already shows the market.

## Users & current alternative
The desk owner (behind the PIN), on desktop and iPad. Today they read the
per-account **positions table** (sym / qty / market value / day % / unrealized
P&L, sortable) and mentally reconstruct concentration and what's moving. The
treemap makes weight and day-movement visible in one glance.

## Definition of done (smallest useful)
A new PIN-gated **"Positions — day heat"** panel that, per account, renders a
squarified treemap where **tile size = market value (`mkt`)** and
**tile color = day % (`dayPct`)** on the existing heatmap ramp, with:
- The panel's data-state **lamp + as-of stamp** (design signature — required).
- Hover tooltip: symbol, qty, market value, day %, unrealized P&L — all via
  `textContent`, 2-decimal percentages.
- Demo mode renders demo positions identically (no live backend required).
- Empty state ("no positions yet") when an account has none — reuses the
  existing authed-empty pattern.

## Risks
- **Riskiest:** whether live `desk_get_dashboard` actually returns populated
  positions (`mkt`/`unrl`) for the real IBKR accounts yet. Real snapshots
  landed, but positions arrive via IBKR Flex. **If wrong:** the panel shows the
  empty state — graceful, non-breaking. Verify against the live RPC before
  claiming done.
- Small position counts (a handful of tiles, unlike ~500 S&P constituents) —
  squarify handles this; labels fit *better*, not worse.
- Reusing the heatmap's color engine means the AA ink-flip fix (PR #27) must be
  in place first, or the same contrast gap reappears here.

## Constraints / non-negotiables
- Inherited directives (global/design/test/data) hold.
- `textContent` only — never `innerHTML`.
- Price-change % at 2 decimals; P&L colors are P&L-only (the ramp poles are
  genuine P&L semantics here, not decoration).
- Every panel carries a data-state lamp + as-of stamp.
- Browser-only / static tier; must work on iPad. No build step.
- Real balances never enter the repo or served files — positions render only
  from the live PIN-gated RPC (or demo data).

## Out of scope (for now)
- Unrealized-P&L coloring toggle (clean fast-follow; data is present as `unrl`).
- Consolidated all-accounts single treemap (per-account is the primary axis).
- Sector/industry grouping (positions carry no sector field; would need a
  lookup — separate effort).
- Drill-down, position history, or any write/trade action.

## Chosen approach + why
**Approach A — reuse the heatmap engine, group by account, color = day %.**
Reuses the just-shipped `squarify` + `heatColor`/`heatInk` (with the #27 AA
fix) and the live-mode `desk_get_dashboard` plumbing, so it's mostly
composition: least new code, ships fast, and gives one visual language across
the S&P heatmap and the owner's own book.

### Alternatives considered
- **B — color = unrealized P&L (`unrl`).** Better "how are my holdings doing
  overall" story, but diverges from the heatmap's day-% language and doubles
  the color logic for v1. Deferred to the out-of-scope toggle.
- **C — consolidated single treemap across all accounts.** Loses per-account
  context, which is the dashboard's primary organizing axis.

---
Next: `/sdd-loop specify` — it reads `brief.md`.
