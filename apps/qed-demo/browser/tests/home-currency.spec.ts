/**
 * A household whose home currency is the pound (R13 S7, S8): it chooses sterling at set-up, reads the example figures in pounds with
 * the rate and source they were converted at, opens its paper bank in pounds, sees every figure in pounds on Home, Save and Pay
 * (no rupee sign anywhere), saves for a goal, and pays a payee, each signed with the passkey. The database is the judge: its bank
 * and set-aside accounts are kept in pounds, its profile holds the rate it started from, its documents state their currency (format
 * 2), and a household that chose nothing has no home currency written. Parts that price in rupees are not offered to it.
 *
 * Its own stack (synthetic prices, no network, no chain).
 */
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_HOMECCY_PORT ?? extraPort(100))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

async function signUp(page: Page, handle: string): Promise<void> {
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
}
const bodyText = (page: Page): Promise<string> => page.locator('body').innerText()

test('a pound household sets up, reads pounds, saves for a goal and pays', async ({ browser }) => {
  test.setTimeout(240_000)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const handle = `ccy${Date.now().toString(36)}`
  await signUp(page, handle)

  // ---- set-up: the rupee is the default; sterling converts the example once, and says at what rate and from where
  await expect(page.getByLabel('Home currency')).toHaveValue('INR')
  await expect(page.locator('.sp-figure')).toContainText('₹')
  await page.getByLabel('Home currency').selectOption('GBP')
  // the rate first, then where it comes from (R14: the note leads with the figure; the same facts as the server's sentence)
  await expect(page.getByText('The example figures are converted at 123.1363 rupees to one Pound sterling.')).toBeVisible()
  await expect(page.getByText(/Rate: FBIL reference rate as at 1\.00 pm IST on 18 Nov 2026.*\(historical\)\. Rounded to two significant figures: opening and monthly figures to the nearest, thresholds down\./)).toBeVisible()
  await expect(page.locator('.sp-figure')).toContainText('£')
  expect(await page.locator('.setup').innerText()).not.toContain('₹')
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [me] = s.query<{ id: string; profile_json: string }>('SELECT id, profile_json FROM users WHERE handle = ?', handle)
  const profile = JSON.parse(me!.profile_json) as { homeCurrency: string; homeBasis: { rupeesPerUnit: string; label: string }; line: number }
  expect(profile.homeCurrency).toBe('GBP')
  expect(profile.homeBasis).toMatchObject({ rupeesPerUnit: '123.1363', label: 'historical' })
  expect(s.query('SELECT code, asset_id FROM accounts WHERE user_id = ? AND code IN (?, ?)', me!.id, 'bank', 'card')).toEqual([{ code: 'bank', asset_id: 'GBP' }, { code: 'card', asset_id: 'GBP' }])
  expect(s.query<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, me!.id)).toEqual([{ t: '650000' }]) // £6,500

  // ---- Home, Save and Pay read in pounds, with no rupee sign and no rupee-only panel
  for (const path of ['/', '/save', '/pay']) {
    await page.goto(`${s.base}${path}`)
    await expect(page.locator('main').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    const text = await bodyText(page)
    expect(text, `${path} reads pounds`).toContain('£')
    expect(text.match(/.{0,40}₹.{0,40}/g) ?? [], `${path} has no rupee sign`).toEqual([])
  }
  expect(profile.line).toBe(410_000) // the floor, ₹5,00,000 at that rate: £4,100

  // ---- Save: a goal of £5,000, QED's monthly figure in pounds, signed with the passkey
  await page.goto(`${s.base}/save`)
  const goals = page.locator('#goals')
  await goals.getByRole('link', { name: 'Save for a goal' }).click()
  await expect(page).toHaveURL(/\/instructions\/new\?kind=goal$/)
  const today = new Date(Date.now() + 19_800_000)
  const by = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 5, 0)).toISOString().slice(0, 10)
  await page.getByLabel('What it is for').fill('Holiday in March')
  await page.getByLabel('How much').fill('5000')
  await page.getByLabel('By', { exact: true }).fill(by)
  const live = page.locator('aside.pr-cw-live')
  await expect(live.getByText('QED works out')).toBeVisible()
  expect((await live.locator('.pr-cw-says-big').innerText()).split('\n')[0]).toMatch(/^£[\d,]+ a month$/)
  await page.getByRole('button', { name: 'Review and sign' }).click()
  const sheet = page.getByRole('dialog', { name: 'Sign this instruction' })
  await expect(sheet.getByText(/^Move £[\d,]+ from your bank account into the set-aside for Holiday in March on day \d+ of each month, until .+ or until £5,000 is set aside\.$/)).toBeVisible()
  await sheet.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [prog] = s.query<{ id: string; document: string }>(`SELECT p.id, v.document FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.kind = 'goal'`, me!.id)
  expect(JSON.parse(prog!.document)).toMatchObject({ v: 2, timeZone: 'Asia/Kolkata' })
  expect(await bodyText(page)).not.toContain('₹')

  // ---- Pay: a payee added, £50 paid, approved with the passkey (below £81, the pound figure of the ₹10,000 step-up)
  await page.goto(`${s.base}/pay`)
  await page.getByLabel('Name', { exact: true }).fill('Ravi Kumar')
  await page.getByLabel('Payment address').fill('ravi.kumar@upi')
  await page.getByRole('button', { name: 'Add this payee' }).click()
  await expect(page.getByRole('radiogroup', { name: 'To' }).getByRole('radio', { name: 'Ravi Kumar (ravi.kumar@upi)' })).toBeChecked()
  await page.getByLabel('How much').fill('50')
  await page.getByRole('button', { name: 'See what this would do' }).click()
  const pay = page.getByRole('dialog')
  await expect(pay.getByText(/£50/).first()).toBeVisible()
  expect(await pay.innerText()).not.toContain('₹')
  await pay.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(pay).toBeHidden()
  await expect.poll(() => s.query<{ state: string }>(`SELECT state FROM actions WHERE user_id = ? AND kind = 'payment' AND origin = 'owner'`, me!.id).map((r) => r.state), { timeout: 60_000 }).toEqual(['done'])
  const [approval] = s.query<{ document: string }>(`SELECT document FROM approvals WHERE user_id = ? AND purpose = 'action'`, me!.id)
  expect(JSON.parse(approval!.document)).toMatchObject({ v: 2, currency: 'GBP', instrumentId: 'iso4217:GBP', timeZone: 'Asia/Kolkata', thresholds: { currency: 'GBP', stepUp: 8100 }, sizePaise: 5000 })
  expect(s.query<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'bank'`, me!.id)).toEqual([{ t: '645000' }])

  // ---- what prices in rupees is closed, with the reason, never converted
  const closed = await page.evaluate(async () => { const r = await fetch('/api/money'); return { status: r.status, body: await r.json() } })
  expect(closed.status).toBe(409)
  expect(closed.body.error).toMatchObject({ code: 'rupees_only' })
  expect(closed.body.error.message).toMatch(/works in rupees only, and your home currency is Pound sterling \(GBP\)/)
  // ---- the home currency is not changed afterwards: refused with the reason, not ignored
  const csrf = await page.evaluate(async () => (await (await fetch('/api/session')).json()).csrf as string)
  const change = await page.evaluate(async (token) => { const r = await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': token }, body: JSON.stringify({ homeCurrency: 'INR' }) }); return { status: r.status, body: await r.json() } }, csrf)
  expect(change.status).toBe(409)
  expect(change.body.error).toMatchObject({ code: 'home_currency_fixed' })
  expect(change.body.error.message).toMatch(/Your home currency is Pound sterling \(GBP\)/)
  expect(JSON.parse(s.query<{ profile_json: string }>('SELECT profile_json FROM users WHERE id = ?', me!.id)[0]!.profile_json).homeCurrency).toBe('GBP')
  expect(errors).toEqual([])

  // ---- a household that chose nothing has no home currency written, and reads rupees
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page2 = await ctx2.newPage()
  await addAuthenticator(page2)
  const handle2 = `inr${Date.now().toString(36)}`
  await signUp(page2, handle2)
  await page2.getByRole('button', { name: 'Open the household' }).click()
  await expect(page2.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [other] = s.query<{ profile_json: string }>('SELECT profile_json FROM users WHERE handle = ?', handle2)
  expect(other!.profile_json).not.toContain('homeCurrency')
  await page2.goto(`${s.base}/`)
  await page2.waitForLoadState('networkidle')
  expect(await bodyText(page2)).toContain('₹')
})
