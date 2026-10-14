# Plan — Ask-the-desk model tier (admin-controlled)

> **STATUS (2026-10-14): DRAFT — `plan` phase, awaiting owner approval. Nothing is applied, deployed or merged by this document.**

HOW. Reads `spec.md` (FR1–FR13, SC1–SC8, C1–C3) and `brief.md` (the owner's design brief and traps). Constitution: the five imported directives; stack = static HTML + vanilla JS on Pages, Supabase edge function + SQL, **no build**. Owner approval is required for each of: the migration, the `desk-ask` deploy, the merge (CLAUDE.md Safety Rules; `git.md`).

## Spec amendment (made with this plan)
`spec.md` FR5 names three control states; the brief names the read's **three outcomes** (failed / readable-and-empty / stored) plus the not-yet-read moment. That is four visible states, so FR5 is amended to list them: **unread**, **failed**, **empty** (the read worked and nothing is stored), **stored**. Same rule for all but `stored`: nothing selected, every option disabled.

## What I reused (Reuse Before Rewrite)
`desk_system_prompt` (`desk_009`) is the existing singleton-setting-with-PIN-RPCs: same table idiom (`id boolean`, singleton check, RLS on, no policies), same `with me as (… pin_hash …)` check, same `deskRpcOk` client wrapper, same service-key REST read in `desk-ask`, same owner-only placement in the Ask panel. The new pieces copy that shape; they are new code only where the brief demands something it lacks (allow-list, stamps, three-state read, proof, parity). `desk_system_prompt` itself is not touched.

## How each line of the brief maps onto this desk
| Brief says | Here | Why equal or stronger |
|---|---|---|
| Role predicate in RLS `using` **and** `with check` | The PIN check — `pin_hash` matches **and `not is_test`** (C1) — written inside BOTH `desk_get_ask_model` and `desk_set_ask_model`, each re-deriving the caller from the PIN | The desk has no browser table access to police: the new table gets **no grant for `anon`/`authenticated` and no policy**, so there is no permissive-policy OR to subvert. The RPC is the only door and re-checks on every call |
| `grant update (model)` to the browser role | None. Browsers hold no privilege on the table; `service_role` gets SELECT only | Nothing to widen: a forged `updated_by` or a second row has no door at all |
| `revoke … from anon, authenticated, service_role` | Same, and **measured** afterwards (`has_table_privilege`, and `TRUNCATE` specifically). Measured today: `service_role` holds SELECT, INSERT and TRUNCATE on every `desk_*` table | The brief's TRUNCATE trap is real on this project |
| `updated_by → auth.users` | `updated_by → desk_users(id) on delete set null` | No Supabase Auth users exist |
| Stamps by BEFORE UPDATE trigger | Same trigger (invoker, `search_path = ''`); the setter names the actor via a transaction-local `set_config('desk.actor', …, true)` and supplies `model` only; with no actor set, `updated_by` becomes null rather than keeping a stale name | The writer cannot forge a stamp: the trigger overwrites whatever it supplied |
| Singleton `check (id)` | Same | — |
| Allow-list in SQL, server, client | `CHECK` in SQL; `TIER_IDS` in `desk-ask/index.ts`; `ASK_MODELS` in `scripts/data.js`; **one parity test** (`tools/ask-model-parity.mjs`, run by S69 in CI) asserts all three identical **in order** and that the default is the first | The default is positional (first element) so order is asserted |
| Proof: model appended to the response, gated on the caller's own role | `desk-ask` already returns `model` (the provider-reported `finalMsg.model`) to **everyone**; it is now returned **only to the admin** (PIN user with `is_test` false, or the cron secret) together with `tierSource` (`row` / `override` / `default`), and the panel renders it beside the answer | A visitor's payload shrinks; the admin sees what really answered and *why* it was chosen (a fallback is visible, not silent) |

## Data shapes
**Table** `public.desk_ask_model` — one seeded row; `id boolean primary key default true` + `check (id)`; `model text not null default 'claude-haiku-5-5' check (model in ('claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5'))`; `updated_at timestamptz not null default now()`; `updated_by uuid references public.desk_users(id) on delete set null`. RLS **on, no policies**. `revoke all … from public, anon, authenticated, service_role; grant select … to service_role`. Seeded `(true, 'claude-haiku-5-5')` (C3).

**RPCs** (SECURITY DEFINER, `set search_path = ''`, everything schema-qualified; `revoke all … from public, anon, authenticated, service_role; grant execute … to anon`, then measured):
- `desk_get_ask_model(pin text) → jsonb`: `{ok:false}` (not the admin) · `{ok:true, model:null}` (admin, no row) · `{ok:true, model, updatedAt}`.
- `desk_set_ask_model(pin text, new_model text) → jsonb`: `{ok:false}` (not the admin) · `{ok:false, error:'unknown model'}` (caught `check_violation` — the CHECK is the allow-list, the function does not keep a fourth copy) · `{ok:false, error:'no row'}` (it never inserts: there is no INSERT door) · `{ok:true, model, updatedAt}`. One `update … where id` — a statement without a `where` hangs the MCP and is a bug.

**Client list** `ASK_MODELS = [{id, label}, …]` in `scripts/data.js`: `claude-haiku-5-5` "Haiku 5.5", `claude-sonnet-5-5` "Sonnet 5.5", `claude-opus-5-5` "Opus 5.5". `askModelLabel(id)` matches by prefix (the provider may report a dated id) and falls back to the raw id.

## Server (`supabase/functions/desk-ask/index.ts`, self-contained — no shared module, per the settled ruling)
1. `TIER_IDS` (ordered) and `TIER_DEFAULT = TIER_IDS[0]`.
2. `readTierRow(supaUrl, svc)` — **one** `GET /rest/v1/desk_ask_model?select=model&id=eq.true`, service key, **no user-agent**, `REST_TIMEOUT_MS`, never cached (no module state; a warm isolate must read again). Returns `{ ok:true, model|null }` or `{ ok:false }` (non-2xx, throw, bad JSON). Runs **after** the door check (an open question has already taken its cap slot; a failed read refuses nothing) and **once per ask** — resolved once at the top so one question, including its grounding check and every loop turn, uses one model.
3. `resolveTier(row, override)`: stored value if in `TIER_IDS` → else `ASK_MODEL` if in `TIER_IDS` → else `TIER_DEFAULT`. An unlisted stored value is treated as unreadable (logged, falls through to the override, then the default). An unlisted override is logged and ignored. A readable stored value that disagrees with a set override logs `override ignored` — the row **wins**. Returns `{ model, source }`.
4. The PIN path adds `is_test` to its `desk_users` select; `isAdmin = viaCron || (matched user && !is_test)`. The cron secret is the owner's own door (it already answers as the owner row).
5. The reply: `model` and `tierSource` appear **only when `isAdmin`**; a visitor and a test-credential caller get neither. The stored `desk_chat_memory.model` is unchanged (still the provider-reported id).
6. The old `Deno.env.get('ASK_MODEL') || 'claude-opus-5'` literal is gone; `ASK_MODEL` survives only as the break-glass in step 3. Everything else (budget, prompts, tools, caps, doors) is untouched (FR12).

## Client (`scripts/app.js`, `scripts/data.js`, `styles/components.css`, `index.html`)
- **State** `askTier = { phase: 'unread' | 'failed' | 'empty' | 'stored' | 'saving', stored: id | null, note }`, module-level, reset whenever `renderAsk` runs locked/open (Lock leaves no admin state behind).
- **One guard**, `askTierCanChoose(state)` = `phase === 'stored'`. The radios' `disabled`, their `aria-checked` and the click handler **all derive from it / from `state`**: there is no static `disabled` attribute anywhere, so the unread state is held *by the guard* (the brief's mutation trap) and a mutant that removes the guard is visible.
- **Read** once per authed `renderAsk` via `deskGetAskModel(pin)` with a generation counter (a slow read from an earlier render must not land on a later one); `{ok:false}`/throw → `failed` (+ a Retry button); `model:null` → `empty`; a value in `ASK_MODELS` → `stored`; a value not in it → `failed` ("unrecognised") — never guessed.
- **Write**: pick → `saving` (all disabled, selection stays on the **stored** value until the server answers) → `deskSetAskModel(pin, id)`; on `ok:true` the selection becomes the model the server **returned** (not the one clicked) and the note says `Saved — applies from your next question.` (never "in use"/"active"); on any refusal the note says so and the control **re-reads** the row (the truth after a failed write is unknown) and shows what that read finds — reverting the selection — or `failed` if that read also fails.
- **Placement**: in `.ask-toolbar` (drawn only when `authed`, like Clear/Verify/⏱/⚙): `role="radiogroup"` named "Ask-the-desk model", three `role="radio"` buttons, a `role="status"` note, and a standing caption `Applies to every question, visitors included.` Visitors and a locked desk never get the toolbar or the control.
- **Proof**: `runAsk` appends a `.ask-model` line under an answer — `Answered by Haiku 5.5` — only when `authed` **and** `res.model` is present; when `res.tierSource` is not `row` it adds `· fallback (stored tier not used)` with the source in its title. A visitor reply carrying a `model` anyway renders nothing (the client guard is belt-and-braces; the server gate is the real one).
- `index.html`: bump the single shared `?v=` token on all render-blocking assets.

