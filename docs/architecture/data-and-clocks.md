# Data layer, clocks and feed lamps

`scripts/data.js` (formatters, seeded demo generator, trading calendar, mode resolution, `liveLampFor` lamps, uniform stamps, Pacific clocks, news-row dating) plus the session-aware feed poller and lamp ageing in `scripts/app.js`.

- `scripts/data.js` — formatters, seeded demo generator, trading-day calendar,
  mode resolution, `deskFeed()` live-feed wrapper, `marketSessionOpen()`,
  two-tier `liveLampFor` staleness lamps; every panel stamp renders one uniform
  terse format via `fmtUpdated` — `Last updated {time} · {Mon D}` (clock dropped
  when only a trading-day as-of exists). The clock is when the DATA last changed,
  NOT the fetch (owner ruling 2026-07-22): for price feeds (`liveLampFor(...,
  priceBound=true)` — market/heatmap/charts/masthead) once the market is closed
  the stamp reads the session close (`marketCloseInstant` = 16:00 ET / 1:00pm PT
  on the as-of day; 13:00 ET / 10:00am PT on a `NYSE_EARLY_CLOSES` half-day) instead of the hourly re-poll clock; intraday and non-price
  feeds (news) keep the fetch clock (≈ now). The price lamp itself reads **EOD**
  (not LIVE) once the market is shut — LIVE shows ONLY while the session is open
  and quotes are streaming (owner ruling 2026-07-22); STALE still flags a genuinely
  stalled open-hours poller, and non-price feeds keep LIVE/STALE by fetch. (A
  future extended-hours quote feed would widen the LIVE window.) Every backend
  call (RPC and edge function alike) goes through `deskPost()` — POST plus the
  anon-key headers, returning fetch's own promise, so keep it NON-async or every
  wrapper's settle timing shifts; `deskRpcOk()` maps the PIN RPCs whose panel only
  needs "did it work" to `{ok:false}`. **Every clock on the desk is pinned to Pacific** (`DESK_TZ`, owner
  ruling 2026-07-22):
  stamps via `fmtClock`, intraday bar times via `fmtBarT`, news row times via
  `newsWhen` — never the viewer's locale, never raw UTC. The trading calendar is ONE
  table (`NYSE_HOLIDAYS`, through 2027 — extend it before 2028) plus
  `NYSE_EARLY_CLOSES`; the settle grace does not fire on a holiday, and
  `lastTradingDay` is anchored to the Pacific day, so a Tokyo/Auckland viewer no
  longer lamps a healthy snapshot STALE. Every number formatter answers an em dash
  for null/undefined/NaN/±Infinity (audit 2026-09-29: `fmtPct(null)` used to print
  `+0.00%`).
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
  Also carries the
  session-aware feed poller (5 min market-open / 60 min closed, paused
  while the tab is hidden; a `CLOSE_SETTLE_GRACE_MIN` window — 15 min,
  `withinCloseSettleGrace()` in `scripts/data.js` — keeps the 5-min cadence for
  a short stretch right after the close, since Stooq/Yahoo's final settle
  print doesn't always land at the exact closing bell; added 2026-07-27, owner
  report of no confidence in the as-of-close numbers).
  **A feed lamp AGES even when its poll fails** (audit 2026-09-29): a failed poll
  used to leave the news/heatmap/charts lamps reading LIVE for as long as the tab
  stayed open. Every poll tick (success or failure), a return from a hidden tab and
  the 30s ticker re-lamp them, and the ticker only judges a feed once it is overdue
  by a full poll cadence plus 90s, so a healthy hourly poller is not lamped STALE
  at +6 min. **Renders sit OUTSIDE the fetch `try`** (`renderAfterFetch` logs the
  stack and never lets it escape): a render fault inside it was reported as a FEED
  failure (STALE on a healthy feed), and one throw in `renderMasthead` stopped
  market polling after two calls.
