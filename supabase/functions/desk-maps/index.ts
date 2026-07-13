// ── desk-maps — delayed quotes for the extra MAP FILTER universes ────────────
// Deployed as a Supabase Edge Function (Deno). Serves the Crypto / Futures /
// World heatmap cuts from Yahoo's crumbless v8 spark batch, fetched
// server-side on demand (owner ruling 2026-07-13: no nightly batch for these
// — delayed quotes on page load). Supabase egress is not IP-throttled the way
// GitHub's runners are (the quote-proxy proves this path daily for Pro 3).
//
// Deliberately NOT PIN-gated: the quotes are public market data and the
// symbol roster is fixed server-side (config/map-filters.json on the Pages
// origin), so this cannot be used as an open proxy. A module-scope cache
// (TTL below) bounds Yahoo traffic to ~one batch per warm instance per
// window regardless of visitor count.
//
// Response mirrors the retired data/maps-extra.json shape so the client
// render path is unchanged: { ok, asOf, generatedAt, cuts }.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk maps; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/map-filters.json';
const QUOTE_TTL_MS = 120_000; // one Yahoo batch per warm instance per 2 min
const CONFIG_TTL_MS = 3_600_000; // roster edits are rare; picked up within the hour

type RosterRow = [string, string, string, string, number?]; // [yahooSym, sym, name, group, weight]
type Quote = { pct: number; last: number };
type Tile = { sym: string; name: string; cap: number; pct: number; ind: string; last: number };
type Cut = { covered: number; sectors: { name: string; cap: number; tiles: Tile[] }[] };

const yahooTicker = (sym: string) => sym.trim().toUpperCase().replace(/\./g, '-');

// Same shaping as the retired pipeline fetch-maps.js buildMapCuts: tiles size
// by the config weight (× $1B — spark carries no market caps), a cut below
// half coverage is dropped, groups and tiles sort by size.
function buildMapCuts(extra: Record<string, RosterRow[]>, quotes: Map<string, Quote>): Record<string, Cut> {
  const cuts: Record<string, Cut> = {};
  for (const [cutKey, roster] of Object.entries(extra)) {
    const groups = new Map<string, Tile[]>();
    let covered = 0;
    for (const [ysym, sym, name, group, weight] of roster) {
      const q = quotes.get(yahooTicker(ysym));
      if (!q || !Number.isFinite(q.pct)) continue;
      covered++;
      const cap = (weight || 1) * 1e9;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push({ sym, name, cap, pct: q.pct, ind: '', last: q.last });
    }
    if (covered < Math.ceil(roster.length / 2)) continue;
    cuts[cutKey] = {
      covered,
      sectors: [...groups.entries()]
        .map(([name, tiles]) => ({
          name,
          cap: tiles.reduce((s, t) => s + t.cap, 0),
          tiles: tiles.sort((a, b) => b.cap - a.cap),
        }))
        .sort((a, b) => b.cap - a.cap),
    };
  }
  return cuts;
}

// Spark → Map(sym → {pct, last}) from the last two daily closes (compact
// spark format: { SYM: { close: [...] }, ... } — same parse as the pipeline).
function parseSpark(json: Record<string, { close?: number[] }> | null): Map<string, Quote> {
  const out = new Map<string, Quote>();
  for (const [sym, node] of Object.entries(json || {})) {
    const closes = (node?.close || []).filter((c) => Number.isFinite(c) && c > 0);
    if (closes.length >= 2) {
      const pct = (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100;
      out.set(sym, { pct: Number(pct.toFixed(2)), last: Number(closes[closes.length - 1].toFixed(2)) });
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
    if (!res.ok) continue; // partial coverage is handled by the half-coverage rule
    const json = await res.json().catch(() => null);
    for (const [sym, v] of parseSpark(json)) out.set(sym, v);
  }
  return out;
}

// EOD date stamp for the payload (UTC, weekends roll back to Friday) —
// informational; the client lamps this feed as LIVE off generatedAt.
function lastTradingDayIso(): string {
  const d = new Date();
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

let configCache: { at: number; extra: Record<string, RosterRow[]> } | null = null;
let quoteCache: { at: number; body: unknown } | null = null;
let inflight: Promise<Response> | null = null; // single-flight: one batch per burst

async function refresh(): Promise<Response> {
  if (!configCache || Date.now() - configCache.at > CONFIG_TTL_MS) {
    const res = await fetch(CONFIG_URL, { headers: UA }).catch(() => null);
    const cfg = res && res.ok ? await res.json().catch(() => null) : null;
    if (cfg?.extra && Object.keys(cfg.extra).length) {
      configCache = { at: Date.now(), extra: cfg.extra };
    } else if (!configCache) {
      return reply(502, { ok: false, error: 'map roster unavailable' });
    } // else: keep serving the stale roster rather than fail
  }

  const symbols = Object.values(configCache.extra).flat().map((r) => r[0]);
  const quotes = await sparkBatch(symbols);
  const cuts = buildMapCuts(configCache.extra, quotes);
  if (!Object.keys(cuts).length) {
    return reply(502, { ok: false, error: `all cuts below half coverage (${quotes.size}/${symbols.length} quotes)` });
  }

  const body = { ok: true, asOf: lastTradingDayIso(), generatedAt: new Date().toISOString(), cuts };
  quoteCache = { at: Date.now(), body };
  return reply(200, body);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  if (quoteCache && Date.now() - quoteCache.at < QUOTE_TTL_MS) return reply(200, quoteCache.body);

  inflight ??= refresh().finally(() => { inflight = null; });
  const res = await inflight;
  return res.clone();
});
