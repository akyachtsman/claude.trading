/* Do the desk's S/R levels actually hold? — re-runnable evidence.
 *
 *   node .agent-reports/sr-level-backtest.mjs
 *
 * Fetches its own daily bars from the public quote-proxy, so it needs no
 * local fixtures and no session-specific paths (Codex review, PR #246 — the
 * first cut read from a scratchpad directory nobody else had).
 *
 * Two things this measures carefully, both of which the first cut got wrong:
 *
 * DIRECTION IS PART OF THE LEVEL. R levels are resistance and S levels are
 * support; each is tested only against the break that would falsify it. The
 * first cut assigned the role retroactively from the touch day's close, so a
 * breakout ABOVE R1 followed by more strength scored as "resistance held" —
 * counting the model's failures as successes.
 *
 * THE NULL IS MATCHED EVENT FOR EVENT. For every real touch we draw one random
 * level inside that same day's range and give it the same role, so the
 * baseline shares the day, the volatility, the direction and the sample count.
 * The first cut drew randoms that always touched, comparing a selected subset
 * of days against all of them.
 */
const SYMBOLS = ['SHY','SLV','QQQ','SMH','TLT','XLE','SPY','EEM','GLD','VXX'];
const PROXY = 'https://kwugzhyfjevzwgplhtsd.supabase.co/functions/v1/quote-proxy';
const ANON = 'sb_publishable_5SCxDQzd0D7aEbbgG3C_3w_4cvGNP0E';

async function bars(sym) {
  const r = await fetch(PROXY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: ANON,
               authorization: `Bearer ${ANON}`, origin: 'https://akyachtsman.github.io' },
    body: JSON.stringify({ symbol: sym, kind: 'daily' }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${sym}: ${j.error || 'fetch failed'}`);
  return j.series;
}

const periodKey = (iso, p) => p === 'month' ? iso.slice(0, 7)
  : p === 'week' ? (d => { d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })(new Date(iso + 'T00:00:00Z'))
  : iso;

/* Classic floor-trader pivots off the prior period — the shipped model.
   Returned WITH their role so the test can never lose it. */
function pivots(s, i, period) {
  const cur = periodKey(s.t[i], period);
  let hi = -Infinity, lo = Infinity, close = null, k = null;
  for (let j = i; j >= 0; j--) {
    const kk = periodKey(s.t[j], period);
    if (kk === cur) continue;
    if (k === null) { k = kk; close = s.c[j]; } else if (kk !== k) break;
    hi = Math.max(hi, s.h[j]); lo = Math.min(lo, s.l[j]);
  }
  if (k === null || !Number.isFinite(hi)) return null;
  const p = (hi + lo + close) / 3;
  return [
    { v: 2 * p - lo, role: 'R' }, { v: p + (hi - lo), role: 'R' }, { v: hi + 2 * (p - lo), role: 'R' },
    { v: 2 * p - hi, role: 'S' }, { v: p - (hi - lo), role: 'S' }, { v: lo - 2 * (hi - p), role: 'S' },
  ];
}

/* Prior swing highs / lows — the obvious alternative. A swing high is a bar
   whose high tops its k neighbours each side; it acts as resistance. */
function swings(s, i, k = 3, want = 6) {
  const out = [];
  for (let j = i - k - 1; j >= Math.max(k, i - 260); j--) {
    let isH = true, isL = true;
    for (let d = -k; d <= k; d++) {
      if (!d) continue;
      if (s.h[j + d] >= s.h[j]) isH = false;
      if (s.l[j + d] <= s.l[j]) isL = false;
    }
    if (isH) out.push({ v: s.h[j], role: 'R' });
    if (isL) out.push({ v: s.l[j], role: 'S' });
    if (out.length >= want) break;
  }
  return out.length ? out : null;
}

const atr = (s, i, len = 14) => {
  let a = 0;
  for (let j = i - len + 1; j <= i; j++)
    a += Math.max(s.h[j] - s.l[j], Math.abs(s.h[j] - s.c[j - 1]), Math.abs(s.l[j] - s.c[j - 1]));
  return a / len;
};

/* Held = price never closed through the level in the direction that would
   falsify it. Resistance breaks upward, support breaks downward. */
function held(s, i, lv, horizon, tol, a) {
  for (let d = 1; d <= horizon; d++) {
    if (lv.role === 'R' ? s.c[i + d] > lv.v + tol * a : s.c[i + d] < lv.v - tol * a) return false;
  }
  return true;
}

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function score(data, pick, horizon, tol) {
  let n = 0, ok = 0, nullN = 0, nullOk = 0;
  for (const s of data) {
    for (let i = 300; i < s.c.length - horizon - 1; i++) {
      const lv = pick(s, i); if (!lv) continue;
      const a = atr(s, i); if (!(a > 0)) continue;
      for (const L of lv) {
        if (!(s.l[i] <= L.v && L.v <= s.h[i])) continue;   // touched today
        n++; if (held(s, i, L, horizon, tol, a)) ok++;
        // matched null: same day, same role, random position inside the range
        const r = { v: s.l[i] + rnd() * (s.h[i] - s.l[i]), role: L.role };
        nullN++; if (held(s, i, r, horizon, tol, a)) nullOk++;
      }
    }
  }
  return { n, rate: ok / n, nullRate: nullOk / nullN };
}

const data = [];
for (const sym of SYMBOLS) { try { data.push(await bars(sym)); } catch (e) { console.error(String(e.message)); } }
console.log(`loaded ${data.length}/${SYMBOLS.length} symbols\n`);

const MODELS = [
  ['pivots monthly', (s, i) => pivots(s, i, 'month')],
  ['pivots weekly',  (s, i) => pivots(s, i, 'week')],
  ['pivots daily',   (s, i) => pivots(s, i, 'day')],
  ['swing hi/lo',    (s, i) => swings(s, i)],
];
console.log('model            horiz  tol   touches   held   matched-null    edge');
for (const [name, pick] of MODELS) {
  for (const h of [1, 3, 5]) for (const t of [0.10, 0.25, 0.50]) {
    const r = score(data, pick, h, t);
    console.log(name.padEnd(16), String(h).padStart(3), t.toFixed(2).padStart(6),
      String(r.n).padStart(8), (100 * r.rate).toFixed(1).padStart(7) + '%',
      (100 * r.nullRate).toFixed(1).padStart(12) + '%',
      ((r.rate - r.nullRate) * 100).toFixed(1).padStart(8) + ' pts');
  }
}
