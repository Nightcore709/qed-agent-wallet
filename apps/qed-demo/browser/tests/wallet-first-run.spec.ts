/**
 * R14, Priority 2: a new account sets up its on-chain wallet and pays from it, on a stack configured as production is:
 * one public origin with a host name (QED_PUBLIC_ORIGIN, the relying party that host), and production's delays (a
 * passkey added beside another waits 24 hours, a recovery 72). Chrome's virtual authenticator stands for the device.
 *
 *   1. Password first (the owner's own account on 25 Nov): account, "Not now" to the passkey, Home's "Set up your
 *      on-chain wallet". The wallet's page says what is missing and makes the passkey in place: the password again, then
 *      the device. A wrong password is refused in words that say so. That first passkey has no 24-hour wait and alone
 *      owns the wallet: created, accepted (the opening grant of test tokens arrives), every service restarted, a mandate
 *      signed, a payment made on the chain and its record opened. Each figure is read from the wallet service too.
 *   2. Passkey first: account with a passkey, wallet created and accepted at the same origin.
 *   3. No usable authenticator: a browser without passkeys is told exactly that and what to use instead; a device with no
 *      screen lock is told what its browser will offer. Neither is left with a greyed button and no reason.
 *
 * The sentence that sends a person from Spend and Save to the wallet's page is one sentence at every width: its link and
 * the words after it share a line (it was three rows: the sentence, "Set it up", ", then use it from here.").
 */
import { randomBytes } from 'node:crypto'
import { expect, type Locator, type Page, test } from '../support/test.ts'
import { answered } from '../support/answer.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { railGet, type RailAt, shot } from '../support/vault.ts'

const PORT = Number(process.env.QED_FIRST_RUN_PORT ?? extraPort(60))
const ORIGIN = `http://qed.localhost:${PORT}`
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
let rail: RailAt
test.beforeAll(async () => {
  test.setTimeout(180_000)
  // production's code path: one public origin, its host the relying party; `localhost` is named for the stack's own
  // health probe only (it reaches no page and no account); production's delays, not the suite's shortened ones
  s = await startExtraStack(PORT, { QED_PUBLIC_ORIGIN: ORIGIN, QED_EXTRA_HOSTS: `localhost:${PORT}`, QED_COOL_OFF_SEC: '86400', QED_RECOVERY_DELAY_SEC: '259200', QED_PROTECTION_DELAY_SEC: '259200' }, { rail: true })
  rail = { port: s.railPort, dir: `${s.dir}/vault` }
})
test.afterAll(async () => { await s?.stop() })

const unique = (p: string) => `${p}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

/** Where a sentence's link and the words after it sit: on one line, the words after the link's end (no line begins with the comma). */
async function sentence(p: Locator): Promise<{ display: string; afterOnLinkLine: boolean; afterFollowsLink: boolean; lines: number }> {
  return p.evaluate((el) => {
    const link = el.querySelector('a')!, after = link.nextSibling as Text
    const r = document.createRange()
    r.setStart(after, 0); r.setEnd(after, 1)
    const first = r.getBoundingClientRect(), rects = link.getClientRects(), last = rects[rects.length - 1]!
    r.selectNodeContents(el)
    const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)))
    return { display: getComputedStyle(el).display, afterOnLinkLine: Math.abs(first.top - last.top) < last.height / 2, afterFollowsLink: first.left >= last.right - 1, lines: tops.size }
  })
}

async function approveInSheet(page: Page): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
}

async function passwordAccount(page: Page, handle: string, password: string): Promise<void> {
  await page.goto(`${ORIGIN}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Test')
  await page.getByRole('radio', { name: /With a password/ }).check()
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create account with a password' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Add the passkey that approves payments' })).toBeVisible()
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('heading', { name: /Finish setting up/ })).toBeVisible()
}

