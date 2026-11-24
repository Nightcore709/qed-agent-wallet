/**
 * Who can sign for the on-chain wallet, in the browser (RISK-053): a household adds a second passkey as a signer of
 * its wallet (signed by the first, applied at once), schedules that passkey's removal (behind the wallet's delay),
 * cancels the removal with the first passkey (the passkey being removed is never offered), sets up a recovery key
 * the browser derives from a code it shows once, then starts a recovery with that code for a third passkey, which a
 * signer stops (the key is spent by the attempt). Each step is compared with the chain (the vault service's own view of
 * the owner account's signers) and with the stack's database, and no request the page sends carries the code.
 * R13: the recovery is relayed only after the third passkey itself confirms that very request (the server refuses any
 * other passkey; its unit tests show the refusal), and suspending the phone in QED freezes it on the chain at once.
 */
import { createECDH, scryptSync } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query } from '../support/stack.ts'
import { accept, newOwner, signupCodes, railGet, setUpVault, shot, vaultRecord } from '../support/vault.ts'

/** Approve what the sheet shows, staying on the page: one passkey prompt per digest. */
async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await shot(page, `signers-sheet-${Date.now()}`)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/** WCAG 2.0 to 2.2 level A and AA rules over one section, as scripts/a11y.ts runs them over whole screens. */
async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
/** A full-page photograph at a width, from the top once the layout has settled (taken scrolled, fixed bars land mid-page). */
async function photo(page: Page, width: number, name: string): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
  await page.evaluate(() => { window.scrollTo(0, 0); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
  await shot(page, name)
}
/**
 * The recovery key a code stands for, worked out here with node:crypto from the recipe chain/accounts/webauthn.ts
 * RecoveryKey states (scrypt N 2^15, r 8, p 1, the fixed salt, 48 bytes, reduced into P-256's scalars): a third
 * implementation, so that what the browser derived is checked against neither of the two it could share a fault with.
 */
function expectedKey(code: string): { x: string; y: string } {
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  const m = BigInt(`0x${scryptSync(c, 'QEDOwnerAccount recovery v1', 48, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`)
  const e = createECDH('prime256v1')
  e.setPrivateKey(Buffer.from(((m % (n - 1n)) + 1n).toString(16).padStart(64, '0'), 'hex'))
  const pub = e.getPublicKey()
  return { x: `0x${pub.subarray(1, 33).toString('hex')}`, y: `0x${pub.subarray(33, 65).toString('hex')}` }
}

test('a second passkey becomes a wallet signer, its removal is scheduled and cancelled by the other passkey, a recovery key is set up in the browser without the code leaving it, and a recovery started with that code is stopped by a signer', async ({ page }) => {
  test.setTimeout(330_000) // 240 s before the two waits for the new passkeys' cool-off
  const laptop = await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const sent: string[] = []
  page.on('request', (r) => { const b = r.postData(); if (b) sent.push(b) })
  const handle = await newOwner(page)
  const [me] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await setUpVault(page)
  await accept(page)
  const railId = vaultRecord(me!.id).railId
  // a second passkey, made on another authenticator (a phone); then this browser holds both keys
  const first = await laptop.credentials()
  await laptop.remove()
  const phone = await addAuthenticator(page)
  await page.goto('/security')
  await page.getByRole('region', { name: 'Passkeys' }).getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(2)
  // a passkey added beside another cools off before it can be made a signer (RISK-068: 6 s on this stack, 24 hours in the
  // product); Security says so on its row, and the wallet offers it once the cool-off is over
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByText(/it cannot approve payments above ₹10,000, loosen a protection or add a signer/)).toBeVisible()
  await page.waitForTimeout(6500)
  await page.reload()
  // the laptop's key, loaded as a non-resident credential: it signs whenever the server names it, as a second device would
  await phone.load(first.map(({ userHandle: _u, ...c }) => ({ ...c, isResidentCredential: false })))
  const creds = query<{ id: string; name: string; x: string; y: string }>('SELECT id, name, x, y FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at', me!.id)
  expect(creds).toHaveLength(2)
  const [laptopKey, phoneKey] = creds as [typeof creds[0], typeof creds[0]]

  // the wallet's signers: only the first passkey, as on the chain
  const signers = page.getByRole('region', { name: 'Who can sign for your on-chain wallet' })
  await expect(signers.getByText('Signs', { exact: true })).toHaveCount(1)
  let chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.signers.map((s: { x: string }) => s.x)).toEqual([`0x${laptopKey.x}`])
  await accessible(page, 'section.wallet-signers')
  await photo(page, 1440, 'signers-1440-before'); await photo(page, 390, 'signers-390-before')
  await page.setViewportSize({ width: 1280, height: 860 })

  // 1 · add the phone as a signer: the laptop's passkey signs the exact addition; it applies at once
  await signers.getByRole('button', { name: 'Make it a signer' }).click()
  await approveHere(page, /Your owner account runs this call.*addSigner/)
  await expect(signers.getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(signers.getByText(`"${phoneKey.name}" now signs for the wallet.`, { exact: false })).toBeVisible()
  await expect(signers.getByText('Signs', { exact: true })).toHaveCount(2)
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.signers.map((s: { x: string }) => s.x).sort()).toEqual([`0x${laptopKey.x}`, `0x${phoneKey.x}`].sort())
  expect(chain.memberCount).toBe(2)

  // 2 · R13 review fix F2: the phone's removal is refused while it is not frozen, since with two signers no other one
  //     could cancel it; nothing is signed and nothing is scheduled (its scheduled removal and cancellation: steps 7 and 8)
  const members = signers.getByRole('listitem').filter({ hasText: 'Signs for the wallet' })
  await expect(members).toHaveCount(2)
  await members.nth(1).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText(/schedules the removal of a passkey that is not frozen only if more than 1 other member/)).toBeVisible({ timeout: 30_000 })
  // the refusal is the server's answer (409 no_canceller_left), which the browser logs as a failed load: expected here, and only here
  const refusedLoads = errors.filter((e) => /status of 409/.test(e)).length
  expect(refusedLoads).toBeLessThanOrEqual(1)
  errors.splice(0, errors.length, ...errors.filter((e) => !/status of 409/.test(e)))
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.signers.every((s: { pendingRemoval: string | null }) => s.pendingRemoval === null)).toBe(true)


  // 4 · a recovery key: the code is made and shown here, the key derived here, and only its public key and signatures leave the page
  await signers.getByRole('button', { name: 'Set up a recovery key' }).click()
  const code = (await signers.getByLabel('Wallet recovery code').textContent())!.trim()
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/)
  await photo(page, 390, 'signers-390-code')
  // the code fits the phone's width: nothing on the page is wider than the window
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1280, height: 860 })
  await expect(signers.getByRole('button', { name: 'Add this recovery key' })).toBeDisabled()
  await accessible(page, 'section.wallet-signers')
  await signers.getByLabel('I have stored this code somewhere other than this device').check()
  await signers.getByRole('button', { name: 'Add this recovery key' }).click()
  await approveHere(page, /addSigner/)
  await expect(signers.getByText('Completed', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(signers.getByText('The wallet now has the recovery key your code stands for.', { exact: false })).toBeVisible()
  await expect(signers.getByText('Recovery only', { exact: true })).toBeVisible()
  await expect(signers.getByLabel('Wallet recovery code')).toHaveCount(0)
  chain = await railGet(`/workspaces/${railId}/signers`)
  const rk = expectedKey(code)
  expect(chain.signers.filter((s: { role: string }) => s.role === 'recovery').map((s: { x: string; y: string }) => [s.x, s.y])).toEqual([[rk.x, rk.y]])
  await photo(page, 1440, 'signers-1440-after'); await photo(page, 390, 'signers-390-after')
  await page.setViewportSize({ width: 1280, height: 860 })

  // 5 · a recovery with the code, typed loosely, for a passkey of this person that does not sign yet; a signer stops it,
  //     and the key is gone (starting a recovery spends it)
  // a third passkey, made on a third authenticator (a tablet); then this browser holds all three keys again
  const held = await phone.credentials()
  await phone.remove()
  const tablet = await addAuthenticator(page)
  await page.getByRole('region', { name: 'Passkeys' }).getByRole('button', { name: 'Add a passkey', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem')).toHaveCount(3)
  // the third passkey adds a signer by the recovery, so it waits out its cool-off first (RISK-068: 6 s on this stack); the
  // wallet offers the recovery to a passkey that may become a signer, so the page is read again once it may
  await page.waitForTimeout(6500)
  await page.reload()
  await tablet.load(held.map(({ userHandle: _u, ...c }) => ({ ...c, isResidentCredential: false })))
  const third = query<{ id: string; name: string; x: string; y: string }>('SELECT id, name, x, y FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at', me!.id)[2]!
  await signers.getByRole('button', { name: 'Recover the wallet with your code' }).click()
  await accessible(page, 'section.wallet-signers')
  await signers.getByLabel('Your wallet\'s recovery code').fill(code.toLowerCase().replace(/-/g, ' '))
  await signers.getByRole('button', { name: 'Start the recovery' }).click()
  await expect(signers.getByText('Scheduled', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(signers.getByText(`The recovery has started: "${third.name}" can be made a signer on `, { exact: false })).toBeVisible()
  await expect(signers.getByText('Recovery under way', { exact: true })).toBeVisible()
  chain = await railGet(`/workspaces/${railId}/signers`)
  const started = chain.signers.find((s: { role: string }) => s.role === 'recovery') as { pendingRecovery: string }
  expect(started.pendingRecovery).toMatch(/^0x[0-9a-f]{64}$/)
  expect((await railGet(`/workspaces/${railId}/scheduled`)).scheduled.find((c: { changeId: string }) => c.changeId === started.pendingRecovery)).toMatchObject({ kind: 'recovery', status: 'pending' })
  // the account's history (Security has no side column since Bounds: its parts are one column, and history is its own region)
  await expect(page.getByRole('region', { name: 'What happened' }).getByText(`On-chain wallet recovery started with its code, for the passkey: ${third.name}`)).toBeVisible()
  await shot(page, 'signers-recovery-started')
  await signers.getByRole('listitem').filter({ hasText: 'A recovery that adds a new passkey as a signer' }).getByRole('button', { name: 'Cancel it' }).click()
  await approveHere(page, /Cancelling the scheduled change/)
  await expect(signers.getByText('Stopped: the recovery will not happen.', { exact: false })).toBeVisible({ timeout: 60_000 })
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.signers.filter((s: { role: string }) => s.role === 'recovery')).toEqual([])
  expect(chain.signers.map((s: { x: string }) => s.x).sort()).toEqual([`0x${laptopKey.x}`, `0x${phoneKey.x}`].sort())
  await expect(signers.getByText('Recovery only', { exact: true })).toHaveCount(0)

  // the recovery was confirmed by the passkey it adds, and by no other (R13): the prompt offered that passkey alone
  expect(query<{ n: number }>(`SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'vault-recovery-refused'`, me!.id)[0]!.n).toBe(0)

  // 6 · R13: the phone is reported stolen and suspended in QED; the wallet freezes it on the chain at once, and the
  //     laptop still signs
  // (the phone and the tablet share a name; the list is in the order they were added: laptop, phone, tablet)
  // every suspension of another passkey spends a saved code (H2)
  await page.getByRole('textbox', { name: 'A saved recovery code, to suspend' }).fill(signupCodes.get(handle)![9]!)
  await page.getByRole('region', { name: 'Passkeys' }).getByRole('listitem').nth(1).getByRole('button', { name: /^Suspend now/ }).click()
  await expect(signers.getByText('Frozen on the chain', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(query<{ suspended_at: number | null }>('SELECT suspended_at FROM webauthn_credentials WHERE id = ?', phoneKey.id)[0]!.suspended_at).not.toBeNull()
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.containment).toMatchObject({ byThisService: true, protect: true })
  expect(chain.signers.find((s: { x: string }) => s.x === `0x${phoneKey.x}`).frozen).toBe(true)
  expect(chain.signers.find((s: { x: string }) => s.x === `0x${laptopKey.x}`).frozen).toBe(false)
  await expect(signers.getByText(`"${phoneKey.name}" is suspended in QED and frozen on the chain`, { exact: false })).toBeVisible()
  await accessible(page, 'section.wallet-signers')
  await shot(page, 'signers-frozen')

  // 7 · the frozen phone's removal (F2 allows it: no unfrozen signer is named) is scheduled: it waits the wallet's delay,
  //     and the chain counts it until then
  await signers.getByRole('listitem').filter({ hasText: 'Frozen on the chain' }).getByRole('button', { name: 'Remove' }).click()
  await approveHere(page, /removeSigners/)
  await expect(signers.getByText(`Removing "${phoneKey.name}" takes effect on `, { exact: false })).toBeVisible({ timeout: 60_000 })
  const waiting = signers.getByRole('listitem').filter({ hasText: /Removing "/ })
  await expect(waiting).toBeVisible()
  chain = await railGet(`/workspaces/${railId}/signers`)
  const removal = chain.signers.find((s: { x: string }) => s.x === `0x${phoneKey.x}`).pendingRemoval as string
  expect(removal).toMatch(/^0x[0-9a-f]{64}$/)
  expect(chain.memberCount).toBe(2)
  await accessible(page, 'section.wallet-signers')
  await shot(page, 'signers-removal-scheduled')

  // 8 · cancel it: only the laptop is offered (a passkey cannot cancel its own removal), and the removal is gone on the chain
  await waiting.getByRole('button', { name: 'Cancel it' }).click()
  await approveHere(page, /Cancelling the scheduled change/)
  await expect(signers.getByText('Cancelled: the change that was waiting will not happen.', { exact: false })).toBeVisible({ timeout: 60_000 })
  await expect(signers.getByText('Being removed', { exact: true })).toHaveCount(0)
  chain = await railGet(`/workspaces/${railId}/signers`)
  expect(chain.signers.every((s: { pendingRemoval: string | null }) => s.pendingRemoval === null)).toBe(true)
  expect((await railGet(`/workspaces/${railId}/scheduled`)).scheduled.find((c: { changeId: string }) => c.changeId === removal).status).toBe('cancelled')
  const cancelSigner = query<{ credential_id: string }>(`SELECT s.credential_id FROM approval_signatures s JOIN approvals a ON a.id = s.approval_id WHERE a.user_id = ? AND a.document LIKE '%"action":"cancel-change"%' AND a.document LIKE ?`, me!.id, `%${removal.slice(2)}%`)
  // this removal's cancellation: the laptop signed it and the phone, whose removal it was, did not (a passkey cannot cancel
  // its own removal); after step 5 the person's other passkey may confirm it too
  expect(cancelSigner.map((r) => r.credential_id)).toContain(laptopKey.id)
  expect(cancelSigner.map((r) => r.credential_id)).not.toContain(phoneKey.id)

  // the code never left the page, however it was typed
  const flat = sent.join('\n').toUpperCase().replace(/[\s-]/g, '')
  expect(flat).not.toContain(code.replace(/-/g, ''))
  expect(errors).toEqual([])
})
