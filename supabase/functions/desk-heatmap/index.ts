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
//     finviz-style. The roster and caps come from that one bulk call; the
//     day-% is overlaid from Yahoo v7 like sp500 (the screener's own is a
//     session behind); stale-but-honest cache when the screener is down.
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

/* Deno's fetch has no default timeout, so every upstream call carries its own
   AbortSignal: a host that accepts the connection and then stalls must cost
   THAT call, never the invocation — an un-bounded await here runs the worker to
   its wall clock and ends in WORKER_RESOURCE_LIMIT (the 546s). The signal also
   covers the body read. Each call site then degrades exactly as it already did
   on a failed call: crumb -> spark fallback, screener -> cached / last-good. */
const CRUMB_TIMEOUT_MS = 4000;     // fc.yahoo.com + getcrumb share ONE deadline
const SCREENER_TIMEOUT_MS = 10000; // the one bulk ~7k-row download; the signal also covers a multi-MB body read
const FETCH_TIMEOUT_MS = 5000;     // any single other call: quote/spark batch, roster, ledger

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
/* ONE formatter for the three session-clock predicates below. They used to
   build a fresh Intl.DateTimeFormat per call — three per request through
   ttlMs() — and the ICU construction is the expensive part (see NY_DATE). The
   superset of fields is safe: each predicate reads only the parts it needs. */
const ET_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function marketSessionOpen(now = new Date()): boolean {
  const parts = ET_CLOCK.formatToParts(now);
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
  const parts = ET_CLOCK.formatToParts(now);
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
  const parts = ET_CLOCK.formatToParts(now);
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

/* The day-% merge gets a larger budget than the extended sweep, because it is
   no longer optional garnish — it is where the day-% comes from. ~500 names in
   batches of 150 is four sequential upstream calls plus a possible cold crumb
   handshake, and 4s was sized for a best-effort extra that could be dropped.
   Still bounded: a stalled Yahoo must cost freshness, never the invocation —
   that is the 546s lesson. */
const QUOTE_MERGE_TIMEOUT_MS = 9000;

/* The batch loops below run through QUOTE_LANES parallel lanes, not one after
   another: r2k's ~14 quote batches and sp500's last-resort ~26 spark batches
   cannot land inside a 9s deadline back to back, so the tail of the roster was
   silently left on the screener's session-behind day-%. Bounded, not unbounded:
   an all-at-once fan-out only moves the stall into Yahoo's rate limiter. */
const QUOTE_LANES = 4;
/* Own deadlines for the two big cases (each still bounds the invocation). */
const R2K_QUOTE_MERGE_TIMEOUT_MS = 20000;   // ~14 batches of 150 / 4 lanes
const SPARK_FALLBACK_TIMEOUT_MS = 25000;    // ~26 batches of 20 / 4 lanes: the last resort must be able to finish
/* A day-% overlay is only "fresh" when nearly every tile got it: at 60% the map
   is a mix of two sessions' numbers under a label that says otherwise. */
const FRESH_MERGE_FRACTION = 0.95;

/* `work` resolves true when its batch produced data. Failure is tracked PER
   LANE: a lane retires after ITS OWN two consecutive failures (any success of
   its own resets the count), so two failed batches beside two healthy lanes cost
   those batches — not the sweep, which a single shared streak would have stopped
   for everyone the moment two failures happened to complete back to back. A real
   outage still ends fast: every lane retires after two failures each, the same
   two-batch wall time the old sequential cutoff cost. `stop` is the deadline. */
async function inLanes<T>(items: T[], work: (item: T) => Promise<boolean>, stop: () => boolean): Promise<void> {
  let next = 0;
  const lane = async () => {
    let fails = 0;
    while (next < items.length && !stop()) {
      if (await work(items[next++])) fails = 0;
      else if (++fails >= 2) return;
    }
  };
  await Promise.all(Array.from({ length: Math.min(QUOTE_LANES, items.length) }, lane));
}
const chunked = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

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
    signal: AbortSignal.timeout(SCREENER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`screener HTTP ${res.status}`);
  return parseScreener(await res.json());
}

