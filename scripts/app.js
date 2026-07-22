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
  data: null,          /* {accounts, market, news, labels, brief, asOfDate} */
  liveStamp: null,     /* freshest market-feed {generatedAt, asOf} — masthead lamp */
};

/* ── masthead ──────────────────────────────────────────────────────────── */
function renderMasthead() {
  const wrap = document.getElementById('mastheadState');
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  if (DESK.mode === 'demo') {
    wrap.appendChild(el('span', 'lamp lamp--demo', 'Demo data'));
    wrap.appendChild(el('span', 'lamp lamp--eod', 'EOD snapshot'));
    wrap.appendChild(el('span', 'stamp', fmtUpdated(null, lastLabel())));
  } else {
    /* live-derived: the market feed's stamps stand for the public layer —
       no committed meta.json anymore (retire-nightly-pipeline Group C) */
    const lamp = DESK.liveStamp
      ? liveLampFor(DESK.liveStamp.generatedAt, DESK.liveStamp.asOf)
      : { cls: 'lamp--stale', text: 'Stale', stamp: 'Live feed unreachable' };
    wrap.appendChild(el('span', 'lamp ' + lamp.cls, lamp.text));
    wrap.appendChild(el('span', 'stamp', lamp.stamp));
    if (DESK.authed) {
      const lock = el('button', 'btn btn-secondary', 'Lock');
      lock.type = 'button';
      lock.addEventListener('click', () => { sessionStorage.removeItem('desk_pin'); DESK.authed = false; renderPrivate(); renderMasthead(); });
      wrap.appendChild(lock);
    }
  }
}
function lastLabel() {
  return DESK.data && DESK.data.labels.length ? DESK.data.labels[DESK.data.labels.length - 1] : '—';
}

/* ── market strip ──────────────────────────────────────────────────────── */
/* Tiles are sorted into labelled asset-class frames (owner request 2026-07-17):
   broad → macro → sectors → industry/metals → rates → global. Matched by the
   feed's display `name` (identical in demo + live). The Gold/Dollar doubles are
   kept intentionally — spot GOLD/DXY as macro barometers, GLD/SLV as the metals
   pair, UUP beside US Dollar. Any feed tile not listed still renders in an
   "Other" frame, so a newly added symbol is never silently dropped. */
/* The four headline indices (S&P 500 / Nasdaq 100 / Dow Jones / Russell via IWM)
   are NOT banded here — they render as the Markets panel's index tiles right
   beside the strip, so a strip band for them just duplicated that (owner request
   2026-07-22). They're held in MKT_STRIP_HIDE so the "Other" catch-all below
   doesn't resurrect them from the feed. */
const MKT_STRIP_HIDE = new Set(['S&P 500', 'Nasdaq 100', 'Dow Jones', 'IWM (R2K proxy)']);
const MKT_BANDS = [
  /* Global & income leads the strip now that the Indices band is gone. */
  { label: 'Global & income',   names: ['EEM', 'FXI', 'INDA', 'JPXN', 'SPYD'] },
  { label: 'Macro',             names: ['VIX', 'US 10Y', 'US Dollar', 'UUP', 'Bitcoin', 'Gold'] },
  { label: 'US sectors',        names: ['XLK', 'XLF', 'XLC', 'XLY', 'XLV', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE'] },
  { label: 'Industry & metals', names: ['SMH', 'KRE', 'GLD', 'SLV'] },
  { label: 'Treasuries',        names: ['SHY', 'TLH', 'TLT'] },
];
/* compact half-size tile: name + price + %-change on one line. No per-tile
   sparkline — at this density it clipped the price (Codex #109). */
function mktTile(m) {
  const tile = el('div', 'mkt-tile');
  tile.appendChild(el('span', 'mkt-name', m.name));
  const row = el('div', 'mkt-vals');
  row.appendChild(el('span', 'mkt-last', m.last));
  row.appendChild(el('span', m.chg >= 0 ? 'pill pill--gain' : 'pill pill--loss', fmtPct(m.chg)));
  tile.appendChild(row);
  return tile;
}
function renderStrip(market) {
  const strip = document.getElementById('marketStrip');
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  const byName = new Map(market.map(m => [m.name, m]));
  /* seed with the headline indices so neither the bands nor the "Other" frame
     re-adds them — they live in the Markets panel beside the strip */
  const placed = new Set(MKT_STRIP_HIDE);
  const addGroup = (label, tiles) => {
    if (!tiles.length) return;
    const group = el('div', 'mkt-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.appendChild(el('span', 'mkt-group-label', label));
    const box = el('div', 'mkt-group-tiles');
    /* tiles flatten into a left-packed row across the group's full-width band
       (CSS auto-fill governs the column count; owner request 2026-07-18) */
    for (const m of tiles) box.appendChild(mktTile(m));
    group.appendChild(box);
    strip.appendChild(group);
  };
  for (const band of MKT_BANDS) {
    const tiles = [];
    for (const name of band.names) {
      const m = byName.get(name);
      if (m) { tiles.push(m); placed.add(name); }
    }
    addGroup(band.label, tiles);
  }
  addGroup('Other', market.filter(m => !placed.has(m.name)));
}

/* ── Markets window (owner request 2026-07-20) ─────────────────────────────
   A compact markets tab: region tabs, three index tiles, a normalized
   multi-index %-change chart with timeframe toggles, and a sector grid. Tiles
   and sector cells read from the shared market feed; the chart series are
   demo-generated or fetched live (SPY/QQQ/IWM via deskQuote). */
const MKT_INDEX = [
  { key: 'sp', label: 'S&P 500', tile: 'S&P 500', proxy: 'SPY', color: '#2f6df0' },
  { key: 'nq', label: 'NASDAQ', tile: 'Nasdaq 100', proxy: 'QQQ', color: '#7c3aed' },
  { key: 'ru', label: 'Russell 2000', tile: 'IWM (R2K proxy)', proxy: 'IWM', color: '#ea6a1e' },
  { key: 'dj', label: 'Dow Jones', tile: 'Dow Jones', proxy: 'DIA', color: '#0d9488' },
];
const MKT_SECTORS = [
  ['Technology', 'XLK'], ['Financials', 'XLF'], ['Health Care', 'XLV'], ['Cons. Disc.', 'XLY'],
  ['Communication', 'XLC'], ['Cons. Staples', 'XLP'], ['Energy', 'XLE'], ['Industrials', 'XLI'],
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
  /* uniform "Updated {time} · {date}" from the feed lamp; demo shows the date */
  if (stampEl) stampEl.textContent = (DESK.mode !== 'demo' && mktState.lamp && mktState.lamp.stamp) ? mktState.lamp.stamp : fmtUpdated(null, lastLabel());

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

  /* sector grid — colored by day-% like a mini heatmap */
  const secBox = document.getElementById('mktSectors');
  while (secBox.firstChild) secBox.removeChild(secBox.firstChild);
  for (const [name, sym] of MKT_SECTORS) {
    const t = mktTileByName(market, sym), pct = t ? t.chg : null;
    const cell = el('div', 'mk-sec');
    cell.style.cssText = mktSecTint(pct);
    cell.appendChild(el('div', 'mk-sec-name', name));
    cell.appendChild(el('div', 'mk-sec-pct', pct == null ? '—' : fmtPct(pct)));
    secBox.appendChild(cell);
  }
}

/* light green/red tint by day-% for the sector cells (daylight panel) */
function mktSecTint(pct) {
  if (pct == null) return 'background: var(--color-surface-2);';
  const p = Math.max(-2, Math.min(2, pct)) / 2;   /* clamp ±2% → −1..1 */
  const rgb = p >= 0 ? '46,180,90' : '224,60,60';
  return 'background: rgba(' + rgb + ',' + (0.1 + Math.abs(p) * 0.5).toFixed(2) + ');';
}

function drawMktChart() {
  const svg = document.getElementById('mktChart');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 600)), H = 150;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  const set = mktState.series && mktState.series[mktState.tf];
  const lines = set ? MKT_INDEX.map(ix => ({ color: ix.color, vals: set[ix.key] })).filter(l => l.vals && l.vals.length) : [];
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
   intraday (covers Today/5D) once, normalise each window to %-change from its
   first bar. Runs after the first live market render; tiles + sectors already
   show, so a failure just leaves the chart in its loading state. */
let mktSeriesPending = false, mktSeriesDone = false;
function normPct(closes, start) {
  const base = closes[start];
  if (!base) return [];
  return closes.slice(start).map(c => Number(((c / base - 1) * 100).toFixed(3)));
}
function buildMktSeries(per) {
  const out = { today: {}, '5d': {}, '1m': {}, '1y': {}, '2y': {} };
  for (const p of per) {
    const d = (p.daily && p.daily.c) || [], i = (p.intra && p.intra.c) || [];
    out.today[p.key] = i.length ? normPct(i, Math.max(0, i.length - 78)) : [];   /* ~1 session of 5-min bars */
    out['5d'][p.key] = i.length ? normPct(i, 0) : [];
    out['1m'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 22)) : [];
    out['1y'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 252)) : [];
    out['2y'][p.key] = d.length ? normPct(d, Math.max(0, d.length - 504)) : [];
  }
  return out;
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
    panel.appendChild(tblWrap);
    makeSortable(table);
    grid.appendChild(panel);
  }
}

