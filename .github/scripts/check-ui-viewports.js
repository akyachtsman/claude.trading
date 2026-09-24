'use strict';
// check-ui-viewports.js — does the installed Playwright config actually declare a
// laptop, a tablet and a phone? (test.md -> UI coverage gates, fifth gate.)
//
// WHY THIS SHAPE. Three static readers were tried; all three failed, twelve
// findings between them (#280, #281, #282), and EVERY failure mode was SILENT —
// a check that goes quiet when it fails reads as having looked. The findings were
// all one thing: a regex approximating what Playwright resolves.
//   * `{ viewport: {width:1440}, ...devices['Pixel 5'] }` runs at 393, not 1440.
//   * commented-out projects counted as coverage.
//   * `devices["iPad …"]` double-quoted; `projects : [` with a space.
// `npx playwright test --list --reporter=json` was MEASURED and ruled out too: it
// exits 0 with 0 specs when TEST_AUTH_CREDENTIAL is unset (the same silent pass),
// and reports `viewport: null` for every project even when all 102 specs
// enumerate — so it cannot answer this question at all (apfp.claude, 2026-08-23).
// A third reason found 2026-08-27: `--reporter=json` REPLACES the config's
// reporters rather than adding to one, so a custom reporter's preprocess() never
// runs under that command. Measured on 1.62.1 — a config whose reporter excludes
// every test listed all three projects and exited 0 with the flag, and exited 1
// having excluded 3 tests without it. Any future rewrite that shells out to
// `--list` must NOT override the reporter, or it reproduces the very false green
// it was written to catch. (templates/actions/ui-suite/action.yml already carries
// this warning for the test run itself; it applies identically to listing.)
//
// So: IMPORT the config and let Node evaluate it. Spread order, quoting, comments
// and the device table all stop mattering, because JavaScript does the resolving.
// That answers WHICH WIDTHS ARE DECLARED, and it is the half of this gate that
// has always worked.
//
// It cannot answer whether anything RUNS at those widths, and #335 records eight
// review rounds and twenty findings from trying — every one a rule correct for
// the example that motivated it and wrong one step out. "Empty" alone had three
// spellings, found one per round. Playwright decides what runs from testDir plus
// testMatch/testIgnore plus grep/grepInvert plus respectGitIgnore plus nested
// .gitignore contents plus shard plus reporter preprocessing plus per-project
// overrides — version-dependent, two of them arbitrary user code, and the config
// object is itself a function of the environment it is evaluated in.
//
// So the second half stops predicting and READS THE RUN. Pass `--report <path>`
// pointing at the JSON report the suite just wrote, and a band is covered when
// some project declared at that width has at least one test whose result status
// is anything other than "skipped". See `readReport()` below. Declared AND
// SCHEDULED, joined by project name in the parent process — a non-skipped result
// is what the run left behind, and a hook failing before the test body leaves
// one too. Never "executed"; that is #348, answered below as RENDERED.
//
// RENDERED, BESIDE SCHEDULED (#348, 2026-09-24). #347 rounds 5-7 had the kit's
// `page` fixture record a width three ways (a marker, at teardown, at
// navigation), and a hook that throws — plain, after requesting `page`, after
// NAVIGATING — defeated each: every one needed a signal that the test BODY
// started, and Playwright gives a fixture none. The lead #348 left unmeasured
// held: Playwright creates a test-scoped fixture when it is first REQUESTED, and
// one requested only by the test body is created after the beforeAll/beforeEach
// hooks. Measured on 1.63.0 with a fixture depending on `page`: a beforeEach
// that throws, a beforeEach that requests `page`, navigates and throws, and a
// throwing beforeAll on a test marked to fail — none created it; an honest
// failing body did. Only a hook that requests the fixture ITSELF creates it
// without the body, which is forgery (#349), not drift. That was round 0, and
// it made the REQUEST the proof — which it is not:
//
// fixture SETUP is still not body entry (Codex, #384 round 1): a sibling
// test-scoped fixture set up after the witness can throw, Playwright then never
// invokes the test callback, and a witness recorded at setup was already on the
// result — a false RENDERED, reproduced on 1.63.0. So the kit's `renderWitness`
// fixture records NOTHING at setup: it yields a function, and each scenario
// body CALLS it as its first statement. The call pushes
// `{ type: 'rendered-viewport', description: '{"width":…}' }` (once per test)
// onto the result's annotations — measured to reach the JSON report on both
// `results[].annotations` and `tests[].annotations`. Only code inside the test
// callback can make that call, so a witness means the callback was ENTERED at
// that width; a body that requests the fixture but never calls it records
// nothing and stays SCHEDULED-only. Keep it NOT `auto: true`: measured, the
// setup-time version was created before the beforeEach hooks when auto.
//
// The gate reads the witnesses from the results it already counts as SCHEDULED
// and, in this (parent) process, bands each width with the SAME bounds as the
// declaration. A class is RENDERED when a project declaring it carries a witness
// whose width is in that class; every other class is SCHEDULED-only. That is a
// DISPOSITION printed under the verdict, never an exit code: the fleet has suites
// that predate the witness, and #348's constraint is that they must not start
// failing. A malformed witness is counted as not rendered and reported, never a
// crash and never a refusal.
//
// ⚠️ LIMITS. The witness records the width at the body's first statement — a
// setViewportSize() later in the body is not seen (S4's `viewport-override`
// marker still does that job). A hook or fixture that requests the witness and
// CALLS it forges it (#349). And
// it proves a page OBJECT had that viewport when the body began, not that the
// app's layout was correct there — that is what the scenarios assert.
//
// A LISTING WAS TRIED FIRST AND IS NOT THIS. `playwright test --list` was the
// #347 design for three rounds and lost on four measured differences from a run,
// each one a false green; `readReport()` below catalogues them. Each was answered
// with a probe or a refusal, and each probe was one more thing the config could
// notice. All four fixtures are kept in the cases suite, and all four are now
// caught by the one rule above.
//
// ⚠️ WHAT THIS STILL CANNOT SEE. The report names projects, not viewports, so the
// WIDTHS still come from importing the config while the EXECUTION comes from the
// run — two evaluations, and a config that returns different viewports to each
// would be believed. Nothing here probes for that: the two evaluations differ
// only in argv and cwd, both of which the run also varies between CI and a
// developer's shell, so a config that is not a stable function of its inputs is
// out of this gate's reach by construction. It is a far narrower hole than the
// listing's, which needed no dishonesty at all — a `.gitignore` or a shard was
// enough.
//
// ⚠️⚠️ THE STANDING LIMIT, AND IT IS ONE LIMIT WEARING TWO FACES. This gate reads
// the config through artifacts produced by processes the CONFIG RUNS IN, and
// there is no authenticated channel out of a process you do not control. So:
//
//   * the JSON report is written by the Playwright process, and the config's own
//     exit handler can replace it after the reporter is done. Codex reproduced a
//     config that rewrote the report with passing results for all three projects
//     when only phone had been scheduled (#347 round 11), and this parser
//     accepted it.
//   * the declaration rows are assembled in the evaluation child, and a
//     corrupted `Array.prototype.push` can put a forged row among them before
//     the parent ever sees one.
//
// Six rounds of hardening bought real ground — the exit path, the bound, the kill
// signal, the verdict file, the nonce, and the band arithmetic all moved out of
// the config's reach — and each of those closed a way to subvert code the gate
// OWNS. Neither of the two above is that. They are the config lying about
// itself, in the only evidence that exists about it.
//
// Nothing closes this, and the shape of the failed attempts says why: every
// candidate mechanism (hash the report before the handler runs, watch the file
// for a second write, capture the array primitives) either lives inside the same
// process or is an enumeration, and every enumeration on #347 was walked around
// within one round. What WOULD close it is an execution channel Playwright does
// not offer.
//
// So the scope is stated rather than defended: THIS GATE CATCHES DRIFT, NOT
// FORGERY. A config that narrows silently — a shard, a `.gitignore`, a filter, a
// device spread overwriting a literal, a project quietly deleted — is what it
// exists for and what it catches. A config written to deceive this gate defeats
// it, and would defeat any check that reads the run through the run's own
// output. Owner decision, 2026-09-02: ship with the limit stated here, in the
// verdict line, and in test.md. Tracked as directives#349.
//
// Without `--report` this gate checks the DECLARATION only and says so in the
// verdict line. That is still a real check — a missing band is exit 1, provable
// from the widths alone — and it is fast enough to run before the suite.
//
// SILENCE MEANS "CHECKED AND FINE", NEVER "COULD NOT LOOK". Every failure has its
// own exit code and its own printed line:
//   0  three classes declared; with --report, also SCHEDULED at those widths
//      (never EXECUTED — a hook can fail before the body and still produce a
//      non-skipped result; see the header's SCHEDULED note and directives#348).
//      The per-class RENDERED / SCHEDULED-only disposition never changes it.
//   1  checked — a class is undeclared (the gate FAILED)
//   2  tests dir not found
//   3  no Playwright config in the tests dir
//   4  @playwright/test not resolvable from the config (CANNOT CHECK)
//   5  importing the config threw, or its export is unusable (CANNOT CHECK)
//   6  zero projects resolved
//   7  reached exit 0 without a verdict — the backstop (a config that calls
//      process.exit(0) at import time would otherwise pass silently)
//   8  usage error (nonsensical band bounds)
//   9  RETIRED by #335 — a top-level selection key used to be refused on
//      presence alone. The run's report settles whether it narrowed anything.
//  10  RETIRED by #335 — a non-built-in reporter used to be refused by name.
//  11  RETIRED by #335 — the built-in reporter list is no longer consulted.
//  12  a band is DECLARED at the right width and NOTHING RAN there (FAILED) —
//      only reachable with --report, and it is the run's own account
//  13  PW_TEST_SOURCE_TRANSFORM and _SCOPE are both set (CANNOT CHECK)
//  14  the config evaluation reported no verdict, or a pass its own data or its
//      exit status does not support, or it never finished (CANNOT CHECK)
//  15  --report was given and the report could not be read (CANNOT CHECK)
//  16  RETIRED — the listing that needed it is gone; see readReport()
//  17  RETIRED — ditto
//  18  two or more projects share a name (CANNOT CHECK) — the gate joins
//      results by project name, so one project's tests would certify another's.
//      The report DOES carry a unique projectId; the refusal stays by owner
//      ruling because it fails closed (#351, see the join comment below)
//  19  RETIRED — `--forbid-only` was a probe against the listing, and a probe
//      the config could observe. The run's report needs no probe.
//  20  --declared was given with --report and the mapping could not be read, or
//      could not be written on the pre-run pass (CANNOT CHECK). Re-importing the
//      config here would restore the re-evaluation the flag exists to prevent,
//      so a missing mapping refuses rather than falling back (#347 round 14).
//  21  the config declared different widths before and after the run, so the
//      carried mapping is not the config the run used (CANNOT CHECK). Agreement
//      proves consistency, never honesty — directives#349.
//  22  --report was given without --declared (CANNOT CHECK). A report verdict
//      rests on TWO independent observations — the widths read BEFORE the run
//      and a fresh import after — and that machinery lives only on the
//      --declared path. `--report` alone imports once, AFTER the run, and
//      attributes the report with whatever that single import says, so a config
//      that answers differently across the run certifies itself (#352).
//
// The three RETIRED codes are kept in this list rather than deleted. They were
// documented exits of a shipped gate, and a reader meeting one in an old CI log
// needs to find out what it meant and why it stopped happening.
// node_modules is environment-provided, not repo-guaranteed: in CI it exists
// because the ui-suite composite ran `npm install` first. Its absence is 4 — a
// loud "cannot check", never a pass.
//
// CommonJS deliberately: the other templates/scripts helpers are CJS
// (notify-email.js, check-contrast.js), and a downstream .github/scripts/package.json
// (the copy of templates/scripts/package.json) carries no "type" field, so an ESM
// .js dropped there would not load at all. Dynamic import() of an ESM config from
// CJS works on Node 20+.
//
// Usage:
//   node .github/scripts/check-ui-viewports.js --tests-dir .github/scripts/ui-tests
//   UI_TESTS_DIR=... node .github/scripts/check-ui-viewports.js
// Options: --config <path>, --tablet-min <px> (768), --laptop-min <px> (1024)

const { existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } = require('fs');
const { createRequire } = require('module');
const { pathToFileURL } = require('url');
const { resolve, join, isAbsolute, dirname } = require('path');
const { tmpdir } = require('os');

