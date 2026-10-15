-- Verification probe for supabase/migrations/desk_022_chat_history_model.sql — run AFTER the migration.
--
-- It measures what the migration promises through the RPC a browser actually calls (as role `anon`, with a PIN),
-- not by reading the function's text. Everything it touches rolls back: ONE DO block ending in a deliberate
-- exception (a statement-level `begin; ... rollback;` would not survive the Supabase MCP). The result is the
-- exception text:
--
--   ERROR:  CHAT_HISTORY_MODEL_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it two ways, identically:
--   * a scratch Postgres:   psql -v ON_ERROR_STOP=0 -f tools/chat-history-model-verify.sql
--   * the live project:     the Supabase MCP execute_sql with this file's text, once the owner has approved applying
--                           desk_022. It inserts two throwaway users and six throwaway exchanges INSIDE the transaction
--                           that is then aborted. The exchanges are inserted with explicit ids (900000001...) and
--                           `overriding system value`, so even the aborted insert never advances the table's identity
--                           sequence. It holds no destructive statement at all, so the MCP has no reason to hold it.
--
-- What each group proves:
--   shape      the key set of a row is what desk_019 returned PLUS `model` — nothing taken away, so the client that is
--              live today keeps working; oldest first; a wrong PIN still gets '[]' (no existence leak).
--   owner      the owner's PIN is handed the stored model for a real provider id (Haiku, Opus — also on a SCHEDULED
--              row, which the desk-cron-ask path writes with a real model) and `null` for a null model, for the
--              Routine's 'claude-code-routine', for any other 'claude-code-…' tag and for a value that is not a claude-…
--              id at all. The Routine's rows are never labelled "Answered by".
--   test user  the CI test credential's PIN is valid but is_test: it gets its OWN rows with `model: null` — a stored
--              real model id is NOT handed to it (owner ruling C1, 2026-10-14).
--   grants     anon can still execute the RPC (the migration re-declares it; create or replace must have kept the ACL),
--              PUBLIC holds nothing on it, and it is still security definer with search_path pinned to public.
do $probe$
declare
  salt     constant text := 'probe-salt';
  v_admin  uuid := gen_random_uuid();
  v_test   uuid := gen_random_uuid();
  steps    jsonb := '[]'::jsonb;
  failed   jsonb := '[]'::jsonb;
  s        record;
  got      text;
  n        int := 0;
begin
  insert into public.desk_users (id, label, salt, pin_hash, is_test) values
    (v_admin, 'probe-admin', salt, encode(extensions.digest(salt || 'probe-admin-pin', 'sha256'), 'hex'), false),
    (v_test,  'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-pin',  'sha256'), 'hex'), true);

  -- oldest → newest, in this order: haiku typed · routine · null model · not a claude id · opus scheduled · claude-code tag
  insert into public.desk_chat_memory (id, user_id, question, answer, model, sources, created_at, origin) overriding system value values
    (900000001, v_admin, 'q-haiku',   'a', 'claude-haiku-5-5',   '[]'::jsonb, now() - interval '6 minutes', 'typed'),
    (900000002, v_admin, 'q-routine', 'a', 'claude-code-routine', '[]'::jsonb, now() - interval '5 minutes', 'scheduled'),
    (900000003, v_admin, 'q-null',    'a', null,                 '[]'::jsonb, now() - interval '4 minutes', 'typed'),
    (900000004, v_admin, 'q-other',   'a', 'gpt-something',      '[]'::jsonb, now() - interval '3 minutes', 'typed'),
    (900000005, v_admin, 'q-opus',    'a', 'claude-opus-5-5',    '[]'::jsonb, now() - interval '2 minutes', 'scheduled'),
    (900000006, v_admin, 'q-tool',    'a', 'claude-code-other',  '[]'::jsonb, now() - interval '1 minutes', 'scheduled'),
    (900000007, v_test,  'q-test',    'a', 'claude-haiku-5-5',   '[]'::jsonb, now(),                        'typed');

  for s in
    select * from (values
      -- ── shape ──────────────────────────────────────────────────────────────────────────────
      ('the owner gets all six of its exchanges, none of the test user''s',
                                          'anon', $q$select jsonb_array_length(public.desk_chat_history('probe-admin-pin'))::text$q$, '6'),
      ('a row has the desk_019 keys PLUS model, nothing removed',
                                          'anon', $q$select (select string_agg(k, ',' order by k) from jsonb_object_keys((public.desk_chat_history('probe-admin-pin'))->0) k)$q$,
                                                  'answer,created_at,id,model,origin,question,sources'),
      ('oldest first',                    'anon', $q$select (select string_agg(e->>'question', ',' order by ord) from jsonb_array_elements(public.desk_chat_history('probe-admin-pin')) with ordinality as t(e, ord))$q$,
                                                  'q-haiku,q-routine,q-null,q-other,q-opus,q-tool'),
      ('a wrong PIN still gets an empty list', 'anon', $q$select public.desk_chat_history('not-a-pin')::text$q$, '[]'),
      -- ── owner ─────────────────────────────────────────────────────────────────────────────
      ('only real provider ids carry a model: haiku, no, no, no, opus, no',
                                          'anon', $q$select (select string_agg(coalesce(e->>'model', '-'), ',' order by ord) from jsonb_array_elements(public.desk_chat_history('probe-admin-pin')) with ordinality as t(e, ord))$q$,
                                                  'claude-haiku-5-5,-,-,-,claude-opus-5-5,-'),
      ('the Routine row says model is null, not that it has no key',
                                          'anon', $q$select ((public.desk_chat_history('probe-admin-pin'))->1) ? 'model' and jsonb_typeof(((public.desk_chat_history('probe-admin-pin'))->1)->'model') = 'null'$q$, 'true'),
      -- ── test user ─────────────────────────────────────────────────────────────────────────
      ('the test credential gets its own exchange',
                                          'anon', $q$select jsonb_array_length(public.desk_chat_history('probe-test-pin'))::text$q$, '1'),
      ('...with model null: a real stored id is NOT handed to it',
                                          'anon', $q$select coalesce(((public.desk_chat_history('probe-test-pin'))->0)->>'model', '-')$q$, '-'),
      -- ── grants ────────────────────────────────────────────────────────────────────────────
      ('anon can still execute the RPC',  'postgres', $q$select has_function_privilege('anon', 'public.desk_chat_history(text)', 'execute')::text$q$, 'true'),
      ('PUBLIC holds nothing on it',      'postgres', $q$select count(*)::text from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'public.desk_chat_history(text)'::regprocedure and a.grantee = 0$q$, '0'),
      ('it is still security definer (the table has RLS and no policy)',
                                          'postgres', $q$select prosecdef::text from pg_proc where oid = 'public.desk_chat_history(text)'::regprocedure$q$, 'true'),
      ('and its search_path is still pinned to public',
                                          'postgres', $q$select coalesce(proconfig::text, '-') from pg_proc where oid = 'public.desk_chat_history(text)'::regprocedure$q$, '{search_path=public}')
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

  raise exception 'CHAT_HISTORY_MODEL_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
