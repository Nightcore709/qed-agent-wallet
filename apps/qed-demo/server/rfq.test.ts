/**
 * Requests for quotes (R13, I2): the paper venue's book walked level by level, two simulated dealers from a documented formula,
 * the cheapest split of an order, a fund's single NAV price, and the certified minimum-variance check where it applies. All
 * prices here are synthetic fixtures.
 */
import { describe, expect, it } from 'vitest'
import { addDays, ist } from './core.ts'
import { DEALERS, listQuotes, requestQuotes, SIMULATED_NOTE, type Source, splitOrder } from './rfq.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'

const LAKH = 10_000_000, CRORE = 100 * LAKH
const owner = { personId: 'usr_test', role: 'owner' as const }
function navHistory(k: Kit, id: string, days: number, drift: number, wiggle: number, last: number): void {
  const today = ist(T0).date
  const pts: [string, number][] = []
  for (let d = days; d >= 1; d--) {
    const date = addDays(today, -d)
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (wd === 0 || wd === 6) continue
    pts.push([date, Math.exp(drift * (days - d) + wiggle * Math.sin(d / 3 + drift * 1000) + 0.3 * wiggle * Math.cos(d / 11))])
  }
  const scale = last / pts[pts.length - 1]![1]
  for (const [date, v] of pts) k.nav(id, date, (v * scale).toFixed(4))
}
const MID = 8_000_000
function market(): Kit {
  const k = makeKit()
  // 0.5 BTC and then 1 BTC either side of the mid: about ₹40 lakh and ₹80 lakh of depth
  k.book('coindcx:BTCINR', [[String(MID - 500), '0.5'], [String(MID - 1500), '1']], [[String(MID + 500), '0.5'], [String(MID + 1500), '1']])
  return k
}

describe('the split', () => {
  const flat = (p: number, cap: number): Source => ({ id: `s${p}`, label: '', simulated: false, executable: true, note: '', capacityPaise: cap, marginal: () => p })
  it('takes everything from the cheapest source while it has room, then the next', () => {
    const r = splitOrder([flat(101, 40), flat(100, 60)], 'buy', 100)
    expect(r.taken[0]! + r.taken[1]!).toBeCloseTo(100, 6)
    expect(r.taken[1]).toBeCloseTo(60, 6)
    expect(r.taken[0]).toBeCloseTo(40, 6)
    // a sale goes to the highest bid
    expect(splitOrder([flat(101, 100), flat(100, 100)], 'sell', 50).taken).toEqual([expect.closeTo(50, 6), 0])
  })
  it('never takes more than a source can quote, and says what it could fill', () => {
    const r = splitOrder([flat(100, 30)], 'buy', 100)
    expect(r.filled).toBeCloseTo(30, 6)
  })
})

