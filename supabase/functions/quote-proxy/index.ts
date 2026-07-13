// ── quote-proxy — PIN-gated OHLC fetch for ANY ticker ───────────────────────
// Deployed as a Supabase Edge Function (Deno). The browser sends {pin,
// symbol, kind}; the PIN is validated against desk_users with the SAME
// hex(sha256(salt || pin)) scheme as desk_login, then the bars come from the
// pipeline's free-source chain fetched server-side (browsers are CORS-blocked
// by both sources): Stooq EOD CSV first, Yahoo v8 chart as fallback — and
// Yahoo alone for intraday. Free-tier data by design (owner ruling: no paid
// market-data subscriptions): near-real-time for US listings, delayed for
// some exchanges, no SLA. The client keeps its last good series if this
// function errors — never crash the panel from here.

const CORS = {
  'Access-Control-Allow-Origin': '*', // PIN is the gate; quotes are public data
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk quote-proxy; +https://akyachtsman.github.io/claude.trading/)' };
const KEEP_BARS = 330; // matches the nightly pipeline's charts.json window

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let payload: { pin?: unknown; symbol?: unknown; kind?: unknown };
  try { payload = await req.json(); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }); }
  const pin = String(payload.pin ?? '');
  const symbol = String(payload.symbol ?? '').trim().toUpperCase();
  const kind = payload.kind === 'intraday' ? 'intraday' : 'daily';
  if (!pin || !symbol) return reply(400, { ok: false, error: 'pin and symbol are required' });
  if (!/^[A-Z0-9.^-]{1,10}$/.test(symbol)) return reply(400, { ok: false, error: 'symbol format not recognized' });

  // PIN check — same salted-hash scheme as the desk_login RPC.
  const supaUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const usersRes = await fetch(`${supaUrl}/rest/v1/desk_users?select=salt,pin_hash`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (!usersRes.ok) return reply(502, { ok: false, error: 'auth backend unavailable' });
  const users: { salt: string; pin_hash: string }[] = await usersRes.json();
  const enc = new TextEncoder();
  let authed = false;
  for (const u of users) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(u.salt + pin));
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex === u.pin_hash) authed = true; // check every row — no early exit
  }
  if (!authed) return reply(401, { ok: false, error: 'PIN not recognized.' });

  let series: Series | null = null;
  if (kind === 'intraday') {
    series = await yahooChart(symbol, '5d', '5m', true);
  } else {
    series = await stooqDaily(symbol);
    if (!series) series = await yahooChart(symbol, '2y', '1d', false);
  }
  if (!series) return reply(404, { ok: false, error: `no ${kind} data found for ${symbol} — check the ticker` });

  return reply(200, {
    ok: true,
    symbol,
    kind,
    asOf: series.t[series.t.length - 1],
    series,
  });
});
