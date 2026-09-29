#!/usr/bin/env node
// browser-ladder.js — can this sandbox actually LAUNCH a browser?
// (test.md -> Sandboxed local runs -> Recording what your project cannot run here.)
//
// WHY THIS IS A SCRIPT AND NOT A PARAGRAPH. Four review rounds produced four
// different defects in one paragraph of prose, each introduced by the fix for
// the one before (#332, split from #331):
//
//   1. "a missing browser has no shipped override; the scenario is unrunnable"
//      — false: ui-suite/action.yml installs browsers as a normal step.
//   2. "try `playwright install <b>`; record a ceiling only if the INSTALL fails"
//      — false: an install can exit 0 and leave a binary that will not start,
//        so the rule forbade recording a ceiling that genuinely exists.
//   3. "install `--with-deps`, launch, record a ceiling when the LAUNCH fails"
//      — false: `--with-deps` runs installDeps BEFORE install, and dependency
//        installation needs privileges, so without them it aborts BEFORE
//        downloading. The launch then fails because nothing was ever fetched,
//        and the rule records a ceiling that is an artefact of the ladder.
//   4. not attempted. That is the point of the issue.
//
// THE ONE RULE THAT SURVIVED ALL FOUR:
//
//     Grade on whether the browser LAUNCHES. Never on an install's exit code,
//     and never let a dependency-phase abort stand in for "unavailable".
//
// This file is that rule as code. Every rung ends in a launch; an install's exit
// status is recorded as context and is never itself a verdict. `--with-deps`
// runs AFTER a plain install for exactly the reason defect 3 names: the plain
// install fetches the binary first, so a later privilege failure in the
// dependency phase cannot retroactively un-download it.
//
// WHAT A CEILING MEANS HERE. Exit 1 says: on this machine, now, with these
// rungs, the browser did not start — and the launch error is quoted so the next
// reader can judge it rather than trust this line. It does NOT say the browser
// is unavailable in principle. `test.md` requires the limit be recorded with the
// date, the causes and what would make it wrong; this prints the material for
// all three.
//
// WHAT IT CANNOT ESTABLISH. That a browser which launches can also reach the
// network, render your app, or pass your suite. It answers one question --
// does it start -- because that is the question the four prose attempts kept
// getting wrong.
//
// WHAT IT SUPERVISES, and what that still does not promise (#358, closed
// 2026-09-08). Two lifecycle gaps were recorded here as limits under the owner's
// 2026-09-05 ruling, and are now fixed:
//
//   1. THE LADDER'S OWN DEATH reaps the installer. `detached` is what lets a
//      timeout kill the installer's whole process group, and it also puts that
//      group outside this process's foreground group -- so a Ctrl-C aimed at the
//      ladder did not reach it, and `playwright install` (with apt beneath it on
//      the --with-deps rung) kept running. Parent-side signal and exit cleanup
//      now reap the group, armed only while an install is in flight. The signal
//      is RE-RAISED rather than swallowed, so Ctrl-C still stops the ladder: a
//      handler that only cleaned up would have traded a leaked installer for an
//      unkillable diagnostic. The signals covered are DERIVED from the platform
//      minus a stated deny-list, because the first version listed three from
//      memory and missed SIGQUIT (#359).
//
//   2. THE FLUSH IS BOUNDED, AND SO IS THE OUTPUT. Waiting for every stream to
//      drain turned a truncated report into a HANG when a consumer opened a pipe
//      and never read it, which also defeated the forced exit that escapes an
//      uncancellable Playwright handle. The ordering is deliberate -- A TRUNCATED
//      REPORT BEATS A HANG -- but ten seconds of ELAPSED time truncated a slow,
//      healthy reader just as readily (#359). A progress-based deadline was
//      tried and cannot work; see flushThenExit. What works is bounding every
//      line this file prints, in BYTES, so the deadline is arithmetic over a
//      measured ceiling instead of a guess about readers.
//
//      ⚠️ This paragraph described the progress deadline for one round AFTER it
//      was abandoned (Codex, #359) -- a header pointing maintainers at a design
//      the code deliberately rejected.
//
// ⚠️ STILL NOT PROMISED, BY THREE ROUTES -- and the count has been wrong twice,
// so treat it as a list to check rather than a reassurance.
//
//   a. `SIGKILL`. The OS does not deliver it, so no handler runs. Unfixable here.
//   b. A FAULT signal -- SIGSEGV, SIGABRT and the rest of FAULT_SIGNALS. These
//      are deliberately excluded (a handler there is unreliable and can hang the
//      process), so they leak the installer exactly as SIGKILL does. Saying
//      "SIGKILL is the only route" was false while that list existed, and it
//      gave operators wrong cleanup guidance after a crash (Codex, #359).
//   c. Any signal whose terminate-default is not ESTABLISHED -- see
//      CLEANUP_SIGNALS. Left unhandled on purpose: leaking is this file's old,
//      documented limit, while wrongly handling one destroys a live install.
//
// After any of these, check for stragglers: `pgrep -f "playwright install"`, and
// on the --with-deps rung an apt that may still hold dpkg's locks.

'use strict';

const { spawn: spawnProcess, spawnSync } = require('child_process');
const { createRequire } = require('module');
const { dirname, join, resolve, sep } = require('path');
const { existsSync } = require('fs');
const { constants: osConstants } = require('os');
const { StringDecoder } = require('string_decoder');

const BROWSERS = ['chromium', 'firefox', 'webkit'];

// The rungs, in the order they must be attempted. Order is load-bearing, not
// stylistic: see defect 3 above.
const RUNGS = [
  {
    name: 'as-is',
    // No install at all. A browser already in the image is the common case in a
    // sandbox and the cheapest correct answer; attempting an install first would
    // spend a network round trip to learn what a launch answers immediately.
    argv: null,
  },
  {
    name: 'install',
    // Plain install: downloads the browser, touches no system packages, needs no
    // privileges. If host libraries are already sufficient this is enough.
    argv: (browser) => ['playwright', 'install', browser],
  },
  {
    name: 'install --with-deps',
    // Only now. This installs system packages first and needs privileges; when
    // it aborts there, the binary from the rung above is still on disk and the
    // launch below still reports the REAL reason rather than "never downloaded".
    argv: (browser) => ['playwright', 'install', '--with-deps', browser],
  },
];

/**
 * Run the ladder. Pure with respect to its effects: `install` and `launch` are
 * injected so the shipped logic can be exercised without a network or a browser.
 *
 * `install(argv)`  -> { code, output }   -- never consulted for the verdict
 * `launch()`       -> { ok, error }      -- the ONLY thing that decides
 */
