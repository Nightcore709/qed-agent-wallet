import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { makeKit, T0 } from './testkit.ts'
import { FUND_PAY_IN_MS, matchBook, navEntitlement, payoutInstant } from './venues.ts'

const asks: { price: string; qty: string }[] = [{ price: '6600000', qty: '0.001' }, { price: '6601000', qty: '0.002' }, { price: '6700000', qty: '1' }]
const bids: { price: string; qty: string }[] = [{ price: '6590000', qty: '0.001' }, { price: '6580000', qty: '0.004' }]
const STEP = 1000n // 0.00001 BTC

describe('matching against a real-shaped order book', () => {
  it('a buy by amount walks the asks and never spends more than the amount', () => {
    const m = matchBook('buy', asks, { amount: 1_500_000n }, null, 8, 2, STEP) // ₹15,000
    expect(m.pieces.map((p) => p.price)).toEqual(['6600000', '6601000'])
    expect(m.pieces[0]!.qty).toBe(100_000n) // all 0.001 at the best ask = ₹6,600
    expect(m.filledAmount <= 1_500_000n).toBe(true)
    expect(m.complete).toBe(true)
    // the second piece is floored to the step size
    expect(m.pieces[1]!.qty % STEP).toBe(0n)
  })
  it('stops at the price bound and reports a partial result', () => {
    const bound = 6_601_000n * 10n ** 10n
    const m = matchBook('buy', asks, { qty: 500_000n }, bound, 8, 2, STEP)
    expect(m.filledQty).toBe(300_000n) // 0.001 + 0.002, nothing at 67,00,000
    expect(m.complete).toBe(false)
    expect(m.stoppedBy).toBe('price_limit')
  })
  it('a sale walks the bids downward and rounds proceeds down', () => {
    const m = matchBook('sell', bids, { qty: 300_000n }, null, 8, 2, STEP)
    expect(m.pieces.map((p) => [p.price, p.qty])).toEqual([['6590000', 100_000n], ['6580000', 200_000n]])
    expect(m.filledAmount).toBe(659_000n + 1_316_000n)
    expect(m.complete).toBe(true)
  })
  it('depth already taken by an earlier paper fill is not sold twice', () => {
    const m = matchBook('buy', asks, { qty: 100_000n }, null, 8, 2, STEP, (price) => (price === '6600000' ? 100_000n : 0n))
    expect(m.pieces[0]!.price).toBe('6601000')
  })
  it('an empty or exhausted book fills nothing', () => {
    expect(matchBook('buy', [], { amount: 1000n }, null, 8, 2, STEP).stoppedBy).toBe('no_liquidity')
    const m = matchBook('sell', bids, { qty: 900_000n }, null, 8, 2, STEP)
    expect(m.filledQty).toBe(500_000n)
    expect(m.complete).toBe(false)
    expect(m.stoppedBy).toBe('depth')
  })
})

