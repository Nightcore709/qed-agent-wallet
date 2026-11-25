/**
 * R14 Activity (owner, 26 Nov 2026): the page opens on its folders and stays there (no older layout that switches to the
 * filter-first one once the rows arrive, even on a slow connection), the filters sit on one baseline and no label or
 * field overlaps another, the amount and dates are behind "More filters", and the folders and the day book each take
 * keyboard focus with a visible ring. A hold-to-confirm or any button here is presentation only; it never authorises.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_R14_ACTIVITY_PORT ?? extraPort(116))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

async function newOwner(page: Page): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`ac${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('Activity opens on its folders without a flash, and its filters do not overlap', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  await newOwner(page)

  // a slow connection: the rows arrive 2.5 s late; at no frame before then, or after, is the day book's layout drawn
  await page.route('**/api/activity*', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue() })
  await page.addInitScript(() => {
    ;(window as unknown as { __seen: string[] }).__seen = []
    const look = () => { const w = window as unknown as { __seen: string[] }; if (document.querySelector('.ac-book, .ac-skel, .ac-none, .ac-count')) w.__seen.push('list-layout'); requestAnimationFrame(look) }
    requestAnimationFrame(look)
  })
  for (const how of ['direct', 'reload'] as const) {
    if (how === 'direct') await page.goto(`${s.base}/activity`); else await page.reload()
    await expect(page.getByRole('heading', { name: 'Your records, filed' })).toBeVisible()
    await page.waitForTimeout(3500)
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen), `${how}: the list's layout was drawn`).toEqual([])
    // the folders are the first thing under the heading: nothing but the one-line bar comes before them
    const order = await page.evaluate(() => { const y = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? 1e9; return { find: y('.ac-find'), shelf: y('.fold-shelf, [aria-label="Your records, filed"]') } })
    expect(order.shelf).toBeGreaterThan(order.find)
  }
  await page.unroute('**/api/activity*')

  // client-side navigation to Activity: the same
  await page.goto(`${s.base}/`)
  await page.evaluate(() => { (window as unknown as { __seen: string[] }).__seen = [] })
  await page.getByRole('link', { name: 'Activity', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Your records, filed' })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen), 'client-side navigation: the list layout was drawn').toEqual([])

  for (const w of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.goto(`${s.base}/activity?view=list`)
    await page.getByRole('button', { name: /^Filters/ }).click()
    await expect(page.getByRole('group', { name: 'Filter the day book' })).toBeVisible()
    // the amount and the dates are behind "More filters"
    await expect(page.getByRole('group', { name: 'Narrow by amount and dates' })).toBeHidden()
    await page.getByRole('button', { name: 'More filters' }).click()
    await expect(page.getByRole('group', { name: 'Narrow by amount and dates' })).toBeVisible()
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.ac-find label, .ac-find legend, .ac-find input, .ac-find select, .ac-find button')]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => { const r = e.getBoundingClientRect(); return { n: `${e.tagName.toLowerCase()} ${(e.textContent || (e as HTMLInputElement).id || '').trim().slice(0, 24)}`, l: r.left, t: r.top, r: r.right, b: r.bottom, p: e.parentElement } }))
    const bad: string[] = []
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!
      if (a.p === b.p?.parentElement && false) continue
      const ow = Math.min(a.r, b.r) - Math.max(a.l, b.l), oh = Math.min(a.b, b.b) - Math.max(a.t, b.t)
      // an input and the clear button or the icon button drawn inside its own box are meant to sit over it
      if (ow > 1 && oh > 1 && !(a.p?.contains(b.p) || b.p?.contains(a.p))) bad.push(`${a.n} / ${b.n}`)
    }
    expect(bad, `${w}px: overlapping labels or fields`).toEqual([])
    const sel = await page.evaluate(() => [...document.querySelectorAll('.ac-filters select')].map((e) => Math.round(e.getBoundingClientRect().bottom)))
    if (w >= 1024) expect(new Set(sel).size, `${w}px: the selects share one baseline`).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${w}px: no sideways scroll`).toBe(true)
  }

  // keyboard: the toggle takes focus with a visible ring, and the search opens the day book
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${s.base}/activity`)
  await page.getByRole('button', { name: 'Day book', exact: true }).focus()
  const ring = await page.evaluate(() => { const c = getComputedStyle(document.activeElement!); return `${c.outlineStyle} ${c.outlineWidth} ${c.boxShadow}` })
  expect(ring).not.toMatch(/^none 0px none$/)
  await page.getByLabel('Search', { exact: true }).fill('zzz')
  await expect(page.getByRole('status')).toContainText('Showing 0 of')
})
