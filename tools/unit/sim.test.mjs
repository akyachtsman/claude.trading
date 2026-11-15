/* Unit tests for the simulated trades' pure helpers (scripts/sim.js, owner 2026-11-15: "a non-funded testing of our
   strategies, both options and stock purchases"). Every expected number is worked out by hand here. Run:
   `node --test tools/unit/`. sim.js is loaded after data.js and layers.js, the page's own order. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from './lib.mjs';

const load = () => loadData({ now: Date.parse('2026-11-13T22:00:00Z'), also: ['scripts/layers.js', 'scripts/sim.js'] });
const J_ = (x) => JSON.parse(JSON.stringify(x));

test('a stock and an OCC option are read; an impossible contract or junk is not', () => {
  const d = load();
  assert.deepEqual(J_(d.simParseSym(' msft ')), { kind: 'stock', sym: 'MSFT', under: 'MSFT', exp: null, right: null, strike: null, mult: 1 });
  assert.deepEqual(J_(d.simParseSym('AMD   261218C00195000')),
    { kind: 'option', sym: 'AMD261218C00195000', under: 'AMD', exp: '2026-12-18', right: 'C', strike: 195, mult: 100 });
  assert.equal(d.simParseSym('BRK.B270115P00412500').strike, 412.5);
  assert.equal(d.simParseSym('AMD261318C00195000'), null);   /* month 13 */
  assert.equal(d.simParseSym('AMD260231C00195000'), null);   /* Feb 31 */
  assert.equal(d.simParseSym('AMD261218C00000000'), null);   /* strike 0 */
  assert.equal(d.simParseSym(''), null);
  assert.equal(d.simParseSym('!!'), null);
});

test('the OCC symbol is built from its parts, and the contract line reads as IBKR prints it', () => {
  const d = load();
  assert.equal(d.simOcc('amd', '2026-12-18', 'c', 195), 'AMD261218C00195000');
  assert.equal(d.simOcc('SPY', '2027-01-15', 'P', 412.5), 'SPY270115P00412500');
  assert.equal(d.simOcc('SPY', '2027-02-30', 'P', 400), null);
  assert.equal(d.simOcc('SPY', '2027-01-15', 'X', 400), null);
  assert.equal(d.simOcc('SPY', '2027-01-15', 'P', 0), null);
  assert.equal(d.simContractLabel(d.simParseSym('AMD261218C00195000')), "Dec 18 '26 195 Call");
  assert.equal(d.simContractLabel(d.simParseSym('SPY270115P00412500')), "Jan 15 '27 412.5 Put");
  assert.equal(d.simContractLabel(d.simParseSym('MSFT')), '');
});

test('period starts are New York calendar dates: Monday, the 1st, January 1st', () => {
  const d = load();
  assert.deepEqual(J_(d.simPeriodStarts('2026-11-13')), { day: '2026-11-13', week: '2026-11-09', month: '2026-11-01', year: '2026-01-01' });
  assert.equal(d.simPeriodStarts('2026-11-09').week, '2026-11-09');   /* a Monday is its own week */
  assert.equal(d.simPeriodStarts('2026-11-15').week, '2026-11-09');   /* Sunday belongs to the week before */
});

const series = { t: ['2025-12-31', '2026-10-30', '2026-11-06', '2026-11-11', '2026-11-12'], c: [80, 90, 95, 98, 99] };

test('a BUY of 100 shares: every period by hand', () => {
  const d = load();
  /* opened 2026-10-15 at 85; price now 100, previous close 99 */
  const n = d.simTradeNumbers({ side: 'buy', qty: 100, mult: 1, entry: 85, openedDay: '2026-10-15' }, { price: 100, prev: 99, series }, '2026-11-13');
  assert.equal(n.cost, 8500); assert.equal(n.value, 10000);
  assert.equal(n.periods.day.pnl, 100);             /* 100 × (100 − 99) */
  assert.equal(n.periods.week.pnl, 500);            /* base = close before Mon Nov 9 = 95 */
  assert.equal(n.periods.month.pnl, 1000);          /* base = close before Nov 1 = 90 */
  assert.equal(n.periods.year.pnl, 1500);           /* opened after Jan 1: base = entry 85 */
  assert.equal(n.periods.all.pnl, 1500);
  assert.ok(Math.abs(n.pct - 1500 / 8500 * 100) < 1e-9);
  assert.ok(Math.abs(n.periods.week.pct - 5 / 95 * 100) < 1e-9);
});

