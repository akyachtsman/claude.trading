# Economy panel and `desk-econ`

The Economy indicators feed (`supabase/functions/desk-econ`, `config/econ-indicators.json`, `tools/econ-check.mjs`): sources, refresh policy, contract and limits. Owner request 2026-09-30; full contract in `specs/economy-indicators/spec.md`. Backend **deployed** 2026-09-30 (owner-approved, v1, `verify_jwt` ON — see Deploying below) and the panel UI built the same day (see "The panel (UI)" below; guarded by S55). Later the same day the owner asked for CURRENT 2Y/10Y yields, so the roster switched Treasury's same-day daily rate ON for the three yields (see Sources and Deploying). On 2026-10-01 a throwaway probe measured Treasury from Supabase's servers: the right data, but 17–20 s per request — so v2 fetches it in the BACKGROUND and a reply never waits on it. **v2 is NOT deployed** (owner approval pending); live is still v1, whose 5 s Treasury limit always times out, so the live yields are still FRED's.

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
  spine = `stale` or `missing`), a validated print is kept 72h so a flaky host cannot flip a
  yield back to T-2, and a failed fetch (5xx, block page, timeout) backs off 10 min. Columns
  are looked up BY NAME (Treasury inserted `1.5 Month` in 2025, shifting every later column).
  **Known residuals** (found when the tail went ON, 2026-09-30, revised 2026-10-01; accepted,
  not fixed): (a) the 72h "never flip back" store is per server INSTANCE — and since v2 fetches
  in the background, EVERY fresh instance's first reply is FRED (its store is empty), so a
  yield row steps back a day whenever a poll lands on a fresh instance, until that instance's
  fetch lands (~20 s; the reply tells the client to come back in 30 s), and its NEW chip (keyed
  on date + value) can re-flag meanwhile; the clean fix is a client rule that never steps a
  daily row's date backwards, or a store shared across instances; (b) a single date where
  Treasury and FRED disagree (a revision FRED has not picked up) makes that row drop the whole
  Treasury tail until FRED catches up; (c) *(superseded 2026-10-01: "may refuse data-centre
  addresses or be slower than the 5s timeout" — measured: NOT refused, but 17–20 s, so the 5 s
  limit failed every time)* a day slower than v2's 45 s bound is a silent FRED fallback with a
  10-min back-off, visible only in the function log; (d) the background fetch only helps if
  the instance LIVES past the reply (`EdgeRuntime.waitUntil`) and the NEXT request reaches the
  SAME instance. Neither is guaranteed, and this repo has measured both going wrong before:
  `desk-charts` found requests spread over short-lived isolates ("nearly every request was
  already sweeping", `edge-feeds-and-heatmap.md`), and `desk-heatmap` records that
  "waitUntil-style background work proved unreliable here (steps never ran post-response)".
  If instances are rarely reused, the tail rarely reaches a reply AND the 30 s cap keeps an
  open tab polling every 30 s (7 FRED + 2 Treasury fetches each). Check both in the logs after
  the v2 deploy; the durable fix is the shared store in (a) (e.g. `desk_feed_cache`, which
  needs the service key — an owner decision).
- **Treasury in the background (v2, 2026-10-01 — NOT deployed yet).** `refresh()` never awaits
  Treasury: after the FRED sweep it calls `kickTreasury()`, which starts ONE fetch pair
  (current + previous NY month, in parallel; `treasuryInflight` makes it single-flight per
  isolate, so concurrent requests share it), hands it to `EdgeRuntime.waitUntil` when that
  exists so the worker outlives the reply, bounds each request at **45 s** (`TREASURY_TIMEOUT_MS`;
  observed 17–20 s) and returns at once; the rows are then built from whatever the store held
  (FRED alone on a cold isolate) — kicked right before the synchronous build, so a fetch
  started there can never land between building those rows and caching them. Whether to start
  one is `treasuryWanted()`: never while one is in flight or during the 10-min back-off; always
  when nothing is held; never once the store holds TODAY's (NY date) rate for every column the
  roster names (it is final); otherwise every 5 min from 15:25 ET to midnight on a weekday
  (`treasuryPosting()`) and hourly at any other time. When a fetch merges something new it
  sets the cached dataset's `expiresAt` to 0 IN PLACE — never nulls it, because the
  whole-refresh-threw path serves the last good one — so the very next request re-sweeps FRED
  and serves the tail, with `changed` true like any new reading. While a fetch is in flight the
  dataset's TTL is capped at **30 s** (`TREASURY_PENDING_TTL_MS`), so `refreshInSec` brings the
  client back to collect it instead of in 15 minutes; it is not capped otherwise. The
  background chain never rejects (an unhandled rejection ends a Deno worker) and a failed fetch
  never changes a reply. `treasuryIdle()` is exported for the checks only.
- **Live-yield candidates, measured from Supabase 2026-10-01 (for the record; none is used).**
  CNBC's quote API: HTTP 403 "Access Denied" (Akamai) — dead. Stooq's yield symbols `2yusy.b` /
  `10yusy.b`: timed out at 20 s — dead. Yahoo `^TNX` (the CBOE 10-year yield index): HTTP 200 in
  ~85–110 ms with a live quote — usable for a future live 10Y, not part of this change.
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
  weekends, ≤2 min while any row is degraded, ≤30 s while a background Treasury fetch is in
  flight (v2). The client is told when to ask
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
- **Checks.** `npm ci --prefix tools` once (installs the esbuild pinned in `tools/package.json`; the check never downloads anything itself), then `node tools/econ-check.mjs` (29 checks, fresh `vm` isolate each,
  stubbed `fetch`, settable clock, real FRED captures + constructed Treasury
  fixtures + the REAL Treasury head captured from Supabase under `tools/fixtures/econ/`; the
  harness serves the COMMITTED roster, and the no-Treasury path is tested on that roster with
  its `treasury` keys stripped); `--mutants` proves 44 single-line source mutants plus 3
  damages to the shipped roster (a re-blanked, a wrong and a swapped Treasury column) are each
  caught (47/47 on 2026-10-01; 36/36 before the background fetch). A Treasury outage — 503,
  403 or 200 block page, network error, a hung host cut off by its `AbortSignal` — is checked
  to leave all seven rows served from FRED, HTTP 200, none missing, before and after the failed
  fetch. A Treasury that answers only when the test releases it must not delay any reply
  (first reply FRED within 2 s of real time, `refreshInSec` ≤ 30, one fetch pair handed to
  `waitUntil`, none started during the flight even past the 5-min cadence; on landing the
  cached body is expired and the next reply serves the tail with `changed:true`); a "30 s"
  answer still lands under the 45 s bound (time scaled); the cadence (today's rate final,
  5 min in the posting window incl. 23:00 ET, hourly otherwise, the back-off beating the
  5-min mark) is checked; and the real rows parse with `\n` and `\r\n`, equal the FRED capture
  on 09-28 and append 09-29/09-30 onto it.
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
  Pages roster DIFFER until v2 is deployed: `roster.source:"default"` on v1 now means the
  yields are on FRED — see below.)*
  The repo spells the BOM strip `/^\uFEFF/`; the payload sent used the same escape, and
  the read-back may show the literal character instead — the same regex either way.
  **Treasury tail ON (2026-09-30, owner request) — NOT redeployed.** The live function is
  still v1, whose built-in default names no Treasury column. But v1 (deployed from `f78a03f`,
  the same source as this file before the roster change) already carries the whole Treasury
  path and reads the roster from Pages at runtime (cached 1h), so the three Treasury columns
  take effect on the LIVE function within about an hour of `config/econ-indicators.json`
  reaching Pages (the merge to `main`) — a merged roster edit IS a live change, deploy or
  not. A v2 deploy (the built-in default naming the same three columns, so a Pages outage
  does not drop the yields back to FRED) awaits the owner's separate approval. The Treasury
  path is UNVERIFIED AGAINST THE LIVE HOST until it has run from Supabase: after Treasury
  posts (inside 15:25–18:30 ET), `ust10y.source` should read `"treasury"` with today's `asOf`;
  if it never does, the rows are silently on FRED — read the function logs for
  `desk-econ: Treasury` / `treasury disagrees` / `no overlap` lines. *(Superseded 2026-10-01:
  it ran, and never did — see the next paragraph.)*
  **2026-10-01 — live v1 never serves Treasury; v2 fixes it but is NOT deployed.** With the
  roster on Pages, live v1 asks Treasury on every refresh, INLINE, with a 5 s limit; the live
  logs show `desk-econ: Treasury 202609 failed: Signal timed out` each time (then a 10-min
  back-off), so the live yields are still FRED's — safe, a day behind. The throwaway
  `desk-probe` (owner-approved 2026-10-01, `verify_jwt` ON, self-expiring at
  2026-10-01T04:00:00Z; source in `supabase/functions/desk-probe/`; the Supabase tools cannot
  delete a function — delete it from the dashboard) then measured why: 17–20 s per request
  (see Sources). The fix is v2's background fetch (above), in this repo and checked, deployed
  only on the owner's approval, `verify_jwt` ON as v1. After the deploy, verify: a cold
  reply's `refreshInSec` is 30 and its yields are FRED; the next poll ~30 s later reads
  `ust10y.source:"treasury"` (today's `asOf` once Treasury has posted, else the prior business
  day's); the logs carry no `Signal timed out`; and the invocation rate per open tab drops
  back to the release-window / quiet cadence once the tail is held (if it stays at one call
  per 30 s, residual (d) is happening).

## The panel (UI) — `scripts/app.js` Economy block, `styles/components.css` `.econ-*`

Built 2026-09-30 into the desk row's 4th slot (`<aside class="panel area-econ">`).
Everything for it sits in ONE block of `app.js` (before the widgets section) plus
`deskEcon()` / `buildDemoEcon()` in `data.js`; `index.html` keeps the bare placeholder it
shipped with — `econChrome()` builds the span control, the list, the source note and the
header's `#econStamp` itself. Guard: **S55** (S5 also names `#econLamp`; S54 holds the slot's
width).

