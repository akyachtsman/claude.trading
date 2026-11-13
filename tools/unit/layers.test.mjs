/* Unit tests for the Layers Heat Map scorer (scripts/layers.js): one worked example per letter A to K,
   the verdict lines and the hold-back, the three rule signals (rule 3 is the PLAIN %K cross, INVEST
   2026-11-13 9:10 AM PT), the exclusions, the demo's coverage and the panel's own colour pairs.
   Run: `node --test tools/unit/`.

   The rules are specs/layers-heat-map/LAYERS_HEAT_MAP.md; every expected number here is worked out
   from that file by hand, never by calling another layers.js helper. layers.js is loaded after
   data.js by `loadData({ also: ['scripts/layers.js'] })`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadData, ROOT } from './lib.mjs';

const load = (now = Date.parse('2026-11-13T22:00:00Z')) => loadData({ now, also: ['scripts/layers.js'] });
const ramp = (from, to, n) => Array.from({ length: n }, (_, i) => from + (to - from) * i / (n - 1));
const pts = (letter, idx) => [letter.comps[idx][2], letter.comps[idx][3]];
const LS = (letter) => [letter.L, letter.S];
const J_ = (x) => JSON.parse(JSON.stringify(x));   /* arrays made inside the page context have its own Array prototype */

// ── the table itself ─────────────────────────────────────────────────────────
test('the letter maxima add up to 100 a side, and the table is frozen', () => {
  const d = load();
  const R = d.LAYERS_RULES;
  assert.equal(R.version, 'v20');
  assert.equal(Object.values(R.max).reduce((a, b) => a + b, 0), 100);
  assert.ok(Object.isFrozen(R));
  assert.deepEqual([...d.LAYERS_LETTERS].join(''), 'ABCDEFGHIJK');
  assert.equal(d.LAYERS_SECTORS.length, 11);
});

// ── verdicts and the hold-back ───────────────────────────────────────────────
test('verdict lines: 25 Strong, 10 Leans, inside ±10 no edge', () => {
  const d = load();
  const cases = [[40, 'Strong BUY'], [25, 'Strong BUY'], [24, 'Leans BUY'], [10, 'Leans BUY'], [9, 'No edge today'], [0, 'No edge today'],
    [-9, 'No edge today'], [-10, 'Leans SELL'], [-24, 'Leans SELL'], [-25, 'Strong SELL'], [-60, 'Strong SELL']];
  for (const [lean, word] of cases) assert.equal(d.layersVerdict(lean), word, String(lean));
  assert.deepEqual([25, 24, 10, 9, -9, -10, -24, -25].map(x => d.layersBand(x)), [2, 1, 1, 0, 0, -1, -1, -2]);
});

test('hold-back: a daily peak caps a Strong BUY at Leans, a trough a Strong SELL; the lean never changes otherwise', () => {
  const d = load();
  assert.equal(d.layersHeld(40, 'peak'), 24);
  assert.equal(d.layersHeld(20, 'peak'), 20, 'a Leans BUY is not touched');
  assert.equal(d.layersHeld(-40, 'peak'), -40, 'a peak never holds back a SELL');
  assert.equal(d.layersHeld(-40, 'trough'), -24);
  assert.equal(d.layersHeld(40, 'trough'), 40);
  assert.equal(d.layersHeld(40, null), 40);
});

// ── A to D ───────────────────────────────────────────────────────────────────
function outerInput(over = {}) {
  return {
    market: {
      brent: { c: ramp(80, 70, 22) }, dxy: { c: ramp(100, 102, 22) }, acwx: { c: ramp(50, 60, 250) },
      tnx: { c: ramp(4.5, 4.2, 22) }, vix: { c: ramp(18, 23, 22) }, ...(over.market || {}),
    },
    fred: over.fred || {
      core: [100, 101, 102, 103, 103.5, 104, 104.5].map((v, i) => ({ d: '2026-0' + (i + 3) + '-01', v })),
      unrate: [4.0, 4.0, 4.0, 4.2].map((v, i) => ({ d: '2026-0' + (i + 6) + '-01', v })),
      payems: [{ d: '2026-08-01', v: 159000 }, { d: '2026-09-01', v: 159120 }],
    },
    fearGreed: over.fearGreed || [20, 20, 20, 20, 20, 20].map((v, i) => ({ d: 'd' + i, v })),
  };
}

