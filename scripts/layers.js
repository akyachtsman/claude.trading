/* Layers Heat Map — the SCORER (owner rulings A–H, 2026-11-13). The rules are INVEST's and live in ONE file,
   specs/layers-heat-map/LAYERS_HEAT_MAP.md (section 4); this file only carries them out. Every point value, cut-off,
   verdict line, hold-back line and colour divisor is in LAYERS_RULES below, so a new issue of the rules is an edit to
   that table and its tests (tools/unit/layers.test.mjs), nothing else. Never change a rule here on your own: a rule
   change comes from INVEST and is logged in the master file's section 12.

   Plain functions, no DOM: app.js draws the panel (renderLayers) from what layersScore() returns. The stochastics are
   the dashboard's OWN stochSeries with WSTOCH (92-15-15, the "13-week" line) and STOCH (14-3-3) from data.js — never a
   second copy of the maths, and never stochPartial (a picture, never a signal).

   Input (layersDecode builds it from the daily feed, desk-layers; ?demo=1 builds it with buildDemoLayersInput):
     { asOf: 'YYYY-MM-DD', source,
       market: { brent, dxy, acwx, tnx, vix, hyg, ief, spy, gspc }   each { t, c, a? } (a = adjusted close)
       funds:  { XLK: { t, c, a }, … }                                 the eleven sector funds
       fred:   { core: [{ d, v }], unrate: [{ d, v }], payems: [{ d, v }] }   monthly, oldest first
       fearGreed: [{ d, v }]                                          daily, oldest first
       stocks: [{ sym, name, sector, sub, sp, bars: { t, o, h, l, c, a, v } }]
       excluded: [{ sym, name, why }] }                                left out before scoring (funds, indexes, …) */

const LAYERS_RULES = Object.freeze({
  version: 'v20',                 /* the rules file version these numbers come from */
  lookback: 21,                   /* "21 sessions ago" */
  minSessions: 120,               /* a stock with fewer sessions is left out */
  max: { A: 5, B: 5, C: 8, D: 7, E: 5, F: 10, G: 20, H: 10, I: 10, J: 10, K: 10 },
  A: { oil: 3, dollar: 2 },                                    /* lower → BUY, higher → SELL */
  B: { above200Buy: 5, above50Sell: 5 },
  C: {
    yieldSmallUp: 0.25,                                        /* points of yield */
    yieldBuy: { down: 4, smallUp: 2 },                         /* up more → 0 */
    yieldSell: { bigUp: 6, smallUp: 2 },                       /* not up → 0 */
    coreCoolingBuy: 2,
    jobs: { higherBuy: 2, flatEach: 1, lowerSell: 2 },         /* OPEN QUESTION 1: scored the test's way */
  },
  D: {
    vix: { buyFear: 22, buyFearPts: 3, calm: 17, buyCalmPts: 2, sellCalmPts: 2, sellMidMax: 25, sellMidPts: 1 },
    breadth: { buyLow: 40, buyLowPts: 2, buyMidMax: 70, buyMidPts: 1, sellHigh: 60, sellHighPts: 3, sellMidMin: 40, sellMidPts: 2 },
    fearGreed: { buyFear: 25, buyFearPts: 2, buyMidMax: 45, buyMidPts: 1, sellMin: 45, sellPts: 2 },
  },
  E: {
    driver: 5, flat: 2,
    drivers: {
      'Energy': ['oil rising', 'oil', 1],
      'Real Estate': ['the 10-year yield falling', 'yield', -1],
      'Utilities': ['the 10-year yield falling', 'yield', -1],
      'Consumer Discretionary': ['oil falling', 'oil', -1],
      'Materials': ['the dollar falling', 'dollar', -1],
      'Information Technology': ['junk bonds beating Treasuries', 'credit', 1],
    },
  },
  F: {
    breadthBuy: { low: 40, lowPts: 6, midMax: 60, midPts: 4, highPts: 2 },
    breadthSell: { high: 60, highPts: 6, midMin: 40, midPts: 3 },
    rsSessions: 5, aheadBuy: 4, above50Sell: 4,
  },
  G: { recent: 5, avgs: [[200, 10, 5], [50, 6, 3], [25, 4, 2]] },   /* [days, crossed, above/below] */
  H: {
    avgSessions: 50, today: [[2, 4], [1.5, 3], [1.2, 2], [1, 1]],
    ratioSessions: 20, ratioStrong: 1.2, ratioStrongPts: 3, ratioAbovePts: 1,  /* an exact 1.0 tie gives neither side a point */
    buildRecent: 5, buildBase: 50, build: [[1.5, 3], [1.2, 2], [1, 1]],
  },
  I: { pts: { 1: 3, 2: 6, 3: 10, 4: 10, 5: 7 }, longPts: 3 },     /* 6 or more → longPts */
  J: {
    long: { low: 30, high: 80, fastDrop: 10, fastSessions: 5, lowRising: 7, lowFalling: 3, lowFast: 0, midWith: 4, midAgainst: 1, highFalling: 7, highRising: 3 },
    daily: { high: 80, low: 20, extremeWith: 3, extremeAgainst: 2, mid: 1 },
  },
  K: { parts: [['its sector', 'sector', 63, 3], ['its sector', 'sector', 5, 2], ['the S&P 500', 'sp500', 63, 3], ['the S&P 500', 'sp500', 5, 2]] },
  verdict: { strong: 25, leans: 10 },          /* the hold-back caps a held verdict at strong − 1 */
  colour: { lean: 42, pointsBase: 15, pointsSpan: 60, sectorMax: 15 },
  flags: { thinDollars: 10e6, thinSessions: 20, panicVix: 30 },
  rules: {
    r3: { low: 30, high: 80 },
    run: { move: 0.015, window: 60, lowAge: 10, near: 0.08, kBuyMax: 30, kSellMin: 70 },
  },
});

