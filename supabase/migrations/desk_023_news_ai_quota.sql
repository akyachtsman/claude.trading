-- desk_023 — a daily limit on the News topic's AI cleanup.
--
-- Owner request 2026-10-17 ("build option B"): when a topic is typed into the News
-- panel's box, desk-news may ask a small Claude model to turn it into the best search
-- phrase (`cerebres` -> `Cerebras`). That call spends the owner's Anthropic quota and
-- the box is on the public page, so the number of such calls per day is bounded here.
--
-- It is desk_020's counter again, on purpose, but its OWN table: the Ask-the-desk
-- visitor cap and this one must never spend each other (specs/news-topic-ai SC6), and
-- desk_020's day key is shape-checked so it cannot carry a prefix. Same reasoning:
-- the limit has to hold under a burst, and every desk-news request runs on a fresh
-- isolate, so a counter that is READ and written back lets 100 parallel requests all
-- see "0 so far". One INSERT ... ON CONFLICT DO UPDATE ... WHERE n < cap is a single
-- atomic statement: the row lock serialises the burst and the (cap + 1)th request
-- updates nothing and gets `false`.
--
-- The day is a text key the CALLER supplies ('YYYY-MM-DD', its Pacific date); the
-- function checks the shape and nothing else, so it is a counter, not a calendar. No
-- pruning: one tiny row per day the helper was used (~365 a year).
--
-- Privileges are stricter than desk_020's: RLS is on with NO policy, and the table's
-- privileges are revoked from anon, authenticated AND service_role (this project's
-- default hands service_role INSERT and the right to empty a table). The function is
-- SECURITY DEFINER and runs as its owner, so service_role needs only EXECUTE: it can
-- take a unit but cannot read, reset or empty the counter, and the browser's anon key
-- can do none of it. A cap below 1 answers false and writes nothing, so
-- NEWS_TOPIC_AI_DAILY_CAP=0 on the function is a real off switch even if this is reached.
--
-- Nothing here is applied by the build: the owner approves applying it (and the
-- desk-news deploy that uses it) separately. Until it is applied desk-news answers
-- `ai: 'counter'` and searches the text as typed, which is harmless.
--
-- revert: drop function public.desk_news_ai_take(text, integer); drop table public.desk_news_ai_quota — loses only per-day counters (no user data); desk-news needs no redeploy first (a missing counter makes it search the typed text as typed).

begin;

create table if not exists public.desk_news_ai_quota (
  day text    primary key,
  n   integer not null default 0
);

alter table public.desk_news_ai_quota enable row level security;
revoke all on public.desk_news_ai_quota from public, anon, authenticated, service_role;

create or replace function public.desk_news_ai_take(p_day text, p_cap integer)
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

  insert into public.desk_news_ai_quota as q (day, n)
  values (p_day, 1)
  on conflict (day) do update set n = q.n + 1 where q.n < p_cap
  returning q.n into v;

  return v is not null;
end;
$function$;

revoke all on function public.desk_news_ai_take(text, integer) from public, anon, authenticated;
grant execute on function public.desk_news_ai_take(text, integer) to service_role;

commit;
