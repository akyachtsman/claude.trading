// ── desk-ibkr-sync — IBKR Flex → desk tables, on the Supabase Cron schedule ──
// Replaces the nightly fetch-ibkr.js step (retire-nightly-pipeline plan,
// Group B). Same Flex SendRequest → GetStatement flow, same parsing, same
// idempotent upserts and expected-as-of guard — only the scheduler changed.
//
// NOT public surface: requires the x-cron-secret header (CRON_SECRET env);
// pg_cron invokes it at 22:35 and 09:35 UTC via net.http_post. Polling is
// capped ≤ ~60s to fit the edge wall-clock limit — a statement that isn't
// ready exits honestly as not-ready and the second cron slot is the retry,
// exactly the retired pipeline's behavior. Token-invalid errors surface in
// the response + function logs (alerting = lamps + logs, Clarification 2;
// the pipeline's renewal email was never configured).
//
// Secrets (function env): IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID, CRON_SECRET,
// optional IBKR_ACCOUNT_MAP ("U1234567=1,U7654321=2").

import { XMLParser } from 'npm:fast-xml-parser@4';

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const FLEX_BASE = 'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService';
const TOKEN_ERROR_CODES = new Set(['1012', '1015']); // expired / invalid token
const UA = { 'user-agent': 'claude.trading desk-ibkr-sync' };

const maskId = (id: string) => String(id).slice(0, 2) + '***' + String(id).slice(-2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
// deno-lint-ignore no-explicit-any
const asArray = (x: any) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const normDate = (s: unknown) => {
  const d = String(s || '').replaceAll('-', '');
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
};

type FlexErr = { code: string; message: string };
// deno-lint-ignore no-explicit-any
export function flexError(doc: any): FlexErr | null {
  const r = doc?.FlexStatementResponse;
  if (!r || String(r.Status).toLowerCase() === 'success') return null;
  return { code: String(r.ErrorCode ?? ''), message: String(r.ErrorMessage ?? 'unknown Flex error') };
}

// deno-lint-ignore no-explicit-any
async function flexCall(url: string): Promise<any> {
  const res = await fetch(url, { headers: UA });
  return parser.parse(await res.text());
}

const isTransientFlex = (e: FlexErr | null) =>
  e && (e.code === '1001' || e.code === '1019' || /try again|in progress|at this time/i.test(e.message));

// Edge-budget version of the pipeline's requestStatement: 2 SendRequest
// attempts (15s apart) + ≤4 GetStatement polls (5s, then 15s) ≈ 65s worst
// case — the second cron slot is the retry for anything slower.
// deno-lint-ignore no-explicit-any
async function requestStatement(token: string, queryId: string): Promise<any> {
  let send, err: FlexErr | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(15000);
    send = await flexCall(`${FLEX_BASE}.SendRequest?t=${token}&q=${queryId}&v=3`);
    err = flexError(send);
    if (!err) break;
    if (!isTransientFlex(err)) throw Object.assign(new Error(`Flex SendRequest ${err.code}: ${err.message}`), { flex: err });
  }
  if (err) throw Object.assign(new Error(`Flex SendRequest ${err.code}: ${err.message}`), { flex: err, transient: true });
  const ref = send.FlexStatementResponse.ReferenceCode;
  const getUrl = send.FlexStatementResponse.Url || `${FLEX_BASE}.GetStatement`;

  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 5000 : 15000);
    const doc = await flexCall(`${getUrl}?t=${token}&q=${ref}&v=3`);
    const e = flexError(doc);
    if (!e) return doc;
    if (e.code === '1019' || /in progress|not yet ready/i.test(e.message)) continue; // still generating
    if (e.code === '1018') continue; // rate-limited — next poll after 15s
    throw Object.assign(new Error(`Flex GetStatement ${e.code}: ${e.message}`), { flex: e });
  }
  throw Object.assign(new Error('Flex statement still generating after the ~60s edge budget'), { transient: true });
}

