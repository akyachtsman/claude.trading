# Edge feeds, heatmap universes and quote-proxy

The anon-callable feed functions (`desk-market`, `desk-news`, `desk-heatmap`, `desk-charts`, `desk-maps`) and `quote-proxy`, including the hoisted-formatter fix for the 546s (`supabase/functions/`; scenarios S13, S14).

- `supabase/functions/` — versioned sources of the edge-function data layer
  (deployed only to the dedicated project). Anon-callable public feeds:
  `desk-market` (Stooq→Yahoo tiles + FRED 10Y for the core 6, plus
  Bitcoin/Gold/US Dollar as **best-effort** extras — a flaky extra drops only
  its tile, never gating the core; owner request 2026-07-16), `desk-heatmap` (Nasdaq
  screener→Yahoo), `desk-charts` (watchlist OHLC), `desk-news`
  (holdings-first RSS), `desk-maps` (Crypto/Futures/World cuts) — all
  session-aware cached + single-flight.
  **`desk-news` takes an owner-typed `topic`** (the box above the News panel,
  owner request 2026-08-14), and **a topic REPLACES THE WHOLE SWEEP** — general
  wire AND the per-ticker holdings lookups — rather than only the general feeds.
  The first cut kept the holdings lookups running, reasoning that dropping news
  about a position was the worse surprise; the owner's report (2026-08-17,
  typed one held ticker and saw three headlines for another above it) settled it the other way,
  because those rows are ranked holdings-first and so land at the TOP, leaving
  the panel not showing what its own box says it shows. Held tickers are still
  read, but only to CHIP a row that names one — `dedupeRank`'s `heldFirst` is
  false under a topic, so ordering is pure recency. Two things follow. A topic
  that matches nothing is a **successful empty result**, not a thrown error:
  throwing lamps the panel STALE and keeps the last good render, which would
  leave the PREVIOUS topic's headlines sitting under the new topic's name. And
  the empty state names the topic, read from the payload's echoed `topic`
  (`DESK.data.newsTopic`) rather than the input box, which holds what is being
  typed now. The topic is sanitised server-side (`cleanTopic`, 60 chars,
  bounded character set) before it reaches an upstream URL, and cache +
  single-flight are keyed by it, capped at 8 slots.
  **`desk-heatmap` serves THREE universes** — `sp500` (default), `r2k`, and
  **`etf`** (added 2026-08-06). The ETF cut used to be assembled CLIENT-side by
  `buildEtfHeatmap()` out of the `desk-charts` payload, which meant an ETF got a
  tile only if the charts workbench happened to carry its 800-bar OHLCV series.
  It did not for 15 of the banded names, so the map drew **25 of 40** for its
  whole life — 20 in their proper bands plus 5 (KRE TLH UUP FXI INDA) swept into
  a catch-all `'ETFs'` bucket by `cats[sym] || 'ETFs'`, which is what kept the
  mismatch invisible. Re-sourcing it is a ~**800× data reduction**: the panel
  needs about six numbers per tile, which cost ~36 KB/name off the charts
  payload and ~46 bytes/name off the period sweep. Four things are load-bearing:
  the roster IS its grouping (`map-filters.json` → `etfCats`, read by BOTH
  sides), so a symbol can never be charted without a band or banded without
  being charted — the drift that caused this; tiles are sized by **dollar
  volume** (`last × averageDailyVolume3Month`, added to the shared `quoteBatch`
  fields) because an ETF has no market cap, and a missing volume falls to an
  area floor rather than dropping the tile; the five orphans were **added to
  `etfCats`** rather than let vanish (a strict rebuild would have shown 35 and
  silently lost 5 the owner could see — `UUP` in *Commodities* is the one
  judgement call, the rest are unambiguous); and the cut **lost its free pass on
  the period dropdown** — it used to compute 1W/1M/YTD from chart bars so could
  always answer, and now reads them off the shared sweep like every other cut,
  so it must be gated on `datasetHasPeriods` or picking 1M paints an empty map.
  40 names is one quote batch and one sweep nudge (160), so unlike the stock
  universes this one converges on its first call. The screener is NOT a fallback
  here (it lists common stocks, not funds); a crumb failure degrades to the 5-day
  spark, losing only the weighting, so every tile hits the floor together and the
  map stays readable.
  **r2k day-% is overlaid from Yahoo v7/quote exactly like sp500** (audit
  2026-09-29): the screener's raw pct is a session behind, and tiles that kept it
  beside merged ones mixed two vintages on one map. The overlay runs in 4 bounded
  lanes under its own 20s deadline (the sp500 spark fallback 25s), and `source`
  says `+yahoo-quote` only at ≥95% merged, else "day% may lag". Every upstream fetch
  in the three map functions is bounded by an `AbortSignal` (crumb 4s, screener
  10s, the rest 5s), and `readSweepRow` THROWS on a failed ledger read — `null`
  means "no row" — because a failed read used to look like an empty ledger and one
  nudge overwrote a full one.
  **`desk-charts` formats bar dates with ONE HOISTED `Intl.DateTimeFormat`**
  (`NY_DATE`) — this is the fix for the 546s (owner report 2026-08-05, charts
  panel blank on 20–50% of loads). `parseYahooChartOHLC` had called
  `toLocaleDateString('en-CA', {timeZone})` once per bar, which builds and
  discards an ICU formatter EVERY call; a cold sweep is 25 symbols × ~1250 bars
  of Yahoo's 5y daily range ≈ **31,000 calls, measured at 2611 ms of pure CPU**,
  which is the worker's whole budget — hence `WORKER_RESOURCE_LIMIT` with no
  upstream fault at all. Reusing one formatter is **2611 ms → 50 ms (52×)** for
  byte-identical output (verified over 33,334 timestamps spanning 2000–2026, so
  every DST transition; measured live, 10/20 failures → **0/50**, and latency
  2.19–3.63 s → 0.43–1.84 s). It must stay timezone-aware rather than become UTC
  string math, or half-days and DST land on the wrong session date. The bar-date
  guard beside it is load-bearing: the two date paths DISAGREE on a malformed
  timestamp — `toLocaleDateString` returns the string `"Invalid Date"` while
  `Intl…format` THROWS `RangeError` — so without it one bad row would fail the
  whole symbol into the (currently always-missing) Stooq fallback; the bar is
  skipped, never the symbol. **A prior 546 diagnosis here was WRONG and is
  recorded in-file so it is not retried:** per-request `JSON.stringify` of the
  ~934 KB payload was blamed and pre-serializing each symbol shipped as v9 —
  measured, it did not move the failure rate at all. The misread was that a
  `force:true` sweep survived where cache hits died; timing them head to head
  showed a cached call cost the SAME as a forced full sweep, which only makes
  sense because `seriesCache` is per-isolate module state and Supabase spreads
  requests across short-lived isolates, so nearly every request was already
  sweeping. The pre-serialization is kept on its own merits (the request path is
  a string join, and the parsed object is dropped from memory) but is NOT the
  fix. Because that path concatenates, the roster is **deduped** in
  `loadWatchlist`: a repeated ticker would emit the same JSON key twice, and
  `got` counts both where a parsed object keeps one — inflating `count`, letting
  the `MIN_COVERAGE` floor pass on fewer real series than it claims, and
  fetching the symbol twice per sweep. `generatedAt` is still rebuilt per
  request: `liveLampFor` measures poller health against it, so a memoized one
  (up to `HISTORY_TTL_MS` old) would lamp the panel STALE mid-session on a
  healthy feed.
  **`desk-heatmap` carried the SAME per-bar formatter and was fixed the same
  day** (`NY_DATE` there too). It was the worse of the two: one sweep nudge is
  `SWEEP_STEP_BATCHES`×20 = 160 symbols × ~250 bars of the 1y daily spark ≈
  **40,000 calls, 3778 ms of CPU → 80 ms (47×)**. The number that matters is
  that 3778 ms exceeded **`SWEEP_BUDGET_MS` (2500)**: that budget bounds the
  fetch DEADLINE, and the formatting runs after each batch resolves, so no
  wall-clock bound could ever contain it — which is why the PR #221 hardening
  (deadline on the fetch, persist partial progress) reduced the damage from
  being killed without stopping the kills. The sweep was being killed by its
  own date parsing. Its bar-date guard is load-bearing for a sharper reason
  than the charts one: a `RangeError` escapes `periodSweep` into
  `advanceSweep`'s `.catch(() => {})`, discarding the whole nudge before
  `writeSweepRow` — re-entering the exact ledger loss `SWEEP_BUDGET_MS` exists
  to prevent, through a different door. The per-request date/clock formatters in
  `desk-market` (34×), `desk-maps`, `desk-heatmap`, `desk-ibkr-sync` and
  `desk-cron-ask` are hoisted the same way (audit 2026-09-29; byte-identical over
  >1M instants incl. every DST day), and a malformed bar timestamp is skipped, never
  rendered as `Invalid Date`. PIN-gated: `desk-ask` — an **agentic**
  Origin-guarded anon: `quote-proxy` (OHLC for any ticker — no PIN, restricted
  to the site origin + in-memory cache; owner ruling 2026-07-14, paid plan).
  `kind:'info'` also returns a per-symbol live-quote line (last / day change /
  bid / ask) plus fundamentals (next earnings date + market cap / P/E /
  52-week range / dividend yield) from Yahoo v7/quote via a cached cookie+crumb
  handshake — powers the charts panel's quote readout + fundamentals strip
  (bid/ask are market-hours-only; Yahoo returns 0 when closed). It always
  answers JSON with the Origin-allowlist CORS headers (a throw used to surface as a
  bare 500 the browser reports as a CORS error); a miss (404/empty) is cached ≤30s so
  a transient Yahoo failure cannot pin a symbol as "not found" for a full TTL; the
  cache is bounded at 500 keys (the ticker is arbitrary); upstream calls carry 8s
  timeouts.
  **Extended hours (owner ruling 2026-07-29):** `kind:'intraday'` accepts
  `prepost:true`, widening the fetch to the 4:00am–8:00pm ET session; the
  `prepost` flag is part of the cache key (two different bar sets, never
  interchangeable). EVERY intraday bar carries `x` — 0 regular, 1 pre/post —
  classified from Yahoo's own per-day `meta.tradingPeriods.regular`, so the
  split survives DST and half-days without hardcoded UTC hours. Two measured
  properties of the extended feed drive the handling: Yahoo reports **no volume
  at all** outside the session (1141 of 1142 sampled bars were volume 0 — the
  Pro 3 volume strip is legitimately empty under the shaded band, not broken),
  and a few percent of pre/post bars carry **phantom wicks** — a high/low tens
  of dollars off their own open/close on zero volume (QQQ 2026-07-28 16:50: low
  647.43 against a 676.25 close, 7.2% off). Bodies are sound, so extended bars
  ONLY are de-spiked by clamping the wick to 1% outside open/close
  (`EXT_WICK_TOL`); regular bars are never touched (0 of 780 sampled exceeded
  that bound). **Indices have no extended session at all** — `^IXIC`/`^GSPC`
  report `hasPrePostMarketData:false` and simply repeat their close (^GSPC held
  7428.78 flat from 16:00 to 17:10), which is why the Markets index tiles stay
  at-close and the Markets chart keeps fetching regular-session only.

