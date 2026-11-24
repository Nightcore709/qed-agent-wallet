/**
 * Reading ideas and judging them on the record (shared/ideaParse.ts, shared/ideaEval.ts), including a seeded fault for
 * each rule: a price after a window's end leaking into it, costs or tax not charged, a claim made on too short a
 * record or without counting the comparisons, a figure that is not the instrument's but its name's. SYNTHETIC series.
 */
import { describe, expect, it } from 'vitest'
import { amountOf, PICKS, readIdea } from './ideaParse.ts'
import { difference, monthly, type Plan, rolling, type Series, stress, taxOn } from './ideaEval.ts'

const INV = [
  { id: 'amfi:120716', name: 'UTI Nifty 50 Index Fund (Direct, Growth)', kind: 'mutual_fund', category: 'index' },
  { id: 'amfi:120684', name: 'ICICI Prudential Nifty Next 50 Index Fund (Direct, Growth)', kind: 'mutual_fund', category: 'index' },
  { id: 'amfi:122639', name: 'Parag Parikh Flexi Cap Fund (Direct, Growth)', kind: 'mutual_fund', category: 'flexi' },
  { id: 'amfi:118701', name: 'Nippon India Liquid Fund (Direct, Growth)', kind: 'mutual_fund', category: 'liquid' },
  { id: 'coindcx:BTCINR', name: 'Bitcoin in rupees', kind: 'crypto_spot' },
]

describe('reading an idea', () => {
  it('reads the four picks without a guess', () => {
    const [a, b, c, d] = PICKS.map((p) => readIdea(p, INV))
    expect(a!.plan).toEqual({ action: 'buy', instrumentId: 'amfi:120716', amount: 5_000_000, cadence: null })
    expect(a!.questions.map((q) => q.key)).toEqual(['cadence']) // once or monthly is asked, not assumed
    expect(b!.plan).toEqual({ action: 'buy', instrumentId: 'amfi:122639', amount: 500_000, cadence: 'monthly' })
    expect(c!.plan).toEqual({ action: 'buy', instrumentId: 'coindcx:BTCINR', amount: 200_000, cadence: null })
    expect(d!.plan).toEqual({ action: 'park', instrumentId: 'amfi:118701', amount: null, cadence: 'once' })
    expect(d!.questions.map((q) => q.text)).toEqual(['How much of your free money?']) // what is free is shown; how much is the owner's
  })
  it('a number in a fund\'s name is not an amount (seeded fault: "Nifty 50" read as ₹50)', () => {
    expect(readIdea('put money into the nifty 50', INV).plan.amount).toBeNull()
    expect(readIdea('nifty next 50 for 10k', INV).plan).toMatchObject({ instrumentId: 'amfi:120684', amount: 1_000_000 })
  })
  it('amounts as people write them', () => {
    expect(amountOf('5 lakh')).toBe(50_000_000)
    expect(amountOf('₹1.5 lakh')).toBe(15_000_000)
    expect(amountOf('50k')).toBe(5_000_000)
    expect(amountOf('1,50,000')).toBe(15_000_000)
    expect(amountOf('Rs. 2500.50')).toBe(250_050)
    expect(amountOf('12% a year')).toBeNull()
  })
  it('asks which index fund rather than choosing one, and asks what is missing', () => {
    const r = readIdea('₹10,000 into an index fund every month', INV)
    expect(r.plan.instrumentId).toBeNull()
    expect(r.questions[0]).toMatchObject({ key: 'instrument', text: 'Which index fund?' })
    expect(r.questions[0]!.choices!.map((c) => c.value)).toEqual(['amfi:120716', 'amfi:120684'])
    expect(readIdea('invest something', INV).questions.map((q) => q.key)).toEqual(['instrument', 'amount', 'cadence'])
  })
  it('refuses what this journey does not do, and says where to go', () => {
    expect(readIdea('sell my bitcoin', INV).refusal).toMatch(/Buy or sell/)
    expect(readIdea('buy nifty futures with leverage', INV).refusal).toMatch(/does not borrow/)
  })
})

/** A synthetic daily record: weekdays from 2023-01-02, a steady drift with a wobble. */
function series(id: string, days: number, drift: number, wobble: number, start = 100): Series {
  const dates: string[] = [], values: number[] = []
  for (let k = 0; k < days; k++) {
    const d = new Date(Date.UTC(2023, 0, 2) + k * 86_400_000)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
    dates.push(d.toISOString().slice(0, 10)); values.push(start * Math.exp(drift * k + wobble * Math.sin(k / 9)))
  }
  return { id, name: id, dates, values }
}
const plan = (id: string, kind: Plan['kind'], legId: string, extra: Partial<Plan> = {}, buyCost = 0.00005, sellCost = 0): Plan => ({ id, label: id, kind, legs: [{ id: legId, weight: 1, taxClass: kind === 'liquid' ? 'debt' : 'equity', buyCost, sellCost }], ...extra })

