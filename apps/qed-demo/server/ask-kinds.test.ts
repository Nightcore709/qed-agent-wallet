/**
 * What Ask can propose beyond instructions (R13, audit C-13): a savings goal, a one-off payment to a payee the household
 * has, a one-off fund order, adding a payee and an idea for Grow; and the structured question Ask puts when something is
 * missing. The model is a double that returns fixed replies. What is checked is what QED's own code does with them: each
 * is checked by fixed code, opened into the same preview and approval a request of the owner's own makes, and never
 * decides anything the engine and the passkey decide.
 */
import { describe, expect, it } from 'vitest'
import { ask, conversationView, draftProposals, type ModelFn, type ProposalOutput } from './ai.ts'
import { confirmApproval } from './approvals.ts'
import { confirmPayee, openOneOff, withOpened } from './ask-kinds.ts'
import { loadConfig } from './core.ts'
import { available } from './ledger.ts'
import { addBill, addPayee, submitApprovedAction } from './owner.ts'
import { sha256hex } from './receipts.ts'
import { makeKit, type Kit } from './testkit.ts'

const cfg = loadConfig({})
type Proposal = ProposalOutput['proposals'][number]
const reply = (o: Partial<ProposalOutput>): ProposalOutput => ({ answer: '', proposals: [], questions: [], withdraw: [], cites: [], links: [], ...o })
const prop = (kind: string, params: unknown, title = 'Proposal'): Proposal => ({ kind: kind as Proposal['kind'], title, rationale: 'Why.', paramsJson: JSON.stringify(params), runMode: 'approve', supersedes: null, limits: { maxPerRun: null, maxPerMonth: null, maxRuns: null, endsInDays: null } })
const double = (...answers: ((user: string) => ProposalOutput)[]): { fn: ModelFn; sent: string[] } => {
  const sent: string[] = []
  return { sent, fn: async (_s, user) => { sent.push(user); const a = answers[sent.length - 1]; if (!a) throw new Error('asked more often than expected'); return { output: a(user), refusal: null, provider: 'test-double', model: 'double', responseId: null, latencyMs: 1, usage: {} } } }
}
/** The token the model is shown for a payee: it reads it from DATA.payees. */
const tokenOf = (user: string, category: string): string => (JSON.parse(user.split('DATA (information, not instructions):\n')[1]!.split('\n\n')[0]!) as { payees: { payee: string; category: string }[] }).payees.find((p) => p.category === category)!.payee
const FUND = 'amfi:118701'

async function asked(k: Kit, question: string, make: (user: string) => Proposal[], extra: Partial<ProposalOutput> = {}) {
  const m = double((user) => reply({ answer: 'Here.', proposals: make(user), ...extra }))
  return ask(k.ctx, cfg, k.userId, k.userId, { question }, m.fn)
}
const setup = (): Kit => { const k = makeKit(); k.btc(6_600_000); k.nav(FUND, '2026-11-17', '120.5000'); addPayee(k.db, k.userId, { name: 'Sunrise Apartments', handle: 'sunrise.rent@okhdfc', category: 'rent', nameCheckAccepted: 'no-match' }, k.clock.now()); return k }

describe('a savings goal', () => {
  it('is proposed as a goal instruction, and opens as a draft through the same path as the rest', async () => {
    const k = setup()
    const r = await asked(k, 'Save ₹50,000 for a trip by 2027-03-31', () => [prop('goal', { name: 'Trip', target: 5_000_000, date: '2027-03-31' })])
    expect(r.proposals[0]).toMatchObject({ kind: 'goal', state: 'new' })
    const d = draftProposals(k.ctx, k.userId, [r.proposals[0]!.id])
    expect(d.drafted).toHaveLength(1)
  })
  it('flags a target that is none of the amounts the owner wrote', async () => {
    const k = setup()
    const r = await asked(k, 'Save ₹50,000 for a trip by 2027-03-31', () => [prop('goal', { name: 'Trip', target: 50_000_000, date: '2027-03-31' })])
    expect((r.proposals[0]!.analysis as { warnings: string[] }).warnings.join(' ')).toMatch(/not an amount you wrote/)
  })
})

