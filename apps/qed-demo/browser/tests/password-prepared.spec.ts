/**
 * Work prepared in a session opened with a password, in the browser (RISK-076's last item). The owner's account has a
 * password and a passkey, and the owner signs in with the passkey. A second browser signs in with the password, as a
 * phished password would let someone do, and adds a payee. When the owner pays that payee, the approval sheet says,
 * before the passkey can be asked, that the payee was added in a password session and when; the passkey stays unoffered
 * until the sheet has read that; and the signed document carries the same sentence. A payee the owner added with the
 * passkey brings no such sentence. Security's history tells the owner that a payee was added in a password session.
 */
import { randomBytes } from 'node:crypto'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '../support/test.ts'
import { answered } from '../support/answer.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend, choosePayeeOnSpend } from '../support/payee.ts'
import { allowSignups, query } from '../support/stack.ts'
import { shot } from '../support/vault.ts'

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
/** "14:02 IST on 23 Nov 2026", worked out here apart from the server's own formatter. */
function atIst(ms: number): string {
  const t = new Date(ms + 330 * 60_000), p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())} IST on ${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

test('a payee added in a password session is named as such on the approval sheet before the passkey is offered, in the signed document, and in Security', async ({ browser }) => {
  test.setTimeout(180_000)
  allowSignups()
  const handle = unique('pp'), password = `${randomBytes(9).toString('base64url')} phrase`
  const owner = await (await browser.newContext()).newPage()
  await addAuthenticator(owner)
  const errors: string[] = []
  owner.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  // An account opened with a password, its household opened, then a passkey made after typing the password again.
  await owner.goto('/')
  await owner.getByRole('button', { name: 'Create an account' }).click()
  await owner.getByText('Choose your handle (optional)').click()
  await owner.getByLabel('Handle').fill(handle)
  await owner.getByLabel('Name to sign with').fill('Prepared Owner')
  // R14: the ordinary sign-up is an email address and a password
  await owner.getByLabel('Email', { exact: true }).fill(`${handle}@example.in`)
  await owner.getByLabel('Password', { exact: true }).fill(password)
  await owner.getByRole('button', { name: 'Create account', exact: true }).click()
  await owner.getByRole('button', { name: 'Not now' }).click()
  await owner.getByRole('button', { name: 'Open the household' }).click()
  await expect(owner.getByRole('heading', { name: /Finish setting up/ })).toBeVisible()
  await owner.goto('/security')
  const note = owner.locator('.note').filter({ hasText: 'This account has no passkey' })
  await note.getByLabel('Password').fill(password)
  await note.getByRole('button', { name: 'Create a passkey' }).click()
  await expect(owner.getByText('This account has no passkey')).toHaveCount(0)
  // The owner signs out and back in with the passkey.
  await owner.getByRole('button', { name: /account menu$/ }).click()
  await owner.getByRole('button', { name: 'Sign out' }).click()
  await owner.getByRole('button', { name: 'Sign in with your fingerprint, Face ID or device PIN' }).click()
  await expect.poll(async () => (await owner.evaluate(async () => (await fetch('/api/session')).json()) as { authMethod?: string }).authMethod).toBe('passkey')
  const [person] = query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // Someone else signs in with the password and adds a payee.
  const other = await (await browser.newContext()).newPage()
  await other.goto('/')
  await other.getByLabel('Handle').fill(handle)
  await other.getByLabel('Password', { exact: true }).fill(password)
  // the server checks the password with scrypt (slow on purpose): what follows is checked once it has answered
  await answered(other, 'POST', '/api/auth/login', () => other.getByRole('button', { name: 'Sign in with your password' }).click())
  await expect(other.getByRole('heading', { level: 1, name: 'Your money' })).toBeVisible()
  await other.goto('/pay')
  await addPayeeOnSpend(other, 'Look Alike', 'look.alike@upi')
  const [added] = query<{ at: number; method: string }>(`SELECT p.at, p.method FROM payees y JOIN prepared p ON p.kind = 'payee' AND p.subject = y.id WHERE y.user_id = ? AND y.handle = 'look.alike@upi'`, person!.id)
  expect(added!.method).toBe('password')
  const said = `The payee Look Alike (look.alike@upi) was added in a password session at ${atIst(added!.at)}, not with a passkey.`

  // The owner pays it. The sheet's reading of the request is held back for a moment: until it arrives the passkey is
  // not offered; then the sentence is shown above the document.
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await owner.route(/\/api\/approvals\/apr_[^/]+$/, async (route) => { if (route.request().method() === 'GET') await held; await route.continue() })
  await owner.goto('/pay')
  await choosePayeeOnSpend(owner, 'look.alike@upi')
  await owner.getByLabel('How much').fill('1200')
  await owner.getByRole('button', { name: 'See what this would do' }).click()
  const sheet = owner.getByRole('dialog')
  const approve = sheet.getByRole('button', { name: 'Approve and send with your passkey' })
  await expect(sheet.getByText('Pay ₹1,200 to Look Alike', { exact: false }).first()).toBeVisible()
  await expect(approve).toBeDisabled()
  release()
  const warn = sheet.locator('.note').filter({ hasText: 'Not all of this was prepared with a passkey' })
  await expect(warn.getByText(said, { exact: true })).toBeVisible()
  await expect(warn.getByText('If this is not your own work, do not approve it.')).toBeVisible()
  await expect(approve).toBeEnabled()
  await owner.unroute(/\/api\/approvals\/apr_[^/]+$/)
  await shot(owner, 'prepared-sheet')
  if (process.env.QED_SHOTS) { await owner.setViewportSize({ width: 390, height: 844 }); await shot(owner, 'prepared-sheet-390'); await owner.setViewportSize({ width: 1280, height: 860 }) }
  const axe = await new AxeBuilder({ page: owner as never }).include('dialog.sheet[open]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(axe.violations.map((v) => v.id)).toEqual([])
  await approve.click()
  const signedDocs = () => query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'action' AND confirmed_at IS NOT NULL ORDER BY confirmed_at`, person!.id)
  await expect.poll(() => signedDocs().length, { timeout: 20_000 }).toBe(1)
  expect(JSON.parse(signedDocs()[0]!.document).prepared).toEqual([said])

  // A payee the owner adds with the passkey: no such sentence, and the passkey is offered as before.
  await owner.goto('/pay')
  // exact: the button for a payee abroad ("Add a payee abroad") arrives a moment later, with Spend's lazily loaded abroad section
  await owner.getByRole('button', { name: 'Add a payee', exact: true }).click()
  await addPayeeOnSpend(owner, 'Corner Shop', 'corner.shop@upi')
  await owner.getByLabel('How much').fill('300')
  await owner.getByRole('button', { name: 'See what this would do' }).click()
  await expect(sheet.getByRole('button', { name: 'Approve and send with your passkey' })).toBeEnabled()
  await expect(sheet.getByText('Not all of this was prepared with a passkey')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Not now' }).click()

  // Security's history tells the owner.
  await owner.goto('/security')
  const history = owner.getByRole('region', { name: 'What happened' })
  await expect(history.getByText('A payee was added in a session opened with a password, not with a passkey: Look Alike (look.alike@upi)')).toBeVisible()
  await shot(owner, 'prepared-security')
  expect(errors).toEqual([])
})
