/**
 * The R7 browser suite (R7-101): every journey driven through the built interface of an isolated stack, with what the
 * screen shows compared against the stack's own database, engine and (later) chain. Run:
 *
 *   npm run build && npx playwright test -c browser/playwright.config.ts
 *
 * Uses the system Chrome. Two more projects, Firefox and WebKit (Playwright's own builds: `npx playwright install firefox webkit`,
 * about 110 MB and 82 MB to download, 294 MB and 297 MB on disk), run only the journeys in tests/cross-browser.spec.ts: those that need no
 * passkey. Passkey journeys stay on Chromium, which has the virtual authenticator (CDP's WebAuthn domain).
 * Run one project with `--project=firefox`. Tests create their own fresh accounts with a virtual passkey authenticator, so they can run
 * side by side on one stack, which is also how concurrent users are exercised. Specs take `test` from
 * support/test.ts, which closes the browser contexts a test opened and left open when that test ends (left open, they
 * stayed live and were traced again by every later test in the worker; docs/research/qed-qa-reliability/
 * 20261124-suite-reliability.md).
 */
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { BASE } from './support/stack.ts'

/** The journeys that run on Firefox and WebKit as well as Chrome: none of them needs a passkey. */
const CROSS = /cross-browser\.spec\.ts$/

export default defineConfig({
  testDir: join(import.meta.dirname, 'tests'),
  testMatch: /.*\.spec\.ts$/,
  outputDir: join(import.meta.dirname, 'results', 'output'),
  globalSetup: join(import.meta.dirname, 'support', 'setup.ts'),
  globalTeardown: join(import.meta.dirname, 'support', 'teardown.ts'),
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 3,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: join(import.meta.dirname, 'results', 'report.json') }]],
  use: { baseURL: BASE, headless: true, viewport: { width: 1280, height: 860 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'firefox', testMatch: CROSS, use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 860 } } },
    { name: 'webkit', testMatch: CROSS, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 } } },
  ],
})
