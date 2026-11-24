/**
 * Paper escrow under terms both sides accepted (R13 section 2, on R12 task comparison gap 16), in the browser on the
 * suite's stack, each figure compared with the stack's database:
 *
 *  1. A job opened in the form: each period and what its end does is a choice, the usual one marked; the complete terms
 *     are read back from the server with their fingerprint before anything is committed; nothing can be accepted until
 *     they are read, a change asks for the acceptance again, and the job opens only with both sides' acceptance (on paper
 *     the household plays the client too). The stored terms are the ones shown. A job whose terms split the money when
 *     the review runs out (a review of eight seconds, allowed on an isolated test stack only, said so) has its work
 *     submitted; the row and "Who acts next" say who acts, until when, and the split in exact paise; the engine applies
 *     it by itself, with one ledger entry naming the terms and a receipt.
 *  2. The client asks for the money back; the earner disputes it, having read who decides (a simulated mediator played
 *     by the household, with its powers and limits, never a real arbitrator), the deadlines and what the terms do if
 *     nobody acts; the client answers; the household, as the mediator, splits it in exact paise. Home's "Needs you" names
 *     the refund's deadline and default and links to the milestone. By keyboard; axe; 320, 375 and 390 px.
 *  3. Work from before terms were recorded (written straight into the database, in the shape the review database has):
 *     "No agreed deadline: nothing happens on its own until both sides agree terms", on the row and in "Who acts next".
 *     The earner proposes complete terms, read in full; nothing changes until the paper client accepts them by their
 *     fingerprint; its review then starts from the agreement, and no money moved.
 *  4. A review the terms leave locked: nothing happens on its own; the earner offers a settlement and the paper client
 *     offers the same, which settles it, each offer recorded in its part.
 */
import { DatabaseSync } from 'node:sqlite'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { query, readState } from '../support/stack.ts'
import { newOwner } from '../support/vault.ts'

test.use({ actionTimeout: 30_000 })

