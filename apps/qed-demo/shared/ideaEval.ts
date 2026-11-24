/**
 * What the recorded prices say about an investment idea and its alternatives (R13 Grow, "critical investigation" and
 * "competing strategies and simple baselines"). Pure functions; server/ideas.ts feeds them the app's own records.
 *
 * Past windows. For every day the record allows, the idea and each alternative are started with the same money and
 * held for the same horizon, then valued net of what it would cost to get out: purchase costs (stamp duty, a venue fee
 * and half the spread), sale costs, and tax on any gain as QED models it (labelled "modelled": not verified against the
 * Income-tax Act 2025, not tax advice). The windows overlap, so the share of windows that lost money describes this
 * record; it is not a probability.
 *
 * Out of sample by construction: nothing is fitted. Each alternative is a fixed rule (do nothing, a liquid fund, equal
 * shares of the growth funds, the household's mix as it stands today), so no parameter is chosen by looking at the
 * outcomes. A window uses no price after its own end (portfolio.test-style leak test in ideaEval.test.ts).
 *
 * A claim needs evidence that can bear it. "Did better" is said only from non-overlapping monthly returns, with at
 * least 36 months, and only when a block-bootstrap interval for the yearly difference excludes zero after dividing 5%
 * by the number of comparisons made (Bonferroni). Otherwise the screen says the record cannot tell, and by how much it
 * could have. Survivorship: the funds are those QED lists today; any that closed or merged are absent from the record,
 * which can flatter the past. Every result carries those words.
 */
import { prng } from './portfolio.ts'

export type TaxClass = 'equity' | 'fof' | 'debt' | 'vda' | 'interest'
export interface Series { id: string; name: string; dates: string[]; values: number[] }
export interface Leg { id: string; weight: number; taxClass: TaxClass; buyCost: number; sellCost: number }
export interface Plan { id: string; label: string; kind: 'idea' | 'spread' | 'liquid' | 'cash' | 'basket' | 'mix'; legs: Leg[]; spreadMonths?: number }

/** Modelled tax on a gain (losses pay nothing here), with the 4% cess; surcharge and exemptions left out. */
export const TAX_RATES: Record<TaxClass, { st: number; lt: number; ltDays: number; words: string; short: string }> = {
  equity: { st: 0.2, lt: 0.125, ltDays: 365, words: 'equity fund: 20% within a year, 12.5% after (the yearly exemption left out)', short: '20% within a year, 12.5% after' },
  fof: { st: 0.3, lt: 0.125, ltDays: 730, words: 'fund of funds: slab rate (taken as 30%) within two years, 12.5% after', short: '30% within two years, 12.5% after' },
  debt: { st: 0.3, lt: 0.3, ltDays: Number.POSITIVE_INFINITY, words: 'debt-like fund: slab rate, taken as 30%', short: '30%, the slab rate' },
  vda: { st: 0.3, lt: 0.3, ltDays: Number.POSITIVE_INFINITY, words: 'digital asset: 30%, losses not set off', short: '30%, losses not set off' },
  interest: { st: 0.3, lt: 0.3, ltDays: Number.POSITIVE_INFINITY, words: 'savings interest: slab rate, taken as 30%', short: '30%, the slab rate' },
}
export const CESS = 1.04
export function taxOn(gain: number, days: number, cls: TaxClass): number {
  if (!(gain > 0)) return 0
  const r = TAX_RATES[cls]
  return gain * (days > r.ltDays ? r.lt : r.st) * CESS
}

const DAY = 86_400_000
const dn = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / DAY

/** The first index whose date is on or after `day` (binary search); -1 if none. */
function atOrAfter(dates: number[], day: number): number {
  let lo = 0, hi = dates.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid]! >= day) { ans = mid; hi = mid - 1 } else lo = mid + 1 }
  return ans
}
/** The last index whose date is on or before `day`; -1 if none. */
function atOrBefore(dates: number[], day: number): number {
  let lo = 0, hi = dates.length - 1, ans = -1
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (dates[mid]! <= day) { ans = mid; lo = mid + 1 } else hi = mid - 1 }
  return ans
}

