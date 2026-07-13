// ── desk-news — holdings-first headlines, on demand ──────────────────────────
// Replaces the nightly fetch-news.js → data/news.json step
// (retire-nightly-pipeline plan, Group A). Same feed chain (general RSS +
// per-held-ticker Yahoo RSS → Google News fallback → text-match degrade),
// same ranking, same payload shape.
//
// Service-key note (plan §desk-news, accepted residual): held tickers come
// from the PRIVATE snapshots via SUPABASE_SERVICE_ROLE_KEY — the same key
// quote-proxy already holds — but only PUBLIC headlines and Stooq day-%
// leave this function, byte-shape-identical to the news.json that was
// previously committed to the public repo. No caller input reaches the
// upstream URLs or the database query.
//
// Anon-callable; module cache TTL is session-aware (5/60 min).

import { XMLParser } from 'npm:fast-xml-parser@4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk news; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/news-feeds.json';
const MAX_TICKERS = 8;

// Session-aware TTL — same rule as desk-market. HOLIDAY LIST — refresh
// annually (seeded 2026–2027).
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
function marketSessionOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = get('weekday');
  if (dow === 'Sat' || dow === 'Sun') return false;
  if (NYSE_HOLIDAYS.has(`${get('year')}-${get('month')}-${get('day')}`)) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
const ttlMs = () => (marketSessionOpen() ? 300_000 : 3_600_000);

