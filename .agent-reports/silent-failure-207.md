# Silent-failure audit — merged commit `3cf7b76` (PR #207, "Close the four extended-hours review findings")

Scope: the diff of `3cf7b76` plus the code paths it feeds into. Post-merge review — findings only, no
edits made. Line numbers are against the current working tree (HEAD `fa46049`), which has not touched
any of these files since #207.

Bias applied throughout, per the project's own rule set: **an absent extended-hours print means "did not
trade after hours" and is never rendered as 0.** That contract turns every silent fetch failure in the
enrichment path into a *false factual claim*, not a missing feature. That is why several of the findings
below are rated higher than a generic "best-effort call failed" would be.

Verified evidence collected during the audit:
- `grep -c 'console\.'` returns **0** for `desk-market/index.ts`, `desk-heatmap/index.ts`, and
  `quote-proxy/index.ts`. Every catch block in the extended-hours path is completely silent.
- `desk-heatmap`'s `quoteBatch` swallows all per-batch errors internally and **never rejects**.
- `wbInfoCache` (app.js:2720) has exactly four references and no delete/TTL — it is a permanent
  per-page cache.
- The Markets *render* path gates on `kind === 'post'` (app.js:158-159, 210); the new *ask-context*
  and *stamp* paths do not.

---

## F1 — CRITICAL — Ask context ships pre-market and index-repeat prints labelled "afterHours"

**Location:** `/home/user/claude.trading/scripts/app.js:1603-1610` (`buildAskContext`)

```js
...(m.ext ? { afterHoursLast: m.ext.last, afterHoursChgPct: m.ext.chg } : {}),
...(m.extProxy ? { afterHoursProxy: m.extProxy.sym, afterHoursProxyChgPct: m.extProxy.chg } : {}),
```

**Failure scenario.** `desk-market`'s `extFrom` (`supabase/functions/desk-market/index.ts:328-349`)
returns `{ kind: 'pre', ... }` whenever `postMarketPrice` is absent but `preMarketPrice` is present —
i.e. every fetch between 04:00 and 09:30 ET. The rendering path filters this out
(`t.ext.kind === 'post'`, app.js:158-159 / 210) exactly because the owner ruled pre-market is not to be
displayed. **`buildAskContext` has no such filter.** At 07:00 ET the assistant receives
`afterHoursChgPct: -0.42` for a tile, and will answer "QQQ is down 0.42% after hours" when that is a
*pre-market* move. The owner cannot cross-check it, because the desk deliberately renders nothing
pre-market — the number exists only inside the model's context.

**Second, worse case in the same expression.** `nameToSym` in `desk-market` (index.ts:485-487) covers
**every** `MARKET_SYMBOLS` entry, including the pure indices `^GSPC` / `^IXIC` / `^DJI` / `^VIX`. When
Yahoo echoes a `postMarketPrice` for an index (it repeats the close — the measured `^GSPC 7428.78 held
flat 16:00→17:10` behaviour recorded in CLAUDE.md), `t.ext` is populated on the index tile with a
compounded pct ≈ its regular pct. The render path suppresses this by preferring `extProxy`
(app.js:158) — a precedence rule that *only exists because both fields can be present at once*. The ask
context sends **both**, unordered:

```
{ name: "S&P 500", dayChgPct: -1.20, afterHoursChgPct: -1.20,
  afterHoursProxy: "SPY", afterHoursProxyChgPct: -1.45 }
```

The model is now free to report "the S&P 500 was down 1.20% after hours" — a fabricated claim about an
instrument that has no extended session, which is precisely the instrument-wearing-the-wrong-name trap
the whole `EXT_PROXY` design (and the deliberate VIX exclusion) exists to prevent. **VIX also leaks
here**: it is excluded from `EXT_PROXY` on purpose but is still in `nameToSym`, so its own `ext` reaches
the assistant unfiltered.

**Third, minor:** the `IWM (R2K proxy)` tile is in both `nameToSym` and `EXT_PROXY`, so it emits
`afterHoursChgPct` and `afterHoursProxyChgPct` with identical values — the model may double-report it as
two instruments.

**Hidden errors / what this masks:** nothing throws. There is no failure to observe — the context is
built successfully with mislabelled data, so no lamp, no log, and no test catches it.

