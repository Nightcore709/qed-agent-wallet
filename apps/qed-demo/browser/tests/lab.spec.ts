/**
 * The Portfolio lab (R12, /holdings/lab), end to end on its own presentation-mode stack (synthetic prices and NAVs, no
 * provider contacted): an owner buys two digital assets by hand, opens the lab from Grow, reads the mix against equal
 * shares with the modelled tax of trading back, declares their fees and taxes and reads what QED can and cannot
 * promise, runs a dollar-liability hedge through the checker, and proposes the mix. The proposal becomes a draft
 * instruction; nothing trades; the owner signs it with a passkey, and it asks before every run. What the screen says is
 * compared with the stack's database at each step. Photographs of the populated lab are written outside the repository
 * (QED_LAB_SHOTS; unset, the test's own output folder, which exists on every machine).
 */
import { mkdirSync } from 'node:fs'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_LAB_PORT ?? extraPort(26))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

async function buy(page: Page, userId: string, instrumentId: string, rupees: string): Promise<void> {
  const before = s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ? AND kind = 'order' AND state = 'done'`, userId)[0]!.n
  await page.goto(`${s.base}/holdings`)
  await page.getByLabel('What', { exact: true }).selectOption(instrumentId)
  await page.getByLabel('With how much').fill(rupees)
  await page.getByRole('button', { name: 'See what this would do' }).click()
  await page.getByRole('dialog', { name: 'Approve this order' }).getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ? AND kind = 'order' AND state = 'done'`, userId)[0]!.n, { timeout: 30_000 }).toBe(before + 1)
}

