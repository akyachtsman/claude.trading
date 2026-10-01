# Specs index

One directory per feature, produced by `/sdd-loop`. These are a record of what was asked and decided at the time; **`CLAUDE.md` ("Application Architecture" and the owner rulings in it, including the topic files under `docs/architecture/` it points to) is authoritative** where the two differ.

| Directory | Purpose | Status (2026-09-29) |
|---|---|---|
| `multi-account-trading-dashboard/` | v1 chain for the IBKR multi-account dashboard: brief, research, design, spec, plan, tasks, analysis | Superseded in part. Built and closed out; `design.md`'s look and token contract is still current, its layout and the nightly-pipeline, brief-panel, market-strip and widget parts are history |
| `retire-nightly-pipeline/` | Replace the nightly GitHub Actions data pipeline with Supabase edge functions and pg_cron | Complete (2026-07-13, PRs #53-#57) |
| `live-desk-assistant/` | Ask-the-desk upgrade: memory, web research, live quotes, directional views | Superseded in part. Shipped in PR #142, since extended (12-call tool loop, editable prompt, scheduled asks, tickers-not-money ruling) |
| `watchlist-driven-charts/` | Charts rail reads the watchlists; Watchlists panel moves above the charts | Superseded in part. Shipped in PR #248; the manual column was replaced by the 100-slot SYMBOL column (PR #282) |
| `economy-indicators/` | Economy panel: yields, unemployment, CPI/PCE with per-row span charts (`desk-econ`) | Backend deployed and UI built 2026-09-30 (S55); Treasury same-day rate switched ON for the three yields the same day (roster); 2026-10-01: Treasury is 17–20 s from Supabase and every request is a fresh instance, so v3 keeps it in the shared `desk_feed_cache` under a lease (v3 deploy pending; live v1 still serves FRED yields, ~5 s slower per reply) |
| `etrade-roth-account-c/` | E*TRADE Roth IRA as a third account (brief and spec only) | On hold since 2026-07-16, paused at clarify awaiting a data-path decision; nothing implemented |
