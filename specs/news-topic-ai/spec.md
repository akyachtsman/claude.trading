# Spec — News topic: an AI cleanup of what is typed

> **STATUS (2026-10-17): `specify` COMPLETE; the feature is BUILT (see `plan.md`) and LIVE since 2026-10-19 (PR #341; `desk_023` applied, `desk-news` v15 deployed). SC1 — the model turning `cerebres` into `Cerebras` — is pending the owner's live check.** Input: the owner's screenshot of the News topic box with `cerebres` in it (the company is Cerebras) and the questions "does it have to be so specific? doesn't it use AI to infer what I meant?", then "build option B" from the options table (A leave it, **B AI cleans up what you type**, C B plus AI ranking the results). No `brief.md` (`/diagnose` was not run: the owner chose from a written comparison in chat). `plan.md` is the HOW.

WHAT and WHY only. Constitution: the five imported directives (`global.md`, `git.md`, `design.md`, `data.md`, `test.md`) — in particular `data.md` (service key and secrets server-side only; RLS always on; reversible backend changes) and `test.md` (*Rendered-verification gate*, *Stub the collaborators, never the subject*). Changes only the News panel's topic box and the function behind it; no other panel.

## Problem
The News panel's topic box (owner request 2026-08-14) sends exactly what is typed to a news search. A misspelling (`cerebres`), a half-remembered name or a loose phrase therefore finds nothing, or the wrong thing, and the owner has to guess the exact spelling. The owner expects to type what they mean.

## Users
- **The owner:** types topics into the box, often quickly and loosely.
- **Visitors:** the box is on the public page (news is public data, no PIN). They can use it too, so whatever it costs must be bounded without them having to be trusted.

## Goals / why
- What is typed is **understood**: a clear misspelling or loose phrase is turned into the phrase most likely meant before the search runs.
- It is **visible**: the panel says what was actually searched whenever that differs from what was typed, so a wrong guess is seen at once and is one retype away from being fixed.
- The news never depends on the helper: if the helper cannot help, the search runs on exactly what was typed and the panel says why.
- **Cost is bounded** and switchable off by the owner without a deploy.

## Non-goals
- AI ranking, filtering or summarising of the headlines (option C). The helper touches the search phrase only.
- Changing which sources are searched, how rows are ranked, cached, chipped or dated.
- Changing the box's behaviour: commit on Enter or click-away, the ✕, the 60-character cap and the allowed characters all stay.
- A history of topics, a topic picker, per-user settings, a choice of model.
- Languages other than English; non-Latin text.
- Demo mode (`?demo=1`): it has no news search and no network, so it gets no helper and no note.
- Any change to Ask the desk or its visitor cap.

## User stories
1. As the owner I type `cerebres` and press Enter; the panel shows headlines about Cerebras and says `Showing news for “Cerebras” (you typed “cerebres”)`.
2. As the owner I type a phrase that is already right (`fed rate cut`); it is searched as typed and the panel adds nothing.
3. As the owner, when the helper cannot help (switched off, today's limit reached, slow, an error, an unusable answer), I still get headlines for exactly what I typed, and a muted line says in plain words that it was searched as typed and why.
4. As the owner, when the page refreshes the news by itself every few minutes, or I reload, I keep seeing the same interpreted topic; none of that spends the helper again.
5. As the owner I clear the topic and the normal full sweep returns with no note.
6. As the owner, when the helper's guess is wrong, one click on the note searches exactly what I typed instead.
7. As a visitor I can use the same box; I cannot make it cost more than the daily limit.

## Functional requirements
Each maps to a check in `plan.md`'s test tasks.

- **FR1 — One interpretation per typing.** The helper runs once for each topic typed (Enter or click-away, topic changed). The panel's automatic refreshes, a reload and a retry reuse the result of that typing and do not run the helper again. Two edge cases are part of the rule: a typing whose request never got an answer back at all is simply tried again, and a topic saved before this feature existed is interpreted once, the first time it is refreshed.
- **FR2 — What the helper may do.** Fix spelling; name the company, ticker, person or event most plausibly meant; tighten a loose phrase into a search phrase. It must not add words the owner did not imply (no "stock", "news", "latest"), must answer a short phrase (at most 60 characters and 8 words), and must treat the typed text as the thing to interpret, never as instructions to it.
- **FR3 — Say what was searched, and let the owner overrule it.** Whenever the searched phrase differs from the typed one, the panel shows both and offers a one-click way to search exactly what was typed instead (which then stays, for that topic, until the topic changes). The empty-result message names the phrase that was searched. The note describes the search the headlines on screen came from, never a newer or older one.
- **FR4 — Fail soft, and say so.** Every way the helper can fail — not configured, switched off, asked from another website, daily limit reached, the limit counter unreachable, too slow, the provider erroring, a refusal, a cut-off, or an empty / too long / unusable answer — searches the typed text unchanged and shows a muted line naming the reason in plain words. A failure noted on one Pacific day is not carried into the next: the next refresh asks again. The helper never makes the news fail and delays it by at most about 8 seconds (its two server-side time limits, in the worst case).
- **FR5 — Bounded cost, owner's off switch.** Interpretations are limited per day, counted so that a burst of parallel requests cannot overshoot the limit. The owner can turn the helper off, or change the limit, without a deploy. Off behaves as FR4.
- **FR6 — Same phrase rules.** Whatever the helper answers passes the same cleaning as typed text (allowed characters, 60-character cap) before it reaches a search, and exactly one search runs.
- **FR7 — No cross-talk.** A reply for an abandoned topic never repaints the panel, and never shows another topic's "showing news for" line (the existing stale-reply rule, S52, extended).
- **FR8 — Clearing.** An empty topic runs no helper and shows no note.
- **FR9 — Demo is untouched.** `?demo=1` makes no helper call and shows no note.
- **FR10 — Privacy and security.** The API key and the daily counter stay on the server. The browser learns only the searched phrase and a short reason code. The helper is handed only the typed topic text — no holdings, accounts, PIN or other page data. It answers only requests that come from the desk page's own origin, so other websites' visitors cannot spend it (a speed bump, not a wall: a script can forge the origin, and the daily limit is the real bound).
- **FR11 — Nothing else moves.** Sources, ranking, caching, chips, the lamp, the other panels, Ask the desk and its daily cap behave exactly as before; the helper has a counter of its own.

## Success criteria
- **SC1** In the live panel, a misspelled or loosely worded known name returns headlines for the intended name and the panel says what was searched. *(The model's judgement can only be proven live, by the owner, after deploy; before that the page and server are proven against a stand-in for the model.)*
- **SC2** With the helper off, at its limit, erroring, too slow, or answering nonsense, the panel still shows headlines for the typed text and names the reason.
- **SC3** N parallel interpretations against a limit of L spend exactly L, however large N is.
- **SC4** Once an answer has landed, an automatic refresh, a reload and a retry spend none, and two refreshes that overlap spend one.
- **SC5** Typed text that tries to instruct the helper can only ever change the search phrase, within FR6's cleaning.
- **SC6** Ask the desk's visitor cap is untouched: the two counters do not share a row.
- **SC7** `CLAUDE.md` and the topic files record the new rule, the secrets, the deploy order and the rollback.

## Assumptions (marked open → closed below)
- **A1 (closed → C1)** Which option: B.
- **A2 (closed → C2)** What a failed helper does: the search runs on the typed text and says so.
- **A3 (closed → C3)** How cost is bounded: a daily limit like Ask's, with an off switch.
- **A4 (RISK, accepted)** The model is a small, cheap Claude (Haiku 5.5) answering one plain-text question with no tools. Whether it turns `cerebres` into `Cerebras` and leaves `fed rate cut` alone can only be seen live; the build sandbox has neither the key nor a route to the provider. FR4 makes a bad or missing answer harmless, and FR3 makes a wrong guess visible.
- **A5 (RISK, accepted)** Visitors share the box, and a script that forges the page's origin can spend interpretations too, until the daily limit is reached; after that everyone (the owner included) gets the as-typed search and the note until the next Pacific day. Acceptable at this scale (the whole limit is about a cent of model spend); the owner can raise or lower it with a secret, with no deploy.

## Clarifications
Answered by the owner, 2026-10-17 (the options table, and "build option B"):
- **C1 — Which option?** *B: the AI cleans up what is typed.* Not A (leave it), not C (AI also ranks the results).
- **C2 — If the helper fails?** *Search the typed text and say so.* Never a silent substitute, never a failed news panel.
- **C3 — How is cost bounded?** *A daily cap in the style of Ask the desk's visitor cap* (atomic, with an off switch that needs no deploy), applied to everyone who uses the box.
- **C4 — What does the panel say?** *What was understood*, as `Showing news for “Cerebras”`, so a wrong guess is visible.