/** A day and time as the page writes them, in India time: "27 Nov, 17:40". */
const dayTime = (ms: number): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).formatToParts(ms).map((x) => [x.type, x.value]))
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`
}
/** A deadline as the page says it in a sentence: near days by name, else the weekday ("Fri 27 Nov, 17:40"). */
const istDay = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10)
const deadline = (ms: number): string => {
  const now = Date.now()
  const near = istDay(ms) === istDay(now) ? 'today' : istDay(ms) === istDay(now + 86_400_000) ? 'tomorrow' : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(ms)
  return `${near}, ${dayTime(ms).split(', ')[1]}`
}
const userOf = (handle: string): string => query<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)[0]!.id
/** Rows written straight into the stack's database: work from before terms were recorded, which QED no longer opens. */
function write(sql: string, ...params: (string | number)[]): void {
  const d = new DatabaseSync(readState().db)
  try { d.exec('PRAGMA busy_timeout = 5000'); d.prepare(sql).run(...params) } finally { d.close() }
}

/** Open a paper job as the form does, through its API: read the terms, then accept them by their fingerprint, as both sides. */
async function openJob(page: Page, body: Record<string, unknown>): Promise<{ jobId: string; ids: string[]; hash: string }> {
  return page.evaluate(async (b) => {
    const { csrf } = await (await fetch('/api/session')).json() as { csrf: string }
    const post = async (path: string, x: unknown) => {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QED-Client': 'web', 'X-QED-CSRF': csrf }, body: JSON.stringify(x) })
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
      return r.json() as Promise<Record<string, unknown>>
    }
    const { hash } = await post('/api/earn/terms/preview', b) as { hash: string }
    const { id } = await post('/api/earn/jobs', { ...b, termsHash: hash, accept: { earner: true, client: true } }) as { id: string }
    const v = await (await fetch('/api/earn')).json() as { jobs: { id: string; milestones: { id: string }[] }[] }
    return { jobId: id, ids: v.jobs.find((j) => j.id === id)!.milestones.map((m) => m.id), hash }
  }, body)
}
async function accessible(page: Page, selector: string): Promise<void> {
  // from the top of the page: axe counts a target under the sticky app bar as obscured, which is where the page was
  // scrolled to, not how it is laid out
  await page.evaluate(() => window.scrollTo(0, 0))
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
/** The row's "who acts next" lines, label and words: [["Next", "..."], ["When", "..."], ["If not", "..."]]. */
async function nextLines(page: Page, id: string): Promise<string[][]> {
  return page.locator(`#ms-${id} .er-pn > div`).evaluateAll((rows) => rows.map((r) => [r.querySelector('dt')!.textContent!.trim(), r.querySelector('dd')!.textContent!.trim()]))
}
async function noOverflow(page: Page, what: string): Promise<void> {
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${what} at ${width} px`).toBeLessThanOrEqual(0)
  }
  await page.setViewportSize({ width: 1280, height: 860 })
}
const ledger = (userId: string, m: string) => query<{ amount_text: string; effective_ts: number; meta_json: string }>(`SELECT p.amount_text, e.effective_ts, e.meta_json FROM entries e JOIN postings p ON p.entry_id = e.id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND a.code = 'bank' AND e.ref = ?`, userId, `earn:${m}`)
const stepsOf = (m: string): string[] => query<{ actor: string; step: string }>('SELECT actor, step FROM earn_steps WHERE milestone_id = ? ORDER BY id', m).map((s) => `${s.actor}:${s.step}`)

test('a job opens only on complete terms read and accepted by both sides; a review the terms end in a split is applied by the engine, in exact paise', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await addAuthenticator(page)
  const userId = userOf(await newOwner(page))

  await page.goto('/earn')
  const paper = page.getByRole('region', { name: 'Work held in escrow on paper' })
  await paper.getByRole('button', { name: 'Open a job' }).click()
  const form = paper.getByRole('form', { name: 'Open a job on paper' })
  const asEarner = form.getByLabel('As the earner, I accept these terms.')
  const asClient = form.getByLabel('As the paper client, which on paper I play too, I accept these terms.')
  // nothing to accept until the terms are complete and read back
  await expect(asEarner).toBeDisabled()
  await form.getByLabel('The work', { exact: true }).fill('Annual report layout')
  await form.getByLabel('The client', { exact: true }).fill('Lakeview Studio')
  await form.getByLabel('Milestone 1').fill('Layout and type')
  await form.getByLabel('Paid on acceptance').fill('15000')
  const due = new Date(Date.now() + 5 * 86_400_000 + 19_800_000).toISOString().slice(0, 10)
  await form.getByLabel('Deliver the work by (optional)').fill(due)
  // each period a choice within its bounds, the usual one marked, why it is usual and its source one press away
  const review = form.getByRole('group', { name: 'The client\'s review of submitted work' })
  await expect(review.getByLabel('How long').locator('option:checked')).toHaveText('7 days, the usual')
  await review.getByLabel('How long').selectOption('3')
  await review.getByText('Why 7 days and “it is released to you” are the usual choice').click()
  // the source as server/escrow.ts states it since the primary-source pass (4ac8e0a): marked NOT VERIFIED, what was read and why not more
  await expect(review.getByText(/^Source: NOT VERIFIED\. Excerpts of Upwork's and Fiverr's help pages as a search returned them on 24 Nov 2026; both providers' own pages refused automated reading \(HTTP 403\), so neither was read in full\./)).toBeVisible()
  const decision = form.getByRole('group', { name: 'The mediator\'s deadline, counted from the dispute' })
  await decision.getByText(/^Why 5 days and/).click()
  await expect(decision.getByText(/Half each is not a judgement of who is right and is not fair by itself/)).toBeVisible()
  // the complete terms, read back from the server
  const read = form.getByRole('region', { name: 'The terms, in full' }).or(form.locator('.er-terms-read'))
  await expect(read).toContainText('3 days, from each submission of the work. If the client neither accepts nor disputes by then: it is released to you.')
  await expect(read).toContainText('A simulated mediator, played by you. Once both sides are heard it may release the disputed milestone, refund it, or split it in whole paise: only as these terms allow, and no other money. It is not an arbitrator, a court or a regulated dispute service')
  await expect(read).toContainText('5 days, from the dispute. If the mediator has not decided by then: it is split, 50% to you: ₹7,500.00 to you and ₹7,500.00 to the client.')
  await expect(asEarner).toBeEnabled()
  // one acceptance is not enough: on paper the household accepts for the client too
  await asEarner.check()
  await form.getByRole('button', { name: 'Open this job' }).click()
  await expect(form.getByText('Accept the terms as the earner and as the paper client: on paper you play the client too.')).toBeVisible()
  expect(query('SELECT COUNT(*) n FROM earn_jobs WHERE user_id = ?', userId)).toEqual([{ n: 0 }])
  // a change to the terms asks for the acceptance again: what is accepted is what was shown
  await asClient.check()
  await review.getByLabel('How long').selectOption('4')
  await expect(asEarner).not.toBeChecked()
  await expect(asClient).not.toBeChecked()
  await review.getByLabel('How long').selectOption('3')
  await expect(read).toContainText('3 days, from each submission of the work.')
  await form.locator('.er-terms-read').getByText('Fingerprint of these terms').click()
  const shown = (await form.locator('.er-terms-read .code').textContent())!.trim()
  await asEarner.check()
  await asClient.check()
  await form.getByRole('button', { name: 'Open this job' }).click()
  const annual = paper.getByRole('article', { name: 'Annual report layout' })
  await expect(annual).toBeVisible()

  // stored exactly as shown, accepted by both sides, by that fingerprint
  const [stored] = query<{ id: string; hash: string; terms_json: string }>(`SELECT id, hash, terms_json FROM earn_terms WHERE user_id = ? AND milestone_id IS NULL`, userId)
  expect(stored!.hash).toBe(shown)
  expect(query<{ side: string }>('SELECT side FROM earn_terms_accepts WHERE terms_id = ? ORDER BY rowid', stored!.id).map((a) => a.side)).toEqual(['earner', 'client'])
  const deliverBy = (JSON.parse(stored!.terms_json) as { deliverBy: number }).deliverBy
  await expect(annual.getByText(`The client reviews submitted work for 3 days; with no answer by then, it is released to you. Deliver by ${deadline(deliverBy)}. Accepted by both sides ${dayTime(Date.now()).split(', ')[0]}.`)).toBeVisible()
  const [layout] = query<{ id: string }>(`SELECT id FROM earn_milestones WHERE user_id = ? AND title = 'Layout and type'`, userId)
  expect(await nextLines(page, layout!.id)).toEqual([['Next', 'You: submit the work'], ['When', `By ${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(deliverBy)}, 23:59`], ['If not', 'The client may ask for the money back after that']])

  // a review of eight seconds, on this test stack only, ending in a 40% split
  const { ids: [m], hash } = await openJob(page, { title: 'Logo refresh', client: 'Meera Nair', testSeconds: { review: 8 }, onTimeout: { review: { kind: 'split', earnerPct: 40 } }, milestones: [{ title: 'Final logo files', amount: 450_001 }] })
  await page.reload()
  const logo = paper.getByRole('article', { name: 'Logo refresh' })
  await expect(logo.getByText('The client reviews submitted work for 8 seconds; with no answer by then, it is split, 40% to you: ₹1,800.01 to you and ₹2,700.00 to the client. No delivery date.', { exact: false })).toBeVisible()
  await logo.getByText('The terms of this job, in full').click()
  await expect(logo.getByText('Some periods are in seconds: allowed on an isolated test stack only.')).toBeVisible()
  const row = page.locator(`#ms-${m}`)
  await row.getByRole('button', { name: 'Submit the work' }).click()
  const sheet = page.getByRole('dialog', { name: 'Submit the work' })
  await expect(sheet.getByText('Once you submit it, the client has 8 seconds to accept it or dispute it; with no answer by then, it is split, 40% to you: ₹1,800.01 to you and ₹2,700.00 to the client, as the accepted terms say.')).toBeVisible()
  await sheet.getByLabel('Evidence of the work').fill('Logo files in three sizes, shared with the client.')
  await sheet.getByRole('button', { name: 'Submit to the client' }).click()
  await expect(sheet).toBeHidden()

  // who acts next, until when, and what the terms do then, in exact paise: the time on screen is the server's
  const [sub] = query<{ due_at: number }>('SELECT due_at FROM earn_milestones WHERE id = ?', m!)
  const lines = await nextLines(page, m!)
  // unless the review has already ended while the page was read (eight seconds on a loaded machine)
  if (!lines[0]![1]!.startsWith('QED\'s paper escrow')) {
    expect(lines).toEqual([['Next', 'You, as the paper client: accept the work or dispute it'], ['When', `Until today, ${dayTime(sub!.due_at).split(', ')[1]}`], ['If not', 'It is split then: ₹1,800.01 to you, ₹2,700.00 to the client']])
  }

  // the review ends: the engine applies the terms, without anyone pressing anything
  await expect(row.getByText('Split', { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(row.locator('.er-ms-next')).toHaveText(/^Split on \d+ \w+, by the accepted terms, when the client's review ran out: ₹1,800\.01 paid into your bank account, ₹2,700\.00 back to the client\.$/)
  expect(query('SELECT state, due_at FROM earn_milestones WHERE id = ?', m!)).toEqual([{ state: 'split', due_at: null }])
  const posted = ledger(userId, m!)
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ amount_text: '180001', effective_ts: sub!.due_at })
  expect(JSON.parse(posted[0]!.meta_json)).toMatchObject({ decidedBy: 'rule', outcome: 'split', period: 'review', termsHash: hash, milestoneId: m })
  const rcpt = query<{ body_json: string }>(`SELECT body_json FROM receipts WHERE user_id = ? AND kind = 'earning' AND subject = ?`, userId, m!)
  expect(rcpt).toHaveLength(1)
  expect(JSON.parse(rcpt[0]!.body_json)).toMatchObject({ outcome: 'split', amount: '450001', toEarner: '180001', toClient: '270000', decidedBy: 'rule', terms: { fingerprint: hash, version: 2 } })
  expect(stepsOf(m!)).toEqual(['client:opened', 'earner:submitted', 'rule:timed-out'])

  // money in says how it came, and the receipt says why
  await expect(page.getByRole('region', { name: 'Money in' }).getByText('Your part of a split the job\'s terms set at the end of the client\'s review, with no answer', { exact: false })).toBeVisible()
  await row.getByRole('link', { name: 'See the receipt' }).click()
  await expect(page.getByRole('article', { name: /^Receipt number/ }).getByText(/The client's review ended on .* with no answer, so, as the accepted terms say, ₹1,800\.01 to you and ₹2,700 back to the client\./)).toBeVisible()
  expect(errors).toEqual([])
})

test('the earner disputes the client taking the money back: decider, powers, deadlines and the terms\' defaults named first; the client answers; the household, as the simulated mediator, splits it in exact paise', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await addAuthenticator(page)
  const userId = userOf(await newOwner(page))
  const { ids: [m] } = await openJob(page, { title: 'Spring catalogue copy', client: 'Lakeview Studio', milestones: [{ title: 'Product descriptions', amount: 1_200_001 }] })
  await page.goto('/earn')
  const row = page.locator(`#ms-${m}`)
  const client = row.getByRole('group', { name: 'The client\'s part for Product descriptions, played by you' })

  // the client asks for the money back: it waits, in escrow, for the earner's answer
  await client.getByRole('button', { name: 'Client asks for the money back' }).click()
  await expect(row.getByText('Refund asked', { exact: true })).toBeVisible()
  const [asked] = query<{ due_at: number }>('SELECT due_at FROM earn_milestones WHERE id = ?', m!)
  expect(await nextLines(page, m!)).toEqual([['Next', 'You: agree to give the money back, or dispute it'], ['When', expect.stringMatching(new RegExp(`^By \\w+ \\d+ \\w+, ${dayTime(asked!.due_at).split(', ')[1]}$`))], ['If not', 'It goes back to the client then']])
  expect(ledger(userId, m!)).toEqual([])
  // Home says it needs the earner, with the deadline and what happens without an answer; its link lands on the milestone
  await page.goto('/')
  const need = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'The client asked for the money for Product descriptions back' }) })
  await expect(need).toContainText('₹12,000.01 goes back to the client unless you dispute it.')
  await expect(need).toContainText('If you do nothing by then, it goes back to the client.')
  await need.getByRole('link', { name: 'Open the milestone' }).click()
  await expect(page).toHaveURL(new RegExp(`/earn#ms-${m}$`))
  await expect(row).toBeFocused()
  await expect(row).toBeInViewport()

  // before raising it: who decides, what it may and may not do, by when, and what the terms do if nobody acts. By keyboard.
  const disputeIt = row.getByRole('button', { name: 'Dispute it' })
  await disputeIt.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Dispute the client taking the money back' })
  await expect(sheet.getByText('A simulated mediator, played by you. Once both sides are heard it may release this milestone to the earner, refund it to the client or split it between the two in whole paise, as the accepted terms allow, and move no other money. It is not an arbitrator, a court or a regulated dispute service, and its decision binds no one outside this practice build.')).toBeVisible()
  await expect(sheet.getByText(/With no decision by .*, it is split, 50% to you: ₹6,000\.01 to you and ₹6,000\.00 to the client\./)).toBeVisible()
  await sheet.getByLabel('Why the money should not go back').focus()
  await page.keyboard.type('Half the descriptions are written and the client agreed to wait.')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(sheet.getByRole('button', { name: 'Raise the dispute' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(sheet).toBeHidden()
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')

  // the dispute on its milestone: the dates on screen are the server's, worked out from the terms
  const [d] = query<{ raised_by: string; against: string; evidence_due_at: number; decide_by: number; reason: string }>('SELECT raised_by, against, evidence_due_at, decide_by, reason FROM earn_disputes WHERE milestone_id = ?', m!)
  expect(d).toMatchObject({ raised_by: 'earner', against: 'refund', reason: 'Half the descriptions are written and the client agreed to wait.' })
  const box = row.getByRole('region', { name: 'The dispute over Product descriptions' })
  await expect(box.getByRole('heading', { name: /You dispute the client taking the money back/ })).toBeVisible()
  await expect(box.getByText(`From each side until ${deadline(d!.evidence_due_at)}, up to five statements each. Waiting for the answer of the client, played by you.`)).toBeVisible()
  await expect(box.getByText(`By ${deadline(d!.decide_by)}, once both sides have been heard.`)).toBeVisible()
  await expect(box.getByText('₹12,000.01 stays locked in escrow: neither side can take it. The two sides may still settle it by agreement.')).toBeVisible()
  await expect(box.getByText(`If the client, played by you, does not answer by ${deadline(d!.evidence_due_at)}, it is released to you. With no decision by ${deadline(d!.decide_by)}, it is split, 50% to you: ₹6,000.01 to you and ₹6,000.00 to the client.`)).toBeVisible()
  expect(await nextLines(page, m!)).toEqual([['Next', 'You, as the paper client: answer the dispute with evidence'], ['When', expect.stringMatching(/^By /)], ['If not', 'It is released to you then']])

  // the client answers with evidence: both sides heard, the mediator's move
  await client.getByRole('button', { name: 'Client sends evidence' }).click()
  const ev = page.getByRole('dialog', { name: 'Send the client\'s evidence, played by you' })
  await ev.getByLabel('What the mediator should know').fill('Only the first page was delivered by the date we agreed.')
  await ev.getByRole('button', { name: 'Send it' }).click()
  await expect(ev).toBeHidden()
  await expect(box.getByText('“Only the first page was delivered by the date we agreed.”')).toBeVisible()
  await expect(box.getByText(`With no decision by ${deadline(d!.decide_by)}, it is split, 50% to you: ₹6,000.01 to you and ₹6,000.00 to the client.`, { exact: true })).toBeVisible()
  await expect(box.getByText(`From each side until ${deadline(d!.evidence_due_at)}, up to five statements each. Both sides have been heard.`, { exact: true })).toBeVisible()
  expect(await nextLines(page, m!)).toEqual([['Next', 'You, as the simulated mediator: decide the dispute'], ['When', expect.stringMatching(/^By /)], ['If not', 'It is split then: ₹6,000.01 to you, ₹6,000.00 to the client']])
  const step = page.getByRole('region', { name: 'Who acts next' }).getByRole('listitem').filter({ hasText: 'Product descriptions' })
  await expect(step).toContainText('You, as the mediator')
  await expect(step).toContainText('Decide the dispute')
  await expect(step).toContainText('If not, it is split then: ₹6,000.01 to you, ₹6,000.00 to the client')
  await accessible(page, '.paper-work')
  await accessible(page, '.er-next')
  await noOverflow(page, 'an open dispute')

  // the household, as the simulated mediator, splits it: the client's part is the rest, to the paisa
  const mediator = row.getByRole('group', { name: 'The simulated mediator\'s decision on Product descriptions, played by you' })
  await expect(mediator.getByText('Played by you. Not an arbitrator, a court or a regulated dispute service: it may do only what the accepted terms allow, on this milestone.')).toBeVisible()
  await mediator.getByRole('button', { name: 'Split it' }).click()
  const split = page.getByRole('dialog', { name: 'Split it between the two' })
  await split.getByLabel('To the earner').fill('9000')
  await expect(split.getByText('To the client: ₹3,000.01')).toBeVisible()
  await split.getByRole('button', { name: 'Decide the split' }).click()
  await expect(split).toBeHidden()
  await expect(row.getByText('Split', { exact: true })).toBeVisible()
  await expect(row.locator('.er-ms-next')).toHaveText(/^Split on \d+ \w+, by the simulated mediator's decision: ₹9,000\.00 paid into your bank account, ₹3,000\.01 back to the client\.$/)
  await expect(box.getByText(/by the simulated mediator, played by you: ₹9,000\.00 to the earner, ₹3,000\.01 to the client\./)).toBeVisible()

  // the ledger moved exactly the earner's part; the receipt has both; every step is on record, in its part
  expect(ledger(userId, m!).map((e) => e.amount_text)).toEqual(['900000'])
  const [r] = query<{ body_json: string }>(`SELECT body_json FROM receipts WHERE user_id = ? AND kind = 'earning' AND subject = ?`, userId, m!)
  expect(JSON.parse(r!.body_json)).toMatchObject({ outcome: 'split', amount: '1200001', toEarner: '900000', toClient: '300001', decidedBy: 'mediator' })
  expect(stepsOf(m!)).toEqual(['client:opened', 'client:asked-refund', 'earner:disputed', 'client:evidence', 'mediator:decided'])
  await row.getByText('Every step on record (5)').click()
  const record = row.locator('.er-hist li')
  await expect(record).toHaveCount(5)
  await expect(record.nth(0)).toContainText('Accepted the terms and put ₹12,000.01 in escrow')
  await expect(record.nth(1)).toContainText('You, as the paper client')
  await expect(record.nth(1)).toContainText('Asked for the money back')
  await expect(record.nth(2)).toContainText('Disputed the client taking the money back: “Half the descriptions are written and the client agreed to wait.”')
  await expect(record.nth(4)).toContainText('You, as the simulated mediator')
  await expect(record.nth(4)).toContainText('Decided: ₹9,000.00 to you, ₹3,000.01 to the client')
  await accessible(page, '.paper-work')
  expect(errors).toEqual([])
})

test('work from before terms: no agreed deadline and nothing on its own; one side proposes complete terms, the other accepts them, and the review starts at the agreement, with no money moved', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await addAuthenticator(page)
  const userId = userOf(await newOwner(page))
  // as the review database has it: a paper milestone submitted before terms were recorded, with no terms, no deadline
  const job = `job_before_${userId.slice(-6)}`, mil = `mil_before_${userId.slice(-6)}`
  write(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES (?, ?, 'Quarterly accounts', 'Lakeview Studio', 'open', ?, '{"paperClient":true}')`, job, userId, Date.now() - 20 * 86_400_000)
  write(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, evidence_hash, updated_at) VALUES (?, ?, ?, 'Books closed for the quarter', 1800000, 'submitted', ?, ?)`, mil, job, userId, 'ab'.repeat(32), Date.now() - 10 * 86_400_000)
  await page.goto('/earn')
  const row = page.locator(`#ms-${mil}`)
  const legacy = row.getByRole('region', { name: 'Terms for Books closed for the quarter' })
  await expect(legacy.getByText('No agreed deadline: nothing happens on its own until both sides agree terms.', { exact: true })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Quarterly accounts' }).getByText('Opened before QED recorded terms: no deadlines and no defaults, until both sides agree terms for a milestone.')).toBeVisible()
  expect(await nextLines(page, mil)).toEqual([['Next', 'Both sides, each played by you: agree terms for it'], ['When', 'No agreed deadline'], ['If not', 'Nothing happens on its own until both sides agree terms']])
  const step = page.getByRole('region', { name: 'Who acts next' }).getByRole('listitem').filter({ hasText: 'Books closed for the quarter' })
  for (const said of ['Both sides: you play each', 'Agree terms for it', 'No agreed deadline', 'No agreed terms', 'If not, nothing happens on its own until both sides agree terms']) await expect(step).toContainText(said)
  await accessible(page, '.paper-work')
  await noOverflow(page, 'work from before terms')

  // the earner proposes complete terms for it, read in full: no delivery date for work already submitted
  await legacy.getByRole('button', { name: 'Propose terms, as the earner' }).click()
  const propose = page.getByRole('dialog', { name: 'Propose terms for Books closed for the quarter' })
  await expect(propose.getByLabel('Deliver the work by (optional)')).toHaveCount(0)
  const review = propose.getByRole('group', { name: 'The client\'s review of submitted work' })
  await review.getByLabel('How long').selectOption('2')
  await review.getByLabel('If the client neither accepts nor disputes by then').selectOption('locked')
  await expect(propose.locator('.er-terms-list')).toContainText('2 days, from each submission of the work. If the client neither accepts nor disputes by then: it stays locked in escrow until both sides agree.')
  await expect(propose.locator('.er-terms-list')).toContainText('Books closed for the quarter, ₹18,000.00')
  await accessible(page, 'dialog')
  await propose.getByRole('button', { name: 'Propose and accept them, as the earner' }).click()
  await expect(propose).toBeHidden()
  // nothing binds it until the other side accepts
  const [p] = query<{ id: string; hash: string; proposed_by: string }>('SELECT id, hash, proposed_by FROM earn_terms WHERE milestone_id = ?', mil)
  expect(p!.proposed_by).toBe('earner')
  expect(query('SELECT terms_id, due_at FROM earn_milestones WHERE id = ?', mil)).toEqual([{ terms_id: null, due_at: null }])
  await expect(legacy).toContainText('the client reviews submitted work for 2 days; with no answer by then, it stays locked in escrow until both sides agree. No delivery date. They bind it once you, as the paper client, accept them, and its deadlines start from then.')
  expect(await nextLines(page, mil)).toEqual([['Next', 'Both sides, each played by you: accept the terms proposed, or propose others'], ['When', 'No agreed deadline'], ['If not', 'Nothing happens on its own until both sides agree terms']])

  // the paper client reads them and accepts them by their fingerprint
  await legacy.getByRole('button', { name: 'Read and accept, as the paper client' }).click()
  const accept = page.getByRole('dialog', { name: 'Accept the terms proposed for Books closed for the quarter?' })
  await accept.getByText('Fingerprint of these terms').click()
  await expect(accept.locator('.code')).toHaveText(p!.hash)
  const before = Date.now()
  await accept.getByRole('button', { name: 'Accept them, as the paper client' }).click()
  await expect(accept).toBeHidden()
  await expect(legacy).toBeHidden()
  const [bound] = query<{ terms_id: string; due_at: number; state: string }>('SELECT terms_id, due_at, state FROM earn_milestones WHERE id = ?', mil)
  expect(bound).toMatchObject({ terms_id: p!.id, state: 'submitted' })
  // its review starts at the agreement, never from when the work was submitted
  expect(bound!.due_at).toBeGreaterThanOrEqual(before + 2 * 86_400_000 - 1_000)
  expect(bound!.due_at).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000)
  expect(query<{ side: string }>('SELECT side FROM earn_terms_accepts WHERE terms_id = ? ORDER BY at, rowid', p!.id).map((a) => a.side)).toEqual(['earner', 'client'])
  expect(stepsOf(mil)).toEqual(['earner:terms-proposed', 'client:terms-agreed'])
  expect(ledger(userId, mil)).toEqual([])
  expect(await nextLines(page, mil)).toEqual([['Next', 'You, as the paper client: accept the work or dispute it'], ['When', `Until ${deadline(bound!.due_at)}`], ['If not', 'It stays locked in escrow then, until both sides agree']])
  await row.getByText('The terms agreed for it').click()
  await expect(row.locator('.er-terms-list')).toContainText('2 days, from each submission of the work.')
  expect(errors).toEqual([])
})

test('a review the terms leave locked: nothing happens on its own; the earner offers a settlement and the paper client offers the same, which settles it', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await addAuthenticator(page)
  const userId = userOf(await newOwner(page))
  const { ids: [m] } = await openJob(page, { title: 'Product photographs', client: 'Meera Nair', testSeconds: { review: 5 }, onTimeout: { review: { kind: 'locked' } }, milestones: [{ title: 'Twelve product shots', amount: 900_001 }] })
  await page.goto('/earn')
  const row = page.locator(`#ms-${m}`)
  await row.getByRole('button', { name: 'Submit the work' }).click()
  const sheet = page.getByRole('dialog', { name: 'Submit the work' })
  await sheet.getByLabel('Evidence of the work').fill('Twelve shots, edited, in a shared folder.')
  await sheet.getByRole('button', { name: 'Submit to the client' }).click()
  await expect(sheet).toBeHidden()

  // the review runs out and the terms keep it locked: both sides' move, and nothing on its own
  await expect.poll(() => nextLines(page, m!), { timeout: 60_000 }).toEqual([['Next', 'Both sides, each played by you: agree how to settle it'], ['When', 'No deadline left: the terms keep it locked'], ['If not', 'Nothing happens on its own: it stays locked in escrow']])
  await expect.poll(() => stepsOf(m!), { timeout: 30_000 }).toEqual(['client:opened', 'earner:submitted', 'rule:locked'])
  const step = page.getByRole('region', { name: 'Who acts next' }).getByRole('listitem').filter({ hasText: 'Twelve product shots' })
  await expect(step).toContainText('Locked in escrow')
  await expect(step).toContainText('No deadline left: the terms keep it locked')
  expect(ledger(userId, m!)).toEqual([])

  // the earner offers a split; nothing moves until the client offers the same
  await row.getByRole('button', { name: 'Offer a settlement' }).click()
  const offer = page.getByRole('dialog', { name: 'Offer a settlement, as the earner' })
  await offer.getByLabel('To the earner', { exact: true }).fill('4500')
  await expect(offer.getByText('To the client: ₹4,500.01')).toBeVisible()
  await offer.getByRole('button', { name: 'Make this offer' }).click()
  await expect(offer).toBeHidden()
  await expect(row.locator('.er-offers')).toContainText('₹4,500.00 to the earner, ₹4,500.01 to the client')
  expect(query('SELECT state FROM earn_milestones WHERE id = ?', m!)).toEqual([{ state: 'submitted' }])
  expect(ledger(userId, m!)).toEqual([])
  await accessible(page, '.paper-work')
  await noOverflow(page, 'a locked milestone with an offer')

  // the paper client offers the same: settled by agreement, the earner's part to the paisa
  const client = row.getByRole('group', { name: 'The client\'s part for Twelve product shots, played by you' })
  await client.getByRole('button', { name: 'Client answers your offer' }).click()
  const answer = page.getByRole('dialog', { name: 'Offer a settlement, as the paper client' })
  await expect(answer.getByText(/^You offered ₹4,500\.00 to the earner, ₹4,500\.01 to the client, .*\. Offering the same settles it now\.$/)).toBeVisible()
  await answer.getByRole('button', { name: 'Offer the same: settle it' }).click()
  await expect(answer).toBeHidden()
  await expect(row.getByText('Split', { exact: true })).toBeVisible()
  await expect(row.locator('.er-ms-next')).toHaveText(/^Split on \d+ \w+, by agreement between the two sides: ₹4,500\.00 paid into your bank account, ₹4,500\.01 back to the client\.$/)
  expect(ledger(userId, m!).map((e) => e.amount_text)).toEqual(['450000'])
  const [r] = query<{ body_json: string }>(`SELECT body_json FROM receipts WHERE user_id = ? AND kind = 'earning' AND subject = ?`, userId, m!)
  expect(JSON.parse(r!.body_json)).toMatchObject({ outcome: 'split', toEarner: '450000', toClient: '450001', decidedBy: 'agreement' })
  expect(stepsOf(m!)).toEqual(['client:opened', 'earner:submitted', 'rule:locked', 'earner:offered-settlement', 'client:offered-settlement', 'client:settled-by-agreement'])
  expect(errors).toEqual([])
})
