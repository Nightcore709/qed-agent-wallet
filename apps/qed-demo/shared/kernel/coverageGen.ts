/**
 * Generated guarantee-or-abstain requests (fast-check), for the differential test against the Python checker
 * (scripts/coverage-differential.ts) and the property tests (coverage.test.ts). SYNTHETIC inputs only: made-up
 * instruments, amounts, calendars and return series that exist to exercise the checkers, never market data.
 *
 * The mix leans to the hard parts of section 5.1: sovereign bills against deadlines near the buffer, calendars that
 * cover all, part or none of the period, holidays, lags and leads, bank money with and without "contractual", funds,
 * other currencies, uncertain amounts, purchases with and without limit prices, budgets, floors short by a lot,
 * leverage, real terms, after-tax promises, CVaR books near their threshold, and model bounds on calm and clustered
 * series. A small share carries deliberately malformed money (a fraction, a boolean) to check both refuse it.
 *
 * Not generated: a cash_at_bank instrument. Both checkers refuse one with CASH_AS_INSTRUMENT (money in the account
 * belongs in bank_cash_minor; the Python checker dropped it without a reason before r11-goa-1.1). Kept out so the
 * generated requests for a given seed stay the ones the earlier runs used. coverage.test.ts pins the port's side.
 */
import fc from 'fast-check'
import { dayNum, isoOf } from './coverage.ts'

export const AS_OF = '2026-11-24'
/**
 * R13 fields (dated charges, tax timing, real floors paying on the horizon, faces of zeros, charges to a CVaR book) are
 * derived deterministically from values already drawn, so they consume no randomness: a seed draws the same requests
 * as before, each extended. QED_GEN_V1=1 leaves them out, for a like-for-like comparison with the earlier runs.
 */
const V1 = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.QED_GEN_V1 === '1'
const T0 = dayNum(AS_OF)
const day = (n: number): string => isoOf(T0 + n)

/** A deterministic return series: calm months, and optionally turbulent blocks (so breaches cluster). */
export function series(seed: number, n: number, mu: number, sigma: number, crisisEvery: number, crisisLen: number): number[] {
  let a = seed >>> 0
  const u = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
  const z = (): number => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u())
  return Array.from({ length: n }, (_, t) => {
    const crisis = crisisEvery > 0 && t % crisisEvery >= crisisEvery - crisisLen
    return Math.round((crisis ? -0.02 + 0.07 * z() : mu + sigma * z()) * 1e8) / 1e8
  })
}

const money = (lo: number, hi: number) => fc.integer({ min: lo, max: hi })
/** Rarely, money that is not an integer number of minor units. */
const maybeBad = <T>(good: fc.Arbitrary<T>) => fc.oneof({ arbitrary: good, weight: 60 }, { arbitrary: fc.constantFrom<unknown>(1000.5, true, -5), weight: 1 })

const instrument = (k: number, ccy: string) => fc.record({
  kind: fc.oneof({ arbitrary: fc.constant('sovereign_zero'), weight: 12 }, { arbitrary: fc.constantFrom('bank_deposit', 'money_market_fund', 'bond_fund', 'equity_fund', 'corporate_bond', 'sovereign_inflation_zero'), weight: 4 }),
  currency: fc.oneof({ arbitrary: fc.constant(ccy), weight: 9 }, { arbitrary: fc.constantFrom('USD', 'EUR', 'JPY', 'INR'), weight: 1 }),
  sovereign: fc.oneof({ arbitrary: fc.constant(true), weight: 9 }, { arbitrary: fc.constant(false), weight: 1 }),
  maturity: fc.oneof({ arbitrary: fc.integer({ min: -6, max: 230 }).map(day), weight: 30 }, { arbitrary: fc.constant(null), weight: 1 }),
  face: fc.oneof({ arbitrary: fc.constantFrom(2_500_000, 10_000, 100_000, 1_000_000), weight: 20 }, { arbitrary: fc.constant(null), weight: 1 }),
  lag: fc.oneof({ arbitrary: fc.constant(0), weight: 4 }, { arbitrary: fc.integer({ min: 1, max: 2 }), weight: 1 }),
  callable: fc.oneof({ arbitrary: fc.constant(false), weight: 15 }, { arbitrary: fc.constant(true), weight: 1 }),
  insurance: fc.constantFrom(0, 50_000_000),
}).map((x) => ({
  id: `I${k}`, kind: x.kind, currency: x.currency, issuer: x.kind.startsWith('sovereign') ? (x.sovereign ? 'Sovereign' : 'A State Government') : x.kind.includes('bank') ? 'Example Bank' : 'Some Issuer Ltd',
  issuer_is_currency_sovereign: x.kind.startsWith('sovereign') ? x.sovereign : false, maturity: x.maturity, face_per_lot_minor: x.face,
  payment_lag_business_days: x.lag, callable: x.callable, index: x.kind === 'sovereign_inflation_zero' ? 'CPI (synthetic)' : null, index_lag_months: x.kind === 'sovereign_inflation_zero' ? 3 : null,
  deposit_insurance_minor: x.insurance, source: 'synthetic (differential test)',
}))