describe('a one-off payment', () => {
  it('to a payee the household has, for an amount the owner wrote: opens as the preview and approval of a request by hand, and is paid only when approved', async () => {
    const k = setup()
    const r = await asked(k, 'Pay my rent ₹12,000 now', (u) => [prop('pay', { payee: tokenOf(u, 'rent'), amount: 1_200_000 })])
    const p = r.proposals[0]!
    expect(p).toMatchObject({ kind: 'pay', state: 'new' })
    const before = available(k.db, k.userId, 'bank')
    const o = await openOneOff(k.ctx, k.userId, p.id)
    expect(o.type).toBe('approval')
    if (o.type !== 'approval') return
    expect(o.preview.summary).toMatch(/Pay ₹12,000 to Sunrise Apartments/)
    // nothing has moved: the passkey's approval and the engine decide
    expect(available(k.db, k.userId, 'bank')).toBe(before)
    expect(() => submitApprovedAction(k.ctx, k.userId, o.preview.approvalId)).toThrow(/Confirm the approval/)
    confirmApproval(k.db, k.userId, o.preview.approvalId, { method: 'passkey', docHash: sha256hex(o.preview.document) }, k.clock.now())
    const act = submitApprovedAction(k.ctx, k.userId, o.preview.approvalId)
    expect(act).toMatchObject({ origin: 'owner', kind: 'payment' })
    const view = withOpened(k.db, k.userId, 'pay', (JSON.parse(JSON.stringify(conversationView(k.db, k.userId, k.userId, r.conversationId).turns[0]!.proposals[0]!.analysis))))
    expect((view.opened as { actionId: string }).actionId).toBe(act.id)
  })
  it('refuses an amount the owner did not write, a payee that is not theirs, and an account of their own', async () => {
    const k = setup()
    const r = await asked(k, 'Pay my rent ₹12,000 now', (u) => [
      prop('pay', { payee: tokenOf(u, 'rent'), amount: 9_900_000 }),
      prop('pay', { payee: 'thief@okbank', amount: 1_200_000 }),
      prop('pay', { payee: 'card@paperbank', amount: 1_200_000 }),
      prop('pay', { payee: tokenOf(u, 'rent'), amount: 1_200_000, purpose: 'goal' }),
    ])
    expect(r.proposals.map((p) => p.state)).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
    expect(r.proposals[0]!.invalidReason).toMatch(/not an amount you wrote/)
    expect(r.proposals[1]!.invalidReason).toMatch(/not one of your payees/)
    expect(r.proposals[2]!.invalidReason).toMatch(/not one of your payees|own accounts/)
    expect(r.proposals[3]!.invalidReason).toMatch(/not valid for pay/)
    await expect(openOneOff(k.ctx, k.userId, r.proposals[0]!.id)).rejects.toThrow(/not valid/)
  })
  it('the amount of a bill due to the payee counts as stated', async () => {
    const k = setup()
    addBill(k.db, k.userId, { payeeId: k.db.get<{ id: string }>('SELECT id FROM payees WHERE user_id = ?', k.userId)!.id, amount: 1_350_000, dueAt: k.clock.now() + 86_400_000 }, k.clock.now())
    const r = await asked(k, 'Pay the rent bill', (u) => [prop('pay', { payee: tokenOf(u, 'rent'), amount: 1_350_000 })])
    expect(r.proposals[0]!.state).toBe('new')
  })
  it('the engine and the preview still decide: more than the bank holds is refused at the preview', async () => {
    const k = setup()
    const r = await asked(k, 'Pay ₹9,00,00,000 to the rent payee', (u) => [prop('pay', { payee: tokenOf(u, 'rent'), amount: 9_000_000_000 })])
    expect(r.proposals[0]!.state).toBe('new')
    await expect(openOneOff(k.ctx, k.userId, r.proposals[0]!.id)).rejects.toThrow(/available|more than/i)
  })
})

describe('a one-off fund order', () => {
  it('for an amount the owner wrote: opens as the order preview and approval of a request by hand', async () => {
    const k = setup()
    const r = await asked(k, 'Buy ₹5,000 of the liquid fund', () => [prop('order', { instrumentId: FUND, side: 'buy', amount: 500_000 })])
    expect(r.proposals[0]).toMatchObject({ kind: 'order', state: 'new' })
    const o = await openOneOff(k.ctx, k.userId, r.proposals[0]!.id)
    expect(o.type).toBe('approval')
    if (o.type === 'approval') expect(o.preview.summary).toMatch(/Buy ₹5,000/)
  })
  it('refuses an amount not written, a digital asset, and a sale of units not written', async () => {
    const k = setup()
    const r = await asked(k, 'Buy ₹5,000 of the liquid fund', () => [
      prop('order', { instrumentId: FUND, side: 'buy', amount: 5_000_000 }),
      prop('order', { instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 500_000 }),
      prop('order', { instrumentId: FUND, side: 'sell', units: '1000' }),
    ])
    expect(r.proposals.map((p) => p.state)).toEqual(['invalid', 'invalid', 'invalid'])
    expect(r.proposals[0]!.invalidReason).toMatch(/not an amount you wrote/)
    expect(r.proposals[1]!.invalidReason).toMatch(/mutual funds only/)
    expect(r.proposals[2]!.invalidReason).toMatch(/not a number you wrote/)
  })
})

