-- desk_025 — the browser roles lose the table privileges they never use (data.md -> Supabase
-- Defaults, check 1; claude.directives PR #494, 2026-10-27).
--
-- Supabase's default privileges give anon and authenticated EVERY privilege on each new table in
-- public, including TRUNCATE, REFERENCES, TRIGGER and (Postgres 17) MAINTAIN. TRUNCATE empties a table
-- without consulting row-level security, so a correct (or absent) policy does not cover it. PostgREST
-- cannot send any of the four, but anything that runs SQL as those roles can. Nothing in the desk uses
-- them: the page reaches the database only through PostgREST and the SECURITY DEFINER PIN RPCs, and
-- the edge functions use service_role, which this migration does not touch.
--
-- Measured live 2026-10-29 (Postgres 17.6): five tables still carried all four for both roles —
-- desk_ask_schedule, desk_chat_memory, desk_feed_cache, desk_system_prompt, desk_watchlists (the
-- other seven desk_* tables had theirs revoked by their own migrations) — and postgres's default
-- privileges in public still hand all four to both roles on every future table.
--
-- Not reachable from here, recorded instead: supabase_admin's default privileges in public grant the
-- same to anon/authenticated, and postgres is not a member of supabase_admin, so it cannot alter
-- them. They apply only to tables supabase_admin creates in public; every desk table is created
-- (and owned) by postgres, and none in public is owned by supabase_admin.
--
-- It contains the word TRUNCATE, so from a project thread the owner pastes it into the Supabase SQL
-- Editor (the connector's own approval question cannot be shown there). The DO block refuses to
-- commit unless both data.md check queries come back empty.
--
-- Verify after applying: tools/supabase-defaults-check.sql (read-only; every row ok).
--
-- revert: grant truncate, references, trigger, maintain on table public.desk_ask_schedule,
--   public.desk_chat_memory, public.desk_feed_cache, public.desk_system_prompt, public.desk_watchlists
--   to anon, authenticated; alter default privileges for role postgres in schema public grant
--   truncate, references, trigger, maintain on tables to anon, authenticated;

begin;

revoke truncate, references, trigger, maintain on all tables in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

do $$
declare
  left_on_tables int;
  left_in_defaults int;
begin
  select count(*) into left_on_tables
  from pg_class c
  cross join (values ('anon'), ('authenticated')) r(role)
  cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and has_table_privilege(r.role, c.oid, p.priv);

  select count(*) into left_in_defaults
  from pg_default_acl d, aclexplode(d.defaclacl) a
  where d.defaclrole = 'postgres'::regrole
    and d.defaclnamespace = 'public'::regnamespace
    and d.defaclobjtype = 'r'
    and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
    and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');

  if left_on_tables > 0 or left_in_defaults > 0 then
    raise exception 'desk_025 incomplete: % table grants and % default grants remain',
      left_on_tables, left_in_defaults;
  end if;
end $$;

commit;
