# Code review — PR #208 (merge commit `fa46049`)

**"Get the live UI suite back to green: S11 selector + NAV crawl budget"** — post-merge review, findings only, no edits made.

## Scope reviewed

| File | Change |
|---|---|
| `.github/scripts/ui-tests/tests/app.spec.js` | S11 selector scoped; NAV crawler gains `NAV_SKIP`, `navSkippable()`, `TRIES_PER_LEVEL`, `domcontentloaded` wait |
| `CLAUDE.md` | Key-selectors row + S11 scenario row updated |
| `specs/multi-account-trading-dashboard/tasks.md` | B4a / C11 / E3 ticked + closure note |
| `specs/retire-nightly-pipeline/tasks.md` | B7 ticked + note |

Cross-checked against `scripts/app.js`, `index.html`, `styles/components.css`, `.github/workflows/qa-live.yml`, and the tracked contents of `.agent-reports/`.

---

## Verified correct

These were checked directly and hold up — recording them so the findings below are read in proportion.

- **S11 scoping is sound.** `.lock-error` is created in exactly two places in `app.js` (line 1656, the Ask form; line 1847, the lock panel) plus four static modal nodes in `index.html` (`#sysPromptErr`, `#wlQuickErr`, `#wlRmErr`, `#wlEditErr`). In the pre-auth locked state that is 5 DOM matches, confirming the commit message's count. `.panel-lock` is created only by `renderLockedPanels()` (line 1832) and `renderAccountsUnavailable()` (line 1804); only the former contains a `.lock-error`, and it is precisely the node the failed-PIN handler writes into (`err.textContent = … 'PIN not recognized — try again.'`). So `.panel-lock .lock-error` resolves to exactly one node, and it is the right one.
- **The scoping does not create a silent-pass path.** The node starts `hidden = true` and `components.css:196` sets no `display`, so the UA `[hidden]` rule holds and `toBeVisible()` is false until the handler unhides it. `renderAccountsUnavailable()`'s `.panel-lock` carries no `.lock-error` at all, so there is no alternate visible node to satisfy the assertion. If a future refactor moved the error out of `.panel-lock`, S11 would **fail**, not pass — the failure mode is loud, which is the right direction.
- **`navSkippable`'s index convention is correct.** `discoverElements` deliberately assigns `index` before the visibility filter (`.map((el, index) => …).filter(…)`), so it is the position within the full `document.querySelectorAll(sel)` list. `document.querySelectorAll(sel)[index]` inside `navSkippable` uses the identical convention, as does the `page.locator(sel).nth(index)` fallback. No off-by-one.
- **`qa-live.yml` really is not a PR gate** — it triggers on `workflow_run: [pages-build-deployment]` plus `workflow_dispatch`. The commit message and the E3 closure note describe this accurately.
- **The B7 note's "brief half is moot" claim is accurate** — CLAUDE.md records the daily brief's retirement on 2026-07-23.
- **Skipping the disabled region tabs is a genuine budget win.** Three of the four `MKT_REGIONS` buttons are `disabled` (`app.js:126`), and Playwright's `.click()` on a disabled element burns the full 3s actionability timeout. Removing them is real savings, independent of the rationale problems below.

---

## Important (80–89)

### 1. `NAV_SKIP`'s stated rationale does not match what it actually filters — and what it filters is the desk's only navigation-shaped controls (confidence 88)

`.github/scripts/ui-tests/tests/app.spec.js:544-560`

The comment and commit message frame the list as excluding **data cells** ("watchlist and market tiles, heatmap rects, sector cells, chart bars… every one is a button or role=button"). Checked against the app, that premise is wrong on every count:

| Entry | Actual element | Matched by `discoverElements`? |
|---|---|---|
| `.wl-tile` / `.mkt-tile` | `el('div', 'mkt-tile wl-tile')` with `tile.tabIndex = 0` only (`app.js:664`, `700-709`) — no `role=button`, no `onclick` attribute | **No** |
| `.mk-sec` | `el('div', 'mk-sec')`, plain div, no role/handler (`app.js:201`) | **No** |
| `.hm-tile` | **class does not exist anywhere in the repo**; heatmap cells are `svgEl('rect', …)` with no class | **No** |
| `.seg` | containers holding real `<button>` children (`wlSort`, `wlTf`, `chartLayout`, `chartZoom`, `chartZoom2`) | **Yes** |
| `[role=tab]` | real `<button role="tab">` region tabs (`app.js:127`) | **Yes** |
| `.wl-band-head`, `.wl-trash`, `.wl-tray` | real buttons (`#wlTrash`, `#wlTrayAdd`, the per-band `+`) | **Yes** |

