/* Simulated trades (owner 2026-11-15: "a non-funded testing of our strategies, both options and stock purchases").
   The panel sits beside the Strategies Chart (the Layers Heat Map's name since 2026-11-15) and keeps, for every
   trade the owner opens, the moment it was opened, the price it was opened at and every Strategies Chart reading
   for that stock at that moment, and how it has done since: in dollars and in percent, today, this week, this
   month, this year and since it was opened. These are the PURE helpers (no DOM, no network), so
   tools/unit/sim.test.mjs can check every sum by hand; the panel itself is the `.sim-*` block in scripts/app.js.

   Words: a trade is a BUY (long) or a SELL (short). An option is one contract of 100 shares, named by its OCC
   symbol (`AAPL261218C00200000`: root, YYMMDD, C or P, strike × 1000 in eight digits). Nothing here is money the
   owner holds: no account, balance or holding is read or stored. */

const SIM_STOCK_RE = /^[A-Z0-9.^=-]{1,10}$/;
const SIM_OCC_RE = /^([A-Z][A-Z.-]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const SIM_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SIM_PERIODS = Object.freeze([['day', 'Today'], ['week', 'Week'], ['month', 'Month'], ['year', 'YTD'], ['all', 'Since start']]);

/* What the owner typed → a stock or an option, or null. Spaces are ignored and the case does not matter, so an
   OCC symbol pasted from a broker (`AMD   261218C00195000`) is read the same as the compact form. An option whose
   month or day cannot exist is not an option (and, being too long for a ticker, nothing). */
function simParseSym(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  const m = SIM_OCC_RE.exec(s);
  if (m) {
    const [, under, yy, mm, dd, right, k] = m;
    const y = 2000 + Number(yy), mo = Number(mm), d = Number(dd);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (mo < 1 || mo > 12 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    const strike = Number(k) / 1000;
    if (!(strike > 0)) return null;
    return { kind: 'option', sym: s, under, exp: y + '-' + mm + '-' + dd, right, strike, mult: 100 };
  }
  if (SIM_STOCK_RE.test(s)) return { kind: 'stock', sym: s, under: s, exp: null, right: null, strike: null, mult: 1 };
  return null;
}

/* Underlying, expiry (YYYY-MM-DD), C/P and strike → the OCC symbol, or null when any part is not usable. */
function simOcc(under, expIso, right, strike) {
  const u = String(under || '').trim().toUpperCase();
  const m = /^20(\d{2})-(\d{2})-(\d{2})$/.exec(String(expIso || ''));
  const r = String(right || '').toUpperCase();
  const k = Math.round(Number(strike) * 1000);
  if (!/^[A-Z][A-Z.-]{0,5}$/.test(u) || !m || (r !== 'C' && r !== 'P') || !(k > 0) || k > 99999999) return null;
  const out = u + m[1] + m[2] + m[3] + r + String(k).padStart(8, '0');
  return simParseSym(out) ? out : null;
}

/* The contract line under an option, as IBKR prints it: `Dec 18 '26 195 Call`. */
function simContractLabel(p) {
  if (!p || p.kind !== 'option') return '';
  const [y, mo, d] = p.exp.split('-').map(Number);
  return SIM_MONTHS[mo - 1] + ' ' + d + " '" + String(y).slice(2) + ' ' + (+p.strike.toFixed(3)) + ' ' + (p.right === 'C' ? 'Call' : 'Put');
}

/* The close of the last daily bar ON or BEFORE `iso` (strictly before when `before`), NaN when there is none. */
function simCloseOn(series, iso, before) {
  if (!series || !series.t || !series.c) return NaN;
  for (let i = series.t.length - 1; i >= 0; i--) {
    const t = String(series.t[i]).slice(0, 10);
    if (before ? t < iso : t <= iso) { const v = Number(series.c[i]); return Number.isFinite(v) && v > 0 ? v : NaN; }
  }
  return NaN;
}

/* Where each period starts, as a New York calendar date: today, the Monday of this week, the 1st of this month,
   January 1st. "Today" is measured from the previous close, the others from the last close BEFORE their first day. */
function simPeriodStarts(nyDate) {
  const [y, m, d] = nyDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mon = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000);
  return { day: nyDate, week: mon.toISOString().slice(0, 10), month: nyDate.slice(0, 8) + '01', year: nyDate.slice(0, 5) + '01-01' };
}

/* One trade's numbers. `tr`: { side 'buy'|'sell', qty, mult, entry, openedDay (NY date it was opened), closedDay
   and exit when closed }. `q`: { price (now), prev (the previous close, for Today), series (daily bars) }. `nyDate`:
   today in New York.
   For a period that starts on S the trade's result is  sign × qty × mult × (end − base), where
     base = the entry price if the trade was opened on or after S, else the close before S (Today: the previous close),
     end  = the exit price once the trade is closed, else the price now,
   and a trade closed BEFORE S takes no part (null). The percent is that result over |base| × qty × mult, so a
   SELL that gains when the price falls reads positive. Unknown inputs give null, never 0. */
function simTradeNumbers(tr, q, nyDate) {
  const sign = tr.side === 'sell' ? -1 : 1, units = Number(tr.qty) * (Number(tr.mult) || 1);
  const entry = Number(tr.entry), closed = !!tr.closedDay;
  const now = closed ? Number(tr.exit) : Number(q && q.price);
  const ok = v => Number.isFinite(v) && v > 0;
  const out = { sign, units, cost: ok(entry) && units > 0 ? sign * units * entry : null, value: null, pnl: null, pct: null, periods: {} };
  if (ok(now) && units > 0) out.value = sign * units * now;
  const starts = simPeriodStarts(nyDate);
  for (const [k] of SIM_PERIODS) {
    let base, inPeriod = true;
    if (k === 'all') base = entry;
    else {
      const S = starts[k];
      if (closed && tr.closedDay < S) inPeriod = false;
      if (tr.openedDay >= S) base = entry;
      else if (k === 'day') base = Number(q && q.prev);
      else base = simCloseOn(q && q.series, S, true);
    }
    if (!inPeriod) { out.periods[k] = null; continue; }
    if (!(ok(base) && ok(now) && units > 0)) { out.periods[k] = { pnl: null, pct: null, base: ok(base) ? units * base : null }; continue; }
    out.periods[k] = { pnl: sign * units * (now - base), pct: sign * (now - base) / base * 100, base: units * base };
  }
  if (out.periods.all) { out.pnl = out.periods.all.pnl; out.pct = out.periods.all.pct; }
  return out;
}

/* The whole simulation over a period: the trades that take part and have a number, summed; the percent is the sum
   over the sum of their bases. `n` counts the trades summed and `missing` the ones that take part but could not be
   priced, so a total is never shown as complete when it is not. */
function simTotals(nums, k) {
  let pnl = 0, base = 0, n = 0, missing = 0;
  for (const x of nums) {
    const p = x && x.periods[k];
    if (p === null || p === undefined) continue;
    if (p.pnl == null || p.base == null) { missing++; continue; }
    pnl += p.pnl; base += p.base; n++;
  }
  return { pnl: n ? pnl : null, pct: n && base > 0 ? pnl / base * 100 : null, n, missing };
}

/* Demo prices for an option contract, drawn from its underlying's bars (made-up numbers for ?demo=1 only): what it
   is worth if exercised, plus time value that shrinks as expiry nears. Never used in live. */
function simDemoOptionSeries(p, under) {
  if (!under || !under.t) return null;
  const expMs = Date.parse(p.exp + 'T21:00:00Z');
  const c = under.c.map((s, i) => {
    const days = Math.max(0, (expMs - Date.parse(String(under.t[i]).slice(0, 10) + 'T21:00:00Z')) / 86400000);
    const intrinsic = Math.max(0, p.right === 'C' ? s - p.strike : p.strike - s);
    const time = s * 0.3 * Math.sqrt(days / 365) * 0.4;
    return Math.max(0.05, Math.round((intrinsic + time) * 100) / 100);
  });
  return { t: under.t.slice(), c };
}