// ============================================================================
// THE VERDICT LIVES OUTSIDE THE PROCESS THAT IMPORTS THE CONFIG.
//
// A Playwright config is arbitrary JavaScript, and this gate imports it. Round
// 15 found a config that set `process.exit = () => {}` and turned its own gate
// green; I bound the reference and said plainly that this was a patch and not
// isolation. Round 16 then found `process.on('exit', () => { process.exitCode =
// 0 })`, which the bound EXIT still invokes — same false green, one primitive
// further out. Capturing primitives one at a time is the enumerate-vs-derive
// failure this whole PR is about, applied to my own runtime.
//
// So the config is now evaluated in a CHILD process, and the child reports its
// verdict through a file the parent created. The parent never imports the
// config, so nothing the config does can reach the exit path that decides pass
// or fail. If the child dies without writing a verdict — crash, signal, an exit
// the config forced — the parent has no verdict to report and says so (exit 14),
// which is this file's founding rule applied to its own plumbing: a missing
// answer is never a passing one.
//
// This is the "remove the thing that can be wrong" move that has held three
// times on this PR, rather than a fourth captured primitive.
// ============================================================================
// ============================================================================
// READING THE RUN'S OWN REPORT. Runs in the PARENT, which never imports the
// config.
//
// #335 asked for an observation instead of a config read, and the first answer
// was `playwright test --list`. Three review rounds measured four ways a LISTING
// is not a RUN, and none of them is adversarial:
//   * `--list` appears in `process.argv`, which config code can read.
//   * list mode loads with `filterOnly: false`; a run uses `true`, so one stray
//     `test.only` makes the listing name bands the run never reaches.
//   * list mode skips `globalSetup`, so a suite whose collection depends on
//     setup state enumerates differently than it runs.
//   * a listing carries no DISPOSITION: `testRun.skip()` leaves tests enumerated
//     and their bodies unexecuted, and `--list --reporter=json` reports
//     status "skipped" for every test even when nothing skipped any of them,
//     because nothing runs.
// Each fix for one widened the surface for the next — the `--forbid-only` probe
// added for the second became a third observable mode. That is the plateau #341
// was filed to escape, reached again in three rounds instead of twenty-four.
//
// So the question moved to where it can be answered: the RUN. Playwright's JSON
// reporter records, per test, the project that owned it and whether it actually
// executed. Every one of the four gaps closes at once, because this is not a
// model of the run — it is the run's own account of itself. Nothing here
// predicts, observes from outside, or needs to know which mechanism removed a
// test.
//
// The config import above still answers WHICH WIDTHS ARE DECLARED, because the
// report does not carry per-project viewports (measured: `config.projects[]` has
// name, testDir, testMatch, timeout and no `use`). Declaration from the config,
// execution from the report, joined by project name.
function readReport(reportPath) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return { ok: false, code: 15, lines: [
      `could not read the run's report at ${reportPath}`,
      `  ${(e && e.message) || e}`,
      '  This gate certifies coverage from the run\'s own results. No report is',
      '  "the run did not report", never "nothing ran at those widths".',
    ] };
  }
  // WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT. A result proves a test was
  // SCHEDULED in a project declaring that width. It does NOT prove a page was
  // ever that wide, and the verdict line says so rather than implying more.
  //
  // #347 rounds 5-7 tried to close that gap by having the kit's `page` fixture
  // record the width each page rendered at. Three variants of one finding
  // defeated three implementations: a `beforeAll` that throws, a `beforeEach`
  // that throws, and a `beforeEach` that NAVIGATES and then throws — each
  // producing evidence for a test whose body never ran. Every fix was correct
  // for the variant that motivated it and wrong one step out, which is the
  // exact pattern #335 catalogued twenty times over for config prediction. The
  // mechanism was removed rather than lost to a fourth time; the reasoning is
  // in the PR and the work is filed as directives#348. #348 has since answered
  // it with a body-only witness fixture and a RENDERED disposition beside this
  // verdict — see the header.
  //
  // NON-SKIPPED, not merely present — and non-skipped is as far as it goes. A
  // test the run reports as `skipped` did not run its body (`testRun.skip()` and
  // `test.skip()` both land here), so it is no evidence at all. A non-skipped
  // result is evidence the run SCHEDULED the test, which a hook failing before
  // the body also produces. This is the distinction a listing cannot make at
  // all, and the whole reason the observation moved here.
  //
  // `viewport-override` marks a test that called `setViewportSize()`, which runs
  // at the width IT chose in every project and would otherwise credit its
  // project's declared width (#347 round 4). PER-RESULT, not per-test:
  // Playwright stores a retry's annotation on the test-level list too, so
  // merging them let a retry retroactively discard an honest earlier attempt
  // (round 5).
  // PER-RESULT WHERE THE REPORT HAS IT, PER-TEST WHERE IT DOES NOT. Playwright
  // only began serialising `results[].annotations` after the floor this kit
  // declares: measured on 1.44.0, the key is ABSENT from every result while
  // `tests[].annotations` carries the marker. Reading the result alone there
  // made `overrides()` always false, so S4's marker was ignored and a run
  // containing only S4 certified laptop and tablet — the round-4 false green,
  // restored by the round-5 fix for anyone on an older Playwright (Codex, #347
  // round 8).
  //
  // The FIELD'S PRESENCE is the capability signal, so nothing here reads a
  // version number. Where results carry annotations, each attempt is judged by
  // its own record and a retry cannot retroactively discard an honest earlier
  // one (round 5). Where they do not, the test-level list is the only evidence
  // that exists — retry scoping is unavailable on such a report because the
  // data is, not because this chose to ignore it.
  // PLAYWRIGHT'S OWN STATUSES, AND NOTHING ELSE COUNTS. The predicate below read
  // `r.status && r.status !== 'skipped'`, which counts ANY truthy value: a
  // string Playwright never emits, and an object, both certified three bands at
  // exit 0 (Codex, #347 round 22 — reproduced with `"not-a-playwright-status"`
  // and again with `{"a":1}`). A malformed element was silently ignored rather
  // than refused, so a report could be half-read and still produce a verdict.
  //
  // The list is Playwright's, not a guess: these are the values its JSON
  // reporter emits for a result. An unknown status is a report this gate does
  // not understand, and the only honest answer to that is CANNOT CHECK.
  const STATUSES = new Set(['passed', 'failed', 'timedOut', 'interrupted', 'skipped']);
  const OVERRIDE = 'viewport-override';
  // ANNOTATIONS DECIDE WHETHER A RESULT IS EXCLUDED, so a malformed one is not a
  // detail. `Array.isArray(...) ? ... : []` read a present non-array as absent —
  // the same `x || []` behaviour the round-20/21 work removed everywhere else,
  // left in the one place where the value decides whether evidence counts
  // (Codex, #347 round 23). Through `arr()` now, which distinguishes an omitted
  // field from a present wrong one.
  //
  // The FALLBACK still means what round 8 established: `results[].annotations`
  // where the report has it, `tests[].annotations` where it does not. What
  // changes is that "does not have it" now means the key is absent, not that it
  // holds something unusable.
  //
  // AND THE ENTRIES, not just the container. `some(a => a && a.type === …)`
  // treats `null`, a string or `{ type: 42 }` as a non-override, so a malformed
  // annotation silently turns exclusion OFF and a passed result certifies its
  // band (Codex, #347 round 24). Round 23 validated the array and stopped at its
  // edge — the same one-field-at-a-time pattern this round replaced with a
  // schema. Validate every entry first, then search: a search may stop early, a
  // validation may not (round 23).
  //
  // AND EVERY LIST, not just the one the fallback selected. Round 25 validated
  // entries inside `overrides()`, which reads exactly one of the two lists — so
  // whenever a modern report supplied `results[].annotations`, the test-level
  // array was checked for being an array and its ENTRIES were never read at all:
  // `tests[].annotations: [null]` beside valid per-result lists certified three
  // bands at exit 0 (Codex, #347 round 26). Reproducing it found a second
  // carrier Codex did not name: `overrides()` sits behind `r.status !==
  // 'skipped' &&`, so a SKIPPED result's own annotations were never validated
  // either — `{"status":"skipped","annotations":[null]}` certified the same way.
  //
  // One defect, two carriers, and the same shape as rounds 19-25: the previous
  // round's fix was applied to the list that was named. So validation is no
  // longer a side effect of the search. `checkEntries` runs unconditionally on
  // the test-level list once per test and on each result's list per result,
  // BEFORE any short-circuit can skip it, and the search that replaced
  // `overrides()` (`marks`) reads entries something else has already vouched
  // for. It is a search, so it may still stop early; nothing else depends on
  // it having looked.
  const checkEntries = (list, where) => {
    for (const a of list) {
      if (a && typeof a === 'object' && !Array.isArray(a) && typeof a.type === 'string') continue;
      if (!malformed) {
        malformed = `an annotation in ${where} is ${describe(a)}`
          + `${a && typeof a === 'object' && !Array.isArray(a) ? ` with type ${describe(a.type)}` : ''},`
          + ' expected an object with a string type';
      }
    }
    return list;
  };
  const marks = (list) => list.some((a) => a && typeof a === 'object' && !Array.isArray(a)
    && typeof a.type === 'string' && a.type === OVERRIDE);
  // PARSES IS NOT READS. `JSON.parse` succeeding says the bytes are JSON; it
  // says nothing about the document being a Playwright report, and every level
  // below was written as `x || []`, which handles undefined and null and throws
  // on anything else. Codex reproduced `{"suites":{}}` exiting 1 with an
  // uncaught TypeError and a stack trace — Node's generic failure, not this
  // gate's CANNOT CHECK — so the caller sees a crash where the contract
  // promises exit 15 (#347 round 20).
  //
  // Reproducing the family rather than the instance found it is worse than
  // reported. Seven shapes, two failure modes:
  //
  //   {"suites":{}}                                  TypeError, exit 1
  //   {"suites":[{"specs":{}}]}                      TypeError, exit 1
  //   {"suites":[{"specs":[{"tests":{}}]}]}          TypeError, exit 1
  //   {"suites":[{"specs":[{"tests":[{results:{}}]}]}]}  TypeError, exit 1
  //   {"suites":[null]}                              TypeError, exit 1
  //   "a string"                                     exit 12, NOTHING RAN
  //   42                                             exit 12, NOTHING RAN
  //
  // The last two are the dangerous half and were NOT reported: no crash, no
  // refusal, just a confident FAIL naming three bands as unexercised because
  // `doc.suites` was undefined and `|| []` swallowed it. A wrong verdict reads
  // as a real result; a stack trace at least reads as broken.
  //
  // So the top level is checked before anything walks it, and every nested
  // level that must be an array is checked as it is reached. A missing key is
  // still legitimately empty — Playwright omits `specs` on a suite that has
  // none — but a present non-array is a malformed report, and the difference is
  // exactly what `|| []` could not express.
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.suites)) {
    return { ok: false, code: 15, lines: [
      `the file at ${reportPath} is JSON but not a Playwright run report`,
      `  expected an object with a "suites" array; got ${describe(doc)}`,
      '  Parsing is not reading: a stale, truncated-to-valid or simply different',
      '  JSON file gets refused here rather than counted as a run with no tests.',
    ] };
  }
  let malformed = null;
  // ONLY `undefined` IS AN OMITTED FIELD. Round 20 wrote the rule as "a present
  // non-array is malformed" and then implemented `undefined || null` as absent,
  // which is the old `x || []` behaviour wearing the new rule's clothes:
  // `{"suites":[{"specs":null}]}` was read as an empty report and produced the
  // confident exit-12 NOTHING RAN verdict — the dangerous half of the round-20
  // family, reintroduced by the round-20 fix (Codex, #347 round 21).
  //
  // Playwright omits keys it has nothing for; it does not null them. So a null
  // where an array belongs is a stale or wrong document, and saying so is the
  // whole point of the check.
  const arr = (v, where) => {
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    if (!malformed) malformed = `${where} is ${describe(v)}, expected an array`;
    return [];
  };
  const obj = (v, where) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return true;
    if (!malformed) malformed = `${where} is ${describe(v)}, expected an object`;
    return false;
  };
  // REQUIRED IS NOT THE SAME AS PRESENT-AND-VALID, and `arr()` only ever knew
  // the second. An OMITTED `specs` read as a legitimately empty suite, so a
  // malformed branch was skipped silently beside a valid one and the gate
  // returned a verdict (Codex, #347 round 24). Rounds 20-23 fixed one field per
  // round this way; this is the schema instead of a fifth instance.
  //
  // Measured against a real 1.62.1 report rather than assumed — the shapes below
  // are what its JSON reporter actually emits:
  //   suite   specs REQUIRED, suites OPTIONAL (absent when a suite has no children)
  //   spec    tests REQUIRED
  //   test    projectName REQUIRED string, results REQUIRED
  //   result  status REQUIRED and one of STATUSES
  //   test    annotations REQUIRED — see below
  //   result  annotations OPTIONAL, and ONLY this one
  //
  // Round 24 wrote "OPTIONAL at BOTH levels" and cited round 8's measurement two
  // lines above it, which says the opposite: on 1.44.0 the key is absent from
  // every RESULT while `tests[].annotations` CARRIES THE MARKER. The fallback
  // exists because the per-result field is missing there — the test-level one is
  // what it falls back TO, and is emitted by 1.44 and 1.62.1 alike. Treating it
  // as optional let a report omit the field that carries `viewport-override`
  // evidence and read as an empty list (Codex, #347 round 25).
  //
  // I quoted the measurement and drew the opposite conclusion from it in the
  // same comment. Recorded rather than silently corrected.
  const need = (holder, key, where) => {
    if (holder[key] !== undefined) return arr(holder[key], `${where}.${key}`);
    if (!malformed) malformed = `${where}.${key} is missing, and Playwright always emits it`;
    return [];
  };
  const executed = new Map();
  // project name -> widths its `rendered-viewport` witnesses recorded (#348)
  const witnessed = new Map();
  let badWitness = 0;
  let total = 0;
  const walk = (suite) => {
    if (!obj(suite, 'a suite')) return;
    for (const spec of need(suite, 'specs', 'suite')) {
      if (!obj(spec, 'a spec')) continue;
      for (const t of need(spec, 'tests', 'spec')) {
        if (!obj(t, 'a test')) continue;
        total += 1;
        // THE JOIN KEY IS EVIDENCE TOO. A missing or non-string `projectName`
        // was coerced to '', which is the label a legitimately unnamed project
        // uses — so a malformed test could certify that project's band on a key
        // the report never carried (Codex, #347 round 24). Playwright's
        // JSONReportTest requires the field; an absent one is a report this gate
        // does not understand.
        if (typeof t.projectName !== 'string') {
          if (!malformed) {
            malformed = `a test has projectName ${describe(t.projectName)},`
              + ' expected a string (an unnamed project reports "")';
          }
          continue;
        }
        const name = t.projectName;
        // VALIDATE EVERY RESULT, THEN DECIDE. Round 22 put the validation inside a
        // `some()` predicate, which short-circuits on the first qualifying
        // element: `[{"status":"passed"}, null]` certified three bands because
        // the null was never reached (Codex, #347 round 23). A validating pass
        // cannot be the same pass as an early-exit search — the search is
        // allowed to stop, the validation is not.
        const results = need(t, 'results', 'test');
        // Required, and read once per test rather than per result: the fallback
        // below reaches for it whenever a result omits its own list, which on
        // the 1.44 floor is every result. Validated here, unconditionally, so
        // that a report supplying per-result lists cannot leave it unread.
        const testAnn = checkEntries(need(t, 'annotations', 'test'), 'test.annotations');
        const counts = results.map((r) => {
          if (!obj(r, 'a result')) return false;
          if (typeof r.status !== 'string' || !STATUSES.has(r.status)) {
            if (!malformed) {
              malformed = `a result has status ${describe(r.status)}`
                + `${typeof r.status === 'string' ? ` (${JSON.stringify(r.status)})` : ''},`
                + ' expected one of ' + [...STATUSES].join(', ');
            }
            return false;
          }
          // Both before the `skipped` test below, which used to short-circuit
          // past the only pass that read them (#347 round 26).
          const perResult = checkEntries(arr(r.annotations, 'result.annotations'), 'result.annotations');
          const list = r.annotations === undefined ? testAnn : perResult;
          const counted = r.status !== 'skipped' && !marks(list);
          // THE RENDER WITNESS (#348) — read only from a result that already
          // counts as SCHEDULED, so RENDERED can never claim a class SCHEDULED
          // does not. The widths are only COLLECTED here; which class each
          // falls in is decided in decideFromRows(), with the same bounds that
          // band the declaration. A witness this cannot read is not evidence,
          // and it is not a refusal either: a report that predates the witness,
          // or carries a broken one, still gets its SCHEDULED verdict.
          if (counted) {
            for (const a of list) {
              if (!a || typeof a !== 'object' || Array.isArray(a) || a.type !== WITNESS) continue;
              const w = witnessWidth(a);
              if (w === null) { badWitness += 1; continue; }
              if (!witnessed.has(name)) witnessed.set(name, []);
              witnessed.get(name).push(w);
            }
          }
          return counted;
        });
        const ran = counts.some(Boolean);
        if (ran) executed.set(name, (executed.get(name) || 0) + 1);
      }
    }
    for (const child of arr(suite.suites, 'suite.suites')) walk(child);
  };
  for (const suite of doc.suites) walk(suite);
  // A REFUSAL, NOT A PARTIAL COUNT. Anything malformed anywhere means the tally
  // below is missing whatever that branch held, and a tally with a hole in it is
  // the fail-open shape: it would name bands unexercised on the strength of data
  // that was never read.
  if (malformed) {
    return { ok: false, code: 15, lines: [
      `the run report at ${reportPath} is not shaped like a Playwright report`,
      `  ${malformed}`,
      '  Counting what could be walked would report bands as unexercised on the',
      '  strength of a branch that was never read.',
    ] };
  }
  return { ok: true, total, executed, witnessed, badWitness };
}

