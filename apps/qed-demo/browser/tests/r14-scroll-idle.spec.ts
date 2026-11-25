/**
 * R14 (owner, 26 Nov 2026): Home jumped back to the top, with a twitch, after being scrolled and left alone. A page that
 * is scrolled and idle through a data refresh and a clock tick keeps its scroll position, on every main screen. The
 * test scrolls, waits past the 30 s clock and a forced refresh of every data topic, and watches every scroll event, so
 * a jump up and back (the twitch) fails too.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_R14_SCROLL_PORT ?? extraPort(114))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

async function newOwner(page: Page): Promise<void> {
  const handle = `sc${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

const SCREENS = ['/', '/save', '/pay', '/holdings', '/earn', '/activity', '/protect']

test('a scrolled page stays where it is through a clock tick and a data refresh', async ({ page }) => {
  test.setTimeout(600_000)
  await addAuthenticator(page)
  await newOwner(page)
  for (const path of SCREENS) {
    await page.goto(`${s.base}${path}`)
    await page.locator('main h1, main h2').first().waitFor()
    await page.waitForTimeout(1500)
    const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
    if (room < 200) { test.info().annotations.push({ type: 'short', description: `${path}: only ${room}px to scroll` }); continue }
    const target = Math.min(400, room - 50)
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), target) // instant: a smooth scroll would log its own steps
    await page.waitForTimeout(600)
    await page.evaluate(() => {
      ;(window as unknown as { __ys: number[] }).__ys = []
      addEventListener('scroll', () => (window as unknown as { __ys: unknown[] }).__ys.push(`y=${scrollY} h=${document.documentElement.scrollHeight}`))
    })
    // 30 s of idleness, with a refresh of the page's own data half way (the same call a pushed event makes)
    await page.waitForTimeout(16_000)
    await page.evaluate(() => { void fetch('/api/home'); dispatchEvent(new Event('online')) })
    await page.waitForTimeout(16_000)
    const seen = await page.evaluate(() => ({ y: scrollY, ys: (window as unknown as { __ys: unknown[] }).__ys as string[] }))
    expect(seen.ys.filter((e) => Math.abs(Number(/y=([\d.]+)/.exec(e)![1]) - target) > 2), `${path}: scroll positions seen while idle`).toEqual([])
    expect(Math.abs(seen.y - target), `${path}: scrollY after 32 s idle`).toBeLessThanOrEqual(2)
  }
})
