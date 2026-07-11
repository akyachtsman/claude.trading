'use strict';
/* ── fetch-ibkr.js — IBKR Flex Web Service → Supabase (private domain) ───────
   SendRequest → poll GetStatement with backoff; Flex soft errors handled
   distinctly (plan.md): 1019 "generation in progress" ⇒ keep polling; 1018
   rate limit ⇒ back off longer; token invalid/expired ⇒ RENEW-TOKEN EMAIL —
   actionable, never a silent no-op. As-of assertion: day-T data must exist or
   we exit "not ready" WITHOUT upserting and let the 09:30 UTC cron retry.
   `--backfill` runs the one-time ~1Y historical query (SC-4) and skips the
   assertion. Flex query must include: Account Information, Change in NAV /
   Equity Summary in Base by ReportDate, Cash Report, Open Positions. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { XMLParser } from 'fast-xml-parser';
import { retryFetch, sleep, writeStatus, notice, warn, errorLine, isoDate, lastTradingDay } from './lib/util.js';
import { dayPctMap } from './lib/quotes.js';
import { supaConfigured, ownerUserId, supaUpsert, supaSelect } from './supa.js';

const FLEX_BASE = process.env.IBKR_FLEX_BASE_URL
  || 'https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService';
const TOKEN_ERROR_CODES = new Set(['1012', '1015']); // expired / invalid token

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const asArray = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const normDate = s => {
  const d = String(s || '').replaceAll('-', '');
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
};

/* Flex error responses come as <FlexStatementResponse><Status>Fail</Status>
   <ErrorCode>..</ErrorCode>… — surface {code, message} or null. */
export function flexError(doc) {
  const r = doc?.FlexStatementResponse;
  if (!r || String(r.Status).toLowerCase() === 'success') return null;
  return { code: String(r.ErrorCode ?? ''), message: String(r.ErrorMessage ?? 'unknown Flex error') };
}

async function flexCall(url) {
  const res = await retryFetch(url, { headers: { 'user-agent': 'claude.trading data-refresh' } });
  return parser.parse(await res.text());
}

/* Transient Flex conditions (observed 1001 "could not be generated at this
   time"; 1019 in-progress) — retry in-run, then exit not-ready for the
   morning cron rather than failing the domain. */
const isTransientFlex = e => e && (e.code === '1001' || e.code === '1019' || /try again|in progress|at this time/i.test(e.message));

async function requestStatement(token, queryId) {
  let send, err;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(30000);
    send = await flexCall(`${FLEX_BASE}.SendRequest?t=${token}&q=${queryId}&v=3`);
    err = flexError(send);
    if (!err) break;
    if (!isTransientFlex(err)) throw Object.assign(new Error(`Flex SendRequest ${err.code}: ${err.message}`), { flex: err });
    warn('Flex transient error', `${err.code}: ${err.message} — retry ${attempt + 1}/3`);
  }
  if (err) throw Object.assign(new Error(`Flex SendRequest ${err.code}: ${err.message}`), { flex: err, transient: true });
  const ref = send.FlexStatementResponse.ReferenceCode;
  const getUrl = send.FlexStatementResponse.Url || `${FLEX_BASE}.GetStatement`;

  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(attempt === 0 ? 5000 : 15000);
    const doc = await flexCall(`${getUrl}?t=${token}&q=${ref}&v=3`);
    const e = flexError(doc);
    if (!e) return doc;
    if (e.code === '1019' || /in progress|not yet ready/i.test(e.message)) continue; // still generating
    if (e.code === '1018') { warn('Flex rate limited', 'error 1018 — backing off 60s'); await sleep(60000); continue; }
    throw Object.assign(new Error(`Flex GetStatement ${e.code}: ${e.message}`), { flex: e });
  }
  throw new Error('Flex statement still generating after ~3 minutes of polling');
}

/* Statement XML → per-account {accountId, asOf, nav, cash, dayPnl, totalUnrl,
   positions[], equity[{as_of, nav}]}. Pure function — fixture-tested. */