test('A: oil down 21 sessions is BUY 3, the dollar up is SELL 2', () => {
  const d = load();
  const o = d.layersOuter(outerInput(), 50);
  assert.deepEqual(pts(o.A, 0), [3, 0]);
  assert.deepEqual(pts(o.A, 1), [0, 2]);
  assert.deepEqual(LS(o.A), [3, 2]);
  const flat = d.layersOuter(outerInput({ market: { brent: { c: ramp(80, 80, 22) } } }), 50);
  assert.deepEqual(pts(flat.A, 0), [0, 0], 'unchanged oil favours neither side');
  const none = d.layersOuter(outerInput({ market: { brent: null } }), 50);
  assert.deepEqual(J_(none.A.comps[0].slice(1)), ['not available', 0, 0], 'no oil series: no points, never a guess');
});

test('B: world stocks above their 200-day is BUY 5, above their 50-day SELL 5', () => {
  const d = load();
  assert.deepEqual(LS(d.layersOuter(outerInput(), 50).B), [5, 5]);
  assert.deepEqual(LS(d.layersOuter(outerInput({ market: { acwx: { c: ramp(60, 50, 250) } } }), 50).B), [0, 0]);
});

test('C: the 10-year yield, core inflation cooling, and jobs scored the tested way', () => {
  const d = load();
  const y = (from, to) => pts(d.layersOuter(outerInput({ market: { tnx: { c: ramp(from, to, 22) } } }), 50).C, 0);
  assert.deepEqual(y(4.5, 4.2), [4, 0], 'down: BUY 4');
  assert.deepEqual(y(4.0, 4.1), [2, 2], 'up a little: BUY 2, SELL 2');
  assert.deepEqual(y(4.0, 4.25), [2, 2], 'up exactly 0.25 is still the small move');
  assert.deepEqual(y(4.0, 4.5), [0, 6], 'up more than 0.25: SELL 6');
  assert.deepEqual(y(4.0, 4.0), [2, 0], 'unchanged: the small BUY, no SELL');
  const o = d.layersOuter(outerInput(), 50);
  assert.deepEqual(pts(o.C, 1), [2, 0], 'core 3-month pace 1.46% against 3.00%: cooling, BUY 2');
  assert.deepEqual(pts(o.C, 2), [2, 0], 'unemployment higher than three months earlier: BUY 2 (the test, not instinct)');
  assert.match(o.C.comps[2][1], /payrolls \+120,000 in September/);
  const jobs = (arr) => pts(d.layersOuter(outerInput({ fred: { ...outerInput().fred, unrate: arr.map(v => ({ d: 'x', v })) } }), 50).C, 2);
  assert.deepEqual(jobs([4.2, 4.0, 4.0, 4.0]), [0, 2], 'lower: SELL 2');
  assert.deepEqual(jobs([4.0, 4.1, 4.1, 4.0]), [1, 1], 'flat: one each');
});

test('D: VIX, breadth and Fear & Greed, scored against the crowd', () => {
  const d = load();
  const vix = (v) => pts(d.layersOuter(outerInput({ market: { vix: { c: ramp(v, v, 22) } } }), 50).D, 0);
  assert.deepEqual(vix(23), [3, 1]);
  assert.deepEqual(vix(22), [3, 1], '22 is fear');
  assert.deepEqual(vix(26), [3, 0], 'over 25: no SELL point');
  assert.deepEqual(vix(20), [0, 1], 'between 17 and 22: the dead zone for a BUY');
    assert.deepEqual(vix(15), [2, 2], 'calm: two each');
  const br = (b) => pts(d.layersOuter(outerInput(), b).D, 1);
  assert.deepEqual(br(35), [2, 0]);
  assert.deepEqual(br(50), [1, 2]);
  assert.deepEqual(br(65), [1, 3]);
  assert.deepEqual(br(75), [0, 3]);
  assert.deepEqual(J_(d.layersOuter(outerInput(), NaN).D.comps[1].slice(1)), ['not available', 0, 0]);
  const fg = (v) => pts(d.layersOuter(outerInput({ fearGreed: [{ d: 'x', v }] }), 50).D, 2);
  assert.deepEqual(fg(20), [2, 0]);
  assert.deepEqual(fg(40), [1, 0]);
  assert.deepEqual(fg(45), [0, 2]);
  assert.deepEqual(fg(80), [0, 2]);
});

