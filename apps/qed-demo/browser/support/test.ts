/**
 * The browser suite's `test`: Playwright's, with two rules every journey follows automatically
 * (docs/research/qed-qa-reliability/20261124-suite-reliability.md).
 *
 * 1. A browser context that a test opens itself with `browser.newContext()` (a second household, another device, a
 *    contact's phone) and leaves open is closed when that test ends, as Playwright's own `context` fixture closes the
 *    context it made. Playwright 1.64 closes only the contexts its `context` fixture created. Left open, such a context
 *    stayed open for the rest of the worker's life: Playwright stops tracing it when the test ends and starts tracing
 *    it again when each later test in the worker starts (node_modules/playwright/lib/index.js, ArtifactsRecorder
 *    willStartTest and didFinishTest), and its page keeps running the app. About 32 such contexts were left open in
 *    every full run, so the journeys late in a run (vault-signers ran 41st of 44 when it timed out on 24 Nov) ran in
 *    browsers carrying many live, traced pages.
 *
 * 2. Before a worker's first journey, its browser must open a blank page within START_CHECK_MS. A browser that does not
 *    is closed and one replacement is launched with the same options; the event is written to stderr and to
 *    browser-start-checks.log in the run's output folder, so a run's evidence says when it happened. If the
 *    replacement does not open a page either, the worker fails with that reason. No journey's checks or time limits
 *    change, and no test is run twice: nothing of QED has been opened in a browser at this point.
 *
 * Every spec imports `test` and `expect` from here; server/browser-suite.test.ts fails if one imports them from
 * '@playwright/test' instead.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { test as base } from '@playwright/test'
import { opensPageWithin } from './browser-check.ts'

/** Opening a context and a blank page takes well under a second here, and some seconds at the heaviest load measured. */
export const START_CHECK_MS = 60_000

export const test = base.extend<{ closeContextsLeftOpen: void }>({
  browser: [async ({ browser, playwright, browserName }, use, workerInfo) => {
    if (await opensPageWithin(browser, START_CHECK_MS)) { await use(browser); return }
    const record = (line: string): void => {
      const text = `${new Date().toISOString()} worker ${workerInfo.workerIndex}: ${line} (load averages ${loadavg().map((l) => l.toFixed(2)).join(' ')})`
      console.error(`[browser start check] ${text}`)
      try { mkdirSync(workerInfo.project.outputDir, { recursive: true }); appendFileSync(join(workerInfo.project.outputDir, 'browser-start-checks.log'), `${text}\n`) } catch { /* the message on stderr stands */ }
    }
    record(`the launched browser did not open a blank page within ${START_CHECK_MS / 1000} s; closing it and launching one replacement`)
    await browser.close({ reason: 'It did not open a blank page after launch.' }).catch(() => undefined)
    const replacement = await playwright[browserName].launch()
    if (!(await opensPageWithin(replacement, START_CHECK_MS))) {
      record('the replacement did not open a blank page either; the worker stops here')
      await replacement.close().catch(() => undefined)
      throw new Error(`Two browsers in a row did not open a blank page within ${START_CHECK_MS / 1000} s of launch. That is this machine (load, memory), not QED: no QED page had been opened.`)
    }
    record('the replacement opened a blank page; the journeys run in it')
    await use(replacement)
    await replacement.close({ reason: 'Test ended.' })
  }, { scope: 'worker', timeout: 0 }],

  closeContextsLeftOpen: [async ({ browser }, use) => {
    const before = new Set(browser.contexts())
    await use()
    // the contexts this test opened and did not close; closing one stops its trace and, if the test failed, keeps its
    // screenshot first (Playwright's willCloseBrowserContext), exactly as for the context fixture's own context
    const leftOpen = browser.contexts().filter((c) => !before.has(c))
    await Promise.all(leftOpen.map((c) => c.close({ reason: 'The test that opened this context ended.' }).catch(() => undefined)))
  }, { auto: true, title: 'close the contexts the test left open' }],
})

export { expect } from '@playwright/test'
export type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
