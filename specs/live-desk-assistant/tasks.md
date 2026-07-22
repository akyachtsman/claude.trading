# Tasks — Live Desk Assistant

Derived from `plan.md`. Ordered, dependency-aware; `[P]` = parallel-safe with
its siblings. Each task ≈ 2–5 min: change → verify → (commit). Gates
(`npx html-validate index.html`, `node .github/scripts/check-contrast.js`,
`node --check`) run on any task that touches served files. Two tasks are
**GATED** — they execute against the dedicated Supabase project only after
explicit owner go-ahead at that moment.

## A. Backend — memory data layer
- **T1** — Write `supabase/migrations/desk_008_chat_memory.sql`: `desk_chat_memory` table (id identity, user_id fk→desk_users on delete cascade, question, answer, model, sources jsonb default '[]', created_at) + index `(user_id, created_at desc)` + `enable row level security` (no policies = deny-all). Source-of-record file only; do not apply yet. Deps: none.
- **T2** — In the same migration, add SECURITY DEFINER `desk_chat_history(pin text) returns jsonb` — verify pin via `encode(extensions.digest(u.salt||pin,'sha256'),'hex')`, return last 40 rows for that user as a JSON array (newest last), `[]` if pin unknown; `GRANT EXECUTE TO anon`. Deps: T1.
- **T3** — In the same migration, add SECURITY DEFINER `desk_chat_clear(pin text) returns jsonb` — verify pin, `DELETE` all rows for that user, return `{ok, cleared}`; `{ok:false}` if pin unknown; `GRANT EXECUTE TO anon`. Deps: T1.
- **T4 — GATED** — Apply `desk_008` to the dedicated project (`kwugzhyfjevzwgplhtsd`) via MCP `apply_migration`. **Requires explicit owner go-ahead at execution.** Deps: T1–T3.

## B. Backend — desk-ask agentic rewrite (`supabase/functions/desk-ask/index.ts`)
- **T5** — Replace the `SYSTEM` prompt (`:17-26`): allow directional views (buy/sell/hold/trim/add), require every call grounded in data pulled/read this turn, require inline provenance (snapshot / live HH:MM / web), forbid private sizes/balances/account-ids in web queries, tell it to use `get_quote` + web tools. Deps: none.
- **T6** — Add tool defs to the request: `{type:'web_search_20260209',name:'web_search',max_uses:5}`, `{type:'web_fetch_20260209',name:'web_fetch'}`, and a `get_quote` user tool (`input_schema:{symbol}`). Deps: T5.
- **T7** — Implement the `get_quote` executor: on a `get_quote` `tool_use`, fetch `quote-proxy` `kind:'info'` server-side, return a `tool_result` with the `info` object + `asOf`; on fetch error return `tool_result` `is_error:true`. Deps: T6.
- **T8** — Wrap the Anthropic call in the manual agentic loop (mirror `desk-brief:82-105`): while `stop_reason==='tool_use'` and calls<6 → run `get_quote`s, append results, re-call; handle `pause_turn` (≤3 resumes); collect `web_search_tool_result` links into `sources`; `max_tokens:2048`. Deps: T7.
- **T9** — Memory replay: after PIN auth, `SELECT` last ≤20 rows (≤30d) from `desk_chat_memory` via service-key PostgREST, trim to ~8k-token estimate, prepend as alternating user/assistant turns before the snapshot+question turn. Non-fatal on failure (skip replay, log). Deps: T8.
- **T10** — Memory append: after a successful answer, `INSERT {user_id, question, answer, model, sources}` via service key. Non-fatal on failure. Extend the success response to `{ok:true, answer, sources, model}`. Deps: T9.

## C. Client — data layer (`scripts/data.js`)
- **T11 [P]** — Add `deskChatHistory(pin)` — POST `/rest/v1/rpc/desk_chat_history` (anon key), return the exchanges array (mirror `deskLogin` `:317-337`). Deps: none.
- **T12 [P]** — Add `deskChatClear(pin)` — POST `/rest/v1/rpc/desk_chat_clear`, return `{ok,cleared}`. Deps: none.
- **T13 [P]** — Confirm `deskAsk(pin,q,ctx)` surfaces `res.sources` (shape already `{ok,answer,...}`; add nothing if pass-through). Deps: none.

## D. Client — panel UI (`scripts/app.js` `renderAsk` `:488-542`; styles)
- **T14** — On the live+authed render, call `deskChatHistory(pin)` and populate `.ask-thread` with prior exchanges (each q/a via `el()` → textContent), scrollable, newest at bottom. Reuse the height cap already in place. Deps: T11.
- **T15** — Submit handler: on `res.ok`, append the answer + a `.ask-sources` footer (links/titles from `res.sources`) + inline freshness tags; all `textContent`. Deps: T13.
- **T16** — Add a confirm-first **"Clear conversation"** control in the panel header → `deskChatClear(pin)` → empty `.ask-thread`. Confirmation states the consequence (design.md rule). Deps: T12, T14.
- **T17 [P]** — Add `.ask-sources` + freshness-tag styles to `styles/components.css` using existing tokens; keep the `.stamp`/lamp signature. Deps: none.
- **T18** — Bump the shared `?v=` cache-bust in `index.html` (js/css changed). Deps: T14–T17.

## E. Demo & safety
- **T19 [P]** — Verify `renderAsk` demo branch (`:493-498`) still shows the static explainer with no history/tool/clear calls; add a guard so `deskChatHistory`/`deskChatClear` are never invoked in demo. Deps: T14, T16.

## F. Backend deploy
- **T20 — GATED** — Deploy the rewritten `desk-ask` via MCP `deploy_edge_function` to the dedicated project. **Requires explicit owner go-ahead at execution.** Deps: T4, T10.

## G. Tests (`.github/scripts/ui-tests/tests/app.spec.js`)
- **T21 [P]** — Add live-gated scenarios S15 (memory round-trip), S16 (research returns a source), S17 (live quote for an off-page ticker), S18 (directional answer, not a refusal; disclaimer present), S19 (clear empties the thread). Each skips while demo-only (mirror S10/S11/S14). Deps: T14–T16.
- **T22** — Confirm the demo suite (S1–S5, S9, S12, S13) still passes untouched. Deps: T18, T19.

## H. Docs & QA
- **T23 [P]** — Update `CLAUDE.md` Application Architecture: `desk-ask` now PIN-gated **agentic** Q&A (memory replay + web_search/web_fetch + get_quote, directional posture), new `desk_chat_memory` table + `desk_chat_history`/`desk_chat_clear` RPCs; add S15–S19 to the scenario table. Deps: T5–T10.
- **T24** — Run `directives-toolkit:qa-pipeline` (test-verifier → ui-tester → code review → pr-readiness) over the diff; fix findings. Deps: all client tasks + T21–T23.
- **T25** — Mark PR #142 ready for review once green; merge per the inherited git.md lifecycle. Deps: T24.

## Notes
- Client (C/D) is authored/committable **before** the gated backend (T4, T20) — the panel degrades gracefully if the backend isn't deployed yet (`plan.md` Deploy section).
- T4 and T20 are the only owner-gated steps; everything else ships via the normal PR flow.
