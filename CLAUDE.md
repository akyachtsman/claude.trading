# CLAUDE.md — claude.trading

## Imported Directives
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/global.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/git.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/design.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/test.md
https://raw.githubusercontent.com/akyachtsman/claude.directives/main/directives/data.md

---

## Project Overview
- **Project name:** claude.trading — multi-account trading dashboard
- **Live URL:** https://akyachtsman.github.io/claude.trading/
- **Stack:** Static tier — plain HTML + CSS + vanilla JS on GitHub Pages (no
  build), confirmed. Dynamic data arrives two ways: public JSON committed by a
  scheduled pipeline, and (when live mode is enabled) private data behind
  PIN-validated Supabase RPCs.
- **Branch policy:** Develop on a `claude/<name>` feature branch; PRs target `main`

## Design
This project's look is its own — established at kickoff via `/design-intake`
(per `directives/design.md`), not a shared company theme. It lives in:
- `styles/tokens.css` — brand primitives (color, type, spacing, radius, shadow)
- `styles/components.css` — reusable components
- **Reference page:** `index.html` on demo data (see `specs/multi-account-trading-dashboard/design.md` — "Daylight desk ledger")

## Application Architecture
- `index.html` — markup only + 3 script tags; all render-blocking assets share
  ONE `?v=` cache-bust token (bump them together on every asset change).
