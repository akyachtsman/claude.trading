# Plan: Retire the Nightly Pipeline — Live-Delayed Data Everywhere

**Status:** Phase 3 (plan) — revised after the fresh-context reviewer pass
(scores A7/B8/C5/D7 → all ten findings addressed); pending owner approval
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
| `desk-heatmap` | `fetch-heatmap.js` → `heatmap.json` | Nasdaq screener bulk endpoint (primary, one call for ~500 rows) → Yahoo v7 crumb quote (mid-tier, carries caps) → Yahoo spark + a **24-hour module cap cache** seeded from the last cap-bearing pass (spark has no caps and the retired `prevCaps` rescue read the committed file, which ceases to exist). Below a 300-tile coverage floor → `ok:false` | `{ok, generatedAt, asOf, sectors:[…]}` — same shape as `heatmap.json` |
| `desk-charts` | `fetch-charts.js` → `charts.json` | Stooq EOD CSV per symbol → Yahoo v8 chart fallback (the exact quote-proxy daily chain). **Parallel batches, no ported etiquette sleeps** (the 400ms gaps were a runner-IP mitigation that no longer applies). First-response latency budget ≤ 4s: serve whatever coverage is primed with `ok:true, partial:true` rather than blocking the workbench paint on a full cold sweep | `{ok, partial?, generatedAt, asOf, symbols:{SYM:{t,o,h,l,c,v}}}` — same shape as `charts.json` |
| `desk-news` | `fetch-news.js` → `news.json` | RSS feeds per `config/news-feeds.json` fetched from the Pages origin (owner edits need no redeploy — desk-maps precedent); parse via `npm:fast-xml-parser` (edge runtime supports npm imports; same parser as today). **Holdings-first semantics preserved**: the function reads latest snapshots with the service key exactly as `fetch-news.js` does today — not a new key surface (`quote-proxy` already holds `SUPABASE_SERVICE_ROLE_KEY`), and the emitted payload is byte-shape-identical to the `news.json` that is already committed publicly, so nothing new is disclosed. Chip day-% ports the Stooq `dayPctMap`. Recorded as an accepted residual in CLAUDE.md; PR A routes through `/security-review` | `{ok, generatedAt, items:[…]}` — same shape as `news.json` |
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
| `desk-ibkr-sync` | `fetch-ibkr.js` | `pg_cron` **22:35 UTC + 09:35 UTC retry** via `pg_net` POST | Port of the Flex fetch → upsert; `IBKR_FLEX_TOKEN`/`QUERY_ID` move from Actions secrets to **edge function secrets**; same idempotent upsert + expected-as-of guard. **Flex polling capped ≤ 60s** to fit the edge wall-clock limit — not-ready exits honestly and the second cron slot is the retry, exactly today's behavior |
| `desk-brief` | `generate-brief.js` | `pg_cron` **23:05 UTC + 10:05 UTC** (own staggered slots — pg_cron cannot sequence dependent HTTP calls; the brief already tolerates a not-ready sync via the stale-lamp path) | Port verbatim including the **FR-AI4 grounding guard**; `ANTHROPIC_API_KEY` moves to function secrets; grounding context now read from the live feed functions instead of `data/*.json` |

Both scheduled functions reject unauthenticated invocations (require a
cron shared-secret header) — they are not public surface. The cron schedule
is a **versioned SQL migration** (data.md rule 1) whose header comments the
inverse (`cron.unschedule`). **The migration file is public** (public repo),
so it contains no literals: the shared secret AND the anon key for the
`verify_jwt` Bearer both resolve at runtime from **Supabase Vault**
(`vault.decrypted_secrets`), provisioned once by the owner via the
dashboard. Every `net.http_post` sets an explicit
`timeout_milliseconds := 150000` — the 5-second default would abort both
functions mid-run.

### Client (`scripts/data.js`, `scripts/app.js`)

- `deskFeed(name)` wrapper (one function, parameterized) beside `deskMaps()`.
- **Feed poller:** `startFeedPolling()` — after first successful paint of a
  live panel, re-fetch its feed every 5 min (`setInterval`, paused on
  `document.hidden` via `visibilitychange` to save invocations, resumed with
  an immediate refresh). Every poll failure keeps last-good (FR-R9).
