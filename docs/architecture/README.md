# Architecture notes

Per-panel history, measurements and owner rulings for claude.trading. Until 2026-09-29 this
text was the body of `## Application Architecture` in `CLAUDE.md`; it was moved here
**verbatim** (paragraphs unchanged and in their original order, one heading and one scope
line added per file) so `CLAUDE.md` stays small enough to load into every session. These
files carry the same authority as `CLAUDE.md`, and the map in `CLAUDE.md` links each topic
here. `CLAUDE.md` keeps the operative rules (security constraints, coding standards, the
test-scenario table, workflow) and a checklist of the load-bearing rules from these files.

**How to use:** find the symbol or panel you are about to touch in the table, read that file
first, then edit. When you change behaviour, update the matching topic file and the
one-paragraph summary in `CLAUDE.md` in the same PR.

| Topic | File | Read before editing |
|---|---|---|
| Data layer, clocks, lamps | [`data-and-clocks.md`](data-and-clocks.md) | `scripts/data.js`: `liveLampFor`, `fmtUpdated`, `fmtClock`, `fmtBarT`, `newsWhen`, `utcHmToPt`, `marketCloseInstant`, `NYSE_HOLIDAYS` / `NYSE_EARLY_CLOSES`, `lastTradingDay`, `DESK_TZ`, `deskFeed()`, `withinCloseSettleGrace()`, `buildDemoMarkets()`; the feed poller (`CLOSE_SETTLE_GRACE_MIN`, `renderAfterFetch`); every panel lamp and stamp; `.news-date` (S43) |
| Charts symbol rail and slots | [`charts-rail-and-slots.md`](charts-rail-and-slots.md) | `renderWbSidebar`, `wbEditSlot` / `wbEditDraft`, `wbSlotClick`, `WB_SLOT_DBL_MS`, `WB_SLOTS`, `wbSlotArray`, `setWbSlot`, `wbSlotTab` / `setWbSlotTab`, `wbMoveSlot` / `wbInsertSlot` / `wbInsertAndEdit` / `wbCommitMove`, `wbSlotPointerDown` / `wbSlotDrag*` / `WB_SLOT_DRAG_*`, `wbDropGap` / `wbGapToSlot`, `closeRow`, `keepPageStill`, `restoreStickySymbols`, `WB_RESTORE_LANES`, `wbLoadSymbol`, `wbLoadGen` / `WB_SUPERSEDED`, `--wb-rail-h` / the stacked 220px cap, `WB_ROSTER_CHARTS`, `wb_sticky_v1.syms`; `#wbSidebar`, `.wb-slots`, `.wb-slot`, `.wb-slot-input`, `.wb-rail-*`, `.wb-grid`; the header Load box (S40, S45, S64) |
| Charts panes, stochastics, price tab | [`charts-panes-and-stochastics.md`](charts-panes-and-stochastics.md) | `renderCharts`, `drawPane`, `opts.colorSt`, `weeklyStochOnDaily`, `STEADY_BAND` / `stochSteady`, `VOL_MA` / `data-volma`, `cfg.p1` / `cfg.p2` / `cfg.p3`, `wireCharts` pane seg, the settings-popover title map, `wbBar-p2` / `chartZoom2` in `index.html`, `wbInfoCache`, `maybeFetchWbInfo`, `syncZoomPressed`, `wb_sticky_v1.z1` / `z2` (S12, S25, S34, S36, S37, S39) |
| Extended hours and day-% | [`extended-hours-and-day-pct.md`](extended-hours-and-day-pct.md) | `cfg.p3.ext`, `extDefaultOff2026_08_20`, `WB_CFG_KEY` / `wb_cfg_v3`, `graftTodayBar()`, `regularOnly()`, `intraTo15()`, `ptBarStamp`; `desk-ibkr-sync` day-% (`pct[p.sym]`), `upstreamSymbol`, the day-% baseline in `desk-news` / `desk-ibkr-sync` / `desk-market` (`meta.regularMarketTime`). The Markets-side and `quote-proxy` halves of the extended-hours rules are in `markets-window.md` and `edge-feeds-and-heatmap.md` |
| Markets window, Refresh now | [`markets-window.md`](markets-window.md) | `renderMarkets()`, `drawMktChart()`, `mktSecTint()`, `#mktLamp` / `#mktStamp`, `EXT_PROXY`, `.mk-ext`, `.mk-sec-ext`, `.tip-ext`, `#refreshNowBtn` and `force:true`, the `desk-market` v7/quote call, the index tiles and 11-cell sector grid (S23) |
| Config rosters and retired widgets | [`config-and-widgets.md`](config-and-widgets.md) | `config/news-feeds.json`, `config/chart-watchlist.json`, `config/map-filters.json`, `rosterCache`, `MIN_COVERAGE`, `DEFAULT_WATCHLIST`, `config/widgets.json`, `loadWidgets()`, `widgetFrameSrc`, `WIDGET_DEFAULTS`, `#acctWidgets` |
| Watchlists panel | [`watchlists-panel.md`](watchlists-panel.md) | `renderWatchlist()`, `wlTile()`, `.mkt-group` / `.wl-band-head` / `.mkt-group-tiles`, `.wl-tile`, `.wl-strip`, `.wl-pct`, `wlCommitMove`, `wlMoveBand`, `#wlMissing`, the Radar list, `#wlTf` / `renderWlTf()`, `WL_RANGES`, `buildSpark` (S20, S26, S27, S41, S42) |
| Watchlist roster and writes | [`watchlist-roster-and-writes.md`](watchlist-roster-and-writes.md) | `desk_watchlists`, `desk_get_watchlists(_open)` / `desk_set_watchlists(_open)`, `expected_version` (`desk_014`), `wlMutate()`, `wlPick()`, `wlLocked`, `wlCanEdit()`, `openWlDelList`, `#wlNewListBtn`, `.wl-del`, the ✎ editor, `desk-watchlist`, `config/watchlists.json` bootstrap (S30, S31) |
| Watchlist quick add, remove, detail window | [`watchlist-detail-and-quick-edit.md`](watchlist-detail-and-quick-edit.md) | `wlWireRemove`, `WL_CLICK_MS`, `WL_DRAG_CLICK_MS`, `wlDragClickAt`, `wlDragEnd`, `openWlDetail()`, `#wlDetailBackdrop`, `#wlRmBackdrop`, `buildDemoDetailBars`, `DEMO_CHART_SYMBOLS`, `wl_detail_smas_v1`, `SMA_COLORS` (S21, S35) |
| Desk row and page layout | [`desk-row-layout.md`](desk-row-layout.md) | `styles/layout.css`: `.desk-row`, `.top-boxes`, `.top-band`, `.col-markets`, `.col-rail`, `.col-watchlist` (removed), `.acct-positions`, `.accounts-side`, `.area-accounts`, `.account-grid`, `.ask-thread`, `#newsList`, `.heat-foot`, `#heatSource`, the lock panel (S4, S11) |
| Edge feeds, heatmap, quote-proxy | [`edge-feeds-and-heatmap.md`](edge-feeds-and-heatmap.md) | `supabase/functions/desk-market`, `desk-heatmap` (`sp500` / `r2k` / `etf`), `desk-charts`, `desk-news`, `desk-maps`, `quote-proxy`; `NY_DATE`, `parseYahooChartOHLC`, `SWEEP_BUDGET_MS`, `periodSweep` / `advanceSweep`, `readSweepRow`, `cleanTopic`, `dedupeRank`, `etfCats`, `datasetHasPeriods`, `EXT_WICK_TOL`, `loadWatchlist`, `seriesCache` (S13, S14) |
| Economy panel feed | [`economy-panel.md`](economy-panel.md) | `supabase/functions/desk-econ` (`stitchTreasury`, `treasuryCycle`, `treasuryWanted`, `treasuryHeld`, `treasuryRetryInMs`, `lastPostingStart`, `readTreasuryRow`, `writeTreasuryRow`, `storeRowFrom`, `parseFredCsv`, `parseTreasuryCsv`, `transformSeries`, `pointsFor`, `downsample`, `refreshPolicy`, `NY_CLOCK`, `validateRoster`, `rangeKey`), `config/econ-indicators.json`, `tools/econ-check.mjs` + `tools/fixtures/econ/`; the Economy panel in `.area-econ` (`renderEcon`, `refreshEcon`, `buildDemoEcon`, `deskEcon`, `#econTf`, `#econLamp`; the live yield overlay `ECON_LIVE`, `ECON_CNBC_URL`, `econLiveRow`, `econLiveParseCnbc`, `econLiveCnbc`, `econLiveFetch`, `econLiveRepaint`, `econLiveSeen`, the NOT LIVE chip `econBondOpen`, `econLiveState`, `econNotLiveWhy`, `.econ-nolive`; the 1D view `econRange`, `ECON_CHART_URL`, `econLiveBars`, `econBarMs`, `econBarsParse`, `econBarsEntry`, `econBarsFetch`, `econIntradayChart`, the axes `econPlot`, `econYTicks`, `econYAxis`, `econIdxFrac`, `econXTicksIntraday`, `econXTicksDates`, `econXTicksWeek`, `econWeekChart`, `econWeekCaption`, `econBarsView`, `econBarsWk`, `econXAxis`, `econFitAxis`, `econFitValueAxis`, `econWatchAxes`, `econSparkY`, and in `data.js` `etWallToMs`, `buildDemoBars`) |
| Assistant, IBKR sync, scheduled asks | [`desk-ask-and-cron.md`](desk-ask-and-cron.md) | `desk-ask`, `buildAskContext()`, `containerId`, `desk_system_prompt` / `DEFAULT_SYSTEM`, `desk_chat_memory`, `askAbort` / `.ask-stop`, `desk-ibkr-sync`, `desk-cron-ask`, `CATCHUP_MIN`, `x-cron-secret`, `desk_005` / `desk_018` cron, `desk_020` / `OPEN_ASK_DAILY_CAP` / `anonymous` (open questions), `deskPinDeviceGet` / `deskPinForget` (S15-S19, S29, S32, S33, S59, S60) |

