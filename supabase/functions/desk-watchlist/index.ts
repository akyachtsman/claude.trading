// ── desk-watchlist — batched quotes for the owner's watchlist rosters ────────
// Deployed as a Supabase Edge Function (Deno). Reads the owner's lists from
// desk_watchlists (desk_010) with the service-role key — that table is RLS
// deny-all and is EDITED through the PIN RPCs from the dashboard, so the roster
// is owner-controlled at runtime with no redeploy. Returns one quote row per
// symbol, grouped by list.
//
// config/watchlists.json remains as a BOOTSTRAP fallback only: it seeds the
// panel if the table read fails (or before desk_010 is applied), so the feed
// degrades to a working roster instead of a dead panel. Rosters are NEVER
// derived from account holdings — this repo is public.
//
// One upstream call per 50 symbols, not one per symbol: Yahoo's v7/quote takes
// a comma-separated `symbols` list, so a 41-name roster is a SINGLE round trip
// (verified end-to-end before building — all 41 returned, including the ^VIX
// index and the BRK-B share class). That is what makes an unbounded roster
// affordable here, where desk-market's per-symbol v8/chart sweep would not be.
//
// Anon-callable: public market data, roster fixed in committed config, no
// caller input reaches the upstream URL. Session-aware module cache (1 min
// while the US session is open, 60 min closed) + single-flight, matching
// desk-market.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const UA = { 'user-agent': 'Mozilla/5.0 (desk watchlist; +https://akyachtsman.github.io/claude.trading/)' };
const CONFIG_URL = 'https://akyachtsman.github.io/claude.trading/config/watchlists.json';
const CHUNK = 50;          // symbols per upstream call (v7/quote)
// v7/finance/spark is a SEPARATE, stricter endpoint: 20 symbols works, 30 is a
// hard 400 (measured). It is the only BATCHED source of an intraday series —
// v8/chart takes one symbol per call, which would be 41 round trips per panel.
const SPARK_CHUNK = 20;
const SPARK_POINTS = 24;   // downsampled from Yahoo's 78 five-minute closes
const MAX_SYMBOLS = 1000;  // runaway guard on a hand-edited config, not a product cap

// ── session-aware TTL (mirrors desk-market) ─────────────────────────────────
function sessionOpen(now = new Date()): boolean {
  // US equities regular session in ET, weekdays. Holidays are not modelled —
  // a holiday merely polls at the open cadence against an unchanging feed.
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}
const ttlMs = () => (sessionOpen() ? 60_000 : 3_600_000);

// ── Yahoo v7/quote needs a cookie + crumb (401 otherwise) ───────────────────
// Same handshake quote-proxy uses; cached per warm instance.
let yauth: { cookie: string; crumb: string; at: number } | null = null;
const YAUTH_TTL_MS = 3_600_000;

async function yahooAuth(force = false): Promise<{ cookie: string; crumb: string } | null> {
  if (!force && yauth && Date.now() - yauth.at < YAUTH_TTL_MS) return yauth;
  const c = await fetch('https://fc.yahoo.com/', { headers: UA });
  // deno-lint-ignore no-explicit-any
  const setCookies: string[] = (c.headers as any).getSetCookie?.() ?? [];
  let cookie = setCookies.map((s) => s.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) { const one = c.headers.get('set-cookie'); if (one) cookie = one.split(';')[0]; }
  if (!cookie) return null;
  const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: cookie } });
  if (!cr.ok) return null;
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 32 || crumb.includes('<')) return null; // reject HTML/error bodies
  yauth = { cookie, crumb, at: Date.now() };
  return yauth;
}

