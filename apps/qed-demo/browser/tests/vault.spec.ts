/**
 * The on-chain vault in the browser (R7-040, R7-071, F-014): a fresh household sets up its own vault, owned by an
 * account on the chain whose signers are its passkeys; it accepts the vault, signs a mandate and pays, each time with
 * its passkey signing the digest the chain checks. Two households stay independent: one pausing its vault changes
 * nothing of the other's. The screen is compared with the stack's database and with the vault service's own state.
 */
import { expect, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { accept, approve, household, newOwner, railGet, setUpVault, shot, treasury, vaultRecord } from '../support/vault.ts'

test('a fresh household sets up its own vault, owned by its passkey; accepting it, a mandate and a payment are each signed by the passkey and checked on the chain', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const handle = await newOwner(page)
  const [me] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await setUpVault(page)
  // the owner account's signer is this account's passkey, and its origin is the page's
  const rec = vaultRecord(me!.id)
  const [cred] = query<{ x: string; y: string }>('SELECT x, y FROM webauthn_credentials WHERE person_id = ?', me!.id)
  expect(rec.request.owner.signers).toEqual([{ x: `0x${cred!.x}`, y: `0x${cred!.y}` }])
  expect(rec.request.origin).toBe(new URL(page.url()).origin)
  const ws = await railGet(`/workspaces/${rec.railId}`)
  expect(ws).toMatchObject({ status: 'awaiting-acceptance', ownerKind: 'passkey-account', threshold: 1, asset: { symbol: 'tINR', decimals: 2 } })
  // accept: the passkey signs the account's digest of exactly the two acceptOwnership calls
  await accept(page)
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('10000000')
  // a mandate, signed by the passkey through the account (ERC-1271)
  await page.getByLabel('Most in one payment, in test rupees').fill('2500')
  await page.getByRole('button', { name: 'See the exact mandate' }).click()
  await approve(page, /The mandate above/)
  // the signed mandate is its own section of the wallet (Bounds, 23 Nov); the Overview draws what it allows as the bound
  await page.goto('/vault/mandate')
  const mandate = page.getByRole('article', { name: 'Mandate version 1' })
  await expect(mandate.getByText('In force')).toBeVisible()
  await shot(page, '05-vault-with-mandate')
  await expect(mandate.getByText('Signed with your passkey', { exact: true })).toBeVisible()
  // a payment the agent sends under that mandate, after the owner's passkey signed the instruction
  await page.goto('/vault/treasury')
  // the co-signer's check C12 is the authority budget (R7 D7), shown with its figures
  await expect(page.getByText('Your authority budget', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Grant the agent more authority' })).toBeVisible()
  await shot(page, '06-treasury')
  const pay = page.getByRole('region', { name: 'Pay CloudCo' })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'See the exact terms' }).click()
  await approve(page, /The exact text above/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('9999700')
  // the owner grants the agent more authority with the passkey: granted rises, earned does not, no money moves
  await page.goto('/vault/treasury')
  const grant = page.getByRole('region', { name: 'Grant the agent more authority' })
  await grant.getByLabel('How much, in test rupees').fill('20')
  await grant.getByRole('button', { name: 'See the exact grant' }).click()
  await approve(page, /The exact text above/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Owner granted the agent 20.00 test rupees more authority')
  await page.goto('/vault/treasury')
  const budget = page.locator('dt', { hasText: 'Your authority budget' }).locator('xpath=following-sibling::dd[1]')
  // written as the Overview writes money, ₹ on the figure (finish review of 23 Nov; was "27.00 tINR available now, of 30.00 ...")
  await expect(budget).toHaveText('₹27.00 available now, of ₹30.00 granted and earned')
  expect((await railGet(`/workspaces/${rec.railId}/state`)).treasury.balance).toBe('9999700')
  // every one of those approvals carries the passkey's assertion over the digest, made at the vault's origin
  const sigs = query<{ evidence_json: string }>(`SELECT s.evidence_json FROM approval_signatures s JOIN approvals a ON a.id = s.approval_id WHERE a.user_id = ? AND a.purpose = 'rail'`, me!.id)
  expect(sigs).toHaveLength(4) // accepting, the mandate, the payment and the grant
  for (const s of sigs) {
    const v = (JSON.parse(s.evidence_json) as { vault: { digest: string; clientDataJSON: string }[] }).vault
    expect(v).toHaveLength(1)
    const c = JSON.parse(v[0]!.clientDataJSON) as { type: string; challenge: string; origin: string }
    expect(c).toMatchObject({ type: 'webauthn.get', origin: rec.request.origin })
    expect(Buffer.from(c.challenge, 'base64url').toString('hex')).toBe(v[0]!.digest.slice(2))
  }
  expect(errors).toEqual([])
})

test('two households: each has its own vault and owner account, and one pausing its vault leaves the other\'s untouched', async ({ browser }) => {
  test.setTimeout(240_000)
  const [a, b] = await Promise.all([household(browser), household(browser)])
  expect(a.railId).not.toBe(b.railId)
  const [wa, wb] = await Promise.all([railGet(`/workspaces/${a.railId}`), railGet(`/workspaces/${b.railId}`)])
  expect(wa.ownerAccount).not.toBe(wb.ownerAccount)
  expect(wa.contracts.vault).not.toBe(wb.contracts.vault)
  expect(wa.contracts.execution).not.toBe(wb.contracts.execution)
  expect(wa.keys.agent).not.toBe(wb.keys.agent)
  expect(wa.signers[0].signerId).not.toBe(wb.signers[0].signerId)
  // A pauses its vault with its passkey
  await a.page.getByRole('button', { name: 'Pause the wallet' }).click()
  await approve(a.page, /Your owner account runs this call.*pause/)
  await a.page.goto('/vault')
  await expect(treasury(a.page).getByText('Paused')).toBeVisible()
  // B's vault is not paused, on the screen and on the chain
  await b.page.goto('/vault')
  await expect(b.page.getByRole('button', { name: 'Pause the wallet' })).toBeVisible()
  await expect(treasury(b.page).getByText('Paused')).toHaveCount(0)
  const [sa, sb] = await Promise.all([railGet(`/workspaces/${a.railId}/state`), railGet(`/workspaces/${b.railId}/state`)])
  expect(sa.treasury.paused).toBe(true)
  expect(sb.treasury.paused).toBe(false)
  expect(sb.treasury.balance).toBe('10000000')
  // B cannot reach A's vault, even naming A's own proposal: every vault route is the signed-in household's own
  const [mine] = query<{ subject: string }>(`SELECT subject FROM approvals WHERE user_id = ? AND purpose = 'rail' ORDER BY created_at DESC LIMIT 1`, a.personId)
  const proposalOfA = mine!.subject.replace(/^rail:/, '')
  expect(await a.page.evaluate(async (id) => (await fetch(`/api/vault/proposals/${id}`)).status, proposalOfA)).toBe(200)
  expect(await b.page.evaluate(async (id) => (await fetch(`/api/vault/proposals/${id}`)).status, proposalOfA)).toBe(404)
})
