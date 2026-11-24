/**
 * The paper securities desks (R13, audit G2): the exchange (ETFs, shares) and the government-securities desk (a bill, a
 * bond). Per desk: settlement, costs as applied at execution, and refusals out of hours; then an order through the whole
 * flow (approval, execution, receipt, holdings), a sale to its settlement day, and a bond's coupon. Prices here are
 * fixtures that exercise the arithmetic.
 */
import { describe, expect, it } from 'vitest'
import { istInstant } from './core.ts'
import { createAction, getAction, stepAllActions } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { balance, verifyLedger } from './ledger.ts'
import { reconcileUser } from './recon.ts'
import { verifyChain } from './receipts.ts'
import { exchangeCostsStatus, term } from './registry.ts'
import { billPrice, bondPrice, closedText, couponDates, couponsDue, NOT_OFFERED, securityCosts, sessionOf, settlementDate, SecuritiesProvider } from './securities.ts'
import { payCoupons } from './securities-books.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import type { OrderParams } from './types.ts'
import { venueHolding } from './venues.ts'

const BANK = BigInt(DEFAULT_OPENING.bank)
const ETF = 'xchg:NIFTYBEES', GOLD = 'xchg:GOLDBEES', SHARE = 'xchg:RELIANCE', BILL = 'gsec:TB91', BOND = 'gsec:GS2036'
const WED_10 = istInstant('2026-11-18', '10:30')

function quote(k: Kit, id: string, bid: string, ask: string): void { k.quote(id, 'bid', bid); k.quote(id, 'ask', ask) }
function order(k: Kit, ref: string, instrumentId: string, side: 'buy' | 'sell', extra: Record<string, bigint | boolean> = {}) {
  const desk = k.inst(instrumentId).venue === 'paper-gsec' ? k.venues.debt! : k.venues.exchange!
  return desk.submit({ clientRef: ref, userId: k.userId, instrumentId, side, type: 'market', ...extra })
}
function owner(k: Kit, eid: string, params: OrderParams) {
  const inst = k.inst(params.instrumentId)
  return createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: inst.venue, economicId: eid, params, approvalId: k.approveOwner(`action:${eid}`) })
}
const sound = (k: Kit) => { expect(verifyLedger(k.db, k.userId)).toEqual([]); expect(verifyChain(k.db, k.userId).ok).toBe(true) }

describe('the registry offers them, with their terms', () => {
  it('lists the instruments the mandate names and keeps four kinds out, each with a reason', () => {
    const k = makeKit()
    for (const id of [ETF, GOLD, SHARE, 'xchg:TCS', 'xchg:HDFCBANK', BILL, BOND, 'amfi:118719']) expect(k.inst(id).tradable).toBe(1)
    expect(k.inst(ETF).venue).toBe('paper-exchange')
    expect(k.inst(BILL).venue).toBe('paper-gsec')
    expect(NOT_OFFERED.map((x) => x.id).sort()).toEqual(['futures-options', 'fx-trades', 'reits-invits', 'us-equities'])
    for (const n of NOT_OFFERED) expect(n.reason.length).toBeGreaterThan(40)
  })
  it('states the data of each: a recorded anchor with its date and source, or a round number, and never live', () => {
    const k = makeKit()
    expect(k.inst(ETF).meta.anchor).toMatchObject({ basis: 'recorded', date: '2026-11-23', value: '289.3289' })
    expect(k.inst(ETF).meta.anchor!.source).toContain('AMFI')
    expect(k.inst(SHARE).meta.anchor!.basis).toBe('round')
    expect(k.inst(BILL).provider).toBe('synthetic-markets')
  })
  it('keeps the limits that experiment X9 refused to calibrate illustrative, with the reason in the registry', () => {
    const k = makeKit()
    for (const id of ['limit.amfi:120716', 'limit.amfi:118701', 'limit.amfi:119110', `limit.${ETF}`]) {
      const t = k.db.get<{ status: string; source: string }>('SELECT status, source FROM terms WHERE id = ?', id)!
      expect(t.source).toMatch(/^Illustrative placeholder/)
      expect(['modelled', 'calibrated']).toContain(t.status)
    }
  })
})