/* The eleven GICS sectors in the panel's order, and the fund each one is measured by. */
const LAYERS_SECTORS = [
  ['Information Technology', 'XLK'], ['Financials', 'XLF'], ['Health Care', 'XLV'], ['Consumer Discretionary', 'XLY'],
  ['Communication Services', 'XLC'], ['Industrials', 'XLI'], ['Consumer Staples', 'XLP'], ['Energy', 'XLE'],
  ['Utilities', 'XLU'], ['Real Estate', 'XLRE'], ['Materials', 'XLB'],
];
const LAYERS_LETTERS = 'ABCDEFGHIJK'.split('');
const LAYERS_NAMES = {
  A: 'Global trend', B: 'Global sentiment', C: 'National trend', D: 'National sentiment', E: 'Sector trend', F: 'Sector sentiment',
  G: 'Moving averages', H: 'Volume', I: 'Days in a row', J: 'Stochastic', K: 'Strength',
};
/* What the tests showed, per letter (INVEST's words, from the rules file and its simulation). */
const LAYERS_EVIDENCE = {
  A: 'Oil and the dollar falling help a BUY; rising, a SELL. In five years of rule 3 signals a BUY gained 2.3% over 20 sessions with oil falling and 0.4% with oil rising. The SELL side is a mirror the test did not confirm.',
  B: 'A BUY did better with world stocks above their 200-day (+1.9% against +0.5%). A SELL held up only with world stocks above their 50-day, a stretched world: the stock rose 0.1% after the signal, against 2.2% otherwise.',
  C: 'A 10-year yield up more than 0.25 in 21 sessions is the one firm SELL reading. Cooling core inflation is a lean for BUYs. Jobs score the way six years of prices point, which is backwards from instinct: with unemployment higher than three months earlier the market gained 1.9% over the next 20 sessions, against 1.1% with it lower. That rests on about 70 monthly reports, so it is a thin test.',
  D: 'Scored against the crowd. A BUY did best after fear and worst with the VIX between 17 and 22. A SELL broke even only in a broad market. Fear & Greed under 25 was followed by +2.9% over 20 sessions, 25 to 45 by +1.6%, 45 to 75 by +0.3% to +1.0%, against +1.3% on an average day. No reading was followed by a fall.',
  E: 'Each sector answers to its own driver. Over five years the direction matched in 6 of 7 sector tests, on small samples. Sectors with no clear driver earn a flat 2.',
  F: 'Scored against the crowd. A BUY did best in a washed-out sector with money starting to return. A SELL held up only in a broad sector.',
  G: 'Crossing an average within five sessions earns the most, the 200-day above all. Carried over from the first indicator draft and scaled to 20.',
  H: 'A stock that rose over five sessions on volume 1.5 times normal or more gained 1.6% over the next 20 sessions, against 1.0% when it rose on below-normal volume. Heavy volume on falling prices was also followed by a gain (1.8%), so the SELL side of this letter is not supported by the test.',
  I: 'Three or four closes in a row in the trade\'s direction earn the most. Six or more is stretched and earns less.',
  J: 'The 13-week stochastic (92-15-15), the line rule 3 watches, earns up to 7. The daily (14-3-3) earns up to 3 and is about timing: after a daily reading over 80 the stock gained 0.2% over five sessions, against 0.3% on an average day and 0.45% after a reading under 20.',
  K: 'Beating its sector and the S&P 500 favours a BUY, lagging them a SELL. In the test, BUY signals with more strength readings did better: +0.6% with none, +2.5% with all three.',
};

/* ── small numeric helpers (NaN, never 0, for anything unknown) ───────────── */
const lyNum = v => (v == null || v === '' ? NaN : Number(v));
function lyAt(arr, i) { return arr && i >= 0 && i < arr.length ? lyNum(arr[i]) : NaN; }
function lyBack(arr, n) { return arr ? lyAt(arr, arr.length - 1 - n) : NaN; }
const lyPct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a / b - 1) * 100 : NaN);
function lySmaAt(arr, len, i) {
  if (!arr || i < len - 1 || i >= arr.length) return NaN;
  let s = 0;
  for (let j = i - len + 1; j <= i; j++) { const v = lyNum(arr[j]); if (!Number.isFinite(v)) return NaN; s += v; }
  return s / len;
}
function lyMean(arr, from, to) {   /* inclusive indices */
  if (!arr || from < 0 || to >= arr.length || to < from) return NaN;
  let s = 0;
  for (let j = from; j <= to; j++) { const v = lyNum(arr[j]); if (!Number.isFinite(v)) return NaN; s += v; }
  return s / (to - from + 1);
}
const lyF2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');
const lyPts = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + ' points' : '—');
const lyMonthName = d => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(String(d).slice(5, 7)) - 1] || '';
function lyLetter(comps) { return { L: comps.reduce((s, c) => s + c[2], 0), S: comps.reduce((s, c) => s + c[3], 0), comps }; }
const lyNA = (label) => [label, 'not available', 0, 0];

/* Verdict words for a lean (BUY score minus SELL score). */
function layersVerdict(lean, R = LAYERS_RULES) {
  const v = R.verdict;
  return lean >= v.strong ? 'Strong BUY' : lean >= v.leans ? 'Leans BUY' : lean > -v.leans ? 'No edge today' : lean > -v.strong ? 'Leans SELL' : 'Strong SELL';
}
function layersBand(lean, R = LAYERS_RULES) {
  const v = R.verdict;
  return lean >= v.strong ? 2 : lean >= v.leans ? 1 : lean > -v.leans ? 0 : lean > -v.strong ? -1 : -2;
}
/* The timing hold-back (owner's rule, OPEN QUESTION 2): while the daily stochastic is over 80 a Strong BUY is SHOWN as
   Leans BUY, under 20 a Strong SELL as Leans SELL. The lean itself never changes; `eff` is the lean the verdict and colour use. */
function layersHeld(lean, tm, R = LAYERS_RULES) {
  const cap = R.verdict.strong - 1;
  return tm === 'peak' ? Math.min(lean, cap) : tm === 'trough' ? Math.max(lean, -cap) : lean;
}

