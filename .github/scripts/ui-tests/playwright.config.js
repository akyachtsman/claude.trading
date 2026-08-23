// Playwright configuration template for static HTML apps.
// Copy to .github/scripts/ui-tests/playwright.config.js and customize.
// Replace all REPLACE_* placeholders before use.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: '../../../.agent-reports/playwright-results.json' }]],
  use: {
    baseURL: (process.env.APP_URL || 'https://akyachtsman.github.io/claude.trading/').replace(/\/?$/, '/'),
    /* Bounded actions: the default (0 = unlimited) lets one hung click run to
       the test timeout — an S3 sweep attempt burned 8 minutes that way on
       WebKit once the vendor widget frames hydrate mid-sweep and keep the
       network busy (qa-live run 113). 10s is generous for any real action. */
    actionTimeout: 10_000,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'on-first-retry',
  },
  outputDir: '../../../.agent-reports/screenshots',
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
      name: 'iphone',
      use: { ...devices['iPhone 12'] },
    },
  ],
});
