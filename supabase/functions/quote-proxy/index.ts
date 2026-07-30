// ── quote-proxy — origin-guarded OHLC fetch for ANY ticker ──────────────────
// Deployed as a Supabase Edge Function (Deno). The browser sends {symbol,
// kind}; bars come from the pipeline's free-source chain fetched server-side
// (browsers are CORS-blocked by both sources): Yahoo v8 chart first, Stooq EOD
// CSV as fallback — and Yahoo alone for intraday. Free-tier data by design
// (owner ruling: no paid market-data subscriptions): near-real-time for US
// listings, delayed for some exchanges, no SLA. The client keeps its last good
// series if this function errors — never crash the panel from here.
//
// Auth (owner ruling 2026-07-14): NO PIN — the desk runs on a paid Supabase
// plan and the owner wants any ticker chartable without unlocking. The gate is
// now an ORIGIN ALLOWLIST: only requests from the dashboard's own origin are
// served, so the endpoint can't be used as a general open proxy to Yahoo/Stooq
// through the project's egress IP. A short in-memory cache blunts repeat hits.
// (Origin is browser-enforced and unspoofable from page JS; a non-browser
// client can forge it, so this is an abuse speed-bump, not a hard auth wall.)

const ALLOWED_ORIGINS = new Set([
  'https://akyachtsman.github.io', // the live GitHub Pages site
]);
const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const ALLOW_METHODS = 'POST, OPTIONS';

function corsHeaders(origin: string, allowed: boolean): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    Vary: 'Origin',
  };
  if (allowed) h['Access-Control-Allow-Origin'] = origin; // echo only allowed origins
  return h;
}
const reply = (status: number, body: unknown, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk quote-proxy; +https://akyachtsman.github.io/claude.trading/)' };
const KEEP_BARS = 800; // ~3 years of daily view + weekly-stoch warmup (owner ruling 2026-07-14)
// Intraday needs its own, larger cap. A 5-day extended-hours response is ~961
// 5-minute bars (4:00am–8:00pm ET × 5 sessions), so the 800 daily cap would
// silently drop the oldest ~161 — most of the first session — and Pro 3's
// navigator could no longer reach the five days the feed advertises. Sized with
// headroom over the measured 961 (Codex review, PR #187).
const KEEP_BARS_INTRADAY = 1200;

// Small in-memory response cache (per warm instance) — a soft guardrail that
// collapses repeat lookups of the same ticker before they reach upstream.
const CACHE_TTL_MS = { daily: 300_000, intraday: 60_000, info: 900_000 }; // 5 min / 1 min / 15 min
type Cached = { at: number; status: number; body: unknown };
const CACHE = new Map<string, Cached>();

// `x` marks each bar's session: 0 = regular, 1 = extended (pre/post). Always
// present, so callers can split the two without re-deriving ET/DST rules — but
// only ever 1 on a prepost:true intraday fetch, since that is the only response
// that contains extended bars at all. On every other response it is all zeros.
type Series = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; x: number[] };
const emptySeries = (): Series => ({ t: [], o: [], h: [], l: [], c: [], v: [], x: [] });

function pack(rows: { t: string; o: number; h: number; l: number; c: number; v: number; x?: number }[], keep = KEEP_BARS): Series {
  const s = emptySeries();
  for (const r of rows.slice(-keep)) {
    s.t.push(r.t); s.o.push(r.o); s.h.push(r.h); s.l.push(r.l); s.c.push(r.c); s.v.push(r.v); s.x.push(r.x ?? 0);
  }
  return s;
}

