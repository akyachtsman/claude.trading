'use strict';
/* ── data.js — mode resolution, demo generation, public loaders, staleness ──
   Depends on config.js (DESK_ACCOUNTS, DESK_DB). No DOM access here. */

/* ── formatters ────────────────────────────────────────────────────────── */
const fmtUsd = v => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUsd0 = v => (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtSigned = v => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';

/* ── deterministic demo series ─────────────────────────────────────────── */
const DEMO_DAYS = 260; /* > 252 so the account cards' 1-year sparkline fills in demo */
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
    /* extras folded in from the old ticker tape (owner request 2026-07-16) —
       best-effort tiles live; deterministic here */
    { name: 'Bitcoin',      last: '64,216.00', chg: -0.77, seed: 71 },
    { name: 'Gold',         last: '2,634.50',  chg: 0.31,  seed: 83 },
    { name: 'US Dollar',    last: '104.28',    chg: -0.12, seed: 89 },
    /* Owner request 2026-07-16: watchlist ETFs + all 11 SPDR sectors as strip
       tiles (SPY/QQQ/DIA/IWM/VXX skipped — already shown as indices above).
       Live tiles come from desk-market; this is the deterministic demo mirror. */
    ...[
      ['XLK', 258.40, 0.72], ['XLF', 52.18, 0.31], ['XLE', 91.40, -0.44],
      ['XLI', 148.90, 0.28], ['XLB', 92.10, -0.12], ['XLV', 146.30, 0.19],
      ['XLY', 224.60, 0.83], ['XLP', 82.40, -0.06], ['XLU', 81.20, 0.41],
      ['XLRE', 41.30, 0.24], ['XLC', 108.70, 0.55], ['SMH', 284.90, -0.97],
      ['KRE', 62.80, 0.66], ['GLD', 311.20, 0.30], ['SLV', 30.15, 0.88],
      ['TLT', 86.40, -0.21], ['TLH', 108.90, -0.15], ['SHY', 82.60, 0.02],
      ['UUP', 27.85, -0.12], ['EEM', 46.20, 0.35], ['FXI', 33.10, 1.02],
      ['INDA', 54.70, 0.26], ['JPXN', 72.40, 0.44], ['SPYD', 43.90, 0.21],
    ].map(([name, price, chg], i) => ({ name, last: price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), chg, seed: 101 + i * 6 })),
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
  return { accounts, market, news, labels, asOfDate, markets: buildDemoMarkets() };
}

/* Demo heatmap — deterministic (seeded pct), rough caps; same shape as the
   desk-heatmap feed payload so the renderer is shared. */
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

/* Markets window demo — normalized %-change series per index for each
   timeframe. A detrended random walk pinned to 0 at the start and to the index's
   end-% at the right edge, so the shape is organic but the endpoints are stable.
   Tiles + sector cells are read from the shared market feed (renderMarkets), so
   only the chart series are generated here. */
function pctWalk(seed, n, endPct, vol) {
  const rnd = lcg(seed), noise = [0]; let v = 0;
  for (let i = 1; i < n; i++) { v += (rnd() - 0.5) * vol; noise.push(v); }
  const a = noise[0], b = noise[n - 1] || 0;
  /* subtract the endpoint line (→ both ends 0), then add a ramp to endPct */
  return noise.map((x, i) => Number((x - (a + (b - a) * i / (n - 1)) + endPct * i / (n - 1)).toFixed(3)));
}
const MKT_TF_META = [
  ['today', 78, 0.16], ['5d', 130, 0.30], ['1m', 22, 0.55], ['1y', 120, 1.6], ['2y', 120, 2.6],
];
const MKT_DEMO_ENDS = {   /* today-% matches the demo index tiles (S&P/Nasdaq/Dow/IWM chg) */
  sp: { today: 0.54, '5d': 1.1, '1m': 2.3, '1y': 14.2, '2y': 31.0 },
  nq: { today: 0.81, '5d': 1.6, '1m': 3.1, '1y': 19.5, '2y': 42.0 },
  ru: { today: -0.33, '5d': 0.4, '1m': -1.2, '1y': 6.8, '2y': 11.0 },
  dj: { today: 0.12, '5d': 0.6, '1m': 1.4, '1y': 9.5, '2y': 18.0 },
};
function buildDemoMarkets() {
  const series = {};
  let seed = 311;
  for (const [tf, n, vol] of MKT_TF_META) {
    series[tf] = {};
    for (const key of ['sp', 'nq', 'ru', 'dj']) series[tf][key] = pctWalk(seed += 7, n, MKT_DEMO_ENDS[key][tf], vol);
  }
  return { asOf: isoDate(lastTradingDay(new Date())), source: 'demo', series };
}

