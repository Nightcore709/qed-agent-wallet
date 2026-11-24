/**
 * The refutation bounties through the interface (R12 section 6; R10-008, R10-009), on a stack of their own whose vault
 * service opens the release's positive controls as claimable bounties 3 and 4 (QED_RAIL_BOUNTY_CONTROLS=1, tests only),
 * with short periods (a 15-second reveal delay, the shortest reveal window it allows, 60 s, and a 10-second contest) and
 * without revealing or settling on its own (QED_RAIL_BOUNTY_AUTO=0), so that the person takes every step:
 *
 *   - a household with no wallet sees the two bounties' statements exactly as the API serves them, the Sepolia record
 *     apart and marked historical, and is told to set its wallet up; Earn links to the page;
 *   - a finder checks a valid claim (the judge accepts it), commits it, reveals it after the delay, waits out the
 *     contest and settles: its reserve vault receives exactly 1,000 tUSD, on the chain and on the wallet's own screen;
 *   - a copier, whose page was open before the finder revealed, pastes the claim copied from the finder's revealed
 *     transaction on the chain: the judge accepts it, and the commitment is refused because the bounty is not open any
 *     more; nothing is recorded and its vault receives nothing;
 *   - the same copier's claim to an original bounty is rejected by the judge with exactly the error recorded on Sepolia
 *     for claim BM1, shown as reproduced here, and refused when committed;
 *   - the paid bounty is shown closed, with its reason; a commitment never revealed lapses, and the page says what that
 *     cost (nothing) and what can be done;
 *   - with the vault service stopped (QED's engine and API still running), the page says it is not answering, what
 *     still stands (the statements and the record) and what to do.
 * No passkey is asked for any bounty step: the server's design (a claimant key with no authority over the wallet).
 * The chain-level race against a copier reading the pending reveal from the mempool is chain/test/bounties.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Locator, type Page, test } from '../support/test.ts'
import { addAuthenticator } from '../support/passkey.ts'
import { APP, extraPort, startExtraStack } from '../support/stack.ts'
import { chainCall, household, newOwner, type RailAt, railGet, shot } from '../support/vault.ts'

const PORT = Number(process.env.QED_BOUNTIES_PORT ?? extraPort(18))
// a 15-second delay: long enough that a claim is still "committed" when the page first shows it on a loaded machine
const RAIL = { QED_RAIL_BOUNTY_CONTROLS: '1', QED_RAIL_BOUNTY_AUTO: '0', QED_RAIL_BOUNTY_REVEAL_DELAY_S: '15', QED_RAIL_BOUNTY_REVEAL_WINDOW_S: '60', QED_RAIL_BOUNTY_CONTEST_S: '10' }
const POOL = 1_000_000_000n // 1,000 tUSD in micro-units
test.describe.configure({ mode: 'serial' })
let s: Awaited<ReturnType<typeof startExtraStack>>
test.beforeAll(async () => { test.setTimeout(240_000); s = await startExtraStack(PORT, {}, { rail: true, railEnv: RAIL }) })
test.afterAll(async () => { await s?.stop() })

// ───────────── the claims, built from the release's own fixtures (vendor/contracts/test/fixtures), as the chain test builds them ─────────────
const FIX = join(APP, 'chain', 'vendor', 'contracts', 'test', 'fixtures')
const cfx = JSON.parse(readFileSync(join(FIX, 'clearing.json'), 'utf8')) as { members: number; debtors: number[]; creditors: number[]; amounts: string[]; optimal: { x: string[]; potential: string[]; y: string[] }; greedy: { x: string[] } }
const mfx = JSON.parse(readFileSync(join(FIX, 'minvar.json'), 'utf8')) as { spec: string; honest: string }
const economy = { members: String(cfx.members), debtor: cfx.debtors.map(String), creditor: cfx.creditors.map(String), d: cfx.amounts.map(String) }
const certified = { x: cfx.optimal.x.map(String), potential: cfx.optimal.potential.map(String), y: cfx.optimal.y.map(String) }
/** BM1 as recorded on Sepolia (19 Oct 2026): the greedy netting is not larger, so MaximalityBounty says the theorem holds. */
const BM1 = { economy, certified, larger: cfx.greedy.x.map(String) }
/** Bounty 4's refutation: the positive control's rule under-reports by 7 tUSD, so the optimal netting is larger. */
const MAX_CONTROL = { economy, certified, larger: cfx.optimal.x.map(String) }
/** ABI words of the fixtures, decoded by hand: unsigned and two's-complement integers, and dynamic arrays by offset. */
const words = (hex: string): string[] => hex.slice(2).match(/.{64}/g)!
const uint = (w: string): bigint => BigInt(`0x${w}`)
const int = (w: string): bigint => { const v = uint(w); return v >= 1n << 255n ? v - (1n << 256n) : v }
const arrayAt = (ws: string[], head: number): bigint[] => { const at = Number(uint(ws[head]!)) / 32; return ws.slice(at + 1, at + 1 + Number(uint(ws[at]!))).map(int) }
const sw = words(mfx.spec), hw = words(mfx.honest)
const n = Number(uint(sw[0]!))
const W = 10n ** 18n
const honest = arrayAt(hw, 0)
/**
 * Bounty 3's refutation: the positive control's verifier accepts anything, so a certificate for the worst portfolio (all
 * in one asset) passes, and the honest optimum beats it by more than the bound (chain/test/bounties.test.ts, optControl).
 */
