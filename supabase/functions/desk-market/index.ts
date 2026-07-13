// ── desk-market — market summary strip, delayed quotes on demand ─────────────
// Replaces the nightly fetch-market.js → data/market.json step
// (retire-nightly-pipeline plan, Group A). Same sources, same tile shape:
// Stooq daily CSV → Yahoo v8 chart fallback for the five index tiles, FRED
// DGS10 for the 10Y (T-1 by upstream construction — stamped with the SERIES
// date, never the fetch time; see the plan's lamp carve-out).
// All six tiles must succeed or the response is ok:false — the client keeps
// its last good payload (FR-R9); a partial strip is a lie, not a degradation.
//
// Anon-callable: public market data, no caller input reaches the upstream
// URLs. Module cache TTL is session-aware (5 min while the US equities
// session is open, 60 min closed — spec Clarification 6).

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
  { sym: '^ndx', name: 'Nasdaq 100' },
  { sym: '^dji', name: 'Dow Jones' },
  { sym: 'iwm.us', name: 'IWM (R2K proxy)' },
  { sym: '^vix', name: 'VIX' },
];
const YAHOO_MAP: Record<string, string> = { '^spx': '^GSPC', '^ndx': '^NDX', '^dji': '^DJI', '^vix': '^VIX' };

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
const ttlMs = () => (marketSessionOpen() ? 300_000 : 3_600_000);

// ── quote chain (verbatim ports of lib/stooq.js + lib/quotes.js) ────────────
type Row = { date: string; close: number };

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

async function stooqDaily(symbol: string): Promise<Row[]> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - 90 * 86400000);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await fetch(url, { headers: UA });
  const rows = parseStooqDaily(await res.text());
  if (rows.length < 2) throw new Error(`Stooq: ${rows.length} usable rows for ${symbol}`);
  return rows;
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

async function yahooDaily(stooqSym: string): Promise<Row[]> {
  const sym = yahooSymbol(stooqSym);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
  const res = await fetch(url, { headers: UA });
  const rows = parseYahooChart(await res.json().catch(() => null));
  if (rows.length < 2) throw new Error(`Yahoo: ${rows.length} usable rows for ${sym}`);
  return rows;
}

const dailyCloses = (symbol: string) => stooqDaily(symbol).catch(() => yahooDaily(symbol));

// ── tile shaping (verbatim ports of fetch-market.js) ────────────────────────
const fmtLast = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function tileFrom(name: string, rows: Row[]) {
  const closes = rows.map((r) => r.close);
  const [prev, last] = closes.slice(-2);
  return {
    name,
    last: fmtLast(last),
    chg: Number(((last / prev - 1) * 100).toFixed(2)),
    spark: closes.slice(-30).map((c) => Number(c.toFixed(4))),
    asOf: rows[rows.length - 1].date,
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
let cache: { at: number; body: unknown } | null = null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  if (cache && Date.now() - cache.at < ttlMs()) return reply(200, cache.body);

  try {
    // Parallel: Supabase egress has no runner-IP rate-limit history; the
    // pipeline's sequential 600ms spacing was an Actions-IP mitigation.
    const cosd = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const [idxRows, fredCsv] = await Promise.all([
      Promise.all(MARKET_SYMBOLS.map((m) => dailyCloses(m.sym))),
      fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=${cosd}`, { headers: UA }).then((r) => r.text()),
    ]);
    const tiles = MARKET_SYMBOLS.map((m, i) => tileFrom(m.name, idxRows[i]));
    const fredRows = parseFred(fredCsv);
    if (fredRows.length < 2) throw new Error(`FRED DGS10: ${fredRows.length} usable rows`);
    tiles.push(tenYearTile(fredRows));

    const asOf = tiles.map((t) => t.asOf).sort().at(-1);
    const body = { ok: true, asOf, generatedAt: new Date().toISOString(), tiles };
    cache = { at: Date.now(), body };
    return reply(200, body);
  } catch (e) {
    if (cache) return reply(200, cache.body); // stale-but-honest beats a dead strip
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
