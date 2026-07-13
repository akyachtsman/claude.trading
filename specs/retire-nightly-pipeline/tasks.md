# Tasks: Retire the Nightly Pipeline

**Status:** Phase 4 (tasks) — plan approved 2026-07-13
**Phase 0 (done):** PR #53 merged (`1fb7264`) — desk-maps live, pattern set,
verified 200/38-of-38 via pg_net. `desk_004_enable_pg_net` migration applied.

Conventions: one PR per group (A/B/C per plan.md rollout); every group ends
with the Required Commands gates + `qa-pipeline`; deploys/migrations are
owner-prompt-gated; branch = `claude/hello-kccc26` restarted from `main` per
group. `[P]` = parallel-safe within its group.

## Group A — public feeds (PR A)

- [x] **A1 [P]** `supabase/functions/desk-market/index.ts`: port
  `fetch-market.js` (Stooq quote chain + FRED DGS10 CSV) to Deno; emit
  `{ok, generatedAt, asOf, tiles}` matching `data/market.json`; inline
  `sessionOpen()` helper (Mon–Fri 09:30–16:00 America/New_York via
  `Intl.DateTimeFormat`, NYSE holiday list 2026–2027 with annual-refresh
  comment); cache TTL 5 min open / 60 min closed.
- [x] **A2 [P]** `supabase/functions/desk-heatmap/index.ts`: port
  `fetch-heatmap.js`; chain = Nasdaq screener → Yahoo v7 crumb quote →
  spark + 24h module cap cache; 300-tile floor → `ok:false`; same
  `{sectors}` shape as `data/heatmap.json`; session-aware TTL.
- [x] **A3 [P]** `supabase/functions/desk-charts/index.ts`: port
  `fetch-charts.js` (Stooq EOD → Yahoo v8 chart per symbol) with parallel
  batches (no etiquette sleeps), per-symbol cache priming, 30-min TTL for
  history bars + session-aware TTL for the latest bar, `partial:true` under
  a 4s first-response budget; roster from Pages `config/chart-watchlist.json`.
- [x] **A4 [P]** `supabase/functions/desk-news/index.ts`: port
  `fetch-news.js` incl. holdings-first ranking (service key via
  `SUPABASE_SERVICE_ROLE_KEY` env — quote-proxy precedent), per-ticker
  feeds, Stooq `dayPctMap` chips; RSS parse via `npm:fast-xml-parser`;
  feeds roster from Pages `config/news-feeds.json`; same `{items}` shape as
  `data/news.json`.
- [x] **A5** `scripts/data.js`: add `deskFeed(name)` POST wrapper (mirrors
  `deskMaps`); add `marketSessionOpen()` (same rule as A1, comment linking
  the two); add two-tier `liveLampFor(generatedAt, dataAsOf)` returning
  LIVE ≤ 6 min / STALE beyond, stamp carrying both times.
- [x] **A6** `scripts/app.js`: each live panel loader (market strip,
  heatmap, charts, news) tries `deskFeed(...)` first, falls back to the
  existing `fetchPublic('data/….json')` snapshot on failure (fallback dies
  in Group C); wire `startFeedPolling()` — interval from
  `marketSessionOpen()` (5/60 min), `visibilitychange` pause + resume-refresh.
- [x] **A7** `index.html`: bump all five `?v=` tokens together.
- [x] **A8** Gates: html-validate, contrast, workflow YAML, fixture tests,
  `node --check` both scripts; local Playwright demo subset
  (S1/S5–S9/S12/S13 on mobile-chrome) — demo behavior must be unchanged.
- [x] **A9** `/security-review` on the diff (desk-news service-key surface)
  + `directives-toolkit:qa-pipeline`.
- [x] **A10** Draft PR A; deploy the four functions (owner prompts); verify
  each via pg_net (`status_code = 200`, `ok:true`, shape spot-checks);
  merge on green + owner approval; verify all four panels show LIVE lamps
  on production.

