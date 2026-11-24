/**
 * A shared workspace's on-chain vault (R7-043): two members and a policy of two signatures. The owner sets the vault
 * up with one passkey of each member as its signers and the workspace's count as the owner account's threshold; the
 * owner's signature alone sends nothing, and the second member's, given from their own browser on the workspace page,
 * completes the approval and sends it with both, which the chain checks. Shown for accepting the vault, a mandate and
 * a payment.
 */
import { type Browser, expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { newOwner, railGet, shot, vaultRecord } from '../support/vault.ts'

async function member(browser: Browser): Promise<{ page: Page; handle: string }> {
  const page = await (await browser.newContext()).newPage()
  await addAuthenticator(page)
  return { page, handle: await newOwner(page) }
}
/** The member who prepared it signs: one of two; nothing is sent. */
async function signFirst(page: Page): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet.getByText('Signed: 1 of 2')).toBeVisible()
  // closing the sheet now withdraws nothing: the request waits for the other member
  await expect(sheet.getByRole('button', { name: 'Not now' })).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
/** The second member finds the request on the workspace page and signs; the job it sends opens. */
async function signSecond(page: Page, outcome = 'Completed'): Promise<void> {
  await page.goto('/workspace')
  await expect(page.getByText('1 of 2 signatures')).toBeVisible()
  await page.getByRole('button', { name: 'Review and sign' }).click()
  await shot(page, `shared-second-${Date.now()}`)
  await page.getByRole('dialog').getByRole('button', { name: 'Sign with your passkey' }).click()
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(page.locator('.page-head').getByText(outcome, { exact: true })).toBeVisible({ timeout: 60_000 })
}

test("a shared vault needs two different members' passkeys: the owner's alone sends nothing, the second member's completes it, for acceptance, a mandate and a payment", async ({ browser }) => {
  test.setTimeout(300_000)
  const a = await member(browser), b = await member(browser)
  const business = `Vault Traders ${a.handle}`
  await a.page.goto('/workspace')
  await a.page.getByLabel('Business name').fill(business)
  await a.page.getByRole('button', { name: 'Create' }).click()
  await a.page.getByRole('button', { name: 'Open the household' }).click()
  await a.page.goto('/workspace')
  await a.page.getByLabel('Their handle').fill(b.handle)
  await a.page.getByLabel('Role').selectOption('approver')
  await a.page.getByRole('button', { name: 'Add member' }).click()
  // giving a member authority waits out the protection delay (Q-048: 6 s on this stack, 72 hours in the product)
  await expect(a.page.getByText(`@${b.handle}`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await a.page.getByLabel('Signatures for every request').fill('2')
  await a.page.getByRole('button', { name: 'Save who must sign' }).click()
  await expect(a.page.getByText('In force now')).toBeVisible()
  const [ws] = query<{ id: string }>('SELECT id FROM users WHERE display_name = ?', business)

  // the owner sets the vault up: one passkey of each member, two must sign
  await a.page.goto('/vault')
  await expect(a.page.getByRole('heading', { name: 'Set up this workspace\'s wallet' })).toBeVisible()
  await expect(a.page.getByText(/One passkey of each member who may sign/)).toBeVisible()
  await shot(a.page, 'shared-set-up')
  await a.page.getByRole('button', { name: 'Confirm with your passkey and set it up' }).click()
  await expect(a.page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  const rec = vaultRecord(ws!.id)
  const view = await railGet(`/workspaces/${rec.railId}`)
  expect(view).toMatchObject({ threshold: 2, ownerKind: 'passkey-account' })
  expect((view.signers as { role: string }[]).filter((x) => x.role === 'member')).toHaveLength(2)
  const people = query<{ person_id: string }>('SELECT person_id FROM webauthn_credentials WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(JSON.parse(query<{ value: string }>('SELECT value FROM meta WHERE key = ?', `vault.workspace:${ws!.id}`)[0]!.value).credentialIds))
  expect(new Set(people.map((p) => p.person_id)).size).toBe(2)

  // accepting it: the owner's signature is one of two and sends nothing; the second member's completes and sends it
  await a.page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
  await signFirst(a.page)
  expect((await railGet(`/workspaces/${rec.railId}`)).status).toBe('awaiting-acceptance')
  await b.page.reload()
  await b.page.getByRole('button', { name: /account menu$/ }).click()
  await b.page.getByRole('combobox', { name: 'Workspace' }).selectOption({ label: `${business} (approver)` })
  await signSecond(b.page)
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('10000000')

  // a mandate, then a payment: each needs both members
  await a.page.goto('/vault')
  await a.page.getByLabel('Most in one payment, in test rupees').fill('250')
  await a.page.getByRole('button', { name: 'See the exact mandate' }).click()
  await signFirst(a.page)
  await signSecond(b.page)
  await a.page.goto('/vault/treasury')
  const pay = a.page.getByRole('region', { name: 'Pay CloudCo' })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'See the exact terms' }).click()
  await signFirst(a.page)
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('10000000')
  // the second member may look and decline for now: that withdraws nothing
  await b.page.goto('/workspace')
  await b.page.getByRole('button', { name: 'Review and sign' }).click()
  await b.page.getByRole('dialog').getByRole('button', { name: 'Not now' }).click()
  await b.page.reload()
  await expect(b.page.getByText('1 of 2 signatures')).toBeVisible()
  await signSecond(b.page)
  await expect(b.page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('9999700')
  // the payment's approval carries two members' assertions over the same digest
  const [payApproval] = query<{ id: string }>(`SELECT id FROM approvals WHERE user_id = ? AND purpose = 'rail' ORDER BY created_at DESC LIMIT 1`, ws!.id)
  const sigs = query<{ person_id: string; evidence_json: string }>('SELECT person_id, evidence_json FROM approval_signatures WHERE approval_id = ?', payApproval!.id)
  expect(new Set(sigs.map((x) => x.person_id)).size).toBe(2)
  const digests = sigs.map((x) => (JSON.parse(x.evidence_json) as { vault: { digest: string }[] }).vault[0]!.digest)
  expect(digests[0]).toBe(digests[1])
})
