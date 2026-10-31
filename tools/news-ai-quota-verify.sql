-- Verification probe for supabase/migrations/desk_023_news_ai_quota.sql — run AFTER the migration.
--
-- It measures what the migration promises and probes the DENIALS (the sqlstate a caller actually
-- gets), not whether a grant line exists. Everything it touches rolls back: it is ONE DO block that
-- ends in a deliberate exception (a statement-level `begin; ...; rollback;` would not survive the
-- Supabase MCP), and it only ever uses day keys in the year 2099, so even a probe that somehow
-- committed could not touch a real day's counter. The result is the exception text:
--
--   ERROR:  NEWS_AI_QUOTA_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it two ways, identically:
--   * a scratch Postgres:   psql -v ON_ERROR_STOP=0 -f tools/news-ai-quota-verify.sql
--   * the live project:     the Supabase MCP execute_sql with this file's text, once the owner has
--                           approved applying desk_023. The MCP's destructive-SQL detector stops a
--                           statement that STARTS with delete, drop or truncate (inside the DO body
--                           too, and an EXECUTE of a literal string that starts so). If it stops this
--                           probe, a project thread cannot draw its form: run the same text from a
--                           claude.ai chat with the Supabase connector, the SQL editor behind that
--                           (CLAUDE.md -> Applying a migration).
--                           Do not reword the keywords away: a probe that no longer attempts the
--                           delete or the truncate no longer proves they are refused.
--
-- What each group proves:
--   privileges  RLS is on with no policy; NO caller role holds ANY privilege on the table (the project
--               default also gives service_role INSERT and the right to empty it — the revoke has to
--               remove them); the function is SECURITY DEFINER; only service_role may execute it and
--               PUBLIC may not.
--   denials     anon and authenticated cannot call the function; service_role cannot read, insert,
--               update, delete or empty the table; anon cannot read it.
--   rpc         with a cap of 2 the third call of a day is false and writes nothing; a new day is
--               independent; a cap below 1 or NULL and a malformed day (including one with a trailing
--               newline) answer false and write NO row.
-- The 20-way parallel burst (the atomicity claim) cannot be a single-transaction probe; it is run by
-- tools/news-ai-quota-check.py.
do $probe$
declare
  steps  jsonb := '[]'::jsonb;
  failed jsonb := '[]'::jsonb;
  s      record;
  got    text;
  n      int := 0;
  fn     constant text := 'public.desk_news_ai_take(text,integer)';