/* ── the outer letters A to D, the same for every stock ──────────────────── */
function layersOuter(input, breadth, R = LAYERS_RULES) {
  const m = input.market || {}, lb = R.lookback;
  const c = k => (m[k] && m[k].c) || null;
  const out = {};

  const b0 = lyBack(c('brent'), 0), b21 = lyBack(c('brent'), lb);
  const d0 = lyBack(c('dxy'), 0), d21 = lyBack(c('dxy'), lb);
  out.A = lyLetter([
    Number.isFinite(b0) && Number.isFinite(b21)
      ? ['Brent oil against 21 sessions ago', '$' + lyF2(b0) + ' against $' + lyF2(b21) + ' (' + fmtPct(lyPct(b0, b21)) + ')', b0 < b21 ? R.A.oil : 0, b0 > b21 ? R.A.oil : 0]
      : lyNA('Brent oil against 21 sessions ago'),
    Number.isFinite(d0) && Number.isFinite(d21)
      ? ['Dollar index against 21 sessions ago', lyF2(d0) + ' against ' + lyF2(d21) + ' (' + fmtPct(lyPct(d0, d21)) + ')', d0 < d21 ? R.A.dollar : 0, d0 > d21 ? R.A.dollar : 0]
      : lyNA('Dollar index against 21 sessions ago'),
  ]);

  const ac = c('acwx'), a0 = lyBack(ac, 0), aN = ac ? ac.length - 1 : -1;
  const a200 = lySmaAt(ac, 200, aN), a50 = lySmaAt(ac, 50, aN);
  out.B = lyLetter([
    Number.isFinite(a0) && Number.isFinite(a200)
      ? ['World stocks outside the US against their 200-day', fmtPct(lyPct(a0, a200)) + ' (' + (a0 > a200 ? 'above' : 'below') + ')', a0 > a200 ? R.B.above200Buy : 0, 0]
      : lyNA('World stocks outside the US against their 200-day'),
    Number.isFinite(a0) && Number.isFinite(a50)
      ? ['World stocks outside the US against their 50-day', fmtPct(lyPct(a0, a50)) + ' (' + (a0 > a50 ? 'above' : 'below') + ')', 0, a0 > a50 ? R.B.above50Sell : 0]
      : lyNA('World stocks outside the US against their 50-day'),
  ]);

  const t0 = lyBack(c('tnx'), 0), t21 = lyBack(c('tnx'), lb), tchg = t0 - t21, C = R.C;
  const f = input.fred || {};
  const cv = (f.core || []).map(r => lyNum(r.v));
  const nowP = lyPct(lyBack(cv, 0), lyBack(cv, 3)), thenP = lyPct(lyBack(cv, 3), lyBack(cv, 6));
  const cooling = nowP < thenP;
  const un = (f.unrate || []), u0 = lyNum(un.length ? un[un.length - 1].v : NaN), u3 = lyNum(un.length > 3 ? un[un.length - 4].v : NaN);
  const pay = (f.payems || []), p1 = pay.length > 1 ? lyNum(pay[pay.length - 1].v) - lyNum(pay[pay.length - 2].v) : NaN;
  const jobsWord = u0 > u3 ? 'higher' : u0 < u3 ? 'lower' : 'flat';
  out.C = lyLetter([
    Number.isFinite(tchg)
      ? ['10-year yield against 21 sessions ago', lyF2(t0) + '% against ' + lyF2(t21) + '% (' + (tchg >= 0 ? '+' : '−') + Math.abs(tchg).toFixed(2) + ')',
        t0 < t21 ? C.yieldBuy.down : tchg <= C.yieldSmallUp ? C.yieldBuy.smallUp : 0,
        tchg > C.yieldSmallUp ? C.yieldSell.bigUp : tchg > 0 ? C.yieldSell.smallUp : 0]
      : lyNA('10-year yield against 21 sessions ago'),
    Number.isFinite(nowP) && Number.isFinite(thenP)
      ? ['Core inflation, three-month pace against the three months before', lyF2(nowP) + '% against ' + lyF2(thenP) + '% (' + (cooling ? 'cooling' : 'not cooling') + '; through ' + lyMonthName(f.core[f.core.length - 1].d) + ')', cooling ? C.coreCoolingBuy : 0, 0]
      : lyNA('Core inflation, three-month pace against the three months before'),
    Number.isFinite(u0) && Number.isFinite(u3)
      ? ['Jobs: unemployment against three months earlier', u0.toFixed(1) + '% against ' + u3.toFixed(1) + '% (' + jobsWord + ')' +
          (Number.isFinite(p1) ? '; payrolls ' + (p1 >= 0 ? '+' : '−') + Math.abs(Math.round(p1)).toLocaleString('en-US') + ',000 in ' + lyMonthName(pay[pay.length - 1].d) : ''),
        u0 > u3 ? C.jobs.higherBuy : u0 === u3 ? C.jobs.flatEach : 0, u0 < u3 ? C.jobs.lowerSell : u0 === u3 ? C.jobs.flatEach : 0]
      : lyNA('Jobs: unemployment against three months earlier'),
  ]);

  const D = R.D, vc = c('vix'), v0 = lyBack(vc, 0), v5 = lyBack(vc, 5);
  const fg = input.fearGreed || [], fg0 = lyNum(fg.length ? fg[fg.length - 1].v : NaN), fg5 = lyNum(fg.length > 5 ? fg[fg.length - 6].v : NaN);
  const fgWord = fg0 < 25 ? 'Extreme fear' : fg0 < 45 ? 'Fear' : fg0 <= 55 ? 'Neutral' : fg0 <= 75 ? 'Greed' : 'Extreme greed';
  const V = D.vix, Bd = D.breadth, G = D.fearGreed;
  out.D = lyLetter([
    Number.isFinite(v0)
      ? ['Fear gauge (VIX)', lyF2(v0) + (Number.isFinite(v5) ? ' (' + lyF2(v5) + ' five sessions ago)' : ''),
        v0 >= V.buyFear ? V.buyFearPts : v0 < V.calm ? V.buyCalmPts : 0,
        v0 < V.calm ? V.sellCalmPts : v0 <= V.sellMidMax ? V.sellMidPts : 0]
      : lyNA('Fear gauge (VIX)'),
    Number.isFinite(breadth)
      ? ['S&P 500 stocks above their 50-day', Math.round(breadth) + '%',
        breadth < Bd.buyLow ? Bd.buyLowPts : breadth <= Bd.buyMidMax ? Bd.buyMidPts : 0,
        breadth > Bd.sellHigh ? Bd.sellHighPts : breadth >= Bd.sellMidMin ? Bd.sellMidPts : 0]
      : lyNA('S&P 500 stocks above their 50-day'),
    Number.isFinite(fg0)
      ? ['CNN Fear & Greed', Math.round(fg0) + ' (' + fgWord + (Number.isFinite(fg5) ? '; ' + Math.round(fg5) + ' five sessions ago' : '') + ')',
        fg0 < G.buyFear ? G.buyFearPts : fg0 < G.buyMidMax ? G.buyMidPts : 0, fg0 >= G.sellMin ? G.sellPts : 0]
      : lyNA('CNN Fear & Greed'),
  ]);
  for (const k of ['A', 'B', 'C', 'D']) { out[k].name = LAYERS_NAMES[k]; out[k].max = R.max[k]; }

  /* Context only, no points: the S&P 500 level (the Fed and AAII labels stay out until each has a real source). */
  const g = c('gspc'), gN = g ? g.length - 1 : -1, g0 = lyBack(g, 0);
  const vsAvg = n => fmtPct(lyPct(g0, lySmaAt(g, n, gN)));
  out.labels = Number.isFinite(g0)
    ? [['S&P 500', g0.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '; ' + vsAvg(200) + ' against its 200-day, ' + vsAvg(50) + ' its 50-day, ' + vsAvg(25) + ' its 25-day']]
    : [['S&P 500', 'not available']];
  out.vix = v0;
  out.panic = Number.isFinite(v0) && v0 >= R.flags.panicVix;
  out.moves = { oil: b0 - b21, yield: tchg, dollar: d0 - d21 };
  const hy = m.hyg && (m.hyg.a || m.hyg.c), ie = m.ief && (m.ief.a || m.ief.c);
  const cr0 = lyBack(hy, 0) / lyBack(ie, 0), cr21 = lyBack(hy, lb) / lyBack(ie, lb);
  out.moves.credit = cr0 - cr21;
  out.movesText = {
    oil: 'Brent ' + fmtPct(lyPct(b0, b21)) + ' over 21 sessions',
    yield: '10-year ' + (Number.isFinite(tchg) ? (tchg >= 0 ? '+' : '−') + Math.abs(tchg).toFixed(2) : '—') + ' over 21 sessions',
    dollar: 'dollar ' + fmtPct(lyPct(d0, d21)) + ' over 21 sessions',
    credit: 'junk bonds against Treasuries ' + fmtPct(lyPct(cr0, cr21)) + ' over 21 sessions',
  };
  return out;
}

