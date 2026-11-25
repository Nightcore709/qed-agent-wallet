/**
 * R13: Ask proposes more of what a household does, and QED buys services within a mandate. One journey on its own stack
 * (scripted test double for Ask: no model; both purchase services are simulated test doubles; paper rail):
 *
 *   1. Ask proposes a savings goal, opened as a draft and signed with the passkey;
 *   2. Ask asks which amount (a structured question: choices and a typed answer), is answered with a choice, and proposes
 *      a one-off payment to a payee the household has; the preview and passkey approval are the ones a payment of the
 *      person's own makes, and the engine pays it;
 *   3. a commerce mandate is signed with the passkey (a limit for one purchase, a limit for a month, one service named);
 *      QED compares the two services' quotes and buys from the one the mandate names (paid, receipt, in Activity);
 *      a request for the other service is refused with the reason, and nothing is paid.
 *
 * The database is the judge of what was signed, what moved and what was refused.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { addPayeeOnSpend } from '../support/payee.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = extraPort(50)
const dir = mkdtempSync(join(tmpdir(), 'qed-ask-agentic-'))
const SCRIPT = join(dir, 'replies.json')
const by = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 5, 0)).toISOString().slice(0, 10)
const shape = (o: Record<string, unknown>): Record<string, unknown> => ({ answer: '', proposals: [], questions: [], withdraw: [], cites: [], links: [], clarify: [], ...o })
const proposal = (kind: string, title: string, params: unknown): Record<string, unknown> => ({ kind, title, rationale: 'As you asked.', paramsJson: JSON.stringify(params), runMode: 'approve', supersedes: null, limits: { maxPerRun: null, maxPerMonth: null, maxRuns: null, endsInDays: null } })
writeFileSync(SCRIPT, JSON.stringify({ turns: [
  { match: 'for a holiday', reply: shape({ answer: 'A goal for the holiday.', proposals: [proposal('goal', 'Holiday', { name: 'Holiday', target: 5_000_000, date: by })] }) },
  { match: 'pay my landlord', reply: shape({ answer: 'I need the amount before I propose a payment.', clarify: [{ field: 'amount', question: 'How much should I pay?', choices: ['₹500', '₹1,200'], allowTyped: true }] }) },
  { match: 'How much should I pay', reply: shape({ answer: 'Here is the payment.', proposals: [proposal('pay', 'Pay ₹500 to your landlord', { payee: '$payee:other', amount: 50_000 })] }) },
] }))
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_AI_PROVIDER: 'scripted', QED_AI_SCRIPT: SCRIPT, QED_ASK_DAILY: '1000', QED_ASK_MONTHLY: '1000' }) })
test.afterAll(async () => { await s?.stop() })

/** A photograph of the window for review, only when QED_ASK_SHOTS names a folder. */
const shot = async (page: Page, name: string): Promise<void> => { const d = process.env.QED_ASK_SHOTS; if (d) { mkdirSync(d, { recursive: true }); await page.screenshot({ path: join(d, `ask-agentic-${name}.png`), fullPage: true, animations: 'disabled' }) } }
async function ask(page: Page, text: string): Promise<void> {
  await page.getByLabel('Your question').fill(text)
  await page.getByRole('button', { name: /^(Ask|Send)/ }).click()
}

