/**
 * Guarantee-or-abstain (R12): a TypeScript checker for three properties a household may ask QED to stand behind,
 * written from the specification in docs/research/qed-quant-finance/20261124-portfolio-intelligence.md section 5.1 and
 * from the behaviour the Python checker's tests require (experiments/r11-portfolio/tests/test_guarantee.py). It was not
 * translated from experiments/r11-portfolio/qpi/guarantee/checker.py; coverage.test.ts compares the two on the 22
 * recorded cases and on generated ones, and every difference found is recorded there and in the R12 note.
 *
 *   reserve    "The reserve covers every dated obligation in the next N days in nominal <currency>"
 *   principal  "At <horizon> the account holds at least <principal> (<basis>, <tax basis>)"
 *   cvar       "The <level> CVaR of the loss to <horizon_end>, in <currency>, is at most <threshold> of today's value"
 *
 * Levels, strongest first: CERTIFIED_BY_CONSTRUCTION (holds because of the holdings themselves; the currency's own
 * sovereign and named custody stand behind it), CERTIFIED_CONTRACTUAL (also relies on a named bank's promise),
 * BOUNDED_UNDER_MODEL ("MODEL BOUND, NOT A GUARANTEE": nobody stands behind it), ABSTAIN (reasons and remedies).
 * The checker never returns a level weaker than every level the request accepts; a stronger one is always acceptable.
 * It only computes: it never acts.
 *
 * Money is integer minor units with an ISO 4217 currency; a float or a boolean where money belongs is refused. Dates
 * are calendar dates (YYYY-MM-DD). The wire format is the Python dataclasses' field names (snake_case) plus "type".
 * The request hash is SHA-256 over the same canonical JSON the Python checker hashes, so either can verify the other's
 * certificate (coverage.test.ts checks equality on all 22 recorded requests).
 *
 * The model-bound statistics (backtests and bootstrap) are not specified in section 5.1; they are defined in
 * coverageModel.ts, whose header says where each definition comes from.
 */
import { sha256 } from '../sha256.ts'
import { modelBound, type ModelResult } from './coverageModel.ts'

export const CHECKER_VERSION = 'r12-goa-ts-2.0' // 2.0: R13 (protection established or refused: real at the horizon, dated charges, faces, exact rounding)
/** The Python checker these results are compared with (experiments/r11-portfolio/qpi/guarantee/checker.py). */
export const REFERENCE_VERSION = 'r11-goa-2.0'

export const MINOR_DIGITS: Readonly<Record<string, number>> = { INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0 }
export const LEVELS = ['by_construction', 'contractual', 'model_bound'] as const
export type Level = (typeof LEVELS)[number]
export type Status = 'CERTIFIED_BY_CONSTRUCTION' | 'CERTIFIED_CONTRACTUAL' | 'BOUNDED_UNDER_MODEL' | 'ABSTAIN'
export const KINDS = ['sovereign_zero', 'sovereign_inflation_zero', 'bank_deposit', 'cash_at_bank', 'money_market_fund', 'bond_fund', 'corporate_bond', 'equity_fund'] as const
export const CUSTODY_KINDS = ['sovereign_registry', 'custodian', 'bank', 'fund_registrar', 'unknown'] as const

// ------------------------------------------------------------------------------------------------ the wire format
export interface Instrument {
  id: string; kind: string; currency: string; issuer: string; issuer_is_currency_sovereign: boolean
  maturity: string | null; face_per_lot_minor: number | null
  payment_lag_business_days?: number; callable?: boolean; index?: string | null; index_lag_months?: number | null
  deposit_insurance_minor?: number; source?: string
}
export interface Position {
  instrument_id: string; lots: number; custody: string; custody_kind: string
  hold_to_maturity?: boolean; planned_sale?: string | null; status?: 'held' | 'to_buy'; limit_price_per_lot_minor?: number | null
}
export interface Obligation { id: string; due: string; currency: string; amount_minor: number | null; upper_bound_minor?: number | null; payee?: string; kind?: string }
export interface Calendar { name: string; holidays: string[]; covers_from: string; covers_to: string; weekend?: number[] }
export interface ReserveCoverageRequest {
  type: 'reserve'; as_of: string; currency: string; horizon_days: number
  obligations: Obligation[]; positions: Position[]; instruments: Instrument[]
  accept?: string[]; basis?: string; bank_cash_minor?: number; bank_name?: string; bank_insured_minor?: number; settlement_bank?: string
  calendar?: Calendar | null; max_nonbusiness_run_days?: number; payment_lead_business_days?: number
  fees_declared?: boolean; taxes_declared?: boolean; budget_minor?: number | null
}
/** A dated charge against the account on or before the horizon (a fee, or a yearly tax listed as one). */
export interface FeeCharge { due: string; amount_minor: number; payee?: string }
export interface RiskyHolding { id: string; value_minor: number; currency: string; limited_liability: boolean; leverage?: number; short_options?: boolean; margin?: boolean }
export interface PrincipalProtectionRequest {
  type: 'principal'; as_of: string; currency: string; principal_minor: number; horizon: string; basis: string; tax_basis: string
  budget_minor: number; positions: Position[]; instruments: Instrument[]; risky?: RiskyHolding[]
  fees_from_account_minor?: number; max_tax_rate?: number | null; withdrawals_before_horizon?: boolean; accept?: string[]
  calendar?: Calendar | null; max_nonbusiness_run_days?: number
  /** Dated charges (R13). `fees_from_account_minor` holds charges whose dates are not known, which can fall due tomorrow. */
  fees?: FeeCharge[]
  /** When the tax on the floor's accretion is charged (R13; required after tax): when the floor pays, or each year before. */
  tax_timing?: 'on_payout' | 'yearly' | null
}
export interface LossHolding {
  id: string; value_minor: number; currency: string; kind: string; maturity?: string | null; issuer_is_currency_sovereign?: boolean
  limited_liability?: boolean; leverage?: number; short_options?: boolean; hold_to_maturity?: boolean
  /** What an own-currency sovereign zero pays at maturity, in base-currency minor units (R13): loss = value - face if above. */
  face_minor?: number | null
}
export interface CVaRBoundRequest {
  type: 'cvar'; as_of: string; base_currency: string; level: number; horizon_end: string; threshold: number; holdings: LossHolding[]
  accept?: string[]; scenario_returns?: number[] | null; scenario_source?: string; window?: number; bootstrap_reps?: number; seed?: number
  model?: string; ewma_lambda?: number
  /** Charges to the book before horizon_end, in base-currency minor units, counted in full as loss (R13). */
  charges_minor?: number
}
export type Request = ReserveCoverageRequest | PrincipalProtectionRequest | CVaRBoundRequest

export interface Reason { code: string; detail: string }
export interface Outcome {
  status: Status; property: string; request_hash: string; checker_version: string
  protected: Record<string, unknown>; construction: Record<string, unknown>[]; assumptions: string[]; liquidity: string
  funding_underwriter: string; enforcement: string; counterparties: Record<string, unknown>[]; failure_conditions: string[]
  evidence: Record<string, unknown>; reasons: Reason[]; remedies: string[]; alternatives: string[]
}
export const isGuarantee = (o: Pick<Outcome, 'status'>): boolean => o.status === 'CERTIFIED_BY_CONSTRUCTION' || o.status === 'CERTIFIED_CONTRACTUAL'

// ------------------------------------------------------------------------------------------------ defaults (the dataclasses')
const INSTRUMENT_DEFAULTS = { payment_lag_business_days: 0, callable: false, index: null, index_lag_months: null, deposit_insurance_minor: 0, source: '' }
const POSITION_DEFAULTS = { hold_to_maturity: true, planned_sale: null, status: 'held', limit_price_per_lot_minor: null }
const OBLIGATION_DEFAULTS = { upper_bound_minor: null, payee: '', kind: 'payment' }
const RISKY_DEFAULTS = { leverage: 1.0, short_options: false, margin: false }
const LOSS_DEFAULTS = { maturity: null, issuer_is_currency_sovereign: false, limited_liability: true, leverage: 1.0, short_options: false, hold_to_maturity: true, face_minor: null }
const FEE_DEFAULTS = { payee: '' }
const RESERVE_DEFAULTS = { accept: ['by_construction'], basis: 'nominal', bank_cash_minor: 0, bank_name: '', bank_insured_minor: 0, settlement_bank: "the household's payment bank account", calendar: null, max_nonbusiness_run_days: 4, payment_lead_business_days: 1, fees_declared: true, taxes_declared: true, budget_minor: null }
const PRINCIPAL_DEFAULTS = { risky: [], fees_from_account_minor: 0, max_tax_rate: null, withdrawals_before_horizon: false, accept: ['by_construction'], calendar: null, max_nonbusiness_run_days: 4, fees: [], tax_timing: null }
const CVAR_DEFAULTS = { accept: ['by_construction'], scenario_returns: null, scenario_source: '', window: 120, bootstrap_reps: 2000, seed: 20261124, model: 'hs', ewma_lambda: 0.97, charges_minor: 0 }
/** Fields added in R13, left out of the canonical request at their defaults so every earlier request keeps its hash. */
const NEW_AT_DEFAULT: Record<string, unknown> = { fees: [], tax_timing: null, face_minor: null, charges_minor: 0 }
const atNewDefault = (k: string, v: unknown): boolean => k in NEW_AT_DEFAULT && JSON.stringify(v) === JSON.stringify(NEW_AT_DEFAULT[k])

type Full<T> = { [K in keyof T]-?: Exclude<T[K], undefined> }
type FullReserve = Full<Omit<ReserveCoverageRequest, 'obligations' | 'positions' | 'instruments'>> & { obligations: Full<Obligation>[]; positions: Full<Position>[]; instruments: Full<Instrument>[] }
type FullPrincipal = Full<Omit<PrincipalProtectionRequest, 'positions' | 'instruments' | 'risky' | 'fees'>> & { positions: Full<Position>[]; instruments: Full<Instrument>[]; risky: Full<RiskyHolding>[]; fees: Full<FeeCharge>[] }
type FullCVaR = Full<Omit<CVaRBoundRequest, 'holdings'>> & { holdings: Full<LossHolding>[] }

const fill = <T extends object>(defaults: object, x: T): T => ({ ...defaults, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) }) as T
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])

/** The request with every default the Python dataclass would give it: what is checked and what is hashed. */
export function normalise(r: Request): FullReserve | FullPrincipal | FullCVaR {
  const ins = (x: unknown) => arr(x).map((i) => fill(INSTRUMENT_DEFAULTS, i as object))
  const pos = (x: unknown) => arr(x).map((p) => fill(POSITION_DEFAULTS, p as object))
  if (r.type === 'reserve') return { ...fill(RESERVE_DEFAULTS, r), obligations: arr(r.obligations).map((o) => fill(OBLIGATION_DEFAULTS, o as object)), positions: pos(r.positions), instruments: ins(r.instruments) } as FullReserve
  if (r.type === 'principal') return { ...fill(PRINCIPAL_DEFAULTS, r), positions: pos(r.positions), instruments: ins(r.instruments), risky: arr(r.risky ?? []).map((h) => fill(RISKY_DEFAULTS, h as object)), fees: arr(r.fees ?? []).map((f) => fill(FEE_DEFAULTS, f as object)) } as FullPrincipal
  return { ...fill(CVAR_DEFAULTS, r), holdings: arr(r.holdings).map((h) => fill(LOSS_DEFAULTS, h as object)) } as FullCVaR
}

// ------------------------------------------------------------------------------------------------ the canonical hash
/**
 * Python's json.dumps(obj, sort_keys=True) for the dataclass fields (no "type"): ", " and ": " separators, non-ASCII
 * escaped as \uXXXX, and floats written as Python's repr writes them (1.0, 5e-05). Which fields are floats comes from the
 * schema, since JSON cannot say: a JavaScript 1 in a float field is written 1.0, as Python writes the dataclass default.
 */
