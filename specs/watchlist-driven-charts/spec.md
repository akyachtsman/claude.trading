# Spec — Watchlist-driven charts workbench

**Status:** specify complete — clarifications resolved, ready for `plan`
**Requested:** 2026-08-17, owner, two overhauls given minutes apart and treated
as one feature because they serve one workflow.
**Slug:** `watchlist-driven-charts`

---

## Why

The desk has two surfaces that name symbols and one that charts them, and they
do not talk to each other.

The **Watchlists** panel holds the owner's real rosters — twelve named lists,
edited in place, live-priced. The **Stochastic charts** workbench holds a
*different*, fixed roster of 25 names that lives in `config/chart-watchlist.json`
and has no relationship to the lists at all. So the owner curates a list of
names they care about in one panel, then goes to the panel where the analysis
actually happens and finds a rail of 25 unrelated tickers. To chart something
from a watchlist they must read the ticker off a tile, walk to the charts panel,
and retype it.

The two overhauls close that gap from both ends: the charts rail learns to read
the watchlists, and the watchlists panel moves to sit directly above the charts
so the read-then-chart motion is a glance and a click rather than a scroll
across the page.

A second, smaller complaint sits underneath: the charts rail today mixes the
fixed 25 with any ad-hoc ticker the owner has typed, in one undifferentiated
column. There is no way to see "the things I pulled up myself" apart from "the
roster somebody configured".

---

## Who

One user: the desk owner, on a 1512px laptop (measured `innerWidth` 1152 with
DevTools docked — the layout must engage at that width, not only at 1900+).
Phone and tablet widths must remain usable but are not where this work is aimed.

---

## User stories

**US-1 — Chart a name from a list.**
As the owner, I pick one of my watchlists from a dropdown in the charts panel
and see every symbol in it listed in the rail, so I can click straight down the
list and read each chart in turn without retyping anything.

**US-2 — Keep my own scratch stack.**
As the owner, I type a ticker into the charts panel and it lands at the top of a
column of its own — separate from any roster — and it is still there tomorrow.
Names I pull up myself accumulate into a personal working set.

**US-3 — Don't lose the old roster.**
As the owner, the 25 names the workbench has always carried are still one
selection away, because they load instantly and I use them.

**US-4 — Read a list downward.**
As the owner, I see all my watchlist categories at once as vertical columns —
each list's name on top, its symbols stacked beneath it — because that is how a
list reads, and because I want to compare across lists at a glance.

**US-5 — Watchlists next to the charts.**
As the owner, the Watchlists panel sits directly above the Stochastic charts
panel, so choosing what to look at and looking at it are the same eye movement.

---

## Functional requirements

### The charts symbol rail — two columns

- **FR-1** The charts panel's symbol rail renders **two columns side by side**,
  replacing today's single column.
- **FR-2** **Column A (manual)** starts **empty**. It holds only symbols the
  owner has entered by hand.
- **FR-3** Entering a symbol pushes it onto the **top** of column A; existing
  entries move down. Re-entering a symbol already in the column moves it back to
  the top rather than duplicating it.
- **FR-4** Column A **persists across reloads and across browser sessions**,
  scoped to the machine the owner typed on. It is explicitly **not** synced to
  the desk (see Clarification C2).
- **FR-5** Column A holds at least 30 entries; when it is longer than the panel
  it scrolls within its own column without trapping the page's scroll.
- **FR-6** The owner can **remove** an individual entry from column A, and that
  removal persists.
- **FR-7** **Column B (roster)** is headed by a **dropdown** listing every one
  of the owner's watchlists, plus one entry for the **existing 25-name charts
  roster**. Selecting an entry lists that roster's symbols beneath it.
- **FR-8** The selected roster **persists across reloads**.
- **FR-9** Clicking any symbol in either column charts it, exactly as clicking a
  rail entry does today — same panes, same indicators, same behaviour.
- **FR-10** A symbol that the charts feed does not already carry is fetched on
  demand when clicked. The rail must show that a fetch is in progress and must
  say so plainly if the symbol cannot be resolved.
- **FR-11** Each rail entry shows its **day-% change** alongside the ticker, as
  today, for both columns.
- **FR-12** In demo mode the rail renders from demo data and offers demo
  watchlists; nothing fabricates a live price. Ad-hoc lookups stay disabled in
  demo, as they are today.

### The Watchlists panel — position and layout

- **FR-13** The Watchlists panel is **relocated to sit immediately above the
  Stochastic charts panel**, at full page width, and is no longer one of the
  three columns in the top band.
- **FR-14** With Watchlists gone from the top band, the remaining panels
  (Markets, Ask the desk) re-occupy that row without dead space and without
  either panel being stretched across the gap.
- **FR-15** Each watchlist category renders as a **vertical column**: the list's
  name at the top, its symbol tiles stacked downward beneath it. Columns sit
  side by side across the panel.
- **FR-16** **Every list is visible at once** — there are no tabs and no list
  picker. The columns are the navigation.
- **FR-17** A column shorter than its neighbours does not stretch its tiles to
  fill the difference.
- **FR-18** An **empty list still renders as a full column** with a placeholder,
  so it keeps its shape and stays a drop target.
- **FR-19** The panel runs at its **full natural height** — no inner height cap
  that hides whole lists behind a scrollbar.