const position = (nInst: number) => fc.record({
  ref: fc.oneof({ arbitrary: fc.integer({ min: 0, max: Math.max(0, nInst - 1) }).map((i) => `I${i}`), weight: 20 }, { arbitrary: fc.constant('nope'), weight: 1 }),
  lots: fc.oneof({ arbitrary: fc.integer({ min: 1, max: 24 }), weight: 30 }, { arbitrary: fc.constant(0), weight: 1 }),
  custodyKind: fc.oneof({ arbitrary: fc.constantFrom('sovereign_registry', 'custodian', 'bank'), weight: 15 }, { arbitrary: fc.constant('unknown'), weight: 1 }),
  hold: fc.oneof({ arbitrary: fc.constant(true), weight: 12 }, { arbitrary: fc.constant(false), weight: 1 }),
  sale: fc.oneof({ arbitrary: fc.constant(null), weight: 12 }, { arbitrary: fc.integer({ min: 0, max: 240 }).map(day), weight: 1 }),
  toBuy: fc.boolean(),
  limit: fc.oneof({ arbitrary: fc.integer({ min: 900, max: 2_499_000 }), weight: 8 }, { arbitrary: fc.constant(null), weight: 1 }),
}).map((x) => ({ instrument_id: x.ref, lots: x.lots, custody: x.custodyKind === 'unknown' ? '' : 'Named custody', custody_kind: x.custodyKind, hold_to_maturity: x.hold, planned_sale: x.sale, status: x.toBuy ? 'to_buy' : 'held', limit_price_per_lot_minor: x.toBuy ? x.limit : null }))

const obligation = (k: number, ccy: string, horizon: number) => fc.record({
  currency: fc.oneof({ arbitrary: fc.constant(ccy), weight: 15 }, { arbitrary: fc.constantFrom('USD', 'INR'), weight: 1 }),
  due: fc.oneof({ arbitrary: fc.integer({ min: 1, max: horizon + 30 }), weight: 30 }, { arbitrary: fc.integer({ min: -3, max: 0 }), weight: 1 }),
  amount: fc.oneof({ arbitrary: maybeBad(money(1, 30_000_000)), weight: 20 }, { arbitrary: fc.constant(null), weight: 1 }),
  upper: fc.oneof({ arbitrary: fc.constant(null), weight: 2 }, { arbitrary: money(1, 30_000_000), weight: 1 }),
  kind: fc.constantFrom('payment', 'tax', 'fee'),
}).map((x) => ({ id: `O${k}`, due: day(x.due), currency: x.currency, amount_minor: x.amount, upper_bound_minor: x.amount === null ? x.upper : null, payee: 'synthetic payee', kind: x.kind }))

const calendar = (horizon: number) => fc.oneof(
  { arbitrary: fc.constant(null), weight: 5 },
  { arbitrary: fc.record({ holidays: fc.uniqueArray(fc.integer({ min: -10, max: horizon + 60 }), { maxLength: 14 }), from: fc.integer({ min: -40, max: 60 }), to: fc.integer({ min: 30, max: horizon + 120 }), weekend: fc.constantFrom([5, 6], [4, 5], [6]) }), weight: 4 },
).map((c) => (c === null ? null : { name: 'synthetic calendar', holidays: [...new Set(c.holidays)].sort((a, b) => a - b).map(day), covers_from: day(Math.min(c.from, c.to)), covers_to: day(Math.max(c.from, c.to)), weekend: c.weekend }))

