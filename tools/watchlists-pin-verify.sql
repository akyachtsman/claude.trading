-- Verification probe for supabase/migrations/desk_029_watchlists_pin.sql — run AFTER the migration (and desk_026).
--
-- It reads and writes the watchlist roster through the doors a browser calls (as role `anon`) and reads back what that
-- did. Everything it touches rolls back: ONE DO block ending in a deliberate exception (a statement-level
-- `begin; ... rollback;` would not survive the Supabase MCP). The result is the exception text:
--
--   ERROR:  WATCHLISTS_PIN_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it on a scratch Postgres (tools/watchlists-pin-check.py does, against every mutant there) or on the live project
-- with the Supabase MCP execute_sql once desk_029 is applied. Live, it holds the PIN guard row and the roster table's
-- lock for the few milliseconds it runs, inserts three throwaway desk_users rows and replaces the roster, all inside the
-- transaction that is then aborted. No statement in it starts with DELETE, DROP or TRUNCATE.
--
--   closed     the browser roles can no longer call the open reader or writer (42501); service_role still can.
--   refusals   a wrong PIN is refused and COUNTED (desk_026) and writes nothing; the CI test credential may READ but
--              never write; a locked desk refuses the right PIN and says until when.
--   life       the owner reads (with a version), writes a roster with that version, reads it back normalised, and a
--              write naming a version the roster does not have is refused as a conflict (one transaction cannot move the
--              version: updated_at is now(), the transaction's start).
--   read-only  a write asked in a read-only transaction (a PostgREST GET) gets an error, never an answer.
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

  for s in
    select * from (values
      -- ── closed ────────────────────────────────────────────────────────────────────────────────
      ('anon cannot read through the open door',     'anon',          $q$select public.desk_get_watchlists_open()::text$q$, '42501'),
      ('authenticated cannot read through it',       'authenticated', $q$select public.desk_get_watchlists_open()::text$q$, '42501'),
      ('anon cannot write through the open door',    'anon',          $q$select public.desk_set_watchlists_open('[]'::jsonb, null)::text$q$, '42501'),
      ('authenticated cannot write through it',      'authenticated', $q$select public.desk_set_watchlists_open('[]'::jsonb, null)::text$q$, '42501'),
      ('service_role still reads the open door',     'service_role',  $q$select (public.desk_get_watchlists_open()->>'ok')$q$, 'true'),
      ('anon reads no row of the table (RLS)',       'anon',          $q$select count(*)::text from public.desk_watchlists$q$, '0'),
      ('anon cannot call the PIN helper',            'anon',          $q$select public.desk_pin_who('probe-owner-passphrase')::text$q$, '42501'),
      ('the two PIN doors are definer and anon-callable', 'postgres', $q$select (count(*) = 2 and bool_and(p.prosecdef and has_function_privilege('anon', p.oid, 'execute')))::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('desk_get_watchlists_pin', 'desk_set_watchlists_pin')$q$, 'true'),
      -- ── a known roster to start from (rolled back) ────────────────────────────────────────────
      ('seed the roster (rolled back)',              'postgres',      $q$select (public.desk_set_watchlists_open('[{"title":"Seed","symbols":["SPY"]}]'::jsonb, null)->>'ok')$q$, 'true'),
      -- ── refusals ──────────────────────────────────────────────────────────────────────────────
      ('reset the guard (rolled back)',              'postgres',      $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('a wrong PIN cannot read',                    'anon',          $q$select public.desk_get_watchlists_pin('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...and it is counted as a miss',             'postgres',      $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('a wrong PIN cannot write',                   'anon',          $q$select public.desk_set_watchlists_pin('not-the-passphrase', '[]'::jsonb, null)::text$q$, '{"ok": false}'),
      ('...and is counted too',                      'postgres',      $q$select fails::text from public.desk_pin_guard$q$, '2'),
      ('...and the roster is untouched',             'postgres',      $q$select string_agg(title, ',' order by pos) from public.desk_watchlists$q$, 'Seed'),
      ('no PIN at all cannot read',                  'anon',          $q$select (public.desk_get_watchlists_pin(null)->>'ok')$q$, 'false'),
      ('the test credential may read',               'anon',          $q$select (public.desk_get_watchlists_pin('probe-test-passphrase')->'lists'->0->>'title')$q$, 'Seed'),
      ('the test credential cannot write',           'anon',          $q$select public.desk_set_watchlists_pin('probe-test-passphrase', '[]'::jsonb, null)->>'error'$q$, 'Only the owner can change the watchlists.'),
      ('...and the roster is still untouched',       'postgres',      $q$select string_agg(title, ',' order by pos) from public.desk_watchlists$q$, 'Seed'),
      -- ── life ──────────────────────────────────────────────────────────────────────────────────
      ('the owner reads, with a version',            'anon',          $q$select (set_config('probe.v', public.desk_get_watchlists_pin('probe-owner-passphrase')->>'version', true) is not null)::text$q$, 'true'),
      ('the owner writes with that version',         'anon',          $q$select (public.desk_set_watchlists_pin('probe-owner-passphrase', '[{"title":"Probe","symbols":["aapl"," msft ","!!"]},{"title":"Two","symbols":[]}]'::jsonb, current_setting('probe.v')::timestamptz)->>'ok')$q$, 'true'),
      ('...and reads it back, normalised',           'anon',          $q$select string_agg((x->>'title') || ':' || (x->'symbols')::text, ' ' order by o) from jsonb_array_elements(public.desk_get_watchlists_pin('probe-owner-passphrase')->'lists') with ordinality as a(x, o)$q$, 'Probe:["AAPL", "MSFT"] Two:[]'),
      ('a write naming another version is a conflict', 'anon',       $q$select public.desk_set_watchlists_pin('probe-owner-passphrase', '[]'::jsonb, '2000-01-01T00:00:00Z'::timestamptz)->>'error'$q$, 'conflict'),
      ('...and wrote nothing',                       'postgres',      $q$select count(*)::text from public.desk_watchlists$q$, '2'),
      -- ── the lock ──────────────────────────────────────────────────────────────────────────────
      ('lock the desk (rolled back)',                'postgres',      $q$update public.desk_pin_guard set window_start = now(), fails = 10, locked_until = now() + interval '1 hour' where id = 1$q$, 'ok'),
      ('locked: the owner cannot read, and is told until when', 'anon', $q$select (public.desk_get_watchlists_pin('probe-owner-passphrase')->>'ok') || ' ' || (public.desk_get_watchlists_pin('probe-owner-passphrase') ? 'locked_until')::text$q$, 'false true'),
      ('locked: the owner cannot write',             'anon',          $q$select (public.desk_set_watchlists_pin('probe-owner-passphrase', '[]'::jsonb, null) ? 'locked_until')::text$q$, 'true'),
      ('...and the roster is unchanged',             'postgres',      $q$select count(*)::text from public.desk_watchlists$q$, '2'),
      ('unlock (rolled back)',                       'postgres',      $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok')
    ) as t(label, as_role, stmt, want)
  loop
    n := n + 1;
    begin
      if s.as_role <> 'postgres' then execute format('set local role %I', s.as_role); end if;
      if s.stmt ~* '^\s*update ' then execute s.stmt; got := null;
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

  -- ── read-only: what PostgREST runs a GET in. A write must get an ERROR, never an answer. ──────────────
  n := n + 1;
  begin
    set local transaction_read_only = on;
    execute 'set local role anon';
    execute $q$select public.desk_set_watchlists_pin('probe-owner-passphrase', '[]'::jsonb, null)::text$q$ into got;
    raise exception 'PROBE_ANSWERED %', got;
  exception when others then
    got := case when sqlerrm like 'PROBE_ANSWERED%' then 'answered: ' || substr(sqlerrm, 16) else sqlstate end;
  end;
  execute 'reset role';
  steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a write gets an error, not an answer', 'got', got, 'want', '25006', 'pass', got = '25006'));
  if got is distinct from '25006' then
    failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: a write gets an error, not an answer', 'got', got, 'want', '25006'));
  end if;

  raise exception 'WATCHLISTS_PIN_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