## Deploying (added 2026-09-30, after the audit deploy)

The edge functions are single-file (`supabase/functions/<name>/index.ts`, no shared module) and
deploy through the Supabase MCP `deploy_edge_function`, one call per function, with the file
content passed whole. There is no Deno here, so nothing is type-checked locally.

What made the 2026-09-30 deploy safe, and should be repeated:

1. **Read the live state first.** `list_edge_functions` gives each function's `verify_jwt`
   and version; `get_edge_function` gives the live source. Diff the live source against the
   repo commit you believe is deployed BEFORE overwriting it (on 2026-09-30 `desk-heatmap`
   was byte-identical to the pre-audit repo, which proved the deploy delta was exactly the
   reviewed diff).
2. **Preserve `verify_jwt`.** ON: `desk-maps`, `desk-heatmap`, `desk-watchlist`,
   `desk-ibkr-sync`, `desk-cron-ask`. OFF: `desk-ask`, `quote-proxy`, `desk-market`,
   `desk-charts`, `desk-news`. The tool defaults to ON; deploying an OFF function without
   passing `false` would 401 every browser call.
3. **Syntax-check the source** (`esbuild --loader=ts < index.ts` parses it), **then verify what
   was actually sent**: compile the repo file and the deployed payload with `esbuild --minify`
   and compare — comments are stripped, so any transcription slip in code shows up. Do this
   for every function; a one-character typo in a 56 KB file otherwise ships silently.
