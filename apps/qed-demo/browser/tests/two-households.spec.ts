/**
 * Two fresh households side by side on the on-chain vault (R7-048, in part), driven through the interface on a stack
 * of their own: each sets up and accepts its vault, signs a mandate, pays, converts, sets money aside for a creditor
 * and signs a standing policy with one tick, concurrently. Then one is paused and the other drained of free funds,
 * the paused one runs a scenario on a throwaway chain, and neither can reach the other's proposals. Every balance the
 * vault screen shows is compared with the chain's own state for both, before and after QED's engine and API, the
 * vault service and its chain are all restarted on the same data; afterwards the paused household's passkey still
 * signs. Earning is part of it too: one household offers the other a job, the other funds it from its wallet, and the
 * escrow pays the first for certified work the verifier on the chain accepts (R7-054 inside R7-048). Not covered
 * here: the household journeys that run on paper venues, and every figure against the engine.
 */
import { expect, type Page, test } from '../support/test.ts'
import { extraPort, startExtraStack } from '../support/stack.ts'
import { approve, household, type RailAt, railGet, treasury } from '../support/vault.ts'

const PORT = Number(process.env.QED_TWO_HOUSEHOLDS_PORT ?? extraPort(16))
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { test.setTimeout(180_000); s = await startExtraStack(PORT, {}, { rail: true }) })
test.afterAll(async () => { await s?.stop() })

/**
 * Raw units as the vault screen writes them, every amount grouped the Indian way: test rupees to the paisa; test dollars
 * to six places where exact, and to the cent (half up) on a headline figure (the finish review of 23 Nov).
 */
const inr = (raw: string): string => { const d = raw.padStart(3, '0'); return `${Number(d.slice(0, -2)).toLocaleString('en-IN')}.${d.slice(-2)}` }
const usd = (raw: string): string => { const d = raw.padStart(7, '0'); return `${Number(d.slice(0, -6)).toLocaleString('en-IN')}.${d.slice(-6).replace(/0+$/, '').padEnd(2, '0')}` }
const usdCents = (raw: string): string => inr(((BigInt(raw) + 5_000n) / 10_000n).toString())
/** The two accounts on the vault screen, as label → shown text. */
async function figures(page: Page): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(() => {
    const out: Record<string, Record<string, string>> = {}
    // each account is a region named by its heading (the Proof wallet, 23 Nov: \`section.vault-acct\`, was \`.tablet\`)
    for (const t of Array.from(document.querySelectorAll('section.vault-acct'))) {
      const name = t.querySelector('h3')?.textContent?.trim() ?? ''
      if (name !== 'Treasury' && name !== 'Reserve') continue
      const kv: Record<string, string> = { balance: (t.querySelector('.lead')?.textContent ?? '').replace(/\s+/g, ' ').trim(), exact: (t.querySelector('.va-exact')?.textContent ?? '').trim() }
      for (const dt of Array.from(t.querySelectorAll('dt'))) kv[(dt.textContent ?? '').trim()] = (dt.nextElementSibling?.textContent ?? '').trim()
      out[name] = kv
    }
    return out
  })
}
/** What the screen shows equals what the chain holds, for both of a household's accounts. */
async function screenMatchesChain(page: Page, railId: string, at: RailAt): Promise<Record<string, any>> {
  await page.goto(`${s.base}/vault`)
  await expect(treasury(page).locator('.lead')).toBeVisible({ timeout: 20_000 })
  const [f, st] = [await figures(page), await railGet(`/workspaces/${railId}/state`, at)]
  // Test rupees are shown with the rupee sign, test dollars with $; the card names the token once, in words.
  expect(f.Treasury!.balance).toBe(`₹${inr(st.treasury.balance)}`)
  expect(f.Treasury!['Set aside for promises']).toMatch(new RegExp(`^₹${inr(st.treasury.ringFenced).replace(/[.,]/g, '\\$&')}`))
  expect(f.Treasury!.Free).toBe(`₹${inr(st.treasury.free)}`)
  // the reserve's headline is to the cent; when the cents hide digits, its exact figure is the quiet line beneath
  expect(f.Reserve!.balance).toBe(`$${usdCents(st.reserve.balance)}`)
  expect(f.Reserve!.exact).toBe(BigInt(st.reserve.balance) % 10_000n === 0n ? '' : `Exactly $${usd(st.reserve.balance)}`)
  return st
}

