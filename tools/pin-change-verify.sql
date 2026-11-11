-- Verification probe for supabase/migrations/desk_027_change_pin.sql — run AFTER the migration (and desk_026).
--
-- It changes a passphrase through the door a browser calls (as role `anon`) and reads back what that did, rather
-- than reading the functions' text. Everything it touches rolls back: ONE DO block ending in a deliberate exception
-- (a statement-level `begin; ... rollback;` would not survive the Supabase MCP). The result is the exception text:
--
--   ERROR:  PIN_CHANGE_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it on a scratch Postgres (tools/pin-change-check.py does, against every mutant there) or on the live project
-- with the Supabase MCP execute_sql once desk_027 is applied. Live, it holds the guard row for the few milliseconds
-- it runs, inserts two throwaway desk_users rows and changes ONE of them — all inside the transaction that is then
-- aborted, so the live guard and every real PIN are exactly as they were (a fingerprint of the real rows is
-- compared before and after, inside the transaction, to prove the probe never touched them). No statement in it
-- starts with DELETE, DROP or TRUNCATE, so the connector runs it without a confirmation form.
--
-- What each group proves:
--   grants     the page can call desk_change_pin (anon), SECURITY DEFINER with search_path public; no API role can
--              call desk_pin_set or desk_pin_taken; no API-callable function other than desk_pin_who touches a hash.
--   refusals   a wrong current PIN is refused and COUNTED (desk_026); the CI test credential is refused and not
--              counted; under 16, over 200, a space at either end, the same passphrase, another user's PIN and a
--              null are each refused with a reason — and none of them changed the owner's PIN.
--   change     the owner's change answers {ok:true}; the old PIN stops working at once and the new one logs in; a
--              FRESH 32-hex salt is stored; the test user's row and every real row are untouched; 16 and 200
--              characters are accepted.
--   lock       a locked desk refuses a change with the right PIN and says until when; the PIN is unchanged.
--   read-only  a change asked in a read-only transaction (a PostgREST GET) gets an error, never an answer.
do $probe$
declare
  salt     constant text := 'probe-salt';
  steps    jsonb := '[]'::jsonb;
  failed   jsonb := '[]'::jsonb;
  s        record;
  got      text;
  n        int := 0;
