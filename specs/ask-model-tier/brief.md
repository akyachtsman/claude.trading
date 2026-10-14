# Brief — Ask-the-desk model tier (admin-controlled)

> **STATUS (2026-10-14): DRAFT — written by hand in place of `/diagnose`: the owner supplied the approach, so this records it plus what was measured on this project the same day. `spec.md` (WHAT) reads this; `plan.md` (HOW) will carry the owner's traps below into tasks.**

## Problem
The model that answers Ask-the-desk questions is fixed at deploy time: `supabase/functions/desk-ask/index.ts:365` reads `Deno.env.get('ASK_MODEL') || 'claude-opus-5'`. Changing it means editing a Supabase function secret (dashboard, no UI, no record of who or when) or redeploying. The owner wants to choose between three Claude models — **Haiku 5.5, Sonnet 5.5, Opus 5.5** — from the product itself, to trade answer quality against cost. (Owner, earlier this session: "let's put a toggle switch between three models for the Ask Desk to use. For now, it's going to be Haiku, Sonnet, and Opus.")

## Chosen approach (owner, 2026-10-14)
"Copy exactly what the insurance session did" — the design shipped in `claude.insurance`, **not its code** (schemas differ): a singleton database row holding the tier, switchable by an admin from the product, read by the server on every ask; the env secret stays as break-glass, consulted only when the row is unreadable or absent. The owner's full design brief follows verbatim; it is the input to `plan.md`.

## Measured on this project, 2026-10-14 (read-only; nothing changed)
| Question the owner asked to verify | Finding |
|---|---|
| Own credentials | `postgres`, not superuser, `BYPASSRLS` true, `application_name` `mgmt-api`, **four** projects visible (`trading dashboard` = this one, `insurance`, `property dashboard`, `apfp`). Matches the owner's expected answer. Reach is not permission: this work touches only `kwugzhyfjevzwgplhtsd`. |
| Is there an admin/staff role? | **No.** `desk_users` is `id, label, salt, pin_hash, is_test`. The desk has no Supabase Auth users; access is the anon key plus SECURITY DEFINER RPCs that take a PIN. The owner is "the ONE `desk_users` row that is not a test user" (`is_test` false). So "admin" has to be defined — see `spec.md` Clarifications. |
| Which code path chooses the model? | `desk-ask/index.ts:365`: `const model = Deno.env.get('ASK_MODEL') \|\| 'claude-opus-5';`. That one constant reaches the grounding-check call (~706), the main call (~744) and the stored/returned `model` (~952, ~968). `desk-cron-ask` calls `desk-ask`, so scheduled asks take the same path. |
| Does `desk_chat_memory.model` already prove what answered? | **Partly.** It is written from `finalMsg?.model ?? model` — the model the provider reported — for PIN and cron questions only (an open question has no `userId`, nothing saved). But (a) `desk_chat_history` does not select it and the client never renders it; (b) the response payload `model` is returned to **every** caller, open visitors included, and nothing displays it; (c) scheduled rows written by the morning-scan Routine carry `claude-code-routine`, not a model id. The table holds 3 rows (all Routine), so it cannot tell us today's live model. |
| Closest existing analogue | `desk_system_prompt` (`desk_009`): a singleton (`id boolean default true`, check, RLS on, no policies), PIN RPCs `desk_get_system_prompt(pin)` / `desk_set_system_prompt(pin, content)`, read by `desk-ask` over REST with the service key (non-fatal, falls back to a constant), edited from the owner-only ⚙ modal. Reuse-before-rewrite applies: the tier follows this shape. |
| Table privileges here | Every `public.desk_*` table gives `service_role` SELECT, INSERT **and TRUNCATE** (project default); `anon`/`authenticated` hold SELECT grants on five tables that RLS then denies. A new table's comment must not claim "SELECT only" without a `revoke` that is then measured. |
| Model ids | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (no date suffix). Today's default id `claude-opus-5` is a different, older model. Thinking blocks are bound to the model that produced them; `desk-ask` replays text only, so switching between questions is safe. Whether Haiku 5.5 accepts `desk-ask`'s exact tool set (`web_search_20260209`, `web_fetch_20260209`, adaptive thinking, effort `high`) is **not verified, and the sources disagree** (correcting an earlier note that read the docs as reassuring): the platform docs say dynamic filtering is "available with Claude 4.6 and later models", but the API reference's explicit list names Opus 4.6–5.5, Sonnet 4.6/5/5.5 and Fable 5 and not Haiku 5.5, and a model without programmatic tool calling gets a 400 unless `allowed_callers: ["direct"]` is set. Haiku 5.5 does accept adaptive thinking and `effort`, and rejects the sampling parameters and prefill that `desk-ask` never sends. Only a live call settles the tool types. |

