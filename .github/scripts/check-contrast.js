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
// Heatmap tile labels use an ink-flip (white↔black) over a DYNAMIC piecewise
// ramp (HEAT.stops in scripts/app.js) — colors the token pairs above can't
// see. Re-derive the ramp here and assert the best-available ink clears AA
// across the whole range. The flat color IS the glyph background: labeled
// tiles carry no bevel overlay (drawTiles applies the vignette only to tiles
// too small for a label). Skips cleanly if the panel is absent.
const APP = 'scripts/app.js';
if (existsSync(APP)) {
  const app = readFileSync(APP, 'utf8');
  const stopsM = app.match(/stops:\s*\[([\s\S]*?)\]\s*,\s*\n\s*cap:/);
  const stops = stopsM
    ? [...stopsM[1].matchAll(/\[\s*(-?\d+(?:\.\d+)?)\s*,\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*\]/g)]
        .map((m) => [parseFloat(m[1]), [+m[2], +m[3], +m[4]]])
    : null;
  if (stops && stops.length >= 2) {
    const lumRGB = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const heatRGB = (p) => {
      p = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], p));
      let i = 0;
      while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
      const [p0, c0] = stops[i], [p1, c1] = stops[i + 1];
      const t = (p - p0) / (p1 - p0);
      return c0.map((c, k) => c + (c1[k] - c) * t);
    };
    // Best ink = max(white, black) contrast — the same flip heatInk applies.
    const bestInk = (rgb) => { const L = lumRGB(rgb); return Math.max(1.05 / (L + 0.05), (L + 0.05) / 0.05); };
    const lo = stops[0][0], hi = stops[stops.length - 1][0];
    let worst = Infinity, worstPct = 0;
    for (let p = lo; p <= hi + 1e-9; p += (hi - lo) / 120) {
      const r = bestInk(heatRGB(p));
      if (r < worst) { worst = r; worstPct = p; }
    }
    const ok = worst >= AA;
    if (!ok) failed = true;
    console.log(`${ok ? '  ok' : 'FAIL'}  ${'heatmap label ink (ramp)'.padEnd(30)} ${worst.toFixed(2)} (need ${AA.toFixed(1)}, worst @ ${worstPct.toFixed(2)}%)`);
  } else {
    console.log('  skip  heatmap label ink (ramp) — HEAT.stops not found in scripts/app.js');
  }
}

console.log(failed ? '\ncheck-contrast: FAIL — fix styles/tokens.css' : '\ncheck-contrast: OK — all pairs meet WCAG AA');
if (failed) process.exit(1);