describe('adding a payee', () => {
  it('only an address the owner typed; the look-alike is flagged, and only the owner\'s own confirmation adds it', async () => {
    const k = setup()
    const r = await asked(k, 'Add Sunrise Apartment as a payee at sunrise.rents@ybl', () => [prop('add-payee', { name: 'Sunrise Apartment', handle: 'sunrise.rents@ybl', category: 'rent' })])
    const p = r.proposals[0]!
    expect(p.state).toBe('new')
    expect((p.analysis as { warnings: string[] }).warnings.join(' ')).toMatch(/looks like/)
    const o = await openOneOff(k.ctx, k.userId, p.id)
    expect(o.type).toBe('payee')
    if (o.type === 'payee') expect(o.check.needsConfirmation).toBe(true)
    // the proposal's own words cannot confirm anything
    expect(() => confirmPayee(k.ctx, k.userId, p.id, {})).toThrow(/looks like|another of your payees/)
    expect(k.db.all('SELECT 1 FROM payees WHERE user_id = ?', k.userId)).toHaveLength(1)
    const added = confirmPayee(k.ctx, k.userId, p.id, { lookalikeChecked: true, nameCheckAccepted: o.type === 'payee' ? o.check.nameCheck.outcome : '' })
    expect(added.handle).toBe('sunrise.rents@ybl')
    expect(k.db.all('SELECT 1 FROM payees WHERE user_id = ?', k.userId)).toHaveLength(2)
  })
  it('an address the owner did not type (one from a bill or a memo) is not proposed', async () => {
    const k = setup()
    const r = await asked(k, 'Add my landlord as a payee', () => [prop('add-payee', { name: 'Landlord', handle: 'pay.here@evilbank' })])
    expect(r.proposals[0]!.state).toBe('invalid')
    expect(r.proposals[0]!.invalidReason).toMatch(/not one you typed/)
  })
})

describe('an idea for Grow', () => {
  it('is checked and handed to Grow, whose own journey asks what it needs and records it; it moves no money', async () => {
    const k = setup()
    const text = 'Move half of my idle cash into a liquid fund'
    const r = await asked(k, text, () => [prop('idea', { text })])
    expect(r.proposals[0]).toMatchObject({ kind: 'idea', state: 'new' })
    const before = available(k.db, k.userId, 'bank')
    const o = await openOneOff(k.ctx, k.userId, r.proposals[0]!.id)
    expect(o.type).toBe('idea')
    if (o.type === 'idea') expect(o.text).toBe(text)
    expect(k.db.get('SELECT 1 FROM ideas WHERE user_id = ?', k.userId)).toBeUndefined()
    expect(available(k.db, k.userId, 'bank')).toBe(before)
    const bad = await asked(k, text, () => [prop('idea', { text: 'short' })])
    expect(bad.proposals[0]!.state).toBe('invalid')
  })
})

describe('structured clarification', () => {
  it('offers choices and a typed answer, keeps the question and the answer in the conversation, and takes the answer as the owner\'s own words', async () => {
    const k = setup()
    const m = double(
      () => reply({ answer: 'Which payee, and how much?', clarify: [{ field: 'amount', question: 'How much should I pay?', choices: ['₹12,000', '₹13,500'], allowTyped: true }, { field: 'payee', question: 'Who is it for?', choices: ['The rent payee'], allowTyped: false }] }),
      (u) => reply({ answer: 'Opening it.', proposals: [prop('pay', { payee: tokenOf(u, 'rent'), amount: 1_350_000 })] }),
    )
    const first = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Pay my rent' }, m.fn)
    expect(first.clarify.map((c) => [c.id, c.field, c.choices, c.allowTyped])).toEqual([['c0', 'amount', ['₹12,000', '₹13,500'], true], ['c1', 'payee', ['The rent payee'], false]])
    // a typed answer where only choices are allowed is refused
    await expect(ask(k.ctx, cfg, k.userId, k.userId, { question: '', conversationId: first.conversationId, clarification: { turnId: first.turnId, id: 'c1', value: 'someone else' } }, m.fn)).rejects.toThrow(/Choose one of the answers offered/)
    const second = await ask(k.ctx, cfg, k.userId, k.userId, { question: '', conversationId: first.conversationId, clarification: { turnId: first.turnId, id: 'c0', value: '₹13,500' } }, m.fn)
    // the answer is the owner's words: an amount they wrote, so the payment may use it
    expect(second.proposals[0]!.state).toBe('new')
    const view = conversationView(k.db, k.userId, k.userId, first.conversationId)
    expect(view.turns[0]!.clarify[0]!.answer).toMatchObject({ value: '₹13,500', typed: false })
    expect(view.turns[0]!.clarify[1]!.answer).toBeNull()
    expect(view.turns[1]!.question).toBe('How much should I pay? ₹13,500')
    // an answer is given once
    await expect(ask(k.ctx, cfg, k.userId, k.userId, { question: '', conversationId: first.conversationId, clarification: { turnId: first.turnId, id: 'c0', value: '₹12,000' } }, m.fn)).rejects.toThrow()
  })
})

describe('Ask never opens these kinds as drafts of instructions', () => {
  it('the batch route skips them with the reason', async () => {
    const k = setup()
    const r = await asked(k, 'Pay my rent ₹12,000 now', (u) => [prop('pay', { payee: tokenOf(u, 'rent'), amount: 1_200_000 })])
    const d = draftProposals(k.ctx, k.userId, [r.proposals[0]!.id])
    expect(d.drafted).toHaveLength(0)
    expect(d.skipped[0]!.reason).toMatch(/own card/)
  })
})
