'use strict';
/* ── write-meta.js — data/meta.json from the run's per-domain statuses ───────
   Runs last, always exits 0: meta must reflect a partial refresh honestly
   (FR-D2/FR-D4). Domain files embed their own as-of and always win over meta
   in the browser (CDN-skew rule); meta supplies the masthead stamp + per-
   domain status for observability. A domain with no status this run keeps
   its previous meta entry — last-good keeps serving. */
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { DATA_DIR, STATUS_DIR, writeJson, readJsonIfExists } from './lib/util.js';

async function main() {
  const prev = (await readJsonIfExists(path.join(DATA_DIR, 'meta.json'))) || { domains: {} };
  const domains = { ...(prev.domains || {}) };

  let files = [];
  try { files = (await readdir(STATUS_DIR)).filter(f => f.endsWith('.json')); } catch { /* no statuses this run */ }
  for (const f of files) {
    const s = await readJsonIfExists(path.join(STATUS_DIR, f));
    if (!s) continue;
    domains[s.domain] = {
      status: s.status,
      asOf: s.asOf || domains[s.domain]?.asOf || null,
      detail: s.detail || '',
      at: s.at,
    };
  }

  /* Masthead stamp: newest as-of across domains that have ever succeeded. */
  const asOf = Object.values(domains).map(d => d.asOf).filter(Boolean).sort().at(-1) || prev.asOf || null;
  await writeJson(path.join(DATA_DIR, 'meta.json'), {
    asOf,
    generatedAt: new Date().toISOString(),
    domains,
  });
  console.log('meta.json written — asOf ' + asOf + ', domains: '
    + Object.entries(domains).map(([k, v]) => `${k}=${v.status}`).join(' '));
}

main().catch(err => { console.log('::warning title=write-meta failed::' + String(err.message || err)); });
