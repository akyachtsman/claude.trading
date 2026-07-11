import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseConstituents, buildHeatmap } from '../fetch-heatmap.js';
import { yahooTicker, parseSpark } from '../lib/yahoo-batch.js';

const CSV = `Symbol,Security,GICS Sector,GICS Sub-Industry
AAPL,Apple Inc.,Information Technology,Technology Hardware
AMZN,"Amazon.com, Inc.",Consumer Discretionary,Broadline Retail
BRK.B,Berkshire Hathaway,Financials,Multi-Sector Holdings
XOM,Exxon Mobil,Energy,Integrated Oil
`;

test('parseCsv survives quoted fields with commas', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows[2][1], 'Amazon.com, Inc.');
  assert.equal(rows.length, 5);
});

test('parseConstituents maps symbol/name/sector', () => {
  const c = parseConstituents(CSV);
  assert.equal(c.length, 4);
  assert.deepEqual(c[2], { sym: 'BRK.B', name: 'Berkshire Hathaway', sector: 'Financials' });
});

test('yahooTicker converts dots to dashes', () => {
  assert.equal(yahooTicker('BRK.B'), 'BRK-B');
  assert.equal(yahooTicker('aapl'), 'AAPL');
});

test('buildHeatmap groups by sector, sorts by cap, merges prev caps', () => {
  const constituents = parseConstituents(CSV);
  const quotes = new Map([
    ['AAPL', { pct: 1.2, cap: 3200e9 }],
    ['AMZN', { pct: -0.6, cap: 2100e9 }],
    ['BRK-B', { pct: 0.1, cap: null }],   // cap missing → prev caps
    ['XOM', { pct: 0.4, cap: 520e9 }],
  ]);
  const prevCaps = new Map([['BRK.B', 950e9]]);
  const { sectors, covered } = buildHeatmap(constituents, quotes, prevCaps);
  assert.equal(covered, 4);
  assert.equal(sectors[0].name, 'Information Technology'); // largest cap first
  const fin = sectors.find(s => s.name === 'Financials');
  assert.equal(fin.tiles[0].cap, 950e9, 'prev cap carried forward');
});

test('buildHeatmap drops symbols with no cap anywhere', () => {
  const { covered } = buildHeatmap(
    parseConstituents(CSV),
    new Map([['AAPL', { pct: 1.0, cap: null }]]),
    new Map()
  );
  assert.equal(covered, 0);
});

test('parseSpark computes day % from last two closes', () => {
  const m = parseSpark({ AAPL: { close: [200, 202, null, 204.02] }, MSFT: { close: [500] } });
  assert.equal(m.get('AAPL').pct, 1.0); // 204.02/202 - 1
  assert.equal(m.has('MSFT'), false, 'single close is unusable');
});