## Owner's design brief (verbatim)

Build an admin-controlled model tier for the Ask-the-desk feature, the same
design we just shipped in claude.insurance. Do NOT copy its code — the schemas
differ. Copy the design and the traps.

WHAT IT IS
A singleton row in the database holding which Claude model answers desk
questions, switchable from the product by an admin, read by the server on every
ask. An env-var secret stays as break-glass, consulted only when the row is
unreadable or absent.

FIRST, VERIFY YOUR OWN GROUND (do not assume any of it):
 - Does the desk have an admin/staff role at all, and where does it live?
   claude.insurance keys on `profiles.role = 'broker'`. If this repo has no role
   column, that is the first decision, not an implementation detail.
 - Which code path chooses the model today? Find the literal or env read that
   reaches the provider call.
 - `desk_chat_memory` appears to have a `model` column already. If it records
   what answered, that is most of the proof mechanism below — check before
   building a second one.

THE SCHEMA
  create table if not exists public.<desk>_settings (
    id          boolean primary key default true check (id),
    model       text not null default '<your default model id>'
                  check (model in ('<id1>', '<id2>', '<id3>')),
    updated_at  timestamptz not null default now(),
    updated_by  uuid references auth.users(id) on delete set null
  );
`check (id)` is the singleton idiom: a second row can only be inserted as
id = false, which the CHECK refuses.

PRIVILEGES — enumerate, do not assume, and MEASURE after applying:
  revoke all on public.<desk>_settings from anon, authenticated, service_role;
  grant select on public.<desk>_settings to authenticated;
  grant update (model) on public.<desk>_settings to authenticated;
  grant select on public.<desk>_settings to service_role;   -- only if the
      -- server reads it; in claude.insurance `service_role` has NO table
      -- privileges by default, so this grant is load-bearing, not tidiness.
      -- Check `has_table_privilege('service_role', …)` on your project before
      -- assuming either way.
NO INSERT and NO DELETE for any browser caller. The seeded row is the only row.
⚠️ Include service_role in the revoke: when I measured after applying, it still
held TRUNCATE from the project default while my comment claimed "SELECT only".

RLS — admin-only read AND write, and repeat the role predicate in BOTH clauses:
  create policy "<x>_admin_select" … for select using (<role predicate>);
  create policy "<x>_admin_update" … for update using (<role predicate>)
                                           with check (<role predicate>);
⚠️ This is not redundancy. PERMISSIVE policies OR their `using` and their
`with check` INDEPENDENTLY, so a caller can pass `using` via one policy and
`with check` via another. That cost claude.insurance a HIGH finding.

STAMPS BY TRIGGER, NOT BY THE WRITER. `updated_at`/`updated_by` are set in a
BEFORE UPDATE trigger (SECURITY INVOKER, `set search_path = ''`). The column
grant above is what makes them unforgeable — without it they are decoration.