describe('paper crypto venue', () => {
  it('fills a market buy against the book, charges the fee inside the budget, and is idempotent', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    const req = { clientRef: 'c1', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'buy' as const, type: 'market' as const, amount: 1_000_000n, maxSlippageBps: 100 }
    const o1 = k.venues.crypto.submit(req)
    expect(o1.state).toBe('new')
    expect(k.venues.crypto.submit(req).id).toBe(o1.id)
    await k.venues.crypto.tick()
    const o = k.venues.crypto.get('c1')!
    expect(o.state).toBe('filled')
    expect(o.filledAmount + o.fees <= 1_000_000n).toBe(true)
    expect(o.fees).toBe((o.filledAmount * 59n + 9999n) / 10_000n) // 0.50% plus 18% GST on the fee, rounded up
    expect(o.fills[0]!.snapshotId).toBeTruthy()
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('c1')!.fills.length).toBe(o.fills.length) // a second tick does not fill again
  })

  it('rejects below the venue minimum, above the market-order limit, and sales of what is not held', () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.db.run(`UPDATE instruments SET meta_json = json_set(meta_json, '$.maxMarketQty', '0.0158', '$.minNotional', '100', '$.qtyStep', '0.00001') WHERE id = 'coindcx:BTCINR'`)
    const base = { userId: k.userId, instrumentId: 'coindcx:BTCINR', type: 'market' as const }
    expect(k.venues.crypto.submit({ ...base, clientRef: 'a', side: 'buy', amount: 5000n }).rejectReason).toMatch(/minimum/)
    expect(k.venues.crypto.submit({ ...base, clientRef: 'b', side: 'buy', qty: 2_000_000n }).rejectReason).toMatch(/market-order limit/)
    expect(k.venues.crypto.submit({ ...base, clientRef: 'c', side: 'sell', qty: 1000n }).rejectReason).toMatch(/does not hold enough/)
    expect(k.venues.crypto.submit({ ...base, clientRef: 'd', side: 'buy', qty: 1500n }).rejectReason).toMatch(/multiple/)
  })

  it('does not fill on a stale or missing book: it waits, then rejects', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.bookDown = true
    k.venues.crypto.submit({ clientRef: 's1', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 1_000_000n })
    k.clock.advance(5000)
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('s1')!.state).toBe('new')
    expect(String(k.venues.crypto.get('s1')!.meta.lastNote)).toMatch(/Waiting for a fresh order book/)
    k.clock.advance(31_000)
    await k.venues.crypto.tick()
    const o = k.venues.crypto.get('s1')!
    expect(o.state).toBe('rejected')
    expect(o.rejectReason).toMatch(/not filled on stale prices/)
    expect(o.fills).toEqual([])
  })

  it('a market sale takes 1% TDS and the fee from the proceeds; a thin book gives a partial fill', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.venues.crypto.submit({ clientRef: 'b', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', qty: 1_000_000n, maxSlippageBps: 500 })
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('b')!.filledQty).toBe(1_000_000n)
    k.clock.advance(120_000)
    k.book('coindcx:BTCINR', [['6599500', '0.004']], [['6600500', '0.5']])
    k.venues.crypto.submit({ clientRef: 's', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'sell', type: 'market', qty: 1_000_000n })
    await k.venues.crypto.tick()
    const o = k.venues.crypto.get('s')!
    expect(o.state).toBe('partially_filled')
    expect(o.filledQty).toBe(400_000n)
    expect(o.taxes).toBe((o.filledAmount + 99n) / 100n)
    expect(o.rejectReason).toMatch(/rest was cancelled/)
  })

  it('a sell-stop triggers only when a fresh bid is at or below the stop', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    k.venues.crypto.submit({ clientRef: 'b', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', qty: 100_000n })
    await k.venues.crypto.tick()
    k.venues.crypto.submit({ clientRef: 'st', userId: k.userId, instrumentId: 'coindcx:BTCINR', side: 'sell', type: 'stop', qty: 100_000n, stopPrice: '6500000' })
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('st')!.state).toBe('accepted')
    k.clock.advance(60_000) // the bid on record is now a minute old
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('st')!.state).toBe('accepted')
    expect(String(k.venues.crypto.get('st')!.meta.lastNote)).toMatch(/stale/)
    k.btc(6_480_000)
    await k.venues.crypto.tick()
    expect(k.venues.crypto.get('st')!.state).toBe('filled')
  })
})

