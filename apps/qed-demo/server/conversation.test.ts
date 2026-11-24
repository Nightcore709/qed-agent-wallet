/**
 * Ask as a conversation (R7-092) and the checks around each reply (N-005 payee tokens, grounded figures, cited records,
 * fixed links). The model is replaced by a test double that records exactly what it was sent.
 */
import { describe, expect, it } from 'vitest'
import { ask, conversationView, detectProvider, draftProposals, type ModelFn, type ProposalOutput } from './ai.ts'
import { groundingOf, isCancellation, linksOf, writtenRupees } from './conversation.ts'
import { loadConfig } from './core.ts'
import { addBill, addPayee } from './owner.ts'
import { amountText, requestProgramApproval, saveDraft } from './programs.ts'
import { makeKit } from './testkit.ts'

const cfg = loadConfig({})
const DAY = 86_400_000
type Proposal = ProposalOutput['proposals'][number]
const reply = (o: Partial<ProposalOutput>): ProposalOutput => ({ answer: '', proposals: [], questions: [], withdraw: [], cites: [], links: [], ...o })
const proposal = (o: Partial<Proposal>): Proposal => ({ kind: 'invest', title: 'Invest', rationale: 'Why.', paramsJson: '{}', runMode: 'approve', supersedes: null, limits: { maxPerRun: null, maxPerMonth: null, maxRuns: null, endsInDays: null }, ...o })
const btc = (amount: number, schedule: unknown = { type: 'monthly', day: 5, at: '10:00' }) => JSON.stringify({ instrumentId: 'coindcx:BTCINR', amount, schedule })
/** A model double that answers in turn and remembers what it was sent. */
function double(...answers: ((user: string) => ProposalOutput)[]): { fn: ModelFn; sent: string[] } {
  const sent: string[] = []
  return { sent, fn: async (_system, user) => { sent.push(user); const a = answers[sent.length - 1]; if (!a) throw new Error('the model was asked more often than expected'); return { output: a(user), refusal: null, provider: 'test-double', model: 'test-double', responseId: null, latencyMs: 1, usage: {} } } }
}
const noModel: ModelFn = async () => { throw new Error('the model must not be asked') }
const historyIds = (user: string): string[] => [...(user.split('HISTORY (')[1] ?? '').split('QUESTION (')[0]!.matchAll(/"id":"(prp_[^"]+)"/g)].map((m) => m[1]!)

