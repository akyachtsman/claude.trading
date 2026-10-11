#!/usr/bin/env node
/* Mutation check for tools/watchlist-scan.mjs: each entry changes ONE thing in the tool's source and the tool's own `--selftest` must then
   fail. A mutant the selftest still passes is a behaviour no test pins down.

     node tools/watchlist-scan-mutants.mjs

   Entries are [name, exact text in the source, its replacement, equivalent?]. A fifth element `true` marks a mutant that cannot change
   the REPORT (its effect is covered by the next guard, or it only changes how many requests are made), listed so the count stays honest rather than hidden. The mutant is written beside
   the tool (it loads ../scripts/data.js relative to itself) and always removed afterwards; the tool itself is never edited. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tool = path.join(dir, 'watchlist-scan.mjs'), tmp = path.join(dir, '.watchlist-scan.mutant.mjs');
const orig = fs.readFileSync(tool, 'utf8');

const MUTANTS = [
  ["crossings up30 prev < not <=", "k[i - 1] <= 30 && k[i] > 30", "k[i - 1] < 30 && k[i] > 30"],
  ["crossings up30 now >= 30", "k[i] > 30 && k[i] > d[i]", "k[i] >= 30 && k[i] > d[i]"],
  ["crossings up30 red-above-yellow dropped", "k[i] > 30 && k[i] > d[i]", "k[i] > 30"],
  ["crossings up30 red above yellow flipped", "k[i] > 30 && k[i] > d[i]", "k[i] > 30 && k[i] < d[i]"],
  ["crossings down80 prev > not >=", "k[i - 1] >= 80 && k[i] < 80", "k[i - 1] > 80 && k[i] < 80"],
  ["crossings down80 now <= 80", "k[i] < 80 && k[i] < d[i]", "k[i] <= 80 && k[i] < d[i]"],
  ["crossings down80 red-below-yellow dropped", "k[i] < 80 && k[i] < d[i]", "k[i] < 80"],
  ["crossings down80 red below yellow flipped", "k[i] < 80 && k[i] < d[i]", "k[i] < 80 && k[i] > d[i]"],
  ["crossings lookback off by one", "ago < lookback; ago++", "ago <= lookback; ago++"],
  ["crossings lookback ignored", "ago < lookback; ago++", "ago < 3; ago++"],
  ["crossings i<1 guard", "if (i < 1 || k[i] == null", "if (i < 0 || k[i] == null", true],
  ["crossings null prev not guarded", "|| k[i - 1] == null || d[i] == null", "|| d[i] == null"],
  ["crossings d null not guarded", "k[i - 1] == null || d[i] == null", "k[i - 1] == null"],
  ["crossings keeps newest, not oldest", "if (!hit.up30 && ", "if ("],
  ["redStreak flat counts", "closes[i] < closes[i - 1]; i--", "closes[i] <= closes[i - 1]; i--"],
  ["redStreak up counts", "closes[i] < closes[i - 1]; i--", "closes[i] !== closes[i - 1]; i--"],
  ["redStreak stops at 2", "i >= 1 && closes[i]", "i >= 2 && closes[i]"],
  ["skippedWeekdays counts weekends", "if (w !== 0 && w !== 6) n++", "n++"],
  ["skippedWeekdays counts endpoint", "t < Date.parse(b + 'T12:00:00Z')", "t <= Date.parse(b + 'T12:00:00Z')"],
  ["skippedWeekdays starts at a", "Date.parse(a + 'T12:00:00Z') + 864e5; t <", "Date.parse(a + 'T12:00:00Z'); t <"],
  ["describeContract call/put swapped", "m[5] === 'C' ? 'Call' : 'Put'", "m[5] === 'C' ? 'Put' : 'Call'"],
  ["describeContract strike unscaled", "+m[6] / 1000", "+m[6]"],
  ["describeContract month off by one", "MON[+m[3] - 1]", "MON[+m[3]]"],
  ["yahooSymbol keeps padding", "String(s).replace(/\\s+/g, '').replace", "String(s).replace"],
  ["yahooSymbol dot kept", ".replace(/^([A-Z]+)\\.([A-Z])$/, '$1-$2')", ""],
  ["dropFormingBar never drops", "last.date === ny.day && ny.mins < SETTLE_MIN ? rows.slice(0, -1)", "false ? rows.slice(0, -1)"],
  ["dropFormingBar always drops today", "last.date === ny.day && ny.mins < SETTLE_MIN", "last.date === ny.day"],
  ["dropFormingBar settle off", "const SETTLE_MIN = 16 * 60 + 15;", "const SETTLE_MIN = 16 * 60;"],
  ["dropFormingBar ignores date", "last && last.date === ny.day && ny.mins", "last && ny.mins"],
  ["fullBars allows zero", "Number.isFinite(n) && n > 0));   // desk-charts", "Number.isFinite(n) && n >= 0));   // desk-charts"],
  ["fullBars allows negative", "Number.isFinite(n) && n > 0));   // desk-charts", "Number.isFinite(n)));   // desk-charts"],
  ["fullBars checks close only", "[x.o, x.h, x.l, x.c].every", "[x.c].every"],
  ["fullBars skips open", "[x.o, x.h, x.l, x.c].every", "[x.h, x.l, x.c].every"],
  ["fullBars skips high", "[x.o, x.h, x.l, x.c].every", "[x.o, x.l, x.c].every"],
  ["fullBars skips low", "[x.o, x.h, x.l, x.c].every", "[x.o, x.h, x.c].every"],
  ["barsNeeded ignores lookback", "+ (lookback - 1);", "+ 0;"],
  ["barsNeeded off by one", "cfg.d - 2 + (lookback - 1)", "cfg.d - 1 + (lookback - 1)"],
  ["prepareRows uses raw rows", "const rows = b.rows ? fullBars(b.rows) : null", "const rows = b.rows || null"],
  ["prepareRows min off by one", "rows.length < need ? {", "rows.length < need - 1 ? {"],
  ["prepareRows error masked", "{ why: b.error || `under", "{ why: `under"],
  ["buildScans pane ignored", "pane === 2 ? dash.STOCH : dash.WSTOCH", "dash.WSTOCH"],
  ["buildScans unpriced dropped", "if (prep.why) unpriced.push({ symbol: sym, why: prep.why });\n    else ready.push", "if (prep.why) {}\n    else ready.push"],
  ["buildScans scan failure dropped", "unpriced.push({ symbol: sym, why: one.why }); continue;", "continue;"],
  ["scanOrReason rethrows", "catch (e) { return { why: 'could not be read: '", "catch (e) { throw e; return { why: 'could not be read: '"],
  ["roundBars not rounded", "o: +x.o.toFixed(2), h: +x.h.toFixed(2), l: +x.l.toFixed(2), c: +x.c.toFixed(2)", "o: x.o, h: x.h, l: x.l, c: x.c"],
  ["roundBars close unrounded", "c: +x.c.toFixed(2) }));", "c: x.c }));"],
  ["partitionBySession keeps all", "onSession: scans.filter(x => x.r.asOf === newest)", "onSession: scans"],
  ["partitionBySession stale dropped", "scans.filter(x => x.r.asOf !== newest).map", "[].map"],
  ["isStaleBar never", "!!newest && last < newest", "false"],
  ["isStaleBar <=", "!!newest && last < newest", "!!newest && last <= newest"],
  ["classify min bars off by one", "if (rows.length < minStreak + 1) return", "if (rows.length < minStreak) return"],
  ["classify fetch error reason dropped", "why: b.error || (all.length", "why: (all.length"],
  ["classify stale check removed", "if (isStaleBar(last, newest)) return", "if (false) return"],
  ["classify stale streak not reported", "lastBar: last, redDaysThen: streak", "lastBar: last, redDaysThen: 0"],
  ["classify min streak off by one", "if (streak < minStreak) return", "if (streak < minStreak - 1) return"],
  ["classify min streak ignored", "if (streak < minStreak) return { kind: 'none' };", ""],
  ["classify span too short", "rows.slice(-(streak + 1))", "rows.slice(-streak)"],
  ["classify dayPct from wrong bar", "c[c.length - 1] / c[c.length - 2] - 1", "c[c.length - 1] / c[0] - 1"],
  ["classify caution dropped", "...(skipped ? { caution:", "...(false ? { caution:"],
  ["classify caution always", "...(skipped ? { caution:", "...(true ? { caution:"],
  ["classify contract dropped from streak", "kind: 'streak', rec: { symbol: sym, contract: describeContract(sym),", "kind: 'streak', rec: { symbol: sym,"],
  ["fileHolding drops stale", "else if (h.kind === 'stale') holdings.stale.push(h.rec);", ""],
  ["fileHolding drops unpriced", "else if (h.kind === 'unpriced') holdings.unpriced.push(h.rec);", ""],
  ["fileHolding drops streak", "if (h.kind === 'streak') holdings.redStreak.push(h.rec);", "if (false) holdings.redStreak.push(h.rec);"],
  ["fileHolding stale into streak", "else if (h.kind === 'stale') holdings.stale.push(h.rec);", "else if (h.kind === 'stale') holdings.redStreak.push(h.rec);"],
  ["fileHit all latest", "h.ago === 0 ? 'latest' : 'earlier'", "'latest'"],
  ["fileHit all earlier", "h.ago === 0 ? 'latest' : 'earlier'", "'earlier'"],
  ["scanSymbol pane ignored", "p1: pane === 2 ? swing : long, p2: pane === 2 ? long : swing", "p1: long, p2: swing"],
  ["scanSymbol rounds not", "readings(dash, roundBars(rawRows), pane)", "readings(dash, rawRows, pane)"],
  ["scanSymbol crossedOn wrong bar", "crossedOn: R.s.t[j]", "crossedOn: R.s.t[i]"],
  ["scanSymbol kBefore wrong bar", "kBefore: R.r2(R.p1.k[j - 1])", "kBefore: R.r2(R.p1.k[i - 1])"],
  ["scanSymbol kAtCross wrong bar", "kAtCross: R.r2(R.p1.k[j])", "kAtCross: R.r2(R.p1.k[i])"],
  ["scanSymbol dAtCross wrong bar", "dAtCross: R.r2(R.p1.d[j])", "dAtCross: R.r2(R.p1.d[i])"],
  ["scanSymbol kNow wrong bar", "kNow: R.r2(R.p1.k[i])", "kNow: R.r2(R.p1.k[j])"],
  ["scanSymbol dNow wrong bar", "dNow: R.r2(R.p1.d[i])", "dNow: R.r2(R.p1.d[j])"],
  ["scanSymbol close wrong bar", "close: R.r2(R.s.c[i])", "close: R.r2(R.s.c[j])"],
  ["scanSymbol dayPct wrong base", "R.s.c[i] / R.s.c[i - 1] - 1", "R.s.c[i] / R.s.c[0] - 1"],
  ["scanSymbol asOf wrong", "return { asOf: R.s.t[i], hits }", "return { asOf: R.s.t[0], hits }"],
  ["scanSymbol sessionsAgo wrong", "sessionsAgo: h.ago,", "sessionsAgo: 0,"],
  ["scanSymbol other pane = same pane", "otherPaneK: R.r2(R.p2.k[i])", "otherPaneK: R.r2(R.p1.k[i])"],
  ["r2 nonfinite not null", "(v == null || !isFinite(v) ? null :", "(false ? null :"],
  ["dominantSession tie goes to the earlier date", "(c === n.get(best) && d > best)", "(c === n.get(best) && d < best)"],
  ["dominantSession takes the newest date, not the most common", "c > n.get(best) || (c === n.get(best) && d > best)", "d > best"],
  ["dominantSession takes the oldest date", "c > n.get(best) || (c === n.get(best) && d > best)", "d < best"],
  ["buildScans never cuts a 24/7 asset back to the session", "const rows = all.filter(x => x.date <= session);", "const rows = all;"],
  ["buildScans cuts the session day itself", "all.filter(x => x.date <= session)", "all.filter(x => x.date < session)"],
  ["buildScans skips the length check after the cut", "if (rows.length < need) { unpriced.push", "if (false) { unpriced.push"],
  ["buildScans session not reported", "return { scans, unpriced, session, ahead };", "return { scans, unpriced, session: null, ahead };"],
  ["buildScans reason loses the session", "under ${need} bars as of ${session}", "under ${need} bars"],
  ["hasClose allows a zero close", "Number.isFinite(x.c) && x.c > 0;", "Number.isFinite(x.c) && x.c >= 0;"],
  ["hasClose allows a negative close", "Number.isFinite(x.c) && x.c > 0;", "Number.isFinite(x.c);"],
  ["chartRows keeps every row", "if (hasClose(row)) rows.push(row);", "rows.push(row);"],
  ["chartRows dates by UTC", "date: nyParts(when).day", "date: when.toISOString().slice(0, 10)"],
  ["classify empty rows not guarded", "if (!rows.length) return { kind: 'unpriced'", "if (false) return { kind: 'unpriced'"],
  ["coverageError passes an empty roster", "if (!requested) return", "if (false) return"],
  ["coverageError threshold <=", "scanned / requested < MIN_PRICED", "scanned / requested <= MIN_PRICED"],
  ["coverageError never fails on coverage", "if (scanned / requested < MIN_PRICED) return", "if (false) return"],
  ["coverageError message loses the counts", "`only ${scanned} of ${requested} symbols priced on the latest session`", "'too few symbols priced'"],
  ["verdict ignores the coverage verdict", "const errors = [coverageError(out.requested, out.scanned)];", "const errors = [null];"],
  ["chartRows keeps a bar with a junk timestamp", "if (!Number.isFinite(secs) || !Number.isFinite(when.getTime())) return;", "if (false) return;"],
  ["chartRows lets an out-of-range timestamp through", "|| !Number.isFinite(when.getTime())) return;", ") return;"],
  ["chartRows reads a null timestamp as 1970", "const secs = t == null ? NaN : Number(t)", "const secs = Number(t)"],
  ["verdict stale limit 5 -> 6", "out.staleDays > 5", "out.staleDays > 6"],
  ["verdict stale limit 5 -> 4", "out.staleDays > 5", "out.staleDays > 4"],
  ["verdict never fails on a stale bar", "if (out.staleDays != null && out.staleDays > 5) errors.push(", "if (false) errors.push("],
  ["verdict staleDays from the wrong end", "Math.round((now - new Date(out.newestBar + 'T12:00:00Z')) / 864e5)", "Math.round((new Date(out.newestBar + 'T12:00:00Z') - now) / 864e5)"],
  ["attemptTimeout ignores the budget", "Math.min(20000, deadline - now)", "20000"],
  ["attemptTimeout ignores Yahoo's 20 s", "Math.min(20000, deadline - now)", "deadline - now"],
  ["rosterLimitError edge >=", "n > MAX_SYMBOLS ?", "n >= MAX_SYMBOLS ?"],
  ["roster limit raised", "const MAX_SYMBOLS = 1000;", "const MAX_SYMBOLS = 5000;"],
  ["main skips the roster cap", "if (tooMany) {", "if (false) {"],
  ["bars ignores the run budget", "if (left <= 0) return { error: 'run time limit reached' };", ""],
  ["bars requests always get 20 s", "signal: AbortSignal.timeout(left)", "signal: AbortSignal.timeout(20000)"],
  ["bars sleeps past the deadline", "await sleep(Math.max(0, Math.min(1500 * (a + 1), deadline - Date.now())))", "await sleep(1500 * (a + 1))"],
  ["sessionCalendar tie excluded", "c * 2 >= datesPerSymbol.length", "c * 2 > datesPerSymbol.length"],
  ["sessionCalendar counts dates after the session", "if (d <= session) n.set(d,", "n.set(d,"],
  ["sessionCalendar counts a symbol's repeats", "for (const d of new Set(dates))", "for (const d of dates)"],
  ["sessionsSince counts the date itself", "d > date && d <= session", "d >= date && d <= session"],
  ["sessionsSince counts past the session", "d > date && d <= session", "d > date"],
  ["realignHits keeps the bar count", "Math.max(h.ago, sessionsSince(calendar, h.rec.crossedOn, session))", "h.ago"],
  ["realignHits trusts the calendar alone", "Math.max(h.ago, sessionsSince(calendar, h.rec.crossedOn, session))", "sessionsSince(calendar, h.rec.crossedOn, session)"],
  ["realignHits keeps hits outside the window", ".filter(h => h.ago < lookback)", ""],
  ["realignHits leaves the record's age stale", "rec: { ...h.rec, sessionsAgo: ago }", "rec: h.rec"],
  ["buildScans never realigns", "hits: realignHits(one.r.hits, calendar, session, lookback)", "hits: one.r.hits"],
  ["isWeekend misses Sunday", "w === 0 || w === 6", "w === 6"],
  ["isWeekend misses Saturday", "w === 0 || w === 6", "w === 0"],
  ["ahead counts a 24/7 asset's weekend bar", "x.date > session && !isWeekend(x.date)", "x.date > session"],
  ["ahead counts the session itself", "x.date > session && !isWeekend(x.date)", "x.date >= session && !isWeekend(x.date)"],
  ["ahead is never counted", "const ahead = ready.filter(", "const ahead = 0 * ready.filter("],
  ["ahead limit loosened", "const MAX_AHEAD = 0.1;", "const MAX_AHEAD = 0.5;"],
  ["ahead limit removed", "const MAX_AHEAD = 0.1;", "const MAX_AHEAD = 1;"],
  ["verdict ignores the lagging cohort", "if (out.requested && (out.ahead || 0) / out.requested > MAX_AHEAD)", "if (false)"],
  ["verdict keeps only the last problem", "out.error = bad.join('; ')", "out.error = bad[bad.length - 1]"],
  ["holdingsChecked ignores stale", "h.requested - h.stale.length - h.unpriced.length", "h.requested - h.unpriced.length"],
  ["holdingsChecked ignores unpriced", "h.requested - h.stale.length - h.unpriced.length", "h.requested - h.stale.length"],
  ["buildReport drops the lagging cohort", "out.ahead = built.ahead;", "out.ahead = 0;"],
  ["buildReport drops the unpriced list", "out.unpriced.push(...built.unpriced);", ""],
  ["buildReport forgets the verdict", "  verdict(out, now);\n  return out;", "  return out;"],
  ["buildReport files everything as latest", "for (const x of part.onSession) for (const h of x.r.hits) fileHit(out, h);", "for (const x of part.onSession) for (const h of x.r.hits) fileHit(out, { ...h, ago: 0 });"],
  ["buildReport leaves hits unsorted", "out[k][w].sort((a, b) => a.symbol.localeCompare(b.symbol));", "out[k][w].sort(() => 0);"],
  ["buildHoldings forgets the checked count", "h.checked = holdingsChecked(h);", ""],
  ["buildHoldings sorts shortest first", "b.redDays - a.redDays || a.symbol.localeCompare(b.symbol)", "a.redDays - b.redDays || a.symbol.localeCompare(b.symbol)"],
  ["buildHoldings ignores the reference session", "referenceSession: newest", "referenceSession: null"],
  ["ahead looks only at the newest bar", "rows.some(x => x.date > session && !isWeekend(x.date))", "(x => x.date > session && !isWeekend(x.date))(rows[rows.length - 1])"],
  ["chartRows keeps Yahoo's order", "return rows.sort((a, b) => a.date.localeCompare(b.date));", "return rows;"],
  ["chartRows sorts newest first", "a.date.localeCompare(b.date));\n}", "b.date.localeCompare(a.date));\n}"],
  ["classifyHolding keeps bars after the session", "rows = all.filter(x => x.date <= newest);", "rows = all;"],
  ["classifyHolding cuts the session day itself", "all.filter(x => x.date <= newest)", "all.filter(x => x.date < newest)"],
  ["classifyHolding loses the as-of date in its reason", "`no bars as of ${newest}`", "'no bars'"],
  ["classifyHolding evaluates with no report session", "if (!newest) return { kind: 'unpriced'", "if (false) return { kind: 'unpriced'"],
  ["classifyHolding no-session reason lost", "why: 'no report session: the watchlist could not be priced' } };\n  const all", "why: 'no bars' } };\n  const all"],
  ["fetchHoldings fetches even with no report session", "if (!newest) return list.map(sym => [sym, { error: 'not fetched: no report session' }]);", ""],
  ["fetchHoldings never fetches", "return pool(list, 8, async sym => [sym, await fetchOne(sym)]);", "return list.map(sym => [sym, { error: 'x' }]);"],
  ["main skips fetchHoldings", "const H = await fetchHoldings(list, out.newestBar, sym", "const H = await fetchHoldings(list, 'x', sym", true],   // changes only how many requests are made, never the report (fetchHoldings's own check pins the skip)
];

let caught = 0, equivalent = 0; const bad = [];
try {
  for (const [name, from, to, eq] of MUTANTS) {
    const n = orig.split(from).length - 1;
    if (n !== 1) { bad.push(`${name}: the text to change matches ${n} times, expected 1`); continue; }
    fs.writeFileSync(tmp, orig.replace(from, () => to));
    const r = spawnSync(process.execPath, [tmp, '--selftest'], { encoding: 'utf8', timeout: 60000 });
    const failed = r.status !== 0 || /FAIL/.test(r.stdout) || !/all passed/.test(r.stdout);
    if (eq) { equivalent++; if (failed) bad.push(`${name}: marked equivalent but the selftest caught it - drop the mark`); }
    else if (failed) caught++;
    else bad.push(`${name}: SURVIVED - the selftest still passes`);
  }
} finally { fs.rmSync(tmp, { force: true }); }
console.log(`${MUTANTS.length} mutants: ${caught} caught, ${equivalent} equivalent (cannot change the report)${bad.length ? ', ' + bad.length + ' problem(s)' : ''}`);
for (const b of bad) console.log('  ' + b);
process.exit(bad.length ? 1 : 0);