const FLOAT_FIELDS = new Set(['leverage', 'max_tax_rate', 'level', 'threshold', 'ewma_lambda'])
const FIELD_ORDER: Record<string, string[]> = {
  reserve: ['as_of', 'currency', 'horizon_days', 'obligations', 'positions', 'instruments', ...Object.keys(RESERVE_DEFAULTS)],
  principal: ['as_of', 'currency', 'principal_minor', 'horizon', 'basis', 'tax_basis', 'budget_minor', 'positions', 'instruments', ...Object.keys(PRINCIPAL_DEFAULTS)],
  cvar: ['as_of', 'base_currency', 'level', 'horizon_end', 'threshold', 'holdings', ...Object.keys(CVAR_DEFAULTS)],
}
export function pyFloat(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  // toExponential() gives the shortest digits that round-trip, as repr does; only the layout differs
  const [digits, expText] = Math.abs(x).toExponential().split('e') as [string, string]
  const mant = digits.replace('.', '')
  const e = Number(expText)
  const sign = x < 0 ? '-' : ''
  if (e >= -4 && e < 16) {
    // fixed notation, as repr writes 1e-04 <= |x| < 1e16
    if (e < 0) return `${sign}0.${'0'.repeat(-e - 1)}${mant}`
    const intPart = mant.slice(0, e + 1).padEnd(e + 1, '0'), frac = mant.slice(e + 1)
    return `${sign}${intPart}.${frac || '0'}`
  }
  const m = `${mant[0]}${mant.length > 1 ? `.${mant.slice(1)}` : ''}`
  return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
}
// json.dumps escapes every character outside U+0020..U+007E, U+007F included (review finding PT-12)
const pyString = (s: string): string => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
function pyJson(x: unknown, key = ''): string {
  if (x === null || x === undefined) return 'null'
  if (typeof x === 'boolean') return x ? 'true' : 'false'
  if (typeof x === 'number') return FLOAT_FIELDS.has(key) || key === 'scenario_returns' ? pyFloat(x) : Number.isInteger(x) ? String(x) : pyFloat(x)
  if (typeof x === 'string') return pyString(x)
  if (Array.isArray(x)) return `[${x.map((v) => pyJson(v, key)).join(', ')}]`
  const o = x as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${pyString(k)}: ${pyJson(o[k], k)}`).join(', ')}}`
}
/** The dataclass fields of each nested object: the Python checker reads only these, so only these are hashed. */
const NESTED_FIELDS: Record<string, string[]> = {
  obligations: ['id', 'due', 'currency', 'amount_minor', ...Object.keys(OBLIGATION_DEFAULTS)],
  positions: ['instrument_id', 'lots', 'custody', 'custody_kind', ...Object.keys(POSITION_DEFAULTS)],
  instruments: ['id', 'kind', 'currency', 'issuer', 'issuer_is_currency_sovereign', 'maturity', 'face_per_lot_minor', ...Object.keys(INSTRUMENT_DEFAULTS)],
  risky: ['id', 'value_minor', 'currency', 'limited_liability', ...Object.keys(RISKY_DEFAULTS)],
  holdings: ['id', 'value_minor', 'currency', 'kind', ...Object.keys(LOSS_DEFAULTS)],
  fees: ['due', 'amount_minor', ...Object.keys(FEE_DEFAULTS)],
}
const pick = (o: unknown, fields: string[]): unknown => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(fields.map((f) => [f, (o as Record<string, unknown>)[f]]).filter(([f, v]) => !atNewDefault(f as string, v))) : o)
export function requestHash(r: Request): string {
  const n = normalise(r) as unknown as Record<string, unknown>
  const body: Record<string, unknown> = {}
  for (const k of FIELD_ORDER[r.type]!) if (!atNewDefault(k, n[k])) body[k] = Array.isArray(n[k]) && NESTED_FIELDS[k] ? (n[k] as unknown[]).map((x) => pick(x, NESTED_FIELDS[k]!)) : n[k]
  // the holidays are a frozenset in Python: each date once, in order (review finding PT-12)
  if (body.calendar) { const c = body.calendar as Calendar; body.calendar = { name: c.name, covers_from: c.covers_from, covers_to: c.covers_to, weekend: c.weekend ?? [5, 6], holidays: [...new Set(c.holidays)].sort() } }
  return sha256(pyJson(body))
}

// ------------------------------------------------------------------------------------------------ dates and money
const DAY = 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}$/
export const dayNum = (iso: string): number => {
  if (!ISO.test(iso)) throw new BadInput(`"${iso}" is not a date (YYYY-MM-DD)`)
  const t = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
  const n = t / DAY
  if (!Number.isInteger(n) || isoOf(n) !== iso) throw new BadInput(`"${iso}" is not a calendar date`)
  return n
}
export const isoOf = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10)
/** Monday 0 to Sunday 6, as Python's date.weekday(). 1 Jan 1970 was a Thursday. */
const weekday = (n: number): number => (((n + 3) % 7) + 7) % 7

/** "INR 7,199,166.34", "JPY 1,000": the checker's own money text, in the currency's minor units. */
export function money(minor: number, ccy: string): string {
  const d = MINOR_DIGITS[ccy] ?? 2
  const sign = minor < 0 ? '-' : ''
  const a = Math.abs(minor), unit = 10 ** d
  const q = Math.floor(a / unit), r = a - q * unit
  return `${sign}${ccy} ${q.toLocaleString('en-US')}${d ? `.${String(r).padStart(d, '0')}` : ''}`
}
const pct2 = (x: number): string => `${(x * 100).toFixed(2)}%`

// ------------------------------------------------------------------------------------------------ exact decimals
/**
 * A rate or a threshold as the exact decimal it was written as: its shortest round-trip form, which JavaScript and Python
 * print alike ("0.05", "1e-07" / "1e-7"). Money is compared with it and rounded by it exactly, so no float product
 * can round across a boundary in the request's favour (R13: "rounding must not manufacture compliance").
 */
function decimal(x: number): { n: bigint; d: bigint } {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x))
  if (!m || !Number.isFinite(x)) throw new BadInput(`${String(x)} is not a finite decimal`)
  const [, sign, int, frac = '', exp = '0'] = m as unknown as [string, string, string, string?, string?]
  let n = BigInt(`${int}${frac}`), d = 10n ** BigInt(frac.length)
  const e = Number(exp)
  if (e > 0) n *= 10n ** BigInt(e)
  else if (e < 0) d *= 10n ** BigInt(-e)
  return { n: sign ? -n : n, d }
}
/** ceil(a / b) for b > 0. */
const ceilDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? (a + b - 1n) / b : -(-a / b))
/** ceil(rate x amount), exactly, for an integer amount. */
export const ceilTimes = (rate: number, amount: number): number => { const { n, d } = decimal(rate); return Number(ceilDiv(n * BigInt(amount), d)) }
/** a <= rate x b, exactly, for integers a and b. */
export const atMostTimes = (a: number, rate: number, b: number): boolean => { const { n, d } = decimal(rate); return BigInt(a) * d <= n * BigInt(b) }
/** The most business days a lag, a lead or a non-business run may span (R13 review M3: an unbounded one walked the
 *  calendar about 2^53 times on the request thread). A year is far beyond any settlement convention. */
const MAX_BUSINESS_DAYS = 366

class BadInput extends Error {}

// ------------------------------------------------------------------------------------------------ validation
interface Problems { add(code: string, detail: string): void; list: Reason[] }
const problems = (): Problems => { const list: Reason[] = []; return { list, add: (code, detail) => { if (!list.some((r) => r.code === code && r.detail === detail)) list.push({ code, detail }) } } }
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x)
/** A name is a string with something in it besides spaces (R13 M2: " " named a custodian and a bank). */
const named = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0
function moneyField(p: Problems, x: unknown, what: string, opts: { nullable?: boolean; min?: number } = {}): void {
  if (x === null && opts.nullable) return
  if (!isInt(x)) { p.add('BAD_INPUT', `${what} must be an integer number of minor units (got ${JSON.stringify(x)})`); return }
  if (x < (opts.min ?? 0)) p.add('BAD_INPUT', `${what} must be at least ${opts.min ?? 0} (got ${x})`)
}
function dateField(p: Problems, x: unknown, what: string, nullable = false): void {
  if (x === null && nullable) return
  try { if (typeof x !== 'string') throw new BadInput(''); dayNum(x) } catch { p.add('BAD_INPUT', `${what} must be a date YYYY-MM-DD (got ${JSON.stringify(x)})`) }
}
function acceptField(p: Problems, accept: unknown): void {
  if (!Array.isArray(accept) || accept.length === 0 || accept.some((a) => !(LEVELS as readonly unknown[]).includes(a))) p.add('BAD_INPUT', `accept must list one or more of ${LEVELS.join(', ')} (got ${JSON.stringify(accept)})`)
}
function currencyField(p: Problems, c: unknown, what: string): void {
  if (typeof c !== 'string' || !(c in MINOR_DIGITS)) p.add('BAD_INPUT', `${what} ${JSON.stringify(c)} is not a supported ISO 4217 currency (${Object.keys(MINOR_DIGITS).join(', ')})`)
}
/** A holding's or an instrument's own currency only has to be named: one the checker does not format is simply another
 *  currency than the request's, and is treated as such (review finding PT-11). */
function otherCurrencyField(p: Problems, c: unknown, what: string): void {
  if (typeof c !== 'string' || !c) p.add('BAD_INPUT', `${what} must name a currency (got ${JSON.stringify(c)})`)
}
/** A flag is true or false; anything else is refused, never read by truthiness ("false" is truthy; review PT-06). */
function boolField(p: Problems, x: unknown, what: string): void {
  if (typeof x !== 'boolean') p.add('BAD_INPUT', `${what} must be true or false (got ${JSON.stringify(x)})`)
}
/** A leverage is a finite number; a negative one (a short) has no loss bound and is classified so (review PT-04). */
function leverageField(p: Problems, x: unknown, what: string): void {
  if (typeof x !== 'number' || !Number.isFinite(x)) p.add('BAD_INPUT', `${what} must be a number (got ${JSON.stringify(x)})`)
}
const unboundedLeverage = (lev: number): boolean => lev > 1 || lev < 0
/** What every instrument must carry, for a reserve and a principal floor alike (the floor's payment lag was never
 *  checked: a negative one counted a floor maturing after the horizon; review PT-01). */
function instrumentFields(p: Problems, i: Full<Instrument>, k: number): void {
  dateField(p, i.maturity, `instruments[${k}].maturity`, true)
  moneyField(p, i.face_per_lot_minor, `instruments[${k}].face_per_lot_minor`, { nullable: true, min: 1 })
  moneyField(p, i.deposit_insurance_minor, `instruments[${k}].deposit_insurance_minor`)
  otherCurrencyField(p, i.currency, `instruments[${k}].currency`)
  if (!isInt(i.payment_lag_business_days) || i.payment_lag_business_days < 0 || i.payment_lag_business_days > MAX_BUSINESS_DAYS) p.add('BAD_INPUT', `instruments[${k}].payment_lag_business_days must be a whole number of days from 0 to ${MAX_BUSINESS_DAYS}`)
  boolField(p, i.issuer_is_currency_sovereign, `instruments[${k}].issuer_is_currency_sovereign`); boolField(p, i.callable, `instruments[${k}].callable`)
}
/** What every position must carry beyond its instrument and lots: a flag and a status the checker knows (review PT-06). */
function positionFields(p: Problems, q: Full<Position>, k: number): void {
  boolField(p, q.hold_to_maturity, `positions[${k}].hold_to_maturity`)
  if (q.status !== 'held' && q.status !== 'to_buy') p.add('BAD_INPUT', `positions[${k}].status must be "held" or "to_buy" (got ${JSON.stringify(q.status)})`)
}
function duplicates(p: Problems, ids: string[], what: string): void {
  const seen = new Set<string>()
  for (const id of ids) { if (seen.has(id)) p.add('DUPLICATE_ID', `${what} id "${id}" appears more than once`); seen.add(id) }
}
function calendarField(p: Problems, c: Calendar | null): void {
  if (c === null) return
  if (typeof c !== 'object' || !Array.isArray(c.holidays)) { p.add('BAD_INPUT', 'calendar must name its holidays, covers_from and covers_to'); return }
  dateField(p, c.covers_from, 'calendar.covers_from'); dateField(p, c.covers_to, 'calendar.covers_to')
  c.holidays.forEach((h, i) => dateField(p, h, `calendar.holidays[${i}]`))
  if (c.weekend !== undefined && (!Array.isArray(c.weekend) || c.weekend.some((d) => !isInt(d) || d < 0 || d > 6))) p.add('BAD_INPUT', 'calendar.weekend must list weekdays 0 (Monday) to 6 (Sunday)')
  // A week with no business day would make every date walk forever (the Python checker runs off the end of its
  // date range on it: OverflowError, found while probing it). Refused here as input, not discovered as a crash.
  else if (c.weekend !== undefined && new Set(c.weekend).size >= 7) p.add('BAD_INPUT', 'calendar.weekend leaves no business day in the week')
  // Holidays are finite, so a walk always ends. The list is bounded only to bound the work: a century of days, as the
  // horizon is (it was 366, which refused every real calendar for a horizon past about twenty years; review PT-11).
  else if (c.holidays.length > 36_600) p.add('BAD_INPUT', 'calendar.holidays lists more than 36,600 days')
}

