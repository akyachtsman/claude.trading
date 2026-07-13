'use strict';
/* ── fetch-maps.js — extra MAP FILTER universes → data/maps-extra.json ──────
   Feeds the heatmap side panel's Crypto / Futures / World cuts. Rosters and
   hand weights live in config/map-filters.json ("extra" key, owner-editable):
   crypto tiles size by Yahoo market cap, futures/world have no cap so the
   config weight (× $1B) sets tile area. Runs on the same v7 crumb batch the
   heatmap uses (~1 call for ~40 symbols). A cut below half coverage is
   dropped for the run; zero cuts ⇒ status failed and the last committed
   maps-extra.json keeps serving (FR-D4). */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { DATA_DIR, writeJson, writeStatus, warn, errorLine, isoDate, lastTradingDay } from './lib/util.js';
import { getCrumb, quoteBatch, sparkBatch } from './lib/yahoo-batch.js';

const CONFIG_URL = new URL('../../../config/map-filters.json', import.meta.url);

/* rosters + quote map → { cutKey: { covered, sectors } } (heatmap shape) */
export function buildMapCuts(extra, quotes) {
  const cuts = {};
  for (const [cutKey, roster] of Object.entries(extra)) {
    const groups = new Map();
    let covered = 0;
    for (const [ysym, sym, name, group, weight] of roster) {
      const q = quotes.get(ysym);
      if (!q || !Number.isFinite(q.pct)) continue;
      covered++;
      const cap = (cutKey === 'crypto' && q.cap) ? q.cap : (weight || 1) * 1e9;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push({ sym, name, cap, pct: q.pct, ind: '', last: q.last });
    }
    if (covered < Math.ceil(roster.length / 2)) continue;
    cuts[cutKey] = {
      covered,
      sectors: [...groups.entries()]
        .map(([name, tiles]) => ({
          name,
          cap: tiles.reduce((s, t) => s + t.cap, 0),
          tiles: tiles.sort((a, b) => b.cap - a.cap),
        }))
        .sort((a, b) => b.cap - a.cap),
    };
  }
  return cuts;
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  const extra = cfg.extra || {};
  const symbols = Object.values(extra).flat().map(r => r[0]);
  if (!symbols.length) throw new Error('no extra rosters configured in map-filters.json');
  /* v7 crumb path first (gives crypto market caps); GitHub runner IPs are
     routinely 429'd on getcrumb, so the crumbless v8 spark is the fallback
     (pct + last only — tiles then size by the config weights). */
  let quotes = new Map();
  try {
    const auth = await getCrumb();
    quotes = await quoteBatch(symbols, auth, 50);
  } catch (e) {
    warn('maps v7 quote path failed', String(e.message || e));
  }
  if (quotes.size < Math.ceil(symbols.length / 2)) {
    warn('maps falling back to spark', `${quotes.size}/${symbols.length} via v7`);
    const spark = await sparkBatch(symbols, 20);
    for (const [sym, q] of spark) if (!quotes.has(sym)) quotes.set(sym, { pct: q.pct, cap: null, last: q.last });
  }
  const cuts = buildMapCuts(extra, quotes);
  const keys = Object.keys(cuts);
  if (!keys.length) throw new Error(`all extra cuts below half coverage (${quotes.size}/${symbols.length} quotes)`);
  const asOf = isoDate(lastTradingDay());
  await writeJson(path.join(DATA_DIR, 'maps-extra.json'), {
    asOf, generatedAt: new Date().toISOString(), cuts,
  });
  await writeStatus('maps', { status: 'ok', asOf, detail: keys.map(k => `${k}:${cuts[k].covered}`).join(' ') });
  console.log(`maps-extra.json written — ${keys.map(k => `${k}=${cuts[k].covered}`).join(' ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('Maps fetch failed', String(err.message || err));
    await writeStatus('maps', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
