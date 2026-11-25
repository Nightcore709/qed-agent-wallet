/**
 * Writing and signing an instruction (R7-093): a contradiction between the schedule and the monthly limit is shown
 * before anything can be signed, must be accepted point by point, and what was accepted is in the signed document.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('ins')
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

test('a schedule that asks for more than its monthly limit must be accepted point by point before signing, and the acceptance is signed', async ({ page }) => {
  await addAuthenticator(page)
  // the normal path raises no error: contradictions come with the saved draft, not from a refused request
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const handle = await newOwner(page)
  await page.goto('/instructions/new?kind=invest')
  await page.getByLabel('Buy').selectOption('coindcx:BTCINR')
  await page.getByLabel('With this much each time').fill('200')
  await page.getByLabel('How often').selectOption('every')
  await page.getByLabel('Minutes between runs').fill('60')
  await page.getByLabel('Most in one month').fill('2000')
  await page.getByRole('radio', { name: /On its own/ }).check()
  await page.getByRole('button', { name: 'Review and sign' }).click()
  // held: the contradiction is named, and the button cannot be used until it is accepted
  await expect(page.getByText('This instruction contradicts itself or what you wrote')).toBeVisible()
  const box = page.getByRole('checkbox', { name: /^I accept: The schedule asks for about ₹1,44,000 a month and the monthly limit is ₹2,000/ })
  await expect(box).toBeVisible()
  const go = page.getByRole('button', { name: 'Accept and continue to signing' })
  await expect(go).toBeDisabled()
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  expect(query('SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND purpose = ?', person!.id, 'program-version')[0]).toEqual({ n: 0 })
  await box.check()
  await go.click()
  // the sheet shows the document with what was accepted, and the passkey signs it
  await expect(page.getByRole('dialog').getByText('You accepted')).toBeVisible()
  await page.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [a] = query<{ document: string; method: string }>('SELECT document, method FROM approvals WHERE user_id = ? AND purpose = ? AND confirmed_at IS NOT NULL', person!.id, 'program-version')
  expect(a!.method).toBe('passkey')
  expect((JSON.parse(a!.document) as { accepted?: string[] }).accepted?.[0]).toMatch(/runs beyond the limit in a month will be refused/)
  expect(query('SELECT COUNT(*) n FROM programs WHERE user_id = ? AND state = ?', person!.id, 'active')[0]).toEqual({ n: 1 })
  // the signed document says how it was signed, as the approval recorded it (it once said "with your password" for every instruction)
  await expect(page.locator('.signature').getByText(/^Signed with your passkey,/)).toBeVisible()
  await expect(page.getByText(/with your password/)).toHaveCount(0)
  expect(errors).toEqual([])
})
