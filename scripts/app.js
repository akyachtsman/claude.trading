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
  const thread = el('div', 'ask-thread');
  const form = document.createElement('form');
  form.className = 'lock-form'; form.setAttribute('autocomplete', 'off');
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'input'; input.maxLength = 500;
  input.placeholder = 'Ask about this page…';
  input.setAttribute('aria-label', 'Ask a question about the dashboard');
  const btn = el('button', 'btn', 'Ask'); btn.type = 'submit';
  const err = el('p', 'lock-error', ''); err.hidden = true;
  form.appendChild(input); form.appendChild(btn);
  body.appendChild(thread); body.appendChild(form); body.appendChild(err);
  body.appendChild(el('p', 'ai-disclaimer',
    'Answers come from the page’s current snapshot only. AI-generated; can make mistakes. Not financial advice.'));

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Asking…'; input.disabled = true;
    thread.appendChild(el('p', 'ask-q', q));
    thread.scrollTop = thread.scrollHeight;
    const pin = sessionStorage.getItem('desk_pin');
    const res = await deskAsk(pin, q, buildAskContext())
      .catch(() => ({ ok: false, error: 'Could not reach the ask service — try again in a moment.' }));
    btn.disabled = false; btn.textContent = 'Ask'; input.disabled = false;
    if (res && res.ok) {
      thread.appendChild(el('p', 'ask-a', res.answer));
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

  /* equity + brief + ask panels show locked shells */
  lockChartPanel(true);
  renderBrief(null, { cls: 'lamp--locked', text: 'Locked' });
  document.getElementById('briefBody').replaceChildren(el('p', 'stamp', 'Unlocks with the desk PIN.'));
  renderAsk();
}
function lockChartPanel(locked) {
  const wrap = document.getElementById('equityPanelBody');
  wrap.hidden = locked;
  const lockedMsg = document.getElementById('equityLocked');
  lockedMsg.hidden = !locked;
  const lampEl = document.getElementById('equityLamp');
  if (locked) { lampEl.className = 'lamp lamp--locked'; lampEl.textContent = 'Locked'; }
  /* dead controls disappear with the data they act on */
  document.querySelector('.chart-head-tools').hidden = locked;
  document.getElementById('consolidateBtn').hidden = locked;
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
  if (!DESK.data.accounts.length) return; /* authed, zero history yet */
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
  cap: 3,
  canvas: '#262931',         /* mosaic backdrop */
  label: '#CBD2DE',          /* sector/band captions on the dark canvas */
  band: '#31353F',           /* sub-industry band fill */
  focus: '#FDE047',          /* hover outline for the industry group */
  ink: '#FFFFFF',            /* tile label ink — consistently white (owner, 2026-07-12) */
  halo: '#23262D',           /* solid stroke behind every glyph; white-vs-halo is the AA pair */
};

function heatRGB(pct) {
  const s = HEAT.stops;
  const p = Math.max(s[0][0], Math.min(s[s.length - 1][0], pct));
  let i = 0;
  while (i < s.length - 2 && p > s[i + 1][0]) i++;
  const [p0, c0] = s[i], [p1, c1] = s[i + 1];
  const t = (p - p0) / (p1 - p0);
  return c0.map((c, k) => Math.round(c + (c1[k] - c) * t));
}
const heatColor = pct => 'rgb(' + heatRGB(pct).join(',') + ')';
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

