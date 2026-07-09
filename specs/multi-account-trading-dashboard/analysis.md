# Analysis — cross-artifact consistency (SDD phase 5)

Reviewer: fresh-context `pr-review-toolkit:code-reviewer` agent over spec.md
(incl. Clarifications), plan.md, tasks.md, and the codebase baseline
(index.html, styles/*, check-contrast.js, app.spec.js, qa-live.yml).
Date: 2026-07-09.

## Must-fix findings → resolutions (all applied before implement)
1. **TEST_AUTH_CREDENTIAL provisioned too late** (Phase C, needed in
   Phase B). → New task B4a: the seed generates the test PIN; owner adds it
   as the secret right after B4. B8 uses the value in-session, so B-phase
   e2e never blocks on the secret.
2. **C5 missing dependency on C6** (fetch-ibkr upserts through supa.js).
   → dep updated to C2, C6.
3. **SC7 (failed-refresh keeps last-good snapshot) had no verification
   task.** → New task C10b: forced-failure dispatch + assertion + evidence.
4. **FR-D3 contradicted the PIN-gate model** (post-Supabase, pre-real-data
   window showed LOCKED where spec said DEMO). → FR-D3 reworded: demo when
   no backend configured or `?demo=1`; locked (never fake-real) once the
   backend is wired but data absent.
5. **Demo-mode AI brief unowned** (static 3-account markup would survive
   the restructure). → A2 extended: retire static markup, add a 2-account
   demo-brief generator rendered by the same renderer D1 reuses.
6. **design.md described a 3-account reference page** the restructure
   removes. → A2 includes the design.md description update.

## Non-blocking findings → decisions
- **Dual cron vs "one scheduled run" clarification** — kept; Clarification 3
  reworded: the 09:30 UTC cron is a same-day retry (acts only when the
  close run found IBKR data not yet generated), not a second refresh.
- **1Y Flex backfill "candidate to defer"** — kept deliberately: the brief's
  ambition bar and the chart being the flagship surface outweigh the extra
  code path; SC4's disabled-timeframe fallback covers pre-backfill states.
  (Noted: the plan self-review had explicitly promoted it; two reviewers
  weighed it differently — resolved in favor of the ambition bar.)
- **Dead `.lamp--live`** — retained in the contract for the possible future
  intraday tier; harmless, documented here.
- **1Y button semantics** (`data-days=9999` ≈ "all") — normalized to 252 in
  A2.

## Traceability
Confirmed complete after fixes: every FR (incl. FR-AUTH1–3, demo-path
FR-AI, FR-Q3) and SC1–9 trace to concrete tasks; no orphan tasks. Map lives
at the bottom of tasks.md.

## Verdict
READY TO IMPLEMENT (Phase A first: frontend restructure on demo data).