/* ── charts panel: demo OHLCV, weekly aggregation, stochastics ─────────── */
const CHART_BARS = 800; /* matches the feeds' KEEP_BARS: ~3y view + warmup */
/* Stochastic settings — REVERSE-ENGINEERED from the owner's reference terminal
   by fitting its hover readouts on live INTC data (2026-07-22, three independent
   anchors: Jan 12, Jan 28, Apr 15 2026 — all 12 values reproduced to ±0.02):
   - Daily  = 14-3-3 slow on daily bars. (Earlier 13-vs-14 confusion: 13 matched
     one saturated ~96 readout by coincidence; 14 matches all three anchors.)
   - Weekly = 92-15-15 slow on DAILY bars — the terminal's "weekly" is a
     scaled-period daily stochastic, not one computed on weekly bars. That's
     also why its weekly line is smooth and still updates daily. */
const STOCH = { k: 14, kSmooth: 3, d: 3 };
const WSTOCH = { k: 92, kSmooth: 15, d: 15 };
/* Intraday (Pro 3) — fitted 2026-07-22 from the terminal's Pro 3 hover readout
   (INTC, bar Jul 21 10:00 ET): the terminal's Pro 3 runs 15-MINUTE bars (its
   hover OHLC matched our 5-min feed aggregated to 15-min exactly, ±0.02), and
   the readout %K 79.21/%D 59.86 fits 10-3-3 slow (err 0.078). Single-anchor
   fit — %K alone was lookback-degenerate, %D picked 10 — but corroborated
   independently: the source course deck documents "slow smooth K-10 D-3"
   (strategies/stochastic-investing.md). So the terminal's tiers are
   10-3-3 intraday / 14-3-3 daily / 92-15-15 weekly-scale. */
const ISTOCH = { k: 10, kSmooth: 3, d: 3 };

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

/* (The standalone weekly/monthly bar resamplers were removed 2026-07-19: the
   weekly stochastic now resamples daily bars into ISO-week bars inline and runs
   the same STOCH periods on them, interpolating across days so it updates daily —
   see weeklyStochOnDaily in app.js — and nothing else consumed the old ones.) */

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

/* Panel lamp state from a domain's own embedded as-of date (EOD-class data:
   private snapshots). Live feeds use liveLampFor instead. */
function lampFor(asOfIso, now) {
  const ltd = isoDate(lastTradingDay(now || new Date()));
  if (!asOfIso) return { cls: 'lamp--stale', text: 'NO DATA', stamp: '—' };
  const fresh = asOfIso >= ltd;
  return fresh
    ? { cls: 'lamp--eod', text: 'EOD', stamp: fmtUpdated(null, asOfIso) }
    : { cls: 'lamp--stale', text: 'STALE', stamp: fmtUpdated(null, asOfIso) + ' — refresh overdue' };
}

/* Accounts/equity are IBKR END-OF-DAY statements: a session's statement only
   finalizes after that session closes and rolls overnight, so "yesterday's
   close during today's session" is the freshest data that EXISTS — not stale
   (owner ruling 2026-07-15). Fresh if the statement is within the normal
   one-trading-day roll lag; STALE only if it falls further behind (the sync
   genuinely stopped). The stamp shows the REAL sync time (created_at, local
   zone) and which session the figures run through — the account snapshot has no
   intraday clock, so this replaces the misleading bare "STALE". */
