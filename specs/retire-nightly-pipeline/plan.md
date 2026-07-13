# Plan: Retire the Nightly Pipeline — Live-Delayed Data Everywhere

**Status:** Phase 3 (plan) — pending owner approval
**Spec:** `spec.md` (FR-R1..R12, clarified 2026-07-13)
**Constitution:** global.md (no local build, free-tier), data.md (dedicated
project only, RLS, reversible-by-design), design.md (lamps + as-of stamps),
test.md (S1 console gate, qa-live blocking).

## Architecture in one paragraph

Every public feed becomes an **anon-callable Supabase Edge Function on the
dedicated project** that fetches its upstream server-side, shapes the payload
to the same JSON contract the retired `data/*.json` file had, and caches it
in module memory for ≤ 5 minutes (the desk-maps pattern, deployed and
proven). The two secret-bearing jobs (IBKR Flex sync, Anthropic brief) become
**scheduled edge functions triggered by Supabase Cron** (`pg_cron` +
`pg_net`, available on the free tier) — they already write to the desk's
Supabase tables, so only the scheduler changes. The client gains one small
**feed poller**: each live panel loads lazily, then re-fetches its feed every
5 minutes while the tab is open, driving lamps/stamps from each payload's own
`generatedAt`. Demo mode never touches any of this.

## Components

### New edge functions (public feeds — anon, fixed upstream, ~5-min cache)

