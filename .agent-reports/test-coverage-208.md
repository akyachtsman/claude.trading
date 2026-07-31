# Test-coverage analysis — commit `fa46049` (PR #208)

**Scope:** the Playwright suite itself, not application code. The question is whether
`.github/scripts/ui-tests/tests/app.spec.js` still guards what the CLAUDE.md
"Project-Specific Test Scenarios" table claims it guards.

**Verdict:** #208's two fixes are correct and well-reasoned. But the incident it
fixes is a symptom, and the diagnosis in the commit message stops one level short.
The suite is not "back to green and guarding the desk" — **no Playwright assertion
in this repo blocks a merge, and a large class of PRs never runs the suite at all
before merging.** That is the finding that matters; the S11 selector and the NAV
timeout are the two things that happened to be visible.

---

## 1. Summary

What #208 got right:

- The `.lock-error` diagnosis is exact. Verified against the source: five nodes
  carry the class (`index.html:575,609,628,647` + `scripts/app.js:1656`), and
  `.panel-lock .lock-error` resolves to exactly one — the only `.panel-lock` that
  contains a `.lock-error` is `renderLockedPanels()` (`scripts/app.js:1832-1847`);
  `renderAccountsUnavailable()` (`:1804`) has none, and the Ask form's error
  (`:1656`) sits in `#askBody`, outside any `.panel-lock`.
- The NAV budget arithmetic is right, and `NAV_SKIP` correctly covers the two
  genuinely dangerous targets against a live roster — `#wlTrayAdd` is inside
  `.wl-tray` (`index.html:494-495`) and `#wlTrash` matches `.wl-trash`.
- Ticking the four spec boxes *with evidence* rather than silently, and recording
  the red window against E3's "live verify", is the right instinct.

What it leaves standing:

- The suite is advisory everywhere. Both paths to a merge are non-blocking.
- ~5 of the 20 rows in the "authoritative" table are gated so they never run in CI
  at all; 2 tests exist with no row; 1 row describes behaviour the code no longer has.
- NAV has never asserted anything on this app and structurally cannot.
- Every project in `playwright.config.js` is a phone. A desktop trading dashboard
  is never rendered at desktop width.

---

## 2. Critical gaps (8-10)

### G1 — No Playwright test gates a PR. Two independent reasons. **[9]**

**(a) `qa.yml`'s UI job is `continue-on-error: true`.**
`.github/workflows/qa.yml`, "Run Playwright tests" step. The workflow header states
the intent plainly: *"Non-blocking here (the backend is unreachable on CI runners);
qa-live.yml is the authoritative UI gate."* But `qa-live.yml` triggers on
`workflow_run: pages-build-deployment` — after the merge. So the "authoritative gate"
is not a gate, and the thing that *is* on the PR is declared advisory.

This compounds: the `notify` job gates on
`needs.ui-tests.result == 'success' || 'skipped'`. Step-level `continue-on-error`
leaves the **job** result `success`, so the "✅ QA green" wake comment — consumed as
the auto-merge signal per `directives/git.md` — fires with a fully red Playwright
run underneath it. During the 2026-07-25 → 07-31 window, "QA green" was posted on PRs
whose UI suite was failing.

**(b) The UI job is skipped outright for most PRs.**
`UI_PATHS: '^(index\.html$|\.github/scripts/ui-tests/|\.github/workflows/qa\.yml$)'`.
`scripts/`, `styles/`, `config/` and `supabase/functions/` are all absent. A PR that
touches only `scripts/app.js` — which is where essentially all rendering and
interaction logic lives, and therefore what S12/S13/S20-S26 exist to protect — runs
**zero** browser tests before merging. #208 itself ran only because it touched the
ui-tests directory.

*Regression this permits:* exactly the PR #196/#200/#202 sequence that broke S11.
Each added a modal reusing `.lock-error`, each touched only `index.html`/`app.js`,
and none was ever red on its own PR.

**Fix:** the demo-mode subset (S5, S6, S12, S13, S20-S26, S1-S4, CTRL) needs no
backend and no secrets — it can be a hard gate today. Drop `continue-on-error` for a
demo-only project/grep and widen `UI_PATHS` to `scripts/|styles/|config/`. Leave the
live-gated rows advisory; they're the ones that legitimately can't gate.

### G2 — S10 and S11 still use the ambiguous `.lock-form` selector. **[8]**

