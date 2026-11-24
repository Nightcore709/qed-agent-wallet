/**
 * The judge's walk-through, driven through its screen (src/screens/Judge.tsx) the way a person would: by the names of
 * its regions and buttons. Shared by the browser journey (browser/tests/judge.spec.ts, the scripted test double) and
 * the live script (scripts/judge-live.ts, a real model), so both walk exactly the same screen. Each step waits for the
 * page to redraw from the records and returns what the page then says, so a caller can assert it (the journey) or
 * record it (the live script, where a model may answer differently each time).
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The six steps and the four branches, by their headings (judge-view.ts and Judge.tsx). */
export const STEP = {
  authority: 'What you want, and the authority you already signed',
  decision: 'What the model decided',
  checks: 'Checked independently, before anything moved',
  execution: 'Signed once, then run on its own',
  reconciliation: 'The chain\'s record against QED\'s books',
  evidence: 'Evidence you can check here',
} as const
export const BRANCH = {
  changed: 'The same request, one input changed',
  refusal: 'A refusal: an instruction hidden in a bill',
  revocation: 'Revocation: ending the standing policy',
  recovery: 'Recovery: a lost answer, and authority restored',
} as const

export const step = (page: Page, s: keyof typeof STEP): Locator => page.getByRole('region', { name: STEP[s], exact: true })
export const branch = (page: Page, b: keyof typeof BRANCH): Locator => page.getByRole('region', { name: BRANCH[b], exact: true })
/** The outcome stamp of a step, in the shared status words ('' when the step has none yet). */
export async function stampOf(region: Locator): Promise<string> {
  const s = region.locator('.jg-tags .stamp')
  return (await s.count()) ? (await s.first().innerText()).trim() : ''
}
/** A step's main sentence. */
export const findingOf = async (region: Locator): Promise<string> => (await region.locator('.jg-finding').innerText()).trim()

export async function openJudge(page: Page, base = ''): Promise<void> {
  await page.goto(`${base}/judge`)
  await expect(page.getByRole('heading', { level: 1, name: 'From objective to evidence' })).toBeVisible({ timeout: 20_000 })
  await expect(step(page, 'authority')).toBeVisible({ timeout: 30_000 })
}

/**
 * Approve what the wallet's sheet shows, in place: one passkey prompt per digest, then QED sends it and the page follows
 * the job until it ends. The walk-through never leaves its page for this.
 */
export async function approveHere(page: Page, signs?: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible({ timeout: 30_000 })
  if (signs) await expect(sheet.getByRole('listitem').filter({ hasText: signs }).first()).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 60_000 })
}

/** Step 1: sign the example mandate (250 a payment, 600 a day, 2,000 in all, 7 days) when there is none. */
export async function signMandate(page: Page): Promise<string> {
  const s1 = step(page, 'authority')
  if ((await stampOf(s1)) === 'In force') return 'In force'
  await s1.getByRole('button', { name: 'Sign the example mandate with your passkey' }).click()
  await approveHere(page)
  await expect.poll(() => stampOf(s1), { timeout: 60_000 }).toBe('In force')
  return stampOf(s1)
}

