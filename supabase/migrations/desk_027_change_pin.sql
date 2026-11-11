-- desk_027 — the owner can change the desk PIN to a long passphrase (owner: "Go ahead as written", 2026-11-11, PIN
-- hardening fix 2 of 3: "a stronger secret"; the standing OK of the same day covers applying it).
--
-- Before this the PIN could only be changed by hand in the database. Now there is one door for it:
--
--   desk_change_pin(pin, new_pin) — anon-callable like every other PIN door; it asks public.desk_pin_who(pin)
--     (desk_026) first, so a wrong current PIN is a counted miss and a locked desk refuses it like any door;
--     only the OWNER may use it (a NON-test desk_users row: the CI test credential cannot change anyone's PIN,
--     its own included — desk_021 / desk_024's rule); the new passphrase must be 16 to 200 characters with no
--     space at either end, must differ from the current one and from every other desk user's (desk_pin_who
--     takes the first row a PIN matches, so two users sharing one would make the owner's PIN log in as
--     whichever row came first); on success it is stored under a FRESH 16-byte random salt, the same salted
--     SHA-256 every door already checks. The answer is {ok:true}, or {ok:false, error} with a reason a person
--     can act on, or {ok:false, locked_until} while the desk is locked.
--
--   desk_pin_set(p_id, new_pin) — the only function that writes a hash — and desk_pin_taken(p_id, new_pin), which
--     says whether a PIN would log in ANOTHER desk user. desk_change_pin calls both (as their owner); NO API role
--     can, so desk_026's rule holds: no function an API role can execute hashes a PIN except desk_pin_who.
--
-- Not changed: the eleven doors, the guard, the lock, desk-ask (it asks desk_pin_who, which reads the new hash at
-- once — every open tab's stored PIN stops working the moment the passphrase changes; the page that changed it
-- stores the new one). The lockout's numbers stay 10 misses an hour.
--
-- Apply: no statement in this file starts with DROP, DELETE or TRUNCATE, so it goes through the Supabase
-- connector's apply_migration from a thread (CLAUDE.md -> Applying a migration), WITHOUT the begin/commit lines
-- (the tool wraps its own transaction). The DO block at the end refuses to commit unless the grants are as below.
--
-- Verify after applying: tools/pin-change-verify.sql (one DO block that always rolls back; every step must pass).
-- Proven first on a scratch Postgres by tools/pin-change-check.py: the probe and every mutant listed there.
--
-- revert: drop function public.desk_change_pin(text, text); drop function public.desk_pin_set(uuid, text);
--   drop function public.desk_pin_taken(uuid, text);
--   (a passphrase already set stays set: it is an ordinary salt + hash row, which every door reads as before)

begin;

-- ── the only writer of a hash ────────────────────────────────────────────────────────────────────────
create or replace function public.desk_pin_set(p_id uuid, new_pin text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_salt text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  update public.desk_users
     set salt     = v_salt,
         pin_hash = encode(extensions.digest(v_salt || new_pin, 'sha256'), 'hex')
   where id = p_id;
  return found;
end;
$function$;
revoke all on function public.desk_pin_set(uuid, text) from public, anon, authenticated, service_role;

-- would this PIN log in a desk user OTHER than p_id? Counts nothing (it is not a login), closed to every API role.
create or replace function public.desk_pin_taken(p_id uuid, new_pin text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from public.desk_users u
                  where u.id <> p_id
                    and u.pin_hash = encode(extensions.digest(u.salt || new_pin, 'sha256'), 'hex'));
$function$;
revoke all on function public.desk_pin_taken(uuid, text) from public, anon, authenticated, service_role;

-- ── the door ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.desk_change_pin(pin text, new_pin text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  w     jsonb := public.desk_pin_who(pin);
  v_id  uuid;
begin
  if not coalesce((w->>'ok')::boolean, false) then
    return jsonb_strip_nulls(jsonb_build_object('ok', false, 'locked_until', w->'locked_until'));
  end if;
  if coalesce((w->>'is_test')::boolean, true) then
    return jsonb_build_object('ok', false, 'error', 'Only the owner can change the passphrase.');
  end if;
  v_id := (w->>'id')::uuid;

  if new_pin is null or char_length(new_pin) < 16 then
    return jsonb_build_object('ok', false, 'error', 'The new passphrase must be at least 16 characters.');
  end if;
  if char_length(new_pin) > 200 then
    return jsonb_build_object('ok', false, 'error', 'The new passphrase must be at most 200 characters.');
  end if;
  if new_pin <> btrim(new_pin, E' \t\r\n') then
    return jsonb_build_object('ok', false, 'error', 'The new passphrase cannot start or end with a space.');
  end if;
  if new_pin = pin then
    return jsonb_build_object('ok', false, 'error', 'The new passphrase is the same as the current one.');
  end if;
  -- another desk user's PIN: desk_pin_who takes the first row a PIN matches, so it must stay unique
  if public.desk_pin_taken(v_id, new_pin) then
    return jsonb_build_object('ok', false, 'error', 'Choose a different passphrase.');
  end if;

  if not public.desk_pin_set(v_id, new_pin) then
    return jsonb_build_object('ok', false, 'error', 'The passphrase could not be saved.');
  end if;
  return jsonb_build_object('ok', true);
end;
$function$;
revoke all on function public.desk_change_pin(text, text) from public;
grant execute on function public.desk_change_pin(text, text) to anon, authenticated, service_role;

-- ── refuse to commit unless the grants are right and desk_026's rule still holds ─────────────────────
do $$
declare
  bad text;
begin
  if not (select prosecdef from pg_proc where oid = 'public.desk_change_pin(text,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.desk_pin_set(uuid,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.desk_pin_taken(uuid,text)'::regprocedure) then
    raise exception 'desk_027: every function here must be SECURITY DEFINER';
  end if;
  if (select prosrc from pg_proc where oid = 'public.desk_change_pin(text,text)'::regprocedure) not like '%public.desk_pin_who(pin)%' then
    raise exception 'desk_027: desk_change_pin must ask desk_pin_who first';
  end if;
  if not has_function_privilege('anon', 'public.desk_change_pin(text,text)', 'execute') then
    raise exception 'desk_027: the page calls desk_change_pin with the anon key';
  end if;
  if has_function_privilege('anon', 'public.desk_pin_set(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.desk_pin_set(uuid,text)', 'execute')
     or has_function_privilege('service_role', 'public.desk_pin_set(uuid,text)', 'execute')
     or has_function_privilege('anon', 'public.desk_pin_taken(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.desk_pin_taken(uuid,text)', 'execute')
     or has_function_privilege('service_role', 'public.desk_pin_taken(uuid,text)', 'execute') then
    raise exception 'desk_027: desk_pin_set and desk_pin_taken must be closed to every API role';
  end if;

  -- desk_026's rule, re-checked: no function an API role can execute touches a hash except desk_pin_who
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc like '%pin_hash%'
     and p.oid <> 'public.desk_pin_who(text)'::regprocedure
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('service_role', p.oid, 'execute'));
  if bad is not null then raise exception 'desk_027: an API role can reach a hash outside desk_pin_who: %', bad; end if;
end $$;

commit;