/* ── news ──────────────────────────────────────────────────────────────── */
function renderNews(news, lamp) {
  const list = document.getElementById('newsList');
  while (list.firstChild) list.removeChild(list.firstChild);
  const lampEl = document.getElementById('newsLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  if (!news || !news.length) {
    list.appendChild(el('p', 'stamp', 'No headlines in the latest snapshot — check back after the next refresh.'));
    return;
  }
  for (const n of news) {
    const row = el('div', 'news-row');
    row.appendChild(el('span', 'news-time', n.t));
    const main = el('div', 'news-main');
    main.appendChild(el('p', 'news-headline', n.h));
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

/* ── AI brief ──────────────────────────────────────────────────────────── */
function renderBrief(brief, lamp, staleNote) {
  const body = document.getElementById('briefBody');
  while (body.firstChild) body.removeChild(body.firstChild);
  const lampEl = document.getElementById('briefLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  document.getElementById('briefStamp').textContent = brief ? brief.generatedAt : '—';
  if (!brief) {
    body.appendChild(el('p', 'stamp', 'No brief for the latest snapshot yet — it generates after each data refresh.'));
    return;
  }
  /* FR-AI4: a brief older than the account snapshot says so plainly. */
  if (staleNote) body.appendChild(el('p', 'lock-error', staleNote));
  const mk = (title, items) => {
    const sec = el('div', 'brief-section');
    sec.appendChild(el('h3', '', title));
    if (typeof items === 'string') sec.appendChild(el('p', '', items));
    else {
      const ul = document.createElement('ul');
      for (const it of items) ul.appendChild(el('li', '', it));
      sec.appendChild(ul);
    }
    return sec;
  };
  body.appendChild(mk('Portfolio state', brief.state));
  body.appendChild(mk('Key levels', brief.levels));
  body.appendChild(mk('Scenarios', brief.scenarios));
  body.appendChild(el('p', 'ai-disclaimer',
    'Generated from your committed account and market snapshots — not the open internet. AI-generated; can make mistakes. Informational only, not financial advice.'));
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
    market: (d.market || []).map(m => ({ name: m.name, last: m.last, dayChgPct: m.chg })),
    headlines: (d.news || []).slice(0, 10).map(n => n.h),
    brief: d.brief ? { state: d.brief.state, levels: d.brief.levels, scenarios: d.brief.scenarios } : null,
  };
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
  const err = el('p', 'lock-error', ''); err.hidden = true;
  form.appendChild(input); form.appendChild(btn);
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

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Asking…'; input.disabled = true;
    thread.appendChild(el('p', 'ask-q', q));
    thread.scrollTop = thread.scrollHeight;
    const res = await deskAsk(pin, q, buildAskContext())
      .catch(() => ({ ok: false, error: 'Could not reach the ask service — try again in a moment.' }));
    btn.disabled = false; btn.textContent = 'Ask'; input.disabled = false;
    if (res && res.ok) {
      thread.appendChild(el('p', 'ask-a', res.answer));
      appendSources(res.sources);
      clearBtn.hidden = false;
      input.value = '';
    } else {
      err.textContent = (res && res.error) || 'Something went wrong — try again.';
      err.hidden = false;
    }
    thread.scrollTop = thread.scrollHeight;
    input.focus();
  });
}

