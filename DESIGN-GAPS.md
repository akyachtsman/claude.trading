# DESIGN-GAPS.md — where the desk still breaks the house standard

The known-gaps list `directives/design.md` describes at its top: one line per panel
(screen) and group, each with the file it lives in. Written 2026-10-29 by step 1 of
the move onto the house style (`/design-intake` 1c; CLAUDE.md → Design), from reading
the code, not from an audit. Step 2 moves the panels one PR at a time in the order
the owner picks from this list; each PR brings its panel up to the standard (or
says in the PR why not) and deletes the lines it fixes. Step 3 deletes this file
once it is empty and no `legacy-` class is used.

The five gaps recorded before the move (2026-10-25, the iPhone rule) are kept
below, each under its panel, with the reason it stays.

The palette and fonts are NOT gaps: the owner ruled this project keeps its own
(CLAUDE.md → Design). Group numbers are design.md's sections.

## Every panel
- All panels — Tokens & components: no page loads `styles/components.js` yet, so no `House.*` behaviour is used — `index.html`
- All panels — Tokens & components: the page base is held back under `.legacy-screen` (overflow-wrap, control font, link focus ring) — `styles/legacy.css`
- All panels — §4 Buttons: `.legacy-btn` (filled accent; the house `.btn-primary`) and `.legacy-btn-secondary` are the desk's own buttons — `styles/legacy.css`, `index.html`, `scripts/app.js`
- All panels — §12 Forms: fields are `.legacy-input`, with no house `.field` / `.label` — `styles/legacy.css`, `index.html`, `scripts/app.js`
- All panels — §3 Icons: emoji and glyphs stand in for the house icon set (⚙ ⏱ 🔓 ✎ ✕ ↑ ↓) — `index.html`, `scripts/app.js`
- All panels — §16 Search, filter and sort: the span and sort controls are the desk's own `.seg`, not the house `.segmented` — `styles/legacy.css`, `index.html`, `scripts/app.js`
- All panels — a ruling to make: the house `.dialog-body`, `.table-wrap` and the pop-overs (`.archived-pop`, `.menu-pop`, `.list-pop`) carry `overscroll-behavior: contain`, which this desk bans (CLAUDE.md, Project-Specific Coding Standards); no element uses them yet and S42 fails the day one does — the panel that first takes one needs the owner's call — `styles/components.css`, `.github/scripts/ui-tests/tests/app.spec.js` (S42)
- All dialogs — §10 Pop-ups / *iPhone and iPad*: the eight dialogs are `.modal-backdrop` + `.panel.modal-panel` with their own z-index (20), not the house `.dialog` shell on the shared layer scale; their `max-height` has the `85dvh` the rule asks for (2026-10-25) and their body scrolls, and S48 checks each with `fitProblems()` in every project — `index.html`, `styles/legacy.css`, `scripts/app.js` (`openModal`)

## Masthead and Accounts
- Accounts — §4 Buttons: Refresh now and Lock are small `.legacy-btn-secondary` (26px tall, under the 44px target) — `scripts/app.js` (`renderPrivate`), `styles/layout.css` (`.accounts-head .legacy-btn`)
- Accounts — §12 Forms: the PIN form is a bare `.legacy-input` + `.legacy-btn` with no visible label — `scripts/app.js` (`renderLockedPanels`)
- Accounts — §6 Lists and tables: the positions table sorts on its own `th` handlers, not the house `.table` / `.th-sort` — `scripts/app.js` (`.data-table`), `styles/legacy.css`

## Markets
- Markets — §14 Status pills: the sector change chips are `.legacy-pill--gain/--loss`, a P&L figure the house status pills do not cover — ask the owner before moving it — `scripts/app.js` (`renderMarkets`), `styles/legacy.css`

## News
- News — §12 Forms / §16 Search: the topic box is a `.legacy-input` with its own ✕, not the house `.search` — `index.html`, `styles/legacy.css`

