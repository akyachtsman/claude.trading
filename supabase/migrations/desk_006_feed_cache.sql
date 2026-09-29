-- desk_006_feed_cache — RECONSTRUCTED on 2026-09-29 from the live catalog, NOT
-- the original text. The original was applied out-of-band through the Supabase
-- MCP (live migration log: version 20260714023225, name desk_006_feed_cache)
-- and was never committed. Rebuilt from information_schema / pg_class on the
-- dedicated project (kwugzhyfjevzwgplhtsd).
--
-- DO NOT APPLY THIS TO THE LIVE PROJECT — the table already exists. It exists so
-- a scratch/fresh database can be rebuilt by replaying supabase/migrations/ in
-- order.
--
-- revert: drop table public.desk_feed_cache — a cache of public market data only (owner approval per data.md before dropping anything on the live project; the edge functions repopulate it, so the cost is a cold start).
--
-- A key/value cache the edge functions write with the service-role key.
-- CLAUDE.md records desk-heatmap as persisting its daily multi-period sweep
-- ledger here (public market percentages only), and desk_008 describes its own
-- table as "RLS deny-all exactly like desk_feed_cache (desk_006)".
--
-- RLS is enabled with NO policies (deny-all). Unlike desk_001's tables the live
-- ACL is Supabase's DEFAULT (anon/authenticated/service_role all hold table
-- privileges) — nothing was revoked here, so nothing is revoked below; RLS with
-- no policy is what keeps anon out.

create table if not exists public.desk_feed_cache (
  key      text        primary key,
  at       timestamptz not null default now(),
  payload  jsonb       not null
);

alter table public.desk_feed_cache enable row level security;