4. **Deploy public feeds first, smoke-test each, PIN/cron functions last.** Public feeds can be
   called with the anon key and the site `Origin`; the cron-secret and PIN functions can only
   be boot-tested (401 without the secret, 405 on GET, 400/401 on `desk-ask`) — their real
   runs are the first live exercise.
5. **Read the logs afterwards** (`query_logs`, source `function_edge_logs`, group by
   `request.pathname`): no 5xx, and every 4xx should be one of your own guard tests.

Rollback: redeploy the file from the last known-good commit (`dd7cf5f` for the audit deploy)
with the same `verify_jwt`. Migrations are separate and are never part of a function deploy.

### `desk-market` v17 — 2026-10-07 (owner-approved; the procedure above, followed)

`parseFred`'s empty-field rule (PR #309: FRED writes a holiday as `.` or, in the current CSV, an EMPTY field,
and `Number('')` is 0 — a 0.00 yield on the 10Y tile) had been merged to `main` for two days with the function
NOT deployed. Deployed from `e1307e0`, `verify_jwt` OFF (read from `list_edge_functions` first: version 16, OFF),
version 16 → 17. Live v16 was read back first: its `parseFred` lacked the empty-field test and the rest matched the repo
file as of `c748851^` by eye (not byte-compared), so the intended delta was the three-line `parseFred` change.

What was checked, and what was NOT: the deployed source READ BACK from Supabase, minified with the pinned
`tools/` esbuild beside the repo file, is byte-identical (9,535 bytes each, comments stripped — step 3 above,
done against what Supabase actually stores rather than against the payload that was sent). A live call (anon,
site `Origin`) answered 200 in ~1.2s with `ok: true`, `generatedAt` seconds old (a cold v17 instance), 33 tiles,
the US 10Y tile present and no zero or negative `last`. The logs were not yet showing v17 requests when read
(the log stream lags a few minutes), so the version served is evidenced by the smoke call's fresh `generatedAt`,
not by a log row. Rollback = redeploy `supabase/functions/desk-market/index.ts` as of `c748851^` with
`verify_jwt` OFF.
