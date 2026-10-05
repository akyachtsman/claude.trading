# Economy panel and `desk-econ`

The Economy indicators feed (`supabase/functions/desk-econ`, `config/econ-indicators.json`, `tools/econ-check.mjs`): sources, refresh policy, contract and limits. Owner request 2026-09-30; full contract in `specs/economy-indicators/spec.md`. Backend **deployed** 2026-09-30 (owner-approved, v1, `verify_jwt` ON — see Deploying below) and the panel UI built the same day (see "The panel (UI)" below; guarded by S55). Later the same day the owner asked for CURRENT 2Y/10Y yields, so the roster switched Treasury's same-day daily rate ON for the three yields (see Sources and Deploying). On 2026-10-01 a throwaway probe measured Treasury from Supabase's servers: the right data, but 17–20 s per request — and live calls the same day showed that EVERY desk-econ request runs on a FRESH instance. So v3 keeps Treasury's validated rows in the SHARED table `desk_feed_cache` and lets at most one request per interval do the slow fetch, under a lease (see "Treasury in the shared store"). **v3 was DEPLOYED 2026-10-01** (owner-approved, Supabase version 2, `verify_jwt` ON, from `c06888a`; no migration needed — the table exists; verified live, see Deploying) — until then live was v1, whose inline 5 s Treasury attempt ran on EVERY request, added ~4–5 s to each reply, and still ended FRED-only. (A per-instance background design, v2, was written and checkpointed that morning and dropped once the fresh-instance measurement came in.)

- **What it serves.** Seven rows by default — 2Y / 10Y / 20Y Treasury, Unemployment,
  CPI YoY, PCE YoY, Core PCE YoY — each with `value`, `prev`, `delta`, `asOf`,
  `source`, `status` and a `points` chart series for the requested span
  (`1w 1m 3m 6m 1y 5y`; anything else degrades to `3m`). One anon-callable POST,
  same family as `desk-market` / `desk-maps`: session-aware module cache +
  single-flight, every upstream fetch bounded by an `AbortSignal`, always JSON.
  CORS is the **quote-proxy Origin allowlist** (site origin only; no Origin = 403)
  rather than the `*` the other five feeds use — a browser-enforced speed-bump.
