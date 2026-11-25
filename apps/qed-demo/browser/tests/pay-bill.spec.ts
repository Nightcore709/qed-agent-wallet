/**
 * Paying a bill on a phone (R12 task comparison). "Pay this bill" on Home lands on the payment's review (gap 13): on a
 * phone Spend's review sits below the whole journey (From, To, How much, Route), 2.6 screens down; the link brings the
 * review, with the bill chosen and its "See what this would do" button, into view and puts keyboard focus there.
 * Then the signing sheet (gaps 10 and 19): two minutes before the request lapses it says so, shown and announced, and
 * "Keep it open" gives ten more minutes on the same terms; a press on the hold button let go too soon says how to
 * finish instead of cancelling silently.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { AxeBuilder } from '@axe-core/playwright'

async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test.use({ viewport: { width: 390, height: 844 } })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('pbl')
  await page.goto('/')
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
/** A bill no instruction covers, put on record through the same API the Spend form uses. */
async function putBill(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { csrf } = await (await fetch('/api/session')).json() as { csrf: string }
    const post = async (path: string, body: unknown) => {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QED-Client': 'web', 'X-QED-CSRF': csrf }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
      return r.json() as Promise<{ id: string }>
    }
    const payee = await post('/api/payees', { name: 'City Power', handle: 'citypower@paper', category: 'utilities' })
    return (await post('/api/bills', { payeeId: payee.id, amount: 612_000, dueAt: Date.now() + 3 * 86_400_000, memo: 'Consumer 4471' })).id
  })
}

test('on a phone, "Pay this bill" lands on the review with the bill chosen', async ({ page }) => {
  await addAuthenticator(page)
  await newOwner(page)
  const billId = await putBill(page)

  await page.goto('/')
  const need = page.getByRole('heading', { name: 'City Power: ₹6,120 is due' })
  await expect(need).toBeVisible()
  await page.getByRole('link', { name: 'Pay this bill' }).click()
  await expect(page).toHaveURL(new RegExp(`/pay\\?bill=${billId}#pay-review$`))

  // the review is on screen, names the bill's payee and amount, and its button is the next thing to press
  const review = page.locator('#pay-review')
  await expect(review).toBeInViewport()
  await expect(review.getByText('City Power')).toBeVisible()
  await expect(review.locator('.ps-amount')).toHaveText('₹6,120.00')
  const go = review.getByRole('button', { name: 'See what this would do' })
  await expect(go).toBeEnabled()
  await expect(go).toBeInViewport()
  await expect(review).toBeFocused()
  // the journey above it shows the same bill chosen
  await expect(page.getByRole('radio', { name: /^Bill from City Power, ₹6,120\.00/ })).toBeChecked()
})

test('the signing sheet: a press let go too soon says how to finish; two minutes before it lapses it says so, and "Keep it open" keeps the same terms', async ({ page }) => {
  await page.clock.install() // the page's clock runs as usual until the test moves it on
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const userId = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
  const billId = await putBill(page)
  await page.goto('/')
  await page.getByRole('link', { name: 'Pay this bill' }).click()
  await expect(page).toHaveURL(new RegExp(`/pay\\?bill=${billId}#pay-review$`))
  await page.locator('#pay-review').getByRole('button', { name: 'See what this would do' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this payment' })
  await expect(sheet.getByText('This request expires in 10 minutes.')).toBeVisible()
  const open = () => query<{ id: string; doc_hash: string; cancelled_at: number | null }>("SELECT id, doc_hash, cancelled_at FROM approvals WHERE user_id = ? AND purpose = 'action' ORDER BY created_at", userId)

  // a press let go before the fill completes: nothing is approved, and the way to finish is shown and announced
  const hold = sheet.getByRole('button', { name: 'Hold to approve and send' })
  await expect(hold).toBeEnabled()
  await hold.focus()
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await expect(sheet.getByRole('status').filter({ hasText: 'Hold the button down until it fills, or use the one-step button below it.' })).toHaveCount(1)
  await expect(sheet.getByText('Hold the button down until it fills, or use the one-step button below it.').first()).toBeVisible()
  expect(open().every((a) => a.cancelled_at === null)).toBe(true)
  expect(query('SELECT id FROM actions WHERE user_id = ?', userId)).toHaveLength(0)

  // eight minutes on: the warning is shown and said once, with the way to keep the request open
  const [first] = open()
  await page.clock.fastForward('08:10')
  await expect(sheet.getByText('Less than two minutes left')).toBeVisible()
  await expect(sheet.getByRole('status').filter({ hasText: 'Less than two minutes are left to approve this.' })).toHaveCount(1)
  await accessible(page, 'dialog[open]')
  await sheet.getByRole('button', { name: 'Keep it open' }).click()
  // the server issued a fresh request for the same document and withdrew the first
  await expect.poll(() => open().length).toBe(2)
  const [was, now] = open()
  expect(was!.id).toBe(first!.id)
  expect(was!.cancelled_at).not.toBeNull()
  expect(now!.cancelled_at).toBeNull()
  expect(now!.doc_hash).toBe(first!.doc_hash)
  // back on the server's time (the page's clock was moved on, the server's was not): ten minutes again, and it is said
  await page.clock.setSystemTime(new Date())
  await expect(sheet.getByText('Less than two minutes left')).toHaveCount(0)
  await expect(sheet.getByRole('status').filter({ hasText: /^Kept open with the same terms\. It now expires at \d\d:\d\d\.$/ })).toHaveCount(1)

  // approving now signs and sends the request in force, with the same fingerprint
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 20_000 })
  await expect.poll(() => query<{ approval_id: string }>('SELECT approval_id FROM actions WHERE user_id = ?', userId).map((a) => a.approval_id)).toEqual([now!.id])
})