describe('fund NAV entitlement and payout dates', () => {
  const k = makeKit()
  const index = k.inst('amfi:120716'), liquid = k.inst('amfi:118701')
  const at = (date: string, hm: string) => istInstant(date, hm)
  it('index fund: before 15:00 on a business day gets that day; after, or on a weekend, the next business day', () => {
    expect(navEntitlement(index, 'buy', at('2026-11-18', '14:59')).minNavDate).toBe('2026-11-18')
    expect(navEntitlement(index, 'buy', at('2026-11-18', '15:00')).minNavDate).toBe('2026-11-19')
    expect(navEntitlement(index, 'buy', at('2026-11-20', '16:00')).minNavDate).toBe('2026-11-23') // Friday evening -> Monday
    expect(navEntitlement(index, 'sell', at('2026-11-21', '11:00')).minNavDate).toBe('2026-11-23') // Saturday -> Monday
  })
  it('liquid fund: purchases cut off at 13:30 and take the previous day; redemptions take the day before the next business day', () => {
    expect(navEntitlement(liquid, 'buy', at('2026-11-18', '13:29')).minNavDate).toBe('2026-11-17')
    expect(navEntitlement(liquid, 'buy', at('2026-11-18', '13:30')).minNavDate).toBe('2026-11-18')
    expect(navEntitlement(liquid, 'buy', at('2026-11-20', '14:00')).minNavDate).toBe('2026-11-22') // Friday afternoon -> Sunday's NAV
    expect(navEntitlement(liquid, 'sell', at('2026-11-18', '14:00')).minNavDate).toBe('2026-11-18')
    expect(navEntitlement(liquid, 'sell', at('2026-11-20', '14:00')).minNavDate).toBe('2026-11-22') // Friday -> Sunday's NAV
  })
  it('payout skips the weekend', () => {
    expect(payoutInstant('2026-11-19', 2)).toBe(at('2026-11-23', '10:00')) // Thursday + 2 business days = Monday
    expect(payoutInstant('2026-11-18', 1)).toBe(at('2026-11-19', '10:00'))
  })
})

describe('paper fund venue', () => {
  it('allots only when the fund house has published the applicable NAV, at that NAV, with stamp duty', async () => {
    const k = makeKit() // Wednesday 10:30 IST
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    const o = k.venues.funds.submit({ clientRef: 'm1', userId: k.userId, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 500_000n })
    expect(o.state).toBe('accepted')
    expect(o.meta.minNavDate).toBe('2026-11-18')
    await k.venues.funds.tick()
    expect(k.venues.funds.get('m1')!.state).toBe('accepted') // yesterday's NAV does not count
    k.clock.advance(13 * 3600_000)
    k.nav('amfi:120716', '2026-11-18', '180.0000')
    await k.venues.funds.tick()
    const f = k.venues.funds.get('m1')!
    expect(f.state).toBe('filled')
    expect(f.fills[0]!.effectiveDate).toBe('2026-11-18')
    expect(f.fills[0]!.tax).toBe(25n) // 0.005% of ₹5,000 = 25 paise
    expect(f.fills[0]!.qty).toBe(27_776n) // (5,000.00 - 0.25) / 180 = 27.7763… -> 27.776 units
    expect(f.fills[0]!.amount).toBe(499_975n)
  })

  it('a holiday resolves itself: the order takes the first NAV dated on or after its entitlement', async () => {
    const k = makeKit()
    k.venues.funds.submit({ clientRef: 'm2', userId: k.userId, instrumentId: 'amfi:120716', side: 'buy', type: 'nav', amount: 500_000n })
    k.clock.advance(2 * 86_400_000)
    k.nav('amfi:120716', '2026-11-20', '181.5000') // nothing was published for the 18th or 19th
    await k.venues.funds.tick()
    expect(k.venues.funds.get('m2')!.fills[0]!.effectiveDate).toBe('2026-11-20')
  })

  it('a redemption pays out on a later business day, with the graded liquid-fund exit load', async () => {
    const k = makeKit()
    k.nav('amfi:118701', '2026-11-17', '7033.4995')
    k.venues.funds.submit({ clientRef: 'lb', userId: k.userId, instrumentId: 'amfi:118701', side: 'buy', type: 'nav', amount: 10_000_000n })
    k.clock.advance(FUND_PAY_IN_MS) // the money reaches the fund house (since v8 a state of its own: server/fund-states.test.ts)
    await k.venues.funds.tick()
    const bought = k.venues.funds.get('lb')!
    expect(bought.state).toBe('filled') // liquid purchase before 13:30 takes the previous day's NAV
    expect(bought.fills[0]!.effectiveDate).toBe('2026-11-17')
    const r = k.venues.funds.submit({ clientRef: 'ls', userId: k.userId, instrumentId: 'amfi:118701', side: 'sell', type: 'nav', sellAll: true })
    expect(r.state).toBe('accepted')
    expect(r.qty).toBe(bought.fills[0]!.qty)
    k.clock.advance(20 * 3600_000)
    k.nav('amfi:118701', '2026-11-18', '7034.7000')
    await k.venues.funds.tick()
    const sold = k.venues.funds.get('ls')!
    expect(sold.state).toBe('filled')
    expect(sold.fills[0]!.fee > 0n).toBe(true) // redeemed one day after purchase: day-1 load of 0.0065%
    expect(sold.fills[0]!.cashDone).toBe(false)
    expect(sold.fills[0]!.cashAt).toBe(istInstant('2026-11-19', '10:00'))
    k.clock.set(istInstant('2026-11-19', '10:01'))
    await k.venues.funds.tick()
    expect(k.venues.funds.get('ls')!.fills[0]!.cashDone).toBe(true)
    expect(k.venues.funds.submit({ clientRef: 'x', userId: k.userId, instrumentId: 'amfi:118701', side: 'sell', type: 'nav', qty: 1n }).rejectReason).toMatch(/does not hold/)
  })
})