- **Sources, keyless — FRED spine, plus Treasury's same-day daily RATE on the three yields**
  (ON since 2026-09-30, owner request: current 2Y and 10Y yields. *Superseded: the same
  day's "FRED only to begin with" ruling, under which the roster named no Treasury column
  and Treasury was never called.* 20Y comes from the same Treasury file and is included so
  no yield in the table sits a day behind its neighbours.) FRED `fredgraph.csv` is the SPINE
  of every row (verified reachable 2026-09-30; lags daily yields 1–2 business days: read the
  row's `asOf`). The shipped roster and the built-in default are IDENTICAL and name exactly
  the `2 Yr` / `10 Yr` / `20 Yr` Treasury columns (`econ-check` asserts both). The U.S.
  Treasury daily par-yield CSV is a **daily RATE: a snapshot of bid-side quotes taken at about
  3:30 pm ET, published about 15:30–18:00 ET** — same day after the snapshot, NEVER intraday,
  and on a volatile afternoon it can differ from the actual closing yield (Codex, PR #295),
  so it is never called a "close": before it posts, a yield row shows the previous business
  day's rate (Treasury's; FRED often carries that day only after its own afternoon update).
  **Measured from Supabase on 2026-10-01** (the throwaway `desk-probe`, 3 runs; this sandbox
  still cannot reach `home.treasury.gov`): the month CSV desk-econ uses, the year CSV and the
  XML feed all answered HTTP 200 `text/csv`, but in **17.1–19.2 s each, and one month-CSV run
  passed the probe's 20 s limit** — independent of size (1.8 / 15 / 33 KB), so throttling of
  data-centre traffic, not a block. The real header and rows matched the parser
  (`tools/fixtures/econ/treasury-real-20260930-head.csv`: `Date,"1 Mo","1.5 Month",…,"30 Yr"`,
  `MM/DD/YYYY`, newest first, 2 decimals), and FRED's `DGS*` equal Treasury's par values on
  shared dates (09-28 in the repo's FRED capture: 4.92 / 5.24 / 5.60; 09-29 live: 4.89 / 5.26 /
  5.64 both). Treasury already had 09/30 (4.88 / 5.29 / 5.68) at ~20:50 ET while FRED's
  newest was 09/29. It is used only when (1) it parses, (2) it AGREES with FRED on every shared date (|Δ| ≤ 0.015) with
  at least one shared date, and (3) it is strictly NEWER than FRED; otherwise the row is
  served from FRED — silently, per row, every refresh (the row's `source`, `"treasury"` or
  `"fred"`, says which; a function log line says why). It is never served alone (no FRED
  spine = `stale` or `missing`), a validated print is kept 72h in the SHARED store so a flaky
  host cannot flip a yield back to T-2 on any instance, and a failed attempt (5xx, block page,
  timeout, nothing that agrees with FRED) records `failedAt`, so EVERY instance backs off 10 min. Columns
  are looked up BY NAME (Treasury inserted `1.5 Month` in 2025, shifting every later column).
  **Known residuals** (found when the tail went ON, 2026-09-30, revised for v3 2026-10-01;
  accepted, not fixed): (a) the LEASE RACE — two instances whose first reads both predate
  either's lease write can both take one. A re-read just before taking the lease and a confirm
  read after writing it (the last write wins; the other backs off) narrow this to the case
  where one instance's lease write lands after the other has already confirmed; then both
  fetch (two ~20 s replies, one wasted fetch pair — both write valid rows, and a racer's
  failure is only recorded while the lease is still its own, so it never overwrites the other's
  success). An atomic compare-and-set (a PostgREST PATCH filtered on the row's `at`) would
  close it, but rests on timestamp round-tripping that could not be tested here, and a wrong
  guess would block Treasury for good — not worth it for one occasional extra fetch; (b) a
  single date where Treasury and FRED disagree (a revision FRED has not picked up) makes that
  row drop the whole Treasury tail until FRED catches up; (c) *(superseded 2026-10-01: "may
  refuse data-centre addresses or be slower than the 5s timeout" — measured: NOT refused, but
  17–20 s, so the 5 s limit failed every time)* the request that holds the lease takes ~20 s:
  at most ONE such reply per 5 minutes while today's rate is pending (typically the first poll
  after ~15:30 ET; every 5 min until midnight ET on a weekday market holiday, when nothing
  posts); the panel keeps its last render meanwhile (no client-side timeout on
  `desk-econ`). A day slower than the 45 s bound is a silent FRED fallback with a 10-min
  back-off, visible only in the function log; (d) the STORE — a failed read (5xx, timeout,
  bad body) is a FRED-only reply with NO attempt (an attempt nobody can record would be
  repeated by every request, ~20 s each); a lease that cannot be written means no attempt; a
  final write that fails still serves THIS reply, and the next attempt waits for the interval;
  a final RE-READ that fails writes nothing at all (below) — the reply serves what it
  validated, the lease row it wrote stands, and the next attempt again waits for the interval;
  (e) per-instance state is useless (MEASURED: every request is a fresh instance), so the
  module dataset cache, `changed` (always `false` in practice — the client's NEW marker keys
  on `asOf`), the `force` once-per-30s guard and FRED's stale-while-error (a failed series
  reads `missing`, not `stale`, with no earlier copy) are best effort only; (f) the row stays
  small: every write and every read prunes it to 70 days of the columns it holds (a few KB);
  (g) a PARTIAL success (2026-10-01, from the Codex review of v3): a column that does not
  validate (its FRED spine down this request, or a mislabelled column) leaves `fetchedAt` where
  it was, so a column that can NEVER validate costs at most one slow attempt per idle interval
  outside the window (hourly, like a failing host) and the usual 5-min attempts inside it until
  midnight ET (today's rate is not held without it).
- **Treasury in the shared store (v3, 2026-10-01 — DEPLOYED the same day).** MEASURED 2026-10-01:
  every desk-econ request runs on a FRESH instance (`generatedAt` differed on calls 4 s apart,
  and v1's per-instance 10-minute back-off never held — every call re-attempted Treasury), so
  module memory is never reused and any per-instance or background design can never be seen by
  a later request. The validated rows therefore live in `desk_feed_cache` (`desk_006`, RLS
  deny-all, service key — as `desk-heatmap` / `desk-news` use it) under the key
  `econ:treasury`: payload `{ cols: {"2 Yr": [[date, value], …], "10 Yr": …, "20 Yr": …},
  fetchedAt, mergedAt, attemptedAt, failedAt, lease }` (`fetchedAt` = the last COMPLETE
  success — every Treasury column the roster names validated, `mergedAt` = the last merge of
  ANY validated column, which the 72h keep runs from,
  `attemptedAt` = the last attempt's start = the lease, `failedAt` = the last total failure or
  null, `lease` = the holder's random id). Every request reads it BESIDE the FRED sweep
  (`readTreasuryRow`, 3 s bound — no added latency); a failed read is a FRED-only reply and NO
  attempt. After FRED, `treasuryCycle()` judges on the ROW and the NY clock
  (`treasuryWanted()`): no attempt while no yield has a FRED spine this request (a file could
  not be checked), within 10 min of `failedAt`, or once the row holds today's NY-date rate for
  every column the roster names AND it agrees with FRED (`treasuryHeld()` — final). Inside
  the posting window (weekdays 15:25 ET–midnight, `treasuryPosting()`) an attempt is due at
  most every 5 min, measured from `attemptedAt` — that interval IS the lease. OUTSIDE it
  (before 15:25 ET, and all weekend) nothing new can have been published since the window
  last opened, so an attempt is due only when no fetch has SUCCEEDED since the most recent
  weekday 15:25 ET (`fetchedAt` against `lastPostingStart()`: the previous weekday's on a
  weekday morning, Friday's over a weekend and on Monday morning; walked back one NY day at a
  time, so the DST Sundays are handled) OR the stored columns no longer cover the roster this
  request runs on (`treasuryCovers()`: every Treasury column the roster names is present and,
  where this request has the row's FRED spine, still agrees with it — the Pages roster is
  re-read hourly, so a tenor added or a row repointed over a weekend is asked for at once, not
  at Monday 15:25 ET; Codex, PR #296 round 3) — and then at most hourly, so a host that keeps
  failing costs at most one slow poll an hour. An empty store has `fetchedAt` 0, so the first
  request after a deploy asks at once. When an attempt is due it
  re-reads (the first read ran beside FRED), writes the lease BEFORE fetching, re-reads to
  confirm the lease is its own, then fetches both months AWAITED with the 45 s bound — on
  purpose: `desk-heatmap` found detached work unreliable on this runtime, and a fresh instance
  would never see its result. The fetched columns are validated BEFORE anything is written
  (parsed, and agreeing with this request's FRED by `stitchTreasury`'s own check — a blocked,
  HTML or mislabelled file never reaches the store); nothing usable records `failedAt` (only
  while the lease is still its own; if THAT write is not stored either, the client's next poll
  is timed from the lease row the table still holds — 5 min — not from the unsaved 10-min
  back-off); otherwise the merged row (pruned to 70 days) is written,
  re-read first so it merges onto whatever is stored by then, stamped `mergedAt` — and
  `fetchedAt` only when EVERY column the roster names validated (a partial success stores what
  did but leaves `fetchedAt`, so outside the window the missing column is still asked for,
  hourly, instead of waiting for the next window). That final re-read FAILING (5xx, timeout)
  is not "no row yet" (an empty list is, and is written on): the request then writes NOTHING —
  neither rows nor a failure, since a whole-payload write from its pre-fetch snapshot could
  erase a contender's fresher columns — and serves what it validated. Either way
  THIS reply is built from the result, so the lease holder's own reply already carries the
  rate, while every other request meanwhile finds the lease taken and serves the row as it
  is. The stored payload is UNTRUSTED (`storeRowFrom()`): re-validated field by field — known
  tenor names, ISO dates no later than today (NY) and within 70 days, plausible values,
  stamps no later than now + 60 s; a foreign shape reads as an empty store (the next lease
  rewrites it clean) — and it only ever reaches a row through `stitchTreasury`, so a corrupt
  row cannot show a wrong yield. The REST calls (`storeHeaders()`) carry the service key and
  NO user-agent (a browser-shaped UA makes the gateway refuse the secret key — CLAUDE.md), and
  log through `scrubbed()`. Expected cost (not yet measured from Supabase): roughly ONE slow
  (~20 s) reply per 5 minutes ONLY while today's rate is pending after ~15:30 ET (and once for
  the first request after a deploy); outside the window, none once a fetch has succeeded since
  it opened; every other reply makes one extra store read (expected ~50–100 ms) that runs
  beside the FRED sweep. *(Until 2026-10-01's last revision the rule outside the window was
  "hourly" — about 20 pointless ~20 s polls a day, since nothing new exists then.)* No holiday
  table: on a weekday market holiday Treasury publishes nothing, so inside the window today's
  rate never appears and an attempt is made every 5 min until midnight ET (one slow poll each,
  for whichever tab lands on it); the day after needs nothing special — the rule is "a fetch
  has succeeded since the window last opened", not "a file dated yesterday".
- **Live-yield candidates, measured from Supabase 2026-10-01.** CNBC's quote API: HTTP 403 "Access
  Denied" (Akamai) — dead. Stooq's yield symbols `2yusy.b` / `10yusy.b`: timed out at 20 s — dead.
  Yahoo `^TNX` (the CBOE 10-year yield index): HTTP 200 in ~85–110 ms with a live quote — **USED as
  the 10Y's fallback for a few hours of 2026-10-01 and REMOVED the same day** (measured ~15 minutes
  behind at 12:10 ET; the owner: "no fallbacks" — see "The live yields" in the panel section below).
  Measured through the live `quote-proxy` the same
  day: `^TNX` last 5.293 vs Treasury's 09-30 par 5.29, `^FVX` 5.089 vs 5.09 (5Y), `^TYX` 5.638 vs
  5.64 (30Y); there is NO Yahoo symbol for a 2Y or 20Y yield (`2YY=F`, `5YY=F`, `30Y=F`, `US2Y=X`,
  `^US2Y`, `2Y=F`, `^UST2Y`, `US20Y=X`, `^US20Y` all 404; `ZT=F` / `ZB=F` / `UB=F` are futures
  PRICES, not yields; `10Y=F`, the micro 10-year yield future, exists and trades overnight). So
  through Yahoo the 2Y and 20Y have no live source. *(Superseded the same day for the 2Y and 20Y:
  CNBC refuses SERVERS but answers the visitor's own BROWSER — see "The live yields from CNBC"
  below.)*
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
  desk-econ has no 1D: the finest data it holds is one reading per business day
  (yields) or per month (jobs, inflation). The panel's own 1D view (below) is NOT a range
  and never reaches it.
- **Refresh policy — "as soon as the data changes".** From the America/New_York
  wall clock (ONE hoisted formatter, `NY_CLOCK` — the `NY_DATE` rule): 60 s inside
  Mon–Fri 08:25–09:15 (BLS/BEA 08:30) and 15:25–18:30 (Treasury), 15 min on a
  quiet weekday but never past today's next window opening, a 60 min heartbeat at
  weekends, ≤2 min while any row is degraded. Inside the Treasury posting
  window (weekdays 15:25 ET–midnight), while today's rate is not yet held, the TTL
  is also capped at the time until the next attempt is allowed (`treasuryRetryInMs()`:
  5 min from the shared row's `attemptedAt`, or the end of a `failedAt` back-off if
  later; never below 30 s), so after the 18:30 release window the client still comes
  back every ≤5 min instead of the quiet 15 and a late print (2026-09-30's was out by
  ~20:50 ET) is seen; no cap once held, outside that window, or when no attempt can be
  wanted (no Treasury column, no FRED spine, the store unreadable). The cap is timed from
  what the table STILL holds: if the final store write fails after a successful fetch,
  this reply serves the fetched rows but `refreshInSec` comes from the persisted row (the
  lease, today's rate still pending), not from the unsaved one that reads as held (Codex,
  PR #296 round 2). The client is told when to ask again (`refreshInSec`, ≥30). Holidays
  are not excluded (cheaper than a table).
- **Failure semantics.** One failed series degrades its own row only: `stale`
  with its last good values and `staleSec` if this isolate held a copy, else
  `missing` with every value `null` (never 0). Every series down on a cold isolate
  → 502 `{ok:false}` (the client keeps its last good render). A refresh that
  throws with a previous dataset → 200, every row `stale`. `changed` is
  per-isolate best effort (a cold isolate says `false` — and since every request was
  MEASURED to be a fresh instance, 2026-10-01, it is `false` in practice, as `stale` is in
  practice `missing`); the UI's NEW marker is client-side from `asOf`.
- **Roster.** `config/econ-indicators.json` is a bare JSON array of row objects,
  read from Pages at runtime (5s timeout, cached 1 hour, built-in identical default
  on failure — `econ-check` asserts the two match). Validated, never trusted: bad
  rows dropped and counted (`roster.dropped`), deduped by `id`, capped at 12, the
  FRED id strictly patterned before it reaches a URL, Treasury only on a
  daily-level row.
- **Checks.** `npm ci --prefix tools` once (installs the esbuild pinned in `tools/package.json`; the check never downloads anything itself), then `node tools/econ-check.mjs` (38 checks, fresh `vm` isolate each,
  stubbed `fetch`, settable clock, real FRED captures + constructed Treasury fixtures + the REAL
  Treasury head captured from Supabase under `tools/fixtures/econ/`, and `fakeDb()` — a stateful
  in-memory `desk_feed_cache` behind the stubbed fetch, SHARED by several vm contexts of one
  check to play several cold instances, and playing the gateway's 401 for a browser-shaped
  user-agent; the harness serves the COMMITTED roster, and the no-Treasury path is tested on
  that roster with its `treasury` keys stripped); `--mutants` proves 71 single-line source
  mutants plus 3 damages to the shipped roster are each caught (79/79 on 2026-10-01; a mutant
  that does not transpile is reported INVALID). The v3 checks: cold instance A holds the lease,
  waits for a "18 s" Treasury (time scaled) and serves it in its OWN reply, while instance C
  arriving during that wait gets the store at once without fetching, and instance B afterwards
  serves the stored rows with ZERO Treasury requests; two cold instances at once make exactly
  one fetch pair, nothing inside the 5-min interval, one after it, and an instance whose first
  read predates another's landing re-reads and serves it; a racer's stale failure never
  overwrites a fresher row; the cadence (today's rate final, 5 min in the posting window incl.
  23:00 ET, `failedAt` binding a DIFFERENT instance); OUTSIDE the window, a previous-evening
  success means ZERO requests and no lease written across cold instances until 15:25 ET, a
  Friday-evening success the same over Saturday, Sunday and Monday morning (both 2026 DST
  weekends included), a store older than the last window start one attempt and then none, and
  a host that keeps failing one attempt per hour; a PARTIAL success (FRED's DGS20 down) storing
  and serving the two columns that validated with `fetchedAt` left alone, so the missing one is
  asked for again an hour later, and `fetchedAt` advancing once all three validate; a roster
  that GAINS a Treasury column (or repoints a row at another one) after a complete Friday
  fetch is asked for on the Saturday, not at Monday 15:25 ET, and nothing more once the
  stored columns cover it; the RETRY
  CAP (19:00 and 23:00 ET with today's rate pending: `refreshInSec` 300, 180 for a later
  instance, never below 30, back to 900 once the late print lands; 15:30 ET unchanged at 60;
  900 once held; 600 / 360 inside a failure's back-off; no cap at 10:00 ET or on a Saturday); a
  FAILED final re-read (500, timeout) writing nothing after the lease — a contender's row stands
  byte for byte, no `failedAt` — while the reply serves what it validated, and a real "no row
  yet" still written; Treasury 503 / 403 /
  200-HTML / network / a hang cut by the 45 s signal / garbage columns → HTTP 200, seven FRED
  rows, nothing but the failure stored; a store read failing (500, timeout, non-JSON, not a
  row list) → FRED only with no attempt and no write, a foreign-shaped or corrupt payload never
  served and rewritten clean by the next lease; a lease write failing → no attempt, a final
  write failing → this reply still carries the fetched rows (and the log never the key) and the
  client is timed from the lease row the table still holds, as when the failure record itself
  cannot be stored (5 min, not an unsaved back-off's 10); every
  REST call goes to `SUPABASE_URL` with the service key, no user-agent, bounded; and the real
  rows parse with `\n` and `\r\n`, equal the FRED capture on 09-28 and append 09-29/09-30 onto it.
- **Deploying.** Deployed 2026-09-30 (owner-approved, project
  `kwugzhyfjevzwgplhtsd`, version 1, `verify_jwt` **ON**, like `desk-maps` /
  `desk-heatmap` / `desk-watchlist`, which serve the browser's `deskPost` headers).
  Smoke test after deploy, anon key + `Origin: https://akyachtsman.github.io`:
  POST `{range:'3m'}` 200 with 7 rows, all `source:"fred"` (zero Treasury calls — v1 on its
  built-in FRED-only default, before the Treasury tail went on);
  `{range:'bogus'}` and a non-JSON body degrade to `3m`; `1w`/`1y`/`5y` slice the cached
  history; no Origin and a foreign Origin 403; GET 405; OPTIONS 200 with the allowlisted
  `Access-Control-Allow-Origin`; no `Authorization` header 401 (the `verify_jwt` gate).
  Values agreed with direct FRED pulls (10Y 5.24 on 2026-09-28; CPI YoY 3.397 against
  the 3.4 served). Logs read clean (no 5xx). Until `config/econ-indicators.json` is on
  Pages (first merge to `main`) the function reports `roster.source:"default"` — the
  built-in roster is identical, so the rows are the same. *(True of v1 while both were
  FRED-only. Since the Treasury columns went into the config, v1's built-in default and the
  Pages roster DIFFERED until the v3 deploy (2026-10-01, which closed that gap): `roster.source:"default"` on v1 meant the
  yields were on FRED — see below.)*
  The repo spells the BOM strip `/^\uFEFF/`; the payload sent used the same escape, and
  the read-back may show the literal character instead — the same regex either way.
  **Treasury tail ON (2026-09-30, owner request) — NOT redeployed at the time.** *(Historical:
  v3 was deployed 2026-10-01, see the v3 paragraph below.)* The live function was
  still v1, whose built-in default names no Treasury column. But v1 (deployed from `f78a03f`, whose file is the one at `cd5f920` on `main`,
  the same source as this file before the roster change) already carries the whole Treasury
  path and reads the roster from Pages at runtime (cached 1h), so the three Treasury columns
  take effect on the LIVE function within about an hour of `config/econ-indicators.json`
  reaching Pages (the merge to `main`) — a merged roster edit IS a live change, deploy or
  not. The next deploy (the built-in default naming the same three columns, so a Pages outage
  does not drop the yields back to FRED) was v3, approved and done 2026-10-01. The Treasury
  path was UNVERIFIED AGAINST THE LIVE HOST until it ran from Supabase: after Treasury
  posts (inside 15:25–18:30 ET), `ust10y.source` should read `"treasury"` with today's `asOf`;
  if it never does, the rows are silently on FRED — read the function logs for
  `desk-econ: Treasury` / `treasury disagrees` / `no overlap` lines. *(Superseded 2026-10-01:
  it ran, and never did — see the next paragraph.)*
  **2026-10-01 — live v1 never served Treasury and cost EVERY reply ~4–5 s; v3 fixes both and
  was deployed that day (verification at the end of this paragraph).** With the roster on Pages, v1 attempted Treasury INLINE with a 5 s limit.
  Every request runs on a fresh instance, so v1's per-instance 10-min back-off never holds:
  EVERY desk-econ request waits ~5 s for an attempt that always times out (`desk-econ: Treasury
  202609 failed: Signal timed out`) — calls at +0 / +4 / +30 / +90 s each took ~5.5 s and each
  had its own `generatedAt` — and the yields stay FRED's. The throwaway `desk-probe`
  (owner-approved 2026-10-01, `verify_jwt` ON, self-expiring at 2026-10-01T04:00:00Z; source in
  `supabase/functions/desk-probe/`; DELETED from the dashboard by the owner 2026-10-04, since the
  Supabase tools cannot delete a function) measured why: 17–20 s per request (see Sources). A per-instance background
  design (v2) was written and checkpointed (commit `34939b8`, draft PR #296) and dropped once
  the fresh-instance measurement came in. The fix is v3 (see "Treasury in the shared store"):
  deploy only on the owner's approval, `verify_jwt` ON as v1, NO migration (the table exists;
  the first lease creates the row). It reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from
  the function env, which Supabase provides to every edge function (`desk-heatmap` relies on
  the same pair today). The post-deploy checklist (run 2026-10-01 — see "Deployed 2026-10-01
  (v3)" at the end of this section for the result): (1) an ordinary reply is fast again (no
  ~5 s Treasury wait); (2) the first reply after an attempt falls due takes ~20 s and reads
  `ust10y.source:"treasury"` (today's `asOf` once Treasury has posted, else the prior business
  day's); (3) the next call — a different instance — is fast and shows the same rows; (4)
  `desk_feed_cache` row `econ:treasury` holds `cols` for exactly `2 Yr` / `10 Yr` / `20 Yr`,
  with `attemptedAt` moving at most every 5 min in the window, never once today's rate is
  held, and not at all before 15:25 ET / at weekends once a complete fetch has succeeded since
  the window last opened (`fetchedAt` moves only then, `mergedAt` on every merge); (5) the logs
  carry no `Signal timed out`, no `Treasury store read failed` / `store write failed` / `store
  re-read failed` and no `401` (a browser UA on the REST call would surface as a failed read);
  (6) after 18:30 ET with today's rate still pending, a reply's `refreshInSec` is ≤ 300, not the
  quiet 900.
  **Deployed 2026-10-01 (v3).** Owner-approved ("Yes, deploy desk-econ v3"); project
  `kwugzhyfjevzwgplhtsd`, Supabase version 2 (`ezbr_sha256` `dfea38f9…5bea43`), `verify_jwt`
  **ON**, from `c06888a` (the file has not changed since that merge). The payload sent equals the
  repo file except two literal BOM characters where the repo has the `\uFEFF` escape (the same
  regex; a byte-for-byte compare of a read-back needs that normalisation). Verified at
  05:47 UTC (01:47 ET, Treasury's 09-30 print already out): the FIRST request took 20.7 s and
  returned `ust2y` 4.88 / `ust10y` 5.29 / `ust20y` 5.68, all `source:"treasury"`, `asOf`
  2026-09-30 (a day AHEAD of FRED); the `econ:treasury` row held all three columns (21
  observations each, last 2026-09-30) with `fetchedAt` = `mergedAt` set, a lease and no
  `failedAt`; the SECOND request answered in 0.94 s with the same rows (read from the store, on a
  different instance); the logs carried one expected warning — `Treasury 202610 failed: not a
  par-yield CSV`, because the October file does not exist until the first October print — and no
  `Signal timed out`, store read/write failure or 401. Still to see in normal operation: items
  (6) above (the capped `refreshInSec` after 18:30 ET) and today's rate arriving after the
  3:30 pm ET snapshot. **Rollback** = redeploy v1 — `supabase/functions/desk-econ/index.ts` as of `cd5f920` (the #294 merge on `main`, byte-identical to the `f78a03f` branch commit v1 was deployed from; that commit is no longer reachable from any branch after the squash merge) — with `verify_jwt` ON; the
  `econ:treasury` row is then simply unused.

## The panel (UI) — `scripts/app.js` Economy block, `styles/components.css` `.econ-*`

Built 2026-09-30 into the desk row's 4th slot (`<aside class="panel area-econ">`).
Everything for it sits in ONE block of `app.js` (before the widgets section) plus
`deskEcon()` / `buildDemoEcon()` in `data.js`; `index.html` keeps the bare placeholder it
shipped with — `econChrome()` builds the span control, the list and the
header's `#econStamp` itself (there is no footer note). Guard: **S55** (S5 also names `#econLamp`; S54 holds the slot's
width); **S56** guards the live 10Y.

- **Rows.** One `<li class="econ-row">` per indicator: label / value / change / the date
  the reading is FOR at the left (a fixed 104px block, so every chart starts on one line),
  ITS OWN chart to the right (`econSpark()`: an inline SVG path built with `createElementNS`,
  the watchlist sparkline idiom, no axes; x = index order, y = the row's own min/max; a flat
  series is a level line through the middle; fewer than two real values draws a DASHED
  PLACEHOLDER, never an invented line). `pointsNote` ("monthly - 6 latest") is the caption
  under the chart (`.econ-note`); otherwise the caption is the chart's first and last date.
- **Colour (owner 2026-10-02: "if it's lower, make it red … if it's higher, green" → "I'm only
  talking about the digit after the up pointer and the digit after the down pointer").** The
  change is its arrow (`▲` `▼`, `=` for a real zero) in the usual muted ink with ONLY the digits
  after it coloured: `.econ-delta-n.up` is `--color-gain`, `.econ-delta-n.down` is `--color-loss`
  (both text on white at 5.2 / 5.5:1), inside `.econ-delta` — `econRow` splits the text once
  (`/^([▲▼=]) (.+)$/`), so `textContent` still reads `▼ 0.10` end to end. This SUPERSEDES the
  earlier "neutral ink, green/red are P&L-only, a rising yield is not a gain" ruling for this
  ONE figure and nothing else. Consequences worth knowing: it is the DIRECTION of the latest
  reading's move against the previous one (not the selected span's change, which the panel
  never showed), so a rising unemployment rate or CPI shows green exactly like a rising
  yield — a direction, not a verdict; a real zero (`=`), an unknown change (an em dash) and a
  STALE row (its number is not today's: `.is-stale .econ-delta-n` is muted) are never
  coloured; the arrow, the value, the chart line (brass accent), every chip and every axis
  stay neutral. A live row's digits colour the same way (the change from CNBC's previous
  close). S55 reads the colour of every row's digits, arrow and value against the tokens
  (the demo has rows that rose, fell and did not move) and still scans everything ELSE in
  the panel for a gain/loss colour or P&L class; S56/S57 check the live ▲ and ▼ digits.
- **Decimals and dates.** Value and change print at the row's own `decimals`; null/NaN is an
  em dash through `fmtToNum` — never `0.00%`. A daily reading is `Sep 29`; a monthly one names
  its MONTH (`Aug`, the year only when it is not this one), by string slicing — never
  `new Date('2026-08-01')`, which is UTC midnight and reads Jul 31 in Pacific. The date is
  deliberately prominent: a yield is a daily RATE — today's only once Treasury has posted it
  (late afternoon ET), otherwise the previous business day's, and older when only FRED has it.
  (Until 2026-09-30's switch this read "the feed is FRED-only".)
- **A source on every row — and no footer (owner request 2026-10-01: "I want a per index source").**
  Under each row's date sits a tiny `.econ-src` line (9px, the muted ink token — never `opacity`),
  `Source: <name>`, from `econSourceLabel(r)`: a live print → `CNBC US2Y` (the symbol comes from
  `r.live`), `source:'treasury'` → `U.S.
  Treasury`, `source:'fred'` → `FRED`; in DEMO every row reads
  `Source: Demo data` (the generated numbers are not FRED's, whatever the payload's `source` field
  says, and the tooltip agrees); an unknown source and a `missing` row print NO line — never a guess.
  The line is clipped, not wrapped (`overflow: hidden`), and the longest real name, `Source: U.S.
  Treasury`, must fit the 104px value block at every viewport (S55 measures it — a clipped source is
  a wrong source). The footer note that used to say all this once for the whole panel was REMOVED
  (`.econ-foot` is gone; S55/S56 assert `.econ-foot` does not exist). What it carried that the line
  cannot lives in each row's tooltip: `source U.S. Treasury daily rate (a ~3:30 pm ET snapshot of
  bid-side quotes)` / `source FRED` / `source CNBC US2Y live quote, may be delayed` — never
  "same day" and never a "close": before today's rate posts, Treasury supplies YESTERDAY's, and
  `asOf` is what says so (Codex, PR #295). Only the agency FRED republishes (BLS, BEA) is NOT named:
  the payload carries no such field, and a client-side map keyed on row ids would break the day the
  owner edits the roster.
- **Status.** `missing` (or a null value): em dashes, a dashed placeholder, a `NO DATA` tag.
  `stale`: the row keeps its last good value and chart (spec §8), muted, tagged `STALE`
  (the tooltip carries the age).
- **Span.** `#econTf` is the shared `.seg` chrome: 1D 1W 1M 3M 6M 1Y 5Y, default **3M**,
  persisted in `localStorage` `econ_tf_v1` and validated against the list on load (a bad
  value falls back). 1D is a VIEW, not a range — see "The 1D view" below; the control's
  `title` says the monthly indicators have no 1-day data. In demo a pick rebuilds
  from `buildDemoEcon(range)`; live it asks `deskEcon(range)` — a slice server-side — keeping
  the old rows, dimmed (`.is-pending`), until the reply lands. A reply whose `range` is not
  the span being asked (version skew: an older deploy answers 3m to anything) is treated as a
  failed poll, never drawn under the wrong label; after such a failure the rows keep their
  values but their charts become dashed placeholders ("span unavailable").
- **Lamp / stamp.** Demo: `Demo`. Live: `Loading` until the first reply; `LIVE` when the last
  poll succeeded, the body is not `stale:true` and the success is younger than 3 × the
  reply's `refreshInSec`; `STALE` otherwise (poll failed, stale body, or aged out). There is
  no EOD state — these are not prices. The lamp AGES even when nothing lands: a 30s
  `setInterval(relampEcon)` re-reads it against `Date.now()`, and `visibilitychange` re-reads
  it BEFORE the refetch. The stamp is `fmtUpdated(generatedAt, its Pacific date)`
  ("Last updated 08:11, Sep 30" — when the desk last checked; the rows carry when the DATA is
  for); demo names the newest reading's date.
- **Poller.** The next fetch is `refreshInSec` clamped to 30..3600s (`econClamp`; the
  function already tightens it to 60s inside the 08:25–09:15 and 15:25–18:30 ET release
  windows and relaxes it at weekends), scheduled by `econArm()`. A failed poll retries in 60s.
  Paused while the tab is hidden, resumed on return (at once if it came due meanwhile).
  Renders sit OUTSIDE the fetch `try` (`renderAfterFetch`). A span change passes `keepClock`:
  it may only pull the next poll EARLIER, never reset a pending one. `force` is sent only by
  the desk's "Refresh now" (`refreshNowClicked` → `refreshEcon(true)`, the function honours it
  once per 30s). A forced refresh OWNS the clock until it lands: it clears the poll timer and
  `dueAt` first, because a timer coming due meanwhile would start a second, unforced request,
  take the newer generation and get the forced reply thrown away. The same goes for a SPAN
  change made while it is in flight: `econPickSpan` only records the span and marks the list
  pending (`econState.forcing`), and `refreshEcon` asks for the span showing the moment the forced
  reply lands (not a failed poll) — and KEEPS asking (`econFetch` returns "the span moved") until
  the span it asked for is the one showing, holding the lock through repeated changes, so the
  forced refresh (and "Refresh now") settles only when that has landed. "Refresh now" also stays
  disabled ("Refreshing…") until BOTH the feeds and the economy request are done —
  `renderMasthead()` renders the pending state, and `refreshNowClicked`'s `finally` rebuilds
  the button. `?demo=1` never calls the network for this panel; live never renders demo
  rows (first load: empty state + `Loading`, then `STALE` and a 60s retry if it fails).
- **NEW.** `econ_seen_v1` = `{ id: 'asOf|value' }`. A row is NEW when its newest reading
  differs from the recorded one, or — with nothing recorded — when the server says `changed`
  (per-isolate best effort, so never the only source). That hint is TRANSIENT (the next refresh
  says `changed:false` for the same reading), so a hinted row is also written to `econ_pending_v1`
  and stays NEW until acknowledged; without it the next poll would read "no record, not changed"
  as a first look and seed it silently, losing a chip nobody had seen (Codex, PR #294). The first look seeds silently (no wall
  of chips). A chip clears on hover/click of its row, or once ITS ROW has been IN VIEW for ~60s with
  the tab visible (Codex, PR #294: a chip on a row nobody has scrolled to must not be cleared
  unseen). Visibility is an `IntersectionObserver` (half the row; it accounts for the page scroll
  AND the panel's own scrollport); timers are per row id (`econState.newTimers`), a row that leaves
  view drops its timer, and a poll's re-render does NOT restart one — a rebuilt row the observer has
  not yet reported on (`econState.known`) keeps its running timer. Without `IntersectionObserver`
  every row counts as in view.
  **Storage** (Codex, PR #294): `econPersist()` writes only the ids THIS tab changed, merged into a
  fresh read of the stored map, so two tabs acknowledging different rows do not overwrite each
  other; a `storage` listener re-reads both maps and re-renders, so an acknowledgement made in
  another tab clears the chip here. **Demo state is never persisted** (session-only, empty at
  `startEcon`): its synthetic readings would otherwise make the first real visit read every row
  as NEW. Each chart's accessible name says what is drawn — `pointsNote` ("monthly - 6 latest")
  when the span fell back, else "over 3M" — never a short span over a half-year of readings.
- **The live yields (owner request 2026-10-01; guards S56 and S57).** FRED and Treasury publish a
  yield once a day, so by the afternoon a yield row is a business day old. The live print is a
  CLIENT-side OVERLAY on the `ust2y` / `ust10y` / `ust20y` rows — no edge-function change, no
  deploy; merging it IS shipping it — from ONE place: **CNBC's quote service**, ONE request for all
  three rows made by the visitor's browser (next bullet). **There is NO fallback source** (owner, the
  same day: "no fallbacks. If CNBC doesn't give me real time, I want to be aware"). Yahoo's `^TNX`,
  through the `quote-proxy` every chart uses, was the 10Y's fallback for a few hours; measured through
  the live proxy at 12:10 ET (newest bar 15:56 UTC at 16:11 UTC, steady over three calls a minute
  apart) it ran about **15 minutes behind** — the CBOE delay — so it would have put a delayed number
  under a live-looking row. `ECON_LIVE_YAHOO`, `econLiveParse`, `econLiveQuote` and the `via` field are
  GONE, and a `deskQuote` call for a yield is a defect (S56 and S57 record one and assert none).
  `ECON_LIVE` maps row id → CNBC symbol (`US2Y` / `US10Y` / `US20Y`) and is the set of rows that CAN be
  live; each stored print (`econLive.q[id]`) carries its `symbol`. `econLiveRow(r, now)` returns the
  SAME object (no overlay) unless ALL of these hold: the official row is `status: 'ok'` (never alone —
  a print needs a healthy row to be checked against); the print's NEW YORK date is STRICTLY newer than
  the official `asOf` — **or** the bond session is open (`econBondOpen`) and the quote is FRESH (its OWN
  time within `ECON_LIVE_FRESH_MS`, 5 minutes) and on today's date, which replaces today's own
  Treasury snapshot (it is a 3:30 pm ET reading posted mid-afternoon, so from then until the close it
  is OLDER than the live quote beside it; a stale quote, or any quote once the session is shut, leaves
  the official reading standing); it is within `ECON_LIVE_TOL` (0.75 points) of the official value (a
  misread symbol or a ×10 scale is not a move); and the fetch it came from is younger than
  `ECON_LIVE_KEEP_MS` (30 min — a failing request keeps the last good print that long, then the row
  is the official one again: real data or nothing; when polling is slower than that the window is
  TWO poll intervals, `q.keepMs` — 2 h on the hourly weekend/holiday cadence — so a valid
  closed-session print does not flicker off halfway through its own interval, Codex PR #297). When it
  applies the row shows the print (`value`), the change from the PREVIOUS CLOSE CNBC reports (`null` —
  an em dash, never 0 — when it reports none), `asOf` = the print's NY date, `source: 'live'`,
  `changed: false`, and the chart gets the print as its last point (only when it already had two or
  more; a short span that fell back to its N latest readings, `pointsNote` "daily - 6 latest", keeps N
  — the print replaces the OLDEST point — so the caption and the chart's accessible name stay true).
  The date cell is the Pacific CLOCK of the quote when it is from today (Pacific), else the date.
  **NEW is bypassed**: `econRowIsNew` is false for a live row (the print ticks by the minute) and
  `econLiveSeen` records the official reading it stands in for as seen (and clears its pending mark),
  so no chip fires later when the overlay drops.
  **NOT LIVE (owner, same day; guards S56/S57).** `econLiveState(r, now)` is the one rule for the chip
  beside the date: `live` → `LIVE` (a quote whose own time is within `ECON_LIVE_FRESH_MS`); `last` →
  `LAST` (a quote that has stopped moving while the bond session is SHUT — after the bell, a weekend,
  a holiday: normal); `notlive` → a SOLID ink chip `NOT LIVE` (`.econ-nolive`: ink on surface — never
  red, red is for losses, and not outlined like LIVE/LAST so it cannot be mistaken for them) whenever
  the session is OPEN (`econBondOpen`: 07:55–17:05 ET on a bond-market trading day — the same window
  as the 60 s poll) and the row has no fresh quote: CNBC is blocked or down, answered but left that
  row out, was refused as a misread, or its stamp has stopped moving. The row keeps its OFFICIAL
  reading under its own date and source (or the stale CNBC print, flagged), and the tooltip says why
  (`econNotLiveWhy`): "CNBC's last quote for this row is N min old, so it is not real time", "CNBC did
  not answer (blocked, offline or refused), so there is no real-time yield; this is the latest
  official reading", or "CNBC sent no usable real-time quote for this row; …". No chip in demo, on a
  row that is not a yield, before the FIRST reply has landed (`econLive.landedAt` — a page load does
  not flash it), or on a row with no live print once the session is shut (real time is not expected
  then). `econLive.answered` records whether the last request got a usable body (`null` until the
  first). Width: the chip is compact (`.econ-nolive`: no border, tight padding and tracking, ~46px beside a 42px
  date) so date + NOT LIVE fit the 104px block on one line in every font state, and a NEW chip beside
  them (an unseen official reading while CNBC is down) wraps to a second line (`.econ-sub` is
  `flex-wrap`) rather than hang into the chart column. S56 asserts what must hold in ANY font state —
  both chips visible, NOT LIVE never after NEW, every chip inside the block, no sideways overflow — and
  NOT the stricter "same line as the date": a first version asserted that and failed on CI's phone
  viewport, where the web fonts swap in late and the fallback sans is wider than this sandbox's (a
  first, bordered ~57px chip wrapped there). Known residual: bond-market EARLY closes (14:00
  before some holidays) are not modelled, so the row says NOT LIVE from the early close until 17:05.
  **Polling** is its own timer, not `refreshInSec`: `econLiveFetch` → `econLiveArm`, every 60 s while
  the bond session runs, 10 min around it on a trading day, hourly at weekends and holidays
  (`econLiveDelaySec`, off `etTradingClock` PLUS `BOND_ONLY_HOLIDAYS` in `data.js` — Columbus Day and
  Veterans Day, when the NYSE is open and the bond market is not); a failed request retries in 60 s;
  each is capped at 8 s inside `econLiveCnbc` so a hung request is a failed one, not a wedged poller;
  paused while the tab is hidden and asked at once on return if one came due (the aged-out print is
  dropped first); the masthead's "Refresh now" adds a FORCED request to its `Promise.all` (there is
  no cache in front of CNBC, so "forced" only claims the slot). **A FORCED request owns the slot until
  it lands** (`econLive.forcing`; Codex, PR #297): every fetch clears the poll timer when it starts and
  an unforced call made meanwhile returns, because a timer coming due would take the newer generation
  and get the forced reply thrown away. A reply repaints ONLY the yield rows in place
  (`econLiveRepaint`) so a minute's tick does not restart the NEW watch of the other rows; the 30 s
  ticker (`relampEcon`) calls it too — the date cell, LIVE → NOT LIVE → LAST and the session's open
  and close depend on the CLOCK, so they would otherwise go stale across Pacific midnight, between idle
  polls or at the bell — and it rebuilds a row only when its text or tooltip differs, so a hover is not
  torn down every half minute; a full `renderEcon` also applies the overlay. `?demo=1` never calls it
  (`DESK.mode === 'demo'` guards the fetch, the overlay and the chip).
- **The live yields from CNBC (owner request 2026-10-01: "Can this be built into the dashboard?";
  guard S57).** CNBC's quote service, `quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol
  ?symbols=US2Y|US10Y|US20Y&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`
  (the URL is `ECON_CNBC_URL`; the owner found it in CNBC's own page — DevTools → Network → Fetch/XHR on
  `cnbc.com/quotes/US10Y` — a `symbol?symbols=US10Y…` fetch the page repeats as its price updates).
  **It must be called from the BROWSER.** Its bot protection (Akamai, `AkamaiGHost`, "Access Denied",
  HTTP 403) refuses every server — Supabase's functions and the build sandbox, even with the host
  allowed — but a page on this site is answered with CORS: measured from the owner's Chromebook,
  running on `akyachtsman.github.io`, 2026-10-01 11:49 ET: `US2Y` last 4.787, `US10Y` 5.253 (agreeing
  with Yahoo's 5.26 at 11:33 and with Treasury's 09-30 closes through `last − change` = 4.887 / 5.293),
  `last_time` seconds old, `exchange: "Tradeweb"`. So `econLiveCnbc()` is a plain `fetch(ECON_CNBC_URL,
  { signal })` — default semantics ONLY, exactly the call that was measured, no extra option or header
  that could turn it into a CORS preflight (S57 pins `['signal']`) — and it NEVER throws: a 403, a
  blocked request (an extension, a work or school network), a body that is not JSON, or 8 s of silence
  (`ECON_CNBC_TIMEOUT_MS`) is `null`. It is an UNOFFICIAL endpoint, so every failure is a **NOT LIVE
  row, never an error** (above). **One request carries all three rows** (a request a minute in the bond
  session): a row it leaves out has no new quote — the last good one ages out after
  `ECON_LIVE_KEEP_MS` — and says NOT LIVE once that quote is no longer fresh.
  `econLiveParseCnbc(body, now)` → `{ rowId: { price, ts, date, prevClose, prevDate: null, symbol } }`:
  numbers arrive as strings with a trailing `%` (`"4.787%"`); `last_time` is
  `"2026-10-01T11:49:47.000-0400"`, an offset WITHOUT a colon, rewritten to the standard form before
  `Date.parse` (which REPAIRS a calendar-impossible stamp — Feb 30 → Mar 2, 24:00 → the next day — so
  the captured fields are read back as UTC and a stamp whose fields move is refused); the previous
  close is **`last − change`** (`change` is in percentage points) and an absent, junk or absurd
  (≥ 2 points) `change` leaves it `null` — an em dash, never a guess; **`change_pct` is NEVER used** (it
  read +0.19% beside a −0.10 change on the 2Y); a quote with a non-zero `code`, a price outside
  (−5, 30), an unparseable or future time, or a symbol outside `ECON_LIVE` is skipped, not repaired.
  The rows then go through `econLiveRow`, each on its OWN: a misread on the 2Y leaves only the 2Y on
  its official reading. The source line reads `Source: CNBC US2Y`; the tooltip says "as of …
  (time of the last quote)", "from the previous close CNBC reports", "source CNBC US2Y live quote, may
  be delayed". **CI:** S1/S3 load the live-config page, so the boot-time request fails there (a
  runner's IP is refused) and logs console errors the app absorbs by design; the shared allowlist
  (`OPTIONAL_FEED`, the exact prefix `https://quote.cnbc.com/quote-html-webservice/`, in `benignCors`
  and the S1/S3 console rules) admits exactly that and nothing wider — not CNBC's other hosts or
  pages, not a look-alike host, and not a foreign URL that carries the prefix in its query string (a
  console location must START with it, `optionalFeedUrl`; a message must hold it as a whole URL token,
  `optionalFeedInText`) — S57 pins all four. **Privacy:** CNBC sees each viewer's IP, user-agent and
  the page origin (`https://akyachtsman.github.io/`) on every poll; no desk data crosses (the request
  carries none). **Open:** how far behind CNBC's quote runs is not measured (one reading, seconds
  old, and the 20Y item's shape was never seen — it is parsed on the same rules); and only a browser
  that can reach `quote.cnbc.com` gets it — server code (`desk-ask`, the scheduled asks) never sees
  these prices.
- **The 1D view (owner 2026-10-01: "add the one day chart" → "build it blind"; guard S58).**
  `econTf` is the VIEW the owner picked and `econRange` the span desk-econ is ASKED for (the
  last real span; `3m` when the saved view is `1d`). 1D is never sent to desk-econ — it would
  answer an unknown range with `3m`, which `econFetch` treats as a failed reply — so picking
  1D, or going back to the span still showing, changes only what is drawn: no request, the poll
  clock and a forced refresh in flight untouched (`econPickSpan`: `econRange === before`). The
  poller's `asked`, its `owned` re-ask and its stale-reply drop read `econRange`; a changed
  range still takes the whole existing path (the forced-slot serialisation, `is-pending`).
  **Source (BUILT BLIND).** The yields draw the day's price bars from CNBC's chart feed,
  `ts-api.cnbc.com/harmony/app/charts/1D.json?symbol=US2Y|US10Y|US20Y` (`ECON_CHART_URL`, one
  request per yield), fetched by the visitor's BROWSER (`econLiveBars`: `fetch(url, { signal })`,
  8 s, never throws → `{ ok, body }` or `{ ok: false, why, detail }`). The URL and the reply's
  shape are from memory and were NOT measured — every CNBC host answers the build sandbox 403
  (WebFetch too) — which is why the design names every failure instead of guessing quietly.
  **Parsing** (`econBarsParse`): the list is looked for at `barData.priceBars`, `priceBars`,
  `bars`, `data.priceBars`, `chart.priceBars`, `result.priceBars` or as a bare array; a bar's
  instant is `tradeTimeinMills` (epoch ms), else `tradeTime` as `YYYYMMDDhhmmss` New York wall
  time (`etWallToMs` in `data.js`, the inverse of `etClock`, refined twice for DST and READ BACK
  so a date that moved — Feb 30, 25:00 — is refused; minute/second ranges are checked first, or
  minute 70 would read back as a valid 09:10), else an ISO stamp with its offset; the price is
  `close`, `last` or `price` through `econCnbcNum`; a bar from the future or with a price outside
  (−5, 30) is skipped; bars are sorted, only the NEWEST New York session is kept — and only THEN
  is the two-bar minimum applied (yesterday plus one bar of today reads `no bars` and keeps the
  last good chart; Codex, PR #301) — and a long day is thinned with `econDownsample`
  (≤ `ECON_BARS_MAX` = 150 real points).
  **Failure is named, never filled.** No substitute source (owner: "no fallbacks"), no demo
  bars in live, no chart from anything but real bars. The row shows the dashed placeholder
  and the reason: caption `1D HTTP 403` / `1D no answer` / `1D not JSON` / `1D unknown format`
  / `1D no bars` / `1D bars ≠ quote`, and the row's tooltip carries the detail — for an unknown
  format the reply's top-level keys (and `barData`'s), for no bars the count and a bar's keys,
  for a mismatch the two prices (`econBarsEntry`: the last bar must be within
  `ECON_BARS_MISMATCH` = 1.5 points of the number the row DRAWS — the live quote only when
  `econLiveRow` trusts it, else the official reading: `econBarsRef`; a CNBC quote the row refused
  as a misread must not vouch for bars near the same misread, Codex PR #301). **The owner
  reads these back**, so a wrong guess about the feed costs one look at the panel, not a
  console session. A failed refresh keeps the last GOOD bars for `ECON_BARS_KEEP_MS` (30 min)
  with "the last refresh failed (…)" in the tooltip, then only the reason is shown.
  The same check runs at every RENDER (`econBarsMismatch` in `econBarsFor`): a page that boots
  on a saved 1D can have a bars reply land before any quote or desk-econ row exists, and those
  bars must still be refused once a reference does (Codex, PR #301). Concurrent fetches are
  coalesced (`econBars.p`): a tab coming back starts the quote poll and asks for fresh bars, and
  must make three requests at the unofficial endpoint, not six.
  **The monthly rows** (unemployment, CPI, PCE, core PCE) have no intraday series: no chart,
  caption `no 1-day data`, tooltip "a monthly indicator has no intraday series" — also when their
  official reading is `missing`. **Demo**
  draws `buildDemoBars` (seeded 5-minute bars over the last BOND session day, 00:00–17:00 ET
  like the real feed's overnight session since 2026-10-02 — NYSE trading days minus Columbus and
  Veterans Day, `BOND_ONLY_HOLIDAYS`, Codex PR #301 — `data-span` `21:00 – 14:00` Pacific, the
  evening before to the afternoon, so a demo chart carries the same `Oct 1 | 06:00 | 12:00`
  axis the live one does) and never calls the network. **Cadence:** the bars
  are fetched at once on picking 1D, alongside each quote poll (`econLiveFetch`, 60 s while the
  bond session runs, 10 min around it, hourly at weekends/holidays; concurrent with the quote and
  AWAITED, so the masthead's "Refresh now" stays pending until the bars have landed — Codex, PR #301;
  that includes a batch started by picking 1D while a forced refresh is already running: the quote
  request waits for whichever batch is in flight (`barsP || econBars.p`) and `refreshNowClicked` waits
  for `econBars.p` once its `Promise.all` has settled) and on a tab coming back
  with bars older than a minute — only while 1D is the view (`econBarsFetch` guards it too),
  never while hidden. `econLiveRepaint` redraws the yield rows in place and compares the
  chart's markup as well as the text, because new bars change no text. The first and last bar's
  Pacific clock (dated when the newest bar is not from today) is `data-span`, not a printed caption
  (see "The axes"). The
  S1/S3 console allowlist carries the chart feed's exact prefix (`OPTIONAL_FEED_CHARTS`) as
  well: S3 clicks every control, the 1D button included, and a CI runner is refused there.
  **Confirmed 2026-10-01** from the owner's screenshot of the live panel: the feed answers a page
  on this site, the URL is right and the parser read it — bars 21:02 → 14:05 Pacific, i.e. CNBC's
  chart carries the OVERNIGHT session from 00:02 ET (the demo's seeded bars match it since
  2026-10-02).
- **The axes (owner 2026-10-01: "numbers across vertical and horizontal lines", asked for on the 1D
  chart and then "every single range option"; guard S55 for every span, S58 for the 1D clock axis
  and the pure builders).** Every drawn chart has a VALUE axis on its right and a TIME axis under
  it, built by `econPlot` beside `econSpark`; the printed range caption ("Sep 24 – Oct 1",
  "21:02 – 14:05") is gone (`data-span`, the accessible name and the tooltip keep it), the only
  caption left being the `pointsNote` of a span that fell back ("monthly - 6 latest").
  *Value axis* — `econYTicks`: up to three round values (a step of 1/2/5 × 10ⁿ leaving two or
  three inside the data, never finer than the row's decimals, else the data's min and max, a flat
  series its one value); `econYAxis` puts each label at `econSparkY(v)` — the very function the line
  is drawn with — and `econSpark(points, label, grid)` draws a faint dashed `.econ-grid` line at each
  value. *Time axis* — `econXAxis` is a baseline as wide as the svg (it carries the value axis' 26px
  as a right margin), a mark per tick at `1 + 98·f` percent (the svg's own x for the point), a label
  under the major ones. `f` is `econIdxFrac`: the line is drawn in INDEX order, so an instant is
  placed between the two points around it, and a gap in the bars (or a weekend) compresses the
  marks inside it. 1D (`econXTicksIntraday`): the smallest round Pacific clock step that leaves at
  most three labels, each read off the Pacific clock at that instant (right on the clock-change
  day), the DATE where Pacific midnight falls ("Oct 1 | 06:00 | 12:00" for the real 21:02 → 14:05
  chart), an unlabelled mark at every other hour when the labels are further apart. Daily and
  monthly series (`econXTicksDates`): calendar marks — Mondays, month, quarter, half-year, year,
  every second year, every fifth — the smallest kind leaving two or three inside the span, else the
  first, middle and last reading; a month is its name with the year only at January ("Jan '26",
  "Jul"), a day "Sep 24", the long marks the year.
  *Fitting* — how many labels fit is a pixel question (232px panel, ~68px plot at the narrowest):
  after layout `econFitAxis` keeps the outermost labels first and HIDES (`.is-hide`) any that would
  touch one kept (4px) or leave the axis; `econFitValueAxis` does the same vertically (1px) and hides
  the label's gridline with it. `econWatchAxes` runs both from a MutationObserver on `#econList`
  (every update path rebuilds a row's chart), a ResizeObserver and `document.fonts.ready` — not
  rAF, which a paused test clock would stall — and the observer watches `childList` only, so
  toggling a class cannot loop.
  *Accessibility* (Codex, PR #302) — both axes are `aria-hidden` (a screen reader walking twenty
  loose numbers is noise), so `econPlot` says it all once in words — "Chart spans Sep 24 – Oct 1.
  Value axis 4.92%, 4.90%. Time axis Sep 23, Sep 28, Sep 30." — in a visually hidden `.econ-sr` node
  that is the svg's `aria-describedby` (the accessible NAME stays "label, N readings over 3M") and
  that is also returned for the row's tooltip. Before this the span the old caption carried was in
  neither. Found by the first screenshots: without the fit, "Jul 1 Aug 1
  Sep 1" and "2022 2024 2026" printed on top of each other at 232px, and two value labels touched
  on a short row (tablet/phone) — both are asserted now.
- **Deployed.** `desk-econ` went live 2026-09-30 (see Deploying above), so a live page renders
  real rows — FRED, with Treasury's daily rate on the three yields since v3 (the shared store)
  went live 2026-10-01 (until then v1's inline 5 s Treasury attempt always timed out, the yields
  were FRED's and every reply carried that ~5 s). If the function is ever down, a live page lamps the panel `STALE` and retries
  every 60s (the S1/S3 console allowlist already covers feed-origin errors).
- **Crude oil: WTI and Brent futures (owner request 2026-10-05: "add price of crude oil to the economy table").**
  Two rows right after the three yields (`econWithCrude`). The owner chose the LIVE futures price over FRED's
  EIA daily spot (`DCOILWTICO`), which on the day this was built had its newest reading on 2026-09-29 while
  the yields' was 2026-10-01 — a week behind, shown under its own date. So the rows are NOT FRED rows (nothing in
  `desk-econ` or `config/econ-indicators.json` changed; merging IS shipping) and NOT CNBC rows: the price is the
  FRONT-MONTH FUTURES `CL=F` / `BZ=F` from the quote feed the watchlists and charts already use (`deskQuote` →
  `quote-proxy` → Yahoo), fetched by the browser on its own clock (`econCrudeFetch`: 60 s while the futures market
  is open, 10 min while shut, paused while the tab is hidden, "Refresh now" forces it).
  - **Measured 2026-10-01..05 from the live site:** `CL=F` and `BZ=F` answer all three kinds (`intraday` 5-minute
    bars for 5 days, `info`, `daily` 800 bars ≈ 3.2 years) in under a second; the newest intraday bar was **10
    minutes old** at the poll (Yahoo's futures are delayed ~10 min), and `info.change` equalled the price less the
    previous daily close to the cent.
  - **The price and its time are the newest 5-minute bar** (one consistent pair; `info` is cached up to 15 min outside
    the NYSE day in `quote-proxy` and would lag the tape). **The change is that price less the previous close,
    `info.price − info.change`** — constant for the whole session whatever the price has done — and an unknown
    previous close is a null change (an em dash, never 0). **The previous close belongs to its futures session**
    (Codex, PR #308): each baseline is stored with `econCrudeSession(ms)` — a session runs from 18:00 ET to 17:00 ET
    the next day (Sunday 18:30 and Monday 16:59 are one), and the 17:00–18:00 halt is a session of its own, because
    Yahoo moves the previous close somewhere inside it. A failed `info` leg keeps the stored baseline only inside the
    session it was read in; across a turnover it is DROPPED (an em dash — a new session's price is never measured
    against the old session's close, which would show a multi-day move as today's), and `prevKey` stays the OLD
    session while the baseline is missing, so each later poll asks `info` FRESH (`{ force: true }`, past
    quote-proxy's up-to-15-minute `info` cache outside the NYSE day, which would hand the old close back) until a
    baseline from the current session lands; with one current, `info` goes back to the ordinary cached call. **A
    request that STRADDLES a turnover** (Codex, second round: the `force` decision is made when it STARTS, so a reply
    that lands after the turnover can still be the old session's cached close) never stores its baseline under the new
    session: the stored one is dropped (an em dash for that poll) and `prevKey` is set to the session it STARTED in,
    so the next poll asks fresh. **With NO baseline stored** (a cold page load, or no `info` has ever answered —
    Codex, fifth round; this was a documented residual until then) there is no "the session has ended" to see, yet the
    cache can still hold the old close: `econCrudeNearTurnover` (17:00 ET until 18:15 ET — Yahoo moves the close
    somewhere inside the 17:00–18:00 halt, and an entry cached just before the move lives 15 minutes past it) makes a
    missing baseline read FRESH inside that window and the ordinary cached call at any other time, so an ordinary cold
    load costs nothing extra. `econCrudeIntra` skips a time that does not exist (Feb 30,
    minute 70), a non-positive price and a bar from the future; it keeps the newest 24 hours, thinned to ≤ 150 real
    bars (`econDownsample`).
  - **Liveness words** (`econCrudeState`): a bar within `ECON_CRUDE_FRESH_MS` (20 min) → **DELAYED** (never LIVE:
    Yahoo runs ~10 minutes behind, and the owner's rule is to be told when it is not real time); older while the
    futures market is open (`econCrudeOpen`: Sunday 18:00 ET to Friday 17:00 ET, shut 17:00–18:00 ET Mon–Thu, NYSE
    holidays counted as shut — coarse, and it only decides the WORD for a stopped quote, since a quote that is still
    arriving reads DELAYED whatever it says) → the solid ink **NOT LIVE** chip; older with the market shut → **LAST**.
    No second source. A row keeps its last good quote for `ECON_CRUDE_KEEP_MS` (30 min, or two poll intervals when
    slower), then says **NO DATA** with the feed's reason in its tooltip. Before the first reply there are no oil rows;
    if desk-econ has delivered nothing AND the quote feed has nothing usable, the panel's own empty state says so once
    instead of two lonely NO DATA rows.
  - **Charts:** 1D is the last **24 hours** of 5-minute bars (futures trade round the clock, so a 1D view is a rolling
    day, not a session; the caption carries BOTH dates — a day ending on the clock time it began would read as one
    instant); 1W–5Y are the daily closes sliced exactly like every other daily row (`econSpanSlice`, shared with the demo),
    and because the feed holds ~3 years a 5Y chart says `since Aug '23` (`pointsNote`) rather than pass for five. The daily
    bars are re-asked every 5 minutes (`ECON_CRUDE_DAILY_MS`); the oil charts redraw on a span pick without waiting for
    desk-econ (their history is already here).
  - **Presentation:** `pre: '$'` — `econValueText` prints a currency sign BEFORE the number; the change is in dollars
    (`▲ 1.25`, digits green/red by the panel's own direction rule); the date cell is the Pacific CLOCK of the newest bar
    when it is from today; the source line reads `Source: Yahoo CL=F`. A currency row's chart gets `.is-px`: a 38px value
    axis (`--econ-yw`, now on `.econ-chart` so the time axis reads it too) and labels at the fewest decimals that show
    every value EXACTLY (`econYAxis(…, px)`: "90", "90.5" — never 100.5 as "101"); a yield keeps its own decimals.
  - **Never NEW** (a price ticking by the minute is not a release: the oil rows skip the seen/pending bookkeeping), **never
    demo from the network** (`?demo=1` draws seeded rows, `buildDemoEcon` / `buildDemoCrudeBars`; live strips any generated
    oil row from a payload), and **never a CNBC quote** (`econLive.q` never holds one; S56/S57 assert that no YIELD is asked
    of the quote feed, which is why their stubs now let `CL=F` / `BZ=F` through).
  - **Every leg names its failure on the row** (Codex, PR #308, sixth round, with the same rule applied to its
    sibling): the price (`crude.why`, from `m.why`/`m.detail`) — "the last refresh of the price failed (…); this is the
    price read N min ago", cleared by the next good read, the age measured from the READ (`fetchedAt`), not from the
    bar; the previous close (`crude.chgWhy`, from `m.infoWhy`) — "no change shown: …" when the change is a dash (the
    leg failed, answered without a close, or its reply crossed a turnover), or "the last refresh of the previous close
    failed (…); the change uses the close read earlier in this session" when a baseline from this session stands;
    and the history (next bullet). A retained value must never read as current.
  - **The history leg fails loudly too** (Codex, PR #308, third round): the 1W–5Y charts come from the DAILY leg and the
    price from the intraday leg, so a failed daily refresh used to leave the row `ok` while its history aged in silence.
    A failed daily leg is recorded (`m.dailyWhy`, cleared by the next success) and follows the price's own rule: the last
    good series is KEPT for `keep` (30 min, from `dailyAt`) with the failure named in the tooltip (`crude.histWhy`: "the
    last refresh of the 1W–5Y history failed (…); the charts show the history read N min ago"), then the chart is DROPPED
    — caption `no chart`, tooltip "no 1W–5Y chart: <reason>" — never an ageing chart that looks current. The daily bars
    are re-asked on every poll once they are 5 minutes old, so a recovery brings the chart straight back.
  - **The in-place repaint follows the COMPOSED panel** (Codex, PR #308, fourth round): `econCrudeRepaint` redraws the oil
    rows alone (a price ticks every minute; a whole-panel rebuild restarts every NEW watch), but it first asks
    `econWithCrude` whether the composed panel carries the oil rows at all. With desk-econ empty and both quotes gone the
    composition drops them so the panel's own empty state speaks ONCE; rows already in the page must not turn into two lonely
    NO DATA rows, so whenever what should be drawn differs from what is (rows to remove, or missing ones to restore when the
    feed returns) the whole panel is composed again with `renderEcon(econState.shown)`. With desk-econ rows present the oil
    rows still say NO DATA IN PLACE and the yields' nodes are left alone.
  - Covered by S63 (the pure parsers, the session clock, the liveness words, the polling, the spans, outage and recovery,
    "Refresh now", a hidden tab, the session baseline, a request that straddles a turnover and a failed history refresh, the composed empty state, the cold-load window and the price and change notes; 53 mutants caught) and S55 (nine rows, both axes on every span, the wider value axis).
