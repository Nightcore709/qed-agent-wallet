/**
 * Grow's central journey (R13), end to end on its own presentation-mode stack (synthetic prices and NAVs, no provider
 * contacted), at a phone's width and a computer's. From Grow's "Test an idea": an idea picked, the question its words
 * leave open answered, the investigation with its five answers kept apart and the idea beside doing nothing, then the
 * owner's decision signed with a passkey through the existing approval flows: on the computer a one-time order, on the
 * phone an instruction that asks before each purchase, then a revision declined with its reason. What the screen says
 * is compared with the stack's database at each step; nothing is created before the passkey signs; axe on both pages.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_IDEA_PORT ?? extraPort(42))
/** Where to photograph the signed and declined records, in both themes (outside the repository; only when set). */
const SHOTS = process.env.QED_IDEA_SHOTS ?? ''
// Both tests share one stack on one port, so they run in one worker, one after the other (as presentation.spec.ts does):
// in parallel workers the second worker's beforeAll found the port taken.
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { s = await startExtraStack(PORT, { QED_PRESENTATION: '1' }) })
test.afterAll(async () => { await s?.stop() })

const AXE = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
async function axe(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page: page as never }).include('main').withTags(AXE).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}-${scheme}.png`, fullPage: true, animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function signUp(page: Page, prefix: string): Promise<string> {
  await page.goto(`${s.base}/`)
  const handle = `${prefix}${Date.now().toString(36)}`
  await page.getByRole('button', { name: 'Create an account' }).click()
  await page.getByRole('button', { name: 'Use a passkey instead' }).click()
  await page.getByLabel('Handle').fill(handle)
  await page.getByLabel('Name to sign with').fill('Idea Owner')
  await page.getByRole('button', { name: 'Create account with a passkey' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Open the household' }).click()
  await expect(page.getByRole('button', { name: 'Open the household' })).toHaveCount(0)
  return s.query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
}
const rupees = (paise: number): string => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`

