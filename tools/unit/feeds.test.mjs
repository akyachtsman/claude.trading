/* Unit tests for the internal helpers of three anon-callable edge feeds:
   supabase/functions/quote-proxy, desk-charts and desk-market.

     node --test tools/unit/feeds.test.mjs     (needs `npm ci --prefix tools` once, for esbuild)

   Each function is transpiled and run in a fresh `vm` context by tools/unit/lib.mjs; `fetch`
   is a stub, nothing touches the network. Expectations come from the rules in CLAUDE.md and
   docs/architecture/ (edge-feeds-and-heatmap.md, markets-window.md,
   extended-hours-and-day-pct.md), not from re-running the code under test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEdge } from './lib.mjs';

// Values built inside the vm context carry that realm's prototypes, which deepStrictEqual rejects:
// compare their JSON shape instead.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);

const SITE = 'https://akyachtsman.github.io';
const ET = (iso) => Date.parse(iso); // write instants with an explicit offset, e.g. '2026-10-14T09:30:00-04:00'
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// A Yahoo v8/chart body. `bars` = [[tsSec, o, h, l, c, v], ...]; `regular` = [[start, end], ...] (tradingPeriods).
function yahooChartBody(bars, { regular, meta = {} } = {}) {
  const q = { open: [], high: [], low: [], close: [], volume: [] };
  for (const [, o, h, l, c, v] of bars) { q.open.push(o); q.high.push(h); q.low.push(l); q.close.push(c); q.volume.push(v); }
  const m = { ...meta };
  if (regular) m.tradingPeriods = { regular: regular.map(([start, end]) => [{ start, end }]) };
  return { chart: { result: [{ meta: m, timestamp: bars.map((b) => b[0]), indicators: { quote: [q] } }] } };
}
// n daily bars, one a day from `startSec`, price ~100.
const dailyBars = (n, startSec = ET('2026-01-05T16:00:00-05:00') / 1000) =>
  Array.from({ length: n }, (_, i) => [startSec + i * 86400, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000 + i]);

// ═══ quote-proxy ═════════════════════════════════════════════════════════════
const QP = ['toYahoo', 'pack', 'regularRanges', 'emptySeries', 'pricesMoving', 'ttlFor', 'extInfo', 'corsHeaders',
  'EXT_WICK_TOL', 'KEEP_BARS', 'KEEP_BARS_INTRADAY', 'CACHE_TTL_MS'];
const qp = (opts) => loadEdge('quote-proxy', QP, opts);

test('quote-proxy toYahoo: a share-class dot is hyphenated, an exchange suffix is kept', () => {
  const { toYahoo } = qp();
  assert.equal(toYahoo('BRK.B'), 'BRK-B');
  assert.equal(toYahoo('BF.A'), 'BF-A');
  assert.equal(toYahoo('DX-Y.NYB'), 'DX-Y.NYB');
  assert.equal(toYahoo('AAPL'), 'AAPL');
  assert.equal(toYahoo('^GSPC'), '^GSPC');
  assert.equal(toYahoo('GC=F'), 'GC=F');
});

test('quote-proxy pack: every bar carries x (0 by default), and keep trims the OLDEST bars', () => {
  const { pack, emptySeries } = qp();
  deq(JSON.parse(JSON.stringify(emptySeries())), { t: [], o: [], h: [], l: [], c: [], v: [], x: [] });
  const rows = [1, 2, 3, 4].map((i) => ({ t: `d${i}`, o: i, h: i, l: i, c: i, v: i, ...(i === 3 ? { x: 1 } : {}) }));
  const s = pack(rows, 3);
  deq([...s.t], ['d2', 'd3', 'd4']);
  deq([...s.x], [0, 1, 0]);
  for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'x']) assert.equal(s[k].length, 3, `${k} is as long as t`);
});

test('quote-proxy regularRanges: reads tradingPeriods.regular, with NO currentTradingPeriod fallback', () => {
  const { regularRanges } = qp();
  deq(regularRanges({ tradingPeriods: { regular: [[{ start: 1, end: 2 }], [{ start: 3, end: 4 }]] } }).map((r) => [...r]), [[1, 2], [3, 4]]);
  deq(regularRanges({ tradingPeriods: { regular: [{ start: 5, end: 6 }] } }).map((r) => [...r]), [[5, 6]], 'a flat per-day entry is accepted');
  assert.equal(regularRanges({ currentTradingPeriod: { regular: { start: 1, end: 2 } } }).length, 0, 'one day of bounds is never applied to a 5-day window');
  assert.equal(regularRanges({ tradingPeriods: { regular: [[{ start: '1', end: 2 }]] } }).length, 0, 'non-numeric bounds are dropped');
  assert.equal(regularRanges(null).length, 0);
  assert.equal(regularRanges(undefined).length, 0);
});

test('quote-proxy pricesMoving: 04:00–20:00 ET on a weekday, across DST', () => {
  const { pricesMoving } = qp();
  assert.equal(pricesMoving(new Date(ET('2026-10-14T03:59:00-04:00'))), false);
  assert.equal(pricesMoving(new Date(ET('2026-10-14T04:00:00-04:00'))), true);
  assert.equal(pricesMoving(new Date(ET('2026-10-14T19:59:00-04:00'))), true);
  assert.equal(pricesMoving(new Date(ET('2026-10-14T20:00:00-04:00'))), false);
  assert.equal(pricesMoving(new Date(ET('2026-12-15T04:30:00-05:00'))), true, 'EST');
  assert.equal(pricesMoving(new Date(ET('2026-10-17T12:00:00-04:00'))), false, 'Saturday');
  assert.equal(pricesMoving(new Date(ET('2026-10-18T12:00:00-04:00'))), false, 'Sunday');
});

test('quote-proxy ttlFor: info is 60 s while prices move and 15 min when frozen; daily/intraday fixed', () => {
  const e = qp({ now: ET('2026-10-14T12:00:00-04:00') });
  assert.equal(e.ttlFor('info'), 60_000);
  assert.equal(e.ttlFor('daily'), 300_000);
  assert.equal(e.ttlFor('intraday'), 60_000);
  e.clock.now = ET('2026-10-17T12:00:00-04:00');
  assert.equal(e.ttlFor('info'), 900_000);
  assert.equal(e.ttlFor('daily'), 300_000);
});

test('quote-proxy extInfo: post-market % compounds from the PRIOR close; absent is null, never 0', () => {
  const { extInfo } = qp();
  // (1 + 2%)(1 + 1%) - 1 = 3.02%
  deq({ ...extInfo({ postMarketPrice: 103, regularMarketChangePercent: 2, postMarketChangePercent: 1, postMarketTime: 99 }) },
    { extPrice: 103, extPct: 3.02, extAt: 99 });
  // (1 - 3%)(1 + 2%) - 1 = -1.06%
  assert.equal(extInfo({ postMarketPrice: 50, regularMarketChangePercent: -3, postMarketChangePercent: 2 }).extPct, -1.06);
  // regularMarketPreviousClose must not enter the result
  const a = extInfo({ postMarketPrice: 10, regularMarketChangePercent: 1, postMarketChangePercent: 1, regularMarketPreviousClose: 1 });
  const b = extInfo({ postMarketPrice: 10, regularMarketChangePercent: 1, postMarketChangePercent: 1, regularMarketPreviousClose: 999 });
  assert.equal(a.extPct, b.extPct);
  deq({ ...extInfo({ postMarketPrice: 10, postMarketChangePercent: 1 }) }, { extPrice: 10, extPct: null, extAt: null }, 'no reg% → price, no %');
  assert.equal(extInfo({ postMarketPrice: 10, regularMarketChangePercent: 1 }).extPct, null, 'no post% → no %');
  deq({ ...extInfo({}) }, { extPrice: null, extPct: null, extAt: null });
  deq({ ...extInfo(null) }, { extPrice: null, extPct: null, extAt: null });
  assert.equal(extInfo({ postMarketPrice: 0, regularMarketChangePercent: 1, postMarketChangePercent: 1 }).extPrice, null, 'a zero price is no print');
  assert.equal(extInfo({ postMarketPrice: NaN, regularMarketChangePercent: 1, postMarketChangePercent: 1 }).extPrice, null);
  assert.equal(extInfo({ postMarketPrice: '10', regularMarketChangePercent: 1, postMarketChangePercent: 1 }).extPrice, null, 'a string is not a price');
});

test('quote-proxy corsHeaders: echoes ONLY an allowed origin; always Vary: Origin', () => {
  const { corsHeaders } = qp();
  const ok = corsHeaders(SITE, true);
  assert.equal(ok['Access-Control-Allow-Origin'], SITE);
  assert.equal(ok.Vary, 'Origin');
  const no = corsHeaders('https://evil.example', false);
  assert.equal('Access-Control-Allow-Origin' in no, false);
  assert.equal(no.Vary, 'Origin');
  assert.match(no['Access-Control-Allow-Methods'], /POST/);
});

// ── quote-proxy handler ──────────────────────────────────────────────────────
function qpReq(body, { origin = SITE, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  return new Request('https://fn.test/quote-proxy', { method, headers, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
}
async function call(e, req) {
  const res = await e.handler(req);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { res, status: res.status, text, body, acao: res.headers.get('access-control-allow-origin'), ctype: res.headers.get('content-type') };
}
const isJsonWithCors = (r, allowed) => {
  assert.equal(r.ctype, 'application/json', `status ${r.status} answers JSON`);
  assert.notEqual(r.body, null, `status ${r.status} body parses as JSON`);
  assert.equal(r.res.headers.get('vary'), 'Origin');
  assert.equal(r.acao, allowed ? SITE : null);
};

test('quote-proxy handler: every refusal is JSON with the allowlist CORS headers', async () => {
  const calls = [];
  const e = qp({ fetch: (u) => { calls.push(String(u)); return Promise.reject(new Error('should not be reached')); } });
  const foreign = await call(e, qpReq({ symbol: 'AAPL' }, { origin: 'https://evil.example' }));
  assert.equal(foreign.status, 403); isJsonWithCors(foreign, false);
  const noOrigin = await call(e, qpReq({ symbol: 'AAPL' }, { origin: null }));
  assert.equal(noOrigin.status, 403); isJsonWithCors(noOrigin, false);
  const get = await call(e, qpReq(null, { method: 'GET' }));
  assert.equal(get.status, 405); isJsonWithCors(get, true);
  const badJson = await call(e, qpReq('{not json'));
  assert.equal(badJson.status, 400); isJsonWithCors(badJson, true);
  const nullBody = await call(e, qpReq('null'));
  assert.equal(nullBody.status, 400); isJsonWithCors(nullBody, true);
  const empty = await call(e, qpReq({ symbol: '  ' }));
  assert.equal(empty.status, 400); isJsonWithCors(empty, true);
  for (const bad of ['AAPL;rm', 'TOOLONGSYMBOL1', 'A B', '../x']) {
    const r = await call(e, qpReq({ symbol: bad }));
    assert.equal(r.status, 400, bad); isJsonWithCors(r, true);
  }
  assert.equal(calls.length, 0, 'nothing reaches upstream for a refused request');
});

test('quote-proxy handler: OPTIONS preflight carries the CORS headers (allowed and not)', async () => {
  const e = qp();
  const ok = await e.handler(qpReq(null, { method: 'OPTIONS' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.match(ok.headers.get('access-control-allow-methods'), /OPTIONS/);
  const no = await e.handler(qpReq(null, { method: 'OPTIONS', origin: 'https://evil.example' }));
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('quote-proxy handler: an upstream THROW is a 502 JSON with CORS, not a bare 500', async () => {
  const e = qp({ fetch: () => Promise.reject(new Error('socket hang up')) });
  const r = await call(e, qpReq({ symbol: 'AAPL', kind: 'intraday' }));
  assert.equal(r.status, 502); isJsonWithCors(r, true);
  assert.equal(r.body.ok, false);
  assert.doesNotMatch(r.text, /socket hang up/, 'the upstream error text is not echoed');
});

test('quote-proxy handler: an upstream 5xx / junk body is a 404 JSON with CORS', async () => {
  const e = qp({ fetch: () => Promise.resolve(new Response('<html>challenge</html>', { status: 200 })) });
  const r = await call(e, qpReq({ symbol: 'AAPL' }));
  assert.equal(r.status, 404); isJsonWithCors(r, true);
  const e2 = qp({ fetch: () => Promise.resolve(new Response('', { status: 503 })) });
  const r2 = await call(e2, qpReq({ symbol: 'MSFT', kind: 'info' }));
  assert.equal(r2.status, 404); isJsonWithCors(r2, true);
});

test('quote-proxy handler: a daily lookup symbol is upper-cased and BRK.B goes to Yahoo as BRK-B', async () => {
  const urls = [];
  const e = qp({ fetch: (u) => { urls.push(String(u)); return Promise.resolve(json(yahooChartBody(dailyBars(40)))); } });
  const r = await call(e, qpReq({ symbol: 'brk.b' }));
  assert.equal(r.status, 200); isJsonWithCors(r, true);
  assert.equal(r.body.symbol, 'BRK.B');
  assert.equal(r.body.prepost, false);
  assert.match(urls[0], /\/chart\/BRK-B\?range=5y&interval=1d&includePrePost=false/);
  assert.equal(r.body.series.t.length, 40);
  assert.ok(r.body.series.x.every((x) => x === 0), 'a daily series is all regular');
  assert.match(r.body.series.t[0], /^\d{4}-\d{2}-\d{2}$/);
});

test('quote-proxy handler: prepost is part of the intraday cache key, and ignored for daily', async () => {
  const urls = [];
  const day = ET('2026-10-14T00:00:00-04:00') / 1000;
  const regStart = day + 9.5 * 3600, regEnd = day + 16 * 3600;
  const bars = [];
  for (let ts = day + 4 * 3600; ts < day + 20 * 3600; ts += 300) bars.push([ts, 100, 100.5, 99.5, 100.2, ts >= regStart && ts < regEnd ? 10 : 0]);
  const e = qp({
    now: ET('2026-10-14T21:00:00-04:00'),
    fetch: (u) => { urls.push(String(u)); return Promise.resolve(json(yahooChartBody(bars, { regular: [[regStart, regEnd]] }))); },
  });
  const plain = await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday' }));
  const pp = await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday', prepost: true }));
  assert.equal(urls.length, 2, 'the prepost variant is NOT served from the plain variant\'s cache');
  assert.match(urls[0], /includePrePost=false/);
  assert.match(urls[1], /includePrePost=true/);
  assert.equal(plain.body.prepost, false);
  assert.equal(pp.body.prepost, true);
  assert.ok(plain.body.series.x.every((x) => x === 0));
  assert.ok(pp.body.series.x.some((x) => x === 1), 'extended bars are marked x:1');
  // both now cached separately
  await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday' }));
  await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday', prepost: true }));
  assert.equal(urls.length, 2, 'each variant is served from its own cache entry');
  // prepost on a DAILY request means nothing: it shares the plain daily key
  const e2 = qp({ fetch: (u) => { urls.push(String(u)); return Promise.resolve(json(yahooChartBody(dailyBars(40)))); } });
  urls.length = 0;
  const d1 = await call(e2, qpReq({ symbol: 'QQQ' }));
  const d2 = await call(e2, qpReq({ symbol: 'QQQ', prepost: true }));
  assert.equal(urls.length, 1);
  assert.equal(d1.body.prepost, false);
  assert.equal(d2.body.prepost, false);
});

test('quote-proxy handler: only EXTENDED bars are wick-de-spiked (1% outside the body)', async () => {
  const day = ET('2026-10-14T00:00:00-04:00') / 1000;
  const regStart = day + 9.5 * 3600, regEnd = day + 16 * 3600;
  const bars = [];
  for (let ts = day + 9.5 * 3600; ts < regEnd; ts += 300) bars.push([ts, 100, 100.5, 99.5, 100.2, 10]);
  // a regular bar with a wild wick (left alone), and a post-market bar with a phantom wick (clamped)
  const regWild = regStart + 1800;
  bars.find((b) => b[0] === regWild)[2] = 150;
  bars.find((b) => b[0] === regWild)[3] = 60;
  const post = day + 16.5 * 3600;
  bars.push([post, 100, 140, 50, 101, 0]);
  const e = qp({ now: ET('2026-10-14T21:00:00-04:00'), fetch: () => Promise.resolve(json(yahooChartBody(bars, { regular: [[regStart, regEnd]] }))) });
  const r = await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday', prepost: true }));
  assert.equal(r.status, 200);
  const s = r.body.series;
  const iReg = s.t.indexOf(new Date(regWild * 1000).toISOString().slice(0, 16).replace('T', ' '));
  const iPost = s.t.indexOf(new Date(post * 1000).toISOString().slice(0, 16).replace('T', ' '));
  assert.ok(iReg >= 0 && iPost >= 0);
  assert.equal(s.x[iReg], 0);
  assert.equal(s.h[iReg], 150, 'a regular bar keeps its high');
  assert.equal(s.l[iReg], 60, 'a regular bar keeps its low');
  assert.equal(s.x[iPost], 1);
  assert.ok(Math.abs(s.h[iPost] - 101 * 1.01) < 1e-9, `extended high clamped to body top +1%: ${s.h[iPost]}`);
  assert.ok(Math.abs(s.l[iPost] - 100 * 0.99) < 1e-9, `extended low clamped to body bottom -1%: ${s.l[iPost]}`);
  assert.equal(s.o[iPost], 100); assert.equal(s.c[iPost], 101, 'the body is untouched');
});

test('quote-proxy handler: an extended wick INSIDE the tolerance is not touched, and a clamp never cuts into the body', async () => {
  const day = ET('2026-10-14T00:00:00-04:00') / 1000;
  const regStart = day + 9.5 * 3600, regEnd = day + 16 * 3600;
  const bars = [];
  for (let ts = regStart; ts < regEnd; ts += 300) bars.push([ts, 100, 100.5, 99.5, 100.2, 10]);
  const p1 = day + 17 * 3600, p2 = day + 17.5 * 3600;
  bars.push([p1, 100, 100.6, 99.6, 100.4, 0]);   // within 1%
  bars.push([p2, 100, 100, 100, 100, 0]);         // flat body, high/low == body
  const e = qp({ now: ET('2026-10-14T21:00:00-04:00'), fetch: () => Promise.resolve(json(yahooChartBody(bars, { regular: [[regStart, regEnd]] }))) });
  const s = (await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday', prepost: true }))).body.series;
  const i1 = s.t.indexOf(new Date(p1 * 1000).toISOString().slice(0, 16).replace('T', ' '));
  const i2 = s.t.indexOf(new Date(p2 * 1000).toISOString().slice(0, 16).replace('T', ' '));
  assert.equal(s.h[i1], 100.6); assert.equal(s.l[i1], 99.6);
  assert.equal(s.h[i2], 100); assert.equal(s.l[i2], 100);
});

test('quote-proxy handler: prepost with NO tradingPeriods retries regular-only instead of guessing', async () => {
  const urls = [];
  const day = ET('2026-10-14T00:00:00-04:00') / 1000;
  const bars = [];
  for (let ts = day + 9.5 * 3600; ts < day + 16 * 3600; ts += 300) bars.push([ts, 100, 100.5, 99.5, 100.2, 10]);
  const e = qp({ fetch: (u) => { urls.push(String(u)); return Promise.resolve(json(yahooChartBody(bars))); } });
  const r = await call(e, qpReq({ symbol: 'QQQ', kind: 'intraday', prepost: true }));
  assert.equal(r.status, 200);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /includePrePost=false/);
  assert.ok(r.body.series.x.every((x) => x === 0), 'nothing is marked extended on a guess');
});

test('quote-proxy handler: a negative (404) result is cached only 30 s, a hit for the full TTL; force skips the cache', async () => {
  let n = 0;
  const e = qp({ now: ET('2026-10-17T12:00:00-04:00'), fetch: () => { n++; return Promise.resolve(new Response('', { status: 404 })); } });
  await call(e, qpReq({ symbol: 'ZZZZ', kind: 'info' }));
  const before = n;
  await call(e, qpReq({ symbol: 'ZZZZ', kind: 'info' }));
  assert.equal(n, before, 'inside 30 s the miss is served from cache');
  e.clock.now += 31_000;
  await call(e, qpReq({ symbol: 'ZZZZ', kind: 'info' }));
  assert.ok(n > before, 'after 30 s a miss is asked again (not pinned for the 15-min info TTL)');
  const mid = n;
  await call(e, qpReq({ symbol: 'ZZZZ', kind: 'info', force: true }));
  assert.ok(n > mid, 'force skips the cache');
});

test('quote-proxy handler: a daily miss on Yahoo falls back to Stooq, and a Stooq throw stays a 404 (not a 502)', async () => {
  const urls = [];
  const e = qp({ fetch: (u) => { urls.push(String(u)); return /stooq/.test(u) ? Promise.reject(new Error('boom')) : Promise.resolve(new Response('', { status: 404 })); } });
  const r = await call(e, qpReq({ symbol: 'AAPL' }));
  assert.equal(r.status, 404); isJsonWithCors(r, true);
  assert.ok(urls.some((u) => /stooq\.com/.test(u)));
});

test('quote-proxy handler: an info lookup returns the compounded post-market print', async () => {
  const e = qp({
    fetch: (u) => {
      u = String(u);
      if (u.startsWith('https://fc.yahoo.com')) return Promise.resolve(new Response('', { status: 404, headers: { 'set-cookie': 'A3=abc; Path=/' } }));
      if (u.includes('getcrumb')) return Promise.resolve(new Response('crumb123', { status: 200 }));
      if (u.includes('/v7/finance/quote')) {
        assert.match(u, /crumb=crumb123/);
        return Promise.resolve(json({ quoteResponse: { result: [{ symbol: 'AAPL', regularMarketPrice: 200, regularMarketChangePercent: 2, postMarketPrice: 202, postMarketChangePercent: 1, priceEpsCurrentYear: 30, trailingPE: 35 }] } }));
      }
      return Promise.reject(new Error('unexpected ' + u));
    },
  });
  const r = await call(e, qpReq({ symbol: 'aapl', kind: 'info' }));
  assert.equal(r.status, 200); isJsonWithCors(r, true);
  assert.equal(r.body.info.extPct, 3.02);
  assert.equal(r.body.info.pe, 30); assert.equal(r.body.info.peFwd, true, 'forward P/E preferred and labelled');
});

// ═══ desk-charts ═════════════════════════════════════════════════════════════
const DC = ['parseStooqOHLC', 'parseYahooChartOHLC', 'packSeries', 'KEEP_BARS'];
const dc = () => loadEdge('desk-charts', DC);

test('desk-charts parseStooqOHLC: keeps valid rows sorted, skips bad dates and non-positive prices', () => {
  const { parseStooqOHLC } = dc();
  const csv = [
    'Date,Open,High,Low,Close,Volume',
    '2026-10-02,10,11,9,10.5,100',
    '2026-10-01,9,10,8,9.5,',           // missing volume → 0
    'not-a-date,1,1,1,1,1',
    '2026-10-03,0,1,1,1,1',             // zero open
    '2026-10-04,1,1,-1,1,1',            // negative low
    '2026-10-05,1,1,1',                 // too few columns
    '2026-10-06,x,1,1,1,1',             // NaN
    '2026-10-07,5,6,4,5.5,-3',          // negative volume → 0
  ].join('\n');
  const rows = parseStooqOHLC(csv);
  deq(rows.map((r) => r.date), ['2026-10-01', '2026-10-02', '2026-10-07']);
  assert.equal(rows[0].v, 0);
  assert.equal(rows[2].v, 0);
  deq(parseStooqOHLC('<html>challenge</html>'), []);
  deq(parseStooqOHLC(''), []);
});

test('desk-charts parseYahooChartOHLC: a bad timestamp skips the BAR, never the symbol', () => {
  const { parseYahooChartOHLC } = dc();
  const good = ET('2026-10-14T20:00:00Z') / 1000;
  const body = {
    chart: { result: [{ timestamp: [good, undefined, 'abc', NaN, good + 86400],
      indicators: { quote: [{ open: [1, 1, 1, 1, 2], high: [1, 1, 1, 1, 2], low: [1, 1, 1, 1, 2], close: [1, 1, 1, 1, 2], volume: [5, 5, 5, 5, null] }] } }] },
  };
  let rows;
  assert.doesNotThrow(() => { rows = parseYahooChartOHLC(body); });
  deq(rows.map((r) => r.date), ['2026-10-14', '2026-10-15']);
  assert.equal(rows[1].v, 0, 'a null volume is 0');
  deq(parseYahooChartOHLC(null), []);
  deq(parseYahooChartOHLC({ chart: { result: [] } }), []);
});

test('desk-charts parseYahooChartOHLC: dates are NEW YORK dates, DST-aware', () => {
  const { parseYahooChartOHLC } = dc();
  const one = (iso) => {
    const ts = ET(iso) / 1000;
    return parseYahooChartOHLC({ chart: { result: [{ timestamp: [ts], indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1], volume: [1] }] } }] } })[0].date;
  };
  assert.equal(one('2026-10-14T20:00:00Z'), '2026-10-14', '20:00Z is 16:00 EDT the same day');
  assert.equal(one('2026-10-15T03:00:00Z'), '2026-10-14', '03:00Z is 23:00 EDT the PREVIOUS day');
  assert.equal(one('2026-10-15T04:30:00Z'), '2026-10-15', '04:30Z is 00:30 EDT');
  assert.equal(one('2026-12-15T04:30:00Z'), '2026-12-14', 'in EST 04:30Z is still 23:30 the day before');
  assert.equal(one('2026-03-08T05:30:00Z'), '2026-03-08', 'the spring-forward night');
  assert.equal(one('2026-11-01T04:30:00Z'), '2026-11-01', 'the fall-back night, still EDT at 00:30');
});

test('desk-charts parseYahooChartOHLC: non-positive / missing prices are skipped and output is sorted', () => {
  const { parseYahooChartOHLC } = dc();
  const t = (d) => ET(`2026-10-${d}T20:00:00Z`) / 1000;
  const rows = parseYahooChartOHLC({ chart: { result: [{ timestamp: [t(16), t(14), t(15), t(13)],
    indicators: { quote: [{ open: [3, 1, null, 0], high: [3, 1, 2, 1], low: [3, 1, 2, 1], close: [3, 1, 2, 1], volume: [1, 1, 1, 1] }] } }] } });
  deq(rows.map((r) => r.date), ['2026-10-14', '2026-10-16']);
});

test('desk-charts packSeries: rounds prices to 2 decimals, keeps volume, trims to KEEP_BARS', () => {
  const { packSeries, KEEP_BARS } = dc();
  const s = packSeries([{ date: '2026-10-14', o: 1.005, h: 2.3449, l: 0.996, c: 123.456789, v: 1234567 }]);
  deq([...s.t], ['2026-10-14']);
  assert.equal(s.h[0], 2.34);
  assert.equal(s.l[0], 1);
  assert.equal(s.c[0], 123.46);
  assert.equal(s.v[0], 1234567, 'volume is not rounded');
  assert.equal(KEEP_BARS, 800);
  const many = Array.from({ length: 900 }, (_, i) => ({ date: `d${String(i).padStart(4, '0')}`, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  const p = packSeries(many);
  assert.equal(p.t.length, 800);
  assert.equal(p.t[0], 'd0100', 'the OLDEST bars are dropped');
  assert.equal(p.t.at(-1), 'd0899');
});

// ═══ desk-market ═════════════════════════════════════════════════════════════
const DM = ['nyDate', 'marketSessionOpen', 'withinCloseSettleGrace', 'withinPostMarket', 'ttlMs', 'parseStooqDaily',
  'yahooSymbol', 'parseYahooChart', 'extFrom', 'fmtLast', 'tileFrom', 'parseFred', 'tenYearTile'];
const dm = (opts) => loadEdge('desk-market', DM, opts);
const at = (iso) => new Date(ET(iso));

test('desk-market nyDate: the New York calendar date, null for an invalid instant', () => {
  const { nyDate } = dm();
  assert.equal(nyDate(ET('2026-10-14T20:00:00Z') / 1000), '2026-10-14');
  assert.equal(nyDate(ET('2026-10-15T03:00:00Z') / 1000), '2026-10-14');
  assert.equal(nyDate(NaN), null);
  assert.equal(nyDate(undefined), null);
  assert.equal(nyDate('x'), null);
});

test('desk-market marketSessionOpen: 09:30–16:00 ET, weekdays, NYSE holidays shut', () => {
  const { marketSessionOpen } = dm();
  assert.equal(marketSessionOpen(at('2026-10-14T09:29:00-04:00')), false);
  assert.equal(marketSessionOpen(at('2026-10-14T09:30:00-04:00')), true);
  assert.equal(marketSessionOpen(at('2026-10-14T15:59:00-04:00')), true);
  assert.equal(marketSessionOpen(at('2026-10-14T16:00:00-04:00')), false);
  assert.equal(marketSessionOpen(at('2026-12-15T10:00:00-05:00')), true, 'EST');
  assert.equal(marketSessionOpen(at('2026-10-17T12:00:00-04:00')), false, 'Saturday');
  assert.equal(marketSessionOpen(at('2026-11-26T12:00:00-05:00')), false, 'Thanksgiving');
  assert.equal(marketSessionOpen(at('2026-12-25T12:00:00-05:00')), false, 'Christmas');
  assert.equal(marketSessionOpen(at('2027-03-26T12:00:00-04:00')), false, 'Good Friday 2027');
  assert.equal(marketSessionOpen(at('2026-10-12T12:00:00-04:00')), true, 'Columbus Day: equities trade');
});

test('desk-market withinCloseSettleGrace: the 15 minutes after the bell on a weekday', () => {
  const { withinCloseSettleGrace } = dm();
  assert.equal(withinCloseSettleGrace(at('2026-10-14T15:59:00-04:00')), false);
  assert.equal(withinCloseSettleGrace(at('2026-10-14T16:00:00-04:00')), true);
  assert.equal(withinCloseSettleGrace(at('2026-10-14T16:14:00-04:00')), true);
  assert.equal(withinCloseSettleGrace(at('2026-10-14T16:15:00-04:00')), false);
  assert.equal(withinCloseSettleGrace(at('2026-10-17T16:05:00-04:00')), false, 'Saturday');
});

test('desk-market withinPostMarket: 16:00–20:00 ET on a trading day only', () => {
  const { withinPostMarket } = dm();
  assert.equal(withinPostMarket(at('2026-10-14T15:59:00-04:00')), false);
  assert.equal(withinPostMarket(at('2026-10-14T16:00:00-04:00')), true);
  assert.equal(withinPostMarket(at('2026-10-14T19:59:00-04:00')), true);
  assert.equal(withinPostMarket(at('2026-10-14T20:00:00-04:00')), false);
  assert.equal(withinPostMarket(at('2026-11-26T17:00:00-05:00')), false, 'Thanksgiving');
  assert.equal(withinPostMarket(at('2026-10-18T17:00:00-04:00')), false, 'Sunday');
});

test('desk-market ttlMs: 1 min while the session, settle grace or post-market runs; 60 min otherwise', () => {
  const e = dm();
  const ttlAt = (iso) => { e.clock.now = ET(iso); return e.ttlMs(); };
  assert.equal(ttlAt('2026-10-14T11:00:00-04:00'), 60_000);
  assert.equal(ttlAt('2026-10-14T16:05:00-04:00'), 60_000);
  assert.equal(ttlAt('2026-10-14T18:00:00-04:00'), 60_000);
  assert.equal(ttlAt('2026-10-14T21:00:00-04:00'), 3_600_000);
  assert.equal(ttlAt('2026-10-14T08:00:00-04:00'), 3_600_000);
  assert.equal(ttlAt('2026-10-17T12:00:00-04:00'), 3_600_000);
});

test('desk-market parseStooqDaily: close-only rows, sorted, junk skipped', () => {
  const { parseStooqDaily } = dm();
  const rows = parseStooqDaily(['Date,Open,High,Low,Close,Volume', '2026-10-02,1,1,1,11', '2026-10-01,1,1,1,10', '2026-10-03,1,1,1,0', 'x,1,1,1,1', '2026-10-04,1,1,1'].join('\n'));
  deq(rows.map((r) => [r.date, r.close]), [['2026-10-01', 10], ['2026-10-02', 11]]);
  deq(parseStooqDaily('<html>'), []);
});

test('desk-market yahooSymbol: mapped indices, NASDAQ is the Composite, .us stripped', () => {
  const { yahooSymbol } = dm();
  assert.equal(yahooSymbol('^spx'), '^GSPC');
  assert.equal(yahooSymbol('^ixic'), '^IXIC', 'the NASDAQ tile is the Composite, not ^NDX');
  assert.equal(yahooSymbol('^dji'), '^DJI');
  assert.equal(yahooSymbol('^vix'), '^VIX');
  assert.equal(yahooSymbol('btcusd'), 'BTC-USD');
  assert.equal(yahooSymbol('xauusd'), 'GC=F');
  assert.equal(yahooSymbol('dx.f'), 'DX-Y.NYB');
  assert.equal(yahooSymbol('iwm.us'), 'IWM');
  assert.equal(yahooSymbol('xlre.us'), 'XLRE');
  assert.equal(yahooSymbol('abc'), 'ABC');
});

test('desk-market parseYahooChart: NY dates, a malformed timestamp skips the bar, bad closes skipped', () => {
  const { parseYahooChart } = dm();
  const t = (iso) => ET(iso) / 1000;
  const rows = parseYahooChart({ chart: { result: [{ timestamp: [t('2026-10-15T03:00:00Z'), NaN, t('2026-10-13T20:00:00Z'), t('2026-10-16T20:00:00Z')],
    indicators: { quote: [{ close: [101, 102, 100, null] }] } }] } });
  deq(rows.map((r) => [r.date, r.close]), [['2026-10-13', 100], ['2026-10-14', 101]]);
  deq(parseYahooChart(undefined), []);
});

test('desk-market extFrom: post compounds from the PRIOR close; an incomplete quote is null, never 0', () => {
  const { extFrom } = dm();
  const post = extFrom({ regularMarketChangePercent: 2, postMarketPrice: 103, postMarketChangePercent: 1, postMarketTime: 7, regularMarketPreviousClose: 1 });
  deq({ ...post }, { kind: 'post', price: 103, pct: 3.02, at: 7 });
  const other = extFrom({ regularMarketChangePercent: 2, postMarketPrice: 103, postMarketChangePercent: 1, postMarketTime: 7, regularMarketPreviousClose: 500 });
  assert.equal(other.pct, post.pct, 'regularMarketPreviousClose is never used');
  assert.equal(extFrom({ postMarketPrice: 103, postMarketChangePercent: 1 }), null, 'no reg% → no line (not the post% alone)');
  assert.equal(extFrom({ regularMarketChangePercent: 2, postMarketPrice: 103 }), null, 'no post% → no line (not the reg% relabelled)');
  assert.equal(extFrom(null), null);
  assert.equal(extFrom({}), null);
  assert.equal(extFrom({ regularMarketChangePercent: 2 }), null, 'nothing traded → null, not 0');
  deq({ ...extFrom({ preMarketPrice: 99, preMarketChangePercent: -1.234, preMarketTime: 3 }) }, { kind: 'pre', price: 99, pct: -1.23, at: 3 });
  assert.equal(extFrom({ preMarketPrice: 99 }), null);
  // a post print wins over a pre print, but an incomplete post does not fall through to pre
  assert.equal(extFrom({ postMarketPrice: 1, preMarketPrice: 99, preMarketChangePercent: 1 }), null);
});

test('desk-market fmtLast / tileFrom / tenYearTile: shape and day change off the second-to-last close', () => {
  const { fmtLast, tileFrom, tenYearTile } = dm();
  assert.equal(fmtLast(1234.5), '1,234.50');
  assert.equal(fmtLast(0.123), '0.12');
  const rows = Array.from({ length: 40 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, close: 100 + i }));
  rows[38].close = 200; rows[39].close = 210;
  const tile = tileFrom('S&P 500', { rows, quoteTs: 12345 });
  assert.equal(tile.last, '210.00');
  assert.equal(tile.chg, 5);
  assert.equal(tile.spark.length, 30, 'spark is the last 30 closes');
  assert.equal(tile.spark.at(-1), 210);
  assert.equal(tile.asOf, rows[39].date);
  assert.equal(tile.quoteTs, 12345);
  assert.equal(tileFrom('X', { rows }).quoteTs, null, 'no quote clock → null');
  const ten = tenYearTile([{ date: '2026-10-13', value: 4.1 }, { date: '2026-10-14', value: 4.15 }]);
  assert.equal(ten.last, '4.15%');
  assert.equal(ten.chg, 0.05);
  assert.equal(ten.asOf, '2026-10-14', 'stamped with the SERIES date');
});

test('desk-market parseFred: an EMPTY or "." field is a gap, never a 0.00 yield', () => {
  const { parseFred } = dm();
  const csv = ['observation_date,DGS10', '2026-09-03,4.20', '2026-09-04,', '2026-09-07,.', '2026-09-08, 4.25 ', 'bad,4.0', '2026-09-09,abc', '2026-09-10,0'].join('\n');
  const rows = parseFred(csv);
  deq(rows.map((r) => [r.date, r.value]), [['2026-09-03', 4.2], ['2026-09-08', 4.25], ['2026-09-10', 0]]);
  assert.ok(!rows.some((r) => r.date === '2026-09-04' || r.date === '2026-09-07'));
  deq(parseFred(''), []);
  deq(parseFred('observation_date,DGS10'), []);
});

// ── desk-market handler ──────────────────────────────────────────────────────
function marketFetch({ fredCsv = 'observation_date,DGS10\n2026-10-13,4.10\n2026-10-14,4.15', yahooOk = true, quotes = [] } = {}) {
  const calls = [];
  const fn = (u) => {
    u = String(u); calls.push(u);
    if (u.includes('fred.stlouisfed.org')) return Promise.resolve(new Response(fredCsv, { status: 200 }));
    if (u.includes('/v8/finance/chart/')) {
      if (!yahooOk) return Promise.resolve(new Response('', { status: 500 }));
      return Promise.resolve(json(yahooChartBody(dailyBars(10, ET('2026-10-01T20:00:00Z') / 1000))));
    }
    if (u.startsWith('https://fc.yahoo.com')) return Promise.resolve(new Response('', { status: 404, headers: { 'set-cookie': 'A3=x; Path=/' } }));
    if (u.includes('getcrumb')) return Promise.resolve(new Response('crumb', { status: 200 }));
    if (u.includes('/v7/finance/quote')) return Promise.resolve(json({ quoteResponse: { result: quotes } }));
    if (u.includes('stooq.com')) return Promise.resolve(new Response('<html>challenge</html>', { status: 200 }));
    return Promise.reject(new Error('unexpected ' + u));
  };
  return { fn, calls };
}
const mreq = (body) => new Request('https://fn.test/desk-market', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('desk-market handler: an EMPTY FRED field never becomes a 0.00 10Y tile', async () => {
  const f = marketFetch({ fredCsv: 'observation_date,DGS10\n2026-10-12,4.10\n2026-10-13,4.12\n2026-10-14,' });
  const e = dm({ now: ET('2026-10-14T21:30:00-04:00'), fetch: f.fn });
  const body = await (await e.handler(mreq())).json();
  assert.equal(body.ok, true);
  const ten = body.tiles.find((t) => t.name === 'US 10Y');
  assert.ok(ten, 'the 10Y tile is present');
  assert.equal(ten.last, '4.12%');
  assert.equal(ten.asOf, '2026-10-13');
  assert.ok(ten.spark.every((v) => v > 0), 'no zero in the spark');
});

test('desk-market handler: FRED down drops ONLY the 10Y tile; the core indices still answer ok', async () => {
  const f = marketFetch({ fredCsv: '' });
  const e = dm({ now: ET('2026-10-14T21:30:00-04:00'), fetch: f.fn });
  const body = await (await e.handler(mreq())).json();
  assert.equal(body.ok, true);
  assert.equal(body.tiles.some((t) => t.name === 'US 10Y'), false);
  for (const n of ['S&P 500', 'Nasdaq Composite', 'Dow Jones', 'IWM (R2K proxy)', 'VIX']) assert.ok(body.tiles.some((t) => t.name === n), n);
});

test('desk-market handler: index tiles carry a NAMED ETF proxy ext line; VIX has none; ext is never folded into chg', async () => {
  const q = (symbol, reg, post) => ({ symbol, regularMarketChangePercent: reg, postMarketPrice: 100, postMarketChangePercent: post, postMarketTime: 1_800_000_000 });
  const quotes = [q('SPY', 1, 1), q('QQQ', 2, -1), q('DIA', 0, 0.5), q('IWM', -1, 1), q('XLK', 1, 2)];
  const f = marketFetch({ quotes });
  const e = dm({ now: ET('2026-10-14T17:30:00-04:00'), fetch: f.fn });
  const body = await (await e.handler(mreq())).json();
  const tile = (n) => body.tiles.find((t) => t.name === n);
  deq([tile('S&P 500').extProxy.sym, tile('Nasdaq Composite').extProxy.sym, tile('Dow Jones').extProxy.sym, tile('IWM (R2K proxy)').extProxy.sym], ['SPY', 'QQQ', 'DIA', 'IWM']);
  assert.equal(tile('S&P 500').extProxy.chg, 2.01);
  assert.equal(tile('VIX').extProxy, undefined, 'VIX has no ETF proxy');
  assert.equal(tile('S&P 500').ext, undefined, 'an index has no extended print of its own');
  assert.equal(tile('XLK').ext.chg, 3.02, 'an ETF carries its own ext line');
  assert.equal(tile('S&P 500').chg, 0.92, 'the regular day change is the bars\' own (109.5 / 108.5), untouched by the ext print');
  assert.ok(body.extAt, 'the newest extended print is stamped');
});

test('desk-market handler: a GET is served, an unsupported method is a 405 JSON', async () => {
  const e = dm({ fetch: marketFetch().fn });
  const r = await e.handler(new Request('https://fn.test/desk-market', { method: 'PUT', body: '{}' }));
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const o = await e.handler(new Request('https://fn.test/desk-market', { method: 'OPTIONS' }));
  assert.equal(o.headers.get('access-control-allow-origin'), '*');
});

test('desk-market handler: a body cached during the session is dropped once the bell rings', async () => {
  const f = marketFetch();
  const e = dm({ now: ET('2026-10-14T15:59:30-04:00'), fetch: f.fn });
  await e.handler(mreq());
  const n1 = f.calls.filter((u) => u.includes('/v8/finance/chart/')).length;
  e.clock.now = ET('2026-10-14T15:59:50-04:00');
  await e.handler(mreq());
  assert.equal(f.calls.filter((u) => u.includes('/v8/finance/chart/')).length, n1, 'served from cache inside the session TTL');
  e.clock.now = ET('2026-10-14T16:00:20-04:00');
  await e.handler(mreq());
  assert.ok(f.calls.filter((u) => u.includes('/v8/finance/chart/')).length > n1, 'mid-session body is not served under the close');
});

test('desk-market handler: force is honoured at most once per 30 s', async () => {
  const f = marketFetch();
  const e = dm({ now: ET('2026-10-17T12:00:00-04:00'), fetch: f.fn });
  const sweeps = () => f.calls.filter((u) => u.includes('fred.stlouisfed.org')).length;
  await e.handler(mreq());
  assert.equal(sweeps(), 1);
  await e.handler(mreq({ force: true }));
  assert.equal(sweeps(), 2, 'the first force sweeps');
  e.clock.now += 5_000;
  await e.handler(mreq({ force: true }));
  assert.equal(sweeps(), 2, 'a second force inside 30 s is a cached read');
  e.clock.now += 30_000;
  await e.handler(mreq({ force: true }));
  assert.equal(sweeps(), 3);
});

test('desk-market handler: every core index failing is a 502 JSON with no cache to fall back on', async () => {
  const f = marketFetch({ yahooOk: false });
  const e = dm({ now: ET('2026-10-17T12:00:00-04:00'), fetch: f.fn });
  const r = await e.handler(mreq());
  assert.equal(r.status, 502);
  const b = await r.json();
  assert.equal(b.ok, false);
});
