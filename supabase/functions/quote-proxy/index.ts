// ── quote-proxy — origin-guarded OHLC fetch for ANY ticker ──────────────────
// Deployed as a Supabase Edge Function (Deno). The browser sends {symbol,
// kind}; bars come from the pipeline's free-source chain fetched server-side
// (browsers are CORS-blocked by both sources): Stooq EOD CSV first, Yahoo v8
// chart as fallback — and Yahoo alone for intraday. Free-tier data by design
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

// Small in-memory response cache (per warm instance) — a soft guardrail that
// collapses repeat lookups of the same ticker before they reach upstream.
const CACHE_TTL_MS = { daily: 300_000, intraday: 60_000, info: 900_000 }; // 5 min / 1 min / 15 min
type Cached = { at: number; status: number; body: unknown };
const CACHE = new Map<string, Cached>();

type Series = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
const emptySeries = (): Series => ({ t: [], o: [], h: [], l: [], c: [], v: [] });

function pack(rows: { t: string; o: number; h: number; l: number; c: number; v: number }[]): Series {
  const s = emptySeries();
  for (const r of rows.slice(-KEEP_BARS)) {
    s.t.push(r.t); s.o.push(r.o); s.h.push(r.h); s.l.push(r.l); s.c.push(r.c); s.v.push(r.v);
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

// Yahoo v8 chart: daily fallback and the only intraday source.
async function yahooChart(symbol: string, range: string, interval: string, intraday: boolean): Promise<Series | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) return null;
  const rows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if ([o, h, l, c].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)) continue;
    const d = new Date(r.timestamp[i] * 1000);
    const t = intraday
      ? d.toISOString().slice(0, 16).replace('T', ' ') // YYYY-MM-DD HH:mm (UTC)
      : d.toISOString().slice(0, 10);
    rows.push({ t, o, h, l, c, v: q.volume?.[i] || 0 });
  }
  const minBars = intraday ? 20 : 30;
  return rows.length >= minBars ? pack(rows) : null;
}

// ── fundamentals (kind:'info') ───────────────────────────────────────────────
// Yahoo's v7/quote carries earnings date + key stats but, unlike v8/chart,
// now requires a cookie + crumb handshake (401 "Unauthorized" otherwise). We
// fetch a cookie from fc.yahoo.com (it 404s but sets A3), trade it for a crumb,
// and cache the pair per warm instance (~1h). Validated end-to-end from the
// project egress IP before shipping.
type Info = {
  symbol: string; name: string | null; price: number | null;
  marketCap: number | null; pe: number | null;
  wkLow: number | null; wkHigh: number | null; divYield: number | null;
  earningsTs: number | null; earningsEstimate: boolean;
};
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
  // Yahoo hyphenates share-class dots (BRK.B → BRK-B); keep ^ for indices.
  const ysym = symbol.replace(/\./g, '-');
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
  return {
    symbol: String(q.symbol ?? symbol).toUpperCase(),
    name: q.shortName ?? q.longName ?? null,
    price: num(q.regularMarketPrice),
    marketCap: num(q.marketCap),
    pe: num(q.trailingPE),
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

  let payload: { symbol?: unknown; kind?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }, cors); }
  const symbol = String(payload.symbol ?? '').trim().toUpperCase();
  const kind = payload.kind === 'intraday' ? 'intraday' : payload.kind === 'info' ? 'info' : 'daily';
  if (!symbol) return reply(400, { ok: false, error: 'symbol is required' }, cors);
  if (!/^[A-Z0-9.^-]{1,10}$/.test(symbol)) return reply(400, { ok: false, error: 'symbol format not recognized' }, cors);

  // Serve from the warm-instance cache when fresh.
  const cacheKey = `${symbol}:${kind}`;
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
    series = await yahooChart(symbol, '5d', '5m', true);
  } else {
    series = await stooqDaily(symbol);
    if (!series) series = await yahooChart(symbol, '5y', '1d', false);
  }
  if (!series) {
    const body = { ok: false, error: `no ${kind} data found for ${symbol} — check the ticker` };
    CACHE.set(cacheKey, { at: Date.now(), status: 404, body }); // cache the miss too — blunts junk-ticker repeats
    return reply(404, body, cors);
  }

  const body = { ok: true, symbol, kind, asOf: series.t[series.t.length - 1], series };
  CACHE.set(cacheKey, { at: Date.now(), status: 200, body });
  return reply(200, body, cors);
});
