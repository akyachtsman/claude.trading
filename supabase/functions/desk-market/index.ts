// ── desk-market — market summary strip, delayed quotes on demand ─────────────
// Replaces the nightly fetch-market.js → data/market.json step
// (retire-nightly-pipeline plan, Group A). Same sources, same tile shape:
// Yahoo v8 chart → Stooq daily CSV fallback for the five index tiles, FRED
// DGS10 for the 10Y (T-1 by upstream construction — stamped with the SERIES
// date, never the fetch time; see the plan's lamp carve-out).
// The core six tiles (5 indices + FRED 10Y) must ALL succeed or the response is
// ok:false — the client keeps its last good payload (FR-R9); a partial CORE
// strip is a lie, not a degradation. The extras (Bitcoin/Gold/US Dollar plus
// the watchlist ETFs + 11 SPDR sectors, owner request 2026-07-16) are additive
// best-effort: each is fetched with its own catch + latency cap, so a flaky OR
// slow one drops only its tile and never gates the core.
//
// Anon-callable: public market data, no caller input reaches the upstream
// URLs. Module cache TTL is session-aware (1 min while the US equities
// session is open — cut from 5 min, owner report 2026-07-28 — 60 min closed;
// spec Clarification 6).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk market; +https://akyachtsman.github.io/claude.trading/)' };

const MARKET_SYMBOLS: { sym: string; name: string }[] = [
  { sym: '^spx', name: 'S&P 500' },
  // ^ixic (Nasdaq Composite), not ^ndx (Nasdaq-100): owner report 2026-07-27 —
  // the desk's "NASDAQ" tile was tracking the 100-name mega-cap index while
  // every other reference the owner trusts (IBKR's own "NASDAQ" quote) means
  // the ~3,000+ name Composite. Matching that avoids two different indices
  // hiding behind the same everyday name.
  { sym: '^ixic', name: 'Nasdaq Composite' },
  { sym: '^dji', name: 'Dow Jones' },
  { sym: 'iwm.us', name: 'IWM (R2K proxy)' },
  { sym: '^vix', name: 'VIX' },
];
// Extras (owner request 2026-07-16 — folded in from the old ticker tape, then
// expanded with the watchlist ETFs + SPDR sectors). These are BEST-EFFORT:
// fetched with a per-symbol catch + latency cap so a flaky/slow quote drops
// only its own tile, never gating the core six (which the S14 canary + FR-R9
// all-or-nothing contract depend on).
const EXTRA_SYMBOLS: { sym: string; name: string }[] = [
  { sym: 'btcusd', name: 'Bitcoin' },
  { sym: 'xauusd', name: 'Gold' },
  { sym: 'dx.f', name: 'US Dollar' },
  // Owner request 2026-07-16: the watchlist ETFs + all 11 SPDR sector funds as
  // strip tiles. BEST-EFFORT like the extras above (own per-symbol catch +
  // latency cap) — a flaky one drops only its own tile, never the core six.
  // Stooq-style tickers (lowercase + .us) are the canonical key here even
  // though Yahoo is now the primary fetch — yahooSymbol() maps them across
  // (strips .us → uppercase), and Stooq remains the fallback. The index
  // equivalents SPY/QQQ/DIA/IWM/VXX are intentionally NOT here — the core
  // tiles already show them (owner ruling: skip the dupes).
  { sym: 'xlk.us', name: 'XLK' }, { sym: 'xlf.us', name: 'XLF' },
  { sym: 'xle.us', name: 'XLE' }, { sym: 'xli.us', name: 'XLI' },
  { sym: 'xlb.us', name: 'XLB' }, { sym: 'xlv.us', name: 'XLV' },
  { sym: 'xly.us', name: 'XLY' }, { sym: 'xlp.us', name: 'XLP' },
  { sym: 'xlu.us', name: 'XLU' }, { sym: 'xlre.us', name: 'XLRE' },
  { sym: 'xlc.us', name: 'XLC' }, { sym: 'smh.us', name: 'SMH' },
  { sym: 'kre.us', name: 'KRE' }, { sym: 'gld.us', name: 'GLD' },
  { sym: 'slv.us', name: 'SLV' }, { sym: 'tlt.us', name: 'TLT' },
  { sym: 'tlh.us', name: 'TLH' }, { sym: 'shy.us', name: 'SHY' },
  { sym: 'uup.us', name: 'UUP' }, { sym: 'eem.us', name: 'EEM' },
  { sym: 'fxi.us', name: 'FXI' }, { sym: 'inda.us', name: 'INDA' },
  { sym: 'jpxn.us', name: 'JPXN' }, { sym: 'spyd.us', name: 'SPYD' },
];
const YAHOO_MAP: Record<string, string> = {
  '^spx': '^GSPC', '^ixic': '^IXIC', '^dji': '^DJI', '^vix': '^VIX',
  'btcusd': 'BTC-USD', 'xauusd': 'GC=F', 'dx.f': 'DX-Y.NYB',
};

