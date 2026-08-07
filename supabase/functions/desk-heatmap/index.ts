// ── desk-heatmap — index heat treemaps, delayed quotes on demand ─────────────
// Replaces the nightly fetch-heatmap.js → data/heatmap.json step
// (retire-nightly-pipeline plan, Group A; universes + periods added
// 2026-07-14, owner request). Universes:
//   sp500 (default) — constituents CSV roster; chain: Nasdaq screener →
//     Yahoo v7 crumb quote → Yahoo spark + 24h cap cache. Same payload
//     shape as the retired data/heatmap.json.
//   r2k — small-cap proxy for the Russell 2000: every US common stock from
//     the same screener call, ranked by market cap; skip the top 1000
//     (≈ Russell 1000 territory), take the next 2000 — the FULL index,
//     finviz-style. Screener-only (the roster and quotes come from one
//     bulk call); stale-but-honest cache when the screener is down.
// Periods: tiles carry pctW / pctM / pctYtd from a once-a-day Yahoo spark
// 1y sweep per universe (EOD data — intraday refresh would be noise). The
// sweep advances in small AWAITED steps (~4 spark batches per invocation)
// persisted to the desk_feed_cache table (desk_006; RLS deny-all,
// service-key only): module memory dies with the isolate, and detached
// background work proved unreliable on this runtime. Until the ledger
// completes, tiles omit the fields and the client keeps those options
// disabled.
//
// Anon-callable: public market data; the only caller input is the universe
// enum — nothing reaches upstream URLs. Session-aware TTL (5/60 min).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA_BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA = { 'user-agent': UA_BROWSER };
const CONSTITUENTS_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

// ETF cut roster. Read from the SAME committed file the client groups the
// tiles with (map-filters.json → etfCats), so band membership and roster can
// never drift apart — they are one object.
//
// This cut used to be built CLIENT-side out of the desk-charts payload, which
// meant a tile could only exist if the charts workbench happened to carry that
// symbol's full 800-bar OHLCV series. It did not for 15 of the banded names, so
// the map drew 25 of 40 for its whole life — 20 in their proper bands plus 5
// swept into a catch-all 'ETFs' bucket by `cats[sym] || 'ETFs'`, which is what
// kept the mismatch invisible. Sourcing it here costs ~46 bytes a name off the
// period sweep instead of ~36 KB a name off the charts payload — the panel only
// ever needed a handful of numbers per tile.
const MAP_FILTERS_URL = 'https://akyachtsman.github.io/claude.trading/config/map-filters.json';
const ETF_CAP = 60;  // bounds upstream fan-out if the committed roster balloons
// Fallback only, for a Pages hiccup — the committed file is the real roster
// (same shape as desk-charts' DEFAULT_WATCHLIST relationship to its config).
const DEFAULT_ETF_CATS: Record<string, string> = {
  SPY: 'Broad market', QQQ: 'Broad market', DIA: 'Broad market', IWM: 'Broad market',
  RSP: 'Broad market', VTI: 'Broad market', VOO: 'Broad market',
  EFA: 'International', EEM: 'International', VEA: 'International',
  FXI: 'International', INDA: 'International',
  SMH: 'Sector', XLK: 'Sector', XLF: 'Sector', XLE: 'Sector', XLV: 'Sector',
  XLI: 'Sector', XLP: 'Sector', XLY: 'Sector', XLU: 'Sector', XLB: 'Sector',
  XLRE: 'Sector', XBI: 'Sector', KRE: 'Sector',
  GLD: 'Commodities', SLV: 'Commodities', USO: 'Commodities', DBC: 'Commodities',
  UUP: 'Commodities',
  TLT: 'Bonds & vol', IEF: 'Bonds & vol', TLH: 'Bonds & vol', SHY: 'Bonds & vol',
  LQD: 'Bonds & vol', HYG: 'Bonds & vol', AGG: 'Bonds & vol', BND: 'Bonds & vol',
  VXX: 'Bonds & vol', UVXY: 'Bonds & vol',
};
const R2K_SKIP = 1000;  // ranks 1..1000 ≈ Russell 1000 — not small caps
const R2K_TAKE = 2000;  // the FULL index, finviz-style (owner ruling 2026-07-14:
                        // never silently shrink an expected scope — small tiles
                        // render unlabeled, hover carries the detail)

