import test from 'node:test';
import assert from 'node:assert/strict';
import { yahooSymbol, parseYahooChart } from '../lib/quotes.js';

test('yahooSymbol maps Stooq notation to Yahoo tickers', () => {
  assert.equal(yahooSymbol('^spx'), '^GSPC');
  assert.equal(yahooSymbol('^ndx'), '^NDX');
  assert.equal(yahooSymbol('^dji'), '^DJI');
  assert.equal(yahooSymbol('^vix'), '^VIX');
  assert.equal(yahooSymbol('iwm.us'), 'IWM');
  assert.equal(yahooSymbol('nvda.us'), 'NVDA');
});

test('parseYahooChart maps timestamps to NY dates, drops null closes', () => {
  const json = {
    chart: {
      result: [{
        // 2026-07-07 / 07-08 16:00 ET closes (20:00 UTC)
        timestamp: [1783533600, 1783620000, 1783706400],
        indicators: { quote: [{ close: [6284.5, null, 6318.42] }] },
      }],
    },
  };
  const rows = parseYahooChart(json);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), 'ISO dates: ' + JSON.stringify(rows));
  assert.equal(rows.at(-1).close, 6318.42);
  assert.ok(rows[0].date < rows[1].date, 'ascending');
});

test('parseYahooChart tolerates error payloads', () => {
  assert.deepEqual(parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } }), []);
  assert.deepEqual(parseYahooChart(null), []);
});
