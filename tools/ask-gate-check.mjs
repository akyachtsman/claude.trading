#!/usr/bin/env node
/* Re-runnable checks for the three ways into supabase/functions/desk-ask — above all the
   OPEN one (no PIN, owner ruling 2026-10-04) and the daily cap that bounds its cost.

     node tools/ask-gate-check.mjs             # the suite, against the function as committed
     node tools/ask-gate-check.mjs --mutants   # ...then prove each single-line mutant below is CAUGHT

   How: the same harness shape as tools/econ-check.mjs. The function is transpiled with the
   PINNED esbuild in tools/package.json (`npm ci --prefix tools` once; there is no Deno here)
   and run in a fresh `vm` context per check, which is a cold isolate (ONE context reused across
   several questions is a warm one): `Deno.serve` is captured,
   `fetch` is a stub that plays PostgREST (desk_users — the owner and a TEST user with its own PIN —,
   desk_system_prompt, desk_chat_memory, desk_ask_model — the model tier, desk_021, with failure modes —
   and the desk_open_ask_take RPC, whose atomic counter is a Map) and the Anthropic API, and `Date`
   runs on a settable clock so the Pacific day rolls where the check says it does. Nothing
   touches the network, the live Supabase project or an Anthropic key.

   What it proves and what it cannot: it proves what the FUNCTION does with each request — which
   door admitted it, what was read and written, what the model was shown, how many model calls
   it cost. It cannot prove the SQL in supabase/migrations/desk_020 or desk_021 (those are checked
   against a database: desk_020 live with a scratch day key, desk_021 by tools/ask-model-tier-verify.sql)
   — here the RPC and the desk_ask_model table are stand-ins that return what the SQL would. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'supabase/functions/desk-ask/index.ts');
const SITE = 'https://akyachtsman.github.io';
const DB_URL = 'https://db.supabase.test';
const DB_HOST = new URL(DB_URL).hostname;
const SERVICE_KEY = 'test-service-role-key';          // not a real key, and not secret-shaped
const CRON_SECRET = 'test-cron-secret';
const PIN = '4242';
const TEST_PIN = '9999';            // the CI test credential: a valid PIN on a row with is_test true
const SALT = 'salty';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_PROMPT = 'OWNER-PROMPT: you are talking to the owner about their own accounts.';
const PUBLIC_MARK = 'You are the desk assistant embedded in';   // the first words of DEFAULT_SYSTEM, which is committed
const T0 = Date.parse('2026-10-04T18:00:00Z');        // Sun 11:00 PDT, Oct 4 Pacific

// ── assertions ────────────────────────────────────────────────────────────────
class Fail extends Error {}
const assert = (c, m) => { if (!c) throw new Fail(m); };
const eq = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Fail(`${m}: got ${x}, want ${y}`); };

// ── the harness: one vm context = one cold isolate ────────────────────────────
const sha = (s) => createHash('sha256').update(s).digest('hex');
function fakeDb() {
  const db = {
    quota: new Map(),            // day -> n, the desk_open_ask_quota table
    log: [],                     // every request that reached the "database"
    memory: [{ question: 'earlier Q', answer: 'earlier A' }],
    memPosts: [],
    take: null,                  // override: (body) => Response, to simulate a failing counter
    // desk_ask_model, the model tier (desk_021). mode: ok | empty | nullmodel | http500 | throw | badjson | notarray
    tier: { mode: 'ok', model: 'claude-sonnet-5-5' },
    omitIsTest: false,           // a desk_users select that leaves is_test out (must read as "not admin")
  };
  db.rpc = () => db.log.filter((c) => c.path === '/rest/v1/rpc/desk_open_ask_take');
  db.touched = (table) => db.log.filter((c) => c.path === `/rest/v1/${table}`);
  db.handle = async (u, init) => {
    const h = new Headers(init.headers);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    db.log.push({ method, path: u.pathname, search: u.search, body, signal: !!init.signal });
    // the gateway, as CLAUDE.md records it: a secret key on a browser-shaped request is refused
    if (/mozilla/i.test(h.get('user-agent') || '')) return new Response('{"message":"Forbidden use of secret API key in browser"}', { status: 401 });
    if (h.get('apikey') !== SERVICE_KEY || h.get('authorization') !== `Bearer ${SERVICE_KEY}`) return new Response('{"message":"Invalid API key"}', { status: 401 });
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/rest/v1/rpc/desk_open_ask_take') {
      if (db.take) return db.take(body);
      // what desk_020 does, in one step: a bad cap or day is false; otherwise count up to the cap
      const { p_day: day, p_cap: cap } = body;
      if (!Number.isInteger(cap) || cap < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return json(false);
      const n = db.quota.get(day) ?? 0;
      if (n >= cap) return json(false);
      db.quota.set(day, n + 1);
      return json(true);
    }
    if (u.pathname === '/rest/v1/desk_users' && method === 'GET') {
      // PostgREST honours `select=` (only those columns come back), `is_test=eq.…` and `limit=`, and refuses a column that does not exist
      const known = ['id', 'salt', 'pin_hash', 'is_test'];
      const cols = (u.searchParams.get('select') || '*').split(',');
      if (cols[0] !== '*' && cols.some((c) => !known.includes(c))) return json({ message: 'column does not exist' }, 400);
      let rows = [
        { id: USER_ID, salt: SALT, pin_hash: sha(SALT + PIN), is_test: false },
        { id: TEST_USER_ID, salt: SALT, pin_hash: sha(SALT + TEST_PIN), is_test: true },
      ];
      const f = u.searchParams.get('is_test');
      if (f === 'eq.false') rows = rows.filter((r) => !r.is_test);
      if (f === 'eq.true') rows = rows.filter((r) => r.is_test);
      const lim = Number(u.searchParams.get('limit'));
      if (lim) rows = rows.slice(0, lim);
      rows = rows.map((r) => (cols[0] === '*' ? r : Object.fromEntries(cols.map((c) => [c, r[c]]))));
      return json(db.omitIsTest ? rows.map(({ is_test, ...r }) => r) : rows);
    }
    if (u.pathname === '/rest/v1/desk_ask_model') {
      const t = db.tier;
      if (t.mode === 'throw') throw new TypeError('network down');
      if (t.mode === 'http500') return json({ message: 'boom' }, 500);
      if (t.mode === 'badjson') return new Response('<html>not json</html>', { status: 200 });
      if (t.mode === 'notarray') return json({ model: t.model });
      // the same honesty for the tier table: only the columns asked for, a wrong column is a 400, the one row has id = true
      const known = ['id', 'model', 'updated_at', 'updated_by'];
      const cols = (u.searchParams.get('select') || '*').split(',');
      if (cols[0] !== '*' && cols.some((c) => !known.includes(c))) return json({ message: 'column does not exist' }, 400);
      const idf = u.searchParams.get('id');
      if (t.mode === 'empty' || (idf !== null && idf !== 'eq.true')) return json([]);
      const row = { id: true, model: t.mode === 'nullmodel' ? null : t.model, updated_at: '2026-10-14T00:00:00Z', updated_by: null };
      return json([cols[0] === '*' ? row : Object.fromEntries(cols.map((c) => [c, row[c]]))]);
    }
    if (u.pathname === '/rest/v1/desk_system_prompt') return json([{ content: OWNER_PROMPT }]);
    if (u.pathname === '/rest/v1/desk_chat_memory') {
      if (method === 'GET') return json(db.memory);
      db.memPosts.push(body);
      return new Response(null, { status: 201 });
    }
    return json({ message: 'not found' }, 404);
  };
  return db;
}

// A model answer the loop accepts at once: it carries a web source (so the forced-search turn
// does not fire) and ends the turn.
const MODEL_OK = () => new Response(JSON.stringify({
  stop_reason: 'end_turn', model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 },
  content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/a', title: 'A' }] },
    { type: 'text', text: 'the answer' },
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } });

// the same accepted answer, reported by the provider under another name (a dated id, as it really does)
const modelAs = (name) => () => new Response(JSON.stringify({
  stop_reason: 'end_turn', model: name, usage: { input_tokens: 10, output_tokens: 5 },
  content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/a', title: 'A' }] },
    { type: 'text', text: 'the answer' },
  ],
}), { status: 200, headers: { 'content-type': 'application/json' } });
const ALL_TIERS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const withTier = (tier, o = {}) => { const db = fakeDb(); db.tier = tier; return { db, ...o }; };

function boot(code, opts = {}) {
  const clock = { now: opts.now ?? T0 };
  const db = opts.db ?? fakeDb();
  const denoEnv = {
    SUPABASE_URL: DB_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ANTHROPIC_API_KEY: 'test-anthropic-key',
    CRON_SECRET, ...(opts.env ?? {}),
  };
  for (const k of Object.keys(denoEnv)) if (denoEnv[k] === undefined) delete denoEnv[k];
  const env = { clock, db, models: [], warns: [] };
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === DB_HOST) return db.handle(u, init);
    if (u.hostname === 'api.anthropic.com') {
      env.models.push(JSON.parse(init.body));
      return opts.model ? opts.model(env.models.length) : MODEL_OK();
    }
    throw new TypeError('fetch to an unexpected host: ' + u.href);
  };
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  let handler = null;
  const mod = { exports: {} };
  const sandbox = {
    module: mod, exports: mod.exports,
    Deno: { serve: (h) => { handler = h; }, env: { get: (k) => (Object.hasOwn(denoEnv, k) ? denoEnv[k] : undefined) } },
    fetch, Response, Request, Headers, AbortSignal, AbortController, URL, TextEncoder, crypto: webcrypto,
    setTimeout, clearTimeout, Date: FakeDate,
    console: { log() {}, info() {}, warn: (...a) => env.warns.push(a.join(' ')), error: (...a) => env.warns.push(a.join(' ')) },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'desk-ask.cjs' });
  assert(typeof handler === 'function', 'Deno.serve was never called');
  env.call = async (body = {}, o = {}) => {
    const headers = { 'content-type': 'application/json', ...(o.headers ?? {}) };
    const origin = 'origin' in o ? o.origin : SITE;
    if (origin !== null) headers.origin = origin;
    const res = await handler(new Request('https://x.supabase.co/functions/v1/desk-ask', {
      method: o.method ?? 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
    return { status: res.status, json, text };
  };
  env.open = (extra = {}, o = {}) => env.call({ question: 'how is NVDA?', context: { market: [] }, ...extra }, o);
  env.pin = (extra = {}, o = {}) => env.call({ pin: PIN, question: 'how is NVDA?', context: { market: [] }, ...extra }, o);
  // the system text and the snapshot the model was shown on its first call
  env.systemOf = (i = 0) => env.models[i].system.map((b) => b.text).join('\n');
  env.userTextOf = (i = 0) => JSON.stringify(env.models[i].messages);
  return env;
}

// ── the suite ─────────────────────────────────────────────────────────────────
const TESTS = [
  ['PIN path unchanged: 200, the saved conversation is read and appended (typed), the owner prompt is used, accounts reach the model, and the cap is never touched', async (code) => {
    const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: '1' } });
    for (let i = 0; i < 3; i++) {       // three PIN questions against a cap of ONE open question
      const r = await e.pin({ context: { accounts: [{ label: 'A', positions: [{ sym: 'ZZZ', dayPct: 1 }] }], market: [] } });
      eq([r.status, r.json.ok, r.json.answer, r.json.open], [200, true, 'the answer', undefined], `PIN question ${i + 1}`);
    }
    eq(e.db.rpc().length, 0, 'a PIN question never takes from the open quota');
    eq(e.db.touched('desk_chat_memory').filter((c) => c.method === 'GET').length, 3, 'the saved conversation is read for each');
    eq(e.db.memPosts.map((m) => [m.user_id, m.origin]), Array(3).fill([USER_ID, 'typed']), 'and appended, as the owner, as typed');
    assert(e.systemOf().startsWith(OWNER_PROMPT), 'the owner prompt leads');
    assert(!e.systemOf().includes(PUBLIC_MARK), 'and the public default does not');
    eq(e.db.touched('desk_system_prompt').length, 3, 'the stored prompt is read for each PIN question');
    assert(!/OPEN SESSION/.test(e.systemOf()), 'no open-session note for the owner');
    assert(/earlier Q/.test(e.userTextOf()) && /ZZZ/.test(e.userTextOf()), 'memory and the positions reach the model');
  }],

  ['a PIN that is sent and WRONG is a 401 — never a downgrade to an open question', async (code) => {
    const e = boot(code);
    const r = await e.call({ pin: '0000', question: 'q' });
    eq([r.status, r.json.ok], [401, false], 'wrong PIN');
    eq([e.models.length, e.db.rpc().length, e.db.memPosts.length], [0, 0, 0], 'no model call, no quota taken, nothing stored');
  }],

  ['cron path unchanged: the secret alone (no PIN, no Origin) is let in as the owner, stored as scheduled, never counted', async (code) => {
    const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: '1' } });
    for (let i = 0; i < 2; i++) {
      const r = await e.call({ question: 'brief', context: {} }, { origin: null, headers: { 'x-cron-secret': CRON_SECRET } });
      eq([r.status, r.json.ok], [200, true], 'cron question ' + (i + 1));
    }
    eq(e.db.memPosts.map((m) => [m.user_id, m.origin]), [[USER_ID, 'scheduled'], [USER_ID, 'scheduled']], 'stored as the owner, scheduled');
    eq(e.db.rpc().length, 0, 'cron never takes from the open quota');
    const bad = await e.call({ question: 'brief' }, { origin: null, headers: { 'x-cron-secret': 'wrong' } });
    eq(bad.status, 403, 'a wrong secret with no PIN is just an open request with no Origin: refused');
  }],

  ['OPEN question from the site: 200 {open:true}; counted once against the PACIFIC day; no saved conversation read or written; the model is told it is a visitor, shown no accounts, and not verified', async (code) => {
    const e = boot(code);
    const r = await e.open({ verify: true, context: { accounts: [{ label: 'FORGED', positions: [{ sym: 'ZZZ', dayPct: 9 }] }], market: [{ name: 'S&P' }] } });
    eq([r.status, r.json.ok, r.json.answer, r.json.open, r.json.memoryStored], [200, true, 'the answer', true, false], 'answered, marked open, nothing stored');
    eq(e.db.rpc().map((c) => c.body), [{ p_day: '2026-10-04', p_cap: 25 }], 'one atomic take, for the Pacific day, at the default cap of 25');
    eq(e.db.touched('desk_users').length, 0, 'no PIN lookup');
    eq(e.db.touched('desk_chat_memory').length, 0, 'the saved conversation is neither read nor written');
    eq(e.models.length, 1, 'ONE model call: verify is ignored for an open question');
    eq(e.db.touched('desk_system_prompt').length, 0, 'the owner\'s PIN-gated stored prompt is never even read');
    assert(!e.systemOf().includes(OWNER_PROMPT), 'so it cannot reach the model (a visitor can coax a model into repeating its prompt)');
    assert(e.systemOf().includes(PUBLIC_MARK), 'a visitor is answered under the PUBLIC default, which is in this repo');
    assert(/OPEN SESSION[^]*anonymous visitor[^]*NOT the owner/.test(e.systemOf()), 'and the open-session note follows it');
    assert(e.systemOf().indexOf('OPEN SESSION') > e.systemOf().indexOf('PANE NUMBERING'), 'LAST, after the pane note, so it supersedes');
    assert(!/FORGED|ZZZ/.test(e.userTextOf()), 'a forged accounts block never reaches the model');
    assert(/S&P|S\\u0026P/.test(e.userTextOf()), 'but the public market snapshot still does');
    assert(!/earlier Q/.test(e.userTextOf()), 'and the owner conversation is not replayed');
  }],

  ['an open question needs the site Origin: missing, null, another site and a look-alike are refused (403) before any quota is taken or model called', async (code) => {
    const e = boot(code);
    for (const origin of [null, 'null', 'https://evil.test', SITE + '.evil.test', SITE + '/', 'http://akyachtsman.github.io', 'https://AKYACHTSMAN.github.io']) {
      const r = await e.open({}, { origin });
      eq([r.status, r.json.ok], [403, false], `Origin ${JSON.stringify(origin)}`);
    }
    eq([e.db.rpc().length, e.models.length], [0, 0], 'nothing taken, nothing asked');
    eq((await e.open()).status, 200, 'the site itself is let in');
  }],

  ['the daily cap: question N+1 is a 429 with NO model call, a PIN question still passes, and the next Pacific day starts fresh', async (code) => {
    const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: '3' } });
    eq((await Promise.all([1, 2, 3].map(() => e.open()))).map((r) => r.status), [200, 200, 200], 'three open questions');
    const over = await e.open();
    eq([over.status, over.json.ok], [429, false], 'the fourth');
    assert(/used up/i.test(over.json.error) && /PIN/.test(over.json.error), 'and it says why and what to do');
    eq(e.models.length, 3, 'the refused one cost nothing');
    eq((await e.pin()).status, 200, 'the owner is not locked out by an exhausted open quota');
    e.clock.now = Date.parse('2026-10-04T06:59:00Z');   // Sat Oct 3, 23:59 Pacific
    eq([e.db.quota.has('2026-10-03'), (await e.open()).status], [false, 200], '23:59 Pacific is still Oct 3 — a fresh day key (UTC says Oct 4, which is already full)');
    assert(e.db.quota.has('2026-10-03'), 'counted under Oct 3 (Pacific), not Oct 4 (UTC)');
    e.clock.now = Date.parse('2026-10-05T07:00:00Z');   // Mon Oct 5, 00:00 Pacific
    eq((await e.open()).status, 200, 'after Pacific midnight the day key changes and a question is let in');
    eq([...e.db.quota.keys()].sort(), ['2026-10-03', '2026-10-04', '2026-10-05'], 'one counter per Pacific day');
  }],

  ['a BURST of 40 parallel open questions against a cap of 5 answers exactly 5: the cap is the atomic RPC, not a read-then-write in the function', async (code) => {
    const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: '5' } });
    const rs = await Promise.all(Array.from({ length: 40 }, () => e.open()));
    eq([rs.filter((r) => r.status === 200).length, rs.filter((r) => r.status === 429).length], [5, 35], '5 answered, 35 refused');
    eq(e.models.length, 5, 'five model calls, not forty');
    eq(e.db.log.filter((c) => c.path === '/rest/v1/desk_open_ask_quota').length, 0, 'the function never reads or writes the counter table itself');
    eq(e.db.rpc().length, 40, 'it asks the RPC once per request and believes the answer');
  }],

  ['the cap is the owner\'s dial and OFF switch: UNSET = 25, a whole number >= 1 = that, 0, blank or junk = the open path is off (the pre-2026-10-04 400, nothing taken)', async (code) => {
    eq((await (async () => { const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: undefined } }); await e.open(); return e.db.rpc()[0].body.p_cap; })()), 25, 'unset secret: the default');
    eq((await (async () => { const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: '7' } }); await e.open(); return e.db.rpc()[0].body.p_cap; })()), 7, 'a set secret is the cap');
    for (const off of ['0', 'abc', '-3', '2.5', '', ' ', 'NaN', '1e999']) {
      const e = boot(code, { env: { OPEN_ASK_DAILY_CAP: off } });
      const r = await e.open();
      eq([r.status, r.json.error, e.db.rpc().length, e.models.length], [400, 'pin and question are required', 0, 0], `OPEN_ASK_DAILY_CAP=${JSON.stringify(off)} switches the open path off`);
      eq((await e.pin()).status, 200, `...and the PIN still works (${JSON.stringify(off)})`);
    }
  }],

  ['the counter fails CLOSED: an erroring RPC is a 503, an unreachable one a 5xx, a non-true answer a 429 — never an answer', async (code) => {
    const cases = [
      ['HTTP 500', () => new Response('{"message":"boom"}', { status: 500 }), 503],
      ['HTTP 401 (gateway refusal)', () => new Response('{"message":"nope"}', { status: 401 }), 503],
      ['null body', () => new Response('null', { status: 200 }), 429],
      ['false', () => new Response('false', { status: 200 }), 429],
      ['an object', () => new Response('{"ok":true}', { status: 200 }), 429],
      ['the string "true"', () => new Response('"true"', { status: 200 }), 429],
      ['a network error', () => { throw new TypeError('connection reset'); }, 502],
    ];
    for (const [name, take, status] of cases) {
      const e = boot(code);
      e.db.take = take;
      const r = await e.open();
      eq([r.status, r.json.ok, e.models.length], [status, false, 0], `counter says ${name}`);
    }
  }],

  ['an empty question is a 400 BEFORE the counter is touched', async (code) => {
    const e = boot(code);
    for (const q of ['', '   ', null, undefined]) {
      const r = await e.call({ question: q });
      eq([r.status, r.json.error], [400, 'question is required'], `question ${JSON.stringify(q)}`);
    }
    eq(e.db.rpc().length, 0, 'no quota spent on nothing');
  }],

  ['PIN questions may arm verify (two model calls); an open one may not (one) — and the cron/PIN prompt never carries the open note', async (code) => {
    const e = boot(code);
    await e.pin({ verify: true });
    eq(e.models.length, 2, 'a PIN question with verify: the answer and its grounding pass');
    assert(!/OPEN SESSION/.test(e.systemOf(0)), 'no open note on the owner path');
  }],

  ['the owner\'s ASK_VERIFY=1 secret forces the grounding pass for the PIN path only — never for a visitor (Codex, PR #305)', async (code) => {
    const e = boot(code, { env: { ASK_VERIFY: '1' } });
    await e.pin();
    eq(e.models.length, 2, 'ASK_VERIFY=1: every PIN question is verified (the owner asked for that)');
    const v = boot(code, { env: { ASK_VERIFY: '1' } });
    const r = await v.open();
    eq([r.status, v.models.length], [200, 1], 'ASK_VERIFY=1: an open question still costs ONE model call');
    const w = boot(code, { env: { ASK_VERIFY: '1' } });
    await w.open({ verify: true });
    eq(w.models.length, 1, '...and arming verify on it changes nothing');
  }],

  // ── the model tier (desk_021) ────────────────────────────────────────────────────────────────
  ['each stored tier reaches the provider on BOTH the answer call and the grounding call, and the owner\'s reply names the model the PROVIDER reported and that the row chose it', async (code) => {
    for (const id of ALL_TIERS) {
      const e = boot(code, withTier({ mode: 'ok', model: id }, { model: modelAs(id + '-20261001') }));
      const r = await e.pin({ verify: true });
      eq(r.status, 200, `${id}: answered`);
      eq(e.models.map((m) => m.model), [id, id], `${id}: the answer and its grounding pass ask for the stored model`);
      eq([r.json.model, r.json.tierSource], [id + '-20261001', 'row'], `${id}: the reply names what answered (the provider's dated id) and the row as the reason`);
    }
  }],

  ['the stored row WINS over the ASK_MODEL secret, and a disagreement is logged (not obeyed)', async (code) => {
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-opus-5-5' }, { env: { ASK_MODEL: 'claude-haiku-5-5' } }));
    const r = await e.pin();
    eq([e.models[0].model, r.json.tierSource], ['claude-opus-5-5', 'row'], 'the row answers, not the secret');
    assert(e.warns.some((w) => /ASK_MODEL .* ignored: the stored tier .* wins/.test(w)), 'the ignored secret is logged: ' + JSON.stringify(e.warns));
    const same = boot(code, withTier({ mode: 'ok', model: 'claude-opus-5-5' }, { env: { ASK_MODEL: 'claude-opus-5-5' } }));
    await same.pin();
    assert(!same.warns.some((w) => /ignored/.test(w)), 'a secret that AGREES with the row says nothing');
  }],

  ['with no usable row the ASK_MODEL secret is the break-glass: unreadable (5xx, network, garbage), absent, a null model or a value outside the list each still answer, on the secret, and say so', async (code) => {
    const modes = [
      [{ mode: 'http500', model: null }, /unreadable \(HTTP 500\)/],
      [{ mode: 'throw', model: null }, /unreadable/],
      [{ mode: 'badjson', model: null }, /unreadable/],
      [{ mode: 'notarray', model: null }, /unreadable/],
      [{ mode: 'empty', model: null }, /absent/],
      [{ mode: 'nullmodel', model: null }, /absent/],
      [{ mode: 'ok', model: 'gpt-4' }, /not an allowed model/],
      [{ mode: 'ok', model: '' }, /not an allowed model/],
    ];
    for (const [tier, why] of modes) {
      const e = boot(code, withTier(tier, { env: { ASK_MODEL: 'claude-sonnet-5-5' } }));
      const r = await e.pin();
      eq([r.status, r.json.ok, e.models[0].model, r.json.tierSource], [200, true, 'claude-sonnet-5-5', 'override'], `${tier.mode}/${tier.model}: answered on the secret`);
      assert(e.warns.some((w) => why.test(w)), `${tier.mode}/${tier.model}: logged (${why}): ` + JSON.stringify(e.warns));
    }
  }],

  ['the secret may name ANY well-formed model id (a retired id on the list can be routed around without a deploy) and is logged when outside the three; a malformed one is ignored', async (code) => {
    const e = boot(code, withTier({ mode: 'empty', model: null }, { env: { ASK_MODEL: 'claude-opus-6' } }));
    const r = await e.pin();
    eq([e.models[0].model, r.json.tierSource], ['claude-opus-6', 'override'], 'a well-formed id outside the three is used');
    assert(e.warns.some((w) => /outside the offered models/.test(w)), 'and logged');
    for (const bad of ['gpt-4', 'claude-x; drop table', 'Claude-Opus', 'claude opus', 'claude-']) {
      const b = boot(code, withTier({ mode: 'empty', model: null }, { env: { ASK_MODEL: bad } }));
      const rb = await b.pin();
      eq([rb.status, b.models[0].model, rb.json.tierSource], [200, 'claude-haiku-5-5', 'default'], `"${bad}" is ignored: answered on the fallback`);
      assert(b.warns.some((w) => /not a model id/.test(w)), `"${bad}": logged`);
    }
  }],

  ['with nothing usable anywhere the desk still answers, on the named fallback (Haiku 5.5), and says it was the default', async (code) => {
    for (const tier of [{ mode: 'http500', model: null }, { mode: 'throw', model: null }, { mode: 'empty', model: null }]) {
      const e = boot(code, withTier(tier));
      const r = await e.pin();
      eq([r.status, r.json.ok, e.models[0].model, r.json.tierSource], [200, true, 'claude-haiku-5-5', 'default'], `${tier.mode}: the fallback`);
    }
  }],

  ['NOTHING is cached: one warm isolate follows the row at once, and a read that starts failing is not papered over with the last good value', async (code) => {
    const e = boot(code);
    e.db.tier = { mode: 'ok', model: 'claude-opus-5-5' };
    await e.pin();
    e.db.tier = { mode: 'ok', model: 'claude-haiku-5-5' };
    await e.pin();
    e.db.tier = { mode: 'ok', model: 'claude-sonnet-5-5' };
    await e.open();
    e.db.tier = { mode: 'http500', model: null };
    await e.pin();
    eq(e.models.map((m) => m.model), ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
      'each question asks the row as it stands THEN (and the failed read falls back; it does not reuse the stale opus)');
  }],

  ['exactly ONE tier read per question, whichever door let it in — and none for a question refused at the door', async (code) => {
    const reads = (e) => e.db.touched('desk_ask_model').length;
    const a = boot(code); await a.pin({ verify: true });
    eq(reads(a), 1, 'a PIN question with a grounding pass: one read (the same model for both calls)');
    const b = boot(code); await b.open();
    eq(reads(b), 1, 'an open question: one read');
    const c = boot(code); await c.call({ question: 'brief', context: {} }, { origin: null, headers: { 'x-cron-secret': CRON_SECRET } });
    eq(reads(c), 1, 'a scheduled question: one read');
    const d = boot(code); const rd = await d.open({}, { origin: 'https://evil.example' });
    eq([rd.status, reads(d)], [403, 0], 'an open question refused for its Origin reads nothing');
    const f = boot(code); const rf = await f.call({ pin: '0000', question: 'q' });
    eq([rf.status, reads(f)], [401, 0], 'a wrong PIN reads nothing');
    // every other way an open question is turned away after the Origin gate: the cap spent (429), the counter failing (503), the open path off (400)
    const g = boot(code, { env: { OPEN_ASK_DAILY_CAP: '1' } }); await g.open(); const rg = await g.open();
    eq([rg.status, reads(g)], [429, 1], 'the question the cap turns away reads nothing (only the first one read)');
    const h = boot(code); h.db.take = () => new Response('boom', { status: 500 }); const rh = await h.open();
    eq([rh.status, reads(h)], [503, 0], 'a failing counter reads nothing');
    const i = boot(code, { env: { OPEN_ASK_DAILY_CAP: '0' } }); const ri = await i.open();
    eq([ri.status, reads(i)], [400, 0], 'the open path switched off reads nothing');
  }],

  ['one QUESTION keeps one MODEL across its turns: a switch moved while it runs changes the NEXT question, never this one (the answer, its forced-search retry and the reply all agree)', async (code) => {
    // the first provider reply has no web search behind it, so the loop sends a second turn; the owner flips the switch in between
    const noSearch = () => new Response(JSON.stringify({ stop_reason: 'end_turn', model: 'claude-opus-5-5-20261001', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'a draft with no source' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    let env = null;
    env = boot(code, { model: (n) => { if (n === 1) env.db.tier = { mode: 'ok', model: 'claude-haiku-5-5' }; return n === 1 ? noSearch() : modelAs('claude-opus-5-5-20261001')(); } });
    env.db.tier = { mode: 'ok', model: 'claude-opus-5-5' };
    const r = await env.pin();
    eq([r.status, r.json.ok, env.models.length], [200, true, 2], 'the forced-search retry made a second provider call');
    eq(env.models.map((m) => m.model), ['claude-opus-5-5', 'claude-opus-5-5'], 'both turns of the question ran on the model read at its start');
    eq([r.json.tierSource, env.db.touched('desk_ask_model').length], ['row', 1], 'the row was read once for the whole question');
    await env.pin();   // the NEXT question follows the switch that was moved meanwhile
    eq(env.models.slice(2).map((m) => m.model), ['claude-haiku-5-5'], 'the next question runs on the new model');
  }],

  ['visitors follow the switch (owner ruling C2) but are told nothing about it: no `model`, no `tierSource`', async (code) => {
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-haiku-5-5' }));
    const r = await e.open();
    eq([r.status, r.json.ok, r.json.open, e.models[0].model], [200, true, true, 'claude-haiku-5-5'], 'the open question is answered by the stored tier');
    assert(!('model' in r.json) && !('tierSource' in r.json), 'the visitor reply carries no model name: ' + Object.keys(r.json).join(','));
  }],

  ['only the ADMIN is told which model answered: the owner\'s PIN and the cron secret are; the TEST credential, a visitor and a desk_users read that leaves is_test out are answered but told nothing (fail closed)', async (code) => {
    const owner = boot(code); const ro = await owner.pin();
    assert('model' in ro.json && ro.json.tierSource === 'row', 'the owner is told');
    const cron = boot(code); const rc = await cron.call({ question: 'brief', context: {} }, { origin: null, headers: { 'x-cron-secret': CRON_SECRET } });
    assert('model' in rc.json && rc.json.tierSource === 'row', 'the cron path is told (it is the owner\'s own door)');
    const test = boot(code); const rt = await test.call({ pin: TEST_PIN, question: 'how is NVDA?', context: { market: [] } });
    eq([rt.status, rt.json.ok, test.models.length, test.db.memPosts.map((m) => m.user_id)], [200, true, 1, [TEST_USER_ID]], 'the test credential is a real PIN: answered, and saved as itself');
    assert(!('model' in rt.json) && !('tierSource' in rt.json), 'but it is not told the model: ' + Object.keys(rt.json).join(','));
    const omit = boot(code); omit.db.omitIsTest = true; const rm = await omit.pin();
    eq([rm.status, rm.json.ok], [200, true], 'a users read without is_test still answers');
    assert(!('model' in rm.json) && !('tierSource' in rm.json), 'and the owner is NOT treated as admin on a missing field: ' + Object.keys(rm.json).join(','));
  }],

  ['the admin is shown the tier on a provider failure too (so a refused model is diagnosable); the test credential is not', async (code) => {
    const fail = () => new Response(JSON.stringify({ error: { message: 'tools not supported on this model' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-haiku-5-5' }, { model: fail }));
    const r = await e.pin();
    eq([r.status, r.json.ok, r.json.model, r.json.tierSource], [502, false, 'claude-haiku-5-5', 'row'], 'the owner sees which tier was asked for');
    assert(/HTTP 400.*tools not supported/.test(r.json.error), 'and the provider\'s own words: ' + r.json.error);
    const t = boot(code, withTier({ mode: 'ok', model: 'claude-haiku-5-5' }, { model: fail }));
    const rt = await t.call({ pin: TEST_PIN, question: 'q', context: {} });
    assert(rt.status === 502 && !('model' in rt.json) && !('tierSource' in rt.json), 'the test credential is told only the error: ' + JSON.stringify(rt.json));
  }],

  ['the saved conversation row keeps the model the PROVIDER reported (typed and scheduled), unchanged by the switch', async (code) => {
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-opus-5-5' }, { model: modelAs('claude-opus-5-5-20261001') }));
    await e.pin();
    await e.call({ question: 'brief', context: {} }, { origin: null, headers: { 'x-cron-secret': CRON_SECRET } });
    eq(e.db.memPosts.map((m) => [m.origin, m.model]), [['typed', 'claude-opus-5-5-20261001'], ['scheduled', 'claude-opus-5-5-20261001']], 'the stored model name');
  }],

  ['the tier read is bounded by a timeout and asks for the model column of the ONE row; a secret with stray spaces is trimmed, not ignored', async (code) => {
    const e = boot(code, withTier({ mode: 'empty', model: null }, { env: { ASK_MODEL: '  claude-sonnet-5-5  ' } }));
    const r = await e.pin();
    const read = e.db.touched('desk_ask_model')[0];
    assert(read.signal === true, 'the tier read carries an abort signal (a hung read must not hold a question)');
    assert(/select=model(&|$)/.test(read.search) && /id=eq\.true/.test(read.search), 'it asks for the model column of the row whose id is true: ' + read.search);
    eq([e.models[0].model, r.json.tierSource], ['claude-sonnet-5-5', 'override'], 'the padded secret is used, trimmed');
  }],

  ['a refusal by the provider carries the proof to the admin only', async (code) => {
    const refuse = () => new Response(JSON.stringify({ stop_reason: 'refusal', model: 'claude-opus-5-5-20261001', usage: { input_tokens: 1, output_tokens: 1 }, content: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-opus-5-5' }, { model: refuse }));
    const r = await e.pin();
    eq([r.status, r.json.ok, r.json.model, r.json.tierSource], [200, false, 'claude-opus-5-5-20261001', 'row'], 'the owner is told which model declined');
    for (const [who, call] of [['the test credential', (x) => x.call({ pin: TEST_PIN, question: 'q', context: {} })], ['a visitor', (x) => x.open()]]) {
      const x = boot(code, withTier({ mode: 'ok', model: 'claude-opus-5-5' }, { model: refuse }));
      const rx = await call(x);
      assert(rx.json.ok === false && !('model' in rx.json) && !('tierSource' in rx.json), `${who} is told only that it declined: ${JSON.stringify(rx.json)}`);
    }
  }],

  ['the provider\'s own words go to the OWNER only: a visitor and the test credential get the status and nothing about the model or the account', async (code) => {
    const words = 'model claude-haiku-5-5 does not support web_search; your credit balance is too low';
    const fail = () => new Response(JSON.stringify({ error: { message: words } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const e = boot(code, withTier({ mode: 'ok', model: 'claude-haiku-5-5' }, { model: fail }));
    const r = await e.pin();
    assert(r.json.error.includes('does not support web_search'), 'the owner reads the provider\'s words: ' + r.json.error);
    for (const [who, call] of [['the test credential', (x) => x.call({ pin: TEST_PIN, question: 'q', context: {} })], ['a visitor', (x) => x.open()]]) {
      const x = boot(code, withTier({ mode: 'ok', model: 'claude-haiku-5-5' }, { model: fail }));
      const rx = await call(x);
      eq([rx.status, rx.json.error], [502, 'model call failed (HTTP 400)'], `${who} gets the status alone`);
      assert(!/haiku|credit|balance|support/i.test(JSON.stringify(rx.json)), `${who} learns nothing about the model or the account: ${JSON.stringify(rx.json)}`);
    }
  }],

  // ── the words of a reply (owner 2026-10-14: a CPI answer broke mid-sentence around "Reuters in / coverage on coinpaper / .") ──
  ['an answer that cites the web arrives in fragments and reads as ONE passage: contiguous text blocks are joined with nothing (each keeps its own spaces), a tool block between two texts is a blank line, a thinking block is neither — stored and returned the same', async (code) => {
    const text = (t) => ({ type: 'text', text: t });
    const cited = (t) => ({ type: 'text', text: t, citations: [{ type: 'web_search_result_location', url: 'https://example.test/a', title: 'A' }] });
    const fragments = () => new Response(JSON.stringify({
      stop_reason: 'end_turn', model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        text('Let me check the report. '),
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'CPI' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://example.test/a', title: 'A' }] },
        text('The September CPI report is out today, and it came in hotter than expected. '),
        cited('The consumer price index showed annual inflation of 3.7% in September, according to the Bureau of Labor Statistics.'),
        text(' Economists had expected 3.6%.'),
        { type: 'thinking', thinking: 'a thought between two fragments', signature: 'sig' },
        cited(' Core CPI rose 0.3% on the month.\n\nAfter the release, Fed rate hike odds rose to about 45%, according to futures data cited by Reuters in '),
        cited('coverage on coinpaper'),
        text('.'),
        { type: 'server_tool_use', id: 'srv_2', name: 'web_search', input: { query: 'again' } },
        text('   '),   // a passage of nothing but spaces after a tool call: it is no paragraph
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const WANT = 'Let me check the report.\n\n' +
      'The September CPI report is out today, and it came in hotter than expected. The consumer price index showed annual inflation of 3.7% in September, according to the Bureau of Labor Statistics. Economists had expected 3.6%. Core CPI rose 0.3% on the month.\n\n' +
      'After the release, Fed rate hike odds rose to about 45%, according to futures data cited by Reuters in coverage on coinpaper.';
    const e = boot(code, { model: fragments });
    const r = await e.pin();
    eq([r.status, r.json.ok], [200, true], 'the question is answered');
    eq(r.json.answer, WANT, 'the returned answer reads as the model wrote it: no newline inside a sentence, a blank line only where a tool call sat between two texts');
    eq(e.db.memPosts.map((m) => m.answer), [WANT], 'and the saved conversation holds the same words (what a reload replays)');
    const v = boot(code, { model: fragments }); const rv = await v.open();
    eq(rv.json.answer, WANT, 'a visitor\'s answer is built the same way');
  }],

  ['a plain one-block answer is returned as written (an inner blank line kept, the ends trimmed) and a reply with no text at all is still the "empty model response" error', async (code) => {
    const one = (t) => () => new Response(JSON.stringify({
      stop_reason: 'end_turn', model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.test/a', title: 'A' }] }, { type: 'text', text: t }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const e = boot(code, { model: one('\n  First paragraph.\n\nSecond paragraph.  \n') });
    eq((await e.pin()).json.answer, 'First paragraph.\n\nSecond paragraph.', 'one block: trimmed at the ends, untouched inside');
    const blank = boot(code, { model: one('   \n ') });
    const rb = await blank.pin();
    eq([rb.status, rb.json.ok, rb.json.error], [502, false, 'empty model response'], 'whitespace alone is no answer');
  }],
];

async function runSuite(code, { verbose = false } = {}) {
  const failures = [];
  for (const [name, fn] of TESTS) {
    try { await fn(code); if (verbose) console.log('  ok        ' + name.slice(0, 150)); }
    catch (e) {
      failures.push({ name, error: e });
      if (verbose) console.log(`  FAIL      ${name.slice(0, 150)}\n            ${e instanceof Fail ? e.message : e.stack}`);
    }
  }
  return failures;
}

// Single-line damage to the function, each of which a check above must notice.
const MUTANTS = [
  ['the Origin gate removed', "if (req.headers.get('origin') !== SITE_ORIGIN) {", 'if (false) {'],
  ['the Origin gate a prefix match (a look-alike host passes)', "if (req.headers.get('origin') !== SITE_ORIGIN) {", "if (!(req.headers.get('origin') || '').startsWith(SITE_ORIGIN)) {"],
  ['the cap never consulted (every open question passes)', 'if ((await takeRes.json()) !== true) {', 'if (false) {'],
  ['the counter fails OPEN on a non-true answer (null passes)', 'if ((await takeRes.json()) !== true) {', 'if ((await takeRes.json()) === false) {'],
  ['an erroring counter is answered anyway', 'if (!takeRes.ok) return reply(503,', 'if (false) return reply(503,'],
  ['the cap secret ignored', 'const cap = openAskCap();', 'const cap = OPEN_ASK_DEFAULT_CAP;'],
  ['a cap of 0 does not switch the open path off', 'if (cap < 1) return reply(400,', 'if (cap < 0) return reply(400,'],
  ['junk in the cap secret does not switch it off (read as the default)', 'return Number.isInteger(n) && n >= 1 ? Math.min(n, 100_000) : 0;', 'return Number.isInteger(n) && n >= 1 ? Math.min(n, 100_000) : OPEN_ASK_DEFAULT_CAP;'],
  ['a BLANK cap secret reads as unset (the open path opens by accident)', "if (raw === undefined) return OPEN_ASK_DEFAULT_CAP;", "if (raw === undefined || raw.trim() === '') return OPEN_ASK_DEFAULT_CAP;"],
  ['the day key is UTC, not Pacific', 'PT_DAY.format(new Date())', 'new Date().toISOString().slice(0, 10)'],
  ['PIN and cron questions are counted against the open quota', 'if (anonymous) {\n    const cap = openAskCap();', 'if (true) {\n    const cap = openAskCap();'],
  ['a wrong PIN is let through as an open question', "if (!userId) return reply(401, { ok: false, error: 'PIN not recognized.' });", 'if (!userId) { /* downgraded */ }'],
  ['the owner\'s stored prompt is READ for an open question (a visitor can coax it out)', 'if (!anonymous) try {\n    const spRes', 'try {\n    const spRes'],
  ['the saved conversation is READ for an open question', 'if (userId) try {\n    const since', 'try {\n    const since'],
  ['an open answer is WRITTEN into the owner conversation', 'if (userId) try {\n    const mres', 'try {\n    const mres'],
  ['a forged accounts block reaches the model of an open question', 'if (anonymous) delete ctx.accounts;', ''],
  ['the open-session note dropped', 'if (anonymous) SYSTEM += OPEN_SESSION_NOTE;', ''],
  ['verify honoured for an open question (double the cost)', '!anonymous && (VERIFY_ALWAYS || askedToVerify)', 'VERIFY_ALWAYS || askedToVerify'],
  ['ASK_VERIFY=1 forces the grounding pass on an open question (the first version of the guard; Codex, PR #305)', '!anonymous && (VERIFY_ALWAYS || askedToVerify)', 'VERIFY_ALWAYS || (askedToVerify && !anonymous)'],
  ['the empty-question check dropped (an empty open question spends the quota)', "if (!question) return reply(400, { ok: false, error: 'question is required' });", ''],
  ['open answers not marked open', '...(anonymous ? { open: true } : {}),', ''],
  // ── the model tier (desk_021). `find` / `repl` may be ARRAYS (one entry per edit) for damage that takes two lines. ──
  ['the stored tier is never read (the secret and the fallback decide)', 'const tierRow = await readTierRow(supaUrl, svc);', "const tierRow: TierRead = { ok: false, why: 'mutant' };"],
  ['the ASK_MODEL secret BEATS the stored row (the owner moves the switch and nothing changes)', '  if (stored) {\n    if (ov && ov !== stored) notes.push', '  if (stored && !usable) {\n    if (ov && ov !== stored) notes.push'],
  ['a stored value outside the list is used anyway (the allow-list is skipped)', '  else if (!inList(row.model)) notes.push(`stored tier "${clip(row.model)}" is not an allowed model — not used`);\n', ''],
  ['the break-glass secret may only name one of the three (narrower than before the switch)', "if (!OVERRIDE_SHAPE.test(ov)) notes.push('ASK_MODEL is not a model id — ignored');", "if (!inList(ov)) notes.push('ASK_MODEL is not a model id — ignored');"],
  ['the secret\'s shape is not checked (any string reaches the provider)', "if (!OVERRIDE_SHAPE.test(ov)) notes.push('ASK_MODEL is not a model id — ignored');", "if (false) notes.push('ASK_MODEL is not a model id — ignored');"],
  ['a secret that disagrees with the row is not logged', 'if (ov && ov !== stored) notes.push(`ASK_MODEL "${clip(ov)}" ignored: the stored tier "${stored}" wins`);', ''],
  ['the fallback is a different model than the named constant', "return { model: TIER_FALLBACK, source: 'default', notes };", "return { model: 'claude-opus-5-5', source: 'default', notes };"],
  ['the tier is CACHED in the isolate (a warm instance serves a tier the owner already changed)',
    ['async function readTierRow(supaUrl: string, svc: Record<string, string>): Promise<TierRead> {\n  try {', "return { ok: true, model: typeof m === 'string' ? m : null };"],
    ['async function readTierRow(supaUrl: string, svc: Record<string, string>): Promise<TierRead> {\n  if ((globalThis as Any).__tier) return (globalThis as Any).__tier;\n  try {', "return ((globalThis as Any).__tier = { ok: true, model: typeof m === 'string' ? m : null });"]],
  ['a failed tier read is FATAL (the network)', "    return { ok: false, why: (e as Any)?.name ?? 'error' };", '    throw e;'],
  ['a non-OK tier read is FATAL', 'if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };', "if (!res.ok) throw new Error('tier read failed');"],
  ['the grounding check ignores the tier', '        model,\n        max_tokens: VERIFY_TOKENS,', '        model: TIER_FALLBACK,\n        max_tokens: VERIFY_TOKENS,'],
  ['the answer call ignores the tier', '        model,\n        max_tokens: MAX_ANSWER_TOKENS,', '        model: TIER_FALLBACK,\n        max_tokens: MAX_ANSWER_TOKENS,'],
  ['two tier reads per question', 'const tierRow = await readTierRow(supaUrl, svc);', 'await readTierRow(supaUrl, svc);\n  const tierRow = await readTierRow(supaUrl, svc);'],
  ['the tier is read BEFORE the door (a refused question still reads it)', "if (!question) return reply(400, { ok: false, error: 'question is required' });", "if (!question) return reply(400, { ok: false, error: 'question is required' });\n  await readTierRow(supaUrl, svc);"],
  ['the tier is read BEFORE the cap (a question the cap turns away still reads it)', '    const takeRes = await fetch(`${supaUrl}/rest/v1/rpc/desk_open_ask_take`, {', '    await readTierRow(supaUrl, svc);\n    const takeRes = await fetch(`${supaUrl}/rest/v1/rpc/desk_open_ask_take`, {'],
  ['the model is re-read on EVERY turn of the loop (a switch moved mid-question splits one question across two models)',
    ['const tierRow = await readTierRow(supaUrl, svc);', '        model,\n        max_tokens: MAX_ANSWER_TOKENS,'],
    ["const tierRow: TierRead = { ok: false, why: 'mutant' };", '        model: resolveTier(await readTierRow(supaUrl, svc), Deno.env.get(\'ASK_MODEL\')).model,\n        max_tokens: MAX_ANSWER_TOKENS,']],
  ['the tier read sends a browser-shaped user-agent (the gateway refuses the secret key)', 'desk_ask_model?select=model&id=eq.true`, { headers: svc,', "desk_ask_model?select=model&id=eq.true`, { headers: { ...svc, 'user-agent': 'Mozilla/5.0' },"],
  ['EVERY PIN is admin (the test credential is told the model)', 'isAdmin = u.is_test === false;', 'isAdmin = true;'],
  ['admin is read as `!is_test` (a missing field makes the caller an admin)', 'isAdmin = u.is_test === false;', 'isAdmin = !u.is_test;'],
  ['a visitor is told the model', 'const adminProof = (answered?: string | null) => isAdmin ? {', 'const adminProof = (answered?: string | null) => true ? {'],
  ['the cron path is not admin', "    if (!userId) return reply(500, { ok: false, error: 'no owner row in desk_users' });\n    isAdmin = true;\n", "    if (!userId) return reply(500, { ok: false, error: 'no owner row in desk_users' });\n"],
  ['the admin is not told where the choice came from', ', tierSource: tier.source } : {}', ' } : {}'],
  ['the reply names the model that was ASKED for, not the one the provider reports', '...adminProof(finalMsg?.model), usage, checked,', '...adminProof(), usage, checked,'],
  ['the provider-failure reply carries no tier', '        ...adminProof(),   // which tier was asked for, so a provider refusal of one model is diagnosable\n', ''],
  ['the saved conversation row stores the model that was asked for', 'model: finalMsg?.model ?? model, sources, usage, checked, origin', 'model, sources, usage, checked, origin'],
  ['the users read no longer asks for is_test (the owner is never told which model answered)', 'desk_users?select=id,salt,pin_hash,is_test', 'desk_users?select=id,salt,pin_hash'],
  ['the tier query asks for the wrong column', 'desk_ask_model?select=model&id=eq.true`, { headers: svc, signal', 'desk_ask_model?select=mode&id=eq.true`, { headers: svc, signal'],
  ['the tier query asks for the wrong row', 'desk_ask_model?select=model&id=eq.true`, { headers: svc, signal', 'desk_ask_model?select=model&id=eq.false`, { headers: svc, signal'],
  ['the tier read has no timeout', 'desk_ask_model?select=model&id=eq.true`, { headers: svc, signal: AbortSignal.timeout(REST_TIMEOUT_MS) }', 'desk_ask_model?select=model&id=eq.true`, { headers: svc }'],
  ['a padded ASK_MODEL secret is not trimmed', "const ov = (override ?? '').trim();", "const ov = (override ?? '');"],
  ['a refusal carries no proof to the admin', "error: 'The model declined this question.', ...adminProof(msg.model) }", "error: 'The model declined this question.' }"],
  ['a visitor is shown the provider\'s own words (the model, the account\'s billing state)', "${isAdmin && msg ? ' — ' + msg.slice(0, 300) : ''}", "${msg ? ' — ' + msg.slice(0, 300) : ''}"],
  ['contiguous text blocks are joined with a newline again (a sentence breaks at every citation)', "if (b?.type === 'text') open = (open ?? '') + (typeof b.text === 'string' ? b.text : '');", "if (b?.type === 'text') open = (open === null ? '' : open + '\\n') + (typeof b.text === 'string' ? b.text : '');"],
  ['a tool block between two texts no longer separates them (the narration runs into the answer)', "else if (b?.type !== 'thinking' && b?.type !== 'redacted_thinking' && open !== null) { passages.push(open); open = null; }", "else if (false) { passages.push(open); open = null; }"],
  ['a thinking block splits a passage in two', "else if (b?.type !== 'thinking' && b?.type !== 'redacted_thinking' && open !== null) { passages.push(open); open = null; }", "else if (open !== null) { passages.push(open); open = null; }"],
  ['the passages are joined with a single newline, not a blank line', "return passages.map((p) => p.trim()).filter(Boolean).join('\\n\\n');", "return passages.map((p) => p.trim()).filter(Boolean).join('\\n');"],
  ['the passages are not trimmed (a stray space at every seam)', "return passages.map((p) => p.trim()).filter(Boolean).join('\\n\\n');", "return passages.filter(Boolean).join('\\n\\n');"],
  ['a whitespace-only passage is kept (a blank line left in the answer)', "return passages.map((p) => p.trim()).filter(Boolean).join('\\n\\n');", "return passages.map((p) => p.trim()).join('\\n\\n');"],
  ['a trailing text run is dropped (the last fragment of the answer is lost)', "if (open !== null) passages.push(open);\n", "void 0;\n"],
];

