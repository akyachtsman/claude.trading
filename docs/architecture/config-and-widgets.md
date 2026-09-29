# Owner-editable config and retired widgets

`config/news-feeds.json`, `config/chart-watchlist.json`, `config/map-filters.json` and `config/widgets.json` (third-party embeds retired 2026-08-07, machinery dormant).

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
