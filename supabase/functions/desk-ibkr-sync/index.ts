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

// day % for position chips — public Stooq, best-effort (null → 0 in the UI)
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

function lastTradingDayIso(): string {
  const d = new Date();
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
      positions: a.positions.map((p: any) => ({ sym: p.sym, qty: p.qty, mkt: p.mkt, dayPct: pct[p.sym] ?? 0, unrl: p.unrl })),
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
