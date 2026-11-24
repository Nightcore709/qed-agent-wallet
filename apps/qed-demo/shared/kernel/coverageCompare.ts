/**
 * What "the TypeScript checker agrees with the Python checker" means, field by field (R12). Used by coverage.test.ts on
 * the recorded and generated fixtures, and by scripts/coverage-differential.ts against the live Python checker.
 *
 * Hard agreement (a difference is a defect in one of them): the status, the request hash, every coverage row (deadline,
 * cumulative cash in and out, slack), every counted position's cash date and face, the payment bank's peak exposure,
 * the principal floor's figures, the CVaR worst case and every backtest figure (to 1e-12; the two p-values to 1e-9,
 * since the chi-square tail is computed independently).
 * Soft agreement: the set of reason codes. When a request is wrong in several ways, which refusals each checker names
 * together is a matter of order that section 5.1 does not fix; such cases are pinned in the fixtures, each with both
 * answers. Not compared: wording (details, remedies, failure conditions), which each checker writes in its own words.
 *
 * Deliberate status differences are allowed only where the port names them: RISKY_SLEEVE_TOO_LARGE (the port refuses
 * principal protection when the declared risky sleeve exceeds what the budget leaves after the floor; the Python
 * checker certifies such a plan, stating the room for risk, as section 5.1 reads) and RISKY_SLEEVE_CURRENCY (R13: a
 * sleeve in another currency cannot be set against the budget without an exchange rate). One figure difference is
 * allowed in one direction only: the port's peak in-transit exposure may be higher than Python's, never lower. Since
 * r11-goa-1.1 both compute the same upper bound (coverage.ts, peakInTransit), so that allowance is unused.
 */
import type { Outcome } from './coverage.ts'

type J = Record<string, unknown>
export const codes = (o: { reasons?: unknown }): string[] => [...new Set(((o.reasons ?? []) as { code: string }[]).map((r) => r.code))].sort()
export const DELIBERATE = ['RISKY_SLEEVE_TOO_LARGE', 'RISKY_SLEEVE_CURRENCY'] as const

export interface Comparison { hard: string[]; codesAgree: boolean; statusAgree: boolean; deliberate: string | null; exposure: boolean }

