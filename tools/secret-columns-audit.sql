-- Secret-column audit (data.md -> Secret Columns), first run 2026-10-27.
-- READ-ONLY: one SELECT, nothing written. Run it through the Supabase MCP `execute_sql` on the
-- dedicated project (kwugzhyfjevzwgplhtsd) on every security audit and after any migration that adds
-- a column holding a secret. Every row must read ok = true; a false row is a finding.
-- It returns no secret VALUES, only privileges and counts.
--
-- Check 1 (inventory) is the list in the first CTE: extend it when a migration adds a secret column.
-- Check 2 (who can read) is asked of the two browser roles, anon (a visitor) and authenticated (no
-- Supabase Auth user exists here; listed so a future one starts denied). The CI test PIN is a row in
-- desk_users, not a role: it reaches data only through the PIN RPCs, so the RPC rows below cover it.
-- Check 3 (a named lock) = no table/column privilege for those roles AND the only door a SECURITY
-- DEFINER function that compares the hash and never returns it.
-- The pg_net rows are the recorded deferral in CLAUDE.md (Secret columns): Supabase grants PUBLIC on
-- them and this project cannot revoke it, so the guard is that `net` is NOT an exposed API schema.
-- Check 4 (tighten-later notes) is a reading of CLAUDE.md, not SQL.
with secret_cols(sch, tbl, col) as (values
  ('public', 'desk_users', 'salt'),
  ('public', 'desk_users', 'pin_hash'),
  ('vault', 'secrets', 'secret'),
  ('vault', 'decrypted_secrets', 'decrypted_secret'),
  ('cron', 'job', 'command'),
  ('net', 'http_request_queue', 'headers')
), roles(r) as (values ('anon'), ('authenticated'))
select 'read ' || s.sch || '.' || s.tbl || '.' || s.col || ' as ' || r.r as check,
       s.sch = 'net' or not readable as ok,   -- net: the recorded deferral, guarded by schema exposure
       case when s.sch = 'net' and readable
            then 'deferral: PUBLIC grant by supabase_admin; net must stay unexposed' end as note
from secret_cols s cross join roles r
cross join lateral (select has_schema_privilege(r.r, s.sch, 'usage')
                       and (has_table_privilege(r.r, format('%I.%I', s.sch, s.tbl), 'select')
                            or has_column_privilege(r.r, format('%I.%I', s.sch, s.tbl), s.col, 'select'))
                       as readable) x
where to_regclass(format('%I.%I', s.sch, s.tbl)) is not null
union all
select 'cron.job has RLS on', (select relrowsecurity from pg_class where oid = 'cron.job'::regclass), null
union all
select 'no literal secret in cron.job.command',
       not exists (select 1 from cron.job
                    where command ~* '(sk-ant|sb_secret|eyJ[A-Za-z0-9_-]{10,}|x-cron-secret.{0,6}:\s*''[A-Za-z0-9]{12,})'),
       'headers must come from vault.decrypted_secrets at run time'
union all
select 'no public function returns a desk_users row or its hash',
       not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and (p.prosrc ~* 'to_jsonb\(u\)|u\.\*|row_to_json\(u'
                           or (select count(*) from regexp_matches(p.prosrc, 'salt', 'g'))
                              <> (select count(*) from regexp_matches(p.prosrc, 'u\.salt \|\| pin', 'g'))
                           or (select count(*) from regexp_matches(p.prosrc, 'pin_hash', 'g'))
                              <> (select count(*) from regexp_matches(p.prosrc, 'pin_hash = encode', 'g')))),
       'salt and pin_hash may appear only inside the hash comparison'
union all
select 'no public view exists (none to leak a column)',
       not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind in ('v', 'm')),
       'a new view needs its own row in this audit'
union all
select 'no account number in desk_account_snapshots.label or positions',
       not exists (select 1 from public.desk_account_snapshots
                    where label ~ '[0-9]{4,}' or positions::text ~* '"(account|acct|accountid|account_id)"'),
       'labels are short names; positions carry sym/qty/mkt/unrl/dayPct only';
-- Also check over the API (not SQL): with the public anon key, GET /rest/v1/<any> with
-- `Accept-Profile: net` must answer PGRST106 (only public, graphql_public exposed), and
-- GET /rest/v1/desk_users?select=salt must answer 42501.
