#!/usr/bin/env node
/* Compares the live desk-heatmap day-% against Yahoo's, symbol by symbol.
   Re-runnable evidence for the 2026-08-20 report that WMT read -0.78% while it
   was down ~9%. Run it any time the heatmap looks wrong:

     node .agent-reports/heatmap-quote-check.mjs [SYM SYM ...]

   Yahoo is the reference because its chartPreviousClose is the same basis the
   rest of the desk computes against; the Nasdaq screener's own pctchange was
   found to use a different (stale) prior close. */
const KEY = 'sb_publishable_5SCxDQzd0D7aEbbgG3C_3w_4cvGNP0E';
const URL = 'https://kwugzhyfjevzwgplhtsd.supabase.co/functions/v1/desk-heatmap';
const want = process.argv.slice(2).map(s => s.toUpperCase());

const res = await fetch(URL, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, apikey: KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ force: true }),
});
const feed = await res.json();
const tiles = feed.sectors.flatMap(s => s.tiles);
const pick = want.length ? tiles.filter(t => want.includes(t.sym)) : tiles.slice(0, 25);

console.log(`source: ${feed.source}   generatedAt: ${feed.generatedAt}\n`);
console.log('sym      feed%     real%    off      feed last   real last');
let worst = 0;
for (const t of pick) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${t.sym}?range=5d&interval=1d`,
    { headers: { 'user-agent': 'Mozilla/5.0' } });
  const m = (await r.json())?.chart?.result?.[0]?.meta;
  if (!m?.regularMarketPrice || !m?.chartPreviousClose) continue;
  const real = (m.regularMarketPrice / m.chartPreviousClose - 1) * 100;
  const off = Math.abs((t.pct ?? 0) - real);
  worst = Math.max(worst, off);
  const flag = off > 0.5 ? '  <-- WRONG' : '';
  console.log(
    `${t.sym.padEnd(6)} ${String(t.pct).padStart(7)} ${real.toFixed(2).padStart(9)} ` +
    `${off.toFixed(2).padStart(6)} ${String(t.last).padStart(11)} ${String(m.regularMarketPrice).padStart(11)}${flag}`);
}
console.log(`\nworst disagreement: ${worst.toFixed(2)} points`);
process.exit(worst > 0.5 ? 1 : 0);