`discoverElements`'s selector list is `button, a[href], input:not([type=hidden]), select, textarea, [role=button], [onclick]`. A focusable `div` with `tabIndex = 0` and `addEventListener` handlers matches none of it. **Watchlist tiles, market tiles, sector cells and heatmap rects were never crawl candidates**, so four of the nine entries are inert and the headline diagnosis — "far worse live, where the watchlist alone renders a tile per symbol… 248 of them" — is not what was costing the budget.

What the filter *actually* removes is the ~25–29 segmented-control buttons plus the four region tabs, which is consistent with the measured 62 → 31. Those are not data cells: `[role=tab]` is navigation by ARIA definition, and `#chartLayout` is the PANE seg that per CLAUDE.md S12 "maximizes a tier" — the single closest thing to a drill-in this dashboard has. So the change removes the only candidates that could plausibly have produced a level transition, under a justification that describes something else.

The safety argument is also mis-aimed: "a second click on a watchlist tile is the remove gesture" is moot (tiles were never clicked), while the parts that *are* real and *are* worth skipping — `#wlTrayAdd` and the per-band `+`, which open dialogs that mutate a live roster — get no specific mention.

**Suggested fix:** drop `.hm-tile` and `.mk-sec` (dead), keep the roster-mutating controls with the real justification, and re-label the `.seg` / `[role=tab]` entries honestly — e.g. "in-pane view controls: they change what a pane displays without producing a new level, and three of the four region tabs are `disabled` so each costs a full 3s actionability timeout." Same behaviour, accurate reasoning.

### 2. The NAV assertion is now structurally unreachable on this app, and that is not stated (confidence 85)

`.github/scripts/ui-tests/tests/app.spec.js:614-617`

`backControl()` matches `[data-back], [aria-label*="back" i], button:has-text("Back"), a:has-text("Back"), button:has-text("←"), a:has-text("←")`. Grepping `index.html` and `scripts/app.js` for all six: **zero matches**. There is no `data-back` attribute, no back-labelled control, no arrow-glyph control anywhere in the desk. CLAUDE.md's own UI Test Configuration already says "Nav cards | n/a — single-page dashboard".

Consequently `advanced` can never be set (it requires `hasBack`), `forward.length` stays 1, and the test always reaches `test.skip(…, 'back-flow invariant N/A')`. The PR's framing — "a drill-in either exists among the page's genuine navigation controls or it does not", "keeps real headroom under the ceiling" — reads as though a meaningful search survives. In practice the crawler now clicks the first ≤8 non-skipped buttons, observes no back control, and skips. The fix is correct (a timeout became a clean skip, which is strictly better), but the framing overstates what remains exercised, and with finding #1 the exclusions make the skip permanent by construction rather than by observation.

This matters for the honesty question the project's own rules raise ("Never silently shrink an expected scope… a caption disclosing the cut is not consent"). One sentence in the test header would settle it: *"This desk has no in-app back control, so NAV is expected to skip; it is retained as a regression guard for if one is ever added."*

### 3. The E3 closure note's evidence is not present in the tracked artifacts (confidence 85)

`specs/multi-account-trading-dashboard/tasks.md` (closure note, E3 bullet)

> "the full qa-pipeline has run many times since, most recently across the PR series #196–#208; `.agent-reports/` holds the reports."

`.agent-reports/` **is** git-tracked (`git ls-files` confirms), so its contents are the record being cited. What it actually holds:

| File | Last modified |
|---|---|
| `code-review-report.md` | Jul 28 |
| `security-review-report.md` | Jul 28 |
| `playwright-results.json` | Jul 28 |
| `test-report.md` | **Jul 12** |

Nothing is newer than Jul 28 — i.e. nothing from #199, #205, #206, #207 or #208. And E3 enumerates five stages ("test-verifier → ui-tester → code review → security review → pr-readiness"); of the report types CLAUDE.md's *Reporting Requirements* names, **`ui-test-report.md`, `test-coverage-report.md` and `pr-readiness-report.md` are absent entirely**. The directory also still contains committed S1 *failure* screenshots and traces (`.agent-reports/screenshots/app-S1-…-retry1/test-failed-1.png`), which is not what "holds the reports" implies.

The note is careful and self-critical elsewhere — the qa-live caveat is a genuinely good disclosure — which makes this bullet the weak link. It should either name the actual evidence (PR checks / CI run URLs) or say the on-disk reports are partial and stop at Jul 28.

### 4. The B4a evidence sentence is provably false — and it exposes a live harness landmine (confidence 88)

`specs/multi-account-trading-dashboard/tasks.md` (closure note, B4a bullet)