THE SERVER SIDE
Precedence: the stored row, then the env secret, then the hardcoded default.
⚠️ The row must WIN. If the secret overrode it, an admin could move the switch,
watch it save and read back, and change nothing about the answers. Log the
ignored one when both are set and disagree.
Do NOT cache the row in the isolate or in any client-side data cache. A cached
tier takes effect whenever the cache happens to recycle, which is the same
"appears to work" failure one layer down. One indexed single-row select per ask.
A failed read is NOT fatal: log it and fall back. A missing tier has a correct
answer without it.
Allow-list the value on the server anyway, even with the CHECK constraint — a
function must not assume a constraint it does not own. An unknown id falls back
to the default and logs, rather than refusing.

THE UI — three refusals, each of which I got wrong first:
 1. Never show the default as though it were stored. The read has THREE
    outcomes — read-failed, readable-and-empty, and a stored value — and an
    admin whose read was refused must not conclude the switch says X when
    nobody knows what it says. Nothing selected and all options disabled until
    a tier has actually been read.
 2. A refused write REVERTS the selection. Otherwise the screen says one thing
    and the row says another.
 3. The control must claim only that the ROW moved. "Saved" is not "in use".

THE PROOF, and this is the part most likely to be skipped:
The server appends the model that answered to the response payload, gated on
the caller's OWN role read server-side, and the view renders it. Without that,
a tier the deployed server never read looks identical to one it honours.
⚠️ Asking the model "which model are you using" does NOT prove it. We tried
that first; it correctly answered that its corpus doesn't say. A model cannot
verify its own tier.

TRAPS THAT COST ME TIME HERE:
 - A UI guard is not the gate. The database is. Say so in the code, so nobody
   later deletes the policy thinking the role check covers it.
 - Mutation-test every guard by deleting it and re-running. One of mine
   survived: the "unread" state was being held by a stray `disabled` attribute
   rather than by the guard I'd written. Fixed by rendering the unread state
   THROUGH the guard.
 - If the allow-list ends up in more than one file (SQL CHECK, server, client),
   write a test that parses all of them and asserts they are identical IN ORDER
   — order, if any default is positional. Scope each parse to the declaration
   that owns it before comment-stripping; a whole-file scan will match the
   value in a comment.
 - Probing via the Supabase MCP: a top-level UPDATE with no WHERE clause hangs
   60s and applies nothing. Add a `where`, or wrap it in a CTE. And wrap write
   probes in `begin; … rollback;` — that IS honoured.
 - Probe the DENIALS, not the presence of a clause. Assert the client gets 0
   rows / 42501, not that a policy exists.
 - Verify the uid you probe with actually belongs to who you think. I once read
   a correct RLS result as a bypass because the "foreign" uid was the broker's.

SEPARATELY, AND IT NEEDS NO HELP DESK — add this to your session-start checks:
measure what YOUR OWN credentials reach before touching the database.
  select current_user, session_user,
         (select rolsuper from pg_roles where rolname = session_user),
         (select rolbypassrls from pg_roles where rolname = session_user),
         (select application_name from pg_stat_activity where pid = pg_backend_pid());
  mcp__Supabase__list_projects
Record the expected answer in CLAUDE.md so that anything WIDER later is a
finding. On this account the answer is `postgres`, not superuser, BYPASSRLS
true, `mgmt-api`, and FOUR projects — which is broader than that repo's notes
probably say. Knowing the reach is not permission to use it: stay in your own
project.

## Translation notes for the plan (not decisions — the plan makes them)
The brief was written for a project with Supabase Auth users and browser RLS. This one has neither, so several of its lines have a different shape here; `plan.md` must say for each what it became and why the protection is equal or stronger:
- **Role predicate / policies** → the PIN RPCs' own check (`pin_hash` matches, and — if the owner so rules — `not is_test`), repeated inside BOTH the getter and the setter. There is no browser-held table privilege to column-grant: browsers get **no** grants on the new table at all, and the RPC is the only writer.
- **`updated_by uuid references auth.users`** → `desk_users(id)`.
- **Stamps by trigger** → still a BEFORE UPDATE trigger; the RPC names the actor through a transaction-local setting so the writer supplies `model` only.
- **Proof** → the response already carries `model` (the provider-reported one); gate it to the admin and render it.
