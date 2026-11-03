/* tools/watchlist-scan.mjs must run from a checkout whose path needs URL-encoding.
   Its entry guard compared the percent-encoded import.meta.url with the raw argv[1],
   so from a folder with a space in its name the scan printed NOTHING and exited 0 —
   the "silence means nothing found" failure the tool itself forbids (audit I12). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib.mjs';

test('watchlist-scan: runs from a path with a space in it, and says ok:false for an unusable roster', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'scan entry '));
  try {
    mkdirSync(path.join(base, 'tools')); mkdirSync(path.join(base, 'scripts'));
    copyFileSync(path.join(ROOT, 'tools/watchlist-scan.mjs'), path.join(base, 'tools/watchlist-scan.mjs'));
    for (const f of ['data.js', 'config.js']) copyFileSync(path.join(ROOT, 'scripts', f), path.join(base, 'scripts', f));
    // '!!,??' holds no ticker, so nothing is fetched: the run ends at once with ok:false.
    const r = spawnSync(process.execPath, [path.join(base, 'tools/watchlist-scan.mjs'), '--symbols=!!,??'], { encoding: 'utf8', timeout: 30000 });
    assert.ok(r.stdout.trim().length > 0, 'the scan printed a report (the old guard printed nothing)');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.notEqual(r.status, 0, 'an unusable roster is a non-zero exit, never a silent 0');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
