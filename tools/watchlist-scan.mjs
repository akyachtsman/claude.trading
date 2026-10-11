#!/usr/bin/env node
/* The morning scan: which watchlist stocks just crossed a Pro 1 line, and which holdings have a run of red days.

     node tools/watchlist-scan.mjs                       # whole roster, prints JSON
     node tools/watchlist-scan.mjs --pane=2              # the SWING pane (Pro 2, 14-3-3) instead of Pro 1 (the default)
     node tools/watchlist-scan.mjs --symbols=AAPL,MSFT   # just these (no roster call)
     node tools/watchlist-scan.mjs --holdings=file.json  # also: trailing red-day runs for a JSON array of symbols
     node tools/watchlist-scan.mjs --selftest            # the checks below, no network

   Why this exists (owner 2026-10-11): the Ask-the-desk assistant reads one symbol per tool call and a turn is capped at
   12 of them, so "all watchlist stocks crossing ..." came back as a partial scan of the first names. This computes every
   symbol in one go (~240 in ~15 s) and hands a short, exact table to whoever writes the report.

   The math is the DASHBOARD'S OWN: `stochSeries` and `rsiSeries` are loaded out of scripts/data.js, so a reading here is
   the number Pro 1 / Pro 2 draw — it cannot drift from a second copy. Pro 1 is the LONG-TERM pane, the 92-15-15 slow
   stochastic on daily bars (WSTOCH); %K is the red line, %D the yellow one, and its strip draws its lines at 30 and 80.

   `--pane=2` runs the same two definitions on Pro 2, the SWING pane (14-3-3, daily). Pro 1 is the default because that is what
   the owner's scheduled questions say; the Ask-the-desk answers to them have been reading the swing pane instead.

   Definitions (the owner's own scheduled questions):
     up30    %K was at or under 30 on the previous bar and is over 30 now, with %K above %D     ("crossing up 30 ... red above yellow")
     down80  %K was at or over 80 on the previous bar and is under 80 now, with %K below %D     ("crossing down 80 ... red below yellow")
   `latest` = it happened on the last COMPLETED session; `earlier` = on one of the two sessions before it (so a morning that
   was skipped — a holiday, an outage — does not silently lose a crossing).

   COMPLETED sessions only: a bar dated today is dropped while the NYSE session is open or settling (before 16:15 ET), the
   same "last completed session" read the dashboard's scheduled asks give. A 7:00 AM Pacific run is 10:00 ET, mid-session.

   Untrusted input: the roster is writable by anyone holding the site's public key (an accepted residual, see CLAUDE.md), so
   only regex-validated TICKERS leave this script — never a list title or any free text — the same rule desk-ask applies.
   Holdings are passed in by the caller at run time and are never stored here; nothing about money is read or printed.

   Exit codes: 0 ok, 2 the roster could not be read, 3 too few symbols priced to trust the answer (JSON still printed with
   ok:false — "no crossings" must never be what a broken data feed looks like). */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TICKER_RE = /^[A-Z0-9.^=-]{1,10}$/;          // app.js WL_SYM_RE / desk-ask TICKER_RE
const HOLDING_RE = /^[A-Z0-9.^=-]{1,24}$/;         // an OCC option symbol is longer than a ticker
const MIN_PRICED = 0.9;                            // fraction of the roster that must price, or the run says ok:false
const SETTLE_MIN = 16 * 60 + 15;                   // ET minutes: before this, a bar dated today is still forming
const UA = 'Mozilla/5.0';                          // Yahoo wants one; never sent to Supabase (see CLAUDE.md)

/* ── the dashboard's own math ─────────────────────────────────────────────── */
function loadDashboard() {
  const stub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const ctx = { console, Intl, Date, Math, JSON, window: {}, document: {}, location: { search: '' }, navigator: {}, localStorage: stub, sessionStorage: stub };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts/data.js'), 'utf8') +
    '\n;globalThis.__dash = { stochSeries, rsiSeries, STOCH, WSTOCH };', ctx);
  const cfg = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts/config.js'), 'utf8') + '\n;globalThis.__db = DESK_DB;', cfg);
  return { ...ctx.__dash, db: cfg.__db };
}

/* ── pure helpers (the selftest drives these) ─────────────────────────────── */
export const yahooSymbol = s => String(s).replace(/\s+/g, '').replace(/^([A-Z]+)\.([A-Z])$/, '$1-$2');   // BRK.B -> BRK-B; OCC padding stripped

export function crossings(k, d, lookback = 3) {
  const n = k.length, hit = { up30: null, down80: null };
  for (let ago = 0; ago < lookback; ago++) {
    const i = n - 1 - ago;
    if (i < 1 || k[i] == null || k[i - 1] == null || d[i] == null) continue;
    if (!hit.up30 && k[i - 1] <= 30 && k[i] > 30 && k[i] > d[i]) hit.up30 = { ago };
    if (!hit.down80 && k[i - 1] >= 80 && k[i] < 80 && k[i] < d[i]) hit.down80 = { ago };
  }
  return hit;
}

export function redStreak(closes) {
  let n = 0;
  for (let i = closes.length - 1; i >= 1 && closes[i] < closes[i - 1]; i--) n++;
  return n;
}

/* Weekdays that fall strictly between two bar dates ('YYYY-MM-DD'). A thinly traded option has no bar on a day it never traded,
   so "3 red days" across a hole is not 3 consecutive sessions; weekends are not holes (holidays can read as one: a harmless false caution). */