export const reserveRequest = fc.record({ horizon: fc.integer({ min: 30, max: 200 }), nInst: fc.integer({ min: 1, max: 6 }), ccy: fc.constantFrom('INR', 'INR', 'USD', 'JPY') }).chain(({ horizon, nInst, ccy }) => fc.record({
  instruments: fc.tuple(...Array.from({ length: nInst }, (_, k) => instrument(k, ccy))),
  positions: fc.array(position(nInst), { maxLength: 7 }),
  obligations: fc.tuple(...Array.from({ length: 4 }, (_, k) => obligation(k, ccy, horizon))).chain((os) => fc.integer({ min: 1, max: 4 }).map((n) => os.slice(0, n))),
  accept: fc.constantFrom(['by_construction'], ['by_construction'], ['contractual'], ['by_construction', 'contractual'], ['model_bound'], ['anything']),
  bankCash: fc.oneof({ arbitrary: fc.constant(0), weight: 2 }, { arbitrary: money(1, 80_000_000), weight: 1 }),
  bankName: fc.constantFrom('', 'Example Bank'),
  insured: fc.constantFrom(0, 50_000_000),
  calendar: calendar(horizon),
  run: fc.oneof({ arbitrary: fc.constant(4), weight: 4 }, { arbitrary: fc.integer({ min: 0, max: 5 }), weight: 1 }),
  lead: fc.oneof({ arbitrary: fc.constant(1), weight: 4 }, { arbitrary: fc.integer({ min: 0, max: 2 }), weight: 1 }),
  fees: fc.oneof({ arbitrary: fc.constant(true), weight: 15 }, { arbitrary: fc.constant(false), weight: 1 }),
  taxes: fc.oneof({ arbitrary: fc.constant(true), weight: 15 }, { arbitrary: fc.constant(false), weight: 1 }),
  budget: fc.oneof({ arbitrary: fc.constant(null), weight: 3 }, { arbitrary: money(0, 200_000_000), weight: 1 }),
  basis: fc.oneof({ arbitrary: fc.constant('nominal'), weight: 20 }, { arbitrary: fc.constant('real'), weight: 1 }),
}).map((x) => ({
  type: 'reserve' as const, as_of: AS_OF, currency: ccy, horizon_days: horizon, obligations: x.obligations, positions: x.positions, instruments: x.instruments,
  accept: x.accept, basis: x.basis, bank_cash_minor: x.bankCash, bank_name: x.bankName, bank_insured_minor: x.insured, settlement_bank: 'synthetic payment account',
  calendar: x.calendar, max_nonbusiness_run_days: x.run, payment_lead_business_days: x.lead, fees_declared: x.fees, taxes_declared: x.taxes, budget_minor: x.budget,
})))

