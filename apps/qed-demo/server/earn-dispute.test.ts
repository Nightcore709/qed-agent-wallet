/**
 * The dispute step for work paid on the chain (R13 E3; server/earn-chain.ts), against the recording stand-in of the
 * rail's HTTP contract (server/rail-fake.ts). The rail's own test (chain/test/disputes.test.ts) shows the chain side on
 * Anvil, and chain/disputes the contract's Forge suite. Here: the terms QED lets a provider choose (a third household
 * as decider, the paper escrow's bounds, seconds only on a test stack); that the quote and the funding carry them to
 * the vault service; who may take each step and in which state; that the decider sees nothing before funding; that the
 * texts are kept and tied to the hashes on the chain; and the states read back, a split included.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { acceptChainWork, addChainEvidence, createChainJob, decideChainDispute, deliverChainMilestone, disputeChainWork, disputeChoice, earnChainView, finishChainWork, fundChainMilestone, giveWayChainWork, quoteChainMilestone } from './earn-chain.ts'
import { beginSignup, finishSignup, type RelyingParty } from './passkeys.ts'
import { type Asker, railExecute, railSetup, railSignBegin, railSignFinish, railWorkspaceId } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'
import { addMember, createBusiness } from './workspaces.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
const PROBLEM = { kind: 'custom', assets: [{ name: 'Alpha', volatilityBps: 1500 }, { name: 'Beta', volatilityBps: 3000 }] }
const DISPUTE = { deciderHandle: 'meera', reviewDays: 7, evidenceDays: 3, decisionDays: 5, onReviewPct: 100, onDecisionPct: 50, may: { pay: true, refund: true, split: true } }
const now = () => Math.floor(T0 / 1000)

beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => {
  fake.reset()
  let n = 0
  // the rail's answers, as chain/test/disputes.test.ts shows them for real
  fake.outcome['escrow-quote'] = (p, w) => {
    const q = { provider: w.ownerAccount, payee: `0x${'d1'.repeat(20)}`, client: `0x${'d1'.repeat(20)}`, token: `0x${'11'.repeat(20)}`, price: String(Math.round(Number(p!.params.price) * 100)), verifier: `0x${'22'.repeat(20)}`, specHash: `0x${'33'.repeat(32)}`, deliverBy: String(now() + 7200), validUntil: String(now() + 3600), quoteId: `0x${String(++n).padStart(64, '0')}` }
    const terms = { client: p!.params.client, payee: w.vault, decider: (p!.params.dispute as { decider: string }).decider, deciderMay: 7, reviewPeriod: 604800, evidencePeriod: 259200, decisionPeriod: 432000, reviewTimeoutBps: 10000, decisionTimeoutBps: 5000, salt: `0x${'5a'.repeat(32)}` }
    return { outcome: 'executed', summary: 'Signed.', evidence: { quote: q, quoteHash: `0x9a${q.quoteId.slice(4)}`, signature: `0x${'44'.repeat(80)}`, spec: '0x1234', problem: p!.params.problem, dispute: { escrow: q.client, terms, termsHash: q.quoteId, words: ['Review: the client has 7 days.', 'Evidence: 3 days.', 'Decision: by 5 days.', 'Timeout: half each.', 'Either side may give way.'] } } }
  }
  fake.outcome['escrow-fund'] = (p, w) => {
    const id = String(fake.escrow.size + 1)
    const provider = [...fake.workspaces.values()].find((x) => x.ownerAccount === (p!.params.quote as { provider: string }).provider)!
    const decider = [...fake.workspaces.values()].find((x) => x.ownerAccount === (p!.params.dispute as { decider: string }).decider)!
    fake.escrow.set(id, { jobId: id, status: 'open', roles: ['client'], quoteHash: `0x9a${(p!.params.quote as { quoteId: string }).quoteId.slice(4)}`, price: (p!.params.quote as { price: string }).price, deliverByTime: new Date((now() + 7200) * 1000).toISOString(), refundable: false, opened: { tx: `0x${'aa'.repeat(32)}`, block: '10' }, settled: null, refunded: null, solutionHash: null, authority: null, parties: [w.id, provider.id, decider.id],
      dispute: { disputeId: id, status: 'funded', outcome: 'none', toProvider: '0', toClient: '0', reviewEndsAt: 0, evidenceEndsAt: 0, decideBy: 0, reason: null, evidence: [], canAccept: false, canDispute: false, canAddEvidence: false, canDecide: false, canFinish: false } })
    return { outcome: 'executed', summary: `Funded #${id}.`, evidence: { escrowJobId: id, disputeJobId: id } }
  }
  const d = (id: unknown) => (fake.escrow.get(String(id))!.dispute as Record<string, unknown>)
  fake.outcome['escrow-deliver'] = (p) => { Object.assign(fake.escrow.get(String(p!.params.jobId))!, { status: 'settled' }); Object.assign(d(p!.params.jobId), { status: 'delivered', reviewEndsAt: now() + 604800, canAccept: true, canDispute: true }); return { outcome: 'executed', summary: 'Delivered for review.', evidence: {} } }
  fake.outcome['escrow-dispute'] = (p) => { Object.assign(d(p!.params.disputeId), { status: 'disputed', evidenceEndsAt: now() + 259200, decideBy: now() + 432000, canDispute: false, canAddEvidence: true, reason: { hash: '0xr1', tx: '0xt1' } }); return { outcome: 'executed', summary: 'Disputed.', evidence: { reason: p!.params.reason, reasonHash: '0xr1' } } }
  fake.outcome['escrow-evidence'] = (p) => { const x = d(p!.params.disputeId); (x.evidence as unknown[]).push({ by: 'provider', hash: '0xe1', tx: '0xt2' }); return { outcome: 'executed', summary: 'Evidence.', evidence: { text: p!.params.text, evidenceHash: '0xe1', by: 'provider' } } }
  fake.outcome['escrow-decide'] = (p) => { Object.assign(d(p!.params.disputeId), { status: 'closed', outcome: 'decided', toProvider: String(Math.round(Number(p!.params.toProvider) * 100)), toClient: String(25075 - Math.round(Number(p!.params.toProvider) * 100)), canAccept: false, canAddEvidence: false, canDecide: false }); return { outcome: 'executed', summary: 'Ruled.', evidence: {} } }
})

async function person(db: Db, handle: string): Promise<{ auth: SoftAuthenticator; who: Asker }> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle[0]!.toUpperCase() + handle.slice(1) }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  return { auth, who: { workspaceId: r.personId, personId: r.personId, role: 'owner', session: sessionFor(db, r.session.token, T0)! } }
}
async function signAndSend(db: Db, who: Asker, p: Record<string, unknown>, auth: SoftAuthenticator, at: number) {
  const begin = await railSignBegin(db, RP, who, String(p.approvalId), at)
  await railSignFinish(CFG, db, RP, who, String(p.approvalId), begin.challenges.map((c) => ({ challengeId: c.challengeId, response: auth.get(c.options as never) })), String(p.docHash), at + 1)
  return railExecute(CFG, db, who, String((p.proposal as { id: string }).id), String(p.approvalId), at + 2)
}
async function world() {
  const db = openDb(':memory:')
  const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), meera = await person(db, 'meera'), kiran = await person(db, 'kiran')
  for (const x of [asha, ravi, meera]) await railSetup(CFG, db, RP, x.who, RP.origins[0], T0)
  return { db, asha, ravi, meera, kiran }
}
const JOB = (dispute: unknown = DISPUTE) => ({ key: `job-key-${Math.random().toString(36).slice(2, 10)}`, title: 'Portfolio sleeve', clientHandle: 'ravi', problem: PROBLEM, milestones: [{ title: 'Certified weights', amount: 25075, deliverWithinHours: 2 }], dispute })
type M = { id: string; state: string; status: string; actions: string[]; dispute: { decider: { handle: string; name: string | null }; terms: { review: string; words: string[] | null }; reason: { text: string; onChain: boolean } | null; evidence: { by: string; text: string; onChain: boolean }[]; outcome: { kind: string; toProvider: number; toClient: number } | null } | null }
type View = { asProvider: { milestones: M[] }[]; asClient: { milestones: M[] }[]; asDecider: { milestones: M[] }[] }
const view = async (db: Db, who: Asker, at: number) => (await earnChainView(CFG, db, who, at)) as unknown as View

describe('the dispute step on the chain, from the Earn flow', () => {
  it('the terms: a third household with a wallet and no member in common as decider, answered alike whoever it is not; the paper escrow\'s bounds; seconds only on a test stack', async () => {
    const { db, asha, ravi, meera } = await world()
    const refusal = (over: Record<string, unknown>) => createChainJob(CFG, db, asha.who, JOB({ ...DISPUTE, ...over }), T0).then(() => null, (e: { code: string; fields?: Record<string, string>; message: string }) => e)
    const answers = await Promise.all(['ravi', 'asha', 'kiran', 'nobody'].map((h) => refusal({ deciderHandle: h })))
    for (const a of answers) expect(a).toMatchObject({ code: 'invalid', fields: { deciderHandle: 'Name a third household with an on-chain wallet, sharing no member with you or the client.' } })
    expect((await refusal({ reviewDays: 0 }))?.fields).toHaveProperty('reviewDays')
    expect((await refusal({ reviewDays: 15 }))?.fields).toHaveProperty('reviewDays')
    expect((await refusal({ evidenceDays: 5, decisionDays: 4 }))?.fields).toHaveProperty('decisionDays')
    expect((await refusal({ onDecisionPct: 101 }))?.fields).toHaveProperty('onDecisionPct')
    expect((await refusal({ may: { pay: false, refund: false, split: false } }))?.fields).toHaveProperty('may')
    expect((await refusal({ testSeconds: { review: 60, evidence: 60, decision: 120 } }))?.fields).toHaveProperty('testSeconds')
    // on an isolated test stack, periods in seconds
    expect(disputeChoice(db, asha.who.workspaceId, ravi.who.workspaceId, { ...DISPUTE, testSeconds: { review: 120, evidence: 60, decision: 180 } }, { QED_TEST_STACK: '1' })).toMatchObject({ reviewSeconds: 120, evidenceSeconds: 60, decisionSeconds: 180, test: true })
    // a decider who shares a member with the provider (here a business Meera belongs to) is not independent
    const biz = createBusiness(db, asha.who.personId, 'Asha and Meera Ltd', T0)
    addMember(db, biz, { personId: asha.who.personId, role: 'owner' }, 'meera', 'approver', T0)
    expect(() => disputeChoice(db, biz, ravi.who.workspaceId, DISPUTE)).toThrow(expect.objectContaining({ fields: { deciderHandle: expect.any(String) } }))
    expect(disputeChoice(db, asha.who.workspaceId, ravi.who.workspaceId, DISPUTE)).toMatchObject({ deciderWs: meera.who.workspaceId })
  })

  it('a dispute: the decider\'s account goes into the quote, the signed terms into the funding; review, a reason, evidence and the decider\'s split, each by the side it belongs to, and read back', async () => {
    const { db, asha, ravi, meera } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    const ms = j.milestones[0]!.id
    const q = await quoteChainMilestone(CFG, db, asha.who, ms, T0 + 1000)
    const meeraAccount = fake.workspaces.get(railWorkspaceId(meera.who.workspaceId))!.ownerAccount
    expect(fake.proposed('escrow-quote')[0]!.params.dispute).toEqual({ decider: meeraAccount, reviewSeconds: 604800, evidenceSeconds: 259200, decisionSeconds: 432000, onReviewBps: 10000, onDecisionBps: 5000, deciderMay: { pay: true, refund: true, split: true } })
    await signAndSend(db, asha.who, q, asha.auth, T0 + 1100)
    expect((await view(db, ravi.who, T0 + 1200)).asClient[0]!.milestones[0]!.dispute!.terms.words).toHaveLength(5)
    expect((await view(db, meera.who, T0 + 1200)).asDecider).toEqual([]) // nothing is the decider's business before funding
    const f = await fundChainMilestone(CFG, db, ravi.who, ms, T0 + 2000)
    expect(fake.proposed('escrow-fund')[0]!.params.dispute).toMatchObject({ decider: meeraAccount, reviewPeriod: 604800 })
    await signAndSend(db, ravi.who, f, ravi.auth, T0 + 2100)
    expect((await view(db, meera.who, T0 + 2200)).asDecider[0]!.milestones[0]).toMatchObject({ state: 'chain-funded', actions: [] })
    await view(db, asha.who, T0 + 2900)
    await signAndSend(db, asha.who, await deliverChainMilestone(CFG, db, asha.who, ms, {}, T0 + 3000), asha.auth, T0 + 3100)
    const review = (await view(db, ravi.who, T0 + 3200)).asClient[0]!.milestones[0]!
    expect(review).toMatchObject({ state: 'chain-review', actions: ['accept', 'dispute'] })
    // each step belongs to one side
    await expect(disputeChainWork(CFG, db, asha.who, ms, { reason: 'I dispute my own work here.' }, T0 + 3300)).rejects.toMatchObject({ status: 404 })
    await expect(decideChainDispute(CFG, db, meera.who, ms, { toProvider: 100 }, T0 + 3300)).rejects.toMatchObject({ code: 'wrong_state' })
    await expect(disputeChainWork(CFG, db, ravi.who, ms, { reason: 'short' }, T0 + 3300)).rejects.toMatchObject({ code: 'invalid' })
    const reason = 'The weights cover two assets; we agreed on the whole sleeve.'
    await signAndSend(db, ravi.who, await disputeChainWork(CFG, db, ravi.who, ms, { reason }, T0 + 3400), ravi.auth, T0 + 3500)
    expect(fake.proposed('escrow-dispute')[0]!.params).toEqual({ disputeId: '1', reason })
    await view(db, asha.who, T0 + 3550)
    await signAndSend(db, asha.who, await addChainEvidence(CFG, db, asha.who, ms, { text: 'The quote named exactly two assets.' }, T0 + 3600), asha.auth, T0 + 3700)
    const seen = (await view(db, meera.who, T0 + 3800)).asDecider[0]!.milestones[0]!
    expect(seen.state).toBe('chain-disputed')
    // the ruling is offered only once the evidence period (3 days here) has passed, and only to the decider
    expect(seen.actions).toEqual([])
    expect((await view(db, meera.who, T0 + 260_000_000)).asDecider[0]!.milestones[0]!.actions).toEqual(['decide'])
    expect((await view(db, ravi.who, T0 + 260_000_000)).asClient[0]!.milestones[0]!.actions).toEqual(['accept'])
    expect(seen.dispute).toMatchObject({ reason: { text: reason, onChain: true }, evidence: [{ by: 'provider', text: 'The quote named exactly two assets.', onChain: true }] })
    await expect(decideChainDispute(CFG, db, ravi.who, ms, { toProvider: 0 }, T0 + 3900)).rejects.toMatchObject({ status: 404 })
    await expect(decideChainDispute(CFG, db, meera.who, ms, { toProvider: 25076 }, T0 + 3900)).rejects.toMatchObject({ code: 'invalid' })
    await signAndSend(db, meera.who, await decideChainDispute(CFG, db, meera.who, ms, { toProvider: 15000 }, T0 + 4000), meera.auth, T0 + 4100)
    expect(fake.proposed('escrow-decide')[0]!.params).toEqual({ disputeId: '1', toProvider: '150.00' })
    for (const who of [asha.who, ravi.who, meera.who]) {
      const v = await view(db, who, T0 + 4200)
      const m = [...v.asProvider, ...v.asClient, ...v.asDecider].flatMap((x) => x.milestones).find((x) => x.id === ms)!
      expect(m).toMatchObject({ state: 'chain-split', dispute: { outcome: { kind: 'decided', toProvider: 15000, toClient: 10075 } } })
    }
    expect((await view(db, ravi.who, T0 + 4300)).asClient[0]!.milestones[0]!.status).toMatch(/₹150 to Asha, ₹100\.75 to your wallet/)
  })

  it('accepting, giving way and a timeout go only through the dispute escrow; work paid straight through the proof escrow has none of them', async () => {
    const { db, asha, ravi } = await world()
    const plain = await createChainJob(CFG, db, asha.who, { ...JOB(), dispute: undefined }, T0)
    await expect(acceptChainWork(CFG, db, ravi.who, plain.milestones[0]!.id, T0)).rejects.toMatchObject({ code: 'no_dispute_step' })
    await expect(giveWayChainWork(CFG, db, asha.who, plain.milestones[0]!.id, T0)).rejects.toMatchObject({ code: 'no_dispute_step' })
    await expect(finishChainWork(CFG, db, ravi.who, plain.milestones[0]!.id, { key: 'finish-key-01' }, T0)).rejects.toMatchObject({ code: 'no_dispute_step' })
  })
})
