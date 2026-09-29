-- TARGET: a Supabase project or branch (the anon/authenticated roles must already exist for the revokes below), NOT vanilla Postgres.
-- desk_001_tables — RECONSTRUCTED on 2026-09-29 from the live catalog, NOT the
-- original text. The original was applied out-of-band through the Supabase MCP
-- (live migration log: version 20260710215033, name desk_001_tables) and was
-- never committed, so this file is a best-effort rebuild of its EFFECT, read
-- back from pg_catalog / information_schema on the dedicated project
-- (kwugzhyfjevzwgplhtsd). Comments, statement order and any incidental clauses
-- of the original are unrecoverable.
--
-- DO NOT APPLY THIS TO THE LIVE PROJECT — it is already at (or past) this
-- state. It exists so a scratch/fresh database can be rebuilt by replaying
-- supabase/migrations/ in order.
--
-- revert: drop table public.desk_ai_briefs, public.desk_equity_history, public.desk_account_snapshots, public.desk_users (in that order, after dropping public.desk_chat_memory from desk_008, which also references desk_users) — DESTROYS all account data: owner approval, backup/PITR only.
--
-- What it created (all four tables are RLS deny-all — RLS enabled, NO policies
-- — and anon/authenticated hold NO table privileges at all; the only readers
-- are the SECURITY DEFINER PIN RPCs of desk_002 and the service-role key inside
-- the edge functions, which bypasses RLS):
--   desk_users             the owner rows: label + salted-SHA256 PIN hash
--   desk_account_snapshots one row per (user, account, day): balances + positions
--   desk_equity_history    one NAV point per (user, account, day)
--   desk_ai_briefs         the retired twice-daily AI brief (desk-brief is
--                          unscheduled but the table and the desk_get_dashboard
--                          `brief` field still exist)
--
-- NOT attributable from the catalog, flagged rather than guessed:
--   * desk_users.is_test — it may have been created here or added by a later
--     out-of-band step (desk_003 seed). Its position as the LAST column is
--     consistent with either. It is declared here so the table is complete
--     before anything (desk_002, desk_007/008) reads it.
--   * the pgcrypto statement below — Supabase pre-installs pgcrypto in the
--     `extensions` schema, so the original probably had no such line. It is
--     idempotent and only matters on a scratch database that lacks it, where
--     desk_002's extensions.digest() calls would otherwise fail to resolve.
--     The `extensions` schema is created first for the same reason.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── desk_users ──────────────────────────────────────────────────────────────
-- pin_hash = encode(extensions.digest(salt || pin, 'sha256'), 'hex'). The PIN is
-- never stored; a login is a lookup by recomputed hash (see desk_login).
create table if not exists public.desk_users (
  id        uuid    primary key default gen_random_uuid(),
  label     text    not null,
  salt      text    not null,
  pin_hash  text    not null,
  is_test   boolean not null default false
);

-- ── desk_account_snapshots ──────────────────────────────────────────────────
create table if not exists public.desk_account_snapshots (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references public.desk_users(id),
  account_key integer     not null,
  label       text        not null default ''::text,
  as_of       date        not null,
  nav         numeric     not null,
  day_pnl     numeric     not null,
  total_unrl  numeric     not null,
  cash        numeric     not null,
  positions   jsonb       not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, account_key, as_of)
);

-- ── desk_equity_history ─────────────────────────────────────────────────────
create table if not exists public.desk_equity_history (
  user_id     uuid    not null references public.desk_users(id),
  account_key integer not null,
  as_of       date    not null,
  nav         numeric not null,
  primary key (user_id, account_key, as_of)
);

-- ── desk_ai_briefs ──────────────────────────────────────────────────────────
create table if not exists public.desk_ai_briefs (
  id           bigint      generated always as identity primary key,
  user_id      uuid        not null references public.desk_users(id),
  as_of        date        not null,
  generated_at timestamptz not null default now(),
  model        text        not null,
  content      jsonb       not null,
  unique (user_id, as_of)
);

-- ── RLS: deny-all, no policies (pg_policies is empty for the whole schema) ──
alter table public.desk_users             enable row level security;
alter table public.desk_account_snapshots enable row level security;
alter table public.desk_equity_history    enable row level security;
alter table public.desk_ai_briefs         enable row level security;

-- Supabase's default privileges grant every new public table to anon and
-- authenticated. Live ACL on these four is {postgres, service_role} only, so the
-- original revoked them (no column-level grants exist either).
revoke all on table public.desk_users             from anon, authenticated;
revoke all on table public.desk_account_snapshots from anon, authenticated;
revoke all on table public.desk_equity_history    from anon, authenticated;
revoke all on table public.desk_ai_briefs         from anon, authenticated;