- **Rows.** One `<li class="econ-row">` per indicator: label / value / change / the date
  the reading is FOR at the left (a fixed 104px block, so every chart starts on one line),
  ITS OWN chart to the right (`econSpark()`: an inline SVG path built with `createElementNS`,
  the watchlist sparkline idiom, no axes; x = index order, y = the row's own min/max; a flat
  series is a level line through the middle; fewer than two real values draws a DASHED
  PLACEHOLDER, never an invented line). `pointsNote` ("monthly - 6 latest") is the caption
  under the chart (`.econ-note`); otherwise the caption is the chart's first and last date.
- **Neutral colour.** Green/red are P&L-only on this desk and a yield or inflation rate
  rising is not a gain: the change is neutral ink with an arrow (`▲` `▼`, `=` for a real
  zero), the line is the brass accent. S55 scans every element's computed colour against the
  gain/loss tokens.
- **Decimals and dates.** Value and change print at the row's own `decimals`; null/NaN is an
  em dash through `fmtToNum` — never `0.00%`. A daily reading is `Sep 29`; a monthly one names
  its MONTH (`Aug`, the year only when it is not this one), by string slicing — never
  `new Date('2026-08-01')`, which is UTC midnight and reads Jul 31 in Pacific. The date is
  deliberately prominent: a yield is a daily RATE — today's only once Treasury has posted it
  (late afternoon ET), otherwise the previous business day's, and older when only FRED has it.
  (Until 2026-09-30's switch this read "the feed is FRED-only".) The source note under the list
  is true on both paths ("Yields: U.S. Treasury's daily rate (3:30 pm ET snapshot) once posted, else
  FRED …"), and each row's tooltip names its own `source` ("source U.S. Treasury daily rate" /
  "source FRED") — never "same day": before today's rate posts, Treasury supplies YESTERDAY's,
  and `asOf` is what says so (Codex, PR #295).
- **Status.** `missing` (or a null value): em dashes, a dashed placeholder, a `NO DATA` tag.
  `stale`: the row keeps its last good value and chart (spec §8), muted, tagged `STALE`
  (the tooltip carries the age).
- **Span.** `#econTf` is the shared `.seg` chrome: 1W 1M 3M 6M 1Y 5Y, default **3M**,
  persisted in `localStorage` `econ_tf_v1` and validated against the list on load (a bad
  value falls back). There is NO 1D (the control's `title` says so). In demo a pick rebuilds
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
  windows, to 30s while a background Treasury fetch is in flight (v2), and relaxes it at
  weekends), scheduled by `econArm()`. A failed poll retries in 60s.
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
- **Deployed.** `desk-econ` went live 2026-09-30 (see Deploying above), so a live page renders
  real rows — FRED, with Treasury's daily rate on the three yields once v2 (the background
  fetch) is deployed; v1's inline 5 s Treasury fetch always times out, so until then the yields
  are FRED's. If the function is ever down, a live page lamps the panel `STALE` and retries
  every 60s (the S1/S3 console allowlist already covers feed-origin errors).
