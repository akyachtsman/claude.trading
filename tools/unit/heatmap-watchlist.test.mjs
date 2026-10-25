/* Unit tests for the internal helpers of three public feed edge functions:
   supabase/functions/desk-heatmap, desk-watchlist and desk-maps.

     node --test tools/unit/heatmap-watchlist.test.mjs     (needs `npm ci --prefix tools` once)

   Each check loads the committed function into a fresh `vm` context (lib.mjs `loadEdge`), so
   module caches start cold. `fetch` is a stub that records every call; nothing reaches the
   network or the live Supabase project. A test marked `todo` documents a suspected defect: it
   asserts what the function SHOULD do and is reported, not failed, until the code is fixed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadEdge, loadData } from './lib.mjs';

const MAP_FILTERS = JSON.parse(readFileSync(path.join(ROOT, 'config/map-filters.json'), 'utf8'));

// Values built inside the vm belong to another realm, so deepStrictEqual would compare their
// prototypes and fail on equal data. Flatten to plain JSON first (a Map becomes an object, a
// Set an array).
const plain = (x) => JSON.parse(JSON.stringify(x, (_k, v) => {
  if (v && typeof v === 'object' && v.constructor?.name === 'Map') return Object.fromEntries(v);
  if (v && typeof v === 'object' && v.constructor?.name === 'Set') return [...v];
  return v;
}));
const at = (iso) => Date.parse(iso);
const hasUserAgent = (init) => Object.keys(init?.headers || {}).some((k) => k.toLowerCase() === 'user-agent');

/* A recording fetch: `routes` is a list of [predicate(url, init), responder(url, init)]. An
   unmatched call rejects, so a request the test did not expect is visible as a failure. */
