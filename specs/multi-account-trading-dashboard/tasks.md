# Tasks — Multi-Account Trading Dashboard (v1)

Derived from `plan.md`. Ordered; `dep:` lists blockers; `[P]` = parallel-safe
within its phase. Every task names its files. Check off as landed. Gates
(html-validate, contrast, security grep, node --check, YAML parse) run before
every push; qa-pipeline runs at each phase boundary.

## Phase A — frontend restructure (demo-first, pure static)
- [x] A1. Create `scripts/config.js`: `DESK_ACCOUNTS` (2 entries — key,
      label placeholder, short-id mask, series slot), `DESK_DB` ({url:'',
      anonKey:''} — empty until Phase B ⇒ demo mode). dep: —
- [x] A2. Extract inline JS from `index.html` into `scripts/data.js`
      (formatters, seeded demo generator now driven by `DESK_ACCOUNTS`,
      LABELS/EQUITY builders) and `scripts/app.js` (el/svg helpers, strip/
      accounts/news/chart renderers, makeSortable, interactions);
      `index.html` keeps markup + 3 script tags. Demo now renders 2
      accounts; the static 3-account AI-brief markup is retired — data.js
      gains a demo-brief generator (2-account numbers derived from the demo
      snapshot) rendered by the same brief renderer D1 later reuses; the 1Y
      seg button becomes data-days="252"; update design.md's reference-page
      description to two account windows. dep: A1
- [x] A3. Add `.lamp--locked`/`.lamp--stale` + `.panel-lock` (PIN form:
      48px `.input`, 44px `.btn`, error line) to `styles/components.css`,
      tokens only; extend `check-contrast.js` pairs if a new color pair
      appears (expected: none — reuse existing tokens). dep: —  [P]
- [x] A4. Mode resolution in `scripts/data.js`: `demo` when `?demo=1` or
      `!DESK_DB.url`; else `live`. In live: fetch `data/meta.json`,
      `data/market.json`, `data/news.json` with `?v=<Date.now()>`;
      per-domain fallback to last-known/demo-labeled with correct lamp.
      dep: A2
- [x] A5. Locked-state rendering in `scripts/app.js`: in live mode
      pre-auth, account grid + equity panel + brief panel render locked
      variants (lamp LOCKED, one-line explain, PIN form once — in the
      accounts header area); market strip + news render normally. dep: A2, A3
- [x] A6. Auth flow in `scripts/app.js`: submit PIN → (Phase B wires real
      RPC; until then a stub rejects) → error line "PIN not recognized —
      try again"; success path renders full dashboard from payload;
      sessionStorage `desk_pin`; masthead "Lock" button clears + re-renders
      locked. dep: A5
- [x] A7. Staleness engine in `scripts/data.js`: per-panel lamp state from
      each domain's embedded as-of (EOD if == last US trading day, else
      STALE + true date); masthead overall stamp from meta; DEMO overrides
      all in demo mode. Include last-trading-day helper (weekends/observed
      holidays list). dep: A4
- [x] A8. Timeframe guard in `scripts/app.js`: disable seg buttons whose
      window exceeds available history (aria-disabled + title reason). Demo
      generator (data.js) produces 260 trading days so every timeframe is
      exercisable in demo; the guard is for live mode's growing history.
      dep: A2
- [x] A9. Playwright parity run (local): S1–S4 basics + demo render, sort,
      consolidate, timeframes, hover; fix regressions. dep: A2–A8
- [x] A10. Gates + qa-pipeline agent (Phase A scope); PR "feat: modular
      frontend + auth/locked states (demo)" → merge → update-pages verify
      live. dep: A9

## Phase B — Supabase (private data + PIN)
- [x] B1. Supabase MCP: free tier full (2/2 projects); dedicated project
      blocked — desk tables live `desk_`-prefixed in the lighter existing
      project ("insurance", ref bdsegmjcgfmgzuxwiplj), reversible via
      schema move if the owner later frees a slot/upgrades. dep: —
- [x] B2. Migration `001_tables.sql` via `apply_migration`: desk_users,
      account_snapshots, equity_history, ai_briefs (+uniques per plan),
      `alter table … enable row level security` on all; no policies (all
      default-deny). dep: B1
- [x] B3. Migration `002_rpcs.sql`: `desk_login(pin)` +
      `desk_get_dashboard(pin)` (SECURITY DEFINER, `set search_path`,
      salted sha256 via pgcrypto, constant-time compare, history bounded
      400 rows/account); `revoke execute … from public, authenticated;
      grant execute … to anon;`. dep: B2
- [x] B4. Seed migration `003_seed.sql`: owner row (random placeholder PIN
      hash — owner rotates via SQL editor; instructions in PR body), test
      row with a session-generated test PIN (demo-grade snapshots + 260d
      equity + one brief for the test user). dep: B2
- [ ] B4a. OWNER: add that generated test PIN as the
      `TEST_AUTH_CREDENTIAL` repo secret (needed by qa-live/E1; B8 uses the
      value directly in-session, so B-phase e2e is not blocked on this).
      dep: B4
- [x] B5. `get_advisors` (security + performance) — fix every finding or
      record accepted residual. dep: B3, B4
- [x] B6. (replaced by decision — plain fetch RPC wrapper in data.js; see plan.md Stack note) Vendor `scripts/vendor/supabase.js` (pinned @supabase/supabase-js@2
      UMD build, version + integrity noted in header comment). dep: —  [P]
- [x] B7. Wire `scripts/data.js`: fill `DESK_DB` from B1; `desk_login` /
      `desk_get_dashboard` calls replace the A6 stub; map payload → render
      model (snapshots, equity, brief). dep: B3, B6, A10