// ONE formatter for every ET calendar date in this file — same fix as
// desk-charts (2026-08-05), and it matters MORE here.
//
// `toLocaleDateString('en-CA', { timeZone })` builds and discards an ICU
// formatter on EVERY call. periodSweep runs it once per bar: a nudge is
// SWEEP_STEP_BATCHES x 20 = 160 symbols x ~250 bars of the 1y daily spark =
// ~40,000 calls, measured at 3778 ms of pure CPU against a hoisted
// formatter's 80 ms (47x).
//
// Note what that number is bigger than: SWEEP_BUDGET_MS is 2500. The budget
// CANNOT bound this, because it bounds the fetch DEADLINE — the formatting
// happens after each batch's fetch resolves, so the worker blows its CPU
// limit no matter how tight the wall-clock bound is. That is why the PR #221
// hardening (deadline on the fetch, persist partial progress) reduced the
// damage from being killed without stopping the kills: the sweep was being
// killed by its own date parsing the whole time.
const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Session-aware TTL — same rule as desk-market (Mon–Fri 09:30–16:00 ET minus
// NYSE holidays). HOLIDAY LIST — refresh annually (seeded 2026–2027).
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
function marketSessionOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  if (NYSE_HOLIDAYS.has(`${get('year')}-${get('month')}-${get('day')}`)) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
// Owner report 2026-07-27: same close-transition gap as desk-market — Stooq/
// Yahoo's final settle print can post a few minutes after the 4pm ET close,
// but this cache's TTL jumps straight from 5-min to 60-min the instant the
// session is marked closed. Keep the 5-min TTL for a short grace window right
// after the close so the real settle print gets picked up quickly.
const CLOSE_SETTLE_GRACE_MIN = 15;
function withinCloseSettleGrace(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const closeMin = 16 * 60;
  return minutes >= closeMin && minutes < closeMin + CLOSE_SETTLE_GRACE_MIN;
}
/* 16:00–20:00 ET, the window where a post-market print exists to fetch. Same
   rule as desk-market's copy. Weekends and holidays never qualify: the regular
   session has to have happened for there to be an after-hours session. */
function withinPostMarket(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  if (NYSE_HOLIDAYS.has(`${get('year')}-${get('month')}-${get('day')}`)) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 16 * 60 && minutes < 20 * 60;
}
/* Post-market keeps the 5-min cadence too: prints are still arriving, and an
   hour-stale after-hours number is the thing the owner asked to fix. Note this
   also sets the ceiling on the extended Yahoo sweep further down — 12 refreshes
   an hour through 16:00-20:00 ET, not the 1/hr its comment first claimed. */
const ttlMs = () =>
  (marketSessionOpen() || withinCloseSettleGrace() || withinPostMarket() ? 300_000 : 3_600_000);

/* Cap for the extended sweep, matching desk-market's EXT_QUOTE_TIMEOUT_MS: long
   enough for a cold crumb handshake plus the batched quotes, short enough that
   the core payload is never held past its own latency budget. */
const EXT_QUOTE_TIMEOUT_MS = 4000;

// extPct/extLast: the post-market print, prior-close basis (owner request
// 2026-07-30). Null whenever the symbol has no extended session or none has
// printed yet — never silently 0, which would read as "flat after hours".
// `advol` = Yahoo's 3-month average daily volume. Carried ONLY for the ETF cut,
// which has no market cap to size tiles by; stock cuts ignore it.
type Quote = { pct: number; cap: number | null; last: number | null; extPct?: number | null; extLast?: number | null; sector?: string; name?: string; industry?: string; advol?: number | null };
type Constituent = { sym: string; name: string; sector: string; ind: string };
type Periods = { w: number | null; m: number | null; ytd: number | null };

const yahooTicker = (sym: string) => sym.trim().toUpperCase().replace(/\./g, '-');

// ── constituents (verbatim ports of fetch-heatmap.js parsers) ───────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

export function parseConstituents(csv: string): Constituent[] {
  const rows = parseCsv(csv);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const iSym = head.findIndex((h) => h === 'symbol');
  const iName = head.findIndex((h) => /security|name/.test(h));
  const iSector = head.findIndex((h) => /sector/.test(h) && !/sub/.test(h));
  const iInd = head.findIndex((h) => /sub-industry|sub industry/.test(h));
  if (iSym < 0 || iSector < 0) throw new Error('constituents CSV missing symbol/sector columns');
  return rows.slice(1).map((r) => ({
    sym: r[iSym].trim().toUpperCase(),
    name: (r[iName] || '').trim(),
    sector: r[iSector].trim(),
    ind: iInd >= 0 ? (r[iInd] || '').trim() : '',
  })).filter((c) => c.sym && c.sector);
}

// ── quote sources (ports of lib/screener.js + lib/yahoo-batch.js, sleeps
//    removed — the batch spacing was a runner-IP mitigation) ────────────────
export function parseScreener(json: unknown): Map<string, Quote> {
  const out = new Map<string, Quote>();
  // deno-lint-ignore no-explicit-any
  for (const r of (json as any)?.data?.rows || []) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (!sym) continue;
    const rawPct = String(r.pctchange ?? '').replace(/[%,+]/g, '').trim();
    const pct = rawPct === '' || rawPct === '--' ? 0 : Number(rawPct);
    const cap = Number(String(r.marketCap ?? '').replace(/[$,]/g, ''));
    const last = Number(String(r.lastsale ?? '').replace(/[$,]/g, ''));
    if (!Number.isFinite(pct)) continue;
    const q: Quote = {
      pct: Number(pct.toFixed(2)),
      cap: Number.isFinite(cap) && cap > 0 ? cap : null,
      last: Number.isFinite(last) && last > 0 ? last : null,
      sector: String(r.sector || '').trim() || undefined,
      name: String(r.name || '').trim() || undefined,
      industry: String(r.industry || '').trim() || undefined,
    };
    out.set(sym, q);
    out.set(sym.replace(/\./g, '-'), q);
  }
  return out;
}

async function nasdaqScreener(): Promise<Map<string, Quote>> {
  const url = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&download=true';
  const res = await fetch(url, {
    headers: { 'user-agent': UA_BROWSER, accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`screener HTTP ${res.status}`);
  return parseScreener(await res.json());
}

async function getCrumb(): Promise<{ cookie: string; crumb: string }> {
  const init = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual' });
  const cookie = (init.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('no Yahoo session cookie issued');
  const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie } });
  if (!res.ok) throw new Error(`getcrumb HTTP ${res.status}`);
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) throw new Error('no Yahoo crumb issued');
  return { cookie, crumb };
}

