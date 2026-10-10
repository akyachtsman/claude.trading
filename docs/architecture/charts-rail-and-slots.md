# Charts symbol rail and the 100-slot editor

`scripts/app.js` charts-workbench symbol rail: the SYMBOL column (100 positional slots edited in place), the ROSTER column and picker, the rail width budget, and the click / blur / focus / scroll rules of the slot editor (`renderWbSidebar`; scenarios S40, S45).

- `scripts/app.js` — all rendering + interactions (accounts with per-card
  equity sparklines, news, ask-the-desk panel, the Markets window, stochastic
  charts workbench, PIN lock/unlock flow) + the
  **charts SYMBOL RAIL is TWO COLUMNS** (`renderWbSidebar()`, owner request
  2026-08-17), replacing one flat list that mixed the fixed 25-name roster with
  every ad-hoc ticker typed, so there was no way to separate "names I pulled up"
  from "the roster someone configured". **SYMBOL** (left) is **100 PERMANENT
  SLOTS the owner edits IN PLACE**; **ROSTER** (right) is headed
  by a `<select>` of the owner's watchlists plus a `WB_ROSTER_CHARTS` entry for
  the 25-name charts roster — kept, not retired (owner ruling), because its 800
  bars are already loaded so those names chart instantly. Two rules are
  load-bearing on the roster side: `restoreStickySymbols`
  re-hydrates **`sel` as well as `syms`**, since a watchlist symbol left
  selected is no longer in `syms` and would return with no bars; and
  `renderWatchlist` ends by repainting the rail, because the two feeds land
  independently and desk-charts usually wins, so the picker's first render sees
  no lists and would otherwise stay a one-entry dropdown all session.
  **THE LIST IS THE EDITOR** (owner ruling 2026-08-26: "I didn't want a field to
  push into the list. I want every item in the list to be editable. And the list
  has 100 slots accessible via scroll just for the list" / "I don't need the x to
  delete a item. the 100 entries, filled or empty is permanent"). This REPLACES
  the add-box-plus-stack shipped hours earlier in PR #281, and the replacement is
  structural rather than cosmetic — the storage changed meaning. `WB_MANUAL_MAX`
  40, the `×` per row, `addWbStickySym`/`removeWbStickySym`, the add box and the
  whole **pin** mechanism (`wbLoadSymbol({pin:true})`) are **deleted**:
  `wb_sticky_v1.syms` is now **POSITIONAL and always exactly `WB_SLOTS` (100)
  long**, holes included, so index IS the slot. `wbSlotArray` pads, truncates and
  junk-fills on every read, and `setWbSlot` writes one index — a `filter()`
  anywhere here would renumber every row below a hole and silently move the
  owner's symbols. A pre-2026-08-26 stack migrates by landing in slots 0..n-1 in
  the order it was already displayed. **NOTHING PINS ANY MORE** — not the loader,
  not a roster click. Charting a symbol charts it and
  writes no slot, which is what makes the column mean "what I typed". **The ONE
  exception, added 2026-10-08, is the header Load box's SUBMIT — see "The Load
  box adds what it charts" below.**
  What follows is all load-bearing. **A slot is a cheap `<button>` until
  double-clicked, and at most ONE is an `<input>` at a time** (`wbEditSlot` /
  `wbEditDraft` in module state): `renderCharts` rebuilds this rail on every
  animation frame of a chart drag, and a hundred live inputs per frame is work
  the rail cannot afford. The gestures collide by nature — **single click charts,
  double-click edits**, and a double-click delivers a `click` FIRST. **NOTHING IS
  DEFERRED, and that is the fix for THREE Codex P2 findings at once** (PR #282).
  The first cut copied the watchlist tiles' device — defer the single action,
  cancel it from `dblclick` — and every one of those findings is the same root
  cause: deferring makes the platform's pairing threshold and OUR wait two
  INDEPENDENT numbers. A threshold LONGER than the wait charts on the first
  click, so opening a slot to edit it also retimes the pane — and the owner is on
  **macOS, where double-click speed is user-configurable well past 250ms**. A
  pending timer also outlives any newer navigation: a roster click inside the
  window charts, then the older timer fires and pulls the chart BACK, and
  `wbLoadGen` cannot see it because the stale load does not exist yet when the
  newer one runs, so it is born holding the newest generation. And `dblclick`
  needs BOTH clicks on the SAME node, which an editor committing on blur between
  them destroys. So the first click charts **immediately**, and a second click on
  the SAME SLOT within `WB_SLOT_DBL_MS` (500, **ours**) opens the editor — one
  number governing both halves, so they cannot disagree — tracked in module state
  keyed by slot **INDEX, not by node**, since charting rebuilds the rail. The
  `dblclick` event is not used at all. **The trade is stated rather than hidden:**
  a double-click charts that slot before opening it, so the pane briefly shows the
  symbol being edited. That is coherent (it is the slot's own symbol) and it buys
  back the 250ms lag the defer put on the primary action. Note the slot-to-slot
  case CANNOT be falsified in this sandbox — Chromium dispatches `dblclick` to the
  replacement node, so the old design passes it too; the **slow** double-click is
  the one S45 proves, measured at a 300ms gap opening no editor at all under the
  defer. **F2 is the KEYBOARD path to
  the editor** — a double-click is pointer-only, and Enter/Space on a focused
  button fires `click`, which CHARTS a filled slot rather than editing it, so
  without F2 a filled slot could only ever be changed with a mouse. That is the
  same rule the watchlist tiles follow with Delete/Backspace: an edit only a
  mouse can reach is not an edit everyone has. The gesture is stated in the
  button's `title`, NOT its `aria-label` — a screen reader would otherwise read
  the same hint on all 100 rows, and the label's job is to say which slot this is. **A BLUR IS NOT ONE OUTCOME
  BUT THREE, and telling them apart is the whole job** — this is the subtle part,
  and none of it was visible in a browser probe that looked complete. The blur is
  deferred a tick, and in that tick:
  (1) the input is **still connected** — an ordinary blur (the owner clicked
  elsewhere, or tabbed away); commit normally.
  (2) **detached, and this slot is still the one being edited** — a repaint the
  owner did not cause. `renderWbSidebar` tears the input out, which FIRES BLUR,
  so `renderCharts` (every animation frame of a chart drag, every 60s poll) would
  otherwise save half a ticker, chart it and close the editor mid-word. The
  `wbEditSlot` guard inside `commit` cannot see this — the slot is still open and
  the stale closure still names it, so the guard passes. Do nothing: a newer
  input already holds the draft and the focus.
  (3) **detached, and ANOTHER slot is now being edited** — the owner clicked
  straight from this slot to that one, and that slot's `openEditor` re-rendered
  before this timer ran. Save what was typed, but do NOT chart it: their
  attention has moved. **Case 3 is why `isConnected` alone is not enough** — it
  reads exactly like case 2 and is the opposite, so the first fix silently
  DISCARDED every edit the owner clicked away from, and clicking slot to slot is
  ordinary use. A `settled` flag covers the fourth path: Escape must not be undone
  by the blur its own re-render fires a tick later.
  **A BLUR CLOSES ITS OWN ROW (`closeRow`) AND MUST NEVER REBUILD THE RAIL.**
  This is not a micro-optimisation, it is the fix for a failure that **passed
  locally every time and failed on ALL THREE CI viewports** (Codex saw the
  mechanism first; CI proved it). The commit is deferred a tick, and on any
  machine slower than a warm laptop that tick lands BEFORE the pending click is
  delivered. A full `renderWbSidebar` there detaches the button the owner is
  mid-click on, so the click event is **never dispatched at all** — clicking from
  one slot's editor to another did *nothing*, no editor anywhere. Replacing the
  single row leaves every other node, including the one being clicked, where it
  was. Reproduced deterministically by separating mouse-down from mouse-up by
  60ms, which is what S45 now does; falsified, it returns `editor=null`, exactly
  what CI reported. Blur therefore also **never charts** — only Enter does, plus
  a click on a slot. A **`pointerdown` version of the gesture was built for this
  and REJECTED**: once `closeRow` was in place it could not be falsified in any
  case, and unlike an inert guard it changes real behaviour (acting on press
  removes press-drag-away-to-cancel, and its `preventDefault` suppresses focus).
  **`touch-action: manipulation` on `.wb-slot` is load-bearing** (Codex P1), the
  same rule `.wl-tile` follows: mobile browsers reserve the double-tap for zoom
  and would SWALLOW the edit gesture. On a touch-only phone that gesture is the
  ONLY way to edit a filled slot — F2 needs a keyboard — so without it an owner
  can fill an empty slot once and then never change or clear it.
  **The column is ONE TAB STOP, not a hundred** (`wbSlotTab`, roving tabindex,
  Codex P2). Native buttons are all tabbable, and this column precedes the roster
  in DOM order, so 100 of them put the ROSTER up to 100 Tab presses away and made
  F2 largely theoretical — you could not reach a deep slot to press it. Arrow
  keys, Home and End move within the list and carry the tab stop with them; a
  click moves it too, so Tab returns to the slot last worked on.
  **A commit CLOSES the row before it charts, always** (Codex P2). `wbLoadSymbol`
  is async and only repaints VIA `wbPick` on success, so charting first left a
  logically-settled editor on screen whose handlers reject every later Enter,
  Escape and blur — inert until something else happened to repaint. Demo mode, a
  no-data reply and an unreachable proxy all take that path, so it was reachable
  by simply typing a ticker under `?demo=1`.
  **The re-fetch queue is DEDUPED and VALIDATED** (Codex P2, rounds 2 and 4): a
  positional column can hold the same ticker in several slots, and an
  unresolvable one never lands in `wbRealSyms`, so a column repeating one bad
  symbol re-requested it once per slot on every cold start. It is filtered
  through `WL_SYM_RE` for the same reason the Enter path refuses to chart an
  invalid draft — a slot deliberately KEEPS text that fails the validator, so
  without this every syntactically impossible entry was posted to quote-proxy on
  every live reload. The filter is on the QUEUE; the stored array keeps its
  holes and its junk, because there an index IS a slot.
  **A pending slot pair is BROKEN by any other navigation** — a roster click, the
  header Load box's SUBMIT, the header input's **`change`** handler (which
  reaches `wbPick` directly, without the loader, so the submit reset does not
  cover it) and **an editor opening** all reset `wbSlotClick` (Codex P2, rounds
  2, 3 and 4). **Keep that list complete**: it took three rounds to find all four
  doors, and each missing one has the same symptom — a slot click read as the
  second half of a stale pair, so it edits instead of charting. **BOTH HALVES must be
  POINTER clicks**: Enter/Space fire a synthetic click with `detail` 0, so two
  activations inside the window — or Enter auto-repeating while held — opened the
  editor, contradicting F2 being THE keyboard edit gesture. Gating only the CHECK
  was half a fix and took a fifth round to finish: the synthetic click still
  RECORDED itself, so Enter followed by a pointer click inside the window opened
  the editor too. A keyboard activation is navigation like any other, so it also
  breaks a pair already pending. Otherwise clicking slot A, then a roster name, then slot A
  again inside the window reads the last click as the second half of a pair: it
  opens A's editor and does NOT chart A, leaving the pane on the roster symbol
  rather than the newest thing asked for. The editor is navigation too, and
  missing that had its own symptom: click an empty slot, type a ticker, commit —
  and the next click on the now-filled row reopened the editor instead of
  charting, so a slot could not be charted immediately after being filled.
  **The roving tab stop moves through `setWbSlotTab`, which updates the LIVE
  buttons, not just module state** (Codex P2). Assigning `wbSlotTab` alone is
  only correct when a repaint follows, and one does not always follow:
  `wbLoadSymbol` never repaints when the lookup fails — a persisted unresolvable
  symbol, demo mode, an unreachable proxy — so the clicked row kept `tabIndex`
  -1 and Tab went back to the row before it.
  **SETTLING an editor keeps focus on that slot** — `closeRow` carries focus onto
  the button it puts in place of a focused input, and Escape does the same after
  its repaint (Codex P2). `renderWbSidebar`'s own restore cannot cover this: it
  snapshots a focused `.wb-slot` BUTTON, and what is focused at that instant is
  the INPUT. Without it a keyboard user is dropped to the document the moment
  their edit lands. Falsified: focus went to `BODY` on Enter.
  **A focused slot BUTTON is preserved across a repaint, exactly like the input**
  (Codex P2). Charting from the keyboard runs synchronously into `wbPick`, whose
  render removes the button that was focused; with nothing restoring it focus
  fell to the document and the Arrow keys and F2 stopped responding until the
  owner tabbed all the way back in — and this column is a SINGLE tab stop, so
  that is a long way back. Falsified: focus landed on `BODY`.
  **`.wb-slots` SCROLL POSITION is restored across a render**, same class as the
  caret and `preventScroll`. The list is rebuilt here, so its `scrollTop` resets
  to 0 — and this rail repaints every 60s, so an owner scrolled to slot 60 is
  yanked back to slot 1 by a repaint they did not cause. It also breaks the
  gesture outright rather than merely annoying: a double-click's FIRST click
  opens the editor, the re-render scrolls the list away under the SECOND click,
  and the editor opens on a different slot than the one clicked — **measured,
  clicking slot 30 opened slot 28**, and 17 with the restore removed. S45 now
  exercises a DEEP slot for exactly this reason: rows 3/5/7 need no scroll, which
  is why the first version of the scenario could not see any of it.
  **`overflow-anchor: none` on `#wbSidebar` and its subtree is the OTHER half,
  and it is not the same fix.** `renderWbSidebar` EMPTIES the rail and rebuilds
  it, and Chromium compensates for that content change by adjusting the nearest
  scroller — **the PAGE**. Measured with the rail's top above the viewport
  (ordinary: this panel sits far down the page), opening a slot editor scrolled
  the page **31px**, which put slot 58 under a pointer aimed at 60. It **cannot**
  be fixed by saving and restoring `scrollY` around the render: the adjustment
  happens during LAYOUT, after the synchronous block has already read an
  unchanged value — `keepPageStill` is synchronous and did not see it. Excluding
  the subtree from anchor selection stops it at the source. This is also why S45
  **sets that geometry explicitly** rather than trusting where earlier steps left
  the page: the check passed or failed by luck, 1–2 runs in 3, purely on whether
  the page had drifted to the exposing position.
  **`restoreStickySymbols` filters the holes out — there and ONLY there.** `syms`
  is 100 positional entries, mostly empty on a real desk, so feeding it straight
  into that serial loop fired ~100 `deskQuote('')` calls at quote-proxy on every
  live boot. Filtering is right in a re-fetch QUEUE, where neither order nor
  position means anything, and wrong in the STORE, where an index IS a slot.
  **And the queue is BOUNDED, not serial** (`WB_RESTORE_LANES` 4, Codex P2): the
  old manual column capped this at 40 and awaited each in turn, so 100 filled
  slots is the SUM of every proxy round-trip — most of a minute cold. Bounded
  rather than unbounded too, since 100 parallel requests to one origin only move
  the stall into the browser's connection queue. The **selected** symbol is
  fetched first and ALONE and repaints immediately — it is the chart the owner is
  waiting for — while the pool's repaints are coalesced to one per frame instead
  of one per response.
  **NOTHING CHARTABLE ⇒ the click opens the EDITOR** — an empty slot and one
  holding a draft that fails `WL_SYM_RE` behave alike, because neither has
  anything to chart (Codex P2, round 6). Charting it anyway posted quote-proxy a
  value the client already knew was not a ticker, while the Enter path and the
  re-fetch queue both declined it — three paths, one rule, and this was the last
  one still disagreeing. Opening the editor is the useful answer as well as the
  cheap one: it puts the bad text in front of the owner, selected, to correct.
  The row's `title` says so, since the gesture there is a SINGLE click.
  And **a slot keeps whatever was typed even when it does not resolve** (owner ruling, asked and answered): the
  save and the chart are separate acts, so a bad entry is never discarded or
  rewritten — accepted knowingly as the silent-failure class it is.
  `wbLoadGen`/`WB_SUPERSEDED` SURVIVE the rewrite: the rail no longer reads the
  outcome, but the header Load box, a roster click and a slot commit still race
  each other, and cancellation must stay distinguishable from failure.
  The rail carries **NO day-%** at all (owner request
  2026-08-25). It is a navigation list — its job is "which ticker am I looking
  at" — and the width it spent on a percentage went to the Pro panes instead
  (`.wb-grid` first column 240 → **200px**, ~40px to the chart).
  Removing it RETIRES a whole class of fault rather than fixing it again: the row
  sits directly under the charts header, which prints the same symbol's move, so
  the two were permanently comparable and were twice reported as contradicting
  each other — first two different VINTAGES (the rail read bars/watchlist while
  the header read the live quote, PR #277), then two different MEASUREMENTS (the
  header renders `changePct` while the rail preferred `extPct`, so every symbol
  with an after-hours print disagreed by exactly that move). One number cannot
  contradict itself. `wbRailPct`, the `preMarketOpen` gate it needed, that
  gate's hoisted `NY_PARTS` formatter and scenario **S44** all went with it —
  deleting S44 is not lost coverage, since the behaviour it guarded no longer
  exists. **The ticker NEVER abbreviates — that is the rule; the width is only ever
  derived from it.** `.wb-grid`'s first column went 96 → 200 → 240 (when it
  still carried a day-%) → 200 → **154px** (owner request 2026-08-25, "reduce
  the width of these two columns to a min and give more space to the pro
  charts"). Read the rule, never the number: a clipped symbol names no
  instrument on a rail whose whole purpose is being clicked by ticker (owner
  report 2026-08-20, when 4-letter names rendered as `AV…`), and `WL_SYM_RE`
  accepts **ten** characters with `DX-Y.NYB` and `BTC-USD` already in the
  roster. **160 was tried and REJECTED in review** on the same day 200 was set:
  at 12px IBM Plex Mono (~7.22px/glyph) ten characters need ~72px of ticker
  alone, and a 160px rail's manual column offered **56**.
  154 reaches a narrower rail than that rejected 160 **without touching the
  rule**, because it makes the glyphs and the chrome cheaper instead of the
  budget tighter — which is the whole lesson: the earlier attempt tried to buy
  width out of the ticker's own allowance, and there was none to take. Three
  measured savings, in order of size: the row font goes **12px → 10px** mono, so
  ten characters cost **60.2px** instead of 72.3; **the two columns stop being
  equal** (`.wb-rail-manual` `flex: 0 0 78px`, `.wb-rail-roster` `flex: 1 1 0`),
  since only the manual column carries a `×` and forcing the roster to match it
  spent ~12px per rail on nothing; and row padding 4px → 2px a side with the `×`
  3px → 2px. Measured at 1512: **rail 200 → 154, chart 1170 → 1216 (+46px)**,
  with ~3.9px of headroom in BOTH columns — slightly MORE than the 3.3px the
  200px rail had. The type drop is the biggest contributor and is the first
  thing to give back if this ever needs to grow: it is a legibility cost, where
  the unequal split and the padding were pure waste. Equal columns are the tidy
  default and were simply wrong once the two rows stopped being the same shape.
  `scrollbar-width: thin` on `.wb-rail-col` is part of the budget, not
  decoration: two classic 15px bars would eat most of what the width buys.
  **The LEFT column is a SYMBOL column** (owner request 2026-08-26, from a
  reference-platform screenshot): title `SYMBOL`, an `ACTIVE` section naming the
  charted symbol, then the 100 slots. Only the LEFT column changed — the roster
  column beside it was explicitly left alone, since it mirrors the watchlists.
  `ACTIVE` stated what the rail previously only implied with `aria-current`, and
  answered the case that marking could not: a symbol charted from the roster, or
  restored on reload, that is not in this column at all. **The ACTIVE section was
  REMOVED 2026-10-09** (owner, with a screenshot of HOOD drawn twice under the entry
  box: "now I'm seeing double entries. We remove one"): every push puts the charted
  symbol in slot 0, so the row repeated the first slot after every push. The
  charted symbol is still marked where it stands (`aria-current` and a background on
  its slot and on its roster name) and the pane header names it; a symbol charted from
  the roster that is not in the column is marked in the roster column only. The header **Load box
  stays** (owner ruling, asked and answered), and until 2026-10-08 it wrote
  NOTHING — it charted, like every other path (it now ADDS what it charts, see
  "The Load box adds what it charts"). Both it and a slot commit validate with the
  shared `WL_SYM_RE` (the submit handler had an inline third copy of that regex;
  it is gone).
  **THE FIRST CUT OF THIS WAS WRONG AND IS WORTH RECORDING.** PR #281 shipped an
  add box that pushed onto a stack — a faithful reading of the screenshot's input
  field, and the owner rejected it within the hour: "I didn't want a field to push
  into the list. I want every item in the list to be editable." The screenshot's
  input was not an ADD control, it was the SELECTED ROW being edited. A whole
  round of race-hardening (`wbRailDraft`/`wbRailMsg`/`wbRailGen`, the optimistic
  clear, the pin-on-success rule, five Codex rounds) existed only to make that
  box safe and was deleted wholesale. **Three of its findings SURVIVE, because
  they are properties of any in-place editor, not of the box**, and each had to
  be re-guarded after the rewrite silently dropped it:
  (a) **`maxLength` is 24, NOT the validator's 10.** It caps the RAW value and
  the browser applies it before any handler runs, so a 10-cap truncates a pasted
  ` ABCDEFGHIJ ` to nine characters — a real but DIFFERENT instrument, the
  wrong-number-wearing-a-plausible-face fault this desk keeps hitting.
  `WL_SYM_RE` stays the authority after trimming. **S45's guard for this has now
  been INERT TWICE**, which is why the padding is spelled out here: it must type
  through real key events (assigning `el.value` bypasses `maxlength` entirely)
  AND the value must be PADDED — a bare `ABCDEFGHIJ` is exactly ten, so a
  regressed cap does not truncate it and the check stays green. Falsifying the
  current form yields `Expected " ABCDEFGHIJ ", Received " ABCDEFGHI"`.
  (b) **The WHOLE selection is preserved** — both offsets AND
  `selectionDirection`, not just `selectionStart`. A collapsed caret makes the
  next keystroke INSERT where it should REPLACE, and a lost direction changes
  which end Shift+Arrow extends. S45 makes a BACKWARD selection and asserts the
  direction, since asserting the offsets alone left the direction capture
  deletable; the input must hold a value first, or every range clamps to 0,0.
  (c) **`focus({preventScroll: true})` is load-bearing, not a nicety.** The rail
  repaints on the 60s poll, so a plain `focus()` yanks an owner who had scrolled
  away back to the charts. Measured on falsification: the page jumped **1616px**
  originally, **1684** when re-falsified on the slot rail. S45 had NO guard for
  this until 2026-08-26 — a fourth guard the rewrite silently dropped — and it is
  the single most owner-visible thing in this file. `select()` was replaced by
  `setSelectionRange` beside it (same text, narrower contract); `keepPageStill`
  wraps both as a **cross-engine belt that is honestly UNFALSIFIABLE here** —
  measured, Chromium's selection calls do not scroll, so removing it changes
  nothing observable. Do not record a measured fault for it; the measured ones
  are `preventScroll` (1684px) and `overflow-anchor` (31px). `keepPageStill` DOES
  mask a lone plain-`focus()` regression (it scrolls the page back), which is why
  S45's guard clicks EMPTY slot 90, asserts the editor is focused and off-screen,
  and stubs `scrollTo` for that one repaint to isolate the focus call — falsified:
  scrollY 0 → 2126px on desktop, 4163px on mobile-chrome.
  **What the rewrite ADDED is the blur/repaint interaction** — see the
  `inp.isConnected` rule above. It is the same class as (a)–(c): a repaint the
  owner did not cause quietly changing what their typing does.
  Two CSS rules are load-bearing for the column itself. **`.wb-slots` carries its
  own `overflow-y: auto` plus `min-height: 0`** — the slots scroll beneath a
  fixed head (the entry box; it was `SYMBOL`/`ACTIVE` until 2026-10-09) ("100 slots accessible via scroll just for the
  list"), and without the `min-height` a flex item defaults to `min-height: auto`
  and would grow to its full 100-row content height, taking the rail with it.
  And **`.wb-slot-input` carries `min-width: 0`**, because an input's default
  intrinsic width (~20 characters) would otherwise push the column past its flex
  basis and undo the 154px rail.
    **2026-10-09 — THE PICKER IS THE ROSTER COLUMN'S OWN HEAD AGAIN, on the same line as the entry box over the SYMBOL column** (owner, with a
  screenshot: "align everything nicely so that the radar will line up with the second column and not expand the two columns"). There is no
  full-width row above the columns, no `.wb-rail-top`, and no SYMBOL / ROSTER title rows: each column has ONE head control of the same 20px height (the
  entry box, `.wb-entry-input`, and the picker, `.wb-rail-pick`), each exactly as wide as its column. The cost is the one the passage below records: in
  the narrow roster column a long list name is cut with an ellipsis (`text-overflow` on the select), its whole name staying in the tooltip (`sel.title`)
  and in the open menu — the owner chose the alignment over the full names. S40 pins the geometry (same line, same height, lined up with its own column
  and no wider). The rest of this passage is the HISTORY of the full-width header and describes what is gone.

  **The ROSTER PICKER WAS A FULL-WIDTH HEADER over both columns**, not the roster
  column's own head (Codex P2, 2026-08-25). Inside a 68px column it had ~**45px**
  of text room against the ~**82px** its own default "Charts roster" label needs,
  so 6 of demo's 8 list names truncated and the control could no longer answer
  the one question it exists to answer — which roster is loaded. Spanning the
  rail gives it **131px**, which seats every name including `Industry & metals`
  (99.6px); measured overflow is now zero. It cost ~20px of VERTICAL space and
  **no chart width at all** — which is why it beat the alternative of widening
  the roster column to fit the label, which puts the rail back at **191px** and
  cuts the chart's gain from 46px to **9**, undoing the request. Vertical space
  is not scarce in a rail capped to the chart's height. Three consequences:
  `#wbSidebar` is a `flex-direction: column` (it was a row of two columns) with
  a `.wb-rail-cols` row inside it; that row needs **`min-height: 0`**, since a
  flex ITEM defaults to `min-height: auto` and would refuse to shrink below its
  content, which stops the per-render rail cap from capping anything and lets a
  long roster grow the grid row instead of scrolling; and the roster column
  gained its own **`ROSTER` title**, because the picker used to serve as that
  column's head and the two columns must still start on the same line.
  `sel.title` is KEPT even so — an owner-created list has no title-length limit,
  so a long enough name still truncates — and is read from the selected
  **OPTION's TEXT, never `sel.value`**: the charts entry's value is the
  `WB_ROSTER_CHARTS` sentinel, a NUL-prefixed token, so the obvious
  `sel.title = sel.value` would show the owner an internal string instead of a
  list name (verified in the browser, where it renders "Charts roster").
  **The sentinel is written as the escape `'\u0000charts'`, NEVER a literal NUL
  byte** (audit 2026-09-29): a raw one sat in `app.js` from #248 (2026-08-18) and
  made ripgrep/the Grep tool treat the whole file as binary, silently skipping it
  on every directory search for six weeks — exactly the searches "is there already
  an implementation of this?" depends on. No raw control byte belongs in a source
  file; `rg -c renderWbSidebar scripts/` returning `app.js` is the quick check.
  **S40 budgets against the VALIDATOR, not against demo.** Demo carries ten
  three-letter symbols, so a five-character budget passed on a 160px rail that a
  real supported symbol would have broken — a budget that admits less than the
  validator accepts is not a budget. It measures **BOTH columns** against the
  full 10-character limit and also asserts no rendered ticker is clipped.
  Critically it reads the **computed
  font off the live element** rather than hardcoding a pixel figure, which is
  why the 12px → 10px change needed no test edit: at 154 it re-derived its own
  expectation as 60.2 and still failed at **58** when the SYMBOL column was
  narrowed to 62px to falsify it (proved, this pass — as it was proved at 200 by
  setting the rail back to 160). It was briefly LOST when S40 was rewritten for
  the slot column and restored in the same pass; do not let a rail rewrite drop
  it again, since it is the only thing holding the never-clip rule.
  **The 78/68 split is UNCHANGED in number and CHANGED in reason.** It used to
  pay for the `×` on every manual row; that control is gone, and the same ~10px
  is now the SYMBOL column's **scrollbar allowance**. This is a real difference,
  not bookkeeping: the SYMBOL column is 100 permanent slots, so `.wb-slots`
  ALWAYS overflows, where the old 40-row stack usually did not. Where a thin
  scrollbar takes layout width (~11–12px) the column still offers **62px**
  against the **60.2** a ten-character ticker needs — so it now CLEARS that case
  rather than accepting it, and narrowing it to the roster's 68 would leave 52
  and clip. **The residual survives on the ROSTER column ONLY** (owner ruling
  2026-08-25, re-affirmed at 154): 3.8px of headroom and no scrollbar allowance,
  so where a bar reserves width a **9- or 10-character** symbol could clip;
  **8** (`DX-Y.NYB`, the longest in the roster) still fits. This sandbox's
  Chromium uses OVERLAY scrollbars and reserves nothing, so it CANNOT reproduce
  the case. Covering it now costs ~**12px** rather than the old 24. The TRIGGER
  to revisit is concrete: if a 9–10 character symbol enters a WATCHLIST, or the
  desk is used where scrollbars take layout width, widen the roster column and
  add the scrollbar to S40's budget. Note this is the same class as the
  `overscroll-behavior` trap below — a Chromium harness cannot reproduce it, so
  it must be reasoned about rather than tested here.

## Rail height: two layouts, two caps (fixed 2026-09-30)

`#wbSidebar` is capped differently depending on where it stands, and the two caps
come from different places on purpose.

| Layout | Where the rail is | Cap | Where it lives |
|---|---|---|---|
| Beside the chart (861px and up) | left of the pane bars | the chart column's height (pane bars + canvas) | `renderCharts` publishes it as the custom property `--wb-rail-h`; the base `#wbSidebar` rule reads `max-height: var(--wb-rail-h, 600px)` |
| Stacked (860px and down) | ABOVE the chart | a fixed 220px | `#wbSidebar { max-height: 220px }` in the SECOND `@media (max-width: 860px)` block, after the base rule |

Why it is a custom property and not an inline `max-height`: an inline style beats
every stylesheet rule, so while `renderCharts` wrote the chart's height inline the
stacked cap could not apply however it was written. The 220px rule also sat in the
FIRST 860px block, BEFORE the base rule at equal specificity, so it lost on source
order too — two independent reasons it did nothing, and nothing failed. Measured
before the fix: a 460px list over a phone's chart (393px wide), 734px at 860px, and
**891px over an iPad's** (810px). After: 220px at every stacked width (the slot list
window inside it is 130px, about eight rows of the 100); the side rail (746px) and
every chart height (356 / 451 / 815 / 658 / 670 / 694 across the widths measured) are unchanged.

Keep three things:
- **Never write the cap inline.** `renderCharts` collapses the rail with an inline
  `max-height: 0px` BEFORE it measures (a long roster would otherwise stretch the
  grid row and shorten the chart), and clears it (`''`) once `--wb-rail-h` is set.
  Clearing it is what lets the stylesheet decide.
- **The stacked rule must stay AFTER `#wbSidebar`'s base rule** — the same
  equal-specificity source-order trap as the stacked column split and the
  `.top-boxes` overrides.
- **The 0px collapse stays**, because the chart's height is measured with the rail
  out of the way. Removing it would make the stacked chart shorter by the rail's height.

S53 guards it at each project's OWN width (desktop beside; tablet, mobile-chrome
and iphone stacked): computed cap and rendered height in both layouts, and an
EMPTY inline `max-height`. S45's deep-slot check seats slot 60 three-quarters of the
way down the list's own scroll window rather than at a fixed offset, because the
stacked list is only ~130px tall — a fixed "rail top 70px above the viewport"
pushed the slot off screen there (the pointer landed on nothing). Falsified: with
`overflow-anchor: none` removed S45 still fails (slot 58 under a pointer aimed at
60) in both layouts.

## Moving a stock, and opening a slot (owner request 2026-10-07)

Owner: "how do I edit the left column on the stochastic? Can you make the stocks movable up/down by
pressing the mouse button and can we have an open slot so I can push in more stocks?" — then, mid-turn,
"stocastic NOT watchlist": this is the SYMBOL column of the Stochastic charts rail, never the watchlist
tiles (which have their own drag, `wlDrag*`, and were not touched; this borrows its POINTER-event design
and its constants' meaning, not its code). Everything above still holds: the array is POSITIONAL and
exactly `WB_SLOTS` long, a click charts, a second pointer click within `WB_SLOT_DBL_MS` edits, F2 is the
keyboard edit. What was added sits beside those rules and changes none of them.

**A move is ONE splice** (`wbMoveSlot(from, to)`: `splice(from, 1)` then `splice(to, 0, moved)`), so the rows
between the two shift by one place, the length is unchanged and nothing is overwritten, dropped or
duplicated — a swap would have silently displaced a stock that was not part of the gesture. The pointer
reads a GAP, not a row (`wbDropGap(y)`: the number of rows whose vertical middle it has passed, 0..100),
and the gap is counted BEFORE the stock is lifted out, so a gap below its own row lands one place higher
(`wbGapToSlot`: `gap > from ? gap - 1 : gap`). A hole travels with the shift, like any other entry.

**An open slot is made by CONSUMING an empty one** (`wbInsertSlot(at)`): the stocks from `at` down move one
place into the nearest empty slot beneath, and the slot at `at` is empty. When nothing beneath is empty it
pulls the rows ABOVE up into the nearest empty one instead, so the open slot lands just above `at`. Only a
column with all 100 filled is refused, with a visible `role="status"` note under the entry box (`wbRailNote`,
module state `wbRailMsg`, cleared by its own timer) — never a silent no-op. **It must never grow the array**:
`wbSlotArray` truncates to 100 on every read, so a 101-entry write looks fine until the next write drops the
LAST stock. S64 therefore reads the store directly after the Insert key, BEFORE anything is typed (the typed write
would normalise it and hide the fault). Reached by Insert on a focused slot (ABOVE that row), which puts the owner in the
new slot's editor (`wbInsertAndEdit` → `wbFocusSlotEditor`, shared with the click-to-edit path), and — at index 0 — by the
two typing boxes through `wbPushSymbol` (see "Typing boxes PUSH the symbol in at the top"). There is no `+` any more.

**The drag is ONE delegated `pointerdown` on `#wbSidebar` (`wbSlotPointerDown`), not a listener per button —
and that was MEASURED, not assumed.** The first cut wired each filled slot; in WebKit a `pointerdown`
listener cost ~5ms per button, so with eight filled slots a rail repaint went from 8ms to 50ms (`renderWbSidebar`
runs on every animation frame of a chart drag and every poll). It was caught because S45's slow double-click
(two clicks 300ms apart, which must land inside `WB_SLOT_DBL_MS` = 500) started failing on the tablet and iPhone
projects: the repaint after the first click now delayed the second past the window. `#wbSidebar` itself is never
rebuilt — only its contents — so one listener survives every repaint. Do not move it back onto the buttons.

**The same cost applies to the press's own listeners, and was found the same way.** The second cut added
`pointermove`/`pointerup`/`pointercancel`/`keydown` to `window` at every `pointerdown` and removed them at the
end; with the per-button listeners gone S45 was still failing on iPhone/iPad about half the time, because those
four adds put ~20ms on every plain click and the slow double-click sits ~470ms into a 500ms window. Measured
(two clicks 300ms apart, the gap between the click EVENTS, WebKit, iPad profile): base ≈ 470ms, that cut ≈ 480ms,
the permanent-listener version ≈ 345ms. The press is now module state (`wbSlotPress`: pointer id, button, slot,
symbol, start point, touch, hold-scroll listener) and the four listeners are registered ONCE at load, ignoring
every event while no press is in progress. A stale press (its pointerup lost) is replaced by the next
`pointerdown`, never joined. **Only a touch press adds a listener of its own — the non-passive `touchmove` —
and it must stay per-press:** a permanent non-passive `touchmove` on `window` would make every scroll on the
page wait for JavaScript. The ~125ms gain over base beyond that is `user-select: none` / `-webkit-touch-callout:
none` on `.wb-slot` (added for the long-press callout): WebKit skips its selection handling on mouse-down for
the slot, which also stops a double-click from highlighting a ticker. Not separately proven; measured as a
whole.

Gesture rules, each of which S64 holds:
- **Slop and arming.** A mouse starts a drag after `WB_SLOT_DRAG_SLOP` (6px); a finger must rest
  `WB_SLOT_TOUCH_ARM_MS` (300ms) first, so an ordinary swipe still scrolls the 100-row list. The base
  `touch-action: manipulation` (which keeps the double-tap edit from becoming a zoom, Codex P1 above) stays
  the rule.
- **Touch: the pan is stopped by a NON-PASSIVE `touchmove`, not by a class (Codex P1, PR #313).** The first cut
  copied the watchlist tiles' device — add `.wb-armed` (`touch-action: none`) after the hold. But
  `touch-action` is evaluated when the finger goes DOWN and cannot be changed for the gesture in progress, so
  on a real phone the first move after the rest starts a native pan and the browser sends `pointercancel`:
  the advertised hold-to-drag cancels instead of moving the stock. What works, and is how touch sortables are
  built: a `touchmove` listener registered `{ passive: false }` AT `pointerdown` (window-level listeners
  default to passive in Chromium) that calls `preventDefault()` while the slot is armed or a drag is running
  (`holdScroll`). The first move after a rest is still cancelable because no pan has begun; an unarmed move is
  left alone, so a swipe still scrolls the list, and moving past the slop before the rest is over cancels the
  press. `.wb-armed` stays as the visible cue. `.wb-slot` also carries `-webkit-touch-callout: none` and
  `user-select: none` so the hold raises no long-press callout. **The watchlist tiles (`wlWireDrag`) still use
  the class-only device and may have the same defect on a phone; they were not touched (out of scope), and
  this is recorded here so the next person to touch them knows.** S64 step 12 drives synthetic pointer and
  `touchmove` events through the real handler: it proves the arming rule and the cancel hook, NOT that a
  phone's browser honours them — a real finger is still unverified in this sandbox.
- **The release is still a click — and the guard that swallows it is ONE-SHOT and tied to the source NODE.**
  It is delivered to the slot BUTTON the press began on and would CHART it, so `wbSlotDragClickBtn` names that
  node and the click handler ignores the first click it receives on it (and clears the guard), for at most
  `WB_SLOT_DRAG_CLICK_MS` (250, stamped AFTER the commit's repaint). **The first cut was a global timestamp
  (Codex P2, PR #313)**, which discarded EVERY slot's clicks for 250ms and was never cleared by the click it
  existed for: after a drop whose source button had been detached, an immediate click on another stock was
  silently lost. A committed move usually detaches the source button so no click arrives and the guard
  lapses; the case that needs it is a CANCELLED drag (Escape, a release off the list), with no repaint to
  detach anything, which is why S64 holds a chartable symbol in the slot and checks the chart did not move.
  **The exception:** a release back where it started (`to === from`) sets no guard — a click that wandered
  past 6px and came home still charts.
- **The gesture belongs to ONE pointer** (`pid`, the `pointerId` of the press): `move`, `up` and `cancel` ignore any
  other. Found by S64's touch step on iPhone's WebKit: a real, trusted mouse `pointermove` (a hybrid device's
  hover, or the fake one a browser fires after a layout change) landed mid-hold, read as a far-away move of a
  not-yet-armed finger, and cancelled it before the 300ms rest ended. S64 now dispatches such a stray move
  during the hold and still expects the slot to arm.
- **Escape cancels at once, the click guard waits for the RELEASE (Codex P2, PR #313).** The guard that swallows
  the release click was stamped when the drag ended — for Escape that is the key press — and then lived 250ms. An
  owner who pressed Escape and kept the mouse down longer let go after it had expired, and the click (routed to
  the source button by pointer capture) charted the stock they had just cancelled. The press now stays alive,
  marked `dead`, until the physical release: `wbSlotDragEnd` RETURNS the button instead of stamping, and
  `wbSlotPointerUp` arms the guard (`wbSlotArmClickGuard`) at that moment, after any commit repaint. A dead
  press ignores moves (it cannot start another drag) and a mouse released outside the window ends it.
- **Settle the open editor before the column is re-indexed (`wbSettleEditor`, Codex P2, PR #313).** The input's
  blur save is deferred a tick (`setTimeout(0)`), and a TAP delivers `mousedown`, `mouseup` and `click` back to
  back, so the Insert key's (or the entry box's) handler can run first: the slot the owner just typed in still reads empty in storage, so
  `wbInsertSlot` calls it "already open" and moves nothing, `wbInsertAndEdit` rebuilds it as a blank editor, and
  the old input's blur then takes the rebuild for a background repaint (case 2 above) and returns without saving
  — the typed symbol is gone. A finger drag is the same hazard without any blur at all. The editor that is on
  screen publishes its own quiet "save and close" as `wbEditorSettle`; `wbInsertAndEdit`, `wbCommitMove` and `wbPushSymbol` call
  `wbSettleEditor()` first, which saves the draft to ITS slot (no charting — attention has moved) and marks the
  editor settled so the deferred blur does nothing. S64 reproduces the tap ordering exactly with `blur()` and
  `click()` in one `evaluate`.
- **A drag is navigation** and breaks a pending double-click pair (`wbSlotClick`), like a roster click or an
  editor opening.
- **Cancel.** Escape, `pointercancel`, and a release more than 40px beside or 24px above/below the list change
  nothing and draw no marker. A mouse or pen `pointermove` with `buttons === 0` also ends the press: a button
  released OUTSIDE the window never delivers its `pointerup`, and the window listeners would otherwise outlive the
  press and turn the next plain move into a drag with nothing held. An EMPTY slot has nothing to pick up (the handler refuses a slot with no text).
- **The list scrolls itself** while a drag holds within `WB_SLOT_EDGE_PX` (22) of its top or bottom edge
  (`wbSlotDragScroll`, one rAF loop re-armed by every move, cancelled when the drag ends), because a finger
  cannot scroll while armed and a stock moving from slot 3 to slot 60 must be possible in one gesture. The page
  does not scroll: the rail is capped to the chart's height (side) or 220px (stacked), so the list is the only
  thing that can need it.
- **Feedback.** The marker is an ABSOLUTE child of `.wb-slots` (`position: relative` was added to it) so it
  takes no flex row and scrolls with the list; the ghost is a child of `.area-charts` and NOT of the rail,
  because `renderWbSidebar` empties the rail and the dark scope's tokens live on `.area-charts`. A repaint the
  owner did not cause can arrive mid-drag (the 60s poll, a chart landing): the drag state is module state and
  `renderWbSidebar` ends by calling `wbSlotDragPaint()` when one is live, which puts the marker and the dimmed
  source row back.
- **Focus follows the stock** (`wbCommitMove`): a mouse press focuses the button and the keyboard path is all
  about focus, and `renderWbSidebar`'s own restore would put it back on the old INDEX, which now holds a
  different stock. The roving tab stop moves with it (`wbSlotTab = to`).
- **Keyboard parity** (an arrangement only a mouse can make is not one everyone can): Alt+ArrowUp/Down moves
  the focused stock one place; Insert opens a slot above it (with the drag, the way to put one BETWEEN stocks).
- **Typing boxes PUSH the symbol in at the top (owner 2026-10-09).** History, because it took four rounds: 2026-10-07 the owner asked for "an
  open slot so I can push in more stocks" and got a `+` (and the Insert key) that opened an empty slot ABOVE the row last worked on;
  2026-10-08 "it just overwrites what I input last" — a slot just filled IS the row last worked on, so every `+` landed at the same index; the
  `+` was changed to open BELOW the row last worked on (`wbAddTarget`, `wbSlotWorked`); then, with a screenshot of the ACTIVE box, "keeps overwriting
  in the same spot" — the header Load box only replaced the ACTIVE symbol (it charted, the 100 slots never changed), so Load was made to add to the
  END of the list (`wbAddLoaded`, reversing the 2026-08-26 "I didn't want a field to push into the list" for that box); and finally, with another
  screenshot and after asking "how does + work?": "This is a little confusing for me … put a blank empty space on top of the left column and I will
  type in a symbol and it will just get pushed into the list." The `+`, `wbAddTarget`, `wbAddNext`, `wbSlotWorked` and the end-of-column case of
  `wbInsertSlot` were DELETED, and there is ONE rule with two doors: the ENTRY BOX on top of the SYMBOL column (`wbEntryInput`) and the header Load
  box's submit both call `wbPushSymbol(sym)`. The rules: (1) the new symbol takes slot 0 and everything above the first EMPTY slot moves down one
  place — `wbInsertSlot(0)`, so the column stays exactly 100 long and nothing is dropped; a slot 0 that is already empty is simply filled; a full
  column is refused with the `role="status"` note and the symbol is charted anyway. (2) SAVED FIRST, whether or not the lookup resolves — the
  same rule as a slot commit — so a slow or failed quote can neither lose the symbol nor reorder two typed in a row (an add after the lookup was the
  mutant S66 catches); a typo is therefore kept and fixed or emptied like any slot. (3) Never a twin, and **a symbol already in the column is LIFTED
  to the top and its older copy goes** (owner 2026-10-09: "if there are duplicates, I would just remove the existing or the older one from the list"
  — it was "only charted, in place" until then): ONE splice (the stock out, in at slot 0), so the rows above it move down one place, nothing is
  dropped, no hole is left and the column stays 100 long; it uses up no empty slot, so it works on a full column too and never says "every slot is
  filled"; a further copy lower down (a twin an older build could leave) is emptied in place. (4) `wbSettleEditor()` first (the shift reads what is
  STORED), and EVERY path repaints: settling closes the editor LOGICALLY only and a failed lookup repaints nothing, so without it a stale input stays
  on screen with handlers that ignore every key (Codex P2, PR #317). (5) `.wb-slots` is scrolled back to the top, where the new symbol is (a repaint otherwise keeps the owner's scroll position).
  (6) The entry box is a blank space that STAYS blank: emptied after a push, focus kept so the next symbol can be typed at once, Escape empties it,
  text that is not a ticker (`WL_SYM_RE`) is refused with a note in the rail and left in the box. It is ONE node for the page's life, re-seated by
  every `renderWbSidebar` (the rail is rebuilt on every chart repaint and 60 s poll — a box rebuilt with it would lose what the owner was typing),
  which keeps its focus and caret as it does the slot editor's. (7) The loader (`wbLoadSymbol`), a roster click and a slot commit
  still write nothing (a slot commit may still type a copy of a symbol that is already listed: "a slot keeps whatever was typed"); the header input's `change` handler (a roster symbol committed by blur) is unchanged and still only charts. S66 pins all of
  it (24 mutants), S64 the Insert key, S40 the alignment.
- **Deleting a stock (owner 2026-10-10: "in addition to pushing, I also want to be able to delete symbols from that list").** Until then the only way out of the
  column was to open a slot's editor and empty its text, which leaves a HOLE where the stock was (S45: "nothing below it moves up"; that editing ruling stands). A
  delete is a different act and CLOSES the gap, like the lift in `wbPushSymbol`: `wbDeleteSlot(i)` is one splice — the stock out, an empty slot added at the
  END — so the rows below move up one place and the array stays exactly 100 long. Rules: (1) `wbSettleEditor()` first, because it re-indexes (a draft in an
  open editor is saved in ITS slot, then the rows move); (2) it charts NOTHING and opens no editor — removing a stock is not navigating to it; (3) it writes
  NO note: the rail's note pushes `.wb-slots` down by its own height, so with a note up the next click on the same × would land on the wrong stock, and the
  point of closing the gap is that the same spot now holds the NEXT stock, so two clicks remove two; a screen reader hears the focus land on the next stock
  instead; the one note it does touch is a STALE one — a delete makes room, so an "every slot is filled" note a refused push left up is dropped
  (`wbRailNoteClear`; a retrying assertion cannot see this, the note clears itself after 4 s); (3b) it CANCELS a quote lookup still running for that
  stock, and only that one: a slot clicked a moment before has `wbLoadSymbol` awaiting `deskQuote`, and when the quote lands its success path calls
  `wbPick` — charting the stock just removed. `wbLoadPending` holds the symbol whose request is in flight (set when it goes out, cleared when it lands
  unsuperseded and by `wbPick`), `wbCancelLoad(sym)` bumps `wbLoadGen` only when it matches and takes the `Loading X…` note with it, so another stock clicked
  just before and still loading is the newest request and still wins (both Codex P2, PR #320); (4) the tab stop stays at the index (`wbSlotTab = i`), and a Delete / Backspace from the keyboard keeps focus there too (the render restores a
  focused slot button by index). Two ways in. **The ×** (`.wb-slot-del`) is built after the slot button on every FILLED row — a SIBLING, never inside
  `.wb-slot`, so `wbSlotPointerDown` (which looks for `.wb-slot`) cannot start a drag from it and a press on it cannot chart or edit; an empty slot gets none;
  `tabindex=-1` keeps the column ONE tab stop; tooltip `Remove <SYM>`, accessible name `Remove <SYM> from the list`; ONE delegated `click` listener on the rail
  (`wbSlotDelClick`), registered next to the drag's `pointerdown`, never a listener per row. It is an OVERLAY on the row's right edge (`position: absolute`; the
  row became `position: relative`), NOT a flex item, because the ticker never abbreviates and the 78px column has ~3.9px of headroom at ten characters: a
  × that took width would clip a symbol at rest, which S40 forbids. The price of an overlay is that while it is up it covers the last ~18px of THAT row's
  text (only the row being pointed at, whose tooltip names the stock). `display: none` at rest; shown on the row's `:hover` and `:focus-within`; under
  `@media (hover: none)` — a phone, where nothing hovers — on the row LAST TAPPED (`.is-touched`) — `wbSlotTouched` holds the SYMBOL, not the index (a push or a delete moves rows), and the slot's click handler moves the class IN PLACE because tapping a stock that cannot be charted repaints nothing, while every repaint rebuilds it from the state. It was the CHARTED row (`.is-active`) first, and Codex (P2, PR #320) caught what that misses: a delisted or mistyped ticker never becomes the charted symbol and is exactly the one to remove, so it had no × on a phone; a delete forgets the tapped stock, so one pushed back in is a new row. Hidden during a drag
  (`body.wb-drag-active`, `.wb-dragging`); never red. **Delete / Backspace** on a focused slot do the same (`preventDefault`, so Backspace never navigates
  back; nothing happens on an empty slot) — the keyboard path, as F2 is for the editor. No Undo was built: a push re-adds a stock in one step. S67 pins it
  (21 mutants, each caught — one first survived: a × in the flow instead of an overlay passed every position check, so S67 also asserts the slot button is exactly as wide with the × up); S45's old "no ×" assertion still holds for `.wb-rail-x`, the per-slot × of the pre-2026-08-26 stack.
- **Names.** `wbDrag` already exists (the chart's pan/resize drag, `endWbDrag`); everything here is
  `wbSlotDrag*` / `WB_SLOT_*`. Do not merge them.

Not measured, stated rather than claimed away: a real finger. The mouse path is S64 on all four projects
(desktop, tablet, mobile-chrome, iphone); twenty-four mutants each fail it (swap instead of splice, gap off by
one, the release clicking through, Escape not cancelling, an off-list drop committing, an insert that keeps
the empty slot — in both branches — a marker at the wrong edge, a wandering click swallowed, no pull-up
fallback, focus not following, an empty slot draggable, no suppression window, the lost-pointerup guard removed, a global or never-consumed click guard, a guard consumed by any
slot, a touch hold that never cancels the pan, a touch drag that needs no rest, a gesture driven by any pointer, the
+ or a move that does not settle the open editor, a guard armed at the Escape, a held cancelled press that may
drag again).
