-- Verification probe for supabase/migrations/desk_028_sim_trades.sql — run AFTER the migration (and desk_026).
--
-- It opens, lists, closes and removes simulated trades through the doors a browser calls (as role `anon`) and reads
-- back what that did. Everything it touches rolls back: ONE DO block ending in a deliberate exception (a statement-level
-- `begin; ... rollback;` would not survive the Supabase MCP). The result is the exception text:
--
--   ERROR:  SIM_TRADES_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it on a scratch Postgres (tools/sim-trades-check.py does, against every mutant there) or on the live project with
-- the Supabase MCP execute_sql once desk_028 is applied. Live, it holds the PIN guard row for the few milliseconds it
-- runs and inserts two throwaway desk_users rows and their trades, all inside the transaction that is then aborted.
-- No statement in it starts with DELETE, DROP or TRUNCATE.
--
--   closed     no API role can read or write the table directly (42501); the doors are SECURITY DEFINER and anon-callable.
--   refusals   a wrong PIN is refused and COUNTED (desk_026); the CI test credential is refused (and not counted); a
--              locked desk refuses the right PIN and says until when; a bad symbol, side, quantity, multiplier, price,
--              a note over 500 characters and an oversized snapshot are each refused and store nothing.
--   life       the owner opens a stock trade and an option, lists them (oldest first, no user_id), closes one (once
--              only), removes one (a soft delete: the row stays, the list drops it), and cannot touch another user's.
--   read-only  an open asked in a read-only transaction (a PostgREST GET) gets an error, never an answer.
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
    (gen_random_uuid(), 'probe-other', salt, encode(extensions.digest(salt || 'probe-other-passphrase', 'sha256'), 'hex'), false),
    (gen_random_uuid(), 'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-passphrase',  'sha256'), 'hex'), true);

  for s in
    select * from (values
      -- ── closed ────────────────────────────────────────────────────────────────────────────────
      ('anon cannot read the table',               'anon',     $q$select count(*)::text from public.desk_sim_trades$q$, '42501'),
      ('authenticated cannot read the table',      'authenticated', $q$select count(*)::text from public.desk_sim_trades$q$, '42501'),
      ('service_role cannot read the table',       'service_role', $q$select count(*)::text from public.desk_sim_trades$q$, '42501'),
      ('anon cannot write the table',              'anon',     $q$insert into public.desk_sim_trades (user_id, sym, side, qty, entry) values (gen_random_uuid(), 'X', 'buy', 1, 1) returning id::text$q$, '42501'),
      ('anon cannot call the helper',              'anon',     $q$select public.desk_sim_who('probe-owner-passphrase')::text$q$, '42501'),
      ('RLS is on, no policy',                     'postgres', $q$select (c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid))::text from pg_class c where c.oid = 'public.desk_sim_trades'::regclass$q$, 'true'),
      ('the four doors are definer and anon-callable', 'postgres', $q$select bool_and(p.prosecdef and has_function_privilege('anon', p.oid, 'execute'))::text from pg_proc p where p.proname in ('desk_sim_list', 'desk_sim_open', 'desk_sim_close', 'desk_sim_remove')$q$, 'true'),
      -- ── refusals ──────────────────────────────────────────────────────────────────────────────
      ('reset the guard (rolled back)',            'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok'),
      ('a wrong PIN is refused',                   'anon',     $q$select public.desk_sim_list('not-the-passphrase')::text$q$, '{"ok": false}'),
      ('...and counted as a miss',                 'postgres', $q$select fails::text from public.desk_pin_guard$q$, '1'),
      ('a wrong PIN cannot open a trade',          'anon',     $q$select public.desk_sim_open('not-the-passphrase', 'MSFT', 'buy', 10, 1, 400, '', null)->>'ok'$q$, 'false'),
      ('the test credential is refused',           'anon',     $q$select public.desk_sim_list('probe-test-passphrase')::text$q$, '{"ok": false}'),
      ('...even to open',                          'anon',     $q$select public.desk_sim_open('probe-test-passphrase', 'MSFT', 'buy', 10, 1, 400, '', null)->>'ok'$q$, 'false'),
      ('a junk symbol is refused',                 'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'msft; drop', 'buy', 10, 1, 400, '', null)->>'error'$q$, 'The trade is not valid.'),
      ('a bad side is refused',                    'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'hold', 10, 1, 400, '', null)->>'ok'$q$, 'false'),
      ('a zero quantity is refused',               'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 0, 1, 400, '', null)->>'ok'$q$, 'false'),
      ('a multiplier of 10 is refused',            'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 1, 10, 400, '', null)->>'ok'$q$, 'false'),
      ('a negative price is refused',              'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 1, 1, -4, '', null)->>'ok'$q$, 'false'),
      ('a 501-character note is refused',          'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 1, 1, 4, repeat('n', 501), null)->>'ok'$q$, 'false'),
      ('an oversized snapshot is refused',         'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 1, 1, 4, '', jsonb_build_object('x', repeat('s', 8001)))->>'ok'$q$, 'false'),
      ('a snapshot that is not an object is refused', 'anon',  $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 1, 1, 4, '', '[1,2]'::jsonb)->>'ok'$q$, 'false'),
      ('...none of those stored a row',            'postgres', $q$select count(*)::text from public.desk_sim_trades t join public.desk_users u on u.id = t.user_id where u.label like 'probe-%'$q$, '0'),
      -- ── life ──────────────────────────────────────────────────────────────────────────────────
      ('the owner opens a stock trade',            'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'MSFT', 'buy', 100, 1, 412.5, 'Strong BUY', '{"buy": 52, "sell": 33}'::jsonb)->>'ok'$q$, 'true'),
      ('...and an option',                         'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'AMD261218C00195000', 'sell', 2, 100, 4.5, '', null)->>'ok'$q$, 'true'),
      ('another owner opens one of their own',     'anon',     $q$select public.desk_sim_open('probe-other-passphrase', 'TSLA', 'buy', 1, 1, 300, '', null)->>'ok'$q$, 'true'),
      ('note the ids (the anon role cannot read them)', 'postgres', $q$select ((set_config('probe.tsla', (select id::text from public.desk_sim_trades where sym = 'TSLA' and entry = 300), true) || set_config('probe.msft', (select id::text from public.desk_sim_trades where sym = 'MSFT' and note = 'Strong BUY'), true) || set_config('probe.amd', (select id::text from public.desk_sim_trades where sym = 'AMD261218C00195000'), true)) is not null)::text$q$, 'true'),
      ('the list holds the owner''s two, oldest first', 'anon', $q$select string_agg(x->>'sym', ',' order by o) from jsonb_array_elements(public.desk_sim_list('probe-owner-passphrase')->'trades') with ordinality as a(x, o)$q$, 'MSFT,AMD261218C00195000'),
      ('...with the snapshot and no user_id',      'anon',     $q$select ((x->'snap'->>'buy') || ' ' || (x ? 'user_id')::text) from jsonb_array_elements(public.desk_sim_list('probe-owner-passphrase')->'trades') x where x->>'sym' = 'MSFT'$q$, '52 false'),
      ('the server stamped the time',              'postgres', $q$select (opened_at = now())::text from public.desk_sim_trades where sym = 'MSFT' and note = 'Strong BUY'$q$, 'true'),
      ('the owner cannot close another''s trade',  'anon',     $q$select public.desk_sim_close('probe-owner-passphrase', current_setting('probe.tsla')::bigint, 310, null)->>'ok'$q$, 'false'),
      ('the owner cannot remove another''s trade', 'anon',     $q$select public.desk_sim_remove('probe-owner-passphrase', current_setting('probe.tsla')::bigint)->>'ok'$q$, 'false'),
      ('...it is untouched',                       'postgres', $q$select (closed_at is null and removed_at is null)::text from public.desk_sim_trades where sym = 'TSLA' and entry = 300$q$, 'true'),
      ('a bad exit price is refused',              'anon',     $q$select public.desk_sim_close('probe-owner-passphrase', current_setting('probe.msft')::bigint, 0, null)->>'ok'$q$, 'false'),
      ('the owner closes the stock trade',         'anon',     $q$select public.desk_sim_close('probe-owner-passphrase', current_setting('probe.msft')::bigint, 420, '{"buy": 40}'::jsonb)::text$q$, '{"ok": true}'),
      ('...only once',                             'anon',     $q$select public.desk_sim_close('probe-owner-passphrase', current_setting('probe.msft')::bigint, 430, null)->>'ok'$q$, 'false'),
      ('...and the list shows its exit',           'anon',     $q$select (x->>'exit') || ' ' || (x->'exit_snap'->>'buy') from jsonb_array_elements(public.desk_sim_list('probe-owner-passphrase')->'trades') x where x->>'sym' = 'MSFT'$q$, '420 40'),
      ('the owner removes the option',             'anon',     $q$select public.desk_sim_remove('probe-owner-passphrase', current_setting('probe.amd')::bigint)::text$q$, '{"ok": true}'),
      ('...the list drops it',                     'anon',     $q$select jsonb_array_length(public.desk_sim_list('probe-owner-passphrase')->'trades')::text$q$, '1'),
      ('...the row stays (a soft delete)',         'postgres', $q$select (removed_at is not null)::text from public.desk_sim_trades where sym = 'AMD261218C00195000'$q$, 'true'),
      ('...and cannot be closed after',            'anon',     $q$select public.desk_sim_close('probe-owner-passphrase', current_setting('probe.amd')::bigint, 5, null)->>'ok'$q$, 'false'),
      ('the other owner sees only theirs',         'anon',     $q$select string_agg(x->>'sym', ',') from jsonb_array_elements(public.desk_sim_list('probe-other-passphrase')->'trades') x$q$, 'TSLA'),
      -- ── the lock ──────────────────────────────────────────────────────────────────────────────
      ('lock the desk (rolled back)',              'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 10, locked_until = now() + interval '1 hour' where id = 1$q$, 'ok'),
      ('locked: the right PIN is refused and told until when', 'anon', $q$select (public.desk_sim_list('probe-owner-passphrase')->>'ok') || ' ' || (public.desk_sim_list('probe-owner-passphrase') ? 'locked_until')::text$q$, 'false true'),
      ('locked: nothing can be opened',            'anon',     $q$select public.desk_sim_open('probe-owner-passphrase', 'IBM', 'buy', 1, 1, 200, '', null)->>'ok'$q$, 'false'),
      ('unlock (rolled back)',                     'postgres', $q$update public.desk_pin_guard set window_start = now(), fails = 0, locked_until = null where id = 1$q$, 'ok')
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

  -- ── read-only: what PostgREST runs a GET in. An open must get an ERROR, never an answer. ──────────────
  n := n + 1;
  begin
    set local transaction_read_only = on;
    execute 'set local role anon';
    execute $q$select public.desk_sim_open('probe-owner-passphrase', 'IBM', 'buy', 1, 1, 200, '', null)::text$q$ into got;
    raise exception 'PROBE_ANSWERED %', got;
  exception when others then
    got := case when sqlerrm like 'PROBE_ANSWERED%' then 'answered: ' || substr(sqlerrm, 16) else sqlstate end;
  end;
  execute 'reset role';
  steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: an open gets an error, not an answer', 'got', got, 'want', '25006', 'pass', got = '25006'));
  if got is distinct from '25006' then
    failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', 'read-only: an open gets an error, not an answer', 'got', got, 'want', '25006'));
  end if;

  raise exception 'SIM_TRADES_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
