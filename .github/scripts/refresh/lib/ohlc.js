'use strict';
/* ── lib/ohlc.js — full daily OHLCV history for the charts panel ─────────────
   Stooq daily CSV primary (same keyless source as lib/stooq, but keeping all
   six columns instead of just close), Yahoo v8 chart fallback per symbol.
   Callers fetch SEQUENTIALLY — Stooq etiquette, and the per-symbol chart
   endpoint is the one Yahoo path that survived the #26 throttle storms. */
import { retryFetch, isoDate } from './util.js';
import { STOOQ_BASE } from './stooq.js';

const YAHOO_BASE = () => process.env.MARKET_FALLBACK_URL || 'https://query1.finance.yahoo.com';

/* Stooq daily CSV (Date,Open,High,Low,Close,Volume) → [{date,o,h,l,c,v}]
   ascending. Tolerates "No data" bodies, junk rows, and missing volume. */
export function parseStooqOHLC(csv) {
  const rows = [];
  for (const line of String(csv).trim().split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 5) continue;
    const date = cols[0].trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const [o, h, l, c] = [1, 2, 3, 4].map(i => Number(cols[i]));
    if (![o, h, l, c].every(n => Number.isFinite(n) && n > 0)) continue;
    rows.push({ date, o, h, l, c, v: Number(cols[5]) > 0 ? Number(cols[5]) : 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/* Yahoo v8 chart JSON → same shape; bars stamped with their NY trading day. */
export function parseYahooChartOHLC(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const o = Number(q.open?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), c = Number(q.close?.[i]);
    if (![o, h, l, c].every(n => Number.isFinite(n) && n > 0)) continue;
    const date = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    rows.push({ date, o, h, l, c, v: Number(q.volume?.[i]) > 0 ? Number(q.volume?.[i]) : 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function stooqOHLC(ticker, days) {
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - days * 86400000);
  const ymd = d => isoDate(d).replaceAll('-', '');
  const sym = ticker.toLowerCase() + '.us';
  const url = `${STOOQ_BASE()}/q/d/l/?s=${encodeURIComponent(sym)}&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const res = await retryFetch(url);
  const body = await res.text();
  const rows = parseStooqOHLC(body);
  if (rows.length < 40) {
    throw new Error(`Stooq returned ${rows.length} usable OHLC rows for ${sym} (body starts: ${JSON.stringify(body.slice(0, 60))})`);
  }
  return rows;
}

async function yahooOHLC(ticker) {
  const url = `${YAHOO_BASE()}/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
  const res = await retryFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (claude.trading data-refresh)' } });
  const rows = parseYahooChartOHLC(await res.json());
  if (rows.length < 40) throw new Error(`Yahoo returned ${rows.length} usable OHLC rows for ${ticker}`);
  return rows;
}

/* Daily OHLCV for one US ticker: Stooq → Yahoo chart fallback. */
export async function dailyOHLC(ticker, { days = 500 } = {}) {
  try {
    return await stooqOHLC(ticker, days);
  } catch (e) {
    console.log(`::warning title=charts::Stooq OHLC failed for ${ticker}: ${String(e.message || e)} — falling back to Yahoo`);
    return yahooOHLC(ticker);
  }
}