async function quoteBatch(symbols: string[], auth: { cookie: string; crumb: string }, batchSize = 150): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  let deadStreak = 0;
  for (let i = 0; i < symbols.length; i += batchSize) {
    if (deadStreak >= 2) break;
    const chunk = symbols.slice(i, i + batchSize);
    // postMarket* added 2026-07-30 (owner request: extended hours everywhere it
    // exists). Stocks genuinely trade after the bell, so a heatmap tile can
    // carry its own extended move — unlike an index, which has no extended
    // session at all. Pre-market fields are requested too because the same
    // compounding covers both, but only post is surfaced (owner: "not
    // premarket, I'm mostly interested in post market").
    // averageDailyVolume3Month + shortName added for the ETF cut: an ETF has no
    // marketCap, so its tile is sized by dollar volume, and its label has to
    // come from the quote (there is no constituents roster carrying names).
    // Both are additive — the stock cuts read neither.
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.map(yahooTicker).join(',')}&fields=symbol,regularMarketChangePercent,regularMarketPrice,marketCap,averageDailyVolume3Month,shortName,postMarketPrice,postMarketChangePercent,preMarketPrice,preMarketChangePercent&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const res = await fetch(url, { headers: { ...UA, cookie: auth.cookie } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const before = out.size;
      // deno-lint-ignore no-explicit-any
      for (const q of ((await res.json()) as any)?.quoteResponse?.result || []) {
        const pct = Number(q.regularMarketChangePercent);
        const last = Number(q.regularMarketPrice);
        if (Number.isFinite(pct)) {
          // Extended move measured from the PRIOR CLOSE, by compounding the two
          // percentages Yahoo gives — post% is off today's regular close, reg%
          // is off the prior close, so (1+reg)(1+post)-1 is the prior-close
          // move. Same rule as desk-watchlist and desk-market, so one number
          // means one thing across every panel. regularMarketPreviousClose is
          // NOT used: it shifts basis during pre-market (verified 07-29).
          const postPct = Number(q.postMarketChangePercent);
          const postPx = Number(q.postMarketPrice);
          const hasPost = Number.isFinite(postPx) && postPx > 0 && Number.isFinite(postPct);
          const extPct = hasPost ? ((1 + pct / 100) * (1 + postPct / 100) - 1) * 100 : null;
          out.set(String(q.symbol), {
            pct: Number(pct.toFixed(2)),
            cap: Number(q.marketCap) || null,
            last: Number.isFinite(last) && last > 0 ? last : null,
            extPct: extPct == null ? null : Number(extPct.toFixed(2)),
            extLast: hasPost ? Number(postPx.toFixed(2)) : null,
            advol: Number(q.averageDailyVolume3Month) || null,
            name: typeof q.shortName === 'string' ? q.shortName : undefined,
          });
        }
      }
      deadStreak = out.size > before ? 0 : deadStreak + 1;
    } catch { deadStreak++; }
  }
  return out;
}

function parseSpark(json: Record<string, { close?: number[] }> | null): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const [sym, node] of Object.entries(json || {})) {
    const closes = (node?.close || []).filter((c) => Number.isFinite(c) && c > 0);
    if (closes.length >= 2) {
      const pct = (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100;
      out.set(sym, { pct: Number(pct.toFixed(2)), cap: null, last: Number(closes[closes.length - 1].toFixed(2)) });
    }
  }
  return out;
}