// Statement XML → per-account snapshot rows. Verbatim port — fixture-tested
// in the retired pipeline.
// deno-lint-ignore no-explicit-any
export function parseStatements(doc: any) {
  const statements = asArray(doc?.FlexQueryResponse?.FlexStatements?.FlexStatement);
  // deno-lint-ignore no-explicit-any
  return statements.map((st: any) => {
    const equityRows = asArray(st?.EquitySummaryInBase?.EquitySummaryByReportDateInBase)
      // deno-lint-ignore no-explicit-any
      .map((r: any) => ({ as_of: normDate(r['@_reportDate']), nav: Number(r['@_total']), cash: Number(r['@_cash'] ?? NaN) }))
      // deno-lint-ignore no-explicit-any
      .filter((r: any) => r.as_of && Number.isFinite(r.nav) && r.nav > 0)
      // deno-lint-ignore no-explicit-any
      .sort((a: any, b: any) => a.as_of.localeCompare(b.as_of));
    const positions = asArray(st?.OpenPositions?.OpenPosition)
      // deno-lint-ignore no-explicit-any
      .map((p: any) => ({
        sym: String(p['@_symbol'] || '').trim(),
        qty: Number(p['@_position']),
        mkt: Number(p['@_positionValue']),
        unrl: Number(p['@_fifoPnlUnrealized'] ?? 0),
      }))
      // deno-lint-ignore no-explicit-any
      .filter((p: any) => p.sym && Number.isFinite(p.mkt) && p.qty !== 0);
    const last = equityRows[equityRows.length - 1], prev = equityRows[equityRows.length - 2];
    return {
      accountId: String(st['@_accountId'] || ''),
      asOf: last?.as_of || normDate(st['@_toDate']),
      nav: last?.nav ?? null,
      cash: Number.isFinite(last?.cash) ? last.cash : 0,
      dayPnl: last && prev ? Number((last.nav - prev.nav).toFixed(2)) : null,
      // deno-lint-ignore no-explicit-any
      totalUnrl: Number(positions.reduce((s: number, p: any) => s + (Number.isFinite(p.unrl) ? p.unrl : 0), 0).toFixed(2)),
      positions,
      // deno-lint-ignore no-explicit-any
      equity: equityRows.map(({ as_of, nav }: any) => ({ as_of, nav })),
    };
    // deno-lint-ignore no-explicit-any
  }).filter((a: any) => a.accountId && a.asOf && a.nav !== null);
}

export function accountKeyMap(accountIds: string[]): (id: string) => number | null {
  const env = Deno.env.get('IBKR_ACCOUNT_MAP');
  if (env) {
    const map = Object.fromEntries(env.split(',').map((p) => p.split('=').map((s) => s.trim())));
    return (id) => Number(map[id]) || null;
  }
  const sorted = [...accountIds].sort();
  return (id) => sorted.indexOf(id) + 1 || null;
}

