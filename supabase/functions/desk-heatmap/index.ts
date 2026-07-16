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
const R2K_SKIP = 1000;  // ranks 1..1000 ≈ Russell 1000 — not small caps
const R2K_TAKE = 2000;  // the FULL index, finviz-style (owner ruling 2026-07-14:
                        // never silently shrink an expected scope — small tiles
                        // render unlabeled, hover carries the detail)

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

type Quote = { pct: number; cap: number | null; last: number | null; sector?: string; name?: string; industry?: string };
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

async function periodSweep(symbols: string[], batchSize = 20): Promise<Map<string, Periods>> {
  const out = new Map<string, Periods>();
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(yahooTicker).join(',')}&range=1y&interval=1d`;
    const res = await fetch(url, { headers: UA }).catch(() => null);
    if (!res || !res.ok) continue;
    // deno-lint-ignore no-explicit-any
    const json: any = await res.json().catch(() => null);
    for (const [sym, node] of Object.entries(json || {})) {
      // deno-lint-ignore no-explicit-any
      const ts: number[] = (node as any)?.timestamp || [];
      // deno-lint-ignore no-explicit-any
      const rawCloses: (number | null)[] = (node as any)?.close || [];
      const dates: string[] = [], closes: number[] = [];
      for (let j = 0; j < ts.length; j++) {
        const c = Number(rawCloses[j]);
        if (!Number.isFinite(c) || c <= 0) continue;
        dates.push(new Date(ts[j] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
        closes.push(c);
      }
      out.set(sym, periodsFromCloses(dates, closes));
    }
  }
  return out;
}

// ── shaping (buildHeatmap port + period merge) ───────────────────────────────
export function buildHeatmap(
  constituents: Constituent[],
  quotes: Map<string, Quote>,
  prevCaps: Map<string, number>,
  periods?: Map<string, Periods> | null,
) {
  const bySector = new Map<string, { sym: string; name: string; cap: number; pct: number; ind: string; last: number | null; pctW?: number | null; pctM?: number | null; pctYtd?: number | null }[]>();
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

function lastTradingDayIso(): string {
  // Anchor to the US market's calendar day (Eastern time), NOT UTC. After
  // ~20:00 ET the UTC date has already rolled to "tomorrow", so a UTC-based
  // stamp read a day ahead for evening US viewers (e.g. 6pm PT showed the next
  // date). Weekends roll back to Friday. (desk-news uses the same ET anchor.)
  const etIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD in ET
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

// Period sweeps persist in desk_feed_cache (desk_006) and advance in SMALL
// STEPS (a few spark batches per invocation): module memory dies with the
// isolate, and a single long background sweep gets killed by the edge
// runtime's background budget. Each request nudges the sweep forward; the
// client's 5-min poller (or a burst of calls) completes it, and the row is
// the durable progress ledger. Row payload: { done, total, map }.
const SWEEP_STEP_BATCHES = 8; // 8 × 20 symbols per nudge — still inside budget
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

async function advanceSweep(universe: string, symbols: string[]): Promise<void> {
  let row = await readSweepRow(universe);
  if (row && row.total !== symbols.length) row = null; // roster changed → resweep
  if (sweepComplete(row)) return;
  // stale-complete or missing → restart the ledger
  if (!row || (row.total > 0 && row.done >= row.total)) {
    row = { at: Date.now(), done: 0, total: symbols.length, map: {} };
  }
  const slice = symbols.slice(row.done, row.done + SWEEP_STEP_BATCHES * 20);
  if (!slice.length) { row.done = row.total; await writeSweepRow(universe, row); return; }
  const got = await periodSweep(slice);
  for (const [sym, p] of got) row.map[sym] = p;
  row.done += slice.length;
  row.at = Date.now();
  await writeSweepRow(universe, row);
  if (row.done >= row.total) payloadCache.delete(universe); // next call rebuilds WITH periods
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
  // periods must cover the roster — a partial map would shrink period views
  if (periods && periods.map.size < constituents.length * 0.8) periods = null;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  let universe = 'sp500';
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (body?.universe === 'r2k') universe = 'r2k'; // strict enum — anything else is sp500
  }

  const cached = payloadCache.get(universe);
  if (cached && Date.now() - cached.at < ttlMs()) {
    // cache hits still nudge an incomplete period sweep — otherwise the
    // sweep would only advance on TTL expiry (hours, off-session)
    // deno-lint-ignore no-explicit-any
    const syms = ((cached.body as any)?.sectors || []).flatMap((s: any) => s.tiles.map((t: any) => t.sym));
    if (syms.length) await kickPeriodSweep(universe, syms);
    return reply(200, cached.body);
  }

  try {
    if (!inflight.has(universe)) {
      const work = (universe === 'r2k' ? refreshR2k() : refreshSp500())
        .finally(() => { inflight.delete(universe); });
      inflight.set(universe, work);
    }
    return reply(200, await inflight.get(universe)!);
  } catch (e) {
    if (cached) return reply(200, cached.body); // stale-but-honest
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