function stubFetch(routes) {
  const calls = [];
  const fetch = async (u, init = {}) => {
    const url = String(u);
    calls.push({ url, init });
    for (const [match, respond] of routes) if (match(url, init)) return respond(url, init);
    throw new Error('unexpected fetch ' + url);
  };
  return { fetch, calls };
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ── desk-heatmap ─────────────────────────────────────────────────────────────
const HEAT = ['marketSessionOpen', 'withinCloseSettleGrace', 'withinPostMarket', 'ttlMs', 'inLanes', 'yahooTicker',
  'parseCsv', 'parseConstituents', 'parseScreener', 'parseSpark', 'periodsFromCloses', 'dedupeMultiClass',
  'buildHeatmap', 'r2kConstituents', 'buildEtfMap', 'lastTradingDayIso', 'scrubbed', 'sweepComplete',
  'mergeFreshQuotes', 'readSweepRow', 'writeSweepRow', 'advanceSweep', 'kickPeriodSweep', 'loadEtfCats',
  'DEFAULT_ETF_CATS', 'NYSE_HOLIDAYS'];
const heat = (opts) => loadEdge('desk-heatmap', HEAT, opts);
const DB_ENV = { SUPABASE_URL: 'https://db.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key-123' };

test('desk-heatmap: the session clock follows New York, weekdays and NYSE holidays', () => {
  const h = heat();
  const open = (iso) => h.marketSessionOpen(new Date(iso));
  assert.equal(open('2026-10-14T13:29:00Z'), false, '09:29 EDT is before the bell');
  assert.equal(open('2026-10-14T13:30:00Z'), true, '09:30 EDT opens');
  assert.equal(open('2026-10-14T19:59:00Z'), true, '15:59 EDT is still open');
  assert.equal(open('2026-10-14T20:00:00Z'), false, '16:00 EDT is shut');
  assert.equal(open('2026-12-14T14:30:00Z'), true, '09:30 EST (winter offset) opens');
  assert.equal(open('2026-10-17T15:00:00Z'), false, 'a Saturday');
  assert.equal(open('2026-11-26T16:00:00Z'), false, 'Thanksgiving 2026');
  assert.equal(open('2027-03-26T15:00:00Z'), false, 'Good Friday 2027');

  assert.equal(h.withinCloseSettleGrace(new Date('2026-10-14T19:59:00Z')), false, 'before the close');
  assert.equal(h.withinCloseSettleGrace(new Date('2026-10-14T20:00:00Z')), true, '16:00 ET starts the grace');
  assert.equal(h.withinCloseSettleGrace(new Date('2026-10-14T20:14:00Z')), true, '16:14 ET is inside it');
  assert.equal(h.withinCloseSettleGrace(new Date('2026-10-14T20:15:00Z')), false, '16:15 ET ends it');
  assert.equal(h.withinCloseSettleGrace(new Date('2026-10-17T20:05:00Z')), false, 'never on a Saturday');

  assert.equal(h.withinPostMarket(new Date('2026-10-14T23:59:00Z')), true, '19:59 ET is post-market');
  assert.equal(h.withinPostMarket(new Date('2026-10-15T00:00:00Z')), false, '20:00 ET ends it');
  assert.equal(h.withinPostMarket(new Date('2026-11-26T22:00:00Z')), false, 'no after-hours on a holiday');
});

test('desk-heatmap: ttlMs is 5 min through the session, the settle grace and post-market, 60 min otherwise', () => {
  const h = heat();
  const ttl = (iso) => { h.clock.now = at(iso); return h.ttlMs(); };
  assert.equal(ttl('2026-10-14T15:00:00Z'), 300_000, 'session');
  assert.equal(ttl('2026-10-14T20:05:00Z'), 300_000, 'settle grace');
  assert.equal(ttl('2026-10-14T22:30:00Z'), 300_000, '18:30 ET post-market');
  assert.equal(ttl('2026-10-15T02:00:00Z'), 3_600_000, '22:00 ET');
  assert.equal(ttl('2026-10-18T15:00:00Z'), 3_600_000, 'Sunday');
});

test('desk-heatmap: NYSE_HOLIDAYS agrees with scripts/data.js for every year it carries', () => {
  const h = heat();
  const d = loadData();
  const mine = [...h.NYSE_HOLIDAYS].sort();
  const years = new Set(mine.map((s) => s.slice(0, 4)));
  const theirs = [...d.NYSE_HOLIDAYS].filter((s) => years.has(s.slice(0, 4))).sort();
  assert.deepEqual(mine, theirs);
});

test('desk-heatmap: inLanes retires a lane after ITS OWN two consecutive failures, never the whole sweep', async () => {
  const h = heat();
  const run = async (n, fails, stop = () => false) => {
    const seen = [];
    await h.inLanes([...Array(n).keys()], async (i) => { seen.push(i); return !fails(i); }, stop);
    return seen.sort((a, b) => a - b);
  };
  assert.deepEqual(await run(20, () => false), [...Array(20).keys()], 'all healthy: every batch runs');
  assert.deepEqual(await run(20, (i) => i < 2), [...Array(20).keys()], 'two failures in DIFFERENT lanes stop no one');
  assert.equal((await run(20, () => true)).length, 8, 'a real outage ends after two failures per lane (4 lanes)');
  assert.deepEqual(await run(20, () => false, () => true), [], 'the deadline is checked before each batch');
  assert.deepEqual(await run(0, () => false), [], 'no items, no lanes');
  assert.deepEqual(await run(2, () => false), [0, 1], 'fewer items than lanes');
});

test('desk-heatmap: yahooTicker trims, upper-cases and hyphenates every dot', () => {
  const h = heat();
  assert.equal(h.yahooTicker(' brk.b '), 'BRK-B');
  assert.equal(h.yahooTicker('BF.B'), 'BF-B');
  assert.equal(h.yahooTicker('AAPL'), 'AAPL');
});

test('desk-heatmap: parseCsv handles quoted commas, escaped quotes, CRLF and a missing final newline', () => {
  const h = heat();
  const rows = plain(h.parseCsv('Symbol,Security,Sector\r\nMMM,"3M, Inc.",Industrials\r\nX,"say ""hi""",Tech\nsolo\nZ,Zed,Util'));
  assert.deepEqual(rows, [
    ['Symbol', 'Security', 'Sector'],
    ['MMM', '3M, Inc.', 'Industrials'],
    ['X', 'say "hi"', 'Tech'],
    ['Z', 'Zed', 'Util'],
  ], 'a one-field line ("solo") is dropped');
  assert.deepEqual(plain(h.parseCsv('')), []);
});

test('desk-heatmap: parseConstituents finds its columns by name and drops rows without a sector', () => {
  const h = heat();
  const csv = 'Symbol,Security,GICS Sector,GICS Sub-Industry,CIK\n'
    + 'brk.b,"Berkshire Hathaway",Financials,"Multi-Sector Holdings",1\n'
    + 'AAPL,Apple Inc.,Information Technology,Technology Hardware,2\n'
    + 'NOSEC,No Sector,,Thing,3\n';
  assert.deepEqual(plain(h.parseConstituents(csv)), [
    { sym: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financials', ind: 'Multi-Sector Holdings' },
    { sym: 'AAPL', name: 'Apple Inc.', sector: 'Information Technology', ind: 'Technology Hardware' },
  ]);
  assert.throws(() => h.parseConstituents('Ticker,Name\nA,B\n'), /missing symbol\/sector/);
  // The sub-industry column must not be mistaken for the sector column.
  const swapped = 'Symbol,GICS Sub-Industry,Name,GICS Sector\nA,Sub,Alpha,Energy\n';
  assert.deepEqual(plain(h.parseConstituents(swapped)), [{ sym: 'A', name: 'Alpha', sector: 'Energy', ind: 'Sub' }]);
});

test('desk-heatmap: parseScreener reads Nasdaq\'s formatted strings and registers a dotted ticker twice', () => {
  const h = heat();
  const m = h.parseScreener({ data: { rows: [
    { symbol: 'brk.b', pctchange: '+1.234%', marketCap: '$1,000,000,000', lastsale: '$480.10', sector: 'Finance', name: ' Berkshire ', industry: '' },
    { symbol: 'ZERO', pctchange: '-0.5%', marketCap: '0', lastsale: 'n/a' },
    { symbol: 'JUNK', pctchange: 'abc' },
    { symbol: '', pctchange: '1%' },
  ] } });
  const b = plain(m.get('BRK.B'));
  assert.deepEqual(b, { pct: 1.23, cap: 1e9, last: 480.1, sector: 'Finance', name: 'Berkshire' });
  assert.equal(m.get('BRK-B'), m.get('BRK.B'), 'the hyphen alias is the SAME quote object');
  assert.deepEqual(plain(m.get('ZERO')), { pct: -0.5, cap: null, last: null }, 'a zero cap and a junk price are null');
  assert.equal(m.has('JUNK'), false, 'a non-numeric change skips the row');
  assert.equal(m.size, 3);
  assert.equal(h.parseScreener(null).size, 0);
  assert.equal(h.parseScreener({ data: {} }).size, 0);
});

test('desk-heatmap: an UNKNOWN screener change ("" or "--") is not read as a flat 0.00%', {
  todo: 'BUG: parseScreener maps a blank/"--" pctchange to pct 0, so a symbol with no reading tints as flat (unknown must never be 0)',
}, () => {
  const h = heat();
  const m = h.parseScreener({ data: { rows: [
    { symbol: 'BLANK', pctchange: '', marketCap: '$5,000', lastsale: '$1' },
    { symbol: 'DASH', pctchange: '--', marketCap: '$5,000', lastsale: '$1' },
  ] } });
  for (const s of ['BLANK', 'DASH']) {
    const q = m.get(s);
    assert.ok(!q || q.pct == null || !Number.isFinite(q.pct), `${s} must not read 0.00%`);
  }
});

test('desk-heatmap and desk-maps: parseSpark needs two positive closes and rounds to cents', () => {
  for (const [name, extra] of [['desk-heatmap', { cap: null }], ['desk-maps', {}]]) {
    const { parseSpark } = loadEdge(name, ['parseSpark']);
    const m = parseSpark({
      UP: { close: [100, 0, null, 110.004] },   // 0 and null are skipped, so the pair is 100 → 110.004
      ONE: { close: [5] },
      NONE: {},
      NEG: { close: [-1, 10] },
    });
    assert.deepEqual(plain(m), { UP: { pct: 10, ...extra, last: 110 } }, name);
    assert.equal(parseSpark(null).size, 0, name);
  }
});

test('desk-heatmap: periodsFromCloses measures 1W/1M back 5/21 sessions and YTD from the prior year\'s last close', () => {
  const h = heat();
  const dates = [], closes = [];
  const d = new Date('2025-12-24T12:00:00Z');
  while (dates.length < 30) {
    if (d.getUTCDay() % 6 !== 0) { dates.push(d.toISOString().slice(0, 10)); closes.push(100 + dates.length - 1); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const last = closes[29];
  const pct = (ref) => Number(((last / ref - 1) * 100).toFixed(2));
  const lastOf2025 = dates.filter((x) => x < '2026').length - 1;
  assert.deepEqual(plain(h.periodsFromCloses(dates, closes)),
    { w: pct(closes[24]), m: pct(closes[8]), ytd: pct(closes[lastOf2025]) });

  assert.deepEqual(plain(h.periodsFromCloses(['2026-01-02'], [1])), { w: null, m: null, ytd: null }, 'one close');
  assert.equal(h.periodsFromCloses(dates.slice(0, 5), closes.slice(0, 5)).w, null, 'five closes: no week yet');
  assert.notEqual(h.periodsFromCloses(dates.slice(0, 6), closes.slice(0, 6)).w, null, 'six closes: a week');
  assert.equal(h.periodsFromCloses(dates.slice(0, 21), closes.slice(0, 21)).m, null, '21 closes: no month');
  const thisYear = dates.map((x) => x.replace(/^2025/, '2026'));
  assert.equal(h.periodsFromCloses(thisYear, closes).ytd, null, 'no prior-year close in the series: YTD unknown, not 0');
  const zeroRef = closes.slice(); zeroRef[24] = 0;
  assert.equal(h.periodsFromCloses(dates, zeroRef).w, null, 'a zero reference is unknown');
});

test('desk-heatmap: dedupeMultiClass keeps one tile per company, the Class A row', () => {
  const h = heat();
  const c = (sym, name) => ({ sym, name, sector: 'S', ind: '' });
  const out = plain(h.dedupeMultiClass([
    c('GOOG', 'Alphabet Inc. (Class C)'), c('GOOGL', 'Alphabet Inc. (Class A)'),
    c('FOX', 'Fox Corporation (Class B)'), c('FOXA', 'Fox Corporation (Class A)'),
    c('AAPL', 'Apple Inc.'),
    c('XB', 'Twoclass Co (Class B)'), c('XC', 'Twoclass Co (Class C)'),
  ])).map((r) => r.sym);
  assert.deepEqual(out, ['GOOGL', 'FOXA', 'AAPL', 'XB'], 'no Class A row: the first row stands');
});

test('desk-heatmap: buildHeatmap sizes by cap (falling back to the last known one) and carries extended prints only when present', () => {
  const h = heat();
  const cons = [
    { sym: 'BRK.B', name: 'Berkshire', sector: 'Fin', ind: 'Ins' },
    { sym: 'JPM', name: 'JPMorgan', sector: 'Fin', ind: 'Bank' },
    { sym: 'NOCAP', name: 'No cap', sector: 'Tech', ind: '' },
    { sym: 'XOM', name: 'Exxon', sector: 'Energy', ind: '' },
  ];
  const quotes = new Map([
    ['BRK-B', { pct: 1, cap: 900, last: 480 }],
    ['JPM', { pct: -2, cap: null, last: 200, extPct: 0.5, extLast: 201 }],
    ['NOCAP', { pct: 3, cap: null, last: 1 }],
    ['XOM', { pct: NaN, cap: 500, last: 100 }],
  ]);
  const periods = new Map([['BRK-B', { w: 1, m: 2, ytd: 3 }]]);
  const r = plain(h.buildHeatmap(cons, quotes, new Map([['JPM', 600]]), periods));
  assert.equal(r.covered, 2, 'no cap anywhere and a NaN change are both left out');
  assert.deepEqual(r.sectors.map((s) => [s.name, s.cap]), [['Fin', 1500]]);
  const [brk, jpm] = r.sectors[0].tiles;
  assert.deepEqual([brk.sym, brk.cap, brk.pctW, brk.pctM, brk.pctYtd, 'extPct' in brk], ['BRK.B', 900, 1, 2, 3, false]);
  assert.deepEqual([jpm.sym, jpm.cap, jpm.extPct, jpm.extLast, 'pctW' in jpm], ['JPM', 600, 0.5, 201, false]);
});

test('desk-heatmap: r2kConstituents skips the top 1000 caps, aliases, warrants/units/rights and sector-less rows', () => {
  const h = heat();
  const quotes = new Map();
  for (let i = 0; i < 1005; i++) quotes.set(`S${i}`, { pct: 0, cap: 1e6 - i, sector: 'Sec', name: `N${i}`, industry: 'Ind' });
  const dual = { pct: 0, cap: 1, sector: 'Sec' };
  quotes.set('DU.A', dual); quotes.set('DU-A', dual);     // parseScreener's alias pair: counted once
  quotes.set('WT.W', { pct: 0, cap: 2, sector: 'Sec' });
  quotes.set('NOSEC', { pct: 0, cap: 3 });
  const out = plain(h.r2kConstituents(quotes));
  assert.deepEqual(out.map((r) => r.sym), ['S1000', 'S1001', 'S1002', 'S1003', 'S1004', 'DU.A']);
  assert.deepEqual(out[0], { sym: 'S1000', name: 'N1000', sector: 'Sec', ind: 'Ind' });
});

test('desk-heatmap: buildEtfMap gives EVERY banded ETF with a quote a tile, in its own band, with no catch-all', () => {
  const h = heat();
  const cats = plain(h.DEFAULT_ETF_CATS);
  const quotes = new Map(Object.keys(cats).map((s, i) => [s, { pct: i / 10, cap: null, last: 10 + i, advol: i % 3 ? 1000 * (i + 1) : null }]));
  const r = plain(h.buildEtfMap(cats, quotes));
  assert.equal(r.covered, Object.keys(cats).length);
  const tiles = r.sectors.flatMap((s) => s.tiles);
  assert.equal(tiles.length, Object.keys(cats).length, 'a missing volume does not drop a tile');
  assert.deepEqual(new Set(r.sectors.map((s) => s.name)), new Set(Object.values(cats)), 'only the roster\'s own bands');
  for (const s of r.sectors) for (const t of s.tiles) assert.equal(cats[t.sym], s.name, `${t.sym} is in its own band`);
  for (const t of tiles) assert.ok(t.cap >= 1, `${t.sym} has a positive area`);
  // A symbol with no quote (or a NaN change) is the only thing left out.
  quotes.delete('SPY'); quotes.set('QQQ', { pct: NaN, cap: null, last: 1 });
  assert.equal(h.buildEtfMap(cats, quotes).covered, Object.keys(cats).length - 2);
});

test('desk-heatmap: the built-in ETF roster is the committed config\'s etfCats (the fallback must not drift)', () => {
  const h = heat();
  assert.deepEqual(plain(h.DEFAULT_ETF_CATS), MAP_FILTERS.etfCats);
});

test('desk-heatmap: loadEtfCats reads the roster, normalises and caps it, and falls back on a malformed file', async () => {
  const cats = { ' spy ': ' Broad market ', qqq: 'Broad market', BAD: 7, EMPTY: '  ' };
  for (let i = 0; i < 80; i++) cats[`E${i}`] = 'Sector';
  let h = heat({ fetch: stubFetch([[() => true, () => json({ etfCats: cats })]]).fetch });
  const got = plain(await h.loadEtfCats());
  assert.equal(got.SPY, 'Broad market');
  assert.equal(got.QQQ, 'Broad market');
  assert.equal('BAD' in got || 'EMPTY' in got, false, 'a non-string or blank band is dropped');
  assert.equal(Object.keys(got).length, 60, 'capped at ETF_CAP');

  for (const body of [{ etfCats: [] }, { etfCats: {} }, {}, null]) {
    h = heat({ fetch: stubFetch([[() => true, () => json(body)]]).fetch });
    assert.deepEqual(plain(await h.loadEtfCats()), plain(h.DEFAULT_ETF_CATS), JSON.stringify(body));
  }
  h = heat({ fetch: () => Promise.reject(new Error('down')) });
  assert.deepEqual(plain(await h.loadEtfCats()), plain(h.DEFAULT_ETF_CATS), 'unreachable');
});

test('desk-heatmap: lastTradingDayIso is the New York calendar day, weekends rolled back to Friday', () => {
  const h = heat();
  const day = (iso) => { h.clock.now = at(iso); return h.lastTradingDayIso(); };
  assert.equal(day('2026-10-15T01:00:00Z'), '2026-10-14', '21:00 EDT Wed is still Wednesday in New York (UTC says Thursday)');
  assert.equal(day('2026-10-17T15:00:00Z'), '2026-10-16', 'Saturday → Friday');
  assert.equal(day('2026-10-18T15:00:00Z'), '2026-10-16', 'Sunday → Friday');
  assert.equal(day('2026-10-19T15:00:00Z'), '2026-10-19', 'Monday');
});

test('desk-heatmap and desk-maps: lastTradingDayIso rolls an NYSE holiday back to the session before it', () => {
  for (const name of ['desk-heatmap', 'desk-maps']) {
    const h = loadEdge(name, ['lastTradingDayIso'], { now: at('2026-11-26T18:00:00Z') });
    assert.equal(h.lastTradingDayIso(), '2026-11-25', name);
    h.clock.now = at('2027-12-26T18:00:00Z'); // Sunday after a Friday holiday (Christmas observed Dec 24)
    assert.equal(h.lastTradingDayIso(), '2027-12-23', `${name}: a weekend after a holiday rolls past both`);
    h.clock.now = at('2026-11-27T18:00:00Z');
    assert.equal(h.lastTradingDayIso(), '2026-11-27', `${name}: the day after is itself`);
  }
});

test('desk-maps: its NYSE_HOLIDAYS copy agrees with desk-heatmap\'s', () => {
  const m = loadEdge('desk-maps', ['NYSE_HOLIDAYS']);
  assert.deepEqual([...m.NYSE_HOLIDAYS].sort(), [...heat().NYSE_HOLIDAYS].sort());
});

test('desk-heatmap: scrubbed() removes the service key from anything it prints', () => {
  let h = heat({ env: DB_ENV });
  assert.equal(h.scrubbed(`bad key ${DB_ENV.SUPABASE_SERVICE_ROLE_KEY} twice ${DB_ENV.SUPABASE_SERVICE_ROLE_KEY}`), 'bad key [key] twice [key]');
  assert.equal(h.scrubbed(42), '42');
  h = heat({ env: {} });
  assert.equal(h.scrubbed('no key set'), 'no key set');
});

test('desk-heatmap: sweepComplete needs a non-empty, finished ledger younger than 24 h', () => {
  const h = heat({ now: at('2026-10-14T12:00:00Z') });
  const now = h.clock.now;
  assert.equal(h.sweepComplete(null), false);
  assert.equal(h.sweepComplete({ at: now, done: 0, total: 0, map: {} }), false, 'an empty roster is not complete');
  assert.equal(h.sweepComplete({ at: now, done: 499, total: 500, map: {} }), false);
  assert.equal(h.sweepComplete({ at: now, done: 500, total: 500, map: {} }), true);
  assert.equal(h.sweepComplete({ at: now - 86_400_000 + 1, done: 500, total: 500, map: {} }), true);
  assert.equal(h.sweepComplete({ at: now - 86_400_000, done: 500, total: 500, map: {} }), false, 'a day old is stale');
});

test('desk-heatmap: mergeFreshQuotes overlays by CONSTITUENT so BRK.B and BRK-B meet, and counts only real changes', () => {
  const h = heat();
  const cons = [{ sym: 'BRK.B' }, { sym: 'AAPL' }, { sym: 'MISS' }, { sym: 'NANP' }];
  const brk = { pct: 0, cap: 1, last: 1 };
  const quotes = new Map([['BRK.B', brk], ['BRK-B', brk], ['AAPL', { pct: 0, cap: 1, last: 1 }], ['NANP', { pct: 7, cap: 1, last: 5 }]]);
  const fresh = new Map([
    ['BRK-B', { pct: 1.5, cap: null, last: 481, extPct: -0.2, extLast: 480 }],
    ['AAPL', { pct: -0.3, cap: null, last: null }],
    ['NANP', { pct: NaN, cap: null, last: 6 }],
  ]);
  assert.equal(h.mergeFreshQuotes(cons, quotes, fresh), 2);
  assert.deepEqual(plain(quotes.get('BRK.B')), { pct: 1.5, cap: 1, last: 481, extPct: -0.2, extLast: 480 });
  assert.deepEqual(plain(quotes.get('AAPL')), { pct: -0.3, cap: 1, last: 1 }, 'a null price keeps the old one');
  assert.deepEqual(plain(quotes.get('NANP')), { pct: 7, cap: 1, last: 6 }, 'a NaN change keeps the old change');
});

test('desk-heatmap: readSweepRow returns null ONLY for "no row yet" and THROWS on a failed read', async () => {
  const cases = [
    [() => json([]), null],
    [() => json([{ at: '2026-10-14T00:00:00Z', payload: { done: '3', total: 5, map: { A: { w: 1, m: null, ytd: null } } } }]),
      { at: at('2026-10-14T00:00:00Z'), done: 3, total: 5, map: { A: { w: 1, m: null, ytd: null } } }],
    [() => json([{ at: '2026-10-14T00:00:00Z' }]), { at: at('2026-10-14T00:00:00Z'), done: 0, total: 0, map: {} }],
  ];
  for (const [respond, want] of cases) {
    const s = stubFetch([[() => true, respond]]);
    const h = heat({ env: DB_ENV, fetch: s.fetch });
    assert.deepEqual(plain(await h.readSweepRow('sp500')), want);
    const { url, init } = s.calls[0];
    assert.equal(url, 'https://db.supabase.test/rest/v1/desk_feed_cache?select=at,payload&key=eq.periods:sp500');
    assert.equal(hasUserAgent(init), false, 'a browser-shaped UA on a secret-key REST call is refused by the gateway');
    assert.equal(init.headers.apikey, DB_ENV.SUPABASE_SERVICE_ROLE_KEY);
  }
  for (const [label, f] of [
    ['HTTP 500', async () => json({ message: 'boom' }, 500)],
    ['network error', async () => { throw new TypeError('fetch failed'); }],
    ['a non-array body', async () => json({ rows: [] })],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 })],
  ]) {
    const h = heat({ env: DB_ENV, fetch: f });
    await assert.rejects(h.readSweepRow('sp500'), undefined, label);
  }
});

// A 1-year spark answer for the period sweep: 30 weekday closes ending 2026-10-13.
function sparkYear(syms) {
  const ts = [], close = [];
  const d = new Date('2026-08-31T20:00:00Z');
  while (ts.length < 30) { if (d.getUTCDay() % 6 !== 0) { ts.push(d.getTime() / 1000); close.push(100 + ts.length); } d.setUTCDate(d.getUTCDate() + 1); }
  return Object.fromEntries(syms.map((s) => [s, { timestamp: ts, close }]));
}

test('desk-heatmap: a FAILED ledger read never leads to a write (one blip must not overwrite a complete row)', async () => {
  const s = stubFetch([[(u) => u.includes('/rest/v1/'), () => json({ message: 'down' }, 503)]]);
  const h = heat({ env: DB_ENV, fetch: s.fetch });
  await h.kickPeriodSweep('sp500', ['AAPL', 'MSFT']);
  assert.equal(s.calls.filter((c) => c.init.method === 'POST').length, 0, 'no ledger write');
  assert.equal(s.calls.filter((c) => c.url.includes('finance.yahoo.com')).length, 0, 'no sweep from scratch');
  assert.ok(h.logs.some((l) => /sweep step sp500 skipped/.test(l)), 'the skip is logged');
  assert.ok(h.logs.every((l) => !l.includes(DB_ENV.SUPABASE_SERVICE_ROLE_KEY)), 'never with the key');
});

test('desk-heatmap: advanceSweep keys the ledger by ROSTER symbol, records Yahoo\'s empty answers and retries failed batches', async () => {
  const now = at('2026-10-14T15:00:00Z');
  let posted = null;
  const s = stubFetch([
    [(u, i) => u.includes('/rest/v1/') && i.method === 'POST', (_u, i) => { posted = JSON.parse(i.body); return json([], 201); }],
    [(u) => u.includes('/rest/v1/'), () => json([{ at: new Date(now - 3_600_000).toISOString(), payload: { done: 2, total: 4, map: { OLD: { w: 1, m: 1, ytd: 1 }, KEEP: { w: 2, m: 2, ytd: 2 } } } }])],
    [(u) => u.includes('symbols=BRK-B,GONE'), () => json(sparkYear(['BRK-B']))],   // Yahoo answers, but has nothing for GONE
  ]);
  const h = heat({ env: DB_ENV, fetch: s.fetch, now });
  await h.advanceSweep('sp500', ['KEEP', 'BRK.B', 'GONE']);
  assert.ok(posted, 'the step is written');
  const row = posted[0];
  assert.equal(row.key, 'periods:sp500');
  assert.deepEqual(Object.keys(row.payload.map).sort(), ['BRK.B', 'GONE', 'KEEP'], 'OLD left the roster and is dropped; BRK.B is stored under its roster form');
  assert.deepEqual(row.payload.map.GONE, { w: null, m: null, ytd: null }, 'an answered symbol with no data is an EMPTY reading');
  assert.equal(typeof row.payload.map['BRK.B'].w, 'number');
  assert.deepEqual([row.payload.done, row.payload.total], [3, 3]);
  const post = s.calls.find((c) => c.init.method === 'POST');
  assert.equal(hasUserAgent(post.init), false, 'the ledger write carries no browser UA either');
  assert.equal(post.init.headers.prefer, 'resolution=merge-duplicates');

  // The same step with the Yahoo batch FAILING leaves the new symbols missing (retried next request).
  posted = null;
  const s2 = stubFetch([
    [(u, i) => u.includes('/rest/v1/') && i.method === 'POST', (_u, i) => { posted = JSON.parse(i.body); return json([], 201); }],
    [(u) => u.includes('/rest/v1/'), () => json([])],
    [(u) => u.includes('finance.yahoo.com'), () => json({}, 500)],
  ]);
  const h2 = heat({ env: DB_ENV, fetch: s2.fetch, now });
  await h2.advanceSweep('sp500', ['AAA', 'BBB']);
  assert.deepEqual(posted[0].payload, { done: 0, total: 2, map: {} });
});

test('desk-heatmap: a complete, fresh ledger with nothing to sweep is NOT rewritten (its 24 h clock keeps running)', async () => {
  const now = at('2026-10-14T15:00:00Z');
  const map = { A: { w: 1, m: 1, ytd: 1 }, B: { w: 1, m: 1, ytd: 1 } };
  const s = stubFetch([
    [(u, i) => u.includes('/rest/v1/') && i.method === 'POST', () => json([], 201)],
    [(u) => u.includes('/rest/v1/'), () => json([{ at: new Date(now - 7_200_000).toISOString(), payload: { done: 2, total: 2, map } }])],
  ]);
  const h = heat({ env: DB_ENV, fetch: s.fetch, now });
  await h.advanceSweep('sp500', ['A', 'B']);
  assert.equal(s.calls.length, 1, 'one read, no Yahoo call, no write');
});

test('desk-heatmap: a rejected ledger write is logged with the key scrubbed', async () => {
  const key = DB_ENV.SUPABASE_SERVICE_ROLE_KEY;
  const s = stubFetch([[() => true, () => new Response(`denied for ${key}`, { status: 401 })]]);
  const h = heat({ env: DB_ENV, fetch: s.fetch });
  await h.writeSweepRow('etf', { at: 0, done: 0, total: 0, map: {} });
  assert.ok(h.logs.some((l) => /ledger write periods:etf failed HTTP 401/.test(l) && l.includes('[key]')));
  assert.ok(h.logs.every((l) => !l.includes(key)));
});

// ── desk-watchlist ───────────────────────────────────────────────────────────
const WL = ['rangeKey', 'sessionOpen', 'ttlMs', 'toYahoo', 'num', 'priceRow', 'buildSpark', 'normalizeLists',
  'listsFromTable', 'rosterFp', 'listsFromConfig', 'WL_RANGES', 'MAX_SYMBOLS'];
const wl = (opts) => loadEdge('desk-watchlist', WL, opts);

test('desk-watchlist: rangeKey accepts only its own tokens (nothing the caller sends reaches Yahoo)', () => {
  const w = wl();
  for (const k of ['1d', '1mo', '3mo', '6mo', '1y', '2y', '5y']) assert.equal(w.rangeKey(k), k);
  for (const k of ['10y', '1D', '', null, undefined, 5, {}, 'toString', '__proto__', '1d&interval=1m']) assert.equal(w.rangeKey(k), '1d', String(k));
  assert.deepEqual(Object.keys(plain(w.WL_RANGES)), ['1d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);
});

test('desk-watchlist: sessionOpen is the weekday 09:30–16:00 ET session and ttlMs follows it (1 min / 60 min)', () => {
  const w = wl();
  const open = (iso) => w.sessionOpen(new Date(iso));
  assert.equal(open('2026-10-14T13:29:00Z'), false);
  assert.equal(open('2026-10-14T13:30:00Z'), true);
  assert.equal(open('2026-10-14T19:59:00Z'), true);
  assert.equal(open('2026-10-14T20:00:00Z'), false);
  assert.equal(open('2026-12-14T14:29:00Z'), false, 'EST: 09:29');
  assert.equal(open('2026-12-14T14:30:00Z'), true, 'EST: 09:30');
  assert.equal(open('2026-10-17T15:00:00Z'), false, 'Saturday');
  // Documented: holidays are not modelled here (a holiday merely polls at the open cadence).
  assert.equal(open('2026-11-26T16:00:00Z'), true, 'Thanksgiving polls as open, by design');
  w.clock.now = at('2026-10-14T15:00:00Z'); assert.equal(w.ttlMs(), 60_000);
  w.clock.now = at('2026-10-14T21:00:00Z'); assert.equal(w.ttlMs(), 3_600_000);
});

test('desk-watchlist: toYahoo hyphenates a share-class dot only, never an exchange suffix', () => {
  const w = wl();
  assert.equal(w.toYahoo('BRK.B'), 'BRK-B');
  assert.equal(w.toYahoo('DX-Y.NYB'), 'DX-Y.NYB');
  assert.equal(w.toYahoo('^VIX'), '^VIX');
  assert.equal(w.toYahoo('ES=F'), 'ES=F');
  assert.equal(w.toYahoo('AAPL'), 'AAPL');
});

test('desk-watchlist: num keeps only finite numbers', () => {
  const w = wl();
  assert.equal(w.num(1.5), 1.5);
  assert.equal(w.num(0), 0);
  for (const x of ['1.5', NaN, Infinity, null, undefined, {}]) assert.equal(w.num(x), null, String(x));
});

test('desk-watchlist: priceRow — regular, post-market compounded from the prior close, pre-market, and indices', () => {
  const w = wl();
  const reg = plain(w.priceRow('AAPL', { regularMarketPrice: 200, regularMarketChangePercent: 1.2345, regularMarketTime: 1000, shortName: 'Apple', bid: 199, ask: 'x', regularMarketVolume: 5 }, [1, 2, 3], true));
  assert.deepEqual(reg, { sym: 'AAPL', name: 'Apple', last: 200, pct: 1.23, ext: false, bid: 199, ask: null, vol: 5, index: false, at: 1000, spark: [1, 2, 3] });

  // The function's own worked example (SOXL): reg −14.522%, post +1.8486% → −12.94%.
  const post = plain(w.priceRow('SOXL', { regularMarketPrice: 30, regularMarketChangePercent: -14.522, postMarketPrice: 30.55, postMarketChangePercent: 1.8486, regularMarketTime: 1000, postMarketTime: 2000, longName: 'Direxion' }, [29, 30], true));
  assert.deepEqual([post.last, post.pct, post.ext, post.at, post.name, post.spark], [30.55, -12.94, true, 2000, 'Direxion', [29, 30, 30.55]]);

  const half = w.priceRow('X', { regularMarketPrice: 10, regularMarketChangePercent: 1, postMarketPrice: 11 }, undefined, true);
  assert.equal(half.pct, null, 'a post price without its own % prints no pill, never the regular session\'s move');
  assert.equal(half.at, null);

  const pre = plain(w.priceRow('Y', { regularMarketPrice: 50, regularMarketChangePercent: 2, preMarketPrice: 51, preMarketChangePercent: 2.004, regularMarketTime: 1000, preMarketTime: 3000 }, [48, 49, 50], true));
  assert.deepEqual([pre.last, pre.pct, pre.ext, pre.at, pre.spark], [51, 2, true, 3000, [50, 51]], 'pre-market draws prior close → pre price, stamped with the pre time');

  assert.equal(w.priceRow('^VIX', { regularMarketPrice: 15 }, undefined, true).index, true);
  assert.equal(w.priceRow('SPX', { regularMarketPrice: 15, quoteType: 'INDEX' }, undefined, true).index, true);
  assert.equal(w.priceRow('Z', {}, undefined, true).name, null);
  assert.equal(w.priceRow('Z', {}, undefined, true).pct, null, 'no change is null, not 0');
});

test('desk-watchlist: buildSpark ends the line where the price is, and only rewrites a ONE-DAY pre-market window', () => {
  const w = wl();
  const b = (...a) => plain(w.buildSpark(...a));
  assert.deepEqual(b([1, 2], null, null, null, true), [1, 2], 'no price: the series as it is');
  assert.equal(w.buildSpark([1], null, null, null, true), null);
  assert.equal(w.buildSpark(undefined, null, null, null, true), null);
  assert.deepEqual(b([1, 2], 3, 2, 'pre', true), [2, 3], 'intraday pre-market: prior close → pre price');
  assert.equal(w.buildSpark([1, 2], 2, 2, 'pre', true), null, 'pre price equal to the prior close: no line');
  assert.equal(w.buildSpark([1, 2], 3, null, 'pre', true), null, 'no prior close: no line');
  assert.deepEqual(b([1, 2], 3.123456, 2, 'pre', false), [1, 2, 3.1235], 'multi-day pre-market keeps the history and appends');
  assert.deepEqual(b([1, 2], 3, 2, 'post', true), [1, 2, 3], 'post-market appends the extended last');
  assert.deepEqual(b([1, 3], 3, 2, 'post', true), [1, 3], 'already ending on it: unchanged');
  assert.deepEqual(b([1, 2], 9, 2, null, true), [1, 2], 'no extended print: the series stands');
  assert.equal(w.buildSpark([5], 9, 2, 'post', true), null);
});

test('desk-watchlist: normalizeLists trims and upper-cases, drops junk and untitled lists, keeps an empty list and the saved order', () => {
  const w = wl();
  const out = plain(w.normalizeLists([
    { title: '  Radar ', symbols: [' brk.b', 'aapl', '!!', '', null, 'TOOLONGTICKER', 'AAPL', '^vix', 'es=f', 7] },
    { title: '', symbols: ['AAPL'] },
    { title: 'Empty', symbols: [] },
    { title: 'NoArray', symbols: 'AAPL,MSFT' },
    { symbols: ['MSFT'] },
    null,
  ]));
  assert.deepEqual(out, [
    { title: 'Radar', symbols: ['BRK.B', 'AAPL', 'AAPL', '^VIX', 'ES=F', '7'] },
    { title: 'Empty', symbols: [] },
    { title: 'NoArray', symbols: [] },
  ], 'the saved order is complete (a repeat is de-duplicated at fetch time, not here)');
});

test('desk-watchlist: rosterFp is a fingerprint of row id/pos/updated_at, independent of read order, capped at 51 rows', () => {
  const w = wl();
  const rows = [{ id: 2, pos: 1, updated_at: 'b', symbols: ['X'] }, { id: 1, pos: 0, updated_at: 'a', symbols: ['Y'] }];
  const fp = w.rosterFp(rows);
  assert.equal(fp, '2|1:0:a,2:1:b');
  assert.equal(w.rosterFp([...rows].reverse()), fp, 'the pos-ordered sweep read and the id-ordered check read agree');
  assert.equal(w.rosterFp(rows.map((r) => ({ ...r, symbols: ['CHANGED'] }))), fp, 'symbol arrays are not read');
  assert.notEqual(w.rosterFp([{ ...rows[0], pos: 5 }, rows[1]]), fp, 'a reorder changes it');
  assert.notEqual(w.rosterFp([{ ...rows[0], updated_at: 'c' }, rows[1]]), fp, 'an edit changes it');
  assert.notEqual(w.rosterFp([rows[1]]), fp, 'a delete changes it');
  assert.equal(w.rosterFp([]), '0|');
  const many = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, pos: i, updated_at: 't' }));
  assert.match(w.rosterFp(many), /^51\|/);
  assert.equal(w.rosterFp(many), w.rosterFp(many.slice(0, 51)), 'the full read and the LIMIT 51 read agree');
});

