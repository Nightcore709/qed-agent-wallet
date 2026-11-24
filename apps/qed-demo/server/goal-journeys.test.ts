/**
 * Savings goals as complete financial journeys (R13 section 4):
 *
 *   - goal funds never also count as spendable cash or fund another commitment (bills, instructions, a payment by hand,
 *     the idle-cash sweep);
 *   - goal protection stays distinct from the reserve kept for what falls due, while both reconcile to total assets;
 *   - releasing protected funds needs the owner's passkey approval of its exact terms, used once;
 *   - contributions and progress come from actual balances, dates and disclosed assumptions;
 *   - "ask me each time" and any explicitly approved automation apply consistently; nothing broadens authority.
 *
 * The first part is a model-based property: random sequences of what a household does over months (time passing with
 * the engine running, a contribution approved or declined, money set aside by hand, a release, spending and paying a bill
 * by hand), with every invariant above checked after every step (fast-check, fixed seed). The second part gives each
 * claim a deterministic case, and the third shows the reconciliation in figures.
 */
import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { confirmApproval, getApproval } from './approvals.ts'
import { bankTick } from './bank.ts'
import { istInstant, parse } from './core.ts'
import { stepAllActions } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { available, balance, heldAmount, listAccounts, verifyLedger } from './ledger.ts'
import { liquidity } from './liquidity.ts'
import { addBill, addPayee, previewAction, submitApprovedAction } from './owner.ts'
import { checkPayeeName } from './name-check.ts'
import { haveTotal, oweTotal } from '../src/lib/sheet.ts'

/** The payee check acknowledged as the owner would after seeing it (R13: anything but a match needs that confirmation). */
const ack = (name: string, handle: string): { nameCheckAccepted?: string } => { const o = checkPayeeName(name, handle).outcome; return o === 'match' ? {} : { nameCheckAccepted: o } }
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { sha256hex, verifyChain } from './receipts.ts'
import { cancelRun, requestRunApproval, runTick, schedulerTick, triggerTick } from './runner.ts'
import { goalView, prepareRelease, releaseSetAside } from './goals.ts'
import { goalAccount, onItsWay } from './setaside.ts'
import { type Kit, makeKit } from './testkit.ts'
import type { Authority } from './types.ts'
import { overview } from './valuation.ts'

const DAY = 86_400_000

