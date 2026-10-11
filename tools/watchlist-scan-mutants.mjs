#!/usr/bin/env node
/* Mutation check for tools/watchlist-scan.mjs: each entry changes ONE thing in the tool's source and the tool's own `--selftest` must then
   fail. A mutant the selftest still passes is a behaviour no test pins down.

     node tools/watchlist-scan-mutants.mjs

   Entries are [name, exact text in the source, its replacement, equivalent?]. A fifth element `true` marks a mutant that cannot change
   behaviour (its effect is covered by the next guard), listed so the count stays honest rather than hidden. The mutant is written beside
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
  ["buildScans unpriced dropped", "unpriced.push({ symbol: sym, why: prep.why }); continue;", "continue;"],
  ["buildScans scan failure dropped", "unpriced.push({ symbol: sym, why: one.why }); continue;", "continue;"],
  ["scanOrReason rethrows", "catch (e) { return { why: 'could not be read: '", "catch (e) { throw e; return { why: 'could not be read: '"],
  ["roundBars not rounded", "o: +x.o.toFixed(2), h: +x.h.toFixed(2), l: +x.l.toFixed(2), c: +x.c.toFixed(2)", "o: x.o, h: x.h, l: x.l, c: x.c"],
  ["roundBars close unrounded", "c: +x.c.toFixed(2) }));", "c: x.c }));"],
  ["partitionBySession keeps all", "scans.filter(x => x.r.asOf === newest)", "scans"],
  ["partitionBySession newest = oldest", ".sort().pop()", ".sort().shift()"],
  ["partitionBySession stale dropped", "scans.filter(x => x.r.asOf !== newest).map", "[].map"],
  ["isStaleBar never", "!!newest && last < newest", "false"],
  ["isStaleBar <=", "!!newest && last < newest", "!!newest && last <= newest"],
  ["classify min bars off by one", "b.rows.length < minStreak + 1", "b.rows.length < minStreak"],
  ["classify too-few reason dropped", "why: b.error || 'too few bars'", "why: 'too few bars'"],
  ["classify stale check removed", "if (isStaleBar(last, newest)) return", "if (false) return"],
  ["classify stale streak not reported", "lastBar: last, redDaysThen: streak", "lastBar: last, redDaysThen: 0"],
  ["classify min streak off by one", "if (streak < minStreak) return", "if (streak < minStreak - 1) return"],
  ["classify min streak ignored", "if (streak < minStreak) return { kind: 'none' };", ""],
  ["classify span too short", "b.rows.slice(-(streak + 1))", "b.rows.slice(-streak)"],
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
console.log(`${MUTANTS.length} mutants: ${caught} caught, ${equivalent} equivalent (cannot change behaviour)${bad.length ? ', ' + bad.length + ' problem(s)' : ''}`);
for (const b of bad) console.log('  ' + b);
process.exit(bad.length ? 1 : 0);