// THE WITNESS'S ONE FIELD, READ DEFENSIVELY (#348). The kit writes
// `JSON.stringify({ width, height })` into the annotation's description. Anything
// else — no description, text that is not JSON, JSON that is not an object, a
// width that is not a finite positive number, the `null` a page with no viewport
// emulation records — returns null, and the caller counts it as NOT rendered and
// reports how many it could not read. Never a throw: the witness is optional
// evidence on top of a verdict that stands without it.
const WITNESS = 'rendered-viewport';
function witnessWidth(a) {
  if (typeof a.description !== 'string') return null;
  let v;
  try { v = JSON.parse(a.description); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const w = v.width;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
}

// For the parent's payload diagnostics: same one-word answer, at module scope,
// because `describe` above is local to readReport() (#347 round 25).
function describeTop(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

// For the diagnostics above: what a value IS, in one word, without dumping it.
function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}


// How long the config-evaluation child may take. Two minutes is far past any
// honest evaluation (the shipped kit is well under a second) and well inside the
// ui-suite job's own bound. Named because it appears in the spawn AND in two
// diagnostics, and a bound whose stated value drifts from its enforced one sends
// the reader looking for the wrong thing.
const EVAL_TIMEOUT_MS = 120000;

// ONE READER FOR THE BAND FLAGS, USED BY BOTH PROCESSES. Round 11 gave the
// parent its own parser so a band bound could not be taken from the child's
// payload — right reason, wrong execution: the parent's copy also accepted
// `--tablet-min=900` while the child's `opt()` understood only the
// space-separated form. So a caller using the equals spelling got the parent
// banding at 900 and the child refusing at 768, and since the parent never
// overturns a refusal, a legitimate 850/1100/1300 config was rejected for
// "no phone project" (Codex, #347 round 12).
//
// Two parsers that must agree is the coupling this file keeps being caught by,
// so there is now one. It is still each process reading its OWN argv — the
// child is spawned with `process.argv.slice(2)` verbatim, so the two see the
// same tokens — which is what round 11 was actually protecting: the bound comes
// from the command line in both, never from the payload.
// VALUES ARE NOT FLAGS. Searching the whole argv for `--tablet-min` finds it
// wherever it appears — including as the VALUE of another option. Codex
// reproduced it with an accepted `report-path: --tablet-min`, a legal filename:
// the post-run command becomes `--report --tablet-min`, this read the following
// (nonexistent) token as a band bound, and NaN bounds exited 14 without ever
// reading the report (#347 round 16).
//
// So the scan walks argv in order and steps OVER the value of every option that
// takes one. The list is explicit rather than inferred from a leading `-`,
// because a value can look like a flag — which is the whole finding.
//
// ONE SCANNER, USED BY EVERY FLAG THIS PROCESS READS. Round 16 fixed the band
// bounds and round 14's `--declared` with the same walk written out twice, and
// left `--report` on a bare `indexOf`. Codex found the third copy by the same
// construction as the first: `--config --report`, with a config file literally
// NAMED `--report`, made the whole-argv search land on the config's VALUE and
// read the token after it as the report path — exit 8 for a missing path on a
// command that supplied none (#347 round 18).
//
// That is the idiom propagating rather than a new bug: the value-stepping was
// written twice and the third reader was not brought along. So the walk exists
// once now and the three flags are defined in terms of it — a fourth reader
// inherits the rule instead of re-deriving it.
const VALUE_OPTS = new Set(['--tests-dir', '--config', '--report', '--declared',
  '--tablet-min', '--laptop-min']);
const argOpt = (flag) => {
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === flag) return { value: process.argv[i + 1], given: true };
    if (a.startsWith(`${flag}=`)) return { value: a.slice(flag.length + 1), given: true };
    // Step over this option's value so it is never read as a flag itself.
    if (VALUE_OPTS.has(a)) i += 1;
  }
  return { value: undefined, given: false };
};
const bandOpt = (flag, fallback) => {
  const hit = argOpt(flag);
  return hit.given ? { value: Number(hit.value), given: true } : { value: fallback, given: false };
};

// A PRESENT FLAG WITH AN EMPTY VALUE IS A USAGE ERROR — CHECKED BEFORE ANY PATH
// SPLITS. Round 19 added this for `--config` and `--tests-dir` and put it in the
// CHILD section, which the carried-mapping path never reaches: Codex ran
// `--tests-dir '' --config '' --declared <map> --report <report>` and got the
// SCHEDULED verdict at exit 0, while the same flags refused at 8 on the
// config-import path (#347 round 20). One command, two answers, decided by which
// branch it happened to take.
//
// That is the round-19 bounds finding again — a usage check on one side of a
// split — and it recurred because I fixed the reported flags rather than moving
// the check. So it lives here now, above `decideFromRows`, above the
// VERDICT_FILE branch, above the spawn: every invocation passes through it.
//
// STRICTLY EMPTY, NOT TRIMMED-EMPTY. The first version called `.trim()`, which
// refused a config file or directory named with spaces — a legal filename the
// filesystem and every earlier version of this gate accept (Codex, same round).
// A flag the caller supplied with a real value is the caller's business; the
// only thing being refused is a flag supplied with NO value, which is what an
// unset variable inside quotes expands to.
for (const [flag, why] of [
  ['--tests-dir', 'names the suite to read; empty falls through to UI_TESTS_DIR and then to a hard-coded default'],
  ['--config', 'names the config to import; empty falls through to implicit discovery'],
  ['--declared', 'names the mapping carried across the run'],
  ['--report', 'asks for the execution check; empty is an unset or empty `report-path` in the ui-suite composite'],
  // THE NUMERIC FLAGS TOO. Not reported for these, and the same construction
  // defeats them harder: `Number('')` is 0, not NaN, so an empty bound slipped
  // past the NaN guard and REBANDED the whole config — every positive-width
  // phone project reclassified as tablet, reported as a missing phone
  // declaration at exit 1 rather than a usage error (Codex, #347 round 21,
  // filed against `--tablet-min` alone).
  //
  // Adding them here rather than beside the NaN check keeps one rule in one
  // place, which is what round 20 was about.
  ['--tablet-min', 'sets the tablet floor; `Number(\'\')` is 0, which silently rebands every project'],
  ['--laptop-min', 'sets the laptop floor; `Number(\'\')` is 0, which silently rebands every project'],
]) {
  const hit = argOpt(flag);
  if (hit.given && (hit.value === undefined || hit.value === '')) {
    console.error(`CANNOT CHECK: ${flag} was given with no value.`);
    console.error(`  It ${why}.`);
    console.error('  Passing the flag names something specific, so an empty value is a usage');
    console.error('  error rather than a reason to fall back. In a wrapper this is an unset');
    console.error('  variable inside the quotes.');
    console.error('check-ui-viewports: FAIL (code 8)');
    process.exit(8);
  }
}

