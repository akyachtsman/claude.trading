// Playwright configuration template for static HTML apps.
// Copy to .github/scripts/ui-tests/playwright.config.js and customize.
// Replace all REPLACE_* placeholders before use.

import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Failure screenshots land where the ui-suite composite's upload step looks for
// them: `.agent-reports/screenshots/` at the WORKSPACE root. Derived from
// GITHUB_WORKSPACE when it is set (every CI job), never from this file's depth:
// a hard-coded `../../../` is right only when the kit sits exactly at
// .github/scripts/ui-tests/, and a moved UI_TESTS_DIR (cicd-setup.md Step 2
// allows it) wrote the screenshots outside the workspace, where upload-artifact
// only warns and the artifact silently omits them (audit 2026-10-11, M-10). The
// relative form remains the local fallback, for a hand run from the shipped path.
const SCREENSHOT_DIR = process.env.GITHUB_WORKSPACE
  ? join(process.env.GITHUB_WORKSPACE, '.agent-reports', 'screenshots')
  : '../../../.agent-reports/screenshots';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  // LOCAL ADDITION: scenario-title exclusion, set by qa.yml's ui-tests job env
  // (`GREP_INVERT: live only`) — the ui-suite composite is a verbatim upstream
  // drop-in with no such input. Unset = run everything. 'i' matches the CLI's
  // --grep-invert, which is what qa.yml used to pass through the composite.
  grepInvert: process.env.GREP_INVERT ? new RegExp(process.env.GREP_INVERT, 'i') : undefined,
  reporter: [['list'], ['json', { outputFile: '../../../.agent-reports/playwright-results.json' }]],
  use: {
    baseURL: (process.env.APP_URL || 'https://akyachtsman.github.io/claude.trading/').replace(/\/?$/, '/'),
    /* Bounded actions: the default (0 = unlimited) lets one hung click run to
       the test timeout — an S3 sweep attempt burned 8 minutes that way on
       WebKit once the vendor widget frames hydrate mid-sweep and keep the
       network busy (qa-live run 113). 10s is generous for any real action. */
    actionTimeout: 10_000,
    /* The OTHER half of the same guard, and it was missing here while
       actionTimeout was not. Navigation defaults to 0 = NO timeout, so a hung
       goto() runs to the test timeout exactly as the hung click above did —
       which makes every per-scenario budget arithmetic over an unbounded term.
       A guard that fails open is indistinguishable from one that passes. */
    navigationTimeout: 30_000,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'on-first-retry',
  },
  outputDir: SCREENSHOT_DIR,
  projects: [
    // Desktop first. global.md requires laptop + tablet + phone coverage, and a
    // device-emulated project has a FIXED viewport, so neither 1440x900 nor any
    // explicit resize is reachable from one. Until 2026-08-22 this matrix was
    // Pixel 5 + iPhone 12 — both PHONES — so two of the three required classes
    // had no project at all. A viewport that is never instantiated produces no
    // failing test, which is why the suite stayed green while telling us nothing
    // about them.
    //
    // 1440 matters specifically here: this project's widest tier is gated at
    // min-width 1400 (the three-across desk row) and the desk row itself at
    // 1120. Neither had ever been rendered by a test.
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // Tablet is its own class, not an interpolation between the other two.
      //
      // PORTRAIT, and the orientation is the whole point: this entry is 810
      // wide, while the landscape variant is 1080. Checked against THIS
      // project's breakpoints rather than the template's assumed 1023 band —
      // ours are 1120 (desk row stacks) and 1400 (three-across), with mid-tier
      // rules at 860/900/1119. So 810 lands in a genuine tablet band, distinct
      // from the 390-wide phones and from 1440 desktop, and cannot masquerade
      // as either. Do not switch this to landscape without re-checking those
      // numbers.
      name: 'tablet',
      use: { ...devices['iPad (gen 7)'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      // WebKit, the engine of every iPhone browser, and the only WebKit project
      // here: keep it (test.md → UI coverage gates, *Overlays fit and scroll*).
      // A Chromium phone profile does not stand in for it.
      name: 'iphone',
      use: { ...devices['iPhone 12'] },
    },
  ],
});
