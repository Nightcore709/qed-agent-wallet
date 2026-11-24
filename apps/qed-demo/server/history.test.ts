/**
 * The price record a chart draws (`history`, GET /api/market/history). A fund's NAV is published once a business day
 * and holds until the next, so the chart draws each one as a step: every published value of the period asked for must
 * be sent, or a step would hold a NAV for days it was not the NAV (R12: daily NAVs as steps, never interpolated). Until
 * 24 Nov 2026 a daily series was thinned above 600 values, so three years of NAVs (about 740) came as every second one.
 */
import { describe, expect, it } from 'vitest'
import { openDb } from './core.ts'
import { seedRegistry } from './registry.ts'
import { DAILY_POINTS, history } from './views.ts'

const DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
/** Business days (Monday to Friday) from `days` ago to yesterday, each with a NAV. */
function navs(days: number): string[] {
  const out: string[] = []
  for (let k = days - 1; k >= 1; k--) { const t = Date.now() - k * DAY; const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(iso(t)) }
  return out
}

describe('the price record of a fund (published once a business day)', () => {
  it('sends every NAV of three years, so each can be drawn as the step it was', () => {
    const db = openDb(':memory:'); seedRegistry(db)
    const days = navs(1095)
    expect(days.length).toBeGreaterThan(700)
    days.forEach((d, i) => db.run('INSERT INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', 'amfi:120716', d, (150 + i / 100).toFixed(4), Date.now(), 'test'))
    const h = history(db, 'amfi:120716', { days: 1095 }) as { kind: string; priceType: string; points: { t: string; v: number }[]; observations: number; step: number }
    expect(h).toMatchObject({ kind: 'daily', priceType: 'nav', step: 1 })
    expect(h.points).toHaveLength(h.observations)
    // every published day, in order, none skipped
    expect(h.points.map((p) => p.t)).toEqual(days.filter((d) => d >= iso(Date.now() - 1095 * DAY)))
  })

  it('says how it thinned a series longer than it sends whole, and keeps the last value', () => {
    const db = openDb(':memory:'); seedRegistry(db)
    // more published values than are sent whole: one a day for 5,000 days
    for (let k = 4999; k >= 1; k--) db.run('INSERT INTO daily_values (instrument_id, value_date, value, recv_ts, source) VALUES (?, ?, ?, ?, ?)', 'amfi:120716', iso(Date.now() - k * DAY), '100.0000', Date.now(), 'test')
    const h = history(db, 'amfi:120716', { days: 5000 }) as { points: { t: string }[]; observations: number; step: number; to: string }
    expect(h.observations).toBeGreaterThan(DAILY_POINTS)
    expect(h.step).toBe(Math.ceil(h.observations / DAILY_POINTS))
    expect(h.points.length).toBeLessThanOrEqual(DAILY_POINTS + 1)
    expect(h.points[h.points.length - 1]!.t).toBe(h.to)
  })
})
