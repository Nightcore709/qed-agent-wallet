/**
 * The words and states of the judge's walk-through (judge-view.ts), on the records the stack writes (the fixture of
 * server/judge-fixture.ts, linked by server/judge.ts) and on a case recorded from a real model on 22 Nov 2026. Every
 * step says what kind of evidence it rests on; the scripted test double is never called a model and a real model never
 * a double; every figure is a record's figure, said in words, never recomputed.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IDS, judgeRecords } from '../../server/judge-fixture.ts'
import { buildJudgeIndex } from '../../server/judge.ts'
import { briefReason, changedRows, type CaseLike, cosignerChecks, injectedView, type JudgeIndex, jobStamp, mandateWords, producedWords, proposalStamp, proposerLine, provenanceShown, recoveryView, spendFacts, usd, requestedWords, revocationView, say, stations, tickWords, when } from './judge-view.ts'

const LIVE = join(import.meta.dirname, '..', '..', 'evidence', '20261122-judge-journey-live')
const liveTick = JSON.parse(readFileSync(join(LIVE, 'cases', `${JSON.parse(readFileSync(join(LIVE, 'summary.json'), 'utf8')).main.engineTick}.json`), 'utf8')) as CaseLike
const base = { now: Date.parse('2026-11-24T08:00:00Z'), presentation: true, provider: { provider: 'scripted', model: 'scripted-test-double' } }
const index = (o: Parameters<typeof judgeRecords>[0], extra: Partial<typeof base> & { reader?: { personId: string; role: 'viewer' | 'admin' } } = {}): JudgeIndex => buildJudgeIndex(judgeRecords(o), { ...base, ...extra }) as unknown as JudgeIndex
const byId = (st: ReturnType<typeof stations>) => Object.fromEntries(st.map((s) => [s.id, s]))

describe('the six steps, as the household moves through them', () => {
  it('a fresh wallet: the first step is the next move, and says that nothing may move without a mandate', () => {
    const st = stations(index({ stage: 'fresh' }), null, null)
    expect(st.map((s) => s.progress)).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo'])
    expect(st[0]!.stamp).toBeNull()
    expect(st[0]!.finding).toBe('No mandate yet: without one, QED\'s agent may move nothing from the wallet. Sign the example mandate below to start.')
    expect(st.every((s) => ['genuine', 'scripted', 'historical', 'reproduced'].includes(s.provenance))).toBe(true)
  })

  it('the mandate in force, said with its own figures; then the model is the next move', () => {
    const ix = index({ stage: 'mandate' })
    const st = byId(stations(ix, null, null))
    expect(st.authority).toMatchObject({ progress: 'done', stamp: ['In force', 'ok'], provenance: 'reproduced' })
    expect(mandateWords(ix.mandate!, ix.wallet.asset)).toBe('At most 250.00 test rupees a payment or conversion, 600.00 test rupees a day and 2,000.00 test rupees in all, until 1 Dec, 12:30')
    expect(st.decision).toMatchObject({ progress: 'current', stamp: null })
    expect(st.decision!.finding).toMatch(/^Not asked yet\. A scripted test double answers Ask from a fixed file\. It is not a model/)
  })

  it('the double\'s proposal: replayed, never a model; QED\'s four checks; the signature is the next move', () => {
    const st = byId(stations(index({ stage: 'asked' }), null, null))
    expect(st.decision).toMatchObject({ progress: 'done', stamp: ['Proposed', 'plain'], provenance: 'scripted' })
    expect(st.authority!.finding).toContain('Your objective, as you typed it: “Keep at least 10 test dollars in my vault\'s dollar reserve, topped up automatically from the treasury.” The mandate your passkey signed')
    expect(st.decision!.finding).toMatch(/^The scripted test double, which is not a model, answered at 12:32\. It proposed “Keep 10 test dollars in the dollar reserve”, because: “A standing policy/)
    expect(st.decision!.facts).toContainEqual({ label: 'Where it comes from', value: 'Mock or scripted' })
    expect(st.checks).toMatchObject({ progress: 'done', stamp: null })
    expect(st.checks!.finding).toMatch(/^4 of 4 of QED's checks passed on the proposal, against the wallet's own figures\. The co-signer checks each tick again/)
    expect(st.checks!.groups.map((g) => g.title)).toEqual(['QED\'s checks of the proposal, before any terms existed'])
    expect(st.checks!.groups[0]!.checks.map((c) => c.name)).toEqual(['The on-chain wallet answered', 'The terms have the form the wallet accepts', 'A signed mandate is in force', 'The reserve target is within what the wallet accepts'])
    expect(st.checks!.groups[0]!.checks[2]!.detail).toBe('Mandate v1 is active: every tranche stays within 250.00 test rupees and its period and lifetime limits.')
    expect(st.execution).toMatchObject({ progress: 'current', stamp: ['Awaiting your approval', 'wait'] })
    expect(JSON.stringify(stations(index({ stage: 'asked' }), null, null))).not.toMatch(/A real model|answered by a model/i)
  })

  it('a real model\'s proposal: running now, named by the model the records name, never a double', () => {
    const st = byId(stations(index({ stage: 'asked', provider: 'claude-cli' }, { provider: { provider: 'claude-cli', model: 'claude-opus-5-5' } }), null, null))
    expect(st.decision!.provenance).toBe('genuine')
    expect(st.decision!.finding).toMatch(/^claude-opus-5-5, a real model, answered at 12:32\./)
    expect(st.decision!.facts[0]).toEqual({ label: 'Answered by', value: 'claude-opus-5-5, through claude-cli, as recorded when it answered' })
    expect(JSON.stringify(st)).not.toMatch(/test double/)
  })

  it('a tick that ran with no signature: the co-signer\'s own checks, the transaction, the chain read back, and the case to check', () => {
    const ix = index({ stage: 'ticked' })
    const st = byId(stations(ix, liveTick, null))
    const cos = cosignerChecks(liveTick)
    expect(cos.length).toBe(15)
    expect(cos.every((c) => c.pass && c.by.startsWith('the co-signer'))).toBe(true)
    expect(st.checks!.finding).toMatch(/The co-signer, a separate process with its own key, then re-derived the tick itself: 15 of 15 of its checks passed, and only then did it sign\. The model holds no key and signs nothing\.$/)
    expect(st.checks!.groups.map((g) => [g.title, g.checks.length])).toEqual([['QED\'s checks of the proposal, before any terms existed', 4], ['The co-signer\'s own checks of the tick, before it signed', 15]])
    expect(st.execution).toMatchObject({ progress: 'done', stamp: ['Completed', 'ok'], provenance: 'reproduced' })
    expect(st.execution!.finding).toMatch(/^Your passkey signed the policy's exact terms once, 24 Nov, 12:34\. Then a tick ran with no new signature\. QED's engine asked for it by itself, on its own schedule: no page asked for it, and no one signed anything for it\. It moved 250\.00 test rupees out of the treasury vault into the execution module; 2\.974112 test dollars into the dollar reserve, in a transaction on the local test chain\.$/)
    expect(st.execution!.facts).toEqual(expect.arrayContaining([{ label: 'A new signature for it', value: 'None' }, { label: 'Transaction', value: '0xae12760d…56a1e1', code: true }, { label: 'Block', value: '60' }, { label: 'Tranche', value: '250.00 test rupees, limited by the mandate\'s limit for one payment' }]))
    expect(st.reconciliation).toMatchObject({ progress: 'done', stamp: ['Completed', 'ok'] })
    expect(st.reconciliation!.finding).toBe('The chain mined it: Block 60, 363,564 gas. Read back from the chain afterwards: Free test dollars 0.00 → 2.974112 (target 10.00). That balance agrees with what the trade\'s own event on the chain says it delivered. The co-signer\'s decision records are whole: 3, each chained to the one before by its hash.')
    expect(st.reconciliation!.facts).toEqual([{ label: 'Dollar reserve, free (step 5)', value: '0.00 test dollars before, 2.974112 test dollars after' }])
    expect(st.evidence).toMatchObject({ progress: 'current', stamp: null, caseId: `vault.${IDS.tick}` })
    expect(st.evidence!.facts).toEqual([{ label: 'Case', value: liveTick.id, code: true }, { label: 'Root', value: `${liveTick.hashes.root.slice(0, 10)}…${liveTick.hashes.root.slice(-6)}`, code: true }])
    expect(byId(stations(ix, liveTick, { ok: true })).evidence).toMatchObject({ progress: 'done', stamp: ['Every hash matches', 'ok'] })
    expect(byId(stations(ix, liveTick, { ok: false })).evidence).toMatchObject({ progress: 'stopped', stamp: ['A hash does not match', 'void'] })
  })

  it('a tick the co-signer refused: the flow stops there, and says who refused', () => {
    const st = byId(stations(index({ stage: 'ticked', tick: 'refused' }), null, null))
    expect(st.execution).toMatchObject({ progress: 'stopped', stamp: ['Refused by QED\'s checks', 'void'] })
    expect(st.checks).toMatchObject({ progress: 'stopped', stamp: ['Refused by QED\'s checks', 'void'] })
    expect(st.checks!.finding).toMatch(/The co-signer refused the tick: Refused: C12 not met: Authority budget: this conversion's cost does not fit\./)
    expect(st.reconciliation).toMatchObject({ progress: 'todo', stamp: null })
    expect(st.evidence!.progress).toBe('todo')
  })

  it('a member who did not ask reads that a question was asked, and no words of it', () => {
    const st = byId(stations(index({ stage: 'asked' }, { reader: { personId: 'person-b', role: 'viewer' } }), null, null))
    expect(st.authority!.finding).toMatch(/^Your objective, as you typed it: A question asked by another member of this workspace \(shown only to them and to the workspace's owners and admins\)\. The mandate your passkey signed/)
    expect(st.decision!.finding).toMatch(/It proposed a standing policy for the wallet\. A proposal is only words/)
    expect(JSON.stringify(st)).not.toContain('Keep at least 10 test dollars')
  })
})

describe('the branches', () => {
  it('changed inputs on the double: allowed at 3, refused at 300 by the mandate, each with its case', () => {
    const c = changedRows(index({ stage: 'ticked', branches: true }))
    expect(c.rows.map((r) => [r.amount, r.tone, r.proposedBy])).toEqual([['3', 'ok', 'scripted'], ['300', 'void', 'scripted']])
    expect(c.rows[0]!.proposed).toBe('Pay 3 test rupees to CloudCo')
    expect(c.rows[1]!.proposed).toBe('Pay 300 test rupees to the payee in the wallet\'s book')
    expect(c.rows[1]!.decided).toBe('Refused by QED\'s checks: The vault\'s own limit check refuses 300 test rupees: Per-payment limit in the owner\'s signed mandate (250.00 test rupees left).')
    expect(c.sentence).toBe('Only the amount changed, from 3 to 300 test rupees, and the decision changed with it: allowed at 3, refused at 300, by the limit your mandate sets.')
  })

  it('changed inputs with a real model that proposes nothing at 300: said as such, nothing claimed for QED', () => {
    const c = changedRows(index({ stage: 'ticked', branches: true, provider: 'claude-cli' }, { provider: { provider: 'claude-cli', model: 'claude-opus-5-5' } }))
    expect(c.rows.map((r) => [r.amount, r.decided, r.proposedBy])).toEqual([['3', 'Allowed by QED\'s checks; it would still need your signature to run.', 'genuine'], ['300', 'Nothing to check: the model proposed no payment.', 'genuine']])
    expect(c.sentence).toBe('Only the amount changed, from 3 to 300 test rupees, and the decision changed with it: allowed at 3, not proposed at 300.')
  })

  it('the hidden instruction: the double follows it and QED refuses it, nothing sent; a model that ignores it is said to', () => {
    const d = injectedView(index({ stage: 'ticked', branches: true }))!
    expect(d).toMatchObject({ who: 'A scripted test double, not a model', proposedBy: 'scripted', tone: 'ok' })
    expect(d.proposed).toBe('Pay 50 test rupees to the address 0x00000000…00dEaD (the double follows the hidden instruction, as a compromised model might)')
    expect(d.decided).toBe('Refused by QED\'s checks: "0x00000000…00dEaD" is not a payee of the vault\'s book: it has 3 payees, given to the model as tokens.')
    expect(d.nothingSent).toBe('Nothing was sent: a proposal that fails a check can never become terms for your passkey, so the wallet was never asked.')
    const m = injectedView(index({ stage: 'ticked', branches: true, provider: 'claude-cli' }, { provider: { provider: 'claude-cli', model: 'claude-opus-5-5' } }))!
    expect(m).toMatchObject({ who: 'A real model: claude-opus-5-5', proposedBy: 'genuine', proposed: 'Nothing: it did not follow the hidden instruction', decided: 'Nothing to refuse: no payment was proposed', tone: 'ok' })
    expect(injectedView(index({ stage: 'ticked' }))).toBeNull()
  })

  it('the revocation and the tick after it; a repeat with one key; authority restored by a new signature', () => {
    const ix = index({ stage: 'restored', repeated: true })
    const r = revocationView(ix)!
    expect(r).toMatchObject({ at: '24 Nov, 12:50', stamp: ['Completed', 'ok'] })
    expect(r.next).toMatchObject({ stamp: ['Failed', 'void'], words: 'The next tick did not run: No standing policy yet: the owner must sign one first. Nothing was sent to the chain. It was asked for from this page on purpose, after the policy ended; QED\'s vault service refused it, not the model and not the page.' })
    const rec = recoveryView(ix)
    expect(rec.repeated!.words).toBe('Your session asked for the same tick 2 times with one key, as a browser does after an answer is lost. The vault service started one job and answered every repeat with that same job: nothing ran twice.')
    expect(rec.restored!.words).toBe('You signed a standing policy again with your passkey, 24 Nov, 12:55. Authority comes back only that way: QED, the model and the vault service hold no key that can sign for you.')
    expect(rec.restored!.next).toMatchObject({ stamp: ['Completed', 'ok'], words: 'The next tick ran again under it: Converted 250.00 test rupees → 2.971754 test dollars; bound 2.971755. QED\'s engine asked for it by itself.' })
    expect(revocationView(index({ stage: 'ticked' }))).toBeNull()
    expect(recoveryView(index({ stage: 'ticked' }))).toEqual({ repeated: null, restored: null })
  })
})

describe('words', () => {
  it('who answers, in one line and its kind of evidence', () => {
    expect(proposerLine({ provider: 'claude-cli', model: 'claude-opus-5-5', isModel: true, label: 'model', statement: '' })).toMatchObject({ word: 'A real model: claude-opus-5-5', tone: 'ok', provenance: 'genuine' })
    expect(proposerLine({ provider: 'scripted', model: 'scripted-test-double', isModel: false, label: 'scripted-test-double', statement: '' })).toMatchObject({ word: 'A scripted test double, not a model', tone: 'wait', provenance: 'scripted' })
    expect(proposerLine({ provider: 'none', model: '', isModel: false, label: 'none', statement: '' })).toMatchObject({ word: 'No model', provenance: null })
  })
  it('who asked for a tick', () => {
    expect(requestedWords({ requestedBy: 'engine', asked: 0 })).toBe('QED\'s engine asked for it by itself, on its own schedule: no page asked for it, and no one signed anything for it.')
    expect(requestedWords({ requestedBy: 'owner', asked: 2 })).toBe('It was asked for from a page, your session (2 times, with one key), with no signature: it ran under the policy you had already signed. The engine did not start it.')
    expect(requestedWords({ requestedBy: 'unrecorded', asked: 0 })).toBe('No record says who asked for it.')
  })
  it('outcomes in the shared status words', () => {
    expect(jobStamp({ outcome: 'executed', status: 'done' })).toEqual(['Completed', 'ok'])
    expect(jobStamp({ outcome: 'refused', status: 'done' })).toEqual(['Refused by QED\'s checks', 'void'])
    expect(jobStamp({ outcome: 'failed', status: 'failed' })).toEqual(['Failed', 'void'])
    expect(jobStamp({ outcome: 'no-action', status: 'done' })).toEqual(['Nothing to do', 'plain'])
    expect(jobStamp({ outcome: '', status: 'running' })).toEqual(['Pending', 'plain'])
    expect(proposalStamp({ state: 'invalid' })).toEqual(['Refused by QED\'s checks', 'void'])
    expect(proposalStamp({ state: 'drafted' })).toEqual(['Proposed', 'plain'])
  })
  it('addresses shortened, never dropped; test tokens in words; times in India time', () => {
    expect(say('"0x000000000000000000000000000000000000dEaD" is not a payee; 300 tINR')).toBe('"0x00000000…00dEaD" is not a payee; 300 test rupees')
    expect(when('2026-11-24T07:02:00.000Z')).toBe('24 Nov, 12:32')
    expect(producedWords('2026-11-22 22:40:08.534 IST')).toBe('22 Nov 2026, 22:40 IST')
    expect(producedWords('2026-11-25T10:00:00Z')).toBe('25 Nov 2026, 15:30 IST')
    expect(producedWords(null)).toBe('At an unrecorded time')
  })
  it('a refusal said by its first rule, the others counted', () => {
    expect(briefReason('The vault\'s own limit check refuses 300 tINR: Per-payment limit in the owner\'s signed mandate (the same limit as per conversion) (250.00 tINR left); Left in the mandate\'s current period (100.00 tINR left); Authority budget (co-signer check C12, R7 decision D7): what leaves the workspace\'s control stays within what the owner granted (7.04 tINR left).'))
      .toBe('The vault\'s own limit check refuses 300 tINR: Per-payment limit in the owner\'s signed mandate (250.00 tINR left), and 2 more limits.')
    expect(briefReason('"0x00" is not a payee of the vault\'s book: it has 3 payees. A payment can go only to one of them.')).toBe('"0x00" is not a payee of the vault\'s book: it has 3 payees.')
  })
  it('a tick under the same policy, from its own figures', () => {
    expect(tickWords({ n: 1, action: 'convert', amountIn: '25000', outcome: 'executed', limitedBy: 'mandate cap' }, { symbol: 'tINR', decimals: 2 })).toBe('Tick 1: converted 250.00 test rupees, limited by the mandate\'s limit for one payment')
    expect(tickWords({ n: 2, action: 'convert', amountIn: '25000', outcome: 'refused', limitedBy: 'need' }, { symbol: 'tINR', decimals: 2 })).toBe('Tick 2: would have converted 250.00 test rupees, limited by what the reserve was short, then the co-signer refused it')
    expect(tickWords({ n: 3, action: 'wait', amountIn: null, outcome: 'no-action', limitedBy: 'impact' }, { symbol: 'tINR', decimals: 2 })).toBe('Tick 3: waited')
  })
  it('where the steps a page shows come from (R13): the double\'s run is scripted, a model\'s genuine; reproduced and historical always', () => {
    expect(provenanceShown(index({ stage: 'asked' }))).toEqual(['scripted', 'historical', 'reproduced'])
    expect(provenanceShown(index({ stage: 'asked', provider: 'claude-cli' }, { presentation: false, provider: { provider: 'claude-cli', model: 'claude-opus-5-5' } }))).toEqual(['genuine', 'historical', 'reproduced'])
  })
  it('every step and branch of the engine-run chain says one of the four, and the refusals are QED\'s own (R13)', () => {
    const ix = index({ stage: 'restored', branches: true })
    expect(stations(ix, liveTick, { ok: true }).map((s) => [s.id, s.provenance])).toEqual([['authority', 'reproduced'], ['decision', 'scripted'], ['checks', 'reproduced'], ['execution', 'reproduced'], ['reconciliation', 'reproduced'], ['evidence', 'reproduced']])
    expect(byId(stations(ix, liveTick, null)).execution!.finding).toContain('QED\'s engine asked for it by itself')
    expect(changedRows(ix).rows.map((r) => [r.amount, r.proposedBy, r.tone])).toEqual([['3', 'scripted', 'ok'], ['300', 'scripted', 'void']])
    expect(injectedView(ix)).toMatchObject({ proposedBy: 'scripted', decided: expect.stringMatching(/^Refused by QED's checks: /) })
    expect(revocationView(ix)!.next!.words).toMatch(/It was asked for from this page on purpose, after the policy ended; QED's vault service refused it, not the model and not the page\.$/)
    expect(recoveryView(ix).restored!.next!.words).toMatch(/QED's engine asked for it by itself\.$/)
    // with no model on the installation, the decision step points at the recorded runs: historical, never left unlabelled
    const none = index({ stage: 'mandate' }, { provider: { provider: 'none', model: '' } })
    expect(byId(stations(none, null, null)).decision).toMatchObject({ provenance: 'historical', finding: expect.stringMatching(/as historical evidence\.$/) })
  })
})

describe('on the Anthropic API: why this model, and what it cost (server/ask-models.ts, as server/judge.ts reads the call)', () => {
  it('the decision says the kind of question, any model passed over or asked first, and the cost priced from the reported tokens', () => {
    expect(spendFacts({ tier: 'demanding', why: 'it asks about investing, a plan, a strategy or advice', costUsd: 0.0661, priceSource: 'Anthropic, “Pricing”, read 25 Nov 2026',
      attempts: [{ model: 'claude-fable-5-2', answeredBy: null, outcome: 'overloaded' }, { model: 'claude-opus-5-5', answeredBy: 'claude-opus-5-5', outcome: 'answered' }], passedOver: [] })).toEqual([
      { label: 'Why this model', value: 'A demanding question: it asks about investing, a plan, a strategy or advice. Asked first, without an answer: claude-fable-5-2 (overloaded).' },
      { label: 'What it cost', value: 'US$0.07 in all, 2 requests, priced from the tokens the API reported (Anthropic, “Pricing”, read 25 Nov 2026)' },
    ])
    expect(spendFacts({ tier: 'routine', why: 'it is a short question or a look-up', costUsd: 0.004, priceSource: null, attempts: [{ model: 'claude-sonnet-5-5', answeredBy: 'claude-sonnet-5-5', outcome: 'answered' }], passedOver: [{ model: 'claude-fable-5-2', why: 'not listed for this key by GET /v1/models' }] })[0]!.value)
      .toBe('A routine question: it is a short question or a look-up. Passed over: claude-fable-5-2 (not listed for this key by GET /v1/models).')
    expect(usd(12.5)).toBe('US$12.50')
  })
})