async function getCrumb(): Promise<{ cookie: string; crumb: string }> {
  const signal = AbortSignal.timeout(CRUMB_TIMEOUT_MS);  // one deadline for the whole handshake
  const init = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual', signal });
  const cookie = (init.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('no Yahoo session cookie issued');
  const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie }, signal });
  if (!res.ok) throw new Error(`getcrumb HTTP ${res.status}`);
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) throw new Error('no Yahoo crumb issued');
  return { cookie, crumb };
}

/* `deadline` (epoch ms) is the same device periodSweep uses: stop starting
   batches and return what has landed. It matters on the r2k path, where 2000
   names are ~14 batches and an all-or-nothing race would throw away every batch
   that had already answered. Batches run in QUOTE_LANES parallel lanes. */
async function quoteBatch(symbols: string[], auth: { cookie: string; crumb: string }, batchSize = 150, deadline = Infinity): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  await inLanes(chunked(symbols, batchSize), async (chunk) => {
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
      const res = await fetch(url, {
        headers: { ...UA, cookie: auth.cookie },
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, Math.max(250, deadline - Date.now()))),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let got = 0;   // this batch's own count: other lanes grow `out` while it awaits
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
          got++;
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
      return got > 0;
    } catch { return false; }
  }, () => Date.now() > deadline);
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