async function ladder({ browser, install, launch, log = () => {} }) {
  const attempts = [];

  for (const rung of RUNGS) {
    let installed = null;
    if (rung.argv) {
      const argv = rung.argv(browser);
      log(`  rung "${rung.name}": ${argv.join(' ')}`);
      installed = await install(argv);
      // DELIBERATELY NOT A BRANCH. A non-zero install is recorded and the ladder
      // continues to the launch: defect 2 was reading this exit code as the
      // answer, and defect 3 was letting the dependency phase's failure end the
      // ladder before anything was ever launched.
      log(`    install exited ${installed.code} (context, not a verdict)`);
      // AN INTERRUPTED INSTALL CANNOT SUPPORT A CEILING -- BUT IT STILL ENDS IN A
      // LAUNCH. Round 2 learned to DETECT a spawn the ladder cut short and then
      // carried on as though the rung had completed, so a launch failing for want
      // of a browser this ladder never finished fetching was reported as a
      // CEILING. Round 3 fixed that by returning before the launch -- and
      // overshot: the install result then decided the outcome, which is defect 2
      // wearing the other sleeve, and a signal arriving after the download
      // actually landed produced CANNOT CHECK for a browser that starts fine
      // (Codex, #355).
      //
      // The rule does not have an exception. EVERY RUNG ENDS IN A LAUNCH, and a
      // browser that starts, launched -- however the installer ended. What the
      // interruption costs is only the ability to read a FAILURE: after one, a
      // launch that fails cannot be told apart from a browser this ladder never
      // finished fetching, so that direction is CANNOT CHECK and never a ceiling.
      if (installed.interrupted) {
        const result = await launch();
        attempts.push({ rung: rung.name, install: installed, launch: result });
        if (result.ok) {
          log(`    LAUNCHED (despite an interrupted install -- a launch is a launch)`);
          return { ok: true, rung: rung.name, attempts };
        }
        // A harness failure is the more specific diagnosis and has its own
        // report, so it is not folded into the interrupted one.
        if (result.harness) {
          log(`    cannot check: ${firstLine(result.error)}`);
          return { ok: false, harness: true, rung: null, attempts };
        }
        log(`    launch failed after an install this ladder cut short -- not a ceiling`);
        return { ok: false, harness: true, interrupted: true, rung: null, attempts };
      }
    } else {
      log(`  rung "${rung.name}": no install, launching what is already here`);
    }

    // `await` on a non-promise is the identity, so an injected synchronous
    // launch works unchanged while the real one -- which returns a promise --
    // is resolved before the next rung starts an install.
    const result = await launch();
    attempts.push({ rung: rung.name, install: installed, launch: result });
    if (result.ok) {
      log(`    LAUNCHED`);
      return { ok: true, rung: rung.name, attempts };
    }
    // A HARNESS FAILURE ENDS THE LADDER WITHOUT A VERDICT. Climbing further
    // installs browsers for a Playwright that cannot be loaded, and the rungs
    // then all fail identically -- which reads exactly like a ceiling and is not
    // one (Codex, #355).
    if (result.harness) {
      log(`    cannot check: ${firstLine(result.error)}`);
      return { ok: false, harness: true, rung: null, attempts };
    }
    log(`    launch failed: ${firstLine(result.error)}`);
  }

  return { ok: false, rung: null, attempts };
}

function firstLine(text) {
  return String(text == null ? '' : text).split('\n').find((l) => l.trim()) || '(no message)';
}

/** Render the verdict. Separated from `ladder` so the cases file can pin both. */
// EVERY REPORT LINE IS BOUNDED (#359), IN BYTES. The line COUNTS here were
// always capped -- ten lines of installer output, eight of the launch error --
// but a single line was not, and a launch error is whatever the browser chose
// to throw. That left the report unbounded in bytes while looking bounded,
// which is what made the flush deadline unprovable: for any elapsed-time bound
// there is a report large enough to truncate a reader that is working perfectly
// (Codex, #359; reproduced at 5 MB on one line, losing 1.9 MB to a healthy
// consumer).
//
// ⚠️ THE FIRST CAP COUNTED CHARACTERS AND THE CEILING IS IN BYTES. A JavaScript
// string length is UTF-16 code units; stdout drains UTF-8. So 2,000 characters
// of CJK text is ~6,000 bytes, and the measured worst case understated itself
// threefold on any non-ASCII output -- which Playwright emits as soon as a path
// or a browser message is localised. Codex caught it; the cap and the ceiling
// case are both in bytes now, so they are the same unit as the arithmetic they
// support.
//
// Cutting is done by CODE POINT, accumulating encoded size, so the cap can
// never split a multi-byte sequence into a replacement character -- and a
// surrogate pair stays whole because `for...of` iterates code points.
//
// The cap ANNOUNCES itself, because silently shortening an error message is how
// a reader is sent chasing the wrong cause.
const MAX_REPORT_LINE_BYTES = 2000;

function boundReportLine(line) {
  const text = String(line);
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= MAX_REPORT_LINE_BYTES) return text;

  let kept = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > MAX_REPORT_LINE_BYTES) break;
    kept += char;
    bytes += size;
  }
  return `${kept}… [truncated: ${total - bytes} more bytes on this line]`;
}

// THE ONLY TWO WAYS THIS FILE WRITES A LINE (#359). The bound was applied to
// report() first, then to the progress log when a 5 MB line survived, then --
// Codex, round 3 -- to main()'s own refusals, which quote a browser name and a
// --tests-dir straight from argv: an accepted 115,000-character argument
// delivered 102,400 of 115,081 bytes to a slow reader, so the ceiling the flush
// deadline rests on did not hold.
//
// Three rounds, three sites, one rule: that is the shape this repo calls "a rule
// enforced call-site by call-site gets one site every round". So the call sites
// are gone. Everything goes through these, and the ceiling case OBSERVES real
// CLI output on the refusal paths too -- a check that does not care how a future
// line gets written, only that it came out bounded.
const say = (line = '') => console.log(boundReportLine(line));
const warn = (line = '') => console.error(boundReportLine(line));