const SETTLED = /^(Proposed|Nothing proposed|Failed|Refused by QED's checks)$/
/** Step 2: ask the model the objective (as the field holds it) and wait for its answer to be on the page. */
export async function askObjective(page: Page, timeout = 240_000): Promise<{ stamp: string; finding: string }> {
  const s2 = step(page, 'decision')
  const before = await s2.locator('.jg-finding').innerText()
  await s2.getByRole('button', { name: /^(Ask QED's model|Ask again)$/ }).click()
  await expect.poll(async () => (await s2.locator('.jg-finding').innerText()) !== before && SETTLED.test(await stampOf(s2)), { timeout }).toBe(true)
  return { stamp: await stampOf(s2), finding: await findingOf(s2) }
}

/** Step 4: sign the proposal's exact terms once; the policy is then in force. */
export async function signPolicy(page: Page): Promise<string> {
  const s4 = step(page, 'execution')
  await s4.getByRole('button', { name: 'Review the exact terms and sign once' }).click()
  await approveHere(page)
  await expect.poll(() => stampOf(s4), { timeout: 60_000 }).toMatch(/^(In force|Completed|Refused by QED's checks|Failed|Nothing to do)$/)
  return stampOf(s4)
}

/**
 * Step 4: wait, pressing nothing, until QED's engine has run the signed policy's first tick by itself (it asks within
 * about half a minute of the signature; R13) and the page shows how it ended. The page offers no button for it.
 */
export async function waitForEngineTick(page: Page, timeout = 150_000): Promise<{ stamp: string; finding: string }> {
  const s4 = step(page, 'execution')
  await expect(s4.getByRole('button', { name: /tick/i })).toHaveCount(0)
  await expect.poll(() => stampOf(s4), { timeout }).toMatch(/^(Completed|Refused by QED's checks|Failed|Nothing to do|Reverted by the chain)$/)
  return { stamp: await stampOf(s4), finding: await findingOf(s4) }
}

/** Step 6: recompute every hash of the tick's case in this browser. */
export async function checkHashesHere(page: Page): Promise<string> {
  const s6 = step(page, 'evidence')
  await s6.getByRole('button', { name: 'Check its hashes here' }).click({ timeout: 60_000 })
  const out = s6.getByRole('status')
  await expect(out).toBeVisible()
  return (await out.innerText()).trim()
}

/** A branch's button, pressed, then its rows read once the page has redrawn. */
async function pressAndRead(page: Page, b: keyof typeof BRANCH, button: string | RegExp, until: (region: Locator) => Promise<boolean>, timeout = 240_000): Promise<string> {
  const region = branch(page, b)
  await region.getByRole('button', { name: button }).click()
  await expect.poll(() => until(region), { timeout }).toBe(true)
  return (await region.innerText()).trim()
}

/** Changed inputs: ask to pay 3 and then 300 test rupees; the region lists both decisions. */
export async function askChangedInputs(page: Page): Promise<string> {
  await pressAndRead(page, 'changed', 'Ask to pay 3 test rupees', async (r) => (await r.locator('.jg-rows > li').count()) >= 1)
  return pressAndRead(page, 'changed', 'Ask to pay 300 test rupees', async (r) => (await r.locator('.jg-rows').first().locator('> li').count()) >= 2)
}

/** The refusal: paste the bill with the hidden instruction into Ask; the region says what QED decided and what moved. */
export async function pasteBill(page: Page): Promise<string> {
  return pressAndRead(page, 'refusal', 'Paste the bill into Ask', async (r) => (await r.getByText('QED decided').count()) > 0)
}

/** Revocation: end the policy with the passkey, then ask for a tick anyway; the region shows that tick's outcome. */
export async function revokeAndTry(page: Page): Promise<string> {
  const region = branch(page, 'revocation')
  await region.getByRole('button', { name: 'End the policy with your passkey' }).click()
  await approveHere(page)
  await expect(region.getByText('signed with your passkey')).toBeVisible({ timeout: 60_000 })
  return pressAndRead(page, 'revocation', 'Ask for a tick anyway', async (r) => !/None asked for since/.test(await r.innerText()) && (await r.locator('dd .stamp').count()) >= 2, 120_000)
}

/** Recovery: send one tick request twice with the same key, as a browser does after a lost answer; the page says one job answered both. */
export async function repeatWithOneKey(page: Page): Promise<string> {
  // the button's own label says "with one key" too: wait for the answer's status line itself
  return pressAndRead(page, 'recovery', 'Send one tick request twice, with one key', async (r) => (await r.getByRole('status').filter({ hasText: /Asked \d+ times with one key/ }).count()) > 0, 120_000)
}

/** Recovery: after a revocation, sign the policy again with the passkey; then wait, pressing nothing, for the engine's next tick under it. */
export async function signAgainAndWait(page: Page, timeout = 150_000): Promise<string> {
  const region = branch(page, 'recovery')
  await region.getByRole('button', { name: 'Sign the policy again' }).click()
  await approveHere(page)
  await expect(region.getByText('Authority restored')).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => /The next tick ran again|The next tick: /.test(await region.innerText()), { timeout }).toBe(true)
  return (await region.innerText()).trim()
}
