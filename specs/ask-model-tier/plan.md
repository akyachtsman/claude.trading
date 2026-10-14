# Plan — Ask-the-desk model tier (admin-controlled)

> **STATUS (2026-10-14): DRAFT v2 — `plan` phase, revised after an independent review, awaiting owner approval (one decision, D1, below). Nothing is applied, deployed or merged by this document.**

HOW. Reads `spec.md` (FR1–FR13, SC1–SC8, C1–C3) and `brief.md` (the owner's design brief and traps). Constitution: the five imported directives; stack = static HTML + vanilla JS on Pages, Supabase edge function + SQL, **no build**. Owner approval is required for each of: the migration, the `desk-ask` deploy, the merge (CLAUDE.md Safety Rules; `git.md`).

## Decision needed from the owner — D1: how the rollout meets Haiku
Haiku 5.5 is your chosen starting tier and fallback (C3), and it is the one model **no document confirms can run the desk's tool set**: the platform docs say dynamic filtering (the `_20260209` web tools the desk sends on every call, `desk-ask/index.ts:105-106`) is "available with Claude 4.6 and later models", but the API reference's explicit list names only Opus 4.6–5.5, Sonnet 4.6/5/5.5 and Fable 5 — not Haiku 5.5 — and says models without programmatic tool calling get a 400 unless `allowed_callers: ["direct"]` is set. The two sources disagree, I cannot call the live function from here with a PIN, so **a live question is the only proof**.

The first draft seeded Haiku and deployed, which would have put every typed, scheduled and open question on an unproven model from the deploy until someone tested it. **Recommended (this draft):**
- Seed the stored tier at **Opus 5.5** (listed as supporting the tools). Production moves from `claude-opus-5` to Opus 5.5 — a documented-supported step, not a gamble.
- Haiku 5.5 stays the **built-in fallback** (C3), as its own named constant, reached only if the stored tier *and* the override are unusable.
- **You click Haiku in the new switch as the live test (SC8).** If it works it stays on Haiku — your starting tier, proven. If it does not, you click back; nothing is broken, and *then* we decide (D2, only if needed) whether Haiku gets its own tool settings or the fallback becomes Sonnet.

Alternatives: keep the Haiku seed and test right after the deploy with you present (a failure then breaks every question until you flip the row — instant, but a real outage window); or drop Haiku from the three. Reply "D1 as recommended" or name another.

## What the review changed (independent reviewer, then checked against the code and docs by me)
| Finding | Verified how | Change |
|---|---|---|
| **Haiku unproven + it is also the default/fallback** | Skill's dynamic-filtering model list and the two docs pages (above); `index.ts:105-106` | D1 above; explicit `TIER_FALLBACK` constant (not "first array element"); SC8 widened (below) |
| **Control would be invisible on a fresh desk** | `components.css:226` `.ask-toolbar:has(.ask-clear[hidden]) { display: none }`; Clear starts `hidden` (`app.js:3416`) and only appears after saved history or an answer | The control gets its **own element** outside `.ask-toolbar`; S69 asserts it is **visible** with empty history |
| `current_setting('desk.actor', true)` returns `''` after a transaction-local `set_config` on a pooled session → `''::uuid` raises 22P02 and would break the owner's own manual SQL | Known Postgres behaviour; the one-transaction probe cannot reproduce it | Trigger uses `nullif(current_setting('desk.actor', true), '')::uuid`; an explicit probe sets the GUC to `''` then updates |
| NULL `new_model` raises `not_null_violation`, not `check_violation` | `check (model in (…))` passes NULL | The setter rejects NULL up front (`unknown model`) and catches `check_violation`; both probed through the RPC |
| Override narrower than today (any id works today) — a retired id could only be fixed by a deploy | `index.ts:365` accepts any string | Override accepted if it matches `^claude-[a-z0-9-]+$`; logged when outside the three; `tierSource: 'override'` |
| `isAdmin` fails open if the field is missing | The harness's fake returns no `is_test` (`ask-gate-check.mjs:78-81`); `!undefined` is true | `u.is_test === false`; the fake gains a second, test user with its own PIN |
| Control state / write races across `renderAsk` reruns | `renderAsk` runs from `renderPrivate`/`loadPrivate` (`app.js:3780, 8281, 8311`) | A save in flight lands through state → render, not captured nodes; a generation counter on the write as well as the read |
| Test credential would see a permanent "failed" | `deskRpcOk` collapses "refused" and "down" | Note reads "could not read the setting — or this PIN is not the owner's"; S69 covers it |
| Old server returns `model` with no `tierSource` after a rollback | — | Fallback marker only when `tierSource` is present and not `row`; S69 has the "missing tierSource" case |
| Admin error replies carry no tier | `index.ts:780-783` | `model` + `tierSource` added to failure replies when `isAdmin` |
| Stale comments ("model and budget ship together") | `index.ts:133-138, 361-364` | Rewritten; budget and effort `high` stay the same for all three **deliberately** (Haiku's own default effort is `medium`; the desk sets `high` explicitly) |
| "Warm-isolate runner" is unnecessary | `boot()` is one vm context and one handler reused across calls (`ask-gate-check.mjs:159-172` already calls `e.pin()` three times) | Dropped |
| Task list gaps | See Tasks | Fixed: T10's file path, dependencies, a post-merge source re-diff, a scheduled-question check |
| `desk-brief` hard-codes `claude-opus-4-8` | `desk-brief/index.ts:16`; retired per `desk-ask-and-cron.md` | Recorded as exempt in the docs |

**Reviewer points I did not take as given:** it asked to decide per-model tools now — deferred to D2, because the evidence (the gate's result) decides it. It suggested the stamp trigger could be dropped — kept, because the brief requires stamps by trigger; the `nullif` fix removes the cost.

## What I reused (Reuse Before Rewrite)
`desk_system_prompt` (`desk_009`) is the existing singleton-setting-with-PIN-RPCs: same table idiom, same `with me as (… pin_hash …)` check, same `deskRpcOk` wrapper, same service-key REST read in `desk-ask`, same owner-only placement in the Ask panel. New code only where the brief demands more (allow-list, stamps, four-state read, proof, parity). `desk_system_prompt` itself is not touched.

## How each line of the brief maps onto this desk
| Brief says | Here | Why equal or stronger |
|---|---|---|
| Role predicate in RLS `using` **and** `with check` | The PIN check — `pin_hash` matches **and `not is_test`** (C1) — inside BOTH `desk_get_ask_model` and `desk_set_ask_model`, each re-deriving the caller from the PIN | No browser table access to police: **no grant for `anon`/`authenticated`, no policy**, so no permissive-policy OR to subvert. The RPC is the only door and re-checks every call |
| `grant update (model)` to the browser role | None. Browsers hold no privilege on the table; `service_role` gets SELECT only | Nothing to widen |
| `revoke … from anon, authenticated, service_role` | Same, **measured** afterwards incl. `TRUNCATE` (today `service_role` holds SELECT, INSERT, TRUNCATE on every `desk_*` table) | The brief's TRUNCATE trap is real here |
| `updated_by → auth.users` | `updated_by → desk_users(id) on delete set null` | No Supabase Auth users exist |
| Stamps by BEFORE UPDATE trigger | Same (invoker, `search_path = ''`, `nullif`); the setter names the actor via a transaction-local `set_config('desk.actor', …, true)` and supplies `model` only; no actor → `updated_by` null | The trigger overwrites whatever the writer supplied |
| Singleton `check (id)` | Same | — |
| Allow-list in SQL, server, client | `CHECK`; `TIER_IDS` in `desk-ask/index.ts`; `ASK_MODELS` in `scripts/data.js`; **one parity test** (`tools/ask-model-parity.mjs`, run by S69 in CI) asserts all three identical **in order**, that `TIER_FALLBACK` is a member and equals the SQL column default | Order and the fallback are positional/named facts, so both are asserted |
| Proof gated on the caller's own role | `desk-ask` already returns `model` (provider-reported `finalMsg.model`) to **everyone**; now **only to the admin** (`u.is_test === false` PIN user, or the cron secret) with `tierSource` (`row` / `override` / `default`) | A visitor's payload shrinks; the admin sees what answered *and why it was chosen* |

## Data shapes
**Table** `public.desk_ask_model` — one seeded row; `id boolean primary key default true` + `check (id)`; `model text not null default 'claude-haiku-5-5' check (model in ('claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5'))` (the column default is the fallback, C3); `updated_at timestamptz not null default now()`; `updated_by uuid references public.desk_users(id) on delete set null`. RLS **on, no policies**. `revoke all … from public, anon, authenticated, service_role; grant select … to service_role`. **Seeded `(true, 'claude-opus-5-5')`** (D1).

**RPCs** (SECURITY DEFINER, `set search_path = ''`, everything `public.`-qualified, `extensions.digest` as the existing functions write it; `revoke all … from public, anon, authenticated, service_role; grant execute … to anon`, then measured):
- `desk_get_ask_model(pin text) → jsonb`: `{ok:false}` (not the admin) · `{ok:true, model:null}` (admin, no row) · `{ok:true, model, updatedAt}`.
- `desk_set_ask_model(pin text, new_model text) → jsonb`: `{ok:false}` (not the admin) · `{ok:false, error:'unknown model'}` (NULL, or a caught `check_violation`) · `{ok:false, error:'no row'}` (never inserts) · `{ok:true, model, updatedAt}`. One `update … where id`.

**Client list** `ASK_MODELS = [{id, label}, …]` in `scripts/data.js`: Haiku 5.5, Sonnet 5.5, Opus 5.5 (ids as above). `askModelLabel(id)` matches by prefix (the provider may report a dated id), falling back to the raw id.

## Server (`supabase/functions/desk-ask/index.ts`, self-contained — no shared module)
1. `TIER_IDS` (ordered), `TIER_FALLBACK = 'claude-haiku-5-5'` (a named constant; a member of `TIER_IDS`).
2. `readTierRow(supaUrl, svc)` — **one** `GET /rest/v1/desk_ask_model?select=model&id=eq.true`, service key, **no user-agent**, `REST_TIMEOUT_MS`, never cached (no module state). Returns `{ ok:true, model|null }` or `{ ok:false }`. Runs **after** the door check and **once per ask**, resolved once at the top so one question — grounding check and every loop turn — uses one model.
3. `resolveTier(row, override)`: stored value if in `TIER_IDS` → else `ASK_MODEL` if it matches `^claude-[a-z0-9-]+$` (logged when not one of `TIER_IDS`; `tierSource:'override'`) → else `TIER_FALLBACK`. An unlisted stored value is treated as unreadable (logged, falls through). A readable stored value that disagrees with a set override logs `override ignored` — the row **wins**. Returns `{ model, source }`.
4. PIN path selects `is_test` too; `isAdmin = viaCron || (matched user && user.is_test === false)`; the "check every row, no early exit" loop stays.
5. Reply: `model` and `tierSource` appear **only when `isAdmin`** — on success and on the provider-failure reply. Stored `desk_chat_memory.model` unchanged.
6. The `ASK_MODEL || 'claude-opus-5'` literal is gone; the stale "ship together" comments are rewritten. Budget, prompts, tools, caps, doors untouched (FR12).

## Client (`scripts/app.js`, `scripts/data.js`, `styles/components.css`, `index.html`)
- **State** `askTier = { phase: 'unread' | 'failed' | 'empty' | 'stored' | 'saving', stored: id | null, note }`, module-level, reset whenever `renderAsk` runs locked/open.
- **One guard**, `askTierCanChoose(state)` = `phase === 'stored'`. The radios' `disabled`, `aria-checked` and the click handler all derive from it / from `state`; **no static `disabled` attribute anywhere**, so the unread state is held *by the guard*.
- **Read** once per authed `renderAsk` via `deskGetAskModel(pin)` with a generation counter (also on the write). `{ok:false}`/throw → `failed` (Retry; note "could not read the setting — or this PIN is not the owner's"); `model:null` → `empty`; a value in `ASK_MODELS` → `stored`; any other value → `failed` ("unrecognised") — never guessed.
- **Write**: pick → `saving` (all disabled; selection stays on the stored value) → `deskSetAskModel(pin, id)`; `ok:true` → selection becomes the model the server **returned**, note `Saved — applies from your next question.` (never "in use"/"active"); any refusal → note says so and the control **re-reads** the row and shows what that read finds (the revert), or `failed`. The write lands through state → render.
- **Placement**: its **own element** (`.ask-tier`) between the thread and the form, drawn only when `authed`; `role="radiogroup"` named "Ask-the-desk model", three `role="radio"` buttons, a `role="status"` note, the caption `Applies to every question, visitors included.` Not in `.ask-toolbar` (hidden by `:has(.ask-clear[hidden])`). Visitors and a locked desk never get it.
- **Proof**: `runAsk` appends `.ask-model` under an answer — `Answered by Haiku 5.5` — only when `authed` **and** `res.model` is present; when `res.tierSource` is present and not `row` it adds `· fallback (stored tier not used)`. A visitor reply carrying a `model` renders nothing.
- `index.html`: bump the single shared `?v=` token.

## Data flow and main failure modes
Owner picks a tier → `desk_set_ask_model(pin, id)` (PIN re-checked; CHECK validates; trigger stamps) → the row. Any later question (any door) → `desk-ask` reads the row once → resolves → one provider model for the whole question → reply carries `model` + `tierSource` to the admin only → the panel prints it.

| Failure | What happens |
|---|---|
| Row read 5xx / timeout / network | Logged; override, else Haiku (fallback); question answered; admin sees `fallback` |
| Row missing | Same (`empty` in the UI) |
| Stored value outside the three | Logged, not used; override, else fallback |
| Override set and disagrees with a readable row | Row wins; `override ignored` logged |
| Override not shaped like a model id | Logged, ignored |
| Setter refused (wrong PIN, test credential, NULL/unknown model, no row, network) | UI keeps the stored selection, says so, re-reads |
| Getter refused / network | `failed`, nothing selected, all disabled, Retry |
| Provider rejects the model's tools (400) | Existing error path (`model call failed (HTTP 400) — …`), now carrying `model`/`tierSource` for the admin; owner clicks another tier. **Gate (SC8), because Haiku is also the fallback** |
| Visitor / test credential tries to change the tier | `{ok:false}`; no table grant to fall back on |
| Warm isolate | Nothing cached: every ask re-reads |
| Manual SQL by the owner after a prior RPC on a pooled connection | Works (`nullif`); probed |

## Verification plan
- **Server** — `tools/ask-gate-check.mjs` (a `boot()` is already a warm isolate): a `desk_ask_model` handler in the fake database (modes: ok, 5xx, throw, empty, unlisted value); `desk_users` gains a test user with its own PIN. Checks: each of the three stored values reaches the provider's `model` field on **both** the main and the grounding call; row beats override and the disagreement is logged; read failure / empty / unlisted row / malformed override each still answer and log; a well-formed unlisted override is used and reported `override`; no caching (row changed between two asks on one boot → the second follows it); exactly one tier read per ask; admin reply has `model` + `tierSource` (also on the provider-failure reply); a visitor's and the test credential's have neither; the reported model is the provider's, not the requested one. `--mutants`: delete each guard (the row read, row-over-override precedence, the allow-list, `is_test === false`, the admin gate on the reply, the single read, the `tierSource` field, the failure-reply gate) and require a failure. `ask-gate-check` is **not run by CI** today (recorded, not changed here).
- **SQL** — at apply time, in one `DO` block ending in `raise exception` (so everything rolls back and the result returns): grants for `anon`/`authenticated`/`service_role` on the table (incl. TRUNCATE) and `has_function_privilege` on both RPCs; under `set local role anon|service_role` probe the **denials** (select/insert/update/delete/truncate → 42501 where denied); a second row `id=false` → 23514; an out-of-list model by direct update → 23514; a throwaway admin and a throwaway test user (inserted inside the rolled-back transaction, ids verified to be who they claim) prove: wrong PIN → `ok:false`, test user → `ok:false` on **both** RPCs, admin get/set works, the RPC rejects an out-of-list value **and NULL** with `unknown model`, `updated_by` equals the admin and a forged `updated_by` in a direct update is overwritten; a direct UPDATE after `set_config('desk.actor','',true)` succeeds. Then, outside the transaction: `get_advisors`, and an **anon-key HTTP probe** from this sandbox (it can reach the project): `GET /rest/v1/desk_ask_model` must be refused, and the RPCs with a wrong PIN must answer `ok:false`.
- **Client** — new **S69** in `.github/scripts/ui-tests/tests/app.spec.js` (stubbed `deskGetAskModel`/`deskSetAskModel`/`deskAsk`, forced live+authed): the control is **visible with empty history**; unread, failed and empty select nothing and disable all three; stored selects exactly one; a refused save reverts (via the re-read); the note never says "in use"/"active"; the answer shows the model and the fallback marker (and **no** marker when `tierSource` is missing); visitors/locked get no control and no model line even when the reply carries one; the test-credential refusal reads as such; the real `deskGetAskModel`/`deskSetAskModel` put the right function names and keys on the wire; and the **parity test** over the three declarations. Mutation-tested by deleting each guard (`askTierCanChoose`, the handler's own re-check, the revert/re-read, the saved-wording, the proof gate, the visitor gate) and re-running.
- **Parity** — `tools/ask-model-parity.mjs`: parse each file **scoped to the declaration that owns it before stripping comments**; assert identical order, `TIER_FALLBACK` ∈ list and equal to the SQL default. Its in-memory mutants (swap, drop, add, comment-in) run in T11.
- **Gates** per CLAUDE.md Required Commands: `npx html-validate index.html`, contrast gate.

## Rollout (every step needs explicit owner approval; order is the `desk_020` rule: SQL → function → client)
1. Apply `desk_021` to `kwugzhyfjevzwgplhtsd` only (seed **Opus 5.5**, D1); run the SQL verification and the anon-key probe; paste the measured output.
2. Deploy `desk-ask` (`verify_jwt` **OFF**; live is v28 — re-read `list_edge_functions` first), read it back and compare to the repo. From here every question follows the stored row.
3. Merge the client PR on green CI + clean Codex + your go-ahead; watch the Pages build; **re-diff the deployed `desk-ask` against `main`** (the squash makes the branch commit unreachable, as with v28).
4. **SC8 gate, through the panel:** you click **Haiku 5.5**, then ask: one question that needs a web search, one that names a URL to fetch, one that needs live quotes and technicals for two tickers, and one with ✓ Verify armed. I read the new `desk_chat_memory` rows (`model`, `sources`, `usage`, `checked`) and the function logs for `model call failed`. Pass → Haiku stays. Fail → you click back, nothing is broken, and D2 is asked.
5. SC1/SC2: you click Sonnet → Opus → Haiku; each answer names the model you chose, and (with your OK) one open visitor question via curl shows a reply with no model name. If any scheduled question exists, I read its `desk_chat_memory.model` after its first run.
- **Rollback**: set the row to the model wanted (instant, no deploy); or redeploy the pre-change `desk-ask` (it never reads the table, so the table stays); or drop the table/RPCs (the `desk_021` `-- revert:` line) — owner approval for each.

## Tasks
Convention: `depends:` lists task IDs; `[P]` = parallel-safe. Each is roughly failing test → change → verify → commit.

- [ ] **T1** [P] Spec amendment: `spec.md` FR5 → four states; FR8 → override accepts a well-formed id; FR1 → named fallback; SC8 widened; A4 notes the docs conflict; status line. Files: `specs/ask-model-tier/spec.md`, `brief.md` (the Haiku row). depends: none
- [ ] **T2** [P] Write `tools/ask-model-parity.mjs` (exports `checkParity(files)`, CLI over the repo). Run it first: it must FAIL (no declarations yet). depends: none
- [ ] **T3** [P] Write `supabase/migrations/desk_021_ask_model_tier.sql`: table, constraints, RLS on, revoke/grant lines, seed (Opus 5.5), stamp trigger + function (with `nullif`), the two RPCs and their grants, a header naming the DB as the gate, a `-- revert:` line. depends: none
- [ ] **T4** [P] `scripts/data.js`: `ASK_MODELS`, `askModelLabel`, `deskGetAskModel`, `deskSetAskModel` beside `deskGetSystemPrompt`. depends: none
- [ ] **T5** `desk-ask/index.ts`: `TIER_IDS`/`TIER_FALLBACK`, `readTierRow`, `resolveTier`, `is_test` select + `isAdmin` (`=== false`), the resolved model replacing the literal, `model`+`tierSource` gated on success and failure replies, comments rewritten. depends: T3
- [ ] **T6** `tools/ask-gate-check.mjs`: the `desk_ask_model` fake table + modes and a test user (own PIN, `is_test:true`) in the fake `desk_users`. depends: T5
- [ ] **T7** `tools/ask-gate-check.mjs`: the tier checks (list under Verification); run until green; the existing checks stay green (FR12). depends: T6
- [ ] **T8** `tools/ask-gate-check.mjs --mutants`: the guard mutants; each caught; record the count. depends: T7
- [ ] **T9** `scripts/app.js` + `styles/components.css`: state, `askTierCanChoose`, read/write/re-read with generation counters, the `.ask-tier` element, the `.ask-model` proof line; `index.html` `?v=` bump. depends: T4
- [ ] **T10** `.github/scripts/ui-tests/tests/app.spec.js` **S69** (cases under Verification, parity via `tools/ask-model-parity.mjs`); red first, then green. depends: T2, T3, T4, T5, T9
- [ ] **T11** Mutation-test S69 and the parity tool: delete each named guard in a scratch copy, run S69 and the parity mutants, require a failure; record caught/equivalent counts honestly. depends: T10
- [ ] **T12** Docs: `docs/architecture/desk-ask-and-cron.md` ("Model tier" + `desk-brief` exempt), `CLAUDE.md` (map lines, one load-bearing rule, the S69 row, the credential-reach answer + a session-start check line, migrations/tools lists), `specs/README.md` row. depends: T3, T5, T8, T10, T11
- [ ] **T13** Local gates: html-validate, contrast gate, ask-gate-check (+ `--mutants`), parity, S69 on desktop and mobile via the local-Chromium wrapper config. depends: T8, T10, T11, T12
- [ ] **T14** `/qa-pipeline` over the batch from this session; fix findings; mark the PR ready; keep it subscribed. depends: T13
- [ ] **T15** **Owner approval** → apply `desk_021`; SQL verification; anon-key probe; `get_advisors`; paste results. depends: T14
- [ ] **T16** **Owner approval** → deploy `desk-ask` (`verify_jwt` OFF); read back and compare. depends: T15
- [ ] **T17** Merge on green CI + clean Codex + owner go-ahead; watch Pages; re-diff deployed `desk-ask` against `main`. depends: T16
- [ ] **T18** **SC8 gate** through the panel (owner clicks Haiku and asks the four questions; I read `desk_chat_memory` + logs). depends: T17
- [ ] **T19** SC1/SC2 cycle; scheduled-question read if any; record evidence (CLAUDE.md deploy facts, a `learnings.jsonl` entry for each trap met). depends: T18

## Consistency
| Requirement | Task(s) |
|---|---|
| FR1 three tiers, named fallback | T3, T4, T5, T2, T10 |
| FR2/FR11 one setting, every question | T5, T7 |
| FR3 admin only, enforced in the data layer | T3, T15 (denials), T7 (`is_test`) |
| FR4/FR5 control and four states, visible | T9, T10 |
| FR6 revert, honest wording | T9, T10, T11 |
| FR7 next question, no cache | T5, T7 |
| FR8 fallbacks and logging | T5, T7 |
| FR9 proof | T5, T7, T9, T10, T18 |
| FR10 record, unforgeable stamps | T3, T15 |
| FR12 nothing else moves | T7 |
| FR13 reach recorded | T12 |
| SC1 | T19 · SC2 | T7, T10, T15, T19 · SC3 | T7 · SC4 | T7 · SC5 | T10 · SC6 | T2, T10 · SC7 | T12 · SC8 | T18 |

Residuals stated, not hidden: `ask-gate-check` is not in CI; the PIN is brute-forceable through the new RPCs exactly as through the existing ones (accepted residual in CLAUDE.md); Haiku's tool compatibility is unproven until T18 and the fallback is Haiku by your choice; the SQL is verified against the live database when applied, not in CI; the existing PIN RPCs (`desk_009` etc.) revoke EXECUTE only from `public`, so `authenticated`/`service_role` likely still hold it — not changed here, flagged.