// day % for position chips — public market data, best-effort (null → 0 in UI).
// Yahoo first, Stooq second (owner report 2026-07-28). This was Stooq-ONLY, so
// once Stooq began serving its HTML JS-challenge page as HTTP 200 every synced
// position chip silently lost its day-% — the sync still "succeeded", the
// number just quietly went missing. Stooq stays as the backstop.
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
  /* Which session the PRICE belongs to is read off the quote's own timestamp,
     NEVER off the wall clock (fixed 2026-08-21, hours after the first cut
     shipped with the clock version). The two differ for most of the day: at
     00:48 ET the clock says "today" is the new date while the newest bar and
     the quote are both still the previous session, so a clock comparison
     concluded the last bar was not today, took that same bar as the baseline,
     and measured its close against itself — every symbol read 0.00%, verified
     on FRMI against a real +3.65% move. Overnight is precisely when the sync
     cron runs (09:35 UTC), so this would have written a zero for every
     position in the account.
     Comparing the quote's ET date with the last bar's ET date is true at every
     hour: mid-session both are today, after the close both are still today,
     and before the next session's bar exists both are still the prior day. */
  const etDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const quoteTs = Number(r?.meta?.regularMarketTime);
  const lastTs = stamps[stamps.length - 1];
  /* No usable timestamp on either side falls back to a VALUE test, which
     answers the same question: a price equal to the last bar's close IS that
     bar, so the baseline is the one before it. */
  const priceIsLastBar = Number.isFinite(quoteTs) && Number.isFinite(lastTs)
    ? etDate(quoteTs) === etDate(lastTs)
    : Math.abs(price - closes[closes.length - 1]) < 1e-6;
  const prev = priceIsLastBar ? closes[closes.length - 2] : closes[closes.length - 1];
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
/* IBKR's Flex feed pads an OCC option symbol to fixed width — "AVAV
   261002C00180000" with two spaces — and Yahoo 404s on that. Stripping the
   internal whitespace resolves all four of the owner's option positions
   (verified 2026-08-21: AVAV, LULU, NFLX and SPCX all priced), so these stop
   being unquotable and start carrying a real day-%. The underlying ticker is
   never guessed from the option symbol: an option's move is its own, and
   reporting the stock's percentage against a contract would be a wrong number
   wearing a plausible face. */
function upstreamSymbol(symbol: string): string {
  return symbol.replace(/\s+/g, '');
}
async function dayPctFor(raw: string): Promise<number | null> {
  const symbol = upstreamSymbol(raw);
  try {
    const via = await yahooDayPct(symbol).catch(() => null);
    if (via !== null) return via;
    return await stooqDayPct(symbol).catch(() => null);
  } catch { return null; }
}

