-- Verification probe for supabase/migrations/desk_021_ask_model_tier.sql — run AFTER the migration.
--
-- It measures what the migration promises and probes the DENIALS (the sqlstate a caller actually
-- gets), not whether a policy or a grant line exists. Everything it touches rolls back: it is ONE
-- DO block that ends in a deliberate exception, and a statement-level `begin; ...; rollback;` would
-- not survive the Supabase MCP, so the abort is the guarantee. The result is the exception text:
--
--   ERROR:  ASK_MODEL_TIER_PROBE {"all_pass": true, "failed": [], "steps": [...]}
--
-- Run it two ways, identically:
--   * a scratch Postgres:   psql -v ON_ERROR_STOP=0 -f tools/ask-model-tier-verify.sql
--   * the live project:     the Supabase MCP execute_sql, with this file's text, once the owner has
--                           approved applying desk_021 (it inserts two throwaway users, inside the
--                           transaction that is then aborted, and temporarily removes the row for
--                           the "no row" steps — also rolled back).
--
-- What each group proves (the traps from the owner's brief, 2026-10-14, are named):
--   privileges   RLS is on and there is NO policy; the ONLY privilege any caller role holds on the
--                table is service_role SELECT (the project default also gives service_role INSERT and
--                the privilege to empty the table — the revoke has to remove them).
--   denials      anon / authenticated / service_role are refused 42501 for every write and (for the
--                first two) the read; the RPCs are callable by anon only; the trigger function is not.
--   rpc          wrong PIN and the TEST user's PIN are refused by BOTH RPCs (the admin predicate is
--                repeated in each); the admin reads and writes; NULL and an unknown model are refused
--                with 'unknown model' by the RPC itself (NULL raises 23502, not 23514, at the table).
--   stamps       a writer's own updated_by / updated_at are overwritten by the trigger; an update
--                after set_config('desk.actor','',true) works (a pooled connection answers '' not NULL
--                and ''::uuid raises 22P02); the RPC stamps the admin's id.
--   constraints  a second row (id = false) and an out-of-list model are refused by the table itself.
--   no row       with the row removed: get answers model null, set answers 'no row' (it never inserts).
do $probe$
declare
  salt       constant text := 'probe-salt';
  v_admin    uuid := gen_random_uuid();
  v_test     uuid := gen_random_uuid();
  steps      jsonb := '[]'::jsonb;
  failed     jsonb := '[]'::jsonb;
  s          record;
  got        text;
  n          int := 0;
  v_start    text;
