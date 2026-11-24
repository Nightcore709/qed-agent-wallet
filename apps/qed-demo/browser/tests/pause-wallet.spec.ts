/**
 * A paused QED does not run the on-chain wallet's standing policy, on its own or on request (R7-091). A fresh
 * household signs a policy, pauses QED from the status button and asks the policy page for one tick: refused with the
 * reason, no job is created and nothing on its vault changes. Resumed with the passkey, the same request runs a tick.
 * The engine's own five-minute ticks of a paused workspace are covered at component level (server/rail.test.ts).
 */
import { expect, test } from '../support/test.ts'
import { approve, household, railGet } from '../support/vault.ts'

test('a paused QED refuses a wallet-policy tick asked for on the policy page and nothing on the vault changes; resumed, the tick runs', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await household(browser)
  const p = a.page
  await p.getByLabel('Most in one payment, in test rupees').fill('2500')
  await p.getByRole('button', { name: 'See the exact mandate' }).click()
  await approve(p, /The mandate above/)
  await p.goto('/vault/policy')
  await p.getByLabel('Keep this much free in the reserve, in test dollars').fill('5')
  await p.getByRole('button', { name: 'See the exact policy' }).click()
  await approve(p, /The exact text above/)
  const before = await railGet(`/workspaces/${a.railId}/state`)
  const jobsBefore = (await railGet(`/workspaces/${a.railId}/jobs`)).jobs?.length ?? null

  await p.getByRole('button', { name: 'QED active' }).click()
  await p.getByRole('dialog', { name: 'Pause QED' }).getByRole('button', { name: 'Pause everything now' }).click()
  await expect(p.getByRole('button', { name: 'QED paused' })).toBeVisible()

  await p.goto('/vault/policy')
  await p.getByRole('button', { name: 'Tick once now' }).click()
  await expect(p.getByText(/QED is paused, so the standing policy does not run/)).toBeVisible({ timeout: 20_000 })
  expect(p.url()).not.toMatch(/\/vault\/job\//)
  const after = await railGet(`/workspaces/${a.railId}/state`)
  for (const k of ['balance', 'ringFenced', 'free', 'paused']) expect(after.treasury[k]).toEqual(before.treasury[k])
  if (jobsBefore !== null) expect((await railGet(`/workspaces/${a.railId}/jobs`)).jobs.length).toBe(jobsBefore)

  await p.getByRole('button', { name: 'QED paused' }).click()
  await p.getByRole('dialog', { name: 'Resume QED' }).getByRole('button', { name: /^Resume/ }).click()
  await expect(p.getByRole('button', { name: 'QED active' })).toBeVisible()
  await p.getByRole('button', { name: 'Tick once now' }).click()
  await p.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  // the request reached the vault service and finished, whatever the tick decided
  await expect(p.locator('.page-head').getByText(/^(Completed|No action needed|Refused by QED's checks; nothing sent)$/)).toBeVisible({ timeout: 60_000 })
})

test('the pause sheet can pause the on-chain wallet too: once QED is paused the passkey signs the wallet\'s own pause, the chain records it, and resuming QED says the wallet stays paused', async ({ browser }) => {
  test.setTimeout(240_000)
  const a = await household(browser)
  const p = a.page
  await p.goto('/')
  await p.getByRole('button', { name: 'QED active' }).click()
  const sheet = p.getByRole('dialog', { name: 'Pause QED' })
  await sheet.getByRole('checkbox', { name: /Pause the on-chain wallet too/ }).check()
  await sheet.getByRole('button', { name: 'Pause everything now' }).click()
  await expect(p.getByRole('button', { name: 'QED paused' })).toBeVisible()
  // the wallet's own pause: its exact terms, then the passkey
  const terms = p.getByRole('dialog', { name: 'Pause the on-chain wallet too' })
  await expect(terms.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible({ timeout: 30_000 })
  await expect(terms.getByText(/Resuming QED does not resume the wallet/)).toBeVisible()
  await terms.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await p.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(p.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect((await railGet(`/workspaces/${a.railId}/state`)).treasury.paused).toBe(true)
  // resuming QED would leave the wallet paused, and the sheet says so
  await p.getByRole('button', { name: 'QED paused' }).click()
  await expect(p.getByRole('dialog', { name: 'Resume QED' }).getByText(/The on-chain wallet is paused too\. Resuming QED does not resume it/)).toBeVisible({ timeout: 20_000 })
})