export interface PlanResult { id: string; label: string; kind: Plan['kind']; outcomes: number[]; median: number; p05: number; worst: number; best: number; lostIn: number }
export interface Rolling { windows: number; firstStart: string; lastStart: string; horizonDays: number; plans: PlanResult[] }

const quantile = (sorted: number[], q: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]! : NaN

/**
 * Every past window of `horizonDays` the record allows, started on each recorded day of the idea's own series (every
 * `step`-th), for each plan: the net value at the end per rupee put in. `cashRate` is the yearly savings rate for "do
 * nothing" (its interest is taxed as interest). A window counts only when every plan can be valued in it (a price
 * within the week at each purchase and at the end), so every plan is judged on the same windows; one whose record is
 * shorter shortens them all, and the caller chooses its alternatives with that in mind.
 */
export function rolling(plans: Plan[], series: Map<string, Series>, horizonDays: number, cashRate: number, opts: { anchor: string; step?: number; maxEnd?: string } = { anchor: '' }): Rolling | null {
  const anchor = series.get(opts.anchor)
  if (!anchor || anchor.dates.length < 2) return null
  const idx = new Map([...series].map(([id, s]) => [id, { d: s.dates.map(dn), v: s.values }]))
  const maxEnd = opts.maxEnd ? dn(opts.maxEnd) : Math.min(...[...idx.values()].map((x) => x.d[x.d.length - 1]!))
  const starts = anchor.dates.map(dn).filter((d, k) => k % (opts.step ?? 1) === 0 && d + horizonDays <= maxEnd)
  if (!starts.length) return null
  const valueOn = (id: string, day: number, after: boolean): number | null => {
    const s = idx.get(id); if (!s) return null
    const k = after ? atOrAfter(s.d, day) : atOrBefore(s.d, day)
    if (k < 0 || (after ? s.d[k]! > day + 6 : s.d[k]! < day - 6)) return null // a price within the week, else none
    return s.v[k]!
  }
  const cash = (days: number) => { const g = Math.pow(1 + cashRate, days / 365) - 1; return 1 + g - taxOn(g, days, 'interest') }
  const one = (p: Plan, start: number): number | null => {
    const end = start + horizonDays
    if (p.kind === 'cash') return cash(horizonDays)
    const tranches = p.kind === 'spread' ? Math.max(1, p.spreadMonths ?? 6) : 1
    let total = 0
    for (let k = 0; k < tranches; k++) {
      const t0 = start + k * 30
      const part = 1 / tranches
      // money waiting for its tranche earns the savings rate
      const waited = k ? cash(k * 30) : 1
      for (const l of p.legs) {
        const a = valueOn(l.id, t0, true), b = valueOn(l.id, end, false)
        if (a === null || b === null) return null
        const put = part * waited * l.weight
        const units = (put * (1 - l.buyCost)) / a
        const gross = units * b
        const sold = gross * (1 - l.sellCost)
        total += sold - taxOn(sold - put, end - t0, l.taxClass)
      }
    }
    return total
  }
  const rows = new Map(plans.map((p) => [p.id, [] as number[]]))
  let used = 0
  const usedStarts: number[] = []
  for (const s of starts) {
    const vals = plans.map((p) => one(p, s))
    if (vals.some((v) => v === null)) continue
    used++; usedStarts.push(s)
    plans.forEach((p, i) => rows.get(p.id)!.push(vals[i]!))
  }
  if (!used) return null
  const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10)
  return {
    windows: used, firstStart: iso(usedStarts[0]!), lastStart: iso(usedStarts[usedStarts.length - 1]!), horizonDays,
    plans: plans.map((p) => {
      const o = rows.get(p.id)!
      const s = [...o].sort((a, b) => a - b)
      return { id: p.id, label: p.label, kind: p.kind, outcomes: o, median: quantile(s, 0.5), p05: quantile(s, 0.05), worst: s[0] ?? NaN, best: s[s.length - 1] ?? NaN, lostIn: o.length ? o.filter((x) => x < 1).length / o.length : NaN }
    }),
  }
}

/** Month-end values (the last recorded value of each calendar month) and the returns between them; the month in
 *  progress is left out. */