// THE BAND DECISION AND THE JOIN, IN ONE PLACE, called from two.
//
// Round 14 gave the post-run invocation a second way in — reading the mapping
// carried from before the run instead of importing the config again — and two
// callers computing the verdict separately is precisely the shape this file has
// been burned by (two flag parsers, two escaping rules, two definitions of
// "inside the workspace"). So there is one.
//
// ROWS are already structurally validated by the caller in the carried case and
// by the nonce check in the spawned case; this validates them again because it
// is the function that acts on them.
function decideFromRows(ROWS, TESTS, SOURCE) {
  const bands = ['laptop', 'tablet', 'phone'];
  // THE PARENT COMPUTES THE BANDS. It does not read a `cover` map, because
  // there is no longer one to read.
  //
  // Until round 11 the child sent both the rows and its own `cover`, and this
  // block checked `cover[b].length > 0` — trusting exactly the arithmetic the
  // comment two hundred lines down claimed the parent was re-doing. Codex
  // showed the gap with `Array.prototype.filter = () => []` plus
  // `Array.prototype.toJSON = () => ['phone']`: the LEGITIMATE child stamps the
  // real nonce onto forged arrays, so authentication of the writer said nothing
  // about the content, and a phone-only config printed all three bands.
  //
  // The nonce answers "who wrote this". This answers "is it true", and the two
  // are different questions — conflating them is what the round-10 fix quietly
  // did. So the payload now carries only OBSERVATIONS (a project name and the
  // number its config gave for width) and every conclusion is drawn here, by a
  // process that never imported the config.
  //
  // Band bounds are re-derived from argv rather than taken from the payload,
  // for the same reason: a bound the child supplies is a bound the config can
  // choose. This duplicates the parsing further down (that copy runs in the
  // child) — two readings of one flag, deliberately, because the alternative is
  // the child telling the parent what "laptop" means.
  const tabletMin = bandOpt('--tablet-min', 768).value;
  const laptopMin = bandOpt('--laptop-min', 1024).value;
  // BOUNDS ARE A USAGE ERROR HERE TOO, AND THIS PATH USED TO SWALLOW THEM.
  // The child refuses nonsensical bounds at exit 8 before importing anything.
  // The carried-mapping path (`--declared` with `--report`) never reaches the
  // child, so `--tablet-min 1200 --laptop-min 1000` fell through the guard on
  // the banding loop below, produced an empty cover map, and surfaced as exit
  // 14 — "a pass its own data does not support", which blames the mapping for
  // the caller's command line (Codex, #347 round 19).
  //
  // Same numbers, same message, same exit as the child. Two paths that band
  // rows must refuse the same bounds or the exit code stops meaning anything.
  if (!Number.isFinite(tabletMin) || !Number.isFinite(laptopMin) || tabletMin >= laptopMin) {
    console.error(`CANNOT CHECK: nonsensical band bounds (tablet-min=${tabletMin}, laptop-min=${laptopMin})`);
    console.error('check-ui-viewports: FAIL (code 8)');
    process.exit(8);
  }
  // STRICT ROWS. Every row must be an object with a string name; `width` is
  // optional (the UNCLASSIFIABLE rows carry none) but when present must be a
  // finite number. A `toJSON` hook that collapses the array to strings, or an
  // object prototype that reshapes the entries, fails here rather than
  // arriving as a plausible-looking cover map.
  const rowList = Array.isArray(ROWS) ? ROWS : null;
  const rowsWellFormed = rowList !== null && rowList.every(r => r && typeof r === 'object'
    && !Array.isArray(r) && typeof r.name === 'string'
    && (r.width === undefined || (typeof r.width === 'number' && Number.isFinite(r.width))));
  const cover = { laptop: [], tablet: [], phone: [] };
  // ONE BANDING RULE, for the declared widths AND the witnessed ones (#348), so
  // RENDERED and DECLARED can never disagree about what "tablet" means.
  const bandOf = w => (w >= laptopMin ? 'laptop' : w >= tabletMin ? 'tablet' : 'phone');
  if (rowsWellFormed && Number.isFinite(tabletMin) && Number.isFinite(laptopMin)
      && tabletMin < laptopMin) {
    for (const r of rowList) {
      if (typeof r.width !== 'number' || !Number.isFinite(r.width)) continue;
      cover[bandOf(r.width)].push(r.name);
    }
  }
  const ok = rowsWellFormed && bands.every(b => cover[b].length > 0);
  // THE VERDICT STATES ITS OWN BANDS (#328). The gate proves three width
  // CLASSES are covered, not that the project's own breakpoints are: a design
  // whose widest tier starts at 1400 passes with a 1024 "laptop" that never
  // renders that tier. A green that prints the bounds it used can be checked
  // against the design by the next reader; a bare OK reads as total scope.
  const bandsUsed = () => console.log(`  (bands: laptop >=${laptopMin}px, tablet >=${tabletMin}px and <${laptopMin}px, phone <${tabletMin}px`
    + ` — width CLASSES, ${bandOpt('--tablet-min', 768).given || bandOpt('--laptop-min', 1024).given ? 'from --tablet-min/--laptop-min' : 'the DEFAULTS'};`
    + ' NOT a check of this project\'s own breakpoints. Compare these bounds with'
    + ' the design\'s tiers: one starting above the laptop floor is not covered by this line.)');
  if (ok) {
    // ── STAGE TWO: WHAT THE RUN SCHEDULED ────────────────────────────────
    // Only when a report is supplied. Without one this gate reports what the
    // config DECLARES and says so plainly — that is a real check (a missing
    // band is exit 1 and provable from the widths alone) and it is fast enough
    // to run before the suite. The coverage claim needs the run, and the
    // ui-suite composite invokes this again with `--report` afterwards.
    // Read from argv directly: `opt()` is defined further down, in the section
    // that runs in the CHILD, and this block is the parent.
    // BOTH SPELLINGS, still. The original reason was a disagreement: round 7
    // found check-ui-suite-env.py accepting `--report=<path>` while this
    // parser understood only the space-separated form, so that spelling passed
    // the guard and then got the declaration-only verdict at exit 0 — the
    // guard certifying a command this script silently ignored.
    //
    // That guard no longer decides anything from the flag's spelling: since
    // round 10 it pins the composite's command bodies verbatim, and the pinned
    // post-run body uses the space-separated form. So the coupling is gone
    // rather than resolved. Both spellings stay supported HERE because this
    // script is also run by hand and from project scripts, where `--report=`
    // is the more natural spelling, and a flag that is silently ignored is the
    // exact failure round 7 recorded.
    //
    // BOTH SPELLINGS THROUGH THE SHARED SCANNER, which is also what makes a
    // config named `--report` stop being read as this flag (#347 round 18).
    const reportOpt = argOpt('--report');
    const reportArg = reportOpt.value;
    // A PRESENT FLAG WITH NO PATH IS A USAGE ERROR, NOT A QUIETER CHECK.
    // `--report ''` — which is what an unset REPORT_PATH expands to in the
    // composite — used to fall through the truthiness test and print the
    // DECLARED verdict, so the caller asked for the execution check and got
    // silence with a passing exit (Codex, #347 round 6). Someone who passes
    // the flag wants stage two; if the path is missing, say so.
    // (`--report ''` already refused at exit 8 above the parent/child split —
    //  round 6's rule, moved in round 20 so every path is behind it.)
    if (reportArg) {
      // THE PHYSICAL TESTS DIRECTORY, NOT THE LEXICAL ONE. Playwright's own
      // process is already INSIDE the symlink's target — `chdir` resolves
      // symlinks — so a reporter writing `../report.json` from a suite at
      // `real/tests` exposed as `link` lands it in `real/`. Resolving the
      // same relative path against the lexical `link` normalises the `..`
      // BEFORE the symlink is followed and looks beside `link` instead, so a
      // successful run reported exit 15, report unreadable (Codex, #347 round
      // 14). Same lesson the config resolution learned in #333 round 14, in
      // the one place it had not been applied.
      const testsReal = (() => { try { return realpathSync(TESTS); }
        catch { return TESTS; } })();
      const run = readReport(isAbsolute(reportArg) ? reportArg : resolve(testsReal, reportArg));
      if (!run.ok) {
        console.error('CANNOT CHECK: could not read what the run did.');
        for (const line of run.lines) console.error(`  ${line}`);
        console.error(`check-ui-viewports: FAIL (code ${run.code})`);
          process.exit(run.code);
      }
      // ONE LABEL FOR THE EMPTY KEY, and it is only ever a LABEL. The join
      // runs on the raw name, so a project actually named `(no name)` is a
      // different key from a project with none — Codex reported the reverse
      // for the old `(unnamed)` sentinel (#347 round 3), which was a real
      // collision because the two sides of the join disagreed. They agree now
      // (both use the empty string), and this only decides what gets printed.
      // Without it a `declared by:` line for an unnamed project printed empty.
      const label = n => (n === '' ? '(no name)' : n);
      const ranIn = n => (run.executed.get(n) || 0) > 0;
      const missing = bands.filter(b => !cover[b].some(ranIn));
      if (missing.length) {
        for (const b of missing) {
          console.error(`FAIL: ${b} is declared but NOTHING RAN at that width.`);
          console.error(`  declared by: ${cover[b].map(label).join(', ')}`);
        }
        const ran = [...run.executed.entries()].map(([n, c]) => `${label(n)}:${c}`).join(', ');
        // COUNTED, NOT EXECUTED — the same correction the success verdict got.
        // `readReport()` establishes a non-skipped result, which a hook failing
        // before the test body also produces (Codex, #347 round 20).
        //
        // The line above it says NOTHING RAN, and that one stays: it claims
        // LESS than the evidence, not more. Nothing scheduled entails nothing
        // executed, so the negative direction is sound where the positive is
        // not — which is the whole asymmetry this verdict is named for.
        console.error(`  the run left ${[...run.executed.values()].reduce((a, b2) => a + b2, 0)} of ${run.total} test(s) with a non-skipped result: ${ran || '(none)'}`);
        console.error('  This is the run\'s own report, not an inference: the widths are declared');
        console.error('  correctly and the run scheduled nothing at them. A filter, an ignore');
        console.error('  rule, a shard, a reporter, a focused test, a global setup — this gate');
        console.error('  does not need to know which, because it is reading the outcome');
        console.error('  rather than predicting it.');
        console.error('  test.md -> UI coverage gates, fifth gate.');
          process.exit(12);
      }
      const where = b => cover[b].filter(ranIn).map(label).join('/');
      console.log(`check-ui-viewports: OK — SCHEDULED laptop:${where('laptop')}  tablet:${where('tablet')}  phone:${where('phone')}`);
      bandsUsed();
      // ── RENDERED, PER CLASS, BESIDE SCHEDULED (#348) ─────────────────────
      // A class is RENDERED when some project DECLARING it has a counted result
      // carrying a `rendered-viewport` witness whose width falls in THAT class,
      // banded here with the same bounds as the declaration. A witness from the
      // body's call to the kit's `renderWitness()` means a test body started
      // with the page at that width. The rest are SCHEDULED-only, which is today's verdict,
      // unchanged: this line adds a disposition and never an exit code, so a
      // suite that predates the witness passes exactly as it did.
      const rendered = bands.filter(b => cover[b].some(n => ranIn(n)
        && (run.witnessed.get(n) || []).some(w => bandOf(w) === b)));
      const onlySched = bands.filter(b => !rendered.includes(b));
      console.log(`  disposition: ${[
        rendered.length ? `RENDERED ${rendered.join(',')}` : '',
        onlySched.length ? `SCHEDULED-only ${onlySched.join(',')}` : '',
      ].filter(Boolean).join(' · ')}`);
      if (run.badWitness > 0) {
        console.log(`  (${run.badWitness} rendered-viewport witness(es) could not be read — not JSON`);
        console.log('   with a finite positive width — and were counted as NOT rendered.)');
      }
      console.log('  (RENDERED: a test BODY started with the page at a width in that class —');
      console.log('   the body CALLS the kit\'s `renderWitness()` as its first statement, and');
      console.log('   only code inside the test callback can, so a hook or fixture that throws');
      console.log('   first leaves no witness. It does NOT see a setViewportSize() later in the');
      console.log('   body, and a hook or fixture that calls the witness itself forges it —');
      console.log('   drift, not forgery, #349. SCHEDULED-only: no in-band witness — a test');
      console.log('   that does not call it, or a suite that predates it. Not a failure.');
      console.log('   directives#348.)');
      console.log('  (SCHEDULED: a NON-SKIPPED result in a project declaring each width. That');
      console.log('   alone does NOT establish that a page was rendered at it, or that a test');
      console.log('   body ran at all: a test that never opens a page, or whose body never');
      console.log('   starts because a hook threw first, counts there — which is why the');
      console.log('   RENDERED disposition above needs the witness. See test.md -> UI coverage gates.)');
      console.log('  (evidence: the run\'s own report, written by the process the config');
      console.log('   runs in. A config that REPLACES it defeats this — the gate catches');
      console.log('   drift, not forgery. directives#349.)');
      console.log(`  (from the run's own report: ${[...run.executed.values()].reduce((a, b2) => a + b2, 0)} of ${run.total} test(s) with a non-skipped result)`);
    } else {
      // THE PRE-RUN INVOCATION. Write the mapping so the post-run one joins
      // against the widths the config declared BEFORE the suite ran, rather than
      // importing it again afterwards (#347 round 14). Written only on a PASS:
      // a refusal has already exited, and a mapping for a config this gate
      // rejected is not one anything should later read.
      if (declaredIdx.given) {
        try {
          // MAKE THE DIRECTORY FIRST. The shipped default report-path is
          // `../../../.agent-reports/playwright-results.json`, and on a clean
          // runner `.agent-reports/` does not exist yet — Playwright creates its
          // own output directories, but it has not run when this executes. So
          // the round-14 sidecar threw ENOENT and exited 20 BEFORE the suite
          // started, which would have failed the shipped composite on every
          // fresh checkout (Codex, #347 round 15). Reproduced: exit 20 on a
          // bare tree with the default path.
          mkdirSync(dirname(resolve(declaredIdx.path)), { recursive: true });
          writeFileSync(declaredIdx.path,
            JSON.stringify({ rows: rowList, testsDir: TESTS }), 'utf8');
        } catch (e) {
          console.error('CANNOT CHECK: could not write the declared mapping.');
          console.error(`  --declared ${declaredIdx.path}`);
          console.error(`  ${(e && e.message) || e}`);
          console.error('  The post-run check reads this file and refuses without it, so a');
          console.error('  silent skip here would surface as a confusing refusal later.');
          console.error('check-ui-viewports: FAIL (code 20)');
          process.exit(20);
        }
      }
      const shown = b => cover[b].map(n => (n === '' ? '(no name)' : n)).join('/');
      console.log(`check-ui-viewports: OK — DECLARED laptop:${shown('laptop')}  tablet:${shown('tablet')}  phone:${shown('phone')}`);
      bandsUsed();
      // WHAT --report BUYS, IN THE SAME WORDS THE VERDICT USES. This line said
      // "certify that scenarios actually ran at these widths" — the EXECUTED
      // claim the whole gate withdrew in favour of SCHEDULED. A hook that fails
      // before the test body starts still produces a non-skipped result, so the
      // report cannot say a scenario ran; it says Playwright scheduled one under
      // a project declaring that width. Missed when the contract was corrected,
      // and re-stated when the sidecar guidance went in beside it (#347 r17).
      console.log('  (declared, not executed — pass --report <playwright json> after the run');
      console.log('   for the SCHEDULED check: a non-skipped result under a project declaring');
      console.log('   each width, plus a RENDERED disposition for each class whose results');
      console.log('   carry the kit\'s render witness — see test.md -> UI coverage gates, and');
      console.log('   directives#348.)');
      if (declaredIdx.given) console.log(`  (mapping written for the post-run check: ${declaredIdx.path})`);
    }
  }
  if (!ok) {
    console.error('CANNOT CHECK: the evaluation reported a pass its own data does not support.');
    console.error('  Every band must be covered by at least one unrestricted project for a');
    console.error('  pass to stand, and the reported rows do not show that.');
    console.error(`  source: ${SOURCE}`);
    console.error('  The child computes with whatever the config left of the runtime; this');
    console.error('  process re-checks the conclusion with intrinsics the config never saw.');
    console.error('check-ui-viewports: FAIL (code 14)');
    process.exit(14);
  }
  process.exit(0);
}

// THE DECLARED MAPPING, CARRIED FROM BEFORE THE RUN TO AFTER IT.
//
// The composite invokes this gate twice, and until round 14 the SECOND
// invocation imported the config again — after globalSetup, the tests and
// globalTeardown had all run. A config whose project→width mapping depends on
// state the run creates therefore gave a different answer to the join than it
// gave to the run. Codex reproduced it with a `globalTeardown` writing a marker:
// the run scheduled A/B/C at laptop/tablet widths with phone project D matching
// nothing, and the post-run evaluation reclassified C as phone, so the gate
// exited 0 with `SCHEDULED … phone:C`.
//
// With `--declared <path>` the mapping crosses the run instead of being
// re-derived: the pre-run invocation WRITES it, the post-run invocation READS it
// and does not import the config at all. The run's own evaluation happens
// between the two, so the pre-run answer is the nearest thing to it that exists
// outside the run.
//
// ⚠️ What this does NOT establish, stated because the neighbouring comment
// already had to: a config keyed on state `globalSetup` creates still differs
// between this gate and the run, since globalSetup executes inside the run step.
// That is the same family as directives#349 — evidence produced by processes the
// config runs in — and this closes the teardown half of it, not the whole.
const declaredIdx = (() => {
  // Through the shared scanner: a report-path of `--declared` is a legal
  // filename and must not be read as this flag (#347 round 16).
  const hit = argOpt('--declared');
  return { path: hit.value, given: hit.given };
})();

