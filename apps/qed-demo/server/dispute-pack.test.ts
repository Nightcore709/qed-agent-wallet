/**
 * A dispute pack for a payment whose outcome is disputed or uncertain (audit finding S6, server/dispute-pack.ts): the signed
 * approval, the receipts with their hashes, the timeline, the payee as signed and the paper bank's reference, all labelled
 * simulated; refused for a payment that is neither disputed nor uncertain; the same each time it is read.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { FakeClock, openDb } from './core.ts'
import { disputePack, packReason } from './dispute-pack.ts'
import { releasePause, listPauses } from './dispute-pause.ts'
import { verifyDisputePack } from './dispute-pack-verify.ts'
import { stepAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { Market } from './market.ts'
import { addPayee, openDispute, previewAction, submitApprovedAction } from './owner.ts'
import { seedRegistry } from './registry.ts'
import { T0 } from './testkit.ts'
import type { Ctx } from './types.ts'
import { PaperCryptoVenue, PaperFundVenue, PaperRail } from './venues.ts'

const USER = 'usr_test'
function stack() {
  const db = openDb(':memory:'), clock = new FakeClock(T0), market = new Market(db, clock)
  const ctx: Ctx = { db, clock, market, venues: { crypto: new PaperCryptoVenue(db, market, clock, async () => { throw new Error('no book') }), funds: new PaperFundVenue(db, clock), rail: new PaperRail(db, clock) } }
  seedRegistry(db)
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', USER, 'tester', 'Test Owner', 'x', T0)
  openHousehold(db, USER, DEFAULT_OPENING, {}, T0)
  return { ctx, clock }
}
async function pay(ctx: Ctx, handle: string, name: string, amount = 50_000) {
  const y = addPayee(ctx.db, USER, { name, handle, category: 'family' }, T0 - 3 * 86_400_000)
  const pv = await previewAction(ctx, USER, { kind: 'payment', purpose: 'spend', payeeId: y.id, amount })
  confirmApproval(ctx.db, USER, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, ctx.clock.now())
  const a = submitApprovedAction(ctx, USER, pv.approvalId)
  await stepAction(ctx, a.id)
  return a.id
}

describe('the dispute pack', () => {
  it('for a settled payment that was disputed: approval, receipts with hashes, timeline, payee as signed and bank reference', async () => {
    const { ctx, clock } = stack()
    const id = await pay(ctx, 'ravi.kumar@upi', 'Ravi Kumar')
    clock.set(T0 + 10_000)
    await ctx.venues.rail.tick()
    await stepAction(ctx, id)
    expect(ctx.db.get<{ state: string }>('SELECT state FROM actions WHERE id = ?', id)!.state).toBe('done')
    expect(packReason(ctx.db, USER, id, clock.now())).toBeNull() // settled and not disputed: no pack
    expect(() => disputePack(ctx.db, USER, id, clock.now())).toThrow(/disputed or whose outcome is not known/)
    openDispute(ctx, USER, id, 'The payee says they never received it')
    const pack = disputePack(ctx.db, USER, id, clock.now())
    expect(pack).toMatchObject({ simulated: true, reason: 'disputed', payment: { actionId: id, payeeName: 'Ravi Kumar', payeeHandle: 'ravi.kumar@upi', amount: '50000', state: 'done' } })
    expect(pack.notice).toContain('Simulated')
    expect(pack.approval).toMatchObject({ method: 'passkey', docHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((pack.approval as { document: { action: { params: { payeeHandle: string } } } }).document.action.params.payeeHandle).toBe('ravi.kumar@upi')
    expect(pack.receipts.length).toBeGreaterThan(0)
    for (const r of pack.receipts) { expect(r.hash).toMatch(/^[0-9a-f]{64}$/); expect(r.prevHash).toMatch(/^[0-9a-f]{64}$/) }
    expect(pack.receiptChain).toMatchObject({ verified: true })
    expect(pack.bank).toMatchObject({ simulated: true, institution: 'paper rail', state: 'settled', reference: expect.stringMatching(/^PAPER/) })
    expect(pack.payee).toMatchObject({ asSigned: { name: 'Ravi Kumar', handle: 'ravi.kumar@upi' }, changedSinceSigned: false })
    expect(pack.disputes).toHaveLength(1)
    const steps = pack.timeline.map((t) => t.step)
    for (const s of ['requested', 'approved', 'sent', 'bank reference', 'settled', 'dispute opened']) expect(steps).toContain(s)
    expect(pack.timeline.map((t) => t.at)).toEqual([...pack.timeline.map((t) => t.at)].sort((a, b) => a - b))
  })

  it('for a payment whose outcome is unknown: the rail has not said, and the pack says so', async () => {
    const { ctx, clock } = stack()
    const id = await pay(ctx, 'timeout@paper', 'Timeout Test Account')
    expect(packReason(ctx.db, USER, id, clock.now())).toBe('unknown-outcome')
    const pack = disputePack(ctx.db, USER, id, clock.now())
    expect(pack.reasonText).toContain('has not said whether')
    expect(pack.bank).toMatchObject({ state: 'unknown' })
    expect(pack.timeline.map((t) => t.step)).not.toContain('settled')
  })

  it('is the same each time it is read, changes nothing, and is another person\'s never', async () => {
    const { ctx, clock } = stack()
    const id = await pay(ctx, 'timeout@paper', 'Timeout Test Account')
    const before = ctx.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM receipts) + (SELECT COUNT(*) FROM audit) n')!.n
    expect(JSON.stringify(disputePack(ctx.db, USER, id, clock.now()))).toBe(JSON.stringify(disputePack(ctx.db, USER, id, clock.now())))
    expect(ctx.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM receipts) + (SELECT COUNT(*) FROM audit) n')!.n).toBe(before)
    expect(() => disputePack(ctx.db, 'usr_other', id, clock.now())).toThrow(/not found/i)
  })
})

describe('the dispute pack: pause, timestamps, the draft notice, deadlines and offline verification (N-018)', () => {
  async function disputed() {
    const { ctx, clock } = stack()
    const id = await pay(ctx, 'ravi.kumar@upi', 'Ravi Kumar')
    clock.set(T0 + 10_000)
    await ctx.venues.rail.tick(); await stepAction(ctx, id)
    openDispute(ctx, USER, id, 'The payee says they never received it')
    return { ctx, clock, id }
  }

  it('shows the pause QED took on the account, with when it began and, once the person releases it, when', async () => {
    const { ctx, clock, id } = await disputed()
    expect(disputePack(ctx.db, USER, id, clock.now()).pauses).toMatchObject([{ scope: 'payments:paper-rail', startedAt: clock.now(), releasedAt: null, releasedBy: null }])
    clock.set(clock.now() + 60_000)
    releasePause(ctx, USER, 'per_owner', listPauses(ctx.db, USER, id)[0]!.id)
    const pack = disputePack(ctx.db, USER, id, clock.now())
    expect(pack.pauses[0]).toMatchObject({ releasedAt: clock.now(), releasedBy: 'per_owner' })
    expect(pack.timeline.map((t) => t.step)).toEqual(expect.arrayContaining(['QED paused', 'pause released']))
  })

  it('timestamps everything: every step has its time and its date, in order', async () => {
    const { ctx, clock, id } = await disputed()
    const pack = disputePack(ctx.db, USER, id, clock.now())
    for (const t of pack.timeline) expect(t.iso).toBe(new Date(t.at).toISOString())
    for (const r of pack.receipts) expect(typeof r.at).toBe('number')
  })

  it('drafts the notice for the account provider, labelled a draft the person sends themselves; QED sends nothing', async () => {
    const { ctx, clock, id } = await disputed()
    const n = disputePack(ctx.db, USER, id, clock.now()).draftNotice
    expect(n).toMatchObject({ sentBy: 'you', qedSends: false, to: 'Your account provider' })
    expect(n.label).toMatch(/draft/i)
    expect(n.label).toContain('you send it yourself')
    expect(n.text).toContain('Ravi Kumar')
    expect(n.text).toContain('The payee says they never received it')
    expect(n.text).not.toMatch(/waive|guarantee|will refund|you must refund/i)
  })

  it('shows the jurisdiction\'s deadlines and escalation (India by default), counted from the report', async () => {
    const { ctx, clock, id } = await disputed()
    const pack = disputePack(ctx.db, USER, id, clock.now())
    expect(pack.jurisdiction).toBe('IN')
    expect(pack.deadlines.find((d) => d.id === 'customer-report')).toMatchObject({ rule: 'three working days', dueDate: expect.stringMatching(/^2026-/) })
    expect(pack.escalation.text).toContain('Ombudsman')
  })

  it('verifies offline, and catches a changed body, a changed receipt, a changed approval and a changed time', async () => {
    const { ctx, clock, id } = await disputed()
    const pack = JSON.parse(JSON.stringify(disputePack(ctx.db, USER, id, clock.now())))
    expect(verifyDisputePack(pack)).toMatchObject({ ok: true })
    const broke = (mutate: (p: any) => void, name: string) => { const p = JSON.parse(JSON.stringify(pack)); mutate(p); const r = verifyDisputePack(p); expect(r.ok, name).toBe(false); return r }
    expect(broke((p) => { p.payment.amount = '1' }, 'amount').checks.find((c) => c.name === 'digest')!.ok).toBe(false)
    // a forger who also recomputes the digest is still caught by the receipt hashes
    const { packDigest } = await import('./dispute-pack-verify.ts')
    const r = broke((p) => { p.receipts[0].body = { ...p.receipts[0].body, tampered: true }; p.integrity.sha256 = packDigest(p) }, 'receipt body')
    expect(r.checks.find((c) => c.name === 'receipt hashes')!.ok).toBe(false)
    expect(broke((p) => { p.approval.document = { other: 1 }; p.integrity.sha256 = packDigest(p) }, 'approval').checks.find((c) => c.name === 'approval')!.ok).toBe(false)
    expect(broke((p) => { p.timeline[0].at += 1; p.integrity.sha256 = packDigest(p) }, 'time').checks.find((c) => c.name === 'timestamps')!.ok).toBe(false)
  })
})

