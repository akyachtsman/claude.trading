-- desk_010: owner-editable watchlists (owner request 2026-07-29). Multiple
-- named lists, unbounded symbols per list, edited from the dashboard's
-- Watchlists panel rather than by a code change + redeploy.
--
-- Same shape as desk_009 (system prompt): RLS deny-all table reached by anon
-- ONLY through the SECURITY DEFINER PIN RPCs below, or via the service-role key
-- inside the desk-watchlist edge function (bypasses RLS to read the roster it
-- needs to quote). Reading the roster is service-side; EDITING needs the PIN.
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration.

-- ── table ───────────────────────────────────────────────────────────────────
-- `pos` carries the owner's own ordering of the lists (tab order in the panel).
create table if not exists public.desk_watchlists (
  id          bigint generated always as identity primary key,
  title       text not null,
  symbols     text[] not null default '{}',
  pos         integer not null default 0,
  updated_at  timestamptz not null default now(),
  constraint desk_watchlists_title_len check (char_length(title) between 1 and 60)
);

create index if not exists desk_watchlists_pos_idx on public.desk_watchlists (pos, id);

-- deny-all: RLS on, NO policies → anon/authenticated cannot select/insert/update/delete.
alter table public.desk_watchlists enable row level security;

-- Seed the owner's first roster ("ETFs", 41 symbols, supplied 2026-07-29) so the
-- panel renders on day one. Guarded on emptiness rather than a fixed id: a
-- migration replay must never clobber lists the owner has edited since.
-- (This is the desk_009 lesson — that seed reverts live edits on replay.)
insert into public.desk_watchlists (title, symbols, pos)
select 'ETFs', array[
  '^VIX','UUP','TLT','SPY','SPYD','SPYG','DDM','DIA','QQQ','IWM','EEM','FXI',
  'BRK.B','INDA','JPXN','FLCH','GLD','SPYV','SOXL','BX','IEF','BN','VIG','AGG',
  'SHY','VTI','BLK','ARKQ','TLH','CMF','JOET','ARKK','IGV','BUG','XLK','XLV',
  'XLB','XLE','XLI','XLF','SMH'
], 0
where not exists (select 1 from public.desk_watchlists);

-- ── PIN-gated read (populates the editor when unlocked) ─────────────────────
create or replace function public.desk_get_watchlists(pin text)
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
    else jsonb_build_object('ok', true, 'lists', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'title', w.title, 'symbols', to_jsonb(w.symbols),
               'updatedAt', w.updated_at)
             order by w.pos, w.id)
      from public.desk_watchlists w
    ), '[]'::jsonb))
  end;
$function$;

-- ── PIN-gated write — REPLACE ALL ───────────────────────────────────────────
-- The panel submits the complete desired state, so one call covers adding or
-- removing a symbol, creating, renaming, reordering and deleting whole lists,
-- and lands atomically (no window where the roster is half-written).
--
-- Symbols are normalised (trim + upper) and filtered to the same grammar the
-- edge function and quote-proxy accept, so a stray character can't reach
-- upstream. Duplicates within a list collapse; list order follows array order.
-- Caps are runaway guards on a bad paste, not product limits: 50 lists,
-- 2000 symbols each.
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
  ) into ok_pin;
  if not ok_pin then
    return jsonb_build_object('ok', false);
  end if;

  if new_lists is null or jsonb_typeof(new_lists) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'lists must be an array');
  end if;

  delete from public.desk_watchlists;

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
        where upper(btrim(value)) ~ '^[A-Z0-9.^-]{1,10}$'
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

-- anon-only EXECUTE (matches desk_login / desk_get_system_prompt).
revoke all on function public.desk_get_watchlists(text) from public;
revoke all on function public.desk_set_watchlists(text, jsonb) from public;
grant execute on function public.desk_get_watchlists(text) to anon;
grant execute on function public.desk_set_watchlists(text, jsonb) to anon;
