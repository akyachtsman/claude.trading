'use strict';
// Per-project WCAG AA contrast guardrail. Reads this project's design tokens
// (styles/tokens.css or css/tokens.css by default; see "WHERE THE TOKENS LIVE"
// below to point it elsewhere) and checks the meaningful foreground/background
// pairs. Copy into the project's .github/scripts/ and run it from qa.yml. If no
// tokens file exists yet and the repo has no CSS (before /design-intake), it
// prints a notice and exits 0 — safe in a fresh repo.
// CommonJS (matches the other .github/scripts/ helpers, e.g. notify-email.js).
//
// ── What a green run does NOT prove ─────────────────────────────────────────
// The pair list below is a FLOOR, not a coverage report. It encodes the roles
// these tokens are ASSUMED to play; it cannot see what your project renders.
// Where the assumption is wrong this gate certifies a broken state, and that
// certification is indistinguishable from a correct one. Three ways, all
// measured downstream (claude.prop, 2026-08-23):
//   1. WRONG ROLE. --color-danger is checked as a FOREGROUND over page
//      surfaces. A project whose only use of it is a hover BACKGROUND under a
//      hard-coded #fff agrees with these numbers only while surfaces stay light
//      — contrast is symmetric. Forced to a dark theme with --color-danger:
//      #fff, this script printed 17.30 and 18.50, "OK", 9/9, exit 0, while the
//      delete control rendered white-on-white.
//   2. WRONG FLOOR. accent/surface is checked at AA_LARGE (3.0). A project
//      using --color-accent for 12-13px labels gets 3.54 certified "OK" while
//      every one of those labels fails AA. Our own starter kit is one re-theme
//      from this: templates/styles/components.css renders .btn-secondary:hover
//      and :focus-visible in --color-accent over --color-surface at 15px/500 —
//      normal text, so the real floor is 4.5 — and only the 3.0 pair below
//      measures that combination. (The starter palette is 5.75, so it passes
//      today; nothing here would notice if it stopped.)
//   3. NOT LISTED, NOT MEASURED. Downstream, a chip shipped --color-accent on
//      --color-accent-light at 4.32:1, 11px bold, visible on the dashboard,
//      failing AA the whole time. No hand-written pair described it, and none
//      here does either.
// DERIVING the pairs from components.css instead — every rule declaring both a
// color: and a background: from tokens — catches (3), and is also incomplete:
// it cannot see text that sets a colour and INHERITS its background, which is
// every selector in (2). It also misses what enumeration catches (.btn:hover
// declares a background and no colour). Neither method subsumes the other. A
// complete check resolves each element's EFFECTIVE background through the
// cascade — a different program from this one, and nobody has written it.
// So: "9/9 OK" means the nine listed pairs passed. Before trusting it, confirm
// your token roles match the ones assumed below, derive your own pairs from
// your components.css, and check by hand any text using --color-accent below
// 18.66px (or below 24px when not bold).
// ────────────────────────────────────────────────────────────────────────────
const { readFileSync, existsSync, readdirSync, statSync, realpathSync } = require('fs');
const { join } = require('path');

// ── WHERE THE TOKENS LIVE (#322) ────────────────────────────────────────────
// The path used to be one literal, 'styles/tokens.css', and a project keeping
// its contract at css/tokens.css got a red build from a constant rather than a
// contrast problem — or carried a local edit to re-diff on every refresh. So a
// project SAYS where its tokens are, in the first of these that is set:
//   1. `--tokens <file>` (or `--tokens=<file>`), repeatable — qa.yml's run line
//   2. CHECK_CONTRAST_TOKENS=<file>[,<file>…]
//   3. CANDIDATES below, edited in place (a themed project lists each theme's
//      file — design.md -> a themed project gives each theme its own file)
// Every configured file is checked, never just the first. Left unconfigured,
// the script GUESSES from DEFAULT_CANDIDATES and checks each one that exists.
const CANDIDATES = [];
const DEFAULT_CANDIDATES = ['styles/tokens.css', 'css/tokens.css'];

const fromArgs = [];
for (let a = 2; a < process.argv.length; a++) {
  const arg = process.argv[a];
  if (arg === '--tokens' && a + 1 < process.argv.length) fromArgs.push(process.argv[++a]);
  else if (arg.startsWith('--tokens=') && arg.length > 9) fromArgs.push(arg.slice(9));
  else {
    // A mistyped flag must not fall back to the defaults: that would measure a
    // file the project did not name and print green about it.
    console.error(`FAIL  unrecognised argument ${JSON.stringify(arg)} — usage: check-contrast.js [--tokens <file>]…`);
    process.exit(1);
  }
}
const fromEnv = (process.env.CHECK_CONTRAST_TOKENS || '').split(',').map((f) => f.trim()).filter(Boolean);
const CONFIGURED = fromArgs.length ? fromArgs : fromEnv.length ? fromEnv : CANDIDATES;
const CONFIG_SOURCE = fromArgs.length ? '--tokens' : fromEnv.length ? 'CHECK_CONTRAST_TOKENS' : 'CANDIDATES';
const LOOKED_AT = CONFIGURED.length ? CONFIGURED : DEFAULT_CANDIDATES;
const FILES = LOOKED_AT.filter((f) => existsSync(f));

