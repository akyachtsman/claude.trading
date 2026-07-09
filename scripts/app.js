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
  chart: { days: 126, consolidated: false, _state: null },
};

/* ── masthead ──────────────────────────────────────────────────────────── */
function renderMasthead() {
  const wrap = document.getElementById('mastheadState');
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  if (DESK.mode === 'demo') {
    wrap.appendChild(el('span', 'lamp lamp--demo', 'Demo data'));
    wrap.appendChild(el('span', 'lamp lamp--eod', 'EOD snapshot'));
    wrap.appendChild(el('span', 'stamp', 'As of ' + lastLabel()));
  } else {
    const meta = DESK.meta || {};
    const lamp = lampFor(meta.asOf, new Date());
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
function renderStrip(market) {
  const strip = document.getElementById('marketStrip');
  while (strip.firstChild) strip.removeChild(strip.firstChild);
  for (const m of market) {
    const tile = el('div', 'mkt-tile');
    tile.appendChild(el('span', 'mkt-name', m.name));
    const row = el('div', 'mkt-row');
    const left = el('div');
    left.appendChild(el('div', 'mkt-last', m.last));
    left.appendChild(el('span', m.chg >= 0 ? 'pill pill--gain' : 'pill pill--loss', fmtPct(m.chg)));
    row.appendChild(left);
    if (m.spark && m.spark.length > 1) {
      const sp = sparkline(m.spark, 76, 24, m.chg >= 0 ? 'var(--color-gain)' : 'var(--color-loss)');
      sp.classList.add('mkt-spark');
      row.appendChild(sp);
    }
    tile.appendChild(row);
    strip.appendChild(tile);
  }
}

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
      const spark = sparkline(a.equity.slice(-126), 360, 56, seriesColor(a.key));
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
function renderBrief(brief, lamp) {
  const body = document.getElementById('briefBody');
  while (body.firstChild) body.removeChild(body.firstChild);
  const lampEl = document.getElementById('briefLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  document.getElementById('briefStamp').textContent = brief ? brief.generatedAt : '—';
  if (!brief) {
    body.appendChild(el('p', 'stamp', 'No brief for the latest snapshot yet — it generates after each data refresh.'));
    return;
  }
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

  /* equity + brief panels show locked shells */
  lockChartPanel(true);
  renderBrief(null, { cls: 'lamp--locked', text: 'Locked' });
  document.getElementById('briefBody').replaceChildren(el('p', 'stamp', 'Unlocks with the desk PIN.'));
}
function lockChartPanel(locked) {
  const wrap = document.getElementById('equityPanelBody');
  wrap.hidden = locked;
  const lockedMsg = document.getElementById('equityLocked');
  lockedMsg.hidden = !locked;
  const lampEl = document.getElementById('equityLamp');
  if (locked) { lampEl.className = 'lamp lamp--locked'; lampEl.textContent = 'Locked'; }
}

/* ── combined equity chart ─────────────────────────────────────────────── */
const chartGeom = { W: 840, H: 300, padL: 64, padR: 96, padT: 16, padB: 30 };

function activeSeries() {
  const accounts = DESK.data.accounts;
  if (DESK.chart.consolidated) {
    const sum = accounts[0].equity.map((_, i) => accounts.reduce((s, a) => s + a.equity[i], 0));
    return [{ name: 'All accounts', color: 'var(--color-accent-bright)', values: sum }];
  }
  return accounts.map(a => ({ name: a.label, color: seriesColor(a.key), values: a.equity }));
}

function drawChart() {
  const svg = document.getElementById('equityChart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const histLen = DESK.data.accounts[0].equity.length;
  const days = Math.min(DESK.chart.days, histLen);
  const series = activeSeries().map(s => ({ ...s, values: s.values.slice(-days) }));
  const labels = DESK.data.labels.slice(-days);
  const n = series[0].values.length;
  if (n < 2) return;
  const all = series.flatMap(s => s.values);
  const min = Math.min(...all), max = Math.max(...all);
  const span = (max - min) || 1;
  const g = chartGeom;
  const x = i => g.padL + i / (n - 1) * (g.W - g.padL - g.padR);
  const y = v => g.padT + (1 - (v - min) / span) * (g.H - g.padT - g.padB);

  for (let k = 0; k <= 4; k++) {
    const v = min + span * k / 4, gy = y(v);
    svg.appendChild(svgEl('line', { x1: g.padL, x2: g.W - g.padR, y1: gy, y2: gy, stroke: 'var(--color-border)', 'stroke-width': '1' }));
    const t = svgEl('text', { x: g.padL - 8, y: gy + 4, 'text-anchor': 'end', fill: 'var(--color-text-secondary)', 'font-size': '11', 'font-family': 'var(--font-mono)' });
    t.textContent = '$' + Math.round(v / 1000) + 'K';
    svg.appendChild(t);
  }
  for (let k = 0; k <= 3; k++) {
    const i = Math.round((n - 1) * k / 3);
    const t = svgEl('text', { x: x(i), y: g.H - 8, 'text-anchor': k === 0 ? 'start' : k === 3 ? 'end' : 'middle', fill: 'var(--color-text-secondary)', 'font-size': '11', 'font-family': 'var(--font-mono)' });
    t.textContent = labels[i];
    svg.appendChild(t);
  }
  for (const s of series) {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    svg.appendChild(svgEl('path', { d: pathFrom(pts), fill: 'none', stroke: s.color, 'stroke-width': '2', 'stroke-linejoin': 'round' }));
    const last = pts[pts.length - 1];
    const label = svgEl('text', { x: last[0] + 8, y: last[1] + 4, fill: s.color, 'font-size': '11', 'font-weight': '600', 'font-family': 'var(--font-sans)' });
    label.textContent = s.name;
    svg.appendChild(label);
  }
  svg.appendChild(svgEl('line', { id: 'crosshair', x1: 0, x2: 0, y1: g.padT, y2: g.H - g.padB, stroke: 'var(--color-border-hover)', 'stroke-width': '1', 'stroke-dasharray': '3 3', visibility: 'hidden' }));

  DESK.chart._state = { series, labels, n, x };
  renderLegend(series);
  renderDataTable(series, labels);
  updateTimeframeGuard(histLen);
}

function renderLegend(series) {
  const lg = document.getElementById('equityLegend');
  while (lg.firstChild) lg.removeChild(lg.firstChild);
  for (const s of series) {
    const item = el('span');
    const dot = el('span', 'key-dot'); dot.style.background = s.color;
    item.appendChild(dot);
    item.appendChild(el('span', '', s.name));
    lg.appendChild(item);
  }
}

function renderDataTable(series, labels) {
  const table = document.getElementById('equityDataTable');
  while (table.firstChild) table.removeChild(table.firstChild);
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const name of ['Date', ...series.map(s => s.name)]) {
    const th = document.createElement('th');
    th.textContent = name; th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  thead.appendChild(hr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const step = Math.max(1, Math.floor(labels.length / 8));
  for (let i = labels.length - 1; i >= 0; i -= step) {
    const tr = document.createElement('tr');
    const dt = document.createElement('td'); dt.textContent = labels[i]; tr.appendChild(dt);
    for (const s of series) { const td = document.createElement('td'); td.textContent = fmtUsd0(s.values[i]); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function updateTimeframeGuard(histLen) {
  for (const b of document.querySelectorAll('#timeframeSeg button')) {
    const need = Number(b.dataset.days);
    const ok = histLen >= Math.min(need, 9999) || need <= histLen;
    b.disabled = !ok && need > histLen;
    if (b.disabled) b.title = 'Needs ' + need + ' days of history — ' + histLen + ' available so far';
    else b.removeAttribute('title');
  }
}

function wireChart() {
  const svg = document.getElementById('equityChart');
  const tip = document.getElementById('chartTip');
  svg.addEventListener('pointermove', e => {
    const st = DESK.chart._state; if (!st) return;
    const rect = svg.getBoundingClientRect();
    const g = chartGeom;
    const sx = (e.clientX - rect.left) / rect.width * g.W;
    const frac = (sx - g.padL) / (g.W - g.padL - g.padR);
    const i = Math.max(0, Math.min(st.n - 1, Math.round(frac * (st.n - 1))));
    const cx = st.x(i);
    const cross = svg.querySelector('#crosshair');
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('div', 'tip-date', st.labels[i]));
    for (const s of st.series) tip.appendChild(el('div', '', s.name + '  ' + fmtUsd0(s.values[i])));
    tip.style.display = 'block';
    const px = cx / g.W * rect.width;
    tip.style.left = Math.min(px + 12, rect.width - 170) + 'px';
    tip.style.top = '12px';
  });
  svg.addEventListener('pointerleave', () => {
    tip.style.display = 'none';
    const cross = svg.querySelector('#crosshair');
    if (cross) cross.setAttribute('visibility', 'hidden');
  });
  document.getElementById('timeframeSeg').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn || btn.disabled) return;
    for (const b of document.querySelectorAll('#timeframeSeg button')) b.setAttribute('aria-pressed', String(b === btn));
    DESK.chart.days = Number(btn.dataset.days);
    drawChart();
  });
  document.getElementById('consolidateBtn').addEventListener('click', function () {
    DESK.chart.consolidated = !DESK.chart.consolidated;
    this.setAttribute('aria-pressed', String(DESK.chart.consolidated));
    this.textContent = DESK.chart.consolidated ? 'Show accounts separately' : 'Consolidate accounts';
    drawChart();
  });
}

/* ── render orchestration ──────────────────────────────────────────────── */
function renderPrivate() {
  if (DESK.mode === 'demo' || DESK.authed) {
    const lamp = DESK.mode === 'demo'
      ? { cls: 'lamp--demo', text: 'Demo' }
      : lampFor(DESK.privateAsOf, new Date());
    lockChartPanel(false);
    const lampEl = document.getElementById('equityLamp');
    lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
    renderAccounts(DESK.data.accounts, lamp);
    renderBrief(DESK.data.brief, lamp);
    drawChart();
  } else {
    renderLockedPanels();
  }
}

async function loadPrivate(pin) {
  const payload = await deskGetDashboard(pin).catch(() => null);
  if (!payload) { DESK.authed = false; renderLockedPanels(); return; }
  const mapped = mapDashboardPayload(payload);
  DESK.data = { ...DESK.data, accounts: mapped.accounts, labels: mapped.labels, brief: mapped.brief };
  DESK.privateAsOf = mapped.asOf;
  renderPrivate();
}

async function boot() {
  DESK.mode = resolveMode();
  if (DESK.mode === 'demo') {
    DESK.data = buildDemoData();
    renderMasthead();
    renderStrip(DESK.data.market);
    renderNews(DESK.data.news, { cls: 'lamp--demo', text: 'Demo' });
    renderPrivate();
    return;
  }
  /* live: public domains render immediately; private waits for PIN */
  DESK.data = buildDemoData(); /* placeholder series shapes until auth */
  try {
    DESK.meta = await fetchPublic('data/meta.json');
  } catch { DESK.meta = null; }
  /* Public domains: real committed JSON when the pipeline has run; until
     then fall back to clearly-labeled DEMO data (A4 per-domain fallback —
     never an empty strip, never demo masquerading as real). */
  try {
    const market = await fetchPublic('data/market.json');
    renderStrip(market.tiles || []);
  } catch { renderStrip(DESK.data.market); }
  try {
    const news = await fetchPublic('data/news.json');
    renderNews(news.items || [], lampFor(news.asOf, new Date()));
  } catch {
    renderNews(DESK.data.news, { cls: 'lamp--demo', text: 'Demo' });
  }
  renderMasthead();
  const pin = sessionStorage.getItem('desk_pin');
  if (pin) {
    const res = await deskLogin(pin).catch(() => ({ ok: false }));
    if (res && res.ok) { DESK.authed = true; await loadPrivate(pin); renderMasthead(); return; }
    sessionStorage.removeItem('desk_pin');
  }
  renderLockedPanels();
}

wireChart();
boot();