const VERDICT_FILE = process.env.__UI_VIEWPORTS_VERDICT_FILE;
// The pre-run declaration, when one was carried. Set in the branch below and
// consumed after the spawn, so the post-run pass can compare it against a fresh
// import rather than trusting it alone (#347 round 22).
let CARRIED = null;
if (!VERDICT_FILE) {
  // READ THE MAPPING RATHER THAN RE-DERIVE IT. Only when a report is also being
  // read: without one this IS the pre-run invocation, whose job is to produce the
  // mapping. `--declared` with `--report` and no readable file is a refusal, not
  // a fallback to importing — falling back would silently restore exactly the
  // re-evaluation this flag exists to prevent.
  // Through the shared scanner too. A whole-argv `includes` said yes to
  // `--config --report`, so a config NAMED `--report` sent this branch looking
  // for a mapping the command never asked for (#347 round 18).
  const wantsReport = argOpt('--report').given;
  // ⚠️ A REPORT VERDICT FROM `--report` ALONE RESTS ON ONE OBSERVATION, NOT TWO.
  // Rounds 14 and 22 built the carried mapping so the widths a verdict names are
  // read BEFORE the run and cross-checked against a fresh import after it — but
  // only on the `--declared` path. `--report` alone imports the config once,
  // AFTER the run, and attributes the report with whatever that import says.
  // Measured: a config whose `globalTeardown` drops a marker declares 390/390/390
  // before the run and 1280/900/390 after; the run prints 390 for all three and
  // `--report report.json` returns exit 0 SCHEDULED for laptop/tablet/phone
  // (Codex, #347 round 32). The mapping and the run are meant to be two
  // independent observations; this path is one wearing the shape of two.
  //
  // FIXED IN #352, by refusing rather than by degrading. The two candidate
  // remedies were: report a weaker verdict on this path, or refuse it. A weaker
  // verdict still prints SCHEDULED and still gets read as coverage — the whole
  // subject of this gate is that a cheap observable standing in for the property
  // is indistinguishable from the property — so the path that cannot make the
  // claim does not make it.
  //
  // Nothing is lost that was ever sound: the composite has always passed both
  // flags, and `check-ui-suite-env.py` pins that, so no shipped CI path changes.
  // What changes is the DIRECT invocation documented in test.md, which now names
  // both flags because a single import after the run cannot corroborate itself.
  if (wantsReport && !declaredIdx.given) {
    console.error('CANNOT CHECK: --report was given without --declared.');
    console.error('  A report verdict rests on TWO independent observations: the widths the');
    console.error('  config declared BEFORE the run, and a fresh import after it. Reading the');
    console.error('  config once, after the run, is one observation wearing the shape of two —');
    console.error('  a config whose globalTeardown changes what it declares then certifies');
    console.error('  itself (measured: declares 390/390/390 before, 1280/900/390 after, and');
    console.error('  --report alone returned exit 0 SCHEDULED for all three bands).');
    console.error('  Run the pre-run pass first, then pass its mapping back:');
    console.error('    node check-ui-viewports.js --tests-dir <d> --declared <map>');
    console.error('    npx playwright test');
    console.error('    node check-ui-viewports.js --tests-dir <d> --declared <map> --report <json>');
    console.error('check-ui-viewports: FAIL (code 22)');
    process.exit(22);
  }
  if (declaredIdx.given && wantsReport) {
    let carried = null;
    try { carried = JSON.parse(readFileSync(declaredIdx.path, 'utf8')); } catch { /* below */ }
    // `testsDir` IS PART OF THE SHAPE, and validating only `rows` left it out.
    // It is handed straight to `realpathSync` and `resolve()`, so a mapping with
    // it missing or non-string produced Node's ERR_INVALID_ARG_TYPE at exit 1
    // with a stack trace, rather than the exit-20 refusal this branch promises
    // (Codex, #347 round 21). Validating the fields you happen to read is the
    // same partial check as `x || []`.
    const ok = carried && typeof carried === 'object' && !Array.isArray(carried)
      && typeof carried.testsDir === 'string' && carried.testsDir !== ''
      && Array.isArray(carried.rows) && carried.rows.every(r => r
      && typeof r === 'object' && !Array.isArray(r) && typeof r.name === 'string'
      && (r.width === undefined || (typeof r.width === 'number' && Number.isFinite(r.width))));
    if (!ok) {
      console.error('CANNOT CHECK: the declared mapping from before the run could not be read.');
      console.error(`  --declared ${declaredIdx.path}`);
      console.error('  The pre-run invocation writes this file; the post-run one reads it so the');
      console.error('  join uses the widths the config declared BEFORE the suite ran. Re-importing');
      console.error('  the config here would ask a config that may depend on run state (#347');
      console.error('  round 14), so a missing mapping refuses rather than falling back.');
      console.error('check-ui-viewports: FAIL (code 20)');
      process.exit(20);
    }
    // THE SIDECAR IS STATE THIS GATE CREATES BETWEEN THE TWO EVALUATIONS, and
    // round 14 shipped it without noticing that. The pre-run pass imports the
    // config while the file is ABSENT and then writes it; Playwright imports the
    // same config while it is PRESENT. So a config that reads the sidecar
    // declares one thing to the check and another to the run, and the carried
    // mapping — the whole point of which is to be the pre-run truth — becomes the
    // lie. Codex reproduced it: three projects declaring 1280/900/390 before the
    // command and 390/390/390 during the run, an honest report naming all three,
    // and exit 0 claiming every band (#347 round 22).
    //
    // This is round 1's argv finding again in a different costume, and the
    // precedent from that round is the one to follow: when the GATE creates the
    // distinguisher, do not document it — remove its power. Hiding the path does
    // not work (any directory is enumerable, and the child's own argv carries it),
    // and carrying the mapping out of band does not either: every channel GitHub
    // Actions offers is a file the config can read or an env var the composite's
    // parity rule puts on the run step too.
    //
    // So the mapping stops being trusted on its own. The post-run pass imports
    // the config AGAIN and the two declarations must AGREE; where they do not,
    // the config answered differently across the run and no verdict is available.
    // Round 14's property is preserved exactly — the verdict is still computed
    // from the PRE-RUN rows, never the post-run ones — so a config that drifts
    // innocently is refused rather than silently re-banded, which is what round
    // 14 was about. What is added is that drifting is now visible.
    //
    // ⚠️ WHAT THIS DOES NOT ESTABLISH. Agreement means the config answered the
    // same way twice, not that it answered honestly: a config that reads the
    // sidecar and lies CONSISTENTLY — narrow before the run and narrow after —
    // agrees with itself and is believed. That is directives#349's family, and
    // the gate says so rather than implying more.
    CARRIED = { rows: carried.rows, testsDir: carried.testsDir };
  }

  const { spawnSync } = require('child_process');
  const { randomBytes } = require('crypto');
  const box = mkdtempSync(join(tmpdir(), 'ui-viewports-verdict-'));
  const file = join(box, 'verdict.json');
  // THE PATH IS NOT A SECRET AND CANNOT BE MADE ONE. Round 18's fix deleted the
  // env var before the config could read it; Codex round 20 walked around it by
  // enumerating os.tmpdir() for `ui-viewports-verdict-*`, taking the newest, and
  // writing {"code":0} plus a three-band `.rows` from an exit listener — then
  // setting process.exitCode = 0 so the corroboration check above saw a clean
  // end too. Reproduced here: the gate printed its own `FAIL (code 1)` and then
  // exited 0 with `OK — DECLARED laptop:phone tablet:phone phone:phone`.
  //
  // Nor would deleting the variable "harder" have helped: /proc/self/environ is
  // a snapshot taken at exec and `delete process.env.X` does not touch it
  // (measured — the deleted key is still there), so ANYTHING passed to the child
  // through the environment is readable by the config no matter what this file
  // does with it afterwards.
  //
  // So the file stops being the credential. The parent mints a nonce, the child
  // stamps it into both payloads, and a payload without it is not from the child
  // — whoever wrote it and wherever it landed. The nonce reaches the child over
  // STDIN, which is a one-shot channel: the child consumes it before importing
  // anything, and a later read of fd 0 returns "" (`/proc/self/fd/0` is ENXIO).
  // That is the only channel here that a config cannot go back and re-read.
  const nonce = randomBytes(24).toString('hex');
  // ONE CLEANUP, ON EVERY PATH. The box used to be removed at the two exits that
  // remembered to, and the parent has eleven. Measured while reproducing the
  // forgery above: a scratch /tmp held 230 abandoned `ui-viewports-verdict-*`
  // directories, every one from a refusal branch — which is also what made the
  // forge's `readdirSync` enumeration so comfortable. An exit hook covers the
  // refusals, the early returns and a throw alike, so a branch added later
  // cannot forget.
  process.on('exit', () => { try { rmSync(box, { recursive: true, force: true }); } catch {} });
  let child;
  try {
    // BOUNDED. The child IMPORTS the config, which is arbitrary code, and an
    // import that leaves a live handle never lets the child exit — a plain
    // `setInterval(() => {}, 1000)` at module scope is enough, and Playwright
    // lists such a config without complaint. Unbounded, this gate then hung
    // until something outside killed it, consuming the whole job's budget and
    // producing none of the CANNOT CHECK verdicts it promises. A guard that
    // hangs is worse than one that refuses: the refusal is a result.
    //
    child = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      timeout: EVAL_TIMEOUT_MS,
      // SIGKILL, NOT THE DEFAULT SIGTERM. `spawnSync`'s timeout kills with
      // SIGTERM, which a config can install a handler for — and a handler that
      // does not exit, plus one live handle, makes the bound do nothing at all.
      // Codex reproduced it on Node 20 (#347 round 4) and so did I: with a
      // 500ms bound the call had still not returned when an external `timeout 8`
      // killed it. SIGKILL cannot be caught, so the advertised bound holds
      // against config code rather than only against honest configs. Measured
      // after the change: returns at 507ms with ETIMEDOUT and signal SIGKILL.
      //
      // This is the same lesson as the rest of this file one level down — the
      // bound was a claim about arbitrary code, resting on that code's
      // cooperation.
      killSignal: 'SIGKILL',
      // stdin is a pipe carrying the nonce; stdout/stderr still inherit so the
      // child's diagnostics reach the caller unchanged.
      stdio: ['pipe', 'inherit', 'inherit'],
      input: nonce,
      env: { ...process.env, __UI_VIEWPORTS_VERDICT_FILE: file },
    });
  } finally {
    // read before cleanup, so a throw in spawnSync still leaves nothing behind
  }
  let recorded = null;
  try { recorded = JSON.parse(readFileSync(file, 'utf8')); } catch { /* handled below */ }

  // THE NONCE GATE. Checked before anything else looks at `recorded`, because a
  // payload that does not carry it was not written by the child this parent
  // spawned — and the whole point of the child is that the config's code cannot
  // decide this outcome. A forged file lands at the same path; it cannot carry
  // this value. Refusal, not silent fallback: a verdict this process cannot
  // attribute is no verdict, which is exit 14's existing meaning.
  if (recorded && recorded.nonce !== nonce) {
    console.error('CANNOT CHECK: the recorded verdict did not come from the config evaluation.');
    console.error('  The verdict file exists but is not stamped with this run\'s token, so');
    console.error('  something other than the gate\'s own child process wrote it.');
    console.error('  A verdict that cannot be attributed is not a pass.');
    console.error('check-ui-viewports: FAIL (code 14)');
    process.exit(14);
  }

  // A RECORDED SUCCESS NEEDS A CLEAN EXIT TO CORROBORATE IT. The child writes
  // its verdict and then keeps running until the event loop drains, so a config
  // that schedules a delayed throw crashes AFTER record(0) — Codex round 17
  // reproduced a three-band config with a 200ms timer that threw: the child
  // printed an uncaught exception and exited 1, and this parent reported 0.
  //
  // A recorded FAILURE needs no such corroboration: the child had already decided
  // to refuse, and a crash afterwards does not make the config acceptable. Only
  // the pass is upgraded from "was written" to "was written and nothing else went
  // wrong", which is the same asymmetry as everywhere else in this file — a
  // refusal may stand on partial evidence, a certification may not.
  // TWO CAUSES REACH THIS BRANCH AND THEY NEED DIFFERENT ADVICE. A config that
  // schedules a throw fails after recording; so does a config that merely leaves
  // a HANDLE open, because the bound above then kills a child that has already
  // written its verdict. Both are exit 14 and neither hangs, which was the whole
  // point — but telling someone whose config holds a `setInterval` to look for
  // "a scheduled throw" sends them hunting for a bug that is not there.
  //
  // Found by writing the case for Codex's #347 round-3 fixture rather than by
  // reading the fix: the timeout diagnostic further down is UNREACHABLE for it,
  // because the verdict was already on disk. `spawnSync` reports an expired
  // bound as an ETIMEDOUT error alongside the kill signal, so the two are
  // distinguishable here.
  const timedOut = !!(child && child.error && child.error.code === 'ETIMEDOUT');
  if (recorded && recorded.code === 0 && (child.signal || child.status !== 0)) {
    console.error('CANNOT CHECK: the config evaluation recorded a pass and then failed.');
    if (timedOut) {
      console.error(`  it wrote its verdict and then did not finish within ${EVAL_TIMEOUT_MS / 1000}s, so it was killed`);
      console.error('  Importing the config left something running — a timer, a socket, a');
      console.error('  watcher. Playwright will still list such a config; this gate cannot');
      console.error('  wait for one, and a gate that hangs reports nothing at all.');
    } else {
      console.error(child.signal
        ? `  it was killed by ${child.signal} after writing its verdict`
        : `  it exited ${child.status} after writing its verdict`);
      console.error('  Something in the config was still running after the gate finished —');
      console.error('  a scheduled throw, an unhandled rejection, a handler that failed.');
    }
    console.error('  A pass is only accepted when the evaluation also ended cleanly.');
    console.error('check-ui-viewports: FAIL (code 14)');
    process.exit(14);
  }
  // POST-RUN IMPORTABILITY IS NOW A PREREQUISITE, AND THAT IS A REAL COST.
  // Round 22 said the cross-check "preserves round 14's property exactly". That
  // was wrong and Codex was right to call it: round 14's point was that the
  // post-run pass depends on NOTHING the run can touch, and requiring a second
  // import puts it back on the config still being importable afterwards. A suite
  // that writes state making the config throw — measured, exit 5 — now refuses
  // where round 21 would have joined the carried mapping against the report and
  // passed.
  //
  // Kept as a refusal rather than a fallback, deliberately. Falling back means
  // CERTIFYING without corroboration, and this file's rule everywhere else is
  // that a refusal may stand on partial evidence and a certification may not —
  // and a fallback is also the evasion: break the post-run import and the
  // cross-check never runs. What is owed is an honest diagnostic, since a bare
  // exit 5 sends the reader to their `projects` list for a problem that is about
  // WHEN the config was read.
  if (CARRIED && recorded && recorded.code !== 0) {
    console.error('');
    console.error('  ⚠️ This ran with --declared, so the config is imported a SECOND time after');
    console.error('     the run and the two declarations must agree. The refusal above is that');
    console.error('     second import; the pre-run one succeeded, or there would be no mapping.');
    console.error('     A suite that leaves the config unimportable — a deleted fixture, a marker');
    console.error('     a test writes, a globalTeardown — reaches this even though its widths');
    console.error('     never changed. Behaviour change in #347 round 22; the alternative was to');
    console.error('     certify without corroboration, which is also how the check is evaded.');
  }
  // THE PARENT RE-DECIDES THE BAND VERDICT FROM THE CHILD'S DATA. The child's
  // own code for this can be corrupted by the config (round 18), so its answer is
  // not taken on trust where this process can compute the same thing with clean
  // intrinsics. Only a recorded 0 is re-checked: a refusal already refuses, and
  // the parent has no reason to overturn one.
  if (recorded && recorded.code === 0) {
    let rows = null;
    try { rows = JSON.parse(readFileSync(`${file}.rows`, 'utf8')); } catch { /* below */ }
    if (rows && rows.nonce === nonce) {
      // THE FRESH PAYLOAD IS VALIDATED ON BOTH PATHS, not just the compared one.
      // Round 23 added `wellFormed(rows.rows)` inside the `CARRIED` branch, so
      // the documented direct `--report` invocation — no `--declared` — reached
      // `decideFromRows(rows.rows, rows.testsDir, …)` with an unchecked
      // `testsDir`. A config altering inherited JSON serialisation could leave
      // valid rows and `testsDir: null`; `realpathSync` catches the type, and the
      // `resolve(null, reportArg)` after it throws ERR_INVALID_ARG_TYPE — Node's
      // generic exit 1 where this branch promises CANNOT CHECK (Codex, #347
      // round 25).
      //
      // Same shape as the finding it follows: round 23 validated the carried
      // mapping's `testsDir` and left the fresh one, round 24 validated the
      // rows and left the sibling field. Hoisted so BOTH callers of
      // `decideFromRows` pass through it, which is round 20's rule — put the
      // check where every path must cross it, not in each path.
      const wellFormed = list => Array.isArray(list) && list.every(r => r
        && typeof r === 'object' && !Array.isArray(r) && typeof r.name === 'string'
        && (r.width === undefined || (typeof r.width === 'number' && Number.isFinite(r.width))));
      if (!wellFormed(rows.rows) || typeof rows.testsDir !== 'string' || rows.testsDir === '') {
        console.error('CANNOT CHECK: the config evaluation returned a payload this gate cannot read.');
        console.error(`  rows: ${wellFormed(rows.rows) ? 'well-formed' : 'not a list of {name, width}'}`);
        console.error(`  testsDir: ${typeof rows.testsDir === 'string' ? 'empty' : describeTop(rows.testsDir)}`);
        console.error('  A nonce says who wrote a payload, never that it is shaped like one');
        console.error('  (#347 round 11).');
        console.error('check-ui-viewports: FAIL (code 14)');
        process.exit(14);
      }
      if (CARRIED) {
        // THE FRESH ROWS ARE VALIDATED BEFORE THEY ARE COMPARED. `decideFromRows`
        // validates its input, and round 22 put this comparison in FRONT of it —
        // so a config corrupting `Array.prototype.toJSON` only when the report
        // exists produced a non-array `rows` and `asMap()` called `.map()` on it,
        // crashing with an uncaught TypeError at exit 1 (Codex, #347 round 23).
        // The payload is authenticated by the nonce, which says who wrote it, not
        // that it is shaped like anything — round 11's lesson, and this is the
        // first reader added since that did not apply it.
        // (the fresh payload was validated above, on the path BOTH branches cross)
        // COMPARED AS A MAPPING, not as a serialisation. Key order and any field
        // this gate does not band on are not differences, so a config is refused
        // for changing a WIDTH, never for the report's shape.
        const asMap = list => JSON.stringify(
          list.map(r => [r.name, r.width]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
        if (asMap(CARRIED.rows) !== asMap(rows.rows)) {
          console.error('CANNOT CHECK: the config declared different widths before and after the run.');
          console.error(`  before: ${asMap(CARRIED.rows)}`);
          console.error(`  after:  ${asMap(rows.rows)}`);
          console.error('  The verdict is computed from the PRE-RUN declaration, so a config that');
          console.error('  answers differently across the run has no declaration this gate can use.');
          console.error('  The commonest cause is a config reading state the run creates — including');
          console.error('  this gate\'s own --declared sidecar, which exists during the run and did');
          console.error('  not exist when the pre-run check imported the config (#347 round 22).');
          console.error('  Agreement would not prove honesty either, only consistency: see');
          console.error('  test.md -> UI coverage gates and directives#349.');
          console.error('check-ui-viewports: FAIL (code 21)');
          process.exit(21);
        }
        decideFromRows(CARRIED.rows, CARRIED.testsDir, 'the pre-run declaration');
      }
      decideFromRows(rows.rows, rows.testsDir, 'the config evaluation');
    }
    console.error('CANNOT CHECK: the evaluation reported a pass its own data does not support.');
    console.error('  The verdict file was not stamped with this run\'s token.');
    console.error('check-ui-viewports: FAIL (code 14)');
    process.exit(14);
  }
  if (!recorded || !Number.isInteger(recorded.code)) {
    console.error('CANNOT CHECK: the config evaluation did not report a verdict.');
    if (timedOut) {
      console.error(`  it did not finish within ${EVAL_TIMEOUT_MS / 1000}s and was killed`);
      console.error('  Importing the config left something running — a timer, a socket, a');
      console.error('  watcher. Playwright will still list such a config; this gate cannot');
      console.error('  wait for one, and a gate that hangs reports nothing at all.');
    } else if (child && child.signal) console.error(`  the evaluation was killed by ${child.signal}`);
    else if (child && child.error) console.error(`  ${child.error.message}`);
    else console.error(`  it ended with status ${child ? child.status : 'unknown'} and wrote nothing`);
    console.error('  The config is imported in a child process precisely so that nothing it');
    console.error('  does can decide this outcome. No verdict is NOT a pass.');
    console.error('check-ui-viewports: FAIL (code 14)');
    process.exit(14);
  }
  process.exit(recorded.code);
}

// --- everything below runs in the CHILD, where the config is imported. ---

// THE CHANNEL IS REMOVED FROM THE CONFIG'S VIEW. Round 16 I wrote that a config
// could read this path from its own environment and forge a verdict, and said I
// was not defending against it. Codex round 18 then did it: an exit listener that
// writes {"code":0} to process.env.__UI_VIEWPORTS_VERDICT_FILE and sets
// process.exitCode = 0, so a recorded refusal became an accepted pass.
//
// "I am not defending against that" was the wrong posture for a hazard I could
// close in one line. The variable is deleted before anything the config can see
// runs, so the path exists only in this closure. That is the same move as every
// fix on this PR that has held: remove the thing rather than reason about it.
delete process.env.__UI_VIEWPORTS_VERDICT_FILE;

// ...WHICH IS NOT ENOUGH ON ITS OWN, AND THE COMMENT ABOVE USED TO STOP HERE.
// Deleting the key does not touch /proc/self/environ, and the path is guessable
// from os.tmpdir() regardless. So the parent also mints a nonce and sends it
// down STDIN; this reads it once, here, before a single line of the config has
// run. After this read fd 0 is drained — a later `readFileSync(0)` returns ""
// and `/proc/self/fd/0` is ENXIO — so the config cannot recover it the way it
// recovered the path. Every payload below carries it; the parent rejects any
// that does not.
//
// A failed read leaves NONCE empty, which the parent treats as unattributable
// and refuses. That is the right direction: no token, no pass.
let NONCE = '';
try { NONCE = readFileSync(0, 'utf8').trim(); } catch { /* parent refuses */ }

// Captured before the config is imported: a corrupted JSON.stringify or a
// corrupted writeFileSync would make the report unreadable, which the parent
// treats as no answer — the safe direction, but worth not inviting.
const STRINGIFY = JSON.stringify;
const WRITE = writeFileSync;

function record(code) {
  // Written before terminating, so the parent has an answer even if something
  // the config installed interferes with how this process ends.
  try { WRITE(VERDICT_FILE, STRINGIFY({ code, nonce: NONCE }), 'utf8'); } catch { /* parent reports */ }
}

// The band data, for the parent to decide on. Written to a sibling of the
// verdict file so one read tells the parent whether the child got this far.
function report(data) {
  try { WRITE(`${VERDICT_FILE}.rows`, STRINGIFY({ ...data, nonce: NONCE }), 'utf8'); } catch { /* parent reports */ }
}

// CAPTURED BEFORE ANY CONFIG CODE CAN RUN. The config is arbitrary JavaScript
// imported into THIS process, so anything it can reach, it can rewrite — and
// `process.exit` is the one that decides the verdict. Codex reproduced it in
// round 15: a phone-only config containing `process.exit = () => {}` let the
// gate print both missing-band failures, walk past its own `process.exit(1)`,
// print the OK line, and exit 0. A false green produced by the config under
// test, which is the most direct form this file's subject can take.
//
// A bound reference is not reachable from the config, so every termination below
// goes through EXIT rather than looking the method up at call time. The stronger
// fix is a child process — the config could still mutate console, prototypes, or
// exit handlers — and that belongs with #335, which has to spawn a run anyway.
// This closes the verdict path, which is the part that decides pass or fail.
const EXIT = process.exit.bind(process);

let verdict = false;
process.on('exit', code => {
  if (code === 0 && !verdict) {
    console.error('FAIL: check-ui-viewports reached exit 0 without recording a verdict.');
    console.error('      Something ended the process before the gate was evaluated (a config');
    console.error('      that calls process.exit() at import time does exactly this).');
    console.error('check-ui-viewports: FAIL (code 7)');
    // Record it, so the parent reports the SPECIFIC diagnosis rather than the
    // generic "no verdict". 7 says the config ended the process before the gate
    // ran; 14 says the evaluation vanished without even reaching here (a signal,
    // a hard kill). Both are refusals — this one names the cause.
    record(7);
    process.exitCode = 7;
  }
});

function die(code, lines) {
  for (const l of lines) console.error(l);
  console.error(`check-ui-viewports: FAIL (code ${code})`);
  verdict = true;
  record(code);
  EXIT(code);
}

// THE FOURTH READER, brought along with the other three. Codex's round-18
// finding was about `--report`, but the construction it used — an option VALUE
// that is a legal filename spelled like a flag — defeats this one identically:
// a `report-path` of `--tests-dir` (accepted by the validator, which forbids
// globs and traversal, not a leading dash) made `--report --tests-dir` hand this
// search the config's own flag name. Reported for one flag, fixed for every
// flag, because the defect is the idiom and not the instance.
//
// `argOpt` walks `process.argv` from index 2, which is where the old local
// slice started, so the tokens read are identical; the value-stepping is the
// only difference, and it is the whole point.
const opt = name => argOpt(name).value;

// Empty-value refusal happens once, above the parent/child split (#347 r20).

// --- 1. Resolve the tests dir. The default is a fallback, never an assumption:
// the resolved path AND its source print on every run, because #281's snippet died
// from a hard-coded path that exited quiet for any project that moved UI_TESTS_DIR.
let dir = opt('--tests-dir');
let dirSource = '--tests-dir';
if (dir === undefined) { dir = process.env.UI_TESTS_DIR; dirSource = 'UI_TESTS_DIR'; }
if (!dir) { dir = '.github/scripts/ui-tests'; dirSource = 'default'; }

// Width bands, not device names. The template config's own tablet comment states
// the convention this follows — "max-width: 1023px, desktop from 1024px" — and
// says plainly that a 1080-wide "tablet" renders the DESKTOP layout: the width is
// what matters, the device name is a convenience. Override for a project whose
// breakpoints differ; an override always prints, so it can never be invisible.
// Both spellings, through the shared reader above — the parent bands with the
// same numbers or the two disagree (#347 round 12).
const tabletOpt = bandOpt('--tablet-min', 768);
const laptopOpt = bandOpt('--laptop-min', 1024);
const TABLET_MIN = tabletOpt.value;
const LAPTOP_MIN = laptopOpt.value;
const bandSource = (tabletOpt.given || laptopOpt.given)
  ? 'OVERRIDDEN on the command line' : 'defaults';
if (!Number.isFinite(TABLET_MIN) || !Number.isFinite(LAPTOP_MIN) || TABLET_MIN >= LAPTOP_MIN) {
  die(8, [`CANNOT CHECK: nonsensical band bounds (tablet-min=${TABLET_MIN}, laptop-min=${LAPTOP_MIN})`]);
}

// ABSOLUTE, CAPTURED BEFORE THE CHDIR BELOW. Every later use must be this and
// not `dir`: once cwd is the tests directory, a relative `dir` would resolve
// against ITSELF. Caught immediately by the shipped kit (it looked for
// templates/ui-tests/templates/ui-tests) but NOT by any case, because the cases
// harness passes an absolute --tests-dir — so a relative one is now pinned too.
// RESOLVED AGAINST THE SHELL'S LOGICAL CWD, not Node's physical one. Round 15
// set `process.env.PWD = TESTS_DIR` and justified it with "TESTS_DIR is
// resolve()d, which does NOT follow symlinks, so it is the same logical path the
// shell would export". That is true only when `dir` is ABSOLUTE. For a RELATIVE
// one — and the shipped composite passes `--tests-dir .` — `resolve()`'s base is
// `process.cwd()`, which Node reports PHYSICALLY. So under a symlinked tests-dir
// the gate recovered the real target, exported it as PWD, and read the config in
// an environment the run never has: Playwright inherits the shell's LOGICAL PWD.
// Measured — a config branching on a PWD ending in /link declared phone-only to
// the run and laptop+tablet+phone to the gate, and the genuine report still
// certified (Codex, #347 round 28).
//
// A shell resolves a relative path against its own logical PWD, so this does the
// same, and only when that PWD is real: absolute, and naming the same directory
// Node is standing in. Anything else falls back to `process.cwd()`, which is
// what a shell without a valid PWD also does.
const shellCwd = () => {
  const p = process.env.PWD;
  try {
    if (p && isAbsolute(p) && realpathSync(p) === realpathSync(process.cwd())) return p;
  } catch { /* an unreadable PWD is not a usable base */ }
  return process.cwd();
};
const TESTS_DIR = isAbsolute(dir) ? resolve(dir) : resolve(shellCwd(), dir);
console.log(`tests dir: ${TESTS_DIR}  (source: ${dirSource})`);
console.log(`bands (${bandSource}): phone <${TABLET_MIN}px | tablet >=${TABLET_MIN}px and <${LAPTOP_MIN}px | laptop >=${LAPTOP_MIN}px`);

if (!existsSync(TESTS_DIR) || !statSync(TESTS_DIR).isDirectory()) {
  die(2, [
    `CANNOT CHECK: tests dir does not exist: ${TESTS_DIR}`,
    `  resolved from: ${dirSource}`,
    '  order tried:   --tests-dir, then $UI_TESTS_DIR, then .github/scripts/ui-tests',
    '  This is NOT a pass — the viewport gate was not evaluated.',
  ]);
}

// ENTER THE TESTS DIRECTORY FIRST, then resolve everything relative to being
// there. Playwright does `path.resolve(process.cwd(), configFile)` AFTER its cwd
// is the tests directory — and cwd is the REAL path, because chdir resolves
// symlinks. Computing a base instead reproduces that only while no symlink is
// involved: with `--tests-dir suite-link --config ../configdir`, resolving `..`
// against the lexical path names a different directory than resolving it from
// inside the link's target (Codex, round 14 — a false green, reproduced).
//
// Rounds 9 through 13 each corrected WHICH base to compute. This stops computing
// one. `process.cwd()` after the chdir is the same value Playwright will use, by
// construction, so there is no base to get wrong and no fifth predicate to add.
try {
  process.chdir(TESTS_DIR);
  // THE LOGICAL PATH, NOT THE PHYSICAL ONE. A shell entering a symlinked
  // directory keeps the symlink path in PWD while cwd is the real target, so the
  // run sees PWD=/…/link and cwd=/…/real. Round 10 set PWD to process.cwd(),
  // which is the physical path — correct when no symlink is involved and wrong
  // exactly when one is. Codex round 15 reproduced a config branching on a PWD
  // ending in /link.
  //
  // TESTS_DIR is resolve()d, which does NOT follow symlinks, so it is the same
  // logical path the shell would export. cwd stays physical via the chdir above.
  // Between them the two match what the run's shell produces.
  process.env.PWD = TESTS_DIR;
} catch (e) {
  die(5, [
    'CANNOT CHECK: cannot enter the tests directory to evaluate the config.',
    `  ${TESTS_DIR}`,
    `  ${(e && e.message) || e}`,
    '  Playwright evaluates the config from there, so reading it from elsewhere',
    '  can produce a different config. Refusing rather than reading the wrong one.',
  ]);
}

// --- 2. Resolve the config in PLAYWRIGHT'S OWN precedence order. Measured
// 2026-08-26 against @playwright/test 1.62.1: a .ts config shadows a .js one, and
// a .js config shadows a .mjs one. Reading the file Playwright does NOT read is
// #281's bug wearing a different hat, so name every shadowed file.
const CONFIG_NAMES = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mts',
  'playwright.config.mjs', 'playwright.config.cts', 'playwright.config.cjs'];
