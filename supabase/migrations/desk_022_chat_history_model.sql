-- desk_022 — let a replayed Ask-the-desk answer say which model gave it.
--
-- Owner request 2026-10-14 ("apply desk_022"), the follow-up PR #328's review named: the panel prints
-- `Answered by Haiku 5.5` under an answer AS IT ARRIVES (the reply carries `model`), but a saved answer replayed
-- after a reload shows no such line, because desk_chat_history selects an explicit column list that never named
-- `model`. desk_chat_memory.model has been written since desk_008 (the PROVIDER's reported id), so this is a read
-- change only: no new column, no rewrite of any row.
--
-- Additive on the wire. The RPC returns jsonb built from that column list, so a new key is invisible to the client
-- that is live today; the client that reads it ships after this is applied (migration first, then the client).
-- Re-declared in full (create or replace cannot patch a select list) with `model` added and nothing else changed;
-- the signature is the same, so the grants desk_008 set (anon only, nothing to PUBLIC) are untouched.
--
-- WHICH ROWS CARRY A MODEL — the rule lives here, in the database, not in the page:
--   * Only the owner's PIN (a NON-test desk_users row) is handed a model, exactly as desk_021's proof is: the CI
--     test credential is a valid PIN but is_test, and gets `model: null` on every row (owner ruling C1,
--     2026-10-14: a visitor and the test credential get no proof of which model answers).
--   * Only a stored value that is a provider model id. The weekday morning Routine appends its emails to this
--     table with model = 'claude-code-routine', which is not a model, so printing it as "Answered by" would be
--     wrong. Anything under `claude-code-` is a tool, not a model, and reads as null; so does a null, and so does
--     any value that does not start `claude-`. The tier list is deliberately NOT repeated here (the ASK_MODEL
--     secret may name any well-formed claude-* id, so an allow-list of three would hide a real answer).
--   * No `tierSource`: it is not stored, so a replayed line can never claim a fallback it cannot know about
--     (the page already shows no fallback marker when the server named no source).
--
-- revert: restore public.desk_chat_history(text) from desk_019 (select list ending `c.origin`, no `me.is_test`, no
-- `model`) — create or replace, no data is touched; the client then simply shows no line on a replayed answer.

begin;

create or replace function public.desk_chat_history(pin text)
 returns jsonb
 language sql
 security definer
 set search_path to 'public'
as $function$
  with me as (
    select u.id, u.is_test from public.desk_users u
    where u.pin_hash = encode(extensions.digest(u.salt || pin, 'sha256'), 'hex')
    limit 1
  ),
  recent as (
    select c.id, c.question, c.answer, c.sources, c.created_at, c.origin,
           case when not me.is_test
                 and c.model like 'claude-%'
                 and c.model not like 'claude-code-%'
                then c.model end as model
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
