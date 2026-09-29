# claude.trading

A private multi-account trading dashboard: account cards, market and heatmap panels, a stochastic charts workbench, watchlists, news and an "ask the desk" assistant. Architecture, owner rulings and the test-scenario table live in `CLAUDE.md`.

**Live:** https://akyachtsman.github.io/claude.trading/ (append `?demo=1` for deterministic demo data)

## Stack

Plain HTML + CSS + vanilla JS served from GitHub Pages, with no build step. Live data comes from Supabase edge functions (public feeds) and PIN-validated Supabase RPCs (private account data). The site runs in DEMO mode when `DESK_DB.url` in `scripts/config.js` is empty and in LIVE mode when it is set; `?demo=1` forces demo either way. The anon key is public by design; real balances never enter this repo.

## Repo map

| Path | Purpose |
|---|---|
| `index.html` | Markup only, plus three script tags |
| `scripts/` | `config.js` (accounts, backend endpoints), `data.js` (formatters, demo data, feed wrappers), `app.js` (all rendering) |
| `styles/` | `tokens.css` (design primitives), `components.css` (reusable components) |
| `config/` | Owner-editable rosters read at runtime (news feeds, chart watchlist, map filters, watchlist bootstrap) and system-prompt backups |
| `supabase/` | Edge functions (`functions/`) and SQL migrations (`migrations/`) for the dedicated Supabase project |
| `specs/` | Spec-driven-development records; `specs/README.md` indexes them with status |
| `strategies/` | Trading-strategy notes the charts panel is built to serve |
| `tools/` | Re-runnable evidence scripts (`node tools/<name>.mjs`) |
| `.github/` | CI workflows, the contrast check and the Playwright UI kit (`scripts/ui-tests`) |
| `.agent-reports/` | Per-run agent and CI evidence (see its README) |
| `learnings.jsonl` | Append-only log of durable lessons and owner preferences |

## Run locally

Serve the repo root, then open `http://localhost:8000/?demo=1` (`quote-proxy` only accepts the production site's Origin, so live-mode charts will not all work from localhost):

    python3 -m http.server 8000        # or: npx http-server -p 8000

## Checks

    npx html-validate index.html
    node .github/scripts/check-contrast.js
    cd .github/scripts/ui-tests && npm ci && npx playwright install chromium
    APP_URL=http://localhost:8000/ npx playwright test --project=desktop --project=mobile-chrome

Run the Playwright lines with the static server above running. Without `APP_URL` the suite targets the live site; the `tablet` and `iphone` projects use WebKit, and the live-backend scenarios (S10, S11, S14) need Supabase access plus `TEST_AUTH_CREDENTIAL`.
