import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStooqDaily } from '../lib/stooq.js';
import { tileFrom, parseFred, tenYearTile } from '../fetch-market.js';

const STOOQ_CSV = `Date,Open,High,Low,Close,Volume
2026-07-06,6280.00,6300.00,6270.00,6284.50,123456
2026-07-07,6284.50,6320.00,6280.00,6301.10,123456
2026-07-08,6301.10,6330.00,6295.00,6318.42,123456
`;

test('parseStooqDaily extracts dated closes, drops junk', () => {
  const rows = parseStooqDaily(STOOQ_CSV + 'No data\nbad,row\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.at(-1), { date: '2026-07-08', close: 6318.42 });
});

test('tileFrom formats last, 2dp day %, spark and asOf', () => {
  const t = tileFrom('S&P 500', parseStooqDaily(STOOQ_CSV));
  assert.equal(t.last, '6,318.42');
  assert.equal(t.chg, 0.27); // 6318.42/6301.10 - 1 = +0.27%
  assert.equal(t.asOf, '2026-07-08');
  assert.equal(t.spark.length, 3);
});

const FRED_CSV = `observation_date,DGS10
2026-07-02,4.28
2026-07-03,.
2026-07-06,4.26
2026-07-07,4.26
2026-07-08,4.31
`;

test('parseFred drops "." holiday rows', () => {
  const rows = parseFred(FRED_CSV);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => Number.isFinite(r.value)));
});

test('tenYearTile stamps the SERIES date and point change', () => {
  const t = tenYearTile(parseFred(FRED_CSV));
  assert.equal(t.last, '4.31%');
  assert.equal(t.chg, 0.05);
  assert.equal(t.asOf, '2026-07-08'); // series date, not run date
});
