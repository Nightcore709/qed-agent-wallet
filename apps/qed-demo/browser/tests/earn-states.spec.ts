/**
 * Earn's states the happy path never shows (R12), in the browser, on a stack of its own: its vault service is stopped
 * and started here, which no other journey may see. Two fresh households, each with its own passkey and wallet; the
 * provider prepares a job of two milestones for the client, then:
 *
 *  1. a step waiting for the owner's own signature: the offer asked for and the page left with the passkey's sheet
 *     open. The row and "Who acts next" say it waits for the owner's passkey, that nothing moves until it signs, and
 *     when the request lapses by itself (the time compared with the API's). "Review and sign" withdraws the earlier
 *     request and asks again, so the passkey signs the terms as they stand; the database shows one cancelled, one used.
 *  2. a step waiting for the other side's signature: the client asks to fund and leaves; the provider is told whose
 *     signature it waits for, never when they asked; the client withdraws it and nothing moved.
 *  3. an offer that lapsed: the provider's next move is to offer it again, the client is told to ask for a new offer
 *     and cannot fund it; offering it again signs a new offer. The shortest offer the product allows stands for 45
 *     minutes, so this journey moves the offer's recorded time limit into the past (the one write it makes to the
 *     database, named in lapse() below) rather than wait.
 *  4. the on-chain wallet's service not answering: whose move each milestone is is not claimed, no step can be taken,
 *     "Who acts next" counts the work on the chain instead of listing it; started again, "Try again" brings it back.
 *
 * Accessibility (axe, WCAG 2.0 to 2.2 A and AA) is checked over "Who acts next" and the work on the chain in states 1
 * and 4.
 */
import { DatabaseSync } from 'node:sqlite'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { household, shot } from '../support/vault.ts'

const PORT = Number(process.env.QED_EARN_STATES_PORT ?? extraPort(24))
test.describe.configure({ mode: 'serial' })
// no step waits without end: a control that never comes fails in 30 s, not at the test's ten-minute limit
test.use({ actionTimeout: 30_000 })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { test.setTimeout(180_000); s = await startExtraStack(PORT, {}, { rail: true }) })
test.afterAll(async () => { await s?.stop() })

async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/** Ask for a step and leave the page with the passkey's sheet still open: the request stays open, unsigned. */
async function askAndLeave(page: Page, ask: () => Promise<void>): Promise<void> {
  await ask()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'What your passkey signs' })).toBeVisible({ timeout: 30_000 })
  await page.reload()
}
async function accessible(page: Page, selector: string): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
/**
 * The one write this journey makes to the database: the milestone's recorded offer is given a time limit an hour in the
 * past, so QED reads it back as lapsed. Nothing else changes; the signed quote on the vault service is untouched.
 */
function lapse(db: string, milestoneId: string): number {
  const d = new DatabaseSync(db)
  try {
    d.exec('PRAGMA busy_timeout = 5000')
    const past = String(Math.floor(Date.now() / 1000) - 3600)
    return Number(d.prepare("UPDATE meta SET value = json_set(value, '$.quote.quote.validUntil', ?) WHERE key = ? AND json_extract(value, '$.quote') IS NOT NULL").run(past, `earn.chain.ms:${milestoneId}`).changes)
  } finally { d.close() }
}
/** A photograph for reading (QED_SHOTS): with reduced motion nothing waits to arrive (DESIGN.md M5), so every block is drawn. */
async function still(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await shot(page, name)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
}
const ist = (iso: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(Date.parse(iso))
/**
 * The day Earn names for a time, as its deadline words do (src/screens/Earn.tsx deadlineWords, India time): "today" or
 * "tomorrow". An offer asked for in the ten minutes before midnight lapses after it, tomorrow (a full run of 24 Nov,
 * started at 23:51, expected "today" and read "Lapses tomorrow, 00:03").
 */
const dayOf = (iso: string): string => { const day = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 10); return day(Date.parse(iso)) === day(Date.now()) ? 'today' : 'tomorrow' }