async function cycle(k: Kit): Promise<void> {
  bankTick(k.ctx)
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.rail.tick(); await k.venues.crypto.tick(); await k.venues.funds.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
async function at(k: Kit, when: number): Promise<void> { k.clock.advance(Math.max(0, when - k.clock.now())); await cycle(k); await cycle(k) }
/**
 * Time passing with the engine running all along: the clock stops at each instruction's next run (a run more than a minute
 * late is missed, as when the engine was not running), at each bank event's day, and at the end.
 */
async function runUntil(k: Kit, when: number): Promise<void> {
  for (let i = 0; i < 400 && k.clock.now() < when; i++) {
    const due = k.db.get<{ t: number | null }>(`SELECT MIN(next_due_at) t FROM programs WHERE state = 'active' AND next_due_at > ? AND next_due_at <= ?`, k.clock.now(), when)?.t ?? null
    k.clock.set(due !== null ? due + 1000 : Math.min(when, k.clock.now() + DAY))
    await cycle(k); await cycle(k)
  }
}
function sign(k: Kit, programId: string): void {
  const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
  confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
  activateProgram(k.ctx, k.userId, programId, req.approvalId)
}
function goal(k: Kit, params: Record<string, unknown>, authority: Partial<Authority> = {}): string {
  const d = saveDraft(k.ctx, k.userId, { kind: 'goal', params, authority })
  sign(k, d.programId)
  return d.programId
}
/** A payment by hand, approved with the passkey and sent; returns false when it was refused at once. */
async function byHand(k: Kit, what: Record<string, unknown>): Promise<boolean> {
  let pv: Awaited<ReturnType<typeof previewAction>>
  try { pv = await previewAction(k.ctx, k.userId, what) } catch { return false }
  confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  try { submitApprovedAction(k.ctx, k.userId, pv.approvalId) } catch { return false }
  await cycle(k); k.clock.advance(3000); await cycle(k)
  return true
}
async function release(k: Kit, goalId: string, amount: number): Promise<void> {
  const p = prepareRelease(k.ctx, k.userId, goalId, { amount })
  // not confirmed, or confirmed without a passkey: nothing moves
  expect(() => releaseSetAside(k.ctx, k.userId, goalId, p.approvalId)).toThrow(/Confirm the approval with your passkey first/)
  expect(() => confirmApproval(k.db, k.userId, p.approvalId, { method: 'session', docHash: p.docHash }, k.clock.now())).toThrow(/password/)
  confirmApproval(k.db, k.userId, p.approvalId, { method: 'passkey', docHash: p.docHash }, k.clock.now())
  releaseSetAside(k.ctx, k.userId, goalId, p.approvalId)
  // once: the same approval releases nothing more
  expect(() => releaseSetAside(k.ctx, k.userId, goalId, p.approvalId)).toThrow(/already been used/)
}

/** What the random runs did, summed over every run: the property must be shown to reach each path it claims to check. */
const reached = { contributionsByInstruction: 0, contributionsAsked: 0, byHand: 0, releases: 0, declined: 0, refusedByHand: 0, lapsed: 0, steps: 0 }
/**
 * Every invariant, checked on the state as it stands. Returns nothing; fails the test at the first that does not hold.
 */
function invariants(k: Kit, goals: string[]): void {
  const { db, userId } = k
  const now = k.clock.now()
  // the books and the receipts are sound
  expect(verifyLedger(db, userId)).toEqual([])
  expect(verifyChain(db, userId).ok).toBe(true)

  // 1. only two things ever post to a set-aside: a contribution settling into its own goal, and a release the owner
  // approved with the passkey, once, for exactly what was released
  const touching = db.all<{ entry: string; kind: string; meta: string; code: string; amount: string; ts: number }>(
    `SELECT e.id entry, e.kind, e.meta_json meta, a.code, p.amount_text amount, e.ts FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND a.code LIKE 'goal:%'`, userId)
  for (const t of touching) {
    const goalId = t.code.slice('goal:'.length)
    const meta = parse<{ actionId?: string; purpose?: string; approvalId?: string; goalId?: string }>(t.meta, {})
    const amount = BigInt(t.amount)
    if (t.kind === 'payment-settled') {
      expect(amount > 0n, 'a contribution adds to the set-aside').toBe(true)
      const act = db.get<{ params_json: string; program_id: string | null; origin: string; run_id: string | null; created_at: number }>('SELECT params_json, program_id, origin, run_id, created_at FROM actions WHERE id = ?', meta.actionId ?? '')!
      const p = parse<{ purpose?: string; goalId?: string; amount?: string }>(act.params_json, {})
      expect([p.purpose, p.goalId], 'a contribution names this goal').toEqual(['goal', goalId])
      if (act.origin === 'program') {
        expect(act.program_id, 'an instruction moves money only into its own set-aside').toBe(goalId)
        // 5. ask me each time: a contribution of an instruction that asks first was approved with the passkey before it was made
        const run = db.get<{ version: number }>('SELECT version FROM runs WHERE id = ?', act.run_id ?? '')!
        const auth = parse<Authority>(db.get<{ authority_json: string }>('SELECT authority_json FROM program_versions WHERE program_id = ? AND version = ?', goalId, run.version)!.authority_json, {} as Authority)
        if (auth.runMode !== 'auto') {
          const ap = db.get<{ method: string; confirmed_at: number }>(`SELECT method, confirmed_at FROM approvals WHERE subject = ? AND confirmed_at IS NOT NULL ORDER BY confirmed_at LIMIT 1`, `run:${act.run_id}`)
          expect(ap, 'a contribution that asks first was approved').toBeDefined()
          expect(ap!.method).toBe('passkey')
          expect(ap!.confirmed_at).toBeLessThanOrEqual(act.created_at)
        }
      }
    } else if (t.kind === 'goal-release') {
      expect(amount < 0n, 'a release takes from the set-aside').toBe(true)
      const ap = getApproval(db, userId, meta.approvalId ?? '')!
      expect(ap).toMatchObject({ purpose: 'goal-release', requires_stepup: 1, method: 'passkey' })
      expect(ap.consumed_at).toBe(t.ts)
      const doc = JSON.parse(ap.document) as { goalId: string; sizePaise: number }
      expect([doc.goalId, BigInt(doc.sizePaise)]).toEqual([goalId, -amount])
      expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM entries WHERE user_id = ? AND kind = 'goal-release' AND json_extract(meta_json, '$.approvalId') = ?`, userId, ap.id)!.n).toBe(1)
    } else throw new Error(`entry ${t.entry} (${t.kind}) touched ${t.code}: nothing else may`)
  }

  // 2. progress comes from the books: the set-aside is the ledger's balance, on its way is what is in flight for it
  for (const g of goals) {
    const v = goalView(db, userId, g, now)
    if (!v) continue
    expect(v.setAside).toBe(Number(balance(db, userId, goalAccount(g))))
    expect(v.onItsWay).toBe(onItsWay(db, userId, g))
    if (v.growthBps === 0 && v.status !== 'reached') expect(v.projected).toBe(v.setAside + v.onItsWay + v.scheduled.amount)
  }

  // 3. free to use is bank money only: never the set-aside, and it reconciles with what is held and what must stay
  const o = overview(db, k.market, userId, now)
  const l = liquidity(db, userId, now)
  expect(l.available).toBe(Number(available(db, userId, 'bank')))
  expect(l.available + o.bankHeld).toBe(o.bank)
  expect(o.freeToUse).toBe(Math.max(0, l.available - l.need))
  expect(o.freeToUse).toBeLessThanOrEqual(l.available)

  // 4. the reconciliation: every rupee of the household's own in the books is in exactly one of the parts the wallet shows
  const inr = listAccounts(db, userId).filter((a) => a.asset === 'INR' && (a.kind === 'asset' || a.kind === 'clearing')).reduce((s, a) => s + BigInt(a.raw_text), 0n)
  const parts = BigInt(o.bank) + BigInt(o.setAside) + BigInt(o.paymentsInProgress) + BigInt(o.inTransit) + BigInt(o.deposits) + balance(db, userId, 'tds')
  expect(parts).toBe(inr)
  const bankParts = BigInt(Math.min(l.need, l.available)) + BigInt(Math.max(0, l.available - l.need)) + heldAmount(db, userId, 'bank')
  expect(bankParts).toBe(BigInt(o.bank))
}

describe('a household\'s goals over months: every invariant after every step', () => {
  const op = fc.oneof(
    { weight: 4, arbitrary: fc.record({ t: fc.constant('time' as const), minutes: fc.integer({ min: 1, max: 40 * 1440 }) }) },
    { weight: 4, arbitrary: fc.record({ t: fc.constant('next' as const) }) },
    { weight: 3, arbitrary: fc.record({ t: fc.constant('approve' as const), g: fc.nat(1) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('decline' as const), g: fc.nat(1) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('aside' as const), g: fc.nat(1), rupees: fc.integer({ min: 1, max: 40_000 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('release' as const), g: fc.nat(1), share: fc.integer({ min: 1, max: 100 }) }) },
    { weight: 2, arbitrary: fc.record({ t: fc.constant('spend' as const), rupees: fc.integer({ min: 100, max: 900_000 }) }) },
    { weight: 1, arbitrary: fc.record({ t: fc.constant('bill' as const), rupees: fc.integer({ min: 100, max: 60_000 }) }) },
  )

  it('property: contributions asked for or automatic, set aside by hand, released with the passkey, spending and bills by hand', async () => {
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 4, maxLength: 18 }), fc.boolean(), async (ops, autoFirst) => {
      const k = makeKit()
      // one goal that asks each time (the default) and one the owner signed to run by itself, in either order
      const asks = goal(k, { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' })
      const auto = goal(k, { name: 'New laptop', target: 8_000_000, date: '2027-06-30' }, { runMode: 'auto' })
      const goals = autoFirst ? [auto, asks] : [asks, auto]
      const payee = addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utilities', ...ack('City Power', 'power@upi') }, k.clock.now())
      invariants(k, goals)
      for (const o of ops) {
        reached.steps++
        const g = 'g' in o ? goals[o.g]! : ''
        if (o.t === 'time') await runUntil(k, k.clock.now() + o.minutes * 60_000)
        else if (o.t === 'next') {
          // to the next run of either goal, and stop there: a run that asks is then waiting for an answer
          const due = k.db.get<{ t: number | null }>(`SELECT MIN(next_due_at) t FROM programs WHERE state = 'active' AND next_due_at > ?`, k.clock.now())?.t ?? null
          if (due !== null) await runUntil(k, due + 1000)
        }
        else if (o.t === 'approve' || o.t === 'decline') {
          const r = k.db.get<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'awaiting_approval' ORDER BY created_at LIMIT 1`, g)
          if (r && o.t === 'decline') { cancelRun(k.ctx, k.userId, r.id); reached.declined++ }
          else if (r) {
            try {
              const req = requestRunApproval(k.ctx, k.userId, r.id)
              confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: req.docHash }, k.clock.now())
            } catch { /* lapsing: nothing is approved */ }
            await cycle(k); await cycle(k)
          }
        } else if (o.t === 'aside') { if (await byHand(k, { kind: 'payment', purpose: 'goal', goalId: g, amount: o.rupees * 100 })) reached.byHand++ }
        else if (o.t === 'release') {
          const have = Number(balance(k.db, k.userId, goalAccount(g)))
          if (have > 0) { await release(k, g, Math.max(1, Math.floor((have * o.share) / 100))); reached.releases++ }
        } else if (o.t === 'spend') { if (!(await byHand(k, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: o.rupees * 100, acknowledge: { intoReserve: true, belowFloor: true } }))) reached.refusedByHand++ }
        else if (o.t === 'bill') {
          const bill = addBill(k.db, k.userId, { payeeId: payee.id, amount: o.rupees * 100, dueAt: k.clock.now() + 3 * DAY, memo: 'Electricity' }, k.clock.now())
          await byHand(k, { kind: 'payment', purpose: 'bill', billId: bill.id, amount: o.rupees * 100 })
        }
        invariants(k, goals)
      }
      reached.contributionsByInstruction += k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'program' AND state = 'done' AND program_id = ?`, auto)!.n
      reached.contributionsAsked += k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM actions WHERE origin = 'program' AND state = 'done' AND program_id = ?`, asks)!.n
      reached.lapsed += k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM runs WHERE state = 'expired'`)!.n
    }), { seed: 1311, numRuns: 25 })
    console.info(`[goal journeys] ${JSON.stringify(reached)}`)
    // each path the invariants speak of was reached at least once
    for (const [path, n] of Object.entries(reached)) expect(n, path).toBeGreaterThan(0)
  }, 300_000)
})

describe('goal money funds nothing else', () => {
  /** A household whose bank holds less than a bill while a set-aside holds more than it. */
  async function setAsideRich() {
    const k = makeKit({ opening: { ...DEFAULT_OPENING, bank: 6_000_000 }, profile: { line: 0, spending: 0, personalLoanEmi: 0, homeLoanEmi: 0 } })
    const g = goal(k, { name: 'School fees', target: 5_000_000, date: '2027-06-30' })
    expect(await byHand(k, { kind: 'payment', purpose: 'goal', goalId: g, amount: 5_000_000 })).toBe(true)
    expect(balance(k.db, k.userId, goalAccount(g))).toBe(5_000_000n)
    expect(balance(k.db, k.userId, 'bank')).toBe(1_000_000n)
    return { k, g }
  }

  it('a payment by hand, a registered bill, an instruction\'s run and the idle-cash sweep: none of them reaches the set-aside', async () => {
    const { k, g } = await setAsideRich()
    const payee = addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family', ...ack('Ravi Kumar', 'ravi.kumar@upi') }, k.clock.now())
    // by hand: ₹20,000 is more than the bank's ₹10,000, though the set-aside holds ₹50,000
    await byHand(k, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 2_000_000, acknowledge: { intoReserve: true, belowFloor: true } })
    const spent = k.db.get<{ state: string; error: string | null }>(`SELECT state, error FROM actions WHERE json_extract(params_json, '$.payeeHandle') = 'ravi.kumar@upi'`)
    expect(spent?.state ?? 'refused').not.toBe('done')
    // a registered bill of ₹20,000, paid by hand
    const bill = addBill(k.db, k.userId, { payeeId: payee.id, amount: 2_000_000, dueAt: k.clock.now() + 2 * DAY, memo: 'Rent' }, k.clock.now())
    await byHand(k, { kind: 'payment', purpose: 'bill', billId: bill.id, amount: 2_000_000 })
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', bill.id)!.state).toBe('due')
    // an instruction that buys ₹20,000 of a fund by itself, every five minutes
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const inv = saveDraft(k.ctx, k.userId, { kind: 'invest', params: { instrumentId: 'amfi:120716', amount: 2_000_000, schedule: { type: 'every', minutes: 5 } }, authority: { expiresAt: k.clock.now() + 10 * DAY, runMode: 'auto', maxPerRun: 2_000_000, maxPerMonth: 20_000_000 } })
    sign(k, inv.programId)
    // the idle-cash sweep, keeping nothing, by itself
    k.nav('amfi:118701', '2026-11-17', '5400.12')
    const sw = saveDraft(k.ctx, k.userId, { kind: 'sweep', params: { instrumentId: 'amfi:118701', keep: 0, minMove: 100_000, schedule: { type: 'every', minutes: 5 } }, authority: { expiresAt: k.clock.now() + 10 * DAY, runMode: 'auto', maxPerRun: 20_000_000, maxPerMonth: 20_000_000 } })
    sign(k, sw.programId)
    await at(k, k.clock.now() + 11 * 60_000)
    // the set-aside is untouched by all four, and no entry other than its own contribution touched it
    expect(balance(k.db, k.userId, goalAccount(g))).toBe(5_000_000n)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.code = ?`, goalAccount(g))!.n).toBe(1)
    // whatever the instructions did, they did it with bank money: the bank never went below zero and the books are sound
    expect(balance(k.db, k.userId, 'bank') >= 0n).toBe(true)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    // the owner can pay the bill once they release the money, with the passkey
    await release(k, g, 2_000_000)
    expect(await byHand(k, { kind: 'payment', purpose: 'bill', billId: bill.id, amount: 2_000_000 })).toBe(true)
    // the bill's payee is new, so a payment this large waits out the first-day hold (R13 section 4) before it is sent
    k.clock.advance(25 * 3600_000); await cycle(k); k.clock.advance(3000); await cycle(k)
    expect(k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', bill.id)!.state).toBe('paid')
  })

  it('free to use never counts the set-aside, and moving money into it lowers what is free by exactly that much', async () => {
    const k = makeKit()
    const g = goal(k, { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' })
    const before = liquidity(k.db, k.userId, k.clock.now())
    expect(await byHand(k, { kind: 'payment', purpose: 'goal', goalId: g, amount: 1_000_000 })).toBe(true)
    const after = liquidity(k.db, k.userId, k.clock.now())
    expect(before.available - after.available).toBe(1_000_000)
    expect(after.need).toBe(before.need) // what must stay for what is due is the same: the set-aside does not cover it
    expect(overview(k.db, k.market, k.userId, k.clock.now()).setAside).toBe(1_000_000)
  })
})