describe('a request for quotes on a large order', () => {
  it('a small order is best at the venue\'s book, a large one is split with the simulated dealers and costs less than any single source', async () => {
    const k = market()
    const small = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 20 * LAKH }] }, T0)
    const s0 = small.legs[0]!
    expect(s0.complete).toBe(true)
    expect(s0.bestAlone!.id).toBe('paper-book')
    expect(s0.sources.find((x) => x.id === 'paper-book')!.sharePaise).toBeGreaterThan(19.9 * LAKH)
    // larger than the book's depth (about ₹1.2 crore): the book alone cannot fill it
    const big = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 2 * CRORE }] }, T0 + 1)
    const b = big.legs[0]!
    expect(b.complete).toBe(true)
    expect(b.sources.find((x) => x.id === 'paper-book')!.aloneComplete).toBe(false)
    expect(b.sources.filter((x) => x.sharePaise > 0).length).toBeGreaterThan(1)
    expect(b.sources.reduce((s, x) => s + x.sharePaise, 0)).toBeCloseTo(2 * CRORE, -3)
    const bestAlone = b.bestAlone
    expect(bestAlone === null || b.splitAvgPrice! <= bestAlone.avgPrice).toBe(true)
    // every simulated source is labelled, and only the venue's book can be ordered
    for (const x of b.sources) expect(x.simulated).toBe(x.id !== 'paper-book')
    for (const x of b.sources) expect(x.executable).toBe(x.id === 'paper-book')
    expect(big.simulatedNote).toBe(SIMULATED_NOTE)
    expect(DEALERS.every((d) => d.label.includes('simulated'))).toBe(true)
    expect(b.sources.every((x) => x.slippageBps === null || x.slippageBps >= 0)).toBe(true)
  })

  it('a sale is quoted against the bids; a request is recorded and listed; limits on the request are enforced', async () => {
    const k = market()
    const r = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'sell', amountPaise: 10 * LAKH }] }, T0)
    expect(r.legs[0]!.sources.find((x) => x.id === 'paper-book')!.avgPrice!).toBeLessThanOrEqual(MID - 500)
    expect(listQuotes(k.db, 'ws')[0]!.id).toBe(r.id)
    expect(listQuotes(k.db, 'other')).toEqual([])
    expect(r.validUntil - r.createdAt).toBe(60_000)
    await expect(requestQuotes(k.ctx, 'ws', owner, { legs: [] }, T0)).rejects.toThrow(/at least one/)
    await expect(requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 5000 }] }, T0)).rejects.toThrow(/at least ₹10,000/)
    await expect(requestQuotes(k.ctx, 'ws', { ...owner, role: 'viewer' }, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: LAKH }] }, T0)).rejects.toThrow(/cannot ask/)
    await expect(requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'nope:X', side: 'buy', amountPaise: LAKH }] }, T0)).rejects.toThrow(/not one this app lists/)
  })

  it('a fund has one price, its NAV, and says so instead of inventing a comparison', async () => {
    const k = market()
    navHistory(k, 'amfi:120716', 400, 0.0004, 0.02, 250)
    const r = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'amfi:120716', side: 'buy', amountPaise: 5 * LAKH }] }, T0)
    const l = r.legs[0]!
    expect(l.sources).toHaveLength(1)
    expect(l.sources[0]).toMatchObject({ id: 'fund-house', simulated: false, avgPrice: 250 })
    expect(l.why).toMatch(/nothing to compare/)
  })
})

describe('the certified minimum-variance check', () => {
  it('compares an order for several funds with the minimum-variance mix and carries the solve\'s certificate', async () => {
    const k = market()
    navHistory(k, 'amfi:120716', 600, 0.0004, 0.02, 250)
    navHistory(k, 'amfi:122639', 600, 0.0005, 0.025, 80)
    navHistory(k, 'amfi:119788', 600, 0.0003, 0.015, 30)
    const r = await requestQuotes(k.ctx, 'ws', owner, { legs: ['amfi:120716', 'amfi:122639', 'amfi:119788'].map((id) => ({ instrumentId: id, side: 'buy', amountPaise: 3 * LAKH })) }, T0)
    const mv = r.minVariance
    expect(mv.applies).toBe(true)
    expect(mv.certified).toBe(true)
    expect(mv.certificate!.kktResidual).toBeLessThan(1e-6)
    expect(mv.shares!.reduce((s, x) => s + x.minVarianceBps, 0)).toBeGreaterThanOrEqual(9_998)
    expect(typeof mv.matches).toBe('boolean')
    expect(mv.maxGapBps).toBe(Math.max(...mv.shares!.map((s) => Math.abs(s.orderBps - s.minVarianceBps))))
  })
  it('says why where it does not apply: one investment, a sale, or no recorded history', async () => {
    const k = market()
    const one = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 2 * LAKH }] }, T0)
    expect(one.minVariance).toMatchObject({ applies: false, why: expect.stringMatching(/one investment/) })
    navHistory(k, 'amfi:120716', 600, 0.0004, 0.02, 250)
    const noHistory = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'amfi:120716', side: 'buy', amountPaise: 2 * LAKH }, { instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 2 * LAKH }] }, T0)
    expect(noHistory.minVariance).toMatchObject({ applies: false, why: expect.stringMatching(/no recorded value history/) })
    const sale = await requestQuotes(k.ctx, 'ws', owner, { legs: [{ instrumentId: 'amfi:120716', side: 'sell', amountPaise: 2 * LAKH }, { instrumentId: 'coindcx:BTCINR', side: 'buy', amountPaise: 2 * LAKH }] }, T0)
    expect(sale.minVariance).toMatchObject({ applies: false, why: expect.stringMatching(/sells/) })
  })
})
