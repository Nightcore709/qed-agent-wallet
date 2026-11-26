/**
 * R14 (UX final): the day book's column labels stay under the top bar while the rows scroll. The header is solid and sticks
 * at the bar's measured height (--bar-top). Presentation only; nothing here authorises anything.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addPayeeOnSpend, choosePayeeOnSpend } from '../support/payee.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_R14_STICKY_PORT ?? extraPort(118))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

async function newOwner(page: Page): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`st${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('the day book header stays under the top bar while the rows scroll', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  await newOwner(page)
  // records for the day book: three small payments, each approved with the passkey, each filed on the day
  await page.goto(`${s.base}/pay`)
  await addPayeeOnSpend(page, 'Ravi Kumar', 'ravi.kumar@upi')
  for (const amount of ['110', '230', '350']) {
    await page.goto(`${s.base}/pay`)
    await choosePayeeOnSpend(page, 'ravi.kumar@upi')
    await page.getByLabel('How much').fill(amount)
    await page.getByRole('button', { name: 'See what this would do' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
    await expect(sheet).toBeHidden()
  }
  for (const [w, h] of [[1440, 520], [390, 520]] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.goto(`${s.base}/activity?view=list`)
    await expect(page.locator('.ac-table thead th').first()).toBeVisible()
    const st = await page.evaluate(() => {
      const th = document.querySelector<HTMLElement>('.ac-table thead th')!
      return { pos: getComputedStyle(th).position, top: getComputedStyle(th).top, bg: getComputedStyle(th).backgroundColor, rows: document.querySelectorAll('.ac-table tbody tr').length, docH: document.documentElement.scrollHeight }
    })
    expect(st.pos, `${w}px: sticky`).toBe('sticky')
    expect(st.bg, `${w}px: solid, so rows do not show through`).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$/)
    // scroll until the table's rows are under the header, then the header sits level with the bar's measured bottom
    const y = await page.evaluate(() => document.querySelector('.ac-table tbody')!.getBoundingClientRect().top + scrollY + 20)
    await page.evaluate((to) => window.scrollTo({ top: to, behavior: 'instant' }), y)
    await page.waitForTimeout(400)
    const at = await page.evaluate(() => { const th = document.querySelector('.ac-table thead th')!.getBoundingClientRect(), bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-top')); const topbar = document.querySelector('.topbar')!.getBoundingClientRect(); return { thTop: th.top, bar, topbarBottom: topbar.bottom, scrolled: scrollY } })
    expect(at.scrolled, `${w}px: the page scrolled (so the header had to stick)`).toBeGreaterThan(0)
    expect(Math.abs(at.thTop - at.bar), `${w}px: header at the bar's bottom (${JSON.stringify(at)})`).toBeLessThanOrEqual(1.5)
    expect(at.thTop, `${w}px: header clear of the top bar`).toBeGreaterThanOrEqual(at.topbarBottom - 1)
  }
})