// ── E and F ──────────────────────────────────────────────────────────────────
function sectorRun(d, name, fund, moves, members) {
  const input = { funds: { [fund]: { c: ramp(100, 130, 60) } }, market: { spy: { c: ramp(100, 105, 60) } } };
  const outer = { moves, movesText: { oil: 'oil', yield: 'yield', dollar: 'dollar', credit: 'credit' } };
  return d.layersSector(name, fund, input, outer, members);
}
const members = (up, n) => Array.from({ length: n }, (_, i) => ({ above50: i < up }));

test('E: a sector driver its way is BUY 5, against it SELL 5; no driver is a flat 2 each', () => {
  const d = load();
  assert.deepEqual(LS(sectorRun(d, 'Energy', 'XLE', { oil: 2 }, members(5, 10)).E), [5, 0]);
  assert.deepEqual(LS(sectorRun(d, 'Energy', 'XLE', { oil: -2 }, members(5, 10)).E), [0, 5]);
  assert.deepEqual(LS(sectorRun(d, 'Energy', 'XLE', { oil: 0 }, members(5, 10)).E), [0, 0]);
  assert.deepEqual(LS(sectorRun(d, 'Utilities', 'XLU', { yield: -0.1 }, members(5, 10)).E), [5, 0], 'a falling yield is the utilities\' way');
  assert.deepEqual(LS(sectorRun(d, 'Health Care', 'XLV', {}, members(5, 10)).E), [2, 2]);
});

test('F: sector breadth, the fund against the S&P 500 and against its own 50-day', () => {
  const d = load();
  const f = (up) => sectorRun(d, 'Health Care', 'XLV', {}, members(up, 10)).F;
  assert.deepEqual(pts(f(3), 0), [6, 0], '30%: washed out');
  assert.deepEqual(pts(f(5), 0), [4, 3], '50%');
  assert.deepEqual(pts(f(6), 0), [4, 3], '60% is still the middle');
  assert.deepEqual(pts(f(7), 0), [2, 6], '70%: broad');
  assert.deepEqual(pts(f(5), 1), [4, 0], 'the fund rose faster than SPY over five sessions');
  assert.deepEqual(pts(f(5), 2), [0, 4], 'the fund above its 50-day');
  assert.deepEqual(LS(f(5)), [8, 7]);
});

// ── G to K ───────────────────────────────────────────────────────────────────
test('G: above an average earns the side points, a cross within five sessions the cross points', () => {
  const d = load();
  const up = ramp(50, 100, 260);
  assert.deepEqual(J_(d.layersMaSide(up, 25, 4, 2).slice(2)), [2, 0]);
  const cross = ramp(100, 80, 259).concat([110]);
  assert.deepEqual(J_(d.layersMaSide(cross, 25, 4, 2).slice(2)), [4, 0]);
  const crossDown = ramp(50, 100, 259).concat([60]);
  assert.deepEqual(J_(d.layersMaSide(crossDown, 25, 4, 2).slice(2)), [0, 4]);
  assert.deepEqual(J_(d.layersMaSide(ramp(1, 2, 20), 200, 10, 5).slice(1)), ['not enough history', 0, 0]);
  const G = d.lyLetter(d.LAYERS_RULES.G.avgs.map(([days, x, y]) => d.layersMaSide(up, days, x, y)));
  assert.deepEqual(LS(G), [5 + 3 + 2, 0]);
});

function hBars(n, upVol, dnVol, todayVol, todayUp = true) {
  const c = [], v = [];
  for (let j = 0; j < n; j++) { c.push(100 + (j % 2)); v.push(j % 2 ? upVol : dnVol); }
  c[n - 1] = todayUp ? c[n - 2] + 1 : c[n - 2] - 1;
  v[n - 1] = todayVol;
  return { c, v };
}

