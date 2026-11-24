/**
 * Checker B: a TypeScript port of the independently written X7 checker
 * (experiments/r4/X7-independent-checker/checker.py). X7's author worked from a written requirement and never saw
 * X5's code; this port follows X7's own structure and arithmetic order (interest accrued, then EMI; its own FD-break
 * code), not Checker A's.
 *
 * FD-break rule: v3.2, adopted 18 Nov 2026 after X7's differential test exposed an ambiguity (Q1). When savings are
 * short, the deposit is broken by principal equal to the shortfall and the break interest is credited on top
 * (X7 Interp fd_break = "principal_equals_shortfall"; the same reading as X5). Under it X7 and X5 agreed on
 * 10,753 of 10,753 inputs. checkerB.test.ts matches this port to X7's Python output on 255 fixtures.
 */
import { PLAN_KEYS, type Plan, type X5Model, X5_DEFAULT } from './x5.ts'

export interface CheckerBVerdict { tierD: boolean; rejected: boolean; minImprovement: number | null; maxDeepening: number | null; reasons: string[] }

export const CHECKER_B_AVAILABLE = true

const EPSILON = 0.000001

class NonFinite extends Error {}

const ok = (x: number, what: string): number => {
  if (!Number.isFinite(x)) throw new NonFinite(what)
  return x
}

interface Scen { r_sav: number; r_card: number; r_hl: number; r_lf: number; m_lost: number; medical: number; stressed: boolean; label: string }

function grid(m: X5Model): Scen[] {
  const out: Scen[] = []
  for (const rs of m.rateBoxes.sav) for (const rc of m.rateBoxes.card) for (const rh of m.rateBoxes.home_loan) for (const rl of m.rateBoxes.liquid_fund)
    for (const sh of m.shocks) out.push({ r_sav: rs, r_card: rc, r_hl: rh, r_lf: rl, m_lost: sh.mLost, medical: sh.med, stressed: sh.stressed, label: sh.label })
  return out
}

/** One path: the monthly transition T1..T8 of X7's SPEC §4, with the v3.2 FD-break rule. */
function simulate(a: [number, number, number, number, number], s0: number, sc: Scen, m: X5Model): { shortfall: number[]; netWorth: number } {
  const [xc, xp, xh, xf, xl] = a
  const charge = ok(m.prepayPenalty.personal_loan * xp, 'prepayment charge')
  const outlay = ok(xc + xp + xh + xf + xl, 'plan outlay')
  let S = ok(s0 - outlay - charge, 'S0')
  let L = xl
  let P = xf
  let A = 0
  let C = ok(m.debt.card - xc, 'C0')
  let Dp = ok(m.debt.personal_loan - xp, 'Dp0')
  let Dh = ok(m.debt.home_loan - xh, 'Dh0')
  const shortfall: number[] = []
  for (let t = 1; t <= m.months; t++) {
    S = ok(S + ok((S * (S >= 0 ? sc.r_sav : sc.r_card)) / 12, 'savings interest'), 'S after T1')
    L = ok(L + ok((L * sc.r_lf) / 12, 'LF growth'), 'L after growth')
    if (sc.stressed && t === 2) L = ok(L - ok(L * m.lfStressLoss, 'LF credit loss'), 'L after credit event')
    A = ok(A + ok((P * m.fdRate) / 12, 'FD accrual'), 'A after T3')
    C = ok(C + ok((C * sc.r_card) / 12, 'card interest'), 'C after T4')
    Dp = ok(Dp + ok((Dp * m.plRate) / 12, 'PL interest'), 'Dp after growth')
    const eP = Math.min(m.plEmi, Dp)
    Dp = ok(Dp - eP, 'Dp after EMI')
    Dh = ok(Dh + ok((Dh * sc.r_hl) / 12, 'HL interest'), 'Dh after growth')
    const eH = Math.min(m.hlEmi, Dh)
    Dh = ok(Dh - eH, 'Dh after EMI')
    const inc = t <= sc.m_lost ? 0 : m.income
    const med = t === 2 ? sc.medical : 0
    S = ok(S + inc - m.expenses - eP - eH - med, 'S after T6')
    if (S < 0) {
      const redeem = Math.min(L, -S)
      L = ok(L - redeem, 'L after redemption')
      S = ok(S + redeem, 'S after redemption')
      if (S < 0 && P > 0) {
        const q = ok((Math.max(0, sc.r_sav - m.fdBreak) * t) / 12, 'break rate')
        const target = -S // v3.2: principal equal to the shortfall
        if (target < P) {
          const broken = target
          A = ok(A - ok(A * (broken / P), 'forfeited interest'), 'A after break')
          P = ok(P - broken, 'P after break')
          S = ok(S + broken + ok(broken * q, 'break interest'), 'S after break')
        } else {
          const broken = P
          const brkInt = ok(broken * q, 'break interest')
          P = 0
          A = 0
          S = ok(S + broken + brkInt, 'S after full break')
        }
      }
    }
    shortfall.push(Math.max(0, -S))
  }
  return { shortfall, netWorth: ok(S + P + A + L - C - Dp - Dh, 'net worth') }
}