// A CONFIGURED file that is gone is a broken configuration, not a fresh repo.
// Only the defaults are guesses; a configured entry can only get there by a
// human saying "this project's tokens live in these files". Filtering configured
// files through existsSync measured the surviving theme and printed green for
// it, while the renamed one was never read -- the every-theme guarantee
// reported about a file nobody opened. So any configured file that is missing
// is FATAL: absent-and-unconfigured is the bootstrap/gap logic below,
// absent-while-configured is a failure.
const MISSING = CONFIGURED.filter((f) => !existsSync(f));
if (MISSING.length > 0) {
  console.error(`FAIL  ${MISSING.length} of ${CONFIGURED.length} configured token files do not exist:`);
  for (const f of MISSING) console.error(`        ${f}`);
  console.error(`      ${CONFIG_SOURCE} names the files this project declares as its design contract.`);
  console.error('      Measuring only the ones still present would certify a palette this gate');
  console.error(`      never read. Restore the file, or drop it from ${CONFIG_SOURCE}.`);
  process.exit(1);
}
if (FILES.length === 0) {
  // A repo with no CSS at all has nothing to check (a fresh scaffold before
  // /design-intake). A repo that HAS stylesheets but none at a known token path
  // is a real gap: failing here is the whole point of a guardrail.
  //
  // "Has CSS" must mean an actual .css file. Treating index.html — or a `styles/`
  // directory that exists but is empty — as proof of CSS failed the static-check
  // job for a fresh project that had a page and no stylesheet yet, contradicting
  // the bootstrap behaviour documented at the top of this file.
  // Recursive, because projects keep stylesheets in src/, public/css/,
  // assets/styles/ and elsewhere. A shallow look at styles/ + app/ + root
  // answered "no CSS" for those and exited 0 — the vacuous green this branch
  // exists to reject.
  const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', 'vendor']);
  // No depth cap. A cutoff turns "I stopped looking" into "there is no CSS" —
  // a monorepo keeping its only stylesheet at packages/client/src/features/…
  // would have passed green. The ignore list below bounds the walk instead,
  // and the search short-circuits on the first .css file found.
  // Dirent's isFile()/isDirectory() are BOTH false for a symlink, so link
  // handling used to be a special case bolted onto the file test — which left
  // the other half open: `assets -> ../shared/assets` holding the project's only
  // stylesheet was neither a file nor a directory, so it was not counted and not
  // descended into, and the walk answered "no CSS at all". One resolution step
  // for every entry replaces both special cases: ask the filesystem what the
  // entry IS, once, and let the file and directory branches read the answer.
  // realpath keys the visited set, so a link cycle (`a -> .`) terminates.
  const visited = new Set();
  const hasCssUnder = (dir) => {
    let entries;
    try {
      const real = realpathSync(dir);
      if (visited.has(real)) return false;   // a symlink cycle, already walked
      visited.add(real);
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      let isFile = e.isFile();
      let isDir = e.isDirectory();
      if (!isFile && !isDir) {
        // A symlink, or something this walk has no opinion about. statSync
        // follows the link; a broken one throws and is neither.
        try {
          const st = statSync(path);
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch { continue; }
      }
      if (isFile && e.name.endsWith('.css')) return true;
      if (isDir && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name)) {
        if (hasCssUnder(path)) return true;
      }
    }
    return false;
  };
  const hasCss = hasCssUnder('.');
  if (!hasCss) {
    console.log(`::notice::no stylesheet yet — run /design-intake to establish this project's look. Skipping contrast check.`);
    process.exit(0);
  }
  console.error(`FAIL  this project has CSS but no tokens file at ${LOOKED_AT.join(' or ')}.`);
  console.error('      design.md makes tokens.css the single source of truth — the contrast');
  console.error('      guardrail cannot run without it. Create one via /design-intake, or, if');
  console.error('      it lives elsewhere, name it: --tokens <file> or CHECK_CONTRAST_TOKENS.');
  process.exit(1);
}

// ── Reading declarations: a SCAN, not a regex ───────────────────────────────
// This was three regexes — strip comments, strip strings, match declarations —
// and #337 round 2 returned NINE findings against them in one pass: five silent
// (a wrong value measured and certified) and four spurious (a valid palette
// rejected). They did not converge. Each fix drew a reshaped one, and the last
// round's own fix became the next round's defect: deleting comments merges the
// tokens either side, so `#15/**/65c0` — which CSS does NOT read as a colour —
// became exactly `#1565c0` and matched the value it was overriding.
// The cause is not any one pattern. Raw-text matching cannot see what CSS sees:
//   * `--color-\61 ccent` is `--color-accent` — an escape in an identifier
//   * `content: "/*"` does not open a comment, and a later `*/` does not close one
//   * a `\` before a newline continues a string
//   * `--x: { … }` is a legal custom-property value containing braces
//   * `!important` is a flag on the declaration, not part of the value
// So this walks the file once, in CSS's own terms: comments become a SPACE
// (a boundary, never a join), strings and their escapes are consumed whole,
// brackets nest, and what it cannot read in CSS's terms it REFUSES rather than
// guessing at -- identifier escapes among them.
// It is not a full CSS parser and does not need to be — it needs to agree with
// one about where a declaration starts and ends, which is all this gate reads.
// Anything it cannot reason about is FATAL, never skipped: `@import` brings in a
// stylesheet this gate never sees, and an unterminated string or comment means
// the rest of the file is not what it appears to be.

// NO ESCAPE DECODER. There was one, for two rounds, and it was the wrong shape:
// `--color-\61 ccent` really is `--color-accent`, so a decoder unified them —
// and then `\FFFFFF` threw a RangeError out of String.fromCodePoint (CSS maps an
// invalid code point to U+FFFD), `@\69mport` slipped past the at-rule check
// because the raw text did not start with `@import`, and `!\69mportant` was not
// recognised as the flag. Three findings, one per surface the decoder touched.
// A backslash outside a string or a comment has no legitimate place in a design
// token file, so it is FATAL instead — one rule, no decoder, and none of those
// three classes can exist. Loud beats clever: refusing an escaped identifier
// tells the author to spell it plainly; decoding it correctly everywhere is a
// standing invitation to miss one surface.

