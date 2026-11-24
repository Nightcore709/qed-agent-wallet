/**
 * Saving for a goal on a phone (R12 task comparison, gap 5; T3-a to T3-d): a household says what it is saving for, how
 * much and by when; QED works out the monthly figure; the instruction is signed with the passkey and asks first. When
 * the first contribution day comes and nobody answers, the request lapses and the goal falls behind: Home says so as a
 * need, with what happens if nothing changes, and Save gives the remedies in figures. One is applied with the passkey and
 * the goal is on track again. The database is the judge of what was signed and what moved.
 *
 * Its own stack (synthetic prices, so no network), whose clock the journey moves forward through the stack's test-only
 * clock hook (server/core.ts testClockOffset) instead of waiting: to just after the first contribution day, then a day
 * on, past the 24 hours a request waits. Nothing sleeps for long: each step waits only for the engine's next tick.
 *
 * With QED_GOALS_SHOTS set to a folder, the states it reaches are photographed there at 390 px for review.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'

const PORT = Number(process.env.QED_GOALS_PORT ?? extraPort(22))
const DAY = 86_400_000
const dir = mkdtempSync(join(tmpdir(), 'qed-goal-clock-'))
const CLOCK = join(dir, 'offset')
writeFileSync(CLOCK, '0')
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => {
  // the clock hook is honoured on an isolated test stack only; sessions outlast the days the clock is moved
  s = await startExtraStack(PORT, { QED_PRESENTATION: '1', QED_TEST_CLOCK_FILE: CLOCK, QED_SESSION_IDLE_MINUTES: '200000', QED_SESSION_MAX_MINUTES: '200000' })
})
test.afterAll(async () => { await s?.stop() })

/** Move the stack's clock to `at` (server time), forward only. */
const moveClockTo = (at: number): void => { writeFileSync(CLOCK, String(Math.max(0, Math.round(at - Date.now())))) }
const rupees = (paise: number): string => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const SHOTS = process.env.QED_GOALS_SHOTS
/** A photograph of the window, or of one part, for review; only when QED_GOALS_SHOTS names a folder. */
async function shot(page: Page, name: string, part?: Locator): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await (part ?? page).screenshot({ path: join(SHOTS, `goals-390-${name}.png`), animations: 'disabled' })
}