export function parseStatements(doc) {
  const statements = asArray(doc?.FlexQueryResponse?.FlexStatements?.FlexStatement);
  return statements.map(st => {
    const equityRows = asArray(st?.EquitySummaryInBase?.EquitySummaryByReportDateInBase)
      .map(r => ({ as_of: normDate(r['@_reportDate']), nav: Number(r['@_total']), cash: Number(r['@_cash'] ?? NaN) }))
      .filter(r => r.as_of && Number.isFinite(r.nav) && r.nav > 0)
      .sort((a, b) => a.as_of.localeCompare(b.as_of));
    const positions = asArray(st?.OpenPositions?.OpenPosition)
      .map(p => ({
        sym: String(p['@_symbol'] || '').trim(),
        qty: Number(p['@_position']),
        mkt: Number(p['@_positionValue']),
        unrl: Number(p['@_fifoPnlUnrealized'] ?? 0),
      }))
      .filter(p => p.sym && Number.isFinite(p.mkt) && p.qty !== 0);
    const last = equityRows.at(-1), prev = equityRows.at(-2);
    return {
      accountId: String(st['@_accountId'] || ''),
      asOf: last?.as_of || normDate(st['@_toDate']),
      nav: last?.nav ?? null,
      cash: Number.isFinite(last?.cash) ? last.cash : 0,
      dayPnl: last && prev ? Number((last.nav - prev.nav).toFixed(2)) : null,
      totalUnrl: Number(positions.reduce((s, p) => s + (Number.isFinite(p.unrl) ? p.unrl : 0), 0).toFixed(2)),
      positions,
      equity: equityRows.map(({ as_of, nav }) => ({ as_of, nav })),
    };
  }).filter(a => a.accountId && a.asOf && a.nav !== null);
}

/* accountId → account_key (scripts/config.js roster). Explicit via
   IBKR_ACCOUNT_MAP="U1234567=1,U7654321=2"; else deterministic sorted order. */
export function accountKeyMap(accountIds) {
  const env = process.env.IBKR_ACCOUNT_MAP;
  if (env) {
    const map = Object.fromEntries(env.split(',').map(p => p.split('=').map(s => s.trim())));
    return id => Number(map[id]) || null;
  }
  const sorted = [...accountIds].sort();
  return id => sorted.indexOf(id) + 1 || null;
}

async function sendRenewTokenEmail(detail) {
  try {
    const { sendEmail } = createRequire(import.meta.url)('../notify-email.js');
    await sendEmail({
      subject: 'claude.trading: IBKR Flex token needs renewal',
      text: `The daily data refresh could not authenticate with IBKR Flex Web Service.\n\n${detail}\n\nRenew the token: IBKR Client Portal → Performance & Reports → Flex Queries → Flex Web Service Configuration, then update the IBKR_FLEX_TOKEN repo secret.`,
    });
  } catch (e) {
    warn('Renew-token email not sent', String(e.message || e));
  }
}