## Conventions

- **Moved verbatim.** The paragraphs are the original `CLAUDE.md` text (revision `d984ad1`).
  Within a file they keep their original relative order; a file made of several passages of
  the old section simply lists them in that order, so a paragraph can start with "Also
  carries the ..." or a lone clause whose subject is in a sibling file. The old section was
  organised by source file (`data.js`, `app.js`, ...), not by topic, which is why some topics
  are spread across it.
- **One line appears twice.** The line that ends the `desk-heatmap` hoisted-formatter
  paragraph (``rendered as `Invalid Date`. PIN-gated: `desk-ask` — an **agentic**``) is
  also the first line of the `desk-ask` paragraph. It is kept whole in both
  `edge-feeds-and-heatmap.md` and `desk-ask-and-cron.md` rather than edited.
- **Cross-references inside the moved text** that say "below", "above" or "see that entry"
  resolve as follows:
  - "the `overscroll-behavior` trap below" and "the dead-wheel trap below" point to
    *Project-Specific Coding Standards* in `CLAUDE.md`;
  - "see the accepted residual under Security Constraints" points to *Project-Specific
    Security Constraints* in `CLAUDE.md`;
  - "see that entry below" (`config-and-widgets.md`, the heatmap ETF cut) points to
    `edge-feeds-and-heatmap.md`;
  - "see the Watchlists panel below" (`config-and-widgets.md`) points to
    `watchlists-panel.md`;
  - "the out-of-flow arrangement (see below)" (`watchlists-panel.md`) points to
    `desk-row-layout.md`;
  - "scenario S..." always refers to the *Project-Specific Test Scenarios* table in
    `CLAUDE.md`.
- **Extended hours is spread over three files** by the seam it crosses: the workbench rule
  and the day-% rules are in `extended-hours-and-day-pct.md`, the index-tile / sector-strip
  display is in `markets-window.md`, and the `quote-proxy` `prepost` / `x` flag handling is
  in `edge-feeds-and-heatmap.md`.
