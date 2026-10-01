# Desk row and page layout

How the desk row (Markets | News | Ask | Economy), the accounts block at the bottom of the page, the positions table and the heatmap footer are sized: the measuring column, out-of-flow panels, breakpoints and the caps (`styles/layout.css`; scenarios S4, S11, S54, S55).

  **ACCOUNTS ARE THE LAST BLOCK ON THE PAGE, cards side by side** (owner request
  2026-09-30: "my accounts information to go at the bottom of the dashboard show
  side by side"). `<section class="area-accounts">` — the title, the MARKETS desk
  lamp with Refresh / Lock, the synced stamp and `#accountGrid` — is the LAST
  child of `<main id="main">`, after the heatmap panel. The MARKUP moved, not a
  CSS `order`, so visual order is DOM order. The cost is named and accepted: the
  desk lamp, Refresh and Lock now sit at the bottom of the page and come LAST in
  the reading order keyboard and screen-reader users follow. Every id and class
  the renderers use is unchanged (`#accountGrid`, `#mastheadState`,
  `#accountsStamp`, `#accountsTitle`), so `renderAccounts`, `renderMasthead` and
  the lock flow needed no change, and nothing in `app.js` selects the old parent.
  **This WITHDRAWS the 2026-08-20 ruling** (a fixed 232px column beside Ask, the
  cards stacked one per row) — see the SUPERSEDED banners further down, which keep
  that history.
  - **Edges.** The section is a full-bleed sibling of `.area-charts` and
    `.heat-panel` and takes their exact inline inset
    (`margin-inline: calc(0.5in - var(--space-4))`), so its left and right edges ARE
    theirs. It is also on the shell cap's opt-out list (`:not(.area-accounts)` beside
    `.area-charts`, `.heat-panel`, `.wl-area`, `.masthead`): without that, a window
    wider than 1880 centres it inside the cap, inset from the heatmap above it. The
    heatmap's own 0.5in bottom margin is the seam above; the footer's margin the gap
    below.
  - **Cards.** `.account-grid` is `repeat(auto-fit, minmax(min(340px, 100%), 1fr))`:
    two equal columns from ~792px (2 x 340 + the gutter must fit inside the inset
    section), one column below that with no breakpoint of its own. `min(340px, 100%)`
    keeps the floor from exceeding a phone's 294px section, where a bare 340 scrolls
    the page sideways. `auto-fit`, not `auto-fill`, so two accounts share the whole
    width. The card's stats are 2-up above 520px and 1-up at or below it (2-up at 390
    is the fault that failed S4 on WebKit alone). The equity sparkline is back — it was
    hidden in the 232px column. The hacks that only existed to fit that column are
    DELETED, not disabled: the `zoom` scale, the single-column stat grid, the hidden
    sparkline, the 150px side header and every `.top-boxes`-scoped card override.
  - **Header row.** `.accounts-side` puts the title and desk lamp on the left and the
    stamp on the right, ONE line at desktop; it wraps, never overflows, when the
    LIVE + Refresh + Lock cluster outgrows a phone. Refresh / Lock stay 26px
    (`.accounts-head .btn`).
  - **Locked.** `.account-grid .panel-lock` spans every track (`grid-column: 1 / -1`)
    with `min-height: 158px` — a floor, NEVER `height`: the wrong-PIN error renders
    below the form and at a fixed height landed outside the panel (S11 would not
    catch that, the element still exists and still has its text; S54 asserts the
    error line is inside the panel). The explainer type trim that used to buy the last
    17px against the cards' 158 is gone with the row it matched.
  - **Positions cap unchanged:** `.acct-positions`, 120px, ordinary scrollbar, NO
    `overscroll-behavior` (next to the heatmap-footer notes below).
  **The desk row reads Markets | News | Ask | Economy at ≥1120px.** The accounts'
  old 232px column now holds the **Economy panel** (`<aside class="panel area-econ">`,
  `#econTitle` / `#econLamp` / `#econBody`; filled by `renderEcon()`, see
  `economy-panel.md`). Every rule the accounts column had is re-pointed at `.area-econ`:
  stretch to Markets' bottom line, the same 1120 gate, `flex: 2 1 320px` beside Ask when the
  row wraps below 1120 (the old accounts ratio). **Its width is FLUID, not the old fixed 232
  (2026-09-30):** `flex: 0 0 clamp(232px, calc(100vw - 1067px), 320px)`. A row needs label +
  value + change over a chart, and at 232 the chart is ~94px wide (readable); at 320 it is
  ~200px. 1067 is the fixed width of everything that is NOT Ask or Economy — Markets 311 +
  News 300 + three 16px gaps + the page's 32px inset + the 12px gap to Economy + Ask's own
  380 — so Economy takes only width Ask can spare and **Ask keeps >= 380px wherever Economy is
  wider than 232**. Measured (Chromium): 1152 → Economy 232 / Ask 234; 1280 → 232 / 362 (both
  exactly the old widths — Ask was ALREADY under 380 there with the fixed 232, and Economy
  does not make it worse); 1440 → 320 / 434; 1920 → 320 / 906. A fixed 320 would have left
  Ask 146px wide in the owner's 1152 browser (a 1512 laptop with DevTools docked) — a
  composer you cannot type into. WebKit lays Markets ~11px wider, so Ask is ~11px narrower
  there; S54 therefore reads the floor off the layout's own Ask+Economy box.
  The panel stays IN FLOW and is kept from setting the row's height — no longer by the
  320px cap on `.top-boxes .panel-body` (the Economy body opts out of it: seven rows (each with its
  source line) + the span control need well over that, and a cap that cut rows off behind a scroller
  nobody is told about would read as a shorter list) but by the body being
  **`flex: 1 1 0; min-height: 0`**: its content contributes nothing to the panel's height, so
  the panel is exactly Markets' height whatever the roster holds, and the body is an ordinary
  scroll container (plain `overflow-y: auto`, NO `overscroll-behavior`) that scrolls only when
  the space it is given really is too small. Rows share the height (`flex: 1 1 56px`, capped at
  104px, floored at 52px). Stacked (<1120) there is no Markets height to match: the body is
  uncapped and the page scrolls. The panel header WRAPS (title + lamp, then the stamp) because
  "Last updated 08:11, Sep 30" does not share a line with them at 232px. Two traps: a body
  that is not `flex: 1 1 0; min-height: 0` hands the row's height to the panel — take it out
  of flow like Ask instead; and **`contain: size` was tried to keep its content out of the
  line and is WRONG** — WebKit does not re-measure it when a resize crosses the 1120 gate
  (810 → 1152 gave Ask 0px wide and the column 139px past the viewport), so never reach for
  it here. S54 holds the shape (Economy right of Ask, `clamp(232, vw-1067, 320)` wide, Ask's
  floor, ending on Markets' bottom line, eighty injected rows do not grow the row); S55 holds
  the panel's content.

  **EVERY COLUMN IN THE DESK ROW ENDS ON ONE LINE at ≥1120px** (owner request
  2026-08-21: "I want all of these windows to be as tall as the bottom of the
  Real Estate XLRE box"). **MARKETS is the measuring column** — four index
  tiles, a chart and eleven sector rows is content fixed by the desk rather
  than by whatever the feeds returned today, so it is the only honest ruler.
  Everything else is fitted to it: `.desk-row` goes `align-items: stretch`
  (it was `flex-start`, which let the boxes half stop at its own content and
  leave **~690px of empty page** beside the news), Ask loses its 420px cap and
  its `align-self: start` so the slack goes to the thread, and the right-hand
  column (the account cards then, the Economy panel now) stretches to the same
  line instead of stopping 204px short.
  **ASK is taken out of flow inside its own column too**, for the same reason
  and after the same fault reached the owner: with the 420px cap lifted, a long
  answer dragged the whole row down past Markets and the panel ran on down the
  page ("anything below the real estate should be cut off", 2026-08-21). A flex
  line's height is the MAX of its items, so `stretch` alone cannot express "fill
  this row but never set it". **Demo cannot show this** — `.ask-thread:empty` is
  `display: none`, so with no conversation there is nothing to overflow; it
  needs a forced live+authed session with answers in the thread, which is how
  it was finally measured (3,129px of answer, row held at 927, thread scrolling
  internally).
  **NEWS is taken OUT OF FLOW to make that possible** — the documented device,
  and this is the case that justifies it: an absolutely-positioned panel
  contributes nothing to the line's cross size, so Markets stays the only
  column measuring itself and News resolves against whatever height it lands
  on. No flex alignment can express "let the SHORTER column drive the taller
  one" — `stretch` gives the row to the tallest, which is backwards here, since
  demo carries 8 headlines and the live feed 20 and News is the column that
  runs past XLRE. `#newsList` keeps `overflow-y: auto` and deliberately NO
  `overscroll-behavior`, so reaching the last headline carries on scrolling the
  page; it is the one body on this row with genuinely more content than column.
  One ordering trap: the Ask overrides (the accounts' went with them) must sit **later in the
  stylesheet** than the base `align-self: start` and `max-height: 420px` they
  lift — equal specificity, so source order is the whole mechanism, and placed
  earlier they silently did nothing (measured: Ask stayed at 158 while News and
  Markets moved). Measured at 1512/1280/1152: all four panels end at 927 with
  XLRE at 912. Below 1120 the row stacks and every one of these rules is inert.
  **SUPERSEDED 2026-09-30 — history, not current behaviour** (the accounts moved to
  the bottom of the page and the 232px column is the Economy panel's; see the top
  of this file). What survives unchanged: the 1120 gate and its reason, below.
  **The desk row (`.top-boxes`) reads Ask | Accounts at ≥1120px** — Ask on the
  left taking whatever is left, the accounts as a fixed **232px column** on its
  right with the cards **stacked one per row** (owner request 2026-08-20:
  "move the accounts back on top and squeeze it on the right side of the desk
  AI, reducing the width of that guy, and you could re-expand the heat map to
  the full screen"). This REPLACES the 2026-08-18 `.heat-row`, where the
  accounts sat beside the heatmap; that wrapper and its CSS are deleted, not
  disabled, and the heat panel is full-bleed again. Two rules from the old
  three-across arrangement went with it and must not be reinstated without
  their cause: `zoom: .62` on the card and the 150px header column BESIDE the
  grid both existed so Ask / Account A / Account B could start on one 158px
  line. The cards are a COLUMN now, with no line to match, so the scale and the
  side header were solving a problem that no longer exists.
  The gate is **1120, the same breakpoint `.desk-row` itself uses**, and the two
  must agree: that gate was lowered to 1120 precisely because the accounts had
  left this row, so a higher one here leaves 1120–1400 running the old
  share-the-row rules — measured, that put Ask at **198px** at a 1280 viewport.
  It also matters that the owner's browser reports `innerWidth` 1152, the same
  trap the watchlist column layout hit at 1900. (Both points still govern the
  Ask | Economy row.)
  **What is capped is the POSITIONS TABLE, not the column** (`.acct-positions`,
  `max-height: 120px` ≈ three rows): "don't allow the accounts to grow with
  positions. Use a scroll button." It carries an **ordinary scrollbar**
  (`overflow-y: auto`, `scrollbar-width: thin`, `scrollbar-gutter: stable`) —
  it was paged by the shared ▲/▼ for a few hours on 2026-08-20 and the owner
  asked for a scrollbar instead the next morning ("need scroll bar inside so I
  can look at the rest of the positions"). The pager was not broken (measured:
  `▲▼2`, three of five rows shown); a 20px button bar under a row sliced in
  half is simply not how anyone expects to read a table. **The cap is the part
  that was asked for** and it stays; only the mechanism for reaching the rest
  changed. NO `overscroll-behavior` here, so the last position chains on to
  scrolling the page — the same configuration `#newsList` uses, and the one
  that avoids the wheel-eating fault. (The watchlist columns were paged by this same idiom until 2026-09-30, when the
  watchlists went back to horizontal bands and the paging was deleted.) Capping the whole
  accounts column was built first and is WRONG — the header takes most of a
  short column, so the cards themselves were left a **31px sliver**, which stops
  the growth by hiding the thing the panel exists for. Three rows rather than a
  roomier six because the owner's own account holds five and their screenshot
  already showed the panel outrunning its neighbour: a cap that only bit at
  seven would have changed nothing they can see. Opening the disclosure now
  costs a card 140px instead of an unbounded amount, and the bar is removed
  entirely while the table is collapsed.
  **The heatmap footer is ONE row** (`.heat-foot`: legend left, movers
  disclosure right) — "much more condensed and not waste so much space". The
  standing "Sized by market cap · colored by day % change" caption was DELETED
  rather than shrunk, because the legend's own label already said it; the 44px
  summary target, sized for a standalone control, drops to 24 inside a row. The
  `#heatSource` node stays (now `:empty`-hidden) because it is where the
  empty-state line lands — removing it would make that message throw on a null.
  (owner request 2026-08-08 for the original three-across form). **Ask is height-ELASTIC, not pinned**: 192px while
  its thread is empty, growing with the conversation to a 420px cap past which
  the thread scrolls. It was briefly a fixed 158 — and at that height the
  header, composer and disclaimer consume the whole panel, so `.ask-thread`
  resolved to ZERO and every answer rendered into a 0px box (owner report
  2026-08-09, "cant see my results"; measured: 255px of answer, 0px of room).
  The earlier "158 is the floor" figure came from checking only that the FORM
  fitted, which it did — the thread silently absorbed the shortfall, so the
  panel looked fine and the assistant was unusable. 192 is what the authed
  panel actually needs at rest.
  **SUPERSEDED 2026-09-30 — history only, through the `Three across` paragraph
  below:** the Ask | Account A | Account B row, the `zoom: .62` cards and the 150px
  side header were withdrawn with the cards' move to the bottom of the page (the
  earlier 2026-08-20 withdrawal had already dropped the scale). What survives:
  Refresh / Lock are 26px, demo never renders them, and the lock panel is
  `min-height`, never `height` (all restated in the current section above). "Ask
  moves by `order`, not by moving the markup" below is OVERTAKEN: the owner has now
  asked for the accounts at the bottom, so the markup moved (visual = DOM order).
  Ask is on the FAR LEFT and **fluid** — it takes
  whatever the cards leave (1052 at 1512, 1452 at 1920) — and the two cards are
  **200×158** beside it, matched to Ask's height. They went 485 → 242 → 200 over
  two passes; Ask was briefly pinned at 489 and became fluid in the second, so
  narrowing the cards now widens Ask automatically instead of leaving dead space. The accounts header
  (title, desk lamp, Refresh/Lock, synced stamp) sits in a 150px `.accounts-side`
  column BESIDE the cards rather than above them: stacked, it pushed the cards
  ~75px below Ask and the row read as staggered, and in live mode its two
  full-size buttons wrapped it onto three lines. `.btn` is 44px tall with 20px
  padding — right for a form's primary action, far too heavy for two secondary
  header controls — so they are 26px here. Two details are load-bearing:
  `.area-accounts` must be `flex: 0 0 auto`, or it shrinks below its own content
  and spills 22px past a 1512 viewport; and `.account-grid`'s 12px `margin-top`
  is zeroed, since it exists to clear a header ABOVE it and was the last thing
  holding the cards off Ask's line. **Demo never renders Refresh/Lock**, so none
  of this is visible under `?demo=1` — force `DESK.mode='live'` and
  `DESK.authed=true`, then `renderMasthead()`, to see the header the owner
  actually has. **The LOCKED state keeps the row's shape too**: the lock
  panel replaces both cards, so it spans both grid tracks at the same height —
  it was 200×247 against the cards' 158 and the row jumped the moment the desk
  locked. It is `min-height`, NOT `height`: the wrong-PIN error renders below
  the form and at a fixed 158 landed 8px OUTSIDE the panel, so a failed unlock
  showed no visible reason — and **S11 would not have caught that**, since the
  element still exists and still carries its text. The row is 158 whenever the
  desk is merely locked and grows ~27px only while an error is on screen. It is
  also deliberately NOT `zoom`ed like `.account`: the cards are scaled because
  they carry many figures, whereas this panel is a text input, and shrinking one
  people must type into to 62% would buy nothing. Ask moves
  by `order`, **not** by moving the markup: the accounts section carries the
  desk's masthead state and the Refresh/Lock controls, and reordering the DOM
  would drag those out of the reading order keyboard and screen-reader users
  follow. The card is **scaled, not re-typeset** (owner ruling: "reduce font to
  fit") — at full size it needs 331px of height, and shrinking individual fonts
  would leave padding and gaps at their old size, so it would read as starved
  rather than smaller; `zoom` takes type, padding and borders together, the same
  device the Markets column uses. **`.62` is the largest scale that fits** —
  `.66` still overflows by 10px. One asymmetry is easy to get wrong: the width
  comes from the grid track and is already in rendered pixels, while `height` is
  set INSIDE the zoomed box and must be divided by the scale to render at 158.
  The whole block is gated at 1400 because both numbers break a narrow screen —
  two 200px cards plus gaps overflow a 390px viewport outright,
  and below 1400 the stats drop to 1-up, which no longer fits 158px.
  **Three across at ≥1400px** (owner request 2026-08-07) — Watchlists moved
  INSIDE `.top-band` as `.col-watchlist`, so the row reads Markets | Watchlists |
  Ask. It reached its current shape over three passes the same day: first
  387 / 1040 / 385 pinned at 600px tall and gated at 1900px; then Watchlists
  became the FLUID column and the gate dropped to 1400, because the owner's
  browser measured `innerWidth` 1152 (a 1512 laptop with DevTools docked) so the
  1900 version never engaged on the machine it was built for; then Markets was
  cut by a **THIRD** (387 → **258** rendered) with **Ask matched to it at 258**,
  Watchlists taking the ~256px that freed. Markets keeps its 0.9 `zoom`, so its
  basis is the pre-zoom **287** (287 × 0.9 ≈ 258); Ask carries no zoom, so its
  basis IS the rendered width. Watchlists measures ~932 at 1512 and ~1332 at
  1920. The shell cap went 1560 → **1880**, so a 1920 monitor doesn't carry
  180px of dead margin each side. Narrower screens keep exactly the layout they
  had: `order:-1` + a 100% basis puts Watchlists back on its own full-width row
  ABOVE Markets and Ask.
  **SUPERSEDED 2026-08-17 — the paragraph below is history, not current
  behaviour.** Watchlists left `.top-band` for its own full-width block above
  the charts, so the band is now TWO columns (Markets | News) and the
  out-of-flow arrangement was **deleted rather than ported**: it existed for
  exactly one reason — to let the shorter watchlist column drive the row's
  height — and with no third column to defer to, plain `align-items: stretch`
  is correct again. The inner `overflow-y: auto` went with it, since neither
  panel is cropped any more and a scroll container with nothing to scroll is
  the dead-wheel trap. News is now the FLUID column (Markets keeps its pinned
  345 basis), or the row would strand ~800px of empty band at 1512. Kept below
  because the reasoning explains why no future layout should reach for the
  same device without the same cause.
  **No column is height-pinned, and WATCHLISTS is what sets the row height**
  (owner request 2026-08-07, revising the same day's first cut). Watchlists runs
  at its FULL length — the old 600px cap hid whole lists behind an inner
  scrollbar — and the row ends at its last band. The intermediate version used
  plain `align-items: stretch`, but stretch gives the row to the TALLEST column,
  and once Markets was cut to 258px it became the tallest (~811px against the
  watchlist's ~586), so the row ran on past the last band and left Watchlists
  standing in dead space. Pinning Markets to a number would re-break the moment
  a list is added or removed.
  The fix is that **Markets and News are taken out of flow** — `position:
  absolute; inset: 0` inside a `position: relative` column. An out-of-flow panel
  contributes nothing to the line's cross size, so the only column still
  measuring its own content is Watchlists and the other two resolve against
  whatever height it lands on. That is what lets a SHORTER column drive a taller
  one, which no flex alignment can express. Both then genuinely scroll, and that
  is **not** a return of the dead-wheel trap below: they CAN scroll, and they
  leave `overscroll-behavior` at `auto` so reaching the end chains to the page.
  In demo (7 lists, ~586px) that puts 8 of the 11 sector rows below the fold of
  their own panel; the live roster is 12 lists and much taller, so Markets
  generally fits without scrolling there.
  The Markets grids are therefore re-columned **by the COLUMN's width, not the
  viewport's**: both are `repeat(4, 1fr)` and drop to 2 only under a
  `max-width: 520px` **viewport** query, which never fires on the wide screen
  where this narrow column exists — 4-up at 287px pre-zoom puts a ~63px sector
  cell under a 10px label and a mono %, and they spill the box. The two grids
  then **differ on purpose**, and both splits came from a text-overflow audit
  rather than taste: index tiles stay **2-up** (forcing them 3-up clips 5–6
  elements — the `--font-lg` mono % and the `.mk-ext` proxy line), while the 11
  sectors go **3-up** to pull ~140px out of the row (914 → 773). The 10px sector
  label does not survive that on its own: a 3-up cell is **71px** and
  "Communication" needs **76px** — the one label that is a single unbreakable
  word, so neither wrapping nor `break-word` helps. It is set to **9px in this
  column only** (~68px, clearing every other name), which sizes the label to the
  cell instead of clipping or ellipsising it; the stacked layout below 1400px
  keeps the 10px label at its 4-up width. Two more rules are
  load-bearing and were both caught by measuring rather than by eye: the ≤1280
  stack must carry **`flex-wrap: nowrap`**, because a `flex-direction: column`
  container that is allowed to wrap spills into EXTRA COLUMNS when its content
  outgrows the box (this sent the panels to 2822px at a 1280 viewport and
  scrolled the page sideways — the fault S4 exists to catch); and `.col-rail`
  needs an explicit **380px basis rather than `auto`**, or with wrapping enabled
  it measures its own content and breaks onto a row of its own at 1440–1728.
