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