test('H: today\'s volume, up against down volume (an exact 1.0 tie gives no point), volume building', () => {
  const d = load();
  /* alternating up and down days of equal volume; today is an up day on twice the average */
  const tie = hBars(80, 1000, 1000, 1000);
  const H0 = d.layersLetterH(tie);
  assert.deepEqual(pts(H0, 0), [1, 0], '1.0 times normal on an up day: 1');
  assert.match(H0.comps[1][1], /^1\.00 to 1 \(even\)/);
  assert.deepEqual(pts(H0, 1), [0, 0], 'an exact 1.0 tie: neither side');
  const two = d.layersLetterH(hBars(80, 1000, 1000, 2000));
  assert.deepEqual(pts(two, 0), [4, 0], 'twice normal: 4');
  const heavy = d.layersLetterH(hBars(80, 1300, 1000, 1000));
  assert.deepEqual(pts(heavy, 1), [3, 0], 'up volume 1.2 times down or more: 3');
  const light = d.layersLetterH(hBars(80, 1100, 1000, 1100));
  assert.deepEqual(pts(light, 1), [1, 0], 'heavier but under 1.2: 1');
  const sell = d.layersLetterH(hBars(80, 1000, 1500, 3000, false));
  assert.deepEqual(pts(sell, 0), [0, 4], 'heavy volume on a down day goes to SELL');
  assert.deepEqual(pts(sell, 1)[1], 3);
});

test('I: closes in a row, three or four the most, six or more stretched', () => {
  const d = load();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(n => d.layersStreakPts(n)), [0, 3, 6, 10, 10, 7, 3, 3]);
  const s = d.layersStreak([5, 4, 3, 4, 5, 6]);
  assert.deepEqual([s.up, s.dn], [3, 0]);
  const t = d.layersStreak([1, 2, 3, 2, 1]);
  assert.deepEqual([t.up, t.dn], [0, 2]);
  const f = d.layersStreak([1, 2, 2]);
  assert.deepEqual([f.up, f.dn], [0, 0], 'a flat close ends both runs');
});

test('J: the 13-week line by zone and direction, the daily by zone and its signal line', () => {
  const d = load();
  const J = (k, dk, dd) => d.layersLetterJ({ k, d: k }, { k: Array(k.length - 1).fill(50).concat([dk]), d: Array(k.length - 1).fill(50).concat([dd]) });
  const pad = (...xs) => Array(10).fill(50).concat(xs);
  assert.deepEqual(pts(J(pad(25, 28), 50, 50), 0), [7, 0], 'under 30 and rising');
  assert.deepEqual(pts(J(pad(28, 28, 28, 28, 28, 25), 50, 50), 0), [3, 0], 'under 30, falling slowly');
  assert.deepEqual(pts(J(pad(40, 35, 32, 30, 27, 25), 50, 50), 0), [0, 0], 'under 30, falling fast (15 in five sessions)');
  assert.deepEqual(pts(J(pad(50, 55), 50, 50), 0), [4, 1], 'between, rising');
  assert.deepEqual(pts(J(pad(55, 50), 50, 50), 0), [1, 4], 'between, falling');
  assert.deepEqual(pts(J(pad(90, 85), 50, 50), 0), [0, 7], 'over 80 and falling');
  assert.deepEqual(pts(J(pad(85, 90), 50, 50), 0), [0, 3], 'over 80 and rising');
  const peak = J(pad(50, 55), 85, 88);
  assert.deepEqual(pts(peak, 1), [0, 3]);
  assert.equal(peak.tm, 'peak');
  assert.deepEqual(pts(J(pad(50, 55), 85, 80), 1), [0, 2], 'over 80 but above its signal line');
  const trough = J(pad(50, 55), 15, 10);
  assert.deepEqual(pts(trough, 1), [3, 0]);
  assert.equal(trough.tm, 'trough');
  assert.deepEqual(pts(J(pad(50, 55), 50, 45), 1), [1, 0]);
  assert.deepEqual(pts(J(pad(50, 55), 50, 55), 1), [0, 1]);
  assert.deepEqual(pts(J(pad(50, 55), 50, 50), 1), [0, 0], 'on its signal line: nothing');
  assert.equal(J(pad(50, 55), 50, 50).tm, null);
});

