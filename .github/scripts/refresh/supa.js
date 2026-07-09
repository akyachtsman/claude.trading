'use strict';
/* ── supa.js — service-key REST access to the desk_* tables (data.md: the
   service role key lives ONLY in Actions secrets, never client-side).
   PostgREST upserts use on_conflict + Prefer: resolution=merge-duplicates,
   matching the unique constraints from migration desk_001_tables. ─────────── */
import { retryFetch } from './lib/util.js';

export const supaConfigured = () => Boolean(process.env.DB_URL && process.env.DB_SERVICE_KEY);

function headers(extra = {}) {
  const key = process.env.DB_SERVICE_KEY;
  return {
    'content-type': 'application/json',
    apikey: key,
    authorization: 'Bearer ' + key,
    ...extra,
  };
}

export async function supaSelect(pathAndQuery) {
  const res = await retryFetch(process.env.DB_URL + '/rest/v1/' + pathAndQuery, { headers: headers() });
  return res.json();
}

export async function supaUpsert(table, rows, conflictCols) {
  if (!rows.length) return;
  const url = `${process.env.DB_URL}/rest/v1/${table}?on_conflict=${conflictCols}`;
  await retryFetch(url, {
    method: 'POST',
    headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
}

/* The dashboard owner (single non-test user). */
export async function ownerUserId() {
  const rows = await supaSelect('desk_users?select=id&is_test=eq.false&limit=1');
  if (!rows.length) throw new Error('no owner row in desk_users');
  return rows[0].id;
}

/* Latest snapshot per account for a user (used for brief grounding and the
   held-ticker list in the news job). */
export async function latestSnapshots(userId) {
  const rows = await supaSelect(
    `desk_account_snapshots?select=account_key,label,as_of,nav,day_pnl,total_unrl,cash,positions&user_id=eq.${userId}&order=as_of.desc&limit=40`
  );
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.account_key)) latest.set(r.account_key, r);
  return [...latest.values()].sort((a, b) => a.account_key - b.account_key);
}
