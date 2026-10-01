# Spec — Economy indicators (`desk-econ`)

> **STATUS (2026-09-30): BACKEND DEPLOYED (v1, `verify_jwt` ON) AND UI BUILT (S55). TREASURY SAME-DAY RATE ON FOR THE THREE YIELDS (owner request, later the same day: current 2Y/10Y yields).** `supabase/functions/desk-econ/index.ts`, `config/econ-indicators.json` and `tools/econ-check.mjs` are committed and `desk-econ` is live (owner-approved deploy, 2026-09-30). The shipped roster and the built-in default now name the `2 Yr` / `10 Yr` / `20 Yr` Treasury columns, so the Treasury path (§3) is ON — a silent fallback to FRED whenever it fails. **2026-10-01:** measured from Supabase's servers, Treasury's file has exactly the layout the parser expects and FRED's values, but answers in 17–20 s (§2, §9), and every desk-econ request runs on a FRESH instance (calls 4 s apart each had their own `generatedAt`), so v1 — which attempted Treasury inline with a 5 s limit on every request — added ~4–5 s to every reply and still ended FRED-only. v3 keeps Treasury's validated rows in the SHARED table `desk_feed_cache` (§3): every request reads them; at most one request per interval takes a lease and does the ~20 s fetch, awaited, in its own reply. **v3 was DEPLOYED 2026-10-01** on the owner's approval (Supabase version 2, `verify_jwt` ON, from `c06888a`; no migration: the table existed) and verified live — the first request 20.7 s, the three yield rows `source:"treasury"` as of 2026-09-30, the next request 0.94 s from the stored row. *(A per-instance background design, v2, was written and dropped the same day once the fresh-instance measurement came in.)* *Superseded: "FRED-ONLY TO BEGIN WITH" (owner: "can't you just use FRED to begin with?"), under which the roster named no Treasury column.* Where this and `CLAUDE.md` disagree, `CLAUDE.md` is authoritative.

> **2026-10-01 (owner request: "close to real time" yields): THE 10Y IS LIVE** — a client-side overlay of Yahoo's `^TNX` on the `ust10y` row through the existing `quote-proxy`; no `desk-econ` change, no deploy (§11, S56). The 2Y and 20Y have no free live source.

Requested 2026-09-30 by the owner (see `brief.md`). Slug: `economy-indicators`. This file is the contract the UI codes against (§5); the UI work is `tasks.md`; the operative summary is `docs/architecture/economy-panel.md`.

---

## 1. Indicators (the default roster)

| id | label | FRED series | Treasury column (in the shipped roster since 2026-09-30) | transform | cadence | decimals |
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
| U.S. Treasury Daily Par Yield Curve Rates, month CSV `…/daily-treasury-rates.csv/all/YYYYMM?type=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM&page&_format=csv` | 2Y / 10Y / 20Y only: the same-day TAIL | **No** — `000` / proxy `403 CONNECT` on 4 URL variants (CSV year + month, XML month, fiscaldata API). **From Supabase: yes, slowly** (2026-10-01, the throwaway `desk-probe`) | From the build sandbox, nothing. From Supabase (3 runs): month CSV, year CSV and XML feed all HTTP 200 `text/csv` in **17.1–19.2 s, one month-CSV run past 20 s**, regardless of size (1.8 / 15 / 33 KB) — throttled, not blocked. The real header and rows match the parser (quoted tenor headers incl. `1.5 Month`, `MM/DD/YYYY`, newest first, 2 decimals; captured in `tools/fixtures/econ/treasury-real-20260930-head.csv`), and equal FRED on shared dates. |
| Owner config `https://akyachtsman.github.io/claude.trading/config/econ-indicators.json` | The roster | n/a (Pages) | Same mechanism as `desk-charts`' `chart-watchlist.json`: 5s timeout, cached 1 hour, built-in default on failure. Until this file is published on Pages the function serves the built-in default (identical content). |