test('K: beating the sector and the S&P 500 over 3 months and 5 sessions', () => {
  const d = load();
  const st = { c: ramp(100, 150, 80) }, laggard = { c: ramp(100, 101, 80) };
  assert.deepEqual(LS(d.layersLetterK(st, laggard, laggard)), [10, 0]);
  assert.deepEqual(LS(d.layersLetterK(laggard, st, st)), [0, 10]);
  assert.deepEqual(LS(d.layersLetterK(st, st, laggard)), [5, 0], 'level with its sector: no points there');
  const young = d.layersLetterK({ c: ramp(1, 2, 30) }, laggard, laggard);
  assert.deepEqual([young.comps[0][1], young.comps[2][1]], ['not enough history', 'not enough history'], 'under 63 sessions: no 3-month reading');
  assert.deepEqual(LS(young), [4, 0], 'the five-session readings still count');
  const adj = { c: ramp(100, 100, 80), a: ramp(100, 150, 80) };
  assert.deepEqual(LS(d.layersLetterK(adj, laggard, laggard)), [10, 0], 'strength reads the adjusted close');
});

// ── rule signals ─────────────────────────────────────────────────────────────
function tinyBars(n) { const z = Array(n).fill(100); return { t: Array(n).fill('2026-11-13'), o: z, h: z, l: z, c: z }; }

test('rule 3 is the plain cross of %K: under 30 then at or over 30; over 80 then at or under 80; a touch does not count', () => {
  const d = load();
  const r3 = (kp, kn) => [...d.layersRuleAt(tinyBars(2), { k: [kp, kn], d: [99, 99] }, 1)];
  assert.deepEqual(r3(29.9, 30), ['Rule 3 BUY'], 'reaching 30 counts');
  assert.deepEqual(r3(20, 45), ['Rule 3 BUY']);
  assert.deepEqual(r3(30, 31), [], 'sitting ON 30 the session before is a touch, not a cross');
  assert.deepEqual(r3(31, 29), []);
  assert.deepEqual(r3(80.1, 80), ['Rule 3 SELL'], 'falling to 80 counts');
  assert.deepEqual(r3(80, 79), [], 'sitting on 80 is a touch');
  assert.deepEqual(r3(79, 81), []);
  assert.deepEqual(r3(NaN, 40), []);
  /* no %D test: %D far above %K still gives the BUY dot */
  assert.deepEqual(J_([...d.layersRuleAt(tinyBars(2), { k: [25, 31], d: [60, 60] }, 1)]), ['Rule 3 BUY']);
});

function runBars(dir) {
  const n = 70, i = n - 1, base = 100;
  const o = Array(n).fill(base), c = Array(n).fill(base), h = Array(n).fill(base), l = Array(n).fill(base);
  const t = Array.from({ length: n }, (_, j) => 'd' + String(j).padStart(2, '0'));
  const m = dir; /* +1 BUY run off a low, -1 SELL run off a high */
  o[i - 6] = c[i - 6] = base - 9 * m; (m > 0 ? l : h)[i - 6] = base - 10 * m;
  (m > 0 ? h : l)[i - 6] = base - 9 * m;
  for (const j of [i - 5, i - 4, i - 3]) { o[j] = c[j] = h[j] = l[j] = base - 8 * m; }
  const steps = [base - 6 * m, base - 4 * m, base - 2 * m];
  [i - 2, i - 1, i].forEach((j, x) => { c[j] = steps[x]; o[j] = steps[x] - 1.5 * m; h[j] = Math.max(o[j], c[j]); l[j] = Math.min(o[j], c[j]); });
  return { t, o, h, l, c, i };
}

test('rules 1 and 2: three strong closes off a 60-session extreme set within 12 sessions, with %K running three days', () => {
  const d = load();
  const b = runBars(1), k = Array(70).fill(15);
  k[b.i - 3] = 20; k[b.i - 2] = 22; k[b.i - 1] = 25; k[b.i] = 28;
  assert.deepEqual(J_([...d.layersRuleAt(b, { k }, b.i)]), ['Rule 1 BUY']);
  const kHigh = k.slice(); kHigh[b.i] = 31;
  assert.deepEqual(J_([...d.layersRuleAt(b, { k: kHigh }, b.i)]), ['Rule 3 BUY'], '%K over 30 now: the run is not rule 1, the cross is rule 3');
  const kFlat = k.slice(); kFlat[b.i - 1] = 22;
  assert.deepEqual(J_([...d.layersRuleAt(b, { k: kFlat }, b.i)]), [], '%K must rise on each of the three days');
  const four = runBars(1); four.c[four.i - 3] = four.c[four.i - 4] * 1.02; four.o[four.i - 3] = four.c[four.i - 4];
  assert.deepEqual(J_([...d.layersRuleAt(four, { k }, four.i)]), [], 'the day before the three must not be a fourth strong day');
  const far = runBars(1); far.l[far.i - 6] = 70;
  assert.deepEqual(J_([...d.layersRuleAt(far, { k }, far.i)]), [], 'starting more than 8% above the low');
  const old = runBars(1); old.l[old.i - 6] = 100; old.l[old.i - 20] = 90;
  assert.deepEqual(J_([...d.layersRuleAt(old, { k }, old.i)]), [], 'a low set more than 10 sessions before the run');

  const s = runBars(-1), ks = Array(70).fill(85);
  ks[s.i - 3] = 80; ks[s.i - 2] = 78; ks[s.i - 1] = 75; ks[s.i] = 72;
  assert.deepEqual(J_([...d.layersRuleAt(s, { k: ks }, s.i)]), ['Rule 2 SELL']);
  const ksLow = ks.slice(); ksLow[s.i] = 69;
  assert.deepEqual(J_([...d.layersRuleAt(s, { k: ksLow }, s.i)]), [], '%K under 70 now: no rule 2');
});