begin
  create temp table probe_mark (real_rows text) on commit drop;
  insert into probe_mark select coalesce(md5(string_agg(u.id::text || u.salt || u.pin_hash, ',' order by u.id)), 'none') from public.desk_users u;
  insert into public.desk_users (id, label, salt, pin_hash, is_test) values
    (gen_random_uuid(), 'probe-owner', salt, encode(extensions.digest(salt || 'probe-owner-passphrase', 'sha256'), 'hex'), false),
    (gen_random_uuid(), 'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-passphrase',  'sha256'), 'hex'), true);

  for s in
    select * from (values
      -- ── grants ────────────────────────────────────────────────────────────────────────────────
      ('anon can call desk_change_pin',            'postgres', $q$select has_function_privilege('anon', 'public.desk_change_pin(text,text)', 'execute')::text$q$, 'true'),
      ('desk_change_pin is security definer, search_path public', 'postgres', $q$select (prosecdef and proconfig::text = '{search_path=public}')::text from pg_proc where oid = 'public.desk_change_pin(text,text)'::regprocedure$q$, 'true'),
      ('no API role can call desk_pin_set',        'postgres', $q$select (has_function_privilege('anon', 'public.desk_pin_set(uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.desk_pin_set(uuid,text)', 'execute') or has_function_privilege('service_role', 'public.desk_pin_set(uuid,text)', 'execute'))::text$q$, 'false'),
      ('no API role can call desk_pin_taken',      'postgres', $q$select (has_function_privilege('anon', 'public.desk_pin_taken(uuid,text)', 'execute') or has_function_privilege('authenticated', 'public.desk_pin_taken(uuid,text)', 'execute') or has_function_privilege('service_role', 'public.desk_pin_taken(uuid,text)', 'execute'))::text$q$, 'false'),
      ('anon calling desk_pin_set is refused',     'anon',     $q$select public.desk_pin_set(gen_random_uuid(), 'probe-anything-long-enough')::text$q$, '42501'),
      ('anon calling desk_pin_taken is refused',   'anon',     $q$select public.desk_pin_taken(gen_random_uuid(), 'probe-anything-long-enough')::text$q$, '42501'),
      ('no API-callable function but desk_pin_who touches a hash', 'postgres', $q$select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like '%pin_hash%' and p.oid <> 'public.desk_pin_who(text)'::regprocedure and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))$q$, '0'),
      -- ── refusals ──────────────────────────────────────────────────────────────────────────────
      ('reset the guard (rolled back)',            'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('a wrong current PIN is refused',           'anon',     $q$select public.desk_change_pin('not-the-passphrase', 'a brand new long passphrase')::text$q$, '{"ok": false}'),
      ('...and counted as a miss',                 'postgres', $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('the test credential is refused',           'anon',     $q$select public.desk_change_pin('probe-test-passphrase', 'a brand new long passphrase')->>'error'$q$, 'Only the owner can change the passphrase.'),
      ('...and not counted',                       'postgres', $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('15 characters are refused',                'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', '123456789012345')->>'error'$q$, 'The new passphrase must be at least 16 characters.'),
      ('a null is refused',                        'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', null)->>'error'$q$, 'The new passphrase must be at least 16 characters.'),
      ('201 characters are refused',               'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', repeat('x', 201))->>'error'$q$, 'The new passphrase must be at most 200 characters.'),
      ('a space at the start is refused',          'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', ' a brand new long passphrase')->>'error'$q$, 'The new passphrase cannot start or end with a space.'),
      ('a space at the end is refused',            'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', 'a brand new long passphrase ')->>'error'$q$, 'The new passphrase cannot start or end with a space.'),
      ('the same passphrase is refused',           'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', 'probe-owner-passphrase')->>'error'$q$, 'The new passphrase is the same as the current one.'),
      ('another user''s PIN is refused',           'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', 'probe-test-passphrase')->>'error'$q$, 'Choose a different passphrase.'),
      ('...none of those changed the owner''s PIN', 'anon',    $q$select public.desk_login('probe-owner-passphrase')->>'ok'$q$, 'true'),
      -- ── change ────────────────────────────────────────────────────────────────────────────────
      ('the owner changes it',                     'anon',     $q$select public.desk_change_pin('probe-owner-passphrase', 'a brand new long passphrase')::text$q$, '{"ok": true}'),
      ('the old PIN stops working at once',        'anon',     $q$select public.desk_login('probe-owner-passphrase')::text$q$, '{"ok": false}'),
      ('the new one logs in as the owner',         'anon',     $q$select public.desk_login('a brand new long passphrase')->>'label'$q$, 'probe-owner'),
      ('...and desk-ask''s helper agrees',         'service_role', $q$select (public.desk_pin_who('a brand new long passphrase')->>'is_test')$q$, 'false'),
      ('a fresh 32-hex salt was stored',           'postgres', $q$select (salt ~ '^[0-9a-f]{32}$' and salt <> 'probe-salt')::text from public.desk_users where label = 'probe-owner'$q$, 'true'),
      ('the test user is untouched',               'postgres', $q$select (salt = 'probe-salt' and pin_hash = encode(extensions.digest('probe-salt' || 'probe-test-passphrase', 'sha256'), 'hex'))::text from public.desk_users where label = 'probe-test'$q$, 'true'),
      ('every real row is untouched',              'postgres', $q$select (coalesce(md5(string_agg(id::text || salt || pin_hash, ',' order by id)), 'none') = (select real_rows from probe_mark))::text from public.desk_users where label not in ('probe-owner', 'probe-test')$q$, 'true'),
      ('exactly 16 characters are accepted',       'anon',     $q$select public.desk_change_pin('a brand new long passphrase', '0123456789abcdef')::text$q$, '{"ok": true}'),
      ('exactly 200 characters are accepted',      'anon',     $q$select public.desk_change_pin('0123456789abcdef', repeat('y', 199) || 'z')::text$q$, '{"ok": true}'),
      ('...and log in',                            'anon',     $q$select public.desk_login(repeat('y', 199) || 'z')->>'ok'$q$, 'true'),
      ('a space inside is fine',                   'anon',     $q$select public.desk_change_pin(repeat('y', 199) || 'z', 'correct horse battery staple')::text$q$, '{"ok": true}'),
      ('every salt it stored was fresh',           'postgres', $q$select (salt ~ '^[0-9a-f]{32}$')::text from public.desk_users where label = 'probe-owner'$q$, 'true'),
      -- ── the lock ──────────────────────────────────────────────────────────────────────────────
      ('lock the desk (rolled back)',              'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 10, locked_until = now() + interval '1 hour' where id = 1$q$, 'ok'),
      ('locked: the right PIN cannot change it, and says until when', 'anon', $q$select ((public.desk_change_pin('correct horse battery staple', 'another long passphrase!')->>'ok') || ' ' || (public.desk_change_pin('correct horse battery staple', 'another long passphrase!') ? 'locked_until')::text)$q$, 'false true'),
      ('unlock (rolled back)',                     'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('...the PIN did not change while locked',   'anon',     $q$select public.desk_login('correct horse battery staple')->>'ok'$q$, 'true')
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

  -- ── read-only: what PostgREST runs a GET in. A change must get an ERROR, never an answer. ──────────────
  n := n + 1;
  begin
    set local transaction_read_only = on;
    execute 'set local role anon';
    execute $q$select public.desk_change_pin('correct horse battery staple', 'another long passphrase!')::text$q$ into got;
    raise exception 'PROBE_ANSWERED %', got;   -- an answer: undo this sub-block and report it
  exception when others then
    got := case when sqlerrm like 'PROBE_ANSWERED%' then 'answered: ' || substr(sqlerrm, 16) else sqlstate end;
  end;
  execute 'reset role';
  steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a change gets an error, not an answer', 'got', got, 'want', '25006', 'pass', got = '25006'));
  if got is distinct from '25006' then
    failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a change gets an error, not an answer', 'got', got, 'want', '25006'));
  end if;

  raise exception 'PIN_CHANGE_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