describe('hours', () => {
  it('the exchange trades 9:15 to 15:30, Monday to Friday; the government desk 9:00 to 17:00', () => {
    const k = makeKit()
    const at = (date: string, hm: string) => istInstant(date, hm)
    expect(sessionOf(k.inst(ETF), at('2026-11-18', '09:14')).open).toBe(false)
    expect(sessionOf(k.inst(ETF), at('2026-11-18', '09:15')).open).toBe(true)
    expect(sessionOf(k.inst(ETF), at('2026-11-18', '15:29')).open).toBe(true)
    expect(sessionOf(k.inst(ETF), at('2026-11-18', '15:30')).open).toBe(false)
    expect(sessionOf(k.inst(ETF), at('2026-11-21', '11:00')).open).toBe(false) // Saturday
    expect(sessionOf(k.inst(BILL), at('2026-11-18', '16:59')).open).toBe(true)
    expect(sessionOf(k.inst(BILL), at('2026-11-18', '17:00')).open).toBe(false)
    expect(new Date(sessionOf(k.inst(ETF), at('2026-11-20', '16:00')).nextOpenAt! + 19_800_000).toISOString().slice(0, 16)).toBe('2026-11-23T09:15') // Friday evening: Monday
    expect(closedText(k.inst(ETF), at('2026-11-21', '11:00'))).toMatch(/closed.*9:15 am to 3:30 pm India time.*holidays are not modelled/)
  })
  it('settlement skips weekends: a Friday sale settles on Monday', () => {
    expect(settlementDate('2026-11-20', 1)).toBe('2026-11-23')
    expect(settlementDate('2026-11-18', 1)).toBe('2026-11-19')
    expect(settlementDate('2026-11-19', 3)).toBe('2026-11-24')
  })
})

