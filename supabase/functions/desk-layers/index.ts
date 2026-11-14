// ── desk-layers — the Layers Heat Map's daily inputs (step 2) ────────────────
// specs/layers-heat-map/LAYERS_HEAT_MAP.md, sections 2, 3 and 13 (owner 2026-11-14:
// "Build it now"; ruling H — a new daily feed is accepted in principle, and nothing
// here is deployed without the owner's approval).
//
// It GATHERS and SERVES the inputs. It scores nothing: the scoring runs in the
// visitor's browser (scripts/layers.js, `layersScore`) on the dashboard's own
// stochastic code, so the panel's numbers match the charts.
//
// What it gathers, once a day after the close (16:15 ET; "today" is the last
// completed session):
//   - daily bars (~300 sessions) for every S&P 500 member (the constituents CSV:
//     name, GICS sector, sub-industry) and every single stock on the dashboard's
//     own watchlists that is not in the S&P 500 (sector from Yahoo's company
//     profile, mapped to the eleven GICS sectors by a fixed table);
//   - the market series: Brent, the dollar index, ACWX, the 10-year yield, the
//     VIX, HYG, IEF, SPY, the S&P 500 index and the eleven sector funds;
//   - FRED core CPI, unemployment and payrolls, and the CNN Fear & Greed history
//     (the community file named in the rules file, marked stale when it stops).
//
// How (the desk-heatmap pattern): the work is too big for one request, so every
// request ADVANCES a sweep by a small, AWAITED, time-boxed step and persists what
// it fetched to desk_feed_cache (desk_006, RLS deny-all, service key only), one
// row per Yahoo symbol (`layers:y:<SYM>`). Progress is read from the rows' `at`
// (fetched after the target session settled), so concurrent requests converge
// instead of overwriting each other. Once every symbol is in, ONE request
// assembles the payload, gzips it and stores it as `layers:body`; every request
// serves the newest body it has — the previous session's while today's sweep is
// still running — as gzip bytes the page inflates itself. No migration: the
// table exists.
//
// Anon-callable: public market data only. The caller sends nothing that reaches
// an upstream URL. The watchlist roster is ANON-WRITABLE (CLAUDE.md, audit C1),
// so only regex-validated tickers are read from it, never a list title, and
// their number is capped; each one is one Yahoo request a day.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'x-layers-asof, x-layers-target, x-layers-done, x-layers-total, x-layers-failed',
};
const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });

/* For OUTBOUND third-party calls only (Yahoo, FRED, GitHub). NEVER on this
   project's own REST calls: the gateway refuses the secret key from anything
   that looks like a browser (CLAUDE.md, 2026-07-29).
   The desk's own honest name, as quote-proxy, desk-charts and desk-econ send on
   these same hosts — never a copied Chrome string: measured 2026-11-14, Yahoo
   answered a Chrome user-agent 429 on the chart and crumb calls and FRED reset
   the connection, while this one got 200 from all three. */
const UA = { 'user-agent': 'Mozilla/5.0 (desk layers; +https://akyachtsman.github.io/claude.trading/)' };

const CONSTITUENTS_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const FEAR_GREED_URL = 'https://raw.githubusercontent.com/whit3rabbit/fear-greed-data/main/fear-greed.csv';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const FRED_SERIES = { core: 'CPILFESL', unrate: 'UNRATE', payems: 'PAYEMS' } as const;

/* Every upstream call carries its own bound (Deno's fetch has none): a host that
   stalls must cost that call, never the invocation. */
const FETCH_TIMEOUT_MS = 6000;
const CRUMB_TIMEOUT_MS = 4000;
const STORE_TIMEOUT_MS = 8000;     // the assembly reads ~600 rows, a few MB
/* One sweep step: start fetches for at most this long, then write what landed.
   ~6 lanes × ~0.3–0.6 s a chart ≈ 30–60 symbols a step, so a full day is
   ~10–20 page requests (the page asks again every minute while it is open). */
