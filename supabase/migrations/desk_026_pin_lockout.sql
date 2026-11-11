-- desk_026 — a server-side lockout on every PIN door (owner: "Go ahead as written", 2026-11-11, on the
-- plan from chat.GIT's read-only security review of 2026-11-10: "No failed-attempt limit ... the PIN is
-- brute-forceable").
--
-- Before this, each of the twelve PIN functions re-hashed the PIN itself and nothing counted a miss, so
-- anyone with the public anon key could try PINs as fast as PostgREST answered. Now there is ONE place a
-- PIN is checked, public.desk_pin_who(pin), and every door goes through it:
--
--   * one guard row (public.desk_pin_guard) counts misses for the WHOLE desk in a fixed 1-hour window;
--   * the 10th miss in a window shuts every door for 1 hour from that miss — the right PIN included, or a
--     guess made during the lock would still say whether it was right;
--   * a success does NOT reset the count (the CI test login on every deploy would otherwise hand an
--     attacker a fresh allowance); misses only age out with the window;
--   * while locked nothing is hashed and nothing is counted;
--   * the helper takes the guard row FOR UPDATE before anything else. That makes attempts run one at a
--     time (a burst of parallel guesses cannot all read "9 so far"), and Postgres refuses FOR UPDATE in a
--     read-only transaction — which is what PostgREST runs a GET in — so no door can be asked a PIN in a
--     way that is not counted (a success writes nothing, so without the row lock a read-only call would
--     answer a right guess and only ever fail on a wrong one).
--
-- The doors: desk_login, desk_get_dashboard, desk_chat_history, desk_chat_clear, desk_get_watchlists,
-- desk_get_system_prompt, desk_set_system_prompt, desk_get_ask_schedule, desk_set_ask_schedule,
-- desk_get_ask_model, desk_set_ask_model — each keeps its body, signature, ACL, SECURITY DEFINER and
-- search_path; only its own hash lookup is swapped for the helper (the owner-only ones keep refusing the
-- CI test user, desk_021 / desk_024). desk_login also says until when the desk is locked
-- (`locked_until`), so the lock panel can say so. The legacy desk_set_watchlists(pin, jsonb) — called by
-- nothing since desk_012 moved the page to desk_set_watchlists_open — loses EXECUTE for every API role
-- instead of being rewritten: one door fewer. desk-ask (v33) asks the helper through the service key
-- instead of reading desk_users itself, so it counts and obeys the lock as well.
--
-- Accepted trade-off (in the plan the owner approved): the lock is for the whole desk — a wrong PIN
-- matches no user and the database cannot reliably tell callers apart — so 10 wrong PINs an hour keep the
-- owner's accounts locked. The way out is to wait the hour, or (owner approval) the one statement under
-- "unlock" below. The morning scan, the scheduled questions (cron secret) and open Ask do not use a PIN.
--
-- Body text: each function below is the LIVE definition read with pg_get_functiondef on 2026-11-11 with
-- only the PIN lookup changed (the live text of four of them had CRLF line ends from the SQL Editor;
-- written here with LF). The previous definitions are kept verbatim in tools/fixtures/desk_026_revert.sql.
--
-- Apply: this file contains statements that start with `delete` (inside desk_set_ask_schedule's body),
-- so the Supabase connector's destructive-SQL check stops it in a project thread (CLAUDE.md -> Applying a
-- migration). It goes to the owner as one line for a claude.ai chat with the Supabase connector, applied
-- with apply_migration WITHOUT the begin/commit lines (the tool wraps its own transaction). The DO block
-- at the end refuses to commit unless every door goes through the helper and the grants are as below.
--
-- Verify after applying: tools/pin-lockout-verify.sql (one DO block that always rolls back; every step
-- must pass). Proven first on a scratch Postgres by tools/pin-lockout-check.py: the probe, a 30-way burst,
-- a read-only call, and every mutant listed there caught.
--
-- unlock (owner approval): update public.desk_pin_guard set fails = 0, locked_until = null where id = 1;
--
-- revert: run tools/fixtures/desk_026_revert.sql (the eleven previous definitions, verbatim, and EXECUTE
--   on desk_set_watchlists back to anon, authenticated, service_role); then drop function
--   public.desk_pin_who(text); drop table public.desk_pin_guard — redeploy desk-ask v32 FIRST, or
--   every PIN question to desk-ask fails while v33 calls a helper that is gone.

begin;

-- ── the guard ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.desk_pin_guard (
  id            smallint    primary key default 1 check (id = 1),
  window_start  timestamptz not null default now(),
  fails         integer     not null default 0,
  locked_until  timestamptz,
  last_fail_at  timestamptz,
  total_fails   bigint      not null default 0
);
alter table public.desk_pin_guard enable row level security;   -- and no policy: nobody reads it through the API
revoke all on table public.desk_pin_guard from public, anon, authenticated, service_role;
insert into public.desk_pin_guard (id) values (1) on conflict (id) do nothing;

-- ── the one PIN check ────────────────────────────────────────────────────────────────────────────────
-- {ok:true, id, is_test} for a PIN that matches a desk_users row while the desk is not locked; otherwise
-- {ok:false, locked_until} (null unless the desk is locked now). Callable by the other PIN functions (they
-- run as its owner) and by service_role (desk-ask) — never by a browser role.
create or replace function public.desk_pin_who(pin text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  g       public.desk_pin_guard;
  v_id    uuid;
  v_test  boolean;
  v_lock  timestamptz;
begin
  -- FIRST, before any hashing: one attempt at a time, and a read-only call fails here
  select * into g from public.desk_pin_guard where id = 1 for update;
  if not found then
    raise exception 'desk_pin_guard row missing';
  end if;
  if g.locked_until > now() then
    return jsonb_build_object('ok', false, 'locked_until', g.locked_until);
  end if;

  select u.id, u.is_test into v_id, v_test
    from public.desk_users u
   where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'is_test', v_test);
  end if;

  if g.window_start <= now() - interval '1 hour' then
    g.window_start := now();
    g.fails := 0;
  end if;
  g.fails := g.fails + 1;
  v_lock := case when g.fails >= 10 then now() + interval '1 hour' end;
  update public.desk_pin_guard
     set window_start = g.window_start,
         fails        = g.fails,
         locked_until = v_lock,
         last_fail_at = now(),
         total_fails  = total_fails + 1
   where id = 1;
  return jsonb_build_object('ok', false, 'locked_until', v_lock);
end;
$function$;
revoke all on function public.desk_pin_who(text) from public, anon, authenticated, service_role;
grant execute on function public.desk_pin_who(text) to service_role;

-- ── the doors ────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.desk_login(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with w as (select public.desk_pin_who(pin) as j)
  select case when (w.j->>'ok')::boolean
    then coalesce(
      (select jsonb_build_object('ok', true, 'label', u.label)
         from public.desk_users u
        where u.id = (w.j->>'id')::uuid),
      jsonb_build_object('ok', false))
    else jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w.j->'locked_until'))
  end
  from w;