async function sparkBatch(symbols: string[], batchSize = 20): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(yahooTicker).join(',')}&range=5d&interval=1d`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) continue;
    const json = await res.json().catch(() => null);
    for (const [sym, v] of parseSpark(json)) if (!out.has(sym)) out.set(sym, v);
  }
  return out;
}

// ── multi-period sweep: 1y daily spark → {w, m, ytd} per symbol ─────────────
export function periodsFromCloses(dates: string[], closes: number[]): Periods {
  const n = closes.length;
  if (n < 2) return { w: null, m: null, ytd: null };
  const lastClose = closes[n - 1];
  const pctFrom = (ref: number | undefined) =>
    ref && ref > 0 ? Number(((lastClose / ref - 1) * 100).toFixed(2)) : null;
  const yr = dates[n - 1]?.slice(0, 4);
  const firstOfYear = dates.findIndex((d) => d.slice(0, 4) === yr);
  return {
    w: n > 5 ? pctFrom(closes[n - 6]) : null,
    m: n > 21 ? pctFrom(closes[n - 22]) : null,
    ytd: firstOfYear > 0 ? pctFrom(closes[firstOfYear - 1]) : null, // ref = last close of prior year
  };
}

// Returns the readings AND the symbols whose batch actually got a reply.
// The caller needs to tell "Yahoo answered, it has nothing for this symbol"
// apart from "the request failed": the first deserves a permanent empty
// reading, the second must be retried. Collapsing them lets one transient
// batch failure bury 20 names for 24 hours.
// `deadline` (epoch ms) stops the loop early and returns what it has. The
// batches are sequential awaited fetches, so a fixed batch COUNT is a promise
// about work, not about time — and when the upstream is slow that promise is
// what kills the worker. Symbols never reached are simply absent from both
// return values, which the caller already treats as "retry next request", so
// stopping early costs nothing but a slower convergence.
async function periodSweep(symbols: string[], batchSize = 20, deadline = Infinity): Promise<{ out: Map<string, Periods>; answered: Set<string> }> {
  const out = new Map<string, Periods>();
  const answered = new Set<string>();
  for (let i = 0; i < symbols.length; i += batchSize) {
    if (Date.now() > deadline) break;   // hand back partial progress rather than dying whole
    const chunk = symbols.slice(i, i + batchSize);
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(yahooTicker).join(',')}&range=1y&interval=1d`;
    /* The deadline has to bound the FETCH, not just the loop head (Codex
       review, PR #221). Checking it only between batches makes it a promise
       about starting work, not about finishing: a batch that HANGS never
       returns, so the loop never gets back to re-check, periodSweep never
       resolves, advanceSweep never reaches writeSweepRow, and every symbol
       this request already fetched is thrown away when the worker hits its
       wall clock — the exact ledger loss SWEEP_BUDGET_MS was added to stop.
       Deno's fetch has no default timeout, so nothing else bounds it.
       The signal covers the body read too: aborting tears down the response
       stream, so a batch that stalls midway through res.json() fails into the
       same `continue` rather than hanging there instead. An aborted batch
       leaves its symbols out of `answered`, which the caller already treats
       as "retry next request" — the right outcome, since we never learned
       whether Yahoo has data for them. */
    const left = deadline - Date.now();
    const res = await fetch(url, {
      headers: UA,
      /* deadline defaults to Infinity for callers that want no bound at all
         (the tests, and any future non-request-path use); AbortSignal.timeout
         throws on a non-finite delay, so it must stay unset in that case.
         The 250ms floor gives a batch started just under the wire a fair
         chance instead of aborting it on arrival, and costs at most one
         overshoot of that size: the next loop-head check then breaks. */
      signal: Number.isFinite(left) ? AbortSignal.timeout(Math.max(250, left)) : undefined,
    }).catch(() => null);
    if (!res || !res.ok) continue;
    // deno-lint-ignore no-explicit-any
    const json: any = await res.json().catch(() => null);
    if (!json) continue;                     // unparseable body = not an answer
    for (const s of chunk) answered.add(s);
    for (const [sym, node] of Object.entries(json)) {
      // deno-lint-ignore no-explicit-any
      const ts: number[] = (node as any)?.timestamp || [];
      // deno-lint-ignore no-explicit-any
      const rawCloses: (number | null)[] = (node as any)?.close || [];
      const dates: string[] = [], closes: number[] = [];
      for (let j = 0; j < ts.length; j++) {
        const c = Number(rawCloses[j]);
        if (!Number.isFinite(c) || c <= 0) continue;
        // Guard the timestamp BEFORE either push, so `dates` and `closes` stay
        // index-aligned (periodsFromCloses reads them positionally).
        //
        // This is not defensive padding. The two date paths differ on bad
        // input: toLocaleDateString returns the string "Invalid Date", while
        // Intl.DateTimeFormat.format THROWS RangeError. An exception here
        // escapes periodSweep, and advanceSweep's own `.catch(() => {})`
        // swallows it — so the whole nudge is discarded BEFORE writeSweepRow,
        // losing every symbol already fetched. That is precisely the ledger
        // loss SWEEP_BUDGET_MS exists to prevent, re-entered through a
        // different door. One bad bar must cost one bar.
        const secs = Number(ts[j]);
        if (!Number.isFinite(secs)) continue;
        dates.push(NY_DATE.format(new Date(secs * 1000)));
        closes.push(c);
      }
      out.set(sym, periodsFromCloses(dates, closes));
    }
  }
  return { out, answered };
}

// ── shaping (buildHeatmap port + period merge) ───────────────────────────────
export function buildHeatmap(
  constituents: Constituent[],
  quotes: Map<string, Quote>,
  prevCaps: Map<string, number>,
  periods?: Map<string, Periods> | null,
) {
  const bySector = new Map<string, { sym: string; name: string; cap: number; pct: number; ind: string; last: number | null; extPct?: number | null; extLast?: number | null; pctW?: number | null; pctM?: number | null; pctYtd?: number | null }[]>();
  let covered = 0;
  for (const c of constituents) {
    const q = quotes.get(yahooTicker(c.sym)) || quotes.get(c.sym);
    if (!q) continue;
    const cap = q.cap ?? prevCaps.get(c.sym) ?? null;
    if (!cap || !Number.isFinite(q.pct)) continue;
    covered++;
    if (!bySector.has(c.sector)) bySector.set(c.sector, []);
    const p = periods?.get(yahooTicker(c.sym)) || periods?.get(c.sym);
    bySector.get(c.sector)!.push({
      sym: c.sym, name: c.name, cap, pct: q.pct, ind: c.ind || '', last: q.last ?? null,
      /* Only carried when an extended print exists, so the client can tell
         "no after-hours trade" from "unchanged after hours". */
      ...(q.extPct != null ? { extPct: q.extPct, extLast: q.extLast ?? null } : {}),
      ...(p ? { pctW: p.w, pctM: p.m, pctYtd: p.ytd } : {}),
    });
  }
  const sectors = [...bySector.entries()]
    .map(([name, tiles]) => ({
      name,
      cap: tiles.reduce((s, t) => s + t.cap, 0),
      tiles: tiles.sort((a, b) => b.cap - a.cap),
    }))
    .sort((a, b) => b.cap - a.cap);
  return { sectors, covered };
}

