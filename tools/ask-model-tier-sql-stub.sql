-- The part of the live schema desk_021 depends on, for a SCRATCH Postgres: used by tools/ask-model-tier-sql-mutants.py
-- (and by hand: build a throwaway database, run this, then supabase/migrations/desk_021_ask_model_tier.sql, then
-- tools/ask-model-tier-verify.sql). It mirrors what matters for the privilege and denial probes:
--   * the three caller roles (cluster-wide, created only if missing);
--   * the `extensions` schema holding pgcrypto (the PIN functions call extensions.digest);
--   * Supabase's DEFAULT PRIVILEGES — new tables and functions in public are granted to anon, authenticated and
--     service_role, which is exactly why desk_021 revokes and the probe measures (service_role holds INSERT and the
--     privilege to empty a table by default, so a "SELECT only" comment would be false without the revoke);
--   * public.desk_users with one real (non-test) row.
-- Run it as the scratch cluster's superuser, in a fresh database. It is NOT the live schema and is not applied anywhere.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;
create schema extensions;
create extension pgcrypto schema extensions;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
create table public.desk_users (
  id uuid primary key default gen_random_uuid(), label text not null, salt text not null, pin_hash text not null,
  is_test boolean not null default false);
alter table public.desk_users enable row level security;
insert into public.desk_users (label, salt, pin_hash, is_test)
  values ('owner', 's1', encode(extensions.digest('s1' || '1111', 'sha256'), 'hex'), false);
