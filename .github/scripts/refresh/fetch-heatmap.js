'use strict';
/* ── fetch-heatmap.js — S&P 500 day-heat treemap data → data/heatmap.json ────
   Constituents (symbol, name, GICS sector) come from the maintained public
   dataset at github.com/datasets/s-and-p-500-companies at run time; quotes
   via lib/yahoo-batch (v7 crumb dance → day % + market cap; spark fallback
   carries market caps forward from the previous committed heatmap). Domain
   fails ⇒ last committed heatmap.json keeps serving (FR-D4). */
import path from 'node:path';
import { DATA_DIR, retryFetch, writeJson, readJsonIfExists, writeStatus, warn, errorLine, isoDate, lastTradingDay } from './lib/util.js';
import { getCrumb, quoteBatch, sparkBatch, yahooTicker } from './lib/yahoo-batch.js';

const CONSTITUENTS_URL = process.env.SP500_CONSTITUENTS_URL
  || 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';

/* Minimal CSV parse that survives quoted fields ("Amazon.com, Inc."). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

export function parseConstituents(csv) {
  const rows = parseCsv(csv);
  const head = rows[0].map(h => h.trim().toLowerCase());
  const iSym = head.findIndex(h => h === 'symbol');
  const iName = head.findIndex(h => /security|name/.test(h));
  const iSector = head.findIndex(h => /sector/.test(h));
  if (iSym < 0 || iSector < 0) throw new Error('constituents CSV missing symbol/sector columns');
  return rows.slice(1).map(r => ({
    sym: r[iSym].trim().toUpperCase(),
    name: (r[iName] || '').trim(),
    sector: r[iSector].trim(),
  })).filter(c => c.sym && c.sector);
}

/* constituents + quote map → sector-grouped tiles, caps required, sorted. */
export function buildHeatmap(constituents, quotes, prevCaps = new Map()) {
  const bySector = new Map();
  let covered = 0;
  for (const c of constituents) {
    const q = quotes.get(yahooTicker(c.sym)) || quotes.get(c.sym);
    if (!q) continue;
    const cap = q.cap ?? prevCaps.get(c.sym) ?? null;
    if (!cap || !Number.isFinite(q.pct)) continue;
    covered++;
    if (!bySector.has(c.sector)) bySector.set(c.sector, []);
    bySector.get(c.sector).push({ sym: c.sym, name: c.name, cap, pct: q.pct });
  }
  const sectors = [...bySector.entries()]
    .map(([name, tiles]) => ({
      name,
      cap: tiles.reduce((s, t) => s + t.cap, 0),
      tiles: tiles.sort((a, b) => b.cap - a.cap),
    }))
    .sort((a, b) => b.cap - a.cap);
  return { sectors, covered };
}

async function main() {
  const csvRes = await retryFetch(CONSTITUENTS_URL, { headers: { 'user-agent': 'claude.trading data-refresh' } });
  const constituents = parseConstituents(await csvRes.text());
  if (constituents.length < 400) throw new Error(`only ${constituents.length} constituents parsed`);

  const prev = await readJsonIfExists(path.join(DATA_DIR, 'heatmap.json'));
  const prevCaps = new Map((prev?.sectors || []).flatMap(s => s.tiles.map(t => [t.sym, t.cap])));

  let quotes, source = 'yahoo-quote';
  try {
    quotes = await quoteBatch(constituents.map(c => c.sym), await getCrumb());
    if (quotes.size < 300) throw new Error(`quote coverage too thin (${quotes.size})`);
  } catch (e) {
    warn('Heatmap: quote API unavailable', String(e.message || e) + ' — falling back to spark + previous caps');
    quotes = await sparkBatch(constituents.map(c => c.sym));
    source = 'yahoo-spark+prev-caps';
    if (quotes.size < 300) throw new Error(`spark coverage too thin (${quotes.size})`);
  }

  const { sectors, covered } = buildHeatmap(constituents, quotes, prevCaps);
  if (covered < 300) throw new Error(`heatmap coverage too thin after cap merge (${covered})`);

  const asOf = isoDate(lastTradingDay());
  await writeJson(path.join(DATA_DIR, 'heatmap.json'), {
    asOf, generatedAt: new Date().toISOString(), source, count: covered, sectors,
  });
  await writeStatus('heatmap', { status: 'ok', asOf, detail: `${covered} tiles via ${source}` });
  console.log(`heatmap.json written — ${covered} tiles across ${sectors.length} sectors (${source})`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('Heatmap fetch failed', String(err.message || err));
    await writeStatus('heatmap', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
