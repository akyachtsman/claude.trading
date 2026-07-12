'use strict';
// Per-project WCAG AA contrast guardrail. Reads this project's styles/tokens.css
// and checks the meaningful foreground/background pairs. Copy into the project's
// .github/scripts/ and run it from qa.yml. If styles/tokens.css doesn't exist yet
// (before /design-intake), it prints a notice and exits 0 — safe in a fresh repo.
// CommonJS (matches the other .github/scripts/ helpers, e.g. notify-email.js).
const { readFileSync, existsSync } = require('fs');

const FILE = 'styles/tokens.css';
if (!existsSync(FILE)) {
  console.log(`::notice::${FILE} not found — run /design-intake to establish this project's look. Skipping contrast check.`);
  process.exit(0);
}

const css = readFileSync(FILE, 'utf8');
const t = {};
for (const m of css.matchAll(/(--color-[a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) t[m[1]] = m[2];

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
function lum(hex) {
  let h = hex.replace('#', '');
  // The token regex admits #RGBA / #RRGGBBAA — drop the alpha channel so the
  // channel pairs below stay aligned (alpha-blended contrast isn't computed here).
  if (h.length === 4) h = h.slice(0, 3);
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
}
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

const AA = 4.5, AA_LARGE = 3.0;
const pairs = [
  ['#FFFFFF', t['--color-accent'], AA, 'white / accent (button)'],
  [t['--color-text-primary'], t['--color-bg'], AA, 'text-primary / bg'],
  [t['--color-text-primary'], t['--color-surface'], AA, 'text-primary / surface'],
  [t['--color-text-secondary'], t['--color-bg'], AA, 'text-secondary / bg'],
  [t['--color-text-secondary'], t['--color-surface'], AA, 'text-secondary / surface'],
  [t['--color-accent'], t['--color-surface'], AA_LARGE, 'accent / surface (large)'],
];

let failed = false;
for (const [fg, bg, thr, name] of pairs) {
  if (!fg || !bg) { console.log(`  skip  ${name} (token missing)`); continue; }
  const r = ratio(fg, bg), ok = r >= thr;
  if (!ok) failed = true;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name.padEnd(30)} ${r.toFixed(2)} (need ${thr.toFixed(1)})`);
}
// Heatmap tile labels are consistently white over a DYNAMIC piecewise ramp
// (owner directive 2026-07-12); AA is carried by the solid halo stroke painted
// under every glyph (paint-order:stroke in heatText), finviz-style — so the
// glyph's contrast pair is HEAT.ink vs HEAT.halo, independent of tile color.
// Parse both from scripts/app.js and assert that pair. Skips cleanly if the
// panel is absent.
const APP = 'scripts/app.js';
if (existsSync(APP)) {
  const app = readFileSync(APP, 'utf8');
  const hex = (k) => { const m = app.match(new RegExp(k + ":\\s*'(#[0-9a-fA-F]{6})'")); return m ? m[1] : null; };
  const ink = hex('ink'), halo = hex('halo');
  const haloed = /paint-order/.test(app);
  if (ink && halo && haloed) {
    const r = ratio(ink, halo), ok = r >= AA;
    if (!ok) failed = true;
    console.log(`${ok ? '  ok' : 'FAIL'}  ${'heatmap label ink / halo'.padEnd(30)} ${r.toFixed(2)} (need ${AA.toFixed(1)})`);
  } else if (ink || halo) {
    failed = true;
    console.log(`FAIL  heatmap label ink / halo — HEAT.ink/HEAT.halo/paint-order incomplete in scripts/app.js`);
  } else {
    console.log('  skip  heatmap label ink / halo — HEAT constants not found in scripts/app.js');
  }
}

console.log(failed ? '\ncheck-contrast: FAIL — fix styles/tokens.css' : '\ncheck-contrast: OK — all pairs meet WCAG AA');
if (failed) process.exit(1);