// Stooq daily CSV: Date,Open,High,Low,Close,Volume (US listings need a .us suffix).
async function stooqDaily(symbol: string): Promise<Series | null> {
  const s = symbol.toLowerCase().replace(/[.^]/g, '-');
  const res = await fetch(`https://stooq.com/q/d/l/?s=${s}.us&i=d`, { headers: UA });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 30 || !lines[0].startsWith('Date')) return null;
  const rows = [];
  for (const line of lines.slice(1)) {
    const [t, o, h, l, c, v] = line.split(',');
    const nums = [o, h, l, c].map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || nums.some((n) => !Number.isFinite(n) || n <= 0)) continue;
    rows.push({ t, o: nums[0], h: nums[1], l: nums[2], c: nums[3], v: Number(v) || 0 });
  }
  return rows.length >= 30 ? pack(rows) : null;
}

// Regular-session bounds per day, straight from Yahoo's own `tradingPeriods`
// (a {pre,post,regular} dict, each a list of one-entry per-day lists). Using
// the feed's own bounds keeps session classification correct across DST and
// half-days instead of hardcoding 13:30–20:00 UTC.
// deno-lint-ignore no-explicit-any
function regularRanges(meta: any): [number, number][] {
  const out: [number, number][] = [];
  const days = meta?.tradingPeriods?.regular;
  if (Array.isArray(days)) {
    for (const day of days) {
      for (const p of (Array.isArray(day) ? day : [day])) {
        if (typeof p?.start === 'number' && typeof p?.end === 'number') out.push([p.start, p.end]);
      }
    }
  }
  // Deliberately NO currentTradingPeriod fallback (Codex review, PR #187).
  // That field describes ONE day, and applying it to a 5-day response marks
  // every prior day's regular bars as extended — which the 20-regular-bar floor
  // can still pass on the current day alone, after which regularOnly() would
  // quietly discard almost all history and the daily graft would be built from
  // a single session. An empty result is the honest answer; the caller retries
  // without extended hours rather than classifying on a guess.
  return out;
}

// Extended-hours bars arrive with unreliable wicks: Yahoo reports no volume at
// all outside the session (measured: 1141 of 1142 pre/post bars across QQQ and
// AAPL had volume 0), and a few percent of them carry a high/low tens of
// dollars off their own open/close — e.g. QQQ 2026-07-28 16:50, low 647.43
// against a 676.25 close, a 7.2% phantom wick on zero volume. The bodies are
// sound; only the extremes are junk. So on EXTENDED bars only, clamp the wick
// to 1% outside the body — comfortably above any genuine pre/post bar range
// (the body itself moves with a real earnings gap, so the clamp moves with it)
// and well under the 2.8–7.2% garbage. Regular-session bars are never touched;
// they are clean (0 of 780 sampled bars exceeded this bound).
const EXT_WICK_TOL = 0.01;

// Yahoo hyphenates a SHARE-CLASS dot (BRK.B → BRK-B) but keeps an EXCHANGE
// suffix intact (DX-Y.NYB, the dollar index). Measured against v8/chart:
// BRK.B 404s, BRK-B 200s, DX-Y.NYB 200s as it stands — so the rule is a dot
// followed by a single trailing letter, which is what a share class looks like
// and an exchange code never is. Shared by both upstream call sites; the same
// helper (and the same reasoning) lives in desk-watchlist.
const toYahoo = (s: string) => s.replace(/\.([A-Z])$/, '-$1');