describe('past windows', () => {
  const A = series('A', 1200, 0.0004, 0.05), L = series('L', 1200, 0.00018, 0.0005)
  const map = new Map([['A', A], ['L', L]])
  it('each window ends no later than the record, and a price after a window\'s end cannot reach it (seeded leak)', () => {
    const base = rolling([plan('idea', 'idea', 'A')], map, 365, 0.0275, { anchor: 'A', maxEnd: '2025-06-30' })!
    const spiked = { ...A, values: A.values.map((v, i) => (A.dates[i]! > '2025-06-30' ? v * 10 : v)) }
    const again = rolling([plan('idea', 'idea', 'A')], new Map([['A', spiked], ['L', L]]), 365, 0.0275, { anchor: 'A', maxEnd: '2025-06-30' })!
    expect(again.plans[0]!.outcomes).toEqual(base.plans[0]!.outcomes)
    expect(base.lastStart <= '2024-06-30').toBe(true)
  })
  it('charges what it costs to get in and out, and tax only on a gain (seeded fault: costs left out)', () => {
    const free = rolling([plan('idea', 'idea', 'A', {}, 0, 0)], map, 365, 0.0275, { anchor: 'A' })!
    const paid = rolling([plan('idea', 'idea', 'A', {}, 0.005, 0.005)], map, 365, 0.0275, { anchor: 'A' })!
    expect(paid.plans[0]!.median).toBeLessThan(free.plans[0]!.median)
    expect(taxOn(-100, 400, 'equity')).toBe(0)
    expect(taxOn(100, 300, 'equity')).toBeCloseTo(20.8, 10)
    expect(taxOn(100, 400, 'equity')).toBeCloseTo(13, 10)
    expect(taxOn(100, 400, 'vda')).toBeCloseTo(31.2, 10)
  })
  it('every plan is judged on the same windows: a plan with a shorter record shortens them all (seeded fault: unequal windows)', () => {
    const late = { ...L, dates: L.dates.slice(300), values: L.values.slice(300) }
    const r = rolling([plan('idea', 'idea', 'A'), plan('late', 'liquid', 'L')], new Map([['A', A], ['L', late]]), 365, 0.0275, { anchor: 'A' })!
    expect(r.plans[0]!.outcomes.length).toBe(r.windows)
    expect(r.plans[1]!.outcomes.length).toBe(r.windows)
    // a price within the week of a window's start is its price: no window starts more than six days before the later record
    expect(r.firstStart >= new Date(Date.parse(`${late.dates[0]}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)).toBe(true)
    expect(r.firstStart > A.dates[0]!).toBe(true)
  })
  it('"do nothing" is the savings rate after tax, in every window; a spread over one month is the lump sum', () => {
    const r = rolling([plan('idea', 'idea', 'A'), { id: 'cash', label: 'cash', kind: 'cash', legs: [] }, plan('spread1', 'spread', 'A', { spreadMonths: 1 })], map, 365, 0.0275, { anchor: 'A' })!
    const cash = r.plans.find((p) => p.id === 'cash')!
    expect(new Set(cash.outcomes).size).toBe(1)
    expect(cash.outcomes[0]).toBeCloseTo(1 + 0.0275 * (1 - 0.3 * 1.04), 10)
    expect(r.plans.find((p) => p.id === 'spread1')!.outcomes).toEqual(r.plans[0]!.outcomes)
  })
})

describe('claims the record can bear', () => {
  const noise = (n: number, seed: number) => { let a = seed; return Array.from({ length: n }, () => { a = (a * 1103515245 + 12345) % 2 ** 31; return (a / 2 ** 31 - 0.5) * 0.08 }) }
  it('no claim on fewer than 36 months, however large the difference (seeded fault: a 20-month claim)', () => {
    const b = noise(20, 1), a = b.map((x) => x + 0.03)
    const d = difference(a, b)
    expect(d.tooShort).toBe(true)
    expect(d.detectable).toBe(false)
  })
  it('a real difference over enough months is detectable; nothing is detected between equal series', () => {
    const b = noise(120, 2)
    expect(difference(b.map((x) => x + 0.02), b).detectable).toBe(true)
    expect(difference(b, b)).toMatchObject({ yearly: 0, detectable: false })
  })
  it('counting the comparisons can withdraw a claim (seeded fault: one test of many reported alone)', () => {
    const b = noise(60, 3), a = b.map((x, i) => x + 0.004 + (i % 2 ? 0.01 : -0.01))
    const single = difference(a, b, { familyAlpha: 0.05 }), many = difference(a, b, { familyAlpha: 0.05 / 1000 })
    expect(single.yearly).toBeCloseTo(many.yearly, 12)
    expect(!many.detectable || single.detectable).toBe(true) // a stricter family level never detects what the single test did not
  })
  it('monthly returns leave the month in progress out', () => {
    const m = monthly(series('A', 100, 0.001, 0), '2023-04')
    expect(m.months.every((x) => x < '2023-04')).toBe(true)
  })
  it('stress names the worst past window, the worst month and the limit fall, in rupees', () => {
    const r = rolling([plan('idea', 'idea', 'A')], new Map([['A', series('A', 900, 0.0002, 0.08)]]), 180, 0.0275, { anchor: 'A' })!
    const s = stress(5_000_000, r.plans[0]!, monthly(series('A', 900, 0.0002, 0.08), '2099-01'), 0.25, 'modelled')
    expect(s.map((x) => x.label)).toEqual(['The worst past window', 'The worst past month, at once', 'A fall by its limit'])
    expect(s[2]!.loss).toBe(1_250_000)
    expect(s[2]!.note).toMatch(/illustrative/)
  })
})