// NYSE full-closure holidays (2026–2027 seeded; refresh annually) — a held
// day is never the "last closed session".
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// The most recent US session whose 16:00 ET close has ALREADY passed — the
// latest as-of IBKR can possibly have published. Both cron slots run when
// this is the SAME day: 22:35 UTC = 18:35 ET (today, already closed) and
// 09:35 UTC = 05:35 ET (today not open yet → yesterday). Computing this in
// UTC-calendar terms was the bug: the pre-market morning slot expected the
// current UTC day, which hasn't closed, so it rejected the valid prior-day
// statement forever.
function lastTradingDayIso(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // start at the ET calendar date; if the 16:00 ET close hasn't passed, the
  // last completed session is the prior day
  const cur = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  if (Number(get('hour')) < 16) cur.setUTCDate(cur.getUTCDate() - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  for (let i = 0; i < 10; i++) {                 // roll back weekends + holidays
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(iso(cur))) break;
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return iso(cur);
}

// Supabase REST helpers (service key — this function is cron-secret-gated)
function supa() {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  return {
    // deno-lint-ignore no-explicit-any
    select: async (path: string): Promise<any[]> => {
      const res = await fetch(`${url}/rest/v1/${path}`, { headers });
      if (!res.ok) throw new Error(`supa select ${res.status}`);
      return res.json();
    },
    upsert: async (table: string, rows: unknown[], onConflict: string): Promise<void> => {
      if (!rows.length) return;
      const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: { ...headers, prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`supa upsert ${table} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return reply(401, { ok: false, error: 'cron secret required' });
  }

  const token = Deno.env.get('IBKR_FLEX_TOKEN');
  const queryId = Deno.env.get('IBKR_FLEX_QUERY_ID');
  if (!token || !queryId) return reply(200, { ok: false, status: 'skipped', detail: 'IBKR secrets not set' });

  try {
    // deno-lint-ignore no-explicit-any
    let doc: any;
    try {
      doc = await requestStatement(token, queryId);
      // deno-lint-ignore no-explicit-any
    } catch (err: any) {
      if (err.flex && (TOKEN_ERROR_CODES.has(err.flex.code) || /token/i.test(err.flex.message))) {
        console.error('IBKR Flex token invalid/expired:', err.message);
        return reply(200, { ok: false, status: 'failed-token', detail: 'Flex token invalid/expired — renew in IBKR Client Portal, update the function secret' });
      }
      if (err.transient) return reply(200, { ok: false, status: 'not-ready', detail: err.message });
      throw err;
    }

    const accounts = parseStatements(doc);
    if (!accounts.length) throw new Error('Flex statement parsed to zero accounts — check the Flex query sections');

    const expected = lastTradingDayIso();
    // deno-lint-ignore no-explicit-any
    const behind = accounts.filter((a: any) => a.asOf < expected);
    if (behind.length) {
      // deno-lint-ignore no-explicit-any
      const got = behind.map((a: any) => `${maskId(a.accountId)}=${a.asOf}`).join(', ');
      return reply(200, { ok: false, status: 'not-ready', detail: `expected as-of ${expected}, got ${got} — the next cron slot retries` });
    }

    // deno-lint-ignore no-explicit-any
    const keyFor = accountKeyMap(accounts.map((a: any) => a.accountId));
    const db = supa();
    const users = await db.select('desk_users?select=id&is_test=eq.false&limit=1');
    if (!users.length) throw new Error('no owner row in desk_users');
    const userId = users[0].id;

    // deno-lint-ignore no-explicit-any
    const chipSyms: string[] = [...new Set(accounts.flatMap((a: any) => a.positions.map((p: any) => String(p.sym))))];
    const pctEntries = await Promise.all(chipSyms.map(async (s) => [s, await dayPctFor(s)] as const));
    const pct = Object.fromEntries(pctEntries);

    for (const a of accounts) {
      if (a.dayPnl !== null) continue;
      const key = keyFor(a.accountId);
      if (!key) continue;
      const prior = await db.select(
        `desk_equity_history?select=nav&user_id=eq.${userId}&account_key=eq.${key}&as_of=lt.${a.asOf}&order=as_of.desc&limit=1`,
      );
      a.dayPnl = prior.length ? Number((a.nav - Number(prior[0].nav)).toFixed(2)) : 0;
    }

    // deno-lint-ignore no-explicit-any
    const snapshots = accounts.map((a: any) => ({
      user_id: userId,
      account_key: keyFor(a.accountId),
      label: '', // empty ⇒ frontend keeps the scripts/config.js label
      as_of: a.asOf,
      nav: a.nav,
      day_pnl: a.dayPnl ?? 0,
      total_unrl: a.totalUnrl,
      cash: a.cash,
      // deno-lint-ignore no-explicit-any
      /* `?? null`, NOT `?? 0`. A symbol the feeds could not price is UNKNOWN,
         and storing 0 made the dashboard state that the position finished flat
         — which is exactly what it did for four option positions, one of them
         down 38% (owner check 2026-08-21). The client renders a null as an em
         dash; the same rule the watchlist rail already follows. */
      positions: a.positions.map((p: any) => ({ sym: p.sym, qty: p.qty, mkt: p.mkt, dayPct: pct[p.sym] ?? null, unrl: p.unrl })),
      // deno-lint-ignore no-explicit-any
    })).filter((s: any) => s.account_key);
    // deno-lint-ignore no-explicit-any
    const equity = accounts.flatMap((a: any) =>
      // deno-lint-ignore no-explicit-any
      a.equity.map((r: any) => ({ user_id: userId, account_key: keyFor(a.accountId), as_of: r.as_of, nav: r.nav }))
      // deno-lint-ignore no-explicit-any
    ).filter((r: any) => r.account_key);

    await db.upsert('desk_account_snapshots', snapshots, 'user_id,account_key,as_of');
    await db.upsert('desk_equity_history', equity, 'user_id,account_key,as_of');
    return reply(200, { ok: true, status: 'ok', asOf: accounts[0].asOf, snapshots: snapshots.length, equityRows: equity.length });
    // deno-lint-ignore no-explicit-any
  } catch (e: any) {
    console.error('desk-ibkr-sync failed:', String(e?.message || e));
    return reply(200, { ok: false, status: 'failed', detail: String(e?.message || e) });
  }
});
