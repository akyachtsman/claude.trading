/* Shared loaders for the unit tests in tools/unit/ (run: `node --test tools/unit/`).

   Nothing here touches the network or the live Supabase project.

   loadData(opts)        scripts/data.js in a fresh `vm` context with stub storage and a
                         settable clock; returns the context, so every top-level function
                         and `const` the file declares is reachable by name (`ctx.fmtPct`).
   loadEdge(name, names) supabase/functions/<name>/index.ts transpiled with the PINNED
                         esbuild (`npm ci --prefix tools` once) and run in a fresh `vm`
                         context with `Deno.serve` captured and `fetch` stubbed. The
                         internal helpers listed in `names` are exposed on the returned
                         object (they are not exported by the function itself); the request
                         handler is `handler`. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A Date whose "now" is the settable `clock.now` (ms). Every other constructor form is untouched.
function clockedDate(clock) {
  return class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  };
}

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

export function loadData({ now = Date.parse('2026-10-14T17:00:00Z'), search = '', extra = {} } = {}) {
  const clock = { now };
  const ctx = {
    console, Intl, Math, JSON, Date: clockedDate(clock), clock,
    window: {}, document: {}, location: { search }, navigator: {},
    localStorage: memStorage(), sessionStorage: memStorage(),
    setTimeout, clearTimeout, URLSearchParams, URL, AbortController, AbortSignal,
    fetch: () => Promise.reject(new Error('network is off in unit tests')),
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'scripts/config.js'), 'utf8'), ctx, { filename: 'config.js' });
  vm.runInContext(readFileSync(path.join(ROOT, 'scripts/data.js'), 'utf8'), ctx, { filename: 'data.js' });
  // Top-level `const`/`let` live in the context's lexical scope, not on the global object:
  // reach them through a getter evaluated inside the context.
  return new Proxy(ctx, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (k in t) return t[k];
      try { return vm.runInContext(k, t); } catch { return undefined; }
    },
  });
}

const ESBUILD = path.join(ROOT, 'tools/node_modules/.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
const transpiled = new Map();
export function transpile(file) {
  if (transpiled.has(file)) return transpiled.get(file);
  const ts = readFileSync(file, 'utf8');
  const r = spawnSync(ESBUILD, ['--loader=ts', '--format=cjs', '--log-level=error'], { input: ts, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error && r.error.code === 'ENOENT') throw new Error('the pinned esbuild is not installed — run: npm ci --prefix tools');
  if (r.status !== 0) throw new Error('esbuild failed: ' + (r.stderr || r.error || 'unknown'));
  transpiled.set(file, r.stdout);
  return r.stdout;
}

/* opts: env (Deno.env values), fetch (stub; default rejects), now (ms), require (map of id → module),
   console (default: records into `logs`). */
export function loadEdge(name, names = [], opts = {}) {
  const code = transpile(path.join(ROOT, 'supabase/functions', name, 'index.ts'));
  const clock = { now: opts.now ?? Date.parse('2026-10-14T17:00:00Z') };
  const env = opts.env || {};
  const logs = [];
  let handler = null;
  const mod = { exports: {} };
  const rec = (...a) => logs.push(a.map(String).join(' '));
  const sandbox = {
    module: mod, exports: mod.exports,
    require: (id) => { if (opts.require && id in opts.require) return opts.require[id]; throw new Error('unexpected require ' + id); },
    Deno: { serve: (...a) => { handler = a.find((x) => typeof x === 'function'); }, env: { get: (k) => (Object.hasOwn(env, k) ? env[k] : undefined) } },
    fetch: opts.fetch || (() => Promise.reject(new Error('network is off in unit tests'))),
    Response, Request, Headers, AbortSignal, AbortController, URL, URLSearchParams, Intl, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, structuredClone, crypto: globalThis.crypto, atob, btoa,
    Date: clockedDate(clock), clock,
    console: opts.console || { log: rec, info: rec, warn: rec, error: rec, debug: rec },
  };
  vm.createContext(sandbox);
  const expose = names.length ? `\n;globalThis.__t = { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };` : '';
  vm.runInContext(code + expose, sandbox, { filename: `${name}.cjs` });
  const t = sandbox.__t || {};
  for (const n of names) if (t[n] === undefined) throw new Error(`${name}: no top-level binding named ${n}`);
  return { ...t, handler, clock, logs, sandbox, exports: mod.exports };
}
