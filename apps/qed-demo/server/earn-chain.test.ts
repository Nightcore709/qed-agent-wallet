/**
 * Earning on the chain from the wallet's Earn flow (server/earn-chain.ts; R7-054), against a recording stand-in of the
 * rail's HTTP contract (server/rail-fake.ts). The rail's own test (chain/test/escrow-earn.test.ts) shows the chain side:
 * the quote's signature, the client's funding from its vault, the verifier, settlement, refunds and the authority
 * budget. Here: that the Earn journey's records are the same ones the paper flow uses, which vault each step is asked
 * of and by whom, what QED refuses (a proof escrow has no dispute), that every state is read from the rail and is
 * truthful when it cannot be read, and that QED declares a client with a member in common as linked before it quotes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { chainClientDecision, createChainJob, deliverChainMilestone, earnChainView, fundChainMilestone, quoteChainMilestone, releaseChainMilestone } from './earn-chain.ts'
import { clientDecision, submitMilestone } from './owner.ts'
import { beginSignup, finishSignup, type RelyingParty } from './passkeys.ts'
import { type Asker, railExecute, railSetup, railSignBegin, railSignFinish, railWorkspaceId } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'
import type { Ctx } from './types.ts'
import { actor, addMember, createBusiness } from './workspaces.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 22, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
/** Each quote's hash, as the escrow would compute it: here derived from its id, so that every quote has its own. */
const hashOf = (quoteId: string) => `0x9a${quoteId.slice(4)}`
const PROBLEM = { kind: 'custom', assets: [{ name: 'Alpha', volatilityBps: 1500 }, { name: 'Beta', volatilityBps: 3000 }] }
let deliverBy = Math.floor(T0 / 1000) + 7200

beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => {
  fake.reset()
  deliverBy = Math.floor(T0 / 1000) + 7200
  let n = 0
  // the rail's answers (chain/test/escrow-earn.test.ts shows them for real)
  fake.outcome['escrow-quote'] = (p, w) => ({ outcome: 'executed', summary: 'Signed the quote.', evidence: { quote: { provider: w.ownerAccount, payee: w.vault, client: p!.params.client, token: `0x${'11'.repeat(20)}`, price: String(Math.round(Number(p!.params.price) * 100)), verifier: `0x${'22'.repeat(20)}`, specHash: `0x${'33'.repeat(32)}`, deliverBy: String(deliverBy), validUntil: String(deliverBy - 3600), quoteId: `0x${String(++n).padStart(64, '0')}` }, quoteHash: hashOf(`0x${String(n).padStart(64, '0')}`), signature: `0x${'44'.repeat(80)}`, spec: '0x1234', problem: p!.params.problem } })
  fake.outcome['escrow-fund'] = (p, w) => {
    const id = String(fake.escrow.size + 1)
    const provider = [...fake.workspaces.values()].find((x) => x.ownerAccount === (p!.params.quote as { provider: string }).provider)!
    const quoteHash = hashOf((p!.params.quote as { quoteId: string }).quoteId)
    fake.escrow.set(id, { jobId: id, status: 'open', roles: ['client'], quoteHash, price: String((p!.params.quote as { price: string }).price), deliverBy: String(deliverBy), deliverByTime: new Date(deliverBy * 1000).toISOString(), refundable: false, opened: { tx: `0x${'aa'.repeat(32)}`, block: '10' }, settled: null, refunded: null, solutionHash: null, authority: null, parties: [w.id, provider.id] })
    return { outcome: 'executed', summary: `Funded escrow job #${id}.`, evidence: { escrowJobId: id, quoteHash } }
  }
  fake.outcome['escrow-deliver'] = (p) => { const j = fake.escrow.get(String(p!.params.jobId))!; Object.assign(j, { status: 'settled', solutionHash: `0x${'55'.repeat(32)}`, settled: { tx: `0x${'bb'.repeat(32)}`, block: '11', confirmations: 2 }, authority: { status: 'credited', credit: '12537', creditText: '125.37 tINR', confirmations: 2, needed: 2, why: 'Earned: half the price.' } }); return { outcome: 'executed', summary: 'Delivered.', evidence: {} } }
  fake.outcome['escrow-release'] = (p) => { Object.assign(fake.escrow.get(String(p!.params.jobId))!, { status: 'refunded', refunded: { tx: `0x${'cc'.repeat(32)}`, block: '12' } }); return { outcome: 'executed', summary: 'Released the client.', evidence: {} } }
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
const JOB = (over: Record<string, unknown> = {}) => ({ key: 'job-key-0001', title: 'Portfolio sleeve', clientHandle: 'ravi', problem: PROBLEM, milestones: [{ title: 'Certified weights', amount: 25075, deliverWithinHours: 2 }], ...over })
async function world() {
  const db = openDb(':memory:')
  const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), kiran = await person(db, 'kiran')
  await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
  await railSetup(CFG, db, RP, ravi.who, RP.origins[0], T0)
  return { db, asha, ravi, kiran }
}
type View = { asProvider: { id: string; state: string; authority: { counts: boolean; why: string }; milestones: M[] }[]; asClient: { id: string; provider: { name: string }; milestones: M[] }[]; reachable: boolean }
type M = { id: string; state: string; status: string; actions: string[]; escrowJobId: string | null; pending: { action: string } | null; last: { action: string; outcome: string; summary: string } | null; authority?: { status: string; creditText: string } | null; evidence?: { solutionHash: string } | null }
const view = async (db: Db, who: Asker, at: number) => (await earnChainView(CFG, db, who, at)) as unknown as View

