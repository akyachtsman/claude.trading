/* Unit tests for tools/signal-alert.mjs, the weekday 10 AM trading-signal push (owner 2026-11-17: moved here from INVEST,
   built on the dashboard's own rules). Run: `node --test tools/unit/`.

   The rules themselves are layers.test.mjs's: here the point is that the push reads THEM (layersSignals over the same
   bars the Trading signals panel uses) and words one push exactly as INVEST's alert spec says. Tickers are invented. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from './lib.mjs';
import {
  universe, yahooSymbol, parseChart, parseConstituents, nyNow, isLive, dayLabel, weekSignals, signalLines, buildPush,
  loadRules, MAX_MSG,
} from '../signal-alert.mjs';

const sig = (sym, side, rule, d, px, k = 50) => ({ sym, side, rule, d, px, k });

test('universe: upper-cases, dedupes, drops indices and anything that is not a ticker', () => {
  assert.deepEqual(universe(['aaa', ' BBB ', 'AAA', '^VIX', '', null, 'C.D', 'bad ticker', '<b>', 'ABCDEFGHIJK']), ['AAA', 'BBB', 'C.D']);
});

test('yahooSymbol: a class share uses a dash', () => {
  assert.equal(yahooSymbol('BRK.B'), 'BRK-B');
  assert.equal(yahooSymbol('AAA'), 'AAA');
});

test('parseConstituents: reads the Symbol column, refuses a short list', () => {
  const rows = Array.from({ length: 450 }, (_, i) => `S${i},Name ${i},Tech`);
  assert.equal(parseConstituents('Symbol,Security,GICS Sector\n' + rows.join('\n')).length, 450);
  assert.throws(() => parseConstituents('Symbol,Security\nAAA,x\n'), /only 1/);
  assert.throws(() => parseConstituents('Ticker,Security\nAAA,x\n'), /no Symbol/);
});

test('parseChart: dates each bar on the exchange clock, skips a missing or zero price', () => {
  const body = { chart: { result: [{
    meta: { gmtoffset: -18000 },
    timestamp: [1763389800, 1763476200, 1763562600, 1763649000],          // 14:30Z = 09:30 ET, Nov 17-20 2025
    indicators: { quote: [{ open: [10, 11, null, 13], high: [12, 12, 12, 14], low: [9, 10, 10, 0], close: [11, 11.5, 11, 13.5] }] },
  }] } };
  const b = parseChart(body);
  assert.deepEqual([...b.t], ['2025-11-17', '2025-11-18']);
  assert.deepEqual([...b.c], [11, 11.5]);
  assert.throws(() => parseChart({ chart: { result: null } }), /no chart/);
});

test('isLive: only today, on a weekday, between the 9:30 and 16:00 ET bell', () => {
  const at = iso => new Date(iso);
  assert.equal(nyNow(at('2026-11-17T17:57:00Z')).day, '2026-11-17');
  assert.equal(isLive('2026-11-17', at('2026-11-17T17:57:00Z')), true, '9:57 AM PT');
  assert.equal(isLive('2026-11-17', at('2026-11-17T14:29:00Z')), false, '9:29 ET');
  assert.equal(isLive('2026-11-17', at('2026-11-17T14:30:00Z')), true, '9:30 ET');
  assert.equal(isLive('2026-11-17', at('2026-11-17T21:00:00Z')), false, '16:00 ET');
  assert.equal(isLive('2026-11-16', at('2026-11-17T17:57:00Z')), false, 'yesterday');
  assert.equal(isLive('2026-11-21', at('2026-11-21T17:57:00Z')), false, 'Saturday');
});

test('dayLabel: Tue 11/17', () => {
  assert.equal(dayLabel('2026-11-17'), 'Tue 11/17');
  assert.equal(dayLabel('2026-11-09'), 'Mon 11/9');
  assert.equal(dayLabel('junk'), 'junk');
});

test('weekSignals: the dashboard\'s own layersSignals over the demo bars, and nothing after the as-of day', () => {
  const rules = loadRules();
  const d = loadData({ now: Date.parse('2026-11-13T22:00:00Z'), also: ['scripts/layers.js'] });
  const input = d.buildDemoLayersInput(new Date('2026-11-13T22:00:00Z'));
  let total = 0, checked = 0;
  for (const s of input.stocks) {
    const b = s.bars, wk = d.stochSeries(b, d.WSTOCH);
    /* every session as an as-of day: a week's signals are exactly the panel's own, with its close and %K */
    for (let i = b.t.length - 60; i < b.t.length; i++) {
      const asOf = b.t[i];
      const got = weekSignals(rules, s.sym, b, asOf);
      const cut = { t: b.t.slice(0, i + 1), o: b.o.slice(0, i + 1), h: b.h.slice(0, i + 1), l: b.l.slice(0, i + 1), c: b.c.slice(0, i + 1) };
      const want = d.layersSignals(cut, d.stochSeries(cut, d.WSTOCH), asOf);
      assert.equal(got.length, want.length, s.sym + ' ' + asOf);
      want.forEach(([name, day], j) => {
        assert.equal(got[j].d, day);
        assert.equal(got[j].side, / BUY$/.test(name) ? 'LONG' : 'SHORT');
        assert.equal(got[j].rule, Number(name.charAt(5)));
        assert.ok(got[j].d <= asOf, 'never a later session');
        const at = b.t.indexOf(day);
        assert.equal(got[j].px, b.c[at]);
        assert.ok(Math.abs(got[j].k - wk.k[at]) < 1e-9);
      });
      total += got.length; checked++;
    }
  }
  assert.ok(checked > 1000 && total > 20, `the demo exercises the rules (${total} signals over ${checked} as-of days)`);
});