// ------------------------------------------------------------------------------------------------ business-day timing
/**
 * When cash from an instrument maturing on `maturity` is in the payment account, and by when an obligation due on
 * `due` must be funded. With a calendar: the next business day on or after maturity, then the payment lag in business
 * days; and the business day on or before the due date, then the payment lead in business days earlier. Without one,
 * the worst case any calendar whose non-business runs are at most R days long allows: each business-day step can cost
 * R + 1 calendar days, and reaching the first business day up to R. So cash counts from maturity + R + lag (R + 1) and
 * must be in place by due - R - lead (R + 1); with R = 4 and a lead of 1, due - 9, as section 5.1 says.
 *
 * A calendar is used only when it covers the whole period the request can touch, from as_of to as_of + horizon + 60
 * days; otherwise every date uses the buffer. (This port first used a calendar wherever it covered the walk; the
 * all-or-nothing rule is the Python checker's, found by probing it, and is no less safe.)
 */
interface Timing { date: number; rule: string }
function walker(cal: Calendar | null, from: number, to: number) {
  if (!cal || dayNum(cal.covers_from) > from || dayNum(cal.covers_to) < to) return null
  const holidays = new Set(cal.holidays.map(dayNum)), weekend = new Set(cal.weekend ?? [5, 6])
  const biz = (n: number): boolean => !weekend.has(weekday(n)) && !holidays.has(n)
  return {
    name: cal.name,
    forward(start: number, steps: number): number { let d = start; while (!biz(d)) d++; for (let k = 0; k < steps; k++) { d++; while (!biz(d)) d++ } return d },
    back(start: number, steps: number): number { let d = start; while (!biz(d)) d--; for (let k = 0; k < steps; k++) { d--; while (!biz(d)) d-- } return d },
  }
}
type Walker = ReturnType<typeof walker>
function cashAvailable(maturity: number, lag: number, run: number, w: Walker): Timing {
  if (w) return { date: w.forward(maturity, lag), rule: `calendar ${w.name}: the first business day on or after maturity, then ${lag} business day${lag === 1 ? '' : 's'}` }
  const days = run + lag * (run + 1)
  return { date: maturity + days, rule: `no calendar covers the period: maturity + ${days} days (${run}-day non-business run, ${lag} business-day lag)` }
}
/** The latest maturity of a zero with no payment lag whose cash counts by `dl`: the business day on or before it with a
 *  calendar; `dl` less the non-business run without one. A bill bought now can count by `dl` only if this is after
 *  as_of (review PT-08). */
function latestMaturity(dl: number, run: number, w: Walker): number { return w ? w.back(dl, 0) : dl - run }
function fundingDeadline(due: number, lead: number, run: number, w: Walker): Timing {
  if (w) return { date: w.back(due, lead), rule: `calendar ${w.name}: the business day on or before the due date, then ${lead} business day${lead === 1 ? '' : 's'} earlier` }
  const days = run + lead * (run + 1)
  return { date: due - days, rule: `no calendar covers the period: due - ${days} days (${run}-day non-business run, ${lead} business-day lead)` }
}

// ------------------------------------------------------------------------------------------------ the outcome
function outcome(status: Status, property: string, hash: string, parts: Partial<Outcome> = {}): Outcome {
  return {
    status, property, request_hash: hash, checker_version: CHECKER_VERSION, protected: {}, construction: [], assumptions: [], liquidity: '',
    funding_underwriter: '', enforcement: '', counterparties: [], failure_conditions: [], evidence: {}, reasons: [], remedies: [], alternatives: [], ...parts,
  }
}
const abstain = (property: string, hash: string, reasons: Reason[], parts: Partial<Outcome> = {}): Outcome => outcome('ABSTAIN', property, hash, { ...parts, reasons })

/** Check one request. Never throws on a malformed request: it abstains with BAD_INPUT and says why. */
export function check(raw: unknown): Outcome {
  const r = raw as Request
  if (!r || typeof r !== 'object' || !['reserve', 'principal', 'cvar'].includes((r as { type?: string }).type ?? '')) {
    return abstain('(no property: the request has no recognised type)', '', [{ code: 'BAD_INPUT', detail: 'type must be "reserve", "principal" or "cvar"' }])
  }
  let hash = ''
  try { hash = requestHash(r) } catch { hash = '' }
  // A list that is not a list was read as an empty one: "obligations": {} certified a reserve over nothing (review PT-06).
  const lists = { reserve: ['obligations', 'positions', 'instruments'], principal: ['positions', 'instruments'], cvar: ['holdings'] }[r.type]
  const notList = lists.filter((k) => !Array.isArray((r as unknown as Record<string, unknown>)[k]))
  if (r.type === 'principal' && r.risky != null && !Array.isArray(r.risky)) notList.push('risky')
  if (r.type === 'principal' && r.fees != null && !Array.isArray(r.fees)) notList.push('fees')
  // no fingerprint: the hash would be of the request read as if its lists were empty, which is not this request (R13 note)
  if (notList.length) return abstain('(the request could not be read)', '', notList.map((k) => ({ code: 'BAD_INPUT', detail: `${k} must be a list` })))
  try {
    if (r.type === 'reserve') return checkReserve(normalise(r) as FullReserve, hash)
    if (r.type === 'principal') return checkPrincipal(normalise(r) as FullPrincipal, hash)
    return checkCVaR(normalise(r) as FullCVaR, hash)
  } catch (e) {
    // Anything the validation did not anticipate is still a refusal, never a crash of the caller (the API's check
    // endpoint takes requests from anyone signed in).
    return abstain('(the request could not be read)', hash, [{ code: 'BAD_INPUT', detail: e instanceof BadInput ? e.message : 'the request has a field of the wrong shape' }])
  }
}

// ------------------------------------------------------------------------------------------------ what a holding is
/**
 * Every reason a position cannot count by construction (section 5.1: a sovereign zero-coupon instrument of the
 * obligation's own sovereign, in its currency, held to maturity, not callable, in identified custody), all of them at
 * once so a refusal says everything that is wrong. A bank deposit can count at the contractual level; it still carries
 * COUNTERPARTY_BANK, which says what it relies on. `wanted` is the kind a by-construction floor needs (principal
 * protection); a reserve takes nominal sovereign zeros.
 */
function classify(inst: Full<Instrument>, q: Full<Position>, ccy: string, today: number, opts: { wanted?: string; horizon?: number; run?: number; w?: Walker } = {}): { codes: Reason[]; contractual: boolean } {
  const codes: Reason[] = []
  const add = (code: string, detail: string) => codes.push({ code, detail })
  const wanted = opts.wanted ?? 'sovereign_zero'
  if (inst.currency !== ccy) add('CURRENCY_MISMATCH', `${inst.id} pays ${inst.currency}, not ${ccy}: an exchange rate would stand between it and the obligations`)
  let contractual = false, notSovereign = false
  switch (inst.kind) {
    case 'sovereign_zero':
    case 'sovereign_inflation_zero':
      if (inst.kind === 'sovereign_inflation_zero' && wanted === 'sovereign_zero') add('INDEXED_NOT_NOMINAL', `${inst.id} pays an inflation-indexed amount, not a fixed nominal one`)
      else if (!inst.issuer_is_currency_sovereign) { notSovereign = true; add('NOT_CURRENCY_SOVEREIGN', `${inst.id} is issued by ${inst.issuer}, not by the sovereign that issues ${inst.currency}`) }
      break
    case 'bank_deposit':
      if (inst.maturity === null || inst.face_per_lot_minor === null) break // TERMS_INCOMPLETE below says what is wrong
      add('COUNTERPARTY_BANK', `${inst.id} is a claim on ${inst.issuer}: it counts only at the contractual level`)
      contractual = true
      break
    case 'cash_at_bank':
      add('CASH_AS_INSTRUMENT', `${inst.id}: money already in a bank account is declared as bank_cash_minor (with the bank named), not as an instrument`)
      break
    case 'money_market_fund': case 'bond_fund': case 'equity_fund':
      add('MARKET_VALUE_RISK', `${inst.id} is a fund: its value on any date is not fixed in advance`)
      break
    case 'corporate_bond':
      add('ISSUER_CREDIT_RISK', `${inst.id} is a promise of ${inst.issuer}, a private issuer`)
      break
    default:
      add('BAD_INPUT', `${inst.id} has kind "${inst.kind}", which the checker does not know`)
  }
  if (opts.wanted && inst.kind !== opts.wanted) add('WRONG_INSTRUMENT_KIND', `${inst.id} is ${inst.kind}; this floor needs ${opts.wanted}`)
  if (inst.callable) add('CALLABLE', `${inst.id} can be called before maturity, so its cash cannot be dated`)
  if (!q.hold_to_maturity || q.planned_sale !== null) add('NOT_HELD_TO_MATURITY', `${inst.id} may be sold before maturity: its sale price is not fixed`)
  // a custody kind the checker does not know, or a blank custody name, is not identified custody (review PT-03; R13 M2)
  if (!(CUSTODY_KINDS as readonly unknown[]).includes(q.custody_kind) || q.custody_kind === 'unknown' || !named(q.custody)) add('CUSTODY_UNKNOWN', `${inst.id} has no identified custody`)
  // a real-terms floor is an indexed zero that names its index and its lag (section 5.1; review PT-05; R13 L2)
  const indexedFloor = inst.kind === 'sovereign_inflation_zero' && wanted === 'sovereign_inflation_zero'
  if (indexedFloor && !named(inst.index)) add('TERMS_INCOMPLETE', `${inst.id} names no inflation index: a real-terms promise must say which index it is kept in`)
  if (indexedFloor && !(isInt(inst.index_lag_months) && inst.index_lag_months >= 0 && inst.index_lag_months <= 120)) add('TERMS_INCOMPLETE', `${inst.id} gives no index lag in whole months (0 to 120): what a real promise protects depends on it`)
  const dated = inst.kind === 'sovereign_zero' || inst.kind === 'bank_deposit' || indexedFloor
  // who pays a counted line is part of the promise: a blank issuer is not named (R13 M2)
  if (dated && !named(inst.issuer)) add('TERMS_INCOMPLETE', `${inst.id} names no issuer: who pays it is part of the promise`)
  if (dated && (inst.maturity === null || inst.face_per_lot_minor === null)) add('TERMS_INCOMPLETE', `${inst.id} has no maturity date or no face value, so its cash cannot be dated or counted`)
  else if (inst.maturity !== null && !notSovereign) {
    const mat = dayNum(inst.maturity)
    if (mat <= today) add('MATURED', `${inst.id} matured on ${inst.maturity}: its cash is no longer a claim on its issuer; declare it as bank cash`)
    else if (opts.horizon !== undefined && codes.length === 0) {
      if (indexedFloor) {
        // R13 (PT-07): only a claim paying on the horizon keeps its value in the index until then; after an earlier
        // payout the money is nominal, and nothing here can keep it real without a reinvestment rate or known inflation
        if (mat < opts.horizon) add('REAL_FLOOR_PAYS_EARLY', `${inst.id} pays on ${inst.maturity}, before ${isoOf(opts.horizon)}: from then its money is nominal, and nothing here keeps it in real terms until ${isoOf(opts.horizon)} without assuming a reinvestment rate or known inflation`)
        else if (mat > opts.horizon) add('MATURES_AFTER_HORIZON', `${inst.id} pays on ${inst.maturity}, after ${isoOf(opts.horizon)}: its value on ${isoOf(opts.horizon)} is a market price`)
      } else {
        const t = cashAvailable(mat, inst.payment_lag_business_days, opts.run ?? 4, opts.w ?? null)
        if (t.date > opts.horizon) add('MATURES_AFTER_HORIZON', `${inst.id} pays on ${isoOf(t.date)} at the latest (${t.rule}), after ${isoOf(opts.horizon)}`)
      }
    }
  }
  return { codes, contractual: contractual && codes.every((c) => c.code === 'COUNTERPARTY_BANK') }
}
const union = (lists: Reason[][]): Reason[] => { const out: Reason[] = []; for (const l of lists) for (const r of l) if (!out.some((x) => x.code === r.code && x.detail === r.detail)) out.push(r); return out }

// ------------------------------------------------------------------------------------------------ 1. reserve coverage
interface Inflow { amount: number; at: number; level: 'construction' | 'contractual'; maturity: number | null }
interface Row { obligation: string; due: string; fund_by: string; amount_minor: number; cum_in_minor: number; cum_out_minor: number; slack_minor: number; rule: string }
interface Due { id: string; due: number; fundBy: number; amount: number; rule: string }

