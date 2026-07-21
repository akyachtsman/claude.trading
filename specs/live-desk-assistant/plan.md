# Plan — Live Desk Assistant (HOW)

Implements `spec.md` (v1) with its `## Clarifications`. Constitution: the five
imported directives. Stack is fixed by `global.md` (plain HTML + vanilla JS, no
build) + the existing Supabase/Deno edge-function layer — **no new framework,
no new client dependency.** Every file path below is real (verified against the
current tree).

## Architecture at a glance

| Piece | Where | Role |
|---|---|---|
| Memory store | new table `desk_chat_memory` (migration `desk_008`) | durable per-exchange history, RLS deny-all |
| Memory access | 2 SECURITY DEFINER RPCs (`desk_chat_history`, `desk_chat_clear`) + service-key reads/writes inside `desk-ask` | PIN-gated read for the client transcript; PIN-gated wipe; server-side replay + append |
| Assistant brain | rewritten `supabase/functions/desk-ask/index.ts` | agentic tool loop: replay memory → web_search/web_fetch + get_quote tools → directional answer with provenance → persist |
| On-demand data | existing `quote-proxy` `kind:'info'` (unchanged) | the `get_quote` tool calls it server-side |
| Panel | `scripts/app.js` `renderAsk`/`buildAskContext` + `scripts/data.js` wrappers | render transcript, submit, sources footer + freshness tags, clear control |

### Data flow (live, authed)
```
renderAsk() ──deskChatHistory(pin)──▶ RPC ──▶ desk_chat_memory ──▶ transcript rendered (textContent)
   │
owner asks ──deskAsk(pin,q,context)──▶ desk-ask edge fn
                                         1. verify PIN (existing salted-hash vs desk_users, service key)
                                         2. SELECT last ≤20 rows (≤30d), trim to ~8k tok  ── desk_chat_memory
                                         3. Anthropic call: system + replayed turns + snapshot context + q
                                            + tools[web_search_20260209(max_uses 5), web_fetch_20260209, get_quote]
                                         4. tool loop (≤6 calls): get_quote→quote-proxy kind:info;
                                            web_search/web_fetch run server-side on Anthropic; handle pause_turn (≤3 resumes)
                                         5. INSERT {question, answer, model, sources} ── desk_chat_memory
                                         6. return {ok, answer, sources[], model}
                                         ▼
                            renderAsk appends answer (textContent) + sources footer + freshness tags
```
Demo (`?demo=1`): unchanged — static explainer, **no** RPC/edge calls, analysis-only.

## Component 1 — Memory data layer  (FR-MEM, FR-SEC)

**Migration `supabase/migrations/desk_008_chat_memory.sql`** (source-of-record; applied via MCP `apply_migration` — see Deploy gate). Models on `desk_feed_cache`/`desk_006` (RLS deny-all) and the `desk_get_dashboard` SECURITY DEFINER pattern in `desk_007`.

Table:
```sql
create table public.desk_chat_memory (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.desk_users(id) on delete cascade,
  question    text not null,
  answer      text not null,
  model       text,
  sources     jsonb not null default '[]',   -- [{title,url}]
  created_at  timestamptz not null default now()
);
create index desk_chat_memory_user_time on public.desk_chat_memory (user_id, created_at desc);
alter table public.desk_chat_memory enable row level security;   -- deny-all: no policies → anon blocked
```
RLS: **no policies** → default-deny to anon (per `data.md`; matches `desk_feed_cache`). Access is only via (a) the two SECURITY DEFINER RPCs below, or (b) the `SUPABASE_SERVICE_ROLE_KEY` path inside `desk-ask` (bypasses RLS like `desk-heatmap`).

RPCs (same migration, `LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'`, `GRANT EXECUTE … TO anon`, PIN verified with the canonical `encode(extensions.digest(u.salt||pin,'sha256'),'hex')` compare from `desk_007:9-18`):
- `desk_chat_history(pin text) returns jsonb` — return the last **40** rows for the PIN's user as a JSON array `[{id,question,answer,sources,created_at}]` newest-last; empty array if PIN unknown (no leak).
- `desk_chat_clear(pin text) returns jsonb` — verify PIN, `DELETE` all rows for that user, return `{ok:true, cleared:<count>}`; `{ok:false}` if PIN unknown.

Rationale for RPC-for-read/clear but service-key-for-append: the client needs history at panel-load and a wipe button (both direct, PIN-checked, no answer involved) — RPCs fit the existing `deskLogin`/`deskGetDashboard` shape. The **append** happens only as the tail of a successful `desk-ask` turn, which already holds the service key and the verified PIN — no separate client write path (smaller attack surface; a client can never forge a memory row).

## Component 2 — `desk-ask` agentic rewrite  (FR-WEB, FR-DATA, FR-ADV, FR-TR)