// Yahoo hyphenates share-class dots (BRK.B → BRK-B); '^' index prefixes pass through.
const toYahoo = (s: string) => s.replace(/\./g, '-');
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// deno-lint-ignore no-explicit-any
async function quoteChunk(symbols: string[]): Promise<any[]> {
  const q = symbols.map(toYahoo).map(encodeURIComponent).join(',');
  const url = (crumb: string) =>
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${q}&crumb=${encodeURIComponent(crumb)}`;
  let auth = await yahooAuth();
  if (!auth) throw new Error('yahoo auth handshake failed');
  let res = await fetch(url(auth.crumb), { headers: { ...UA, Cookie: auth.cookie } });
  if (res.status === 401) { // stale crumb → refresh once
    auth = await yahooAuth(true);
    if (!auth) throw new Error('yahoo auth refresh failed');
    res = await fetch(url(auth.crumb), { headers: { ...UA, Cookie: auth.cookie } });
  }
  if (!res.ok) throw new Error(`yahoo quote HTTP ${res.status}`);
  const json = await res.json().catch(() => null);
  // deno-lint-ignore no-explicit-any
  return ((json as any)?.quoteResponse?.result ?? []) as any[];
}

// Today's intraday shape, one downsampled close series per symbol (owner
// request 2026-07-29: a tile shows the whole day's movement, not just a number).
// Best-effort by design — a failed spark chunk costs its tiles their sparkline,
// never the quote itself, so the panel degrades to what it showed before.
async function sparkChunk(symbols: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const q = symbols.map(toYahoo).map(encodeURIComponent).join(',');
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${q}&range=1d&interval=5m`,
    { headers: UA },
  ).catch(() => null);
  if (!res || !res.ok) return out;
  const json = await res.json().catch(() => null);
  // deno-lint-ignore no-explicit-any
  const rows = ((json as any)?.spark?.result ?? []) as any[];
  for (const r of rows) {
    const sym = String(r?.symbol ?? '').toUpperCase();
    const closes = (r?.response?.[0]?.indicators?.quote?.[0]?.close ?? [])
      .filter((c: unknown) => typeof c === 'number' && Number.isFinite(c)) as number[];
    if (closes.length < 2 || !sym) continue;
    // Downsample by even stride: 78 points of detail is invisible at ~44px wide
    // and would multiply the payload across a large roster.
    const step = Math.max(1, Math.ceil(closes.length / SPARK_POINTS));
    const thin = closes.filter((_, i) => i % step === 0);
    // always keep the true last close so the line ends where the price does
    if (thin[thin.length - 1] !== closes[closes.length - 1]) thin.push(closes[closes.length - 1]);
    out.set(sym, thin.map((v) => Number(v.toFixed(4))));
  }
  return out;
}

// Resolve the price the owner should see, and the % that belongs beside it.
//
// Owner ruling 2026-07-29: Change % measures from the PRIOR CLOSE and includes
// extended hours, so one number keeps the same meaning all day and all evening.
// We reach it by COMPOUNDING Yahoo's two percentages rather than dividing by
// `regularMarketPreviousClose` — that field silently shifts basis during the
// pre-market window (it can point at the session before last), whereas
// post/preMarketChangePercent are each defined against a known anchor:
//   post% is measured off today's regular close, reg% off the prior close,
//   so (1+reg%)(1+post%)-1 is the exact prior-close move. Checked against live
//   data: SOXL reg −14.522%, post +1.8486% → −12.94%.
// Pre-market has no regular session yet, so pre% IS already the prior-close move.
// deno-lint-ignore no-explicit-any
function priceRow(sym: string, q: any, spark?: number[]) {
  const reg = num(q.regularMarketPrice);
  const regPct = num(q.regularMarketChangePercent);
  const post = num(q.postMarketPrice), postPct = num(q.postMarketChangePercent);
  const pre = num(q.preMarketPrice), prePct = num(q.preMarketChangePercent);
  let last = reg, pct = regPct, ext = false;
  // `at` must timestamp the price we actually SHOW (Codex review, PR #188):
  // a pre-market row stamped with regularMarketTime would date a current
  // pre-open print to the prior close, and the roster-wide asOf is a max over
  // these — so one mis-stamped row would drag the panel's whole as-of back.
  let at = num(q.regularMarketTime);
  if (post != null) {
    last = post;
    pct = postPct != null && regPct != null ? ((1 + regPct / 100) * (1 + postPct / 100) - 1) * 100 : regPct;
    ext = true;
    at = num(q.postMarketTime) ?? at;
  } else if (pre != null) {
    last = pre;
    pct = prePct;
    ext = true;
    at = num(q.preMarketTime) ?? at;
  }
  return {
    sym,                                        // the roster's own form (BRK.B, ^VIX)
    name: q.shortName ?? q.longName ?? null,
    last,
    pct: pct == null ? null : Number(pct.toFixed(2)),
    ext,                                        // last came from a pre/post print
    bid: num(q.bid), ask: num(q.ask),
    vol: num(q.regularMarketVolume),
    // Indices have no extended session at all (hasPrePostMarketData:false) —
    // they simply repeat their close once constituents stop printing. Flagging
    // it lets the panel say "at close" rather than imply a stalled quote.
    index: sym.startsWith('^') || q.quoteType === 'INDEX',
    at,
    spark: spark && spark.length >= 2 ? spark : null,  // today's shape, or null
  };
}