## Group B — scheduled jobs (PR B)

- [x] **B1 [P]** `supabase/functions/desk-ibkr-sync/index.ts`: port
  `fetch-ibkr.js` — Flex SendRequest/GetStatement with polling capped at
  60s (not-ready exits honestly; the retry slot is the recovery), same
  idempotent upsert + expected-as-of guard; requires
  `x-cron-secret` header matching `CRON_SECRET` env; 401 otherwise.
- [x] **B2 [P]** `supabase/functions/desk-brief/index.ts`: port
  `generate-brief.js` with the FR-AI4 grounding guard verbatim; grounding
  context assembled from `desk-market`/`desk-charts`/`desk-heatmap`
  responses (not `data/*.json`); same `CRON_SECRET` gate; writes the same
  brief table/row shape.
- [ ] **B3** Owner provisions (dashboard, one-time): Vault secrets
  `cron_secret` + `anon_key`; function secrets `IBKR_FLEX_TOKEN`,
  `IBKR_FLEX_QUERY_ID`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, plus
  `SUPABASE_SERVICE_ROLE_KEY` availability check (present by default).
- [ ] **B4** Migration `desk_005_cron_schedule` (via `apply_migration`):
  `create extension pg_cron`; four `cron.schedule` entries — sync
  22:35/09:35 UTC, brief 23:05/10:05 UTC — each `net.http_post` with
  `timeout_milliseconds := 150000`, headers built from
  `vault.decrypted_secrets` lookups (`anon_key` Bearer + `cron_secret`);
  header comment carries the `cron.unschedule` inverses. No literals —
  the migration is public.
- [ ] **B5** Deploy both functions + apply migration (owner prompts); fire
  `desk-ibkr-sync` once via pg_net with the secret and verify the upsert
  guard response; verify `desk-brief` at its next slot (or fire once) —
  check `cron.job_run_details` and the brief row.
- [x] **B6** `.github/workflows/data-refresh.yml`: remove the IBKR and
  brief steps (workflow shell remains until Group C).
- [ ] **B7** Gates + `qa-pipeline`; PR B merge on green + owner approval
  (backend class); confirm next-morning accounts/brief lamps are fresh.

## Group C — the deletion (PR C)

- [ ] **C1** Delete `.github/workflows/data-refresh.yml`,
  `.github/workflows/cron-notify.yml`, the whole
  `.github/scripts/refresh/` tree, and `data/*.json`.
- [ ] **C2** `scripts/data.js` + `scripts/app.js`: delete meta loading,
  `DESK.meta`, meta-driven gates, and every `fetchPublic('data/…')`
  snapshot fallback from A6 — live feeds + demo generator are the only two
  sources left; lamps fully live-derived.
- [ ] **C3** `.github/scripts/ui-tests/tests/app.spec.js`: S1 gains the
  narrowly-scoped feed-origin console-error allowlist with the written
  reason (spec Clarifications #7); add S14 (live only): market-strip lamp
  reads LIVE with stamp < 6 min — the live-feed-layer canary; confirm S5
  demo lamps untouched.
- [ ] **C4** `CLAUDE.md`: drop the "Pipeline fixture tests" Required
  Commands row; rewrite the pipeline architecture bullets (edge functions +
  cron are the data layer now); add the desk-news service-key accepted
  residual; update the S13/S14 scenario table rows.
- [ ] **C5** Gates + `qa-pipeline`; PR C merge on green + owner approval;
  verify production panels post-deploy (cache-busted); **dispatch
  `keepalive.yml` and confirm the empty commit lands** — it is now the only
  writer resetting the 60-day Actions scheduler clock.
- [ ] **C6** Close the loop: `specs/retire-nightly-pipeline/analysis.md`
  via `/sdd-loop analyze`; append a learnings.jsonl entry (nightly→live
  migration pattern, pg_net verification trick).