describe('Ask: a conversation, not a single question', () => {
  it('a later turn carries the earlier one to the model, and a correction supersedes the earlier proposal instead of editing it', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const m = double(
      () => reply({ answer: 'A monthly purchase fits.', proposals: [proposal({ title: 'Buy bitcoin every month', paramsJson: btc(200_000) })] }),
      (user) => reply({ answer: 'Changed to ₹3,000 a month.', proposals: [proposal({ title: 'Buy bitcoin every month', paramsJson: btc(300_000), supersedes: historyIds(user)[0]! })] }),
    )
    const first = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy ₹2,000 of bitcoin every month' }, m.fn)
    const second = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Make it ₹3,000 instead', conversationId: first.conversationId }, m.fn)
    expect(m.sent[0]).not.toContain('HISTORY (')
    expect(m.sent[1]).toContain('HISTORY (')
    expect(historyIds(m.sent[1]!)).toEqual([first.proposals[0]!.id])
    expect(second.conversationId).toBe(first.conversationId)
    expect(second.superseded).toEqual([{ from: first.proposals[0]!.id, to: second.proposals[0]!.id }])
    const view = conversationView(k.db, k.userId, k.userId, first.conversationId)
    expect(view.turns.map((t) => t.proposals.map((p) => p.state))).toEqual([['superseded'], ['new']])
    expect(view.turns[0]!.proposals[0]!.supersededBy).toBe(second.proposals[0]!.id)
    expect(view.turns[1]!.proposals[0]!.supersedes).toBe(first.proposals[0]!.id)
    // the earlier proposal is kept as it was; the correction is a new one
    expect((view.turns[0]!.proposals[0]!.params as { amount: number }).amount).toBe(200_000)
    expect((view.turns[1]!.proposals[0]!.params as { amount: number }).amount).toBe(300_000)
  })

  it('"cancel that" withdraws the open proposals in QED\'s own code, without the model; a proposal already opened as a draft keeps its draft', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const m = double(() => reply({ answer: 'Two ways.', proposals: [proposal({ title: 'Buy monthly', paramsJson: btc(200_000) }), proposal({ title: 'Buy weekly', paramsJson: btc(50_000, { type: 'weekly', weekday: 1, at: '10:00' }) })] }))
    const first = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'How could I buy bitcoin regularly?' }, m.fn)
    const [monthly, weekly] = first.proposals
    const d = draftProposals(k.ctx, k.userId, [weekly!.id])
    expect(d.drafted).toHaveLength(1)
    const c = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Cancel that.', conversationId: first.conversationId }, noModel)
    expect(c.kind).toBe('cancel')
    expect(c.engine.provider).toBe('qed')
    expect(c.withdrawn).toEqual([monthly!.id])
    // titled as the cards show them: QED's own title for what each instruction does
    const titleOf = (p: typeof monthly) => String(p!.analysis!.title)
    expect(c.answer).toContain(`Withdrawn: "${titleOf(monthly)}". Nothing was signed`)
    expect(c.answer).toContain(`"${titleOf(weekly)}" was already opened as a draft: a draft does nothing unless you sign it`)
    expect(c.links).toEqual([{ to: `/instructions/${d.drafted[0]!.programId}`, label: `Draft: ${d.drafted[0]!.title}` }])
    expect(k.db.all('SELECT state FROM proposals WHERE id IN (?, ?) ORDER BY title', monthly!.id, weekly!.id)).toEqual([{ state: 'dismissed' }, { state: 'drafted' }])
    expect(k.db.get('SELECT state FROM programs WHERE id = ?', d.drafted[0]!.programId)).toEqual({ state: 'draft' })
    const again = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'never mind', conversationId: first.conversationId }, noModel)
    // the draft is still there, so a second cancellation says so again rather than claiming nothing exists
    expect(again.answer).toBe(`There was nothing open to withdraw in this conversation. "${titleOf(weekly)}" was already opened as a draft: a draft does nothing unless you sign it, and you can discard it under Instructions.`)
    await expect(ask(k.ctx, cfg, k.userId, k.userId, { question: 'cancel' }, noModel)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a request for several things becomes several proposals, opened as drafts together; one that is not valid is skipped with the reason', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const m = double(() => reply({ answer: 'Three parts.', proposals: [proposal({ title: 'Buy monthly', paramsJson: btc(200_000) }), proposal({ title: 'Buy weekly', paramsJson: btc(50_000, { type: 'weekly', weekday: 1, at: '10:00' }) }), proposal({ title: 'Broken', paramsJson: '{}' })] }))
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy bitcoin monthly and weekly, and something else' }, m.fn)
    expect(r.proposals.map((p) => p.state)).toEqual(['new', 'new', 'invalid'])
    const d = draftProposals(k.ctx, k.userId, r.proposals.map((p) => p.id))
    expect(d.drafted.map((x) => x.proposalId)).toEqual([r.proposals[0]!.id, r.proposals[1]!.id])
    expect(d.skipped).toEqual([{ proposalId: r.proposals[2]!.id, reason: 'It is not valid, so it cannot be drafted.' }])
    for (const x of d.drafted) expect(k.db.get('SELECT state, origin FROM programs WHERE id = ?', x.programId)).toEqual({ state: 'draft', origin: `proposal:${x.proposalId}` })
    expect(draftProposals(k.ctx, k.userId, [r.proposals[0]!.id]).skipped[0]!.reason).toBe('It is already a draft.')
  })

  it('a correction or withdrawal touches only open proposals of the same conversation', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const other = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy ₹2,000 of bitcoin monthly' }, double(() => reply({ answer: 'One.', proposals: [proposal({ paramsJson: btc(200_000) })] })).fn)
    const here = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy ₹500 of bitcoin weekly' }, double(() => reply({ answer: 'One.', proposals: [proposal({ paramsJson: btc(50_000, { type: 'weekly', weekday: 1, at: '10:00' }) })] })).fn)
    const foreign = other.proposals[0]!.id
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Change the other one and drop it', conversationId: here.conversationId }, double(() => reply({ answer: 'Done.', proposals: [proposal({ paramsJson: btc(250_000), supersedes: foreign })], withdraw: [foreign, 'prp_unknown'] })).fn)
    expect(r.superseded).toEqual([])
    expect(r.withdrawn).toEqual([])
    expect(k.db.get('SELECT state FROM proposals WHERE id = ?', foreign)).toEqual({ state: 'new' })
  })

  it('an instruction drafted from a model\'s proposal says so in the document that is signed; one typed by hand does not (N-006)', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy ₹2,000 of bitcoin every month' }, double(() => reply({ answer: 'One.', proposals: [proposal({ paramsJson: btc(200_000) })] })).fn)
    const d = draftProposals(k.ctx, k.userId, [r.proposals[0]!.id])
    const fromModel = requestProgramApproval(k.ctx, k.userId, d.drafted[0]!.programId)
    expect((JSON.parse(fromModel.draft.document) as { drafted?: string }).drafted).toBe("A model (test-double) drafted this instruction from the owner's question. No licensed adviser reviewed it.")
    const byHand = saveDraft(k.ctx, k.userId, { kind: 'invest', params: JSON.parse(btc(200_000)) as unknown })
    expect((JSON.parse(requestProgramApproval(k.ctx, k.userId, byHand.programId).draft.document) as { drafted?: string }).drafted).toBeUndefined()
  })

  it('a conversation belongs to one person in one workspace', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Buy ₹2,000 of bitcoin monthly' }, double(() => reply({ answer: 'One.' })).fn)
    expect(() => conversationView(k.db, k.userId, 'usr_someone_else', r.conversationId)).toThrow(/not found/)
    expect(() => conversationView(k.db, 'usr_other_workspace', k.userId, r.conversationId)).toThrow(/not found/)
    await expect(ask(k.ctx, cfg, k.userId, 'usr_someone_else', { question: 'and now?', conversationId: r.conversationId }, noModel)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('Ask: what is sent, and what comes back, is checked by QED', () => {
  it('payees reach the model only as tokens, and a token in a proposal comes back as exactly that payee (N-005)', async () => {
    const k = makeKit()
    const now = k.clock.now()
    const payee = addPayee(k.db, k.userId, { name: 'Ramesh Kumar', handle: 'ramesh.k@okaxis', category: 'rent', nameCheckAccepted: 'unknown' }, now)
    addBill(k.db, k.userId, { payeeId: payee.id, amount: 1_500_000, dueAt: now + 5 * DAY, memo: 'Rent for Ramesh Kumar' }, now)
    const m = double((user) => {
      const token = (JSON.parse(user.split('\n')[1]!) as { payees: { payee: string; category: string }[] }).payees.find((p) => p.category === 'rent')!.payee
      return reply({ answer: `I would pay Payee ${token.slice(6)} the rent of ₹15,000 when it falls due.`, proposals: [proposal({ kind: 'bills', title: `Pay Payee ${token.slice(6)} when due`, runMode: 'notify', paramsJson: JSON.stringify({ payeeHandles: [token], capPerBill: 1_600_000, leadMinutes: 60 }) })] })
    })
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'Pay Ramesh Kumar\'s rent of ₹15,000 when it is due; his address is ramesh.k@okaxis' }, m.fn)
    expect(m.sent[0]).not.toMatch(/ramesh|okaxis|kumar/i)
    const stored = k.db.get<{ sent_json: string; question: string }>('SELECT sent_json, question FROM ai_calls WHERE id = ?', r.callId!)!
    expect(stored.sent_json).not.toMatch(/ramesh|okaxis|kumar/i)
    expect(stored.question).toContain('Ramesh Kumar') // the owner's own words are kept as written, on this machine
    expect((r.proposals[0]!.params as { payeeHandles: string[] }).payeeHandles).toEqual(['ramesh.k@okaxis'])
    expect(r.proposals[0]!.state).toBe('new')
    expect(r.proposals[0]!.title).toBe('Pay Ramesh Kumar when due')
    expect(r.answer).toBe('I would pay Ramesh Kumar the rent of ₹15,000 when it falls due.')
  })

  it('every rupee figure in a reply is looked for in the records, and each cited record is shown with its value', async () => {
    const k = makeKit()
    const m = double((user) => {
      const bank = (JSON.parse(user.split('\n')[1]!) as { position: { bank: number } }).position.bank
      return reply({ answer: `You have ${amountText(Math.round(bank * 100))} in the bank. Keep ₹9,99,999 aside.`, cites: ['position.bank', 'position.nowhere'], links: ['safeguards', 'pay'] })
    })
    const r = await ask(k.ctx, cfg, k.userId, k.userId, { question: 'How much do I have in the bank?' }, m.fn)
    expect(r.grounding.checked).toBe(2)
    expect(r.grounding.ungrounded).toEqual([{ text: '₹9,99,999', paise: 99_999_900 }])
    expect(r.cites).toHaveLength(1)
    expect(r.cites[0]).toMatchObject({ path: 'position.bank', label: 'Bank balance' })
    expect(r.citesUnresolved).toBe(1)
    expect(r.links).toEqual([{ to: '/safeguards', label: 'Your floor and reserve' }, { to: '/pay', label: 'Pay someone' }])
  })

  it('reads rupee figures at the precision they were written, and refuses a rounding that misleads', () => {
    expect(writtenRupees('about ₹1.5 lakh, then Rs 3,000 and 2 lakh rupees, and 250 rupees')).toEqual([
      { text: '₹1.5 lakh', paise: 15_000_000, step: 1_000_000 }, { text: 'Rs 3,000', paise: 300_000, step: 100 },
      { text: '2 lakh rupees', paise: 20_000_000, step: 10_000_000 }, { text: '250 rupees', paise: 25_000, step: 100 },
    ])
    expect(writtenRupees('every 5 minutes for 30 days, 12 times, 30%')).toEqual([])
    expect(groundingOf('about ₹1.5 lakh', [14_800_000]).ungrounded).toEqual([])
    expect(groundingOf('₹2 lakh', [15_100_000]).ungrounded).toHaveLength(1) // within the precision, but 25% off
    expect(groundingOf('₹1,23,456', [12_345_600]).ungrounded).toEqual([])
    expect(groundingOf('₹1,23,457', [12_345_600]).ungrounded).toHaveLength(1)
  })

  it('recognises a message that only cancels, and leaves "stop" and "no" to the model', () => {
    for (const q of ['cancel', 'Cancel that.', 'please cancel them', 'never mind', 'Nevermind!', 'forget it', 'withdraw both', 'no, cancel it', 'scrap that', 'I don\'t want any of them']) expect(isCancellation(q), q).toBe(true)
    for (const q of ['stop', 'no', 'cancel my card bill payment and pay the rent', 'what does cancel mean?', 'stop everything']) expect(isCancellation(q), q).toBe(false)
  })

  it('links come only from the fixed list; the scripted test double runs only on an isolated test stack', () => {
    expect(linksOf(['pay', 'http://evil.example', 'pay', 'security'])).toEqual([{ to: '/pay', label: 'Pay someone' }, { to: '/security', label: 'Security' }])
    const scripted = { ...cfg, aiProvider: 'scripted' as const, aiScript: '/x.json' }
    expect(detectProvider(scripted, {}).provider).toBe('none')
    expect(detectProvider(scripted, { QED_TEST_STACK: '1' }).provider).toBe('scripted')
  })
})