// ── session-aware cache TTL (spec Clarification 6) ──────────────────────────
// US equities regular session: Mon–Fri 09:30–16:00 America/New_York
// (Intl handles DST), minus the NYSE full-closure holidays below.
// HOLIDAY LIST — refresh annually (2026–2027 seeded at migration time).
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
export function marketSessionOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (NYSE_HOLIDAYS.has(date)) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
// Owner report 2026-07-27: Stooq/Yahoo's final settle print doesn't always
// land at the exact 4:00pm ET closing bell — a few minutes' lag is common.
// Both this cache's TTL and the client poll cadence jump straight from 5-min
// to 60-min the instant the session is marked closed, so a not-quite-final
// print could get cached for up to an hour with no staleness flag (the
// client's EOD lamp skips the freshness check by design once the market
// shuts). Keep the 5-min TTL for a short grace window right after the close
// so the real settle print gets picked up quickly.
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
// Open-session TTL cut 5 min → 1 min (owner report 2026-07-28: the tiles read
// visibly behind a live IBKR quote). The upstream Yahoo feed is real-time —
// measured at ~5-second-old ticks — so the lag the owner saw was entirely this
// cache plus the client's poll interval stacking, up to ~10 min combined. At
// 1 min each, worst-case on-screen staleness drops to ~2 min. The closed-market
// TTL stays at 60 min: prices are frozen, so re-polling buys nothing.
const OPEN_TTL_MS = 60_000;
const CLOSED_TTL_MS = 3_600_000;
const ttlMs = () => (marketSessionOpen() || withinCloseSettleGrace() ? OPEN_TTL_MS : CLOSED_TTL_MS);

// ── quote chain (verbatim ports of lib/stooq.js + lib/quotes.js) ────────────
type Row = { date: string; close: number };
// A symbol's daily closes plus, when the upstream gives one, the exact instant
// its last price was quoted. `quoteTs` is what lets the desk print the QUOTE
// time rather than its own fetch clock — the difference that makes a
// side-by-side against a broker screen meaningful (owner report 2026-07-29: an
// IBKR tile read +0.07% against the desk's −0.43%; both were the Composite off
// the same prior close, IBKR's tick was ~21 minutes old, and nothing on either
// screen said so).
type Series = { rows: Row[]; quoteTs?: number };