#208 fixed `.lock-error` and left the identical pattern two lines above untouched:

```js
const pinInput = page.locator('.lock-form input.input');   // S10 and S11, unscoped
await page.locator('.lock-form button').click();
```

`.lock-form` has two producers — the lock gate (`app.js:1841`) and the
**Ask-the-desk form** (`app.js:1647`). They are mutually exclusive states today, so
the count is 1 and the tests pass. That is the same "1 until it isn't" property
`.lock-error` had before PR #167.

The suite already knows this. `unlockDesk()` (the S15-S19 helper) scopes to
`#accountGrid .lock-form input.input[type="password"]` and carries an explicit
warning: filling the global `.lock-form` after auth *"would type the PIN into the
assistant box and submit it (leaking the real PIN to Anthropic + desk_chat_memory)."*
S10/S11 do not apply that scoping. The hardened knowledge exists in the file and was
not propagated to the two tests #208 was editing.

**Fix:** `#accountGrid .lock-form input.input[type="password"]` in S10 and S11, same
as the helper.

---

## 3. Important improvements (5-7)

### Q4 — Is S11 strong enough post-scoping? Partly. Two real holes.

It asserts the error *appears* and that `#accountGrid .hero-number` count is 0.

**H1 — no text assertion, so S11 cannot tell rejection from outage. [7]**
The submit handler writes one of two strings into that same node
(`scripts/app.js:1866-1871`):

```js
const res = await deskLogin(input.value).catch(() => ({ ok: false,
  error: 'Could not reach the data service — try again in a moment.' }));
...
err.textContent = (res && res.error) || 'PIN not recognized — try again.';
```

Both render identically to `toBeVisible()`. **S11 stays green if the Supabase project
auto-pauses, if `desk_login` is dropped, or if the RPC 500s** — the desk never
validated anything and the test says the auth boundary works. That is the precise
scenario CLAUDE.md's "Supabase free-tier auto-pause runbook" is written about, and
S14 only covers the *public feed* path, not the PIN RPC. The CLAUDE.md row itself
says "shows `.panel-lock .lock-error` **text**"; the test does not read the text.
Add `.toContainText(/not recognized/i)`.

**H2 — "stays locked" and "no data leaks" are under-asserted. [6]**
`hero-number` count 0 is a *render* check, not an *authorization* check. Not asserted:
the lock form is still on screen; `sessionStorage.desk_pin` is unset; `DESK.authed`
is still false. A regression that set `DESK.authed = true` on a rejected PIN would
pass S11 — and post-`desk_011` that flag no longer gates the watchlist writes but
still shapes the Ask panel and the system-prompt editor. Also `toHaveCount(0)`
resolves on its first evaluation, so it can win a race against a late render; asserting
the lock form is still present is strictly stronger, since `loadPrivate()` replaces
the whole grid.

### Q2 — Rows whose stated coverage the test does not deliver

| Row | Claimed | Actually asserted | Rating |
|---|---|---|---|
| **S5** | "every panel lamp reads Demo"; failure = "**any** lamp shows LIVE/EOD/LOCKED" | Only `#newsLamp` + `#askLamp`. There are **six** panel lamps — `wlLamp`, `mktLamp`, `askLamp`, `newsLamp`, `chartsLamp`, `heatLamp`. `#mktLamp` is in CLAUDE.md's own key-selector row and is unchecked. Worse: all six are **hardcoded `Demo` in `index.html`** (`:472,526,546,666,688,749`), so those two assertions pass even if `renderNews`/`renderAsk` never ran. Only `#mastheadState` (empty in markup, `index.html:656`) is a real check. | **6** |
| **S12** | "Pro 3 **alone** carries the Session → Extended hours toggle"; failure = "the EXT toggle offered on Pro 1/Pro 2" | Opens `#wbSettings-p1` (16 boxes) and `#wbSettings-p3` (4 boxes + EXT). **Pro 2's popover is never opened.** The named failure mode — EXT leaking onto Pro 2 — cannot fail this test. | **5** |
| **S13** | "**Live mode additionally** unlocks 1W/1M/YTD on stock cuts once the daily 1y sweep lands (tiles carry `pctW/pctM/pctYtd`)" | Test is `?demo=1` only. The live half of the row has no assertion anywhere in the suite. | **5** |
| **S23** | heatmap "some tiles with `extPct` and some without" | Asserted by calling `buildDemoHeatmap()` directly — it tests the **generator**, not the render. The `.tip-ext` tooltip path the architecture doc describes is never exercised. | **4** |
| **S6** | "sorts rows … first-row value order changes accordingly" | Asserts the two `aria-sort` values are `[ascending, descending]` and that `v1 !== v2`. A shuffle that merely reorders would pass; ordering correctness is not checked. | **4** |
| **S15-S19** | five rows in the authoritative table | Gated on `RUN_ASSISTANT_TESTS` **on top of** live+auth, so they run in **no** CI configuration. Correct by design (real Claude calls, cost, nondeterminism) but it means five table rows describe coverage that has never protected a merge. Worth stating in the table rather than only in the prose below it. | **5** |