const OPT_CONTROL = {
  spec: { n: String(n), cov: arrayAt(sw, 1).map(String), tol: String(uint(sw[2]!)), universe: `0x${sw[3]}` },
  certificate: { w: Array.from({ length: n }, (_, i) => (i === 3 ? W : 0n).toString()), nu: '0', mu: Array(n).fill('0'), L: Array((n * (n + 1)) / 2).fill('0') },
  x: honest.map((v, i) => (i === 0 ? v + W - honest.reduce((a, b) => a + b, 0n) : v).toString()),
}

/** The judge's claim inside a reveal on the chain: QEDBountyBoard.reveal(uint256 bountyId, address recipient, bytes claim, bytes32 salt). */
function claimOfReveal(input: string): string {
  const a = input.slice(10)
  const w = (i: number) => a.slice(i * 64, (i + 1) * 64)
  const at = Number(BigInt(`0x${w(2)}`)) / 32
  const len = Number(BigInt(`0x${w(at)}`))
  return `0x${a.slice((at + 1) * 64, (at + 1) * 64 + len * 2)}`
}
/** The journey stack's own chain, over its socket as its vault service reaches it (support/vault.ts chainCall). */
const anvil = (method: string, params: unknown[]): Promise<any> => chainCall(method, params, { port: s.railPort, dir: `${s.dir}/vault` })