export function parseStooqDaily(csv: string): Row[] {
  const rows: Row[] = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const date = cols[0].trim();
    const close = Number(cols[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function stooqDaily(symbol: string): Promise<Series> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - 90 * 86400000);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await fetch(url, { headers: UA });
  const rows = parseStooqDaily(await res.text());
  if (rows.length < 2) throw new Error(`Stooq: ${rows.length} usable rows for ${symbol}`);
  // Stooq's daily CSV carries no intraday quote clock, so no quoteTs — the
  // client falls back to the fetch clock for these, as it always did.
  return { rows };
}

export function yahooSymbol(stooqSym: string): string {
  if (YAHOO_MAP[stooqSym]) return YAHOO_MAP[stooqSym];
  if (stooqSym.endsWith('.us')) return stooqSym.slice(0, -3).toUpperCase();
  return stooqSym.toUpperCase();
}

export function parseYahooChart(json: unknown): Row[] {
  // deno-lint-ignore no-explicit-any
  const r = (json as any)?.chart?.result?.[0];
  const ts: number[] = r?.timestamp || [];
  const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close || [];
  const rows: Row[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function yahooDaily(stooqSym: string): Promise<Series> {
  const sym = yahooSymbol(stooqSym);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
  const res = await fetch(url, { headers: UA });
  const json = await res.json().catch(() => null);
  const rows = parseYahooChart(json);
  if (rows.length < 2) throw new Error(`Yahoo: ${rows.length} usable rows for ${sym}`);
  // deno-lint-ignore no-explicit-any
  const meta = (json as any)?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  const ts = Number(meta?.regularMarketTime);
  const last = rows[rows.length - 1];
  // The live tick beats the daily bar's close, which trails it by up to a
  // minute mid-session. Only applied when the quote falls on the SAME ET
  // session as the last bar — otherwise a pre-open tick would be scored
  // against the wrong previous close.
  //
  // Deliberately NOT taking `meta.chartPreviousClose` as the day-change
  // baseline: that field is the close preceding the REQUESTED RANGE, so on
  // this 3-month call it reads ~3 months back (measured 24,673.24 against
  // yesterday's real 24,876.91). The baseline stays the second-to-last daily
  // bar, which is the actual prior session.
  if (Number.isFinite(price) && price > 0 && Number.isFinite(ts)) {
    const quoteDate = new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (quoteDate === last.date) {
      last.close = price;
      return { rows, quoteTs: ts };
    }
  }
  return { rows };
}

// Yahoo FIRST, Stooq as the fallback (owner report 2026-07-28, verified same
// day). Stooq now answers every request — index and US-equity symbols alike,
// any user-agent — with an HTML JavaScript proof-of-work challenge served as
// HTTP 200, so `res.ok` is true and only the row-count check catches it. That
// made Stooq a guaranteed failure on the happy path: every refresh fired 29
// doomed Stooq requests (5 core + 24 extras) and waited on each before falling
// back to Yahoo, roughly doubling latency and wasting egress for nothing.
// Yahoo also carries a REAL-TIME index quote where Stooq's daily CSV lags, so
// this ordering is what makes the tiles track IBKR intraday rather than trail
// it. Stooq stays as the fallback: it costs nothing while Yahoo is healthy
// (only tried if Yahoo throws) and revives on its own if the challenge lifts.
const dailyCloses = (symbol: string) => yahooDaily(symbol).catch(() => stooqDaily(symbol));

// Latency guard for the best-effort extras: resolve null on rejection OR on a
// hung/slow upstream, so a stalled optional quote can never hold the core
// payload past the edge timeout (Codex #109). clearTimeout avoids a dangling
// isolate timer on the happy path.
function bestEffort(p: Promise<Series>, ms: number): Promise<Series | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// ── tile shaping (verbatim ports of fetch-market.js) ────────────────────────
const fmtLast = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function tileFrom(name: string, series: Series) {
  const rows = series.rows;
  const closes = rows.map((r) => r.close);
  const [prev, last] = closes.slice(-2);
  return {
    name,
    last: fmtLast(last),
    chg: Number(((last / prev - 1) * 100).toFixed(2)),
    spark: closes.slice(-30).map((c) => Number(c.toFixed(4))),
    asOf: rows[rows.length - 1].date,
    // When this price was QUOTED, not when we fetched it. Absent on the Stooq
    // fallback and on FRED, where the client keeps using the fetch clock.
    quoteTs: series.quoteTs ?? null,
  };
}

export function parseFred(csv: string): { date: string; value: number }[] {
  const rows = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const [date, raw] = line.split(',').map((s) => (s || '').trim());
    const value = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === '.' || !Number.isFinite(value)) continue;
    rows.push({ date, value });
  }
  return rows;
}

export function tenYearTile(rows: { date: string; value: number }[]) {
  const [prev, last] = rows.slice(-2);
  return {
    name: 'US 10Y',
    last: last.value.toFixed(2) + '%',
    chg: Number((last.value - prev.value).toFixed(2)),
    spark: rows.slice(-30).map((r) => r.value),
    asOf: last.date, // series date — FRED lags T-1 (plan lamp carve-out)
  };
}

// ── handler ──────────────────────────────────────────────────────────────────
// `duringSession` records whether the body was captured while the market was
// OPEN, so it can be dropped the moment the market shuts. Without it a body
// cached at 15:59 stays servable for the rest of the closed TTL, and the client
// renders mid-session prices under an "at close" stamp — EOD is a claim that
// the number IS the closing print (Codex review, PR #193). The settle grace
// usually replaces such a body within a minute of the bell, but only if a
// request happens to arrive in that window; this makes it unconditional.
let cache: { at: number; body: unknown; duringSession: boolean } | null = null;
let inflight: Promise<unknown> | null = null; // single-flight: a concurrent burst shares one sweep

async function refresh(): Promise<unknown> {
  // Parallel: Supabase egress has no runner-IP rate-limit history; the
  // pipeline's sequential 600ms spacing was an Actions-IP mitigation.
  const cosd = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const [idxRows, fredCsv, extraRows] = await Promise.all([
    Promise.all(MARKET_SYMBOLS.map((m) => dailyCloses(m.sym))),
    fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=${cosd}`, { headers: UA }).then((r) => r.text()),
    // best-effort with a latency cap (see bestEffort): a slow/rejected extra → null
    Promise.all(EXTRA_SYMBOLS.map((m) => bestEffort(dailyCloses(m.sym), 4000))),
  ]);
  const tiles = MARKET_SYMBOLS.map((m, i) => tileFrom(m.name, idxRows[i]));
  const fredRows = parseFred(fredCsv);
  if (fredRows.length < 2) throw new Error(`FRED DGS10: ${fredRows.length} usable rows`);
  tiles.push(tenYearTile(fredRows));
  // Aggregate as-of is computed from the CORE tiles ONLY (Codex #109): the
  // extras include 24/7 crypto, so their date would otherwise push the
  // masthead "as of" past the equities' real trading day, overstating core
  // freshness. Extras still carry their own per-tile asOf.
  const asOf = tiles.map((t) => t.asOf).sort().at(-1);
  // append whichever extras resolved (need ≥2 closes for a day change)
  EXTRA_SYMBOLS.forEach((m, i) => {
    const rows = extraRows[i];
    if (rows && rows.rows.length >= 2) tiles.push(tileFrom(m.name, rows));
  });
  // Freshest CORE quote instant — the clock the desk should PRINT, so a tile
  // can be compared like-for-like against a broker screen. Core only, for the
  // same reason asOf is: 24/7 crypto would otherwise overstate equity freshness.
  const coreTs = tiles.slice(0, MARKET_SYMBOLS.length)
    .map((t) => t.quoteTs).filter((t): t is number => typeof t === 'number' && t > 0);
  const quoteAt = coreTs.length ? new Date(Math.max(...coreTs) * 1000).toISOString() : null;
  const body = { ok: true, asOf, quoteAt, generatedAt: new Date().toISOString(), tiles };
  cache = { at: Date.now(), body, duringSession: marketSessionOpen() };
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  // force (owner request 2026-07-27): the dashboard's manual "Refresh now"
  // button bypasses this cache so a click guarantees a fresh upstream pull.
  let force = false;
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
  }

  // A body captured during the open session is discarded once the session is
  // shut, however much of its TTL is left: it is mid-session data, and after
  // the bell the client would label it as the close.
  const crossedClose = !!cache && cache.duringSession && !marketSessionOpen();
  if (!force && cache && !crossedClose && Date.now() - cache.at < ttlMs()) return reply(200, cache.body);

  try {
    inflight ??= refresh().finally(() => { inflight = null; });
    return reply(200, await inflight);
  } catch (e) {
    if (cache) return reply(200, cache.body); // stale-but-honest beats a dead strip
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
