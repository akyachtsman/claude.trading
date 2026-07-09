'use strict';
/* ── lib/util.js — shared plumbing for the refresh pipeline ──────────────────
   Node 20+ (global fetch). Repo-root-relative paths resolve from this file so
   every script works regardless of the workflow's working-directory. */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const DATA_DIR = path.join(ROOT, 'data');
export const STATUS_DIR = process.env.STATUS_DIR || fileURLToPath(new URL('../.status/', import.meta.url));

/* GitHub Actions annotations — the bootstrap "guarded secret" convention:
   a missing secret is a visible notice + exit 0, never a cryptic crash. */
export const notice = (title, msg) => console.log(`::notice title=${title}::${msg}`);
export const warn = (title, msg) => console.log(`::warning title=${title}::${msg}`);
export const errorLine = (title, msg) => console.log(`::error title=${title}::${msg}`);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* fetch with exponential backoff on network errors, 429 and 5xx. */
export async function retryFetch(url, opts = {}, { tries = 4, baseMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
      if (res.status < 500 && res.status !== 429) throw lastErr; // 4xx: not retryable
    } catch (e) {
      lastErr = e;
    }
    if (i < tries - 1) await sleep(baseMs * 2 ** i);
  }
  throw lastErr;
}

/* ── US-market trading-day calendar ──────────────────────────────────────────
   Mirror of scripts/data.js (frontend) — keep the two lists in sync when
   extending yearly. Dates are observed market holidays. */
export const US_HOLIDAYS = new Set([
  '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
]);

/* The pipeline runs in UTC; the "current trading day" is a New York concept.
   Compute the NY calendar date, then walk back to a trading day. */
export function nyToday(now = new Date()) {
  return new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
export const isoDate = d =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const isTradingDay = d => d.getDay() !== 0 && d.getDay() !== 6 && !US_HOLIDAYS.has(isoDate(d));
export function lastTradingDay(from = nyToday()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (!isTradingDay(d)) d.setDate(d.getDate() - 1);
  return d;
}

/* ── file helpers ─────────────────────────────────────────────────────────── */
export async function writeJson(filePath, obj) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
export async function readJsonIfExists(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

/* Per-domain run status — consumed by write-meta.js at the end of the run.
   status: 'ok' | 'skipped' (missing secret) | 'not-ready' | 'failed' */
export async function writeStatus(domain, { status, asOf = null, detail = '' }) {
  await writeJson(path.join(STATUS_DIR, domain + '.json'), {
    domain, status, asOf, detail, at: new Date().toISOString(),
  });
}