function amountOf(v: unknown): { good: boolean; v?: number; why: string } {
  if (typeof v === 'boolean') return { good: false, why: 'is a boolean, not an amount' }
  if (typeof v !== 'number') return { good: false, why: `is of type ${v === null ? 'null' : typeof v}, not a real number` }
  if (!Number.isFinite(v)) return { good: false, why: 'is not finite' }
  return { good: true, v, why: '' }
}

const rejected = (reasons: string[]): CheckerBVerdict => ({ tierD: false, rejected: true, minImprovement: null, maxDeepening: null, reasons })

export function checkerB(plan: unknown, s0: unknown, m: X5Model = X5_DEFAULT): CheckerBVerdict {
  const reasons: string[] = []
  const s = amountOf(s0)
  let s0f: number | null = null
  if (!s.good) reasons.push(`s0 ${s.why}`)
  else if ((s.v as number) < 0) reasons.push('s0 is negative')
  else s0f = s.v as number
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return rejected([...reasons, 'plan is not a mapping of the five amounts'])
  const o = plan as Record<string, unknown>
  const missing = PLAN_KEYS.filter((k) => !(k in o))
  const extra = Object.keys(o).filter((k) => !(PLAN_KEYS as readonly string[]).includes(k))
  if (missing.length) reasons.push(`missing keys: ${missing.join(', ')}`)
  if (extra.length) reasons.push(`unexpected keys: ${extra.join(', ')}`)
  const values: Partial<Record<(typeof PLAN_KEYS)[number], number>> = {}
  for (const k of PLAN_KEYS) {
    if (!(k in o)) continue
    const a = amountOf(o[k])
    if (!a.good) { reasons.push(`${k} ${a.why}`); continue }
    if ((a.v as number) < 0) { reasons.push(`${k} is negative`); continue }
    values[k] = a.v as number
  }
  for (const [k, cap] of [['card', m.debt.card], ['personal_loan', m.debt.personal_loan], ['home_loan', m.debt.home_loan]] as const) {
    const v = values[k]
    if (v !== undefined && v > cap) reasons.push(`${k} exceeds the outstanding balance`)
  }
  if (Object.keys(values).length === PLAN_KEYS.length && s0f !== null) {
    const v = values as Plan
    const total = v.card + v.personal_loan + v.home_loan + v.fd + v.liquid_fund + m.prepayPenalty.personal_loan * v.personal_loan
    if (!Number.isFinite(total)) reasons.push('plan total is not finite')
    else if (total > s0f + EPSILON) reasons.push('plan total including the prepayment charge exceeds savings')
  }
  if (reasons.length || s0f === null) return rejected(reasons.length ? reasons : ['s0 invalid'])
  const v = values as Plan
  const amounts: [number, number, number, number, number] = [v.card, v.personal_loan, v.home_loan, v.fd, v.liquid_fund]
  let minImp: number | null = null
  let maxDeep = 0
  let nwFail = 0
  let sfFail = 0
  try {
    for (const sc of grid(m)) {
      const base = simulate([0, 0, 0, 0, 0], s0f, sc, m)
      const p = simulate(amounts, s0f, sc, m)
      const dW = ok(p.netWorth - base.netWorth, 'net-worth difference')
      if (minImp === null || dW < minImp) minImp = dW
      if (!(p.netWorth >= base.netWorth - EPSILON)) nwFail++
      p.shortfall.forEach((fp, i) => {
        const fd = base.shortfall[i]!
        const dF = ok(fp - fd, 'shortfall difference')
        if (dF > maxDeep) maxDeep = dF
        if (!(fp <= fd + EPSILON)) sfFail++
      })
    }
  } catch (e) {
    if (e instanceof NonFinite) return rejected([`non-finite intermediate value (${e.message})`])
    throw e
  }
  const why: string[] = []
  if (sfFail) why.push(`(a) shortfall deeper than doing nothing in ${sfFail} scenario-months`)
  if (nwFail) why.push(`(b) horizon net worth below doing nothing in ${nwFail} scenarios`)
  return { tierD: nwFail === 0 && sfFail === 0, rejected: false, minImprovement: Math.round((minImp ?? 0) * 100) / 100, maxDeepening: Math.round(maxDeep * 100) / 100, reasons: why }
}
