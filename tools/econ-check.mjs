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
     treasury-2026MM.csv  CONSTRUCTED from Treasury's par-yield CSV layout (quoted
                      header names incl. "1.5 Month", MM/DD/YYYY, newest first).
                      2 Yr / 10 Yr / 20 Yr copy the FRED capture on shared dates; the
                      09/29 and 09/30/2026 rows are SYNTHETIC (they differ from the
                      real ones below, on purpose: the suite must not depend on them).
     treasury-real-20260930-head.csv  the REAL header and three newest rows of the
                      live file, fetched FROM SUPABASE on 2026-10-01 by the throwaway
                      desk-probe (this sandbox cannot reach home.treasury.gov). The
                      layout matched the parser, and 09/28 equals the FRED capture.
   The Treasury tail is ON in the shipped roster (2Y/10Y/20Y, owner request
   2026-09-30). Every desk-econ request runs on a FRESH instance (measured
   2026-10-01), so the validated Treasury rows live in the shared table
   desk_feed_cache (`econ:treasury`). Here that table is `fakeDb()`: a stateful
   in-memory PostgREST stand-in behind the stubbed fetch (GET ?select=at,payload
   &key=eq.…, POST ?on_conflict=key with Prefer: resolution=merge-duplicates),
   which also plays the gateway's 401 for a browser-shaped user-agent carrying the
   secret key. One fakeDb passed to several boot()s = several cold instances
   sharing one database; a boot() without one gets a fresh, empty table. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'supabase/functions/desk-econ/index.ts');
