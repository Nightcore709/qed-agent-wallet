/**
 * The Statement for a chosen period and Activity's finding (R12 task comparison, gap 9; T5-a, T5-c, T5-d), at a phone's
 * width and a computer's. The Statement: choosing last month shows the balance at its start and at its end with money in
 * and out between them, as the ledger has them; the file it downloads names its days, says its period first, and its
 * lines add up from the start to the end; the next period starts where last month ended; dates the wrong way round are
 * refused in words. Activity: a search with a misspelt name finds the payee and says which spelling it read; filters by
 * amount and by direction narrow the rows, the number found is announced, and when nothing is found the filters in force
 * are named, each removable; the day book file says which days and which rows it holds.
 */
import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { force, query } from '../support/stack.ts'
import { fromAmountText } from '../../shared/amount-text.ts'
import { fmtDec } from '../../shared/fixed.ts'
import { dayStartIst, istDate, nextDay, periodOf } from '../../shared/period.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
/** A CSV line split into its cells (quoted cells may hold commas and doubled quotes). */
const cells = (line: string): string[] => [...line.matchAll(/("((?:[^"]|"")*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]!))
/** Rupees as the file writes them ("56653.83") to paise, exactly. */
const paiseOf = (t: string | undefined): bigint => (t ? BigInt(t.replace('.', '')) : 0n)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (d: string): string => { const [y, m, dd] = d.split('-').map(Number) as [number, number, number]; return `${dd} ${MONTHS[m - 1]} ${y}` }

/** Sign up with a passkey and keep the codes; `beforeOpening` runs before the household is opened. Returns the account's id. */
async function newOwner(page: Page, beforeOpening?: (userId: string) => void): Promise<string> {
  const handle = unique('per')
  await page.goto('/')
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toBeVisible()
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  beforeOpening?.(person!.id)
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return person!.id
}

/**
 * Forced writes, named as support/stack.ts asks: the history of the two months before this one. The stack's clock cannot
 * be moved back, so a fresh account has nothing last month. Each entry is written as server/ledger.ts post() writes one,
 * before the household is opened, so the ledger's order is the order of time and the opening entry follows them: a
 * balanced pair of postings (the bank and the salary or spending account) with exact text and its integer copy, the
 * entry's sequence number next in line, and the balances kept equal to the sum of the postings. Nothing else is written.
 */
function writeHistory(userId: string, lines: { ts: number; memo: string; paise: bigint }[]): void {
  const accounts: [string, string, string, string, number][] = [['bank', 'asset', 'Bank account', unique('acc_'), 1], ['inc:salary', 'income', 'Salary', unique('acc_'), 0], ['exp:spend', 'expense', 'Spending', unique('acc_'), 0]]
  for (const [code, kind, name, id, nonneg] of accounts) force(`INSERT INTO accounts (id, user_id, code, kind, asset_id, instrument_id, name, nonneg, meta_json) VALUES (?, ?, ?, ?, 'INR', 'iso4217:INR', ?, ?, '{}')`, id, userId, code, kind, name, nonneg)
  const id = (code: string) => accounts.find((a) => a[0] === code)![3]
  const sums = new Map<string, bigint>()
  lines.forEach((l, i) => {
    const entry = unique('ent_'), other = l.paise > 0n ? 'inc:salary' : 'exp:spend'
    force(`INSERT INTO entries (id, user_id, seq, ts, effective_ts, kind, ref, memo, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{"paper":true}')`, entry, userId, i + 1, l.ts, l.ts, l.paise > 0n ? 'income' : 'spend', `test-history:${i + 1}`, l.memo)
    for (const [code, amount] of [['bank', l.paise], [other, -l.paise]] as const) {
      force('INSERT INTO postings (entry_id, account_id, asset_id, instrument_id, amount, amount_text) VALUES (?, ?, \'INR\', \'iso4217:INR\', ?, ?)', entry, id(code), Number(amount), amount.toString())
      sums.set(code, (sums.get(code) ?? 0n) + amount)
    }
  })
  for (const [code] of accounts) { const v = sums.get(code) ?? 0n; force('INSERT INTO balances (account_id, amount, amount_text) VALUES (?, ?, ?)', id(code), Number(v), v.toString()) }
}

