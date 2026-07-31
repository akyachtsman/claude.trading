-- desk_013 — repair the watchlist write path.
--
-- Every `desk_set_watchlists*` function did an unqualified
--     delete from public.desk_watchlists;
-- as the first half of its replace-all. Supabase runs PostgREST with the
-- `safeupdate` guard preloaded, which rejects that with
--     21000: DELETE requires a WHERE clause
-- so the whole call aborts and rolls back. The function has therefore NEVER
-- written successfully through the API: the ✎ editor, quick-add and the
-- double-click remove all failed the same way, and the roster only ever held
-- what desk_010/desk_011 seeded directly (migrations run as the owner, where
-- the guard is not preloaded — which is exactly why this went unnoticed).
--
-- Found 2026-07-31 while adding the Energy/SOFT/SEMI lists: the write returned
-- 400 and a re-read showed the roster unchanged. Nothing was lost — the guard
-- fires before the delete, so the transaction rolls back intact.
--
-- desk_010/011/012 are corrected at source for a fresh replay; this migration
-- repairs a database that already has the broken definitions. It rewrites the
-- stored definition rather than restating the bodies, so it cannot drift from
-- whatever those functions currently are — including the live-edited ones.
-- It is idempotent: a definition already carrying the WHERE clause is skipped.
do $$
declare
  def  text;
  fixed text;
begin
  for def in
    select pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('desk_set_watchlists', 'desk_set_watchlists_open')
  loop
    fixed := replace(def, 'delete from public.desk_watchlists;',
                          'delete from public.desk_watchlists where true;');
    if fixed <> def then
      execute fixed;
    end if;
  end loop;
end $$;
