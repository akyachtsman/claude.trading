-- Supabase Defaults audit (data.md -> Supabase Defaults), first run 2026-10-29.
-- READ-ONLY: one SELECT, nothing written. Run it through the Supabase MCP `execute_sql` on the
-- dedicated project (kwugzhyfjevzwgplhtsd) on every security audit, beside
-- tools/secret-columns-audit.sql. Every row must read ok = true; a false row is a finding.
--
-- Check 1 (default grants): data.md's two queries, with MAINTAIN added (Postgres 17). The first
--   reads the tables that exist, the second the defaults a future table gets; both must be empty,
--   so each is one row here holding the count and the offenders. Fixed by desk_025.
-- Check 2 (pg_net): the PUBLIC grant on net.http_request_queue cannot be revoked here and is
--   recorded in CLAUDE.md (Secret columns, kept deferral). Its three rules are checked as far as
--   SQL can see: pg_graphql not installed, and no function in public reads net.*. The third rule —
--   net, extensions, cron and vault are not exposed API schemas — lives in the API settings, not
--   the database: probe it with the anon key (Accept-Profile: net, ... must answer PGRST106).
-- Check 3 (leaked-password protection): N/A while the desk uses PIN login and Supabase Auth holds
--   no user; the row turns false the day one appears.
with t as (
  select coalesce(string_agg(format('%s %s %s', c.oid::regclass, r.role, p.priv), ', '), '') as hits,
         count(*) as n
  from pg_class c
  cross join (values ('anon'), ('authenticated')) r(role)
  cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) p(priv)
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and has_table_privilege(r.role, c.oid, p.priv)
), d as (
  select coalesce(string_agg(format('%s %s', a.grantee::regrole, a.privilege_type), ', '), '') as hits,
         count(*) as n
  from pg_default_acl d, aclexplode(d.defaclacl) a
  where d.defaclrole = 'postgres'::regrole
    and d.defaclnamespace = 'public'::regnamespace
    and d.defaclobjtype = 'r'
    and a.grantee in ('anon'::regrole, 'authenticated'::regrole)
    and a.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
)
select '1a no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on public tables for anon/authenticated' as check,
       t.n = 0 as ok, nullif(t.hits, '') as note from t
union all
select '1b postgres default privileges in public grant none of them',
       d.n = 0, nullif(d.hits, '') from d
union all
select '2a pg_net installed (the recorded deferral applies)',
       true, case when exists (select 1 from pg_extension where extname = 'pg_net')
                  then 'installed: keep the CLAUDE.md rules' else 'not installed: N/A' end
union all
select '2b pg_graphql is not installed',
       not exists (select 1 from pg_extension where extname = 'pg_graphql'), null
union all
select '2c no function in public reads net.*',
       not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                   and prosrc ~* '\mnet\.'),
       (select string_agg(proname::text, ', ') from pg_proc
        where pronamespace = 'public'::regnamespace and prosrc ~* '\mnet\.')
union all
select '3 no Supabase Auth user (leaked-password protection N/A)',
       (select count(*) from auth.users) = 0,
       format('%s auth users', (select count(*) from auth.users));