- `scripts/config.js` — account roster (`DESK_ACCOUNTS`) + backend endpoints
  (`DESK_DB`). **Empty `DESK_DB.url` ⇒ the whole site runs in DEMO mode.**
  Current state: **LIVE** on the dedicated Supabase project ("trading
  dashboard", `kwugzhyfjevzwgplhtsd`, wired in PR #19) — RLS tables +
  SECURITY DEFINER PIN RPCs + the edge-function data layer below.
  Demo remains reachable via `?demo=1`.
- `scripts/data.js` — formatters, seeded demo generator, trading-day calendar,
  mode resolution, `deskFeed()` live-feed wrapper, `marketSessionOpen()`,
  two-tier `liveLampFor` staleness lamps; every panel stamp renders one uniform
  terse format via `fmtUpdated` — `Last updated {time} · {Mon D}` (clock dropped
  when only a trading-day as-of exists). The clock is when the DATA last changed,
  NOT the fetch (owner ruling 2026-07-22): for price feeds (`liveLampFor(...,
  priceBound=true)` — market/heatmap/charts/masthead) once the market is closed
  the stamp reads the session close (`marketCloseInstant` = 16:00 ET / 1:00pm PT
  on the as-of day) instead of the hourly re-poll clock; intraday and non-price
  feeds (news) keep the fetch clock (≈ now). The price lamp itself reads **EOD**
  (not LIVE) once the market is shut — LIVE shows ONLY while the session is open
  and quotes are streaming (owner ruling 2026-07-22); STALE still flags a genuinely
  stalled open-hours poller, and non-price feeds keep LIVE/STALE by fetch. (A
  future extended-hours quote feed would widen the LIVE window.) Supabase RPC fetch
  wrappers. **Every clock on the desk is pinned to Pacific** (`DESK_TZ`, owner
  ruling 2026-07-22):
  stamps via `fmtClock`, intraday bar times via `fmtBarT`, news row times via
  `newsWhen` — never the viewer's locale, never raw UTC.
  **A news row DATES itself whenever it is not from today** (`newsWhen`,
  `.news-date`, owner report 2026-08-24). `desk-news` used to emit only a bare
  UTC `HH:mm` and discard the date, and the sweep applies NO maximum age — so a
  quiet topic fills its 20 slots with whatever exists and a **Jun 29** story sat
  **fourth** in an August feed reading `14:19`, which is indistinguishable from
  this afternoon. Position made it worse, not better: the list is sorted by
  recency, so a row near the top reads as fresh. The old `utcHmToPt` then pinned
  that bare `HH:mm` onto **TODAY's** date to do the Pacific conversion, so the
  date was not merely missing but overwritten — and the hour could land in the
  wrong DST context too. The payload now carries `ts` (full ISO instant)
  alongside `t`, and `newsWhen` renders `Mon D` above the clock, with the exact
  instant in the row's `title`. Three things are load-bearing. The date is
  **absent for today's rows on purpose** — dating all twenty would put an
  identical `Aug 24` on every line and the one old row would stop standing out,
  which is the entire signal. "Is this today" is decided on the **Pacific
  calendar date** of both the item and now, never on elapsed hours, so an item
  from 23:30 last night reads as yesterday's at 00:30 even though it is an hour
  old. And `utcHmToPt` is KEPT as the fallback for a payload predating `ts`, so
  the client is safe to ship before the function is redeployed — it simply keeps
  the old behaviour until `ts` arrives rather than rendering blanks.
  **The age itself is still unfiltered** — this change makes an old row legible,
  it does not remove it. A maximum age was deliberately NOT added: a topic
  search on a thin ticker legitimately has little recent news, and silently
  emptying the panel would trade a misleading answer for no answer.
  Demo seeds **both** states (two dated tail rows), because every demo row was
  same-day before — which is exactly why nothing caught this: a bare clock
  always looked right in demo while misdating live rows. S43 guards both.
  `buildDemoMarkets()` seeds the Markets window's normalized %-change series —
  a detrended random walk per index (S&P/Nasdaq/Russell/Dow) per timeframe,
  pinned to 0 at the start and the index's end-% at the right edge.
- `scripts/app.js` — all rendering + interactions (accounts with per-card
  equity sparklines, news, ask-the-desk panel, the Markets window, stochastic
  charts workbench, PIN lock/unlock flow) + the
  **charts SYMBOL RAIL is TWO COLUMNS** (`renderWbSidebar()`, owner request
  2026-08-17), replacing one flat list that mixed the fixed 25-name roster with
  every ad-hoc ticker typed, so there was no way to separate "names I pulled up"
  from "the roster someone configured". **MANUAL** (left) starts empty, holds
  only what was typed into the Load box, newest on top, `wb_sticky_v1.syms`
  capped at `WB_MANUAL_MAX` 40, with a `×` per row. **ROSTER** (right) is headed
  by a `<select>` of the owner's watchlists plus a `WB_ROSTER_CHARTS` entry for
  the 25-name charts roster — kept, not retired (owner ruling), because its 800
  bars are already loaded so those names chart instantly. Four rules are
  load-bearing. `wbPick` **no longer** calls `addWbStickySym`: it used to pin
  every non-roster pick, which was invisible plumbing before and would now push
  every watchlist name the owner clicks into a column they never typed into —
  pinning moved to `wbLoadSymbol({pin:true})`, which the Load box alone passes.
  Pinning happens on BOTH success branches (already-loaded and post-fetch) but
  **never before the outcome is known**, or a typo takes a permanent seat in a
  column that persists across sessions. `restoreStickySymbols` therefore
  re-hydrates **`sel` as well as `syms`**, since a watchlist symbol left
  selected is no longer in `syms` and would return with no bars. And
  `renderWatchlist` ends by repainting the rail: the two feeds land
  independently and desk-charts usually wins, so the picker's first render sees
  no lists and would otherwise stay a one-entry dropdown all session. Day-% per
  row falls back **live quote → charts-bars → watchlist quote → nothing**
  (never 0.00%, which claims the name was flat). The **live quote is FIRST, but only for
  the ACTIVE symbol and never in pre-market** (`wbInfoCache`, owner report
  2026-08-24): the header read AVAV −0.19% while the rail row directly under it
  read **+1.03%**. Nothing was miscomputed — they were different VINTAGES.
  **The rail was already being repainted on every quote** (`renderCharts` calls
  `renderWbSidebar`); the bug was that `wbRailPct` never READ the quote — it
  went straight to bars, then to the watchlist copy, which rides the 5-minute
  all-feeds poll and pauses while the tab is hidden. So the rail faithfully
  re-rendered a stale number every 60s. AVAV is not in the charts roster, so it
  fell all the way through to that watchlist value. (An earlier cut of this
  entry claimed `renderCharts` does NOT paint the rail and added a second
  repaint — both wrong, caught by Codex; the call is at the end of
  `renderCharts`.)
  Two bounds are load-bearing, both Codex P1s. **ACTIVE SYMBOL ONLY**:
  `refreshWbQuote()` refreshes `wbState.sym` and nothing else, so a cached entry
  for a ticker visited earlier is never updated again — preferring it everywhere
  would let an hour-old quote outrank the 5-minute watchlist value on every row
  the owner had ever clicked, strictly worse than the bug being fixed. **NEVER
  IN PRE-MARKET**: `quote-proxy`'s `info` has no pre-market fields at all
  (`extInfo` keys off `postMarketPrice`), so between 04:00 and 09:30 ET its
  `changePct` is the PRIOR regular session's move while `desk-watchlist`
  deliberately puts `preMarketChangePercent` in `row.pct`. The test is
  `preMarketOpen()` — the ACTUAL 04:00–09:30 ET window, mirroring
  `postMarketOpen` — and **not** "extended and not post-market", which was a
  third Codex P1: after 20:00 ET and all weekend a retained row still carries
  `ext === true` from a valid POST print while `postMarketOpen()` has gone
  false, so that reading misclassifies it and drops back to the bar percentage.
  It must also RETURN `row.pct` rather than merely skip the quote (a fourth
  P1) — skipping alone fell through to the BARS branch, so for any charted
  symbol the pre-market case was unchanged. The gate is evaluated ONCE per rail
  render and passed in, because `renderCharts` rebuilds the rail on every
  animation frame of a chart drag: called per row it would multiply
  `formatToParts` and its part scans by the rail length, every frame. That is a
  separate bound from hoisting `NY_PARTS`, which is what stops `preMarketOpen`
  CONSTRUCTING an `Intl.DateTimeFormat` per call — the 546s pattern proper. It
  no longer builds one at all; do not re-document it as though it does. Otherwise `extPct` when an extended print exists and
  `changePct` otherwise — the desk-wide prior-close rule (2026-07-29) that
  `desk-watchlist` compounds too, so the rail agrees with the HEADER during
  regular hours and with the WATCHLISTS panel after them. S44 guards it,
  driving `wbInfoCache` directly because demo never fetches quotes — the same
  reason the fault could not surface in demo — and asserts a cached quote for a
  NON-active symbol does not win. `.wb-grid` went 96 → 200 → **240px**, and
  the **symbol never abbreviates**: at 200 a column was 96px and, after the
  row's padding, the `×`, the gap and a ~42px day-%, ~21px was left for the
  ticker, so every 4-letter live name rendered as `AV…` — which names no
  instrument, on a rail whose whole purpose is being clicked by ticker (owner
  report 2026-08-20). `.wb-side-sym` is now the NON-shrinking half and the
  day-% is the one that yields; `scrollbar-width: thin` on `.wb-rail-col` is
  part of the width budget, not decoration (two classic 15px bars would eat
  most of the 40px the widening bought). **Demo cannot reproduce the fault**,
  so S40 measures a WIDTH BUDGET rather than checking for a clipped label:
  only 10 demo symbols carry bars, all three letters, and a roster name with
  no series renders no day-% at all, so at the old 200px rail every demo row
  still fitted and a clipping assertion passed on the broken CSS.
  **A 20-period VOLUME AVERAGE** rides over the histogram on all three panes
  (`VOL_MA`, `data-volma`, owner request 2026-08-12, shipped 2026-08-18) — the
  reference platform's yellow line, and what makes a bar readable as heavy or
  light, since "big volume" only means anything against the recent norm. Three
  things are load-bearing: it is computed from the **WHOLE series, not the
  visible window**, so the leading visible bars carry a real average instead of
  the line starting 20 bars into the pane (the same rule the Pro 2 colour state
  machine follows, for the same reason — a line that moves when you zoom is not
  trustworthy); it uses a **rolling sum** rather than re-summing 20 bars per
  point, because the `All` span is ~9,000 bars across three panes and the
  per-bar form is the shape of work that cost this project the 546s; and it
  **clamps to the strip top**, since `vMax` is the VISIBLE window's max while
  the average reaches back before it, so an average above everything on screen
  would otherwise draw up into the price pane. It carries `data-volma` because
  it shares its yellow with the stochastic `%D` lines and neither a test nor a
  reader could otherwise tell which yellow path is which.
  **Pro 2 candle colouring follows the WEEKLY STOCHASTIC CROSSOVER, not
  open/close** (owner ruling 2026-07-30): `%K` (red) above `%D` (yellow) ⇒ green
  candle, below ⇒ red — "red over yellow is a buy sign", and on the long-term
  pane the decision is whether momentum is with you, not what one day did.
  `drawPane` colours by `opts.colorSt` when present; it is set on the **Pro 2
  pane only**, to the **weekly-scale 92-15-15** (`weeklyStochOnDaily`) — NOT the
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
  Also carries the
  session-aware feed poller (5 min market-open / 60 min closed, paused
  while the tab is hidden; a `CLOSE_SETTLE_GRACE_MIN` window — 15 min,
  `withinCloseSettleGrace()` in `scripts/data.js` — keeps the 5-min cadence for
  a short stretch right after the close, since Stooq/Yahoo's final settle
  print doesn't always land at the exact closing bell; added 2026-07-27, owner
  report of no confidence in the as-of-close numbers).
  **Extended-hours rule (owner ruling 2026-07-29) — where pre/post bars may and
  may NOT go.** The workbench fetches intraday with `prepost:true`, so
  `wbState.intraday[sym]` holds the full 4am–8pm set; what consumes it differs
  ON PURPOSE. **Pro 3 only** displays extended bars, gated on its per-pane
  `cfg.p3.ext` toggle (Session group in the gear popover, **OFF by default since
  2026-08-20** — owner: "remove the off market candles, I just wanna see open
  sessions candles in pro three"; the toggle stays, so this is a default change
  rather than a removal, and off is also the exact regular-session bar set the
  ISTOCH 10-3-3 fit was established against, so parity and preference now
  agree). Flipping the default alone reaches nobody who has ever opened the
  gear, since `wb_cfg_v3` is already saved for them — a **one-time marker**
  (`extDefaultOff2026_08_20`) clears a stored `p3.ext: true` on next load. It is
  a marker rather than a `WB_CFG_KEY` bump, which is how this file changed
  defaults before: a bump discards the WHOLE stored config, and per-pane SMAs,
  S/R levels and chart styles are not worth resetting to correct one flag. Extended runs render behind a tinted backdrop rect so a
  thin 4am print never reads as regular-hours conviction, and the caption gains
  `· EXT`. **`graftTodayBar()` is regular-session ONLY** — it pipes its input
  through `regularOnly()` (`scripts/data.js`) first, because a daily candle's
  OHLC has one canonical meaning and folding pre/post prints into today's
  high/low would silently walk the Pro 1 SWING and Pro 2 LONG-TERM stochastics
  off their terminal-fitted values. Verified on live data: the grafted bar's H/L
  matches Yahoo's own `regularMarketDayHigh`/`Low` exactly (QQQ 2026-07-28:
  679.40 / 667.88), where folding extended hours in would have reported
  679.40 / **647.43**. `desk-ask`'s `getTechnicals` graft omits `prepost` for
  the same reason — its readings must match the panes the owner reads them
  against. `intraTo15()` carries the `x` flag through; 15-min buckets align to
  the session boundaries (9:30 = minute 570, 16:00 = 960) so one never straddles
  regular and extended. The Markets window is untouched (regular session).
  The masthead's
  **"Refresh now" button** (`#refreshNowBtn`, next to the MARKETS lamp, live
  mode only — owner request 2026-07-27) force-bypasses BOTH the poll cooldown
  and every desk-market/desk-news/desk-heatmap/desk-charts in-memory cache in
  one click (`force:true` in the POST body; each edge function's cache-read
  skips its TTL check when set) — the guaranteed-fresh escape hatch for when
  the owner doesn't trust the current numbers. The **Markets window** (`renderMarkets()` +
  `drawMktChart()` + `mktSecTint()`, owner request 2026-07-20) is a compact
  trading-app-style panel beside Ask-the-desk: region tabs (U.S. live; Europe/
  Asia/FX disabled placeholders), four index tiles (S&P 500 / Nasdaq Composite /
  Russell 2000 / Dow Jones — day-% + last, read from the shared `desk-market`
  feed by tile name; the NASDAQ tile tracks the ~3,000+ name **Composite**
  (`^IXIC`), not the 100-name Nasdaq-100 — switched 2026-07-27, owner report:
  the desk's original Nasdaq-100 read didn't match the "NASDAQ" the owner
  actually watches on IBKR, which is the Composite), a normalized multi-index
  %-change SVG chart with
  Today/5D/1M/1Y/2Y timeframe toggles (series demo-generated or live via the
  index ETF proxies SPY/QQQ/IWM/DIA), and an 11-cell **Performance by Sector**
  grid (SPDR sector ETFs XLK…XLRE, heatmap-tinted by day-%). Carries its own
  `#mktLamp` data-state lamp + `#mktStamp` as-of stamp like every panel.
  **Extended hours (owner request 2026-07-30) — POST-market only** ("not
  premarket, I'm mostly interested in post market"; pre IS computed server-side,
  so enabling it is a display change). **v8/chart carries NO pre/post fields** —
  measured: with `includePrePost=true` AND `hasPrePostMarketData:true`, SPY's
  meta still returns only `regularMarket*`. The print lives in **v7/quote**, so
  `desk-market` gains ONE batched v7/quote call (best-effort: an auth failure
  costs the extended lines, never the core payload S14 depends on).
  One rule desk-wide: the extended % measures from the **PRIOR CLOSE**, reached
  by COMPOUNDING Yahoo's two percentages — `(1+reg%)(1+post%)-1` — because post%
  is off today's regular close and reg% off the prior close.
  `regularMarketPreviousClose` is NEVER used (it shifts basis during pre-market).
  **Indices have no extended session**, so the four index tiles render a NAMED
  ETF proxy on its own line (`.mk-ext`, `extProxy` in the payload) — SPY / QQQ /
  DIA — never folded into the index's own number. The R2K tile is in `EXT_PROXY`
  too: its data already IS IWM, but the tile reads "Russell 2000", so naming IWM
  stops it printing two unattributed percentages. **VIX is deliberately excluded**
  — no ETF tracks spot VIX (VXX holds futures), the same
  instrument-wearing-the-wrong-name trap as the Nasdaq-100/Composite and Russell
  1000/2000 mismatches. Sector rows and heatmap tiles carry their OWN `ext`
  (they genuinely trade). The heatmap's rides in a **tooltip** (`.tip-ext`)
  because a tile is a few pixels tall at the tail; the **sector strip's is
  VISIBLE on every row**, and the column width exists to make that true. It was
  briefly tooltip-only on 2026-08-07, when the tinted grid first became a
  258px-wide stacked strip — name + ticker + price + sparkline + day-% needs
  ~292px in a 228px row, and flex answered a sixth item by crushing the label
  column to 8px. Rather than drop either number the owner chose to **widen the
  rails**: Markets 287 → **345 basis** (258 → **311** rendered) and News matched
  at 311, so the row carries the sparkline AND the after-hours figure with no
  clipping. Measured at 1512 with both present, clipping only reaches zero at a
  330 basis, so 345 is the first width with headroom rather than one that merely
  fits — live prices run longer than demo's. **S23 asserts all 11 rows carry
  BOTH** plus a zero-clipping check, since the first attempt failed by silently
  crushing the label rather than by dropping anything. The cost is paid by the
  watchlist, whose bands are `flex-wrap: nowrap` and scroll horizontally: at
  1512 the widening moves 3 more tiles per band behind that scroll (29 → 32 of
  75 in demo). The tooltip stays alongside the visible figure because it carries
  the after-hours PRICE, which the row has no room to state.
  The heatmap **keeps tinting by the REGULAR day-%** — re-tinting only the names
  that happen to have an after-hours trade would make the map compare two
  different measurements. The sector strip has **no tint at all** any more: it
  encoded the same number its pill now states outright.
  Absent means "did not trade after hours" and is never rendered as 0.
  `quote-proxy kind:'info'` gained `extPrice`/`extPct`/`extAt`, which reaches the
  charts quote readout AND the assistant at once — `desk-ask`'s `get_quote`
  forwards `info` verbatim, so it needed no change.
  **A position's day-% is NULL when unknown, never 0** (`desk-ibkr-sync`, owner
  check 2026-08-21). The write was `pct[p.sym] ?? 0`, so any symbol the feeds
  could not price was stored as FLAT — and the client made it worse, because
  `fmtPct(null)` returns `+0.00%` (`null >= 0` is true). Four option positions
  read 0.00% on the dashboard while **AVAV was down 38.4% and SPCX 19.5%**: the
  largest moves in the account were the ones claiming they had not moved. The
  row now renders an **em dash** with no gain/loss class and sorts to the
  bottom (`-Infinity`), so an unknown never ranks between a loser and a winner —
  the same rule the watchlist rail already followed.
  **OCC option symbols are stripped of IBKR's padding before the upstream
  call** (`upstreamSymbol`). Flex pads to fixed width — `AVAV  261002C00180000`
  — and Yahoo 404s on that; without the spaces all four resolve, so these
  positions carry a real day-% instead of nothing. The underlying ticker is
  never substituted: an option's move is its own, and reporting the stock's
  percentage against a contract would be a wrong number wearing a plausible
  face.
  **Day-% is measured against the SECOND-TO-LAST DAILY BAR, never
  `meta.chartPreviousClose`** (owner-facing fault found 2026-08-21). That field
  is the close preceding the REQUESTED RANGE, so on a 5-day call it reads five
  sessions back and a "day" percentage is really a WEEK's move. `desk-market`
  already documented the trap and took the prior bar; `desk-news` (news chip
  day-%) and `desk-ibkr-sync` (**the day-% stored for every position in the
  owner's accounts**) both still trusted the field. Measured against Yahoo's own
  1-day baseline on 16 names, the old form was wrong on **all 16** — GDX read
  13.12% on a 2.59% day, META −8.26% on a −0.04% day — and the new one matches
  to 0.00 on 15. Which bar counts as "prior" depends on whether the last one is
  TODAY, decided on the bar's own ET date so half-days and holidays need no
  special case — and read off the QUOTE'S OWN TIMESTAMP
  (`meta.regularMarketTime`), **never the wall clock**. That distinction is the
  whole rule: the first cut compared the last bar's date against `new Date()`
  and shipped, and at 00:48 ET the clock had rolled to the new date while both
  the newest bar and the quote were still the prior session — so it concluded
  the last bar was not today, took that same bar as the baseline, and measured
  its close against itself. **Every symbol read 0.00%** (caught on FRMI against
  a real +3.65% move), and 09:35 UTC — when the sync cron runs — is squarely
  inside that window, so it would have written a zero for every position in the
  account. Comparing the quote's ET date with the last bar's ET date holds at
  every hour. Do not "simplify" this back to a clock comparison.
  The two helpers are separate deployments with no shared module,
  so the fix is duplicated by necessity — keep them in step. One accepted
  difference: on an EX-DIVIDEND date the raw prior close and Yahoo's adjusted
  one differ by the payout (MSFT 2026-08-20: 484.31 vs 483.40, 0.18pt). The raw
  close is taken, because desk-market uses it and panels disagreeing with each
  other by a dividend is worse than differing from Yahoo's adjusted figure.
- `config/news-feeds.json` / `config/chart-watchlist.json` /
  `config/map-filters.json` — owner-editable rosters read by the edge
  functions at runtime (watchlist NEVER derived from holdings — public repo).
  **`chart-watchlist.json` did not exist until 2026-08-06** — it 404'd from the
  day `desk-charts` shipped, so the documented owner-editable roster was inert
  and every sweep silently used the code's `DEFAULT_WATCHLIST`. It was created
  holding EXACTLY those 25 defaults, so publishing it changed no behaviour; it
  is now the live roster and editing it takes effect. Four things bound an
  edit: it must be a **bare JSON array of strings** (the loader's own
  predicate — an object wrapper is rejected and falls back to the defaults,
  which is also why the file carries no `_note` like its neighbours); symbols
  are trimmed/upper-cased/**deduped** then **capped at 40** (the cap is what
  bounds upstream fan-out, and answers the old security-review finding that the
  roster length was unbounded); `rosterCache` holds it for **1 hour**, so an
  edit is not immediate; and `MIN_COVERAGE` 0.6 means a roster padded with
  tickers that don't resolve can fail the whole panel to `ok:false`.
  **The heatmap's ETF cut no longer reads this roster at all** (2026-08-06) —
  it is its own `desk-heatmap` universe; see that entry below. Until then the
  cut was built client-side out of the `desk-charts` payload, so an ETF got a
  tile only if the charts workbench happened to carry its 800-bar series, and
  the two rosters were coupled for no reason other than that.
- `config/widgets.json` — **EMPTY as of 2026-08-07 (owner ruling): both embeds
  are retired and the desk now runs NO third-party vendor JS at all** — the page
  carries zero iframes. The FRED "Economy at a glance" widget was replaced by
  FRED + St. Louis Fed RSS in `config/news-feeds.json`, which puts the same macro
  material in the News panel's own row idiom; the TradingView **economic
  calendar** went with it and has no replacement — upcoming-release visibility
  is simply gone, which the owner chose knowingly. Two things matter for anyone
  re-adding a widget. **An empty roster now means "none", not "use the
  defaults"**: the loader tested `Array.isArray(cfg) && cfg.length`, so `[]` was
  indistinguishable from a missing file and silently restored the built-in pair —
  there was NO way to turn the embeds off from config. It now tests
  `Array.isArray(cfg)` alone, so a valid array is authoritative whatever its
  length and only a fetch/parse failure falls back to `WIDGET_DEFAULTS`. And the
  file is a **bare JSON array**, so like `chart-watchlist.json` it can carry no
  `_note` — there is nowhere to put one without a loader change. The machinery
  below is intact and dormant; re-adding an entry brings a widget back with no
  code change.
  Historical, and still the contract if one returns: a roster of embedded
  third-party
  widgets from TWO providers — **TradingView** (economic calendar) and **FRED**
  (`fred-glance` = the St. Louis Fed "Economy at a glance" widget). Each is
  rendered by `loadWidgets()` as a bare sandboxed **cross-origin** iframe
  (`widgetFrameSrc` builds a `tradingview-widget.com` URL for TV widgets, or the
  provider URL for `fred-glance` — `spec.src` overrides for a configure-generated
  FRED set). (The TradingView **ticker tape** — the former `slot:'strip'` widget
  — was removed 2026-07-16; its symbols became half-size market-strip tiles fed
  by `desk-market`, owner ruling. That strip is gone too as of 2026-07-29 — see
  the Watchlists panel below.) Widgets render — panel-less, captionless — in
  the compact left-packed **`#acctWidgets` row inside the Accounts section**,
  directly under the account cards, sized by per-spec `width`/`height`
  (both 245×305 — matched to the half-width account cards they stack under,
  owner ruling 2026-07-16; the two former widget panels were removed the same
  day). Everything third-party is above the fold now, so
  ALL frames hydrate on **first user interaction** (a scroll-observer would
  run vendor JS on paint and trip the S1 gate). One shared static stamp under
  the row ("TradingView + FRED · live · sandboxed from the desk") replaces the
  former per-panel lamps; CSS hides row + stamp when nothing renders. Read
  CLIENT-side (`fetchPublic`), not by an edge function. Mode-independent (live
  external data in demo + live).
- **Watchlists panel** (`renderWatchlist()` + `wlTile()` + the editor, owner
  request 2026-07-29) — multiple named lists, unbounded symbols each.
  **Rendered as TILES, not a table** (owner request the same day, after seeing
  the table). The band/tile chrome is the shared `.mkt-group`/`.mkt-tile` CSS in
  `index.html`; `.wl-strip` widens it for a full-page panel.
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
  **EVERY COLUMN IN THE DESK ROW ENDS ON ONE LINE at ≥1120px** (owner request
  2026-08-21: "I want all of these windows to be as tall as the bottom of the
  Real Estate XLRE box"). **MARKETS is the measuring column** — four index
  tiles, a chart and eleven sector rows is content fixed by the desk rather
  than by whatever the feeds returned today, so it is the only honest ruler.
  Everything else is fitted to it: `.desk-row` goes `align-items: stretch`
  (it was `flex-start`, which let the boxes half stop at its own content and
  leave **~690px of empty page** beside the news), Ask loses its 420px cap and
  its `align-self: start` so the slack goes to the thread, and the account
  cards stretch to the same line instead of stopping 204px short.
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
  One ordering trap: the Ask and accounts overrides must sit **later in the
  stylesheet** than the base `align-self: start` and `max-height: 420px` they
  lift — equal specificity, so source order is the whole mechanism, and placed
  earlier they silently did nothing (measured: Ask stayed at 158 while News and
  Markets moved). Measured at 1512/1280/1152: all four panels end at 927 with
  XLRE at 912. Below 1120 the row stacks and every one of these rules is inert.
  **The watchlist change pill reads at the PRICE's size** (`.wl-pct`, 9 → 12px,
  owner request 2026-08-21: "bigger, but try to not resize the boxes"). It was
  the smallest thing on a tile whose whole job is to show a move. The tile is
  held at 76 × 63 by paying for the type out of the pill's own leading and side
  padding — 9px at 1.3 is 11.7px tall, 12px at 1.05 is 12.6 — so the row grows
  by **one pixel**, not four, and the widest real value still sits inside the
  66px of usable width with nothing clipped (S27 guards exactly this).
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
  trap the watchlist column layout hit at 1900.
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
  that avoids the wheel-eating fault. This is the one place a scrollbar beat
  the paging idiom: the watchlist columns keep theirs, because there the wheel
  had nowhere to chain from six short containers. Capping the whole
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
  **The roster is NOT in this repo.** It lives in `desk_watchlists`
  (`desk_010`): RLS deny-all, reached by anon only through the SECURITY DEFINER
  PIN RPCs `desk_get_watchlists` / `desk_set_watchlists`, and read server-side
  by `desk-watchlist` with the service key. `config/watchlists.json` is a
  BOOTSTRAP FALLBACK ONLY — editing it does nothing once the table is
  populated, and it says so in its own `_note`. `desk_set_watchlists` takes the
  COMPLETE desired state, so add/remove symbol and create/rename/reorder/delete
  list all land atomically in one replace-all; the seed is guarded on emptiness
  (not a fixed id) so a replay can't clobber later edits — the documented
  `desk_009` hazard.
  **A replace-all is version-guarded** (`desk_014`). `desk_get_watchlists_open`
  returns a `version` — `max(updated_at)` — and `desk_set_watchlists_open` takes
  `expected_version`, holds an exclusive table lock and REFUSES with
  `{ok:false, error:'conflict', version}` when the table has moved since. Every
  caller in this repo sends it; `null` means "do not check", so a cached
  pre-`desk_014` tab keeps working rather than bricking mid-session. This exists
  because a replace-all is otherwise a last-write-wins overwrite of everything
  that happened while a dialog was open, and **that is how the Radar list was
  silently deleted on 2026-08-01** — inserted while the dashboard was open, then
  erased by a later save built from a pre-Radar snapshot, leaving 15 rows with
  contiguous ids and no error anywhere. `wlMutate` was never the risk (its read
  and write are milliseconds apart); the **editor** is, because its draft is
  loaded when the modal opens and saved whenever the owner presses Save. On a
  conflict the editor reloads the draft IN PLACE and says so — it must not close
  (that discards the owner's edits) and must not re-send (that loses the same
  race again).
  **Create and delete a whole list from the panel** (owner request 2026-08-01) —
  a labelled `+ list` in the panel header mints an empty list; an `×` in each
  band's gutter, beside its ↑/↓, deletes that one. Both were previously
  reachable ONLY inside the ✎ editor, so the two commonest roster edits meant
  opening a modal, editing a draft and saving it. Three things are deliberate:
  the new-list control is **labelled rather than a bare `+`**, because the `+`
  next to it already means "new SYMBOL tile" and two identical glyphs doing
  different jobs is how a control gets pressed by mistake; **delete is gated on `wlLocked`** while
  create is NOT (owner ruling 2026-08-01, revising the first cut). The lock had
  been read as position-only — its tooltip promised "adding and removing stay
  available" — and delete was left ungated behind its confirm dialog; the
  owner's ruling draws the line at destruction instead, which is the more
  defensible reading, since losing a whole list is not the same kind of act as
  removing one tile. It is **disabled, never hidden** (like the ↑/↓ beside it),
  and refused inside `openWlDelList` as well as on the button — a disabled
  control is a hint, while the keyboard path and a stale render both reach the
  function directly, the same reason `wlCommitMove`/`wlMoveBand` enforce it
  themselves. The confirm dialog still names the
  list AND its symbol count, counted from the **saved** symbols so a list of
  unresolved tickers is never described as empty at the moment it is destroyed;
  and a **duplicate list name is refused** (case-insensitive), which is
  correctness rather than tidiness — `wlPick()` resolves a list by title
  whenever its index has shifted and gives up unless exactly one matches, so two
  lists sharing a name would make every add, remove and drop into either of them
  silently unaddressable. Both route through `wlMutate()` like every other
  write, and the delete resolves its target through `wlPick` so a roster that
  shifted under an open dialog deletes the list the owner POINTED AT or nothing.
  Editing is the ✎ in the panel header (live + authed only)
  → a modal in the system-prompt idiom; symbols are free text because the
  owner's source is a pasted broker table, normalised client-side for the count
  and again server-side where the RPC is the real authority.
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
  signal.
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
  messaging.** The auth gate itself stays, because `desk_set_watchlists` takes
  the PIN and there is no write path without one.
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
  The **SMA price display** (a right-edge price tag at each enabled SMA) was
  removed from Pro 1/2/3 the same day, owner request — the config, the popover
  group and the drawing code all went; the SMA lines themselves are untouched.
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
- `supabase/functions/` — versioned sources of the edge-function data layer
  (deployed only to the dedicated project). Anon-callable public feeds:
  `desk-market` (Stooq→Yahoo tiles + FRED 10Y for the core 6, plus
  Bitcoin/Gold/US Dollar as **best-effort** extras — a flaky extra drops only
  its tile, never gating the core; owner request 2026-07-16), `desk-heatmap` (Nasdaq
  screener→Yahoo), `desk-charts` (watchlist OHLC), `desk-news`
  (holdings-first RSS), `desk-maps` (Crypto/Futures/World cuts) — all
  session-aware cached + single-flight.
  **`desk-news` takes an owner-typed `topic`** (the box above the News panel,
  owner request 2026-08-14), and **a topic REPLACES THE WHOLE SWEEP** — general
  wire AND the per-ticker holdings lookups — rather than only the general feeds.
  The first cut kept the holdings lookups running, reasoning that dropping news
  about a position was the worse surprise; the owner's report (2026-08-17,
  typed "avav" and saw three FRMI headlines above it) settled it the other way,
  because those rows are ranked holdings-first and so land at the TOP, leaving
  the panel not showing what its own box says it shows. Held tickers are still
  read, but only to CHIP a row that names one — `dedupeRank`'s `heldFirst` is
  false under a topic, so ordering is pure recency. Two things follow. A topic
  that matches nothing is a **successful empty result**, not a thrown error:
  throwing lamps the panel STALE and keeps the last good render, which would
  leave the PREVIOUS topic's headlines sitting under the new topic's name. And
  the empty state names the topic, read from the payload's echoed `topic`
  (`DESK.data.newsTopic`) rather than the input box, which holds what is being
  typed now. The topic is sanitised server-side (`cleanTopic`, 60 chars,
  bounded character set) before it reaches an upstream URL, and cache +
  single-flight are keyed by it, capped at 8 slots.
  **`desk-heatmap` serves THREE universes** — `sp500` (default), `r2k`, and
  **`etf`** (added 2026-08-06). The ETF cut used to be assembled CLIENT-side by
  `buildEtfHeatmap()` out of the `desk-charts` payload, which meant an ETF got a
  tile only if the charts workbench happened to carry its 800-bar OHLCV series.
  It did not for 15 of the banded names, so the map drew **25 of 40** for its
  whole life — 20 in their proper bands plus 5 (KRE TLH UUP FXI INDA) swept into
  a catch-all `'ETFs'` bucket by `cats[sym] || 'ETFs'`, which is what kept the
  mismatch invisible. Re-sourcing it is a ~**800× data reduction**: the panel
  needs about six numbers per tile, which cost ~36 KB/name off the charts
  payload and ~46 bytes/name off the period sweep. Four things are load-bearing:
  the roster IS its grouping (`map-filters.json` → `etfCats`, read by BOTH
  sides), so a symbol can never be charted without a band or banded without
  being charted — the drift that caused this; tiles are sized by **dollar
  volume** (`last × averageDailyVolume3Month`, added to the shared `quoteBatch`
  fields) because an ETF has no market cap, and a missing volume falls to an
  area floor rather than dropping the tile; the five orphans were **added to
  `etfCats`** rather than let vanish (a strict rebuild would have shown 35 and
  silently lost 5 the owner could see — `UUP` in *Commodities* is the one
  judgement call, the rest are unambiguous); and the cut **lost its free pass on
  the period dropdown** — it used to compute 1W/1M/YTD from chart bars so could
  always answer, and now reads them off the shared sweep like every other cut,
  so it must be gated on `datasetHasPeriods` or picking 1M paints an empty map.
  40 names is one quote batch and one sweep nudge (160), so unlike the stock
  universes this one converges on its first call. The screener is NOT a fallback
  here (it lists common stocks, not funds); a crumb failure degrades to the 5-day
  spark, losing only the weighting, so every tile hits the floor together and the
  map stays readable.
  **`desk-charts` formats bar dates with ONE HOISTED `Intl.DateTimeFormat`**
  (`NY_DATE`) — this is the fix for the 546s (owner report 2026-08-05, charts
  panel blank on 20–50% of loads). `parseYahooChartOHLC` had called
  `toLocaleDateString('en-CA', {timeZone})` once per bar, which builds and
  discards an ICU formatter EVERY call; a cold sweep is 25 symbols × ~1250 bars
  of Yahoo's 5y daily range ≈ **31,000 calls, measured at 2611 ms of pure CPU**,
  which is the worker's whole budget — hence `WORKER_RESOURCE_LIMIT` with no
  upstream fault at all. Reusing one formatter is **2611 ms → 50 ms (52×)** for
  byte-identical output (verified over 33,334 timestamps spanning 2000–2026, so
  every DST transition; measured live, 10/20 failures → **0/50**, and latency
  2.19–3.63 s → 0.43–1.84 s). It must stay timezone-aware rather than become UTC
  string math, or half-days and DST land on the wrong session date. The bar-date
  guard beside it is load-bearing: the two date paths DISAGREE on a malformed
  timestamp — `toLocaleDateString` returns the string `"Invalid Date"` while
  `Intl…format` THROWS `RangeError` — so without it one bad row would fail the
  whole symbol into the (currently always-missing) Stooq fallback; the bar is
  skipped, never the symbol. **A prior 546 diagnosis here was WRONG and is
  recorded in-file so it is not retried:** per-request `JSON.stringify` of the
  ~934 KB payload was blamed and pre-serializing each symbol shipped as v9 —
  measured, it did not move the failure rate at all. The misread was that a
  `force:true` sweep survived where cache hits died; timing them head to head
  showed a cached call cost the SAME as a forced full sweep, which only makes
  sense because `seriesCache` is per-isolate module state and Supabase spreads
  requests across short-lived isolates, so nearly every request was already
  sweeping. The pre-serialization is kept on its own merits (the request path is
  a string join, and the parsed object is dropped from memory) but is NOT the
  fix. Because that path concatenates, the roster is **deduped** in
  `loadWatchlist`: a repeated ticker would emit the same JSON key twice, and
  `got` counts both where a parsed object keeps one — inflating `count`, letting
  the `MIN_COVERAGE` floor pass on fewer real series than it claims, and
  fetching the symbol twice per sweep. `generatedAt` is still rebuilt per
  request: `liveLampFor` measures poller health against it, so a memoized one
  (up to `HISTORY_TTL_MS` old) would lamp the panel STALE mid-session on a
  healthy feed.
  **`desk-heatmap` carried the SAME per-bar formatter and was fixed the same
  day** (`NY_DATE` there too). It was the worse of the two: one sweep nudge is
  `SWEEP_STEP_BATCHES`×20 = 160 symbols × ~250 bars of the 1y daily spark ≈
  **40,000 calls, 3778 ms of CPU → 80 ms (47×)**. The number that matters is
  that 3778 ms exceeded **`SWEEP_BUDGET_MS` (2500)**: that budget bounds the
  fetch DEADLINE, and the formatting runs after each batch resolves, so no
  wall-clock bound could ever contain it — which is why the PR #221 hardening
  (deadline on the fetch, persist partial progress) reduced the damage from
  being killed without stopping the kills. The sweep was being killed by its
  own date parsing. Its bar-date guard is load-bearing for a sharper reason
  than the charts one: a `RangeError` escapes `periodSweep` into
  `advanceSweep`'s `.catch(() => {})`, discarding the whole nudge before
  `writeSweepRow` — re-entering the exact ledger loss `SWEEP_BUDGET_MS` exists
  to prevent, through a different door. The pattern also survives, harmlessly,
  in `desk-market` (~63 bars × a few symbols). PIN-gated: `desk-ask` — an **agentic**
  desk assistant (not plain Q&A): replays prior exchanges from `desk_chat_memory`
  (≤20 turns / ≤30d / ~8k-char budget), runs a bounded tool loop (≤12 calls,
  ≤3 pause resumes) with `web_search`/`web_fetch` + `get_quote` (calls
  `quote-proxy kind:'info'` server-side) + `get_technicals` (calls
  `quote-proxy kind:'daily'` + a best-effort `kind:'intraday'` graft — the
  server-side port of `app.js`'s `graftTodayBar()`, so a live-session reading
  matches the charts — and computes RSI(14, Wilder) + the Pro 1 SWING
  Stochastic 14-3-3 + the Pro 2 LONG-TERM weekly-scale Stochastic 92-15-15, all
  from one fetch), gives **directional** views on the owner's positions (owner
  opt-in 2026-07-21; the "not financial advice" label stays), attributes
  provenance, and appends each exchange back to memory.
  **The tool loop must CARRY THE CODE-EXECUTION CONTAINER** (owner report
  2026-08-20: `model call failed (HTTP 400) — container_id is required when
  there are pending tool uses generated by code execution with tools`). The
  desk never asks for code execution, but `web_search_20260209` /
  `web_fetch_20260209` filter their results inside a container ("dynamic
  filtering") that the API provisions on its own; a response whose
  code-execution tool use is still pending — a `pause_turn` mid-search is the
  usual way — can only be continued by a request naming that container. So
  `containerId` latches `msg.container.id` the moment one appears and is sent
  as the top-level `container` on every later call of the turn, including the
  forced-search retry and the grounding-check revision, which resume the same
  conversation. It is never cleared mid-turn, and never sent on the first call
  (that is what asks for a fresh one). Without it the turn does not degrade —
  the request is invalid and the whole question dies. The system prompt
  itself is **owner-editable at runtime**: `desk_system_prompt` (`desk_009`,
  RLS deny-all, singleton row) is read live on every request via the PIN RPCs
  `desk_get_system_prompt`/`desk_set_system_prompt` (dashboard: the ⚙ button
  beside Ask-the-desk), falling back to the code's `DEFAULT_SYSTEM` constant
  only if that read fails. **Residual (Codex review, PR #182):** the
  `desk_009` migration only seeds the table's ORIGINAL day-one prompt text —
  every rule the owner has since added or edited live (the itemized rule
  numbering, the Stochastic Framework, BUY/SELL SIGNALS, brevity, etc.) exists
  only in that live row, not in any migration or repo file. A from-scratch
  restore via migration replay alone would silently revert to the original
  seed text, not the current live prompt; recovering the actual current
  prompt depends on Supabase's own data backup/PITR, not on the repo. This is
  accepted as the tradeoff for genuine self-service editing (no code
  deploy needed to change behavior) rather than patched via a migration
  update, since an unconditional seed-update would itself risk overwriting
  the owner's live customizations on a future replay. Web-query privacy
  (never sending real position sizes to search) is system-prompt-enforced,
  not hard-filtered.
  **THE ASSISTANT IS HANDED TICKERS, NEVER MONEY** (owner ruling 2026-08-12,
  shipped 2026-08-18): `buildAskContext()` sends `label` plus
  `positions:[{sym, dayPct}]` and nothing else — `nav`, `cash`, `dayPnl`,
  `totalUnrealized` and the per-position `qty`/`mkt`/`unrl` are all withheld.
  The ruling was "I don't want this guy to be concerned about my liquidity or
  look at my account balance. Just give me cold, hard fact regarding buy or
  sell the stock." **Withholding is the enforcement point, NOT a system-prompt
  rule** — a prompt asks the model not to dwell on a number it can still read,
  whereas removing it leaves nothing to weigh; this is why the assistant used
  to answer "your position is the largest thing in the account going in", which
  was correct reasoning over data it should never have had. Symbols stay, so
  "should I sell my GDX" still knows GDX is held; `dayPct` stays with them
  because it is the ticker's own market move, public data about the stock
  rather than a fact about the account. The four stored `desk_chat_memory` rows
  carrying portfolio-aware phrasing were edited IN PLACE on 2026-08-12 (not
  deleted — they also hold the GDX/META/SPCX/FRMI analysis), and a broad scan
  that flagged 7 of 11 rows was **all false positives**: "balance sheet" and
  "cash flow" about COMPANIES, and `$145` as a META price target. Deleting on
  that scan would have destroyed the analysis the ruling exists to keep.
  **Interrupting a question** (`.ask-stop` + `askAbort`, owner request
  2026-08-01) — the tool loop can reach 12 calls, so a stalled question had no
  exit but waiting. Stop aborts the fetch via an `AbortController` threaded into
  `deskAsk`. It severs **this tab's wait only**: the edge function runs to
  completion regardless, so the Claude quota is spent either way AND the
  exchange still reaches `desk_chat_memory` — the stopped note in the thread
  says so out loud, because a silent stop means the answer reappears on the next
  reload looking like a bug. Two deliberate choices: Stop is a **separate button**
  rather than Ask changing role (a control that swaps jobs under the cursor gets
  pressed as a re-send), and the **composer stays enabled** while in flight,
  since someone reaching for Stop wants to retype — `askBusy` still blocks a
  second send. Genuinely cancelling the SERVER run would need `desk-ask` to
  honour `req.signal` plus a deploy; not done.
  Origin-guarded anon: `quote-proxy` (OHLC for any ticker — no PIN, restricted
  to the site origin + in-memory cache; owner ruling 2026-07-14, paid plan).
  `kind:'info'` also returns a per-symbol live-quote line (last / day change /
  bid / ask) plus fundamentals (next earnings date + market cap / P/E /
  52-week range / dividend yield) from Yahoo v7/quote via a cached cookie+crumb
  handshake — powers the charts panel's quote readout + fundamentals strip
  (bid/ask are market-hours-only; Yahoo returns 0 when closed).
  **Extended hours (owner ruling 2026-07-29):** `kind:'intraday'` accepts
  `prepost:true`, widening the fetch to the 4:00am–8:00pm ET session; the
  `prepost` flag is part of the cache key (two different bar sets, never
  interchangeable). EVERY intraday bar carries `x` — 0 regular, 1 pre/post —
  classified from Yahoo's own per-day `meta.tradingPeriods.regular`, so the
  split survives DST and half-days without hardcoded UTC hours. Two measured
  properties of the extended feed drive the handling: Yahoo reports **no volume
  at all** outside the session (1141 of 1142 sampled bars were volume 0 — the
  Pro 3 volume strip is legitimately empty under the shaded band, not broken),
  and a few percent of pre/post bars carry **phantom wicks** — a high/low tens
  of dollars off their own open/close on zero volume (QQQ 2026-07-28 16:50: low
  647.43 against a 676.25 close, 7.2% off). Bodies are sound, so extended bars
  ONLY are de-spiked by clamping the wick to 1% outside open/close
  (`EXT_WICK_TOL`); regular bars are never touched (0 of 780 sampled exceeded
  that bound). **Indices have no extended session at all** — `^IXIC`/`^GSPC`
  report `hasPrePostMarketData:false` and simply repeat their close (^GSPC held
  7428.78 flat from 16:00 to 17:10), which is why the Markets index tiles stay
  at-close and the Markets chart keeps fetching regular-session only.
  Cron-secret-gated: `desk-ibkr-sync` (Flex → tables). Scheduled by pg_cron
  (`desk_005` migration): sync 22:35/09:35 UTC — dual-slot because IBKR
  statements roll overnight. Also cron-secret-gated: **`desk-cron-ask`**
  (`desk_018`, owner ruling 2026-08-11) — **the desk waking ITSELF up.** The
  scheduled-ask roster used to be a `setInterval` in `app.js`, so it only fired
  while the dashboard was open, which is exactly when the owner is already at
  the desk and could type the question; the ruling was that a cron task's only
  value is waking itself at a set time and delivering a market summary. It ticks
  **every 5 minutes** and the FUNCTION decides what is due, because pg_cron's
  clock is UTC and the roster's is **Pacific** — a fixed UTC line would drift an
  hour at every DST change and deliver the 8am summary at 7am for half the year.
  Due-ness is wall-clock, not elapsed-time, arithmetic (has the PT clock passed
  the slot, and was the last run at or after it on this PT date), which is exact
  on the two DST days that elapsed-time comparison gets wrong; `CATCHUP_MIN` (90)
  both lets a missed tick still deliver and stops a row added at 10am from
  back-firing an 8am slot. It stamps `last_run_at` **before** calling `desk-ask`,
  so a run that outlives the next tick or throws cannot be started twice, and it
  fires **one row per tick** — two rows due together would be back-to-back tool
  loops. It assembles the whole dashboard server-side (accounts from tables, the
  five public feeds, plus **Pro 1 / Pro 2 stochastics and RSI computed here** off
  the `desk-charts` bars — the model's own `get_technicals` is capped at 12 tool
  calls against a 25-symbol roster, so a question about "the watchlist" would
  otherwise get readings for the first few names and silence for the rest), then
  hands it to `desk-ask`, which appends the exchange to `desk_chat_memory` as
  usual — the table the Ask thread already replays from, so the summary is simply
  there when the desk is opened. **`desk-ask` therefore takes TWO auth paths**:
  the browser's PIN, or `x-cron-secret` resolving to the single owner row. The
  PIN is never stored server-side (only its salted hash), so a scheduled run has
  nothing to replay; the secret lives in function env + Vault and never reaches
  the client, so this widens nothing the browser can reach. The context cap in
  `desk-ask` went 30k → **80k characters** at the same time: PR #241's watchlist
  + heatmap + stochastics had quietly outgrown it, and the slice was cutting the
  snapshot off mid-string with the last sections (heatmap, chart readings) the
  first to vanish. (The scheduled twice-daily AI brief — `desk-brief`,
  its `desk-brief-evening`/`desk-brief-morning` cron jobs, and the dashboard
  panel that rendered it — was retired 2026-07-23, owner request: Ask-the-desk
  already covers the same ground on demand. The edge function and
  `desk_ai_briefs` table are left in place, unscheduled, in case the feature
  returns.)
- `specs/multi-account-trading-dashboard/` — the SDD artifact chain
  (brief/spec/plan/tasks/design/analysis).

## Required Commands
| Purpose | Command |
|---|---|
| Validate HTML | `npx html-validate index.html` |
| Contrast gate (WCAG AA) | `node .github/scripts/check-contrast.js` |
| Validate workflow YAML | `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/qa.yml'))"` |

## Project-Specific Security Constraints
- **Dedicated Supabase project ONLY** (owner ruling, 2026-07-10; see
  `learnings.jsonl`): never place desk tables/RPCs/functions in any existing
  project. If no slot exists, stop and ask the owner. Any resource decision
  outside this repo needs explicit owner approval first.
- The Supabase **anon key is public by design**; RLS default-deny + SECURITY
  DEFINER PIN RPCs are the enforcement boundary (data.md pattern).
- **Accepted residuals (live mode):** the PIN space is brute-forceable through
  the RPC (RLS cannot rate-limit); the PIN sits in sessionStorage for the tab
  session. Real balances never enter this repo or the served files. The five
  public feed functions are anon-callable by design (public market data,
  rosters fixed server-side / in committed config — not open proxies);
  unauthenticated invocations can burn free-tier quota, bounded by
  session-aware caches + single-flight. `quote-proxy` (owner ruling
  2026-07-14) takes an **arbitrary** ticker, so it is not roster-bounded like
  the five feeds; its guard is an **Origin allowlist** (site origin only) plus
  an in-memory cache — browser-enforced and unspoofable from page JS, but a
  non-browser client can forge the Origin header, so this is an abuse
  speed-bump on the paid plan's egress IP, not a hard auth wall. `desk-news`
  holds the service key to
  read held tickers for ranking, but only public headlines and Stooq day-%
  ever leave it — payload byte-shape-identical to the formerly-committed
  public news.json. `desk-heatmap` holds it too, solely for the
  `desk_feed_cache` table (`desk_006`, RLS deny-all) that persists its daily
  multi-period sweep — public market percentages only.
- **Third-party widget embeds — RETIRED 2026-08-07 (owner ruling).**
  `config/widgets.json` is `[]`, so nothing renders and **the desk runs no vendor
  JS and carries zero iframes**; this whole class of exposure is currently
  dormant, not merely mitigated. Verified after the change: 0 iframes on the
  page, the `#acctWidgets` row computing `display:none`, and no page errors.
  The rules below stay because the machinery is intact and a config edit brings
  a widget straight back — they are the contract any re-added embed must meet,
  NOT a description of what the page does today.
  (owner request 2026-07-15; panels removed in
  favour of the accounts-row layout 2026-07-16): the desk embeds TradingView
  widgets — the one place it runs vendor JS. Each widget is a **direct cross-origin iframe** on
  `tradingview-widget.com` (NOT a `srcdoc` doc — a srcdoc frame inherits the
  PARENT origin, so `allow-same-origin` there would put the vendor script
  same-origin with the desk and expose `sessionStorage`/the PIN; this was
  caught in PR #72 review and fixed). A real cross-origin `src` gives the frame
  TradingView's own origin, so the browser same-origin policy walls it off from
  the desk — it cannot read the page DOM, the PIN, or account data. The
  `sandbox` (`allow-scripts allow-same-origin allow-popups ...`) is
  defence-in-depth; `allow-same-origin` there refers to TradingView's origin,
  not the desk's. The frame also carries a tight Permissions-Policy
  `allow="accelerometer; gyroscope; magnetometer"` — motion sensors ONLY (the
  set TradingView's own official embed grants), deliberately NOT camera/
  microphone/geolocation/clipboard/payment, and scoped to the frame's own vendor
  origin. Historical note: the grant reaches only the DIRECT vendor frame — the
  now-removed **ticker tape**'s accelerometer probe fired inside a TradingView
  **nested sub-frame** the outer `allow` couldn't propagate into, so hydrate
  logged one benign `accelerometer is not allowed` violation (PR #78). With the
  ticker gone (2026-07-16) that warning no longer fires; the tightly-scoped
  **S3** accelerometer allowlist (exact-string match only; every other console
  error still fails) is now dormant but retained in case a future TV widget
  probes the same sensor — NOT to be widened, and never widen S1. **FRED (`fred-glance`, owner request 2026-07-15) is a SECOND
  embed provider on the same footing** — a direct cross-origin iframe on
  `research.stlouisfed.org` (self-contained, no parent-page vendor script),
  sandboxed identically; `allow-same-origin` there refers to FRED's origin.
  Every widget frame (the accounts-row calendar/FRED) sits
  **above the fold**, so all loads defer to the **first user interaction**
  (pointer/scroll/key/touch, PR #76 pattern) — S1's load-time check never
  interacts, so nothing third-party runs on initial paint and the S1 console
  gate stays clean (do NOT widen the S1 allowlist for widget origins; the
  deferred hydration is the containment). Residual:
  each vendor sees the viewer's IP/UA and sets its own cookies in its own frame;
  no desk data crosses the boundary. Roster is owner-controlled
  (`config/widgets.json`).
- **NEVER send a browser-shaped `user-agent` on an edge function's own
  Supabase REST call** (learned the hard way, 2026-07-29). This project's
  service key is the newer `sb_secret_…` format, and the API gateway refuses a
  secret key whenever the request looks like it came from a browser — a
  `Mozilla/5.0` UA is enough. The reply is `401 Forbidden use of secret API key
  in browser`, which a `.catch(() => null)` will happily swallow into a silent
  empty result (this cost a full debugging round on `desk-watchlist`: the
  function 502'd with no clue, and the table read only worked once the UA was
  dropped). The `UA` const belongs on OUTBOUND third-party fetches (Yahoo,
  Stooq, FRED) and nowhere else.
- Server-side keys (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, IBKR
  token/query-id, `CRON_SECRET`) live only in edge-function secrets;
  `cron_secret`/`anon_key` also sit in Vault for pg_cron header assembly —
  never client-side, never committed. GitHub keeps only
  `TEST_AUTH_CREDENTIAL` (`KEEPALIVE_PAT` and its consumer `keepalive.yml`
  were both retired 2026-08-22; secret deletion owner-confirmed, so this is
  the enumeration, not a pending state). **`CRON_SECRET` became an ALTERNATIVE AUTH for
  `desk-ask` on 2026-08-11** (`desk-cron-ask` — see the functions map): a
  scheduled run has nobody present to type the PIN, and the PIN cannot be
  replayed server-side because only its salted hash is stored. The secret is
  function-env + Vault only, so nothing the browser can reach gained a second
  door; but it does mean `CRON_SECRET` now unlocks the assistant as the owner,
  not just the sync jobs — treat it as a credential of the same weight as the
  PIN, and never expose it to a client or a repo.
- **Supabase free-tier auto-pause runbook:** if live panels lamp STALE and
  login fails, the project likely auto-paused — restore it from the Supabase
  dashboard. Early-warning signals: the S14 canary failing in CI and
  `cron.job_run_details` gaps. The IBKR Flex token expires **2027-06-14**
  (renew in Client Portal → update the `IBKR_FLEX_TOKEN` function secret).

## Project-Specific Coding Standards
- **Live mode is REAL DATA OR NOTHING (owner ruling 2026-07-22):** no panel
  may ever render demo/fabricated data while `DESK.mode !== 'demo'` — a feed
  failure shows a blank/empty state with a STALE lamp and a fast retry
  (visibility-aware), or keeps the last good LIVE render. The demo generator
  is exclusively for `?demo=1`.
- Price-change percentages use **2 decimals** (finance convention) — a
  deliberate exception to the editorial whole-number rule; allocation-style
  percentages stay whole.
- All dynamic DOM text via `textContent` — never `innerHTML`.
- Series colors/order are CVD-validated (`--color-series-1..3`): do not reorder.
- Gain/loss colors are P&L-only, never decorative.
- Every panel carries a data-state lamp + as-of stamp (the design signature);
  new panels must too.
- **NEVER use `overscroll-behavior: contain` (the shorthand) on this page.**
  The owner reported the same fault three times across 2026-08-07: the mouse
  wheel dies over a panel and the page only scrolls from the far edges of the
  screen. `contain` stops a scroll chaining to the page — right at the END of a
  long list, but it applies just as hard when the container has NOTHING to
  scroll, and then it simply eats the wheel. **Chromium chains regardless, so
  this never reproduces in a Chromium harness** (this sandbox has no WebKit
  build; `playwright install webkit` downloads but its host libraries are
  missing), which is why two rounds of "verified fixed" were wrong. The last
  holdout was `.ask-thread`, empty before the first question and therefore
  invisible to every scan — it needs a live AUTHED session to exist at all.
  A scan is only meaningful if it checks both axes and every mode: an earlier
  one tested `overflowY` alone and reported zero traps while `overflow-x`
  scrollers went unexamined. The page now carries the property in NO form: the
  axis-scoped `overscroll-behavior-x` went with the horizontal watchlist bands
  it belonged to, and the watchlist columns answer chaining a different way (see
  below). Only the shorthand was ever banned, but there is nothing left using
  either.
- **The watchlist columns are PAGED, not scrolled** (owner request 2026-08-20:
  "as soon as the scroll ends, it scrolls up the screen … maybe we need a
  different mechanism to move the symbols up and down in the watch list, and
  need to scroll to move the entire screen up and down"). `.wl-strip
  .mkt-group-tiles` is `overflow: hidden`, so the wheel has nothing to grab
  anywhere on this panel and always moves the PAGE; `wlSyncPaging()` gives a
  column that ACTUALLY overflows a ▲/▼ footer that steps it by whole tiles.
  `contain` would have stopped the chaining in one line and is the obvious
  reach — it is also the exact rule banned above, and six of the seven columns
  here are the short container it kills the wheel over. Four things are
  load-bearing. Overflow is **measured, never inferred from the symbol count**
  (a wrapped long name changes tile height). The **▼ carries the count still
  below it**, because with no scrollbar nothing else on screen says a list
  continues, and a silently cropped list reads as a complete one; the count is
  read from `getBoundingClientRect`, NOT `offsetTop` — the column is statically
  positioned, so offsetTop is measured from an ancestor further up and reported
  all 41 tiles as hidden on a list showing 10. The bar is a **footer, not a
  header control**: every column's tiles start on the same line, so the two
  extra buttons wrapping the band head pushed the tiles of ALL SEVEN columns
  down 19px to pay for a control on one. And a **drag steps the column by
  resting on the ▼**, wired from `wlDragMove` rather than a `pointerenter` on
  the button — a drag in progress owns the pointer, so the button receives no
  pointer events of its own and the listener fired exactly never. S42 guards
  all of it; note that its hover check must put the bar and a tile on screen
  TOGETHER, since `elementFromPoint` returns null outside the viewport and a
  below-the-fold button silently reports no hover at all.

## Agent Workflow
1. Use a `claude/<name>` feature branch
2. For a non-trivial feature, run `/sdd-loop` (`specify` → `clarify` → `plan` → `tasks`) before coding — separate WHAT from HOW; trivial changes skip to step 3
3. Implement changes per the Application Architecture map above — or `/sdd-loop analyze` then `/sdd-loop implement` to check consistency and work the task list
4. Run Required Commands above — all must pass
5. Prefer `qa-pipeline`; run steps individually only if it fails:
   `test-verifier` → `pr-review-toolkit:code-reviewer` → `/security-review` (if security-relevant) → `pr-readiness-reviewer`
6. Open PR to `main`; merging follows the inherited rules in
   `directives/git.md` (*PR Lifecycle*, *Conditional Auto-Merge on Green*,
   *Repo-settings preflight*) — do not restate them here.

## UI Test Configuration
Read by `ui-tester` and the Playwright kit at runtime — fill in before invoking agents:
| Key | Value |
|---|---|
| App URL | `https://akyachtsman.github.io/claude.trading/` (demo state: append `?demo=1` for deterministic data) |
| Valid test credential | repo secret `TEST_AUTH_CREDENTIAL` (name only — never commit the value; set — S10 exercises the live unlock path in CI) |
| Invalid test credential | `000000` |
| Primary nav button | `Load` (charts-workbench symbol loader) |
| Primary content selector | `.account .hero-number` |
| Nav cards | n/a — single-page dashboard (panels: Accounts, Markets, Heatmap, Stochastic charts, Ask the desk, News) |
| Playwright test directory | `.github/scripts/ui-tests` |
| Key selectors | lock form: `.lock-form input.input` + button `Unlock` · error: `.panel-lock .lock-error` (**always scope it** — `.lock-error` is the shared error-line class every modal reuses, so a bare selector matches 5+ elements and Playwright strict mode rejects it) · lamps: `#newsLamp #askLamp #mktLamp` · chart: `#wbChart` · Markets chart: `#mktChart` · news rows: `.news-row` |

## Project-Specific Test Scenarios
Authoritative list of coverage beyond the generic S1–S4 suite — one
`app.spec.js` scenario per row, numbered from S5. Live-gated rows skip
cleanly while `DESK_DB` is empty; with the desk LIVE (current state) S10/S11
run for real against the dedicated project on every PR.
| # | Feature | What to verify | Failure indicator |
|---|---|---|---|
| S5 | Demo lamps | With `?demo=1`, the desk-state cluster (labeled "MARKETS", Accounts header since 2026-07-22) shows "Demo data" and every panel lamp (news, ask) reads Demo | Any lamp shows LIVE/EOD/LOCKED in demo |
| S6 | Positions sort | Clicking a positions header sorts rows and flips `aria-sort`; first-row value order changes accordingly | Order/aria-sort unchanged after click |
| S10 | Locked → login → render (live only) | With a backend configured + `TEST_AUTH_CREDENTIAL`: locked shell pre-auth, valid PIN renders accounts | Skips while demo-only; fails if unlock doesn't render |
| S12 | Charts workbench | With `?demo=1`, `#wbChart` renders all three pane captions (Pro 1 swing / Pro 2 long-term / Pro 3 day-trading EOD) with candles + 6 stochastic paths; zoom segs and symbol select redraw; PANE seg maximizes a tier; settings popover opens with per-pane chart-style radios + indicator/SMA/S-R checkboxes, and Pro 3 alone carries the Session → "Extended hours" toggle | Missing pane, empty SVG, dead controls, popover missing controls, or the EXT toggle offered on Pro 1/Pro 2 |
| S25 | Pro 2 stochastic candles | With `?demo=1`, EVERY Pro 2 candle's colour matches the **weekly** `%K` vs `%D` (read off the rendered SVG, pane-scoped by title, volume bars excluded — they stay price-coloured). TWO negative controls must both fail the same comparison: the pane's own daily strip, and Pro 1 against its stochastic. Sampling tolerance scales with bar spacing, so it holds at phone width | Any Pro 2 candle disagreeing with the weekly crossover (a silent fallback to open/close), the daily strip also matching (the wrong series drives the colour), or Pro 1 agreeing everywhere (the rule leaked into the wrong pane) |
| S34 | Pro 2 steady candle colour | With `?demo=1` the caption carries NO `(STEADY)` and steady is off. Armed through the gear popover's own checkbox (not by poking `wbState` — a state-only test passes even if the control was never wired): the caption gains `(STEADY)`, the candle colours CHANGE, flip **fewer** times than before **but still more than zero** (a rule that suppressed crossovers generally, rather than only the extreme-zone ones, would pass a fewer-flips assertion by never turning at all), and the same bars keep the same colours across a zoom — read from the NARROW window's OLDEST bars, since that is where a viewport-seeded state machine diverges | A toggle that only stores a flag, a mid-band crossover the colour ignores (the owner's stated rule), a mode the caption doesn't name (crossed lines with old-regime candles then read as a stale render), or a candle that changes colour on zoom (seeded at the visible window instead of the whole series — 20 of the 25 charted symbols repaint, up to 77 bars) |
| S36 | Sticky Pro 1/Pro 2 spans | With `?demo=1`, the panes open on 3M/6M; picking spans that BOTH differ from those defaults survives a reload **independently** (restoring a pane to its own default would look like success while doing nothing), and a hand-edited `wb_sticky_v1` span falls back to the default | A span lost on reload, only one pane restoring, or a corrupt value sizing a window no seg button matches — every preset then reads unpressed and the pane is at a width nothing in the UI explains |
| S37 | Last-price tab | With `?demo=1`, all THREE panes carry a price flag and its inverted label (a flag with no number, or a number with no flag, must fail), all three read the SAME price — a per-pane number would mean it is drawn from the visible window — each sits inside its own pane, and after PANNING Pro 1 back through history the number is UNCHANGED | A missing or per-pane tab, a tab drawn outside the pane, or a price that shifts when panned — that is the `end - 1` bug, labelling an old close as the current price |
| S40 | Charts rail — manual + roster | With `?demo=1`, `#wbSidebar` renders TWO columns side by side; the manual one starts empty and says what fills it; the picker offers "Charts roster" PLUS every watchlist (a one-entry picker means the rail never repainted when the lists landed); typing stacks newest-first and re-typing lifts rather than duplicates; an UNCHARTABLE ticker is not pinned; clicking a ROSTER name charts it without entering the manual column; both the stack and the chosen roster survive a reload; the `×` removes one | A rail that quietly collects every symbol looked at, a typo taking a permanent seat in a persisted column, a picker stuck on one entry, or either half lost on reload |
| S42 | Watchlist column paging | With `?demo=1`, NO column is wheel-scrollable (`overflow` hidden on both axes) and none carries `overscroll-behavior` in any form; the wheel over a column moves the PAGE; a ▲/▼ footer renders on exactly the columns that overflow and nowhere else; the paged column's band head is no taller than its neighbours; the ▲ is dead at the top, the ▼ names how many are still below and that count FALLS as you step, and the ▼ dies at the bottom with the last tiles on screen. Then forced live: resting a DRAG on the ▼ steps the column | A column that still eats the wheel, a pager on a list that fits (or missing from one that does not), a control that grows the band head — which pushes every column's tiles down, not just its own — a count that never changes (it is counting the list, not what is hidden), or a drag that cannot reach past the visible rows, leaving most of a long list undroppable |
| S41 | Watchlists are vertical columns | With `?demo=1`, tiles STACK downward inside a category and the categories sit SIDE BY SIDE; no `role=tab` exists (the columns are the navigation); the panel sits above `.area-charts` and shares its left edge; no sideways page scroll and no inner crop on `.wl-strip`; and in live NO reorder control is a bare `←`/`‹` | Tiles rendering as fixed-height boxes (a row's `flex-basis` governs HEIGHT in a column — it still looks plausible), a panel inset from the chart below it, or a reorder arrow impersonating a back button, which is what the UI crawler's back selector grabs |
| S39 | Volume average | With `?demo=1`, all THREE panes carry a `path[data-volma]` in the %D yellow with no NaN coordinates, and Pro 1's spans its FULL 63-bar 3M window rather than 63−20 | A missing line, or one that starts 20 bars in — that is an average computed from the visible window, which also shifts every time you zoom |
| S20 | Watchlist chart timeframe | With `?demo=1`, `#wlTf` offers all 7 spans (1D…5Y) with 1D pressed; picking 1Y flips `aria-pressed`, redraws every tile sparkline to a different path, and survives a reload (persisted, not per-render state) | Control missing/short, the path unchanged after switching, or the choice lost on reload |
| S26 | Watchlist drag to arrange | With `?demo=1` NO staging tray or + renders. Live: every band carries `data-band`; a drag under a sort key draws no ghost and instead snaps `wlSort` to Manual with a note; a real drag shows ghost + insertion marker + lit target and cleans both up on drop; Escape cancels; the tray round-trips through `localStorage` across a reload; double-click removal still opens the confirm dialog | A drag that silently fights a sort key, a ghost or marker left behind, a tray tile lost on reload, the trash replacing double-click, or any page error during a drag |
| S31 | Create + delete a whole list | With `?demo=1` NO `#wlNewListBtn` and no `.wl-del` render. Forced live+authed against a stateful fake roster: the created list PERSISTS to the store, a case-insensitive duplicate name is refused without writing and without discarding the typed name, **under `wlLocked` the `×` is disabled AND `openWlDelList` refuses even when called directly while `+ list` stays available**, the delete confirm names the list and its symbol count and opens focus on "Keep it", and the deleted list is gone from the store | A write control in demo, a duplicate accepted (it makes both lists unaddressable via `wlPick`), a delete reachable under the lock (the button guard alone is not the rule), a confirm that doesn't say what is being destroyed, or a delete that only repaints |
| S21 | Watchlist quick add + double-click remove | With `?demo=1` (no backend to write to) NO write control renders and tiles keep native double-tap zoom. Switching to live with `DESK.authed` left **false** must still render one + per band (owner ruling 2026-07-30 — edits do not depend on unlocking); a SINGLE click does NOT open `#wlRmBackdrop` but a double-click does (focus on "Keep it"), the tiles compute `touch-action: manipulation` so a phone double-tap is not eaten by zoom, Delete on a focused tile opens the same dialog, and quick-add rejects junk input | A + offered in demo, edits re-gated on auth, a single click removing, no keyboard path, or junk accepted |
| S23 | Extended hours (post-market) | With `?demo=1`, all four index tiles carry a `.mk-ext` line NAMING their proxy (SPY/QQQ/IWM/DIA) + "after hrs", the extended % differs from the regular one, all 11 sector cells carry `.mk-sec-ext`, and the demo heatmap has SOME tiles with `extPct` and some without (absent = did not trade, never 0) | A tile showing an unattributed second %, the extended figure repeating the close, or every heatmap name carrying a print |
| S27 | Watchlist tile shape | With `?demo=1`, a tile is ≤80px wide (the half-width 66px layout), its rendered top-to-bottom order is ticker → price → change → line (`.wl-vals` is `display:contents`, so DOM order still nests them), and NO `.mkt-last` or `.mkt-name` overflows its own box | A tile back at 132px, the line between price and pill, or any clipped value — a clipped price is a wrong price and fails silently |
| S35 | Symbol detail window | With `?demo=1` a single click opens `#wlDetailBackdrop` on the clicked ticker, the chart draws candles + volume, the span control opens on the panel's own `wlTf` and switching it redraws the chart WITHOUT retiming `wlTf`, and Escape closes. Then forced live (`DESK.authed` left **false** — opening a window READS a symbol and must not need an unlock): a **double-click reaches the removal dialog and leaves the detail window shut** (waited past `WL_CLICK_MS`, so a leaked timer would have fired), a single click still opens it without reaching removal, and a **drag/drop opens nothing** | The window opening under a removal (the deferred-open cancel is broken, and the modal then swallows the second click — removal dies outright), a modal control retiming the whole panel, a drop opening a window on every arrange, or an empty `<svg>` |
| S28 | Charts quote expires by age | With `?demo=1`, `wbInfoTtlMs()` returns one of the two session cadences (60s / 15 min) and a `wbInfoCache` entry carries both `at` and `info`. Guards the CONTRACT, not the bug: reproducing it needs a tab held open across a session boundary, which CI cannot do | A cache keyed on presence again (the 2026-07-31 SMH report: the prior session's close and move shown under a "delayed by 1 minute" stamp) |
| S32 | Interrupt a question | With `?demo=1` NO `.ask-stop` renders (nothing to stop). Forced live+authed with `deskAsk` stubbed to hang until aborted: Stop appears only while in flight, the COMPOSER STAYS ENABLED throughout, and after Stop the button returns to "Ask", `askBusy` clears, and a `.ask-a--stopped` note states the answer is still coming — with the red `.lock-error` line staying hidden | A Stop offered in demo, a composer disabled mid-flight, a wedged `askBusy` (the panel is then dead), a silent stop (the answer reappears on reload looking like a bug), or a deliberate stop rendered as an error |
| S29 | Scheduled asks | With `?demo=1` NO ⏱ renders (no backend to write to). Forced live+authed against a stateful fake roster: the ⏱ opens it, a new row saves and is read BACK WITH ITS ID, a second save of the same row sends that id and updates in place, the cadence control swaps the time control (a clock for daily/weekdays, minutes-past-the-hour for hourly/every-N), the 10-row cap holds on a DIRECT assignment, and the first ✕ over unsaved edits warns instead of discarding | A ⏱ in demo, an id dropped on save (the write is an upsert-by-id and the cron stamps `last_run_at` on those rows — a lost id inserts a twin and re-fires today's summary), an hour offered for a cadence that ignores it, an uncapped roster (each firing is real Claude quota), or edits discarded silently |
| S33 | Verify-answer toggle | With `?demo=1` NO `.ask-verify` renders. Forced live+authed with `deskAsk` stubbed to RECORD its `verify` argument: off by default, arming sends `true` **on the wire** (not just `aria-pressed`), it disarms itself once an answer lands so the next question sends `false`, and a FAILED question keeps the arm | A toggle that stays on (every follow-up silently bills the check), a reset that's only cosmetic, or an error that disarms — the owner re-sends and their choice is gone |
| S11 | Wrong-PIN error (live only) | Invalid PIN shows `.panel-lock .lock-error` text, stays locked, no data leaks | Skips while demo-only; fails if error absent or data renders |
| S30 | Watchlist write conflict | With `?demo=1`, `deskSetWatchlists` forwards a version it is handed, `wlMutate` echoes back the version its own read returned, and an omitted version serializes as an explicit `null` — `undefined` would be dropped by `JSON.stringify` and silently bind the RPC's no-check default. The refusal itself is server-side (`desk_014`), exercised against the live table rather than in CI | A write with no `expected_version`, a version invented at write time rather than read, or `undefined` on the wire |
| S44 | Rail agrees with the header | With `?demo=1`, seeding `wbInfoCache` for the charted symbol and repainting makes the rail row show the header's own quote — `changePct` in the regular session, `extPct` when an extended print exists — and it replaces whatever the rail held | A rail row contradicting the header above it (two vintages, nothing saying which is older), or an extended print rendered as the regular % |
| S43 | News row dating | With `?demo=1`, rows older than today render a `.news-date` reading `Mon D` ABOVE the clock, today's rows carry NO date, the clock survives alongside the date, the exact instant is in the row's `title`, and no when-column clips | Every row dated (twenty identical `Aug 24`s destroy the signal), no row dated (the Jun-29-reads-as-14:19 fault), a date replacing the clock, or a clipped date — a clipped date is a wrong date |
| S13 | Heatmap map filter | With `?demo=1`, the panel starts COLLAPSED (`#heatBody` hidden, `aria-expanded=false`) and opens on `#heatToggle`; then the MAP FILTER bar cuts the treemap (Dow 30 shrinks tile count); Themes regroups the S&P dataset; live-fed universes (World/Crypto/Futures — `desk-maps`; Russell 2000 — `desk-heatmap` r2k universe) render disabled in demo. On the ETF cut, **every banded ETF gets a tile** — `tiles === Object.keys(etfCats).length`, with NO catch-all band and periods on every tile — read off the dataset via `page.evaluate`, NOT counted in the SVG (tiles are bare `rect`s with no class, sub-3px tiles are skipped by design, and the gloss overlay adds a second rect each, so a DOM count is both ambiguous and flaky at phone width). Live mode additionally unlocks 1W/1M/YTD on stock cuts once the feed's daily 1y period sweep lands (tiles carry `pctW/pctM/pctYtd`) | Cut doesn't re-render, period gating wrong, disabled rows clickable, or a banded ETF with no tile — the 2026-08-06 regression, where the cut drew 25 of 40 because it was built from whatever the charts panel happened to carry |
| S14 | Live-feed canary (live only) | Desk lamp (`#mastheadState`, labeled "MARKETS", in the Accounts header since 2026-07-22) reads **LIVE** (market open) or **EOD** (market closed) — proves the edge-function feed layer end-to-end (there is no snapshot fallback anymore); skips while demo-only. **STALE is a THIRD legitimate state inside `withinCloseSettleGrace()`** (16:00–16:15 ET) and the scenario accepts it there ONLY: `liveLampFor` will not claim EOD while the newest snapshot still predates the close instant, since EOD asserts the number IS the closing print and desk-market is briefly still serving a body it cached at 15:59 (PR #193). Asserting just LIVE/EOD made this canary fail on any run crossing the bell — `main` went red on 1e3db75 with desktop/tablet reading LIVE at 19:50Z and mobile-chrome/iphone reading STALE at 20:00:29Z and 20:02:08Z, same commit, clock the only variable. The window is evaluated PER ATTEMPT, against the instant the lamp was actually read, inside an `expect(fn).toPass()` retry — never chosen once up front. Selecting the matcher from `withinCloseSettleGrace() || withinCloseSettleGrace(now+20s)` to cover the bell passing mid-wait is the trap and was caught in review: in the last 20s before 16:00 ET the future operand is already true while the market is still OPEN, so a genuinely stalled open-hours feed matches the permissive pattern immediately and the canary reports a FALSE SUCCESS (verified: 15:59:45 ET gives now=false, now+20s=true); the same cached boolean also stays permissive if polling runs past 16:15. A canary that passes while the feed is dead is worse than one that fails spuriously. Do NOT widen this to accept STALE unconditionally — outside the window it must still fail loudly. Note: S1 and S3 allowlist errors from the feed origin ONLY (`.supabase.co/functions/v1/`) — the app handles feed failures by design (panels lamp STALE); S14 is where feed health fails loudly. That allowlist is now ONE shared block at the top of `app.spec.js` (`FEED_ORIGIN`/`FEED_CORS`/`BENIGN_CONSOLE`/`benignPageError`), not a copy per scenario: on 2026-08-01 the copies drifted and S3's `pageerror` listener had no filter at all, so `[iphone]` failed on exactly what `[mobile-chrome]` was already dropping — **WebKit raises a blocked cross-origin fetch as a pageerror, Chromium only logs it**. The SAME drift recurred one layer down hours later (the `0bfb372` post-merge run on `main`): the shared rule had been applied to the pageerror listener but not to S3's CONSOLE twin, which still demanded the FEED ORIGIN appear in the message text or location — and the first message of WebKit's CORS pair names only the refused origin, so `[iphone]` failed again. The rule is therefore ONE predicate, `benignCors(text, src)`, that every listener calls (`benignPageError` is now just its no-`src` alias) — restating it is the bug. It is deliberately stricter than a bare CORS match (pageerror is where real faults land): CORS-phrased AND naming either the feed origin or the run's own origin, and the own-origin half is enabled ONLY for a LOCAL test server (`localhost`/`127.0.0.1`) — not merely "any origin that isn't production", since `qa-live` takes an `app_url` override and a staging deploy would otherwise inherit the carve-out and swallow a real `quote-proxy` CORS break that S14 (which proves the MARKET feed) would not catch | Lamp STALE/missing on a healthy backend, or the S1/S3 allowlist widened beyond the feed origin |
| S15 | Assistant memory (opt-in, live) | With `RUN_ASSISTANT_TESTS=1` + live backend: ask, reload, prior exchange replays from `desk_chat_memory` (transcript contains the earlier text) | Transcript empty after reload despite a stored exchange |
| S16 | Assistant research (opt-in, live) | A snapshot-absent question renders an answer (web tools available) | No answer bubble renders |
| S17 | Assistant live data (opt-in, live) | An off-page ticker returns an answer (the `get_quote` path) | No answer bubble renders |
| S18 | Assistant advice posture (opt-in, live) | A buy/sell/hold question returns an answer, NOT `.lock-error`; the "not financial advice" disclaimer stays | A refusal error, or the disclaimer missing |
| S19 | Assistant clear (opt-in, live) | The Clear control (confirmed) empties `.ask-thread` | Thread still shows exchanges after clear |

**S15–S19 are OPT-IN** (gated on `RUN_ASSISTANT_TESTS` on top of the live+auth
gates) — each makes a real `desk-ask` Claude tool-loop call (slow, nondeterministic,
costs quota), so they never run in normal CI; run them on demand.

## Owner Communication Preferences
- **Explanations of how things work (data flows, architecture, processes):
  lead with a simple table** — one row per component, plain-language columns
  (what / where it comes from / when it updates / how it reaches the user) —
  followed by at most two takeaway sentences. No jargon in the cells;
  mechanism detail only if asked. (Owner preference, 2026-07-13.)
- **Never silently shrink an expected scope.** When a feature has an obvious
  reference (finviz map = ALL ~2000 names), build the full expected thing or
  surface the trade-off BEFORE shipping and let the owner choose. A caption
  disclosing the cut is not consent. (Owner ruling, 2026-07-14.)
- **Aesthetic/sizing changes: one decisive change; mock ONLY on request.**
  Make one decisive larger adjustment rather than pixel-nudging increments
  across many rounds, and ship it — do NOT produce a mock first unless the
  owner explicitly asks for one (owner update 2026-07-16, superseding the
  2026-07-15 mock-first rule). Corollary: vendor widget iframes render blank
  in the sandbox, so measure sizes from the owner's screenshots, not a local
  render.

## Reporting Requirements
Agents write evidence to `.agent-reports/`:
- `implementation-summary.md`, `test-report.md`, `ui-test-report.md`
- `playwright-results.json`, `screenshots/` (on failure)
- `code-review-report.md`, `test-coverage-report.md`, `security-review-report.md`, `pr-readiness-report.md`

## Safety Rules for Agents
- Reviewer agents must not edit code unless explicitly instructed.
- Test commands must not require production credentials.
- Destructive commands, data resets, migrations, or deploys require explicit approval.
- If a check can't run locally, explain why and name the closest substitute.

## Session Start
1. Read all Imported Directive URLs above fully
2. Verify the directives-toolkit plugin attached (commands/agents resolve) per global.md → Skill Bootstrap
3. Confirm active branch: `git branch --show-current`
4. Run `/env-chk` and report status