const STEP_BUDGET_MS = 3500;
const LANES = 6;
const KEEP_BARS = 300;             // ≥ 205 for a 200-day cross within 5 sessions, with room
const SETTLE_MIN = 16 * 60 + 15;   // the rules file's 16:15 ET
/* A row fetched after the settle that does not yet carry the target day is asked
   again until this long after the settle (Yahoo can be minutes late); after that
   it counts as answered, and the scorer leaves the stock out for the day. */
const LATE_RETRY_MS = 2 * 3600_000;
const WATCH_CAP = 300;             // non-S&P watchlist symbols read (anon-writable roster)
const BODY_KEY = 'layers:body';
const MACRO_KEY = 'layers:macro';
const ROW_PREFIX = 'layers:y:';

export const MARKET: Record<string, string> = {
  brent: 'BZ=F', dxy: 'DX-Y.NYB', acwx: 'ACWX', tnx: '^TNX', vix: '^VIX',
  hyg: 'HYG', ief: 'IEF', spy: 'SPY', gspc: '^GSPC',
};
/* The eleven GICS sectors and their funds — the SAME table as LAYERS_SECTORS in
   scripts/layers.js (tools/unit/desk-layers.test.mjs holds them equal). */
export const SECTOR_FUNDS: [string, string][] = [
  ['Information Technology', 'XLK'], ['Financials', 'XLF'], ['Health Care', 'XLV'], ['Consumer Discretionary', 'XLY'],
  ['Communication Services', 'XLC'], ['Industrials', 'XLI'], ['Consumer Staples', 'XLP'], ['Energy', 'XLE'],
  ['Utilities', 'XLU'], ['Real Estate', 'XLRE'], ['Materials', 'XLB'],
];
/* Yahoo's sector names → GICS (agreed 2026-11-13). Anything else does not map. */
export const YAHOO_SECTORS: Record<string, string> = {
  'Technology': 'Information Technology', 'Healthcare': 'Health Care', 'Financial Services': 'Financials',
  'Consumer Cyclical': 'Consumer Discretionary', 'Consumer Defensive': 'Consumer Staples', 'Energy': 'Energy',
  'Industrials': 'Industrials', 'Basic Materials': 'Materials', 'Utilities': 'Utilities', 'Real Estate': 'Real Estate',
  'Communication Services': 'Communication Services',
};
export const SYM_RE = /^[A-Z0-9.^=-]{1,10}$/;   // the dashboard's WL_SYM_RE
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
/* Yahoo spells a class share with a dash (BRK-B); the roster with a dot. */
/* Yahoo writes a share class with a dash (BRK.B → BRK-B) but keeps an exchange
   suffix's dot (DX-Y.NYB): only a dot before ONE final letter is a class (the
   rule desk-watchlist's toYahoo uses). */
export const yahooTicker = (sym: string) => sym.trim().toUpperCase().replace(/\.([A-Z])$/, '-$1');

// ── the trading calendar (New York) ──────────────────────────────────────────
const NY_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
// HOLIDAY LIST — the same as every other function's; extend it with NYSE_HOLIDAYS in data.js before 2028.
export const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
function shiftDays(iso: string, k: number): string {
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) + k * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
export function isTradingDay(iso: string): boolean {
  const dow = new Date(iso + 'T12:00:00Z').getUTCDay();
  return dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(iso);
}
/* The epoch ms at which New York's wall clock reads `iso` hh:mm. */
export function nyWallMs(iso: string, hh: number, mm: number): number {
  const want = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), hh, mm);
  let t = want + 5 * 3600_000;   // EST first guess; one correction lands EDT
  for (let i = 0; i < 2; i++) {
    const p = ET_CLOCK.formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    const seen = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    t += want - seen;
  }
  return t;
}
/* "Today" for the panel: the last session whose close has settled (16:15 ET). */
export function targetSession(now: Date): string {
  let d = NY_DATE.format(now);
  const p = ET_CLOCK.formatToParts(now);
  const min = Number(p.find((x) => x.type === 'hour')?.value) * 60 + Number(p.find((x) => x.type === 'minute')?.value);
  if (!(isTradingDay(d) && min >= SETTLE_MIN)) d = shiftDays(d, -1);
  while (!isTradingDay(d)) d = shiftDays(d, -1);
  return d;
}
export const settleMs = (iso: string) => nyWallMs(iso, 16, 15);

