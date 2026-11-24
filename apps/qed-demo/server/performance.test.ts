/**
 * "Why it changed" (R12 task comparison, gap 17, T4-c): a holding's change in value since it was first bought, split
 * into price movement on the units while they were held, money added or taken out, and costs (fees, stamp duty, taxes,
 * rounding), adding up to the paisa; and an annual rate, money-weighted (XIRR on the dated cash flows).
 *
 * The flows below are made with the paper venues' own rules (server/venues.ts: stamp duty net of itself, units rounded
 * down to a thousandth, an exit load and a venue fee rounded up, tax deducted at source on a sale), using shared/fixed.ts
 * directly, so the bridge is checked against money worked out apart from it.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fraction, mulDiv, notional, parseDec, PRICE_SCALE, pow10, quantityFor } from '../shared/fixed.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { createAction } from './execute.ts'
import { ANNUAL_MIN_DAYS, bridge, type CashFlow, type Flow, fineUnit, holdingStory, xirr, XIRR_TOLERANCE } from './performance.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import type { OrderParams } from './types.ts'
import { holdings } from './valuation.ts'

const STAMP = '0.00005'
const nav4 = (rupees: string): bigint => parseDec(rupees, PRICE_SCALE) // a NAV, four places as published
/** Money for units the venue's way: what a value of `qty` atoms at `price` is, rounded as named. */
const value = (qty: bigint, base: number, price: bigint, mode: 'down' | 'up') => notional(qty, base, price, 2, mode)

/** A fund purchase as the paper registrar makes it: stamp duty out of the amount, units rounded down. */
function fundBuy(amount: bigint, nav: bigint): Flow | null {
  const r = parseDec(STAMP, 12)
  const stamp = mulDiv(amount, r, pow10(12) + r, 'half')
  const net = amount - stamp
  const qty = quantityFor(net, 2, nav, 3, 'down')
  return qty > 0n ? { side: 'buy', qty, price: nav, gross: net, fee: 0n, stamp, tax: 0n, cash: amount } : null
}
/** A redemption: the gross at the NAV rounded down, less an exit load rounded up. */
function fundSell(qty: bigint, nav: bigint, loadRate: string): Flow {
  const gross = value(qty, 3, nav, 'down')
  const fee = fraction(gross, loadRate, 'up')
  return { side: 'sell', qty, price: nav, gross, fee, stamp: 0n, tax: 0n, cash: gross - fee }
}
/** A crypto buy and sell on the paper exchange: the consideration rounded against the owner, a fee, and TDS on a sale. */
function coinBuy(qty: bigint, price: bigint): Flow {
  const gross = value(qty, 8, price, 'up')
  const fee = fraction(gross, '0.005', 'up')
  return { side: 'buy', qty, price, gross, fee, stamp: 0n, tax: 0n, cash: gross + fee }
}
function coinSell(qty: bigint, price: bigint): Flow {
  const gross = value(qty, 8, price, 'down')
  const fee = fraction(gross, '0.005', 'up'), tax = fraction(gross, '0.01', 'up')
  return { side: 'sell', qty, price, gross, fee, stamp: 0n, tax, cash: gross - fee - tax }
}

/** Price movement worked out on its own, interval by interval: the units held times each change of price, exactly. */
function movementByIntervals(flows: Flow[], priceNow: bigint): bigint {
  let q = 0n, prev = flows[0]?.price ?? priceNow, m = 0n
  for (const f of flows) { m += q * (f.price - prev); q += f.side === 'buy' ? f.qty : -f.qty; prev = f.price }
  return m + q * (priceNow - prev)
}
const held = (flows: Flow[]): bigint => flows.reduce((s, f) => s + (f.side === 'buy' ? f.qty : -f.qty), 0n)
/** The equation XIRR solves, worked out here on its own: each amount discounted to the first day (Actual/365) at ln(1 + rate), their sum and their sizes. */
function residual(cfs: CashFlow[], lnGrowth: number): { sum: number; size: number } {
  const t0 = Math.min(...cfs.map((c) => c.at))
  const parts = cfs.map((c) => c.amount * Math.exp(-lnGrowth * (c.at - t0) / (365 * 86_400_000)))
  return { sum: parts.reduce((s, v) => s + v, 0), size: parts.reduce((s, v) => s + Math.abs(v), 0) }
}

