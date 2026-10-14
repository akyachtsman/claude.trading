#!/usr/bin/env node
/* The Ask-the-desk model list lives in THREE files, and it must be the same list in all of them:

     supabase/migrations/desk_021_ask_model_tier.sql   the CHECK on desk_ask_model.model (and the column default)
     supabase/functions/desk-ask/index.ts              TIER_IDS (the server's allow-list) and TIER_FALLBACK
     scripts/data.js                                   ASK_MODELS (what the Ask panel offers)

   Same ids, in the SAME ORDER (cheapest first; the order is part of the contract), and the fallback
   is a member of the list and equals the SQL column default. A list that drifts is a model the
   panel offers and the server refuses (or the reverse) — the failure this file exists to catch.

     node tools/ask-model-parity.mjs              # the repo as committed; exit 1 on any drift
     node tools/ask-model-parity.mjs --selftest   # the checker against synthetic files, good and drifted

   How each declaration is read — the traps this was written around:
   * Comments are blanked FIRST, by a string-aware scanner (a naive `//.*` strip would eat the rest
     of a line after `https://`), so a model id written in a comment can never be counted…
   * …and then each parse is SCOPED to the one statement that owns it (the CREATE TABLE, the
     `const TIER_IDS` declaration, the `const ASK_MODELS` declaration). A whole-file scan would pick
     up the same id from any other list, example or message in the file.
   Exports `checkParity` so the UI suite (S69) runs the same check on the real files in CI. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILES = {
  sql: 'supabase/migrations/desk_021_ask_model_tier.sql',
  server: 'supabase/functions/desk-ask/index.ts',
  client: 'scripts/data.js',
};

/* Replace every comment with spaces (newlines kept, so offsets and line numbers survive), leaving
   string contents alone. `lang` picks the comment grammar: 'sql' (-- and block) or 'js' (// and
   block, plus template literals). Strings: '..' and ".." (and `..` for js); '' inside a SQL string is
   an escaped quote, a backslash escapes in js. */
export function blankComments(src, lang) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (lang === 'sql' ? (c === '-' && d === '-') : (c === '/' && d === '/')) {
      let j = i; while (j < n && src[j] !== '\n') j++;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2;
      blank(i, j); i = j; continue;
    }
    if (c === "'" || c === '"' || (lang === 'js' && c === '`')) {
      let j = i + 1;
      while (j < n) {
        if (lang === 'js' && src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) {
          if (lang === 'sql' && src[j + 1] === c) { j += 2; continue; }   // '' is one quote inside a SQL string
          break;
        }
        j++;
      }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

/* The text of ONE statement from `start`: up to the first top-level `;` (js) or the matching `)` of
   the opening `(` at `start` (sql). Strings are skipped so a `;` or `)` inside one does not end it. */
function statementFrom(masked, start, { closeParen = false } = {}) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < masked.length && masked[j] !== c) j += masked[j] === '\\' ? 2 : 1;
      i = j; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (closeParen && depth === 0) return masked.slice(start, i + 1);
    } else if (c === ';' && depth <= 0 && !closeParen) return masked.slice(start, i + 1);
  }
  return null;
}

const quoted = (text) => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);

export function readSql(src) {
  const masked = blankComments(src, 'sql');
  const m = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.desk_ask_model\s*\(/i.exec(masked);
  if (!m) return { error: 'no CREATE TABLE public.desk_ask_model' };
  const body = statementFrom(masked, m.index + m[0].length - 1, { closeParen: true });
  if (!body) return { error: 'the CREATE TABLE is not closed' };
  const check = /check\s*\(\s*model\s+in\s*\(([^)]*)\)\s*\)/i.exec(body);
  if (!check) return { error: 'no CHECK (model IN (...)) inside the table' };
  const def = /\bmodel\s+text\s+not\s+null\s+default\s+'([^']*)'/i.exec(body);
  return { list: quoted(check[1]), fallback: def ? def[1] : null };
}

