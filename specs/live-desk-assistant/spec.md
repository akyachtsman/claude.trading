# Spec — Live Desk Assistant (Ask-the-desk upgrade, v1)

WHAT and WHY only. HOW lives in `plan.md`. Constitution: the five imported
directives (`global.md`, `git.md`, `design.md`, `test.md`, `data.md`).
Supersedes the behavior of the current stateless Ask-the-desk panel; does not
change any other panel.

## Problem
Today "Ask the desk" is a **stateless, snapshot-only Q&A box**. It has no
memory between messages, sessions, or days; it can only answer from the current
page snapshot (a deliberate FR-AI4 grounding guard); and it refuses anything
resembling market advice. For the owner's actual use — a working trading desk —
this is close to useless: it can't remember yesterday's discussion, can't look
anything up, and won't give a view. The owner has asked to turn it into a real
desk assistant.

## Users
- **Owner (only user):** the sole authenticated user, behind the desk PIN, on
  desktop and iPad Safari. There is no multi-tenant/per-user model — one PIN,
  one owner, one shared history.

## Goals / why
- Make the assistant **remember** across sessions and days so a conversation
  builds instead of resetting.
- Let it **research** current information beyond the frozen page snapshot.
- Let it **pull live data on demand** (quotes, fundamentals) for any ticker,
  not only what the snapshot happens to contain.
- Let it give the owner **directional, opinionated views** on the owner's own
  real positions — the owner has explicitly opted into buy/sell commentary on
  their private desk.
- Keep the owner able to **trust what they're reading**: always distinguishable
  which parts came from the snapshot, from live fetches, or from the web, and
  how fresh each is.

## User stories
- **US1 — Continuity:** As the owner, I ask a follow-up tomorrow that refers to
  "the position we discussed" and the assistant knows what I mean, because it
  remembers our prior exchanges.
- **US2 — Lookup:** I ask about a current event, an earnings result, or a
  number that isn't on the page, and the assistant searches the web and answers
  with sources instead of saying "that isn't in the snapshot."
- **US3 — Live pull:** I ask about a ticker I don't hold and the assistant
  fetches its live quote and fundamentals on demand rather than being limited to
  the snapshot's tiles.
- **US4 — A view:** I ask "what would you do with my AMZN here?" and get a
  clear directional answer grounded in real data — not a refusal — with the
  standard "AI-generated · not financial advice" label still present.
- **US5 — Provenance:** For any answer, I can tell which claims rest on the
  snapshot, on a live fetch, or on the web, and how stale each source is, so I
  never mistake old data for live.
- **US6 — Demo safety:** In demo mode (`?demo=1`) the panel still works for a
  visitor with deterministic behavior and **no** live network calls, memory
  writes, or web searches.

## Functional requirements

### Persistent memory (FR-MEM)
- FR-MEM1: Each completed Ask-the-desk exchange (owner question + assistant
  answer, with timestamps) is persisted to the desk's own backend so it
  survives page reloads, new sessions, and new days.
- FR-MEM2: On a new question, prior exchanges are replayed into the assistant's
  context so it can reference them, within a bounded window
  `[NEEDS CLARIFICATION: how many prior turns / how far back is replayed, and is
  it capped by count, age, or token budget?]`.
- FR-MEM3: Memory is **owner-private** — readable/writable only behind the desk
  PIN, never exposed to an unauthenticated caller and never written into the
  public repo or served files.
- FR-MEM4: The owner can **clear** the stored conversation
  `[NEEDS CLARIFICATION: is a "clear history" control in scope for v1, and does
  it wipe all history or a range?]`.
- FR-MEM5: The panel presents continuity visibly
  `[NEEDS CLARIFICATION: does the panel render the prior transcript on load, or
  just silently use it as context while showing only the latest exchange?]`.

### Web research (FR-WEB)
- FR-WEB1: The assistant can search the web and fetch page content to answer
  questions the snapshot can't, returning **sources** (links/titles) for
  web-derived claims.
- FR-WEB2: Web research is **live-mode only**; it never runs in demo mode.
- FR-WEB3: Because external browsing relaxes the FR-AI4 snapshot-only grounding
  guard, the answer must keep snapshot facts and web facts **distinguishable**
  (see FR-TR) rather than blending them into one unattributed claim.
