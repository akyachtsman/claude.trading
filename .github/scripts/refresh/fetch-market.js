'use strict';
/* ── fetch-market.js — market summary strip → data/market.json ───────────────
   Sources (keyless): Stooq daily CSV for ^spx, ^ndx (Nasdaq 100 — ^ndq is the
   Composite), ^dji, ^vix, iwm.us (labeled "IWM (R2K proxy)" per the trust-
   metadata bar); FRED DGS10 for the 10Y (publishes T-1, "." on holidays —
   stamped with the SERIES date, never the run date).
   All six must succeed or the script exits 1: the last committed market.json
   keeps serving with its older as-of stamp visible (FR-D4 / SC7). */
import path from 'node:path';
import { DATA_DIR, retryFetch, writeJson, writeStatus, errorLine, sleep } from './lib/util.js';
import { dailyCloses } from './lib/quotes.js';

export const MARKET_SYMBOLS = [
  { sym: '^spx', name: 'S&P 500' },
  { sym: '^ndx', name: 'Nasdaq 100' },
  { sym: '^dji', name: 'Dow Jones' },
  { sym: 'iwm.us', name: 'IWM (R2K proxy)' },
  { sym: '^vix', name: 'VIX' },
];

const fmtLast = v => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* rows: [{date, close}] ascending → strip tile (30-close spark, 2dp day %). */
export function tileFrom(name, rows) {
  const closes = rows.map(r => r.close);
  const [prev, last] = closes.slice(-2);
  return {
    name,
    last: fmtLast(last),
    chg: Number(((last / prev - 1) * 100).toFixed(2)),
    spark: closes.slice(-30).map(c => Number(c.toFixed(4))),
    asOf: rows[rows.length - 1].date,
  };
}

/* FRED fredgraph CSV → [{date, value}]; header row varies (DATE vs
   observation_date) and holidays are "." — both handled here. */
export function parseFred(csv) {
  const rows = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const [date, raw] = line.split(',').map(s => (s || '').trim());
    const value = Number(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === '.' || !Number.isFinite(value)) continue;
    rows.push({ date, value });
  }
  return rows;
}

export function tenYearTile(rows) {
  const [prev, last] = rows.slice(-2);
  return {
    name: 'US 10Y',
    last: last.value.toFixed(2) + '%',
    chg: Number((last.value - prev.value).toFixed(2)),
    spark: rows.slice(-30).map(r => r.value),
    asOf: last.date, // series date — FRED lags T-1
  };
}

async function main() {
  const tiles = [];
  for (const { sym, name } of MARKET_SYMBOLS) {
    tiles.push(tileFrom(name, await dailyCloses(sym)));
    await sleep(600); // sequential + spaced — quote sources rate-limit Actions IPs
  }
  const fredBase = process.env.FRED_BASE_URL || 'https://fred.stlouisfed.org';
  const cosd = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const fredRes = await retryFetch(`${fredBase}/graph/fredgraph.csv?id=DGS10&cosd=${cosd}`);
  const fredRows = parseFred(await fredRes.text());
  if (fredRows.length < 2) throw new Error(`FRED DGS10 returned ${fredRows.length} usable rows`);
  tiles.push(tenYearTile(fredRows));

  const asOf = tiles.map(t => t.asOf).sort().at(-1);
  await writeJson(path.join(DATA_DIR, 'market.json'), {
    asOf, generatedAt: new Date().toISOString(), tiles,
  });
  await writeStatus('market', { status: 'ok', asOf });
  console.log(`market.json written — as of ${asOf}, ${tiles.length} tiles`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('Market fetch failed', String(err.message || err));
    await writeStatus('market', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
