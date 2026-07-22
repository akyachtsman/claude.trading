# Code Review — Live Desk Assistant

Branch `claude/claude-md-architecture-update-j3pwsc` vs `origin/main`.

Reviewed:
- `supabase/functions/desk-ask/index.ts` — agentic edge function
- `supabase/migrations/desk_008_chat_memory.sql` — table + 2 SECURITY DEFINER RPCs
- `scripts/data.js` — `deskChatHistory` / `deskChatClear` / `deskAsk`
- `scripts/app.js` — `renderAsk` rewrite (transcript replay, sources footer, clear control)
- `styles/components.css` / `index.html` — ask panel styles + cache-bust
- `.github/scripts/ui-tests/tests/app.spec.js` — S15–S19

Anthropic API details were verified against the `claude-api` reference: for `claude-opus-4-8`,
`web_search_20260209` / `web_fetch_20260209` are the correct tool-type strings and need **no**
`anthropic-beta` header; `pause_turn` is resumed by re-sending the assistant content with no extra
user message; every `tool_use` block must have a matching `tool_result` in the following user turn.

## Important (80–89)

### 1. Partial `get_quote` batch produces a mismatched tool_result set → HTTP 400
`supabase/functions/desk-ask/index.ts:161-174` (confidence 85)

When the model emits more `get_quote` `tool_use` blocks in a single assistant turn than remain
under `MAX_TOOL_CALLS` (6), the inner executor loop breaks mid-batch:

```
for (const tu of quoteUses) {
  if (toolCalls >= MAX_TOOL_CALLS) break;   // stops early
  toolCalls++;
  ...
  results.push({ type: 'tool_result', tool_use_id: tu.id, ... });
}
messages.push({ role: 'assistant', content: msg.content });   // N tool_use blocks
messages.push({ role: 'user', content: results });            // fewer than N tool_result blocks
continue;                                                     // next call 400s
```

The Anthropic Messages API requires one `tool_result` for **every** `tool_use` block in the
preceding assistant message. Dropping the over-budget ones makes the next request invalid, so the
loop's `continue` hits `if (!apiRes.ok) return reply(502, …HTTP 400)` and the user gets
`model call failed (HTTP 400)` instead of an answer.

Reachable whenever the model requests, in one turn, more quotes than the remaining budget — e.g. a
"compare KO, PEP, MCD, SBUX, AAPL, MSFT, GOOG" style question (7 parallel `get_quote` calls),
or a second batch that starts with `toolCalls` already near 6.

Fix: emit a `tool_result` for **every** `quoteUse`, substituting an error result for ones past the
cap instead of skipping them, so the shapes always match:

```
for (const tu of quoteUses) {
  if (toolCalls >= MAX_TOOL_CALLS) {
    results.push({ type: 'tool_result', tool_use_id: tu.id,
      content: JSON.stringify({ ok: false, error: 'quote budget exhausted this turn' }),
      is_error: true });
    continue;
  }
  toolCalls++;
  const out = await getQuote(String(tu.input?.symbol ?? ''));
  results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out), is_error: out.ok === false });
}
```

## Verified correct (no action)

- **Agentic loop control flow** — `pause_turn` resumption (re-push assistant content, no extra user
  message) matches the documented pattern. Both caps (`MAX_RESUMES` for pauses, `MAX_TOOL_CALLS` for
  quotes) are honored; every `continue` increments one counter, so no infinite loop or unbounded
  cost past the caps. The only defect is the message-shape mismatch above, which fails closed (502),
  not an infinite loop.
- **Web tool versions** — `web_search_20260209` / `web_fetch_20260209` are correct for `claude-opus-4-8`;
  no beta header required. `stop_reason === 'refusal'` is handled before reading content.
- **Memory replay trimming** (`index.ts`) — after `rows.reverse()` (oldest→newest), the budget loop
  walks newest→oldest and `unshift`es user-then-assistant, yielding a valid ascending
  user/assistant/user/assistant sequence; it keeps newest and drops oldest when over
  `REPLAY_CHAR_BUDGET`. Direction and ordering are correct; no consequential off-by-one.
- **`desk_chat_clear` CTE** — the data-modifying CTE always executes, but with an unknown PIN `me` is
  empty, so `delete … using me where c.user_id = me.id` joins to zero rows and deletes nothing;
  the `case when not exists(select 1 from me)` returns `{ok:false}`. Correct — no accidental
  full-table delete.
- **RPC safety** — `pin` is a parameterized function argument fed to `extensions.digest`; no
  injection surface. Grants match the established pattern (`revoke all … from public`,
  `grant execute … to anon`); table is RLS deny-all with no policies, reached only via the SECURITY
  DEFINER RPCs or the service key inside the function. No new client-held secret; `ANTHROPIC_API_KEY`,
  service and anon keys stay in function env.
- **get_quote Origin forge** — setting the `origin` header on a server-side Deno `fetch` to
  `quote-proxy` (same project) is permitted (Deno, unlike browsers, allows it) and safe: it only
  returns public quote data, and the service key passed as `apikey` is accepted because quote-proxy
  is anon-callable. No secret crosses to the client.
- **Demo mode isolation** — `renderAsk` returns at `scripts/app.js:496` for `DESK.mode === 'demo'`
  (and at 501 for `!DESK.authed`) before any `deskChatHistory` / `deskChatClear` / `deskAsk` call, so
  demo stays fully offline. No live/tool/memory call is reachable in demo.
- **textContent compliance** — all transcript text goes through `el()` (which uses `textContent`);
  source links set `link.textContent` and validate `href` to `http:`/`https:` only via `new URL`,
  rejecting `javascript:`/`data:` from a web result or tampered memory row. No `innerHTML`.
- **Transcript render safety** — `deskChatHistory` returns `[]` on non-array/throw; the `.then`
  handler guards missing rows and is wrapped in `.catch(() => {})`; `appendSources` guards
  null/empty. No unhandled throw path.
- **Lamp + stamp** — the ask panel keeps its `#askLamp`; conversational panel has no date stamp,
  consistent with pre-existing design (not a regression).

## Noted, not blocking

- **Web-query privacy is system-prompt-enforced only.** The `SYSTEM` prompt instructs the model
  never to put position sizes / balances / account IDs into a web query. This is the documented,
  owner-accepted residual (spec.md FR-WEB4 / plan.md) — there is no server-side hook to rewrite
  server-tool queries, so a stronger control isn't available without dropping the server tools.
  No stronger control is being missed; flagging only for the record.
- **web_fetch'd URLs are not collected into `sources`** — only `web_search_tool_result` blocks feed
  the sources footer (`index.ts` collection loop). Matches the plan ("collect web_search_tool_result
  links"); a fetched-but-not-searched URL simply won't appear as a citation. Cosmetic completeness gap.