test('Earn\'s states in the browser: a step waiting for your signature (and signing it later), one waiting for the other side\'s, an offer that lapsed and offered again, and the wallet\'s service not answering, each said plainly with what can be done next', async ({ browser }) => {
  test.setTimeout(600_000)
  const P = await household(browser, s.base, s.query), C = await household(browser, s.base, s.query)
  const errors: string[] = []
  for (const x of [P, C]) x.page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const [client] = s.query<{ handle: string }>('SELECT handle FROM users WHERE id = ?', C.personId)
  const [provider] = s.query<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', P.personId)

  // the provider prepares a job of two milestones for the client's handle
  await P.page.goto(`${s.base}/earn`)
  const work = P.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  await work.getByRole('button', { name: 'Prepare a job for another account' }).click()
  const form = work.getByRole('form', { name: 'Prepare a job paid through the escrow' })
  await form.getByLabel('The work', { exact: true }).fill('Rebalancing review')
  await form.getByLabel('The client\'s handle').fill(client!.handle)
  await form.getByLabel('Asset 1').fill('Alpha')
  await form.getByLabel('Yearly swing, %').nth(0).fill('15')
  await form.getByLabel('Asset 2').fill('Beta')
  await form.getByLabel('Yearly swing, %').nth(1).fill('30')
  await form.getByLabel('Milestone 1').fill('First opinion')
  await form.getByLabel('Paid when the work checks out').nth(0).fill('120')
  await form.getByLabel('Deliver within, hours').nth(0).fill('2')
  await form.getByRole('button', { name: 'Add a milestone' }).click()
  await form.getByLabel('Milestone 2').fill('Second opinion')
  await form.getByLabel('Paid when the work checks out').nth(1).fill('40')
  await form.getByLabel('Deliver within, hours').nth(1).fill('2')
  await form.getByRole('button', { name: 'Prepare the job' }).click()
  const job = work.getByRole('article', { name: 'Rebalancing review' })
  const first = job.getByRole('listitem').filter({ hasText: 'First opinion' })
  const second = job.getByRole('listitem').filter({ hasText: 'Second opinion' })
  const next = P.page.getByRole('region', { name: 'Who acts next' })
  await expect(job.getByText('Not offered yet', { exact: true })).toHaveCount(2)

  // 1 · waiting for the owner's own signature
  await askAndLeave(P.page, () => first.getByRole('button', { name: `Offer it to @${client!.handle}` }).click())
  await expect(first.getByText('You asked to offer it and have not signed yet. Nothing moves until your passkey signs it; if you leave it, the request lapses by itself at', { exact: false })).toBeVisible({ timeout: 30_000 })
  const view = await P.page.evaluate(() => fetch('/api/earn/chain').then((r) => r.json())) as { asProvider: { milestones: { title: string; pending: { expiresAt: string | null } | null }[] }[] }
  const expiresAt = view.asProvider.flatMap((j) => j.milestones).find((m) => m.title === 'First opinion')!.pending!.expiresAt!
  await expect(first.getByText(`lapses by itself at ${ist(expiresAt)}.`, { exact: false })).toBeVisible()
  const [open] = s.query<{ expires_at: number }>("SELECT expires_at FROM approvals WHERE user_id = ? AND subject LIKE 'rail:%' ORDER BY created_at DESC LIMIT 1", P.personId)
  expect(Date.parse(expiresAt)).toBe(open!.expires_at)
  const sign = next.getByRole('listitem').filter({ hasText: 'Sign the offer' })
  await expect(sign).toContainText('Awaiting your approval')
  await expect(sign).toContainText(`Lapses ${dayOf(expiresAt)}, ${ist(expiresAt)}`)
  await expect(first.getByRole('button', { name: 'Withdraw it' })).toBeVisible()
  await accessible(P.page, 'section.er-next')
  await accessible(P.page, 'section.chain-work')
  await still(P.page, 'earn-states-1-awaiting-your-signature')
  // signing it now: the earlier request is withdrawn and the offer asked for again, so the passkey signs current terms
  await first.getByRole('button', { name: 'Review and sign' }).click()
  await approveHere(P.page, /The offer above/)
  await expect(first.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })
  const asked = s.query<{ cancelled_at: number | null; consumed_at: number | null }>("SELECT cancelled_at, consumed_at FROM approvals WHERE user_id = ? AND subject LIKE 'rail:%' ORDER BY created_at DESC LIMIT 2", P.personId)
  expect(asked.map((a) => [a.consumed_at !== null, a.cancelled_at !== null])).toEqual([[true, false], [false, true]])

  // 2 · waiting for the other side's signature: the client asks to fund the first milestone and leaves
  await C.page.goto(`${s.base}/earn`)
  const cjob = C.page.getByRole('region', { name: 'Work paid through escrow on the chain' }).getByRole('article', { name: 'Rebalancing review' })
  const cfirst = cjob.getByRole('listitem').filter({ hasText: 'First opinion' })
  await askAndLeave(C.page, () => cfirst.getByRole('button', { name: 'Fund it from your wallet' }).click())
  await expect(cfirst.getByText('You asked to fund it and have not signed yet.', { exact: false })).toBeVisible({ timeout: 30_000 })
  await P.page.reload()
  await expect(first.getByText(`@${client!.handle} has asked to fund it and has not signed yet. Nothing moves until they do.`)).toBeVisible({ timeout: 30_000 })
  const theirs = next.getByRole('listitem').filter({ hasText: 'Signs the funding' })
  await expect(theirs).toContainText(`@${client!.handle}`)
  await expect(theirs).toContainText('Awaiting their approval')
  await expect(first.getByRole('button', { name: /Offer|Fund|Deliver|Review and sign|Release|Refund|Withdraw/ })).toHaveCount(0) // nothing for the provider to do but wait
  await still(P.page, 'earn-states-2-awaiting-their-signature')
  // the client withdraws it: nothing moved, and the offer can still be funded
  await cfirst.getByRole('button', { name: 'Withdraw it' }).click()
  await expect(cfirst.getByText('The funding was not signed', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(cfirst.getByRole('button', { name: 'Fund it from your wallet' })).toBeVisible()
  // the provider is told it was the client's step that went unsigned: news, not something for them to do
  await P.page.reload()
  await expect(first.getByText(`@${client!.handle} did not sign the funding`, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(first.getByText('The funding was not signed', { exact: true })).toHaveCount(0)

  // 3 · an offer that lapsed
  await second.getByRole('button', { name: `Offer it to @${client!.handle}` }).click()
  await approveHere(P.page, /The offer above/)
  await expect(second.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })
  const [ms2] = s.query<{ id: string }>("SELECT m.id FROM earn_milestones m JOIN earn_jobs j ON j.id = m.job_id WHERE j.user_id = ? AND m.title = 'Second opinion'", P.personId)
  expect(lapse(s.db, ms2!.id)).toBe(1)
  await P.page.reload()
  await expect(second.getByText('Offer lapsed', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(second.getByText(/The offer lapsed on .+ without funding\. No money moved\. You can offer it again\./)).toBeVisible()
  const again = next.getByRole('listitem').filter({ hasText: 'Offer it again' })
  await expect(again).toContainText('Expired')
  await expect(again).toContainText('Lapsed ')
  await still(P.page, 'earn-states-3-offer-lapsed')
  await C.page.reload()
  const csecond = cjob.getByRole('listitem').filter({ hasText: 'Second opinion' })
  await expect(csecond.getByText(`To go ahead, ask ${provider!.display_name} to offer it again: it cannot be funded until they do.`)).toBeVisible({ timeout: 30_000 })
  await expect(csecond.getByRole('button', { name: 'Fund it from your wallet' })).toHaveCount(0)
  await expect(C.page.getByRole('region', { name: 'Who acts next' }).getByRole('listitem').filter({ hasText: 'Can offer it again' })).toContainText('Expired')
  // offering it again signs a new offer
  await second.getByRole('button', { name: 'Offer it again' }).click()
  await approveHere(P.page, /The offer above/)
  await expect(second.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(errors).toEqual([])

  // 4 · the on-chain wallet's service not answering
  await s.railDown()
  await P.page.reload()
  const down = work.getByText('The on-chain wallet\'s service is not answering', { exact: true })
  await expect(down).toBeVisible({ timeout: 30_000 })
  await expect(job.getByText('Whose move: not known', { exact: true })).toHaveCount(3) // the job's line and each milestone
  await expect(job.getByText(/The client's move|Your move/)).toHaveCount(0)
  await expect(job.getByRole('button', { name: /Offer|Fund|Deliver|Review and sign|Release|Refund/ })).toHaveCount(0)
  await expect(next.getByText('Not known: the next move on 2 milestones paid through the escrow on the chain.', { exact: false })).toBeVisible()
  await expect(next.getByRole('listitem')).toHaveCount(0)
  await accessible(P.page, 'section.er-next')
  await accessible(P.page, 'section.chain-work')
  await still(P.page, 'earn-states-4-service-not-answering')
  await P.page.setViewportSize({ width: 390, height: 844 })
  expect(await P.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  await still(P.page, 'earn-states-4-service-not-answering-390')
  await P.page.setViewportSize({ width: 1280, height: 860 })
  // "Try again" while it is still down: the page asks again, and says so again
  await next.getByRole('button', { name: 'Try again' }).click()
  await expect(next.getByText('Not known: the next move on 2 milestones paid through the escrow on the chain.', { exact: false })).toBeVisible()
  // started again: the page reads it back, on its own (it asks every 4 s while work is open on the chain) or when
  // asked; whichever comes first, each milestone is the client's move again
  await s.railUp()
  const retry = next.getByRole('button', { name: 'Try again' })
  if (await retry.isVisible()) await retry.click({ timeout: 5_000 }).catch(() => {}) // the page's own read may take it away first
  await expect(down).toHaveCount(0, { timeout: 30_000 })
  await expect(next.getByRole('listitem').filter({ hasText: 'Funds it from their wallet' })).toHaveCount(2)
  await expect(job.getByText('The client\'s move', { exact: true })).toHaveCount(3)
  // the page logged no error at any point, the outage included: an unanswered service is a state, not a fault
  expect(errors).toEqual([])
})