async function statementJourney(page: Page, width: number): Promise<void> {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const now = Date.now(), last = periodOf('last-month', now), before = periodOf('last-month', dayStartIst(last.first) - 1)
  // the month before last ends on a salary; last month starts with one at exactly midnight, then two payments out
  const history = [
    { ts: before.to - 1, memo: 'Salary (paper) for the month before', paise: 2_000_000n },
    { ts: last.from, memo: 'Salary (paper)', paise: 5_000_000n },
    { ts: dayStartIst(last.first) + 14 * 86_400_000 + 10 * 3_600_000, memo: 'Rent for the month', paise: -1_234_567n },
    { ts: last.to - 60_000, memo: 'Groceries', paise: -100_050n },
  ]
  const userId = await newOwner(page, (id) => writeHistory(id, history))

  await page.goto('/passbook')
  await expect(page.getByRole('heading', { name: 'Bank statement' })).toBeVisible()
  const period = page.getByRole('group', { name: 'Period' })
  await period.getByRole('button', { name: 'Last month' }).click()
  await expect(period.getByRole('button', { name: 'Last month' })).toHaveAttribute('aria-pressed', 'true')
  const words = `Last month: ${longDate(last.first)} to ${longDate(last.last)}`
  await expect(page.locator('.pb-title p')).toHaveText(words)
  // the four figures, as the ledger has them: start 20,000; in 50,000; out 12,345.67 + 1,000.50; end 56,653.83
  const sum = page.getByLabel('The period, as a sum')
  const figure = (k: string) => sum.locator('.rv-term').filter({ has: page.locator('dt', { hasText: k }) }).locator('dd.v')
  await expect(figure('Balance at the start')).toHaveText('₹20,000.00')
  await expect(figure('Money in')).toHaveText('₹50,000.00')
  await expect(figure('Money out')).toHaveText('₹13,346.17')
  await expect(figure('Balance at the end')).toHaveText('₹56,653.83')
  // the period is announced once it has arrived, and the lines are last month's three, ending at the period's end
  await expect(page.getByRole('status').filter({ hasText: words })).toHaveText(`${words}. Balance at the start ₹20,000.00; money in ₹50,000.00; money out ₹13,346.17; balance at the end ₹56,653.83.`)
  await expect(page.locator('.pb-line')).toHaveCount(3)
  await expect(page.locator('.pb-end')).toContainText('Balance at the end ₹56,653.83, from ₹20,000.00 at the start.')
  await expect(page.locator('.pb-now')).toHaveCount(0)
  // photographed once the page's blocks have finished arriving (DESIGN.md M5), so the photograph can be read
  await expect(page.locator('[data-arrive]')).toHaveCount(0)
  await page.locator('.pb-figs').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath(`statement-last-month-${width}.png`), fullPage: false })

  // the file: named by its days, its period first, its figures, then lines that add up from the start to the end
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download it (CSV)' }).click()])
  expect(download.suggestedFilename()).toBe(`qed-bank-statement-${last.first}-to-${last.last}.csv`)
  const rows = readFileSync((await download.path())!, 'utf8').trimEnd().split('\r\n').map(cells)
  expect(rows[0]).toEqual(['Bank statement', `${words} (India Standard Time)`])
  expect(rows.slice(1, 5)).toEqual([['Balance at the start (INR)', '20000.00'], ['Money in (INR)', '50000.00'], ['Money out (INR)', '13346.17'], ['Balance at the end (INR)', '56653.83']])
  expect(rows[5]![0]).toBe('Read at')
  expect(rows[6]![0]).toBe('Order') // the order of the lines, stated (R13)
  expect(rows[8]).toEqual(['Entered (IST)', 'What', 'By', 'Under instruction', 'Money in (INR)', 'Money out (INR)', 'Balance after (INR)', 'Record', 'Why late', 'Took effect (IST)'])
  const lines = rows.slice(9)
  expect(lines.map((l) => l[1])).toEqual(['Salary (paper)', 'Rent for the month', 'Groceries'])
  expect(lines[0]![0]).toBe(`${last.first}T00:00:00.000+05:30`) // the line at midnight belongs to the month it starts
  let running = paiseOf(rows[1]![1])
  for (const l of lines) { running += paiseOf(l[4]) - paiseOf(l[5]); expect(paiseOf(l[6])).toBe(running) }
  expect(running).toBe(paiseOf(rows[4]![1]))

  // the next period starts where last month ended, and runs to now, which is the account's balance
  await period.getByRole('button', { name: 'This month' }).click()
  await expect(page.locator('.pb-title p')).toHaveText(/^This month: /)
  await expect(figure('Balance at the start')).toHaveText('₹56,653.83')
  const [acc] = query<{ t: string }>(`SELECT b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code = 'bank'`, userId)
  await expect(figure('Balance now')).toHaveText(`₹${Number(fmtDec(fromAmountText(acc!.t, 'the bank balance'), 2)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`)

  // chosen dates: the wrong way round is refused in words and nothing changes; the right way shows those days
  await period.getByRole('button', { name: 'Choose dates' }).click()
  await expect(page.getByLabel('First day')).toBeFocused()
  await page.getByLabel('First day').fill(last.last)
  await page.getByLabel('Last day').fill(last.first)
  await page.getByRole('button', { name: 'Show these dates' }).click()
  await expect(page.getByText(/^The last day, .* is before the first day, .*\.$/)).toBeVisible()
  await expect(page.getByLabel('Last day')).toBeFocused()
  await expect(page.locator('.pb-title p')).toHaveText(/^This month: /)
  await page.getByLabel('First day').fill(last.first)
  await page.getByLabel('Last day').fill(last.first)
  await page.getByRole('button', { name: 'Show these dates' }).click()
  await expect(page.locator('.pb-title p')).toHaveText(longDate(last.first))
  await expect(page.locator('.pb-line')).toHaveCount(1)
  // a period before the account had any line: nothing, from nothing
  await page.getByLabel('First day').fill(istDate(dayStartIst(before.first) - 40 * 86_400_000))
  await page.getByLabel('Last day').fill(istDate(dayStartIst(before.first) - 86_400_000))
  await page.getByRole('button', { name: 'Show these dates' }).click()
  await expect(page.getByText(/^Your bank account was opened on .*, after this period\. Nothing was entered in it before then\.$/)).toBeVisible()
  await expect(figure('Balance at the end')).toHaveText('₹0.00')
}

