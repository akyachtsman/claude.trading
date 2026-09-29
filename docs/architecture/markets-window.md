# Markets window and Refresh now

The masthead "Refresh now" button, the Markets window (`renderMarkets`, index tiles, sector grid, timeframe chart) and its post-market extended-hours display (scenario S23).

  The masthead's
  **"Refresh now" button** (`#refreshNowBtn`, next to the MARKETS lamp, live
  mode only — owner request 2026-07-27) force-bypasses BOTH the poll cooldown
  and every desk-market/desk-news/desk-heatmap/desk-charts in-memory cache in
  one click (`force:true` in the POST body; each edge function's cache-read
  skips its TTL check when set, but only ONCE per 30s per isolate — desk-heatmap
  per universe, desk-news per topic, desk-watchlist exempting a roster edit (detected by a ~3KB `id,pos,updated_at`
  fingerprint read, not a full-roster compare) — since
  these feeds are anon-callable and an unthrottled `force` would let any caller start
  a full upstream sweep per request; a forced refresh that FAILS hands its stamp back
  so a retry is not locked out; `quote-proxy`'s stays unthrottled behind its Origin
  guard) — the guaranteed-fresh escape hatch for when the owner doesn't trust the
  current numbers. The **Markets window** (`renderMarkets()` +
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