/* ── the sector letters E and F, the same for every stock in a sector ────── */
function layersSector(name, fundSym, input, outer, members, R = LAYERS_RULES) {
  const fund = (input.funds || {})[fundSym], spy = (input.market || {}).spy;
  const fa = fund && (fund.a || fund.c), sa = spy && (spy.a || spy.c), n5 = R.F.rsSessions;
  const drv = R.E.drivers[name];
  let E;
  if (drv) {
    const mv = outer.moves[drv[1]] * drv[2];
    E = Number.isFinite(mv)
      ? [['Sector driver: ' + drv[0], outer.movesText[drv[1]] + ' (' + (mv > 0 ? 'its way' : mv < 0 ? 'against it' : 'unchanged') + ')', mv > 0 ? R.E.driver : 0, mv < 0 ? R.E.driver : 0]]
      : [lyNA('Sector driver: ' + drv[0])];
  } else {
    E = [['Sector driver', 'No single driver stood out for this sector; it earns a flat ' + R.E.flat, R.E.flat, R.E.flat]];
  }
  const above = members.filter(s => s.above50 != null);
  const sb = above.length ? above.filter(s => s.above50).length / above.length * 100 : NaN;
  const r5 = lyPct(lyBack(fa, 0), lyBack(fa, n5)), s5 = lyPct(lyBack(sa, 0), lyBack(sa, n5)), rs5 = r5 - s5;
  const f50 = lyPct(lyBack(fa, 0), lySmaAt(fa, 50, fa ? fa.length - 1 : -1));
  const BB = R.F.breadthBuy, BS = R.F.breadthSell;
  const F = [
    Number.isFinite(sb)
      ? ["Sector's S&P 500 stocks above their 50-day", Math.round(sb) + '% of ' + above.length,
        sb < BB.low ? BB.lowPts : sb <= BB.midMax ? BB.midPts : BB.highPts,
        sb > BS.high ? BS.highPts : sb >= BS.midMin ? BS.midPts : 0]
      : lyNA("Sector's S&P 500 stocks above their 50-day"),
    Number.isFinite(rs5)
      ? ['Sector fund against the S&P 500, last 5 sessions', lyPts(rs5) + ' (' + fundSym + ' ' + fmtPct(r5) + ', S&P 500 ' + fmtPct(s5) + ')', rs5 > 0 ? R.F.aheadBuy : 0, 0]
      : lyNA('Sector fund against the S&P 500, last 5 sessions'),
    Number.isFinite(f50)
      ? ['Sector fund against its own 50-day', fmtPct(f50) + ' (' + (f50 > 0 ? 'above' : 'below') + ')', 0, f50 > 0 ? R.F.above50Sell : 0]
      : lyNA('Sector fund against its own 50-day'),
  ];
  return { name, fund: fundSym, n: above.length, breadth: sb, rs5, E: lyLetter(E), F: lyLetter(F) };
}

/* ── the stock letters G to K ─────────────────────────────────────────────── */
function layersMaSide(c, days, crossPts, sidePts, R = LAYERS_RULES) {
  const n = c.length, i = n - 1, label = days + '-day average';
  const ma = lySmaAt(c, days, i), px = lyNum(c[i]);
  if (!Number.isFinite(ma) || !Number.isFinite(px)) return [label, 'not enough history', 0, 0];
  // Section 4.G scores ABOVE and BELOW; a close exactly ON its average is
  // neither, so it earns nothing, and a cross needs a strictly-other-side day
  // (a touch is not a cross) — Codex P2, PR #370; logged in section 12.
  const ab = px > ma, be = px < ma;
  let beforeAbove = 0, beforeBelow = 0;
  for (let j = i - R.G.recent; j < i; j++) {
    const m = lySmaAt(c, days, j), v = lyNum(c[j]);
    if (!Number.isFinite(m) || !Number.isFinite(v)) continue;
    if (v > m) beforeAbove++; else if (v < m) beforeBelow++;
  }
  const d = fmtPct(lyPct(px, ma));
  if (!ab && !be) return [label, 'on the average (' + d + ')', 0, 0];
  if (ab && beforeBelow > 0) return [label, 'crossed above within ' + R.G.recent + ' sessions (' + d + ')', crossPts, 0];
  if (be && beforeAbove > 0) return [label, 'crossed below within ' + R.G.recent + ' sessions (' + d + ')', 0, crossPts];
  return [label, (ab ? 'above' : 'below') + ' (' + d + ')', ab ? sidePts : 0, ab ? 0 : sidePts];
}
function layersStreak(c) {
  let up = 0, dn = 0;
  for (let i = c.length - 1; i > 0 && c[i] > c[i - 1]; i--) up++;
  for (let i = c.length - 1; i > 0 && c[i] < c[i - 1]; i--) dn++;
  return { up, dn };
}
const layersStreakPts = (n, R = LAYERS_RULES) => (n <= 0 ? 0 : n >= 6 ? R.I.longPts : R.I.pts[n]);
const lyStep = (x, steps) => { for (const [min, pts] of steps) if (x >= min) return pts; return 0; };

