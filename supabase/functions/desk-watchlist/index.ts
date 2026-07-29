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

// Chart timeframe (owner request 2026-07-30). The caller sends a TOKEN, which
// is looked up here; the range/interval strings that reach Yahoo come from this
// table and are never built from caller input. That is what keeps the header
// comment's "no caller input reaches the upstream URL" true now that the panel
// has a control — an anon-callable function must not let a query param through
// to a third party.
//
// Interval is paired to range so the point count stays in the same band before
// downsampling (Yahoo caps intraday history, and a 5y daily series would be
// ~1250 points to throw away): minutes for a day, days out to a year, weeks
// beyond that.
const WL_RANGES: Record<string, { range: string; interval: string }> = {
  '1d': { range: '1d', interval: '5m' },
  '1mo': { range: '1mo', interval: '1d' },
  '3mo': { range: '3mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y': { range: '1y', interval: '1d' },
  '2y': { range: '2y', interval: '1wk' },
  '5y': { range: '5y', interval: '1wk' },
};
const DEFAULT_RANGE = '1d';
const rangeKey = (raw: unknown): string =>
  typeof raw === 'string' && Object.hasOwn(WL_RANGES, raw) ? raw : DEFAULT_RANGE;

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

// Yahoo hyphenates a SHARE-CLASS dot (BRK.B → BRK-B) but keeps an EXCHANGE
// suffix intact (DX-Y.NYB, the dollar index, stays as it is). Replacing every
// dot mangled the second kind into DX-Y-NYB, which resolves to nothing — so the
// rule is narrowed to a dot followed by a single trailing letter, which is what
// a share class looks like and an exchange code never is.
const toYahoo = (s: string) => s.replace(/\.([A-Z])$/, '-$1');
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
async function sparkChunk(symbols: string[], tf: string): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const q = symbols.map(toYahoo).map(encodeURIComponent).join(',');
  // Both come from WL_RANGES (see rangeKey) — never from the request body.
  const { range, interval } = WL_RANGES[tf] ?? WL_RANGES[DEFAULT_RANGE];
  const res = await fetch(
    `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${q}&range=${range}&interval=${interval}`,
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
function priceRow(sym: string, q: any, spark: number[] | undefined, intraday: boolean) {
  const reg = num(q.regularMarketPrice);
  const regPct = num(q.regularMarketChangePercent);
  const post = num(q.postMarketPrice), postPct = num(q.postMarketChangePercent);
  const pre = num(q.preMarketPrice), prePct = num(q.preMarketChangePercent);
  let last = reg, pct = regPct, ext = false;
  let extKind: 'pre' | 'post' | null = null;
  // `at` must timestamp the price we actually SHOW (Codex review, PR #188):
  // a pre-market row stamped with regularMarketTime would date a current
  // pre-open print to the prior close, and the roster-wide asOf is a max over
  // these — so one mis-stamped row would drag the panel's whole as-of back.
  let at = num(q.regularMarketTime);
  if (post != null) {
    last = post;
    pct = postPct != null && regPct != null ? ((1 + regPct / 100) * (1 + postPct / 100) - 1) * 100 : regPct;
    ext = true;
    extKind = 'post';
    at = num(q.postMarketTime) ?? at;
  } else if (pre != null) {
    last = pre;
    pct = prePct;
    ext = true;
    extKind = 'pre';
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
    // The selected window's shape — see buildSpark for why pre and post are
    // handled apart, and why that only applies intraday.
    spark: buildSpark(spark, last, reg, extKind, intraday),
  };
}

// The spark endpoint is regular-session ONLY and ignores includePrePost
// entirely (measured: same 79 points, same last value with the flag on), which
// makes the two extended windows behave very differently:
//
//   POST-market — the series IS today's session, it just stops at the close
//   while the tile shows a later price (SPY ending 740.86 beside a displayed
//   743.62). Appending the extended last makes the line finish where the price
//   and the pill do; the steep final segment is the after-hours move, which the
//   prior-close Change % already counts.
//
//   PRE-market — today's regular session HASN'T HAPPENED, so range=1d returns
//   YESTERDAY's path. Appending today's pre-open print there would draw all of
//   yesterday's intraday movement plus an overnight gap and label it "today"
//   (Codex review, PR #190). Instead the line becomes the only true statement
//   available: prior close → current pre-market price, which is exactly what
//   the pre-market Change % measures.
//
// Both of those are properties of a ONE-DAY window, so they apply only when the
// selected timeframe is intraday (owner request 2026-07-30 added 1M…5Y). On a
// multi-day range the series is a run of daily/weekly closes and neither
// special case holds: the pre-market rewrite would throw away a year of history
// to draw a two-point line, and there is no "yesterday's path mislabelled as
// today" hazard because the series legitimately spans many days. What stays
// true at every timeframe is that the line should END where the displayed price
// is, so an extended print is appended in both modes.
function buildSpark(
  series: number[] | undefined,
  last: number | null,
  regClose: number | null,
  extKind: 'pre' | 'post' | null,
  intraday: boolean,
): number[] | null {
  if (last == null) return series && series.length >= 2 ? series : null;
  if (intraday && extKind === 'pre') {
    // During pre-market Yahoo's regularMarketPrice is still the prior close.
    return regClose != null && regClose !== last ? [regClose, Number(last.toFixed(4))] : null;
  }
  if (!series || series.length < 2) return null;
  if (!extKind || series[series.length - 1] === last) return series;
  return [...series, Number(last.toFixed(4))];
}

type List = { title: string; symbols: string[] };

// deno-lint-ignore no-explicit-any
function normalizeLists(raw: any[]): List[] {
  const out: List[] = [];
  for (const l of raw) {
    const title = typeof l?.title === 'string' ? l.title.trim() : '';
    const symbols = (Array.isArray(l?.symbols) ? l.symbols : [])
      .map((s: unknown) => String(s ?? '').trim().toUpperCase())
      .filter((s: string) => /^[A-Z0-9.^=-]{1,10}$/.test(s));
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
// Keyed BY TIMEFRAME (owner request 2026-07-30). Two ranges are two different
// bodies — a 1D sweep and a 5Y sweep share their quotes but never their spark
// series — so one shared slot would serve whichever range asked last to
// whoever asked next, and flipping the control would appear to do nothing (or
// worse, redraw the wrong window under the right label). Same reasoning as
// quote-proxy's prepost cache key.
const cache = new Map<string, { at: number; body: unknown }>();
const inflight = new Map<string, Promise<unknown>>(); // single-flight, per range

// The quote roster is IDENTICAL for every timeframe — only the spark series
// differs — so it is fetched once and shared (Codex review, PR #195). Keying
// single-flight purely by timeframe meant clicking through all seven buttons on
// a cold cache started seven complete sweeps, each re-fetching the same quotes:
// at the 1000-symbol cap that is 20 quote calls per sweep, 140 for the burst,
// reachable anonymously without `force`. Now a burst costs ONE quote sweep plus
// one spark sweep per range.
// deno-lint-ignore no-explicit-any
type Sweep = { lists: List[]; source: 'table' | 'config'; uniq: string[]; truncated: string[]; byYahoo: Map<string, any>; quoted: number };
let quoteCache: { at: number; data: Sweep } | null = null;
let quoteInflight: Promise<Sweep> | null = null;

async function quoteSweep(): Promise<Sweep> {
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
  const results = await Promise.all(chunks.map((c) => quoteChunk(c)));
  // Key upstream rows by Yahoo's form so BRK.B → BRK-B still resolves.
  // deno-lint-ignore no-explicit-any
  const byYahoo = new Map<string, any>();
  for (const q of results.flat()) if (q?.symbol) byYahoo.set(String(q.symbol).toUpperCase(), q);
  return { lists, source, uniq, truncated, byYahoo, quoted: results.flat().length };
}

function sharedSweep(): Promise<Sweep> {
  if (quoteCache && Date.now() - quoteCache.at < ttlMs()) return Promise.resolve(quoteCache.data);
  quoteInflight ??= quoteSweep()
    .then((s) => { quoteCache = { at: Date.now(), data: s }; return s; })
    .finally(() => { quoteInflight = null; });
  return quoteInflight;
}

// Spark series ARE range-specific, so these stay keyed by timeframe.
const sparkCache = new Map<string, { at: number; map: Map<string, number[]> }>();
const sparkInflight = new Map<string, Promise<Map<string, number[]>>>();

function sharedSparks(uniq: string[], tf: string): Promise<Map<string, number[]>> {
  const hit = sparkCache.get(tf);
  if (hit && Date.now() - hit.at < ttlMs()) return Promise.resolve(hit.map);
  let job = sparkInflight.get(tf);
  if (!job) {
    const sparkChunks: string[][] = [];
    for (let i = 0; i < uniq.length; i += SPARK_CHUNK) sparkChunks.push(uniq.slice(i, i + SPARK_CHUNK));
    // Best-effort: a failed spark chunk costs its tiles their line, never the quote.
    job = Promise.all(sparkChunks.map((c) => sparkChunk(c, tf).catch(() => new Map<string, number[]>())))
      .then((maps) => {
        const out = new Map<string, number[]>();
        for (const m of maps) for (const [k, v] of m) out.set(k, v);
        sparkCache.set(tf, { at: Date.now(), map: out });
        return out;
      })
      .finally(() => { sparkInflight.delete(tf); });
    sparkInflight.set(tf, job);
  }
  return job;
}

async function refresh(tf: string): Promise<unknown> {
  const intraday = tf === '1d';
  const { lists, source, uniq, truncated, byYahoo, quoted } = await sharedSweep();
  const sparks = await sharedSparks(uniq, tf);

  const rows = new Map<string, ReturnType<typeof priceRow>>();
  const missing: string[] = [...truncated];
  for (const sym of uniq) {
    const q = byYahoo.get(toYahoo(sym));
    if (q) rows.set(sym, priceRow(sym, q, sparks.get(toYahoo(sym)), intraday));
    else missing.push(sym);
  }
  // NOT an error when the upstream calls succeeded and simply knew none of the
  // symbols (Codex review, PR #188). Throwing there would 502 — or serve a
  // stale cached roster — so a list of pure typos could never show the
  // unresolved-ticker warning that explains it, and an edit would appear not to
  // apply. quoteChunk already throws on a genuine upstream failure, which is
  // the only case that should reach the caller's catch.
  if (uniq.length && !rows.size && !quoted && !byYahoo.size) {
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
    // Echoed so the client can tell WHICH window it is drawing. A late reply
    // for the range the owner just switched away from would otherwise repaint
    // the tiles with the wrong series under the newly-selected label.
    range: tf,
    lists: lists.map((l) => ({
      title: l.title,
      // The COMPLETE saved order, including symbols that resolved to nothing.
      // `rows` holds only what quoted, so a client that reordered tiles and
      // wrote back from rows alone would silently delete every unresolved
      // ticker. Reordering has to operate on this array.
      symbols: l.symbols,
      rows: l.symbols.map((s) => rows.get(s)).filter(Boolean),
    })),
  };
  cache.set(tf, { at: Date.now(), body });
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(405, { ok: false, error: 'GET or POST' });

  // force: the dashboard's "Refresh now" button bypasses the cache.
  let force = false;
  let tf = DEFAULT_RANGE;
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    force = body?.force === true;
    // Anything unrecognised falls back to 1d rather than erroring: an older
    // cached client asking for a range this deploy doesn't know should still
    // get a working panel.
    tf = rangeKey(body?.range);
  }

  // A force is either the manual "Refresh now" or a roster edit that just
  // saved, and it has to invalidate EVERY timeframe (Codex review, PR #195).
  // Clearing only the selected one left the others holding the pre-edit roster
  // for up to the closed-session hour: add a symbol while on 1D, switch back to
  // 1Y, and the old list reappears as though the save had failed.
  if (force) {
    quoteCache = null;
    sparkCache.clear();
    cache.clear();
  }

  const hit = cache.get(tf);
  if (!force && hit && Date.now() - hit.at < ttlMs()) return reply(200, hit.body);

  try {
    let job = inflight.get(tf);
    if (!job) {
      job = refresh(tf).finally(() => { inflight.delete(tf); });
      inflight.set(tf, job);
    }
    return reply(200, await job);
  } catch (e) {
    // Stale-but-honest beats a dead panel — but only from THIS range's slot.
    // Serving another timeframe's body here would draw the wrong window under
    // the label the owner selected.
    const stale = cache.get(tf);
    if (stale) return reply(200, stale.body);
    return reply(502, { ok: false, error: String((e as Error)?.message || e) });
  }
});