export function skippedWeekdays(a, b) {
  let n = 0;
  for (let t = Date.parse(a + 'T12:00:00Z') + 864e5; t < Date.parse(b + 'T12:00:00Z'); t += 864e5) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function describeContract(sym) {            // OCC: root + YYMMDD + C/P + strike*1000 (8 digits)
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym);
  return m ? `${m[1]} ${MON[+m[3] - 1]} ${+m[4]} 20${m[2]} ${+m[6] / 1000} ${m[5] === 'C' ? 'Call' : 'Put'}` : null;
}

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function nyParts(date) {
  const p = Object.fromEntries(NY.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute };
}
export function dropFormingBar(rows, now = new Date()) {
  const ny = nyParts(now), last = rows[rows.length - 1];
  return last && last.date === ny.day && ny.mins < SETTLE_MIN ? rows.slice(0, -1) : rows;
}

/* ── network ──────────────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bars(symbol, now) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSymbol(symbol)) + '?range=2y&interval=1d';
  let err = 'no answer';
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return { error: 'unknown to Yahoo' };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let rows = chartRows((await r.json()).chart.result[0]);
      rows = dropFormingBar(rows, now);
      return rows.length ? { rows } : { error: 'no bars' };
    } catch (e) { err = String(e.message || e).slice(0, 60); await sleep(1500 * (a + 1)); }
  }
  return { error: err };
}
async function pool(items, size, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]); }));
  return out;
}
async function roster(db) {
  const r = await fetch(db.url + '/rest/v1/rpc/desk_get_watchlists_open', {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: db.anonKey, authorization: 'Bearer ' + db.anonKey },
    body: '{}', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('roster RPC HTTP ' + r.status);
  const j = await r.json();
  if (!j || j.ok === false || !Array.isArray(j.lists)) throw new Error('roster RPC returned no lists');
  const raw = [...new Set(j.lists.flatMap(l => (Array.isArray(l.symbols) ? l.symbols : [])).map(s => String(s).toUpperCase()))];
  const symbols = raw.filter(s => TICKER_RE.test(s));
  return { symbols, lists: j.lists.length, rejected: raw.length - symbols.length };   // titles are never read out
}

/* ── the scan ─────────────────────────────────────────────────────────────── */
/* A scan needs all four prices of a bar, each finite and above zero: the dashboard's parser (`parseYahooChartOHLC`) drops any other row, and a
   null open would otherwise throw in roundBars and abort the whole run (Codex, PR #321). Holdings need only the close and do not go through this. */
/* Yahoo's chart result -> dated bars. Holdings need only a good close, so that is all this keeps; a scan demands all four prices on top (fullBars). */
export function chartRows(res) {
  const q = res.indicators.quote[0];
  return res.timestamp.map((t, i) => ({ date: nyParts(new Date(t * 1000)).day, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 })).filter(hasClose);
}
/* A usable close: finite and above zero (a zero is a sentinel, and `[6, 5, 4, 0]` would otherwise read as a 3-day losing streak ending -100%). */
export const hasClose = x => Number.isFinite(x.c) && x.c > 0;
export const fullBars = rows => rows.filter(x => [x.o, x.h, x.l, x.c].every(n => Number.isFinite(n) && n > 0));   // desk-charts: `Number.isFinite(n) && n > 0` (a zero is a sentinel, not a price)

/* Bars a symbol needs before a crossing can be judged on each of the last `lookback` sessions. %D first has a value at bar k+kSmooth+d-2
   (92-15-15: the 120th), and the OLDEST session examined needs one too: 120 for the latest session alone, 122 for three (Codex, PR #321). */
export const barsNeeded = (cfg, lookback) => cfg.k + cfg.kSmooth + cfg.d - 2 + (lookback - 1);

/* Fetched bars -> the bars a scan may use, or the reason it cannot (incomplete rows do not count toward the minimum). */
export function prepareRows(b, cfg, lookback) {
  const rows = b.rows ? fullBars(b.rows) : null, need = barsNeeded(cfg, lookback);
  return !rows || rows.length < need ? { why: b.error || `under ${need} bars` } : { rows };
}

/* The report's session is the date most symbols' newest bar falls on (ties go to the later date), NOT the newest bar any symbol has: a 24/7
   asset in the roster (BTC-USD is in the default roster) still has Sunday's bar on a Monday morning while US equities end on Friday, and taking
   the maximum would make Sunday the session, mark every equity stale and fail the coverage check every Monday (Codex, PR #321). */
export function dominantSession(dates) {
  const n = new Map();
  for (const d of dates) n.set(d, (n.get(d) || 0) + 1);
  let best = null;
  for (const [d, c] of n) if (best === null || c > n.get(best) || (c === n.get(best) && d > best)) best = d;
  return best;
}

/* The fetched results -> the scans that stand, and the symbols that could not be scanned with why. Nothing here throws.
   A symbol whose bars run PAST the report session (a 24/7 asset) is read as of that session: its newer bars are cut, so it is scanned on the
   same completed session as everything else rather than excluded. */
export function buildScans(results, dash, pane, lookback) {
  const cfg = pane === 2 ? dash.STOCH : dash.WSTOCH, scans = [], unpriced = [], ready = [];
  const need = barsNeeded(cfg, lookback);
  for (const [sym, b] of results) {
    const prep = prepareRows(b, cfg, lookback);
    if (prep.why) unpriced.push({ symbol: sym, why: prep.why });
    else ready.push([sym, prep.rows]);
  }
  const session = dominantSession(ready.map(([, rows]) => rows[rows.length - 1].date));
  for (const [sym, all] of ready) {
    const rows = all.filter(x => x.date <= session);
    if (rows.length < need) { unpriced.push({ symbol: sym, why: `under ${need} bars as of ${session}` }); continue; }
    const one = scanOrReason(dash, sym, rows, pane, lookback);
    if (one.why) { unpriced.push({ symbol: sym, why: one.why }); continue; }
    scans.push({ sym, r: one.r });
  }
  return { scans, unpriced, session };
}

