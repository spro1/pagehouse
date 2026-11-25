// Browser tests against a running Pagehouse (BASE_URL), signed in as E2E_EMAIL / E2E_PASSWORD.
// CI runs them against the real container after an upgrade (see e2e/upgrade.sh).
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
