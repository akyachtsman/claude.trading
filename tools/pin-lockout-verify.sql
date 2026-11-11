-- Verification probe for supabase/migrations/desk_026_pin_lockout.sql — run AFTER the migration.
--
-- It measures the lockout through the functions a browser calls (as role `anon`, with a PIN) and the one desk-ask
-- calls (as `service_role`), not by reading their text. Everything it touches rolls back: ONE DO block ending in a
-- deliberate exception (a statement-level `begin; ... rollback;` would not survive the Supabase MCP). The result is
-- the exception text:
--
--   ERROR:  PIN_LOCKOUT_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it on a scratch Postgres (tools/pin-lockout-check.py does, against every mutant there) or on the live project
-- with the Supabase MCP execute_sql once desk_026 is applied. Live, it holds the guard row for the few milliseconds
-- it runs (a real PIN call waits that long), inserts two throwaway desk_users rows, moves the guard's counters and
-- writes a few rows back to themselves — all inside the transaction that is then aborted, so the live guard, the
-- prompt, the schedule and the model are exactly as they were. No statement in it starts with DELETE, DROP or
-- TRUNCATE, so the connector runs it without a confirmation form.
--
-- What each group proves:
--   grants     no browser role can call the helper or touch the guard; desk-ask's role can call the helper; the
--              legacy desk_set_watchlists is shut to every API role; the eleven doors are still anon-callable,
--              SECURITY DEFINER, with the search_path they had.
--   counting   a wrong PIN at EVERY door is counted exactly once; a right PIN (owner or test) is not counted and
--              does not reset the count; the test PIN is still refused by the six owner-only doors.
--   lock       the 10th miss in the window locks for an hour; while locked the RIGHT PIN is refused at every kind
--              of door (login says until when), and nothing is counted; once the lock and the window have passed
--              the owner gets in and the count starts again at 1; a miss inside the window keeps counting.
--   read-only  a right PIN asked in a read-only transaction (what PostgREST runs a GET in) gets an error, never an
--              answer — otherwise a GET could test PINs without a miss ever being written.
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
    (gen_random_uuid(), 'probe-owner', salt, encode(extensions.digest(salt || 'probe-owner-passphrase', 'sha256'), 'hex'), false),
    (gen_random_uuid(), 'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-passphrase',  'sha256'), 'hex'), true);
  create temp table probe_mark (total bigint) on commit drop;
  insert into probe_mark values (0);

  for s in
    select * from (values
      -- ── grants ────────────────────────────────────────────────────────────────────────────────
      ('anon cannot call desk_pin_who',            'postgres', $q$select has_function_privilege('anon', 'public.desk_pin_who(text)', 'execute')::text$q$, 'false'),
      ('authenticated cannot call desk_pin_who',   'postgres', $q$select has_function_privilege('authenticated', 'public.desk_pin_who(text)', 'execute')::text$q$, 'false'),
      ('service_role (desk-ask) can',              'postgres', $q$select has_function_privilege('service_role', 'public.desk_pin_who(text)', 'execute')::text$q$, 'true'),
      ('desk_pin_who is security definer, search_path public', 'postgres', $q$select (prosecdef and proconfig::text = '{search_path=public}')::text from pg_proc where oid = 'public.desk_pin_who(text)'::regprocedure$q$, 'true'),
      ('no API role holds a privilege on the guard', 'postgres', $q$select (has_table_privilege('anon', 'public.desk_pin_guard', 'select, insert, update, delete, truncate, references, trigger') or has_table_privilege('authenticated', 'public.desk_pin_guard', 'select, insert, update, delete, truncate, references, trigger') or has_table_privilege('service_role', 'public.desk_pin_guard', 'select, insert, update, delete, truncate, references, trigger'))::text$q$, 'false'),
      ('the guard has RLS on',                     'postgres', $q$select relrowsecurity::text from pg_class where oid = 'public.desk_pin_guard'::regclass$q$, 'true'),
      ('anon reading the guard is refused',        'anon',     $q$select count(*)::text from public.desk_pin_guard$q$, '42501'),
      ('anon calling desk_pin_who is refused',     'anon',     $q$select public.desk_pin_who('probe-owner-passphrase')::text$q$, '42501'),
      ('the legacy desk_set_watchlists is shut to every API role', 'postgres', $q$select (has_function_privilege('anon', 'public.desk_set_watchlists(text,jsonb)', 'execute') or has_function_privilege('authenticated', 'public.desk_set_watchlists(text,jsonb)', 'execute') or has_function_privilege('service_role', 'public.desk_set_watchlists(text,jsonb)', 'execute'))::text$q$, 'false'),
      ('the eleven doors are still anon-callable', 'postgres', $q$select (count(*) = 11 and bool_and(has_function_privilege('anon', f, 'execute')))::text from unnest(array['public.desk_login(text)', 'public.desk_get_dashboard(text)', 'public.desk_chat_clear(text)', 'public.desk_chat_history(text)', 'public.desk_get_watchlists(text)', 'public.desk_get_system_prompt(text)', 'public.desk_set_system_prompt(text,text)', 'public.desk_get_ask_schedule(text)', 'public.desk_set_ask_schedule(text,jsonb)', 'public.desk_get_ask_model(text)', 'public.desk_set_ask_model(text,text)']) f$q$, 'true'),
      ('...still security definer with their search_path', 'postgres', $q$select (count(*) = 11 and bool_and(prosecdef and proconfig::text = case when proname like '%ask_model' then '{"search_path=\"\""}' else '{search_path=public}' end))::text from pg_proc where oid in ('public.desk_login(text)'::regprocedure, 'public.desk_get_dashboard(text)'::regprocedure, 'public.desk_chat_clear(text)'::regprocedure, 'public.desk_chat_history(text)'::regprocedure, 'public.desk_get_watchlists(text)'::regprocedure, 'public.desk_get_system_prompt(text)'::regprocedure, 'public.desk_set_system_prompt(text,text)'::regprocedure, 'public.desk_get_ask_schedule(text)'::regprocedure, 'public.desk_set_ask_schedule(text,jsonb)'::regprocedure, 'public.desk_get_ask_model(text)'::regprocedure, 'public.desk_set_ask_model(text,text)'::regprocedure)$q$, 'true'),
      -- ── counting ──────────────────────────────────────────────────────────────────────────────
      ('reset the guard (rolled back)',            'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('owner PIN unlocks',                        'anon',     $q$select public.desk_login('probe-owner-passphrase')::text$q$, '{"ok": true, "label": "probe-owner"}'),
      ('test PIN unlocks',                         'anon',     $q$select public.desk_login('probe-test-passphrase')::text$q$, '{"ok": true, "label": "probe-test"}'),
      ('...neither counted',                       'postgres', $q$select fails::text from public.desk_pin_guard$q$, '0'),
      ('a wrong PIN is refused, no lock named',    'anon',     $q$select public.desk_login('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...and counted once',                      'postgres', $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('owner PIN still unlocks',                  'anon',     $q$select (public.desk_login('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('...and a success does not reset the count','postgres', $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('desk-ask''s door: owner',                  'service_role', $q$select (public.desk_pin_who('probe-owner-passphrase') - 'id')::text$q$, '{"ok": true, "is_test": false}'),
      ('desk-ask''s door: test user',              'service_role', $q$select (public.desk_pin_who('probe-test-passphrase') - 'id')::text$q$, '{"ok": true, "is_test": true}'),
      ('desk-ask''s door: wrong PIN',              'service_role', $q$select public.desk_pin_who('not-the-passphrase')::text$q$, '{"ok": false, "locked_until": null}'),
      ('...counted like any door',                 'postgres', $q$select fails::text from public.desk_pin_guard$q$, '2'),
      ('a NULL PIN is a miss',                     'anon',     $q$select public.desk_login(null)::text$q$, '{"ok": false}'),
      ('...counted',                               'postgres', $q$select fails::text from public.desk_pin_guard$q$, '3'),
      -- every door counts a wrong PIN exactly once (two batches, so the lock never trips mid-way)
      ('reset',                                    'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('wrong PIN: desk_get_dashboard',            'anon',     $q$select public.desk_get_dashboard('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_chat_clear',               'anon',     $q$select public.desk_chat_clear('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_chat_history',             'anon',     $q$select public.desk_chat_history('not-the-passphrase')::text$q$, '[]'),
      ('wrong PIN: desk_get_watchlists',           'anon',     $q$select public.desk_get_watchlists('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_get_system_prompt',        'anon',     $q$select public.desk_get_system_prompt('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...five doors, five misses',               'postgres', $q$select fails::text from public.desk_pin_guard$q$, '5'),
      ('reset',                                    'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('wrong PIN: desk_set_system_prompt',        'anon',     $q$select public.desk_set_system_prompt('not-the-passphrase', 'PROBE OVERWRITE')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_get_ask_schedule',         'anon',     $q$select public.desk_get_ask_schedule('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_set_ask_schedule',         'anon',     $q$select public.desk_set_ask_schedule('not-the-passphrase', '[{"prompt":"PROBE"}]'::jsonb)::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_get_ask_model',            'anon',     $q$select public.desk_get_ask_model('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('wrong PIN: desk_set_ask_model',            'anon',     $q$select public.desk_set_ask_model('not-the-passphrase', 'claude-opus-5-5')::text$q$, '{"ok": false}'),
      ('...five more doors, five misses',          'postgres', $q$select fails::text from public.desk_pin_guard$q$, '5'),
      -- the owner through every door (rolled back), nothing counted
      ('reset',                                    'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('owner: desk_get_dashboard',                'anon',     $q$select (public.desk_get_dashboard('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_chat_history',                 'anon',     $q$select jsonb_typeof(public.desk_chat_history('probe-owner-passphrase'))$q$, 'array'),
      ('owner: desk_chat_clear',                   'anon',     $q$select (public.desk_chat_clear('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_get_watchlists',               'anon',     $q$select (public.desk_get_watchlists('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_get_system_prompt',            'anon',     $q$select (public.desk_get_system_prompt('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_set_system_prompt (its own text)', 'anon', $q$select (public.desk_set_system_prompt('probe-owner-passphrase', public.desk_get_system_prompt('probe-owner-passphrase')->>'content')->>'ok')$q$, 'true'),
      ('owner: desk_get_ask_schedule',             'anon',     $q$select (public.desk_get_ask_schedule('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_set_ask_schedule (its own rows)', 'anon',  $q$select (public.desk_set_ask_schedule('probe-owner-passphrase', public.desk_get_ask_schedule('probe-owner-passphrase')->'rows')->>'ok')$q$, 'true'),
      ('owner: desk_get_ask_model',                'anon',     $q$select (public.desk_get_ask_model('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('owner: desk_set_ask_model (the stored model)', 'anon', $q$select (public.desk_set_ask_model('probe-owner-passphrase', public.desk_get_ask_model('probe-owner-passphrase')->>'model')->>'ok')$q$, 'true'),
      ('...nothing counted',                       'postgres', $q$select fails::text from public.desk_pin_guard$q$, '0'),
      -- the CI test PIN: still refused by the owner-only doors, and not a miss
      ('test PIN: desk_get_system_prompt refused', 'anon',     $q$select public.desk_get_system_prompt('probe-test-passphrase')::text$q$, '{"ok": false}'),
      ('test PIN: desk_set_system_prompt refused', 'anon',     $q$select public.desk_set_system_prompt('probe-test-passphrase', 'PROBE OVERWRITE')::text$q$, '{"ok": false}'),
      ('test PIN: desk_get_ask_schedule refused',  'anon',     $q$select public.desk_get_ask_schedule('probe-test-passphrase')::text$q$, '{"ok": false}'),
      ('test PIN: desk_set_ask_schedule refused',  'anon',     $q$select public.desk_set_ask_schedule('probe-test-passphrase', '[{"prompt":"PROBE"}]'::jsonb)::text$q$, '{"ok": false}'),
      ('test PIN: desk_get_ask_model refused',     'anon',     $q$select public.desk_get_ask_model('probe-test-passphrase')::text$q$, '{"ok": false}'),
      ('test PIN: desk_set_ask_model refused',     'anon',     $q$select public.desk_set_ask_model('probe-test-passphrase', 'claude-opus-5-5')::text$q$, '{"ok": false}'),
      ('test PIN: its own dashboard still opens',  'anon',     $q$select (public.desk_get_dashboard('probe-test-passphrase')->>'ok')$q$, 'true'),
      ('...and none of it counted',                'postgres', $q$select fails::text from public.desk_pin_guard$q$, '0'),
      -- ── the lock ──────────────────────────────────────────────────────────────────────────────
      ('nine misses so far (rolled back)',         'postgres', $q$update public.desk_pin_guard set window_start = now() - interval '30 minutes', fails = 9, locked_until = null where id = 1$q$, 'ok'),
      ('the 10th miss locks and says so',          'anon',     $q$select (public.desk_login('not-the-passphrase') ? 'locked_until')::text$q$, 'true'),
      ('...for one hour',                          'postgres', $q$select (fails = 10 and locked_until between now() + interval '59 minutes' and now() + interval '61 minutes')::text from public.desk_pin_guard$q$, 'true'),
      ('mark total_fails',                         'postgres', $q$update probe_mark set total = (select total_fails from public.desk_pin_guard)$q$, 'ok'),
      ('locked: the RIGHT PIN is refused at login, with the time', 'anon', $q$select ((public.desk_login('probe-owner-passphrase')->>'ok') || ' ' || (public.desk_login('probe-owner-passphrase') ? 'locked_until')::text)$q$, 'false true'),
      ('locked: desk_get_dashboard refuses the owner', 'anon',  $q$select public.desk_get_dashboard('probe-owner-passphrase')::text$q$, '{"ok": false}'),
      ('locked: desk_chat_history gives nothing',  'anon',     $q$select public.desk_chat_history('probe-owner-passphrase')::text$q$, '[]'),
      ('locked: desk_set_system_prompt refuses the owner', 'anon', $q$select public.desk_set_system_prompt('probe-owner-passphrase', 'PROBE OVERWRITE')::text$q$, '{"ok": false}'),
      ('locked: desk_set_ask_schedule refuses the owner', 'anon', $q$select public.desk_set_ask_schedule('probe-owner-passphrase', '[{"prompt":"PROBE"}]'::jsonb)::text$q$, '{"ok": false}'),
      ('locked: desk_set_ask_model refuses the owner', 'anon',  $q$select public.desk_set_ask_model('probe-owner-passphrase', 'claude-opus-5-5')::text$q$, '{"ok": false}'),
      ('locked: desk-ask''s door refuses the owner', 'service_role', $q$select ((public.desk_pin_who('probe-owner-passphrase')->>'ok') || ' ' || (public.desk_pin_who('probe-owner-passphrase')->>'locked_until' is not null)::text)$q$, 'false true'),
      ('locked: wrong PINs are not even counted',  'anon',     $q$select public.desk_login('not-the-passphrase')::text is not null$q$, 'true'),
      ('...the count and the lifetime total did not move', 'postgres', $q$select (fails = 10 and total_fails = (select total from probe_mark))::text from public.desk_pin_guard$q$, 'true'),
      ('the lock and the window pass (rolled back)', 'postgres', $q$update public.desk_pin_guard set window_start = now() - interval '2 hours', locked_until = now() - interval '1 second' where id = 1$q$, 'ok'),
      ('the owner gets in again',                  'anon',     $q$select (public.desk_login('probe-owner-passphrase')->>'ok')$q$, 'true'),
      ('the next miss starts a new window',        'anon',     $q$select public.desk_login('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...at 1, unlocked',                        'postgres', $q$select (fails = 1 and locked_until is null)::text from public.desk_pin_guard$q$, 'true'),
      ('nine misses 59 minutes into the window',   'postgres', $q$update public.desk_pin_guard set window_start = now() - interval '59 minutes', fails = 9, locked_until = null where id = 1$q$, 'ok'),
      ('a 10th inside the window',                 'anon',     $q$select public.desk_get_dashboard('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...locks it',                              'postgres', $q$select (fails = 10 and locked_until > now())::text from public.desk_pin_guard$q$, 'true')
    ) as t(label, as_role, stmt, want)
  loop
    n := n + 1;
    begin
      if s.as_role <> 'postgres' then execute format('set local role %I', s.as_role); end if;
      if s.stmt ~* '^\s*update ' then execute s.stmt; got := null;   -- a setup step: no row to read back
      else execute s.stmt into got; end if;
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

  -- ── read-only: what PostgREST runs a GET in. A right PIN must get an ERROR, never an answer. ──────────
  update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1;
  n := n + 1;
  begin
    set local transaction_read_only = on;
    execute 'set local role anon';
    execute $q$select public.desk_login('probe-owner-passphrase')::text$q$ into got;
    raise exception 'PROBE_ANSWERED %', got;   -- an answer: undo this sub-block and report it
  exception when others then
    got := case when sqlerrm like 'PROBE_ANSWERED%' then 'answered: ' || substr(sqlerrm, 16) else sqlstate end;
  end;
  execute 'reset role';
  steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a right PIN gets an error, not an answer', 'got', got, 'want', '25006', 'pass', got = '25006'));
  if got is distinct from '25006' then
    failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a right PIN gets an error, not an answer', 'got', got, 'want', '25006'));
  end if;

  raise exception 'PIN_LOCKOUT_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