// ── feed config (verbatim port of mergeFeedConfig) ──────────────────────────
type FeedCfg = {
  general: { src: string; url: string }[];
  perTicker: { enabled: boolean; maxPerSymbol: number };
  maxItems: number;
  source: string;
};
const DEFAULT_FEED_CONFIG = {
  general: [
    { src: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { src: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  ],
  perTicker: { enabled: true, maxPerSymbol: 3 },
  maxItems: 20,
};
// deno-lint-ignore no-explicit-any
export function mergeFeedConfig(fileCfg: any, defaults = DEFAULT_FEED_CONFIG): FeedCfg {
  if (!fileCfg || typeof fileCfg !== 'object') return { ...defaults, source: 'defaults' };
  const general = Array.isArray(fileCfg.general)
    // deno-lint-ignore no-explicit-any
    ? fileCfg.general.filter((f: any) => f && typeof f.url === 'string' && /^https:\/\//.test(f.url) && f.src)
    : defaults.general;
  return {
    general: general.length ? general : defaults.general,
    perTicker: {
      enabled: fileCfg.perTicker?.enabled !== false,
      maxPerSymbol: Number(fileCfg.perTicker?.maxPerSymbol) > 0 ? Number(fileCfg.perTicker.maxPerSymbol) : defaults.perTicker.maxPerSymbol,
    },
    maxItems: Number(fileCfg.maxItems) > 0 ? Math.min(Number(fileCfg.maxItems), 50) : defaults.maxItems,
    source: 'config/news-feeds.json',
  };
}

// ── RSS/Atom parsing (verbatim port of parseFeed) ───────────────────────────
type Item = { title: string; at: Date | null; src: string; chip?: string; chips?: string[] };
const parser = new XMLParser({ ignoreAttributes: false, textNodeName: '#text', htmlEntities: true });
// deno-lint-ignore no-explicit-any
const asArray = (x: any) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
// deno-lint-ignore no-explicit-any
const textOf = (v: any) => (typeof v === 'object' && v !== null ? v['#text'] || '' : String(v ?? ''));

export function parseFeed(xml: string, fallbackSrc: string): Item[] {
  // deno-lint-ignore no-explicit-any
  let doc: any;
  try { doc = parser.parse(xml); } catch { return []; }
  const rssItems = asArray(doc?.rss?.channel?.item);
  const atomItems = asArray(doc?.feed?.entry);
  const out: Item[] = [];
  for (const it of [...rssItems, ...atomItems]) {
    let title = textOf(it.title).trim();
    if (!title) continue;
    let src = fallbackSrc;
    const m = title.match(/^(.*)\s+-\s+([A-Za-z][\w .&''-]{1,40})$/);
    if (m && fallbackSrc === 'Google News') { title = m[1].trim(); src = m[2].trim(); }
    const when = textOf(it.pubDate || it.published || it.updated).trim();
    const at = when ? new Date(when) : null;
    out.push({ title, at: at && !isNaN(at.getTime()) ? at : null, src });
  }
  return out;
}

async function fetchFeed(url: string, src: string): Promise<Item[]> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${src} HTTP ${res.status}`);
  return parseFeed(await res.text(), src);
}

// ── held tickers (private read, public output only — FR-N2) ─────────────────
async function heldTickers(): Promise<string[]> {
  const supaUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !serviceKey) return [];
  try {
    const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
    const users = await (await fetch(`${supaUrl}/rest/v1/desk_users?select=id&is_test=eq.false&limit=1`, { headers })).json();
    if (!users?.length) return [];
    const rows = await (await fetch(
      `${supaUrl}/rest/v1/desk_account_snapshots?select=account_key,as_of,positions&user_id=eq.${users[0].id}&order=as_of.desc&limit=40`,
      { headers },
    )).json();
    const latest = new Map<number, { positions?: { sym?: string; mkt?: number }[] }>();
    for (const r of rows || []) if (!latest.has(r.account_key)) latest.set(r.account_key, r);
    const positions = [...latest.values()].flatMap((s) => Array.isArray(s.positions) ? s.positions : []);
    positions.sort((a, b) => Math.abs(b.mkt || 0) - Math.abs(a.mkt || 0));
    return [...new Set(positions.map((p) => String(p.sym || '').toUpperCase()).filter((s) => /^[A-Z.]{1,6}$/.test(s)))].slice(0, MAX_TICKERS);
  } catch { return []; }
}

// ── ranking (verbatim port of dedupeRank) ───────────────────────────────────
export function dedupeRank(items: Item[], held: string[], maxItems = 20): Item[] {
  const seen = new Set<string>();
  const uniq: Item[] = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const chips = it.chip ? [it.chip]
      : held.filter((sym) => new RegExp(`\\b${sym.replace('.', '\\.')}\\b`).test(it.title.toUpperCase())).slice(0, 2);
    uniq.push({ ...it, chips });
  }
  uniq.sort((a, b) => {
    const ha = a.chips!.length ? 1 : 0, hb = b.chips!.length ? 1 : 0;
    if (ha !== hb) return hb - ha;
    return (b.at?.getTime() || 0) - (a.at?.getTime() || 0);
  });
  return uniq.slice(0, maxItems);
}

// ── chip day-% (public Stooq, parallel — no runner etiquette needed) ────────
async function dayPctFor(symbol: string): Promise<number | null> {
  try {
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
    const d2 = new Date(), d1 = new Date(d2.getTime() - 14 * 86400000);
    const res = await fetch(`https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: UA });
    const closes = (await res.text()).trim().split('\n').slice(1)
      .map((l) => Number(l.split(',')[4]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (closes.length < 2) return null;
    return Number(((closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100).toFixed(2));
  } catch { return null; }
}

function nyTodayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

let cache: { at: number; body: unknown } | null = null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  if (cache && Date.now() - cache.at < ttlMs()) return reply(200, cache.body);

  try {
    const cfgRes = await fetch(CONFIG_URL, { headers: UA }).catch(() => null);
    const cfg = mergeFeedConfig(cfgRes && cfgRes.ok ? await cfgRes.json().catch(() => null) : null);
    const held = cfg.perTicker.enabled ? await heldTickers() : [];

    const items: Item[] = [];
    const generalResults = await Promise.allSettled(cfg.general.map((f) => fetchFeed(f.url, f.src)));
    for (const r of generalResults) if (r.status === 'fulfilled') items.push(...r.value.slice(0, 15));

    const tickerResults = await Promise.allSettled(held.map(async (sym) => {
      let got: Item[] = [];
      try { got = await fetchFeed(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${sym}&region=US&lang=en-US`, 'Yahoo Finance'); }
      catch { /* fall through */ }
      if (!got.length) {
        try { got = await fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(sym + ' stock')}&hl=en-US&gl=US&ceid=US:en`, 'Google News'); }
        catch { /* degrade: text-match in dedupeRank */ }
      }
      return got.slice(0, cfg.perTicker.maxPerSymbol).map((it) => ({ ...it, chip: sym }));
    }));
    for (const r of tickerResults) if (r.status === 'fulfilled') items.push(...r.value);

    if (!items.length) throw new Error('every news source failed');

    const ranked = dedupeRank(items, held, cfg.maxItems);
    const chipSyms = [...new Set(ranked.flatMap((it) => it.chips!))];
    const pctEntries = await Promise.all(chipSyms.map(async (s) => [s, await dayPctFor(s)] as const));
    const pct = Object.fromEntries(pctEntries);

    const body = {
      ok: true,
      asOf: nyTodayIso(),
      generatedAt: new Date().toISOString(),
      items: ranked.map((it) => ({
        t: it.at ? it.at.toISOString().slice(11, 16) : '—',
        src: it.src,
        h: it.title,
        chips: it.chips!.map((sym) => [sym, pct[sym] ?? null]),
      })),
    };
    cache = { at: Date.now(), body };
    return reply(200, body);
  } catch (e) {
    if (cache) return reply(200, cache.body); // stale-but-honest
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
