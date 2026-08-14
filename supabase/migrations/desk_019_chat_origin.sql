-- desk_019 — say which Ask-the-desk rows the desk wrote to itself.
--
-- Codex review, PR #241. Scheduled runs append to desk_chat_memory through the
-- same path a typed question uses, so the thread replays them with the ordinary
-- `ask-q` styling and the owner cannot tell a brief the cron asked for from a
-- question they actually typed. That was survivable while nothing was
-- scheduled; with two briefs a weekday it means the thread fills with questions
-- the owner never asked, reading as if someone else were using their desk.
--
-- Nullable and additive, following desk_015: every existing row stays valid,
-- and the memory append is already best-effort — it must not become less
-- reliable because it now carries a provenance field. Rows written before this
-- migration, and any run whose origin is unknown, stay null and render exactly
-- as they do today.
--
-- Deliberately a plain text column rather than a boolean: "was this scheduled"
-- is the question today, but the honest shape is "where did this come from",
-- and a future third source (an email reply, a webhook) would otherwise need a
-- second boolean and a rule about which wins.

begin;

alter table public.desk_chat_memory
  add column if not exists origin text;

comment on column public.desk_chat_memory.origin is
  'Where this exchange came from: ''scheduled'' for a desk-cron-ask firing, '
  '''typed'' for the browser composer. Null for rows written before desk_019 '
  'or when the writer did not say. The Ask thread marks scheduled rows so a '
  'brief the desk asked itself is never mistaken for one the owner typed.';

-- The history RPC selects an explicit column list, so a new column is invisible
-- to the client until it is named here. Re-declared in full (create or replace
-- cannot patch a select list) with `origin` added and nothing else changed.
create or replace function public.desk_chat_history(pin text)
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
  recent as (
    select c.id, c.question, c.answer, c.sources, c.created_at, c.origin
    from public.desk_chat_memory c, me
    where c.user_id = me.id
    order by c.created_at desc
    limit 40
  )
  select coalesce(
    (select jsonb_agg(to_jsonb(r) order by r.created_at asc) from recent r),
    '[]'::jsonb);
$function$;

commit;
