'use strict';
/* ── notify-fail.js — refresh-failure email (workflow `if: failure()` step) ──
   Bridges to the CJS bootstrap helper ../notify-email.js (nodemailer). Missing
   SMTP config degrades to a visible Actions warning, never a crash — the
   guarded-secret convention. Context arrives via env RUN_URL / FAILED_NOTE. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { STATUS_DIR, readJsonIfExists, warn } from './lib/util.js';

const REQUIRED = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'ALERT_TO'];

async function main() {
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) {
    warn('Failure email not sent', `refresh failed but ${missing.join(', ')} not configured — see the run log.`);
    return;
  }
  let lines = [];
  try {
    for (const f of (await readdir(STATUS_DIR)).filter(f => f.endsWith('.json'))) {
      const s = await readJsonIfExists(path.join(STATUS_DIR, f));
      if (s) lines.push(`- ${s.domain}: ${s.status}${s.detail ? ' — ' + s.detail : ''}`);
    }
  } catch { /* no statuses written */ }

  const { sendEmail } = createRequire(import.meta.url)('../notify-email.js');
  await sendEmail({
    subject: 'claude.trading: data refresh FAILED',
    text: [
      'The scheduled data refresh hit a failure. Last-good data keeps serving with its older as-of stamp (FR-D4).',
      '',
      'Domain statuses this run:',
      ...(lines.length ? lines : ['- (no domain statuses were written)']),
      '',
      process.env.FAILED_NOTE || '',
      'Run: ' + (process.env.RUN_URL || 'see Actions tab'),
    ].join('\n'),
  });
}

main().catch(err => warn('Failure email not sent', String(err.message || err)));
