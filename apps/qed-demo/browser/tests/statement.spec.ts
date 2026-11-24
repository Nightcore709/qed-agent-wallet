/**
 * The bank statement downloads as a CSV file (RISK-066), and the file is the ledger: as many lines as the database has
 * entries on the bank account, the payment just made among them, and a last balance equal to the account's balance.
 * Since R12 (gap 9) the file first says its period (since the account was opened, by default) and its four figures.
 * A payee name written like a spreadsheet formula is written into the file as text, never as a formula.
 */
import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { query } from '../support/stack.ts'
import { fromAmountText } from '../../shared/amount-text.ts'
import { fmtDec } from '../../shared/fixed.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('csv')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}
/** A CSV line split into its cells (quoted cells may hold commas and doubled quotes). */
const cells = (line: string): string[] => [...line.matchAll(/("((?:[^"]|"")*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]!))

test('the bank statement downloads as a CSV that equals the ledger, and a formula-like name is written as text', async ({ page }) => {
  test.setTimeout(120_000)
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto('/pay')
  await addPayeeOnSpend(page, '=HYPERLINK("http://example.invalid","Shop")', 'formula@okbank')
  await page.getByLabel('How much').fill('250')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => query<{ state: string }>(`SELECT state FROM actions WHERE user_id = ? AND kind = 'payment'`, person!.id)[0]?.state, { timeout: 30_000 }).toBe('done')

  await page.goto('/passbook')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download it (CSV)' }).click()])
  expect(download.suggestedFilename()).toMatch(/^qed-bank-statement-\d{4}-\d{2}-\d{2}\.csv$/)
  const text = readFileSync((await download.path())!, 'utf8')
  const lines = text.trimEnd().split('\r\n')
  expect(cells(lines[0]!)[0]).toBe('Bank statement')
  expect(cells(lines[0]!)[1]).toMatch(/^Since the account was opened, \d{1,2} \w+ \d{4}, to now \(India Standard Time\)$/)
  // the order of its lines is stated (R13), then the table: when each was entered, and when it took effect where that differs
  expect(cells(lines[6]!)[0]).toBe('Order')
  expect(cells(lines[6]!)[1]).toMatch(/^Oldest first, in the order each line was entered in your bank account/)
  expect(cells(lines[8]!)).toEqual(['Entered (IST)', 'What', 'By', 'Under instruction', 'Money in (INR)', 'Money out (INR)', 'Balance after (INR)', 'Record', 'Why late', 'Took effect (IST)'])
  const rows = lines.slice(9).map(cells)
  // one line per ledger entry on the bank account, oldest first, ending at the account's balance
  const [acc] = query<{ id: string; t: string }>(`SELECT a.id, b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code = 'bank'`, person!.id)
  const [n] = query<{ n: number }>('SELECT COUNT(DISTINCT p.entry_id) n FROM postings p WHERE p.account_id = ?', acc!.id)
  expect(rows.length).toBe(n!.n)
  expect(rows.at(-1)![6]).toBe(fmtDec(fromAmountText(acc!.t, 'the bank balance'), 2))
  expect(cells(lines[4]!)).toEqual(['Balance at the end (INR)', fmtDec(fromAmountText(acc!.t, 'the bank balance'), 2)])
  // the payment is there, and the name that looks like a formula starts with a quote, so it is read as text
  const paid = rows.find((r) => r[5] === '250.00')!
  expect(paid).toBeDefined()
  expect(paid[1]).toContain('HYPERLINK')
  for (const r of rows) for (const c of r) expect(c).not.toMatch(/^[=+\-@]/)
})
