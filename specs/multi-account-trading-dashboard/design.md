# Design record — claude.trading

## Look: "Daylight desk ledger" (v2 — user feedback at look-gate)
A private trading desk instrument on paper: white panels on a warm paper
ground, warm near-black ink, and a brass/amber accent nodding to classic
terminal hardware — while green/red stay strictly reserved for P&L
semantics. v1 was dark ("midnight ledger"); the owner asked for a white
background at the look-gate, so light is now the committed theme. Same
structure, grammar, and signature; only tokens.css changed.

## Signature element
**The trust layer is the identity**: every panel carries a data-state lamp
(glowing dot + LIVE/EOD/DEMO label) and an as-of stamp in mono. For a
snapshot-based dashboard, honest freshness labeling is both the credibility
feature (per research.md, every leading platform's trust device) and the
most recognizable visual motif of the page.

## Contract
- `styles/tokens.css` — all primitives. Key decisions:
  - `--color-accent` #96610F (brass; white button text 5.23:1, bg 4.76:1)
  - `--color-accent-bright` #8F5D12 — wordmark/lamps/active states, text-safe on white
  - `--color-gain` #177C4B / `--color-loss` #C13636 — P&L ONLY, never decorative
  - `--color-series-1..3` (#2A78D6 blue, #C98500 amber, #4A3AA7 violet) —
    account identity; CVD-validated as an ordered set with the dataviz
    validator (light surface, worst adjacent ΔE 114, all ≥3:1). **Do not reorder.**
  - Type: IBM Plex Sans (UI) + IBM Plex Mono (all numerics, tabular figures),
    via Google Fonts with system fallbacks.
- `styles/components.css` — the module grammar: `.panel` (+header/title/body),
  `.lamp` + `.stamp` (trust layer), `.pill` (P&L), `.chip` (ticker), `.stat`,
  `.hero-number`, `.data-table` (+`--compact`, sortable per design.md
  standard), `.seg` (timeframe), `.news-row`, `.brief-section`, `.key-dot`.

## Reference page
`index.html` — the dashboard itself, on deterministic demo data (seeded
walks, stable screenshots): masthead + lamps, market-summary strip with
sparklines, three account windows (NAV hero, stat grid, equity sparkline,
sortable compact positions table), combined equity chart (3 series, direct
end-labels + legend, crosshair + tooltip, timeframe seg, consolidate toggle,
"view data table" fallback), AI daily brief (structured: state → levels →
scenarios, grounding + not-advice microcopy), holdings-first news feed,
provenance footer.

## Verification (all fresh at time of record)
- `npx html-validate index.html` — clean
- `node .github/scripts/check-contrast.js` — all pairs AA
- dataviz `validate_palette.js` — series trio passes (light, surface #FFFFFF)
- Playwright renders at 1440px and 834px (iPad): no JS errors (the single
  network error is the Google Fonts fetch blocked in the sandbox; system
  fallbacks apply), tables fit, hover tooltip works

## Deviations / decisions to record in CLAUDE.md post-merge
- Price-change percentages use 2 decimals (finance convention) — a deliberate
  project-level exception to the editorial "whole-number percentages" rule;
  allocation-style percentages stay whole.
- Light-only (owner request); a dark theme is a token-block swap later if wanted.
- Account sparklines are passive (no tooltip); the combined chart carries the
  full interaction layer + data-table fallback.

## Status
Awaiting look-gate sign-off on the reference page (presented as screenshots;
deploys to Pages on merge). Next: `/sdd-loop` — it builds everything else
against `styles/tokens.css` + `styles/components.css`, so every page matches
this one.
