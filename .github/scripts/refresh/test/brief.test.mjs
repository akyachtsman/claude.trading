import test from 'node:test';
import assert from 'node:assert/strict';
import { groundingNumbers, validateGrounding, buildPrompt } from '../generate-brief.js';

const SNAPSHOTS = [
  { account_key: 1, as_of: '2026-07-08', nav: 412386.54, day_pnl: 3241.12, total_unrl: 58212.40, cash: 31200, positions: [{ sym: 'NVDA', mkt: 58282.80, unrl: 21140.20, dayPct: 1.84 }] },
  { account_key: 2, as_of: '2026-07-08', nav: 268930.77, day_pnl: 1102.36, total_unrl: 41008.19, cash: 12400, positions: [] },
];
const MARKET = { tiles: [{ name: 'S&P 500', last: '6,318.42', chg: 0.54 }] };

test('groundingNumbers includes per-account, cross-account sums and market lasts', () => {
  const nums = groundingNumbers(SNAPSHOTS, MARKET);
  assert.ok(nums.includes(412386.54));
  assert.ok(nums.includes(21140.20));
  assert.ok(nums.some(n => Math.abs(n - 681317.31) < 0.01), 'total nav sum present');
  assert.ok(nums.includes(6318.42), 'market last parsed from formatted string');
});

test('validateGrounding accepts cited figures incl. rounded $K forms', () => {
  const allowed = groundingNumbers(SNAPSHOTS, MARKET);
  const ok = validateGrounding({
    state: 'Net liquidation is $681,317 across two accounts, up $4,343.48 on the day.',
    levels: ['NVDA carries $21,140.20 of open P&L.', 'Cash is $43.6K combined.'],
    scenarios: ['S&P 500 at 6,318.42 holds the recent range.'],
  }, allowed);
  assert.equal(ok.ok, true, 'bad: ' + ok.bad.join(','));
});

test('validateGrounding rejects invented dollar figures', () => {
  const allowed = groundingNumbers(SNAPSHOTS, MARKET);
  const out = validateGrounding({
    state: 'The portfolio gained $999,999 today.',
    levels: [], scenarios: [],
  }, allowed);
  assert.equal(out.ok, false);
  assert.deepEqual(out.bad, [999999]);
});

test('buildPrompt embeds grounding JSON and the tool instruction', () => {
  const p = buildPrompt(SNAPSHOTS, MARKET, { items: [{ h: 'Headline one' }] }, '2026-07-08');
  assert.match(p, /<grounding>/);
  assert.match(p, /"nav": 412386.54/);
  assert.match(p, /Headline one/);
  assert.match(p, /record_brief/);
  assert.match(p, /never give advice/);
});
