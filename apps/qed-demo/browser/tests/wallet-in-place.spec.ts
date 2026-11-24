/**
 * The on-chain wallet used from the everyday pages (R7-045), with no visit to the wallet's own pages after its set-up:
 * its mandate written in Protect, then pay from it in Spend, set money aside on it in Save, convert into its dollar
 * reserve and sign its standing conversion policy in Grow. Each is signed with the passkey over its exact terms in the
 * sheet and followed on the same page; the chain's own figures are read before and after each, and the finished
 * action links to its record.
 */
import { expect, type Page, test } from '../support/test.ts'
import { household, railGet } from '../support/vault.ts'

async function signInSheet(p: Page): Promise<void> {
  const sheet = p.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
}

test('Spend, Save and Grow act on the on-chain wallet in place: each signed with the passkey over exact terms, followed on the page, and each change equal on the chain', async ({ browser }) => {
  test.setTimeout(300_000)
  const a = await household(browser)
  const p = a.page
  // the mandate, from Protect ("What QED may do")
  await p.goto('/protect')
  await p.getByRole('button', { name: 'Write a mandate' }).click()
  const mandate = p.getByRole('form', { name: 'A new mandate for your on-chain wallet' })
  await mandate.getByLabel('Most in one payment, in test rupees').fill('2500')
  await mandate.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet(p)
  await expect(p.getByText('Signed: the new mandate is in force on the chain.')).toBeVisible({ timeout: 60_000 })
  expect(((await railGet(`/workspaces/${a.railId}/state`)) as { mandate: { status: string } | null }).mandate?.status).toBe('active')
  await expect(p.getByText(/QED may pay .+ from your on-chain wallet: at most ₹2,500\.00 a payment/)).toBeVisible()
  const units = ((await (await p.request.get('/api/vault')).json()) as { workspace: { asset: { decimals: number } } }).workspace.asset.decimals
  const one = 10n ** BigInt(units)
  const state = async () => (await railGet(`/workspaces/${a.railId}/state`)) as { treasury: Record<string, string>; reserve: Record<string, string>; policy: { status: string } | null }

  // Spend: pay from the wallet
  let before = await state()
  await p.goto('/pay')
  await p.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
  const pay = p.getByRole('form', { name: 'Pay from your on-chain wallet' })
  await expect(pay.getByText(/Most that can be paid now/)).toBeVisible({ timeout: 20_000 })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet(p)
  await expect(pay.getByText('Paid ₹3.00 in test rupees to CloudCo from your on-chain wallet.')).toBeVisible({ timeout: 60_000 })
  expect(new URL(p.url()).pathname).toBe('/pay')
  await expect(pay.getByRole('link', { name: 'Open its record' })).toHaveAttribute('href', /^\/vault\/job\//)
  let after = await state()
  expect(BigInt(before.treasury.balance!) - BigInt(after.treasury.balance!)).toBe(3n * one)

  // Save: set money aside for the creditor
  before = after
  await p.goto('/save')
  const aside = p.getByRole('form', { name: 'Set money aside on your on-chain wallet' })
  await aside.getByLabel('How much to set aside for CloudCo, in test rupees').fill('4')
  await aside.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet(p)
  await expect(aside.getByText('₹4.00 in test rupees is set aside for CloudCo, due in 30 days.')).toBeVisible({ timeout: 60_000 })
  after = await state()
  expect(BigInt(after.treasury.ringFenced!) - BigInt(before.treasury.ringFenced!)).toBe(4n * one)
  expect(BigInt(before.treasury.free!) - BigInt(after.treasury.free!)).toBe(4n * one)

  // Grow: convert by hand, after reading the limits and a price
  before = after
  await p.goto('/holdings')
  const convert = p.getByRole('form', { name: 'Convert into your dollar reserve' })
  await convert.getByLabel('Convert how much, in test rupees').fill('10')
  await convert.getByRole('button', { name: 'Check the limits and the price' }).click()
  await expect(convert.getByText(/You would receive about \$/)).toBeVisible({ timeout: 20_000 })
  await convert.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet(p)
  await expect(convert.getByText('Converted ₹10.00 in test rupees into your dollar reserve.')).toBeVisible({ timeout: 60_000 })
  after = await state()
  expect(BigInt(before.treasury.balance!) - BigInt(after.treasury.balance!)).toBe(10n * one)
  expect(BigInt(after.reserve.balance!)).toBeGreaterThan(BigInt(before.reserve.balance!))

  // Grow: sign the standing conversion policy
  const policy = p.getByRole('form', { name: 'Keep a dollar reserve topped up' })
  await policy.getByLabel('Keep this much free in the reserve, in test dollars').fill('5')
  await policy.getByRole('button', { name: 'Review and sign' }).click()
  await signInSheet(p)
  await expect(p.getByText(/^In force:/)).toBeVisible({ timeout: 60_000 })
  expect((await state()).policy?.status).toBe('active')
})
