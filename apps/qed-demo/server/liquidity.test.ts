import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { bankTick } from './bank.ts'
import { istInstant } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { getProfile, saveProfile, validateProfile } from './household.ts'
import { balance, post, verifyLedger } from './ledger.ts'
import { authorityEnvelope, billLowersReserve, HORIZON_DAYS, limitAdvice, liquidity, profileLowersReserve, runCalendar, staysLiquid } from './liquidity.ts'
import { previewAction, submitApprovedAction } from './owner.ts'
import { activateProgram, buildDraft, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'
import type { Authority } from './types.ts'
import { overview, worstCase } from './valuation.ts'

const DAY = 86_400_000
/*
 * The test household, on Wednesday 18 November 2026 at 10:30 IST (T0), opened that morning:
 *   salary ₹1,20,000 on the 1st; instalments ₹10,000 + ₹20,000 on the 5th; everyday spending ₹70,000 a month.
 * Everyday spending is spread over the days of each month, rounded up to the paisa:
 *   November has 30 days: 70,00,000 / 30 = 2,33,333.34 paise a day, so 2,33,334
 *   December and January have 31: 70,00,000 / 31 = 2,25,806.45, so 2,25,807
 */
const NOV = 233_334, DEC = 225_807
const NOV_18_TO_30 = 13 * NOV          // 30,33,342 paise
const EMIS = 3_000_000                  // both instalments, each month

async function cycle(k: Kit, prices?: () => void): Promise<void> {
  prices?.()
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
async function run(k: Kit, ms: number, prices?: () => void, stepMs = 5000): Promise<void> {
  for (let t = 0; t < ms; t += stepMs) { k.clock.advance(stepMs); await cycle(k, prices) }
}
function start(k: Kit, kind: string, params: unknown, authority: Partial<Authority> = {}): string {
  // These journeys exercise an instruction that runs on its own. Since R12 (task comparison, gap 14) a hand-written
  // instruction asks each time unless the owner chooses otherwise, so the fixture chooses, as the owner would.
  const d = saveDraft(k.ctx, k.userId, { kind, params, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'auto', ...authority } })
  const req = requestProgramApproval(k.ctx, k.userId, d.programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
  return d.programId
}
const runs = (k: Kit, programId: string) => k.db.all<{ state: string; reason: string | null }>('SELECT state, reason FROM runs WHERE program_id = ? ORDER BY created_at, due_at', programId)
/** A payee the household has had for a month: these tests are about the reserve, not a new payee's first day (new-payee.ts). */
const payee = (k: Kit, handle: string, name: string): string => { const id = `pay_${handle.replace(/\W/g, '')}`; k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, name, handle, 'utility', k.clock.now() - 30 * DAY, k.clock.now()); return id }
const bill = (k: Kit, payeeId: string, amount: number, dueAt: number): string => { const id = `bill_${amount}_${dueAt}`; k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)", id, k.userId, payeeId, amount, dueAt, '', k.clock.now()); return id }
/** A household with no card debt and no floor, so that only liquidity can refuse. */
const thin = (bank: number, profile = {}) => makeKit({ opening: { bank, fd: 0, card: 0, personalLoan: 30_000_000, homeLoan: 200_000_000 }, profile: { line: 0, ...profile } })

describe('the reserve: what must stay in the bank for everything due', () => {
  it('with the default assumptions (income up to 5 days late, one salary lost) it reaches to 6 January', () => {
    const k = makeKit()
    const l = liquidity(k.db, k.userId, T0)
    // The December salary is the one allowed to go missing, so the first counted is January's, by the 6th.
    // Until then: spending 18 Nov to 6 Jan, and the instalments of 5 December and 5 January.
    const need = NOV_18_TO_30 + 31 * DEC + 6 * DEC + 2 * EMIS
    expect(need).toBe(17_388_201)
    expect(l.need).toBe(need)
    expect(l.binding?.date).toBe('2027-01-06')
    expect(l.binding?.inflows).toBe(0)
    expect(l.binding?.parts).toEqual([{ kind: 'emi', label: 'Loan instalments', amount: 2 * EMIS }, { kind: 'living', label: 'Everyday spending', amount: need - 2 * EMIS }])
    expect(l.binding?.items.map((d) => [d.date, d.amount])).toEqual([['2026-12-05', 1_000_000], ['2026-12-05', 2_000_000], ['2027-01-05', 1_000_000], ['2027-01-05', 2_000_000]])
    expect(l.assumptions.firstCounted).toEqual({ due: '2027-01-01', by: '2027-01-06' })
    expect(l.available).toBe(80_000_000)
    expect(l.free).toBe(80_000_000 - need)
    expect(l.short).toBe(0)
    expect(l.sustainable).toBe(true)
    expect(l.path[0]).toEqual({ date: '2026-11-18', low: 80_000_000 - NOV })
    expect(Math.min(...l.path.map((p) => p.low))).toBe(80_000_000 - need) // the lowest point of the worst case is exactly what is spare
    expect(overview(k.db, k.market, k.userId, T0).freeToUse).toBe(80_000_000 - need)
  })

  it('with salary on time and none lost, the tight day is the morning of the next salary', () => {
    const k = makeKit({ profile: { lateDays: 0, lostSalaries: 0 } })
    const l = liquidity(k.db, k.userId, T0)
    expect(l.need).toBe(NOV_18_TO_30 + DEC) // spending to 1 December; the instalments on the 5th are paid from the salary
    expect(l.binding?.date).toBe('2026-12-01')
    expect(l.assumptions.firstCounted).toEqual({ due: '2026-12-01', by: '2026-12-01' })
  })

  it('counts a large bill beyond 30 days, which the 30-day rule in the worst case does not', () => {
    const k = makeKit()
    const before = liquidity(k.db, k.userId, T0).need
    const worstBefore = worstCase(k.db, k.market, k.userId, T0).reserves
    bill(k, payee(k, 'school@upi', 'School fees'), 25_000_000, istInstant('2026-12-28', '10:00')) // 40 days out
    expect(liquidity(k.db, k.userId, T0).need).toBe(before + 25_000_000)
    expect(worstCase(k.db, k.market, k.userId, T0).reserves).toBe(worstBefore) // unchanged: the floor's own term looks 30 days ahead
  })

  it('a bill due after the first counted salary can move the tight day rather than add to it', () => {
    const k = makeKit()
    const before = liquidity(k.db, k.userId, T0)
    // The next tight day after 6 January is 6 February, the morning the February salary is counted. Without any bill
    // it needs less: everything due from 18 Nov to 6 Feb (February has 28 days: ₹2,500 a day) less January's salary.
    const FEB = 250_000
    const on6Feb = NOV_18_TO_30 + 31 * DEC + 31 * DEC + 6 * FEB + 3 * EMIS - 12_000_000
    expect(on6Feb).toBe(15_533_376)
    expect(on6Feb).toBeLessThan(before.need)
    const tax = payee(k, 'tax@upi', 'Advance tax')
    // ₹10,000 due on 20 January: 6 February still needs less than 6 January, so nothing changes.
    const small = bill(k, tax, 1_000_000, istInstant('2027-01-20', '10:00'))
    expect(liquidity(k.db, k.userId, T0).need).toBe(before.need)
    k.db.run("UPDATE bills SET state = 'cancelled' WHERE id = ?", small)
    // ₹50,000 due the same day: now 6 February is the harder day, and it is that day's figure that must be kept.
    bill(k, tax, 5_000_000, istInstant('2027-01-20', '10:00'))
    const l = liquidity(k.db, k.userId, T0)
    expect(l.need).toBe(on6Feb + 5_000_000)
    expect(l.binding?.date).toBe('2027-02-06')
    expect(l.binding?.inflows).toBe(12_000_000)
  })

  it('instalments follow the loan: none once it is repaid, and a prepayment lowers what is needed', () => {
    const k = thin(50_000_000)
    const base = liquidity(k.db, k.userId, T0).need
    // Repaying the personal loan in full removes its two instalments from the stretch to 6 January.
    expect(liquidity(k.db, k.userId, T0, { prepays: { code: 'loan:personal', amount: 30_000_000 } }).need).toBe(base - 2_000_000)
  })

  it('says when no reserve can be enough: outgoings larger than income', () => {
    const k = makeKit({ profile: { spending: 13_000_000 } })
    const l = liquidity(k.db, k.userId, T0)
    // ₹1,30,000 of spending and ₹30,000 of instalments against ₹1,20,000 of salary: each month needs ₹40,000 more than
    // the last, so the hardest day found is simply the last salary morning inside the look-ahead, 6 April.
    expect(l.binding?.date).toBe('2027-04-06')
    expect(l.binding!.step).toBeGreaterThanOrEqual(HORIZON_DAYS - 31)
    expect(l.sustainable).toBe(false)
    expect(liquidity(makeKit().db, 'usr_test', T0).sustainable).toBe(true)
  })

  it('an instalment that fell due and was not taken is owed today', () => {
    const k = thin(100_000) // ₹1,000 in the bank: the bank cannot take the instalments on the 5th
    k.clock.set(istInstant('2026-12-05', '09:05'))
    const l = liquidity(k.db, k.userId, k.clock.now())
    expect(l.binding?.items.filter((d) => d.date === '2026-12-05').map((d) => d.amount)).toEqual([1_000_000, 2_000_000])
    expect(l.short).toBeGreaterThan(0)
  })

  it('notices a salary that is later than allowed, counts it as lost, and says when that is worse than was allowed for', () => {
    // 8 December: the salary due on the 1st could arrive up to the 6th. It has not. (The kit posts no salary by itself.)
    const dec8 = T0 + 20 * DAY
    const k = makeKit()
    expect(liquidity(k.db, k.userId, T0).assumptions.late).toBeNull()
    expect(liquidity(k.db, k.userId, T0 + 18 * DAY).assumptions.late).toBeNull()              // the 6th: its last allowed day
    const l = liquidity(k.db, k.userId, dec8)
    // One salary was allowed to be lost and this is it: nothing is beyond the allowance, and January's is counted on.
    expect(l.assumptions.late).toEqual({ due: '2026-12-01', count: 1, beyondAllowance: 0 })
    expect(l.assumptions.firstCounted).toEqual({ due: '2027-01-01', by: '2027-01-06' })
    // With none allowed to be lost the same record is worse than the assumption, and the figure is the same:
    // the lost salary counts for nothing either way.
    const strict = makeKit({ profile: { lostSalaries: 0 } })
    const s = liquidity(strict.db, strict.userId, dec8)
    expect(s.assumptions.late).toEqual({ due: '2026-12-01', count: 1, beyondAllowance: 1 })
    expect(s.need).toBe(l.need)
    // Once the salary is on the ledger nothing is late.
    post(k.db, { userId: k.userId, ts: dec8, kind: 'income-salary', ref: 'salary:2026-12', memo: 'Salary (paper)', meta: { paper: true }, lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    expect(liquidity(k.db, k.userId, dec8).assumptions.late).toBeNull()
  })
  it('an instalment refused for lack of money is taken when the money is there, dated then and said so, not back-dated as if the engine had been stopped (the statement review)', () => {
    // ₹1,000 in the bank, the personal loan's ₹10,000 instalment due on the 5th at 09:00 (the engine running)
    const k = thin(100_000, { personalLoanEmi: 1_000_000, homeLoanEmi: 0, emiDay: 5, income: 0 })
    const due = istInstant('2026-12-05', '09:00')
    k.clock.set(due + 60_000); bankTick(k.ctx)
    expect(k.db.get(`SELECT 1 FROM entries WHERE user_id = ? AND ref = 'emi:loan:personal:2026-12'`, k.userId)).toBeUndefined()
    // money arrives on the 9th; the next tick takes the instalment then
    const taken = istInstant('2026-12-09', '12:00')
    k.clock.set(taken)
    post(k.db, { userId: k.userId, ts: taken, kind: 'paper-topup', ref: 'topup:1', memo: 'top-up', lines: [{ account: 'bank', amount: 5_000_000n }, { account: 'inc:other', amount: -5_000_000n }] })
    bankTick(k.ctx)
    const e = k.db.get<{ effective_ts: number; meta_json: string }>(`SELECT effective_ts, meta_json FROM entries WHERE user_id = ? AND ref = 'emi:loan:personal:2026-12'`, k.userId)!
    expect(e.effective_ts).toBe(taken)
    const meta = JSON.parse(e.meta_json) as { note?: string; scheduledAt?: number }
    expect(meta.note).toBe('Taken late: the money was not there on its day.')
    expect(meta.scheduledAt).toBe(due)
    expect(meta.note).not.toMatch(/engine/)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('a paper salary missed because the engine was stopped across the month\'s turn is posted late, not counted as lost (Q-045)', () => {
    const k = thin(5_000_000, { income: 12_000_000, incomeDay: 28 })
    k.clock.set(istInstant('2026-11-27', '10:00')); bankTick(k.ctx)
    expect(k.db.get(`SELECT 1 FROM entries WHERE user_id = ? AND ref = 'salary:2026-11'`, k.userId)).toBeUndefined()
    // the engine is stopped from the 27th and runs again on 2 December
    const dec2 = istInstant('2026-12-02', '10:00')
    k.clock.set(dec2); bankTick(k.ctx)
    const e = k.db.get<{ effective_ts: number; meta_json: string }>(`SELECT effective_ts, meta_json FROM entries WHERE user_id = ? AND ref = 'salary:2026-11'`, k.userId)
    expect(e?.effective_ts).toBe(istInstant('2026-11-28', '09:30'))
    expect((JSON.parse(e!.meta_json) as { recordedLate?: boolean }).recordedLate).toBe(true)
    expect(liquidity(k.db, k.userId, dec2).assumptions.lostSoFar).toBe(0)
    bankTick(k.ctx) // once only
    expect(k.db.all(`SELECT 1 FROM entries WHERE user_id = ? AND ref = 'salary:2026-11'`, k.userId)).toHaveLength(1)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('an instalment that could not be taken stays owed into the next month, in the reserve and at the paper bank', () => {
    // 5 December: ₹30,000 of instalments fall due and the bank holds ₹5,000. Nothing is taken. On 10 January, after
    // the January instalments have also fallen due, ₹60,000 is owed today. (Until 20 November 2026 the December
    // instalments were forgotten at the month's end, though the notice said they would be taken.)
    // No salary on record here: the paper bank would otherwise pay December's on the 1st and the instalments would go through.
    const k = thin(500_000, { spending: 0, income: 0 })
    k.clock.set(istInstant('2026-12-05', '10:00')); bankTick(k.ctx)
    expect(k.db.all(`SELECT 1 FROM notices WHERE kind = 'emi-unpaid'`).length).toBe(2)
    expect(k.db.all(`SELECT 1 FROM entries WHERE user_id = ? AND kind = 'loan-instalment'`, k.userId).length).toBe(0)
    const jan = istInstant('2027-01-10', '10:00')
    k.clock.set(jan)
    const l = liquidity(k.db, k.userId, jan)
    expect(l.binding!.items.filter((d) => d.step === 0).map((d) => d.amount).reduce((a, b) => a + b, 0)).toBe(4 * 0 + 6_000_000)
    // Money arrives; the bank takes the oldest first and then the newer ones.
    post(k.db, { userId: k.userId, ts: jan, kind: 'money-in', ref: 'in:test-1', memo: 'Money in', lines: [{ account: 'bank', amount: 12_000_000n }, { account: 'inc:salary', amount: -12_000_000n }] })
    bankTick(k.ctx)
    expect(k.db.all<{ ref: string }>(`SELECT ref FROM entries WHERE user_id = ? AND kind = 'loan-instalment' ORDER BY seq`, k.userId).map((e) => e.ref)).toEqual(['emi:loan:personal:2026-12', 'emi:loan:personal:2027-01', 'emi:loan:home:2026-12', 'emi:loan:home:2027-01'])
    expect(liquidity(k.db, k.userId, jan).binding?.items.filter((d) => d.step === 0) ?? []).toEqual([])
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('accepts only sensible assumptions', () => {
    expect(validateProfile({ lateDays: 16 })).toHaveProperty('lateDays')
    expect(validateProfile({ lostSalaries: 4 })).toHaveProperty('lostSalaries')
    expect(validateProfile({ lateDays: 0, lostSalaries: 3 })).toEqual({})
    const k = makeKit()
    const before = liquidity(k.db, k.userId, T0).need
    saveProfile(k.db, k.userId, { lostSalaries: 2 })
    expect(liquidity(k.db, k.userId, T0).need).toBeGreaterThan(before) // allowing for more never lowers the reserve
    saveProfile(k.db, k.userId, { lostSalaries: 0, lateDays: 0 })
    expect(liquidity(k.db, k.userId, T0).need).toBeLessThan(before)
  })
})

describe('the rule: an instruction may not create a shortfall, nor deepen one', () => {
  it('refuses a purchase that the floor allows but that would take money an instalment needs', async () => {
    // ₹2,00,000 in the bank, ₹1,73,882.01 of it needed: ₹26,117.99 is free. No card debt and no floor, so the floor check passes.
    const k = thin(20_000_000)
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 2_000_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 2_000_000, maxPerMonth: 20_000_000 })
    await run(k, 65_000, () => k.btc(6_600_000))
    expect(runs(k, id)[0]!.state).toBe('done') // ₹20,000 of the ₹26,117.99 that is free
    await run(k, 60_000, () => k.btc(6_600_000))
    const second = runs(k, id)[1]!
    expect(second.state).toBe('blocked')
    expect(second.reason).toMatch(/must stay for what is due by 6 Jan 2027, allowing for income up to 5 days late and one salary not arriving/)
    const act = k.db.all<{ policy_json: string }>('SELECT policy_json FROM actions WHERE program_id = ? ORDER BY created_at', id).map((r) => JSON.parse(r.policy_json).checks as { name: string; ok: boolean }[])
    expect(act[1]!.filter((c) => !c.ok).map((c) => c.name)).toEqual(['stays-liquid'])
    expect(act[1]!.find((c) => c.name === 'worst-case-stays-above-floor')!.ok).toBe(true)
    expect(Number(balance(k.db, k.userId, 'bank'))).toBeGreaterThanOrEqual(liquidity(k.db, k.userId, k.clock.now()).need)
    expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true)
  })

  it('paying a bill that is due today is allowed even when the household is already short; paying one early, or buying, is not', () => {
    const k = thin(5_000_000)
    const power = payee(k, 'power@upi', 'City Power')
    const today = bill(k, power, 1_000_000, T0 + 3_600_000)
    const later = bill(k, power, 1_100_000, istInstant('2027-02-20', '10:00'))
    const before = liquidity(k.db, k.userId, T0)
    expect(before.short).toBeGreaterThan(0)
    const due = staysLiquid(k.db, k.userId, T0, 1_000_000, { paysBillId: today })
    expect(due.ok).toBe(true)
    expect(due.needAfter).toBe(before.need - 1_000_000)
    expect(staysLiquid(k.db, k.userId, T0, 1_100_000, { paysBillId: later }).ok).toBe(false)
    expect(staysLiquid(k.db, k.userId, T0, 10_000).ok).toBe(false)
  })

  it('what a draft says about today is what the engine then does on the same state: to the paisa', async () => {
    // ₹1,73,882.01 must stay. A run of ₹20,000 just fits with ₹1,93,882.01 in the bank, and does not with one paisa less.
    // The draft's analysis and the engine's decision are separate code; this holds them to the same verdict.
    for (const [bank, refused] of [[17_388_201 + 2_000_000, false], [17_388_201 + 2_000_000 - 1, true], [17_388_201 + 5_000_000, false], [17_388_201, true]] as const) {
      const k = thin(bank)
      k.btc(6_600_000)
      const params = { instrumentId: 'coindcx:BTCINR', amount: 2_000_000, schedule: { type: 'every', minutes: 1 } }
      const d = buildDraft(k.ctx, k.userId, 'invest', params, { maxPerRun: 2_000_000, maxPerMonth: 2_000_000, expiresAt: T0 + 30 * DAY }, T0)
      const says = d.analysis.warnings.some((w) => w.startsWith('Today a run would be refused: ₹'))
      const id = start(k, 'invest', params, { maxPerRun: 2_000_000, maxPerMonth: 2_000_000 })
      await run(k, 65_000, () => k.btc(6_600_000))
      const first = runs(k, id)[0]!
      expect([bank, says, first.state === 'blocked']).toEqual([bank, refused, refused])
      if (refused) expect(k.db.all<{ policy_json: string }>('SELECT policy_json FROM actions WHERE program_id = ?', id).map((r) => (JSON.parse(r.policy_json).checks as { name: string; ok: boolean }[]).filter((c) => !c.ok).map((c) => c.name))[0]).toEqual(['stays-liquid'])
    }
  })

  it('an instruction may not pay a bill ahead of its day when that would leave an earlier debit uncovered', () => {
    // Found by an adversarial review on 20 November 2026. No everyday spending, so the figures can be worked by hand:
    // instalments of ₹30,000 on 5 December and 5 January, a bill of ₹11,000 due 6 December, salary not counted on
    // until 6 January. By 5 January ₹71,000 is due. With ₹35,000 the household is ₹36,000 short either way, so the
    // rule "the shortfall may not grow" let the bill be paid on 18 November. But then ₹24,000 is left and the
    // instalments of 5 December cannot be taken, where before they could.
    const k = thin(3_500_000, { spending: 0 })
    const power = payee(k, 'power@upi', 'City Power')
    const b = bill(k, power, 1_100_000, istInstant('2026-12-06', '10:00'))
    const before = liquidity(k.db, k.userId, T0)
    expect([before.need, before.short, before.binding!.date]).toEqual([7_100_000, 3_600_000, '2027-01-05'])
    const early = staysLiquid(k.db, k.userId, T0, 1_100_000, { paysBillId: b })
    expect(early.ok).toBe(false)
    expect(early.firstWorse).toEqual({ date: '2026-12-05', shortBefore: 0, shortAfter: 600_000 })
    expect(early.detail).toMatch(/That would leave ₹6,000 too little for what is due by 5 Dec 2026\.$/)
    // On its own day the bill is owed either way, and paying it makes no day worse. (The instalments of the 5th were
    // not taken in this test, so they are owed on the 6th as well.)
    expect(staysLiquid(k.db, k.userId, istInstant('2026-12-06', '11:00'), 1_100_000, { paysBillId: b }).ok).toBe(true)
    // With ₹45,000 the household is still short for 5 January, but paying the bill early leaves 5 December covered
    // (₹34,000 against ₹30,000) and changes nothing after the 6th: no day is made worse, so it is allowed.
    const k2 = thin(4_500_000, { spending: 0 })
    const b2 = bill(k2, payee(k2, 'power@upi', 'City Power'), 1_100_000, istInstant('2026-12-06', '10:00'))
    expect(liquidity(k2.db, k2.userId, T0).short).toBe(2_600_000)
    const fine = staysLiquid(k2.db, k2.userId, T0, 1_100_000, { paysBillId: b2 })
    expect([fine.ok, fine.firstWorse]).toEqual([true, null])
    // Spending that pays nothing off makes every short day worse, and is refused.
    expect(staysLiquid(k2.db, k2.userId, T0, 100).ok).toBe(false)
  })

  it('through the engine: a bills instruction that pays a week ahead does not pay early what would leave an instalment uncovered, and pays on the day', async () => {
    const k = thin(3_500_000, { spending: 0 })
    const power = payee(k, 'power@upi', 'City Power')
    const b = bill(k, power, 1_100_000, istInstant('2026-12-06', '10:00'))
    const id = start(k, 'bills', { payeeHandles: ['power@upi'], capPerBill: 1_500_000, leadMinutes: 10_080 }, { runMode: 'auto', maxPerRun: 1_500_000, maxPerMonth: 3_000_000, expiresAt: T0 + 60 * DAY })
    // 29 November is inside the week before the due day. The instruction tries, and is refused by the reserve.
    k.clock.set(istInstant('2026-11-29', '10:00'))
    await run(k, 60_000)
    const early = k.db.all<{ state: string; policy_json: string }>(`SELECT state, policy_json FROM actions WHERE program_id = ?`, id)
    expect(early.map((a) => a.state)).toEqual(['blocked'])
    expect((JSON.parse(early[0]!.policy_json) as { checks: { name: string; ok: boolean }[] }).checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['stays-liquid'])
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', b)!.state).toBe('due')
    expect(Number(balance(k.db, k.userId, 'bank'))).toBe(3_500_000)
    // It does not try again the next day. On the bill's own day it tries once more: the bill is owed either way,
    // no day is made worse by paying it, and it is paid.
    k.clock.set(istInstant('2026-11-30', '10:00'))
    await run(k, 30_000)
    expect(k.db.all('SELECT 1 FROM actions WHERE program_id = ?', id).length).toBe(1)
    k.clock.set(istInstant('2026-12-06', '09:00'))
    await run(k, 5 * 60_000, undefined, 30_000)
    const all = k.db.all<{ state: string }>(`SELECT state FROM actions WHERE program_id = ? ORDER BY created_at`, id)
    expect(all.map((a) => a.state)).toEqual(['blocked', 'done'])
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', b)!.state).toBe('paid')
    expect(Number(balance(k.db, k.userId, 'bank'))).toBe(3_500_000 - 1_100_000)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('the owner may dip into the reserve by hand: the document warns, the password is asked, and the check is recorded', async () => {
    const k = thin(20_000_000)
    const shop = payee(k, 'shop@upi', 'A shop')
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 500_000, purpose: 'spend' }) // ₹5,000: under the ₹10,000 password threshold on its own
    expect(pv.requiresStepUp).toBe(false)
    const big = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 900_000 + 2_611_799, purpose: 'spend' })
    expect(big.warnings[0]).toMatch(/is needed for what is due by 6 Jan 2027, allowing for income up to 5 days late and one salary not arriving\. You may do it yourself; QED's instructions may not\./)
    expect(big.requiresStepUp).toBe(true)
    expect(big.document).toMatch(/Bank reserve: /)
    // Approved with the password, having been shown the warning, it goes through, and the record says on what terms.
    expect(() => confirmApproval(k.db, k.userId, big.approvalId, { method: 'session', docHash: big.docHash }, k.clock.now())).toThrow(/Enter your password/)
    confirmApproval(k.db, k.userId, big.approvalId, { method: 'password', docHash: big.docHash }, k.clock.now())
    const a = submitApprovedAction(k.ctx, k.userId, big.approvalId)
    await stepAllActions(k.ctx)
    expect(getAction(k.db, a.id)!.state).not.toBe('blocked')
    const c = getAction(k.db, a.id)!.policy.checks!.find((x) => x.name === 'stays-liquid')!
    expect(c.ok).toBe(true)
    // The hardest day is 6 January; the first day that could not be met is the 5th, when the instalments fall.
    expect(c.detail).toMatch(/must stay for what is due by 6 Jan 2027, .*That would leave ₹6,741\.93 too little for what is due by 5 Jan 2027\. Allowed: you were shown this and approved it yourself\./)
  })

  it('an approval given while the money was free does not cover taking what must stay: prepared twice, the second is refused when it is sent', async () => {
    // ₹10,000 is free. Two payments of ₹9,000 are prepared one after the other; each, on its own, leaves the reserve
    // untouched, so neither document carries a warning. The first is paid. The second would now take ₹8,000 of what
    // must stay, which its owner was never shown: it is not sent.
    const k = thin(17_388_201 + 1_000_000)
    const shop = payee(k, 'shop@upi', 'A shop')
    const one = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 900_000, purpose: 'spend' })
    // ₹8,999 for the second: a payment of the same amount to the same payee within a day is held for confirmation instead (duplicates.ts)
    const two = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 899_900, purpose: 'spend' })
    // neither warns about what must stay: each carries only the first-payment caution (new-payee.ts)
    const first = 'You have not paid this payee before. Check the address with them yourself before you send.'
    expect([one.warnings, two.warnings]).toEqual([[first], [first]])
    for (const pv of [one, two]) confirmApproval(k.db, k.userId, pv.approvalId, { method: 'password', docHash: pv.docHash }, k.clock.now())
    const a1 = submitApprovedAction(k.ctx, k.userId, one.approvalId), a2 = submitApprovedAction(k.ctx, k.userId, two.approvalId)
    await stepAllActions(k.ctx)
    expect(getAction(k.db, a1.id)!.state).not.toBe('blocked')
    const second = getAction(k.db, a2.id)!
    expect(second.state).toBe('blocked')
    const failed = second.policy.checks!.filter((x) => !x.ok)
    expect(failed.map((x) => x.name)).toEqual(['stays-liquid'])
    expect(failed[0]!.detail).toMatch(/When you approved this it left what must stay untouched\. It no longer does, so it was not sent\. Review it again\./)
    expect(Number(balance(k.db, k.userId, 'bank'))).toBe(17_388_201 + 1_000_000 - 900_000)
    // Prepared again, the document now carries the warning and asks for the password.
    const again = await previewAction(k.ctx, k.userId, { kind: 'payment', payeeId: shop, amount: 900_000, purpose: 'spend' })
    expect(again.warnings[0]).toMatch(/You may do it yourself; QED's instructions may not\./)
    expect(again.requiresStepUp).toBe(true)
  })

  it('a change that lowers what must stay needs the password: less spending, smaller instalments, a bill removed', () => {
    const k = makeKit()
    const p = getProfile(k.db, k.userId)
    expect(profileLowersReserve(k.db, k.userId, T0, { ...p, spending: 0 })).toEqual({ before: 17_388_201, after: 6_000_000 })
    expect(profileLowersReserve(k.db, k.userId, T0, { ...p, personalLoanEmi: 0 })).toEqual({ before: 17_388_201, after: 17_388_201 - 2_000_000 })
    // Raising it, or a change that leaves it where it is, does not.
    expect(profileLowersReserve(k.db, k.userId, T0, { ...p, spending: p.spending + 1_000_000 })).toBeNull()
    expect(profileLowersReserve(k.db, k.userId, T0, p)).toBeNull()
    const b = bill(k, payee(k, 'power@upi', 'City Power'), 1_100_000, istInstant('2026-12-01', '10:00'))
    expect(billLowersReserve(k.db, k.userId, T0, b)).toEqual({ before: 17_388_201 + 1_100_000, after: 17_388_201 })
    // A bill due after the hardest day is not in the figure, so removing it changes nothing.
    const far = bill(k, payee(k, 'net@upi', 'Fibre'), 500_000, istInstant('2027-02-20', '10:00'))
    expect(billLowersReserve(k.db, k.userId, T0, far)).toBeNull()
  })

  it('cash parking never parks reserved money, whatever buffer was signed', async () => {
    const k = thin(40_000_000) // ₹4,00,000; ₹1,73,882.01 needed
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    const id = start(k, 'sweep', { instrumentId: 'amfi:118701', keep: 5_000_000, minMove: 1_000_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 60_000_000, maxPerMonth: 200_000_000 })
    await run(k, 65_000)
    expect(runs(k, id)[0]!.state).toBe('done')
    // The signed buffer alone would leave ₹50,000. The reserve keeps ₹1,73,882.01.
    expect(balance(k.db, k.userId, 'bank')).toBe(17_388_201n)
    await run(k, 60_000)
    expect(runs(k, id).at(-1)!.state).toBe('skipped')
  })
})

describe('what signed limits allow, and the largest limit that is safe', () => {
  it('a monthly limit lets twice the limit through in 30 days that span a month end', () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    start(k, 'invest', { instrumentId: 'amfi:118701', amount: 500_000, schedule: { type: 'daily', at: '11:00' } }, { maxPerRun: 500_000, maxPerMonth: 1_000_000, expiresAt: T0 + 90 * DAY })
    const e = authorityEnvelope(k.db, k.userId, T0)
    expect(e.windows).toEqual([{ days: 1, most: 500_000 }, { days: 7, most: 1_000_000 }, { days: 30, most: 2_000_000 }])
  })

  it('sizes a new instruction: the largest monthly limit under which nothing due can fail', () => {
    const k = thin(25_000_000) // ₹2,50,000; ₹1,73,882.01 needed; ₹76,117.99 free
    const a: Authority = { maxPerRun: 1_000_000, maxPerDay: null, maxPerMonth: 3_000_000, expiresAt: T0 + 90 * DAY, runMode: 'auto', noticeSec: 0, maxSlippageBps: 100, maxRuns: null }
    const schedule = { type: 'daily' as const, at: '11:00' }
    // If every run takes ₹10,000, a limit of L a month takes L in November, L in December and L by 6 January:
    // 3 × ₹20,000 fits in ₹76,117.99 and 3 × ₹30,000 does not. By 6 February it has taken 4 L, and that morning needs
    // ₹1,55,333.76 without it: 4 × ₹20,000 still fits in ₹2,50,000 and nothing later is tighter before it ends.
    const high = limitAdvice(k.db, k.userId, T0, a, schedule)
    expect(high.largest).toBe(2_000_000)
    expect(high.holds).toBe(false)
    // At ₹30,000 a month the first debit that could not be met is the instalments of 5 January:
    // 6 January would need ₹1,73,882.01 + ₹90,000; the day before, one day's spending less.
    expect(17_388_201 + 9_000_000 - DEC).toBeGreaterThan(25_000_000)
    expect(17_388_201 + 9_000_000 - 2 * DEC - EMIS).toBeLessThan(25_000_000)
    expect(high.shortOn).toBe('2027-01-05')
    const fits = limitAdvice(k.db, k.userId, T0, { ...a, maxPerMonth: 2_000_000 }, schedule)
    expect(fits.holds).toBe(true)
    expect(fits.shortOn).toBe(null)
    expect(fits.need).toBe(15_533_376 + 8_000_000)
    // The same figures reach the owner: the default limit, the figure on the document and the warning.
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    const d = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'amfi:118701', amount: 1_000_000, schedule }, { expiresAt: T0 + 90 * DAY }, T0)
    expect(d.authority.maxPerMonth).toBe(2_000_000)
    expect(d.analysis.figures.find((f) => f.label.startsWith('Largest monthly limit'))!.value).toBe('₹20,000')
    const over = buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'amfi:118701', amount: 1_000_000, schedule }, { expiresAt: T0 + 90 * DAY, maxPerMonth: 3_000_000 }, T0)
    expect(over.analysis.warnings.join(' ')).toMatch(/could not meet what falls due on 5 Jan 2027, allowing for income up to 5 days late and one salary not arriving\. Runs are refused before that happens\. The largest monthly limit that what is due in the next 150 days can carry, on today's records, is ₹20,000\./)
  })

  it('counts other spending instructions at their limits when sizing a new one, and not the instruction being amended', () => {
    const k = thin(25_000_000)
    k.nav('amfi:118701', '2026-11-17', '7033.4995'); k.nav('amfi:120716', '2026-11-17', '250.1234')
    const a: Authority = { maxPerRun: 1_000_000, maxPerDay: null, maxPerMonth: 3_000_000, expiresAt: T0 + 90 * DAY, runMode: 'auto', noticeSec: 0, maxSlippageBps: 100, maxRuns: null }
    const schedule = { type: 'daily' as const, at: '11:00' }
    const other = start(k, 'invest', { instrumentId: 'amfi:118701', amount: 1_000_000, schedule }, { maxPerRun: 1_000_000, maxPerMonth: 1_000_000, expiresAt: T0 + 90 * DAY })
    const withOther = limitAdvice(k.db, k.userId, T0, a, schedule)
    expect(withOther.largest).toBe(1_000_000) // ₹76,117.99 free, the other may take 3 × ₹10,000, which leaves room for 3 × ₹10,000
    expect(withOther.countedWith.length).toBe(1)
    expect(limitAdvice(k.db, k.userId, T0, a, schedule, other).largest).toBe(2_000_000)
  })
})

