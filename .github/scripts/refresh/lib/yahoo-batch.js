'use strict';
/* ── lib/yahoo-batch.js — batched Yahoo quotes for the S&P 500 heatmap ───────
   Primary: the v7 quote API (needs the cookie+crumb dance; one dance + ~4
   batches for 500 symbols) — returns day % AND market cap together.
   Fallback: the v8 spark API (no crumb; day % only, ~25 symbols per call);
   caller merges market caps from the previous committed heatmap. */
import { retryFetch, sleep, warn } from './util.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const Q1 = () => process.env.MARKET_FALLBACK_URL || 'https://query1.finance.yahoo.com';

/* Constituent lists use dots (BRK.B); Yahoo wants dashes (BRK-B). */
export const yahooTicker = sym => String(sym).trim().toUpperCase().replace(/\./g, '-');

export async function getCrumb() {
  const init = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' });
  const cookie = (init.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('no Yahoo session cookie issued');
  const res = await retryFetch(`${Q1()}/v1/test/getcrumb`, { headers: { 'user-agent': UA, cookie } }, { tries: 2 });
  const crumb = (await res.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) throw new Error('no Yahoo crumb issued');
  return { cookie, crumb };
}

/* v7 quote in batches → Map(sym → {pct, cap}). Throws only if the dance or
   EVERY batch fails; partial coverage is returned and reported by size. */
export async function quoteBatch(symbols, { cookie, crumb }, batchSize = 150) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const url = `${Q1()}/v7/finance/quote?symbols=${chunk.map(yahooTicker).join(',')}&fields=symbol,regularMarketChangePercent,marketCap&crumb=${encodeURIComponent(crumb)}`;
    try {
      const res = await retryFetch(url, { headers: { 'user-agent': UA, cookie } }, { tries: 2, baseMs: 2000 });
      for (const q of (await res.json())?.quoteResponse?.result || []) {
        const pct = Number(q.regularMarketChangePercent);
        if (Number.isFinite(pct)) out.set(String(q.symbol), { pct: Number(pct.toFixed(2)), cap: Number(q.marketCap) || null });
      }
    } catch (e) {
      warn('Yahoo quote batch failed', `${chunk[0]}… (${chunk.length} syms): ${String(e.message || e)}`);
    }
    await sleep(500);
  }
  return out;
}

/* Spark fallback → Map(sym → {pct}) from the last two daily closes. */
export function parseSpark(json) {
  const out = new Map();
  for (const [sym, node] of Object.entries(json || {})) {
    const closes = (node?.close || []).filter(c => Number.isFinite(c) && c > 0);
    if (closes.length >= 2) {
      const pct = (closes.at(-1) / closes.at(-2) - 1) * 100;
      out.set(sym, { pct: Number(pct.toFixed(2)) });
    }
  }
  return out;
}

export async function sparkBatch(symbols, batchSize = 25) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    const url = `${Q1()}/v8/finance/spark?symbols=${chunk.map(yahooTicker).join(',')}&range=5d&interval=1d`;
    try {
      const res = await retryFetch(url, { headers: { 'user-agent': UA } }, { tries: 2, baseMs: 2000 });
      for (const [sym, v] of parseSpark(await res.json())) out.set(sym, v);
    } catch (e) {
      warn('Yahoo spark batch failed', `${chunk[0]}… (${chunk.length} syms): ${String(e.message || e)}`);
    }
    await sleep(400);
  }
  return out;
}
