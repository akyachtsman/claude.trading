/* Unit tests for the pure logic in scripts/data.js (formatters, the NYSE calendar, Pacific clocks,
   session gates and lamps, the stochastic / RSI math, the Economy helpers, the dashboard payload
   mapper and the device-PIN storage). Run: `node --test tools/unit/`.

   data.js is loaded into a fresh vm context per test by `loadData()` (tools/unit/lib.mjs),
   with a settable clock (`d.clock.now`) and in-memory storage. Expectations are worked out HERE, from
   the rules in CLAUDE.md and the functions' own comments, never by calling another data.js helper. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadData } from './lib.mjs';

const at = (iso) => Date.parse(iso);
const DASH = '—';
const MINUS = '−';

// ── formatters ──────────────────────────────────────────────────────────────
test('every number formatter answers an em dash for an unknown value', () => {
  const d = loadData();
  for (const f of ['fmtPct', 'fmtUsd', 'fmtUsd0', 'fmtSigned']) {
    for (const v of [null, undefined, '', NaN, Infinity, -Infinity, 'abc']) {
      assert.equal(d[f](v), DASH, `${f}(${String(v)})`);
    }
  }
});

test('fmtPct: two decimals, a plus for zero and gains, a true minus sign for losses', () => {
  const d = loadData();
  assert.equal(d.fmtPct(0), '+0.00%');
  assert.equal(d.fmtPct(1.234), '+1.23%');
  assert.equal(d.fmtPct(-3.14159), MINUS + '3.14%');
  assert.equal(d.fmtPct('2.5'), '+2.50%', 'a numeric string still formats');
  assert.equal(d.fmtPct(12345.678), '+12345.68%');
});

test('fmtUsd / fmtUsd0 / fmtSigned: grouping, cents and signs', () => {
  const d = loadData();
  assert.equal(d.fmtUsd(1234.5), '$1,234.50');
  assert.equal(d.fmtUsd(-1234.5), MINUS + '$1,234.50');
  assert.equal(d.fmtUsd(0), '$0.00');
  assert.equal(d.fmtUsd0(1234.6), '$1,235');
  assert.equal(d.fmtUsd0(-999.4), MINUS + '$999');
  assert.equal(d.fmtSigned(0), '+$0.00');
  assert.equal(d.fmtSigned(42.1), '+$42.10');
  assert.equal(d.fmtSigned(-2), MINUS + '$2.00');
});

// ── the NYSE calendar ───────────────────────────────────────────────────────
// An independent rule-based NYSE holiday list (observed dates). NYSE does NOT observe a Saturday
// New Year's Day on the Friday before (it would fall in the prior year).
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
function nthWeekday(y, m, wd, n) { let d = 1; while (dow(y, m, d) !== wd) d++; return d + 7 * (n - 1); }
function lastWeekday(y, m, wd) { let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); while (dow(y, m, d) !== wd) d--; return d; }
function observed(y, m, d) {
  const w = dow(y, m, d);
  const t = Date.UTC(y, m - 1, d) + (w === 6 ? -1 : w === 0 ? 1 : 0) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function easter(y) { // anonymous Gregorian computus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}
function nyseHolidays(y) {
  const out = [];
  if (dow(y, 1, 1) !== 6) out.push(observed(y, 1, 1));
  out.push(ymd(y, 1, nthWeekday(y, 1, 1, 3)), ymd(y, 2, nthWeekday(y, 2, 1, 3)));
  const [em, ed] = easter(y);
  out.push(new Date(Date.UTC(y, em - 1, ed) - 2 * 86400000).toISOString().slice(0, 10));
  out.push(ymd(y, 5, lastWeekday(y, 5, 1)), observed(y, 6, 19), observed(y, 7, 4));
  out.push(ymd(y, 9, nthWeekday(y, 9, 1, 1)), ymd(y, 11, nthWeekday(y, 11, 4, 4)), observed(y, 12, 25));
  return out.sort();
}

test('NYSE_HOLIDAYS matches the NYSE rules for every full year it carries', () => {
  const d = loadData();
  const table = [...d.NYSE_HOLIDAYS];
  const years = [...new Set(table.map((s) => +s.slice(0, 4)))].filter((y) => table.some((s) => s.startsWith(y + '-01-')));
  assert.ok(years.length >= 2, 'at least two full years');
  for (const y of years) assert.deepEqual(table.filter((s) => s.startsWith(y + '-')).sort(), nyseHolidays(y), `NYSE holidays ${y}`);
});

test('the holiday tables do not run out (extend NYSE_HOLIDAYS, NYSE_EARLY_CLOSES and BOND_ONLY_HOLIDAYS yearly)', () => {
  // A reminder with a date on it: CLAUDE.md says "NYSE_HOLIDAYS runs through 2027 — extend it before 2028".
  // The REAL clock: this fails from December 1 of the last year a table covers, while there is still time to add
  // the next one (the same date as the desk-ibkr-sync copy's check in cron-ibkr.test.mjs).
  const d = loadData();
  const lastYear = (set) => Math.max(...[...set].map((s) => Number(s.slice(0, 4))));
  const now = new Date();
  for (const [name, set] of [['NYSE_HOLIDAYS', d.NYSE_HOLIDAYS], ['NYSE_EARLY_CLOSES', d.NYSE_EARLY_CLOSES], ['BOND_ONLY_HOLIDAYS', d.BOND_ONLY_HOLIDAYS]]) {
    const y = lastYear(set);
    assert.ok(now < new Date(Date.UTC(y, 11, 1)), `${name} ends in ${y}: add ${y + 1} (scripts/data.js and the edge functions' copies)`);
  }
});

test('early closes and bond-only holidays follow their rules', () => {
  const d = loadData();
  for (const s of d.NYSE_EARLY_CLOSES) {
    assert.ok(!d.NYSE_HOLIDAYS.has(s), `${s} is both a holiday and an early close`);
    const w = dow(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
    assert.ok(w >= 1 && w <= 5, `${s} is a weekday`);
  }
  for (const y of [2026, 2027]) {
    assert.ok(d.NYSE_EARLY_CLOSES.has(ymd(y, 11, nthWeekday(y, 11, 4, 4) + 1)), `${y}: the day after Thanksgiving closes early`);
    assert.ok(d.BOND_ONLY_HOLIDAYS.has(ymd(y, 10, nthWeekday(y, 10, 1, 2))), `${y}: Columbus Day`);
    assert.ok(d.BOND_ONLY_HOLIDAYS.has(ymd(y, 11, 11)), `${y}: Veterans Day`);
  }
  assert.ok(!d.NYSE_EARLY_CLOSES.has('2027-12-24'), 'Dec 24 2027 is the observed Christmas holiday, not an early close');
});

test('isTradingDay / tradingDayOnOrBefore: weekends and holidays are skipped', () => {
  const d = loadData();
  assert.equal(d.isTradingDay(new Date(2026, 9, 14)), true, 'a Wednesday');
  assert.equal(d.isTradingDay(new Date(2026, 9, 17)), false, 'a Saturday');
  assert.equal(d.isTradingDay(new Date(2026, 10, 26)), false, 'Thanksgiving');
  assert.equal(d.isTradingDay(new Date(2026, 9, 12)), true, 'Columbus Day: stocks trade');
  assert.equal(d.isoDate(d.tradingDayOnOrBefore(new Date(2026, 9, 18))), '2026-10-16', 'Sunday → Friday');
  assert.equal(d.isoDate(d.tradingDayOnOrBefore(new Date(2026, 3, 5))), '2026-04-02', 'Easter Sunday → the Thursday before Good Friday');
  assert.equal(d.isoDate(d.tradingDayOnOrBefore(new Date(2026, 9, 14))), '2026-10-14', 'a trading day is its own answer');
});

test('lastTradingDay keys off the PACIFIC calendar day of an instant', () => {
  const d = loadData();
  assert.equal(d.isoDate(d.lastTradingDay(new Date(at('2026-10-20T05:00:00Z')))), '2026-10-19', 'Mon 22:00 PDT is still Monday although UTC says Tuesday');
  assert.equal(d.isoDate(d.lastTradingDay(new Date(at('2026-10-17T19:00:00Z')))), '2026-10-16', 'Saturday → Friday');
  assert.equal(d.isoDate(d.lastTradingDay(new Date(at('2026-11-26T20:00:00Z')))), '2026-11-25', 'Thanksgiving → Wednesday');
  assert.equal(d.isoDate(d.lastTradingDay(new Date(at('2026-01-01T20:00:00Z')))), '2025-12-31', 'New Year → the old year');
});

test('lampFor: EOD when the as-of is the last trading day, STALE when older, NO DATA when absent', () => {
  const d = loadData();
  const now = new Date(at('2026-10-17T19:00:00Z')); // Saturday: the last trading day is Fri Oct 16
  assert.equal(d.lampFor('2026-10-16', now).text, 'EOD');
  assert.equal(d.lampFor('2026-10-15', now).text, 'STALE');
  assert.match(d.lampFor('2026-10-15', now).stamp, /refresh overdue$/);
  assert.deepEqual({ ...d.lampFor(null, now) }, { cls: 'lamp--stale', text: 'NO DATA', stamp: DASH });
});

// ── Pacific clocks ──────────────────────────────────────────────────────────
test('fmtClock: Pacific with a zone label, midnight is 00 not 24, junk is empty', () => {
  const d = loadData();
  assert.equal(d.fmtClock('2026-10-14T19:32:00Z'), '12:32 PDT');
  assert.equal(d.fmtClock('2026-12-05T01:03:00Z'), '17:03 PST');
  assert.equal(d.fmtClock('2026-10-14T07:03:00Z'), '00:03 PDT');
  assert.equal(d.fmtClock('not a date'), '');
});

// Some engines read a bare `hour12: false` as the h24 cycle and print the midnight hour as "24" (the
// reason fmtClock asks for `hourCycle: 'h23'` by name — Codex, PR #334; S73 emulates such an engine).
// This emulates it for the dates of one context, so the OTHER Pacific clocks can be held to the rule.
function h24Engine(d) {
  const proto = d.Date.prototype;
  const wrap = (name) => {
    const orig = Date.prototype[name];
    proto[name] = function (loc, o) {
      const opts = o && o.hour12 === false && !o.hourCycle ? { ...o, hour12: undefined, hourCycle: 'h24' } : o;
      return orig.call(this, loc, opts);
    };
  };
  wrap('toLocaleTimeString'); wrap('toLocaleString');
  return d;
}

test('the emulated h24 engine misprints a bare hour12:false, and fmtClock survives it', () => {
  const d = h24Engine(loadData());
  const mid = new d.Date('2026-10-14T07:03:00Z');
  assert.equal(mid.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' }), '24:03', 'the emulation is live');
  assert.equal(d.fmtClock('2026-10-14T07:03:00Z'), '00:03 PDT');
});

test('fmtBarT / fmtClockBare / newsWhen print the Pacific midnight hour as 00 in an h24 engine',
  { todo: 'BUG: fmtBarT, fmtClockBare, newsWhen and utcHmToPt still pass a bare `hour12: false` (fmtClock was fixed to hourCycle h23 in PR #334) — such an engine prints "24:03"' },
  () => {
    const d = h24Engine(loadData({ now: at('2026-10-14T17:00:00Z') }));
    assert.equal(d.fmtBarT('2026-10-14 07:03'), '2026-10-14 00:03 PT');
    assert.equal(d.fmtClockBare('2026-10-14T07:03:00Z'), '00:03');
    assert.equal(d.newsWhen('2026-10-14T07:03:00Z').t, '00:03');
    assert.equal(d.utcHmToPt('07:03'), '00:03');
  });

test('fmtBarT: a UTC intraday stamp reads Pacific; a daily date and junk pass through', () => {
  const d = loadData();
  assert.equal(d.fmtBarT('2026-10-14 20:00'), '2026-10-14 13:00 PT');
  assert.equal(d.fmtBarT('2026-12-14 21:00'), '2026-12-14 13:00 PT');
  assert.equal(d.fmtBarT('2026-10-15 03:30'), '2026-10-14 20:30 PT', 'the Pacific DATE moves back too');
  assert.equal(d.fmtBarT('2026-10-14'), '2026-10-14');
  assert.equal(d.fmtBarT(''), '');
  assert.equal(d.fmtBarT('2026-10-14 25:99'), '2026-10-14 25:99', 'an impossible clock passes through, never repaired');
});

test('utcHmToPt: a bare UTC HH:mm becomes Pacific; anything else passes through', () => {
  const d = loadData({ now: at('2026-10-14T17:00:00Z') });
  assert.equal(d.utcHmToPt('20:15'), '13:15');
  assert.equal(d.utcHmToPt('7:15'), '7:15');
  assert.equal(d.utcHmToPt(undefined), undefined);
});

test('ptDateKey / fmtShortDate: the Pacific date, and a month by string slicing (Aug 1 never reads Jul 31)', () => {
  const d = loadData();
  assert.equal(d.ptDateKey(new d.Date('2026-10-15T06:30:00Z')), '2026-10-14');
  assert.equal(d.fmtShortDate('2026-08-01'), 'Aug 1');
  assert.equal(d.fmtShortDate('2026-12-31T23:00:00Z'), 'Dec 31');
  assert.equal(d.fmtShortDate('Oct 5'), 'Oct 5', 'an already-short label passes through');
  assert.equal(d.fmtShortDate(''), '');
});

test('newsWhen / newsDateLabel: only a row from another PACIFIC day carries a date', () => {
  const d = loadData({ now: at('2026-10-14T17:00:00Z') }); // 10:00 PDT
  const today = d.newsWhen('2026-10-14T15:00:00Z');
  assert.equal(today.t, '08:00');
  assert.equal(today.d, '', 'today is not dated');
  assert.equal(today.full, '2026-10-14 08:00 PDT');
  assert.equal(d.newsWhen('2026-10-14T06:30:00Z').d, 'Oct 13', '23:30 PDT the night before is yesterday');
  assert.equal(d.newsWhen('2026-06-29T21:19:00Z').d, 'Jun 29');
  d.clock.now = at('2026-10-15T07:30:00Z'); // 00:30 PDT Oct 15
  assert.equal(d.newsDateLabel('2026-10-15T06:30:00Z'), 'Oct 14', 'an hour old but across Pacific midnight: dated');
  assert.equal(d.newsDateLabel('2026-10-15T07:10:00Z'), '');
  const legacy = d.newsWhen(null, '20:15');
  assert.equal(legacy.d, '');
  assert.equal(legacy.full, '');
  assert.equal(d.newsDateLabel('junk'), '');
});

test('askWhen: Pacific, the date always drawn, PDT/PST by season, junk is null', () => {
  const d = loadData({ now: at('2026-10-14T20:00:00Z') });
  const a = d.askWhen('2026-10-14T19:32:56.487577+00:00');
  assert.equal(a.t, 'Oct 14, 12:32 PDT');
  assert.equal(a.full, '2026-10-14 12:32 PDT', 'the tooltip carries the year');
  assert.equal(d.askWhen('2026-12-05T01:03:00Z').t, 'Dec 4, 17:03 PST', 'PST, and the evening before its UTC date');
  assert.equal(d.askWhen('2026-10-14T17:34:00Z').t, 'Oct 14, 10:34 PDT');
  for (const bad of [null, undefined, '', 'junk', 123, '2026', 'March 7', '2026-10-14', '2026-13-45T25:99:00Z']) {
    assert.equal(d.askWhen(bad), null, `askWhen(${JSON.stringify(bad)})`);
  }
});

test('fmtDelay: whole minutes, under-a-minute in words, junk empty', () => {
  const d = loadData({ now: at('2026-10-14T17:00:00Z') });
  assert.equal(d.fmtDelay('2026-10-14T16:59:40Z'), 'delayed by under a minute');
  assert.equal(d.fmtDelay('2026-10-14T16:59:00Z'), 'delayed by 1 minute');
  assert.equal(d.fmtDelay('2026-10-14T16:57:00Z'), 'delayed by 3 minutes');
  assert.equal(d.fmtDelay('2026-10-14T17:05:00Z'), 'delayed by under a minute', 'a clock skew forward is not a negative delay');
  assert.equal(d.fmtDelay('junk'), '');
});

test('fmtUpdated: clock, date and the right tail', () => {
  const d = loadData({ now: at('2026-10-14T17:00:00Z') });
  assert.equal(d.fmtUpdated('2026-10-14T20:00:00Z', '2026-10-14', 'close'), 'Last updated 13:00, Oct 14, at close');
  assert.equal(d.fmtUpdated('2026-10-14T16:57:00Z', '2026-10-14', 'age'), 'Last updated 09:57, Oct 14, delayed by 3 minutes');
  assert.equal(d.fmtUpdated(null, '2026-07-21'), 'Last updated Jul 21');
  assert.equal(d.fmtUpdated(null, null, 'age'), '');
  assert.equal(d.fmtUpdated(null, '2026-07-21', 'age'), 'Last updated Jul 21', 'no clock, no delay tail');
});

// ── session gates ───────────────────────────────────────────────────────────
test('etClock: the New York wall clock across both DST seasons', () => {
  const d = loadData();
  assert.deepEqual({ ...d.etClock(new Date(at('2026-10-14T13:30:00Z'))) }, { date: '2026-10-14', weekend: false, minutes: 570 });
  assert.deepEqual({ ...d.etClock(new Date(at('2026-12-14T14:30:00Z'))) }, { date: '2026-12-14', weekend: false, minutes: 570 });
  assert.equal(d.etClock(new Date(at('2026-10-18T03:59:00Z'))).weekend, true, 'Sat 23:59 ET');
  assert.equal(d.etClock(new Date(at('2026-10-19T04:00:00Z'))).weekend, false, 'Mon 00:00 ET although UTC already said Monday at 00:00Z');
  assert.equal(d.etClock(new Date(at('2026-10-17T15:00:00Z'))).weekend, true, 'Saturday');
  assert.equal(d.etClock(new Date(at('2026-10-15T04:00:00Z'))).minutes, 0, 'midnight is minute 0 (h23)');
});

test('nyseCloseMin: 13:00 on an early-close day, 16:00 otherwise', () => {
  const d = loadData();
  assert.equal(d.nyseCloseMin('2026-11-27'), 780);
  assert.equal(d.nyseCloseMin('2026-12-24'), 780);
  assert.equal(d.nyseCloseMin('2026-10-14'), 960);
});

test('marketSessionOpen: 09:30 to the close, closed weekends, holidays and after an early close', () => {
  const d = loadData();
  const open = (iso) => d.marketSessionOpen(new Date(at(iso)));
  assert.equal(open('2026-10-14T13:29:00Z'), false, '09:29 ET');
  assert.equal(open('2026-10-14T13:30:00Z'), true, '09:30 ET');
  assert.equal(open('2026-10-14T19:59:00Z'), true, '15:59 ET');
  assert.equal(open('2026-10-14T20:00:00Z'), false, '16:00 ET');
  assert.equal(open('2026-12-14T14:30:00Z'), true, '09:30 EST');
  assert.equal(open('2026-11-27T17:59:00Z'), true, '12:59 ET on the day after Thanksgiving');
  assert.equal(open('2026-11-27T18:00:00Z'), false, '13:00 ET early close');
  assert.equal(open('2026-11-26T16:00:00Z'), false, 'Thanksgiving');
  assert.equal(open('2026-10-17T16:00:00Z'), false, 'Saturday');
});

test('postMarketOpen / extendedSessionOpen / withinCloseSettleGrace hang off the day\'s own close', () => {
  const d = loadData();
  const t = (f, iso) => d[f](new Date(at(iso)));
  assert.equal(t('postMarketOpen', '2026-10-14T19:59:00Z'), false);
  assert.equal(t('postMarketOpen', '2026-10-14T20:00:00Z'), true);
  assert.equal(t('postMarketOpen', '2026-10-14T23:59:00Z'), true);
  assert.equal(t('postMarketOpen', '2026-10-15T00:00:00Z'), false, '20:00 ET');
  assert.equal(t('postMarketOpen', '2026-11-27T18:00:00Z'), true, '13:00 ET on an early-close day');
  assert.equal(t('postMarketOpen', '2026-11-27T22:00:00Z'), false, '17:00 ET on an early-close day');
  assert.equal(t('postMarketOpen', '2026-11-26T21:00:00Z'), false, 'a holiday has no post-market');
  assert.equal(t('extendedSessionOpen', '2026-10-14T07:59:00Z'), false, '03:59 ET');
  assert.equal(t('extendedSessionOpen', '2026-10-14T08:00:00Z'), true, '04:00 ET');
  assert.equal(t('extendedSessionOpen', '2026-10-14T23:59:00Z'), true);
  assert.equal(t('withinCloseSettleGrace', '2026-10-14T20:00:00Z'), true);
  assert.equal(t('withinCloseSettleGrace', '2026-10-14T20:14:00Z'), true);
  assert.equal(t('withinCloseSettleGrace', '2026-10-14T20:15:00Z'), false);
  assert.equal(t('withinCloseSettleGrace', '2026-11-27T18:05:00Z'), true, 'measured from 13:00 on an early-close day');
  assert.equal(t('withinCloseSettleGrace', '2026-11-26T21:05:00Z'), false, 'never on a holiday');
});

test('marketCloseInstant: the close as a UTC instant, DST and early closes included', () => {
  const d = loadData();
  assert.equal(d.marketCloseInstant('2026-10-14'), '2026-10-14T20:00:00.000Z');
  assert.equal(d.marketCloseInstant('2026-12-14'), '2026-12-14T21:00:00.000Z');
  assert.equal(d.marketCloseInstant('2026-03-09'), '2026-03-09T20:00:00.000Z', 'the Monday after DST starts');
  assert.equal(d.marketCloseInstant('2026-11-02'), '2026-11-02T21:00:00.000Z', 'the Monday after DST ends');
  assert.equal(d.marketCloseInstant('2026-11-27'), '2026-11-27T18:00:00.000Z', 'early close');
  assert.equal(d.marketCloseInstant('2026-10-14T09:00:00Z'), '2026-10-14T20:00:00.000Z', 'a date-time reads its date');
  assert.equal(d.marketCloseInstant('junk'), null);
  assert.equal(d.marketCloseInstant(null), null);
});

test('liveLampFor while the session is open: LIVE when fetched within 6 min, STALE after; the quote clock is shown', () => {
  const d = loadData({ now: at('2026-10-14T17:00:00Z') }); // 13:00 ET Wednesday
  const live = d.liveLampFor('2026-10-14T16:56:00Z', '2026-10-14', true, '2026-10-14T16:50:00Z');
  assert.equal(live.text, 'LIVE');
  assert.equal(live.atIso, '2026-10-14T16:50:00Z', 'the MARKET clock, not the fetch clock');
  assert.equal(live.stamp, 'Last updated 09:50, Oct 14, delayed by 10 minutes');
  assert.equal(d.liveLampFor('2026-10-14T16:54:00Z', '2026-10-14', true).text, 'LIVE', 'exactly 6 minutes');
  const stale = d.liveLampFor('2026-10-14T16:53:00Z', '2026-10-14', true);
  assert.equal(stale.text, 'STALE');
  assert.match(stale.stamp, / — refresh overdue$/);
  assert.equal(d.liveLampFor('junk', '2026-10-14', false).text, 'STALE', 'an unparseable fetch clock is not fresh');
});

test('liveLampFor after the bell: EOD only for a print at or after the close; a post-market print names itself', () => {
  const d = loadData({ now: at('2026-10-14T21:30:00Z') }); // 17:30 ET
  const eod = d.liveLampFor('2026-10-14T21:29:00Z', '2026-10-14', true, '2026-10-14T20:00:30Z');
  assert.equal(eod.text, 'EOD');
  assert.equal(eod.stamp, 'Last updated 13:00, Oct 14, at close');
  assert.equal(d.liveLampFor('2026-10-14T21:29:00Z', '2026-10-14', true, '2026-10-14T19:59:00Z').text, 'STALE',
    'a mid-session price never relabels itself as the close');
  const ext = d.liveLampFor('2026-10-14T21:29:00Z', '2026-10-14', true, '2026-10-14T20:00:30Z', '2026-10-14T21:12:00Z');
  assert.equal(ext.text, 'EOD');
  assert.equal(ext.stamp, 'Last updated 14:12, Oct 14 — after hrs');
  assert.equal(ext.tail, '', 'no growing delay tail on an extended print');
  // the next morning's pre-market print is more than 4h past the prior close: not "after hrs"
  d.clock.now = at('2026-10-15T10:30:00Z'); // 06:30 ET Thursday, session shut
  const pre = d.liveLampFor('2026-10-15T10:29:00Z', '2026-10-14', true, '2026-10-14T20:00:30Z', '2026-10-15T10:00:00Z');
  assert.equal(pre.text, 'EOD');
  assert.match(pre.stamp, /at close$/);
  // a non-price feed keeps LIVE/STALE around the clock
  assert.equal(d.liveLampFor('2026-10-15T10:28:00Z', null, false).text, 'LIVE');
});

// ── stochastic and RSI ──────────────────────────────────────────────────────
function bars(n, seed = 7) {
  let s = seed >>> 0, v = 100;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const o = { h: [], l: [], c: [] };
  for (let i = 0; i < n; i++) { v *= 1 + (rnd() - 0.5) * 0.04; const hi = v * (1 + rnd() * 0.02), lo = v * (1 - rnd() * 0.02); o.h.push(hi); o.l.push(lo); o.c.push(lo + (hi - lo) * rnd()); }
  return o;
}
const firstNonNull = (a) => a.findIndex((x) => x != null);

test('stochSeries: warm-up nulls, values within 0..100, a flat range reads 50, too few bars give nothing', () => {
  const d = loadData();
  const s = d.stochSeries(bars(60), { k: 14, kSmooth: 3, d: 3 });
  assert.equal(firstNonNull(s.k), 14 + 3 - 2);
  assert.equal(firstNonNull(s.d), 14 + 3 + 3 - 3);
  assert.ok(s.k.every((x) => x == null || (x >= 0 && x <= 100)));
  const flat = { h: Array(30).fill(10), l: Array(30).fill(10), c: Array(30).fill(10) };
  assert.ok(d.stochSeries(flat, { k: 14, kSmooth: 3, d: 3 }).k.filter((x) => x != null).every((x) => x === 50));
  const few = d.stochSeries(bars(10), { k: 14, kSmooth: 3, d: 3 });
  assert.ok(few.k.every((x) => x == null) && few.d.every((x) => x == null));
  // a close at the top of its window is 100, at the bottom 0 (no smoothing)
  const edge = { h: [1, 2, 3, 4], l: [0, 1, 2, 3], c: [0.5, 1.5, 2.5, 4] };
  assert.equal(d.stochSeries(edge, { k: 3, kSmooth: 1, d: 1 }).k[3], 100);
});

test('stochPartial IS stochSeries from kFrom / dFrom on, starts at the tenth bar and stays in range', () => {
  const d = loadData();
  for (const cfg of [{ k: 92, kSmooth: 15, d: 15 }, { k: 14, kSmooth: 3, d: 3 }, { k: 10, kSmooth: 3, d: 3 }]) {
    const b = bars(200, cfg.k);
    const full = d.stochSeries(b, cfg), part = d.stochPartial(b, cfg);
    assert.equal(part.kFrom, firstNonNull(full.k), `kFrom ${cfg.k}`);
    assert.equal(part.dFrom, firstNonNull(full.d), `dFrom ${cfg.k}`);
    for (let i = part.kFrom; i < 200; i++) assert.ok(Math.abs(part.k[i] - full.k[i]) < 1e-9, `%K at ${i}`);
    for (let i = part.dFrom; i < 200; i++) assert.ok(Math.abs(part.d[i] - full.d[i]) < 1e-9, `%D at ${i}`);
    assert.equal(firstNonNull(part.k), Math.min(cfg.k, d.PARTIAL_MIN_BARS) - 1);
    assert.ok(part.k.every((x) => x == null || (x >= 0 && x <= 100)));
  }
  const nine = d.stochPartial(bars(9), { k: 92, kSmooth: 15, d: 15 });
  assert.ok(nine.k.every((x) => x == null), 'under ten bars: nothing');
  const flat = { h: Array(20).fill(5), l: Array(20).fill(5), c: Array(20).fill(5) };
  assert.ok(d.stochPartial(flat, { k: 92, kSmooth: 15, d: 15 }).k.filter((x) => x != null).every((x) => x === 50));
});

test('rsiSeries: nothing until len+1 closes, 100 on all-up, 0 on all-down, within 0..100', () => {
  const d = loadData();
  assert.ok(d.rsiSeries({ c: Array.from({ length: 14 }, (_, i) => i) }).every((x) => x == null));
  const up = d.rsiSeries({ c: Array.from({ length: 30 }, (_, i) => 100 + i) });
  assert.equal(firstNonNull(up), 14);
  assert.equal(up[29], 100);
  const down = d.rsiSeries({ c: Array.from({ length: 30 }, (_, i) => 100 - i) });
  assert.equal(down[29], 0);
  const mixed = d.rsiSeries({ c: bars(80).c });
  assert.ok(mixed.slice(14).every((x) => x > 0 && x < 100));
  // Wilder's first value by hand: 14 diffs, gains 7×1, losses 7×1 → RSI 50
  const zig = d.rsiSeries({ c: Array.from({ length: 15 }, (_, i) => (i % 2 ? 101 : 100)) });
  assert.equal(zig[14], 50);
});

test('rsiSeries on a flat series reads neutral, not overbought',
  { todo: 'BUG?: a constant close series reads RSI 100 (avgLoss 0 ⇒ 100) — an extreme "overbought" for no movement, unlike stochSeries, which reads a flat range as 50' },
  () => {
    const d = loadData();
    const flat = d.rsiSeries({ c: Array(30).fill(10) });
    assert.equal(flat[29], 50);
  });

// ── Economy helpers ─────────────────────────────────────────────────────────
test('econShiftMonths clamps to the month end; econShiftDays is calendar arithmetic', () => {
  const d = loadData();
  assert.equal(d.econShiftMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(d.econShiftMonths('2024-03-31', -1), '2024-02-29', 'leap year');
  assert.equal(d.econShiftMonths('2026-01-15', -1), '2025-12-15', 'across a year');
  assert.equal(d.econShiftMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(d.econShiftMonths('2026-10-14', -60), '2021-10-14');
  assert.equal(d.econShiftDays('2026-03-01', -1), '2026-02-28');
  assert.equal(d.econShiftDays('2026-03-08', 1), '2026-03-09', 'DST day is still one day');
  assert.equal(d.econShiftDays('2026-12-31', 1), '2027-01-01');
});

test('econDownsample: a copy under the cap; over it ≤ max real points, both ends and the extremes kept, in order', () => {
  const d = loadData();
  const small = [[1, 1], [2, 2]];
  const copy = d.econDownsample(small, 150);
  assert.deepEqual(copy, small);
  assert.notEqual(copy, small);
  const pts = Array.from({ length: 1000 }, (_, i) => [i, Math.sin(i / 30)]);
  pts[517] = [517, 9]; pts[733] = [733, -9];
  for (const max of [150, 151, 10, 3]) {
    const out = d.econDownsample(pts, max);
    assert.ok(out.length <= max, `≤ ${max}`);
    assert.deepEqual(out[0], pts[0]);
    assert.deepEqual(out[out.length - 1], pts[999]);
    for (let i = 1; i < out.length; i++) assert.ok(out[i][0] > out[i - 1][0], 'oldest first, no repeats');
    assert.ok(out.every((p) => pts[p[0]] === p), 'every point is a real observation');
    if (max >= 10) { assert.ok(out.some((p) => p[0] === 517), 'the spike survives'); assert.ok(out.some((p) => p[0] === 733), 'the dip survives'); }
  }
});

test('econSpanSlice: a span from the last reading back, and a short span falls back to the 6 latest WITH a note', () => {
  const d = loadData();
  const daily = [];
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2026, 9, 14); t += 86400000) daily.push([new Date(t).toISOString().slice(0, 10), 1]);
  const w = d.econSpanSlice(daily, '1w', 'daily');
  assert.equal(w.start, '2026-10-07');
  assert.equal(w.slice[0][0], '2026-10-07');
  assert.equal(w.slice.length, 8);
  assert.equal(w.note, null);
  assert.equal(d.econSpanSlice(daily, '3m', 'daily').start, '2026-07-14');
  const monthly = ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'].map((s) => [s, 4]);
  const m = d.econSpanSlice(monthly, '1m', 'monthly');
  assert.equal(m.slice.length, 6);
  assert.equal(m.note, 'monthly - 6 latest');
  const tiny = d.econSpanSlice(monthly.slice(-3), '1m', 'monthly');
  assert.equal(tiny.slice.length, 3);
  assert.equal(tiny.note, 'monthly - 3 latest');
});

test('etWallToMs: New York wall time → instant, in both seasons and on the DST-change day', () => {
  const d = loadData();
  assert.equal(d.etWallToMs('2026-10-14', 8 * 60), at('2026-10-14T12:00:00Z'));
  assert.equal(d.etWallToMs('2026-12-14', 8 * 60), at('2026-12-14T13:00:00Z'));
  assert.equal(d.etWallToMs('2026-10-14', 8 * 60, 30), at('2026-10-14T12:00:30Z'));
  assert.equal(d.etWallToMs('2026-03-08', 3 * 60 + 30), at('2026-03-08T07:30:00Z'), '03:30 EDT after the spring change');
  assert.equal(d.etWallToMs('2026-03-08', 60 + 30), at('2026-03-08T06:30:00Z'), '01:30 EST before it');
  assert.equal(d.etWallToMs('2026-11-01', 12 * 60), at('2026-11-01T17:00:00Z'), 'noon EST after the autumn change');
});

test('etWallToMs does not refuse an impossible stamp itself — the caller reads it back through etClock and sees it move', () => {
  const d = loadData();
  const back = (iso, min) => d.etClock(new Date(d.etWallToMs(iso, min)));
  const feb30 = back('2026-02-30', 9 * 60);
  assert.notEqual(feb30.date, '2026-02-30', 'Feb 30 lands on another day, which a read-back exposes');
  assert.equal(feb30.date, '2026-03-02');
  const h25 = back('2026-10-14', 25 * 60);
  assert.notEqual(h25.date, '2026-10-14', '25:00 lands on the next day');
  // minute 70 is a FIELD problem: 08:70 is 550 minutes after midnight, the same as 09:10, so it is the
  // caller's hour/minute fields (app.js econBarMs) that must be checked — the instant itself is 09:10
  assert.equal(back('2026-10-14', 8 * 60 + 70).minutes, 9 * 60 + 10);
});

// ── payload mapping, misc helpers ───────────────────────────────────────────
test('numOrNull: unknown is null, never 0', () => {
  const d = loadData();
  assert.equal(d.numOrNull(null), null);
  assert.equal(d.numOrNull(undefined), null);
  assert.equal(d.numOrNull(''), null);
  assert.equal(d.numOrNull('0'), 0);
  assert.equal(d.numOrNull('-1.5'), -1.5);
});

test('mapDashboardPayload: a null day-% stays null, dates are aligned across accounts, labels fall back', () => {
  const d = loadData();
  const keys = d.DESK_ACCOUNTS.map((a) => a.key);
  const [k1, k2] = [keys[0], keys[1] || 'zz-other'];
  const payload = {
    accounts: [
      { account_key: k1, nav: '1000', day_pnl: '5', total_unrl: '-2', cash: '10', as_of: '2026-10-14', created_at: '2026-10-14T22:40:00Z',
        positions: [{ sym: 'AAA', qty: 1, mkt: '10', dayPct: null, unrl: '' }, { sym: 'BBB', qty: 2, mkt: '20', dayPct: '1.5', unrl: '3' }] },
      { account_key: k2, label: null, nav: 500, day_pnl: 0, total_unrl: 0, cash: 0, as_of: '2026-10-13' },
    ],
    equity: [
      { as_of: '2026-10-13', account_key: k1, nav: 990 }, { as_of: '2026-10-13', account_key: k2, nav: 480 },
      { as_of: '2026-10-14', account_key: k1, nav: 1000 }, // k2 missing that day → the date is dropped
      { as_of: '2026-10-12', account_key: k2, nav: 470 }, { as_of: '2026-10-12', account_key: k1, nav: 980 },
    ],
  };
  const out = d.mapDashboardPayload(payload);
  assert.deepEqual([...out.labels], ['Oct 12', 'Oct 13']);
  assert.deepEqual([...out.accounts[0].equity], [980, 990]);
  assert.deepEqual([...out.accounts[1].equity], [470, 480]);
  const p = out.accounts[0].positions;
  assert.equal(p[0].dayPct, null, 'a day-% nobody could price is null, not 0');
  assert.equal(p[0].unrl, null);
  assert.equal(p[1].dayPct, 1.5);
  assert.equal(out.accounts[0].nav, 1000);
  assert.equal(out.accounts[0].syncedAt, '2026-10-14T22:40:00Z');
  assert.equal(out.accounts[1].syncedAt, null);
  assert.deepEqual([...out.accounts[1].positions], []);
  if (!keys[1]) assert.equal(out.accounts[1].label, 'Account zz-other');
  assert.equal(out.asOf, '2026-10-14');
  assert.deepEqual({ ...d.mapDashboardPayload({ accounts: [], equity: [] }), accounts: null, labels: null }, { accounts: null, labels: null, asOf: null, syncedAt: null });
});

test('regularOnly: drops pre/post bars, passes a series with no extended bars through untouched', () => {
  const d = loadData();
  const none = { t: [1, 2], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1], v: [1, 1] };
  assert.equal(d.regularOnly(none), none, 'no x flag (an older cache) keeps every bar');
  const allReg = { ...none, x: [0, 0] };
  assert.equal(d.regularOnly(allReg), allReg);
  assert.equal(d.regularOnly(null), null);
  const mixed = { t: [1, 2, 3, 4], o: [1, 2, 3, 4], h: [1, 2, 3, 4], l: [1, 2, 3, 4], c: [1, 2, 3, 4], x: [1, 0, 0, 1] };
  const r = d.regularOnly(mixed);
  assert.deepEqual([...r.t], [2, 3]);
  assert.deepEqual([...r.c], [2, 3]);
  assert.deepEqual([...r.v], [0, 0], 'missing volume reads 0');
  assert.deepEqual([...r.x], [0, 0]);
});

test('askModelLabel: exact id, a dated provider id, anything else as given', () => {
  const d = loadData();
  assert.equal(d.askModelLabel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(d.askModelLabel('claude-opus-5-5-20260301'), 'Opus 5.5');
  assert.equal(d.askModelLabel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(d.askModelLabel('claude-haiku-5-55'), 'claude-haiku-5-55', 'a prefix without the dash is not a match');
  assert.equal(d.askModelLabel('gpt-x'), 'gpt-x');
  for (const v of [null, undefined, '', 42, {}]) assert.equal(d.askModelLabel(v), '');
  assert.deepEqual([...d.ASK_MODELS.map((m) => m.id)], ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], 'cheapest first (the parity list)');
});

test('the device PIN: set and read back, Lock forgets BOTH copies, blocked storage never throws', () => {
  const d = loadData();
  assert.equal(d.deskPinDeviceGet(), null);
  d.deskPinDeviceSet('1234');
  assert.equal(d.deskPinDeviceGet(), '1234');
  assert.equal(d.localStorage.getItem('desk_pin_device_v1'), '1234');
  d.sessionStorage.setItem('desk_pin', '1234');
  d.deskPinForget();
  assert.equal(d.deskPinDeviceGet(), null);
  assert.equal(d.sessionStorage.getItem('desk_pin'), null);
  d.localStorage.setItem('desk_pin_device_v1', '');
  assert.equal(d.deskPinDeviceGet(), null, 'an empty stored PIN is no PIN');
  const boom = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  d.localStorage = boom; d.sessionStorage = boom;
  assert.equal(d.deskPinDeviceGet(), null);
  assert.doesNotThrow(() => d.deskPinDeviceSet('1'));
  assert.doesNotThrow(() => d.deskPinForget());
});

test('resolveMode: ?demo=1 forces demo; otherwise the configured backend decides', () => {
  assert.equal(loadData({ search: '?demo=1' }).resolveMode(), 'demo');
  const live = loadData({ search: '' });
  assert.equal(live.resolveMode(), live.DESK_DB.url ? 'live' : 'demo');
  assert.equal(loadData({ search: '?demo=0' }).resolveMode(), live.DESK_DB.url ? 'live' : 'demo');
  assert.equal(loadData({ search: '?demo=true' }).resolveMode(), live.DESK_DB.url ? 'live' : 'demo', 'only the exact value 1');
});