function report(browser, outcome, print = console.log) {
  const emit = (line = '') => print(boundReportLine(line));
  if (outcome.ok) {
    emit(`browser-ladder: LAUNCHES — ${browser} started at rung "${outcome.rung}"`);
    // SAY ONLY WHAT WAS TESTED. These two lines used to read "a failure in your
    // suite is about your code or your app" -- which contradicts this file's own
    // header three screens up. A browser that opens an empty context proves
    // nothing about egress, DNS, TLS, the filesystem, or any other runner
    // constraint, so a suite failing on one of those would have been reported
    // here as an application regression (Codex, #355). An instrument that
    // over-claims in its PASS is the same defect as one that over-claims in its
    // failure; this one just reads as reassurance.
    emit('  No ceiling for BROWSER STARTUP. That is the only thing this tested:');
    emit('  the browser process came up and answered. If your suite fails, browser');
    emit('  startup is not the demonstrated cause — but network egress, DNS, TLS,');
    emit('  filesystem limits and every other sandbox constraint are all still');
    emit('  open questions, and this says nothing about any of them.');
    return 0;
  }

  const last = outcome.attempts[outcome.attempts.length - 1];

  // CANNOT CHECK IS NOT A CEILING. Saying "this browser will not start here" when
  // the truth is "this ladder could not load Playwright" records a limit about
  // the wrong thing, and `test.md` asks projects to write these limits down.
  if (outcome.interrupted) {
    const last = outcome.attempts[outcome.attempts.length - 1];
    emit('browser-ladder: CANNOT CHECK — this ladder could not run the installer to completion');
    emit('');
    // FIRST, and outside the truncation: this is the only line that says WHICH
    // way the installer was cut short.
    emit(`  WHY: ${last.install.reason || '(reason not recorded)'}`);
    emit('');
    emit('  What the installer had said before that (first 10 lines):');
    for (const line of String(last.install.output || '').split('\n').slice(0, 10)) emit(`  ${line}`);
    emit('');
    emit('  The launch was attempted anyway, and failed:');
    for (const line of String(last.launch.error || '(no message)').split('\n').slice(0, 8)) {
      emit(`    ${line}`);
    }
    emit('');
    emit('  That failure is NOT read as a ceiling. A browser this ladder never');
    emit('  finished fetching fails to start for a reason this ladder caused, and');
    emit('  nothing here can tell that apart from a browser that genuinely will');
    emit('  not run. Had it launched, that would have been a pass — a launch is a');
    emit('  launch however the installer ended.');
    return 2;
  }
  if (outcome.harness) {
    emit(`browser-ladder: CANNOT CHECK — Playwright itself could not be loaded`);
    emit('');
    for (const line of String(last.launch.error || '').split('\n')) emit(`  ${line}`);
    emit('');
    emit('  This says nothing about whether the browser works. Install the UI kit\'s');
    emit('  dependencies, or point --tests-dir at the directory that holds them:');
    emit('    node browser-ladder.js chromium --tests-dir <dir with node_modules>');
    return 2;
  }

  emit(`browser-ladder: CEILING — ${browser} did not launch after ${outcome.attempts.length} rung(s)`);
  emit('');
  // NOT "verbatim": emit() bounds each line, so a long error arrives as a
  // marked excerpt. Claiming verbatim while truncating invites a reader to
  // treat a partial message as the whole one (Codex, #359).
  emit('  THE EVIDENCE IS THE LAUNCH ERROR, quoted as far as the per-line bound');
  emit('  allows — any cut is marked inline — so you can judge it:');
  for (const line of String(last.launch.error || '(no message)').split('\n').slice(0, 12)) {
    emit(`    ${line}`);
  }
  emit('');
  emit('  What each rung did (install exit codes are CONTEXT, never the verdict):');
  for (const attempt of outcome.attempts) {
    const code = attempt.install ? `install exit ${attempt.install.code}` : 'no install attempted';
    emit(`    ${attempt.rung.padEnd(20)} ${code} -> launch failed`);
  }
  for (const attempt of outcome.attempts) {
    if (attempt.install && attempt.install.output && attempt.install.code !== 0) {
      emit('');
      emit(`  Install output from "${attempt.rung}", for diagnosis only — this text is`);
      emit('  NOT classified here, because a rule that pattern-matches an error string');
      emit('  is a rule about a message rather than about what happened:');
      for (const line of String(attempt.install.output).split('\n').slice(0, 8)) {
        emit(`    ${line}`);
      }
    }
  }
  emit('');
  emit('  Record this in the project\'s CLAUDE.md per test.md -> Sandboxed local');
  emit('  runs: the DATE, the causes above, and what would make it wrong.');
  return 1;
}

// A LADDER THAT KILLS ITS OWN INSTALLER MANUFACTURES THE CEILING IT REPORTS.
// spawnSync's default maxBuffer is ~1 MiB; `playwright install`, and especially
// the apt/dpkg output of `--with-deps`, exceeds that routinely. On overflow Node
// terminates the child with SIGTERM and sets `proc.error` (ENOBUFS) -- so the
// install is cut off part-way, the browser is half-fetched, and the launch below
// fails for a reason THIS FUNCTION CAUSED. That is defect 3 wearing different
// clothes: a ceiling that is an artefact of the ladder (Codex, #355).
//
// The buffer is raised, and an overflow is reported as what it is rather than
// folded into the exit code -- `code: -1` alone is indistinguishable from a
// spawn that never started.
const INSTALL_MAX_BUFFER = 64 * 1024 * 1024;

// AND BOUND IT IN TIME. `spawnSync` waits forever by default, so an installer
// stalled on a network blackhole, a package-manager lock or a hung child blocked
// the ladder before any launch or any report could run -- and a ladder whose
// whole purpose is diagnosing restricted egress is exactly the one that meets
// blackholes (Codex, #355). A timeout kills the child and Node reports
// `status: null, signal: 'SIGTERM', error.code: 'ETIMEDOUT'` (measured), which
// `classifyInstall` already reads as an interruption -- so a stall becomes
// CANNOT CHECK rather than a hang or a manufactured ceiling.
//
// TEN MINUTES, not one. A browser download on a slow link, and `--with-deps`
// fetching apt packages, legitimately take minutes; a bound tight enough to trip
// on a slow network would turn every slow machine into CANNOT CHECK, which is
// safe in direction and useless in practice. This is a bound on HUNG, not on
// SLOW.
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// Split out so the overflow branch is testable. The command is always `npx`,
// which exists, so a genuine spawn error here is almost always ENOBUFS -- and
// that is precisely the branch worth pinning, because it is the one that
// silently turns a truncated install into a reported ceiling.
function classifyInstall(proc) {
  const output = `${proc.stdout || ''}${proc.stderr || ''}`.trim();
  const code = proc.status == null ? -1 : proc.status;
  // A SIGNAL IS AN INTERRUPTION EVEN WITHOUT AN `error`. Node reports a
  // signal-terminated child as `status: null, signal: 'SIGTERM'` and sets NO
  // `proc.error` -- so keying only on `error` classified an installer the OS (or
  // a CI job timeout, or the maxBuffer kill on a Node build that does not
  // populate `error`) cut short as a rung that completed with code -1. The
  // launch then failed for want of a browser this ladder never finished
  // fetching, and that was reported as a CEILING: defect 3 again, arriving
  // through the one door round 3 left open (Codex, #355).
  const reason = proc.error ? proc.error.message
    : proc.signal != null ? `the installer was terminated by ${proc.signal}`
    : null;
  if (reason) {
    // THE REASON IS A FIELD. It used to be appended to the END of the captured
    // output, and `report()` prints the FIRST ten lines -- so any installer that
    // had already said ten lines (a download, an apt run: routinely more) lost
    // the one sentence saying whether it timed out, overflowed its buffer or was
    // signalled. The actionable cause vanished from the report written to carry
    // it (Codex, #355). Text that must survive cannot live inside text that gets
    // truncated.
    return {
      code,
      reason,
      output: `${output}\n[this ladder could not run the installer to completion: ${reason}]`.trim(),
      interrupted: true,
    };
  }
  return { code, output };
}

