-- desk_029 — the watchlists need the PIN on the server (owner 2026-11-16: "yes, everything PIN only").
--
-- WHY. Since desk_012 the roster has been read and written through two anon-callable doors with no PIN at all
-- (desk_get_watchlists_open / desk_set_watchlists_open; owner ruling 2026-07-30 "the watchlist is not to depend on
-- unlocking"). The page has been locked behind the desk PIN since 2026-11-15, but the page is only one way in: anyone
-- holding the public anon key could still read every list and rewrite or empty the roster straight through the API.
-- This closes those two doors to the browser roles and opens two PIN doors in their place.
--
--   desk_get_watchlists_pin(pin)                                -> {ok, version, lists:[...]} — same shape as the open
--                                                                  reader; ANY desk user (the CI test credential too:
--                                                                  reading is what an unlocked page does)
--   desk_set_watchlists_pin(pin, new_lists, expected_version)   -> the open writer's answer, unchanged; the OWNER only
--                                                                  (a NON-test desk_users row: CI never writes the
--                                                                  owner's roster — desk_021 / desk_024's rule)
--
-- Both ask public.desk_pin_who(pin) FIRST (desk_026: a wrong PIN is a counted miss, ten an hour lock every PIN door for
-- an hour, a locked desk answers {ok:false, locked_until}). Neither hashes a PIN itself, and neither repeats the
-- writer's rules: once the PIN is accepted they CALL the existing desk_012/desk_014 functions, so the version guard,
-- the symbol grammar and the 50-list / 2000-symbol caps stay in ONE place. A SECURITY DEFINER function runs as its
-- owner (postgres), which keeps EXECUTE on the open functions after the browser roles lose it.
--
-- service_role keeps EXECUTE on the open reader and writer (it bypasses everything anyway); the edge functions read
-- the table with the service key and are not affected. The morning scan (tools/watchlist-scan.mjs, paused since
-- 2026-11-12) read the roster with the ANON key and will now be refused — loudly, it exits 2 — until it is given
-- another way in.
--
-- Apply: no statement in this file starts with DROP, DELETE or TRUNCATE, so it goes through the Supabase connector's
-- apply_migration from a thread, WITHOUT the begin/commit lines (the tool wraps its own transaction). Owner approval
-- first. The DO block at the end refuses to commit unless the grants are as described.
-- ORDER: apply it together with the page that calls the PIN doors — an older page still calls the open doors and its
-- watchlist saves fail until it is reloaded.
--
-- Verify after applying: tools/watchlists-pin-verify.sql (one DO block that always rolls back; every step must pass).
--
-- revert: grant execute on function public.desk_get_watchlists_open() to anon, authenticated; grant execute on
--   function public.desk_set_watchlists_open(jsonb, timestamptz) to anon, authenticated; then revoke execute on the two
--   desk_*_watchlists_pin functions from anon, authenticated (or drop them — destructive: hand that to the owner).

begin;

create or replace function public.desk_get_watchlists_pin(pin text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w jsonb := public.desk_pin_who(pin);
begin
  if not coalesce((w->>'ok')::boolean, false) then
    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));
  end if;
  return public.desk_get_watchlists_open();
end;
$function$;

create or replace function public.desk_set_watchlists_pin(pin text, new_lists jsonb, expected_version timestamptz default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w jsonb := public.desk_pin_who(pin);
begin
  if not coalesce((w->>'ok')::boolean, false) then
    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));
  end if;
  if coalesce((w->>'is_test')::boolean, true) then
    return jsonb_build_object('ok', false, 'error', 'Only the owner can change the watchlists.');
  end if;
  return public.desk_set_watchlists_open(new_lists, expected_version);
end;
$function$;

revoke all on function public.desk_get_watchlists_pin(text) from public, anon, authenticated, service_role;
revoke all on function public.desk_set_watchlists_pin(text, jsonb, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.desk_get_watchlists_pin(text) to anon, authenticated, service_role;
grant execute on function public.desk_set_watchlists_pin(text, jsonb, timestamptz) to anon, authenticated, service_role;

-- the open doors: closed to the browser roles
revoke execute on function public.desk_get_watchlists_open() from public, anon, authenticated;
revoke execute on function public.desk_set_watchlists_open(jsonb, timestamptz) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.desk_get_watchlists_open()', 'execute')
     or has_function_privilege('authenticated', 'public.desk_get_watchlists_open()', 'execute')
     or has_function_privilege('anon', 'public.desk_set_watchlists_open(jsonb, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.desk_set_watchlists_open(jsonb, timestamptz)', 'execute') then
    raise exception 'desk_029: a browser role can still call an open watchlist door';
  end if;
  if not (has_function_privilege('anon', 'public.desk_get_watchlists_pin(text)', 'execute')
          and has_function_privilege('anon', 'public.desk_set_watchlists_pin(text, jsonb, timestamptz)', 'execute')) then
    raise exception 'desk_029: the PIN doors are not callable by anon';
  end if;
  if exists (select 1 from pg_proc where proname in ('desk_get_watchlists_pin', 'desk_set_watchlists_pin')
              and pronamespace = 'public'::regnamespace and not prosecdef) then
    raise exception 'desk_029: a PIN door is not SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc where proname in ('desk_get_watchlists_pin', 'desk_set_watchlists_pin')
              and pronamespace = 'public'::regnamespace and prosrc ~* 'digest|pin_hash') then
    raise exception 'desk_029: a PIN door hashes a PIN itself (desk_026: only desk_pin_who may)';
  end if;
end $$;

commit;
