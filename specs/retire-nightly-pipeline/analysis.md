# Analysis: Retire the Nightly Pipeline

**Date:** 2026-07-13 · **Phase 6 (analyze)** — post-implementation consistency
check across brief intent → spec → plan → tasks → shipped code.
**Verdict: CONSISTENT — shipped in one day across PRs #53 (phase 0), #54 (A),
#55 (B), #56 (C); no open contradictions. Two accepted deviations below.**

## Artifact ↔ implementation cross-check

| Requirement (spec) | Shipped | Notes |
|---|---|---|
| FR-1 five public feeds live on demand | `desk-market/heatmap/charts/news/maps` deployed, pg_net-verified (6 tiles / 501 tiles / 25 syms / 20 items / 3 cuts) | payload shapes byte-compatible with the retired `data/*.json` |
| FR-2 session-aware freshness | 5 min open / 60 min closed TTLs server-side + the same cadence in the client poller (`marketSessionOpen`, one holiday list, annual-refresh comment) | Clarification 6 |
| FR-3 scheduled jobs off Actions | `desk-ibkr-sync` + `desk-brief` on pg_cron 22:35/09:35 + 23:05/10:05 UTC, Vault-resolved headers | `desk_005` migration carries unschedule inverses |
| FR-AI4 grounding guard survives the port | verbatim in `desk-brief`; live-fired: ok:true, stored | grounding source switched to live feeds per plan |
| FR-R7 two-tier lamps | `liveLampFor(generatedAt, dataAsOf)` everywhere incl. masthead | LIVE can never overstate quote freshness |
| FR-R9 no-lie degradation | poller keeps last good; first-load failure lamps Stale; snapshot fallback deleted in C | |
| SC guardrails (S1 allowlist, S14 canary) | S1 feed-origin-only allowlist (text + location().url), S14 masthead LIVE assert | Clarification 7 |
| Keepalive = sole scheduler-clock writer | confirmed by manual dispatch post-C: empty commit `93ed56d` landed | |

## Deviations (accepted, documented)

1. **Flex polling budget** — pipeline polled ~3 min; the edge port caps at
   ~65 s to fit the function wall-clock. Risk accepted because the dual-slot
   cron IS the retry (same recovery the pipeline used); first live fire
   returned an honest `not-ready` for exactly this case.
2. **Renew-token email dropped** — the pipeline's SMTP path was never
   provisioned; the port surfaces `failed-token` in the response +
   function logs, and CLAUDE.md's runbook carries the 2027-06-14 expiry.

## Verification trail

- Every function verified server-side via `net.http_post` before each merge
  (status_code + ok + shape spot-checks) — no client needed.
- Security review (A): SHIP with recommendations; all applied (single-flight
  memoization on all five feeds, roster caps 40/8, `replaceAll` regex fix).
- 401 gate proven with a wrong-secret probe; PIN RPCs untouched.
- Demo suite: unchanged behavior, 7/7 locally (S1's sandbox-only Google
  Fonts block documented in PR C).

## Residual risks (tracked in CLAUDE.md)

- Free-tier auto-pause now silences EVERYTHING (feeds + cron) — early
  warning: S14 in CI + `cron.job_run_details` gaps.
- `desk-news` holds the service key (read-only ranking input; public output
  only) — accepted residual.
- NYSE holiday lists (2026–2027) live in two functions + `data.js`; annual
  refresh needed or session-TTL selection degrades gracefully to 60 min.