describe('the Earn journey on the chain', () => {
  it('a job for another QED account is kept in the same Earn records; one key makes one job; the paper flow never changes its milestones itself', async () => {
    const { db, asha, kiran } = await world()
    // a handle that does not exist and one without an on-chain wallet are answered alike, with no name (RISK-071)
    type Refusal = { status: number; code: string; message: string }
    const refusal = (handle: string): Promise<Refusal> => createChainJob(CFG, db, asha.who, JOB({ clientHandle: handle }), T0).then(() => ({ status: 200, code: 'created', message: '' }), (e: unknown) => e as Refusal)
    const nobody = await refusal('nobody'), noVault = await refusal('kiran')
    expect({ status: nobody.status, code: nobody.code, message: nobody.message }).toEqual({ status: noVault.status, code: noVault.code, message: noVault.message })
    expect(noVault.code).toBe('client_unavailable')
    expect(noVault.message).not.toMatch(/Kiran/i)
    await expect(createChainJob(CFG, db, asha.who, JOB({ clientHandle: 'asha' }), T0)).rejects.toMatchObject({ code: 'self_dealing' })
    await expect(createChainJob(CFG, db, asha.who, JOB({ milestones: [] }), T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(createChainJob(CFG, db, asha.who, JOB({ problem: { kind: 'custom', assets: [{ name: 'A', volatilityBps: 50 }] } }), T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(createChainJob(CFG, db, asha.who, JOB({ key: undefined }), T0)).rejects.toMatchObject({ code: 'invalid' })
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    expect(await createChainJob(CFG, db, asha.who, JOB(), T0 + 1)).toMatchObject({ id: j.id, duplicate: true })
    await expect(createChainJob(CFG, db, asha.who, JOB({ title: 'Something else' }), T0 + 2)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    const row = db.get<{ user_id: string; client: string; meta_json: string }>('SELECT user_id, client, meta_json FROM earn_jobs WHERE id = ?', j.id)!
    expect(row).toMatchObject({ user_id: asha.who.workspaceId, client: '@ravi' }) // the client's name only once they fund (RISK-071)
    expect(JSON.parse(row.meta_json).chain).toMatchObject({ clientHandle: 'ravi', problem: PROBLEM })
    const [ms] = db.all<{ id: string; state: string; amount: number }>('SELECT id, state, amount FROM earn_milestones WHERE job_id = ?', j.id)
    expect(ms).toMatchObject({ state: 'chain-draft', amount: 25075 })
    // the paper flow hands it to the chain: nothing is marked submitted, nothing is posted as income
    const ctx = { db, clock: { now: () => T0 } } as unknown as Ctx
    expect(() => submitMilestone(db, asha.who.workspaceId, ms!.id, 'some evidence', T0)).toThrow(/only a funded one can be delivered/)
    expect(() => clientDecision(ctx, asha.who.workspaceId, ms!.id, 'accept')).toThrow(/nothing to accept/)
    expect(() => clientDecision(ctx, asha.who.workspaceId, ms!.id, 'dispute')).toThrow(/no dispute/)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE user_id = ? AND kind = 'income-earn'`, asha.who.workspaceId)!.n).toBe(0)
    void kiran
  })

  it('quote, offer, funding from the client\'s vault, delivery and settlement: each step a passkey-signed proposal of the right vault, every state read back from the rail', async () => {
    const { db, asha, ravi, kiran } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    const msId = j.milestones[0]!.id
    // the provider signs the quote with its own vault's passkey
    const q = await quoteChainMilestone(CFG, db, asha.who, msId, T0 + 1000)
    const [qp] = fake.proposed('escrow-quote')
    expect(qp!.ws).toBe(railWorkspaceId(asha.who.workspaceId))
    expect(qp!.params).toEqual({ client: fake.workspaces.get(railWorkspaceId(ravi.who.workspaceId))!.ownerAccount, price: '250.75', deliverWithinHours: 2, validForMinutes: 105, problem: PROBLEM, title: 'Portfolio sleeve: Certified weights' })
    await expect(quoteChainMilestone(CFG, db, asha.who, msId, T0 + 1100)).rejects.toMatchObject({ code: 'already_pending' })
    let v = await view(db, asha.who, T0 + 1200)
    expect(v.asProvider[0]!.milestones[0]).toMatchObject({ state: 'chain-draft', pending: { action: 'quote' } })
    // the provider's own request says when it lapses: when its approval does (the Earn page says so)
    const lapses = db.get<{ expires_at: number }>('SELECT expires_at FROM approvals WHERE id = ?', String(q.approvalId))!.expires_at
    expect((v.asProvider[0]!.milestones[0]!.pending as unknown as { expiresAt: string | null }).expiresAt).toBe(new Date(lapses).toISOString())
    expect((await view(db, ravi.who, T0 + 1250)).asClient, 'nothing is shown to the client before it is offered').toEqual([])
    await signAndSend(db, asha.who, q, asha.auth, T0 + 1300)
    v = await view(db, asha.who, T0 + 1400)
    // an offer cannot be taken back on the chain (the escrow has no revocation of a quote): the provider waits until it lapses
    expect(v.asProvider[0]!.milestones[0]).toMatchObject({ state: 'chain-offered', pending: null, actions: [] })
    expect((v.asProvider[0] as unknown as { client: unknown }).client, 'the client\'s name only once they fund (RISK-071)').toEqual({ name: null, handle: 'ravi' })
    // the client sees the offer, and only the client can fund it, from its own vault
    const c = await view(db, ravi.who, T0 + 1500)
    expect(c.asClient[0]).toMatchObject({ provider: { name: 'Asha' }, milestones: [{ state: 'chain-offered', actions: ['fund'] }] })
    expect((await view(db, kiran.who, T0 + 1500)).asClient).toEqual([])
    await expect(fundChainMilestone(CFG, db, kiran.who, msId, T0 + 1600)).rejects.toMatchObject({ code: 'not_found' })
    await expect(fundChainMilestone(CFG, db, asha.who, msId, T0 + 1600)).rejects.toMatchObject({ code: 'not_found' })
    const f = await fundChainMilestone(CFG, db, ravi.who, msId, T0 + 1700)
    const [fp] = fake.proposed('escrow-fund')
    expect(fp!.ws).toBe(railWorkspaceId(ravi.who.workspaceId))
    expect(Object.keys(fp!.params).sort()).toEqual(['quote', 'signature', 'spec'])
    // the provider sees that the client's funding waits for the client's signature, never when the client asked
    const waiting = (await view(db, asha.who, T0 + 1750)).asProvider[0]!.milestones[0]!
    expect(waiting.pending).toMatchObject({ action: 'fund', status: 'awaiting-signature', yours: false, expiresAt: null })
    await signAndSend(db, ravi.who, f, ravi.auth, T0 + 1800)
    v = await view(db, asha.who, T0 + 1900)
    expect(v.asProvider[0]!.milestones[0]).toMatchObject({ state: 'chain-funded', escrowJobId: '1', actions: ['deliver', 'release'] })
    expect((v.asProvider[0] as unknown as { client: unknown }).client).toEqual({ name: 'Ravi', handle: 'ravi' })
    // delivery: the certificate is checked by the verifier on the chain; settlement pays the provider's vault
    const d = await deliverChainMilestone(CFG, db, asha.who, msId, {}, T0 + 2000)
    expect(fake.proposed('escrow-deliver')[0]!.params).toEqual({ jobId: '1' })
    await signAndSend(db, asha.who, d, asha.auth, T0 + 2100)
    v = await view(db, asha.who, T0 + 2200)
    expect(v.asProvider[0]).toMatchObject({ state: 'complete', milestones: [{ state: 'chain-released', evidence: { solutionHash: `0x${'55'.repeat(32)}` }, authority: { status: 'credited', creditText: '125.37 tINR' } }] })
    expect(db.get<{ evidence_hash: string }>('SELECT evidence_hash FROM earn_milestones WHERE id = ?', msId)!.evidence_hash).toBe(`0x${'55'.repeat(32)}`)
    expect((await view(db, ravi.who, T0 + 2300)).asClient[0]!.milestones[0]).toMatchObject({ state: 'chain-released', actions: [] })
    expect((await view(db, ravi.who, T0 + 2300)).asClient[0]!.milestones[0]).not.toHaveProperty('authority')
  })

  it('refunds and disputes: a proof escrow has no dispute; before the deadline only the provider releases the client; after it the client takes the money back; a refused refund says why', async () => {
    const { db, asha, ravi } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB({ milestones: [{ title: 'First', amount: 4000, deliverWithinHours: 2 }, { title: 'Second', amount: 6000, deliverWithinHours: 2 }] }), T0)
    const [m1, m2] = j.milestones.map((m) => m.id)
    for (const [i, id] of [m1!, m2!].entries()) {
      await signAndSend(db, asha.who, await quoteChainMilestone(CFG, db, asha.who, id, T0 + 1000 + i * 100), asha.auth, T0 + 1010 + i * 100)
      await view(db, asha.who, T0 + 1020 + i * 100)
      await signAndSend(db, ravi.who, await fundChainMilestone(CFG, db, ravi.who, id, T0 + 1030 + i * 100), ravi.auth, T0 + 1040 + i * 100)
    }
    await view(db, asha.who, T0 + 2000)
    await expect(chainClientDecision(CFG, db, ravi.who, m1!, 'dispute', {}, T0 + 3000)).rejects.toMatchObject({ code: 'no_dispute_in_proof_escrow', message: expect.stringMatching(/the verifier on the chain decides/) })
    await expect(chainClientDecision(CFG, db, ravi.who, m1!, 'accept', {}, T0 + 3000)).rejects.toMatchObject({ code: 'settles_on_verification' })
    await expect(chainClientDecision(CFG, db, ravi.who, m1!, 'refund', { key: 'refund-key-0001' }, T0 + 3000)).rejects.toMatchObject({ code: 'not_refundable_yet' })
    expect(fake.sent('/refund')).toEqual([])
    // the provider releases the first
    await signAndSend(db, asha.who, await releaseChainMilestone(CFG, db, asha.who, m1!, T0 + 3100), asha.auth, T0 + 3110)
    // after the deadline the client refunds the second; the rail refuses once (truthfully shown), then refunds
    const late = (deliverBy + 1) * 1000
    fake.outcome['escrow-refund'] = () => ({ outcome: 'refused', summary: 'Job #2 can be refunded by anyone only after its deadline. Nothing was sent.' })
    await chainClientDecision(CFG, db, ravi.who, m2!, 'refund', { key: 'refund-key-0002' }, late)
    let v = await view(db, ravi.who, late + 100)
    expect(v.asClient[0]!.milestones[1]).toMatchObject({ state: 'chain-funded', last: { action: 'refund', outcome: 'refused', summary: expect.stringMatching(/only after its deadline/) } })
    fake.outcome['escrow-refund'] = (_p, _w) => { Object.assign(fake.escrow.get('2')!, { status: 'refunded', refunded: { tx: `0x${'dd'.repeat(32)}`, block: '20' } }); return { outcome: 'executed', summary: 'Refunded.', evidence: {} } }
    await chainClientDecision(CFG, db, ravi.who, m2!, 'refund', { key: 'refund-key-0003' }, late + 200)
    expect(fake.sent('/refund').map((s) => [s.path.split('/')[2], s.key])).toEqual([[railWorkspaceId(ravi.who.workspaceId), 'ui-refund-key-0002'], [railWorkspaceId(ravi.who.workspaceId), 'ui-refund-key-0003']])
    v = await view(db, asha.who, late + 300)
    expect(v.asProvider[0]).toMatchObject({ state: 'complete', milestones: [{ state: 'chain-refunded' }, { state: 'chain-refunded' }] })
  })

  it('a client with a member in common may hire, but QED says it adds nothing to the authority budget, and declares the link before it quotes', async () => {
    const { db, asha, ravi } = await world()
    const ws = createBusiness(db, asha.who.personId, 'Asha Studio', T0)
    const studio: Asker = { ...asha.who, workspaceId: ws, role: 'owner' }
    await railSetup(CFG, db, RP, studio, RP.origins[0], T0)
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'ravi', 'viewer', T0 + 10)
    const j = await createChainJob(CFG, db, studio, JOB({ key: 'job-key-0002' }), T0 + 100)
    const v = await view(db, studio, T0 + 200)
    expect(v.asProvider.find((x) => x.id === j.id)!.authority).toMatchObject({ counts: false, why: expect.stringMatching(/a member in common/) })
    const sentBefore = fake.seen.length
    await quoteChainMilestone(CFG, db, studio, j.milestones[0]!.id, T0 + 300)
    const after = fake.seen.slice(sentBefore)
    const link = after.findIndex((s) => s.path.endsWith('/links') && (s.body.workspaces as string[]).includes(railWorkspaceId(ravi.who.workspaceId)))
    const quote = after.findIndex((s) => s.path.endsWith('/proposals') && s.body.kind === 'escrow-quote')
    expect(link).toBeGreaterThanOrEqual(0)
    expect(link).toBeLessThan(quote)
  })

  it('the paper flow hands a funded chain milestone to the chain: "submit the work" prepares the certified delivery for the vault\'s passkeys, "refund" before the deadline is the provider\'s release, and a failure is kept on the milestone', async () => {
    const { db, asha, ravi } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB({ milestones: [{ title: 'One', amount: 1000, deliverWithinHours: 2 }, { title: 'Two', amount: 2000, deliverWithinHours: 2 }, { title: 'Three', amount: 3000, deliverWithinHours: 2 }] }), T0)
    const ids = j.milestones.map((m) => m.id)
    for (const [i, id] of ids.entries()) {
      await signAndSend(db, asha.who, await quoteChainMilestone(CFG, db, asha.who, id, T0 + 1000 + i * 100), asha.auth, T0 + 1010 + i * 100)
      await view(db, asha.who, T0 + 1020 + i * 100)
      await signAndSend(db, ravi.who, await fundChainMilestone(CFG, db, ravi.who, id, T0 + 1030 + i * 100), ravi.auth, T0 + 1040 + i * 100)
    }
    expect((await view(db, asha.who, T0 + 2000)).asProvider[0]!.milestones.map((m) => m.state)).toEqual(['chain-funded', 'chain-funded', 'chain-funded'])
    const ctx = { db, clock: { now: () => T0 + 3000 } } as unknown as Ctx
    // only for the person the request established, in this workspace; no identity is assumed
    expect(() => submitMilestone(db, asha.who.workspaceId, ids[0]!, 'x', T0 + 3000)).toThrow(/signed-in member of this workspace/)
    expect(() => actor.run({ personId: ravi.who.personId, workspaceId: ravi.who.workspaceId, role: 'owner' }, () => submitMilestone(db, asha.who.workspaceId, ids[0]!, 'x', T0 + 3000))).toThrow(/signed-in member of this workspace/)
    const as = <T>(fn: () => T): T => actor.run({ personId: asha.who.personId, workspaceId: asha.who.workspaceId, role: 'owner' }, fn)
    const delivered = await as(() => submitMilestone(db, asha.who.workspaceId, ids[0]!, 'the evidence is the certificate', T0 + 3000)) as { proposal: { kind: string } }
    expect(delivered.proposal.kind).toBe('escrow-deliver')
    expect(fake.proposed('escrow-deliver').map((p) => p.params)).toEqual([{ jobId: '1' }])
    const released = await as(() => clientDecision(ctx, asha.who.workspaceId, ids[1]!, 'refund')) as { proposal: { kind: string } }
    expect(released.proposal.kind).toBe('escrow-release')
    // a caller that does not wait (the paper routes answer at once): the failure is on the milestone, not lost
    fake.refuse['escrow-deliver'] = { status: 409, code: 'deadline_passed', message: 'The delivery deadline has passed. Nothing was prepared.' }
    void as(() => submitMilestone(db, asha.who.workspaceId, ids[2]!, 'x', T0 + 3100))
    await new Promise((r) => setTimeout(r, 100))
    expect((await view(db, asha.who, T0 + 3200)).asProvider[0]!.milestones[2]).toMatchObject({ state: 'chain-funded', last: { action: 'deliver', outcome: 'failed', summary: expect.stringMatching(/deadline has passed/) } })
  })

  it('says since when each milestone has stood in its state, so a payment through the escrow can be dated where money in is listed; reading it again does not move that time', async () => {
    const { db, asha, ravi } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    const msId = j.milestones[0]!.id
    type Since = { state: string; since: number }
    const mine = async (at: number) => (await view(db, asha.who, at)).asProvider[0]!.milestones[0] as unknown as Since
    expect(await mine(T0 + 500)).toMatchObject({ state: 'chain-draft', since: T0 })
    await signAndSend(db, asha.who, await quoteChainMilestone(CFG, db, asha.who, msId, T0 + 1000), asha.auth, T0 + 1100)
    expect(await mine(T0 + 1400)).toMatchObject({ state: 'chain-offered', since: T0 + 1400 })
    await signAndSend(db, ravi.who, await fundChainMilestone(CFG, db, ravi.who, msId, T0 + 1500), ravi.auth, T0 + 1600)
    expect(await mine(T0 + 1900)).toMatchObject({ state: 'chain-funded', since: T0 + 1900 })
    await signAndSend(db, asha.who, await deliverChainMilestone(CFG, db, asha.who, msId, {}, T0 + 2000), asha.auth, T0 + 2100)
    expect(await mine(T0 + 2200)).toMatchObject({ state: 'chain-released', since: T0 + 2200 })
    // a settled milestone is read back on every view (its authority credit counts only after confirmations): the time
    // QED first recorded the payment stays, for both parties
    expect(await mine(T0 + 9000)).toMatchObject({ state: 'chain-released', since: T0 + 2200 })
    expect((await view(db, ravi.who, T0 + 9100)).asClient[0]!.milestones[0]).toMatchObject({ state: 'chain-released', since: T0 + 2200 })
    expect(db.get<{ updated_at: number; evidence_hash: string }>('SELECT updated_at, evidence_hash FROM earn_milestones WHERE id = ?', msId)).toEqual({ updated_at: T0 + 2200, evidence_hash: `0x${'55'.repeat(32)}` })
  })

  it('a read-back that overlaps a step never erases the request the step recorded, so a signed offer is followed to its result', async () => {
    const { db, asha } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    const msId = j.milestones[0]!.id
    const first = await quoteChainMilestone(CFG, db, asha.who, msId, T0 + 1000)
    const firstId = String((first.proposal as { id: string }).id)
    db.run('UPDATE approvals SET cancelled_at = ? WHERE id = ?', T0 + 1100, String(first.approvalId)) // withdrawn
    // the page's read-back asks the rail about the first request; its answer is held until a second request is recorded
    let release!: () => void, reached!: () => void
    const held = new Promise<void>((r) => { release = r }), asked = new Promise<void>((r) => { reached = r })
    fake.before = async (method, path) => { if (method === 'GET' && path.endsWith(`/proposals/${firstId}`)) { reached(); await held } }
    const reading = view(db, asha.who, T0 + 1200)
    await asked
    const second = await quoteChainMilestone(CFG, db, asha.who, msId, T0 + 1300)
    release()
    await reading
    fake.before = null
    const rec = JSON.parse(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', `earn.chain.ms:${msId}`)!.value) as { pending?: { proposalId?: string } }
    expect(rec.pending?.proposalId, 'the second request is still recorded').toBe(String((second.proposal as { id: string }).id))
    expect((await view(db, asha.who, T0 + 1400)).asProvider[0]!.milestones[0]).toMatchObject({ pending: { action: 'quote' } })
  })

  it('says "unknown" when the vault service does not answer, and changes nothing it has not read', async () => {
    const { db, asha } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    await signAndSend(db, asha.who, await quoteChainMilestone(CFG, db, asha.who, j.milestones[0]!.id, T0 + 1000), asha.auth, T0 + 1100)
    fake.up = false
    const v = await view(db, asha.who, T0 + 1200)
    expect(v.reachable).toBe(false)
    expect(v.asProvider[0]!.milestones[0]).toMatchObject({ state: 'chain-draft', status: expect.stringMatching(/unknown/i), pending: { action: 'quote' } })
    fake.up = true
    expect((await view(db, asha.who, T0 + 1300)).asProvider[0]!.milestones[0]).toMatchObject({ state: 'chain-offered' })
  })
})

// The R13 security review's leads on the chain escrow (docs/SECURITY-REVIEW-R13.md section 4); scripts/security.ts runs
// these by their check ids and records each as one of its checks.
describe('R13 lead checks: the chain escrow', () => {
  /** A funded milestone of Asha's (provider) for Ravi (client), its deadline `deliverBy`. */
  async function funded() {
    const { db, asha, ravi } = await world()
    const j = await createChainJob(CFG, db, asha.who, JOB(), T0)
    const m = j.milestones[0]!.id
    await signAndSend(db, asha.who, await quoteChainMilestone(CFG, db, asha.who, m, T0 + 1000), asha.auth, T0 + 1010)
    await view(db, asha.who, T0 + 1020)
    return { db, asha, ravi, m }
  }

  it('R17 (L-02): after the deadline, a release request the provider keeps waiting does not hold off the client\'s refund', async () => {
    const { db, asha, ravi, m } = await funded()
    await signAndSend(db, ravi.who, await fundChainMilestone(CFG, db, ravi.who, m, T0 + 1030), ravi.auth, T0 + 1040)
    await view(db, asha.who, T0 + 2000)
    const deadline = deliverBy * 1000
    // the provider asks to release a minute before the deadline and never signs: the request waits (ten minutes, and
    // can be withdrawn and asked again to keep it waiting)
    await releaseChainMilestone(CFG, db, asha.who, m, deadline - 60_000)
    fake.outcome['escrow-refund'] = () => ({ outcome: 'executed', summary: 'Refunded.', evidence: {} })
    const refund = await chainClientDecision(CFG, db, ravi.who, m, 'refund', { key: 'refund-key-l02-0001' }, deadline + 1000).then((x) => ({ ok: x }), (e: { code?: string }) => ({ refused: e.code }))
    expect(refund).toMatchObject({ ok: { jobId: expect.any(String) } })
    expect(fake.sent('/refund').length).toBe(1)
    // a second refund while the first waits is still one too many
    await expect(chainClientDecision(CFG, db, ravi.who, m, 'refund', { key: 'refund-key-l02-0002' }, deadline + 2000)).rejects.toMatchObject({ code: 'already_pending' })
  })

  it('R19 (L-04): the provider does not read what the client\'s vault service said about the client\'s refused funding (it names the client vault\'s free balance)', async () => {
    const { db, asha, ravi, m } = await funded()
    fake.outcome['escrow-fund'] = () => ({ outcome: 'refused', summary: 'Refused before sending: the job costs 250.75 tINR and the treasury vault has 12.34 tINR of free funds. Nothing was sent.' })
    await signAndSend(db, ravi.who, await fundChainMilestone(CFG, db, ravi.who, m, T0 + 1030), ravi.auth, T0 + 1040)
    const client = (await view(db, ravi.who, T0 + 2000)).asClient[0]!.milestones[0]!
    const provider = (await view(db, asha.who, T0 + 2100)).asProvider[0]!.milestones[0]!
    expect(client.last).toMatchObject({ action: 'fund', outcome: 'refused', summary: expect.stringMatching(/12\.34 tINR of free funds/) })
    expect(provider.last).toMatchObject({ action: 'fund', outcome: 'refused' })
    expect(provider.last!.summary).not.toMatch(/12\.34|free funds/)
  })
})
