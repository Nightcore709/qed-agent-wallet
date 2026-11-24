/**
 * Grow's idea journey on the server (server/ideas.ts), on a test household and a SYNTHETIC price record: reading an idea
 * against the books, the five judgements kept apart, the alternatives on the same windows, and the decision handed to
 * the approval flows. A seeded fault for each rule: the bank balance used where only free money may be, goal money
 * counted, a purchase below the floor offered, a fund with no NAV called placeable, a figure shown for an asset with no
 * record, a choice that was not offered accepted, and an action created before the owner signed.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { stepAllActions } from './execute.ts'
import { createIdea, decide, ideaRecord, investigate, listIdeas, readWithAnswers } from './ideas.ts'
import { saveProfile } from './household.ts'
import { post } from './ledger.ts'
import { liquidity } from './liquidity.ts'
import { submitApprovedAction } from './owner.ts'
import { activateProgram, requestProgramApproval } from './programs.ts'
import { sha256hex } from './receipts.ts'
import { ensureGoalAccount } from './setaside.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import { overview } from './valuation.ts'
import { prng } from '../shared/portfolio.ts'
import { canonical } from '../shared/sha256.ts'

const DAY = 86_400_000
/** A synthetic weekday record for one fund, written as the app records NAVs, its last value the market's latest. */
function history(k: Kit, id: string, from: string, drift: number, vol: number, seed: number): void {
  const rnd = prng(seed)
  let v = 100, last = ''
  k.db.tx(() => {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse('2026-11-17T00:00:00Z'); t += DAY) {
      const d = new Date(t)
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
      v *= Math.exp(drift + vol * (rnd() * 2 - 1))
      last = d.toISOString().slice(0, 10)
      k.db.run('INSERT OR REPLACE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, last, v.toFixed(4), k.clock.now(), 'test')
    }
  })
  k.nav(id, last, v.toFixed(4))
}
function kit(): Kit {
  const k = makeKit()
  history(k, 'amfi:120716', '2022-10-03', 0.0005, 0.012, 1) // Nifty 50 index
  history(k, 'amfi:120684', '2022-10-03', 0.0006, 0.015, 2) // Nifty Next 50
  history(k, 'amfi:122639', '2022-10-03', 0.0006, 0.011, 3) // flexi cap
  history(k, 'amfi:119788', '2022-10-03', 0.0004, 0.009, 4) // gold
  history(k, 'amfi:148381', '2024-06-03', 0.0005, 0.012, 5) // S&P 500: a shorter record, left out of the basket
  history(k, 'amfi:118701', '2022-10-03', 0.00027, 0.0002, 6) // liquid
  return k
}
const read = (k: Kit, text: string, answers: Record<string, unknown> = {}) => readWithAnswers(k.ctx, k.userId, text, answers, k.clock.now())
const inv = (k: Kit, text: string, answers: Record<string, unknown> = {}) => investigate(k.ctx, k.userId, text, answers, k.clock.now())
const verdicts = (i: Awaited<ReturnType<typeof inv>>) => Object.fromEntries(i.judgements.map((j) => [j.key, j.verdict]))

describe('reading an idea against the books', () => {
  it('asks what the words leave open, and answers fill it in; idle cash offers figures from what is free', () => {
    const k = kit()
    const r = read(k, '₹50,000 into the Nifty 50 index fund')
    expect(r.reading.questions.map((q) => q.key)).toEqual(['cadence'])
    expect(read(k, '₹50,000 into the Nifty 50 index fund', { cadence: 'once' }).reading.questions).toEqual([])
    const park = read(k, 'Move idle cash to a liquid fund')
    const free = liquidity(k.db, k.userId, k.clock.now()).free
    expect(park.free).toBe(free)
    expect(park.reading.questions[0]!.choices![0]).toEqual({ value: String(Math.floor(free / 100_000) * 100_000), label: expect.stringMatching(/^All that is free, ₹/) })
    // an answer naming something QED does not list is ignored, not trusted
    expect(read(k, 'invest ₹1,000 once', { instrumentId: 'amfi:999999' }).reading.questions.map((q) => q.key)).toEqual(['instrument'])
  })
  it('refuses selling and borrowing, and says where to go', async () => {
    const k = kit()
    expect(read(k, 'sell my units').reading.refusal).toMatch(/Buy or sell/)
    await expect(inv(k, 'buy nifty on margin', { amount: 100_000, cadence: 'once' })).rejects.toThrow(/does not borrow/)
  })
})