function layersLetterH(b, R = LAYERS_RULES) {
  const H = R.H, c = b.c, v = b.v, i = c.length - 1;
  const comps = [];
  const vavg = lyMean(v, i - H.avgSessions, i - 1), vx = lyNum(v[i]) / vavg;
  const isUp = c[i] > c[i - 1], isDn = c[i] < c[i - 1], r1 = lyPct(lyNum(c[i]), lyNum(c[i - 1]));
  const vp = lyStep(vx, H.today);
  comps.push(Number.isFinite(vx) && vavg > 0
    ? ["Today's volume against its 50-day average", lyF2(vx) + ' times normal on ' + (isUp ? 'an up day' : isDn ? 'a down day' : 'a flat day') + ' (' + fmtPct(r1) + ')', isUp ? vp : 0, isDn ? vp : 0]
    : lyNA("Today's volume against its 50-day average"));
  let u = 0, d = 0;
  for (let j = i - H.ratioSessions + 1; j <= i; j++) {
    if (j < 1) continue;
    if (c[j] > c[j - 1]) u += lyNum(v[j]) || 0; else if (c[j] < c[j - 1]) d += lyNum(v[j]) || 0;
  }
  const label2 = 'Volume on up days against down days, ' + H.ratioSessions + ' sessions';
  if (u > 0 && d > 0) {
    const ratio = u / d, inv = d / u;
    comps.push([label2, ratio >= 1 ? lyF2(ratio) + ' to 1 (' + (ratio > 1 ? 'buying heavier' : 'even') + ')' : '1 to ' + lyF2(inv) + ' (selling heavier)',
      ratio >= H.ratioStrong ? H.ratioStrongPts : ratio > 1 ? H.ratioAbovePts : 0,
      inv >= H.ratioStrong ? H.ratioStrongPts : inv > 1 ? H.ratioAbovePts : 0]);
  } else if (u > 0 || d > 0) {
    comps.push([label2, u > 0 ? 'one-sided (buying only)' : 'one-sided (selling only)', u > 0 ? H.ratioStrongPts : 0, d > 0 ? H.ratioStrongPts : 0]);
  } else comps.push(lyNA(label2));
  const recent = lyMean(v, i - H.buildRecent + 1, i), base = lyMean(v, i - H.buildRecent - H.buildBase + 1, i - H.buildRecent);
  const vt = recent / base, p5 = lyPct(lyNum(c[i]), lyNum(c[i - H.buildRecent]));
  const tp = lyStep(vt, H.build);
  comps.push(Number.isFinite(vt) && base > 0 && Number.isFinite(p5)
    ? ['Volume building: last five sessions against the 50 before', lyF2(vt) + ' times normal, price ' + (p5 > 0 ? 'up ' : p5 < 0 ? 'down ' : 'flat ') + Math.abs(p5).toFixed(2) + '% over the five', p5 > 0 ? tp : 0, p5 < 0 ? tp : 0]
    : lyNA('Volume building: last five sessions against the 50 before'));
  return lyLetter(comps);
}

function layersLetterJ(wk, dl, R = LAYERS_RULES) {
  const J = R.J, n = wk.k.length, i = n - 1;
  const comps = [];
  const k0 = lyNum(wk.k[i]), k1 = lyNum(wk.k[i - 1]), k5 = lyNum(wk.k[i - J.long.fastSessions]);
  if (!Number.isFinite(k0) || !Number.isFinite(k1)) comps.push(['13-week stochastic (92-15-15)', 'not enough history', 0, 0]);
  else {
    const L = J.long, rising = k0 > k1, fast = Number.isFinite(k5) && k0 - k5 <= -L.fastDrop;
    let b, s, zone;
    if (k0 < L.low) { zone = 'under ' + L.low; b = rising ? L.lowRising : fast ? L.lowFast : L.lowFalling; s = 0; }
    else if (k0 > L.high) { zone = 'over ' + L.high; b = 0; s = rising ? L.highRising : L.highFalling; }
    else { zone = 'between ' + L.low + ' and ' + L.high; b = rising ? L.midWith : L.midAgainst; s = rising ? L.midAgainst : L.midWith; }
    const txt = k0 < L.low && fast && !rising
      ? Math.round(k0) + ', under ' + L.low + ' and falling fast (' + Math.round(k5) + ' five sessions ago)'
      : Math.round(k0) + ', ' + zone + ' and ' + (rising ? 'rising' : 'falling') + ' (' + Math.round(k1) + ' yesterday' + (Number.isFinite(k5) ? ', ' + Math.round(k5) + ' five sessions ago' : '') + ')';
    comps.push(['13-week stochastic (92-15-15)', txt, b, s]);
  }
  const dk = lyNum(dl.k[i]), dd = lyNum(dl.d[i]), D = J.daily;
  let tm = null;
  if (!Number.isFinite(dk) || !Number.isFinite(dd)) comps.push(['Daily stochastic (14-3-3)', 'not enough history', 0, 0]);
  else {
    const above = dk > dd, below = dk < dd;
    let b, s, zone;
    if (dk > D.high) { b = 0; s = below ? D.extremeWith : D.extremeAgainst; zone = 'over ' + D.high + ', peaking'; tm = 'peak'; }
    else if (dk < D.low) { b = above ? D.extremeWith : D.extremeAgainst; s = 0; zone = 'under ' + D.low + ', bottoming'; tm = 'trough'; }
    else { b = above ? D.mid : 0; s = below ? D.mid : 0; zone = 'between ' + D.low + ' and ' + D.high; }
    comps.push(['Daily stochastic (14-3-3)', Math.round(dk) + ', ' + zone + ', ' + (above ? 'above' : below ? 'below' : 'on') + ' its signal line (' + Math.round(dd) + ')', b, s]);
  }
  const out = lyLetter(comps);
  out.tm = tm; out.dk = dk; out.k = k0;
  return out;
}

function layersLetterK(b, fund, spy, R = LAYERS_RULES) {
  const a = b.a || b.c, fa = fund && (fund.a || fund.c), sa = spy && (spy.a || spy.c);
  return lyLetter(R.K.parts.map(([lab, ref, n, pts]) => {
    const ra = ref === 'sector' ? fa : sa;
    const x = lyPct(lyBack(a, 0), lyBack(a, n)) - lyPct(lyBack(ra, 0), lyBack(ra, n));
    const label = 'Against ' + lab + ' over ' + (n === 63 ? '3 months' : n + ' sessions');
    return Number.isFinite(x) ? [label, lyPts(x) + ' (' + (x > 0 ? 'beat' : x < 0 ? 'lagged' : 'level') + ')', x > 0 ? pts : 0, x < 0 ? pts : 0] : [label, 'not enough history', 0, 0];
  }));
}

