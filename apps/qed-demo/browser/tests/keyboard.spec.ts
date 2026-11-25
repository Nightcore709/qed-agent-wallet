/**
 * Journeys completed with the keyboard alone (R7-100, in part): every control is reached with Tab and operated with
 * Enter, Space or typing; nothing is clicked or filled by script. The virtual authenticator answers each passkey
 * prompt as Touch ID would, which is the one step a keyboard user would also hand to the platform. When a sheet
 * opens, focus must already be inside it. A screen-reader review is not part of this and has not been done.
 */
import { expect, type Locator, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { shot } from '../support/vault.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

/** Press Tab until the target has focus; fails if it is not in the tab order within `max` presses. */
async function tabTo(page: Page, target: Locator, max = 150): Promise<void> {
  await expect(target).toBeVisible({ timeout: 20_000 })
  for (let i = 0; i < max; i++) {
    // bounded: a control that re-renders (the header's Stop and Resume) must not stall the walk
    if (await target.evaluate((el) => el === document.activeElement, undefined, { timeout: 1000 }).catch(() => false)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Not reachable with Tab within ${max} presses: ${target.toString()}`)
}
const press = async (page: Page, target: Locator, key = 'Enter'): Promise<void> => { await tabTo(page, target); await page.keyboard.press(key) }
/** Reach a field with Tab, replace what is in it, and type. */
const type = async (page: Page, target: Locator, text: string): Promise<void> => { await tabTo(page, target); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(text) }
/** A sheet that has just opened holds the focus: a keyboard user starts inside it, not behind it. */
async function focusInDialog(page: Page): Promise<void> {
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true)
}

async function signUp(page: Page): Promise<string> {
  const handle = unique('kbd')
  await page.goto('/')
  await press(page, page.getByRole('button', { name: 'Create an account' }))
  await press(page, page.getByRole('button', { name: 'Use a passkey instead' }))
  await type(page, page.getByLabel('Handle'), handle)
  await type(page, page.getByLabel('Name to sign with'), `Owner ${handle}`)
  await press(page, page.getByRole('button', { name: 'Create account with a passkey' }))
  await press(page, page.getByRole('button', { name: 'Continue' }))
  await press(page, page.getByRole('button', { name: 'Open the household' }))
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return handle
}

test('by keyboard alone: create an account with a passkey, open the household, pause QED and resume', async ({ page }) => {
  await addAuthenticator(page)
  const handle = await signUp(page)
  await press(page, page.getByRole('button', { name: 'QED active' }))
  await focusInDialog(page)
  await press(page, page.getByRole('dialog').getByRole('button', { name: 'Pause everything now' }))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(query<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE handle = ?', handle)[0]!.stop_at).not.toBeNull()
  await press(page, page.getByRole('button', { name: 'QED paused' }))
  await focusInDialog(page)
  await press(page, page.getByRole('dialog').getByRole('button', { name: /^Resume/ }))
  await expect(page.getByRole('button', { name: 'QED active' })).toBeVisible()
  expect(query<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE handle = ?', handle)[0]!.stop_at).toBeNull()
})

/** Approve what an open vault sheet shows, by keyboard: the job page then opens and finishes. */
async function approveByKeyboard(page: Page, outcome = 'Completed'): Promise<void> {
  await focusInDialog(page)
  await press(page, page.getByRole('dialog').getByRole('button', { name: 'Approve and send to the vault with your passkey' }))
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(page.locator('.page-head').getByText(outcome, { exact: true })).toBeVisible({ timeout: 60_000 })
}

test('by keyboard alone: set up the on-chain vault, accept it, sign a mandate and pay, each signed by the passkey', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  await signUp(page)
  // to the on-chain wallet from home, where it is listed among the accounts (the Clear redesign has no separate vault section)
  await press(page, page.getByRole('link', { name: 'On-chain wallet' }).first())
  await press(page, page.getByRole('button', { name: 'Confirm with your passkey and set it up' }))
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  await press(page, page.getByRole('button', { name: 'Review it and accept with your passkey' }))
  await approveByKeyboard(page)
  // back to the vault from the job page, then a mandate
  await press(page, page.getByRole('link', { name: 'On-chain wallet' }).first())
  await type(page, page.getByLabel('Most in one payment, in test rupees'), '250')
  await press(page, page.getByRole('button', { name: 'See the exact mandate' }))
  await approveByKeyboard(page)
  // a payment, from the vault's own section navigation
  await press(page, page.getByRole('link', { name: 'On-chain wallet' }).first())
  await press(page, page.getByRole('navigation', { name: 'On-chain wallet sections' }).getByRole('link', { name: 'Pay and set aside' }))
  const pay = page.getByRole('region', { name: 'Pay CloudCo' })
  await type(page, pay.getByLabel('How much, in test rupees'), '3')
  await press(page, pay.getByRole('button', { name: 'See the exact terms' }))
  await approveByKeyboard(page)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')
  await shot(page, 'keyboard-paid')
})
