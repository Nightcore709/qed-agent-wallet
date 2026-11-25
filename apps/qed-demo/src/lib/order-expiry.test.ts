import { describe, expect, it } from 'vitest'
import { expiredLine, standsUntilLine } from './order-expiry.ts'

const at = Date.parse('2026-11-18T05:30:00Z') // 11:00 IST
const base = { kind: 'order' as const, params: { type: 'limit', validity: { kind: 'until', expiresAt: at } }, instrument: { id: 'x', name: 'Bitcoin', kind: 'crypto_spot', baseAsset: 'BTC', baseScale: 8 } }

describe('the words for how long an order stands and how it ended', () => {
  it('an open order stands until its time, with the date, or until cancelled', () => {
    expect(standsUntilLine({ ...base, state: 'working' })).toBe('Stands until 18 Nov 2026, 11:00 IST')
    expect(standsUntilLine({ ...base, state: 'working', params: { type: 'limit', validity: { kind: 'gtc' } } })).toBe('Stands until you cancel it')
    expect(standsUntilLine({ ...base, state: 'working', params: { type: 'limit' } })).toBe('Stands until you cancel it')
    expect(standsUntilLine({ ...base, state: 'working', params: { type: 'limit', validity: { kind: 'day', expiresAt: Date.parse('2026-11-18T18:30:00Z') } } })).toBe('Stands until the end of 18 Nov 2026 (midnight IST)')
    expect(standsUntilLine({ ...base, state: 'expired' })).toBeNull()
    expect(standsUntilLine({ ...base, state: 'working', params: { type: 'market' } })).toBeNull()
  })
  it('an expired order says what filled before and what was released, in the household currency', () => {
    const line = expiredLine({ ...base, state: 'expired', result: { expired: true, expiredAt: at, filledQty: '50000', movedPaise: '326918', releasedPaise: '173082' } })
    expect(line).toBe('Expired at 18 Nov 2026, 11:00 IST, ₹3,269.18 filled before, ₹1,730.82 released')
    expect(expiredLine({ ...base, state: 'expired', result: { expired: true, expiredAt: at, filledQty: '0', releasedPaise: '500000' } })).toBe('Expired at 18 Nov 2026, 11:00 IST, ₹0.00 filled before, ₹5,000.00 released')
    expect(expiredLine({ ...base, state: 'expired', result: { expired: true, expiredAt: at, filledQty: '0', releasedQty: '100000' } })).toContain('0.001 BTC released')
    // a part-filled expiry is a partly done order; a sale says what it brought in, not what "filled"
    expect(expiredLine({ ...base, state: 'partial', result: { expired: true, expiredAt: at, filledQty: '50000', movedPaise: '326918', releasedPaise: '173082' } })).toContain('₹3,269.18 filled before')
    expect(expiredLine({ ...base, state: 'partial', result: { expired: true, expiredAt: at, filledQty: '50000', movedPaise: '320000', releasedQty: '50000' } })).toBe('Expired at 18 Nov 2026, 11:00 IST, ₹3,200.00 brought in before, 0.0005 BTC released')
    expect(expiredLine({ ...base, state: 'cancelled', result: {} })).toBeNull()
  })
})
