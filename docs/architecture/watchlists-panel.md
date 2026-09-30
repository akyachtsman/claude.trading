# Watchlists panel

The Watchlists panel's tile / band rendering, placement, display rules and chart timeframe (`renderWatchlist`, `wlTile`, `#wlTf`; scenarios S20, S26, S27, S41, S42).

- **Watchlists panel** (`renderWatchlist()` + `wlTile()` + the editor, owner
  request 2026-07-29) — multiple named lists, unbounded symbols each.
  **Rendered as TILES, not a table** (owner request the same day, after seeing
  the table). The band/tile chrome is the shared `.mkt-group`/`.mkt-tile` CSS in
  `styles/layout.css`; `.wl-strip` widens it for a full-page panel.
  **EACH LIST IS A HORIZONTAL BAND** (owner request 2026-09-30: "I need each of
  the watch list to go back to displaying horizontal. I don't like the vertical
  anymore."). Bands stack top to bottom, ONE per list, each the full width of the
  panel; inside a band the head (list name + its controls) is a fixed 104px
  block on the LEFT and the tiles run in ONE row to its right. **This WITHDRAWS
  two earlier rulings**: 2026-08-17 ("each category is a COLUMN") and
  2026-08-20 ("the columns are PAGED, not scrolled") — the pager existed only to
  tame a column's vertical overflow and went with the columns. The layout is the
  one the panel had from 2026-07-29 to 2026-08-17. The **markup never changed**
  through any of it — `.mkt-group` > `.wl-band-head` + `.mkt-group-tiles` —
  because drag-to-arrange, quick add, double-click removal, the detail window
  and create/delete all hang off it; only the CSS axis flips.
  Load-bearing, each with the failure it prevents:
  - **The row never wraps and scrolls SIDEWAYS**: `.wl-strip .mkt-group-tiles` is
    `flex-wrap: nowrap; overflow-x: scroll; overflow-y: hidden`. `scroll`, not
    `auto`, so the 8px track is present even where a short list would fit and
    bands do not change height as symbols come and go. The bar is styled ONLY by
    the `::-webkit-scrollbar*` rules and the row carries **NO `scrollbar-width`**:
    from Chrome 121 that property takes precedence over the pseudo-elements and
    would switch the always-visible bar off (Firefox keeps its own overlay bar).
    Playwright's headless Chromium hides scrollbars outright, so the reserved
    track height is measurable in WebKit only; S42 probes whether the browser
    draws one and says so when it cannot measure.
  - **`overscroll-behavior-x: contain` is the ONLY overscroll rule on the page**,
    the axis-scoped form, so a sideways swipe off the end of a band does not
    trigger browser back-navigation. The shorthand and every `-y` form stay
    banned (`CLAUDE.md` → *NEVER use `overscroll-behavior: contain`*): the row is
    `overflow-y: hidden`, so a vertical wheel over a band has nothing to grab and
    moves the PAGE — the owner's dead-wheel complaint of 2026-08-07 stays fixed.
    S42 scans every stylesheet rule (including `@media`) and every inline style
    for the shorthand and the `-y` longhand.
  - **`.wl-tile` is `flex: 0 0 76px`**. In a ROW `flex-basis` is the tile's
    WIDTH, so a fixed basis keeps the tile a fixed size while the band scrolls;
    `flex: 0 0 auto` (the column-era value) would size every tile to its content.
    It is 76, not the 66 it carried before 2026-08-17: the tile now measures
    76 × 63 and the owner asked that it not be resized (2026-08-21, "try to not
    resize the boxes", when the change pill grew to the price's size); S27 holds
    it to ≤ 80. The column era's trap was the mirror image: in
    a COLUMN the same basis set the HEIGHT and drew every tile 66px tall.
  - **The empty-list placeholder** (`.wl-band-empty`) is a one-line, no-wrap row
    one tile tall, so an empty band keeps its shape and stays a drop target.
  - **Under 640px the band stacks**: head above the tiles, the tile row the full
    width of the band and still scrolling sideways. The shared `.mkt-group` goes
    to `flex-direction: column` there, where `flex: 1 1 0` on the tile row would
    set a ZERO HEIGHT basis and collapse the band to its padding (Codex review,
    PR #190), so the stacked block resets it to `flex: 0 0 auto`, and the head's
    fixed 104px resets to its content height.
  - **Drag: the slot is decided by X alone** (`wlDropIndex(zone, x)`); Y only
    picks WHICH band (the drop zone under the pointer). A band is one row that
    never wraps, and a comparison on Y as well counts every tile as passed the
    moment the pointer sits on the row's own scrollbar — dropping at the END of the
    list wherever you aimed (S26 holds the pointer at the row's bottom edge).
  - **Drag: a long band auto-scrolls at its edges** (`wlAutoScroll`, `WL_EDGE_PX`
    56, `WL_EDGE_MAX_STEP` 24; added after Codex's review of PR #294). The pointer
    owns the drag, so the row's scrollbar cannot be used at the same time and, without
    this, a tile could only be dropped among the slots already on screen. Holding the
    pointer within 56px of a row's left/right edge scrolls it (faster nearer the edge)
    until it runs out; `wlDragPaint` redraws the marker after every step because the
    tiles move under a STILL pointer; the rAF loop runs only while the pointer sits in
    an edge zone that can still scroll, is re-armed by every pointer move and is
    cancelled in `wlDragEnd`. The keyboard path is Alt+←/→.
  - **Removed for good, not dormant**: `wlSyncPaging`, `attachPaging`, the ▲/▼
    `.wl-page-bar`/`.wl-page` footer and its CSS, the drag-rests-on-▼ stepping
    (`WL_DRAG_STEP_MS`, `wlDragStepAt`, `_wlStep`), the resize listener that
    re-measured overflow, and the `max-height` caps on the column. S42 asserts no
    pager markup and `typeof wlSyncPaging === 'undefined'`.
  The reorder controls are **`↑`/`↓`, NOT a bare `←`/`→`/`‹`**. The bands stack top
  to bottom, so up/down names the direction a list actually moves. (They were
  `«`/`»` from 2026-08-17 to 2026-09-30, when the lists sat side by side; before
  that `↑`/`↓`.) A bare `←` on a button is read as BACK by people and machines
  alike on any axis: the UI crawler's back-control selector is literally
  `button:text-is("←")`, and it grabbed the control the moment that shipped,
  failing the NAV scenario on a disabled first-list arrow. `‹` is in that selector
  too; `↑`/`↓` are in none. The aria-labels are "Move X earlier/later", which
  describes a position in the order and stays true however the lists are laid
  out. S41 asserts every control is `↑`/`↓` and none is a back arrow.
  **The panel sits FULL-WIDTH DIRECTLY ABOVE the Stochastic charts panel**
  (owner request 2026-08-17) — it was previously a column inside `.top-band`.
  It full-bleeds like `.area-charts` and joins the shell cap's opt-out list,
  since a capped, centred panel sitting on a full-bleed one reads as a
  misalignment rather than a margin. That move also **deleted** the top band's
  out-of-flow arrangement (see below) rather than porting it.
  Every list renders at once, so **the bands ARE the navigation** and there are
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
