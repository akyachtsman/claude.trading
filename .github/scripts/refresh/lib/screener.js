'use strict';
/* ── lib/screener.js — Nasdaq screener: bulk day % + market cap in ONE call ──
   Primary heatmap source. Yahoo throttles GitHub-runner IPs per-endpoint
   (observed runs: crumb + spark 429 across whole jobs), while this endpoint
   returns every listed symbol with pctchange and marketCap in a single
   download request. Yahoo remains the fallback chain. */
import { retryFetch } from './util.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = () => process.env.SCREENER_BASE_URL || 'https://api.nasdaq.com';

/* Screener JSON → Map keyed by BOTH the raw symbol and its dot→dash variant
   so constituent lookups (BRK.B) hit either notation. Pure — fixture-tested. */
export function parseScreener(json) {
  const out = new Map();
  for (const r of json?.data?.rows || []) {
    const sym = String(r.symbol || '').trim().toUpperCase();
    if (!sym) continue;
    const rawPct = String(r.pctchange ?? '').replace(/[%,+]/g, '').trim();
    const pct = rawPct === '' || rawPct === '--' ? 0 : Number(rawPct);
    const cap = Number(String(r.marketCap ?? '').replace(/[$,]/g, ''));
    if (!Number.isFinite(pct)) continue;
    const q = { pct: Number(pct.toFixed(2)), cap: Number.isFinite(cap) && cap > 0 ? cap : null };
    out.set(sym, q);
    out.set(sym.replace(/\./g, '-'), q);
  }
  return out;
}

export async function nasdaqScreener() {
  const url = `${BASE()}/api/screener/stocks?tableonly=true&limit=25&download=true`;
  const res = await retryFetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9' },
  }, { tries: 3, baseMs: 4000 });
  return parseScreener(await res.json());
}