### Q1 — Blast radius of a red qa-live window

Rows gated `test.skip(!(await liveBackendConfigured(page)))`, i.e. only ever
meaningful on the deployed site:

- **S10** — valid PIN unlocks accounts
- **S11** — wrong-PIN error (one of the two that was broken)
- **S14** — live-feed canary (`#mastheadState` reads LIVE/EOD)
- **S15, S16, S17, S18, S19** — assistant memory / research / live data / advice
  posture / clear (additionally `RUN_ASSISTANT_TESTS`-gated → never run at all)

Plus the authed half of the generic invariants — **S1, S2, S3, S4, NAV, CTRL** all
route through `gotoAndAuth()`, so on a demo-only desk they only ever exercise the
login screen.

**Two corrections to the premise, both of which enlarge the radius:**

1. `liveBackendConfigured()` reads the **served** `scripts/config.js`, and this repo's
   `DESK_DB.url` is populated. So under `qa.yml` (localhost, serving the repo) S10/S11/S14
   do **not** skip — they run and hit the real Supabase. They simply cannot fail
   anything, because of G1(a). The live-only rows aren't unguarded *because* they're
   live-only; **everything** is unguarded because nothing blocks.
2. Playwright reports per-test, so the other ~18 scenarios still executed during the
   window. The damage is **signal masking**: an already-red run makes a *new* failure
   in S25 or S26 invisible, and `ci-monitor` has been folding every failure into a
   single umbrella issue (below). So the honest blast radius is *the entire suite's
   signal*, for six days — not two tests.

   One thing to verify from the run logs, which I cannot read from here: `qa-live.yml`
   caps the Playwright step at **12 minutes**, and `retries: 1` means a failing NAV
   burned up to `120s × 2 projects × 2 attempts = 480s` on its own. If the step hit its
   timeout, the tail of the suite genuinely never executed and the masking is total
   rather than partial. Worth confirming against run ~197-217.

### Q3 — Table-vs-code disagreements after this diff

**D1 — The S21 row is stale and now contradicts its own test. [7]**
Row: *"must still render **one + per band**"*. Test (`app.spec.js:922-924`):

```js
expect(await page.locator('.wl-strip .wl-add').count(), 'no per-band + survives').toBe(0);
expect(await page.locator('#wlTrayAdd').count(), 'exactly one panel-level +').toBe(1);
```

The 2026-07-31 tray change (documented only in the S26 row) removed the per-band `+`.
The S21 row still describes the superseded design, and so does the architecture prose:
*"A small round + sits in each band's gutter beside the list name (`.wl-band-head`)"*.
The same prose block is internally inconsistent — it says the hold gesture went
"3s → 1s → gone", then describes the hold's fill animation and drag-cancel as
"load-bearing, not polish". Neither is asserted anywhere, because neither exists.

**D2 — S22 and S24 are tests with no row.** The table's own preamble says
*"one `app.spec.js` scenario per row"*. `S22` (duplicate list titles must not misroute
a quick edit — `wlPick` positional resolution) and `S24` (a failed accounts load must
not revoke authentication) are both substantial tests guarding real reported bugs, and
neither appears in the "authoritative list". **[6]**

**D3 — The table preamble is now false.** *"with the desk LIVE (current state) S10/S11
run for real against the dedicated project on every PR."* They run only when `UI_PATHS`
matches, and they cannot fail anything when they do. #208's entire premise is that
qa-live is not a PR gate, yet this sentence — three lines above the row it edited —
still asserts PR-level coverage. **[7]**

**D4 — The key-selector row lists 3 of 6 lamps** (`#newsLamp #askLamp #mktLamp`);
`#wlLamp`, `#chartsLamp`, `#heatLamp` are undocumented. **[3]**