// RUN THE INSTALLER WHERE THE HARNESS LIVES. `npx` resolves the package from its
// working directory, and the shipped kit installs Playwright under the UI-test
// directory -- so running from a repository root either cannot find it (offline:
// `npm exec playwright` fails ENOTCACHED) or fetches a DIFFERENT Playwright than
// the suite uses. Either way the browser it installs is not the browser the next
// rung launches, and the launch failure that follows gets reported as a ceiling
// (Codex, #355). Round 1 fixed where Playwright is RESOLVED and left where the
// installer RUNS -- half a fix, which is how the same defect arrived twice.
// A BOUND THAT LEAVES THE INSTALLER RUNNING IS NOT A BOUND. `spawnSync`'s
// `timeout` kills the direct child only, and `playwright install --with-deps`
// spawns apt (and sudo) beneath it -- so the ladder returned "interrupted",
// climbed on and launched while a PRIVILEGED package manager was still
// modifying the system and holding dpkg's locks. Measured here: `realInstall`
// returned after 402 ms and an orphaned grandchild wrote its marker two seconds
// later (Codex, #355).
//
// So the installer is started `detached`, which on POSIX gives it its own
// process group, and the bound kills the GROUP with a signal it cannot catch.
// That requires the asynchronous `spawn` -- `spawnSync` gives no handle to kill
// while it is blocking -- so this returns a promise, and `ladder()` awaits it.
//
// `spawn` and `timeout` are injectable so the SHIPPED call can be inspected. The
// first case for the bound called `spawnSync` itself with its own 500 ms
// timeout, which proved that Node honours a timeout -- a fact about Node, not
// about this file. Deleting the bound from the call left all 42 cases green
// (Codex measured it, #355). A case that tests a COPY of the call cannot notice
// the call changing.
function killGroup(child) {
  // The group id equals the pid of a detached leader. Falling back to the pid
  // alone is strictly better than nothing when the platform has no groups.
  try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// THE LADDER'S OWN DEATH MUST REAP THE INSTALLER TOO (#358).
//
// `detached` is what lets a timeout kill the installer's whole process group --
// and it also puts that group OUTSIDE this process's foreground group, so a
// Ctrl-C aimed at the ladder never reaches it. Reaping when the LEADER dies
// covers every way the installer ends; it does not cover the ladder being
// killed while the installer is healthy. Measured before the fix: terminating
// the parent left `playwright install` running, and on the --with-deps rung
// that is an apt still holding dpkg's locks.
//
// Handlers are armed only while an install is in flight and removed as soon as
// the last one finishes, so a three-rung ladder does not accumulate three of
// them -- and a process that merely REQUIRES this file gets none at all.
const ACTIVE_INSTALLS = new Set();

// WHICH SIGNALS ARE CLEANED UP, and why the rule is what it is (#359).
//
// Version 1 named SIGINT/SIGTERM/SIGHUP from memory. Codex found SIGQUIT
// missing: Ctrl-\\ killed the ladder at status 131 and the installer survived.
//
// Version 2 inverted it -- every signal the platform reports, minus a deny-list
// -- and argued the inversion was safe because the handler re-raises, so
// covering a signal that needed no cleanup "costs nothing". CODEX DISPROVED
// THAT ARGUMENT with SIGINFO: macOS puts it in os.constants.signals, its
// default action is to be IGNORED, and Ctrl-T is how a user asks a long install
// for a progress report. Under version 2 that reaped the install and then
// re-raised a signal the OS discards -- so the ladder carried on alive, having
// destroyed the thing it was installing, because someone asked how it was
// going. Over-coverage is NOT harmless. It is harmless only for signals whose
// default action TERMINATES, and that is a property of the signal which no
// runtime API exposes.
//
// So version 3 asks the question that can actually be answered: is this
// signal's terminate-default ESTABLISHED? POSIX answers it for the standard
// signals, and a platform extra is added only with its own citation. Anything
// unestablished -- SIGINFO and SIGEMT on the BSDs, whatever a future platform
// adds -- is simply not handled.
//
// THE FAILURE MODES ARE NOT SYMMETRIC, and that is the whole basis for the
// direction. An unhandled signal leaks the installer: the ORIGINAL, documented
// limit of this file, unchanged for that signal. A wrongly handled one destroys
// a healthy install. Reverting to the older failure beats inventing a new one,
// so an unknown signal is left alone rather than guessed at.
const POSIX_TERMINATING = [
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT',
  'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGQUIT', 'SIGSEGV', 'SIGSYS',
  'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGXCPU', 'SIGXFSZ',
];
// Platform signals whose terminate-default is established individually, KEYED BY
// PLATFORM (#360). SIGPWR is Linux's "system going down"; it terminates by
// default there and is exactly the case where an installer must not be left
// holding dpkg's locks. The first version was a flat NAME list, so it applied
// on every platform that merely HAS a SIGPWR -- and on SunOS/illumos (and AIX)
// its default is to be IGNORED, so a power signal reaped a healthy installer and
// was then discarded: the SIGINFO defect again, inside the fix for it. A
// disposition is a fact about a (platform, signal) pair, never about a name.
// SIGINFO is deliberately NOT here -- it is the signal that proved the rule.
const PLATFORM_TERMINATING = { linux: ['SIGPWR'] };

const UNCATCHABLE = ['SIGKILL', 'SIGSTOP'];
// Default action is STOP, not terminate -- nothing is ending, and a reap here
// would throw away an install the user intends to resume with `fg`.
const STOP_SIGNALS = ['SIGTSTP', 'SIGTTIN', 'SIGTTOU'];
// Node/libuv ignores SIGPIPE rather than dying on it, so it never reaches the
// termination path POSIX describes. The rest never terminate anywhere.
const NON_TERMINATING = ['SIGCHLD', 'SIGCONT', 'SIGURG', 'SIGWINCH', 'SIGPIPE', 'SIGINFO'];
// Fault signals. Node documents handlers for these as unreliable and able to
// hang the process, and by the time one arrives the runtime is already in an
// undefined state -- a best-effort reap is not worth an unkillable ladder.
// ⚠️ These therefore LEAK the installer, exactly as SIGKILL does. Said in the
// header too, because "SIGKILL is the only route" was false while this list
// existed (Codex, #359).
const FAULT_SIGNALS = ['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT',
  'SIGIOT', 'SIGTRAP', 'SIGSTKFLT', 'SIGSYS'];
// Claimed by the runtime: SIGUSR1 starts Node's debugger, SIGPROF drives V8's
// CPU profiler under `node --prof`. Taking either would break a tool, not a bug.
const RESERVED_SIGNALS = ['SIGUSR1', 'SIGPROF'];

const NOT_OUR_SIGNALS = new Set([
  ...UNCATCHABLE, ...STOP_SIGNALS, ...NON_TERMINATING,
  ...FAULT_SIGNALS, ...RESERVED_SIGNALS,
]);

// A PURE FUNCTION OF A SIGNAL TABLE, so a case can hand it macOS's table on
// Linux and check what it would do there. The bug this replaces could not be
// reproduced on the machine that shipped it -- SIGINFO does not exist here --
// and a rule that can only be checked on the platform it breaks is not checked.
// The PLATFORM is an argument for the same reason (#360): the SIGPWR defect only
// exists off Linux, so it has to be askable from Linux.
function cleanupSignalsFor(available, platform = process.platform) {
  const extras = Object.prototype.hasOwnProperty.call(PLATFORM_TERMINATING, platform)
    ? PLATFORM_TERMINATING[platform] : [];
  const established = [...POSIX_TERMINATING, ...extras];
  return established.filter((signal) => Object.prototype.hasOwnProperty.call(available, signal)
    && !NOT_OUR_SIGNALS.has(signal));
}

const CLEANUP_SIGNALS = cleanupSignalsFor(osConstants.signals);

function reapActiveInstalls() {
  for (const child of ACTIVE_INSTALLS) killGroup(child);
  ACTIVE_INSTALLS.clear();
}

// ⚠️ RE-RAISE, DO NOT SWALLOW. Adding a SIGINT listener REPLACES Node's default
// action, so a handler that only cleans up would leave Ctrl-C not stopping the
// ladder -- trading a leaked installer for an unkillable diagnostic, which is a
// worse defect than the one being fixed. Removing the listener and re-sending
// the same signal restores the default path and the right exit status (128+n).
//
// ⚠️ ONLY IF NOTHING ELSE IS LISTENING (#360). Node restores the default action
// when a signal's LAST listener goes, and removing only this file's handler left
// any other -- Playwright installs SIGTERM/SIGHUP/SIGINT handlers while it holds
// a browser, e.g. one a timed-out probe could not close -- to catch the re-raise
// and carry on. Codex reproduced it: installer reaped, CLI exited 2 instead of
// dying of SIGTERM. So every listener for THIS signal is removed before the
// re-raise. That skips another module's handler, deliberately: the process is
// terminating by this signal either way, and an asynchronous cleanup started
// from a handler could not finish before a default-action death regardless.
function onCleanupSignal(signal) {
  reapActiveInstalls();
  disarmParentCleanup();
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}

const SIGNAL_HANDLERS = new Map(
  CLEANUP_SIGNALS.map((signal) => [signal, () => onCleanupSignal(signal)]),
);

function armParentCleanup() {
  if (ACTIVE_INSTALLS.size !== 1) return;   // already armed for an earlier rung
  for (const [signal, handler] of SIGNAL_HANDLERS) process.on(signal, handler);
  // A plain `process.exit()` elsewhere, or a normal end, still owes the group a
  // kill. `exit` handlers must be synchronous, and `process.kill` is.
  process.on('exit', reapActiveInstalls);
}

function disarmParentCleanup() {
  for (const [signal, handler] of SIGNAL_HANDLERS) process.removeListener(signal, handler);
  process.removeListener('exit', reapActiveInstalls);
}

function realInstall(argv, cwd, { spawn = spawnProcess, timeout = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn('npx', argv, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      settle(classifyInstall({ status: null, signal: null, stdout: '', stderr: '', error: err }));
      return;
    }

    let stdout = '';
    let stderr = '';
    // IN BYTES, like the constant and its message (#360). This summed
    // `stdout.length + stderr.length` -- UTF-16 code units -- so multibyte output
    // reached ~3x the nominal bound before it fired: an OOM where a classified
    // interruption was meant. The unit bug boundReportLine had, one site over.
    let capturedBytes = 0;
    let cause = null;
    let done = false;

    // RAW bytes are counted, BEFORE decoding: `setEncoding('utf8')` turns each
    // invalid input byte into U+FFFD, which re-encodes as THREE, so malformed
    // output would trip the bound at ~a third of it. The decoder is only for
    // the captured diagnostic strings.
    const collect = (stream, onto) => {
      if (!stream) return;
      const decoder = new StringDecoder('utf8');
      const append = (text) => { if (onto === 'out') stdout += text; else stderr += text; };
      stream.on('end', () => append(decoder.end()));
      stream.on('data', (chunk) => {
        append(decoder.write(chunk));
        capturedBytes += chunk.length;
        // The buffer is a bound too, and overflowing it is an interruption
        // rather than a truncation: a browser half-fetched cannot support a
        // verdict either way.
        if (capturedBytes > INSTALL_MAX_BUFFER && !cause) {
          cause = new Error(`the installer produced more than ${INSTALL_MAX_BUFFER} bytes`);
          killGroup(child);
        }
      });
    };
    collect(child.stdout, 'out');
    collect(child.stderr, 'err');

    const timer = setTimeout(() => {
      if (!cause) {
        cause = Object.assign(
          new Error(`the installer exceeded ${timeout} ms and its process group was killed`),
          { code: 'ETIMEDOUT' },
        );
      }
      killGroup(child);
    }, timeout);

    // THE GROUP IS REAPED WHEN THE LEADER EXITS — one handler, every cause.
    //
    // The bound killed the group; a leader terminated by an EXTERNAL signal (an
    // admin, a runner shutting down, the OS) did not, so its descendants kept
    // running after `realInstall` returned. Measured (Codex, #355). That is the
    // timeout fix's own rule, applied to one branch and not the other.
    //
    // ⚠️ AND IT CANNOT BE DONE ON `close`. `close` fires when the child's STDIO
    // has closed, and a grandchild INHERITS those pipes -- so with a descendant
    // still running, `close` waits for the descendant. Measured: reaping in the
    // settle path returned after 10 006 ms, exactly when the orphan finished on
    // its own, and the marker was written anyway. `exit` fires when the LEADER
    // dies, which is the moment the group becomes orphaned and the only moment
    // early enough to matter.
    child.on('exit', () => killGroup(child));

    // Registered AFTER the spawn succeeded, so a spawn that threw leaves nothing
    // armed, and released on every settle path below.
    ACTIVE_INSTALLS.add(child);
    armParentCleanup();

    const finish = (status, signal, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ACTIVE_INSTALLS.delete(child);
      if (ACTIVE_INSTALLS.size === 0) disarmParentCleanup();
      settle(classifyInstall({ status, signal, stdout, stderr, error: cause || err || null }));
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (status, signal) => finish(status, signal, null));
  });
}

