/**
 * Checker A: a line-by-line TypeScript port of the X5 exact checker, v3.1
 * (experiments/r4/X5-dominance-engine/run.py, commit 8e1b753): validate_plan, ledger, exact_check.
 *
 * Arithmetic is performed in the same order as the Python source, so IEEE-754 results agree. x5.test.ts checks
 * 255 golden fixtures generated from the Python code (scripts/gen_x5_fixtures.py) to within ₹0.006.
 *
 * Extension beyond X5, used by the demo: the household's balances (s0 and the three debts) can be passed in from
 * the live state. With X5's defaults the outputs are X5's own. All model parameters are ILLUSTRATIVE.
 */

export const PLAN_KEYS = ['card', 'personal_loan', 'home_loan', 'fd', 'liquid_fund'] as const
export type PlanKey = (typeof PLAN_KEYS)[number]
export type Plan = Record<PlanKey, number>
export const DEBT_KEYS = ['card', 'personal_loan', 'home_loan'] as const
export type DebtKey = (typeof DEBT_KEYS)[number]

export interface Shock { mLost: number; med: number; stressed: boolean; label: string }

export interface X5Model {
  months: number
  s0: number
  debt: Record<DebtKey, number>
  prepayPenalty: Record<DebtKey, number>
  income: number
  expenses: number
  plEmi: number
  hlEmi: number
  plRate: number
  fdRate: number
  fdBreak: number
  lfStressLoss: number
  rateBoxes: { sav: [number, number]; card: [number, number]; home_loan: [number, number]; liquid_fund: [number, number] }
  shocks: Shock[]
  nominal: Scenario
}

export interface Scenario { sav: number; card: number; home_loan: number; liquid_fund: number; mLost: number; med: number; stressed: boolean }

export const X5_DEFAULT: X5Model = {
  months: 12,
  s0: 800_000,
  debt: { card: 120_000, personal_loan: 300_000, home_loan: 2_000_000 },
  prepayPenalty: { card: 0, personal_loan: 0.03, home_loan: 0 },
  income: 120_000,
  expenses: 70_000,
  plEmi: 10_000,
  hlEmi: 20_000,
  plRate: 0.14,
  fdRate: 0.0625,
  fdBreak: 0.01,
  lfStressLoss: 0.01,
  rateBoxes: { sav: [0.025, 0.03], card: [0.4, 0.46], home_loan: [0.08, 0.095], liquid_fund: [0.055, 0.065] },
  shocks: [
    { mLost: 0, med: 0, stressed: false, label: 'No shock' },
    { mLost: 3, med: 0, stressed: true, label: '3 months without income' },
    { mLost: 6, med: 150_000, stressed: true, label: '6 months without income and a ₹1.5 lakh medical bill' },
    { mLost: 0, med: 150_000, stressed: true, label: 'A ₹1.5 lakh medical bill' },
  ],
  nominal: { sav: 0.0275, card: 0.43, home_loan: 0.0875, liquid_fund: 0.06, mLost: 0, med: 0, stressed: false },
}

export const ZERO_PLAN: Plan = { card: 0, personal_loan: 0, home_loan: 0, fd: 0, liquid_fund: 0 }

