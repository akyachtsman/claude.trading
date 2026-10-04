-- desk_020 — a daily cap on the PIN-less ("open") Ask-the-desk questions.
--
-- Owner request 2026-10-04: "remove the PIN for ask the desk". desk-ask now takes
-- a question with NO PIN (the third way in, beside the PIN and desk-cron-ask's
-- x-cron-secret), and every such question spends the owner's Anthropic quota. The
-- cap is what bounds that cost, so it has to hold under a burst: a counter that is
-- READ and then written back lets 100 parallel requests each see "0 so far" and all
-- pass, and every desk-ask request runs on a fresh isolate, so nothing in module
-- memory can count either. One INSERT ... ON CONFLICT DO UPDATE ... WHERE n < cap
-- is a single atomic statement: the row lock serialises the burst, and the
-- request that would be the (cap + 1)th updates nothing and gets `false`.
--
-- The day is a text key the CALLER supplies ('YYYY-MM-DD', its Pacific date — every
-- clock on the desk is Pacific); the function checks the shape and nothing else, so
-- it is a counter, not a calendar. There is NO pruning: the table gains one tiny
-- row per day an open question was asked (~365 a year), so it needs no cron job and
-- no clean-up inside the function. (An in-function prune was written and dropped —
-- the Supabase MCP holds any statement containing a destructive keyword for
-- confirmation and the apply timed out; a year of rows is a few KB. Tidy by hand if
-- ever wanted.)
--
-- Same posture as desk_006: RLS is enabled with NO policy (deny-all), and only the
-- service role may call the function — the browser's anon key can neither read the
-- counter nor reset it. A cap below 1 answers false and writes nothing, so
-- OPEN_ASK_DAILY_CAP=0 on the function is a real off switch even if this is reached.
--
-- revert: drop function public.desk_open_ask_take(text, integer); drop table public.desk_open_ask_quota — loses only per-day question counters (no user data); desk-ask must be redeployed WITHOUT the open path first, or every open question answers 503 (fail closed).

begin;

create table if not exists public.desk_open_ask_quota (
  day text    primary key,
  n   integer not null default 0
);

alter table public.desk_open_ask_quota enable row level security;
revoke all on public.desk_open_ask_quota from anon, authenticated;

create or replace function public.desk_open_ask_take(p_day text, p_cap integer)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v integer;
begin
  if p_cap is null or p_cap < 1 then return false; end if;
  if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;

  insert into public.desk_open_ask_quota as q (day, n)
  values (p_day, 1)
  on conflict (day) do update set n = q.n + 1 where q.n < p_cap
  returning q.n into v;

  return v is not null;
end;
$function$;

revoke all on function public.desk_open_ask_take(text, integer) from public, anon, authenticated;
grant execute on function public.desk_open_ask_take(text, integer) to service_role;

commit;