/* One symbol's scan that cannot take the run down with it: whatever it throws becomes a reason, listed beside the unpriced. */
export function scanOrReason(dash, sym, rows, pane, lookback) {
  try { return { r: scanSymbol(dash, sym, rows, pane, lookback) }; }
  catch (e) { return { why: 'could not be read: ' + String((e && e.message) || e).slice(0, 50) }; }
}

/* The dashboard computes on bars rounded to two decimals: desk-charts' packSeries does `+r.o.toFixed(2)` on open/high/low/close
   before the chart or the scheduled ask ever sees them. A crossing within a cent of 30/80, or %K within a cent of %D, can flip on
   raw floats, so the scan rounds the same way (Codex, PR #321). Holdings are NOT rounded: a $0.25 option moves in sub-cent steps. */
export const roundBars = rows => rows.map(x => ({ ...x, o: +x.o.toFixed(2), h: +x.h.toFixed(2), l: +x.l.toFixed(2), c: +x.c.toFixed(2) }));

/* A symbol's newest bar must be the report's session. Yahoo can omit the latest session for a few symbols (a halt, a thin name); their
   final bar is older, and "crossed on the last session" would then be said of an older day (Codex, PR #321). Those are listed, not scanned. */
export function partitionBySession(scans, newest) {
  return { newest: newest || null, onSession: scans.filter(x => x.r.asOf === newest), stale: scans.filter(x => x.r.asOf !== newest).map(x => ({ symbol: x.sym, lastBar: x.r.asOf })) };
}
export const isStaleBar = (last, newest) => !!newest && last < newest;

/* What one holding's bars say. A holding whose last bar predates the report session is ALWAYS listed as stale, with the red days it had as of
   that bar, whether or not they make a streak: it could not be checked through the session, and "none has 3 red days" must not be said of it
   (Codex, PR #321). Only a current holding can be a streak. */
export function classifyHolding(sym, b, newest, minStreak) {
  if (!b.rows || !b.rows.length) return { kind: 'unpriced', rec: { symbol: sym, why: b.error || 'no bars' } };
  const r2 = v => Math.round(v * 100) / 100, c = b.rows.map(x => x.c), streak = redStreak(c), last = b.rows[b.rows.length - 1].date;
  if (isStaleBar(last, newest)) return { kind: 'stale', rec: { symbol: sym, contract: describeContract(sym), lastBar: last, redDaysThen: streak } };
  if (b.rows.length < minStreak + 1) return { kind: 'unpriced', rec: { symbol: sym, why: 'too few bars' } };
  if (streak < minStreak) return { kind: 'none' };
  const span = b.rows.slice(-(streak + 1)), skipped = span.reduce((n, x, ix) => n + (ix ? skippedWeekdays(span[ix - 1].date, x.date) : 0), 0);
  return { kind: 'streak', rec: { symbol: sym, contract: describeContract(sym), redDays: streak, asOf: last, closes: span.map(x => r2(x.c)), lastDayPct: r2((c[c.length - 1] / c[c.length - 2] - 1) * 100),
    ...(skipped ? { caution: `${skipped} weekday(s) in this run have no bar (no trades), so these are not consecutive sessions` } : {}) } };
}

/* File one classified holding in its list. A holding is never dropped: current streaks, stale ones and unpriced ones each have a list; only "none" is nothing. */
export function fileHolding(holdings, h) {
  if (h.kind === 'streak') holdings.redStreak.push(h.rec);
  else if (h.kind === 'stale') holdings.stale.push(h.rec);
  else if (h.kind === 'unpriced') holdings.unpriced.push(h.rec);
  return holdings;
}

function readings(dash, rows, pane) {
  const s = { t: rows.map(x => x.date), o: rows.map(x => x.o), h: rows.map(x => x.h), l: rows.map(x => x.l), c: rows.map(x => x.c), v: rows.map(x => x.v) };
  const n = s.c.length, r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
  const long = dash.stochSeries(s, dash.WSTOCH), swing = dash.stochSeries(s, dash.STOCH), rsi = dash.rsiSeries(s);
  return { s, n, p1: pane === 2 ? swing : long, p2: pane === 2 ? long : swing, rsi, r2 };   // p1 = the pane being scanned, p2 = the other one
}

export const fileHit = (out, h) => out[h.kind][h.ago === 0 ? 'latest' : 'earlier'].push(h.rec);

/* One symbol's crossings on the pane being scanned. `dash` is the dashboard's math (or, in the selftest, a stand-in for it). */
export function scanSymbol(dash, sym, rawRows, pane, lookback) {
  const R = readings(dash, roundBars(rawRows), pane), i = R.n - 1, hits = [], hit = crossings(R.p1.k, R.p1.d, lookback);
  for (const [kind, h] of [['up30', hit.up30], ['down80', hit.down80]]) {
    if (!h) continue;
    const j = i - h.ago;       // the bar the cross happened on; for an `earlier` hit the readings AT it and NOW differ, and both are reported
    hits.push({ kind, ago: h.ago, rec: {
      symbol: sym, crossedOn: R.s.t[j], sessionsAgo: h.ago,
      kBefore: R.r2(R.p1.k[j - 1]), kAtCross: R.r2(R.p1.k[j]), dAtCross: R.r2(R.p1.d[j]),
      kNow: R.r2(R.p1.k[i]), dNow: R.r2(R.p1.d[i]), close: R.r2(R.s.c[i]), dayPct: R.r2((R.s.c[i] / R.s.c[i - 1] - 1) * 100),
      otherPaneK: R.r2(R.p2.k[i]), otherPaneD: R.r2(R.p2.d[i]), rsi: R.r2(R.rsi[i]),
    } });
  }
  return { asOf: R.s.t[i], hits };
}