### G3 — NAV asserts nothing on this app, and structurally cannot. [6]

`backControl(page)` matches `[data-back]`, `aria-label*="back"`, or a Back/← button.
Grepping `index.html` and `scripts/app.js` finds **no such control anywhere** — the
only `←` characters in the repo are inside comments. The drill-down loop requires
`hasBack` before it will set `advanced = true`, so `forward.length` can never exceed 1,
so NAV always reaches:

```js
test.skip(true, 'No multi-level drill-down with an in-app back control found — back-flow invariant N/A');
```

CLAUDE.md agrees: *"Nav cards | n/a — single-page dashboard"*.

So NAV has never tested this app. #208's real effect is to convert a **loud 120s
timeout into a silent skip** — an improvement in cost and honesty, but the commit
message frames it as a fix to a test that guards something, and it doesn't. It still
spends up to ~76s × 2 projects clicking real controls on the live authed desk to reach
a foregone conclusion. Either delete it, or replace the crawl with a cheap explicit
assertion ("this app exposes no in-app back control; invariant N/A") that costs 0s
and states the same fact.

Two robustness nits inside the crawl, if it stays:

- `navSkippable()` re-queries `document.querySelectorAll(sel)[index]` *after* prior
  clicks, but the element list was snapshotted once per level. A click that re-renders
  without changing `viewSignature` (which is heading + control counts + a 160-char text
  prefix — a watchlist re-render can leave all three identical) shifts the index→node
  mapping, and a stale index can un-skip a `.wl-tile`. Same positional-fragility class
  as the bug #208 fixed.
- `#wlEditBtn` (class `wl-edit`, in the panel header, outside `.wl-tray`) is not in
  `NAV_SKIP`, so the crawl can open the watchlist editor over the real roster. Bounded
  in practice — any view change `break`s the level — but it is a write-surface modal
  left open against live data.

### G4 — There is no desktop viewport in the suite at all. [7]

`playwright.config.js` defines exactly two projects: `Pixel 5` (393px) and
`iPhone 12` (390px). Every scenario runs at phone width, in both CI workflows.

This makes **S4 ("no horizontal overflow at 390px mobile viewport") tautological** —
it is the only width anything runs at — and it means the desk's actual layout is
untested: `.top-band > .col-markets` at 860px, "~11 tiles per row at 1600px", the
`.wl-strip` band packing, the three-pane split workbench, and the 245×305 widget row
sized against half-width account cards. All of that is described in CLAUDE.md as
deliberate desktop design and none of it is ever rendered by a test.

Related: S26's pointer-based drag is exercised via `page.mouse` on touch-emulating
devices. The implementation comment says it was built on pointer events *"because
mobile never fires dragstart"* — but the test drives it with synthetic mouse input,
so the mobile path it was written for is the one least directly verified.

---

## 4. Test quality issues

- **Style classes used as test hooks.** `.lock-error`, `.lock-form`, `.wl-tile`,
  `.mkt-tile`, `.panel-lock`, `.seg` are all presentational classes doing double duty
  as selectors. #208 patched one instance; the pattern is repo-wide and will recur on
  the next modal. `data-testid` on the handful of nodes tests actually address is the
  durable fix.
- **S5's lamp assertions match static markup**, so they cannot distinguish "rendered
  correctly in demo" from "never rendered". Assert a panel body first (e.g. a
  `.news-row` exists), then the lamp.
- **S23 asserts against a generator function, not the DOM** for the heatmap third.
- **`discoverElements` + `.nth(index)`** is positional addressing over a mutating SPA;
  it is inherently drift-prone (see G3).
- **Positive:** S24, S25 and S21 are genuinely good. S25 in particular is the model —
  it reads colour off the rendered SVG, pane-scopes by title, excludes volume bars,
  scales tolerance with bar spacing, and carries **two negative controls** (the daily
  strip and Pro 1) that must *fail* the same comparison. That is a test that cannot pass
  for the wrong reason. S24 asserts the thing that actually matters
  (`buildAskContext().accounts.length === 0` — no fabricated holdings reach the
  assistant) rather than the surface symptom. S22 tests the resolution function
  directly with a stale-roster negative case.

---

## 5. Q5 — Follow-ups, prioritised