test('password first: the wallet page makes the passkey in place, and the account reaches a payment on the chain and its record, across a restart', async ({ page }) => {
  test.setTimeout(420_000)
  const handle = unique('pwf'), password = `${randomBytes(9).toString('base64url')} lantern`
  await addAuthenticator(page)
  await passwordAccount(page, handle, password)
  const person = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id

  // Spend, before anything is set up: one sentence, with its link inside it, at a desktop's width and a phone's
  await page.goto(`${ORIGIN}/pay`)
  await page.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
  const missing = page.locator('.vt-wmissing')
  await expect(missing).toHaveText('Your on-chain wallet is not set up yet. Set it up, then use it from here.')
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 860 })
    const at = await sentence(missing)
    expect(at, `at ${width} px`).toMatchObject({ display: 'block', afterOnLinkLine: true, afterFollowsLink: true })
    expect(at.lines, `at ${width} px`).toBeLessThanOrEqual(2)
    await shot(page, `r14-spend-wallet-not-set-up-${width}`)
  }
  await page.setViewportSize({ width: 1280, height: 860 })
  // Save says it the same way
  await page.goto(`${ORIGIN}/save`)
  await expect(page.locator('.vt-wmissing')).toHaveText('Your on-chain wallet is not set up yet. Set it up, then use it from here.')
  expect(await sentence(page.locator('.vt-wmissing'))).toMatchObject({ display: 'block', afterOnLinkLine: true, afterFollowsLink: true })

  // Home's own list leads to the wallet's page, which says what is missing and offers it there
  await page.goto(`${ORIGIN}/`)
  await page.getByRole('link', { name: /Set up your on-chain wallet/ }).click()
  await expect(page.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  const gate = page.getByRole('group', { name: 'First, a passkey on this device' })
  await expect(gate).toContainText('This account signs in with a password, and a wallet is owned by a passkey')
  const setUp = page.getByRole('button', { name: 'Confirm with your passkey and set it up' })
  await expect(setUp).toBeDisabled()
  await expect(page.getByRole('region', { name: 'Your wallet', exact: true })).toContainText('No passkey yet that can own it: see the first step.')
  await shot(page, 'r14-wallet-first-passkey-1280')
  await page.setViewportSize({ width: 390, height: 860 })
  await expect(gate.getByRole('button', { name: 'Create a passkey on this device' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scroll at 390 px').toBe(true)
  await shot(page, 'r14-wallet-first-passkey-390')
  await page.setViewportSize({ width: 1280, height: 860 })

  // a wrong password is refused in words, nothing is made, and the form is still there
  await gate.getByLabel('Your password').fill('not the password at all')
  await answered(page, 'POST', '/api/auth/stepup', () => gate.getByRole('button', { name: 'Create a passkey on this device' }).click())
  await expect(gate.getByRole('alert')).toContainText(/password/i)
  await shot(page, 'r14-wallet-wrong-password')
  expect(s.query('SELECT 1 FROM webauthn_credentials WHERE person_id = ?', person)).toHaveLength(0)

  // the right one: the device makes the passkey; it has no 24-hour wait, because the account has no older passkey
  await gate.getByLabel('Your password').fill(password)
  await gate.getByRole('button', { name: 'Create a passkey on this device' }).click()
  await expect(gate).toHaveCount(0, { timeout: 20_000 })
  const creds = s.query<{ id: string; cool_off_until: number | null; authority: string }>('SELECT id, cool_off_until, authority FROM webauthn_credentials WHERE person_id = ?', person)
  expect(creds).toHaveLength(1)
  expect(creds[0]).toMatchObject({ cool_off_until: null, authority: 'full' })
  await expect(page.getByRole('region', { name: 'Your wallet', exact: true })).toContainText('your passkey. One signature is enough.')

  // create: a confirmation with that passkey, then the wallet exists and is offered to it alone
  await expect(setUp).toBeEnabled()
  await shot(page, 'r14-wallet-passkey-made-ready')
  await setUp.click()
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  const record = JSON.parse(s.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', `vault.workspace:${person}`)[0]!.value) as { railId: string; credentialIds: string[]; request: { origin: string; owner: { signers: unknown[]; threshold: number } } }
  expect(record.credentialIds).toEqual([creds[0]!.id])
  expect(record.request.origin).toBe(ORIGIN)
  expect(record.request.owner).toMatchObject({ threshold: 1 })
  expect(record.request.owner.signers).toHaveLength(1)
  const ws = `/workspaces/${record.railId}`
  expect((await railGet(ws, rail)).status).toBe('awaiting-acceptance')
  expect((await railGet(`${ws}/state`, rail)).treasury.balance).toBe('0')

  // Spend now says the next step, not "not set up"
  await page.goto(`${ORIGIN}/pay`)
  await page.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
  await expect(page.locator('.vt-wmissing')).toHaveText('Your on-chain wallet is created and waiting for you to accept it. Accept it, then use it from here.')
  await page.locator('.vt-wmissing').getByRole('link', { name: 'Accept it' }).click()

  // accept: the passkey signs the owner account's own digest; the opening grant of test tokens arrives
  await page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
  await approveInSheet(page)
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(page.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('heading', { level: 1 })).toContainText('accepted ownership of the treasury and reserve vaults')
  const funded = await railGet(`${ws}/state`, rail)
  expect(funded.provisioned).toBe(true)
  expect(BigInt(funded.treasury.balance)).toBeGreaterThan(0n)

  // every service stopped and started again on the same data: the wallet, its money and the session are as they were
  await s.restart()
  expect((await railGet(`${ws}/state`, rail)).treasury.balance).toBe(funded.treasury.balance)
  await page.goto(`${ORIGIN}/vault`)
  await expect(page.getByRole('region', { name: 'Treasury', exact: true }).locator('.lead')).toHaveText('₹1,00,000.00', { timeout: 30_000 })

  // the first signed mandate, from Protect
  await page.goto(`${ORIGIN}/protect`)
  await page.getByRole('button', { name: 'Write a mandate' }).click()
  const mandate = page.getByRole('form', { name: 'A new mandate for your on-chain wallet' })
  await mandate.getByLabel('Most in one payment, in test rupees').fill('2500')
  await mandate.getByRole('button', { name: 'Review and sign' }).click()
  await approveInSheet(page)
  await expect(page.getByText('Signed: the new mandate is in force on the chain.')).toBeVisible({ timeout: 90_000 })
  expect((await railGet(`${ws}/state`, rail)).mandate?.status).toBe('active')

  // the first payment on the chain, from Spend, and its record
  const before = await railGet(`${ws}/state`, rail)
  await page.goto(`${ORIGIN}/pay`)
  await page.getByRole('group', { name: 'Pay from' }).getByRole('button', { name: 'On-chain wallet' }).click()
  const pay = page.getByRole('form', { name: 'Pay from your on-chain wallet' })
  await expect(pay.getByText(/Most that can be paid now/)).toBeVisible({ timeout: 30_000 })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'Review and sign' }).click()
  await approveInSheet(page)
  await expect(pay.getByText('Paid ₹3.00 in test rupees to CloudCo from your on-chain wallet.')).toBeVisible({ timeout: 90_000 })
  const after = await railGet(`${ws}/state`, rail)
  const units = ((await (await page.request.get(`${ORIGIN}/api/vault`)).json()) as { workspace: { asset: { decimals: number } } }).workspace.asset.decimals
  expect(BigInt(before.treasury.balance) - BigInt(after.treasury.balance)).toBe(3n * 10n ** BigInt(units))
  await pay.getByRole('link', { name: 'Open its record' }).click()
  await page.waitForURL(/\/vault\/job\//)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')
  await expect(page.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible()
  // what the account's own history says of the path: the first passkey, then the wallet
  const events = s.query<{ kind: string }>('SELECT kind FROM security_events WHERE person_id = ? ORDER BY ts', person).map((e) => e.kind)
  expect(events).toContain('first-passkey-added')
  expect(s.query(`SELECT 1 FROM audit WHERE action = 'vault.setup' AND user_id = ? AND subject = ?`, person, record.railId)).toHaveLength(1)
})

test('passkey first: an account made with a passkey creates and accepts its wallet at the same origin', async ({ page }) => {
  test.setTimeout(240_000)
  const handle = unique('pkf')
  await addAuthenticator(page)
  await page.goto(`${ORIGIN}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Asha Test')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10)
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  await page.goto(`${ORIGIN}/vault`)
  await expect(page.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  // nothing stands in the way: no passkey step, and the button is ready
  await expect(page.getByRole('group', { name: 'First, a passkey on this device' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Confirm with your passkey and set it up' }).click()
  await expect(page.getByText('Your wallet is waiting for you to accept it')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Review it and accept with your passkey' }).click()
  await approveInSheet(page)
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(page.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible({ timeout: 90_000 })
  const person = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
  const railId = (JSON.parse(s.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', `vault.workspace:${person}`)[0]!.value) as { railId: string }).railId
  expect((await railGet(`/workspaces/${railId}/state`, rail)).provisioned).toBe(true)
})

test('no usable authenticator: a browser without passkeys, and a device with no screen lock, are each told why and what to use instead', async ({ browser }) => {
  test.setTimeout(240_000)
  // a browser with no passkey support at all (WebAuthn absent)
  const none = await browser.newContext()
  const a = await none.newPage()
  await a.addInitScript(() => { Reflect.deleteProperty(window, 'PublicKeyCredential'); (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false })
  await passwordAccount(a, unique('nopk'), `${randomBytes(9).toString('base64url')} lantern`)
  await a.goto(`${ORIGIN}/vault`)
  await expect(a.getByRole('heading', { name: 'Set up your wallet' })).toBeVisible({ timeout: 20_000 })
  const cannot = a.locator('.note').filter({ hasText: 'This browser cannot make a passkey' })
  await expect(cannot).toContainText('A wallet is owned by a passkey, and this browser has no support for them')
  await expect(cannot).toContainText('Open QED in a current Chrome, Safari, Edge or Firefox, on a phone or computer with a screen lock, and sign in there with your handle and password')
  await expect(a.getByRole('button', { name: 'Confirm with your passkey and set it up' })).toBeDisabled()
  await expect(a.getByRole('button', { name: 'Create a passkey on this device' })).toHaveCount(0)
  await shot(a, 'r14-wallet-browser-without-passkeys')

  // a device whose browser has passkeys but which has no screen lock of its own for one
  const bare = await browser.newContext()
  const b = await bare.newPage()
  await b.addInitScript(() => {
    (window as unknown as { qedTestAutofill: boolean }).qedTestAutofill = false
    Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { value: () => Promise.resolve(false) })
  })
  await passwordAccount(b, unique('bare'), `${randomBytes(9).toString('base64url')} lantern`)
  await b.goto(`${ORIGIN}/vault`)
  const gate = b.getByRole('group', { name: 'First, a passkey on this device' })
  await expect(gate).toContainText('This device has no screen lock a passkey can use')
  await expect(gate).toContainText('your browser offers a phone nearby (scan its code with the phone\'s camera) or a security key with a PIN')
  // the way on is still offered: the password, then the browser's own choice of where the passkey is kept
  await expect(gate.getByRole('button', { name: 'Create a passkey on this device' })).toBeVisible()
  await shot(b, 'r14-wallet-device-without-screen-lock')
})
