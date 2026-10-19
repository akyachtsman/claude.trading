# Charts panes, stochastics and the last-price tab

The three Pro panes in `scripts/app.js` (`renderCharts` / `drawPane`): volume average, pane order and config keys, LONG-TERM candle colouring and Steady, the last-price tab, sticky spans (scenarios S12, S25, S34, S36, S37, S39).

    **A 20-period VOLUME AVERAGE** rides over the histogram on all three panes
  (`VOL_MA`, `data-volma`, owner request 2026-08-12, shipped 2026-08-18) — the
  reference platform's yellow line, and what makes a bar readable as heavy or
  light, since "big volume" only means anything against the recent norm. Three
  things are load-bearing: it is computed from the **WHOLE series, not the
  visible window**, so the leading visible bars carry a real average instead of
  the line starting 20 bars into the pane (the same rule the LONG-TERM pane's colour state
  machine follows, for the same reason — a line that moves when you zoom is not
  trustworthy); it uses a **rolling sum** rather than re-summing 20 bars per
  point, because the `All` span is ~9,000 bars across three panes and the
  per-bar form is the shape of work that cost this project the 546s; and it
  **clamps to the strip top**, since `vMax` is the VISIBLE window's max while
  the average reaches back before it, so an average above everything on screen
  would otherwise draw up into the price pane. It carries `data-volma` because
  it shares its yellow with the stochastic `%D` lines and neither a test nor a
  reader could otherwise tell which yellow path is which.
  **PANE ORDER, and why the NUMBER is not the identity** (owner request
  2026-08-25): the panes render **LONG-TERM, then SWING, then DAY TRADING**, and
  are captioned `PRO 1` / `PRO 2` / `PRO 3` **left to right**. So the number is
  POSITIONAL and the doctrine name is the identity — `PRO 1 · LONG-TERM`,
  `PRO 2 · SWING`, `PRO 3 · DAY TRADING`.
  **The config keys deliberately did NOT move**: `cfg.p1` is still the SWING pane
  and `cfg.p2` still the LONG-TERM one; they simply render second and first. That
  is what made the change safe to ship — those keys are what the owner's SAVED
  per-pane settings hang off (SMAs, S/R levels, chart style, the Steady toggle,
  the extended-hours toggle), so renumbering them would have silently moved the
  long-term pane's settings onto the swing pane and needed a storage migration.
  Keeping them means none was required. **Read the doctrine name, never the
  number**: `cfg.p1` = SWING = displayed "PRO 2". THREE places cross the two, and this
  list is load-bearing — an earlier version of this entry named only the first
  two, and following it through another reorder would leave the header bars
  behind exactly as this PR did (Codex P2): the pane seg in `wireCharts` (label
  `Pro 1` → key `p2`), the settings-popover title map, and **the header-bar DOM
  in `index.html`**, where `wbBar-p2`/`chartZoom2` renders FIRST while displaying
  `PRO 1`. The bars are not cosmetic — each one's zoom seg, lock and gear mutate
  the config named by its id, so a bar above the wrong chart silently retimes the
  wrong pane. If the order changes again, all three move together. Reordering was otherwise free because nothing
  indexes `panes[]` for identity: each entry carries its own `panKey`, `daysKey`
  and `cfg` in its opts, and `idx` only places the pane on the X axis and draws
  the dividers. The tests locate panes by DOCTRINE NAME for the same reason —
  S25, S34 and S39 all matched on the number and silently pointed at the wrong
  pane the moment the order changed (S39's index-based check was measuring a
  different window than its own message claimed).
  **The LONG-TERM pane's candle colouring follows the WEEKLY STOCHASTIC
  CROSSOVER, not open/close** (owner ruling 2026-07-30): `%K` (red) above `%D` (yellow) ⇒ green
  candle, below ⇒ red — "red over yellow is a buy sign", and on the long-term
  pane the decision is whether momentum is with you, not what one day did.
  `drawPane` colours by `opts.colorSt` when present; it is set on the **LONG-TERM pane
  only** (config key `p2`, displayed `PRO 1`), to the **weekly-scale 92-15-15** (`weeklyStochOnDaily`) — NOT the
  fast daily 14-3-3, since on a long-term pane the regime that matters is the
  long-term one. That weekly series is computed **unconditionally**, independent
  of the `cfg.p2.stochW` overlay toggle: the toggle decides whether the strip is
  drawn, and tying the colour to it would let hiding a strip silently change
  what every candle means. Pro 1 and Pro 3 keep open/close. Two deliberate
  consequences: a green candle in this pane **can be a down day** (the body
  still shows direction; the fill now means momentum regime), which is why the
  weekly strip caption reads `· CANDLE COLOUR` rather than leaving it to look
  like a rendering bug; and **volume bars stay price-coloured**, since a volume
  bar is a fact about one day and tinting it by a regime would make the
  histogram claim something it does not measure. Bars before the stochastic
  warms up fall back to open/close rather than defaulting to one colour.
  **A per-pane "Steady" toggle confines colour changes to the 30–80 BAND**
  (`cfg.p2.stochSteady` / `STEADY_BAND`, owner ruling 2026-08-05, from a
  reference platform that flips a handful of times where ours flipped every few
  weeks). The ruling is explicit and is the acceptance criterion: **a crossover
  INSIDE 30–80 must change the colour; one out in the extremes must not.** It
  matches the doctrine the pane already follows — a cross still pinned near the
  top hasn't confirmed the turn, you want it breaking down INTO the band — so
  bearish turns need `%K` below 80 and bullish turns need it above 30. Measured
  over ~2y across the 25 charted symbols (12,600 bars): 650 colour changes →
  **413**, with all **269 mid-band crossovers still acted on** and 381 extreme
  ones dropped. A **separation threshold** (hold until `%K`/`%D` pull apart by
  N points) was built and measured FIRST and is **REJECTED** — and not on the
  numbers, which favour it (305 changes, and 2 runs ≤5 bars against the band's
  56). It silently skips a real mid-band crossover whenever the lines cross and
  stay close, which is the event this pane exists to show; fewer repaints is
  worth nothing if the dropped one is the one that matters. Do not
  re-litigate this with flicker counts. Two things are load-bearing: the state
  machine runs across the **WHOLE series, never the visible window** — seeded at
  the viewport, 20 of the 25 symbols repaint on zoom (up to 77 bars), and a
  candle changing colour as you zoom destroys trust in the pane (S34 guards
  exactly this, and only catches it by comparing the NARROW window's OLDEST
  bars, where the seed divergence lives); and the caption gains `(STEADY)`,
  because with it armed the strip can show the lines visibly crossed while the
  candles hold the old regime (an extreme-zone cross being ignored on purpose) —
  the same unexplained-divergence trap the `· CANDLE COLOUR` caption already
  exists for. OFF by default: it recolours 21% of bars, and silently changing
  what every candle means on an entry pane is not a default to assume.
  The **SMA price display** (a right-edge price tag at each enabled SMA) was
  removed from Pro 1/2/3 the same day, owner request — the config, the popover
  group and the drawing code all went; the SMA lines themselves are untouched.
  **The five SMA colours each differ (owner 2026-10-14, from a chart screenshot: "Why is uh, fifty? And 100 day
  moving ave Yeah., same color").** `SMA_COLORS` (app.js) draws 1 white (`--color-text-primary`), 25 purple
  (`--color-series-3`), 50 yellow (`--color-accent-bright`), 100 CYAN (`--color-sma-100`), 200 grey-blue
  (`--color-text-secondary`). The 100 used to borrow `--color-series-2`, which the dark `.area-charts` scope paints
  `#f5c518` — the same yellow as the 50 AND the stochastic %D — so three lines read as one. The 100 now has a token
  of its own, **defined in BOTH themes**: `#22d3ee` in the dark scope (`layout.css`) and `#0E7490` in `tokens.css`
  (5.36:1 on white), because the watchlist detail window draws the same averages OUTSIDE the dark scope and a token
  declared in the dark scope alone resolves to nothing there (a transparent swatch, an unpainted line). It is not one
  of the CVD-validated `--color-series-1..3`, whose order is untouched. No orange (owner 2026-07-16). The 50 keeping
  its yellow beside the %D yellow is deliberate and unchanged: they sit in different strips (price vs stochastic),
  while the five averages share one plotting area and must all read apart. Each SMA path carries `data-sma="<len>"`
  (like `data-volma`) so a test can read its resolved stroke. Guarded by S71; by hand, six regressions (the 100 back
  on series-2, on the 50's token, the dark token turned yellow, the token missing from the daylight theme, the
  daylight token equal to the 50, the `data-sma` attribute dropped) each fail it on desktop.
  **A strip that cannot carry its full setting yet draws a PARTIAL line (owner 2026-10-16, from a screenshot of a recent listing's weekly strip reading
  `INSUFFICIENT HISTORY — NEEDS ~120 BARS`: "why do you need 120 bars? Can it just do a partial display?" — "build the partial display").** Why 120: 92-15-15 is a raw
  %K over 92 bars, smoothed over 15 (the first %K line is bar 106), smoothed over 15 again (the first %D is bar 120) — `warm` in `drawPane`, `kFrom` / `dFrom` in
  `stochPartial`. A stock with fewer daily bars (a new listing: `quote-proxy` fetches up to five years, so this is the stock's age and never a short fetch) drew an
  empty strip with that sentence. It now draws `stochPartial` (`data.js`, next to `stochSeries`): the SAME formula with every window clipped to the bars that exist
  (raw %K over `min(k, bars so far)`, each smoothing over `min(len, values so far)`), starting at the tenth bar (`PARTIAL_MIN_BARS` — a handful of bars always sits at the
  edge of its own range, so %K would only flip between 0 and 100), and from `kFrom` / `dFrom` on it IS `stochSeries`, value for value (S74 proves it, on the demo's bars
  AND on a series whose first bar is the extreme of every early window — the demo bars alone let a window one bar short survive every check). What is drawn: a DASHED
  (`3 3`), dimmer (`stroke-opacity .6`) line in the real %K / %D colours (`path[data-partial="k|d"]`) over the bars where the real line has no value, ENDING ON the first
  real point so the two read as one line, and a note INSIDE the strip's top-right corner (the caption line above it is already full) — `PARTIAL — 70 OF 120 BARS`, with
  `· CANDLES BY PRICE` on the strip that colours the candles, and the short `PARTIAL 70/120` when the plot is narrower than 230px (`plotW`). **The gate is "the series has no
  real %D at all"** — so 106–119 bars draws the real %K solid with the dashed line before it, and a long series' own leading warm-up stays empty exactly as before.
  **It is a picture, never a signal, so NOTHING that decides anything reads it:** the doctrine marks (`stochMarks` on the real series), the candle colour (`colorSt` is the
  real weekly series, which is null until %D exists, so a partial strip's candles are coloured by PRICE direction — the note says so, otherwise visible dashed crossovers
  beside candles that ignore them would read as a fault), `tools/watchlist-scan.mjs` (it loads `stochSeries`, unchanged: a symbol needing `barsNeeded` bars is still listed
  unpriced, never scanned on a partial number) and the crosshair's plain readout. A bar the dashed line covers reads out marked **`~`** (`W~ 63/61`, `%K~ 63 %D~ 61` on a
  daily strip) so the line is never an unlabelled number and a partial number never passes for the real one; every other bar reads as before. `INSUFFICIENT HISTORY` survives
  only where even the partial has nothing (under ten bars: reachable on Pro 3's 15-minute series early in a session, because the ≥30-bar guard in `renderCharts` counts DAILY
  bars) — that path is not covered by a test (the intraday feed needs a live desk). In practice only the weekly strip of a 30–119-bar listing is ever partial (a pane needs
  30 bars to draw at all; the 14-3-3 strip needs 18). Guarded by S74 (13 hand mutants, each caught: solid, undimmed, drawn beside a real %D, note dropped, window one bar short,
  starting at bar 1, candle colour reading it, line not joined, readout unmarked or dropped, gate on %K instead of %D, the old message kept, %D not expanded).
  **A LAST-PRICE TAB is a different thing and IS on all three panes** (owner
  request 2026-08-12, from a reference terminal's white flag): a pentagon
  notched at the price axis, `--color-text-primary` on `--color-bg` — which
  inside `.chart-wrap` resolve to near-white on near-black, so it inverts with
  the pane instead of being a hardcoded white that would vanish if the
  workbench ever went light. Neutral by rule, never gain/loss coloured: those
  are P&L-only, and a price level is not a P&L. Four things are load-bearing.
  It reads the **LIVE QUOTE** (`wbInfoCache`), not the last bar's close, which
  is what makes it "move as often as our prices" — `scheduleMarketPoll` already
  refreshes that every 60s while prints arrive and `maybeFetchWbInfo` already
  re-renders the workbench on completion, so the tab needed NO clock of its own.
  The quote is read as `.price`, for the PANE'S OWN symbol (the desk quote is
  trusted for the desk symbol only — a pane pinned by `cfg.sym` used to show another
  symbol's price), and an `ok:false` reply never overwrites a good cached quote.
  It falls back to the newest close when there is no quote (demo, or a failed
  live fetch) — real data either way, never fabricated. It indexes
  `bars.c.length - 1`, **NOT `end - 1`**: `end` is the last VISIBLE bar, so
  panning back through history would otherwise label a years-old close as the
  current price; it is clamped into `[lo, hi]` and rides the pane edge instead,
  as the reference does. And it is painted **BEFORE** the crosshair, so when the
  pointer's own tag lands on the same row the crosshair wins — both share the
  same 36px gutter, and the one tracking the pointer is the one being read.
  The chart is a **self-contained renderer**, deliberately NOT the
  workbench's `drawPane`: that is a closure inside `renderCharts()` guarded by
  S12/S25/S34, and prising it out to serve a modal would risk a heavily-ruled
  surface for a view needing none of its stochastic machinery.
  **Pro 1 / Pro 2 spans are STICKY** (owner request 2026-08-09: they reset to
  3M/6M on every refresh). `wb_sticky_v1` already carried the workbench's last
  symbol; it now also carries `z1`/`z2`, so each pane reopens on the span it was
  left at — Pro 1 on 3M and Pro 2 on 1Y, say. Both are **validated against that
  pane's own preset list** on read rather than trusted: an arbitrary number from
  a hand-edited `localStorage` would size a window no seg button matches,
  leaving every preset unpressed and the pane at a width nothing in the UI can
  explain; an unrecognised value falls back to the built-in default. Pro 3 is
  deliberately excluded — it has no presets, its window is a BAR count that gets
  rescaled when the EXT toggle flips, and its range control is the navigator.
  `syncZoomPressed()` (end of `renderCharts`) is what lights the restored
  button: `wireCharts()` runs before the feed has built `wbState`, so the
  pressed state it sets at load is provisional.

**The resize-grip pills sit on a row of their own (owner 2026-10-19: "fix the resize grip pills").** Every pane has a draggable bar above its VOLUME pane and above each
stochastic strip: a faint line with a 56x5 white pill centred on it (`resizeBar` in `drawPane`; the pill carries `data-grip="vol|stoch|stochW|stochSplit"`, its hit area
`data-grip-hit`, and tests select by those markers, never by the white fill). The pill above a STRIP used to share a 14px band with the strip's caption — and the
pill is CENTRED while the caption starts at the left, so any caption wider than about half the plot ran underneath it (`STOCH 14-3-3 · DAILY` read `STOCH 14-3-3 ·`
under it; at 900px and below, and on a phone, every strip caption; measured before the change: 5 of the demo's 7 pills over a caption at 1152px, 6 of 7 at 900px
and at 390px). The band is now `STRIP_GAP` = 20px (one constant, read by the height budget, the price-pane height, `stripTops` and the drag's `budget`) and the
pill's centre is `GRIP_UP` = 16px above the strip top: its box runs 18.5–13.5 above the strip, clear of the caption's glyph tops (~10.3) and of the block above
(20). The pill stays CENTRED — the fix is vertical, never a sideways slide, which has no room on a phone (a pane is ~110 user units wide there and its caption can be
wider than the pane). The volume pill is untouched (it lives in the 8px gap above the volume pane, where no text is). **Never narrow `STRIP_GAP` back to 14 or move
`GRIP_UP` below ~12** without re-running S76: each puts the pill back over the caption or over the block above, and the price pane's height budget (`MIN_PH`) is
computed from the same constant, so the three places cannot drift. Guarded by S76 (pill box vs every text and badge within half a pixel, centred on its own hit
area both ways, nothing drawn touching it above or below, and a real drag on the first strip's bar still grows that strip); by hand, seven regressions (the old 14/7
geometry, a pill nudged sideways, the pill moved up with the band left at 14, the hit area left at the old place, either marker dropped, the pill back on the caption
row) each fail it on desktop and mobile-chrome.