function accountsLampFor(asOfIso, syncedAtIso, now) {
  if (!asOfIso) return { cls: 'lamp--stale', text: 'NO DATA', stamp: '—' };
  const n = now || new Date();
  const ltd = lastTradingDay(n);
  const prevTd = lastTradingDay(new Date(ltd.getFullYear(), ltd.getMonth(), ltd.getDate() - 1));
  const fresh = asOfIso >= isoDate(prevTd);   /* allow the overnight-roll lag */
  /* "Accounts synced" (not "Last updated" — owner request 2026-07-22): this
     stamp sits directly under the MARKETS-labeled masthead cluster, which now
     ALSO reads "Last updated" — identical wording on two different things
     reads as one duplicated stamp. Same sync clock · statement-day content,
     distinct label. */
  const parts = [syncedAtIso ? fmtClock(syncedAtIso) : '', fmtShortDate(asOfIso)].filter(Boolean);
  const stamp = parts.length ? 'Accounts synced ' + parts.join(' · ') : '';
  return fresh
    ? { cls: 'lamp--eod', text: 'EOD', stamp }
    : { cls: 'lamp--stale', text: 'STALE', stamp: stamp + ' — sync overdue' };
}

/* Auth: PIN-validated Supabase RPCs (SECURITY DEFINER, anon-only EXECUTE).
   Two plain fetch calls — no client library needed for /rest/v1/rpc. `extra`
   merges additional named args into the RPC body (e.g. desk_set_system_prompt's
   new_content) alongside pin. */
async function deskRpc(fn, pin, extra) {
  const res = await fetch(DESK_DB.url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify({ pin, ...(extra || {}) }),
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

/* Ask-the-desk conversation memory (desk_008): PIN-gated SECURITY DEFINER RPCs.
   History returns a jsonb array of prior exchanges (oldest→newest); clear wipes
   all stored history for the desk. Both fail soft — memory is best-effort. */
async function deskChatHistory(pin) {
  try { const out = await deskRpc('desk_chat_history', pin); return Array.isArray(out) ? out : []; }
  catch { return []; }
}
async function deskChatClear(pin) {
  try { return await deskRpc('desk_chat_clear', pin); }
  catch { return { ok: false }; }
}

/* Ask-the-desk system prompt (desk_009): PIN-gated read/write of the full
   text desk-ask sends the model as `system` on every call — the owner's
   self-service alternative to asking Claude Code to edit and redeploy
   supabase/functions/desk-ask/index.ts. */
async function deskGetSystemPrompt(pin) {
  try { const out = await deskRpc('desk_get_system_prompt', pin); return out && out.ok ? out : { ok: false }; }
  catch { return { ok: false }; }
}
async function deskSetSystemPrompt(pin, content) {
  try { const out = await deskRpc('desk_set_system_prompt', pin, { new_content: content }); return out && out.ok ? out : { ok: false }; }
  catch { return { ok: false }; }
}

/* Ask-the-desk: PIN-gated agentic Claude assistant (memory replay + web research
   + live get_quote). The Anthropic key lives only in the edge function's
   secrets (FR-D1); the answer carries a sources[] array of web citations. */
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
  return out; /* {ok:true, answer, sources} | {ok:false, error} */
}

/* Quote-proxy: OHLC for ANY ticker, fetched server-side through the pipeline's
   free-source chain (Stooq → Yahoo; Yahoo for intraday). No PIN — the function
   is origin-guarded instead (owner ruling 2026-07-14); anyone on the site can
   chart any symbol. Free-tier quotes — near-real-time US, delayed elsewhere. */
async function deskQuote(symbol, kind) {
  const res = await fetch(DESK_DB.url + '/functions/v1/quote-proxy', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify({ symbol, kind: kind || 'daily' }),
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
async function deskFeed(name, params) {
  const res = await fetch(DESK_DB.url + '/functions/v1/' + name, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: DESK_DB.anonKey,
      authorization: 'Bearer ' + DESK_DB.anonKey,
    },
    body: JSON.stringify(params || {}),
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

/* Display clocks in the VIEWER'S local timezone (owner ruling 2026-07-15):
   server timestamps are UTC ISO strings — parse and render them in the
   browser's own zone. Absolute trading-day dates (asOf) and the market-session
   logic above stay UTC/ET; only these wall-clock display stamps localize. */
/* Every clock on the desk reads PACIFIC (owner ruling 2026-07-22) — pinned to
   America/Los_Angeles rather than the viewer's locale, so stamps, bar times,
   and news times agree with the owner's clock everywhere. */
const DESK_TZ = 'America/Los_Angeles';
function fmtClock(iso) {         /* "HH:mm PDT/PST"; '' if unparseable */
  const d = new Date(iso);
  return isNaN(d.getTime()) ? ''
    : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short', timeZone: DESK_TZ });
}
/* intraday bar stamp: feed times are UTC 'YYYY-MM-DD HH:mm' → Pacific display;
   date-only daily bars pass through untouched */
function fmtBarT(t) {
  if (!t || t.length <= 10) return t;
  const d = new Date(t.replace(' ', 'T') + ':00Z');
  if (isNaN(d.getTime())) return t;
  return d.toLocaleDateString('en-CA', { timeZone: DESK_TZ }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DESK_TZ }) + ' PT';
}
/* news row clock: the feed sends UTC 'HH:mm' (headlines are all recent, so
   today's date is a safe DST context) → Pacific 'HH:mm' */
function utcHmToPt(hm) {
  if (!/^\d\d:\d\d$/.test(hm || '')) return hm;
  const d = new Date(new Date().toISOString().slice(0, 10) + 'T' + hm + ':00Z');
  return isNaN(d.getTime()) ? hm
    : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: DESK_TZ });
}
function fmtStampDateTime(iso) { /* Pacific "YYYY-MM-DD HH:mm TZ"; '' if unparseable */
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: DESK_TZ }) + ' ' + fmtClock(iso);
}

