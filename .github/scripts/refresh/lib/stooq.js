'use strict';
/* ── lib/stooq.js — Stooq daily-CSV access shared by market, news chips and
   position day-% lookups. Stooq is keyless but rate-limits shared Actions
   IPs: callers fetch SEQUENTIALLY with retry, never in parallel. ──────────── */
import { retryFetch, sleep, isoDate } from './util.js';

export const STOOQ_BASE = () => process.env.MARKET_BASE_URL || 'https://stooq.com';

/* Parse Stooq daily CSV (Date,Open,High,Low,Close,Volume) → [{date, close}].
   Tolerates the "No data" body and malformed rows. */
export function parseStooqDaily(csv) {
  const rows = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const date = cols[0].trim();
    const close = Number(cols[4]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/* Last ~90 calendar days of daily closes for one symbol (^spx, iwm.us, …). */
export async function fetchDailyCloses(symbol, { days = 90 } = {}) {
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - days * 86400000);
  const ymd = d => isoDate(d).replaceAll('-', '');
  const url = `${STOOQ_BASE()}/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await retryFetch(url);
  const rows = parseStooqDaily(await res.text());
  if (rows.length < 2) throw new Error(`Stooq returned ${rows.length} usable rows for ${symbol}`);
  return rows;
}

/* Day % (last close vs previous close, 2dp) for a US ticker chip. Returns
   null instead of throwing — a chip without a % is fine, a dead panel isn't. */
export async function dayPctFor(symbol) {
  try {
    const rows = await fetchDailyCloses(symbol.toLowerCase() + '.us', { days: 21 });
    const [prev, last] = rows.slice(-2);
    await sleep(400); // politeness gap between sequential Stooq calls
    return Number(((last.close / prev.close - 1) * 100).toFixed(2));
  } catch {
    return null;
  }
}

/* Sequential day-% map for a symbol list (deduped, order preserved). */
export async function dayPctMap(symbols) {
  const out = {};
  for (const sym of [...new Set(symbols)]) out[sym] = await dayPctFor(sym);
  return out;
}
