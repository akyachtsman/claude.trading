-- Verification probe for supabase/migrations/desk_024_test_pin_owner_only.sql — run AFTER the migration.
--
-- It measures what the migration promises through the RPCs a browser calls (as role `anon`, with a PIN), not by
-- reading the functions' text. Everything it touches rolls back: ONE DO block ending in a deliberate exception (a
-- statement-level `begin; ... rollback;` would not survive the Supabase MCP). The result is the exception text:
--
--   ERROR:  TEST_PIN_OWNER_ONLY_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it on a scratch Postgres (psql -v ON_ERROR_STOP=0 -f ...) or on the live project with the Supabase MCP
-- execute_sql, once the owner has approved applying desk_024. It inserts two throwaway desk_users rows (an owner and
-- an is_test one) INSIDE the transaction that is then aborted; its only writes through the RPCs are refused ones and
-- one write of the system prompt's own current text back to itself, all undone by the abort.
--
-- What each group proves:
--   test PIN   the CI credential's PIN (valid, is_test) is refused by all five owner-only doors, and a refused write
--              leaves the prompt, the schedule and the roster exactly as they were; desk_login still lets it unlock.
--   owner      a non-test PIN still reads the prompt and the schedule and can save the prompt.
--   wrong PIN  still refused (no existence leak).
--   grants     anon can still execute all five (create or replace must have kept the ACL); each is still security
--              definer with search_path pinned to public.
do $probe$
declare
  salt     constant text := 'probe-salt';
  steps    jsonb := '[]'::jsonb;
  failed   jsonb := '[]'::jsonb;
  s        record;
  got      text;
  n        int := 0;
begin
  insert into public.desk_users (id, label, salt, pin_hash, is_test) values
    (gen_random_uuid(), 'probe-owner', salt, encode(extensions.digest(salt || 'probe-owner-pin', 'sha256'), 'hex'), false),
    (gen_random_uuid(), 'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-pin',  'sha256'), 'hex'), true);

  create temp table probe_before on commit drop as
    select (select md5(coalesce(content, '')) from public.desk_system_prompt where id) as prompt,
           (select md5(coalesce(string_agg(id || ':' || prompt || ':' || pos, '|' order by id), '')) from public.desk_ask_schedule) as sched,
           (select md5(coalesce(string_agg(id || ':' || title || ':' || array_to_string(symbols, ','), '|' order by id), '')) from public.desk_watchlists) as roster;

  for s in
    select * from (values
      -- ── test PIN ──────────────────────────────────────────────────────────────────────────
      ('test PIN: desk_get_system_prompt refused', 'anon', $q$select public.desk_get_system_prompt('probe-test-pin')::text$q$, '{"ok": false}'),
      ('test PIN: desk_set_system_prompt refused', 'anon', $q$select public.desk_set_system_prompt('probe-test-pin', 'PROBE OVERWRITE')::text$q$, '{"ok": false}'),
      ('...and the prompt is unchanged',          'postgres', $q$select ((select md5(coalesce(content, '')) from public.desk_system_prompt where id) = (select prompt from probe_before))::text$q$, 'true'),
      ('test PIN: desk_get_ask_schedule refused', 'anon', $q$select public.desk_get_ask_schedule('probe-test-pin')::text$q$, '{"ok": false}'),
      ('test PIN: desk_set_ask_schedule refused', 'anon', $q$select public.desk_set_ask_schedule('probe-test-pin', '[{"prompt":"PROBE"}]'::jsonb)::text$q$, '{"ok": false}'),
      ('...and the schedule is unchanged',        'postgres', $q$select ((select md5(coalesce(string_agg(id || ':' || prompt || ':' || pos, '|' order by id), '')) from public.desk_ask_schedule) = (select sched from probe_before))::text$q$, 'true'),
      ('test PIN: legacy desk_set_watchlists refused', 'anon', $q$select public.desk_set_watchlists('probe-test-pin', '[{"title":"PROBE","symbols":["AAA"]}]'::jsonb)::text$q$, '{"ok": false}'),
      ('...and the roster is unchanged',          'postgres', $q$select ((select md5(coalesce(string_agg(id || ':' || title || ':' || array_to_string(symbols, ','), '|' order by id), '')) from public.desk_watchlists) = (select roster from probe_before))::text$q$, 'true'),
      ('test PIN still unlocks (desk_login)',     'anon', $q$select (public.desk_login('probe-test-pin')->>'ok')$q$, 'true'),
      -- ── owner ─────────────────────────────────────────────────────────────────────────────
      ('owner PIN reads the prompt',              'anon', $q$select (public.desk_get_system_prompt('probe-owner-pin')->>'ok')$q$, 'true'),
      ('owner PIN saves the prompt (its own text, rolled back)', 'anon',
                                                  $q$select (public.desk_set_system_prompt('probe-owner-pin', (public.desk_get_system_prompt('probe-owner-pin')->>'content'))->>'ok')$q$, 'true'),
      ('owner PIN reads the schedule',            'anon', $q$select (public.desk_get_ask_schedule('probe-owner-pin')->>'ok')$q$, 'true'),
      -- ── wrong PIN ─────────────────────────────────────────────────────────────────────────
      ('a wrong PIN is refused',                  'anon', $q$select public.desk_get_system_prompt('not-a-pin')::text$q$, '{"ok": false}'),
      -- ── grants ────────────────────────────────────────────────────────────────────────────
      ('anon can still execute all five',         'postgres', $q$select (count(*) = 5 and bool_and(has_function_privilege('anon', f, 'execute')))::text from unnest(array['public.desk_get_system_prompt(text)', 'public.desk_set_system_prompt(text,text)', 'public.desk_get_ask_schedule(text)', 'public.desk_set_ask_schedule(text,jsonb)', 'public.desk_set_watchlists(text,jsonb)']) f$q$, 'true'),
      ('all five still security definer, search_path pinned to public', 'postgres',
                                                  $q$select (count(*) = 5 and bool_and(coalesce(prosecdef and proconfig::text = '{search_path=public}', false)))::text from pg_proc where oid in ('public.desk_get_system_prompt(text)'::regprocedure, 'public.desk_set_system_prompt(text,text)'::regprocedure, 'public.desk_get_ask_schedule(text)'::regprocedure, 'public.desk_set_ask_schedule(text,jsonb)'::regprocedure, 'public.desk_set_watchlists(text,jsonb)'::regprocedure)$q$, 'true')
    ) as t(label, as_role, stmt, want)
  loop
    n := n + 1;
    begin
      if s.as_role <> 'postgres' then execute format('set local role %I', s.as_role); end if;
      execute s.stmt into got;
      if got is null then got := 'ok'; end if;
    exception when others then
      got := sqlstate;
    end;
    execute 'reset role';
    steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'role', s.as_role, 'got', got, 'want', s.want, 'pass', got is not distinct from s.want));
    if got is distinct from s.want then
      failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'got', got, 'want', s.want));
    end if;
  end loop;

  raise exception 'TEST_PIN_OWNER_ONLY_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
