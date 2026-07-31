-- ── desk_012 — watchlist edits without the PIN ───────────────────────────────
-- Owner ruling 2026-07-30, stated twice: the watchlist is not to depend on
-- unlocking. desk_010 put the roster behind PIN-gated SECURITY DEFINER RPCs, so
-- every add/remove needed an unlocked desk; these two drop that requirement.
--
-- Numbered 012, not 011: desk_011_watchlist_categories.sql already exists. The
-- first cut of this file collided with it, and — worse — was copied from
-- desk_010's body, which predates the grammar widening in that 011. Base any
-- future variant on the LATEST definition, not the original.
--
-- WHAT THIS TRADES AWAY, stated plainly because the anon key is public by
-- design (it ships in the served JavaScript): anyone who loads the site can now
-- read AND rewrite the watchlist roster. Read was already effectively public —
-- desk-watchlist serves the panel to unauthenticated visitors — so what is new
-- is WRITE. The blast radius is a vandalised ticker list, recoverable by
-- editing it back. Balances, positions, the assistant and the system prompt all
-- stay PIN-gated; nothing here touches money or trading.
--
-- The PIN versions are deliberately LEFT IN PLACE and untouched: reverting is a
-- client-side switch back to them plus dropping these two, no data migration.

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

  -- REJECT an oversized payload before touching the table (Codex review, PR
  -- #202). The per-list slice below caps what is STORED, but it runs after
  -- Postgres has already expanded, grouped and sorted every element supplied.
  -- Behind a PIN that was merely wasteful; anon-callable it is a free way to
  -- make the database do unbounded work, so the bound has to come first — and
  -- as a rejection, not a silent truncation, since a caller sending 100k
  -- symbols is not making an edit anyone intended.
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

  -- WHERE clause is REQUIRED, not decoration: Supabase runs PostgREST with the
  -- safeupdate guard, which rejects an unqualified DELETE with 21000 "DELETE
  -- requires a WHERE clause". Without it this function has never written once
  -- (found 2026-07-31 adding a list) — every write path silently 400d.
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
        -- Grammar copied from desk_011_watchlist_categories, NOT desk_010: it
        -- admits '=', without which a replace-all silently drops seeded futures
        -- symbols like GC=F on every unrelated edit.
        where upper(btrim(value)) ~ '^[A-Z0-9.^=-]{1,10}$'
        group by upper(btrim(value))
      ) q;

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
