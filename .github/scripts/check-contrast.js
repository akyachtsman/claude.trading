'use strict';
// Per-project WCAG AA contrast guardrail. Reads this project's styles/tokens.css
// and checks the meaningful foreground/background pairs. Copy into the project's
// .github/scripts/ and run it from qa.yml. If styles/tokens.css doesn't exist yet
// (before /design-intake), it prints a notice and exits 0 — safe in a fresh repo.
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
const { readFileSync, existsSync, readdirSync } = require('fs');
const { join } = require('path');

// styles/tokens.css is the design contract's single home (design.md -> Tokens &
// components). Kept as a list so a project with a second token file can add it
// here; every candidate that exists is checked, never just the first.
const CANDIDATES = ['styles/tokens.css'];
const FILES = CANDIDATES.filter((f) => existsSync(f));
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
  const hasCssUnder = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.css')) return true;
      if (e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name)) {
        if (hasCssUnder(join(dir, e.name))) return true;
      }
    }
    return false;
  };
  const hasCss = hasCssUnder('.');
  if (!hasCss) {
    console.log(`::notice::no stylesheet yet — run /design-intake to establish this project's look. Skipping contrast check.`);
    process.exit(0);
  }
  console.error(`FAIL  this project has CSS but no tokens file at ${CANDIDATES.join(' or ')}.`);
  console.error('      design.md makes tokens.css the single source of truth — the contrast');
  console.error('      guardrail cannot run without it. Create one via /design-intake.');
  process.exit(1);
}

let exitCode = 0;
// Hoisted ABOVE the per-file loop (local change). These are pure — no FILE, no
// css, no token table — and the heatmap check at the bottom of this file needs
// ratio()/AA after the loop has closed. `pairs` stays inside, since it reads the
// per-file token table.
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

const AA = 4.5, AA_LARGE = 3.0;