test('a goal: QED\'s monthly figure, signed with the passkey; behind when a contribution lapses; a remedy applied with the passkey', async ({ browser }) => {
  test.setTimeout(180_000)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  await addAuthenticator(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const handle = `goal${Date.now().toString(36)}`
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

  // ---- Save: no goal yet; "Save for a goal" opens the instruction form for one
  await page.goto(`${s.base}/save`)
  const goals = page.locator('#goals')
  await expect(goals.getByRole('heading', { name: 'Saving for goals' })).toBeVisible()
  await expect(goals.getByRole('heading', { name: 'No goal yet' })).toBeVisible()
  await goals.getByRole('link', { name: 'Save for a goal' }).click()
  await expect(page).toHaveURL(/\/instructions\/new\?kind=goal$/)

  // ---- what it is for, how much, by when: QED works out the monthly figure as it is typed
  const today = new Date(Date.now() + 19_800_000)
  const by = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 5, 0)).toISOString().slice(0, 10) // the last day of the fourth month on
  await page.getByLabel('What it is for').fill('Holiday in March')
  await page.getByLabel('How much').fill('50000')
  await page.getByLabel('By', { exact: true }).fill(by)
  const live = page.locator('.pr-cw-step').first().locator('.pr-cw-live')
  await expect(live.getByText('QED works out')).toBeVisible()
  const figure = (await live.locator('.pr-cw-says-big').innerText()).split('\n')[0]!
  expect(figure).toMatch(/^₹[\d,]+ a month$/)
  await expect(page.getByRole('radio', { name: /^Ask me each time/ })).toBeChecked() // asks first unless the owner chooses
  await page.getByRole('button', { name: 'Review and sign' }).click()
  const sheet = page.getByRole('dialog', { name: 'Sign this instruction' })
  await expect(sheet.getByText(/^Move ₹[\d,]+ from your bank account into the set-aside for Holiday in March on day \d+ of each month, until .+ or until ₹50,000 is set aside\.$/)).toBeVisible()
  await expect(sheet.getByText('Spend, invest or pay anyone with the money set aside: no instruction can, this one included.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Sign and put in force with your passkey' }).click()
  await page.waitForURL(/\/instructions\/prg_/)

  // what was signed, as the database holds it: the goal, QED's figure, asking first, bounded by the goal
  const [prog] = s.query<{ id: string; next_due_at: number; params_json: string; authority_json: string }>(`SELECT p.id, p.next_due_at, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.kind = 'goal' AND p.state = 'active'`, me!.id)
  const params = JSON.parse(prog!.params_json) as { amount: number; target: number; date: string; schedule: { day: number } }
  const authority = JSON.parse(prog!.authority_json) as { runMode: string; maxPerRun: number; maxPerMonth: number; maxRuns: number }
  expect(params).toMatchObject({ target: 5_000_000, date: by })
  expect(figure).toBe(`${rupees(params.amount)} a month`)
  expect(authority).toMatchObject({ runMode: 'approve', maxPerRun: params.amount, maxPerMonth: params.amount })
  expect(params.amount * authority.maxRuns).toBeGreaterThanOrEqual(5_000_000)
  expect(s.query<{ method: string }>(`SELECT method FROM approvals WHERE user_id = ? AND purpose = 'program-version' AND confirmed_at IS NOT NULL`, me!.id)[0]).toEqual({ method: 'passkey' })
  // the record shows the goal on track, with the monthly figure
  const card = page.locator(`#goal-${prog!.id}`)
  await expect(card.getByText('On track', { exact: true })).toBeVisible()
  await expect(card.getByText(`${rupees(params.amount)} on the`)).toBeVisible()
  await shot(page, 'signed-record', card)

  // ---- the first contribution day comes (the stack's clock is moved to just after it): QED asks, and nobody answers
  moveClockTo(prog!.next_due_at + 3_000)
  await expect.poll(() => s.query<{ state: string }>('SELECT state FROM runs WHERE program_id = ?', prog!.id).map((r) => r.state), { timeout: 30_000 }).toEqual(['awaiting_approval'])
  moveClockTo(prog!.next_due_at + DAY + 60_000) // a day on: the request has waited its 24 hours
  await expect.poll(() => s.query<{ state: string; reason: string }>('SELECT state, reason FROM runs WHERE program_id = ?', prog!.id)[0], { timeout: 30_000 }).toEqual({ state: 'expired', reason: 'You did not answer within 24 hours, so this run lapsed. Nothing was done.' })

  // ---- Home: the goal is behind, as a need that says what catches up and what happens if nothing changes
  await page.goto(`${s.base}/`)
  const need = page.locator('article.need').filter({ has: page.getByRole('heading', { name: 'Holiday in March is behind' }) })
  await expect(need).toBeVisible()
  await expect(need.getByText(/^To catch up: ₹[\d,]+ more a month, or \d+ \w+ \d{4} instead of \d+ \w+ \d{4}, or ₹[\d,]+ now\.$/)).toBeVisible()
  await expect(need.getByText(/If you change nothing and every contribution still scheduled is made, ₹[\d,]+ will be set aside by .+, ₹[\d,]+ short of ₹50,000\./)).toBeVisible()
  await shot(page, 'home-need', need)
  await need.getByRole('link', { name: 'See how to catch up' }).click()

  // ---- Save: the goal's card, behind by the stated rule, with the three remedies in figures
  await expect(page).toHaveURL(new RegExp(`/save#goal-${prog!.id}$`))
  await expect(card).toBeInViewport()
  await expect(card.getByText('Behind', { exact: true })).toBeVisible()
  await expect(card.getByText(/^On track means: what is set aside now, plus every contribution still scheduled before .+, reaches ₹50,000 on that date\. Growth: none counted\.$/)).toBeVisible()
  const view = await page.evaluate(async (id) => ((await (await fetch('/api/goals')).json()) as { goals: { id: string; shortfall: number; remedies: { more: { extra: number; monthly: number }; later: { date: string }; now: { amount: number } } }[] }).goals.find((g) => g.id === id)!, prog!.id)
  expect(view.shortfall).toBeGreaterThan(0)
  const fix = card.getByRole('list', { name: 'To catch up, any one of these' })
  await expect(fix.getByText(`${rupees(view.remedies.more.extra)} more a month`, { exact: true })).toBeVisible()
  await expect(fix.getByRole('button', { name: `Sign ${rupees(view.remedies.more.monthly)} a month for Holiday in March` })).toBeVisible()
  await expect(fix.getByRole('button', { name: /^Sign the later date of \d+ \w+ \d{4} for Holiday in March$/ })).toBeVisible()
  await expect(fix.getByText(`${rupees(view.remedies.now.amount)} now`, { exact: true })).toBeVisible()
  await shot(page, 'save-behind', card)

  // ---- apply one: the sum now, a payment by hand into the set-aside, approved with the passkey
  await fix.getByRole('button', { name: `Set aside ${rupees(view.remedies.now.amount)} now for Holiday in March` }).click()
  const now = page.getByRole('dialog', { name: 'Set money aside now' })
  await expect(now.getByText(`Set aside ${rupees(view.remedies.now.amount)} for Holiday in March.`)).toBeVisible()
  await expect(now.getByText('The set-aside for Holiday in March, inside your own bank')).toBeVisible()
  await shot(page, 'sheet-now')
  await now.getByRole('button', { name: 'Set it aside with your passkey' }).click()
  await expect(now).toBeHidden()
  await expect.poll(() => s.query<{ t: string }>(`SELECT b.amount_text t FROM accounts a JOIN balances b ON b.account_id = a.id WHERE a.user_id = ? AND a.code = ?`, me!.id, `goal:${prog!.id}`)[0]?.t ?? '0', { timeout: 30_000 }).toBe(String(view.remedies.now.amount))
  await expect(card.getByText('On track', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('.sv-goal-v')).toHaveText(`${rupees(view.remedies.now.amount)}.00`)
  await shot(page, 'save-caught-up', card)
  // the payment was the owner's, approved with the passkey, into this goal's own set-aside, and it completed
  const [act] = s.query<{ origin: string; state: string; params_json: string; method: string }>(`SELECT a.origin, a.state, a.params_json, p.method FROM actions a JOIN approvals p ON p.id = a.approval_id WHERE a.user_id = ? AND json_extract(a.params_json, '$.purpose') = 'goal'`, me!.id)
  expect(act).toMatchObject({ origin: 'owner', state: 'done', method: 'passkey' })
  expect(JSON.parse(act!.params_json)).toMatchObject({ goalId: prog!.id, amount: String(view.remedies.now.amount) })
  // Home no longer asks about it
  await page.goto(`${s.base}/`)
  await expect(page.getByRole('heading', { name: 'Holiday in March is behind' })).toHaveCount(0)
  // nothing on the phone is wider than the screen, and nothing failed to draw
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  expect(errors).toEqual([])
  await ctx.close()
})
