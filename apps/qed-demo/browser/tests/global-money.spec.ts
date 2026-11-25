/**
 * Money in other currencies, in the browser (R13; R10-003: "a payment and a conversion across at least three currencies or
 * assets of different precision ... with the route, fees, FX provenance, settlement and finality shown and reconciled; an
 * unsupported route is refused with its reason, never rerouted silently"; R7-038: indicative, executable and fill apart,
 * an expired quote shown as expired).
 *
 * A household changes rupees into yen (no decimal places) and Bahraini dinars (three), each at an executable quote of the
 * paper desk approved with the passkey; sees each balance in its own currency and a total that names its rates; pays a
 * payee in the United States in dollars (two) from rupees at a quote, and one in Japan from its yen balance; a payee in
 * Germany who is to receive dollars is refused, with the reason, and nothing is rerouted; the same dollar payment again is
 * held for confirmation; a quote left too long is shown as expired. The database is the judge of what was filled, paid
 * and booked: every currency balances on its own.
 *
 * Its own stack (synthetic prices, no network, no chain), with quotes that hold for 20 seconds so the expiry is seen
 * without a long wait. With QED_GLOBAL_SHOTS set to a folder, the screens are photographed there at 1440 and 390 px.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_GLOBAL_PORT ?? extraPort(38))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_QUOTE_TTL_SEC: '20' }) })
test.afterAll(async () => { await s?.stop() })

const SHOTS = process.env.QED_GLOBAL_SHOTS
async function shot(page: Page, name: string, part: Locator): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await part.scrollIntoViewIfNeeded()
    await part.screenshot({ path: join(SHOTS, `${name}-${width}.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1280, height: 860 })
}

/** Approve what the sheet shows with the passkey, in one step. */
async function approveSheet(page: Page, title: string, action: string): Promise<Locator> {
  const sheet = page.getByRole('dialog', { name: title })
  await expect(sheet).toBeVisible()
  return sheet.getByRole('button', { name: `${action} with your passkey` }).click().then(() => sheet)
}