// A MISSING HARNESS IS NOT A BROWSER CEILING, and it must not be reported as
// one. The shipped kit installs `@playwright/test` under the UI-test directory
// -- `.github/scripts/ui-tests/node_modules` -- because that is the composite's
// `working-directory`. Node does not search a nested sibling directory, so
// resolving from the repository root finds nothing even when the browser is
// installed and healthy, and every rung then fails identically and the run ends
// in CEILING (Codex, #355). Two separate defects in one line: the wrong search
// base, and a harness problem classified as a browser problem.
//
// So the base is the tests directory, defaulting to the shipped kit's location,
// and an unresolvable harness is its own outcome -- CANNOT CHECK, exit 2 --
// never a launch failure.
const DEFAULT_TESTS_DIR = '.github/scripts/ui-tests';

// THE PROBE NEEDS ITS OWN BOUND. Playwright sends `newContext()` and
// `context.close()` with `kNoTimeout`, so a browser that starts and then stops
// answering the protocol -- alive, but not responding -- hangs this file
// forever, before the next rung and before any verdict is printed. Bounding the
// INSTALLER did not make the ladder bounded (Codex, #355); the launch side needs
// the same treatment, and a diagnostic that can hang is not a diagnostic.
//
// Thirty seconds: opening an empty context is a local operation with no network
// in it, so a browser that has not answered in that time is not slow, it has
// stopped answering.
const PROBE_TIMEOUT_MS = 30 * 1000;

