# Watchlists panel

The Watchlists panel's tile / column rendering, placement, display rules and chart timeframe (`renderWatchlist`, `wlTile`, `#wlTf`; scenarios S20, S26, S27, S41, S42).

- **Watchlists panel** (`renderWatchlist()` + `wlTile()` + the editor, owner
  request 2026-07-29) — multiple named lists, unbounded symbols each.
  **Rendered as TILES, not a table** (owner request the same day, after seeing
  the table). The band/tile chrome is the shared `.mkt-group`/`.mkt-tile` CSS in
  `styles/layout.css`; `.wl-strip` widens it for a full-page panel.
  **EACH CATEGORY IS A COLUMN** (owner request 2026-08-17, replacing the
  full-width horizontal band it had been): list name on top, its tiles stacked
  downward, columns left to right, wrapping onto another row when they outgrow
  the panel. The **markup is unchanged** — `.mkt-group` > `.wl-band-head` +
  `.mkt-group-tiles` — because drag-to-arrange, quick add, double-click removal,
  the detail window and create/delete all hang off it; only the CSS axis flips.
  One trap is load-bearing: `.wl-tile` carried `flex: 0 0 66px`, and inside a
  COLUMN parent `flex-basis` governs HEIGHT, so every tile would have rendered
  as a 66px-tall box — it is `0 0 auto` now, with width from the 92px column
  (66px tile + padding + gutters). The same reasoning retired the per-band
  horizontal scrollbar (nothing scrolls sideways any more) and let the
  empty-list placeholder wrap instead of running out of a 92px column. Short
  columns simply END — never stretched to match the tallest, which would make a
  3-symbol list look like a 12-symbol one.
  The reorder controls are **`«`/`»`, NOT a bare `←`/`→`** (2026-08-17). The
  axis genuinely changed, but a bare `←` on a button is read as BACK by people
  and machines alike: the UI crawler's back-control selector is literally
  `button:text-is("←")`, and it grabbed this control the moment it shipped,
  failing the NAV scenario on a disabled first-list arrow. `‹` is in that
  selector too. Labels are "Move X earlier/later", which stays true when the
  columns wrap.
  **The panel sits FULL-WIDTH DIRECTLY ABOVE the Stochastic charts panel**
  (owner request 2026-08-17) — it was previously a column inside `.top-band`.
  It full-bleeds like `.area-charts` and joins the shell cap's opt-out list,
  since a capped, centred panel sitting on a full-bleed one reads as a
  misalignment rather than a margin. That move also **deleted** the top band's
  out-of-flow arrangement (see below) rather than porting it.
  Every list renders at once, so **the columns ARE the navigation** and there are
  no tabs. A tile shows ticker / last / day-% pill; bid, ask, volume and the long
  name move to its `title` tooltip rather than being dropped. A long price wraps
  its pill to a second line.
  **This panel replaced the market strip** (owner ruling 2026-07-29). The strip
  was a left-column stack of the same labelled bands — Global & income, Macro,
  US sectors, Industry & metals, Treasuries — fed by `desk-market`. Once
  Watchlists carried those same categories with live prices and a per-tile
  sparkline, the strip was the same information twice, so it was removed
  (markup, `MKT_BANDS`/`renderStrip`/`mktTile` in `app.js`, and its `.market-strip`
  layout rules; the shared tile chrome stays because this panel uses it, and the
  4-tile row cap went with the strip that needed it). `desk-market` itself is
  untouched — the Markets window's index tiles and sector grid still read from
  it, as does the assistant's market context. With the strip's column freed,
  `.top-band > .col-markets` went 420 → 860px so Markets and Ask-the-desk split
  the row about evenly instead of leaving Ask stretched across dead space.
  **The watchlist change pill reads at the PRICE's size** (`.wl-pct`, 9 → 12px,
  owner request 2026-08-21: "bigger, but try to not resize the boxes"). It was
  the smallest thing on a tile whose whole job is to show a move. The tile is
  held at 76 × 63 by paying for the type out of the pill's own leading and side
  padding — 9px at 1.3 is 11.7px tall, 12px at 1.05 is 12.6 — so the row grows
  by **one pixel**, not four, and the widest real value still sits inside the
  66px of usable width with nothing clipped (S27 guards exactly this).
  **`Radar` is the inbox list** (owner request 2026-07-30): the panel-header `+`
  routes every new symbol there rather than asking which list, and it is dragged
  onward from there. It is an ordinary row in `desk_watchlists` — nothing in the
  code creates or protects it — so it can be renamed or deleted like any other.
  **An empty list still renders as a full band**: a placeholder sized to one
  tile, so it keeps its shape and stays a drop target instead of collapsing to a
  bare label that reads as a rendering fault. The copy comes from the SAVED
  symbols and the lock state, never from the drawn rows — a list whose every
  ticker is unresolved has rows `[]` but symbols, and calling that "Empty" would
  contradict the `#wlMissing` warning naming those very tickers; and the drag
  invitation is withheld under the lock, since `wlCommitMove` refuses every
  non-trash move there.
  **A drop commits at the index the insertion marker showed** (audit 2026-09-29): a
  forward same-band drop landed one slot short (a one-slot drop did nothing)
  because the code shifted an index that was already post-removal; the marker math,
  `wlCommitMove` and Alt+Arrow now share one computation, which also counts
  unresolved symbols.
  **Two display rules, both from the 2026-07-29 extended-hours ruling:** each
  tile marks its price's session — `EXT` for a pre/post print, `CLOSE` for an
  index whose session has ENDED (indices have no extended session; during
  regular hours their price is live and carries no marker) — and Change %
  always measures from the
  PRIOR CLOSE including extended hours, so one number means the same thing all
  day and all evening. Neither marker is colour-coded (gain/loss colour is
  P&L-only). Unresolved tickers render in `#wlMissing` rather than vanishing:
  splitting a pasted table on whitespace turns "BRK B" into BRK + B, both of
  which *look* like tickers, so naming what didn't resolve is the only honest
  signal. A tile whose post print arrives with no post-% shows NO percentage rather
  than the regular move beside an after-hours price (audit 2026-09-29).
    **Chart timeframe** (`#wlTf` / `renderWlTf()`, owner request 2026-07-30) — a
  segmented 1D/1M/3M/6M/1Y/2Y/5Y control beside the sort, panel-wide (per-list
  spans would make two tiles incomparable) and persisted in `localStorage`
  (`wl_tf_v1`). It sets the window each tile's SPARKLINE draws and nothing else:
  the Change % pill stays the prior-close move per the 07-29 ruling, so one
  number keeps one meaning regardless of a control elsewhere in the header. The
  token is validated server-side against `WL_RANGES` and never interpolated into
  the upstream URL — `desk-watchlist` is anon-callable, so a query param must not
  reach Yahoo. Each range is a separate cache slot + single-flight (two ranges
  are two different bodies), the payload echoes `range` so a slow 5Y reply can't
  repaint tiles after the owner has switched away, and `buildSpark`'s pre/post
  special-casing is gated to intraday (on a multi-day series the pre-market
  rewrite would discard a year of history to draw a two-point line).
