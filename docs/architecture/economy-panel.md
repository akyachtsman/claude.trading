# Economy panel and `desk-econ`

The Economy indicators feed (`supabase/functions/desk-econ`, `config/econ-indicators.json`, `tools/econ-check.mjs`): sources, refresh policy, contract and limits. Owner request 2026-09-30; full contract in `specs/economy-indicators/spec.md`. Backend built 2026-09-30, **not deployed**; the panel UI is `specs/economy-indicators/tasks.md`.

- **What it serves.** Seven rows by default — 2Y / 10Y / 20Y Treasury, Unemployment,
  CPI YoY, PCE YoY, Core PCE YoY — each with `value`, `prev`, `delta`, `asOf`,
  `source`, `status` and a `points` chart series for the requested span
  (`1w 1m 3m 6m 1y 5y`; anything else degrades to `3m`). One anon-callable POST,
  same family as `desk-market` / `desk-maps`: session-aware module cache +
  single-flight, every upstream fetch bounded by an `AbortSignal`, always JSON.
  CORS is the **quote-proxy Origin allowlist** (site origin only; no Origin = 403)
  rather than the `*` the other five feeds use — a browser-enforced speed-bump.
- **Sources, keyless — FRED ONLY TO BEGIN WITH** (owner 2026-09-30). FRED `fredgraph.csv` is the SPINE of every row (verified
  reachable 2026-09-30; lags daily yields 1–2 business days: read the row's `asOf`).
  The shipped roster and the built-in default name no Treasury column, so
  Treasury is never called (`econ-check` asserts zero calls) and every row is
  `source:"fred"`. The U.S. Treasury daily par-yield CSV is an OPT-IN same-day
  TAIL for the three yields (add `"treasury": "10 Yr"` to a row's `sources`),
  dormant until it can be checked against the live host, and
  **UNVERIFIED-AGAINST-LIVE** — `home.treasury.gov` was unreachable from the build
  sandbox, so its parser was written from the documented layout and tested on
  constructed fixtures. It is used only when (1) it parses, (2) it AGREES with
  FRED on every shared date (|Δ| ≤ 0.015) with at least one shared date, and (3)
  it is strictly NEWER than FRED; otherwise the row is FRED-only, automatically.
  It is never served alone (no FRED spine = `stale` or `missing`), a validated
  print is kept 72h so a flaky host cannot flip a yield back to T-2, and a failed
  fetch backs off 10 min. Columns are looked up BY NAME (Treasury inserted
  `1.5 Month` in 2025, shifting every later column).
- **FRED holes are holes.** The documented missing marker is `.`, but MEASURED
  2026-09-30 the endpoint writes an EMPTY field (`2026-09-07,` Labor Day;
  `2025-10-01,` the shutdown month for CPI and UNRATE). `Number('')` is `0`, so
  both markers are caught before `Number()`. (`desk-market`'s own `parseFred` does
  not do this: run on the same capture it yields 0.00 for 2026-07-03 and
  2026-09-07, which puts zeros in the 10Y tile's sparkline — reported, not fixed
  here.)
- **Transforms.** `yoy` / `mom` are computed POINT BY POINT against the observation
  exactly 12 (or 1) months earlier; a missing base month gives no point, never an
  interpolated one. CPI uses `CPIAUCNS` (the BLS headline basis — the adjusted
  index prints a different YoY in some months); PCE uses `PCEPI` / `PCEPILFE`.
- **History once, spans as slices.** ~76 months of each series (5y display + the
  YoY base + publication lag) is fetched per refresh and every `range` is a slice:
  measured back from the row's own newest observation, start inclusive, oldest
  first, ≤120 points (first/last + min/max of 59 buckets — every point real). A
  span with fewer than 6 observations returns the 6 latest and sets
  `pointsNote` (`"monthly - 6 latest"`); fewer than 2 in total → `points: []`.
  There is no 1D: the finest data that exists is one reading per business day
  (yields) or per month (jobs, inflation).
- **Refresh policy — "as soon as the data changes".** From the America/New_York
  wall clock (ONE hoisted formatter, `NY_CLOCK` — the `NY_DATE` rule): 60 s inside
  Mon–Fri 08:25–09:15 (BLS/BEA 08:30) and 15:25–18:30 (Treasury), 15 min on a
  quiet weekday but never past today's next window opening, a 60 min heartbeat at
  weekends, ≤2 min while any row is degraded. The client is told when to ask
  again (`refreshInSec`, ≥30). Holidays are not excluded (cheaper than a table).
- **Failure semantics.** One failed series degrades its own row only: `stale`
  with its last good values and `staleSec` if this isolate held a copy, else
  `missing` with every value `null` (never 0). Every series down on a cold isolate
  → 502 `{ok:false}` (the client keeps its last good render). A refresh that
  throws with a previous dataset → 200, every row `stale`. `changed` is
  per-isolate best effort (a cold isolate says `false`); the UI's NEW marker is
  client-side from `asOf`.
- **Roster.** `config/econ-indicators.json` is a bare JSON array of row objects,
  read from Pages at runtime (5s timeout, cached 1 hour, built-in identical default
  on failure — `econ-check` asserts the two match). Validated, never trusted: bad
  rows dropped and counted (`roster.dropped`), deduped by `id`, capped at 12, the
  FRED id strictly patterned before it reaches a URL, Treasury only on a
  daily-level row.
- **Checks.** `node tools/econ-check.mjs` (24 checks, fresh `vm` isolate each,
  stubbed `fetch`, settable clock, real FRED captures + constructed Treasury
  fixtures under `tools/fixtures/econ/`); `--mutants` proves 27 single-line
  mutants are each caught (27/27 on 2026-09-30).
- **Deploying.** Deployed 2026-09-30 (owner-approved, project
  `kwugzhyfjevzwgplhtsd`, version 1, `verify_jwt` **ON**, like `desk-maps` /
  `desk-heatmap` / `desk-watchlist`, which serve the browser's `deskPost` headers).
  Smoke test after deploy, anon key + `Origin: https://akyachtsman.github.io`:
  POST `{range:'3m'}` 200 with 7 rows, all `source:"fred"` (zero Treasury calls);
  `{range:'bogus'}` and a non-JSON body degrade to `3m`; `1w`/`1y`/`5y` slice the cached
  history; no Origin and a foreign Origin 403; GET 405; OPTIONS 200 with the allowlisted
  `Access-Control-Allow-Origin`; no `Authorization` header 401 (the `verify_jwt` gate).
  Values agreed with direct FRED pulls (10Y 5.24 on 2026-09-28; CPI YoY 3.397 against
  the 3.4 served). Logs read clean (no 5xx). Until `config/econ-indicators.json` is on
  Pages (first merge to `main`) the function reports `roster.source:"default"` — the
  built-in roster is identical, so the rows are the same.
  The repo spells the BOM strip `/^\uFEFF/`; the payload sent used the same escape, and
  the read-back may show the literal character instead — the same regex either way.
