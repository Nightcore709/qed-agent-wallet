/**
 * Grow's benchmark comparison and risk estimates (R13, audit G5 and G9): no benchmark chosen for the owner; the owner's own
 * flows replayed on the same days, after costs; the uncertainty stated; and value at risk and expected shortfall shown only
 * as estimates with their method, window and confidence, never as limits.
 */
import { describe, expect, it } from 'vitest'
import { addDays, istInstant } from './core.ts'
import { createAction } from './execute.ts'
import { benchmarkChoices, compare, EQUAL_WEIGHT, riskEstimate } from './benchmark.ts'
import { type Kit, makeKit, settle } from './testkit.ts'
import { holdings } from './valuation.ts'

const FUND = 'amfi:120716', LIQ = 'amfi:118701', GOLD = 'amfi:119788'
const weekday = (d: string): boolean => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return w !== 0 && w !== 6 }

/** A deterministic series: a drift a day and a wobble, on every weekday from `from` to `to`. */
function series(k: Kit, id: string, from: string, to: string, start: number, drift: number, wobble: number): void {
  let v = start, i = 0
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!weekday(d)) continue
    v *= 1 + drift + wobble * Math.sin(i * 1.7 + start)
    i++
    k.db.run('INSERT OR REPLACE INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', id, d, v.toFixed(4), k.clock.now(), 'test')
  }
}
async function buy(k: Kit, ref: string, id: string, rupees: number, date: string): Promise<void> {
  k.clock.set(istInstant(date, '10:30'))
  const nav = k.db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date <= ? ORDER BY value_date DESC LIMIT 1', id, date)!.value
  k.nav(id, date, nav)
  createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-mf', economicId: ref, params: { instrumentId: id, side: 'buy', type: 'nav', amount: String(rupees * 100), purpose: 'manual' }, approvalId: k.approveOwner(`action:${ref}`) })
  await settle(k, 8, 1000)
}
async function world(): Promise<Kit> {
  const k = makeKit({ start: istInstant('2026-06-01', '10:30') })
  series(k, FUND, '2026-04-01', '2026-11-17', 150, 0.0008, 0.006)
  series(k, LIQ, '2026-04-01', '2026-11-17', 7000, 0.00018, 0.00002)
  series(k, GOLD, '2026-04-01', '2026-11-17', 90, 0.0004, 0.004)
  await buy(k, 'a', FUND, 50_000, '2026-06-02')
  await buy(k, 'b', FUND, 30_000, '2026-08-03')
  await buy(k, 'c', GOLD, 20_000, '2026-09-01')
  k.clock.set(istInstant('2026-11-18', '10:30')); k.nav(FUND, '2026-11-17', k.db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date = ?', FUND, '2026-11-17')!.value)
  return k
}
const hs = (k: Kit) => holdings(k.db, k.market, k.userId, k.clock.now())

describe('no benchmark is chosen for the owner', () => {
  it('offers choices, says it does not pick, and compares nothing until one is chosen', async () => {
    const k = await world()
    const c = compare(k.db, k.userId, hs(k), null, k.clock.now())
    expect(c.chosen).toBeNull(); expect(c.windows).toEqual([])
    expect(c.statement).toMatch(/does not choose a benchmark for you/)
    expect(c.choices.some((x) => x.id === EQUAL_WEIGHT)).toBe(true)
    expect(c.choices.filter((x) => x.usable).length).toBeGreaterThan(3)
    expect(c.choices.some((x) => (x as { default?: boolean }).default)).toBe(false)
  })
  it('marks a choice with too little history as unusable, with the reason', async () => {
    const k = await world()
    const bills = benchmarkChoices(k.db).find((x) => x.id === 'gsec:TB91')!
    expect(bills.usable).toBe(false); expect(bills.note).toMatch(/too few to compare/)
    expect(compare(k.db, k.userId, hs(k), 'gsec:TB91', k.clock.now()).method.join(' ')).toMatch(/cannot be used as a benchmark/)
  })
})

describe('the comparison replays the owner\'s flows after costs', () => {
  it('against the same fund the difference is only rounding: the flows and costs are the same on both sides', async () => {
    const k = await world()
    // the fund alone, so the benchmark is exactly what the owner held
    const only = compare(k.db, k.userId, hs(k).filter((h) => h.instrumentId === FUND), FUND, k.clock.now())
    const all = only.windows.find((w) => w.id === 'all')!
    expect(all.from).toBe('2026-06-01')
    // gold was bought too and is part of the owner's book; the difference against the fund is therefore the gold's
    expect(all.ok).toBe(true)
    expect(all.portfolio!.bought).toBeGreaterThan(9_000_000) // ₹80,000 of fund and ₹20,000 of gold, plus stamp duty
    expect(all.benchmark!.costs).toMatch(/buy 0\.005%/)
  })
  it('against a lower-growth benchmark the holdings come out ahead, in rupees and in points, on the same windows', async () => {
    const k = await world()
    const c = compare(k.db, k.userId, hs(k), LIQ, k.clock.now())
    expect(c.chosen).toBe(LIQ)
    const labels = c.windows.map((w) => w.label)
    expect(labels).toEqual(expect.arrayContaining(['The last 90 days', 'Since your first purchase']))
    for (const w of c.windows.filter((x) => x.ok)) {
      expect(w.to).toBe('2026-11-17')
      expect(Math.abs(w.portfolio!.gain - w.benchmark!.gain - w.difference!.rupees)).toBeLessThanOrEqual(1) // each is rounded to the paisa on its own
      // the same denominator on both sides
      expect(Math.abs(w.portfolio!.gain / w.portfolio!.dietz / (w.benchmark!.gain / w.benchmark!.dietz) - 1)).toBeLessThan(1e-4) // gains are rounded to the paisa, the returns are not
    }
    const all = c.windows.find((w) => w.id === 'all')!
    expect(all.difference!.rupees).toBeGreaterThan(0)
    expect(all.portfolio!.dietz).toBeGreaterThan(all.benchmark!.dietz)
    // the window that starts after the first purchase carries the starting value over
    const ninety = c.windows.find((w) => w.id === '90d')!
    expect(ninety.portfolio!.startValue).toBeGreaterThan(0)
  })
  it('states the uncertainty: observations, a standard error, an interval, and whether there are enough days', async () => {
    const k = await world()
    const w = compare(k.db, k.userId, hs(k), LIQ, k.clock.now()).windows.find((x) => x.id === 'all')!
    expect(w.observations).toBeGreaterThan(100)
    expect(w.active!.se).toBeGreaterThan(0)
    expect(w.active!.annualisedLow).toBeLessThan(w.active!.annualisedHigh)
    expect(w.active!.enough).toBe(true)
    const thirty = compare(k.db, k.userId, hs(k), LIQ, k.clock.now()).windows.find((x) => x.id === '30d')!
    expect(thirty.active!.enough).toBe(false) // twenty-odd days say very little
    expect(compare(k.db, k.userId, hs(k), LIQ, k.clock.now()).method.join(' ')).toMatch(/independent.*too narrow/)
  })
  it('the equal-weight benchmark is built from what was held and says it ignores costs', async () => {
    const k = await world()
    const c = compare(k.db, k.userId, hs(k), EQUAL_WEIGHT, k.clock.now())
    expect(c.windows.find((w) => w.id === 'all')!.ok).toBe(true)
    expect(c.windows.find((w) => w.id === 'all')!.benchmark!.costs).toBe('buy 0.000%, sell 0.000%')
    expect(benchmarkChoices(k.db).find((x) => x.id === EQUAL_WEIGHT)!.note).toMatch(/ignores trading costs/)
  })
  it('with nothing bought there is nothing to compare, and says so', () => {
    const k = makeKit(); series(k, LIQ, '2026-09-01', '2026-11-17', 7000, 0.0002, 0.00002)
    const c = compare(k.db, k.userId, [], LIQ, k.clock.now())
    expect(c.windows[0]!.ok).toBe(false); expect(c.windows[0]!.why).toMatch(/bought nothing/)
  })
})

describe('risk estimates are estimates, never limits', () => {
  it('gives a value at risk and an expected shortfall with method, window and confidence, and says what they are not', async () => {
    const k = await world()
    const r = riskEstimate(k.db, hs(k))
    expect(r.ok).toBe(true)
    expect(r.confidence).toBe(0.95); expect(r.horizon).toBe('one day')
    expect(r.method).toMatch(/Historical simulation.*5th-percentile.*average of the days at or below/)
    expect(r.window!.observations).toBeGreaterThanOrEqual(60); expect(r.window!.observations).toBeLessThanOrEqual(250)
    expect(r.var!.fraction).toBeGreaterThan(0)
    expect(r.cvar!.fraction).toBeGreaterThanOrEqual(r.var!.fraction)
    expect(-r.worstDay!.fraction).toBeGreaterThanOrEqual(r.cvar!.fraction - 1e-12) // the worst day is at least as bad as the average of the tail
    expect(r.says).toMatch(/not limits and not protections/)
    expect(r.says).toMatch(/worse than any of them can come/)
    expect(r.covered.share).toBeGreaterThan(0.99)
  })
  it('refuses to estimate on too little history, and lists what it left out', () => {
    const k = makeKit()
    const r = riskEstimate(k.db, [])
    expect(r.ok).toBe(false); expect(r.why).toMatch(/daily price history/); expect(r.var).toBeUndefined()
  })
  it('the risk certificate in the lab no longer reads as a bound on a bad month', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('./lab.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/at most 10% \(95% CVaR\)/)
    expect(src).toMatch(/estimate, never a limit/)
  })
})
