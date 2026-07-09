'use strict';
/* ── lib/quotes.js — daily closes with a two-source chain ────────────────────
   Stooq first (keyless CSV), Yahoo Finance chart API as fallback — Stooq
   enforces a daily per-IP limit that shared Actions runners regularly
   exhaust (observed run #1: HTTP 200, zero usable rows). Yahoo is unofficial
   but the same public data; symbol names/labels in market.json are
   source-independent. SC7 force-fail overrides BOTH bases (MARKET_BASE_URL +
   MARKET_FALLBACK_URL) so the forced-failure drill can't be rescued. */
import { retryFetch, sleep, warn } from './util.js';
import { fetchDailyCloses as stooqDaily } from './stooq.js';

const YAHOO_BASE = () => process.env.MARKET_FALLBACK_URL || 'https://query1.finance.yahoo.com';
const YAHOO_MAP = { '^spx': '^GSPC', '^ndx': '^NDX', '^dji': '^DJI', '^vix': '^VIX' };

export function yahooSymbol(stooqSym) {
  if (YAHOO_MAP[stooqSym]) return YAHOO_MAP[stooqSym];
  if (stooqSym.endsWith('.us')) return stooqSym.slice(0, -3).toUpperCase();
  return stooqSym.toUpperCase();
}

/* Yahoo v8 chart JSON → [{date, close}] ascending; dates are the NY trading
   day of each bar (timestamps are epoch seconds). Pure — fixture-tested. */
export function parseYahooChart(json) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const closes = r?.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close) || close <= 0) continue;
    const date = new Date(ts[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

async function yahooDaily(stooqSym) {
  const sym = yahooSymbol(stooqSym);
  const url = `${YAHOO_BASE()}/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
  const res = await retryFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (claude.trading data-refresh)' } });
  const rows = parseYahooChart(await res.json());
  if (rows.length < 2) throw new Error(`Yahoo returned ${rows.length} usable rows for ${sym}`);
  return rows;
}

/* Daily closes for one symbol (Stooq notation): Stooq → Yahoo. */
export async function dailyCloses(symbol) {
  try {
    return await stooqDaily(symbol);
  } catch (e) {
    warn(`Stooq failed for ${symbol}`, String(e.message || e) + ' — falling back to Yahoo');
    return yahooDaily(symbol);
  }
}

/* Day % (last vs previous close, 2dp) for a US ticker chip. Null instead of
   throwing — a chip without a % is fine, a dead panel isn't. */
export async function dayPctFor(symbol) {
  try {
    const rows = await dailyCloses(symbol.toLowerCase() + '.us');
    const [prev, last] = rows.slice(-2);
    await sleep(400); // politeness gap between sequential quote calls
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