// Pairs name their TOKENS, not their values. Listing names and resolving them
// at evaluation time is what lets the ambiguity check below know which tokens
// are actually measured without a second, drift-prone list of names.
const AA = 4.5, AA_LARGE = 3.0;
const pairs = [
  // No `|| '#FFFFFF'` fallback: substituting a default made the pair "evaluable"
  // while measuring a colour the page may not use, so a project that DROPPED the
  // token still scored 8/8. A missing required token must fail like any other.
  ['--color-on-accent', '--color-accent', AA, 'on-accent / accent (button)'],
  ['--color-text-primary', '--color-bg', AA, 'text-primary / bg'],
  ['--color-text-primary', '--color-surface', AA, 'text-primary / surface'],
  ['--color-text-secondary', '--color-bg', AA, 'text-secondary / bg'],
  ['--color-text-secondary', '--color-surface', AA, 'text-secondary / surface'],
  // Both button templates render the on-accent foreground over accent-hover on
  // hover (and the static one on keyboard focus), so the hover background is a
  // real background for this text and needs its own pair. Checking only the
  // resting state passed themes that go nearly-black-on-dark the moment a
  // pointer touches the control.
  ['--color-on-accent', '--color-accent-hover', AA, 'on-accent / accent-hover (button hover)'],
  ['--color-accent', '--color-surface', AA_LARGE, 'accent / surface (large)'],
  // design.md's error-message copy rule creates --color-danger; it carries meaning,
  // so it needs the same AA floor as any other body text.
  ['--color-danger', '--color-surface', AA, 'danger / surface'],
  ['--color-danger', '--color-bg', AA, 'danger / bg'],
];

// The measured set, derived from `pairs` so there is no second list of names.
// The scanner needs it: after #337 round 9 a measured token is recorded ONLY
// from a top-level `:root` rule and refused anywhere else, so "is this name
// measured" is a question the scan itself has to answer.
const MEASURED = new Set(pairs.flatMap(([fg, bg]) => [fg, bg]));

// ── CSS whitespace, not JavaScript's ────────────────────────────────────────
// CSS whitespace is exactly these five code points. String.prototype.trim()
// removes a far larger set, U+00A0 among them — and U+00A0 is an IDENTIFIER
// character in CSS. Trimming it off a name RENAMES the property: a file
// declaring `--color-bg<NBSP>` (nine times over) left the browser with no
// palette at all, while this gate trimmed each name back to the token it
// measures and printed `OK — 9/9`, exit 0. One definition, used wherever a CSS
// token is bounded here, because the same trim runs on names, values and the
// !important flag and each one renames or revalues what it touches.
const cssTrim = (t) => t.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');

// A custom-property name this check can vouch for. CSS allows far more — every
// non-ASCII code point is an identifier character, and escapes spell anything —
// but this gate MEASURES these names by comparing them literally, so one it
// cannot compare is FATAL rather than skipped. A silent skip is what let `--é`
// past the brace refusal below, and a skipped name is indistinguishable from a
// file that never declared it.
const PLAIN_CUSTOM_NAME = /^--[A-Za-z0-9_-]*$/;