> "Evidence: S10 (valid PIN unlocks accounts) passes on every live CI run; **it cannot run at all without the secret**."

It can. `AUTH_CREDENTIAL` is `process.env.TEST_AUTH_CREDENTIAL ?? readCredentialFromClaude() ?? null` (`app.spec.js:38`), and `readCredentialFromClaude()` parses CLAUDE.md. Running that regex against the current CLAUDE.md:

```
MATCH: "test credential | repo"  =>  CRED: "repo"
```

The `Valid test credential | repo secret \`TEST_AUTH_CREDENTIAL\` …` table row matches the `test\s+(?:pin|credential|password)` alternative, `[:|]` eats the table pipe, and the capture group takes the next word — **`"repo"`**. That is truthy, so `test.skip(!AUTH_CREDENTIAL, …)` does **not** fire: without the secret, S10 runs with PIN `"repo"` and **fails** rather than skipping.

Two consequences:

- The stated reasoning is wrong. The *conclusion* may still hold (if S10 genuinely passes, `"repo"` would not have unlocked, so a real secret was supplied) — but the note should say that, not the false version. A tasks.md tick is a durable claim; citing a mechanism that does not exist is exactly the overclaiming the closure note otherwise sets out to avoid.
- Independently, this is a real harness hazard: any local, forked, or secret-less run gets a bogus credential and a confusing S10 *failure* instead of the intended clean skip. Worth fixing at the source (tighten the regex to reject a following `secret`/`repo` keyword, or have the CLAUDE.md row not present `credential |` followed by a word).

I could not verify the CI history directly — `gh` is not installed in this environment — so the "passes on every live CI run" half is unverified from the repo alone.

### 5. The same shared-class hazard the PR fixed is left in place two lines above it (confidence 82)

`.github/scripts/ui-tests/tests/app.spec.js:715, 718, 726, 729` and `CLAUDE.md` Key-selectors row

S10 and S11 both still use bare `page.locator('.lock-form input.input')` and `page.locator('.lock-form button')`. `.lock-form` is the *same kind* of shared class as `.lock-error` — `app.js:1647` (Ask panel) and `app.js:1841` (lock panel) both apply it. It happens to be unambiguous today only because `renderAsk()` renders no form while unauthed.

The suite already knows this. Line 1296 carries an explicit warning — *"The ask form is also .lock-form, so all selectors are scoped to #askBody"* — and lines 1126 and 1306–1312 use the scoped `.panel-lock .lock-form input` / `#accountGrid .lock-form …` forms. So S10/S11 are the outliers, and CLAUDE.md's updated row now says **"always scope it"** for the error line while the `lock form:` entry immediately to its left stays unscoped. That is inconsistent guidance in a single table cell, on the exact lesson the PR exists to record. Scoping both to `#accountGrid` (or `.panel-lock`) would close the class of bug rather than one instance of it.

### 6. S11 asserts visibility only, but CLAUDE.md's row claims it checks the text (confidence 80)

`.github/scripts/ui-tests/tests/app.spec.js:737`; `CLAUDE.md` S11 row

The scenario row reads "Invalid PIN shows `.panel-lock .lock-error` **text**". The test asserts `toBeVisible()` and never reads `textContent`. The same node carries the network-failure branch — `'Could not reach the data service — try again in a moment.'` (`app.js:1857`) — so **S11 goes green on a completely dead backend**, reporting "wrong PIN correctly rejected" when what actually happened is the RPC never answered. That is the one condition S14 exists to catch, so the suite is not silently blind overall, but S11's own claim is stronger than its assertion.

The commit message quotes the CI log capturing `PIN not recognized — try again.`, so the expected string was in hand. Adding `toContainText(/not recognized|incorrect|invalid/i)` would make the test match its documentation. Pre-existing rather than introduced here, but the PR rewrote this exact line and updated this exact doc row.

---

## Minor, but worth recording

### 7. "five-level worst case near 76s" is an expected case, not a worst case (confidence 80, low impact)

`.github/scripts/ui-tests/tests/app.spec.js:571-575`

Per attempted candidate the ceiling is `click(3000ms) + waitForTimeout(800) + waitForLoadState(1000)` = 4.8s. `TRIES_PER_LEVEL × DEPTH_CAP` = 8 × 5 = 40 attempts → **192s worst case**, against a 120s ceiling, before `gotoAndAuth`'s two 4s `networkidle` waits (which never settle on this page, so they are always paid in full). 76s is roughly the *typical* cost, where clicks succeed immediately and only the 800ms settle is paid. The stated headroom does not exist in the arithmetic sense.

