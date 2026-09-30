# Spec — Economy indicators (`desk-econ`)

> **STATUS (2026-09-30): BACKEND BUILT, NOT DEPLOYED; UI IN PROGRESS. FRED-ONLY TO BEGIN WITH (owner: "can't you just use FRED to begin with?").** `supabase/functions/desk-econ/index.ts`, `config/econ-indicators.json` and `tools/econ-check.mjs` are committed; nothing is deployed. The shipped roster names NO Treasury column, so the Treasury same-day path (§3) is **dormant** — complete and tested on fixtures, **UNVERIFIED-AGAINST-LIVE** (§9), and switched on per row by adding `"treasury": "10 Yr"` to its `sources`. Where this and `CLAUDE.md` disagree, `CLAUDE.md` is authoritative.

Requested 2026-09-30 by the owner (see `brief.md`). Slug: `economy-indicators`. This file is the contract the UI codes against (§5); the UI work is `tasks.md`; the operative summary is `docs/architecture/economy-panel.md`.

---

## 1. Indicators (the default roster)

| id | label | FRED series | Treasury column (dormant — not in the shipped roster) | transform | cadence | decimals |
|---|---|---|---|---|---|---|
| `ust2y` | 2Y Treasury | `DGS2` | `2 Yr` | level | daily | 2 |
| `ust10y` | 10Y Treasury | `DGS10` | `10 Yr` | level | daily | 2 |
| `ust20y` | 20Y Treasury | `DGS20` | `20 Yr` | level | daily | 2 |
| `unrate` | Unemployment | `UNRATE` | — | level | monthly | 1 |
| `cpi` | CPI YoY | `CPIAUCNS` | — | yoy | monthly | 1 |
| `pce` | PCE YoY | `PCEPI` | — | yoy | monthly | 1 |
| `corepce` | Core PCE YoY | `PCEPILFE` | — | yoy | monthly | 1 |

Every unit is `%`. Both PCE rows are included: headline PCE is the Fed's stated 2% target, core PCE is what it actually steers by, and the two diverge by a full point in some years — seven rows fit the panel (see `tasks.md`).

**CPI uses `CPIAUCNS` (not seasonally adjusted), not `CPIAUCSL`.** BLS computes its headline "12 months ending …" figure from the unadjusted index; the adjusted index gives a different YoY. Measured on the 2026-09-30 captures: May 4.17 (SA) vs 4.25 (NSA), Aug 3.35 vs 3.40 — at one decimal they print differently, and the desk would disagree with the number in the news. PCE's headline is computed from the adjusted index, so `PCEPI` / `PCEPILFE` stay. This is a one-line config edit if the owner prefers SA.

The roster is `config/econ-indicators.json` (§7); the same seven rows are built into the function as the fallback, and `tools/econ-check.mjs` asserts the two are identical.

## 2. Sources (keyless)

| Source | Used for | Reachable from the build sandbox | What was measured |
|---|---|---|---|
| FRED `https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES&cosd=YYYY-MM-DD` | Every row: full history (the SPINE) | **Yes** (2026-09-30) | Daily yields LAG ~1–2 business days (newest `DGS10` on 2026-09-30 was 2026-09-28). A missing observation is written as an **EMPTY field** (`2026-09-07,` on Labor Day; `2025-10-01,` — the shutdown month — for CPI and UNRATE), not the documented `.`. Both are treated as holes. |
| U.S. Treasury Daily Par Yield Curve Rates, month CSV `…/daily-treasury-rates.csv/all/YYYYMM?type=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM&page&_format=csv` | 2Y / 10Y / 20Y only: the same-day TAIL | **No** — `000` / proxy `403 CONNECT` on 4 URL variants (CSV year + month, XML month, fiscaldata API) | Nothing. Parser written against the documented layout (quoted tenor headers incl. `1.5 Month`, `MM/DD/YYYY`, newest first) and tested on CONSTRUCTED fixtures only. **UNVERIFIED-AGAINST-LIVE.** |
| Owner config `https://akyachtsman.github.io/claude.trading/config/econ-indicators.json` | The roster | n/a (Pages) | Same mechanism as `desk-charts`' `chart-watchlist.json`: 5s timeout, cached 1 hour, built-in default on failure. Until this file is published on Pages the function serves the built-in default (identical content). |

Not used: `api.bls.gov` (v2 needs a key; unreachable here), BEA (key). FRED mirrors both within minutes to an hour of their 08:30 ET releases.

Every upstream fetch carries the desk `UA` and an `AbortSignal` timeout (config 5s, FRED 8s, Treasury 5s). There is no Supabase REST call, no service key, no database and no secret.

## 3. Treasury vs FRED