test('the lab: the mix and its tax, what can be promised, a dollar hedge, and a proposal the owner signs; nothing trades on its own', async ({ page }) => {
  test.setTimeout(240_000)
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  await page.goto(`${s.base}/`)
  const handle = `lab${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Lab Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [u] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id IN ('coindcx:BTCINR', 'coindcx:ETHINR')`)[0]!.n, { timeout: 20_000 }).toBeGreaterThan(1)

  // two holdings that can grow, one twice the other
  await buy(page, u!.id, 'coindcx:BTCINR', '2000')
  await buy(page, u!.id, 'coindcx:ETHINR', '4000')

  // Grow links to the lab; the lab opens on the owner's own books
  await page.goto(`${s.base}/holdings`)
  await page.getByRole('link', { name: 'Portfolio lab' }).click()
  await page.waitForURL(/\/holdings\/lab$/)
  await expect(page.getByRole('heading', { level: 1, name: /Portfolio lab/ })).toBeVisible()
  await expect(page.getByText(/Not investment advice\. QED is not a registered investment adviser or portfolio manager/)).toBeVisible()
  await expect(page.getByText(/every price here is synthetic \(presentation mode\)/)).toBeVisible()

  // the mix: two thirds and one third against equal shares, out of the 5-point band; selling Ether is taxed as modelled
  const mix = page.getByRole('region', { name: 'Your mix' })
  await expect(mix.getByText(/^\d+\.\d points out of balance$/)).toBeVisible({ timeout: 20_000 })
  await expect(mix.getByText('Bitcoin in rupees', { exact: true })).toBeVisible()
  await expect(mix.getByText('Ether in rupees', { exact: true })).toBeVisible()
  const sell = mix.getByRole('row', { name: /^Sell Ether in rupees/ })
  await expect(sell).toBeVisible()
  await expect(sell.getByText(/virtual digital asset: short-term (gain|loss).*modelled rate, losses not set off/)).toBeVisible()
  await expect(mix.getByText(/would also be deducted at source on the digital-asset sale \(1%/)).toBeVisible()

  // promises: refused without the owner's declaration; with it, the bank's promise covers what is due, Grow is refused
  const certs = page.getByRole('region', { name: 'What QED can promise about your money' })
  const bank = certs.getByRole('article', { name: 'Everything due in the next 30 days, from money already in your bank' })
  await expect(bank.getByText('Not promised')).toBeVisible({ timeout: 20_000 })
  await expect(bank.getByText('FEES_NOT_DECLARED')).toBeVisible()
  await certs.getByRole('checkbox', { name: /Every fee and tax I owe in the next 30 days is among my bills/ }).check()
  await expect(bank.getByText('Holds by a bank\'s promise')).toBeVisible({ timeout: 20_000 })
  // R13: what exactly is promised, and what it assumes, are on the card before anything else about it
  await expect(bank.getByText('Exactly what is promised')).toBeVisible()
  await expect(bank.getByText(/Nominal INR\. Each listed obligation due from .* is paid in full on time/)).toBeVisible()
  await expect(bank.getByRole('region', { name: 'What it assumes' }).getByText(/the request asserts it, for example for a payment system that runs every day/)).toBeVisible()
  await expect(certs.getByRole('article', { name: 'Everything due in the next 30 days, covered by construction' }).getByText('Not promised')).toBeVisible()
  const cvar = certs.getByRole('article', { name: /Does a model put the average of your worst months under a 10% loss\? \(95% CVaR: an estimate, never a limit\)/ })
  await expect(cvar.getByText('Not promised')).toBeVisible()
  await expect(cvar.getByText('NO_MODEL_DATA')).toBeVisible()
  await expect(certs.getByText(/(Bitcoin|Ether) in rupees and (Bitcoin|Ether) in rupees only while it has been running/)).toBeVisible()
  // the fingerprint shown is the request's canonical SHA-256
  await bank.getByText('The exact request and its fingerprint').click()
  await expect(bank.getByText(/^[0-9a-f]{64}$/)).toBeVisible()
  // the request's block scrolls, so it is a named region a keyboard can reach (axe scrollable-region-focusable)
  await expect(bank.getByRole('region', { name: 'The request, as sent to the checker' })).toHaveAttribute('tabindex', '0')

  // the simulation on recorded (synthetic) NAVs and the recorded study are labelled apart
  const sim = page.getByRole('region', { name: 'Strategies on the prices this app recorded' })
  await expect(sim.getByText('Simulation, recomputed now')).toBeVisible()
  await expect(sim.getByText(/synthetic prices: it shows the method works, and says nothing about markets/)).toBeVisible()
  for (const name of ['Equal weight (1/N)', 'Risk parity (equal risk contribution)', 'Minimum variance (long only)']) await expect(sim.getByRole('rowheader', { name: new RegExp(`^${name.replace(/[()/]/g, '\\$&')}`) })).toBeVisible()
  const study = page.getByRole('region', { name: /The 54-year study/ })
  await expect(study.getByText('Research, recorded')).toBeVisible()
  await expect(study.getByText(/agrees with the study's own table/)).toBeVisible()
  await study.getByText(/Where every research figure comes from/).click()
  await expect(study.getByText('experiments/r11-portfolio/results/core_w120/net.csv')).toBeVisible()

  // a dollar liability: the bill hedge would hold by construction once its bills are bought (R13: not before), as an
  // illustration of what this app cannot buy
  const hedge = page.getByRole('region', { name: 'A payment due in dollars' })
  const due = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)
  await hedge.getByLabel('Dollars owed').fill('25000')
  await hedge.getByLabel('Due on').fill(due)
  await hedge.getByRole('button', { name: 'See the risk and the hedge' }).click()
  const bill = hedge.getByRole('article', { name: /^USD 25,000 due .*, from Treasury bills$/ })
  await expect(bill.getByText('Would hold by construction, once bought')).toBeVisible({ timeout: 20_000 })
  await expect(bill.getByText(/Would hold by construction once bought at or below the limit price, if the assumptions below hold; until then nothing is protected/)).toBeVisible()
  await expect(bill.getByRole('region', { name: 'What it assumes' }).getByText(/purchase fills at or below the limit price before the first deadline; until then nothing is protected/)).toBeVisible()
  await expect(hedge.getByText(/This app cannot buy Treasury bills or hold dollars at a custodian/)).toBeVisible()

  // photographs of the populated lab, both themes, computer and phone (outside the repository)
  const SHOTS = process.env.QED_LAB_SHOTS ?? test.info().outputPath('lab-shots')
  mkdirSync(SHOTS, { recursive: true })
  for (const [w, h, scheme] of [[1440, 900, 'dark'], [1440, 900, 'light'], [390, 844, 'dark'], [390, 844, 'light']] as const) {
    await page.setViewportSize({ width: w, height: h })
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/journey-holdings_lab-${w}-${scheme}.png`, fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no sideways scroll at ${w}`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 1280, height: 860 })

  // the proposal: a draft instruction, and no order of its own
  const orders = s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', u!.id)[0]!.n
  await mix.getByRole('button', { name: 'Propose this mix as an instruction' }).click()
  await page.waitForURL(/\/instructions\/prg_[A-Za-z0-9_]+$/, { timeout: 30_000 })
  const programId = page.url().split('/').pop()!
  expect(s.query<{ origin: string; kind: string; state: string }>(`SELECT origin, kind, state FROM proposals WHERE user_id = ?`, u!.id)).toEqual([{ origin: 'rules', kind: 'rebalance', state: 'drafted' }])
  expect(s.query<{ state: string; kind: string }>('SELECT state, kind FROM programs WHERE id = ?', programId)).toEqual([{ state: 'draft', kind: 'rebalance' }])
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', u!.id)[0]!.n).toBe(orders)
  await expect(page.getByText(/Drafted, not signed|can do nothing until you sign it/).first()).toBeVisible()

  // the owner signs it with the passkey; it asks before every run
  await page.getByRole('button', { name: 'Review and sign' }).click()
  const accept = page.getByRole('button', { name: 'Accept and continue to signing' })
  if (await accept.isVisible().catch(() => false)) { for (const box of await page.getByRole('checkbox', { name: /^I accept:/ }).all()) await box.check(); await accept.click() }
  await page.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await expect.poll(() => s.query<{ state: string }>('SELECT state FROM programs WHERE id = ?', programId)[0]?.state, { timeout: 30_000 }).toBe('active')
  const [v] = s.query<{ authority_json: string }>('SELECT v.authority_json FROM program_versions v JOIN programs p ON p.id = v.program_id AND v.version = p.live_version WHERE p.id = ?', programId)
  expect(JSON.parse(v!.authority_json).runMode).toBe('approve')
  expect(s.query<{ method: string }>(`SELECT method FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, u!.id)).toEqual([{ method: 'passkey' }])
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', u!.id)[0]!.n).toBe(orders)

  // back in the lab, the mix is already kept by that instruction, and no second one is offered
  await page.goto(`${s.base}/holdings/lab`)
  await expect(mix.getByRole('button', { name: 'Propose this mix as an instruction' })).toBeDisabled({ timeout: 20_000 })
  await expect(mix.getByText(/You already have an instruction keeping a mix in balance/)).toBeVisible()
  expect(errors).toEqual([])
})
