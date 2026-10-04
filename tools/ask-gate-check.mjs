#!/usr/bin/env node
/* Re-runnable checks for the three ways into supabase/functions/desk-ask — above all the
   OPEN one (no PIN, owner ruling 2026-10-04) and the daily cap that bounds its cost.

     node tools/ask-gate-check.mjs             # the suite, against the function as committed
     node tools/ask-gate-check.mjs --mutants   # ...then prove each single-line mutant below is CAUGHT

   How: the same harness shape as tools/econ-check.mjs. The function is transpiled with the
   PINNED esbuild in tools/package.json (`npm ci --prefix tools` once; there is no Deno here)
   and run in a fresh `vm` context per check, which is a cold isolate: `Deno.serve` is captured,
   `fetch` is a stub that plays PostgREST (desk_users, desk_system_prompt, desk_chat_memory and
   the desk_open_ask_take RPC, whose atomic counter is a Map) and the Anthropic API, and `Date`
   runs on a settable clock so the Pacific day rolls where the check says it does. Nothing
   touches the network, the live Supabase project or an Anthropic key.

   What it proves and what it cannot: it proves what the FUNCTION does with each request — which
   door admitted it, what was read and written, what the model was shown, how many model calls
   it cost. It cannot prove the SQL in supabase/migrations/desk_020 (that is checked against the
   live database when the migration is applied, with a scratch day key) — here the RPC is a
   stand-in that returns what the SQL would. */
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
const SALT = 'salty';
const USER_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_PROMPT = 'OWNER-PROMPT: you are talking to the owner about their own accounts.';
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
  };
  db.rpc = () => db.log.filter((c) => c.path === '/rest/v1/rpc/desk_open_ask_take');
  db.touched = (table) => db.log.filter((c) => c.path === `/rest/v1/${table}`);
  db.handle = async (u, init) => {
    const h = new Headers(init.headers);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    db.log.push({ method, path: u.pathname, search: u.search, body });
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
      if (u.searchParams.get('select') === 'id') return json([{ id: USER_ID }]);
      return json([{ id: USER_ID, salt: SALT, pin_hash: sha(SALT + PIN) }]);
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
    assert(e.systemOf().startsWith(OWNER_PROMPT), 'the owner-edited prompt still leads (the doctrine is the product)');
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
  ['the saved conversation is READ for an open question', 'if (userId) try {\n    const since', 'try {\n    const since'],
  ['an open answer is WRITTEN into the owner conversation', 'if (userId) try {\n    const mres', 'try {\n    const mres'],
  ['a forged accounts block reaches the model of an open question', 'if (anonymous) delete ctx.accounts;', ''],
  ['the open-session note dropped', 'if (anonymous) SYSTEM += OPEN_SESSION_NOTE;', ''],
  ['verify honoured for an open question (double the cost)', '(askedToVerify && !anonymous)', 'askedToVerify'],
  ['the empty-question check dropped (an empty open question spends the quota)', "if (!question) return reply(400, { ok: false, error: 'question is required' });", ''],
  ['open answers not marked open', '...(anonymous ? { open: true } : {}),', ''],
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
    const n = src.split(find).length - 1;
    if (n !== 1) { console.log(`  INVALID   ${name} (anchor found ${n}x)`); exit = 1; continue; }
    let mutated;
    try { mutated = transpile(src.replace(find, () => repl)); }
    catch { console.log(`  INVALID   ${name} (the mutant does not transpile)`); exit = 1; continue; }
    const f = await runSuite(mutated);
    if (f.length) { killed++; console.log(`  caught    ${name}  <- ${f[0].name.slice(0, 110)}`); }
    else { console.log(`  SURVIVED  ${name}`); exit = 1; }
  }
  console.log(`\nmutants caught: ${killed}/${MUTANTS.length}`);
}
process.exit(exit);
