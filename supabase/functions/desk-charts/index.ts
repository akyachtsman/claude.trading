// ── desk-charts — watchlist OHLCV histories, delayed on demand ───────────────
// Replaces the nightly fetch-charts.js → data/charts.json step
// (retire-nightly-pipeline plan, Group A). Same per-symbol chain (Stooq daily
// CSV → Yahoo v8 chart), same packed shape. Roster comes from the
// Pages-served config/chart-watchlist.json (owner-editable, NEVER derived
// from holdings — public repo), falling back to the classic desk roster.
//
// Cold-cache economics: ~25 upstream calls. Fetched in PARALLEL BATCHES of 8
// (the 400ms etiquette sleeps were a runner-IP mitigation) under a first-
// response budget — whatever resolves within ~4s is served with
// partial:true, and the stragglers keep filling the module cache for the
// next call. History bars are EOD data: a full refetch only happens when the
// 30-min history TTL lapses; within it the session-aware TTL (5/60 min) only
// gates re-serving the cached payload.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk charts; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/chart-watchlist.json';

const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'SMH',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLB', 'XLU', 'XLY', 'XLP', 'KRE',
  'GLD', 'SLV', 'TLT', 'TLH', 'SHY', 'UUP', 'VXX', 'EEM', 'FXI', 'INDA',
];
const KEEP_BARS = 800;      // ~3 years of view + weekly-stoch warmup (owner ruling 2026-07-14)
const MIN_COVERAGE = 0.6;   // below this fraction of the roster → ok:false
const HISTORY_TTL_MS = 1_800_000; // EOD bars don't change intraday
const BATCH = 8;
const FIRST_RESPONSE_BUDGET_MS = 4_000;

type Row = { date: string; o: number; h: number; l: number; c: number; v: number };
type Packed = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };

