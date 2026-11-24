/**
 * The order of a fund order's days (R13 section 4: "NAV for Wed 25 Nov; allotted Tue 24 Nov" was seen on a fixture).
 *
 * A NAV is the price of a fund's units at the close of one business day, published that evening or later. So, for every
 * order the paper registrar fills: the order reaches the registrar, then (a purchase) its money reaches the fund house, and
 * only on or after the NAV's own day can units be allotted or redeemed at it; a redemption's money is paid out after that.
 * In days: registrar <= money received <= allotted, and NAV day <= the day it was allotted, and the NAV day is never before
 * the one the order is entitled to. Until 24 Nov 2026 the registrar took the first NAV on record for the entitled day or
 * later, whatever its date, so a NAV written for a later day (the test stacks' control published one at once, for a day
 * that had not come) allotted units a day before their NAV existed. These tests make that order of days impossible in the
 * registrar and in the test stacks' control, and check it over random order times, sides and publication times.
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addDays, ist, istInstant } from './core.ts'
import { SyntheticProvider, syntheticNavThrough } from './synthetic.ts'
import { makeKit, type Kit } from './testkit.ts'

const FUND = 'amfi:120716' // an index fund: the NAV of the business day its money arrives before 15:00
const LIQUID = 'amfi:118701' // a liquid fund: the NAV of the day before
interface Fill { order_id: string; side: string; ts: number; effective_date: string; cash_at: number | null }
interface Order { id: string; client_ref: string; side: string; state: string; created_at: number; funds_at: number | null; meta_json: string }

/** Write a NAV for `date` into the record now, as a feed (or a test control) would publish it. */
function publish(k: Kit, id: string, date: string, value = '180.0000'): void {
  k.db.run('INSERT OR IGNORE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, date, value, k.clock.now(), 'test')
}
const fills = (k: Kit): Fill[] => k.db.all<Fill>('SELECT order_id, side, ts, effective_date, cash_at FROM pv_fills ORDER BY ts')
const order = (k: Kit, ref: string): Order => k.db.get<Order>('SELECT id, client_ref, side, state, created_at, funds_at, meta_json FROM pv_orders WHERE client_ref = ?', ref)!

/** Every filled order's days in their order: the property this file is about. Returns what was violated, in words. */
function dayOrderBreaks(k: Kit): string[] {
  const out: string[] = []
  for (const f of fills(k)) {
    const o = k.db.get<Order>('SELECT id, client_ref, side, state, created_at, funds_at, meta_json FROM pv_orders WHERE id = ?', f.order_id)!
    const entitled = String((JSON.parse(o.meta_json) as { minNavDate?: string }).minNavDate ?? '')
    const allottedDay = ist(f.ts).date
    if (f.effective_date > allottedDay) out.push(`${o.client_ref}: NAV for ${f.effective_date}, allotted ${allottedDay}`)
    if (f.effective_date < entitled) out.push(`${o.client_ref}: NAV for ${f.effective_date}, entitled from ${entitled}`)
    if (o.side === 'buy' && (o.funds_at === null || o.funds_at < o.created_at || o.funds_at > f.ts)) out.push(`${o.client_ref}: registrar ${o.created_at}, money ${o.funds_at}, allotted ${f.ts}`)
    if (o.side === 'sell' && (f.cash_at === null || f.cash_at < f.ts || ist(f.cash_at).date <= f.effective_date)) out.push(`${o.client_ref}: NAV for ${f.effective_date}, redeemed ${f.ts}, paid ${f.cash_at}`)
  }
  return out
}

describe('the paper registrar allots no units before their NAV\'s day', () => {
  it('a NAV written for a day that has not come is not used until that day: the order waits, then is allotted on it', async () => {
    // Tuesday 24 Nov, 16:00 IST: after the 15:00 cut-off, so the purchase is entitled to Wednesday 25 Nov's NAV
    const k = makeKit({ start: istInstant('2026-11-24', '16:00') })
    k.venues.funds.submit({ clientRef: 'late-buy', userId: k.userId, instrumentId: FUND, side: 'buy', type: 'nav', amount: 2_500_000n })
    expect(JSON.parse(order(k, 'late-buy').meta_json).minNavDate).toBe('2026-11-25')
    k.clock.advance(5_000)
    publish(k, FUND, '2026-11-25') // published on Tuesday for Wednesday: what the test control did
    await k.venues.funds.tick()
    expect(order(k, 'late-buy').state).toBe('funded') // the money is there; the units are not, on Tuesday
    expect(fills(k)).toEqual([])
    // Wednesday evening: the same NAV is now a NAV of a day that has come
    k.clock.set(istInstant('2026-11-25', '21:00'))
    await k.venues.funds.tick()
    expect(order(k, 'late-buy').state).toBe('filled')
    expect(fills(k)).toEqual([expect.objectContaining({ effective_date: '2026-11-25' })])
    expect(ist(fills(k)[0]!.ts).date).toBe('2026-11-25')
    expect(dayOrderBreaks(k)).toEqual([])
  })

  it('the same for a redemption: units are redeemed at a NAV only on or after its day, and paid out after it', async () => {
    const k = makeKit({ start: istInstant('2026-11-23', '11:00') }) // Monday, before the cut-off
    publish(k, FUND, '2026-11-20')
    k.venues.funds.submit({ clientRef: 'buy', userId: k.userId, instrumentId: FUND, side: 'buy', type: 'nav', amount: 2_500_000n })
    k.clock.set(istInstant('2026-11-23', '21:00')); publish(k, FUND, '2026-11-23'); await k.venues.funds.tick(); await k.venues.funds.tick()
    expect(order(k, 'buy').state).toBe('filled')
    k.clock.set(istInstant('2026-11-24', '15:30')) // Tuesday after the cut-off: Wednesday's NAV
    k.venues.funds.submit({ clientRef: 'sell', userId: k.userId, instrumentId: FUND, side: 'sell', type: 'nav', qty: 5_000n })
    publish(k, FUND, '2026-11-25')
    await k.venues.funds.tick()
    expect(order(k, 'sell').state).toBe('accepted')
    k.clock.set(istInstant('2026-11-25', '20:00'))
    await k.venues.funds.tick()
    expect(order(k, 'sell').state).toBe('filled')
    expect(dayOrderBreaks(k)).toEqual([])
  })

  it('property: over random order times, sides and publication times (some published days early), every fill keeps the order of days', async () => {
    // a fixed seed, so a failure is reproduced exactly; 60 runs of up to 8 orders over three weeks with weekends
    const plan = fc.record({
      orders: fc.array(fc.record({ minute: fc.integer({ min: 0, max: 21 * 1440 - 1 }), liquid: fc.boolean(), sell: fc.boolean() }), { minLength: 1, maxLength: 8 }),
      // how long after the start of its day each day's NAV is published: from two days early (a faulty or test feed) to the next noon
      lag: fc.array(fc.integer({ min: -2 * 1440, max: 36 * 60 }), { minLength: 25, maxLength: 25 }),
      tickEvery: fc.integer({ min: 7, max: 240 }),
    })
    await fc.assert(fc.asyncProperty(plan, async ({ orders, lag, tickEvery }) => {
      const start = istInstant('2026-11-16', '00:00') // Monday
      const k = makeKit({ start })
      for (const id of [FUND, LIQUID]) publish(k, id, '2026-11-13')
      const due = [...orders].sort((a, b) => a.minute - b.minute)
      const days = Array.from({ length: 25 }, (_, d) => addDays('2026-11-16', d))
      const published = new Set<string>()
      let n = 0
      for (let m = 0; m <= 24 * 1440; m += tickEvery) {
        k.clock.set(start + m * 60_000)
        for (const [d, day] of days.entries()) {
          if (published.has(day) || ![1, 2, 3, 4, 5].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue
          if (start + (d * 1440 + lag[d]!) * 60_000 <= k.clock.now()) { for (const id of [FUND, LIQUID]) publish(k, id, day, (180 + d / 10).toFixed(4)); published.add(day) }
        }
        while (due.length && due[0]!.minute <= m) {
          const o = due.shift()!
          const id = o.liquid ? LIQUID : FUND
          const held = k.db.all<{ side: string; qty: number }>('SELECT side, qty FROM pv_fills WHERE instrument_id = ?', id).reduce((s, f) => s + (f.side === 'buy' ? f.qty : -f.qty), 0)
          if (o.sell && held >= 1_000) k.venues.funds.submit({ clientRef: `o${n++}`, userId: k.userId, instrumentId: id, side: 'sell', type: 'nav', qty: 1_000n })
          else k.venues.funds.submit({ clientRef: `o${n++}`, userId: k.userId, instrumentId: id, side: 'buy', type: 'nav', amount: 1_000_000n })
        }
        await k.venues.funds.tick()
      }
      expect(dayOrderBreaks(k)).toEqual([])
    }), { seed: 20261124, numRuns: 60 })
  }, 120_000)
})

describe('the test stacks\' control publishes no NAV for a day that has not come', () => {
  const env = { stack: process.env.QED_TEST_STACK, file: process.env.QED_TEST_SYNTHETIC_NAV_FILE }
  const dirs: string[] = []
  afterEach(() => {
    if (env.stack === undefined) delete process.env.QED_TEST_STACK; else process.env.QED_TEST_STACK = env.stack
    if (env.file === undefined) delete process.env.QED_TEST_SYNTHETIC_NAV_FILE; else process.env.QED_TEST_SYNTHETIC_NAV_FILE = env.file
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function control(day: string): void {
    const dir = mkdtempSync(join(tmpdir(), 'qed-nav-control-')); dirs.push(dir)
    const file = join(dir, 'nav-through'); writeFileSync(file, day)
    process.env.QED_TEST_STACK = '1'; process.env.QED_TEST_SYNTHETIC_NAV_FILE = file
  }
  const latest = (k: Kit, id: string): string | undefined => k.db.get<{ d: string }>('SELECT MAX(value_date) d FROM daily_values WHERE instrument_id = ?', id)?.d

  it('asked for tomorrow\'s NAV on Tuesday, it publishes Tuesday\'s at most; asked for today\'s, it publishes today\'s ahead of the evening', () => {
    const k = makeKit({ start: istInstant('2026-11-24', '16:00') })
    const feed = new SyntheticProvider(k.market)
    control('2026-11-25')
    expect(syntheticNavThrough()).toBe('2026-11-25')
    feed.tick(k.clock.now())
    expect(latest(k, FUND)).toBe('2026-11-24')
    control('2026-11-24')
    k.clock.advance(60_000)
    feed.tick(k.clock.now())
    expect(latest(k, FUND)).toBe('2026-11-24')
    // and the quote it leaves is labelled with the day its NAV is for, never a later one
    expect(ist(k.market.get(FUND, 'nav')!.sourceTs!).date <= '2026-11-24').toBe(true)
  })
})