describe('"ask me each time" and automation, applied consistently', () => {
  it('a goal that asks first moves nothing without an approval, lapses unanswered, and is not made automatic by an amendment', async () => {
    const k = makeKit()
    const g = goal(k, { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' })
    await at(k, istInstant('2026-12-02', '10:00') + 1000)
    expect(k.db.all<{ state: string }>('SELECT state FROM runs WHERE program_id = ?', g).map((r) => r.state)).toEqual(['awaiting_approval'])
    await at(k, istInstant('2026-12-03', '10:01'))
    expect(k.db.all<{ state: string }>('SELECT state FROM runs WHERE program_id = ?', g).map((r) => r.state)).toEqual(['expired'])
    expect(balance(k.db, k.userId, goalAccount(g))).toBe(0n)
    // a remedy re-signed with no mode said keeps asking: the default never turns into running by itself
    const v = goalView(k.db, k.userId, g, k.clock.now())!
    const d = saveDraft(k.ctx, k.userId, { programId: g, params: { name: v.name, target: v.target, date: v.date, schedule: { type: 'monthly', day: v.day, at: '10:00' }, growthBps: 0 }, authority: {} })
    expect((d.draft.authority as Authority).runMode).toBe('approve')
    // and a goal signed to run by itself, amended without saying, asks again rather than keeping the wider authority
    const a = goal(k, { name: 'New laptop', target: 8_000_000, date: '2027-06-30' }, { runMode: 'auto' })
    const va = goalView(k.db, k.userId, a, k.clock.now())!
    const da = saveDraft(k.ctx, k.userId, { programId: a, params: { name: va.name, target: va.target, date: va.date, schedule: { type: 'monthly', day: va.day, at: '10:00' }, growthBps: 0 }, authority: {} })
    expect((da.draft.authority as Authority).runMode).toBe('approve')
  })
})

describe('the reconciliation, in figures', () => {
  it('goal protection, what must stay for what is due, what is free and what is in flight add up to the household\'s own money', async () => {
    const k = makeKit()
    const g = goal(k, { name: 'Holiday in Goa', target: 5_000_000, date: '2027-03-31' }, { runMode: 'auto' })
    await at(k, istInstant('2026-12-02', '10:00') + 1000) // one contribution of ₹12,500 settled
    expect(await byHand(k, { kind: 'payment', purpose: 'goal', goalId: g, amount: 300_000 })).toBe(true)
    // a fund purchase waiting for its units, a payment still on the rail and a bill due: each in its own part
    k.nav('amfi:120716', '2026-12-01', '180.0000')
    await byHand(k, { kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 1_000_000 })
    const payee = addPayee(k.db, k.userId, { name: 'Slow Payee', handle: 'slow@paper', category: 'other', ...ack('Slow Payee', 'slow@paper') }, k.clock.now())
    await byHand(k, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 250_000 })
    addBill(k.db, k.userId, { payeeId: payee.id, amount: 400_000, dueAt: k.clock.now() + 4 * DAY, memo: 'Water' }, k.clock.now())
    const now = k.clock.now()
    const o = overview(k.db, k.market, k.userId, now), l = liquidity(k.db, k.userId, now)
    const covered = Math.min(l.need, l.available)
    const parts = { free: l.free, mustStay: covered, short: l.short, held: o.bankHeld, setAside: o.setAside, paymentsInProgress: o.paymentsInProgress, fundMoneyInTransit: o.inTransit, deposits: o.deposits, taxCredit: Number(balance(k.db, k.userId, 'tds')) }
    const total = listAccounts(k.db, k.userId).filter((a) => a.asset === 'INR' && (a.kind === 'asset' || a.kind === 'clearing')).reduce((s, a) => s + Number(a.raw_text), 0)
    expect(parts.free + parts.mustStay + parts.held + parts.setAside + parts.paymentsInProgress + parts.fundMoneyInTransit + parts.deposits + parts.taxCredit).toBe(total)
    expect(parts.setAside).toBe(1_550_000) // ₹12,500 by the instruction and ₹3,000 by hand
    expect(parts.paymentsInProgress).toBe(250_000) // slow@paper stays on the rail for 90 seconds
    expect(parts.fundMoneyInTransit).toBe(1_000_000)
    // the record of this run, for the findings: the parts and the total, in paise
    console.info(`[reconciliation] ${JSON.stringify({ ...parts, total, need: l.need, available: l.available, bank: o.bank })}`)
  })
})

describe('the net position reconciles with the parts the wallet shows', () => {
  it('every part of what the household has, tax already deducted included, less what it owes, is the net position (R13: reconcile to total assets)', async () => {
    const k = makeKit({ profile: { line: 0 } })
    k.btc(6_600_000)
    // a sale of bitcoin leaves tax deducted at source (1%): money the household has, as a credit against its tax
    expect(await byHand(k, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 2_000_000 })).toBe(true)
    k.btc(6_600_000)
    expect(balance(k.db, k.userId, 'pos:coindcx:BTCINR')).toBeGreaterThan(0n)
    expect(await byHand(k, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'sell', sellAll: true })).toBe(true)
    const tds = Number(balance(k.db, k.userId, 'tds'))
    expect(tds).toBeGreaterThan(0)
    const o = overview(k.db, k.market, k.userId, k.clock.now())
    // the overview names the tax credit, so a screen that lists what the household has can show it (Home's sheet lists
    // bank, investments, fund money, deposits and set-asides; the net position counts the tax credit as well)
    expect(o.taxCredit).toBe(tds)
    expect(o.bank + o.deposits + o.setAside + o.holdingsValue + o.inTransit + o.paymentsInProgress + o.taxCredit - o.card - o.loans).toBe(o.netWorth)
  })

  it("Home's sheet: what it lists as had, less what it lists as owed, is the net position, with the tax credit and a payment on the rail each in its own row (QA hand-back)", async () => {
    const k = makeKit({ profile: { line: 0 } })
    k.btc(6_600_000)
    expect(await byHand(k, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 2_000_000 })).toBe(true)
    k.btc(6_600_000)
    expect(await byHand(k, { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'sell', sellAll: true })).toBe(true)
    const payee = addPayee(k.db, k.userId, { name: 'Slow Payee', handle: 'slow@paper', category: 'other', ...ack('Slow Payee', 'slow@paper') }, k.clock.now())
    await byHand(k, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 250_000 })
    const o = overview(k.db, k.market, k.userId, k.clock.now())
    expect(o.taxCredit).toBeGreaterThan(0)
    expect(o.paymentsInProgress).toBe(250_000)
    expect(haveTotal(o) - oweTotal(o)).toBe(o.netWorth)
    // the sheet shows both rows exactly when they are non-zero
    const home = readFileSync(new URL('../src/screens/Home.tsx', import.meta.url), 'utf8')
    expect(home).toMatch(/o\.paymentsInProgress > 0 \? <SheetRow name=\{<Link to="\/activity">Payments in progress/)
    expect(home).toMatch(/o\.taxCredit > 0 \? <SheetRow name="Tax already deducted"/)
    expect(home).toContain('haveTotal(o)')
  })
})