describe('why a holding changed: three lines that add up to the change shown', () => {
  it('one fund purchase of ₹25,000 at a NAV of 178.6, now 180: added ₹25,000.00, price +₹195.96, costs ₹1.36 (stamp ₹1.25, rounding 11 paise)', () => {
    const buy = fundBuy(2_500_000n, nav4('178.6'))!
    expect(buy).toMatchObject({ qty: 139_970n, stamp: 125n, gross: 2_499_875n }) // 139.970 units, ₹1.25 stamp duty
    const b = bridge([buy], 139_970n, nav4('180'), 3, 2)
    expect(b).toMatchObject({ change: 2_519_460n, added: 2_500_000n, takenOut: 0n, flows: 2_500_000n, movement: 19_596n, stamp: 125n, rounding: 11n, costs: 136n, buys: 1, sells: 0 })
    expect(b.movement + b.flows - b.costs).toBe(b.change)
  })

  it('a price that has not moved moved nothing: the rounding of units and of the value shown is a cost, not a movement', () => {
    const buy = fundBuy(2_500_000n, nav4('178.6'))!
    const b = bridge([buy], buy.qty, nav4('178.6'), 3, 2)
    expect(b.movement).toBe(0n)
    expect(b.change).toBe(value(buy.qty, 3, nav4('178.6'), 'down'))
  })

  it('refuses flows that do not reconcile: money that is not the consideration plus its charges, or units that are not the holding', () => {
    const buy = fundBuy(2_500_000n, nav4('178.6'))!
    expect(() => bridge([{ ...buy, cash: buy.cash + 1n }], buy.qty, nav4('180'), 3, 2)).toThrow(/does not reconcile/)
    expect(() => bridge([buy], buy.qty + 1n, nav4('180'), 3, 2)).toThrow(/units/)
    expect(() => bridge([buy, fundSell(buy.qty + 1n, nav4('180'), '0')], 0n, nav4('180'), 3, 2)).toThrow(/more units than were held/)
  })

  const fundOps = fc.array(fc.record({
    buy: fc.boolean(),
    amount: fc.bigInt({ min: 10_000n, max: 100_000_000n }), // ₹100 to ₹10 lakh
    nav: fc.integer({ min: 100_000, max: 100_000_000 }).map((n) => BigInt(n) * 1_000_000n), // NAV 10.0000 to 10,000.0000
    share: fc.integer({ min: 1, max: 1000 }), // thousandths of what is held, for a sale
    load: fc.constantFrom('0', '0.0001', '0.0065', '0.01'),
  }), { minLength: 1, maxLength: 12 })

  it('property, fund purchases, partial redemptions and costs: the lines add up exactly, the money is what the bank saw, and price movement is the units times the NAV changes to within half a paisa', () => {
    fc.assert(fc.property(fundOps, fc.integer({ min: 100_000, max: 100_000_000 }), (ops, nowNav) => {
      const flows: Flow[] = []
      let bankOut = 0n, bankIn = 0n, fees = 0n, stamp = 0n
      for (const o of ops) {
        const q = held(flows)
        if (o.buy || q === 0n) {
          const f = fundBuy(o.amount, o.nav)
          if (!f) continue
          flows.push(f); bankOut += o.amount; stamp += f.stamp
        } else {
          const qty = (q * BigInt(o.share)) / 1000n || 1n
          const f = fundSell(qty > q ? q : qty, o.nav, o.load)
          flows.push(f); bankIn += f.cash; fees += f.fee
        }
      }
      if (!flows.length) return
      const priceNow = BigInt(nowNav) * 1_000_000n, qty = held(flows)
      const b = bridge(flows, qty, priceNow, 3, 2)
      expect(b.movement + b.flows - b.costs).toBe(b.change)
      expect(b.change).toBe(value(qty, 3, priceNow, 'down')) // the value Grow shows
      expect(b.added).toBe(bankOut)
      expect(b.takenOut).toBe(bankIn)
      expect(b.flows).toBe(bankOut - bankIn)
      expect([b.fees, b.stamp, b.taxes]).toEqual([fees, stamp, 0n])
      expect(b.costs).toBe(fees + stamp + b.rounding)
      const D = fineUnit(3, 2)
      const off = b.movement * D - movementByIntervals(flows, priceNow)
      expect(off * 2n <= D && off * 2n >= -D).toBe(true)
    }), { numRuns: 400 })
  })

  it('property, digital assets bought and sold in part, with the venue fee and tax deducted at source: the same three lines add up exactly', () => {
    const ops = fc.array(fc.record({
      buy: fc.boolean(),
      qty: fc.bigInt({ min: 1_000n, max: 100_000_000n }), // 0.00001 to 1 BTC
      price: fc.integer({ min: 100, max: 1_000_000_000 }).map((p) => BigInt(p) * 100_000_000n), // ₹1 to ₹1 crore, to the paisa
      share: fc.integer({ min: 1, max: 1000 }),
    }), { minLength: 1, maxLength: 12 })
    fc.assert(fc.property(ops, fc.integer({ min: 100, max: 1_000_000_000 }), (list, nowPaise) => {
      const flows: Flow[] = []
      let bankOut = 0n, bankIn = 0n, fees = 0n, taxes = 0n
      for (const o of list) {
        const q = held(flows)
        if (o.buy || q === 0n) { const f = coinBuy(o.qty, o.price); flows.push(f); bankOut += f.cash; fees += f.fee }
        else { const qty = (q * BigInt(o.share)) / 1000n || 1n; const f = coinSell(qty > q ? q : qty, o.price); flows.push(f); bankIn += f.cash; fees += f.fee; taxes += f.tax }
      }
      const priceNow = BigInt(nowPaise) * 100_000_000n, qty = held(flows)
      const b = bridge(flows, qty, priceNow, 8, 2)
      expect(b.movement + b.flows - b.costs).toBe(b.change)
      expect([b.added, b.takenOut, b.fees, b.taxes]).toEqual([bankOut, bankIn, fees, taxes])
      const D = fineUnit(8, 2)
      const off = b.movement * D - movementByIntervals(flows, priceNow)
      expect(off * 2n <= D && off * 2n >= -D).toBe(true)
    }), { numRuns: 400 })
  })
})

