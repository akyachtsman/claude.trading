# Watchlist quick add, double-click remove and the detail window

Tile gestures (quick add, double-click remove, single-click detail) and the symbol detail window (`wlWireRemove`, `openWlDetail`; scenarios S21, S35).

  **Quick add / double-click remove** (owner request 2026-07-30) — per-list edits
  without opening the full ✎ editor. A small round **+** sits in each band's
  gutter beside the list name (`.wl-band-head`) and opens a dialog that adds
  symbols to THAT list; a **double-click** on a tile (`wlWireRemove`) opens a confirm dialog
  before removing it — owner ruling 2026-07-30, replacing a hold that went
  3s → 1s → gone. The confirm dialog was always the real safety net, so the
  gesture only has to beat a stray single click. **`touch-action:
  manipulation` on `.wl-tile` is load-bearing**: mobile browsers reserve
  double-tap for zoom and would swallow the gesture, so without it removal
  works on a desktop and silently does nothing on a phone. A locked-state
  signpost (a disabled ✎ pointing at the PIN field) was built and removed the
  same day — **owner ruling: the edit controls are not to be tied to unlock
  messaging.** (The PIN-gated `desk_set_watchlists` still exists, but the
  panel writes through `desk_set_watchlists_open`, which is anon-callable.)
  Both are gated on
  `wlCanEdit()` (live + authed) exactly like the ✎ — the roster lives behind the
  PIN RPCs, so unauthenticated there is nothing to write to and NO write control
  renders. Both route through **`wlMutate()`**, which does an authoritative
  `desk_get_watchlists` read → mutate → `desk_set_watchlists` replace-all: never
  a patch of the rendered payload, because that payload omits unresolved symbols
  (the `desk_009`/PR #188 hazard) and can be an hour stale when the market is
  shut, so an add built from it would silently roll back an edit made elsewhere.
  Three details that are load-bearing, not polish: the tile **fills** as the
  hold progresses (a silent 3s wait reads as a dead control) in
  `--color-accent-bright`, NOT gain/loss red, since those colours are P&L-only;
  a **drag cancels** the hold (>10px), or resting a finger on a tile while
  scrolling would arm a removal; and **Delete/Backspace on a focused tile**
  reaches the same dialog, because a hold is pointer-only and a remove only a
  mouse can reach is not a remove everyone has. The confirm dialog is
  `role="alertdialog"` and opens focus on "Keep it".
  **Symbol detail window** (`#wlDetailBackdrop` / `openWlDetail()`, owner request
  2026-08-06) — a SINGLE click on a tile opens a larger read-only view: full
  quote (last, change, and the after-hours print on its own marked line), key
  stats (bid/ask, earnings, market cap, P/E, 52-week, yield) and a large candle
  chart with volume, SMA 20/50 and its own 1D…5Y span control. **The load-bearing
  part is the gesture collision, not the window.** Double-click already removes a
  tile, and a double-click delivers a `click` FIRST — so a naive handler would
  open the window underneath every removal and then swallow the second click,
  breaking removal outright. The open is therefore deferred by `WL_CLICK_MS`
  (250ms, under the ~500ms platform double-click threshold) and cancelled by the
  tile's own `dblclick`. The defer applies **only where a removal is actually
  wired** (`wlCanEdit()`); in demo there is no dblclick listener to protect and
  lagging the open there would pay for a conflict that does not exist. A
  completed drag also ends in a `click` on its source tile, so `wlDragEnd` stamps
  `wlDragClickAt` and the handler ignores clicks for `WL_DRAG_CLICK_MS` — without
  it, arranging the panel opens a window on every drop. Three further rules: the
  window is wired **outside** the `canEdit` gate, because opening it READS a
  symbol and must not depend on an unlock any more than the edits do; it opens on
  the PANEL's span (`wlTf`) so the chart is the tile's own line made bigger, and
  changing the span inside the modal is local — it must never retime `wlTf`, which
  every tile sparkline reads; and `loading` is **tracked, not inferred** from
  `(bars === null && info === undefined)`, since on a span change the new window
  clears `bars` but keeps the quote, and the inferred form claimed "no chart data"
  during an ordinary reload and lamped a healthy backend STALE before its first
  reply landed. Live is real-data-or-nothing (`quote-proxy` `kind:'daily'` sliced
  to the span, `kind:'intraday'` for 1D, plus `kind:'info'`); a failure renders the
  empty state under a STALE lamp, never a demo series under a real ticker. Demo
  seeds its own OHLC per symbol (`buildDemoDetailBars`), walked backward from the
  tile's own price so the last candle closes exactly on the number that opened it
  — the ten names in `DEMO_CHART_SYMBOLS` are far narrower than the rosters, and a
  window that opened blank on most demo tiles would hide the faults demo exists to
  surface. **Moving averages are owner-selectable** (2026-08-08): SMA
  25/50/100/200 as checkboxes beside the span control, defaulting to 25+50 and
  persisted in `localStorage` (`wl_detail_smas_v1`) because it is a reading
  preference, not per-symbol state. **SMA (1) is deliberately absent** — a
  1-period average IS the close, which the candles already draw, so it would be
  a control that changes nothing. Colours come from the workbench's own
  `SMA_COLORS`, so a 50 here is the same colour as a 50 on a Pro pane; the old
  hard-coded 20/50 pair used the generic series ramp and matched nothing. A line
  still only draws once **fully warmed**, so on a short span a ticked 100 or 200
  legitimately shows nothing — the swatch in the control is the chart's key.
