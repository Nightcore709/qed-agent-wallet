/**
 * The price chart's arithmetic and drawing, and the market tables' figures. A price is written as the venue quotes it,
 * at the venue's own step, with the same number of decimals every time, so a figure that changes never changes its
 * width; a quantity is written at its own step and never rounded. A stretch with nothing recorded is drawn as a gap,
 * never as a filled shape over the plot (the opaque block over the Bitcoin chart, R10).
 */
import fc from 'fast-check'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dayStart, isoDayOf } from './prices.ts'
import { atomsText, dailyAge, dailyRows, duration, gapAt, gapsOf, heldWords, holdAt, holdsOf, nearestIndex, pointTime, priceDecimals, priceText, publicationMarks, quantityText, readDaily, stretch, TimeChart, timeTicks, valueScale, valueTicks } from './timechart.tsx'

const IST = 19_800_000
const at = (iso: string): number => Date.parse(`${iso}+05:30`)
const istHour = (t: number): number => new Date(t + IST).getUTCHours()

describe('quantities at their own step', () => {
  it('are written to the step, never with fewer places than the record, and grouped the Indian way', () => {
    expect(quantityText('0.00046', 5)).toBe('0.00046')
    expect(quantityText('0.0004', 5)).toBe('0.00040')
    expect(quantityText('16.5', 3)).toBe('16.500')
    expect(quantityText('0.123456789', 5)).toBe('0.123456789') // more places than the step: kept, not rounded away
    expect(quantityText('1234567.25', 3)).toBe('12,34,567.250')
    expect(quantityText('12', 0)).toBe('12')
    expect(quantityText('not a number', 3)).toBe('not a number')
  })
  it('turn a venue\'s smallest units into a decimal', () => {
    expect(atomsText('46000', 8)).toBe('0.00046')
    expect(atomsText('16500', 3)).toBe('16.5')
    expect(atomsText('100000000', 8)).toBe('1')
    expect(atomsText('0', 8)).toBe('0')
    expect(atomsText('250', 0)).toBe('250')
  })
})

describe('a stretch with nothing recorded', () => {
  const t0 = at('2026-11-23T17:58:00')
  // samples every 15 s for about three minutes, nothing for 255 s (the engine stopped), then samples again
  const before = Array.from({ length: 12 }, (_, i) => ({ t: t0 + i * 15_000, v: 6_433_000 + i * 100 }))
  const resumed = before[before.length - 1]!.t + 255_000
  const after = Array.from({ length: 12 }, (_, i) => ({ t: resumed + i * 15_000, v: 6_440_000 + i * 50 }))
  const points = [...before, ...after]
  const draw = (width: number) => renderToStaticMarkup(createElement(TimeChart, { points, show: (v: number) => `₹${v.toFixed(1)}`, tick: (v: number) => `₹${v}`, describe: 'The price buyers offered.', unit: '₹ per BTC', width }))

  it('is found, and a time inside it is known to be inside it', () => {
    const gaps = gapsOf(points.map((p) => p.t))
    expect(gaps).toEqual([[before[11]!.t, resumed]])
    expect(gapAt(gaps, before[11]!.t + 100_000)).toEqual(gaps[0])
    expect(gapAt(gaps, before[11]!.t)).toBeNull()
    expect(gapAt(gaps, resumed)).toBeNull()
    expect(gapAt([], 5)).toBeNull()
  })
  it('is drawn as its two edges and its name, with the line broken there and nothing filled over the plot (the opaque block, R10)', () => {
    const html = draw(640)
    expect(html).toContain('class="tc-gap"')
    expect(html.match(/class="tc-gap-edge"/g)).toHaveLength(2)
    expect(html).toContain('>No record<')
    expect(html).not.toContain('class="gap"')
    // the line is two pieces: it starts again after the stretch instead of joining across it
    const d = /<path class="tc-line" d="([^"]+)"/.exec(html)![1]!
    expect(d.match(/M/g)).toHaveLength(2)
    // the only filled shape is the latest value's tab, inside the value axis to the right of the plot
    const rects = [...html.matchAll(/<rect\b[^>]*?\sx="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(rects).toHaveLength(1)
    expect(rects[0]).toBeGreaterThan(640 - 120)
  })
  it('is told to a screen reader, with how long it lasted', () => {
    expect(draw(640)).toContain('1 stretch with nothing recorded, 4 min in all, where the line stops.')
  })
  it('names both axes: what the values count, and whose clock the times are in', () => {
    const html = draw(360)
    expect(html).toContain('>₹ per BTC<')
    expect(html).toContain('>India time<')
  })
  it('is said in words a person uses', () => {
    expect(duration(50_000)).toBe('50 s')
    expect(duration(255_000)).toBe('4 min')
    expect(duration(2 * 3_600_000 + 10 * 60_000)).toBe('2 h 10 min')
    expect(duration(3 * 3_600_000)).toBe('3 h')
    expect(duration(3 * 86_400_000)).toBe('3 days')
    expect(stretch(at('2026-11-23T18:03:12'), at('2026-11-23T18:07:31'), false)).toBe('18:03 to 18:07 on 23 Nov')
    expect(stretch(at('2026-11-23T23:50:00'), at('2026-11-24T00:10:00'), false)).toBe('23 Nov, 23:50 to 24 Nov, 00:10')
    expect(stretch(pointTime('2026-11-20'), pointTime('2026-11-25'), true)).toBe('Fri 20 Nov 2026 to Wed 25 Nov 2026')
  })
  it('places a daily value at noon India time', () => {
    expect(pointTime('2026-11-20')).toBe(at('2026-11-20T12:00:00'))
    expect(pointTime(1234)).toBe(1234)
  })
})

