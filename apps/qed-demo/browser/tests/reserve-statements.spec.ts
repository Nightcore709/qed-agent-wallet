/**
 * Every statement of the reserve, on every screen that makes one, against the server's own figures (R7-090; audit SV3).
 * A fresh household opens; each screen that says what must stay in the bank (Home, Pay, Protect, Save, Safeguards) is
 * read. Every figure the screen marks as a reserve figure (`data-reserve`: what must stay, what is kept, what is free,
 * what is short) is read from the page and compared, to the paisa, with what the server says (`/api/liquidity`,
 * `/api/home`); and each screen's statement of what is counted (`data-reserve-basis`) is checked for the look-ahead
 * in days and the late-income and lost-salary assumptions the server holds.
 * Runs on a stack of its own (no network).
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_RESERVE_PORT ?? extraPort(74))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

/** "₹1,23,456.78" or "−₹5" as paise. */
const paise = (text: string): number => {
  const m = /(−|-)?₹\s*([\d,]+)(?:\.(\d{1,2}))?/.exec(text)
  if (!m) throw new Error(`no rupee figure in "${text}"`)
  const n = Number(m[2]!.replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0)
  return m[1] ? -n : n
}
interface Liq { liquidity: { need: number; free: number; short: number; available: number; horizonDays: number; assumptions: { lateDays: number; lostSalaries: number } } }

async function newOwner(page: Page): Promise<string> {
  const handle = `res${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Reserve Reader')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

test('every reserve figure on every screen equals the server\'s, and every statement of the reserve names the look-ahead and the assumptions', async ({ page }) => {
  test.setTimeout(180_000)
  await addAuthenticator(page)
  await newOwner(page)
  const liq = ((await (await page.request.get(`${s.base}/api/liquidity`)).json()) as Liq).liquidity
  const home = (await (await page.request.get(`${s.base}/api/home`)).json()) as { overview: { bankAvailable: number } }
  expect(liq.need).toBeGreaterThan(0)
  const expected: Record<string, number> = { need: liq.need, kept: Math.min(home.overview.bankAvailable, liq.need), free: liq.short > 0 ? 0 : liq.free, short: liq.short }

  const compared: Record<string, number> = {}
  for (const path of ['/', '/pay', '/protect', '/save', '/safeguards']) {
    await page.goto(`${s.base}${path}`)
    // the statement of what is counted, with the look-ahead and the assumptions the server holds
    const basis = page.locator('[data-reserve-basis]').first()
    await expect(basis, path).toBeVisible({ timeout: 30_000 })
    const said = (await basis.innerText()).replace(/\s+/g, ' ')
    expect(said, path).toContain(`over the next ${liq.horizonDays} days`)
    expect(said, path).toMatch(/^Counted: the bills and loan instalments on record/)
    expect(said, path).toContain(`a salary up to ${liq.assumptions.lateDays} day${liq.assumptions.lateDays === 1 ? '' : 's'} late`)
    expect(await basis.getAttribute('data-horizon'), path).toBe(String(liq.horizonDays))
    expect(await basis.getAttribute('data-late-days'), path).toBe(String(liq.assumptions.lateDays))
    expect(await basis.getAttribute('data-lost'), path).toBe(String(liq.assumptions.lostSalaries))
    // every figure the screen marks as a reserve figure
    const marked = page.locator('[data-reserve]')
    await expect.poll(() => marked.count(), { message: `${path} marks at least one reserve figure`, timeout: 30_000 }).toBeGreaterThan(0)
    for (const el of await marked.all()) {
      const kind = (await el.getAttribute('data-reserve'))!
      // the text in the page, shown or inside a disclosure that is closed
      await expect(el, `${path}: ${kind} is drawn`).toContainText('₹', { timeout: 15_000 })
      expect(paise((await el.textContent()) ?? ''), `${path}: ${kind}`).toBe(expected[kind]!)
      compared[path] = (compared[path] ?? 0) + 1
    }
  }
  // every screen that states the reserve was compared, and more than one figure in all
  expect(Object.keys(compared).sort()).toEqual(['/', '/pay', '/protect', '/safeguards', '/save'])
  expect(Object.values(compared).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8)
})