/* ── locked state (live mode, pre-auth) ────────────────────────────────── */
function renderLockedPanels() {
  const grid = document.getElementById('accountGrid');
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const lockPanel = el('section', 'panel panel-lock');
  const head = el('div', 'panel-header');
  head.appendChild(el('h3', 'panel-title', 'Accounts'));
  head.appendChild(el('span', 'lamp ml-auto lamp--locked', 'Locked'));
  lockPanel.appendChild(head);
  const body = el('div', 'panel-body');
  body.appendChild(el('p', 'lock-explain', 'Account balances, charts, and the AI brief are private — enter the desk PIN to unlock.'));
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
    } else {
      err.textContent = (res && res.error) || 'PIN not recognized — try again.';
      err.hidden = false;
    }
  });

  /* brief + ask panels show locked shells */
  renderBrief(null, { cls: 'lamp--locked', text: 'Locked' });
  document.getElementById('briefBody').replaceChildren(el('p', 'stamp', 'Unlocks with the desk PIN.'));
  renderAsk();
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
const DESK_CHART_BOOST = 192;   /* +2in on the stochastic chart */
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
  /* uniform "Updated {fetch time} · {trading day}" (fetch clock omitted for demo
     and the delayed cuts whose generatedAt is absent) */
  document.getElementById('heatStamp').textContent = hm ? fmtUpdated(hm.generatedAt, hm.asOf) : '—';
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
   Live cuts derive from data already on hand: index rosters intersect the
   S&P dataset (config/map-filters.json, owner-editable), the ETF map reads
   the charts histories. Russell 2000 is its own desk-heatmap universe
   (screener small-cap band, top 300 — owner request 2026-07-14). Stock
   cuts carry pctW/pctM/pctYtd from the feed's daily 1y sweep, so the
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
let heatExtra = null;                       /* desk-maps payload (crypto/futures/world, delayed quotes) */
let heatExtraAt = 0;                        /* fetch timestamp — refetch on cut click when stale */
let heatR2k = null;                         /* desk-heatmap universe:r2k payload + lamp */
let heatR2kAt = 0;
let heatR2kErr = false;
let mapView = { key: 'sp500', period: '1d', filters: null };

/* period support: '1d' always; longer periods need pctW/pctM/pctYtd on the
   tiles (feed's daily 1y sweep — absent for a few minutes after a cold
   function boot, and always absent in demo) */
const PERIOD_FIELD = { '1w': 'pctW', '1m': 'pctM', 'ytd': 'pctYtd' };
function datasetHasPeriods(hm) {
  if (!hm || !hm.sectors) return false;
  const t = hm.sectors[0] && hm.sectors[0].tiles[0];
  return Boolean(t && t.pctW !== undefined);
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

function buildEtfHeatmap(period) {
  if (!wbState || !wbState.data) return null;
  const cats = (mapView.filters && mapView.filters.etfCats) || {};
  const nBack = { '1d': 1, '1w': 5, '1m': 21 }[period];
  const groups = new Map();
  let asOf = '';
  for (const [sym, s] of Object.entries(wbState.data.symbols)) {
    const c = s.c;
    if (!c || c.length < 25) continue;
    let ref;
    if (period === 'ytd') {
      const yr = s.t[s.t.length - 1].slice(0, 4);
      const idx = s.t.findIndex(t => t.slice(0, 4) === yr);
      ref = idx > 0 ? c[idx - 1] : c[0];
    } else {
      if (c.length <= nBack) continue;
      ref = c[c.length - 1 - nBack];
    }
    /* tile weight = 21-day average dollar volume (ETFs have no market cap) */
    let dv = 0;
    const m = Math.min(21, c.length);
    for (let i = c.length - m; i < c.length; i++) dv += c[i] * (s.v[i] || 0);
    const cat = cats[sym] || 'ETFs';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ sym, name: sym, cap: Math.max(dv / m, 1), pct: Number(((c[c.length - 1] / ref - 1) * 100).toFixed(2)), ind: '', last: c[c.length - 1] });
    asOf = s.t[s.t.length - 1];
  }
  const sectors = [...groups.entries()]
    .map(([name, tiles]) => ({ name, cap: tiles.reduce((a, t) => a + t.cap, 0), tiles }))
    .sort((a, b) => b.cap - a.cap);
  return sectors.length ? { asOf, source: 'charts', sectors } : null;
}

function applyMapView() {
  if (!heatBase) return;
  const label = (MAP_CUTS.find(([k]) => k === mapView.key) || [])[1] || 'S&P 500';
  /* gate first: a period the current cut can't express falls back to 1d
     BEFORE rendering, so a cut switch never paints an empty map */
  const stockDataset = mapView.key === 'r2k' ? (heatR2k && heatR2k.hm) : heatBase.hm;
  const multiOk = mapView.key === 'etf'
    || (['sp500', 'dj30', 'ndx100', 'themes', 'r2k'].includes(mapView.key) && datasetHasPeriods(stockDataset));
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
    out = buildEtfHeatmap(mapView.period);
    lamp = wbState && wbState.lamp ? wbState.lamp : lamp;
    note = out ? 'Sized by 21-day avg dollar volume · colored by ' + periodLabel.toLowerCase() : 'ETF map needs the charts panel data — still loading';
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
    heatR2k = { hm: out, lamp: liveLampFor(out.generatedAt, out.asOf) };
    heatR2kAt = Date.now();
    heatR2kErr = false;
  } catch { heatR2kErr = !heatR2k; /* keep last good */ }
  if (mapView.key === 'r2k') applyMapView();
}

async function loadHeatmap() {
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
      const hm = await deskFeed('desk-heatmap');
      heatBase = { hm, lamp: liveLampFor(hm.generatedAt, hm.asOf) };
      applyMapView();
      return;
    } catch { /* poller failure below */ }
    if (heatBase) return; /* poller failure: keep the last good map */
  }
  heatBase = { hm: buildDemoHeatmap(), lamp: { cls: 'lamp--demo', text: 'Demo' } };
  applyMapView();
}

/* re-render the treemap at the new container size (debounced) */
let heatResizeTimer = 0;
window.addEventListener('resize', () => {
  if (!heatState) return;
  clearTimeout(heatResizeTimer);
  heatResizeTimer = setTimeout(() => renderHeatmap(heatState.hm, heatState.lamp), 150);
});

/* ── watchlist charts (candles + volume + daily/weekly-13 stochastics) ─────
   The desk's chart workbench, in the dashboard's own idiom: EOD candlesticks
   for a fixed public watchlist, classic floor-trader pivots from the prior
   calendar month, and the signature 13-period slow stochastic on BOTH daily
   bars and weekly bars (owner spec: "daily and weekly (13)"). Candle green/
   red is price-direction semantics (like the heatmap), not decoration. */