test('buildPush: one title and one message, the week\'s list newest first, numbered across both sides', () => {
  const p = buildPush({
    weekFrom: '2026-11-16', live: true, scanned: 600, failed: 3,
    signals: [
      sig('AAA', 'LONG', 3, '2026-11-16', 10.5), sig('AAA', 'LONG', 3, '2026-11-17', 11),   // fired twice: listed once, first day
      sig('BBB', 'LONG', 2, '2026-11-17', 20), sig('BBB', 'LONG', 3, '2026-11-17', 20),
      sig('CCC', 'SHORT', 3, '2026-11-17', 30.125),
      sig('DDD', 'SHORT', 2, '2026-11-16', 40), sig('DDD', 'SHORT', 3, '2026-11-17', 41),
    ],
  });
  assert.equal(p.title, '📈📉 Trading this week: 2 LONG, 2 SHORT');
  assert.equal(p.msg, [
    "Since Mon 11/16, newest first. Today's are live at 10 AM, not confirmed at close; earlier days at their close.",
    '', '📈 LONG',
    '1. <b>BBB</b> · $20.00 · rule 2+3 · Tue 11/17',
    '2. <b>AAA</b> · $10.50 · rule 3 · Mon 11/16',
    '', '📉 SHORT',
    '3. <b>CCC</b> · $30.13 · rule 3 · Tue 11/17',
    '4. <b>DDD</b> · $40.00 · rule 2 Mon 11/16, rule 3 Tue 11/17',
  ].join('\n'));
});

test('buildPush: one side only, past sessions only', () => {
  const p = buildPush({ weekFrom: '2026-11-16', live: false, scanned: 10, failed: 0, signals: [sig('EEE', 'SHORT', 3, '2026-11-16', 5)] });
  assert.equal(p.title, '📉 Trading this week: 1 SHORT');
  assert.match(p.msg, /^Since Mon 11\/16, newest first\. Each at its day's close\.\n/);
});

test('buildPush: a quiet day sends nothing; an incomplete scan says so, alone or after the list', () => {
  assert.deepEqual(buildPush({ weekFrom: '2026-11-16', live: true, scanned: 600, failed: 30, signals: [] }), { title: '', msg: '' }, '30 of 600 is 5%: complete');
  const inc = buildPush({ weekFrom: '2026-11-16', live: true, scanned: 600, failed: 31, signals: [] });
  assert.equal(inc.title, '⚠️ Trading scan incomplete');
  assert.equal(inc.msg, '31 of 600 tickers could not be fetched today, so signals may be missing.');
  const wl = buildPush({ weekFrom: '2026-11-16', live: true, scanned: 500, failed: 0, watchlistFailed: true, signals: [sig('FFF', 'LONG', 1, '2026-11-17', 7)] });
  assert.match(wl.msg, /\n\n⚠️ The watchlist could not be read, so its stocks were not checked\.$/);
});

test('buildPush: over 1,000 characters the oldest of the longer side goes first, and the rest is counted', () => {
  const s = [];
  for (let i = 0; i < 40; i++) s.push(sig('L' + String(i).padStart(3, '0'), 'LONG', 3, '2026-11-' + String(16 + (i % 4)).padStart(2, '0'), 100 + i));
  for (let i = 0; i < 10; i++) s.push(sig('S' + String(i).padStart(3, '0'), 'SHORT', 3, '2026-11-19', 50 + i));
  const p = buildPush({ weekFrom: '2026-11-16', live: true, scanned: 600, failed: 0, signals: s });
  assert.equal(p.title, '📈📉 Trading this week: 40 LONG, 10 SHORT');
  assert.ok(p.msg.length <= MAX_MSG, String(p.msg.length));
  const shown = (p.msg.match(/^\d+\. /gm) || []).length;
  assert.match(p.msg, new RegExp(`\\n\\n\\+ ${50 - shown} more in code\\.TRADE$`));
  const [longs, shorts] = p.msg.split('📉 SHORT');
  const nL = (longs.match(/^\d+\. /gm) || []).length, nS = (shorts.match(/^\d+\. /gm) || []).length;
  assert.ok(Math.abs(nL - nS) <= 1, `trimmed from whichever side has more left, so the two end level (${nL} / ${nS})`);
  const longRows = longs.split('\n').filter(l => /^\d+\. /.test(l)).join('\n');
  assert.ok(/Thu 11\/19/.test(longRows) && !/Mon 11\/16/.test(longRows), 'the newest LONGs are kept, Monday\'s (oldest) go first');
  assert.match(buildPush({ weekFrom: '2026-11-16', live: true, scanned: 1, failed: 0, signals: s, moreIn: 'the run thread' }).msg, /more in the run thread$/);
});

test('signalLines: the record, oldest day first, today marked live', () => {
  const lines = signalLines([sig('BBB', 'SHORT', 3, '2026-11-17', 20, 79.6), sig('AAA', 'LONG', 1, '2026-11-16', 10, 22.2)], '2026-11-17');
  assert.deepEqual(lines, [
    'SIGNAL LONG rule1 AAA close=10.00 stoch13w=22 on=2026-11-16',
    'SIGNAL SHORT rule3 BBB [live, not confirmed at close] price=20.00 stoch13w=80 on=2026-11-17',
  ]);
});