// At-rules are checked at BOTH terminators, `;` and `{`. Checking only `;`
// missed every block-form at-rule.
//
// THIS LIST HAS BEEN INVERTED TWICE, AND THE DIRECTION IS THE WHOLE POINT.
// It began as an ALLOW-LIST of grouping rules, to decide whether a block's
// declarations could be read. That was wrong twice (@layer missing, r5;
// @starting-style added, r7) and its failure mode was silent — an at-rule
// wrongly admitted supplied a palette.
// Round 9 made a measured token readable only from a top-level `:root`, which
// killed that job, so it became a DENY-LIST of text-hiding rules where a short
// list could only over-refuse. Round 10 showed the deny-list had inherited the
// silent direction anyway, three times over, because an at-rule need not
// SUPPLY declarations to break the palette — it can change what the top-level
// `:root` MEANS:
//   @property --color-accent { inherits: false; initial-value: #FFF }
//                     the root value stops inheriting; `.btn` renders the
//                     white initial value while this gate measures 5.75:1
//   @namespace url(…)  a DEFAULT namespace re-points the implied universal, so
//                     `:root` no longer matches the HTML document root
//   @forward "theme"   like @use: emits CSS from a sheet never opened here
//
// So it is an allow-list again — and this time a short one FAILS LOUDLY, because
// nothing here decides whether declarations may be read any more. An unknown or
// newly-specified at-rule is refused with a message naming it, and the fix is to
// add it after checking it against the question below. That question is the
// membership rule, and it is not "is this a grouping rule" (the r7 error) but:
//
//   CAN THIS AT-RULE CHANGE WHAT A TOP-LEVEL `:root` PALETTE MEANS?
//
// @media/@supports/@container/@layer/@scope cannot: their contents are not read
// and a `:root` outside them is untouched. @font-face/@keyframes declare
// something that is not an element's tokens. @charset is a file-encoding
// preamble.
const AT_RULES_SAFE = new Set([
  'charset', 'media', 'supports', 'container', 'layer', 'scope',
  'font-face', 'keyframes', 'property',
]);
function atRuleProblem(buf) {
  const head = cssTrim(buf);
  if (!head.startsWith('@')) return null;
  const name = (/^@([A-Za-z0-9_\u0080-\uFFFF-]*)/.exec(head) || [, ''])[1].toLowerCase();
  if (!AT_RULES_SAFE.has(name)) {
    return `an @${name || '(unreadable)'} rule — this gate does not know that it leaves a top-level \`:root\` palette`
      + ' meaning what it says, and refuses rather than assume; if it does, add it to AT_RULES_SAFE';
  }
  // @property is safe EXCEPT for a measured name, where it is the sharpest
  // failure this gate has: registering `--color-accent` with `inherits: false`
  // and a white initial value leaves the root declaration intact and measurable
  // while every descendant renders the initial value instead. Modelling that
  // means modelling registration semantics; refusing costs a project nothing it
  // needs, since a measured token has no reason to be registered.
  if (name === 'property') {
    // CSS whitespace, not `\s`: JavaScript's class includes U+00A0, which CSS
    // reads as part of an identifier. `--color-accent<NBSP>` is a DIFFERENT
    // property and cannot affect the measured one, but `[^\s{;]+` truncated it
    // to the measured name and refused a valid file.
    const registered = (/^@property[ \t\n\r\f]+(--[^ \t\n\r\f{;]+)/i.exec(head) || [, ''])[1];
    if (MEASURED.has(registered)) {
      return `an @property registration of the measured token \`${registered}\` — it can stop the root value`
        + ' inheriting, or give descendants a different initial value, neither of which this gate resolves';
    }
  }
  return null;
}

// Returns { decls } or { fatal: '…' }. `decls` maps a custom-property name to
// every value declared for it, in source order. Names are AS SPELLED: an
// escaped identifier is refused, never decoded, so nothing here has unified two
// spellings of one property and no caller may assume it has.
function scanDeclarations(rawCss) {
  // CSS decoding removes a leading BOM; Node's utf8 read keeps it as U+FEFF.
  // That one invisible character made `head.startsWith('@')` false for the
  // FIRST at-rule in the file, so the whole allow-list was skipped and a BOM
  // followed by `@property --color-accent { inherits: false; … }` printed
  // OK — 9/9 while the browser applied the registration. Strip it here, once,
  // rather than teaching every downstream test to ignore it.
  // CSS PREPROCESSING, done here because it is what the browser does before
  // tokenizing and every downstream rule assumes it has happened:
  //   * a leading BOM is removed — CSS decoding drops it, Node's utf8 read keeps
  //     it, and one U+FEFF made `head.startsWith('@')` false for the FIRST
  //     at-rule in the file, skipping the whole allow-list (round 11);
  //   * U+0000 becomes U+FFFD, which is a NAME character — so `<NUL>url(` stays
  //     one ordinary function token and does NOT enter the URL state, and
  //     `@media<NUL>` is the unknown at-rule `media<FFFD>` rather than `media`.
  //     Two rounds patched the consequences of not doing this (the identifier
  //     capture in round 8, the url boundary now); doing the substitution once,
  //     at the layer CSS does it, retires both.
  const hadBom = rawCss.charCodeAt(0) === 0xFEFF;
  const css = (hadBom ? rawCss.slice(1) : rawCss).replace(/\0/g, '\uFFFD');

  // @charset is read HERE, from the raw text, and not in atRuleProblem — by the
  // time a declaration reaches that function its strings have been consumed and
  // replaced with `""`, so the encoding name is gone. (I wrote it there first
  // and `@charset "utf-8"` came back as `(unreadable)`, which is the scanner
  // working as designed and the check asking the wrong layer.)
  // The preamble must be the one this gate can actually read: readFileSync
  // decodes every file as UTF-8 whatever the sheet says, so a Shift_JIS file
  // whose bytes CSS reads as one identifier character arrives as U+FFFD plus a
  // stray backslash and fails on an escape that does not exist. Refusing beats
  // red-building a valid stylesheet for a reason that names the wrong thing.
  // THE EXACT BYTE FORM, or it is not an encoding declaration at all. CSS's
  // sniff requires `@charset "…";` spelled in lowercase, with ONE ASCII space
  // and a terminating quote-semicolon — anything else is a parsed-and-ignored
  // at-rule that changes no decoding. A case-insensitive, multi-whitespace match
  // refused `@CHARSET "shift_jis";` on a file that is in fact readable UTF-8,
  // which is the loud-but-wrong direction: the previous version was strict about
  // the encoding and sloppy about what counts as declaring one.
  // AND ONLY WHEN THERE WAS NO BOM. A UTF-8 BOM is itself the encoding
  // signature and it OUTRANKS `@charset`: per spec, text following a BOM is not
  // an encoding declaration at all, so a BOM-prefixed `@charset "shift_jis";`
  // describes a file that is already, correctly, being read as UTF-8. Sniffing
  // the stripped text made the BOM invisible to the check that most needed to
  // see it, and refused a stylesheet this gate reads perfectly well.
  //
  // Note which direction this was wrong in. Every other refusal here exists
  // because a partial read produces a confident number about a colour the page
  // may never render; this one produced no number at all, on a file with
  // nothing wrong with it. I asked about exactly this position in the round-12
  // request — "after the BOM strip, is offset 0 still the right position?" —
  // and shipped the version I was already unsure of. Naming a doubt is not
  // resolving it, which is the same note round 4 of the sibling PR earned.
  const charset = hadBom ? null : /^@charset "([^"]*)";/.exec(css);
  if (charset && !/^utf-?8$/i.test(charset[1])) {
    return { fatal: `an @charset of "${charset[1]}" — this gate decodes every file as UTF-8,`
      + ' so it would read different characters than the browser does' };
  }
  const decls = {};
  let buf = '';          // the declaration candidate being accumulated
  let colonAt = -1;      // index in buf of its first top-level `:`
  const closers = [];    // open ( and [ , innermost last
  // Plain nesting depth. There was a block-KIND stack here, to decide whether a
  // `{` opened a rule or a custom-property value; the branch below refuses
  // brace-valued declarations outright instead, so nothing needs to know what a
  // block contains and the only question left is whether one is open.
  let depth = 0;
  // ── WHERE A MEASURED TOKEN MAY LIVE ────────────────────────────────────────
  // ONE RULE, replacing four rounds of trying to classify blocks: a measured
  // token is recorded only from a `:root` rule at the TOP LEVEL of the
  // stylesheet, and is FATAL anywhere else.
  //
  // Rounds 5 through 9 each asked "does this context apply?" and answered it
  // locally, and each answer was wrong in a way the next round found:
  //   r5  prelude before the colon is a plain identifier
  //   r6  only `--` preludes refuse; descend otherwise
  //   r7  only whitespace between the colon and the `{`
  //   r8  descend, but refuse a measured token in an ambiguous block
  // Round 9 then broke r8 four different ways at once — a leading-hyphen
  // property name, `@media print` (a condition that can be false), a NUL inside
  // an at-keyword, and `.e:definitely-not-a-pseudo` (an invalid selector CSS
  // drops) — every one of them printing OK — 9/9 on a palette the page never
  // applies. The question has no local answer. It is not asked any more.
  //
  // What this buys, and it is the whole point: the scanner no longer needs to
  // know whether a block applies, because nowhere except a top-level `:root`
  // is allowed to hold a measured token. An unknown at-rule, a false media
  // query, an invalid selector, a dropped declaration-shaped rule — all of them
  // now fail the same way, loudly, without being told apart.
  // The cost is stated in design.md: a themed project must give each theme its
  // own file with a complete `:root` palette, which design.md already required.
  const records = [];                    // one flag per open block
  const recordingHere = () => records.length > 0 && records[records.length - 1];

  const flush = () => {
    let problem = null;
    if (colonAt >= 0) {
      const name = cssTrim(buf.slice(0, colonAt));
      if (name.startsWith('--')) {
        if (!recordingHere()) {
          // Outside a top-level `:root`. A MEASURED token here is fatal — this
          // is the one rule that replaced classifying blocks. An unmeasured one
          // is ignored: no pair reads it, so where it lives cannot affect a
          // number this gate prints, and refusing it would red-build valid
          // token files over a property nothing measures.
          if (MEASURED.has(name)) {
            problem = `a measured custom property outside a top-level \`:root\` rule (\`${name}\`)`
              + ' — whether those declarations apply depends on the selector, the media query and'
              + ' the cascade, none of which this gate resolves, so it refuses rather than assume';
          }
        } else if (!PLAIN_CUSTOM_NAME.test(name)) {
          problem = `a custom property whose name this check cannot compare literally (\`${name}\`)`
            + ' — spell token names with ASCII letters, digits, - and _';
        } else {
          // !important is a declaration FLAG; CSS does not put it in the value.
          // Bounded with CSS whitespace for the same reason the name is: `\s`
          // would eat a U+00A0 that CSS reads as part of an identifier, turning
          // a declaration CSS DROPS into one this gate measures.
          const value = cssTrim(buf.slice(colonAt + 1).replace(/[ \t\n\r\f]*![ \t\n\r\f]*important[ \t\n\r\f]*$/i, ''));
          (decls[name] ||= []).push(value);
        }
      }
    }
    buf = '';
    colonAt = -1;
    return problem;
  };

  // ── ONE TERMINATOR ROUTINE (#340) ─────────────────────────────────────────
  // `;`, `}` and EOF each end a construct, and each must run the SAME checks in
  // the SAME order: the at-rule allow-list, then the declaration flush. These
  // were three hand-maintained copies, and a check present on one path and
  // absent from its twin shipped twice (round 12: EOF skipped the at-rule check;
  // round 13: `}` did) — sameness kept by attention failed every time it was
  // tried. A check added here reaches every terminator. What genuinely differs
  // between them stays at the call site and is stated there: `;` is not a
  // terminator inside ( ) or [ ]; `}` must first refuse an unmatched brace and
  // afterwards close its block; EOF must still check balance.
  const terminate = () => atRuleProblem(buf) || flush();

  for (let i = 0; i < css.length; i++) {
    const c = css[i];

    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      // A SPACE, not nothing: removing a comment must not weld its neighbours
      // into a token CSS never saw.
      if (end < 0) return { fatal: 'an unterminated /* comment — the rest of the file is inside it' };
      buf += ' ';
      i = end + 1;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < css.length; j++) {
        // CSS normalises CRLF to one newline before tokenizing, so a backslash
        // continues the string across BOTH characters. Skipping only the \r
        // left the \n to trip the unterminated check on a CRLF file.
        if (css[j] === '\\') { j += (css[j + 1] === '\r' && css[j + 2] === '\n') ? 2 : 1; continue; }   // CRLF is ONE newline
        if (css[j] === c) break;
        // CSS preprocessing turns a lone CR and a form feed into newlines, so
        // all three end an unescaped string. Recognising only \n let a CR-only
        // file run the "string" past a live override and exit 0 -- a silent
        // certification where the intended answer was a loud refusal.
        if (css[j] === '\n' || css[j] === '\r' || css[j] === '\f') {
          return { fatal: `an unterminated ${c === '"' ? 'double' : 'single'}-quoted string` };
        }
      }
      if (j >= css.length) return { fatal: `an unterminated ${c === '"' ? 'double' : 'single'}-quoted string` };
      buf += c + c;       // the string stays, its contents do not
      i = j;
      continue;
    }

    // See "NO ESCAPE DECODER" above. Outside a string or comment this is fatal.
    if (c === '\\') return { fatal: 'a backslash escape outside a string — spell identifiers and values plainly here' };

    // CDO/CDC. CSS discards these at the top level and carries on, so a file can
    // hide an at-rule behind one. Nothing in a token file needs them.
    if ((c === '<' && css.startsWith('<!--', i)) || (c === '-' && css.startsWith('-->', i))) {
      return { fatal: 'an HTML comment delimiter (<!-- or -->), which CSS discards and this check will not read around' };
    }

    // An UNQUOTED url() is its own tokenizer state, and the point of it is what
    // it does NOT recognise: inside the URL, `/*` is data, not a comment opener.
    // Bracket nesting alone protected the `;` and left this open, so `url(x/*)`
    // followed later by a real `*/` deleted everything between them — a live
    // override included — and the guard exited 0. Consume it here, to the first
    // unescaped `)`, with no comment or string scanning inside: that is the
    // whole state, and modelling it REMOVES two recognitions rather than adding
    // one. `url("…")` is a function token, not this — the quote is handled by
    // the string rule above, so only an unquoted first character takes this path.
    // The boundary matters: `myurl(` is an ordinary function and CSS does not
    // enter the URL state for it, but an unanchored match did — closing the
    // "URL" at a `)` inside a comment and recording the rest as declarations.
    // A name character is not the only prefix that swallows the ident, though,
    // and the fix that only excluded those left `#url(` entering a URL state
    // CSS never enters: `#url` is a single HASH token, so its `(` is an
    // ordinary paren. Rather than collect prefixes as they are found, take the
    // closed set from the tokenizer: the token types that consume an ident
    // sequence after a leading character are hash (`#`) and at-keyword (`@`);
    // everything else that continues an ident IS a name character. Those three
    // classes are the whole boundary. (A `\` prefix cannot reach here — an
    // escape outside a string is fatal above.) Excluding a prefix can only make
    // this MISS a url token, never invent one, and CSS produces none after
    // `#` or `@` — so the exclusion costs nothing it was reading correctly.
    // ROUND 7: the derivation above said "name character" and the class spelled
    // ASCII. CSS makes EVERY code point at U+0080 and above an identifier
    // character, so `éurl(` is one function token — this opened a URL state
    // inside it, closed at a `)` sitting in a comment, and red-built a valid
    // file. The class now says what that sentence always claimed.
    const urlOpen = (i === 0 || !/[A-Za-z0-9_@#\u0080-\uFFFF-]/.test(css[i - 1]))
    // ROUND 11: the quote lookahead must sit INSIDE it, not after a consuming
    // `\s*`. With `url( "x) y" )` the `\s*` ate the space, `(?!["'])` failed at
    // the quote, and the engine BACKTRACKED `\s*` to zero width — where the next
    // character is a space, not a quote, so the lookahead passed and a QUOTED
    // url was consumed as unquoted. The scanner then stopped at the `)` inside
    // the string and red-built a valid file on a nonexistent unterminated
    // string. Testing through the whitespace without consuming it first leaves
    // the engine nothing to backtrack over.
      ? /^url\((?![ \t\n\r\f]*["'])[ \t\n\r\f]*/i.exec(css.slice(i)) : null;
    if (urlOpen) {
      let j = i + urlOpen[0].length;
      for (; j < css.length; j++) {
        // A backslash here would be an escape outside a string, which the
        // shipped grammar refuses everywhere else. Consuming it silently made
        // url() an undocumented exception to the contract.
        if (css[j] === '\\') return { fatal: 'a backslash escape inside a url() — spell identifiers and values plainly here' };
        if (css[j] === ')') break;
      }
      if (j >= css.length) return { fatal: 'an unterminated url() token' };
      buf += 'url()';
      i = j;
      continue;
    }
    if (c === '(' || c === '[') { closers.push(c === '(' ? ')' : ']'); buf += c; continue; }
    if (c === ')' || c === ']') {
      // A non-matching top used to fall through and land in `buf`, so a stray
      // `)` left the stack empty at EOF and the file read as "balanced" — the
      // same underflow the closing brace already refuses, surviving in the two
      // bracket types nobody re-checked. Both terminators, one rule.
      if (closers[closers.length - 1] !== c) {
        return { fatal: `a closing ${c} with no matching open — the file does not parse as CSS` };
      }
      closers.pop(); buf += c; continue;
    }

    if (c === '{') {
      // ── DOES THIS BLOCK RECORD? ────────────────────────────────────────────
      // The only question left, after round 9 retired block classification (see
      // "WHERE A MEASURED TOKEN MAY LIVE" above): a block records iff it is a
      // `:root` rule opened at the STYLESHEET TOP LEVEL. Not inside a media
      // query, not inside a layer, not nested in another rule — because in
      // every one of those the declarations' applicability depends on something
      // this gate does not resolve.
      // A brace-valued CUSTOM PROPERTY is still refused outright: `--x: { … }`
      // is a legal value this cannot resolve, and unlike the cases above it is
      // not fixed by refusing to read the block, since the DECLARATION itself
      // is then unreadable.
      // TWO readings of the same text, and conflating them cost a debugging pass:
      // the DECLARATION NAME is what sits before a top-level colon, and the
      // SELECTOR is the whole prelude. For `:root {` the colon is at index 0, so
      // the name is empty and the selector is `:root` — read the name and this
      // rule never records.
      const declName = colonAt >= 0 ? cssTrim(buf.slice(0, colonAt)) : '';
      const selector = cssTrim(buf);
      if (declName.startsWith('--')) {
        return { fatal: `a custom property whose value is a { } block (\`${declName}\`) — this check cannot resolve one, and a token file does not need one` };
      }
      const isRootRule = depth === 0 && /^:root$/i.test(selector);
      const bad = atRuleProblem(buf);
      if (bad) return { fatal: bad };
      records.push(isRootRule);
      depth++;
      buf = ''; colonAt = -1;
      continue;
    }
    if (c === '}') {
      // An unmatched `}` used to pop an empty stack as a no-op, so a file that
      // closes more blocks than it opens reached the end balanced and exited 0
      // — contradicting the refusal this same function documents.
      if (depth === 0) return { fatal: 'a closing brace with no matching open — the file does not parse as CSS' };
      // Terminate BEFORE popping: the buffer belongs to the block being closed
      // (the last declaration may omit its `;`, and `.e { @whatever }` ends at
      // this brace), so its checks must run while that block's record is on top.
      const bad = terminate();
      if (bad) return { fatal: bad };
      records.pop();
      depth--;
      continue;
    }

    // Inside ( ) or [ ] a `;` is value text, not a terminator.
    if (c === ';' && closers.length === 0) {
      const bad = terminate();
      if (bad) return { fatal: bad };
      continue;
    }

    if (c === ':' && colonAt < 0 && closers.length === 0) colonAt = buf.length;
    buf += c;
  }
  // EOF is a terminator too: a trailing at-rule or declaration may omit its
  // optional `;`. It is not a character, so its fatal returns from the function
  // rather than from an iteration, and the balance check follows it.
  const trailing = terminate();
  if (trailing) return { fatal: trailing };
  if (closers.length > 0 || depth > 0) return { fatal: 'unbalanced brackets — the file does not parse as CSS' };
  return { decls };
}

let exitCode = 0;
for (const FILE of FILES) {
const scan = scanDeclarations(readFileSync(FILE, 'utf8'));
console.log(`\n── ${FILE}`);
if (scan.fatal) {
  console.error(`\ncheck-contrast: FAIL — ${FILE} contains ${scan.fatal}.`);
  console.error('  This gate refuses input it cannot read rather than measuring the part it');
  console.error('  can: a partial read of a palette produces a confident number about a');
  console.error('  colour the page may never render, which is the defect, not the fix.');
  exitCode = 1;
  continue;
}
const decls = scan.decls;   // name AS SPELLED -> [value, …] every declaration, in source order
const t = {};
// Validate and measure the HEX declarations. Non-hex values are RECORDED but not
// measured — they are never skipped, because the ambiguity check below fails on
// any measured token that carries one.
for (const [name, values] of Object.entries(decls)) {
  if (!name.startsWith('--color-')) continue;
  for (const hex of values) {
    if (!/^#[0-9a-fA-F]+$/.test(hex)) continue;
    if (![3, 4, 6, 8].includes(hex.length - 1)) {
      console.error(`check-contrast: ${name} has an invalid hex value "${hex}" (expected 3, 4, 6, or 8 digits)`);
      process.exit(1);
    }
    // ── Reject alpha, never drop it ────────────────────────────────────────────
    // A translucent colour has no contrast ratio of its own: it depends on
    // whatever is painted behind it at the point of use, which this script cannot
    // know. lum() used to drop the channel unconditionally, which scored a fully
    // transparent --color-on-accent: #FFFFFF00 as opaque white — 5.09, reported
    // OK, 9/9, exit 0, on button text that is invisible (claude.prop, 2026-08-23).
    // Compositing instead needs a background we do not have; inventing one is the
    // same confident-wrong-number defect pointed the other way. Refusing the input
    // is the only honest option, so this is fatal like the malformed-hex check
    // above, not a measurement failure.
    // Fully-opaque alpha (FF / F) is exempt: dropping THAT channel is exact rather
    // than an approximation, and design tools export #RRGGBBFF routinely.
    const digits = hex.slice(1);
    const alpha = digits.length === 4 ? digits[3].toLowerCase()
                : digits.length === 8 ? digits.slice(6).toLowerCase()
                : null;
    if (alpha !== null && alpha !== 'f' && alpha !== 'ff') {
      console.error(`check-contrast: ${name} carries an alpha channel ("${hex}") and cannot be measured.`);
      console.error('  A translucent colour has no contrast ratio of its own — it depends on');
      console.error('  whatever is painted behind it where it is used, and this script cannot');
      console.error('  know that. Dropping the channel scored a fully transparent #FFFFFF00 as');
      console.error('  opaque white: 5.09, "OK", on invisible text.');
      console.error('  Fix: declare an opaque #hex (or #RRGGBBFF) here. If the colour is purely');
      console.error('  decorative — a scrim or overlay that is never a text foreground and never');
      console.error('  a text background — declare it in rgba()/hsl() form, which this guardrail');
      console.error('  does not parse.');
      process.exit(1);
    }
    t[name] = hex;
  }
}

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function lum(hex) {
  let h = hex.replace('#', '');
  // Only FULLY OPAQUE alpha reaches here: the capture loop above rejects any
  // token whose alpha is not FF/F, so dropping the channel is exact, not an
  // approximation. That guard is the only thing keeping this true — a future
  // caller that reaches lum() without passing through it reintroduces the bug
  // where #FFFFFF00 scored as opaque white and certified invisible text.
  if (h.length === 4) h = h.slice(0, 3);
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };


// ── One token, two values: refuse, never pick one ──────────────────────────
// The capture loop keeps the LAST hex it sees and cannot see anything else, so
// a token declared twice was silently resolved to one of its declarations and
// the report claimed the file. Two shapes, one argument:
//   * hex then non-hex — `--color-accent: #1565C0` followed anywhere by
//     `--color-accent: rgb(255 255 255)`. CSS applies the rgb(); the gate
//     measured the hex. Reproduced on the shipped tokens.css by appending one
//     line: "OK — 9/9 assumed pairs meet WCAG AA", exit 0, on .btn rendering
//     white on white (#334).
//   * hex then a DIFFERENT hex — a second `:root`, a `[data-theme]` block, a
//     prefers-color-scheme media query. The gate measured whichever came last
//     and said nothing about the other theme.
// Which declaration wins is a cascade question — selector specificity, order,
// media context — and resolving it is the different, larger program this file's
// header already says nobody has written. So this is a refusal, like the
// malformed-hex and alpha branches above, not a measurement failure: picking
// either value produces a confident number about a colour the page may not
// render, which is the defect, not the fix.
// Scoped to MEASURED tokens on purpose. A token no pair reads can be declared
// per theme without this gate having an opinion — failing on it would red-build
// a valid palette to defend a number nobody computes.
const canon = (v) => {
  // cssTrim, not .trim(): the capture deliberately keeps a U+00A0 because CSS
  // reads it as part of a token, and trimming it HERE collapsed `#1565C0` and
  // `<NBSP>#1565C0` — a valid value and one CSS rejects — to the same hex, so
  // the ambiguity check saw one value and stayed silent about a live override.
  const raw = cssTrim(v);
  if (!/^#[0-9a-fA-F]+$/.test(raw)) return raw.toLowerCase().replace(/\s+/g, ' ');
  let h = raw.slice(1).toLowerCase();
  if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
  if (h.length === 8 && h.slice(6) === 'ff') h = h.slice(0, 6);   // matches the alpha exemption above
  return `#${h}`;
};
const ambiguous = [...MEASURED]
  .map((name) => [name, [...new Set((decls[name] || []).map(canon))]])
  .filter(([, vals]) => vals.length > 1);
if (ambiguous.length > 0) {
  console.error(`\ncheck-contrast: FAIL — ${FILE}: a measured token is declared more than once.`);
  for (const [name, vals] of ambiguous) console.error(`  ${name}: ${vals.join('  |  ')}`);
  console.error('  This script reads declarations, not the cascade: it cannot know which of');
  console.error('  these the page actually renders, and measuring one of them would certify a');
  console.error('  colour that may never appear. It refuses instead of guessing.');
  console.error('  Fix: declare each measured token exactly once in this file, in #hex form.');
  console.error('  If the project themes, give each theme its own tokens file holding that');
  console.error('  theme\'s resolved values, list every one (--tokens, CHECK_CONTRAST_TOKENS or');
  console.error('  CANDIDATES — see the top of this script), and let each be measured on its');
  console.error('  own — one palette per run, every one checked.');
  exitCode = 1;
  continue;
}

let failed = false;
let evaluated = 0;
for (const [fgName, bgName, thr, name] of pairs) {
  const fg = t[fgName], bg = t[bgName];
  if (!fg || !bg) { console.log(`  skip  ${name} (token missing)`); continue; }
  evaluated++;
  const r = ratio(fg, bg), ok = r >= thr;
  if (!ok) failed = true;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name.padEnd(30)} ${r.toFixed(2)} (need ${thr.toFixed(1)})`);
}

// A green report on zero evaluated pairs is the worst outcome available: it
// certifies WCAG AA having measured nothing. The token regex only reads #hex,
// so a tokens.css written in oklch()/rgb()/hsl()/var() skips every pair —
// exactly the palettes /design-intake now produces.
// ALL six pairs must be evaluable, not merely one. These are the standard token
// contract, and every pair is a required check — warning on a partial run let a
// palette be certified while normal-text contrast was never measured at all,
// which is the same vacuous pass as measuring nothing.
if (evaluated < pairs.length) {
  const missing = pairs.filter(([fg, bg]) => !t[fg] || !t[bg]).map(([, , , name]) => name);
  console.error(`\ncheck-contrast: FAIL — ${FILE}: only ${evaluated}/${pairs.length} pairs were evaluable.`);
  console.error(`  Not measured: ${missing.join('; ')}`);
  console.error('  Each needs both tokens declared in #hex form (oklch()/rgb()/hsl()/var()');
  console.error('  are not parsed). Declare the missing tokens, or extend this script.');
  // #328: say WHY a token is missing, because the two causes have different
  // fixes. A token that is NOT DECLARED AT ALL is what a hard-coded colour in
  // its role produces (`.btn { color: #fff }` over `var(--color-accent)` leaves
  // --color-on-accent undeclared), and the tempting response to a bare "7/9" is
  // an exception that keeps the literal and hides the finding. This gate reads
  // tokens, not components.css, so it cannot see the literal itself — it names
  // the pattern instead.
  const needed = [...new Set(pairs.filter(([fg, bg]) => !t[fg] || !t[bg]).flatMap(([fg, bg]) => [fg, bg]))];
  const undeclared = needed.filter((n) => !decls[n]);
  const notHex = needed.filter((n) => decls[n] && !t[n]);
  if (notHex.length) console.error(`  Declared, but not in #hex form: ${notHex.join(', ')}`);
  if (undeclared.length) {
    console.error(`  Not declared at all: ${undeclared.join(', ')}`);
    console.error('  If a stylesheet paints that role with a literal — e.g. `color: #fff` over');
    console.error('  `var(--color-accent)` — that is why. A hard-coded colour over a token background cannot be scored:');
    console.error('  declare a token for it and use var() there. Do not add an exception — that');
    console.error('  keeps the literal and hides the finding.');
  }
  exitCode = 1;
  continue;
}
// "OK" is scoped deliberately: the listed pairs passed. It is NOT a claim about
// the file — the pair list cannot see the roles this project actually gives its
// tokens (see the header). An unqualified "meets WCAG AA" in a CI log is a
// completeness this script has no basis for.
console.log(failed ? `check-contrast: FAIL — fix ${FILE}` : `check-contrast: OK — ${evaluated}/${pairs.length} assumed pairs meet WCAG AA in ${FILE}`);
if (!failed) console.log('        a floor, not a coverage report: pairs not listed, and tokens used in a role other than the one assumed, are NOT measured — read this script\'s header before trusting the count');
if (failed) exitCode = 1;
}
process.exit(exitCode);
