/**
 * An on-chain dispute, in the browser (R13, audit item E3): three fresh households, each with its own wallet owned by its
 * own passkey: a provider, a client and a third household named to decide. The provider prepares a job with a review
 * and dispute step (periods in seconds: an isolated test stack only, and labelled so), naming the decider; its passkey
 * signs the offer, which binds those terms. The client funds it, seeing the terms first. The provider delivers: the
 * verifier on the chain accepts the certificate, and the money waits in QED's dispute escrow for the client's review
 * instead of reaching the provider. The client disputes with a reason; the provider answers with evidence; once the
 * evidence period has passed, the decider rules a split. Every payment is read back from the chain: the provider's vault,
 * the client's own account, and nothing to the decider.
 */
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '../support/test.ts'
import { query } from '../support/stack.ts'
import { chainCall, household, railGet, shot } from '../support/vault.ts'

async function approveHere(page: Page, signs: RegExp): Promise<void> {
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'What your passkey signs' })).toBeVisible()
  await expect(sheet.getByRole('listitem').filter({ hasText: signs })).toHaveCount(1)
  await shot(page, `dispute-sheet-${Date.now()}`)
  await sheet.getByRole('button', { name: 'Approve and send to the vault with your passkey' }).click()
  await expect(sheet).toBeHidden({ timeout: 30_000 })
}
/**
 * WCAG 2.0 to 2.2 A and AA over one section. With reduced motion nothing waits to arrive (DESIGN.md M5), so no block is
 * measured halfway through its arrival out of blur: a block scrolled into view by a fill arrives then, and axe once
 * read a button mid-arrival as low contrast (directory journey, second run, 24 Nov).
 */
