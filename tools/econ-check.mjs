#!/usr/bin/env node
/* Re-runnable checks for supabase/functions/desk-econ (the Economy panel feed).

     node tools/econ-check.mjs             # the suite, against the function as committed
     node tools/econ-check.mjs --mutants   # ...then prove each single-line mutant below is CAUGHT

   How: the function is transpiled with the PINNED esbuild in tools/package.json
   (`npm ci --prefix tools` once; there is no Deno here, and the check never
   downloads anything itself) and run in a fresh `vm` context per
   check, which is a cold isolate: `Deno.serve` is captured, `fetch` is a stub
   that serves the fixtures and records every call, and `Date` runs on a
   settable clock so TTLs and New_York release windows are exercised at chosen
   instants. Nothing touches the network or the live Supabase project.

   Fixtures (tools/fixtures/econ/):
     fred-*.csv       REAL FRED fredgraph.csv captures (public data, fetched
                      2026-09-30, cosd=2020-01-01). They carry the real hole
                      markers: an EMPTY field (Labor Day 2026-09-07, and the
                      2025-10-01 shutdown month for CPI and UNRATE), not ".".
     treasury-*.csv   CONSTRUCTED from Treasury's documented par-yield CSV layout
                      (quoted header names incl. "1.5 Month", MM/DD/YYYY, newest
                      first). 2 Yr / 10 Yr / 20 Yr copy the FRED capture on shared
                      dates; the 09/29 and 09/30/2026 rows are SYNTHETIC. The live
                      host was unreachable from the build sandbox, so the Treasury
                      path is UNVERIFIED against the real file — and it is ON in the
                      shipped roster (2Y/10Y/20Y, owner request 2026-09-30), which is
                      why every Treasury failure mode below must land on FRED. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'supabase/functions/desk-econ/index.ts');
const FIX = path.join(ROOT, 'tools/fixtures/econ');
const SITE = 'https://akyachtsman.github.io';
const T0 = Date.parse('2026-09-30T22:00:00Z'); // Wed 18:00 EDT — inside the Treasury window
const COSD_T0 = '2020-05-30';                  // 76 months before 2026-09-30 (NY)
const FRED_IDS = ['DGS2', 'DGS10', 'DGS20', 'UNRATE', 'CPIAUCNS', 'PCEPI', 'PCEPILFE'];
const FRED_TEXT = Object.fromEntries(FRED_IDS.map((id) => [id, readFileSync(path.join(FIX, `fred-${id}.csv`), 'utf8')]));
const TSY_TEXT = Object.fromEntries(['202608', '202609'].map((m) => [m, readFileSync(path.join(FIX, `treasury-${m}.csv`), 'utf8')]));
// The shipped roster. Since 2026-09-30 (owner request: current 2Y/10Y yields; 20Y comes from the
// same Treasury file) it names a Treasury column on the three yield rows, so the same-day tail is
// ON. The harness serves it unless a test passes its own `config` (`config: null` = the config
// host is unreachable, so the built-in default is used). `let`, because the roster mutants at the
// bottom swap in a damaged copy and require the suite to notice.
let CONFIG = JSON.parse(readFileSync(path.join(ROOT, 'config/econ-indicators.json'), 'utf8'));
// [row id, FRED spine, Treasury column] — exactly these, and no other row, name a Treasury column.
const TSY_COLS = [['ust2y', 'DGS2', '2 Yr'], ['ust10y', 'DGS10', '10 Yr'], ['ust20y', 'DGS20', '20 Yr']];
const YIELDS = TSY_COLS.map(([id]) => id);
const OTHERS = ['unrate', 'cpi', 'pce', 'corepce'];
// The no-Treasury path, built explicitly: the committed roster with every `treasury` key stripped.
const fredOnly = (roster) => roster.map((r) => ({
  ...r, sources: Object.fromEntries(Object.entries(r.sources || {}).filter(([k]) => k !== 'treasury')),
}));

// ── assertions ───────────────────────────────────────────────────────────────
class Fail extends Error {}
const assert = (c, m) => { if (!c) throw new Fail(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Fail(`${m}: got ${x}, want ${y}`); };
const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Fail(`${m}: got ${a}, want ${b} ±${tol}`); };
const throws = (fn, m) => { let t = false; try { fn(); } catch { t = true; } assert(t, m + ' (expected a throw)'); };
const round = (v, d) => Number(v.toFixed(d));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── independent reference data (NOT the function's code) ─────────────────────
function refObs(id, cosd = COSD_T0) {
  const out = [];
  for (const line of FRED_TEXT[id].split('\n').slice(1)) {
    const [d, v] = line.split(',');
    if (!ISO.test(d || '') || v === undefined || v.trim() === '' || v.trim() === '.' || d < cosd) continue;
    out.push([d, Number(v)]);
  }
  return out;
}
function refTail(col) {
  const out = [];
  for (const text of Object.values(TSY_TEXT)) {
    const lines = text.trim().split('\n');
    const head = lines[0].split(',').map((s) => s.replace(/"/g, ''));
    const i = head.indexOf(col);
    for (const l of lines.slice(1)) {
      const c = l.split(',');
      const [mm, dd, yy] = c[0].split('/');
      out.push([`${yy}-${mm}-${dd}`, Number(c[i])]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
function refLevel(id, col) {
  const spine = refObs(id);
  const last = spine[spine.length - 1][0];
  return col ? spine.concat(refTail(col).filter(([d]) => d > last)) : spine;
}
function refYoy(obs) {
  const m = new Map(obs);
  const out = [];
  for (const [d, v] of obs) {
    const base = m.get(`${Number(d.slice(0, 4)) - 1}${d.slice(4)}`);
    if (base !== undefined) out.push([d, (v / base - 1) * 100]);
  }
  return out;
}
const REF = {
  ust2y: () => refLevel('DGS2', '2 Yr'), ust10y: () => refLevel('DGS10', '10 Yr'), ust20y: () => refLevel('DGS20', '20 Yr'),
  unrate: () => refObs('UNRATE'),
  cpi: () => refYoy(refObs('CPIAUCNS')), pce: () => refYoy(refObs('PCEPI')), corepce: () => refYoy(refObs('PCEPILFE')),
};
function refStart(last, range) {
  const [y, m, d] = last.split('-').map(Number);
  if (range === '1w') return new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10);
  const back = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '5y': 60 }[range];
  const t = y * 12 + (m - 1) - back, ny = Math.floor(t / 12), nm = t % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

// ── the harness: one vm context = one cold isolate ────────────────────────────
function fredResponse(id, cosd) {
  const text = FRED_TEXT[id];
  if (!text) return new Response('<!DOCTYPE html><title>Bad Request</title>', { status: 400 });
  const [head, ...rest] = text.split('\n');
  const body = [head, ...rest.filter((l) => !l || !cosd || l.slice(0, 10) >= cosd)].join('\n');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
}
const tsyResponse = (m) => (TSY_TEXT[m] ? new Response(TSY_TEXT[m], { status: 200 }) : new Response('Not Found', { status: 404 }));

function boot(code, opts = {}) {
  const clock = { now: opts.now ?? T0 };
  const calls = [];
  const env = { clock, calls, opts, warns: [], throwOnWarn: false };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, host: u.hostname, init });
    if (u.hostname === 'fred.stlouisfed.org') {
      const id = u.searchParams.get('id');
      const ov = env.opts.fred?.[id];
      return ov ? ov(u) : fredResponse(id, u.searchParams.get('cosd'));
    }
    if (u.hostname === 'home.treasury.gov') {
      const m = u.searchParams.get('field_tdr_date_value_month');
      return env.opts.treasury ? env.opts.treasury(m, u, init) : tsyResponse(m);
    }
    if (u.hostname === 'akyachtsman.github.io') {
      if (env.opts.config === null) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(env.opts.config === undefined ? CONFIG : env.opts.config), { status: 200 });
    }
    throw new TypeError('fetch to an unexpected host: ' + u.href);
  };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  // `timeoutScale` shrinks every AbortSignal.timeout the function sets (0.01: Treasury's 5s -> 50ms),
  // so a HUNG upstream can be exercised end to end without the suite sleeping for real seconds.
  const scale = opts.timeoutScale;
  const Abort = scale ? { timeout: (ms) => AbortSignal.timeout(Math.max(1, Math.round(ms * scale))) } : AbortSignal;
  let handler = null;
  const mod = { exports: {} };
  const sandbox = {
    module: mod, exports: mod.exports,
    Deno: { serve: (h) => { handler = h; } },
    fetch, Response, Request, Headers, AbortSignal: Abort, AbortController, URL,
    setTimeout, clearTimeout, Date: FakeDate,
    console: {
      log() {}, info() {},
      warn: (...a) => { if (env.throwOnWarn) throw new Error('injected failure'); env.warns.push(a.join(' ')); },
      error: (...a) => { env.warns.push(a.join(' ')); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'desk-econ.cjs' });
  assert(typeof handler === 'function', 'Deno.serve was never called');
  env.api = mod.exports;
  env.call = async (body = {}, o = {}) => {
    const method = o.method ?? 'POST';
    const headers = { 'content-type': 'application/json' };
    const origin = 'origin' in o ? o.origin : SITE;
    if (origin) headers.origin = origin;
    const init = { method, headers };
    if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await handler(new Request('https://x.supabase.co/functions/v1/desk-econ', init));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  env.fetchCount = (host, pred = () => true) => calls.filter((c) => c.host === host && pred(c)).length;
  return env;
}
const row = (r, id) => r.json.rows.find((x) => x.id === id);
const at = (iso) => Date.parse(iso);
const down = (status = 503) => () => new Response('upstream down', { status });

// ── the suite ────────────────────────────────────────────────────────────────
const TESTS = [
  ['FRED CSV: "." and EMPTY holes are holes (never 0), CRLF + trailing blanks, header checked', async (code) => {
    const { api } = boot(code);
    const csv = 'observation_date,DGS10\r\n2026-09-03,4.80\r\n2026-09-07,.\r\n2026-09-04,4.78\r\n2026-09-08,\r\n2026-09-09,4.83\r\n\r\n\r\n';
    eq(api.parseFredCsv(csv), [['2026-09-03', 4.8], ['2026-09-04', 4.78], ['2026-09-09', 4.83]], 'holes dropped, sorted');
    eq(api.parseFredCsv('DATE,DGS2\n2026-01-02,4.1\n'), [['2026-01-02', 4.1]], 'older DATE header accepted');
    const real = api.parseFredCsv(FRED_TEXT.DGS10);
    const filled = FRED_TEXT.DGS10.split('\n').slice(1).filter((l) => /^\d{4}-\d{2}-\d{2},\s*[-0-9]/.test(l)).length;
    eq(real.length, filled, 'real capture: one observation per filled line');
    assert(real.every(([, v]) => Number.isFinite(v) && v !== 0), 'real capture: no 0 and no NaN');
    assert(!real.some(([d]) => d === '2026-09-07') && real.some(([d]) => d === '2026-09-08'), 'Labor Day 2026-09-07 is a hole');
    const cpi = api.parseFredCsv(FRED_TEXT.CPIAUCNS);
    assert(!cpi.some(([d]) => d === '2025-10-01'), 'the 2025-10 shutdown month is a hole, not 0');
    throws(() => api.parseFredCsv('<!DOCTYPE html><html><body>Too many requests</body></html>'), 'HTML is not a series');
  }],

  ['Treasury CSV: columns BY NAME, MM/DD/YYYY, ascending, N/A + empty + future dropped, HTML refused', async (code) => {
    const { api } = boot(code);
    const m = api.parseTreasuryCsv(TSY_TEXT['202609'], '2026-09-30');
    const ten = m.get('10 Yr');
    eq(ten[0], refObs('DGS10').find(([d]) => d === '2026-09-01'), '10 Yr first (oldest) = the FRED value that day');
    eq(ten[ten.length - 1], ['2026-09-30', 5.21], '10 Yr newest');
    eq(m.get('2 Yr')[m.get('2 Yr').length - 1], ['2026-09-30', 4.9], '2 Yr newest');
    eq(m.get('20 Yr')[m.get('20 Yr').length - 1], ['2026-09-30', 5.58], '20 Yr newest');
    for (let i = 1; i < ten.length; i++) assert(ten[i - 1][0] < ten[i][0], 'strictly ascending');
    const early = api.parseTreasuryCsv(TSY_TEXT['202609'], '2026-09-29');
    eq(early.get('10 Yr').at(-1)[0], '2026-09-29', 'a row dated after today (NY) is dropped');
    const odd = api.parseTreasuryCsv('Date,"20 Yr","2 Yr","10 Yr"\n09/30/2026,5.58,N/A,\n09/29/2026,5.63,4.95,5.27\n', '2026-09-30');
    eq(odd.get('2 Yr'), [['2026-09-29', 4.95]], 'N/A dropped, never NaN');
    eq(odd.get('10 Yr'), [['2026-09-29', 5.27]], 'empty dropped, never 0');
    eq(odd.get('20 Yr'), [['2026-09-29', 5.63], ['2026-09-30', 5.58]], 'reordered header still maps by name');
    throws(() => api.parseTreasuryCsv('<html><body>Access Denied</body></html>', '2026-09-30'), 'HTML block page');
    throws(() => api.parseTreasuryCsv('Date,"Foo","Bar"\n09/30/2026,1,2\n', '2026-09-30'), 'no known tenor column');
  }],

  ['roster validation: bad rows dropped, dedupe (first wins), cap 12, units forced for yoy', async (code) => {
    const { api } = boot(code);
    const good = (i, extra = {}) => ({ id: 'r' + i, label: 'Row ' + i, sources: { fred: 'DGS10' }, unit: '%', transform: 'level', cadence: 'daily', decimals: 2, ...extra });
    const bad = [
      null, 'x', [1], good(0, { id: 'Bad Id' }), good(0, { label: 'Label too long' }), good(0, { label: '' }),
      good(0, { sources: { fred: 'DGS10&x=1' } }), good(0, { sources: {} }), good(0, { transform: 'cube' }),
      good(0, { cadence: 'hourly' }), good(0, { transform: 'mom' }),
      good(0, { transform: 'yoy', cadence: 'monthly', sources: { fred: 'CPIAUCNS', treasury: '10 Yr' } }),
      good(0, { sources: { fred: 'DGS10', treasury: '11 Yr' } }), good(0, { decimals: 9 }), good(0, { decimals: 1.5 }),
      good(0, { unit: '<b>' }),
    ];
    const r1 = api.validateRoster(bad);
    eq(r1.rows.length, 0, 'every bad row dropped');
    eq(r1.dropped, bad.length, 'every bad row counted');
    const r2 = api.validateRoster([good(1), good(1, { label: 'Dup' }), good(2)]);
    eq(r2.rows.map((r) => r.id), ['r1', 'r2'], 'dedupe by id');
    eq(r2.rows[0].label, 'Row 1', 'first occurrence wins');
    eq(r2.dropped, 1, 'duplicate counted');
    const r3 = api.validateRoster(Array.from({ length: 15 }, (_, i) => good(i)));
    eq([r3.rows.length, r3.dropped], [12, 3], 'capped at 12');
    const r4 = api.validateRoster([{ id: 'x', label: 'X', sources: { fred: 'cpiaucns' }, unit: 'K', transform: 'yoy', cadence: 'monthly' }]);
    eq([r4.rows[0].unit, r4.rows[0].fred, r4.rows[0].decimals], ['%', 'CPIAUCNS', 2], 'yoy unit is %, id upper-cased, default decimals');
    eq(api.validateRoster({ rows: [] }).rows.length, 0, 'an object is not a roster');
  }],

  ['roster: committed config == built-in default, both naming EXACTLY the 2 Yr / 10 Yr / 20 Yr Treasury columns; served rows follow it; junk config falls back', async (code) => {
    const { api } = boot(code);
    const tsy = (roster) => roster.filter((r) => r && r.sources && r.sources.treasury != null).map((r) => [r.id, r.sources.fred, r.sources.treasury]);
    eq(tsy(CONFIG), TSY_COLS, 'the committed roster names exactly the three yield Treasury columns, each on its own row and FRED spine, and no other');
    eq(api.DEFAULT_ROSTER, CONFIG, 'the built-in default IS the committed roster (same rows, same keys, same order)');
    eq(tsy(api.DEFAULT_ROSTER), TSY_COLS, 'so the fallback names the same three columns');
    const v = api.validateRoster(CONFIG);
    eq([v.dropped, v.rows.map((r) => [r.id, r.fred, r.treasury])], [0, [...TSY_COLS, ...OTHERS.map((id) => [id, CONFIG.find((r) => r.id === id).sources.fred, null])]],
      'all seven rows pass validation with their Treasury columns intact');
    const a = boot(code, { config: CONFIG });
    const ra = await a.call({ range: '1y' });
    const b = boot(code, { config: null });
    const rb = await b.call({ range: '1y' });
    eq(ra.json.roster, { source: 'config', count: 7, dropped: 0 }, 'committed config accepted whole');
    eq(rb.json.roster.source, 'default', 'unreachable config -> default');
    for (const [name, e] of [['committed config', a], ['built-in default', b]]) eq(e.fetchCount('home.treasury.gov'), 2, `${name}: the Treasury tail is ON (one fetch each for the current and previous NY month)`);
    eq(ra.json.rows.map((x) => [x.id, x.source]), [...YIELDS.map((id) => [id, 'treasury']), ...OTHERS.map((id) => [id, 'fred'])], 'the three yields are served from Treasury, the other four from FRED');
    eq(ra.json.rows, rb.json.rows, 'the committed config and the built-in default are the SAME roster');
    // The no-Treasury path is still a real path (a roster edit can drop a column): built explicitly, never taken from the shipped file.
    const f = boot(code, { config: fredOnly(CONFIG) });
    const rf = await f.call({ range: '1y' });
    eq(f.fetchCount('home.treasury.gov'), 0, 'a roster naming no Treasury column never calls Treasury');
    eq(rf.json.rows.map((x) => [x.id, x.source, x.status]), CONFIG.map((r) => [r.id, 'fred', 'ok']), 'and serves every row from FRED');
    eq(YIELDS.map((id) => row(rf, id).asOf), ['2026-09-28', '2026-09-28', '2026-09-28'], "the yields at FRED's newest (T-2 on the capture)");
    const c = boot(code, { config: [
      { id: 'ten', label: 'Ten', sources: { fred: 'DGS10' }, unit: '%', transform: 'level', cadence: 'daily', decimals: 2 },
      { id: 'bad', label: 'Bad', sources: { fred: 'DGS10' }, transform: 'level', cadence: 'yearly' },
      { id: 'cpi', label: 'CPI', sources: { fred: 'CPIAUCNS' }, transform: 'yoy', cadence: 'monthly', decimals: 1 },
    ] });
    const rc = await c.call();
    eq(rc.json.rows.map((r) => r.id), ['ten', 'cpi'], 'config rows served in order');
    eq(rc.json.roster, { source: 'config', count: 2, dropped: 1 }, 'drop reported');
    eq(c.calls.filter((x) => x.host === 'fred.stlouisfed.org').map((x) => new URL(x.url).searchParams.get('id')).sort(), ['CPIAUCNS', 'DGS10'], 'only the roster series are fetched');
    eq(c.fetchCount('home.treasury.gov'), 0, 'no Treasury call when no row wants it');
    const d = boot(code, { config: { rows: CONFIG } });
    eq((await d.call()).json.roster.source, 'default', 'an object wrapper is not a roster');
  }],

  ['YoY / MoM are computed POINT BY POINT on the real index (CPI index -> percent), holes never interpolated', async (code) => {
    const e = boot(code);
    const r = await e.call({ range: '5y' });
    for (const [id, fred] of [['cpi', 'CPIAUCNS'], ['pce', 'PCEPI'], ['corepce', 'PCEPILFE']]) {
      const x = row(r, id);
      const ref = refYoy(refObs(fred));
      const map = new Map(ref);
      eq(x.asOf, '2026-08-01', `${id} asOf`);
      eq(x.value, round(map.get('2026-08-01'), 1), `${id} value = Aug/Aug-1y`);
      eq(x.prevAsOf, '2026-07-01', `${id} prevAsOf`);
      eq(x.prev, round(map.get('2026-07-01'), 1), `${id} prev`);
      for (const [d, v] of x.points) near(v, map.get(d), 5e-5, `${id} point ${d} is the YoY of its own date`);
      eq(x.points.length, ref.filter(([d]) => d >= '2021-08-01').length, `${id} 5y holds every YoY point`);
      assert(x.points.every(([, v]) => Math.abs(v) < 15), `${id} is a percent line, not the index level`);
      eq(x.unit, '%', `${id} unit`);
    }
    const cpi = row(r, 'cpi');
    assert(!cpi.points.some(([d]) => d === '2025-10-01'), 'no CPI YoY for the missing 2025-10 observation');
    near(cpi.value, 3.4, 0.05, 'CPI YoY Aug-2026 on the real capture');
    const obs = e.api.parseFredCsv(FRED_TEXT.CPIAUCNS);
    const mom = e.api.transformSeries(obs, 'mom', 'monthly');
    const lv = new Map(obs);
    eq(mom.at(-1)[0], '2026-08-01', 'MoM newest');
    near(mom.at(-1)[1], (lv.get('2026-08-01') / lv.get('2026-07-01') - 1) * 100, 1e-9, 'MoM = Aug/Jul');
    assert(!mom.some(([d]) => d === '2025-10-01' || d === '2025-11-01'), 'MoM skips the hole and the month after it');
  }],

  ["committed roster (and the identical built-in default): Treasury newer than FRED wins the three yields with TODAY's close; tail stitched with no duplicate or out-of-order date", async (code) => {
    let e;
    for (const [name, config] of [['committed roster', CONFIG], ['built-in default', null]]) {
      e = boot(code, { config });
      const r = await e.call({ range: '1m' });
      eq([r.status, r.json.ok], [200, true], `${name}: HTTP 200`);
      for (const [id, v30, v29] of [['ust2y', 4.9, 4.95], ['ust10y', 5.21, 5.27], ['ust20y', 5.58, 5.63]]) {
        const x = row(r, id);
        // T0 is 18:00 EDT on 2026-09-30: today's close has posted, so asOf is TODAY
        eq([x.source, x.status, x.asOf, x.value, x.prevAsOf, x.prev, x.delta], ['treasury', 'ok', '2026-09-30', v30, '2026-09-29', v29, round(v30 - v29, 2)], `${name}: ${id}`);
        eq(x.points.at(-1), ['2026-09-30', v30], `${name}: ${id} chart ends on the Treasury print`);
        for (let i = 1; i < x.points.length; i++) assert(x.points[i - 1][0] < x.points[i][0], `${name}: ${id} strictly ascending, no duplicate`);
      }
      for (const id of OTHERS) eq([row(r, id).source, row(r, id).status], ['fred', 'ok'], `${name}: ${id} is FRED`);
    }
    const { api } = e;
    const spine = refObs('DGS10');
    const st = api.stitchTreasury(spine, [['2026-09-25', 5.17], ['2026-09-28', 5.24], ['2026-09-29', 5.27], ['2026-09-30', 5.21]]);
    eq([st.fromTreasury, st.obs.length, st.obs.at(-2), st.obs.at(-1)], [2, spine.length + 2, ['2026-09-29', 5.27], ['2026-09-30', 5.21]], 'stitch appends strictly newer only');
    eq(api.stitchTreasury(spine, [['2026-09-25', 5.22], ['2026-09-29', 5.27]]).fromTreasury, 0, 'disagreement on a shared date rejects the tail');
    eq(api.stitchTreasury(spine, [['2026-09-29', 5.27]]).fromTreasury, 0, 'no overlap = nothing to cross-check = not used');
    eq(api.stitchTreasury(spine, null).obs.length, spine.length, 'no tail = the spine');
  }],

  ["before Treasury has posted today's rate, the yields are the PRIOR business day's rate (a daily snapshot, never intraday)", async (code) => {
    // 10:00 EDT on 2026-09-30: Treasury's file ends on 09-29 (today's rate is not out yet); FRED's capture ends on 09-28
    const noToday = (m) => (TSY_TEXT[m]
      ? new Response(TSY_TEXT[m].split('\n').filter((l) => !l.startsWith('09/30/2026')).join('\n'), { status: 200 })
      : new Response('', { status: 404 }));
    const e = boot(code, { config: CONFIG, now: at('2026-09-30T14:00:00Z'), treasury: noToday });
    const r = await e.call({ range: '1m' });
    for (const [id, v29, v28] of [['ust2y', 4.95, 4.92], ['ust10y', 5.27, 5.24], ['ust20y', 5.63, 5.6]]) {
      const x = row(r, id);
      eq([x.source, x.status, x.asOf, x.value, x.prevAsOf, x.prev], ['treasury', 'ok', '2026-09-29', v29, '2026-09-28', v28], id);
    }
    for (const id of OTHERS) eq(row(r, id).source, 'fred', `${id} is FRED`);
  }],

  ['Treasury NOT newer than FRED -> FRED stays the source', async (code) => {
    const cut = (m) => new Response(TSY_TEXT[m].split('\n').filter((l) => !/^09\/(29|30)\/2026/.test(l)).join('\n'), { status: 200 });
    const e = boot(code, { treasury: (m) => (TSY_TEXT[m] ? cut(m) : new Response('', { status: 404 })) });
    const r = await e.call();
    for (const id of ['ust2y', 'ust10y', 'ust20y']) eq([row(r, id).source, row(r, id).asOf], ['fred', '2026-09-28'], id);
  }],

  ['Treasury outage (503, 403 block page, HTML on a 200, network error, TIMEOUT) on the committed roster -> all seven rows from FRED, HTTP 200, none missing', async (code) => {
    // A HUNG host: the fetch settles only when the function's own AbortSignal fires. The 3s guard
    // turns a fetch nobody bounds into a failed check instead of a suite that never ends.
    let aborted = 0, unbounded = false;
    const hang = (m, u, init) => new Promise((_, reject) => {
      const guard = setTimeout(() => { unbounded = true; reject(new Error('never aborted')); }, 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(guard); aborted++; reject(init.signal.reason); }, { once: true });
    });
    for (const [name, fn, extra] of [
      ['503', down(503)],
      ['403 block page', () => new Response('<html><head><title>Access Denied</title></head><body>Access Denied</body></html>', { status: 403 })],
      ['HTML on a 200', () => new Response('<html><body>Access Denied</body></html>', { status: 200 })],
      ['network', () => { throw new TypeError('connection reset'); }],
      ['timeout', hang, { timeoutScale: 0.01 }],
    ]) {
      const e = boot(code, { config: CONFIG, treasury: fn, ...extra });
      const r = await e.call();
      eq([r.status, r.json.ok, r.json.stale, r.json.rows.length], [200, true, false, 7], `${name}: HTTP 200, ok, nothing stale, seven rows`);
      eq(e.fetchCount('home.treasury.gov'), 2, `${name}: Treasury was asked (the committed roster wants it)`);
      for (const x of r.json.rows) {
        eq([x.id, x.status, x.source, x.value === null], [x.id, 'ok', 'fred', false], `${name}: ${x.id} served from FRED, not missing`);
      }
      for (const id of YIELDS) eq(row(r, id).asOf, '2026-09-28', `${name}: ${id} at FRED's newest`);
      eq(row(r, 'ust10y').value, 5.24, `${name}: FRED's newest 10Y`);
    }
    eq([aborted, unbounded], [2, false], 'the hung Treasury host was cut off by its AbortSignal (both months), never left hanging');
  }],

  ['Treasury garbage (mislabelled columns) fails the FRED agreement check; the good column still serves', async (code) => {
    const swapped = (m) => new Response(TSY_TEXT[m].replace('"10 Yr","20 Yr"', '"20 Yr","10 Yr"'), { status: 200 });
    const e = boot(code, { treasury: (m) => (TSY_TEXT[m] ? swapped(m) : new Response('', { status: 404 })) });
    const r = await e.call();
    eq([row(r, 'ust10y').source, row(r, 'ust10y').asOf, row(r, 'ust10y').value], ['fred', '2026-09-28', 5.24], '10Y rejected');
    eq([row(r, 'ust20y').source, row(r, 'ust20y').asOf], ['fred', '2026-09-28'], '20Y rejected');
    eq([row(r, 'ust2y').source, row(r, 'ust2y').asOf], ['treasury', '2026-09-30'], '2Y (correct column) still Treasury');
  }],

  ['partial failure degrades ONE row; Treasury is never served without a FRED spine; missing is null, never 0', async (code) => {
    const e = boot(code, { fred: { DGS20: down(500) } });
    const r = await e.call({ range: '6m' });
    eq([r.status, r.json.ok], [200, true], 'the response survives');
    const x = row(r, 'ust20y');
    eq([x.status, x.value, x.prev, x.delta, x.asOf, x.prevAsOf, x.source, x.points, x.changed], ['missing', null, null, null, null, null, null, [], false], 'ust20y missing, all null');
    for (const y of r.json.rows.filter((z) => z.id !== 'ust20y')) eq(y.status, 'ok', `${y.id} unaffected`);
    const h = boot(code, { fred: { DGS10: () => new Response('<!DOCTYPE html>', { status: 200 }) } });
    const rh = await h.call();
    eq([row(rh, 'ust10y').status, row(rh, 'ust10y').value], ['missing', null], 'HTML body from FRED = missing, even with a Treasury tail on offer');
    const one = boot(code, { fred: { UNRATE: () => new Response('observation_date,UNRATE\n2026-08-01,4.1\n', { status: 200 }) } });
    const u = row(await one.call(), 'unrate');
    eq([u.status, u.value, u.prev, u.delta, u.prevAsOf, u.points, 'pointsNote' in u], ['ok', 4.1, null, null, null, [], false], 'one observation: value, no prev, no delta, no chart');
  }],

  ['total failure on a cold isolate -> HTTP 502 JSON ok:false, every value null', async (code) => {
    const all = Object.fromEntries(FRED_IDS.map((id) => [id, down(503)]));
    const e = boot(code, { fred: all, treasury: down(503) });
    const r = await e.call();
    eq([r.status, r.json.ok, typeof r.json.error], [502, false, 'string'], '502 ok:false with an error');
    eq(r.headers.get('access-control-allow-origin'), SITE, 'still CORS');
    for (const x of r.json.rows) eq([x.status, x.value, x.prev, x.delta, x.points], ['missing', null, null, null, []], x.id);
    eq(r.json.refreshInSec, 60, 'a dead feed is retried at the release-window cadence (min of 60s and the 2 min degraded cap)');
    e.clock.now += 30_000;
    const again = await e.call();
    eq([again.status, again.json.ok, e.fetchCount('fred.stlouisfed.org')], [502, false, 7], 'the cached failure is still a 502, and costs no upstream call');
  }],

  ['stale-while-error: a failed series keeps its last good values, flagged stale with its age', async (code) => {
    const e = boot(code);
    const r1 = await e.call({ range: '1m' });
    const before = row(r1, 'ust10y');
    e.clock.now += 120_000;
    e.opts.fred = { DGS10: down(503) };
    const r2 = await e.call({ range: '1m' });
    const x = row(r2, 'ust10y');
    eq([r2.status, r2.json.ok], [200, true], 'still served');
    eq([x.status, x.value, x.asOf, x.staleSec], ['stale', before.value, before.asOf, 120], 'stale row keeps value + asOf, with its age');
    eq(x.points, before.points, 'stale row keeps its chart');
    eq([r2.json.stale, r2.json.staleSec], [true, 120], 'top-level stale flag + age');
    for (const y of r2.json.rows.filter((z) => z.id !== 'ust10y')) eq([y.status, y.staleSec], ['ok', null], `${y.id} fresh`);
    assert(r2.json.refreshInSec <= 120, 'a degraded feed asks again soon');
    const f = boot(code);
    await f.call();
    f.clock.now += 120_000;
    f.throwOnWarn = true; // a refresh that THROWS part-way (the catch path)
    f.opts.fred = { DGS2: down(503) };
    const r3 = await f.call({ range: '1m' });
    eq([r3.status, r3.json.ok, r3.json.stale], [200, true, true], 'a thrown refresh serves the last good body, flagged');
    assert(r3.json.rows.every((z) => z.status === 'stale' && z.value !== null), 'every row flagged stale, none blanked');
    const g = boot(code);
    g.throwOnWarn = true;
    g.opts.fred = { DGS2: down(503) };
    const r4 = await g.call();
    eq([r4.status, r4.json.ok, typeof r4.json.error], [502, false, 'string'], 'a cold thrown refresh is JSON 502');
  }],

  ['release windows on the New_York wall clock, incl. both 2026 DST switches', async (code) => {
    const { api } = boot(code);
    const cases = [
      ['2026-09-30T12:30:00Z', 'release', 60], // Wed 08:30 EDT
      ['2026-09-30T12:24:59Z', 'quiet', 1], // 08:24:59 -> the window opens in 1s
      ['2026-09-30T12:20:00Z', 'quiet', 300], // 08:20 -> clamped to the 08:25 opening
      ['2026-09-30T13:14:59Z', 'release', 60], // 09:14:59
      ['2026-09-30T13:15:00Z', 'quiet', 900], // 09:15 end is exclusive
      ['2026-09-30T19:25:00Z', 'release', 60], // 15:25
      ['2026-09-30T22:29:59Z', 'release', 60], // 18:29:59
      ['2026-09-30T22:30:00Z', 'quiet', 900], // 18:30
      ['2026-10-03T12:30:00Z', 'weekend', 3600], // Saturday
      ['2026-03-06T13:30:00Z', 'release', 60], // Fri 08:30 EST (UTC-5)
      ['2026-03-06T12:30:00Z', 'quiet', 900], // Fri 07:30 EST
      ['2026-03-08T12:30:00Z', 'weekend', 3600], // Sun: DST starts
      ['2026-03-09T12:30:00Z', 'release', 60], // Mon 08:30 EDT (UTC-4) — a fixed EST offset reads 07:30
      ['2026-03-09T13:30:00Z', 'quiet', 900], // Mon 09:30 EDT, after the 09:15 close — fixed EST reads 08:30
      ['2026-11-01T13:30:00Z', 'weekend', 3600], // Sun: DST ends
      ['2026-11-02T13:30:00Z', 'release', 60], // Mon 08:30 EST — a fixed EDT offset reads 09:30
      ['2026-11-02T12:30:00Z', 'quiet', 900], // Mon 07:30 EST
      ['2026-10-30T12:30:00Z', 'release', 60], // Fri 08:30 EDT
    ];
    for (const [iso, phase, sec] of cases) {
      const p = api.refreshPolicy(at(iso));
      eq([p.phase, p.ttlMs / 1000], [phase, sec], iso);
    }
    const q = boot(code, { now: at('2026-09-30T13:20:00Z') });
    eq([(await q.call()).json.refreshInSec, (await q.call()).json.phase], [900, 'quiet'], 'quiet weekday through the handler');
    const w = boot(code, { now: at('2026-10-03T16:00:00Z') });
    eq([(await w.call()).json.refreshInSec, (await w.call()).json.phase], [3600, 'weekend'], 'weekend heartbeat through the handler');
    const d = boot(code, { now: at('2026-03-09T12:30:00Z') });
    eq((await d.call()).json.refreshInSec, 60, 'DST Monday 08:30 EDT through the handler');
    const o = boot(code, { now: at('2026-09-30T12:20:00Z') });
    eq((await o.call()).json.refreshInSec, 300, 'the client is told to come back at the window opening');
  }],

  ['response shape matches the contract exactly', async (code) => {
    const e = boot(code);
    const r = await e.call({ range: '3m' });
    const j = r.json;
    assert(!/NaN|Infinity/.test(r.text), 'no NaN / Infinity anywhere in the body');
    eq(r.headers.get('content-type'), 'application/json', 'JSON');
    eq(Object.keys(j).sort(), ['fetchedAt', 'generatedAt', 'ok', 'phase', 'range', 'refreshInSec', 'roster', 'rows', 'stale', 'staleSec'], 'top-level keys');
    assert(j.ok === true && !Number.isNaN(Date.parse(j.generatedAt)) && !Number.isNaN(Date.parse(j.fetchedAt)), 'ok + ISO stamps');
    assert(j.range === '3m' && Number.isInteger(j.refreshInSec) && j.refreshInSec >= 30, 'range + refreshInSec');
    assert(['release', 'quiet', 'weekend'].includes(j.phase) && j.stale === false && j.staleSec === null, 'phase + stale');
    eq(j.rows.map((x) => x.id), ['ust2y', 'ust10y', 'ust20y', 'unrate', 'cpi', 'pce', 'corepce'], 'default roster order');
    const KEYS = ['asOf', 'cadence', 'changed', 'decimals', 'delta', 'id', 'label', 'points', 'prev', 'prevAsOf', 'source', 'staleSec', 'status', 'transform', 'unit', 'value'];
    for (const x of j.rows) {
      eq(Object.keys(x).filter((k) => k !== 'pointsNote').sort(), KEYS, `${x.id} keys`);
      assert(typeof x.label === 'string' && x.label.length <= 12, `${x.id} label <= 12`);
      assert(Number.isInteger(x.decimals) && ['daily', 'weekly', 'monthly', 'quarterly'].includes(x.cadence), `${x.id} decimals/cadence`);
      assert(['ok', 'stale', 'missing'].includes(x.status) && ['treasury', 'fred', null].includes(x.source), `${x.id} enums`);
      assert(x.status !== 'ok' || (Number.isFinite(x.value) && ISO.test(x.asOf) && x.source !== null), `${x.id} ok => a real value`);
      for (const k of ['value', 'prev', 'delta']) assert(x[k] === null || Number.isFinite(x[k]), `${x.id}.${k} number or null`);
      assert(x.prev === null || x.delta === round(x.value - x.prev, x.decimals), `${x.id} delta = value - prev in the row's unit`);
      assert(x.value === null || x.value === round(x.value, x.decimals), `${x.id} value rounded to decimals`);
      assert(ISO.test(x.prevAsOf) && x.prevAsOf < x.asOf, `${x.id} prevAsOf before asOf`);
      assert(Array.isArray(x.points) && x.points.every((p) => p.length === 2 && ISO.test(p[0]) && Number.isFinite(p[1])), `${x.id} points are [date, number]`);
      assert(!('pointsNote' in x) || typeof x.pointsNote === 'string', `${x.id} pointsNote is a string when present`);
    }
  }],

  ['single-flight: 8 concurrent cold calls -> ONE upstream fetch per series', async (code) => {
    const e = boot(code);
    const rs = await Promise.all(['1w', '1m', '3m', '6m', '1y', '5y', '3m', '1m'].map((range) => e.call({ range })));
    assert(rs.every((r) => r.status === 200 && r.json.ok), 'all served');
    for (const id of FRED_IDS) eq(e.fetchCount('fred.stlouisfed.org', (c) => new URL(c.url).searchParams.get('id') === id), 1, `FRED ${id} fetched once`);
    eq(e.fetchCount('home.treasury.gov'), 2, 'Treasury: one fetch per month (current + previous) — the three yield rows share ONE file');
    eq(e.fetchCount('akyachtsman.github.io'), 1, 'config fetched once');
    eq(new Set(rs.map((r) => r.json.fetchedAt)).size, 1, 'all eight share one sweep');
  }],

  ['range allowlist: unknown tokens degrade to 3m; every valid range is echoed', async (code) => {
    const e = boot(code);
    for (const bad of ['bogus', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 5, null, '1D', ' 1y', ['1y']]) {
      const r = await e.call({ range: bad });
      eq([r.status, r.json.range], [200, '3m'], `range ${JSON.stringify(bad)}`);
    }
    eq((await e.call({})).json.range, '3m', 'no range');
    eq((await e.call('{not json')).json.range, '3m', 'unparseable body');
    for (const ok of ['1w', '1m', '3m', '6m', '1y', '5y']) eq((await e.call({ range: ok })).json.range, ok, ok);
  }],

  ['another span is a SLICE: no extra upstream call, and the windows really differ', async (code) => {
    const e = boot(code);
    await e.call({ range: '3m' });
    const n = e.calls.length;
    const by = {};
    for (const range of ['1w', '1m', '3m', '6m', '1y', '5y']) by[range] = row(await e.call({ range }), 'ust10y').points;
    eq(e.calls.length, n, 'no upstream call for any other range');
    assert(by['1w'].length < by['1m'].length && by['1m'].length < by['3m'].length && by['3m'].length < by['6m'].length, 'spans grow');
    assert(by['1y'][0][0] < by['6m'][0][0] && by['5y'][0][0] < by['1y'][0][0], 'longer spans start earlier');
    eq(by['1w'].map((p) => p[0]), ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30'], '1W = the last business week (start inclusive)');
  }],

  ['points: oldest first, <= 120, first/last of the span kept, extremes kept, every point real', async (code) => {
    const e = boot(code);
    for (const range of ['1w', '1m', '3m', '6m', '1y', '5y']) {
      const r = await e.call({ range });
      for (const x of r.json.rows) {
        const ref = REF[x.id]();
        const map = new Map(ref);
        const start = refStart(ref.at(-1)[0], range);
        let span = ref.filter(([d]) => d >= start);
        if (span.length < 6) span = ref.slice(-6);
        const P = x.points, tag = `${x.id} ${range}`;
        assert(P.length <= 120 && P.length >= 2, `${tag} 2..120 points (got ${P.length})`);
        for (let i = 1; i < P.length; i++) assert(P[i - 1][0] < P[i][0], `${tag} strictly oldest-first`);
        for (const [d, v] of P) assert(map.has(d) && Math.abs(map.get(d) - v) <= 5e-5, `${tag} ${d} is a real observation`);
        eq(P[0][0], span[0][0], `${tag} first point kept`);
        eq(P.at(-1)[0], span.at(-1)[0], `${tag} last point kept`);
        const vals = span.map((p) => p[1]);
        for (const ext of [Math.min(...vals), Math.max(...vals)]) assert(P.some(([, v]) => Math.abs(v - ext) <= 5e-5), `${tag} extreme ${ext} kept`);
        if (span.length <= 120) eq(P.length, span.length, `${tag} nothing dropped when it fits`);
      }
    }
    const big = row(await e.call({ range: '5y' }), 'ust10y');
    eq(big.points.length, 120, '5Y of daily yields is downsampled to exactly 120');
  }],

  ['fewer than 6 observations in the span -> the 6 latest + pointsNote; <2 in total -> no chart', async (code) => {
    const e = boot(code);
    for (const range of ['1w', '1m', '3m']) {
      const r = await e.call({ range });
      for (const id of ['unrate', 'cpi', 'pce', 'corepce']) {
        const x = row(r, id);
        eq([x.points.length, x.pointsNote], [6, 'monthly - 6 latest'], `${id} ${range}`);
        eq(x.points.map((p) => p[0]), REF[id]().slice(-6).map((p) => p[0]), `${id} ${range} = the 6 latest`);
      }
      assert(!('pointsNote' in row(r, 'ust10y')), `ust10y ${range}: a real span, no note`);
    }
    const r6 = await e.call({ range: '6m' });
    eq([row(r6, 'unrate').points.length, 'pointsNote' in row(r6, 'unrate')], [7, false], '6M of a monthly row is a real span');
    const { api } = e;
    const holidayWeek = [['2026-06-26', 1], ['2026-06-29', 2], ['2026-06-30', 3], ['2026-07-01', 4], ['2026-07-02', 5], ['2026-07-06', 6]];
    const hw = api.pointsFor(holidayWeek, '1w', 'daily');
    eq([hw.points.length, hw.note], [6, 'daily - 6 latest'], 'a 5-observation holiday week falls back and says so');
    eq(api.pointsFor([['2026-08-01', 1], ['2026-09-01', 2], ['2026-10-01', 3]], '1y', 'monthly'), { points: [['2026-08-01', 1], ['2026-09-01', 2], ['2026-10-01', 3]], note: 'monthly - 3 latest' }, 'short history: what exists, labelled');
    eq(api.pointsFor([['2026-08-01', 1]], '1y', 'monthly'), { points: [], note: null }, 'one observation: no chart');
  }],

  ['changed: false on a cold isolate, true only when the newest observation moves', async (code) => {
    const e = boot(code, { treasury: down(503) });
    const r1 = await e.call();
    assert(r1.json.rows.every((x) => x.changed === false), 'cold isolate says false');
    eq(row(r1, 'ust10y').asOf, '2026-09-28', 'FRED while Treasury is down');
    e.clock.now += 11 * 60_000; // past the Treasury back-off
    e.opts.treasury = undefined;
    const r2 = await e.call();
    eq(['ust2y', 'ust10y', 'ust20y'].map((id) => [row(r2, id).asOf, row(r2, id).changed]), [['2026-09-30', true], ['2026-09-30', true], ['2026-09-30', true]], 'the Treasury print is a change');
    assert(['unrate', 'cpi', 'pce', 'corepce'].every((id) => row(r2, id).changed === false), 'unchanged rows say false');
    e.clock.now += 120_000;
    const r3 = await e.call();
    assert(r3.json.rows.every((x) => x.changed === false), 'the next refresh with nothing new says false');
  }],

  ['CORS origin allowlist, methods, and JSON on every path', async (code) => {
    const e = boot(code);
    const ok = await e.call();
    eq([ok.status, ok.headers.get('access-control-allow-origin'), ok.headers.get('vary')], [200, SITE, 'Origin'], 'site origin echoed');
    const evil = await e.call({}, { origin: 'https://evil.example' });
    eq([evil.status, evil.json?.ok, evil.headers.get('access-control-allow-origin')], [403, false, null], 'foreign origin refused, no ACAO');
    const none = await e.call({}, { origin: null });
    eq([none.status, none.json?.ok], [403, false], 'no origin refused');
    const pre = await e.call(undefined, { method: 'OPTIONS' });
    eq([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-methods')], [200, SITE, 'POST, OPTIONS'], 'preflight');
    const get = await e.call(undefined, { method: 'GET' });
    eq([get.status, get.json?.ok], [405, false], 'GET is 405 JSON');
    const f = boot(code);
    await f.call({}, { origin: 'https://evil.example' });
    eq(f.calls.length, 0, 'a refused origin costs no upstream call');
  }],

  ['outbound hygiene: every fetch is bounded by an AbortSignal, carries the UA, no Supabase key, known hosts only', async (code) => {
    const e = boot(code);
    await e.call({ range: '5y' });
    assert(e.calls.length === 10, `the committed roster's first sweep: 7 FRED + 2 Treasury (current + previous NY month) + 1 config (got ${e.calls.length})`);
    for (const c of e.calls) {
      assert(c.init.signal instanceof AbortSignal, `${c.host}: AbortSignal`);
      const h = new Headers(c.init.headers);
      assert(/desk econ/.test(h.get('user-agent') || ''), `${c.host}: UA`);
      assert(!h.has('apikey') && !h.has('authorization'), `${c.host}: no key sent upstream`);
      assert(['fred.stlouisfed.org', 'home.treasury.gov', 'akyachtsman.github.io'].includes(c.host), `host ${c.host}`);
    }
    const fred = e.calls.filter((c) => c.host === 'fred.stlouisfed.org').map((c) => new URL(c.url).searchParams.get('cosd'));
    eq([...new Set(fred)], [COSD_T0], 'FRED history starts 76 months back (5y + YoY base + lag)');
    eq(e.calls.filter((c) => c.host === 'home.treasury.gov').map((c) => new URL(c.url).searchParams.get('field_tdr_date_value_month')).sort(), ['202608', '202609'], 'Treasury: current + previous NY month');
  }],

  ['force is honoured at most once per 30s; Treasury backs off after a failure and a kept print never flips back', async (code) => {
    const e = boot(code);
    await e.call();
    const n = e.calls.length;
    e.clock.now += 10_000;
    await e.call({ force: true });
    await e.call({ force: true });
    eq(e.calls.length, n + 9, 'first force re-sweeps every series (7 FRED + 2 Treasury, the committed roster; the roster itself is cached 1h)');
    e.clock.now += 10_000;
    await e.call({ force: true });
    eq(e.calls.length, n + 9, 'a second force inside 30s is a cached read');
    e.clock.now += 25_000;
    await e.call({ force: true });
    eq(e.calls.length, n + 18, 'honoured again once 30s have passed');
    const b = boot(code, { treasury: down(503) });
    await b.call();
    eq(b.fetchCount('home.treasury.gov'), 2, 'tried once');
    b.clock.now += 120_000;
    await b.call();
    eq(b.fetchCount('home.treasury.gov'), 2, 'backing off');
    b.clock.now += 9 * 60_000;
    await b.call();
    eq(b.fetchCount('home.treasury.gov'), 4, 'retried after 10 min');
    const k = boot(code);
    eq(row(await k.call(), 'ust10y').asOf, '2026-09-30', 'Treasury print');
    k.clock.now += 120_000;
    k.opts.treasury = down(503);
    const kept = row(await k.call(), 'ust10y');
    eq([kept.asOf, kept.source, kept.value, kept.status], ['2026-09-30', 'treasury', 5.21, 'ok'], 'a failed Treasury fetch keeps the validated print (no flip back to T-2)');
  }],

  ['a degraded feed retries fast even in a quiet period', async (code) => {
    const e = boot(code, { now: at('2026-09-30T13:20:00Z'), fred: { DGS20: down(503) } });
    const r = await e.call();
    eq(r.json.refreshInSec, 120, 'degraded -> 2 min, not the 15 min quiet TTL');
    const n = e.fetchCount('fred.stlouisfed.org');
    e.clock.now += 121_000;
    await e.call();
    eq(e.fetchCount('fred.stlouisfed.org'), n + 7, 'and actually retried');
  }],
];

async function runSuite(code, { verbose = false } = {}) {
  const failures = [];
  for (const [name, fn] of TESTS) {
    try {
      await fn(code);
      if (verbose) console.log(`  ok    ${name}`);
    } catch (e) {
      failures.push({ name, error: e });
      if (verbose) console.log(`  FAIL  ${name}\n        ${e instanceof Fail ? e.message : e.stack}`);
    }
  }
  return failures;
}

// ── mutants: each a SINGLE-LINE edit of the TypeScript source ─────────────────
// `find` must occur EXACTLY once, so a mutant can never silently mutate nothing
// after the source drifts (that is reported as INVALID, which fails the run).
const MUTANTS = [
  ['"." read as 0', "const v = raw === '' || raw === '.' ? NaN : Number(raw);", "const v = raw === '.' ? 0 : Number(raw);"],
  ['empty FRED field read as 0 (the Number("") trap)', "const v = raw === '' || raw === '.' ? NaN : Number(raw);", "const v = raw === '.' ? NaN : Number(raw);"],
  ['YoY off by one month', "const back = transform === 'yoy' ? -12 : -1;", "const back = transform === 'yoy' ? -11 : -1;"],
  ['prefer FRED over a newer Treasury print', 'if (!newer.length) return { obs: spine, fromTreasury: 0, reason: null };', 'if (newer.length) return { obs: spine, fromTreasury: 0, reason: null };'],
  ['TTL ignores DST (fixed EST offset)', "timeZone: 'America/New_York', weekday: 'short',", "timeZone: 'Etc/GMT+5', weekday: 'short',"],
  ['NaN leaks from a Treasury N/A', 'if (!Number.isFinite(v) || v < -5 || v > 30) continue;', 'if (v < -5 || v > 30) continue;'],
  ['single-flight removed', 'inflight ??= refresh().finally(() => { inflight = null; });', 'inflight = refresh().finally(() => { inflight = null; });'],
  ['range allowlist admits prototype keys', 'typeof raw === \'string\' && Object.hasOwn(RANGES, raw) ? raw : DEFAULT_RANGE;', "typeof raw === 'string' && raw in RANGES ? raw : DEFAULT_RANGE;"],
  ['downsample drops the newest point', 'const keep = new Set<number>([0, n - 1]);', 'const keep = new Set<number>([0]);'],
  ['points newest-first', 'return [...keep].sort((a, b) => a - b).map((i) => pts[i]);', 'return [...keep].sort((a, b) => b - a).map((i) => pts[i]);'],
  ['<6 rule weakened to <2', 'if (slice.length < MIN_POINTS) {', 'if (slice.length < 2) {'],
  ['missing value rendered as 0', 'const value = last ? roundTo(last[1], r.decimals) : null;', 'const value = last ? roundTo(last[1], r.decimals) : 0;'],
  ['stale row reported as ok', "status: freshNow ? 'ok' : 'stale',", "status: 'ok',"],
  ['a failed fetch discards the last good history', 'console.warn(`desk-econ: FRED ${id} failed: ${msg(e)}`);', 'fredStore.delete(id); console.warn(`desk-econ: FRED ${id} failed: ${msg(e)}`);'],
  ['Treasury/FRED agreement check disabled', 'if (Math.abs(f - v) > TREASURY_TOL) return', 'if (Math.abs(f - v) > 99) return'],
  ['cold isolate claims changed', 'changed: before !== undefined && before !== key,', 'changed: before !== key,'],
  ['roster cap off by one', 'if (!r || seen.has(r.id) || rows.length >= MAX_ROWS) { dropped++; continue; }', 'if (!r || seen.has(r.id) || rows.length > MAX_ROWS) { dropped++; continue; }'],
  ['roster dedupe removed', 'if (!r || seen.has(r.id) || rows.length >= MAX_ROWS) { dropped++; continue; }', 'if (!r || rows.length >= MAX_ROWS) { dropped++; continue; }'],
  ['Sunday polled like a weekday', "if (w.dow === 'Sat' || w.dow === 'Sun') return { phase: 'weekend', ttlMs: WEEKEND_TTL_MS };", "if (w.dow === 'Sat') return { phase: 'weekend', ttlMs: WEEKEND_TTL_MS };"],
  ['quiet TTL sleeps through a window opening', 'if (win.from > w.sec) { ttl = Math.min(ttl, (win.from - w.sec) * 1000); break; }', 'if (win.from > w.sec) { break; }'],
  ['future-dated Treasury row accepted (day/month swap)', 'if (!d || d > today) continue;', 'if (!d) continue;'],
  ['force never throttled', 'if (now - lastForceAt >= FORCE_MIN_GAP_MS) { stampedFrom = lastForceAt; lastForceAt = now; }', 'if (true) { stampedFrom = lastForceAt; lastForceAt = now; }'],
  ['history one year short (5Y loses its YoY base)', 'const HISTORY_MONTHS = 76;', 'const HISTORY_MONTHS = 64;'],
  ['origin allowlist bypassed', 'const allowed = ALLOWED_ORIGINS.has(origin);', 'const allowed = true;'],
  ['delta not rounded (float noise on the wire)', 'const delta = value !== null && prevV !== null ? roundTo(value - prevV, r.decimals) : null;', 'const delta = value !== null && prevV !== null ? value - prevV : null;'],
  ['a dead feed answers HTTP 200', 'const send = (out: ReturnType<typeof shape>) => reply(out.ok ? 200 : 502, out, cors);', 'const send = (out: ReturnType<typeof shape>) => reply(200, out, cors);'],
  ['degraded feed waits the full quiet TTL','const ttl = degraded ? Math.min(policy.ttlMs, DEGRADED_TTL_MS) : policy.ttlMs;', 'const ttl = policy.ttlMs;'],
  ['built-in default re-blanks the 10Y Treasury column (the fallback silently goes FRED-only)', "sources: { fred: 'DGS10', treasury: '10 Yr' }", "sources: { fred: 'DGS10' }"],
  ['built-in default names the wrong tenor on the 20Y row', "sources: { fred: 'DGS20', treasury: '20 Yr' }", "sources: { fred: 'DGS20', treasury: '30 Yr' }"],
  ['Treasury never fetched although rows name a column', 'roster.rows.some((r) => r.treasury) ? refreshTreasury(now, today) : Promise.resolve(),', 'Promise.resolve(),'],
  ['Treasury fetched although no row names a column', 'roster.rows.some((r) => r.treasury) ? refreshTreasury(now, today) : Promise.resolve(),', 'refreshTreasury(now, today),'],
  ['a Treasury tail sharing no date with FRED is trusted', "if (!overlap) return { obs: spine, fromTreasury: 0, reason: 'treasury: no overlap with FRED to cross-check' };", "if (overlap < 0) return { obs: spine, fromTreasury: 0, reason: 'treasury: no overlap with FRED to cross-check' };"],
  ['upstream fetch left unbounded (a hung Treasury host hangs the sweep)', 'const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });', 'const res = await fetch(url, { headers: UA });'],
];

// ...and each damage to the SHIPPED roster (config/econ-indicators.json, the file the live function
// reads from Pages) must be caught as well. Applied to a copy; a damage that changes nothing is INVALID.
const byId = (c, id) => { const r = c.find((x) => x.id === id); if (!r) throw new Error(`no row ${id}`); return r; };
const CONFIG_MUTANTS = [
  ['shipped roster re-blanks the 2Y Treasury column', (c) => { delete byId(c, 'ust2y').sources.treasury; }],
  ['shipped roster names the 30 Yr column on the 20Y row', (c) => { byId(c, 'ust20y').sources.treasury = '30 Yr'; }],
  ['shipped roster swaps the 2Y and 10Y columns', (c) => { byId(c, 'ust2y').sources.treasury = '10 Yr'; byId(c, 'ust10y').sources.treasury = '2 Yr'; }],
];

// The esbuild pinned (exact version + integrity hash) in tools/package.json and its lockfile — NOT
// `npx -y esbuild`, which fetched whatever release was current and failed outright offline.
const ESBUILD = path.join(ROOT, 'tools/node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
function transpile(ts) {
  const r = spawnSync(ESBUILD, ['--loader=ts', '--format=cjs', '--log-level=error'],
    { input: ts, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error && r.error.code === 'ENOENT') throw new Error('the pinned esbuild is not installed — run: npm ci --prefix tools');
  if (r.status !== 0) throw new Error('esbuild failed: ' + (r.stderr || r.error || 'unknown'));
  return r.stdout;
}

const src = readFileSync(SRC, 'utf8');
const CODE = transpile(src);
console.log('desk-econ checks — suite against the committed source');
const failures = await runSuite(CODE, { verbose: true });
console.log(`\n${TESTS.length - failures.length}/${TESTS.length} checks passed`);
let exit = failures.length ? 1 : 0;

if (process.argv.includes('--mutants')) {
  const total = MUTANTS.length + CONFIG_MUTANTS.length;
  console.log(`\nmutants (${total}: ${MUTANTS.length} of the source, ${CONFIG_MUTANTS.length} of the shipped roster) — each must be CAUGHT by at least one check`);
  let killed = 0;
  for (const [name, find, repl] of MUTANTS) {
    const n = src.split(find).length - 1;
    if (n !== 1) { console.log(`  INVALID   ${name} (anchor found ${n}x)`); exit = 1; continue; }
    const f = await runSuite(transpile(src.replace(find, () => repl)));
    if (f.length) { killed++; console.log(`  caught    ${name}  <- ${f[0].name}`); }
    else { console.log(`  SURVIVED  ${name}`); exit = 1; }
  }
  for (const [name, damage] of CONFIG_MUTANTS) {
    const shipped = CONFIG;
    const bad = structuredClone(shipped);
    let applied = true;
    try { damage(bad); } catch { applied = false; }
    if (!applied || JSON.stringify(bad) === JSON.stringify(shipped)) { console.log(`  INVALID   ${name} (the damage changed nothing)`); exit = 1; continue; }
    CONFIG = bad;
    let f;
    try { f = await runSuite(CODE); } finally { CONFIG = shipped; }
    if (f.length) { killed++; console.log(`  caught    ${name}  <- ${f[0].name}`); }
    else { console.log(`  SURVIVED  ${name}`); exit = 1; }
  }
  console.log(`\nmutants caught: ${killed}/${total}`);
}
process.exit(exit);