export function monthly(s: Series, through: string): { months: string[]; r: number[] } {
  const ends = new Map<string, number>()
  s.dates.forEach((d, i) => { if (d.slice(0, 7) < through) ends.set(d.slice(0, 7), s.values[i]!) })
  const months = [...ends.keys()].sort()
  const r: number[] = []
  for (let k = 1; k < months.length; k++) r.push(ends.get(months[k]!)! / ends.get(months[k - 1]!)! - 1)
  return { months: months.slice(1), r }
}

export interface Difference { months: number; yearly: number; lo: number; hi: number; mde: number; tooShort: boolean; detectable: boolean }
/**
 * The yearly difference in mean monthly return of `a` over `b` (paired months), with a circular block bootstrap: a 95%
 * interval and the minimum detectable difference (about 2.8 standard errors); "detectable" only with `minMonths` or
 * more and when the interval at `familyAlpha` (5% divided by the number of comparisons) excludes zero.
 */
export function difference(a: number[], b: number[], opts: { familyAlpha?: number; minMonths?: number; reps?: number; block?: number; seed?: number } = {}): Difference {
  const n = Math.min(a.length, b.length)
  const d = Array.from({ length: n }, (_, i) => a[a.length - n + i]! - b[b.length - n + i]!)
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1)
  const yearly = mean(d) * 12
  const reps = opts.reps ?? 2000, block = Math.max(1, Math.min(opts.block ?? 3, n || 1)), rnd = prng(opts.seed ?? 20261124)
  const boot: number[] = []
  for (let r = 0; r < reps && n > 1; r++) {
    let s = 0, k = 0
    while (k < n) { const st = Math.floor(rnd() * n); for (let j = 0; j < block && k < n; j++, k++) s += d[(st + j) % n]! }
    boot.push((s / n) * 12)
  }
  boot.sort((x, y) => x - y)
  const q = (p: number) => boot.length ? boot[Math.min(boot.length - 1, Math.max(0, Math.floor(p * (boot.length - 1))))]! : NaN
  const m = mean(boot), se = boot.length > 1 ? Math.sqrt(boot.reduce((s, v) => s + (v - m) ** 2, 0) / (boot.length - 1)) : NaN
  const fa = opts.familyAlpha ?? 0.05, tooShort = n < (opts.minMonths ?? 36)
  return { months: n, yearly, lo: q(0.025), hi: q(0.975), mde: 2.8 * se, tooShort, detectable: !tooShort && (q(fa / 2) > 0 || q(1 - fa / 2) < 0) }
}

export interface Stress { label: string; loss: number; note: string }
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "2020-03" as "March 2020". */
export const monthWords = (ym: string): string => { const [y, m] = ym.split('-').map(Number); return m && m >= 1 && m <= 12 ? `${MONTH_NAMES[m - 1]} ${y}` : ym }
/** Three ways it could go badly, in rupees lost on `amount` paise: the worst past window, the worst past month
 *  repeated at once, and the fall the floor's worst case already allows for this holding. */
export function stress(amount: number, idea: PlanResult | null, months: { months: string[]; r: number[] } | null, limitFall: number, limitStatus: string): Stress[] {
  const out: Stress[] = []
  if (idea && Number.isFinite(idea.worst)) out.push({ label: 'The worst past window', loss: Math.max(0, Math.round(amount * (1 - idea.worst))), note: `the worst of ${idea.outcomes.length.toLocaleString('en-IN')} past windows, after costs and modelled tax` })
  if (months && months.r.length) {
    const k = months.r.indexOf(Math.min(...months.r))
    out.push({ label: 'The worst past month, at once', loss: Math.max(0, Math.round(-amount * months.r[k]!)), note: `as in ${monthWords(months.months[k]!)}, the worst month recorded` })
  }
  out.push({ label: 'A fall by its limit', loss: Math.round(amount * limitFall), note: `the fall your floor's worst case allows for this holding (${Math.round(limitFall * 100)}%, ${limitStatus === 'calibrated' || limitStatus === 'verified' ? 'calibrated on its history' : 'illustrative, not calibrated'})` })
  return out
}

export const SURVIVORSHIP = 'The funds are the ones QED lists today; funds that closed or merged are not in the record, which can flatter the past.'
export const OVERLAP = 'The windows overlap, so the share that lost money describes this record; it is not a probability.'
export const NOT_FITTED = 'Nothing is fitted to the record: each alternative is a fixed rule, and each window uses no price after its own end.'