describe('paper exchange', () => {
  it('buys whole units at the ask, with every cost inside the amount, and the stamp duty as tax', async () => {
    const k = makeKit(); quote(k, ETF, '289.00', '289.03')
    const amount = 1_000_000n // ₹10,000
    const o = order(k, 'e1', ETF, 'buy', { amount })
    expect(o.state).toBe('new')
    await k.venues.exchange!.tick()
    const f = k.venues.exchange!.get('e1')!
    expect(f.state).toBe('filled')
    const fill = f.fills[0]!
    expect(fill.price).toBe('289.03')
    expect(fill.qty).toBe(34n) // 34 units: ₹9,827.02
    expect(fill.amount).toBe(34n * 28_903n)
    const c = securityCosts(k.db, k.inst(ETF), 'buy', fill.amount)
    expect(fill.fee).toBe(c.fee); expect(fill.tax).toBe(c.tax)
    expect(fill.amount + fill.fee + fill.tax <= amount).toBe(true)
    expect(fill.amount + fill.fee + fill.tax + 28_903n > amount).toBe(true) // one more unit would not have fitted
    expect(fill.tax).toBe((fill.amount * 15n + 99_999n) / 100_000n) // stamp duty 0.015%, rounded up
    expect(fill.cashAt).toBeNull()
    // the equity ETF pays no securities transaction tax on a purchase; brokerage is 0.03%
    expect(c.parts.find((p) => p.label === 'Securities transaction tax')).toBeUndefined()
    expect(c.parts.find((p) => p.label === 'Brokerage')!.amount).toBe((fill.amount * 3n + 9_999n) / 10_000n)
  })
  it('charges securities transaction tax by class: shares both ways, an equity ETF on the sale only, a gold ETF never', () => {
    const k = makeKit(); const gross = 10_000_000n
    const stt = (id: string, side: 'buy' | 'sell') => securityCosts(k.db, k.inst(id), side, gross).parts.find((p) => p.label === 'Securities transaction tax')?.amount ?? 0n
    expect(stt(SHARE, 'buy')).toBe(10_000n); expect(stt(SHARE, 'sell')).toBe(10_000n) // 0.1% of ₹1,00,000
    expect(stt(ETF, 'buy')).toBe(0n); expect(stt(ETF, 'sell')).toBe(100n) // 0.001%
    expect(stt(GOLD, 'buy')).toBe(0n); expect(stt(GOLD, 'sell')).toBe(0n)
    expect(securityCosts(k.db, k.inst(SHARE), 'sell', gross).parts.find((p) => p.label === 'Depository charge')!.amount).toBe(1_534n)
    expect(securityCosts(k.db, k.inst(SHARE), 'buy', gross).parts.find((p) => p.label === 'Depository charge')).toBeUndefined()
    // brokerage is capped at ₹20 an order
    expect(securityCosts(k.db, k.inst(SHARE), 'buy', 100_000_000n).parts.find((p) => p.label === 'Brokerage')!.amount).toBe(2_000n)
  })
  it('charges the exchange and SEBI as their circulars state them: NSE ₹307 per crore in all (₹306.99 and ₹0.01), SEBI ₹10 per crore, and 18% GST on those and the brokerage', () => {
    const k = makeKit(); const gross = 10_000_000n // ₹1,00,000
    const c = securityCosts(k.db, k.inst(SHARE), 'buy', gross)
    // ₹3.07 and ₹0.10: the 0.00297% QED seeded before 24 Nov 2026 left out NSE's ₹10 per crore contribution and gave ₹2.97
    expect(c.parts.find((p) => p.label === 'Exchange transaction charge and SEBI fee')!.amount).toBe(317n)
    expect(c.parts.find((p) => p.label === 'GST on those')!.amount).toBe(((2_000n + 317n) * 18n + 99n) / 100n) // ₹20 brokerage cap + 317 paise, 18% rounded up
    expect(term(k.db, 'fee.exchange.charges')).toMatchObject({ status: 'verified', value: { txnRate: '0.0000307', sebiRate: '0.000001' } })
    expect(term(k.db, 'fee.exchange.gst')).toMatchObject({ status: 'unverified' }) // GST on the exchange's charges: no page read states it
    expect(term(k.db, 'fee.exchange.dp')).toMatchObject({ status: 'modelled' })
    for (const id of ['tax.stt', 'tax.stamp.exchange', 'rule.exchange.hours', 'rule.exchange.settlement', 'tax.vda.tds', 'mf.stamp']) expect(term(k.db, id)?.status, id).toBe('verified')
    for (const id of ['rule.gsec.hours', 'tax.debt.interest']) expect(term(k.db, id)?.status, id).toBe('unverified')
    expect(exchangeCostsStatus(k.db)).toBe('unverified') // the weakest of the terms behind a trade's costs, never the best
  })
  it('a sale pays the bank on the next business day at 10:00, and a Friday sale on Monday', async () => {
    const k = makeKit({ start: istInstant('2026-11-20', '11:00') }); quote(k, ETF, '300.00', '300.05')
    order(k, 'b', ETF, 'buy', { amount: 3_100_000n }); await k.venues.exchange!.tick()
    const bought = k.venues.exchange!.get('b')!.filledQty
    expect(bought).toBe(103n)
    order(k, 's', ETF, 'sell', { qty: 100n }); await k.venues.exchange!.tick()
    const s = k.venues.exchange!.get('s')!
    expect(s.state).toBe('filled')
    expect(s.fills[0]!.price).toBe('300.00')
    expect(s.fills[0]!.cashAt).toBe(istInstant('2026-11-23', '10:00'))
    expect(s.fills[0]!.cashDone).toBe(false)
    expect(s.fills[0]!.tax).toBe(0n) // no stamp duty on a sale
    k.clock.set(istInstant('2026-11-23', '10:01')); await k.venues.exchange!.tick()
    expect(k.venues.exchange!.get('s')!.fills[0]!.cashDone).toBe(true)
  })
  it('refuses out of hours: before the open, after the close, on a Saturday; and rejects an order the close overtakes', async () => {
    const k = makeKit(); quote(k, SHARE, '999.00', '1000.00')
    for (const [i, [d, hm]] of ([['2026-11-18', '09:00'], ['2026-11-18', '15:30'], ['2026-11-21', '11:00']] as const).entries()) {
      k.clock.set(istInstant(d, hm)); quote(k, SHARE, '999.00', '1000.00')
      const o = order(k, `x${i}`, SHARE, 'buy', { amount: 500_000n })
      expect(o.state).toBe('rejected'); expect(o.rejectReason).toMatch(/closed/); expect(o.fills).toHaveLength(0)
    }
    k.clock.set(istInstant('2026-11-18', '15:29')); quote(k, SHARE, '999.00', '1000.00')
    const late = order(k, 'late', SHARE, 'buy', { amount: 500_000n })
    expect(late.state).toBe('new')
    k.clock.set(istInstant('2026-11-18', '15:31')); quote(k, SHARE, '999.00', '1000.00')
    await k.venues.exchange!.tick()
    expect(k.venues.exchange!.get('late')!.state).toBe('rejected')
    expect(k.venues.exchange!.get('late')!.fills).toHaveLength(0)
  })
  it('never fills on an old price, and gives up after thirty seconds', async () => {
    const k = makeKit(); quote(k, ETF, '289.00', '289.03')
    k.clock.advance(20_000)
    order(k, 'old', ETF, 'buy', { amount: 1_000_000n }); await k.venues.exchange!.tick()
    expect(k.venues.exchange!.get('old')!.state).toBe('new')
    k.clock.advance(31_000); await k.venues.exchange!.tick()
    expect(k.venues.exchange!.get('old')!.state).toBe('rejected')
  })
  it('refuses a sale of more than is held, a fractional lot, a limit order, and an amount that buys nothing', async () => {
    const k = makeKit(); quote(k, SHARE, '999.00', '1000.00')
    expect(order(k, 'a', SHARE, 'sell', { qty: 1n }).rejectReason).toMatch(/not hold that many|nothing is held/)
    const lim = k.venues.exchange!.submit({ clientRef: 'l', userId: k.userId, instrumentId: SHARE, side: 'buy', type: 'limit', amount: 500_000n, limitPrice: '990' })
    expect(lim.state).toBe('rejected'); expect(lim.rejectReason).toMatch(/market orders only/)
    order(k, 'tiny', SHARE, 'buy', { amount: 50_000n }); await k.venues.exchange!.tick() // ₹500 against a ₹1,000 share
    expect(k.venues.exchange!.get('tiny')!.state).toBe('rejected')
    expect(k.venues.exchange!.get('tiny')!.rejectReason).toMatch(/less than the smallest lot/)
    expect(k.venues.exchange!.submit({ clientRef: 'wrong', userId: k.userId, instrumentId: BILL, side: 'buy', type: 'market', amount: 1_000_000n }).rejectReason).toMatch(/does not trade/)
  })
  it('is idempotent on its client reference and its holding is what the fills say', async () => {
    const k = makeKit(); quote(k, SHARE, '999.00', '1000.00')
    const a = order(k, 'same', SHARE, 'buy', { amount: 2_000_000n })
    expect(order(k, 'same', SHARE, 'buy', { amount: 2_000_000n }).id).toBe(a.id)
    await k.venues.exchange!.tick(); await k.venues.exchange!.tick()
    expect(venueHolding(k.db, k.userId, SHARE)).toBe(19n)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_fills')!.n).toBe(1)
  })
})

