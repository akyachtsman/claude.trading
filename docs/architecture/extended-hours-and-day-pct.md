# Extended hours and day-% rules

Where pre/post bars may and may not go on the charts workbench, and how a position's and a news chip's day-% is computed (`graftTodayBar`, `regularOnly`, `desk-ibkr-sync`, `desk-news`, `upstreamSymbol`).

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
  regular and extended. The Markets window is untouched (regular session). Pro 3's
  nav and day labels are formatted by `ptBarStamp` (memoised Intl, Pacific) — they
  read 13:30–19:45 UTC before — and an intraday fetch that came back empty is no
  longer re-requested on every render (25 renders had made 25 requests).
  **A position's day-% is NULL when unknown, never 0** (`desk-ibkr-sync`, owner
  check 2026-08-21). The write was `pct[p.sym] ?? 0`, so any symbol the feeds
  could not price was stored as FLAT — and the client made it worse, because
  `fmtPct(null)` returned `+0.00%` (`null >= 0` is true; it now answers an em dash). Four option positions
  read 0.00% on the dashboard while **one underlying was down 38.4% and another 19.5%**: the
  largest moves in the account were the ones claiming they had not moved. The
  row now renders an **em dash** with no gain/loss class and sorts to the
  bottom (a BLANK sort key, which `makeSortable` parks last in both directions —
  `-Infinity` led an ascending click), so an unknown never ranks between a loser and a winner —
  the same rule the watchlist rail already followed.
  **OCC option symbols are stripped of IBKR's padding before the upstream
  call** (`upstreamSymbol`). Flex pads to fixed width — `XXXX  261002C00180000`
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
  1-day baseline on 16 names, the old form was wrong on **all 16** — one ETF read
  13.12% on a 2.59% day, one mega-cap −8.26% on a −0.04% day — and the new one matches
  to 0.00 on 15. Which bar counts as "prior" depends on whether the last one is
  TODAY, decided on the bar's own ET date so half-days and holidays need no
  special case — and read off the QUOTE'S OWN TIMESTAMP
  (`meta.regularMarketTime`), **never the wall clock**. That distinction is the
  whole rule: the first cut compared the last bar's date against `new Date()`
  and shipped, and at 00:48 ET the clock had rolled to the new date while both
  the newest bar and the quote were still the prior session — so it concluded
  the last bar was not today, took that same bar as the baseline, and measured
  its close against itself. **Every symbol read 0.00%** (caught on a small-cap against
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
