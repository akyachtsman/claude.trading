# Plan — Multi-Account Trading Dashboard (v1)

HOW for `spec.md` (incl. Clarifications). Constitution: the four imported
directives — static tier, no local build, client-side Supabase + RLS is the
sanctioned dynamic pattern (global.md → Hosting), data rules per data.md.
Ambition bar: terminal-grade per brief.md + research.md; look is the approved
daylight-ledger contract (design.md) — build against `styles/*`, don't fork it.

## Stack
- **Frontend:** plain HTML + CSS + vanilla JS on GitHub Pages (existing
  `index.html` evolves; JS moves to `scripts/app.js` + `scripts/data.js`;
  no framework, no build). `@supabase/supabase-js@2` loaded from CDN as an
  ES module import (pinned version) — constitution-compatible (no build).
- **Private data:** Supabase (hosted Postgres) — RLS default-deny; browser
  uses the publishable/anon key (repo variable `DB_URL` + `DB_ANON_KEY`)
  and reads exclusively through SECURITY DEFINER RPCs that validate the PIN.
- **Pipeline:** one new GitHub Actions workflow `data-refresh.yml`
  (cron: weekdays ~22:30 UTC + `workflow_dispatch`) running Node scripts in
  `.github/scripts/refresh/` with repo secrets.
- **AI brief:** Anthropic API from the pipeline job (server-side only),
  model `claude-sonnet-5` (quality/cost fit for one brief/day; consult the
  claude-api skill at implement time for params). Structured JSON output.

## Data domains (the key architectural split)
| Domain | Sensitivity | Store | Read path |
|---|---|---|---|
| Market summary (indices, VIX, 10Y) | public | committed `data/market.json` | `fetch()` + cache-bust |
| News headlines | public | committed `data/news.json` | `fetch()` + cache-bust |
| Refresh metadata (as-of stamps, last success) | public | committed `data/meta.json` | `fetch()` |
| Account snapshots + equity history | **private** | Supabase | PIN-validated RPC |
| AI daily brief (quotes account numbers) | **private** | Supabase | PIN-validated RPC |

Public data stays in the repo (free, cacheable, no backend dependency for
the pre-auth view). Private data never touches the repo or the served files
(FR-D1, Clarification 2).

## Supabase design (data.md client-auth pattern)
Tables (RLS enabled, **default-deny, zero anon policies** — all access via
RPCs; direct table grants revoked):
- `desk_users(id uuid pk, label text, pin_hash text, is_test bool)` —
  two rows: owner, QA test user. `pin_hash` = salted SHA-256; the column is
  never selectable by anon (column grants revoked; login is a function).
- `account_snapshots(id, user_id fk, account_key text, label text,
  as_of date, nav numeric, day_pnl numeric, total_unrl numeric,
  cash numeric, positions jsonb, created_at)` — unique
  `(user_id, account_key, as_of)` for idempotent upserts.
- `equity_history(user_id, account_key, as_of date, nav numeric)` — one row
  per account per trading day; accumulates from the daily run (charts grow
  richer over time; optional backfill later via a historical Flex run).
- `ai_briefs(user_id, as_of date, generated_at timestamptz, model text,
  content jsonb)` — content = {state, levels[], scenarios[]}.

RPCs (SECURITY DEFINER, `search_path` pinned, EXECUTE revoked from
`authenticated`, granted to `anon` per data.md):
- `desk_login(pin text) → {ok bool, label text}` — constant-time hash compare.
- `desk_get_dashboard(pin text) → jsonb` — validates pin, returns latest
  snapshots + equity history + latest brief in one round-trip.
Wrong pin → `{ok:false}`; reveals nothing (FR-AUTH2). Test user's rows are
demo-grade data only (FR-AUTH3).

**Accepted residuals (record in CLAUDE.md):** PIN space is brute-forceable
through the RPC (RLS cannot rate-limit); the PIN sits in sessionStorage for
the tab session; Supabase anon key is public by design.

## Pipeline — `data-refresh.yml`
Jobs (single workflow, sequential steps; Node 20; secrets guarded like
`notify-task.js` — missing secret ⇒ clear notice + demo-safe no-op, never a
cryptic crash):
1. **fetch-ibkr** — IBKR Flex Web Service: `SendRequest` (token + query id)
   → poll `GetStatement` with backoff. Parses XML for both accounts (one
   Flex query spanning the 2 accounts). Secrets: `IBKR_FLEX_TOKEN`,
   `IBKR_FLEX_QUERY_ID`. Upserts snapshots + equity_history via
   `DB_SERVICE_KEY` (service role, server-side only per data.md).
2. **fetch-market** — Stooq CSV endpoints (free, keyless): ^spx, ^ndq, ^dji,
   ^rut? (Russell on stooq: ^rut unavailable → use IWM proxy or ^rus if
   present — resolve at implement), ^vix, 10Y via FRED `DGS10` public CSV.
   Last value + change + 30-day closes for sparklines → `data/market.json`.