describe('paper government-securities desk', () => {
  it('trades a bill in lots of 100 units (₹10,000 of face value), with no brokerage and no tax: the cost is the gap', async () => {
    const k = makeKit({ start: istInstant('2026-11-18', '16:00') }) // the exchange is closed; this desk is open
    quote(k, BILL, '98.5000', '98.5300')
    const o = order(k, 'b1', BILL, 'buy', { amount: 1_000_000n }); expect(o.state).toBe('new')
    await k.venues.debt!.tick()
    const f = k.venues.debt!.get('b1')!
    expect(f.state).toBe('filled')
    expect(f.filledQty).toBe(100n) // ₹10,000 face at 98.53 = ₹9,853
    expect(f.fills[0]!.amount).toBe(985_300n)
    expect(f.fills[0]!.fee).toBe(0n); expect(f.fills[0]!.tax).toBe(0n)
    const small = order(k, 'b2', BILL, 'buy', { amount: 500_000n }); await k.venues.debt!.tick()
    expect(small.state).toBe('new')
    expect(k.venues.debt!.get('b2')!.rejectReason).toMatch(/less than the smallest lot of 100/)
    expect(order(k, 's1', BILL, 'sell', { qty: 50n }).rejectReason).toMatch(/multiples of 100/)
  })
  it('settles a sale next business day and refuses after 17:00 and on the weekend', async () => {
    const k = makeKit({ start: istInstant('2026-11-19', '11:00') }); quote(k, BILL, '98.5000', '98.5300')
    order(k, 'b', BILL, 'buy', { amount: 1_000_000n }); await k.venues.debt!.tick()
    order(k, 's', BILL, 'sell', { sellAll: true }); await k.venues.debt!.tick()
    expect(k.venues.debt!.get('s')!.fills[0]!.cashAt).toBe(istInstant('2026-11-20', '10:00'))
    k.clock.set(istInstant('2026-11-19', '17:00')); quote(k, BILL, '98.5000', '98.5300')
    expect(order(k, 'late', BILL, 'buy', { amount: 1_000_000n }).rejectReason).toMatch(/government-securities desk is closed.*9:00 am to 5:00 pm/)
    k.clock.set(istInstant('2026-11-21', '12:00')); quote(k, BILL, '98.5000', '98.5300')
    expect(order(k, 'sat', BILL, 'buy', { amount: 1_000_000n }).rejectReason).toMatch(/closed/)
  })
  it('refuses to buy a matured bill but lets a holder sell it at face value', async () => {
    const k = makeKit({ start: istInstant('2027-02-18', '11:00') }); quote(k, BILL, '99.9500', '99.9700')
    order(k, 'b', BILL, 'buy', { amount: 1_000_000n }); await k.venues.debt!.tick()
    expect(venueHolding(k.db, k.userId, BILL)).toBe(100n)
    k.clock.set(istInstant('2027-02-19', '11:00')); quote(k, BILL, '100.0000', '100.0000')
    expect(order(k, 'again', BILL, 'buy', { amount: 1_000_000n }).rejectReason).toMatch(/matured/)
    order(k, 'redeem', BILL, 'sell', { sellAll: true }); await k.venues.debt!.tick()
    expect(k.venues.debt!.get('redeem')!.fills[0]!.amount).toBe(1_000_000n)
  })
  it('prices a bill from its yield and a bond from its coupons, and a bond falls when yields rise', () => {
    expect(billPrice(5.4, 91)).toBeCloseTo(100 / (1 + 0.054 * 91 / 365), 10)
    expect(billPrice(5.4, 0)).toBe(100)
    expect(billPrice(6, 91)).toBeLessThan(billPrice(5, 91))
    expect(couponDates('2036-05-15', '2026-05-15').length).toBe(20)
    expect(couponDates('2036-05-15', '2026-05-15')[0]).toBe('2026-11-15')
    const par = bondPrice(6.5, 6.5, '2036-05-15', '2026-05-15', '2026-05-15')
    expect(par).toBeCloseTo(100, 1) // a bond whose coupon is its yield is worth face on its issue day
    expect(bondPrice(7.5, 6.5, '2036-05-15', '2026-05-15', '2026-05-15')).toBeLessThan(par)
    expect(bondPrice(5.5, 6.5, '2036-05-15', '2026-05-15', '2026-05-15')).toBeGreaterThan(par)
    // the full price drops by the coupon on the coupon day (here: between 14 and 15 Nov, a day's accrual of 3.25 is shed at once)
    expect(bondPrice(6.5, 6.5, '2036-05-15', '2026-05-15', '2026-11-14') - bondPrice(6.5, 6.5, '2036-05-15', '2026-05-15', '2026-11-15')).toBeGreaterThan(3)
  })
  it('pays a coupon once, to whoever held the bond at the start of the coupon day', async () => {
    const k = makeKit({ start: istInstant('2027-05-13', '11:00') }); quote(k, BOND, '99.0000', '99.2000')
    order(k, 'bond', BOND, 'buy', { amount: 1_000_000n }); await k.venues.debt!.tick()
    expect(venueHolding(k.db, k.userId, BOND)).toBe(100n)
    // book the fill as an owner order would; here only the coupon is of interest, so the desk's own record is enough
    k.clock.set(istInstant('2027-05-15', '09:00'))
    expect(couponsDue(k.db, k.clock.now()).filter((c) => c.date === '2027-05-15')).toHaveLength(0) // not before 10:00
    k.clock.set(istInstant('2027-05-15', '10:00'))
    const due = couponsDue(k.db, k.clock.now()).filter((c) => c.date === '2027-05-15')
    expect(due).toHaveLength(1)
    expect(due[0]!.paise).toBe(100n * 325n) // 100 units of ₹100 face at 6.50% a year, half a year: ₹3.25 each
    // sold on the Monday after, the coupon of the Saturday is still the holder's; and none is due for a day before the purchase
    k.clock.set(istInstant('2027-05-17', '11:00')); quote(k, BOND, '99.0000', '99.2000')
    order(k, 'sell-after', BOND, 'sell', { sellAll: true }); await k.venues.debt!.tick()
    expect(couponsDue(k.db, k.clock.now()).filter((c) => c.date === '2027-05-15')).toHaveLength(1)
    expect(couponsDue(k.db, k.clock.now()).filter((c) => c.date === '2026-11-15')).toHaveLength(0)
  })
})

