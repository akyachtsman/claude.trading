-- desk_024 — the CI test PIN can no longer read or change the owner's system prompt, scheduled
-- asks or (through the legacy PIN door) the watchlist roster.
--
-- Finding (2026-10-25 security review, HIGH; repo audit I1): desk_get/set_system_prompt and
-- desk_get/set_ask_schedule accepted ANY desk_users row, the is_test one included. Both tables are
-- global singletons/rosters, and desk-cron-ask runs the schedule AS THE OWNER (holdings in context,
-- answers emailed), so whoever holds the CI credential could rewrite what the owner's assistant is
-- told and what it does on a timer. The live sweeps (S3, NAV, CTRL) click real controls with that
-- credential. desk_021/desk_022 already exclude it; this brings the other owner-only doors in line
-- (owner ruling C1, 2026-10-14: "admin" = a PIN matching a NON-test desk_users row).
--
-- The ONLY change to each body is `and not u.is_test` in the PIN lookup. Everything else — the
-- language, SECURITY DEFINER, search_path, caps, return shapes — is the live definition read back
-- with pg_get_functiondef on 2026-10-27, unchanged. CREATE OR REPLACE keeps each function's owner
-- and EXECUTE grants (anon, authenticated, service_role), so no grant statement is needed; check
-- them after applying.
--
-- Not changed, on purpose:
--   * desk_chat_clear / desk_chat_history / desk_get_dashboard are scoped to the caller's OWN
--     user_id, so the test credential only ever reaches the test user's own rows.
--   * desk_get_watchlists(pin) reads the roster that desk_get_watchlists_open already gives anon.
--   * desk_set_watchlists(pin) is legacy (the page writes through desk_set_watchlists_open, which
--     is anon by owner ruling — accepted residual C1), so excluding the test PIN here closes the
--     PIN door without changing what anon can do.
--   * desk_login: the test PIN must still unlock (CI's S10/S2 depend on it).
--
-- Effect on the page for the TEST credential only: the ⚙ editor's read answers {ok:false} (its
-- Save stays disabled — "a failed read disables Save") and the ⏱ list does too. The owner's PIN is
-- unaffected.
--
-- Verify after applying: tools/test-pin-owner-only-verify.sql (one DO block, always rolled back).
--
-- Applied 2026-10-27 (owner-approved) by the owner in the Supabase SQL Editor, not through the connector,
-- so there is no list_migrations row. Read back identical to this file apart from CRLF line ends; the probe
-- ran live, 15 of 15, rolled back.
--
-- revert: re-run the five CREATE OR REPLACE statements below with the one `and not u.is_test`
-- clause removed from each — that is the pre-desk_024 live definition exactly; no data changes.

create or replace function public.desk_get_system_prompt(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
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
$function$;

create or replace function public.desk_set_system_prompt(pin text, new_content text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
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
$function$;

create or replace function public.desk_get_ask_schedule(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
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
$function$;

create or replace function public.desk_set_watchlists(pin text, new_lists jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  ok_pin boolean;
  item   jsonb;
  i      integer := 0;
  t      text;
  syms   text[];
  n      integer := 0;
begin
  select exists (
    select 1 from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      and not u.is_test
  ) into ok_pin;
  if not ok_pin then
    return jsonb_build_object('ok', false);
  end if;

  if new_lists is null or jsonb_typeof(new_lists) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'lists must be an array');
  end if;

  delete from public.desk_watchlists where true;

  for item in select * from jsonb_array_elements(new_lists) loop
    exit when i >= 50;
    t := btrim(coalesce(item->>'title', ''));
    continue when t = '';

    select coalesce(array_agg(s order by ord), '{}')
      into syms
      from (
        select upper(btrim(value)) as s, min(ordinality) as ord
        from jsonb_array_elements_text(
               case when jsonb_typeof(item->'symbols') = 'array'
                    then item->'symbols' else '[]'::jsonb end
             ) with ordinality as e(value, ordinality)
        where upper(btrim(value)) ~ '^[A-Z0-9.^=-]{1,10}$'
        group by upper(btrim(value))
      ) q;

    if array_length(syms, 1) > 2000 then
      syms := syms[1:2000];
    end if;

    insert into public.desk_watchlists (title, symbols, pos)
    values (left(t, 60), coalesce(syms, '{}'), i);
    i := i + 1;
    n := n + coalesce(array_length(syms, 1), 0);
  end loop;

  return jsonb_build_object('ok', true, 'lists', i, 'symbols', n, 'updatedAt', now());
end;
$function$;