async function main() {
  const backfill = process.argv.includes('--backfill');
  const token = process.env.IBKR_FLEX_TOKEN;
  let queryId = process.env.IBKR_FLEX_QUERY_ID;
  if (!token || !queryId) {
    notice('IBKR fetch skipped', 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set — account snapshots unchanged (add secrets to go live).');
    await writeStatus('accounts', { status: 'skipped', detail: 'IBKR secrets not set' });
    return;
  }
  if (!supaConfigured()) {
    notice('IBKR fetch skipped', 'DB_URL / DB_SERVICE_KEY not set — nowhere to store private snapshots.');
    await writeStatus('accounts', { status: 'skipped', detail: 'DB secrets not set' });
    return;
  }
  if (backfill) {
    if (process.env.IBKR_FLEX_BACKFILL_QUERY_ID) queryId = process.env.IBKR_FLEX_BACKFILL_QUERY_ID;
    else notice('Backfill using daily query', 'IBKR_FLEX_BACKFILL_QUERY_ID not set — set it to a ~1Y Flex query for the full SC-4 backfill.');
  }

  let doc;
  try {
    doc = await requestStatement(token, queryId);
  } catch (err) {
    if (err.flex && (TOKEN_ERROR_CODES.has(err.flex.code) || /token/i.test(err.flex.message))) {
      errorLine('IBKR Flex token invalid/expired', err.message);
      await sendRenewTokenEmail(err.message);
      await writeStatus('accounts', { status: 'failed', detail: 'Flex token invalid/expired — renewal email sent' });
      process.exit(1);
    }
    if (err.transient) {
      notice('IBKR statement not ready', err.message + ' — no upsert; the next cron retries.');
      await writeStatus('accounts', { status: 'not-ready', detail: err.message });
      return;
    }
    throw err;
  }

  const accounts = parseStatements(doc);
  if (!accounts.length) throw new Error('Flex statement parsed to zero accounts — check the Flex query sections');

  const expected = isoDate(lastTradingDay());
  if (!backfill) {
    const behind = accounts.filter(a => a.asOf < expected);
    if (behind.length) {
      notice('IBKR statement not ready', `expected as-of ${expected}, got ${behind.map(a => `${a.accountId}=${a.asOf}`).join(', ')} — no upsert; the 09:30 UTC cron retries.`);
      await writeStatus('accounts', { status: 'not-ready', asOf: behind[0].asOf, detail: `expected ${expected}` });
      return;
    }
  }

  const keyFor = accountKeyMap(accounts.map(a => a.accountId));
  if (!process.env.IBKR_ACCOUNT_MAP) {
    notice('IBKR account mapping', `no IBKR_ACCOUNT_MAP set — mapping by sorted account id: ${accounts.map(a => `${a.accountId}→${keyFor(a.accountId)}`).join(', ')}`);
  }

  /* Position day % is PUBLIC data (Stooq) — the Flex snapshot has no prev
     close; null day % renders as 0.00 in the table, so best-effort here. */
  const pct = await dayPctMap(accounts.flatMap(a => a.positions.map(p => p.sym)));

  const userId = await ownerUserId();
  /* A one-day Flex query yields a single equity row ⇒ no in-statement prev
     close; recover day P&L from the NAV already accumulated in history. */
  for (const a of accounts) {
    if (a.dayPnl !== null) continue;
    const key = keyFor(a.accountId);
    if (!key) continue;
    const prior = await supaSelect(
      `desk_equity_history?select=nav&user_id=eq.${userId}&account_key=eq.${key}&as_of=lt.${a.asOf}&order=as_of.desc&limit=1`
    );
    a.dayPnl = prior.length ? Number((a.nav - Number(prior[0].nav)).toFixed(2)) : 0;
  }
  const snapshots = accounts.map(a => ({
    user_id: userId,
    account_key: keyFor(a.accountId),
    label: '', // empty ⇒ frontend keeps the scripts/config.js label
    as_of: a.asOf,
    nav: a.nav,
    day_pnl: a.dayPnl ?? 0,
    total_unrl: a.totalUnrl,
    cash: a.cash,
    positions: a.positions.map(p => ({ sym: p.sym, qty: p.qty, mkt: p.mkt, dayPct: pct[p.sym] ?? 0, unrl: p.unrl })),
  })).filter(s => s.account_key);
  const equity = accounts.flatMap(a =>
    a.equity.map(r => ({ user_id: userId, account_key: keyFor(a.accountId), as_of: r.as_of, nav: r.nav }))
  ).filter(r => r.account_key);

  await supaUpsert('desk_account_snapshots', snapshots, 'user_id,account_key,as_of');
  await supaUpsert('desk_equity_history', equity, 'user_id,account_key,as_of');
  await writeStatus('accounts', { status: 'ok', asOf: accounts[0].asOf });
  console.log(`IBKR upserted — ${snapshots.length} snapshots, ${equity.length} equity rows (backfill=${backfill})`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(async err => {
    errorLine('IBKR fetch failed', String(err.message || err));
    await writeStatus('accounts', { status: 'failed', detail: String(err.message || err) });
    process.exit(1);
  });
}
