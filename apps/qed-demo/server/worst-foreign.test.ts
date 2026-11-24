/**
 * The worst-case figure and money held in other currencies (R13 second pass, item 7). A foreign balance counts at its reference
 * rate less a stated haircut, rounded down; a currency with no reference of a central bank's or a benchmark's (a synthetic
 * cross) counts for nothing; a household with no foreign balance sees no change.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { convertApproved, prepareConversion } from './fx.ts'
import { FOREIGN_HAIRCUT_BPS, foreignHeldWorst } from './foreign-worst.ts'
import { balance } from './ledger.ts'
import { makeKit } from './testkit.ts'
import { worstCase } from './valuation.ts'

const T1 = Date.parse('2026-11-25T05:00:00Z')
const buy = (k: ReturnType<typeof makeKit>, c: string, amount: string) => {
  const q = prepareConversion(k.ctx, k.userId, { sell: 'INR', buy: c, amount, fixed: 'buy' })
  confirmApproval(k.db, k.userId, q.approvalId, { method: 'passkey', docHash: q.docHash }, k.clock.now())
  convertApproved(k.ctx, k.userId, q.approvalId)
}

describe('the worst case with money in other currencies', () => {
  it('is unchanged for a household with none', () => {
    const k = makeKit({ start: T1 })
    const w = worstCase(k.db, k.market, k.userId, k.clock.now())
    expect(w.parts.map((p) => p.label)).not.toContain('Money held in other currencies')
    expect(w.foreign).toBe(0)
  })

  it('counts a dollar balance at its reference rate less the stated haircut, rounded down, and says so', () => {
    const k = makeKit({ start: T1 })
    const before = worstCase(k.db, k.market, k.userId, k.clock.now())
    buy(k, 'USD', '1000.00')
    const bankDrop = before.cash - Number(balance(k.db, k.userId, 'bank'))
    const w = worstCase(k.db, k.market, k.userId, k.clock.now())
    // USD 1,000.00 at the recorded FBIL rate 93.3558 is 93,355.80 rupees; the haircut keeps (10000 - haircut)/10000 of it
    const atReference = 9_335_580n
    const counted = (atReference * BigInt(10_000 - FOREIGN_HAIRCUT_BPS)) / 10_000n
    expect(w.foreign).toBe(Number(counted))
    expect(w.gHat).toBe(before.gHat - bankDrop + Number(counted))
    const part = w.parts.find((p) => p.label === 'Money held in other currencies')!
    expect(part.amount).toBe(Number(counted))
    expect(part.note).toMatch(new RegExp(`${FOREIGN_HAIRCUT_BPS / 100}%`))
    expect(part.note).toMatch(/reference rate/)
    // the whole point of a haircut: counting it leaves the household worse off than the rupees it paid
    expect(Number(counted)).toBeLessThan(9_335_580)
    expect(foreignHeldWorst(k.db, k.market, k.userId, k.clock.now()).lines[0]).toMatchObject({ currency: 'USD', counted: counted.toString() })
  })

  it('counts a synthetic cross for nothing, and says which currency and why', () => {
    const k = makeKit({ start: T1 })
    buy(k, 'AED', '1000.00')
    const f = foreignHeldWorst(k.db, k.market, k.userId, k.clock.now())
    expect(f.total).toBe(0n)
    expect(f.lines[0]).toMatchObject({ currency: 'AED', counted: '0' })
    expect(f.lines[0]!.why).toMatch(/synthetic/)
    const w = worstCase(k.db, k.market, k.userId, k.clock.now())
    expect(w.parts.find((p) => p.label === 'Money held in other currencies')!.note).toMatch(/Not counted: AED/)
  })

  it('counts the dinar, whose rate is from its central bank\'s decree (but still with the haircut)', () => {
    const k = makeKit({ start: T1 })
    buy(k, 'BHD', '10.000')
    const f = foreignHeldWorst(k.db, k.market, k.userId, k.clock.now())
    expect(f.lines[0]!.currency).toBe('BHD')
    expect(BigInt(f.lines[0]!.counted)).toBeGreaterThan(0n)
  })
})