for (const FILE of FILES) {
const css = readFileSync(FILE, 'utf8');
console.log(`\n── ${FILE}`);
const t = {};
// Capture every color token, then validate its hex length (3/4/6/8). A 5- or
// 7-digit value is malformed: fail loudly rather than silently skip it — a
// tighter regex that just doesn't match would drop the token from the checks
// below and pass green, hiding the bad declaration instead of catching it.
for (const m of css.matchAll(/(--color-[a-z-]+)\s*:\s*(#[0-9a-fA-F]+)\s*;/g)) {
  const [, name, hex] = m;
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

const pairs = [
  // No `|| '#FFFFFF'` fallback: substituting a default made the pair "evaluable"
  // while measuring a colour the page may not use, so a project that DROPPED the
  // token still scored 8/8. A missing required token must fail like any other.
  [t['--color-on-accent'], t['--color-accent'], AA, 'on-accent / accent (button)'],
  [t['--color-text-primary'], t['--color-bg'], AA, 'text-primary / bg'],
  [t['--color-text-primary'], t['--color-surface'], AA, 'text-primary / surface'],
  [t['--color-text-secondary'], t['--color-bg'], AA, 'text-secondary / bg'],
  [t['--color-text-secondary'], t['--color-surface'], AA, 'text-secondary / surface'],
  // Both button templates render the on-accent foreground over accent-hover on
  // hover (and the static one on keyboard focus), so the hover background is a
  // real background for this text and needs its own pair. Checking only the
  // resting state passed themes that go nearly-black-on-dark the moment a
  // pointer touches the control.
  [t['--color-on-accent'], t['--color-accent-hover'], AA, 'on-accent / accent-hover (button hover)'],
  [t['--color-accent'], t['--color-surface'], AA_LARGE, 'accent / surface (large)'],
  // design.md's error-message copy rule creates --color-danger; it carries meaning,
  // so it needs the same AA floor as any other body text.
  [t['--color-danger'], t['--color-surface'], AA, 'danger / surface'],
  [t['--color-danger'], t['--color-bg'], AA, 'danger / bg'],
];

let failed = false;
let evaluated = 0;
for (const [fg, bg, thr, name] of pairs) {
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
  const missing = pairs.filter(([fg, bg]) => !fg || !bg).map(([, , , name]) => name);
  console.error(`\ncheck-contrast: FAIL — ${FILE}: only ${evaluated}/${pairs.length} pairs were evaluable.`);
  console.error(`  Not measured: ${missing.join('; ')}`);
  console.error('  Each needs both tokens declared in #hex form (oklch()/rgb()/hsl()/var()');
  console.error('  are not parsed). Declare the missing tokens, or extend this script.');
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
// ── PROJECT CHECK: heatmap tile labels ──────────────────────────────────────
// Heatmap tile labels sit on a DYNAMIC piecewise colour ramp (owner directive
// 2026-07-12), so there is no static background to measure them against. AA is
// carried by a solid halo stroke painted under every glyph
// (`paint-order: stroke`, finviz-style), making the real contrast pair
// HEAT.ink vs HEAT.halo. Upstream's template cannot carry this check, which is
// why a verbatim install silently deleted it (Codex P2, #283).
//
// ⚠️ THIS IS THE FOURTH IMPLEMENTATION AND THE FIRST CORRECT ONE. The three
// before it asked the source questions with regexes and a hand-rolled scanner,
// and Codex found eight separate ways for valid JavaScript to satisfy the text
// while the rendered labels lost their halo — or, by the last round, for valid
// code to be REJECTED. In order:
//   1  a loose /paint-order/ matched the explanatory COMMENT beside the attribute
//   2  ink/halo and paint-order matched anywhere in the file, so a decoy object
//      or a second renderer satisfied them
//   3  a renderer line prefixed with `//` still contained all three strings
//   4  ink/halo nested under `palette: {…}` matched, while HEAT.ink was undefined
//   5  `  const HEAT = {` indented one level matched nothing and SKIPPED, exiting 0
//   6  `#23262D00` (transparent) measured 15.14 — the alpha guard was bypassed,
//      verbatim the claude.prop 2026-08-23 defect lum() warns about
//   7  a string payload `note: "ink: '#FFFFFF'"` was read as a property
//   8  a duplicate `ink:` was read first-wins where JavaScript takes the LAST
// Every fix moved the fail-open instead of closing it, and round four added the
// opposite failure — `console.log(HEAT.ink)` in a debug helper read as a
// renderer missing its halo. That is what an approximation looks like when it is
// pushed past its limit in both directions at once.
//
// THE ROOT CAUSE, stated once: "is this property actually set on this object"
// and "does this object literal paint a label" are questions about program
// SEMANTICS. Text matching cannot answer them, so no amount of tightening ever
// would have. This now parses with acorn and walks the AST, where each question
// has an exact answer and none of the eight evasions is expressible:
//   * duplicates resolve LAST, because that is what JavaScript does;
//   * a string is a Literal value, never a Property;
//   * a nested object's properties are not HEAT's properties;
//   * a paint site is a Property whose VALUE is HEAT.ink — a call argument is not;
//   * comments and regex literals are the lexer's problem, not ours.
//
// COST, stated because it is a real trade: static-checks now installs
// .github/scripts deps (acorn, one package, no transitive deps) before running
// this, taking the job from ~7s to ~20s. That is the price of a gate that
// answers the question it claims to. If acorn is unresolvable the check REFUSES
// LOUDLY rather than falling back to pattern matching — a fallback would restore
// exactly the eight holes above, on the day the install breaks.
//
// REMAINING CEILING: this proves the SOURCE says the right thing, not that the
// browser painted it. The durable form reads computed fill/stroke/paint-order
// off rendered tiles in the Playwright suite. Follow-up, not scope-crept here.
const APP = 'scripts/app.js';
if (existsSync(APP)) {
  const bail = (...msg) => {
    console.error('\nFAIL  heatmap label ink / halo — CANNOT CHECK');
    msg.forEach((m) => console.error('      ' + m));
    console.error('      This gate is the ONLY thing asserting the heatmap labels meet AA.');
    console.error('      Repair it rather than deleting it.');
    exitCode = 1;
  };

  let acorn = null;
  try { acorn = require('acorn'); } catch { /* handled below */ }

  if (!acorn) {
    bail('acorn is not resolvable from .github/scripts.',
         'Run `npm ci` there (qa.yml does this before calling this script).',
         'Refusing rather than falling back to regex: the pattern-matching versions',
         'of this check had eight separate fail-opens, all found in review.');
  } else {
    let ast = null;
    try {
      ast = acorn.parse(readFileSync(APP, 'utf8'), { ecmaVersion: 'latest', sourceType: 'script', locations: true });
    } catch (e) {
      bail(`${APP} does not parse: ${e.message}`);
    }
    if (ast) {
      // ── walk ────────────────────────────────────────────────────────────────
      const walk = (node, fn, parent = null) => {
        if (!node || typeof node.type !== 'string') return;
        fn(node, parent);
        for (const k of Object.keys(node)) {
          if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, fn, node));
          else if (v && typeof v.type === 'string') walk(v, fn, node);
        }
      };
      const keyName = (p) => (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null);
      const isHeatMember = (n, prop) =>
        n && n.type === 'MemberExpression' && !n.computed &&
        n.object.type === 'Identifier' && n.object.name === 'HEAT' &&
        n.property.type === 'Identifier' && n.property.name === prop;

      // ── the HEAT object literal ─────────────────────────────────────────────
      const heats = [];
      walk(ast, (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'HEAT'
            && n.init && n.init.type === 'ObjectExpression') heats.push(n.init);
      });

      if (heats.length === 0) {
        console.log('\n  skip  heatmap label ink / halo — no HEAT object literal in scripts/app.js');
      } else if (heats.length > 1) {
        bail(`${heats.length} HEAT object literals found; expected exactly 1.`);
      } else {
        // DIRECT properties, LAST wins — JavaScript's own rule for duplicate keys.
        const direct = (name) => {
          let hex = null, dup = 0;
          for (const p of heats[0].properties) {
            if (p.type !== 'Property' || p.computed || keyName(p) !== name) continue;
            dup++;
            hex = p.value.type === 'Literal' && typeof p.value.value === 'string' ? p.value.value : null;
          }
          return { hex, dup };
        };
        // Same alpha rule as the token loop above: a translucent colour has no
        // contrast ratio of its own, and lum() drops the channel.
        const badHex = (h, label) => {
          if (h === null) return `${label} is not a string literal on HEAT`;
          if (!/^#[0-9a-fA-F]+$/.test(h)) return `${label} is "${h}", not a #hex colour`;
          const d = h.slice(1);
          if (![3, 4, 6, 8].includes(d.length)) return `${label} "${h}" is not 3, 4, 6 or 8 hex digits`;
          const a = d.length === 4 ? d[3].toLowerCase() : d.length === 8 ? d.slice(6).toLowerCase() : null;
          if (a !== null && a !== 'f' && a !== 'ff') return `${label} "${h}" carries alpha and cannot be measured`;
          return null;
        };

        const ink = direct('ink'), halo = direct('halo');
        const problems = [badHex(ink.hex, 'HEAT.ink'), badHex(halo.hex, 'HEAT.halo')].filter(Boolean);

        // ── paint sites: an object literal with a Property whose VALUE is
        //    HEAT.ink. A call argument, a variable init or a debug log is not a
        //    paint site and is left alone.
        const sites = [];
        walk(ast, (n, parent) => {
          if (!isHeatMember(n, 'ink')) return;
          if (!parent || parent.type !== 'Property' || parent.value !== n) return;
          let obj = null;
          walk(ast, (m) => { if (m.type === 'ObjectExpression' && m.properties.includes(parent)) obj = m; });
          if (!obj) return;
          const props = obj.properties.filter((p) => p.type === 'Property' && !p.computed);
          const haloed = props.some((p) => isHeatMember(p.value, 'halo'));
          const order = props.some((p) => keyName(p) === 'paint-order'
            && p.value.type === 'Literal' && p.value.value === 'stroke');
          sites.push({ line: n.loc.start.line, haloed, order });
        });
        const naked = sites.filter((s) => !s.haloed || !s.order);

        if (problems.length || ink.dup > 1 || halo.dup > 1 || sites.length === 0 || naked.length) {
          console.error('\nFAIL  heatmap label ink / halo — the AA mechanism is incomplete');
          problems.forEach((m) => console.error('      ' + m));
          if (ink.dup > 1) console.error(`      HEAT.ink is declared ${ink.dup} times — JavaScript takes the last; remove the duplicates`);
          if (halo.dup > 1) console.error(`      HEAT.halo is declared ${halo.dup} times — JavaScript takes the last; remove the duplicates`);
          if (sites.length === 0) {
            console.error('      No object literal paints with HEAT.ink, so the pair below would');
            console.error('      measure a colour the page never renders.');
          }
          naked.forEach((s) => console.error(
            `      scripts/app.js:${s.line} paints with HEAT.ink but is missing ` +
            [!s.haloed && 'stroke: HEAT.halo', !s.order && "'paint-order': 'stroke'"].filter(Boolean).join(' and ')));
          console.error('      The tile ramp is dynamic, so the halo stroke IS the AA mechanism here.');
          exitCode = 1;
        } else {
          const r = ratio(ink.hex, halo.hex), ok = r >= AA;
          if (!ok) exitCode = 1;
          console.log(`\n${ok ? '  ok' : 'FAIL'}  ${'heatmap label ink / halo'.padEnd(30)} ${r.toFixed(2)} (need ${AA.toFixed(1)})`);
        }
      }
    }
  }
}

process.exit(exitCode);
