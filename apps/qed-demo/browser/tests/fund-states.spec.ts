/**
 * A fund purchase followed from its sheet to its units (R12 task comparison, gap 17, and T4-a's dates). The sheet names
 * the NAV day in words ("the NAV for Wed 25 Nov"), never a database's date; the record and Home's "With the fund house"
 * line say each of the paper registrar's states as it happens: the order with the registrar, the money received by the
 * fund house with its day, the units allotted with theirs. Grow then says what the holding was bought at and why it
 * changed, in three lines that add up to the change shown, and why there is no annual rate yet.
 *
 * On a presentation-mode stack (synthetic NAVs, nothing contacted). The order's NAV is published at once by the test
 * stack's own control (server/synthetic.ts syntheticNavThrough: the day written to a file), instead of that evening:
 * no long waits. The money's arrival is the paper registrar's own two seconds, seen at its next pass (every 10 s).
 * A NAV is the close of its own day, so the control publishes none for a day that has not come (R13): an order placed
 * after the cut-off or at a weekend is entitled to a later day's NAV, and the stack's clock is first brought to that
 * day's evening (core.ts testClockOffset). Until R13 the later day's NAV was published at once and the units were
 * allotted the day before it ("NAV for Wed 25 Nov; allotted Tue 24 Nov"); the record must now show the NAV day on or
 * before the day of allotment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_FUND_STATES_PORT ?? extraPort(30))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let dir = ''
let navFile = ''
let clockFile = ''
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qed-fund-states-'))
  navFile = join(dir, 'nav-through')
  clockFile = join(dir, 'clock-offset')
  writeFileSync(clockFile, '0')
  // sessions outlast the day the clock may be brought forward by
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_SYNTHETIC_NAV_FILE: navFile, QED_TEST_CLOCK_FILE: clockFile, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
/** The stack's clock brought forward to an instant (never back): the engine and the API read the offset within a quarter second. */
const moveClockTo = (at: number): void => { writeFileSync(clockFile, String(Math.max(0, Math.round(at - Date.now())))) }
/** 21:00 IST on a day, when that day's NAV has been published. */
const eveningOf = (iso: string): number => Date.parse(`${iso}T21:00:00+05:30`)
test.afterAll(async () => { await s?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

const FUND = 'amfi:120716'
/** A day as the app writes it: "Wed 25 Nov", the year only when it is not this year; its spaces do not break (no-break spaces). */
const DAY = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s\d{4})?/
/** Text as a pattern whose spaces match any space, the no-break space of a day included. */
const words = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s')
const ISO = /\b\d{4}-\d{2}-\d{2}\b/
const day = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  const ist = new Date(Date.now() + 19_800_000)
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}${d.getUTCFullYear() === ist.getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`}`
}
/** "+₹25,000.00", "−₹1.36", "₹0.00" in paise, with its sign. */
const paise = (t: string): number => {
  const m = /([+−-])?₹([\d,]+)\.(\d\d)/.exec(t)
  if (!m) throw new Error(`no sum in "${t}"`)
  return (m[1] === '−' || m[1] === '-' ? -1 : 1) * (Number(m[2]!.replace(/,/g, '')) * 100 + Number(m[3]))
}

async function newOwner(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Fund Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
}