async function sparkBatch(symbols: string[], batchSize = 20, deadline = Infinity): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  // ~25 batches for sp500, in lanes: bound the SUM (the deadline), not just each call
  await inLanes(chunked(symbols, batchSize), async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(yahooTicker).join(',')}&range=5d&interval=1d`;
    const res = await fetch(url, {
      headers: UA,
      signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, Math.max(250, deadline - Date.now()))),
    }).catch(() => null);
    // a stalled/failed batch is a coverage gap, which the callers' floors already judge
    const json = res && res.ok ? await res.json().catch(() => null) : null;
    const got = parseSpark(json);
    for (const [sym, v] of got) if (!out.has(sym)) out.set(sym, v);
    return got.size > 0;
  }, () => Date.now() > deadline);
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
/* `force:true` skips every cache and this function is anon-callable, so honouring
   it unconditionally lets any caller buy a full upstream sweep per request.
   Honour it at most once per FORCE_MIN_GAP_MS per universe per isolate; inside
   the window it is treated as an ordinary (cached) call. Tradeoff: "Refresh now"
   is click-rate-limited, so a second click within 30s costs at most a <=30s-old
   answer. Per-isolate only — a speed-bump on egress, not a fleet-wide wall.
   The stamp is HANDED BACK if the forced refresh fails (the handler's catch),
   so a click that only got stale cache does not also lock out the retry. */
const FORCE_MIN_GAP_MS = 30_000;
const lastForcedAt = new Map<string, number>();
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
    const res = await fetch(MAP_FILTERS_URL, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
/* Logs must never carry the service key: a PostgREST error body can echo
   request context, so scrub before printing. */
function scrubbed(s: unknown): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const t = String(s);
  return key ? t.split(key).join('[key]') : t;
}
/* Resolves null ONLY for "the ledger has no row yet". A failed read THROWS
   instead: returning null for a 5xx / timeout / bad JSON made advanceSweep
   believe there was no ledger, sweep 160 names from scratch and OVERWRITE a
   complete 2000/2000 row with 160/2000 — one blip regressing days of work.
   loadPeriods catches it (no periods this call); advanceSweep lets it reach
   kickPeriodSweep's catch, which skips the write. */
async function readSweepRow(universe: string): Promise<SweepRow | null> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const res = await fetch(
    `${url}/rest/v1/desk_feed_cache?select=at,payload&key=eq.periods:${universe}`,
    { headers: feedCacheHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`ledger read HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('ledger read: unexpected body');
  if (!rows.length) return null;
  const p = rows[0].payload || {};
  return { at: new Date(rows[0].at).getTime(), done: Number(p.done) || 0, total: Number(p.total) || 0, map: p.map || {} };
}
async function writeSweepRow(universe: string, row: SweepRow): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL')!;
  try {
    const res = await fetch(`${url}/rest/v1/desk_feed_cache?on_conflict=key`, {
      method: 'POST',
      headers: { ...feedCacheHeaders(), prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{
        key: `periods:${universe}`, at: new Date(row.at).toISOString(),
        payload: { done: row.done, total: row.total, map: row.map },
      }]),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    /* fetch RESOLVES on 401/403/409/5xx, so the old `.catch` never saw a
       rejected write: the ledger silently stopped advancing and nothing said so.
       Still not fatal — the next request retries — but it is now visible. */
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`desk-heatmap: ledger write periods:${universe} failed HTTP ${res.status} ${scrubbed(detail).slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`desk-heatmap: ledger write periods:${universe} failed ${scrubbed((e as Error)?.name || e)}`);  // next step retries
  }
}
const sweepComplete = (r: SweepRow | null): r is SweepRow =>
  Boolean(r && r.total > 0 && r.done >= r.total && Date.now() - r.at < 86_400_000);

async function loadPeriods(universe: string): Promise<{ at: number; map: Map<string, Periods> } | null> {
  const hit = periodCache.get(universe);
  if (hit && Date.now() - hit.at < 86_400_000) return hit;
  const row = await readSweepRow(universe).catch(() => null);  // unreadable ledger = no periods this call
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
    .catch((e) => { console.error(`desk-heatmap: sweep step ${universe} skipped: ${scrubbed((e as Error)?.message || e)}`); })  // next request retries
    .finally(() => { periodInflight.delete(universe); });
  periodInflight.set(universe, work);
  await work;
}

/* Overlay Yahoo's live day-% / last / after-hours print onto the screener's
   quotes and return how many rows were refreshed. Keyed off the CONSTITUENT,
   not by iterating `fresh`: the two maps use different ticker spellings (BRK.B
   vs BRK-B) and each registers under its own, so matching by one side's keys
   alone drops the multi-class names. Shared by sp500 and r2k. */
function mergeFreshQuotes(constituents: Constituent[], quotes: Map<string, Quote>, fresh: Map<string, Quote>): number {
  let merged = 0;
  for (const c of constituents) {
    const q = fresh.get(yahooTicker(c.sym)) || fresh.get(c.sym);
    const base = quotes.get(yahooTicker(c.sym)) || quotes.get(c.sym);
    if (!q || !base) continue;
    if (Number.isFinite(q.pct)) { base.pct = q.pct; merged++; }
    if (q.last != null && Number.isFinite(q.last)) base.last = q.last;
    if (q.extPct != null) { base.extPct = q.extPct; base.extLast = q.extLast ?? null; }
  }
  return merged;
}

async function refreshSp500(): Promise<unknown> {
  if (!constituentsCache || Date.now() - constituentsCache.at > 86_400_000) {
    const res = await fetch(CONSTITUENTS_URL, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
    /* THE SCREENER'S QUOTE IS A FULL SESSION BEHIND — Yahoo supplies the
       day-%, the screener supplies the metadata (owner report 2026-08-20).

       Walmart read -0.78% on the desk while it was actually down 8.7% on
       earnings. Traced against the tape: the screener's `last` was 114.30,
       which is Aug 19's CLOSE, and -0.78% is Aug 19's change (114.30 from Aug
       18's 115.20). It was serving the previous session, labelled as today.

       The tile was already contradicting itself and nobody could see it: its
       pctW read -9.79% — essentially the real one-day move — because the
       week/month/YTD figures come from the Yahoo daily sweep, which HAS today's
       bar, while pct came from the screener, which does not. Two sources, one
       tile, disagreeing.

       It hid because on an ordinary day yesterday's close is a fraction of a
       percent from today's price, so a stale day-% looks entirely plausible. It
       only shows on a gap day — the day it matters. And the freshness lamp
       measures when we FETCHED, not how old the data is, so it reported LIVE
       over a day-old number.

       So the merge is now unconditional and it overwrites `pct`/`last`, rather
       than running only in post-market to add an after-hours line. The screener
       is still the right source for what it is good at — one call gives the
       roster, market cap, sector and industry for ~500 names, and none of those
       go stale intraday. It is simply not a quote feed.

       Bounded, and it says so when it fails. A REJECTING Yahoo was already
       handled; a STALLING one is the shape that kills the invocation after the
       screener has already succeeded — the documented 546 -> blank map + STALE
       lamp path. The deadline is passed INTO quoteBatch (not raced against it),
       so batches that landed before it are kept instead of discarded with the
       rest. But a thin merge must not pass silently as fresh: `source` records
       which numbers the payload is actually carrying, so a lagging day-% is
       visible in the response rather than only on a chart. */
    const auth = await getCrumb();   // a crumb failure still falls through to the outer catch, as before
    const fresh = await quoteBatch(constituents.map((c) => c.sym), auth, 150, Date.now() + QUOTE_MERGE_TIMEOUT_MS);

    const merged = mergeFreshQuotes(constituents, quotes, fresh);
    source = merged >= constituents.length * FRESH_MERGE_FRACTION ? 'nasdaq-screener+yahoo-quote' : `nasdaq-screener (day% may lag, ${merged} refreshed)`;
  } catch {
    try {
      quotes = await quoteBatch(constituents.map((c) => c.sym), await getCrumb(), 150, Date.now() + QUOTE_MERGE_TIMEOUT_MS);
      source = 'yahoo-quote';
      if (hits(quotes) < 300) throw new Error(`quote coverage too thin (${hits(quotes)})`);
    } catch {
      quotes = await sparkBatch(constituents.map((c) => c.sym), 20, Date.now() + SPARK_FALLBACK_TIMEOUT_MS);
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
  const quotes = await nasdaqScreener(); // roster AND cap/sector/name in one call
  const constituents = r2kConstituents(quotes);
  if (constituents.length < 1200) throw new Error(`r2k roster too thin (${constituents.length})`);
  /* The screener's day-% is a FULL SESSION BEHIND (see refreshSp500: WMT read
     -0.78% on a -8.7% day). r2k was left reading it raw, so this universe put a
     stale pct next to pctW/pctM/pctYtd from the Yahoo sweep that HAS today's
     bar — two sources, one tile. Same rule as sp500: Yahoo supplies day-% /
     last / after-hours, the screener supplies roster and caps.
     Unlike sp500 there is no other quote source to fall back to, so a Yahoo
     failure here keeps the screener's numbers and SAYS so in `source`, rather
     than failing a map that was renderable before. The batches run in lanes
     under their own deadline and a partial merge is kept (a stalled batch costs
     its own names); only a near-complete merge is labelled fresh. */
  const fresh = await (async () => {
    try {
      return await quoteBatch(constituents.map((c) => c.sym), await getCrumb(), 150, Date.now() + R2K_QUOTE_MERGE_TIMEOUT_MS);
    } catch { return new Map<string, Quote>(); }
  })();
  const merged = mergeFreshQuotes(constituents, quotes, fresh);
  const source = merged >= constituents.length * FRESH_MERGE_FRACTION ? 'nasdaq-screener+yahoo-quote' : `nasdaq-screener (day% may lag, ${merged} refreshed)`;
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
    source, universe: 'r2k', count: covered,
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
  let stampedFrom: number | null = null;   // the stamp this request replaced, so a failure can restore it
  if (force) {
    const prev = lastForcedAt.get(universe) ?? 0;
    if (Date.now() - prev < FORCE_MIN_GAP_MS) force = false;
    else { stampedFrom = prev; lastForcedAt.set(universe, Date.now()); }
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
    if (stampedFrom !== null) lastForcedAt.set(universe, stampedFrom);  // failed forced refresh: don't lock out the retry
    if (cached) return reply(200, cached.body); // stale-but-honest
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