function renderHeatmap(hm, lamp) {
  heatState = { hm, lamp };
  const svg = document.getElementById('heatmapSvg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const lampEl = document.getElementById('heatLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  document.getElementById('heatStamp').textContent = hm ? 'As of ' + hm.asOf : '—';
  if (!hm || !hm.sectors || !hm.sectors.length) {
    document.getElementById('heatSource').textContent = 'No heatmap in the latest snapshot — it fills in after the next refresh.';
    return;
  }
  /* Render at the container's true pixel size (the panel now lives in the
     main column, not full-width): 1 viewBox unit = 1 rendered px, so label
     px thresholds are honest and text isn't stretched by aspect mismatch. */
  const W = Math.max(320, Math.round(svg.parentElement.clientWidth || 1200));
  const H = Math.round(Math.min(Math.max(W * 0.62, 420), 640));
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
  const groupRects = new Map();
  const bandEls = new Map();   /* sector|ind → {rect, text} for the lit-band hover */
  let litBand = null;
  const focusGroup = svgEl('rect', { fill: 'none', stroke: HEAT.focus, 'stroke-width': 2, rx: 2, visibility: 'hidden', 'pointer-events': 'none' });
  const focusTile = svgEl('rect', { fill: 'none', stroke: '#FFFFFF', 'stroke-width': 1.5, rx: 2, visibility: 'hidden', 'pointer-events': 'none' });
  const unlightBand = () => {
    if (!litBand) return;
    litBand.rect.setAttribute('fill', HEAT.band);
    litBand.text.setAttribute('fill', HEAT.label);
    litBand = null;
  };

  /* finviz-style hover card: SECTOR — INDUSTRY header, the hovered stock in
     bold with last price + full name, then its industry peers by cap. */
  const showPeers = (t, sector, px, py) => {
    const key = sector.name + '|' + (t.ind || '');
    unlightBand();
    const band = bandEls.get(key);   /* light the industry caption, finviz-style */
    if (band) {
      band.rect.setAttribute('fill', HEAT.focus);
      band.text.setAttribute('fill', '#111111');
      litBand = band;
    }
    const g = groupRects.get(key);
    if (g) {
      focusGroup.setAttribute('x', g.x + 1); focusGroup.setAttribute('y', g.y + 1);
      focusGroup.setAttribute('width', Math.max(g.w - 2, 1)); focusGroup.setAttribute('height', Math.max(g.h - 2, 1));
      focusGroup.setAttribute('visibility', 'visible');
    }
    focusTile.setAttribute('x', t.x + 1); focusTile.setAttribute('y', t.y + 1);
    focusTile.setAttribute('width', Math.max(t.w - 2, 1)); focusTile.setAttribute('height', Math.max(t.h - 2, 1));
    focusTile.setAttribute('visibility', 'visible');

    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.appendChild(el('div', 'tip-head', (sector.name + (t.ind ? ' — ' + t.ind : '')).toUpperCase()));
    const dir = p => p > 0 ? 'up' : p < 0 ? 'down' : '';
    const cur = el('div', 'tip-main');
    cur.appendChild(el('span', 'tip-sym', t.sym));
    if (Number.isFinite(t.last)) cur.appendChild(el('span', 'tip-price ' + dir(t.pct), fmtPrice(t.last)));
    cur.appendChild(el('span', dir(t.pct), fmtPct(t.pct)));
    tip.appendChild(cur);
    tip.appendChild(el('div', 'tip-name', (t.name && t.name !== t.sym ? t.name + ' · ' : '') + fmtCap(t.cap)));
    const peers = sector.tiles
      .filter(p => (t.ind ? p.ind === t.ind : true))
      .sort((a, b) => b.cap - a.cap).slice(0, 8);
    for (const p of peers) {
      const row = el('div', 'tip-row' + (p.sym === t.sym ? ' tip-cur' : ''));
      row.appendChild(el('span', '', p.sym));
      row.appendChild(el('span', 'tip-price', Number.isFinite(p.last) ? fmtPrice(p.last) : ''));
      row.appendChild(el('span', dir(p.pct), fmtPct(p.pct)));
      tip.appendChild(row);
    }
    tip.style.display = 'block';
    const wrap = svg.parentElement.getBoundingClientRect();
    const sx = wrap.width / W, sy = wrap.height / H;
    tip.style.left = Math.min(px * sx + 8, wrap.width - 250) + 'px';
    tip.style.top = Math.min(Math.max(py * sy - 8, 0), wrap.height - 40) + 'px';
  };
  const hideHover = () => {
    tip.style.display = 'none';
    unlightBand();
    focusGroup.setAttribute('visibility', 'hidden');
    focusTile.setAttribute('visibility', 'hidden');
  };

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
      rect.addEventListener('pointerenter', () => showPeers(t, sector, t.x + t.w, t.y));
      rect.addEventListener('pointerleave', hideHover);
    }
  };

  const sectorRects = squarify(hm.sectors.map(s => ({ ...s, value: s.cap })), 0, 0, W, H);
  for (const s of sectorRects) {
    if (s.w < 4 || s.h < HEAD + 6) continue;
    if (s.w > 64 && s.h > 40) {
      /* solid header strip (finviz) instead of a floating caption */
      svg.appendChild(svgEl('rect', { x: s.x + 1, y: s.y + 1, width: Math.max(s.w - 2, 1), height: HEAD - 2, fill: '#1E2129' }));
      const label = svgEl('text', { x: s.x + 5, y: s.y + 12, fill: '#D9DEE8', 'font-size': '10', 'font-weight': '600', 'font-family': 'var(--font-sans)', 'letter-spacing': '.05em' });
      label.textContent = s.name.toUpperCase().slice(0, Math.floor(s.w / 7));
      svg.appendChild(label);
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
        groupRects.set(s.name + '|' + g.ind, { x: g.x, y: g.y, w: g.w, h: g.h });
        const hasBand = g.w > 58 && g.h > 40;
        if (hasBand) {
          const bandRect = svgEl('rect', { x: g.x + 1, y: g.y + 1, width: Math.max(g.w - 2, 1), height: BAND, fill: HEAT.band });
          svg.appendChild(bandRect);
          const bl = svgEl('text', { x: g.x + 4, y: g.y + 9, fill: HEAT.label, 'font-size': '7', 'font-weight': '600', 'font-family': 'var(--font-sans)', 'letter-spacing': '.04em' });
          bl.textContent = g.ind.toUpperCase().slice(0, Math.floor(g.w / 5));
          svg.appendChild(bl);
          bandEls.set(s.name + '|' + g.ind, { rect: bandRect, text: bl });
        }
        drawTiles(g.tiles, g.x, g.y + (hasBand ? BAND + 1 : 0), g.w, g.h - (hasBand ? BAND + 1 : 0), s);
      }
    } else {
      for (const g of groups) groupRects.set(s.name + '|' + g.ind, { x: body.x, y: body.y, w: body.w, h: body.h });
      drawTiles(s.tiles, body.x, body.y, body.w, body.h, s);
    }
  }
  svg.appendChild(focusGroup);
  svg.appendChild(focusTile);
  renderHeatLegend();
  renderHeatTable(hm);
}