$function$;

create or replace function public.desk_get_dashboard(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
  ),
  latest as (
    select distinct on (s.account_key) s.account_key, s.label, s.as_of,
           s.nav, s.day_pnl, s.total_unrl, s.cash, s.positions, s.created_at
    from public.desk_account_snapshots s, me
    where s.user_id = me.id
    order by s.account_key, s.as_of desc
  ),
  equity as (
    select account_key, as_of, nav from (
      select e.account_key, e.as_of, e.nav,
             row_number() over (partition by e.account_key order by e.as_of desc) rn
      from public.desk_equity_history e, me
      where e.user_id = me.id
    ) t where rn <= 400
  ),
  brief as (
    select b.as_of, b.generated_at, b.model, b.content
    from public.desk_ai_briefs b, me
    where b.user_id = me.id
    order by b.as_of desc limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object(
      'ok', true,
      'accounts', coalesce((select jsonb_agg(to_jsonb(l) order by l.account_key) from latest l), '[]'::jsonb),
      'equity', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_key', e.account_key, 'as_of', e.as_of, 'nav', e.nav)
                  order by e.as_of) from equity e), '[]'::jsonb),
      'brief', (select to_jsonb(b) from brief b))
  end;
$function$;

create or replace function public.desk_chat_clear(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
  ),
  del as (
    delete from public.desk_chat_memory c
    using me
    where c.user_id = me.id
    returning c.id
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'cleared', (select count(*) from del))
  end;
$function$;

