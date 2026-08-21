// ── desk-news — holdings-first headlines, on demand ──────────────────────────
// Replaces the nightly fetch-news.js → data/news.json step
// (retire-nightly-pipeline plan, Group A). Same feed chain (general RSS +
// per-held-ticker Yahoo RSS → Google News fallback → text-match degrade),
// same ranking, same payload shape.
//
// Service-key note (plan §desk-news, accepted residual): held tickers come
// from the PRIVATE snapshots via SUPABASE_SERVICE_ROLE_KEY — the same key
// quote-proxy already holds — but only PUBLIC headlines and public day-%
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
    // cap 8: bounds server-side egress even if the committed config balloons
    general: (general.length ? general : defaults.general).slice(0, 8),
    perTicker: {
      enabled: fileCfg.perTicker?.enabled !== false,
      maxPerSymbol: Number(fileCfg.perTicker?.maxPerSymbol) > 0 ? Number(fileCfg.perTicker.maxPerSymbol) : defaults.perTicker.maxPerSymbol,
    },
    maxItems: Number(fileCfg.maxItems) > 0 ? Math.min(Number(fileCfg.maxItems), 50) : defaults.maxItems,
    source: 'config/news-feeds.json',
  };
}

// ── RSS/Atom parsing (verbatim port of parseFeed) ───────────────────────────
type Item = { title: string; at: Date | null; src: string; link?: string; chip?: string; chips?: string[] };
const parser = new XMLParser({ ignoreAttributes: false, textNodeName: '#text', htmlEntities: true });
// deno-lint-ignore no-explicit-any
const asArray = (x: any) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
// deno-lint-ignore no-explicit-any
const textOf = (v: any) => (typeof v === 'object' && v !== null ? v['#text'] || '' : String(v ?? ''));
// RSS <link> is a plain text node; Atom <link href="..."/> is an attribute-only
// element (possibly repeated with different rel values) — prefer rel="alternate"
// or the first entry with an href.
// deno-lint-ignore no-explicit-any
function linkOf(raw: any): string {
  if (raw == null) return '';
  if (Array.isArray(raw)) {
    const alt = raw.find((r) => !r?.['@_rel'] || r['@_rel'] === 'alternate') || raw[0];
    return linkOf(alt);
  }
  if (typeof raw === 'object') return String(raw['@_href'] || textOf(raw) || '').trim();
  return String(raw).trim();
}

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
    out.push({ title, at: at && !isNaN(at.getTime()) ? at : null, src, link: linkOf(it.link) });
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
/* `heldFirst` (owner report 2026-08-17) — chips and RANKING are two different
   jobs and only one of them belongs to a topic search. `held` still labels a
   row that names a position, because that is context the owner wants either
   way; but sorting holdings above everything else is the default sweep's rule,
   and applying it to a typed topic pushes whatever happens to mention a held
   ticker above the thing that was actually asked for. */
export function dedupeRank(items: Item[], held: string[], maxItems = 20, heldFirst = true): Item[] {
  const seen = new Set<string>();
  const uniq: Item[] = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const chips = it.chip ? [it.chip]
      : held.filter((sym) => new RegExp(`\\b${sym.replaceAll('.', '\\.')}\\b`).test(it.title.toUpperCase())).slice(0, 2);
    uniq.push({ ...it, chips });
  }
  uniq.sort((a, b) => {
    if (heldFirst) {
      const ha = a.chips!.length ? 1 : 0, hb = b.chips!.length ? 1 : 0;
      if (ha !== hb) return hb - ha;
    }
    return (b.at?.getTime() || 0) - (a.at?.getTime() || 0);
  });
  return uniq.slice(0, maxItems);
}