function renderHeatLegend() {
  const lg = document.getElementById('heatLegend');
  while (lg.firstChild) lg.removeChild(lg.firstChild);
  lg.appendChild(el('span', '', '−' + HEAT.cap + '%'));
  for (let p = -HEAT.cap; p <= HEAT.cap; p += 1) {
    const sw = el('span', 'swatch');
    sw.style.background = heatColor(p);
    lg.appendChild(sw);
  }
  lg.appendChild(el('span', '', '+' + HEAT.cap + '%'));
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

/* ── MAP FILTER side panel (finviz-parity; owner request 2026-07-13) ─────
   Live cuts derive from data already on hand: index rosters intersect the
   S&P dataset (config/map-filters.json, owner-editable), the ETF map reads
   the charts histories (which also unlock multi-period performance).
   Russell 2000 / World / Crypto / Futures / Themes need new pipeline
   feeds — shown disabled until the owner asks to wire them. */
const MAP_CUTS = [
  ['sp500', 'S&P 500', 'live'],
  ['dj30', 'Dow Jones 30', 'roster'],
  ['ndx100', 'Nasdaq 100', 'roster'],
  ['etf', 'ETFs', 'live'],
  ['themes', 'Themes', 'roster'],
  ['world', 'World', 'extra'],
  ['crypto', 'Crypto', 'extra'],
  ['futures', 'Futures', 'extra'],
  ['r2k', 'Russell 2000', 'pending'],
];
const MAP_PERIODS = [['1d', '1-Day Performance'], ['1w', '1-Week Performance'], ['1m', '1-Month Performance'], ['ytd', 'YTD Performance']];
let heatBase = null;                        /* raw dataset + lamp from loadHeatmap */
let heatExtra = null;                       /* data/maps-extra.json (crypto/futures/world) */
let mapView = { key: 'sp500', period: '1d', filters: null };

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
  let out = heatBase.hm;
  let lamp = heatBase.lamp;
  let note = 'Sized by market cap · colored by day % change';
  if (mapView.key === 'dj30' || mapView.key === 'ndx100') {
    const set = new Set((mapView.filters || {})[mapView.key] || []);
    const sectors = out.sectors.map(s => {
      const tiles = s.tiles.filter(t => set.has(t.sym) || set.has(t.sym.replace('.', '-')));
      return { name: s.name, cap: tiles.reduce((a, t) => a + t.cap, 0), tiles };
    }).filter(s => s.tiles.length).sort((a, b) => b.cap - a.cap);
    out = { ...out, sectors };
    note = 'Hand-kept roster ∩ dataset (' + sectors.reduce((a, s) => a + s.tiles.length, 0) + ' names) · sized by cap · day %';
  } else if (mapView.key === 'etf') {
    const periodLabel = (MAP_PERIODS.find(([k]) => k === mapView.period) || [])[1];
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
    note = 'Hand-kept theme baskets over the S&P dataset · sized by cap · day %';
  } else if (mapView.key === 'crypto' || mapView.key === 'futures' || mapView.key === 'world') {
    const cut = heatExtra && heatExtra.cuts && heatExtra.cuts[mapView.key];
    out = cut ? { asOf: heatExtra.asOf, sectors: cut.sectors } : null;
    lamp = cut ? lampFor(heatExtra.asOf, new Date()) : lamp;
    note = !cut ? 'This universe fills in after the next nightly refresh'
      : mapView.key === 'crypto' ? 'Sized by market cap · colored by day % change'
      : 'Hand-weighted tiles (config/map-filters.json) · colored by day % change';
  }
  document.getElementById('heatTitle').textContent = label + ' — heat';
  renderHeatmap(out, lamp);
  document.getElementById('heatSource').textContent = note;
  /* period choices: multi-period needs per-name history, which only the
     ETF cut has today; stock cuts stay 1-day until a history feed lands */
  const sel = document.getElementById('heatPeriod');
  for (const opt of sel.options) opt.disabled = mapView.key !== 'etf' && opt.value !== '1d';
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
    if (kind === 'pending') {
      b.disabled = true;
      b.title = 'Needs a new data feed — ask the desk to wire it';
    } else if (kind === 'extra') {
      b.disabled = true;                       /* enabled once maps-extra.json loads */
      b.title = 'Fills in after the next nightly refresh';
      b.dataset.extra = '1';
      b.addEventListener('click', () => {
        mapView.key = key;
        mapView.period = '1d';
        for (const other of nav.children) other.setAttribute('aria-current', String(other === b));
        applyMapView();
      });
    } else {
      b.addEventListener('click', () => {
        mapView.key = key;
        if (key !== 'etf') mapView.period = '1d';
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

async function loadHeatmap() {
  if (!mapView.filters) {
    try { mapView.filters = await fetchPublic('config/map-filters.json'); }
    catch { mapView.filters = {}; }
  }
  /* Fetch the file only once meta says the pipeline has published it — a
     404 would log a console error (fails test S1) even when handled. */
  const mapsPublished = DESK.meta && DESK.meta.domains && DESK.meta.domains.maps
    && DESK.meta.domains.maps.asOf;
  if (DESK.mode !== 'demo' && mapsPublished && !heatExtra) {
    try {
      heatExtra = await fetchPublic('data/maps-extra.json');
      for (const b of document.querySelectorAll('.map-filter-btn[data-extra]')) {
        b.disabled = false;
        b.removeAttribute('title');
      }
    } catch { /* extra cuts stay disabled */ }
  }
  const published = DESK.meta && DESK.meta.domains && DESK.meta.domains.heatmap
    && DESK.meta.domains.heatmap.asOf;
  if (DESK.mode !== 'demo' && published) {
    try {
      const hm = await fetchPublic('data/heatmap.json');
      heatBase = { hm, lamp: lampFor(hm.asOf, new Date()) };
      applyMapView();
      return;
    } catch { /* fall through to demo-labeled */ }
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
const WB = { up: 'var(--color-gain)', down: 'var(--color-loss)', kLine: 'var(--color-series-1)', dLine: 'var(--color-series-2)', grid: 'var(--color-border)', label: 'var(--color-text-secondary)' };
const WB_ZOOMS = [['1M', 21], ['3M', 63], ['6M', 126], ['YTD', 'ytd'], ['1Y', 252], ['All', 9999]];
const WB2_ZOOMS = [['6M', 26], ['1Y', 52], ['All', 9999]];  /* Pro 2 window, in weekly bars */
const WB3_ZOOMS = [['5D', 5], ['10D', 10], ['1M', 21]];     /* Pro 3 window, in daily bars */

/* per-pane configuration (their settings menu, in our idiom) — persisted */
const WB_CFG_KEY = 'wb_cfg_v2';
const WB_CFG_DEFAULT = () => ({
  p1: { type: 'candle', bb: false, vol: true, stoch: true, stochW: false, smas: { 1: false, 25: true, 50: true, 100: false, 200: false }, sr: { 1: true, 2: false, 3: true }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
  p2: { type: 'candle', bb: false, vol: true, stoch: true, stochW: false, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
  /* Pro 3 = day trading: Bollinger Bands on by default, slim settings (owner ruling) */
  p3: { type: 'candle', bb: true, vol: true, stoch: true, stochW: false, smas: { 1: false, 25: false, 50: false, 100: false, 200: false }, sr: { 1: false, 2: false, 3: false }, smaPrice: { 1: false, 25: false, 50: false, 100: false, 200: false } },
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
const SMA_COLORS = { 1: 'var(--color-text-primary)', 25: 'var(--color-series-3)', 50: 'var(--color-accent-bright)', 100: 'var(--color-series-2)', 200: 'var(--color-text-secondary)' };
const ytdBars = bars => { const y = bars.t[bars.t.length - 1].slice(0, 4); let n = 0; for (let i = bars.t.length - 1; i >= 0 && bars.t[i].slice(0, 4) === y; i--) n++; return Math.max(n, 5); };
const paneWindow = (spec, bars) => spec === 'ytd' ? ytdBars(bars) : spec;
let wbState = null;   /* { data, lamp, sym, days, wdays, off, woff, layout, cfg } */

/* drag-to-pan lives at window level so the SVG rebuild mid-drag (each pan
   frame re-renders) can't drop the pointer stream */
let wbDrag = null, wbPanRaf = 0;
window.addEventListener('pointermove', ev => {
  if (!wbDrag || !wbState) return;
  const next = Math.min(wbDrag.max, Math.max(0, wbDrag.off0 + Math.round((ev.clientX - wbDrag.x0) / wbDrag.slotPx)));
  if (next !== wbState[wbDrag.key]) {
    wbState[wbDrag.key] = next;
    cancelAnimationFrame(wbPanRaf);
    wbPanRaf = requestAnimationFrame(() => renderCharts(wbState.data, wbState.lamp));
  }
});
window.addEventListener('pointerup', () => { wbDrag = null; });

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
/* Weekly stochastic projected onto daily bars (step lines): each daily bar
   carries the last COMPLETED week's %K/%D — matches how the reference
   platform overlays its weekly stochastic on the daily tier. */
function weeklyStochOnDaily(daily) {
  const wk = toWeeklyBars(daily);
  const wst = stochSeries(wk);
  const k = new Array(daily.c.length).fill(null);
  const d = new Array(daily.c.length).fill(null);
  let wi = -1;
  for (let i = 0; i < daily.c.length; i++) {
    while (wi + 1 < wk.t.length && wk.t[wi + 1] <= daily.t[i]) wi++;
    if (wi >= 0) { k[i] = wst.k[wi]; d[i] = wst.d[wi]; }
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
    b.addEventListener('click', () => {
      wbState.sym = sym;
      wbState.off = wbState.woff = wbState.off3 = 0;
      renderCharts(wbState.data, wbState.lamp);
    });
    nav.appendChild(b);
  }
}

/* ── the two-tier workbench: Pro 1 (daily, short-term) · Pro 2 (weekly,
   long-term) side by side in one SVG, per the three-tier doctrine. Pro 3
   (intraday) awaits the quote-proxy backend. ─────────────────────────── */
function renderCharts(data, lamp) {
  wbState = wbState && wbState.data === data ? wbState : { data, lamp, sym: Object.keys(data.symbols)[0], days: 63, wdays: 9999, days3: 10, off: 0, woff: 0, off3: 0, layout: 'split', cfg: loadWbCfg() };
  wbState.lamp = lamp;
  const lampEl = document.getElementById('chartsLamp');
  lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
  document.getElementById('chartsStamp').textContent = data ? 'As of ' + data.asOf : '—';

  /* the symbol box is a typeable combobox: datalist suggests the roster,
     free entry goes through the quote-proxy (wireCharts submit handler) */
  const list = document.getElementById('wbSymList');
  const roster = Object.keys(data.symbols);
  if (list.children.length !== roster.length) {
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const sym of roster) {
      const o = document.createElement('option');
      o.value = sym;
      list.appendChild(o);
    }
  }
  const symBox = document.getElementById('wbSymInput');
  if (document.activeElement !== symBox) symBox.value = wbState.sym;
  renderWbSidebar(data);

  const svg = document.getElementById('wbChart');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const tip = document.getElementById('wbTip');
  const s = data.symbols[wbState.sym];
  if (!s || s.c.length < 30) return;

  const W = Math.max(480, Math.round(svg.parentElement.clientWidth || 900));
  const H = 560;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.style.height = H + 'px';

  const GAP = 16;
  const line = (x1, y1, x2, y2, attrs) => svg.appendChild(svgEl('line', { x1, y1, x2, y2, ...attrs }));
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
    if (opts.cfg.stochW && opts.stW) strips.push(['weekly', opts.stW, opts.stochWCaption || 'STOCH 13-3-3 · WEEKLY (13)', false]);
    const vH = opts.cfg.vol ? 50 : 0;
    const sH = strips.length === 2 ? 68 : 88;
    const pY = 22;
    const pH = H - pY - 30 - (vH ? vH + 8 : 0) - strips.length * (sH + 14);
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

    const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 3)));
    const tick = (hi - lo) / step > 6 ? step * 2 : step;
    for (let v = Math.ceil(lo / tick) * tick; v < hi; v += tick) {
      line(x0 + 6, py(v), x0 + 6 + plotW, py(v), { stroke: WB.grid, 'stroke-width': 1 });
      text(fmtPrice(v), x0 + 6 + plotW + 4, py(v) + 3, { 'font-size': 9 });
    }
    for (const [name, v] of pivots) {
      line(x0 + 6, py(v), x0 + 6 + plotW, py(v), { stroke: 'var(--color-accent)', 'stroke-width': 1, 'stroke-dasharray': '5 4', 'stroke-opacity': 0.7 });
      text(name + ' ' + fmtPrice(v), x0 + 8, py(v) - 3, { fill: 'var(--color-accent)', 'font-size': 9 });
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
        svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: py(Math.max(bars.o[i], bars.c[i])), width: bodyW, height: Math.max(1, Math.abs(py(bars.o[i]) - py(bars.c[i]))), fill: col }));
      }
      if (vMax) svg.appendChild(svgEl('rect', { x: cx - bodyW / 2, y: vY + vH - (bars.v[i] / vMax) * vH, width: bodyW, height: (bars.v[i] / vMax) * vH, fill: col, 'fill-opacity': 0.55 }));
    }
    /* line style draws closes in gain-green, like the reference platform */
    if (closeD) svg.appendChild(svgEl('path', { d: closeD, fill: 'none', stroke: WB.up, 'stroke-width': 1.5 }));
    if (opts.cfg.vol) text('VOL', x0 + 6, vY + 8, { 'font-size': 8, 'letter-spacing': '.08em' });

    /* stochastic strips (native + optional weekly) + doctrine markers */
    strips.forEach(([which, series, capText, withMarks], si) => {
      const yTop = stripTops[si];
      const sy = v => yTop + sH - v / 100 * sH;
      for (const g of [20, 80]) {
        line(x0 + 6, sy(g), x0 + 6 + plotW, sy(g), { stroke: WB.grid, 'stroke-width': 1, 'stroke-dasharray': '3 3' });
        text(String(g), x0 + 6 + plotW + 4, sy(g) + 3, { 'font-size': 9 });
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

    /* month gridlines (labels only where they have ≥48px of room) */
    let lastLabelX = -Infinity;
    for (let i = i0 + 1; i < end; i++) {
      if (bars.t[i].slice(0, 7) !== bars.t[i - 1].slice(0, 7)) {
        const gx = x(i) - slotW / 2;
        line(gx, pY, gx, chartBot, { stroke: WB.grid, 'stroke-width': 1, 'stroke-opacity': 0.5 });
        if (gx - lastLabelX >= 48) {
          text(bars.t[i].slice(0, 7), gx + 2, H - 4, { 'font-size': 8 });
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
      tip.appendChild(el('div', 'tip-date', bars.t[i] + ' · ' + (opts.sym || wbState.sym) + ' · ' + opts.tier));
      const chg = i > 0 ? (bars.c[i] / bars.c[i - 1] - 1) * 100 : 0;
      tip.appendChild(el('div', '', 'O ' + fmtPrice(bars.o[i]) + '  H ' + fmtPrice(bars.h[i]) + '  L ' + fmtPrice(bars.l[i])));
      const cRow = el('div', '', 'C ' + fmtPrice(bars.c[i]) + ' ');
      cRow.appendChild(el('span', chg > 0 ? 'up' : chg < 0 ? 'down' : '', fmtPct(chg)));
      tip.appendChild(cRow);
      tip.appendChild(el('div', '', 'Vol ' + fmtVol(bars.v[i])));
      const smaParts = [];
      for (const [len] of opts.smas || []) {
        if (i < len - 1) continue;
        let sum = 0;
        for (let j = i - len + 1; j <= i; j++) sum += bars.c[j];
        smaParts.push('SMA' + len + ' ' + fmtPrice(sum / len));
      }
      if (smaParts.length) tip.appendChild(el('div', '', smaParts.join(' · ')));
      if (st.k[i] != null) tip.appendChild(el('div', '', 'Stoch %K ' + st.k[i].toFixed(0) + ' · %D ' + (st.d[i] == null ? '—' : st.d[i].toFixed(0))));
      if (opts.cfg.stochW && opts.stW && opts.stW.k[i] != null) tip.appendChild(el('div', '', 'Weekly %K ' + opts.stW.k[i].toFixed(0) + ' · %D ' + (opts.stW.d[i] == null ? '—' : opts.stW.d[i].toFixed(0))));
      tip.style.display = 'block';
      const wrap = svg.parentElement.getBoundingClientRect();
      const sx = wrap.width / W;
      tip.style.left = Math.min(x(i) * sx + 10, wrap.width - 190) + 'px';
      tip.style.top = '16px';
    });
    overlay.addEventListener('pointerleave', hideTip);
  };

  const smaList = cfg => Object.entries(cfg.smas).filter(([, on]) => on).map(([len]) => [Number(len), SMA_COLORS[len]]);
  const show = p => wbState.layout === 'split' || wbState.layout === p;
  /* each pane may pin its own ticker (cfg.sym); empty = follow the desk
     symbol. Guarded against symbols missing from the loaded roster. */
  const effSym = cfg => (cfg.sym && data.symbols[cfg.sym] && data.symbols[cfg.sym].c.length >= 30) ? cfg.sym : wbState.sym;
  const dailyCache = {};
  const daily = sym => dailyCache[sym] || (dailyCache[sym] = (() => {
    const bars = data.symbols[sym];
    return { bars, st: stochSeries(bars), piv: monthlyPivots(bars) };
  })());
  const panes = [];
  if (show('p1')) {
    const sym = effSym(wbState.cfg.p1);
    const d = daily(sym);
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 1 · DAILY · ' + sym, {
      window: paneWindow(wbState.days, d.bars), offset: wbState.off, panKey: 'off',
      tier: 'Pro 1', sym, cfg: wbState.cfg.p1,
      pivots: d.piv, smas: smaList(wbState.cfg.p1),
      stW: wbState.cfg.p1.stochW ? weeklyStochOnDaily(d.bars) : null,
      stochCaption: 'STOCH 13-3-3 · DAILY',
    }]);
  }
  if (show('p2')) {
    const sym = effSym(wbState.cfg.p2);
    const d = daily(sym);
    const wk = toWeeklyBars(d.bars);
    const wst = stochSeries(wk);
    panes.push([wk, wst, stochMarks(wst), 'PRO 2 · WEEKLY · ' + sym, {
      window: paneWindow(wbState.wdays, wk), offset: wbState.woff, panKey: 'woff',
      tier: 'Pro 2', sym, cfg: wbState.cfg.p2,
      pivots: d.piv, smas: smaList(wbState.cfg.p2),
      stW: wbState.cfg.p2.stochW ? wst : null,
      stochCaption: 'STOCH 13-3-3 · WEEKLY (13)',
    }]);
  }
  /* Pro 3 = the day-trading tier; honest EOD placeholder (tight daily
     window) until the intraday quote-proxy backend is approved */
  if (show('p3')) {
    const sym = effSym(wbState.cfg.p3);
    const d = daily(sym);
    panes.push([d.bars, d.st, stochMarks(d.st), 'PRO 3 · DAY TRADING · ' + sym + ' EOD', {
      window: paneWindow(wbState.days3, d.bars), offset: wbState.off3, panKey: 'off3',
      tier: 'Pro 3', sym, cfg: wbState.cfg.p3,
      pivots: d.piv, smas: smaList(wbState.cfg.p3),
      stW: wbState.cfg.p3.stochW ? weeklyStochOnDaily(d.bars) : null,
      stochCaption: 'STOCH 13-3-3 · DAILY (INTRADAY PENDING)',
    }]);
  }
  for (const k of ['p1', 'p2', 'p3']) document.getElementById('wbBar-' + k).hidden = !show(k);
  const pw = (W - GAP * (panes.length - 1)) / panes.length;
  panes.forEach((p, idx) => drawPane(idx * (pw + GAP), pw, ...p));
  for (let idx = 1; idx < panes.length; idx++) {
    line(idx * (pw + GAP) - GAP / 2, 8, idx * (pw + GAP) - GAP / 2, H - 8, { stroke: WB.grid, 'stroke-width': 1 });
  }
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
    const title = { p1: 'PRO 1 · DAILY', p2: 'PRO 2 · WEEKLY', p3: 'PRO 3 · DAY TRADING' }[key];
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
    /* Pro 3 (day trading) keeps a slim panel by owner ruling: Bollinger
       Bands / Volume / Stochastic only. Pro 1/2 carry the full set. */
    const full = key !== 'p3';
    const ind = [
      ['Bollinger Bands', () => cfg.bb, v => { cfg.bb = v; }],
      ['Volume', () => cfg.vol, v => { cfg.vol = v; }],
      ['Stochastic', () => cfg.stoch, v => { cfg.stoch = v; }],
    ];
    if (full) ind.push(['Stochastic weekly', () => cfg.stochW, v => { cfg.stochW = v; }]);
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
  wireZoom('chartZoom2', WB2_ZOOMS, 9999, spec => { wbState.wdays = spec; wbState.woff = 0; });
  wireZoom('chartZoom3', WB3_ZOOMS, 10, spec => { wbState.days3 = spec; wbState.off3 = 0; });

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

  /* Symbol combobox: roster picks (typed or datalist) switch instantly;
     unknown tickers go through the PIN-gated quote-proxy in live mode
     (demo/locked ⇒ note). */
  const symForm = document.getElementById('wbSymForm');
  const symInput = document.getElementById('wbSymInput');
  const symNote = document.getElementById('wbSymNote');
  symInput.addEventListener('change', () => {
    if (!wbState) return;
    const sym = symInput.value.trim().toUpperCase();
    if (sym !== wbState.sym && wbState.data.symbols[sym]) {
      symNote.textContent = '';
      wbState.sym = sym;
      wbState.off = wbState.woff = wbState.off3 = 0;
      renderCharts(wbState.data, wbState.lamp);
    }
  });
  symForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (!wbState) return;
    const sym = symInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9.^-]{1,10}$/.test(sym)) { symNote.textContent = 'Ticker not recognized'; return; }
    const pick = () => {
      wbState.sym = sym;
      wbState.off = wbState.woff = wbState.off3 = 0;
      renderCharts(wbState.data, wbState.lamp);
    };
    if (wbState.data.symbols[sym]) { symNote.textContent = ''; pick(); return; }
    if (DESK.mode === 'demo' || !DESK.authed) {
      symNote.textContent = 'Unlock the desk to load tickers beyond the watchlist';
      return;
    }
    symNote.textContent = 'Loading ' + sym + '…';
    try {
      const out = await deskQuote(sessionStorage.getItem('desk_pin'), sym, 'daily');
      if (!out.ok || !out.series || out.series.c.length < 30) {
        symNote.textContent = out.error || 'No data found for ' + sym;
        return;
      }
      wbState.data.symbols[sym] = out.series;
      symNote.textContent = sym + ' · live fetch · as of ' + out.asOf;
      pick();
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
  const published = DESK.meta && DESK.meta.domains && DESK.meta.domains.charts
    && DESK.meta.domains.charts.asOf;
  if (DESK.mode !== 'demo' && published) {
    try {
      const data = await fetchPublic('data/charts.json');
      renderCharts(data, lampFor(data.asOf, new Date()));
      return;
    } catch { /* fall through to demo-labeled */ }
  }
  renderCharts(buildDemoCharts(), { cls: 'lamp--demo', text: 'Demo' });
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
      : lampFor(DESK.privateAsOf, new Date());
    lockChartPanel(false);
    const lampEl = document.getElementById('equityLamp');
    lampEl.className = 'lamp ' + lamp.cls; lampEl.textContent = lamp.text;
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
    drawChart();
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
    loadHeatmap();
    loadCharts();
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
    DESK.data.market = market.tiles || []; /* real tiles feed the ask context too */
    renderStrip(DESK.data.market);
  } catch { renderStrip(DESK.data.market); }
  try {
    const news = await fetchPublic('data/news.json');
    DESK.data.news = news.items || [];
    renderNews(DESK.data.news, lampFor(news.asOf, new Date()));
  } catch {
    renderNews(DESK.data.news, { cls: 'lamp--demo', text: 'Demo' });
  }
  renderMasthead();
  loadHeatmap();
  loadCharts();
  const pin = sessionStorage.getItem('desk_pin');
  if (pin) {
    const res = await deskLogin(pin).catch(() => ({ ok: false }));
    if (res && res.ok) { DESK.authed = true; await loadPrivate(pin); renderMasthead(); return; }
    sessionStorage.removeItem('desk_pin');
  }
  renderLockedPanels();
}

wireChart();
wireCharts();
wireMapFilter();
boot();