test('a SELL gains when the price falls, and reads positive', () => {
  const d = load();
  const n = d.simTradeNumbers({ side: 'sell', qty: 10, mult: 1, entry: 110, openedDay: '2026-11-10' }, { price: 100, prev: 99, series }, '2026-11-13');
  assert.equal(n.pnl, 100);                         /* −1 × 10 × (100 − 110) */
  assert.ok(Math.abs(n.pct - 10 / 110 * 100) < 1e-9);
  assert.equal(n.periods.day.pnl, -10);             /* the price rose 1 today: a loss for a SELL */
  assert.equal(n.periods.week.pnl, 100);            /* opened inside the week: base = entry */
});

test('an option counts 100 shares a contract', () => {
  const d = load();
  const n = d.simTradeNumbers({ side: 'buy', qty: 2, mult: 100, entry: 4.5, openedDay: '2026-11-12' }, { price: 5.25, prev: 5, series: null }, '2026-11-13');
  assert.equal(n.cost, 900);
  assert.ok(Math.abs(n.pnl - 150) < 1e-9);          /* 2 × 100 × 0.75 */
  assert.ok(Math.abs(n.periods.day.pnl - 50) < 1e-9);
});

test('a closed trade ends at its exit, and takes no part in a period that began after it closed', () => {
  const d = load();
  const n = d.simTradeNumbers({ side: 'buy', qty: 10, mult: 1, entry: 90, openedDay: '2026-10-20', closedDay: '2026-11-03', exit: 96 },
    { price: 100, prev: 99, series }, '2026-11-13');
  assert.equal(n.pnl, 60);
  assert.equal(n.periods.day, null);
  assert.equal(n.periods.week, null);
  assert.equal(n.periods.month.pnl, 60);            /* base = close before Nov 1 = 90, end = exit 96 */
});

test('unknown inputs give null, never 0, and the totals say what they left out', () => {
  const d = load();
  const a = d.simTradeNumbers({ side: 'buy', qty: 10, mult: 1, entry: 50, openedDay: '2026-11-12' }, { price: NaN, prev: null, series: null }, '2026-11-13');
  assert.equal(a.pnl, null); assert.equal(a.value, null); assert.equal(a.periods.day.pnl, null);
  const b = d.simTradeNumbers({ side: 'buy', qty: 10, mult: 1, entry: 50, openedDay: '2026-11-12' }, { price: 55, prev: 54, series: null }, '2026-11-13');
  const c = d.simTradeNumbers({ side: 'sell', qty: 10, mult: 1, entry: 40, openedDay: '2026-11-12' }, { price: 38, prev: 39, series: null }, '2026-11-13');
  const t = d.simTotals([a, b, c], 'all');
  assert.equal(t.n, 2); assert.equal(t.missing, 1);
  assert.equal(t.pnl, 70);                          /* 50 + 20 */
  assert.ok(Math.abs(t.pct - 70 / 900 * 100) < 1e-9);
  assert.deepEqual(J_(d.simTotals([a], 'all')), { pnl: null, pct: null, n: 0, missing: 1 });
});

test('the close on or before a day, and strictly before it', () => {
  const d = load();
  assert.equal(d.simCloseOn(series, '2026-11-09'), 95);
  assert.equal(d.simCloseOn(series, '2026-11-11'), 98);
  assert.equal(d.simCloseOn(series, '2026-11-11', true), 95);
  assert.ok(Number.isNaN(d.simCloseOn(series, '2025-01-01')));
  assert.ok(Number.isNaN(d.simCloseOn(null, '2026-11-11')));
});