// Multi-class companies list one row per share class in the CSV ("Alphabet
// Inc. (Class A)" / "(Class C)", "Fox Corporation (Class A)" / "(Class B)",
// "News Corp (Class A)" / "(Class B)"). Confirmed 2026-07-23 by comparing live
// quotes: for every such pair, cap ÷ price implies the SAME share count on
// both tickers — Yahoo's marketCap is the whole-company diluted figure under
// EACH class symbol, not a per-class split — so two tiles double the
// company's true weight on the map (the bug behind the "two Google boxes"
// report). The reference terminal shows one tile per company; match that by
// keeping only the Class A row (GOOGL/FOXA/NWSA) of each pair.
export function dedupeMultiClass(list: Constituent[]): Constituent[] {
  const groups = new Map<string, Constituent[]>();
  for (const c of list) {
    const base = c.name.replace(/\s*\(Class\s+[A-Z]\)\s*$/i, '').trim() || c.name;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(c);
  }
  const out: Constituent[] = [];
  for (const rows of groups.values()) out.push(rows.length === 1 ? rows[0] : (rows.find((r) => /\(Class A\)\s*$/i.test(r.name)) || rows[0]));
  return out;
}

// r2k roster: all cap-bearing screener rows ranked by cap, skip the large/mid
// band, take the next R2K_TAKE. Sector/name/industry come from the screener
// itself — industry gives finviz-style sub-bands and full-group popups.
export function r2kConstituents(quotes: Map<string, Quote>): Constituent[] {
  const seen = new Set<string>();
  const rows: { sym: string; cap: number; sector: string; name: string; industry: string }[] = [];
  for (const [sym, q] of quotes) {
    if (sym.includes('-') && seen.has(sym.replace(/-/g, '.'))) continue; // alias rows
    if (seen.has(sym)) continue;
    seen.add(sym);
    if (!q.cap || !q.sector) continue;
    if (/\^|\.W$|\.U$|\.R$/.test(sym)) continue; // warrants/units/rights
    rows.push({ sym, cap: q.cap, sector: q.sector, name: q.name || sym, industry: q.industry || '' });
  }
  rows.sort((a, b) => b.cap - a.cap);
  return rows.slice(R2K_SKIP, R2K_SKIP + R2K_TAKE)
    .map((r) => ({ sym: r.sym, name: r.name, sector: r.sector, ind: r.industry }));
}

// ETF cut: group the roster by its own band and size by dollar volume.
// Tile shape is IDENTICAL to buildHeatmap's, so the client treemap renderer,
// the period re-colour and the tooltip all work unchanged.
export function buildEtfMap(
  cats: Record<string, string>,
  quotes: Map<string, Quote>,
  periods?: Map<string, Periods> | null,
) {
  const byBand = new Map<string, { sym: string; name: string; cap: number; pct: number; ind: string; last: number | null; extPct?: number | null; extLast?: number | null; pctW?: number | null; pctM?: number | null; pctYtd?: number | null }[]>();
  let covered = 0;
  for (const [sym, band] of Object.entries(cats)) {
    const q = quotes.get(yahooTicker(sym)) || quotes.get(sym);
    if (!q || !Number.isFinite(q.pct)) continue;
    covered++;
    /* Sized by dollar volume — ETFs have no market cap. A missing volume must
       NOT drop the tile: the treemap only needs a positive area, and a name
       that trades thinly is still a name the owner asked to see. It falls to
       the floor and renders small, which is the honest outcome. */
    const dv = q.last && q.advol ? q.last * q.advol : 0;
    const p = periods?.get(yahooTicker(sym)) || periods?.get(sym);
    if (!byBand.has(band)) byBand.set(band, []);
    byBand.get(band)!.push({
      sym, name: q.name || sym, cap: Math.max(dv, 1), pct: q.pct, ind: band,
      last: q.last ?? null,
      ...(q.extPct != null ? { extPct: q.extPct, extLast: q.extLast ?? null } : {}),
      ...(p ? { pctW: p.w, pctM: p.m, pctYtd: p.ytd } : {}),
    });
  }
  const sectors = [...byBand.entries()]
    .map(([name, tiles]) => ({
      name,
      cap: tiles.reduce((s, t) => s + t.cap, 0),
      tiles: tiles.sort((a, b) => b.cap - a.cap),
    }))
    .sort((a, b) => b.cap - a.cap);
  return { sectors, covered };
}

function lastTradingDayIso(): string {
  // Anchor to the US market's calendar day (Eastern time), NOT UTC. After
  // ~20:00 ET the UTC date has already rolled to "tomorrow", so a UTC-based
  // stamp read a day ahead for evening US viewers (e.g. 6pm PT showed the next
  // date). Weekends roll back to Friday. (desk-news uses the same ET anchor.)
  const etIso = NY_DATE.format(new Date()); // YYYY-MM-DD in ET
  const d = new Date(etIso + 'T12:00:00Z'); // noon-UTC anchor keeps DOW math on the ET date
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── caches (per universe where applicable) ───────────────────────────────────
let constituentsCache: { at: number; list: Constituent[] } | null = null;  // 24h, sp500
let capCache: { at: number; caps: Map<string, number> } | null = null;     // 24h, sp500
const payloadCache = new Map<string, { at: number; body: unknown }>();     // session-aware
const inflight = new Map<string, Promise<unknown>>();                      // single-flight
const periodCache = new Map<string, { at: number; map: Map<string, Periods> }>(); // module mirror
const periodInflight = new Map<string, Promise<void>>();
let etfCatsCache: { at: number; cats: Record<string, string> } | null = null;  // 1h

/* The ETF roster IS its grouping — one object, so a symbol can never be
   charted without a band or banded without being charted (the drift that left
   this cut rendering 25 of 40 tiles). Normalised the same way the client reads
   it, capped like every other runtime-loaded roster, and cached for an hour so
   an edit is picked up without a deploy. A malformed file falls back to the
   built-in copy rather than emptying the map. */
async function loadEtfCats(): Promise<Record<string, string>> {
  if (etfCatsCache && Date.now() - etfCatsCache.at < 3_600_000) return etfCatsCache.cats;
  try {
    const res = await fetch(MAP_FILTERS_URL, { headers: UA });
    if (res.ok) {
      const json = await res.json();
      const raw = json?.etfCats;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          const sym = String(k).trim().toUpperCase();
          const band = typeof v === 'string' ? v.trim() : '';
          if (sym && band && Object.keys(out).length < ETF_CAP) out[sym] = band;
        }
        if (Object.keys(out).length) {
          etfCatsCache = { at: Date.now(), cats: out };
          return out;
        }
      }
    }
  } catch { /* fall through to the built-in roster */ }
  etfCatsCache = { at: Date.now(), cats: DEFAULT_ETF_CATS };
  return DEFAULT_ETF_CATS;
}