let configPath;
const explicit = opt('--config');
if (explicit) {
  // Plain resolve() against the CURRENT directory, which the chdir above has
  // already made the tests directory — exactly Playwright's
  // resolve(process.cwd(), configFile). Round 13 computed the base instead and
  // round 14 defeated that with a symlink.
  configPath = isAbsolute(explicit) ? explicit : resolve(explicit);
  if (!existsSync(configPath)) {
    die(3, [`CANNOT CHECK: --config path does not exist: ${configPath}`, '  This is NOT a pass.']);
  }
  // Playwright's own --config is "Configuration file, OR a test directory with
  // optional playwright.config" (1.62.1 --help). Treating a directory as a file
  // made import() fail and the gate exit 4 on a config Playwright loads fine —
  // a refusal on a valid invocation, not a fail-open, but still a false alarm.
  // Codex, round 12. Same precedence list as the implicit search below, so the
  // two paths cannot disagree about which file Playwright would read.
  if (statSync(configPath).isDirectory()) {
    const found = CONFIG_NAMES.filter(n => existsSync(join(configPath, n)));
    if (!found.length) {
      die(3, [
        `CANNOT CHECK: --config names a directory with no Playwright config: ${configPath}`,
        `  looked for: ${CONFIG_NAMES.join(', ')}`,
        '  This is NOT a pass — the viewport gate was not evaluated.',
      ]);
    }
    if (found.length > 1) {
      console.log(`NOTE: ${found.length} configs present — Playwright reads ${found[0]}, shadowing ${found.slice(1).join(', ')}`);
    }
    configPath = join(configPath, found[0]);
  }
} else {
  const present = CONFIG_NAMES.filter(n => existsSync(join(TESTS_DIR, n)));
  if (!present.length) {
    die(3, [
      `CANNOT CHECK: no Playwright config in ${TESTS_DIR}`,
      `  looked for: ${CONFIG_NAMES.join(', ')}`,
      '  This is NOT a pass — the viewport gate was not evaluated.',
    ]);
  }
  if (present.length > 1) {
    console.log(`NOTE: ${present.length} configs present — Playwright reads ${present[0]}, shadowing ${present.slice(1).join(', ')}`);
  }
  configPath = resolve(join(TESTS_DIR, present[0]));
}
console.log(`config:    ${configPath}`);

