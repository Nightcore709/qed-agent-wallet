/**
 * A goal in another currency (R13 section 7, Save): a target held in a foreign balance, its progress counted in that
 * currency at its own precision, and what is left and a month's share also in rupees at a named reference rate (an
 * estimate, never a price). It moves no money: the owner changes money into the currency at a quote to fund it.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { addFxGoal, fxGoalsView, removeFxGoal } from './fx-goals.ts'
import { convertApproved, prepareConversion } from './fx.ts'
import { makeKit } from './testkit.ts'

const T1 = Date.parse('2026-11-25T05:00:00Z') // Wednesday 25 Nov 2026, 10:30 IST

describe('a goal in another currency', () => {
  it('counts what is held in the currency toward its target, and says the rest in rupees at a named reference rate', () => {
    const k = makeKit({ start: T1 })
    const g = addFxGoal(k.db, k.userId, { name: 'Kyoto in spring', currency: 'JPY', target: '300000', by: '2027-04-01' }, k.clock.now())
    expect(g).toMatchObject({ name: 'Kyoto in spring', currency: 'JPY', target_text: '300000', by_date: '2027-04-01' })
    const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: 'JPY', amount: '50000', fixed: 'buy' })
    confirmApproval(k.db, k.userId, q.approvalId, { method: 'passkey', docHash: q.docHash }, k.clock.now())
    convertApproved(k.ctx, k.userId, q.approvalId)
    const [v] = fxGoalsView(k.ctx, k.userId).goals
    expect(v).toMatchObject({ currency: 'JPY', targetText: 'JPY 3,00,000', heldText: 'JPY 50,000', leftText: 'JPY 2,50,000', monthsLeft: 5, perMonthText: 'JPY 50,000', status: 'on-the-way', byText: '1 Apr 2027' })
    expect(v!.progressPermille).toBe(166) // 50,000 of 3,00,000, rounded down
    // 2,50,000 yen at the recorded FBIL reference, 0.586 rupees a yen: about ₹1,46,500.00
    expect(v!.leftInRupees).toMatchObject({ text: '₹1,46,500.00', rate: '0.586', label: 'historical' })
    expect((v!.leftInRupees as { source: string }).source).toMatch(/FBIL/)
    expect(v!.words).toMatch(/moves no money/)
  })

  it('refuses a rupee goal here, a second goal in the same currency, a past or distant date, and a target of nothing', () => {
    const k = makeKit({ start: T1 })
    expect(() => addFxGoal(k.db, k.userId, { name: 'Rent', currency: 'INR', target: '1000.00', by: '2027-01-01' }, k.clock.now())).toThrow(/rupees/)
    expect(() => addFxGoal(k.db, k.userId, { name: 'Trip', currency: 'BHD', target: '1.2345', by: '2027-01-01' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => addFxGoal(k.db, k.userId, { name: 'Trip', currency: 'USD', target: '0', by: '2027-01-01' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => addFxGoal(k.db, k.userId, { name: 'Trip', currency: 'USD', target: '10.00', by: '2026-11-24' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => addFxGoal(k.db, k.userId, { name: 'Trip', currency: 'USD', target: '10.00', by: '2029-01-01' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid' }))
    const g = addFxGoal(k.db, k.userId, { name: 'Trip', currency: 'BHD', target: '120.500', by: '2027-01-01' }, k.clock.now())
    expect(() => addFxGoal(k.db, k.userId, { name: 'Other', currency: 'BHD', target: '1.000', by: '2027-01-01' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'exists' }))
    removeFxGoal(k.db, k.userId, g.id, k.clock.now())
    expect(fxGoalsView(k.ctx, k.userId).goals).toHaveLength(0)
    expect(addFxGoal(k.db, k.userId, { name: 'Other', currency: 'BHD', target: '1.000', by: '2027-01-01' }, k.clock.now()).currency).toBe('BHD')
  })
})