function coverage(inflows: Inflow[], dues: Due[]): Row[] {
  let out = 0
  return dues.map((o) => {
    out += o.amount
    const got = inflows.filter((i) => i.at <= o.fundBy).reduce((s, i) => s + i.amount, 0)
    return { obligation: o.id, due: isoOf(o.due), fund_by: isoOf(o.fundBy), amount_minor: o.amount, cum_in_minor: got, cum_out_minor: out, slack_minor: got - out, rule: o.rule }
  })
}

/**
 * Stages, each refusing before the next is looked at (the order is the Python checker's, inferred from the
 * differential test; section 5.1 does not fix it): the request itself and its instruments; the obligations; the
 * positions; the budget; then what each holding is and whether its cash meets each deadline.
 */
function checkReserve(r: FullReserve, hash: string): Outcome {
  const p = problems()
  currencyField(p, r.currency, 'currency')
  if (!isInt(r.horizon_days) || r.horizon_days < 1 || r.horizon_days > 36_600) p.add('BAD_INPUT', `horizon_days must be a whole number of days from 1 to 36,600 (got ${JSON.stringify(r.horizon_days)})`)
  acceptField(p, r.accept)
  dateField(p, r.as_of, 'as_of')
  for (const [k, v] of [['bank_cash_minor', r.bank_cash_minor], ['bank_insured_minor', r.bank_insured_minor]] as const) moneyField(p, v, k)
  moneyField(p, r.budget_minor, 'budget_minor', { nullable: true })
  if (!isInt(r.max_nonbusiness_run_days) || r.max_nonbusiness_run_days < 0 || r.max_nonbusiness_run_days > MAX_BUSINESS_DAYS) p.add('BAD_INPUT', `max_nonbusiness_run_days must be a whole number of days from 0 to ${MAX_BUSINESS_DAYS}`)
  if (!isInt(r.payment_lead_business_days) || r.payment_lead_business_days < 0 || r.payment_lead_business_days > MAX_BUSINESS_DAYS) p.add('BAD_INPUT', `payment_lead_business_days must be a whole number of days from 0 to ${MAX_BUSINESS_DAYS}`)
  calendarField(p, r.calendar)
  if (r.basis !== 'nominal') p.add('REAL_BASIS_UNSUPPORTED', `a reserve can be certified in nominal terms only; "${String(r.basis)}" needs inflation-indexed instruments and a named index (ask for principal protection instead)`)
  boolField(p, r.fees_declared, 'fees_declared'); boolField(p, r.taxes_declared, 'taxes_declared')
  if (!r.fees_declared) p.add('FEES_NOT_DECLARED', 'the request does not declare that every fee payable from the reserve is listed, so an unlisted fee could leave an obligation short')
  if (!r.taxes_declared) p.add('TAXES_NOT_DECLARED', 'the request does not declare that every tax payment due in the horizon is listed')
  duplicates(p, r.instruments.map((i) => i.id), 'instrument')
  r.instruments.forEach((i, k) => instrumentFields(p, i, k))
  const readable = isInt(r.horizon_days) && r.horizon_days >= 1 && r.horizon_days <= 36_600 && typeof r.as_of === 'string' && ISO.test(r.as_of)
  const property = readable ? `The reserve covers every dated obligation due from ${isoOf(dayNum(r.as_of) + 1)} to ${isoOf(dayNum(r.as_of) + r.horizon_days)} in nominal ${String(r.currency)}` : `The reserve covers every dated obligation in nominal ${String(r.currency)}`
  const remediesFor = (list: Reason[]): string[] => {
    const out: string[] = []
    if (list.some((b) => b.code === 'FEES_NOT_DECLARED' || b.code === 'TAXES_NOT_DECLARED')) out.push('list every fee and tax payable from the reserve in the horizon, then declare the list complete')
    if (list.some((b) => b.code === 'AMOUNT_UNCERTAIN')) out.push('give each uncertain obligation an upper bound (a tax can be bounded by reserving it when the gain is realised)')
    if (list.some((b) => b.code === 'OBLIGATION_CURRENCY_MISMATCH')) out.push('ask for a separate reserve in each obligation\'s own currency')
    if (list.some((b) => b.code === 'NO_LIMIT_PRICE')) out.push('give every purchase a limit price per lot')
    if (list.some((b) => b.code === 'BUDGET_EXCEEDED')) out.push('raise the budget or buy fewer lots')
    return out
  }
  if (p.list.length) return abstain(property, hash, p.list, { remedies: remediesFor(p.list) })

  const today = dayNum(r.as_of), end = today + r.horizon_days, ccy = r.currency
  const run = r.max_nonbusiness_run_days, lead = r.payment_lead_business_days
  const w = walker(r.calendar, today, end + 60)

  duplicates(p, r.obligations.map((o) => o.id), 'obligation')
  const dues: Due[] = []
  r.obligations.forEach((o, k) => {
    if (o.currency !== ccy) { p.add('OBLIGATION_CURRENCY_MISMATCH', `obligation ${o.id} is in ${o.currency}; this request covers ${ccy} only (request each currency separately)`); return }
    const before = p.list.length
    dateField(p, o.due, `obligations[${k}].due`)
    if (p.list.length > before) return
    const due = dayNum(o.due)
    if (due <= today) { p.add('OBLIGATION_DUE_NOW_OR_PAST', `${o.id} is due ${o.due}, not after ${r.as_of}: nothing held can be certified to pay it`); return }
    if (due > end) return // outside the property's horizon: not part of what is certified
    moneyField(p, o.amount_minor, `obligations[${k}].amount_minor`, { nullable: true }); moneyField(p, o.upper_bound_minor, `obligations[${k}].upper_bound_minor`, { nullable: true })
    if (p.list.length > before) return
    const amount = o.amount_minor ?? o.upper_bound_minor
    if (amount === null) { p.add('AMOUNT_UNCERTAIN', `${o.id} has no amount and no upper bound`); return }
    const fb = fundingDeadline(due, lead, run, w)
    dues.push({ id: o.id, due, fundBy: fb.date, amount, rule: fb.rule })
  })
  if (p.list.length) return abstain(property, hash, p.list, { remedies: remediesFor(p.list) })

  const byId = new Map(r.instruments.map((i) => [i.id, i]))
  r.positions.forEach((q, k) => {
    if (!byId.has(q.instrument_id)) { p.add('UNKNOWN_INSTRUMENT', `position ${k} names unknown instrument "${q.instrument_id}"`); return }
    if (!isInt(q.lots) || q.lots < 1) { p.add('BAD_INPUT', `position ${k} (${q.instrument_id}): lots must be a positive integer (got ${JSON.stringify(q.lots)})`); return }
    // a limit price of zero or less priced the purchase at nothing (review PT-02); the Python checker refuses it too
    if (q.status === 'to_buy' && (!isInt(q.limit_price_per_lot_minor) || q.limit_price_per_lot_minor < 1)) p.add('NO_LIMIT_PRICE', `${q.instrument_id}: a purchase needs a positive integer limit price per lot, which binds execution to this certificate`)
    dateField(p, q.planned_sale, `positions[${k}].planned_sale`, true)
    positionFields(p, q, k)
  })
  if (p.list.length) return abstain(property, hash, p.list, { remedies: remediesFor(p.list) })
  const buyCost = r.positions.filter((q) => q.status === 'to_buy').reduce((s, q) => s + q.limit_price_per_lot_minor! * q.lots, 0)
  if (r.budget_minor !== null && buyCost > r.budget_minor) {
    const b = [{ code: 'BUDGET_EXCEEDED', detail: `the purchases cost up to ${money(buyCost, ccy)} at their limit prices, above the budget of ${money(r.budget_minor, ccy)}` }]
    return abstain(property, hash, b, { remedies: remediesFor(b) })
  }
  // A JavaScript number holds every sum below 2^53 minor units exactly; a request past that is refused, not rounded.
  const faceSum = r.positions.reduce((s, q) => s + (byId.get(q.instrument_id)!.face_per_lot_minor ?? 0) * q.lots, 0) + r.bank_cash_minor + dues.reduce((s, o) => s + o.amount, 0)
  if (!Number.isSafeInteger(faceSum)) return abstain(property, hash, [{ code: 'BAD_INPUT', detail: 'the sums in this request exceed 2^53 minor units, the largest this checker adds exactly' }])

  const accepts = (l: Level) => r.accept.includes(l)
  const inflows: Inflow[] = []
  const construction: Record<string, unknown>[] = []
  const notCounted: Reason[][] = []
  // what the request's own bank money and deposits would add if it accepted 'contractual' (for the remedy only)
  const ifContractual: Inflow[] = []
  for (const q of r.positions) {
    const inst = byId.get(q.instrument_id)!
    const c = classify(inst, q, ccy, today)
    const level = c.codes.length === 0 ? 'construction' : c.contractual && accepts('contractual') ? 'contractual' : null
    if (!level) {
      notCounted.push(c.codes)
      if (c.contractual) ifContractual.push({ amount: inst.face_per_lot_minor! * q.lots, at: cashAvailable(dayNum(inst.maturity!), inst.payment_lag_business_days, run, w).date, level: 'contractual', maturity: dayNum(inst.maturity!) })
      continue
    }
    const t = cashAvailable(dayNum(inst.maturity!), inst.payment_lag_business_days, run, w)
    const face = inst.face_per_lot_minor! * q.lots
    inflows.push({ amount: face, at: t.date, level, maturity: dayNum(inst.maturity!) })
    construction.push({
      instrument: inst.id, kind: inst.kind, issuer: inst.issuer, lots: q.lots, face: money(face, ccy), face_minor: face, maturity: inst.maturity, cash_available_by: isoOf(t.date), rule: t.rule,
      custody: q.custody, custody_kind: q.custody_kind, status: q.status, level: level === 'construction' ? 'by_construction' : 'contractual',
      ...(q.limit_price_per_lot_minor !== null ? { limit_price_per_lot: money(q.limit_price_per_lot_minor, ccy) } : {}),
    })
  }
  if (r.bank_cash_minor > 0) {
    // a contractual promise is a named party's (section 5.1): money at an unnamed or blank-named bank does not count (R13 M2)
    if (accepts('contractual') && !named(r.bank_name)) notCounted.push([{ code: 'BANK_NOT_NAMED', detail: `${money(r.bank_cash_minor, ccy)} in the bank counts only as a named bank's promise, and the request names no bank` }])
    else if (accepts('contractual')) inflows.push({ amount: r.bank_cash_minor, at: today, level: 'contractual', maturity: today })
    else {
      notCounted.push([{ code: 'BANK_CASH_NOT_BY_CONSTRUCTION', detail: `${money(r.bank_cash_minor, ccy)} in the bank is a claim on that bank, not on the sovereign: it counts only if "contractual" is accepted` }])
      if (named(r.bank_name)) ifContractual.push({ amount: r.bank_cash_minor, at: today, level: 'contractual', maturity: today })
    }
  }

  // Within one deadline the order changes only the intermediate rows, never the last (binding) one: smaller amounts
  // first, then as listed (the Python checker's order, found by the differential test).
  dues.sort((a, b) => a.fundBy - b.fundBy || a.amount - b.amount)
  const total = dues.reduce((s, o) => s + o.amount, 0)
  const byConstruction = coverage(inflows.filter((i) => i.level === 'construction'), dues)
  const withContract = coverage(inflows, dues)
  const okC = byConstruction.every((x) => x.slack_minor >= 0)
  const okK = withContract.every((x) => x.slack_minor >= 0)
  const level: 'construction' | 'contractual' | null = okC ? 'construction' : okK && accepts('contractual') ? 'contractual' : null
  const rows = level === 'construction' ? byConstruction : accepts('contractual') ? withContract : byConstruction

  if (level === null) {
    const short = rows.find((x) => x.slack_minor < 0)!
    const reasons: Reason[] = [{ code: 'COVERAGE_SHORTFALL', detail: `by ${short.fund_by} (${short.obligation}) eligible cash falls short by ${money(-short.slack_minor, ccy)}` }, ...union(notCounted)]
    // Remedies that are true and can be followed (review PT-08). A short deadline is one of three kinds: before today
    // (nothing counts, not even money already in the account, which counts from today); from today until the earliest
    // day a bill bought now can count (only money already in the account can); or later (a purchase can). For the
    // last kind, buying the largest gap, maturing by the latest date whose cash counts by the first such deadline,
    // covers every later deadline too, and no smaller face can (the largest gap must be met by its own deadline).
    const remedies: string[] = []
    const under = w ? `the calendar ${w.name}` : 'the conservative buffer'
    const shortRows = rows.filter((y) => y.slack_minor < 0)
    let firstBuy: Row | null = null, buyGap = 0
    for (const x of shortRows) {
      const dl = dayNum(x.fund_by)
      if (dl < today) remedies.push(`${x.obligation}: its funding deadline ${x.fund_by} is before ${r.as_of}, so nothing bought now, and no money already in the account (it counts from ${r.as_of}), can be shown to pay it in time under ${under}. ${w ? 'Move' : 'Supply a business-day calendar that covers the period, or move'} the payment date`)
      else if (latestMaturity(dl, run, w) <= today) remedies.push(`${x.obligation}: no bill bought now pays out by its funding deadline ${x.fund_by} under ${under} (one maturing tomorrow counts from ${isoOf(cashAvailable(today + 1, 0, run, w).date)}). Only money already in the payment account can pay it: by then ${money(-x.slack_minor, ccy)} more is needed in all, for it and everything due before it; declare it as bank cash with the bank named, and accept 'contractual'${w ? '' : '; or supply a business-day calendar that covers the period'}; or move the payment date`)
      else { firstBuy ??= x; buyGap = Math.max(buyGap, -x.slack_minor) }
    }
    const gap = Math.max(0, -rows.reduce((m, x) => Math.min(m, x.slack_minor), 0))
    const evidence: Record<string, unknown> = { coverage: rows, largest_gap_minor: gap }
    if (firstBuy) {
      const m = isoOf(latestMaturity(dayNum(firstBuy.fund_by), run, w))
      // exact only if the purchase also fits the budget (R13 L5): say how much the budget leaves
      const left = r.budget_minor === null ? null : r.budget_minor - buyCost
      remedies.push(`add at least ${money(buyGap, ccy)} of face in ${ccy} sovereign zero-coupon instruments (the ${ccy} issuer's own, held to maturity in named custody, with no payment lag) maturing after ${r.as_of} and on or before ${m}, so that their cash counts by ${firstBuy.fund_by}${left === null ? '' : `; bought now, they must also fit the budget, which leaves ${money(Math.max(0, left), ccy)} at limit prices`}${firstBuy !== shortRows[0] ? '; once the earlier deadlines above are dealt with, check again' : ''}`)
      evidence.remedy_buy = { face_minor: buyGap, mature_after: r.as_of, mature_on_or_before: m, cash_by: firstBuy.fund_by }
    }
    // this remedy was never offered: its condition could not hold when 'contractual' was not accepted
    if (!accepts('contractual') && ifContractual.length && coverage([...inflows, ...ifContractual], dues).every((x) => x.slack_minor >= 0)) remedies.push("accept 'contractual': the bank money and deposits in this request then cover every deadline, as a promise of the bank (named), not by construction")
    if (notCounted.some((l) => l.some((x) => x.code === 'BANK_NOT_NAMED'))) remedies.push('name the bank that holds the money (bank_name): a contractual promise is a named bank\'s')
    return abstain(property, hash, reasons, { remedies, evidence })
  }

  // certified: who stands behind it, and what could break it
  // Every counted position is listed, each with its level, as the Python checker lists them (found by the
  // differential test); who stands behind the certificate follows from the level actually relied on.
  const used = construction
  const sovereign = used.filter((c) => c.level === 'by_construction')
  const issuers = [...new Set(sovereign.map((c) => String(c.issuer)))]
  const custodies = [...new Set(sovereign.map((c) => String(c.custody)))]
  const banks = level === 'contractual' ? [...new Set(used.filter((c) => c.level === 'contractual').map((c) => String(c.issuer)))] : []
  const peak = peakInTransit(inflows.filter((i) => level === 'contractual' || i.level === 'construction'), dues)
  const insured = r.bank_insured_minor
  const bankName = r.bank_name.trim() // counted only when named (BANK_NOT_NAMED otherwise)
  const cashUsed = level === 'contractual' && r.bank_cash_minor > 0
  const pending = used.filter((c) => c.status === 'to_buy').length
  const counterparties: Record<string, unknown>[] = [
    ...issuers.map((n) => ({ name: n, role: 'issuer of the zero-coupon instruments (pays face at maturity)' })),
    ...custodies.map((n) => ({ name: n, role: `custody (${String(sovereign.find((c) => c.custody === n)?.custody_kind ?? 'unknown')})` })),
    ...banks.map((n) => ({ name: n, role: 'deposit-taking bank (repays the deposit at maturity: a contractual promise)' })),
    ...(cashUsed ? [{ name: bankName, role: `holds ${money(r.bank_cash_minor, ccy)} already in the payment account (a contractual claim)` }] : []),
    { name: r.settlement_bank, role: 'payment account between maturity and payment', peak_exposure: money(peak, ccy), peak_exposure_minor: peak, insured_minor: insured },
  ]
  const failure = [
    ...issuers.map((n) => `${n} does not pay face value at maturity (default, restructuring or redenomination)`),
    ...custodies.map((n) => `custody failure at ${n} (insolvency, fraud or operational loss)`),
    ...banks.map((n) => `${n} fails or does not repay the deposit at maturity (insured up to ${money(r.instruments.find((i) => i.issuer === n)?.deposit_insurance_minor ?? 0, ccy)} as declared)`),
    ...(cashUsed ? [`${bankName} fails or freezes the account holding ${money(r.bank_cash_minor, ccy)}`] : []),
    `the payment bank fails while up to ${money(peak, ccy)} is in transit (insured up to ${money(insured, ccy)} as declared by the caller)`,
    'an obligation not listed in the request (the caller declared fees and taxes complete)',
    'a listed amount is wrong, or an uncertain obligation exceeds its stated upper bound',
    'a non-business day or payment delay longer than the calendar or buffer assumed',
    'legal or regulatory action (capital controls, freezes, tax changes)',
    'operational error in buying or paying (wrong instrument, missed instruction)',
    ...(r.positions.some((q) => q.status === 'to_buy') ? ['a purchase does not fill at or below its limit price before the first deadline: the certificate then lapses and the checker must be re-run (no action proceeds)'] : []),
  ]
  const minSlack = rows.length ? Math.min(...rows.map((x) => x.slack_minor)) : 0
  // what exactly is promised, in one sentence (R13: nominal or real, gross or net, conditional on what, and when)
  const claim = `Nominal ${ccy}. Each listed obligation due from ${isoOf(today + 1)} to ${isoOf(end)} is paid in full on time, ${dues.length ? `${dues.length} obligation${dues.length === 1 ? '' : 's'} in all, ${money(total, ccy)}` : 'none is listed, so there is nothing to cover'}; fees and taxes count only as listed. ${level === 'construction' ? 'By construction: it relies on the issuer paying face and on the named custody, and on the payment bank while money is in transit' : 'Contractual: it also relies on the named bank'}${pending ? `, and it holds only once the ${pending === 1 ? 'purchase is' : `${pending} purchases are`} made at or below the limit price` : ''}.`
  return outcome(level === 'construction' ? 'CERTIFIED_BY_CONSTRUCTION' : 'CERTIFIED_CONTRACTUAL', property, hash, {
    protected: { basis: 'nominal', currency: ccy, horizon_end: isoOf(end), obligations: dues.length, total: money(total, ccy), total_minor: total, fees: 'fees payable from the reserve are covered only as listed obligations', taxes: "listed tax payments are covered; tax on the instruments' own discount income is a separate obligation and is covered only if listed", claim, purchases_pending: pending },
    construction: used,
    assumptions: [
      'instruments are held to maturity and not lent, pledged or sold',
      'positions come from the custody record, not from user entry, and no lot is listed twice',
      'obligation amounts and dates are as listed (upper bounds used where amounts are uncertain)',
      w ? `cash timing follows the calendar ${w.name}, which the request states covers ${r.calendar!.covers_from} to ${r.calendar!.covers_to}`
        : `with no calendar: no run of non-business days is longer than ${run} day${run === 1 ? '' : 's'}, and each payment leaves ${lead} business day${lead === 1 ? '' : 's'} before it is due${run < 4 || lead < 1 ? ' (shorter than the 4-day run and 1-day lead section 5.1 assumes: the request asserts it, for example for a payment system that runs every day)' : ''}`,
      'no reinvestment income is counted; surplus cash earns nothing in this check',
      ...(pending ? [`the ${pending === 1 ? 'purchase fills' : `${pending} purchases fill`} at or below the limit price before the first deadline; until then nothing is protected`] : []),
    ],
    liquidity: `Covered amounts are not available for other uses before their dates; selling an instrument early voids this certificate. Smallest slack across deadlines: ${money(minSlack, ccy)}.`,
    funding_underwriter: level === 'construction'
      ? `No underwriter: the payments are funded by the instruments themselves${issuers.length ? ` (${issuers.join(', ')})` : ''}.`
      : `No underwriter: the payments are funded by the instruments themselves${issuers.length ? ` (${issuers.join(', ')})` : ''} and by the bank${[...banks, ...(cashUsed ? [bankName] : [])].length ? ` (${[...banks, ...(cashUsed ? [bankName] : [])].join(', ')})` : ''}.`,
    enforcement: 'Holding the instruments to maturity in the named custody; the payment instruction is executed by the wallet only after this certificate is re-checked against current holdings.',
    counterparties, failure_conditions: failure,
    evidence: { coverage: rows, min_slack_minor: minSlack },
  })
}