describe('a chart with too little to draw', () => {
  it('keeps its height and says what will appear there', () => {
    const html = renderToStaticMarkup(createElement(TimeChart, { points: [{ t: 1, v: 2 }], show: String, tick: String, describe: 'x', unit: '₹ per BTC', height: 240, width: 400 }))
    expect(html).toContain('height:240px')
    expect(html).toContain('A line appears once two values have been recorded.')
  })
})

describe('prices at the venue’s step', () => {
  it('take their decimals from the price step', () => {
    expect(priceDecimals('0.1', 2)).toBe(1)
    expect(priceDecimals('0.01', 0)).toBe(2)
    expect(priceDecimals('1', 2)).toBe(0)
    expect(priceDecimals('0.5', 2)).toBe(1)
    expect(priceDecimals('0.00001', 2)).toBe(5)
    expect(priceDecimals(undefined, 4)).toBe(4)
    expect(priceDecimals('not a step', 2)).toBe(2)
  })
  it('always show that many decimals, so a quote that ends in zero keeps its width', () => {
    expect(priceText('6350468.1', 'INR', 1)).toBe('₹63,50,468.1')
    expect(priceText('180000', 'INR', 1)).toBe('₹1,80,000.0')
    expect(priceText('180583.3', 'INR', 1).length).toBe(priceText('180000', 'INR', 1).length)
    expect(priceText('104.1', 'INR', 2)).toBe('₹104.10')
    expect(priceText(4127.1277, 'INR', 4)).toBe('₹4,127.1277')
    expect(priceText('60614.81', 'USD', 2)).toBe('$60,614.81')
    expect(priceText('60708.57000000', 'USDT', 2)).toBe('60,708.57 USDT')
    expect(priceText(null, 'INR', 2)).toBe('no price')
    expect(priceText('', 'INR', 2)).toBe('no price')
  })
})

describe('a record with holes in it', () => {
  it('finds the stretches with nothing recorded: much longer than the usual step, and at least a minute', () => {
    const ts = [0, 1000, 2000, 3000, 200_000, 201_000, 202_000]
    expect(gapsOf(ts)).toEqual([[3000, 200_000]])
    expect(gapsOf([0, 1000, 2000, 3000])).toEqual([])
    // daily values a week apart in places are a gap only beyond six usual steps
    const day = 86_400_000
    expect(gapsOf([0, day, 2 * day, 3 * day, 4 * day, 12 * day])).toEqual([[4 * day, 12 * day]])
  })
  it('reads the nearest recorded point to a time', () => {
    expect(nearestIndex([0, 10, 20, 30], 14)).toBe(1)
    expect(nearestIndex([0, 10, 20, 30], 16)).toBe(2)
    expect(nearestIndex([0, 10, 20, 30], -5)).toBe(0)
    expect(nearestIndex([0, 10, 20, 30], 99)).toBe(3)
  })
})