test('Ask proposes a goal and a payment, both approved; QED buys within a mandate, and a request outside it is refused', async ({ browser }) => {
  test.setTimeout(240_000)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('PAGEERROR', String(e).slice(0, 400)) })
  const handle = `agentic${Date.now().toString(36)}`
  await page.goto(`${s.base}/`)
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Asha Rao')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  const [me] = s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)

  // ---- the household has a payee (as Spend adds one)
  await page.goto(`${s.base}/pay`)
  await addPayeeOnSpend(page, 'Sunrise Apartments', 'sunrise.rent@okhdfc')

  // ---- 1. Ask proposes a goal; opened as a draft, signed with the passkey
  await page.goto(`${s.base}/ask`)
  await ask(page, `Save ₹50,000 for a holiday by ${by}.`)
  await page.waitForURL(/\/ask\?c=cnv_/)
  const goalCard = page.getByRole('article', { name: /Holiday/ })
  await expect(goalCard).toBeVisible({ timeout: 30_000 })
  await goalCard.getByRole('link', { name: /Open as a draft/ }).click()
  await page.waitForURL(/\/instructions\/new\?proposal=/)
  await page.getByRole('button', { name: 'Review and sign' }).click()
  const sign = page.getByRole('dialog', { name: 'Sign this instruction' })
  await sign.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)
  const [goal] = s.query<{ id: string; kind: string; origin: string; params_json: string }>(`SELECT p.id, p.kind, p.origin, v.params_json FROM programs p JOIN program_versions v ON v.program_id = p.id WHERE p.user_id = ? AND p.state = 'active'`, me!.id)
  expect(goal).toMatchObject({ kind: 'goal' })
  expect(goal!.origin).toMatch(/^proposal:prp_/)
  expect(JSON.parse(goal!.params_json)).toMatchObject({ target: 5_000_000, date: by })

  // ---- 2. a structured question, answered with a choice; then a one-off payment, approved with the passkey
  await page.goto(`${s.base}/ask`)
  await ask(page, 'Please pay my landlord.')
  await page.waitForURL(/\/ask\?c=cnv_/)
  const clar = page.getByRole('group', { name: 'Questions QED needs answered' })
  await expect(clar.getByText('How much should I pay?')).toBeVisible({ timeout: 30_000 })
  await expect(clar.getByLabel(/Type your own answer/)).toBeVisible()
  await clar.getByRole('button', { name: '₹500' }).click()
  const payCard = page.getByRole('article', { name: /Pay ₹500(\.00)? to/ })
  await expect(payCard).toBeVisible({ timeout: 30_000 })
  await shot(page, 'ask-pay')
  await expect(clar.getByText(/You answered:/)).toBeVisible()
  expect(s.query<{ clarify_json: string }>(`SELECT clarify_json FROM conversation_turns WHERE clarify_json <> '[]'`)[0]!.clarify_json).toContain('"value":"₹500"')
  const before = s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ?`, me!.id)[0]!.n
  await payCard.getByRole('button', { name: 'Review the payment and approve' }).click()
  const pay = page.getByRole('dialog', { name: 'Approve this payment' })
  await expect(pay.getByText(/Pay ₹500(\.00)? to Sunrise Apartments/)).toBeVisible()
  await shot(page, 'pay-sheet')
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE user_id = ?`, me!.id)[0]!.n).toBe(before) // the preview moves nothing
  await pay.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect(pay).toBeHidden({ timeout: 30_000 })
  await expect.poll(() => s.query<{ state: string; origin: string; params_json: string }>(`SELECT state, origin, params_json FROM actions WHERE user_id = ? AND kind = 'payment'`, me!.id).map((a) => `${a.origin} ${a.state} ${JSON.parse(a.params_json).amount}`), { timeout: 60_000 }).toEqual(['owner done 50000'])

  // ---- 3. the mandate: signed with the passkey, one service named
  await page.goto(`${s.base}/pay`)
  const commerce = page.getByRole('region', { name: 'Services QED can buy for you' })
  await expect(commerce.getByText('No mandate is signed, so QED buys nothing.')).toBeVisible()
  await expect(commerce.getByText(/Simulated: two test services on this computer/)).toBeVisible()
  await commerce.getByRole('group', { name: 'Services QED may buy from' }).getByLabel(/Beta Briefs/).uncheck()
  await commerce.getByRole('button', { name: 'Review the mandate and sign' }).click()
  const mandate = page.getByRole('dialog', { name: 'Sign this mandate' })
  await expect(mandate.getByText(/Let QED buy from Alpha Digest \(simulated\)/)).toBeVisible()
  await mandate.getByRole('button', { name: 'Sign the mandate with your passkey' }).click()
  await expect(commerce.getByRole('button', { name: 'Revoke the mandate' })).toBeVisible({ timeout: 30_000 })
  const [m] = s.query<{ per_purchase: number; per_month: number; services_json: string; approval_id: string }>(`SELECT per_purchase, per_month, services_json, approval_id FROM commerce_mandates WHERE user_id = ? AND state = 'active'`, me!.id)
  expect(m).toMatchObject({ per_purchase: 5000, per_month: 10000 })
  expect(JSON.parse(m!.services_json)).toEqual(['sim-alpha'])
  expect(s.query<{ method: string; consumed_at: number | null }>(`SELECT method, consumed_at FROM approvals WHERE id = ?`, m!.approval_id)[0]).toMatchObject({ method: 'passkey' })

  // ---- the two quotes are compared; QED buys from the service the mandate names
  await commerce.getByRole('button', { name: 'Compare the two quotes' }).click()
  const quotes = commerce.getByRole('table')
  await expect(quotes.getByRole('row')).toHaveCount(3)
  await expect(quotes.getByRole('row').nth(1)).toContainText('Beta Briefs (simulated)')   // cheapest first
  await expect(quotes.getByRole('row').nth(1)).toContainText('₹28')
  await expect(quotes.getByRole('row').nth(2)).toContainText('₹35')
  await quotes.getByRole('button', { name: 'Buy from Alpha' }).click()
  const bought = commerce.getByRole('list').filter({ hasText: 'What' }).or(commerce.locator('.cm-list'))
  await expect(commerce.locator('.cm-list li').first().getByText('Bought', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(commerce.locator('.cm-list li').first()).toContainText('Receipt: payment act_')
  await expect(bought.first()).toBeVisible()

  // ---- a request outside the mandate is refused, with the reason, and nothing is paid
  await quotes.getByRole('button', { name: 'Buy from Beta' }).click()
  const refused = commerce.locator('.cm-list li').first()
  await expect(refused.getByText('Refused', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(refused).toContainText('not one of the services the mandate names')
  await expect(refused).toContainText('nothing was paid')
  await shot(page, 'spend-commerce')

  // ---- the database: one purchase paid (an action of origin commerce, done), one refused with no action
  const purchases = s.query<{ state: string; service_id: string; amount: number; action_id: string | null; reason: string | null }>(`SELECT state, service_id, amount, action_id, reason FROM commerce_purchases WHERE user_id = ? ORDER BY created_at`, me!.id)
  expect(purchases.map((p) => `${p.state} ${p.service_id} ${p.amount}`)).toEqual(['paid sim-alpha 3500', 'refused sim-beta 2800'])
  expect(purchases[1]!.action_id).toBeNull()
  const acts = s.query<{ origin: string; state: string; params_json: string }>(`SELECT origin, state, params_json FROM actions WHERE user_id = ? AND origin = 'commerce'`, me!.id)
  expect(acts).toHaveLength(1)
  expect(acts[0]).toMatchObject({ origin: 'commerce', state: 'done' })
  expect(JSON.parse(acts[0]!.params_json)).toMatchObject({ payeeHandle: 'alpha-digest@simservice', amount: '3500', purpose: 'spend' })

  // ---- Spend lists it, and Activity shows the payment under the mandate
  await page.reload()
  await expect(page.getByRole('region', { name: 'Payments so far' }).getByText('By QED, within your mandate')).toBeVisible({ timeout: 30_000 })
  await page.goto(`${s.base}/activity`)
  await expect(page.getByText('Alpha Digest (simulated)').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Your commerce mandate').first()).toBeVisible()
  expect(errors).toEqual([])
})