// Period sweeps persist in desk_feed_cache (desk_006) and advance in SMALL
// STEPS (a few spark batches per invocation): module memory dies with the
// isolate, and a single long background sweep gets killed by the edge
// runtime's background budget. Each request nudges the sweep forward; the
// client's 5-min poller (or a burst of calls) completes it, and the row is
// the durable progress ledger. Row payload: { done, total, map }.
const SWEEP_STEP_BATCHES = 8; // 8 × 20 symbols per nudge — a CEILING, not a target
// Wall-clock ceiling on one nudge's Yahoo fetching. A batch count alone cannot
// bound a run of sequential awaited fetches: when Yahoo is slow, 8 batches is
// however long 8 batches takes, and on the r2k path that lands on top of a
// screener download the worker has already paid for.
//
// Owner report 2026-08-05: desk-heatmap returning 546 on every call. The
// ledger told the story — periods:r2k stuck at 480/2000 for TWELVE DAYS,
// periods:sp500 at 320/500. Neither was converging, because advanceSweep
// persisted only AFTER the whole slice: a request killed at the resource
// limit threw away every symbol it had just fetched, and the next request
// started from the same number. The sweep was doing the work and never
// keeping it.
//
// 2.5s leaves room for the screener download, the heatmap build and the write
// inside the worker's budget. A slow nudge now advances by one or two batches
// instead of dying at eight — slower per request, but monotonic, which is the
// property that was actually missing.
const SWEEP_BUDGET_MS = 2500;
function feedCacheHeaders() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}
type SweepRow = { at: number; done: number; total: number; map: Record<string, Periods> };
async function readSweepRow(universe: string): Promise<SweepRow | null> {
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const rows = await (await fetch(
      `${url}/rest/v1/desk_feed_cache?select=at,payload&key=eq.periods:${universe}`,
      { headers: feedCacheHeaders() },
    )).json();
    if (!rows?.length) return null;
    const p = rows[0].payload || {};
    return { at: new Date(rows[0].at).getTime(), done: Number(p.done) || 0, total: Number(p.total) || 0, map: p.map || {} };
  } catch { return null; }
}
async function writeSweepRow(universe: string, row: SweepRow): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL')!;
  await fetch(`${url}/rest/v1/desk_feed_cache?on_conflict=key`, {
    method: 'POST',
    headers: { ...feedCacheHeaders(), prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{
      key: `periods:${universe}`, at: new Date(row.at).toISOString(),
      payload: { done: row.done, total: row.total, map: row.map },
    }]),
  }).catch(() => { /* next step retries */ });
}
const sweepComplete = (r: SweepRow | null): r is SweepRow =>
  Boolean(r && r.total > 0 && r.done >= r.total && Date.now() - r.at < 86_400_000);

async function loadPeriods(universe: string): Promise<{ at: number; map: Map<string, Periods> } | null> {
  const hit = periodCache.get(universe);
  if (hit && Date.now() - hit.at < 86_400_000) return hit;
  const row = await readSweepRow(universe);
  if (!sweepComplete(row)) return null;
  const entry = { at: row.at, map: new Map<string, Periods>(Object.entries(row.map)) };
  periodCache.set(universe, entry);
  return entry;
}