begin
  for s in
    select * from (values
      -- ── privileges ────────────────────────────────────────────────────────────
      ('rls is on',                 'postgres', $q$select relrowsecurity::text from pg_class where oid = 'public.desk_news_ai_quota'::regclass$q$, 'true'),
      ('there is no policy',        'postgres', $q$select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'desk_news_ai_quota'$q$, '0'),
      ('no caller role holds any privilege on the table',
                                    'postgres', $q$select coalesce(string_agg(r || ':' || p, ',' order by r, p), '') from unnest(array['anon','authenticated','service_role']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p where has_table_privilege(r, 'public.desk_news_ai_quota', p)$q$, ''),
      ('the function is SECURITY DEFINER', 'postgres', $q$select prosecdef::text from pg_proc where oid = 'public.desk_news_ai_take(text,integer)'::regprocedure$q$, 'true'),
      ('only service_role may execute it', 'postgres', $q$select coalesce(string_agg(r, ',' order by r), '') from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r, 'public.desk_news_ai_take(text,integer)', 'execute')$q$, 'service_role'),
      ('PUBLIC may not execute it',  'postgres', $q$select count(*)::text from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'public.desk_news_ai_take(text,integer)'::regprocedure and a.grantee = 0$q$, '0'),
      -- ── denials ───────────────────────────────────────────────────────────────
      ('anon cannot call the function',          'anon',          $q$select public.desk_news_ai_take('2099-01-01', 5)::text$q$, '42501'),
      ('authenticated cannot call the function', 'authenticated', $q$select public.desk_news_ai_take('2099-01-01', 5)::text$q$, '42501'),
      ('anon cannot read the table',             'anon',          $q$select count(*)::text from public.desk_news_ai_quota$q$, '42501'),
      ('service_role cannot read the table',     'service_role',  $q$select count(*)::text from public.desk_news_ai_quota$q$, '42501'),
      ('service_role cannot insert a counter',   'service_role',  $q$insert into public.desk_news_ai_quota (day, n) values ('2099-02-02', 0)$q$, '42501'),
      ('service_role cannot reset a counter',    'service_role',  $q$update public.desk_news_ai_quota set n = 0$q$, '42501'),
      ('service_role cannot delete a counter',   'service_role',  $q$delete from public.desk_news_ai_quota$q$, '42501'),
      ('service_role cannot empty the table',    'service_role',  $q$truncate public.desk_news_ai_quota$q$, '42501'),
      -- ── rpc: the cap ──────────────────────────────────────────────────────────
      ('call 1 of a cap of 2 is true',     'service_role', $q$select public.desk_news_ai_take('2099-01-01', 2)::text$q$, 'true'),
      ('call 2 of a cap of 2 is true',     'service_role', $q$select public.desk_news_ai_take('2099-01-01', 2)::text$q$, 'true'),
      ('call 3 of a cap of 2 is false',    'service_role', $q$select public.desk_news_ai_take('2099-01-01', 2)::text$q$, 'false'),
      ('call 4 is still false',            'service_role', $q$select public.desk_news_ai_take('2099-01-01', 2)::text$q$, 'false'),
      ('the counter stopped at the cap (a refused call writes nothing)', 'postgres', $q$select n::text from public.desk_news_ai_quota where day = '2099-01-01'$q$, '2'),
      ('raising the cap lets the day continue', 'service_role', $q$select public.desk_news_ai_take('2099-01-01', 3)::text$q$, 'true'),
      ('a new day starts at its own count (1 of 1)', 'service_role', $q$select public.desk_news_ai_take('2099-01-02', 1)::text$q$, 'true'),
      ('and that day is then full',        'service_role', $q$select public.desk_news_ai_take('2099-01-02', 1)::text$q$, 'false'),
      ('the first day was not touched by the second', 'postgres', $q$select n::text from public.desk_news_ai_quota where day = '2099-01-01'$q$, '3'),
      -- ── rpc: refusals that must write NOTHING ─────────────────────────────────
      ('a cap of 0 is false',              'service_role', $q$select public.desk_news_ai_take('2099-03-01', 0)::text$q$, 'false'),
      ('a negative cap is false',          'service_role', $q$select public.desk_news_ai_take('2099-03-01', -5)::text$q$, 'false'),
      ('a NULL cap is false',              'service_role', $q$select public.desk_news_ai_take('2099-03-01', null)::text$q$, 'false'),
      ('a NULL day is false',              'service_role', $q$select public.desk_news_ai_take(null, 5)::text$q$, 'false'),
      ('a day not in YYYY-MM-DD is false', 'service_role', $q$select public.desk_news_ai_take('2099-3-1', 5)::text$q$, 'false'),
      ('free text for a day is false',     'service_role', $q$select public.desk_news_ai_take('tomorrow', 5)::text$q$, 'false'),
      ('an empty day is false',            'service_role', $q$select public.desk_news_ai_take('', 5)::text$q$, 'false'),
      ('a day with a trailing newline is false', 'service_role', $q$select public.desk_news_ai_take(E'2099-03-01\n', 5)::text$q$, 'false'),
      ('none of those refusals wrote a row', 'postgres', $q$select count(*)::text from public.desk_news_ai_quota where day not in ('2099-01-01', '2099-01-02')$q$, '0')
    ) as t(label, as_role, stmt, want)
  loop
    n := n + 1;
    begin
      if s.as_role <> 'postgres' then execute format('set local role %I', s.as_role); end if;
      execute s.stmt into got;
      if got is null then got := 'ok'; end if;   -- a statement with no result that did not raise
    exception when others then
      got := sqlstate;
    end;
    execute 'reset role';
    steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'role', s.as_role, 'got', got, 'want', s.want, 'pass', got is not distinct from s.want));
    if got is distinct from s.want then
      failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'got', got, 'want', s.want));
    end if;
  end loop;

  raise exception 'NEWS_AI_QUOTA_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