test('converts and pays across zero, two and three decimal places; refuses a route it does not offer; holds a duplicate; shows an expired quote', async ({ browser }) => {
  test.setTimeout(240_000)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const handle = `globe${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Meera Iyer')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByLabel('I have stored these codes somewhere other than this device').check()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [me] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // ---- Save: change rupees into yen (0 places) and dinars (3 places) at executable quotes, each approved with the passkey
  await page.goto(`${s.base}/save`)
  const desk = page.locator('section.fx-desk')
  await expect(desk.getByRole('heading', { name: 'Change money between currencies' })).toBeVisible()
  for (const [code, amount, shown] of [['JPY', '50000', 'JPY 50,000'], ['BHD', '25.500', 'BHD 25.500']] as const) {
    await desk.getByLabel('Into').selectOption(code)
    await desk.getByRole('button', { name: 'Receive' }).click()
    await desk.getByLabel(`Amount in ${code}`).fill(amount)
    await desk.getByRole('button', { name: 'Get a quote' }).click()
    const sheet = page.getByRole('dialog', { name: 'Approve this conversion' })
    await expect(sheet).toBeVisible()
    // the executable rate, the reference (labelled as such), the spread and the fee, each apart, and when the quote expires
    for (const label of ['Rate', 'Reference', 'Spread', 'Fee', 'You pay', 'You receive', 'Quote expires']) await expect(sheet.getByText(label, { exact: true })).toBeVisible()
    await expect(sheet.getByText(/nobody can trade at it/).first()).toBeVisible()
    await expect(sheet.getByText(shown, { exact: true })).toBeVisible()
    if (code === 'JPY') await shot(page, 'r13-quote-sheet', sheet)
    await approveSheet(page, 'Approve this conversion', 'Approve and convert')
    await expect(sheet).toBeHidden()
    const fill = desk.getByRole('article', { name: 'The conversion' })
    await expect(fill).toContainText(shown)
    await expect(fill).toContainText('Filled at')
    await expect(fill).toContainText('Spread')
    await expect(fill).toContainText('₹50.00')
  }
  // a conversion into a held balance counts toward the Liberalised Remittance Scheme, and the screen says so: in one line
  // beside the button, and in full behind the disclosure under it (R14: the long rules are one press away, every word kept)
  await expect(desk.getByText('Rupees changed count towards the Liberalised Remittance Scheme at once.')).toBeVisible()
  await desk.getByText('How the rate is rounded, the desk\'s spread, and what counts towards the scheme').click()
  await expect(page.getByTestId('lrs-held-note')).toBeVisible()
  await expect(page.getByTestId('lrs-held-note')).toContainText('even when the money stays in your account here')
  const balances = page.getByTestId('by-currency-save')
  await expect(balances.locator('[data-currency="JPY"] .ccy-bal')).toHaveText('JPY 50,000')
  await expect(balances.locator('[data-currency="BHD"] .ccy-bal')).toHaveText('BHD 25.500')
  await expect(balances.getByTestId('ccy-total')).toHaveText(/^about ₹[\d,]+\.\d\d$/)
  await expect(balances.locator('[data-currency="JPY"] .ccy-val')).toContainText('at ₹0.586 per JPY')
  await expect(balances.locator('[data-currency="JPY"] .ccy-val')).toContainText('recorded reference, observed 18 Nov 2026')
  await expect(balances.locator('[data-currency="BHD"] .ccy-val')).toContainText('recorded reference')
  await shot(page, 'r13-save-currencies', page.locator('.ccy-save'))

  // ---- a quote left too long is shown as expired, and cannot be approved
  await desk.getByLabel('Into').selectOption('USD')
  await desk.getByLabel('Amount in USD').fill('10.00')
  await desk.getByRole('button', { name: 'Get a quote' }).click()
  const stale = page.getByRole('dialog', { name: 'Approve this conversion' })
  await expect(stale.getByText('This request has expired; close it and prepare it again.')).toBeVisible({ timeout: 30_000 })
  await expect(stale.getByRole('button', { name: 'Approve and convert with your passkey' })).toBeDisabled()
  await stale.getByRole('button', { name: 'Not now' }).click()

  // ---- Home: holdings by currency, with a total that names its rates and their time
  await page.goto(`${s.base}/`)
  const home = page.getByTestId('by-currency-home')
  await expect(home.getByRole('heading', { name: 'Holdings by currency' })).toBeVisible()
  await expect(home.locator('[data-currency="INR"] .ccy-bal')).toHaveText(/^₹/)
  await expect(home.locator('[data-currency="JPY"] .ccy-bal')).toHaveText('JPY 50,000')
  await expect(home.getByTestId('ccy-total')).toHaveText(/^about ₹/)
  await expect(home.getByText(/converted exactly at its reference rate; the sum is rounded once/)).toBeVisible()
  await shot(page, 'r13-home-currencies', home)

  // ---- Spend: a payee in the United States, paid in dollars (2 places) from rupees at a quote
  await page.goto(`${s.base}/pay`)
  const ab = page.locator('section#abroad')
  await expect(ab.getByRole('heading', { name: 'Pay someone abroad' })).toBeVisible()
  const addPayee = async (name: string, country: string, currency: string, fields: [string, string][]) => {
    await ab.getByRole('button', { name: 'Add a payee abroad' }).click()
    const form = ab.getByRole('form', { name: 'Add a payee abroad' })
    await form.getByLabel('Payee\'s name').fill(name)
    await form.getByLabel('Country').selectOption({ label: country })
    await form.getByLabel('Currency they receive').selectOption(currency)
    for (const [label, value] of fields) await form.getByLabel(label).fill(value)
    await form.getByRole('button', { name: 'Add this payee abroad' }).click()
    await expect(ab.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeChecked()
  }
  await addPayee('Anita Rao', 'United States', 'USD', [['Routing number', '021000021'], ['Account number', '123456789']])
  await expect(ab.getByText('Paper wire to the United States').first()).toBeVisible()
  await ab.getByLabel('Amount they receive, in USD').fill('120.00')
  await ab.getByRole('button', { name: 'See the quote and the route' }).click()
  const pay = page.getByRole('dialog', { name: 'Approve this payment abroad' })
  await expect(pay).toBeVisible()
  for (const label of ['To', 'Route', 'They receive', 'Rate', 'Reference', 'Spread', 'Fee', 'Tax collected at source', 'Liberalised Remittance Scheme', 'Value date', 'Quote expires']) await expect(pay.getByText(label, { exact: true })).toBeVisible()
  await expect(pay.getByText('USD 120.00', { exact: true })).toBeVisible()
  await expect(pay.getByText('₹500.00', { exact: true })).toBeVisible()
  await shot(page, 'r13-abroad-sheet', pay)
  await approveSheet(page, 'Approve this payment abroad', 'Approve and send')
  const receipt = ab.getByTestId('abroad-receipt')
  await expect(receipt).toContainText('USD 120.00')
  await expect(receipt).toContainText('Pending')
  await expect(receipt).toContainText('On its way on paper')
  await expect(receipt).toContainText('Not final')
  await expect(receipt).toContainText('Match this payment\'s record')
  await shot(page, 'r13-abroad-receipt', ab)

  // ---- a payee in Japan, paid in yen (0 places) from the yen balance held
  await addPayee('Kenji Sato', 'Japan', 'JPY', [['Bank\'s BIC', 'MHCBJPJT'], ['Account number', '1234567']])
  await ab.getByRole('button', { name: /My JPY balance/ }).click()
  await ab.getByLabel('Amount they receive, in JPY').fill('30000')
  await ab.getByRole('button', { name: 'See the quote and the route' }).click()
  await approveSheet(page, 'Approve this payment abroad', 'Approve and send')
  await expect(ab.getByTestId('abroad-receipt')).toContainText('JPY 30,000')
  await expect(ab.getByTestId('abroad-receipt')).toContainText('From your JPY balance')

  // ---- refused: dollars to Germany has no paper route; the reason is said and nothing is rerouted
  await addPayee('Jonas Weber', 'Germany', 'USD', [['IBAN', 'DE89 3704 0044 0532 0130 00']])
  await expect(ab.getByText('No paper route for this payee', { exact: true })).toBeVisible()
  await ab.getByLabel('Amount they receive, in USD').fill('10.00')
  await ab.getByRole('button', { name: 'See the quote and the route' }).click()
  await expect(ab.getByText(/No paper route sends USD to Germany\. QED does not change the route or the currency for you\./)).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Approve this payment abroad' })).toBeHidden()

  // ---- the same dollar payment again is held for confirmation
  await ab.getByRole('radio', { name: /^Anita Rao/ }).check()
  await ab.getByLabel('Amount they receive, in USD').fill('120.00')
  await ab.getByRole('button', { name: 'See the quote and the route' }).click()
  await expect(ab.getByText('Held for your confirmation', { exact: true })).toBeVisible()
  await expect(ab.getByText(/you sent USD 120\.00 to Anita Rao/)).toBeVisible()
  await ab.getByRole('button', { name: 'Do not send it' }).click()

  // ---- a payee that looks like one already held needs the owner's confirmation, in the server's words
  await ab.getByRole('button', { name: 'Add a payee abroad' }).click()
  const twin = ab.getByRole('form', { name: 'Add a payee abroad' })
  await twin.getByLabel('Payee\'s name').fill('Anita Rao')
  await twin.getByLabel('Routing number').fill('021000021')
  await twin.getByLabel('Account number').fill('123456788')
  await twin.getByRole('button', { name: 'Add this payee abroad' }).click()
  await expect(twin.getByText('This payee looks like one you already have', { exact: true })).toBeVisible()
  await expect(twin.getByText(/looks like Anita Rao.*its account number differs by one character/)).toBeVisible()
  await expect(twin.getByRole('button', { name: 'Add it, I have checked' })).toBeDisabled()
  await twin.getByLabel(/I have checked this payee's account with them directly/).check()
  await shot(page, 'r13-abroad-lookalike', twin)
  await twin.getByRole('button', { name: 'Add it, I have checked' }).click()
  await expect(ab.getByRole('radio', { name: /^Anita Rao.*6788/ })).toBeChecked()
  // the Spend side says how far the IBAN's length and layout are checked, and that the Liberalised Remittance Scheme counts rupees changed
  // (R14: the year's figure is a tile of its own; how it is counted is behind the disclosure under it, every word kept)
  await expect(ab.getByTestId('abroad-lrs')).toContainText(/Liberalised Remittance Scheme, this financial year \(since \d+ \w+ \d{4}\)/)
  await expect(ab.getByTestId('abroad-lrs')).toContainText('changed out of rupees')
  await ab.getByText('How QED counts this, tax collected at source, and a repeated payment').click()
  await expect(ab.getByTestId('abroad-lrs-rule')).toBeVisible()
  await expect(ab.getByTestId('abroad-lrs-rule')).toContainText('count now, even when the money stays in your account here')

  // ---- the database: what was filled, paid and booked; every currency balances on its own
  const fills = s.query<{ buy_ccy: string; buy_text: string; purpose: string; spread_bps: number; fee_text: string }>('SELECT buy_ccy, buy_text, purpose, spread_bps, fee_text FROM fx_fills WHERE user_id = ? ORDER BY filled_at', me!.id)
  expect(fills).toEqual([
    { buy_ccy: 'JPY', buy_text: '50000', purpose: 'conversion', spread_bps: 50, fee_text: '5000' },
    { buy_ccy: 'BHD', buy_text: '25500', purpose: 'conversion', spread_bps: 75, fee_text: '5000' },
    { buy_ccy: 'USD', buy_text: '12000', purpose: 'payment', spread_bps: 50, fee_text: '50000' },
  ])
  const paid = s.query<{ currency: string; amount_text: string; funded_from: string; state: string; route: string }>('SELECT currency, amount_text, funded_from, state, route FROM xb_payments WHERE user_id = ? ORDER BY created_at', me!.id)
  expect(paid).toEqual([
    { currency: 'USD', amount_text: '12000', funded_from: 'INR', state: 'in_transit', route: 'paper-usd-us' },
    { currency: 'JPY', amount_text: '30000', funded_from: 'JPY', state: 'in_transit', route: 'paper-jpy-jp' },
  ])
  for (const row of s.query<{ asset_id: string; s: string }>('SELECT p.asset_id, amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id WHERE e.user_id = ? GROUP BY p.asset_id', me!.id)) expect(row.s, row.asset_id).toBe('0')
  expect(s.query('SELECT 1 FROM xb_payments p JOIN xb_payees y ON y.id = p.payee_id WHERE y.country = ?', 'DE')).toEqual([])
  expect(errors).toEqual([])
  await ctx.close()
})