/** Same order as Python's itertools.product over RATE_BOXES (sav, card, home_loan, liquid_fund), then SHOCKS. */
export function scenarios(m: X5Model = X5_DEFAULT): Scenario[] {
  const out: Scenario[] = []
  for (const sav of m.rateBoxes.sav)
    for (const card of m.rateBoxes.card)
      for (const home_loan of m.rateBoxes.home_loan)
        for (const liquid_fund of m.rateBoxes.liquid_fund)
          for (const sh of m.shocks) out.push({ sav, card, home_loan, liquid_fund, mLost: sh.mLost, med: sh.med, stressed: sh.stressed })
  return out
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const fmt = (v: number) => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function prepaymentCharges(x: Plan, m: X5Model = X5_DEFAULT): number {
  let s = 0
  for (const k of DEBT_KEYS) s += m.prepayPenalty[k] * x[k]
  return s
}

/** validate_plan(): reasons the input is not a well-formed, executable one-time reallocation; empty = valid. */
export function validatePlan(x: unknown, s0: unknown, m: X5Model = X5_DEFAULT): string[] {
  const reasons: string[] = []
  if (!isAmount(s0) || s0 < 0) reasons.push(`savings balance must be a finite non-negative amount, got ${String(s0)}`)
  if (x === null || typeof x !== 'object' || Array.isArray(x)) {
    return [...reasons, `plan must map each of ${PLAN_KEYS.join(', ')} to an amount`]
  }
  const o = x as Record<string, unknown>
  const missing = PLAN_KEYS.filter((k) => !(k in o))
  const unknown = Object.keys(o).filter((k) => !(PLAN_KEYS as readonly string[]).includes(k))
  if (missing.length) reasons.push(`missing allocations: ${missing.join(', ')}`)
  if (unknown.length) reasons.push(`unknown allocations: ${unknown.join(', ')}`)
  for (const k of PLAN_KEYS) {
    if (!(k in o)) continue
    const v = o[k]
    if (!isAmount(v)) reasons.push(`${k}: amount must be a finite real number, got ${String(v)}`)
    else if (v < 0) reasons.push(`${k}: negative allocation ${fmt(v)}; a plan may only move money out of savings`)
    else if ((DEBT_KEYS as readonly string[]).includes(k) && v > m.debt[k as DebtKey]) {
      reasons.push(`${k}: repayment ${fmt(v)} exceeds outstanding ${fmt(m.debt[k as DebtKey])}`)
    }
  }
  if (reasons.length === 0) {
    const plan = o as Plan
    let need = 0
    for (const k of PLAN_KEYS) need += plan[k]
    need += prepaymentCharges(plan, m)
    if (need > (s0 as number) + 1e-6) reasons.push(`conservation: plan needs ${fmt(need)} including prepayment charges, savings hold ${fmt(s0 as number)}`)
  }
  return reasons
}

export interface LedgerResult { nw: number; shortfalls: number[] }

/** ledger(): exact month-by-month household ledger for one scenario. Callers must validate first. */
export function ledger(x: Plan, s: Scenario, s0: number, m: X5Model = X5_DEFAULT): LedgerResult {
  const hPen = prepaymentCharges(x, m)
  let sav = s0 - (x.card + x.personal_loan + x.home_loan + x.fd + x.liquid_fund) - hPen
  // Python sums in PLAN_KEYS order starting from 0; (0 + a) + b ... is identical to a + b + ... for finite floats.
  if (sav < -1e-6) return { nw: -Infinity, shortfalls: Array(m.months).fill(Infinity) }
  let fdP = x.fd
  let fdInt = 0
  let lf = x.liquid_fund
  let card = m.debt.card - x.card
  let pl = m.debt.personal_loan - x.personal_loan
  let hl = m.debt.home_loan - x.home_loan
  const shortfalls: number[] = []
  for (let t = 1; t <= m.months; t++) {
    sav += (sav * (sav >= 0 ? s.sav : s.card)) / 12
    lf += (lf * s.liquid_fund) / 12
    if (s.stressed && t === 2) lf *= 1 - m.lfStressLoss
    fdInt += (fdP * m.fdRate) / 12
    card += (card * s.card) / 12
    const plDue = pl * (1 + m.plRate / 12)
    const hlDue = hl * (1 + s.home_loan / 12)
    const payPl = Math.min(m.plEmi, plDue)
    const payHl = Math.min(m.hlEmi, hlDue)
    pl = plDue - payPl
    hl = hlDue - payHl
    const inc = t <= s.mLost ? 0 : m.income
    sav += inc - m.expenses - payPl - payHl - (t === 2 ? s.med : 0)
    if (sav < 0 && lf > 0) {
      const take = Math.min(lf, -sav)
      lf -= take
      sav += take
    }
    if (sav < 0 && fdP > 0) {
      const b = Math.min(fdP, -sav)
      const share = b / fdP
      const accrued = fdInt * share
      fdInt -= accrued
      fdP -= b
      sav += b + (((b * Math.max(0, s.sav - m.fdBreak)) * t) / 12)
    }
    shortfalls.push(Math.max(0, -sav))
  }
  return { nw: sav + fdP + fdInt + lf - card - pl - hl, shortfalls }
}

export interface ScenarioOutcome { scenario: Scenario; improvement: number; deepening: number }

export interface X5Verdict {
  rejected: boolean
  reasons: string[]
  tierD: boolean
  scenariosChecked: number
  minImprovement: number | null
  maxDeepening: number | null
  /** Demo extensions (not in X5's output): every scenario's outcome, and the typical-year estimate. */
  outcomes: ScenarioOutcome[]
  nominalImprovement: number | null
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** exact_check(): Tier D candidate iff valid and, in every scenario, no month's shortfall is deeper and horizon net worth is weakly higher. */
export function exactCheck(x: unknown, s0: unknown = X5_DEFAULT.s0, m: X5Model = X5_DEFAULT): X5Verdict {
  const reasons = validatePlan(x, s0, m)
  const reject = (r: string[]): X5Verdict => ({ rejected: true, reasons: r, tierD: false, scenariosChecked: 0, minImprovement: null, maxDeepening: null, outcomes: [], nominalImprovement: null })
  if (reasons.length) return reject(reasons)
  const plan = x as Plan
  const bal = s0 as number
  let worst = Infinity
  let worstDeeper = 0
  const outcomes: ScenarioOutcome[] = []
  for (const s of scenarios(m)) {
    const p = ledger(plan, s, bal, m)
    const b = ledger(ZERO_PLAN, s, bal, m)
    const values = [p.nw, b.nw, ...p.shortfalls, ...b.shortfalls]
    if (!values.every(Number.isFinite)) return reject([`non-finite ledger value in scenario ${JSON.stringify(s)}`])
    const imp = p.nw - b.nw
    let deeper = -Infinity
    for (let i = 0; i < p.shortfalls.length; i++) deeper = Math.max(deeper, p.shortfalls[i]! - b.shortfalls[i]!)
    worst = Math.min(worst, imp)
    worstDeeper = Math.max(worstDeeper, deeper)
    outcomes.push({ scenario: s, improvement: imp, deepening: Math.max(0, deeper) })
  }
  const nominal = ledger(plan, m.nominal, bal, m).nw - ledger(ZERO_PLAN, m.nominal, bal, m).nw
  return {
    rejected: false,
    reasons: [],
    tierD: worstDeeper <= 1e-6 && worst >= -1e-6,
    scenariosChecked: outcomes.length,
    minImprovement: round2(worst),
    maxDeepening: round2(worstDeeper),
    outcomes,
    nominalImprovement: round2(nominal),
  }
}

export function describeScenario(s: Scenario, m: X5Model = X5_DEFAULT): string {
  const shock = m.shocks.find((k) => k.mLost === s.mLost && k.med === s.med && k.stressed === s.stressed)
  const p = (v: number) => `${(v * 100).toFixed(2).replace(/\.?0+$/, '')}%`
  return `${shock?.label ?? 'Custom shock'} · savings ${p(s.sav)}, card ${p(s.card)}, home loan ${p(s.home_loan)}, liquid fund ${p(s.liquid_fund)}`
}