// ── parsers (verbatim ports of lib/ohlc.js) ─────────────────────────────────
export function parseStooqOHLC(csv: string): Row[] {
  const rows: Row[] = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const date = cols[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const [o, h, l, c] = [1, 2, 3, 4].map((i) => Number(cols[i]));
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    rows.push({ date, o, h, l, c, v: Number(cols[5]) > 0 ? Number(cols[5]) : 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

// ONE formatter, hoisted — this is the whole 546 fix (owner report 2026-08-05).
//
// `d.toLocaleDateString('en-CA', { timeZone })` builds and discards an ICU
// formatter on EVERY call. This loop runs once per bar: 25 watchlist symbols x
// ~1250 bars of Yahoo's 5y daily range is ~31k calls per cold sweep. Measured,
// that is 2611 ms of pure CPU — and the sweep is what the worker's CPU budget
// is spent on, which is why 20-30% of calls died with WORKER_RESOURCE_LIMIT at
// 2475-3074 ms while the ones that survived came in at 1736-2401 ms. The
// failures were not a slow upstream and not the payload serialization; they
// were this line.
//
// Reusing a single Intl.DateTimeFormat is the same work without the per-call
// construction: 2611 ms -> 50 ms, a 52x cut, for byte-identical output
// (verified equal across 33,334 timestamps spanning 2000-2026, which covers
// every DST transition — the reason this must stay timezone-aware rather than
// become UTC string math).
const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function parseYahooChartOHLC(json: unknown): Row[] {
  // deno-lint-ignore no-explicit-any
  const r = (json as any)?.chart?.result?.[0];
  const ts: number[] = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const rows: Row[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = Number(q.open?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), c = Number(q.close?.[i]);
    if (![o, h, l, c].every((n) => Number.isFinite(n) && n > 0)) continue;
    const date = NY_DATE.format(new Date(ts[i] * 1000));
    rows.push({ date, o, h, l, c, v: Number(q.volume?.[i]) > 0 ? Number(q.volume?.[i]) : 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function stooqOHLC(ticker: string, days = 1200): Promise<Row[]> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - days * 86400000);
  const sym = ticker.toLowerCase() + '.us';
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: UA });
  const rows = parseStooqOHLC(await res.text());
  if (rows.length < 40) throw new Error(`Stooq: ${rows.length} usable OHLC rows for ${sym}`);
  return rows;
}

async function yahooOHLC(ticker: string): Promise<Row[]> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d`, { headers: UA });
  const rows = parseYahooChartOHLC(await res.json().catch(() => null));
  if (rows.length < 40) throw new Error(`Yahoo: ${rows.length} usable OHLC rows for ${ticker}`);
  return rows;
}

// Yahoo FIRST, Stooq as the fallback — same reason as desk-market (owner
// report 2026-07-28): Stooq now serves an HTML JS-challenge page as HTTP 200
// for every symbol, so the Stooq leg was a guaranteed miss that ran before the
// Yahoo fetch on all 25 watchlist symbols. Stooq stays wired as the fallback
// so it resumes automatically if the challenge ever lifts.
const dailyOHLC = (ticker: string) => yahooOHLC(ticker).catch(() => stooqOHLC(ticker));

export function packSeries(rows: Row[]): Packed {
  const s: Packed = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const r of rows.slice(-KEEP_BARS)) {
    s.t.push(r.date);
    s.o.push(+r.o.toFixed(2)); s.h.push(+r.h.toFixed(2));
    s.l.push(+r.l.toFixed(2)); s.c.push(+r.c.toFixed(2));
    s.v.push(r.v);
  }
  return s;
}

// ── caches ───────────────────────────────────────────────────────────────────
let rosterCache: { at: number; list: string[] } | null = null;                    // 1h
// Each symbol is cached PRE-SERIALIZED, not as a Packed object. This function
// never READS the bars — it only ships them — so holding the parsed object
// alongside its own JSON is dead weight; serializing once per symbol at prime
// time leaves the request path a string join.
//
// This was FIRST shipped (v9) as a claimed fix for the 546s and was NOT one —
// measured before/after, the failure rate did not move. Recorded because the
// reasoning was wrong in an instructive way: the ~934 KB payload IS expensive
// to stringify, and a force:true sweep did survive where apparent cache hits
// died, which looked like per-request serialization was the cost. It wasn't.
// A warm-cache call was timed against a forced full sweep and cost the SAME
// (~2.2-2.9s both ways), which only makes sense if the "cache hit" was also
// sweeping — Supabase spreads requests across short-lived isolates, and
// seriesCache is per-isolate module state, so nearly every request pays a cold
// sweep. The real cost was inside that sweep, in parseYahooChartOHLC's
// per-bar date formatting (see NY_DATE). Keep this change on its own merits;
// do not re-credit it with fixing the 546s.
const seriesCache = new Map<string, { at: number; json: string; last: string }>(); // per symbol, 30 min
let sweepInflight: Promise<void> | null = null;

async function loadWatchlist(): Promise<string[]> {
  if (rosterCache && Date.now() - rosterCache.at < 3_600_000) return rosterCache.list;
  try {
    const res = await fetch(CONFIG_URL, { headers: UA });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length && list.every((s) => typeof s === 'string')) {
        // cap 40: bounds the upstream fan-out even if the committed roster balloons
        rosterCache = { at: Date.now(), list: list.map((s: string) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40) };
        return rosterCache.list;
      }
    }
  } catch { /* fall through to default */ }
  rosterCache = { at: Date.now(), list: DEFAULT_WATCHLIST };
  return rosterCache.list;
}

async function primeSymbol(ticker: string): Promise<void> {
  try {
    const rows = await dailyOHLC(ticker);
    // Serialize HERE, inside the sweep, not per request — see the seriesCache note.
    seriesCache.set(ticker, {
      at: Date.now(),
      json: JSON.stringify(packSeries(rows)),
      last: rows[rows.length - 1].date,
    });
  } catch { /* keep whatever the cache holds */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  // force (owner request 2026-07-27): the dashboard's manual "Refresh now"
  // button treats the whole watchlist as stale so a click guarantees a fresh
  // upstream pull, same contract as the other desk-* feeds' force bypass.
  let force = false;
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
  }

  const watchlist = await loadWatchlist();
  const stale = watchlist.filter((t) => {
    const hit = seriesCache.get(t);
    return force || !hit || Date.now() - hit.at > HISTORY_TTL_MS;
  });

  if (stale.length) {
    // Parallel batches with a first-response budget: don't block the panel
    // paint on a full cold sweep — stragglers finish for the next call.
    // Single-flight: a concurrent burst shares one sweep instead of each
    // caller launching its own ~25-fetch storm.
    sweepInflight ??= (async () => {
      for (let i = 0; i < stale.length; i += BATCH) {
        await Promise.all(stale.slice(i, i + BATCH).map(primeSymbol));
      }
    })().finally(() => { sweepInflight = null; });
    const work = sweepInflight;
    await Promise.race([work, new Promise((r) => setTimeout(r, FIRST_RESPONSE_BUDGET_MS))]);
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(work); // let stragglers finish filling the cache
  }

  // Assembled by concatenation from the per-symbol JSON already in the cache,
  // so the big blob is never re-serialized on the request path. Same bytes as
  // the object literal this replaced, same key order.
  const parts: string[] = [];
  let asOf: string | null = null;
  for (const t of watchlist) {
    const hit = seriesCache.get(t);
    if (!hit) continue;
    parts.push(`${JSON.stringify(t)}:${hit.json}`);
    if (!asOf || hit.last > asOf) asOf = hit.last;
  }
  const got = parts.length;
  if (got < Math.ceil(watchlist.length * MIN_COVERAGE)) {
    return reply(502, { ok: false, error: `coverage floor: ${got}/${watchlist.length} watchlist symbols` });
  }
  // generatedAt stays FRESH per request: the client measures poller staleness
  // against it (liveLampFor(data.generatedAt, ...)), so serving a memoized one
  // up to a HISTORY_TTL_MS old would lamp the charts panel STALE mid-session
  // while the feed was in fact healthy. It is the one field worth rebuilding.
  const body = '{"ok":true'
    + (got < watchlist.length ? ',"partial":true' : '')
    + `,"asOf":${JSON.stringify(asOf)}`
    + `,"generatedAt":${JSON.stringify(new Date().toISOString())}`
    + `,"count":${got}`
    + `,"symbols":{${parts.join(',')}}}`;
  return new Response(body, { status: 200, headers: { ...CORS, 'content-type': 'application/json' } });
});