(async () => {
  // --- 3. Precondition probe BEFORE the import, so "no node_modules" can never be
  // mistaken for "the config is broken". Resolves exactly as Node will when the
  // config's own `import ... from '@playwright/test'` runs.
  try {
    // FROM THE TESTS DIRECTORY, not from the config. These are the GATE'S OWN
    // dependencies: it needs Playwright installed to do its job, and Playwright
    // is installed next to the suite. A config living outside the tests dir may
    // legitimately export a plain object without importing Playwright at all —
    // Codex round 15 reproduced that layout, where the runner listed all three
    // projects and this probe exited 4 on a valid setup.
    // Whether the CONFIG's own imports resolve is reported by importing it,
    // which is where that belongs.
    createRequire(pathToFileURL(join(TESTS_DIR, 'noop.js'))).resolve('@playwright/test');
  } catch (e) {
    die(4, [
      'CANNOT CHECK: @playwright/test is not resolvable from the config.',
      `  config: ${configPath}`,
      `  ${(e && (e.code || e.name)) || 'Error'}: ${String(e && e.message).split('\n')[0]}`,
      '  In CI this step must run AFTER the ui-suite composite\'s "Install test dependencies".',
      `  Locally: (cd ${TESTS_DIR} && npm install --no-package-lock --ignore-scripts)`,
      '  node_modules is environment-provided (gitignored, never in a fresh clone),',
      '  so its absence is a loud "cannot check" — NOT a pass.',
    ]);
  }

  // --- 4. Import it. Node evaluates the spreads; nothing here parses text.
  //
  // CHDIR FIRST. A config is CODE, so what it exports can depend on where it is
  // evaluated — process.cwd() as much as process.env. Playwright runs with the
  // tests directory as its working directory (the ui-suite composite sets
  // `working-directory` on the run step); this gate was invoked from the repo
  // root. A config branching on cwd therefore handed the two a DIFFERENT object,
  // and copying environment variables across, as round 8 did, does not make the
  // evaluations equivalent — it made one of two inputs match. Codex, round 9.
  //
  // (the chdir into the tests directory happened before config resolution above)
  let cfg;
  try {
    const mod = await import(pathToFileURL(configPath).href);
    cfg = mod.default !== undefined ? mod.default : mod;
  } catch (e) {
    // The old wording here said "or keep a playwright.config.js", which is wrong
    // for the case Codex reported in round 10: a config that IS JavaScript but
    // imports a TypeScript helper. Node rejects the whole module graph, so the
    // file's own extension is not the deciding factor and that advice sends the
    // reader nowhere. Playwright's runner accepts such a config, so this is a
    // refusal on a config the subsequent run would have handled.
    //
    // Deliberately NOT fixed by falling back to Playwright's own config loader,
    // which does load it. Measured 2026-08-27: loadConfigFromFile NORMALISES
    // defaults onto its output — the shipped kit declares no `grep` and the
    // loader reports `grep: /.*/`; it declares no project `testMatch` and the
    // loader reports the default glob. It cannot distinguish DECLARED from
    // DEFAULTED, and every refusal in this gate is a statement about what the
    // config declares. Loading through it would read every config as carrying a
    // root filter on every project — which, while this gate still refused those,
    // meant refusing the entire fleet. #335 removed that refusal, so the cost is
    // no longer fatal; the plain import stays because DECLARED-vs-DEFAULTED still
    // decides which widths are the author's and which are Playwright's.
    const hint = e && e.code === 'ERR_UNKNOWN_FILE_EXTENSION'
      ? ['  This Node cannot import the config\'s module graph — note that the config',
        '  itself may be JavaScript and still import a TypeScript file, which is enough.',
        '  Playwright\'s own runner WOULD load it, so this is a refusal on a config the',
        '  run accepts. Either raise this step to Node >= 22.18 (type stripping is on by',
        '  default there), or keep the config\'s imports to JavaScript.',
        '  The ui-suite composite pins Node 20; see its header note.']
      : [];
    die(5, [
      'CANNOT CHECK: importing the config threw.',
      `  config: ${configPath}`,
      `  ${(e && (e.code || e.name)) || 'Error'}: ${String(e && e.message).split('\n')[0]}`,
      ...hint,
      '  This is NOT a pass — the viewport gate was not evaluated.',
    ]);
  }
  if (!cfg || typeof cfg !== 'object') {
    die(5, [`CANNOT CHECK: the config's export is ${cfg === null ? 'null' : typeof cfg}, not an object.`,
      `  config: ${configPath}`, '  This is NOT a pass.']);
  }

  // --- 5. Projects.
  // ONE READ. `cfg.projects` was read twice here (the Array.isArray test, then
  // the value), so a stateful getter could be tested on one array and used on
  // another. See the SEQUENCE limit recorded above the row loop below.
  const RAW_PROJECTS = cfg.projects;
  const projects = Array.isArray(RAW_PROJECTS) ? RAW_PROJECTS : null;
  if (projects === null) {
    die(6, ['FAIL: the config declares no `projects` array.',
      '  This gate reads per-project viewports to decide which bands are DECLARED,',
      '  so with no projects there is nothing here that declares a band. It makes',
      '  no claim about what such a config would run.',
      '  test.md -> UI coverage gates, fifth gate.']);
  }
  if (projects.length === 0) {
    die(6, ['FAIL: the config declares an EMPTY `projects` array — zero projects resolved.',
      '  test.md -> UI coverage gates, fifth gate.']);
  }

  // ROOT SELECTION KEYS ARE NO LONGER REFUSED, AND THE HISTORY IS THE ARGUMENT.
  // Until #335 this gate stopped whenever `grep`, `grepInvert`, `testMatch`,
  // `testIgnore` or `shard` appeared at the root — not because such a key
  // necessarily narrows anything, but because a config read could not establish
  // that it does not. That refused configs that were provably fine, and it was
  // the honest move only while nothing better existed.
  //
  // claude.trading reported (from a Codex finding on their #283) that a root
  // `grep` left this gate printing a confident OK, and seven review rounds then
  // produced seventeen findings — every one a rule that held for the example that
  // motivated it and failed one step out. "Empty" had three spellings ([], '',
  // ['']). "Matches everything" had at least two (/(?:)/ and /^/). testDir took
  // four predicates and a symlink still beat it. A `shard` can be cancelled at
  // runtime by a reporter calling skipSharding().
  //
  // The run's report ends the argument by not entering it. A key that narrows
  // shows up as a project with nothing executed; a key that is a no-op shows up
  // as nothing at all. The question "does this value actually narrow?" —
  // answered wrong six times across three spellings of "empty" and two of
  // "matches everything" — is no longer asked by anyone here.

  // REPORTERS ARE NO LONGER VETTED BY NAME. A reporter's preprocess() can call
  // testRun.exclude() on every test, and this gate used to refuse any reporter
  // absent from the installed Playwright's `builtInReporters` — a derived list,
  // but still a rule about which reporters are TRUSTED rather than an
  // observation of what they DID.
  //
  // A reporter that empties the run produces a report with nothing executed, and
  // the bands go uncovered. #335 set this as the criterion for whether the
  // rewrite had actually moved from predicting to observing: if the new stage
  // still needed the reporter allowlist, it had not.
  // PW_TEST_REPORTER ADDS A REPORTER THE CONFIG NEVER MENTIONS. The runner
  // appends it independently of `reporter`, so a config declaring only built-ins
  // can still run arbitrary reporter code. Reproduced 2026-08-27 (Codex, round 9):
  // with it pointing at a preprocess() that excludes everything, Playwright found
  // 0 tests in 0 files while this gate exited 0 naming three bands.
  //
  // This is the same lesson as the cwd fix above, arriving from a third direction:
  // the config object is not the whole input. Round 8 fixed environment VARIABLES
  // reaching the config; this is the environment reaching PLAYWRIGHT, past the
  // config entirely. Reading `reporter` was never going to see it.
  // PW_TEST_SOURCE_TRANSFORM makes Playwright run a Babel plugin over the config
  // as it loads it, so the object Playwright gets is not the object a plain
  // import() produces. Codex reproduced a transform that ADDS a root grep: the
  // gate imported the untransformed three-band config and exited 0 while
  // Playwright found zero tests. Round 14.
  //
  // Same family as PW_TEST_REPORTER above — an environment variable that changes
  // what Playwright does, invisible to reading the config. Refused rather than
  // reproduced: applying the transform here would mean running an arbitrary Babel
  // plugin from this gate, and the point of the last eight rounds is that this
  // program should stop trying to reproduce Playwright's behaviour.
  // BOTH VARIABLES, because Playwright applies the transform only when both are
  // set (transformHook, 1.62.1). Round 14 refused on the transform variable
  // alone; Codex round 18 reproduced an inherited transform path with no scope
  // where Playwright loaded all three projects and this gate refused a valid
  // setup. A refusal on a config the run accepts is a false alarm, and false
  // alarms are how a gate gets deleted.
  //
  // The scope's PREFIX MATCH against the config path is deliberately not
  // evaluated. Deciding whether a scope covers a file is a prediction about
  // Playwright, and this file has lost that argument in every round it tried.
  // Both set → refuse; that is decidable and it is where the refusal belongs.
  if (process.env.PW_TEST_SOURCE_TRANSFORM && process.env.PW_TEST_SOURCE_TRANSFORM_SCOPE) {
    die(13, [
      'FAIL: PW_TEST_SOURCE_TRANSFORM and _SCOPE are both set — CANNOT CHECK.',
      `  ${process.env.PW_TEST_SOURCE_TRANSFORM}`,
      `  scope: ${process.env.PW_TEST_SOURCE_TRANSFORM_SCOPE}`,
      '  Playwright applies that transform while loading the config, so what it',
      '  sees is not what a plain import() produces. This gate reads the config;',
      '  it will not run your transform to find out what it changes.',
      '  Clear it for the run this gate is certifying, or accept that coverage',
      '  here cannot be attributed.',
      '  test.md -> UI coverage gates, fifth gate.',
    ]);
  }

  // Playwright merges top-level `use` into each project at RUNTIME, but
  // defineConfig() does not do it at authoring time (measured 2026-08-26), so do it
  // here. An unset viewport falls through to Playwright's documented 1280x720
  // default; `viewport: null` is an explicit "no fixed viewport" and must NOT fall
  // through, which is why this tests `!== undefined` rather than truthiness.
  const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
  // PROJECT-LEVEL SELECTION KEYS ARE NO LONGER SUBTRACTED HERE. A project that
  // restricts its test set may declare a width and still never run the UI suite —
  // round 2 of #280 — and this gate used to answer that by refusing to count any
  // project carrying `testMatch`, `testIgnore`, `grep` or `grepInvert`. That is
  // the root-key refusal one level down, with the same cost: a project whose key
  // is a no-op was dropped from its band and the band reported unattributable.
  // Stage two counts a project when Playwright discovers a test for it, which
  // answers the same question by observation and needs no list of key names.
  // THE JOIN IS BY PROJECT NAME, so two projects that share one are
  // indistinguishable TO THIS GATE — whichever ran would certify both bands.
  // An earlier version of this comment said the report identifies a result only
  // by `projectName`. That was FALSE: measured on 1.62.1, `config.projects[]`
  // carries `id` as well as `name` (`same`, `same1`, `phone` for names `same`,
  // `same`, `phone`, in config order) and every test carries `projectId` beside
  // `projectName`. #357 tried rejoining by id and its review found six ways that
  // positional mapping certifies a project that never ran — all fail-open — so
  // the refusal stays, by owner ruling (#351): it costs a rename and never
  // overstates coverage. A false refusal and a false certification are not
  // symmetric defects.
  //
  // An unnamed project reports `projectName: ""`, so the empty string is the key
  // for "no name" on BOTH sides and two nameless projects collide exactly as two
  // projects called `same` do — one rule covers both. The listing-era rule about
  // names containing `] ›` is gone with the listing: the report carries the name
  // as a JSON string, so nothing has to be parsed back out of prose.
  //
  // AND AN EXPLICIT NON-STRING NAME IS NOT "unnamed". `typeof p.name === 'string'
  // ? p.name : ''` coerced `name: 42` to the SAME key a legitimately unnamed
  // project uses, so a config Playwright refuses outright — measured on 1.62.1:
  // `config.projects[0].name must be a string` — was joined against a leftover
  // report carrying `projectName: ""` and certified at exit 0. Nothing could
  // have run against that config; the run that produced the report was a
  // different one (Codex, #347 round 27).
  //
  // This is round 24's `projectName` finding on the OTHER side of the join. That
  // round made the report's key refuse a non-string and left the config's key
  // coercing one, which is the round-26 pattern again: the fix reached the
  // carrier that was named. Absent still means unnamed — Playwright allows it
  // and reports `""` — but present-and-not-a-string is a config this gate will
  // not pretend to understand.
  //
  // AND THE ENTRY ITSELF, found by sweeping the line rather than the finding.
  // `projects: [null]` is refused by Playwright too ("config.projects[0] must be
  // an object"), and here it was worse than a mis-keyed name: `keyOf(null)` gave
  // it the empty key, `p && p.use` fell through to the DEFAULT 1280x720, and the
  // gate INVENTED an unnamed laptop project and certified that band from a
  // report row for `projectName: ""`. A fabricated declaration, not merely a
  // wrong one — checked here because it is the same coercion on the same line.
  // ARRAYS ARE OBJECTS, and Playwright's check is `typeof x === 'object'` with a
  // null guard — nothing more. Round 27 added `Array.isArray` here and I called
  // it "Playwright's own rule rather than an approximation" in the same breath;
  // it was an approximation, and a stricter one. An array carrying `name` and
  // `use` is LISTED normally by 1.62.1 (measured), so refusing it blocks a config
  // the run accepts (Codex, #347 round 28). A gate that refuses what the run
  // accepts is the same defect as one that certifies what the run refuses — it
  // just fails loudly, which is why it survived a round.
  const badEntry = projects.findIndex(p => !p || typeof p !== 'object');
  if (badEntry !== -1) {
    die(5, [
      `CANNOT CHECK: project ${badEntry} is ${describeTop(projects[badEntry])}, not an object.`,
      '  Playwright refuses this config itself ("config.projects[N] must be an',
      '  object"), so no run can have produced results for it. Read as a project,',
      '  it would take the empty key and Playwright\'s default 1280x720 viewport —',
      '  a laptop-band declaration this config never made.',
    ]);
  }
  // ONE READ PER NAME, CACHED — the accessor problem again, on the join key.
  // `keyOf` read `p.name` twice (the typeof test, then the return) and was called
  // twice per project (duplicate detection, then row construction), so a stateful
  // `name` getter could hold `laptop-empty` through Playwright's resolution and
  // return `phone` on the gate's LAST read. Measured: the laptop project matched
  // no tests, the real phone and tablet ran, and the gate emitted the laptop row
  // under `phone` and certified from a genuine report (Codex, #347 round 33).
  //
  // Playwright validates the accessor and then stores the resolved name, so it
  // reads once. This does the same: the read happens here, and every later use —
  // the refusal below, the duplicate check, the join — reads this array.
  const RAW_NAMES = projects.map(p => p.name);
  const badName = RAW_NAMES.findIndex(n => n !== undefined && typeof n !== 'string');
  if (badName !== -1) {
    die(5, [
      `CANNOT CHECK: project ${badName} has a name that is not a string.`,
      `  name: ${describeTop(RAW_NAMES[badName])}`,
      '  Playwright refuses this config itself ("config.projects[N].name must be a',
      '  string"), so no run can have produced results for it. Coercing it to the',
      '  empty key would join it against a legitimately UNNAMED project\'s results',
      '  — a different run\'s report certifying this one.',
      '  Omit `name` for an unnamed project; anything else must be a string.',
    ]);
  }
  //
  // AND `use`, one level down from the entry — the same coercion again, found by
  // Codex in round 28 immediately after round 27 fixed the two above it.
  // `use: null` (or a primitive) was accepted here, and the viewport fallback
  // then read it as an OMITTED viewport and assigned the root or default width —
  // a declaration from a config Playwright refuses outright
  // ("config.projects[0].use must be an object", measured on 1.62.1).
  const badUse = [
    ...(cfg.use !== undefined ? [['the root config', cfg.use]] : []),
    ...projects.flatMap((p, i) => (p.use !== undefined ? [[`project ${i}`, p.use]] : [])),
  ].find(([, u]) => !u || typeof u !== 'object');
  if (badUse) {
    die(5, [
      `CANNOT CHECK: ${badUse[0]} has a \`use\` that is ${describeTop(badUse[1])}, not an object.`,
      '  Playwright refuses this config itself ("use must be an object"), so no run',
      '  can have produced results for it. Read as a project, an unusable `use`',
      '  falls through to the root or default viewport — a width this config never',
      '  declared.',
    ]);
  }
  // AND THE ROOT `name` IS INHERITED. Playwright resolves a project's reported
  // name as project.name, then the ROOT config's name, then "" — measured on
  // 1.62.1: a root `name: 'desktop-root'` with an unnamed project reports
  // `[desktop-root]` and writes `projectName: "desktop-root"`. This keyed such a
  // project as "" unconditionally, so the join looked for a row the report never
  // carries and the band read as NOTHING RAN (Codex, #347 round 30). Predates
  // this PR; the empty default was only ever correct when no root name exists.
  // AND A PRESENT ROOT NAME IS VALIDATED LIKE A PROJECT NAME. Round 30 added the
  // inheritance and coerced a non-string to '' — reintroducing, on the root, the
  // exact defect round 27 fixed on projects. Playwright refuses `config.name`
  // that is not a string, so nothing could have run (Codex, #347 round 31).
  // The root name is read ONCE for the same reason as the project names above.
  const RAW_ROOT_NAME = cfg.name;
  if (RAW_ROOT_NAME !== undefined && typeof RAW_ROOT_NAME !== 'string') {
    die(5, [
      `CANNOT CHECK: the root config's name is ${describeTop(RAW_ROOT_NAME)}, not a string.`,
      '  Playwright refuses this config itself ("config.name must be a string"),',
      '  so no run can have produced results for it. Coercing it to the empty key',
      '  would let a report from a nameless project certify these bands.',
    ]);
  }
  const ROOT_NAME = typeof RAW_ROOT_NAME === 'string' ? RAW_ROOT_NAME : '';
  const keys = RAW_NAMES.map(n => (typeof n === 'string' ? n : ROOT_NAME));
  const dupes = [...new Set(keys.filter((n, i2, a) => a.indexOf(n) !== i2))];
  if (dupes.length) {
    die(18, [
      'CANNOT CHECK: two or more projects share a name.',
      `  ${dupes.map(n => (n === '' ? '(no name)' : n)).join(', ')}`,
      '  This gate joins each result to its project by NAME, so tests belonging to',
      '  one of them would certify the other\'s band. Give every project a distinct name;',
      '  Playwright accepts any string and the names appear in the run\'s output.',
      '  test.md -> UI coverage gates, fifth gate.',
    ]);
  }
  // ⚠️ THE GATE READS EACH VALUE ONCE. IT DOES NOT REPLAY PLAYWRIGHT'S ACCESS
  // SEQUENCE, and cannot — that is a recorded limit, not an open defect.
  //
  // Measured against the installed 1.62.1 with a three-project config whose
  // every field was a counting accessor:
  //
  //   cfg.projects   read  4 times
  //   project.name   read  9 times   (3 per project)
  //   project.use    read 12 times   (4 per project)
  //   viewport.width read  0 times   in this process — the worker reads it when
  //                                  it builds the browser context
  //
  // So "read it the same number of times, in the same order, and use the same
  // one Playwright uses" means reproducing counts that depend on the project
  // count, on which internal validation paths run, and on the version — and for
  // `width`, reproducing a read that happens in a different process entirely.
  // That is reimplementing Playwright's config loader and keeping it bit-exact
  // forever; every version bump would be a fresh divergence.
  //
  // What is achievable, and what this does: read every config-controlled value
  // EXACTLY ONCE and drive everything from that snapshot, so the gate cannot
  // disagree with ITSELF — validate one value and band another, or test one
  // array and iterate a different one. Rounds 30, 33 and 34 each found a place
  // where it could, and those were real.
  //
  // What remains is a config whose accessors return DIFFERENT VALUES on
  // successive reads. That config is not drifting, it is lying, and it is the
  // same class directives#349 already records: the gate reads the config through
  // artifacts produced by processes the config runs in, and there is no
  // authenticated channel out of a process you do not control. A stateful
  // accessor is that limit on the DECLARATION side rather than the report side.
  // Recorded here so the next round reads the verdict instead of re-deriving it.
  const cover = { laptop: [], tablet: [], phone: [] };
  const rows = [];
  for (const [i, p] of projects.entries()) {
    const name = keys[i];
    // REPRODUCE THE MERGE, DO NOT MODEL IT. Rounds 28-31 each added one more
    // attribute of `mergeObjects()` to a predicate over `viewport` alone —
    // which keys it sees (28), which values it copies (29), how many times it
    // reads (30), and in what order across layers (31). Round 32 found the next
    // one: it reads EVERY own enumerable property, in order, so a `baseURL`
    // getter with side effects changes what the `viewport` getter returns, and a
    // predicate that touches only `viewport` never triggers it. Measured — root
    // 390 in the run against 1280/900/390 in the gate, certified at exit 0.
    //
    // Four rounds of adding conjuncts is the signal that the predicate was the
    // wrong shape. `mergeObjects` is short and fully specified: own enumerable
    // entries, in order, skipping undefined, layer after layer. Doing exactly
    // that is not a prediction about Playwright — it IS the operation — and it
    // subsumes all four previous fixes into the traversal rather than encoding
    // each as a rule. `Object.entries` reads every property once, in order, so
    // enumerability, undefined-skipping, read count and read order all fall out
    // of the loop instead of being asserted around it.
    // THE TWO LAYERS ARE NOT MERGED THE SAME WAY, and round 32 treated them as if
    // they were. Read out of the installed 1.62.1 rather than reasoned about:
    //
    //   function mergeObjects(a, b, c) {
    //     const result = { ...a };
    //     for (const x of [b, c].filter(Boolean))
    //       for (const [name, value] of Object.entries(x))
    //         if (!Object.is(value, void 0)) result[name] = value;
    //   }
    //
    // The FIRST layer is a SPREAD — which evaluates enumerable SYMBOL properties
    // and copies `undefined` through — and only the later layers go through
    // `Object.entries`, which is string-keyed and skips undefined. Round 32 sent
    // both through `Object.entries`, so a root symbol accessor with side effects
    // never fired here and did fire in the run: measured, Playwright ran the
    // laptop project at 390px while both gate imports read 1440 and a genuine
    // report certified (Codex, #347 round 33).
    //
    // Performing the operation was the right move; performing it from the source
    // rather than from a description of it is the part I had not done.
    const mergedUse = { ...cfg.use };
    if (p.use !== null && typeof p.use === 'object') {
      for (const [k, v] of Object.entries(p.use)) if (!Object.is(v, undefined)) mergedUse[k] = v;
    }
    const vp = mergedUse.viewport !== undefined ? mergedUse.viewport : DEFAULT_VIEWPORT;
    // testDir IS NOT PART OF `restricted`, at the project level either. Round 10
    // fixed the spelling comparison here; round 12 defeated the fix with a
    // directory symlink — `alias -> .` makes two lexically different paths name
    // one directory, and every project was marked restricted, refusing all three
    // bands on a config Playwright runs.
    //
    // That is the SAME defeat round 6 delivered to the root testDir check, after
    // four predicates. I removed the root one then and left this one, because the
    // finding named the root. A realpath here would be predicate five, and
    // bind mounts and case-insensitive filesystems are the next two.
    //
    // So all testDir inference now goes to #335 together, root and project. The
    // cost is a project that genuinely redirects discovery away from the suite is
    // not flagged — a real hole, recorded rather than papered over, and no worse
    // than the root case that has been deferred since round 6.
    if (vp === null) {
      rows.push({ name, w: 'null', band: 'UNCLASSIFIABLE (viewport: null — no fixed viewport)' });
      continue;
    }
    // ONE READ OF EACH, then every use reads the local. `vp.width` was read for
    // the validation, twice for the banding and twice more for the row — five
    // chances for an accessor to hand the gate a different number than the one
    // it validated (Codex, #347 round 34).
    const width = vp === null || typeof vp !== 'object' ? undefined : vp.width;
    const height = vp === null || typeof vp !== 'object' ? undefined : vp.height;
    if (typeof vp !== 'object' || !Number.isFinite(width)) {
      rows.push({ name, w: JSON.stringify(vp), band: 'UNCLASSIFIABLE (malformed viewport)' });
      continue;
    }
    const band = width >= LAPTOP_MIN ? 'laptop' : width >= TABLET_MIN ? 'tablet' : 'phone';
    // `width` is the NUMBER, for the parent to band; `w` and `band` are this
    // process's own display strings and the parent reads neither.
    rows.push({ name, w: `${width}x${height}`, band, width });
    cover[band].push(name);
  }
  for (const r of rows) {
    console.log(`  ${String(r.name === '' ? '(no name)' : r.name).padEnd(18)} ${String(r.w).padEnd(12)} ${r.band}`);
  }

  // TWO DIFFERENT VERDICTS, because they are different facts. A band with no
  // project in it at all is UNDECLARED — that is a FAIL this gate can prove from
  // the widths alone. A band whose only projects carry selection keys is
  // DECLARED BUT UNATTRIBUTABLE: the projects exist at the right widths and this
  // gate cannot tell whether their filters exclude the suite.
  //
  // They were one verdict until round 10, and calling the second "no project
  // covers laptop" states something false — a laptop project is right there.
  // Codex reproduced the cost: a laptop project carrying `testIgnore: []`, which
  // excludes nothing, reported a missing band while Playwright listed the spec
  // for all three projects.
  //
  // What is NOT done here, deliberately: exempting the no-op. That needs the
  // question "does this value actually narrow?", which rounds 1-6 answered wrong
  // six times across three spellings of "empty" and two of "matches everything".
  // The refusal stays; only the false claim goes. See #335.
  // THE DECISION IS MADE IN THE PARENT, from data this process reports.
  //
  // The child boundary stopped the config reaching the exit path (round 16) and
  // the verdict file (round 18), but not the ARITHMETIC. Codex round 18:
  // `Array.prototype.filter = () => []` in a phone-only config makes both lists
  // below empty, so the gate prints OK naming empty bands and exits 0 cleanly —
  // no exit trick, no forged file, just a corrupted computation.
  //
  // Capturing the primitives this analysis uses would be an enumeration
  // (`filter`, then `map`, then `Object.keys`, then `JSON.stringify`…), and every
  // enumeration on this PR has been defeated within a round. So the rows are
  // reported to the parent, which never imported the config, and the parent
  // decides. A corrupted child can only produce WORSE data — fewer rows, missing
  // bands — which the parent turns into a refusal. It cannot manufacture a pass,
  // because the pass is computed by code the config never touched.
  // configPath travels with the rows so the PARENT can observe discovery. The
  // parent never imports the config; it hands the path to Playwright and reads
  // what comes back, which is the whole point of #335.
  // NO `cover`. The parent bands the rows itself (#347 round 11): a map computed
  // here is a conclusion drawn with whatever the config left of the runtime, and
  // the nonce proves only who wrote it. `cover` is still used BELOW for this
  // process's own refusal message, which is allowed to be wrong in the safe
  // direction — a corrupted child refusing is not a false pass.
  report({ rows, configPath, testsDir: TESTS_DIR });
  const bandProjects = b => rows.filter(r => r.band === b);
  const undeclared = ['laptop', 'tablet', 'phone'].filter(b => bandProjects(b).length === 0);
  if (undeclared.length) {
    for (const b of undeclared) console.error(`FAIL: no project declares a ${b} viewport.`);
    console.error('  global.md requires laptop, tablet AND phone. This config is the only place');
    console.error('  the UI suite gets its widths, and exactly one test sets its own (S4, at 390),');
    console.error('  so no scenario is ever rendered at the missing width.');
    console.error('  test.md -> UI coverage gates, fifth gate.');
    verdict = true;
    console.error('check-ui-viewports: FAIL (code 1)');
    record(1);
    EXIT(1);
  }
  // ONE VERDICT NOW, not two. "Declared but unattributable" existed because a
  // config read could not tell whether a project's selection keys excluded the
  // suite, so a band with only restricted projects got its own refusal (exit 12,
  // CANNOT CHECK). Stage two answers that question outright, so the refusal is
  // gone and exit 12 now means something PROVEN: the band is declared and
  // Playwright discovers nothing for it. The code is reused deliberately — it was
  // always "this band is not established"; what changed is that the gate can now
  // say why with evidence instead of declining to say.
  // NO VERDICT LINE HERE. Declaring the bands is half the question; the other
  // half is whether Playwright discovers anything for them, and only the parent
  // can ask (it never imported the config). A success printed here would be the
  // "declared, not executed" claim #335 was filed to replace — and worse, it
  // would print BEFORE the observation that can still refuse it.
  verdict = true;
  // The PASS must be recorded too, and explicitly. If the success path forgot,
  // every clean config would reach the parent with no verdict and report exit 14
  // — loud and wrong, but in the safe direction. The dangerous direction is the
  // one that cannot happen here: nothing writes a 0 except this line.
  record(0);
})().catch(err => die(5, ['CANNOT CHECK: unexpected failure inside check-ui-viewports.',
  `  ${(err && err.stack) || err}`]));