/**
 * Resolve to `{ value }`, `{ error }` or `{ timedOut: true }`.
 *
 * WHAT THIS CANNOT DO, said plainly: cancel the underlying call. A `kNoTimeout`
 * protocol request stays outstanding, and its handle can keep Node alive after
 * the verdict is printed -- which is why the CLI flushes and then exits rather
 * than waiting for the loop to drain. The bound buys a REPORT, not a clean
 * teardown, and those are different things.
 */
function bounded(promise, ms) {
  let timer = null;
  const stop = () => { if (timer) clearTimeout(timer); };
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => { stop(); return { value }; },
      (error) => { stop(); return { error }; },
    ),
    // ⚠️ NOT `unref()`ed. An unref'd timer does not keep Node alive, so if the
    // awaited call is the only thing outstanding -- exactly the hang this bound
    // exists for -- the process exits BEFORE the bound fires, with code 0 and no
    // verdict. Measured: it ended this file's own case suite silently, mid-run.
    // A bound that cannot fire is not a bound; the timer is cleared on every
    // settled path instead, which is what keeps it from holding the loop open.
    new Promise((res) => { timer = setTimeout(() => res({ timedOut: true }), ms); }),
  ]);
}

// AN EXPLICIT DIRECTORY IS AUTHORITATIVE FOR RESOLUTION, NOT ONLY FOR EXISTENCE.
// main() already refuses a --tests-dir the caller named that does not exist. This
// fallback quietly undid half of that: a named directory that EXISTS but holds no
// Playwright resolved from the working directory instead, while the installer
// still ran in the named one -- so the ladder installed into one tree and
// launched from another, and a version or browser-revision mismatch between them
// came out as a CEILING (Codex, #355). The cwd fallback survives only for the
// DEFAULT, which is a guess this file makes rather than something the caller
// asserted.
// THE BASE WE ASKED FROM IS NOT THE BASE IT CAME FROM. `createRequire` walks
// EVERY ancestor's `node_modules`, so resolution succeeds from a directory that
// does not exist -- and the first version of this returned that directory as the
// installer's cwd, which `spawnSync` would have rejected with ENOENT while the
// banner announced it as the tree in use. Caught by this file's own case, which
// is the reason the case asserts the announced directory rather than only the
// exit code (#355 round 7).
//
// `npx` walks ancestors the same way, so the nearest EXISTING ancestor of the
// requested base resolves through exactly the chain `createRequire` used: the
// directories that do not exist contribute nothing to either search.
// THE TREE THE PACKAGE LIVES IN, derived from the package itself.
// `/x/y/node_modules/playwright/index.js` -> `/x/y`. This is the directory whose
// `node_modules` holds the module, so `npx` run there finds the same package's
// local CLI -- no search, no ambiguity, and no second computation to diverge.
//
// It also closes the symlink case. `createRequire` searches the ancestors of the
// LEXICAL path it is given, while a process spawned with that path as `cwd`
// observes the CANONICAL target and searches ITS ancestors -- two different
// trees again, and a Playwright resolved from one while the installer fetched
// another (Codex, #355). `require.resolve` returns a real path, so the tree
// derived from it is canonical by construction and both sides agree.
function treeRootOf(packagePath) {
  const parts = String(packagePath || '').split(sep);
  const marker = parts.lastIndexOf('node_modules');
  if (marker <= 0) return null;
  return parts.slice(0, marker).join(sep) || sep;
}

function nearestExisting(dir) {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(current)) return current;
    const up = dirname(current);
    if (up === current) return process.cwd();
    current = up;
  }
}

function resolvePlaywright(testsDir, explicit) {
  const bases = explicit ? [resolve(testsDir)] : [resolve(testsDir), process.cwd()];
  const tried = [];
  for (const asked of bases) {
    try {
      const require_ = createRequire(join(asked, 'noop.js'));
      const mod = require_('playwright');
      // Where the module ACTUALLY came from, reported alongside the working
      // directory so a reader can see both rather than infer one from the other.
      let packagePath = null;
      try { packagePath = require_.resolve('playwright'); } catch { /* informational only */ }
      // The package's own tree when it can be derived; the nearest existing
      // ancestor of what we asked for only when it cannot.
      const base = treeRootOf(packagePath) || nearestExisting(asked);
      return { mod, asked, base, packagePath };
    } catch (err) {
      tried.push(`${asked}: ${err.message.split('\n')[0]}`);
    }
  }
  return { mod: null, tried };
}

