-- desk_021 — the model that answers Ask-the-desk, held in the database and switched from the page.
--
-- Owner request 2026-10-14: a switch between Haiku 5.5, Sonnet 5.5 and Opus 5.5 for the Ask
-- panel, built to the design shipped in claude.insurance (the design and its traps, not its code):
-- one singleton row an admin changes from the product, read by desk-ask on EVERY question, the
-- ASK_MODEL function secret kept only as break-glass for when this row cannot be read.
--
-- THE DATABASE IS THE GATE. The Ask panel only draws the switch for an unlocked desk, but that is a
-- convenience: a hand-made request skips the page entirely. What actually keeps anyone else from
-- reading or moving the tier is below — the table gives the browser roles NO privilege at all, and
-- the two RPCs re-check the PIN themselves on every call. Do not delete either thinking the UI
-- guard covers it.
--
-- "Admin" has no existing meaning on this desk (there are no roles, only a PIN): it is a PIN that
-- matches the one real, non-test desk_users row. The test credential CI unlocks with is a valid PIN
-- but is_test, so it can neither read nor move the production tier (owner ruling C1, 2026-10-14).
--
-- Shape — the same singleton idiom as desk_009 (desk_system_prompt):
--   * id boolean primary key + check (id): a second row could only be id = false, which the CHECK
--     refuses, so the seeded row is the only row there will ever be.
--   * model is allow-listed by a CHECK. The same list lives in desk-ask (TIER_IDS) and in
--     scripts/data.js (ASK_MODELS), in the SAME ORDER; tools/ask-model-parity.mjs fails if any of
--     the three drifts. The column DEFAULT is the built-in fallback (Haiku 5.5, owner ruling C3) and
--     must equal desk-ask's TIER_FALLBACK; the row itself is SEEDED at Opus 5.5 (plan decision D1):
--     Haiku is proven live through the new switch before anything depends on it.
--   * updated_at / updated_by are stamped by a BEFORE UPDATE trigger, never by the writer, so a
--     caller cannot forge who changed it or when. updated_by names the PIN's desk_users row (this
--     desk has no Supabase Auth users).
--
-- Privileges — enumerated, not assumed, and measured after applying:
--   * Every desk_* table here gives service_role SELECT, INSERT and the privilege to empty the table
--     by project default, so the revoke below names service_role too; desk-ask then gets SELECT back
--     and nothing else. anon and authenticated get nothing, and there is NO policy: with row level
--     security on and no policy the table is deny-all, so there is no permissive-policy OR to
--     subvert (the weakness the brief's RLS predicate had to guard against).
--   * The only way in for a browser is the two SECURITY DEFINER PIN RPCs, executable by anon only.
--     They run as the table owner, so the revokes do not touch them.
--   * There is no way for any browser caller to add a row or remove one.
--
-- The RPCs answer jsonb, never raise for an expected refusal:
--   desk_get_ask_model(pin)            {ok:false} not the admin | {ok:true, model:null} no row |
--                                      {ok:true, model, updatedAt}
--   desk_set_ask_model(pin, new_model) {ok:false} not the admin | {ok:false, error:'unknown model'}
--                                      (NULL, or outside the CHECK) | {ok:false, error:'no row'} (it
--                                      never inserts) | {ok:true, model, updatedAt}
--
-- Stamping: the setter names the actor through a transaction-local setting that the trigger reads.
-- After ANY transaction-local set_config, current_setting(name, true) on that connection returns ''
-- (not NULL) once the transaction ends, and ''::uuid raises 22P02 — so the trigger must nullif() it,
-- or the owner's own manual UPDATE (the documented rollback) would fail intermittently depending on
-- which pooled connection it landed on. With no actor set, updated_by becomes NULL ("unknown")
-- rather than keeping a previous person's name.
--
-- revert: drop function public.desk_set_ask_model(text, text); drop function public.desk_get_ask_model(text); drop table public.desk_ask_model; drop function public.desk_ask_model_stamp() — loses only the stored tier (desk-ask then falls back to the ASK_MODEL secret, then its built-in fallback); no user data. Redeploying the pre-desk_021 desk-ask is NOT required first: it never reads this table.

begin;

create table if not exists public.desk_ask_model (
  id          boolean     primary key default true,
  model       text        not null default 'claude-haiku-5-5',
  updated_at  timestamptz not null default now(),
  updated_by  uuid        references public.desk_users (id) on delete set null,
  constraint desk_ask_model_singleton check (id),
  constraint desk_ask_model_allowed   check (model in ('claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'))
);

alter table public.desk_ask_model enable row level security;

-- deny-all for every browser role, and for service_role everything but SELECT
revoke all on table public.desk_ask_model from public, anon, authenticated, service_role;
grant select on table public.desk_ask_model to service_role;

-- seeded at Opus 5.5 (plan decision D1), NOT at the column default
insert into public.desk_ask_model (id, model)
values (true, 'claude-opus-5-5')
on conflict (id) do nothing;

-- ── the stamp: set by the database, never by the writer ───────────────────────
create or replace function public.desk_ask_model_stamp()
 returns trigger
 language plpgsql
 security invoker
 set search_path to ''
as $function$
begin
  new.updated_at := now();
  new.updated_by := nullif(current_setting('desk.actor', true), '')::uuid;
  return new;
end;
$function$;

revoke all on function public.desk_ask_model_stamp() from public, anon, authenticated, service_role;

create or replace trigger desk_ask_model_stamp
  before update on public.desk_ask_model
  for each row execute function public.desk_ask_model_stamp();

-- ── PIN-gated read (populates the switch when the desk is unlocked) ───────────
create or replace function public.desk_get_ask_model(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to ''
as $function$
  with me as (
    select u.id from public.desk_users u
    where not u.is_test
      and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else coalesce(
      (select jsonb_build_object('ok', true, 'model', s.model, 'updatedAt', s.updated_at)
         from public.desk_ask_model s where s.id),
      jsonb_build_object('ok', true, 'model', null))
  end;
$function$;

-- ── PIN-gated write (the switch) ──────────────────────────────────────────────
create or replace function public.desk_set_ask_model(pin text, new_model text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_actor uuid;
  v_at    timestamptz;
begin
  select u.id into v_actor
    from public.desk_users u
   where not u.is_test
     and u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
   limit 1;
  if v_actor is null then return jsonb_build_object('ok', false); end if;
  -- NULL passes the CHECK (a NULL is neither true nor false there) and would raise not_null_violation,
  -- which the handler below does not catch; refuse it here so the contract holds.
  if new_model is null then return jsonb_build_object('ok', false, 'error', 'unknown model'); end if;

  perform set_config('desk.actor', v_actor::text, true);
  update public.desk_ask_model s set model = new_model where s.id returning s.updated_at into v_at;
  perform set_config('desk.actor', '', true);
  -- NOT `if not found`: PERFORM sets FOUND, so after the line above it is always true. updated_at is
  -- NOT NULL and stamped on every update, so a NULL here means the UPDATE touched no row.
  if v_at is null then return jsonb_build_object('ok', false, 'error', 'no row'); end if;
  return jsonb_build_object('ok', true, 'model', new_model, 'updatedAt', v_at);
exception when check_violation then
  return jsonb_build_object('ok', false, 'error', 'unknown model');
end;
$function$;

-- anon-only EXECUTE: say so for every caller role rather than rely on the project's default ACLs
revoke all on function public.desk_get_ask_model(text)       from public, anon, authenticated, service_role;
revoke all on function public.desk_set_ask_model(text, text) from public, anon, authenticated, service_role;
grant execute on function public.desk_get_ask_model(text)       to anon;
grant execute on function public.desk_set_ask_model(text, text) to anon;

commit;
