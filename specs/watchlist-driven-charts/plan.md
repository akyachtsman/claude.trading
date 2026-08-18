# Plan — Watchlist-driven charts workbench

Reads `spec.md`. HOW only. Constitution: the inherited directives + `CLAUDE.md`.

## Stack

Unchanged: plain HTML + CSS + vanilla JS, no build. No edge-function change, no
migration, no deploy — both overhauls are client-side, which is what made C1 and
C2 the right calls.

## Architecture

### Overhaul 1 — the two-column rail

`#wbSidebar` stops being a flat list of buttons and becomes two columns.

| | Column A — Manual | Column B — Roster |
|---|---|---|
| Source | `wb_sticky_v1.syms` (localStorage) | the selected roster |
| Header | static label + count | `<select>` of watchlists + "Charts roster" |
| Starts | empty | on the last-selected roster |
| Entries | typed via the existing Load box | that roster's symbols |
| Remove | `×` per row | n/a |

**The store already exists.** `readWbSticky()/writeWbSticky()/addWbStickySym()`
maintain a newest-first list capped at 12. Three changes: raise the cap to 40
(FR-5), add `removeWbStickySym()` (FR-6), and add a `roster` key (FR-8).

**One correctness fix comes with it.** `wbPick()` currently calls
`addWbStickySym()` for *any* symbol not in the charts feed, so clicking a
watchlist name would silently push it into the manual column — which FR-2 says
holds only what the owner typed. The auto-add moves out of `wbPick` and into the
Load-box submit path, its only legitimate caller. Boot re-hydration then needs
`sel` as well as `syms`, since a charted-but-not-manual symbol must still get
its bars refetched.

**Day-% per entry**, without a new fetch:
- charts-roster symbols → the bars already in `data.symbols` (as today)
- watchlist symbols → the `desk-watchlist` payload rows, which already carry it
- manual symbols → `data.symbols` if loaded, else blank until first click

**Clicking an unloaded symbol** reuses the Load box's own fetch. That handler is
extracted to `wbLoadSymbol(sym, note)` so the rail and the form share one path
(FR-9, FR-10) rather than growing a second copy of the quote-proxy call.

### Overhaul 2 — the watchlist panel

**Move.** `<aside class="col-watchlist">` leaves `.top-band` and becomes a
direct `.shell` child immediately before `.area-charts`.

**R-1 resolves by deletion, not by porting.** The `position: absolute` treatment
of Markets and News exists *only* so the watchlist column could drive the row's
height. With Watchlists gone the row is two columns and plain
`align-items: stretch` is correct again, so that block is removed outright.
News becomes the fluid column (Markets keeps its pinned 345 basis), which is
FR-14 — otherwise the row would carry ~800px of dead space at 1512.

**Width.** `.area-charts` opts out of the shell's 1880 cap and full-bleeds. The
watchlist panel now sits directly above it and must opt out identically, or the
two panels it is meant to pair with would not share an edge.

**Vertical columns (FR-15).** The band markup is unchanged — `.mkt-group` >
`.wl-band-head` + `.mkt-group-tiles` — so every behaviour in FR-21…25 keeps its
hooks. Only the axis flips:

- `.wl-strip` → `row` + `wrap` (was `column`)
- `.wl-strip .mkt-group` → `column`, fixed width, `flex: 0 0 auto`
- `.wl-strip .mkt-group-tiles` → `column`, no horizontal scroll
- `.wl-strip .wl-tile` → `flex: 0 0 auto` — **critical**: in a column parent
  `flex-basis` governs HEIGHT, so the existing `flex: 0 0 66px` would set a 66px
  tall tile. This is the same trap the mobile block already documents.
- border collapse moves from `margin-top: -1px` to `margin-left: -1px`
- `.wl-band-head` gets a `min-height` so every column's tiles start level
  (R-3: short columns simply end, they do not stretch — FR-17)

**The ↑/↓ glyphs become ←/→.** They reorder a list among its siblings; with
siblings now side by side, an up arrow that moves a column left is wrong.
`wlMoveBand()` is untouched — only the glyph and the aria-label change.