**User impact:** the assistant states after-hours figures that are (a) pre-market, or (b) an index's own
close repeated, both with full confidence and both contradicting the panel beside them. This is a
wrong-but-plausible financial number reaching the owner through the one surface with no visual
cross-check.

**Recommendation.** Mirror the render path's gate and precedence exactly, in one place:

```js
market: (d.market || []).map(m => {
  const xt = (m.extProxy && m.extProxy.kind === 'post') ? m.extProxy
           : (m.ext && m.ext.kind === 'post' && !EXT_INDEX_NAMES.has(m.name)) ? m.ext
           : null;
  return {
    name: m.name, last: m.last, dayChgPct: m.chg,
    ...(xt ? {
      afterHoursSymbol: xt.sym || m.name,   // names the instrument, always
      afterHoursLast: xt.last,
      afterHoursChgPct: xt.chg,
    } : {}),
  };
}),
```

Better still: have `renderMarkets` and `buildAskContext` call a single shared
`extLineFor(tile)` helper so the two can never drift again — the drift is the bug.

**Follow-up PR: YES, highest priority.**

---

## F2 — HIGH — The new `extAt` stamp branch mislabels pre-market and runs away overnight/weekend

**Location:** `/home/user/claude.trading/scripts/data.js:927-932` (`liveLampFor`)

```js
if (extAt && closeIso && new Date(extAt) > new Date(closeIso)) {
  return { cls: 'lamp--eod', text: 'EOD',
           stamp: fmtUpdated(extAt, dataAsOf, 'age') + ' — after hrs',
           atIso: extAt, asOf: dataAsOf, tail: 'age', stampSuffix: ' — after hrs' };
}
```

Two independent defects, both reachable on healthy data.

### F2a — pre-market prints are stamped "after hrs", with a mismatched date

`desk-market:525-529` builds `extAt` from `r.ext?.at` / `r.extProxy?.at` **without checking `kind`**.
At 06:25 ET on a trading day: `asOf` is the *prior* trading day (it comes from the daily-close series),
so `closeIso` = prior day 16:00 ET; `extAt` = today 06:25 ET (a pre-market `postMarketTime`… strictly a
`preMarketTime`) — which is `> closeIso`, so the branch fires.