/** `unknownToBank`: the paper bank cannot check the name behind the address, so Pay asks the owner to say it was checked. */
async function pay(page: Page, name: string, address: string, amount: string, unknownToBank = false): Promise<void> {
  await page.goto('/pay')
  // the form to add a payee is open when there is none yet, and one press away after that: wait for the step to draw
  // one or the other (isVisible does not wait, and the payees arrive a moment after the page)
  const open = page.getByRole('button', { name: 'Add a payee', exact: true })
  const field = page.getByLabel('Name', { exact: true })
  await expect(open.or(field).first()).toBeVisible()
  if (await open.isVisible()) await open.click()
  await field.fill(name)
  await page.getByLabel('Payment address').fill(address)
  await page.getByRole('button', { name: 'Add this payee', exact: true }).click()
  if (unknownToBank) {
    // the first press asks; the payee is added only once the owner says the address was checked with the payee
    await expect(page.getByText('The paper bank could not check the name')).toBeVisible()
    await page.getByLabel('I checked this address with the payee myself, not from a message or a call').check()
    await page.getByRole('button', { name: 'Add it anyway' }).click()
  }
  await expect(page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: new RegExp(`^${name} \\(`) })).toBeChecked()
  await page.getByLabel('How much').fill(amount)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('button', { name: 'Approve and send with your passkey' }).click()
}