| Function | Replaces | Upstream (server-side) | Payload contract |
|---|---|---|---|
| `desk-market` | `fetch-market.js` → `market.json` | Stooq quotes (indices/ETFs) + FRED 10Y CSV — same chain as today, from unthrottled egress | `{ok, generatedAt, asOf, tiles:[…]}` — field-compatible with `market.json` |
| `desk-heatmap` | `fetch-heatmap.js` → `heatmap.json` | Nasdaq screener bulk endpoint (primary, one call for ~500 rows) → Yahoo spark chunks (fallback) | `{ok, generatedAt, asOf, sectors:[…]}` — same shape as `heatmap.json` |
| `desk-charts` | `fetch-charts.js` → `charts.json` | Stooq EOD CSV per symbol → Yahoo v8 chart fallback (the exact quote-proxy daily chain, batched over the watchlist roster) | `{ok, generatedAt, asOf, symbols:{SYM:{t,o,h,l,c,v}}}` — same shape as `charts.json` |
| `desk-news` | `fetch-news.js` → `news.json` | RSS feeds per `config/news-feeds.json` fetched from the Pages origin (owner edits need no redeploy — desk-maps precedent); parse via `npm:fast-xml-parser` (edge runtime supports npm imports; same parser as today) | `{ok, generatedAt, items:[…]}` — same shape as `news.json` |
| `desk-maps` | *(shipped, PR #53)* | Yahoo v8 spark | unchanged |

Shared choices: CORS `*`; `verify_jwt: true` with the anon key (matches all
existing functions); rosters/config read from the Pages origin with a 1-hour
module cache; payload cache `QUOTE_TTL_MS = 300_000` (desk-maps' 2-min stays
— it is already within the 5-min bar). `desk-charts` is the heavyweight
(~25 upstream calls on a cold cache): its cache is primed per-symbol so a
partial upstream failure degrades to partial coverage plus last-good, and its
TTL is 30 min for bars older than today (EOD history doesn't change
intraday) with only the latest bar refreshed on the 5-min cycle.

### Scheduled jobs (private/costly — Supabase Cron)

| Function | Replaces | Trigger | Notes |
|---|---|---|---|
| `desk-ibkr-sync` | `fetch-ibkr.js` | `pg_cron` 22:35 UTC + 09:35 UTC retry, via `pg_net` POST with a shared secret header | Port of the Flex fetch → upsert; `IBKR_FLEX_TOKEN`/`QUERY_ID` move from Actions secrets to **edge function secrets**; same idempotent upsert + expected-as-of guard |
| `desk-brief` | `generate-brief.js` | same two slots, after ibkr-sync | Port verbatim including the **FR-AI4 grounding guard**; `ANTHROPIC_API_KEY` moves to function secrets; grounding context now read from the live feed functions instead of `data/*.json` |

Both scheduled functions reject unauthenticated invocations (require the
cron shared-secret header) — they are not public surface. The cron schedule
is a **versioned SQL migration** (data.md rule 1) whose header comments the
inverse (`cron.unschedule`).

### Client (`scripts/data.js`, `scripts/app.js`)

- `deskFeed(name)` wrapper (one function, parameterized) beside `deskMaps()`.
- **Feed poller:** `startFeedPolling()` — after first successful paint of a
  live panel, re-fetch its feed every 5 min (`setInterval`, paused on
  `document.hidden` via `visibilitychange` to save invocations, resumed with
  an immediate refresh). Every poll failure keeps last-good (FR-R9).
- **Lazy first load, S1-safe (FR-R8):** the initial fetch of each feed fires
  from the existing per-panel loaders *after* first paint of the shell — and,
  like desk-maps, a failed feed sets an honest per-panel unavailable state
  without retry storms. Console-noise reality: a network-level failure logs a
  resource error regardless of handling, so S1's guarantee is met by the
  *live site being up*, and the S1 spec keeps its current form (it tests
  load, and loads no longer 404 — the functions exist before cutover).
- **Lamps (FR-R7):** `lampFor` gains a live variant: `generatedAt` within
  ≤ 6 min → `LIVE`; older → `STALE (live feed)` with the stamp carrying the
  fetch time. `meta.json` loading, `DESK.meta`, and the meta-driven gates are
  deleted in the final phase.

### Deletions (final phase only)

`data-refresh.yml`, `cron-notify.yml`, `.github/scripts/refresh/` (scripts,
lib, fixtures, package.json), `data/*.json`, meta plumbing in
`data.js`/`app.js`, the "Pipeline fixture tests" row in CLAUDE.md's Required
Commands, and the CLAUDE.md architecture bullets that describe the pipeline.

## Failure modes and answers

| Failure | Behavior |
|---|---|
| Upstream throttles the new egress (the maps saga repeats) | Each function keeps its last successful payload in module memory and serves it stale-marked (`generatedAt` honest); client lamp flips to STALE at > 6 min. Cold instance + dead upstream → `ok:false` → panel unavailable state, other panels unaffected |
| Supabase project auto-pauses (free tier, existing runbook) | All live panels degrade to unavailable states; demo unaffected; existing CLAUDE.md runbook covers restore. The daily cron jobs also stop — the brief/accounts lamps go stale, which is the documented early-warning signal (replaces the pipeline-email signal) |
| `pg_net` invocation silently fails | The 09:35 retry slot re-fires it; persistent failure surfaces as stale accounts/brief lamps (alerting = lamps + logs per clarification 2) |
| Free-tier invocation/compute budget | ~35K invocations/month at worst-case polling (clarification 3); `desk-charts` cold-cache cost bounded by per-symbol caching + 30-min history TTL |
| A function deploy regresses | Functions are versioned sources in `supabase/functions/`; `git revert` + redeploy restores prior behavior (data.md rules 2–3). No schema/RLS changes anywhere in this migration |

## Rollout phases (FR-R11 — never dark)

0. **PR #53 merges** (desk-maps pattern-setter) — done first, separately.
1. **PR A — public feeds:** four new function sources + client cutover
   behind their availability (client prefers the live feed, falls back to the
   committed snapshot if the feed errors — snapshots still exist in this
   phase). Deploy functions (owner prompt), merge on green + owner approval,
   verify all four panels LIVE on production.
2. **PR B — scheduled jobs:** two function sources + the cron migration.
   Deploy + apply migration (owner prompts), verify next-day accounts/brief
   landed via Supabase, then remove the IBKR/brief steps from the nightly
   (keeping the workflow shell one more day is fine — it is now a no-op).
3. **PR C — the deletion:** everything in the Deletions list, snapshot
   fallback removed, lamps fully live-derived, qa expectations updated
   (S5 demo lamps unchanged; live lamp assertions in qa-live adjusted),
   CLAUDE.md + spec artifacts updated. Merge ends the pipeline era.

Each PR is independently revertible; the site serves data at every point.

## Test impact

- Fixture tests: retired with the pipeline in PR C (33 → 0 for refresh; the
  suite row leaves CLAUDE.md). The shaping logic ports into Deno functions —
  the durable safety net becomes qa-live's S-scenarios against production
  plus each function's honest `ok:false` degradation.
- S5/S9/S12/S13 (demo) unchanged by construction (FR-R12).
- qa-live gains one scenario (S14): with the desk live, the market strip
  lamp reads LIVE and its stamp is < 6 min old — the canary that the whole
  live-feed layer is up.
