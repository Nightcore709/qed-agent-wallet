/**
 * Grow's watchlist (R14), one journey on a presentation-mode stack: two names are added (a fund and an ETF on the paper
 * exchange); each row says its price, its source, the time of the price and that it is synthetic; one is removed; "Buy or
 * sell" on the other opens the ordinary ticket with that name chosen, and nothing is bought, sold or approved from the list
 * (no order, no approval sheet, no holding, the bank unchanged). The panel has no sideways scroll at 390 px and its buttons
 * are at least 44 px tall.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_WATCHLIST_PORT ?? extraPort(110))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let dir = ''
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qed-watchlist-'))
  const clockFile = join(dir, 'clock-offset')
  writeFileSync(clockFile, '0')
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_CLOCK_FILE: clockFile, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
test.afterAll(async () => { await s?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

async function newOwner(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Watching Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).locator('li')).toHaveCount(10) // R14: made with the first device, shown once, no box to tick
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('two names watched with their source and time, one removed, the ticket opened from the other, and nothing traded', async ({ page }) => {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const handle = `watch${Date.now().toString(36)}`
  await newOwner(page, handle)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const bank = () => s.query<{ v: string }>(`SELECT b.amount_text v FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, u!.id)[0]!.v
  const bank0 = bank()

  await page.goto(`${s.base}/holdings`)
  const panel = page.locator('#watching')
  await expect(panel.getByRole('heading', { name: 'Watching', exact: true })).toBeVisible()
  // the empty state says what this is and how to add
  await expect(panel.getByText('You are not watching anything yet')).toBeVisible()
  await expect(panel.getByText(/Choose a name below and press Add/)).toBeVisible()

  const add = async (value: string, name: string) => {
    await panel.getByLabel('Add a name to watch').selectOption(value)
    await panel.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText(`Now watching ${name}`)
  }
  await add('amfi:120716', 'UTI Nifty 50 Index Fund (Direct, Growth)')
  await add('xchg:NIFTYBEES', 'Nippon India ETF Nifty 50 BeES (paper)')
  const rows = panel.locator('.gr-watch-row')
  await expect(rows).toHaveCount(2)

  // each row: a price, its source, the time of the price, and whether it is observed or synthetic
  for (const id of ['amfi:120716', 'xchg:NIFTYBEES']) {
    const row = panel.locator(`.gr-watch-row[data-instrument="${id}"]`)
    await expect(row.locator('.gr-watch-px b')).toHaveText(/₹\s?[\d,]+\.\d{2,4}/, { timeout: 30_000 })
    await expect(row.locator('.gr-watch-px')).toContainText('a rupee price')
    await expect(row.locator('.gr-watch-src')).toContainText('Synthetic')
    await expect(row.locator('.gr-watch-src')).toContainText(/From synthetic/)
    await expect(row.locator('.gr-watch-src')).toContainText(/heard .* at \d\d:\d\d:\d\d|NAV for/)
    await expect(row.locator('.gr-watch-chg')).toContainText(/Since you added it|No price was on record|No price has arrived/)
  }
  // the server's rows agree with what the screen says
  const view = await page.evaluate(async () => (await fetch('/api/watchlist')).json()) as { items: { instrumentId: string; provider: string; basis: string; price: string | null; at: number | null }[] }
  expect(view.items.map((i) => i.instrumentId).sort()).toEqual(['amfi:120716', 'xchg:NIFTYBEES'])
  for (const i of view.items.filter((x) => x.price !== null)) { expect(i.provider).toMatch(/^synthetic/); expect(i.basis).toBe('synthetic'); expect(i.at).toBeGreaterThan(0) }
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE user_id = ? AND action = 'watchlist.add'`, u!.id)[0]!.n).toBe(2)

  const shots = process.env.QED_WATCH_SHOTS
  if (shots) await panel.screenshot({ path: join(shots, 'watching-1280.png') })
  // a narrow phone: no sideways scroll, and every button in the panel is a 44 px target
  await page.setViewportSize({ width: 390, height: 800 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const small = await panel.locator('.btn, select').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h < 44))
  expect(small).toEqual([])
  if (shots) await panel.screenshot({ path: join(shots, 'watching-390.png') })
  await page.setViewportSize({ width: 1280, height: 860 })

  // remove one
  await rows.filter({ hasText: 'UTI Nifty 50' }).getByRole('button', { name: /Remove/ }).click()
  await expect(rows).toHaveCount(1)
  await expect(panel.getByRole('status')).toContainText('Removed UTI Nifty 50')
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM watchlist_items WHERE user_id = ?`, u!.id)[0]!.n).toBe(1)
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM audit WHERE user_id = ? AND action = 'watchlist.remove'`, u!.id)[0]!.n).toBe(1)

  // "Buy or sell" opens the ordinary ticket with this name chosen; the list itself places nothing
  await rows.first().getByRole('link', { name: /Buy or sell/ }).click()
  await expect(page).toHaveURL(/\/holdings\?buy=xchg%3ANIFTYBEES#ticket|\/holdings\?buy=xchg:NIFTYBEES#ticket/)
  await expect(page.getByLabel('What', { exact: true })).toHaveValue('xchg:NIFTYBEES')
  await expect(page.getByRole('button', { name: 'See what this would do' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // nothing traded without an approval: no order, no action, no approval, no holding, the bank as it was
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM pv_orders WHERE user_id = ?', u!.id)[0]!.n).toBe(0)
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', u!.id)[0]!.n).toBe(0)
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL`, u!.id)[0]!.n).toBe(0)
  expect(bank()).toBe(bank0)
  await expect(page.getByText('You hold no investments yet')).toBeVisible()

  // "Test an idea" goes to the idea flow with this name already read
  await page.goto(`${s.base}/holdings`)
  await page.locator('#watching .gr-watch-row').first().getByRole('link', { name: /Test an idea/ }).click()
  await expect(page).toHaveURL(/\/holdings\/idea\?text=/)
})