async function accessible(page: Page, selector: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  const r = await new AxeBuilder({ page: page as never }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}
/** A token balance read from the chain itself (ERC-20 balanceOf through the stack's own local chain, over its socket). */
async function onChain(token: string, who: string): Promise<bigint> {
  const data = `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}`
  return BigInt(await chainCall('eth_call', [{ to: token, data }, 'latest']) as string)
}

test('an on-chain dispute through the screens: terms bound by the offer, verified work held for the client\'s review, a dispute with a reason, evidence, and the named decider\'s split paid by the dispute escrow', async ({ browser }) => {
  test.setTimeout(540_000)
  const P = await household(browser), C = await household(browser), D = await household(browser)
  const errors: string[] = []
  for (const x of [P, C, D]) x.page.on('console', (m) => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`) })
  const name = (id: string) => query<{ handle: string; display_name: string }>('SELECT handle, display_name FROM users WHERE id = ?', id)[0]!
  const client = name(C.personId), decider = name(D.personId)
  const contracts = async (railId: string) => (await railGet(`/workspaces/${railId}/state`)).contracts as { vault: string; ownerAccount: string; asset: string }
  const [p, c, d] = [await contracts(P.railId), await contracts(C.railId), await contracts(D.railId)]
  const TITLE = 'Certified sleeve with a review'

  // 1 · the provider prepares the job with a review and dispute step, naming the decider; periods in seconds (test stack)
  await P.page.goto('/earn')
  const work = P.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  await work.getByRole('button', { name: 'Prepare a job for another account' }).click()
  const form = work.getByRole('form', { name: 'Prepare a job paid through the escrow' })
  await form.getByLabel('The work', { exact: true }).fill(TITLE)
  await form.getByLabel('The client\'s handle').fill(client.handle)
  await form.getByLabel('Asset 1').fill('Alpha')
  await form.getByLabel('Yearly swing, %').nth(0).fill('15')
  await form.getByLabel('Asset 2').fill('Beta')
  await form.getByLabel('Yearly swing, %').nth(1).fill('30')
  await form.getByLabel('Milestone 1').fill('Certified weights')
  await form.getByLabel('Paid when the work checks out').fill('200')
  await form.getByLabel('Deliver within, hours').fill('2')
  await form.getByLabel(/The client reviews verified work before you are paid/).check()
  await form.getByLabel('Who decides a dispute').fill(decider.handle)
  await form.getByLabel(/Periods in seconds/).check()
  await form.getByLabel('Review, seconds').fill('600')
  await form.getByLabel('Evidence, seconds').fill('100')
  await form.getByLabel('Ruling within, seconds').fill('900')
  await accessible(P.page, 'section.chain-work')
  await form.getByRole('button', { name: 'Prepare the job' }).click()
  const pjob = work.getByRole('article', { name: TITLE })
  const pms = pjob.getByRole('listitem').filter({ hasText: 'Certified weights' }).first()
  await expect(pms.getByText('Not offered yet', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(pms.getByText(`@${decider.handle}`, { exact: false }).first()).toBeVisible()

  // 2 · the offer: the passkey signs the quote, whose id is the hash of the dispute terms
  await pms.getByRole('button', { name: `Offer it to @${client.handle}` }).click()
  await approveHere(P.page, /The offer above/)
  await expect(pms.getByText('Offered', { exact: true })).toBeVisible({ timeout: 60_000 })

  // 3 · the client sees the terms, then funds it through the dispute escrow
  await C.page.goto('/earn')
  const cwork = C.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  const cms = cwork.getByRole('article', { name: TITLE }).getByRole('listitem').filter({ hasText: 'Certified weights' }).first()
  await expect(cms.getByText('Review and dispute step.', { exact: false })).toBeVisible({ timeout: 30_000 })
  await cms.getByRole('button', { name: 'Fund it from your wallet' }).click()
  await expect(C.page.getByRole('dialog').getByRole('listitem').filter({ hasText: 'Decision: the named decider' })).toHaveCount(1)
  await approveHere(C.page, /withdraw.*approve.*QEDDisputeEscrow\.open/)
  await expect(cms.getByText('In escrow', { exact: true })).toBeVisible({ timeout: 60_000 })

  // 4 · delivery: verified on the chain, held by the dispute escrow for the client's review, not paid to the provider
  const vault0 = await onChain(p.asset, p.vault)
  await P.page.reload()
  await expect(pms.getByText('In escrow', { exact: true })).toBeVisible({ timeout: 30_000 })
  await pms.getByRole('button', { name: 'Deliver the work' }).click()
  await approveHere(P.page, /ProofEscrow\.deliver.*QEDDisputeEscrow\.noteDelivered/)
  await expect(pms.getByText('Verified, under review', { exact: true })).toBeVisible({ timeout: 60_000 })
  expect(await onChain(p.asset, p.vault)).toBe(vault0)
  const disputes = t_disputes()
  expect(await onChain(p.asset, disputes)).toBeGreaterThanOrEqual(20000n)

  // 5 · the client disputes, with its reason
  await C.page.reload()
  await expect(cms.getByText('Verified, under review', { exact: true })).toBeVisible({ timeout: 30_000 })
  await cms.getByRole('button', { name: 'Dispute it' }).click()
  const reason = 'The weights cover the two assets, but we asked for a third, Gamma, in our message.'
  await cms.getByRole('form', { name: 'Dispute the work' }).getByLabel('Why you dispute the work').fill(reason)
  await cms.getByRole('button', { name: 'Prepare the dispute' }).click()
  await approveHere(C.page, /QEDDisputeEscrow\.dispute/)
  await expect(cms.getByText('Disputed', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await shot(C.page, 'dispute-raised')

  // 6 · the provider answers with evidence, inside the evidence period
  await P.page.reload()
  await expect(pms.getByText(reason)).toBeVisible({ timeout: 30_000 })
  await pms.getByRole('button', { name: 'Add evidence' }).click()
  const evidence = 'The quote named exactly two assets, Alpha and Beta; the certificate checks for those.'
  await pms.getByRole('form', { name: 'Add evidence' }).getByLabel('Your evidence').fill(evidence)
  await pms.getByRole('button', { name: 'Prepare the evidence' }).click()
  await approveHere(P.page, /QEDDisputeEscrow\.addEvidence/)
  await expect(pms.getByText(evidence)).toBeVisible({ timeout: 60_000 })

  // 7 · the decider sees both sides, and may rule only once the evidence period has passed
  await D.page.goto('/earn')
  const dwork = D.page.getByRole('region', { name: 'Work paid through escrow on the chain' })
  await expect(dwork.getByRole('heading', { name: 'Disputes you were named to decide' })).toBeVisible({ timeout: 30_000 })
  const dms = dwork.getByRole('article', { name: TITLE }).getByRole('listitem').filter({ hasText: 'Certified weights' }).first()
  await expect(dms.getByText(reason)).toBeVisible()
  await expect(dms.getByText(evidence)).toBeVisible()
  await shot(D.page, 'dispute-decider-reads')
  const rule = dms.getByRole('button', { name: 'Rule on the dispute' })
  await expect(rule).toBeVisible({ timeout: 180_000 })
  await rule.click()
  await dms.getByRole('form', { name: 'Rule on the dispute' }).getByLabel('The provider\'s part').fill('120')
  const [cAcct0, dVault0, dAcct0] = [await onChain(c.asset, c.ownerAccount), await onChain(d.asset, d.vault), await onChain(d.asset, d.ownerAccount)]
  await dms.getByRole('button', { name: 'Prepare the ruling' }).click()
  await approveHere(D.page, /QEDDisputeEscrow\.decide/)
  await expect(dms.getByText('Split', { exact: true })).toBeVisible({ timeout: 60_000 })

  // 8 · paid by the dispute escrow as ruled: ₹120 to the provider's vault, ₹80 to the client's own account, nothing to the decider
  expect((await onChain(p.asset, p.vault)) - vault0).toBe(12000n)
  expect((await onChain(c.asset, c.ownerAccount)) - cAcct0).toBe(8000n)
  expect([await onChain(d.asset, d.vault), await onChain(d.asset, d.ownerAccount)]).toEqual([dVault0, dAcct0])
  expect(query<{ state: string }>(`SELECT m.state FROM earn_milestones m JOIN earn_jobs j ON j.id = m.job_id WHERE j.user_id = ? AND j.title = ?`, P.personId, TITLE)).toEqual([{ state: 'chain-split' }])
  await P.page.reload()
  await expect(pms.getByText('Settled: the decider ruled.', { exact: false })).toBeVisible({ timeout: 30_000 })
  await accessible(P.page, 'section.chain-work')
  await accessible(D.page, 'section.chain-work')
  await shot(P.page, 'dispute-settled')
  expect(errors).toEqual([])

  function t_disputes(): string {
    const rec = query<{ value: string }>(`SELECT value FROM meta WHERE key LIKE 'earn.chain.ms:%' AND value LIKE ?`, `%${TITLE}%`)[0]!
    return String((JSON.parse(rec.value) as { quote: { quote: { payee: string } } }).quote.quote.payee)
  }
})
