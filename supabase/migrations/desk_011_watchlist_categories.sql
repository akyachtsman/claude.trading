-- desk_011: widen the ticker grammar, and seed the strip's categories as
-- watchlists (owner request 2026-07-29).
--
-- Two parts, both driven by the same request: the owner wants a list per
-- category shown in the market strip, and two of those categories need symbols
-- the old grammar rejected.
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration.

-- ── 1. allow '=' in a ticker ────────────────────────────────────────────────
-- Futures carry it (GC=F gold, SI=F silver) and Yahoo resolves them fine; only
-- our own grammar was rejecting them, which silently dropped the symbol on save
-- with no way for the owner to tell why. The client and the edge function carry
-- the same widened pattern — all three must agree or a symbol accepted in one
-- place vanishes in another.
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

revoke all on function public.desk_set_watchlists(text, jsonb) from public;
grant execute on function public.desk_set_watchlists(text, jsonb) to anon;

-- ── 2. seed one list per market-strip category ──────────────────────────────
-- These MIRROR the strip's own bands (MKT_BANDS in scripts/app.js) plus an
-- Indices list, so the two surfaces name the same groups. Symbols are the Yahoo
-- forms, each verified to resolve before seeding:
--   ^GSPC ^IXIC ^RUT ^DJI ^VIX ^TNX  — indices and the 10-year yield
--   DX-Y.NYB                         — ICE dollar index; needs the exchange-suffix
--                                      fix, since a blanket dot→hyphen made it
--                                      DX-Y-NYB, which resolves to nothing
--   BTC-USD  GC=F                    — bitcoin, gold futures ('=' needed above)
--
-- Each list is inserted ONLY if its title is absent, so a replay cannot
-- duplicate a list or overwrite one the owner has since edited. The existing
-- "ETFs" list is untouched.
insert into public.desk_watchlists (title, symbols, pos)
select v.title, v.symbols, v.pos
from (values
  ('Indices',            array['^GSPC','^IXIC','^RUT','^DJI','^VIX'],                                                   1),
  ('Global & income',    array['EEM','FXI','INDA','JPXN','SPYD'],                                                       2),
  ('Macro',              array['^VIX','^TNX','DX-Y.NYB','UUP','BTC-USD','GC=F'],                                        3),
  ('US sectors',         array['XLK','XLF','XLC','XLY','XLV','XLI','XLP','XLE','XLU','XLB','XLRE'],                     4),
  ('Industry & metals',  array['SMH','KRE','GLD','SLV'],                                                                5),
  ('Treasuries',         array['SHY','TLH','TLT'],                                                                      6)
) as v(title, symbols, pos)
where not exists (
  select 1 from public.desk_watchlists w where lower(w.title) = lower(v.title)
);
