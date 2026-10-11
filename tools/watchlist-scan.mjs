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
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TICKER_RE = /^[A-Z0-9.^=-]{1,10}$/;          // app.js WL_SYM_RE / desk-ask TICKER_RE
const HOLDING_RE = /^[A-Z0-9.^=-]{1,24}$/;         // an OCC option symbol is longer than a ticker
const MAX_SYMBOLS = 1000;                           // = the dashboard feed's cap (WL_FEED_CAP / desk-watchlist MAX_SYMBOLS); the roster is anon-writable
const RUN_BUDGET_MS = 6 * 60 * 1000;               // the whole roster fetch, however many symbols and however slow Yahoo is
const HOLDINGS_BUDGET_MS = 90 * 1000;
const MAX_AHEAD = 0.1;                             // more than this share of the roster ending on a NEWER weekday than the report session = a lagging feed
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
/* How long the next request may take: Yahoo's 20 s, or what is left of the run's budget if that is less. Zero or below = out of time. */
export const attemptTimeout = (deadline, now = Date.now()) => Math.min(20000, deadline - now);
/* An unbounded roster would keep the scan (and the Routine behind it) busy for hours: the roster is writable by anyone holding the site's public
   key, so it is capped BEFORE any request goes out (Codex, PR #321). */
export const rosterLimitError = n => (n > MAX_SYMBOLS ? `${n} symbols is over the limit of ${MAX_SYMBOLS}; nothing was scanned` : null);
export async function bars(symbol, now, deadline, doFetch = fetch) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(yahooSymbol(symbol)) + '?range=2y&interval=1d';
  let err = 'no answer';
  for (let a = 0; a < 3; a++) {
    const left = attemptTimeout(deadline);
    if (left <= 0) return { error: 'run time limit reached' };
    try {
      const r = await doFetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(left) });
      if (r.status === 404) return { error: 'unknown to Yahoo' };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      let rows = chartRows((await r.json()).chart.result[0]);
      rows = dropFormingBar(rows, now);
      return rows.length ? { rows } : { error: 'no bars' };
    } catch (e) { err = String(e.message || e).slice(0, 60); await sleep(Math.max(0, Math.min(1500 * (a + 1), deadline - Date.now()))); }
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
/* The coverage verdict: a run that checked nothing, or too little of the roster, must say so. An EMPTY roster (or one whose every entry failed
   ticker validation) priced 0 of 0, which the percentage test alone would let through as a clean "no crossings" (Codex, PR #321). */
export function coverageError(requested, scanned) {
  if (!requested) return 'no symbols to scan (the roster was empty or held no valid ticker)';
  if (scanned / requested < MIN_PRICED) return `only ${scanned} of ${requested} symbols priced on the latest session`;
  return null;
}

/* Whether the run can be trusted, written onto the report: too little of the roster priced (or none), or a newest bar more than five days old,
   makes it ok:false with the reason, so "no crossings" can never be what a broken feed looks like. */
export function verdict(out, now) {
  out.staleDays = out.newestBar ? Math.round((now - new Date(out.newestBar + 'T12:00:00Z')) / 864e5) : null;
  const errors = [coverageError(out.requested, out.scanned)];
  if (out.requested && (out.ahead || 0) / out.requested > MAX_AHEAD) errors.push(`${out.ahead} of ${out.requested} symbols have a newer weekday bar than the report session ${out.newestBar}: the feed is lagging for the rest, so this report would be a stale one`);
  if (out.staleDays != null && out.staleDays > 5) errors.push(`newest bar is ${out.staleDays} days old`);
  const bad = errors.filter(Boolean);
  if (bad.length) { out.ok = false; out.error = bad.join('; '); }
  return out;
}