describe('the time axis', () => {
  it('over a day, marks round hours in India time and names the new day at midnight', () => {
    const t0 = at('2026-11-22T00:12:00'), t1 = at('2026-11-23T00:12:00')
    const ticks = timeTicks(t0, t1, 8)
    expect(ticks.length).toBeGreaterThan(3)
    expect(ticks.length).toBeLessThanOrEqual(9)
    for (const k of ticks) { expect(k.t).toBeGreaterThanOrEqual(t0); expect(k.t).toBeLessThanOrEqual(t1) }
    const midnight = ticks.find((k) => k.t === at('2026-11-23T00:00:00'))
    expect(midnight).toMatchObject({ label: 'Mon 23 Nov', major: true })
    for (const k of ticks.filter((x) => !x.major)) { expect(k.label).toMatch(/^\d\d:00$/); expect(istHour(k.t) % 3).toBe(0) }
  })
  it('over an hour or so, marks quarter hours, and still names the new day at midnight', () => {
    const ticks = timeTicks(at('2026-11-22T23:12:00'), at('2026-11-23T00:21:00'), 6)
    expect(ticks.map((k) => k.label)).toEqual(['23:15', '23:30', '23:45', 'Mon 23 Nov', '00:15'])
    expect(ticks.find((k) => k.label === 'Mon 23 Nov')!.major).toBe(true)
  })
  it('over a week, marks each day', () => {
    const ticks = timeTicks(at('2026-11-15T23:40:00'), at('2026-11-22T23:40:00'), 8)
    expect(ticks.map((k) => k.label)).toEqual(['Mon 16', 'Tue 17', 'Wed 18', 'Thu 19', 'Fri 20', 'Sat 21', 'Sun 22'])
  })
  it('over a year, marks months, with the year where it turns', () => {
    const ticks = timeTicks(at('2025-11-22T12:00:00'), at('2026-11-22T12:00:00'), 7)
    expect(ticks.length).toBeLessThanOrEqual(7)
    expect(ticks.some((k) => k.label === 'Jan 2026' && k.major)).toBe(true)
    for (const k of ticks) expect(new Date(k.t + IST).getUTCDate()).toBe(1)
  })
  it('over three years, marks years', () => {
    const ticks = timeTicks(at('2023-11-22T12:00:00'), at('2026-11-22T12:00:00'), 7)
    expect(ticks.filter((k) => k.major).map((k) => k.label)).toEqual(['2024', '2025', '2026'])
  })
})

describe('a scale that means something (R11)', () => {
  // the 24-hour Bitcoin chart of 24 Nov: a 10-paise change on ₹64 lakh was drawn from the bottom of the plot to its
  // top, with axis steps of 2 paise, finer than the venue's own step of 10 paise
  const flat = [6_430_938.0, 6_430_938.1, 6_430_938.0, 6_430_938.1, 6_430_938.0]
  it('spans at least 1% of the latest value, centred on what was recorded', () => {
    const s = valueScale(flat)
    expect(s.hi - s.lo).toBeGreaterThanOrEqual(6_430_938 * 0.01)
    expect((s.hi + s.lo) / 2).toBeCloseTo(6_430_938.05, 1)
    // so a move of 10 paise is drawn as a sliver of the height, not all of it
    expect(0.1 / (s.hi - s.lo)).toBeLessThan(0.0001)
  })
  it('never labels the axis in steps finer than whole rupees for a price of lakhs', () => {
    const s = valueScale(flat)
    const t = valueTicks(s.lo, s.hi, 4)
    expect(t.decimals).toBe(0)
    expect(t.values.length).toBeGreaterThanOrEqual(2)
    expect(t.values[1]! - t.values[0]!).toBeGreaterThanOrEqual(10_000)
  })
  it('leaves a range wider than 1% as it is, with a little room above and below', () => {
    const s = valueScale([100, 104, 110])
    expect(s.lo).toBeLessThan(100)
    expect(s.hi).toBeGreaterThan(110)
    expect(s.hi - s.lo).toBeLessThan(12) // 10 recorded, 8% room each side
  })
  it('takes a level near the line into the scale, and names one far from it at the edge instead of squeezing the line', () => {
    const near = valueScale([100, 102, 101], 0.01, [104])
    expect(near.hi).toBeGreaterThan(104)
    expect(near.above).toEqual([])
    const far = valueScale([100, 102, 101], 0.01, [150, 40])
    expect(far.hi).toBeLessThan(110)
    expect(far.lo).toBeGreaterThan(90)
    expect(far.above).toEqual([150])
    expect(far.below).toEqual([40])
  })
})

