'use strict';
/* ── config.js — the desk's roster + backend endpoints ───────────────────────
   Adding/renaming an account is a change HERE only (FR-A4). `seed/drift/vol`
   feed the demo generator; they are ignored in live mode. Series slot = key
   (maps to --color-series-<key>; ordering is CVD-validated, do not reorder). */

const DESK_ACCOUNTS = [
  { key: 1, label: 'Account A', code: 'U***1111', seed: 101, drift: 0.0004, vol: 0.016 },
  { key: 2, label: 'Account B', code: 'U***2222', seed: 303, drift: 0.0003, vol: 0.010 },
];

/* Supabase project URL + publishable key — public by design; RLS + PIN RPCs
   are the enforcement boundary (data.md). Empty ⇒ DEMO mode. Awaiting a
   DEDICATED Supabase project for the desk (the previous backend was removed
   from an unrelated project at the owner's direction — never share one). */
const DESK_DB = {
  url: '',
  anonKey: '',
};
