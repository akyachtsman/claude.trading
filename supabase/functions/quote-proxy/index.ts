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
const CACHE_TTL_MS = { daily: 300_000, intraday: 60_000 }; // 5 min / 1 min
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
  const kind = payload.kind === 'intraday' ? 'intraday' : 'daily';
  if (!symbol) return reply(400, { ok: false, error: 'symbol is required' }, cors);
  if (!/^[A-Z0-9.^-]{1,10}$/.test(symbol)) return reply(400, { ok: false, error: 'symbol format not recognized' }, cors);

  // Serve from the warm-instance cache when fresh.
  const cacheKey = `${symbol}:${kind}`;
  const hit = CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS[kind]) return reply(hit.status, hit.body, cors);

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
