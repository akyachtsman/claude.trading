-- desk_007: expose the account snapshot sync time (created_at) in the dashboard
-- payload so the client can show "Updated <local time> · through <session> close"
-- and stop false-flagging normal overnight-roll EOD lag as STALE.
--
-- Applied to the dedicated project (kwugzhyfjevzwgplhtsd) via Supabase MCP
-- apply_migration; committed here as the source-of-record for the schema change
-- (earlier desk_00N migrations were applied out-of-band and are tracked in the
-- project's supabase_migrations table).
CREATE OR REPLACE FUNCTION public.desk_get_dashboard(pin text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  latest as (
    select distinct on (s.account_key) s.account_key, s.label, s.as_of,
           s.nav, s.day_pnl, s.total_unrl, s.cash, s.positions, s.created_at
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
