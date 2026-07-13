# Security Review — retire-nightly-pipeline Group A (origin/main...HEAD)

**Branch:** `claude/hello-kccc26` · **Date:** 2026-07-13 · **Reviewer:** security-review agent
**Scope:** 4 new anon-callable edge functions (`desk-market`, `desk-heatmap`, `desk-charts`, `desk-news`) + client wiring (`scripts/data.js`, `scripts/app.js`, `index.html` cache-bust) + `specs/retire-nightly-pipeline/tasks.md`.
**Model baseline applied:** CLAUDE.md "Project-Specific Security Constraints" (anon key public by design; RLS default-deny + PIN RPCs as enforcement boundary; desk-maps anon-quota residual) and `specs/retire-nightly-pipeline/plan.md` (§desk-news service-key residual, plan.md:33; concurrent-instance headroom, plan.md:108; invocation-budget residual, spec.md Clarification 3).

## Verdict: SHIP

No blocking items. One MED hardening recommendation (single-flight refresh), largely covered by recorded residuals but cheap to close.

---

## Findings

### MED-1 — Cache-miss thundering herd: concurrent anon requests each trigger the full upstream sweep
- **Files:** `supabase/functions/desk-market/index.ts:164`, `desk-heatmap/index.ts:222`, `desk-news/index.ts:185`, `desk-charts/index.ts:136-151`
- **Issue:** All four functions gate on a module-scope payload cache but do not deduplicate in-flight refreshes. Requests that arrive while a refresh is running (cold cache or just-expired TTL) each pass the `Date.now() - cache.at < ttlMs()` check and each launch the entire upstream fan-out: ~6 fetches (desk-market), the crumb dance + up to ~4 batched Yahoo calls (desk-heatmap), config + N feeds + up to 8 ticker feeds ×2 fallbacks + chip Stooq calls **plus a service-role DB read** (desk-news), and up to ~25 OHLC fetches with `EdgeRuntime.waitUntil` background continuation (desk-charts, where the per-symbol `stale` computation is also re-run per request). A hostile caller firing R parallel anon requests inside the fetch window forces ~R× upstream amplification per warm instance, repeatable each TTL lapse, plus fresh isolates spawn with fully cold caches. No caller *input* can bypass the caches (input is ignored — see INFO-1), only concurrency can.
- **Impact:** Availability/quota only — free-tier egress/compute burn and, more materially, upstream IP throttling of Supabase egress (the "maps saga" failure mode), which would take down the live feeds for everyone. No confidentiality impact (desk-news DB read result never varies with caller input and only public-shaped output leaves).
- **Residual status:** PARTIALLY ACCEPTED-RESIDUAL. CLAUDE.md records "unauthenticated invocations can burn free-tier quota, bounded by the in-function cache" for desk-maps; plan.md:108 folds concurrent *warm instances* into a 2× headroom factor; spec.md residual #3 accepts the invocation budget. Those bounds assume ~one refresh per TTL window per instance — benign traffic. A deliberate concurrent burst breaks that assumption, so the recorded bound is per-burst, not per-TTL.
- **Fix (recommended, non-blocking):** single-flight the refresh — memoize the in-progress promise at module scope and have concurrent requests await it, e.g. in desk-market:
  ```ts
  let inflight: Promise<unknown> | null = null;
  // in handler, on cache miss:
  inflight ??= refresh().finally(() => { inflight = null; });
  return reply(200, await inflight);
  ```
  For desk-charts, wrap the `work` batch loop the same way so concurrent callers share one prime sweep. ~5 lines per function; also brings the code in line with the budget math in plan.md:108.

### LOW-1 — SSRF boundary: owner-committed `config/news-feeds.json` steers server-side fetches to arbitrary HTTPS hosts, titles echoed back
- **File:** `supabase/functions/desk-news/index.ts:73` (`mergeFeedConfig` URL filter), `:186-193` (fetch loop)
- **Issue:** `general[].url` entries are fetched server-side from the edge runtime. The filter enforces `typeof url === 'string' && /^https:\/\//` — scheme enforcement is present and correct (blocks `http://` cloud-metadata endpoints, `file:`, etc.), but host is unrestricted and the array length is uncapped, so a config with hundreds of entries drives uncapped fan-out, and parsed `<title>` text from any HTTPS-reachable XML resource surfaces in the public response. The write boundary is a commit to `main` on the Pages repo — and note this is *not* identical to "game over": someone with only repo write (or a compromised workflow using the bot-data-commit exception, which pushes to `main` directly) gets to steer the edge function's egress without any Supabase access. No auth headers accompany these fetches, so the function's own Supabase REST API is not reachable with privilege this way.
- **Fix:** cap the merged list (`general.slice(0, 8)` — the shipped config has 2 entries) and optionally pin an allowlist of feed hosts. At minimum this bounds the fan-out; the host boundary can stay documented as-is given single-owner scale.