// Progress is tracked BY SYMBOL, not by position in the roster.
//
// The original ledger compared roster SIZE (`row.total !== symbols.length →
// resweep`) and sliced the next step by an index into a freshly-fetched list.
// Both assumptions fail against the live screener: it re-sorts by market cap
// and drifts a name or two most days. So a finished 500-name sweep was
// discarded whenever 498 came back, and every subsequent request redid a
// 160-symbol step (8 Yahoo 1-year spark calls) inline before it could answer.
// That extra work is what pushed the worker past its resource limit — the
// function returned HTTP 546 on roughly one call in three, and the desk showed
// a blank map with a STALE lamp (owner report 2026-07-30). Set-based progress
// converges instead: a two-name drift now costs two lookups, not 500.
async function advanceSweep(universe: string, symbols: string[]): Promise<void> {
  const prev = await readSweepRow(universe);
  const fresh = Boolean(prev && Date.now() - prev.at < 86_400_000);   // else: daily refresh
  const map: Record<string, Periods> = fresh ? { ...prev!.map } : {};
  const want = new Set(symbols);
  for (const sym of Object.keys(map)) if (!want.has(sym)) delete map[sym];  // dropped from roster
  const slice = symbols.filter((s) => !(s in map)).slice(0, SWEEP_STEP_BATCHES * 20);

  if (slice.length) {
    const { out: got, answered } = await periodSweep(slice, 20, Date.now() + SWEEP_BUDGET_MS);
    for (const sym of slice) {
      // The ledger is keyed by ROSTER symbol (what `want` compares against),
      // but periodSweep answers in Yahoo's form — BRK.B comes back as BRK-B.
      // Resolve through yahooTicker or every dotted ticker loses its periods.
      const p = got.get(yahooTicker(sym)) ?? got.get(sym);
      if (p) map[sym] = p;
      // Yahoo replied but carries nothing for this symbol → record an EMPTY
      // reading. Left out entirely it stays "missing" forever, the ledger
      // never completes, and every request keeps paying a sweep step — the
      // 546s this change exists to stop. An empty reading renders exactly
      // like no reading, since the client drops non-finite periods.
      else if (answered.has(sym)) map[sym] = { w: null, m: null, ytd: null };
      // else: the batch itself failed. Leave the symbol missing so the next
      // request retries it — burying 20 names for 24 hours on one transient
      // network blip is not the same thing as knowing they have no data.
    }
  }

  const done = Object.keys(map).length;
  const row: SweepRow = { at: Date.now(), done, total: symbols.length, map };
  if (!slice.length) {
    // Nothing left to sweep. Preserve the original timestamp so the 24h
    // refresh still fires on schedule — stamping `at` on every no-op call
    // would hold the ledger permanently "fresh" and freeze the period data.
    if (fresh && prev!.done === done && prev!.total === symbols.length) return;
    row.at = fresh ? prev!.at : Date.now();
  }
  await writeSweepRow(universe, row);
  if (done >= symbols.length) payloadCache.delete(universe); // next call rebuilds WITH periods
}

async function kickPeriodSweep(universe: string, symbols: string[]): Promise<void> {
  const hit = periodCache.get(universe);
  if (hit && Date.now() - hit.at < 86_400_000) return;
  if (periodInflight.has(universe)) return;
  // AWAITED on purpose: waitUntil-style background work proved unreliable
  // here (steps never ran post-response). One step is ~4 spark calls, and
  // only requests during an incomplete sweep pay it.
  const work = advanceSweep(universe, symbols)
    .catch(() => { /* next request retries */ })
    .finally(() => { periodInflight.delete(universe); });
  periodInflight.set(universe, work);
  await work;
}

async function refreshSp500(): Promise<unknown> {
  if (!constituentsCache || Date.now() - constituentsCache.at > 86_400_000) {
    const res = await fetch(CONSTITUENTS_URL, { headers: UA });
    if (!res.ok) throw new Error(`constituents HTTP ${res.status}`);
    const list = parseConstituents(await res.text());
    if (list.length < 400) throw new Error(`only ${list.length} constituents parsed`);
    constituentsCache = { at: Date.now(), list: dedupeMultiClass(list) };
  }
  const constituents = constituentsCache.list;
  const hits = (q: Map<string, Quote>) => constituents.filter((c) => q.get(yahooTicker(c.sym)) || q.get(c.sym)).length;

  let quotes: Map<string, Quote>, source = 'nasdaq-screener';
  try {
    quotes = await nasdaqScreener();
    if (hits(quotes) < 300) throw new Error(`screener coverage too thin (${hits(quotes)})`);
    /* The screener carries no after-hours print, and it is the path this
       function actually takes — extPct was only ever computed in the Yahoo
       FALLBACK below, so the heatmap's post-market tooltips never appeared in
       practice (Codex review, PR #199). Merge one Yahoo pass over the roster on
       top of the screener's regular quotes.

       Cost, stated correctly (the first version of this comment was wrong).
       It claimed a "60-min TTL when the session is shut ... about four batched
       calls an hour". But the same commit put withinPostMarket() into ttlMs(),
       so throughout 16:00-20:00 ET the TTL is 300_000 — FIVE minutes. The real
       ceiling is up to 12 refreshes an hour during that window, each a full
       screener download plus this Yahoo sweep, on an anon-callable function
       whose 546s came from exactly this kind of per-refresh upstream work.
       That is a deliberate trade (a stale after-hours number is the thing this
       feature exists to fix), but it should be recorded as what it is.

       Bounded like desk-market's identical call. A REJECTING Yahoo was already
       handled; a STALLING one was not, and that is the shape that kills the
       invocation after the screener has already succeeded — the documented
       546 → blank map + STALE lamp path. Promise.race resolves an empty map
       instead, so a hung upstream costs the extended lines and nothing else. */
    if (withinPostMarket()) {
      try {
        const ext = await Promise.race([
          quoteBatch(constituents.map((c) => c.sym), await getCrumb()),
          new Promise<Map<string, Quote>>((resolve) =>
            setTimeout(() => resolve(new Map()), EXT_QUOTE_TIMEOUT_MS)),
        ]);
        for (const [sym, q] of ext) {
          const base = quotes.get(sym);
          if (base && q.extPct != null) { base.extPct = q.extPct; base.extLast = q.extLast ?? null; }
        }
      } catch { /* extended lines only — the core payload stands */ }
    }
  } catch {
    try {
      quotes = await quoteBatch(constituents.map((c) => c.sym), await getCrumb());
      source = 'yahoo-quote';
      if (hits(quotes) < 300) throw new Error(`quote coverage too thin (${hits(quotes)})`);
    } catch {
      quotes = await sparkBatch(constituents.map((c) => c.sym));
      source = 'yahoo-spark+cap-cache';
      if (hits(quotes) < 300) throw new Error(`spark coverage too thin (${hits(quotes)})`);
    }
  }

  // caps: harvest from this pass when present; otherwise lean on the 24h cache
  const prevCaps = capCache && Date.now() - capCache.at < 86_400_000 ? capCache.caps : new Map<string, number>();
  const periods = await loadPeriods('sp500');
  const { sectors, covered } = buildHeatmap(constituents, quotes, prevCaps, periods?.map);
  if (covered < 300) throw new Error(`heatmap coverage too thin after cap merge (${covered})`);
  const harvested = new Map<string, number>(prevCaps);
  for (const s of sectors) for (const t of s.tiles) harvested.set(t.sym, t.cap);
  capCache = { at: capCache && source === 'yahoo-spark+cap-cache' ? capCache.at : Date.now(), caps: harvested };

  await kickPeriodSweep('sp500', constituents.map((c) => c.sym));
  const body = {
    ok: true, asOf: lastTradingDayIso(), generatedAt: new Date().toISOString(),
    source, count: covered, periodsAsOf: periods ? new Date(periods.at).toISOString() : null, sectors,
  };
  payloadCache.set('sp500', { at: Date.now(), body });
  return body;
}