test('desk-watchlist: listsFromTable reads with the service key, NO browser UA, and tells an empty roster from a failure', async () => {
  const env = DB_ENV;
  let s = stubFetch([[() => true, () => json([{ id: 1, title: 'A', symbols: ['aapl'], pos: 0, updated_at: 'u' }])]]);
  let w = wl({ env, fetch: s.fetch });
  assert.deepEqual(plain(await w.listsFromTable()), { lists: [{ title: 'A', symbols: ['AAPL'] }], fp: '1|1:0:u' });
  assert.match(s.calls[0].url, /\/rest\/v1\/desk_watchlists\?select=id,title,symbols,pos,updated_at&order=pos\.asc,id\.asc$/);
  assert.equal(hasUserAgent(s.calls[0].init), false);
  assert.equal(s.calls[0].init.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);

  w = wl({ env, fetch: stubFetch([[() => true, () => json([])]]).fetch });
  assert.deepEqual(plain(await w.listsFromTable()), { lists: [], fp: '0|' }, 'a deliberately empty roster is a SUCCESS');

  for (const f of [async () => json({}, 401), async () => json({ rows: [] }), async () => { throw new Error('x'); }]) {
    w = wl({ env, fetch: f });
    assert.equal(await w.listsFromTable(), null);
    assert.ok(w.logs.length >= 1, 'a failed read is not silent');
    assert.ok(w.logs.every((l) => !l.includes(env.SUPABASE_SERVICE_ROLE_KEY)));
  }
  w = wl({ env: {}, fetch: () => assert.fail('no request without credentials') });
  assert.equal(await w.listsFromTable(), null);
});

