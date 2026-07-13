// ── desk-heatmap — S&P 500 day-heat treemap, delayed quotes on demand ────────
// Replaces the nightly fetch-heatmap.js → data/heatmap.json step
// (retire-nightly-pipeline plan, Group A). Same source chain, same payload
// shape: Nasdaq screener (one bulk call, pct + caps) → Yahoo v7 crumb quote
// (caps) → Yahoo spark (pct only) + a 24-hour module cap cache seeded from
// the last cap-bearing pass — the retired pipeline's prevCaps rescue read the
// previous committed heatmap.json, which no longer exists. Coverage below
// 300 constituent tiles → ok:false (client keeps last good, FR-R9).
//
// Anon-callable: public market data, no caller input reaches upstream URLs.
// Cache TTL is session-aware (5 min open / 60 min closed, Clarification 6).

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
const ttlMs = () => (marketSessionOpen() ? 300_000 : 3_600_000);

type Quote = { pct: number; cap: number | null; last: number | null };
type Constituent = { sym: string; name: string; sector: string; ind: string };

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
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.map(yahooTicker).join(',')}&fields=symbol,regularMarketChangePercent,regularMarketPrice,marketCap&crumb=${encodeURIComponent(auth.crumb)}`;
    try {
      const res = await fetch(url, { headers: { ...UA, cookie: auth.cookie } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const before = out.size;
      // deno-lint-ignore no-explicit-any
      for (const q of ((await res.json()) as any)?.quoteResponse?.result || []) {
        const pct = Number(q.regularMarketChangePercent);
        const last = Number(q.regularMarketPrice);
        if (Number.isFinite(pct)) {
          out.set(String(q.symbol), { pct: Number(pct.toFixed(2)), cap: Number(q.marketCap) || null, last: Number.isFinite(last) && last > 0 ? last : null });
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

// ── shaping (verbatim port of fetch-heatmap.js buildHeatmap) ────────────────
export function buildHeatmap(constituents: Constituent[], quotes: Map<string, Quote>, prevCaps: Map<string, number>) {
  const bySector = new Map<string, { sym: string; name: string; cap: number; pct: number; ind: string; last: number | null }[]>();
  let covered = 0;
  for (const c of constituents) {
    const q = quotes.get(yahooTicker(c.sym)) || quotes.get(c.sym);
    if (!q) continue;
    const cap = q.cap ?? prevCaps.get(c.sym) ?? null;
    if (!cap || !Number.isFinite(q.pct)) continue;
    covered++;
    if (!bySector.has(c.sector)) bySector.set(c.sector, []);
    bySector.get(c.sector)!.push({ sym: c.sym, name: c.name, cap, pct: q.pct, ind: c.ind || '', last: q.last ?? null });
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

function lastTradingDayIso(): string {
  const d = new Date();
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── caches ───────────────────────────────────────────────────────────────────
let constituentsCache: { at: number; list: Constituent[] } | null = null; // 24h
let capCache: { at: number; caps: Map<string, number> } | null = null;    // 24h, cap-bearing passes only
let payloadCache: { at: number; body: unknown } | null = null;            // session-aware
let inflight: Promise<unknown> | null = null; // single-flight: one sweep per burst

async function refresh(): Promise<unknown> {
  {
    if (!constituentsCache || Date.now() - constituentsCache.at > 86_400_000) {
      const res = await fetch(CONSTITUENTS_URL, { headers: UA });
      if (!res.ok) throw new Error(`constituents HTTP ${res.status}`);
      const list = parseConstituents(await res.text());
      if (list.length < 400) throw new Error(`only ${list.length} constituents parsed`);
      constituentsCache = { at: Date.now(), list };
    }
    const constituents = constituentsCache.list;
    const hits = (q: Map<string, Quote>) => constituents.filter((c) => q.get(yahooTicker(c.sym)) || q.get(c.sym)).length;

    let quotes: Map<string, Quote>, source = 'nasdaq-screener';
    try {
      quotes = await nasdaqScreener();
      if (hits(quotes) < 300) throw new Error(`screener coverage too thin (${hits(quotes)})`);
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
    const { sectors, covered } = buildHeatmap(constituents, quotes, prevCaps);
    if (covered < 300) throw new Error(`heatmap coverage too thin after cap merge (${covered})`);
    const harvested = new Map<string, number>(prevCaps);
    for (const s of sectors) for (const t of s.tiles) harvested.set(t.sym, t.cap);
    capCache = { at: capCache && source === 'yahoo-spark+cap-cache' ? capCache.at : Date.now(), caps: harvested };

    const body = { ok: true, asOf: lastTradingDayIso(), generatedAt: new Date().toISOString(), source, count: covered, sectors };
    payloadCache = { at: Date.now(), body };
    return body;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  if (payloadCache && Date.now() - payloadCache.at < ttlMs()) return reply(200, payloadCache.body);

  try {
    inflight ??= refresh().finally(() => { inflight = null; });
    return reply(200, await inflight);
  } catch (e) {
    if (payloadCache) return reply(200, payloadCache.body); // stale-but-honest
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
