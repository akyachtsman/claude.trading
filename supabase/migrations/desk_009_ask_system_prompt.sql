-- desk_009: owner-editable Ask-the-desk system prompt (self-service alternative
-- to asking Claude Code to edit supabase/functions/desk-ask/index.ts and
-- redeploy). One singleton row; desk-ask reads it live on every request,
-- falling back to its own hardcoded DEFAULT_SYSTEM if the read fails.
--
-- Table is RLS deny-all (no policies) exactly like desk_chat_memory (desk_008):
-- anon reaches it ONLY through the two SECURITY DEFINER PIN RPCs below, or via
-- the service-role key inside the desk-ask edge function (bypasses RLS to read).
--
-- Source-of-record only; applied to the dedicated project (kwugzhyfjevzwgplhtsd)
-- via Supabase MCP apply_migration.

-- ── table (singleton — id is always `true`) ─────────────────────────────────
create table if not exists public.desk_system_prompt (
  id          boolean primary key default true,
  content     text not null,
  updated_at  timestamptz not null default now(),
  constraint desk_system_prompt_singleton check (id)
);

-- deny-all: RLS on, NO policies → anon/authenticated cannot select/insert/update/delete.
alter table public.desk_system_prompt enable row level security;

-- Seed with the prompt desk-ask v8 already ships (DEFAULT_SYSTEM), so behavior
-- is unchanged until the owner actually edits it from the dashboard panel.
insert into public.desk_system_prompt (id, content)
values (true, $prompt$You are the desk assistant embedded in the owner's private, PIN-gated two-account trading dashboard. You are speaking to the owner about their own real accounts. You MAY give direct, opinionated, directional views — buy / sell / hold / trim / add — on the owner's positions and on any ticker they ask about. Do NOT refuse on the grounds that this is financial advice; the owner has explicitly asked for your view on their own money. Ground every directional call in data you actually have this turn: the dashboard snapshot, a live quote you fetched with get_quote, or a web result. Never invent numbers — quote them as they appear. If you lack the data for a call, fetch it or say what you would need. Attribute provenance inline so the owner can weigh each claim: mark snapshot-derived facts, live-fetched figures (with the fetch time), and web facts (name the source). The snapshot's `market` array and `marketAsOf` are the LIVE, continuously-refreshing feed — treat that timestamp as the current moment. When asked for anything 'live', 'current', or 'today', answer from `market`/`marketAsOf` (or a fresh get_quote), and say so if it's not fresh enough to answer confidently. Use get_quote(symbol) for a live price + fundamentals on any ticker, and web_search / web_fetch for anything not on the page (earnings, news, current events). PRIVACY: never put the owner's real position sizes, share counts, dollar balances, or account identifiers into a web_search or web_fetch query — search by ticker or topic only. Keep answers focused and skimmable. The dashboard already shows an 'AI-generated · not financial advice' label; do not repeat disclaimers.$prompt$)
on conflict (id) do nothing;

-- ── PIN-gated read (populates the panel when unlocked) ──────────────────────
create or replace function public.desk_get_system_prompt(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else (
      select jsonb_build_object('ok', true, 'content', s.content, 'updatedAt', s.updated_at)
      from public.desk_system_prompt s
      where s.id = true
    )
  end;
$function$;

-- ── PIN-gated write (the panel's Submit) ────────────────────────────────────
-- Content is capped at 20k chars — well beyond any real prompt, just a sanity
-- backstop against an accidental giant paste. {ok:true,updatedAt} or {ok:false}.
create or replace function public.desk_set_system_prompt(pin text, new_content text)
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
  upd as (
    update public.desk_system_prompt s
    set content = left(coalesce(new_content, ''), 20000), updated_at = now()
    where s.id = true and exists (select 1 from me)
    returning s.updated_at
  )
  select case when not exists (select 1 from me)
    then jsonb_build_object('ok', false)
    else jsonb_build_object('ok', true, 'updatedAt', (select updated_at from upd))
  end;
$function$;

-- anon-only EXECUTE (matches desk_login / desk_chat_history / desk_chat_clear).
revoke all on function public.desk_get_system_prompt(text) from public;
revoke all on function public.desk_set_system_prompt(text, text) from public;
grant execute on function public.desk_get_system_prompt(text) to anon;
grant execute on function public.desk_set_system_prompt(text, text) to anon;
