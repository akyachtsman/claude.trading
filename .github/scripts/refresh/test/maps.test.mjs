import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMapCuts } from '../fetch-maps.js';

const EXTRA = {
  crypto: [
    ['BTC-USD', 'BTC', 'Bitcoin', 'Majors'],
    ['ETH-USD', 'ETH', 'Ethereum', 'Majors'],
    ['SOL-USD', 'SOL', 'Solana', 'Alt layer-1s'],
    ['DOGE-USD', 'DOGE', 'Dogecoin', 'Payments'],
  ],
  futures: [
    ['ES=F', 'ES', 'S&P 500 E-mini', 'Equity index', 10],
    ['GC=F', 'GC', 'Gold', 'Metals', 6],
    ['CL=F', 'CL', 'WTI Crude', 'Energy', 5],
  ],
};

const q = (pct, cap, last) => ({ pct, cap, last });

test('crypto tiles size by real market cap; groups sort by cap', () => {
  const quotes = new Map([
    ['BTC-USD', q(1.2, 2.1e12, 108000)],
    ['ETH-USD', q(-0.8, 4.4e11, 3600)],
    ['SOL-USD', q(3.1, 9e10, 190)],
    ['DOGE-USD', q(-2.0, 2e10, 0.14)],
  ]);
  const cuts = buildMapCuts(EXTRA, quotes);
  assert.equal(cuts.crypto.covered, 4);
  assert.equal(cuts.crypto.sectors[0].name, 'Majors');           // biggest group first
  assert.equal(cuts.crypto.sectors[0].tiles[0].sym, 'BTC');      // cap-sorted tiles
  assert.equal(cuts.crypto.sectors[0].tiles[0].cap, 2.1e12);     // real cap, not weight
});

test('futures tiles use hand weights (× $1B) since Yahoo has no cap', () => {
  const quotes = new Map([
    ['ES=F', q(0.4, null, 6100)],
    ['GC=F', q(-0.2, null, 3350)],
    ['CL=F', q(1.7, null, 68)],
  ]);
  const cuts = buildMapCuts(EXTRA, quotes);
  assert.equal(cuts.futures.sectors[0].tiles[0].cap, 10e9);
  assert.equal(cuts.futures.sectors[0].name, 'Equity index');
});

test('a cut below half coverage is dropped; others survive', () => {
  const quotes = new Map([
    ['BTC-USD', q(1.2, 2.1e12, 108000)],                          // 1/4 crypto — dropped
    ['ES=F', q(0.4, null, 6100)],
    ['GC=F', q(-0.2, null, 3350)],                                // 2/3 futures — kept
  ]);
  const cuts = buildMapCuts(EXTRA, quotes);
  assert.equal(cuts.crypto, undefined);
  assert.ok(cuts.futures);
});

test('missing/NaN quotes are skipped without crashing', () => {
  const quotes = new Map([['ES=F', { pct: NaN, cap: null, last: null }]]);
  const cuts = buildMapCuts(EXTRA, quotes);
  assert.deepEqual(Object.keys(cuts), []);
});

test('spark-shaped fallback (pct only) sizes crypto by config weight', () => {
  const EXTRA_W = {
    crypto: [
      ['BTC-USD', 'BTC', 'Bitcoin', 'Majors', 2100],
      ['ETH-USD', 'ETH', 'Ethereum', 'Majors', 450],
    ],
  };
  const quotes = new Map([
    ['BTC-USD', { pct: 1.2, cap: null, last: 108000 }],
    ['ETH-USD', { pct: -0.8, cap: null, last: undefined }],
  ]);
  const cuts = buildMapCuts(EXTRA_W, quotes);
  assert.equal(cuts.crypto.sectors[0].tiles[0].cap, 2100e9);   // weight, not cap
  assert.equal(cuts.crypto.sectors[0].tiles[1].cap, 450e9);
});