const FIX = path.join(ROOT, 'tools/fixtures/econ');
const SITE = 'https://akyachtsman.github.io';
// Deno.env as the harness sets it. Not a real key, and deliberately not secret-shaped.
const DB_URL = 'https://db.supabase.test';
const DB_HOST = new URL(DB_URL).hostname;
const SERVICE_KEY = 'test-service-role-key';
const DENO_ENV = { SUPABASE_URL: DB_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const T0 = Date.parse('2026-09-30T22:00:00Z'); // Wed 18:00 EDT — inside the Treasury window
const COSD_T0 = '2020-05-30';                  // 76 months before 2026-09-30 (NY)
const FRED_IDS = ['DGS2', 'DGS10', 'DGS20', 'UNRATE', 'CPIAUCNS', 'PCEPI', 'PCEPILFE'];
const FRED_TEXT = Object.fromEntries(FRED_IDS.map((id) => [id, readFileSync(path.join(FIX, `fred-${id}.csv`), 'utf8')]));
const TSY_TEXT = Object.fromEntries(['202608', '202609'].map((m) => [m, readFileSync(path.join(FIX, `treasury-${m}.csv`), 'utf8')]));
const TSY_REAL = readFileSync(path.join(FIX, 'treasury-real-20260930-head.csv'), 'utf8');
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
// Fails (instead of hanging the suite) when `p` has not settled within `ms` of REAL time.
async function within(p, ms, m) {
  let t;
  const late = new Promise((_, reject) => { t = setTimeout(() => reject(new Fail(`${m} (nothing within ${ms} ms)`)), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(t); }
}

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
// Treasury before today's rate has posted: the fixture without its 09/30 row.
const noTodayTsy = (m) => (TSY_TEXT[m]
  ? new Response(TSY_TEXT[m].split('\n').filter((l) => !l.startsWith('09/30/2026')).join('\n'), { status: 200 })
  : new Response('Not Found', { status: 404 }));
// A host that answers after `ms` of REAL time, or is cut off by the function's own AbortSignal.
const slowTsy = (ms) => (m, u, init) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve(tsyResponse(m)), ms);
  init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }, { once: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── desk_feed_cache, faked: shared across the fresh vm contexts of one check ───
function fakeDb() {
  const db = { rows: new Map(), log: [], read: null, write: null };
  db.posts = () => db.log.filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body)[0].payload);
  db.payload = (key = 'econ:treasury') => db.rows.get(key)?.payload ?? null;
  db.seed = (payload, key = 'econ:treasury') => db.rows.set(key, { key, at: new Date(T0).toISOString(), payload: JSON.parse(JSON.stringify(payload)) });
  db.reads = () => db.log.filter((c) => c.method === 'GET').length;
  db.writes = () => db.log.filter((c) => c.method === 'POST').length;
  db.handle = async (u, init) => {
    const h = new Headers(init.headers);
    const method = (init.method || 'GET').toUpperCase();
    db.log.push({ method, url: u.href, headers: Object.fromEntries(h), body: init.body ?? null });
    // The gateway (CLAUDE.md, learned 2026-07-29): a secret key in a browser-shaped request is refused.
    if (/mozilla/i.test(h.get('user-agent') || '')) return new Response('{"message":"Forbidden use of secret API key in browser"}', { status: 401 });
    if (h.get('apikey') !== SERVICE_KEY || h.get('authorization') !== `Bearer ${SERVICE_KEY}`) return new Response('{"message":"Invalid API key"}', { status: 401 });
    if (u.pathname !== '/rest/v1/desk_feed_cache') return new Response('{"message":"not found"}', { status: 404 });
    if (method === 'GET') {
      // an override that answers nothing (undefined) falls through to the real read
      if (db.read) { const forced = await db.read(u, init); if (forced) return forced; }
      const key = u.searchParams.get('key') || '';
      if (u.searchParams.get('select') !== 'at,payload' || !key.startsWith('eq.')) return new Response('{"message":"bad query"}', { status: 400 });
      const r = db.rows.get(key.slice(3));
      return new Response(JSON.stringify(r ? [{ at: r.at, payload: r.payload }] : []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'POST') {
      if (db.write) { const forced = await db.write(u, init); if (forced) return forced; }
      const upsert = u.searchParams.get('on_conflict') === 'key' && /resolution=merge-duplicates/.test(h.get('prefer') || '');
      for (const item of JSON.parse(init.body)) {
        if (db.rows.has(item.key) && !upsert) return new Response('{"code":"23505"}', { status: 409 });
        // merge-duplicates: the columns sent REPLACE the stored ones (the jsonb payload whole)
        db.rows.set(item.key, { ...(db.rows.get(item.key) || {}), ...JSON.parse(JSON.stringify(item)) });
      }
      return new Response(null, { status: 201 });
    }
    return new Response('{"message":"method"}', { status: 405 });
  };
  return db;
}

function boot(code, opts = {}) {
  const clock = { now: opts.now ?? T0 };
  const calls = [];
  const db = opts.db ?? fakeDb();   // a fresh, empty table unless the check shares one between instances
  const denoEnv = opts.denoEnv ?? DENO_ENV;
  const env = { clock, calls, opts, db, warns: [], throwOnWarn: false };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, host: u.hostname, init });
    if (u.hostname === DB_HOST) return db.handle(u, init);
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
    Deno: { serve: (h) => { handler = h; }, env: { get: (k) => (Object.hasOwn(denoEnv, k) ? denoEnv[k] : undefined) } },
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
    eq([f.fetchCount('home.treasury.gov'), f.fetchCount(DB_HOST)], [0, 0], 'a roster naming no Treasury column never calls Treasury, nor the store');
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

  ["committed roster (and the identical built-in default): once it lands, Treasury newer than FRED wins the three yields with TODAY's rate; tail stitched with no duplicate or out-of-order date", async (code) => {
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

  ['Treasury outage (503, 403 block page, HTML on a 200, network error, TIMEOUT, garbage columns) -> all seven rows from FRED, HTTP 200, none missing, NOTHING written to the store but the failure', async (code) => {
    // A HUNG host: the fetch settles only when the function's own AbortSignal fires. The 3s guard
    // turns a fetch nobody bounds into a failed check instead of a suite that never ends.
    let aborted = 0, unbounded = false;
    const hang = (m, u, init) => new Promise((_, reject) => {
      const guard = setTimeout(() => { unbounded = true; reject(new Error('never aborted')); }, 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(guard); aborted++; reject(init.signal.reason); }, { once: true });
    });
    // every tenor column rotated: it parses, and none of it agrees with FRED
    const rotated = (m) => (TSY_TEXT[m]
      ? new Response(TSY_TEXT[m].replace('"2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr"', '"20 Yr","3 Yr","5 Yr","7 Yr","2 Yr","10 Yr"'), { status: 200 })
      : new Response('Not Found', { status: 404 }));
    for (const [name, fn, extra] of [
      ['503', down(503)],
      ['403 block page', () => new Response('<html><head><title>Access Denied</title></head><body>Access Denied</body></html>', { status: 403 })],
      ['HTML on a 200', () => new Response('<html><body>Access Denied</body></html>', { status: 200 })],
      ['network', () => { throw new TypeError('connection reset'); }],
      ['timeout', hang, { timeoutScale: 0.01 }],
      ['garbage columns', rotated],
    ]) {
      const e = boot(code, { config: CONFIG, treasury: fn, ...extra });
      const r = await e.call();
      eq([r.status, r.json.ok, r.json.stale, r.json.rows.length], [200, true, false, 7], `${name}: HTTP 200, ok, nothing stale, seven rows`);
      eq(e.fetchCount('home.treasury.gov'), 2, `${name}: Treasury was asked (the committed roster wants it), once`);
      for (const x of r.json.rows) {
        eq([x.id, x.status, x.source, x.value === null], [x.id, 'ok', 'fred', false], `${name}: ${x.id} served from FRED, not missing`);
      }
      for (const id of YIELDS) eq(row(r, id).asOf, '2026-09-28', `${name}: ${id} at FRED's newest`);
      eq(row(r, 'ust10y').value, 5.24, `${name}: FRED's newest 10Y`);
      const p = e.db.payload();
      eq([p.cols, p.attemptedAt, p.failedAt, p.fetchedAt], [{}, T0, T0, 0], `${name}: the store holds the failure (every instance backs off) and NO observation`);
      eq((await e.call()).json.rows, r.json.rows, `${name}: the next reply is the same`);
    }
    eq([aborted, unbounded], [2, false], 'the hung Treasury host was cut off by its AbortSignal (both months), never left hanging');
  }],

  ['Treasury garbage (mislabelled columns) fails the FRED agreement check: the good column serves, and ONLY it is stored', async (code) => {
    const swapped = (m) => new Response(TSY_TEXT[m].replace('"10 Yr","20 Yr"', '"20 Yr","10 Yr"'), { status: 200 });
    const e = boot(code, { treasury: (m) => (TSY_TEXT[m] ? swapped(m) : new Response('', { status: 404 })) });
    const r = await e.call();
    eq([row(r, 'ust10y').source, row(r, 'ust10y').asOf, row(r, 'ust10y').value], ['fred', '2026-09-28', 5.24], '10Y rejected');
    eq([row(r, 'ust20y').source, row(r, 'ust20y').asOf], ['fred', '2026-09-28'], '20Y rejected');
    eq([row(r, 'ust2y').source, row(r, 'ust2y').asOf], ['treasury', '2026-09-30'], '2Y (correct column) still Treasury');
    eq(Object.keys(e.db.payload().cols), ['2 Yr'], 'the store stays clean: the mislabelled columns were never written');
  }],

  ['SHARED STORE: cold instance A takes the lease, WAITS for a slow ("18 s") Treasury and serves it in its OWN reply; a request during that wait does not fetch; cold instance B then serves the stored rows with ZERO Treasury requests', async (code) => {
    const db = fakeDb();
    // timeoutScale 0.01: the 45 s bound -> 450 ms; this host answers after "18 s" (180 ms of real time)
    const a = boot(code, { db, treasury: slowTsy(180), timeoutScale: 0.01 });
    const pa = within(a.call({ range: '1m' }), 440, 'instance A did not answer inside the 45 s bound');
    // While A waits on Treasury, instance C (1 s later) finds the lease taken: no fetch, the store as it is, at once.
    for (let i = 0; i < 100 && !a.fetchCount('home.treasury.gov'); i++) await sleep(5);
    eq(a.fetchCount('home.treasury.gov'), 2, 'A is now waiting on its fetch pair');
    const c = boot(code, { db, now: T0 + 1_000, treasury: slowTsy(180), timeoutScale: 0.01 });
    const pc = within(c.call({ range: '1m' }), 2000, 'instance C');
    eq(await Promise.race([pa.then(() => 'A'), pc.then(() => 'C')]), 'C', 'C answered while A was still waiting on Treasury');
    const rc = await pc;
    eq([c.fetchCount('home.treasury.gov'), rc.status, YIELDS.map((id) => row(rc, id).source)], [0, 200, ['fred', 'fred', 'fred']],
      'C: the lease is taken, so no fetch — the (still empty) store, i.e. FRED');
    const ra = await pa;
    eq([ra.status, ra.json.rows.length], [200, 7], 'A: HTTP 200, seven rows');
    for (const [id, v] of [['ust2y', 4.9], ['ust10y', 5.21], ['ust20y', 5.58]]) {
      eq([row(ra, id).source, row(ra, id).asOf, row(ra, id).value], ['treasury', '2026-09-30', v], `A ${id}: its OWN reply carries the fetched rate`);
    }
    const p = db.payload();
    eq(Object.keys(p.cols).sort(), ['10 Yr', '2 Yr', '20 Yr'], 'the store holds exactly the roster columns');
    eq([p.cols['10 Yr'].at(-1), p.attemptedAt, p.fetchedAt, p.failedAt], [['2026-09-30', 5.21], T0, T0, null], 'with today\'s rate and its stamps');
    const b = boot(code, { db, now: T0 + 60_000, treasury: () => { throw new Error('instance B must not ask Treasury'); } });
    const rb = await within(b.call({ range: '1m' }), 2000, 'instance B');
    eq(b.fetchCount('home.treasury.gov'), 0, 'B: ZERO Treasury requests');
    for (const [id, v] of [['ust2y', 4.9], ['ust10y', 5.21], ['ust20y', 5.58]]) {
      eq([row(rb, id).source, row(rb, id).asOf, row(rb, id).value], ['treasury', '2026-09-30', v], `B ${id}: served from the shared store`);
    }
    for (const id of OTHERS) eq(row(rb, id).source, 'fred', `B ${id}`);
  }],

  ['LEASE: two cold instances at once make ONE fetch pair (the loser serves the store without fetching); inside the 5-min interval no new attempt, after it one', async (code) => {
    const db = fakeDb();
    const N = at('2026-09-30T20:00:00Z'); // Wed 16:00 ET: today's rate not out yet, so attempts stay due every 5 min
    const x = boot(code, { db, now: N, treasury: noTodayTsy });
    const y = boot(code, { db, now: N, treasury: noTodayTsy });
    const [rx, ry] = await Promise.all([x.call(), y.call()]);
    const nx = x.fetchCount('home.treasury.gov'), ny = y.fetchCount('home.treasury.gov');
    eq([nx + ny, Math.min(nx, ny)], [2, 0], 'exactly ONE fetch pair across the two instances, all of it by one of them');
    const [winner, loser] = nx ? [rx, ry] : [ry, rx];
    eq(YIELDS.map((id) => [row(winner, id).source, row(winner, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-29']), 'the lease holder serves what it fetched');
    eq([loser.status, YIELDS.map((id) => row(loser, id).source)], [200, ['fred', 'fred', 'fred']], 'the loser served the store as it was (empty: FRED)');
    const w = boot(code, { db, now: N + 4 * 60_000, treasury: noTodayTsy });
    const rw = await w.call();
    eq([w.fetchCount('home.treasury.gov'), row(rw, 'ust10y').source], [0, 'treasury'], '16:04: no attempt inside the interval — and the stored tail serves');
    const v = boot(code, { db, now: N + 5 * 60_000, treasury: noTodayTsy });
    await v.call();
    eq(v.fetchCount('home.treasury.gov'), 2, '16:05: a new attempt is allowed');
    // The first read runs beside the FRED sweep, so it can predate another instance's whole attempt. Instance S
    // (slow FRED) reads a FREE lease, then T (fast) takes it, fetches today's rate and stores it — S must re-read
    // before taking the lease, find today's rate held, and serve it without a second fetch.
    const late = fakeDb(), L = at('2026-09-30T21:00:00Z');   // 17:00 ET, nothing stored yet
    const slowFred = Object.fromEntries(FRED_IDS.map((id) => [id, (u) => sleep(80).then(() => fredResponse(id, u.searchParams.get('cosd')))]));
    const s = boot(code, { db: late, now: L, fred: slowFred });
    const ps = s.call();
    for (let i = 0; i < 100 && !late.reads(); i++) await sleep(2);
    const tt = boot(code, { db: late, now: L + 1_000 });
    await tt.call();
    eq(tt.fetchCount('home.treasury.gov'), 2, 'T took the lease and fetched');
    const rs = await ps;
    eq([s.fetchCount('home.treasury.gov'), YIELDS.map((id) => [row(rs, id).source, row(rs, id).asOf])], [0, YIELDS.map(() => ['treasury', '2026-09-30'])],
      "S re-read before taking the lease: today's rate held, served, no second fetch");
  }],

  ["RACE: a racing instance's STALE failure never overwrites the fresher rows another instance stored meanwhile", async (code) => {
    const db = fakeDb();
    const fresh = { '2 Yr': [['2026-09-28', 4.92], ['2026-09-29', 4.95], ['2026-09-30', 4.9]], '10 Yr': [['2026-09-28', 5.24], ['2026-09-29', 5.27], ['2026-09-30', 5.21]], '20 Yr': [['2026-09-28', 5.6], ['2026-09-29', 5.63], ['2026-09-30', 5.58]] };
    // x holds a lease and its fetch FAILS slowly; meanwhile another instance (which also won a lease) stores today's rate
    const failSlow = () => sleep(40).then(() => {
      if (db.payload().lease !== 'other') db.seed({ cols: fresh, fetchedAt: T0, attemptedAt: T0, failedAt: null, lease: 'other' });
      return new Response('upstream down', { status: 503 });
    });
    const x = boot(code, { db, treasury: failSlow });
    const rx = await x.call();
    eq(x.fetchCount('home.treasury.gov'), 2, 'x made its (failing) attempt');
    eq([db.payload().lease, db.payload().failedAt, db.payload().cols['10 Yr'].at(-1)], ['other', null, ['2026-09-30', 5.21]], 'the fresher row stands: no stale failure written over it');
    eq(YIELDS.map((id) => [row(rx, id).source, row(rx, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-30']), 'and x serves it');
  }],

  ['a Treasury answering in "30 s" (observed 17-20 s, once past 20 s) is AWAITED and lands in this reply: the 45 s bound, not the old 5 s', async (code) => {
    // timeoutScale 0.02: 45 s -> 900 ms, the old 5 s -> 100 ms; this host answers after "30 s" (600 ms)
    const e = boot(code, { config: CONFIG, treasury: slowTsy(600), timeoutScale: 0.02 });
    const r = await within(e.call(), 1500, 'no reply');
    eq(YIELDS.map((id) => [row(r, id).source, row(r, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-30']), 'the slow answer landed in this reply');
  }],

  ["CADENCE on the shared row: today's rate is final; a missing one is attempted every 5 min from 15:25 ET to midnight (from attemptedAt); outside that, nothing once a fetch has succeeded since the window opened; a failure's 10-min back-off binds a DIFFERENT instance", async (code) => {
    const inst = async (db, now, treasury) => {
      const e = boot(code, { db, now, treasury });
      const r = await e.call();
      return [e.fetchCount('home.treasury.gov'), r];
    };
    // (a) 18:00 ET, today's rate held: never attempted again that day, by any instance
    const da = fakeDb();
    eq((await inst(da, T0))[0], 2, '18:00: the first instance fetches');
    for (const later of [6, 61]) eq((await inst(da, T0 + later * 60_000))[0], 0, `+${later} min (another instance): today's rate is final`);
    // (b) 16:00 ET, today's rate not out yet: every 5 min, not sooner, until it posts
    const db = fakeDb(), B = at('2026-09-30T20:00:00Z');
    eq((await inst(db, B, noTodayTsy))[0], 2, '16:00');
    eq((await inst(db, B + 4 * 60_000, noTodayTsy))[0], 0, '16:04: not sooner than 5 min');
    eq((await inst(db, B + 5 * 60_000, noTodayTsy))[0], 2, '16:05: attempted again');
    const [n10, r10] = await inst(db, B + 10 * 60_000);   // today's rate has posted
    eq([n10, YIELDS.map((id) => row(r10, id).asOf)], [2, ['2026-09-30', '2026-09-30', '2026-09-30']], '16:10: attempted, there, and served at once');
    eq((await inst(db, B + 15 * 60_000))[0], 0, '16:15: held — no more attempts');
    // (c) 23:00 ET still counts (a late post): 5 min, not hourly
    const dc = fakeDb(), C = at('2026-10-01T03:00:00Z');
    await inst(dc, C, noTodayTsy);
    eq((await inst(dc, C + 5 * 60_000, noTodayTsy))[0], 2, '23:05 ET: attempted at 5 min');
    // (d) 10:00 ET, outside the posting window, empty store: the first request asks at once; after that success,
    //     nothing more until the window opens (nothing new can be published before ~15:30 ET)
    const dd = fakeDb(), D = at('2026-09-30T14:00:00Z');
    eq((await inst(dd, D, noTodayTsy))[0], 2, '10:00, nothing stored: asked at once');
    for (const [label, later] of [['10:30', 30], ['11:01', 61], ['15:24', 324]]) eq((await inst(dd, D + later * 60_000, noTodayTsy))[0], 0, `${label}: nothing new can exist before the window`);
    eq((await inst(dd, D + 325 * 60_000, noTodayTsy))[0], 2, '15:25: the window opens, today missing: asked');
    // (e) 16:00 ET, a total failure: the 10-min back-off binds another instance (it would otherwise be due at 5 min)
    const de = fakeDb();
    eq((await inst(de, B, down(503)))[0], 2, '16:00: attempted, failed');
    eq((await inst(de, B + 5 * 60_000, down(503)))[0], 0, '16:05 (another instance): backing off');
    eq((await inst(de, B + 10 * 60_000, down(503)))[0], 2, '16:10: attempted again once the back-off is over');
  }],

  ["RETRY CAP: while today's rate is pending inside the posting window, refreshInSec brings the client back when the next attempt is allowed — after the 18:30 ET release window too (the quiet 15 min would miss a late print); the back-off after a failure; no cap once held, or outside the window", async (code) => {
    const poll = async (db, ms, treasury) => {
      const e = boot(code, { db, now: ms, treasury });
      const r = await e.call();
      return [r.json.refreshInSec, e.fetchCount('home.treasury.gov'), r];
    };
    for (const [label, iso] of [['Wed 19:00 ET', '2026-09-30T23:00:00Z'], ['Wed 23:00 ET', '2026-10-01T03:00:00Z']]) {
      const db = fakeDb(), N = at(iso);
      const [s, n, r] = await poll(db, N, noTodayTsy);
      eq([n, r.json.phase, s], [2, 'quiet', 300], `${label}, today's rate not out: attempted, and back in 5 min (the quiet phase alone says 15)`);
      eq((await poll(db, N + 2 * 60_000, noTodayTsy)).slice(0, 2), [180, 0], `${label} +2 min (another instance): no attempt, back when the lease frees`);
      eq((await poll(db, N + 290_000, noTodayTsy)).slice(0, 2), [30, 0], `${label} +4:50: never below the 30 s client clamp`);
      // the client came back on time: the lease is free, the late print lands, and the cap lifts
      const [s5, n5, r5] = await poll(db, N + 5 * 60_000);
      eq([n5, YIELDS.map((id) => row(r5, id).asOf), s5], [2, ['2026-09-30', '2026-09-30', '2026-09-30'], 900], `${label} +5 min: attempted, today's rate held, the quiet policy again`);
    }
    eq((await poll(fakeDb(), at('2026-09-30T19:30:00Z'), noTodayTsy))[0], 60, "15:30 ET: the release window's own 60 s is already sooner — unchanged");
    const h = fakeDb();
    eq((await poll(h, at('2026-09-30T23:00:00Z')))[0], 900, "19:00 ET, today's rate fetched and held: no cap");
    eq((await poll(h, at('2026-09-30T23:03:00Z')))[0], 900, 'and none for a later instance');
    const f = fakeDb();
    eq((await poll(f, at('2026-09-30T23:00:00Z'), down(503))).slice(0, 2), [600, 2], '19:00 ET, Treasury down: back when the 10-min back-off ends, not at 5 min');
    eq((await poll(f, at('2026-09-30T23:04:00Z'), down(503))).slice(0, 2), [360, 0], '19:04 (another instance): the back-off remaining');
    eq((await poll(fakeDb(), at('2026-09-30T14:00:00Z'), noTodayTsy))[0], 900, '10:00 ET (outside the posting window): the quiet policy, no cap');
    eq((await poll(fakeDb(), at('2026-10-03T22:00:00Z'), noTodayTsy))[0], 3600, 'Saturday: the weekend heartbeat, no cap');
  }],

  ['OUTSIDE the posting window: no attempt once a fetch has succeeded since the last window opened (weekday 15:25 ET; Friday\'s over a weekend, DST weekends included); a store older than that gets ONE attempt; a failing host costs at most one per hour', async (code) => {
    // a row as a real successful attempt leaves it, re-stamped to `fetchedAt`
    // A fetch dated BEFORE the fixtures' own Treasury rows (the March DST case) cannot hold them: the function drops
    // stored dates after "today", correctly. Its columns are FRED's own last observations up to that day instead —
    // they agree with FRED by construction, which is all the weekend checks need from a stored column.
    const colsUpTo = (iso) => Object.fromEntries(TSY_COLS.map(([, fredId, c]) => [c, refObs(fredId, '2025-12-01').filter(([d]) => d <= iso.slice(0, 10)).slice(-5)]));
    const seeded = async (fetchedAt) => {
      const src = fakeDb();
      await boot(code, { db: src }).call();
      const db = fakeDb();
      const iso = new Date(fetchedAt).toISOString();
      db.seed({ ...src.payload(), ...(iso < '2026-09-01' ? { cols: colsUpTo(iso) } : {}), fetchedAt, attemptedAt: fetchedAt, failedAt: null });
      return db;
    };
    const visit = async (db, iso, treasury) => {
      const e = boot(code, { db, now: at(iso), treasury });
      const r = await e.call();
      return [e.fetchCount('home.treasury.gov'), r];
    };
    // (a) Wed 18:00 ET success -> Thursday until 15:25 ET: ZERO requests and NO write, whichever instance asks
    const a = fakeDb();
    eq((await visit(a, '2026-09-30T22:00:00Z'))[0], 2, 'Wed 18:00 ET: fetched');
    const writes = a.writes();
    for (const iso of ['2026-10-01T04:30:00Z', '2026-10-01T10:00:00Z', '2026-10-01T14:00:00Z', '2026-10-01T19:24:59Z']) {
      const [n, r] = await visit(a, iso);
      eq([n, YIELDS.map((id) => [row(r, id).source, row(r, id).asOf])], [0, YIELDS.map(() => ['treasury', '2026-09-30'])], `${iso}: no attempt, Wednesday's rate served from the store`);
    }
    eq(a.writes(), writes, 'and no lease written all morning');
    eq((await visit(a, '2026-10-01T19:25:00Z'))[0], 2, 'Thu 15:25 ET: the window opens, today missing: asked');
    // (b) Friday-evening success -> the weekend and Monday morning: nothing; Monday 15:25 ET: asked. Both 2026 DST weekends too.
    for (const [fri, quiet, mon1525] of [
      ['2026-10-02T22:00:00Z', ['2026-10-03T14:00:00Z', '2026-10-03T22:00:00Z', '2026-10-04T16:00:00Z', '2026-10-05T13:00:00Z', '2026-10-05T19:24:00Z'], '2026-10-05T19:25:00Z'],
      ['2026-10-30T22:00:00Z', ['2026-10-31T22:00:00Z', '2026-11-01T17:00:00Z', '2026-11-02T14:00:00Z', '2026-11-02T20:24:00Z'], '2026-11-02T20:25:00Z'],   // DST ends Sun Nov 1
      ['2026-03-06T23:00:00Z', ['2026-03-07T23:00:00Z', '2026-03-08T16:00:00Z', '2026-03-09T13:00:00Z', '2026-03-09T19:24:00Z'], '2026-03-09T19:25:00Z'],   // DST starts Sun Mar 8
    ]) {
      const db = await seeded(at(fri));
      for (const iso of quiet) eq((await visit(db, iso))[0], 0, `Friday ${fri} success -> ${iso}: no attempt`);
      eq(db.writes(), 0, `Friday ${fri} success: no lease written over the weekend`);
      eq((await visit(db, mon1525))[0], 2, `Monday 15:25 ET after Friday ${fri}: asked`);
    }
    // (c) a store OLDER than the last window start (a Wednesday success, now Friday 10:00 ET): one attempt, then none
    const c = await seeded(at('2026-09-30T22:00:00Z'));
    eq((await visit(c, '2026-10-02T14:00:00Z'))[0], 2, 'Fri 10:00 ET, nothing since Thursday 15:25: asked once');
    for (const iso of ['2026-10-02T14:30:00Z', '2026-10-02T15:01:00Z', '2026-10-02T19:24:00Z']) eq((await visit(c, iso))[0], 0, `${iso}: it succeeded, so nothing more before the window`);
    // (d) the same, but the host keeps failing: at most one attempt per hour, and the stored rate still serves
    const d = await seeded(at('2026-09-30T22:00:00Z'));
    const fails = [];
    for (const iso of ['2026-10-02T14:00:00Z', '2026-10-02T14:11:00Z', '2026-10-02T14:59:00Z', '2026-10-02T15:01:00Z']) {
      const [n, r] = await visit(d, iso, down(503));
      fails.push(n);
      eq([r.status, row(r, 'ust10y').source, row(r, 'ust10y').asOf], [200, 'treasury', '2026-09-30'], `${iso}: HTTP 200, the stored rate`);
    }
    eq(fails, [2, 0, 0, 2], 'a failing host: 10:00 asked, 10:11 (back-off over) and 10:59 not, 11:01 asked again');
    // (e) the roster changes after a COMPLETE fetch (Codex, PR #296): fetchedAt vouches only for the roster it ran under.
    //     The Pages roster is re-read hourly, so a tenor added — or a row repointed — on a weekend must not wait for Monday 15:25 ET.
    const no20 = CONFIG.map((r) => (r.id === 'ust20y' ? { ...r, sources: { fred: r.sources.fred } } : r));
    const swapped = CONFIG.map((r) => (r.id === 'ust2y' ? { ...r, sources: { ...r.sources, treasury: '10 Yr' } }
      : r.id === 'ust10y' ? { ...r, sources: { ...r.sources, treasury: '2 Yr' } } : r));
    const asked = async (db, iso, config) => {
      const e = boot(code, { db, now: at(iso), config });
      const r = await e.call();
      return [e.fetchCount('home.treasury.gov'), r];
    };
    const e1 = fakeDb();
    eq((await asked(e1, '2026-10-02T22:00:00Z', no20))[0], 2, 'Fri 18:00 ET, a roster without the 20 Yr column: fetched');
    eq([Object.keys(e1.payload().cols).sort(), e1.payload().fetchedAt > 0], [['10 Yr', '2 Yr'], true], 'a COMPLETE fetch for that roster: two columns stored, fetchedAt advanced');
    eq((await asked(e1, '2026-10-03T14:00:00Z', no20))[0], 0, 'Saturday, same roster: nothing to ask');
    const [n1, r1] = await asked(e1, '2026-10-03T15:00:00Z', CONFIG);
    eq([n1, row(r1, 'ust20y').source], [2, 'treasury'], 'Saturday, the roster now names the 20 Yr column: asked at once (not Monday 15:25 ET), and that row carries Treasury');
    eq(Object.keys(e1.payload().cols).sort(), ['10 Yr', '2 Yr', '20 Yr'], 'the new column is stored');
    eq((await asked(e1, '2026-10-03T16:00:00Z', CONFIG))[0], 0, 'and once the stored columns cover the roster nothing more is asked');
    const e2 = await seeded(at('2026-10-02T22:00:00Z'));
    eq((await asked(e2, '2026-10-03T14:00:00Z', CONFIG))[0], 0, 'baseline: the roster it was fetched for asks nothing');
    const [n2, r2] = await asked(e2, '2026-10-03T15:00:00Z', swapped);
    eq(n2, 2, 'a roster that repoints the 2Y/10Y rows at the other column (the stored ones no longer agree with their FRED spines): asked');
    eq(YIELDS.map((id) => row(r2, id).source), ['fred', 'fred', 'treasury'], 'the repointed rows stay on FRED, the untouched 20Y still carries Treasury');
  }],

  ['PARTIAL success (one yield cannot validate — its FRED spine is down): the columns that did are stored and served, but fetchedAt does NOT move, so outside the window the missing one is still asked for, hourly; once all validate, fetchedAt advances and the asking stops', async (code) => {
    const db = fakeDb();
    const dgs20Down = { DGS20: down(503) };
    const visit = async (iso, fred) => {
      const e = boot(code, { db, now: at(iso), fred, treasury: noTodayTsy });
      const r = await e.call();
      return [e.fetchCount('home.treasury.gov'), r];
    };
    const T1 = at('2026-09-30T14:00:00Z');   // Wed 10:00 ET: outside the posting window, nothing stored
    const [n1, r1] = await visit('2026-09-30T14:00:00Z', dgs20Down);
    eq(n1, 2, '10:00: asked');
    eq(YIELDS.map((id) => [row(r1, id).source, row(r1, id).status]), [['treasury', 'ok'], ['treasury', 'ok'], [null, 'missing']], '2Y and 10Y from Treasury; 20Y has no FRED spine to check it against');
    const p1 = db.payload();
    eq([Object.keys(p1.cols).sort(), p1.fetchedAt, p1.mergedAt, p1.attemptedAt, p1.failedAt], [['10 Yr', '2 Yr'], 0, T1, T1, null],
      'the two validated columns stored; fetchedAt NOT advanced (not every roster column validated), mergedAt is');
    const [n2, r2] = await visit('2026-09-30T14:30:00Z', dgs20Down);
    eq([n2, row(r2, 'ust2y').source, row(r2, 'ust10y').source, row(r2, 'ust10y').asOf], [0, 'treasury', 'treasury', '2026-09-29'],
      '10:30 (another instance): inside the hourly interval no attempt — and the stored columns serve (their 72h keep runs from mergedAt)');
    const [n3] = await visit('2026-09-30T15:01:00Z', dgs20Down);
    eq([n3, db.payload().fetchedAt], [2, 0], '11:01: the hour is up and no COMPLETE success since the window opened: asked again (still partial)');
    const T4 = at('2026-09-30T16:05:00Z');
    const [n4, r4] = await visit('2026-09-30T16:05:00Z');   // FRED's DGS20 is back
    eq([n4, YIELDS.map((id) => [row(r4, id).source, row(r4, id).asOf])], [2, YIELDS.map(() => ['treasury', '2026-09-29'])], '12:05, FRED recovered: asked, all three yields from Treasury');
    eq([Object.keys(db.payload().cols).sort(), db.payload().fetchedAt, db.payload().mergedAt], [['10 Yr', '2 Yr', '20 Yr'], T4, T4], 'the third column stored and fetchedAt advanced: a COMPLETE success');
    eq((await visit('2026-09-30T17:10:00Z'))[0], 0, '13:10: complete since the window opened — nothing more before 15:25 ET');
  }],

  ['STORE READ failure (500, timeout, non-JSON, not a row list) = a FRED-only reply with NO Treasury attempt; a foreign-shaped or corrupt payload never reaches a reply, and the next lease rewrites it clean', async (code) => {
    // A hung store: settles only when the function's own signal fires. The guard keeps Node's event loop
    // alive (AbortSignal.timeout's timer is unref'd) and fails the check if the read was never bounded.
    let unboundedRead = false;
    const hang = (u, init) => new Promise((_, reject) => {
      const guard = setTimeout(() => { unboundedRead = true; reject(new Error('never aborted')); }, 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(guard); reject(init.signal.reason); }, { once: true });
    });
    for (const [name, read, extra] of [
      ['HTTP 500', () => new Response('{"message":"boom"}', { status: 500 })],
      ['timeout', hang, { timeoutScale: 0.01 }],
      ['non-JSON', () => new Response('<html>', { status: 200 })],
      ['not a row list', () => new Response('{"rows":[]}', { status: 200 })],
    ]) {
      const db = fakeDb();
      db.read = read;
      const e = boot(code, { db, ...extra });
      const r = await e.call();
      eq([r.status, r.json.ok, r.json.rows.length], [200, true, 7], `${name}: HTTP 200, ok, seven rows`);
      for (const x of r.json.rows) eq([x.id, x.status, x.source], [x.id, 'ok', 'fred'], `${name}: ${x.id} from FRED`);
      eq([e.fetchCount('home.treasury.gov'), db.writes()], [0, 0], `${name}: no Treasury attempt and no write (an attempt nobody can see would be repeated by every request)`);
    }
    eq(unboundedRead, false, 'the hung store read was cut off by its own signal');
    const junk = { cols: { '10 Yr': 'x', '2 Yr': [[1, 2], ['2026-09-30', '4.9'], ['2099-01-01', 4.9]], Bogus: [['2026-09-30', 1]] }, attemptedAt: 'soon', failedAt: 9e15, fetchedAt: -1 };
    for (const [name, payload] of [['an array', [1, 2, 3]], ['a string', 'hello'], ['a foreign object', { rows: { '10 Yr': 9.99 } }], ['junk fields', junk]]) {
      const db = fakeDb();
      db.seed(payload);
      const e = boot(code, { db, treasury: down(503) });   // nothing fresh to be had: whatever the payload says, FRED
      const r = await e.call();
      eq([r.status, YIELDS.map((id) => row(r, id).source)], [200, ['fred', 'fred', 'fred']], `${name}: never served`);
      const db2 = fakeDb();
      db2.seed(payload);
      const f = boot(code, { db: db2 });                   // Treasury up: the payload reads as empty, so a lease is due
      const rf = await f.call();
      eq(YIELDS.map((id) => row(rf, id).source), ['treasury', 'treasury', 'treasury'], `${name}: the lease holder serves fresh rows`);
      eq([Object.keys(db2.payload().cols).sort(), db2.payload().failedAt], [['10 Yr', '2 Yr', '20 Yr'], null], `${name}: and rewrites the row clean`);
    }
    // well-formed but WRONG values: a 10 Yr that disagrees with FRED never shows, a 20 Yr sharing no date with FRED
    // never shows, and a "today" that disagrees is not final — a fresh attempt is made
    const db = fakeDb();
    db.seed({ cols: { '2 Yr': [['2026-09-28', 4.92], ['2026-09-30', 4.9], ['2026-10-05', 1.23]], '10 Yr': [['2026-09-28', 9.99], ['2026-09-30', 9.99]], '20 Yr': [['2026-09-30', 7.77]] },
      fetchedAt: T0 - 6 * 60_000, attemptedAt: T0 - 6 * 60_000, failedAt: null });
    const e = boot(code, { db, treasury: down(503) });
    const r = await e.call();
    eq([row(r, 'ust2y').source, row(r, 'ust2y').asOf, row(r, 'ust2y').value], ['treasury', '2026-09-30', 4.9], 'the good stored column serves — its date AFTER today dropped on read');
    eq([row(r, 'ust10y').source, row(r, 'ust10y').asOf, row(r, 'ust10y').value], ['fred', '2026-09-28', 5.24], 'a stored 10 Yr that disagrees with FRED never shows');
    eq([row(r, 'ust20y').source, row(r, 'ust20y').asOf], ['fred', '2026-09-28'], 'a stored 20 Yr sharing no date with FRED never shows');
    eq(e.fetchCount('home.treasury.gov'), 2, 'a "today" that disagrees with FRED is not final: attempted');
  }],

  ['STORE WRITE failure: a lease that cannot be written means NO attempt (a fast FRED reply); a final write that fails still serves the rows fetched in THIS request', async (code) => {
    const db = fakeDb();
    db.write = () => new Response('{"message":"boom"}', { status: 500 });
    const e = boot(code, { db });
    const r = await e.call();
    eq([r.status, e.fetchCount('home.treasury.gov'), YIELDS.map((id) => row(r, id).source)], [200, 0, ['fred', 'fred', 'fred']], 'no lease, no attempt');
    const db2 = fakeDb();
    db2.write = (u, init) => (JSON.parse(init.body)[0].payload.fetchedAt > 0 ? new Response(`{"message":"boom","hint":"${SERVICE_KEY}"}`, { status: 503 }) : undefined);
    const f = boot(code, { db: db2 });
    const rf = await f.call();
    eq(f.fetchCount('home.treasury.gov'), 2, 'the lease was written, the fetch made');
    eq(YIELDS.map((id) => [row(rf, id).source, row(rf, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-30']), 'this reply carries what it fetched though the store write failed');
    eq(db2.payload().cols, {}, 'nothing was stored');
    assert(f.warns.some((w) => /store write failed HTTP 503/.test(w)), 'the failed write is logged');
    assert(!f.warns.some((w) => w.includes(SERVICE_KEY)), 'and the log never carries the service key');
    // After 18:30 ET a failed FINAL write must not lift the retry cap (Codex, PR #296): `next` reads as "today's rate held",
    // but the table still holds only the lease, and the next request — a fresh instance — reads exactly that.
    const db3 = fakeDb();
    db3.write = (u, init) => (JSON.parse(init.body)[0].payload.mergedAt > 0 ? new Response('{"message":"boom"}', { status: 503 }) : undefined);
    const g = boot(code, { db: db3, now: at('2026-09-30T23:00:00Z') });
    const rg = await g.call();
    eq(YIELDS.map((id) => [row(rg, id).source, row(rg, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-30']), '19:00 ET: this reply still carries what it fetched');
    eq([rg.json.phase, rg.json.refreshInSec], ['quiet', 300], 'but the client is told to come back when the next attempt is allowed (5 min), not the quiet 15');
    eq(db3.payload().mergedAt ?? 0, 0, 'the table still holds only the lease');
    // The same when Treasury answers nothing usable and the FAILURE record cannot be stored (Codex, PR #296): the table then
    // holds only the lease (retryable in 5 min), so the client is not told to wait for a 10-min back-off nobody else will see.
    const N = at('2026-09-30T23:00:00Z');
    const stored = boot(code, { db: fakeDb(), now: N, treasury: down(503) });
    eq((await stored.call()).json.refreshInSec, 600, '19:00 ET, failure stored: the client is sent back when the 10-min back-off ends');
    const db4 = fakeDb();
    db4.write = (u, init) => (JSON.parse(init.body)[0].payload.failedAt !== null ? new Response('{"message":"boom"}', { status: 503 }) : undefined);
    const h = boot(code, { db: db4, now: N, treasury: down(503) });
    const rh = await h.call();
    eq([rh.status, YIELDS.map((id) => row(rh, id).source)], [200, ['fred', 'fred', 'fred']], 'the reply is FRED either way');
    eq([db4.payload().failedAt, rh.json.refreshInSec], [null, 300], 'failure record not stored: the table holds the lease only, so the client comes back in 5 min, not 10');
  }],

  ["FINAL RE-READ failure (500, timeout) is not 'no row yet': nothing is written after the lease — a contender's fresher row stands byte for byte, and no failure is recorded — while the reply serves what THIS request validated; a real 'no row yet' is still a base it writes on", async (code) => {
    const KEY = 'econ:treasury';
    // A contender (which also won a lease) stored today's rate while this instance was fetching.
    const contender = {
      cols: { '2 Yr': [['2026-09-28', 4.92], ['2026-09-29', 4.95], ['2026-09-30', 4.9]], '10 Yr': [['2026-09-28', 5.24], ['2026-09-29', 5.27], ['2026-09-30', 5.21]], '20 Yr': [['2026-09-28', 5.6], ['2026-09-29', 5.63], ['2026-09-30', 5.58]] },
      fetchedAt: T0 + 9_000, mergedAt: T0 + 9_000, attemptedAt: T0 + 1_000, failedAt: null, lease: 'contender',
    };
    let unboundedRead = false;
    const hang = (u, init) => new Promise((_, reject) => {
      const guard = setTimeout(() => { unboundedRead = true; reject(new Error('never aborted')); }, 3000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(guard); reject(init.signal.reason); }, { once: true });
    });
    for (const [name, failRead, extra] of [
      ['HTTP 500', () => new Response('{"message":"boom"}', { status: 500 })],
      ['timeout', hang, { timeoutScale: 0.01 }],
    ]) {
      // (a) Treasury answers (without today's rate); the contender writes; then the store stops answering reads
      const db = fakeDb();
      let snapshot = null;
      const x = boot(code, { db, ...extra, treasury: (m) => {
        if (!db.read) { db.seed(contender); snapshot = JSON.stringify(db.rows.get(KEY)); db.read = failRead; }
        return noTodayTsy(m);
      } });
      const rx = await x.call();
      eq([rx.status, x.fetchCount('home.treasury.gov'), db.writes()], [200, 2, 1], `${name}: fetched, and the lease is the ONLY write`);
      eq(JSON.stringify(db.rows.get(KEY)), snapshot, `${name}: the contender's row stands byte for byte (never overwritten from the pre-fetch snapshot)`);
      eq(YIELDS.map((id) => [row(rx, id).source, row(rx, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-29']), `${name}: this reply serves what this request validated`);
      // (b) Treasury down too: the failure is NOT recorded — the lease row stands as written, and the client
      //     is sent back when that lease frees (19:00 ET, so the quiet 15 min is what it would otherwise be)
      const g = fakeDb(), N = at('2026-09-30T23:00:00Z');
      const y = boot(code, { db: g, now: N, ...extra, treasury: () => { g.read ??= failRead; return new Response('upstream down', { status: 503 }); } });
      const ry = await y.call();
      eq([ry.status, y.fetchCount('home.treasury.gov'), g.writes()], [200, 2, 1], `${name}, Treasury down: attempted, and the lease is the ONLY write`);
      eq([g.payload().attemptedAt, g.payload().failedAt, g.payload().lease], [N, null, g.posts()[0].lease], `${name}, Treasury down: no failedAt written blind`);
      eq([YIELDS.map((id) => row(ry, id).source), ry.json.refreshInSec], [['fred', 'fred', 'fred'], 300], `${name}, Treasury down: FRED, back when the lease frees`);
    }
    eq(unboundedRead, false, 'the hung re-read was cut off by its own signal');
    // (c) the row vanished between the confirm and the final read: [] is "no row yet", a real base — written
    const db = fakeDb();
    const z = boot(code, { db, treasury: (m) => { db.rows.delete(KEY); return tsyResponse(m); } });
    const rz = await z.call();
    const p = db.payload();
    eq([db.writes(), Object.keys(p.cols).sort(), p.fetchedAt, p.lease], [2, ['10 Yr', '2 Yr', '20 Yr'], T0, db.posts()[0].lease], "'no row yet': the validated rows ARE written, under this request's lease");
    eq(YIELDS.map((id) => [row(rz, id).source, row(rz, id).asOf]), YIELDS.map(() => ['treasury', '2026-09-30']), "'no row yet': and served");
  }],

  ['REST hygiene: every desk_feed_cache call goes to SUPABASE_URL with the service key, NO user-agent at all, and a bounded signal; no env = FRED only', async (code) => {
    const e = boot(code);
    await e.call();
    const rest = e.calls.filter((c) => c.host === DB_HOST);
    eq(rest.map((c) => c.init.method || 'GET'), ['GET', 'GET', 'POST', 'GET', 'GET', 'POST'], 'read, re-read before the lease, lease, confirm, re-read before writing, merged write');
    for (const c of rest) {
      const h = new Headers(c.init.headers);
      eq([h.get('apikey'), h.get('authorization'), h.has('user-agent')], [SERVICE_KEY, `Bearer ${SERVICE_KEY}`, false], `${c.init.method || 'GET'}: service key, no user-agent`);
      assert(c.init.signal instanceof AbortSignal, 'a bounded call');
      assert(c.url.startsWith(`${DB_URL}/rest/v1/desk_feed_cache?`), c.url);
    }
    for (const c of rest.filter((x) => x.init.method === 'POST')) {
      eq([new URL(c.url).search, new Headers(c.init.headers).get('prefer')], ['?on_conflict=key', 'resolution=merge-duplicates'], 'an upsert on the key');
    }
    eq(rest.filter((x) => !x.init.method).map((c) => new URL(c.url).search), Array(4).fill('?select=at,payload&key=eq.econ:treasury'), 'reads select the one row');
    const other = boot(code, { denoEnv: { ...DENO_ENV, SUPABASE_URL: 'https://other.supabase.test' } });
    const ro = await other.call();
    eq([ro.status, other.calls.some((c) => c.host === 'other.supabase.test')], [200, true], 'the store is wherever SUPABASE_URL says');
    const none = boot(code, { denoEnv: {} });
    const rn = await none.call();
    eq([rn.status, YIELDS.map((id) => row(rn, id).source), none.fetchCount('home.treasury.gov')], [200, ['fred', 'fred', 'fred'], 0], 'no env: FRED only, no attempt, no throw');
  }],

  ['REAL Treasury rows (fetched from Supabase 2026-10-01) parse with \\n and \\r\\n, AGREE with the real FRED capture, and stitch onto it', async (code) => {
    const { api } = boot(code);
    const want = {
      '2 Yr': [['2026-09-28', 4.92], ['2026-09-29', 4.89], ['2026-09-30', 4.88]],
      '10 Yr': [['2026-09-28', 5.24], ['2026-09-29', 5.26], ['2026-09-30', 5.29]],
      '20 Yr': [['2026-09-28', 5.6], ['2026-09-29', 5.64], ['2026-09-30', 5.68]],
    };
    for (const [name, text] of [['LF', TSY_REAL.replace(/\r\n/g, '\n')], ['CRLF', TSY_REAL.replace(/\r?\n/g, '\r\n')]]) {
      const m = api.parseTreasuryCsv(text, '2026-09-30');
      eq(m.size, 14, `${name}: every tenor of the real header found by name, "1.5 Month" included`);
      for (const [col, obs] of Object.entries(want)) eq(m.get(col), obs, `${name}: ${col}`);
    }
    const m = api.parseTreasuryCsv(TSY_REAL, '2026-09-30');
    for (const [, fredId, col] of TSY_COLS) {
      const fred = new Map(refObs(fredId));
      const shared = m.get(col).filter(([d]) => fred.has(d));
      eq(shared.map(([d]) => d), ['2026-09-28'], `${col}: the real rows share 2026-09-28 with the FRED capture`);
      for (const [d, v] of shared) eq(v, fred.get(d), `${col} on ${d}: Treasury's real value equals FRED ${fredId}`);
      const st = api.stitchTreasury(api.parseFredCsv(FRED_TEXT[fredId]), m.get(col));
      eq([st.reason, st.fromTreasury, st.obs.slice(-3)], [null, 2, want[col]], `${col}: the real 09/29 and 09/30 append onto the real FRED capture`);
    }
  }],

  ['partial failure degrades ONE row; Treasury is never served without a FRED spine; missing is null, never 0', async (code) => {
    const e = boot(code, { fred: { DGS20: down(500) } });
    const r = await e.call({ range: '6m' });
    eq([r.status, r.json.ok], [200, true], 'the response survives');
    const x = row(r, 'ust20y');
    eq([x.status, x.value, x.prev, x.delta, x.asOf, x.prevAsOf, x.source, x.points, x.changed], ['missing', null, null, null, null, null, null, [], false], 'ust20y missing, all null');
    for (const y of r.json.rows.filter((z) => z.id !== 'ust20y')) eq(y.status, 'ok', `${y.id} unaffected`);
    const h = boot(code, { fred: { DGS10: () => new Response('<!DOCTYPE html>', { status: 200 }) } });
    const rh = await h.call();   // the Treasury tail HAS landed: still no row without a FRED spine
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
    eq([e.fetchCount('home.treasury.gov'), e.db.writes()], [0, 0], 'no FRED spine to check a Treasury file against: no ~20 s attempt, no lease spent, no failure recorded');
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
    // Through the handler on a roster that names no Treasury column: this is the NY-clock policy
    // alone (the Treasury retry cap inside the posting window is its own check, RETRY CAP).
    const fo = fredOnly(CONFIG);
    const q = boot(code, { config: fo, now: at('2026-09-30T13:20:00Z') });
    eq([(await q.call()).json.refreshInSec, (await q.call()).json.phase], [900, 'quiet'], 'quiet weekday through the handler');
    const w = boot(code, { config: fo, now: at('2026-10-03T16:00:00Z') });
    eq([(await w.call()).json.refreshInSec, (await w.call()).json.phase], [3600, 'weekend'], 'weekend heartbeat through the handler');
    const d = boot(code, { config: fo, now: at('2026-03-09T12:30:00Z') });
    eq((await d.call()).json.refreshInSec, 60, 'DST Monday 08:30 EDT through the handler');
    const o = boot(code, { config: fo, now: at('2026-09-30T12:20:00Z') });
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
    await e.call();   // the reference series carry the Treasury tail
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
    e.clock.now += 11 * 60_000; // past the back-off the store recorded
    e.opts.treasury = undefined;
    const r2 = await e.call();  // this request holds the lease: its own reply carries the rate
    eq(YIELDS.map((id) => [row(r2, id).asOf, row(r2, id).changed]), [['2026-09-30', true], ['2026-09-30', true], ['2026-09-30', true]], 'the Treasury print is a change (on the same instance)');
    assert(OTHERS.every((id) => row(r2, id).changed === false), 'unchanged rows say false');
    e.clock.now += 120_000;
    const r3 = await e.call();
    assert(r3.json.rows.every((x) => x.changed === false), 'the next refresh with nothing new says false');
    // ...and since every live request runs on a FRESH instance (measured 2026-10-01), this is what production sees:
    const g = boot(code, { db: e.db, now: e.clock.now });
    assert((await g.call()).json.rows.every((x) => x.changed === false), 'a fresh instance always says false: `changed` is a hint, the client keys NEW on asOf');
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
    const by = (h) => e.fetchCount(h);
    eq([by('akyachtsman.github.io'), by('fred.stlouisfed.org'), by('home.treasury.gov'), by(DB_HOST), e.calls.length], [1, 7, 2, 6, 16],
      "the committed roster's first sweep: 1 config + 7 FRED + 2 Treasury (current + previous NY month) + 6 store calls");
    for (const c of e.calls) {
      assert(c.init.signal instanceof AbortSignal, `${c.host}: AbortSignal`);
      const h = new Headers(c.init.headers);
      assert(['fred.stlouisfed.org', 'home.treasury.gov', 'akyachtsman.github.io', DB_HOST].includes(c.host), `host ${c.host}`);
      if (c.host === DB_HOST) continue;   // the store's own rules: the REST hygiene check
      assert(/desk econ/.test(h.get('user-agent') || ''), `${c.host}: UA`);
      assert(!h.has('apikey') && !h.has('authorization'), `${c.host}: no key sent upstream`);
    }
    const fred = e.calls.filter((c) => c.host === 'fred.stlouisfed.org').map((c) => new URL(c.url).searchParams.get('cosd'));
    eq([...new Set(fred)], [COSD_T0], 'FRED history starts 76 months back (5y + YoY base + lag)');
    eq(e.calls.filter((c) => c.host === 'home.treasury.gov').map((c) => new URL(c.url).searchParams.get('field_tdr_date_value_month')).sort(), ['202608', '202609'], 'Treasury: current + previous NY month');
  }],

  ['force is honoured at most once per 30s (and never bypasses the Treasury lease); Treasury backs off after a failure and a kept print never flips back, across instances', async (code) => {
    const e = boot(code);
    await e.call();   // today's rate fetched and held
    const fred = () => e.fetchCount('fred.stlouisfed.org'), tsy = () => e.fetchCount('home.treasury.gov');
    const [f0, t0] = [fred(), tsy()];
    e.clock.now += 10_000;
    await e.call({ force: true });
    await e.call({ force: true });
    eq([fred(), tsy()], [f0 + 7, t0], 'first force re-sweeps every FRED series; Treasury follows the shared lease (today\'s rate is held)');
    e.clock.now += 10_000;
    await e.call({ force: true });
    eq(fred(), f0 + 7, 'a second force inside 30s is a cached read');
    e.clock.now += 25_000;
    await e.call({ force: true });
    eq(fred(), f0 + 14, 'honoured again once 30s have passed');
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
    k.clock.now += 21.5 * 3_600_000; // 15:30 ET on Oct 1: the next window, today's rate missing, so an attempt is due
    k.opts.treasury = down(503);
    const kr = row(await k.call(), 'ust10y');
    eq(k.fetchCount('home.treasury.gov'), 4, 'the attempt was made, and failed');
    eq([kr.asOf, kr.source, kr.value, kr.status], ['2026-09-30', 'treasury', 5.21, 'ok'], 'a failed Treasury fetch keeps the validated print (no flip back to T-2)');
    const k2 = boot(code, { db: k.db, now: k.clock.now + 60_000, treasury: down(503) });
    const kept = row(await k2.call(), 'ust10y');
    eq([kept.asOf, kept.source, k2.fetchCount('home.treasury.gov')], ['2026-09-30', 'treasury', 0], 'and so does a DIFFERENT instance, backing off without an attempt');
  }],

  ['a degraded feed retries fast even in a quiet period', async (code) => {
    // A roster that names no Treasury column: this is the degraded-row rule alone.
    const e = boot(code, { config: fredOnly(CONFIG), now: at('2026-09-30T13:20:00Z'), fred: { DGS20: down(503) } });
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
  ['degraded feed waits the full quiet TTL', 'let ttl = degraded ? Math.min(policy.ttlMs, DEGRADED_TTL_MS) : policy.ttlMs;', 'let ttl = policy.ttlMs;'],
  ['built-in default re-blanks the 10Y Treasury column (the fallback silently goes FRED-only)', "sources: { fred: 'DGS10', treasury: '10 Yr' }", "sources: { fred: 'DGS10' }"],
  ['built-in default names the wrong tenor on the 20Y row', "sources: { fred: 'DGS20', treasury: '20 Yr' }", "sources: { fred: 'DGS20', treasury: '30 Yr' }"],
  // the shared Treasury store under a lease (v3, 2026-10-01)
  ['Treasury never attempted although rows name a column', 'const tsy = seen ? await treasuryCycle(now, today, roster.rows, seen) : null;', 'const tsy = seen ? { store: working(seen), row: seen } : null;'],
  ['the store read although no row names a Treasury column', 'const wantsTreasury = roster.rows.some((r) => r.treasury);', 'const wantsTreasury = true;'],
  ['the old 5 s Treasury timeout (Treasury answers Supabase in 17-20 s)', 'const TREASURY_TIMEOUT_MS = 45_000;', 'const TREASURY_TIMEOUT_MS = 5_000;'],
  ['lease check removed (an attempt on every request that finds today missing)', 'return now - row.attemptedAt >= TREASURY_POSTING_EVERY_MS;', 'return true;'],
  ['the lease is not confirmed (two racing instances both fetch)', 'if (!mine || mine.lease !== lease.lease) return done(mine ?? latest, mine ?? lease);', 'if (!mine) return done(latest, lease);'],
  ['no re-read before taking the lease (a stale first read refetches what just landed)', 'if (!treasuryWanted(now, today, rows, latest)) return done(latest);', 'if (!latest.cols) return done(latest);'],
  ['attemptedAt not written before the fetch (the lease row does not move the clock)', 'const lease: StoreRow = { ...latest, attemptedAt: now, lease: `${now}-${Math.random().toString(36).slice(2, 10)}` };', 'const lease: StoreRow = { ...latest, lease: `${now}-${Math.random().toString(36).slice(2, 10)}` };'],
  ['the fetch made fire-and-forget (not awaited by the lease holder)', 'const good = await fetchTreasuryMonths(today);', 'const good: Map<string, Obs[]>[] = []; void fetchTreasuryMonths(today);'],
  ['write-before-validate (a column that disagrees with FRED is stored)', 'if (s.reason === null) agreed.set(r.treasury, col);', 'if (s.reason === null || true) agreed.set(r.treasury, col);'],
  ['garbage not recorded as a failure (no shared back-off after a mislabelled file)', 'if (!agreed.size) {', 'if (!good.length) {'],
  ['the store read ignored (every read says "no row yet")', 'return rows.length ? storeRowFrom(rows[0]?.payload, now, today) : null;', 'return null;'],
  ['a failure not recorded (no back-off shared between instances)', 'const failed = { ...cur, failedAt: Date.now() };', 'const failed = { ...cur };'],
  ["a racer's stale failure clobbers a fresher row", 'if (cur?.lease === lease.lease) {', 'if (cur) {'],
  ['the recorded back-off ignored', 'if (row.failedAt !== null && now - row.failedAt < TREASURY_BACKOFF_MS) return false;', 'if (row.failedAt === -1) return false;'],
  ["today's-row stop removed (attempted again all evening)", 'if (treasuryHeld(row, rows, today)) return false;', 'if (rows.length < 0) return false;'],
  ['a stored "today" that disagrees with FRED counts as final', 'return !spine || stitchTreasury(spine, col).reason === null;', 'return true;'],
  ['an attempt with no FRED spine to check it against (FRED down: a pointless ~20 s fetch)', 'if (!rows.some((r) => r.treasury && fredStore.has(r.fred))) return false;', 'if (rows.length < 0) return false;'],
  ['a browser UA on the desk_feed_cache REST call (the gateway then refuses the key)', "return { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };", "return { ...UA, apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };"],
  ['stored stamps from the future trusted (a corrupt failedAt blocks Treasury for good)', 'const stamp = (v: unknown) => (typeof v === \'number\' && Number.isFinite(v) && v > 0 && v <= now + STORE_SKEW_MS ? v : null);', 'const stamp = (v: unknown) => (typeof v === \'number\' && Number.isFinite(v) && v > 0 ? v : null);'],
  ['stored dates after today trusted', "if (typeof d !== 'string' || !ISO_RE.test(d) || d > today || d < floor) continue;", "if (typeof d !== 'string' || !ISO_RE.test(d) || d < floor) continue;"],
  ['posting-window cadence shortened to 1 min', 'return now - row.attemptedAt >= TREASURY_POSTING_EVERY_MS;', 'return now - row.attemptedAt >= 60_000;'],
  ['5-minutely outside the posting window instead of hourly (a failing host)', 'return now - row.attemptedAt >= TREASURY_IDLE_EVERY_MS;', 'return now - row.attemptedAt >= TREASURY_POSTING_EVERY_MS;'],
  ['a failing host outside the window asked on every request', 'return now - row.attemptedAt >= TREASURY_IDLE_EVERY_MS;', 'return true;'],
  ['the old hourly-regardless rule outside the window (fetchedAt not consulted)', 'if (row.fetchedAt >= lastPostingStart(now) && treasuryCovers(row, rows)) return false;', 'if (row.fetchedAt < 0 && treasuryCovers(row, rows)) return false;'],
  ['fetchedAt ignored: any attempt since the window opened, even a failed one, stops asking', 'if (row.fetchedAt >= lastPostingStart(now) && treasuryCovers(row, rows)) return false;', 'if (row.attemptedAt >= lastPostingStart(now) && treasuryCovers(row, rows)) return false;'],
  ['window start wrong over a weekend (Sat/Sun counted as weekdays)', "if (w.dow !== 'Sat' && w.dow !== 'Sun' && w.sec >= WINDOWS[1].from) return t - (w.sec - WINDOWS[1].from) * 1000;", 'if (w.sec >= WINDOWS[1].from) return t - (w.sec - WINDOWS[1].from) * 1000;'],
  ["window start off by a day (today's 15:25 even before it)", 't -= (w.sec + 1) * 1000;', 'return t + (WINDOWS[1].from - w.sec) * 1000;'],
  ['posting window stops at 18:30 (a late post waits an hour)', "return w.dow !== 'Sat' && w.dow !== 'Sun' && w.sec >= WINDOWS[1].from;", "return w.dow !== 'Sat' && w.dow !== 'Sun' && w.sec >= WINDOWS[1].from && w.sec < WINDOWS[1].to;"],
  ['a Treasury tail sharing no date with FRED is trusted', "if (!overlap) return { obs: spine, fromTreasury: 0, reason: 'treasury: no overlap with FRED to cross-check' };", "if (overlap < 0) return { obs: spine, fromTreasury: 0, reason: 'treasury: no overlap with FRED to cross-check' };"],
  ['upstream fetch left unbounded (a hung Treasury host hangs the sweep)', 'const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });', 'const res = await fetch(url, { headers: UA });'],
  // Codex review of v3 (PR #296): final re-read failure, the retry cap after 18:30 ET, partial success
  ["a FAILED final re-read read as 'no row yet' (the pre-fetch snapshot overwrites a contender's fresher row)", 'try { cur = await readTreasuryRow(now, today); } catch { curFailed = true; }', 'try { cur = await readTreasuryRow(now, today); } catch { cur = null; }'],
  ['a failed final re-read still writes the fetched rows', 'if (curFailed) {', 'if (false) {'],
  ['a failed FINAL write times the client from the unsaved row (the retry cap lifts after 18:30 ET)', 'return stored ? done(next) : done(next, cur ?? lease);', 'return done(next);'],
  ["'no row yet' on the final re-read treated as a failure (a first fetch is never stored)", 'try { cur = await readTreasuryRow(now, today); } catch { curFailed = true; }', 'try { cur = await readTreasuryRow(now, today); curFailed = !cur; } catch { curFailed = true; }'],
  ['a failed final re-read on the failure path times the client from the pre-lease row (back in 30 s, not when the lease frees)', 'if (curFailed) return done(latest, lease);', 'if (curFailed) return done(latest);'],
  ['no retry cap: after 18:30 ET a pending rate waits the quiet 15 min', 'if (retry !== null) ttl = Math.min(ttl, retry);', 'if (retry === -1) ttl = Math.min(ttl, retry);'],
  ['the retry cap ignores the back-off (clients poll every 5 min into a 10-min back-off)', 'if (row.failedAt !== null) due = Math.max(due, row.failedAt + TREASURY_BACKOFF_MS);', 'if (row.failedAt === -1) due = Math.max(due, row.failedAt + TREASURY_BACKOFF_MS);'],
  ["the retry cap kept once today's rate is held", 'if (treasuryHeld(row, rows, today)) return null;', 'if (rows.length < 0) return null;'],
  ['the retry cap applied outside the posting window', 'if (!treasuryPosting(now)) return null;', 'if (rows.length < 0) return null;'],
  ['fetchedAt advanced on a PARTIAL success (the missing yield then waits for the next window)', 'fetchedAt: complete ? at : base.fetchedAt', 'fetchedAt: at'],
  ['mergedAt not stamped on a merge (a partial store is dropped by the 72h keep at once)', 'mergedAt: at,', 'mergedAt: base.mergedAt,'],
  ['the 72h keep measured from fetchedAt only', 'const keptAt = (r: StoreRow) => Math.max(r.mergedAt, r.fetchedAt);', 'const keptAt = (r: StoreRow) => r.fetchedAt;'],
  ['mergedAt not read back from the store', 'row.mergedAt = stamp(o.mergedAt) ?? 0;', 'row.mergedAt = 0;'],
  // Codex round 3 (PR #296): a roster change after a complete fetch, and a failure record that is not stored
  ['fetchedAt honoured although the roster has since gained a Treasury column the store lacks', 'if (row.fetchedAt >= lastPostingStart(now) && treasuryCovers(row, rows)) return false;', 'if (row.fetchedAt >= lastPostingStart(now)) return false;'],
  ['a missing column counts as covered (a tenor added on a weekend waits for Monday)', 'if (!col) return false;\n    const spine = fredStore.get(r.fred)?.obs;\n    return spine ?', 'if (!col) return true;\n    const spine = fredStore.get(r.fred)?.obs;\n    return spine ?'],
  ['a stored column that no longer agrees with its (repointed) FRED spine counts as covered', 'return spine ? stitchTreasury(spine, col).reason === null : true;', 'return true;'],
  ['a failure record that was not stored still times the client from the unsaved 10-min back-off', 'return (await writeTreasuryRow(failed)) ? done(cur, failed) : done(cur);', 'return (await writeTreasuryRow(failed), done(cur, failed));'],
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
    let mutated;
    try { mutated = transpile(src.replace(find, () => repl)); }
    catch { console.log(`  INVALID   ${name} (the mutant does not transpile)`); exit = 1; continue; }
    const f = await runSuite(mutated);
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
