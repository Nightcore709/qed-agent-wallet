/**
 * Browser tests for the QED demonstration (QA: qed-qa-reliability). See e2e/README.md.
 *
 * - Runs the system Chrome (`channel: 'chrome'`); Playwright's own browsers are not downloaded.
 * - Starts its own Vite dev server on 127.0.0.1:5199. The orchestrator's server on 5174 is never touched.
 * - One retry, for one measured reason only: on this machine about 1 in 30 Chrome starts hangs at newContext/newPage
 *   (e2e/tools/launch-stress.ts: 5 of 160 attempts). A test that passes only on retry is reported as "flaky" in
 *   the list output and in results/summary.json; it is never counted as a clean pass.
 */
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

const PORT = 5199
const HERE = import.meta.dirname
const ARTIFACTS = join(HERE, 'e2e', 'results', 'artifacts')

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(ARTIFACTS, 'test-output'),
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  workers: 4,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: join(ARTIFACTS, 'report.json') }],
    ['html', { outputFolder: join(ARTIFACTS, 'html'), open: 'never' }],
    ['./e2e/summary-reporter.ts'],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    headless: true,
    // A hung Chrome launch fails in 60 s instead of the 180 s default.
    launchOptions: { timeout: 60_000 },
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    // A stale server on 5199 is an error, not something to reuse silently. Set QED_E2E_REUSE=1 to reuse one on purpose.
    reuseExistingServer: process.env.QED_E2E_REUSE === '1',
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