export const principalRequest = fc.record({ ccy: fc.constantFrom('USD', 'INR'), horizon: fc.integer({ min: 120, max: 1300 }), real: fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }) }).chain(({ ccy, horizon, real }) => fc.record({
  principal: money(1_000_000, 20_000_000),
  tax: fc.oneof({ arbitrary: fc.constant('before_tax'), weight: 3 }, { arbitrary: fc.constant('after_tax'), weight: 1 }),
  rate: fc.oneof({ arbitrary: fc.constant(null), weight: 1 }, { arbitrary: fc.double({ min: 0, max: 0.45, noNaN: true }).map((v) => Math.round(v * 1000) / 1000), weight: 2 }),
  insts: fc.array(fc.record({ kind: fc.constantFrom('sovereign_zero', 'sovereign_zero', 'sovereign_inflation_zero', 'bank_deposit'), ccy: fc.oneof({ arbitrary: fc.constant(ccy), weight: 8 }, { arbitrary: fc.constant(ccy === 'USD' ? 'INR' : 'USD'), weight: 1 }), mat: fc.integer({ min: 60, max: 1400 }), sovereign: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, { arbitrary: fc.constant(false), weight: 1 }), callable: fc.oneof({ arbitrary: fc.constant(false), weight: 12 }, { arbitrary: fc.constant(true), weight: 1 }) }), { minLength: 1, maxLength: 3 }),
  lots: fc.array(fc.record({ k: fc.nat(), lots: fc.integer({ min: 1, max: 2500 }), toBuy: fc.boolean(), price: fc.integer({ min: 7000, max: 9990 }), hold: fc.oneof({ arbitrary: fc.constant(true), weight: 10 }, { arbitrary: fc.constant(false), weight: 1 }), noLimit: fc.oneof({ arbitrary: fc.constant(false), weight: 10 }, { arbitrary: fc.constant(true), weight: 1 }) }), { maxLength: 3 }),
  budgetShare: fc.integer({ min: 60, max: 130 }),
  risky: fc.array(fc.record({ value: money(0, 3_000_000), lev: fc.oneof({ arbitrary: fc.constant(1.0), weight: 8 }, { arbitrary: fc.constant(2.0), weight: 1 }), opt: fc.oneof({ arbitrary: fc.constant(false), weight: 10 }, { arbitrary: fc.constant(true), weight: 1 }), margin: fc.oneof({ arbitrary: fc.constant(false), weight: 10 }, { arbitrary: fc.constant(true), weight: 1 }), ll: fc.oneof({ arbitrary: fc.constant(true), weight: 10 }, { arbitrary: fc.constant(false), weight: 1 }) }), { maxLength: 2 }),
  fees: fc.oneof({ arbitrary: fc.constant(0), weight: 3 }, { arbitrary: money(1, 200_000), weight: 1 }),
  withdraw: fc.oneof({ arbitrary: fc.constant(false), weight: 12 }, { arbitrary: fc.constant(true), weight: 1 }),
}).map((x) => {
  const instruments = x.insts.map((i, k) => ({ id: `Z${k}`, kind: i.kind, currency: i.ccy, issuer: i.sovereign ? 'Sovereign' : 'Not the sovereign', issuer_is_currency_sovereign: i.sovereign, maturity: day(i.mat), face_per_lot_minor: 10_000, payment_lag_business_days: 0, callable: i.callable, index: i.kind === 'sovereign_inflation_zero' ? 'CPI-U NSA' : null, index_lag_months: i.kind === 'sovereign_inflation_zero' ? 3 : null, deposit_insurance_minor: 0, source: 'synthetic' }))
  const positions = x.lots.map((l) => ({ instrument_id: `Z${l.k % instruments.length}`, lots: l.lots, custody: 'Broker custody account', custody_kind: 'custodian', hold_to_maturity: l.hold, planned_sale: null, status: l.toBuy ? 'to_buy' : 'held', limit_price_per_lot_minor: l.toBuy && !l.noLimit ? l.price : null }))
  // R13, derived: half the real requests hold their indexed zeros to the horizon itself; half the charges are dated
  // (some before the floor pays, some after); an after-tax request states its timing two times in three
  const r13 = !V1 && {
    dated: x.fees > 0 && x.principal % 2 === 0 ? [{ due: day(Math.max(1, horizon - (x.principal % 997))), amount_minor: x.fees, payee: 'synthetic charge' }] : [],
    timing: x.tax === 'after_tax' ? ([null, 'on_payout', 'yearly'] as const)[x.principal % 3]! : null,
    atHorizon: real && x.principal % 2 === 1,
  }
  return {
    type: 'principal' as const, as_of: AS_OF, currency: ccy, principal_minor: x.principal, horizon: day(horizon), basis: real ? 'real' : 'nominal', tax_basis: x.tax, budget_minor: Math.round((x.principal * x.budgetShare) / 100),
    positions, instruments: r13 && r13.atHorizon ? instruments.map((i) => (i.kind === 'sovereign_inflation_zero' ? { ...i, maturity: day(horizon) } : i)) : instruments,
    risky: x.risky.map((h, k) => ({ id: `R${k}`, value_minor: h.value, currency: ccy, limited_liability: h.ll, leverage: h.lev, short_options: h.opt, margin: h.margin })),
    fees_from_account_minor: r13 && r13.dated.length ? 0 : x.fees, max_tax_rate: x.rate, withdrawals_before_horizon: x.withdraw, accept: ['by_construction'], calendar: null, max_nonbusiness_run_days: 4,
    ...(r13 ? { fees: r13.dated, tax_timing: r13.timing } : {}),
  }
}))