test('desk-watchlist: listsFromConfig is the bootstrap fallback — normalised, and null when it has nothing', async () => {
  let w = wl({ fetch: stubFetch([[(u) => u.endsWith('/config/watchlists.json'), () => json({ lists: [{ title: 'Seed', symbols: ['spy'] }, { title: '', symbols: [] }] })]]).fetch });
  assert.deepEqual(plain(await w.listsFromConfig()), [{ title: 'Seed', symbols: ['SPY'] }]);
  for (const f of [async () => json({ lists: [] }), async () => json({ lists: 'x' }), async () => json({}, 404), async () => { throw new Error('x'); }]) {
    w = wl({ fetch: f });
    assert.equal(await w.listsFromConfig(), null);
  }
});

/* The handler end to end, against a stub roster and a stub Yahoo that quotes whatever it is asked. */
function wlWorld({ table, config = null, quoteFor = (s) => ({ symbol: s, regularMarketPrice: 10, regularMarketChangePercent: 1, regularMarketTime: 1_760_000_000 }) }) {
  const quoteReqs = [];
  const s = stubFetch([
    [(u) => u.includes('/rest/v1/desk_watchlists'), () => (typeof table === 'function' ? table() : json(table))],
    [(u) => u.endsWith('/config/watchlists.json'), () => (config ? json(config) : json({}, 404))],
    [(u) => u === 'https://fc.yahoo.com/', () => new Response('', { status: 404, headers: { 'set-cookie': 'A=1; path=/' } })],
    [(u) => u.includes('/v1/test/getcrumb'), () => new Response('crumb123', { status: 200 })],
    [(u) => u.includes('/v7/finance/quote'), (u) => {
      const syms = decodeURIComponent(new URL(u).searchParams.get('symbols')).split(',');
      quoteReqs.push(syms);
      return json({ quoteResponse: { result: syms.map(quoteFor).filter(Boolean) } });
    }],
    [(u) => u.includes('/v7/finance/spark'), () => json({ spark: { result: [] } })],
  ]);
  const w = wl({ env: DB_ENV, fetch: s.fetch, now: at('2026-10-14T15:00:00Z') });
  const call = async (body = {}) => {
    const res = await w.handler(new Request('https://fn.test/desk-watchlist', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  return { w, s, call, quoteReqs };
}

test('desk-watchlist: a roster past MAX_SYMBOLS (1000) is fetched up to the cap and the rest is REPORTED missing, never dropped silently', async () => {
  const syms = Array.from({ length: 1003 }, (_, i) => `S${String(i).padStart(4, '0')}`);
  const { call, quoteReqs, w } = wlWorld({ table: [{ id: 1, title: 'Big', symbols: syms, pos: 0, updated_at: 'u' }] });
  assert.equal(w.MAX_SYMBOLS, 1000);
  const { status, body } = await call({ range: '1d' });
  assert.equal(status, 200);
  assert.equal(quoteReqs.length, 20, '1000 symbols in chunks of 50');
  assert.equal(quoteReqs.flat().length, 1000);
  assert.deepEqual(body.missing, ['S1000', 'S1001', 'S1002']);
  assert.equal(body.lists[0].symbols.length, 1003, 'the complete saved list is echoed');
  assert.equal(body.lists[0].rows.length, 1000);
  assert.equal(body.source, 'table');
});

test('desk-watchlist: one fetch per UNIQUE symbol across lists; BRK.B is asked as BRK-B and answered under its roster form', async () => {
  const { call, quoteReqs } = wlWorld({
    table: [{ id: 1, title: 'A', symbols: ['AAPL', 'BRK.B', 'TYPO'], pos: 0, updated_at: 'u' }, { id: 2, title: 'B', symbols: ['AAPL', 'brk.b'], pos: 1, updated_at: 'u' }],
    quoteFor: (s) => (s === 'TYPO' ? null : { symbol: s, regularMarketPrice: 1, regularMarketChangePercent: 0, regularMarketTime: 1 }),
  });
  const { body } = await call({});
  assert.deepEqual(quoteReqs, [['AAPL', 'BRK-B', 'TYPO']]);
  assert.deepEqual(body.lists.map((l) => l.rows.map((r) => r.sym)), [['AAPL', 'BRK.B'], ['AAPL', 'BRK.B']]);
  assert.deepEqual(body.missing, ['TYPO'], 'an unknown ticker is reported');
  assert.equal(body.range, '1d', 'the range is echoed');
});

test('desk-watchlist: an empty table is the owner\'s empty roster, not a cue to resurrect the bootstrap config', async () => {
  const { call, s } = wlWorld({ table: [], config: { lists: [{ title: 'Seed', symbols: ['SPY'] }] } });
  const { status, body } = await call({});
  assert.equal(status, 200);
  assert.deepEqual([body.source, body.lists, body.missing], ['table', [], []]);
  assert.equal(s.calls.some((c) => c.url.endsWith('/config/watchlists.json')), false);
});

test('desk-watchlist: a failed table read falls back to the config; with neither it is a 502 with ok:false', async () => {
  let world = wlWorld({ table: () => json({}, 500), config: { lists: [{ title: 'Seed', symbols: ['SPY'] }] } });
  let r = await world.call({});
  assert.deepEqual([r.status, r.body.source, r.body.lists[0].title], [200, 'config', 'Seed']);
  world = wlWorld({ table: () => json({}, 500) });
  r = await world.call({});
  assert.equal(r.status, 502);
  assert.equal(r.body.ok, false);
});

// ── desk-maps ────────────────────────────────────────────────────────────────
const MAPS = ['yahooTicker', 'buildMapCuts', 'parseSpark', 'lastTradingDayIso'];
const maps = (opts) => loadEdge('desk-maps', MAPS, opts);
const quoteAll = (extra, pick = () => true) => new Map(Object.values(extra).flat().filter(pick).map(([y], i) => [y, { pct: (i % 7) - 3, last: 100 + i }]));

test('desk-maps: buildMapCuts over the committed roster — every cut, every tile, sized by weight × $1B and sorted', () => {
  const m = maps();
  const extra = MAP_FILTERS.extra;
  const cuts = plain(m.buildMapCuts(extra, quoteAll(extra)));
  assert.deepEqual(Object.keys(cuts).sort(), Object.keys(extra).sort());
  for (const [key, roster] of Object.entries(extra)) {
    const cut = cuts[key];
    assert.equal(cut.covered, roster.length, key);
    const tiles = cut.sectors.flatMap((s) => s.tiles);
    assert.deepEqual(tiles.map((t) => t.sym).sort(), roster.map((r) => r[1]).sort(), `${key}: tiles carry the TILE ticker`);
    for (const [, sym, name, group, weight] of roster) {
      const sec = cut.sectors.find((s) => s.name === group);
      const t = sec.tiles.find((x) => x.sym === sym);
      assert.equal(t.cap, (weight || 1) * 1e9, `${sym} size`);
      assert.equal(t.name, name);
    }
    for (let i = 1; i < cut.sectors.length; i++) assert.ok(cut.sectors[i - 1].cap >= cut.sectors[i].cap, `${key}: groups by size`);
    for (const s of cut.sectors) {
      assert.equal(s.cap, s.tiles.reduce((a, t) => a + t.cap, 0));
      for (let i = 1; i < s.tiles.length; i++) assert.ok(s.tiles[i - 1].cap >= s.tiles[i].cap, `${key}/${s.name}: tiles by size`);
    }
  }
});

test('desk-maps: a cut below half coverage is dropped; exactly half stands; a NaN change is not coverage', () => {
  const m = maps();
  const roster = [['A', 'A', 'a', 'G', 2], ['B', 'B', 'b', 'G'], ['C', 'C', 'c', 'H', 1], ['D', 'D', 'd', 'H', 1]];
  const q = (syms) => new Map(syms.map((s) => [s, { pct: 1, last: 1 }]));
  assert.equal(Object.keys(m.buildMapCuts({ x: roster }, q(['A']))).length, 0, '1 of 4');
  const half = plain(m.buildMapCuts({ x: roster }, q(['A', 'B'])));
  assert.equal(half.x.covered, 2, '2 of 4 stands');
  assert.equal(half.x.sectors[0].tiles.find((t) => t.sym === 'B').cap, 1e9, 'a missing weight is 1');
  const withNaN = q(['A']); withNaN.set('B', { pct: NaN, last: 1 });
  assert.equal(Object.keys(m.buildMapCuts({ x: roster }, withNaN)).length, 0);
});

test('desk-maps: lastTradingDayIso is the New York day with weekends rolled back', () => {
  const m = maps();
  const day = (iso) => { m.clock.now = at(iso); return m.lastTradingDayIso(); };
  assert.equal(day('2026-10-15T01:30:00Z'), '2026-10-14');
  assert.equal(day('2026-10-18T12:00:00Z'), '2026-10-16');
  assert.equal(m.yahooTicker(' btc-usd '), 'BTC-USD');
});

test('desk-maps: the handler answers JSON ok:false with CORS (never a bare 500) when the roster or the quotes are missing', async () => {
  const call = async (fetch) => {
    const m = maps({ fetch });
    const res = await m.handler(new Request('https://fn.test/desk-maps', { method: 'POST', body: '{}' }));
    return { status: res.status, cors: res.headers.get('access-control-allow-origin'), body: await res.json() };
  };
  let r = await call(async () => json({}, 404));
  assert.deepEqual([r.status, r.cors, r.body.ok, r.body.error], [502, '*', false, 'map roster unavailable']);
  r = await call(async (u) => (String(u).endsWith('map-filters.json') ? json(MAP_FILTERS) : json({}, 500)));
  assert.deepEqual([r.status, r.cors, r.body.ok], [502, '*', false]);
  assert.match(r.body.error, /below half coverage/);
  // The happy path: Yahoo answers every symbol it is asked for.
  r = await call(async (u) => {
    const url = String(u);
    if (url.endsWith('map-filters.json')) return json(MAP_FILTERS);
    const syms = new URL(url).searchParams.get('symbols').split(',');
    return json(Object.fromEntries(syms.map((s) => [s, { close: [100, 101] }])));
  });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.cuts).sort(), Object.keys(MAP_FILTERS.extra).sort());
  assert.match(r.body.asOf, /^\d{4}-\d{2}-\d{2}$/);
  const m2 = maps();
  const res = await m2.handler(new Request('https://fn.test/desk-maps', { method: 'DELETE' }));
  assert.equal(res.status, 405);
});