// ── parsing the sources ──────────────────────────────────────────────────────
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
export type Member = { sym: string; name: string; sector: string; sub: string };
/* The S&P 500 roster. A member whose sector is not one of the eleven is kept OUT
   of the roster (it could only be scored against a sector that does not exist). */
export function parseConstituents(csv: string): Member[] {
  const rows = parseCsv(String(csv).replace(/^﻿/, ''));
  if (!rows.length) throw new Error('constituents CSV is empty');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const iSym = head.findIndex((h) => h === 'symbol');
  const iName = head.findIndex((h) => /security|name/.test(h));
  const iSector = head.findIndex((h) => /sector/.test(h) && !/sub/.test(h));
  const iSub = head.findIndex((h) => /sub-industry|sub industry/.test(h));
  if (iSym < 0 || iSector < 0) throw new Error('constituents CSV missing symbol/sector columns');
  const sectors = new Set(SECTOR_FUNDS.map((s) => s[0]));
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const r of rows.slice(1)) {
    const sym = (r[iSym] || '').trim().toUpperCase();
    const sector = (r[iSector] || '').trim();
    if (!SYM_RE.test(sym) || !sectors.has(sector) || seen.has(sym)) continue;
    seen.add(sym);
    out.push({ sym, name: (r[iName] || '').trim().slice(0, 80), sector, sub: iSub >= 0 ? (r[iSub] || '').trim().slice(0, 80) : '' });
  }
  if (out.length < 400) throw new Error(`constituents CSV holds only ${out.length} usable members`);
  return out;
}
/* The watchlists' symbols that are not S&P members: validated, deduped, in
   roster order, capped. Titles are never read (anon-writable text). */