Not used: `api.bls.gov` (v2 needs a key; unreachable here), BEA (key). FRED mirrors both within minutes to an hour of their 08:30 ET releases. Live intraday yields, measured from Supabase 2026-10-01: CNBC's quote API answers 403 "Access Denied" (Akamai) and Stooq's `2yusy.b` / `10yusy.b` time out at 20 s — both dead; Yahoo `^TNX` (the CBOE 10-year yield index) answers 200 in ~85–110 ms with a live quote — a candidate for a future live 10Y, not used.

Every upstream fetch carries the desk `UA` and an `AbortSignal` timeout (config 5s, FRED 8s, Treasury **45s** in v3 — 5s in v1, which always timed out). v3 also makes Supabase REST calls to `desk_feed_cache` (3s timeout) with the service key (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the function env) and NO user-agent — the key is held solely for that table's `econ:treasury` row (public yield observations), exactly as `desk-heatmap` / `desk-news` hold it. No other database use and no other secret.

## 3. Treasury vs FRED

**The Treasury tail is ON for the three yields (2026-09-30, owner request: current 2Y and 10Y yields; 20Y comes from the same file and is included so no yield in the table sits a day behind its neighbours).** The shipped roster and the built-in default are identical and name exactly the `2 Yr` / `10 Yr` / `20 Yr` columns; `econ-check` asserts both, and that a first sweep makes 7 FRED + 2 Treasury (current and previous NY month) + 1 config fetch. Without Treasury the yields arrive with FRED's lag — FRED posts a day's 2Y/10Y/20Y about one business day later (measured 2026-09-30 ~14:00 ET: newest DGS10 was 09-28). Treasury's par-yield file is a **daily rate — a snapshot of bid-side quotes taken at about 3:30 pm ET, posted about 15:30–18:00 ET**: same day after the snapshot, **never intraday**, and on a volatile afternoon it can differ from the actual closing yield (Codex, PR #295). Before it posts, a yield row shows the previous business day's rate (Treasury's — FRED often carries that day only after its own afternoon update); after, today's. The row's `asOf` is always what to trust. *Superseded: "FRED-only is the default (2026-09-30)", under which the roster named no Treasury column, Treasury was never called and `econ-check` asserted zero Treasury calls; that path still exists for a roster whose rows name no column, and is still tested.*

FRED is the spine of every row. For a row that names a Treasury column, Treasury observations are appended only when **all** of these hold:

1. Treasury's file fetched and parsed (header starts `Date`, the tenor column is found **by name**, values in −5..30, no row dated after today in New York).
2. It **agrees with FRED on every date both carry** (|Δ| ≤ 0.015 — both publish 2 decimals), and at least one date is shared. A mislabelled or shifted column cannot pass this by accident; it is the guard that keeps a future layout change at Treasury harmless (the parser has now been checked against one real capture, 2026-10-01 — not against every future file).
3. It has observations **strictly newer** than FRED's newest. Only those are appended, so the stitched series has no duplicate and no out-of-order date.

Otherwise the row is FRED-only — automatically, per row, every refresh. Treasury is **never served alone**: a row whose FRED spine is unavailable is `stale` (last good FRED + tail) or `missing`, even if Treasury answered.

A validated Treasury observation is kept for 72h (from the row's last merge, `mergedAt`) and merged with later fetches, so a flaky Treasury does not make a yield flip back from today's print to FRED's T-2 between refreshes — on every instance, since v3 keeps it in the shared store. After a failed Treasury attempt no instance asks again for 10 minutes (`failedAt` in the store). The current and previous New York month are fetched so a month boundary never hides the tail.

**A shared store refreshed under a lease (v3, 2026-10-01 — deployed the same day, owner-approved).** Measured 2026-10-01: every desk-econ request runs on a fresh instance, so nothing kept in module memory is ever seen by a later request. The validated Treasury rows therefore live in `desk_feed_cache` (`desk_006`, RLS deny-all, service-key only) under `econ:treasury`, payload `{ cols: {"2 Yr": [[date, value], …], …}, fetchedAt, mergedAt, attemptedAt, failedAt, lease }` (`fetchedAt` = the last COMPLETE success, every Treasury column the roster names validated; `mergedAt` = the last merge of any validated column). Every request reads the row beside the FRED sweep (3 s bound); a failed read means FRED only and no Treasury attempt. An attempt is due, judged on the row and the New York clock, unless no yield has a FRED spine this request, `failedAt` is under 10 minutes old, or the row already holds today's rate for every Treasury column the roster names and it agrees with FRED (final). Inside the posting window (weekdays 15:25 ET to midnight) an attempt is otherwise due at most every 5 minutes from `attemptedAt` — the lease. Outside it (before 15:25 ET and all weekend) nothing new can have been published since the window last opened, so an attempt is due only when no COMPLETE fetch has succeeded since the most recent weekday 15:25 ET (`fetchedAt`; Friday's over a weekend), and then at most hourly; an empty store asks at once. No holiday table: on a weekday market holiday an attempt is made every 5 minutes until midnight ET (Treasury posts nothing), and the day after needs nothing special. The request that finds an attempt due re-reads the row, writes the lease (`attemptedAt`, a random id) BEFORE fetching, re-reads to confirm it is its own, then fetches both months AWAITED (45 s bound; ~20 s measured), validates them against FRED BEFORE writing (only columns that parse and agree are stored; nothing usable records `failedAt`, and only while the lease is still its own), writes the merged row (70-day window; `mergedAt` always, `fetchedAt` only on a complete success — a partial one stores what validated, so the missing column is still asked for, hourly outside the window) and builds its reply from it — so that reply already carries the rate. Its final re-read (just before that write) FAILING is not "no row yet" (an empty list is, and is written on): the request then writes nothing at all — neither rows nor a failure, since a whole-payload write from its pre-fetch snapshot could erase a contender's fresher columns — and serves what it validated. Every other request meanwhile finds the lease taken and serves the row as it is. The stored payload is untrusted: re-validated field by field (known tenors, ISO dates ≤ today and within 70 days, plausible values, stamps not in the future), and only ever used through the agreement-and-newer stitch above, so a corrupt row cannot show a wrong yield.

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
| Treasury pending (v3) | Mon–Fri 15:25 ET–midnight, while today's rate is not yet held | capped at the time until the next attempt is allowed: 5 min from `attemptedAt`, or a `failedAt` back-off's end (≥ 30 s); no cap once held | after the 18:30 release window the quiet 15 min would miss a late print (09-30's was out by ~20:50 ET) |

`refreshInSec = max(30, seconds until the cached dataset expires)`. Federal holidays are **not** excluded: nothing is released, so a holiday window costs a few extra cached fetches — cheaper than a holiday table that must be extended every year. Windows are `[from, to)`.

**`changed`** is `true` on a row when its newest observation (date and value) differs from what this function instance held at its previous refresh. It is best effort and per isolate: Supabase spreads requests over short-lived isolates, so a cold isolate legitimately says `false`, and a change can be reported by one isolate and not another — and since every request was MEASURED on 2026-10-01 to run on a fresh instance, it is `false` in practice (the same goes for the per-instance `force` once-per-30s guard). The UI's "NEW since you last looked" marker must therefore be computed client-side from `asOf` (see `tasks.md`); `changed` is a hint, not the source of truth.

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
| Treasury is slow (17–20 s measured; anything up to 45 s) — v3 | Only the one request holding the lease waits — roughly one per 5 min ONLY while today's rate is pending after ~15:30 ET (and once after a deploy), none outside the window once a fetch has succeeded since it opened — and its own reply carries the rate; every other request reads the shared row and answers fast |
| The shared store (`desk_feed_cache`) cannot be read — v3 | FRED-only reply, HTTP 200, and NO Treasury attempt (an attempt nobody can record would be repeated by every request) |
| The lease cannot be written / the final write fails — v3 | No attempt / the reply still carries the rows fetched in this request; the next attempt waits for the interval |
| The final re-read (just before the write) fails — v3 | Nothing is written after the lease (neither rows nor a failure — a contender's fresher row stays intact); the reply carries the rows validated in this request; the next attempt waits for the interval |
| Only some yields validate (e.g. one FRED spine down) — v3 | Those columns are stored and served; `fetchedAt` is NOT advanced, so outside the window the missing one is asked for again at most hourly (inside it, every 5 min until midnight ET) |
| Treasury fails after a validated print was kept (≤ 72h) | The kept print stays — no flip back to T-2 |
| Every series fails, cold isolate | HTTP 502 `{ok:false, error, rows:[…all missing…]}` — the client lamps STALE and keeps its last good render |
| The refresh throws part-way (a bug) with a previous dataset | HTTP 200, the previous dataset, every row `stale`, `refreshInSec` 120 |
| Any row degraded | `refreshInSec` ≤ 120 even in a quiet period |

## 9. What is UNVERIFIED

- ~~**The whole Treasury path against the live host.**~~ *Answered 2026-10-01 from Supabase's servers (the throwaway `desk-probe`):* the URL shape, the header names, the date format and the 2-decimal values are exactly what the parser expects, and there is no bot wall — but the host is SLOW (17–20 s, once past 20 s), so v1's inline 5 s fetch timed out every time (live logs: `Signal timed out`) and its yields stayed on FRED. v3 keeps the rows in a shared store and lets one request per interval wait for them (§3). Still unverified: v3 itself against the live host and the live table — the first post-deploy check is an ordinary reply that is fast again, one reply taking ~20 s that reads `ust10y.source:"treasury"`, the next (a different instance) fast with the same rows, the `econ:treasury` row present with exactly the three columns, and no `Signal timed out` / store failure / `401` in the logs.
- ~~**That FRED's `DGS*` equal Treasury's par-curve values.**~~ *Confirmed 2026-10-01:* the real Treasury 09/28 row equals the repo's FRED capture (4.92 / 5.24 / 5.60, asserted by `econ-check`), and the live desk-econ's FRED 09/29 equals Treasury's 09/29 row (4.89 / 5.26 / 5.64).
- ~~**That background work survives the reply and the next request reaches the same isolate.**~~ *Answered 2026-10-01, negatively:* every desk-econ request runs on a FRESH instance (`generatedAt` differed on calls 4 s apart; v1's per-instance back-off never held), so the per-instance background design (v2) could never have served its result; v3 keeps the rows in `desk_feed_cache` instead. Still unverified for v3: the store's read latency from the function (expected ~50–100 ms, beside the FRED sweep), and the lease race (two instances whose first reads both predate either's lease write can both fetch once, if one's lease write lands after the other has confirmed — accepted: one extra ~20 s reply, both write valid rows, and a racer's failure never overwrites the other's success).
- **Treasury's posting time.** The 15:25–18:30 window is the brief's; the exact time Treasury posts on a given day was not measured — only that 09/30's row was there by ~20:50 ET (2026-10-01 00:50Z). v3 allows an attempt every 5 minutes until midnight ET for that reason.
- **FRED's mirror latency** after an 08:30 release (believed minutes to an hour; not measured here).
- **Deno execution.** There is no Deno in the sandbox: the function was syntax-checked by esbuild and executed in Node (`vm`) under stubs. `Deno.serve`, `AbortSignal.timeout` and Deno's `fetch` were not run.
- **`verify_jwt` ON with the publishable key.** `desk-maps` / `desk-heatmap` / `desk-watchlist` are ON and serve the browser today with the same `deskPost` headers, which is the evidence; confirm with the first smoke test.

## 10. Checks

`node tools/econ-check.mjs` — 38 checks on real FRED captures, constructed Treasury fixtures and the REAL Treasury head captured from Supabase, each in a fresh `vm` context (a cold isolate) with a stubbed `fetch` and a settable clock, against the COMMITTED roster (the Treasury tail ON). They include a Treasury outage — 503, a 403 or 200 block page, a network error and a hung host cut off by its `AbortSignal` — leaving all seven rows served from FRED with HTTP 200 and none missing, and the yields before Treasury has posted the day's rate carrying the previous business day's. Since 2026-10-01 they also hold the shared store (§3), against `fakeDb()` — a stateful in-memory `desk_feed_cache` shared by several vm contexts to play several cold instances: the lease holder waits for a slow Treasury and serves it in its own reply, a request during that wait does not fetch, the next cold instance serves the stored rows with zero Treasury requests; two concurrent instances make one fetch pair; the cadence, the back-off (honoured by a different instance) and the today's-rate stop hold; outside the window a fetch that has succeeded since it opened means zero requests and no lease written across cold instances, over weekends and both DST weekends too, a store older than that gets one attempt, a failing host one per hour, and a roster that gains a Treasury column (or repoints a row) after a complete fetch is asked for at once rather than at Monday 15:25 ET (`fetchedAt` only vouches for the roster it ran under); failures write nothing but the failure; a failed store read means FRED only and no attempt, a corrupt payload is never served and is rewritten clean; a failed final write still serves the fetched rows and, after 18:30 ET, still tells the client to come back in 5 minutes (timed from the row the table still holds), and so does a failure record that cannot be stored (5 minutes, not the unsaved back-off's 10); a failed final re-read writes nothing after the lease (a contender's row stands byte for byte, no failure recorded) while the reply serves what it validated, and a real "no row yet" is still written on; a partial success stores and serves what validated without advancing `fetchedAt`, so the missing column is asked for again an hour later, and advances it once all validate; while today's rate is pending in the posting window `refreshInSec` is capped at the next allowed attempt (300 at 19:00 and 23:00 ET, the back-off's remainder after a failure, ≥ 30), unchanged at 15:30 ET, and uncapped once held, at 10:00 ET and at weekends; the REST calls carry the service key and no user-agent; and the real rows parse with `\n` and `\r\n`, agree with the FRED capture and append onto it. `node tools/econ-check.mjs --mutants` additionally applies 76 single-line mutants of the source (e.g. `"."` read as 0, the `Number("")` trap, YoY off by one month, FRED preferred over a newer Treasury print, a fixed EST offset, NaN leaking from `N/A`, single-flight removed, prototype keys admitted as ranges, the built-in default re-blanking a Treasury column, a tail sharing no date with FRED trusted, an unbounded upstream fetch; and since 2026-10-01 the old 5 s timeout, the lease check removed, the lease not confirmed, no re-read before the lease, `attemptedAt` not written before the fetch, the fetch made fire-and-forget, write-before-validate, the store read ignored, a failure not recorded or the back-off ignored, a racer's failure clobbering a fresher row, the today's-rate stop removed, a disagreeing "today" counted as final, an attempt with no FRED spine, a browser UA on the REST call, future stamps or dates trusted from the store, the 5-minute and hourly cadences broken, the posting window cut at 18:30, the old hourly-regardless rule outside the window, `fetchedAt` ignored, the window start wrong over a weekend or off by a day; and from the Codex review of v3, a failed final re-read read as "no row yet" or still writing, "no row yet" read as a failure, the failure path timing the client from the pre-lease row, the retry cap removed, ignoring the back-off, kept once held or applied outside the window, `fetchedAt` advanced on a partial success, `mergedAt` not stamped or not read back, the 72h keep measured from `fetchedAt`, a failed final write or a failure record that was not stored timing the client from the unsaved row, `fetchedAt` honoured although the roster gained a column the store lacks, a missing or no-longer-agreeing column counted as covered) and 3 damages to the shipped roster (a re-blanked, a wrong and a swapped Treasury column), and requires every one to be caught; 79/79 were caught on 2026-10-01 (75/75 before the Codex round-3 fix, 74/74 before the Codex round-2 fix, 62/62 before the Codex fixes, 36/36 before the shared store, 27/27 before the tail went on).

## 11. The live 10Y (owner request 2026-10-01)

**Why.** FRED and Treasury publish a yield once a day, so by the afternoon the 10Y row is a business day old; the owner asked for "close to real time" 2Y, 10Y and 20Y. Measured through the live `quote-proxy` (Supabase's servers, 2026-10-01): Yahoo `^TNX` (the CBOE 10-year yield index, quoted in percent, 5-minute bars) is a live print that matches Treasury's own 09-30 par yield (5.293 vs 5.29), and so do `^FVX` (5Y) and `^TYX` (30Y) — but **Yahoo has no 2Y or 20Y yield symbol** (the 2Y/5Y/30Y micro-yield futures and every `US2Y`/`US20Y` spelling tried 404; `ZT=F`/`ZB=F`/`UB=F` are futures prices, not yields), CNBC refuses Supabase (403) and Stooq times out. So only the 10Y can be live without a paid, keyed provider (which the owner has not approved, and which was not tested).

**Shape.** A CLIENT-side overlay on the row `ust10y` (the map `ECON_LIVE`: row id → symbol; nothing else). The browser calls `deskQuote('^TNX', 'intraday')` — the same anon, Origin-guarded `quote-proxy` every chart uses — so nothing is deployed and `desk-econ`'s contract (§5) is unchanged; the overlay is derived per render from the server row and the last good quote, and the server row underneath is never mutated.

**When it applies (`econLiveRow`; otherwise the row is the SAME object the server sent).** All of: the official row is `status:'ok'` (never alone — a print needs a healthy row to be checked against); the print's NEW YORK date is STRICTLY newer than the row's `asOf` (an official reading that has caught up to that day stands, so Treasury's and FRED's own number is never overwritten by a delayed quote of the same day, and a Treasury tail once v3 is deployed composes with it); the print is within 0.75 percentage points of the official value (a misread symbol or a ×10 scale is not a move); the fetch it came from is younger than 30 minutes, or two poll intervals when polling is slower (2 h on the hourly weekend cadence — a valid closed-session print must not flicker off halfway through its own interval); a failing quote keeps the last good print that long, then the official row returns.

**What it shows.** Value = the print; change = from the previous session's LAST print of the same index (null — an em dash, never 0 — when the series holds no earlier session); `asOf` = the print's NY date; `source:'live'`; `changed:false`; the chart gets the print as its last point (only when it already had two or more). The date cell is the Pacific clock of the bar when it is from today (Pacific), else its date; the tag is `LIVE` while the bar started under 30 minutes ago and `LAST` after (the bell, a weekend), in neutral ink (green/red stay P&L-only). The tooltip names the bar ("5-minute bar start"), the source and the official reading it stands in for; the footer says "10Y live (Yahoo ^TNX, may be delayed)". **A live row is never NEW**, and the official reading it replaces is recorded as seen, so no chip fires when the overlay drops.

**Cadence.** Its own timer: every 60 s while the bond cash session runs (07:55–15:15 ET on a trading day — the proxy caches a minute), 10 min around it, hourly at weekends and holidays (the NYSE's plus Columbus Day and Veterans Day, `BOND_ONLY_HOLIDAYS`; bond early closes are not modelled); a failed or 20-s-silent quote retries in 60 s; paused while the tab is hidden and asked at once on return; "Refresh now" adds a forced quote that OWNS the slot until it lands (the timer is cleared and an unforced call waits). A quote repaints only the live row in place, and the 30 s ticker re-reads its clock-dependent parts (date cell, LIVE/LAST) so they do not go stale across Pacific midnight. A short span that fell back to its N latest readings keeps N (the print replaces the oldest point). `?demo=1` never calls it.

**Not decided / unmeasured.** How far behind the tape Yahoo's bars run while the market is OPEN (the market was closed when this was built): the 30-minute LIVE/LAST threshold is a guess and the wording is "may be delayed". A live 2Y/20Y would need a keyed provider and a new secret — an owner decision.

**Guard.** S56 (`app.spec.js`): parsing, every trust rule, the cadence, aging, the forced quote and the neutral tag, on a fake clock with both feeds stubbed.

