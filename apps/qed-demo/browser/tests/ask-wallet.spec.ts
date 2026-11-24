/**
 * A wallet action proposed through Ask (N-009), driven through the interface: a household with an on-chain wallet and a
 * signed mandate asks for a standing policy; the proposal is shown as one for the wallet, with QED's own checks; the
 * owner signs its exact vault terms once with the passkey and the job runs on the local chain. The proposer here is the
 * suite's scripted test double, which the interface labels as not a model: this shows the path and its controls, not
 * that a model directed it (N-009 stays open until a real-model run, which needs the owner's approval).
 */
import { expect, test } from '../support/test.ts'
import { query } from '../support/stack.ts'
import { approve, household } from '../support/vault.ts'

test('Ask proposes a standing policy for the on-chain wallet; the owner signs its exact terms once and it runs on the chain', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await household(browser)
  // a mandate first: a wallet proposal is checked against it
  await a.page.getByLabel('Most in one payment, in test rupees').fill('2500')
  await a.page.getByRole('button', { name: 'See the exact mandate' }).click()
  await approve(a.page, /The mandate above/)
  await a.page.goto('/ask')
  await a.page.getByLabel('Your question').fill('Keep 10 test dollars in my dollar reserve')
  await a.page.getByRole('button', { name: 'Ask', exact: true }).click()
  await expect(a.page.getByText('Written by a scripted test double, not a model')).toBeVisible({ timeout: 30_000 })
  const card = a.page.getByRole('article', { name: 'Keep 10 test dollars in the dollar reserve' })
  await expect(card.getByText(/for your on-chain wallet/)).toBeVisible()
  await expect(card.getByText(/Once you sign it, QED's engine runs it on its own/)).toBeVisible()
  // no paper draft is offered for a wallet proposal
  await expect(card.getByRole('link', { name: /Open as a draft/ })).toHaveCount(0)
  await card.getByRole('button', { name: 'Review the exact terms and sign' }).click()
  const sheet = a.page.getByRole('dialog')
  // the scripted double is named as such everywhere, never as a model (claims review F5)
  await expect(sheet.getByText('On-chain wallet, proposed by a scripted test double, not a model')).toBeVisible()
  await expect(sheet.getByText(/Drafted by a scripted test double, not a model; no licensed adviser reviewed it/)).toBeVisible()
  await expect(a.page.getByText('Proposed by the model')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Approve and send to the wallet with your passkey' }).click()
  // the card follows it in the thread, as Spend's summary card follows a payment: submitted, pending, then the job's own
  // outcome in the shared words (executed is Completed), with the job's record one link away
  await expect(card.getByRole('list', { name: 'Where it stands: Completed' })).toBeVisible({ timeout: 60_000 })
  await card.getByRole('link', { name: 'Its record on the chain' }).click()
  await a.page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(a.page.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 })
  // the document the passkey signed names who proposed it, as recorded (the scripted double, provider "scripted")
  const docs = query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`, a.personId)
  expect(docs[0]!.document).toContain('proposedBy')
  expect(docs[0]!.document).toContain('scripted')
})