/* Yahoo's chart result -> dated bars. Holdings need only a good close, so that is all this keeps; a scan demands all four prices on top (fullBars). */
export function chartRows(res) {
  const q = res.indicators.quote[0], rows = [];
  (res.timestamp || []).forEach((t, i) => {
    // Drop the bar, never the symbol (as desk-charts' parseYahooChartOHLC does): a missing or junk timestamp makes Intl throw a RangeError,
    // which would otherwise cost the whole symbol its coverage (Codex, PR #321).
    const secs = t == null ? NaN : Number(t), when = new Date(secs * 1000);
    if (!Number.isFinite(secs) || !Number.isFinite(when.getTime())) return;
    const row = { date: nyParts(when).day, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 };
    if (hasClose(row)) rows.push(row);
  });
  return rows;
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
export const isWeekend = date => { const w = new Date(date + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
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
/* The sessions the market actually had up to the report session: the dates at least half the symbols have a bar on (a thin name missing a day
   does not delete it; a holiday nobody traded is not one). `crossings` counts BARS back, and a symbol that skipped a session would otherwise
   report a crossing four sessions old as two (Codex, PR #321). */
export function sessionCalendar(datesPerSymbol, session) {
  const n = new Map();
  for (const dates of datesPerSymbol) for (const d of new Set(dates)) if (d <= session) n.set(d, (n.get(d) || 0) + 1);
  return [...n].filter(([, c]) => c * 2 >= datesPerSymbol.length).map(([d]) => d).sort();
}
export const sessionsSince = (calendar, date, session) => calendar.filter(d => d > date && d <= session).length;
/* A hit's age is the larger of the bars back and the sessions back, so a skipped session can only push it OUT of the window, never in; a hit
   that is no longer inside the lookback is dropped. */
export function realignHits(hits, calendar, session, lookback) {
  return hits.map(h => { const ago = Math.max(h.ago, sessionsSince(calendar, h.rec.crossedOn, session)); return { ...h, ago, rec: { ...h.rec, sessionsAgo: ago } }; })
    .filter(h => h.ago < lookback);
}

export function buildScans(results, dash, pane, lookback) {
  const cfg = pane === 2 ? dash.STOCH : dash.WSTOCH, scans = [], unpriced = [], ready = [];
  const need = barsNeeded(cfg, lookback);
  for (const [sym, b] of results) {
    const prep = prepareRows(b, cfg, lookback);
    if (prep.why) unpriced.push({ symbol: sym, why: prep.why });
    else ready.push([sym, prep.rows]);
  }
  const session = dominantSession(ready.map(([, rows]) => rows[rows.length - 1].date));
  // Symbols whose bars run PAST the session on a weekday are not a 24/7 asset's weekend bar: they are a cohort the rest of the feed is lagging
  // behind. Rolling them back to the majority's date would report a stale session as a clean one, so they are counted and `verdict` fails the run
  // when there are too many (Codex, PR #321).
  const ahead = ready.filter(([, rows]) => rows.some(x => x.date > session && !isWeekend(x.date))).length;   // ANY weekday bar past the session, not just the newest bar
  const calendar = sessionCalendar(ready.map(([, rows]) => rows.map(x => x.date)), session);
  for (const [sym, all] of ready) {
    const rows = all.filter(x => x.date <= session);
    if (rows.length < need) { unpriced.push({ symbol: sym, why: `under ${need} bars as of ${session}` }); continue; }
    const one = scanOrReason(dash, sym, rows, pane, lookback);
    if (one.why) { unpriced.push({ symbol: sym, why: one.why }); continue; }
    scans.push({ sym, r: { ...one.r, hits: realignHits(one.r.hits, calendar, session, lookback) } });
  }
  return { scans, unpriced, session, ahead };
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

/* How many requested holdings were actually evaluated: "none of them has a red-day run" may only be said of these (Codex, PR #321). */
export const holdingsChecked = h => h.requested - h.stale.length - h.unpriced.length;

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

/* The scan results -> the report: hits filed by kind and recency, the session, the stale and unpriced lists, and the verdict. */
export function buildReport(out, built, now) {
  out.unpriced.push(...built.unpriced);
  const part = partitionBySession(built.scans, built.session);
  out.newestBar = part.newest; out.ahead = built.ahead; out.stale = part.stale; out.scanned = part.onSession.length;
  for (const x of part.onSession) for (const h of x.r.hits) fileHit(out, h);
  for (const k of ['up30', 'down80']) for (const w of ['latest', 'earlier']) out[k][w].sort((a, b) => a.symbol.localeCompare(b.symbol));
  verdict(out, now);
  return out;
}

/* The fetched holdings -> the holdings block: red-day runs, the ones that could not be checked through the session (stale, unpriced), and how
   many WERE checked, so "none has a run" is only ever said of those. */
export function buildHoldings(fetched, requested, newest, minStreak) {
  const h = { requested, referenceSession: newest, redStreak: [], stale: [], unpriced: [] };
  for (const [sym, b] of fetched) fileHolding(h, classifyHolding(sym, b, newest, minStreak));
  h.checked = holdingsChecked(h);
  h.redStreak.sort((a, b) => b.redDays - a.redDays || a.symbol.localeCompare(b.symbol));
  return h;
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

  const tooMany = rosterLimitError(symbols.length);
  if (tooMany) { console.log(JSON.stringify({ ok: false, error: tooMany, requested: symbols.length })); process.exit(2); }

  const runDeadline = Date.now() + RUN_BUDGET_MS;
  const results = await pool(symbols, 8, async sym => [sym, await bars(sym, now, runDeadline)]);
  const out = { ok: true, pane: pane === 2 ? 'Pro 2 SWING 14-3-3' : 'Pro 1 LONG-TERM 92-15-15', generatedAt: now.toISOString(), requested: symbols.length, scanned: 0, lists: rosterInfo ? rosterInfo.lists : null,
    rejectedTickers: rosterInfo ? rosterInfo.rejected : 0, unpriced: [], stale: [],
    up30: { latest: [], earlier: [] }, down80: { latest: [], earlier: [] } };

  buildReport(out, buildScans(results, dash, pane, lookback), now);

  const hold = arg('holdings');
  if (hold) {
    const list = [...new Set(JSON.parse(fs.readFileSync(hold, 'utf8')).map(s => String(s).toUpperCase().replace(/\s+/g, '')).filter(s => HOLDING_RE.test(s)))];
    const holdDeadline = Date.now() + HOLDINGS_BUDGET_MS;
    const H = await pool(list, 8, async sym => [sym, await bars(sym, now, holdDeadline)]);
    out.holdings = buildHoldings(H, list.length, out.newestBar, minStreak);
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(out.ok ? 0 : 3);
}

/* ── selftest ─────────────────────────────────────────────────────────────── */
async function selftest() {
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
  const jts = { timestamp: [1760000000, undefined, NaN, 'abc', null, 1e20, '1760086400', 1760172800], indicators: { quote: [{ open: Array(8).fill(1), high: Array(8).fill(2), low: Array(8).fill(1), close: [5, 5, 5, 5, 5, 5, 4, 3], volume: Array(8).fill(1) }] } };
  eq('a junk timestamp drops THAT bar, never the symbol or the run (as the dashboard\'s parser)', chartRows(jts).map(r => r.c), [5, 4, 3]);
  eq('...and a missing timestamp list is no bars, not a crash', chartRows({ indicators: { quote: [{}] } }), []);
  eq('an empty roster is not a clean "no crossings"', typeof coverageError(0, 0), 'string');
  eq('a healthy run has no coverage error', coverageError(240, 237), null);
  eq('too few priced is an error naming the counts', coverageError(240, 215), 'only 215 of 240 symbols priced on the latest session');
  eq('exactly 90% priced is enough', coverageError(240, 216), null);
  const vNow = new Date('2026-10-12T14:00:00Z'), vd = o => verdict({ ok: true, requested: 240, scanned: 237, newestBar: '2026-10-09', ...o }, vNow);
  eq('a healthy report stays ok', [vd({}).ok, vd({}).staleDays, 'error' in vd({})], [true, 3, false]);
  eq('an empty roster makes the report not ok, with the reason', [vd({ requested: 0, scanned: 0, newestBar: null }).ok, vd({ requested: 0, scanned: 0, newestBar: null }).error], [false, 'no symbols to scan (the roster was empty or held no valid ticker)']);
  eq('too few priced makes it not ok', vd({ scanned: 100 }).ok, false);
  eq('a newest bar over five days old makes it not ok', [vd({ newestBar: '2026-10-06' }).ok, vd({ newestBar: '2026-10-06' }).error], [false, 'newest bar is 6 days old']);
  eq('five days old is still fine', vd({ newestBar: '2026-10-07' }).ok, true);
  // the real CLI, offline: nothing valid to scan must exit 3 with ok:false, never a clean report (this is what pins main's wiring of the verdict)
  eq('a roster at the limit is scanned', rosterLimitError(1000), null);
  eq('a roster over the limit is refused with the count, before any request', rosterLimitError(1001), '1001 symbols is over the limit of 1000; nothing was scanned');
  eq('a request gets Yahoo\'s 20 s when there is time', attemptTimeout(100000, 0), 20000);
  eq('...or what is left of the budget when that is less', attemptTimeout(5000, 1000), 4000);
  eq('...and nothing once the budget is spent', attemptTimeout(1000, 1000) <= 0, true);
  const NOW = new Date('2026-10-12T14:00:00Z'), okJson = { chart: { result: [{ timestamp: [1760000000, 1760086400], indicators: { quote: [{ open: [1, 1], high: [2, 2], low: [1, 1], close: [5, 4], volume: [1, 1] }] } }] } };
  let calls = 0;
  const fakeFetch = (status, body) => async () => { calls++; return { status, ok: status >= 200 && status < 300, json: async () => body }; };
  eq('out of time: no request is made at all', [await bars('AAA', NOW, Date.now() - 1, fakeFetch(200, okJson)), calls], [{ error: 'run time limit reached' }, 0]);
  eq('with time, a good reply gives its bars', (await bars('AAA', NOW, Date.now() + 60000, fakeFetch(200, okJson))).rows.length, 2);
  eq('a 404 is "unknown to Yahoo" at once', [await bars('AAA', NOW, Date.now() + 60000, fakeFetch(404, {})), calls], [{ error: 'unknown to Yahoo' }, 2]);
  // (AbortSignal.timeout's own timer is unref'd, so this stand-in holds the process open the way a real socket would)
  const hang = (_u, o) => new Promise((_r, rej) => { const keep = setTimeout(() => {}, 10000); o.signal.addEventListener('abort', () => { clearTimeout(keep); rej(new Error('aborted')); }); });
  const t0 = Date.now(), hung = await bars('AAA', NOW, Date.now() + 300, hang);
  eq('a silent server is given up on at the budget, not after 20 s x 3', [hung.error.includes('abort') || hung.error === 'run time limit reached', Date.now() - t0 < 1200], [true, true]);
  // a session a symbol skipped: crossings counts bars, so the true age comes from the market's own calendar
  const dts = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const cal = sessionCalendar([dts, dts, dts, dts.filter(d => d !== '2026-10-08')], '2026-10-09');
  eq('the calendar is the dates most symbols traded', cal, dts);
  eq('a date only a minority has is not a session', sessionCalendar([dts, dts, [...dts, '2026-10-10'], dts], '2026-10-09').includes('2026-10-10'), false);
  eq('a date after the report session is not counted', sessionCalendar([[...dts, '2026-10-10']], '2026-10-09').includes('2026-10-10'), false);
  eq('a date exactly half the symbols have is a session', sessionCalendar([['2026-10-05'], ['2026-10-06']], '2026-10-09'), ['2026-10-05', '2026-10-06']);
  eq('a symbol listing a date twice counts once', sessionCalendar([['2026-10-05', '2026-10-05'], ['2026-10-06'], ['2026-10-06']], '2026-10-09'), ['2026-10-06']);
  eq('sessions since a date stop at the report session', sessionsSince(['2026-10-05', '2026-10-06', '2026-10-10'], '2026-10-05', '2026-10-09'), 1);
  eq('sessions since a date', [sessionsSince(cal, '2026-10-09', '2026-10-09'), sessionsSince(cal, '2026-10-07', '2026-10-09'), sessionsSince(cal, '2026-10-05', '2026-10-09')], [0, 2, 4]);
  const hit = (ago, crossedOn) => ({ kind: 'up30', ago, rec: { crossedOn, sessionsAgo: ago } });
  eq('a hit with no skipped session keeps its age', realignHits([hit(2, '2026-10-07')], cal, '2026-10-09', 3).map(h => h.ago), [2]);
  eq('a skipped session pushes an old hit OUT of the window: 2 bars back is 4 sessions back', realignHits([hit(2, '2026-10-05')], cal, '2026-10-09', 3), []);
  eq('...and a hit still inside gets its true age, in the record too', realignHits([hit(1, '2026-10-07')], cal, '2026-10-09', 3).map(h => [h.ago, h.rec.sessionsAgo]), [[2, 2]]);
  eq('the latest session stays latest', realignHits([hit(0, '2026-10-09')], cal, '2026-10-09', 3).map(h => h.ago), [0]);
  eq('an empty calendar never makes a hit look newer than its bars', realignHits([hit(2, '2026-10-07')], [], '2026-10-09', 3).map(h => h.ago), [2]);
  const tailArr = (n, t) => Array(n - t.length).fill(null).concat(t);
  const crossDash = { ...fake, stochSeries: (S, cfg) => (cfg === WS ? { k: tailArr(S.c.length, [20, 29, 31, 33, 35]), d: tailArr(S.c.length, [22, 25, 28, 30, 32]) } : { k: tailArr(S.c.length, [50]), d: tailArr(S.c.length, [50]) }) };
  const mkRows = ds => ds.map((date, i) => ({ date, o: 10, h: 11, l: 9, c: 10 + i, v: 1 }));
  const gapped = buildScans([['AAA', { rows: mkRows(dts) }], ['BBB', { rows: mkRows(dts) }], ['CCC', { rows: mkRows(dts) }],
    ['GAP', { rows: mkRows(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-09']) }]], crossDash, 1, 3);
  eq('end to end: a symbol with a calendar gap loses a crossing that is really four sessions old', gapped.scans.map(x => [x.sym, x.r.hits.map(h => h.ago)]), [['AAA', [2]], ['BBB', [2]], ['CCC', [2]], ['GAP', []]]);
  const cli2 = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--symbols=' + Array.from({ length: 1001 }, (_, i) => 'T' + String(i).padStart(4, '0')).join(',')], { encoding: 'utf8', timeout: 30000 });
  let cli2Out = {}; try { cli2Out = JSON.parse(cli2.stdout); } catch { /* reported by the check below */ }
  eq('the real CLI refuses an oversized roster before any request: exit 2, ok:false, the count', [cli2.status, cli2Out.ok, cli2Out.requested, /over the limit/.test(cli2Out.error || '')], [2, false, 1001, true]);
  const cli = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--symbols=!!,??'], { encoding: 'utf8', timeout: 30000 });
  let cliOut = {}; try { cliOut = JSON.parse(cli.stdout); } catch { /* reported by the check below */ }
  eq('the CLI given nothing valid to scan exits 3 with ok:false and says why', [cli.status, cliOut.ok, cliOut.requested, /no symbols to scan/.test(cliOut.error || '')], [3, false, 0, true]);
  eq('Saturday and Sunday are weekends, a Friday and a Monday are not', ['2026-10-10', '2026-10-11', '2026-10-09', '2026-10-12'].map(isWeekend), [true, true, false, false]);
  const lagRows = mkRows([...dts, '2026-10-12']);
  const lag = buildScans([['A1', { rows: mkRows(dts) }], ['A2', { rows: mkRows(dts) }], ['A3', { rows: mkRows(dts) }], ['N1', { rows: lagRows }], ['N2', { rows: lagRows }]], crossDash, 1, 3);
  eq('a cohort with a newer WEEKDAY bar is counted (the majority is lagging), not silently rolled back', [lag.session, lag.ahead], ['2026-10-09', 2]);
  const earlyDts = dts.slice(0, -1);   // the equity feed stops on Thursday 10-08; a 24/7 asset still has Friday, Saturday and Sunday
  eq('a 24/7 asset whose NEWEST bar is a Sunday still counts as ahead when it has a weekday bar past the session', buildScans([['A1', { rows: mkRows(earlyDts) }], ['A2', { rows: mkRows(earlyDts) }], ['A3', { rows: mkRows(earlyDts) }], ['BTC-USD', { rows: mkRows([...earlyDts, '2026-10-09', '2026-10-10', '2026-10-11']) }]], crossDash, 1, 3).ahead, 1);
  eq('a 24/7 asset\'s weekend bar is not that cohort', buildScans([['AAA', { rows: mkRows(dts) }], ['BBB', { rows: mkRows(dts) }], ['BTC-USD', { rows: mkRows([...dts, '2026-10-10', '2026-10-11']) }]], crossDash, 1, 3).ahead, 0);
  const vl = o => verdict({ ok: true, requested: 240, scanned: 240, newestBar: '2026-10-09', ahead: 0, ...o }, vNow);
  eq('a few symbols ahead is fine (a 24/7 asset on a holiday)', vl({ ahead: 24 }).ok, true);
  eq('more than 10% ahead fails the run and says why', [vl({ ahead: 25 }).ok, /25 of 240 symbols have a newer weekday bar/.test(vl({ ahead: 25 }).error)], [false, true]);
  eq('two problems are both reported', vl({ ahead: 100, newestBar: '2026-10-01' }).error.split('; ').length, 2);
  eq('the 60/40 split from the review: 40% ahead is not ok', vl({ ahead: 96 }).ok, false);
  eq('holdings checked excludes the stale and the unpriced', holdingsChecked({ requested: 5, stale: [1], unpriced: [1, 2] }), 2);
  eq('every holding checked', holdingsChecked({ requested: 2, stale: [], unpriced: [] }), 2);
  const rep = () => ({ ok: true, requested: 5, scanned: 0, unpriced: [], stale: [], up30: { latest: [], earlier: [] }, down80: { latest: [], earlier: [] } });
  const repLag = buildReport(rep(), lag, vNow);
  eq('the report carries the lagging cohort and fails on it', [repLag.ahead, repLag.ok, /newer weekday bar/.test(repLag.error || '')], [2, false, true]);
  const repOk = buildReport({ ...rep(), requested: 4 }, buildScans([['AAA', { rows: mkRows(dts) }], ['BBB', { rows: mkRows(dts) }], ['CCC', { rows: mkRows(dts) }], ['BAD', { error: 'unknown to Yahoo' }]], crossDash, 1, 3), vNow);
  eq('a healthy small report: session, counts, hits filed as latest/earlier, the unpriced listed', [repOk.newestBar, repOk.scanned, repOk.up30.earlier.map(h => h.symbol), repOk.up30.latest.length, repOk.unpriced.map(u => u.symbol)], ['2026-10-09', 3, ['AAA', 'BBB', 'CCC'], 0, ['BAD']]);
  eq('...and 3 of 4 priced is under the bar, so it is not ok', repOk.ok, false);
  const hb2 = (dates, closes) => ({ rows: dates.map((date, i) => ({ date, c: closes[i] })) });
  const hold = buildHoldings([['CUR', hb2(D5.slice(1), [9, 8, 7, 6])], ['OLD', hb2(D5.slice(0, 4), [4, 3, 2, 1])], ['ERR', { error: 'unknown to Yahoo' }], ['UP', hb2(D5.slice(1), [1, 2, 3, 4])]], 4, '2026-10-09', 3);
  eq('holdings: a streak, a stale one and an unpriced one each land in their list, and the checked count excludes the last two', [hold.redStreak.map(x => x.symbol), hold.stale.map(x => x.symbol), hold.unpriced.map(x => x.symbol), hold.checked, hold.referenceSession], [['CUR'], ['OLD'], ['ERR'], 2, '2026-10-09']);
  eq('holdings: streaks sort longest first, then by symbol', buildHoldings([['B', hb2(D5, [9, 8, 7, 6, 5])], ['A', hb2(D5.slice(1), [9, 8, 7, 6])], ['C', hb2(D5, [9, 8, 7, 6, 5])]], 3, '2026-10-09', 3).redStreak.map(x => x.symbol), ['B', 'C', 'A']);
  const hitOf = (symbol, kind, ago) => ({ kind, ago, rec: { symbol } });
  const sortedRep = buildReport(rep(), { scans: [{ sym: 'ZZZ', r: { asOf: '2026-10-09', hits: [hitOf('ZZZ', 'up30', 0)] } }, { sym: 'AAA', r: { asOf: '2026-10-09', hits: [hitOf('AAA', 'up30', 0), hitOf('AAA', 'down80', 1)] } }], unpriced: [], session: '2026-10-09', ahead: 0 }, vNow);
  eq('hits are filed by kind and recency and listed in symbol order', [sortedRep.up30.latest.map(h => h.symbol), sortedRep.down80.earlier.map(h => h.symbol)], [['AAA', 'ZZZ'], ['AAA']]);
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