**FRED-only is the default (2026-09-30).** The shipped roster and the built-in default name no Treasury column, so Treasury is never called and every row is `source:"fred"`. The yields therefore arrive with FRED's lag: FRED posts a day's 2Y/10Y/20Y about one business day later (measured 2026-09-30 ~14:00 ET: newest DGS10 was 09-28), so the row's `asOf` is what to trust. Everything below describes the OPT-IN same-day path, kept dormant until it can be checked against the live host after deploy; `econ-check` asserts that the committed roster makes zero Treasury calls.

FRED is the spine of every row. For a row that names a Treasury column, Treasury observations are appended only when **all** of these hold:

1. Treasury's file fetched and parsed (header starts `Date`, the tenor column is found **by name**, values in −5..30, no row dated after today in New York).
2. It **agrees with FRED on every date both carry** (|Δ| ≤ 0.015 — both publish 2 decimals), and at least one date is shared. A mislabelled or shifted column cannot pass this by accident; it is the guard that makes an unverified parser safe to run.
3. It has observations **strictly newer** than FRED's newest. Only those are appended, so the stitched series has no duplicate and no out-of-order date.

Otherwise the row is FRED-only — automatically, per row, every refresh. Treasury is **never served alone**: a row whose FRED spine is unavailable is `stale` (last good FRED + tail) or `missing`, even if Treasury answered.

A validated Treasury observation is kept for 72h and merged with later fetches, so a flaky Treasury does not make a yield flip back from today's print to FRED's T-2 between refreshes. After a failed Treasury fetch the function does not ask again for 10 minutes. The current and previous New York month are fetched so a month boundary never hides the tail.