async function main() {
  const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=').slice(1).join('=');
  const now = new Date(), dash = loadDashboard();
  const lookback = Math.max(1, +arg('lookback') || 3);
  const pane = arg('pane') === '2' ? 2 : 1;                       // 1 = LONG-TERM 92-15-15 (WSTOCH), 2 = SWING 14-3-3 (STOCH)
  const minStreak = Math.max(1, +arg('min-streak') || 3);

  let symbols, rosterInfo = null;
  const given = arg('symbols');
  if (given) symbols = [...new Set(given.toUpperCase().split(/[,\s]+/).filter(s => TICKER_RE.test(s)))];
  else {
    try { rosterInfo = await roster(dash.db); symbols = rosterInfo.symbols; }
    catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(2); }
  }

  const results = await pool(symbols, 8, async sym => [sym, await bars(sym, now)]);
  const out = { ok: true, pane: pane === 2 ? 'Pro 2 SWING 14-3-3' : 'Pro 1 LONG-TERM 92-15-15', generatedAt: now.toISOString(), requested: symbols.length, scanned: 0, lists: rosterInfo ? rosterInfo.lists : null,
    rejectedTickers: rosterInfo ? rosterInfo.rejected : 0, unpriced: [], stale: [],
    up30: { latest: [], earlier: [] }, down80: { latest: [], earlier: [] } };

  const built = buildScans(results, dash, pane, lookback), scans = built.scans;
  out.unpriced.push(...built.unpriced);
  const part = partitionBySession(scans, built.session);
  out.newestBar = part.newest; out.stale = part.stale; out.scanned = part.onSession.length;
  for (const x of part.onSession) for (const h of x.r.hits) fileHit(out, h);
  for (const k of ['up30', 'down80']) for (const w of ['latest', 'earlier']) out[k][w].sort((a, b) => a.symbol.localeCompare(b.symbol));
  out.staleDays = out.newestBar ? Math.round((now - new Date(out.newestBar + 'T12:00:00Z')) / 864e5) : null;
  if (out.requested && out.scanned / out.requested < MIN_PRICED) { out.ok = false; out.error = `only ${out.scanned} of ${out.requested} symbols priced on the latest session`; }
  if (out.staleDays != null && out.staleDays > 5) { out.ok = false; out.error = `newest bar is ${out.staleDays} days old`; }

  const hold = arg('holdings');
  if (hold) {
    const list = [...new Set(JSON.parse(fs.readFileSync(hold, 'utf8')).map(s => String(s).toUpperCase().replace(/\s+/g, '')).filter(s => HOLDING_RE.test(s)))];
    const H = await pool(list, 8, async sym => [sym, await bars(sym, now)]);
    out.holdings = { requested: list.length, referenceSession: out.newestBar, redStreak: [], stale: [], unpriced: [] };
    for (const [sym, b] of H) fileHolding(out.holdings, classifyHolding(sym, b, out.newestBar, minStreak));
    out.holdings.redStreak.sort((a, b) => b.redDays - a.redDays || a.symbol.localeCompare(b.symbol));
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.ok ? 0 : 3);
}

