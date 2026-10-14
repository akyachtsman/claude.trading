# Spec — Ask-the-desk model tier (admin-controlled)

> **STATUS (2026-10-14): `specify` phase COMPLETE — the three clarifications are answered (below). Next phase: `plan`.**

WHAT and WHY only. HOW lives in `plan.md`. Constitution: the five imported directives (`global.md`, `git.md`, `design.md`, `data.md`, `test.md`). Input: `brief.md` (the owner's design brief and the measurements taken on this project). Changes only the Ask-the-desk panel and the answers it gets; no other panel.

## Problem
Which Claude model answers Ask-the-desk is decided at deploy time and can only be changed by editing a hidden server setting or redeploying. The owner cannot trade quality against cost from the product, cannot see which model actually answered a question, and nothing records who last changed it.

## Users
- **The owner (admin):** the one person who unlocks the desk with the PIN. Wants to move the whole desk between a cheaper, faster model and the strongest one, and to *see proof* that the move took effect.
- **Visitors:** anyone on the public page, who may ask a limited number of questions with no PIN (owner ruling 2026-10-04). They must neither see nor reach the control.
- **Scheduled questions:** the desk asking itself on a schedule. They are answered by the same assistant.

## Goals / why
- Let the owner pick **Haiku 5.5, Sonnet 5.5 or Opus 5.5** for the desk from the Ask panel, with no deploy and no dashboard.
- Make the choice **trustworthy**: what the control says is what the server uses, and every answer shows which model really produced it. A choice that looks saved but is not honoured is the failure this feature exists to prevent.
- Keep the desk **answering** whatever goes wrong with the choice itself.
- Leave a record of who changed it and when.

## Non-goals
- A model picker per question, per conversation or per visitor.
- Any model beyond those three (adding one later is a deliberate change to every place the list lives, not a free-text field).
- Different prompts, answer budgets, tools or time limits per model — those stay as they are.
- Cost reporting, usage dashboards, or capping spend by model. (The existing daily cap on visitor questions is unchanged.)
- A history of past changes — only the last change is recorded.
- Letting a visitor, or the test credential, change the setting.
- Changing how questions are let in (PIN, schedule, open visitor) or what each may see.

## User stories
1. As the owner, I unlock the desk and see in the Ask panel which of the three models the desk is set to, and I can change it with one click.
2. As the owner, after I change it, my next question's answer tells me which model produced it, so I know the change is live and not merely saved.
3. As the owner, if the setting cannot be read or saved, the control says so plainly instead of showing a model it does not know the desk is using.
4. As a visitor, I see no model control and learn nothing about which model answered; my questions still get answered.
5. As the owner, if the stored setting is ever unreadable, questions keep working on a safe fallback and the problem is visible in the server's logs.

## Functional requirements
Each maps to a check in `plan.md`'s test tasks.

- **FR1 — Exactly three tiers.** The desk offers Haiku 5.5, Sonnet 5.5 and Opus 5.5, in that order of cost (cheapest first), and no other value is ever accepted, stored or used, wherever the list is held. The starting tier, and the built-in fallback every failure path ends on, is **Haiku 5.5** (C3).
- **FR2 — One desk-wide setting.** There is a single setting for the whole desk. Changing it governs the next question that starts afterwards — typed, scheduled and open visitor questions alike (C2).
- **FR3 — Admin only, enforced where the data lives.** Only the admin — a PIN session of the one real (non-test) desk user (C1) — can read or change the setting. A visitor, a locked desk, a wrong PIN, or a hand-made request that bypasses the page can do neither; hiding the control is not the protection.
- **FR4 — Where it is.** The control is in the Ask panel, drawn only while the desk is unlocked, and is absent for visitors and for a locked desk (like Verify, schedules and the prompt editor).
- **FR5 — Honest states.** The control has three states and never shows a guess as a fact: *not yet read* (nothing selected, every option disabled), *read failed* (nothing selected, every option disabled, the failure said in words, a way to try again), and *stored* (the stored model selected, options enabled). The built-in default is never displayed as though it were what is stored.
- **FR6 — A refused change reverts and claims little.** If saving is refused or fails, the selection returns to what is stored and the failure is said. A successful save says only that the setting was saved and applies from the next question — never that the model is "in use".
- **FR7 — Takes effect on the next question, with no lag.** Each question is answered by the setting as stored when that question starts. Nothing may hold a previous value for a while after a change. One question is answered by one model start to finish, including its grounding check.
- **FR8 — The desk keeps answering.** If the stored setting cannot be read or is empty, the question is answered anyway: first by an operator override (the existing server setting `ASK_MODEL`, kept as break-glass), then by a built-in default. A stored value that is not one of the three is not used — the question falls back and the event is logged, never refused. When both a stored setting and an override exist and disagree, the stored setting wins and the disagreement is logged.
- **FR9 — Proof.** The answer the admin receives names the model that actually answered, as reported by the model provider (not what was asked for), and the Ask panel shows it with that answer. A visitor's reply carries no model name. (Today every reply carries it, and nothing shows it.)
- **FR10 — A record.** The setting records when it last changed and who changed it. The system sets these — a caller cannot supply or forge them.
- **FR11 — The same assistant everywhere.** Typed, scheduled and open questions all follow the setting (C2). The saved conversation and the stored model name on each saved answer keep working as today.
- **FR12 — Nothing else moves.** Prompts, answer budget, tools, daily visitor cap, history, Verify, schedules and who is let in behave exactly as before.
- **FR13 — Reach is recorded.** The session-start check of what the working credentials can reach (and the expected answer: one project to work in, four visible, not a superuser, bypasses row security) is written into `CLAUDE.md`, so a wider answer later is noticed.

## Success criteria
- **SC1** With the setting at each of the three values in turn, a question to the live desk is answered by that model, and the owner's panel shows that model's name beside the answer. *(Proof the server honours the setting.)*
- **SC2** A visitor's reply contains no model name and the page shows the visitor no control; a locked desk shows no control; a request made without the PIN, or with the test credential, can neither read nor change the setting.
- **SC3** With the stored setting unreadable, a question is still answered and the fallback is logged; with a stored value outside the three, the same; with an override that disagrees with a readable stored setting, the stored one answers and the disagreement is logged.
- **SC4** A change made at one moment governs a question started a moment later (no caching window).
- **SC5** The three states of the control are each reachable and each correct: nothing is selected and everything is disabled before a read lands and after a failed one; a refused save puts the selection back.
- **SC6** The list of three is identical, in the same order, in every place it is held, and a test fails if any one drifts.
- **SC7** `CLAUDE.md` records the credential-reach answer and the new rules.
- **SC8** Because Haiku 5.5 is the starting tier and the fallback, it is proven **live on the desk's own tool paths** (web search and the live-quote tool) before the feature is called done: an answer that used each, with the Haiku name shown beside it.

## Assumptions to confirm (marked open)
- **A1 (closed → C1)** "Admin" has no existing meaning here: the desk has no roles, only a PIN. Resolved: the admin is whoever unlocks with the owner's PIN, excluding the test credential.
- **A2 (closed → C2)** Resolved: the one switch governs every question, open visitors included.
- **A3 (closed → C3)** Resolved: Haiku 5.5. Today's default id is `claude-opus-5`, so the move to Haiku is a real change in answer quality and cost the moment the feature ships, even before the switch is touched — the owner chose that knowingly.
- **A4 (RISK — now load-bearing)** Haiku 5.5 is assumed able to run the desk's full tool set. Documentation says it should; only a live question proves it. Because Haiku is also the fallback, a Haiku that refuses the desk's tools would break the desk's last line of defence, not just one option. So SC8 is a gate, not a nicety: prove it live, and until then keep the feature unannounced. If it refuses, the owner sees the provider's error on the question and switches to Sonnet or Opus (the switch is the fix); nothing is stored wrongly.

## Clarifications
Answered by the owner, 2026-10-14:
- **C1 — Who is the admin?** *Owner PIN only.* Whoever unlocks with the owner's PIN. The test credential CI unlocks with is excluded, so a test can never move the production switch. No new role column on the users table. (Rejected: any valid PIN; a role column.)
- **C2 — Do open visitor questions follow the switch?** *Yes — everyone follows it.* One cost lever for the whole desk. Visitors still see no control and no model name. (Rejected: a second, fixed model for visitors.)
- **C3 — Starting tier and built-in fallback?** *Haiku 5.5.* The row starts at Haiku, and every failure path (no row, unreadable row, unknown value, no override) ends there. (Rejected: Opus 5.5, Sonnet 5.5.) Consequence recorded under A3/A4.
