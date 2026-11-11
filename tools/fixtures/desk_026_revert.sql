-- Revert of supabase/migrations/desk_026_pin_lockout.sql: the eleven PIN functions exactly as they were before it,
-- and EXECUTE on the legacy desk_set_watchlists back to the API roles.
--
-- Generated 2026-11-11 with pg_get_functiondef from a scratch replay of desk_001..desk_025 (desk_004/005/025 skipped:
-- pg_net, pg_cron and Postgres 17's MAINTAIN are not on the scratch server). Each body's md5 (CR stripped) matched the
-- live project's the same day, so these are the live definitions (four of them had CRLF line ends there).
--
-- Order: redeploy desk-ask v32 FIRST (v33 calls desk_pin_who), run this file, then — only if the guard is no longer
-- wanted at all — drop function public.desk_pin_who(text); drop table public.desk_pin_guard.
-- It holds a statement that starts with `delete` (desk_set_ask_schedule's body): apply it the way desk_026 was applied.

begin;

CREATE OR REPLACE FUNCTION public.desk_chat_clear(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_chat_history(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id, u.is_test from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_get_ask_model(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with me as (
    select u.id from public.desk_users u
    where not u.is_test
      and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else coalesce(
      (select jsonb_build_object('ok', true, 'model', s.model, 'updatedAt', s.updated_at)
         from public.desk_ask_model s where s.id),
      jsonb_build_object('ok', true, 'model', null))
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.desk_get_ask_schedule(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      and not u.is_test
    limit 1
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_get_dashboard(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_get_system_prompt(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      and not u.is_test
    limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else (
      select jsonb_build_object('ok', true, 'content', s.content, 'updatedAt', s.updated_at)
      from public.desk_system_prompt s
      where s.id = true
    )
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.desk_get_watchlists(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_login(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select jsonb_build_object('ok', true, 'label', u.label)
       from public.desk_users u
      where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      limit 1),
    jsonb_build_object('ok', false));
$function$
;

CREATE OR REPLACE FUNCTION public.desk_set_ask_model(pin text, new_model text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid;
  v_at    timestamptz;
begin
  select u.id into v_actor
    from public.desk_users u
   where not u.is_test
     and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
   limit 1;
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_set_ask_schedule(pin text, new_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    select 1 from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      and not u.is_test
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
$function$
;

CREATE OR REPLACE FUNCTION public.desk_set_system_prompt(pin text, new_content text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      and not u.is_test
    limit 1
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
$function$
;

grant execute on function public.desk_set_watchlists(text, jsonb) to anon, authenticated, service_role;

commit;