/* ── rule signals this week (owner's definitions, 2026-11-13; the long-term 92-15-15 lines) ── */
function layersRuleAt(b, wk, i, R = LAYERS_RULES) {
  /* rule 3 is the plain cross of %K, no %D test (INVEST, 9:10 AM PT 2026-11-13): under 30 the session before and at or
     over 30 now; over 80 the session before and at or under 80 now. A touch (sitting exactly on the line) does not count. */
  const out = [], k = wk.k, r3 = R.rules.r3;
  const kp = lyNum(k[i - 1]), kn = lyNum(k[i]);
  if (Number.isFinite(kp) && Number.isFinite(kn)) {
    if (kp < r3.low && kn >= r3.low) out.push('Rule 3 BUY');
    if (kp > r3.high && kn <= r3.high) out.push('Rule 3 SELL');
  }
  const run = R.rules.run, c = b.c, o = b.o;
  if (i < 4 || i - run.window + 1 < 0) return out;
  const strong = (j, dir) => dir > 0 ? c[j] >= c[j - 1] * (1 + run.move) && c[j] > o[j] : c[j] <= c[j - 1] * (1 - run.move) && c[j] < o[j];
  const kRun = dir => [i - 2, i - 1, i].every(j => { const a = lyNum(k[j]), p = lyNum(k[j - 1]); return Number.isFinite(a) && Number.isFinite(p) && (dir > 0 ? a > p : a < p); });
  for (const dir of [1, -1]) {
    if (![i - 2, i - 1, i].every(j => strong(j, dir)) || strong(i - 3, dir)) continue;
    /* the extreme of the 60 sessions ending on day 3, and when it was first set */
    const src = dir > 0 ? b.l : b.h;
    let at = i - run.window + 1;
    for (let j = at; j <= i; j++) if (dir > 0 ? src[j] < src[at] : src[j] > src[at]) at = j;
    if (at < i - 2 - run.lowAge) continue;
    const ext = src[at], c0 = c[i - 3];
    if (dir > 0 ? c0 > ext * (1 + run.near) : c0 < ext * (1 - run.near)) continue;
    if (!kRun(dir)) continue;
    const ki = lyNum(k[i]);
    if (dir > 0 && ki <= run.kBuyMax) out.push('Rule 1 BUY');
    if (dir < 0 && ki >= run.kSellMin) out.push('Rule 2 SELL');
  }
  return out;
}
/* Monday of the as-of date's week, as an ISO date. */
function layersWeekStart(asOf) {
  const d = new Date(asOf + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function layersSignals(b, wk, asOf, R = LAYERS_RULES) {
  const mon = layersWeekStart(asOf), sig = [];
  for (let i = b.t.length - 1; i >= 1 && b.t[i] >= mon; i--) {
    for (const name of layersRuleAt(b, wk, i, R)) sig.unshift([name, b.t[i]]);
  }
  return sig;
}

/* ── the live feed's payload → the input above (step 2; desk-layers encodes, this decodes) ──
   desk-layers sends whole cents: the close as a running difference from the bar before, open/high/low as a difference
   from their own close, the adjusted close as the close times a factor sent in runs [first index, factor], and the
   dates as positions in one shared calendar `cal` (a series names its first position `t0` and the positions it skips
   `sk`, or sends its own dates `t`). A series that does not decode is dropped, never half-built: the scorer then says
   "not available" (outer letters) or leaves the stock out. Pure, so tools/unit/desk-layers.test.mjs round-trips it
   against the function's encoder. */
const LY_ISO = /^\d{4}-\d{2}-\d{2}$/;
function layersDecodeBars(e, cal) {
  if (!e || !Array.isArray(e.c) || !e.c.length) return null;
  const n = e.c.length;
  if (![e.o, e.h, e.l, e.v].every(a => Array.isArray(a) && a.length === n)) return null;
  let t;
  if (Array.isArray(e.t)) t = e.t.slice();
  else {
    if (!Array.isArray(cal) || !Number.isInteger(e.t0)) return null;
    const skip = new Set(Array.isArray(e.sk) ? e.sk : []);
    t = [];
    for (let i = e.t0; t.length < n && i < cal.length; i++) if (!skip.has(i)) t.push(cal[i]);
  }
  if (t.length !== n || !t.every(d => LY_ISO.test(d))) return null;
  const c = [], o = [], h = [], l = [], v = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    run = i ? run + e.c[i] : e.c[i];
    if (![run, e.o[i], e.h[i], e.l[i], e.v[i]].every(Number.isFinite)) return null;
    c.push(run / 100); o.push((run + e.o[i]) / 100); h.push((run + e.h[i]) / 100); l.push((run + e.l[i]) / 100); v.push(e.v[i]);
  }
  const out = { t, o, h, l, c, v };
  if (Array.isArray(e.af) && e.af.length) {
    const a = new Array(n);
    let k = 0, f = 1;
    for (let i = 0; i < n; i++) {
      while (k < e.af.length && e.af[k][0] <= i) { f = Number(e.af[k][1]); k++; }
      a[i] = Math.round(c[i] * f * 100) / 100;
    }
    if (a.every(Number.isFinite)) out.a = a;
  }
  return out;
}
function layersDecode(p) {
  if (!p || typeof p !== 'object' || !LY_ISO.test(String(p.asOf)) || !Array.isArray(p.cal)) throw new Error('not a Layers payload');
  const cal = p.cal, obj = x => (x && typeof x === 'object' ? x : {});
  const series = src => { const out = {}; for (const [k, e] of Object.entries(obj(src))) { const b = layersDecodeBars(e, cal); if (b) out[k] = b; } return out; };
  const pairs = arr => (Array.isArray(arr) ? arr : []).filter(r => Array.isArray(r) && LY_ISO.test(String(r[0])) && Number.isFinite(Number(r[1]))).map(r => ({ d: r[0], v: Number(r[1]) }));
  const f = obj(p.fred);
  const stocks = [];
  for (const s of Array.isArray(p.stocks) ? p.stocks : []) {
    const bars = layersDecodeBars(s && s.b, cal);
    if (!bars || typeof s.s !== 'string') continue;
    stocks.push({ sym: s.s, name: String(s.n || s.s), sector: String(s.sec || ''), sub: String(s.sub || ''), sp: s.sp === 1 || s.sp === true, bars });
  }
  const excluded = (Array.isArray(p.excluded) ? p.excluded : []).filter(x => x && typeof x.sym === 'string').map(x => ({ sym: x.sym, name: String(x.name || x.sym), why: String(x.why || '') }));
  return {
    asOf: p.asOf, source: 'live', built: p.built || null, fgLast: LY_ISO.test(String(p.fgLast)) ? p.fgLast : null,
    market: series(p.market), funds: series(p.funds),
    fred: { core: pairs(f.core), unrate: pairs(f.unrate), payems: pairs(f.payems) },
    fearGreed: pairs(p.fg), stocks, excluded,
  };
}

/* ── everything ───────────────────────────────────────────────────────────── */
function layersScore(input, R = LAYERS_RULES) {
  const asOf = input.asOf;
  const excluded = (input.excluded || []).slice();
  const ready = [];
  for (const s of input.stocks || []) {
    const b = s.bars, n = b && b.c ? b.c.filter(v => Number.isFinite(lyNum(v))).length : 0;
    const secIdx = LAYERS_SECTORS.findIndex(x => x[0] === s.sector);
    if (secIdx < 0) { excluded.push({ sym: s.sym, name: s.name, why: 'its sector does not map to one of the eleven' }); continue; }
    if (n < R.minSessions) { excluded.push({ sym: s.sym, name: s.name, why: 'under ' + R.minSessions + ' sessions of history' }); continue; }
    if (b.t[b.t.length - 1] !== asOf) { excluded.push({ sym: s.sym, name: s.name, why: 'no price for the as-of day' }); continue; }
    const a = b.a || b.c, i = a.length - 1, ma = lySmaAt(a, 50, i);
    ready.push({ src: s, b, sec: secIdx, above50: Number.isFinite(ma) ? lyNum(a[i]) > ma : null });
  }
  const spMembers = ready.filter(r => r.src.sp && r.above50 != null);
  const breadth = spMembers.length ? spMembers.filter(r => r.above50).length / spMembers.length * 100 : NaN;
  const outer = layersOuter(input, breadth, R);
  const sectors = LAYERS_SECTORS.map(([name, fund], i) => layersSector(name, fund, input, outer, ready.filter(r => r.sec === i && r.src.sp), R));
  const outL = ['A', 'B', 'C', 'D'].reduce((s, k) => s + outer[k].L, 0), outS = ['A', 'B', 'C', 'D'].reduce((s, k) => s + outer[k].S, 0);
  const spy = (input.market || {}).spy;
  const stocks = ready.map(r => {
    const s = r.src, b = r.b, c = b.c, i = c.length - 1, sec = sectors[r.sec];
    const wk = stochSeries(b, WSTOCH), dl = stochSeries(b, STOCH);
    const G = lyLetter(R.G.avgs.map(([days, x, y]) => layersMaSide(c, days, x, y, R)));
    const H = layersLetterH(b, R);
    const st = layersStreak(c);
    const I = lyLetter([['Closes in a row, counting today', st.up ? st.up + ' up' : st.dn ? st.dn + ' down' : 'flat today', layersStreakPts(st.up, R), layersStreakPts(st.dn, R)]]);
    const J = layersLetterJ(wk, dl, R);
    const K = layersLetterK(b, (input.funds || {})[sec.fund], spy, R);
    const g = { G, H, I, J, K };
    const sl = G.L + H.L + I.L + J.L + K.L, ss = G.S + H.S + I.S + J.S + K.S;
    const L = outL + sec.E.L + sec.F.L + sl, S = outS + sec.E.S + sec.F.S + ss, lean = L - S;
    const eff = layersHeld(lean, J.tm, R);
    let dv = 0, dvn = 0;
    for (let j = Math.max(0, i - R.flags.thinSessions + 1); j <= i; j++) { const x = lyNum(c[j]) * lyNum(b.v[j]); if (Number.isFinite(x)) { dv += x; dvn++; } }
    dv = dvn ? dv / dvn : NaN;
    return {
      sym: s.sym, name: s.name || s.sym, sec: r.sec, sub: s.sub || '', sp: !!s.sp,
      px: lyNum(c[i]), chg: lyPct(lyNum(c[i]), lyNum(c[i - 1])),
      L, S, sl, ss, lean, eff, held: eff !== lean, tm: J.tm, dk: J.dk, k: J.k,
      g, sig: layersSignals(b, wk, asOf, R), dv, thin: Number.isFinite(dv) && dv < R.flags.thinDollars,
      bars: b, wk, dl,
    };
  });
  return { asOf, source: input.source || '', version: R.version, outer, sectors, stocks, excluded, breadth };
}

/* Colour value in −1…+1 for a stock in the chosen view (the panel maps it onto the dashboard's seven heat stops). */
function layersTone(st, mode, R = LAYERS_RULES) {
  const C = R.colour;
  if (mode === 'buy') return Math.max(0, st.L - C.pointsBase) / C.pointsSpan;
  if (mode === 'sell') return -Math.max(0, st.S - C.pointsBase) / C.pointsSpan;
  return st.eff / C.lean;
}
/* A stock letter's cell: the number shown and its tone, by view. */
function layersCell(L, S, max, mode) {
  if (mode === 'buy') return [L, L / max];
  if (mode === 'sell') return [S, -S / max];
  return [L - S, (L - S) / max];
}

/* ── ?demo=1 input: made-up numbers on generic large caps (no holdings), deterministic ── */
const LAYERS_DEMO_NAMES = {
  NVDA: 'NVIDIA', MSFT: 'Microsoft', AAPL: 'Apple', AVGO: 'Broadcom', ORCL: 'Oracle', AMD: 'Advanced Micro Devices', CRM: 'Salesforce', INTC: 'Intel',
  GOOGL: 'Alphabet', META: 'Meta Platforms', NFLX: 'Netflix', DIS: 'Walt Disney', T: 'AT&T', AMZN: 'Amazon', TSLA: 'Tesla', HD: 'Home Depot',
  MCD: "McDonald's", NKE: 'Nike', 'BRK.B': 'Berkshire Hathaway', JPM: 'JPMorgan Chase', V: 'Visa', MA: 'Mastercard', BAC: 'Bank of America',
  WFC: 'Wells Fargo', LLY: 'Eli Lilly', UNH: 'UnitedHealth Group', JNJ: 'Johnson & Johnson', ABBV: 'AbbVie', MRK: 'Merck', GE: 'GE Aerospace',
  CAT: 'Caterpillar', RTX: 'RTX', UPS: 'United Parcel Service', BA: 'Boeing', WMT: 'Walmart', COST: 'Costco', PG: 'Procter & Gamble',
  KO: 'Coca-Cola', PEP: 'PepsiCo', XOM: 'Exxon Mobil', CVX: 'Chevron', COP: 'ConocoPhillips', NEE: 'NextEra Energy', SO: 'Southern Company',
  DUK: 'Duke Energy', PLD: 'Prologis', AMT: 'American Tower', EQIX: 'Equinix', LIN: 'Linde', SHW: 'Sherwin-Williams', APD: 'Air Products',
};
/* Invented tickers standing in for watchlist stocks outside the S&P 500 (never a real holding). */
const LAYERS_DEMO_EXTRA = [
  ['QBTX', 'Qubitex Systems (demo)', 'Information Technology', 'Semiconductors'],
  ['RVLN', 'Rivlon Motors (demo)', 'Consumer Discretionary', 'Automobile Manufacturers'],
  ['NOVX', 'Novexa Bio (demo)', 'Health Care', 'Biotechnology'],
];
const LAYERS_DEMO_SESSIONS = 400;

/* One made-up daily series. `shape` forces the path's tail: 'r1' (a three-day thrust off a 60-day low), 'r2' (its
   mirror), 'r3buy' / 'r3sell' (a long-term %K cross on the last session), 'run' (a strong climb), 'slump' (a slide, a
   bounce and a sell-off with long lower wicks, so the daily stochastic stays over 20 and its SELL is not held back). */
function layersDemoBars(t, seed, start, drift, vol, mVol, shape) {
  const n = t.length, rnd = lcg(seed);
  const extra = shape === 'r3buy' || shape === 'r3sell' ? 260 : 0, len = n + extra;
  const rets = [];
  for (let i = 0; i < len; i++) {
    let r = drift + (rnd() - 0.5) * 2 * vol;
    if (shape === 'r1' && i >= len - 103 && i < len - 3) r = -0.004 + (rnd() - 0.5) * vol * 0.4;
    if (shape === 'r2' && i >= len - 103 && i < len - 3) r = 0.004 + (rnd() - 0.5) * vol * 0.4;
    if (shape === 'r1' && i >= len - 3) r = 0.022;
    if (shape === 'r2' && i >= len - 3) r = -0.022;
    if (shape === 'run' && i >= len - 40) r = 0.006 + (rnd() - 0.4) * vol * 0.5;
    if (shape === 'slump' && i >= len - 90) r = (i >= len - 4 ? -0.012 : i >= len - 30 ? 0.004 : -0.003) + (rnd() - 0.5) * vol * 0.3;
    if (shape === 'r3buy') r = (i % 220 < 120 ? -0.003 : 0.0035) + (rnd() - 0.5) * vol;
    if (shape === 'r3sell') r = (i % 220 < 120 ? 0.003 : -0.0035) + (rnd() - 0.5) * vol;
    rets.push(r);
  }
  const s = { t: [], o: [], h: [], l: [], c: [], a: [], v: [] };
  let close = start;
  for (let i = 0; i < len; i++) {
    const prev = close;
    close = prev * (1 + rets[i]);
    const forced = (shape === 'r1' || shape === 'r2') && i >= len - 3;
    const open = forced ? prev * (1 + rets[i] * 0.3) : prev * (1 + (rnd() - 0.5) * vol * 0.6);
    const sold = shape === 'slump' && i >= len - 4;   /* the last four sessions sold off, with buyers under each low */
    const hi = Math.max(open, close) * (1 + rnd() * vol * 0.5), lo = Math.min(open, close) * (sold ? 0.95 : 1 - rnd() * vol * 0.5);
    s.o.push(+open.toFixed(2)); s.h.push(+hi.toFixed(2)); s.l.push(+lo.toFixed(2)); s.c.push(+close.toFixed(2));
    s.v.push(Math.round(mVol * 1e6 * (0.6 + rnd() * 0.8) * (forced ? 2.2 : sold ? 1.8 : 1)));
  }
  let end = len;
  if (extra) {
    /* the latest session where the long-term %K crosses the way asked; the series is cut so it ends there */
    const wk = stochSeries(s, WSTOCH);
    for (let i = len - 1; i > n; i--) {
      const ok = shape === 'r3buy' ? wk.k[i - 1] < 30 && wk.k[i] >= 30 : wk.k[i - 1] > 80 && wk.k[i] <= 80;
      if (ok) { end = i + 1; break; }
    }
  }
  for (const k of ['o', 'h', 'l', 'c', 'v']) s[k] = s[k].slice(end - n, end);
  s.t = t.slice();
  s.a = s.c.map((v, i) => +(v * (1 - 0.00004 * (n - 1 - i))).toFixed(2)); /* dividends: older adjusted closes a little lower */
  return s;
}

/* The last COMPLETED session: a trading day counts once its close plus the
   settle grace has passed (16:15 ET; 13:15 on an early close), the same line
   the morning scan draws. Before that, today is still running and the panel
   speaks of the session before. */
function layersLastSession(now = new Date()) {
  const d = lastTradingDay(now);
  const close = marketCloseInstant(isoDate(d));
  if (close && now.getTime() < Date.parse(close) + CLOSE_SETTLE_GRACE_MIN * 60000) {
    d.setDate(d.getDate() - 1);
    return tradingDayOnOrBefore(d);
  }
  return d;
}

function buildDemoLayersInput(now = new Date()) {
  const t = tradingISODates(LAYERS_DEMO_SESSIONS, layersLastSession(now));
  const asOf = t[t.length - 1];
  const ser = (seed, start, drift, vol) => layersDemoBars(t, seed, start, drift, vol, 5);
  const market = {
    brent: ser(301, 84, -0.0006, 0.018), dxy: ser(303, 101, -0.0002, 0.004), acwx: ser(305, 52, 0.0005, 0.009),
    tnx: ser(307, 4.4, -0.0004, 0.012), vix: ser(309, 21, 0, 0.05), hyg: ser(311, 78, 0.0002, 0.003),
    ief: ser(313, 95, 0, 0.003), spy: ser(315, 560, 0.0005, 0.009), gspc: null,
  };
  market.gspc = { t: market.spy.t, c: market.spy.c.map(v => +(v * 10.02).toFixed(2)) };
  const funds = {};
  LAYERS_SECTORS.forEach(([, f], i) => { funds[f] = ser(401 + i * 7, 60 + i * 9, 0.0002 + (i % 4) * 0.0002, 0.011); });
  const months = n => { const out = []; const d = new Date(asOf + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 2); for (let i = 0; i < n; i++) { out.unshift(d.toISOString().slice(0, 10)); d.setUTCMonth(d.getUTCMonth() - 1); } return out; };
  const md = months(12);
  const fred = {
    core: md.map((d, i) => ({ d, v: +(320 * (1 + 0.0026 * i - (i > 8 ? 0.0009 * (i - 8) : 0))).toFixed(3) })),
    unrate: md.map((d, i) => ({ d, v: [4.1, 4.1, 4.2, 4.1, 4.2, 4.2, 4.3, 4.2, 4.3, 4.3, 4.4, 4.4][i] })),
    payems: md.map((d, i) => ({ d, v: 159000 + i * 95 + (i % 3) * 20 })),
  };
  const fgr = lcg(331);
  const fearGreed = t.slice(-60).map((d, i) => ({ d, v: Math.round(38 + Math.sin(i / 7) * 14 + (fgr() - 0.5) * 8) }));
  const SHAPES = { AMD: 'r1', CVX: 'r2', NKE: 'r3buy', COST: 'r3sell', NVDA: 'run', LLY: 'run', JPM: 'run', MRK: 'slump', DIS: 'slump' };
  const stocks = [];
  DEMO_HEAT_SECTORS.forEach(([sector, list]) => list.forEach(([sym, capB, sub]) => {
    const seed = symSeed(sym);
    const r = lcg(seed);
    stocks.push({
      sym, name: LAYERS_DEMO_NAMES[sym] || sym, sector, sub, sp: true,
      bars: layersDemoBars(t, seed, 40 + r() * 400, (r() - 0.42) * 0.002, 0.012 + r() * 0.012, Math.max(2, capB / 60), SHAPES[sym]),
    });
  }));
  LAYERS_DEMO_EXTRA.forEach(([sym, name, sector, sub], i) => {
    stocks.push({ sym, name, sector, sub, sp: false, bars: layersDemoBars(t, 700 + i, 12 + i * 9, 0.001, 0.03, 0.4) });
  });
  /* a listing too young to score (scored by the panel's own rule, not dropped here) */
  const young = layersDemoBars(t, 760, 18, 0.002, 0.04, 3);
  for (const k of Object.keys(young)) young[k] = young[k].slice(-80);
  stocks.push({ sym: 'NWCO', name: 'Newco Holdings (demo)', sector: 'Industrials', sub: 'Aerospace & Defense', sp: false, bars: young });
  return {
    asOf, source: 'demo', market, funds, fred, fearGreed, stocks,
    excluded: [{ sym: 'QQQ', name: 'Invesco QQQ Trust', why: 'a fund' }, { sym: '^VIX', name: 'CBOE Volatility Index', why: 'an index' }],
  };
}