Every row reports `source` (`"treasury"` when its newest observation came from Treasury, else `"fred"`) and `asOf` (that observation's date), so the UI never implies fresher data than it has.

## 4. Refresh policy — "updated as soon as that data changes"

The function sets its cache TTL from the **America/New_York wall clock** (one hoisted `Intl.DateTimeFormat`, the `NY_DATE` rule; DST handled by the timezone database) and TELLS the client when to ask again (`refreshInSec`).

| Phase | When (NY time) | Cache TTL | Why |
|---|---|---|---|
| `release` | Mon–Fri 08:25–09:15 | 60 s | BLS/BEA release at 08:30 (jobs, CPI, PCE); FRED mirrors within minutes |
| `release` | Mon–Fri 15:25–18:30 | 60 s | Treasury posts the day's par yield curve in the afternoon |
| `quiet` | any other weekday time | 15 min, **clamped so it never runs past today's next window opening** (08:20 → 5 min) | FRED's daily yield updates land at no fixed minute |
| `weekend` | Sat–Sun | 60 min heartbeat | nothing is released |
| degraded | any phase, while any row is `stale` or `missing` | ≤ 2 min | fast retry after a failure |

`refreshInSec = max(30, seconds until the cached dataset expires)`. Federal holidays are **not** excluded: nothing is released, so a holiday window costs a few extra cached fetches — cheaper than a holiday table that must be extended every year. Windows are `[from, to)`.

**`changed`** is `true` on a row when its newest observation (date and value) differs from what this function instance held at its previous refresh. It is best effort and per isolate: Supabase spreads requests over short-lived isolates, so a cold isolate legitimately says `false`, and a change can be reported by one isolate and not another. The UI's "NEW since you last looked" marker must therefore be computed client-side from `asOf` (see `tasks.md`); `changed` is a hint, not the source of truth.

## 5. Response contract

**Request:** `POST /functions/v1/desk-econ` with headers `apikey` + `Authorization: Bearer <anon key>` (what `deskPost` sends) and body

```json
{ "range": "1w" | "1m" | "3m" | "6m" | "1y" | "5y", "force": true }
```

Both optional. `range` is checked against a server-side allowlist (`Object.hasOwn`); anything else — unknown token, wrong type, `"constructor"`, a missing or unparseable body — degrades to **`"3m"`** (the `desk-watchlist` rule: an old client asking for a range this deploy does not know still gets a working panel). `force` re-fetches every series, honoured at most once per 30s per isolate. Another range is a **slice of the cached history, never an upstream call.**

**Response** (HTTP 200 whenever at least one row has data; 502 otherwise):

```jsonc
{
  "ok": true,                         // false only when EVERY row is missing
  "generatedAt": "2026-09-30T22:00:00.000Z", // this response's assembly time (per request: poller health)
  "fetchedAt": "2026-09-30T22:00:00.000Z",   // when the function last pulled upstream
  "range": "1w",                      // the range actually served (after validation) — drop a reply whose range != what you asked
  "refreshInSec": 60,                 // ask again in this many seconds (>= 30)
  "phase": "release",                 // "release" | "quiet" | "weekend"
  "stale": false,                     // true if any row is stale
  "staleSec": null,                   // age in s of the oldest stale row's data, else null
  "roster": { "source": "default", "count": 7, "dropped": 0 }, // "config" | "default"; dropped = rows the validator refused
  "rows": [
    {
      "id": "ust2y", "label": "2Y Treasury", "unit": "%", "decimals": 2,
      "transform": "level",           // "level" | "yoy" | "mom"
      "cadence": "daily",             // "daily" | "weekly" | "monthly" | "quarterly"
      "value": 4.9,                   // newest observation, rounded to `decimals`; null if unknown (NEVER 0 for unknown)
      "prev": 4.95,                   // the observation before it; null if none
      "delta": -0.05,                 // value - prev in the row's unit (percentage points), rounded; null if either is null
      "asOf": "2026-09-30",           // the date the newest observation is FOR (a monthly row: the 1st of that month)
      "prevAsOf": "2026-09-29",
      "source": "treasury",           // "treasury" | "fred"; null when missing
      "status": "ok",                 // "ok" | "stale" | "missing"
      "changed": false,               // best effort, per isolate (§4)
      "staleSec": null,               // seconds since this row's data was fetched, when stale; else null
      "points": [["2026-09-23", 4.85], ["2026-09-24", 4.87], ["2026-09-25", 4.81],
                 ["2026-09-28", 4.92], ["2026-09-29", 4.95], ["2026-09-30", 4.9]]
    },
    {
      "id": "cpi", "label": "CPI YoY", "unit": "%", "decimals": 1, "transform": "yoy", "cadence": "monthly",
      "value": 3.4, "prev": 3.4, "delta": 0, "asOf": "2026-08-01", "prevAsOf": "2026-07-01",
      "source": "fred", "status": "ok", "changed": false, "staleSec": null,
      "points": [["2026-03-01", 3.2564], ["2026-04-01", 3.8108], ["2026-05-01", 4.2487],
                 ["2026-06-01", 3.5314], ["2026-07-01", 3.3648], ["2026-08-01", 3.3965]],
      "pointsNote": "monthly - 6 latest"   // present ONLY when the span held < 6 observations (§6)
    }
  ],
  "error": "…"                        // present only when ok is false
}
```

(The example is a real render of the committed function on the fixtures at 2026-09-30 18:00 ET, `range:"1w"`, trimmed to two rows; the 09-29/09-30 yields in the fixture are synthetic.)

Row rules:
- `value`, `prev`, `delta` are numbers or `null` — never `NaN`, never `0` for unknown. `delta: 0` is a real zero (two equal rounded observations).
- Units are already applied: a `yoy` row's values and points are **percent change on the year**, computed **point by point** (each point against the observation exactly 12 months earlier), so the CPI chart is a YoY line, not the index. A missing base month (2025-10) yields no point — nothing is interpolated.
- `points` is the selected span, **oldest first**, at most **120** points, every one a real observation (values rounded to 4 decimals). Longer spans are thinned by keeping the first and last point plus the minimum and maximum of each of 59 equal buckets, so spikes survive. The span is measured back from the row's **own** newest observation (start inclusive), so a lagging series still fills its window. Treasury's tail is already stitched in.
- `status: "missing"` ⇒ `value/prev/delta/asOf/prevAsOf/source` null, `points: []`.
- Response sizes on the fixtures: 3.0 KB (1W) to 14.3 KB (5Y).

Other HTTP answers, all JSON with the CORS headers: `403 {ok:false,error:"forbidden origin"}` for a non-allowlisted `Origin` (including none), `405` for anything but POST/OPTIONS, `200 "ok"` for OPTIONS, `502 {ok:false,error}` on an unhandled throw with nothing cached.

## 6. Granularity policy (for the owner, in plain words)

The owner asked for "one day, week, month, etc." selectors. The finest data that **exists** for these numbers is:

- **one reading per business day** for Treasury yields, and
- **one reading per month** for unemployment, CPI and PCE (published about two weeks after the month ends).

There is no intraday or "today" series for any of them — a yield is fixed once a day, an inflation rate once a month. So the span choices are **1W 1M 3M 6M 1Y 5Y** for every row, and there is no 1D: a one-day chart would be a single dot.

When a span holds **fewer than 6 readings** — every monthly row on 1W, 1M and 3M, or a yield on a holiday week — the row shows **its 6 latest readings instead** and the payload says so (`pointsNote: "monthly - 6 latest"`), so the panel can label it rather than draw a two-point line or a misleading flat one. A row with fewer than 2 readings in total draws no chart. 1W of yields normally holds 6 readings (start inclusive), so it draws its real week.

## 7. Roster file (`config/econ-indicators.json`)

A **bare JSON array** of row objects (like `chart-watchlist.json` it can carry no `_note`):

```json
{ "id": "ust10y", "label": "10Y Treasury",
  "sources": { "fred": "DGS10", "treasury": "10 Yr" },
  "unit": "%", "transform": "level", "cadence": "daily", "decimals": 2 }
```

The function never trusts it. A row is **dropped** (and counted in `roster.dropped`) unless: `id` matches `^[a-z0-9][a-z0-9_-]{0,23}$`; `label` is 1–12 characters; `sources.fred` (upper-cased) matches `^[A-Z0-9_]{1,30}$` — it reaches an upstream URL, encoded; `transform` is `level|yoy|mom` (default `level`); `cadence` is `daily|weekly|monthly|quarterly`; `decimals` is an integer 0–4 (default 2); `mom` only on `monthly`; `sources.treasury`, if present, is a known tenor column **and** the row is `daily` + `level`; a `level` row's `unit` matches `^[%$A-Za-z]{0,4}$` (a `yoy`/`mom` row's unit is always `%`). Duplicates by `id` keep the first; the list is **capped at 12**. An array with no valid row, a non-array, or an unreachable file falls back to the last good config this instance held, else the built-in default. Edits land within the hour (`CONFIG_TTL_MS`).

