/**
 * Test support: trades booked to a ledger with the same postings, lots and realised rows as server/execute.ts bookFill, so
 * the tax statement is tested (server/tax.test.ts) and walked in the browser (browser/tests/tax.spec.ts) on books of the
 * wallet's own shape. Paper figures; it never touches a venue.
 */
import { istInstant, type Db } from './core.ts'
import { consumeLots, ensureAccount, openLot, post } from './ledger.ts'
import { instrument } from './registry.ts'

export const at = (date: string): number => istInstant(date, '11:00')
export const BTC = 'coindcx:BTCINR', NIFTY = 'amfi:120716', GOLD = 'amfi:119788', LIQUID = 'amfi:118701'

export function trades(db: Db, userId: string, tag = 't') {
  let seq = 0
  const ref = (): string => `${tag}${++seq}`
  function accountsFor(id: string): { pos: string; base: string } {
    const i = instrument(db, id)!
    ensureAccount(db, userId, `pos:${id}`, 'asset', i.base_asset, i.name, true)
    ensureAccount(db, userId, `trade:${i.base_asset}`, 'trading', i.base_asset, `Trade ${i.base_asset}`)
    return { pos: `pos:${id}`, base: `trade:${i.base_asset}` }
  }
  return {
    buyCoin(date: string, qty: bigint, amount: bigint, fee: bigint): void {
      const { pos, base } = accountsFor(BTC), ts = at(date), cash = amount + fee
      const e = post(db, { userId, ts, kind: 'buy', ref: ref(), memo: 'buy', lines: [{ account: pos, amount: qty }, { account: base, amount: -qty }, { account: 'trade:INR', amount }, { account: 'exp:fees', amount: fee }, { account: 'bank', amount: -cash }] })
      openLot(db, userId, BTC, qty, cash, ts, e.id)
    },
    sellCoin(date: string, qty: bigint, amount: bigint, fee: bigint, tds = (amount + 99n) / 100n): void {
      const { pos, base } = accountsFor(BTC), ts = at(date)
      const e = post(db, { userId, ts, kind: 'sell', ref: ref(), memo: 'sell', lines: [{ account: base, amount: qty }, { account: pos, amount: -qty }, { account: 'bank', amount: amount - fee - tds }, { account: 'exp:fees', amount: fee }, { account: 'tds', amount: tds }, { account: 'trade:INR', amount: -amount }] })
      consumeLots(db, userId, BTC, qty, amount - fee, ts, e.id)
    },
    buyFund(id: string, date: string, qty: bigint, amount: bigint): void {
      const { pos, base } = accountsFor(id), ts = at(date), stamp = amount / 20_000n
      post(db, { userId, ts, kind: 'transfer', ref: ref(), memo: 'to the fund house', lines: [{ account: 'bank', amount: -(amount + stamp) }, { account: 'clear:mf', amount: amount + stamp }] })
      const e = post(db, { userId, ts, kind: 'fund-units-allotted', ref: ref(), memo: 'units', lines: [{ account: pos, amount: qty }, { account: base, amount: -qty }, { account: 'trade:INR', amount }, { account: 'exp:stamp', amount: stamp }, { account: 'clear:mf', amount: -(amount + stamp) }] })
      openLot(db, userId, id, qty, amount + stamp, ts, e.id)
    },
    sellFund(id: string, date: string, qty: bigint, amount: bigint, fee = 0n): void {
      const { pos, base } = accountsFor(id), ts = at(date), net = amount - fee
      const e = post(db, { userId, ts, kind: 'fund-units-redeemed', ref: ref(), memo: 'redeemed', lines: [{ account: base, amount: qty }, { account: pos, amount: -qty }, { account: 'recv:mf', amount: net }, { account: 'exp:fees', amount: fee }, { account: 'trade:INR', amount: -amount }] })
      consumeLots(db, userId, id, qty, net, ts, e.id)
    },
  }
}