/* ── selftest ─────────────────────────────────────────────────────────────── */
function selftest() {
  let bad = 0;
  const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) { bad++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); } else console.log('ok  ', name); };
  const pad = a => [null, ...a];
  // up30: previous bar at/under 30, now over 30, red above yellow
  eq('up30 latest', crossings(pad([20, 29, 31]), pad([20, 25, 28])).up30, { ago: 0 });
  eq('up30 needs red above yellow', crossings(pad([20, 29, 31]), pad([20, 25, 35])).up30, null);
  eq('up30 touching 30 counts as the previous side', crossings(pad([20, 30, 31]), pad([20, 25, 28])).up30, { ago: 0 });
  eq('up30 must actually cross: staying over 30 is not a cross', crossings(pad([31, 32, 33]), pad([25, 26, 28])).up30, null);
  eq('up30 one session earlier', crossings(pad([29, 31, 34]), pad([25, 28, 30])).up30, { ago: 1 });
  eq('up30 two sessions earlier is still seen at lookback 3', crossings(pad([29, 31, 34, 36]), pad([25, 28, 30, 32])).up30, { ago: 2 });
  eq('up30 three sessions earlier is not', crossings(pad([29, 31, 34, 36, 38]), pad([25, 28, 30, 32, 34])).up30, null);
  // down80: previous bar at/over 80, now under 80, red below yellow
  eq('down80 latest', crossings(pad([85, 82, 78]), pad([84, 83, 80])).down80, { ago: 0 });
  eq('down80 needs red below yellow', crossings(pad([85, 82, 78]), pad([84, 83, 70])).down80, null);
  eq('down80 a cross up through 80 is not it', crossings(pad([70, 78, 82]), pad([70, 75, 80])).down80, null);
  eq('nulls never cross', crossings([null, null, 31], [null, null, 28]).up30, null);
  eq('up30 landing exactly on 30 has not crossed', crossings(pad([20, 30]), pad([20, 25])).up30, null);
  eq('down80 touching 80 on the previous bar counts', crossings(pad([80, 78]), pad([84, 80])).down80, { ago: 0 });
  eq('down80 landing exactly on 80 has not crossed', crossings(pad([85, 80]), pad([84, 83])).down80, null);
  eq('a lookback of 1 sees only the latest session', crossings(pad([29, 31, 34]), pad([25, 28, 30]), 1).up30, null);
  eq('a lookback of 2 sees one session back', crossings(pad([29, 31, 34]), pad([25, 28, 30]), 2).up30, { ago: 1 });
  eq('a missing %D never counts as a cross', crossings(pad([29, 31]), pad([null, null])).up30, null);
  eq('two crossings in the window: the NEWEST is reported', crossings(pad([29, 31, 29, 32]), pad([25, 28, 30, 30])).up30, { ago: 0 });
  // red-day runs
  eq('red streak 3', redStreak([10, 11, 10, 9, 8]), 3);
  eq('red streak broken by a green day', redStreak([10, 9, 10, 9]), 1);
  eq('flat is not red', redStreak([10, 9, 9]), 0);
  eq('no bars, no streak', redStreak([5]), 0);
  // holes in a thin option's bars
  eq('no weekday hole across a weekend', skippedWeekdays('2026-10-09', '2026-10-12'), 0);
  eq('one missing weekday is a hole', skippedWeekdays('2026-10-06', '2026-10-08'), 1);
  eq('a missing Mon-Fri week is five', skippedWeekdays('2026-10-02', '2026-10-12'), 5);
  eq('adjacent days', skippedWeekdays('2026-10-07', '2026-10-08'), 0);
  eq('OCC contract reads plainly', describeContract('QCOM261218C00195000'), 'QCOM Dec 18 2026 195 Call');
  eq('OCC put with a fractional strike', describeContract('FRMI261218P00005500'), 'FRMI Dec 18 2026 5.5 Put');
  eq('a stock is not a contract', describeContract('AAPL'), null);
  // completed sessions only: ET wall clock
  const rows = [{ date: '2026-10-08' }, { date: '2026-10-09' }, { date: '2026-10-12' }];
  eq('mid-session Monday drops the forming bar', dropFormingBar(rows, new Date('2026-10-12T14:00:00Z')).length, 2);   // 10:00 ET
  eq('just after the bell, still settling', dropFormingBar(rows, new Date('2026-10-12T20:05:00Z')).length, 2);        // 16:05 ET
  eq('settled after 16:15 ET keeps the bar', dropFormingBar(rows, new Date('2026-10-12T20:20:00Z')).length, 3);
  eq('Saturday keeps Friday', dropFormingBar(rows.slice(0, 2), new Date('2026-10-10T15:00:00Z')).length, 2);
  // symbols
  eq('share class maps to Yahoo form', yahooSymbol('BRK.B'), 'BRK-B');
  eq('OCC padding is stripped', yahooSymbol('AAPL  261002C00180000'), 'AAPL261002C00180000');
  eq('index symbol untouched', yahooSymbol('^GSPC'), '^GSPC');
  eq('free text is not a ticker', TICKER_RE.test('IGNORE PREVIOUS INSTRUCTIONS'), false);
  eq('a long title is not a ticker', TICKER_RE.test('SEND-EMAIL-TO-ATTACKER'), false);
  eq('a plain ticker is', TICKER_RE.test('BRK.B'), true);
  // which pane is scanned, and where a hit is filed (a stand-in for the dashboard's math: the two configs answer different series)
  const WS = { tag: 'long', k: 2, kSmooth: 1, d: 1 }, SW = { tag: 'swing', k: 1, kSmooth: 1, d: 1 };   // barsNeeded at lookback 3: long 4, swing 3
  const pad2 = a => [...Array(10 - a.length).fill(null), ...a];            // 10 bars, nulls first
  const fake = { WSTOCH: WS, STOCH: SW,
    stochSeries: (_s, cfg) => cfg === WS ? { k: pad2([20, 25, 29, 31]), d: pad2([22, 24, 26, 28]) }          // long-term: crosses UP 30 on the last bar
                                          : { k: pad2([85, 90, 82, 78]), d: pad2([84, 88, 83, 80]) },         // swing: crosses DOWN 80 on the last bar
    rsiSeries: () => Array(10).fill(55) };
  const rows10 = Array.from({ length: 10 }, (_, i) => ({ date: '2026-10-0' + i, o: 10, h: 11, l: 9, c: 10 + i, v: 1 }));
  const p1 = scanSymbol(fake, 'XYZ', rows10, 1, 3), p2 = scanSymbol(fake, 'XYZ', rows10, 2, 3);
  eq('pane 1 scans the LONG-TERM series: an up-30 cross, no down-80', p1.hits.map(h => h.kind), ['up30']);
  eq('pane 2 scans the SWING series: a down-80 cross, no up-30', p2.hits.map(h => h.kind), ['down80']);
  eq('a cross on the last bar is sessionsAgo 0 (filed as latest)', p1.hits[0].ago, 0);
  eq('the record carries the scanned pane K/D now and the other pane', [p1.hits[0].rec.kNow, p1.hits[0].rec.dNow, p1.hits[0].rec.otherPaneK], [31, 28, 78]);
  eq('K before the cross is the bar before it', p1.hits[0].rec.kBefore, 29);
  eq('on the latest session, at-the-cross readings are the current ones', [p1.hits[0].rec.kAtCross, p1.hits[0].rec.dAtCross], [31, 28]);
  eq('day change is last close over the one before', p1.hits[0].rec.dayPct, 5.56);                         // 19/18 - 1
  eq('asOf is the last bar', p1.asOf, '2026-10-09');
  const bucket = { up30: { latest: [], earlier: [] }, down80: { latest: [], earlier: [] } };
  fileHit(bucket, { kind: 'up30', ago: 0, rec: 'a' }); fileHit(bucket, { kind: 'up30', ago: 2, rec: 'b' }); fileHit(bucket, { kind: 'down80', ago: 1, rec: 'c' });
  eq('hits are filed latest vs earlier by sessionsAgo', [bucket.up30.latest, bucket.up30.earlier, bucket.down80.latest, bucket.down80.earlier], [['a'], ['b'], [], ['c']]);
  const early = { ...fake, stochSeries: (_s, cfg) => cfg === WS ? { k: pad2([20, 25, 29, 31, 35]), d: pad2([22, 24, 26, 28, 30]) } : fake.stochSeries(_s, cfg) };
  eq('a cross one bar earlier is filed as sessionsAgo 1', scanSymbol(early, 'XYZ', rows10, 1, 3).hits.map(h => h.ago), [1]);
  const e1 = scanSymbol(early, 'XYZ', rows10, 1, 3).hits[0].rec;
  eq('an earlier hit reports the readings AT the crossing, not today\'s', [e1.kBefore, e1.kAtCross, e1.dAtCross, e1.crossedOn], [29, 31, 28, '2026-10-08']);
  eq('...and today\'s readings separately', [e1.kNow, e1.dNow], [35, 30]);
  eq('...and the close and day change are the latest session\'s', [e1.close, e1.dayPct, e1.sessionsAgo], [19, 5.56, 1]);
  eq('a reading the study cannot give is null, never NaN (JSON would print both as null)', Object.is(scanSymbol({ ...fake, rsiSeries: () => Array(10).fill(NaN) }, 'XYZ', rows10, 1, 3).hits[0].rec.rsi, null), true);
  // bars are rounded to two decimals as desk-charts' packSeries does, before any study sees them
  let seen = null; const spy = { ...fake, stochSeries: (S, cfg) => { seen = S; return fake.stochSeries(S, cfg); } };
  const raw = rows10.map(x => ({ ...x, o: 10.004, h: 11.126, l: 8.996, c: 10.126 }));
  scanSymbol(spy, 'XYZ', raw, 1, 3);
  eq('the study sees prices rounded like the dashboard\'s', [seen.o[0], seen.h[0], seen.l[0], seen.c[0]], [10, 11.13, 9, 10.13]);
  eq('roundBars leaves dates and volume alone', roundBars([{ date: 'd', o: 1.234, h: 1.236, l: 1.231, c: 1.235, v: 7 }]), [{ date: 'd', o: 1.23, h: 1.24, l: 1.23, c: 1.24, v: 7 }]);
  // a symbol whose newest bar is older than the report's session is listed, not scanned
  const mk = (sym, asOf) => ({ sym, r: { asOf, hits: [] } });
  const part = partitionBySession([mk('A', '2026-10-09'), mk('B', '2026-10-09'), mk('C', '2026-10-08')], '2026-10-09');
  eq('the report session is the newest bar any symbol has', part.newest, '2026-10-09');
  eq('symbols on it are scanned', part.onSession.map(x => x.sym), ['A', 'B']);
  eq('an older last bar is quarantined with its date', part.stale, [{ symbol: 'C', lastBar: '2026-10-08' }]);
  eq('nothing priced, nothing newest', partitionBySession([], null).newest, null);
  eq('the session is the one it is told, not the newest scan it sees', partitionBySession([mk('A', '2026-10-10'), mk('B', '2026-10-09')], '2026-10-09').stale, [{ symbol: 'A', lastBar: '2026-10-10' }]);
  // the report session is where most symbols end, so one 24/7 asset cannot make every equity stale
  eq('the session is the date most symbols end on', dominantSession(['2026-10-09', '2026-10-09', '2026-10-11']), '2026-10-09');
  eq('a tie goes to the later date', dominantSession(['2026-10-08', '2026-10-09']), '2026-10-09');
  eq('...whichever order they arrive in', dominantSession(['2026-10-09', '2026-10-08']), '2026-10-09');
  eq('no symbols, no session', dominantSession([]), null);
  eq('a holding whose last bar is older is stale', isStaleBar('2026-10-07', '2026-10-09'), true);
  eq('a holding on the latest session is not', isStaleBar('2026-10-09', '2026-10-09'), false);
  eq('no reference session, nothing is stale', isStaleBar('2026-10-07', null), false);
  // nonpositive prices are dropped like the dashboard's parser does
  eq('a zero price is a sentinel, not a bar', fullBars([{ o: 0, h: 2, l: 1, c: 1.5 }, { o: 1, h: 2, l: 0, c: 1.5 }, { o: 1, h: 2, l: 1, c: 0 }]).length, 0);
  eq('a negative price is dropped', fullBars([{ o: 1, h: 2, l: -1, c: 1.5 }]).length, 0);
  eq('a positive bar is kept', fullBars([{ o: 0.01, h: 0.02, l: 0.01, c: 0.02 }]).length, 1);
  // holdings: what each one says, and a stale one is never silently dropped
  const hb = (dates, closes) => ({ rows: dates.map((date, i) => ({ date, c: closes[i] })) });
  const D5 = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const cur = classifyHolding('QCOM261218C00195000', hb(D5.slice(1), [10.75, 8.55, 7.65, 7.15]), '2026-10-09', 3);
  eq('a current holding with 3 red days is a streak', [cur.kind, cur.rec.redDays, cur.rec.closes, cur.rec.contract], ['streak', 3, [10.75, 8.55, 7.65, 7.15], 'QCOM Dec 18 2026 195 Call']);
  eq('a streak reports the last day\'s move and no caution when nothing is missing', [cur.rec.lastDayPct, 'caution' in cur.rec], [-6.54, false]);
  eq('a current holding with only 2 red days is nothing to report', classifyHolding('X', hb(D5.slice(1), [10, 11, 10, 9]), '2026-10-09', 3).kind, 'none');
  const stNo = classifyHolding('FRMI261218C00005000', hb(D5.slice(0, 4), [10, 11, 12, 13]), '2026-10-09', 3);
  eq('a stale holding with NO streak is still listed, never dropped', [stNo.kind, stNo.rec.lastBar, stNo.rec.redDaysThen], ['stale', '2026-10-08', 0]);
  const stYes = classifyHolding('X', hb(D5.slice(0, 4), [13, 12, 11, 10]), '2026-10-09', 3);
  eq('a stale holding WITH a streak is stale, not a current streak', [stYes.kind, stYes.rec.redDaysThen], ['stale', 3]);
  eq('a short stale holding is still listed as stale, not unpriced', classifyHolding('X', hb(D5.slice(0, 2), [2, 1]), '2026-10-09', 3).kind, 'stale');
  eq('a holding with a single bar is stale when that bar is old', classifyHolding('X', hb([D5[0]], [5]), '2026-10-09', 3).rec.lastBar, '2026-10-05');
  eq('no bars at all is unpriced', classifyHolding('X', { rows: [] }, '2026-10-09', 3), { kind: 'unpriced', rec: { symbol: 'X', why: 'no bars' } });
  const zr = classifyHolding('X', { rows: [7, 6, 5, 4, 0].map((c, i) => ({ date: '2026-10-0' + (5 + i), c })).filter(hasClose) }, '2026-10-08', 3);
  eq('a zero close is a sentinel and is dropped: the run ends on the last real close (-20%), not -100%', [zr.kind, zr.rec.redDays, zr.rec.lastDayPct], ['streak', 3, -20]);
  const yres = { timestamp: [1760000000, 1760086400, 1760172800, 1760227200], indicators: { quote: [{ open: [1, 1, 1, 1], high: [2, 2, 2, 2], low: [1, 1, 1, 1], close: [5, 0, null, 4], volume: [10, null, 7, 8] }] } };
  eq('Yahoo rows keep a good close only: a zero and a null are dropped, the rest dated on the New York day (midnight UTC is still the evening before there)', chartRows(yres).map(r => [r.date, r.c, r.v]), [['2025-10-09', 5, 10], ['2025-10-11', 4, 8]]);
  eq('a negative close is dropped too', [{ c: -1 }, { c: 0 }, { c: NaN }, { c: 0.25 }].filter(hasClose).length, 1);
  eq('too few bars is unpriced, with its reason', classifyHolding('X', hb(D5.slice(3), [1, 2]), '2026-10-09', 3), { kind: 'unpriced', rec: { symbol: 'X', why: 'too few bars' } });
  eq('a fetch error is passed through', classifyHolding('X', { error: 'unknown to Yahoo' }, '2026-10-09', 3).rec.why, 'unknown to Yahoo');
  eq('with no reference session nothing is stale', classifyHolding('X', hb(D5.slice(0, 4), [13, 12, 11, 10]), null, 3).kind, 'streak');
  eq('a run across a missing weekday carries a caution', typeof classifyHolding('X', hb(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09'], [10, 9, 8, 7]), '2026-10-09', 3).rec.caution, 'string');
  eq('exactly minStreak bars cannot show a streak of minStreak (it needs one more close): unpriced', classifyHolding('X', hb(D5.slice(2), [3, 2, 1]), '2026-10-09', 3).kind, 'unpriced');
  eq('minStreak + 1 bars can', classifyHolding('X', hb(D5.slice(1), [4, 3, 2, 1]), '2026-10-09', 3).kind, 'streak');
  const hl = () => ({ redStreak: [], stale: [], unpriced: [] });
  eq('a streak is filed under redStreak only', fileHolding(hl(), { kind: 'streak', rec: 'a' }), { redStreak: ['a'], stale: [], unpriced: [] });
  eq('a stale holding is filed under stale only', fileHolding(hl(), { kind: 'stale', rec: 'b' }), { redStreak: [], stale: ['b'], unpriced: [] });
  eq('an unpriced holding is filed under unpriced only', fileHolding(hl(), { kind: 'unpriced', rec: 'c' }), { redStreak: [], stale: [], unpriced: ['c'] });
  eq('"none" is filed nowhere', fileHolding(hl(), { kind: 'none' }), hl());
  // incomplete bars never reach the study, and one bad symbol never takes the run down
  eq('a row missing its open is dropped (and so cannot throw in roundBars)', fullBars([{ o: null, h: 2, l: 1, c: 1.5 }, { o: 1, h: 2, l: 1, c: 1.5 }]).length, 1);
  eq('a row missing any of high/low/close is dropped too', fullBars([{ o: 1, h: undefined, l: 1, c: 1 }, { o: 1, h: 2, l: NaN, c: 1 }, { o: 1, h: 2, l: 1, c: null }]).length, 0);
  eq('a complete row is kept', fullBars([{ o: 1, h: 2, l: 1, c: 1.5 }]).length, 1);
  const cfg = { k: 92, kSmooth: 15, d: 15 }, full = n => Array.from({ length: n }, () => ({ o: 1, h: 2, l: 1, c: 1.5 })), holey = n => Array.from({ length: n }, () => ({ o: null, h: 2, l: 1, c: 1.5 }));
  eq('enough complete bars are usable', prepareRows({ rows: full(125) }, cfg, 3).rows.length, 125);
  eq('incomplete rows are dropped from what is used', prepareRows({ rows: [...full(123), ...holey(3)] }, cfg, 3).rows.length, 123);
  eq('incomplete rows do not count toward the minimum', prepareRows({ rows: [...full(121), ...holey(5)] }, cfg, 3).why, 'under 122 bars');
  eq('121 complete bars cannot judge three sessions', prepareRows({ rows: full(121) }, cfg, 3).why, 'under 122 bars');
  eq('...but can judge the latest alone', prepareRows({ rows: full(121) }, cfg, 1).rows.length, 121);
  eq('a fetch error is passed through as the reason', prepareRows({ error: 'unknown to Yahoo' }, cfg, 3).why, 'unknown to Yahoo');
  const rowsBoom = rows10.map((r, i) => (i ? r : { ...r, c: 999 })), pickyDash = { ...fake, stochSeries: (S, cfg) => { if (S.c[0] === 999) throw new Error('boom'); return fake.stochSeries(S, cfg); } };
  const built = buildScans([['AAA', { rows: rows10 }], ['BBB', { error: 'unknown to Yahoo' }], ['CCC', { rows: rows10.slice(0, 2) }], ['DDD', { rows: rowsBoom }], ['EEE', { rows: rows10 }]], pickyDash, 1, 3);
  eq('good symbols are scanned, in order', built.scans.map(x => x.sym), ['AAA', 'EEE']);
  eq('the rest are listed with their reason; one failure does not stop the others', built.unpriced, [{ symbol: 'BBB', why: 'unknown to Yahoo' }, { symbol: 'CCC', why: 'under 4 bars' }, { symbol: 'DDD', why: 'could not be read: boom' }]);
  eq('a scanned entry carries its result', built.scans[0].r.asOf, '2026-10-09');
  eq('the build reports the session it used', built.session, '2026-10-09');
  // a 24/7 asset still has Sunday's bar on a Monday: it is read as of the session, and cannot make the equities stale
  const wk = rows10.concat([{ date: '2026-10-10', o: 10, h: 11, l: 9, c: 20, v: 1 }, { date: '2026-10-11', o: 10, h: 11, l: 9, c: 21, v: 1 }]);
  const mon = buildScans([['AAA', { rows: rows10 }], ['BBB', { rows: rows10 }], ['CCC', { rows: rows10 }], ['BTC-USD', { rows: wk }]], fake, 1, 3);
  eq('the session is where most symbols end, not the newest bar anyone has', mon.session, '2026-10-09');
  eq('...so the equities are all on it, and so is the 24/7 asset', mon.scans.map(x => [x.sym, x.r.asOf]), [['AAA', '2026-10-09'], ['BBB', '2026-10-09'], ['CCC', '2026-10-09'], ['BTC-USD', '2026-10-09']]);
  eq('...with nobody stale', partitionBySession(mon.scans, mon.session).stale, []);
  const thin = buildScans([['AAA', { rows: rows10 }], ['BBB', { rows: rows10 }], ['NEW', { rows: [...rows10.slice(7), { date: '2026-10-10', o: 1, h: 2, l: 1, c: 2, v: 1 }] }]], fake, 1, 3);
  eq('cutting a 24/7 asset back to the session can leave it too short: it is listed with why', thin.unpriced, [{ symbol: 'NEW', why: 'under 4 bars as of 2026-10-09' }]);
  const three = [['AAA', { rows: rows10.slice(0, 3) }]];
  eq('three bars are enough for the swing pane here (it needs 3)', buildScans(three, fake, 2, 3).scans.length, 1);
  eq('...but not for the long-term pane (it needs 4): each pane uses ITS OWN minimum', buildScans(three, fake, 1, 3).unpriced, [{ symbol: 'AAA', why: 'under 4 bars' }]);
  const boom = { ...fake, stochSeries: () => { throw new TypeError('x'); } };
  eq('a symbol that throws is a reason, not a crash', scanOrReason(boom, 'XYZ', rows10, 1, 3).why, 'could not be read: x');
  eq('a symbol that scans returns its result', scanOrReason(fake, 'XYZ', rows10, 1, 3).r.asOf, '2026-10-09');
  // the bars a symbol needs, checked against the REAL study's warm-up
  const dash0 = loadDashboard(), ramp = Array.from({ length: 130 }, (_, i) => 10 + Math.sin(i / 5) * 3 + i * 0.05);
  const RS = { t: ramp.map((_, i) => 'd' + i), o: ramp, h: ramp.map(x => x + 1), l: ramp.map(x => x - 1), c: ramp, v: ramp.map(() => 1) };
  const real = dash0.stochSeries(RS, dash0.WSTOCH);
  eq('Pro 1 %K first has a value at bar 106 (index 105)', real.k.findIndex(v => v != null), 105);
  eq('Pro 1 %D first has a value at bar 120 (index 119)', real.d.findIndex(v => v != null), 119);
  eq('Pro 1 needs 120 bars for the latest session alone', barsNeeded(dash0.WSTOCH, 1), 120);
  eq('Pro 1 needs 122 bars to judge the last three sessions', barsNeeded(dash0.WSTOCH, 3), 122);
  const upTo = n => ({ t: RS.t.slice(0, n), o: RS.o.slice(0, n), h: RS.h.slice(0, n), l: RS.l.slice(0, n), c: RS.c.slice(0, n), v: RS.v.slice(0, n) });
  const need3 = barsNeeded(dash0.WSTOCH, 3);
  eq('with exactly the needed bars, %D exists on the oldest of the last three sessions', dash0.stochSeries(upTo(need3), dash0.WSTOCH).d[need3 - 1 - 2] != null, true);
  eq('with one bar fewer it does not', dash0.stochSeries(upTo(need3 - 1), dash0.WSTOCH).d[need3 - 1 - 1 - 2] != null, false);
  eq('Pro 2 swing needs 20 bars for three sessions', barsNeeded(dash0.STOCH, 3), 20);
  // the dashboard's own math is what is being used
  const dash = loadDashboard(), up = Array.from({ length: 200 }, (_, i) => 10 + i);
  const S = { t: up.map((_, i) => 'd' + i), o: up, h: up.map(x => x + 1), l: up.map(x => x - 1), c: up, v: up.map(() => 1) };
  const k = dash.stochSeries(S, dash.WSTOCH).k;
  eq('a steady climb sits near the top of the Pro 1 range', k[199] > 90, true);
  eq('Pro 1 is the 92-15-15 config', [dash.WSTOCH.k, dash.WSTOCH.kSmooth, dash.WSTOCH.d], [92, 15, 15]);
  console.log(bad ? `${bad} FAILED` : 'all passed');
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else if (import.meta.url === 'file://' + process.argv[1]) main();
