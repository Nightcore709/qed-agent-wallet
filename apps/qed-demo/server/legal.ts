/**
 * Where QED could move real money, and under whose licence (register N-022; R12 section 7: "Distinguish functioning
 * integrations, local research implementations, simulations and genuine legal or commercial dependencies. Do not imply
 * regulated permissions or institutional status QED does not possess").
 *
 * The capability-by-jurisdiction matrix is the compliance research of 23 Nov 2026
 * (docs/research/qed-fin-infra-compliance/20261123-jurisdiction-matrix.json; research, not legal advice). For each pair
 * it gives the licence a provider of the capability needs there, the partner model QED's design would use, and a
 * verdict: P a licensed-partner route exists, L QED would need its own licence, X not offered by QED's design,
 * C classification unresolved (counsel needed), O owner-only display; the global column is architecture, never a legal
 * service. A real-money route is open only where a recorded agreement covers the pair: a licence QED holds or a signed
 * agreement with a licensed partner, read from data/legal-agreements.json, which the operator fills and which does not
 * exist today. Everything else is refused, and the refusal names what is missing in the matrix's own words.
 *
 * Nothing in this build moves real money: every venue is a paper venue and every token is a valueless test token. This
 * module is the gate any real-money adapter must pass (`assertRealMoney`), and what the readiness page shows.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from './core.ts'

const APP = join(import.meta.dirname, '..')
const ROOT = join(APP, '..', '..')
export const MATRIX_FILE = join(ROOT, 'docs', 'research', 'qed-fin-infra-compliance', '20261123-jurisdiction-matrix.json')
export const AGREEMENTS_FILE = join(APP, 'data', 'legal-agreements.json')

export type Verdict = 'P' | 'L' | 'X' | 'C' | 'O' | 'build'
interface Cell { licence: string; partner_model: string; verdict: string; labels: string[]; sources?: string[] }
interface Capability { id: string; name: string; cells: Record<string, Cell> }
export interface Matrix { meta: { researched: string; status: string; columns: Record<string, string>; verdict_codes: Record<string, string> }; capabilities: Capability[] }
/** A licence QED holds, or a signed agreement with a licensed partner, for one capability in one jurisdiction. */
export interface Agreement { capability: string; jurisdiction: string; kind: 'licence' | 'partner'; holder: string; reference: string; from: string; until?: string }
export interface Route { capability: string; capabilityName: string; jurisdiction: string; jurisdictionName: string; open: boolean; verdicts: Verdict[]; missing: string; labels: string[]; agreement: Agreement | null }

/** The research's own jurisdictions; GL is the global architecture column. */
export const LEGAL_JURISDICTIONS = ['IN', 'US', 'UK', 'EU', 'SG', 'AE'] as const

export function loadMatrix(file = MATRIX_FILE): Matrix {
  if (!existsSync(file)) throw new AppError(500, 'legal_matrix_missing', 'The jurisdiction research is not in this build, so no real-money route can be judged; every one stays closed.')
  return JSON.parse(readFileSync(file, 'utf8')) as Matrix
}
export function loadAgreements(file = AGREEMENTS_FILE): Agreement[] {
  if (!existsSync(file)) return []
  const list = JSON.parse(readFileSync(file, 'utf8')) as Agreement[]
  if (!Array.isArray(list)) throw new AppError(500, 'legal_agreements_invalid', `${file} must be a list of agreements.`)
  return list
}

const verdictsOf = (cell: Cell | undefined): Verdict[] => {
  if (!cell) return []
  if (cell.verdict.trim() === 'build') return ['build']
  return cell.verdict.split(',').map((v) => v.trim()).filter((v): v is Verdict => ['P', 'L', 'X', 'C', 'O'].includes(v))
}

/** What is missing before this pair could move real money, in the matrix's own words. */
function missingOf(cell: Cell | undefined, verdicts: Verdict[]): string {
  if (!cell) return 'Not researched: no route is known.'
  if (verdicts.includes('build')) return 'Architecture only: the code is built once, but this is not a legal service anywhere.'
  if (verdicts.includes('X')) return 'Not offered by QED\'s design.'
  const parts: string[] = []
  if (verdicts.includes('L')) parts.push(`QED's own licence or registration: ${cell.licence}`)
  if (verdicts.includes('P')) parts.push(`An agreement with a licensed partner: ${cell.partner_model}`)
  if (verdicts.includes('C')) parts.push(`A classification by counsel, unresolved: ${cell.licence}`)
  if (verdicts.includes('O')) parts.push(`Display to the owner only, under the provider's terms: ${cell.licence}`)
  return parts.join(' Or: ') || `Unclassified: ${cell.licence}`
}

/** One capability in one jurisdiction: open only with an agreement in force on `at` that covers it. */
export function routeOf(m: Matrix, agreements: Agreement[], capability: string, jurisdiction: string, at = Date.now()): Route {
  const cap = m.capabilities.find((c) => c.id === capability)
  if (!cap) throw new AppError(400, 'legal_capability_unknown', `No capability ${capability} in the jurisdiction research.`)
  const cell = cap.cells[jurisdiction]
  const verdicts = verdictsOf(cell)
  const inForce = (a: Agreement): boolean => a.capability === capability && a.jurisdiction === jurisdiction && Date.parse(a.from) <= at && (!a.until || at < Date.parse(a.until))
  // an agreement opens a route only where the research says a route of that kind exists
  const fits = (a: Agreement): boolean => (a.kind === 'partner' && verdicts.includes('P')) || (a.kind === 'licence' && (verdicts.includes('L') || verdicts.includes('P')))
  const agreement = agreements.find((a) => inForce(a) && fits(a)) ?? null
  return { capability, capabilityName: cap.name, jurisdiction, jurisdictionName: m.meta.columns[jurisdiction] ?? jurisdiction, open: agreement !== null, verdicts, missing: agreement ? '' : missingOf(cell, verdicts), labels: cell?.labels ?? [], agreement }
}

/** The gate every real-money adapter calls before it acts. Refuses with what is missing; never opens a route itself. */
export function assertRealMoney(capability: string, jurisdiction: string, m: Matrix = loadMatrix(), agreements: Agreement[] = loadAgreements(), at = Date.now()): Route {
  const r = routeOf(m, agreements, capability, jurisdiction, at)
  if (!r.open) throw new AppError(403, 'no_legal_route', `${r.capabilityName} with real money in ${r.jurisdictionName} needs: ${r.missing} No such agreement is recorded, so QED does this only with practice money.`)
  return r
}

/** What the readiness page shows: every capability in every jurisdiction, closed or open, and why. */
export function legalView(m: Matrix = loadMatrix(), agreements: Agreement[] = loadAgreements(), at = Date.now()): Record<string, unknown> {
  const jurisdictions = LEGAL_JURISDICTIONS.map((j) => ({ id: j, name: m.meta.columns[j] ?? j }))
  const rows = m.capabilities.map((c) => ({ id: c.id, name: c.name, cells: LEGAL_JURISDICTIONS.map((j) => { const r = routeOf(m, agreements, c.id, j, at); return { jurisdiction: j, open: r.open, verdicts: r.verdicts, missing: r.missing, labels: r.labels } }) }))
  const open = rows.reduce((n, r) => n + r.cells.filter((c) => c.open).length, 0)
  return { researched: m.meta.researched, status: m.meta.status, verdictCodes: m.meta.verdict_codes, jurisdictions, capabilities: rows, agreements: agreements.length, open, pairs: rows.length * jurisdictions.length }
}
