/* Unit tests for desk-layers (supabase/functions/desk-layers), the Layers Heat Map's daily feed, and for
   layersDecode in scripts/layers.js, which reads what it serves.

     node --test tools/unit/desk-layers.test.mjs     (needs `npm ci --prefix tools` once)

   The function is loaded into a fresh `vm` context (lib.mjs `loadEdge`); `fetch` is a stub that records every call,
   so nothing reaches Yahoo, FRED, GitHub or the live Supabase project. The round trip at the end encodes real-shaped
   bars with the FUNCTION's encoder and decodes them with the PAGE's decoder, then scores both with layersScore. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { loadEdge, loadData } from './lib.mjs';

const NAMES = ['targetSession', 'settleMs', 'nyWallMs', 'isTradingDay', 'parseConstituents', 'watchSymbols', 'parseChart',
  'parseFredCsv', 'parseFearGreed', 'encodeBars', 'buildPayload', 'isIn', 'rosterSymbols', 'MARKET', 'SECTOR_FUNDS',
  'YAHOO_SECTORS', 'yahooTicker'];
const edge = (opts = {}) => loadEdge('desk-layers', NAMES, opts);
const page = () => loadData({ now: Date.parse('2026-11-14T02:00:00Z'), also: ['scripts/layers.js'] });
const J_ = (x) => JSON.parse(JSON.stringify(x));
const at = (iso) => Date.parse(iso);

// ── the calendar ─────────────────────────────────────────────────────────────
test('"today" is the last session whose close has settled (16:15 ET)', () => {
  const e = edge();
  const T = (iso) => e.targetSession(new Date(iso));
  assert.equal(T('2026-11-13T21:14:00Z'), '2026-11-12');   // Fri 16:14 EST
  assert.equal(T('2026-11-13T21:15:00Z'), '2026-11-13');   // Fri 16:15 EST
  assert.equal(T('2026-11-14T15:00:00Z'), '2026-11-13');   // Saturday
  assert.equal(T('2026-11-16T14:00:00Z'), '2026-11-13');   // Monday morning
  assert.equal(T('2026-11-26T23:00:00Z'), '2026-11-25');   // Thanksgiving evening
  assert.equal(T('2026-07-06T20:15:00Z'), '2026-07-06');   // 16:15 EDT
  assert.equal(T('2026-07-06T20:14:00Z'), '2026-07-02');   // before it: Friday the 3rd is a holiday
});
test('the settle instant reads 16:15 on New York\'s wall clock in summer and winter', () => {
  const e = edge();
  assert.equal(e.settleMs('2026-11-13'), at('2026-11-13T21:15:00Z'));
  assert.equal(e.settleMs('2026-07-06'), at('2026-07-06T20:15:00Z'));
  assert.equal(e.nyWallMs('2026-03-09', 16, 15), at('2026-03-09T20:15:00Z'));   // the Monday after the change
});

// ── the roster ───────────────────────────────────────────────────────────────
const SECTORS = ['Information Technology', 'Financials', 'Health Care', 'Energy'];
const csv = (extra = '') => 'Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location\n'
  + Array.from({ length: 410 }, (_, i) => `S${i},Company ${i},${SECTORS[i % 4]},Sub ${i},"City, State"`).join('\n') + '\n' + extra;
test('the S&P 500 roster keeps members of the eleven sectors, once each, with valid tickers', () => {
  const e = edge();
  const m = e.parseConstituents(csv('BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings,"Omaha, Nebraska"\nS1,Twice,Energy,X,Y\nbad sym!,Bad,Energy,X,Y\nZZZ,Nowhere,Not A Sector,X,Y\n'));
  assert.equal(m.length, 411);
  const b = m.find((x) => x.sym === 'BRK.B');
  assert.deepEqual(J_(b), { sym: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financials', sub: 'Multi-Sector Holdings' });
  assert.equal(m.filter((x) => x.sym === 'S1').length, 1);
  assert.ok(!m.some((x) => x.sym === 'ZZZ'));
  assert.throws(() => e.parseConstituents('Symbol,Security,GICS Sector\nAAA,A,Energy\n'), /only 1 usable/);
  assert.throws(() => e.parseConstituents('Ticker,Name\nAAA,A\n'), /missing symbol/);
});
test('the watchlists give validated, deduped, non-S&P tickers in order, capped — never a title', () => {
  const e = edge();
  const rows = [
    { title: 'Ignore me <b>', symbols: ['aapl', ' PLTR ', 'PLTR', 'not a ticker!', 'QQQ', null, 42] },
    { title: 'Two', symbols: ['^GSPC', 'BTC-USD', 'HOOD'] },
    { title: 'bad' },
  ];
  assert.deepEqual(J_(e.watchSymbols(rows, new Set(['AAPL']))), ['PLTR', 'QQQ', '42', '^GSPC', 'BTC-USD', 'HOOD']);
  assert.deepEqual(J_(e.watchSymbols(rows, new Set(['AAPL']), 2)), ['PLTR', 'QQQ']);
  assert.deepEqual(J_(e.watchSymbols(null, new Set())), []);
  const syms = e.rosterSymbols({ members: [{ sym: 'AAPL' }, { sym: 'SPY' }], watch: ['PLTR', 'XLK'] });
  assert.equal(new Set(syms).size, syms.length);
  for (const s of ['BZ=F', 'DX-Y.NYB', '^TNX', '^VIX', 'SPY', '^GSPC', 'XLK', 'XLRE', 'AAPL', 'PLTR']) assert.ok(syms.includes(s), s);
});
test('the eleven sectors and funds are the scorer\'s own table, and Yahoo\'s sector names map onto them', () => {
  const e = edge(), d = page();
  assert.deepEqual(J_(e.SECTOR_FUNDS), J_(d.LAYERS_SECTORS));
  const gics = new Set(J_(d.LAYERS_SECTORS).map((s) => s[0]));
  assert.equal(Object.keys(e.YAHOO_SECTORS).length, 11);
  for (const v of Object.values(e.YAHOO_SECTORS)) assert.ok(gics.has(v), v);
  assert.equal(new Set(Object.values(e.YAHOO_SECTORS)).size, 11);
  assert.deepEqual(J_(Object.keys(e.MARKET)).sort(), ['acwx', 'brent', 'dxy', 'gspc', 'hyg', 'ief', 'spy', 'tnx', 'vix']);
  assert.equal(e.yahooTicker('brk.b'), 'BRK-B');
  assert.equal(e.yahooTicker('BF.B'), 'BF-B');
  assert.equal(e.yahooTicker('DX-Y.NYB'), 'DX-Y.NYB', 'an exchange suffix keeps its dot');
  for (const sym of J_(Object.values(e.MARKET))) if (!/\.[A-Z]$/.test(sym)) assert.equal(e.yahooTicker(sym), sym);
});

// ── Yahoo's chart reply ──────────────────────────────────────────────────────
const secs = (iso, hh = 14, mm = 30) => Math.floor(Date.parse(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`) / 1000);
function chart(days, { type = 'EQUITY', currency = 'USD', adj = true, tweak = {} } = {}) {
  const q = { open: [], high: [], low: [], close: [], volume: [] }, a = [];
  days.forEach((d, i) => {
    const c = 100 + i;
    q.open.push(c - 0.5); q.high.push(c + 1.004); q.low.push(c - 1.006); q.close.push(c); q.volume.push(1000 + i);
    a.push(i < 3 ? c * 0.98 : c);
  });
  for (const [k, [i, v]] of Object.entries(tweak)) (k === 'adj' ? a : q[k])[i] = v;
  return { chart: { result: [{ meta: { instrumentType: type, currency, longName: 'Long Name Inc.' }, timestamp: days.map((d) => secs(d)),
    indicators: { quote: [q], ...(adj ? { adjclose: [{ adjclose: a }] } : {}) } }] } };
}
const DAYS = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'];
test('a chart reply becomes bars through the target day, rounded to cents, bad bars dropped', () => {
  const e = edge();
  const got = e.parseChart(chart(DAYS, { tweak: { close: [1, null], low: [2, 0] } }), '2026-11-13');
  assert.deepEqual(J_(got.meta), { type: 'EQUITY', currency: 'USD', name: 'Long Name Inc.' });
  assert.deepEqual(J_(got.bars.t), ['2026-11-09', '2026-11-12', '2026-11-13']);   // null close, zero low, and Monday after the target: gone
  assert.deepEqual(J_(got.bars.h), [101, 104, 105]);
  assert.deepEqual(J_(got.bars.l), [98.99, 101.99, 102.99]);
  assert.deepEqual(J_(got.bars.a), [98, 103, 104]);
  assert.deepEqual(J_(got.bars.v), [1000, 1003, 1004]);
  assert.equal(e.parseChart(chart(DAYS), '2026-11-16', 2).bars.t.length, 2);
  assert.equal(e.parseChart(chart(DAYS, { adj: false }), '2026-11-16').bars.a, null);
  assert.equal(e.parseChart({ chart: { result: null } }, '2026-11-16'), null);
  assert.equal(e.parseChart('junk', '2026-11-16'), null);
});
test('FRED and Fear & Greed files: holes stay holes, newest last, nothing past the target', () => {
  const e = edge();
  assert.deepEqual(J_(e.parseFredCsv('observation_date,UNRATE\n2026-08-01,4.3\n2026-09-01,.\n2026-10-01,\n2026-07-01,4.2\n')), [['2026-07-01', 4.2], ['2026-08-01', 4.3]]);
  assert.throws(() => e.parseFredCsv('<html>'), /not a series/);
  const fg = 'Date,Fear Greed,Rating\n2026-11-11,35.94,fear\n2026-11-12,,x\n2026-11-13,38.6,fear\n2026-11-16,50,neutral\n2026-11-10,140,bad\n';
  assert.deepEqual(J_(e.parseFearGreed(fg, '2026-11-13')), [['2026-11-11', 35.9], ['2026-11-13', 38.6]]);
});

// ── progress ─────────────────────────────────────────────────────────────────
test('a symbol is in once fetched after the settle with the target day, or long enough after it', () => {
  const e = edge();
  const s = at('2026-11-13T21:15:00Z');
  assert.equal(e.isIn(undefined, '2026-11-13'), false);
  assert.equal(e.isIn({ at: s - 1, last: '2026-11-13' }, '2026-11-13'), false);    // fetched before the settle
  assert.equal(e.isIn({ at: s + 1, last: '2026-11-13' }, '2026-11-13'), true);
  assert.equal(e.isIn({ at: s + 60_000, last: '2026-11-12' }, '2026-11-13'), false); // Yahoo late: ask again
  assert.equal(e.isIn({ at: s + 2 * 3600_000, last: '2026-11-12' }, '2026-11-13'), true);   // a halted stock
  assert.equal(e.isIn({ at: s + 1, last: '' }, '2026-11-13'), true);                // answered: no such symbol
});

// ── the encoding: the function's encoder, the page's decoder ────────────────
test('encoded bars decode to the same bars: shared calendar, skipped days, own dates, dividend runs', () => {
  const e = edge(), d = page();
  const cal = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
  const calIdx = new Map(cal.map((x, i) => [x, i]));
  const b = { t: ['2026-11-10', '2026-11-12', '2026-11-13'], o: [10.5, 11.01, 9.99], h: [11, 11.5, 10.2], l: [10, 10.9, 9.5], c: [10.75, 11.2, 10.01], a: [10.54, 10.98, 10.01], v: [5, 0, 7_000_000_000] };
  const enc = e.encodeBars(b, calIdx);
  assert.equal(enc.t0, 1);
  assert.deepEqual(J_(enc.sk), [2]);
  assert.deepEqual(J_(enc.c), [1075, 45, -119]);
  assert.equal(enc.af.length, 2);                       // one factor before the ex-dividend day, 1 after
  const back = J_(d.layersDecodeBars(J_(enc), cal));
  assert.deepEqual(back, b);
  const own = e.encodeBars({ ...b, t: ['2026-11-10', '2026-11-11', '2026-11-14'] }, calIdx);   // a date the calendar lacks
  assert.deepEqual(J_(own.t), ['2026-11-10', '2026-11-11', '2026-11-14']);
  assert.deepEqual(J_(d.layersDecodeBars(J_(own), cal)).t, ['2026-11-10', '2026-11-11', '2026-11-14']);
  const noAdj = e.encodeBars({ ...b, a: null }, calIdx);
  assert.equal(noAdj.af, undefined);
  assert.equal(J_(d.layersDecodeBars(J_(noAdj), cal)).a, undefined);
  const plainA = e.encodeBars({ ...b, a: b.c.slice() }, calIdx);
  assert.equal(plainA.af, undefined);                   // a factor of 1 throughout is not sent
  // a one-cent difference (Yahoo's own rounding) is kept to the cent, never smoothed over
  const cent = { t: ['2026-11-11', '2026-11-12', '2026-11-13'], o: [100, 200, 300], h: [100, 200, 300], l: [100, 200, 300], c: [100, 200, 300], a: [98, 196, 294.01], v: [1, 1, 1] };
  assert.deepEqual(J_(d.layersDecodeBars(J_(e.encodeBars(cent, calIdx)), cal)).a, [98, 196, 294.01]);
});
test('the decoder drops a broken series instead of half-building it', () => {
  const d = page();
  const cal = ['2026-11-12', '2026-11-13'];
  const ok = { t0: 0, c: [100, 1], o: [0, 0], h: [1, 1], l: [-1, -1], v: [1, 2] };
  assert.ok(d.layersDecodeBars(ok, cal));
  assert.equal(d.layersDecodeBars({ ...ok, o: [0] }, cal), null);           // lengths disagree
  assert.equal(d.layersDecodeBars({ ...ok, t0: 1 }, cal), null);            // runs off the calendar
  assert.equal(d.layersDecodeBars({ ...ok, c: [100, 'x'] }, cal), null);
  assert.equal(d.layersDecodeBars({ ...ok, t0: undefined, t: ['2026-11-12', 'junk'] }, cal), null);
  assert.equal(d.layersDecodeBars(null, cal), null);
  assert.throws(() => d.layersDecode({ asOf: 'x', cal: [] }), /not a Layers payload/);
});

// ── the payload ──────────────────────────────────────────────────────────────
const bars = (t, base = 100) => ({ t, o: t.map((_, i) => base + i), h: t.map((_, i) => base + i + 1), l: t.map((_, i) => base + i - 1), c: t.map((_, i) => base + i + 0.5), a: t.map((_, i) => base + i + 0.5), v: t.map(() => 1000) });
const row = (type, t, extra = {}) => ({ last: t[t.length - 1], meta: { type, currency: 'USD', name: extra.name || '' }, bars: bars(t), ...extra });
test('the payload: S&P members by the CSV, watchlist names by Yahoo, and every left-out name says why', () => {
  const e = edge(), d = page();
  const t = ['2026-11-11', '2026-11-12', '2026-11-13'];
  const rows = new Map([
    ['AAA', row('EQUITY', t)], ['SPY', row('ETF', t)], ['BZ=F', row('FUTURE', ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'].slice(0, 3))],
    ['XLK', row('ETF', t)],
    ['PLTR', row('EQUITY', t, { name: 'Palantir', sector: 'Technology', ind: 'Software' })],
    ['QQQ', row('ETF', t, { name: 'Invesco QQQ' })], ['^GSPC', row('INDEX', t)],
    ['SHOP', { ...row('EQUITY', t, { name: 'Shopify' }), meta: { type: 'EQUITY', currency: 'CAD', name: 'Shopify' } }],
    ['ODD', row('EQUITY', t, { name: 'Odd Co', sector: 'Conglomerates' })],
    ['BTC-USD', row('CRYPTOCURRENCY', t, { name: 'Bitcoin' })],
    ['GONE', { last: '', err: 'no such symbol' }],
  ]);
  const roster = { members: [{ sym: 'AAA', name: 'Aaa Corp', sector: 'Energy', sub: 'Oil' }, { sym: 'BBB', name: 'Bbb', sector: 'Energy', sub: '' }],
    watch: ['PLTR', 'QQQ', '^GSPC', 'SHOP', 'ODD', 'BTC-USD', 'GONE'] };
  const p = e.buildPayload('2026-11-13', roster, rows, { fred: { core: [['2026-09-01', 330]] }, fg: [['2026-11-13', 38.6]] }, '2026-11-13T22:00:00Z');
  assert.deepEqual(J_(p.stocks.map((s) => [s.s, s.sec, s.sp])), [['AAA', 'Energy', 1], ['PLTR', 'Information Technology', 0]]);
  assert.deepEqual(J_(p.excluded.map((x) => [x.sym, x.why])), [
    ['BBB', 'no price data'], ['QQQ', 'a fund'], ['^GSPC', 'an index'], ['SHOP', 'not priced in dollars'],
    ['ODD', 'its sector does not map to one of the eleven'], ['BTC-USD', 'not a single stock'], ['GONE', 'no price data']]);
  assert.deepEqual(J_(p.cal), t);
  assert.ok(p.market.spy && p.market.brent && p.funds.XLK && !p.funds.XLF);
  assert.equal(p.fgLast, '2026-11-13');
  const input = J_(d.layersDecode(J_(p)));
  assert.equal(input.source, 'live');
  assert.equal(input.stocks[1].name, 'Palantir');
  assert.equal(input.stocks[1].sub, 'Software');
  assert.deepEqual(input.fred.core, [{ d: '2026-09-01', v: 330 }]);
  assert.deepEqual(input.fearGreed, [{ d: '2026-11-13', v: 38.6 }]);
  assert.deepEqual(input.market.spy.c, [100.5, 101.5, 102.5]);
});
test('round trip: the demo input, encoded by the feed and decoded by the page, scores exactly the same', () => {
  const e = edge(), d = page();
  const demo = J_(d.buildDemoLayersInput(new Date('2026-11-14T02:00:00Z')));
  const r2 = (x) => Math.round(x * 100) / 100;
  const round = (b) => ({ t: b.t, o: b.o.map(r2), h: b.h.map(r2), l: b.l.map(r2), c: b.c.map(r2), a: b.a ? b.a.map(r2) : null, v: (b.v || b.c.map(() => 0)).map(Math.round) });
  const full = (b) => ({ ...b, o: b.o || b.c, h: b.h || b.c, l: b.l || b.c, v: b.v || b.c.map(() => 0) });
  const rows = new Map();
  const members = [];
  for (const s of demo.stocks) { rows.set(s.sym, { last: s.bars.t.at(-1), meta: { type: 'EQUITY', currency: 'USD', name: s.name }, bars: round(s.bars) }); if (s.sp) members.push({ sym: s.sym, name: s.name, sector: s.sector, sub: s.sub }); }
  for (const [k, sym] of Object.entries(e.MARKET)) if (demo.market[k]) rows.set(sym, { last: '', meta: {}, bars: round(full(demo.market[k])) });
  for (const [, f] of J_(e.SECTOR_FUNDS)) rows.set(f, { last: '', meta: {}, bars: round(full(demo.funds[f])) });
  const macro = { fred: { core: demo.fred.core.map((x) => [x.d, x.v]), unrate: demo.fred.unrate.map((x) => [x.d, x.v]), payems: demo.fred.payems.map((x) => [x.d, x.v]) }, fg: demo.fearGreed.map((x) => [x.d, x.v]) };
  const p = J_(e.buildPayload(demo.asOf, { members, watch: [] }, rows, macro, 'now'));
  // the same input, rounded the way the feed rounds, scored directly
  const direct = { ...demo, stocks: demo.stocks.filter((s) => s.sp).map((s) => ({ ...s, bars: round(s.bars) })), excluded: [],
    market: Object.fromEntries(Object.entries(demo.market).map(([k, b]) => [k, round(full(b))])),
    funds: Object.fromEntries(Object.entries(demo.funds).map(([k, b]) => [k, round(full(b))])) };
  const a = d.layersScore(direct), b = d.layersScore(d.layersDecode(p));
  assert.ok(a.stocks.length > 40);
  assert.equal(b.stocks.length, a.stocks.length);
  assert.equal(b.breadth, a.breadth);
  for (let i = 0; i < a.stocks.length; i++) {
    const x = a.stocks[i], y = b.stocks[i];
    assert.deepEqual([y.sym, y.L, y.S, y.eff, J_(y.sig)], [x.sym, x.L, x.S, x.eff, J_(x.sig)], x.sym);
  }
  for (const k of ['A', 'B', 'C', 'D']) assert.deepEqual(J_(b.outer[k]), J_(a.outer[k]), k);
});

// ── the request ──────────────────────────────────────────────────────────────
const ENV = { SUPABASE_URL: 'https://store.test', SUPABASE_SERVICE_ROLE_KEY: 'sk_test' };
function stubStore(seed = {}) {
  const rows = new Map(Object.entries(seed));
  const calls = [];
  const box = { clock: null, failRows: false, failWatch: false };   // clock: set once the function is loaded, each chart then costs 400 ms of it
  const fetch = async (u, init = {}) => {
    const url = String(u);
    calls.push({ url, init });
    if (url.startsWith('https://store.test/rest/v1/desk_feed_cache')) {
      const hasUA = Object.keys(init.headers || {}).some((k) => k.toLowerCase() === 'user-agent');
      if (hasUA) return new Response('{"message":"Forbidden use of secret API key in browser"}', { status: 401 });
      if (init.method === 'POST' && box.failRows && JSON.parse(init.body).some((r) => r.key.startsWith('layers:y:'))) return new Response('{}', { status: 500 });
      if (init.method === 'POST') { for (const r of JSON.parse(init.body)) rows.set(r.key, { at: r.at, payload: r.payload }); return new Response(null, { status: 201 }); }
      const q = new URL(url).searchParams;
      const keyQ = q.get('key') || '';
      let keys = [...rows.keys()];
      if (keyQ.startsWith('in.(')) { const want = keyQ.slice(4, -1).split(',').map((k) => k.replace(/"/g, '')); keys = keys.filter((k) => want.includes(k)); }
      if (keyQ.startsWith('like.')) { const pre = keyQ.slice(5, -1); keys = keys.filter((k) => k.startsWith(pre)); }
      return Response.json(keys.map((k) => ({ key: k, at: rows.get(k).at, payload: rows.get(k).payload,
        last: rows.get(k).payload?.last ?? null, sector: rows.get(k).payload?.sector ?? null, ind: rows.get(k).payload?.ind ?? null })));
    }
    if (url.startsWith('https://store.test/rest/v1/desk_watchlists')) return box.failWatch ? new Response('{}', { status: 503 }) : Response.json([{ symbols: ['PLTR'] }]);
    if (url.includes('constituents.csv')) return new Response(csv());
    if (url.includes('/v8/finance/chart/')) { if (box.clock) box.clock.now += 400; return Response.json(chart(DAYS.slice(0, 5))); }
    if (url.startsWith('https://fc.yahoo.com')) return new Response('', { headers: { 'set-cookie': 'A3=x; path=/' } });
    if (url.includes('/getcrumb')) return new Response('crumb1');
    if (url.includes('quoteSummary')) return Response.json({ quoteSummary: { result: [{ assetProfile: { sector: 'Technology', industry: 'Software' } }] } });
    throw new Error('unexpected fetch ' + url);
  };
  return { fetch, calls, rows, box };
}
const post = () => new Request('https://fn.test/desk-layers', { method: 'POST', body: '{}' });
test('a stored body for the target is served as gzip bytes, with no upstream call', async () => {
  const { gzipSync } = await import('node:zlib');
  const gz = gzipSync(JSON.stringify({ ok: true, asOf: '2026-11-13' })).toString('base64');
  const s = stubStore({ 'layers:body': { at: '2026-11-13T22:00:00Z', payload: { asOf: '2026-11-13', n: 450, gz } } });
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  const res = await e.handler(post());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-layers-asof'), '2026-11-13');
  assert.equal(res.headers.get('x-layers-target'), '2026-11-13');
  assert.match(res.headers.get('access-control-expose-headers'), /x-layers-done/);
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer()))), { ok: true, asOf: '2026-11-13' });
  assert.ok(s.calls.every((c) => c.url.startsWith('https://store.test/')));
});
test('with no body yet a request moves the sweep on, stores what it fetched, and says it is not ready', async () => {
  const s = stubStore();
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  const res = await e.handler(post());
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.ready, false);
  assert.equal(j.target, '2026-11-13');
  assert.equal(j.total, 9 + 11 + 410 + 1);
  assert.ok(j.done > 0 && j.done < j.total);
  const pltr = s.rows.get('layers:y:PLTR');
  if (pltr) assert.deepEqual([pltr.payload.sector, pltr.payload.ind], ['Technology', 'Software']);
  assert.equal(s.rows.get('layers:y:SPY')?.payload.last, '2026-11-13');
  for (const c of s.calls) {
    const ua = Object.keys(c.init.headers || {}).some((k) => k.toLowerCase() === 'user-agent');
    assert.equal(ua, !c.url.startsWith('https://store.test/'), 'a user-agent goes to third parties only: ' + c.url);
  }
});
test('the whole day: requests until every symbol is in, then ONE assembled body for the target', async () => {
  const s = stubStore();
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  let res, n = 0;
  do {
    res = await e.handler(post());
    n++;
    e.clock.now += 1000;
  } while (res.headers.get('content-type') !== 'application/octet-stream' && n < 80);
  assert.ok(n > 1 && n < 80, `took ${n} requests`);
  const p = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())));
  assert.equal(p.asOf, '2026-11-13');
  assert.equal(p.stocks.length, 411);
  assert.equal(s.rows.get('layers:body').payload.asOf, '2026-11-13');
  const before = s.calls.length;
  const again = await e.handler(post());
  assert.equal(again.headers.get('x-layers-asof'), '2026-11-13');
  assert.ok(s.calls.slice(before).every((c) => c.url.startsWith('https://store.test/')) && s.calls.length - before <= 1);
});
test('a sweep that ends with too few stocks never replaces the body', async () => {
  const s = stubStore();
  const inner = s.fetch;
  const fetch = async (u, init) => (/\/v8\/finance\/chart\/S\d/.test(String(u)) ? new Response('', { status: 404 }) : inner(u, init));
  const e = edge({ env: ENV, fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  let res;
  for (let n = 0; n < 40; n++) { res = await e.handler(post()); e.clock.now += 1000; }
  const j = await res.json();
  assert.equal(j.ready, false);
  assert.equal(j.done, j.total, 'every symbol answered');
  assert.equal(s.rows.has('layers:body'), false);
  assert.ok(e.logs.some((l) => /assembly refused, 1 stocks/.test(l)), e.logs.join('\n'));
});
test('the dollar index is asked of Yahoo by its own symbol, dot and all', async () => {
  const s = stubStore();
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  for (let n = 0; n < 40 && !s.calls.some((c) => c.url.includes('/chart/DX-Y.NYB?')); n++) { await e.handler(post()); e.clock.now += 1000; }
  assert.ok(s.calls.some((c) => c.url.includes('/v8/finance/chart/DX-Y.NYB?')));
  assert.ok(!s.calls.some((c) => c.url.includes('DX-Y-NYB')));
});
test('a failed store write moves nothing on: those symbols are fetched again and no body is built without them', async () => {
  const s = stubStore();
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  s.box.failRows = true;
  let res;
  for (let n = 0; n < 40; n++) { res = await e.handler(post()); e.clock.now += 1000; }
  const j = await res.json();
  assert.equal(j.ready, false);
  assert.equal(j.done, 0, 'nothing counts as in while nothing was stored');
  assert.equal(s.rows.has('layers:body'), false);
  s.box.failRows = false;
  let n = 0;
  do { res = await e.handler(post()); n++; e.clock.now += 1000; } while (res.headers.get('content-type') !== 'application/octet-stream' && n < 80);
  assert.equal(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer()))).stocks.length, 411);
});
test('a failed watchlist read is never an empty watchlist: no sweep before one read, and a later failure keeps it', async () => {
  const s = stubStore();
  const e = edge({ env: ENV, fetch: s.fetch, now: at('2026-11-14T02:00:00Z') });
  s.box.clock = e.clock;
  s.box.failWatch = true;
  for (let n = 0; n < 3; n++) {
    const j = await (await e.handler(post())).json();
    assert.equal(j.ready, false);
  }
  assert.ok(!s.calls.some((c) => c.url.includes('yahoo')), 'no sweep runs on a roster it could not read');
  s.box.failWatch = false;
  await e.handler(post());                         // one good read
  s.box.failWatch = true;
  e.clock.now += 2 * 3600_000;                     // past the hour the roster is kept: it reads again, and fails
  let res, n = 0;
  do { res = await e.handler(post()); n++; e.clock.now += 1000; } while (res.headers.get('content-type') !== 'application/octet-stream' && n < 80);
  const p = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())));
  assert.ok(p.stocks.some((st) => st.s === 'PLTR'), 'the watchlist stock is still in the day');
  assert.ok(e.logs.some((l) => /watchlist read failed/.test(l)));
});
