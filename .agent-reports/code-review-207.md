# Code review — commit `3cf7b76` (PR #207, "Close the four extended-hours review findings")

**Post-merge review.** The code is on `main` and deployed. No edits made; every item
below is assessed for whether it warrants a follow-up PR.

## Scope reviewed

| File | Change |
|---|---|
| `index.html` | cache-bust token `20260731b` → `20260731c` on all five render-blocking assets |
| `scripts/app.js` | ask-context extended fields; `AFTER HRS` line in the charts quote readout; `extAt` threaded into `liveLampFor` from masthead / `relampMarket` / `refreshMarket` |
| `scripts/data.js` | `liveLampFor(..., extAt)` — new EOD branch whose stamp names the extended instant |
| `supabase/functions/desk-heatmap/index.ts` | `withinPostMarket()`; post-market added to `ttlMs()`; Yahoo extended pass merged onto the Nasdaq-screener path in `refreshSp500` |
| `supabase/functions/desk-market/index.ts` | `extAt` published in the payload (max of core tiles' `ext.at` / `extProxy.at`) |

Baseline: `CLAUDE.md` — Application Architecture (extended-hours rulings 2026-07-29 /
2026-07-30), Project-Specific Security Constraints, Project-Specific Coding Standards.

## Verified clean

- **Prior-close basis.** All three extended-% computations compound correctly:
  `desk-market extFrom()` (`(1+reg)(1+post)-1`), `desk-heatmap quoteBatch()` (same),
  `quote-proxy extInfo()` (same). `regularMarketPreviousClose` appears nowhere.
- **Absent stays absent.** `desk-heatmap`'s merge sets `extPct`/`extLast` only when
  `q.extPct != null`; `buildHeatmap` spreads them conditionally; the new charts readout
  guards `info.extPrice != null` and omits the `%` when `extPct` is null. No partial
  quote produces a `0.00%`.
- **2-decimal convention.** `ep.toFixed(2)` in the readout; `toFixed(2)` on every
  server-side extended pct.
- **`textContent` only.** All new DOM goes through `el()` / `createTextNode`; zero
  `innerHTML` in `scripts/app.js`.
- **Gain/loss colour.** The new `AFTER HRS` readout item carries no `up`/`down` class —
  correct, and consistent with the ruling that those colours are P&L-only.
- **Lamp contract.** The new branch returns `lamp--eod` / `EOD`; S14's LIVE/EOD contract
  is intact.
- **Failure isolation.** The heatmap merge is wrapped in its own `try/catch` nested
  inside the screener `try`, so a Yahoo auth failure costs the extended lines and does
  not spuriously trigger the Yahoo fallback path.
- **Cache-bust token** bumped consistently across all five assets.
- **UA rule.** The new `getCrumb()`/`quoteBatch` calls are outbound third-party (Yahoo);
  no browser UA reaches a Supabase REST call.

---

# Findings

## Critical (confidence 90–100)

### 1. Ask context labels PRE-market prints as "after hours" — `scripts/app.js:1604-1609` (confidence 92)

```js
...(m.ext ? { afterHoursLast: m.ext.last, afterHoursChgPct: m.ext.chg } : {}),
...(m.extProxy ? { afterHoursProxy: m.extProxy.sym, afterHoursProxyChgPct: m.extProxy.chg } : {}),
```

`desk-market`'s `extFrom()` returns `{ kind: 'pre' | 'post' }` and deliberately computes
the pre-market print server-side (`supabase/functions/desk-market/index.ts:343-347`;
CLAUDE.md: "pre IS computed server-side, so enabling it is a display change"). Every
other consumer in this repo filters on it:

- `scripts/app.js:158-159` — index tiles: `t.extProxy.kind === 'post' ? ... : t.ext && t.ext.kind === 'post' ? ... : null`
- `scripts/app.js:210` — sector cells: `t.ext.kind === 'post'`

The new ask-context mapping has **no `kind` filter**. Between 04:00 and 09:30 ET the
assistant is handed a pre-market figure under the field name `afterHoursChgPct` and
reports it as an after-hours move — while the Markets panel beside it correctly renders
nothing. That is the exact "two different numbers for the same question" failure the
change was written to prevent, inverted.

Reachable in normal use: the owner is on Pacific time, so 06:00–06:30 PT is pre-market,
and the Ask panel is available whenever live + authed. Demo can never surface it —
`scripts/data.js:138-139` hardcodes `kind: 'post'`, which is why no S23-style test
would catch this.

**Secondary, same lines:** the mapping also lacks the *proxy-preference* guard the UI
carries (`app.js:152-157` — "extProxy is preferred over ext ... taking `ext` first
dropped the IWM label"). For the `IWM (R2K proxy)` tile both objects are present, so
the assistant receives the same number twice under two names; and if Yahoo ever returns
a `postMarketPrice` for `^GSPC`/`^IXIC`, `afterHoursChgPct` would be attributed to
"S&P 500" itself — the instrument-wearing-the-wrong-name trap the ruling exists to stop.
Measured evidence says indices report `hasPrePostMarketData:false`, so this half is
latent rather than live, but the guard is one line and the UI already has it.

**Fix:** mirror the UI's selection exactly —
`const xt = m.extProxy?.kind === 'post' ? m.extProxy : m.ext?.kind === 'post' ? m.ext : null;`
then emit `afterHoursProxy` only when `xt === m.extProxy`.

**Follow-up PR: yes.** Small, self-contained, and it is a wrong-number-to-the-assistant
bug on a panel the owner asks directional questions of.

### 2. The heatmap's stated cost model is contradicted by its own TTL change — `supabase/functions/desk-heatmap/index.ts:94-96, 546-551` (confidence 90)

The merge's comment claims:

> "it runs only during post-market, and only on a cache MISS (60-min TTL when the
> session is shut), so it costs about four batched calls an hour"

But the *same commit*, 450 lines earlier, added `withinPostMarket()` to `ttlMs()`:

```js
const ttlMs = () =>
  (marketSessionOpen() || withinCloseSettleGrace() || withinPostMarket() ? 300_000 : 3_600_000);
```

During 16:00–20:00 ET the payload TTL is **5 minutes, not 60**. The refresh ceiling in
that window therefore went from 1/hour to 12/hour, and each of those 12 now performs the
full `nasdaqScreener()` download **plus** `getCrumb()` (2 fetches) + a ~500-symbol
`quoteBatch` (4 fetches) — roughly 7 upstream calls per refresh instead of 1.

In practice the owner's own client polls hourly when the session is shut, so the typical
cost is nearer 1 refresh/hour. The problem is the **ceiling**: `desk-heatmap` is
anon-callable, and CLAUDE.md names the session-aware cache + single-flight as the only
thing bounding unauthenticated quota burn. That bound just loosened 12× in a four-hour
daily window, on the function with a documented HTTP 546 resource-limit history.

Note also that `refreshR2k()` gets the same 5-minute post-market TTL and performs **no**
extended merge at all — pure additional screener load for zero extended benefit.

**Fix options:** (a) gate the post-market TTL to `sp500` only, or (b) keep the 60-minute
post-market payload TTL and give the extended merge its own short-lived sub-cache, or
(c) at minimum correct the comment so the next reader is not misled about the cost.

**Follow-up PR: yes** — at least to correct the comment and to exclude `r2k` from the
post-market TTL, which is free.

---

## Important (confidence 80–89)

### 3. The heatmap's extended pass has no latency cap, unlike its `desk-market` sibling — `supabase/functions/desk-heatmap/index.ts:549` (confidence 88)

```js
const ext = await quoteBatch(constituents.map((c) => c.sym), await getCrumb());
```

`desk-market` bounds the identical operation and says exactly why
(`desk-market/index.ts:490-498`):

> "try/catch only covers settled rejections: a Yahoo endpoint that STALLS rather than
> failing would hold the already-complete core payload until the edge runtime deadline"

`desk-heatmap`'s `quoteBatch`/`getCrumb` use bare `await fetch(...)` with no
`AbortController` and no `Promise.race` timeout. Its `deadStreak >= 2` guard only counts
*settled* failures. A hung Yahoo therefore holds the request — after the screener has
already succeeded — until the edge runtime kills the invocation. That is not catchable
by the surrounding `try/catch`: the whole request dies, and the handler's
`if (cached) return reply(200, cached.body)` never runs on a cold isolate. Result: blank
treemap + STALE lamp — precisely the owner-reported 546 failure mode this function was
recently rewritten to eliminate.

**Fix:** wrap in the same `Promise.race([..., timeout])` pattern, resolving an empty Map
(`EXT_QUOTE_TIMEOUT_MS = 4000` is the established constant).

**Follow-up PR: yes.** Low risk, and it protects the core payload of an anon-callable
function.

### 4. The extended stamp's `age` tail keeps growing all night — `scripts/data.js:918-925` (confidence 85)

```js
stamp: fmtUpdated(extAt, dataAsOf, 'age') + ' — after hrs',
tail: 'age',
```

The `'age'` tail appends `fmtDelay()` and is re-rendered every 30s by `retickStamps()`.
Once the extended session ends at 20:00 ET the print is final, but Yahoo keeps serving
`postMarketPrice`/`postMarketTime`, so `extAt` stays set and the stamp reads
"delayed by 340 minutes — after hrs", then 700, then 780 by the next morning.

This is the case `fmtUpdated`'s own header comment rules out
(`scripts/data.js:842-846`, owner ruling 2026-07-28):

> "after the bell the print is FINAL, not lagging, so an ever-growing delay figure would
> read as a fault when nothing is wrong"

The `'close'` tail exists for exactly this. The extended branch should either use a
static suffix once the extended window has closed, or keep `'age'` only while
`withinPostMarket()`-equivalent client logic holds.

**Follow-up PR: yes** — same PR as #5 below; both are in this one branch.

### 5. The extended stamp mislabels pre-market and can pair a next-day clock with a prior-day date — `scripts/data.js:918-925` (confidence 82)

Same branch, second problem. `extAt` is computed in `desk-market` as the **max** across
`ext.at` and `extProxy.at` **without filtering `kind`** (`desk-market/index.ts:525-530`),
so a pre-market `preMarketTime` flows into it. In the client:

```js
if (extAt && closeIso && new Date(extAt) > new Date(closeIso)) { ... ' — after hrs' }
```

`closeIso = marketCloseInstant(dataAsOf)`. Whenever `dataAsOf` is still the prior trading
day (the normal state before today's daily bar appears), a 06:30 ET pre-market print is
`> ` yesterday's 16:00 close, so the branch fires and:

1. the stamp says **"— after hrs"** during the **pre**-market window, while the tiles —
   correctly filtered to `kind === 'post'` — render no `.mk-ext` line at all; and
2. `fmtUpdated` composes `fmtClockBare(extAt)` (today's clock) with
   `fmtShortDate(dataAsOf)` (yesterday's date), producing an internally inconsistent
   stamp such as "Last updated 03:30, Jul 30".

**Fix:** either have `desk-market` restrict `extAt` to `kind === 'post'` prints (one
predicate in the `flatMap`), or have the client derive the suffix from the tile's `kind`
rather than from a bare timestamp comparison. The server-side fix is preferable — the
payload field currently means two different sessions.

**Follow-up PR: yes** — combine with #4.

---

## Minor notes (below the reporting threshold, listed for completeness)

- `wb-quote-ext` (`app.js:3006`) has **no CSS rule** anywhere in `index.html` or
  `styles/`. Harmless — the line inherits `wb-info-item` and the literal "AFTER HRS"
  text is the marker — but it is a dead class. Also, unlike `Bid`/`Ask`/`Diff` it does
  not use the `item()` helper, so its label is not wrapped in `<b>`.
- The readout has `info.extAt` available but does not print it, while the Markets tile
  tooltip does show "last print HH:MM". Minor inconsistency.
- **No test coverage was added.** S23 covers demo `.mk-ext` tiles only, and demo hardcodes
  `kind: 'post'` (`data.js:138-139`), so none of the four behaviours here — the heatmap
  screener-path merge, the `AFTER HRS` readout, the `extAt` stamp, the ask-context
  fields — is exercised. The stamp branch and the ask-context mapping are pure functions
  of their inputs and could be unit-tested cheaply; that would have caught findings 1
  and 5.
- Worth verifying separately (pre-existing, not introduced here): the heatmap merge
  overlays Yahoo-derived `extPct` onto screener-derived `pct`. If the Nasdaq screener's
  `pctchange`/`lastsale` ever includes after-hours activity, the tile would be *tinted*
  by a post-market-inclusive figure while CLAUDE.md states both grids "keep tinting by
  the REGULAR day-%".

---

## Recommendation

**One follow-up PR, four commits:**

1. `app.js` ask context — filter `kind === 'post'` and prefer `extProxy` (finding 1).
2. `desk-market` — restrict `extAt` to post prints; `data.js` — drop the growing `age`
   tail once the extended window is over (findings 4, 5).
3. `desk-heatmap` — bound the extended pass with the `EXT_QUOTE_TIMEOUT_MS` race
   (finding 3).
4. `desk-heatmap` — exclude `r2k` from the post-market TTL and correct the cost comment
   (finding 2).

None of these is a data-loss or security issue, so nothing here argues for a revert. The
extended-% math and the absent-vs-zero contract — the two invariants most likely to
produce a silently wrong number — are correct throughout.
