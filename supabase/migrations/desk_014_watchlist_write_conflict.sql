-- desk_014 — optimistic concurrency for the watchlist replace-all.
--
-- WHY. `desk_set_watchlists_open` takes the COMPLETE desired roster and does a
-- delete-all + reinsert. That is deliberate (add/remove symbol and
-- create/rename/reorder/delete list all land atomically in one write), but it
-- makes every save a last-write-wins overwrite of whatever else happened in the
-- meantime.
--
-- `wlMutate` is safe by construction: it reads the authoritative roster and
-- writes it back within milliseconds. The EDITOR is not — its draft is loaded
-- when the modal opens and saved whenever the owner presses Save, which can be
-- many minutes later. Anything created in that window is silently deleted.
--
-- That is not hypothetical: it is exactly how the "Radar" list disappeared on
-- 2026-08-01. It was inserted into the table while the dashboard was open, and
-- a later save built from a pre-Radar snapshot removed it. The table went back
-- to 15 rows with contiguous ids — the signature of a replace-all — and the
-- loss was invisible until the owner noticed the band was missing.
--
-- FIX. The roster carries a version, and a write that names a version the table
-- no longer has is REFUSED rather than applied. The version is
-- max(updated_at): every row's updated_at defaults to now(), a replace-all
-- rewrites every row, and separate RPC calls are separate transactions, so it
-- advances on every successful write.
--
-- `expected_version` DEFAULTS TO NULL = do not check. A cached client that
-- predates this migration must keep working rather than be bricked mid-session;
-- it simply keeps the old last-write-wins behaviour. Every caller in this repo
-- sends the version.

begin;

-- The 1-arg form must GO, not merely be superseded. `create or replace` with a
-- new signature creates a second overload, and PostgREST resolves an RPC by the
-- argument names it is given — a body sending only `new_lists` would match the
-- old unguarded function and the check would be bypassed without any error.
-- Dropping it means that same body matches the new function's default instead.
drop function if exists public.desk_set_watchlists_open(jsonb);

-- The reader hands out the version it read, so a client can echo it back.
create or replace function public.desk_get_watchlists_open()
returns jsonb
language sql
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'ok', true,
    -- NULL on an empty table, which round-trips as a null version and matches
    -- the same null on the write side — an empty roster is a real state.
    'version', (select max(w.updated_at) from public.desk_watchlists w),
    'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'title', w.title, 'symbols', to_jsonb(w.symbols),
               'updatedAt', w.updated_at)
             order by w.pos, w.id)
      from public.desk_watchlists w
    ), '[]'::jsonb));
$function$;

create or replace function public.desk_set_watchlists_open(
  new_lists jsonb,
  expected_version timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  item jsonb;
  i    integer := 0;
  t    text;
  syms text[];
  n    integer := 0;
  cur  timestamptz;
begin
  if new_lists is null or jsonb_typeof(new_lists) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'lists must be an array');
  end if;

  -- Bound the input BEFORE any expansion: anon-callable, so an oversized
  -- payload must not make the database do unbounded work.
  if jsonb_array_length(new_lists) > 50 then
    return jsonb_build_object('ok', false, 'error', 'too many lists (max 50)');
  end if;
  if exists (
    select 1 from jsonb_array_elements(new_lists) e
    where jsonb_typeof(e.value->'symbols') = 'array'
      and jsonb_array_length(e.value->'symbols') > 2000
  ) then
    return jsonb_build_object('ok', false, 'error', 'too many symbols in a list (max 2000)');
  end if;

  -- Serialize writers. Without this the read below and the delete after it
  -- straddle a window in which a second writer can pass the same check, and
  -- both would then believe they were writing over the version they read.
  -- The table is a single owner's roster, so an exclusive lock costs nothing;
  -- it still permits concurrent reads.
  lock table public.desk_watchlists in exclusive mode;

  select max(w.updated_at) into cur from public.desk_watchlists w;

  -- `is distinct from` rather than <>: on an empty table both sides are NULL,
  -- and <> would yield NULL (not true), silently skipping the check.
  if expected_version is not null and cur is distinct from expected_version then
    -- The caller gets the CURRENT version back so it can reload and retry
    -- without a second round-trip to find out what it missed.
    return jsonb_build_object('ok', false, 'error', 'conflict', 'version', cur);
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

    insert into public.desk_watchlists (title, symbols, pos)
    values (left(t, 60), coalesce(syms, '{}'), i);
    i := i + 1;
    n := n + coalesce(array_length(syms, 1), 0);
  end loop;

  select max(w.updated_at) into cur from public.desk_watchlists w;
  return jsonb_build_object('ok', true, 'lists', i, 'symbols', n,
                            'version', cur, 'updatedAt', now());
end;
$function$;

grant execute on function public.desk_get_watchlists_open() to anon, authenticated;
grant execute on function public.desk_set_watchlists_open(jsonb, timestamptz) to anon, authenticated;

commit;
