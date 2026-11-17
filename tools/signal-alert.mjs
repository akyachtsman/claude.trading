#!/usr/bin/env node
/* The 10 AM trading-signal push: the week's rule 1-3 signals, ONE push, built with the dashboard's own rules.

     node tools/signal-alert.mjs --sp500 --tickers=file.txt --out=DIR   # the weekday run: S&P 500 + the watchlist tickers
     node tools/signal-alert.mjs --symbols=AAPL,MSFT                    # just these
     node tools/signal-alert.mjs --sp500 --as-of=2026-11-16             # the week through a past session, nothing live
     node tools/signal-alert.mjs ... --watchlist-failed                 # the watchlist could not be read: say so in the push

   Why it exists (owner 2026-11-17, moving INVEST's weekday 9:57 AM PT alert to this project; he chose "Dashboard's own rules"):
   the push and the Trading signals panel must never disagree, so the rules are NOT copied here. `layersRuleAt` and
   `layersSignals` are loaded out of scripts/layers.js and `stochSeries` / `WSTOCH` out of scripts/data.js — the very
   functions the Strategies Chart's dots and the Trading signals panel run. This file only fetches bars and words the push.

   What it tests (INVEST's alert spec, arash 2026-11-12): every weekday from this week's Monday through today in New York;
   a day before today on its final close, today on its forming bar (live while the market is open: 9:30-16:00 ET). A stock
   is listed once a side, at the FIRST day it fired that week and that day's price; two rules on one side are `rule 2+3`,
   and rules first fired on different days each keep their own day. Monday starts a new list.

   The push (arash 2026-11-12: "There should have been one push notification. all combined."): ONE title and ONE message,
   never one per signal. Title `📈📉 Trading this week: N LONG, M SHORT`; message `Since Mon 11/16, newest first. ...`, then
   `📈 LONG` / `📉 SHORT` with numbered lines `1. <b>TICKER</b> · $price · rule N · Tue 11/17` (Pushover's html=1), newest
   first-fired day first. Over 1,000 characters (Pushover's limit is 1,024) the oldest stock of whichever side has more
   is dropped and the message ends `+ N more in <--more-in>`. More than 5% of tickers unfetched, or `--watchlist-failed`,
   adds the incomplete-scan sentence; with no signal at all that sentence is the push (`⚠️ Trading scan incomplete`).
   No signal and a complete scan = an EMPTY title: send nothing.

   Output: JSON on stdout (ok, asOf, weekFrom, live, scanned, failed, failedSymbols, signals, lines, push). With --out=DIR it
   also writes DIR/title, DIR/msg and DIR/signals.txt (the record's SIGNAL lines). Sending is NOT done here: no key ever
   passes through this repository.

   Untrusted input: the watchlist roster is the owner's but the tickers file is data — only tickers matching TICKER_RE are
   read, index symbols (^) are dropped, and nothing but tickers, prices and dates leaves this script.

   Exit codes: 0 ok (a push or a quiet day), 1 bad arguments, 2 the scan failed (no S&P 500 list, nothing priced, or the
   time budget ran out with most of the list unread) — the run then sends `⚠️ Trading scan failed` instead. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TICKER_RE = /^[A-Z0-9.=-]{1,10}$/;        // app.js WL_SYM_RE without the index caret: indices are out of scope
export const SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';   // = desk-layers CONSTITUENTS_URL
const CHART_URL = s => 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s) + '?range=1y&interval=1d';
const UA = 'Mozilla/5.0';                                // Yahoo wants one; never sent to Supabase (see CLAUDE.md)
const LANES = 4;
const RETRY_WAITS_MS = [2000, 5000, 10000, 20000];       // Yahoo answers 429 to a burst of ~600 (INVEST, 2026-11-11)
const FETCH_TIMEOUT_MS = 15000;
const RUN_BUDGET_MS = 8 * 60 * 1000;
export const MAX_MSG = 1000;
export const INCOMPLETE_SHARE = 0.05;

/* ── the dashboard's own rules ─────────────────────────────────────────────── */
export function loadRules() {
  const stub = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const ctx = { console, Intl, Date, Math, JSON, window: {}, document: {}, location: { search: '' }, navigator: {}, localStorage: stub, sessionStorage: stub };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts/config.js'), 'utf8'), ctx, { filename: 'config.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts/data.js'), 'utf8'), ctx, { filename: 'data.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'scripts/layers.js'), 'utf8') +
    '\n;globalThis.__rules = { stochSeries, WSTOCH, layersSignals, layersWeekStart, LAYERS_RULES };', ctx, { filename: 'layers.js' });
  return ctx.__rules;
}

