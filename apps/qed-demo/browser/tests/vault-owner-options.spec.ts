/**
 * R13 owner options in the browser, on the suite's stack: a household sets its wallet up with the time-lock chosen,
 * makes a second passkey a signer, turns on "Require two of your devices" (one device signs that: the threshold was
 * one), then turns the time-lock off, which now takes two of its devices: the sheet says so before the first prompt,
 * the first device's signature is kept while the second is asked for, and the vault service receives both. Each step is
 * compared with the chain (the vault service's own view of the owner account) and with the stack's database. The
 * guardian's part is shown with its words; its co-signature is exercised by server/owner-options.test.ts and
 * chain/test/owner-options.test.ts, on the chain by chain/accounts/test/Guardian.t.sol.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { accept, newOwner, railGet, shot, vaultRecord } from '../support/vault.ts'

/** Approve what the sheet shows, staying on the page. */
async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
async function photo(page: Page, width: number, name: string): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(() => { window.scrollTo(0, 0); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
  await shot(page, name)
}

test('the time-lock chosen at set-up, then "Require two of your devices": turning the time-lock off takes both devices, and the chain receives both signatures', async ({ page }) => {
  test.setTimeout(240_000)
  const laptop = await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const handle = await newOwner(page)
  const [me] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // set-up, with the time-lock chosen: the request the vault service received says so, and so does the chain
  await page.goto('/vault')
  await expect(page.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  const choice = page.getByLabel(/Time-lock withdrawals and resuming/)
  await expect(choice).not.toBeChecked()
  await choice.check()
  await shot(page, 'options-set-up')
  await page.getByRole('button', { name: 'Confirm with your passkey and set it up' }).click()
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  await accept(page)
  const rec = vaultRecord(me!.id) as ReturnType<typeof vaultRecord> & { request: { timeLock?: boolean } }
  expect(rec.request.timeLock).toBe(true)
  const railId = rec.railId
  let chain = await railGet(`/workspaces/${railId}/signers`)
  expect([chain.timeLock.supported, chain.timeLock.on, chain.guardian.supported, chain.threshold]).toEqual([true, true, true, 1])

  // a second passkey (another authenticator: a phone), past its cool-off, made a signer by the first
  const first = await laptop.credentials()
  await laptop.remove()
  const phone = await addAuthenticator(page)
  await page.goto('/security')
  await page.getByRole('region', { name: 'Passkeys' }).getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(2)
  await phone.load(first.map(({ userHandle: _u, ...c }) => ({ ...c, isResidentCredential: false })))
  await page.waitForTimeout(6500) // a new passkey's cool-off: 6 s on this stack (RISK-068)
  await page.reload()
  const signers = page.getByRole('region', { name: 'Who can sign for your on-chain wallet' })
  await signers.getByRole('button', { name: 'Make it a signer' }).click()
  await approveHere(page, /addSigner/)
  await expect(signers.getByText('Signs', { exact: true })).toHaveCount(2, { timeout: 60_000 })

  // the protection options, as the chain holds them: the time-lock on, two devices off, no guardian yet
  const options = signers.locator('.wallet-options')
  await expect(options.getByRole('heading', { name: 'Protection options' })).toBeVisible()
  await expect(options.getByText('Time-lock on withdrawals and resuming', { exact: false })).toBeVisible()
  await expect(options.getByText(/each wait/)).toBeVisible()
  await expect(options.getByText(/a lost or stolen device alone can only cancel a change or stop the agent/i)).toBeVisible()
  await expect(options.getByText(/losing one leaves you only that veto/)).toBeVisible()
  await expect(options.getByText(/A guardian is one of your recovery contacts/)).toBeVisible()
  await accessible(page, 'section.wallet-signers')
  await photo(page, 1440, 'options-1440'); await photo(page, 390, 'options-390')
  await page.setViewportSize({ width: 1280, height: 860 })

  // "Require two of your devices": one device signs it (the wallet's threshold is one until it applies), at once
  await options.getByRole('button', { name: 'Require two of your devices' }).click()
  await approveHere(page, /setThresholds/)
  await expect(signers.getByText('The wallet now needs 2 signatures for each request and 2 signatures to change who signs.', { exact: false })).toBeVisible({ timeout: 60_000 })
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect([chain.threshold, chain.adminThreshold]).toEqual([2, 2])

  // turning the time-lock off now takes both devices: the sheet says so first; two rounds; then it is scheduled
  await options.getByRole('button', { name: 'Turn it off' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByText('This wallet needs 2 of your devices.', { exact: false })).toBeVisible()
  await approveHere(page, /setTimeLock/)
  await expect(signers.getByText('The time-lock goes off on ', { exact: false })).toBeVisible({ timeout: 60_000 })
  await expect(signers.getByText('Turning the time-lock off', { exact: true })).toBeVisible()
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.timeLock.on, 'still on until the delay passes').toBe(true)
  expect(chain.pending.map((c: { kind: string }) => c.kind)).toContain('set-time-lock')
  // the approval carries one signature row, the person's, holding two assertions by two different passkeys
  const rows = query<{ credential_id: string; evidence_json: string }>(`SELECT s.credential_id, s.evidence_json FROM approval_signatures s JOIN approvals a ON a.id = s.approval_id WHERE a.user_id = ? AND a.document LIKE '%"action":"set-time-lock"%'`, me!.id)
  expect(rows).toHaveLength(1)
  const used = (JSON.parse(rows[0]!.evidence_json) as { vault: { credentialId: string }[] }).vault.map((e) => e.credentialId)
  expect(used).toHaveLength(2)
  expect(new Set(used).size, 'two different passkeys').toBe(2)
  await shot(page, 'options-two-devices-scheduled')
  expect(errors).toEqual([])
})