test('a fund purchase: the NAV day in words, each state with its day on the record and Home, then what it was bought at and why it changed', async ({ page }) => {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const handle = `fund${Date.now().toString(36)}`
  await newOwner(page, handle)
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id = ? AND price_type = 'nav'`, FUND)[0]!.n, { timeout: 15_000 }).toBeGreaterThan(0)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  const [fund] = s.query<{ name: string }>('SELECT name FROM instruments WHERE id = ?', FUND)

  // the sheet: the NAV day as a day, and why, before anything is signed
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption(FUND)
  await page.getByLabel('With how much').fill('25000')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet.getByText(new RegExp(`^the NAV for ${DAY.source}, or the next one published$`))).toBeVisible()
  await expect(sheet.getByText(/^On paper the money reaches the fund house about 2 seconds after you approve, (?:before|after) the 15:00 India time cut-off\./)).toBeVisible()
  await expect(sheet.getByText(/synthetic NAV generated on this computer \(presentation mode\)/)).toBeVisible()
  expect(await sheet.innerText()).not.toMatch(ISO)
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()

  // the record: with the registrar, then the money received with its day; the units still to come, with their NAV day
  await expect(page).toHaveURL(/\/record\/act_/)
  const actionId = page.url().split('/record/')[1]!
  // the engine sends it on its next pass; the registrar's record then says which day's NAV it is for
  const orderOf = () => s.query<{ nav: string }>(`SELECT json_extract(o.meta_json, '$.minNavDate') nav FROM pv_orders o JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, actionId)[0]
  await expect.poll(orderOf, { timeout: 15_000 }).toBeDefined()
  const order = orderOf()
  const navDay = day(order!.nav)
  const stages = page.locator('.ac-timeline')
  await expect(stages.getByText('Order with the registrar', { exact: true })).toBeVisible()
  await expect(stages.getByText(new RegExp(`^Money received by the fund house, ${DAY.source}$`))).toBeVisible({ timeout: 30_000 })
  await expect(stages.getByText('Units not allotted yet', { exact: true })).toBeVisible()
  await expect(stages.getByText(new RegExp(`^${words(`At the NAV for ${navDay}, once the fund house publishes it, usually late that evening.`)}$`))).toBeVisible()
  const [funded] = s.query<{ state: string; funds_at: number; created_at: number }>(`SELECT o.state, o.funds_at, o.created_at FROM pv_orders o JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, actionId)
  expect(funded).toMatchObject({ state: 'funded' })
  expect(funded!.funds_at - funded!.created_at).toBe(2000)
  expect(await page.locator('main').innerText()).not.toMatch(ISO)

  // Home: the money with the fund house says where it is
  await page.goto(`${s.base}/`)
  const row = page.locator('.hm-row').filter({ hasText: 'With the fund house' })
  await expect(row).toContainText(new RegExp(`Money received by the fund house ${DAY.source}; ${words(`units at the NAV for ${navDay}, once published`)}`))
  await expect(row).toContainText('₹25,000.00')

  // the fund house publishes that day's NAV (the test stack's control, not a wait for the evening): the same order is
  // allotted. A NAV day that has not come yet (after the cut-off, or at a weekend) is first reached by the stack's clock.
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)
  if (order!.nav > today) moveClockTo(eveningOf(order!.nav))
  writeFileSync(navFile, order!.nav)
  await expect.poll(() => s.query<{ state: string; receipted: number }>('SELECT state, receipt_id IS NOT NULL AS receipted FROM actions WHERE id = ?', actionId)[0], { timeout: 40_000 }).toEqual({ state: 'done', receipted: 1 })
  const [fill] = s.query<{ qty: number; price: string; effective_date: string; ts: number }>(`SELECT f.qty, f.price, f.effective_date, f.ts FROM pv_fills f JOIN pv_orders o ON o.id = f.order_id JOIN actions a ON a.economic_id = o.client_ref WHERE a.id = ?`, actionId)
  expect(fill!.effective_date).toBe(order!.nav)
  // the order of days: allotted on the NAV's own day or later, never before it
  expect(new Date(fill!.ts + 19_800_000).toISOString().slice(0, 10) >= fill!.effective_date).toBe(true)
  const units = (fill!.qty / 1000).toLocaleString('en-IN', { minimumFractionDigits: 3 })
  await page.goto(`${s.base}/record/${actionId}`)
  await expect(stages.getByText(new RegExp(`^Units allotted, ${DAY.source}$`))).toBeVisible()
  await expect(stages.getByText(new RegExp(`^${words(`${units} units at ₹`)}[\\d,]+\\.\\d{4}, ${words(`the NAV for ${navDay}.`)}$`))).toBeVisible()
  await expect(stages.getByText(new RegExp(`^Money received by the fund house, ${DAY.source}$`))).toBeVisible()
  expect(await page.locator('main').innerText()).not.toMatch(ISO)
  expect((await new AxeBuilder({ page: page as never }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])

  // Grow, on a computer: what it was bought at, and why it changed in three lines that add up to the change shown
  const nav = Number(fill!.price).toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
  const bought = `Bought at ₹${nav} a unit, the NAV for ${navDay}; allotted `
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width > 1000 ? 860 : 844 })
    await page.goto(`${s.base}/holdings`)
    const holding = width > 1000 ? page.locator('tr.gr-h-row').filter({ hasText: fund!.name }) : page.locator('li.gr-card').filter({ hasText: fund!.name })
    await expect(holding.locator('.gr-bought')).toHaveText(new RegExp(`^${words(bought)}${DAY.source}$`))
    const shown = paise(await holding.locator(width > 1000 ? '.gr-val' : '.gr-card-v').innerText())
    const story = width > 1000 ? holding.locator('xpath=following-sibling::tr[1]').locator('.gr-story') : holding.locator('.gr-story')
    // a disclosure: by pointer on the computer, by keyboard on the phone (Enter on its summary)
    const why = story.locator('.gr-why > summary')
    if (width > 1000) await why.click()
    else { await why.focus(); await expect(why).toBeFocused(); await page.keyboard.press('Enter') }
    await expect(story.locator('details.gr-why')).toHaveAttribute('open', '')
    const lines = story.locator('.gr-why-lines dd')
    await expect(lines).toHaveCount(4)
    const [put, movement, costs, change] = await Promise.all([0, 1, 2, 3].map(async (i) => paise(await lines.nth(i).innerText())))
    expect(put).toBe(2_500_000) // the ₹25,000 that left the bank
    expect(put! + movement! + costs!).toBe(change) // the three lines add up to the change shown, exactly
    expect(change).toBe(shown) // from nothing to what it is worth now
    expect(costs).toBeLessThan(0)
    await expect(story.locator('.gr-why-lines')).toContainText('stamp duty ₹1.25')
    await expect(story.locator('.gr-why-rate')).toContainText(/Not shown until you have held it for a year \(\d+ days? so far\).*money-weighted: an XIRR/)
    expect(await page.locator('main').innerText()).not.toMatch(ISO)
    expect((await new AxeBuilder({ page: page as never }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  }
  // the ledger agrees with what Grow said was put in, and the order was sent once
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM pv_orders WHERE user_id = ?`, u!.id)[0]!.n).toBe(1)
})