/* ── pure helpers (the unit test drives these) ─────────────────────────────── */
export const yahooSymbol = s => String(s).replace(/^([A-Z0-9]+)\.([A-Z])$/, '$1-$2');   // BRK.B -> BRK-B

/* Upper-case, dedupe, keep only well-formed tickers; an index (^VIX) is out of scope. */
export function universe(list) {
  const out = [], seen = new Set();
  for (const raw of list) {
    const t = String(raw == null ? '' : raw).trim().toUpperCase();
    if (!t || t.startsWith('^') || !TICKER_RE.test(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

export function parseConstituents(csv) {
  const rows = String(csv).split(/\r?\n/).filter(Boolean);
  const head = (rows.shift() || '').split(',').map(x => x.trim().replace(/^"|"$/g, '').toLowerCase());
  const iSym = head.indexOf('symbol');
  if (iSym < 0) throw new Error('constituents CSV has no Symbol column');
  const syms = rows.map(r => (r.split(',')[iSym] || '').trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (syms.length < 400) throw new Error(`constituents CSV holds only ${syms.length} symbols`);
  return syms;
}

/* Yahoo's v8 chart reply -> {t,o,h,l,c}, one bar per session dated on the EXCHANGE's own clock (gmtoffset). A bar with a
   missing or non-positive price is skipped, never repaired. */
export function parseChart(body) {
  const res = body && body.chart && Array.isArray(body.chart.result) ? body.chart.result[0] : null;
  if (!res) throw new Error('no chart result');
  const q = res.indicators && res.indicators.quote && res.indicators.quote[0];
  const ts = res.timestamp || [];
  if (!q) throw new Error('no quote block');
  const off = Number((res.meta && res.meta.gmtoffset) || 0);
  const b = { t: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < ts.length; i++) {
    const o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if (![o, h, l, c].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) || !Number.isFinite(ts[i])) continue;
    const d = new Date((ts[i] + off) * 1000).toISOString().slice(0, 10);
    if (b.t.length && b.t[b.t.length - 1] === d) {               // a second row for one session: keep the newer
      b.o[b.o.length - 1] = o; b.h[b.h.length - 1] = h; b.l[b.l.length - 1] = l; b.c[b.c.length - 1] = c;
      continue;
    }
    b.t.push(d); b.o.push(o); b.h.push(h); b.l.push(l); b.c.push(c);
  }
  return b;
}

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
export function nyNow(now = new Date()) {
  const p = Object.fromEntries(NY.formatToParts(now).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute, weekday: !['Sat', 'Sun'].includes(p.weekday) };
}
/* Today's session is still forming: a weekday between the 9:30 and 16:00 ET bell. (A holiday has no bar, so nothing
   fires; on an early-close day the label stays live after the 13:00 ET close, as INVEST's scanner does.) */
export function isLive(asOf, now = new Date()) {
  const n = nyNow(now);
  return asOf === n.day && n.weekday && n.mins >= 570 && n.mins < 960;
}

export function dayLabel(iso) {
  const d = new Date(String(iso) + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso)) || Number.isNaN(d.getTime())) return String(iso);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}

/* One stock's week: every rule that fired from Monday through asOf, with that day's close and 13-week %K. The bars are cut
   at asOf first, so a past as-of date never sees a later session. */
export function weekSignals(rules, sym, bars, asOf) {
  const n = bars.t.findLastIndex ? bars.t.findLastIndex(d => d <= asOf) : (() => { let j = -1; bars.t.forEach((d, i) => { if (d <= asOf) j = i; }); return j; })();
  if (n < 1) return [];
  const b = { t: bars.t.slice(0, n + 1), o: bars.o.slice(0, n + 1), h: bars.h.slice(0, n + 1), l: bars.l.slice(0, n + 1), c: bars.c.slice(0, n + 1) };
  const wk = rules.stochSeries(b, rules.WSTOCH);
  const out = [];
  for (const [name, d] of rules.layersSignals(b, wk, asOf)) {
    const i = b.t.indexOf(d);
    out.push({ sym, side: / BUY$/.test(name) ? 'LONG' : 'SHORT', rule: Number(name.charAt(5)), d, px: b.c[i], k: Number(wk.k[i]) });
  }
  return out;
}

/* The record's text lines, oldest day first, the same order and wording INVEST's alert posts in its thread. */
export function signalLines(signals, liveDay) {
  return [...signals].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : a.rule - b.rule || (a.sym < b.sym ? -1 : 1)))
    .map(s => `SIGNAL ${s.side} rule${s.rule} ${s.sym} ${s.d === liveDay ? '[live, not confirmed at close] price=' : 'close='}${s.px.toFixed(2)} stoch13w=${Number.isFinite(s.k) ? s.k.toFixed(0) : '?'} on=${s.d}`);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* The ONE push. Returns { title, msg }; an empty title means send nothing. */
export function buildPush({ signals, weekFrom, live, scanned, failed, watchlistFailed = false, moreIn = 'code.TRADE' }) {
  const parts = [];
  const tooMany = failed > INCOMPLETE_SHARE * scanned;
  if (tooMany) parts.push(`${failed} of ${scanned} tickers could not be fetched today, so signals may be missing.`);
  if (watchlistFailed) parts.push('The watchlist could not be read, so its stocks were not checked.');
  const inc = parts.join(' ');
  if (!signals.length) return inc ? { title: '⚠️ Trading scan incomplete', msg: inc } : { title: '', msg: '' };

  const by = { LONG: new Map(), SHORT: new Map() };
  for (const s of signals) {
    const r = by[s.side].get(s.sym) || { rules: new Map(), first: null, px: null };
    const was = r.rules.get(s.rule);
    if (!was || s.d < was) r.rules.set(s.rule, s.d);
    if (r.first == null || s.d < r.first) { r.first = s.d; r.px = s.px; }
    by[s.side].set(s.sym, r);
  }
  const rulesText = m => {
    const days = new Set(m.values());
    const keys = [...m.keys()].sort((a, b) => a - b);
    if (days.size === 1) return `rule ${keys.join('+')} · ${dayLabel([...days][0])}`;
    return keys.sort((a, b) => (m.get(a) < m.get(b) ? -1 : m.get(a) > m.get(b) ? 1 : a - b)).map(k => `rule ${k} ${dayLabel(m.get(k))}`).join(', ');
  };
  const rows = {};
  for (const side of ['LONG', 'SHORT']) {
    rows[side] = [...by[side]].map(([sym, r]) => ({ sym, first: r.first, line: `<b>${esc(sym)}</b> · $${r.px.toFixed(2)} · ${rulesText(r.rules)}` }))
      .sort((a, b) => (a.first > b.first ? -1 : a.first < b.first ? 1 : a.sym < b.sym ? -1 : 1));
  }
  const nl = rows.LONG.length, ns = rows.SHORT.length;
  const title = `${nl ? '📈' : ''}${ns ? '📉' : ''} Trading this week: ` + [nl ? `${nl} LONG` : '', ns ? `${ns} SHORT` : ''].filter(Boolean).join(', ');
  const head = [`Since ${dayLabel(weekFrom)}, newest first.` + (live ? " Today's are live at 10 AM, not confirmed at close; earlier days at their close." : " Each at its day's close.")];
  const tail = inc ? ['', '⚠️ ' + inc] : [];
  const build = show => {
    const body = []; let n = 0;
    for (const [side, ic] of [['LONG', '📈'], ['SHORT', '📉']]) {
      if (!rows[side].length) continue;
      body.push('', `${ic} ${side}`);
      for (const r of rows[side].slice(0, show[side])) body.push(`${++n}. ${r.line}`);
    }
    const more = nl + ns - n;
    return [...head, ...body, ...(more ? ['', `+ ${more} more in ${moreIn}`] : []), ...tail].join('\n');
  };
  const show = { LONG: nl, SHORT: ns };
  let msg = build(show);
  while (msg.length > MAX_MSG && show.LONG + show.SHORT > 0) {
    show[show.LONG >= show.SHORT ? 'LONG' : 'SHORT']--;
    msg = build(show);
  }
  return { title, msg };
}

/* ── network ────────────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function fetchBars(sym, deadline) {
  for (let a = 0; ; a++) {
    try { return parseChart(await getJson(CHART_URL(yahooSymbol(sym)))); } catch (e) {
      const retry = e.status ? (e.status === 429 || e.status >= 500) : !/no chart|no quote/.test(e.message);
      if (!retry || a >= RETRY_WAITS_MS.length || Date.now() + RETRY_WAITS_MS[a] > deadline) throw e;
      await sleep(RETRY_WAITS_MS[a]);
    }
  }
}

function parseArgs(argv) {
  const o = { sp500: false, tickers: null, symbols: null, asOf: null, out: null, watchlistFailed: false, moreIn: 'code.TRADE' };
  for (const a of argv) {
    let m;
    if (a === '--sp500') o.sp500 = true;
    else if (a === '--watchlist-failed') o.watchlistFailed = true;
    else if ((m = /^--tickers=(.+)$/.exec(a))) o.tickers = m[1];
    else if ((m = /^--symbols=(.+)$/.exec(a))) o.symbols = m[1].split(',');
    else if ((m = /^--as-of=(\d{4}-\d{2}-\d{2})$/.exec(a))) o.asOf = m[1];
    else if ((m = /^--out=(.+)$/.exec(a))) o.out = m[1];
    else if ((m = /^--more-in=(.{1,40})$/.exec(a))) o.moreIn = m[1];
    else throw new Error('unknown argument: ' + a);
  }
  if (!o.sp500 && !o.tickers && !o.symbols) throw new Error('nothing to scan: give --sp500, --tickers=FILE or --symbols=A,B');
  return o;
}

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  const rules = loadRules();
  const now = new Date();
  const ny = nyNow(now);
  const asOf = o.asOf || ny.day;
  const weekFrom = rules.layersWeekStart(asOf);
  const live = !o.asOf && isLive(asOf, now);
  const result = { ok: false, asOf, weekFrom, live, scanned: 0, failed: 0, failedSymbols: [], signals: [], lines: [], push: { title: '', msg: '' }, error: null };
  const finish = code => {
    process.stdout.write(JSON.stringify(result, null, 1) + '\n');
    if (o.out) {
      fs.mkdirSync(o.out, { recursive: true });
      fs.writeFileSync(path.join(o.out, 'title'), result.ok ? result.push.title : '');
      fs.writeFileSync(path.join(o.out, 'msg'), result.ok ? result.push.msg : '');
      fs.writeFileSync(path.join(o.out, 'signals.txt'), result.lines.join('\n') + (result.lines.length ? '\n' : ''));
    }
    return code;
  };

  let list = [];
  if (o.symbols) list.push(...o.symbols);
  if (o.tickers) {
    try { list.push(...fs.readFileSync(o.tickers, 'utf8').split(/\r?\n/)); } catch (e) { o.watchlistFailed = true; }
  }
  if (o.sp500) {
    try {
      const r = await fetch(SP500_URL, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      list.push(...parseConstituents(await r.text()));
    } catch (e) { result.error = 'S&P 500 list unreadable: ' + e.message; return finish(2); }
  }
  const syms = universe(list);
  result.scanned = syms.length;
  if (!syms.length) { result.error = 'no tickers to scan'; return finish(2); }

  const deadline = Date.now() + RUN_BUDGET_MS;
  let next = 0, priced = 0;
  const lane = async () => {
    while (next < syms.length) {
      const sym = syms[next++];
      if (Date.now() > deadline) { result.failed++; result.failedSymbols.push(sym); continue; }
      try {
        const bars = await fetchBars(sym, deadline);
        priced++;
        result.signals.push(...weekSignals(rules, sym, bars, asOf));
      } catch (e) { result.failed++; result.failedSymbols.push(sym); }
    }
  };
  await Promise.all(Array.from({ length: LANES }, lane));
  if (!priced) { result.error = 'no ticker could be fetched'; return finish(2); }
  if (result.failed > result.scanned / 2) { result.error = `${result.failed} of ${result.scanned} tickers could not be fetched`; return finish(2); }

  result.failedSymbols.sort();
  result.lines = signalLines(result.signals, live ? asOf : null);
  result.push = buildPush({ signals: result.signals, weekFrom, live, scanned: result.scanned, failed: result.failed, watchlistFailed: o.watchlistFailed, moreIn: o.moreIn });
  result.ok = true;
  return finish(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 2; });
}
