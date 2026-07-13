'use strict';
/* ── data.js — mode resolution, demo generation, public loaders, staleness ──
   Depends on config.js (DESK_ACCOUNTS, DESK_DB). No DOM access here. */

/* ── formatters ────────────────────────────────────────────────────────── */
const fmtUsd = v => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd0 = v => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtSigned = v => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';

/* ── deterministic demo series ─────────────────────────────────────────── */
const DEMO_DAYS = 260; /* > 252 so every timeframe is exercisable in demo */
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function walk(seed, start, drift, vol, n, end) {
  const rnd = lcg(seed), out = [start]; let v = start;
  for (let i = 1; i < n; i++) { v *= 1 + drift + (rnd() - 0.5) * vol; out.push(v); }
  if (end === undefined) return out;
  const scale = end / out[n - 1];
  return out.map((x, i) => x * Math.pow(scale, i / (n - 1)));
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/* Observed US market holidays covering the label window (extend yearly). */
const US_HOLIDAYS = new Set([
  '2025-07-04','2025-09-01','2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25',
  '2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31',
]);
const isoDate = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const isTradingDay = d => d.getDay() !== 0 && d.getDay() !== 6 && !US_HOLIDAYS.has(isoDate(d));
function lastTradingDay(from) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (!isTradingDay(d)) d.setDate(d.getDate() - 1);
  return d;
}
function tradingDayLabels(n, endDate) {
  const out = []; const d = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (out.length < n) {
    if (isTradingDay(d)) out.unshift(MONTHS[d.getMonth()] + ' ' + d.getDate());
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/* ── demo dataset (2 accounts, mirrors the real roster size) ───────────── */
const DEMO_POSITIONS = {
  1: [
    ['NVDA', 340, 58282.80, 1.84, 21140.20],
    ['MSFT', 120, 61452.00, 0.92, 9822.00],
    ['AAPL', 260, 60491.60, -0.34, 6410.40],
    ['AMZN', 180, 44289.00, 1.12, 5230.80],
    ['SPY',  220, 138688.00, 0.54, 12904.00],
  ],
  2: [
    ['VTI',  480, 150024.00, 0.48, 28110.00],
    ['SCHD', 620, 18500.80, 0.21, 2205.60],
    ['TLT',  310, 27472.20, -0.65, -1830.40],
    ['BRK.B', 240, 59496.00, 0.35, 12523.00],
  ],
};
const DEMO_FINANCIALS = {
  1: { nav: 412386.54, day: 3241.12, total: 58212.40, cash: 31200.00 },
  2: { nav: 268930.77, day: 1102.36, total: 41008.19, cash: 12400.00 },
};

function buildDemoData() {
  const asOfDate = lastTradingDay(new Date());
  const labels = tradingDayLabels(DEMO_DAYS, asOfDate);
  const accounts = DESK_ACCOUNTS.map(a => {
    const fin = DEMO_FINANCIALS[a.key] || DEMO_FINANCIALS[1];
    return {
      key: a.key, label: a.label, code: a.code,
      nav: fin.nav, day: fin.day, total: fin.total, cash: fin.cash,
      positions: (DEMO_POSITIONS[a.key] || DEMO_POSITIONS[1]).map(p => ({ sym: p[0], qty: p[1], mkt: p[2], dayPct: p[3], unrl: p[4] })),
      equity: walk(a.seed, fin.nav - fin.total * 0.6, a.drift, a.vol, DEMO_DAYS, fin.nav),
    };
  });
  const market = [
    { name: 'S&P 500',      last: '6,318.42',  chg: 0.54,  seed: 11 },
    { name: 'Nasdaq 100',   last: '23,104.88', chg: 0.81,  seed: 23 },
    { name: 'Dow Jones',    last: '44,912.30', chg: 0.12,  seed: 37 },
    { name: 'IWM (R2K proxy)', last: '228.12', chg: -0.33, seed: 41 },
    { name: 'VIX',          last: '14.82',     chg: -4.20, seed: 53 },
    { name: 'US 10Y',       last: '4.31%',     chg: 0.05,  seed: 67 },
  ].map(m => ({ ...m, spark: walk(m.seed, 100, m.chg >= 0 ? 0.001 : -0.001, 0.02, 30, m.chg >= 0 ? 102 : 98) }));
  const news = [
    { t: '15:58', src: 'Reuters',   h: 'S&P 500 ends higher as megacap tech extends rally', chips: [['SPY', 0.54]] },
    { t: '15:41', src: 'Bloomberg', h: 'Nvidia supplier checks point to firm data-center demand', chips: [['NVDA', 1.84]] },
    { t: '14:55', src: 'CNBC',      h: 'Microsoft to detail AI capex plans at next earnings call', chips: [['MSFT', 0.92]] },
    { t: '14:02', src: 'Reuters',   h: 'Treasury yields edge up ahead of CPI report', chips: [['TLT', -0.65]] },
    { t: '13:20', src: 'Bloomberg', h: 'Apple services growth seen slowing this quarter, analysts say', chips: [['AAPL', -0.34]] },
    { t: '11:47', src: 'Reuters',   h: 'Small caps lag as rate-cut bets get pushed out', chips: [['IWM', -0.41]] },
    { t: '10:15', src: 'CNBC',      h: 'Amazon Prime Day sales tracking ahead of last year', chips: [['AMZN', 1.12]] },
    { t: '09:36', src: 'Bloomberg', h: 'Volatility drifts lower; VIX under 15 for third session', chips: [['VIX', -4.20]] },
  ];
  return { accounts, market, news, labels, asOfDate, brief: buildDemoBrief(accounts) };
}

/* Demo brief derives its numbers from the demo snapshot — same shape the
   live RPC payload uses, so the renderer is shared with Phase D. */
function buildDemoBrief(accounts) {
  const totalNav = accounts.reduce((s, a) => s + a.nav, 0);
  const totalDay = accounts.reduce((s, a) => s + a.day, 0);
  const dayPct = totalDay / (totalNav - totalDay) * 100;
  const best = accounts.reduce((x, a) => (a.day > x.day ? a : x), accounts[0]);
  const allPos = accounts.flatMap(a => a.positions.map(p => ({ ...p, acct: a.label })));
  const mover = allPos.reduce((x, p) => (Math.abs(p.unrl) > Math.abs(x.unrl) ? p : x), allPos[0]);
  const cashPct = accounts.reduce((s, a) => s + a.cash, 0) / totalNav * 100;
  return {
    generatedAt: 'Demo',
    state: 'Net liquidation across ' + accounts.length + ' accounts is ' + fmtUsd0(totalNav)
      + ', ' + (totalDay >= 0 ? 'up ' : 'down ') + fmtPct(Math.abs(dayPct)).slice(1)
      + ' on the day. ' + best.label + ' led with ' + fmtSigned(best.day) + '.',
    levels: [
      mover.sym + ' carries the largest open P&L (' + fmtSigned(mover.unrl) + ') in ' + mover.acct + '.',
      'Portfolio cash is ' + Math.round(cashPct) + '% of net liquidation.',
      'SPY closed at 630.4 — 1.1% below its recent high (demo figure).',
    ],
    scenarios: [
      'CPI prints Thursday — a hot print pressures the rate-sensitive sleeve (TLT, SCHD).',
      'Concentration: the top holding exceeds 10% of one account — a single-name drawdown moves the whole window.',
    ],
  };
}

/* Demo heatmap — deterministic (seeded pct), rough caps; same shape as the
   pipeline's data/heatmap.json so the renderer is shared. */
const DEMO_HEAT_SECTORS = [
  ['Information Technology', [['NVDA', 4200, 'Semiconductors'], ['MSFT', 3700, 'Software - Infrastructure'], ['AAPL', 3300, 'Consumer Electronics'], ['AVGO', 1200, 'Semiconductors'], ['ORCL', 620, 'Software - Infrastructure'], ['AMD', 340, 'Semiconductors'], ['CRM', 250, 'Software - Application'], ['INTC', 130, 'Semiconductors']]],
  ['Communication Services', [['GOOGL', 2400, 'Internet Content'], ['META', 1700, 'Internet Content'], ['NFLX', 540, 'Entertainment'], ['DIS', 210, 'Entertainment'], ['T', 150, 'Telecom Services']]],
  ['Consumer Discretionary', [['AMZN', 2300, 'Internet Retail'], ['TSLA', 1100, 'Auto Manufacturers'], ['HD', 380, 'Home Improvement'], ['MCD', 220, 'Restaurants'], ['NKE', 110, 'Apparel']]],
  ['Financials', [['BRK.B', 1000, 'Insurance - Diversified'], ['JPM', 700, 'Banks - Diversified'], ['V', 620, 'Credit Services'], ['MA', 500, 'Credit Services'], ['BAC', 330, 'Banks - Diversified'], ['WFC', 240, 'Banks - Diversified']]],
  ['Health Care', [['LLY', 800, 'Drug Manufacturers'], ['UNH', 480, 'Healthcare Plans'], ['JNJ', 420, 'Drug Manufacturers'], ['ABBV', 340, 'Drug Manufacturers'], ['MRK', 260, 'Drug Manufacturers']]],
  ['Industrials', [['GE', 260, 'Aerospace & Defense'], ['CAT', 200, 'Farm & Heavy Machinery'], ['RTX', 190, 'Aerospace & Defense'], ['UPS', 110, 'Integrated Freight'], ['BA', 130, 'Aerospace & Defense']]],
  ['Consumer Staples', [['WMT', 800, 'Discount Stores'], ['COST', 430, 'Discount Stores'], ['PG', 400, 'Household Products'], ['KO', 300, 'Beverages'], ['PEP', 230, 'Beverages']]],
  ['Energy', [['XOM', 520, 'Oil & Gas Integrated'], ['CVX', 280, 'Oil & Gas Integrated'], ['COP', 130, 'Oil & Gas E&P']]],
  ['Utilities', [['NEE', 170, 'Utilities - Regulated'], ['SO', 100, 'Utilities - Regulated'], ['DUK', 90, 'Utilities - Regulated']]],
  ['Real Estate', [['PLD', 110, 'REIT - Industrial'], ['AMT', 95, 'REIT - Specialty'], ['EQIX', 85, 'REIT - Specialty']]],
  ['Materials', [['LIN', 220, 'Specialty Chemicals'], ['SHW', 90, 'Specialty Chemicals'], ['APD', 65, 'Specialty Chemicals']]],
];
function buildDemoHeatmap() {
  const rnd = lcg(97);
  const sectors = DEMO_HEAT_SECTORS.map(([name, list]) => {
    const tiles = list.map(([sym, capB, ind]) => ({
      sym, name: sym, cap: capB * 1e9, ind,
      pct: Number(((rnd() - 0.47) * 3.4).toFixed(2)),
      last: Number((30 + rnd() * 500).toFixed(2)),
    }));
    return { name, cap: tiles.reduce((s, t) => s + t.cap, 0), tiles };
  }).sort((a, b) => b.cap - a.cap);
  return { asOf: isoDate(lastTradingDay(new Date())), source: 'demo', sectors };
}

/* ── charts panel: demo OHLCV, weekly aggregation, stochastics ─────────── */
const CHART_BARS = 330; /* matches the pipeline's KEEP_BARS: 1y view + warmup */
const STOCH = { k: 13, kSmooth: 3, d: 3 }; /* 13-period slow — 13 days / 13 weeks */

function tradingISODates(n, endDate) {
  const out = []; const d = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
  while (out.length < n) {
    if (isTradingDay(d)) out.unshift(isoDate(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

const DEMO_CHART_SYMBOLS = [
  ['SPY', 5, 630, 0.00035, 0.010, 60], ['QQQ', 7, 560, 0.00045, 0.014, 45],
  ['DIA', 11, 449, 0.00025, 0.008, 4], ['IWM', 13, 228, 0.0001, 0.014, 30],
  ['SMH', 17, 285, 0.0006, 0.019, 8], ['XLF', 19, 52, 0.0002, 0.009, 40],
  ['XLE', 23, 92, -0.0001, 0.013, 18], ['GLD', 29, 312, 0.0004, 0.008, 7],
  ['TLT', 31, 87, -0.0002, 0.007, 25], ['VXX', 37, 44, -0.0009, 0.035, 6],
];
function buildDemoCharts() {
  const t = tradingISODates(CHART_BARS, lastTradingDay(new Date()));
  const symbols = {};
  for (const [sym, seed, end, drift, vol, mVol] of DEMO_CHART_SYMBOLS) {
    const rnd = lcg(seed * 1013);
    const s = { t, o: [], h: [], l: [], c: [], v: [] };
    let close = end / Math.exp(drift * CHART_BARS); /* walk forward toward `end` */
    for (let i = 0; i < CHART_BARS; i++) {
      const prev = close;
      close = prev * (1 + drift + (rnd() - 0.5) * 2 * vol);
      const open = prev * (1 + (rnd() - 0.5) * vol * 0.6);
      const hi = Math.max(open, close) * (1 + rnd() * vol * 0.7);
      const lo = Math.min(open, close) * (1 - rnd() * vol * 0.7);
      s.o.push(+open.toFixed(2)); s.h.push(+hi.toFixed(2));
      s.l.push(+lo.toFixed(2)); s.c.push(+close.toFixed(2));
      s.v.push(Math.round(mVol * 1e6 * (0.55 + rnd() * 0.9)));
    }
    symbols[sym] = s;
  }
  return { asOf: t[t.length - 1], source: 'demo', count: DEMO_CHART_SYMBOLS.length, symbols };
}

/* Daily packed series → weekly bars (t = last trading day of each ISO week). */
function toWeeklyBars(s) {
  const w = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let key = null;
  for (let i = 0; i < s.t.length; i++) {
    const d = new Date(s.t[i] + 'T12:00:00Z');
    const monday = new Date(d.getTime() - (((d.getUTCDay() + 6) % 7) * 86400000));
    const k = monday.toISOString().slice(0, 10);
    if (k !== key) {
      key = k;
      w.t.push(s.t[i]); w.o.push(s.o[i]); w.h.push(s.h[i]); w.l.push(s.l[i]); w.c.push(s.c[i]); w.v.push(s.v[i]);
    } else {
      const j = w.t.length - 1;
      w.t[j] = s.t[i];
      w.h[j] = Math.max(w.h[j], s.h[i]); w.l[j] = Math.min(w.l[j], s.l[i]);
      w.c[j] = s.c[i]; w.v[j] += s.v[i];
    }
  }
  return w;
}

/* Slow stochastic on packed bars: raw %K over `k` bars → SMA(kSmooth) → %D =
   SMA(d). Warmup slots are null. Flat ranges read 50 (no signal, not a spike). */
function stochSeries(s, { k, kSmooth, d } = STOCH) {
  const n = s.c.length;
  const raw = new Array(n).fill(null);
  for (let i = k - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - k + 1; j <= i; j++) { if (s.h[j] > hi) hi = s.h[j]; if (s.l[j] < lo) lo = s.l[j]; }
    raw[i] = hi === lo ? 50 : (s.c[i] - lo) / (hi - lo) * 100;
  }
  const sma = (arr, len) => arr.map((_, i) => {
    if (i < len - 1) return null;
    let sum = 0;
    for (let j = i - len + 1; j <= i; j++) { if (arr[j] == null) return null; sum += arr[j]; }
    return sum / len;
  });
  const kLine = sma(raw, kSmooth);
  return { k: kLine, d: sma(kLine, d) };
}

/* ── mode resolution + public loaders (live mode) ──────────────────────── */
function resolveMode() {
  const q = new URLSearchParams(location.search);
  if (q.get('demo') === '1') return 'demo';
  return DESK_DB.url ? 'live' : 'demo';
}

async function fetchPublic(path) {
  const res = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

/* Panel lamp state from a domain's own embedded as-of date (wins over meta —
   CDN generation skew rule). Returns {cls, text, stampText}. */
function lampFor(asOfIso, now) {
  const ltd = isoDate(lastTradingDay(now || new Date()));
  if (!asOfIso) return { cls: 'lamp--stale', text: 'NO DATA', stamp: '—' };
  const fresh = asOfIso >= ltd;
  return fresh
    ? { cls: 'lamp--eod', text: 'EOD', stamp: 'As of ' + asOfIso }
    : { cls: 'lamp--stale', text: 'STALE', stamp: 'As of ' + asOfIso + ' — refresh overdue' };
}

/* Auth: PIN-validated Supabase RPCs (SECURITY DEFINER, anon-only EXECUTE).
   Two plain fetch calls — no client library needed for /rest/v1/rpc. */
async function deskRpc(fn, pin) {
  const res = await fetch(DESK_DB.url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) throw new Error(fn + ' → HTTP ' + res.status);
  return res.json();
}
async function deskLogin(pin) {
  const out = await deskRpc('desk_login', pin);
  return out && out.ok ? out : { ok: false, error: 'PIN not recognized — try again.' };
}
async function deskGetDashboard(pin) {
  const out = await deskRpc('desk_get_dashboard', pin);
  return out && out.ok ? out : null;
}

/* Ask-the-desk: PIN-gated Claude Q&A over the visible dashboard content.
   The Anthropic key lives only in the edge function's secrets (FR-D1). */
async function deskAsk(pin, question, context) {
  const res = await fetch(DESK_DB.url + '/functions/v1/desk-ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify({ pin, question, context }),
  });
  const out = await res.json().catch(() => null);
  if (!out) throw new Error('desk-ask → HTTP ' + res.status);
  return out; /* {ok:true, answer} | {ok:false, error} */
}

/* Quote-proxy: PIN-gated OHLC for ANY ticker, fetched server-side through
   the pipeline's free-source chain (Stooq → Yahoo; Yahoo for intraday).
   Free-tier quotes by owner ruling — near-real-time US, delayed elsewhere. */
async function deskQuote(pin, symbol, kind) {
  const res = await fetch(DESK_DB.url + '/functions/v1/quote-proxy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify({ pin, symbol, kind: kind || 'daily' }),
  });
  const out = await res.json().catch(() => null);
  if (!out) throw new Error('quote-proxy → HTTP ' + res.status);
  return out; /* {ok:true, symbol, kind, asOf, series:{t,o,h,l,c,v}} | {ok:false, error} */
}

/* Extra map universes (Crypto/Futures/World): delayed quotes fetched on
   demand through the desk-maps edge function (fixed server-side roster, no
   PIN — public data; owner ruling 2026-07-13 replaced the nightly batch). */
async function deskMaps() {
  const res = await fetch(DESK_DB.url + '/functions/v1/desk-maps', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: '{}',
  });
  const out = await res.json().catch(() => null);
  if (!out) throw new Error('desk-maps → HTTP ' + res.status);
  return out; /* {ok:true, asOf, generatedAt, cuts:{crypto|futures|world}} | {ok:false, error} */
}

/* Public live feeds (retire-nightly-pipeline Group A): each desk-* edge
   function replaces one committed data/*.json snapshot with the same shape
   plus {ok, generatedAt}. Anon-callable, fixed upstreams server-side. */
async function deskFeed(name) {
  const res = await fetch(DESK_DB.url + '/functions/v1/' + name, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: '{}',
  });
  const out = await res.json().catch(() => null);
  if (!out || !out.ok) throw new Error(name + ' → ' + (out && out.error ? out.error : 'HTTP ' + res.status));
  return out;
}

/* US equities session gate for the feed poller cadence (spec Clarification
   6). Mirrors the Deno copies in supabase/functions/desk-* — keep the
   holiday list in sync there when refreshing it annually (2026–2027). */
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
function marketSessionOpen(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now || new Date());
  const get = t => { const p = parts.find(x => x.type === t); return p ? p.value : ''; };
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  if (NYSE_HOLIDAYS.has(get('year') + '-' + get('month') + '-' + get('day'))) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/* Two-tier lamp for live feeds (FR-R7): the lamp class answers "how fresh
   is the FETCH" (LIVE ≤ 6 min), the stamp always carries the payload's own
   data as-of so a LIVE lamp can never overstate quote freshness. */
function liveLampFor(generatedAt, dataAsOf) {
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  const t = String(generatedAt).slice(11, 16) + ' UTC';
  const fresh = Number.isFinite(ageMs) && ageMs <= 6 * 60000;
  return fresh
    ? { cls: 'lamp--live', text: 'LIVE', stamp: 'Fetched ' + t + (dataAsOf ? ' · data as of ' + dataAsOf : '') }
    : { cls: 'lamp--stale', text: 'STALE', stamp: 'Last fetch ' + t + ' — refresh overdue' };
}

/* Map the RPC payload into the render model app.js uses (same shape demo
   mode builds). Equity series are aligned on dates present for EVERY
   account so the consolidated sum is well-defined. */
function mapDashboardPayload(payload) {
  const byDate = new Map();
  for (const row of payload.equity) {
    if (!byDate.has(row.as_of)) byDate.set(row.as_of, {});
    byDate.get(row.as_of)[row.account_key] = Number(row.nav);
  }
  const acctKeys = payload.accounts.map(a => a.account_key);
  const dates = [...byDate.keys()].sort().filter(d => acctKeys.every(k => byDate.get(d)[k] !== undefined));
  const labels = dates.map(d => {
    const [y, m, day] = d.split('-').map(Number);
    return MONTHS[m - 1] + ' ' + day;
  });
  const cfgByKey = Object.fromEntries(DESK_ACCOUNTS.map(a => [a.key, a]));
  const accounts = payload.accounts.map(a => ({
    key: a.account_key,
    label: a.label || (cfgByKey[a.account_key] || {}).label || 'Account ' + a.account_key,
    code: (cfgByKey[a.account_key] || {}).code || '',
    nav: Number(a.nav), day: Number(a.day_pnl), total: Number(a.total_unrl), cash: Number(a.cash),
    positions: (a.positions || []).map(p => ({ sym: p.sym, qty: p.qty, mkt: Number(p.mkt), dayPct: Number(p.dayPct), unrl: Number(p.unrl) })),
    equity: dates.map(d => byDate.get(d)[a.account_key]),
    asOf: a.as_of,
  }));
  let brief = null;
  if (payload.brief && payload.brief.content) {
    const c = payload.brief.content;
    brief = {
      generatedAt: (payload.brief.generated_at || '').slice(0, 16).replace('T', ' ') + ' UTC',
      state: c.state || '', levels: c.levels || [], scenarios: c.scenarios || [],
      asOf: payload.brief.as_of,
    };
  }
  return { accounts, labels, brief, asOf: accounts.length ? accounts[0].asOf : null };
}