/* %K red / %D yellow mirror the reference terminal's stochastic indicator colors
   (owner request 2026-07-22, "identical to theirs"). These are dedicated
   indicator-palette hexes, NOT the P&L --color-loss/gain tokens — the red here is
   a chart-series color, not a P&L signal; red-vs-yellow stays CVD-distinguishable
   by lightness. */
const WB = { up: 'var(--color-gain)', down: 'var(--color-loss)', kLine: '#e23b3b', dLine: '#f5c518', grid: 'var(--color-border)', label: 'var(--color-text-secondary)', canvas: 'var(--color-bg)', band: 'var(--color-loss)' };
/* Strip caption derived from the live STOCH setting so the label can never
   disagree with the math (e.g. "STOCH 13-3-3"). STOCH is defined in data.js,
   which loads first; this runs at render time, so it's always resolved. */
function stochTag() { return `STOCH ${STOCH.k}-${STOCH.kSmooth}-${STOCH.d}`; }
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
  p1: { type: 'candle', bb: false, vol: true, stoch: true, stochW: true, smas: { 1: false, 25: true, 50: true, 100: false, 200: false }, sr: { 1: true, 2: false, 3: true }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
  p2: { type: 'candle', bb: false, vol: true, stoch: true, stochW: true, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
  /* Pro 3 = day trading: Bollinger Bands on by default, slim settings (owner ruling) */
  p3: { type: 'candle', bb: true, vol: true, stoch: true, stochW: true, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
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
          smaPrice: { ...d.smaPrice, ...(r.smaPrice || {}) },
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
function readWbSticky() {
  try {
    const raw = JSON.parse(localStorage.getItem(WB_STICKY_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        syms: Array.isArray(raw.syms) ? raw.syms.filter((s) => typeof s === 'string' && s).slice(0, 12) : [],
        sel: typeof raw.sel === 'string' ? raw.sel : '',
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
  wbState.off = wbState.woff = wbState.off3 = 0;
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
const wbInfoCache = {};                /* symbol → fundamentals object, or null for a known miss */
const wbInfoPending = new Set();       /* per-symbol info fetches in flight */
const wbRealSyms = new Set();          /* symbols backed by REAL data (live desk-charts feed or an
                                          ad-hoc quote-proxy load) — fundamentals show only for these,
                                          never for the synthetic demo-fallback watchlist */
const MIN_NAV_WIN = 20;   /* smallest window the navigator can shrink to (bars) */
window.addEventListener('pointermove', ev => {
  if (!wbDrag || !wbState) return;
  if (wbDrag.resize) {   /* vertical drag: resize the volume / stochastic pane */
    const dy = (ev.clientY - wbDrag.startY) * wbDrag.scaleY;
    const nv = Math.round(Math.max(wbDrag.min, Math.min(wbDrag.max,
      wbDrag.startH - (wbDrag.resize === 'stoch' ? dy / wbDrag.strips : dy))));
    const key = wbDrag.resize === 'vol' ? 'volH' : 'stochH';
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
/* Weekly-timeframe stochastic drawn SMOOTH on the daily chart while staying the
   genuine weekly signal (owner request 2026-07-19: smooth, not the daily-texture
   sawtooth; and the crossover IS the signal). We compute the classic 13-3-3 slow
   stochastic on TRUE weekly bars, then draw a straight line between each week's
   close across the intervening days — a clean curve whose crossovers are the real
   weekly crossovers. The last "week" is the current one aggregated week-to-date,
   so its control point sits on the latest bar and the right edge still updates
   daily as the week builds; at each Friday close the value equals the classic
   completed-week reading exactly. (A period-scaled daily stochastic would drift
   from the real weekly signal — Codex #134; step-holding drew a staircase.) */
function weeklyStochOnDaily(daily) {
  const n = daily.c.length;
  const k = new Array(n).fill(null);
  const d = new Array(n).fill(null);
  const isoWeek = t => {
    const dt = new Date(t + 'T12:00:00Z');
    return new Date(dt.getTime() - (((dt.getUTCDay() + 6) % 7) * 86400000)).toISOString().slice(0, 10);
  };
  /* true weekly bars (last week = forming, week-to-date) + each week's last daily index */
  const wh = [], wl = [], wc = [], wEnd = [];
  let key = null;
  for (let i = 0; i < n; i++) {
    const wk = isoWeek(daily.t[i]);
    if (wk !== key) { key = wk; wh.push(daily.h[i]); wl.push(daily.l[i]); wc.push(daily.c[i]); wEnd.push(i); }
    else {
      const j = wh.length - 1;
      if (daily.h[i] > wh[j]) wh[j] = daily.h[i];
      if (daily.l[i] < wl[j]) wl[j] = daily.l[i];
      wc[j] = daily.c[i]; wEnd[j] = i;
    }
  }
  const wst = stochSeries({ h: wh, l: wl, c: wc });
  /* control points at each week's close (the last sits on the latest daily bar,
     carrying the live week-to-date value) */
  const pts = [];
  for (let j = 0; j < wh.length; j++) if (wst.k[j] != null) pts.push([wEnd[j], wst.k[j], wst.d[j]]);
  /* linearly interpolate %K/%D between consecutive weekly closes across the days */
  for (let p = 0; p + 1 < pts.length; p++) {
    const [ai, ak, ad] = pts[p], [bi, bk, bd] = pts[p + 1];
    const span = (bi - ai) || 1;
    for (let i = ai; i <= bi; i++) {
      const t = (i - ai) / span;
      k[i] = ak + (bk - ak) * t;
      d[i] = ad + (bd - ad) * t;
    }
  }
  return { k, d };
}

function stochMarks(st) {
  const buys = [], sells = [];
  for (let i = 1; i < st.k.length; i++) {
    if (st.k[i] == null || st.d[i] == null || st.k[i - 1] == null || st.d[i - 1] == null) continue;
    /* buy: %K up through %D with BOTH at/below the oversold band; sell: the
       top-roll — down through %D AND dropping OUT of the overbought band
       (an embedded cross that stays pinned above 80 is trend, not a sell). */
    if (st.k[i - 1] <= st.d[i - 1] && st.k[i] > st.d[i] && st.k[i - 1] <= 20 && st.d[i - 1] <= 20) buys.push(i);
    if (st.k[i - 1] >= st.d[i - 1] && st.k[i] < st.d[i] && st.d[i - 1] >= 80 && st.k[i] < 80) sells.push(i);
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
function maybeFetchWbInfo(sym) {
  if (!wbSymLive(sym)) return;
  if (sym in wbInfoCache || wbInfoPending.has(sym)) return;
  wbInfoPending.add(sym);
  deskQuote(sym, 'info')
    .then(out => { wbInfoCache[sym] = (out && out.ok && out.info) ? out.info : null; })
    .catch(() => { wbInfoCache[sym] = null; })
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
  const info = live ? wbInfoCache[sym] : undefined;

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
    box.appendChild(el('span', 'wb-info-item wb-quote-last', fmtPrice(last)));
    if (chg != null) {
      const sign = chg > 0 ? '+' : '';
      box.appendChild(el('span', 'wb-info-item wb-quote-chg ' + dir,
        sign + fmtPrice(chg) + ' (' + sign + (chgPct == null ? '0.00' : chgPct.toFixed(2)) + '%)'));
    }
    if (bid != null && bid > 0) item('Bid', fmtPrice(bid));
    if (ask != null && ask > 0) item('Ask', fmtPrice(ask));
    if (bid != null && bid > 0 && ask != null && ask > 0) item('Diff', fmtPrice(ask - bid));
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
function graftTodayBar(bars, intra) {
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
  wbState = wbState && wbState.data === data ? wbState : { data, lamp, sym: Object.keys(data.symbols)[0], days: 63, wdays: 126, days3: 156, off: 0, woff: 0, off3: 0, layout: 'split', cfg: loadWbCfg() };
  wbState.lamp = lamp;
  const lampEl = document.getElementById('chartsLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  /* uniform "Updated {time} · {date}" from the feed lamp; demo shows the date */
  document.getElementById('chartsStamp').textContent =
    (DESK.mode !== 'demo' && lamp && lamp.stamp) ? lamp.stamp : (data ? fmtUpdated(null, data.asOf) : '—');

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
  const hideTip = () => { tip.style.display = 'none'; while (tip.firstChild) tip.removeChild(tip.firstChild); for (const c of svg.querySelectorAll('[data-cross]')) c.setAttribute('visibility', 'hidden'); };

  /* one pane = caption · price (+SMA/pivots) · volume · stochastic strip */
  const drawPane = (x0, w, bars, st, marks, caption, opts) => {
    const padR = 46;
    const plotW = w - padR - 6;
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
    const strips = [];
    if (opts.cfg.stoch) strips.push(['native', st, opts.stochCaption, true]);
    if (opts.cfg.stochW && opts.stW) strips.push(['weekly', opts.stW, opts.stochWCaption || (stochTag() + ' · WEEKLY (' + STOCH.k + ')'), false]);
    /* Volume + stochastic pane heights are user-draggable (the resize bars
       below) and persisted per pane; the PRICE pane absorbs the change
       (owner request 2026-07-16). Defaults match the prior fixed sizes. */
    let vH = opts.cfg.vol ? (opts.cfg.volH ?? 50) : 0;
    let sH = opts.cfg.stochH ?? (strips.length === 2 ? 68 : 88);
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
    const hNeed = vH + strips.length * sH;
    if (hNeed > hBudget && hNeed > 0) {
      const scale = Math.max(0, hBudget) / hNeed;
      vH = vH ? Math.max(16, Math.round(vH * scale)) : 0;
      sH = Math.max(24, Math.round(sH * scale));
    }
    const pH = H - pY - navReserve - (vH ? vH + 8 : 0) - strips.length * (sH + 14);
    const vY = pY + pH + (vH ? 8 : 0);
    let stripCursor = vY + vH;
    const stripTops = strips.map(() => { stripCursor += 14; const y = stripCursor; stripCursor += sH; return y; });
    const chartBot = strips.length ? stripCursor : vY + vH;

    text(caption, x0 + 6, 13, { 'font-size': 9, 'font-weight': 600, 'letter-spacing': '.08em', 'font-family': 'var(--font-sans)' });

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
      text(fmtPrice(v), x0 + 6 + plotW + 4, py(v) + 3, { 'font-size': 9 });   /* number only — no gridline */
    }
    for (const [name, v] of pivots) {
      /* R levels orange, S levels green, pivot yellow — the reference scheme */
      const pcol = name === 'P' ? 'var(--color-accent-bright)' : name[0] === 'R' ? 'var(--color-accent)' : 'var(--color-gain)';
      line(x0 + 6, py(v), x0 + 6 + plotW, py(v), { stroke: pcol, 'stroke-width': 1, 'stroke-dasharray': '5 4', 'stroke-opacity': 0.7 });
      text(name + ' ' + fmtPrice(v), x0 + 8, py(v) - 3, { fill: pcol, 'font-size': 9 });
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

    /* SMA price display — right-edge tag at each enabled SMA's latest
       visible value, colored to match its line */
    for (const len of [1, 25, 50, 100, 200]) {
      if (!(opts.cfg.smaPrice || {})[len] || end < len) continue;
      let sum = 0;
      for (let j = end - len; j < end; j++) sum += bars.c[j];
      const v = sum / len;
      if (v <= lo || v >= hi) continue;
      const yv = py(v);
      svg.appendChild(svgEl('rect', { x: x0 + 6 + plotW + 2, y: yv - 6, width: padR - 10, height: 12, rx: 2, fill: SMA_COLORS[len] }));
      text(fmtPrice(v), x0 + 6 + plotW + 5, yv + 3, { fill: 'var(--color-bg)', 'font-size': 8, 'font-weight': 600 });
    }

    let vMax = 0;
    if (opts.cfg.vol) for (let i = i0; i < end; i++) vMax = Math.max(vMax, bars.v[i]);
    const isLine = opts.cfg.type === 'line';
    let closeD = '';
    for (let i = i0; i < end; i++) {
      const up = bars.c[i] >= bars.o[i];
      const col = up ? WB.up : WB.down;
      const cx = x(i);
      if (isLine) {
        closeD += (closeD ? 'L' : 'M') + cx.toFixed(1) + ' ' + py(bars.c[i]).toFixed(1);
      } else {
        line(cx, py(bars.h[i]), cx, py(bars.l[i]), { stroke: col, 'stroke-width': 1 });
        svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: py(Math.max(bars.o[i], bars.c[i])), width: bodyW, height: Math.max(1, Math.abs(py(bars.o[i]) - py(bars.c[i]))), fill: col, 'shape-rendering': 'crispEdges' }));
      }
      if (vMax) svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: vY + vH - (bars.v[i] / vMax) * vH, width: bodyW, height: (bars.v[i] / vMax) * vH, fill: col, 'fill-opacity': 0.55, 'shape-rendering': 'crispEdges' }));
    }
    /* line style draws closes in gain-green, like the reference platform */
    if (closeD) svg.appendChild(svgEl('path', { d: closeD, fill: 'none', stroke: WB.up, 'stroke-width': 1.5 }));
    if (opts.cfg.vol) text('VOL', x0 + 6, vY + 8, { 'font-size': 8, 'letter-spacing': '.08em' });

    /* stochastic strips (native + optional weekly) + doctrine markers */
    strips.forEach(([which, series, capText, withMarks], si) => {
      const yTop = stripTops[si];
      const sy = v => yTop + sH - v / 100 * sH;
      /* Full 0-100 axis ladder every 20 (owner request 2026-07-20: show these
         numbers on the stochastic strips like the reference). The faint gridlines
         were removed 2026-07-22 to match the terminal's clean panels — number
         label only at each level, no line across the strip. */
      for (const g of [0, 20, 40, 60, 80]) {
        text(String(g), x0 + 6 + plotW + 4, sy(g) + 3, { 'font-size': 9 });
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
      if (withMarks) {
        for (const i of marks.buys) if (i >= i0 && i < end) svg.appendChild(svgEl('circle', { cx: x(i), cy: sy(st.k[i]), r: 4, fill: 'none', stroke: WB.up, 'stroke-width': 1.8 }));
        for (const i of marks.sells) if (i >= i0 && i < end) svg.appendChild(svgEl('circle', { cx: x(i), cy: sy(st.k[i]), r: 4, fill: 'none', stroke: WB.down, 'stroke-width': 1.8 }));
      }
      text(capText, x0 + 6, yTop - 4, { 'font-size': 8, 'letter-spacing': '.08em' });
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
       panels — the date labels stay, no line crosses the chart. */
    const gridKey = opts.intraday ? (t => t.slice(0, 10)) : (t => t.slice(0, 7));
    const gridLabel = opts.intraday ? (t => t.slice(5, 10)) : (t => t.slice(0, 7));
    let lastLabelX = -Infinity;
    for (let i = i0 + 1; i < end; i++) {
      if (gridKey(bars.t[i]) !== gridKey(bars.t[i - 1])) {
        const gx = x(i) - slotW / 2;
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
       STOCHASTIC strips (owner request 2026-07-16). Drag up to grow that pane,
       down to shrink it; the price pane absorbs it and the size persists per
       pane. Painted AFTER the overlay so they grab the pointer first. */
    const resizeBar = (barY, kind, startH) => {
      svg.appendChild(svgEl('line', { x1: x0 + 6, y1: barY, x2: x0 + 6 + plotW, y2: barY, stroke: WB.label, 'stroke-width': 1, 'stroke-opacity': 0.4, 'shape-rendering': 'crispEdges', 'pointer-events': 'none' }));
      const gw = 34;
      svg.appendChild(svgEl('rect', { x: x0 + 6 + plotW / 2 - gw / 2, y: barY - 2, width: gw, height: 4, rx: 2, fill: 'var(--color-text-primary)', 'fill-opacity': 0.85, 'pointer-events': 'none' }));
      const hit = svgEl('rect', { x: x0 + 6, y: barY - 5, width: plotW, height: 10, fill: 'transparent', style: 'cursor: row-resize; touch-action: none' });
      svg.appendChild(hit);
      hit.addEventListener('pointerdown', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const box = svg.getBoundingClientRect();
        const navR = opts.nav ? 58 : 30;
        const budget = H - pY - navR - ((vH ? 8 : 0) + strips.length * 14) - 140; /* keep price ≥ 140px */
        const minH = kind === 'vol' ? 24 : 40;
        const rawMax = kind === 'vol' ? budget - strips.length * sH : (budget - vH) / strips.length;
        wbDrag = { resize: kind, cfg: opts.cfg, startH, startY: ev.clientY, scaleY: H / box.height, strips: strips.length, min: minH, max: Math.max(minH, rawMax) };
        hideTip();
      });
    };
    if (vH) resizeBar(vY - 4, 'vol', vH);
    if (strips.length) resizeBar(stripTops[0] - 7, 'stoch', sH);

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
      /* compact readout, pinned top-left of the chart box (out of the candles) */
      const chg = i > 0 ? (bars.c[i] / bars.c[i - 1] - 1) * 100 : 0;
      tip.appendChild(el('div', 'tip-date', (opts.sym || wbState.sym) + ' · ' + bars.t[i]));
      const ohlc = el('div', 'tip-row', 'O ' + fmtPrice(bars.o[i]) + ' H ' + fmtPrice(bars.h[i]) + ' L ' + fmtPrice(bars.l[i]) + ' C ' + fmtPrice(bars.c[i]) + ' ');
      ohlc.appendChild(el('span', chg > 0 ? 'up' : chg < 0 ? 'down' : '', fmtPct(chg)));
      tip.appendChild(ohlc);
      const bits = ['Vol ' + fmtVol(bars.v[i])];
      if (st.k[i] != null) bits.push('%K ' + st.k[i].toFixed(0) + ' %D ' + (st.d[i] == null ? '—' : st.d[i].toFixed(0)));
      if (opts.cfg.stochW && opts.stW && opts.stW.k[i] != null) bits.push('W ' + opts.stW.k[i].toFixed(0) + '/' + (opts.stW.d[i] == null ? '—' : opts.stW.d[i].toFixed(0)));
      tip.appendChild(el('div', 'tip-row', bits.join(' · ')));
      const smaParts = [];
      for (const [len] of opts.smas || []) {
        if (i < len - 1) continue;
        let sum = 0;
        for (let j = i - len + 1; j <= i; j++) sum += bars.c[j];
        smaParts.push('SMA' + len + ' ' + fmtPrice(sum / len));
      }
      if (smaParts.length) tip.appendChild(el('div', 'tip-row', smaParts.join(' · ')));
      tip.style.display = 'block';
      /* pin to the top-left of the HOVERED pane (its own column in split view),
         clamped so it never runs off the right edge of the chart box */
      const wrap = svg.parentElement.getBoundingClientRect();
      const sx = wrap.width / W;
      tip.style.left = Math.max(4, Math.min((x0 + 6) * sx, wrap.width - 262)) + 'px';
      tip.style.top = '6px';
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
      /* faint full-range close sparkline for context (downsampled) */
      let sHi = -Infinity, sLo = Infinity;
      for (let i = 0; i < len; i++) { sHi = Math.max(sHi, bars.c[i]); sLo = Math.min(sLo, bars.c[i]); }
      const sRange = sHi - sLo || 1;
      const stepN = Math.max(1, Math.ceil(len / 240));
      let spark = '';
      for (let i = 0; i < len; i += stepN) {
        const sx = navX + i * pxPerBar;
        const syv = navTop + 2 + (sHi - bars.c[i]) / sRange * (navH - 4);
        spark += (spark ? 'L' : 'M') + sx.toFixed(1) + ' ' + syv.toFixed(1);
      }
      if (spark) svg.appendChild(svgEl('path', { d: spark, fill: 'none', stroke: 'var(--color-text-secondary)', 'stroke-width': 1, 'stroke-opacity': 0.5 }));

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
    deskQuote(sym, 'intraday')
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
    return { bars, st: stochSeries(bars), piv: monthlyPivots(bars), live: g ? g.at : null };
  })());
  /* the daily panes need today's intraday bars too (not just Pro 3), so pull
     intraday for every visible pane's symbol — the graft above then lands on
     the next render once each fetch resolves */
  for (const p of ['p1', 'p2', 'p3']) if (show(p)) maybeFetchIntraday(effSym(wbState.cfg[p]));
  const panes = [];
  if (show('p1')) {
    const sym = effSym(wbState.cfg.p1);
    const d = daily(sym);
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 1 · DAILY · ' + sym, {
      window: paneWindow(wbState.days, d.bars), offset: wbState.off, panKey: 'off', daysKey: 'days', nav: true,
      tier: 'Pro 1', sym, cfg: wbState.cfg.p1,
      pivots: d.piv, smas: smaList(wbState.cfg.p1),
      stW: null,   /* Pro 1 = daily stoch only (owner ruling 2026-07-17, no weekly overlay) */
      stochCaption: stochTag() + ' · DAILY',
    }]);
  }
  if (show('p2')) {
    /* Pro 2 = daily candles carrying the daily stoch (native) + the WEEKLY
       stoch overlay (owner ruling 2026-07-17). A daily stoch drawn on weekly
       candles would only step once a week, so Pro 2 shares Pro 1's daily bars
       and layers the weekly tide on top — matching the reference terminal. */
    const sym = effSym(wbState.cfg.p2);
    const d = daily(sym);
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 2 · DAILY · ' + sym, {
      window: paneWindow(wbState.wdays, d.bars), offset: wbState.woff, panKey: 'woff', daysKey: 'wdays', nav: true,
      tier: 'Pro 2', sym, cfg: wbState.cfg.p2,
      pivots: d.piv, smas: smaList(wbState.cfg.p2),
      stW: wbState.cfg.p2.stochW ? weeklyStochOnDaily(d.bars) : null,
      stochCaption: stochTag() + ' · DAILY',
      stochWCaption: stochTag() + ' · WEEKLY (' + STOCH.k + ')',
    }]);
  }
  /* Pro 3 = the day-trading tier: real 5-min intraday when the desk is live,
     an EOD daily fallback otherwise. Both carry the range navigator. */
  if (show('p3')) {
    const sym = effSym(wbState.cfg.p3);
    const d = daily(sym);
    const intra = wbState.intraday && wbState.intraday[sym];
    if (intra) {
      const ist = stochSeries(intra);
      panes.push([intra, ist, stochMarks(ist), 'PRO 3 · DAY TRADING · ' + sym + ' · 5-MIN', {
        /* no presets: the range navigator sets the window (in 5-min bars)
           anywhere within the ~5-day intraday feed */
        window: paneWindow(wbState.days3, intra), offset: wbState.off3, panKey: 'off3', daysKey: 'days3', nav: true,
        tier: 'Pro 3', sym, cfg: wbState.cfg.p3, intraday: true,
        pivots: d.piv, smas: smaList(wbState.cfg.p3),
        stW: null,   /* Pro 3 = intraday stoch only (owner ruling 2026-07-17, no daily overlay) */
        stochCaption: stochTag() + ' · 5-MIN',
      }]);
    } else {
      maybeFetchIntraday(sym);
      panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 3 · DAY TRADING · ' + sym + ' EOD', {
        window: paneWindow(wbState.days3, d.bars), offset: wbState.off3, panKey: 'off3', daysKey: 'days3', nav: true,
        tier: 'Pro 3', sym, cfg: wbState.cfg.p3,
        pivots: d.piv, smas: smaList(wbState.cfg.p3),
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
  wbState.paneGeom = panes.map((p, idx) => ({ x0: idx * (pw + GAP), x1: idx * (pw + GAP) + pw, daysKey: p[4].daysKey, bars: p[0] }));
  for (let idx = 1; idx < panes.length; idx++) {
    line(idx * (pw + GAP) - GAP / 2, 8, idx * (pw + GAP) - GAP / 2, H - 8, { stroke: WB.grid, 'stroke-width': 1 });
  }
  /* when a pane grafted today's forming candle, the stamp reads today + the
     latest intraday bar time (local) instead of the EOD "As of" date, with the
     ~15-min-delay caveat so the live bar is never mistaken for real-time */
  let liveAt = null;
  for (const k in dailyCache) { const L = dailyCache[k].live; if (L && (!liveAt || L > liveAt)) liveAt = L; }
  if (liveAt) {
    document.getElementById('chartsStamp').textContent =
      'Updated ' + fmtClock(liveAt.replace(' ', 'T') + ':00Z') + ' · Today · ~15-min delayed';
  }
  syncZoomPressed();
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
    const title = { p1: 'PRO 1 · DAILY', p2: 'PRO 2 · DAILY', p3: 'PRO 3 · DAY TRADING' }[key];
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
    if (full) {
      group('Moving averages', [25, 50, 100, 200, 1].map(n =>
        ['SMA (' + n + ')', () => cfg.smas[n], v => { cfg.smas[n] = v; }]));
      group('Support / resistance', [1, 2, 3].map(n =>
        ['S' + n + ' / R' + n, () => cfg.sr[n], v => { cfg.sr[n] = v; }]));
      group('SMA price display', [25, 50, 100, 200, 1].map(n =>
        ['SMA (' + n + ')', () => cfg.smaPrice[n], v => { cfg.smaPrice[n] = v; }]));
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
  wireZoom('chartZoom', WB_ZOOMS, 63, spec => { wbState.days = spec; wbState.off = 0; });
  wireZoom('chartZoom2', WB2_ZOOMS, 126, spec => { wbState.wdays = spec; wbState.woff = 0; });
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
    if (!/^[A-Z0-9.^-]{1,10}$/.test(sym)) { symNote.textContent = 'Ticker not recognized'; return; }
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
}

async function loadCharts() {
  if (DESK.mode !== 'demo') {
    try {
      const data = await deskFeed('desk-charts');
      for (const k of Object.keys(data.symbols)) { wbFeedRoster.add(k); wbRealSyms.add(k); }
      if (wbState) {
        /* poller path: refresh bars in place so the user's selected symbol,
           zoom, and pan survive — renderCharts keys state on data identity.
           MERGE (not replace) so ad-hoc tickers the user loaded via
           quote-proxy aren't dropped when the watchlist feed refreshes. */
        wbState.data.symbols = { ...wbState.data.symbols, ...data.symbols };
        wbState.data.asOf = data.asOf;
        renderCharts(wbState.data, liveLampFor(data.generatedAt, data.asOf));
      } else {
        renderCharts(data, liveLampFor(data.generatedAt, data.asOf));
      }
      /* re-hydrate manual entries once, on the first LIVE feed — keyed on this
         one-shot rather than wbState creation so a transient first-load outage
         (which renders the demo fallback) still restores after recovery */
      if (!wbStickyRestored) { wbStickyRestored = true; restoreStickySymbols(); }
      return;
    } catch { /* poller failure below */ }
    if (wbState) return; /* poller failure: keep the last good workbench */
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
    if (acctStamp) acctStamp.textContent = lamp.stamp || (DESK.mode === 'demo' ? fmtUpdated(null, lastLabel()) : '');
    renderAccounts(DESK.data.accounts, lamp);
    /* FR-AI4: the brief carries its own freshness — generation can fail
       while snapshots keep flowing, so its lamp derives from brief.asOf,
       not the account lamp. Demo always shows DEMO. */
    const brief = DESK.data.brief;
    let briefLamp = lamp, staleNote = null;
    if (DESK.mode !== 'demo') {
      if (!brief) {
        briefLamp = { cls: 'lamp--stale', text: 'No brief' };
      } else if (brief.asOf && DESK.privateAsOf && brief.asOf < DESK.privateAsOf) {
        briefLamp = { cls: 'lamp--stale', text: 'Stale' };
        staleNote = 'Brief is stale — generated for ' + brief.asOf
          + ', while accounts show ' + DESK.privateAsOf + '. It regenerates on the next successful refresh.';
      }
    }
    renderBrief(brief, briefLamp, staleNote);
    renderAsk();
  } else {
    renderLockedPanels(); /* renders the ask panel's locked shell too */
  }
}

async function loadPrivate(pin) {
  const payload = await deskGetDashboard(pin).catch(() => null);
  if (!payload) { DESK.authed = false; renderLockedPanels(); return; }
  const mapped = mapDashboardPayload(payload);
  DESK.data = { ...DESK.data, accounts: mapped.accounts, labels: mapped.labels, brief: mapped.brief };
  DESK.privateAsOf = mapped.asOf;
  DESK.privateSyncedAt = mapped.syncedAt;
  renderPrivate();
}

/* ── live public feeds: refreshers + the session-aware poller ────────────
   Live feed (desk-* edge function) or the last good render (FR-R9) — the
   demo generator is the only other data source left. On first-load failure
   the panel lamps Stale rather than showing demo data as real. */
let stripLive = false, newsLive = false;

async function refreshMarket() {
  try {
    const market = await deskFeed('desk-market');
    DESK.data.market = market.tiles || []; /* real tiles feed the ask context too */
    DESK.liveStamp = { generatedAt: market.generatedAt, asOf: market.asOf };
    renderStrip(DESK.data.market);
    renderMarkets(DESK.data.market, liveLampFor(market.generatedAt, market.asOf));
    fetchMktSeries();   /* one-shot: hydrate the index chart series (self-guarded) */
    stripLive = true;
    return;
  } catch { /* keep last good; masthead lamps Stale via liveStamp age */ }
  if (!stripLive) { renderStrip(DESK.data.market); renderMarkets(DESK.data.market, { cls: 'lamp--stale', text: 'Stale' }); }
}

async function refreshNews() {
  try {
    const news = await deskFeed('desk-news');
    DESK.data.news = news.items || [];
    renderNews(DESK.data.news, liveLampFor(news.generatedAt, news.asOf));
    newsLive = true;
    return;
  } catch { /* keep last good */ }
  if (!newsLive) renderNews(DESK.data.news, { cls: 'lamp--stale', text: 'Stale' });
}

/* 5 min while the US session is open, 60 min closed (Clarification 6);
   paused while the tab is hidden, refreshed immediately on return. */
let feedPollTimer = 0;
function startFeedPolling() {
  if (DESK.mode === 'demo' || !DESK_DB.url) return;
  const tick = async () => {
    await Promise.all([refreshMarket(), refreshNews(), loadHeatmap(), loadCharts()]);
    renderMasthead(); /* the masthead lamp tracks the freshest market fetch */
    schedule();
  };
  const schedule = () => {
    clearTimeout(feedPollTimer);
    if (document.hidden) return; /* visibilitychange rearms */
    feedPollTimer = setTimeout(tick, marketSessionOpen() ? 5 * 60000 : 60 * 60000);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(feedPollTimer);
    else tick();
  });
  schedule();
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
  let specs = WIDGET_DEFAULTS;
  try {
    const cfg = await fetchPublic('config/widgets.json');
    if (Array.isArray(cfg) && cfg.length) specs = cfg;
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

async function boot() {
  DESK.mode = resolveMode();
  if (DESK.mode === 'demo') {
    DESK.data = buildDemoData();
    renderMasthead();
    renderStrip(DESK.data.market);
    mktState.series = DESK.data.markets ? DESK.data.markets.series : null;
    renderMarkets(DESK.data.market, { cls: 'lamp--demo', text: 'Demo' });
    renderNews(DESK.data.news, { cls: 'lamp--demo', text: 'Demo' });
    renderPrivate();
    loadHeatmap();
    loadCharts();
    loadWidgets();
    return;
  }
  /* live: public domains render immediately; private waits for PIN */
  DESK.data = buildDemoData(); /* placeholder series shapes until auth */
  await Promise.all([refreshMarket(), refreshNews()]);
  renderMasthead();
  loadHeatmap();
  loadCharts();
  loadWidgets();
  startFeedPolling();
  const pin = sessionStorage.getItem('desk_pin');
  if (pin) {
    const res = await deskLogin(pin).catch(() => ({ ok: false }));
    if (res && res.ok) { DESK.authed = true; await loadPrivate(pin); renderMasthead(); return; }
    sessionStorage.removeItem('desk_pin');
  }
  renderLockedPanels();
}

wireCharts();
wireMapFilter();
boot();