Rewrite `supabase/functions/desk-ask/index.ts`. Keep: CORS `*`, `reply()`, the salted-hash PIN check (`:38-53`), the `ASK_MODEL || 'claude-opus-4-8'` default, `anthropic-version: 2023-06-01`.

**System prompt (relaxed).** Replace the current "Answer ONLY using the snapshot … never give buy/sell/hold advice" (`:17-26`) with a prompt that:
- Grants directional views (buy/sell/hold/trim/add) on the owner's own positions and any ticker — **must not refuse as "financial advice"** (FR-ADV1).
- Requires every directional call to be **grounded in data pulled/read this turn** (FR-ADV2) and to **attribute provenance** inline — mark each material claim as *snapshot*, *live HH:MM*, or *web* (FR-TR2).
- **Privacy scrub (FR-WEB4):** "Never place the owner's real position sizes, share counts, dollar balances, or account identifiers into a `web_search`/`web_fetch` query. Search by ticker/topic only." (Enforced by instruction — see residual.)
- Tells it to use `get_quote` for live prices/fundamentals and web tools for anything not on the page, and to keep answers focused.
- States the "not financial advice" label is shown to the user (kept client-side).

**Tools** (added to the request `tools` array):
- `{type:'web_search_20260209', name:'web_search', max_uses:5}` and `{type:'web_fetch_20260209', name:'web_fetch'}` — Anthropic **server-side** tools (Opus 4.8 supports the `_20260209` dynamic-filtering variants; no beta header). Results return in-response; the function does not execute them.
- `get_quote` — **user-defined** tool the function executes by calling `quote-proxy` `kind:'info'`. `input_schema: {symbol:string}`; the loop maps a `tool_use` for `get_quote` → `deskQuote`-equivalent server-side fetch → `tool_result` with the `info` object (last/change/bid/ask + earnings/cap/pe/52wk/yield) and its `asOf`.

**Turn assembly:** `system` + replayed prior exchanges (each stored row → a `user` turn `question` and an `assistant` turn `answer`, oldest→newest, trimmed to ≤20 rows / ≤30 days / ~8k-token estimate) + a final `user` turn carrying `Dashboard snapshot (JSON):\n<context>\n\nQuestion: <q>` (snapshot still inlined, `slice(0,30000)`, so on-page facts stay grounded — FR-WEB3).