- [x] B8. Live e2e vs test user: Playwright (or manual via served page)
      — wrong PIN error, correct test PIN renders test data; verify no
      real data reachable without PIN (curl RPC with bad pin). dep: B7
- [x] B9. Gates + PR "feat: Supabase PIN gate + private data path" →
      merge → live verify. dep: B8

## Phase C — data pipeline
- [x] C1. `.github/scripts/refresh/package.json` (+ committed lockfile;
      deps: fast-xml-parser only — RSS parsed with it too; node:crypto for
      hashes; no axios, use fetch). dep: —
- [x] C2. `refresh/lib/util.js`: retryFetch (backoff), notice() (guarded-
      secret convention), lastTradingDay(). dep: C1
- [x] C3. `refresh/fetch-market.js`: Stooq ^spx/^ndx/^dji/^vix + iwm.us
      (labeled proxy) + FRED DGS10 (T-1, "." rows dropped, series-date
      stamped); 30d closes; writes `data/market.json`. Fixture test
      `refresh/test/market.test.mjs` (node --test, canned CSVs). dep: C2  [P]
- [x] C4. `refresh/fetch-news.js`: general RSS (CNBC + verified second
      feed) + per-held-ticker feeds (Yahoo → Google News fallback →
      text-match degrade); chips get day % from Stooq quotes; dedupe, rank
      holdings-first, cap 20 → `data/news.json`. Fixture test. dep: C2  [P]
- [x] C5. `refresh/fetch-ibkr.js`: Flex SendRequest→GetStatement poll
      (soft-error handling per plan), as-of assertion, XML→2 account
      snapshots + equity rows; `--backfill` flag for the one-time ~1Y
      historical query (kept deliberately — ambition bar; SC4's
      disabled-timeframe fallback covers pre-backfill states). Fixture test
      with sample Flex XML. dep: C2, C6
- [x] C6. `refresh/supa.js`: service-key upserts (snapshots, equity,
      briefs) via REST; used by C5/C7. dep: C2
- [x] C7. `refresh/generate-brief.js`: grounding context → Anthropic
      (model claude-sonnet-5, structured JSON via tool/schema per
      claude-api skill), validate cited numbers ∈ snapshot, store via C6.
      Fixture test with mocked API. dep: C6
- [x] C8. `refresh/write-meta.js` + commit step logic: meta.json domains
      + statuses; `[skip ci]` commit w/ rebase-retry ×3. dep: C3, C4
- [x] C9. `.github/workflows/data-refresh.yml`: crons 22:30 + 09:30 UTC
      weekdays + workflow_dispatch (inputs: backfill bool); steps wire
      C3–C8; per-step secret guards; failure → notify-email.js. YAML
      validate + node --check all scripts. dep: C3–C8
- [x] C10. PR "feat: scheduled data pipeline" → merge; `workflow_dispatch`
      run; verify: public JSONs committed + site shows real market/news
      with EOD lamps; IBKR/Anthropic steps no-op politely without secrets.
      dep: C9
- [x] C10b. SC7 verification: dispatch a refresh with one domain forced to
      fail (temporarily point fetch-market at an invalid host via a
      workflow input used only for this test); assert the site keeps
      serving the previous `data/market.json` with its older as-of stamp
      visible, and the failure email fires. Record evidence in
      `.agent-reports/test-report.md`. dep: C10
- [ ] C11. OWNER: add secrets (IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID,
      ANTHROPIC_API_KEY, DB_SERVICE_KEY — TEST_AUTH_CREDENTIAL already done
      at B4a) + variables (DB_URL, DB_ANON_KEY); set real PIN; then
      dispatch with backfill. Blocking for live accounts only.
      dep: C10, B9

## Phase D — brief panel + polish
- [x] D1. Brief panel live wiring: render from RPC payload; missing/stale
      handling per FR-AI4 (stale date line); disclaimers + generated-at
      always visible. dep: B7, C7
- [x] D2. Polish pass vs design.md craft + research.md bar: states
      (loading/empty/error/locked), focus order, reduced-motion, copy per
      editorial rules; screenshot review desktop + iPad. dep: A10, B9, D1

## Phase E — QA + docs closeout
- [ ] E1. `app.spec.js` project scenarios S5+: demo lamps; locked→login→
      render (TEST_AUTH_CREDENTIAL from secret); wrong-PIN error; sort;
      consolidate; timeframe disable. dep: B9
- [ ] E2. CLAUDE.md: Stack confirm, Application Architecture, UI Test
      Configuration (secret NAME not value), Project-Specific Test
      Scenarios table, Security Constraints (PIN residuals, anon key,
      bot-data-commit exception, Supabase auto-pause runbook), coding
      standards (2-dp price percentages). dep: D2
- [ ] E3. Full qa-pipeline (test-verifier → ui-tester → code review →
      security review → pr-readiness); fix findings; final PR + merge +
      live verify. dep: E1, E2

## Traceability (requirement → tasks)
FR-A1..4→A1/A2/B7 · FR-C1→A2/A9 · FR-CH1..4→A2/A8/B7 · FR-M1..2→A4/C3 ·
FR-N1..3→A4/C4 · FR-AI1..4→A2(demo)/C7/D1 · FR-D1→B*/C* (no secrets client-side) ·
FR-D2→A7/C8 · FR-D3→A4/A7 · FR-D4→C9/A7 · FR-Q1..4→A3/A5/E1/D2 ·
FR-AUTH1..3→A5/A6/B3/B4/E1 · SC1-9→A9/B8/C10/C10b/E1/E3 · FR-Q3→A2 (textContent preserved; enforced at review)