/** One household's journeys on its vault, through the screens: mandate, payment, conversion, money set aside, a policy and a tick. */
async function journeys(page: Page): Promise<void> {
  await page.goto(`${s.base}/vault`)
  await page.getByLabel('Most in one payment, in test rupees').fill('250')
  await page.getByLabel('Most in a day, in test rupees').fill('600')
  await page.getByLabel('Most over its whole life, in test rupees').fill('2000')
  await page.getByRole('button', { name: 'See the exact mandate' }).click()
  await approve(page, /The mandate above/)

  await page.goto(`${s.base}/vault/treasury`)
  const pay = page.getByRole('region', { name: 'Pay CloudCo' })
  await pay.getByLabel('How much, in test rupees').fill('3')
  await pay.getByRole('button', { name: 'See the exact terms' }).click()
  await approve(page, /The exact text above/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Paid 3.00 test rupees to CloudCo')

  await page.goto(`${s.base}/vault/convert`)
  await page.getByLabel('Convert how much, in test rupees').fill('10')
  await page.getByRole('button', { name: 'Check the limits and get a quote' }).click()
  await page.getByRole('button', { name: 'See the exact order and approve it' }).click()
  await approve(page, /The exact text above/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Converted 10.00 test rupees')

  await page.goto(`${s.base}/vault/treasury`)
  const hold = page.getByRole('region', { name: 'Set money aside for a creditor' })
  await hold.getByLabel('How much to hold, in test rupees').fill('4')
  await hold.getByRole('button', { name: 'See the exact terms' }).click()
  await approve(page, /Your owner account runs this call/)

  await page.goto(`${s.base}/vault/policy`)
  await page.getByLabel('Keep this much free in the reserve, in test dollars').fill('5')
  await page.getByRole('button', { name: 'See the exact policy' }).click()
  await approve(page, /The exact text above/)
  await page.goto(`${s.base}/vault/policy`)
  await page.getByRole('button', { name: 'Tick once now' }).click()
  await page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  // a tick converts a tranche, waits, or finds the target met: each is a finished job
  await expect(page.locator('.page-head').getByText(/^(Completed|No action needed)$/)).toBeVisible({ timeout: 60_000 })
}

/** The vault's sheet for an action taken in place (Earn): approved with the passkey, the page stays where it is. */
async function signInPlace(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/** Earning between the two: p offers c a job, c funds it from its wallet, p delivers certified work the chain verifies. */
async function earn(p: Page, c: Page, clientHandle: string): Promise<void> {
  const job = (x: Page) => x.getByRole('region', { name: 'Work paid through escrow on the chain' }).getByRole('article', { name: 'Side by side sleeve' })
  await p.goto(`${s.base}/earn`)
  const work = p.getByRole('region', { name: 'Work paid through escrow on the chain' })
  await work.getByRole('button', { name: 'Prepare a job for another account' }).click()
  const form = work.getByRole('form', { name: 'Prepare a job paid through the escrow' })
  await form.getByLabel('The work', { exact: true }).fill('Side by side sleeve')
  await form.getByLabel('The client\'s handle').fill(clientHandle)
  await form.getByLabel('Asset 1').fill('Alpha')
  await form.getByLabel('Yearly swing, %').nth(0).fill('15')
  await form.getByLabel('Asset 2').fill('Beta')
  await form.getByLabel('Yearly swing, %').nth(1).fill('30')
  await form.getByLabel('Milestone 1').fill('Certified weights')
  await form.getByLabel('Paid when the work checks out').nth(0).fill('12.50')
  await form.getByLabel('Deliver within, hours').nth(0).fill('2')
  await form.getByRole('button', { name: 'Prepare the job' }).click()
  await job(p).getByRole('button', { name: `Offer it to @${clientHandle}` }).click()
  await signInPlace(p, /The offer above/)
  await expect(job(p).getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })
  await c.goto(`${s.base}/earn`)
  await job(c).getByRole('button', { name: 'Fund it from your wallet' }).click()
  await signInPlace(c, /withdraw.*approve.*open/)
  await expect(job(c).getByText('In escrow', { exact: true })).toBeVisible({ timeout: 60_000 })
  await p.reload()
  await expect(job(p).getByText('In escrow', { exact: true })).toBeVisible({ timeout: 30_000 })
  await job(p).getByRole('button', { name: 'Deliver the work' }).click()
  await signInPlace(p, /deliver/)
  await expect(job(p).getByText('Paid, verified', { exact: true })).toBeVisible({ timeout: 60_000 })
}

test('two households side by side: each pays, converts, sets money aside and signs a policy; one earns from the other through the escrow; one paused, one drained, a scenario; neither reaches the other; after a restart of every service the screens equal the chain and the passkey still signs', async ({ browser }) => {
  test.setTimeout(600_000)
  const at: RailAt = { port: s.railPort, dir: `${s.dir}/vault` }
  const [a, b] = await Promise.all([household(browser, s.base, s.query), household(browser, s.base, s.query)])
  await Promise.all([journeys(a.page), journeys(b.page)])
  for (const h of [a, b]) {
    const st = await railGet(`/workspaces/${h.railId}/state`, at)
    expect(st.mandate?.status).toBe('active')
    expect(st.policy?.status).toBe('active')
    expect(BigInt(st.treasury.ringFenced)).toBe(400n)
    expect(BigInt(st.reserve.balance)).toBeGreaterThan(0n)
  }

  // Earn: a is paid by b through the escrow, for work the verifier on the chain accepts; the price leaves b's vault
  // and arrives in a's, and nothing else moves
  const [bh] = s.query<{ handle: string }>('SELECT handle FROM users WHERE id = ?', b.personId)
  const pre = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  await earn(a.page, b.page, bh!.handle)
  const post = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  expect(BigInt(post[0].treasury.balance) - BigInt(pre[0].treasury.balance)).toBe(1250n)
  expect(BigInt(pre[1].treasury.balance) - BigInt(post[1].treasury.balance)).toBe(1250n)

  // A pauses its vault; B takes every free rupee out to its owner account
  await a.page.goto(`${s.base}/vault`)
  await a.page.getByRole('button', { name: 'Pause the wallet' }).click()
  await approve(a.page, /Your owner account runs this call.*pause/)
  const free = (await railGet(`/workspaces/${b.railId}/state`, at)).treasury.free as string
  const all = `${free.slice(0, -2) || '0'}.${free.slice(-2)}`
  await b.page.goto(`${s.base}/vault/treasury`)
  const own = b.page.getByRole('region', { name: 'Your own money, in and out' })
  await own.getByLabel('How much, in test rupees').fill(all)
  await own.getByRole('button', { name: 'Withdraw' }).click()
  await approve(b.page, /Your owner account runs this call.*withdraw/)
  const [pa, pb] = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  expect(pa.treasury.paused).toBe(true)
  expect(pb.treasury.paused).toBe(false)
  expect(pb.treasury.free).toBe('0')
  expect(BigInt(pa.treasury.free)).toBeGreaterThan(0n)
  // what was withdrawn is in b's owner account, outside the vault; Home shows it as its own line, equal to the chain (RISK-072)
  expect(BigInt(pb.ownerHolds.asset)).toBeGreaterThan(0n)
  await b.page.goto(`${s.base}/`)
  // Bounds draws "Where your money is" as a balance sheet: what you have beside what you owe, each its own list
  const ownLine = b.page.getByRole('region', { name: 'Where your money is' }).getByRole('listitem').filter({ hasText: 'Wallet\'s own account' })
  await expect(ownLine.locator('.val')).toContainText(`₹${inr(pb.ownerHolds.asset)}`)

  // a payment from the drained vault is refused and sends nothing
  await b.page.goto(`${s.base}/vault/treasury`)
  const pay = b.page.getByRole('region', { name: 'Pay CloudCo' })
  await pay.getByLabel('How much, in test rupees').fill('1')
  await pay.getByRole('button', { name: 'See the exact terms' }).click()
  await approve(b.page, /The exact text above/, 'Refused by QED\'s checks; nothing sent')
  expect((await railGet(`/workspaces/${b.railId}/state`, at)).treasury.balance).toBe(pb.treasury.balance)

  // the paused household runs a scenario: fresh contracts on a throwaway chain; neither vault changes
  await a.page.goto(`${s.base}/vault/runs`)
  await a.page.getByRole('listitem').filter({ hasText: 'Above 0 and at most 10 tUSD, to CloudCo.' }).getByRole('button', { name: 'See the terms and run it' }).click()
  const sheet = a.page.getByRole('dialog')
  await expect(sheet.getByText('Nothing here is signed for your vault\'s owner account')).toBeVisible()
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await a.page.waitForURL(/\/vault\/job\//, { timeout: 30_000 })
  await expect(a.page.locator('.page-head').getByText('Completed', { exact: true })).toBeVisible({ timeout: 120_000 })
  const [qa, qb] = await Promise.all([railGet(`/workspaces/${a.railId}/state`, at), railGet(`/workspaces/${b.railId}/state`, at)])
  expect(qa.treasury.balance).toBe(pa.treasury.balance)
  expect(qb.treasury.balance).toBe(pb.treasury.balance)

  // neither can reach the other's proposals, even by naming them
  const latest = (personId: string) => s.query<{ subject: string }>(`SELECT subject FROM approvals WHERE user_id = ? AND purpose = 'rail' ORDER BY created_at DESC LIMIT 1`, personId)[0]!.subject.replace(/^rail:/, '')
  const [ofA, ofB] = [latest(a.personId), latest(b.personId)]
  expect(await b.page.evaluate(async (id) => (await fetch(`/api/vault/proposals/${id}`)).status, ofA)).toBe(404)
  expect(await a.page.evaluate(async (id) => (await fetch(`/api/vault/proposals/${id}`)).status, ofB)).toBe(404)

  // every balance on each screen equals the chain's, before and after a restart of every service
  const before = [await screenMatchesChain(a.page, a.railId, at), await screenMatchesChain(b.page, b.railId, at)]
  await s.restart()
  const after = [await screenMatchesChain(a.page, a.railId, at), await screenMatchesChain(b.page, b.railId, at)]
  for (const i of [0, 1]) {
    for (const k of ['balance', 'ringFenced', 'free', 'paused']) expect(after[i]!.treasury[k]).toBe(before[i]!.treasury[k])
    expect(after[i]!.reserve.balance).toBe(before[i]!.reserve.balance)
    expect(after[i]!.mandate?.hash).toBe(before[i]!.mandate?.hash)
    expect(after[i]!.policy?.id).toBe(before[i]!.policy?.id)
  }
  await expect(treasury(a.page).getByText('Paused')).toBeVisible()

  // after the restart the paused household's passkey still signs: it resumes
  await a.page.getByRole('button', { name: 'Resume the wallet' }).click()
  await approve(a.page, /Your owner account runs this call.*unpause/)
  expect((await railGet(`/workspaces/${a.railId}/state`, at)).treasury.paused).toBe(false)
})