// ── chip day-% (public market data, parallel — no runner etiquette needed) ──
// Yahoo first, Stooq second (owner report 2026-07-28). This helper used to be
// Stooq-ONLY with a bare `catch { return null }`, so once Stooq started serving
// its HTML JS-challenge page as HTTP 200 every chip silently lost its day-%
// with nothing logged and nothing lamped — the chip just renders without a
// percentage. Yahoo's chart meta carries a real-time last + prior close, which
// is exactly what the chip wants; Stooq stays as the backstop.
/* The baseline is the SECOND-TO-LAST DAILY BAR, never `meta.chartPreviousClose`
   (owner-facing fault found 2026-08-21). That field is the close preceding the
   REQUESTED RANGE, so on this 5-day call it reads five sessions back and the
   "day" percentage is really a WEEK's move — measured on KO the same minute:
   0.17% against this range's 3.52%. desk-market already documents this exact
   trap and takes the prior bar for the same reason; this helper and its twin in
   desk-ibkr-sync were the two places that still trusted the field. They are
   separate deployments with no shared module, so the fix is duplicated by
   necessity — keep the two in step.
   Which bar is "prior" depends on whether the last one is TODAY: mid-session it
   is today's still-forming bar and the prior session is the one before it, but
   before today's bar exists the last bar IS the prior session. Decided on the
   bar's own ET date rather than on a clock, so half-days and holidays need no
   special case.
   One bounded difference is known and accepted: on an EX-DIVIDEND date the raw
   prior close and Yahoo's own adjusted `chartPreviousClose` disagree by the
   dividend (measured on MSFT 2026-08-20: 484.31 raw against 483.40 adjusted,
   a $0.91 payout, moving the reading 0.18pt). The raw close is taken, because
   that is what desk-market already uses and a desk whose panels disagree with
   each other by a dividend is worse than one that differs from Yahoo's own
   adjusted figure on the handful of days a year a name goes ex. */