describe('paper payment rail', () => {
  it('chooses the rail by amount and settles an ordinary payment', async () => {
    const k = makeKit()
    const p = k.venues.rail.submit({ clientRef: 'p1', userId: k.userId, payeeHandle: 'landlord@upi', amount: 2_500_000n })
    expect(p.rail).toBe('upi')
    expect(p.state).toBe('pending')
    expect(k.venues.rail.submit({ clientRef: 'p2', userId: k.userId, payeeHandle: 'x@upi', amount: 30_000_000n }).rail).toBe('imps')
    expect(k.venues.rail.submit({ clientRef: 'p3', userId: k.userId, payeeHandle: 'x@upi', amount: 80_000_000n }).rail).toBe('rtgs')
    expect(k.venues.rail.submit({ clientRef: 'p4', userId: k.userId, payeeHandle: 'x@upi', amount: 20_000_000n, rail: 'upi' }).state).toBe('failed')
    k.clock.advance(3000)
    await k.venues.rail.tick()
    expect(k.venues.rail.get('p1')!.state).toBe('settled')
    expect(k.venues.rail.submit({ clientRef: 'p1', userId: k.userId, payeeHandle: 'landlord@upi', amount: 2_500_000n }).id).toBe(p.id)
  })
  it('test payees reach the failure paths deterministically', async () => {
    const k = makeKit()
    const sub = (ref: string, handle: string) => k.venues.rail.submit({ clientRef: ref, userId: k.userId, payeeHandle: handle, amount: 100_000n })
    expect(sub('d', 'decline@paper').state).toBe('failed')
    expect(sub('s', 'slow@paper').state).toBe('pending')
    expect(sub('t', 'timeout@paper').state).toBe('unknown')
    expect(sub('r', 'reverse@paper').state).toBe('pending')
    k.clock.advance(3000); await k.venues.rail.tick()
    expect(k.venues.rail.get('s')!.state).toBe('pending')
    expect(k.venues.rail.get('r')!.state).toBe('settled')
    k.clock.advance(61_000); await k.venues.rail.tick()
    expect(k.venues.rail.get('r')!.state).toBe('reversed')
    k.clock.advance(30_000); await k.venues.rail.tick()
    expect(k.venues.rail.get('s')!.state).toBe('settled')
    k.clock.advance(30_000); await k.venues.rail.tick()
    expect(k.venues.rail.get('t')!.state).toBe('failed')
  })
  it('a transfer by the half-hourly batch settles at the next batch, not before', async () => {
    const k = makeKit({ start: T0 + 7 * 60_000 }) // 10:37 IST
    k.venues.rail.submit({ clientRef: 'n', userId: k.userId, payeeHandle: 'x@bank', amount: 100_000n, rail: 'neft' })
    k.clock.advance(20 * 60_000); await k.venues.rail.tick()
    expect(k.venues.rail.get('n')!.state).toBe('pending')
    k.clock.advance(5 * 60_000); await k.venues.rail.tick() // 11:02
    expect(k.venues.rail.get('n')!.state).toBe('settled')
  })
})
