/**
 * One duplicate-hold rule for domestic and cross-border payments (R13 second pass, item 5). The rule lives in duplicates.ts;
 * abroad.ts uses it. Each side keeps its stricter behaviour: the window's edge counts (the domestic rule), and the check is
 * made again at the moment of paying (the cross-border rule).
 */
import { describe, expect, it } from 'vitest'
import { addAbroadPayee, DUPLICATE_WINDOW_MS as ABROAD_WINDOW, payAbroad, prepareAbroad } from './abroad.ts'
import { confirmApproval } from './approvals.ts'
import { DUPLICATE_RULE, DUPLICATE_WINDOW_MS, repeatsEarlier } from './duplicates.ts'
import { makeKit } from './testkit.ts'

const T1 = Date.parse('2026-11-25T05:00:00Z')
const HOUR = 3_600_000

describe('the shared repeat predicate', () => {
  const a = { payee: 'p', amount: '100', at: 1_000, id: 'a' }
  it('is the same payee, the same amount, the earlier one no more than 24 hours before, the edge included', () => {
    expect(repeatsEarlier(a, { ...a, id: 'b', at: 1_000 + DUPLICATE_WINDOW_MS })).toBe(true)
    expect(repeatsEarlier(a, { ...a, id: 'b', at: 1_000 + DUPLICATE_WINDOW_MS + 1 })).toBe(false)
    expect(repeatsEarlier(a, { ...a, id: 'b', amount: '101', at: 2_000 })).toBe(false)
    expect(repeatsEarlier(a, { ...a, id: 'b', payee: 'q', at: 2_000 })).toBe(false)
  })
  it('is a total order: of two asked for at one moment, exactly one is the repeat', () => {
    const b = { ...a, id: 'b' }
    expect([repeatsEarlier(a, b), repeatsEarlier(b, a)].filter(Boolean)).toHaveLength(1)
    expect(repeatsEarlier(a, { ...a })).toBe(false) // never a repeat of itself
    expect(repeatsEarlier({ ...a, at: 5_000 }, { ...a, id: 'b', at: 4_000 })).toBe(false) // the earlier one must be earlier
  })
  it('is one window: abroad.ts uses duplicates.ts\'s', () => { expect(ABROAD_WINDOW).toBe(DUPLICATE_WINDOW_MS) })
})

describe('a payment abroad held by the shared rule', () => {
  const setup = () => {
    const k = makeKit({ start: T1 })
    const p = addAbroadPayee(k.db, k.userId, { name: 'Anita Rao', country: 'US', currency: 'USD', routing: '021000021', account: '123456789' }, k.clock.now())
    const ask = (extra: object = {}) => prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '100.00', purpose: 'gift', from: 'INR', ...extra })
    const pay = (pv: { approvalId: string; docHash: string }) => { confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now()); return payAbroad(k.ctx, k.userId, pv.approvalId) }
    return { k, p, ask, pay }
  }
  it('holds a payment exactly 24 hours later, as the domestic rule does (the edge counts); not one millisecond after', () => {
    const { k, ask, pay } = setup()
    pay(ask())
    k.clock.advance(24 * HOUR)
    expect(() => ask()).toThrow(expect.objectContaining({ code: 'held_duplicate' }))
    k.clock.advance(1)
    expect(ask().approvalId).toBeTruthy()
  })
  it('says the same rule in the same words as the domestic hold', () => {
    const { k, ask, pay } = setup()
    pay(ask())
    k.clock.advance(HOUR)
    expect(() => ask()).toThrow(/the same payee and the same amount within 24 hours/)
    expect(DUPLICATE_RULE).toMatch(/the same payee and the same amount within 24 hours/)
  })
})
