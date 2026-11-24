/**
 * Whether a freshly launched browser can open a context and a blank page within a bound. Used by support/test.ts before
 * a worker's first journey: on this shared machine Chrome twice hung for minutes on its very first context or page while
 * macOS was reclaiming memory (24 Nov, 13:04 and 13:27 IST: the kernel was ending idle system services, among them
 * secinitd and amfid, once a second), and no journey can pass in a browser that never opens a page.
 * Kept free of the Playwright runner so the unit tests can drive it with a stand-in browser.
 */
import type { Browser } from '@playwright/test'

export type Opener = Pick<Browser, 'newContext'>

/** True when `browser` opens a context and a page within `ms`, closing them again; false on a timeout or an error. */
export async function opensPageWithin(browser: Opener, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms) })
  const probe = (async (): Promise<true> => {
    const context = await browser.newContext()
    try { await context.newPage() } finally { await context.close() }
    return true
  })()
  probe.catch(() => undefined) // a probe still waiting on a hung browser fails later, when that browser is closed
  try { return await Promise.race([probe, deadline]) } catch { return false } finally { clearTimeout(timer) }
}