export function readServer(src) {
  const masked = blankComments(src, 'js');
  const ids = /(^|\n)[ \t]*(?:export\s+)?const\s+TIER_IDS\b[^=\n]*=/.exec(masked);
  if (!ids) return { error: 'no `const TIER_IDS =`' };
  const stmt = statementFrom(masked, ids.index + ids[0].length);
  if (!stmt) return { error: 'TIER_IDS is not terminated' };
  const fb = /(^|\n)[ \t]*(?:export\s+)?const\s+TIER_FALLBACK\b[^=\n]*=\s*(['"])([^'"]*)\2/.exec(masked);
  return { list: quoted(stmt), fallback: fb ? fb[3] : null };
}

export function readClient(src) {
  const masked = blankComments(src, 'js');
  const m = /(^|\n)[ \t]*(?:export\s+)?const\s+ASK_MODELS\b[^=\n]*=/.exec(masked);
  if (!m) return { error: 'no `const ASK_MODELS =`' };
  const stmt = statementFrom(masked, m.index + m[0].length);
  if (!stmt) return { error: 'ASK_MODELS is not terminated' };
  return { list: [...stmt.matchAll(/\bid\s*:\s*(['"])([^'"]*)\1/g)].map((x) => x[2]) };
}

/* files: { sql, server, client } — the TEXT of each. Returns { ok, problems[], lists }. */
export function checkParity(files) {
  const problems = [];
  const sql = readSql(files.sql), server = readServer(files.server), client = readClient(files.client);
  const where = { sql: FILES.sql, server: FILES.server, client: FILES.client };
  for (const [k, r] of Object.entries({ sql, server, client })) if (r.error) problems.push(`${where[k]}: ${r.error}`);
  const lists = { sql: sql.list, server: server.list, client: client.list };
  const have = Object.entries(lists).filter(([, v]) => Array.isArray(v));
  for (const [k, v] of have) {
    if (!v.length) problems.push(`${where[k]}: the model list is empty`);
    if (new Set(v).size !== v.length) problems.push(`${where[k]}: the model list repeats an id (${v.join(', ')})`);
  }
  const ref = lists.sql ?? lists.server ?? lists.client;
  for (const [k, v] of have) {
    if (ref && JSON.stringify(v) !== JSON.stringify(ref)) {
      problems.push(`${where[k]}: [${v.join(', ')}] differs from [${ref.join(', ')}] — same ids, same order, everywhere`);
    }
  }
  if (server.list && server.fallback == null) problems.push(`${where.server}: no \`const TIER_FALLBACK = '...'\``);
  if (server.fallback != null && server.list && !server.list.includes(server.fallback)) {
    problems.push(`${where.server}: TIER_FALLBACK ${server.fallback} is not in TIER_IDS`);
  }
  if (sql.list && sql.fallback == null) problems.push(`${where.sql}: the model column has no DEFAULT`);
  if (sql.fallback != null && server.fallback != null && sql.fallback !== server.fallback) {
    problems.push(`the SQL column default (${sql.fallback}) is not the server's TIER_FALLBACK (${server.fallback})`);
  }
  return { ok: problems.length === 0, problems, lists, fallback: { sql: sql.fallback ?? null, server: server.fallback ?? null } };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function readRepo(root = ROOT) {
  const out = {};
  for (const [k, rel] of Object.entries(FILES)) {
    try { out[k] = readFileSync(path.join(root, rel), 'utf8'); } catch { out[k] = ''; }
  }
  return out;
}

const GOOD = {
  sql: `-- model in ('claude-opus-5-5')  <- a comment naming a model must not count
create table if not exists public.desk_ask_model (
  id boolean primary key default true check (id),
  model text not null default 'claude-haiku-5-5'
    check (model in ('claude-haiku-5-5',
                     -- 'claude-fable-5' was dropped (it's not offered)
                     'claude-sonnet-5-5', 'claude-opus-5-5')),  -- 'claude-fable-5'
  updated_at timestamptz not null default now()
);
create table public.other (model text check (model in ('claude-opus-5')));`,
  server: `// const TIER_IDS = ['claude-opus-5'];  (an old list in a comment)
const OTHER = ['claude-opus-5'];
/*
const TIER_IDS = ['claude-fable-5'];
*/
const WILD = 'a/*b';
const TIER_IDS = [
  'claude-haiku-5-5', // cheapest first
  // 'claude-fable-5' once lived here
  'claude-sonnet-5-5',
  'claude-opus-5-5',
] as const;
const TIER_FALLBACK = 'claude-haiku-5-5';
const url = 'https://example.com/a'; /* 'claude-fable-5' */`,
  client: `/* const ASK_MODELS = [{ id: 'claude-opus-5' }]; */
const ASK_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  /* { id: 'claude-fable-5', label: 'F' }, */
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
];
const NOTE = "ids: claude-haiku-5-5";`,
};

function selftest() {
  const cases = [];
  const run = (name, mutate, wantOk, wantText, { noop = false } = {}) => {
    const f = { ...GOOD }; mutate(f);
    // a mutation whose pattern no longer matches the fixture changes nothing and would "pass" — refuse that
    const applied = noop || Object.keys(GOOD).some((k) => f[k] !== GOOD[k]);
    const r = checkParity(f);
    const hit = wantText ? r.problems.some((p) => p.includes(wantText)) : true;
    cases.push({ name: applied ? name : name + '  [MUTATION DID NOT APPLY]', pass: applied && r.ok === wantOk && hit, got: r });
  };
  run('the good fixture passes (comments inside and outside each declaration, decoy lists, a URL, a /* inside a string, a second table)', () => {}, true, undefined, { noop: true });
  run('drop a model from the SQL CHECK', (f) => { f.sql = f.sql.replace(", 'claude-opus-5-5')),", ")),"); }, false, 'differs');
  const swapInDecl = (text, declRe) => text.replace(declRe, (m) => m.replaceAll('claude-haiku-5-5', '@@').replaceAll('claude-sonnet-5-5', 'claude-haiku-5-5').replaceAll('@@', 'claude-sonnet-5-5'));
  run('swap two ids in the server list', (f) => { f.server = swapInDecl(f.server, /const TIER_IDS[\s\S]*?as const;/); }, false, 'differs');
  run('add a model to the client list only', (f) => { f.client = f.client.replace("];\nconst NOTE", "  { id: 'claude-fable-5', label: 'F' },\n];\nconst NOTE"); }, false, 'differs');
  run('reorder the client list', (f) => { f.client = swapInDecl(f.client, /const ASK_MODELS = \[[\s\S]*?\n\];/); }, false, 'differs');
  run('fallback not in the list', (f) => { f.server = f.server.replace("TIER_FALLBACK = 'claude-haiku-5-5'", "TIER_FALLBACK = 'claude-fable-5'"); }, false, 'not in TIER_IDS');
  run('fallback differs from the SQL default', (f) => { f.server = f.server.replace("TIER_FALLBACK = 'claude-haiku-5-5'", "TIER_FALLBACK = 'claude-opus-5-5'"); }, false, 'SQL column default');
  run('SQL default differs from the fallback', (f) => { f.sql = f.sql.replace("default 'claude-haiku-5-5'", "default 'claude-sonnet-5-5'"); }, false, 'SQL column default');
  run('the SQL table is missing', (f) => { f.sql = '-- nothing'; }, false, 'no CREATE TABLE');
  run('TIER_IDS is missing from the server', (f) => { f.server = f.server.replace(/const TIER_IDS[\s\S]*?as const;/, ''); }, false, 'TIER_IDS');
  run('no TIER_FALLBACK on the server', (f) => { f.server = f.server.replace("const TIER_FALLBACK = 'claude-haiku-5-5';", ''); }, false, 'TIER_FALLBACK');
  run('no DEFAULT on the SQL model column', (f) => { f.sql = f.sql.replace("model text not null default 'claude-haiku-5-5'", 'model text not null'); }, false, 'no DEFAULT');
  run('a repeated id', (f) => { f.client = f.client.replace("{ id: 'claude-opus-5-5', label: 'Opus 5.5' },", "{ id: 'claude-opus-5-5', label: 'Opus 5.5' },\n  { id: 'claude-opus-5-5', label: 'again' },"); }, false, 'repeats');
  run('every list empty (the fallback check alone must not be what catches it)', (f) => {
    f.sql = f.sql.replace(/check \(model in \([\s\S]*?\)\),/, 'check (model in ()),');
    f.server = f.server.replace(/const TIER_IDS = \[[\s\S]*?\] as const;/, 'const TIER_IDS = [] as const;');
    f.client = f.client.replace(/const ASK_MODELS = \[[\s\S]*?\n\];/, 'const ASK_MODELS = [];');
  }, false, 'is empty');
  run('a `/*` inside a string does not start a comment', (f) => { f.server = f.server.replace("const WILD = 'a/*b';", "const WILD = 'a/*b';\nconst MORE = '//';"); }, true);
  run('a model id ONLY in a comment changes nothing', (f) => { f.server = f.server.replace('const OTHER', "// TIER_IDS gains 'claude-fable-5'\nconst OTHER"); }, true);
  run('a decoy list elsewhere in the file changes nothing', (f) => { f.client = f.client + "\nconst DECOY = [{ id: 'claude-fable-5' }];"; }, true);
  run('an `//` inside a string does not hide the rest of the line', (f) => { f.server = f.server.replace("'claude-sonnet-5-5',", "'claude-sonnet-5-5', /* x */"); }, true);
  let bad = 0;
  for (const c of cases) {
    if (!c.pass) bad++;
    console.log(`${c.pass ? '  ok ' : 'FAIL '} ${c.name}${c.pass ? '' : '\n      got ' + JSON.stringify(c.got)}`);
  }
  console.log(bad ? `${bad} of ${cases.length} selftest cases FAILED` : `all ${cases.length} selftest cases passed`);
  return bad === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  const r = checkParity(readRepo());
  if (r.ok) {
    console.log(`parity ok: [${r.lists.sql.join(', ')}] in the migration, desk-ask and scripts/data.js; fallback ${r.fallback.server}`);
  } else {
    console.error('MODEL LIST DRIFT:\n  - ' + r.problems.join('\n  - '));
    process.exit(1);
  }
}
