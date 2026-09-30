# Brief — Economy indicators panel

> **STATUS (2026-09-30): BACKEND BUILT AND DEPLOYED (v1, `verify_jwt` ON); UI BUILT (S55).** `desk-econ`, its roster and its checks are committed and the function is live; the panel is in `scripts/app.js`'s Economy block (`tasks.md` is history). Where this and `CLAUDE.md` disagree, `CLAUDE.md` is authoritative.

## Problem (one sentence)
The desk shows prices but none of the macro numbers the owner trades against — Treasury yields, unemployment, inflation — so reading them means leaving the desk.

## Owner request (2026-09-30)
A table in the desk row's 4th slot (where the accounts used to be) holding the most important, most **current** economic statistics: the unemployment rate, the 2-, 10- and 20-year Treasury yields, CPI and PCE inflation "and those kind of indicators" — "the most current, and updated as soon as that data changes". Added the same day: **every row gets its own small chart to its right, with a selectable time span** ("one day, week, month, etc.") like the other charts on the desk.

Approved by the owner: **keyless** data sources only (no API key, no new secret) and an **editable** indicator list.

## Users & current alternative
Single user (the owner). Today: a news site or FRED in another tab. The retired FRED "Economy at a glance" iframe (removed 2026-08-07 with every vendor embed) was the last time the desk carried any of this.

## Definition of done (smallest useful)
Seven rows — 2Y, 10Y, 20Y Treasury, Unemployment, CPI YoY, PCE YoY, Core PCE YoY — each with its latest value, the change from the previous observation, the date that observation is for, where it came from, and a small chart over a span chosen from 1W 1M 3M 6M 1Y 5Y. Every row honest about staleness: a failed source shows its last good value flagged stale, or a dash — never a made-up number.

## Constraints
- No vendor JS or iframes (owner ruling 2026-08-07): the data comes only through a desk edge function.
- Live mode is real data or nothing; absent is never 0.
- The panel was 232px wide when this was written (it is `clamp(232px, 100vw − 1067px, 320px)` now — `docs/architecture/desk-row-layout.md`).
- Nothing ships live until the owner approves its deploy, and only the dedicated Supabase project is touched. *(Historical: this read "nothing is deployed" while the function was being built. The owner approved the deploy on 2026-09-30 and `desk-econ` v1 is live — `docs/architecture/economy-panel.md`.)*

## Approach chosen
One anon-callable feed function, `desk-econ`, in the same family as `desk-market` / `desk-maps`: FRED's public CSV as the spine for every series (full history, verified reachable), and — OFF by default, FRED-only to begin with (owner 2026-09-30) — the U.S. Treasury's daily par-yield CSV as an opt-in same-day tail for the three yields (FRED lags them 1–2 business days), a committed owner-editable roster (`config/econ-indicators.json`), and a refresh cadence that tightens around the scheduled release times. The history is fetched once (six-plus years) and every span is a slice of it. Detail: `spec.md`.

## Not chosen, and why
- **BLS / BEA APIs directly**: BLS v2 needs a key; v1 is keyless but tightly rate-limited, and `api.bls.gov` was unreachable from the build sandbox. FRED republishes both within minutes to an hour of the 08:30 release, keyless.
- **Treasury alone for the yields**: unverifiable here (the host was unreachable), and it has no long history in one file. It is used as a cross-checked tail instead.
- **A literal 1-day chart**: no intraday series exists for any of these numbers — see the granularity policy in `spec.md`.