## Data flow and main failure modes
Owner picks a tier → `desk_set_ask_model(pin, id)` (PIN re-checked; CHECK validates; trigger stamps) → the row. A later question (any door) → `desk-ask` reads the row once → resolves → one provider model for the whole question → reply carries `model` (+ `tierSource`) to the admin only → the panel prints it.

| Failure | What happens |
|---|---|
| Row read 5xx / timeout / network | Logged; override, else Haiku; the question is answered; admin's panel shows `fallback` |
| Row missing | Same as above (`empty` in the UI) |
| Stored value outside the three (hand edit past the CHECK) | Logged, not used; override, else Haiku |
| Override set and disagrees with a readable row | Row wins; `override ignored` logged |
| Override is not one of the three | Logged, ignored |
| Setter refused (wrong PIN, test credential, unknown model, no row, network) | UI keeps the stored selection, says so, re-reads |
| Getter refused / network | `failed`, nothing selected, all disabled, Retry |
| Provider refuses Haiku's tool set (400) | Existing error path (`model call failed (HTTP 400) — …`); nothing stored wrong; the owner switches to Sonnet/Opus. **A gate, not a footnote (SC8): Haiku is also the fallback** |
| Visitor / test credential tries to change the tier | `{ok:false}` from the RPC; no table grant to fall back on |
| Warm isolate | Nothing cached: each ask re-reads |

