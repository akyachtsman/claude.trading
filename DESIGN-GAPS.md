# Design gaps

Screens and components that do not yet match the house design rules
(claude.directives `directives/design.md`). This project is **not on the house
style** (`.claude/directive-sync.json` has no `house_style: true`), so a gap is
recorded here instead of restyling the screen. Each one is fixed when its screen
moves to the house components.

| Where | Rule | What is different | Why it stays for now |
|---|---|---|---|
| Charts header, the Load box's ticker list (`#wbSuggest`, `scripts/app.js` → the ticker typeahead) | *iPhone and iPad*: a type-ahead list is the house `.list-pop`, `position: fixed` and placed inside `window.visualViewport` | Its own listbox, `position: absolute` under the box, not moved when the on-screen keyboard opens | S77 proves it fits and is not clipped at every project's width (the `iphone` project in WebKit). Move it to `.list-pop` when the charts header moves |
| The eight dialogs (`.modal-backdrop` / `.modal-panel`) | *iPhone and iPad*: the house dialog | The project's own dialogs. `max-height` now has the `85dvh` the rule asks for (2026-10-25), and their body scrolls | S48 checks each one with `fitProblems()` in every project |
| Charts header Load box (`.wb-any-input`) and the SYMBOL column's entry box | *Touch and pointer*: input font never below 16px (it stops iOS zooming on focus) | 12px (`--font-xs`), set over `.input`'s 16px to fit the dark header | A visual change to the charts header is the owner's call. iOS zooms the page when one of these boxes is focused |
| SYMBOL column drag and watchlist tile drag on a phone | *iPhone and iPad*: never cancel `touchmove`, never `touch-action: none` | Both locks were removed on 2026-10-25, so on a real phone a finger drag now scrolls instead of moving a stock or a tile | On a phone a stock is moved with the entry box, Insert and the ×. A touch drag that obeys the rule (a separate drag handle, say) would be new work |
| Stochastic strip resize grips | Same rule | The grips' inline `touch-action: none` was removed on 2026-10-25, so a finger on a grip scrolls the page instead of resizing the strip | A mouse still resizes. A finger resize that obeys the rule would be new work |