async function yahooDayPct(symbol: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  // deno-lint-ignore no-explicit-any
  const r = (j as any)?.chart?.result?.[0];
  const price = Number(r?.meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const closes: number[] = [], stamps: number[] = [];
  const rawC = r?.indicators?.quote?.[0]?.close || [];
  const rawT = r?.timestamp || [];
  for (let i = 0; i < rawC.length; i++) {
    const c = Number(rawC[i]);
    if (!Number.isFinite(c) || c <= 0) continue;
    closes.push(c);
    stamps.push(Number(rawT[i]));
  }
  if (!closes.length) return null;
  const etDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const lastIsToday = Number.isFinite(stamps[stamps.length - 1]) &&
    etDate(stamps[stamps.length - 1]) === today;
  const prev = lastIsToday ? closes[closes.length - 2] : closes[closes.length - 1];
  if (!Number.isFinite(prev) || prev <= 0) return null;
  return Number(((price / prev - 1) * 100).toFixed(2));
}
async function stooqDayPct(symbol: string): Promise<number | null> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const d2 = new Date(), d1 = new Date(d2.getTime() - 14 * 86400000);
  const res = await fetch(`https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.us&i=d&d1=${ymd(d1)}&d2=${ymd(d2)}`, { headers: UA });
  const closes = (await res.text()).trim().split('\n').slice(1)
    .map((l) => Number(l.split(',')[4]))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (closes.length < 2) return null;
  return Number(((closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100).toFixed(2));
}
async function dayPctFor(symbol: string): Promise<number | null> {
  try {
    const via = await yahooDayPct(symbol).catch(() => null);
    if (via !== null) return via;
    return await stooqDayPct(symbol).catch(() => null);
  } catch { return null; }
}

function nyTodayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/* Owner-typed topic (owner request 2026-08-14): narrows the sweep itself
   rather than filtering what already came back — a filter over 20 fetched rows
   can only ever hide, never find.

   SANITISED, not trusted. This function is anon-callable and the value reaches
   an upstream URL, so it is bounded on BOTH length and character set before
   encodeURIComponent, rather than relying on encoding alone: encoding makes a
   string safe to place in a URL, it does not stop a 4KB query being forwarded
   to Google on every cold call. Letters, digits, space and a few separators
   cover every real topic ("fed rate cut", "AI chips", "oil & gas") while
   leaving nothing that can restructure the query. */
const TOPIC_MAX = 60;
function cleanTopic(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9 &.,'+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX);
}

/* Cache and single-flight are keyed BY TOPIC — two topics are two different
   payloads, and a shared slot would serve one owner's search to the next
   caller. Bounded at MAX_SLOTS because the key is user-typed: an unbounded map
   keyed on free text is a memory leak with a stranger's hand on the tap.
   Oldest-inserted is evicted, which is enough here — the common case is one
   topic plus the empty default. */
const MAX_SLOTS = 8;
const cache = new Map<string, { at: number; body: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function refresh(topic: string): Promise<unknown> {
  {
    const cfgRes = await fetch(CONFIG_URL, { headers: UA }).catch(() => null);
    const cfg = mergeFeedConfig(cfgRes && cfgRes.ok ? await cfgRes.json().catch(() => null) : null);
    const held = cfg.perTicker.enabled ? await heldTickers() : [];

    /* A TOPIC REPLACES THE WHOLE SWEEP, not just the broad wire (owner report
       2026-08-17: typed "avav", still saw FRMI headlines above it). The first
       cut left the per-ticker holdings lookups running on the reasoning that
       dropping news about a position would be the worse surprise. In practice
       it is the other way round — those rows are ranked holdings-first, so
       naming a symbol put three headlines about something else at the TOP of
       the panel, and the panel then does not show what the box says it shows.
       Narrowing is the whole point of the control; the holdings sweep is one
       empty box away. */
    const items: Item[] = [];
    const general = topic
      ? [{ src: `Topic · ${topic}`, url: `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en` }]
      : cfg.general;
    const generalResults = await Promise.allSettled(general.map((f) => fetchFeed(f.url, f.src)));
    let generalOk = false;
    for (const r of generalResults) {
      if (r.status !== 'fulfilled') continue;
      generalOk = true;
      items.push(...r.value.slice(0, 15));
    }

    const tickerResults = await Promise.allSettled((topic ? [] : held).map(async (sym) => {
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

    /* "Nothing matched" and "the fetch failed" are different answers and must
       not share one. Throwing lamps the panel STALE and keeps the LAST GOOD
       render on screen, so a topic nobody has written about would leave the
       previous topic's headlines sitting under the new topic's name — the exact
       misreport this control was added to fix. A search that ran and returned
       nothing is a successful empty result. */
    if (!items.length && !(topic && generalOk)) throw new Error('every news source failed');

    const ranked = dedupeRank(items, held, cfg.maxItems, !topic);
    const chipSyms = [...new Set(ranked.flatMap((it) => it.chips!))];
    const pctEntries = await Promise.all(chipSyms.map(async (s) => [s, await dayPctFor(s)] as const));
    const pct = Object.fromEntries(pctEntries);

    const body = {
      ok: true,
      asOf: nyTodayIso(),
      generatedAt: new Date().toISOString(),
      /* Echoed so a slow reply for an abandoned topic cannot repaint the panel
         after the owner has typed a different one — the same rule the watchlist
         timeframe follows. Also lets the panel say WHICH topic it is showing
         rather than the client assuming its own last input was honoured. */
      topic,
      items: ranked.map((it) => ({
        t: it.at ? it.at.toISOString().slice(11, 16) : '—',
        src: it.src,
        h: it.title,
        url: it.link || null,
        chips: it.chips!.map((sym) => [sym, pct[sym] ?? null]),
      })),
    };
    /* The caller stores this under its topic key — refresh() no longer writes
       the cache itself, because it does not know which slot it is filling and
       a bare assignment here would have overwritten whichever topic was last
       requested with whichever finished last. */
    return body;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  // force (owner request 2026-07-27): the dashboard's manual "Refresh now"
  // button bypasses this cache so a click guarantees a fresh upstream pull.
  let force = false, topic = '';
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
    topic = cleanTopic(body?.topic);
  }

  const hit = cache.get(topic);
  if (!force && hit && Date.now() - hit.at < ttlMs()) return reply(200, hit.body);

  try {
    let run = inflight.get(topic);
    if (!run) {
      run = refresh(topic).finally(() => inflight.delete(topic));
      inflight.set(topic, run);
    }
    const body = await run;
    cache.set(topic, { at: Date.now(), body });
    /* Evict oldest-inserted once over the cap. Map preserves insertion order,
       so the first key is the oldest — re-set on write would make this LRU, but
       the roster here is one or two topics and the extra churn buys nothing. */
    while (cache.size > MAX_SLOTS) cache.delete(cache.keys().next().value as string);
    return reply(200, body);
  } catch (e) {
    if (hit) return reply(200, hit.body); // stale-but-honest, for THIS topic
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