function realLaunch(browser, testsDir, injected, explicit) {
  return () => {
    const found = injected ? { mod: injected } : resolvePlaywright(testsDir, explicit);
    if (!found.mod) {
      return { ok: false, harness: true,
               error: `playwright could not be resolved:\n    ${found.tried.join('\n    ')}` };
    }
    const playwright = found.mod;
    try {
      const browserType = playwright[browser];
      if (!browserType) return { ok: false, error: `playwright exposes no "${browser}"` };
      // Launch and close synchronously from the caller's perspective: the CLI
      // awaits this promise. A launch that starts and immediately dies still
      // counts as a failure, which is why the browser is closed rather than
      // leaked -- close throwing is a browser that did not really come up.
      // CHECK IT IS STILL CONNECTED BEFORE CLOSING IT. `Browser.close()` treats an
      // already-closed target as an idempotent success -- it catches
      // TargetClosedError and resolves -- so a browser that starts and dies
      // immediately produced `ok: true` from a clean close, which is exactly the
      // case the comment above claims to catch (Codex, #355). A successful
      // cleanup is not a health signal; `isConnected()` asks the question
      // directly, and the close is then only cleanup.
      return browserType.launch()
        .then(async (b) => {
          // USE IT, do not merely ask whether it is connected. `isConnected()` is
          // a flag sampled at an instant, and a browser that dies between that
          // sample and the close still passed -- the start-then-die window round
          // 1 claimed to have closed (Codex, #355). Opening a context is the
          // cheapest operation that requires the process to still be answering,
          // which is the property "it launched" is supposed to mean.
          let error = null;
          const opened = await bounded(b.newContext(), PROBE_TIMEOUT_MS);
          if (opened.timedOut) {
            error = `the browser started but stopped answering: no context after ${PROBE_TIMEOUT_MS} ms`;
          } else if (opened.error) {
            error = `the browser started but could not be used: ${(opened.error && opened.error.message) || opened.error}`;
          } else {
            const closed = await bounded(opened.value.close(), PROBE_TIMEOUT_MS);
            if (closed.timedOut) {
              error = `the browser started but stopped answering: the context would not close within ${PROBE_TIMEOUT_MS} ms`;
            }
            // A close that THROWS is still a browser that answered, so it is
            // cleanup rather than the verdict -- unchanged from round 3.
          }
          // Best effort, and bounded for the same reason: cleanup must not be
          // able to outlast the thing it is cleaning up after.
          await bounded(Promise.resolve().then(() => b.close()).catch(() => {}), PROBE_TIMEOUT_MS);
          return error ? { ok: false, error } : { ok: true, error: null };
        })
        .catch((err) => ({ ok: false, error: err && err.message ? err.message : String(err) }));
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

// EXPORTED AND TESTED. This lived inline in main(), which no case exercised --
// so the round-3 mutant that restored the broken filter reddened NOTHING, and the
// most user-visible bug of that round (`browser-ladder.js firefox` silently
// running chromium) had no case at all. Untested argument parsing is where that
// bug lived for two rounds.
function parseArgs(argv) {
  // WALK THE ARGUMENTS. The first version filtered on `i !== flag + 1`, and with
  // no `--tests-dir` present `flag` is -1, so `flag + 1` is 0 and the filter
  // dropped argv[0] -- the browser (Codex, #355). An index computed from a
  // not-found result is the bug; walking the list cannot produce one.
  // SUPPLIED-BUT-EMPTY IS NOT OMITTED. `|| null` collapsed a trailing
  // `--tests-dir` and a bare `--tests-dir=` into the same value the omitted case
  // produces, so the caller's malformed option silently became the shipped
  // default -- the ladder then installed into and reported on a directory the
  // caller never named, which is the mistyped-directory defect round 3 refused,
  // reached by a different route (Codex, #355). `null` now means OMITTED and
  // nothing else; an empty string means the flag was there with no usable value,
  // and main() refuses it.
  const positional = [];
  let testsDirArg = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--tests-dir') { testsDirArg = argv[i + 1] == null ? '' : argv[i + 1]; i += 1; continue; }
    if (argv[i].startsWith('--tests-dir=')) {
      testsDirArg = argv[i].slice('--tests-dir='.length);
      continue;
    }
    positional.push(argv[i]);
  }
  return {
    browser: positional[0] || 'chromium',
    testsDir: testsDirArg == null ? DEFAULT_TESTS_DIR : testsDirArg,
    testsDirArg,
  };
}

async function main(argv) {
  const { browser, testsDir, testsDirArg } = parseArgs(argv);
  if (!BROWSERS.includes(browser)) {
    warn(`browser-ladder: unknown browser "${browser}" — expected one of ${BROWSERS.join(', ')}`);
    return 2;
  }
  say(`browser-ladder: ${browser} — grading on whether it LAUNCHES`);
  // NOT "running any installer from <predicted>". That line re-derived the
  // installer's directory from the existence rule the code no longer uses, so it
  // would have announced one tree while the run used another -- a banner that
  // lies quietly. The real base is printed below, after it is decided, by the
  // code that decides it.
  say(`  looking for playwright under ${testsDir}`
    + `${testsDirArg == null ? ', then the working directory' : ' (explicitly named — no fallback)'}`);

  // ONE implementation. main() wires the real effects into the same `ladder()`
  // the cases file drives with stubs; if it looped over RUNGS itself, the tested
  // logic and the shipped logic would be two things that merely look alike.
  // A DIRECTORY THE CALLER NAMED AND THAT DOES NOT EXIST IS A TYPO, NOT A
  // FALLBACK. Silently dropping to the working directory meant a mistyped
  // --tests-dir installed into, and reported on, a DIFFERENT harness than the
  // one asked for -- an invalid pass or an invalid ceiling, either way about
  // the wrong tree (Codex, #355). The fallback survives only for the default,
  // which is a guess this file makes rather than something the caller asserted.
  // ONLY the truly empty value is refused here. A directory whose name is
  // whitespace is legal on POSIX and resolves to a real path, so trimming before
  // this test would refuse a directory the OS accepts -- an over-broad refusal
  // where the existence check below already gives the right answer.
  if (testsDirArg === '') {
    warn('browser-ladder: CANNOT CHECK — --tests-dir was given with no value');
    warn('  A trailing "--tests-dir" or a bare "--tests-dir=" names no directory,');
    warn('  and falling back to the default would install into and report on a tree');
    warn('  you did not ask for. Pass a directory, or omit the flag entirely.');
    return 2;
  }
  if (testsDirArg && !existsSync(resolve(testsDirArg))) {
    warn(`browser-ladder: CANNOT CHECK — --tests-dir ${testsDirArg} does not exist`);
    warn(`  resolved: ${resolve(testsDirArg)}`);
    warn('  This says nothing about the browser. Point it at the directory holding');
    warn("  the UI kit's node_modules, or omit it to use the shipped default.");
    return 2;
  }
  // ONE RESOLUTION, ONE BASE — and that is why this happens HERE rather than at
  // launch time. The previous version chose the installer's directory by
  // EXISTENCE and let the launcher resolve Playwright INDEPENDENTLY, under a
  // comment claiming "the same directory for both". Two computations, and for
  // the default they disagree exactly when it matters: a default directory that
  // exists but holds no Playwright made `npx` install into it while every launch
  // used the working directory's Playwright, so the browser revision fetched was
  // not the one launched and the mismatch came out as a CEILING (Codex, #355).
  // Round 6 fixed this for an EXPLICIT --tests-dir and left the default branch —
  // a rule applied to one of the two places it governs, which is how it came
  // back a round later.
  //
  // So the tree is resolved once, and the base it resolved FROM is what the
  // installer runs in. There are no longer two values to keep in step.
  const found = resolvePlaywright(testsDir, testsDirArg != null);
  if (!found.mod) {
    // A MISSING HARNESS IS NOT A BROWSER CEILING. Reported through the shipped
    // report so there is one wording, not two.
    return report(browser, {
      ok: false,
      harness: true,
      rung: null,
      attempts: [{
        rung: 'as-is',
        install: null,
        launch: { ok: false, harness: true,
                  error: `playwright could not be resolved:\n    ${found.tried.join('\n    ')}` },
      }],
    });
  }
  say(`  playwright resolved from ${found.packagePath || '(path unavailable)'}`);
  say(`  the installer runs in ${found.base}, the same tree that resolution used`);

  const outcome = await ladder({
    browser,
    install: (argv) => realInstall(argv, found.base),
    launch: realLaunch(browser, testsDir, found.mod),
    // The progress lines quote `firstLine(error)`, and the first line of a
    // single-line 5 MB error is the whole 5 MB -- so this channel needs the
    // bound as much as the report does. `say` carries it; double-wrapping it
    // here would just be a second place to forget.
    log: say,
  });
  return report(browser, outcome);
}

// FLUSH, THEN EXIT — and flush EVERY stream this file writes to.
//
// `process.exit()` alone TERMINATES BEFORE A PIPE DRAINS, and this file's output
// is the evidence a reader keeps: quoted installer output and launch errors,
// neither length-bounded. A bare exit truncated exactly the material the CANNOT
// CHECK and CEILING reports exist to preserve.
//
// But `exitCode` alone does not guarantee LEAVING. The probe's bound cannot
// cancel a `kNoTimeout` protocol call, so its handle can hold the loop open
// after the verdict is printed -- a ladder that reports and then hangs is still a
// ladder that hangs.
//
// Writing an empty string queues a callback BEHIND everything already written,
// so it fires once that stream has drained. The first version waited for STDOUT
// ONLY, while every refusal in this file -- the unknown browser, the empty
// --tests-dir, the missing one -- goes to STDERR (Codex, #355). ⚠️ I could NOT
// reproduce the truncation here: ten runs on Node 22.22.2 with a 100,000-char
// argument returned all 100,079 stderr bytes every time. Node documents pipe
// writes as asynchronous on POSIX, so the report is credible and the fix is
// strictly more correct either way -- but the case below pins the MECHANISM
// (every stream is awaited), because a completeness assertion is green on this
// machine with or without the fix and would prove nothing.
const FLUSHED_STREAMS = [process.stdout, process.stderr];

// AND THE WAIT ITSELF IS BOUNDED (#358). Waiting for every stream turned a
// truncated report into a HANG: a consumer that opens stdout as a pipe and never
// reads it leaves the callback queued forever, so `pending` never reaches zero
// and the process never exits. Measured before the fix: a 5 MB launch error with
// an unread stdout pipe was still running after 4 s. That also defeated the
// forced exit itself, which exists to escape a Playwright handle the probe's
// bound cannot cancel -- so an unbounded flush unbounded the whole ladder.
//
// THE ORDERING IS THE POINT, and it is the opposite of what the flush fix
// assumed: A TRUNCATED REPORT BEATS A HANG. A report cut short still tells the
// reader something and the exit status still arrives; a diagnostic that never
// returns tells them nothing and blocks whatever ran it.
//
// AND THE WAIT IS BOUNDED (#358), BY A DEADLINE THE REPORT'S SIZE JUSTIFIES
// (#359). Waiting for every stream to drain turned a truncated report into a
// HANG: a consumer that opens stdout as a pipe and never reads it leaves the
// callback queued forever. Measured before the fix: a 5 MB launch error with an
// unread stdout pipe was still running after 4 s. That also defeated the forced
// exit itself, which exists to escape a Playwright handle the probe's bound
// cannot cancel -- so an unbounded flush unbounded the whole ladder.
//
// THE ORDERING IS THE POINT: A TRUNCATED REPORT BEATS A HANG. A report cut short
// still tells the reader something and the exit status still arrives; a
// diagnostic that never returns tells them nothing and blocks whatever ran it.
//
// ⚠️ THE FIRST VERSION OF THIS COMMENT ASSERTED that ten seconds "cannot cut
// short a healthy reader". That was false and Codex disproved it: a consumer
// draining 100 KB every 300 ms, never once idle, received 3,276,800 bytes of a
// 5 MB report and lost the rest. An elapsed-time bound cannot tell a slow reader
// from a stopped one -- at ANY value, given a large enough report.
//
// So the report was bounded instead, at MAX_REPORT_LINE above, on BOTH channels
// that carry text this file did not write; the deadline is only defensible as
// ARITHMETIC over a known maximum. Measured worst case -- a 5 MB single-line
// launch error and an installer emitting 200 lines of 20,000 characters --
// 46,628 bytes, down from 15,769,172 before the bound. Ten seconds therefore
// truncates nothing draining faster than ~4.7 KB/s, and a case pins the ceiling
// so the arithmetic stays true. That is a claim about a measured maximum rather
// than about which readers are "realistic", which is what the old comment got
// wrong. Verified end to end at ~13 KB/s: the report arrived complete in 3.9 s.
//
// A PROGRESS-BASED DEADLINE WAS TRIED FIRST AND DOES NOT WORK -- recorded so it
// is not re-attempted. Resetting the clock whenever bytes moved is the right
// idea and Node exposes no signal for it: a single large `write` is ONE libuv
// request, so `writableLength` sat at 5,242,880 for the entire drain and
// `bytesWritten` counted bytes ACCEPTED, not delivered. Measured -- both were
// constant while the reader was actively reading, so the poll read a healthy
// drain as idle and truncated at exactly the same byte count as no fix at all.
//
// NOT `unref`ed, for the round-9 reason: a bound that cannot fire when the thing
// it bounds is the only work left is not a bound.
const FLUSH_TIMEOUT_MS = 10 * 1000;

function flushThenExit(code, streams = FLUSHED_STREAMS, exit = process.exit,
                       timeout = FLUSH_TIMEOUT_MS) {
  let done = false;
  const leave = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    exit(code);
  };
  const timer = setTimeout(leave, timeout);

  let pending = streams.length;
  if (!pending) { leave(); return; }
  const settled = () => { pending -= 1; if (pending === 0) leave(); };
  for (const stream of streams) {
    try {
      stream.write('', settled);
    } catch {
      // A stream that cannot be written to cannot be waited for either.
      settled();
    }
  }
}

module.exports = { ladder, report, RUNGS, BROWSERS, firstLine, realInstall, realLaunch,
  resolvePlaywright, classifyInstall, INSTALL_MAX_BUFFER, INSTALL_TIMEOUT_MS, parseArgs,
  DEFAULT_TESTS_DIR, PROBE_TIMEOUT_MS, bounded, treeRootOf, killGroup,
  flushThenExit, FLUSHED_STREAMS, FLUSH_TIMEOUT_MS, ACTIVE_INSTALLS,
  CLEANUP_SIGNALS, reapActiveInstalls, NOT_OUR_SIGNALS, STOP_SIGNALS,
  cleanupSignalsFor, POSIX_TERMINATING,
  boundReportLine, MAX_REPORT_LINE_BYTES, say, warn };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    flushThenExit(code);
  });
}
