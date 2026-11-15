-- desk_028 — simulated trades (owner 2026-11-15: "a non-funded testing of our strategies, both options and stock
-- purchases"; "Only me, when unlocked"; "maximum protection via our supabase").
--
-- One table and four PIN doors. NOTHING here is money the owner holds: a row is a made-up trade — a ticker or an OCC
-- option symbol, BUY or SELL, a quantity, the entry price the owner typed, a note, and the Strategies Chart readings at
-- that moment (`snap`, a small JSON object the page builds from public scores). No account, balance or holding.
--
--   desk_sim_trades       RLS ON with NO policy and NO privilege for any API role (anon, authenticated, service_role):
--                         the only way in or out is the four functions below. A trade is never deleted: Remove sets
--                         `removed_at` (an UPDATE), so the history survives a slip and this file holds no statement
--                         that starts with DELETE (CLAUDE.md -> Applying a migration).
--   desk_sim_list(pin)                                   -> {ok, trades:[...]} the owner's trades not removed, oldest first
--   desk_sim_open(pin, p_sym, p_side, p_qty, p_mult, p_entry, p_note, p_snap) -> {ok, id}; the time is the SERVER's now()
--   desk_sim_close(pin, p_id, p_exit, p_exit_snap)       -> {ok}; only an open trade of the caller's
--   desk_sim_remove(pin, p_id)                           -> {ok}; sets removed_at
--
-- Every door asks public.desk_pin_who(pin) FIRST (desk_026: a wrong PIN is a counted miss, ten an hour lock every PIN
-- door for an hour, a locked desk answers {ok:false, locked_until}) and admits ONLY the owner — a NON-test desk_users row
-- (desk_021 / desk_024's rule: the CI test credential can neither read nor write a trade). No door hashes a PIN itself
-- (desk_026's rule, re-checked by the DO block at the end).
--
-- Bounds (the doors are anon-callable, so a forged call is refused, not stored): symbol ^[A-Z0-9.^=-]{1,10}$ or an OCC
-- symbol ^[A-Z][A-Z.-]{0,5}\d{6}[CP]\d{8}$; side buy|sell; quantity > 0 and <= 1,000,000; multiplier 1 or 100; prices
-- > 0 and < 10,000,000; note <= 500 characters; each snapshot <= 8,000 characters of JSON and an object; at most 2,000
-- trades a user, removed ones included.
--
-- Apply: no statement in this file starts with DROP, DELETE or TRUNCATE, so it goes through the Supabase connector's
-- apply_migration from a thread, WITHOUT the begin/commit lines (the tool wraps its own transaction). Owner approval
-- first, every time. The DO block at the end refuses to commit unless the grants are as described.
--
-- Verify after applying: tools/sim-trades-verify.sql (one DO block that always rolls back; every step must pass).
--
-- revert: drop function public.desk_sim_list(text); drop function public.desk_sim_open(text, text, text, numeric,
--   integer, numeric, text, jsonb); drop function public.desk_sim_close(text, bigint, numeric, jsonb);
--   drop function public.desk_sim_remove(text, bigint); drop table public.desk_sim_trades;
--   (the drops are destructive: hand them to the owner, never run them from a thread)

begin;

create table if not exists public.desk_sim_trades (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references public.desk_users (id),
  opened_at   timestamptz not null default now(),
  sym         text        not null check (sym ~ '^[A-Z0-9.^=-]{1,10}$' or sym ~ '^[A-Z][A-Z.-]{0,5}[0-9]{6}[CP][0-9]{8}$'),
  side        text        not null check (side in ('buy', 'sell')),
  qty         numeric     not null check (qty > 0 and qty <= 1000000),
  mult        integer     not null default 1 check (mult in (1, 100)),
  entry       numeric     not null check (entry > 0 and entry < 10000000),
  note        text        not null default '' check (char_length(note) <= 500),
  snap        jsonb       check (snap is null or (jsonb_typeof(snap) = 'object' and char_length(snap::text) <= 8000)),
  closed_at   timestamptz,
  exit        numeric     check (exit is null or (exit > 0 and exit < 10000000)),
  exit_snap   jsonb       check (exit_snap is null or (jsonb_typeof(exit_snap) = 'object' and char_length(exit_snap::text) <= 8000)),
  removed_at  timestamptz,
  check ((closed_at is null) = (exit is null))
);
create index if not exists desk_sim_trades_user on public.desk_sim_trades (user_id, opened_at);
alter table public.desk_sim_trades enable row level security;
revoke all on table public.desk_sim_trades from public, anon, authenticated, service_role;

-- the row a door hands back (never user_id)
create or replace function public.desk_sim_row(t public.desk_sim_trades)
 returns jsonb
 language sql
 immutable
 set search_path to 'public'
as $function$
  select jsonb_build_object('id', t.id, 'opened_at', t.opened_at, 'sym', t.sym, 'side', t.side, 'qty', t.qty, 'mult', t.mult,
    'entry', t.entry, 'note', t.note, 'snap', t.snap, 'closed_at', t.closed_at, 'exit', t.exit, 'exit_snap', t.exit_snap);
$function$;
revoke all on function public.desk_sim_row(public.desk_sim_trades) from public, anon, authenticated, service_role;

-- ── the doors ───────────────────────────────────────────────────────────────────────────────────────
-- Who is calling: the owner's id, or the refusal to hand back as it is.
create or replace function public.desk_sim_who(pin text)
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
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'id', w->>'id');
end;
$function$;
revoke all on function public.desk_sim_who(text) from public, anon, authenticated, service_role;

create or replace function public.desk_sim_list(pin text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w jsonb := public.desk_sim_who(pin);
begin
  if not (w->>'ok')::boolean then return w; end if;
  return jsonb_build_object('ok', true, 'trades', coalesce((
    select jsonb_agg(public.desk_sim_row(t) order by t.opened_at, t.id)
      from public.desk_sim_trades t
     where t.user_id = (w->>'id')::uuid and t.removed_at is null), '[]'::jsonb));
end;
$function$;

create or replace function public.desk_sim_open(pin text, p_sym text, p_side text, p_qty numeric, p_mult integer, p_entry numeric,
  p_note text, p_snap jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w    jsonb := public.desk_sim_who(pin);
  v_id bigint;
begin
  if not (w->>'ok')::boolean then return w; end if;
  if (select count(*) from public.desk_sim_trades where user_id = (w->>'id')::uuid) >= 2000 then
    return jsonb_build_object('ok', false, 'error', 'At most 2,000 simulated trades.');
  end if;
  begin
    insert into public.desk_sim_trades (user_id, sym, side, qty, mult, entry, note, snap)
    values ((w->>'id')::uuid, p_sym, p_side, p_qty, coalesce(p_mult, 1), p_entry, coalesce(p_note, ''), p_snap)
    returning id into v_id;
  exception when check_violation or not_null_violation or invalid_text_representation then
    return jsonb_build_object('ok', false, 'error', 'The trade is not valid.');
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

create or replace function public.desk_sim_close(pin text, p_id bigint, p_exit numeric, p_exit_snap jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w jsonb := public.desk_sim_who(pin);
begin
  if not (w->>'ok')::boolean then return w; end if;
  begin
    update public.desk_sim_trades
       set closed_at = now(), exit = p_exit, exit_snap = p_exit_snap
     where id = p_id and user_id = (w->>'id')::uuid and closed_at is null and removed_at is null;
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'The exit price is not valid.');
  end;
  if not found then return jsonb_build_object('ok', false, 'error', 'No such open trade.'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.desk_sim_remove(pin text, p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w jsonb := public.desk_sim_who(pin);
begin
  if not (w->>'ok')::boolean then return w; end if;
  update public.desk_sim_trades set removed_at = now()
   where id = p_id and user_id = (w->>'id')::uuid and removed_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'No such trade.'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.desk_sim_list(text) from public;
revoke all on function public.desk_sim_open(text, text, text, numeric, integer, numeric, text, jsonb) from public;
revoke all on function public.desk_sim_close(text, bigint, numeric, jsonb) from public;
revoke all on function public.desk_sim_remove(text, bigint) from public;
grant execute on function public.desk_sim_list(text) to anon, authenticated, service_role;
grant execute on function public.desk_sim_open(text, text, text, numeric, integer, numeric, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.desk_sim_close(text, bigint, numeric, jsonb) to anon, authenticated, service_role;
grant execute on function public.desk_sim_remove(text, bigint) to anon, authenticated, service_role;

-- ── refuse to commit unless the table is closed, every door asks desk_pin_who, and desk_026's rule holds ─────────
do $$
declare
  bad text;
  f   text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.desk_sim_trades'::regclass) then
    raise exception 'desk_028: RLS must be on for desk_sim_trades';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.desk_sim_trades'::regclass) then
    raise exception 'desk_028: desk_sim_trades must have no policy';
  end if;
  select string_agg(r || ':' || p, ', ') into bad
    from unnest(array['anon', 'authenticated', 'service_role']) r,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
   where has_table_privilege(r, 'public.desk_sim_trades', p);
  if bad is not null then raise exception 'desk_028: an API role holds a privilege on desk_sim_trades: %', bad; end if;
  foreach f in array array['public.desk_sim_list(text)', 'public.desk_sim_open(text,text,text,numeric,integer,numeric,text,jsonb)',
                           'public.desk_sim_close(text,bigint,numeric,jsonb)', 'public.desk_sim_remove(text,bigint)'] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception 'desk_028: % must be SECURITY DEFINER', f; end if;
    if (select prosrc from pg_proc where oid = f::regprocedure) not like '%public.desk_sim_who(pin)%' then
      raise exception 'desk_028: % must ask desk_sim_who (and so desk_pin_who) first', f;
    end if;
    if not has_function_privilege('anon', f, 'execute') then raise exception 'desk_028: the page calls % with the anon key', f; end if;
  end loop;
  if (select prosrc from pg_proc where oid = 'public.desk_sim_who(text)'::regprocedure) not like '%public.desk_pin_who(pin)%' then
    raise exception 'desk_028: desk_sim_who must ask desk_pin_who';
  end if;
  if has_function_privilege('anon', 'public.desk_sim_who(text)', 'execute')
     or has_function_privilege('authenticated', 'public.desk_sim_who(text)', 'execute') then
    raise exception 'desk_028: desk_sim_who is not a door';
  end if;
  -- desk_026's rule, re-checked: no function an API role can execute touches a hash except desk_pin_who
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc like '%pin_hash%'
     and p.oid <> 'public.desk_pin_who(text)'::regprocedure
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('service_role', p.oid, 'execute'));
  if bad is not null then raise exception 'desk_028: an API role can reach a hash outside desk_pin_who: %', bad; end if;
end $$;

commit;