describe('the coming weeks of an instruction, day by day', () => {
  it('puts each run on its day, stops where the monthly limit is used up, starts again on the 1st, and ends with the authority', () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '250.1234')
    // Signed on 18 November at 10:30: ₹1,000 every day at 11:00, at most ₹10,000 in a calendar month, until 18 December 10:30.
    const id = start(k, 'invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'daily', at: '11:00' } }, { maxPerRun: 100_000, maxPerMonth: 1_000_000, runMode: 'approve' })
    const c = runCalendar(k.db, k.userId, id, T0)!
    expect(c.days.length).toBe(35)
    expect([c.days[0]!.date, c.days[34]!.date]).toEqual(['2026-11-18', '2026-12-22'])
    const on = (state: string) => c.days.filter((d) => d.state === state).map((d) => d.date.slice(5))
    // ten runs use up November on the 27th; the 28th, 29th and 30th are refused
    expect(on('coming').slice(0, 10)).toEqual(['11-18', '11-19', '11-20', '11-21', '11-22', '11-23', '11-24', '11-25', '11-26', '11-27'])
    expect(on('limit').slice(0, 3)).toEqual(['11-28', '11-29', '11-30'])
    expect([c.limitOn, c.limitBy]).toEqual(['2026-11-28', 'month'])
    expect(c.days.find((d) => d.date === '2026-11-28')).toEqual({ date: '2026-11-28', runs: 0, amount: 0, state: 'limit', by: 'month' })
    // December starts afresh: ten more, then refused from the 11th to the 17th
    expect(on('coming').slice(10)).toEqual(['12-01', '12-02', '12-03', '12-04', '12-05', '12-06', '12-07', '12-08', '12-09', '12-10'])
    expect(on('limit').slice(3)).toEqual(['12-11', '12-12', '12-13', '12-14', '12-15', '12-16', '12-17'])
    // the authority ends at 10:30 on the 18th, before that day's 11:00 run; the days after it are marked as ended
    expect(c.days.find((d) => d.date === '2026-12-18')).toEqual({ date: '2026-12-18', runs: 0, amount: 0, state: 'none' })
    expect(on('ended')).toEqual(['12-19', '12-20', '12-21', '12-22'])
    expect(c.endsOn).toBe('2026-12-18')
    expect([c.runs, c.total, c.perRun, c.fixed, c.asks]).toEqual([20, 2_000_000, 100_000, true, true])
    expect(c.months).toEqual([{ month: '2026-11', limit: 1_000_000, used: 0, scheduled: 1_000_000 }, { month: '2026-12', limit: 1_000_000, used: 0, scheduled: 1_000_000 }])
  })

  it('counts several runs a day and what has already been used this month', async () => {
    const k = thin(80_000_000)
    k.btc(6_600_000)
    // ₹200 every 30 minutes is 48 runs and ₹9,600 on a full day; ₹20,000 a month is used up on the third day.
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 30 } }, { maxPerRun: 20_000, maxPerMonth: 2_000_000 })
    await run(k, 65_000, () => k.btc(6_600_000)) // the first run happens at 10:31
    expect(runs(k, id)[0]!.state).toBe('done')
    const c = runCalendar(k.db, k.userId, id, k.clock.now())!
    expect(c.months[0]).toMatchObject({ month: '2026-11', limit: 2_000_000 })
    expect(c.months[0]!.used).toBeGreaterThan(19_000) // one purchase of about ₹200 is already counted
    expect(c.days[0]!.runs).toBe(26) // 11:01 to 23:31 is 750 minutes: 25 half-hours, so 26 runs; 00:01 belongs to tomorrow
    expect(c.days[1]!).toEqual({ date: '2026-11-19', runs: 48, amount: 960_000, state: 'coming' })
    expect(c.days[2]!.state).toBe('limit')
    expect(c.limitOn).toBe('2026-11-20')
    const november = c.days.filter((d) => d.date < '2026-12-01').reduce((s, d) => s + d.amount, 0)
    expect(november + c.months[0]!.used).toBeLessThanOrEqual(2_000_000)
    expect(2_000_000 - november - c.months[0]!.used).toBeLessThan(20_000) // nothing a further run could use is left over
    expect(c.asks).toBe(false)
  })

  it('names the limit that refuses: the daily one here, which starts again each midnight', () => {
    const k = makeKit()
    k.btc(6_600_000)
    const id = start(k, 'invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 30 } }, { maxPerRun: 20_000, maxPerDay: 100_000, maxPerMonth: 10_000_000 })
    const c = runCalendar(k.db, k.userId, id, T0)!
    expect(c.days[1]).toEqual({ date: '2026-11-19', runs: 5, amount: 100_000, state: 'limit', by: 'day' }) // 48 scheduled, ₹1,000 a day allows 5
    expect(c.days[2]).toEqual({ date: '2026-11-20', runs: 5, amount: 100_000, state: 'limit', by: 'day' })
    expect([c.limitOn, c.limitBy]).toEqual(['2026-11-18', 'day'])
  })

  it('has no calendar for an instruction that waits for an event, or for another owner', () => {
    const k = makeKit()
    payee(k, 'power@upi', 'City Power')
    const bills = start(k, 'bills', { payeeHandles: ['power@upi'], capPerBill: 300_000 }, { runMode: 'notify', noticeSec: 30, maxPerRun: 300_000, maxPerMonth: 1_000_000 })
    expect(runCalendar(k.db, k.userId, bills, T0)).toBeNull()
    k.nav('amfi:120716', '2026-11-17', '250.1234')
    const id = start(k, 'invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'daily', at: '11:00' } }, { maxPerRun: 100_000, maxPerMonth: 1_000_000 })
    expect(runCalendar(k.db, 'usr_other', id, T0)).toBeNull()
  })
})
