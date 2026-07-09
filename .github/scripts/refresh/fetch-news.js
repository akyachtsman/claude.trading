'use strict';
/* ── fetch-news.js — holdings-first headlines → data/news.json ───────────────
   Keyless RSS. General market feeds (CNBC + MarketWatch) plus per-held-ticker
   feeds: Yahoo Finance RSS → Google News RSS fallback → degrade to matching
   tickers against general-headline text (the Yahoo feed is unofficial and may
   vanish — FR-N1 fallback chain from plan.md).
   Held tickers come from the PRIVATE snapshot in-job, but only PUBLIC
   headlines are written out; chip day-% comes from Stooq (public), NEVER from
   the snapshot — the news panel renders pre-auth (FR-N2). */
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { DATA_DIR, retryFetch, writeJson, writeStatus, notice, warn, errorLine, isoDate, nyToday } from './lib/util.js';
import { dayPctMap } from './lib/quotes.js';
import { supaConfigured, ownerUserId, latestSnapshots } from './supa.js';

const GENERAL_FEEDS = [
  { src: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { src: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
];
const MAX_ITEMS = 20;
const MAX_TICKERS = 8;

/* htmlEntities: feeds encode punctuation as numeric/HTML entities (&#x2018;
   etc.) which would otherwise reach the page as literal text. */
const parser = new XMLParser({ ignoreAttributes: false, textNodeName: '#text', htmlEntities: true });
const asArray = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const textOf = v => (typeof v === 'object' && v !== null ? v['#text'] || '' : String(v ?? ''));

/* RSS 2.0 (rss.channel.item) or Atom (feed.entry) → [{title, at, src}].
   Google News suffixes " - Source" onto titles; strip it into src. */
export function parseFeed(xml, fallbackSrc) {
  let doc;
  try { doc = parser.parse(xml); } catch { return []; }
  const rssItems = asArray(doc?.rss?.channel?.item);
  const atomItems = asArray(doc?.feed?.entry);
  const out = [];
  for (const it of [...rssItems, ...atomItems]) {
    let title = textOf(it.title).trim();
    if (!title) continue;
    let src = fallbackSrc;
    const m = title.match(/^(.*)\s+-\s+([A-Za-z][\w .&''-]{1,40})$/);
    if (m && fallbackSrc === 'Google News') { title = m[1].trim(); src = m[2].trim(); }
    const when = textOf(it.pubDate || it.published || it.updated).trim();
    const at = when ? new Date(when) : null;
    out.push({ title, at: at && !isNaN(at) ? at : null, src });
  }
  return out;
}

async function fetchFeed(url, src) {
  const res = await retryFetch(url, { headers: { 'user-agent': 'claude.trading data-refresh (+github actions)' } });
  return parseFeed(await res.text(), src);
}

/* Held tickers, largest positions first — private read, public output only. */
async function heldTickers() {
  if (!supaConfigured()) {
    notice('News: general feeds only', 'DB_URL / DB_SERVICE_KEY not set — skipping per-holding ticker feeds.');
    return [];
  }
  try {
    const snaps = await latestSnapshots(await ownerUserId());
    const positions = snaps.flatMap(s => Array.isArray(s.positions) ? s.positions : []);
    positions.sort((a, b) => Math.abs(b.mkt || 0) - Math.abs(a.mkt || 0));
    return [...new Set(positions.map(p => String(p.sym || '').toUpperCase()).filter(s => /^[A-Z.]{1,6}$/.test(s)))].slice(0, MAX_TICKERS);
  } catch (e) {
    warn('News: could not read holdings', String(e.message || e) + ' — continuing with general feeds.');
    return [];
  }
}

export function dedupeRank(items, held) {
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    /* tag chips: explicit ticker-feed tag, else text match on held symbols */
    const chips = it.chip ? [it.chip]
      : held.filter(sym => new RegExp(`\\b${sym.replace('.', '\\.')}\\b`).test(it.title.toUpperCase())).slice(0, 2);
    uniq.push({ ...it, chips });
  }
  uniq.sort((a, b) => {
    const ha = a.chips.length ? 1 : 0, hb = b.chips.length ? 1 : 0;
    if (ha !== hb) return hb - ha;                       // holdings-first
    return (b.at?.getTime() || 0) - (a.at?.getTime() || 0); // then newest
  });
  return uniq.slice(0, MAX_ITEMS);
}

async function main() {
  const held = await heldTickers();
  const items = [];

  for (const feed of GENERAL_FEEDS) {
    try { items.push(...(await fetchFeed(feed.url, feed.src)).slice(0, 15)); }
    catch (e) { warn(`News feed failed: ${feed.src}`, String(e.message || e)); }
  }

  for (const sym of held) {
    let got = [];
    try {
      got = await fetchFeed(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`, 'Yahoo Finance');
    } catch { /* fall through to Google News */ }
    if (!got.length) {
      try {
        got = await fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(sym + ' stock')}&hl=en-US&gl=US&ceid=US:en`, 'Google News');
      } catch { /* degrade: text-match against general headlines in dedupeRank */ }
    }
    items.push(...got.slice(0, 3).map(it => ({ ...it, chip: sym })));
  }

  if (!items.length) throw new Error('every news source failed — keeping last committed news.json');

  const ranked = dedupeRank(items, held);
  const pct = await dayPctMap(ranked.flatMap(it => it.chips)); // public Stooq day % (FR-N2)
  const asOf = isoDate(nyToday());
  await writeJson(path.join(DATA_DIR, 'news.json'), {
    asOf,
    generatedAt: new Date().toISOString(),
    items: ranked.map(it => ({
      t: it.at ? it.at.toISOString().slice(11, 16) : '—',
      src: it.src,
      h: it.title,
      chips: it.chips.map(sym => [sym, pct[sym] ?? null]),
    })),
  });
  await writeStatus('news', { status: 'ok', asOf });
  console.log(`news.json written — ${ranked.length} items, ${held.length} held tickers tracked`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('News fetch failed', String(err.message || err));
    await writeStatus('news', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