describe('a level drawn for comparison (what was paid)', () => {
  const t0 = at('2026-11-24T02:48:00')
  const points = Array.from({ length: 20 }, (_, i) => ({ t: t0 + i * 60_000, v: 6_430_000 + (i % 5) * 4_000 }))
  const draw = (levels: { v: number; label: string }[]) => renderToStaticMarkup(createElement(TimeChart, { points, levels, show: (v: number) => `₹${v.toFixed(1)}`, tick: (v: number) => `₹${v}`, describe: 'The price buyers offered.', unit: '₹ per BTC', width: 640 }))
  it('is a dashed line across the plot with its name, and is said to a screen reader', () => {
    const html = draw([{ v: 6_488_333.3, label: 'You paid ₹64,88,333.3' }])
    expect(html).toContain('class="tc-level"')
    expect(html).toContain('>You paid ₹64,88,333.3<')
    expect(html).toMatch(/<title[^>]*>[^<]*You paid ₹64,88,333\.3\.<\/title>/)
  })
  it('far from the line, is named at the edge it lies beyond, with no line drawn', () => {
    const html = draw([{ v: 9_000_000, label: 'You paid ₹90,00,000.0' }])
    expect(html).not.toContain('class="tc-level"')
    expect(html).toContain('class="tc-level-far"')
    expect(html).toContain('↑ You paid ₹90,00,000.0')
  })
  it('adds no filled shape over the plot: the only one is still the latest value\'s tab, beside it', () => {
    const html = draw([{ v: 6_488_333.3, label: 'You paid ₹64,88,333.3' }])
    const rects = [...html.matchAll(/<rect\b[^>]*?\sx="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(rects).toHaveLength(1)
    expect(rects[0]).toBeGreaterThan(640 - 120)
  })
  it('draws the line inside the group that is revealed on arrival, whole: the clip moves, the values do not', () => {
    const html = draw([])
    expect(html).toMatch(/<g class="tc-reveal"><path class="tc-glow" d="M[^"]+"[^>]*><\/path><path class="tc-line" d="M[^"]+"><\/path><\/g>/)
    // no reading is shown until the line is pointed at, touched or focused
    expect(html).not.toContain('tc-tip')
    expect(html).toContain('Point at the line, or touch it, to read a value.')
  })
})

describe('a fund’s NAV, published once a business day and held until the next: drawn as steps (R12)', () => {
  // the NAVs for Mon 16 to Fri 20 Nov 2026 and Mon 23 Nov 2026; the weekend between has none
  const navs = [['2026-11-16', 180.1023], ['2026-11-17', 181.2114], ['2026-11-18', 179.9027], ['2026-11-19', 179.7634], ['2026-11-20', 181.7794], ['2026-11-23', 178.5983]].map(([t, v]) => ({ t: t as string, v: v as number }))
  const now = at('2026-11-24T13:10:00') // Tuesday, before that day's NAV is published
  const draw = (points = navs, width = 640) => renderToStaticMarkup(createElement(TimeChart, { points, show: (v: number) => `₹${v.toFixed(4)}`, tick: (v: number) => `₹${v}`, describe: 'The NAV published for each business day.', unit: '₹ per unit', width, valueWord: 'NAV', until: now }))

  it('holds each NAV from the start of its day (India time) until the next NAV’s day begins: Friday’s through the weekend, the latest until now', () => {
    const hs = holdsOf(navs, now)
    expect(hs.map((h) => h.from)).toEqual(navs.map((n) => at(`${n.t}T00:00:00`)))
    expect(hs.slice(0, -1).map((h, i) => h.to)).toEqual(hs.slice(1).map((h) => h.from)) // no gap and no overlap between steps
    expect([hs[4]!.from, hs[4]!.to]).toEqual([at('2026-11-20T00:00:00'), at('2026-11-23T00:00:00')])
    expect(hs[5]!.to).toBe(now)
    // read before the latest day is over, the latest holds to the end of its own day
    expect(holdsOf(navs, at('2026-11-23T21:30:00'))[5]!.to).toBe(at('2026-11-24T00:00:00'))
  })

  it('reads the NAV in force at a time: on its own day the NAV for that day; on a weekend Friday’s; after the latest, the latest; never a value between two', () => {
    const hs = holdsOf(navs, now)
    expect(readDaily(hs, at('2026-11-18T08:00:00'))).toEqual({ kind: 'point', i: 2 })
    expect(readDaily(hs, at('2026-11-21T15:00:00'))).toEqual({ kind: 'held', i: 4, t: at('2026-11-21T15:00:00') })
    expect(readDaily(hs, at('2026-11-22T23:59:00'))).toMatchObject({ kind: 'held', i: 4 })
    expect(readDaily(hs, at('2026-11-23T00:00:00'))).toEqual({ kind: 'point', i: 5 })
    expect(readDaily(hs, at('2026-11-24T10:00:00'))).toMatchObject({ kind: 'held', i: 5 })
    expect(readDaily(hs, at('2026-11-15T12:00:00'))).toBeNull() // before the record
    expect(holdAt(hs, at('2026-11-25T09:00:00'))).toBeNull() // after now: nothing is drawn or read
  })

  it('at any moment of any record, what is read is exactly the latest value published on or before that day (property, 300 records)', () => {
    const series = fc.uniqueArray(fc.integer({ min: 0, max: 400 }), { minLength: 2, maxLength: 60 }).chain((days) => fc.tuple(
      fc.constant([...days].sort((a, b) => a - b)),
      fc.array(fc.integer({ min: 1_000_000, max: 9_999_999 }), { minLength: days.length, maxLength: days.length }),
      fc.double({ min: 0, max: 1, noNaN: true }),
    ))
    fc.assert(fc.property(series, ([days, values, f]) => {
      const base = dayStart('2025-01-01')
      const points = days.map((d, i) => ({ t: isoDayOf(base + d * 86_400_000 + 3_600_000), v: values[i]! / 10_000 }))
      const until = dayStart(points[points.length - 1]!.t) + 2.5 * 86_400_000
      const hs = holdsOf(points, until)
      const t = hs[0]!.from + f * (until - 1 - hs[0]!.from)
      const r = readDaily(hs, t)
      const day = isoDayOf(t)
      const latest = points.filter((p) => p.t <= day).pop()!
      const inGap = gapsOf(points.map((p) => dayStart(p.t))).some(([a, b]) => hs.find((h) => h.from === a)!.to <= t && t < b)
      if (inGap) return r === null
      return r !== null && points[r.i]!.v === latest.v && points[r.i]!.t === latest.t && (r.kind === 'point') === (latest.t === day)
    }), { numRuns: 300 })
  })

  it('is drawn as levels and risers only: one level for each NAV at its exact value, a thin vertical riser between two, no slope anywhere', () => {
    const html = draw()
    expect(html).toContain('class="tchart tc-steps tc-marks-dots"')
    const line = /<path class="tc-line" d="([^"]+)"/.exec(html)![1]!
    expect(line.replace(/M[\d.]+ [\d.]+H[\d.]+/g, '')).toBe('') // nothing but horizontal levels
    expect(line.match(/M/g)).toHaveLength(navs.length)
    // each level is drawn at its own NAV's height, ordered as the NAVs are (higher value, smaller y)
    const ys = [...line.matchAll(/M[\d.]+ ([\d.]+)H/g)].map((m) => Number(m[1]))
    for (let i = 1; i < navs.length; i++) expect(Math.sign(ys[i - 1]! - ys[i]!)).toBe(Math.sign(navs[i]!.v - navs[i - 1]!.v))
    const risers = /<path class="tc-riser" d="([^"]+)"/.exec(html)![1]!
    expect(risers.replace(/M[\d.]+ [\d.]+V[\d.]+/g, '')).toBe('') // nothing but vertical jumps
    expect(risers.match(/M/g)).toHaveLength(navs.length - 1)
    // every riser stands where a level ends and the next begins
    const ends = [...line.matchAll(/H([\d.]+)/g)].map((m) => m[1])
    const rx = [...risers.matchAll(/M([\d.]+) /g)].map((m) => m[1])
    expect(rx).toEqual(ends.slice(0, -1))
  })

  it('marks each day a NAV was published: a dot on its step with room for one, a tick on the axis when close, none when they would merge', () => {
    expect(publicationMarks(640, 60)).toBe('dots')
    expect(publicationMarks(640, 247)).toBe('ticks')
    expect(publicationMarks(640, 740)).toBe('none')
    const html = draw()
    const dots = /<path class="tc-pub" d="([^"]+)"/.exec(html)![1]!
    expect(dots.match(/M/g)).toHaveLength(navs.length)
    // a year of business days at 300 px: ticks on the time axis, one per NAV
    const year: { t: string; v: number }[] = []
    for (let k = 0, d = dayStart('2025-11-24'); year.length < 120; k++, d += 86_400_000) { const wd = new Date(d + 19_800_000).getUTCDay(); if (wd !== 0 && wd !== 6) year.push({ t: isoDayOf(d), v: 150 + (k % 7) }) }
    const ticks = /<path class="tc-pub-ticks" d="([^"]+)"/.exec(draw(year, 400))
    expect(ticks).not.toBeNull()
    expect(ticks![1]!.match(/M/g)).toHaveLength(year.length)
  })

  it('names the day each NAV is for, says it is drawn as steps, and adds no filled shape over the plot', () => {
    const html = draw()
    expect(html).toMatch(/<title[^>]*>[^<]*Drawn as steps: each of the 6 published values holds from its day until the next is published; a jump is a new value, never a slope\.[^<]*the latest is the NAV for Mon 23 Nov 2026: ₹178\.5983\./)
    const rects = [...html.matchAll(/<rect\b[^>]*?\sx="([\d.]+)"/g)].map((m) => Number(m[1]))
    expect(rects).toHaveLength(1)
    expect(rects[0]).toBeGreaterThan(640 - 120)
  })

  it('does not carry a NAV across a long silence in the record: it holds its own day, the silence is a gap, the line starts again after it', () => {
    const silent = [...navs.slice(0, 5), { t: '2026-12-10', v: 182.1 }, { t: '2026-12-11', v: 182.6 }]
    const hs = holdsOf(silent, at('2026-12-11T20:00:00'))
    expect(hs[4]).toMatchObject({ day: '2026-11-20', to: at('2026-11-21T00:00:00'), next: null })
    expect(readDaily(hs, at('2026-11-30T12:00:00'))).toBeNull()
    const html = renderToStaticMarkup(createElement(TimeChart, { points: silent, show: String, tick: String, describe: 'x', unit: '₹ per unit', width: 640, valueWord: 'NAV', until: at('2026-12-11T20:00:00'), gapWhy: 'nothing was published' }))
    expect(html).toContain('class="tc-gap"')
    expect(/<path class="tc-riser" d="([^"]+)"/.exec(html)![1]!.match(/M/g)).toHaveLength(silent.length - 2) // no riser across the gap
  })

  it('lists every NAV in its table, exactly: the day it is for, its value, and the days it held', () => {
    const rows = dailyRows(holdsOf(navs, now))
    expect(rows.filter((r) => r.kind === 'value').map((r) => (r.kind === 'value' ? [r.day, r.v] : null))).toEqual(navs.map((n) => [n.t, n.v]))
    expect(rows[3]).toEqual({ kind: 'value', day: '2026-11-19', v: 179.7634, held: '' })
    expect(rows[4]).toEqual({ kind: 'value', day: '2026-11-20', v: 181.7794, held: 'held through Sun 22 Nov' })
    expect(rows[5]).toEqual({ kind: 'value', day: '2026-11-23', v: 178.5983, held: 'the latest: it holds until the next is published' })
    const silent = dailyRows(holdsOf([...navs.slice(0, 5), { t: '2026-12-10', v: 182.1 }], at('2026-12-10T20:00:00')))
    expect(silent).toContainEqual({ kind: 'gap', from: '2026-11-21', to: '2026-12-09' })
    expect(heldWords(holdsOf(navs, now)[0]!, false)).toBe('')
  })

  it('says a NAV is stale only when the server says so, and then how old the day it is for is', () => {
    expect(dailyAge('2026-11-23', now, false)).toBe('the latest published')
    expect(dailyAge('2026-11-18', now, true)).toBe('stale: for a day 6 days ago, and nothing newer published')
  })
})
