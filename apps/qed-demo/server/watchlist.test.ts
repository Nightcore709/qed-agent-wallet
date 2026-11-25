/**
 * The watchlist (R14, Grow): a household's own list of instruments it watches, each row built from the market data QED
 * already holds. Per household, at most 50, a second add changes nothing, each price with its source and time and whether
 * it is observed or synthetic, the change since the price at the moment it was added, and a stale flag by the source's own rule.
 */
import { describe, expect, it } from 'vitest'
import { WATCH_MAX, addWatch, removeWatch, watchlistView } from './watchlist.ts'
import { buildContext } from './ai.ts'
import { makeKit } from './testkit.ts'

const MIN = 60_000, DAY = 86_400_000
const nav = (k: ReturnType<typeof makeKit>, id: string, date: string, v: string, provider = 'amfi') =>
  k.market.update({ instrumentId: id, type: 'nav', price: v, sourceTs: Date.parse(`${date}T00:00:00+05:30`), precision: 'day', recvTs: k.clock.now(), provider })
const second = (k: ReturnType<typeof makeKit>) => { k.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_two', 'other', 'Other', 'x', k.clock.now()); return 'usr_two' }
const rows = (k: ReturnType<typeof makeKit>, who = k.userId) => watchlistView(k.db, k.market, who, k.clock.now())

describe('the watchlist', () => {
  it('adds an instrument with the price, source and time at that moment, and rows say the change since', () => {
    const k = makeKit()
    nav(k, 'amfi:120716', '2026-11-17', '200.0000')
    const added = addWatch(k.db, k.market, k.userId, 'owner', 'amfi:120716', k.clock.now())
    expect(added).toMatchObject({ added: true, count: 1 })
    k.clock.advance(DAY)
    nav(k, 'amfi:120716', '2026-11-18', '205.0000')
    const [row] = rows(k).items
    expect(row).toMatchObject({ instrumentId: 'amfi:120716', price: '205.0000', priceType: 'nav', provider: 'amfi', basis: 'observed', precision: 'day', stale: false, quote: 'INR', tradable: true,
      addedPrice: '200.0000', addedProvider: 'amfi', change: '5.0000', changePct: 2.5 })
    expect(row!.at).toBe(Date.parse('2026-11-18T00:00:00+05:30'))
    expect(row!.addedAt).toBe(k.clock.now() - DAY)
  })

  it('calls prices from the paper exchange synthetic and a fund NAV from AMFI observed, using the provider on the quote', () => {
    const k = makeKit()
    k.market.update({ instrumentId: 'xchg:TCS', type: 'bid', price: '3010.00', sourceTs: k.clock.now(), precision: 'ms', recvTs: k.clock.now(), provider: 'synthetic-markets' })
    addWatch(k.db, k.market, k.userId, 'owner', 'xchg:TCS', k.clock.now())
    const [row] = rows(k).items
    expect(row).toMatchObject({ provider: 'synthetic-markets', basis: 'synthetic', priceType: 'bid', price: '3010.00' })
  })

  it('flags a price older than its own freshness rule as stale, and never one inside it', () => {
    const k = makeKit()
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    expect(rows(k).items[0]!.stale).toBe(false)
    k.clock.advance(31_000) // staleAfterMs for the rupee crypto markets is 30 s
    expect(rows(k).items[0]).toMatchObject({ stale: true, price: '6000000' })
    // a published NAV is judged by its own cycle: four days
    nav(k, 'amfi:120716', '2026-11-17', '200.0000')
    addWatch(k.db, k.market, k.userId, 'owner', 'amfi:120716', k.clock.now())
    expect(rows(k).items.find((i) => i.instrumentId === 'amfi:120716')!.stale).toBe(false)
    k.clock.advance(5 * DAY)
    expect(rows(k).items.find((i) => i.instrumentId === 'amfi:120716')!.stale).toBe(true)
  })

  it('never leaves the source or the time missing on a price; a name with no value yet says so and still names its source', () => {
    const k = makeKit()
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    const ids = ['coindcx:BTCINR', 'amfi:120716', 'xchg:RELIANCE', 'gsec:GS2036']
    for (const id of ids) addWatch(k.db, k.market, k.userId, 'owner', id, k.clock.now())
    const view = rows(k)
    expect(view.items).toHaveLength(4)
    for (const r of view.items) {
      expect(r.provider, r.instrumentId).toBeTruthy()
      expect(['observed', 'synthetic']).toContain(r.basis)
      if (r.price !== null) { expect(r.at, r.instrumentId).toBeTypeOf('number'); expect(r.recvTs).toBeTypeOf('number') }
      else { expect(r).toMatchObject({ at: null, stale: true, status: 'No value received yet', change: null }); expect(r.changeNote).toMatch(/no price/i) }
    }
    expect(view.items.find((r) => r.instrumentId === 'amfi:120716')).toMatchObject({ provider: 'amfi', basis: 'observed' })
    expect(view.items.find((r) => r.instrumentId === 'xchg:RELIANCE')).toMatchObject({ provider: 'synthetic-markets', basis: 'synthetic' })
  })

  it('a duplicate add changes nothing: the first price and time stay, no second row, no second audit line', () => {
    const k = makeKit()
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    const first = addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    const before = k.db.all('SELECT * FROM watchlist_items')
    k.clock.advance(5000); k.quote('coindcx:BTCINR', 'bid', '6100000')
    const again = addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    expect(again).toMatchObject({ added: false, count: 1 })
    expect(k.db.all('SELECT * FROM watchlist_items')).toEqual(before)
    expect(k.db.get(`SELECT COUNT(*) n FROM audit WHERE action = 'watchlist.add'`)).toEqual({ n: 1 })
    expect(first.item.addedPrice).toBe('6000000')
    expect(rows(k).items[0]).toMatchObject({ addedPrice: '6000000', price: '6100000' })
  })

  it('holds at most 50 a household: the 51st is refused with its reason and nothing changes; a repeat at 50 still changes nothing', () => {
    const k = makeKit()
    expect(WATCH_MAX).toBe(50)
    // sixty more names of the paper exchange's kind: the registry offers fewer than fifty, so the limit is tried on made ones
    const t = k.db.get<{ base_asset: string; quote_asset: string }>(`SELECT base_asset, quote_asset FROM instruments WHERE id = 'xchg:TCS'`)!
    for (let n = 0; n < 60; n++) k.db.run(`INSERT INTO instruments (id, kind, name, base_asset, quote_asset, provider, venue, symbol, tradable, meta_json) VALUES (?, 'equity', ?, ?, ?, 'synthetic-markets', 'paper-exchange', ?, 1, '{}')`, `xchg:T${n}`, `Test ${n}`, t.base_asset, t.quote_asset, `T${n}`)
    for (let n = 0; n < 50; n++) addWatch(k.db, k.market, k.userId, 'owner', `xchg:T${n}`, k.clock.now())
    expect(rows(k).count).toBe(50)
    expect(() => addWatch(k.db, k.market, k.userId, 'owner', 'xchg:T50', k.clock.now())).toThrow(expect.objectContaining({ status: 409, code: 'watchlist_full', message: expect.stringMatching(/50/) }))
    expect(rows(k).count).toBe(50)
    expect(addWatch(k.db, k.market, k.userId, 'owner', 'xchg:T3', k.clock.now())).toMatchObject({ added: false, count: 50 })
    // the limit is the household's, not the installation's
    const other = second(k)
    expect(addWatch(k.db, k.market, other, 'owner', 'xchg:T50', k.clock.now())).toMatchObject({ added: true, count: 1 })
  })

  it('refuses a name QED does not offer', () => {
    const k = makeKit()
    expect(() => addWatch(k.db, k.market, k.userId, 'owner', 'nse:NOSUCH', k.clock.now())).toThrow(expect.objectContaining({ status: 404 }))
    expect(rows(k).count).toBe(0)
  })

  it('is per household: another household neither sees nor removes it, and the same name has its own first price', () => {
    const k = makeKit()
    const other = second(k)
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    expect(rows(k, other)).toMatchObject({ items: [], count: 0 })
    expect(removeWatch(k.db, other, 'owner', 'coindcx:BTCINR', k.clock.now())).toEqual({ removed: false })
    expect(rows(k).count).toBe(1)
    k.clock.advance(1000); k.quote('coindcx:BTCINR', 'bid', '6050000')
    addWatch(k.db, k.market, other, 'owner', 'coindcx:BTCINR', k.clock.now())
    expect(rows(k).items[0]!.addedPrice).toBe('6000000')
    expect(rows(k, other).items[0]!.addedPrice).toBe('6050000')
  })

  it('removes, audits, and a removal of what is not there changes nothing; a name added again starts from its new price', () => {
    const k = makeKit()
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    addWatch(k.db, k.market, k.userId, 'admin', 'coindcx:BTCINR', k.clock.now())
    expect(removeWatch(k.db, k.userId, 'admin', 'coindcx:BTCINR', k.clock.now())).toEqual({ removed: true })
    expect(removeWatch(k.db, k.userId, 'admin', 'coindcx:BTCINR', k.clock.now())).toEqual({ removed: false })
    expect(k.db.all(`SELECT actor, action, subject FROM audit WHERE action LIKE 'watchlist.%' ORDER BY id`)).toEqual([
      { actor: 'admin', action: 'watchlist.add', subject: 'coindcx:BTCINR' }, { actor: 'admin', action: 'watchlist.remove', subject: 'coindcx:BTCINR' }])
    k.clock.advance(1000); k.quote('coindcx:BTCINR', 'bid', '6100000')
    addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    expect(rows(k).items[0]!.addedPrice).toBe('6100000')
  })

  it('says there is no change when no price was on record at the time it was added, and never invents one', () => {
    const k = makeKit()
    addWatch(k.db, k.market, k.userId, 'owner', 'amfi:120716', k.clock.now())
    nav(k, 'amfi:120716', '2026-11-18', '205.0000')
    expect(rows(k).items[0]).toMatchObject({ price: '205.0000', addedPrice: null, change: null, changePct: null, changeNote: 'No price was on record when you added it.' })
  })

  it('reference rates can be watched too, but only what can be traded says so', () => {
    const k = makeKit()
    addWatch(k.db, k.market, k.userId, 'owner', 'binance:BTCUSDT', k.clock.now())
    addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    const v = rows(k).items
    expect(v.find((r) => r.instrumentId === 'binance:BTCUSDT')).toMatchObject({ tradable: false, quote: 'USDT' })
    expect(v.find((r) => r.instrumentId === 'coindcx:BTCINR')!.tradable).toBe(true)
  })

  it('Ask reads it: the snapshot the model sees lists each watched name with its source, time, basis, staleness and change', () => {
    const k = makeKit()
    k.quote('coindcx:BTCINR', 'bid', '6000000')
    addWatch(k.db, k.market, k.userId, 'owner', 'coindcx:BTCINR', k.clock.now())
    k.clock.advance(60_000); k.quote('coindcx:BTCINR', 'bid', '6030000')
    const ctx = buildContext(k.ctx, k.userId, k.clock.now()) as { watching: Record<string, unknown>[] }
    expect(ctx.watching).toEqual([expect.objectContaining({ instrumentId: 'coindcx:BTCINR', price: '6030000', source: 'test', observedOrSynthetic: 'observed', stale: false, priceWhenAdded: '6000000', changeSinceAdded: '30000', changeSinceAddedPercent: 0.5, priceTime: new Date(k.clock.now()).toISOString() })])
    // another household's snapshot has none of it
    expect((buildContext(k.ctx, second(k), k.clock.now()) as { watching: unknown[] }).watching).toEqual([])
  })
})
