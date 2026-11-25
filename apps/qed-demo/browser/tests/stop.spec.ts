/**
 * Pausing QED means what it says (R7-091): the one control in the bar opens a sheet that states what stops and what
 * can keep running; a plain pause holds protective selling too, and keeping protective selling is the owner's
 * explicit choice, named on the button and recorded. The database is the judge of what was chosen. (Since the
 * "Clear" redesign of 22 Nov 2026 the control is the status button, labelled with QED's state, not "Stop everything".)
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { AxeBuilder } from '@axe-core/playwright'

async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('stp')
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
const stopState = (handle: string) => query<{ stop_at: number | null; stop_protective: number }>('SELECT stop_at, stop_protective FROM users WHERE handle = ?', handle)[0]!

test('a plain pause holds protective selling too; keeping it is a choice the sheet names and the record keeps', async ({ page }) => {
  await addAuthenticator(page)
  const handle = await newOwner(page)

  // the sheet says what stops, protective selling included, and the plain pause is the default
  await page.getByRole('button', { name: 'QED active' }).click()
  const sheet = page.getByRole('dialog', { name: 'Pause QED' })
  await expect(sheet.getByText(/No instruction starts a new run, protective selling included/)).toBeVisible()
  // what else the sheet promises: the wallet's standing conversions stop; what was sent cannot be recalled; what the owner signs still works
  await expect(sheet.getByText(/Your on-chain wallet's standing conversions stop too/)).toBeVisible()
  await expect(sheet.getByText(/A payment or order already sent to a bank rail, a venue or the chain/)).toBeVisible()
  await expect(sheet.getByText(/Anything you sign yourself: a payment, an order, a conversion on the on-chain wallet/)).toBeVisible()
  await expect(sheet.getByRole('radio', { name: /Everything QED does on its own/ })).toBeChecked()
  await sheet.getByRole('button', { name: 'Pause everything now' }).click()
  await expect(sheet).toBeHidden()
  expect(stopState(handle)).toMatchObject({ stop_protective: 0 })
  expect(stopState(handle).stop_at).not.toBeNull()
  await expect(page.getByRole('status').filter({ hasText: 'it does nothing on its own' })).toBeVisible()

  // resuming needs the passkey; afterwards nothing is paused
  await page.getByRole('button', { name: 'QED paused' }).click()
  await page.getByRole('dialog', { name: 'Resume QED' }).getByRole('button', { name: /^Resume/ }).click()
  await expect(page.getByRole('button', { name: 'QED active' })).toBeVisible()
  expect(stopState(handle).stop_at).toBeNull()

  // keeping protective selling: the choice says what keeps running, and the button says what it does
  await page.getByRole('button', { name: 'QED active' }).click()
  await sheet.getByRole('radio', { name: /Everything except protective selling/ }).check()
  await expect(sheet.getByText(/keep watching and can still sell\. Everything else stops/)).toBeVisible()
  await sheet.getByRole('button', { name: 'Pause all but protective selling' }).click()
  await expect(sheet).toBeHidden()
  expect(stopState(handle)).toMatchObject({ stop_protective: 1 })

  // and the paused state, when opened, repeats the exception
  await page.getByRole('button', { name: 'Paused, protection on' }).click()
  await expect(page.getByRole('dialog').getByText(/protective selling kept running, as you chose/)).toBeVisible()
})

test('in an emergency one sheet does it: it names what will not happen and what happens anyway, signs out every other session, and Home then says QED may move nothing', async ({ browser }) => {
  // the owner on a laptop and on a phone (the same passkey, synced)
  const laptop = await (await browser.newContext()).newPage()
  const key = await addAuthenticator(laptop)
  const handle = await newOwner(laptop)
  const phone = await (await browser.newContext()).newPage()
  const synced = await addAuthenticator(phone)
  await synced.load(await key.credentials())
  await phone.goto('/')
  await phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect(phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toHaveCount(0, { timeout: 20_000 })
  const person = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
  const open = () => query<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND revoked_at IS NULL', person)[0]!.n
  expect(open()).toBe(2)
  // a bill no instruction pays, due in three days: it stays the household's to pay, paused or not
  await laptop.evaluate(async () => {
    const { csrf } = await (await fetch('/api/session')).json() as { csrf: string }
    const post = async (path: string, body: unknown) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QED-Client': 'web', 'X-QED-CSRF': csrf }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>
    const payee = await post('/api/payees', { name: 'Green School', handle: 'greenschool@upi', category: 'education', nameCheckAccepted: 'unknown' })
    await post('/api/bills', { payeeId: payee.id, amount: 1_500_000, dueAt: Date.now() + 3 * 86_400_000, memo: 'Term fees' })
  })

  await laptop.getByRole('button', { name: 'QED active' }).click()
  const sheet = laptop.getByRole('dialog', { name: 'Pause QED' })
  const yours = sheet.locator('.qs-effects').filter({ has: laptop.getByRole('heading', { name: 'Still yours to pay' }) })
  await expect(yours.getByRole('listitem').filter({ hasText: 'Green School' })).toContainText('No instruction pays it, paused or not')
  await sheet.getByRole('checkbox', { name: /Sign out every other session/ }).check()
  await accessible(laptop, 'dialog[open]')
  await sheet.getByRole('button', { name: 'Pause everything now' }).click()
  await expect(sheet).toBeHidden()
  await expect(laptop.getByRole('button', { name: 'QED paused' })).toBeVisible()
  // the phone's session ended, the laptop's did not, and the security history says so
  expect(open()).toBe(1)
  expect(query('SELECT 1 FROM security_events WHERE person_id = ? AND kind = ?', person, 'sessions-ended-others')).toHaveLength(1)
  await phone.reload()
  await expect(phone.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' })).toBeVisible({ timeout: 20_000 })
  // the paused sheet says what was done (until this page is reloaded)
  await laptop.getByRole('button', { name: 'QED paused' }).click()
  const paused = laptop.getByRole('dialog', { name: 'Resume QED' })
  await expect(paused.getByText('When you paused, 1 other session was signed out.')).toBeVisible()
  await paused.getByRole('button', { name: 'Keep it paused' }).click()

  // Home: QED may move nothing while it is paused
  await laptop.goto('/')
  const reach = laptop.locator('.tile.qed')
  await expect(reach.locator('.v')).toHaveText('₹0')
  await expect(reach.getByText(/^Nothing while QED is paused/)).toBeVisible()
})

test('a lost or stolen device: on the signed-out page a saved recovery code pauses QED, all but protective selling, opening no session; the owner\'s device then shows it paused', async ({ browser }) => {
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const handle = unique('stc')
  await owner.goto('/')
  await owner.getByRole('button', { name: 'Create an account' }).click()
  await owner.getByRole('button', { name: 'Use a passkey instead' }).click()
  await owner.getByLabel('Handle').fill(handle)
  await owner.getByLabel('Name to sign with').fill(`Owner ${handle}`)
  await owner.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(owner.getByRole('heading', { name: 'Keep a way back in' })).toBeVisible()
  // R14 (F1): the codes come with the first device and are shown once
  await expect(owner.getByRole('list', { name: 'Recovery codes' }).locator('li').first()).toBeVisible()
  const codes = await owner.getByRole('list', { name: 'Recovery codes' }).locator('li').allInnerTexts()
  await owner.getByRole('button', { name: 'Continue' }).click()
  await owner.getByRole('button', { name: 'Open the household' }).click()
  await expect(owner.getByRole('button', { name: 'QED active' })).toBeVisible()
  const person = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
  const sessions = () => query<{ n: number }>('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', person)[0]!.n
  const before = sessions()

  // another browser, with no passkey of the account
  const away = await (await browser.newContext()).newPage()
  await away.goto('/?help=recover')
  const fold = away.locator('details.ax-pause')
  await fold.getByText('Lost or stolen device? Pause QED first, with a saved code').click()
  await fold.getByLabel('Handle').fill(handle)
  await fold.getByLabel('One of your saved recovery codes').fill(codes[0]!)
  await accessible(away, 'details.ax-pause')
  await fold.getByRole('button', { name: 'Pause QED' }).click()
  await expect(fold.getByRole('status')).toContainText('If the handle and the code matched, QED is paused')
  expect(stopState(handle)).toMatchObject({ stop_protective: 1 })
  expect(stopState(handle).stop_at).not.toBeNull()
  expect(sessions()).toBe(before)
  // the owner's own device says so, and only a passkey resumes it
  await owner.reload()
  await expect(owner.getByRole('button', { name: 'Paused, protection on' })).toBeVisible()
})