describe('the investigation keeps five things apart', () => {
  it('a lump sum into the Nifty 50 index fund: each judgement, and the idea beside doing nothing and the alternatives on the same windows', async () => {
    const k = kit()
    const i = await inv(k, '₹50,000 into the Nifty 50 index fund', { cadence: 'once' })
    expect(i.title).toBe('₹50,000 into UTI Nifty 50 Index Fund, once')
    expect(verdicts(i)).toMatchObject({ implementable: 'yes', affordable: 'yes', eligible: 'yes' })
    expect(['yes', 'caution']).toContain(verdicts(i).compatible)
    expect(i.judgements.find((j) => j.key === 'implementable')!.says).toMatch(/NAV for Wed 18 Nov \(cut-off 15:00 India time\)/)
    expect(i.evidence.outcomes.map((o) => o.id)).toEqual(['idea', 'cash', 'liquid', 'spread', 'basket', 'loan'])
    // the basket leaves out the fund whose record starts later, so every plan is judged on the same windows
    expect(i.evidence.outcomes.find((o) => o.id === 'basket')!.label).toBe('Equal shares of 4 funds')
    expect(i.evidence.windows).toBeGreaterThan(500)
    expect(i.evidence.firstStart! >= '2022-10-03').toBe(true)
    const cash = i.evidence.outcomes.find((o) => o.id === 'cash')!
    expect(cash.lostIn).toBe(0)
    expect(cash.median).toBeCloseTo(1 + (Math.pow(1.0275, 366 / 365) - 1) * (1 - 0.3 * 1.04), 10)
    // claims: monthly, 36 months or more, every comparison counted (four here: nothing, liquid, basket; no mix held)
    expect(i.evidence.claims.map((c) => c.vs)).toEqual(['doing nothing', 'the liquid fund', 'equal shares of 4 funds'])
    expect(i.evidence.claims.every((c) => c.difference.months >= 36 && !c.difference.tooShort)).toBe(true)
    expect(i.evidence.notes.join(' ')).toMatch(/not a probability.*Nothing is fitted.*closed or merged.*not tax advice/)
    // the personal loan is a certain alternative, named with its rate
    expect(i.evidence.outcomes.find((o) => o.id === 'loan')).toMatchObject({ lostIn: 0, median: 1.11 })
    expect(i.case.against.join(' ')).toMatch(/personal loan costs 14% a year/)
    expect(i.choices.map((c) => [c.id, c.allowed])).toEqual([['order', true], ['alt:liquid', true], ['alt:spread', true], ['reject', true], ['nothing', true]])
    expect(i.stress.map((s) => s.label)).toEqual(['The worst past window', 'The worst past month, at once', 'A fall by its limit'])
  })

  it('affordable only from free money: what must stay in the bank and goal money are not counted (seeded fault: the bank balance used)', async () => {
    const k = kit()
    const free = liquidity(k.db, k.userId, k.clock.now()).free
    const bank = overview(k.db, k.market, k.userId, k.clock.now()).bank
    const over = Math.floor((free + 100_000) / 100) * 100 // more than is free, less than the bank holds
    expect(over).toBeLessThan(bank)
    const i = await inv(k, 'into the nifty 50 index fund once', { amount: over })
    expect(verdicts(i).affordable).toBe('no')
    expect(i.choices.find((c) => c.id === 'order')).toMatchObject({ allowed: false, why: expect.stringMatching(/^Not offered: it needs ₹/) })
    // set ₹4 lakh aside for a goal: still the household's money, never free to invest
    ensureGoalAccount(k.db, k.userId, 'gl_test', 'Holiday')
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'goal', ref: 'test-goal', memo: 'Set aside', lines: [{ account: 'goal:gl_test', amount: 40_000_000n }, { account: 'bank', amount: -40_000_000n }] })
    const after = liquidity(k.db, k.userId, k.clock.now()).free
    expect(after).toBe(free - 40_000_000)
    const g = await inv(k, 'into the nifty 50 index fund once', { amount: Math.floor((after + 50_000) / 100) * 100 })
    expect(verdicts(g).affordable).toBe('no')
    expect(g.judgements.find((j) => j.key === 'affordable')!.says).toMatch(/The ₹4,00,000 set aside for goals is not counted\./)
    expect(g.context.setAside).toBe(40_000_000)
  })

  it('the floor: a purchase that would take the worst case below it is not offered, with the most that keeps it (seeded fault)', async () => {
    const k = kit()
    saveProfile(k.db, k.userId, { line: Math.floor((overview(k.db, k.market, k.userId, k.clock.now()).worst.gHat - 1_000_000) / 100) * 100 })
    const i = await inv(k, '₹50,000 into the Nifty 50 index fund once')
    expect(verdicts(i).compatible).toBe('no')
    expect(i.judgements.find((j) => j.key === 'compatible')!.says).toMatch(/below your floor of ₹.*The most that keeps you above it is about ₹/)
    expect(i.effects.worstAfter).toBeLessThan(i.effects.floor)
    expect(i.choices.find((c) => c.id === 'order')!.allowed).toBe(false)
    const { id } = await createIdea(k.ctx, k.userId, { text: '₹50,000 into the Nifty 50 index fund once' }, k.clock.now())
    await expect(decide(k.ctx, k.userId, id, { choice: 'order' }, k.clock.now())).rejects.toThrow(/Not offered/)
  })

  it('implementable: a fund with no NAV yet, an amount under the venue\'s smallest order, no order book (seeded faults)', async () => {
    const k = kit()
    expect(verdicts(await inv(k, '₹10,000 into the overnight fund once'))).toMatchObject({ implementable: 'no' })
    k.btc(6_000_000)
    expect(verdicts(await inv(k, '₹50 of bitcoin once'))).toMatchObject({ implementable: 'no' })
    k.bookDown = true
    const down = await inv(k, '₹2,000 of bitcoin once')
    expect(verdicts(down).implementable).toBe('unknown')
    expect(down.choices.find((c) => c.id === 'order')!.allowed).toBe(false)
  })

  it('bitcoin: no recorded daily prices, so no figure is shown for it and the record says why', async () => {
    const k = kit()
    k.btc(6_000_000)
    const i = await inv(k, 'Buy ₹2,000 of bitcoin once')
    expect(i.evidence.basis).toBe('none')
    expect(verdicts(i).supported).toBe('unknown')
    expect(i.evidence.outcomes[0]).toMatchObject({ id: 'idea', median: null, worst: null, lostIn: null })
    expect(i.evidence.says[0]).toMatch(/no recorded daily prices for Bitcoin in rupees/)
    expect(i.evidence.claims).toEqual([])
    // the alternatives are still judged, on the liquid fund's record
    expect(i.evidence.outcomes.find((o) => o.id === 'cash')!.median).not.toBeNull()
    expect(i.costs.map((c) => c.label)).toEqual(['Venue fee, each way', 'Half the gap between buyers and sellers, each way', 'Tax deducted at source on a sale', 'Tax on a gain when you sell'])
  })

  it('every month: judged as the instruction it would become, from what is left over each month', async () => {
    const k = kit()
    const ok = await inv(k, 'A monthly SIP of ₹5,000 in the flexi cap fund')
    expect(verdicts(ok)).toMatchObject({ implementable: 'yes', affordable: 'yes' })
    expect(ok.schedule).toBe('On the 7th of each month at 10:00 India time, 12 times; it asks you before each purchase.')
    expect(ok.evidence.outcomes.map((o) => o.id)).toEqual(['idea', 'cash', 'liquid', 'basket', 'loan'])
    expect(ok.choices[0]).toMatchObject({ id: 'instruction', allowed: true })
    const big = await inv(k, 'A monthly SIP of ₹50,000 in the flexi cap fund')
    expect(verdicts(big).affordable).toBe('no')
    expect(big.judgements.find((j) => j.key === 'affordable')!.says).toMatch(/a month is left over, and this needs ₹50,000 a month/)
  })
})

