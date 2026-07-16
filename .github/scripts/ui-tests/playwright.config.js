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