## Verification plan
- **Server** — `tools/ask-gate-check.mjs`: a `desk_ask_model` handler in the fake database with failure modes (5xx, throw, empty, unlisted value) and a **warm-isolate** runner (two asks in one vm context). Checks: each of the three stored values reaches the provider's `model` field on **both** the main and the grounding call; row beats override and the disagreement is logged; read failure / empty / unlisted row / unlisted override each still answer and log; no caching (row changed between two asks in one context → the second follows it); exactly one tier read per ask; admin reply has `model` + `tierSource`, a visitor's and a test-credential caller's have neither; the reported model is the provider's, not the requested one. `--mutants`: delete each guard (the row read, row-over-override precedence, the allow-list, the `is_test` condition, the admin gate on the reply, the per-ask single read, the `tierSource` field) and require a failure. `ask-gate-check` is **not run by CI** today (no workflow references it) — recorded, not changed here.
- **SQL** — at apply time, in a single `DO` block that ends in `raise exception` (so everything rolls back and the result returns): measure grants for `anon`/`authenticated`/`service_role` on the table (incl. TRUNCATE) and `has_function_privilege` on both RPCs; under `set local role anon|service_role` probe the **denials** (select → 42501, insert/update/delete/truncate → 42501); a second row `id=false` → 23514; an out-of-list model → 23514; a throwaway admin and a throwaway test user (inserted inside the rolled-back transaction, with a known salt/hash — their ids checked to be who they claim) prove: wrong PIN → `ok:false`, test user → `ok:false` on **both** RPCs, admin get/set works, `updated_by` equals the admin and a forged `updated_by` in a direct update is overwritten by the trigger.
- **Client** — new **S69** in `app.spec.js` (stubbed `deskGetAskModel`/`deskSetAskModel`/`deskAsk`, forced live+authed): the unread and failed and empty states each select nothing and disable all three; stored selects exactly one; a refused save reverts (including the re-read path); the note never says "in use"/"active"; the answer shows the model and the fallback marker; visitors/locked get no control and no model line even when the reply carries one; the real `deskGetAskModel`/`deskSetAskModel` put the right function names and keys on the wire; and the **parity test** over the three declarations. Mutation-tested by deleting each guard (the `askTierCanChoose` guard, the handler's own re-check, the revert/re-read, the saved-wording, the proof gate, the visitor gate) and re-running.
- **Parity** — `tools/ask-model-parity.mjs`: parse each file **scoped to the declaration that owns it before stripping comments** (a comment naming a model must not count); assert identical order and `default === first`; `--mutants` swaps, drops, adds and comments-in a model in each file and demands failure.
- **Gates** per CLAUDE.md Required Commands: `npx html-validate index.html`, contrast gate, workflow guards (none touched).

## Rollout (every step needs explicit owner approval; order is the rule from `desk_020`: SQL → function → client)
1. Apply `desk_021` to `kwugzhyfjevzwgplhtsd` only; run the SQL verification; paste the measured output.
2. Deploy `desk-ask` (`verify_jwt` **OFF**, read from `list_edge_functions` first), read it back and compare to the repo. **From this moment every question — typed, scheduled and open — runs on Haiku 5.5** (the seeded tier; today's live model is the older `claude-opus-5`).
3. **SC8 gate, before anyone is told it shipped:** the owner asks two questions in the panel (one that needs a web search, one that needs a live quote); I read the two new `desk_chat_memory` rows' `model` and `sources`, and the function logs for `model call failed`. If Haiku 5.5 refuses the tools: flip the row to `claude-opus-5-5` (owner-approved SQL) and stop — the feature does not ship until a model that works is the fallback too.
4. Merge the client PR (Pages), then the owner cycles Sonnet → Opus → Haiku in the panel; each answer must name the chosen model (SC1), and a visitor's reply must name none (SC2).
- **Rollback**: set the row to the model wanted (instant, no deploy); or redeploy the pre-change `desk-ask` (it never reads the table, so the table can stay); or drop the table/RPCs (the `desk_021` `-- revert:` line) — owner approval for each.

## Tasks
Convention: `depends:` lists task IDs; `[P]` = parallel-safe. Each is roughly a failing test → change → verify → commit.

- [ ] **T1** [P] Spec amendment: edit `spec.md` FR5 to the four states; status line → "plan drafted". Files: `specs/ask-model-tier/spec.md`. depends: none
- [ ] **T2** [P] Write `tools/ask-model-parity.mjs` (exports `checkParity(files)`, CLI over the repo, `--mutants`). Run it first: it must FAIL (no declarations yet). Files: `tools/ask-model-parity.mjs`. depends: none
- [ ] **T3** [P] Write `supabase/migrations/desk_021_ask_model_tier.sql`: table, constraints, RLS on, the revoke/grant lines, seed, stamp trigger + function, the two RPCs and their grants, header comment naming the DB as the gate and a `-- revert:` line. Files: that one. depends: none
- [ ] **T4** [P] `scripts/data.js`: add `ASK_MODELS`, `askModelLabel`, `deskGetAskModel`, `deskSetAskModel` beside `deskGetSystemPrompt`. depends: none
- [ ] **T5** `desk-ask/index.ts`: `TIER_IDS`/`TIER_DEFAULT`, `readTierRow`, `resolveTier`, the `is_test` select, `isAdmin`, replace the `ASK_MODEL` literal with the resolved model, gate `model`+`tierSource` on the reply. depends: T3 (names), T2 (to turn it green with T3/T4)
- [ ] **T6** `tools/ask-gate-check.mjs`: add the `desk_ask_model` fake table + failure modes and the warm-isolate runner; update the existing checks that assert `model` on a visitor reply. depends: T5
- [ ] **T7** `tools/ask-gate-check.mjs`: add the tier checks (list under Verification) and run until green. depends: T6
- [ ] **T8** `tools/ask-gate-check.mjs --mutants`: add the guard mutants; each must be caught; record the count. depends: T7
- [ ] **T9** `scripts/app.js` + `styles/components.css`: the state, `askTierCanChoose`, read/write/re-read, toolbar markup, `.ask-model` proof line; `index.html` `?v=` bump. depends: T4
- [ ] **T10** `app.spec.js` **S69** (states, write path, revert, wording, proof, visitor/locked, wire shape, parity via `tools/ask-model-parity.mjs`). Write it red first, then green. depends: T2, T9
- [ ] **T11** Mutation-test S69 and the parity tool: delete each named guard in a scratch copy, run S69 (and `ask-model-parity --mutants`), require a failure; record caught/equivalent counts honestly. depends: T10
- [ ] **T12** Docs: `docs/architecture/desk-ask-and-cron.md` (a "Model tier" section), `CLAUDE.md` (architecture map lines, one load-bearing rule, the S69 row, the credential-reach answer + a session-start check line, migrations/tools lists), `specs/README.md` row. depends: T5, T9
- [ ] **T13** Local gates: html-validate, contrast gate, ask-gate-check (+ `--mutants`), parity (+ `--mutants`), S69 on desktop and mobile with the local-Chromium wrapper config. depends: T7, T8, T10, T11, T12
- [ ] **T14** `/qa-pipeline` over the batch from this session (never from a subagent); fix findings; open the draft PR; subscribe to its activity. depends: T13
- [ ] **T15** **Owner approval** → apply `desk_021`; run the SQL verification block; paste results. depends: T14
- [ ] **T16** **Owner approval** → deploy `desk-ask` (`verify_jwt` OFF); read back and compare. depends: T15
- [ ] **T17** **SC8 gate** (owner asks two questions; I read `desk_chat_memory` + logs). depends: T16
- [ ] **T18** Merge on green CI + clean Codex + owner go-ahead; watch the Pages build; owner cycles the three tiers; record the evidence. depends: T17
- [ ] **T19** Record what was verified, how and when (CLAUDE.md deploy facts, a `learnings.jsonl` entry for any trap met). depends: T18

## Consistency
| Requirement | Task(s) |
|---|---|
| FR1 three tiers, Haiku start/fallback | T3, T4, T5, T2 (parity), T10 |
| FR2/FR11 one setting, every question | T5, T7 |
| FR3 admin only, enforced in the data layer | T3, T15 (denial probes), T7 (`is_test`) |
| FR4/FR5 control and four states | T9, T10 |
| FR6 revert, honest wording | T9, T10, T11 |
| FR7 next question, no cache | T5, T7 (warm isolate) |
| FR8 fallbacks and logging | T5, T7 |
| FR9 proof | T5, T7, T9, T10, T17 |
| FR10 record, unforgeable stamps | T3, T15 |
| FR12 nothing else moves | T7 (existing checks stay green) |
| FR13 reach recorded | T12 |
| SC1 | T17, T18 · SC2 | T7, T10, T15 · SC3 | T7 · SC4 | T7 · SC5 | T10 · SC6 | T2, T10 · SC7 | T12 · SC8 | T17 |

Residuals stated, not hidden: `ask-gate-check` is not in CI; the PIN is still brute-forceable through the new RPCs exactly as through the existing ones (accepted residual in CLAUDE.md); Haiku's tool compatibility is unproven until T17; the SQL is verified against the live database when applied, not in CI.