// Yahoo v8 chart: primary daily source and the only intraday source.
// `prepost` widens an intraday fetch to the 4:00am–8:00pm ET extended session
// (owner request 2026-07-29). Indices carry `hasPrePostMarketData:false` — an
// index is computed from constituent trades, so once those stop printing the
// value simply repeats its close; those flat trailing bars still classify as
// extended via `x`, so callers can drop them rather than draw a dead flat tail.
async function yahooChart(symbol: string, range: string, interval: string, intraday: boolean, prepost = false): Promise<Series | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(toYahoo(symbol))}?range=${range}&interval=${interval}&includePrePost=${prepost ? 'true' : 'false'}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) return null;
  // Classify ONLY when extended hours were actually requested. Two reasons:
  // daily bars are whole sessions, and with includePrePost=false Yahoo returns
  // regular bars exclusively — so every bar is regular by construction, and
  // consulting `tradingPeriods` there is not just redundant but WRONG: that
  // table comes back in a narrower shape on a regular-only response, matching
  // just one day of a 5-day window, which flagged 313 of 391 genuinely regular
  // QQQ bars as extended. Caught live before any caller depended on it.
  const regs = intraday && prepost ? regularRanges(r.meta) : [];
  // Extended bars we cannot classify are worse than no extended bars: they would
  // flow unmarked into regularOnly() and the daily graft. Retry regular-only.
  if (intraday && prepost && !regs.length) return yahooChart(symbol, range, interval, intraday, false);
  const isRegular = (ts: number) => !regs.length || regs.some(([a, b]) => ts >= a && ts < b);
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if ([o, h, l, c].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) continue;
    const ts = r.timestamp[i];
    const d = new Date(ts * 1000);
    const t = intraday
      ? d.toISOString().slice(0, 16).replace('T', ' ') // YYYY-MM-DD HH:mm (UTC)
      : d.toISOString().slice(0, 10);
    const x = intraday && prepost && !isRegular(ts) ? 1 : 0;
    // De-spike the extended session (see EXT_WICK_TOL). The body always wins:
    // the clamp can only pull a wick in, never inside open/close.
    const body = [Math.min(o, c), Math.max(o, c)];
    const hi = x ? Math.max(body[1], Math.min(h, body[1] * (1 + EXT_WICK_TOL))) : h;
    const lo = x ? Math.min(body[0], Math.max(l, body[0] * (1 - EXT_WICK_TOL))) : l;
    rows.push({ t, o, h: hi, l: lo, c, v: q.volume?.[i] || 0, x });
  }
  // The floor counts REGULAR bars only: a thin pre-market on a quiet ticker
  // must not let a mostly-empty session pass as a full one.
  const minBars = intraday ? 20 : 30;
  return rows.filter((b) => !b.x).length >= minBars ? pack(rows, intraday ? KEEP_BARS_INTRADAY : KEEP_BARS) : null;
}

// ── fundamentals (kind:'info') ───────────────────────────────────────────────
// Yahoo's v7/quote carries earnings date + key stats but, unlike v8/chart,
// now requires a cookie + crumb handshake (401 "Unauthorized" otherwise). We
// fetch a cookie from fc.yahoo.com (it 404s but sets A3), trade it for a crumb,
// and cache the pair per warm instance (~1h). Validated end-to-end from the
// project egress IP before shipping.
type Info = {
  symbol: string; name: string | null; price: number | null;
  // live quote line (owner request 2026-07-16): day change + top-of-book.
  // bid/ask are market-hours-only on free Yahoo data (0 when closed).
  change: number | null; changePct: number | null;
  bid: number | null; ask: number | null;
  // Post-market print (owner request 2026-07-30). extPct is measured from the
  // PRIOR CLOSE — the same basis as changePct — so the two are directly
  // comparable instead of one being a move off the closing print. Null when the
  // instrument has no extended session (every index) or nothing has traded yet;
  // never 0, which would read as "flat after hours".
  // This field reaches BOTH the charts quote readout and the assistant, since
  // desk-ask's get_quote forwards `info` verbatim.
  extPrice: number | null; extPct: number | null; extAt: number | null;
  marketCap: number | null; pe: number | null; peFwd: boolean;
  wkLow: number | null; wkHigh: number | null; divYield: number | null;
  earningsTs: number | null; earningsEstimate: boolean;
};
// The post-market print, on a prior-close basis (owner request 2026-07-30).
// Compounds Yahoo's two percentages rather than dividing by
// regularMarketPreviousClose: post% is measured off today's regular close and
// reg% off the prior close, so (1+reg)(1+post)-1 is the exact prior-close move.
// `regularMarketPreviousClose` silently shifts basis during pre-market (it can
// point at the session before last) — verified 2026-07-29 on SOXL.
//
// Post only. Pre-market is deliberately not surfaced (owner: "not premarket,
// I'm mostly interested in post market"); the same compounding would cover it.
// deno-lint-ignore no-explicit-any
function extInfo(q: any): { extPrice: number | null; extPct: number | null; extAt: number | null } {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const px = n(q?.postMarketPrice);
  if (px == null || px <= 0) return { extPrice: null, extPct: null, extAt: null };
  const regPct = n(q?.regularMarketChangePercent);
  const postPct = n(q?.postMarketChangePercent);
  const pct = postPct != null && regPct != null
    ? ((1 + regPct / 100) * (1 + postPct / 100) - 1) * 100
    : regPct;
  return {
    extPrice: px,
    extPct: pct == null ? null : Number(pct.toFixed(2)),
    extAt: n(q?.postMarketTime),
  };
}

