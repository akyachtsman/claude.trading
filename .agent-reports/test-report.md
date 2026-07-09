# Test report — Phase C data pipeline

Date: 2026-07-09 · Workflow: `.github/workflows/data-refresh.yml`

## Fixture suite (node --test, runs in CI before every refresh)
19/19 pass: Stooq/FRED CSV parsing + tile shapes (2dp %, series-date
stamping, "." holiday rows), RSS 2.0 + Google-News parsing, entity
decoding, dedupe/holdings-first ranking/text-match degrade, Flex statement
parsing (both reportDate formats), Flex soft-error surfacing, account-key
mapping (env map + sorted fallback + unknown→null), brief grounding
acceptance/rejection, prompt composition, Yahoo symbol map + chart parsing.

## Live dispatch verification (C10)
- Run #1 (29045079290): pipeline end-to-end shakeout. News live (20 items),
  IBKR + Anthropic steps no-op'd with visible notices, meta honest,
  `[skip ci]` data commit pushed. Market failed: Stooq per-IP daily limit
  on shared Actions runners → fixed by the two-source quote chain (PR #10).
- Run #2 (29045357569): success. All six market tiles real (S&P 500,
  Nasdaq 100, Dow Jones, IWM (R2K proxy), VIX, US 10Y), asOf 2026-07-09;
  live Pages verified serving the new JSON cache-busted.

## SC7 forced-failure drill (C10b)
Run #3 (29045600660), dispatched with `force_fail_market: true` (both quote
bases pointed at an invalid host):
- `data/market.json` was NOT overwritten — it kept run #2's content and
  `generatedAt: 2026-07-09T19:43:53Z`, so the site keeps serving last-good
  data with its older as-of stamp visible (FR-D4). ✔
- `data/meta.json` recorded `market: failed` while preserving the last-good
  as-of; news refreshed independently in the same run (partial refresh). ✔
- The `if: failure()` notify step executed. SMTP repo variables are not yet
  configured (bootstrap owner task), so it emitted the designed visible
  warning instead of the email: `refresh failed but SMTP_HOST, SMTP_USER,
  SMTP_PASS, ALERT_TO not configured`. The email path itself is the same
  `notify-email.js` used by cron-notify; delivery activates as soon as the
  owner sets the SMTP variables/secret. ⚠ pending owner config
