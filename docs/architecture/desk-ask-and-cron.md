# Assistant, IBKR sync and scheduled asks

`desk-ask` (agentic assistant: PIN, cron-secret, or — since 2026-10-04 — an OPEN question), `desk-ibkr-sync`, `desk-cron-ask` and the retired `desk-brief` (`supabase/functions/`, `app.js` Ask panel; scenarios S15-S19, S29, S32, S33, S59, S60).

## Open questions (no PIN) and the remembered PIN — owner, 2026-10-04

> "remove the PIN for ask the desk, keep it for accounts at the bottom but leave it unlocked for now"

Asked back before building (both answers the owner's): Ask = **open + a daily cap** (not "fully open", not "remember the PIN"); accounts = **remember the PIN on this device** (not "open to everyone", which would have made real balances readable by anyone holding the public anon key).

| Piece | What it does | Where |
|---|---|---|
| Three doors into `desk-ask` | PIN (the owner, as before), `x-cron-secret` (`desk-cron-ask`, as before), or NO credential — an open question. `anonymous = !viaCron && !pin`, decided once; a PIN that is sent and wrong is a 401, never a downgrade | `desk-ask/index.ts` `handle()` |
| The open gate | exact `Origin` = `SITE_ORIGIN`, then ONE atomic `desk_open_ask_take(p_day, p_cap)` (`desk_020`): `INSERT … ON CONFLICT (day) DO UPDATE SET n = n + 1 WHERE n < cap`. Anything but a definite `true` refuses: HTTP error → 503, unreachable → 5xx, `false`/`null`/other → 429 (fail closed) | `openAskCap()`, `PT_DAY`, the `if (anonymous)` block |
| The cap | function secret `OPEN_ASK_DAILY_CAP`: UNSET = 25 per Pacific day, across all visitors; a whole number ≥ 1 = that; `0`, blank or junk = the open path is OFF (answers the old 400). Change it in the Supabase dashboard — no deploy. PIN and cron questions are never counted | `openAskCap()` |
| What a visitor is answered as | the PUBLIC `DEFAULT_SYSTEM` (in this repo) — the owner's stored `desk_system_prompt` is never read — with `OPEN_SESSION_NOTE` LAST (the reader is not the owner; no access to accounts or saved conversations); no saved conversation read (`userId` null) or written; a forged `accounts` block is deleted from the snapshot; `verify` ignored; the reply carries `open: true` | the `if (userId)` guards, `delete ctx.accounts`, `verifyThisTurn` |
| The client | `deskAsk` sends no `pin` key for a visitor; `renderAsk()` draws the composer whether or not the desk is unlocked — history replay, Clear, Verify, ⏱ and ⚙ only when `DESK.authed` (they are PIN RPCs); a stopped open question says it is not saved | `data.js` `deskAsk`, `app.js` `renderAsk` |
| The remembered PIN | `sessionStorage 'desk_pin'` is still the working copy; `localStorage 'desk_pin_device_v1'` outlives the tab. Boot: tab's PIN else the device's → `desk_login` → success re-seeds the tab and writes the device copy; a definite refusal forgets BOTH; a failed call (blip) forgets neither. Unlock writes both, a wrong PIN neither, **Lock forgets both** | `data.js` `deskPinDeviceGet/Set`, `deskPinForget`; `app.js` `boot()`, `renderLockedPanels()`, the Lock button |

**Why the cap is a SQL function.** Every desk-ask request runs on a fresh isolate, so a counter cannot live in memory, and a counter read and then written back lets a burst all read "0 so far": 100 parallel requests would all pass. The single statement serialises on the row lock; `tools/ask-gate-check.mjs` fires 40 parallel questions at a cap of 5 and requires exactly 5 answers and exactly 40 RPC calls (the function never touches the counter table itself).

**What this is not.** The Origin check is browser-enforced and unspoofable from page JS but forgeable by a script, exactly like `quote-proxy`'s: a speed bump that keeps other sites' visitors off the quota. The cap is the real bound — at most `OPEN_ASK_DAILY_CAP` questions a day, each up to `MAX_ITERS` tool calls — and it is the same for a forged Origin. A visitor is NOT given the owner's live prompt — that row is PIN-gated and the only copy of the current text, and a visitor can coax a model into repeating whatever it was given (flagged by the security review, 2026-10-04) — so a visitor gets the code's `DEFAULT_SYSTEM`, the day-one assistant, without the owner's current rules; handing visitors the live prompt instead is a one-line change that needs the owner to ask for it, knowing the text would then be retrievable. The accounts are NOT open: `desk_get_dashboard` and every other PIN RPC are unchanged, and nothing in this repo or `config.js` holds a PIN.

**Deploy order and rollback (owner approval at each step, per CLAUDE.md).** (1) apply migration `desk_020` to the dedicated project; (2) deploy `desk-ask` (`verify_jwt` OFF, as before; the previous Supabase version is the rollback — it simply rejects a PIN-less request with the old 400); (3) merge the client (an old server answers a PIN-less question 400 `pin and question are required`, which a visitor would see). To switch the open path off without a deploy: set `OPEN_ASK_DAILY_CAP=0`. `desk_020`'s `-- revert:` line says how to drop it (redeploy `desk-ask` without the open path first).

**Done 2026-10-04 (owner-approved).** `desk_020` was applied with the Supabase MCP's `execute_sql` (logged as `20261004194006`) — the function WITHOUT an in-body prune, because the MCP holds any statement that contains a destructive keyword (`delete`, `drop`, even inside a string or a function body) for confirmation and a held call just times out at 60 s with nothing executed; that is a guard, not a fault, and it was not evaded — keep such words out of migrations you apply that way, split the statement, or run it from the dashboard. The table gains ~1 row a day and is tidied by hand if ever wanted. `desk-ask` is Supabase version 28 (`verify_jwt` OFF), byte-compared against the repo file after deploying; rollback = redeploy `index.ts` as of `076e2d2`, or `OPEN_ASK_DAILY_CAP=0`. Live smoke test the same day: no Origin and a foreign Origin → 403, empty question → 400, a wrong PIN → 401 (none of them counted), one real open question with the site's Origin → 200 and the day's counter at 1.

**Verified how.** `node tools/ask-gate-check.mjs --mutants` (12 checks, 21 single-line mutants — every door, the cap, the Pacific day roll, the burst, the off switch, fail-closed, no memory, no accounts, no stored prompt, no verify); S59 (the open panel and the wire body) and S60 (the remembered PIN through the real boot) in `app.spec.js`. The SQL itself is exercised against the live database when the migration is applied, on a scratch day key that was removed afterwards.

  rendered as `Invalid Date`. PIN-gated: `desk-ask` — an **agentic**
  desk assistant (not plain Q&A): replays prior exchanges from `desk_chat_memory`
  (≤20 turns / ≤30d / ~8k-char budget), runs a bounded tool loop (≤12 calls,
  ≤3 pause resumes) with `web_search`/`web_fetch` + `get_quote` (calls
  `quote-proxy kind:'info'` server-side) + `get_technicals` (calls
  `quote-proxy kind:'daily'` + a best-effort `kind:'intraday'` graft — the
  server-side port of `app.js`'s `graftTodayBar()`, so a live-session reading
  matches the charts — and computes RSI(14, Wilder) + the Pro 1 SWING
  Stochastic 14-3-3 + the Pro 2 LONG-TERM weekly-scale Stochastic 92-15-15, all
  from one fetch), gives **directional** views on the owner's positions (owner
  opt-in 2026-07-21; the "not financial advice" label stays), attributes
  provenance, and appends each exchange back to memory.
  **The tool loop must CARRY THE CODE-EXECUTION CONTAINER** (owner report
  2026-08-20: `model call failed (HTTP 400) — container_id is required when
  there are pending tool uses generated by code execution with tools`). The
  desk never asks for code execution, but `web_search_20260209` /
  `web_fetch_20260209` filter their results inside a container ("dynamic
  filtering") that the API provisions on its own; a response whose
  code-execution tool use is still pending — a `pause_turn` mid-search is the
  usual way — can only be continued by a request naming that container. So
  `containerId` latches `msg.container.id` the moment one appears and is sent
  as the top-level `container` on every later call of the turn, including the
  forced-search retry and the grounding-check revision, which resume the same
  conversation. It is never cleared mid-turn, and never sent on the first call
  (that is what asks for a fresh one). Without it the turn does not degrade —
  the request is invalid and the whole question dies. The system prompt
  itself is **owner-editable at runtime**: `desk_system_prompt` (`desk_009`,
  RLS deny-all, singleton row) is read live on every request via the PIN RPCs
  `desk_get_system_prompt`/`desk_set_system_prompt` (dashboard: the ⚙ button
  beside Ask-the-desk), falling back to the code's `DEFAULT_SYSTEM` constant
  only if that read fails. **Residual (Codex review, PR #182):** the
  `desk_009` migration only seeds the table's ORIGINAL day-one prompt text —
  every rule the owner has since added or edited live (the itemized rule
  numbering, the Stochastic Framework, BUY/SELL SIGNALS, brevity, etc.) exists
  only in that live row, not in any migration or repo file. A from-scratch
  restore via migration replay alone would silently revert to the original
  seed text, not the current live prompt; recovering the actual current
  prompt depends on Supabase's own data backup/PITR, not on the repo. This is
  accepted as the tradeoff for genuine self-service editing (no code
  deploy needed to change behavior) rather than patched via a migration
  update, since an unconditional seed-update would itself risk overwriting
  the owner's live customizations on a future replay. Web-query privacy
  (never sending real position sizes to search) is system-prompt-enforced,
  not hard-filtered. **A failed system-prompt read disables Save** (audit
  2026-09-29): the ⚙ modal used to leave an empty editable textarea, so Save
  overwrote the live prompt with nothing. Likewise the scheduled-ask editor's
  Add/Save stay off after a failed load (a save from an empty roster would replace
  it), a failed history load or Clear shows an error instead of an empty thread, and
  Save is guarded against a double click.
  **THE ASSISTANT IS HANDED TICKERS, NEVER MONEY** (owner ruling 2026-08-12,
  shipped 2026-08-18): `buildAskContext()` sends `label` plus
  `positions:[{sym, dayPct}]` and nothing else — `nav`, `cash`, `dayPnl`,
  `totalUnrealized` and the per-position `qty`/`mkt`/`unrl` are all withheld.
  The ruling was "I don't want this guy to be concerned about my liquidity or
  look at my account balance. Just give me cold, hard fact regarding buy or
  sell the stock." **Withholding is the enforcement point, NOT a system-prompt
  rule** — a prompt asks the model not to dwell on a number it can still read,
  whereas removing it leaves nothing to weigh; this is why the assistant used
  to answer "your position is the largest thing in the account going in", which
  was correct reasoning over data it should never have had. Symbols stay, so
  "should I sell my <ticker>" still knows that ticker is held; `dayPct` stays with them
  because it is the ticker's own market move, public data about the stock
  rather than a fact about the account. The four stored `desk_chat_memory` rows
  carrying portfolio-aware phrasing were edited IN PLACE on 2026-08-12 (not
  deleted — they also hold the per-ticker analysis), and a broad scan
  that flagged 7 of 11 rows was **all false positives**: "balance sheet" and
  "cash flow" about COMPANIES, and `$145` as a price target. Deleting on
  that scan would have destroyed the analysis the ruling exists to keep.
  **Interrupting a question** (`.ask-stop` + `askAbort`, owner request
  2026-08-01) — the tool loop can reach 12 calls, so a stalled question had no
  exit but waiting. Stop aborts the fetch via an `AbortController` threaded into
  `deskAsk`. It severs **this tab's wait only**: the edge function runs to
  completion regardless, so the Claude quota is spent either way AND the
  exchange still reaches `desk_chat_memory` — the stopped note in the thread
  says so out loud, because a silent stop means the answer reappears on the next
  reload looking like a bug. Two deliberate choices: Stop is a **separate button**
  rather than Ask changing role (a control that swaps jobs under the cursor gets
  pressed as a re-send), and the **composer stays enabled** while in flight,
  since someone reaching for Stop wants to retype — `askBusy` still blocks a
  second send. Genuinely cancelling the SERVER run would need `desk-ask` to
  honour `req.signal` plus a deploy; not done.
  Cron-secret-gated: `desk-ibkr-sync` (Flex → tables; the token never appears in
  a log, error or reply — `scrub()` — a Flex statement URL is followed only on https
  + `interactivebrokers.com`, and a network/timeout/5xx from Flex is "not-ready", not
  "failed"). Scheduled by pg_cron
  (`desk_005` migration): sync 22:35/09:35 UTC — dual-slot because IBKR
  statements roll overnight. Also cron-secret-gated: **`desk-cron-ask`**
  (`desk_018`, owner ruling 2026-08-11) — **the desk waking ITSELF up.** The
  scheduled-ask roster used to be a `setInterval` in `app.js`, so it only fired
  while the dashboard was open, which is exactly when the owner is already at
  the desk and could type the question; the ruling was that a cron task's only
  value is waking itself at a set time and delivering a market summary. It ticks
  **every 5 minutes** and the FUNCTION decides what is due, because pg_cron's
  clock is UTC and the roster's is **Pacific** — a fixed UTC line would drift an
  hour at every DST change and deliver the 8am summary at 7am for half the year.
  Due-ness is wall-clock, not elapsed-time, arithmetic (has the PT clock passed
  the slot, and was the last run at or after it on this PT date), which is exact
  on the two DST days that elapsed-time comparison gets wrong; `CATCHUP_MIN` (90)
  both lets a missed tick still deliver and stops a row added at 10am from
  back-firing an 8am slot. It stamps `last_run_at` **before** calling `desk-ask`,
  so a run that outlives the next tick or throws cannot be started twice, and it
  fires **one row per tick** — two rows due together would be back-to-back tool
  loops. It assembles the whole dashboard server-side (accounts from tables, the
  five public feeds, plus **Pro 1 / Pro 2 stochastics and RSI computed here** off
  the `desk-charts` bars — the model's own `get_technicals` is capped at 12 tool
  calls against a 25-symbol roster, so a question about "the watchlist" would
  otherwise get readings for the first few names and silence for the rest), then
  hands it to `desk-ask`, which appends the exchange to `desk_chat_memory` as
  usual — the table the Ask thread already replays from, so the summary is simply
  there when the desk is opened. **`desk-ask` therefore takes TWO auth paths**:
  the browser's PIN, or `x-cron-secret` resolving to the single owner row. The
  PIN is never stored server-side (only its salted hash), so a scheduled run has
  nothing to replay; the secret lives in function env + Vault and never reaches
  the client, so this widens nothing the browser can reach. The context cap in
  `desk-ask` went 30k → **80k characters** at the same time: PR #241's watchlist
  + heatmap + stochastics had quietly outgrown it, and the slice was cutting the
  snapshot off mid-string with the last sections (heatmap, chart readings) the
  first to vanish. The watchlist is capped at 300 symbols total (25 unresolved names
  per list, plus counts) and is emitted LAST, so any residual truncation eats it
  first. `desk-ask` has a 350s turn deadline (each model call gets min(150s, what
  remains)) and answers a JSON+CORS 504 when it runs out; `desk-cron-ask` waits about 200s
  (kept under `desk_018`'s 240s pg_net timeout — raising both needs a migration the
  owner applies) and records "ask timed out; answer may
  still land in the thread" — the exchange is still archived. The memory append
  checks its response (`memoryStored`/`memoryError`), `checked.verified` is true only
  when the grounding check actually COMPLETED (`verifyIncomplete` otherwise — a timed-out
  or skipped check used to be stored as verified), and a failed snapshot read
  lists `accounts` in `feedsUnavailable` instead of reading as "no holdings".
  (The scheduled twice-daily AI brief — `desk-brief`,
  its `desk-brief-evening`/`desk-brief-morning` cron jobs, and the dashboard
  panel that rendered it — was retired 2026-07-23, owner request: Ask-the-desk
  already covers the same ground on demand. The edge function and
  `desk_ai_briefs` table are left in place, unscheduled, in case the feature
  returns.)