| # | Action | Catches | Rating |
|---|---|---|---|
| 1 | Make the demo subset a **hard PR gate**: drop `continue-on-error` for a demo-only run, and widen `UI_PATHS` to include `scripts/`, `styles/`, `config/`. | Converts ~15 of 20 scenarios from advisory to blocking, and makes them run on the PRs that actually change behaviour. Would have caught the `.lock-error` collision at PR #167 — nine PRs and four months earlier. | **8** |
| 2 | **Selector-contract test** (demo-mode, cheap): a single table of documented selectors → expected count, asserted with `toHaveCount`. Export it from one module that CLAUDE.md's key-selector row is generated from or checked against, so doc and test cannot drift. Include `.lock-error` global count and `.panel-lock .lock-error === 1`. | Exactly the ambiguous-selector class. Playwright's strict mode already detects it — the problem is it only detects it in the state where the element renders, on a workflow nobody reads. A count assertion detects it at authoring time. | **7** |
| 3 | Scope S10/S11 to `#accountGrid .lock-form …[type=password]`, matching `unlockDesk()`. | G2 — the next modal, and S10's PIN-leak-into-the-Ask-box failure mode. | **7** |
| 4 | Add `.toContainText(/not recognized/i)` to S11, plus lock-form-still-visible and `sessionStorage.desk_pin === null`. | H1/H2 — a green S11 on a paused/broken Supabase project, and a `DESK.authed` flip on a rejected PIN. | **7** |
| 5 | Add a **desktop project** (`Desktop Chrome`, 1440px+) to `playwright.config.js`. | G4 — every desktop layout rule in CLAUDE.md is currently unverified, and S4 is tautological without it. | **7** |
| 6 | **Fix the qa-live signal, don't gate it.** Issue **#7 "CI failures detected"** has been **OPEN since 2026-07-09** and was last updated 2026-07-31 — `ci-monitor.yml` *did* fire throughout the window; it folded six days of failures into a permanently-open umbrella issue that had already stopped being read. Change to one issue per (workflow, failing-test-name) signature, auto-closed when that workflow next goes green, with the failing test names in the title. A dedup key that never resets is indistinguishable from silence. | The actual "nobody noticed" mechanism. This is the highest-leverage non-gating fix, and it needs no new workflow. | **7** |
| 7 | Add a **daily scheduled** `qa-live` dispatch. | Today qa-live only fires on a Pages deploy, so a quiet week means no live signal at all, and a red run's age is unbounded. | **5** |
| 8 | Add rows for **S22 and S24**; correct the **S21** row and the watchlist prose to the tray design; correct the table preamble's "on every PR" claim. | D1/D2/D3 — the table is described as authoritative and is currently wrong in three places. | **6** |
| 9 | Either delete **NAV** or replace the crawl with an explicit "no in-app back control; invariant N/A" assertion. Add `.wl-edit` to `NAV_SKIP` if it stays. | G3 — a test that costs ~150s across projects, clicks live write-surfaces, and can never assert. | **5** |
| 10 | Close S12's Pro 2 popover gap (assert no EXT toggle on p1/p2) and S5's lamp gap (all six lamps, after a body-render check). | The two named-but-unasserted failure modes. | **5** |
| 11 | Verify whether the 12-minute step timeout truncated qa-live runs during the window. | Determines whether the tail of the suite executed at all — i.e. whether the masking was partial or total. | **4** |

---

## 6. Positive observations

- #208's two fixes are correct, minimal, and land their reasoning in the code as
  comments rather than only in the commit message — including the measured numbers
  (5 → 1 matches; 62 candidates × 5.8s vs a 120s ceiling; 31 after filtering, ~76s
  worst case). The next person to touch either line has what they need.
- `NAV_SKIP`'s safety rationale is right and specific: a second click on a watchlist
  tile *is* the remove gesture, and `#wlTrayAdd`/`#wlTrash` *do* mutate a real roster.
  Both are correctly covered by the `.wl-tray`/`.wl-trash` entries.
- Updating the CLAUDE.md key-selector row with **why** (`"always scope it"`) rather
  than just the new selector is the kind of change that prevents recurrence.
- The spec-box closure note is honest in the way that matters — it records that E3's
  "live verify" was weaker than it looked during the window rather than ticking four
  boxes quietly. That candour is what made this analysis possible.
- S24, S25, S21 and S22 are strong behavioural tests with real negative controls; the
  suite's problem is not test-writing skill, it is that the results are not wired to
  anything that stops a merge.