- FR-WEB4: What the assistant is allowed to send to external search/fetch is
  bounded for privacy `[NEEDS CLARIFICATION: may the assistant include the
  owner's private holdings / position sizes in a web-search query, or must
  queries be scrubbed of private position data? The watchlist is already public,
  but real balances/sizes are private by project rule.]`.

### Live data tools (FR-DATA)
- FR-DATA1: The assistant can pull a **live quote** (last / day change / bid /
  ask) for an arbitrary ticker on demand via the desk's existing quote path.
- FR-DATA2: The assistant can pull **fundamentals** (next earnings, market cap,
  P/E, 52-week range, dividend yield) for an arbitrary ticker on demand.
- FR-DATA3: Live-pulled data carries its own fetch time so its freshness is
  visible in the answer (see FR-TR).
- FR-DATA4: The set of data tools is scoped to what the desk already serves
  `[NEEDS CLARIFICATION: is v1 limited to quote + fundamentals via the existing
  quote path, or also heatmap/news/index feeds?]`.

### Advice posture (FR-ADV)
- FR-ADV1: The assistant **may give explicit directional (buy / sell / hold /
  trim / add) views** on the owner's own positions and on arbitrary tickers —
  it must not refuse on the grounds that it is financial advice.
- FR-ADV2: Every directional call must be **grounded in cited data** it actually
  pulled or read this turn (snapshot, live fetch, or web) — no calls from thin
  air.
- FR-ADV3: The existing **"AI-generated · not financial advice" disclaimer
  remains** as a persistent, factual label on the panel; it is not removed and
  not weakened.
- FR-ADV4: Directional calls are the owner-private desk's behavior only; this
  posture is not exposed to the demo/public visitor
  `[NEEDS CLARIFICATION: in demo mode, should the assistant still demonstrate
  directional language on fake data, or stay analysis-only for public visitors?]`.

### Trust & provenance (FR-TR)
- FR-TR1: The panel keeps its **data-state lamp + as-of stamp** (the design
  signature) — with memory + live tools + web, the lamp/stamp must still convey
  the freshness of what backs the current answer.
- FR-TR2: Within an answer, the **source of each material claim is
  attributable** — snapshot vs live-fetch (with fetch time) vs web (with link) —
  so the owner can weight it. Exact presentation is a design/plan concern, but
  the requirement is that provenance is not lost.
- FR-TR3: If a live fetch or web search **fails**, the assistant says so and
  degrades gracefully (answers from what it has, labeled) rather than
  fabricating or silently dropping the request.

### Security & privacy (FR-SEC)
- FR-SEC1: All new backend surfaces obey the project boundary: **dedicated
  Supabase project only**, RLS default-deny, PIN-gated access; the anon key
  stays public-by-design and is not the enforcement boundary.
- FR-SEC2: Real balances / position sizes **never enter the repo or served
  files**, and never leave the backend except to the owner behind the PIN.
- FR-SEC3: Server-side secrets (`ANTHROPIC_API_KEY`, service role, cron secret)
  stay server-side only; the client never gains a new secret.

### Demo mode (FR-DEMO)
- FR-DEMO1: `?demo=1` continues to work with deterministic, offline behavior:
  no memory writes, no web search, no live quote pulls, no PIN.
- FR-DEMO2: Existing demo-lamp test coverage (S5) and the panel's demo lamp
  continue to pass unchanged.

## Success criteria
- SC1: Asked a follow-up in a **new session** that references an earlier
  exchange, the assistant answers using that prior context (memory works
  end-to-end).
- SC2: Asked something absent from the snapshot, the assistant returns a correct
  answer **with at least one web source** (research works).
- SC3: Asked about a ticker not on the page, the assistant returns a **live
  quote + fundamentals** fetched on demand (data tools work).
- SC4: Asked "what would you do with <position>", the assistant returns a
  **directional call grounded in cited data**, not a refusal (advice posture).
- SC5: Every answer lets the owner tell **snapshot vs live vs web** provenance
  and see freshness; a failed fetch is stated, not faked (trust).
- SC6: With `?demo=1`, the panel behaves deterministically with **zero** live
  calls and the demo lamp reads Demo (S5 still green).
- SC7: An **unauthenticated** caller cannot read or write memory, cannot invoke
  the tools with owner data, and no private balance/size leaves the backend
  (security).

