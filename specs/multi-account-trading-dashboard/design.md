# Design record — claude.trading

## Look: "Midnight desk ledger"
A private trading desk instrument, not a SaaS product. Deep ink-blue ground
(never pure black), warm paper ink (not stark white), and a brass/amber
accent nodding to classic terminal hardware — while green/red stay strictly
reserved for P&L semantics. Deliberately not the category's default
blue-accent dark theme, and not the acid-green-on-black cliché.

## Signature element
**The trust layer is the identity**: every panel carries a data-state lamp
(glowing dot + LIVE/EOD/DEMO label) and an as-of stamp in mono. For a
snapshot-based dashboard, honest freshness labeling is both the credibility
feature (per research.md, every leading platform's trust device) and the
most recognizable visual motif of the page.

## Contract
- `styles/tokens.css` — all primitives. Key decisions:
  - `--color-accent` #9C6410 (brass; white button text 4.95:1, surface 3.66:1)
  - `--color-accent-bright` #E5AE45 — lamps/wordmark/focus only (decorative/large)
  - `--color-gain` #4CC38A / `--color-loss` #F07575 — P&L ONLY, never decorative
  - `--color-series-1..3` (#3987E5 blue, #C98500 amber, #9085E9 violet) —
    account identity; CVD-validated as an ordered set with the dataviz
    validator (worst adjacent ΔE 112, all ≥3:1 on surface). **Do not reorder.**
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
- dataviz `validate_palette.js` — series trio passes (dark, surface #12161F)
- Playwright renders at 1440px and 834px (iPad): no JS errors (the single
  network error is the Google Fonts fetch blocked in the sandbox; system
  fallbacks apply), tables fit, hover tooltip works

## Deviations / decisions to record in CLAUDE.md post-merge
- Price-change percentages use 2 decimals (finance convention) — a deliberate
  project-level exception to the editorial "whole-number percentages" rule;
  allocation-style percentages stay whole.
- Dark-only in v1; a light theme is a token-block swap later if wanted.
- Account sparklines are passive (no tooltip); the combined chart carries the
  full interaction layer + data-table fallback.

## Status
Awaiting look-gate sign-off on the reference page (presented as screenshots;
deploys to Pages on merge). Next: `/sdd-loop` — it builds everything else
against `styles/tokens.css` + `styles/components.css`, so every page matches
this one.