**R-2 (12 columns ≈ 950px)** is answered by `flex-wrap: wrap`: columns that do
not fit start a second row. No horizontal page scroll at any width (SC-7), and
no inner height cap (FR-19).

## Data flow

```
desk-watchlist ──▶ DESK.data.watchlists ──┬─▶ renderWatchlist()  → vertical columns
                                          └─▶ rail column B      → names + day-%
desk-charts    ──▶ wbState.data.symbols ──┬─▶ drawPane()
                                          └─▶ rail "Charts roster" + day-%
localStorage   ──▶ wb_sticky_v1.syms    ────▶ rail column A
                              .roster   ────▶ column B's <select> selection
click ─▶ in data.symbols? ─ yes ─▶ wbPick()
                          └─ no ──▶ wbLoadSymbol() ─▶ quote-proxy daily ─▶ wbPick()
```

## Main failure modes

| Failure | Handling |
|---|---|
| Watchlists not loaded yet | Column B offers "Charts roster" alone; the `<select>` fills on the next render |
| Saved roster no longer exists (list deleted/renamed) | Falls back to "Charts roster" rather than rendering an empty column |
| Clicked symbol has no data upstream | Note beside the rail names the symbol; nothing is charted, no demo bars substituted (FR-12, real-data-or-nothing) |
| Quote-proxy unreachable | Same note path as the Load box already uses |
| Corrupt `wb_sticky_v1` | `readWbSticky` already try/catches to defaults; `roster` validated against the live list of names |
| Demo mode | No ad-hoc lookups (unchanged); demo watchlists still populate column B |

## Tasks

- **T1** `styles/components.css` — flip `.wl-strip` to row/wrap; `.mkt-group` to
  column with fixed width; tiles column; `.wl-tile` to `flex: 0 0 auto`; border
  collapse to `margin-left`; `.wl-band-head` min-height. *depends: none*
- **T2** `index.html` — move `<aside class="col-watchlist">` out of `.top-band`
  to just before `.area-charts`; add it to the max-width opt-out and give it the
  charts panel's `margin-inline`. *depends: none* `[P]`
- **T3** `index.html` — delete `.top-band > .col-watchlist` rules and the
  `position: relative/absolute` block; make `.col-news` fluid. *depends: T2*
- **T4** `scripts/app.js` — `↑/↓` → `←/→` plus aria-labels in `renderWatchlist`.
  *depends: none* `[P]*
- **T5** `scripts/app.js` — sticky store: cap 40, `removeWbStickySym()`,
  `roster` key with validation. *depends: none* `[P]`
- **T6** `scripts/app.js` — move `addWbStickySym` out of `wbPick` into the Load
  path; re-hydrate `sel` as well as `syms` on boot. *depends: T5*
- **T7** `scripts/app.js` — extract `wbLoadSymbol(sym)` from the submit handler.
  *depends: none* `[P]`
- **T8** `scripts/app.js` — rewrite `renderWbSidebar()` as two columns.
  *depends: T5, T6, T7*
- **T9** `index.html` — `.wb-grid` two-column rail width; rail CSS.
  *depends: T8*
- **T10** Browser verification at 390/1152/1512/1920; gates; cache-bust.
  *depends: T1…T9*
- **T11** New scenarios S40 (rail two columns + persistence) and S41 (vertical
  watchlist columns). *depends: T10*

## Consistency

Every FR traces to a task: FR-1/7/9/10/11 → T8; FR-2/3/4/5/6 → T5, T6, T8;
FR-8 → T5; FR-12 → T8; FR-13 → T2; FR-14 → T3; FR-15/16/17/18 → T1;
FR-19/20 → T1, T10; FR-21…25 → unchanged markup, guarded by T10/T11.

No task introduces scope the spec did not ask for. The one addition beyond a
literal reading — moving `addWbStickySym` out of `wbPick` — is required by FR-2
rather than opportunistic: without it column A fills with names the owner never
typed.