// The esbuild pinned (exact version + integrity hash) in tools/package.json and its lockfile.
const ESBUILD = path.join(ROOT, 'tools/node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
function transpile(ts) {
  const r = spawnSync(ESBUILD, ['--loader=ts', '--format=cjs', '--log-level=error'], { input: ts, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error && r.error.code === 'ENOENT') throw new Error('the pinned esbuild is not installed — run: npm ci --prefix tools');
  if (r.status !== 0) throw new Error('esbuild failed: ' + (r.stderr || r.error || 'unknown'));
  return r.stdout;
}

const src = readFileSync(SRC, 'utf8');
console.log('desk-ask gate checks — suite against the committed source');
const failures = await runSuite(transpile(src), { verbose: true });
console.log(`\n${TESTS.length - failures.length}/${TESTS.length} checks passed`);
let exit = failures.length ? 1 : 0;

if (process.argv.includes('--mutants')) {
  console.log(`\nmutants (${MUTANTS.length}) — each must be CAUGHT by at least one check`);
  let killed = 0;
  for (const [name, find, repl] of MUTANTS) {
    const edits = Array.isArray(find) ? find.map((f, i) => [f, repl[i]]) : [[find, repl]];
    const bad = edits.find(([f]) => src.split(f).length - 1 !== 1);
    if (bad) { console.log(`  INVALID   ${name} (anchor found ${src.split(bad[0]).length - 1}x)`); exit = 1; continue; }
    let mutated;
    try { mutated = transpile(edits.reduce((t, [f, r]) => t.replace(f, () => r), src)); }
    catch { console.log(`  INVALID   ${name} (the mutant does not transpile)`); exit = 1; continue; }
    const f = await runSuite(mutated);
    if (f.length) { killed++; console.log(`  caught    ${name}  <- ${f[0].name.slice(0, 110)}`); }
    else { console.log(`  SURVIVED  ${name}`); exit = 1; }
  }
  console.log(`\nmutants caught: ${killed}/${MUTANTS.length}`);
}
process.exit(exit);
