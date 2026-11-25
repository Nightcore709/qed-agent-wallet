/**
 * The price chart answers a question (R7-114): it says what it answers, answers it in words with exact values, gives
 * the same values as a table, says where the values come from, and reads a point under a finger on a phone. Run on a
 * presentation stack, whose synthetic prices give the chart a history without any network.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_CHART_PORT ?? extraPort(10))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

test('the price chart states its question, answers it with exact values, gives a table and its source, and reads a point under a finger on a phone', async ({ browser }) => {
  test.setTimeout(120_000)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(`chart${Date.now().toString(36)}`)
  await page.getByLabel('Name to sign with').fill('Chart Reader')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  // enough synthetic values for a line
  await expect.poll(() => s.query<{ n: number }>('SELECT COUNT(*) n FROM quotes')[0]!.n, { timeout: 30_000 }).toBeGreaterThan(20)

  await page.goto(`${s.base}/holdings`)
  const fig = page.locator('figure#chart')
  // a fund: its synthetic NAV history covers the whole period from the start
  // (screens load as their own chunks since R11, so wait for the chart's choices before reading them)
  await expect(fig.locator('select option[value^="amfi:"]').first()).toBeAttached({ timeout: 30_000 })
  const fund = await fig.locator('select option').evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v.startsWith('amfi:')))
  await fig.locator('select').selectOption(fund!)
  await expect(fig.locator('.chart-q')).toHaveText(/^How has the .+ of .+ moved over .+\?$/, { timeout: 30_000 })
  await expect(fig.locator('.chart-a')).toHaveText(/^From .+ to .+\. Lowest .+, highest .+\. Recorded values only; nothing here is a forecast\.$/)
  await expect(fig.locator('figcaption')).not.toBeEmpty()
  // the table gives the same values, the first and the last included
  await fig.getByText('The values as a table').click()
  const rows = fig.locator('.chart-table tbody tr')
  // the rows are drawn when the table is opened (the details' toggle event): waited for, not counted at once
  await expect.poll(() => rows.count()).toBeGreaterThan(1)
  await expect(fig.locator('.chart-table')).toContainText('(lowest)')
  // a finger on the line reads one point, with its time and value, and it stays after the finger lifts
  const read = fig.locator('.chart-read')
  await expect(read).toHaveText('Point at the line, or touch it, to read a value.')
  await fig.locator('svg.chart').scrollIntoViewIfNeeded()
  const box = (await fig.locator('svg.chart').boundingBox())!
  await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height / 2)
  await expect(read).not.toHaveText('Point at the line, or touch it, to read a value.')
  await expect(read.locator('strong')).toHaveText(/\d/)
  // nothing on the page is wider than the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await ctx.close()
})