## 8. Failure semantics

| Situation | Result |
|---|---|
| One FRED series fails (HTTP error, timeout, HTML page, 0 rows) with no earlier copy in this isolate | That row `missing`, all other rows unaffected, HTTP 200 |
| One FRED series fails, an earlier copy exists | That row `stale` with its last good values, chart and `staleSec`; top-level `stale:true` |
| Treasury fails, is garbage, or disagrees with FRED | The three yields fall back to FRED (`source:"fred"`), `status` stays `ok`; Treasury not retried for 10 min |
| Treasury fails after a validated print was kept (≤ 72h) | The kept print stays — no flip back to T-2 |
| Every series fails, cold isolate | HTTP 502 `{ok:false, error, rows:[…all missing…]}` — the client lamps STALE and keeps its last good render |
| The refresh throws part-way (a bug) with a previous dataset | HTTP 200, the previous dataset, every row `stale`, `refreshInSec` 120 |
| Any row degraded | `refreshInSec` ≤ 120 even in a quiet period |

## 9. What is UNVERIFIED

- **The whole Treasury path against the live host.** URL shape, header names, date format and the absence of a bot wall were taken from Treasury's documented format; `home.treasury.gov` was unreachable from the build sandbox. The FRED agreement check makes a wrong guess fail safe (the yields stay FRED, one day behind) rather than fail wrong. First live smoke test: call `desk-econ` inside 15:25–18:30 ET and check whether `ust10y.source` reads `"treasury"`; if it never does, read the function logs for `desk-econ: Treasury` / `treasury disagrees` lines.
- **That FRED's `DGS*` equal Treasury's par-curve values.** FRED's constant-maturity series come from the Fed's H.15, which takes Treasury's par yield curve, so shared dates are expected to match to the basis point (the agreement check allows 1bp). If they systematically differed, the check would reject every tail and the yields would silently stay on FRED, one day behind — safe, but the same-day feature would be dead; the smoke test above detects it.
- **Treasury's posting time.** The 15:25–18:30 window is the brief's; the exact time Treasury posts on a given day was not measured.
- **FRED's mirror latency** after an 08:30 release (believed minutes to an hour; not measured here).
- **Deno execution.** There is no Deno in the sandbox: the function was syntax-checked by esbuild and executed in Node (`vm`) under stubs. `Deno.serve`, `AbortSignal.timeout` and Deno's `fetch` were not run.
- **`verify_jwt` ON with the publishable key.** `desk-maps` / `desk-heatmap` / `desk-watchlist` are ON and serve the browser today with the same `deskPost` headers, which is the evidence; confirm with the first smoke test.

## 10. Checks

`node tools/econ-check.mjs` — 24 checks on real FRED captures and constructed Treasury fixtures, each in a fresh `vm` context (a cold isolate) with a stubbed `fetch` and a settable clock. `node tools/econ-check.mjs --mutants` additionally applies 27 single-line mutants of the source (e.g. `"."` read as 0, the `Number("")` trap, YoY off by one month, FRED preferred over a newer Treasury print, a fixed EST offset, NaN leaking from `N/A`, single-flight removed, prototype keys admitted as ranges) and requires every one to be caught; 27/27 were caught on 2026-09-30.