- **FR-20** Below the wide-layout breakpoint the panel degrades to a usable
  narrow arrangement rather than forcing horizontal page scroll.

### Everything that must survive unchanged

These are existing, ruled behaviours that ride on the current watchlist markup.
Each must work identically after the re-layout.

- **FR-21** Drag a tile to move it between lists, with ghost, insertion marker,
  lit target, Escape-to-cancel, the staging tray, and the Manual-sort snap.
- **FR-22** Single click opens the symbol detail window; **double click** opens
  the removal confirm; the deferred-open cancel between the two still holds, and
  a completed drag opens nothing.
- **FR-23** Quick add (`+` per list), create list, delete list — including the
  rule that delete is gated on the lock while create is not.
- **FR-24** The panel's sort control, chart-timeframe control, tile sparklines,
  extended-hours markers, and the unresolved-ticker warning.
- **FR-25** The panel's data-state lamp and as-of stamp.

---

## Success criteria

| # | Criterion | How it is verified |
|---|---|---|
| SC-1 | Owner can go from "see a name in a watchlist" to "read its stochastic chart" without typing | Click a rail entry sourced from a watchlist; chart renders |
| SC-2 | A hand-typed ticker is still in column A after a full page reload | Reload; the entry is present and in the same position |
| SC-3 | The old 25-name roster is still reachable and still instant | Select it in the dropdown; charts render from the pre-swept payload |
| SC-4 | All watchlist categories are readable top-to-bottom, all visible together | Every list has a column; no tab strip exists |
| SC-5 | Watchlists sits directly above the charts panel | Document order and rendered position |
| SC-6 | Nothing in FR-21…FR-25 regressed | The existing S20/S21/S23/S26/S27/S31/S35 scenarios still pass |
| SC-7 | No horizontal page scroll at 390px, 1152px, 1512px or 1920px | Measured at each width |
| SC-8 | The mouse wheel scrolls the page over every part of both panels | Wheel test over each scrollable region, both axes |

---

## Non-goals

- **Not** syncing the manual column to the desk / across devices (C2).
- **Not** retiring `config/chart-watchlist.json` or the `desk-charts` sweep (C1).
- **Not** changing what the charts panes draw — no indicator, colour, span or
  stochastic behaviour changes. This is a rail and a layout, not the charts.
- **Not** changing the watchlist data model, the RPCs, or any edge function.
- **Not** adding a way to edit watchlists from the charts panel.
- **Not** changing the tile's own contents (ticker / price / change / sparkline)
  beyond what the column arrangement requires.
- **Not** a redesign of the Markets or Ask panels, beyond re-occupying the row
  Watchlists leaves.

---

## Clarifications

Resolved with the owner during `specify`, 2026-08-17.

**C1 — What happens to the existing 25-symbol charts roster?**
*Asked because* the rail becoming watchlist-driven would otherwise orphan
`config/chart-watchlist.json` and the server-side 800-bar sweep behind it.
**Answer: keep it as one entry in the dropdown.** Nothing is retired; the sweep
keeps serving instant charts for those names, and the owner can still select the
old rail wholesale.

**C2 — Where does the manual column save?**
*Asked because* "it'll save it there" could mean this browser or the desk, and
the desk would mean a new table, PIN RPCs, a migration and a hand-run
edge-function deploy.
**Answer: this browser.** No backend work, no deploy. The stack lives on the
machine it was typed into.

**C3 — What does "categories vertical instead of horizontal" mean?**
*Asked because* it admits at least three readings that produce very different
panels.
**Answer: each category becomes a column** — name on top, tiles stacked
downward, columns side by side, every list visible at once. Explicitly **not** a
vertical list-picker showing one list at a time, and **not** full-width bands
with tiles stacked inside them.

---

## Risks and open concerns

Carried into `plan` — none of these block planning.

- **R-1 — The top band's layout reasoning unwinds.** Markets and News are
  currently taken out of flow (`position: absolute` inside relative columns)
  for one specific reason: so that the *watchlist* column drives the row's
  height while the other two resolve against it. Removing Watchlists from that
  row removes the thing that arrangement exists to serve. This must be
  re-derived from scratch, not cut and pasted.

- **R-2 — Column count vs. list count.** Twelve lists as side-by-side columns at
  the current tile width is roughly 800–950px. That fits 1512 but wants checking
  at 1152, and the behaviour when lists outgrow the width must be decided in
  `plan` (wrap to a second row of columns, or scroll horizontally).

- **R-3 — Ragged column heights.** The tallest list sets the panel height and
  shorter columns leave visible empty space. FR-17 forbids stretching tiles to
  hide it, so the plan must say what fills or ends a short column.

- **R-4 — Lazy chart fetches vs. "quickly go through them".** Watchlist symbols
  outside the charts feed need a per-symbol fetch on click. The plan must
  address whether that is fast enough to click down a list, and whether
  prefetching is warranted.

- **R-5 — Gesture collisions in the rail.** The watchlist tile already carries
  click / double-click / drag with a timing-based disambiguation. The rail is a
  different surface with different gestures; the plan must not import the
  collision.

- **R-6 — Rail width is chart width.** Two columns take roughly twice the
  current 96px from the chart canvas. At the owner's effective 1152px this is
  material and must be measured, not assumed.