## Non-goals
- No multi-user / per-user accounts — one PIN, one owner, one history.
- No automated trading, order placement, or brokerage write access — the
  assistant advises; it never transacts.
- No change to the other panels (Accounts, Markets, Heatmap, Charts, Brief,
  News) beyond what provenance display may require.
- No replacement of the scheduled AI daily brief (`desk-brief`) — this is the
  interactive assistant, a separate surface.
- No new client-held secret and no move off the dedicated Supabase project.
- Not porting the assistant to a public advice service — directional calls are
  the owner's private desk only.

## Open assumptions (for the clarify phase)
All `[NEEDS CLARIFICATION]` markers above, consolidated:
1. FR-MEM2 — replay window size (count / age / token budget).
2. FR-MEM4 — is a "clear history" control in v1; scope of the wipe.
3. FR-MEM5 — render the prior transcript in the panel, or use it silently as
   context.
4. FR-WEB4 — may private holdings/sizes appear in outbound web queries, or must
   queries be scrubbed.
5. FR-DATA4 — tool set for v1 (quote + fundamentals only, or also heatmap /
   news / index feeds).
6. FR-ADV4 — demo-mode advice behavior (directional on fake data, or
   analysis-only for public).
7. Cost/latency envelope — web search + multi-tool turns cost money and take
   longer; is there a per-turn budget or tool-call cap the owner wants?
8. Provenance UX — inline citations, a sources footer, per-claim tags? (a
   design/plan concern, but the owner's preference shapes the spec's SC5.)

## Clarifications
Resolved in the `clarify` phase. The owner chose to fast-track, so these are
**sensible defaults the owner can override** — each is reversible and recorded
here so nothing was decided silently.

1. **Memory replay window (FR-MEM2).** Replay the **last 20 exchanges**, further
   bounded to the last **30 days** and a **~8k-token** history budget (whichever
   is smallest). Keeps continuity useful while bounding cost and context. Older
   history is retained in storage but not replayed.
2. **Clear-history control (FR-MEM4).** **In scope for v1.** A PIN-gated "Clear
   conversation" control wipes **all** stored history for the desk (one owner,
   one history). No partial-range delete in v1.
3. **Transcript display (FR-MEM5).** **Render the prior transcript** in the panel
   on load — a scrollable exchange list — so continuity is visible, not just
   silently fed as context. New answers append to it.
4. **Web-query privacy (FR-WEB4).** **Scrub private data from outbound web
   queries.** The assistant may name tickers (watchlist is already public) but
   must **never** send real position sizes, dollar balances, or account
   identifiers to external search/fetch. Private figures stay in the model
   context for reasoning; only scrubbed queries leave the backend. (Upholds
   FR-SEC2.)
5. **Tool scope (FR-DATA4).** **v1 = live quote + fundamentals only**, via the
   desk's existing `quote-proxy` (`kind:'info'`) path. Heatmap / news / index
   feeds as assistant tools are a **follow-up**, not v1.
6. **Demo advice behavior (FR-ADV4).** **Demo mode stays analysis-only** — the
   public `?demo=1` visitor never sees directional buy/sell language. Directional
   calls are the owner's PIN-gated desk only. (Also keeps demo deterministic and
   the public face conservative.)
7. **Cost / latency cap.** Bound each turn: cap **web_search to ≤5 uses**, cap the
   agentic tool loop (**≤~6 tool calls/turn**), and set a per-turn **task budget**
   so one question can't run away on cost or time. Model stays `claude-opus-4-8`.
   A turn that hits the cap answers with what it has, labeled (ties to FR-TR3).
8. **Provenance UX (SC5 / FR-TR2).** A compact **sources footer** under each
   answer (web links/titles) **plus inline freshness tags** — "live HH:MM" for
   on-demand fetches, "snapshot" for page-snapshot facts — all rendered via
   `textContent`, consistent with the panel's existing lamp + as-of stamp. Exact
   layout is a `plan.md` / design concern; the requirement is that provenance is
   visible and not blended away.

**Net effect on scope:** v1 is memory (20-turn/30-day/8k-token replay) +
clear-history + visible transcript + web research (scrubbed queries, sources
footer) + quote/fundamentals tools + directional calls (live desk only, cited,
disclaimer retained) + provenance tags + bounded per-turn cost. Demo stays
offline and analysis-only. Everything obeys the dedicated-Supabase / RLS / PIN /
no-new-client-secret constitution.