begin
  select model into v_start from public.desk_ask_model;   -- what the row says before anything is probed
  insert into public.desk_users (id, label, salt, pin_hash, is_test) values
    (v_admin, 'probe-admin', salt, encode(extensions.digest(salt || 'probe-admin-pin', 'sha256'), 'hex'), false),
    (v_test,  'probe-test',  salt, encode(extensions.digest(salt || 'probe-test-pin',  'sha256'), 'hex'), true);

  for s in
    select * from (values
      -- ── privileges ────────────────────────────────────────────────────────────
      ('rls is on',                       'postgres', $q$select relrowsecurity::text from pg_class where oid = 'public.desk_ask_model'::regclass$q$, 'true'),
      ('there is no policy',              'postgres', $q$select count(*)::text from pg_policies where schemaname = 'public' and tablename = 'desk_ask_model'$q$, '0'),
      ('the only privilege any caller role holds',
                                          'postgres', $q$select coalesce(string_agg(r || ':' || p, ',' order by r, p), '') from unnest(array['anon','authenticated','service_role']) r, unnest(array['select','insert','update','delete','truncate','references','trigger']) p where has_table_privilege(r, 'public.desk_ask_model', p)$q$, 'service_role:select'),
      ('no column privilege either',      'postgres', $q$select count(*)::text from information_schema.column_privileges where table_name = 'desk_ask_model' and grantee in ('anon','authenticated','service_role') and privilege_type <> 'SELECT'$q$, '0'),
      ('both RPCs are SECURITY DEFINER with an empty search_path', 'postgres',
         $q$select (count(*) = 2 and bool_and(prosecdef) and bool_and(proconfig = array['search_path=""']))::text from pg_proc where oid in ('public.desk_get_ask_model(text)'::regprocedure, 'public.desk_set_ask_model(text,text)'::regprocedure)$q$, 'true'),
      ('the stamp trigger function is SECURITY INVOKER with an empty search_path', 'postgres',
         $q$select (not prosecdef and proconfig = array['search_path=""'])::text from pg_proc where oid = 'public.desk_ask_model_stamp()'::regprocedure$q$, 'true'),
      ('the stamp trigger exists, before update, per row', 'postgres',
         $q$select count(*)::text from pg_trigger where tgrelid = 'public.desk_ask_model'::regclass and not tgisinternal and tgname = 'desk_ask_model_stamp' and (tgtype & 2) = 2 and (tgtype & 16) = 16 and (tgtype & 1) = 1$q$, '1'),
      -- ── denials (the sqlstate a caller actually gets) ─────────────────────────
      ('anon cannot read',                'anon',          'select count(*)::text from public.desk_ask_model', '42501'),
      ('anon cannot insert',              'anon',          $q$insert into public.desk_ask_model (id, model) values (false, 'claude-haiku-5-5')$q$, '42501'),
      ('anon cannot update',              'anon',          $q$update public.desk_ask_model set model = 'claude-haiku-5-5' where id$q$, '42501'),
      ('anon cannot remove the row',      'anon',          'delete from public.desk_ask_model where id', '42501'),
      ('anon cannot empty the table',     'anon',          'truncate public.desk_ask_model', '42501'),
      ('authenticated cannot read',       'authenticated', 'select count(*)::text from public.desk_ask_model', '42501'),
      ('authenticated cannot update',     'authenticated', $q$update public.desk_ask_model set model = 'claude-haiku-5-5' where id$q$, '42501'),
      ('authenticated cannot insert',     'authenticated', $q$insert into public.desk_ask_model (id, model) values (false, 'claude-haiku-5-5')$q$, '42501'),
      ('authenticated cannot remove the row', 'authenticated', 'delete from public.desk_ask_model where id', '42501'),
      ('authenticated cannot empty the table', 'authenticated', 'truncate public.desk_ask_model', '42501'),
      ('service_role CAN read (desk-ask does)', 'service_role', 'select count(*)::text from public.desk_ask_model', '1'),
      ('service_role cannot insert',      'service_role',  $q$insert into public.desk_ask_model (id, model) values (false, 'claude-haiku-5-5')$q$, '42501'),
      ('service_role cannot update',      'service_role',  $q$update public.desk_ask_model set model = 'claude-haiku-5-5' where id$q$, '42501'),
      ('service_role cannot remove the row', 'service_role', 'delete from public.desk_ask_model where id', '42501'),
      ('service_role cannot empty the table', 'service_role', 'truncate public.desk_ask_model', '42501'),
      ('anon can call the getter',        'anon',          $q$select (public.desk_get_ask_model('nobody')->>'ok')$q$, 'false'),
      ('anon can call the setter',        'anon',          $q$select (public.desk_set_ask_model('nobody', 'claude-haiku-5-5')->>'ok')$q$, 'false'),
      ('authenticated cannot call the getter', 'authenticated', $q$select public.desk_get_ask_model('x')::text$q$, '42501'),
      ('authenticated cannot call the setter', 'authenticated', $q$select public.desk_set_ask_model('x', 'claude-haiku-5-5')::text$q$, '42501'),
      ('service_role cannot call the getter',  'service_role',  $q$select public.desk_get_ask_model('x')::text$q$, '42501'),
      ('service_role cannot call the setter',  'service_role',  $q$select public.desk_set_ask_model('x', 'claude-haiku-5-5')::text$q$, '42501'),
      ('anon cannot call the stamp function',  'anon',          'select public.desk_ask_model_stamp()::text', '42501'),
      -- ── the RPCs, called the way the browser calls them (anon) ────────────────
      ('getter: wrong PIN is refused',    'anon', $q$select (public.desk_get_ask_model('wrong')->>'ok')$q$, 'false'),
      ('getter: the TEST user''s PIN is refused', 'anon', $q$select (public.desk_get_ask_model('probe-test-pin')->>'ok')$q$, 'false'),
      ('getter: NULL PIN is refused',     'anon', $q$select (public.desk_get_ask_model(null)->>'ok')$q$, 'false'),
      ('setter: wrong PIN is refused',    'anon', $q$select (public.desk_set_ask_model('wrong', 'claude-haiku-5-5')->>'ok')$q$, 'false'),
      ('setter: the TEST user''s PIN is refused', 'anon', $q$select (public.desk_set_ask_model('probe-test-pin', 'claude-haiku-5-5')->>'ok')$q$, 'false'),
      ('the refused setters changed nothing', 'postgres', format($q$select (model = %L and updated_by is null)::text from public.desk_ask_model$q$, v_start), 'true'),
      ('getter: the admin reads',         'anon', $q$select (public.desk_get_ask_model('probe-admin-pin')->>'ok')$q$, 'true'),
      ('getter: and gets a model in the list', 'anon', $q$select (public.desk_get_ask_model('probe-admin-pin')->>'model') in ('claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5')$q$, 'true'),
      ('setter: the admin writes sonnet', 'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', 'claude-sonnet-5-5')->>'model')$q$, 'claude-sonnet-5-5'),
      ('the row now says sonnet',         'postgres', 'select model from public.desk_ask_model', 'claude-sonnet-5-5'),
      ('setter: unknown model is refused by the RPC itself', 'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', 'gpt-4')->>'error')$q$, 'unknown model'),
      ('setter: NULL is refused by the RPC itself',          'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', null)->>'error')$q$, 'unknown model'),
      ('setter: an empty string is refused',                 'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', '')->>'error')$q$, 'unknown model'),
      ('the refused values changed nothing', 'postgres', 'select model from public.desk_ask_model', 'claude-sonnet-5-5'),
      ('setter: haiku',                   'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', 'claude-haiku-5-5')->>'model')$q$, 'claude-haiku-5-5'),
      ('setter: opus',                    'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', 'claude-opus-5-5')->>'model')$q$, 'claude-opus-5-5'),
      -- ── stamps ────────────────────────────────────────────────────────────────
      ('the RPC stamped the admin''s id', 'postgres', format($q$select (updated_by = %L::uuid)::text from public.desk_ask_model$q$, v_admin), 'true'),
      ('a stamp is set by the trigger: a forged updated_by / updated_at is overwritten', 'postgres',
         $q$with u as (update public.desk_ask_model set model = 'claude-opus-5-5', updated_by = gen_random_uuid(), updated_at = '2000-01-01' where id returning updated_by, updated_at) select (updated_by is null and updated_at > '2020-01-01')::text from u$q$, 'true'),
      ('a manual update after the RPC works and names nobody (the actor was reset)', 'postgres',
         $q$with u as (update public.desk_ask_model set model = 'claude-opus-5-5' where id returning updated_by) select (updated_by is null)::text from u$q$, 'true'),
      ('set the actor GUC to the empty string, as a pooled connection leaves it', 'postgres', $q$select set_config('desk.actor', '', true)$q$, ''),
      ('a manual update with the actor GUC at the empty string works (no 22P02)', 'postgres',
         $q$with u as (update public.desk_ask_model set model = 'claude-opus-5-5' where id returning updated_by) select (updated_by is null)::text from u$q$, 'true'),
      -- ── constraints, from the owner role (no grant is involved) ───────────────
      ('a second row (id = false) is refused',   'postgres', $q$insert into public.desk_ask_model (id, model) values (false, 'claude-haiku-5-5')$q$, '23514'),
      ('an out-of-list model is refused',        'postgres', $q$update public.desk_ask_model set model = 'gpt-4' where id$q$, '23514'),
      ('a NULL model is refused (not null)',     'postgres', $q$update public.desk_ask_model set model = null where id$q$, '23502'),
      ('a second row with id = true is refused', 'postgres', $q$insert into public.desk_ask_model (id, model) values (true, 'claude-haiku-5-5')$q$, '23505'),
      ('the table holds exactly one row',        'postgres', 'select count(*)::text from public.desk_ask_model', '1'),
      -- ── with no row (the row is removed inside this aborted transaction) ──────
      ('setup: remove the row',           'postgres', $q$with d as (delete from public.desk_ask_model where id returning 1) select count(*)::text from d$q$, '1'),
      ('getter with no row: ok, model null', 'anon', $q$select (public.desk_get_ask_model('probe-admin-pin')->>'ok') || ':' || coalesce(public.desk_get_ask_model('probe-admin-pin')->>'model', 'null')$q$, 'true:null'),
      ('setter with no row: refused, it never inserts', 'anon', $q$select (public.desk_set_ask_model('probe-admin-pin', 'claude-haiku-5-5')->>'error')$q$, 'no row'),
      ('still no row after the setter',   'postgres', 'select count(*)::text from public.desk_ask_model', '0')
    ) as t(label, as_role, stmt, want)
  loop
    n := n + 1;
    begin
      if s.as_role <> 'postgres' then execute format('set local role %I', s.as_role); end if;
      execute s.stmt into got;
      if got is null then got := 'ok'; end if;   -- a statement with no result (DML) that did not raise
    exception when others then
      got := sqlstate;
    end;
    execute 'reset role';
    -- a statement that returns nothing and did not raise counts as 'ok'
    steps := steps || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'role', s.as_role, 'got', got, 'want', s.want, 'pass', got is not distinct from s.want));
    if got is distinct from s.want then
      failed := failed || jsonb_build_array(jsonb_build_object('n', n, 'step', s.label, 'got', got, 'want', s.want));
    end if;
  end loop;

  raise exception 'ASK_MODEL_TIER_PROBE %', jsonb_build_object('all_pass', jsonb_array_length(failed) = 0, 'steps_run', n, 'failed', failed, 'steps', steps)::text;
end
$probe$;
