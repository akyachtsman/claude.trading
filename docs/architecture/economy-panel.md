# Economy panel and `desk-econ`

The Economy indicators feed (`supabase/functions/desk-econ`, `config/econ-indicators.json`, `tools/econ-check.mjs`): sources, refresh policy, contract and limits. Owner request 2026-09-30; full contract in `specs/economy-indicators/spec.md`. Backend **deployed** 2026-09-30 (owner-approved, v1, `verify_jwt` ON — see Deploying below) and the panel UI built the same day (see "The panel (UI)" below; guarded by S55).

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
- **Checks.** `npm ci --prefix tools` once (installs the esbuild pinned in `tools/package.json`; the check never downloads anything itself), then `node tools/econ-check.mjs` (24 checks, fresh `vm` isolate each,
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
  deliberately prominent: the feed is FRED-only, so a yield is about a business day old.
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
- **Deployed.** `desk-econ` went live 2026-09-30 (see Deploying above), so a live page renders
  real FRED rows. If the function is ever down, a live page lamps the panel `STALE` and retries
  every 60s (the S1/S3 console allowlist already covers feed-origin errors).
