/**
 * The tax statement (R7-059), walked in the browser: the owner's books are given trades of each kind (the same postings and
 * lots as the wallet's own, server/tax-fixture.ts), then Activity's Tax statement page is read. It is labelled "Modelled, not
 * tax advice" with the rule set's date; its figures are the ledger's (the database is read to check them); the financial year
 * is chosen by keyboard; the reconciliation agrees; and the CSV and JSON files carry the same figures. The stack is this
 * file's own.
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { registerAmountSql } from '../../server/amount-sql.ts'
import { inrExact } from '../../shared/money.ts'
import { openDb } from '../../server/core.ts'
import { BTC, GOLD, LIQUID, NIFTY, trades } from '../../server/tax-fixture.ts'

const PORT = Number(process.env.QED_TAX_PORT ?? extraPort(32))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { s = await startExtraStack(PORT, {}) })
test.afterAll(async () => { await s?.stop() })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const inr = (paise: bigint): string => inrExact(paise)

async function newOwner(page: Page): Promise<string> {
  const handle = unique('tax')
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

test('the statement is labelled, matches the ledger, is chosen by keyboard, reconciles, and downloads as CSV and JSON', async ({ page }) => {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // trades of each kind in 2026-27, and a purchase in the year before
  const db = openDb(s.db)
  try {
    const t = trades(db, person!.id, 'b')
    t.buyCoin('2026-04-10', 100_000_000n, 1_000_000n, 5_900n)
    t.sellCoin('2026-06-10', 40_000_000n, 800_000n, 4_720n)
    t.sellCoin('2026-07-10', 60_000_000n, 300_000n, 1_770n)
    t.buyFund(NIFTY, '2025-01-10', 1_000_000n, 20_000_000n)
    t.sellFund(NIFTY, '2026-08-01', 1_000_000n, 40_000_000n)
    t.buyFund(GOLD, '2026-02-01', 1_000_000n, 5_000_000n)
    t.sellFund(GOLD, '2026-09-01', 1_000_000n, 4_000_000n, 1_000n)
    t.buyFund(LIQUID, '2026-05-01', 1_000_000n, 10_000_000n)
    t.sellFund(LIQUID, '2026-10-01', 1_000_000n, 10_300_000n)
    void BTC
  } finally { db.close() }

  await page.goto(`${s.base}/tax`)
  await expect(page.getByRole('heading', { level: 1, name: 'Tax statement' })).toBeVisible()
  await expect(page.getByText('Modelled, not tax advice. Rule set dated 24 Nov 2026.')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Activity pages' }).getByRole('link', { name: 'Tax statement' })).toHaveAttribute('aria-current', 'page')

  // the year is chosen by keyboard; the newest year is shown first
  const years = page.getByRole('group', { name: 'Financial year' })
  await expect(years.getByRole('button', { name: '2026-27' })).toHaveAttribute('aria-pressed', 'true')
  await years.getByRole('button', { name: '2025-26' }).focus()
  await page.keyboard.press('Enter')
  await expect(years.getByRole('button', { name: '2025-26' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Nothing was sold in this year.')).toBeVisible()
  await years.getByRole('button', { name: '2026-27' }).focus()
  await page.keyboard.press('Space')

  // the ledger's own figures, read from the database
  const raw = new DatabaseSync(s.db, { readOnly: true }); registerAmountSql(raw)
  const sum = (raw.prepare('SELECT amount_sum(CAST(proceeds AS TEXT)) p, amount_sum(CAST(cost AS TEXT)) c FROM realised WHERE user_id = ?').get(person!.id) as { p: string; c: string })
  raw.close()
  const gain = BigInt(sum.p) - BigInt(sum.c)
  const tile = page.locator('.tx-tile').filter({ hasText: 'Realised gain, by the ledger' })
  await expect(tile.locator('.v')).toHaveText(inr(gain))
  await expect(tile).toContainText(`Proceeds ${inr(BigInt(sum.p))} less cost ${inr(BigInt(sum.c))}`)
  await expect(page.locator('.tx-tile').filter({ hasText: 'Tax already deducted' }).locator('.v')).toHaveText(inr(11_000n))

  const gains = page.getByRole('region', { name: 'Realised gains table; scroll sideways on a narrow screen' })
  await expect(gains.getByRole('row', { name: /Equity-oriented funds.*Long-term.*112A.*12\.5%/ })).toBeVisible()
  await expect(gains.getByRole('row', { name: /Debt funds bought on or after 1 April 2023.*Short-term.*50AA.*Your slab rate/ })).toBeVisible()
  await expect(gains.getByRole('row', { name: /Virtual digital assets.*115BBH.*30%/ })).toBeVisible()
  const vda = page.getByRole('region', { name: 'Virtual digital asset sales; scroll sideways on a narrow screen' })
  await expect(vda.getByRole('row')).toHaveCount(4) // header, two sales, the total
  await expect(page.getByText('Exemption on long-term gains under section 112A: ₹1,25,000 used of ₹1,25,000.')).toBeVisible()
  await expect(page.getByText(/Stamp duty on fund purchases: ₹5\./)).toBeVisible()
  await expect(page.getByText('Agrees', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not verified' })).toBeVisible()

  // the files carry the same figures and the same label
  const csvDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download CSV' }).focus()
  await page.keyboard.press('Enter')
  const csv = readFileSync((await (await csvDownload).path())!, 'utf8')
  expect(csv).toContain('Modelled, not tax advice. Rule set in-capital-gains-2026-11-24 dated 2026-11-24')
  expect(csv).toContain(`reconciliation,,,,,,,,ok,`)
  expect(csv.split('\r\n').filter((r) => r.startsWith('vda-transfer,2026-27')).length).toBe(2)
  const jsonDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download JSON' }).click()
  const json = JSON.parse(readFileSync((await (await jsonDownload).path())!, 'utf8')) as { label: string; ruleSet: { asOf: string }; reconciliation: { ok: boolean }; years: { fy: string; totals: { ledgerGain: string } }[] }
  expect(json.label).toBe('Modelled, not tax advice')
  expect(json.ruleSet.asOf).toBe('2026-11-24')
  expect(json.reconciliation.ok).toBe(true)
  expect(BigInt(json.years.find((y) => y.fy === '2026-27')!.totals.ledgerGain)).toBe(gain)
})
