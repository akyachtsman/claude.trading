# Watchlists panel

The Watchlists panel's tile / band rendering, placement, display rules and chart timeframe (`renderWatchlist`, `wlTile`, `#wlTf`; scenarios S20, S26, S27, S41, S42).

- **Watchlists panel** (`renderWatchlist()` + `wlTile()` + the editor, owner
  request 2026-07-29) — multiple named lists, unbounded symbols each.
  **Rendered as TILES, not a table** (owner request the same day, after seeing
  the table). The band/tile chrome is the shared `.mkt-group`/`.mkt-tile` CSS in
  `styles/layout.css`; `.wl-strip` widens it for a full-page panel.
  **EACH LIST IS A BAND, AND A BAND NEVER SCROLLS SIDEWAYS** (owner requests
  2026-09-30, "I need each of the watch list to go back to displaying horizontal.
  I don't like the vertical anymore.", and 2026-10-04, "shrink the watch list as
  much as possible, but keep all the data still intact. I want to cap the number
  of stocks to this widescreen to fit it so I don't have to scroll back and forth.
  And if there's any excess, just create another watch list below it so I can see
  what I need to get rid of."). Bands stack top to bottom, ONE per list, each the
  full width of the panel; inside a band the head (list name + its controls) is a
  fixed 84px block on the LEFT and the tiles fill a GRID to its right whose rows
  wrap: the tiles that fit the width make row one, **the excess is the next row
  BELOW it** — the "other watch list underneath" — so a long list is seen,
  counted and pruned in full. **This WITHDRAWS three earlier rulings**:
  2026-08-17 ("each category is a COLUMN"), 2026-08-20 ("the columns are PAGED,
  not scrolled") and 2026-07-29 (one row per list, scrolled sideways under an
  always-visible bar; its 76px tile and the edge auto-scroll that serviced it).
  The **markup never changed** through any of it — `.mkt-group` >
  `.wl-band-head` + `.mkt-group-tiles` — because drag-to-arrange, quick add,
  double-click removal, the detail window and create/delete all hang off it; only
  the CSS display of the tile area changes.
  The excess is NOT a second list in the roster: no write happens and
  `desk_watchlists` is untouched; it is the same list drawn on further rows.
  Load-bearing, each with the failure it prevents:
  - **The tile area is a GRID, not a scroller**: `.wl-strip .mkt-group-tiles` is
    `display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--wl-tile-w),
    1fr)); overflow: visible; position: relative; padding: 0 1px 1px 0`, with
    `--wl-tile-w: 60px` on `.wl-strip`. `auto-fill` packs as many columns as the
    band's width holds and `1fr` shares the few leftover pixels evenly, so every
    band has the SAME column width and its right edge is flush; a flex wrap would
    stretch or ragged-end its last line. **There is no `overflow-x: scroll`, no
    `::-webkit-scrollbar` rule and no `overscroll-behavior-x`** — nothing in a band
    scrolls (S42), so the old 8px always-visible bar, the `scrollbar-width`
    trap that disabled it from Chrome 121, and the back-navigation guard all went
    with the row. (Do NOT write the max as a definite `minmax(60px, 80px)`:
    `auto-fill` counts columns by the MAX when it is definite, so it would pack
    fewer, wider columns.) `overflow: visible` and the 1px right/bottom padding pay
    for the seam overlap below. The empty-list placeholder (`.wl-band-empty`)
    spans every column (`grid-column: 1 / -1`) and keeps a tile's height so an empty
    band is still a drop target.
  - **`.wl-tile` is a grid item, 60px at its narrowest** (it was `flex: 0 0 76px`,
    64px tall; it is ~62–66px wide and 57px tall now). Its `margin: 0 -1px -1px 0`
    overlaps neighbouring borders so a seam is one line, not two; it is written at
    THREE classes of specificity (`.wl-strip .mkt-group-tiles .wl-tile`) because the
    shared `.mkt-tile + .mkt-tile { margin-left: -1px }` would otherwise pull only
    the second tile of each row left. Padding is 3px, so a tile has 52px of usable
    width.
  - **The size is held by the TYPE, never by clipping.** `wlTile()` sets a length
    tier from the formatted string, because CSS cannot branch on text length: the
    price is 11px, `is-long` (>7 chars) 10px, `is-xlong` (>8) 9px, `is-xxlong` (>10)
    8px; the change pill is 11px, `is-long` (>7 chars, `+100.50%`) 10px,
    `is-xlong` (>8, `+1234.56%`) 8px; a ticker over 5 characters is `is-long` and
    wraps (`overflow-wrap: anywhere`) rather than shrinking further. Plex Mono and
    the usual fallbacks advance ~0.6em a character, so the arithmetic is: 8 chars at
    10px = 46px, 10 chars at 9px = 51px, 12 at 8px = 54px, against 52. S27 builds
    seven worst cases through `wlTile` itself and measures each against its own
    tile. The EXT/CLOSE badge is an `inline-block; white-space: nowrap` at 6.5px
    with the ticker's tracking trimmed to .02em: where ticker and badge do not
    fit on one line the whole badge drops to the next line — it must never split
    inside the word (`CLOS`/`E`, which `overflow-wrap: anywhere` did at 62px). One
    wrapped badge makes its WHOLE grid row 8px taller (tiles stretch), which is why
    the tracking and size were trimmed until `^GSPC CLOSE` and `BTC-USD EXT` fit.
  - **The empty cells of a part-filled last row are part of the drop zone** (the
    zone is the whole grid box); a pointer there, level with the last row, is
    past every tile in it and drops at the END.
  - **Under 640px the band stacks**: head above the tiles, the tile grid the full
    width of the band and wrapping there too (four columns at 390px). The shared
    `.mkt-group` goes to `flex-direction: column` there, where `flex: 1 1 0` on the
    tile area would set a ZERO HEIGHT basis and collapse the band to its padding
    (Codex review, PR #190), so the stacked block resets it to `flex: 0 0 auto`, and
    the head's fixed 84px resets to its content height.
  - **Drag: the slot is read in READING ORDER** (`wlDropIndex(zone, x, y)`): a tile
    is "passed" when the pointer is below its row, or level with its row and past its
    horizontal middle, and the slot is the number of LEADING tiles passed — so Y
    picks the row and X the place along it, and a pointer below every row or past the
    last tile is the end. (The single-row design decided the slot on X ALONE, because
    a Y comparison counted every tile as passed once the pointer sat on the row's own
    scrollbar; a wrapping band has no scrollbar and several rows, and X alone would
    always answer with the first row.) Y still picks WHICH band, via the drop zone
    under the pointer. S26 drops onto the third tile of a row, onto the first tile of
    the SECOND row, and past the last tile.
  - **Drag: the insertion marker is ABSOLUTE**, positioned by `wlDragPaint` with
    `left/top/height` inside the tile area (`position: relative`): on the left edge
    of the tile the drop would precede, or — past the last tile, or where the pointer
    is still in the row above a tile that opens a new row — on the right edge of the
    previous one. As a grid cell it would take a column and push the last tile of a
    full row onto the next row at every pointer move; the old 3px flex child could
    also nudge the row's scroll width, which is what made the edge auto-scroll loop
    (now moot).
  - **Gone with the row: the edge auto-scroll** (`wlAutoScroll`, `WL_EDGE_PX` 56,
    `WL_EDGE_MAX_STEP` 24, the rAF loop in `wlDrag`, added after Codex's review of PR
    #294). It existed because the pointer owns a drag and a row's scrollbar cannot be
    used at the same time; a wrapping band has every slot on screen. S26 asserts
    `typeof wlAutoScroll`/`WL_EDGE_PX` are `undefined`.
  - **Removed for good, not dormant**: `wlSyncPaging`, `attachPaging`, the ▲/▼
    `.wl-page-bar`/`.wl-page` footer and its CSS, the drag-rests-on-▼ stepping
    (`WL_DRAG_STEP_MS`, `wlDragStepAt`, `_wlStep`), the resize listener that
    re-measured overflow, the `max-height` caps on the column, and (2026-10-04) the
    sideways auto-scroll. S42 asserts no pager markup and
    `typeof wlSyncPaging === 'undefined'`.
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
  name move to its `title` tooltip rather than being dropped. A long price steps down a
  size tier (it never wraps and never clips).
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
  **The watchlist change pill reads at the PRICE's size** (`.wl-pct`, owner
  request 2026-08-21: "bigger, but try to not resize the boxes"). It was the
  smallest thing on a tile whose whole job is to show a move. It was 12px on the
  76px tile; at the 60px grid column of 2026-10-04 it is 11px beside the price's
  11px, and a longer figure steps down a tier (`is-long`, `is-xlong`, above) so
  the widest real value still sits inside the 52px of usable width with nothing
  clipped (S27 guards exactly this, against worst cases built by `wlTile`).
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