describe('the decision and what follows', () => {
  it('a one-time order: prepared for the passkey with nothing created before it is signed; then the record follows it to its fill', async () => {
    const k = kit()
    const { id } = await createIdea(k.ctx, k.userId, { text: '₹50,000 into the Nifty 50 index fund', answers: { cadence: 'once' } }, k.clock.now())
    const rec0 = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(rec0.hash).toBe(sha256hex(canonical(rec0.investigation)))
    expect(rec0.state).toBe('open')
    const d = await decide(k.ctx, k.userId, id, { choice: 'order', reason: 'For the long run' }, k.clock.now())
    expect(d.kind).toBe('order')
    const approvalId = (d as unknown as { preview: { approvalId: string } }).preview.approvalId
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', k.userId)!.n).toBe(0) // nothing to send before a signature
    const rec1 = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(rec1).toMatchObject({ state: 'awaiting-signature', choice: 'order', reason: 'For the long run', order: { approvalId, signed: false, action: null } })
    // the owner signs; the action is made from the signed document and runs through the engine's own checks
    const docHash = k.db.get<{ doc_hash: string }>('SELECT doc_hash FROM approvals WHERE id = ?', approvalId)!.doc_hash
    confirmApproval(k.db, k.userId, approvalId, { method: 'passkey', docHash }, k.clock.now())
    submitApprovedAction(k.ctx, k.userId, approvalId)
    await stepAllActions(k.ctx)
    const rec2 = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(rec2.state).toBe('acted')
    expect(rec2.order!.signed).toBe(true)
    expect(rec2.order!.action!.checks.length).toBeGreaterThan(0)
    await settle(k)
    k.clock.advance(12 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '200.0000')
    await settle(k)
    const rec3 = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(rec3.order!.action!.state).toBe('done')
    expect(rec3.monitor).toMatchObject({ put: 5_000_000, days: 0, says: expect.stringMatching(/too early to compare/) })
    expect(rec3.monitor!.value).toBeGreaterThan(0)
    expect(rec3.events.map((e) => e.kind)).toEqual(['investigated', 'decided', 'signed', 'sent', 'filled'])
    expect(rec3.events[0]!.says).toMatch(/^Tested on your books and the recorded prices: QED can place it; free money pays for it; it is open to you; it keeps your rules/)
    // too early to compare after a day; after 40 days the record sets it beside the bank and the liquid fund
    k.clock.advance(40 * DAY)
    const later = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(later.monitor!.says).toMatch(/^Over 40 days: worth ₹.*against ₹.* had it stayed in the bank/)
    expect(later.monitor!.doNothing).toBeGreaterThan(5_000_000)
    // a signed idea is not decided again: it is revised, or what was signed is paused
    await expect(decide(k.ctx, k.userId, id, { choice: 'nothing' }, k.clock.now())).rejects.toThrow(/already signed/)
  })

  it('every month: a draft instruction from the idea that asks before each purchase, 12 at most; signed, the idea has acted', async () => {
    const k = kit()
    const { id } = await createIdea(k.ctx, k.userId, { text: 'A monthly SIP of ₹5,000 in the flexi cap fund' }, k.clock.now())
    const d = await decide(k.ctx, k.userId, id, { choice: 'instruction' }, k.clock.now())
    expect(d.kind).toBe('instruction')
    const programId = (d as { programId: string }).programId
    const p = k.db.get<{ state: string; origin: string; live_version: number | null }>('SELECT state, origin, live_version FROM programs WHERE id = ?', programId)!
    expect(p).toEqual({ state: 'draft', origin: `idea:${id}`, live_version: null })
    const v = k.db.get<{ params_json: string; authority_json: string }>('SELECT params_json, authority_json FROM program_versions WHERE program_id = ?', programId)!
    expect(JSON.parse(v.params_json)).toEqual({ instrumentId: 'amfi:122639', amount: 500_000, schedule: { type: 'monthly', day: 7, at: '10:00', zone: 'Asia/Kolkata' } })
    expect(JSON.parse(v.authority_json)).toMatchObject({ runMode: 'approve', maxRuns: 12, maxPerRun: 500_000 })
    expect(ideaRecord(k.ctx, k.userId, id, k.clock.now()).state).toBe('awaiting-signature')
    const req = requestProgramApproval(k.ctx, k.userId, programId)
    const hash = k.db.get<{ doc_hash: string }>('SELECT doc_hash FROM approvals WHERE id = ?', req.approvalId)!.doc_hash
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: hash }, k.clock.now())
    activateProgram(k.ctx, k.userId, programId, req.approvalId)
    const rec = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(rec.state).toBe('acted')
    expect(rec.instruction).toMatchObject({ programId, state: 'active', signed: true })
  })

  it('a decision can change until something is signed: the earlier request is withdrawn first', async () => {
    const k = kit()
    const { id } = await createIdea(k.ctx, k.userId, { text: '₹50,000 into the Nifty 50 index fund once' }, k.clock.now())
    const a = await decide(k.ctx, k.userId, id, { choice: 'order' }, k.clock.now())
    const first = (a as unknown as { preview: { approvalId: string } }).preview.approvalId
    const b = await decide(k.ctx, k.userId, id, { choice: 'alt:spread' }, k.clock.now())
    expect(k.db.get<{ c: number | null }>('SELECT cancelled_at c FROM approvals WHERE id = ?', first)!.c).not.toBeNull()
    const programId = (b as { programId: string }).programId
    expect(JSON.parse(k.db.get<{ p: string }>('SELECT params_json p FROM program_versions WHERE program_id = ?', programId)!.p).amount).toBe(833_300)
    await decide(k.ctx, k.userId, id, { choice: 'nothing' }, k.clock.now())
    expect(k.db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', programId)!.state).not.toBe('draft')
    expect(ideaRecord(k.ctx, k.userId, id, k.clock.now())).toMatchObject({ state: 'no-action', order: null, instruction: null })
  })

  it('not this: kept with its reason; a closed idea is not decided again; a revision links back', async () => {
    const k = kit()
    const { id } = await createIdea(k.ctx, k.userId, { text: '₹50,000 into the Nifty 50 index fund once' }, k.clock.now())
    await decide(k.ctx, k.userId, id, { choice: 'reject', reason: 'The loan first' }, k.clock.now())
    const r = ideaRecord(k.ctx, k.userId, id, k.clock.now())
    expect(r).toMatchObject({ state: 'declined', reason: 'The loan first' })
    expect(r.events.at(-1)!.says).toBe('Not this: "The loan first"')
    await expect(decide(k.ctx, k.userId, id, { choice: 'order' }, k.clock.now())).rejects.toThrow(/closed/)
    const { id: next } = await createIdea(k.ctx, k.userId, { text: '₹20,000 into the Nifty 50 index fund once', revises: id }, k.clock.now() + 1)
    expect(ideaRecord(k.ctx, k.userId, id, k.clock.now()).revisedBy).toBe(next)
    expect(listIdeas(k.db, k.userId).map((x) => x.id)).toEqual([next, id])
  })

  it('going ahead is checked again on the books as they are then: money spent since the test is not free (seeded fault: the snapshot trusted)', async () => {
    const k = kit()
    const free = liquidity(k.db, k.userId, k.clock.now()).free
    const { id } = await createIdea(k.ctx, k.userId, { text: '₹1,00,000 into the nifty 50 index fund once' }, k.clock.now())
    expect(ideaRecord(k.ctx, k.userId, id, k.clock.now()).investigation.choices[0]).toMatchObject({ id: 'order', allowed: true })
    // spent since the test: what is free is now ₹50,000
    const spent = BigInt(free - 5_000_000)
    post(k.db, { userId: k.userId, ts: k.clock.now(), kind: 'spend', ref: 'since-the-test', memo: 'Spent since', lines: [{ account: 'exp:spend', amount: spent }, { account: 'bank', amount: -spent }] })
    expect(liquidity(k.db, k.userId, k.clock.now()).free).toBe(5_000_000)
    await expect(decide(k.ctx, k.userId, id, { choice: 'order' }, k.clock.now())).rejects.toThrow(/Free money has changed/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals WHERE user_id = ?', k.userId)!.n).toBe(0)
  })

  it('a choice the investigation did not offer is refused, whatever is sent (seeded fault)', async () => {
    const k = kit()
    const { id } = await createIdea(k.ctx, k.userId, { text: 'A monthly SIP of ₹5,000 in the flexi cap fund' }, k.clock.now())
    await expect(decide(k.ctx, k.userId, id, { choice: 'order' }, k.clock.now())).rejects.toThrow(/Choose one of the decisions offered/)
    await expect(decide(k.ctx, k.userId, id, { choice: 'alt:liquid' }, k.clock.now())).rejects.toThrow(/Choose one of the decisions offered/)
    await expect(decide(k.ctx, k.userId, 'idea_nope', { choice: 'reject' }, k.clock.now())).rejects.toThrow(/not found/)
  })
})