- **Lazy first load + FR-R8 amendment:** the initial fetch of each feed fires
  from the existing per-panel loaders *after* first paint of the shell — and,
  like desk-maps, a failed feed sets an honest per-panel unavailable state
  without retry storms. Console-noise reality: browsers log a resource error
  for network failures AND handled 4xx/5xx fetches, so "no console errors
  with all feeds down" is not implementable. **FR-R8 is amended** (spec.md
  Clarifications #6): S1 keeps its zero-tolerance for *unhandled* errors and
  gains a narrowly-scoped allowlist for feed-origin resource errors, with the
  written reason test.md requires recorded in the test file.
- **Lamps (FR-R7), two-tier freshness:** the lamp class derives from
  `generatedAt` (fetch ≤ 6 min → `LIVE`, older → `STALE`); the stamp text
  always carries the payload's own data `asOf` alongside the fetch time
  ("LIVE · quotes 15:55 UTC · 10Y as of 2026-07-10") so a LIVE lamp can
  never overstate quote freshness. **Recorded carve-out:** the FRED 10Y tile
  is T-1 by upstream construction (mirrors the spec's IBKR/brief carve-out).
  `meta.json` loading, `DESK.meta`, and the meta-driven gates are deleted in
  the final phase.

### Deletions (final phase only)

`data-refresh.yml`, `cron-notify.yml`, `.github/scripts/refresh/` (scripts,
lib, fixtures, package.json), `data/*.json`, meta plumbing in
`data.js`/`app.js`, the "Pipeline fixture tests" row in CLAUDE.md's Required
Commands, and the CLAUDE.md architecture bullets that describe the pipeline.

## Failure modes and answers

| Failure | Behavior |
|---|---|
| Upstream throttles the new egress (the maps saga repeats) | Each function **may** hold its last successful payload in module memory (per-instance, evaporates on recycle — precisely when cold-instance + dead-upstream coincide, last-good is likely absent) and serves it stale-marked; client-side, each panel also keeps the tab's last good payload (FR-R9's real guarantee). Cold instance + dead upstream + fresh tab → `ok:false` → honest unavailable state, other panels unaffected. **Accepted residual at single-owner scale** — no persistence table, keeping this migration schema-free |
| Concurrent warm instances each fetch upstream and cache independently | The "~one batch per window" bound is per instance; at this site's traffic the multiplier is ~1–2. Folded into the budget row's math as a 2× headroom factor — still comfortably inside free tier |
| `pg_net` default 5s timeout aborts a scheduled invocation | Every cron `net.http_post` sets `timeout_milliseconds := 150000` explicitly; `desk-ibkr-sync` additionally caps Flex polling ≤ 60s and exits not-ready for the retry slot |
| Supabase project auto-pauses (free tier, existing runbook) | All live panels degrade to unavailable states; demo unaffected; existing CLAUDE.md runbook covers restore. The daily cron jobs also stop — the brief/accounts lamps go stale, which is the documented early-warning signal (replaces the pipeline-email signal) |
| `pg_net` invocation silently fails | The 09:35 retry slot re-fires it; persistent failure surfaces as stale accounts/brief lamps (alerting = lamps + logs per clarification 2) |
| Free-tier invocation/compute budget | ~35K invocations/month at worst-case polling (clarification 3); `desk-charts` cold-cache cost bounded by per-symbol caching + 30-min history TTL |
| A function deploy regresses | Functions are versioned sources in `supabase/functions/`; `git revert` + redeploy restores prior behavior (data.md rules 2–3). No table or RLS changes anywhere in this migration — the only SQL migration is the cron schedule (inverse: `cron.unschedule`) |

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
   (S5 demo lamps unchanged; live lamp assertions in qa-live adjusted; the
   S1 feed-origin allowlist lands with its written reason), CLAUDE.md + spec
   artifacts updated. Checklist item: **verify keepalive.yml still resets
   GitHub's 60-day scheduled-workflow clock once bot data commits stop**
   (dispatch it and confirm the empty commit lands). Merge ends the
   pipeline era.

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