3. **fetch-news** — keyless RSS: Yahoo Finance per-ticker feeds for held
   symbols (tickers read from the private snapshot in-job, but only
   PUBLIC headlines are written out; the holdings-first ordering leaks that
   a symbol is followed — acceptable, it's also in the demo) + 2–3 general
   market feeds (CNBC/MarketWatch RSS). Dedupe, rank holdings-first, cap 20
   → `data/news.json`.
4. **generate-brief** — compose grounding context (latest private snapshot +
   market.json + news.json), call Anthropic (`ANTHROPIC_API_KEY`), require
   structured JSON out; validate numbers-cited-exist before storing to
   `ai_briefs`. Any failure ⇒ skip write (panel shows stale per FR-AI4).
5. **commit-public** — write `data/*.json` + `meta.json` (per-domain as-of +
   status) and push to `main` [bot data commit — same standing exception as
   the template `keepalive.yml`; code changes still go through PRs]. The
   push triggers the Pages deploy; `pages-monitor.yml`/`pages-retry.yml`
   already watch it.
6. **on-failure** — job failure emails via the existing `notify-email.js`
   (SMTP secrets from bootstrap); last-good data keeps serving (FR-D4).

Idempotency: re-runs upsert on `(user_id, account_key, as_of)`; holidays/
weekends produce no new Flex data → job detects unchanged `as_of` and exits
cleanly without a data commit.

## Frontend changes
- `index.html` slims to markup + module script tags; JS splits into:
  - `scripts/config.js` — account list (2 entries, labels editable in one
    place), feature flags.
  - `scripts/data.js` — demo generator (current seeded walks, now 2
    accounts), public JSON loaders, Supabase RPC client, staleness compute.
  - `scripts/app.js` — rendering (existing render functions), auth overlay,
    interactions (sort, consolidate, timeframes, hover).
- **Mode resolution at load:** if `?demo=1` or no `DB_URL` configured →
  DEMO mode (everything renders from generated data, DEMO lamps — current
  behavior, FR-D3). Otherwise: market strip + news render immediately from
  `data/*.json` (pre-auth, FR-AUTH1); account grid/chart/brief render as
  **locked panels** (lamp `LOCKED`, one-line explain + PIN input, iPad-size
  targets). Successful `desk_login` → `desk_get_dashboard` → full render;
  PIN kept in sessionStorage; a "Lock" control clears it.
- Staleness: every panel's lamp derives from `meta.json`/row dates — EOD
  (fresh), STALE (older than last trading day, shown with its true date),
  DEMO, LOCKED. Masthead shows overall snapshot time (FR-D2).
- Charts unchanged in design; series count now follows config (2 + the
  consolidated line). Equity history may be short initially — the chart
  renders whatever exists and the timeframe buttons disable when history is
  shorter than the window (no fake data in live mode).

## Data flow (end to end)
IBKR Flex / Stooq+FRED / RSS → `data-refresh.yml` (Node scripts, secrets)
→ Supabase (private, service key) + `data/*.json` commit (public)
→ Pages deploy → browser: fetch public JSON immediately; PIN → RPC →
private render. Anthropic is called only inside the workflow.

## Main failure modes & handling
| Failure | Behavior |
|---|---|
| Flex service slow/down | retries w/ backoff; no upsert; STALE lamps + true dates; email notice |
| Stooq/FRED/RSS down | keep last committed JSON (old as-of visible); partial refresh allowed per domain |
| Anthropic error/invalid JSON | no brief write; panel shows "brief stale since <date>" (FR-AI4) |
| Supabase unreachable in browser | locked panels show error + retry action; public panels unaffected |
| Wrong PIN | inline error, no info leak (FR-AUTH2) |
| Missing secret | step prints a clear notice and exits 0 for that domain (bootstrap convention) |
| Duplicate run / holiday | idempotent upserts; unchanged as_of ⇒ no commit |

## Owner setup checklist (blocking live mode, not the build)
Secrets: `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`, `ANTHROPIC_API_KEY`,
`DB_SERVICE_KEY`, (SMTP already set at bootstrap). Variables: `DB_URL`,
`DB_ANON_KEY`, `TEST_AUTH_CREDENTIAL` secret for qa-live. Supabase project:
provision via Supabase MCP at implement (owner confirms cost if a new
project is needed). IBKR: create one Flex query (both accounts; sections:
Account Information, NAV, Cash Report, Open Positions) + activate Flex Web
Service token.

## Alternatives considered
- **Commit encrypted account JSON to repo** — no backend, but key handling
  in-browser is clunkier than a PIN RPC and rotating is painful. Rejected.
- **Full Supabase Auth** — heavyweight for a single owner; the data.md PIN
  pattern is the proven fit. Rejected for v1.
- **IBKR Client Portal API** — richer/intraday but needs an always-on
  authenticated gateway; incompatible with no-server. Rejected.
- **Paid market-data API** — cleaner symbols than Stooq but adds a key and
  cost for six tickers. Revisit if Stooq proves flaky.

## Phasing (risk-ordered, not scope-trimmed)
A. Frontend restructure + 2-account config + locked/demo states (pure
   static, verifiable on Pages immediately).
B. Supabase schema + RPCs + seeded test user (Supabase MCP; advisors run).
C. Pipeline: IBKR fetch → upserts; market/news/meta publics; failure mails.
D. AI brief generation + panel wiring.
E. qa-live wiring (TEST_AUTH_CREDENTIAL), CLAUDE.md updates (UI Test
   Configuration, scenarios S5+, security residuals, architecture), polish
   pass against design.md craft rules.
