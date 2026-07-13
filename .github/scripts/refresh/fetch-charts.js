'use strict';
/* ── fetch-charts.js — watchlist OHLCV histories → data/charts.json ──────────
   Daily bars for a FIXED, owner-editable watchlist (config/chart-watchlist
   .json overrides the default roster below). Deliberately NOT derived from
   IBKR holdings: this repo is public and a positions-derived list would leak
   the book. Sequential fetches (Stooq etiquette; Yahoo chart fallback per
   symbol). Domain fails ⇒ last committed charts.json keeps serving (FR-D4). */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, DATA_DIR, writeJson, writeStatus, warn, errorLine, sleep } from './lib/util.js';
import { dailyOHLC } from './lib/ohlc.js';

/* Broad-market + sector + rates/metals/vol roster (the classic desk sidebar). */
export const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'SMH',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLB', 'XLU', 'XLY', 'XLP', 'KRE',
  'GLD', 'SLV', 'TLT', 'TLH', 'SHY', 'UUP', 'VXX', 'EEM', 'FXI', 'INDA',
];

const KEEP_BARS = 330;      /* ~15 months: 1y of view + weekly-stoch warmup */
const MIN_COVERAGE = 0.6;   /* below this fraction of the roster, fail the domain */

/* rows [{date,o,h,l,c,v}] → compact parallel arrays (2dp prices). */
export function packSeries(rows) {
  const s = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (const r of rows.slice(-KEEP_BARS)) {
    s.t.push(r.date);
    s.o.push(+r.o.toFixed(2)); s.h.push(+r.h.toFixed(2));
    s.l.push(+r.l.toFixed(2)); s.c.push(+r.c.toFixed(2));
    s.v.push(r.v);
  }
  return s;
}

async function loadWatchlist() {
  try {
    const raw = await readFile(path.join(ROOT, 'config', 'chart-watchlist.json'), 'utf8');
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length && list.every(s => typeof s === 'string')) {
      return list.map(s => s.trim().toUpperCase()).filter(Boolean);
    }
    warn('charts', 'config/chart-watchlist.json is not a string array — using the default roster');
  } catch { /* no override file — default roster */ }
  return DEFAULT_WATCHLIST;
}

async function main() {
  const watchlist = await loadWatchlist();
  const symbols = {};
  let asOf = null;
  for (const ticker of watchlist) {
    try {
      const rows = await dailyOHLC(ticker);
      symbols[ticker] = packSeries(rows);
      const last = rows.at(-1).date;
      if (!asOf || last > asOf) asOf = last;
    } catch (e) {
      warn('charts', `no OHLC for ${ticker}: ${String(e.message || e)}`);
    }
    await sleep(400);
  }
  const got = Object.keys(symbols).length;
  if (got < Math.ceil(watchlist.length * MIN_COVERAGE)) {
    throw new Error(`coverage floor: only ${got}/${watchlist.length} watchlist symbols returned OHLC`);
  }
  await writeJson(path.join(DATA_DIR, 'charts.json'), { asOf, count: got, symbols });
  await writeStatus('charts', { status: 'ok', asOf, detail: `${got}/${watchlist.length} symbols, ${KEEP_BARS} bars max` });
  console.log(`charts.json written — ${got}/${watchlist.length} symbols, asOf ${asOf}`);
}

/* Only run when invoked directly — the test suite imports the pure helpers. */
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async (e) => {
    errorLine('charts', String(e.message || e));
    await writeStatus('charts', { status: 'failed', detail: String(e.message || e) });
    process.exitCode = 1;
  });
}