export function compare(py: J, ts: Outcome): Comparison {
  const hard: string[] = []
  let exposure = false
  const eq = (what: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) hard.push(`${what}: python ${JSON.stringify(a)} ts ${JSON.stringify(b)}`) }
  const near = (what: string, a: unknown, b: unknown, tol: number) => {
    if (typeof a !== 'number' || typeof b !== 'number') { eq(what, a, b); return }
    if (!(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a)))) hard.push(`${what}: python ${a} ts ${b}`)
  }
  const statusAgree = py.status === ts.status
  const deliberate = !statusAgree && ts.status === 'ABSTAIN' && py.status === 'CERTIFIED_BY_CONSTRUCTION' ? (DELIBERATE.find((d) => codes(ts).includes(d)) ?? null) : null
  if (!statusAgree && !deliberate) hard.push(`status: python ${JSON.stringify(py.status)} ts ${JSON.stringify(ts.status)}`)
  eq('request_hash', py.request_hash, ts.request_hash)
  if (!statusAgree) return { hard, codesAgree: false, statusAgree, deliberate, exposure }
  const pe = (py.evidence ?? {}) as J, te = ts.evidence as J
  const rows = (e: J) => ((e.coverage ?? []) as J[]).map((r) => [r.obligation, r.due, r.fund_by, r.amount_minor, r.cum_in_minor, r.cum_out_minor, r.slack_minor])
  eq('coverage rows', rows(pe), rows(te))
  if (py.status !== 'ABSTAIN') {
    const built = (c: J[]) => c.filter((x) => 'cash_available_by' in x).map((x) => [x.instrument, x.lots, x.face_minor, x.cash_available_by, x.level ?? null])
    eq('construction', built((py.construction ?? []) as J[]), built(ts.construction as J[]))
    // The port's in-transit exposure may exceed Python's, never fall below it (see peakInTransit in coverage.ts).
    const bank = (cs: J[]) => cs.filter((c) => 'peak_exposure_minor' in c).map((c) => [Number(c.peak_exposure_minor), c.insured_minor] as const)
    const pb = bank((py.counterparties ?? []) as J[]), tb = bank(ts.counterparties as J[])
    if (pb.length !== tb.length || pb.some((x, i) => x[1] !== tb[i]![1] || tb[i]![0] < x[0])) eq('payment bank exposure', pb, tb)
    else if (pb.some((x, i) => tb[i]![0] > x[0])) exposure = true
  }
  for (const k of ['floor_cost_minor', 'floor_face_minor', 'need_minor', 'max_risky_minor', 'worst_case_loss_minor', 'total_minor', 'distribution_free']) if (k in pe || k in te) eq(`evidence.${k}`, pe[k], te[k])
  const holdings = (e: J) => ((e.holdings ?? []) as J[]).map((h) => [h.holding, h.value_minor, h.max_loss_minor])
  if ('holdings' in pe || 'holdings' in te) eq('holdings', holdings(pe), holdings(te))
  const pm = pe.model as J | undefined, tm = te.model as J | undefined
  if (pm || tm) {
    if (!pm || !tm) hard.push(`model evidence: python ${pm ? 'present' : 'absent'} ts ${tm ? 'present' : 'absent'}`)
    else {
      for (const k of ['model', 'months_backtested', 'var_exceedances', 'block', 'bootstrap_reps', 'seed']) eq(`model.${k}`, pm[k], tm[k])
      for (const k of ['exceedance_rate', 'expected_rate', 'p_exceed_after_exceed', 'p_exceed_after_calm', 'var_estimate', 'cvar_estimate', 'cvar_ucb95']) near(`model.${k}`, pm[k], tm[k], 1e-12)
      for (const k of ['kupiec_p', 'christoffersen_p']) near(`model.${k}`, pm[k], tm[k], 1e-9)
    }
  }
  return { hard, codesAgree: JSON.stringify(codes(py)) === JSON.stringify(codes(ts)), statusAgree, deliberate, exposure }
}

/** The part of a Python outcome that `compare` reads: what the fixtures keep, so they stay small. */
export function trim(py: J): J {
  const e = (py.evidence ?? {}) as J
  const keep: J = {}
  if (e.coverage) keep.coverage = (e.coverage as J[]).map((r) => ({ obligation: r.obligation, due: r.due, fund_by: r.fund_by, amount_minor: r.amount_minor, cum_in_minor: r.cum_in_minor, cum_out_minor: r.cum_out_minor, slack_minor: r.slack_minor }))
  for (const k of ['floor_cost_minor', 'floor_face_minor', 'need_minor', 'max_risky_minor', 'worst_case_loss_minor', 'total_minor', 'distribution_free', 'model']) if (k in e) keep[k] = e[k]
  if (e.holdings) keep.holdings = (e.holdings as J[]).map((h) => ({ holding: h.holding, value_minor: h.value_minor, max_loss_minor: h.max_loss_minor }))
  return {
    status: py.status, request_hash: py.request_hash, reasons: ((py.reasons ?? []) as J[]).map((r) => ({ code: r.code })), evidence: keep,
    construction: ((py.construction ?? []) as J[]).filter((c) => 'cash_available_by' in c).map((c) => ({ instrument: c.instrument, lots: c.lots, face_minor: c.face_minor, cash_available_by: c.cash_available_by, level: c.level })),
    counterparties: ((py.counterparties ?? []) as J[]).filter((c) => 'peak_exposure_minor' in c).map((c) => ({ peak_exposure_minor: c.peak_exposure_minor, insured_minor: c.insured_minor })),
  }
}
