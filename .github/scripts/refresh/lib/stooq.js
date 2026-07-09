'use strict';
/* ── lib/stooq.js — Stooq daily-CSV access (primary quote source) ────────────
   Keyless but daily-limited per IP; shared Actions runners can exhaust the
   limit, so lib/quotes.js wraps this with a Yahoo fallback. Callers fetch
   SEQUENTIALLY with retry, never in parallel. */
import { retryFetch, isoDate } from './util.js';

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

/* Last ~90 calendar days of daily closes for one symbol (^spx, iwm.us, …).
   A limit/empty body surfaces its first line in the error for the run log. */
export async function fetchDailyCloses(symbol, { days = 90 } = {}) {
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - days * 86400000);
  const ymd = d => isoDate(d).replaceAll('-', '');
  const url = `${STOOQ_BASE()}/q/d/l/?s=${encodeURIComponent(symbol)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await retryFetch(url);
  const body = await res.text();
  const rows = parseStooqDaily(body);
  if (rows.length < 2) {
    throw new Error(`Stooq returned ${rows.length} usable rows for ${symbol} (body starts: ${JSON.stringify(body.slice(0, 60))})`);
  }
  return rows;
}
