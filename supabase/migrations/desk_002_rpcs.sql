-- desk_002_rpcs — RECONSTRUCTED on 2026-09-29 from the live catalog, NOT the
-- original text. The original was applied out-of-band through the Supabase MCP
-- (live migration log: version 20260710215052, name desk_002_rpcs) and was
-- never committed. Rebuilt from pg_get_functiondef / pg_proc on the dedicated
-- project (kwugzhyfjevzwgplhtsd).
--
-- DO NOT APPLY THIS TO THE LIVE PROJECT. desk_get_dashboard below is the
-- PRE-desk_007 shape; running it live would silently drop `created_at` from the
-- payload (re-running desk_007 restores it). It exists so a scratch/fresh
-- database can be rebuilt by replaying supabase/migrations/ in order.
--
-- revert: drop function public.desk_login(text); drop function public.desk_get_dashboard(text) — the client cannot unlock or render accounts without them; desk_007 redefines desk_get_dashboard, so restore that body rather than dropping if only undoing desk_007.
--
-- The two PIN RPCs the static client uses (data.md → Client Auth Pattern):
--   desk_login(pin)         {ok:true,label} | {ok:false}
--   desk_get_dashboard(pin) {ok, accounts[], equity[], brief} | {ok:false}
-- Both are SECURITY DEFINER with a pinned search_path, and EXECUTE is anon-only:
-- live ACL is {postgres, anon, service_role} — PUBLIC and authenticated revoked.
--
-- INFERENCE, flagged: desk_login is exactly the live body. desk_get_dashboard
-- is the live body MINUS `s.created_at` in the `latest` CTE's select list —
-- desk_007's own header says that is the only thing it added ("expose the
-- account snapshot sync time (created_at)"). The catalog cannot show the
-- pre-desk_007 text, so this is the stated delta applied backwards. The end
-- state after desk_007 is identical either way.
--
-- Depends on: desk_001 (all four tables; extensions.digest from pgcrypto).

create or replace function public.desk_login(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (select jsonb_build_object('ok', true, 'label', u.label)
       from public.desk_users u
      where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
      limit 1),
    jsonb_build_object('ok', false));
$function$;

create or replace function public.desk_get_dashboard(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  latest as (
    select distinct on (s.account_key) s.account_key, s.label, s.as_of,
           s.nav, s.day_pnl, s.total_unrl, s.cash, s.positions
    from public.desk_account_snapshots s, me
    where s.user_id = me.id
    order by s.account_key, s.as_of desc
  ),
  equity as (
    select account_key, as_of, nav from (
      select e.account_key, e.as_of, e.nav,
             row_number() over (partition by e.account_key order by e.as_of desc) rn
      from public.desk_equity_history e, me
      where e.user_id = me.id
    ) t where rn <= 400
  ),
  brief as (
    select b.as_of, b.generated_at, b.model, b.content
    from public.desk_ai_briefs b, me
    where b.user_id = me.id
    order by b.as_of desc limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object(
      'ok', true,
      'accounts', coalesce((select jsonb_agg(to_jsonb(l) order by l.account_key) from latest l), '[]'::jsonb),
      'equity', coalesce((select jsonb_agg(jsonb_build_object(
                  'account_key', e.account_key, 'as_of', e.as_of, 'nav', e.nav)
                  order by e.as_of) from equity e), '[]'::jsonb),
      'brief', (select to_jsonb(b) from brief b))
  end;
$function$;

-- anon-only EXECUTE. Live ACL lacks BOTH PUBLIC and authenticated (Supabase
-- default-grants functions to authenticated; data.md requires revoking it).
-- service_role keeps its default grant.
revoke all on function public.desk_login(text)         from public, authenticated;
revoke all on function public.desk_get_dashboard(text) from public, authenticated;
grant execute on function public.desk_login(text)         to anon;
grant execute on function public.desk_get_dashboard(text) to anon;