test('on a computer: a lump sum tested against doing nothing, ordered once with the passkey, and followed on its record', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const userId = await signUp(page, 'idea')
  await expect.poll(() => s.query<{ n: number }>(`SELECT COUNT(*) n FROM quotes WHERE instrument_id = 'amfi:120716'`)[0]!.n, { timeout: 20_000 }).toBeGreaterThan(0)

  // Grow's first action is the idea journey
  await page.goto(`${s.base}/holdings`)
  const acts = page.getByRole('navigation', { name: 'Do something yourself' })
  await expect(acts.getByRole('link')).toHaveText(['Test an idea', 'Buy or sell', 'Invest regularly', 'Portfolio lab'])
  await acts.getByRole('link', { name: 'Test an idea' }).click()
  await page.waitForURL(/\/holdings\/idea$/)
  await expect(page.getByRole('heading', { level: 1, name: /Test an idea/ })).toBeVisible()
  await axe(page)

  // a picked idea: QED says what it read and asks only what the words leave open
  await page.getByRole('button', { name: '₹50,000 into the Nifty 50 index fund' }).click()
  await expect(page.getByText('QED read')).toBeVisible()
  await expect(page.locator('.ix-chip')).toHaveText(['the Nifty 50 index fund', '₹50,000'])
  const cadence = page.getByRole('group', { name: 'Once, or every month?' })
  await cadence.getByRole('button', { name: 'Once', exact: true }).click()
  await expect(cadence).toHaveCount(0)
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM ideas WHERE user_id = ?', userId)[0]!.n).toBe(0) // reading stores nothing
  await page.getByRole('button', { name: 'Test this idea' }).click()
  await page.waitForURL(/\/holdings\/idea\/idea_/)
  const id = page.url().split('/').pop()!
  const [row] = s.query<{ investigation_json: string; state: string }>('SELECT investigation_json, state FROM ideas WHERE id = ? AND user_id = ?', id, userId)
  expect(row!.state).toBe('open')
  const inv = JSON.parse(row!.investigation_json) as { context: { free: number }; effects: { freeAfter: number }; evidence: { basis: string; outcomes: { id: string }[] } }

  // five answers, apart; the presentation stack's record is synthetic and too short for any claim
  await expect(page.getByRole('heading', { level: 1, name: '₹50,000 into UTI Nifty 50 Index Fund, once' })).toBeVisible()
  const five = page.getByRole('region', { name: 'Five questions, answered apart' })
  for (const q of ['Can QED place it?', 'Can free money pay for it?', 'Is it open to you?', 'Does it keep your own rules?', 'What does the record show?']) await expect(five.getByRole('heading', { name: q })).toBeVisible()
  await expect(five.getByRole('listitem', { name: /^Can free money pay for it\? Yes, from free money$/ })).toBeVisible()
  await expect(five.getByRole('listitem', { name: /^What does the record show\? Cannot tell$/ })).toBeVisible()
  expect(inv.evidence.basis).toBe('synthetic')
  const alts = page.getByRole('region', { name: 'Against doing nothing, and the alternatives' })
  await expect(alts.getByText('Synthetic prices')).toBeVisible()
  await expect(alts.getByText('Do nothing', { exact: true })).toBeVisible()
  await expect(alts.getByText(/too short for a claim; QED makes none until 36/).first()).toBeVisible()
  await expect(alts.getByText(/Every price here is synthetic, generated on this QED installation: this shows the method, not markets\./)).toBeVisible()
  expect(inv.evidence.outcomes.map((o) => o.id)).toEqual(expect.arrayContaining(['idea', 'cash', 'liquid', 'spread']))
  // what it does to the money: free money before and after, as the server worked them out
  const effects = page.getByRole('region', { name: 'What it does to your money' })
  await expect(effects.getByText(`${rupees(inv.context.free)} to ${rupees(inv.effects.freeAfter)}`)).toBeVisible()
  await expect(page.getByRole('region', { name: 'The case against' })).toBeVisible()
  await axe(page)

  // the decision: once, with a reason; the exact order is prepared, and nothing exists to send until the passkey signs
  const decide = page.getByRole('region', { name: 'Your decision' })
  await decide.getByRole('radio', { name: /^Buy ₹50,000 of UTI Nifty 50 Index Fund, once/ }).check()
  await decide.getByLabel('Why, in a few words (optional)').fill('For the long run')
  await decide.getByRole('button', { name: 'See the exact order' }).click()
  const sheet = page.getByRole('dialog', { name: 'Approve this order' })
  await expect(sheet.getByText('Buy ₹50,000 of UTI Nifty 50 Index Fund (Direct, Growth).')).toBeVisible()
  const approvalId = s.query<{ approval_id: string }>('SELECT approval_id FROM ideas WHERE id = ?', id)[0]!.approval_id
  expect(approvalId).toBeTruthy()
  expect(s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', userId)[0]!.n).toBe(0)
  await sheet.getByRole('button', { name: 'Approve and send with your passkey' }).click()
  await expect.poll(() => s.query<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ? AND approval_id = ?', userId, approvalId)[0]!.n, { timeout: 30_000 }).toBe(1)
  const followed = page.getByRole('region', { name: 'What you decided, and what followed' })
  await expect(followed.getByText(/go ahead, once, because “For the long run”/)).toBeVisible({ timeout: 20_000 })
  await expect(followed.getByRole('link', { name: /With the venue|Done|Being sent|Waiting to be sent/ })).toBeVisible()
  await expect(page.getByText('Signed', { exact: true }).first()).toBeVisible()
  await expect(followed.getByRole('link', { name: 'Revise this idea' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Your decision' })).toHaveCount(0) // signed: not decided again here
  await axe(page)
  await shoot(page, 'idea-ordered')

  // Grow lists it, with where it stands
  await page.goto(`${s.base}/holdings`)
  const ideas = page.getByRole('region', { name: 'Your ideas' })
  await expect(ideas.getByRole('link', { name: /₹50,000 into UTI Nifty 50 Index Fund, once.*Signed/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('on a phone: a monthly idea becomes an instruction that asks before each purchase; a revision is declined with its reason', async ({ page }) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const userId = await signUp(page, 'sip')
  await page.goto(`${s.base}/holdings/idea`)
  await page.getByRole('button', { name: 'A monthly SIP of ₹5,000 in the flexi cap fund' }).click()
  await expect(page.locator('.ix-chip')).toHaveText(['the flexi cap fund', '₹5,000', 'every month'])
  await page.getByRole('button', { name: 'Test this idea' }).click()
  await page.waitForURL(/\/holdings\/idea\/idea_/)
  const id = page.url().split('/').pop()!
  await expect(page.getByRole('heading', { level: 1, name: '₹5,000 a month into Parag Parikh Flexi Cap Fund' })).toBeVisible()
  // nothing on the page is wider than the phone
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  await axe(page)

  const decide = page.getByRole('region', { name: 'Your decision' })
  await decide.getByRole('radio', { name: /^Buy ₹5,000 of Parag Parikh Flexi Cap Fund every month, 12 times/ }).check()
  await decide.getByRole('button', { name: 'See the exact instruction' }).click()
  const sheet = page.getByRole('dialog', { name: 'Sign this instruction' })
  await expect(sheet.getByText(/It asks you before every run/)).toBeVisible()
  const programId = s.query<{ program_id: string }>('SELECT program_id FROM ideas WHERE id = ?', id)[0]!.program_id
  expect(s.query<{ state: string; origin: string }>('SELECT state, origin FROM programs WHERE id = ?', programId)[0]).toEqual({ state: 'draft', origin: `idea:${id}` })
  await sheet.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await expect.poll(() => s.query<{ state: string }>('SELECT state FROM programs WHERE id = ?', programId)[0]!.state, { timeout: 30_000 }).toBe('active')
  const auth = JSON.parse(s.query<{ a: string }>('SELECT v.authority_json a FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.id = ?', programId)[0]!.a) as { runMode: string; maxRuns: number; maxPerRun: number }
  expect(auth).toMatchObject({ runMode: 'approve', maxRuns: 12, maxPerRun: 500_000 })
  const followed = page.getByRole('region', { name: 'What you decided, and what followed' })
  await expect(followed.getByRole('link', { name: 'In force' })).toBeVisible({ timeout: 20_000 })
  await expect(followed.getByRole('link', { name: 'Pause or stop it' })).toBeVisible()
  await axe(page)
  await shoot(page, 'idea-instruction')

  // revise it: the earlier words and answers come back, read on today's books; this time, not this
  await followed.getByRole('link', { name: 'Revise this idea' }).click()
  await page.waitForURL(/\/holdings\/idea\?revise=/)
  await expect(page.getByRole('textbox', { name: 'Your idea' })).toHaveValue('A monthly SIP of ₹5,000 in the flexi cap fund')
  await page.getByRole('button', { name: 'Test this idea' }).click()
  await page.waitForURL((u) => /\/holdings\/idea\/idea_/.test(u.pathname) && !u.pathname.endsWith(id))
  const next = page.url().split('/').pop()!
  expect(s.query<{ revises: string }>('SELECT revises FROM ideas WHERE id = ?', next)[0]!.revises).toBe(id)
  const again = page.getByRole('region', { name: 'Your decision' })
  await again.getByRole('radio', { name: /^Not this/ }).check()
  await again.getByLabel('Why, in a few words (optional)').fill('One instruction is enough')
  await again.getByRole('button', { name: 'Record: not this' }).click()
  await expect(page.getByRole('region', { name: 'What you decided, and what followed' }).getByText(/not this, because “One instruction is enough”/)).toBeVisible()
  expect(s.query<{ state: string; reason: string }>('SELECT state, reason FROM ideas WHERE id = ?', next)[0]).toEqual({ state: 'declined', reason: 'One instruction is enough' })
  expect(s.query<{ n: number }>(`SELECT COUNT(*) n FROM programs WHERE user_id = ? AND origin = ?`, userId, `idea:${next}`)[0]!.n).toBe(0)
  await shoot(page, 'idea-declined')
  await page.goto(`${s.base}/holdings/idea/${id}`)
  await expect(page.getByRole('link', { name: 'See the revision' })).toBeVisible()
  expect(errors).toEqual([])
})