### LOW-2 — desk-charts watchlist config: uncapped roster size drives uncapped upstream fan-out
- **File:** `supabase/functions/desk-charts/index.ts:106-113` (`loadWatchlist`), `:136-151`
- **Issue:** `config/chart-watchlist.json` symbols are correctly confined to fixed hosts (`encodeURIComponent` into Stooq/Yahoo path+query — no host escape, no SSRF), but the array length is unbounded: a committed roster of 1,000 strings means 1,000 upstream OHLC fetches per 30-min TTL, amplified by MED-1. Same repo-write boundary as LOW-1.
- **Fix:** cap the parsed list, e.g. `.slice(0, 40)` (the default roster is 25), matching desk-news's existing `MAX_TICKERS = 8` discipline.

### LOW-3 — Held-ticker regex escapes only the first dot
- **File:** `supabase/functions/desk-news/index.ts:150`
- **Issue:** `new RegExp('\\b' + sym.replace('.', '\\.') + '\\b')` — `String.replace` with a string pattern replaces only the first occurrence. Symbols pass `/^[A-Z.]{1,6}$/` (desk-news/index.ts:135), so multi-dot symbols leave an unescaped `.` that matches any character → over-broad chip matching (a wrong held-ticker chip on a headline). The charset excludes every other regex metacharacter, so there is no regex injection or ReDoS — this is a correctness nit at the edge of the security surface, worth fixing while in the file.
- **Fix:** `sym.replaceAll('.', '\\.')` (matches how `yahooTicker` in desk-heatmap uses `/\./g`).

### INFO-1 — Injection surface: none (verified)
None of the four functions read the request at all beyond `req.method` — no `req.json()`, no `URL(req.url)` param parsing, no header reads. Request body, query string, and headers cannot reach any fetch URL, the desk-news PostgREST query (built entirely from env vars + the DB's own `users[0].id`), or the response. The client's `deskFeed(name)` (`scripts/data.js:342-355`) is only ever called with the four fixed literals. Matches the "no caller input reaches upstream URLs or the database query" claim in the function headers.

### INFO-2 — desk-news service-role key handling: verified clean; disclosure = recorded residual
- **File:** `supabase/functions/desk-news/index.ts:121-138` (`heldTickers`), `:211-224` (response shape), `:228-231` (error path)
- (a) The service key appears only in headers to `Deno.env.get('SUPABASE_URL')` REST endpoints; the query is constant apart from the DB-sourced user id; symbols are re-validated (`/^[A-Z.]{1,6}$/`) and capped at 8 before use.
- (b) Response fields are `{t (HH:MM), src, h (title), chips: [sym, dayPct]}` — the same held-ticker chips + holdings-first ordering the previously public `data/news.json` carried. Nothing else from the snapshot rows (balances, quantities, `mkt` values, account keys, user ids) reaches the payload. Held-ticker disclosure via chips is **ACCEPTED-RESIDUAL** (plan.md:33 §desk-news; referenced in CLAUDE.md).
- (c) Error paths: `heldTickers` is fully try/caught (returns `[]`); per-feed failures pass through `Promise.allSettled`; the only thrown messages reaching the 502 body are locally constructed strings (`"<src> HTTP <status>"`, `"every news source failed"`). No env values, headers, or row contents can appear in `String(e.message)`. Keep future error construction local for this reason.

### INFO-3 — CORS/headers: consistent with the established model
`Access-Control-Allow-Origin: *` on all four functions matches desk-maps and quote-proxy — appropriate for public-shaped data with no cookies/credentials. `GET` being allowed alongside `POST` makes the endpoints trivially crawlable (marginal quota exposure, folded into MED-1); the client only POSTs. No sensitive response headers introduced.

### INFO-4 — Client diff secrets hygiene: clean (verified)
`scripts/data.js` / `scripts/app.js` additions reference only `DESK_DB.url` and `DESK_DB.anonKey` (public by design). No new keys, tokens, or endpoints beyond the four function names. `index.html` bumps all `?v=` tokens together per the cache-bust rule. The poller (`startFeedPolling`, app.js) exits in demo mode and when `DESK_DB.url` is empty, and pauses on `document.hidden` — client-side request volume matches the spec's 35K/month budget math.

---

## Verdict detail

**SHIP.** No finding blocks: the only MED item is a hardening of bounds the owner has already accepted in principle (desk-maps precedent + plan.md:108 + spec residual #3), and the LOWs sit behind the repo-write boundary or are correctness nits. Recommended follow-ups in priority order: single-flight refresh memoization (MED-1), config fan-out caps (LOW-1, LOW-2), `replaceAll` dot escape (LOW-3).