/** The most money that can sit in the payment account between an instrument paying out and an obligation leaving it,
 *  counting what the certificate relies on: inflows at the earliest they can land (maturity; money already in the
 *  account from today, when a contractual certificate relies on it), outflows at the latest they can leave (the due
 *  date). The first version left that money out; the differential test showed the Python checker counts it, which
 *  is right: it is exposed to the same bank. The Python checker took an obligation's money out at its funding
 *  deadline and counted cash from its cash-available date, which understated the exposure when an instrument matured
 *  between a deadline and its due date; since r11-goa-1.1 it counts as this function does. */
function peakInTransit(inflows: Inflow[], dues: { due: number; amount: number }[]): number {
  const ev: [number, number][] = []
  for (const i of inflows) if (i.maturity !== null) ev.push([i.maturity, i.amount])
  for (const o of dues) ev.push([o.due, -o.amount])
  ev.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let bal = 0, peak = 0
  for (const [, a] of ev) { bal += a; peak = Math.max(peak, bal) }
  return peak
}

// ------------------------------------------------------------------------------------------------ 2. principal protection
/**
 * "At <horizon> the account holds at least <principal> (<basis>, <tax basis>, net of the charges listed)", established
 * by construction or refused. The owner chooses the protection; the checker never certifies a weaker claim in its place
 * (R13). Weaker claims the owner may ask for instead are named in `alternatives`, never certified silently.
 *
 * Nominal: a floor of the currency sovereign's zeros whose cash is in the account by the horizon. Every dated charge and
 * the principal are funding requirements, checked cumulatively against the floor's dated cash as a reserve is: a charge
 * due once a line has paid may consume it, and the rest must still meet the requirement; a charge due earlier needs a
 * line that has already paid. Charges without dates can fall due tomorrow, before anything here pays: refused
 * (FEES_UNDATED). The floor's money waits with its custody from payout to the horizon, and the certificate names that.
 *
 * Real: the floor is the currency sovereign's index-linked zeros paying on the horizon itself, in one named index with
 * one stated lag (INDEX_MIXED otherwise). An earlier payout is nominal money from then on, which nothing here keeps real
 * without a reinvestment rate or known inflation (REAL_FLOOR_PAYS_EARLY); no "near enough" window is allowed. What is
 * protected is the index's reference value for the horizon, which reflects prices `lag` months earlier, and the
 * certificate says so. Its floor pays only at the horizon, so a real promise carries no charges (CHARGES_WITH_REAL_FLOOR).
 *
 * After tax: the request says when the tax on the accretion is charged (TAX_TIMING_UNKNOWN otherwise). At payout it is
 * reserved from each line: nominal, ceil(rate x (face - cost)) for a line bought now (a line already held has no cost to
 * measure from: TAX_BASIS_UNKNOWN); real, ceil(rate x face), the most it can come to in real terms whatever inflation
 * turns out (the tax on F x I - C, divided by I, is below rate x F for every I > 0). Yearly, it falls due before the
 * floor pays: a nominal promise needs each payment listed as a dated charge (TAX_NOT_LISTED otherwise); an indexed
 * floor's yearly tax depends on inflation not yet known (TAX_UNBOUNDED). Rates and money are exact (ceilTimes).
 *
 * The risky sleeve has limited liability only; the port also requires it in the promise's own currency and within what
 * the budget leaves after the floor (RISKY_SLEEVE_CURRENCY, RISKY_SLEEVE_TOO_LARGE: its policy, stricter than 5.1).
 */
