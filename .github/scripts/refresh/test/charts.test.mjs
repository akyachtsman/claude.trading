import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStooqOHLC, parseYahooChartOHLC } from '../lib/ohlc.js';
import { packSeries, DEFAULT_WATCHLIST } from '../fetch-charts.js';

const STOOQ_CSV = [
  'Date,Open,High,Low,Close,Volume',
  '2026-07-09,619.10,624.40,617.80,622.30,51234400',
  '2026-07-10,622.90,631.20,621.50,630.40,60122100',
  'garbage,line,without,numbers',
  '2026-07-08,not,a,number,row,0',
  '2026-07-07,615.00,619.90,613.20,618.75,',
].join('\n');

test('parseStooqOHLC keeps full OHLCV, drops junk, sorts ascending', () => {
  const rows = parseStooqOHLC(STOOQ_CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.date), ['2026-07-07', '2026-07-09', '2026-07-10']);
  assert.deepEqual(rows[1], { date: '2026-07-09', o: 619.10, h: 624.40, l: 617.80, c: 622.30, v: 51234400 });
  assert.equal(rows[0].v, 0);   /* missing volume tolerated as 0 */
});

test('parseStooqOHLC tolerates a "No data" body', () => {
  assert.deepEqual(parseStooqOHLC('No data'), []);
});

test('parseYahooChartOHLC maps quote arrays and skips null bars', () => {
  const json = {
    chart: { result: [{
      timestamp: [1783954800, 1784041200],  /* 2026-07-13, 2026-07-14 (NY) */
      indicators: { quote: [{
        open: [619.1, null], high: [624.4, 626.0], low: [617.8, 620.1],
        close: [622.3, 625.2], volume: [51234400, 48000000],
      }] },
    }] },
  };
  const rows = parseYahooChartOHLC(json);
  assert.equal(rows.length, 1);   /* second bar has a null open → skipped */
  assert.equal(rows[0].c, 622.3);
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseYahooChartOHLC tolerates error payloads', () => {
  assert.deepEqual(parseYahooChartOHLC({ chart: { result: null, error: { code: 'Not Found' } } }), []);
  assert.deepEqual(parseYahooChartOHLC(null), []);
});

test('packSeries emits compact parallel arrays with 2dp prices', () => {
  const rows = parseStooqOHLC(STOOQ_CSV);
  const s = packSeries(rows);
  assert.deepEqual(Object.keys(s), ['t', 'o', 'h', 'l', 'c', 'v']);
  assert.equal(s.t.length, 3);
  assert.equal(s.c[2], 630.40);
  assert.equal(s.v[0], 0);
});

test('default watchlist is a sane, deduped ticker roster', () => {
  assert.ok(DEFAULT_WATCHLIST.length >= 20);
  assert.equal(new Set(DEFAULT_WATCHLIST).size, DEFAULT_WATCHLIST.length);
  assert.ok(DEFAULT_WATCHLIST.every(t => /^[A-Z]{2,5}$/.test(t)));
});