test('signals count from the Monday of the as-of week', () => {
  const d = load();
  assert.equal(d.layersWeekStart('2026-11-13'), '2026-11-09');
  assert.equal(d.layersWeekStart('2026-11-09'), '2026-11-09');
  assert.equal(d.layersWeekStart('2026-11-15'), '2026-11-09');
  const b = { ...tinyBars(4), t: ['2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'] };
  const sig = d.layersSignals(b, { k: [25, 35, 25, 35] }, '2026-11-13');
  assert.deepEqual(JSON.parse(JSON.stringify(sig)), [['Rule 3 BUY', '2026-11-10']], 'last week\'s cross (Nov 6) is not this week\'s');
});

// ── the as-of day ────────────────────────────────────────────────────────────
test('the demo speaks of the last COMPLETED session (16:15 ET)', () => {
  const day = (iso) => { const d = load(Date.parse(iso)); return d.isoDate(d.layersLastSession(new d.Date())); };
  assert.equal(day('2026-11-13T17:30:00Z'), '2026-11-12', 'Friday 12:30 ET: Thursday');
  assert.equal(day('2026-11-13T21:10:00Z'), '2026-11-12', '16:10 ET: still settling');
  assert.equal(day('2026-11-13T21:20:00Z'), '2026-11-13', '16:20 ET: Friday is complete');
  assert.equal(day('2026-11-14T18:00:00Z'), '2026-11-13', 'Saturday');
  assert.equal(day('2026-11-16T15:00:00Z'), '2026-11-13', 'Monday morning: Friday');
  assert.equal(day('2026-11-27T17:30:00Z'), '2026-11-25', 'the day after Thanksgiving before its 13:00 early close settles: the Wednesday');
  assert.equal(day('2026-11-27T18:30:00Z'), '2026-11-27', '13:30 ET on the early-close day: complete');
});

// ── the whole scorer on the demo ─────────────────────────────────────────────
test('the demo scores within every limit and shows every kind of mark', () => {
  const d = load();
  const R = d.LAYERS_RULES;
  const out = d.layersScore(d.buildDemoLayersInput(new d.Date()));
  assert.equal(out.asOf, '2026-11-13');
  assert.ok(out.stocks.length >= 40, out.stocks.length + ' stocks');
  const outL = ['A', 'B', 'C', 'D'].reduce((s, k) => s + out.outer[k].L, 0), outS = ['A', 'B', 'C', 'D'].reduce((s, k) => s + out.outer[k].S, 0);
  for (const k of ['A', 'B', 'C', 'D']) {
    assert.ok(out.outer[k].L <= R.max[k] && out.outer[k].S <= R.max[k], k);
  }
  for (const sec of out.sectors) for (const k of ['E', 'F']) assert.ok(sec[k].L <= R.max[k] && sec[k].S <= R.max[k], sec.name + ' ' + k);
  const kinds = new Set();
  for (const st of out.stocks) {
    for (const k of ['G', 'H', 'I', 'J', 'K']) assert.ok(st.g[k].L <= R.max[k] && st.g[k].S <= R.max[k], st.sym + ' ' + k);
    const sec = out.sectors[st.sec];
    assert.equal(st.L, outL + sec.E.L + sec.F.L + st.sl, st.sym + ' BUY adds up');
    assert.equal(st.S, outS + sec.E.S + sec.F.S + st.ss, st.sym + ' SELL adds up');
    assert.ok(st.L >= 0 && st.L <= 100 && st.S >= 0 && st.S <= 100);
    assert.equal(st.lean, st.L - st.S);
    assert.equal(st.eff, d.layersHeld(st.lean, st.tm));
    for (const [name] of st.sig) kinds.add(name);
  }
  assert.deepEqual([...kinds].sort(), ['Rule 1 BUY', 'Rule 2 SELL', 'Rule 3 BUY', 'Rule 3 SELL']);
  assert.ok(out.stocks.some(s => s.held), 'a verdict held back');
  assert.ok(out.stocks.some(s => !s.sp), 'a watchlist stock outside the S&P 500');
  assert.ok(out.stocks.some(s => s.thin), 'a thin stock');
  assert.ok(out.excluded.length >= 1, 'something is left out, and named');
  assert.equal(new Set(out.stocks.map(s => s.sec)).size, 11, 'every sector has stocks');
  for (const v of ['Strong BUY', 'Leans BUY', 'No edge today', 'Leans SELL', 'Strong SELL']) {
    assert.ok(out.stocks.some(s => d.layersVerdict(s.eff) === v), v);
  }
});