export const cvarRequest = fc.record({ ccy: fc.constantFrom('INR', 'USD') }).chain(({ ccy }) => fc.record({
  holdings: fc.array(fc.record({ kind: fc.constantFrom('sovereign_zero', 'sovereign_zero', 'equity_fund', 'bond_fund', 'money_market_fund'), value: money(0, 50_000_000), foreign: fc.oneof({ arbitrary: fc.constant(false), weight: 6 }, { arbitrary: fc.constant(true), weight: 1 }), mat: fc.integer({ min: 5, max: 120 }), lev: fc.oneof({ arbitrary: fc.constant(1.0), weight: 15 }, { arbitrary: fc.constant(3.0), weight: 1 }), held: fc.oneof({ arbitrary: fc.constant(true), weight: 10 }, { arbitrary: fc.constant(false), weight: 1 }) }), { minLength: 1, maxLength: 5 }),
  threshold: fc.integer({ min: 0, max: 989 }).map((v) => v / 1000),
  level: fc.constantFrom(0.95, 0.95, 0.99, 0.9),
  model: fc.oneof({ arbitrary: fc.constant(null), weight: 2 }, { arbitrary: fc.record({ seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }), n: fc.integer({ min: 40, max: 260 }), window: fc.constantFrom(12, 24, 36, 60, 120), mu: fc.constantFrom(0.004, 0.008), sigma: fc.constantFrom(0.01, 0.03, 0.05), crisis: fc.constantFrom(0, 0, 60, 120), model: fc.constantFrom('hs', 'fhs_ewma', 'hs', 'fhs_ewma', 'magic'), reps: fc.integer({ min: 20, max: 160 }), lambda: fc.constantFrom(0.94, 0.97) }), weight: 3 }),
  modelNull: fc.oneof({ arbitrary: fc.constant(false), weight: 8 }, { arbitrary: fc.constant(true), weight: 1 }),
}).map((x) => ({
  type: 'cvar' as const, as_of: AS_OF, base_currency: ccy, level: x.level, horizon_end: day(30), threshold: x.threshold,
  // R13, derived: a zero's face is above its value (a discount) for most, below it (bought above face) when its value
  // is a multiple of 5, and not stated when a multiple of 7; a book whose first value is a multiple of 3 has charges
  holdings: x.holdings.map((h, k) => ({ id: `H${k}`, value_minor: h.value, currency: h.foreign ? (ccy === 'INR' ? 'USD' : 'INR') : ccy, kind: h.kind, maturity: h.kind === 'sovereign_zero' ? day(h.mat) : null, issuer_is_currency_sovereign: h.kind === 'sovereign_zero', limited_liability: true, leverage: h.lev, short_options: false, hold_to_maturity: h.held, ...(!V1 && h.kind === 'sovereign_zero' ? { face_minor: h.value % 7 === 0 ? null : h.value % 5 === 0 ? h.value - Math.floor(h.value / 400) : h.value + Math.floor(h.value / 80) } : {}) })),
  ...(!V1 && x.holdings[0]!.value % 3 === 0 ? { charges_minor: Math.floor(x.holdings[0]!.value / 200) } : {}),
  accept: x.model || x.modelNull ? ['by_construction', 'model_bound'] : ['by_construction'],
  scenario_returns: x.model ? series(x.model.seed, x.model.n, x.model.mu, x.model.sigma, x.model.crisis, x.model.crisis ? 20 : 0) : null,
  scenario_source: 'synthetic series (differential test)', window: x.model?.window ?? 120, bootstrap_reps: x.model?.reps ?? 2000, seed: x.model?.seed ?? 20261124,
  model: x.model?.model ?? 'hs', ewma_lambda: x.model?.lambda ?? 0.97,
})))

export const anyRequest = fc.oneof({ arbitrary: reserveRequest, weight: 6 }, { arbitrary: principalRequest, weight: 2 }, { arbitrary: cvarRequest, weight: 2 })
