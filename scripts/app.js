'use strict';
/* ── app.js — rendering + interactions ───────────────────────────────────
   Depends on config.js + data.js. All dynamic text via textContent. */

/* ── DOM + SVG helpers ─────────────────────────────────────────────────── */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function pathFrom(points) { return points.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''); }

function sparkline(values, w, h, stroke) {
  const svg = svgEl('svg', { viewBox: '0 0 ' + w + ' ' + h, 'aria-hidden': 'true', focusable: 'false' });
  const min = Math.min(...values), max = Math.max(...values), span = (max - min) || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * (w - 2) + 1, h - 2 - (v - min) / span * (h - 4)]);
  const area = pathFrom(pts) + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (h - 1) + 'L' + pts[0][0].toFixed(1) + ' ' + (h - 1) + 'Z';
  svg.appendChild(svgEl('path', { d: area, fill: stroke, opacity: '0.12' }));
  svg.appendChild(svgEl('path', { d: pathFrom(pts), fill: 'none', stroke: stroke, 'stroke-width': '1.5' }));
  return svg;
}

const seriesColor = key => 'var(--color-series-' + key + ')';

/* ── shared state ──────────────────────────────────────────────────────── */
const DESK = {
  mode: 'demo',        /* 'demo' | 'live' */
  authed: false,
  data: null,          /* {accounts, market, news, labels, asOfDate} */
  liveStamp: null,     /* freshest market-feed {generatedAt, asOf} — masthead lamp */
};

/* ── masthead ──────────────────────────────────────────────────────────── */
function renderMasthead() {
  const wrap = document.getElementById('mastheadState');
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  /* "MARKETS" label (owner report 2026-07-22): this cluster is the market-feed
     lamp, not an Accounts indicator — sitting in the Accounts header without a
     name reads as ambiguous. Label it, matching the Markets panel's own
     "Markets ● Live" convention. */
  wrap.appendChild(el('span', 'masthead-label', 'MARKETS'));
  if (DESK.mode === 'demo') {
    wrap.appendChild(el('span', 'lamp lamp--demo', 'Demo data'));
    wrap.appendChild(el('span', 'lamp lamp--eod', 'EOD snapshot'));
  } else {
    /* live-derived: the market feed's stamp stands for the public layer —
       no committed meta.json anymore (retire-nightly-pipeline Group C).
       The "Last updated" text stamp here was removed (owner report
       2026-07-24: no purpose floating next to Lock) — the lamp text
       (LIVE/EOD/STALE) is the signal; the Markets panel's own stamp
       already carries the full as-of time for anyone who wants it. */
    const lamp = DESK.liveStamp
      ? liveLampFor(DESK.liveStamp.generatedAt, DESK.liveStamp.asOf, true, DESK.liveStamp.quoteAt, DESK.liveStamp.extAt)
      : { cls: 'lamp--stale', text: 'Stale', stamp: 'Live feed unreachable' };
    wrap.appendChild(el('span', 'lamp ' + lamp.cls, lamp.text));
    /* manual force-refresh (owner request 2026-07-27): market/news/heatmap/
       charts are public feeds, so this shows regardless of PIN-auth state. */
    if (DESK_DB.url) {
      const refreshBtn = el('button', 'btn btn-secondary', 'Refresh now');
      refreshBtn.type = 'button';
      refreshBtn.id = 'refreshNowBtn';
      refreshBtn.addEventListener('click', refreshNowClicked);
      wrap.appendChild(refreshBtn);
    }
    if (DESK.authed) {
      const lock = el('button', 'btn btn-secondary', 'Lock');
      lock.type = 'button';
      /* renderWatchlist too: its ✎ and its draggable tiles are auth-gated, and
         leaving them live after a lock would let a drag change the order and
         then silently revert (Codex review, PR #190) */
      lock.addEventListener('click', () => { sessionStorage.removeItem('desk_pin'); DESK.authed = false; renderPrivate(); renderMasthead(); renderWatchlist(); });
      wrap.appendChild(lock);
    }
  }
}
function lastLabel() {
  return DESK.data && DESK.data.labels.length ? DESK.data.labels[DESK.data.labels.length - 1] : '—';
}

/* ── Markets window (owner request 2026-07-20) ─────────────────────────────
   A compact markets tab: region tabs, three index tiles, a normalized
   multi-index %-change chart with timeframe toggles, and a sector grid. Tiles
   and sector cells read from the shared market feed; the chart series are
   demo-generated or fetched live (SPY/QQQ/IWM via deskQuote). */
const MKT_INDEX = [
  { key: 'sp', label: 'S&P 500', tile: 'S&P 500', proxy: 'SPY', color: '#2f6df0' },
  { key: 'nq', label: 'NASDAQ', tile: 'Nasdaq Composite', proxy: 'QQQ', color: '#7c3aed' },
  { key: 'ru', label: 'Russell 2000', tile: 'IWM (R2K proxy)', proxy: 'IWM', color: '#ea6a1e' },
  { key: 'dj', label: 'Dow Jones', tile: 'Dow Jones', proxy: 'DIA', color: '#0d9488' },
];
const MKT_SECTORS = [
  ['Technology', 'XLK'], ['Financials', 'XLF'], ['Health Care', 'XLV'], ['Cons. Disc.', 'XLY'],
  /* "Comm. Svcs", not "Communication": the stacked strip gives the label 67px
     and the full word needs 83, and it is the one name here that is a single
     unbreakable word. Abbreviating matches the panel's own convention for the
     other two long sectors rather than adding a font hack for one row. */
  ['Comm. Svcs', 'XLC'], ['Cons. Staples', 'XLP'], ['Energy', 'XLE'], ['Industrials', 'XLI'],
  ['Materials', 'XLB'], ['Utilities', 'XLU'], ['Real Estate', 'XLRE'],
];
const MKT_TFS = [['today', 'Today'], ['5d', '5D'], ['1m', '1M'], ['1y', '1Y'], ['2y', '2Y']];
const MKT_REGIONS = [['us', 'U.S.', true], ['eu', 'Europe', false], ['as', 'Asia', false], ['fx', 'FX', false]];
let mktState = { tf: 'today', region: 'us', series: null, lamp: { cls: 'lamp--demo', text: 'Demo' } };
const mktTileByName = (market, name) => (market || []).find(m => m.name === name) || null;

function renderMarkets(market, lamp) {
  if (lamp) mktState.lamp = lamp;
  const lampEl = document.getElementById('mktLamp');
  if (!lampEl) return;   /* panel not in the DOM */
  lampEl.className = 'lamp ' + mktState.lamp.cls; lampEl.textContent = mktState.lamp.text;
  const stampEl = document.getElementById('mktStamp');
  /* uniform stamp from the feed lamp; demo shows the date only */
  /* live: the real feed stamp or an honest '—' (never a demo-derived date —
     lastLabel() reads the demo label calendar; Codex #150). Demo keeps it. */
  if (stampEl) {
    if (DESK.mode !== 'demo') applyLampStamp(stampEl, mktState.lamp);
    else applyStamp(stampEl, '', lastLabel(), '');
  }

  /* region tabs — U.S. is live; the others are placeholders until sourced */
  const reg = document.getElementById('mktRegions');
  if (reg && !reg.childElementCount) {
    for (const [key, label, on] of MKT_REGIONS) {
      const b = el('button', 'mk-region', label);
      b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(key === mktState.region));
      if (!on) b.disabled = true;
      else b.addEventListener('click', () => { mktState.region = key; renderMarkets(DESK.data.market); });
      reg.appendChild(b);
    }
  }

  /* index tiles */
  const tilesBox = document.getElementById('mktTiles');
  while (tilesBox.firstChild) tilesBox.removeChild(tilesBox.firstChild);
  for (const ix of MKT_INDEX) {
    const t = mktTileByName(market, ix.tile), pct = t ? t.chg : null;
    const cell = el('div', 'mk-tile');
    cell.style.setProperty('--mk-c', ix.color);
    cell.appendChild(el('div', 'mk-name', ix.label));
    cell.appendChild(el('div', 'mk-pct ' + (pct == null ? '' : pct >= 0 ? 'up' : 'down'), pct == null ? '—' : fmtPct(pct)));
    cell.appendChild(el('div', 'mk-last', t ? t.last : '—'));
    /* Extended-hours line (owner request 2026-07-30). POST only: the owner
       reads after-hours, not pre-market, so the feed computes a pre print but
       nothing draws it here — enabling it is a one-line change.

       An index tile shows its PROXY and names it, because SPY's after-hours
       move is not the S&P 500's value and an unlabelled number would claim it
       was.

       extProxy is preferred over ext (Codex review, PR #199): in LIVE data the
       R2K tile receives BOTH, because its symbol IS IWM and IWM is also in the
       proxy map. Taking `ext` first dropped the "IWM" label and printed a bare
       second percentage on a tile captioned "Russell 2000" — losing exactly the
       attribution this line exists to carry. Demo only ever sends extProxy, so
       S23 could not have caught it. */
    const xt = t && (t.extProxy && t.extProxy.kind === 'post' ? t.extProxy
      : t.ext && t.ext.kind === 'post' ? t.ext : null);
    if (xt && xt.chg != null) {
      const line = el('div', 'mk-ext');
      const num = el('span', 'mk-ext-pct ' + (xt.chg >= 0 ? 'up' : 'down'),
        (xt.sym ? xt.sym + ' ' : '') + fmtPct(xt.chg));
      line.appendChild(num);
      line.appendChild(el('span', 'mk-ext-tag', 'after hrs'));
      /* Both numbers measure from the SAME prior close, so the tooltip can say
         so plainly — otherwise a reader could take the smaller one for a move
         off the closing print. */
      line.title = (xt.sym ? xt.sym + ' ' : ix.label + ' ') + xt.last +
        ' after hours, ' + fmtPct(xt.chg) + ' from the prior close' +
        (xt.at ? ' · last print ' + fmtClock(new Date(xt.at * 1000)) : '');
      cell.appendChild(line);
    }
    /* This tile's OWN quote clock. The panel stamp is a floor across all four,
       so a tile quoted later than the floor would otherwise look staler than it
       is; the tooltip is where an exact broker-vs-desk comparison gets made. */
    if (t && t.quoteTs) cell.title = ix.label + ' quoted ' + fmtClock(new Date(t.quoteTs * 1000));
    tilesBox.appendChild(cell);
  }

  /* timeframe seg */
  const tfBox = document.getElementById('mktTf');
  if (!tfBox.childElementCount) {
    for (const [key, label] of MKT_TFS) {
      const b = el('button', '', label);
      b.type = 'button'; b.setAttribute('aria-pressed', String(key === mktState.tf));
      b.addEventListener('click', () => { mktState.tf = key; renderMarkets(DESK.data.market); });
      tfBox.appendChild(b);
    }
  } else {
    [...tfBox.children].forEach((b, i) => b.setAttribute('aria-pressed', String(MKT_TFS[i][0] === mktState.tf)));
  }

  drawMktChart();

  /* Sector strip — the WATCHLIST tile idiom, stacked (owner request
     2026-08-07: "I like the watchlist icons better"). Each sector is one wide,
     short row rather than a cell in a tinted grid, which buys two things the
     grid could not give at 258px: the sector NAME is spelled out beside its
     ticker instead of being squeezed to 9px, and price + sparkline fit on the
     same line as the move.
     The heat TINT is deliberately gone with the grid. It encoded the same
     number the pill now states outright, and reading a tint against a pill on
     one row is reading one fact twice; the pill is also the watchlist's own
     idiom, which is what was asked for. */
  const secBox = document.getElementById('mktSectors');
  while (secBox.firstChild) secBox.removeChild(secBox.firstChild);
  for (const [name, sym] of MKT_SECTORS) {
    const t = mktTileByName(market, sym), pct = t ? t.chg : null;
    const row = el('div', 'mkt-tile mk-sec');

    const lab = el('span', 'mk-sec-label');
    lab.appendChild(el('span', 'mk-sec-name', name));
    lab.appendChild(el('span', 'mkt-name', sym));
    row.appendChild(lab);

    /* `last` arrives PRE-FORMATTED as a string from the feed (demo mirrors it),
       which is why this uses it verbatim like the index tiles above rather than
       the watchlist's `wlPx` — that takes a number and renders any string as an
       em dash, which is what every sector row showed on the first cut. */
    row.appendChild(el('span', 'mkt-last', t && t.last ? t.last : '—'));

    /* Coloured by the DAY's direction so the line agrees with the pill beside
       it — a green line against a red pill is two answers to one question. */
    if (t && Array.isArray(t.spark) && t.spark.length >= 2) {
      const wrap = el('span', 'wl-spark');
      wrap.appendChild(sparkline(t.spark, WL_SPARK_W, WL_SPARK_H,
        (pct ?? 0) >= 0 ? 'var(--color-gain)' : 'var(--color-loss)'));
      row.appendChild(wrap);
    }

    if (pct != null) {
      row.appendChild(el('span', (pct >= 0 ? 'pill pill--gain' : 'pill pill--loss') + ' mk-sec-pct', fmtPct(pct)));
    } else {
      row.appendChild(el('span', 'mk-sec-pct mk-sec-pct--none', '—'));
    }

    /* Sector ETFs genuinely trade after the bell, so this is their OWN
       post-market move and needs no proxy label. It was briefly tooltip-only,
       when the column was 258px and a sixth item on the row crushed the label
       to 8px; the column was widened to 311px instead (owner request
       2026-08-07) precisely so this can be read at a glance rather than hunted
       for one row at a time. The tooltip stays as well, because it carries the
       after-hours PRICE, which the row has no space to state. */
    if (t && t.ext && t.ext.kind === 'post' && t.ext.chg != null) {
      const x = el('span', 'mk-sec-ext ' + (t.ext.chg >= 0 ? 'up' : 'down'), fmtPct(t.ext.chg));
      x.title = name + ' (' + sym + ') ' + t.ext.last + ' after hours, '
        + fmtPct(t.ext.chg) + ' from the prior close';
      row.appendChild(x);
    }
    secBox.appendChild(row);
  }
}

/* Pin the Ask-the-desk panel's BOTTOM to the Markets panel's bottom (owner
   request 2026-07-22: "the bottom of ask-the-desk should line up with
   Markets"). Flex alone can't cap one sibling by another sibling's height —
   with long answers the Ask panel outgrew the row. Measure the rendered
   Markets column (getBoundingClientRect is post-`zoom`, and the rail is
   unzoomed so viewport px == its CSS px) and pin the rail panel to exactly
   that height; the thread scrolls inside. Cleared when the top band stacks
   (≤1280px), where the thread's own 320px cap rules instead. */
/* `syncAskHeight()` lived here until 2026-08-07. It measured the Markets column
   and wrote that height onto the Ask panel, because flex cannot cap one sibling
   by another's height and long answers used to outgrow the row. Both reasons
   are gone: Ask swapped out of the top band into `.top-boxes`, and the top
   band's columns are stretch-sized, so the row equalises itself. Left in place
   it was worse than useless — its `.top-band > .col-rail > .panel` query no
   longer matches anything, so it silently returned and read as live code.
   `mktSecTint()` went with the tinted sector grid it existed to colour. */

function drawMktChart() {
  const svg = document.getElementById('mktChart');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 600)), H = 150;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const set = mktState.series && mktState.series[mktState.tf];
  const isToday = mktState.tf === 'today';
  const lines = set ? MKT_INDEX.map(ix => {
    let vals = set[ix.key];
    /* Today: land the line exactly on the tile's live day-% (owner ruling
       2026-07-22). Re-pinned here (not baked in) so it tracks the ticking tile. */
    if (isToday && vals && vals.length) {
      const t = mktTileByName(DESK.data.market, ix.tile);
      if (t) vals = pinEnd(vals, t.chg);
    }
    return { color: ix.color, vals };
  }).filter(l => l.vals && l.vals.length) : [];
  const padR = 46, plotW = W - padR - 6, plotH = H - 14;
  if (!lines.length) {
    const tx = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', 'font-family': 'var(--font-sans)', 'font-size': 11, fill: 'var(--color-text-secondary)' });
    tx.textContent = 'Loading index series…';
    svg.appendChild(tx); return;
  }
  const all = lines.flatMap(l => l.vals);
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const span = (hi - lo) || 1; lo -= span * 0.08; hi += span * 0.08;
  const sy = v => 6 + (hi - v) / (hi - lo) * plotH;
  const sx = (i, n) => 4 + (n > 1 ? i / (n - 1) : 0.5) * plotW;
  /* nice %-labelled gridlines, zero line emphasised */
  const rawStep = (hi - lo) / 4, mag = Math.pow(10, Math.floor(Math.log10(rawStep))), norm = rawStep / mag;
  let nice = 1; for (const c of [1, 2, 2.5, 5, 10]) if (Math.abs(c - norm) < Math.abs(nice - norm)) nice = c;
  const step = nice * mag;
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) {
    const y = sy(v), zero = Math.abs(v) < 1e-9;
    svg.appendChild(svgEl('line', { x1: 4, y1: y, x2: 4 + plotW, y2: y, stroke: zero ? 'var(--color-border-hover)' : 'var(--color-border)', 'stroke-width': 1, 'stroke-dasharray': zero ? '' : '3 3', 'shape-rendering': 'crispEdges' }));
    const tx = svgEl('text', { x: 4 + plotW + 4, y: y + 3, 'font-family': 'var(--font-mono)', 'font-size': 9, fill: 'var(--color-text-secondary)' });
    tx.textContent = (v >= 0 ? '' : '−') + Math.abs(v).toFixed(2) + '%';
    svg.appendChild(tx);
  }
  for (const l of lines) {
    const n = l.vals.length;
    const d = l.vals.map((v, i) => (i ? 'L' : 'M') + sx(i, n).toFixed(1) + ' ' + sy(v).toFixed(1)).join('');
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 1.6 }));
  }
}

/* Live chart series: fetch each index proxy's daily (covers 1M/1Y/2Y) and
   intraday (covers Today/5D) once. Multi-day windows normalise to %-change from
   the window's first bar (0 at the left edge). "Today" is special (owner ruling
   2026-07-22): the line must open at 0% on the prior close, trace the real
   intraday %-change bar by bar, and finish EXACTLY on the headline day-% the
   tile shows (e.g. −0.64%). buildMktSeries stores the raw prior-close path;
   drawMktChart re-pins its right edge to the live tile each render (below), so
   the line always agrees with the tile even as the tile ticks through the day.
   Runs after the first live market render; tiles + sectors already show, so a
   failure just leaves the chart in its loading state. */
let mktSeriesPending = false, mktSeriesDone = false;
function normPct(closes, start) {
  const base = closes[start];
  if (!base) return [];
  return closes.slice(start).map(c => Number(((c / base - 1) * 100).toFixed(3)));
}
/* Today's raw path: 0% at the prior session close, then real %-change per bar.
   Isolates TODAY's bars (by date) so early-session windows don't bleed into the
   prior day, and anchors to the prior session's last close so the opening gap
   shows honestly. Endpoint pinning to the exact tile day-% happens at draw. */
function todayLine(intra) {
  const c = (intra && intra.c) || [], t = (intra && intra.t) || [];
  if (c.length < 2 || t.length !== c.length) return [];
  const day = (t[t.length - 1] || '').slice(0, 10);            /* latest bar's date */
  let first = 0; while (first < t.length && t[first].slice(0, 10) !== day) first++;
  const base = first > 0 ? c[first - 1] : c[0];                /* prior session close */
  const todays = c.slice(first);
  if (!base || todays.length < 1) return [];
  return [0, ...todays.map(x => Number(((x / base - 1) * 100).toFixed(3)))];   /* lead 0 = prior close */
}
function buildMktSeries(per) {
  const out = { today: {}, '5d': {}, '1m': {}, '1y': {}, '2y': {} };
  for (const p of per) {
    const d = (p.daily && p.daily.c) || [], i = (p.intra && p.intra.c) || [];
    out.today[p.key] = todayLine(p.intra);
    out['5d'][p.key] = i.length ? normPct(i, 0) : [];
    out['1m'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 22)) : [];
    out['1y'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 252)) : [];
    out['2y'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 504)) : [];
  }
  return out;
}
/* Pin a raw %-change path's right edge to `target` while keeping its shape: a
   hairline linear tilt so the line still opens at 0 and now closes exactly on
   the index tile's day-%. Reconciles the ETF proxy's close with the index's. */
function pinEnd(raw, target) {
  const m = raw.length - 1;
  if (m < 1 || typeof target !== 'number' || !Number.isFinite(target)) return raw;
  const drift = target - raw[m];
  return raw.map((v, i) => Number((v + drift * (i / m)).toFixed(3)));
}
async function fetchMktSeries() {
  if (mktSeriesPending || mktSeriesDone || DESK.mode === 'demo' || !DESK_DB.url) return;
  mktSeriesPending = true;
  try {
    const per = await Promise.all(MKT_INDEX.map(async ix => {
      const [daily, intra] = await Promise.all([
        deskQuote(ix.proxy, 'daily').catch(() => null),
        deskQuote(ix.proxy, 'intraday').catch(() => null),
      ]);
      return { key: ix.key, daily: daily && daily.ok ? daily.series : null, intra: intra && intra.ok ? intra.series : null };
    }));
    if (per.some(p => p.daily || p.intra)) { mktState.series = buildMktSeries(per); mktSeriesDone = true; renderMarkets(DESK.data.market); }
  } catch { /* keep the loading state; tiles + sectors are unaffected */ }
  finally { mktSeriesPending = false; }
}

/* redraw the markets chart on resize (viewBox width tracks the panel) */
let mktResizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(mktResizeTimer); mktResizeTimer = setTimeout(drawMktChart, 150); });

/* ── sortable tables (design.md standard) ──────────────────────────────── */
function makeSortable(table) {
  const heads = [...table.tHead.rows[0].cells], body = table.tBodies[0];
  const blank = v => v === '' || v === '—' || v == null;
  const go = th => {
    const i = th.cellIndex, num = th.dataset.type === 'number';
    const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
    const s = dir === 'ascending' ? 1 : -1;
    heads.forEach(h => h.setAttribute('aria-sort', 'none'));
    th.setAttribute('aria-sort', dir);
    const val = tr => { const c = tr.cells[i]; return c.dataset.sort ?? c.textContent.trim(); };
    [...body.rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (blank(x) && blank(y)) return 0;
      if (blank(x)) return 1;
      if (blank(y)) return -1;
      return (num ? x - y : ('' + x).localeCompare(y, undefined, { sensitivity: 'base', numeric: true })) * s;
    }).forEach(tr => body.appendChild(tr));
  };
  heads.forEach(th => {
    th.onclick = () => go(th);
    th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(th); } };
  });
}

/* ── account windows ───────────────────────────────────────────────────── */
function renderAccounts(accounts, lamp) {
  const grid = document.getElementById('accountGrid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  if (!accounts.length) {
    /* authed but pre-first-refresh: say so plainly instead of a blank grid */
    grid.appendChild(el('p', 'stamp',
      'No account data yet — the first IBKR snapshot lands after the next market close (retried each morning).'));
    return;
  }
  for (const a of accounts) {
    const panel = el('section', 'panel account');
    panel.setAttribute('aria-label', a.label + ' account');

    const head = el('div', 'panel-header');
    head.appendChild(el('span', 'key-dot key-dot--' + a.key));
    head.appendChild(el('h3', 'panel-title', a.label));
    head.appendChild(el('span', 'acct-code', a.code));
    head.appendChild(el('span', 'lamp ml-auto ' + lamp.cls, lamp.text));
    panel.appendChild(head);

    const navWrap = el('div', 'acct-nav');
    navWrap.appendChild(el('div', 'stat-label', 'Net liquidation'));
    navWrap.appendChild(el('div', 'hero-number', fmtUsd(a.nav)));
    panel.appendChild(navWrap);

    const stats = el('div', 'acct-stats');
    const dayPct = a.day / (a.nav - a.day) * 100;
    const statDefs = [
      ['Day P&L', fmtSigned(a.day) + ' (' + fmtPct(dayPct) + ')', a.day],
      ['Total unrealized', fmtSigned(a.total), a.total],
      ['Cash', fmtUsd0(a.cash), 0],
      ['Positions', String(a.positions.length), 0],
    ];
    for (const [label, value, sign] of statDefs) {
      const s = el('div', 'stat');
      s.appendChild(el('div', 'stat-label', label));
      s.appendChild(el('div', 'stat-value' + (sign > 0 ? ' up' : sign < 0 ? ' down' : ''), value));
      stats.appendChild(s);
    }
    panel.appendChild(stats);

    if (a.equity && a.equity.length > 1) {
      /* one-year trend window (252 trading days; fewer early on → renders
         what's accumulated). Owner ruling 2026-07-16. */
      const spark = sparkline(a.equity.slice(-252), 360, 56, seriesColor(a.key));
      spark.setAttribute('preserveAspectRatio', 'none');
      spark.classList.add('acct-spark');
      spark.setAttribute('role', 'img');
      spark.removeAttribute('aria-hidden');
      spark.setAttribute('aria-label', a.label + ' equity, recent history');
      panel.appendChild(spark);
    }

    const tblWrap = el('div', 'acct-positions');
    const table = el('table', 'data-table data-table--compact');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const [name, type] of [['Symbol', 'text'], ['Mkt val', 'number'], ['Day %', 'number'], ['Unrl P&L', 'number']]) {
      const th = document.createElement('th');
      th.textContent = name; th.dataset.type = type;
      th.setAttribute('tabindex', '0'); th.setAttribute('aria-sort', 'none');
      th.setAttribute('scope', 'col');
      hr.appendChild(th);
    }
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const p of a.positions) {
      const tr = document.createElement('tr');
      const cells = [
        [p.sym + ' × ' + p.qty, p.sym, ''],
        [fmtUsd0(p.mkt), p.mkt, ''],
        [fmtPct(p.dayPct), p.dayPct, p.dayPct > 0 ? 'up' : p.dayPct < 0 ? 'down' : ''],
        [fmtSigned(p.unrl), p.unrl, p.unrl > 0 ? 'up' : p.unrl < 0 ? 'down' : ''],
      ];
      for (const [text, sort, cls] of cells) {
        const td = document.createElement('td');
        td.textContent = text; td.dataset.sort = sort;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tblWrap.appendChild(table);

    /* Positions COLLAPSE, closed by default (owner request 2026-08-07: cut the
       accounts area by ~70%). The table is 176px of a 513px card, the single
       largest block, so the cut is not reachable while it is always open.
       It is a disclosure rather than a deletion: holdings are the account's
       actual contents, and a layout change must not be the thing that puts
       them out of reach. `hidden` (not display:none in CSS) so the state is
       readable from the DOM, and the button owns `aria-expanded`. */
    const posOpenKey = 'acct_pos_' + a.key;
    let posOpen = false;
    try { posOpen = localStorage.getItem(posOpenKey) === '1'; } catch { /* private mode */ }
    const posBtn = el('button', 'acct-pos-toggle');
    posBtn.type = 'button';
    const paintPos = () => {
      posBtn.textContent = (posOpen ? 'Hide' : 'Show') + ' positions (' + a.positions.length + ')';
      posBtn.setAttribute('aria-expanded', posOpen ? 'true' : 'false');
      tblWrap.hidden = !posOpen;
    };
    posBtn.addEventListener('click', () => {
      posOpen = !posOpen;
      try { localStorage.setItem(posOpenKey, posOpen ? '1' : '0'); } catch { /* private mode */ }
      paintPos();
    });
    paintPos();
    panel.appendChild(posBtn);
    panel.appendChild(tblWrap);
    makeSortable(table);
    grid.appendChild(panel);
  }
}

/* ── news ──────────────────────────────────────────────────────────────── */
/* ── Watchlists (owner request 2026-07-29) ─────────────────────────────────
   Multiple named lists, unbounded symbols each; one tab per list. Rows come
   from desk-watchlist already grouped, so this only lays them out.
   The Last column shows the extended-hours price where one exists, and marks
   which session it came from — EXT for a pre/post print, CLOSE for an index,
   which has no extended session at all (owner ruling 2026-07-29). Change % is
   always measured from the prior close, so it keeps one meaning all day. */
/* no `active` index any more — every list renders as its own band, so there is
   no selected tab to track */
/* `range` records which timeframe the RENDERED payload actually covers. It is
   not the same thing as wlTf, which is what the owner has selected: between a
   click and its reply those two disagree, and drawing the old series under the
   new label is precisely the mislabelling to avoid (Codex review, PR #195). */
let wlState = { payload: null, lamp: null, range: null };

/* wl-prefixed: the desk already has a fmtVol for the strip tiles, which assumes
   a positive number and never renders an em dash. A watchlist cell must cope
   with a missing volume (indices report none), so it gets its own. */
const wlVol = v => {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return String(v);
};
const wlPx = v => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* One watchlist row as a strip tile: ticker, last, day-% pill — the same three
   facts the market strip shows, in the same components, so the two surfaces
   read as one system. Bid/ask/volume no longer have a column, so they move to
   the tile's tooltip rather than being dropped. */
/* One watchlist row as a tile (owner request 2026-07-29, revised same day):
     ticker
     price   ╱╲╱  ← today's movement, where the % pill used to sit
     +0.46%
   The sparkline replaced the pill's slot and the pill dropped beneath the
   price, which costs one text row. A third row cannot fit inside the owner's
   +10% budget on the 120×48 tile, so the padding and pill were tightened to
   land at 132×52 — +10% wide, +8% tall. */
/* 10% larger than the original 44×16 (owner request 2026-07-30, revised from 5%
   the same day — 5% came to ~2px and read as no change at all). The DISPLAYED
   size is the CSS rule on .wl-strip .wl-spark svg, which was bumped in step;
   these drive the viewBox, so the two have to move together or the line
   stretches. */
const WL_SPARK_W = 48, WL_SPARK_H = 18;

/* Reordering (owner request 2026-07-29). Only offered when unlocked, because
   the new order is written straight back through the PIN-gated RPC — a drag we
   could not persist would silently revert on the next poll.

   Order is moved on the list's `symbols` array, NOT on `rows`: rows hold only
   the symbols that quoted, so writing back from rows would delete every
   unresolved ticker the owner had saved. */
/* ── sorting (owner request 2026-07-29) ────────────────────────────────────
   A VIEW over the saved order, never a rewrite of it. "Saved" is the order the
   roster is stored in — set in the editor — so switching away to A–Z or Price
   and back returns to it exactly. Nothing here calls the write RPC.

   Sorting REPLACED drag-to-reorder (owner ruling, same day): with these keys
   available, arranging symbols by hand earned nothing and cost a great deal —
   a replace-all write per drag, serialization to stop two moves committing out
   of order, handlers that had to be torn down on lock, and focus restore that
   had to reconcile the saved-symbols index against the rendered-tile index.
   All of that is gone; the roster's order is now only ever set in the editor.

   The choice is a per-browser display preference, so it lives in localStorage
   rather than in the roster table: it is how one screen is being read, not
   what the desk's roster IS. */
/* ── watchlist chart timeframe (owner request 2026-07-30) ──────────────────
   Picks the window each tile's sparkline draws. Panel-wide rather than
   per-list: the bands are one surface, and a per-list setting would mean
   comparing two tiles whose lines silently cover different spans.

   The Change % pill is deliberately NOT retimed with it. That number is the
   prior-close move by owner ruling (2026-07-29) so it means the same thing all
   day and all evening; making it follow the chart would give "+0.46%" two
   different meanings depending on a control elsewhere in the header. The chart
   answers "what shape", the pill answers "what today did". */
const WL_TF_KEY = 'wl_tf_v1';
const WL_TFS = [
  ['1d', '1D'], ['1mo', '1M'], ['3mo', '3M'], ['6mo', '6M'],
  ['1y', '1Y'], ['2y', '2Y'], ['5y', '5Y'],
];
let wlTf = '1d';
try {
  const saved = localStorage.getItem(WL_TF_KEY);
  if (WL_TFS.some(t => t[0] === saved)) wlTf = saved;
} catch { /* private mode — default */ }
const saveWlTf = () => { try { localStorage.setItem(WL_TF_KEY, wlTf); } catch { /* private mode */ } };

function renderWlTf() {
  const host = document.getElementById('wlTf');
  if (!host) return;
  host.textContent = '';
  for (const [key, label] of WL_TFS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.tf = key;
    b.setAttribute('aria-pressed', String(wlTf === key));
    b.title = 'Tile charts show ' + (key === '1d' ? 'today' : 'the last ' + label.toLowerCase());
    b.addEventListener('click', () => {
      if (wlTf === key) return;
      wlTf = key;
      saveWlTf();
      renderWlTf();
      /* Each range is a separate fetch — the quotes are shared but the series
         is not — so switching reloads rather than redrawing what's in hand.
         Lamp goes to the fetching state so a slow 5Y sweep doesn't leave the
         previous window's line sitting under the new label unexplained. */
      loadWatchlist(false);
      const again = document.querySelector('#wlTf button[data-tf="' + key + '"]');
      if (again) again.focus();
    });
    host.appendChild(b);
  }
}

const WL_SORT_KEY = 'wl_sort_v1';
const WL_SORTS = [
  ['manual', 'Saved', 'the order your lists are saved in'],
  ['sym', 'A–Z', 'alphabetical by ticker'],
  ['price', 'Price', 'by last price'],
  ['pct', 'Change', 'by day change %'],
];
let wlSort = { key: 'manual', dir: 1 };
try {
  const raw = JSON.parse(localStorage.getItem(WL_SORT_KEY));
  if (raw && WL_SORTS.some(s => s[0] === raw.key)) wlSort = { key: raw.key, dir: raw.dir === -1 ? -1 : 1 };
} catch { /* default */ }
const saveWlSort = () => { try { localStorage.setItem(WL_SORT_KEY, JSON.stringify(wlSort)); } catch { /* private mode */ } };

/* Sorting returns a NEW array — the caller's list order is the saved one and
   must survive untouched. A row missing the sort field sinks to the bottom in
   BOTH directions rather than flipping to the top on a descending sort, which
   would read as "the most expensive thing I own has no price". */
function wlSortRows(rows) {
  if (wlSort.key === 'manual') return rows;
  const val = r => (wlSort.key === 'sym' ? r.sym : wlSort.key === 'price' ? r.last : r.pct);
  const missing = r => { const v = val(r); return v == null || (typeof v === 'number' && !Number.isFinite(v)); };
  return rows.slice().sort((a, b) => {
    const am = missing(a), bm = missing(b);
    if (am || bm) return am && bm ? 0 : (am ? 1 : -1);
    const av = val(a), bv = val(b);
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return c * wlSort.dir;
  });
}

function renderWlSort() {
  const host = document.getElementById('wlSort');
  if (!host) return;
  host.textContent = '';
  for (const [key, label, why] of WL_SORTS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.key = key;
    const on = wlSort.key === key;
    b.setAttribute('aria-pressed', String(on));
    /* the active key doubles as the direction toggle — clicking it again flips */
    b.title = on && key !== 'manual'
      ? (wlSort.dir === 1 ? 'Ascending — click to reverse' : 'Descending — click to reverse')
      : 'Sort ' + why;
    if (on && key !== 'manual') b.appendChild(el('span', 'wl-dir', wlSort.dir === 1 ? '↑' : '↓'));
    b.addEventListener('click', () => {
      if (wlSort.key === key && key !== 'manual') wlSort.dir = -wlSort.dir;
      else wlSort = { key, dir: 1 };
      saveWlSort();
      renderWatchlist();
      /* Re-render REPLACES these buttons, so the one just activated leaves the
         DOM and focus falls back to <body> — a keyboard user could not press
         Enter again to reverse the same sort without tabbing the whole page
         (Codex review, PR #191). Put focus on its replacement. */
      const again = document.querySelector('#wlSort button[data-key="' + key + '"]');
      if (again) again.focus();
    });
    host.appendChild(b);
  }
}

/* `pending` = the payload in hand covers a DIFFERENT window than the one now
   selected (a switch is in flight, or the backend refused the range). Only the
   sparkline is timeframe-specific — the price and Change % are true at any
   span — so the line alone is withheld rather than blanking the whole panel. */
function wlTile(r, pending) {
  const tile = el('div', 'mkt-tile wl-tile');
  const name = el('span', 'mkt-name', r.sym);
  /* Length-driven, not global (owner ruling 2026-07-31, half-width tiles). CSS
     cannot branch on text length, and at 66px a 9-character price like
     "23,104.88" overflows its box at the base size — a CLIPPED PRICE IS A WRONG
     PRICE, which is the one thing this desk must never render. Widening the tile
     does not fix it (measured: 23,104.88 / 44,912.30 / 64,216.00 still clip at
     76px); the base font size is the constraint, so long values step down one
     size and everything else is untouched. */
  if (r.sym && r.sym.length > 5) name.classList.add('is-long');
  /* CLOSE means "this session has ended", not "this is an index": during
     regular hours ^VIX carries a live, moving price, and stamping that CLOSE
     would misstate an intraday quote as a settled one. Indices have no extended
     session, so once the bell rings their value genuinely IS the close. */
  const mark = r.index ? (marketSessionOpen() ? '' : 'CLOSE') : (r.ext ? 'EXT' : '');
  if (mark) name.appendChild(el('span', 'wl-mark', mark));
  tile.appendChild(name);

  const row = el('div', 'mkt-vals wl-vals');
  const px = wlPx(r.last);
  const last = el('span', 'mkt-last', px);
  if (px && px.length > 7) last.classList.add('is-long'); /* see the note above */
  if (px && px.length > 8) last.classList.add('is-xlong');
  row.appendChild(last);
  /* The line is coloured by the DAY's direction so it agrees with the pill
     below it; a green line over a red pill would be two answers to one
     question. Gain/loss colour on a price path is P&L, not decoration. */
  if (!pending && Array.isArray(r.spark) && r.spark.length >= 2) {
    const wrap = el('span', 'wl-spark');
    wrap.appendChild(sparkline(r.spark, WL_SPARK_W, WL_SPARK_H,
      (r.pct ?? 0) >= 0 ? 'var(--color-gain)' : 'var(--color-loss)'));
    row.appendChild(wrap);
  }
  tile.appendChild(row);

  if (r.pct != null) {
    tile.appendChild(el('span', (r.pct >= 0 ? 'pill pill--gain' : 'pill pill--loss') + ' wl-pct', fmtPct(r.pct)));
  }

  /* Bid/ask/volume/name lost their columns in the tile layout. They stay
     reachable rather than dropped: `title` for a mouse, and an aria-label on a
     focusable tile so keyboard and screen-reader users get the same facts
     (Codex review, PR #189 — a title on a non-focusable div is mouse-only). */
  const detail = [
    r.name || null,
    r.bid != null || r.ask != null ? 'Bid ' + wlPx(r.bid) + ', ask ' + wlPx(r.ask) : null,
    r.vol ? 'Volume ' + wlVol(r.vol) : null,
  ].filter(Boolean).join(' — ');
  if (detail) {
    tile.title = detail;
    tile.setAttribute('aria-label', r.sym + ' ' + wlPx(r.last) +
      (r.pct != null ? ' ' + fmtPct(r.pct) : '') + ' — ' + detail);
  }
  /* Still focusable: the aria-label above carries bid/ask/volume, and a
     screen-reader or keyboard user needs to be able to land on the tile to
     hear it — that was never about dragging. */
  tile.tabIndex = 0;
  tile.dataset.sym = r.sym;
  return tile;
}

/* ── drag to arrange (owner request 2026-07-31) ─────────────────────────────
   Built on POINTER events, not the HTML5 drag-and-drop API: mobile browsers
   never fire dragstart, so an HTML5 implementation would work on a desktop and
   be silently dead on the owner's phone — the same trap as the double-tap zoom
   that `touch-action: manipulation` exists to dodge.

   The saved order was already the display order: `symbols` is an ordered text[]
   and wlSortRows() returns rows untouched under Manual. So this adds no storage
   and no migration — it only gives the owner a way to SET what the desk could
   already hold. */
/* Movement past this many px is a drag; anything less stays a click, which is
   what keeps the double-click removal working unchanged. */
const WL_DRAG_SLOP = 6;
/* Touch has no hover state to telegraph a pick-up, and a tile that grabbed the
   gesture immediately would make the panel unscrollable. So a finger must rest
   before the drag arms; a mouse drags at once. This is a hold to PICK UP, not
   the hold-to-delete the owner rejected — the confirm-free destructive gesture
   is what they objected to, and removal still goes through a dialog. */
const WL_TOUCH_ARM_MS = 300;

const wlDrag = { on: false, armed: 0, sym: null, from: null, ghost: null, tile: null, marker: null };

/* Transient feedback for a drag that could not be committed. The staging row
   that used to carry this is gone (owner ruling 2026-07-31), so it borrows the
   panel's own sort note — the only always-present line in the header area. */
function wlNote(msg) {
  const hint = document.getElementById('wlNote');
  if (!hint) return;
  hint.textContent = msg;
  hint.hidden = false;
  clearTimeout(wlNote.t);
  wlNote.t = setTimeout(() => { hint.textContent = ''; hint.hidden = true; }, 4000);
}

/* A hand-made order can only survive under Manual — any other key re-sorts on
   the next repaint and the arrangement is gone. Rather than disable dragging
   under a sort (a dead control reads as a bug), the first drag SNAPS the sort
   to Manual and says so. The gesture is spent on the switch because the tiles
   are about to be redrawn in a different order underneath the finger. */
function wlEnsureManual() {
  if (wlSort.key === 'manual') return true;
  wlSort = { key: 'manual', dir: 1 };
  saveWlSort();
  renderWatchlist();
  wlNote('Switched to Manual so your order can stick — drag again');
  return false;
}

const wlDropZones = () => [...document.querySelectorAll('.mkt-group-tiles[data-band], #wlTrash')];

/* Which slot the pointer is over, in reading order: a tile counts as "already
   passed" when the pointer is below its row, or on its row and past its middle.
   Tiles wrap, so an x-only comparison would put a drop on row 3 at the end of
   row 1. */
function wlDropIndex(zone, x, y) {
  const tiles = [...zone.querySelectorAll('.wl-tile')].filter(t => t !== wlDrag.tile);
  let i = 0;
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (y > r.bottom || (y >= r.top && x > r.left + r.width / 2)) i++;
    else break;
  }
  return i;
}

function wlClearMarker() {
  if (wlDrag.marker) wlDrag.marker.remove();
  wlDrag.marker = null;
  for (const z of wlDropZones()) z.classList.remove('wl-drop-over');
}

function wlDragMove(ev) {
  if (!wlDrag.on) return;
  wlDrag.ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
  wlClearMarker();
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const zone = under && under.closest('.mkt-group-tiles[data-band], #wlTrash');
  if (!zone) return;
  zone.classList.add('wl-drop-over');
  if (zone.id === 'wlTrash') return;
  const at = wlDropIndex(zone, ev.clientX, ev.clientY);
  const mark = el('div', 'wl-drop-marker');
  const tiles = [...zone.querySelectorAll('.wl-tile')].filter(t => t !== wlDrag.tile);
  zone.insertBefore(mark, tiles[at] || null);
  wlDrag.marker = mark;
}

function wlDragEnd(ev, cancelled) {
  const d = wlDrag;
  clearTimeout(d.armed);
  if (!d.on) { d.sym = null; d.tile = null; return; }
  /* A drop still delivers a `click` to the tile it started from. Without this
     stamp, arranging the panel would open a detail window on every drop. */
  wlDragClickAt = Date.now();
  const under = cancelled ? null : document.elementFromPoint(ev.clientX, ev.clientY);
  const zone = under && under.closest('.mkt-group-tiles[data-band], #wlTrash');
  const at = zone && zone.id !== 'wlTrash' ? wlDropIndex(zone, ev.clientX, ev.clientY) : 0;
  wlClearMarker();
  if (d.ghost) d.ghost.remove();
  if (d.tile) d.tile.classList.remove('wl-dragging');
  document.body.classList.remove('wl-drag-active');
  d.on = false;
  const from = d.from, sym = d.sym;
  d.ghost = null; d.tile = null; d.from = null; d.sym = null;
  wlSyncWriteControls();
  if (!zone || cancelled) return;
  const to = zone.id === 'wlTrash' ? { band: 'trash' }
    : { band: Number(zone.dataset.band), title: zone.dataset.title, idx: at };
  wlCommitMove(from, to, sym);
}

function wlDragStart(ev, tile, from, sym) {
  const d = wlDrag;
  d.on = true; d.tile = tile; d.from = from; d.sym = sym;
  tile.classList.add('wl-dragging');
  document.body.classList.add('wl-drag-active');
  /* Reveal the staging row for the duration of the drag. It is hidden while
     empty now that it no longer carries the + and 🗑 (owner ruling
     2026-07-31), and a hidden drop zone is not a drop zone — without this the
     first tile could never be staged. */
  wlSyncWriteControls();
  const ghost = tile.cloneNode(true);
  ghost.className = 'mkt-tile wl-tile wl-ghost';
  ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
  document.body.appendChild(ghost);
  d.ghost = ghost;
}

/* One move = one atomic replace-all through wlMutate, never a patch of the
   rendered payload (the desk_009 / PR #188 hazard). A cross-band move touches
   TWO lists, which is precisely why it has to be one write. */
/* ARRANGEMENT LOCK (owner request 2026-07-31). Freezes POSITION, not content:
   row order, tile order within a row, and tile moves between rows. Adding and
   removing stay available — the owner is protecting a layout they tuned, not
   freezing the roster.
   The trash is deliberately still live: dragging a tile to 🗑 is a removal, not
   a rearrangement, and removal is explicitly allowed. */
const WL_LOCK_KEY = 'wl_locked_v1';
let wlLocked = false;
try { wlLocked = localStorage.getItem(WL_LOCK_KEY) === '1'; } catch { /* private mode */ }
const saveWlLock = () => {
  try { localStorage.setItem(WL_LOCK_KEY, wlLocked ? '1' : '0'); } catch { /* private mode */ }
};

/* Move a whole list one place. Splices inside wlMutate's callback, so the read
   and the write are ONE atomic replace-all against the authoritative roster —
   never a patch of the rendered payload, which omits unresolved symbols and can
   be an hour stale (the desk_009 / PR #188 hazard). Matched by TITLE as well as
   index so a roster that shifted under us aborts instead of moving the wrong
   row. */
async function wlMoveBand(idx, delta) {
  if (wlLocked) { wlNote('Arrangement is locked'); return; }
  const cur = (wlState.payload && wlState.payload.lists) || [];
  const title = cur[idx] && cur[idx].title;
  if (title == null) return;
  const res = await wlMutate(lists => {
    const at = lists.findIndex(l => l.title === title);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= lists.length) return false;
    const [moved] = lists.splice(at, 1);
    lists.splice(to, 0, moved);
    return true;
  });
  if (!res.ok && res.err) wlNote(res.err);
}

async function wlCommitMove(from, to, sym) {
  if (!from || !sym) return;
  /* Enforced HERE, at the write boundary, not only on the controls. Every
     rearrangement — band reorder, in-band reorder, cross-band move — funnels
     through this one function, so one check covers all three however the move
     was started. Disabling buttons alone would leave the drag path open. Same
     lesson as the scheduled-ask floor, which only held once it moved out of the
     input handler and into the save. */
  if (wlLocked && to.band !== 'trash') { wlNote('Arrangement is locked'); return; }
  if (from.band === to.band && to.band !== 'trash' && from.idx === to.idx) return;   /* dropped where it started */

  const res = await wlMutate(lists => {
    const src = wlPick(lists, from.band, from.title);
    if (!src) return false;
    const dst = to.band === 'trash' ? null : wlPick(lists, to.band, to.title);
    if (to.band !== 'trash' && !dst) return false;

    if (src) {
      const at = src.symbols.indexOf(sym);
      if (at < 0) return false;                 /* moved out from under us */
      src.symbols.splice(at, 1);
    }
    if (dst) {
      /* Same list: the removal above shifted everything after it left, so a
         drop past the old slot lands one place too far without this. */
      let idx = to.idx;
      if (src === dst && from.idx < to.idx) idx -= 1;
      dst.symbols.splice(Math.max(0, Math.min(idx, dst.symbols.length)), 0, sym);
    }
    return true;
  });
  if (!res.ok && res.err) wlNote(res.err);
}

/* Pointer wiring. Kept off the tile's own click/dblclick handlers entirely:
   a drag only begins after WL_DRAG_SLOP of movement (or a rested finger), so
   the double-click removal path is untouched. */
function wlWireDrag(tile, from, sym) {
  tile.addEventListener('pointerdown', ev => {
    if (ev.button != null && ev.button !== 0) return;
    if (wlDrag.on) return;
    const startX = ev.clientX, startY = ev.clientY;
    wlDrag.sym = sym; wlDrag.from = from; wlDrag.tile = tile;
    const touch = ev.pointerType === 'touch';
    /* Arming on touch flips the tile to touch-action:none so the browser stops
       treating the gesture as a scroll — but only once the finger has rested,
       so an ordinary swipe over the panel still scrolls the page. */
    if (touch) wlDrag.armed = setTimeout(() => { tile.classList.add('wl-armed'); }, WL_TOUCH_ARM_MS);
    const move = e => {
      if (wlDrag.on) { wlDragMove(e); return; }
      const far = Math.hypot(e.clientX - startX, e.clientY - startY) > WL_DRAG_SLOP;
      if (!far) return;
      if (touch && !tile.classList.contains('wl-armed')) { clearTimeout(wlDrag.armed); cleanup(); return; }
      /* Snap to Manual BEFORE capturing: the snap re-renders the panel, which
         detaches this tile, and setPointerCapture on a detached node throws
         InvalidStateError. The gesture is spent either way. */
      if (!wlEnsureManual()) { cleanup(); return; }
      /* Best-effort: the drag is driven by window listeners, so a refused
         capture (pointer already released, node replaced) costs nothing. */
      try { tile.setPointerCapture(ev.pointerId); } catch { /* not fatal */ }
      wlDragStart(e, tile, from, sym);
      if (wlDrag.on) wlDragMove(e);
    };
    const up = e => { wlDragEnd(e, false); cleanup(); };
    const cancel = e => { wlDragEnd(e, true); cleanup(); };
    const key = e => { if (e.key === 'Escape') { wlDragEnd(e, true); cleanup(); } };
    function cleanup() {
      clearTimeout(wlDrag.armed);
      tile.classList.remove('wl-armed');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key);
  });

  /* Keyboard parity. A drag is pointer-only, and this desk has a keyboard path
     for every mouse gesture — Alt+←/→ moves within the band, Alt+↑/↓ moves to
     the band above or below. Removal already has one (Delete opens the dialog). */
  tile.addEventListener('keydown', ev => {
    if (!ev.altKey) return;
    const d = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
    const band = { ArrowUp: -1, ArrowDown: 1 }[ev.key];
    if (d == null && band == null) return;
    ev.preventDefault();
    if (!wlEnsureManual()) return;
    if (d != null) wlCommitMove(from, { ...from, idx: from.idx + (d > 0 ? 2 : -1) }, sym);
    else {
      const lists = (wlState.payload && wlState.payload.lists) || [];
      const t = from.band + band;
      if (t < 0 || t >= lists.length) return;
      wlCommitMove(from, { band: t, title: lists[t].title, idx: (lists[t].rows || []).length }, sym);
    }
  });
}

/* Show the write controls only when there is somewhere to write. They live in
   the panel header now, so nothing else gates them: `#wlTray` used to, and when
   the + and the trash moved out of it they rendered in demo against a roster
   that cannot be written — caught by S21. Both the `hidden` attribute AND a
   `[hidden] { display: none }` rule are needed, because a class selector
   setting `display` outranks the UA's default. */
function wlSyncWriteControls() {
  const canEdit = wlCanEdit();
  const lock = document.getElementById('wlLock');
  if (lock) {
    lock.hidden = !canEdit;
    lock.textContent = wlLocked ? '🔒' : '🔓';
    lock.setAttribute('aria-pressed', wlLocked ? 'true' : 'false');
    lock.title = wlLocked ? 'Arrangement locked — click to unlock' : 'Lock the arrangement';
    if (!lock.dataset.wired) {
      lock.dataset.wired = '1';
      lock.addEventListener('click', () => {
        wlLocked = !wlLocked;
        saveWlLock();
        wlSyncWriteControls();
        renderWatchlist();   /* redraw so the ↑/↓ pick up their disabled state */
      });
    }
  }
  for (const id of ['wlTrayAdd', 'wlTrash', 'wlNewListBtn']) {
    const el = document.getElementById(id);
    if (el) el.hidden = !canEdit;
  }
}

function renderWatchlist(payload, lamp) {
  const lampEl = document.getElementById('wlLamp');
  const stripEl = document.getElementById('wlStrip');
  const emptyEl = document.getElementById('wlEmpty');
  const editBtn = document.getElementById('wlEditBtn');
  if (!lampEl || !stripEl) return;

  if (payload) {
    wlState.payload = payload;
    /* Demo builds for whatever is selected; live echoes what it drew. */
    wlState.range = payload.range || (DESK.mode === 'demo' ? wlTf : null);
  }
  if (lamp) wlState.lamp = lamp;
  const data = wlState.payload;
  const lp = wlState.lamp || { cls: 'lamp--stale', text: 'Stale' };
  lampEl.className = 'lamp ' + lp.cls;
  lampEl.textContent = lp.text;
  const stampEl = document.getElementById('wlStamp');
  if (stampEl) {
    if (DESK.mode === 'demo') stampEl.textContent = 'Demo data';
    else applyLampStamp(stampEl, lp);
  }
  renderWlSort();   /* reflects the active key + direction on every render */
  renderWlTf();     /* and the active chart timeframe */

  const lists = (data && data.lists) || [];
  /* Withhold the lines whenever what we hold isn't the window now selected. */
  const pending = !!data && wlState.range !== wlTf;
  /* ONE predicate behind every write control — the ✎, the per-band +, and the
     double-click removal. They were split across two conditions, and only the
     first two followed the owner's ruling, so list create/rename/reorder/delete
     still demanded an unlock (Codex review, PR #202). */
  const canEdit = wlCanEdit();
  if (editBtn) editBtn.hidden = !canEdit;

  /* One labelled band per list, in the market strip's idiom (owner request
     2026-07-29). Every list is on screen at once — the bands ARE the
     navigation, so there are no tabs to click through. */
  stripEl.textContent = '';
  let total = 0;
  lists.forEach((l, li) => {
    const rows = l.rows || [];
    total += rows.length;
    const group = el('div', 'mkt-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', l.title);
    /* The list name and its + share the gutter, so they stay together when the
       band stacks on a narrow screen instead of the button drifting to the
       tiles' row. */
    /* The per-band + is gone (owner request 2026-07-31): one + in the panel
       header mints a tile into the tray, and it is dragged to whichever band it
       belongs in. Fifteen bands meant fifteen buttons doing the same job. */
    const head = el('div', 'wl-band-head');
    head.appendChild(el('span', 'mkt-group-label', l.title));
    /* ↑/↓ move the WHOLE list (owner request 2026-07-31). Buttons rather than a
       row drag: tile drag already owns the pointer inside a band, so a row drag
       would have to disambiguate "move this tile" from "move this list", and
       the tile gesture is the one used constantly. Arrows also work on touch
       with no arm-and-hold delay.
       DISABLED at the ends and when locked, never hidden — a control that
       vanishes reads as a bug, one that greys out reads as unavailable. */
    if (wlCanEdit()) {
      const mk = (glyph, delta, off) => {
        const b = el('button', 'wl-move', glyph);
        b.type = 'button';
        b.setAttribute('aria-label', (delta < 0 ? 'Move ' : 'Move ') + l.title + (delta < 0 ? ' up' : ' down'));
        b.disabled = off || wlLocked;
        b.addEventListener('click', () => wlMoveBand(li, delta));
        return b;
      };
      head.appendChild(mk('↑', -1, li === 0));
      head.appendChild(mk('↓', 1, li === lists.length - 1));
      /* Delete the WHOLE list (owner request 2026-08-01), GATED ON THE LOCK
         (owner ruling the same day, revising the first cut). The lock had been
         read as position-only — "adding and removing stay available" — and
         delete was left ungated behind its confirm dialog. The owner's ruling
         draws the line differently, and by the more defensible reading: losing
         a whole list is not the same kind of act as removing one tile, so the
         lock now covers it. Adding a list stays available; only destruction is
         behind the lock.
         DISABLED rather than hidden, like the ↑/↓ beside it — a control that
         vanishes reads as a bug, one that greys out reads as unavailable. */
      const del = el('button', 'wl-del', '×');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete the list ' + l.title);
      del.disabled = wlLocked;
      del.title = wlLocked
        ? 'Unlock the arrangement to delete “' + l.title + '”'
        : 'Delete “' + l.title + '”';
      del.addEventListener('click', () => openWlDelList(li, l.title, del));
      head.appendChild(del);
    }
    group.appendChild(head);
    const box = el('div', 'mkt-group-tiles');
    /* Drop target identity. The title rides along so wlPick() can still refuse
       a write when the roster moved under us — position alone was the PR #196
       bug, and a drop is just another read-modify-write. */
    if (canEdit) {
      box.dataset.band = String(li);
      box.dataset.title = l.title;
    }
    /* Sorting only changes the DRAW order. `rows` arrives in the saved order,
       so Manual needs no work and switching back to it is just this loop
       without a comparator. */
    /* Under Manual the draw order IS the saved order, so a tile's position in
       this loop is its index in `symbols` — which is what makes a drop
       addressable. Under any other key it is not, which is why a drag snaps the
       sort to Manual before it will move anything. */
    /* An empty list would otherwise draw as a bare label over a zero-height
       box — it reads as a rendering fault rather than as a list with nothing
       in it yet, and it gives a drag no target to aim at. The hint reserves a
       tile's worth of height and says what the band is for. */
    /* SAVED symbols, not drawn rows, decide what this says. A list whose every
       ticker is a typo (or past the fetch cap) keeps them in `symbols` and has
       no `rows` at all — calling that "Empty" would contradict the missing-
       symbol warning directly below, which is naming the very tickers it holds.
       And the drag invitation is only offered when a drag would actually be
       accepted: wlCommitMove refuses every non-trash move while the
       arrangement is locked, so under a lock this stays plain (Codex review). */
    if (!rows.length) {
      const saved = (l.symbols || []).length;
      box.appendChild(el('span', 'wl-band-empty',
        saved ? 'No quotes for its ' + saved + ' symbol' + (saved === 1 ? '' : 's')
          : (canEdit && !wlLocked ? 'Empty — drag a tile here' : 'Empty')));
    }
    wlSortRows(rows).forEach((r, ri) => {
      const tile = wlTile(r, pending);
      if (canEdit) {
        wlWireRemove(tile, r.sym, li, l.title);
        wlWireDrag(tile, { band: li, title: l.title, idx: ri }, r.sym);
      }
      /* Outside the canEdit gate on purpose: opening a detail window READS a
         symbol, so it is not an edit and must not depend on one being possible.
         canEdit is passed only to decide whether the open waits for a possible
         double-click — see wlWireOpen. */
      wlWireOpen(tile, r.sym, canEdit);
      box.appendChild(tile);
    });
    group.appendChild(box);
    stripEl.appendChild(group);
  });
  if (emptyEl) emptyEl.hidden = total > 0;
  wlSyncWriteControls();

  /* Unknown tickers, named. A pasted broker table split on whitespace can turn
     "BRK B" into BRK + B — both look like real symbols, so the only honest
     signal the owner gets is which ones the feed couldn't resolve. */
  const missEl = document.getElementById('wlMissing');
  if (missEl) {
    const miss = (data && data.missing) || [];
    missEl.textContent = miss.length
      ? (miss.length === 1 ? 'No quote found for ' : 'No quotes found for ') + miss.join(', ') + ' — check the spelling in Edit.'
      : '';
    missEl.hidden = !miss.length;
  }
}

/* ── watchlist editor ──────────────────────────────────────────────────────
   Reads the roster through desk_get_watchlists (PIN-gated, so the editor shows
   the owner's authoritative lists rather than whatever the quote feed last
   cached) and writes the COMPLETE desired state back through
   desk_set_watchlists — one atomic replace-all covering add/remove symbol and
   create/rename/reorder/delete list.

   Symbols are edited as free text on purpose: the owner's source is a pasted
   broker table, so any of comma / space / newline has to work. Normalisation
   happens here for the preview count and again server-side, where the RPC is
   the real authority on what a ticker may look like. */
let wlEdit = null;        /* [{title, symbols:[…]}] while the modal is open */
let wlEditLoaded = false; /* did the authoritative read succeed? gates saving */
/* The roster version this draft was loaded from (desk_014). The editor is the
   one write path where the read and the write are separated by however long the
   modal stays open, so a save is only allowed to land on the roster the draft
   was built from — otherwise anything created meanwhile is deleted by the
   replace-all, which is precisely how the Radar list vanished. */
let wlEditVersion = null;

/* Split ONLY on the documented delimiters — comma and whitespace — then keep
   whole tokens that are valid tickers (Codex review, PR #188). Splitting on
   "any invalid character" instead would shatter `BAD!!SYM` into BAD + SYM, two
   real-looking symbols that could quietly resolve to unrelated securities.
   Preserving the token means it simply fails validation and is dropped, which
   is what the editor's promise actually says happens. */
const WL_SYM_RE = /^[A-Z0-9.^=-]{1,10}$/;
const wlParseSyms = txt => [...new Set(
  String(txt || '').toUpperCase().split(/[,\s]+/).filter(t => WL_SYM_RE.test(t))
)];

/* ── per-list add / hold-to-remove (owner request 2026-07-30) ───────────────
   Quick edits without opening the full editor: a + in each band's gutter adds
   symbols to THAT list, and a brief hold on a tile asks before removing
   it. Both write the same way the editor does, and both are offered only when
   the desk is live AND unlocked — the roster lives behind the PIN RPCs, so
   there is nothing to write to otherwise. */
/* NOT gated on DESK.authed (owner ruling 2026-07-30, stated twice: the
   watchlist is not to depend on unlocking). Still excludes demo, where the
   roster is a committed bootstrap file with no backend to write to — offering
   an edit there would be a control that cannot work. */
const wlCanEdit = () => DESK.mode !== 'demo';

/* Every quick edit is a READ-MODIFY-WRITE against the authoritative RPC, never
   a patch of what the panel happens to be showing. Two reasons, both already
   paid for once in this panel's history:
     - desk_set_watchlists is a REPLACE-ALL, so writing from a failed or absent
       read would delete real lists (the PR #188 hazard).
     - the quote feed is cached up to an hour when the market is shut, so a
       roster edited on another device would be silently rolled back by an add
       built from that stale payload.
   `mutate` returns false to mean "nothing to do", which skips the write. */
/* One quick edit at a time (Codex review, PR #196). Both dialogs are
   read-modify-write against a replace-all, so two overlapping runs read the
   same roster and the second write silently discards the first one's addition.
   The button's disabled attribute alone did not cover this — Enter in the
   input, or closing and reopening the dialog for another list, reached the
   submit path while a request was still in flight. */
let wlBusy = false;

/* Resolve the band the owner acted on inside the AUTHORITATIVE roster.
   Targeting by title alone was wrong (Codex review, PR #196): the editor
   permits duplicate titles and hands out "New list" by default, so `find` on
   the title could mutate the first band while the dialog named the second.

   Position is a sound key here because both sides order identically — the edge
   function reads `order=pos.asc,id.asc` and desk_get_watchlists aggregates
   `order by w.pos, w.id` (desk_010). The title is then checked against that
   position as a guard: if they disagree the roster moved under us, and refusing
   is the only safe answer. Falls back to a title match only when it is
   UNAMBIGUOUS, which covers an ordering surprise without reintroducing the bug. */
/* The landing list for the panel-level + (owner ruling 2026-07-31). Matched and
   CREATED by name, so the owner never has to seed it by hand and a rename in the
   editor simply means the next + makes a fresh one. */
const WL_RADAR = 'Radar';

function wlPick(lists, idx, title) {
  /* idx === null is the Radar path: find it by name, or mint it. Done inside
     wlMutate's callback, so the create and the add are ONE atomic replace-all
     — never a create followed by a second write that could half-land. */
  if (idx === null) {
    const found = lists.find(l => (l.title || '').trim().toLowerCase() === WL_RADAR.toLowerCase());
    if (found) return found;
    const made = { title: WL_RADAR, symbols: [] };
    lists.push(made);
    return made;
  }
  const at = lists[idx];
  if (at && at.title === title) return at;
  const named = lists.filter(l => l.title === title);
  return named.length === 1 ? named[0] : null;
}

async function wlMutate(mutate) {
  /* No PIN needed — the watchlist RPCs are open (desk_011). Still a
     read-modify-write against the AUTHORITATIVE roster, never a patch of the
     rendered payload: that omits unresolved symbols and can be an hour stale. */
  const pin = null;
  let lists, version;
  try {
    const got = await deskGetWatchlists(pin);
    if (!got || !got.ok) return { ok: false, err: 'Could not load your watchlists — unlock again.' };
    lists = (got.lists || []).map(l => ({ title: l.title, symbols: (l.symbols || []).slice() }));
    version = got.version ?? null;
  } catch {
    return { ok: false, err: 'Could not reach the desk.' };
  }
  if (!mutate(lists)) return { ok: false, err: null };   /* no-op, not a failure */
  try {
    /* The version read a moment ago rides along, so the replace-all can only
       land on the roster it was computed from (desk_014). A conflict is
       near-impossible here — the read and the write are milliseconds apart —
       but it costs nothing and this is the ONE write path that must never lose
       an edit made elsewhere. */
    const out = await deskSetWatchlists(pin, lists.filter(l => String(l.title || '').trim()), version);
    if (!out || !out.ok) {
      if (out && out.error === 'conflict') {
        /* Repaint from the truth before telling the owner to retry, or the
           next attempt is built from the same stale render that just lost. */
        await loadWatchlist(true);
        return { ok: false, err: 'Your watchlists changed elsewhere — the panel has been refreshed. Try that again.' };
      }
      return { ok: false, err: 'The desk rejected the change.' };
    }
  } catch {
    return { ok: false, err: 'Could not reach the desk to save.' };
  }
  /* force: past the feed cache AND every timeframe's slot, since the roster
     just changed for all of them */
  await loadWatchlist(true);
  return { ok: true, err: null };
}

/* ── quick add ─────────────────────────────────────────────────────────── */
let wlQuickList = null;   /* {idx, title} — which band's + was pressed */
let wlReturnFocus = null; /* the + or tile that opened a dialog, to restore to */

/* Both quick dialogs hand focus back to whatever opened them (Codex review,
   PR #196), the way the full editor already does. Without it a keyboard user who
   pressed Delete on a tile and then chose "Keep it" is dropped on <body> and has
   to tab the whole page to get back to where they were. */
function wlRestoreFocus() {
  const el = wlReturnFocus;
  wlReturnFocus = null;
  /* the panel may have re-rendered under us, which replaces the node */
  if (el && el.isConnected && typeof el.focus === 'function') el.focus();
}

function wlQuickErr(msg) {
  const p = document.getElementById('wlQuickErr');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
}

function openWlQuickAdd(idx, title, invoker) {
  if (!wlCanEdit() || wlBusy) return;
  wlQuickList = { idx, title };
  wlReturnFocus = invoker || null;
  const back = document.getElementById('wlQuickBackdrop');
  const head = document.getElementById('wlQuickTitle');
  const input = document.getElementById('wlQuickInput');
  if (!back || !input) return;
  /* The panel-level + always targets RADAR (owner ruling 2026-07-31). It briefly
     offered a destination dropdown; the owner replaced that with a fixed
     landing list — "just automatically add any new stock via the plus sign to
     the radar watch list". One question fewer between seeing a ticker and
     keeping it, which is the whole point of a quick add. Moving it elsewhere is
     a drag, which already exists. */
  if (head) head.textContent = 'Add to ' + (title || WL_RADAR);
  input.value = '';
  input.disabled = false;
  wlQuickErr('');
  back.hidden = false;
  input.focus();
}

function closeWlQuickAdd() {
  if (wlBusy) return;   /* don't abandon a write mid-flight */
  const back = document.getElementById('wlQuickBackdrop');
  if (back) back.hidden = true;
  wlQuickList = null;
  wlRestoreFocus();
}

async function submitWlQuickAdd() {
  const input = document.getElementById('wlQuickInput');
  const btn = document.getElementById('wlQuickSaveBtn');
  if (!input || !wlQuickList || wlBusy) return;
  /* Same parse the editor uses, so "BRK.B, SPY" and a pasted broker column
     behave identically here (and the RPC re-validates regardless). */
  const syms = wlParseSyms(input.value);
  if (!syms.length) { wlQuickErr('No usable ticker in that — letters, digits, . ^ = - only.'); return; }
  /* Opened from a band → that band. Opened from the panel + → RADAR, by name
     rather than by index: indexes shift when lists are reordered, and this
     lookup happens inside the authoritative read below, so a rename or a
     reorder between opening the dialog and saving cannot land the symbols in
     the wrong list. */
  const { idx, title } = wlQuickList.idx == null ? { idx: null, title: WL_RADAR } : wlQuickList;
  wlBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  input.disabled = true;   /* the Enter path has to be shut too, not just the button */
  let already = [], found = true;
  const res = await wlMutate(lists => {
    const l = wlPick(lists, idx, title);
    if (!l) { found = false; return false; }
    const have = new Set(l.symbols);
    already = syms.filter(s => have.has(s));
    const fresh = syms.filter(s => !have.has(s));
    if (!fresh.length) return false;
    l.symbols.push(...fresh);
    return true;
  });
  wlBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  input.disabled = false;
  if (res.ok) { closeWlQuickAdd(); return; }
  input.focus();
  /* A pure duplicate is not an error worth a scary message, but it must not
     look like a successful add either. */
  wlQuickErr(res.err || (!found
    ? 'That list moved or was renamed — reload and try again.'
    : already.length === 1 ? already[0] + ' is already in ' + title + '.'
    : 'Already in ' + title + '.'));
}

/* ── double-click to remove ────────────────────────────────────────────── */
let wlRmTarget = null;            /* {sym, idx, title} awaiting confirmation */

function wlRmErr(msg) {
  const p = document.getElementById('wlRmErr');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
}

function openWlRemove(sym, idx, title, invoker) {
  if (!wlCanEdit() || wlBusy) return;
  wlRmTarget = { sym, idx, title };
  wlReturnFocus = invoker || null;
  const back = document.getElementById('wlRmBackdrop');
  const text = document.getElementById('wlRmText');
  if (!back) return;
  if (text) text.textContent = 'Remove ' + sym + ' from “' + title + '”?';
  wlRmErr('');
  back.hidden = false;
  const cancel = document.getElementById('wlRmCancelBtn');
  if (cancel) cancel.focus();   /* destructive dialog opens on the safe choice */
}

function closeWlRemove() {
  if (wlBusy) return;
  const back = document.getElementById('wlRmBackdrop');
  if (back) back.hidden = true;
  wlRmTarget = null;
  wlRestoreFocus();
}

async function confirmWlRemove() {
  if (!wlRmTarget || wlBusy) return;
  const { sym, idx, title } = wlRmTarget;
  const btn = document.getElementById('wlRmConfirmBtn');
  wlBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
  let found = true;
  const res = await wlMutate(lists => {
    const l = wlPick(lists, idx, title);
    if (!l) { found = false; return false; }
    const i = l.symbols.indexOf(sym);
    if (i < 0) return false;
    l.symbols.splice(i, 1);
    return true;
  });
  wlBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Remove'; }
  if (res.ok) { closeWlRemove(); return; }
  wlRmErr(res.err || (!found
    ? 'That list moved or was renamed — reload and try again.'
    : sym + ' was already gone from that list.'));
}

/* ── create / delete a whole list ──────────────────────────────────────────
   Both were reachable only inside the ✎ editor, which meant opening a modal
   and saving a draft to do the two commonest roster edits (owner request
   2026-08-01). Each routes through wlMutate() like every other write: an
   authoritative read, a mutation, one atomic replace-all. Never a patch of the
   rendered payload — that omits unresolved symbols and can be an hour stale
   when the market is shut. */
let wlDelTarget = null;   /* {idx, title} — which band's × was pressed */

function wlNewErr(msg) {
  const p = document.getElementById('wlNewErr');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
}

function wlDelErr(msg) {
  const p = document.getElementById('wlDelErr');
  if (!p) return;
  p.textContent = msg || '';
  p.hidden = !msg;
}

function openWlNewList(invoker) {
  if (!wlCanEdit() || wlBusy) return;
  wlReturnFocus = invoker || null;
  const back = document.getElementById('wlNewBackdrop');
  const input = document.getElementById('wlNewInput');
  if (!back || !input) return;
  input.value = '';
  input.disabled = false;
  wlNewErr('');
  back.hidden = false;
  input.focus();
}

function closeWlNewList() {
  if (wlBusy) return;   /* don't abandon a write mid-flight */
  const back = document.getElementById('wlNewBackdrop');
  if (back) back.hidden = true;
  wlRestoreFocus();
}

async function submitWlNewList() {
  if (wlBusy) return;
  const input = document.getElementById('wlNewInput');
  const btn = document.getElementById('wlNewSaveBtn');
  const name = String((input && input.value) || '').trim().slice(0, 60);
  if (!name) { wlNewErr('Give the list a name.'); if (input) input.focus(); return; }
  wlBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  if (input) input.disabled = true;
  let dupe = false;
  const res = await wlMutate(lists => {
    /* A DUPLICATE NAME IS REFUSED, and not for tidiness: wlPick() falls back to
       resolving a list by title when the index has moved, and gives up unless
       exactly one matches. Two lists called the same thing would make every
       add, remove and drop into either of them unaddressable — a silent
       failure much worse than this error line. Checked against the
       authoritative roster inside the mutation, not the render. */
    if (lists.some(l => (l.title || '').trim().toLowerCase() === name.toLowerCase())) {
      dupe = true;
      return false;
    }
    lists.push({ title: name, symbols: [] });
    return true;
  });
  wlBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Create'; }
  if (input) input.disabled = false;
  if (res.ok) { closeWlNewList(); return; }
  wlNewErr(dupe ? 'You already have a list called “' + name + '”.' : (res.err || 'Could not create that list.'));
  if (input) input.focus();
}

function openWlDelList(idx, title, invoker) {
  if (!wlCanEdit() || wlBusy) return;
  /* Enforced HERE and not only on the button, the same way wlCommitMove and
     wlMoveBand enforce it rather than trusting their controls. A disabled
     button is a hint; the keyboard path, a stale render and a console call all
     reach this function directly. */
  if (wlLocked) { wlNote('Unlock the arrangement to delete a list'); return; }
  wlDelTarget = { idx, title };
  wlReturnFocus = invoker || null;
  const back = document.getElementById('wlDelBackdrop');
  const text = document.getElementById('wlDelText');
  if (!back) return;
  if (text) {
    /* Counted from the SAVED symbols, not the drawn tiles: a list whose
       tickers did not resolve has no rows at all, and telling the owner they
       are deleting an empty list when it holds eleven symbols would be a lie
       at exactly the moment it matters. */
    const lists = (wlState.payload && wlState.payload.lists) || [];
    const l = lists[idx];
    const n = ((l && l.symbols) || []).length;
    text.textContent = 'Delete “' + title + '”' +
      (n ? ' and the ' + n + ' symbol' + (n === 1 ? '' : 's') + ' in it?' : '?') +
      ' This cannot be undone.';
  }
  wlDelErr('');
  back.hidden = false;
  const cancel = document.getElementById('wlDelCancelBtn');
  if (cancel) cancel.focus();   /* destructive dialog opens on the safe choice */
}

function closeWlDelList() {
  if (wlBusy) return;
  const back = document.getElementById('wlDelBackdrop');
  if (back) back.hidden = true;
  wlDelTarget = null;
  wlRestoreFocus();
}

async function confirmWlDelList() {
  if (!wlDelTarget || wlBusy) return;
  const { idx, title } = wlDelTarget;
  const btn = document.getElementById('wlDelConfirmBtn');
  wlBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  let found = true;
  const res = await wlMutate(lists => {
    /* wlPick resolves by index, falling back to a unique title — so a roster
       that shifted under an open dialog deletes the list the owner POINTED AT
       or nothing at all, never whatever now sits at that index. */
    const l = wlPick(lists, idx, title);
    if (!l) { found = false; return false; }
    const at = lists.indexOf(l);
    if (at < 0) { found = false; return false; }
    lists.splice(at, 1);
    return true;
  });
  wlBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  if (res.ok) { closeWlDelList(); return; }
  wlDelErr(res.err || (!found
    ? 'That list moved or was renamed — reload and try again.'
    : 'Could not delete that list.'));
}

/* DOUBLE-CLICK a tile to reach the confirm dialog (owner ruling 2026-07-30,
   replacing the hold — 3s, then 1s, then this). The confirm dialog was always
   the real safety net, so the gesture only has to be more deliberate than a
   stray single click, which a double-click is.

   `dblclick` fires on touch double-taps too, but mobile browsers treat a
   double-tap as zoom by default and would swallow it — hence
   `touch-action: manipulation` on the tiles in components.css. Without that
   the gesture works on desktop and silently does nothing on a phone.

   Delete/Backspace on a focused tile reaches the same dialog: the tiles are
   already focusable for screen readers, and a remove that only a pointer can
   reach is not a remove everyone has. */
function wlWireRemove(tile, sym, idx, title) {
  /* Marks the tile as actually having a removal wired, so the touch-gesture
     override in components.css applies ONLY here (Codex review, PR #200).
     Putting it on every .wl-tile cost mobile users double-tap zoom in demo and
     locked sessions, where nothing is listening for the gesture — a real
     capability traded for nothing. */
  tile.classList.add('wl-removable');
  tile.addEventListener('dblclick', e => {
    e.preventDefault();
    openWlRemove(sym, idx, title, tile);
  });
  tile.addEventListener('keydown', e => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    e.preventDefault();
    openWlRemove(sym, idx, title, tile);
  });
}

/* ── symbol detail window (owner request 2026-08-06) ───────────────────────
   A SINGLE click on a tile opens a bigger read-only view: full quote, key
   stats, and a large candle chart with its own span control.

   THE COLLISION, and why the open is deferred. Double-click already removes a
   tile (owner ruling 2026-07-30, after a 3s hold and then a 1s hold were both
   rejected), and a double-click fires a `click` FIRST — so a naive click
   handler would pop the detail window open underneath every removal, and the
   modal would then swallow the second click and break removal outright. The
   fix is the standard disambiguation: hold the open for WL_CLICK_MS and cancel
   it if a `dblclick` lands. 250ms is under the ~500ms platform double-click
   threshold, so it costs a barely perceptible pause and never eats the second
   click.

   The delay is applied ONLY where a removal is actually wired. In demo and
   anywhere else `wlCanEdit()` is false there is no dblclick listener to
   protect, and lagging the open there would be paying the cost of a conflict
   that does not exist.

   A drag also ends in a `click` on the tile it started from, so a completed
   drag arms a short suppression window — without it, arranging the panel would
   open a detail window on every drop. */
const WL_CLICK_MS = 250;
const WL_DRAG_CLICK_MS = 400;
let wlDragClickAt = 0;

function wlWireOpen(tile, sym, deferred) {
  let timer = 0;
  tile.addEventListener('click', () => {
    /* A drop is not a click on the tile, even though the browser reports one. */
    if (Date.now() - wlDragClickAt < WL_DRAG_CLICK_MS) return;
    if (!deferred) { openWlDetail(sym, tile); return; }
    clearTimeout(timer);
    timer = setTimeout(() => openWlDetail(sym, tile), WL_CLICK_MS);
  });
  /* Cancels the pending open. The removal dialog's own handler still runs — the
     two listeners are independent, this one only withdraws the detail window. */
  tile.addEventListener('dblclick', () => clearTimeout(timer));
  /* Enter/Space reach the same window: a detail view only a pointer can open is
     not a detail view everyone has. Delete/Backspace stay with removal. */
  tile.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openWlDetail(sym, tile);
  });
}

/* Trading days behind each span token — the tail of the daily series to draw.
   1D is the odd one: it is an intraday session, so it reads a different feed
   (kind:'intraday') rather than slicing one bar off the daily one. */
const WL_DETAIL_SPAN = { '1mo': 21, '3mo': 63, '6mo': 126, '1y': 252, '2y': 504, '5y': 1260 };
/* `loading` is tracked, not inferred from (bars === null && info === undefined).
   Inferring it was wrong on a TIMEFRAME CHANGE: the new span clears `bars` but
   keeps the quote it already has, so the window claimed "no chart data" during
   an ordinary reload, and lamped the panel STALE before its first fetch had
   even settled. */
const wlDetail = { sym: null, tf: '1d', bars: null, info: undefined, seq: 0, invoker: null, asOf: null, at: null, loading: false , smas: null };

function openWlDetail(sym, invoker) {
  const back = document.getElementById('wlDetailBackdrop');
  if (!back || !sym) return;
  wlDetail.sym = sym;
  /* Opens on the span the PANEL is showing, so the chart is the tile's own
     line made bigger — which is what was asked for. Adjusting it here is local
     to the window: it must not repaint every tile or refetch the panel, and it
     is deliberately not persisted, so the next open again matches the panel. */
  wlDetail.tf = wlTf;
  wlDetail.bars = null;
  wlDetail.info = undefined;
  wlDetail.invoker = invoker || null;
  const title = document.getElementById('wlDetailTitle');
  if (title) title.textContent = sym;
  const nameEl = document.getElementById('wlDetailName');
  if (nameEl) nameEl.textContent = '';
  back.hidden = false;
  /* read the saved set once per open, not per render */
  if (!wlDetail.smas) wlDetail.smas = loadWlSmas();
  renderWlDetailTf();
  renderWlDetailSmas();
  renderWlDetail();
  loadWlDetail();
  const close = document.getElementById('wlDetailCloseBtn');
  if (close) close.focus();
}

function closeWlDetail() {
  const back = document.getElementById('wlDetailBackdrop');
  if (back) back.hidden = true;
  /* Bumping the sequence orphans any fetch still in flight, so a slow 5Y reply
     cannot repaint a window the owner has already closed — or, worse, land in
     the next symbol's window. */
  wlDetail.seq++;
  wlDetail.sym = null;
  const focus = wlDetail.invoker;
  wlDetail.invoker = null;
  if (focus && document.body.contains(focus)) focus.focus();
}

function renderWlDetailTf() {
  const host = document.getElementById('wlDetailTf');
  if (!host) return;
  host.textContent = '';
  for (const [key, label] of WL_TFS) {
    const b = el('button', '', label);
    b.type = 'button';
    b.dataset.tf = key;
    b.setAttribute('aria-pressed', String(wlDetail.tf === key));
    b.addEventListener('click', () => {
      if (wlDetail.tf === key) return;
      wlDetail.tf = key;
      wlDetail.bars = null;
      renderWlDetailTf();
      renderWlDetail();
      loadWlDetail();
      const again = document.querySelector('#wlDetailTf button[data-tf="' + key + '"]');
      if (again) again.focus();
    });
    host.appendChild(b);
  }
}

async function loadWlDetail() {
  const sym = wlDetail.sym;
  const tf = wlDetail.tf;
  const seq = ++wlDetail.seq;
  const stale = () => seq !== wlDetail.seq || wlDetail.sym !== sym;
  wlDetail.loading = true;

  if (DESK.mode === 'demo') {
    wlDetail.loading = false;
    wlDetail.bars = buildDemoDetailBars(sym, tf);
    const q = demoWlQuote(sym);
    wlDetail.info = { name: q.name, price: q.last, changePct: q.pct, change: q.last - q.last / (1 + q.pct / 100) };
    wlDetail.asOf = lastTradingDay(new Date()).toISOString().slice(0, 10);
    wlDetail.at = null;
    renderWlDetail();
    return;
  }

  /* LIVE IS REAL DATA OR NOTHING. A failure leaves bars null and renders the
     empty state with a STALE lamp — never a demo series, which would put a
     fabricated chart under a real ticker. */
  const wantIntraday = tf === '1d';
  const [barsRes, infoRes] = await Promise.all([
    deskQuote(sym, wantIntraday ? 'intraday' : 'daily').catch(() => null),
    deskQuote(sym, 'info').catch(() => null),
  ]);
  if (stale()) return;
  wlDetail.loading = false;

  let series = barsRes && barsRes.ok && barsRes.series ? barsRes.series : null;
  if (series && wantIntraday) series = wlDetailLastSession(series);
  else if (series) series = wlSliceTail(series, WL_DETAIL_SPAN[tf] || 252);
  wlDetail.bars = series && series.c && series.c.length >= 2 ? series : null;
  wlDetail.info = infoRes && infoRes.ok && infoRes.info ? infoRes.info : null;
  wlDetail.asOf = barsRes && barsRes.asOf ? String(barsRes.asOf).slice(0, 10) : null;
  wlDetail.at = infoRes && infoRes.asOf ? infoRes.asOf : (barsRes ? barsRes.asOf : null);
  renderWlDetail();
}

/* Keep only the newest session's bars from the 5-day intraday feed, so 1D means
   today rather than a week smeared across one axis. Regular session only: the
   daily-bar rule (extended prints never fold into a daily OHLC) does not apply
   to an intraday pane, but mixing a thin 4am print into a "1D" chart would
   still overstate the day's range. */
function wlDetailLastSession(s) {
  const reg = regularOnly(s);
  if (!reg.t || !reg.t.length) return reg;
  const dayOf = v => String(v).slice(0, 10);
  const last = dayOf(reg.t[reg.t.length - 1]);
  let i = reg.t.length - 1;
  while (i > 0 && dayOf(reg.t[i - 1]) === last) i--;
  return wlSliceTail(reg, reg.t.length - i);
}

function wlSliceTail(s, n) {
  const len = s.c.length;
  const from = Math.max(0, len - n);
  const cut = k => (Array.isArray(s[k]) ? s[k].slice(from) : []);
  return { t: cut('t'), o: cut('o'), h: cut('h'), l: cut('l'), c: cut('c'), v: cut('v') };
}

function renderWlDetail() {
  if (!wlDetail.sym) return;
  const demo = DESK.mode === 'demo';
  const info = wlDetail.info;
  const bars = wlDetail.bars;

  const nameEl = document.getElementById('wlDetailName');
  if (nameEl) {
    /* Only when it differs from the ticker: Yahoo echoes the symbol back for
       names it lacks, and "IYT — IYT" reads as a bug. */
    const n = info && info.name;
    nameEl.textContent = (n && n.toUpperCase() !== wlDetail.sym.toUpperCase()) ? n : '';
  }

  const lampEl = document.getElementById('wlDetailLamp');
  const stampEl = document.getElementById('wlDetailStamp');
  if (lampEl && stampEl) {
    if (demo) {
      lampEl.className = 'lamp lamp--demo'; lampEl.textContent = 'Demo';
      stampEl.textContent = 'Seeded demo series';
    } else if (wlDetail.loading) {
      /* Not STALE while a fetch is still out — STALE is a claim that the feed
         has stopped answering, and making it before the first reply lands
         accuses a healthy backend. */
      lampEl.className = 'lamp'; lampEl.textContent = '—';
      stampEl.textContent = 'Fetching…';
    } else if (!bars && info == null) {
      lampEl.className = 'lamp lamp--stale'; lampEl.textContent = 'STALE';
      stampEl.textContent = 'No data for ' + wlDetail.sym;
    } else {
      const lamp = liveLampFor(new Date().toISOString(), wlDetail.asOf, true, wlDetail.at);
      lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
      stampEl.textContent = lamp.stamp || '';
    }
  }

  renderWlDetailQuote(info, bars);
  renderWlDetailStats(info, demo);

  const svg = document.getElementById('wlDetailChart');
  const empty = document.getElementById('wlDetailEmpty');
  const ready = !!(bars && bars.c && bars.c.length >= 2);
  if (svg) svg.hidden = !ready;
  if (empty) {
    empty.hidden = ready;
    if (!ready) {
      empty.textContent = wlDetail.loading
        ? 'Loading…'
        : 'No chart data for ' + wlDetail.sym + ' over this span.';
    }
  }
  if (ready) drawWlDetailChart(bars);
}

function renderWlDetailQuote(info, bars) {
  const box = document.getElementById('wlDetailQuote');
  if (!box) return;
  box.textContent = '';
  let last = null, chg = null, pct = null;
  if (info && info.price != null) {
    last = info.price; chg = info.change; pct = info.changePct;
  } else if (bars && bars.c.length > 1) {
    const n = bars.c.length;
    last = bars.c[n - 1]; chg = bars.c[n - 1] - bars.c[n - 2];
    pct = (bars.c[n - 1] / bars.c[n - 2] - 1) * 100;
  }
  if (last == null) return;
  box.appendChild(el('span', 'wl-detail-last', fmtPrice(last)));
  if (chg != null) {
    const sign = chg > 0 ? '+' : '';
    box.appendChild(el('span', 'wl-detail-chg ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : ''),
      sign + fmtPrice(chg) + ' (' + sign + (pct == null ? '0.00' : pct.toFixed(2)) + '%)'));
  }
  /* Extended print on its own marked line, never replacing the last — the same
     rule the Markets tiles and the charts readout follow. Absent means "did not
     trade after hours", never 0. */
  if (info && info.extPrice != null) {
    const ep = info.extPct;
    box.appendChild(el('span', 'wl-detail-ext',
      'AFTER HRS ' + fmtPrice(info.extPrice) +
      (ep == null ? '' : ' (' + (ep > 0 ? '+' : '') + ep.toFixed(2) + '%)')));
  }
}

function renderWlDetailStats(info, demo) {
  const box = document.getElementById('wlDetailStats');
  if (!box) return;
  box.textContent = '';
  const item = (label, value) => {
    const span = el('span', 'wl-detail-item');
    span.appendChild(el('b', '', label));
    span.appendChild(document.createTextNode(value));
    box.appendChild(span);
  };
  if (demo) { box.appendChild(el('span', 'wl-detail-muted', 'Key stats show in live mode')); return; }
  if (info === undefined) { box.appendChild(el('span', 'wl-detail-muted', 'Loading key stats…')); return; }
  if (info === null) { box.appendChild(el('span', 'wl-detail-muted', 'Key stats unavailable for ' + wlDetail.sym)); return; }
  if (info.bid != null && info.bid > 0) item('Bid', fmtPrice(info.bid));
  if (info.ask != null && info.ask > 0) item('Ask', fmtPrice(info.ask));
  const e = fmtEarnings(info.earningsTs, info.earningsEstimate);
  if (e) item('Earnings', e.text);
  if (info.marketCap != null) item('Mkt cap', wbFmtCap(info.marketCap));
  if (info.pe != null) item(info.peFwd ? 'Fwd P/E' : 'P/E', info.pe.toFixed(1) + (info.peFwd ? '' : ' ttm'));
  if (info.wkLow != null && info.wkHigh != null) item('52w', '$' + info.wkLow.toFixed(2) + '–$' + info.wkHigh.toFixed(2));
  if (info.divYield != null && info.divYield > 0) item('Yield', info.divYield.toFixed(2) + '%');
  if (!box.childNodes.length) box.appendChild(el('span', 'wl-detail-muted', 'Key stats unavailable for ' + wlDetail.sym));
}

/* Self-contained candle renderer. Deliberately NOT drawPane from the charts
   workbench: that is a closure inside renderCharts(), tuned to the three Pro
   panes and guarded by S12/S25/S34, and prising it out to serve a modal would
   put a heavily-ruled surface at risk for a view that needs none of its
   stochastic machinery. */
/* Owner-selectable moving averages (2026-08-08). The set matches the charts
   workbench MINUS SMA (1) — a 1-period average IS the close, which the candles
   already draw, so offering it here would be a control that changes nothing
   visible. Colours come from the workbench's own `SMA_COLORS`, so a 50 here is
   the same colour as a 50 on a Pro pane; the old hard-coded 20/50 pair used the
   generic series ramp and agreed with nothing.
   The choice persists, like the panel's timeframe — it is a reading preference,
   not per-symbol state, so it should survive closing the window. */
const WL_SMA_SET = [25, 50, 100, 200];
const WL_SMA_KEY = 'wl_detail_smas_v1';
function loadWlSmas() {
  const on = { 25: true, 50: true, 100: false, 200: false };
  try {
    const raw = JSON.parse(localStorage.getItem(WL_SMA_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const n of WL_SMA_SET) if (typeof raw[n] === 'boolean') on[n] = raw[n];
    }
  } catch { /* private mode, or a hand-edited value — keep the defaults */ }
  return on;
}
function saveWlSmas() {
  try { localStorage.setItem(WL_SMA_KEY, JSON.stringify(wlDetail.smas)); } catch { /* private mode */ }
}
function renderWlDetailSmas() {
  const host = document.getElementById('wlDetailSmas');
  if (!host) return;
  host.textContent = '';
  for (const n of WL_SMA_SET) {
    const lab = el('label', 'wl-sma-opt');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!wlDetail.smas[n];
    box.addEventListener('change', () => {
      wlDetail.smas[n] = box.checked;
      saveWlSmas();
      renderWlDetail();
    });
    const swatch = el('span', 'wl-sma-dot');
    swatch.style.background = SMA_COLORS[n];
    lab.appendChild(box);
    lab.appendChild(swatch);
    lab.appendChild(el('span', '', 'SMA ' + n));
    host.appendChild(lab);
  }
}
function wlSma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function drawWlDetailChart(bars) {
  const svg = document.getElementById('wlDetailChart');
  if (!svg) return;
  svg.textContent = '';
  const box = svg.getBoundingClientRect();
  const W = Math.max(320, Math.round(box.width) || 900);
  const H = Math.max(200, Math.round(box.height) || 380);
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');

  const PAD_L = 8, PAD_R = 62, PAD_T = 10, PAD_B = 22;
  const VOL_H = Math.round(H * 0.18);
  const plotW = W - PAD_L - PAD_R;
  const priceH = H - PAD_T - PAD_B - VOL_H - 6;
  const n = bars.c.length;
  const hi = Math.max(...bars.h), lo = Math.min(...bars.l);
  const span = (hi - lo) || 1;
  const pad = span * 0.05;
  const yTop = hi + pad, yBot = lo - pad;
  const y = v => PAD_T + (yTop - v) / (yTop - yBot) * priceH;
  const step = plotW / n;
  const bw = Math.max(1, Math.min(14, step * 0.66));

  /* Horizontal price grid + right-hand scale. Five lines is enough to read a
     level off without turning the plot into graph paper. */
  for (let i = 0; i <= 4; i++) {
    const v = yBot + (yTop - yBot) * (i / 4);
    const yy = y(v);
    svg.appendChild(svgEl('line', {
      x1: PAD_L, x2: PAD_L + plotW, y1: yy, y2: yy,
      stroke: 'var(--color-border)', 'stroke-width': 1, opacity: 0.5,
    }));
    const lab = svgEl('text', {
      x: PAD_L + plotW + 6, y: yy + 4, fill: 'var(--color-text-secondary)',
      'font-size': 11, 'font-variant-numeric': 'tabular-nums',
    });
    lab.textContent = fmtPrice(v);
    svg.appendChild(lab);
  }

  /* Volume under the price, price-coloured: a volume bar is a fact about one
     bar, so it takes that bar's own direction. */
  const vMax = Math.max(1, ...(bars.v || [0]));
  const volTop = PAD_T + priceH + 6;
  for (let i = 0; i < n; i++) {
    const vv = (bars.v && bars.v[i]) || 0;
    if (!vv) continue;
    const h = Math.max(1, (vv / vMax) * VOL_H);
    const up = bars.c[i] >= bars.o[i];
    svg.appendChild(svgEl('rect', {
      x: PAD_L + i * step + (step - bw) / 2, y: volTop + VOL_H - h, width: bw, height: h,
      fill: up ? 'var(--color-gain)' : 'var(--color-loss)', opacity: 0.35,
    }));
  }

  for (let i = 0; i < n; i++) {
    const up = bars.c[i] >= bars.o[i];
    const col = up ? 'var(--color-gain)' : 'var(--color-loss)';
    const cx = PAD_L + i * step + step / 2;
    svg.appendChild(svgEl('line', {
      x1: cx, x2: cx, y1: y(bars.h[i]), y2: y(bars.l[i]), stroke: col, 'stroke-width': 1,
    }));
    const yo = y(bars.o[i]), yc = y(bars.c[i]);
    svg.appendChild(svgEl('rect', {
      x: cx - bw / 2, y: Math.min(yo, yc), width: bw,
      height: Math.max(1, Math.abs(yc - yo)), fill: col,
    }));
  }

  /* SMAs only where they are fully warmed — a line that starts mid-chart is
     honest, one drawn from a partial window is not. Series colours are
     CVD-validated and must keep their order. */
  WL_SMA_SET.forEach(period => {
    if (!wlDetail.smas || !wlDetail.smas[period]) return;
    if (n <= period) return;
    const ma = wlSma(bars.c, period);
    const pts = [];
    for (let i = 0; i < n; i++) {
      if (ma[i] == null) continue;
      pts.push((PAD_L + i * step + step / 2).toFixed(1) + ',' + y(ma[i]).toFixed(1));
    }
    if (pts.length < 2) return;
    svg.appendChild(svgEl('polyline', {
      points: pts.join(' '), fill: 'none',
      stroke: SMA_COLORS[period], 'stroke-width': 1.5, opacity: 0.9,
    }));
  });

  /* First and last date, nothing between: a dense axis of dates on a 5Y chart
     is unreadable, and the two ends are what actually anchor the span. */
  const label = (v, x, anchor) => {
    const txt = svgEl('text', { x, y: H - 6, fill: 'var(--color-text-secondary)', 'font-size': 11, 'text-anchor': anchor });
    txt.textContent = String(v || '').slice(0, 10);
    svg.appendChild(txt);
  };
  if (bars.t && bars.t.length) {
    label(bars.t[0], PAD_L, 'start');
    label(bars.t[n - 1], PAD_L + plotW, 'end');
  }
}

function wireWatchlistDetail() {
  const back = document.getElementById('wlDetailBackdrop');
  const close = document.getElementById('wlDetailCloseBtn');
  if (close) close.addEventListener('click', closeWlDetail);
  if (back) back.addEventListener('click', e => { if (e.target === back) closeWlDetail(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && back && !back.hidden) closeWlDetail();
  });
  /* The chart is sized from its rendered box, so a resize has to redraw it or
     the candles keep the old width's geometry. */
  window.addEventListener('resize', () => {
    if (back && !back.hidden && wlDetail.bars) drawWlDetailChart(wlDetail.bars);
  });
}

function wireWatchlistQuickEdits() {
  /* ONE + for the whole panel, and it asks WHICH LIST (owner ruling
     2026-07-31, replacing the staging tray). `null` means "no fixed target" —
     openWlQuickAdd then shows the picker. */
  const trayAdd = document.getElementById('wlTrayAdd');
  if (trayAdd) trayAdd.addEventListener('click', () => openWlQuickAdd(null, null, trayAdd));
  const trash = document.getElementById('wlTrash');
  if (trash) {
    /* A drop target is pointer-only, so the trash also answers to a click when
       a tile is focused — otherwise removal-by-trash is a control a keyboard
       cannot reach. Double-click on the tile remains the fast path either way. */
    trash.addEventListener('click', () => {
      const t = document.activeElement;
      if (!t || !t.classList || !t.classList.contains('wl-tile')) { wlNote('Focus a symbol first, then press the bin'); return; }
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
  }

  const q = document.getElementById('wlQuickBackdrop');
  const qClose = document.getElementById('wlQuickCloseBtn');
  const qSave = document.getElementById('wlQuickSaveBtn');
  const qInput = document.getElementById('wlQuickInput');
  if (qClose) qClose.addEventListener('click', closeWlQuickAdd);
  if (qSave) qSave.addEventListener('click', submitWlQuickAdd);
  if (q) q.addEventListener('click', e => { if (e.target === q) closeWlQuickAdd(); });
  /* Enter submits, Shift+Enter breaks a line. Pasting is unaffected either way —
     a paste inserts its own newlines without going through this handler, which
     is what lets the textarea take a broker column verbatim. */
  if (qInput) qInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    submitWlQuickAdd();
  });

  const nb = document.getElementById('wlNewListBtn');
  if (nb) nb.addEventListener('click', () => openWlNewList(nb));
  const n = document.getElementById('wlNewBackdrop');
  const nClose = document.getElementById('wlNewCloseBtn');
  const nSave = document.getElementById('wlNewSaveBtn');
  const nInput = document.getElementById('wlNewInput');
  if (nClose) nClose.addEventListener('click', closeWlNewList);
  if (nSave) nSave.addEventListener('click', submitWlNewList);
  if (n) n.addEventListener('click', e => { if (e.target === n) closeWlNewList(); });
  if (nInput) nInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitWlNewList();
  });

  const d = document.getElementById('wlDelBackdrop');
  const dCancel = document.getElementById('wlDelCancelBtn');
  const dOk = document.getElementById('wlDelConfirmBtn');
  if (dCancel) dCancel.addEventListener('click', closeWlDelList);
  if (dOk) dOk.addEventListener('click', confirmWlDelList);
  if (d) d.addEventListener('click', e => { if (e.target === d) closeWlDelList(); });

  const r = document.getElementById('wlRmBackdrop');
  const rCancel = document.getElementById('wlRmCancelBtn');
  const rOk = document.getElementById('wlRmConfirmBtn');
  if (rCancel) rCancel.addEventListener('click', closeWlRemove);
  if (rOk) rOk.addEventListener('click', confirmWlRemove);
  if (r) r.addEventListener('click', e => { if (e.target === r) closeWlRemove(); });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (q && !q.hidden) closeWlQuickAdd();
    if (r && !r.hidden) closeWlRemove();
    if (n && !n.hidden) closeWlNewList();
    if (d && !d.hidden) closeWlDelList();
  });
}

function renderWlEditor() {
  const host = document.getElementById('wlEditLists');
  if (!host) return;
  host.textContent = '';
  wlEdit.forEach((l, i) => {
    const row = el('div', 'wl-edit-row');
    const head = el('div', 'wl-edit-head');

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'wl-edit-title';
    title.value = l.title;
    title.maxLength = 60;
    title.setAttribute('aria-label', 'List name');
    title.addEventListener('input', () => { l.title = title.value; });
    head.appendChild(title);

    const count = el('span', 'wl-edit-count', l.symbols.length + ' symbols');
    head.appendChild(count);

    const del = el('button', 'wl-edit-del', 'Delete');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete list ' + l.title);
    del.addEventListener('click', () => {
      /* deleting a whole list is the one destructive control here, and the
         save is a replace-all — confirm rather than let a stray click drop it */
      if (l.symbols.length && !confirm('Delete the list "' + l.title + '" and its ' + l.symbols.length + ' symbols?')) return;
      wlEdit.splice(i, 1);
      renderWlEditor();
    });
    head.appendChild(del);
    row.appendChild(head);

    const ta = document.createElement('textarea');
    ta.className = 'wl-edit-syms';
    ta.rows = 4;
    ta.value = l.symbols.join(', ');
    ta.setAttribute('aria-label', 'Symbols in ' + l.title);
    ta.addEventListener('input', () => {
      l.symbols = wlParseSyms(ta.value);
      count.textContent = l.symbols.length + ' symbols';
    });
    row.appendChild(ta);
    host.appendChild(row);
  });
}

function wlEditErr(msg) {
  const e = document.getElementById('wlEditErr');
  if (!e) return;
  e.textContent = msg || '';
  e.hidden = !msg;
}

async function openWlEditor() {
  const pin = null;   /* open RPCs — no PIN (desk_011) */
  if (!wlCanEdit()) return;
  const back = document.getElementById('wlEditBackdrop');
  wlEditErr('');
  /* A FAILED read must never become an editable empty draft (Codex review,
     PR #188). Save is a replace-all, so if the load failed and the owner then
     confirmed the empty-state prompt, a recovered connection would delete every
     real list on the strength of a draft that never reflected them. On failure
     the editor opens read-only with the reason shown, and Save is disabled. */
  let loaded = false;
  try {
    const out = await deskGetWatchlists(pin);
    if (out && out.ok) {
      wlEdit = (out.lists || []).map(l => ({ title: l.title, symbols: (l.symbols || []).slice() }));
      wlEditVersion = out.version ?? null;
      loaded = true;
    } else {
      wlEditErr('Could not load your watchlists — unlock again before editing.');
      wlEdit = []; wlEditVersion = null;
    }
  } catch {
    wlEditErr('Could not reach the desk to load your watchlists.');
    wlEdit = []; wlEditVersion = null;
  }
  const saveBtn = document.getElementById('wlSaveBtn');
  const addBtn = document.getElementById('wlAddListBtn');
  if (saveBtn) saveBtn.disabled = !loaded;
  if (addBtn) addBtn.disabled = !loaded;
  wlEditLoaded = loaded;
  renderWlEditor();
  const stamp = document.getElementById('wlEditStamp');
  if (stamp) stamp.textContent = wlEdit.length + (wlEdit.length === 1 ? ' list' : ' lists');
  back.hidden = false;
  const first = back.querySelector('.wl-edit-title');
  if (first) first.focus();
}

/* Re-read the roster into the OPEN modal after a conflict. Shares openWlEditor's
   rule that a failed read must never become an editable draft: on failure the
   version is cleared to a sentinel no write can match, so Save stays refused
   rather than falling back to the unguarded last-write-wins path. */
async function reloadWlEditorDraft() {
  try {
    const out = await deskGetWatchlists(null);
    if (out && out.ok) {
      wlEdit = (out.lists || []).map(l => ({ title: l.title, symbols: (l.symbols || []).slice() }));
      wlEditVersion = out.version ?? null;
      wlEditLoaded = true;
      renderWlEditor();
      return true;
    }
  } catch { /* fall through to the disabled state below */ }
  wlEditLoaded = false;
  const saveBtn = document.getElementById('wlSaveBtn');
  if (saveBtn) saveBtn.disabled = true;
  return false;
}

function closeWlEditor() {
  const back = document.getElementById('wlEditBackdrop');
  if (back) back.hidden = true;
  wlEdit = null;
  wlEditVersion = null;
  const btn = document.getElementById('wlEditBtn');
  if (btn) btn.focus();
}

async function saveWlEditor() {
  const pin = null;   /* open RPCs — no PIN (desk_011) */
  /* wlEditLoaded still gates this, and matters MORE now that no PIN does: a
     replace-all built from a draft that never loaded would delete real lists. */
  if (!wlEdit || !wlEditLoaded) return;
  const lists = wlEdit
    .map(l => ({ title: String(l.title || '').trim(), symbols: l.symbols }))
    .filter(l => l.title);
  /* An empty submission wipes every list. That is a legitimate thing to want,
     but never something to do by accident on a replace-all. */
  if (!lists.length && !confirm('Save with no lists at all? This removes every watchlist.')) return;
  const btn = document.getElementById('wlSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  wlEditErr('');
  try {
    const out = await deskSetWatchlists(pin, lists, wlEditVersion);
    if (out && out.error === 'conflict') {
      /* The roster moved while this modal was open, so saving would delete
         whatever changed. Reload the draft IN PLACE — closing it would throw
         away the owner's edits, and re-sending the same draft would just lose
         the race again. They see the current lists and can redo the edit. */
      /* Branch on the reload: if THAT read also failed, the draft on screen is
         still the stale one and Save is now disabled, so claiming it was
         refreshed would leave the owner staring at old data with a dead button
         and no idea why (Codex review). Say which of the two happened. */
      const fresh = await reloadWlEditorDraft();
      wlEditErr(fresh
        ? 'Your watchlists changed elsewhere while this was open. The list below has been refreshed — redo your edit and save again.'
        : 'Your watchlists changed elsewhere while this was open, and the desk could not be reached to reload them. Close this and reopen the editor — the list below is out of date and cannot be saved.');
      return;
    }
    if (!out || !out.ok) { wlEditErr('The desk rejected the save — try again.'); return; }
    closeWlEditor();
    /* force past the feed's cache so the panel shows the roster just saved */
    await loadWatchlist(true);
  } catch {
    wlEditErr('Could not reach the desk to save.');
  } finally {
    if (btn) { btn.disabled = !wlEditLoaded; btn.textContent = 'Save & exit'; }
  }
}

function wireWatchlistEditor() {
  const btn = document.getElementById('wlEditBtn');
  if (btn) btn.addEventListener('click', openWlEditor);
  const close = document.getElementById('wlEditCloseBtn');
  if (close) close.addEventListener('click', closeWlEditor);
  const back = document.getElementById('wlEditBackdrop');
  if (back) back.addEventListener('click', e => { if (e.target === back) closeWlEditor(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && back && !back.hidden) closeWlEditor();
  });
  const add = document.getElementById('wlAddListBtn');
  if (add) add.addEventListener('click', () => {
    if (!wlEdit) return;
    wlEdit.push({ title: 'New list', symbols: [] });
    renderWlEditor();
    const rows = document.querySelectorAll('#wlEditLists .wl-edit-title');
    const last = rows[rows.length - 1];
    if (last) { last.focus(); last.select(); }
  });
  const save = document.getElementById('wlSaveBtn');
  if (save) save.addEventListener('click', saveWlEditor);
}

function renderNews(news, lamp) {
  const list = document.getElementById('newsList');
  while (list.firstChild) list.removeChild(list.firstChild);
  const lampEl = document.getElementById('newsLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  const stampEl = document.getElementById('newsStamp');
  if (stampEl) {
    if (DESK.mode === 'demo') applyStamp(stampEl, '', lastLabel(), '');
    else applyLampStamp(stampEl, lamp);
  }
  if (!news || !news.length) {
    list.appendChild(el('p', 'stamp', 'No headlines in the latest snapshot — check back after the next refresh.'));
    return;
  }
  for (const n of news) {
    const row = el('div', 'news-row');
    row.appendChild(el('span', 'news-time', n.t));
    const main = el('div', 'news-main');
    /* headline links to the source article when the feed carried one; only
       http(s) — never a javascript:/data: URL from a tampered/odd feed item
       (same guard as the ask-the-desk sources footer). */
    let href = null;
    if (n.url) {
      try { const u = new URL(n.url); if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href; } catch { /* not a URL */ }
    }
    if (href) {
      const link = document.createElement('a');
      link.className = 'news-headline'; link.href = href;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = n.h;
      main.appendChild(link);
    } else {
      main.appendChild(el('p', 'news-headline', n.h));
    }
    const meta = el('div', 'news-meta');
    meta.appendChild(el('span', '', n.src));
    for (const [sym, chg] of (n.chips || [])) {
      const chip = el('span', 'chip');
      chip.appendChild(el('span', '', sym));
      if (chg !== null && chg !== undefined) chip.appendChild(el('span', chg >= 0 ? 'up' : 'down', fmtPct(chg)));
      meta.appendChild(chip);
    }
    main.appendChild(meta);
    row.appendChild(main);
    list.appendChild(row);
  }
}

/* ── ask the desk (PIN-gated Claude Q&A over the page content) ─────────── */
function buildAskContext() {
  const d = DESK.data || {};
  return {
    mode: DESK.mode,
    asOf: DESK.mode === 'demo' ? lastLabel() : (DESK.privateAsOf || null),
    accounts: (d.accounts || []).map(a => ({
      label: a.label, nav: a.nav, dayPnl: a.day, totalUnrealized: a.total, cash: a.cash,
      positions: (a.positions || []).map(p => ({ sym: p.sym, qty: p.qty, mkt: p.mkt, dayPct: p.dayPct, unrl: p.unrl })),
    })),
    /* The extended print rides along when there is one (Codex review, PR #199).
       Without it the assistant answers "how did the market close" with the
       regular close while the panel beside it shows a later after-hours price —
       two different numbers for the same question. Named fields, never folded
       into `last`, so the model can tell the two sessions apart; absent means
       the instrument did not trade after hours, which is not the same as flat.
       `extProxy` names the ETF standing in for an index, so the model reports
       "SPY −1.14% after hours" rather than attributing it to the S&P itself. */
    market: (d.market || []).map(m => {
      /* Same two rules the RENDER path applies (see mk-ext at the Markets tiles
         and mk-sec-ext at the sector cells) — the context had neither, which
         put two wrong numbers in front of the model (both reviews of PR #207):

         1. POST ONLY. `desk-market` tags each print `kind: 'pre' | 'post'`, and
            the desk deliberately shows nothing pre-market (owner: "not
            premarket"). Without this filter, between 04:00 and 09:30 ET the
            model was told a PRE-market move was an after-hours one — and the
            panel beside it renders nothing, so there was no way to catch it.
         2. PROXY WINS. An index tile can carry BOTH its own `ext` (the index
            repeating its close — indices have no extended session) and
            `extProxy` (the ETF's real move). Sending both let the model
            attribute SPY's move to the S&P itself, which is the exact
            instrument-wearing-the-wrong-name trap `extProxy` exists to stop. */
      const post = x => (x && x.kind === 'post' && x.chg != null ? x : null);
      const proxy = post(m.extProxy);
      const own = proxy ? null : post(m.ext);
      return {
        name: m.name, last: m.last, dayChgPct: m.chg,
        ...(own ? { afterHoursLast: own.last, afterHoursChgPct: own.chg } : {}),
        ...(proxy ? { afterHoursProxy: proxy.sym, afterHoursProxyChgPct: proxy.chg } : {}),
      };
    }),
    /* Pre-converted to Pacific here (fmtStampDateTime) rather than sending the
       raw UTC ISO string — every other clock on the desk is pinned to Pacific
       by a formatter before it reaches a screen (owner ruling 2026-07-22); the
       model shouldn't be doing that timezone math itself either (owner report
       2026-07-23: it was echoing UTC straight from the feed). */
    marketAsOf: DESK.mode === 'demo' ? lastLabel() : (DESK.liveStamp ? fmtStampDateTime(DESK.liveStamp.generatedAt) : null),
    headlines: (d.news || []).slice(0, 10).map(n => n.h),
    /* ── the rest of the desk (owner ruling 2026-08-10) ──────────────────────
       "The desk AI has to be aware of my entire dashboard — that's the whole
       purpose, so I can control which stocks it can focus on." Until now the
       assistant saw accounts, the Markets tiles and headlines, so a question
       about "my watchlist" had nothing to answer from — it did not know what
       was on it.
       The WATCHLIST goes in FULL: it is the owner's focus list, and a summary
       would defeat the point of curating it. Names only where a quote is
       missing, so an unresolved ticker is visible as such rather than silently
       dropped.
       The HEATMAP goes in SUMMARY: the sp500 cut alone is ~500 tiles and r2k is
       2000, which would dominate the payload of every question for a panel the
       owner reads as a picture. Sector aggregates plus the strongest movers
       carry the shape of the tape; anything more specific the assistant can
       pull itself with get_quote / get_technicals, which reach any symbol and
       return the SAME stochastics the Pro panes draw. */
    watchlist: (wlState.payload && Array.isArray(wlState.payload.lists))
      ? wlState.payload.lists.map(l => ({
        title: l.title,
        symbols: (l.rows || []).map(r => ({ sym: r.sym, last: r.last, dayChgPct: r.pct })),
        ...(Array.isArray(l.missing) && l.missing.length ? { unresolved: l.missing } : {}),
      }))
      : null,
    watchlistRange: wlState.range || null,
    heatmap: buildHeatmapContext(),
    /* the Pro panes as rendered — same numbers the owner is looking at */
    charts: wbReadings,
  };
}

/* Sector aggregates + the sharpest movers from whichever cut is on screen —
   never the whole tile set (see buildAskContext). `cut` is named so the model
   says "in the S&P 500 cut" rather than implying it looked at everything. */
function buildHeatmapContext() {
  const hm = heatState && heatState.hm;
  if (!hm || !Array.isArray(hm.sectors)) return null;
  const tiles = [];
  const sectors = [];
  for (const sec of hm.sectors) {
    const list = (sec.tiles || []).filter(t => Number.isFinite(t.pct));
    if (!list.length) continue;
    const avg = list.reduce((a, t) => a + t.pct, 0) / list.length;
    sectors.push({ name: sec.name, avgChgPct: Number(avg.toFixed(2)), names: list.length });
    for (const t of list) tiles.push({ sym: t.sym, chgPct: t.pct, sector: sec.name });
  }
  if (!sectors.length) return null;
  const byMove = [...tiles].sort((a, b) => b.chgPct - a.chgPct);
  /* `pct` is NOT always a day move: recolorForPeriod() rewrites it to the
     selected period's return (pctW/pctM/pctYtd) before renderHeatmap() stores
     the dataset here, so on 1W/1M/YTD these are weekly, monthly or
     year-to-date figures. They were being labelled avgDayChgPct/dayChgPct
     regardless, which told the model a monthly move was a daily one — wrong
     analysis stated confidently, with nothing in the answer to reveal it
     (Codex review, PR #241). The fields are therefore period-NEUTRAL and the
     period is named alongside them; a period-specific key would have to be
     read correctly to be safe, whereas a neutral one cannot be misread at
     all. `periodLabel` carries the panel's own wording so the model can say
     "1-Month Performance" in the owner's terms rather than inventing a
     phrasing for the token. */
  const period = (mapView && mapView.period) || '1d';
  const label = (MAP_PERIODS.find(p => p[0] === period) || [])[1] || null;
  return {
    cut: mapView.label || mapView.key || null,
    period,
    periodLabel: label,
    measures: period === '1d'
      ? 'chgPct is each name\'s move on the day'
      : `chgPct is each name's return over ${label}, NOT a daily move`,
    asOf: hm.asOf || null,
    names: tiles.length,
    sectors: sectors.sort((a, b) => b.avgChgPct - a.avgChgPct),
    topGainers: byMove.slice(0, 10),
    topLosers: byMove.slice(-10).reverse(),
  };
}

/* ── scheduled asks (owner request 2026-07-31; moved SERVER-side 2026-08-11) ──
   Questions the desk asks ITSELF on a timer, answered into the same thread a
   typed question lands in.

   The first version was a setInterval right here, which meant it only fired
   while the dashboard was OPEN — exactly the case where the owner is already at
   the desk and could just type the question. The owner's ruling: "the only
   value a cron task has for me is to be able to wake ITSELF up at a certain
   time each day and give me a market summary. Otherwise it's of no use."

   So the roster moved into desk_ask_schedule (desk_017 — RLS deny-all + PIN
   RPCs, same shape as the system prompt and the watchlists), pg_cron ticks
   every 5 minutes, and desk-cron-ask fires whatever is due: it assembles the
   whole dashboard server-side (there is no browser to read it from) and hands
   it to desk-ask, which appends the exchange to desk_chat_memory as usual. That
   is the table this thread already replays from, so the 8am summary is simply
   sitting there when the desk is opened.

   NOTHING on this page is required for any of that to happen. What follows is
   only the editor for the roster — no timer, no firing, no local state. */
const ASK_CADENCES = [
  /* key         label              cadence          everyHours */
  ['hourly',    'Every hour',      'hourly',        null],
  ['h2',        'Every 2 hours',   'every_n_hours', 2],
  ['h3',        'Every 3 hours',   'every_n_hours', 3],
  ['h4',        'Every 4 hours',   'every_n_hours', 4],
  ['h6',        'Every 6 hours',   'every_n_hours', 6],
  ['h8',        'Every 8 hours',   'every_n_hours', 8],
  ['h12',       'Every 12 hours',  'every_n_hours', 12],
  ['daily',     'Every day at',    'daily',         null],
  ['weekdays',  'Weekdays at',     'weekdays',      null],
];
/* The two cadence families need DIFFERENT time controls, and conflating them is
   how a scheduler starts lying: an "every 4 hours" row has no meaningful hour
   (it fires at 00/04/08/12/16/20 PT), only a minute past the hour, so offering
   it a full clock would let the owner set 8:00 and watch it fire at midnight. */
const askAtTheHour = r => r.cadence === 'hourly' || r.cadence === 'every_n_hours';
const askCadenceKey = r => (r.cadence === 'every_n_hours' ? 'h' + r.everyHours : r.cadence);
const ASK_SCHED_MAX = 10;   /* each firing is a real Claude tool-loop call */

let askSched = [];          /* the server's roster, as last read */

let askBusy = false;      /* a scheduled run must never collide with a typed one */
/* The in-flight question's AbortController, or null when idle. Module-scoped
   because Stop lives in renderAsk's form while runAsk owns the request. */
let askAbort = null;
let askRun = null;        /* set by renderAsk() — the shared send path */


/* A row as the RPC returns it, clamped to what the table will accept. Clamping
   on the way IN as well as on the way out matters: the cron writes last_run_at
   to these same rows, and a value this editor could not represent would be
   quietly rewritten by the next Save. */
function askSchedRow(raw) {
  const cadence = ['hourly', 'every_n_hours', 'daily', 'weekdays'].includes(raw && raw.cadence)
    ? raw.cadence : 'daily';
  const every = [2, 3, 4, 6, 8, 12].includes(Number(raw && raw.everyHours)) ? Number(raw.everyHours) : 4;
  const min = Math.min(55, Math.max(0, Number(raw && raw.atMin) || 0));
  return {
    id: raw && raw.id != null ? raw.id : null,
    prompt: String((raw && raw.prompt) || '').slice(0, 500),
    cadence, everyHours: every,
    atHour: Math.min(23, Math.max(0, Number(raw && raw.atHour) || 0)),
    atMin: min - (min % 5),                       /* the cron ticks on 5s */
    marketOnly: !!(raw && raw.marketOnly),
    enabled: !(raw && raw.enabled === false),
    lastRunAt: (raw && raw.lastRunAt) || null,
    lastStatus: (raw && raw.lastStatus) || null,
  };
}

/* When a cadence actually fires, spelled out. The "every N hours" family fires
   at the hours DIVISIBLE by N in Pacific — which is not what "every 4 hours"
   reads like on its own, so it is stated rather than left for the owner to
   discover at midnight. */
function askSchedWhen(r) {
  const mm = String(r.atMin).padStart(2, '0');
  if (r.cadence === 'hourly') return `fires every hour at :${mm} PT`;
  if (r.cadence === 'every_n_hours') {
    const hrs = [];
    for (let h = 0; h < 24; h += r.everyHours) hrs.push(String(h).padStart(2, '0') + ':' + mm);
    return 'fires at ' + hrs.join(', ') + ' PT';
  }
  return 'fires at ' + String(r.atHour).padStart(2, '0') + ':' + mm + ' PT, ' +
    (r.cadence === 'weekdays' ? 'Mon–Fri' : 'every day');
}

/* Roster editor for scheduled asks (desk_017). Built in JS like the rest of
   this panel rather than as static markup, because the row count is data.
   The draft is local until Save: a write REPLACES the whole roster, so saving
   on every field would mean a round trip per keystroke. */
function openAskSched(pin) {
  const back = document.getElementById('askSchedBackdrop');
  const list = document.getElementById('askSchedList');
  if (!back || !list) return;
  const noteEl = document.getElementById('askSchedNote');
  const errEl = document.getElementById('askSchedErr');
  let dirty = false;
  let closeArmed = false;

  const note = (msg, warn) => {
    if (!noteEl) return;
    noteEl.textContent = msg || '';
    noteEl.classList.toggle('ask-sched-note--warn', !!warn);
  };
  const fail = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  };
  const touch = () => { dirty = true; closeArmed = false; note('Unsaved changes', true); };

  const draw = () => {
    list.textContent = '';
    if (!askSched.length) list.appendChild(el('p', 'lock-explain', 'Nothing scheduled yet.'));
    askSched.forEach((r, i) => {
      const row = el('div', 'ask-sched-row');

      const on = document.createElement('input');
      on.type = 'checkbox'; on.checked = r.enabled;
      on.setAttribute('aria-label', 'Enabled');
      on.addEventListener('change', () => { r.enabled = on.checked; touch(); });

      const q = document.createElement('input');
      q.type = 'text'; q.className = 'input ask-sched-q'; q.value = r.prompt; q.maxLength = 500;
      q.placeholder = 'e.g. Summarise the market and my watchlist, and name the best setups';
      q.setAttribute('aria-label', 'Question');
      q.addEventListener('input', () => { r.prompt = q.value.slice(0, 500); touch(); });

      const cad = document.createElement('select');
      cad.className = 'input ask-sched-cad';
      cad.setAttribute('aria-label', 'How often');
      for (const [key, label] of ASK_CADENCES) {
        const o = document.createElement('option');
        o.value = key; o.textContent = label;
        cad.appendChild(o);
      }
      cad.value = askCadenceKey(r);
      cad.addEventListener('change', () => {
        const spec = ASK_CADENCES.find(c => c[0] === cad.value);
        if (!spec) return;
        r.cadence = spec[2];
        if (spec[3]) r.everyHours = spec[3];
        touch();
        draw();          /* the time control itself changes shape — see askAtTheHour */
      });

      /* Two different controls, deliberately: an at-the-hour cadence has only a
         minute to set, and a clock face there would invite an hour it ignores. */
      let when;
      if (askAtTheHour(r)) {
        when = document.createElement('select');
        when.className = 'input ask-sched-min';
        when.setAttribute('aria-label', 'Minutes past the hour');
        for (let m = 0; m < 60; m += 5) {
          const o = document.createElement('option');
          o.value = String(m); o.textContent = ':' + String(m).padStart(2, '0');
          when.appendChild(o);
        }
        when.value = String(r.atMin);
        when.addEventListener('change', () => { r.atMin = Number(when.value) || 0; touch(); draw(); });
      } else {
        when = document.createElement('input');
        when.type = 'time'; when.step = '300'; when.className = 'input ask-sched-time';
        when.setAttribute('aria-label', 'Time (Pacific)');
        when.value = String(r.atHour).padStart(2, '0') + ':' + String(r.atMin).padStart(2, '0');
        when.addEventListener('change', () => {
          const m = /^(\d{2}):(\d{2})$/.exec(when.value || '');
          if (!m) { when.value = String(r.atHour).padStart(2, '0') + ':' + String(r.atMin).padStart(2, '0'); return; }
          r.atHour = Math.min(23, Number(m[1]));
          const mins = Math.min(55, Number(m[2]));
          r.atMin = mins - (mins % 5);            /* snap to the grid the cron ticks on */
          touch(); draw();
        });
      }

      const mkt = document.createElement('input');
      mkt.type = 'checkbox'; mkt.checked = r.marketOnly;
      mkt.id = 'askSchedMkt' + i;
      mkt.addEventListener('change', () => { r.marketOnly = mkt.checked; touch(); });
      const mktLbl = el('label', 'ask-sched-lbl', 'market hrs only');
      mktLbl.htmlFor = mkt.id;
      mktLbl.title = 'Skip the firing unless the US market is in session (pre-market through after-hours, weekdays). Exchange holidays are not excluded.';

      /* Run now uses the DRAFT prompt and does not save — it is how you find out
         what the 8am answer will look like without waiting until 8am. */
      const now = el('button', 'btn btn-secondary', 'Run now'); now.type = 'button';
      now.disabled = !r.prompt.trim() || !askRun || askBusy;
      now.title = 'Ask this question right now, in the thread. Does not save the schedule.';
      now.addEventListener('click', () => {
        if (!askRun || !r.prompt.trim()) return;
        back.hidden = true;
        askRun(r.prompt.trim(), { scheduled: true });
      });

      const del = el('button', 'btn btn-secondary', '✕'); del.type = 'button';
      del.setAttribute('aria-label', 'Remove this question');
      del.addEventListener('click', () => { askSched.splice(i, 1); touch(); draw(); });

      const head = el('div', 'ask-sched-head');
      head.appendChild(on); head.appendChild(q); head.appendChild(del);
      const foot = el('div', 'ask-sched-foot');
      foot.appendChild(cad); foot.appendChild(when);
      foot.appendChild(mkt); foot.appendChild(mktLbl);
      foot.appendChild(now);
      /* The schedule in words, and whether it has actually run. A roster that
         showed only what was CONFIGURED could not tell a working row from one
         that has been failing quietly since it was written. */
      const state = [askSchedWhen(r)];
      if (r.lastRunAt) {
        state.push('last run ' + fmtClock(r.lastRunAt) +
          (r.lastStatus && r.lastStatus !== 'ok' ? ' — ' + r.lastStatus : ''));
      } else if (r.id != null) {
        state.push('not run yet');
      }
      foot.appendChild(el('span', 'ask-sched-when', state.join(' · ')));
      row.appendChild(head); row.appendChild(foot);
      list.appendChild(row);
    });
  };

  const load = async () => {
    fail(''); note('Loading…');
    const out = await deskGetAskSchedule(pin);
    if (!out || !out.ok) {
      askSched = []; draw();
      note('');
      fail('Could not load the schedule. Unlock the desk and try again.');
      return;
    }
    askSched = (out.rows || []).map(askSchedRow);
    dirty = false; closeArmed = false;
    draw(); note('');
  };

  const save = async () => {
    fail(''); note('Saving…');
    /* Blank rows are dropped rather than rejected — the RPC skips them too, and
       failing the whole save over a row the owner has not filled in yet would
       throw away the edits they did make. `id` goes back UNCHANGED so the
       server updates in place and each row keeps its own timer. */
    const payload = askSched
      .filter(r => r.prompt.trim())
      .slice(0, ASK_SCHED_MAX)
      .map(r => ({
        id: r.id, prompt: r.prompt.trim().slice(0, 500), cadence: r.cadence,
        everyHours: r.everyHours, atHour: r.atHour, atMin: r.atMin,
        marketOnly: r.marketOnly, enabled: r.enabled,
      }));
    const out = await deskSetAskSchedule(pin, payload);
    if (!out || !out.ok) {
      note('');
      fail('Could not save the schedule — nothing was changed. Check the desk is unlocked and try again.');
      return;
    }
    await load();                 /* re-read: new rows come back with their ids */
    note('Saved');
  };

  const add = document.getElementById('askSchedAdd');
  const saveBtn = document.getElementById('askSchedSave');
  const close = document.getElementById('askSchedCloseBtn');
  /* Assigned, not addEventListener'd: the modal reopens with a fresh `pin` and
     a fresh draft each time, and a second listener would run against the first
     open's closure. */
  if (add) {
    add.onclick = () => {
      if (askSched.length >= ASK_SCHED_MAX) { fail(`Ten scheduled questions is the limit — each firing costs real quota.`); return; }
      fail('');
      askSched.push(askSchedRow({ cadence: 'daily', atHour: 8, atMin: 0, enabled: true }));
      touch(); draw();
      const inputs = list.querySelectorAll('.ask-sched-q');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
  }
  if (saveBtn) saveBtn.onclick = () => save();
  if (close) {
    /* Two-stage rather than a discard-confirm dialog: the roster is small and
       the cost of losing an edit is retyping it, but losing it SILENTLY is the
       part that reads as a bug. */
    close.onclick = () => {
      if (dirty && !closeArmed) {
        closeArmed = true;
        note('Unsaved changes — press Save, or ✕ again to discard', true);
        return;
      }
      back.hidden = true;
    };
  }

  back.hidden = false;
  load();
}

function renderAsk() {
  const body = document.getElementById('askBody');
  const lampEl = document.getElementById('askLamp');
  while (body.firstChild) body.removeChild(body.firstChild);

  if (DESK.mode === 'demo') {
    lampEl.className = 'lamp lamp--demo'; lampEl.textContent = 'Demo';
    body.appendChild(el('p', 'lock-explain',
      'Ask Claude about anything on this page — positions, moves, headlines. The window unlocks with the desk PIN in live mode; demo data has nothing private to discuss.'));
    return;
  }
  if (!DESK.authed) {
    lampEl.className = 'lamp lamp--locked'; lampEl.textContent = 'Locked';
    body.appendChild(el('p', 'lock-explain', 'Unlocks with the desk PIN.'));
    return;
  }

  lampEl.className = 'lamp lamp--live'; lampEl.textContent = 'Live';
  const pin = sessionStorage.getItem('desk_pin');

  const toolbar = el('div', 'ask-toolbar');
  const clearBtn = el('button', 'ask-clear', 'Clear'); clearBtn.type = 'button'; clearBtn.hidden = true;
  clearBtn.setAttribute('aria-label', 'Clear the saved conversation');
  toolbar.appendChild(clearBtn);
  const thread = el('div', 'ask-thread');
  const form = document.createElement('form');
  form.className = 'lock-form'; form.setAttribute('autocomplete', 'off');
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'input'; input.maxLength = 500;
  input.placeholder = 'Ask about your desk…';
  input.setAttribute('aria-label', 'Ask the desk assistant a question');
  const btn = el('button', 'btn', 'Ask'); btn.type = 'submit';
  /* Stop (owner request 2026-08-01). A SEPARATE button rather than the Ask
     button changing role: a control that swaps what it does under the cursor is
     how a stop gets pressed as a re-send, and the desk-ask tool loop can run
     long enough (up to 12 tool calls) that the owner is reaching for it while
     the page is still settling. Hidden, not disabled, when idle — an always-on
     Stop with nothing to stop is noise. */
  const stopBtn = el('button', 'btn btn-secondary ask-stop', 'Stop'); stopBtn.type = 'button';
  stopBtn.hidden = true;
  stopBtn.setAttribute('aria-label', 'Stop waiting for the current answer');
  stopBtn.title = 'Stop waiting for this answer';
  stopBtn.addEventListener('click', () => { if (askAbort) askAbort.abort(); });
  /* Verify (owner request 2026-08-05). Arms the server's grounding check for
     the NEXT question only — it re-reads the answer against the quote and
     technicals payloads that produced it and forces a rewrite of anything
     those payloads don't support.
     It is off by default and DISARMS ITSELF after each answer, at the owner's
     request, because the check costs real Claude quota on every question it
     runs on. A toggle that stayed on would quietly bill every follow-up, and
     the owner would find out from the invoice rather than the interface.
     It resets on a delivered ANSWER only — not on an error or a Stop. Nothing
     was checked in those cases, the owner is about to re-send, and silently
     dropping the arm between the failure and the retry is how a deliberate
     choice gets lost. */
  let askVerify = false;
  const verifyBtn = el('button', 'btn btn-secondary ask-verify', '✓ Verify'); verifyBtn.type = 'button';
  verifyBtn.setAttribute('aria-pressed', 'false');
  verifyBtn.setAttribute('aria-label', 'Verify the next answer against its data');
  verifyBtn.title = 'Check the next answer against the quotes and technicals behind it. Costs extra; turns itself off afterwards.';
  const setVerify = (on) => {
    askVerify = on;
    verifyBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  verifyBtn.addEventListener('click', () => setVerify(!askVerify));
  /* ⏱ beside ⚙ — same idiom, same place. Opens the schedule roster. */
  const schedBtn = el('button', 'btn btn-secondary ask-sched-btn', '⏱'); schedBtn.type = 'button';
  schedBtn.setAttribute('aria-label', 'Scheduled questions');
  schedBtn.title = 'Questions the desk asks itself on a schedule — it runs with this page shut';
  schedBtn.addEventListener('click', () => openAskSched(pin));
  const sysBtn = el('button', 'btn btn-secondary', '⚙'); sysBtn.type = 'button';
  sysBtn.setAttribute('aria-label', 'Edit the Ask-the-desk system prompt');
  sysBtn.addEventListener('click', () => openSysPromptModal(pin));
  const err = el('p', 'lock-error', ''); err.hidden = true;
  form.appendChild(input); form.appendChild(btn); form.appendChild(stopBtn); form.appendChild(verifyBtn); form.appendChild(schedBtn); form.appendChild(sysBtn);
  body.appendChild(toolbar); body.appendChild(thread); body.appendChild(form); body.appendChild(err);
  body.appendChild(el('p', 'ai-disclaimer',
    'The desk assistant researches the web and pulls live quotes, and gives directional views on your own positions. AI-generated; can make mistakes. Not financial advice.'));

  /* sources footer (FR-TR2): web citations rendered as safe links (textContent) */
  const appendSources = sources => {
    if (!sources || !sources.length) return;
    const foot = el('div', 'ask-sources');
    sources.slice(0, 6).forEach(s => {
      if (!s || !s.url) return;
      /* only http(s) — never let a javascript:/data: URL from a web result
         (or tampered memory row) become a clickable href */
      let href = null;
      try { const u = new URL(s.url); if (u.protocol === 'https:' || u.protocol === 'http:') href = u.href; } catch { /* not a URL */ }
      if (!href) return;
      const link = document.createElement('a');
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = s.title || s.url;
      foot.appendChild(link);
    });
    if (foot.childElementCount) thread.appendChild(foot);
  };

  /* replay the stored conversation on load (FR-MEM5). Hold input until the
     replay settles: a question submitted mid-hydration would append above the
     replayed history and land the transcript out of chronological order. */
  input.disabled = true; btn.disabled = true;
  deskChatHistory(pin).then(rows => {
    (rows || []).forEach(r => {
      thread.appendChild(el('p', 'ask-q', r.question));
      thread.appendChild(el('p', 'ask-a', r.answer));
      appendSources(r.sources);
    });
    clearBtn.hidden = !(rows && rows.length);
    thread.scrollTop = thread.scrollHeight;
  }).catch(() => {}).finally(() => {
    input.disabled = false; btn.disabled = false;
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Clear the entire saved conversation? This permanently deletes all stored history.')) return;
    clearBtn.disabled = true;
    const out = await deskChatClear(pin).catch(() => ({ ok: false }));
    clearBtn.disabled = false;
    if (out && out.ok) { while (thread.firstChild) thread.removeChild(thread.firstChild); clearBtn.hidden = true; }
  });

  /* ONE send path for a typed question and a scheduled one. They differ only in
     where the text came from and whether the question line is marked, so
     sharing this keeps a scheduled answer identical to a typed one in the
     thread, in desk_chat_memory, and in how failures surface. */
  async function runAsk(q, { scheduled = false } = {}) {
    if (!q || askBusy) return;
    askBusy = true;
    err.hidden = true;
    /* The composer STAYS ENABLED while a question is in flight (owner request
       2026-08-01). Disabling it was the old way of saying "busy", but it also
       took away the one thing someone reaching for Stop wants next: typing the
       question they meant. askBusy still guards against a second send. */
    btn.disabled = true; btn.textContent = 'Asking…';
    askAbort = new AbortController();
    stopBtn.hidden = false;
    const qEl = el('p', 'ask-q' + (scheduled ? ' ask-q--sched' : ''), q);
    /* Marked so the owner can tell at a glance what they asked from what the
       desk asked on their behalf — otherwise a scheduled answer reads as a
       question they forgot writing. */
    if (scheduled) qEl.title = 'Asked automatically on a schedule';
    thread.appendChild(qEl);
    thread.scrollTop = thread.scrollHeight;
    /* Read once, here, so a mid-flight toggle can't change what THIS question
       was sent with — the arm the owner set when they pressed Ask is the arm
       that applies to the answer they get back. */
    const verifyThis = askVerify;
    const res = await deskAsk(pin, q, buildAskContext(), askAbort.signal, verifyThis)
      .catch(e => (e && e.name === 'AbortError')
        ? { ok: false, stopped: true }
        : { ok: false, error: 'Could not reach the ask service — try again in a moment.' });
    btn.disabled = false; btn.textContent = 'Ask'; input.disabled = false;
    stopBtn.hidden = true;
    askAbort = null;
    askBusy = false;
    if (res && res.ok) {
      thread.appendChild(el('p', 'ask-a', res.answer));
      appendSources(res.sources);
      clearBtn.hidden = false;
      /* Disarm on a delivered answer — see the note where the button is built. */
      if (verifyThis) setVerify(false);
      if (!scheduled) input.value = '';
    } else if (res && res.stopped) {
      /* Not an error line — the owner did this on purpose, and a red error for
         a deliberate act reads as a fault. It is also NOT silent: the run keeps
         going on the server, so the answer lands in desk_chat_memory and WILL
         replay on the next reload. Saying so here is the only thing that stops
         that looking like a bug later. */
      const note = el('p', 'ask-a ask-a--stopped', 'Stopped. The desk finishes this one anyway — its answer will appear in the history on your next reload.');
      note.title = 'Stopping ends the wait in this tab; it cannot call back a question already sent.';
      thread.appendChild(note);
      clearBtn.hidden = false;
    } else {
      err.textContent = (res && res.error) || 'Something went wrong — try again.';
      err.hidden = false;
    }
    thread.scrollTop = thread.scrollHeight;
    return res;
  }
  askRun = runAsk;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    await runAsk(q);
    input.focus();
  });
}

/* Ask-the-desk system prompt (desk_009) — an on-demand modal (owner request
   2026-07-23) opened via the ⚙ trigger at the far right of the Ask button
   (see renderAsk()). Editable immediately on open; Save & exit saves via
   desk_set_system_prompt and closes, ✕/backdrop close without saving.
   desk-ask reads this table live on every question, so a saved edit takes
   effect on the very next question — no code change or redeploy needed. */
const SYS_PROMPT_MAX = 20000;   // matches desk_set_system_prompt's left(new_content, 20000) cap
function updateSysPromptCounter() {
  const textEl = document.getElementById('sysPromptText');
  const counter = document.getElementById('sysPromptCounter');
  const left = SYS_PROMPT_MAX - textEl.value.length;
  counter.textContent = left.toLocaleString() + ' characters left';
  counter.classList.toggle('sys-prompt-counter--low', left < 1000);
}
function closeSysPromptModal() {
  document.getElementById('sysPromptBackdrop').hidden = true;
}
async function openSysPromptModal(pin) {
  const backdrop = document.getElementById('sysPromptBackdrop');
  const textEl = document.getElementById('sysPromptText');
  const stamp = document.getElementById('sysPromptStamp');
  const err = document.getElementById('sysPromptErr');
  err.hidden = true;
  backdrop.hidden = false;
  textEl.value = 'Loading…'; textEl.disabled = true;
  const out = await deskGetSystemPrompt(pin);
  textEl.disabled = false;
  if (!out.ok) {
    textEl.value = '';
    err.textContent = 'Could not load the system prompt — try again.'; err.hidden = false;
    updateSysPromptCounter();
    return;
  }
  textEl.value = out.content;
  stamp.textContent = out.updatedAt ? 'Saved ' + fmtClock(out.updatedAt) : '—';
  updateSysPromptCounter();
  textEl.focus();
}
function wireSysPromptModal() {
  const backdrop = document.getElementById('sysPromptBackdrop');
  const textEl = document.getElementById('sysPromptText');
  const stamp = document.getElementById('sysPromptStamp');
  const err = document.getElementById('sysPromptErr');
  const submitBtn = document.getElementById('sysPromptSubmit');

  textEl.addEventListener('input', updateSysPromptCounter);
  document.getElementById('sysPromptCloseBtn').addEventListener('click', () => closeSysPromptModal());
  backdrop.addEventListener('mousedown', ev => { if (ev.target === backdrop) closeSysPromptModal(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !backdrop.hidden) closeSysPromptModal(); });

  submitBtn.addEventListener('click', async () => {
    const content = textEl.value.trim();
    if (!content) { err.textContent = 'System prompt can’t be empty.'; err.hidden = false; return; }
    if (!confirm('This changes how Ask-the-desk behaves for every future question. Save?')) return;
    const pin = sessionStorage.getItem('desk_pin');
    submitBtn.disabled = true;
    const out = await deskSetSystemPrompt(pin, content);
    submitBtn.disabled = false;
    if (!out.ok) { err.textContent = 'Could not save — try again.'; err.hidden = false; return; }
    if (out.updatedAt) stamp.textContent = 'Saved ' + fmtClock(out.updatedAt);
    closeSysPromptModal();
  });
}

/* ── locked state (live mode, pre-auth) ────────────────────────────────── */
/* The desk is unlocked but the accounts payload did not arrive (Codex review,
   PR #201). Deliberately NOT the lock gate: the PIN is valid, so asking for it
   again is both wrong and useless. Retry re-runs the fetch with the PIN already
   held for this session. No balances are drawn, because there are none to draw. */
function renderAccountsUnavailable() {
  const grid = document.getElementById('accountGrid');
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const panel = el('section', 'panel panel-lock');
  const head = el('div', 'panel-header');
  head.appendChild(el('h3', 'panel-title', 'Accounts'));
  head.appendChild(el('span', 'lamp ml-auto lamp--stale', 'Unavailable'));
  panel.appendChild(head);
  const body = el('div', 'panel-body');
  body.appendChild(el('p', 'lock-explain',
    'Your PIN worked — the desk just could not load your accounts. Everything else on the page is unaffected.'));
  const btn = el('button', 'btn', 'Retry');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    const pin = sessionStorage.getItem('desk_pin');
    if (!pin) return;
    btn.disabled = true; btn.textContent = 'Loading…';
    await loadPrivate(pin);
    /* On success loadPrivate has replaced this panel; on failure it re-rendered
       a fresh one, so this node is gone either way — nothing to restore. */
  });
  body.appendChild(btn);
  panel.appendChild(body);
  grid.appendChild(panel);
}

/* `why` (optional): shown in place of the generic explainer when the panel is
   locked for a reason other than the desk simply being locked. */
function renderLockedPanels(why) {
  const grid = document.getElementById('accountGrid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const lockPanel = el('section', 'panel panel-lock');
  const head = el('div', 'panel-header');
  head.appendChild(el('h3', 'panel-title', 'Accounts'));
  head.appendChild(el('span', 'lamp ml-auto lamp--locked', 'Locked'));
  lockPanel.appendChild(head);
  const body = el('div', 'panel-body');
  body.appendChild(el('p', 'lock-explain', why ||
    'Account balances and charts are private — enter the desk PIN to unlock.'));
  const form = document.createElement('form');
  form.className = 'lock-form'; form.setAttribute('autocomplete', 'off');
  const input = document.createElement('input');
  input.type = 'password'; input.inputMode = 'numeric'; input.className = 'input';
  input.placeholder = 'Desk PIN'; input.setAttribute('aria-label', 'Desk PIN');
  const btn = el('button', 'btn', 'Unlock');
  btn.type = 'submit';
  const err = el('p', 'lock-error', ''); err.hidden = true;
  form.appendChild(input); form.appendChild(btn);
  body.appendChild(form); body.appendChild(err);
  lockPanel.appendChild(body);
  grid.appendChild(lockPanel);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Checking…';
    const res = await deskLogin(input.value).catch(() => ({ ok: false, error: 'Could not reach the data service — try again in a moment.' }));
    btn.disabled = false; btn.textContent = 'Unlock';
    if (res && res.ok) {
      sessionStorage.setItem('desk_pin', input.value);
      DESK.authed = true;
      await loadPrivate(input.value);
      renderMasthead();
      /* the watchlist's ✎ is gated on DESK.authed, and the panel already
         rendered while locked — re-render so unlocking reveals it without a
         reload (Codex review, PR #188) */
      renderWatchlist();
    } else {
      err.textContent = (res && res.error) || 'PIN not recognized — try again.';
      err.hidden = false;
    }
  });

  /* ask panel shows a locked shell; the system-prompt modal only ever opens
     from an authed Ask-the-desk trigger, so just make sure it's not stuck open */
  renderAsk();
  closeSysPromptModal();
}

/* ── S&P 500 heatmap (squarified treemap) ──────────────────────────────────
   Size = market cap, color = day % on a diverging ramp with a NEUTRAL slate
   midpoint (dataviz rule); gain/loss hues are P&L semantics here, not
   decoration. The panel is a deliberate dark inset (finviz-parity, owner
   request 2026-07-11): saturated poles on slate, white ink ≥3:1 across the
   whole ramp. CVD/contrast relief: printed labels + movers table. */
const HEAT = {
  /* finviz's published 7-stop map scale (legend: −3…+3), interpolated
     piecewise so small moves already carry color — a straight slate→pole
     lerp leaves sub-1% movers gray, which is why the panel read muted
     next to finviz (owner screenshot comparison, 2026-07-12). */
  stops: [
    [-3, [246, 53, 56]],   /* #F63538 */
    [-2, [191, 64, 69]],   /* #BF4045 */
    [-1, [139, 68, 78]],   /* #8B444E */
    [0, [65, 69, 84]],     /* #414554 slate — 0% */
    [1, [53, 118, 78]],    /* #35764E */
    [2, [47, 158, 79]],    /* #2F9E4F */
    [3, [48, 204, 90]],    /* #30CC5A */
  ],
  cap: 3,                    /* the stop DOMAIN (±3) — legend/tiles scale to activeCap below */
  canvas: '#262931',         /* mosaic backdrop */
  label: '#CBD2DE',          /* sector/band captions on the dark canvas */
  band: '#31353F',           /* sub-industry band fill */
  focus: '#FDE047',          /* hover outline for the industry group */
  ink: '#FFFFFF',            /* tile label ink — consistently white (owner, 2026-07-12) */
  halo: '#23262D',           /* solid stroke behind every glyph; white-vs-halo is the AA pair */
};

/* Color scale cap is PER-UNIVERSE (owner ruling 2026-07-14): large caps use
   the finviz-standard ±3%; small caps (Russell 2000) move far harder — a ±3%
   cap saturates ~26% of tiles, so they use ±5% (median mover still tinted,
   only the ~11% tail clips). The 7 stops always span [−activeCap, +activeCap];
   a pct is normalized into the stops' ±3 domain before interpolation. */
let activeCap = HEAT.cap;
function heatRGB(pct) {
  const s = HEAT.stops;
  const norm = pct * HEAT.cap / activeCap;        /* map ±activeCap → the ±3 stop domain */
  const p = Math.max(s[0][0], Math.min(s[s.length - 1][0], norm));
  let i = 0;
  while (i < s.length - 2 && p > s[i + 1][0]) i++;
  const [p0, c0] = s[i], [p1, c1] = s[i + 1];
  const t = (p - p0) / (p1 - p0);
  return c0.map((c, k) => Math.round(c + (c1[k] - c) * t));
}
const heatColor = pct => 'rgb(' + heatRGB(pct).join(',') + ')';
const HEAT_CAP_FOR = key => (key === 'r2k' ? 5 : HEAT.cap);
/* Tile labels are consistently WHITE (owner directive 2026-07-12 — the earlier
   per-tile black flip on bright poles read inconsistent next to finviz). AA is
   carried by a solid dark halo painted under every glyph (paint-order:stroke),
   exactly finviz's trick: the glyph's contrast pair is ink-vs-halo (15.9:1),
   independent of tile color. check-contrast.js asserts that pair. */
const heatText = (attrs, fs) => svgEl('text', {
  ...attrs, fill: HEAT.ink, stroke: HEAT.halo, 'paint-order': 'stroke',
  /* halo stays a shadow, not an outline: ~1px at small sizes, capped so
     display-size tickers don't read as cartoon-stroked */
  'stroke-width': Math.min(1.8, Math.max(0.8, fs / 12)).toFixed(2), 'stroke-linejoin': 'round',
});
const fmtCap = v => v >= 1e12 ? '$' + (v / 1e12).toFixed(1) + 'T' : v >= 1e9 ? '$' + Math.round(v / 1e9) + 'B' : '$' + Math.round(v / 1e6) + 'M';
const fmtPrice = v => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';

/* Squarified treemap (Bruls et al.): items [{value}] DESC → rects. */
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, it) => s + it.value, 0) || 1;
  const scale = (w * h) / total;
  const out = [];
  let row = [], rowSum = 0, i = 0;
  const worst = (sum, min, max, side) => {
    const s2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };
  const layoutRow = () => {
    const horiz = w < h;                       /* lay along the shorter side */
    const side = horiz ? w : h;
    const thick = (rowSum * scale) / side;
    let off = 0;
    for (const it of row) {
      const len = (it.value * scale) / thick;
      out.push(horiz
        ? { ...it, x: x + off, y, w: len, h: thick }
        : { ...it, x, y: y + off, w: thick, h: len });
      off += len;
    }
    if (horiz) { y += thick; h -= thick; } else { x += thick; w -= thick; }
  };
  while (i < items.length) {
    const it = { ...items[i], value: items[i].value * 1 };
    const side = Math.min(w, h);
    const areas = row.map(r => r.value * scale);
    const cur = row.length
      ? worst(rowSum * scale, Math.min(...areas), Math.max(...areas), side) : Infinity;
    const nextSum = rowSum + it.value;
    const nextAreas = [...areas, it.value * scale];
    const nxt = worst(nextSum * scale, Math.min(...nextAreas), Math.max(...nextAreas), side);
    if (row.length && nxt > cur) { layoutRow(); row = []; rowSum = 0; }
    else { row.push(it); rowSum = nextSum; i++; }
  }
  if (row.length) layoutRow();
  return out;
}

let heatState = null;   /* last-rendered data, so a resize can re-render */

/* Canvas height that lets a panel sit within the viewport with a half-inch gap
   all around (owner request 2026-07-18: "shorten the chart to fit my screen
   minus 1/2 inch all around, resize the heatmap to the same measurements").
   We MEASURE the panel's non-canvas chrome (everything above + below the SVG:
   header, toolbar, per-pane bars, caption, padding) rather than guess it, then
   size the canvas to fill the rest of `viewport − 1in`. Because each panel's
   total = canvas + its own chrome = (vh − 1in − chrome) + chrome = vh − 1in,
   the stochastic-charts panel and the heatmap panel end up the exact same outer
   height — and both full-width with the same 0.5in inset, so identical boxes.
   The chrome offsets are independent of the SVG's current height, so measuring
   the live (even placeholder-sized) SVG is safe. Both renderers re-run on
   resize, so this re-fits live; clamped for tiny laptops / tall monitors. */
const DESK_VMARGIN = 96;   /* 0.5in top + 0.5in bottom */
/* Owner 2026-07-19: run the panels TALLER than the viewport-fit base — the
   stochastic chart by 2in, the heatmap by 1in (96px = 1in). They no longer
   match; both now extend past one screen and scroll. */
const DESK_CHART_BOOST = 96;    /* +1in on the stochastic chart (owner request 2026-07-24, was +2in) */
const DESK_HEAT_BOOST = 96;     /* +1in on the heatmap */
const DESK_HEAT_LENGTHEN = 1.1; /* +10% heatmap length (owner request 2026-07-21) */
function deskChartHeight(svg) {
  const vh = window.innerHeight || 800;
  let chrome = 320;   /* fallback if the panel isn't laid out yet */
  const panel = svg && svg.closest('.area-charts, .heat-panel');
  if (panel) {
    const pr = panel.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    const above = sr.top - pr.top;        /* header + toolbar + pane bars */
    const below = pr.bottom - sr.bottom;  /* caption + panel padding */
    if (above >= 0 && below >= 0) chrome = above + below;
  }
  /* Clamp the OUTER panel height — a viewport-only target both panels share — so
     the two boxes stay identical even at the clamp bounds (a per-canvas clamp
     would leave panels with different chrome at different outer heights). Each
     panel then subtracts its own chrome; the canvas floor only guards a
     pathologically short window. */
  const outer = Math.max(560, Math.min(vh - DESK_VMARGIN, 1000));
  return Math.max(260, outer - chrome);
}

function renderHeatmap(hm, lamp) {
  heatState = { hm, lamp };
  activeCap = (hm && hm.scaleCap) || HEAT.cap;   /* per-universe color scale */
  const svg = document.getElementById('heatmapSvg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const lampEl = document.getElementById('heatLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  /* Heatmap tiles ARE price data, so they get the same price-bound treatment as
     the Markets panel: a live delay figure while the session is open, "at close"
     once it shuts (owner ruling 2026-07-28) — otherwise the two panels would
     disagree about the same closing prices. */
  applyLampStamp(
    document.getElementById('heatStamp'),
    hm ? liveLampFor(hm.generatedAt, hm.asOf, true) : null,
  );
  if (!hm || !hm.sectors || !hm.sectors.length) {
    document.getElementById('heatSource').textContent = 'No heatmap in the latest snapshot — it fills in after the next refresh.';
    return;
  }
  /* Render at the container's true pixel size (the panel now spans the full
     width): 1 viewBox unit = 1 rendered px, so label px thresholds are honest
     and text isn't stretched by aspect mismatch. */
  /* Populate the legend BEFORE measuring the chrome — it sits below the canvas,
     and an empty legend row would under-measure the panel on the first render,
     leaving the heatmap a touch too tall to match the chart (Codex #131). */
  renderHeatLegend();
  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 1200));
  const H = Math.round((deskChartHeight(svg) + DESK_HEAT_BOOST) * DESK_HEAT_LENGTHEN);   /* viewport-fit + 1in, +10% length (owner 2026-07-21) */
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.style.height = H + 'px';
  const HEAD = 16, BAND = 11;
  const tip = document.getElementById('heatTip');
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: HEAT.canvas }));

  /* shared tile bevel: a corner-weighted vignette (clear center → shaded
     rim; r=70.7% puts the full shade exactly at the corners). Text-safe on
     every tile because glyph contrast is carried by the label halo, not the
     tile fill (see heatText). */
  const defs = svgEl('defs', {});
  const gloss = svgEl('radialGradient', { id: 'heatGloss', r: '70.7%' });
  for (const [off, op] of [[0, 0], [0.72, 0], [1, 0.16]]) {
    gloss.appendChild(svgEl('stop', { offset: off, 'stop-color': '#000000', 'stop-opacity': op }));
  }
  defs.appendChild(gloss);
  svg.appendChild(defs);

  /* hover chrome (appended last so it paints above the tiles): a yellow
     outline around the hovered stock's whole industry group + a white
     outline on the tile itself — the finviz interaction. */
  const sectorGeo = new Map();   /* sector name → full rect, for the sector-wide focus frame */
  const sectorHead = new Map();  /* sector name → {rect, text} header strip, lit on hover */
  let litHead = null;
  const focusGroup = svgEl('rect', { fill: 'none', stroke: HEAT.focus, 'stroke-width': 2, rx: 2, visibility: 'hidden', 'pointer-events': 'none' });
  const focusTile = svgEl('rect', { fill: 'none', stroke: '#FFFFFF', 'stroke-width': 1.5, rx: 2, visibility: 'hidden', 'pointer-events': 'none' });
  const unlightHead = () => {
    if (!litHead) return;
    litHead.rect.setAttribute('fill', '#1E2129');
    litHead.text.setAttribute('fill', '#D9DEE8');
    litHead = null;
  };

  /* finviz-style hover card: SECTOR header, the hovered stock in bold with
     last price + full name, then EVERY stock in the sector by cap. */
  const showPeers = (t, sector, px, py) => {
    /* new sector under the pointer ⇒ scroll the peer list back to the top
       (moving between tiles of the SAME sector keeps the reading position) */
    const sectorChanged = tip._sectorShown !== sector.name;
    tip._sectorShown = sector.name;
    unlightHead();
    const head = sectorHead.get(sector.name);   /* light the whole sector's header strip */
    if (head) {
      head.rect.setAttribute('fill', HEAT.focus);
      head.text.setAttribute('fill', '#111111');
      litHead = head;
    }
    const g = sectorGeo.get(sector.name);        /* frame the WHOLE sector */
    if (g) {
      focusGroup.setAttribute('x', g.x + 1); focusGroup.setAttribute('y', g.y + 1);
      focusGroup.setAttribute('width', Math.max(g.w - 2, 1)); focusGroup.setAttribute('height', Math.max(g.h - 2, 1));
      focusGroup.setAttribute('visibility', 'visible');
    }
    focusTile.setAttribute('x', t.x + 1); focusTile.setAttribute('y', t.y + 1);
    focusTile.setAttribute('width', Math.max(t.w - 2, 1)); focusTile.setAttribute('height', Math.max(t.h - 2, 1));
    focusTile.setAttribute('visibility', 'visible');

    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('div', 'tip-head', sector.name.toUpperCase()));
    const dir = p => p > 0 ? 'up' : p < 0 ? 'down' : '';
    const cur = el('div', 'tip-main');
    cur.appendChild(el('span', 'tip-sym', t.sym));
    if (Number.isFinite(t.last)) cur.appendChild(el('span', 'tip-price ' + dir(t.pct), fmtPrice(t.last)));
    cur.appendChild(el('span', dir(t.pct), fmtPct(t.pct)));
    tip.appendChild(cur);
    /* Post-market print (owner request 2026-07-30). It goes in the TOOLTIP, not
       on the tile: ~2000 tiles means a tile is a few pixels tall at the tail and
       a second number simply will not fit. The TINT also stays keyed to the
       regular day-% — re-tinting only the names that happen to have an
       after-hours trade would make the map compare two different measurements
       side by side, which is the whole failure mode this desk keeps fixing.
       Re-tinting the WHOLE map by extended % is a separate control, not built. */
    if (t.extPct != null) {
      const x = el('div', 'tip-ext');
      x.appendChild(el('span', 'tip-ext-tag', 'After hours'));
      if (Number.isFinite(t.extLast)) x.appendChild(el('span', 'tip-price ' + dir(t.extPct), fmtPrice(t.extLast)));
      x.appendChild(el('span', dir(t.extPct), fmtPct(t.extPct)));
      tip.appendChild(x);
    }
    tip.appendChild(el('div', 'tip-name', (t.name && t.name !== t.sym ? t.name + ' · ' : '') + fmtCap(t.cap)));
    /* EVERY member of the hovered SECTOR (owner ruling 2026-07-14, extended
       to the whole sector) — the tip scrolls when the list outgrows its max
       height */
    const peers = sector.tiles.slice().sort((a, b) => b.cap - a.cap);
    for (const p of peers) {
      const row = el('div', 'tip-row' + (p.sym === t.sym ? ' tip-cur' : ''));
      row.appendChild(el('span', '', p.sym));
      row.appendChild(el('span', 'tip-price', Number.isFinite(p.last) ? fmtPrice(p.last) : ''));
      row.appendChild(el('span', dir(p.pct), fmtPct(p.pct)));
      tip.appendChild(row);
    }
    tip.style.display = 'block';
    if (sectorChanged) tip.scrollTop = 0;
    const wrap = svg.parentElement.getBoundingClientRect();
    const sx = wrap.width / W, sy = wrap.height / H;
    /* The card lists the WHOLE sector and frames the whole sector group, so it
       must sit OUTSIDE that sector's box — otherwise it buries the very tiles
       the reader is trying to pick (right-edge sectors like Energy). Anchor to
       the sector's right edge; flip to the left of its left edge when the card
       would overrun the container. Measured width beats the old fixed clamp,
       which pinned the card back over right-hand sectors. */
    const gap = 8;
    const tipW = tip.offsetWidth;
    const secRight = (g ? g.x + g.w : t.x + t.w) * sx;
    const secLeft = (g ? g.x : t.x) * sx;
    let left = secRight + gap;
    if (left + tipW > wrap.width) {
      const flipped = secLeft - gap - tipW;
      left = flipped >= 0 ? flipped : Math.max(0, wrap.width - tipW);
    }
    tip.style.left = left + 'px';
    tip.style.top = Math.min(Math.max(py * sy - 8, 0), wrap.height - 40) + 'px';
  };
  const hideHover = () => {
    tip.style.display = 'none';
    tip.scrollTop = 0;
    tip._sectorShown = null;
    unlightHead();
    focusGroup.setAttribute('visibility', 'hidden');
    focusTile.setAttribute('visibility', 'hidden');
  };
  /* leaving a tile schedules the hide instead of firing it, so the pointer
     can travel INTO the tip and wheel-scroll the full peer list. State
     lives ON the tip element: the listeners are wired once, but hideHover
     is a fresh closure every render. */
  tip._hide = hideHover;
  const scheduleHide = () => { clearTimeout(tip._hideTimer); tip._hideTimer = setTimeout(hideHover, 140); };
  if (!tip.dataset.wired) {
    tip.dataset.wired = '1';
    tip.addEventListener('pointerenter', () => clearTimeout(tip._hideTimer));
    tip.addEventListener('pointerleave', () => { if (tip._hide) tip._hide(); });
  }

  const drawTiles = (tiles, x, y, w, h, sector) => {
    for (const t of squarify(tiles.map(t => ({ ...t, value: t.cap })), x, y, w, h)) {
      if (t.w < 3 || t.h < 3) continue;
      const geo = { x: t.x + 1, y: t.y + 1, width: Math.max(t.w - 2, 1), height: Math.max(t.h - 2, 1), rx: 2 };
      const rect = svgEl('rect', { ...geo, fill: heatColor(t.pct) });
      svg.appendChild(rect);
      svg.appendChild(svgEl('rect', { ...geo, fill: 'url(#heatGloss)', 'pointer-events': 'none' }));

      /* finviz label scaling: the ticker grows to fill its tile (mega-caps read
         from across the room), tiny tiles still print at 6px. Bold sans glyphs
         run ~0.60em wide. The halo carries glyph contrast on any fill, so the
         bevel overlay is text-safe and every threshold can run tight. */
      const fs = Math.min(t.h * 0.46, (t.w - 6) / (t.sym.length * 0.64), 38);
      if (fs >= 6) {
        const pfs = Math.max(6, Math.round(fs * 0.42));
        const withPct = fs >= 8 && t.h >= fs + pfs + 7 && t.w >= 30;
        const cy = t.y + t.h / 2;
        const symY = withPct ? cy - 1 : cy + fs * 0.36;
        const sym = heatText({ x: t.x + t.w / 2, y: symY, 'text-anchor': 'middle', 'font-size': fs.toFixed(1), 'font-weight': '700', 'font-family': 'var(--font-sans)' }, fs);
        sym.textContent = t.sym;
        svg.appendChild(sym);
        if (withPct) {
          const pctEl = heatText({ x: t.x + t.w / 2, y: cy + pfs + 2, 'text-anchor': 'middle', 'font-size': pfs, 'font-family': 'var(--font-mono)' }, pfs);
          pctEl.textContent = fmtPct(t.pct);
          svg.appendChild(pctEl);
        }
      }
      rect.addEventListener('pointerenter', () => { clearTimeout(tip._hideTimer); showPeers(t, sector, t.x + t.w, t.y); });
      rect.addEventListener('pointerleave', scheduleHide);
    }
  };

  const sectorRects = squarify(hm.sectors.map(s => ({ ...s, value: s.cap })), 0, 0, W, H);
  for (const s of sectorRects) {
    if (s.w < 4 || s.h < HEAD + 6) continue;
    sectorGeo.set(s.name, { x: s.x, y: s.y, w: s.w, h: s.h });
    if (s.w > 64 && s.h > 40) {
      /* solid header strip (finviz) instead of a floating caption */
      const headRect = svgEl('rect', { x: s.x + 1, y: s.y + 1, width: Math.max(s.w - 2, 1), height: HEAD - 2, fill: '#1E2129' });
      svg.appendChild(headRect);
      const label = svgEl('text', { x: s.x + 5, y: s.y + 12, fill: '#D9DEE8', 'font-size': '10', 'font-weight': '600', 'font-family': 'var(--font-sans)', 'letter-spacing': '.05em' });
      label.textContent = s.name.toUpperCase().slice(0, Math.floor(s.w / 7));
      svg.appendChild(label);
      sectorHead.set(s.name, { rect: headRect, text: label });
    }
    const body = { x: s.x, y: s.y + HEAD, w: s.w, h: s.h - HEAD };

    /* finviz-style sub-industry nesting when the sector has room + data */
    const byInd = new Map();
    for (const t of s.tiles) {
      const k = t.ind || '';
      if (!byInd.has(k)) byInd.set(k, []);
      byInd.get(k).push(t);
    }
    const groups = [...byInd.entries()].map(([ind, tiles]) => ({
      ind, tiles, cap: tiles.reduce((c, t) => c + t.cap, 0),
    }));
    if (groups.length > 1 && groups.every(g => g.ind) && body.h > 76 && body.w > 100) {
      for (const g of squarify(groups.map(g => ({ ...g, value: g.cap })), body.x, body.y, body.w, body.h)) {
        const hasBand = g.w > 58 && g.h > 40;
        if (hasBand) {
          const bandRect = svgEl('rect', { x: g.x + 1, y: g.y + 1, width: Math.max(g.w - 2, 1), height: BAND, fill: HEAT.band });
          svg.appendChild(bandRect);
          const bl = svgEl('text', { x: g.x + 4, y: g.y + 9, fill: HEAT.label, 'font-size': '7', 'font-weight': '600', 'font-family': 'var(--font-sans)', 'letter-spacing': '.04em' });
          bl.textContent = g.ind.toUpperCase().slice(0, Math.floor(g.w / 5));
          svg.appendChild(bl);
        }
        drawTiles(g.tiles, g.x, g.y + (hasBand ? BAND + 1 : 0), g.w, g.h - (hasBand ? BAND + 1 : 0), s);
      }
    } else {
      drawTiles(s.tiles, body.x, body.y, body.w, body.h, s);
    }
  }
  svg.appendChild(focusGroup);
  svg.appendChild(focusTile);
  renderHeatTable(hm);   /* legend was rendered up-front, before the measure */
}

function renderHeatLegend() {
  const lg = document.getElementById('heatLegend');
  while (lg.firstChild) lg.removeChild(lg.firstChild);
  /* 13 swatches evenly across the active cap so the ramp reads the same
     width whether the cap is 3 or 5 (only the end labels change) */
  const STEPS = 12;
  lg.appendChild(el('span', '', '−' + activeCap + '%'));
  for (let k = 0; k <= STEPS; k++) {
    const sw = el('span', 'swatch');
    sw.style.background = heatColor(-activeCap + (2 * activeCap) * k / STEPS);
    lg.appendChild(sw);
  }
  lg.appendChild(el('span', '', '+' + activeCap + '%'));
  lg.appendChild(el('span', '', '· tile size = market cap'));
}

function renderHeatTable(hm) {
  const table = document.getElementById('heatTable');
  while (table.firstChild) table.removeChild(table.firstChild);
  const movers = hm.sectors.flatMap(s => s.tiles.map(t => ({ ...t, sector: s.name })))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 12);
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const name of ['Symbol', 'Sector', 'Last', 'Mkt cap', 'Day %']) {
    const th = document.createElement('th'); th.textContent = name; th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const m of movers) {
    const tr = document.createElement('tr');
    for (const [text, cls] of [[m.sym, ''], [m.sector, ''], [Number.isFinite(m.last) ? fmtPrice(m.last) : '—', ''], [fmtCap(m.cap), ''], [fmtPct(m.pct), m.pct > 0 ? 'up' : m.pct < 0 ? 'down' : '']]) {
      const td = document.createElement('td'); td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

/* ── MAP FILTER bar (finviz-parity; owner request 2026-07-13) ─────────────
   Roster cuts derive from data already on hand: index rosters and theme
   baskets intersect the S&P dataset (config/map-filters.json, owner-editable).
   Russell 2000 and ETFs are each their own desk-heatmap universe — r2k the
   screener's small-cap band (owner request 2026-07-14), ETFs the etfCats
   roster (2026-08-06, replacing a client-side build off the charts payload
   that could only draw the 25 of 40 names that panel happened to carry).
   Every cut carries pctW/pctM/pctYtd from the feed's daily 1y sweep, so the
   period dropdown works wherever those fields are present. */
const MAP_CUTS = [
  ['sp500', 'S&P 500', 'live'],
  ['dj30', 'Dow Jones 30', 'roster'],
  ['ndx100', 'Nasdaq 100', 'roster'],
  ['etf', 'ETFs', 'live'],
  ['themes', 'Themes', 'roster'],
  ['world', 'World', 'extra'],
  ['crypto', 'Crypto', 'extra'],
  ['futures', 'Futures', 'extra'],
  ['r2k', 'Russell 2000', 'r2k'],
];
const MAP_PERIODS = [['1d', '1-Day Performance'], ['1w', '1-Week Performance'], ['1m', '1-Month Performance'], ['ytd', 'YTD Performance']];
let heatBase = null;                        /* raw dataset + lamp from loadHeatmap */

/* Shared live first-load fast retry (owner ruling 2026-07-22: real data or
   nothing — so an empty panel must refetch promptly, not sit blank until the
   5/60-min poller). Visibility-aware backoff 15s → 30s → 60s cap: a hidden tab
   defers the refetch to the next visibilitychange (Codex #148/#150). One state
   object per feed; `landed()` reports whether real data arrived meanwhile. */
function armLiveRetry(st, retryFn, landed) {
  st.wait = Math.min(60000, (st.wait || 7500) * 2);
  clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    if (!document.hidden) { if (!landed()) retryFn(); return; }
    const once = () => {
      document.removeEventListener('visibilitychange', once);
      if (!document.hidden && !landed()) retryFn();
    };
    document.addEventListener('visibilitychange', once);
  }, st.wait);
}
const heatRetry = {}, chartsRetry = {}, marketRetry = {}, newsRetry = {};
let heatExtra = null;                       /* desk-maps payload (crypto/futures/world, delayed quotes) */
let heatExtraAt = 0;                        /* fetch timestamp — refetch on cut click when stale */
let heatR2k = null;                         /* desk-heatmap universe:r2k payload + lamp */
let heatR2kAt = 0;
let heatR2kErr = false;
let heatEtf = null;                         /* desk-heatmap universe:etf payload + lamp */
let heatEtfAt = 0;
let heatEtfErr = false;
let mapView = { key: 'sp500', period: '1d', filters: null };

/* period support: '1d' always; longer periods need pctW/pctM/pctYtd on the
   tiles (feed's daily 1y sweep — absent for a few minutes after a cold
   function boot, and always absent in demo) */
const PERIOD_FIELD = { '1w': 'pctW', '1m': 'pctM', 'ytd': 'pctYtd' };
/* Unlocks 1W/1M/YTD only if some tile actually carries a usable reading.
   Sampling one tile for `pctW !== undefined` was too weak: the feed records
   symbols it could not price with a null reading, so a single null-valued
   first tile would open the dropdown onto a period that renders nothing. */
function datasetHasPeriods(hm) {
  if (!hm || !hm.sectors) return false;
  return hm.sectors.some(s => s.tiles.some(t => Number.isFinite(t.pctW)));
}
/* re-color a cut by the selected period; tiles without that period drop out */
function recolorForPeriod(hm, period) {
  if (!hm || period === '1d') return hm;
  const field = PERIOD_FIELD[period];
  const sectors = hm.sectors.map(s => {
    const tiles = s.tiles.filter(t => Number.isFinite(t[field])).map(t => ({ ...t, pct: t[field] }));
    return { name: s.name, cap: tiles.reduce((a, t) => a + t.cap, 0), tiles };
  }).filter(s => s.tiles.length);
  return { ...hm, sectors };
}

/* The ETF cut used to be assembled HERE, out of the charts workbench payload —
   which meant a tile existed only if that panel happened to carry the symbol's
   full 800-bar OHLCV series. It did not for 15 of the banded names, so the map
   drew 25 of 40 for its whole life — 20 properly banded plus 5 swept into a
   catch-all bucket, which is what hid the mismatch. It is now its own
   desk-heatmap universe, like r2k: the roster and its bands come from the one
   committed object (map-filters.json → etfCats) read on BOTH sides, and the
   periods ride the same sweep every other cut uses. */

function applyMapView() {
  if (!heatBase) return;
  const label = (MAP_CUTS.find(([k]) => k === mapView.key) || [])[1] || 'S&P 500';
  /* gate first: a period the current cut can't express falls back to 1d
     BEFORE rendering, so a cut switch never paints an empty map */
  const cutDataset = mapView.key === 'r2k' ? (heatR2k && heatR2k.hm)
    : mapView.key === 'etf' ? (heatEtf && heatEtf.hm)
      : heatBase.hm;
  /* ETFs no longer get a free pass here. The cut used to compute its own
     periods from chart bars, so it could always answer 1W/1M/YTD; now it reads
     them off the shared sweep like every other cut, and must be gated on the
     sweep having landed — otherwise picking 1M paints an empty map. */
  const multiOk = ['sp500', 'dj30', 'ndx100', 'themes', 'r2k', 'etf'].includes(mapView.key)
    && datasetHasPeriods(cutDataset);
  if (!multiOk && mapView.period !== '1d') mapView.period = '1d';
  const periodLabel = (MAP_PERIODS.find(([k]) => k === mapView.period) || [])[1] || '';
  const colored = mapView.period === '1d' ? 'day % change' : periodLabel.toLowerCase();
  let out = heatBase.hm;
  let lamp = heatBase.lamp;
  let note = 'Sized by market cap · colored by ' + colored;
  if (mapView.key === 'dj30' || mapView.key === 'ndx100') {
    const set = new Set((mapView.filters || {})[mapView.key] || []);
    const sectors = out.sectors.map(s => {
      const tiles = s.tiles.filter(t => set.has(t.sym) || set.has(t.sym.replace('.', '-')));
      return { name: s.name, cap: tiles.reduce((a, t) => a + t.cap, 0), tiles };
    }).filter(s => s.tiles.length).sort((a, b) => b.cap - a.cap);
    out = { ...out, sectors };
    note = 'Hand-kept roster ∩ dataset (' + sectors.reduce((a, s) => a + s.tiles.length, 0) + ' names) · sized by cap · ' + colored;
  } else if (mapView.key === 'etf') {
    out = heatEtf ? heatEtf.hm : null;
    lamp = heatEtf ? heatEtf.lamp : lamp;
    note = out ? 'Sized by 3-month avg dollar volume · colored by ' + colored
      : heatEtfErr ? 'ETF quotes unavailable right now — click again in a minute'
        : 'Loading the ETF map…';
  } else if (mapView.key === 'themes') {
    /* thematic regroup of the S&P dataset — rosters in config/map-filters.json */
    const themes = (mapView.filters || {}).themes || {};
    const bySym = new Map();
    for (const s of heatBase.hm.sectors) for (const t of s.tiles) bySym.set(t.sym, t);
    const sectors = Object.entries(themes).map(([name, syms]) => {
      const tiles = syms.map(sym => bySym.get(sym)).filter(Boolean).map(t => ({ ...t, ind: '' }));
      return { name, cap: tiles.reduce((a, t) => a + t.cap, 0), tiles };
    }).filter(s => s.tiles.length).sort((a, b) => b.cap - a.cap);
    out = { ...heatBase.hm, sectors };
    note = 'Hand-kept theme baskets over the S&P dataset · sized by cap · ' + colored;
  } else if (mapView.key === 'r2k') {
    out = heatR2k ? heatR2k.hm : null;
    lamp = heatR2k ? heatR2k.lamp : lamp;
    note = out ? (heatR2k.hm.note || 'Small-cap band') + ' · screener sectors · sized by cap · ' + colored
      : heatR2kErr ? 'Small-cap quotes unavailable right now — click again in a minute'
      : 'Loading small caps…';
  } else if (mapView.key === 'crypto' || mapView.key === 'futures' || mapView.key === 'world') {
    const cut = heatExtra && heatExtra.cuts && heatExtra.cuts[mapView.key];
    /* the stamp carries the fetch time (local zone) — this cut is delayed-live, not EOD */
    out = cut ? { asOf: fmtStampDateTime(heatExtra.generatedAt), sectors: cut.sectors } : null;
    lamp = cut ? { cls: 'lamp--live', text: 'LIVE' } : lamp;
    note = cut ? 'Hand-weighted tiles (config/map-filters.json) · delayed quotes · day % change'
      : heatExtraErr ? 'Delayed quotes unavailable right now — click again in a minute'
      : 'Loading delayed quotes…';
  }
  /* stock cuts re-color by period from the feed's pctW/pctM/pctYtd fields
     (the ETF cut computes its own periods from bar history above) */
  if (mapView.key !== 'etf') out = recolorForPeriod(out, mapView.period);
  if (out) out.scaleCap = HEAT_CAP_FOR(mapView.key); /* small caps get the wider ±5% ramp */
  document.getElementById('heatTitle').textContent = 'Heatmap — ' + label;
  renderHeatmap(out, lamp);
  document.getElementById('heatSource').textContent = note;
  /* period choices: ETFs always (own history); stock cuts once the feed's
     period sweep has landed; extras (delayed spot quotes) stay 1-day */
  const sel = document.getElementById('heatPeriod');
  for (const opt of sel.options) opt.disabled = !multiOk && opt.value !== '1d';
  sel.value = mapView.period;
}

function wireMapFilter() {
  const nav = document.getElementById('mapFilterNav');
  for (const [key, label, kind] of MAP_CUTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-filter-btn';
    b.textContent = label;
    b.setAttribute('aria-current', String(key === mapView.key));
    if (kind === 'extra' || kind === 'r2k') {
      b.disabled = true;                       /* enabled in live mode (loadHeatmap) */
      b.title = 'Loads delayed quotes when the desk is live';
      b.dataset.extra = '1';
      b.addEventListener('click', () => {
        mapView.key = key;
        for (const other of nav.children) other.setAttribute('aria-current', String(other === b));
        applyMapView();                        /* period auto-falls back if unsupported */
        if (kind === 'r2k') refreshR2kMap();
        else refreshExtraMaps();               /* re-pull if the 2-min window lapsed */
      });
    } else {
      b.addEventListener('click', () => {
        mapView.key = key;
        for (const other of nav.children) other.setAttribute('aria-current', String(other === b));
        applyMapView();
        /* Fetched on click, not on load — same reasoning as the extra cuts: a
           feed error at paint would trip the S1 console gate, and most sessions
           never open this cut. In demo the call is a no-op and the dataset is
           already seeded. */
        if (key === 'etf') refreshEtfMap();
      });
    }
    nav.appendChild(b);
  }
  const sel = document.getElementById('heatPeriod');
  for (const [val, label] of MAP_PERIODS) {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = mapView.period;
  sel.addEventListener('change', () => {
    mapView.period = sel.value;
    applyMapView();
  });
}

/* Crypto/Futures/World: delayed quotes through the desk-maps edge function
   (fixed server-side roster, no PIN). Deliberately NEVER fired on page load —
   an unreachable endpoint would log a resource error and trip the S1
   console-error gate; the fetch is user-initiated (cut click) only, and
   re-fires once the function's 2-min cache window has lapsed. Failures keep
   the last good payload. */
let heatExtraErr = false;
async function refreshExtraMaps() {
  if (DESK.mode === 'demo' || !DESK_DB.url) return;
  if (heatExtra && Date.now() - heatExtraAt < 120000) return;
  try {
    const out = await deskMaps();
    if (!out.ok || !out.cuts) throw new Error(out.error || 'no cuts');
    heatExtra = out;
    heatExtraAt = Date.now();
    heatExtraErr = false;
  } catch { heatExtraErr = !heatExtra; /* keep last good */ }
  if (mapView.key === 'crypto' || mapView.key === 'futures' || mapView.key === 'world') applyMapView();
}

/* Russell 2000 cut — its own desk-heatmap universe (screener small-cap
   band, top 300). 5-min client window; the function's own session-aware
   cache does the real rate limiting. */
async function refreshR2kMap() {
  if (DESK.mode === 'demo' || !DESK_DB.url) return;
  if (heatR2k && Date.now() - heatR2kAt < 300000) return;
  try {
    const out = await deskFeed('desk-heatmap', { universe: 'r2k' });
    heatR2k = { hm: out, lamp: liveLampFor(out.generatedAt, out.asOf, true) };
    heatR2kAt = Date.now();
    heatR2kErr = false;
  } catch { heatR2kErr = !heatR2k; /* keep last good */ }
  if (mapView.key === 'r2k') applyMapView();
}

/* ETF cut — its own desk-heatmap universe. 40 names is one quote batch and one
   sweep nudge, so this converges on the first call rather than over hours like
   the stock universes. Demo mode is served locally: the cut must keep working
   under ?demo=1, and nothing may call the live feed there. */
async function refreshEtfMap() {
  if (DESK.mode === 'demo' || !DESK_DB.url) return;
  if (heatEtf && Date.now() - heatEtfAt < 300000) return;
  try {
    const out = await deskFeed('desk-heatmap', { universe: 'etf' });
    heatEtf = { hm: out, lamp: liveLampFor(out.generatedAt, out.asOf, true) };
    heatEtfAt = Date.now();
    heatEtfErr = false;
  } catch { heatEtfErr = !heatEtf; /* keep last good */ }
  if (mapView.key === 'etf') applyMapView();
}

/* Collapsed by default (owner request 2026-07-31). The gate is deliberately in
   loadHeatmap itself rather than only at the call site: the panel is refreshed
   from the poller too, and a collapsed panel must not quietly keep paying for
   the desk's heaviest feed on a timer. `force` is exempt — "Refresh now" is an
   explicit act, and an open panel is the only way to see the result anyway. */
const HM_OPEN_KEY = 'hm_open_v1';
let hmOpen = false;
try { hmOpen = localStorage.getItem(HM_OPEN_KEY) === '1'; } catch { /* private mode */ }

function renderHeatToggle() {
  const btn = document.getElementById('heatToggle');
  const body = document.getElementById('heatBody');
  if (!btn || !body) return;
  btn.textContent = hmOpen ? 'Hide' : 'Show';
  btn.setAttribute('aria-expanded', hmOpen ? 'true' : 'false');
  body.hidden = !hmOpen;
}

function wireHeatToggle() {
  const btn = document.getElementById('heatToggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    hmOpen = !hmOpen;
    try { localStorage.setItem(HM_OPEN_KEY, hmOpen ? '1' : '0'); } catch { /* private mode */ }
    renderHeatToggle();
    /* First open is what triggers the fetch — nothing was loaded while closed. */
    if (hmOpen) loadHeatmap();
  });
  renderHeatToggle();
}

async function loadHeatmap(force) {
  if (!hmOpen && !force) return;   /* collapsed → costs nothing */
  if (!mapView.filters) {
    try { mapView.filters = await fetchPublic('config/map-filters.json'); }
    catch { mapView.filters = {}; }
  }
  /* extra cuts are clickable in live mode; their data loads on first click */
  if (DESK.mode !== 'demo' && DESK_DB.url) {
    for (const b of document.querySelectorAll('.map-filter-btn[data-extra]')) {
      b.disabled = false;
      b.removeAttribute('title');
    }
  }
  if (DESK.mode !== 'demo') {
    try {
      const hm = await deskFeed('desk-heatmap', force ? { force: true } : undefined);
      clearTimeout(heatRetry.timer); heatRetry.wait = 0;
      heatBase = { hm, lamp: liveLampFor(hm.generatedAt, hm.asOf, true) };
      applyMapView();
      return;
    } catch { /* failure paths below */ }
    if (heatBase) return; /* poller failure: keep the last good map */
    /* LIVE first-load failure: real data or NOTHING (owner ruling 2026-07-22
       — the old silent buildDemoHeatmap() fallback put FABRICATED prices on a
       live desk). Blank canvas + STALE lamp + a fast retry chain (15s → 30s →
       60s cap), instead of sitting on fake tiles until the 5/60-min poller. */
    renderHeatmap(null, { cls: 'lamp--stale', text: 'STALE' });
    document.getElementById('heatSource').textContent = 'Heatmap feed unreachable — nothing shown until real data arrives. Retrying…';
    armLiveRetry(heatRetry, loadHeatmap, () => Boolean(heatBase));
    return;
  }
  heatBase = { hm: buildDemoHeatmap(), lamp: { cls: 'lamp--demo', text: 'Demo' } };
  /* The ETF cut is a live universe now, so demo has to seed it here — there is
     no charts payload for it to fall out of any more. Built from the same
     etfCats object the live roster uses (loaded just above). */
  const demoEtf = buildDemoEtfMap((mapView.filters || {}).etfCats);
  if (demoEtf) heatEtf = { hm: demoEtf, lamp: { cls: 'lamp--demo', text: 'Demo' } };
  applyMapView();
}

/* re-render the treemap at the new container size (debounced) */
let heatResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!heatState) return;
  clearTimeout(heatResizeTimer);
  heatResizeTimer = setTimeout(() => renderHeatmap(heatState.hm, heatState.lamp), 150);
});

/* ── watchlist charts (candles + volume + daily/weekly-scale stochastics) ──
   The desk's chart workbench, in the dashboard's own idiom: EOD candlesticks
   for a fixed public watchlist, classic floor-trader pivots from the prior
   calendar month, and the reference terminal's slow stochastics — STOCH
   (14-3-3 daily) and WSTOCH (92-15-15 weekly-scale, both on daily bars; see
   data.js for how they were fitted). Candle green/red is price-direction
   semantics (like the heatmap), not decoration. */
/* %K red / %D yellow mirror the reference terminal's stochastic indicator colors
   (owner request 2026-07-22, "identical to theirs"). These are dedicated
   indicator-palette hexes, NOT the P&L --color-loss/gain tokens — the red here is
   a chart-series color, not a P&L signal; red-vs-yellow stays CVD-distinguishable
   by lightness. */
/* res/sup/piv are chart-native hexes, NOT page tokens, for the same reason
   kLine/dLine are: the page palette is tuned for dark ink on cream, and this
   pane's canvas is black, so --color-accent (#96610F) and --color-gain
   (#177C4B) render muddy on it. They are also deliberately not the gain/loss
   tokens — support/resistance is a charting semantic, not P&L. */
const WB = { up: 'var(--color-gain)', down: 'var(--color-loss)', kLine: '#e23b3b', dLine: '#f5c518', grid: 'var(--color-border)', label: 'var(--color-text-secondary)', canvas: 'var(--color-bg)', band: 'var(--color-loss)', res: '#FF9F0A', sup: '#32D74B', piv: '#FFD60A' };
/* Strip captions derived from the live STOCH/WSTOCH/ISTOCH settings so the
   label can never disagree with the math (e.g. "STOCH 14-3-3"). All are
   defined in data.js, which loads first; these run at render time. */
const stochTagOf = c => `STOCH ${c.k}-${c.kSmooth}-${c.d}`;
function stochTag() { return stochTagOf(STOCH); }
function stochWTag() { return stochTagOf(WSTOCH); }
const WB_ZOOMS = [['1M', 21], ['3M', 63], ['6M', 126], ['YTD', 'ytd'], ['1Y', 252], ['All', 9999]];
const WB2_ZOOMS = [['1M', 21], ['3M', 63], ['6M', 126], ['YTD', 'ytd'], ['1Y', 252], ['All', 9999]];  /* Pro 2 window, in daily bars — Pro 2 now plots daily candles (daily+weekly stoch), not weekly */

/* per-pane configuration (their settings menu, in our idiom) — persisted */
const WB_CFG_KEY = 'wb_cfg_v3';   /* v3: dual-timeframe stochastic on by default (owner ruling 2026-07-14) */
/* stochW = the higher-timeframe stochastic overlay. Owner ruling 2026-07-17
   dropped multi-year cycles to mirror the reference terminal exactly:
   Pro 1 = daily stoch ONLY, Pro 2 = daily candles with daily+WEEKLY stoch,
   Pro 3 = intraday stoch ONLY. The overlay now lives on Pro 2 alone (weekly);
   Pro 1/Pro 3 render no overlay regardless of this flag. */
const WB_CFG_DEFAULT = () => ({
  p1: { type: 'candle', bb: false, vol: true, stoch: true, stochW: true, smas: { 1: false, 25: true, 50: true, 100: false, 200: false }, sr: { 1: true, 2: false, 3: true }, scrollLock: false },
  /* stochSteady: confine candle-colour changes to STEADY_BAND — a crossover
     inside 30–80 turns the colour, one out in the extremes does not (owner
     ruling 2026-08-05). Off by default — see the gear popover and the drawPane
     comment, which also records why a separation threshold was rejected. */
  p2: { type: 'candle', bb: false, vol: true, stoch: true, stochW: true, stochSteady: false, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, scrollLock: false },
  /* Pro 3 = day trading: Bollinger Bands on by default, slim settings (owner ruling).
     ext = show the 4:00am–8:00pm ET extended session (owner request 2026-07-29).
     On by default; turning it off restores the exact regular-session bar set the
     ISTOCH 10-3-3 fit was established against, for terminal parity. */
  p3: { type: 'candle', bb: true, vol: true, stoch: true, stochW: true, ext: true, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, scrollLock: false },
});
function loadWbCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(WB_CFG_KEY));
    if (raw && raw.p1 && raw.p2) {
      /* older stored shapes lack newer keys — deep-merge over defaults */
      const def = WB_CFG_DEFAULT();
      for (const k of ['p1', 'p2', 'p3']) {
        const d = def[k], r = raw[k] || {};
        raw[k] = {
          ...d, ...r,
          smas: { ...d.smas, ...(r.smas || {}) },
          sr: { ...d.sr, ...(r.sr || {}) },
        };
      }
      return raw;
    }
  } catch { /* fall through */ }
  return WB_CFG_DEFAULT();
}
function saveWbCfg() {
  try { localStorage.setItem(WB_CFG_KEY, JSON.stringify(wbState.cfg)); } catch { /* storage unavailable — session-only */ }
}

/* Sticky manual entries: the ad-hoc tickers a user types (loaded via
   quote-proxy) plus their last-viewed symbol persist across reloads, so the
   workbench reopens on the same chart. syms is re-fetched on boot and merged
   into the watchlist feed; sel restores the selection. */
const WB_STICKY_KEY = 'wb_sticky_v1';
const wbFeedRoster = new Set();  /* symbols served by the desk-charts feed; anything else is a manual entry */
let wbStickyRestored = false;    /* one-shot: restore runs on the first LIVE feed, even after a demo-fallback reload */
let wbUserPicked = false;        /* the user has chosen a symbol → a slow background restore must not override it */
const wbZoomOrNull = (v, zooms) => (zooms.some(([, spec]) => spec === v) ? v : null);
function readWbSticky() {
  try {
    const raw = JSON.parse(localStorage.getItem(WB_STICKY_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        syms: Array.isArray(raw.syms) ? raw.syms.filter((s) => typeof s === 'string' && s).slice(0, 12) : [],
        sel: typeof raw.sel === 'string' ? raw.sel : '',
        /* Per-pane SPAN, sticky across reloads (owner request 2026-08-09: the
           panes reset to 3M/6M on every refresh). Validated against the pane's
           own preset list rather than trusted: this is localStorage, and an
           arbitrary number here would size a window the seg has no button for,
           leaving every preset unpressed and the pane at a width nothing in the
           UI can explain. An unrecognised value simply falls back to the
           built-in default. */
        z1: wbZoomOrNull(raw.z1, WB_ZOOMS),
        z2: wbZoomOrNull(raw.z2, WB2_ZOOMS),
      };
    }
  } catch { /* corrupt or absent */ }
  return { syms: [], sel: '' };
}
function writeWbSticky(patch) {
  const next = { ...readWbSticky(), ...patch };
  try { localStorage.setItem(WB_STICKY_KEY, JSON.stringify(next)); } catch { /* storage unavailable — session-only */ }
}
function addWbStickySym(sym) {
  const syms = [sym, ...readWbSticky().syms.filter((s) => s !== sym)].slice(0, 12);
  writeWbSticky({ syms });
}
/* single choke point for switching the active symbol: resets pan, remembers
   the selection so it sticks across reloads, and repaints */
function wbPick(sym) {
  wbUserPicked = true;
  wbState.sym = sym;
  wbState.off = wbState.woff = wbState.off3 = wbState.off3d = 0;
  /* re-pin any non-watchlist pick so an evicted manual ticker is refetched on
     the next reload (also bumps it to the front of the capped list) */
  if (wbFeedRoster.size && !wbFeedRoster.has(sym)) addWbStickySym(sym);
  writeWbSticky({ sel: sym });
  renderCharts(wbState.data, wbState.lamp);
}
/* Typeahead roster (owner request 2026-07-16): a curated set of popular
   tickers + names the symbol box suggests as you type, merged at match time
   with the live watchlist. Ticker OR name substring both match ("apple" → AAPL,
   "XL" → the sectors). Any ticker is still loadable by typing it in full. */
const WB_TICKERS = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['GOOGL', 'Alphabet'],
  ['AMZN', 'Amazon'], ['META', 'Meta Platforms'], ['TSLA', 'Tesla'], ['AVGO', 'Broadcom'],
  ['BRK.B', 'Berkshire Hathaway'], ['JPM', 'JPMorgan Chase'], ['V', 'Visa'], ['MA', 'Mastercard'],
  ['UNH', 'UnitedHealth'], ['XOM', 'Exxon Mobil'], ['JNJ', 'Johnson & Johnson'], ['WMT', 'Walmart'],
  ['LLY', 'Eli Lilly'], ['HD', 'Home Depot'], ['PG', 'Procter & Gamble'], ['COST', 'Costco'],
  ['NFLX', 'Netflix'], ['AMD', 'AMD'], ['INTC', 'Intel'], ['CRM', 'Salesforce'],
  ['BAC', 'Bank of America'], ['KO', 'Coca-Cola'], ['PEP', 'PepsiCo'], ['DIS', 'Disney'],
  ['MCD', "McDonald's"], ['CVX', 'Chevron'], ['ORCL', 'Oracle'], ['ADBE', 'Adobe'],
  ['QCOM', 'Qualcomm'], ['TXN', 'Texas Instruments'], ['BA', 'Boeing'], ['GS', 'Goldman Sachs'],
  ['PFE', 'Pfizer'], ['NKE', 'Nike'], ['C', 'Citigroup'], ['F', 'Ford'],
  ['SPY', 'S&P 500 ETF'], ['QQQ', 'Nasdaq 100 ETF'], ['DIA', 'Dow Jones ETF'], ['IWM', 'Russell 2000 ETF'],
  ['VOO', 'Vanguard S&P 500'], ['VTI', 'Total Market'], ['SMH', 'Semiconductors'], ['GLD', 'Gold'],
  ['SLV', 'Silver'], ['TLT', '20+ Yr Treasury'], ['HYG', 'High-Yield Bonds'],
  ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLE', 'Energy'], ['XLI', 'Industrials'],
  ['XLB', 'Materials'], ['XLV', 'Health Care'], ['XLY', 'Consumer Disc.'], ['XLP', 'Consumer Staples'],
  ['XLU', 'Utilities'], ['XLRE', 'Real Estate'], ['XLC', 'Communication'],
];
const SMA_COLORS = { 1: 'var(--color-text-primary)', 25: 'var(--color-series-3)', 50: 'var(--color-accent-bright)', 100: 'var(--color-series-2)', 200: 'var(--color-text-secondary)' };
const ytdBars = bars => { const y = bars.t[bars.t.length - 1].slice(0, 4); let n = 0; for (let i = bars.t.length - 1; i >= 0 && bars.t[i].slice(0, 4) === y; i--) n++; return Math.max(n, 5); };
const paneWindow = (spec, bars) => spec === 'ytd' ? ytdBars(bars) : spec;
let wbState = null;   /* { data, lamp, sym, days, wdays, off, woff, layout, cfg } */

/* drag-to-pan lives at window level so the SVG rebuild mid-drag (each pan
   frame re-renders) can't drop the pointer stream */
let wbDrag = null, wbPanRaf = 0;
const wbIntradayPending = new Set();   /* Pro 3 intraday fetches in flight */
const INTRADAY_TTL_MS = 60_000;        /* max age of a cached 5-min snapshot before the forming-candle graft refetches it */
/* symbol → { at, info } — info is null for a known miss. The TIMESTAMP is
   load-bearing (owner report 2026-07-31): this used to be a bare symbol→info
   map keyed only on presence, so the first fetch of a symbol was the LAST one
   for the life of the tab. A desk left open overnight kept showing the previous
   session's quote — SMH read "538.90 +34.68 (+6.88%)", which was Jul 30's close
   and Jul 30's move, while the tape had it at 544.91 +6.01 (+1.12%) — and the
   panel stamp said "delayed by 1 minute", because that stamp tracks the BAR
   feed, not this quote. A stale price under a fresh stamp is the worst of both. */
const wbInfoCache = {};
const wbInfoPending = new Set();       /* per-symbol info fetches in flight */
/* This is a live price line, not just fundamentals, so it expires on the same
   cadence the market tiles do: 1 min while prints are arriving (open session,
   settle grace, or post-market), 15 min once the tape is frozen. */
const wbInfoTtlMs = () =>
  (marketSessionOpen() || withinCloseSettleGrace() || postMarketOpen()) ? 60_000 : 900_000;
const wbRealSyms = new Set();          /* symbols backed by REAL data (live desk-charts feed or an
                                          ad-hoc quote-proxy load) — fundamentals show only for these,
                                          never for the synthetic demo-fallback watchlist */
const MIN_NAV_WIN = 20;   /* smallest window the navigator can shrink to (bars) */
window.addEventListener('pointermove', ev => {
  if (!wbDrag || !wbState) return;
  if (wbDrag.resize === 'stochSplit') {
    /* the divider BETWEEN the daily and weekly strips: dragging down grows the
       daily strip and shrinks the weekly by the same amount (total constant,
       price pane untouched), clamped so neither strip drops below min. */
    const dy = (ev.clientY - wbDrag.startY) * wbDrag.scaleY;
    const d = Math.round(Math.max(-(wbDrag.startH - wbDrag.min), Math.min(wbDrag.startWH - wbDrag.min, dy)));
    if (wbDrag.cfg.stochH !== wbDrag.startH + d || wbDrag.cfg.stochWH !== wbDrag.startWH - d) {
      wbDrag.cfg.stochH = wbDrag.startH + d;
      wbDrag.cfg.stochWH = wbDrag.startWH - d;
      cancelAnimationFrame(wbPanRaf);
      wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
    }
    return;
  }
  if (wbDrag.resize) {   /* vertical drag: resize the volume / stochastic pane */
    const dy = (ev.clientY - wbDrag.startY) * wbDrag.scaleY;
    const nv = Math.round(Math.max(wbDrag.min, Math.min(wbDrag.max, wbDrag.startH - dy)));
    const key = { vol: 'volH', stoch: 'stochH', stochW: 'stochWH' }[wbDrag.resize];
    if (wbDrag.cfg[key] !== nv) {
      wbDrag.cfg[key] = nv;
      cancelAnimationFrame(wbPanRaf);
      wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
    }
    return;
  }
  if (wbDrag.mode) {   /* range-navigator drag (resize handles or pan the window) */
    const d = wbDrag;
    const delta = Math.round((ev.clientX - d.x0) / d.pxPerBar);
    let i0 = d.i0Start, end = d.endStart;
    if (d.mode === 'navLeft') i0 = Math.max(0, Math.min(d.endStart - MIN_NAV_WIN, d.i0Start + delta));
    else if (d.mode === 'navRight') end = Math.min(d.len, Math.max(d.i0Start + MIN_NAV_WIN, d.endStart + delta));
    else { i0 = Math.max(0, Math.min(d.len - d.nStart, d.i0Start + delta)); end = i0 + d.nStart; }
    const win = end - i0, off = d.len - end;
    if (wbState[d.daysKey] !== win || wbState[d.navKey] !== off) {
      wbState[d.daysKey] = win; wbState[d.navKey] = off;
      cancelAnimationFrame(wbPanRaf);
      wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
    }
    return;
  }
  const next = Math.min(wbDrag.max, Math.max(0, wbDrag.off0 + Math.round((ev.clientX - wbDrag.x0) / wbDrag.slotPx)));
  if (next !== wbState[wbDrag.key]) {
    wbState[wbDrag.key] = next;
    cancelAnimationFrame(wbPanRaf);
    wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
  }
});
/* pointercancel (e.g. a touch drag the browser reclaims for scroll) must end the
   drag exactly like pointerup, or the workbench sticks in resize mode and the new
   height is never persisted (Codex #114). touch-action:none on the hit rects keeps
   a vertical drag from being stolen in the first place. */
const endWbDrag = () => { if (wbDrag && wbDrag.resize) saveWbCfg(); wbDrag = null; };
window.addEventListener('pointerup', endWbDrag);
window.addEventListener('pointercancel', endWbDrag);

/* mouse-wheel zoom: scroll over a pane to expand/contract its range-navigator
   window (owner request 2026-07-17). Wheel up = zoom IN (contract the window),
   wheel down = zoom OUT (expand), anchored on the right (latest) edge. Reads the
   per-pane geometry renderCharts stashes on wbState.paneGeom. */
window.addEventListener('wheel', ev => {
  if (wbDrag || !wbState || !wbState.paneGeom) return;
  const svg = document.getElementById('wbChart');
  if (!svg || !svg.contains(ev.target)) return;
  const box = svg.getBoundingClientRect();
  if (!box.width) return;
  const vx = (ev.clientX - box.left) * (wbState.viewW / box.width);
  const g = wbState.paneGeom.find(p => vx >= p.x0 && vx <= p.x1);
  if (!g || !g.bars || !g.bars.c) return;
  if (g.cfg && g.cfg.scrollLock) return;   /* locked: let the wheel scroll the page instead */
  ev.preventDefault();
  const len = g.bars.c.length;
  const curN = Math.min(paneWindow(wbState[g.daysKey], g.bars), len);
  const nw = Math.max(MIN_NAV_WIN, Math.min(len, Math.round(curN * (ev.deltaY < 0 ? 0.82 : 1.22))));
  if (nw !== curN) {
    wbState[g.daysKey] = nw;
    cancelAnimationFrame(wbPanRaf);
    wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
  }
}, { passive: false });

/* reflect the live window in the preset segs — a navigator-set custom range
   matches no preset, so all three clear; a preset value lights its button */
function syncZoomPressed() {
  if (!wbState) return;
  for (const [id, zooms, val] of [['chartZoom', WB_ZOOMS, wbState.days], ['chartZoom2', WB2_ZOOMS, wbState.wdays]]) {
    const seg = document.getElementById(id);
    if (!seg || !seg.children.length) continue;
    [...seg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(zooms[i] && zooms[i][1] === val)));
  }
}

/* scroll-zoom lock button per pane (owner request 2026-07-23): pressed =
   mouse-wheel over that pane scrolls the page instead of resizing its
   range-navigator window (see the window 'wheel' handler). */
function syncLockPressed() {
  if (!wbState) return;
  for (const k of ['p1', 'p2', 'p3']) {
    const b = document.getElementById('wbLock-' + k);
    if (!b) continue;
    const locked = !!wbState.cfg[k].scrollLock;
    b.setAttribute('aria-pressed', String(locked));
    b.textContent = locked ? '🔒' : '🔓';
  }
}

const fmtVol = v => v >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'K';

/* Classic pivots from the prior calendar month's H/L/C of the daily series. */
function monthlyPivots(s) {
  const lastMonth = s.t[s.t.length - 1].slice(0, 7);
  let hi = -Infinity, lo = Infinity, close = null, seen = false;
  for (let i = s.t.length - 1; i >= 0; i--) {
    const m = s.t[i].slice(0, 7);
    if (m === lastMonth) continue;
    if (!seen) { seen = true; close = s.c[i]; }
    else if (s.t[i].slice(0, 7) !== s.t[i + 1].slice(0, 7)) break; /* left prior month */
    hi = Math.max(hi, s.h[i]); lo = Math.min(lo, s.l[i]);
  }
  if (!seen || !Number.isFinite(hi)) return [];
  const p = (hi + lo + close) / 3;
  return [
    ['R3', hi + 2 * (p - lo)], ['R2', p + (hi - lo)], ['R1', 2 * p - lo],
    ['P', p], ['S1', 2 * p - hi], ['S2', p - (hi - lo)], ['S3', lo - 2 * (hi - p)],
  ];
}

/* Doctrine signal markers on a stochastic series: a BUY is %K crossing up
   through %D from at/below the oversold band; a SELL is the top-roll — %K
   crossing down through %D from at/above the overbought band. (strategies/
   stochastic-investing.md — the cycle anatomy.) */
/* Weekly-timeframe stochastic — the reference terminal's "weekly" is a
   SCALED-PERIOD DAILY stochastic (92-15-15 slow on daily bars, WSTOCH in
   data.js), NOT one computed on weekly bars. Established 2026-07-22 by fitting
   the terminal's hover readouts on live INTC data: three independent anchors
   (Jan 12, Jan 28, Apr 15 2026), all 12 daily+weekly values reproduced to
   ±0.02 — and neighboring parameter sets show clear error gradients, so the
   fit is not coincidental. This supersedes the weekly-bar attempts (Codex #134
   period-scaling worry, step-holding, interpolation, week-to-date): the
   terminal IS the definition here, and the big windows also give the smooth
   daily-updating texture its weekly band shows. */
const weeklyStochOnDaily = daily => stochSeries(daily, WSTOCH);

/* The zone a crossover has to land in before the Pro 2 candle colour follows
   it, when steady mode is armed (owner ruling 2026-08-05): inside the band it
   acts, out in the extremes it is ignored. Matches the 30–80 band this pane's
   own weekly strip already draws, so the colour rule and the visible band never
   disagree about where overbought starts. See drawPane. */
const STEADY_BAND = [30, 80];

/* Doctrine circles OFF for now (owner request 2026-07-24) — flip true to
   bring them back; stochMarks() below still computes them either way. */
const SHOW_DOCTRINE_MARKS = false;

function stochMarks(st, os = 20, ob = 80) {
  const buys = [], sells = [];
  for (let i = 1; i < st.k.length; i++) {
    if (st.k[i] == null || st.d[i] == null || st.k[i - 1] == null || st.d[i - 1] == null) continue;
    /* buy: %K up through %D with BOTH at/below the oversold band; sell: the
       top-roll — down through %D AND dropping OUT of the overbought band
       (an embedded cross that stays pinned above the band is trend, not a
       sell). Bands parameterized: daily/intraday use 20/80, the weekly-scale
       strip 30/80 (its drawn oversold band). */
    /* The circle marks whichever of the two bars %K/%D actually sit closer
       together on (owner report 2026-07-23) — the discrete cross test only
       tells us the ORDER flipped between i-1 and i, not which one the lines
       visually touch at; on a steep move the flip bar can already show a
       wide gap while the true near-touch was the bar before. Numerically
       verified: on a synthetic 300-bar series the naive "always bar i"
       placement landed on the FARTHER bar in ~2/3 of detected crosses. */
    const closer = (i0, i1) => Math.abs(st.k[i0] - st.d[i0]) <= Math.abs(st.k[i1] - st.d[i1]) ? i0 : i1;
    if (st.k[i - 1] <= st.d[i - 1] && st.k[i] > st.d[i] && st.k[i - 1] <= os && st.d[i - 1] <= os) buys.push(closer(i - 1, i));
    if (st.k[i - 1] >= st.d[i - 1] && st.k[i] < st.d[i] && st.d[i - 1] >= ob && st.k[i] < ob) sells.push(closer(i - 1, i));
  }
  return { buys, sells };
}

/* Pinned/embedded read on the last bars of a stochastic (trend strength,
   not a sell — the doctrine's exception). */
function stochPinned(st, band = 80, bars = 4) {
  const k = st.k.filter(v => v != null);
  if (k.length < bars) return null;
  const tail = k.slice(-bars);
  if (tail.every(v => v >= band)) return 'PINNED OVERBOUGHT';
  if (tail.every(v => v <= 100 - band)) return 'PINNED OVERSOLD';
  return null;
}

/* ── per-symbol fundamentals strip (earnings date + key stats) ─────────────
   Live-only: fetched on demand through quote-proxy (kind:'info' → Yahoo
   v7/quote). Cached per symbol for the tab session; demo shows a placeholder. */
const wbFmtCap = n => {
  const a = Math.abs(n);
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(0) + 'M';
  return '$' + Math.round(n).toLocaleString();
};
const startOfDay = ms => { const x = new Date(ms); x.setHours(0, 0, 0, 0); return x.getTime(); };
function fmtEarnings(ts, estimate) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const days = Math.round((startOfDay(d.getTime()) - startOfDay(Date.now())) / 86400000);
  let rel, warn = false;
  if (days > 1) { rel = 'in ' + days + 'd'; warn = days <= 7; }
  else if (days === 1) { rel = 'tomorrow'; warn = true; }
  else if (days === 0) { rel = 'today'; warn = true; }
  else { rel = 'reported'; }
  return { text: label + ' · ' + rel + (estimate ? ' · est.' : ''), warn };
}
/* Fundamentals show only for a symbol whose CHART DATA is real — the live
   desk-charts feed or an ad-hoc quote-proxy load. This gates per symbol, not
   on the panel lamp: during a desk-charts outage the watchlist falls back to
   synthetic demo bars (Demo lamp), but a ticker the user loads by hand is still
   real and must show its stats (never mix real stats over synthetic bars). */
const wbSymLive = sym => DESK.mode !== 'demo' && !!DESK_DB.url && wbRealSyms.has(sym);
function maybeFetchWbInfo(sym, force) {
  if (!wbSymLive(sym)) return;
  if (wbInfoPending.has(sym)) return;
  const hit = wbInfoCache[sym];
  /* Age, not presence. `force` is the masthead "Refresh now" button, which must
     bypass this cache for the same reason it bypasses the feeds' — it is the
     escape hatch for exactly the state where the owner does not trust what is
     on screen. */
  if (!force && hit && Date.now() - hit.at < wbInfoTtlMs()) return;
  wbInfoPending.add(sym);
  deskQuote(sym, 'info', false, force ? { force: true } : undefined)
    .then(out => { wbInfoCache[sym] = { at: Date.now(), info: (out && out.ok && out.info) ? out.info : null }; })
    /* Keep the last good reading on a failed refresh rather than blanking a
       populated strip, but stamp it so the next tick retries instead of
       treating the failure as a fresh answer. */
    .catch(() => { wbInfoCache[sym] = { at: Date.now(), info: hit ? hit.info : null }; })
    .finally(() => {
      wbInfoPending.delete(sym);
      /* Re-render (not just renderWbInfo) so the chart height re-fits: the
         fundamentals strip can wrap onto extra rows on a narrow viewport,
         changing the toolbar chrome after the canvas was sized (Codex #131).
         Recursion-safe — sym is now cached, so maybeFetchWbInfo early-returns. */
      if (wbState && wbState.sym === sym) renderCharts(wbState.data, wbState.lamp);
    });
}
function renderWbInfo() {
  const box = document.getElementById('wbInfo');
  if (!box || !wbState) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  const muted = text => { const s = el('span', 'wb-info-muted', text); box.appendChild(s); };
  const item = (label, value, cls) => {
    const span = el('span', 'wb-info-item' + (cls ? ' ' + cls : ''));
    span.appendChild(el('b', '', label));
    span.appendChild(document.createTextNode(value));
    box.appendChild(span);
  };
  const sym = wbState.sym;
  const live = wbSymLive(sym);
  const info = live && wbInfoCache[sym] ? wbInfoCache[sym].info : undefined;

  /* Quote readout — the terminal top line (owner request 2026-07-16): last ·
     change (change%) · Bid · Ask · Diff, before the earnings/stats. Last +
     change come from the live quote when we have it, else the chart's own last
     two bars so demo (and the pre-fetch instant) still shows a price. Bid/Ask/
     Diff are live- AND market-hours-only — Yahoo returns 0 when closed, so they
     appear only when real. */
  const bars = wbState.data.symbols[sym];
  let last = null, chg = null, chgPct = null, bid = null, ask = null;
  if (info && info.price != null) {
    last = info.price; chg = info.change; chgPct = info.changePct; bid = info.bid; ask = info.ask;
  } else if (bars && bars.c.length > 1) {
    const n = bars.c.length;
    last = bars.c[n - 1];
    chg = bars.c[n - 1] - bars.c[n - 2];
    chgPct = (bars.c[n - 1] / bars.c[n - 2] - 1) * 100;
  }
  if (last != null) {
    const dir = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    /* symbol ahead of price (owner request 2026-07-23) — the readout otherwise
       opened on a bare number with no ticker to anchor it */
    box.appendChild(el('span', 'wb-info-item wb-quote-sym', sym));
    /* Full name beside the ticker (owner request 2026-08-05). The name has
       always been in the quote payload and was simply never drawn, so this
       costs no extra fetch. It sits AFTER the symbol and BEFORE the price so
       the ticker still anchors the line — the reason the symbol was put first
       in the first place — and it is muted so it reads as a label rather than
       competing with the numbers.
       It renders only when the name differs from the ticker: for a symbol the
       feed has no name for, Yahoo echoes the ticker back, and printing "IYT
       IYT 86.71" would look like a bug. */
    if (info && info.name && info.name.toUpperCase() !== sym.toUpperCase()) {
      box.appendChild(el('span', 'wb-info-item wb-quote-name', info.name));
    }
    box.appendChild(el('span', 'wb-info-item wb-quote-last', fmtPrice(last)));
    if (chg != null) {
      const sign = chg > 0 ? '+' : '';
      box.appendChild(el('span', 'wb-info-item wb-quote-chg ' + dir,
        sign + fmtPrice(chg) + ' (' + sign + (chgPct == null ? '0.00' : chgPct.toFixed(2)) + '%)'));
    }
    if (bid != null && bid > 0) item('Bid', fmtPrice(bid));
    if (ask != null && ask > 0) item('Ask', fmtPrice(ask));
    if (bid != null && bid > 0 && ask != null && ask > 0) item('Diff', fmtPrice(ask - bid));
    /* After-hours print, on its own marked line rather than replacing the last
       (Codex review, PR #199): the regular close and the extended price are two
       different facts, and overwriting one with the other is how a tile ends up
       showing an unattributed number. Absent means "did not trade after hours",
       never 0. The % is already prior-close based server-side, so it is
       directly comparable with the change above it. */
    if (info && info.extPrice != null) {
      const ep = info.extPct;
      const esign = ep > 0 ? '+' : '';
      box.appendChild(el('span', 'wb-info-item wb-quote-ext',
        'AFTER HRS ' + fmtPrice(info.extPrice) +
        (ep == null ? '' : ' (' + esign + ep.toFixed(2) + '%)')));
    }
  }

  if (!live) { muted('Earnings & key stats show in live mode'); return; }
  if (info === undefined) { muted('Loading fundamentals…'); return; }
  if (info === null) { muted('Fundamentals unavailable for ' + sym); return; }
  const e = fmtEarnings(info.earningsTs, info.earningsEstimate);
  if (e) item('Earnings', e.text, e.warn ? 'wb-info-warn' : '');
  if (info.marketCap != null) item('Mkt cap', wbFmtCap(info.marketCap));
  /* Forward P/E is the desk convention; the edge function falls back to
     trailing only when a ticker has no forward estimate, flagged via peFwd so
     the fallback is marked 'ttm' rather than mislabeled as forward. */
  if (info.pe != null) item(info.peFwd ? 'Fwd P/E' : 'P/E', info.pe.toFixed(1) + (info.peFwd ? '' : ' ttm'));
  if (info.wkLow != null && info.wkHigh != null) item('52w', '$' + info.wkLow.toFixed(2) + '–$' + info.wkHigh.toFixed(2));
  if (info.divYield != null && info.divYield > 0) item('Yield', info.divYield.toFixed(2) + '%');
  if (!box.childNodes.length) muted('Fundamentals unavailable for ' + sym);
}

function renderWbSidebar(data) {
  const nav = document.getElementById('wbSidebar');
  while (nav.firstChild) nav.removeChild(nav.firstChild);
  for (const sym of Object.keys(data.symbols)) {
    const s = data.symbols[sym];
    const n = s.c.length;
    const pct = n > 1 ? (s.c[n - 1] / s.c[n - 2] - 1) * 100 : 0;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wb-side-btn';
    b.setAttribute('aria-current', String(sym === wbState.sym));
    b.appendChild(el('span', '', sym));
    b.appendChild(el('span', 'wb-side-pct ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : ''), fmtPct(pct)));
    b.addEventListener('click', () => wbPick(sym));
    nav.appendChild(b);
  }
}

/* Graft TODAY's still-forming daily candle onto the EOD daily series so Pro 1
   (daily stoch) and Pro 2 (weekly overlay) show today's action live during the
   session (owner request 2026-07-17). The daily feed (Stooq/Yahoo) only carries
   COMPLETED sessions, so the newest daily bar is the prior close; here we roll
   today's 5-minute intraday bars (already fetched for Pro 3) into one provisional
   OHLC bar and append it. Only appends when the intraday session date is AHEAD of
   the last completed daily bar — once the official EOD close lands we trust it and
   stop overwriting. Returns {bars, at} (at = latest 5-min bar time, UTC to the
   minute) or null when there is nothing current to add. The bar repaints until the
   close and inherits the intraday feed's ~15-min delay. */
/* Aggregate the 5-minute intraday feed into 15-MINUTE bars for Pro 3's
   display — the terminal's Pro 3 runs 15-min bars (established by matching
   its hover OHLC against this exact aggregation; see ISTOCH in data.js).
   The raw 5-min series stays untouched for the daily forming-candle graft. */
/* Pro 3 plots 15-MINUTE bars, so a session's bar count depends on whether
   extended hours are showing: 9:30–16:00 is 26 bars, 4:00–20:00 is 64. The
   default window is two sessions either way. */
const WB_P3_BARS_REG = 26;
const WB_P3_BARS_EXT = 64;
const p3Window = ext => 2 * (ext ? WB_P3_BARS_EXT : WB_P3_BARS_REG);

/* Session boundaries land on exact 15-minute marks (9:30 = minute 570, 4:00pm =
   960), so a bucket never straddles the regular/extended line — the first bar's
   x flag describes the whole bucket. */
function intraTo15(s) {
  const out = { t: [], o: [], h: [], l: [], c: [], v: [], x: [] };
  let key = null;
  for (let i = 0; i < s.c.length; i++) {
    const [d, hm] = s.t[i].split(' ');
    const [H, M] = hm.split(':').map(Number);
    const bucket = d + ' ' + Math.floor((H * 60 + M) / 15);
    if (bucket !== key) {
      key = bucket;
      out.t.push(s.t[i]); out.o.push(s.o[i]); out.h.push(s.h[i]); out.l.push(s.l[i]); out.c.push(s.c[i]); out.v.push(s.v ? s.v[i] || 0 : 0); out.x.push(s.x ? s.x[i] || 0 : 0);
    } else {
      const j = out.c.length - 1;
      out.h[j] = Math.max(out.h[j], s.h[i]);
      out.l[j] = Math.min(out.l[j], s.l[i]);
      out.c[j] = s.c[i];
      out.v[j] += s.v ? s.v[i] || 0 : 0;
    }
  }
  return out;
}

/* REGULAR-SESSION ONLY, deliberately (owner request 2026-07-29 added extended
   hours to the intraday feed): a daily candle's OHLC has one canonical meaning
   — the 9:30–4:00 session — and every other source states it that way. Folding
   pre/post prints into today's high/low would quietly shift the Pro 1 SWING and
   Pro 2 LONG-TERM stochastics off the terminal-fitted values they match today.
   Extended hours show up on Pro 3, where they read as what they are. */
function graftTodayBar(bars, intraRaw) {
  const intra = regularOnly(intraRaw);
  const n = intra && intra.t ? intra.t.length : 0;
  if (!n || !bars.t.length) return null;
  const day = intra.t[n - 1].slice(0, 10);
  if (day <= bars.t[bars.t.length - 1]) return null;   /* today's EOD bar already present, or intraday not ahead */
  let o = null, h = -Infinity, l = Infinity, c = null, v = 0;
  for (let i = 0; i < n; i++) {
    if (intra.t[i].slice(0, 10) !== day) continue;
    if (o === null) o = intra.o[i];
    if (intra.h[i] > h) h = intra.h[i];
    if (intra.l[i] < l) l = intra.l[i];
    c = intra.c[i]; v += intra.v[i] || 0;
  }
  if (o === null) return null;
  const vol = bars.v ? bars.v.slice() : bars.c.map(() => 0);
  return {
    bars: {
      t: [...bars.t, day], o: [...bars.o, o], h: [...bars.h, h],
      l: [...bars.l, l], c: [...bars.c, c], v: [...vol, v],
    },
    at: intra.t[n - 1],
  };
}

/* ── the two-tier workbench: Pro 1 (daily, short-term) · Pro 2 (weekly,
   long-term) side by side in one SVG, per the three-tier doctrine. Pro 3
   (intraday) awaits the quote-proxy backend. ─────────────────────────── */
function renderCharts(data, lamp) {
  /* days3 = Pro 3's INTRADAY window in its own bars: 52 × 15-min = 2 sessions
     (was 156 × 5-min before the terminal-fitted 15-min switch — same span).
     days3d = the EOD-fallback branch's window in DAILY bars (Codex #149: the
     two branches display different bar sizes, so they carry separate
     window/pan state instead of sharing one number). */
  if (!(wbState && wbState.data === data)) {
    /* days3 is a BAR count, and an extended session holds 64 fifteen-minute
       bars against a regular session's 26 — so a fixed 52 stops meaning "two
       sessions" the moment extended hours are on (Codex review, PR #187). Size
       the default from the toggle instead, and rescale on flip (below) so the
       view keeps its span rather than collapsing to under one day. */
    const cfg = loadWbCfg();
    /* the saved spans win over the built-in 3M/6M when present */
    const sticky = readWbSticky();
    wbState = { data, lamp, sym: Object.keys(data.symbols)[0], days: sticky.z1 ?? 63, wdays: sticky.z2 ?? 126, days3: p3Window(cfg.p3.ext), days3d: 156, off: 0, woff: 0, off3: 0, off3d: 0, layout: 'split', cfg };
  }
  wbState.lamp = lamp;
  const lampEl = document.getElementById('chartsLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  /* uniform "Updated {time} · {date}" from the feed lamp; demo shows the date */
  if (DESK.mode !== 'demo' && lamp && (lamp.atIso || lamp.asOf)) {
    applyLampStamp(document.getElementById('chartsStamp'), lamp);
  } else {
    applyStamp(document.getElementById('chartsStamp'), '', data ? data.asOf : '', '');
    if (!data) document.getElementById('chartsStamp').textContent = '—';
  }

  /* the symbol box is free-entry: type any ticker → the quote-proxy (wireCharts
     submit handler); the roster is picked from the sidebar list. No datalist —
     it duplicated the current symbol in a native popup (owner ruling 2026-07-16). */
  const symBox = document.getElementById('wbSymInput');
  if (document.activeElement !== symBox) symBox.value = wbState.sym;
  renderWbSidebar(data);
  renderWbInfo();
  maybeFetchWbInfo(wbState.sym);

  const svg = document.getElementById('wbChart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const tip = document.getElementById('wbTip');
  const s = data.symbols[wbState.sym];
  if (!s || s.c.length < 30) return;

  /* Apply pane-bar visibility BEFORE measuring the chrome — switching to/from
     the Pro-3-only layout changes the pane-bar row height, and measuring the
     stale layout would size the canvas off by a header row (Codex #131). */
  const paneVisible = p => wbState.layout === 'split' || wbState.layout === p;
  for (const k of ['p1', 'p2', 'p3']) document.getElementById('wbBar-' + k).hidden = !paneVisible(k);

  /* Collapse the symbol rail BEFORE measuring the chrome — otherwise a long
     watchlist stretches the grid row taller than the chart, that extra height is
     counted as `below` chrome, and H comes out too short (leaving the panes
     shy of the frame bottom until a second render — Codex #132). It's restored
     to the chart column's height right after H is known. */
  const paneBars = document.getElementById('wbPaneBars');
  const rail = document.getElementById('wbSidebar');
  if (rail) rail.style.maxHeight = '0px';

  const W = Math.max(480, Math.round(svg.parentElement.clientWidth || 900));
  /* Viewport-fit base + 2in (owner 2026-07-19: run the chart taller than one
     screen). The price pane still dominates (~64%) above volume + the two
     stochastic strips — the ratios are proportional to H, so growing keeps the
     layout. The rail cap below uses this taller H, so it scrolls to match. */
  const H = deskChartHeight(svg) + DESK_CHART_BOOST;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.style.height = H + 'px';
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: WB.canvas }));  /* dark terminal canvas */
  /* Now cap the rail to the chart column (pane-bars + canvas) so a long
     watchlist scrolls internally and the chart — not the rail — defines the grid
     row, so the panes fill to the frame bottom (owner 2026-07-19). */
  if (rail) rail.style.maxHeight = ((paneBars ? paneBars.offsetHeight : 0) + H) + 'px';

  const GAP = 16;
  /* crispEdges snaps every axis-aligned mark to the device-pixel grid, killing
     the soft grey anti-alias fuzz on 1px wicks/gridlines that read blurry next
     to a real terminal. Diagonal curves (stoch/SMA/BB paths) stay on the
     default smooth renderer so they don't stair-step. */
  const line = (x1, y1, x2, y2, attrs) => svg.appendChild(svgEl('line', { x1, y1, x2, y2, 'shape-rendering': 'crispEdges', ...attrs }));
  const text = (str, tx, ty, attrs) => { const t = svgEl('text', { x: tx, y: ty, 'font-family': 'var(--font-mono)', 'font-size': 10, fill: WB.label, ...attrs }); t.textContent = str; svg.appendChild(t); };
  /* visibility (not display): the dock below the chart keeps its reserved
     height when empty, so hover on/off never shifts the layout */
  const hideTip = () => { tip.style.visibility = 'hidden'; while (tip.firstChild) tip.removeChild(tip.firstChild); for (const c of svg.querySelectorAll('[data-cross]')) c.setAttribute('visibility', 'hidden'); };

  /* one pane = caption · price (+SMA/pivots) · volume · stochastic strip */
  const drawPane = (x0, w, bars, st, marks, caption, opts) => {
    /* Right gutter widened 46 → 64 to carry the larger ladder below. It is the
       ladder that sets this number: tick + gap is 11px, leaving ~53px, which
       fits "1,280.00" at 11px IBM Plex Mono (~6.6px/char). A five-figure price
       would still clip — as it did at 46 — but nothing in this workbench's
       roster reaches one, and buying for it would cost every pane real plot
       width every day to cover a case that does not occur. */
    const padR = 64;
    const plotW = w - padR - 6;

    /* ── axis ladders ───────────────────────────────────────────────────────
       Owner request 2026-08-13, against a reference-terminal screenshot: "a
       line scale of the pricing, bright, nice, great font". The three ladders
       had drifted to 8px, 9px and 9px in --color-text-secondary, which reads
       as a faint annotation rather than the ruler the eye actually navigates
       by — and the stochastic ladder carried no tick at all, so its numbers
       floated free of the column the other two formed.
       ONE spec now drives all three, because the thing being copied is not a
       font size but a single continuous edge running the height of the pane;
       three independently-tuned sizes cannot produce that however carefully
       each is chosen. Volume stays deliberately subordinate in secondary ink:
       it is a supporting histogram, and giving it the same weight as price
       would flatten the hierarchy the brightness exists to create.
       tabular-nums is stated even though IBM Plex Mono is already
       fixed-advance — it costs nothing and keeps the column true if the stack
       ever falls back to a proportional face. */
    const AX = { tick: 7, gap: 4, big: 11, small: 9 };
    const axisRow = (str, ty, size, fill) => {
      line(x0 + 6 + plotW, ty, x0 + 6 + plotW + AX.tick, ty, { stroke: 'var(--color-text-secondary)', 'stroke-width': 1 });
      text(str, x0 + 6 + plotW + AX.tick + AX.gap, ty + size / 3, {
        'font-size': size, fill, 'font-variant-numeric': 'tabular-nums', 'font-weight': 500,
      });
    };
    const n = Math.min(opts.window, bars.c.length);
    /* pan offset = bars hidden off the right edge (0 = latest bar visible) */
    const off = Math.max(0, Math.min(opts.offset || 0, bars.c.length - n));
    const end = bars.c.length - off;
    const i0 = end - n;
    const x = i => x0 + 6 + (i - i0 + 0.5) / n * plotW;
    const slotW = plotW / n;
    const bodyW = Math.max(1, Math.min(9, slotW * 0.66));
    /* vertical layout flexes with the toggles: price takes whatever the
       volume strip and 1–2 stochastic strips (native + weekly) leave over */
    /* Each strip carries ITS OWN doctrine marks (owner ruling 2026-07-22:
       Pro 1 = swing → circles on the DAILY strip; Pro 2 = long-term → circles
       on the WEEKLY strip): 4th tuple slot = the marks object to draw, or null. */
    const strips = [];
    if (opts.cfg.stoch) strips.push(['native', st, opts.stochCaption, opts.hideNativeMarks ? null : marks]);
    if (opts.cfg.stochW && opts.stW) strips.push(['weekly', opts.stW, opts.stochWCaption || (stochWTag() + ' · WEEKLY SCALE'), opts.marksW || null]);
    /* Volume + stochastic pane heights are user-draggable (the resize bars
       below) and persisted per pane; the PRICE pane absorbs the change
       (owner request 2026-07-16). The weekly strip has its OWN height
       (stochWH) so the divider between daily and weekly is movable too
       (owner request 2026-07-22). Defaults match the prior fixed sizes. */
    let vH = opts.cfg.vol ? (opts.cfg.volH ?? 50) : 0;
    /* heights keyed by strip IDENTITY, not array position (Codex #147): with the
       native stoch toggled off but weekly on, the lone weekly strip must still
       read/write ITS height (stochWH), not the hidden daily strip's stochH */
    const hasN = strips.some(([w]) => w === 'native');
    const hasW = strips.some(([w]) => w === 'weekly');
    let sH = hasN ? (opts.cfg.stochH ?? (hasW ? 68 : 88)) : 0;
    let sWH = hasW ? (opts.cfg.stochWH ?? (hasN ? sH : 88)) : 0;
    const pY = 22;
    /* bottom reserve holds the x-axis month labels + the range navigator
       strip (opts.nav); fixed so chartBot lines up across panes */
    const navReserve = opts.nav ? 58 : 30;
    /* Re-clamp restored/toggled heights so the price pane can never be squeezed
       below MIN_PH: a persisted volH/stochH plus a later indicator toggle (e.g.
       turning the weekly stochastic back on → the stoch block doubles) could
       otherwise overflow and push panes off-canvas. The pointerdown clamp only
       bounds future drags, not stored/invalidated values (Codex #114). Scale
       volume + stochastic down together to fit. */
    const MIN_PH = 140;
    const gaps = (vH ? 8 : 0) + strips.length * 14;
    const hBudget = H - pY - navReserve - MIN_PH - gaps;
    const hNeed = vH + sH + sWH;
    if (hNeed > hBudget && hNeed > 0) {
      const scale = Math.max(0, hBudget) / hNeed;
      vH = vH ? Math.max(16, Math.round(vH * scale)) : 0;
      sH = sH ? Math.max(24, Math.round(sH * scale)) : 0;
      sWH = sWH ? Math.max(24, Math.round(sWH * scale)) : 0;
    }
    const stripHs = strips.map(([which]) => (which === 'weekly' ? sWH : sH));
    const pH = H - pY - navReserve - (vH ? vH + 8 : 0) - strips.length * 14 - stripHs.reduce((a, b) => a + b, 0);
    const vY = pY + pH + (vH ? 8 : 0);
    let stripCursor = vY + vH;
    const stripTops = strips.map((_, i) => { stripCursor += 14; const y = stripCursor; stripCursor += stripHs[i]; return y; });
    const chartBot = strips.length ? stripCursor : vY + vH;

    text(caption, x0 + 6, 13, { 'font-size': 9, 'font-weight': 600, 'letter-spacing': '.08em', 'font-family': 'var(--font-sans)' });

    /* Extended-hours backdrop (owner request 2026-07-29). Drawn first so every
       candle, band and gridline lands on top of it. Pre/post bars are thin —
       a 5-lot print moves them — so they get a tinted regime band rather than
       being passed off as regular-session conviction. Contiguous runs merge
       into one rect: two per day at most, not one per bar. */
    if (opts.intraday && bars.x) {
      for (let i = i0; i < end; i++) {
        if (!bars.x[i]) continue;
        let j = i;
        while (j + 1 < end && bars.x[j + 1]) j++;
        const left = x(i) - slotW / 2;
        svg.appendChild(svgEl('rect', {
          x: left, y: pY, width: Math.max(1, x(j) + slotW / 2 - left), height: Math.max(0, chartBot - pY),
          fill: 'var(--color-border)', 'fill-opacity': 0.35, 'pointer-events': 'none',
        }));
        i = j;
      }
    }

    let hi = -Infinity, lo = Infinity;
    for (let i = i0; i < end; i++) { hi = Math.max(hi, bars.h[i]); lo = Math.min(lo, bars.l[i]); }
    /* Bollinger Bands (20, 2) — the day-trading envelope; bands join the
       price range so they never clip */
    let bb = null;
    if (opts.cfg.bb) {
      bb = { u: [], m: [], l: [] };
      for (let i = i0; i < end; i++) {
        if (i < 19) { bb.u.push(null); bb.m.push(null); bb.l.push(null); continue; }
        let sum = 0, sum2 = 0;
        for (let j = i - 19; j <= i; j++) { sum += bars.c[j]; sum2 += bars.c[j] * bars.c[j]; }
        const m = sum / 20;
        const sd = Math.sqrt(Math.max(0, sum2 / 20 - m * m));
        bb.u.push(m + 2 * sd); bb.m.push(m); bb.l.push(m - 2 * sd);
        hi = Math.max(hi, m + 2 * sd); lo = Math.min(lo, m - 2 * sd);
      }
    }
    const srOn = opts.cfg.sr;
    const pivots = (opts.pivots || [])
      .filter(([name]) => name === 'P' ? (srOn[1] || srOn[2] || srOn[3]) : srOn[Number(name.slice(1))])
      .filter(([, v]) => v > lo * 0.95 && v < hi * 1.05);
    for (const [, v] of pivots) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
    const pad = (hi - lo) * 0.05 || 1;
    hi += pad; lo -= pad;
    const py = v => pY + (hi - v) / (hi - lo) * pH;

    /* Dense, evenly-spaced price ladder NUMBERS like the reference terminal
       (owner request 2026-07-20): ~12-15 nice-numbered levels. The horizontal
       gridlines were removed 2026-07-22 to match the terminal's clean panels —
       the axis numbers stay, no lines cross the chart. rawStep is snapped to the
       NEAREST 1/2/2.5/5/10 × 10ⁿ "nice" value so labels stay round. */
    const rawStep = (hi - lo) / 13;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    let nice = 1;
    for (const c of [1, 2, 2.5, 5, 10]) if (Math.abs(c - norm) < Math.abs(nice - norm)) nice = c;
    const tick = nice * mag;
    for (let v = Math.ceil(lo / tick) * tick; v < hi; v += tick) {
      /* a ruler notch at the axis edge, NOT a gridline crossing the chart */
      axisRow(fmtPrice(v), py(v), AX.big, 'var(--color-text-primary)');
    }
    for (const [name, v] of pivots) {
      /* SOLID, at full strength, in chart-native colour (owner request
         2026-08-13 with a reference screenshot: "displayed as such. Solid and
         look at the color").
         These were dashed at 0.7 opacity in --color-accent / --color-gain, and
         the colour was the real fault: those tokens are the page's LIGHT-theme
         values, picked to be text-safe on cream (#96610F, #177C4B). Painted on
         this pane's black canvas they go muddy — the amber reads brown and the
         green reads bottle. The workbench already solves this for %K/%D with
         chart-native hexes rather than page tokens, and pivots now do the same.
         A second benefit: support no longer borrows --color-gain, so the
         P&L-only colour rule is not bent to mean "support" here. */
      const pcol = name === 'P' ? WB.piv : name[0] === 'R' ? WB.res : WB.sup;
      line(x0 + 6, py(v), x0 + 6 + plotW, py(v), { stroke: pcol, 'stroke-width': 1 });
      text(name + ': ' + fmtPrice(v), x0 + 8, py(v) - 4, { fill: pcol, 'font-size': 10, 'font-weight': 600 });
    }

    /* Bollinger envelope — dashed, neutral, like the reference Pro 3 */
    if (bb) {
      const mk = arr => {
        let d = '';
        for (let rel = 0; rel < arr.length; rel++) {
          if (arr[rel] == null) continue;
          d += (d ? 'L' : 'M') + x(i0 + rel).toFixed(1) + ' ' + py(arr[rel]).toFixed(1);
        }
        return d;
      };
      for (const [key, dash, op] of [['u', '5 4', 0.75], ['l', '5 4', 0.75], ['m', '2 4', 0.45]]) {
        const d = mk(bb[key]);
        if (d) svg.appendChild(svgEl('path', { d, fill: 'none', stroke: 'var(--color-text-secondary)', 'stroke-width': 1, 'stroke-dasharray': dash, 'stroke-opacity': op }));
      }
    }

    /* SMA stack (doctrine: layered dynamic S/R) */
    for (const [len, color] of opts.smas || []) {
      let d = '';
      for (let i = Math.max(i0, len - 1); i < end; i++) {
        let sum = 0;
        for (let j = i - len + 1; j <= i; j++) sum += bars.c[j];
        const v = sum / len;
        if (v > lo && v < hi) d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + py(v).toFixed(1);
        else d = d && d + 'M' + x(i).toFixed(1) + ' ' + py(Math.min(hi, Math.max(lo, v))).toFixed(1);
      }
      if (d) svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.8 }));
    }

    /* The SMA price display — a right-edge price tag at each enabled SMA — was
       removed from all three panes on 2026-08-08 (owner request). The SMA lines
       themselves are untouched; only the numeric tags are gone. */

    let vMax = 0;
    if (opts.cfg.vol) for (let i = i0; i < end; i++) vMax = Math.max(vMax, bars.v[i]);
    const isLine = opts.cfg.type === 'line';
    /* `opts.colorSt` (Pro 2 only) colours the candles by a STOCHASTIC CROSSOVER
       instead of the day's open/close — %K (red) above %D (yellow) = green,
       below = red. The owner reads that pane for long-term entries, where "is
       momentum with me" is the decision and a single day's direction is noise.

       The series passed in is the WEEKLY-SCALE 92-15-15, not the fast daily
       (owner ruling 2026-07-30): on a long-term pane the regime that matters is
       the long-term one. It is computed independently of the weekly OVERLAY
       toggle, so turning that strip off changes what is drawn, never what the
       candles mean.

       CONSEQUENCE, deliberately accepted: in this pane a green candle can be a
       DOWN day. The body still shows direction — open vs close positions it —
       but the fill now means momentum regime, not today's result. */
    const cst = opts.colorSt;
    const byStoch = !!(cst && cst.k && cst.d);
    /* STEADY COLOUR (owner request 2026-08-05, from a reference platform whose
       Pro 2 equivalent flips a handful of times in two years where ours flips
       every few weeks).
       The rule is a BAND, and the owner's ruling on it is explicit: a
       crossover INSIDE 30–80 must change the colour; a crossover out in the
       extremes must not. It matches the doctrine the pane already follows —
       "a cross that's still stuck up near the top hasn't confirmed the turn
       yet, you want to see it actually breaking down into the band" — so the
       colour turns bearish only once %K has dropped BELOW 80, and bullish only
       once it has climbed ABOVE 30. Until then the previous regime holds.
       An alternative rule requiring %K and %D to SEPARATE by a few points was
       built and measured (it flickers less: 305 colour changes against the
       band's 413 over ~2y across the 25 charted symbols, and 2 runs of <=5
       bars against 56). It is REJECTED, and the reason is not the numbers: a
       separation threshold silently skips a real mid-band crossover whenever
       the two lines cross and stay close, which is precisely the event this
       pane exists to show. Fewer repaints is worth nothing if the one that
       matters is the one dropped.
       Deliberate consequence: with the band armed the strip can show the two
       lines visibly crossed while the candles still read the old regime —
       that is a cross out in an extreme being ignored on purpose, not a stale
       render, which is why the caption names the mode.
       Computed across the WHOLE series, never the visible window. The state
       carries forward from bar to bar, so seeding it at i0 would make a
       candle's colour depend on where the viewport happens to start — the same
       bar would change colour as you zoom, which is the kind of bug that
       destroys trust in the pane. */
    let hystUp = null;
    if (byStoch && cst.band) {
      const [lo, hi] = cst.band;
      hystUp = new Array(bars.c.length).fill(null);
      let state = null;
      for (let i = 0; i < bars.c.length; i++) {
        const k = cst.k[i], d = cst.d[i];
        if (k == null || d == null) continue;      // still warming up
        if (state === null) state = k > d;         // seed on the first usable bar
        else if (state && k < d && k < hi) state = false;
        else if (!state && k > d && k > lo) state = true;
        hystUp[i] = state;
      }
    }
    const barUp = i => {
      if (hystUp && hystUp[i] != null) return hystUp[i];
      if (byStoch) {
        const k = cst.k[i], d = cst.d[i];
        /* Before the stochastic warms up (the leading bars are null) there is
           no regime to show, so those fall back to price direction rather than
           defaulting everything to one colour. */
        if (k != null && d != null) return k > d;
      }
      return bars.c[i] >= bars.o[i];
    };
    let closeD = '';
    for (let i = i0; i < end; i++) {
      const up = barUp(i);
      const col = up ? WB.up : WB.down;
      const cx = x(i);
      if (isLine) {
        closeD += (closeD ? 'L' : 'M') + cx.toFixed(1) + ' ' + py(bars.c[i]).toFixed(1);
      } else {
        line(cx, py(bars.h[i]), cx, py(bars.l[i]), { stroke: col, 'stroke-width': 1 });
        svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: py(Math.max(bars.o[i], bars.c[i])), width: bodyW, height: Math.max(1, Math.abs(py(bars.o[i]) - py(bars.c[i]))), fill: col, 'shape-rendering': 'crispEdges' }));
      }
      /* VOLUME keeps price direction even in the stochastic-coloured pane: a
         volume bar is a fact about that one day, and tinting it by a momentum
         regime would make the histogram claim something it does not measure. */
      if (vMax) {
        const vcol = bars.c[i] >= bars.o[i] ? WB.up : WB.down;
        svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: vY + vH - (bars.v[i] / vMax) * vH, width: bodyW, height: (bars.v[i] / vMax) * vH, fill: vcol, 'shape-rendering': 'crispEdges' }));
      }
    }
    /* line style draws closes in gain-green, like the reference platform */
    if (closeD) svg.appendChild(svgEl('path', { d: closeD, fill: 'none', stroke: WB.up, 'stroke-width': 1.5 }));
    if (opts.cfg.vol) text('VOL', x0 + 6, vY + 8, { 'font-size': 8, 'letter-spacing': '.08em' });
    /* volume numbering ruler (owner request 2026-07-23) — 2-3 nice-rounded
       levels (1.2M/800K-style via fmtVol) with the same tick-mark style as
       the price axis; scales to the visible window's own max each render. */
    if (vMax) {
      const vRaw = vMax / 3;
      const vMag = Math.pow(10, Math.floor(Math.log10(vRaw)));
      const vNorm = vRaw / vMag;
      let vNice = 1;
      for (const c of [1, 2, 2.5, 5, 10]) if (Math.abs(c - vNorm) < Math.abs(vNice - vNorm)) vNice = c;
      const vTick = vNice * vMag;
      for (let v = vTick; v <= vMax; v += vTick) {
        const yv = vY + vH - (v / vMax) * vH;
        axisRow(fmtVol(v), yv, AX.small, 'var(--color-text-secondary)');
      }
    }

    /* stochastic strips (native + optional weekly) + doctrine markers */
    strips.forEach(([which, series, capText, strMarks], si) => {
      const yTop = stripTops[si];
      const hS = stripHs[si];
      const sy = v => yTop + hS - v / 100 * hS;
      /* Full 0-100 axis ladder every 20 (owner request 2026-07-20: show these
         numbers on the stochastic strips like the reference). The faint gridlines
         were removed 2026-07-22 to match the terminal's clean panels — number
         label only at each level, no line across the strip. */
      for (const g of [0, 20, 40, 60, 80]) {
        axisRow(String(g), sy(g), AX.small, 'var(--color-text-primary)');
      }
      /* Oversold/overbought bands in red on top of the ladder: the WEEKLY strip
         uses 30/80 to match the reference terminal (owner request 2026-07-20);
         daily/intraday keep the classic 20/80 the doctrine ◯ markers key off.
         The 20/40/60/80 levels are already labelled by the ladder above; the
         weekly 30 line is intentionally an unlabelled red band. */
      for (const g of (which === 'weekly' ? [30, 80] : [20, 80])) {
        line(x0 + 6, sy(g), x0 + 6 + plotW, sy(g), { stroke: WB.band, 'stroke-width': 1, 'stroke-opacity': 0.55 });
      }
      /* white dash-dot trigger line at 65 on the WEEKLY strip only — duplicates
         the reference terminal's weekly level (owner request 2026-07-20). */
      if (which === 'weekly') {
        line(x0 + 6, sy(65), x0 + 6 + plotW, sy(65), { stroke: '#eef2f7', 'stroke-width': 1, 'stroke-opacity': 0.75, 'stroke-dasharray': '5 3 1 3', 'stroke-linecap': 'round' });
        text('65', x0 + 6 + plotW + 4, sy(65) + 3, { 'font-size': 9, fill: '#eef2f7' });
      }
      for (const [key, col] of [['k', WB.kLine], ['d', WB.dLine]]) {
        let d = '';
        for (let i = i0; i < end; i++) {
          if (series[key][i] == null) continue;
          d += (d ? 'L' : 'M') + x(i).toFixed(1) + ' ' + sy(series[key][i]).toFixed(1);
        }
        if (d) svg.appendChild(svgEl('path', { d, fill: 'none', stroke: col, 'stroke-width': 1.5 }));
      }
      if (strMarks && SHOW_DOCTRINE_MARKS) {
        for (const i of strMarks.buys) if (i >= i0 && i < end) svg.appendChild(svgEl('circle', { cx: x(i), cy: sy(series.k[i]), r: 4, fill: 'none', stroke: WB.up, 'stroke-width': 1.8 }));
        for (const i of strMarks.sells) if (i >= i0 && i < end) svg.appendChild(svgEl('circle', { cx: x(i), cy: sy(series.k[i]), r: 4, fill: 'none', stroke: WB.down, 'stroke-width': 1.8 }));
      }
      text(capText, x0 + 6, yTop - 4, { 'font-size': 8, 'letter-spacing': '.08em' });
      /* Warm-up gate (Codex #147): a short daily series can be long enough for
         the 14-3-3 daily stoch yet far short of the 92-15-15 weekly scale
         (needs ~120 bars before %D exists) — say so instead of rendering a
         silently empty strip. Partial case: %K alive, %D still warming. */
      {
        const cfgS = which === 'weekly' ? WSTOCH : (opts.stochCfgNative || STOCH);
        const warm = cfgS.k + cfgS.kSmooth + cfgS.d - 2;
        const hasK = series.k.some(v => v != null);
        const hasD = series.d.some(v => v != null);
        if (!hasK) text('INSUFFICIENT HISTORY — NEEDS ~' + warm + ' BARS', x0 + 6 + plotW / 2 - 90, yTop + hS / 2 + 3, { 'font-size': 8, 'letter-spacing': '.06em' });
        else if (!hasD) text('%D WARMING UP — NEEDS ~' + warm + ' BARS', x0 + plotW - 170, yTop - 4, { 'font-size': 7, 'letter-spacing': '.04em' });
      }
      if (which === 'native') {
        const pinned = stochPinned(st);
        if (pinned) {
          const bx = x0 + plotW - 104;
          svg.appendChild(svgEl('rect', { x: bx, y: yTop - 12, width: 112, height: 12, rx: 2, fill: 'var(--color-accent)', 'fill-opacity': 0.15 }));
          text(pinned + ' — TREND', bx + 4, yTop - 3, { 'font-size': 7, fill: 'var(--color-accent)', 'letter-spacing': '.04em' });
        }
      }
    });

    /* time axis LABELS: month boundaries on daily/weekly panes, session (day)
       boundaries on intraday ones. Labels only where they have ≥48px. The
       vertical gridlines were removed 2026-07-22 to match the terminal's clean
       panels — the date labels stay, no line crosses the chart. Intraday
       panes (Pro 3) get ONE exception (owner request 2026-07-24): a subtle
       full-height line at each day boundary, so a multi-day intraday window
       still shows where each trading day started — drawn at every boundary
       regardless of label spacing, since it's a sparse marker (one per day),
       not a dense grid. */
    const gridKey = opts.intraday ? (t => t.slice(0, 10)) : (t => t.slice(0, 7));
    const gridLabel = opts.intraday ? (t => t.slice(5, 10)) : (t => t.slice(0, 7));
    let lastLabelX = -Infinity;
    for (let i = i0 + 1; i < end; i++) {
      if (gridKey(bars.t[i]) !== gridKey(bars.t[i - 1])) {
        const gx = x(i) - slotW / 2;
        if (opts.intraday) line(gx, pY, gx, chartBot, { stroke: 'var(--color-border-hover)', 'stroke-width': 1, 'stroke-opacity': 0.6 });
        if (gx - lastLabelX >= 48) {
          text(gridLabel(bars.t[i]), gx + 2, opts.nav ? chartBot + 12 : H - 4, { 'font-size': 8 });
          lastLabelX = gx;
        }
      }
    }

    /* per-pane crosshair + readout — full cross like the reference: the
       horizontal line tracks the pointer through the price area with a
       live price tag pinned to the axis */
    const cross = svgEl('line', { y1: pY, y2: chartBot, stroke: WB.label, 'stroke-width': 1, 'stroke-dasharray': '2 3', visibility: 'hidden', 'pointer-events': 'none', 'data-cross': '1' });
    svg.appendChild(cross);
    const crossH = svgEl('line', { x1: x0 + 6, x2: x0 + 6 + plotW, stroke: WB.label, 'stroke-width': 1, 'stroke-dasharray': '2 3', visibility: 'hidden', 'pointer-events': 'none', 'data-cross': '1' });
    svg.appendChild(crossH);
    const crossTagBg = svgEl('rect', { x: x0 + 6 + plotW + 2, width: padR - 10, height: 13, rx: 2, fill: 'var(--color-surface-2)', stroke: 'var(--color-border-hover)', 'stroke-width': 1, visibility: 'hidden', 'pointer-events': 'none', 'data-cross': '1' });
    svg.appendChild(crossTagBg);
    const crossTag = svgEl('text', { x: x0 + 6 + plotW + 5, 'font-size': 8, 'font-weight': 600, fill: 'var(--color-text-primary)', 'font-family': 'var(--font-mono)', visibility: 'hidden', 'pointer-events': 'none', 'data-cross': '1' });
    svg.appendChild(crossTag);
    const overlay = svgEl('rect', { x: x0 + 6, y: pY, width: plotW, height: chartBot - pY, fill: 'transparent', style: 'cursor: grab' });
    svg.appendChild(overlay);

    /* Draggable resize bars — one above the VOLUME pane, one above the
       STOCHASTIC strips (owner request 2026-07-16), and — when the weekly
       strip is on — one BETWEEN the daily and weekly strips (owner request
       2026-07-22): that middle bar trades height between the two strips
       (total constant, price pane untouched); the other two resize their
       pane with the price pane absorbing. All persist per pane. Painted
       AFTER the overlay so they grab the pointer first. */
    const resizeBar = (barY, kind, startH, startH2) => {
      svg.appendChild(svgEl('line', { x1: x0 + 6, y1: barY, x2: x0 + 6 + plotW, y2: barY, stroke: WB.label, 'stroke-width': 1, 'stroke-opacity': 0.4, 'shape-rendering': 'crispEdges', 'pointer-events': 'none' }));
      /* grab-handle pill widened + fully opaque (owner report 2026-07-23: too
         subtle to spot between volume and stochastic) — reads unmistakably as
         a draggable white bar now, same across every pane. */
      const gw = 56;
      svg.appendChild(svgEl('rect', { x: x0 + 6 + plotW / 2 - gw / 2, y: barY - 2.5, width: gw, height: 5, rx: 2.5, fill: '#FFFFFF', 'pointer-events': 'none' }));
      const hit = svgEl('rect', { x: x0 + 6, y: barY - 5, width: plotW, height: 10, fill: 'transparent', style: 'cursor: row-resize; touch-action: none' });
      svg.appendChild(hit);
      hit.addEventListener('pointerdown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const box = svg.getBoundingClientRect();
        if (kind === 'stochSplit') {
          /* boundary drag: down grows the daily strip, shrinks the weekly */
          wbDrag = { resize: kind, cfg: opts.cfg, startH, startWH: startH2, startY: ev.clientY, scaleY: H / box.height, min: 30 };
          hideTip();
          return;
        }
        const navR = opts.nav ? 58 : 30;
        const budget = H - pY - navR - ((vH ? 8 : 0) + strips.length * 14) - 140; /* keep price ≥ 140px */
        const minH = kind === 'vol' ? 24 : 40;
        /* max for each bar = the budget minus everything it does NOT resize */
        const rawMax = kind === 'vol' ? budget - sH - sWH : kind === 'stoch' ? budget - vH - sWH : budget - vH - sH;
        wbDrag = { resize: kind, cfg: opts.cfg, startH, startY: ev.clientY, scaleY: H / box.height, min: minH, max: Math.max(minH, rawMax) };
        hideTip();
      });
    };
    if (vH) resizeBar(vY - 4, 'vol', vH);
    /* top bar resizes the FIRST strip by its identity — 'stochW' when the
       weekly strip stands alone (Codex #147: it must write stochWH, not the
       hidden daily strip's stochH) */
    if (strips.length) resizeBar(stripTops[0] - 7, strips[0][0] === 'weekly' ? 'stochW' : 'stoch', stripHs[0]);
    if (hasN && hasW) resizeBar(stripTops[1] - 7, 'stochSplit', sH, sWH);

    overlay.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const box = svg.getBoundingClientRect();
      wbDrag = { key: opts.panKey, x0: ev.clientX, off0: off, slotPx: slotW * (box.width / W), max: bars.c.length - n };
      hideTip();
    });
    overlay.addEventListener('pointermove', ev => {
      if (wbDrag) return;
      const box = svg.getBoundingClientRect();
      const mx = (ev.clientX - box.left) * (W / box.width);
      const i = Math.min(end - 1, Math.max(i0, i0 + Math.floor((mx - x0 - 6) / slotW)));
      hideTip();
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      const my = (ev.clientY - box.top) * (H / box.height);
      if (my >= pY && my <= pY + pH) {
        crossH.setAttribute('y1', my); crossH.setAttribute('y2', my);
        crossH.setAttribute('visibility', 'visible');
        crossTagBg.setAttribute('y', my - 6.5);
        crossTagBg.setAttribute('visibility', 'visible');
        crossTag.setAttribute('y', my + 3);
        crossTag.textContent = fmtPrice(hi - (my - pY) / pH * (hi - lo));
        crossTag.setAttribute('visibility', 'visible');
      }
      /* ONE-line readout docked in a fixed box BELOW the chart (owner request
         2026-07-22): tier · sym · bar time · OHLC ±% · Vol · stoch (· SMAs).
         Constant position — it never covers the canvas; visibility (not
         display) toggling keeps the dock's height reserved, so no jumps. */
      const chg = i > 0 ? (bars.c[i] / bars.c[i - 1] - 1) * 100 : 0;
      const row = el('div', 'tip-row');
      row.appendChild(el('span', 'tip-date', (opts.tier ? opts.tier.toUpperCase() + ' · ' : '') + (opts.sym || wbState.sym) + ' · ' + fmtBarT(bars.t[i]) + ' · '));
      row.appendChild(document.createTextNode('O ' + fmtPrice(bars.o[i]) + ' H ' + fmtPrice(bars.h[i]) + ' L ' + fmtPrice(bars.l[i]) + ' C ' + fmtPrice(bars.c[i]) + ' '));
      row.appendChild(el('span', chg > 0 ? 'up' : chg < 0 ? 'down' : '', fmtPct(chg)));
      const bits = ['Vol ' + fmtVol(bars.v[i])];
      /* Pro 2's weekly-scale overlay IS its read (owner ruling 2026-07-26):
         when it's on, the crosshair line shows the weekly %K/%D only, not the
         daily native pair too — Pro 1 stays the daily/SWING read, Pro 2 is the
         LONG-TERM read. The daily strip still draws on the chart either way;
         only this text summary changes. Falls back to the daily reading ONLY
         when the weekly overlay is toggled off — "enabled" and "warmed up for
         this bar" are different things (Codex review, PR #183): scrolled into
         the ~120-bar warmup window (e.g. the All range) the weekly series is
         legitimately still null while the toggle is on, and that must omit
         the stochastic reading for this bar, not silently show daily. */
      const weeklyOn = opts.cfg.stochW && !!opts.stW;
      const weeklyReady = weeklyOn && opts.stW.k[i] != null;
      if (!weeklyOn && st.k[i] != null) bits.push('%K ' + st.k[i].toFixed(0) + ' %D ' + (st.d[i] == null ? '—' : st.d[i].toFixed(0)));
      if (opts.rsi && opts.rsi[i] != null) bits.push('RSI ' + opts.rsi[i].toFixed(0));
      if (weeklyReady) bits.push('W ' + opts.stW.k[i].toFixed(0) + '/' + (opts.stW.d[i] == null ? '—' : opts.stW.d[i].toFixed(0)));
      const smaParts = [];
      for (const [len] of opts.smas || []) {
        if (i < len - 1) continue;
        let sum = 0;
        for (let j = i - len + 1; j <= i; j++) sum += bars.c[j];
        smaParts.push('SMA' + len + ' ' + fmtPrice(sum / len));
      }
      row.appendChild(document.createTextNode(' · ' + bits.concat(smaParts).join(' · ')));
      tip.appendChild(row);
      tip.style.visibility = 'visible';
    });
    overlay.addEventListener('pointerleave', hideTip);

    /* ── range navigator: a scrollbar over the FULL available history. The lit
       window marks the visible bars; drag a handle to resize (zoom), the body
       to pan. Writes the same window/offset state as the preset buttons and
       drag-pan, so all stay in sync. Every pane carries it — Pro 3 too, since
       its window is now a plain bar count over the ~5-day intraday feed. */
    if (opts.nav) {
      const len = bars.c.length;
      const navX = x0 + 6, navW = plotW, navTop = H - 30, navH = 13;
      const pxPerBar = navW / len;
      const winX = navX + i0 * pxPerBar;
      const winW = Math.max(6, n * pxPerBar);

      svg.appendChild(svgEl('rect', { x: navX, y: navTop, width: navW, height: navH, rx: 3, fill: 'var(--color-surface-2)', stroke: 'var(--color-border)', 'stroke-width': 1 }));
      /* The track stays EMPTY. It used to carry a faint downsampled close
         sparkline "for context"; owner ruling 2026-08-13, against the
         reference terminal: "Do not draw any graphs there. It's just blank."
         Do not re-add it. The navigator's job is to say which slice of history
         is on screen and let you move it — a second, squashed rendering of the
         same prices answers a question the panes above already answer at full
         size, and at 13px tall it can only misrepresent them. The lit window,
         its grip and the end handles are the whole content. */

      const winRect = svgEl('rect', { x: winX, y: navTop, width: winW, height: navH, rx: 3, fill: '#FFFFFF', 'fill-opacity': 0.22, stroke: '#FFFFFF', 'stroke-width': 1, style: 'cursor: grab' });
      svg.appendChild(winRect);
      const midX = winX + winW / 2;
      for (const gx of [-3, 0, 3]) line(midX + gx, navTop + 3, midX + gx, navTop + navH - 3, { stroke: '#FFFFFF', 'stroke-width': 1, 'stroke-opacity': 0.7, 'pointer-events': 'none' });

      const startNavDrag = (ev, mode) => {
        ev.preventDefault();
        const box = svg.getBoundingClientRect();
        wbDrag = { mode, daysKey: opts.daysKey, navKey: opts.panKey, x0: ev.clientX, pxPerBar: pxPerBar * (box.width / W), len, i0Start: i0, endStart: end, nStart: n };
        hideTip();
      };
      winRect.addEventListener('pointerdown', ev => startNavDrag(ev, 'navPan'));
      const hw = 7;
      for (const [hx, mode] of [[winX, 'navLeft'], [winX + winW, 'navRight']]) {
        const handle = svgEl('rect', { x: hx - hw / 2, y: navTop - 1, width: hw, height: navH + 2, rx: 2, fill: '#FFFFFF', stroke: 'var(--color-bg)', 'stroke-width': 1, style: 'cursor: ew-resize' });
        svg.appendChild(handle);
        handle.addEventListener('pointerdown', ev => { ev.stopPropagation(); startNavDrag(ev, mode); });
      }

      /* window start/end dates under each handle */
      const dLabel = t => opts.intraday ? t.slice(5) : t;
      text(dLabel(bars.t[i0]), navX, H - 4, { 'font-size': 8, fill: 'var(--color-text-secondary)' });
      const endLbl = dLabel(bars.t[end - 1]);
      text(endLbl, navX + navW, H - 4, { 'font-size': 8, fill: 'var(--color-text-secondary)', 'text-anchor': 'end' });
    }
  };

  const smaList = cfg => Object.entries(cfg.smas).filter(([, on]) => on).map(([len]) => [Number(len), SMA_COLORS[len]]);
  const show = p => wbState.layout === 'split' || wbState.layout === p;
  /* Pro 3 upgrades itself to real 5-minute bars via the quote-proxy in live
     mode (no unlock needed — the feed is origin-guarded); EOD is the fallback. */
  const maybeFetchIntraday = sym => {
    /* only real, live symbols — never fetch/graft for a demo-fallback series
       (desk-charts outage renders demo while DESK.mode stays live; Codex #120) */
    if (!wbSymLive(sym)) return;
    wbState.intraday = wbState.intraday || {};
    wbState.intradayAt = wbState.intradayAt || {};
    /* refetch at most once a minute (matches quote-proxy's intraday cache) so
       the forming candle keeps updating through the session instead of freezing
       on the first snapshot when the 5-min poller refreshes bars in place
       (Codex #120). The stale snapshot stays visible until the refetch lands. */
    const fresh = wbState.intradayAt[sym] && Date.now() - wbState.intradayAt[sym] < INTRADAY_TTL_MS;
    if (wbIntradayPending.has(sym) || (wbState.intraday[sym] && fresh)) return;
    wbIntradayPending.add(sym);
    deskQuote(sym, 'intraday', true)
      .then(out => {
        if (out.ok && out.series && out.series.c.length >= 30) {
          wbState.intraday[sym] = out.series;
          wbState.intradayAt[sym] = Date.now();
          renderCharts(wbState.data, wbState.lamp);
        }
      })
      .catch(() => { /* keep EOD */ })
      .finally(() => wbIntradayPending.delete(sym));
  };
  /* each pane may pin its own ticker (cfg.sym); empty = follow the desk
     symbol. Guarded against symbols missing from the loaded roster. */
  const effSym = cfg => (cfg.sym && data.symbols[cfg.sym] && data.symbols[cfg.sym].c.length >= 30) ? cfg.sym : wbState.sym;
  const dailyCache = {};
  const daily = sym => dailyCache[sym] || (dailyCache[sym] = (() => {
    /* graft today's forming candle from the intraday feed so the daily +
       weekly stochastics move through the session (owner request 2026-07-17).
       Gated on wbSymLive so a demo-fallback series (a live desk-charts outage)
       never mixes real intraday onto synthetic daily bars (Codex #120). */
    const intra = wbSymLive(sym) && wbState.intraday ? wbState.intraday[sym] : null;
    const g = intra ? graftTodayBar(data.symbols[sym], intra) : null;
    const bars = g ? g.bars : data.symbols[sym];
    return { bars, st: stochSeries(bars), rsi: rsiSeries(bars), piv: monthlyPivots(bars), live: g ? g.at : null };
  })());
  /* the daily panes need today's intraday bars too (not just Pro 3), so pull
     intraday for every visible pane's symbol — the graft above then lands on
     the next render once each fetch resolves */
  for (const p of ['p1', 'p2', 'p3']) if (show(p)) maybeFetchIntraday(effSym(wbState.cfg[p]));
  const panes = [];
  if (show('p1')) {
    const sym = effSym(wbState.cfg.p1);
    const d = daily(sym);
    /* Pro 1 = the SWING tier (owner naming 2026-07-22): daily bars, and the
       doctrine circles live on ITS daily strip — that's the swing signal. */
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 1 · SWING · ' + sym, {
      window: paneWindow(wbState.days, d.bars), offset: wbState.off, panKey: 'off', daysKey: 'days', nav: true,
      tier: 'Pro 1', sym, cfg: wbState.cfg.p1,
      pivots: d.piv, smas: smaList(wbState.cfg.p1), rsi: d.rsi,
      stW: null,   /* Pro 1 = daily stoch only (owner ruling 2026-07-17, no weekly overlay) */
      stochCaption: stochTag() + ' · DAILY',
    }]);
  }
  if (show('p2')) {
    /* Pro 2 = the LONG-TERM tier (owner naming 2026-07-22): daily candles
       carrying the daily stoch (native) + the WEEKLY stoch overlay (owner
       ruling 2026-07-17, weekly-scale per the terminal fit). The doctrine
       circles here live on the WEEKLY strip — the long-term signal — keyed to
       its own 30/80 bands; the daily strip stays clean (owner ruling
       2026-07-22: daily circles are Pro 1's swing signal). */
    const sym = effSym(wbState.cfg.p2);
    const d = daily(sym);
    /* The weekly stochastic is computed unconditionally because it drives the
       CANDLE COLOUR below; the overlay toggle only decides whether its strip is
       also drawn. Tying the two would make turning the strip off silently
       change what every candle means. */
    const wk2 = weeklyStochOnDaily(d.bars);
    const stW2 = wbState.cfg.p2.stochW ? wk2 : null;
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 2 · LONG-TERM · ' + sym, {
      window: paneWindow(wbState.wdays, d.bars), offset: wbState.woff, panKey: 'woff', daysKey: 'wdays', nav: true,
      tier: 'Pro 2', sym, cfg: wbState.cfg.p2,
      /* Candles by the WEEKLY stochastic crossover — Pro 2 ONLY (owner ruling
         2026-07-30). Pro 1 and Pro 3 keep open/close, where a day's direction
         is the point. */
      /* Same 30–80 the weekly strip below draws its band at (stochMarks(stW2,
         30, 80)) — the colour rule and the visible band must not disagree
         about where overbought starts. Measured on SPY and IYT, a 20 floor
         gives identical results to 30 over the last year: no bullish cross
         landed between them, so the lower bound is chosen for consistency
         with the drawn band, not for effect. */
      colorSt: wbState.cfg.p2.stochSteady ? { ...wk2, band: STEADY_BAND } : wk2,
      pivots: d.piv, smas: smaList(wbState.cfg.p2), rsi: d.rsi,
      stW: stW2,
      hideNativeMarks: true,
      marksW: stW2 ? stochMarks(stW2, 30, 80) : null,
      stochCaption: stochTag() + ' · DAILY',
      /* names the strip the candles take their colour from — in this pane a
         green candle can be a down day, so leaving that unstated would read
         as a rendering bug rather than the intended signal.
         STEADY earns its own word for the same reason: with it armed the two
         lines can be visibly crossed here while the candles still show the old
         regime, which is the deliberate lag and not a stale render. */
      stochWCaption: stochWTag() + ' · WEEKLY SCALE · CANDLE COLOUR'
        + (wbState.cfg.p2.stochSteady ? ' (STEADY)' : ''),
    }]);
  }
  /* Pro 3 = the day-trading tier: real 5-min intraday when the desk is live,
     an EOD daily fallback otherwise. Both carry the range navigator. */
  if (show('p3')) {
    const sym = effSym(wbState.cfg.p3);
    const d = daily(sym);
    const intra = wbState.intraday && wbState.intraday[sym];
    if (intra) {
      /* Terminal-fitted intraday (2026-07-22): Pro 3 displays 15-MINUTE bars
         (the 5-min feed aggregated via intraTo15) with the ISTOCH 10-3-3 slow
         stochastic — both established from the terminal's own Pro 3 hover
         readout; see the ISTOCH comment in data.js for the fit evidence. */
      /* EXT off → regular session only, the bar set ISTOCH was fitted against.
         EXT on → pre/post bars join the series, shaded in the chart body so a
         thin 4am print is never mistaken for regular-hours conviction. */
      const intra15 = intraTo15(wbState.cfg.p3.ext ? intra : regularOnly(intra));
      const ist = stochSeries(intra15, ISTOCH);
      const extOn = wbState.cfg.p3.ext && intra15.x && intra15.x.some(v => v);
      panes.push([intra15, ist, stochMarks(ist), 'PRO 3 · DAY TRADING · ' + sym + ' · 15-MIN' + (extOn ? ' · EXT' : ''), {
        /* no presets: the range navigator sets the window (in 15-min bars)
           anywhere within the ~5-day intraday feed */
        window: paneWindow(wbState.days3, intra15), offset: wbState.off3, panKey: 'off3', daysKey: 'days3', nav: true,
        tier: 'Pro 3', sym, cfg: wbState.cfg.p3, intraday: true,
        pivots: d.piv, smas: smaList(wbState.cfg.p3), rsi: rsiSeries(intra15),
        stW: null,   /* Pro 3 = intraday stoch only (owner ruling 2026-07-17, no daily overlay) */
        stochCfgNative: ISTOCH,
        stochCaption: stochTagOf(ISTOCH) + ' · 15-MIN',
      }]);
    } else {
      maybeFetchIntraday(sym);
      panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 3 · DAY TRADING · ' + sym + ' EOD', {
        window: paneWindow(wbState.days3d, d.bars), offset: wbState.off3d, panKey: 'off3d', daysKey: 'days3d', nav: true,
        tier: 'Pro 3', sym, cfg: wbState.cfg.p3,
        pivots: d.piv, smas: smaList(wbState.cfg.p3), rsi: d.rsi,
        stW: null,   /* Pro 3 = intraday stoch only (owner ruling 2026-07-17, no daily overlay) */
        stochCaption: stochTag() + ' · DAILY (INTRADAY PENDING)',
      }]);
    }
  }
  /* pane-bar visibility already applied up-front, before the height measure */
  const pw = (W - GAP * (panes.length - 1)) / panes.length;
  panes.forEach((p, idx) => drawPane(idx * (pw + GAP), pw, ...p));
  /* geometry for wheel-zoom hit-testing: which pane the cursor is over + its
     window key and bar series (see the window 'wheel' handler) */
  wbState.viewW = W;
  wbState.paneGeom = panes.map((p, idx) => ({ x0: idx * (pw + GAP), x1: idx * (pw + GAP) + pw, daysKey: p[4].daysKey, bars: p[0], cfg: p[4].cfg }));
  for (let idx = 1; idx < panes.length; idx++) {
    line(idx * (pw + GAP) - GAP / 2, 8, idx * (pw + GAP) - GAP / 2, H - 8, { stroke: WB.grid, 'stroke-width': 1 });
  }
  /* when a pane grafted today's forming candle, the stamp reads today + the
     latest intraday bar time (local) instead of the EOD "As of" date, with the
     ~15-min-delay caveat so the live bar is never mistaken for real-time */
  let liveAt = null;
  for (const k in dailyCache) { const L = dailyCache[k].live; if (L && (!liveAt || L > liveAt)) liveAt = L; }
  if (liveAt) {
    /* Intraday graft: same stamp grammar as every other panel, with the delay
       now MEASURED off the latest bar rather than the old hardcoded
       "~15-min delayed" guess (owner format 2026-07-28). */
    const liveIso = liveAt.replace(' ', 'T') + ':00Z';
    applyStamp(document.getElementById('chartsStamp'), liveIso, liveAt.slice(0, 10), 'age');
  }
  captureWbReadings(panes);
  syncZoomPressed();
  syncLockPressed();
}

/* ── what the CHART PANES currently show, for the assistant ──────────────────
   Owner ruling 2026-08-10: "I want to make sure the stochastic is also visible
   to the desk." The assistant already has `get_technicals`, which recomputes
   these for any symbol on demand — but that answers about a symbol it chose,
   not about the pane the owner is looking at. This captures the READ VALUES
   from the panes as rendered, so "what does my stochastic say" and what is on
   screen are the same numbers.
   Taken from the assembled pane list rather than recomputed: `daily()` is a
   closure inside renderCharts, and a second computation could drift from the
   drawn one — which is the whole failure this is meant to avoid. */
let wbReadings = null;
function captureWbReadings(panes) {
  const last = arr => {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return Number(arr[i].toFixed(2));
    return null;
  };
  const out = [];
  for (const [bars, st, , title, opts] of panes) {
    if (!opts || !opts.tier) continue;
    /* Pro 2's SIGNAL strip is the weekly one — it is what colours the candles —
       so report that as the pane's stochastic and label it. Pro 1 and Pro 3
       report their own native strip. */
    const signal = opts.stW || st;
    out.push({
      pane: opts.tier,
      sym: opts.sym,
      caption: title,
      lastClose: bars && bars.c ? last(bars.c) : null,
      stochK: signal ? last(signal.k) : null,
      stochD: signal ? last(signal.d) : null,
      /* the pane's OWN caption, not a guess from the tier: Pro 3 falls back to
         EOD daily bars when the intraday feed is absent, and labelling that
         "intraday 10-3-3" would name a scale the pane is not showing */
      stochScale: (opts.stW ? opts.stochWCaption : opts.stochCaption) || null,
      rsi14: opts.rsi ? last(opts.rsi.v || opts.rsi) : null,
    });
  }
  wbReadings = out.length ? out : null;
}

/* the per-pane settings popover (their platform's gear menu, in our idiom):
   indicator + SMA + S/R checkboxes for each tier, persisted via saveWbCfg */
let wbSetPane = null; /* which pane's settings popover is open */
function buildWbSettings() {
  if (!wbState || !wbSetPane) return;
  const pop = document.getElementById('wbSettings-' + wbSetPane);
  while (pop.firstChild) pop.removeChild(pop.firstChild);
  const cols = el('div', 'wb-set-cols');
  {
    const key = wbSetPane;
    const title = { p1: 'PRO 1 · SWING', p2: 'PRO 2 · LONG-TERM', p3: 'PRO 3 · DAY TRADING' }[key];
    const cfg = wbState.cfg[key];
    const col = el('div', 'wb-set-col');
    col.appendChild(el('h3', 'wb-set-title', title));
    col.appendChild(el('p', 'wb-set-group', 'Ticker'));
    const tsel = document.createElement('select');
    tsel.className = 'input wb-set-sym';
    tsel.setAttribute('aria-label', title + ' ticker');
    const follow = document.createElement('option');
    follow.value = ''; follow.textContent = 'Desk symbol';
    tsel.appendChild(follow);
    for (const sym of Object.keys(wbState.data.symbols)) {
      const o = document.createElement('option');
      o.value = sym; o.textContent = sym;
      tsel.appendChild(o);
    }
    tsel.value = cfg.sym && wbState.data.symbols[cfg.sym] ? cfg.sym : '';
    tsel.addEventListener('change', () => {
      cfg.sym = tsel.value || null; saveWbCfg();
      renderCharts(wbState.data, wbState.lamp);
    });
    col.appendChild(tsel);
    col.appendChild(el('p', 'wb-set-group', 'Chart style'));
    for (const [name, val] of [['Candles', 'candle'], ['Line', 'line']]) {
      const lab = el('label', 'wb-set-row');
      const rb = document.createElement('input');
      rb.type = 'radio'; rb.name = 'wb-type-' + key; rb.checked = (cfg.type || 'candle') === val;
      rb.addEventListener('change', () => {
        if (!rb.checked) return;
        cfg.type = val; saveWbCfg();
        renderCharts(wbState.data, wbState.lamp);
      });
      lab.appendChild(rb);
      lab.appendChild(el('span', '', name));
      col.appendChild(lab);
    }
    const group = (label, rows) => {
      col.appendChild(el('p', 'wb-set-group', label));
      for (const [name, get, set] of rows) {
        const lab = el('label', 'wb-set-row');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = get();
        cb.addEventListener('change', () => {
          set(cb.checked); saveWbCfg();
          renderCharts(wbState.data, wbState.lamp);
        });
        lab.appendChild(cb);
        lab.appendChild(el('span', '', name));
        col.appendChild(lab);
      }
    };
    /* Pro 3 (day trading) keeps a slim panel by owner ruling: Bollinger Bands
       / Volume / Stochastic only — no MAs or S/R. Pro 1/2 carry the full set.
       The weekly-stoch overlay now lives on Pro 2 ALONE (owner ruling
       2026-07-17); Pro 1/Pro 3 render their native stoch only, so no overlay
       toggle is offered there. */
    const full = key !== 'p3';
    const ind = [
      ['Bollinger Bands', () => cfg.bb, v => { cfg.bb = v; }],
      ['Volume', () => cfg.vol, v => { cfg.vol = v; }],
      ['Stochastic', () => cfg.stoch, v => { cfg.stoch = v; }],
      ...(key === 'p2' ? [['Stochastic (weekly)', () => cfg.stochW, v => { cfg.stochW = v; }]] : []),
    ];
    group('Indicators', ind);
    /* Pro 2 alone colours by the crossover, so it alone gets this option.
       Off by default: it recolours 21% of bars (measured over ~2y across the
       25 charted symbols), and silently changing what every candle means on a
       pane the owner reads for entries is not a default to assume.
       The label names WHERE the ignored crosses are, not how big they are —
       a cross inside the band always acts, however slight. */
    if (key === 'p2') {
      group('Candle colour', [
        ['Steady (ignore crosses in the extremes)', () => cfg.stochSteady, v => { cfg.stochSteady = v; }],
      ]);
    }
    /* Pro 3 alone trades on intraday bars, so it alone can show the extended
       session (owner request 2026-07-29). */
    if (key === 'p3') group('Session', [['Extended hours (4am–8pm ET)', () => cfg.ext, v => {
      /* Rescale the window and pan offset across the flip so the pane keeps the
         same CALENDAR span — 64 bars/day extended vs 26 regular. Without this,
         switching on would shrink the view to well under a single day. */
      const before = cfg.ext ? WB_P3_BARS_EXT : WB_P3_BARS_REG;
      const after = v ? WB_P3_BARS_EXT : WB_P3_BARS_REG;
      cfg.ext = v;
      wbState.days3 = Math.max(20, Math.round(wbState.days3 * after / before));
      wbState.off3 = Math.round(wbState.off3 * after / before);
    }]]);
    if (full) {
      group('Moving averages', [25, 50, 100, 200, 1].map(n =>
        ['SMA (' + n + ')', () => cfg.smas[n], v => { cfg.smas[n] = v; }]));
      group('Support / resistance', [1, 2, 3].map(n =>
        ['S' + n + ' / R' + n, () => cfg.sr[n], v => { cfg.sr[n] = v; }]));
    }
    cols.appendChild(col);
  }
  pop.appendChild(cols);
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'wb-set-reset'; reset.textContent = 'Reset this chart';
  reset.addEventListener('click', () => {
    wbState.cfg[wbSetPane] = WB_CFG_DEFAULT()[wbSetPane]; saveWbCfg();
    buildWbSettings();
    renderCharts(wbState.data, wbState.lamp);
  });
  pop.appendChild(reset);
}

function wireCharts() {
  const wireZoom = (segId, zooms, initial, apply) => {
    const seg = document.getElementById(segId);
    /* The initial pressed state is provisional: `wireCharts()` runs at load,
       before the feed has built `wbState`, so the restored span is not known
       yet. `syncZoomPressed()` at the end of every `renderCharts` sets the
       real one from `wbState.days`/`wdays`. */
    for (const [label, spec] of zooms) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.setAttribute('aria-pressed', String(spec === initial));
      b.addEventListener('click', () => {
        if (!wbState) return;
        apply(spec);
        for (const btn of seg.children) btn.setAttribute('aria-pressed', String(btn === b));
        renderCharts(wbState.data, wbState.lamp);
      });
      seg.appendChild(b);
    }
  };
  wireZoom('chartZoom', WB_ZOOMS, 63, spec => { wbState.days = spec; wbState.off = 0; writeWbSticky({ z1: spec }); });
  wireZoom('chartZoom2', WB2_ZOOMS, 126, spec => { wbState.wdays = spec; wbState.woff = 0; writeWbSticky({ z2: spec }); });
  /* Pro 3 has no window presets: its intraday feed only carries ~5 trading
     days of 5-min bars, so discrete day-presets all collapsed to one window.
     Range control is the bottom navigator instead — drag it to zoom anywhere
     within the session (owner ruling 2026-07-14). */

  const layoutSeg = document.getElementById('chartLayout');
  for (const [label, mode] of [['Split', 'split'], ['Pro 1', 'p1'], ['Pro 2', 'p2'], ['Pro 3', 'p3']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    b.setAttribute('aria-pressed', String(mode === 'split'));
    b.addEventListener('click', () => {
      if (!wbState) return;
      wbState.layout = mode;
      for (const btn of layoutSeg.children) btn.setAttribute('aria-pressed', String(btn === b));
      renderCharts(wbState.data, wbState.lamp);
    });
    layoutSeg.appendChild(b);
  }

  /* Symbol box: a typed roster symbol switches instantly; unknown tickers go
     through the origin-guarded quote-proxy in live mode — no unlock needed
     (demo has no backend ⇒ note). */
  const symForm = document.getElementById('wbSymForm');
  const symInput = document.getElementById('wbSymInput');
  /* transient load status shares the fundamentals strip's slot; once the chart
     loads, renderWbInfo() repaints it with the stats (owner request 2026-07-15) */
  const symNote = document.getElementById('wbInfo');
  symInput.addEventListener('change', () => {
    if (!wbState) return;
    const sym = symInput.value.trim().toUpperCase();
    if (sym !== wbState.sym && wbState.data.symbols[sym]) {
      symNote.textContent = '';
      wbPick(sym);
    }
  });
  /* ── ticker typeahead (owner request 2026-07-16): a custom listbox suggesting
     matching symbols from the curated WB_TICKERS set + the live roster as you
     type. The native <datalist> was rejected (it duplicated the current symbol);
     this is keyboard-navigable and inherits the dark charts scope. */
  const sug = document.getElementById('wbSuggest');
  let sugItems = [], sugAt = -1;
  const closeSug = () => { sug.hidden = true; sugAt = -1; symInput.setAttribute('aria-expanded', 'false'); };
  const matchSug = raw => {
    const q = raw.trim().toUpperCase();
    if (!q) return [];
    const seen = new Set(), pref = [], sub = [];
    const consider = (symU, name) => {
      if (seen.has(symU)) return;
      if (symU.startsWith(q)) { seen.add(symU); pref.push([symU, name]); }
      else if (symU.includes(q) || (name || '').toUpperCase().includes(q)) { seen.add(symU); sub.push([symU, name]); }
    };
    for (const [s, n] of WB_TICKERS) consider(s.toUpperCase(), n);
    if (wbState) for (const s of Object.keys(wbState.data.symbols)) consider(s.toUpperCase(), '');
    return [...pref, ...sub].slice(0, 8);
  };
  const paintSug = () => {
    while (sug.firstChild) sug.removeChild(sug.firstChild);
    sugItems.forEach(([symU, name], i) => {
      const li = el('li'); li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(i === sugAt));
      li.appendChild(el('span', 'wb-suggest-sym', symU));
      if (name) li.appendChild(el('span', 'wb-suggest-name', name));
      li.addEventListener('mousedown', ev => { ev.preventDefault(); symInput.value = symU; closeSug(); symForm.requestSubmit(); });
      sug.appendChild(li);
    });
    sug.hidden = !sugItems.length;
    symInput.setAttribute('aria-expanded', String(!!sugItems.length));
  };
  const moveSug = d => {
    if (!sugItems.length) return;
    sugAt = (sugAt + d + sugItems.length) % sugItems.length;
    [...sug.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sugAt)));
    sug.children[sugAt]?.scrollIntoView({ block: 'nearest' });
  };
  /* select the pre-filled symbol on focus so typing REPLACES it (the box shows
     the current ticker) instead of appending to it */
  symInput.addEventListener('focus', () => symInput.select());
  symInput.addEventListener('input', () => { sugItems = matchSug(symInput.value); sugAt = -1; paintSug(); });
  symInput.addEventListener('blur', () => setTimeout(closeSug, 120)); /* let a click land first */
  /* keyboard: arrows move the highlight; Enter takes the highlighted suggestion
     else submits the typed value; Escape closes. Enter routing is kept explicit
     here (a lone input submits inconsistently across engines). */
  symInput.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (sug.hidden) { sugItems = matchSug(symInput.value); paintSug(); } moveSug(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSug(-1); }
    else if (ev.key === 'Escape') { closeSug(); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (sugAt >= 0 && sugItems[sugAt]) symInput.value = sugItems[sugAt][0];
      closeSug();
      symForm.requestSubmit();
    }
  });
  symForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!wbState) return;
    const sym = symInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9.^=-]{1,10}$/.test(sym)) { symNote.textContent = 'Ticker not recognized'; return; }
    if (wbState.data.symbols[sym]) { symNote.textContent = ''; wbPick(sym); return; }
    if (DESK.mode === 'demo' || !DESK_DB.url) {
      symNote.textContent = 'Live ticker lookups are off in demo mode';
      return;
    }
    symNote.textContent = 'Loading ' + sym + '…';
    try {
      const out = await deskQuote(sym, 'daily');
      if (!out.ok || !out.series || out.series.c.length < 30) {
        symNote.textContent = out.error || 'No data found for ' + sym;
        return;
      }
      wbState.data.symbols[sym] = out.series;
      wbRealSyms.add(sym);          /* real quote-proxy data → eligible for fundamentals */
      addWbStickySym(sym);
      wbPick(sym);                  /* renderCharts → renderWbInfo repaints the strip with stats */
    } catch {
      symNote.textContent = 'Quote service unreachable — try again';
    }
  });

  /* one header bar per chart — its gear opens that pane's own popover,
     anchored above the pane like the reference platform */
  const gears = ['p1', 'p2', 'p3'].map(k => [k, document.getElementById('wbGear-' + k), document.getElementById('wbSettings-' + k)]);
  const closePop = () => {
    wbSetPane = null;
    for (const [, b, pop] of gears) { pop.hidden = true; b.setAttribute('aria-expanded', 'false'); }
  };
  for (const [k, b, pop] of gears) {
    b.addEventListener('click', () => {
      if (!wbState) return;
      if (!pop.hidden) { closePop(); return; }
      closePop();
      wbSetPane = k;
      buildWbSettings();
      pop.hidden = false;
      b.setAttribute('aria-expanded', 'true');
    });
  }
  document.addEventListener('pointerdown', ev => {
    if (!wbSetPane) return;
    if (gears.some(([, b, pop]) => b.contains(ev.target) || pop.contains(ev.target))) return;
    closePop();
  });

  /* scroll-zoom lock toggle — one small button per pane, next to its gear */
  for (const k of ['p1', 'p2', 'p3']) {
    const lockBtn = document.getElementById('wbLock-' + k);
    if (!lockBtn) continue;
    lockBtn.addEventListener('click', () => {
      if (!wbState) return;
      wbState.cfg[k].scrollLock = !wbState.cfg[k].scrollLock;
      saveWbCfg();
      syncLockPressed();
    });
  }
}

/* blank workbench + STALE lamp — live mode's honest empty state (owner ruling
   2026-07-22: live is REAL DATA OR NOTHING, across every panel) */
function renderChartsUnavailable() {
  const lampEl = document.getElementById('chartsLamp');
  lampEl.className = 'lamp lamp--stale'; lampEl.textContent = 'STALE';
  document.getElementById('chartsStamp').textContent = 'Charts feed unreachable — nothing shown until real data arrives. Retrying…';
  const svg = document.getElementById('wbChart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

async function loadCharts(force) {
  if (DESK.mode !== 'demo') {
    try {
      const data = await deskFeed('desk-charts', force ? { force: true } : undefined);
      clearTimeout(chartsRetry.timer); chartsRetry.wait = 0;
      for (const k of Object.keys(data.symbols)) { wbFeedRoster.add(k); wbRealSyms.add(k); }
      if (wbState) {
        /* poller path: refresh bars in place so the user's selected symbol,
           zoom, and pan survive — renderCharts keys state on data identity.
           MERGE (not replace) so ad-hoc tickers the user loaded via
           quote-proxy aren't dropped when the watchlist feed refreshes. */
        wbState.data.symbols = { ...wbState.data.symbols, ...data.symbols };
        wbState.data.asOf = data.asOf;
        renderCharts(wbState.data, liveLampFor(data.generatedAt, data.asOf, true));
      } else {
        renderCharts(data, liveLampFor(data.generatedAt, data.asOf, true));
      }
      /* re-hydrate manual entries once, on the first LIVE feed — keyed on this
         one-shot rather than wbState creation so a transient first-load outage
         (which renders the demo fallback) still restores after recovery */
      if (!wbStickyRestored) { wbStickyRestored = true; restoreStickySymbols(); }
      return;
    } catch { /* failure paths below */ }
    if (wbState) return; /* poller failure: keep the last good workbench */
    /* LIVE first-load failure: blank + STALE + fast retry — never the demo
       generator on a live desk. */
    renderChartsUnavailable();
    armLiveRetry(chartsRetry, loadCharts, () => Boolean(wbState));
    return;
  }
  renderCharts(buildDemoCharts(), { cls: 'lamp--demo', text: 'Demo' });
}

/* Re-hydrate the sticky manual entries after the watchlist feed lands: restore
   the saved selection immediately if it's already in the roster, then re-fetch
   each persisted ad-hoc ticker via quote-proxy and merge it back in (selecting
   it once it arrives if it was the saved symbol). Runs once, on first load. */
async function restoreStickySymbols() {
  const saved = readWbSticky();
  if (!wbState) return;
  /* never override a live user choice: if they've picked a symbol since load,
     the saved selection is stale and must not snap the chart back */
  if (saved.sel && wbState.data.symbols[saved.sel] && !wbUserPicked && saved.sel !== wbState.sym) {
    wbState.sym = saved.sel;
    renderCharts(wbState.data, wbState.lamp);
  }
  for (const sym of saved.syms) {
    /* skip only if it's already REAL — a demo-fallback may hold SYNTHETIC bars
       for a sticky ticker that collides with the demo roster (e.g. GLD); those
       must still be re-fetched so real bars + fundamentals replace the fakes */
    if (wbRealSyms.has(sym)) continue;
    try {
      const out = await deskQuote(sym, 'daily');
      if (out.ok && out.series && out.series.c.length >= 30) {
        wbState.data.symbols[sym] = out.series;
        wbRealSyms.add(sym);        /* re-hydrated ad-hoc ticker is real → eligible for fundamentals */
        if (saved.sel === sym && !wbUserPicked) wbState.sym = sym;
        renderCharts(wbState.data, wbState.lamp);
      }
    } catch { /* skip a ticker the proxy can't serve */ }
  }
}

let wbResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!wbState) return;
  clearTimeout(wbResizeTimer);
  wbResizeTimer = setTimeout(() => renderCharts(wbState.data, wbState.lamp), 150);
});

/* ── render orchestration ──────────────────────────────────────────────── */
function renderPrivate() {
  if (DESK.mode === 'demo' || DESK.authed) {
    const lamp = DESK.mode === 'demo'
      ? { cls: 'lamp--demo', text: 'Demo' }
      : accountsLampFor(DESK.privateAsOf, DESK.privateSyncedAt, new Date());
    const acctStamp = document.getElementById('accountsStamp');
    if (acctStamp) acctStamp.textContent = lamp.stamp || (DESK.mode === 'demo' ? fmtUpdated(null, lastLabel()).replace('Last updated', 'Accounts synced') : '');
    renderAccounts(DESK.data.accounts, lamp);
    renderAsk();
    if (DESK.mode === 'demo') closeSysPromptModal(); /* demo has no live assistant to configure */
  } else {
    renderLockedPanels(); /* renders the ask panel's locked shell too */
  }
}

async function loadPrivate(pin) {
  const payload = await deskGetDashboard(pin).catch(() => null);
  if (!payload) {
    /* A failed ACCOUNTS fetch is NOT a failed PIN (owner report 2026-07-30 —
       the watchlist + went missing three times before this was traced).
       deskGetDashboard collapses every failure to null: a network blip, an
       empty IBKR table, an RPC hiccup. Clearing DESK.authed here treated all
       of those as "wrong PIN" and silently revoked the watchlist's edit
       controls immediately after a CORRECT unlock — with no error shown,
       because deskLogin itself had succeeded.

       DESK.authed means "we hold a validated PIN", which is still true. The
       watchlist writes through desk_set_watchlists(pin, ...) and needs nothing
       from this payload, so it keeps working. Only the accounts panel is
       unavailable, and it now says so instead of implying the PIN was wrong. */
    /* Accounts are UNAVAILABLE, not locked (Codex review, PR #201). Rendering
       the lock gate here contradicted itself — a PIN field labelled "Locked"
       while DESK.authed is true — and pointed at the very recovery step that
       does not help, which is the whole failure this change exists to end.
       Retry reuses the PIN already validated in this session. */
    DESK.data = { ...DESK.data, accounts: [] };   /* never hold stale/foreign balances */
    renderAccountsUnavailable();
    renderAsk();
    return;
  }
  const mapped = mapDashboardPayload(payload);
  DESK.data = { ...DESK.data, accounts: mapped.accounts, labels: mapped.labels };
  DESK.privateAsOf = mapped.asOf;
  DESK.privateSyncedAt = mapped.syncedAt;
  renderPrivate();
}

/* ── live public feeds: refreshers + the session-aware poller ────────────
   Live feed (desk-* edge function) or the last good render (FR-R9) — the
   demo generator is the only other data source left. On first-load failure
   the panel lamps Stale rather than showing demo data as real. */
let marketLive = false, newsLive = false;

/* Re-evaluate the Markets lamp against the age of the data ALREADY on screen,
   without fetching. The lamp is only ever computed inside a render, so any
   stretch where rendering stops — a failing poll, a hidden tab — freezes the
   lamp along with the prices, and a frozen lamp keeps claiming whatever it last
   said. Calling this re-reads liveLampFor against Date.now(), so stale data
   starts admitting it is stale even while nothing new is arriving. */
function relampMarket() {
  if (!marketLive || !DESK.liveStamp) return;
  renderMarkets(DESK.data.market, liveLampFor(DESK.liveStamp.generatedAt, DESK.liveStamp.asOf, true, DESK.liveStamp.quoteAt, DESK.liveStamp.extAt));
}

async function refreshMarket(force) {
  try {
    const market = await deskFeed('desk-market', force ? { force: true } : undefined);
    clearTimeout(marketRetry.timer); marketRetry.wait = 0;
    DESK.data.market = market.tiles || []; /* real tiles feed the ask context too */
    DESK.liveStamp = { generatedAt: market.generatedAt, asOf: market.asOf, quoteAt: market.quoteAt || null, extAt: market.extAt || null };
    renderMarkets(DESK.data.market, liveLampFor(market.generatedAt, market.asOf, true, market.quoteAt, market.extAt));
    fetchMktSeries();   /* one-shot: hydrate the index chart series (self-guarded) */
    marketLive = true;
    return;
  } catch { /* keep last good — but re-lamp it below, never leave it claiming LIVE */ }
  if (marketLive) {
    /* A failed poll used to return silently here. That kept the last good
       PRICES on screen (correct — FR-R9) but also kept the last good LAMP, so
       the panel went on asserting LIVE beside a frozen number for as long as
       the feed stayed down; only the masthead aged, because renderMasthead
       recomputes from DESK.liveStamp every tick while the panel lamp only
       changes when renderMarkets runs. Re-lamping from the CURRENT age of the
       data we are still showing is what makes the lamp mean something: past
       liveLampFor's 6-minute threshold it flips to STALE on its own.
       (Owner report 2026-07-29: a NASDAQ tile read −0.95% against IBKR's
       −0.58% — the same index ~28 minutes apart, under a LIVE lamp.) */
    relampMarket();
  } else {
    /* first-load failure: dash tiles (the live boot blanked the demo
       placeholder) — and retry fast rather than waiting out the poller */
    renderMarkets(DESK.data.market, { cls: 'lamp--stale', text: 'Stale' });
    armLiveRetry(marketRetry, refreshMarket, () => marketLive);
  }
}

async function refreshNews(force) {
  try {
    const news = await deskFeed('desk-news', force ? { force: true } : undefined);
    clearTimeout(newsRetry.timer); newsRetry.wait = 0;
    /* the feed's row clocks are UTC HH:mm — display Pacific (owner ruling) */
    DESK.data.news = (news.items || []).map(it => ({ ...it, t: utcHmToPt(it.t) }));
    renderNews(DESK.data.news, liveLampFor(news.generatedAt, news.asOf));
    newsLive = true;
    return;
  } catch { /* keep last good */ }
  if (!newsLive) {
    renderNews(DESK.data.news, { cls: 'lamp--stale', text: 'Stale' });
    armLiveRetry(newsRetry, refreshNews, () => newsLive);
  }
}

/* ── panel stamps ───────────────────────────────────────────────────────────
   The "delayed by N minutes" clause (owner format 2026-07-28) ages in real
   time, so a stamp rendered once at fetch would keep claiming "delayed by 1
   minute" an hour later — stating the exact opposite of the truth on the one
   line the owner reads to decide whether to trust the number. Each stamp
   therefore stores its raw inputs in data-* attributes and a 30s ticker
   recomputes the text in place; no re-fetch, no network. Only 'age' stamps
   need re-ticking — 'at close' and date-only stamps are static. */
const STAMP_TICK_MS = 30000;
function applyStamp(el, atIso, asOfDate, tail, suffix) {
  if (!el) return;
  const set = (k, v) => { if (v) el.dataset[k] = v; else delete el.dataset[k]; };
  set('stampAt', atIso); set('stampAsof', asOfDate);
  set('stampTail', tail); set('stampSuffix', suffix);
  el.textContent = fmtUpdated(atIso, asOfDate, tail) + (suffix || '');
}
/* Convenience: render a panel stamp straight from a lamp object. */
function applyLampStamp(el, lamp, fallback) {
  if (!el) return;
  if (!lamp || !(lamp.atIso || lamp.asOf)) { applyStamp(el, '', '', ''); el.textContent = fallback || '—'; return; }
  applyStamp(el, lamp.atIso, lamp.asOf, lamp.tail, lamp.stampSuffix);
}
function retickStamps() {
  for (const el of document.querySelectorAll('[data-stamp-tail="age"]')) {
    el.textContent = fmtUpdated(el.dataset.stampAt || '', el.dataset.stampAsof || '', 'age')
      + (el.dataset.stampSuffix || '');
  }
}
setInterval(retickStamps, STAMP_TICK_MS);

/* 5 min while the US session is open, 60 min closed (Clarification 6) — plus a
   short post-close settle grace (withinCloseSettleGrace, data.js) that keeps the
   5-min cadence for CLOSE_SETTLE_GRACE_MIN after 4pm ET so a late-posting final
   print gets picked up quickly instead of freezing for a full hour. Paused
   while the tab is hidden, refreshed immediately on return. feedPollTick is
   also reused by the manual "Refresh now" masthead button (force:true bypasses
   every server-side cache too — see the desk-* edge functions' `force` param). */
/* Refresh the quote/fundamentals strip for the symbol currently on the charts
   workbench. One symbol, one call, and quote-proxy caches it server-side, so
   this rides the fast market cadence rather than the 5-minute all-feeds tick:
   it is a live price the owner reads against the tape, and it was the one
   number on the desk that never refreshed at all (owner report 2026-07-31). */
function refreshWbQuote(force) {
  const sym = wbState && wbState.sym;
  if (sym) maybeFetchWbInfo(sym, force);
}

let feedPollTimer = 0;
async function feedPollTick(force) {
  /* loadWatchlist belongs here, not just at boot (Codex review, PR #188):
     without it a page left open never refetches quotes, and the panel's lamp
     stays LIVE from the first render while the prices behind it go hours
     stale — the exact lie the lamp exists to prevent. */
  await Promise.all([refreshMarket(force), refreshNews(force), loadHeatmap(force), loadCharts(force), loadWatchlist(force)]);
  refreshWbQuote(force); /* the charts quote readout — see the note on wbInfoCache */
  renderMasthead(); /* the masthead lamp tracks the freshest market fetch */
}
function scheduleFeedPoll() {
  clearTimeout(feedPollTimer);
  if (document.hidden) return; /* visibilitychange rearms */
  const openCadence = marketSessionOpen() || withinCloseSettleGrace();
  feedPollTimer = setTimeout(async () => { await feedPollTick(false); scheduleFeedPoll(); }, openCadence ? 5 * 60000 : 60 * 60000);
}

/* Prices move far faster than headlines, sector sweeps or watchlist OHLC, so
   the MARKET feed gets its own 1-minute poll while the session is open —
   separate from the 5-minute all-feeds tick above (owner report 2026-07-28:
   the tiles read visibly behind a live IBKR quote). Splitting it matters:
   desk-market is a cheap call, while desk-heatmap's screener sweep and
   desk-charts' 25-symbol OHLC pull are the expensive ones, and dragging those
   to a 1-minute cadence would multiply quota for data that barely changes.
   Runs during the open session, the post-close settle grace, AND the
   POST-MARKET window (16:00–20:00 ET, owner request 2026-07-30 + Codex review,
   PR #199). That last one is not optional now that the tiles show after-hours
   prices: without it the poller stopped at the bell and an on-screen extended
   quote could sit nearly two hours behind the tape, which is precisely the
   window the feature exists for. Once 20:00 ET passes and prices really are
   frozen, the hourly all-feeds tick covers it again. */
const MARKET_POLL_MS = 60000;
let marketPollTimer = 0;
function scheduleMarketPoll() {
  clearTimeout(marketPollTimer);
  if (document.hidden) return; /* visibilitychange rearms */
  /* postMarketOpen(): 16:00–20:00 ET, when extended prints are still arriving */
  if (!(marketSessionOpen() || withinCloseSettleGrace() || postMarketOpen())) return;
  marketPollTimer = setTimeout(async () => {
    await refreshMarket(false);
    refreshWbQuote(false); /* same cadence as the tiles — it is the same kind of number */
    renderMasthead();
    scheduleMarketPoll();
  }, MARKET_POLL_MS);
}
function startFeedPolling() {
  if (DESK.mode === 'demo' || !DESK_DB.url) return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(feedPollTimer); clearTimeout(marketPollTimer); }
    else {
      /* Re-lamp BEFORE the refetch, not just after it. Polling is paused while
         hidden, so a tab that sat in the background for half an hour comes back
         showing half-hour-old prices under the lamp they were rendered with —
         LIVE. The refetch fixes that, but only once it lands; until then the
         first thing the owner sees is a stale number claiming to be current,
         which is exactly the moment a figure gets compared against a broker
         screen and lands wrong. */
      relampMarket();
      feedPollTick(false).then(() => { scheduleFeedPoll(); scheduleMarketPoll(); });
    }
  });
  scheduleFeedPoll();
  scheduleMarketPoll();
}
/* Manual force-refresh (owner request 2026-07-27): bypasses BOTH the client
   poll cooldown and every desk-* edge function's in-memory cache, so a click
   guarantees a fresh upstream pull for market/news/heatmap/charts at once —
   the "everything's guaranteed fresh" button. renderMasthead() (inside
   feedPollTick) rebuilds this very button once fresh data lands, which is what
   restores its normal enabled label — no separate re-enable needed here.
   Re-arms the regular poll afterward. */
let refreshNowPending = false;
async function refreshNowClicked() {
  if (refreshNowPending || DESK.mode === 'demo' || !DESK_DB.url) return;
  refreshNowPending = true;
  const btn = document.getElementById('refreshNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  clearTimeout(feedPollTimer); clearTimeout(marketPollTimer);
  await feedPollTick(true);
  refreshNowPending = false;
  scheduleFeedPoll(); scheduleMarketPoll();
}

/* ── market widgets: embedded third-party (TradingView) widgets. Each loads as
   a DIRECT cross-origin iframe on tradingview-widget.com — NOT a srcdoc doc.
   That matters for isolation: a srcdoc frame inherits the PARENT's origin, so
   `allow-same-origin` there would make the vendor script same-origin with the
   desk (able to read sessionStorage/the PIN). A real cross-origin src gives the
   frame TradingView's own origin, so the browser's same-origin policy walls it
   off from the desk entirely — it can't reach our DOM, the PIN, or account
   data. Roster is owner-editable (config/widgets.json); these are the fallback.
   Mode-independent: live external data in demo and live. */
const WIDGET_PATHS = {
  'ticker-tape': 'ticker-tape',
  'events': 'events',
  'market-overview': 'market-overview',
  'mini-symbol-overview': 'mini-symbol-overview',
  'advanced-chart': 'advanced-chart',
  'timeline': 'timeline',
  'screener': 'screener',
};
const WIDGET_DEFAULTS = [
  { type: 'events', title: 'Economic calendar', width: 245, height: 305, config: {
    colorTheme: 'light', isTransparent: true, width: '100%', height: '100%', locale: 'en',
    importanceFilter: '0,1', countryFilter: 'us,eu,gb,jp,cn',
  } },
  { type: 'fred-glance', title: 'Economy at a glance — FRED', width: 245, height: 305 },
];

function widgetSrc(path, config) {
  /* the URL TradingView's own loader builds: widget name in the path, the
     config as a URL-encoded JSON fragment */
  return 'https://www.tradingview-widget.com/embed-widget/' + path + '/?locale=en#'
    + encodeURIComponent(JSON.stringify(config || {}));
}

/* FRED's "Economy at a glance" widget — a self-contained cross-origin iframe on
   research.stlouisfed.org (a SECOND embed provider beside TradingView). Same
   isolation as the TradingView frames: a real cross-origin src, so the browser
   same-origin policy walls the frame off from the desk; it's a standalone iframe
   with no parent-page vendor script, and no desk data ever crosses. */
const FRED_GLANCE_SRC = 'https://research.stlouisfed.org/fred-glance-widget.php';

/* Resolve a widget spec to its iframe src. TradingView widgets build a
   tradingview-widget.com URL from the widget name + config; a FRED widget uses
   the provider's own URL (spec.src lets the owner paste a configure-generated
   one to pick a custom set of series). Returns null for an unknown type. */
function widgetFrameSrc(spec) {
  if (spec.type === 'fred-glance') return spec.src || FRED_GLANCE_SRC;
  const path = WIDGET_PATHS[spec.type];
  return path ? widgetSrc(path, spec.config) : null;
}

/* Build a widget's bare iframe — no card, no caption (owner mock, 2026-07-16).
   The src is stashed on _src, NOT set yet: loadWidgets defers it to the first
   user interaction so no vendor frame ever loads on initial paint (perf +
   privacy, and keeps the S1 console gate clean). */
function buildWidgetFrame(spec) {
  const src = widgetFrameSrc(spec);
  if (!src) return null;
  const frame = document.createElement('iframe');
  frame.className = 'widget-frame';
  frame.title = spec.title || spec.type;
  frame.setAttribute('referrerpolicy', 'no-referrer');
  /* cross-origin src (below) already isolates via same-origin policy; the
     sandbox is defence-in-depth. allow-same-origin here refers to the frame's
     OWN vendor origin (TradingView or FRED, so its widget storage works), NOT
     the desk's. */
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  /* Permissions-Policy grant for the vendor frame: TradingView's widgets probe
     the motion sensors, so without this Chromium logs "accelerometer is not
     allowed" on hydrate (harmless to the widget, but it trips the S3 console
     gate). Grant ONLY the motion sensors — deliberately NOT camera/microphone/
     geolocation/clipboard/payment, which the widgets never need and which would
     be a real surface. Scoped to this frame's own vendor origin. */
  frame.setAttribute('allow', 'accelerometer; gyroscope; magnetometer');
  frame.style.height = (Number(spec.height) || 400) + 'px';
  /* per-widget width for the accounts row, read by the --widget-w CSS hook
     (strip frames ignore it — their CSS width stays 100%) */
  if (spec.width) frame.style.setProperty('--widget-w', Number(spec.width) + 'px');
  frame._src = src;
  return frame;
}

async function loadWidgets() {
  const row   = document.getElementById('acctWidgets');
  const strip = document.getElementById('widgetStrip');
  if (!row && !strip) return;
  /* An EMPTY roster means "no widgets", not "use the defaults" (owner ruling
     2026-08-07, when both embeds were retired). The old test was `cfg.length`,
     which made [] indistinguishable from a missing file and silently restored
     the built-in pair — so there was no way to turn the embeds off from config
     at all. Only a fetch/parse failure falls back now; a valid array is
     authoritative whatever its length. */
  let specs = WIDGET_DEFAULTS;
  try {
    const cfg = await fetchPublic('config/widgets.json');
    if (Array.isArray(cfg)) specs = cfg;
  } catch { /* committed config missing/unreachable → built-in defaults */ }
  /* slot:'strip' widgets (the ticker tape) render in the full-width top strip;
     everything else renders as a bare compact frame in the row under the
     account cards (owner mock 2026-07-16 — the two widget panels are gone;
     the row's static stamp in the markup names both sources, and CSS hides
     row + stamp when nothing renders). */
  const isStrip = s => s && s.slot === 'strip';
  const rowSpecs   = specs.filter(s => s && !isStrip(s)).slice(0, 6);
  const stripSpecs = specs.filter(isStrip).slice(0, 2);

  const hydrate = f => { if (f._src) { f.src = f._src; f._src = null; } };
  const renderInto = (container, specList) => {
    const frames = [];
    if (!container) return frames;
    while (container.firstChild) container.removeChild(container.firstChild);
    for (const spec of specList) {
      const frame = buildWidgetFrame(spec);
      if (frame) { container.appendChild(frame); frames.push(frame); }
    }
    return frames;
  };
  const frames = [...renderInto(row, rowSpecs), ...renderInto(strip, stripSpecs)];

  /* Strip AND row both sit ABOVE the fold now (the row is directly under the
     account cards), so an IntersectionObserver would fire on paint and run
     vendor JS immediately — tripping the S1 console gate. Defer every frame to
     the first genuine user interaction (which the load-time S1 check never
     performs); a real visitor triggers it within a moment of arriving, and it
     hydrates once. */
  if (frames.length) {
    const EVTS = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart', 'scroll'];
    const OPTS = { passive: true };
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      frames.forEach(hydrate);
      EVTS.forEach(ev => window.removeEventListener(ev, fire, OPTS));
    };
    EVTS.forEach(ev => window.addEventListener(ev, fire, OPTS));
  }
}

/* Watchlists loader. Demo seeds from the committed bootstrap roster (read
   client-side, same as the widget config); live pulls the batched quote feed.
   A failure lamps the panel Stale and keeps the last good render — never
   fabricated rows (live is real-data-or-nothing). */
async function loadWatchlist(force) {
  if (DESK.mode === 'demo') {
    try {
      const cfg = await fetchPublic('config/watchlists.json');
      renderWatchlist(buildDemoWatchlist(cfg.lists || [], wlTf), { cls: 'lamp--demo', text: 'Demo' });
    } catch {
      renderWatchlist({ ok: true, lists: [] }, { cls: 'lamp--demo', text: 'Demo' });
    }
    return;
  }
  if (!DESK_DB.url) return;
  const asked = wlTf;
  try {
    const out = await deskWatchlist(force, asked);
    /* Two switches in quick succession race: a 5Y sweep is slower than a 1D
       cache hit, so the older reply can land last and repaint every tile with
       the wrong window under the right label. The feed echoes what it drew, so
       drop anything that isn't the range still selected. */
    if (wlTf !== asked) return;
    if (out && out.range && out.range !== asked) return;
    /* Version skew (Codex review, PR #195). Pages publishes automatically but
       the edge function is deployed by hand, so between a merge and that deploy
       the PREVIOUS desk-watchlist is live — and it ignores `range` entirely,
       answering a 5Y request with a perfectly successful 1D payload that has no
       `range` field. Rendering that would put today's line under a 5Y label,
       which is exactly the class of quiet mislabelling this panel keeps getting
       bitten by. A missing `range` on a non-1D ask means the backend predates
       the control, so refuse it. */
    if (out && out.ok && !out.range && asked !== '1d') {
      renderWatchlist(null, { cls: 'lamp--stale', text: 'Stale' });
      return;
    }
    if (out && out.ok) {
      /* Price-bound lamps read EOD + "at close" the moment the regular session
         ends — correct for every other panel, wrong here: this feed keeps
         quoting through pre/post, so an EXT price would sit beside an "at
         close" stamp (Codex review, PR #188). Only relax it when BOTH hold —
         we're inside the 4am–8pm window AND rows really carry extended prints.
         Yahoo still returns last night's postMarketPrice at 2am, so the clock
         alone would lie. */
      const anyExt = (out.lists || []).some(l => (l.rows || []).some(r => r.ext));
      const streaming = anyExt && extendedSessionOpen();
      renderWatchlist(out, liveLampFor(out.generatedAt, out.asOf, !streaming));
    } else renderWatchlist(null, { cls: 'lamp--stale', text: 'Stale' });
  } catch {
    renderWatchlist(null, { cls: 'lamp--stale', text: 'Stale' });
  }
}

async function boot() {
  DESK.mode = resolveMode();
  if (DESK.mode === 'demo') {
    DESK.data = buildDemoData();
    renderMasthead();
    mktState.series = DESK.data.markets ? DESK.data.markets.series : null;
    renderMarkets(DESK.data.market, { cls: 'lamp--demo', text: 'Demo' });
    renderNews(DESK.data.news, { cls: 'lamp--demo', text: 'Demo' });
    renderPrivate();
    wireHeatToggle();
    loadHeatmap();
    loadCharts();
    loadWatchlist();
    loadWidgets();
    return;
  }
  /* live: public domains render immediately; private waits for PIN */
  DESK.data = buildDemoData(); /* placeholder series shapes until auth */
  /* Owner ruling 2026-07-22: live is REAL DATA OR NOTHING. Blank the demo
     market tiles + headlines so a failed first fetch renders an empty strip/
     Markets/news (Stale lamp) instead of fabricated prices labeled Stale —
     and so the demo tiles can never leak into the ask context either. */
  DESK.data.market = [];
  DESK.data.news = [];
  /* ACCOUNTS too (Codex review, PR #201). The rule above always covered these —
     buildAskContext() sends nav, cash and every position — but only market and
     news were actually blanked, so buildDemoData()'s fabricated holdings sat in
     memory through a live boot. Harmless only while a dashboard failure also
     revoked auth and locked the assistant; the moment that stopped being true,
     a failed first fetch could have handed invented positions to an assistant
     told they are the owner's real portfolio. Blank at the source so the class
     of bug cannot come back through some other path. */
  DESK.data.accounts = [];
  await Promise.all([refreshMarket(), refreshNews()]);
  renderMasthead();
  wireHeatToggle();
  loadHeatmap();
  loadCharts();
  loadWatchlist();
  loadWidgets();
  startFeedPolling();
  const pin = sessionStorage.getItem('desk_pin');
  if (pin) {
    const res = await deskLogin(pin).catch(() => ({ ok: false }));
    if (res && res.ok) { DESK.authed = true; await loadPrivate(pin); renderMasthead(); renderWatchlist(); return; }
    sessionStorage.removeItem('desk_pin');
  }
  renderLockedPanels();
}

wireCharts();
wireMapFilter();
wireWatchlistEditor();
wireWatchlistQuickEdits();
wireWatchlistDetail();
wireSysPromptModal();
boot();