`fmtUpdated` then pairs `fmtClockBare(extAt)` (data.js:824, **today's** Pacific clock) with
`fmtShortDate(asOf)` (data.js:814, **yesterday's** date). The Markets panel renders:

> `Last updated 03:25, Jul 30, delayed by 5 minutes — after hrs`

when 03:25 was Jul **31**, and the session was **pre**-market. Meanwhile the tiles render *no* extended
line at all (`kind === 'post'` filter), so the stamp is making a freshness claim about a number that is
not on the screen.

### F2b — an unbounded, minutes-only "delayed by" figure after hours

`fmtDelay` (data.js:833-839) formats in whole minutes with **no cap and no hours/days rollup**. Yahoo
retains `postMarketPrice`/`postMarketTime` overnight and across the weekend, so `extAt` stays populated
and stays `> closeIso` the entire time. Observed consequences on a perfectly healthy feed:

| when | rendered stamp |
|---|---|
| Thu 23:00 ET | `Last updated 16:59, Jul 30, delayed by 361 minutes — after hrs` |
| Fri 03:00 ET | `… delayed by 601 minutes — after hrs` |
| Sun 12:00 PT | `… delayed by ~2580 minutes — after hrs` |

`retickStamps` (app.js:4351-4357) recomputes this every 30s, so it counts up visibly. This directly
re-introduces the thing the 2026-07-28 owner ruling removed: *"after the bell the print is FINAL, not
lagging, so an ever-growing delay figure would read as a fault when nothing is wrong."* The old code
avoided it with `tail: 'close'`; the new branch switched to `tail: 'age'` and lost the protection.

**Hidden errors:** none thrown. Both defects render confidently.

**User impact:** the panel the owner reads to decide whether to trust a number tells them it is 43 hours
behind — on a healthy feed, over a weekend — and mislabels pre-market as after-hours with the wrong
date. The exact failure mode the stamp exists to prevent.

**Recommendation.**
1. Filter `extAt` server-side by session: in `desk-market:525-528`, only collect `at` from entries with
   `kind === 'post'`, so a pre-market timestamp can never reach `liveLampFor`.
2. Bound the stamp to the window where the number is actually moving. Use `tail: 'age'` only while
   `postMarketOpen()` (data.js:729 — already exists and is already imported into this file's scope);
   outside 16:00–20:00 ET use a static tail so it reads
   `Last updated 16:59, Jul 30, after hrs close` rather than a growing delay.
3. Teach `fmtDelay` to roll up past ~90 minutes (`delayed by 2h 41m`) regardless — a four-digit minute
   count is unreadable on any stamp.

**Follow-up PR: YES.**

---

## F3 — HIGH — The heatmap merge mixes bases: screener regular-% with a Yahoo-derived extended-%

**Location:** `/home/user/claude.trading/supabase/functions/desk-heatmap/index.ts:551-559`

```js
if (withinPostMarket()) {
  try {
    const ext = await quoteBatch(constituents.map((c) => c.sym), await getCrumb());
    for (const [sym, q] of ext) {
      const base = quotes.get(sym);
      if (base && q.extPct != null) { base.extPct = q.extPct; base.extLast = q.extLast ?? null; }
    }
  } catch { /* extended lines only — the core payload stands */ }
}
```

**Failure scenario.** `base` comes from `parseScreener` (index.ts:146-169): `base.pct` is Nasdaq's
`pctchange`, `base.last` is Nasdaq's `lastsale`. `q.extPct` is computed inside `quoteBatch`
(index.ts:216-227) as `((1 + yahooRegPct/100) * (1 + postPct/100) - 1) * 100` — i.e. it is anchored to
**Yahoo's** `regularMarketChangePercent`, a different source and a different snapshot instant from the
screener's. The merge writes the Yahoo-derived extended figure onto the screener's regular figure and
never reconciles them.

The tooltip (app.js:2116-2126) then prints both side by side under the stated contract that both measure
from the same prior close. A reader deriving the after-hours-only move as `extPct − pct` gets a number
that is wrong by the screener/Yahoo disagreement.

**The pathological case is not hypothetical.** `parseScreener:153` does:

```js
const pct = rawPct === '' || rawPct === '--' ? 0 : Number(rawPct);
```

A missing or `--` screener `pctchange` is **fabricated as 0** — "flat today". For any such name the tile
tints neutral and reads 0.00%, while the merged tooltip shows a real compounded after-hours percentage
built on Yahoo's non-zero regular move. Two numbers on one tooltip that cannot both be true. (The `0`
fill is pre-existing, but before #207 nothing else on the tile contradicted it; the merge is what makes
it visible and wrong.)

**Recommendation.** The merge already has the authoritative Yahoo regular figure in hand — carry it
through instead of discarding it:

```js
if (base && q.extPct != null) {
  base.pct  = q.pct;              // same source as extPct — one basis, one instant
  base.last = q.last ?? base.last;
  base.extPct  = q.extPct;
  base.extLast = q.extLast ?? null;
}
```

Separately, `parseScreener:153` should be `continue` (drop the row) rather than `pct = 0` — a fabricated
0 is the precise thing this codebase's own comments forbid two lines away.

**Follow-up PR: YES.**

---

## F4 — HIGH — `desk-heatmap`'s `quoteBatch` never rejects, so the merge's `try/catch` guards almost nothing

**Location:** `/home/user/claude.trading/supabase/functions/desk-heatmap/index.ts:190-235` (definition),
consumed at `:553`

```js
async function quoteBatch(symbols, auth, batchSize = 150) {
  const out = new Map(); let deadStreak = 0;
  for (let i = 0; i < symbols.length; i += batchSize) {
    if (deadStreak >= 2) break;                      // <— silent early exit
    ...
    try { ... if (!res.ok) throw new Error(`HTTP ${res.status}`); ... }
    catch { deadStreak++; }                          // <— swallowed, no log
  }
  return out;                                        // <— always resolves
}
```

**Failure scenario.** ~500 S&P constituents at `batchSize: 150` is 4 batches. If batches 1 and 2 both
fail — a 401 on a rotated crumb, a Yahoo 429, a transient network error — `deadStreak` reaches 2 and the
loop **breaks**, returning a partial or empty map with a resolved promise. The caller's
`catch { /* extended lines only */ }` at `:558` **never fires**, because nothing was thrown. The merge
loop simply iterates a short map.

Result: 0 (or 150, or 300) of ~500 names receive `extPct`. Every name that didn't renders as
`t.extPct == null` → app.js:2120 skips the `.tip-ext` block entirely → the tooltip reads exactly as it
does for a genuinely untraded name. **A fetch failure is indistinguishable from the factual claim "this
name did not trade after hours."** The payload's own comment (index.ts:99-101) states that distinction
is the point.

**Hidden errors the two catch blocks conceal:** Yahoo 401 (invalidated crumb), 429 (rate limit), 5xx,
DNS/TLS failure, `res.json()` parse failure on an HTML error page, and — per this project's own
hard-won lesson recorded in CLAUDE.md — any Supabase-side auth rejection triggered by a browser-shaped
UA. None of them produce a single log line anywhere (`console.*` count in this file: **0**).

**The same bug was fixed in `desk-market` in this very review round and not ported here.**
`desk-market/index.ts:294-303` gained an explicit 401 retry with the comment: *"A crumb can be
invalidated before YAUTH_TTL_MS expires, and silently skipping the batch meant the extended lines
vanished for a whole closed-market TTL — the empty result gets cached (Codex review, PR #199)."*
`desk-heatmap`'s `quoteBatch` has **no 401 retry**, and its `getCrumb()` (`:180-188`) has **no caching**
— a fresh two-request handshake on every rebuild, which is the most 401-prone shape available. The
empty result is then cached at `:585` (`payloadCache.set('sp500', ...)`) for the full TTL, exactly as
described.

**Recommendation.**
1. Port the 401 retry from `desk-market:299-303` into `desk-heatmap`'s `quoteBatch`.
2. Have `quoteBatch` report coverage so the caller can act on it — e.g. return
   `{ quotes, attempted, answered }`, and have the merge site treat
   `answered < attempted * 0.8` as a failure of the enrichment.
3. When the enrichment does not achieve full coverage, **do not publish a half-populated map**. Either
   omit `extPct` from every tile in that body, or add a payload-level flag
   (`extCoverage: 0.42`) that the client can surface, so "no after-hours print" and "we could not fetch
   after-hours prints" are visibly different states.
4. `console.warn` on every swallowed batch. Silent is not an option in a function whose failure mode is
   a false financial claim; CLAUDE.md's own runbook depends on being able to see this in Supabase logs.

**Follow-up PR: YES.**

---

## F5 — HIGH — The heatmap panel stamp still claims "at close" while its tooltips show after-hours prices

**Location:** `/home/user/claude.trading/scripts/app.js:2560`

```js
heatBase = { hm, lamp: liveLampFor(hm.generatedAt, hm.asOf, true) };
```

**Failure scenario.** #207's stated purpose was to stop the stamp claiming 4pm while an after-hours
price sits beside it — and it threaded `extAt` into the Markets lamp (app.js:4287-4288) and the masthead
(app.js:60). It did **not** thread it into the heatmap, the panel whose after-hours tooltips this same
commit made work for the first time. At 17:30 ET the heatmap panel stamp reads
`Last updated 13:00, Jul 30, at close` while hovering any tile shows an `After hours` line printed at
17:28. Same defect, same commit, opposite panel.

Note `hm` carries no `extAt` at all — `desk-heatmap`'s payload (index.ts:580-583) publishes
`asOf / generatedAt / periodsAsOf` and nothing extended-related. So this is a two-sided fix: the
function must publish an extended instant, and the client must pass it.

**Compounding: the heatmap keeps a stale lamp on poller failure.** `app.js:2564`:

```js
if (heatBase) return; /* poller failure: keep the last good map */
```

`refreshMarket` was explicitly fixed (app.js:4291-4305, and its long comment) to *re-lamp* on failure so
a frozen number stops asserting LIVE. `loadHeatmap` returns before re-lamping, keeping both the last
good tiles **and** the last good lamp. Before #207 this was tolerable — after the close the heatmap's
numbers genuinely stopped changing. Now they change every few minutes during post-market, and a dead
poller leaves the last after-hours snapshot on screen under an unchanged lamp with no age signal at all
(the `at close` stamp is static and is not re-ticked by `retickStamps`, which only touches
`[data-stamp-tail="age"]`).

**Recommendation.** Publish `extAt` from `desk-heatmap` (max `postMarketTime` across merged tiles, gated
to `kind === 'post'`), pass it into `liveLampFor` at app.js:2560, and add the `relampMarket()`-equivalent
call to the `loadHeatmap` failure path so a stalled heatmap ages honestly.

**Follow-up PR: YES — fold into the same PR as F2/F3.**

---

## F6 — MEDIUM — Heatmap after-hours tooltips silently vanish around 21:00 ET

**Location:** `/home/user/claude.trading/supabase/functions/desk-heatmap/index.ts:98` and `:551`

The merge is gated on `withinPostMarket()` (16:00–20:00 ET). `ttlMs()` returns 300_000 inside that
window and 3_600_000 outside it. So:

- 19:58 ET — a body is built **with** extended prints, cached.
- 20:58 ET — that body expires; the next request rebuilds with `withinPostMarket()` now `false`; the
  merge is skipped; **every tile's `extPct` disappears**.
- Meanwhile `desk-market`'s ext block (index.ts:483-518) is **not** session-gated and Yahoo retains
  `postMarketPrice` all night, so the Markets panel keeps showing `SPY −1.14% after hrs` until the next
  pre-market.

An owner looking at the desk at 21:30 ET sees the Markets panel reporting after-hours moves and the
heatmap reporting, for all ~500 names, that none of them traded after hours. Under the payload's own
absent-means-did-not-trade contract that is a false claim, and there is no lamp, stamp, caption or log
distinguishing it from the truth.

**Recommendation.** Either widen the merge gate to match `desk-market`'s behaviour (no session gate; the
cost is naturally bounded by the 60-min closed TTL), or — cheaper — keep the gate but retain the
previous body's `extPct`/`extLast` when rebuilding outside the window, since those values genuinely do
not change after 20:00. Whichever is chosen, the two panels must agree.

**Follow-up PR: YES (low effort, fold in with F3).**

---

## F7 — MEDIUM — The Russell 2000 heatmap never gets extended prints, silently

**Location:** `/home/user/claude.trading/supabase/functions/desk-heatmap/index.ts:590-614` (`refreshR2k`)

The merge was added only to `refreshSp500`. `refreshR2k` runs `nasdaqScreener()` and goes straight to
`buildHeatmap` with no Yahoo pass, so every one of its ~1,500 tiles carries `extPct == null`. The commit
message says "the heatmap"; the map-filter UI presents S&P and Russell 2000 as peer cuts with identical
tooltips. Switching cuts silently changes whether after-hours data exists, with nothing on screen saying
so.

Arguably a scope decision (an extra 10 batched calls over 1,500 names) rather than a bug — but per
CLAUDE.md's *"never silently shrink an expected scope"* rule, the shrink is currently undisclosed
anywhere: not in a caption, not in the payload, not in the spec.

**Recommendation.** Either extend the merge to `refreshR2k`, or add an explicit payload field
(`extSupported: false`) that the tooltip surfaces as "after-hours not available on this cut". Do not
leave it as a bare absence.

**Follow-up PR: YES (or an explicit owner decision recorded in the spec).**

---

## F8 — MEDIUM — The new charts "AFTER HRS" line is frozen for the life of the page

**Location:** `/home/user/claude.trading/scripts/app.js:3004-3010` (render), `:2720` + `:2937-2951`
(the cache behind it)

```js
const wbInfoCache = {};                       // :2720 — no TTL, never deleted
...
if (sym in wbInfoCache || wbInfoPending.has(sym)) return;   // :2939
```

`wbInfoCache` has four references in the whole file and **no invalidation path** — not on the feed
poller, not on `Refresh now`, not on visibility change. Once a symbol's `info` is fetched it is frozen
until the page is reloaded. Two concrete wrong outputs, both new with #207 because #207 is what attached
a *time-varying* value to this frozen cache:

- **Stale-forever after-hours price.** Load QQQ at 16:05 ET. The readout shows
  `AFTER HRS 679.40 (-1.14%)`. At 19:55, after nearly four hours of after-hours trading, it still shows
  `679.40 (-1.14%)`. The charts panel stamp (app.js:3851) is driven by the *OHLC* feed, not by `info`,
  so nothing on the panel reflects the quote's age. This is precisely "a stale value on screen with the
  staleness lamp not reflecting it".
- **Permanently missing after-hours line.** Load QQQ at 15:50 while the market is open →
  `extPrice == null` → no line. The line never appears, all evening, because the fetch never repeats.
  Silent no-op with no user-visible cause.

Note this also affects the pre-existing `Last`/`Bid`/`Ask` readout, but those were already
market-hours-only or self-evidently static; the after-hours line is the first value here that is
*expected to move while frozen*.

**Recommendation.** Give `wbInfoCache` a session-aware TTL (60s while `marketSessionOpen()` or
`postMarketOpen()`, longer when truly closed), store `{ at, info }` rather than bare `info`, refetch the
*current* symbol on each `feedPollTick`/`scheduleMarketPoll` tick, and clear it on `Refresh now`.
Additionally, render `info.extAt` (quote-proxy already returns it, index.ts:197) beside the AFTER HRS
line, as the Markets tiles already do in their `line.title` (app.js:167-169) — a marked print with no
time is unverifiable against a broker screen.

**Follow-up PR: YES.**

---

## F9 — MEDIUM — `extAt` is a MAX across core tiles, so one tile's print vouches for tiles that have none

**Location:** `/home/user/claude.trading/supabase/functions/desk-market/index.ts:525-529`

```js
const extTs = tiles.slice(0, MARKET_SYMBOLS.length).flatMap((t) => {
  const r = t as Record<string, { at?: number } | undefined>;
  return [r.ext?.at, r.extProxy?.at];
}).filter((t): t is number => typeof t === 'number' && t > 0);
const extAt = extTs.length ? new Date(Math.max(...extTs) * 1000).toISOString() : null;
```

The inline comment defends `Math.max` as *"when did the thing you are looking at last print"* — but
`extAt` feeds a **panel-level** stamp (`#mktStamp` via app.js:4288) that speaks for all four index
tiles, not for one. Ten lines above, `quoteAt` (`:475-477`) uses `Math.min` for exactly this reason,
with a comment that reads as a direct rebuttal: *"one panel stamp speaks for several tiles, so it has to
be a floor... Taking the max would let a live S&P vouch for a VIX quoted 15 minutes earlier — exactly
the ambiguity this whole change exists to remove."*

**Failure scenario.** SPY's extended quote resolves at 19:58; DIA's batch entry is missing (partial
Yahoo reply — `quoteBatch:304` `if (!res || !res.ok) continue;`). `extAt` = 19:58. The panel stamps
19:58 — while the Dow tile shows no after-hours line at all, which the reader parses as "the Dow's proxy
didn't trade after hours" rather than "we failed to fetch it". One tile's success timestamps the whole
panel and launders another tile's fetch failure into a factual claim.

**Recommendation.** Use `Math.min` over the tiles that actually rendered an extended line (i.e. the
`kind === 'post'` set, per F2a), matching `quoteAt`'s floor semantics — or publish `extAt` per tile only
and drop the panel-level field. Keeping `max` requires the panel to also disclose how many tiles the
stamp covers.

**Follow-up PR: YES — fold into F2.**

---

## F10 — MEDIUM — The post-market TTL drop makes an anon-callable endpoint 12× more expensive, and the code comment's cost model is wrong

**Location:** `/home/user/claude.trading/supabase/functions/desk-heatmap/index.ts:96-98`, comment at
`:544-550`

The comment justifying the merge says:

> *"it runs only during post-market, and only on a cache MISS (60-min TTL when the session is shut), so
> it costs about four batched calls an hour"*

But the **same commit** added `withinPostMarket()` to `ttlMs()` at `:98`, so during post-market the TTL
is **5 minutes, not 60** — the comment's own premise is contradicted by the line above it. Worst case is
12 rebuilds/hour, each doing an uncached two-request `getCrumb()` handshake plus 4 × 150-symbol Yahoo
quote batches: ~60 upstream calls/hour rather than ~4, against a function CLAUDE.md already flags as the
expensive one ("whose 546s came from per-request upstream work").

In practice the *honest client* is safer than that: `loadHeatmap` only runs on `feedPollTick`, whose
cadence is `marketSessionOpen() || withinCloseSettleGrace()` (app.js:4380-4381) — **hourly** during
post-market. So the 5-minute server TTL buys the real user nothing and exists only as attack surface:
`desk-heatmap` is anon-callable by design (CLAUDE.md, accepted residual), and any unauthenticated caller
can now drive 12 full screener+Yahoo rebuilds an hour.

The second-order effect is what makes this a silent-failure finding rather than a pure cost note:
Yahoo rate-limiting the function's egress IP degrades straight into **F4** — silent partial batches
rendered as "did not trade after hours".

Related, and worth deciding deliberately: the heatmap's extended tooltips can be up to **60 minutes
stale** on the honest client path (hourly poll), with a stamp that says `at close` (F5) and a tooltip
that carries no timestamp at all (app.js:2120-2126). `desk-market` got a dedicated 1-minute post-market
poller for exactly this reason (app.js:4396-4408, `postMarketOpen()`); the heatmap did not.

**Recommendation.** Either revert `withinPostMarket()` out of `ttlMs()` (the client does not poll fast
enough to use it), or keep it and add `postMarketOpen()` to the client's `openCadence` at app.js:4380 so
the freshness the TTL implies is actually delivered. Do not keep the current split, where the server pays
for freshness the client never collects. Cache `getCrumb()` with a TTL, matching `desk-market`'s
`yahooAuth` (index.ts:230-231).

**Follow-up PR: YES.**

---

## F11 — LOW — No same-session guard on the `(1+reg%)(1+post%)−1` compounding

**Locations:** `quote-proxy/index.ts:212-227` (`extInfo`), `desk-market/index.ts:328-349` (`extFrom`),
`desk-heatmap/index.ts:216-227`

All three compound `regularMarketChangePercent` with `postMarketChangePercent` and correctly refuse to
fall back to `regularMarketPreviousClose`. But none of them ever compares `postMarketTime` against
`regularMarketTime`, and none inspects `marketState`. The correctness of the basis rests entirely on an
**undocumented Yahoo field-lifecycle assumption** — that `postMarket*` is dropped once a new regular
session begins, so the two percentages always describe the same trading day.

I could not reach live Yahoo from this environment to falsify it, and the assumption appears to hold in
current behaviour. But if Yahoo ever retains a prior session's `postMarketChangePercent` alongside a
freshly-updating `regularMarketChangePercent`, all three call sites produce a confident percentage on a
mixed basis, with no assertion, no lamp change and no log. Given this is the one arithmetic every
extended-hours number on the desk depends on, it deserves a cheap guard rather than a comment.

**Recommendation.** Add one line in each: reject the extended reading when
`postMarketTime` and `regularMarketTime` fall on different ET calendar days. Cheap, and it converts a
silent wrong number into an honest absence.

**Follow-up PR: OPTIONAL — bundle into whichever PR touches these three functions next.**

---

## F12 — LOW (systemic) — Zero observability across the entire extended-hours path

**Locations:** `desk-market/index.ts:518`, `desk-heatmap/index.ts:558` and `:233`,
`quote-proxy/index.ts` throughout; `scripts/app.js:4292`, `:2563`, `:2943`

`grep -c 'console\.'` returns **0** for all three edge functions. Every failure in this feature —
crumb handshake rejected, 401 on a rotated crumb, Yahoo 429, an HTML error page failing `res.json()`,
a Supabase REST call refused for a browser-shaped UA — resolves into an empty map or a bare
`catch {}` and produces no artifact anywhere. On the client, `refreshMarket`'s
`catch { /* keep last good */ }` (app.js:4292) and `maybeFetchWbInfo`'s
`.catch(() => { wbInfoCache[sym] = null; })` (app.js:2943) are equally silent.

CLAUDE.md's own hard-won lesson — *"a `.catch(() => null)` will happily swallow into a silent empty
result (this cost a full debugging round on `desk-watchlist`: the function 502'd with no clue)"* — is
the exact shape of every catch listed above. The extended-hours feature is now the most
failure-prone surface on the desk (three upstream auth handshakes, a rate-limited public API, a
session-dependent field set) and the least observable.

**Recommendation.** One `console.warn` per swallowed failure, with the operation name, symbol count and
HTTP status. It costs nothing, it is visible in Supabase function logs, and it is the difference between
"the tooltips are empty tonight" being a five-minute check and another full debugging round. It is also
what CLAUDE.md's *"never silently fail in production code"* rule requires.

**Follow-up PR: YES — trivial, high leverage, can ride with any of the above.**

---

## Ranked summary

| # | Severity | Finding | File:line | Follow-up |
|---|---|---|---|---|
| F1 | CRITICAL | Ask context ships pre-market + index-repeat prints as "afterHours"; VIX leaks; R2K double-reported | `scripts/app.js:1603-1610` | Yes — first |
| F2 | HIGH | `extAt` stamp branch mislabels pre-market with the wrong date; runaway minutes-only delay overnight/weekend | `scripts/data.js:927-932`, `desk-market/index.ts:525-529` | Yes |
| F3 | HIGH | Heatmap merge writes a Yahoo-basis `extPct` onto a screener-basis `pct` (and onto a fabricated `pct = 0`) | `desk-heatmap/index.ts:551-559`, `:153` | Yes |
| F4 | HIGH | `quoteBatch` never rejects; partial batches become the false claim "did not trade after hours". No 401 retry — the fix applied to `desk-market` this same round | `desk-heatmap/index.ts:190-235`, `:553` | Yes |
| F5 | HIGH | Heatmap stamp still says "at close" over after-hours tooltips; stale lamp kept on poller failure | `scripts/app.js:2560`, `:2564` | Yes |
| F6 | MEDIUM | Heatmap extended tooltips vanish ~21:00 ET while Markets keeps showing them all night | `desk-heatmap/index.ts:98`, `:551` | Yes |
| F7 | MEDIUM | R2K cut silently has no extended data at all | `desk-heatmap/index.ts:590-614` | Yes / owner call |
| F8 | MEDIUM | `wbInfoCache` never invalidates — the new AFTER HRS line is frozen for the page's life, or never appears | `scripts/app.js:3004-3010`, `:2720`, `:2939` | Yes |
| F9 | MEDIUM | `extAt` uses `Math.max` for a panel-level stamp, contradicting `quoteAt`'s deliberate `Math.min` floor | `desk-market/index.ts:525-529` | Yes |
| F10 | MEDIUM | Post-market TTL drop is 12× the documented cost, buys the client nothing, and degrades into F4 under rate-limiting | `desk-heatmap/index.ts:96-98`, `:544-550` | Yes |
| F11 | LOW | No same-session guard on the reg/post compounding — basis correctness rests on undocumented Yahoo behaviour | three call sites | Optional |
| F12 | LOW | Zero `console.*` in all three edge functions — every extended-hours failure is invisible | systemic | Yes (trivial) |

**Suggested PR split**

1. **PR A — "extended-hours session labelling"** (F1, F2, F9): one shared
   `extLineFor(tile)` helper used by `renderMarkets` *and* `buildAskContext`; `kind === 'post'` filter
   applied server-side before `extAt` is built; `Math.min` floor; `fmtDelay` hours rollup + a static
   tail outside `postMarketOpen()`. This is the batch that stops wrong numbers reaching the owner and
   the model.
2. **PR B — "heatmap extended-hours correctness"** (F3, F4, F5, F6, F7, F10, F12): merge the Yahoo
   regular figure alongside the extended one, port the 401 retry, cache `getCrumb`, publish `extAt`
   from `desk-heatmap` and thread it into the panel lamp, re-lamp on poller failure, decide the
   post-market TTL/poll-cadence question, and add logging.
3. **PR C — "charts quote freshness"** (F8, and F11 if convenient): TTL + refetch for `wbInfoCache`,
   render `info.extAt`.

**Test gaps worth closing alongside.** S23 exercises extended hours only in `?demo=1`, and the render
comment at app.js:158 already records that demo *"only ever sends extProxy, so S23 could not have caught
it"* — the same blind spot hides F1 (demo sends no `ext`, so the ask-context leak is invisible) and F2a
(demo has no pre-market `kind`). A demo fixture carrying `kind: 'pre'` and a bare index `ext` would fail
fast on both.