In practice this is harmless — finding #2 means the outer loop breaks after level 0 — but the number is load-bearing justification for the chosen cap and should say "expected", or the cap should be derived from the real per-attempt ceiling (e.g. `DEPTH_CAP × TRIES_PER_LEVEL × 4.8s < 120s` ⇒ 4 tries per level).

### 8. The `domcontentloaded` wait is effectively a no-op, and the settle window shrank 4.8s → 0.8s (confidence 85, low impact)

`.github/scripts/ui-tests/tests/app.spec.js:598`

`waitForLoadState('domcontentloaded')` resolves immediately on an already-loaded document and does not observe DOM mutations at all — the comment concedes this ("the 800ms above is what actually observes it"). So the call contributes nothing except a `catch`; it could be deleted outright.

The substantive change is that the per-candidate observation window dropped from ~4.8s to 0.8s. The old `networkidle` wait, though it never *succeeded*, still burned up to 4 extra seconds of wall clock during which a slow client-side repaint could complete before `viewSignature()` read the DOM. So there is a genuine flake-in-the-other-direction: a click that triggers a feed fetch (the force-refresh button, or a map-filter cut that re-sources from `desk-charts`) can take longer than 800ms to repaint, and the crawler would now conclude "no change" and move on. This is not mentioned in the commit message, which presents the change as pure waste removal.

Impact today is nil (the test can only skip), so this is a latent issue, not an active one. If the settle matters later, `page.waitForFunction` on a changed signature with a 2–3s budget would be both faster in the common case and more reliable in the slow one.

### 9. `navSkippable` and the click locator disagree for elements that carry an `id` (confidence 82, low impact)

`.github/scripts/ui-tests/tests/app.spec.js:555-559` vs `592`

`navSkippable` always resolves by `querySelectorAll(sel)[index]`, but the click resolves by `[id="…"]` whenever `el.id` is set. For id-bearing nodes the two can target different elements, because `discoverElements` is called **once per level** while up to 8 clicks mutate the DOM inside that level (a modal or popover opening shifts every subsequent index). Among `NAV_SKIP` members this reaches `#wlTrash` and `#wlTrayAdd` — both real, both roster-adjacent.

For non-id elements the helper is correct in the way that matters: skip check and click use the same index, evaluated milliseconds apart, so the skip decision applies to the node that will actually be clicked. Only the id branch diverges. Making `navSkippable` mirror the locator (`el.id ? document.getElementById(el.id) : querySelectorAll(sel)[index]`) would close it in one line. The underlying index-staleness is pre-existing in the click path; this change inherits rather than causes it.

### 10. C11's tick is defensible but the task text is stale (confidence 80, informational)

`specs/multi-account-trading-dashboard/tasks.md` C11

C11's text asks for `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`, `ANTHROPIC_API_KEY`, `DB_SERVICE_KEY` as **repo secrets** plus `DB_URL`/`DB_ANON_KEY` as **repo variables**. CLAUDE.md now states "GitHub keeps only `KEEPALIVE_PAT` + `TEST_AUTH_CREDENTIAL`" — the rest moved to edge-function secrets when the nightly pipeline was retired. The closure note does say "the *function* secrets and variables are set", which is the right reading, but the box's own text describes a GitHub-secrets arrangement that no longer applies. Ticking it reads as "we did the thing as written" when the accurate statement is "the underlying need is met elsewhere, and the GitHub half is moot."

---

## Summary

The two defects this PR set out to fix are real, the S11 fix is correct and verified against `app.js`, and turning a 6-day-old hard timeout into a clean skip is a clear improvement. Nothing here is a correctness bug in shipped application code — the whole diff is harness and docs, and no application behaviour changed.

The concerns are concentrated in **accuracy of the reasoning left behind in comments and specs**, which in this project is a first-class artifact:

- The `NAV_SKIP` rationale describes filtering data cells; it actually filters segmented controls and tabs, while four of its nine entries match nothing the crawler could ever have reached (**#1**).
- The NAV invariant cannot fire at all on this desk, and the PR does not say so (**#2**).
- Two spec ticks cite evidence that either is not in the tracked artifacts (**#3**) or does not work the way stated (**#4**).
- The "always scope shared-class selectors" lesson was applied to `.lock-error` and not to `.lock-form` two lines away (**#5**).

Recommended follow-ups, in order: fix the B4a evidence sentence and the credential-regex landmine (#4), correct the `NAV_SKIP` comment and drop the dead entries (#1), state the no-back-control reality in the NAV header (#2), scope the `.lock-form` selectors and CLAUDE.md's row (#5), then the E3 evidence wording (#3).
