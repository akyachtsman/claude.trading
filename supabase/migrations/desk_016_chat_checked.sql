-- desk_016 — record HOW an answer was grounded, not just what it cost.
--
-- Owner request 2026-08-05, after the HOOD replay. desk-ask already computed a
-- `checked` block — whether it searched, whether a search was forced, whether
-- the grounding check ran — and returned it to the browser, where it was
-- rendered and then discarded. Nothing was stored, so reviewing the stored
-- exchange afterwards could not answer "was that answer verified?", which is
-- the single question the verifier exists to make answerable. Inferring it from
-- the model-call count is guesswork: a four-call turn looks the same whether
-- the fourth call was a verify pass or another tool round-trip.
--
-- Nullable and additive on purpose, same as desk_015: every existing row stays
-- valid, and a request whose accounting fails still writes its answer. The
-- memory append is best-effort and must not become less reliable for carrying
-- one more field.
--
-- Shape written by desk-ask:
--   {"searched": bool,      -- any web source backed this answer
--    "forcedSearch": bool,  -- a terminal answer with no search was sent back
--                           --   to search before it was allowed to stand
--    "verified": bool,      -- the grounding check actually ran this turn
--    "requested": bool,     -- asked for on THIS question (the verify toggle
--                           --   or an ask_verify mark), vs armed globally
--    "unsupported": bool}   -- the check flagged a claim it could not support
--
-- Rows written before desk_016 are null: not "unverified", but unrecorded.
-- Anything reading this column must keep those apart — treating null as false
-- would report the whole pre-desk_016 history as having failed a check that was
-- never run on it.

begin;

alter table public.desk_chat_memory
  add column if not exists checked jsonb;

comment on column public.desk_chat_memory.checked is
  'How this answer was grounded: {searched, forcedSearch, verified, requested, '
  'unsupported}. Null for rows written before desk_016 — unrecorded, NOT '
  'unverified; do not collapse null to false.';

commit;