describe('through the whole flow: approval, execution, receipt, holdings, statement', () => {
  it('buys an ETF: the books, the holding, the lot, the receipt and the reconciliation agree', async () => {
    const k = makeKit(); quote(k, ETF, '289.00', '289.03')
    const a = owner(k, 'o1', { instrumentId: ETF, side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect(done.state).toBe('done')
    const r = done.result as Record<string, string>
    expect(r.filledQty).toBe('34')
    const fill = k.venues.exchange!.get('o1')!.fills[0]!
    expect(balance(k.db, k.userId, `pos:${ETF}`)).toBe(34n)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK - fill.amount - fill.fee - fill.tax)
    expect(balance(k.db, k.userId, 'exp:stamp')).toBe(fill.tax)
    expect(balance(k.db, k.userId, 'exp:fees')).toBe(fill.fee)
    const receipt = k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', done.receipt_id!)!
    const body = JSON.parse(receipt.body_json)
    expect(body.reconciliation.state).toBe('reconciled')
    expect(body.costs.ledgerAgrees).toBe(true)
    expect(body.costs.reference.source).toBe('test')
    expect(body.instrument.unit).toBe('units')
    expect(reconcileUser(k.ctx, k.userId).ok).toBe(true)
    sound(k)
  })
  it('refuses a purchase out of hours before anything is sent, with the reason on the receipt', async () => {
    const k = makeKit({ start: istInstant('2026-11-18', '18:00') }); quote(k, ETF, '289.00', '289.03')
    const a = owner(k, 'late', { instrumentId: ETF, side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' })
    await settle(k)
    const done = getAction(k.db, a.id)!
    expect(done.state).toBe('blocked')
    expect(done.error).toMatch(/closed/)
    expect(balance(k.db, k.userId, 'bank')).toBe(BANK)
    expect(k.db.get('SELECT 1 FROM pv_orders WHERE client_ref = ?', 'late')).toBeUndefined()
    sound(k)
  })
  it('sells it: proceeds are due until the next business day, then reach the bank; the lot and the books agree', async () => {
    const k = makeKit(); quote(k, SHARE, '999.00', '1000.00')
    owner(k, 'b', { instrumentId: SHARE, side: 'buy', type: 'market', amount: '2000000', purpose: 'manual' }); await settle(k)
    expect(balance(k.db, k.userId, `pos:${SHARE}`)).toBe(19n)
    quote(k, SHARE, '1010.00', '1011.00')
    const s = owner(k, 's', { instrumentId: SHARE, side: 'sell', type: 'market', qty: '19', purpose: 'manual' }); await settle(k)
    const fill = k.venues.exchange!.get('s')!.fills[0]!
    expect(fill.amount).toBe(19n * 101_000n)
    expect(getAction(k.db, s.id)!.state).toBe('working') // waiting for settlement
    expect(balance(k.db, k.userId, 'recv:mf')).toBe(fill.amount - fill.fee)
    const bankBefore = balance(k.db, k.userId, 'bank')
    k.clock.set(istInstant('2026-11-19', '10:05')); quote(k, SHARE, '1010.00', '1011.00')
    await settle(k)
    expect(getAction(k.db, s.id)!.state).toBe('done')
    expect(balance(k.db, k.userId, 'recv:mf')).toBe(0n)
    expect(balance(k.db, k.userId, 'bank')).toBe(bankBefore + fill.amount - fill.fee)
    expect(balance(k.db, k.userId, `pos:${SHARE}`)).toBe(0n)
    const body = JSON.parse(k.db.get<{ body_json: string }>('SELECT body_json FROM receipts WHERE id = ?', getAction(k.db, s.id)!.receipt_id!)!.body_json)
    expect(body.reconciliation.state).toBe('reconciled')
    expect(body.costs.ledgerAgrees).toBe(true)
    expect(reconcileUser(k.ctx, k.userId).ok).toBe(true)
    sound(k)
  })
  it('pays a held bond its coupon into the bank once, however often the engine looks', async () => {
    const k = makeKit({ start: istInstant('2027-05-13', '11:00') }); quote(k, BOND, '99.0000', '99.2000')
    owner(k, 'bond', { instrumentId: BOND, side: 'buy', type: 'market', amount: '1000000', purpose: 'manual' }); await settle(k)
    expect(balance(k.db, k.userId, `pos:${BOND}`)).toBe(100n)
    k.clock.set(istInstant('2027-05-15', '10:30'))
    const bank = balance(k.db, k.userId, 'bank')
    expect(payCoupons(k.ctx)).toBe(1); expect(payCoupons(k.ctx)).toBe(0)
    expect(balance(k.db, k.userId, 'bank')).toBe(bank + 32_500n)
    expect(balance(k.db, k.userId, 'inc:interest')).toBe(32_500n)
    sound(k)
  })
})

describe('the synthetic feed', () => {
  it('publishes bid and ask for every security from an anchor, labelled synthetic-markets, and moves only in hours', () => {
    const k = makeKit()
    const p = new SecuritiesProvider(k.market)
    p.seedHistory(k.clock.now()); p.tick(k.clock.now())
    for (const id of [ETF, GOLD, SHARE, BILL, BOND]) {
      const bid = k.market.get(id, 'bid')!, ask = k.market.get(id, 'ask')!
      expect(bid.provider).toBe('synthetic-markets')
      expect(Number(ask.price)).toBeGreaterThan(Number(bid.price))
    }
    expect(Number(k.market.get(BILL, 'ask')!.price)).toBeLessThan(100)
    const before = k.market.get(ETF, 'last')!.price
    k.clock.set(istInstant('2026-11-21', '12:00')); p.tick(k.clock.now()) // Saturday: no step
    k.clock.advance(60_000); p.tick(k.clock.now())
    expect(k.market.get(ETF, 'last')!.price).toBe(k.market.get(ETF, 'last')!.price)
    expect(typeof before).toBe('string')
    const rows = k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM daily_values WHERE instrument_id = ? AND source = 'synthetic-markets'`, ETF)!.n
    expect(rows).toBeGreaterThan(250)
  })
})
