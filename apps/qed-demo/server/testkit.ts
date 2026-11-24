/**
 * Test harness: an in-memory database, a clock the test controls, a market store fed by the test, and paper venues
 * whose order-book fetch is the test's own book. No network is used. Prices in tests are fixtures, used only to
 * exercise the arithmetic and the state machines.
 */
import { confirmApproval, createApproval } from './approvals.ts'
import { FakeClock, openDb, type Db } from './core.ts'
import { DEFAULT_OPENING, openHousehold, type OpeningBalances, type Profile } from './household.ts'
import { type Book, Market, type PriceType } from './market.ts'
import { type Instrument, instrument, seedRegistry } from './registry.ts'
import type { Ctx } from './types.ts'
import { PaperCryptoVenue, PaperDebtVenue, PaperExchangeVenue, PaperFundVenue, PaperRail, type Venues } from './venues.ts'

export interface Kit {
  db: Db; clock: FakeClock; market: Market; venues: Venues; ctx: Ctx; userId: string
  bookDown: boolean
  quote(id: string, type: PriceType, price: string, ageMs?: number): void
  book(id: string, bids: [string, string][], asks: [string, string][]): void
  nav(id: string, date: string, nav: string): void
  /** Fresh, mutually consistent BTC prices on every source, so cross-checks pass. */
  btc(inrMid: number): void
  approveOwner(subject: string, document?: string): string
  inst(id: string): Instrument
}

/** 2026-11-18 (Wednesday) 10:30 IST. */
export const T0 = Date.parse('2026-11-18T05:00:00Z')

export function makeKit(opts: { start?: number; opening?: OpeningBalances; profile?: Partial<Profile>; user?: boolean } = {}): Kit {
  const db = openDb(':memory:')
  seedRegistry(db)
  const clock = new FakeClock(opts.start ?? T0)
  const market = new Market(db, clock)
  const kit = { bookDown: false } as Kit
  const fetchBook = async (m: Market, i: Instrument): Promise<Book> => {
    if (kit.bookDown) throw new Error('order book unavailable (test)')
    const b = m.book(i.id)
    if (!b) throw new Error('no book set in test')
    const fresh = { ...b, recvTs: clock.now(), sourceTs: clock.now() }
    m.setBook(fresh)
    return fresh
  }
  const venues: Venues = { crypto: new PaperCryptoVenue(db, market, clock, fetchBook), funds: new PaperFundVenue(db, clock), rail: new PaperRail(db, clock), exchange: new PaperExchangeVenue(db, market, clock), debt: new PaperDebtVenue(db, market, clock) }
  const userId = 'usr_test'
  if (opts.user !== false) {
    db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'tester', 'Test Owner', 'x', clock.now())
    openHousehold(db, userId, opts.opening ?? DEFAULT_OPENING, opts.profile ?? {}, clock.now())
  }
  Object.assign(kit, {
    db, clock, market, venues, ctx: { db, clock, market, venues }, userId,
    quote(id: string, type: PriceType, price: string, ageMs = 0) {
      market.update({ instrumentId: id, type, price, sourceTs: clock.now() - ageMs, precision: 'ms', recvTs: clock.now() - ageMs, provider: 'test' })
    },
    book(id: string, bids: [string, string][], asks: [string, string][]) {
      market.setBook({ instrumentId: id, bids: bids.map(([price, qty]) => ({ price, qty })), asks: asks.map(([price, qty]) => ({ price, qty })), sourceTs: clock.now(), recvTs: clock.now(), provider: 'test' })
      if (bids[0]) kit.quote(id, 'bid', bids[0][0])
      if (asks[0]) kit.quote(id, 'ask', asks[0][0])
    },
    nav(id: string, date: string, nav: string) {
      db.run('INSERT OR REPLACE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, date, nav, clock.now(), 'test')
      market.update({ instrumentId: id, type: 'nav', price: nav, sourceTs: Date.parse(`${date}T00:00:00+05:30`), precision: 'day', recvTs: clock.now(), provider: 'test' })
    },
    btc(inrMid: number) {
      const usdtInr = 100
      kit.book('coindcx:BTCINR', [[String(inrMid - 500), '0.5'], [String(inrMid - 1500), '1']], [[String(inrMid + 500), '0.5'], [String(inrMid + 1500), '1']])
      kit.quote('coindcx:USDTINR', 'bid', String(usdtInr - 0.05)); kit.quote('coindcx:USDTINR', 'ask', String(usdtInr + 0.05))
      kit.quote('binance:BTCUSDT', 'bid', String(inrMid / usdtInr - 1)); kit.quote('binance:BTCUSDT', 'ask', String(inrMid / usdtInr + 1))
    },
    approveOwner(subject: string, document = `Test approval for ${subject}`) {
      const a = createApproval(db, userId, { purpose: 'action', subject, document, requiresStepUp: false }, clock.now())
      confirmApproval(db, userId, a.id, { method: 'session', docHash: a.doc_hash }, clock.now())
      return a.id
    },
    inst(id: string) { return instrument(db, id)! },
  })
  return kit
}

/** Run the venues and the executor until nothing changes, advancing the clock a little each round. */
export async function settle(kit: Kit, rounds = 6, stepMs = 1000): Promise<void> {
  const { stepAllActions } = await import('./execute.ts')
  for (let i = 0; i < rounds; i++) {
    await stepAllActions(kit.ctx)
    await kit.venues.crypto.tick(); await kit.venues.funds.tick(); await kit.venues.rail.tick(); await kit.venues.exchange!.tick(); await kit.venues.debt!.tick()
    await stepAllActions(kit.ctx)
    kit.clock.advance(stepMs)
  }
}