describe('the annual rate: money-weighted, an XIRR on the dated cash flows', () => {
  const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`)

  it('reproduces the worked example in Microsoft\'s XIRR documentation: 0.373362535', () => {
    const cfs: CashFlow[] = [
      { at: day('2008-01-01'), amount: -10_000 }, { at: day('2008-03-01'), amount: 2750 }, { at: day('2008-10-30'), amount: 4250 },
      { at: day('2009-02-15'), amount: 3250 }, { at: day('2009-04-01'), amount: 2750 },
    ]
    const r = xirr(cfs)
    expect(r.rate).not.toBeNull()
    expect(r.rate!).toBeCloseTo(0.373362535, 8)
  })

  it('one amount in and one value out is compound growth: (value / amount) to the power 365 / days, less one', () => {
    const r = xirr([{ at: day('2025-03-01'), amount: -2_500_000 }, { at: day('2026-11-24'), amount: 2_819_460 }])
    const days = (day('2026-11-24') - day('2025-03-01')) / 86_400_000
    expect(r.rate!).toBeCloseTo((2_819_460 / 2_500_000) ** (365 / days) - 1, 10)
  })

  it('says why there is no rate: money only in, or only out, has none', () => {
    expect(xirr([{ at: day('2025-01-01'), amount: -100 }, { at: day('2026-01-01'), amount: -100 }])).toEqual({ rate: null, why: 'one-sided' })
    expect(xirr([{ at: day('2025-01-01'), amount: 100 }])).toEqual({ rate: null, why: 'one-sided' })
  })

  it('property: whenever a rate is given, the dated cash flows discounted at it sum to zero within a billionth of their discounted size', () => {
    const flow = fc.record({ days: fc.integer({ min: 0, max: 3650 }), amount: fc.integer({ min: -100_000_000, max: 100_000_000 }) })
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000_000 }), fc.array(flow, { maxLength: 10 }), fc.integer({ min: 1, max: 500_000_000 }), fc.integer({ min: 30, max: 3650 }), (first, middle, last, span) => {
      const t0 = day('2020-01-01')
      const cfs: CashFlow[] = [{ at: t0, amount: -first }, ...middle.map((m) => ({ at: t0 + Math.min(m.days, span) * 86_400_000, amount: m.amount })), { at: t0 + span * 86_400_000, amount: last }]
      const r = xirr(cfs)
      if (r.rate === null) { expect(['none', 'several']).toContain(r.why); return }
      const e = residual(cfs, r.ln)
      expect(Math.abs(e.sum)).toBeLessThanOrEqual(XIRR_TOLERANCE * e.size)
      expect(r.rate).toBeCloseTo(Math.expm1(r.ln), 12)
      expect(r.rate).toBeGreaterThanOrEqual(-1)
    }), { numRuns: 500 })
  })

  it('property: a single purchase and today\'s value always have exactly one rate, it solves the equation, and it is the closed form', () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 1_000_000_000 }), fc.integer({ min: 1, max: 5_000_000_000 }), fc.integer({ min: 365, max: 7300 }), (paid, worth, days) => {
      const cfs: CashFlow[] = [{ at: 0, amount: -paid }, { at: days * 86_400_000, amount: worth }]
      const r = xirr(cfs)
      if (r.rate === null) throw new Error(`no rate for ${paid} paid and ${worth} worth after ${days} days`)
      const e = residual(cfs, r.ln)
      expect(Math.abs(e.sum)).toBeLessThanOrEqual(XIRR_TOLERANCE * e.size)
      // the closed form: ln(1 + r) = ln(worth / paid) / years
      expect(r.ln).toBeCloseTo(Math.log(worth / paid) / (days / 365), 9)
    }), { numRuns: 300 })
  })
})

describe('a holding\'s story from the ledger: what it was bought at, why it changed, its annual rate', () => {
  const fundOrder = (k: Kit, eid: string, params: Partial<OrderParams>) => createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: eid, params: { instrumentId: 'amfi:120716', type: 'nav', purpose: 'manual', ...params } as OrderParams, approvalId: k.approveOwner(`action:${eid}`) })
  const coinOrder = (k: Kit, eid: string, params: Partial<OrderParams>) => createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: eid, params: { instrumentId: 'coindcx:BTCINR', type: 'market', purpose: 'manual', maxSlippageBps: 100, ...params } as OrderParams, approvalId: k.approveOwner(`action:${eid}`) })
  const storyOf = (k: Kit, id: string) => {
    const h = holdings(k.db, k.market, k.userId, k.clock.now()).find((x) => x.instrumentId === id)!
    return { h, s: holdingStory(k.db, k.userId, k.inst(id), BigInt(h.qtyAtomsText), h.price, k.clock.now()) }
  }
  const posted = (k: Kit, kind: string, code: string): bigint => fromAmountText(k.db.get<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id WHERE e.user_id = ? AND e.kind = ? AND a.code = ?`, k.userId, kind, code)?.s, 'a sum')

  it('two fund purchases and a partial redemption: each figure is the ledger\'s, and the lines add up to the value shown', async () => {
    const k = makeKit() // Wednesday 18 Nov, 10:30 IST
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    fundOrder(k, 'b1', { side: 'buy', amount: '2500000' })
    await settle(k)
    k.clock.advance(12 * 3600_000); k.nav('amfi:120716', '2026-11-18', '178.6000'); await settle(k)
    k.clock.advance(12 * 3600_000) // Thursday 10:30
    fundOrder(k, 'b2', { side: 'buy', amount: '1000000' })
    await settle(k)
    k.clock.advance(12 * 3600_000); k.nav('amfi:120716', '2026-11-19', '181.2500'); await settle(k)
    k.clock.advance(12 * 3600_000) // Friday 10:30
    fundOrder(k, 's1', { side: 'sell', qty: '50000' }) // 50 units, first in first out from the first purchase
    await settle(k)
    k.clock.advance(12 * 3600_000); k.nav('amfi:120716', '2026-11-20', '182.0000'); await settle(k)
    k.clock.advance(24 * 3600_000); k.nav('amfi:120716', '2026-11-23', '183.4567')
    const { h, s } = storyOf(k, 'amfi:120716')
    const w = s.why!
    expect(w.movement + w.flows - w.costs).toBe(w.change)
    expect(w.change).toBe(h.value) // the value Grow shows
    expect(w.added).toBe(Number(-posted(k, 'fund-purchase-paid', 'bank'))) // what left the bank for both purchases
    expect(w.takenOut).toBe(Number(posted(k, 'fund-units-redeemed', 'recv:mf'))) // what the redemption is due to pay
    expect(w.stamp).toBe(Number(posted(k, 'fund-units-allotted', 'exp:stamp')))
    expect(w.fees).toBe(Number(posted(k, 'fund-units-redeemed', 'exp:fees')))
    expect(w).toMatchObject({ buys: 2, sells: 1, taxes: 0, since: k.db.get<{ t: number }>(`SELECT MIN(effective_ts) t FROM entries WHERE kind = 'fund-units-allotted'`)!.t })
    // bought at: two purchases, each its NAV and day; what they cost adds up to the cost Grow shows
    expect(s.purchases.map((p) => [p.navDate, p.price])).toEqual([['2026-11-18', '178.6'], ['2026-11-19', '181.25']])
    expect(s.purchases.reduce((t, p) => t + p.cost, 0)).toBe(h.cost)
    expect(s.purchases.reduce((t, p) => t + BigInt(p.held), 0n)).toBe(BigInt(h.qtyAtomsText))
    expect(BigInt(s.purchases[0]!.held)).toBe(BigInt(s.purchases[0]!.bought) - 50_000n)
    const held = s.purchases.map((p) => BigInt(p.held))
    const avg = (Number(held[0]) * 178.6 + Number(held[1]) * 181.25) / Number(held[0]! + held[1]!)
    expect(Number(s.boughtAt!.price)).toBeCloseTo(avg, 8)
    expect(s.boughtAt).toMatchObject({ purchases: 2, first: s.purchases[0]!.at, last: s.purchases[1]!.at })
    expect(s.annual).toMatchObject({ method: 'xirr', minDays: ANNUAL_MIN_DAYS, rate: null, reason: 'young', heldDays: 3 }) // first allotted on Wednesday evening; read on Saturday evening
  })

  it('a holding sold to nothing and bought again starts again: only the new purchase is in why it changed', async () => {
    const k = makeKit()
    k.btc(6_500_000)
    coinOrder(k, 'c1', { side: 'buy', qty: '100000' })
    await settle(k)
    coinOrder(k, 'c2', { side: 'sell', sellAll: true })
    await settle(k)
    k.btc(6_600_000)
    coinOrder(k, 'c3', { side: 'buy', qty: '200000' })
    await settle(k)
    k.btc(6_700_000)
    const { h, s } = storyOf(k, 'coindcx:BTCINR')
    expect(s.why).toMatchObject({ buys: 1, sells: 0, takenOut: 0, change: h.value })
    expect(s.why!.added).toBe(Number(-posted(k, 'buy', 'bank')) - Number(-k.db.get<{ s: string }>(`SELECT p.amount_text s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id WHERE e.kind = 'buy' AND a.code = 'bank' ORDER BY e.seq LIMIT 1`)!.s))
    expect(s.why!.movement + s.why!.flows - s.why!.costs).toBe(s.why!.change)
    expect(s.purchases).toHaveLength(1) // the fills of one order are one purchase
  })

  it('after a year it gives the money-weighted rate, dating a fund purchase from the day its money left the bank', async () => {
    const k = makeKit()
    k.nav('amfi:120716', '2026-11-17', '178.8713')
    fundOrder(k, 'y1', { side: 'buy', amount: '2500000' })
    await settle(k)
    const paidAt = k.db.get<{ t: number }>(`SELECT effective_ts t FROM entries WHERE kind = 'fund-purchase-paid'`)!.t
    k.clock.advance(12 * 3600_000); k.nav('amfi:120716', '2026-11-18', '178.6000'); await settle(k)
    k.clock.set(paidAt + 400 * 86_400_000)
    k.nav('amfi:120716', '2027-12-22', '196.4600')
    const { h, s } = storyOf(k, 'amfi:120716')
    expect(s.annual.reason).toBeNull()
    expect(s.annual.heldDays).toBeGreaterThanOrEqual(ANNUAL_MIN_DAYS)
    expect(s.annual.rate!).toBeCloseTo((h.value! / 2_500_000) ** (365 / 400) - 1, 9)
  })
})