## Ask the desk
- Ask — §9 Confirmations: Clear uses a native `confirm()` — `scripts/app.js` (Clear handler); the qa caller's `guard-skip: native-dialog:scripts/app.js` covers it until this moves
- Ask — §9 Confirmations: saving the system prompt uses a native `confirm()` — `scripts/app.js` (system-prompt Save)
- Ask — §4 Buttons / §16: the model switch is its own `.ask-tier-opt` group, not the house `.segmented` — `scripts/app.js`, `styles/legacy.css`
- Ask — §10 Pop-ups: the ⚙ system-prompt and ⏱ scheduled-questions dialogs are the desk's own shell (see Every panel) — `index.html`

## Economy
- Economy — §16: the span control (1D … 5Y) is the desk's own `.seg` — `scripts/app.js` (`renderEcon`), `styles/legacy.css`

## Stochastic charts
- Charts — palette: the dark charts scope declares no dark status pairs yet; it needs them before it takes any house component — `styles/layout.css` (`.area-charts` tokens)
- Charts — §16 / *iPhone and iPad*: the Load box's ticker list `#wbSuggest` is its own listbox, `position: absolute` under the box and not moved when the on-screen keyboard opens, not the house `.list-pop` (`position: fixed`, placed inside `window.visualViewport`); S77 proves it fits and is not clipped at every project's width (the `iphone` project in WebKit) — move it to `.list-pop` when the charts header moves — `index.html`, `scripts/app.js` (the ticker typeahead), `styles/layout.css`
- Charts — *Touch and pointer*: the header Load box (`.wb-any-input`) and the SYMBOL column's entry box are 12px (`--font-xs`), set over `.legacy-input`'s 16px to fit the dark header, so iOS zooms the page when one is focused; a visual change to the charts header is the owner's call — `scripts/app.js`, `styles/layout.css`
- Charts — *iPhone and iPad* (never cancel `touchmove`, never `touch-action: none`): the SYMBOL column drag lost its touch lock on 2026-10-25, so on a real phone a finger drag scrolls instead of moving a stock; a stock is moved there with the entry box, Insert and the ×, and a touch drag that obeys the rule (a separate handle, say) would be new work — `scripts/app.js` (`wbSlotPointerDown`)
- Charts — same rule: the Stochastic strip resize grips lost their inline `touch-action: none` on 2026-10-25, so a finger on a grip scrolls the page instead of resizing the strip; a mouse still resizes, and a finger resize that obeys the rule would be new work — `scripts/app.js` (`renderCharts`, the `data-grip` bars)
- Charts — §10 Pop-ups: the per-pane ⚙ settings are the desk's own `.wb-settings` pop-over — `scripts/app.js`, `styles/layout.css`

## Watchlists
- Watchlists — §9 Confirmations: deleting a list inside the ✎ editor, and saving with no lists, use a native `confirm()` — `scripts/app.js` (`renderWlEditor`, `saveWlEditor`)
- Watchlists — *iPhone and iPad* (never cancel `touchmove`, never `touch-action: none`): the tile drag lost its touch lock on 2026-10-25, so on a real phone a finger drag scrolls instead of moving a tile; a touch drag that obeys the rule would be new work — `scripts/app.js` (the watchlist drag)
- Watchlists — §14 Status pills: each tile's change chip is `.legacy-pill--gain/--loss`, a P&L figure — ask the owner before moving it — `scripts/app.js` (`wlTile`), `styles/legacy.css`
- Watchlists — §10 Pop-ups: remove, quick add, new list, delete list, the ✎ editor and the symbol detail window are the desk's own shell (see Every panel) — `index.html`

## Heatmap
- Heatmap — §4 Buttons: Show/Hide is a `.legacy-btn-secondary` — `index.html` (`#heatToggle`)
- Heatmap — §12 Forms: the period picker is a `select.legacy-input` — `index.html` (`#heatPeriod`)
- Heatmap — §6 Lists and tables: the movers table is `.data-table`, not the house `.table` in a `.table-wrap` — `index.html` (`#heatTable`), `scripts/app.js`