let yauth: { cookie: string; crumb: string; at: number } | null = null;
const YAUTH_TTL_MS = 3_600_000;

async function yahooAuth(force = false): Promise<{ cookie: string; crumb: string } | null> {
  if (!force && yauth && Date.now() - yauth.at < YAUTH_TTL_MS) return yauth;
  const c = await fetch('https://fc.yahoo.com/', { headers: UA });
  // deno-lint-ignore no-explicit-any
  const setCookies: string[] = (c.headers as any).getSetCookie?.() ?? [];
  let cookie = setCookies.map((s) => s.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) { const one = c.headers.get('set-cookie'); if (one) cookie = one.split(';')[0]; }
  if (!cookie) return null;
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
  if (!cr.ok) return null;
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) return null; // reject HTML/error bodies
  yauth = { cookie, crumb, at: Date.now() };
  return yauth;
}

async function yahooInfo(symbol: string): Promise<Info | null> {
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const ysym = toYahoo(symbol);
  const quoteUrl = (crumb: string) =>
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ysym)}&crumb=${encodeURIComponent(crumb)}`;
  let auth = await yahooAuth();
  if (!auth) return null;
  let res = await fetch(quoteUrl(auth.crumb), { headers: { ...UA, Cookie: auth.cookie } });
  if (res.status === 401) { // stale crumb → refresh once
    auth = await yahooAuth(true);
    if (!auth) return null;
    res = await fetch(quoteUrl(auth.crumb), { headers: { ...UA, Cookie: auth.cookie } });
  }
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  // deno-lint-ignore no-explicit-any
  const q = (json as any)?.quoteResponse?.result?.[0];
  if (!q) return null;
  const divPct = num(q.dividendYield) ??
    (num(q.trailingAnnualDividendYield) != null ? (q.trailingAnnualDividendYield as number) * 100 : null);
  // Prefer the nearest UPCOMING earnings date over a stale reported one: Yahoo
  // can return a past exact `earningsTimestamp` alongside a future estimated
  // window. Pick the soonest future candidate; else the most recent past.
  const nowSec = Date.now() / 1000;
  const cands = [q.earningsTimestamp, q.earningsTimestampStart, q.earningsTimestampEnd]
    .map(num).filter((x): x is number => x != null);
  const future = cands.filter((t) => t >= nowSec).sort((a, b) => a - b);
  const earningsTs = future.length ? future[0] : (cands.length ? Math.max(...cands) : null);
  // P/E: forward is the desk convention (owner ruling). Fall back to trailing
  // when a ticker has no analyst estimate (ETFs, uncovered names); peFwd tells
  // the client which basis it is so a trailing fallback is never mislabeled.
  // Uses Yahoo's CURRENT-fiscal-year estimate (priceEpsCurrentYear), not its
  // own `forwardPE` (next-fiscal-year estimate) — cross-checked against IBKR's
  // own "Forward P/E" watchlist column across 7 live tickers, current-year
  // basis matched IBKR far more often (e.g. ORCL 14.28 vs IBKR's 14.25; Yahoo's
  // `forwardPE` gave 10.56 for the same ticker).
  const fwdPe = num(q.priceEpsCurrentYear);
  const ttmPe = num(q.trailingPE);
  return {
    symbol: String(q.symbol ?? symbol).toUpperCase(),
    name: q.shortName ?? q.longName ?? null,
    price: num(q.regularMarketPrice),
    change: num(q.regularMarketChange),
    changePct: num(q.regularMarketChangePercent),
    bid: num(q.bid),
    ask: num(q.ask),
    ...extInfo(q),
    marketCap: num(q.marketCap),
    pe: fwdPe ?? ttmPe,
    peFwd: fwdPe != null,
    wkLow: num(q.fiftyTwoWeekLow),
    wkHigh: num(q.fiftyTwoWeekHigh),
    divYield: divPct,
    earningsTs,
    earningsEstimate: q.isEarningsDateEstimate === true,
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const allowed = ALLOWED_ORIGINS.has(origin);
  const cors = corsHeaders(origin, allowed);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  // Origin allowlist is the gate now that the PIN is gone.
  if (!allowed) return reply(403, { ok: false, error: 'forbidden origin' }, cors);
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' }, cors);

  let payload: { symbol?: unknown; kind?: unknown; prepost?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }, cors); }
  const symbol = String(payload.symbol ?? '').trim().toUpperCase();
  const kind = payload.kind === 'intraday' ? 'intraday' : payload.kind === 'info' ? 'info' : 'daily';
  // Extended hours are intraday-only: daily bars are whole regular sessions.
  const prepost = kind === 'intraday' && payload.prepost === true;
  if (!symbol) return reply(400, { ok: false, error: 'symbol is required' }, cors);
  // Must stay in lockstep with the client's own pattern (scripts/app.js) and
  // desk-watchlist's: a symbol the chart box accepts and this proxy rejects
  // surfaces as a bare format error instead of a chart (Codex review, PR #192 —
  // '=' was widened upstream for futures like GC=F but not here).
  if (!/^[A-Z0-9.^=-]{1,10}$/.test(symbol)) return reply(400, { ok: false, error: 'symbol format not recognized' }, cors);

  // Serve from the warm-instance cache when fresh. The prepost flag is part of
  // the key — the two variants are different bar sets, never interchangeable.
  const cacheKey = `${symbol}:${kind}${prepost ? ':pp' : ''}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS[kind]) return reply(hit.status, hit.body, cors);

  // Fundamentals: earnings date + key stats (Yahoo v7/quote, crumb-gated).
  if (kind === 'info') {
    const info = await yahooInfo(symbol);
    if (!info) {
      const body = { ok: false, error: `no info found for ${symbol}` };
      CACHE.set(cacheKey, { at: Date.now(), status: 404, body });
      return reply(404, body, cors);
    }
    const body = { ok: true, symbol, kind, info, asOf: new Date().toISOString() };
    CACHE.set(cacheKey, { at: Date.now(), status: 200, body });
    return reply(200, body, cors);
  }

  let series: Series | null = null;
  if (kind === 'intraday') {
    series = await yahooChart(symbol, '5d', '5m', true, prepost);
  } else {
    // Yahoo FIRST, Stooq as the fallback — same reason as desk-market (owner
    // report 2026-07-28): Stooq answers with an HTML JS-challenge page served
    // as HTTP 200, so stooqDaily's shape checks reject it and every daily
    // request paid for that round-trip before reaching Yahoo anyway.
    series = await yahooChart(symbol, '5y', '1d', false);
    if (!series) series = await stooqDaily(symbol);
  }
  if (!series) {
    const body = { ok: false, error: `no ${kind} data found for ${symbol} — check the ticker` };
    CACHE.set(cacheKey, { at: Date.now(), status: 404, body }); // cache the miss too — blunts junk-ticker repeats
    return reply(404, body, cors);
  }

  const body = { ok: true, symbol, kind, prepost, asOf: series.t[series.t.length - 1], series };
  CACHE.set(cacheKey, { at: Date.now(), status: 200, body });
  return reply(200, body, cors);
});