export function watchSymbols(rows: unknown, members: Set<string>, cap = WATCH_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    // deno-lint-ignore no-explicit-any
    const syms = Array.isArray((r as any)?.symbols) ? (r as any).symbols : [];
    for (const raw of syms) {
      const s = String(raw ?? '').trim().toUpperCase();
      if (!SYM_RE.test(s) || members.has(s) || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

export type Bars = { t: string[]; o: number[]; h: number[]; l: number[]; c: number[]; a: number[] | null; v: number[] };
export type Meta = { type: string; currency: string; name: string };
const r2 = (x: number) => Math.round(x * 100) / 100;
/* One Yahoo chart reply → bars up to and including `through` (never a later,
   unfinished session), the newest KEEP_BARS of them. A bar missing any of
   open/high/low/close, or carrying a zero or negative price, is dropped (the
   dashboard's own parser does the same); a missing volume is 0. */
export function parseChart(json: unknown, through: string, keep = KEEP_BARS): { meta: Meta; bars: Bars } | null {
  // deno-lint-ignore no-explicit-any
  const res = (json as any)?.chart?.result?.[0];
  if (!res || typeof res !== 'object') return null;
  const m = res.meta || {};
  const meta: Meta = {
    type: String(m.instrumentType || ''),
    currency: String(m.currency || ''),
    name: String(m.longName || m.shortName || '').slice(0, 80),
  };
  const ts: unknown[] = Array.isArray(res.timestamp) ? res.timestamp : [];
  const q = res.indicators?.quote?.[0] || {};
  const adj: unknown[] | null = Array.isArray(res.indicators?.adjclose?.[0]?.adjclose) ? res.indicators.adjclose[0].adjclose : null;
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], a: adj ? [] : null, v: [] };
  for (let i = 0; i < ts.length; i++) {
    const secs = Number(ts[i]);
    if (!Number.isFinite(secs)) continue;
    const o = Number(q.open?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), c = Number(q.close?.[i]);
    if (q.open?.[i] == null || q.high?.[i] == null || q.low?.[i] == null || q.close?.[i] == null) continue;
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    const d = NY_DATE.format(new Date(secs * 1000));
    if (d > through) continue;
    if (b.t.length && b.t[b.t.length - 1] === d) {   // a repeated day: the later bar wins
      for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) (b[k] as unknown[]).pop();
      if (b.a) b.a.pop();
    }
    b.t.push(d); b.o.push(r2(o)); b.h.push(r2(h)); b.l.push(r2(l)); b.c.push(r2(c));
    const v = Number(q.volume?.[i]);
    b.v.push(Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    if (b.a) { const a = Number(adj![i]); b.a.push(a > 0 ? r2(a) : r2(c)); }
  }
  if (b.t.length > keep) for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'a'] as const) if (b[k]) (b as Record<string, unknown[]>)[k] = (b[k] as unknown[]).slice(-keep);
  return { meta, bars: b };
}
export function parseFredCsv(text: string, keep = 13): [string, number][] {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const head = (lines[0] ?? '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  if (head.length < 2 || !/^(observation_date|date)$/i.test(head[0])) throw new Error('FRED: not a series CSV');
  const out: [string, number][] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const d = (cells[0] ?? '').trim(), raw = (cells[1] ?? '').trim();
    if (!ISO_RE.test(d) || raw === '' || raw === '.') continue;   // a hole is a hole, never a 0
    const v = Number(raw);
    if (Number.isFinite(v)) out.push([d, v]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out.slice(-keep);
}
/* `Date,Fear Greed,Rating` — readings up to `through`, the newest `keep`. */
export function parseFearGreed(text: string, through: string, keep = 60): [string, number][] {
  const rows = parseCsv(String(text).replace(/^﻿/, ''));
  const out: [string, number][] = [];
  for (const r of rows.slice(1)) {
    const d = (r[0] || '').trim(), v = Number((r[1] || '').trim());
    if (!ISO_RE.test(d) || d > through || (r[1] || '').trim() === '' || !Number.isFinite(v) || v < 0 || v > 100) continue;
    out.push([d, Math.round(v * 10) / 10]);
  }
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out.slice(-keep);
}

// ── the compact encoding (decoded by layersDecode in scripts/layers.js) ──────
// Prices are whole cents: the close as a running difference from the bar before,
// open/high/low as a difference from their own close. The adjusted close is the
// close times a factor that only changes on an ex-dividend day, sent as runs
// [first index, factor]. Dates are positions in one shared calendar (`cal`): a
// series names its first position and the positions it skips; a series with a
// date the calendar does not hold (a futures holiday session) sends its own `t`.
// ~1.6 MB gzipped for ~600 stocks against ~2.4 MB as plain numbers (measured on
// real bars, 2026-11-14). Every value decodes back exactly (tools/unit/desk-layers.test.mjs).
export type Enc = { t0?: number; sk?: number[]; t?: string[]; c: number[]; o: number[]; h: number[]; l: number[]; v: number[]; af?: [number, number][] };
const cents = (x: number) => Math.round(x * 100);
export function encodeBars(b: Bars, calIdx: Map<string, number> | null): Enc {
  const c = b.c.map(cents);
  const e: Enc = {
    c: c.map((v, i) => (i ? v - c[i - 1] : v)),
    o: b.o.map((x, i) => cents(x) - c[i]),
    h: b.h.map((x, i) => cents(x) - c[i]),
    l: b.l.map((x, i) => cents(x) - c[i]),
    v: b.v.slice(),
  };
  if (b.a) {
    const af: [number, number][] = [];
    let cur = NaN;
    b.a.forEach((a, i) => {
      /* a new run only where the running factor would not give back THIS bar's adjusted close to the cent, by the
         decoder's own arithmetic — so the page's adjusted closes are exactly the ones stored */
      if (Math.round(b.c[i] * cur * 100) / 100 === a) return;
      cur = Number((a / b.c[i]).toPrecision(10));
      af.push([i, cur]);
    });
    if (!(af.length === 1 && af[0][1] === 1)) e.af = af;
  }
  const idx = calIdx ? b.t.map((d) => calIdx.get(d)) : [];
  if (calIdx && b.t.length && idx.every((x) => x !== undefined)) {
    const first = idx[0]!, last = idx[idx.length - 1]!;
    const have = new Set(idx as number[]);
    e.t0 = first;
    const sk: number[] = [];
    for (let i = first; i <= last; i++) if (!have.has(i)) sk.push(i);
    if (sk.length) e.sk = sk;
  } else e.t = b.t.slice();
  return e;
}

// ── storage (desk_feed_cache, service key, NO user-agent) ────────────────────
function storeHeaders(): Record<string, string> {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}
const storeUrl = () => Deno.env.get('SUPABASE_URL')!;
function scrubbed(s: unknown): string {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const t = String(s);
  return key ? t.split(key).join('[key]') : t;
}
type Progress = Map<string, { at: number; last: string | null; sector: string | null; ind: string | null }>;
/* Which symbols are in, and when: keys, times and three small fields, never the
   bars. THROWS on a failed read — "could not read" is not "nothing there". */
export async function readProgress(): Promise<Progress> {
  const res = await fetch(
    `${storeUrl()}/rest/v1/desk_feed_cache?select=key,at,last:payload->>last,sector:payload->>sector,ind:payload->>ind&key=like.${encodeURIComponent(ROW_PREFIX)}*`,
    { headers: storeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`progress read HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('progress read: unexpected body');
  const out: Progress = new Map();
  for (const r of rows) {
    const sym = String(r.key || '').slice(ROW_PREFIX.length);
    if (sym) out.set(sym, { at: Date.parse(r.at) || 0, last: r.last ?? null, sector: r.sector ?? null, ind: r.ind ?? null });
  }
  return out;
}
async function readRows(keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += 150) {   // keep the URL short
    const list = keys.slice(i, i + 150).map((k) => '"' + k.replace(/"/g, '') + '"').join(',');
    const res = await fetch(`${storeUrl()}/rest/v1/desk_feed_cache?select=key,payload&key=in.(${encodeURIComponent(list)})`,
      { headers: storeHeaders(), signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`rows read HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('rows read: unexpected body');
    for (const r of rows) out.set(String(r.key), r.payload);
  }
  return out;
}
async function writeRows(rows: { key: string; payload: unknown }[]): Promise<boolean> {
  if (!rows.length) return true;
  try {
    const at = new Date().toISOString();
    const res = await fetch(`${storeUrl()}/rest/v1/desk_feed_cache?on_conflict=key`, {
      method: 'POST',
      headers: { ...storeHeaders(), prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.map((r) => ({ key: r.key, at, payload: r.payload }))),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`desk-layers: write of ${rows.length} rows failed HTTP ${res.status} ${scrubbed(detail).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`desk-layers: write of ${rows.length} rows failed ${scrubbed((e as Error)?.name || e)}`);
    return false;
  }
}

// ── upstream ─────────────────────────────────────────────────────────────────
async function getText(url: string, ms = FETCH_TIMEOUT_MS): Promise<string> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}
async function getCrumb(): Promise<{ cookie: string; crumb: string }> {
  const signal = AbortSignal.timeout(CRUMB_TIMEOUT_MS);
  const init = await fetch('https://fc.yahoo.com/', { headers: UA, redirect: 'manual', signal });
  const cookie = (init.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('no Yahoo session cookie issued');
  const res = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie }, signal });
  if (!res.ok) throw new Error(`getcrumb HTTP ${res.status}`);
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) throw new Error('no Yahoo crumb issued');
  return { cookie, crumb };
}
/* Yahoo's company profile → { sector, ind }, or null when Yahoo could not be
   asked (retried next step). An answered profile with no sector is ''. */
async function profileOf(sym: string, auth: { cookie: string; crumb: string }): Promise<{ sector: string; ind: string } | null> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker(sym))}?modules=assetProfile&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { ...UA, cookie: auth.cookie }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!res) return null;
  if (res.status === 404) return { sector: '', ind: '' };
  if (!res.ok) return null;
  // deno-lint-ignore no-explicit-any
  const j: any = await res.json().catch(() => null);
  const p = j?.quoteSummary?.result?.[0]?.assetProfile;
  if (!j) return null;
  return { sector: String(p?.sector || '').slice(0, 60), ind: String(p?.industry || '').slice(0, 80) };
}

// ── the roster ───────────────────────────────────────────────────────────────
type Roster = { members: Member[]; watch: string[]; at: number };
let rosterCache: Roster | null = null;
async function loadRoster(): Promise<Roster> {
  if (rosterCache && Date.now() - rosterCache.at < 3600_000) return rosterCache;
  const members = parseConstituents(await getText(CONSTITUENTS_URL));
  const set = new Set(members.map((m) => m.sym));
  /* A failed watchlist read is NOT an empty watchlist: a day assembled without
     it would leave out every non-S&P watchlist stock until the next session. So
     it throws (this request serves the stored body and the next one tries
     again), or keeps the watchlist an earlier read in this isolate got. */
  const res = await fetch(`${storeUrl()}/rest/v1/desk_watchlists?select=symbols`, { headers: storeHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
  const rows = res && res.ok ? await res.json().catch(() => null) : null;
  if (!Array.isArray(rows)) {
    console.warn('desk-layers: watchlist read failed', res ? res.status : 'no answer');   // status only
    if (!rosterCache) throw new Error('watchlist read failed');
    return { members, watch: rosterCache.watch, at: rosterCache.at };   // not cached: the next request reads again
  }
  rosterCache = { members, watch: watchSymbols(rows, set), at: Date.now() };
  return rosterCache;
}
export function rosterSymbols(r: { members: Member[]; watch: string[] }): string[] {
  const all = [...Object.values(MARKET), ...SECTOR_FUNDS.map((s) => s[1]), ...r.members.map((m) => m.sym), ...r.watch];
  return [...new Set(all)];
}

// ── the sweep ────────────────────────────────────────────────────────────────
/* A symbol is IN for `target` when its row was fetched after that session
   settled and carries the session — or it was fetched long enough after it that
   Yahoo has had its chance (a halted or delisted stock never will). */
export function isIn(p: { at: number; last: string | null } | undefined, target: string): boolean {
  if (!p) return false;
  const s = settleMs(target);
  if (p.at < s) return false;
  return p.last === target || (p.last !== null && p.last > target) || p.at >= s + LATE_RETRY_MS || p.last === '';
}
async function fetchOne(sym: string, target: string, needProfile: boolean, auth: () => Promise<{ cookie: string; crumb: string } | null>, prev: { sector: string | null; ind: string | null } | undefined) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker(sym))}?range=2y&interval=1d&includeAdjustedClose=true`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!res) return null;                                     // no answer: ask again next step
  if (res.status === 404) return { key: ROW_PREFIX + sym, payload: { last: '', err: 'no such symbol' } };
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json) return null;
  const got = parseChart(json, target);
  if (!got || !got.bars.t.length) return { key: ROW_PREFIX + sym, payload: { last: '', err: 'no price data', ...(got ? { meta: got.meta } : {}) } };
  const payload: Record<string, unknown> = { last: got.bars.t[got.bars.t.length - 1], meta: got.meta, bars: got.bars };
  if (needProfile && got.meta.type === 'EQUITY' && got.meta.currency === 'USD') {
    if (prev && prev.sector) { payload.sector = prev.sector; payload.ind = prev.ind || ''; }
    else {
      const a = await auth();
      const p = a ? await profileOf(sym, a) : null;
      if (!p) return null;                                   // the profile is part of the answer: ask again
      payload.sector = p.sector; payload.ind = p.ind;
    }
  }
  return { key: ROW_PREFIX + sym, payload };
}
async function sweepStep(target: string, roster: Roster, progress: Progress): Promise<number> {
  const members = new Set(roster.members.map((m) => m.sym));
  const watch = new Set(roster.watch);
  const todo = rosterSymbols(roster).filter((s) => !isIn(progress.get(s), target));
  if (!todo.length) return 0;
  const deadline = Date.now() + STEP_BUDGET_MS;
  let crumb: Promise<{ cookie: string; crumb: string } | null> | null = null;
  const auth = () => (crumb ??= getCrumb().catch((e) => { console.warn('desk-layers: crumb', (e as Error)?.message); return null; }));
  const out: { key: string; payload: unknown }[] = [];
  let next = 0;
  const lane = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const sym = todo[next++];
      const row = await fetchOne(sym, target, watch.has(sym) && !members.has(sym), auth, progress.get(sym)).catch(() => null);
      if (row) out.push(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LANES, todo.length) }, lane));
  /* Progress moves only for rows that were STORED: assembly reads the store, so
     a failed write must leave these symbols to be fetched again, never let an
     older row stand in for the session. */
  if (!(await writeRows(out))) return 0;
  for (const r of out) {
    // deno-lint-ignore no-explicit-any
    const p = r.payload as any;
    progress.set(r.key.slice(ROW_PREFIX.length), { at: Date.now(), last: p.last ?? null, sector: p.sector ?? null, ind: p.ind ?? null });
  }
  return out.length;
}
async function macroFor(target: string): Promise<unknown | null> {
  const rows = await readRows([MACRO_KEY]);
  // deno-lint-ignore no-explicit-any
  const cur = rows.get(MACRO_KEY) as any;
  if (cur && cur.for === target) return cur;
  const fred: Record<string, [string, number][]> = {};
  for (const [k, id] of Object.entries(FRED_SERIES)) {
    fred[k] = await getText(`${FRED_CSV}?id=${id}`, 10_000).then((t) => parseFredCsv(t)).catch(() => (cur?.fred?.[k] || []));
  }
  const fg = await getText(FEAR_GREED_URL).then((t) => parseFearGreed(t, target)).catch(() => (cur?.fg || []));
  const macro = { for: target, fred, fg };
  await writeRows([{ key: MACRO_KEY, payload: macro }]);
  return macro;
}

// ── assembling the body ──────────────────────────────────────────────────────
export type Excluded = { sym: string; name: string; why: string };
/* Everything stored for `target` → the payload the page decodes. Pure. */
// deno-lint-ignore no-explicit-any
export function buildPayload(target: string, roster: { members: Member[]; watch: string[] }, rows: Map<string, any>, macro: any, built: string) {
  const bars = (sym: string): Bars | null => { const p = rows.get(sym); return p && p.bars && Array.isArray(p.bars.t) && p.bars.t.length ? p.bars : null; };
  const metaOf = (sym: string): Meta => (rows.get(sym)?.meta || { type: '', currency: '', name: '' });
  const excluded: Excluded[] = [];
  const stocks: { s: string; n: string; sec: string; sub: string; sp: number; b: Bars }[] = [];
  for (const m of roster.members) {
    const b = bars(m.sym);
    if (!b) { excluded.push({ sym: m.sym, name: m.name, why: 'no price data' }); continue; }
    stocks.push({ s: m.sym, n: m.name, sec: m.sector, sub: m.sub, sp: 1, b });
  }
  for (const sym of roster.watch) {
    const p = rows.get(sym), meta = metaOf(sym), name = meta.name || sym, b = bars(sym);
    const type = meta.type;
    if (type === 'ETF' || type === 'MUTUALFUND') { excluded.push({ sym, name, why: 'a fund' }); continue; }
    if (type === 'INDEX') { excluded.push({ sym, name, why: 'an index' }); continue; }
    if (!b) { excluded.push({ sym, name, why: 'no price data' }); continue; }
    if (type !== 'EQUITY') { excluded.push({ sym, name, why: 'not a single stock' }); continue; }
    if (meta.currency !== 'USD') { excluded.push({ sym, name, why: 'not priced in dollars' }); continue; }
    const sector = YAHOO_SECTORS[String(p?.sector || '')];
    if (!sector) { excluded.push({ sym, name, why: 'its sector does not map to one of the eleven' }); continue; }
    stocks.push({ s: sym, n: name, sec: sector, sub: String(p?.ind || ''), sp: 0, b });
  }
  const cal = [...new Set(stocks.flatMap((s) => s.b.t))].sort();
  const calIdx = new Map(cal.map((d, i) => [d, i]));
  const market: Record<string, Enc> = {};
  for (const [k, sym] of Object.entries(MARKET)) { const b = bars(sym); if (b) market[k] = encodeBars(b, calIdx); }
  const funds: Record<string, Enc> = {};
  for (const [, sym] of SECTOR_FUNDS) { const b = bars(sym); if (b) funds[sym] = encodeBars(b, calIdx); }
  const fg = Array.isArray(macro?.fg) ? macro.fg : [];
  return {
    ok: true, v: 1, asOf: target, built, cal, market, funds,
    stocks: stocks.map((s) => ({ s: s.s, n: s.n, sec: s.sec, sub: s.sub, sp: s.sp, b: encodeBars(s.b, calIdx) })),
    fred: { core: macro?.fred?.core || [], unrate: macro?.fred?.unrate || [], payems: macro?.fred?.payems || [] },
    fg, fgLast: fg.length ? fg[fg.length - 1][0] : null,
    excluded,
  };
}
async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function toB64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
type Body = { asOf: string; gz: Uint8Array; n: number };
let bodyCache: { body: Body; at: number } | null = null;
async function readBody(): Promise<Body | null> {
  if (bodyCache && Date.now() - bodyCache.at < 600_000) return bodyCache.body;
  const rows = await readRows([BODY_KEY]);
  // deno-lint-ignore no-explicit-any
  const p = rows.get(BODY_KEY) as any;
  if (!p || typeof p.gz !== 'string' || !ISO_RE.test(String(p.asOf))) return null;
  const body = { asOf: p.asOf, gz: fromB64(p.gz), n: Number(p.n) || 0 };
  bodyCache = { body, at: Date.now() };
  return body;
}
async function assemble(target: string, roster: Roster, macro: unknown): Promise<Body | null> {
  const syms = rosterSymbols(roster);
  const rows = await readRows(syms.map((s) => ROW_PREFIX + s));
  const bySym = new Map<string, unknown>();
  for (const [k, v] of rows) bySym.set(k.slice(ROW_PREFIX.length), v);
  const payload = buildPayload(target, roster, bySym, macro, new Date().toISOString());
  if (payload.stocks.length < 400 || !payload.market.spy) {
    console.error(`desk-layers: assembly refused, ${payload.stocks.length} stocks${payload.market.spy ? '' : ', no SPY'}`);
    return null;   // a broken sweep must never replace a good body
  }
  const gz = await gzip(JSON.stringify(payload));
  const body = { asOf: target, gz, n: payload.stocks.length };
  if (await writeRows([{ key: BODY_KEY, payload: { asOf: target, n: body.n, built: payload.built, gz: toB64(gz) } }])) bodyCache = { body, at: Date.now() };
  return body;
}

// ── the request ──────────────────────────────────────────────────────────────
let inflight: Promise<{ done: number; total: number; body: Body | null }> | null = null;
async function advance(target: string): Promise<{ done: number; total: number; body: Body | null }> {
  let body = await readBody().catch((e) => { console.error('desk-layers: body read', scrubbed((e as Error)?.message)); return null; });
  if (body && body.asOf === target) return { done: body.n, total: body.n, body };
  const roster = await loadRoster();
  const progress = await readProgress();
  await sweepStep(target, roster, progress);
  const syms = rosterSymbols(roster);
  const done = syms.filter((s) => isIn(progress.get(s), target)).length;
  if (done === syms.length) {
    const macro = await macroFor(target);
    const fresh = await assemble(target, roster, macro);
    if (fresh) body = fresh;
  }
  return { done, total: syms.length, body };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const target = targetSession(new Date());
  let state: { done: number; total: number; body: Body | null };
  let failed = false;
  try {
    inflight ??= advance(target).finally(() => { inflight = null; });
    state = await inflight;
  } catch (e) {
    /* The sweep could not move (roster, watchlist or store unreadable). The last
       body is still served, but SAID to be served by a failing feed
       (`x-layers-failed`), so the page lamps it STALE instead of EOD; with no
       body there is nothing to serve and the reply is a plain failure. */
    console.error('desk-layers: step failed', scrubbed((e as Error)?.message || e));
    failed = true;
    const body = await readBody().catch(() => null);
    state = { done: 0, total: 0, body };
  }
  const head: Record<string, string> = { 'x-layers-target': target, 'x-layers-done': String(state.done), 'x-layers-total': String(state.total) };
  if (failed) head['x-layers-failed'] = '1';
  if (!state.body) return failed ? reply(503, { ok: false, error: 'the sweep failed' }, head) : reply(200, { ok: true, ready: false, target, done: state.done, total: state.total }, head);
  return new Response(state.body.gz, {
    status: 200,
    headers: { ...CORS, ...head, 'x-layers-asof': state.body.asOf, 'content-type': 'application/octet-stream', 'cache-control': 'no-store' },
  });
});
