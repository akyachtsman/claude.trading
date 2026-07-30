-- ── desk_011 — watchlist edits without the PIN ───────────────────────────────
-- Owner ruling 2026-07-30, stated twice: the watchlist is not to depend on
-- unlocking. desk_010 put the roster behind PIN-gated SECURITY DEFINER RPCs, so
-- every add/remove needed an unlocked desk; these two drop that requirement.
--
-- WHAT THIS TRADES AWAY, stated plainly because the anon key is public by
-- design (it ships in the served JavaScript): anyone who loads the site can now
-- read AND rewrite the watchlist roster. Read was already effectively public —
-- desk-watchlist serves the panel to unauthenticated visitors — so what is new
-- is WRITE. The blast radius is a vandalised ticker list, recoverable by
-- editing it back. Balances, positions, the assistant and the system prompt all
-- stay PIN-gated; nothing here touches money or trading.
--
-- The desk_010 PIN versions are deliberately LEFT IN PLACE and untouched:
-- reverting is a client-side switch back to them plus dropping these two, with
-- no data migration either way.
--
-- Same validation as the PIN versions — symbol grammar, 50-list and
-- 2000-symbol caps, replace-all semantics — because those are integrity rules,
-- not access control, and removing the PIN is no reason to relax them.

create or replace function public.desk_get_watchlists_open()
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object('ok', true, 'lists', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', w.id, 'title', w.title, 'symbols', to_jsonb(w.symbols),
             'updatedAt', w.updated_at)
           order by w.pos, w.id)
    from public.desk_watchlists w
  ), '[]'::jsonb));
$function$;

create or replace function public.desk_set_watchlists_open(new_lists jsonb)
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
begin
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

grant execute on function public.desk_get_watchlists_open() to anon, authenticated;
grant execute on function public.desk_set_watchlists_open(jsonb) to anon, authenticated;