async function activityJourney(page: Page, width: number): Promise<void> {
  test.setTimeout(150_000)
  await addAuthenticator(page)
  const userId = await newOwner(page)
  // each payment settles before the next is made (leaving the page while one is being signed would abandon it)
  const settled = () => query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ? AND kind = 'payment' AND state = 'done'`, userId)[0]!.n
  await pay(page, 'Meera Nair', 'meera.nair@upi', '250')
  await expect.poll(settled, { timeout: 30_000 }).toBe(1)
  await pay(page, 'City Power', 'citypower@okbank', '1200', true)
  await expect.poll(settled, { timeout: 30_000 }).toBe(2)

  await page.goto('/activity')
  const status = page.getByRole('search', { name: 'Find in the day book' }).getByRole('status')
  await expect(status).toHaveText('2 entries')
  // a misspelt name finds the payee, and the page says which spelling it read
  await page.getByLabel('Search', { exact: true }).fill('Meera Nari')
  await expect(status).toHaveText('Showing 1 of 2 entries. Close spellings included: “nari” read as “nair”.')
  await expect(page.getByRole('link', { name: /^Paid Meera Nair/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Paid City Power/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear the search' }).click()
  await expect(status).toHaveText('2 entries')

  // on a phone the filters fold under one button
  if (width < 760) await page.getByRole('button', { name: /^Filters/ }).click()
  const filters = page.getByRole('group', { name: 'Filter the day book' })
  await filters.getByLabel('Direction').selectOption({ label: 'Money out' })
  await expect(status).toHaveText('Showing 2 of 2 entries.')
  // the amount and the dates are a group of their own beside the filters, folded with them on a phone
  const ranges = page.getByRole('group', { name: 'Narrow by amount and dates' })
  const amount = ranges.getByRole('group', { name: 'Amount, in rupees' })
  await amount.getByLabel('At least').fill('1,000')
  await expect(status).toHaveText('Showing 1 of 2 entries.')
  await expect(page.getByRole('link', { name: /^Paid City Power/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Paid Meera Nair/ })).toHaveCount(0)
  // a wrong amount says why and is not applied
  await amount.getByLabel('At most').fill('500')
  await expect(amount.getByText('The most, ₹500, is less than the least, ₹1,000.')).toBeVisible()
  await expect(status).toHaveText('Showing 2 of 2 entries.')
  await amount.getByLabel('At most').fill('')
  await expect(status).toHaveText('Showing 1 of 2 entries.')
  await expect(page.locator('[data-arrive]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath(`activity-filtered-${width}.png`), fullPage: false })

  // the day book file for the rows found: named by its day, its period and the filters first
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download the rows found (CSV)' }).click()])
  const today = istDate(Date.now())
  expect(download.suggestedFilename()).toBe(`qed-day-book-${today}-selection.csv`)
  const rows = readFileSync((await download.path())!, 'utf8').trimEnd().split('\r\n').map(cells)
  expect(rows[0]).toEqual(['Day book', `${longDate(today)} to now (India Standard Time)`])
  expect(rows[1]).toEqual(['Rows', 'Direction: Money out; Amount: at least ₹1,000'])
  expect([rows[2]![0], rows[3]![0], rows[4], rows[5]![0]]).toEqual(['Read at', 'Order', [], 'Asked for, due or raised (IST)'])
  expect(rows.slice(6).map((r) => [r[3], r[6]])).toEqual([['Paid City Power', '1200.00']])

  // money in: nothing found; the filters in force are named, each removable, and removing one brings the row back
  await filters.getByLabel('Direction').selectOption({ label: 'Money in' })
  await expect(status).toHaveText('Showing 0 of 2 entries.')
  const none = page.locator('.ac-none')
  await expect(none.getByText('Nothing in the period shown matches all of these:')).toBeVisible()
  await expect(none.getByRole('listitem')).toHaveText(['Direction: Money inRemove', 'Amount: at least ₹1,000Remove'])
  await none.getByRole('button', { name: 'Remove Direction: Money in' }).click()
  await expect(status).toHaveText('Showing 1 of 2 entries.')
  await expect(page.getByLabel('Search', { exact: true })).toBeFocused()

  // a date range: today keeps the row; the first day after the last is refused in words and not applied
  const dates = ranges.getByRole('group', { name: 'Dates, India time' })
  await dates.getByLabel('From').fill(today)
  await dates.getByLabel('To').fill(today)
  await expect(status).toHaveText('Showing 1 of 2 entries.')
  await dates.getByLabel('From').fill(nextDay(today))
  await expect(dates.getByText(/^The last day, .* is before the first day, .*\.$/)).toBeVisible()
  await expect(status).toHaveText('Showing 1 of 2 entries.')
  // clearing everything from the button beside the count
  await page.getByRole('button', { name: 'Show everything' }).click()
  await expect(status).toHaveText('2 entries')
}

for (const width of [390, 1440]) {
  test.describe(`at ${width} px`, () => {
    test.use({ viewport: { width, height: width < 760 ? 844 : 900 } })
    test('the Statement for last month: its start, its end, its file, and the next period from its end', async ({ page }) => { await statementJourney(page, width) })
    test('Activity: a misspelt name, amount and direction filters, nothing found named, and the file\'s period', async ({ page }) => { await activityJourney(page, width) })
  })
}