**Agentic loop:** manual loop (mirrors `desk-brief`'s Anthropic call pattern at `desk-brief:82-105`): call → while `stop_reason==='tool_use'` and calls<6, execute `get_quote` tools, append `tool_result`s, re-call; on `stop_reason==='pause_turn'` (server-tool pause) re-send to continue, ≤3 resumes; then extract text + collect `web_search_tool_result` links into `sources`. Caps (FR cost clarification): `web_search max_uses:5`, tool-loop `≤6`, resumes `≤3`, `max_tokens:2048`.

**Response:** `{ok:true, answer, sources:[{title,url}], model}`; on failure `{ok:false, error}` (unchanged shape + `sources`). After a successful answer, INSERT the exchange into `desk_chat_memory` (service key). A memory read/write failure is **non-fatal** — logged, answer still returned (degraded continuity, FR-TR3).

## Component 3 — Panel client  (FR-MEM5, FR-TR1/2, design signature)

`scripts/data.js`: add `deskChatHistory(pin)` and `deskChatClear(pin)` (RPC POSTs, same shape as `deskLogin` `:317-337`). `deskAsk` (`:341-354`) unchanged signature; now also surfaces `res.sources`.

`scripts/app.js` `renderAsk()` (`:488-542`), live+authed branch only:
- On render, call `deskChatHistory(pin)` and populate `.ask-thread` with prior exchanges (each `q`/`a` via `el()` → `textContent`; CLAUDE.md:188). Scrollable, newest at bottom.
- Add a small **"Clear conversation"** control in the panel header area → `deskChatClear(pin)` → empties the thread. Confirm before wiping (states the consequence, per `design.md` confirmation-dialog rule).
- Submit handler: on `res.ok`, append answer (`el('p','ask-a',res.answer)`) **plus** a `.ask-sources` footer listing `res.sources` links and inline freshness tags. Provenance text ("snapshot" / "live HH:MM" / "web") comes from the model's answer; the footer renders the structured `sources` array. All `textContent`.
- `#askLamp` stays; keep the `ai-disclaimer` paragraph verbatim (FR-ADV3).

`index.html`: bump the shared `?v=` cache-bust token (app.js + data.js changed; CLAUDE.md:29).

## Component 4 — Demo mode  (FR-DEMO)
Unchanged. `renderAsk` demo branch (`:493-498`) still shows the static explainer, no input, no calls; analysis-only (FR-ADV4). S5 demo-lamp coverage stays green because the demo lamp and offline behavior are untouched.

## Key decisions & trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Append memory server-side (service key), read/clear via RPC | Client can never forge a memory row; read/clear are answer-free PIN checks that fit the existing RPC shape | Two access paths to one table (documented) |
| Snapshot still inlined alongside tools | On-page facts stay grounded even as web/live are added (FR-WEB3) | Larger prompt; bounded by the existing 30k slice |
| Web privacy = system-prompt scrub, not a hard filter | The model composes server-tool queries; there's no request hook to rewrite them | Residual: a determined model could still emit a size — mitigated by instruction + keeping the strongest signal (dollar balances) out of the *first* search unless the owner's question requires it. Documented as accepted residual. |
| Manual tool loop capped at 6 + web_search max_uses 5 | Bounds cost/latency (clarification 7) without a beta task-budget dependency | A complex question may stop short and answer with what it has (labeled) |
| Keep `claude-opus-4-8` | Clarification 7; matches the rest of the desk | — |

## Failure modes (must-cover)

| Failure | Behavior |
|---|---|
| Anthropic API 5xx/timeout | 502 → client shows error; **no** memory write |
| `get_quote`→quote-proxy fails | tool_result `is_error:true` → model says the fetch failed, answers from rest (FR-TR3) |
| web_search/web_fetch error | error result block → model degrades, notes it couldn't verify |
| `pause_turn` never resolves in ≤3 resumes | return partial answer, labeled incomplete |
| memory read (replay) fails | skip replay, answer without continuity (logged) |
| memory write fails | answer still returned; row lost (logged) — no user-facing error |
| `stop_reason==='refusal'` | 200 `{ok:false,error:'The model declined this question.'}` (unchanged) |
| PIN wrong / brute force | 401; accepted residual (RLS can't rate-limit) — unchanged |
| Cost runaway | impossible past the 6-call / 5-search / 2048-token caps |

## Security (FR-SEC) & residuals
- New table is RLS deny-all; anon reaches it only through the two PIN-checked SECURITY DEFINER RPCs or the service-key `desk-ask` path — no new client secret (FR-SEC3). Dedicated project only.
- Real balances live only in `desk_chat_memory` behind the PIN and in the model context; never in the repo/served files (FR-SEC2). The **new** exfil surface is outbound web-tool queries — mitigated by the scrub instruction (documented residual above; the honest statement to the owner is: instruction-enforced, not hard-enforced).
- Anon key stays public-by-design; PIN + RLS remain the boundary.

## Testing (Project-Specific Test Scenarios)
Demo suite (S1–S5, S9, S12, S13) must stay green untouched. New **live-gated** scenarios (skip while demo-only, like S10/S11/S14) to add in `tasks`:
- S15 — memory round-trip: ask, reload, ask a follow-up referencing it → prior context used; transcript renders.
- S16 — research: a snapshot-absent question returns an answer with ≥1 source link.
- S17 — data tool: a not-on-page ticker returns a live quote/fundamentals.
- S18 — advice posture: "what would you do with X" returns a directional call, not a refusal; disclaimer still present.
- S19 — clear-history: clear control empties the thread and a reload shows none.
Gates: `npx html-validate index.html`, `node .github/scripts/check-contrast.js` must pass.

## Deploy & migration — GATED ON OWNER APPROVAL
Two out-of-band actions, each requiring explicit owner sign-off before execution (Safety Rules; CLAUDE.md):
1. **Apply migration `desk_008`** to the dedicated project (`kwugzhyfjevzwgplhtsd`) via MCP `apply_migration`.
2. **Deploy the rewritten `desk-ask`** via MCP `deploy_edge_function`.
Client changes (`app.js`/`data.js`/`index.html`) ship the normal way — PR to `main`, Pages deploy. The client is written to degrade gracefully if the backend isn't deployed yet (memory/tools simply unavailable, panel still answers or shows a clear error), so the PR can merge before the backend flip if desired — but the feature isn't "live" until both gated steps run.

## Constitution-fit checklist
- `global.md`: no build, no new dependency, `textContent` for all dynamic DOM ✅
- `data.md`: RLS default-deny + SECURITY DEFINER PIN RPCs; service key server-side only ✅
- `design.md`: panel keeps lamp + as-of stamp; confirm-before-clear states the consequence ✅
- `test.md`: demo suite stays green; new live-gated scenarios named ✅
- `git.md`: feature branch → PR → review → merge ✅

## Open risks
- Web-query privacy is instruction-enforced (residual, disclosed above).
- Latency: a multi-tool turn is seconds, not sub-second — the panel must show an "Asking…" busy state (already present) and could show tool progress (nice-to-have, not v1).
- Anthropic web-tool cost per search — bounded but non-zero; the caps keep a single turn cheap.
