-- desk_015 — record what each Ask-the-desk question actually cost.
--
-- Owner request 2026-08-05, after asking what the token difference between
-- Opus 4.8 and Opus 5 would be and getting an estimate rather than a number.
-- The API returns a `usage` block on every call and desk-ask discarded it, so
-- nothing in this project could answer "what did that question cost" — the
-- move to Opus 5 (thinking on by default, so genuinely new output tokens) is
-- exactly the change you want measured rather than reasoned about.
--
-- Nullable and additive on purpose: every existing row stays valid, and any
-- request whose usage accounting fails still writes its answer. The memory
-- append is already best-effort and must not become less reliable because it
-- now carries a cost field.
--
-- Shape written by desk-ask (summed across every model call in the turn,
-- including the tool loop and, when armed, the grounding check):
--   {"in": 0, "out": 0, "cacheWrite": 0, "cacheRead": 0, "calls": 0}
-- cacheWrite/cacheRead are what prove the prompt-cache breakpoints added in
-- the same release are actually landing: a healthy multi-iteration question
-- writes the prefix once and reads it back on every later iteration, so
-- cacheRead should dwarf cacheWrite. Both staying 0 means caching is not
-- working and the prefix is being re-billed at full price.

begin;

alter table public.desk_chat_memory
  add column if not exists usage jsonb;

comment on column public.desk_chat_memory.usage is
  'Token usage summed across every Anthropic call for this question: '
  '{in, out, cacheWrite, cacheRead, calls}. Null for rows written before '
  'desk_015, or when accounting failed. cacheRead >> cacheWrite means the '
  'prompt-cache breakpoints are working.';

commit;