/* "Mon D" short date from an ISO date/datetime; passes a value already in that
   form through (demo labels). '' if empty. */
function fmtShortDate(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? MONTHS[+m[2] - 1] + ' ' + (+m[3]) : String(d);
}
/* Uniform terse freshness stamp used on EVERY panel (owner request 2026-07-21):
   "Last updated 17:14 PDT · Jul 21", dropping to "Last updated Jul 21" when only
   a trading-day as-of exists (no clock). The clock is the time the DATA is
   as-of — not when we polled (owner ruling 2026-07-22). '' if empty. */
function fmtUpdated(atIso, asOfDate) {
  const parts = [atIso ? fmtClock(atIso) : '', fmtShortDate(asOfDate)].filter(Boolean);
  return parts.length ? 'Last updated ' + parts.join(' · ') : '';
}

/* UTC instant of the regular-session close (16:00 America/New_York = 1:00pm PT)
   on a given trading day. Robust across DST via the standard wall-clock→instant
   correction. Null if the date can't be parsed. */
function marketCloseInstant(asOfDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(asOfDate || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], 16, 0, 0);   /* 16:00 as if UTC */
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess - (seen - guess)).toISOString();
}

/* Lamp for live feeds. Price feeds (priceBound) only stream real-time WHILE THE
   MARKET IS OPEN — once it shuts (4:00pm ET / 1:00pm PT) the number is frozen at
   the close, so the lamp reads EOD (never "LIVE" off-hours, owner ruling
   2026-07-22) and the stamp names that close. While the session is open the lamp
   is LIVE when the fetch is fresh (≤ 6 min) and STALE if the poller stalled.
   Non-price feeds (news — headlines arrive around the clock) keep the LIVE/STALE
   fetch logic year-round. Future: an extended-hours quote feed would widen the
   LIVE window through pre/after-market and keep the stamp ticking then. */
function liveLampFor(generatedAt, dataAsOf, priceBound) {
  if (priceBound && !marketSessionOpen()) {
    const atIso = marketCloseInstant(dataAsOf) || generatedAt;
    return { cls: 'lamp--eod', text: 'EOD', stamp: fmtUpdated(atIso, dataAsOf), atIso };
  }
  const ageMs = Date.now() - new Date(generatedAt).getTime();
  const fresh = Number.isFinite(ageMs) && ageMs <= 6 * 60000;
  const stamp = fmtUpdated(generatedAt, dataAsOf);
  return fresh
    ? { cls: 'lamp--live', text: 'LIVE', stamp, atIso: generatedAt }
    : { cls: 'lamp--stale', text: 'STALE', stamp: stamp + ' — refresh overdue', atIso: generatedAt };
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
    syncedAt: a.created_at || null,   /* when the sync wrote this snapshot (desk_007) */
  }));
  return {
    accounts, labels,
    asOf: accounts.length ? accounts[0].asOf : null,
    syncedAt: accounts.length ? accounts[0].syncedAt : null,
  };
}