async function refreshR2k(): Promise<unknown> {
  const quotes = await nasdaqScreener(); // roster AND quotes in one call
  const constituents = r2kConstituents(quotes);
  if (constituents.length < 1200) throw new Error(`r2k roster too thin (${constituents.length})`);
  let periods = await loadPeriods('r2k');
  // Periods must cover the roster — a partial map would shrink period views.
  // Count FINITE readings, not map entries: symbols Yahoo has no data for are
  // recorded as empty placeholders, and counting those as coverage would let a
  // map that is mostly blanks pass the guard and unlock period views onto a
  // small, unrepresentative subset of the index.
  const usable = periods
    ? [...periods.map.values()].filter((p) => Number.isFinite(p.w) || Number.isFinite(p.m) || Number.isFinite(p.ytd)).length
    : 0;
  if (periods && usable < constituents.length * 0.8) periods = null;
  const { sectors, covered } = buildHeatmap(constituents, quotes, new Map(), periods?.map);
  if (covered < 1200) throw new Error(`r2k coverage too thin (${covered})`);
  await kickPeriodSweep('r2k', constituents.map((c) => c.sym));
  const body = {
    ok: true, asOf: lastTradingDayIso(), generatedAt: new Date().toISOString(),
    source: 'nasdaq-screener', universe: 'r2k', count: covered,
    note: `full small-cap band, ${covered} names (cap ranks ${R2K_SKIP + 1}–${R2K_SKIP + R2K_TAKE})`,
    periodsAsOf: periods ? new Date(periods.at).toISOString() : null, sectors,
  };
  payloadCache.set('r2k', { at: Date.now(), body });
  return body;
}

/* ETF cut. 40 names is ONE quote batch and well inside a single sweep nudge
   (160), so unlike the stock universes this one converges on its first call.
   The screener is not a fallback here — it lists common stocks, not funds — so
   a crumb failure degrades to the 5-day spark, which still carries price and
   day-%; only the dollar-volume weighting is lost, and every tile falls to the
   area floor together, so the map stays readable rather than disappearing. */
async function refreshEtf(): Promise<unknown> {
  const cats = await loadEtfCats();
  const symbols = Object.keys(cats);
  let quotes: Map<string, Quote>, source = 'yahoo-quote';
  try {
    quotes = await quoteBatch(symbols, await getCrumb());
    if (quotes.size < symbols.length * 0.6) throw new Error(`quote coverage too thin (${quotes.size})`);
  } catch {
    quotes = await sparkBatch(symbols);
    source = 'yahoo-spark';
  }
  const periods = await loadPeriods('etf');
  const { sectors, covered } = buildEtfMap(cats, quotes, periods?.map);
  if (covered < Math.ceil(symbols.length * 0.6)) throw new Error(`etf coverage too thin (${covered}/${symbols.length})`);
  await kickPeriodSweep('etf', symbols);
  const body = {
    ok: true, asOf: lastTradingDayIso(), generatedAt: new Date().toISOString(),
    source, universe: 'etf', count: covered,
    periodsAsOf: periods ? new Date(periods.at).toISOString() : null, sectors,
  };
  payloadCache.set('etf', { at: Date.now(), body });
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  let universe = 'sp500';
  let force = false;
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    // strict enum — anything else is sp500
    if (body?.universe === 'r2k' || body?.universe === 'etf') universe = body.universe;
    // force (owner request 2026-07-27): the dashboard's manual "Refresh now"
    // button bypasses this cache so a click guarantees a fresh upstream pull.
    force = body?.force === true;
  }

  const cached = payloadCache.get(universe);
  if (!force && cached && Date.now() - cached.at < ttlMs()) {
    // cache hits still nudge an incomplete period sweep — otherwise the
    // sweep would only advance on TTL expiry (hours, off-session)
    // deno-lint-ignore no-explicit-any
    const syms = ((cached.body as any)?.sectors || []).flatMap((s: any) => s.tiles.map((t: any) => t.sym));
    if (syms.length) await kickPeriodSweep(universe, syms);
    return reply(200, cached.body);
  }

  try {
    if (!inflight.has(universe)) {
      const work = (universe === 'r2k' ? refreshR2k() : universe === 'etf' ? refreshEtf() : refreshSp500())
        .finally(() => { inflight.delete(universe); });
      inflight.set(universe, work);
    }
    return reply(200, await inflight.get(universe)!);
  } catch (e) {
    if (cached) return reply(200, cached.body); // stale-but-honest
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
