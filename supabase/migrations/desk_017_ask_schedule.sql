-- desk_017: server-side scheduled asks (owner ruling 2026-08-11).
--
-- The scheduler was CLIENT-side (localStorage `ask_sched_v1`, a setInterval in
-- app.js) and therefore only fired while the dashboard was open. The owner's
-- verdict: "the only value a cron task has for me is to be able to wake ITSELF
-- up at a certain time each day and give me a market summary. Otherwise it's of
-- no use." So the roster moves into the database, pg_cron does the waking, and
-- the answer lands in desk_chat_memory — the same table the Ask thread replays
-- from, so a 6am summary is simply there when the desk is opened.
--
-- Same shape as desk_009 / desk_010: RLS deny-all, reached by anon ONLY through
-- the SECURITY DEFINER PIN RPCs below, and by the service key inside the
-- desk-cron-ask edge function.
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration.

-- ── table ───────────────────────────────────────────────────────────────────
-- Every clock in this table is PACIFIC, like every other clock on the desk
-- (DESK_TZ, owner ruling 2026-07-22). `at_hour`/`at_min` are wall-clock PT and
-- are resolved against America/Los_Angeles at fire time, so DST never shifts
-- delivery — an 8:00am row is 8:00am in July and 8:00am in January.
--
-- `at_min` is constrained to a multiple of 5 because the pg_cron job runs every
-- 5 minutes: a minute the scheduler can never land on would silently fire late
-- by an amount nothing in the UI explains.
--
-- `last_run_at` is per-row timer state and is deliberately NOT part of what the
-- editor submits — desk_set_ask_schedule updates rows BY ID and preserves it,
-- which is why this is an upsert-by-id rather than the replace-all the
-- watchlists use. A replace-all would reset every timer on an unrelated edit
-- and re-fire the day's summary.
create table if not exists public.desk_ask_schedule (
  id           bigint generated always as identity primary key,
  prompt       text not null,
  -- 'hourly' | 'every_n_hours' | 'daily' | 'weekdays'
  cadence      text not null default 'daily',
  every_hours  integer not null default 4,   -- used by 'every_n_hours' only
  at_hour      integer not null default 8,   -- PT hour,   used by 'daily'/'weekdays'
  at_min       integer not null default 0,   -- PT minute, used by every cadence
  -- Only fire while the US market is in session (pre-market through
  -- after-hours, weekdays). Exchange holidays are NOT excluded — the guard is a
  -- noise filter, not a trading calendar.
  market_only  boolean not null default false,
  enabled      boolean not null default true,
  pos          integer not null default 0,
  last_run_at  timestamptz,
  last_status  text,
  updated_at   timestamptz not null default now(),
  constraint desk_ask_schedule_prompt_len check (char_length(btrim(prompt)) between 1 and 500),
  constraint desk_ask_schedule_cadence    check (cadence in ('hourly', 'every_n_hours', 'daily', 'weekdays')),
  constraint desk_ask_schedule_every      check (every_hours in (2, 3, 4, 6, 8, 12)),
  constraint desk_ask_schedule_hour       check (at_hour between 0 and 23),
  constraint desk_ask_schedule_min        check (at_min between 0 and 59 and at_min % 5 = 0)
);

create index if not exists desk_ask_schedule_pos_idx on public.desk_ask_schedule (pos, id);

-- deny-all: RLS on, NO policies → anon/authenticated cannot select/insert/update/delete.
alter table public.desk_ask_schedule enable row level security;

-- ── PIN-gated read ──────────────────────────────────────────────────────────
-- Returns the timer state too (last_run_at / last_status): the editor's whole
-- job is to answer "is this actually running?", and a roster that showed only
-- what was configured could not tell a working row from one that has been
-- failing silently since it was written.
create or replace function public.desk_get_ask_schedule(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
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

-- ── PIN-gated write — UPSERT BY ID, then drop what wasn't sent ──────────────
-- The editor submits the complete desired roster, exactly like the watchlists
-- editor, so one call covers add / edit / reorder / delete atomically. Unlike
-- the watchlists it must NOT delete-then-reinsert: `last_run_at` is state the
-- cron owns, and wiping it would re-fire whatever was already answered today.
--
-- Every field is clamped HERE rather than trusted from the client, for the same
-- reason the old client scheduler clamped at its save boundary: each firing
-- spends real Claude quota, so the cap has to hold however the payload was
-- built. 10 rows, 500 characters, a 5-minute minute grid.
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
    -- Snap to the 5-minute grid the cron job actually ticks on rather than
    -- rejecting the row: a refused save would lose the owner's whole edit over
    -- a minute they cannot see is illegal.
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

  -- WHERE is REQUIRED, not decoration — PostgREST's safeupdate guard rejects an
  -- unqualified DELETE with 21000 (the desk_010 lesson). An empty `kept` makes
  -- `id = any('{}')` false for every row, so "delete everything" still works.
  delete from public.desk_ask_schedule where not (id = any(kept));

  return jsonb_build_object('ok', true, 'rows', i);
end;
$function$;

-- anon-only EXECUTE (matches desk_login / desk_get_system_prompt / desk_get_watchlists).
revoke all on function public.desk_get_ask_schedule(text) from public;
revoke all on function public.desk_set_ask_schedule(text, jsonb) from public;
grant execute on function public.desk_get_ask_schedule(text) to anon;
grant execute on function public.desk_set_ask_schedule(text, jsonb) to anon;