create or replace function public.desk_chat_history(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id, (w.j->>'is_test')::boolean as is_test
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
  ),
  recent as (
    select c.id, c.question, c.answer, c.sources, c.created_at, c.origin,
           case when not me.is_test
                 and c.model like 'claude-%'
                 and c.model not like 'claude-code-%'
                then c.model end as model
    from public.desk_chat_memory c, me
    where c.user_id = me.id
    order by c.created_at desc
    limit 40
  )
  select coalesce(
    (select jsonb_agg(to_jsonb(r) order by r.created_at asc) from recent r),
    '[]'::jsonb);
$function$;

create or replace function public.desk_get_watchlists(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'title', w.title, 'symbols', to_jsonb(w.symbols),
               'updatedAt', w.updated_at)
             order by w.pos, w.id)
      from public.desk_watchlists w
    ), '[]'::jsonb))
  end;
$function$;

create or replace function public.desk_get_system_prompt(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
       and not (w.j->>'is_test')::boolean
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else (
      select jsonb_build_object('ok', true, 'content', s.content, 'updatedAt', s.updated_at)
      from public.desk_system_prompt s
      where s.id = true
    )
  end;
$function$;

create or replace function public.desk_set_system_prompt(pin text, new_content text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
       and not (w.j->>'is_test')::boolean
  ),
  upd as (
    update public.desk_system_prompt s
    set content = left(coalesce(new_content, ''), 20000), updated_at = now()
    where s.id = true and exists (select 1 from me)
    returning s.updated_at
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'updatedAt', (select updated_at from upd))
  end;
$function$;

create or replace function public.desk_get_ask_schedule(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
       and not (w.j->>'is_test')::boolean
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'prompt', r.prompt, 'cadence', r.cadence,
               'everyHours', r.every_hours, 'atHour', r.at_hour, 'atMin', r.at_min,
               'marketOnly', r.market_only, 'enabled', r.enabled,
               'lastRunAt', r.last_run_at, 'lastStatus', r.last_status)
             order by r.pos, r.id)
      from public.desk_ask_schedule r
    ), '[]'::jsonb))
  end;
$function$;

