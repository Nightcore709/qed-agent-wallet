/**
 * Two amounts in one question to Ask (R7-093): "₹2,000 a week, but never more than ₹5,000 a month". The proposal keeps
 * both figures; opened as a draft, the instruction contradicts itself (four or five weekly runs ask for more than the
 * monthly limit), so it cannot be signed until the owner accepts point by point that runs beyond the limit are refused,
 * and the acceptance is part of the signed document. The proposer is the suite's scripted test double, labelled as not
 * a model.
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
async function newOwner(page: Page): Promise<string> {
  const handle = unique('con')
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

test('two amounts in one question to Ask: the draft cannot be signed until the owner accepts the contradiction, and the acceptance is signed', async ({ page }) => {
  await addAuthenticator(page)
  const handle = await newOwner(page)
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await page.goto('/ask')
  await page.getByLabel('Your question').fill('Put ₹2,000 a week, but never more than ₹5,000 a month, into the Nifty 50 index fund.')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await page.waitForURL(/\/ask\?c=cnv_/)
  const card = page.getByRole('article', { name: 'Invest ₹2,000 in UTI Nifty 50 Index Fund' })
  await expect(card).toBeVisible({ timeout: 30_000 })
  // the card already says what the two figures do together
  await expect(card.getByText(/The schedule asks for ₹[\d,]+ a month: every Monday .* The monthly limit stops it at ₹5,000/)).toBeVisible()
  await card.getByRole('link', { name: /^Open/ }).click()
  await page.waitForURL(/\/instructions\/new\?proposal=/)
  // the editor holds it: the schedule asks more each month than the limit allows
  await page.getByRole('button', { name: 'Review and sign' }).click()
  await expect(page.getByText('This instruction contradicts itself or what you wrote')).toBeVisible({ timeout: 20_000 })
  const box = page.getByRole('checkbox', { name: /^I accept: The schedule asks for about ₹[\d,]+ a month and the monthly limit is ₹5,000/ })
  await expect(box).toBeVisible()
  const go = page.getByRole('button', { name: 'Accept and continue to signing' })
  await expect(go).toBeDisabled()
  expect(query<{ n: number }>(`SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, person!.id)[0]).toEqual({ n: 0 })
  await box.check()
  await go.click()
  await expect(page.getByRole('dialog').getByText('You accepted')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/, { timeout: 30_000 })
  const [a] = query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, person!.id)
  const doc = JSON.parse(a!.document) as { accepted?: string[]; authority?: { maxPerMonth?: number; maxPerRun?: number } }
  expect(doc.authority).toMatchObject({ maxPerMonth: 500_000, maxPerRun: 200_000 })
  expect(doc.accepted?.join(' ')).toMatch(/refused/)
})