interface FloorLine { inst: Full<Instrument>; q: Full<Position>; face: number; cost: number | null; cash: Timing; tax: number }
function checkPrincipal(r: FullPrincipal, hash: string): Outcome {
  const p = problems()
  currencyField(p, r.currency, 'currency')
  acceptField(p, r.accept)
  dateField(p, r.as_of, 'as_of'); dateField(p, r.horizon, 'horizon')
  moneyField(p, r.principal_minor, 'principal_minor'); moneyField(p, r.budget_minor, 'budget_minor'); moneyField(p, r.fees_from_account_minor, 'fees_from_account_minor')
  if (r.basis !== 'nominal' && r.basis !== 'real') p.add('BAD_INPUT', `basis must be "nominal" or "real" (got ${JSON.stringify(r.basis)})`)
  if (r.tax_basis !== 'before_tax' && r.tax_basis !== 'after_tax') p.add('BAD_INPUT', `tax_basis must be "before_tax" or "after_tax" (got ${JSON.stringify(r.tax_basis)})`)
  if (r.max_tax_rate !== null && !(typeof r.max_tax_rate === 'number' && r.max_tax_rate >= 0 && r.max_tax_rate <= 1)) p.add('BAD_INPUT', 'max_tax_rate must be a fraction from 0 to 1')
  if (r.tax_timing !== null && r.tax_timing !== 'on_payout' && r.tax_timing !== 'yearly') p.add('BAD_INPUT', `tax_timing must be "on_payout" or "yearly" (got ${JSON.stringify(r.tax_timing)})`)
  calendarField(p, r.calendar)
  if (!isInt(r.max_nonbusiness_run_days) || r.max_nonbusiness_run_days < 0 || r.max_nonbusiness_run_days > MAX_BUSINESS_DAYS) p.add('BAD_INPUT', `max_nonbusiness_run_days must be a whole number of days from 0 to ${MAX_BUSINESS_DAYS}`)
  duplicates(p, r.instruments.map((i) => i.id), 'instrument')
  r.instruments.forEach((i, k) => instrumentFields(p, i, k))
  r.risky.forEach((h, k) => { moneyField(p, h.value_minor, `risky[${k}].value_minor`); otherCurrencyField(p, h.currency, `risky[${k}].currency`); leverageField(p, h.leverage, `risky[${k}].leverage`); boolField(p, h.limited_liability, `risky[${k}].limited_liability`); boolField(p, h.short_options, `risky[${k}].short_options`); boolField(p, h.margin, `risky[${k}].margin`) })
  boolField(p, r.withdrawals_before_horizon, 'withdrawals_before_horizon')
  // as the Python checker requires; a horizon before as_of certified a promise of nothing (review PT-13)
  const datesRead = typeof r.as_of === 'string' && typeof r.horizon === 'string' && ISO.test(r.as_of) && ISO.test(r.horizon)
  if (datesRead && r.horizon <= r.as_of) p.add('BAD_INPUT', 'horizon must be after as_of')
  r.fees.forEach((f, k) => {
    const before = p.list.length
    dateField(p, f.due, `fees[${k}].due`); moneyField(p, f.amount_minor, `fees[${k}].amount_minor`)
    if (typeof f.payee !== 'string') p.add('BAD_INPUT', `fees[${k}].payee must be text`)
    if (p.list.length === before && datesRead && (f.due <= r.as_of || f.due > r.horizon)) p.add('BAD_INPUT', `fees[${k}].due must be after as_of and on or before the horizon: a charge after the horizon is not part of this promise`)
  })
  const named_ = isInt(r.principal_minor) && typeof r.currency === 'string' && r.currency in MINOR_DIGITS
  const property = `At ${String(r.horizon)} the account holds at least ${named_ ? money(r.principal_minor, r.currency) : String(r.principal_minor)} (${String(r.basis)}, ${String(r.tax_basis).replace('_', ' ')}, net of the charges listed)`
  if (p.list.length) return abstain(property, hash, p.list)

  const ccy = r.currency, today = dayNum(r.as_of), horizon = dayNum(r.horizon), run = r.max_nonbusiness_run_days
  const w = walker(r.calendar, today, horizon + 60)
  const byId = new Map(r.instruments.map((i) => [i.id, i]))
  const charged = r.fees.reduce((s, f) => s + f.amount_minor, 0)
  const need0 = r.principal_minor + charged
  r.positions.forEach((q, k) => {
    if (!byId.has(q.instrument_id)) { p.add('UNKNOWN_INSTRUMENT', `position ${k} names unknown instrument "${q.instrument_id}"`); return }
    if (!isInt(q.lots) || q.lots < 1) p.add('BAD_INPUT', `position ${k} (${q.instrument_id}): lots must be a positive integer`)
    positionFields(p, q, k)
  })
  if (p.list.length) return abstain(property, hash, p.list, { evidence: { floor_face_minor: 0, need_minor: need0 } })

  const real = r.basis === 'real'
  const wanted = real ? 'sovereign_inflation_zero' : 'sovereign_zero'
  const reasons: Reason[] = [], excluded: Reason[][] = []
  const add = (code: string, detail: string) => reasons.push({ code, detail })
  if (r.withdrawals_before_horizon) add('EARLY_WITHDRAWAL', 'withdrawals before the horizon would come out of the floor: the promise holds only if nothing is taken out first')
  for (const h of r.risky) {
    if (unboundedLeverage(h.leverage) || h.short_options || h.margin || !h.limited_liability) add('RISKY_SLEEVE_UNLIMITED_LIABILITY', `${h.id} can lose more than its value (${[unboundedLeverage(h.leverage) ? `leverage ${h.leverage}` : '', h.short_options ? 'written options' : '', h.margin ? 'margin' : '', !h.limited_liability ? 'no limited liability' : ''].filter(Boolean).join(', ')}): losses could reach the floor`)
  }
  if (real && (r.fees_from_account_minor > 0 || r.fees.length)) add('CHARGES_WITH_REAL_FLOOR', `a real promise here carries no charges: its floor pays only on ${r.horizon}, so a charge before then needs money held outside the promise, and ${money(r.fees_from_account_minor + charged, ccy)} of charges are listed`)
  else if (r.fees_from_account_minor > 0) add('FEES_UNDATED', `${money(r.fees_from_account_minor, ccy)} of charges have no dates: they can fall due tomorrow, before anything here pays, and paying them by selling floor lots early is not by construction`)

  const lines: FloorLine[] = []
  for (const q of r.positions) {
    const inst = byId.get(q.instrument_id)!
    const c = classify(inst, q, ccy, today, { wanted, horizon, run, w })
    if (c.codes.length) { excluded.push(c.codes); continue }
    // zero or less priced the floor at nothing and left more than the budget for risk (review PT-02)
    if (q.status === 'to_buy' && (!isInt(q.limit_price_per_lot_minor) || q.limit_price_per_lot_minor < 1)) { p.add('NO_LIMIT_PRICE', `${q.instrument_id}: a purchase needs a positive integer limit price per lot`); continue }
    lines.push({ inst, q, face: inst.face_per_lot_minor! * q.lots, cost: q.status === 'to_buy' ? q.limit_price_per_lot_minor! * q.lots : null, cash: cashAvailable(dayNum(inst.maturity!), inst.payment_lag_business_days, run, w), tax: 0 })
  }
  const face = lines.reduce((s, l) => s + l.face, 0), cost = lines.reduce((s, l) => s + (l.cost ?? 0), 0)
  if (p.list.length) return abstain(property, hash, [...p.list, ...reasons], { evidence: { floor_face_minor: face, need_minor: need0 } })
  const indices = [...new Set(lines.map((l) => `${String(l.inst.index)} (lag ${String(l.inst.index_lag_months)} months)`))]
  if (real && indices.length > 1) add('INDEX_MIXED', `the floor mixes ${indices.join(' and ')}: a real promise is kept in one index with one lag`)
  if (real && !lines.length) add('REAL_BASIS_NO_INSTRUMENT', `a real-terms promise needs an inflation-indexed ${ccy} sovereign zero paying on ${r.horizon}, naming its index and lag, held to maturity; the request has none that counts`)
  if (r.tax_basis === 'after_tax') {
    if (r.max_tax_rate === null) add('TAX_RATE_UNKNOWN', 'an after-tax promise needs the highest tax rate that can apply to the accretion')
    if (r.tax_timing === null) add('TAX_TIMING_UNKNOWN', 'an after-tax promise needs to know when the tax on the floor\'s accretion is charged: when the floor pays, or each year before it (as US rules tax STRIPS)')
    else if (r.tax_timing === 'yearly') {
      if (real) add('TAX_UNBOUNDED', 'a yearly tax on an indexed floor\'s accretion depends on inflation not yet known, so no amount set aside now can be shown to be enough')
      else if (!r.fees.length) add('TAX_NOT_LISTED', 'a yearly tax on the accretion falls due before the floor pays; each payment must be listed with its date and amount among the charges')
    } else {
      if (!real && lines.some((l) => l.cost === null)) add('TAX_BASIS_UNKNOWN', 'the floor already held has no recorded cost, so the tax on its accretion cannot be bounded')
      if (r.max_tax_rate !== null) for (const l of lines) l.tax = real ? ceilTimes(r.max_tax_rate, l.face) : l.cost === null ? 0 : ceilTimes(r.max_tax_rate, Math.max(0, l.face - l.cost))
    }
  }
  const tax = lines.reduce((s, l) => s + l.tax, 0)
  const need = need0 + tax
  const riskyTotal = r.risky.reduce((s, h) => s + (h.currency === ccy ? h.value_minor : 0), 0)
  // every sum exact, as in the reserve: past 2^53 minor units a sum is refused, not rounded (review PT-10)
  if (![face, cost, tax, need, riskyTotal].every(Number.isSafeInteger)) return abstain(property, hash, [{ code: 'BAD_INPUT', detail: 'the sums in this request exceed 2^53 minor units, the largest this checker adds exactly' }])
  // dated charges and the principal as funding requirements (nominal), against each line's payout net of its tax
  const reqs: Due[] = [
    ...r.fees.map((f) => { const fb = fundingDeadline(dayNum(f.due), 0, run, w); return { id: `charge on ${f.due}${named(f.payee) ? ` (${f.payee.trim()})` : ''}`, due: dayNum(f.due), fundBy: fb.date, amount: f.amount_minor, rule: fb.rule } }),
    { id: 'principal', due: horizon, fundBy: horizon, amount: r.principal_minor, rule: 'held on the horizon' },
  ].sort((a, b) => a.fundBy - b.fundBy || a.amount - b.amount)
  const inflows: Inflow[] = lines.map((l) => ({ amount: l.face - l.tax, at: l.cash.date, level: 'construction', maturity: dayNum(l.inst.maturity!) }))
  const rows = !real && r.fees.length ? coverage(inflows, reqs) : []
  const structural = reasons.length > 0
  if (!structural && face < need) add('FLOOR_SHORT', `the floor pays ${money(face, ccy)} by ${r.horizon}; it needs ${money(need, ccy)} (the principal${charged ? ' + the charges' : ''}${tax ? ' + tax on the payout' : ''})`)
  else if (!structural && rows.some((x) => x.slack_minor < 0)) {
    const x = rows.find((y) => y.slack_minor < 0)!
    add('CHARGE_NOT_FUNDED', `the ${x.obligation}, ${money(x.amount_minor, ccy)}, falls due before enough of the floor has paid: by ${x.fund_by}, ${money(x.cum_in_minor, ccy)} has paid against ${money(x.cum_out_minor, ccy)} owed`)
  } else if (!structural && cost > r.budget_minor) add('PROTECTION_UNAFFORDABLE', `the floor costs ${money(cost, ccy)} at its limit prices, more than the ${money(r.budget_minor, ccy)} available`)
  const maxRisky = r.budget_minor - cost
  const risky = riskyTotal
  // the port's budget-fit policy, judged last like the sleeve's size: a sleeve in another currency, or the same code
  // spelt otherwise, cannot be set against the budget (R13 L1, PT-16); one that fits is limited to what the budget leaves
  const foreign = r.risky.filter((h) => h.currency !== ccy)
  if (!reasons.length && foreign.length) add('RISKY_SLEEVE_CURRENCY', `${foreign.map((h) => `${h.id} is held in ${h.currency}`).join('; ')}; the budget is in ${ccy}, so whether the sleeve fits beside the floor cannot be checked without an exchange rate`)
  else if (!reasons.length && risky > maxRisky) add('RISKY_SLEEVE_TOO_LARGE', `the risky sleeve holds ${money(risky, ccy)}; after paying for the floor only ${money(maxRisky, ccy)} remains`)
  const taxText = r.tax_basis === 'before_tax' ? 'before tax' : r.tax_timing === 'yearly' ? 'after tax, with each yearly tax payment listed among the charges' : `after tax charged when the floor pays (at most ${String(r.max_tax_rate)} of ${real ? 'its whole indexed payout, whatever inflation turns out' : 'its accretion'}: ${money(tax, ccy)} reserved)`

  if (reasons.length) {
    const all = union([reasons, ...excluded])
    const has = (code: string) => all.some((x) => x.code === code)
    const remedies: string[] = []
    if (has('FLOOR_SHORT')) {
      // its cash must count by the horizon (nominal), or it must pay on the horizon itself (real) (review PT-08; R13)
      const m = real ? horizon : latestMaturity(horizon, run, w)
      const taxedAll = real && r.tax_basis === 'after_tax' && r.tax_timing === 'on_payout' && r.max_tax_rate !== null
      const more = taxedAll ? faceAfterTax(need0, r.max_tax_rate!) : null
      remedies.push(taxedAll && more === null ? 'none while the whole payout can be taxed at a rate of 100%'
        : m <= today ? `no zero bought now pays by ${r.horizon} under ${w ? `the calendar ${w.name}` : 'the conservative buffer'}: choose a later horizon`
        : real ? `hold at least ${money((more ?? need) - face, ccy)} more face (${money(more ?? need, ccy)} in all) in ${ccy} index-linked sovereign zeros paying on ${r.horizon} itself, in the same index`
        : `add at least ${money(need - face, ccy)} of face in ${ccy} sovereign zero-coupon instruments (no payment lag) maturing after ${r.as_of} and on or before ${isoOf(m)}, so that they pay by ${r.horizon}${r.tax_basis === 'after_tax' ? '; more if bought at a discount, since the added accretion is taxed too' : ''}`)
    }
    if (has('CHARGE_NOT_FUNDED')) {
      const x = rows.find((y) => y.slack_minor < 0)!
      const gap = Math.max(...rows.map((y) => -y.slack_minor)), m = latestMaturity(dayNum(x.fund_by), run, w)
      remedies.push(m > today ? `add at least ${money(gap, ccy)} of face in ${ccy} sovereign zeros (no payment lag) maturing after ${r.as_of} and on or before ${isoOf(m)}, so that their cash counts by ${x.fund_by}; or move the charge to after the floor pays` : `no zero bought now pays by ${x.fund_by}: pay the ${x.obligation} from money outside this account, or move it to after the floor pays`)
    }
    if (has('FEES_UNDATED')) remedies.push('list each charge with its date (fees): one due after part of the floor has paid can be paid from it, and an earlier one from a bill that has paid by then')
    if (has('CHARGES_WITH_REAL_FLOOR')) remedies.push('pay the charges from money held outside this promise (a reserve of bills for them, for example), or ask for the nominal promise, which can carry dated charges')
    if (has('TAX_TIMING_UNKNOWN')) remedies.push('say when the tax on the floor\'s accretion is charged: "on_payout" (when the floor pays) or "yearly" (before it, as US rules tax STRIPS)')
    if (has('TAX_NOT_LISTED')) remedies.push('list each yearly tax payment, with its date and amount from the instrument\'s accrual schedule, among the charges (fees)')
    if (has('TAX_UNBOUNDED')) remedies.push('ask for the promise before tax, or hold the floor where its tax is charged when it pays')
    if (has('REAL_FLOOR_PAYS_EARLY')) remedies.push(`an index-linked ${ccy} sovereign zero paying on ${r.horizon} itself; or a real promise at the date the floor pays (a different horizon, which you would choose)`)
    if (has('INDEX_MIXED')) remedies.push('hold the whole floor in one index with one lag')
    if (has('REAL_BASIS_NO_INSTRUMENT')) remedies.push('none with these instruments; a nominal promise is a separate, weaker claim you can ask for instead (see the alternatives)')
    if (has('RISKY_SLEEVE_UNLIMITED_LIABILITY')) remedies.push('hold only limited-liability assets in the risky sleeve (no leverage, margin or written options)')
    if (has('RISKY_SLEEVE_CURRENCY')) remedies.push(`hold the risky part in ${ccy}, or leave it out of this promise`)
    if (has('EARLY_WITHDRAWAL')) remedies.push('take no withdrawals before the horizon, or protect a smaller principal')
    if (has('PROTECTION_UNAFFORDABLE')) remedies.push('protect a smaller principal, or a later horizon (a longer zero costs less today)')
    if (has('RISKY_SLEEVE_TOO_LARGE')) remedies.push(`keep the risky sleeve at or below ${money(maxRisky, ccy)}`)
    // a weaker claim is never certified in place of the one asked for; it is named, for the owner to choose (R13)
    const alternatives = [
      ...(real ? [`A separate, weaker claim you can ask for instead: "At ${r.horizon} the account holds at least ${money(r.principal_minor, ccy)} (nominal, ${r.tax_basis.replace('_', ' ')})". It keeps the amount, not its purchasing power; QED checks it only if you ask for it.`] : []),
      ...(r.tax_basis === 'after_tax' && all.some((x) => x.code.startsWith('TAX_')) ? [`A separate, weaker claim you can ask for instead: the same promise before tax. Tax on the floor would then come out of what it pays; QED checks it only if you ask for it.`] : []),
    ]
    return abstain(property, hash, all, { remedies, alternatives, evidence: { floor_face_minor: face, need_minor: need, ...(rows.length ? { coverage: rows } : {}) } })
  }

  const issuers = [...new Set(lines.map((l) => l.inst.issuer.trim()))], custodies = [...new Set(lines.map((l) => l.q.custody.trim()))]
  const pending = lines.filter((l) => l.q.status === 'to_buy').length
  const idx = real ? lines[0]!.inst : null
  // nominal: the floor's money waits with its custody from payout to the horizon (R13 M6: named, with how much at once)
  const held = real ? 0 : peakInTransit(inflows, r.fees.map((f) => ({ due: dayNum(f.due), amount: f.amount_minor })))
  const firstCash = real ? null : isoOf(Math.min(...lines.map((l) => l.cash.date)))
  const claim = real
    ? `Real, in ${String(idx!.index)} terms: on ${r.horizon} ${issuers.join(', ')} owe${issuers.length === 1 ? 's' : ''} the account at least ${money(r.principal_minor, ccy)} as measured by the index's reference value for ${r.horizon}, which reflects prices about ${String(idx!.index_lag_months)} month${idx!.index_lag_months === 1 ? '' : 's'} earlier; price rises in those last months are not protected, nor is anything after ${r.horizon}. ${taxText[0]!.toUpperCase()}${taxText.slice(1)}; no charges. By construction: it relies on the issuer paying the indexed amount and on the named custody.`
    : `Nominal ${ccy}: on ${r.horizon} the account holds at least ${money(r.principal_minor, ccy)}, ${taxText}, net of ${r.fees.length ? `the ${r.fees.length} dated charge${r.fees.length === 1 ? '' : 's'} listed (${money(charged, ccy)})` : 'charges (none is listed)'}. By construction: it relies on ${issuers.join(', ')} paying face, and on the named custody, which holds the floor's money once it pays (from ${firstCash}) until ${r.horizon}.`
  return outcome('CERTIFIED_BY_CONSTRUCTION', property, hash, {
    protected: { basis: r.basis, tax_basis: r.tax_basis, tax_timing: r.tax_timing, currency: ccy, horizon: r.horizon, principal: money(r.principal_minor, ccy), principal_minor: r.principal_minor, charges_minor: charged, fees_covered_minor: charged, tax_reserved_minor: tax, claim, purchases_pending: pending, ...(idx ? { index: idx.index, index_lag_months: idx.index_lag_months } : {}) },
    construction: lines.map((l) => ({ instrument: l.inst.id, kind: l.inst.kind, issuer: l.inst.issuer, lots: l.q.lots, face: money(l.face, ccy), face_minor: l.face, maturity: l.inst.maturity, cash_available_by: isoOf(l.cash.date), rule: l.cash.rule, custody: l.q.custody, custody_kind: l.q.custody_kind, status: l.q.status, ...(l.tax ? { tax_reserved_minor: l.tax } : {}), ...(real ? { index: l.inst.index, index_lag_months: l.inst.index_lag_months } : {}) })),
    assumptions: [
      'the floor instruments are held to maturity in the named custody',
      'the risky sleeve has limited liability: it can fall to zero but not below',
      `no withdrawals before the horizon, and the charges listed are every charge to the account before it, on the dates listed (${r.fees.length ? money(charged, ccy) : 'none'})`,
      ...(real ? [`the promise is in ${String(idx!.index)} terms, not the household's own prices; it is owed on ${r.horizon} and paid after the payment lag`] : []),
      ...(r.tax_basis === 'after_tax' && r.tax_timing === 'yearly' ? ['every yearly tax payment on the floor\'s accretion is among the charges listed'] : []),
      ...(r.tax_basis === 'after_tax' && r.tax_timing === 'on_payout' ? [`the tax on the floor is charged only when it pays, and comes to at most ${String(r.max_tax_rate)} of its gain (the payout less its cost), the tax authority's rounding included`] : []),
      ...(real ? ['the issuer pays the face times the index ratio for the horizon; its rounding of that payment to a whole minor unit is not allowed for'] : []),
      ...(!real ? [w ? `cash timing follows the calendar ${w.name}` : `with no calendar: no run of non-business days is longer than ${run} day${run === 1 ? '' : 's'}${run < 4 ? ' (shorter than the 4 days section 5.1 assumes: the request asserts it)' : ''}`] : []),
      ...(pending ? [`the ${pending === 1 ? 'purchase fills' : `${pending} purchases fill`} at or below the limit price; until then nothing is protected`] : []),
    ],
    liquidity: `The floor is locked until ${r.horizon}; at most ${money(maxRisky, ccy)} can go to the risky sleeve. The upside of that sleeve is not guaranteed: it can be worth nothing.`,
    funding_underwriter: `No underwriter: the floor is paid by ${issuers.join(', ')} at maturity.`,
    enforcement: 'Holding the floor to maturity in the named custody; the wallet refuses a withdrawal or a trade that would break the floor.',
    counterparties: [
      ...issuers.map((n) => ({ name: n, role: real ? 'issuer of the index-linked floor (owes the indexed amount on the horizon)' : 'issuer of the floor (pays face at maturity)' })),
      ...custodies.map((n) => ({ name: n, role: 'custody of the floor' })),
      // who holds the money once the floor pays, and how much at once (R13 M6), as the reserve names its payment bank
      ...(real ? [] : [{ name: custodies.join(' and '), role: `holds the floor's money from its payout (from ${firstCash}) until ${r.horizon}`, peak_exposure: money(held, ccy), peak_exposure_minor: held }]),
    ],
    failure_conditions: [
      ...issuers.map((n) => `${n} does not pay ${real ? 'the indexed amount' : 'face value'} at maturity (default, restructuring or redenomination)`),
      ...custodies.map((n) => `custody failure at ${n}`),
      ...(real ? [] : [`${custodies.join(' or ')} fails while holding up to ${money(held, ccy)} of the floor's money before ${r.horizon}`]),
      ...(real ? [`the index ${String(idx!.index)} (lag ${String(idx!.index_lag_months)} months) is not the household's own price index; it may rise less than the household's costs, and prices in the last ${String(idx!.index_lag_months)} months before ${r.horizon} are not reflected`] : []),
      'a charge or tax not listed, or larger than listed', 'legal or regulatory action (capital controls, freezes, tax changes)', 'operational error in buying or holding the floor',
      ...(pending ? ['a purchase does not fill at or below its limit price (the certificate lapses before any action)'] : []),
    ],
    evidence: { floor_cost_minor: cost, floor_face_minor: face, need_minor: need, max_risky_minor: maxRisky, ...(rows.length ? { coverage: rows } : {}) },
  })
}
/** The least amount to move from loss-bearing holdings into zeros at or below face so that worst <= threshold x total, exactly. */
function moveFor(worst: number, threshold: number, total: number): number { const { n, d } = decimal(threshold); return Number(ceilDiv(BigInt(worst) * d - n * BigInt(total), d)) }
/** The least total face F with F - ceil(rate x F) >= target (a real floor taxed on its whole payout), or null at 100%. */
function faceAfterTax(target: number, rate: number): number | null {
  const { n, d } = decimal(rate)
  if (n >= d) return null
  let f = Number(ceilDiv(BigInt(target) * d, d - n))
  while (f > 0 && f - 1 - ceilTimes(rate, f - 1) >= target) f--
  while (f - ceilTimes(rate, f) < target) f++
  return f
}