create or replace function public.desk_set_ask_schedule(pin text, new_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  ok_pin  boolean;
  item    jsonb;
  i       integer := 0;
  kept    bigint[] := '{}';
  rid     bigint;
  v_prompt   text;
  v_cadence  text;
  v_every    integer;
  v_hour     integer;
  v_min      integer;
begin
  select exists (
    select 1 from public.desk_pin_who(pin) as w(j)
    where (w.j->>'ok')::boolean
      and not (w.j->>'is_test')::boolean
  ) into ok_pin;
  if not ok_pin then
    return jsonb_build_object('ok', false);
  end if;

  if new_rows is null or jsonb_typeof(new_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows must be an array');
  end if;

  for item in select * from jsonb_array_elements(new_rows) loop
    exit when i >= 10;

    v_prompt := btrim(coalesce(item->>'prompt', ''));
    continue when v_prompt = '';
    v_prompt := left(v_prompt, 500);

    v_cadence := coalesce(item->>'cadence', 'daily');
    if v_cadence not in ('hourly', 'every_n_hours', 'daily', 'weekdays') then
      v_cadence := 'daily';
    end if;

    v_every := coalesce((item->>'everyHours')::integer, 4);
    if v_every not in (2, 3, 4, 6, 8, 12) then v_every := 4; end if;

    v_hour := least(23, greatest(0, coalesce((item->>'atHour')::integer, 8)));
    v_min  := least(55, greatest(0, coalesce((item->>'atMin')::integer, 0)));
    v_min  := v_min - (v_min % 5);

    rid := nullif(item->>'id', '')::bigint;

    if rid is not null and exists (select 1 from public.desk_ask_schedule s where s.id = rid) then
      update public.desk_ask_schedule s
         set prompt = v_prompt, cadence = v_cadence, every_hours = v_every,
             at_hour = v_hour, at_min = v_min,
             market_only = coalesce((item->>'marketOnly')::boolean, false),
             enabled = coalesce((item->>'enabled')::boolean, true),
             pos = i, updated_at = now()
       where s.id = rid;
    else
      insert into public.desk_ask_schedule
        (prompt, cadence, every_hours, at_hour, at_min, market_only, enabled, pos)
      values
        (v_prompt, v_cadence, v_every, v_hour, v_min,
         coalesce((item->>'marketOnly')::boolean, false),
         coalesce((item->>'enabled')::boolean, true), i)
      returning id into rid;
    end if;

    kept := kept || rid;
    i := i + 1;
  end loop;

  delete from public.desk_ask_schedule where not (id = any(kept));

  return jsonb_build_object('ok', true, 'rows', i);
end;
$function$;

create or replace function public.desk_get_ask_model(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  with me as (
    select (w.j->>'id')::uuid as id
      from public.desk_pin_who(pin) as w(j)
     where (w.j->>'ok')::boolean
       and not (w.j->>'is_test')::boolean
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else coalesce(
      (select jsonb_build_object('ok', true, 'model', s.model, 'updatedAt', s.updated_at)
         from public.desk_ask_model s where s.id),
      jsonb_build_object('ok', true, 'model', null))
  end;
$function$;

create or replace function public.desk_set_ask_model(pin text, new_model text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_actor uuid;
  v_at    timestamptz;
begin
  select (w.j->>'id')::uuid into v_actor
    from public.desk_pin_who(pin) as w(j)
   where (w.j->>'ok')::boolean
     and not (w.j->>'is_test')::boolean;
  if v_actor is null then return jsonb_build_object('ok', false); end if;
  -- NULL passes the CHECK (a NULL is neither true nor false there) and would raise not_null_violation,
  -- which the handler below does not catch; refuse it here so the contract holds.
  if new_model is null then return jsonb_build_object('ok', false, 'error', 'unknown model'); end if;

  perform set_config('desk.actor', v_actor::text, true);
  update public.desk_ask_model s set model = new_model where s.id returning s.updated_at into v_at;
  perform set_config('desk.actor', '', true);
  -- NOT `if not found`: PERFORM sets FOUND, so after the line above it is always true. updated_at is
  -- NOT NULL and stamped on every update, so a NULL here means the UPDATE touched no row.
  if v_at is null then return jsonb_build_object('ok', false, 'error', 'no row'); end if;
  return jsonb_build_object('ok', true, 'model', new_model, 'updatedAt', v_at);
exception when check_violation then
  return jsonb_build_object('ok', false, 'error', 'unknown model');
end;
$function$;

-- ── the legacy door, shut ────────────────────────────────────────────────────────────────────────────
revoke execute on function public.desk_set_watchlists(text, jsonb) from public, anon, authenticated, service_role;

-- ── refuse to commit unless every door goes through the helper ──────────────────────────────────────
do $$
declare
  doors    constant text[] := array[
    'public.desk_login(text)', 'public.desk_get_dashboard(text)', 'public.desk_chat_clear(text)',
    'public.desk_chat_history(text)', 'public.desk_get_watchlists(text)', 'public.desk_get_system_prompt(text)',
    'public.desk_set_system_prompt(text,text)', 'public.desk_get_ask_schedule(text)',
    'public.desk_set_ask_schedule(text,jsonb)', 'public.desk_get_ask_model(text)',
    'public.desk_set_ask_model(text,text)'];
  bad      text;
begin
  -- every door asks the helper and hashes nothing itself
  select string_agg(d, ', ') into bad from unnest(doors) d
   where (select prosrc from pg_proc where oid = d::regprocedure) not like '%public.desk_pin_who(pin)%'
      or (select prosrc from pg_proc where oid = d::regprocedure) like '%pin_hash%';
  if bad is not null then raise exception 'desk_026: these doors do not go through desk_pin_who: %', bad; end if;

  -- no OTHER executable public function hashes a PIN (a door added later must use the helper too)
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc like '%pin_hash%'
     and p.oid <> 'public.desk_pin_who(text)'::regprocedure
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('service_role', p.oid, 'execute'));
  if bad is not null then raise exception 'desk_026: an API role can still reach a PIN check outside the helper: %', bad; end if;

  if has_function_privilege('anon', 'public.desk_pin_who(text)', 'execute')
     or has_function_privilege('authenticated', 'public.desk_pin_who(text)', 'execute')
     or not has_function_privilege('service_role', 'public.desk_pin_who(text)', 'execute') then
    raise exception 'desk_026: desk_pin_who must be executable by service_role only';
  end if;

  if has_table_privilege('anon', 'public.desk_pin_guard', 'select, insert, update, delete')
     or has_table_privilege('authenticated', 'public.desk_pin_guard', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'public.desk_pin_guard', 'select, insert, update, delete') then
    raise exception 'desk_026: an API role holds a privilege on desk_pin_guard';
  end if;

  if (select count(*) from public.desk_pin_guard) <> 1 then
    raise exception 'desk_026: desk_pin_guard must hold exactly one row';
  end if;
end $$;

commit;