const SHOTS = process.env.QED_BOUNTY_SHOTS
const bounties = (page: Page) => page.goto(`${s.base}/earn/bounties`)
const make = (page: Page) => page.getByRole('region', { name: 'Make a claim' })
const mine = (page: Page, bounty: string) => page.getByRole('region', { name: 'Your claims' }).getByRole('article', { name: new RegExp(`^Bounty ${bounty}:`) })
const onBoard = (page: Page, bounty: string) => page.getByRole('region', { name: 'On this computer\'s chain' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: new RegExp(`^Bounty ${bounty}:`) }) })
/** Choose a bounty, paste the claim, and ask the judge. */
async function ask(page: Page, bounty: string, claim: unknown): Promise<Locator> {
  const m = make(page)
  await m.getByRole('radio', { name: new RegExp(`^Bounty ${bounty}:`) }).check()
  await m.getByLabel('The claim', { exact: true }).fill(JSON.stringify(claim))
  await m.getByRole('button', { name: 'Check with the judge' }).click()
  return m
}
/** A reserve amount as the vault screen writes its headline: test dollars to the cent (half up), grouped the Indian way (as two-households.spec.ts reads it). */
const usdCents = (raw: string): string => { const d = ((BigInt(raw) + 5_000n) / 10_000n).toString().padStart(3, '0'); return `${Number(d.slice(0, -2)).toLocaleString('en-IN')}.${d.slice(-2)}` }
const reserveOf = async (railId: string, at: RailAt): Promise<bigint> => BigInt((await railGet(`/workspaces/${railId}/state`, at)).reserve.balance as string)
async function axe(page: Page): Promise<void> {
  const r = await new AxeBuilder({ page: page as never }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(', ')}`)).toEqual([])
}

test('a household without a wallet: Earn links to the bounties; the statements exactly as served, the Sepolia record apart and historical, and a way to set the wallet up', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  await addAuthenticator(page)
  await newOwner(page, s.base)
  await page.goto(`${s.base}/earn`)
  await page.getByRole('link', { name: 'Refutation bounties' }).click()
  await expect(page).toHaveURL(/\/earn\/bounties$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Refutation bounties')
  await expect(page.getByText('Test chain on this computer; tokens of no value')).toBeVisible()
  // what the household can do: set its wallet up (no claim form without one)
  const note = page.getByText('Set up your on-chain wallet to claim')
  await expect(note).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('link', { name: 'Set up your on-chain wallet' })).toHaveAttribute('href', '/vault')
  await expect(make(page)).toHaveCount(0)
  // the statements and limits are the API's own text, every field, unchanged
  const api = (await (await page.request.get(`${s.base}/api/bounties`)).json()) as { originals: { name: string; theorem: string; invites: string; test: string; limits: string[]; pays: string; status: string; attempts: { step: string; error: { name: string; args: string[] } }[] }[] }
  const said = page.getByRole('region', { name: 'What the two bounties state' })
  expect(api.originals.map((o) => o.name)).toEqual(['OptimalityBounty', 'MaximalityBounty'])
  for (const o of api.originals) {
    const card = said.getByRole('article', { name: o.name })
    await expect(card.getByText(o.theorem, { exact: true })).toBeVisible()
    await expect(card.getByText(o.invites, { exact: true })).toBeVisible()
    await expect(card.getByText(o.pays, { exact: true })).toBeVisible()
    for (const l of o.limits) await expect(card.getByRole('listitem').filter({ hasText: l })).toHaveCount(1)
    await card.getByText('The exact test, in the contract\'s integers').click()
    await expect(card.getByText(o.test, { exact: true })).toBeVisible()
  }
  // the record from Sepolia, apart: labelled historical and not re-verified, with its five claims and their errors
  const past = page.getByRole('region', { name: 'Recorded on Sepolia, 19 October 2026' })
  await expect(past.getByText('Historical; not re-verified')).toBeVisible()
  for (const o of api.originals) {
    const card = past.getByRole('article', { name: `${o.name} on Sepolia` })
    await expect(card.getByText(o.status, { exact: true })).toBeVisible()
    for (const a of o.attempts) await expect(card.getByRole('listitem').filter({ hasText: a.step }).getByText(`${a.error.name}(${a.error.args.join(', ')})`)).toBeVisible()
  }
  await expect(past.getByText(/Positive control|this computer's chain/)).toHaveCount(0)
  await shot(page, 'bounties-no-wallet')
  await axe(page)
  await context.close()
})

test('a finder checks, commits, reveals and settles a valid claim and its reserve vault receives exactly 1,000 tUSD; a copier of the revealed claim earns nothing; a claim the judge rejects is refused with the judge\'s reason, the one recorded on Sepolia; the paid bounty is closed; a commitment never revealed lapses', async ({ browser }) => {
  test.setTimeout(600_000)
  const at: RailAt = { port: s.railPort, dir: `${s.dir}/vault` }
  const [finder, copier, lapser] = await Promise.all([household(browser, s.base, s.query), household(browser, s.base, s.query), household(browser, s.base, s.query)])
  const [finder0, copier0, lapser0] = await Promise.all([reserveOf(finder.railId, at), reserveOf(copier.railId, at), reserveOf(lapser.railId, at)])

  // ── the lapser commits a valid claim to bounty 4 and will never reveal it ──
  const l = lapser.page
  await bounties(l)
  await expect(onBoard(l, '4').getByText('Open', { exact: true })).toBeVisible({ timeout: 20_000 })
  await ask(l, '4', MAX_CONTROL)
  await expect(make(l).getByText('The judge accepts this claim: it refutes the theorem')).toBeVisible({ timeout: 20_000 })
  await make(l).getByRole('button', { name: 'Commit the claim' }).click()
  await expect(make(l).getByText(/^Committed to bounty 4 as commitment #\d+$/)).toBeVisible({ timeout: 30_000 })
  await expect(mine(l, '4').getByText('Pending', { exact: true })).toBeVisible()

  // ── the copier's page is open before anyone reveals; first, a claim the judge rejects (BM1, as recorded on Sepolia) ──
  const c = copier.page
  await bounties(c)
  await expect(onBoard(c, '3').getByText('Open', { exact: true })).toBeVisible({ timeout: 20_000 })
  const asked = await ask(c, '2', BM1)
  const ruling = asked.getByRole('alert').filter({ hasText: 'The judge rejects this claim: it does not refute the theorem' })
  await expect(ruling).toBeVisible({ timeout: 20_000 })
  await expect(ruling.getByText(/^The theorem holds for this claim: the certified netting cancels 169(\.00)? tUSD and the challenger 162(\.00)? tUSD, which is not more\. Nothing would be paid\.$/)).toBeVisible()
  await expect(ruling.getByText('TheoremHolds(169000000, 162000000)')).toBeVisible()
  await expect(ruling.getByText(/^Reproduced on this computer: the judge here gives exactly the answer recorded on Sepolia for claim BM1 on 19 Oct 2026, 22:4\d:\d\d UTC \(historical, not re-verified\)\.$/)).toBeVisible()
  await asked.getByRole('button', { name: 'Commit the claim' }).click()
  const rejected = asked.getByRole('alert').filter({ hasText: 'Refused by QED\'s checks: the judge rejects this claim' })
  await expect(rejected).toBeVisible({ timeout: 20_000 })
  await expect(rejected.getByText(/^The judge rejects this claim, so it cannot be paid: The theorem holds for this claim/)).toBeVisible()
  await expect(rejected.getByText('Nothing was recorded or sent. A claim the judge rejects can never be paid: check a different claim.')).toBeVisible()
  await shot(c, 'bounties-rejected')
  expect((await railGet(`/workspaces/${copier.railId}/bounties`, at)).claims).toEqual([])

  // ── the finder: the judge accepts its claim; it commits, waits out the delay, reveals ──
  const f = finder.page
  await bounties(f)
  await onBoard(f, '3').getByRole('button', { name: 'Claim bounty 3' }).click()
  await expect(make(f).getByRole('radio', { name: /^Bounty 3:/ })).toBeChecked()
  await expect(make(f).getByLabel('The claim', { exact: true })).toBeFocused()
  await make(f).getByLabel('The claim', { exact: true }).fill(JSON.stringify(OPT_CONTROL))
  await make(f).getByRole('button', { name: 'Check with the judge' }).click()
  await expect(make(f).getByText('The judge accepts this claim: it refutes the theorem')).toBeVisible({ timeout: 20_000 })
  await expect(make(f).getByText(/No passkey is asked/)).toBeVisible()
  await make(f).getByRole('button', { name: 'Commit the claim' }).click()
  await expect(make(f).getByText(/^Committed to bounty 3 as commitment #\d+$/)).toBeVisible({ timeout: 30_000 })
  const claim = mine(f, '3')
  await expect(claim.getByText('Pending', { exact: true })).toBeVisible()
  await expect(claim.getByText(/^Reveal it from \d\d:\d\d:\d\d, before \d\d:\d\d:\d\d: this vault service does not reveal claims on its own\.$/)).toBeVisible()
  await expect(f.getByRole('dialog')).toHaveCount(0) // no passkey sheet at any step
  await shot(f, 'bounties-committed')
  await expect(claim.getByText('Ready to reveal', { exact: true }).first()).toBeVisible({ timeout: 45_000 })
  await claim.getByRole('button', { name: 'Reveal the claim' }).click()
  await expect(claim.getByText(/^The judge accepted the revealed claim\. The pool, 1,000\.00 tUSD, goes to your reserve vault at settlement, from \d\d:\d\d:\d\d, unless an older commitment is revealed before then\.$/)).toBeVisible({ timeout: 30_000 })
  await expect(claim.getByText('Leading.', { exact: true })).toBeVisible()
  await shot(f, 'bounties-leading')

  // ── the copier reads the claim from the finder's reveal on the chain and tries it from its page, still showing bounty 3 open ──
  const revealed = (await railGet(`/workspaces/${finder.railId}/bounties`, at)).claims.find((x: any) => x.bountyId === '3')
  const tx = await anvil('eth_getTransactionByHash', [revealed.revealed.tx])
  const copied = claimOfReveal(String(tx.input))
  expect(copied.slice(0, 10)).toBe('0x88c7acb3') // OptimalityBounty.claim: the claim itself, public once revealed
  await expect(onBoard(c, '3').getByText('Open', { exact: true })).toBeVisible() // not read again since it opened
  const tried = await ask(c, '3', { calldata: copied })
  await expect(tried.getByText('The judge accepts this claim: it refutes the theorem')).toBeVisible({ timeout: 20_000 })
  await tried.getByRole('button', { name: 'Commit the claim' }).click()
  const notOpen = tried.getByRole('alert').filter({ hasText: 'Refused by QED\'s checks: this bounty is not open' })
  await expect(notOpen).toBeVisible({ timeout: 20_000 })
  await expect(notOpen.getByText('A valid claim has already been revealed for this bounty; a commitment recorded now would be younger than it and could not win.')).toBeVisible()
  await expect(notOpen.getByText('Nothing was recorded or sent, and this claim earns nothing: only the commitment made first is paid. Choose a bounty that is open.')).toBeVisible()
  // the page has read the chain again: bounty 3 takes no claim. It is in its 10-second contest, or, on a loaded
  // machine where the copier's attempt took longer, past it and waiting to be settled; the refusal is the same in both.
  await expect(onBoard(c, '3').getByText(/^(Contest|Ready to settle)$/)).toBeVisible({ timeout: 10_000 })
  await expect(tried.getByText('Bounty 3 takes no claim now.')).toBeVisible()
  await expect(tried.getByRole('button', { name: 'Commit the claim' })).toHaveCount(0)
  await shot(c, 'bounties-copier-refused')
  expect((await railGet(`/workspaces/${copier.railId}/bounties`, at)).claims).toEqual([])

  // ── the contest ends; the finder settles; its reserve vault receives exactly 1,000 tUSD ──
  await claim.getByRole('button', { name: 'Settle and pay' }).click({ timeout: 40_000 })
  await expect(claim.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(claim.getByText('Won.', { exact: true })).toBeVisible()
  await expect(claim.getByText('1,000.00 tUSD paid to your reserve vault.', { exact: true })).toBeVisible()
  expect(await reserveOf(finder.railId, at) - finder0).toBe(POOL)
  expect(await reserveOf(copier.railId, at) - copier0).toBe(0n)
  await expect(onBoard(f, '3').getByText('Paid and closed', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(onBoard(f, '3').getByText('It paid 1,000.00 tUSD to your reserve vault and takes no more claims.')).toBeVisible()
  await shot(f, 'bounties-won')
  // the wallet's own screen shows the reserve with the payout in it
  const after = await reserveOf(finder.railId, at)
  await f.goto(`${s.base}/vault`)
  const reserve = f.locator('section.vault-acct').filter({ has: f.getByRole('heading', { name: 'Reserve', exact: true }) })
  await expect(reserve.locator('.lead')).toHaveText(`$${usdCents(after.toString())}`, { timeout: 20_000 })

  // ── the copier, reading the chain again: the bounty is paid and closed, to another household's recipient ──
  await c.reload()
  await expect(onBoard(c, '3').getByText('Paid and closed', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(onBoard(c, '3').getByText(/^It paid 1,000\.00 tUSD to another claimant's recipient \(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}\) and takes no more claims\.$/)).toBeVisible()
  await make(c).getByRole('radio', { name: /^Bounty 3:/ }).check()
  await expect(make(c).getByText('Bounty 3 takes no claim now.')).toBeVisible()
  await expect(c.getByRole('region', { name: 'Your claims' })).toHaveCount(0)
  await shot(c, 'bounties-closed')

  // ── the lapser's commitment, never revealed, lapses: nothing paid, nothing lost, and it may commit again ──
  const lapsed = (await railGet(`/workspaces/${lapser.railId}/bounties`, at)).claims[0]
  const wait = Number(lapsed.committed.expiresAt) * 1000 - Date.now() + 3000
  if (wait > 0) await l.waitForTimeout(wait)
  const mineL = mine(l, '4')
  await expect(mineL.getByText('Expired', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(mineL.getByText(/^It was not revealed before \d\d:\d\d:\d\d, so it can no longer be paid\. Nothing was paid out and nothing was lost\.$/)).toBeVisible()
  await expect(mineL.getByText('Commit it again: paste the claim into "Make a claim". A new commitment gets a new delay and a new reveal window.')).toBeVisible()
  await expect(mineL.getByRole('button', { name: /Reveal|Settle/ })).toHaveCount(0)
  expect(await reserveOf(lapser.railId, at) - lapser0).toBe(0n)
  await expect(onBoard(l, '4').getByText('Open', { exact: true })).toBeVisible()
  await shot(l, 'bounties-lapsed')

  // ── the finder's page, once more: accessible, and photographed at a computer's and a phone's width in both themes ──
  await bounties(f)
  await expect(mine(f, '3').getByText('Completed', { exact: true })).toBeVisible({ timeout: 20_000 })
  await axe(f)
  if (SHOTS) {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        await f.setViewportSize({ width: w, height: h })
        await f.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await f.waitForTimeout(400)
        await f.screenshot({ path: join(SHOTS, `journey-finder-${w}-${scheme}.png`), fullPage: true, animations: 'disabled' })
        await l.setViewportSize({ width: w, height: h })
        await l.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await l.waitForTimeout(400)
        await l.screenshot({ path: join(SHOTS, `journey-lapsed-${w}-${scheme}.png`), fullPage: true, animations: 'disabled' })
      }
    }
  }

  // ── the vault service stops (QED's engine and API still run): the page says so, what still stands, and what to do ──
  await s.stopRail()
  await f.setViewportSize({ width: 1280, height: 860 })
  await f.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await bounties(f)
  const down = f.getByRole('alert').filter({ hasText: 'The wallet service is not answering' })
  await expect(down).toBeVisible({ timeout: 20_000 })
  await expect(down.getByText(/^The bounties' statements and the Sepolia record on this page do not depend on it\. Your claims are kept by the service and its chain; a claim must still be revealed before it lapses, so start the service again before then\.$/)).toBeVisible()
  await expect(down.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(f.getByRole('region', { name: 'What the two bounties state' }).getByRole('article')).toHaveCount(2)
  await expect(f.getByRole('region', { name: 'Recorded on Sepolia, 19 October 2026' }).getByRole('article')).toHaveCount(2)
  await expect(make(f)).toHaveCount(0)
  await shot(f, 'bounties-service-down')
})