type List = { title: string; symbols: string[] };

// deno-lint-ignore no-explicit-any
function normalizeLists(raw: any[]): List[] {
  const out: List[] = [];
  for (const l of raw) {
    const title = typeof l?.title === 'string' ? l.title.trim() : '';
    const symbols = (Array.isArray(l?.symbols) ? l.symbols : [])
      .map((s: unknown) => String(s ?? '').trim().toUpperCase())
      .filter((s: string) => /^[A-Z0-9.^-]{1,10}$/.test(s));
    // A list with no symbols is kept: the panel should show the owner's empty
    // list as an empty tab, not silently lose it.
    if (title) out.push({ title, symbols });
  }
  return out;
}

// The owner's live roster. Service-role read of an RLS deny-all table.
//
// Do NOT send the browser-shaped UA on this call. This project's service key is
// the newer `sb_secret_…` format, and Supabase's gateway refuses a secret key
// whenever the request looks like it came from a browser — a Mozilla/5.0
// user-agent is enough to trip it, and the reply is a 401 "Forbidden use of
// secret API key in browser" that this function's .catch would swallow into a
// silent empty roster. UA belongs on the OUTBOUND Yahoo calls only.
async function listsFromTable(): Promise<List[] | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const res = await fetch(
    `${url}/rest/v1/desk_watchlists?select=title,symbols,pos&order=pos.asc,id.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  // An EMPTY array is a successful read of a deliberately empty roster, not a
  // failure (Codex review, PR #188). Returning null here would fall through to
  // the bootstrap config, so deleting every list would appear not to persist —
  // the owner's save would silently resurrect the seeded ETFs. Only an
  // unreachable/!ok/non-array response counts as failure.
  return normalizeLists(rows);
}

// Bootstrap fallback — the committed config, used only if the table read fails.
async function listsFromConfig(): Promise<List[] | null> {
  const res = await fetch(CONFIG_URL, { headers: UA }).catch(() => null);
  if (!res || !res.ok) return null;
  const cfg = await res.json().catch(() => null);
  const lists = normalizeLists(Array.isArray(cfg?.lists) ? cfg.lists : []);
  return lists.length ? lists : null;
}

async function loadLists(): Promise<{ lists: List[]; source: 'table' | 'config' }> {
  const fromTable = await listsFromTable();
  // null = read failed; [] = read succeeded and the owner has no lists.
  if (fromTable !== null) return { lists: fromTable, source: 'table' };
  const fromConfig = await listsFromConfig();
  if (fromConfig) return { lists: fromConfig, source: 'config' };
  throw new Error('no watchlists available from desk_watchlists or config');
}

// ── handler ─────────────────────────────────────────────────────────────────
let cache: { at: number; body: unknown } | null = null;
let inflight: Promise<unknown> | null = null; // single-flight: a burst shares one sweep

async function refresh(): Promise<unknown> {
  const { lists, source } = await loadLists();
  // One fetch per unique symbol no matter how many lists repeat it.
  const all = [...new Set(lists.flatMap((l) => l.symbols))];
  const uniq = all.slice(0, MAX_SYMBOLS);
  // Anything past the cap is REPORTED, never silently dropped (Codex review,
  // PR #188): the RPC will happily persist more symbols than this fetch covers,
  // and a saved ticker vanishing from its tab with no explanation is exactly
  // the silent-truncation failure the `missing` channel exists to prevent.
  const truncated = all.slice(MAX_SYMBOLS);
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));
  const sparkChunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += SPARK_CHUNK) sparkChunks.push(uniq.slice(i, i + SPARK_CHUNK));
  // Quotes and sparks fetched together; sparks are best-effort so their failure
  // never reaches the caller's catch.
  const [results, sparkMaps] = await Promise.all([
    Promise.all(chunks.map((c) => quoteChunk(c))),
    Promise.all(sparkChunks.map((c) => sparkChunk(c).catch(() => new Map<string, number[]>()))),
  ]);
  const sparks = new Map<string, number[]>();
  for (const m of sparkMaps) for (const [k, v] of m) sparks.set(k, v);

  // Key upstream rows by Yahoo's form so BRK.B → BRK-B still resolves.
  // deno-lint-ignore no-explicit-any
  const byYahoo = new Map<string, any>();
  for (const q of results.flat()) if (q?.symbol) byYahoo.set(String(q.symbol).toUpperCase(), q);

  const rows = new Map<string, ReturnType<typeof priceRow>>();
  const missing: string[] = [...truncated];
  for (const sym of uniq) {
    const q = byYahoo.get(toYahoo(sym));
    if (q) rows.set(sym, priceRow(sym, q, sparks.get(toYahoo(sym))));
    else missing.push(sym);
  }
  // NOT an error when the upstream calls succeeded and simply knew none of the
  // symbols (Codex review, PR #188). Throwing there would 502 — or serve a
  // stale cached roster — so a list of pure typos could never show the
  // unresolved-ticker warning that explains it, and an edit would appear not to
  // apply. quoteChunk already throws on a genuine upstream failure, which is
  // the only case that should reach the caller's catch.
  if (uniq.length && !rows.size && !results.flat().length && !byYahoo.size) {
    throw new Error('no quotes resolved for any symbol');
  }

  const body = {
    ok: true,
    source,   // 'table' = the owner's live edits; 'config' = bootstrap fallback
    generatedAt: new Date().toISOString(),
    // Newest quote timestamp across the roster — the panel's as-of stamp.
    asOf: (() => {
      const ts = [...rows.values()].map((r) => r.at).filter((t): t is number => t != null);
      return ts.length ? new Date(Math.max(...ts) * 1000).toISOString() : new Date().toISOString();
    })(),
    // A symbol upstream doesn't know (a typo the owner just saved) is reported,
    // not silently dropped — otherwise a fat-fingered ticker just vanishes.
    missing,
    lists: lists.map((l) => ({
      title: l.title,
      rows: l.symbols.map((s) => rows.get(s)).filter(Boolean),
    })),
  };
  cache = { at: Date.now(), body };
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  // force: the dashboard's "Refresh now" button bypasses the cache.
  let force = false;
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
  }

  if (!force && cache && Date.now() - cache.at < ttlMs()) return reply(200, cache.body);

  try {
    inflight ??= refresh().finally(() => { inflight = null; });
    return reply(200, await inflight);
  } catch (e) {
    if (cache) return reply(200, cache.body); // stale-but-honest beats a dead panel
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