test('stocks the scorer leaves out, with the reason', () => {
  const d = load();
  const input = d.buildDemoLayersInput(new d.Date());
  const one = input.stocks[0];
  const short = { ...one, sym: 'SHRT', bars: Object.fromEntries(Object.entries(one.bars).map(([k, v]) => [k, v.slice(-100)])) };
  const odd = { ...one, sym: 'ODD', sector: 'Cryptocurrency' };
  const late = { ...one, sym: 'LATE', bars: Object.fromEntries(Object.entries(one.bars).map(([k, v]) => [k, v.slice(0, -1)])) };
  const out = d.layersScore({ ...input, stocks: [one, short, odd, late], excluded: [] });
  const why = Object.fromEntries(out.excluded.map(x => [x.sym, x.why]));
  assert.match(why.SHRT, /under 120 sessions/);
  assert.match(why.ODD, /does not map/);
  assert.match(why.LATE, /no price for the as-of day/);
  assert.deepEqual(J_(out.stocks.map(s => s.sym)), [one.sym]);
});

test('the scorer reads the dashboard\'s own stochastics: a stock\'s %K is stochSeries(WSTOCH) on its last bar', () => {
  const d = load();
  const out = d.layersScore(d.buildDemoLayersInput(new d.Date()));
  const st = out.stocks[0];
  const wk = d.stochSeries(st.bars, d.WSTOCH);
  assert.equal(st.k, wk.k[wk.k.length - 1]);
});

// ── colour pairs (WCAG AA, 4.5:1) ────────────────────────────────────────────
function lum(hex) {
  const n = parseInt(hex.slice(1), 16), ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the panel\'s text colours clear 4.5:1 on its own backgrounds', () => {
  const css = readFileSync(path.join(ROOT, 'styles/layout.css'), 'utf8');
  const block = /\.ly-scope \{([^}]*)\}/.exec(css)[1];
  const tok = Object.fromEntries([...block.matchAll(/--(ly-[\w-]+|color-accent-light):\s*(#[0-9A-Fa-f]{6})/g)].map(m => [m[1], m[2]]));
  const pairs = [['ly-ink', 'ly-halo'], ['ly-ink', 'ly-canvas'], ['ly-ink', 'ly-panel-2'], ['ly-ink-2', 'ly-canvas'], ['ly-ink-2', 'ly-panel-2'],
    ['ly-buy-ink', 'ly-canvas'], ['ly-buy-ink', 'ly-panel-2'], ['ly-sell-ink', 'ly-canvas'], ['ly-sell-ink', 'ly-panel-2'],
    ['ly-accent', 'color-accent-light'], ['ly-halo', 'ly-accent'], ['ly-accent', 'ly-canvas']];
  for (const [fg, bg] of pairs) {
    assert.ok(tok[fg] && tok[bg], fg + ' / ' + bg + ' declared');
    const r = ratio(tok[fg], tok[bg]);
    assert.ok(r >= 4.5, `${fg} ${tok[fg]} on ${bg} ${tok[bg]}: ${r.toFixed(2)}:1`);
  }
});