// ------------------------------------------------------------------------------------------------ 3. CVaR bound
/**
 * By construction only when the largest possible loss is within the threshold: CVaR is at most the essential supremum
 * of the loss for every distribution (section 5.1). Otherwise, at most a model bound, issued only if both backtests
 * pass and the bootstrap upper bound is within the threshold. The by-construction part was written from section 5.1;
 * after the model path was taken from the Python checker (coverageModel.ts), this function's codes and conditions were
 * aligned with check_cvar there (level in (0.5, 1), threshold in [0, 1), the unbounded case reported as
 * GUARANTEE_NOT_POSSIBLE_AT_THIS_EXPOSURE, NO_MODEL_DATA, MODEL_DATA_TOO_SHORT).
 */
function checkCVaR(r: FullCVaR, hash: string): Outcome {
  const p = problems()
  currencyField(p, r.base_currency, 'base_currency')
  acceptField(p, r.accept)
  dateField(p, r.as_of, 'as_of'); dateField(p, r.horizon_end, 'horizon_end')
  if (!(typeof r.level === 'number' && r.level > 0.5 && r.level < 1)) p.add('BAD_INPUT', 'level must be between 0.5 and 1')
  if (!(typeof r.threshold === 'number' && r.threshold >= 0 && r.threshold < 1)) p.add('BAD_INPUT', 'threshold must be a fraction in [0, 1)')
  if (!r.holdings.length) p.add('BAD_INPUT', 'no holdings')
  r.holdings.forEach((h, k) => {
    moneyField(p, h.value_minor, `holdings[${k}].value_minor`); otherCurrencyField(p, h.currency, `holdings[${k}].currency`); dateField(p, h.maturity, `holdings[${k}].maturity`, true)
    leverageField(p, h.leverage, `holdings[${k}].leverage`); moneyField(p, h.face_minor, `holdings[${k}].face_minor`, { nullable: true })
    for (const f of ['issuer_is_currency_sovereign', 'limited_liability', 'short_options', 'hold_to_maturity'] as const) boolField(p, h[f], `holdings[${k}].${f}`)
  })
  // a horizon that ends before it starts made every matured zero "safe" (review PT-13)
  if (typeof r.as_of === 'string' && typeof r.horizon_end === 'string' && ISO.test(r.as_of) && ISO.test(r.horizon_end) && r.horizon_end <= r.as_of) p.add('BAD_INPUT', 'horizon_end must be after as_of')
  duplicates(p, r.holdings.map((h) => h.id), 'holding')
  moneyField(p, r.charges_minor, 'charges_minor')
  const lvl = typeof r.level === 'number' ? `${Math.round(r.level * 100)}%` : '?'
  const property = `The ${lvl} CVaR of the loss from ${String(r.as_of)} to ${String(r.horizon_end)}, in ${String(r.base_currency)}, is at most ${typeof r.threshold === 'number' ? pct2(r.threshold) : '?'} of today's value`
  if (p.list.length) return abstain(property, hash, p.list)

  const ccy = r.base_currency, end = dayNum(r.horizon_end), today = dayNum(r.as_of)
  const total = r.holdings.reduce((s, h) => s + h.value_minor, 0)
  if (!Number.isSafeInteger(total + r.charges_minor)) return abstain(property, hash, [{ code: 'BAD_INPUT', detail: 'the holdings add up to more than 2^53 minor units, the largest this checker adds exactly' }]) // review PT-10
  if (total <= 0) return abstain(property, hash, [{ code: 'BAD_INPUT', detail: 'portfolio value is zero' }])
  const table: Record<string, unknown>[] = []
  const unbounded: string[] = []
  let worst = 0
  for (const h of r.holdings) {
    if (!h.limited_liability || unboundedLeverage(h.leverage) || h.short_options) { // a negative leverage is a short (review PT-04)
      unbounded.push(h.id)
      table.push({ holding: h.id, value_minor: h.value_minor, max_loss_minor: null, why: 'can lose more than its value (leverage or written options)' })
      continue
    }
    // a zero that has already paid is cash at a bank or custodian, not a claim on the sovereign (review PT-13)
    const zero = h.kind === 'sovereign_zero' && h.currency === ccy && h.issuer_is_currency_sovereign && h.hold_to_maturity && h.maturity !== null && dayNum(h.maturity) > today && dayNum(h.maturity) <= end
    // R13 (PT-15): a zero pays its face, so it loses value - face when bought above it (a negative yield); with no face
    // stated its loss cannot be bounded below its value
    const loss = zero && h.face_minor !== null ? Math.max(0, h.value_minor - h.face_minor) : h.value_minor
    worst += loss
    table.push({ holding: h.id, value_minor: h.value_minor, value: money(h.value_minor, ccy), ...(h.face_minor !== null ? { face_minor: h.face_minor } : {}), max_loss_minor: loss, why: zero ? (h.face_minor === null ? 'own-currency sovereign zero maturing within the horizon, but no face is stated: its loss cannot be bounded below its value' : loss ? `own-currency sovereign zero valued above its face: it loses ${money(loss, ccy)} by maturity` : 'own-currency sovereign zero maturing within the horizon: pays its face, at least its value today (nominal)') : h.currency !== ccy ? `held in ${h.currency}, valued in ${ccy}: exchange-rate loss bounded only by its value` : 'can lose up to its full value within the horizon' })
  }
  // charges to the book within the horizon are a certain loss, net of nothing (R13: the outcome must fit the bound)
  worst += r.charges_minor
  // exact: worst <= threshold x total with the threshold as written, never a float product (R13: rounding must not manufacture compliance)
  if (!unbounded.length && atMostTimes(worst, r.threshold, total)) {
    return outcome('CERTIFIED_BY_CONSTRUCTION', property, hash, {
      protected: { currency: ccy, basis: 'nominal', measure: `CVaR at ${lvl}`, threshold: r.threshold, worst_case_loss_share: worst / total, horizon_end: r.horizon_end, charges_minor: r.charges_minor, claim: `Nominal ${ccy}, on today's value of ${money(total, ccy)}: the ${lvl} CVaR of the loss to ${r.horizon_end}, net of the ${money(r.charges_minor, ccy)} of charges stated, is at most ${pct2(r.threshold)} of that value, for every distribution the holdings allow; the largest possible loss is ${money(worst, ccy)}. By construction: it relies on the zeros' issuer paying face and on the holdings being as declared.` },
      construction: table,
      assumptions: ['CVaR of any loss distribution is at most its largest possible loss', 'holdings are as declared (limited liability, no leverage, no written options)', 'own-currency sovereign zeros are held to maturity within the horizon and pay the face stated', `every value is today's value in ${ccy} minor units; a holding in another currency is converted at today's rate by the request`, `the charges stated (${money(r.charges_minor, ccy)}) are every charge to the book before ${r.horizon_end}`],
      liquidity: 'The bound holds at the horizon; values in between can be lower for holdings marked to market.',
      funding_underwriter: 'None: the bound is a property of the holdings\' composition.',
      enforcement: 'The wallet\'s authority must cap exposure to loss-bearing holdings at the threshold.',
      counterparties: [{ name: 'own-currency sovereign', role: 'issuer of zero-coupon holdings' }],
      failure_conditions: ['sovereign default on the zero-coupon holdings', 'custody failure', 'a holding mis-declared (hidden leverage, written options, margin)', 'trades after the check that raise loss-bearing exposure above the threshold'],
      evidence: { worst_case_loss_minor: worst, total_minor: total, distribution_free: true },
    })
  }
  const reasons: Reason[] = [{ code: 'GUARANTEE_NOT_POSSIBLE_AT_THIS_EXPOSURE', detail: `the largest possible loss is ${unbounded.length ? 'unbounded' : `${pct2(worst / total)} of value`}, above the ${pct2(r.threshold)} threshold; below that only a model can bound the CVaR, and a model bound is not a guarantee` }]
  const remedies = unbounded.length
    ? [`remove leverage and written options from ${unbounded.join(', ')}`]
    : [`to make it hold by construction, move at least ${money(moveFor(worst, r.threshold, total), ccy)} from loss-bearing holdings into ${ccy} sovereign zero-coupon instruments maturing after ${r.as_of} and by ${r.horizon_end}, valued at or below their face`]
  const evidence: Record<string, unknown> = { holdings: table }
  if (r.accept.includes('model_bound') && r.scenario_returns === null) return abstain(property, hash, [...reasons, { code: 'NO_MODEL_DATA', detail: 'a model bound was acceptable but no scenario returns were supplied' }], { remedies, evidence })
  if (!r.accept.includes('model_bound') || unbounded.length) return abstain(property, hash, reasons, { remedies, evidence })
  const x = r.scenario_returns!
  if (x.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return abstain(property, hash, [...reasons, { code: 'BAD_INPUT', detail: 'scenario returns must be finite numbers' }], { remedies, evidence })
  if (!isInt(r.window) || r.window < 2 || !isInt(r.bootstrap_reps) || r.bootstrap_reps < 1 || !isInt(r.seed) || r.seed < 0) return abstain(property, hash, [...reasons, { code: 'BAD_INPUT', detail: 'window, bootstrap_reps and seed must be positive whole numbers' }], { remedies, evidence })
  if (x.length < r.window + 24) return abstain(property, hash, [...reasons, { code: 'MODEL_DATA_TOO_SHORT', detail: `${x.length} scenarios; need at least ${r.window + 24} to fit and backtest` }], { remedies, evidence })
  if (r.model !== 'hs' && r.model !== 'fhs_ewma') return abstain(property, hash, [...reasons, { code: 'BAD_INPUT', detail: `unknown model ${JSON.stringify(r.model)}` }], { remedies, evidence })
  const m: ModelResult = modelBound({ returns: x, level: r.level, window: r.window, model: r.model, lambda: r.ewma_lambda, reps: r.bootstrap_reps, seed: r.seed, source: r.scenario_source })
  const withModel = { holdings: table, model: m.evidence }
  if (m.rejected) return abstain(property, hash, [...reasons, ...m.reasons], { remedies, evidence: withModel })
  // a certain charge c adds c / total to any CVaR (translation invariance): the bound must hold with it (R13)
  const chargeShare = r.charges_minor / total
  if (m.ucb + chargeShare > r.threshold) return abstain(property, hash, [...reasons, { code: 'MODEL_BOUND_ABOVE_THRESHOLD', detail: `the model's 95% upper confidence bound on CVaR is ${pct2(m.ucb)}${r.charges_minor ? `, ${pct2(m.ucb + chargeShare)} with the charges stated,` : ''} above ${pct2(r.threshold)}` }], { remedies, evidence: withModel })
  return outcome('BOUNDED_UNDER_MODEL', `${property} (MODEL BOUND, NOT A GUARANTEE)`, hash, {
    protected: { currency: ccy, measure: `CVaR at ${lvl}`, threshold: r.threshold, estimate: m.estimate, upper_confidence_bound: m.ucb, charges_minor: r.charges_minor, claim: `Model-based, not a guarantee: nominal ${ccy}, on today's value of ${money(total, ccy)}, the ${lvl} CVaR of the loss to ${r.horizon_end}${r.charges_minor ? `, with the ${money(r.charges_minor, ccy)} of charges stated,` : ''} is estimated at ${pct2(m.estimate + chargeShare)}, with a 95% upper bound of ${pct2(m.ucb + chargeShare)}, within ${pct2(r.threshold)}. It holds only if the future resembles the window the model was fitted on; nobody stands behind it.` },
    construction: table,
    assumptions: m.assumptions,
    liquidity: 'Not applicable to a model bound.',
    funding_underwriter: 'None. Nobody pays if the bound is exceeded.',
    enforcement: 'None beyond the wallet\'s exposure limits; outcomes can exceed the bound.',
    counterparties: [],
    failure_conditions: ['a market move outside the historical window (regime change, crash, devaluation)', `in the backtest, losses exceeded the model VaR in ${(Number(m.evidence.exceedance_rate) * 100).toFixed(1)}% of months`, 'model or data error'],
    evidence: withModel,
  })
}
