# Competitive Discovery — Multi-Account Trading Dashboard

Eight parallel analyses of leading trading/market platforms, run 2026-07-09
against public pages only (no logins; several sites 403-block automated
fetchers, so findings combine indexed page content, official docs/blogs, and
third-party reviews — sources listed per site at the end). Patterns are
synthesized, never cloned.

Targets: TradingView, Koyfin, Finviz, Yahoo Finance, Webull, IBKR
PortfolioAnalyst/Client Portal, TrendSpider (AI presentation), Benzinga Pro
(news-feed design).

## Comparison matrix

| Site | Signature pattern | Density | AI | News | Trust device | Look |
|---|---|---|---|---|---|---|
| TradingView | Synced multi-chart grid (2–16/tab); right-rail utility dock | Very high, progressively disclosed | — | Rail beside chart | Per-symbol delayed/live badge + exchange attribution | Dark-first terminal, blue accent |
| Koyfin | Color-group **linked widgets**; command bar + mnemonics | Very high, tier-gated | None (reviewers ding it) | Rail widget | Vendor-attribution page; freshness disclosed per market | Dark flagship, thin type, panel grids |
| Finviz | Homepage IS the dashboard — zero clicks to value; uniform table grammar | Extreme, semantic-color-only | — | Column on home | Persistent delayed-quotes disclaimer | White utilitarian wall-of-data |
| Yahoo Finance | Persistent portfolio/market **dock**; ticker chips inside headlines | High, tiered glance→scan→read | — | Core surface, data-interleaved | Point-of-read metadata (exchange, delay, as-of) | Neutral base, semantic green/red only |
| Webull | Ticker-linked widget groups; tab-stacked widgets; Performance widget | Very high (45+ widgets) | — | Widget | SIPC/FINRA footer; "powered by X" per panel | Dark-first, annotated-screenshot heroes |
| IBKR PortfolioAnalyst | Account Selector + explicit **"Consolidate Selected"**; TWR/MWR toggle | Medium (widget grid) | — | Widget | Methodology inline; as-of dates everywhere | Clean consumer dashboard over dense TWS |
| TrendSpider | **AI button on the chart** → structured commentary (trend → levels → scenarios) | Very high | Core product; model choice as trust lever | — | "AI can make mistakes"; evidence next to every claim | Dark terminal, product-as-hero |
| Benzinga Pro | Newsfeed as hub; filters drive alerts; WIIM "why is it moving" one-liners | High, one-line rows | Headline sentiment tags | Core product | Per-headline timestamps to the second | Dark default, color-coded rows |

## Recommended starting version

A **single-page terminal**: the page IS the dashboard (Finviz), no landing or
login in front of it. Structure:

1. **Session-aware market-summary strip** pinned at top (Yahoo): index/futures
   name, last, change %, sparkline; switches futures ↔ indices ↔ close recap
   by market session.
2. **Per-account windows** as the main grid (TradingView multi-pane ×
   IBKR account model): one panel per IBKR account — NAV, day P&L, total
   unrealized/realized P&L, positions table — plus an explicit
   **"Consolidate" toggle** that rolls all accounts into one aggregate window
   (IBKR's "Consolidate Selected", never silently merged).
3. **Charts** inside each window (equity curve) + a large combined chart pane;
   a global timeframe selector syncs all panels (TradingView symbol/interval
   sync, Koyfin color-group linking as the interaction model).
4. **Right-rail dock** (TradingView/Koyfin): collapsible News feed +
   AI Brief panels beside the grid, not separate pages.
5. **News feed** (Benzinga): dense one-line headlines, top-inserted, ticker
   chips colored by live change (Yahoo), source + relative timestamp per row,
   filter by "my holdings" — the watchlist-as-filter model.
6. **AI Daily Brief** (TrendSpider): structured template — portfolio state →
   key levels/numbers → scenarios — grounded in the committed account +
   market data ("grounded in your data, not the open internet"), with
   "AI-generated — can make mistakes; not financial advice" microcopy at the
   point of output, and each claim adjacent to the metric that supports it.

## Richness / polish bar (binding for plan + implement)

- **Zero clicks to value:** live (or demo) data renders immediately on load.
- **Terminal-grade density** with one uniform module grammar: identical
  panel chrome, header, and table style everywhere (Finviz discipline).
- **Semantic color only:** green/red reserved strictly for P&L/direction,
  intensity = magnitude; one neutral accent for everything else.
- **Dark-first** with tabular-figure numerics; light theme via tokens.
- **Trust metadata at point of read (non-negotiable):** every panel carries
  data source + as-of timestamp + freshness state (live/delayed/EOD snapshot);
  every headline carries source + relative time; every AI output carries the
  not-advice microcopy. For a snapshot-based dashboard, honest "as of" labeling
  is the credibility feature.
- **Motion:** data-driven only — new-headline insert, value-change flash;
  0.15s calm transitions; honors `prefers-reduced-motion`.
- **Interaction floor:** panel collapse/expand, global timeframe sync,
  holdings-filtered news, consolidate toggle, sortable tables (per design
  directive's `makeSortable` standard), iPad-safe 44px targets.

## Patterns explicitly avoided

- Ad slots, promo banners, or upsell chrome inside data zones (Finviz/Webull/
  Yahoo complaint) — erodes terminal credibility.
- Feature sprawl / multi-page IA — one coherent surface.
- Community/social feeds (TradingView) — the AI brief is the single "voice".
- 35-factor report configurators (IBKR) — curated defaults over configurators.
- Bare AI confidence percentages without adjacent evidence (TrendSpider's
  lesson: confidence language must be earned by visible data).
- Paywall/gate patterns — personal tool, no tiers.

## Open design cue for /design-intake

Consensus aesthetic across the category: dark-first, thin panel chrome, dense
tabular numerics, semantic green/red, one brand accent. The user supplied no
reference image — design-intake should generate a reference in this vein for
approval.

## Per-site sources

- **TradingView:** tradingview.com indexed pages, support docs, blog; Pentagram rebrand coverage; third-party reviews.
- **Koyfin:** koyfin.com features/help/pricing/release notes via search index; 2026 third-party reviews.
- **Finviz:** finviz.com, finviz.com/elite, screener help, maps blog; FinMasters, WallStreetSurvivor, daytradingz, LuxAlgo reviews.
- **Yahoo Finance:** Yahoo redesign press release, dock help doc (SLN28273), real-time data help (SLN2321), Gold/AlphaSpace pages, talkingbiznews coverage.
- **Webull:** webull.com desktop-app/charts-tools/nasdaq-totalview/pricing/disclosures pages, Webull 4.0 announcement, StockBrokers.com/Warrior Trading/daytrading.com reviews.
- **IBKR:** ibkr.com/pa overview + features, IBKR Campus lessons, IBKR Guides docs (search-index content).
- **TrendSpider:** trendspider.com product/Sidekick/AI Strategy Lab pages, KB/blog snippets, 2026 reviews.
- **Benzinga Pro:** benzinga.com/pro feature pages (newsfeed, alerts), help-center articles, workspaces blog, Liberated Stock Trader/DayTradingToolkit/daytradingz/TradingToolsHub reviews.
