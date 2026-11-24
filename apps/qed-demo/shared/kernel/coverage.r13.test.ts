/**
 * R13: protection is established or refused (the owner's ruling, docs/mandate/20261124-R13-...md section 3), and the
 * second review's findings (H1, H2, M1 to M6, L1 to L6, notes), each first as the counterexample that passed before.
 * Expected outcomes are worked by hand in the comments; the soundness properties use a scenario simulator written here,
 * apart from coverage.ts, which plays each certified request forward under adversarial calendars, charge dates, sleeve
 * losses, inflation and tax, and checks the promise. All inputs are SYNTHETIC.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { check, dayNum, isoOf, requestHash, type Outcome } from './coverage.ts'

const AS_OF = '2026-11-24'
const T0 = dayNum(AS_OF)
const day = (n: number) => isoOf(T0 + n)
const codes = (o: Outcome) => [...new Set(o.reasons.map((r) => r.code))].sort()
const zc = (extra: Record<string, unknown> = {}) => ({ id: 'Z', kind: 'sovereign_zero', currency: 'USD', issuer: 'United States Treasury', issuer_is_currency_sovereign: true, maturity: '2029-11-15', face_per_lot_minor: 10_000, ...extra })
const tips = (extra: Record<string, unknown> = {}) => zc({ id: 'TIPS', kind: 'sovereign_inflation_zero', maturity: '2029-11-30', index: 'CPI-U NSA', index_lag_months: 3, ...extra })
const buy = (extra: Record<string, unknown> = {}) => ({ instrument_id: 'Z', lots: 1000, custody: 'Broker', custody_kind: 'custodian', status: 'to_buy' as const, limit_price_per_lot_minor: 8800, ...extra })
const pp = (over: Record<string, unknown> = {}) => ({ type: 'principal' as const, as_of: AS_OF, currency: 'USD', principal_minor: 10_000_000, horizon: '2029-11-30', basis: 'nominal', tax_basis: 'before_tax', budget_minor: 10_000_000, positions: [buy()], instruments: [zc()], risky: [{ id: 'equity', value_minor: 1_200_000, currency: 'USD', limited_liability: true }], ...over })
const bill = (id: string, maturity: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'sovereign_zero', currency: 'INR', issuer: 'Government of India', issuer_is_currency_sovereign: true, maturity, face_per_lot_minor: 2_500_000, ...extra })
const held = (id: string, lots: number, extra: Record<string, unknown> = {}) => ({ instrument_id: id, lots, custody: 'RBI Retail Direct', custody_kind: 'sovereign_registry', ...extra })
const reserve = (over: Record<string, unknown> = {}) => ({
  type: 'reserve' as const, as_of: AS_OF, currency: 'INR', horizon_days: 90,
  instruments: [bill('TB-1204', '2026-12-04'), bill('TB-0101', '2027-01-01'), bill('TB-0129', '2027-01-29')],
  positions: [held('TB-1204', 2), held('TB-0101', 2), held('TB-0129', 8)],
  obligations: [{ id: 'rent-dec', due: '2026-12-20', currency: 'INR', amount_minor: 4_500_000 }, { id: 'rent-jan', due: '2027-01-20', currency: 'INR', amount_minor: 4_500_000 }, { id: 'fees-feb', due: '2027-02-20', currency: 'INR', amount_minor: 20_000_000 }],
  bank_insured_minor: 50_000_000, ...over,
})
const cv = (over: Record<string, unknown> = {}) => ({ type: 'cvar' as const, as_of: AS_OF, base_currency: 'INR', level: 0.95, horizon_end: '2026-12-24', threshold: 0.1, holdings: [{ id: 'tbill', value_minor: 9_000_000, currency: 'INR', kind: 'sovereign_zero', maturity: '2026-12-18', issuer_is_currency_sovereign: true, face_minor: 9_050_000 }, { id: 'equity', value_minor: 1_000_000, currency: 'INR', kind: 'equity_fund' }], ...over })

describe('real protection at the horizon (owner ruling; PT-07; review H1, M1, L2)', () => {
  it('an index-linked floor paying before the horizon does not establish a later real floor; the nominal claim is offered, not certified', () => {
    // PT-07: a TIPS principal zero paying 2027-01-15 was certified "real" for 2029-11-30; after 34 months of 3%
    // inflation its money buys 1 / 1.03^(34/12) = 91.97% of the promise
    const early = check(pp({ basis: 'real', instruments: [tips({ maturity: '2027-01-15' })], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_900 })], risky: [] }))
    expect(early.status).toBe('ABSTAIN')
    expect(codes(early)).toContain('REAL_FLOOR_PAYS_EARLY')
    expect(early.alternatives.join(' ')).toMatch(/separate, weaker claim .*nominal, before tax.*QED checks it only if you ask for it/)
    // one paying on the horizon itself, in one index with its lag stated, is certified, and says what it protects
    const at = check(pp({ basis: 'real', instruments: [tips()], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_900 })], risky: [] }))
    expect(at.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    const claim = String(at.protected.claim)
    expect(claim).toMatch(/^Real, in CPI-U NSA terms: on 2029-11-30 United States Treasury owes the account at least USD 100,000.00/)
    expect(claim).toMatch(/reference value for 2029-11-30, which reflects prices about 3 months earlier; price rises in those last months are not protected/)
    expect(at.failure_conditions.join(' ')).toMatch(/prices in the last 3 months before 2029-11-30 are not reflected/)
  })
  it('one index and one lag (M1), and the lag must be stated in whole months (L2)', () => {
    const two = check(pp({ basis: 'real', risky: [], instruments: [tips(), tips({ id: 'HICP', index: 'HICP' })], positions: [buy({ instrument_id: 'TIPS', lots: 500, limit_price_per_lot_minor: 9_900 }), buy({ instrument_id: 'HICP', lots: 500, limit_price_per_lot_minor: 9_900 })] }))
    expect(codes(two)).toEqual(['INDEX_MIXED'])
    const lags = check(pp({ basis: 'real', risky: [], instruments: [tips(), tips({ id: 'TIPS8', index_lag_months: 8 })], positions: [buy({ instrument_id: 'TIPS', lots: 500, limit_price_per_lot_minor: 9_900 }), buy({ instrument_id: 'TIPS8', lots: 500, limit_price_per_lot_minor: 9_900 })] }))
    expect(codes(lags)).toEqual(['INDEX_MIXED'])
    for (const lag of [null, -1, 2.5]) expect(codes(check(pp({ basis: 'real', risky: [], instruments: [tips({ index_lag_months: lag })], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_900 })] })))).toContain('TERMS_INCOMPLETE')
  })
  it('real after tax reserves tax on the whole indexed payout (H1, the reviewer\'s example)', () => {
    // Reviewer: principal 9,852,000, real, after tax 0.37, 1,000 lots of a CPI-U zero (face 10,000, limit 9,600).
    // Real after-tax value = F(1 - r) + rC/I with F = 10,000,000, C = 9,600,000: 9,550,560 at I = 1.03^3, and it tends
    // to F(1 - r) = 6,300,000 as I grows. So the promise holds for every inflation path only if F(1 - r) >= principal.
    const base = { basis: 'real', tax_basis: 'after_tax', max_tax_rate: 0.37, principal_minor: 9_852_000, risky: [], instruments: [tips()], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_600 })] }
    expect(codes(check(pp({ ...base, instruments: [tips({ maturity: '2029-11-15' })] })))).toEqual(['REAL_BASIS_NO_INSTRUMENT', 'REAL_FLOOR_PAYS_EARLY', 'TAX_TIMING_UNKNOWN'])
    const short = check(pp({ ...base, tax_timing: 'on_payout' }))
    expect(codes(short)).toEqual(['FLOOR_SHORT'])
    expect(short.evidence.need_minor).toBe(9_852_000 + 3_700_000) // 0.37 x 10,000,000 = 3,700,000 exactly
    // the least face F with F - ceil(0.37 F) >= 9,852,000 is 15,638,096: 0.37 x 15,638,096 = 5,786,095.52, rounded up 5,786,096
    expect(short.remedies[0]).toBe('hold at least USD 56,380.96 more face (USD 156,380.96 in all) in USD index-linked sovereign zeros paying on 2029-11-30 itself, in the same index')
    const ok = check(pp({ ...base, tax_timing: 'on_payout', principal_minor: 6_300_000 }))
    expect(ok.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(ok.evidence.need_minor).toBe(10_000_000)
    // yearly tax on an indexed floor depends on inflation not yet known
    expect(codes(check(pp({ ...base, tax_timing: 'yearly', principal_minor: 6_300_000 })))).toEqual(['TAX_UNBOUNDED'])
  })
  it('a real promise carries no charges, dated or not', () => {
    const r = { basis: 'real', risky: [], instruments: [tips()], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_900 })] }
    expect(codes(check(pp({ ...r, fees: [{ due: '2027-06-01', amount_minor: 10_000 }] })))).toEqual(['CHARGES_WITH_REAL_FLOOR'])
    expect(codes(check(pp({ ...r, fees_from_account_minor: 10_000 })))).toEqual(['CHARGES_WITH_REAL_FLOOR'])
  })
})

describe('charges in dated funding requirements (owner ruling; PT-14; review H2)', () => {
  // 1,010 lots of USD 100 face bought at 88.00: face USD 101,000; principal USD 100,000; a USD 1,000 charge.
  const fl = { positions: [buy({ lots: 1010 })], risky: [{ id: 'equity', value_minor: 10_000_000 - 1010 * 8800, currency: 'USD', limited_liability: true }] }
  it('charges without dates are refused: they can fall due tomorrow, before the floor pays', () => {
    // PT-14: paying USD 1,000 on day 1 sells 12 lots at 88.00, leaving USD 99,800 for a promised USD 100,000
    const o = check(pp({ ...fl, fees_from_account_minor: 100_000 }))
    expect(o.status).toBe('ABSTAIN')
    expect(codes(o)).toEqual(['FEES_UNDATED'])
  })
  it('a dated charge before the floor pays is refused unless something has paid by then; after, it may consume the floor', () => {
    const early = check(pp({ ...fl, fees: [{ due: '2026-11-25', amount_minor: 100_000, payee: 'custody fee' }] }))
    expect(codes(early)).toEqual(['CHARGE_NOT_FUNDED'])
    const rows = early.evidence.coverage as { obligation: string; fund_by: string; slack_minor: number }[]
    expect(rows.map((x) => [x.obligation, x.fund_by, x.slack_minor])).toEqual([['charge on 2026-11-25 (custody fee)', '2026-11-21', -100_000], ['principal', '2029-11-30', 0]])
    // due 2029-11-25 (funding deadline 2029-11-21, the 4-day run), after the floor's cash (2029-11-15 + 4 = 2029-11-19)
    const late = check(pp({ ...fl, fees: [{ due: '2029-11-25', amount_minor: 100_000 }] }))
    expect(late.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(late.evidence.need_minor).toBe(10_100_000)
    expect(String(late.protected.claim)).toMatch(/net of the 1 dated charge listed \(USD 1,000.00\)/)
    // one lot fewer: what remains after the charge no longer meets the principal (USD 99,900 < USD 100,000)
    expect(codes(check(pp({ ...fl, positions: [buy({ lots: 1009 })], fees: [{ due: '2029-11-25', amount_minor: 100_000 }] })))).toEqual(['FLOOR_SHORT'])
    // an early charge funded by a bill that has paid by its date: reserved once, not counted twice
    const bills = { instruments: [zc(), zc({ id: 'TB', maturity: '2026-12-10', face_per_lot_minor: 100_000 })], positions: [buy({ lots: 1000 }), buy({ instrument_id: 'TB', lots: 1, limit_price_per_lot_minor: 99_800 })], risky: [{ id: 'equity', value_minor: 10_000_000 - 8_800_000 - 99_800, currency: 'USD', limited_liability: true }] }
    const funded = check(pp({ ...bills, fees: [{ due: '2026-12-20', amount_minor: 100_000 }] }))
    expect(funded.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(funded.evidence.max_risky_minor).toBe(10_000_000 - 8_800_000 - 99_800)
    // the same bill cannot also pay a second charge: with the floor large enough in total (USD 101,000 + USD 1,000 for
    // USD 100,000 + 2 x USD 1,000), by 2027-01-16 only the bill's USD 1,000 has paid against USD 2,000 owed
    const twice = check(pp({ ...bills, positions: [buy({ lots: 1010 }), buy({ instrument_id: 'TB', lots: 1, limit_price_per_lot_minor: 99_800 })], risky: [], fees: [{ due: '2026-12-20', amount_minor: 100_000 }, { due: '2027-01-20', amount_minor: 100_000 }] }))
    expect(codes(twice)).toEqual(['CHARGE_NOT_FUNDED'])
    expect((twice.evidence.coverage as { cum_in_minor: number; cum_out_minor: number }[])[1]).toMatchObject({ cum_in_minor: 100_000, cum_out_minor: 200_000 })
  })
  it('after tax: the request says when the tax is charged; a yearly tax must be listed as dated charges (H2)', () => {
    const after = { tax_basis: 'after_tax', max_tax_rate: 0.3 }
    expect(codes(check(pp(after)))).toEqual(['TAX_TIMING_UNKNOWN'])
    // US STRIPS: original-issue discount is taxed each year; with nothing listed, nothing shows those payments are funded
    expect(codes(check(pp({ ...after, tax_timing: 'yearly' })))).toEqual(['TAX_NOT_LISTED'])
    // at payout on the nominal accretion: 0.3 x (10,000,000 - 8,800,000) = 360,000, so the floor must pay 10,360,000
    const payout = check(pp({ ...after, tax_timing: 'on_payout' }))
    expect(codes(payout)).toEqual(['FLOOR_SHORT'])
    expect(payout.evidence.need_minor).toBe(10_360_000)
  })
})

describe('above-face zeros and exact bounds (owner ruling; PT-15; review M4)', () => {
  it('a zero bought above its face loses the difference: a 5.0475% loss fails a 5% ceiling', () => {
    // JPY bills at -0.20% a year for 3 months: value 95,000,000, face 95,000,000 x (1 - 0.002/4) = 94,952,500, a certain
    // loss of 47,500 yen; with the equity (5,000,000) gone in the tail the loss is 5,047,500 of 100,000,000 = 5.0475%
    const jpy = (face: number | null, thr: number) => check({ type: 'cvar', as_of: AS_OF, base_currency: 'JPY', level: 0.95, horizon_end: '2027-02-24', threshold: thr, holdings: [{ id: 'JGB bill', value_minor: 95_000_000, currency: 'JPY', kind: 'sovereign_zero', maturity: '2027-02-24', issuer_is_currency_sovereign: true, face_minor: face }, { id: 'equity', value_minor: 5_000_000, currency: 'JPY', kind: 'equity_fund' }] })
    const above = jpy(94_952_500, 0.05)
    expect(above.status).toBe('ABSTAIN')
    expect(above.evidence.holdings).toEqual([{ holding: 'JGB bill', value_minor: 95_000_000, value: 'JPY 95,000,000', face_minor: 94_952_500, max_loss_minor: 47_500, why: 'own-currency sovereign zero valued above its face: it loses JPY 47,500 by maturity' }, { holding: 'equity', value_minor: 5_000_000, value: 'JPY 5,000,000', max_loss_minor: 5_000_000, why: 'can lose up to its full value within the horizon' }])
    expect(above.remedies[0]).toContain('JPY 47,500') // 5,047,500 - 0.05 x 100,000,000
    expect(jpy(94_952_500, 0.050475).status).toBe('CERTIFIED_BY_CONSTRUCTION') // exactly at the bound
    expect(jpy(94_952_500, 0.0504749).status).toBe('ABSTAIN')
    expect(jpy(null, 0.5).status).toBe('ABSTAIN') // no face stated: its loss cannot be bounded below its value
    expect(jpy(95_000_000, 0.05).status).toBe('CERTIFIED_BY_CONSTRUCTION') // at par: no loss
  })
  it('rounding never manufactures compliance: the comparison is exact in the threshold as written', () => {
    // 0.3 is stored as 0.29999999999999998889...; 3,000 of 10,000 is exactly 30%, and 3,001 is not
    const book = (lossBearing: number, thr: number) => check(cv({ threshold: thr, holdings: [{ id: 'z', value_minor: 10_000 - lossBearing, currency: 'INR', kind: 'sovereign_zero', maturity: '2026-12-18', issuer_is_currency_sovereign: true, face_minor: 10_000 - lossBearing }, { id: 'e', value_minor: lossBearing, currency: 'INR', kind: 'equity_fund' }] }))
    expect(book(3_000, 0.3).status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(book(3_001, 0.3).status).toBe('ABSTAIN')
    // 0.1 x 3 is 0.30000000000000004 in binary; as written it is exactly 30%
    expect(book(3_000, 0.1 * 3).status).toBe('CERTIFIED_BY_CONSTRUCTION')
    // a value just under the binary product of a rate: 7 x 0.1 = 0.7000000000000001 in floats, 0.7 as written
    expect(book(7_000, 0.7).status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(book(7_001, 0.7).status).toBe('ABSTAIN')
  })
  it('charges to the book are a certain loss (net, not gross)', () => {
    expect(check(cv({ threshold: 0.1 })).status).toBe('CERTIFIED_BY_CONSTRUCTION') // 1,000,000 of 10,000,000 = 10%
    expect(codes(check(cv({ threshold: 0.1, charges_minor: 1 })))).toEqual(['GUARANTEE_NOT_POSSIBLE_AT_THIS_EXPOSURE'])
  })
  it('values are in the base currency, and the certificate says so (M4)', () => {
    const o = check(cv({ threshold: 0.2, holdings: [cv().holdings[0], { id: 'usd fund', value_minor: 1_000_000, currency: 'USD', kind: 'equity_fund' }] }))
    expect(o.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect((o.construction[1] as { value: string; why: string }).value).toBe('INR 10,000.00')
    expect((o.construction[1] as { why: string }).why).toBe('held in USD, valued in INR: exchange-rate loss bounded only by its value')
    expect(o.assumptions.join(' ')).toMatch(/every value is today's value in INR minor units; a holding in another currency is converted at today's rate by the request/)
  })
})

describe('the second review, item by item', () => {
  it('M2: a blank custody, issuer or bank name is not a name', () => {
    expect(codes(check(reserve({ positions: [held('TB-1204', 2, { custody: ' ' }), held('TB-0101', 2), held('TB-0129', 8)] })))).toContain('CUSTODY_UNKNOWN')
    expect(codes(check(pp({ positions: [buy({ custody: '  ' })] })))).toContain('CUSTODY_UNKNOWN')
    expect(codes(check(reserve({ instruments: [bill('TB-1204', '2026-12-04', { issuer: ' ' }), bill('TB-0101', '2027-01-01'), bill('TB-0129', '2027-01-29')] })))).toContain('TERMS_INCOMPLETE')
    const cash = reserve({ positions: [], bank_cash_minor: 50_000_000, bank_name: ' ', accept: ['contractual'] })
    expect(codes(check(cash))).toEqual(['BANK_NOT_NAMED', 'COVERAGE_SHORTFALL'])
    expect(check(cash).remedies.join(' ')).toMatch(/name the bank that holds the money/)
    expect(check({ ...cash, bank_name: 'Example Bank' }).status).toBe('CERTIFIED_CONTRACTUAL')
  })
  it('M3: leads, lags and runs are bounded, so a covering calendar cannot be walked 2^53 times', () => {
    const cal = { name: 'weekends', holidays: [], covers_from: '2026-01-01', covers_to: '2027-12-31' }
    const t = Date.now()
    expect(codes(check(reserve({ calendar: cal, payment_lead_business_days: 2 ** 31 })))).toEqual(['BAD_INPUT'])
    expect(codes(check(reserve({ calendar: cal, instruments: [bill('TB-1204', '2026-12-04', { payment_lag_business_days: 2 ** 40 }), bill('TB-0101', '2027-01-01'), bill('TB-0129', '2027-01-29')] })))).toEqual(['BAD_INPUT'])
    expect(codes(check(reserve({ max_nonbusiness_run_days: 10 ** 9 })))).toEqual(['BAD_INPUT'])
    expect(codes(check(pp({ instruments: [zc({ payment_lag_business_days: 367 })] })))).toEqual(['BAD_INPUT'])
    expect(Date.now() - t).toBeLessThan(1_000)
    // a year of business days is still accepted
    expect(check(reserve({ calendar: cal, payment_lead_business_days: 366 })).status).toBe('ABSTAIN')
  })
  it('M3: in a separate process, the worst covering-calendar request returns within seconds', () => {
    const k = join(import.meta.dirname, 'coverage.ts')
    const src = `import { check } from ${JSON.stringify(k)}; const o = check({ type: 'reserve', as_of: '2026-11-24', currency: 'INR', horizon_days: 90, obligations: [{ id: 'x', due: '2026-12-20', currency: 'INR', amount_minor: 1 }], positions: [], instruments: [], calendar: { name: 'c', holidays: [], covers_from: '2026-01-01', covers_to: '2027-12-31' }, payment_lead_business_days: 9007199254740991 }); console.log(o.reasons.map((r) => r.code).join())`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 10_000 })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('BAD_INPUT')
  })
  it('M6: a nominal floor\'s money waits with its custody from payout to the horizon, and the certificate says so', () => {
    const o = check(pp())
    const c = o.counterparties.find((x) => 'peak_exposure_minor' in x)!
    expect(c).toMatchObject({ name: 'Broker', role: 'holds the floor\'s money from its payout (from 2029-11-19) until 2029-11-30', peak_exposure_minor: 10_000_000 })
    expect(o.failure_conditions).toContain('Broker fails while holding up to USD 100,000.00 of the floor\'s money before 2029-11-30')
  })
  it('L1: a risky part in another currency, or the same code spelt otherwise, cannot be set against the budget', () => {
    expect(codes(check(pp({ risky: [{ id: 'eq', value_minor: 1_000_000_000, currency: 'usd', limited_liability: true }] })))).toEqual(['RISKY_SLEEVE_CURRENCY'])
    expect(codes(check(pp({ risky: [{ id: 'eq', value_minor: 1_000_000_000, currency: 'INR', limited_liability: true }] })))).toEqual(['RISKY_SLEEVE_CURRENCY'])
  })
  it('L5: the purchase remedy is exact only within the budget, and says how much it leaves', () => {
    const o = check(reserve({ positions: [held('TB-1204', 2), held('TB-0101', 2), held('TB-0129', 7)], budget_minor: 1_000_000 }))
    expect(o.remedies.join(' ')).toMatch(/bought now, they must also fit the budget, which leaves INR 10,000.00 at limit prices/)
  })
  it('notes: a shortened buffer is stated as the request\'s assertion; a malformed request carries no fingerprint', () => {
    const fast = check(reserve({ positions: [], bank_cash_minor: 50_000_000, bank_name: 'Example Bank', accept: ['contractual'], max_nonbusiness_run_days: 0, payment_lead_business_days: 0 }))
    expect(fast.status).toBe('CERTIFIED_CONTRACTUAL')
    expect(fast.assumptions.join(' ')).toMatch(/no run of non-business days is longer than 0 days, and each payment leaves 0 business days before it is due \(shorter than the 4-day run and 1-day lead section 5.1 assumes: the request asserts it/)
    const bad = check(reserve({ obligations: {} }))
    expect(bad.request_hash).toBe('')
    expect(bad.request_hash).not.toBe(requestHash(reserve({ obligations: [] }) as never))
  })
  it('hashes: an earlier request keeps its fingerprint; a new field changes it only when set', () => {
    const before = requestHash(pp() as never)
    expect(requestHash(pp({ fees: [], tax_timing: null }) as never)).toBe(before)
    expect(requestHash(pp({ fees: [{ due: '2029-11-25', amount_minor: 1 }] }) as never)).not.toBe(before)
    expect(requestHash(cv({ charges_minor: 0 }) as never)).toBe(requestHash(cv() as never))
  })
  it('purchases not yet made: the certificate holds only once they fill, and says so', () => {
    const o = check(pp())
    expect(o.protected.purchases_pending).toBe(1)
    expect(o.assumptions).toContain('the purchase fills at or below the limit price; until then nothing is protected')
  })
})

// ------------------------------------------------------------------------------------------------ an independent oracle
/**
 * A scenario simulator, written apart from coverage.ts: it plays a certified principal request forward and reports
 * the first way the promise fails, or null. Money is exact (BigInt). For a nominal promise: a calendar whose
 * non-business runs fit the request's buffer; each line's cash lands on its true date (the first business day on or
 * after maturity, then its lag); its tax, at payout, is the declared bound rate x (face - cost), exactly; each dated
 * charge leaves on the business day on or before its due date; the risky sleeve is worth nothing. The account must
 * never go below zero to pay a charge (no floor lot is sold early) and must hold the principal on the horizon. For a
 * real promise, the index ratio I to the horizon is drawn from a wide range; the payout F x I is taxed at the bound on
 * F x I - cost (a held line's cost taken as zero), and the after-tax amount divided by I must reach the principal.
 */
function simulatePrincipal(req: Record<string, unknown>, holidays: Set<number>, ratios: [bigint, bigint][]): string | null {
  const biz = (d: number) => { const wd = (((d + 3) % 7) + 7) % 7; return wd < 5 && !holidays.has(d) }
  const fwd = (d: number, n: number) => { while (!biz(d)) d++; for (let k = 0; k < n; k++) { d++; while (!biz(d)) d++ } return d }
  const back = (d: number) => { while (!biz(d)) d--; return d }
  const insts = new Map((req.instruments as { id: string }[]).map((i) => [i.id, i as Record<string, unknown>]))
  // the tax charged at payout is at most rate x gain (the declared bound, rounding included), taken here at that bound,
  // exactly: every amount below is scaled by the rate's decimal denominator rd
  const atPayout = req.tax_basis === 'after_tax' && req.tax_timing === 'on_payout' && req.max_tax_rate !== null && req.max_tax_rate !== undefined
  const [rn, rd] = ((): [bigint, bigint] => { if (!atPayout) return [0n, 1n]; const [a, b = ''] = String(req.max_tax_rate).split('.'); return [BigInt(a! + b), 10n ** BigInt(b.length)] })()
  const P = BigInt(req.principal_minor as number), H = dayNum(req.horizon as string)
  const lines = (req.positions as Record<string, unknown>[]).map((q) => { const i = insts.get(q.instrument_id as string)!; return { F: BigInt((i.face_per_lot_minor as number) * (q.lots as number)), C: q.status === 'to_buy' ? BigInt((q.limit_price_per_lot_minor as number) * (q.lots as number)) : 0n, mat: dayNum(i.maturity as string), lag: (i.payment_lag_business_days as number) ?? 0 } })
  if (req.basis === 'real') {
    // payout F x I with I = num / den; real after-tax value = (payout - tax) / I >= P, compared exactly:
    // F num rd - rn max(0, F num - C den) >= P num rd
    for (const [num, den] of ratios) {
      let lhs = 0n
      for (const l of lines) { const gain = l.F * num - l.C * den; lhs += l.F * num * rd - (gain > 0n ? rn * gain : 0n) }
      if (lhs < P * num * rd) return `real value below ${P} at index ratio ${num}/${den}`
    }
    return null
  }
  const events: [number, bigint, string][] = lines.map((l) => [fwd(l.mat, l.lag), l.F * rd - (l.F > l.C ? rn * (l.F - l.C) : 0n), 'in'])
  for (const f of (req.fees ?? []) as { due: string; amount_minor: number }[]) events.push([back(dayNum(f.due)), -BigInt(f.amount_minor) * rd, 'out'])
  events.sort((a, b) => a[0] - b[0] || (a[2] === 'in' ? -1 : 1))
  let bal = 0n
  for (const [d, a] of events) { bal += a; if (bal < 0n) return `short ${-bal / rd} on ${isoOf(d)} paying a charge` }
  const atH = events.filter(([d]) => d <= H).reduce((s, [, a]) => s + a, 0n)
  return atH >= P * rd ? null : `holds ${atH / rd} on the horizon, below ${P}`
}
const admissible = (hol: number[]) => { const h = new Set(hol.map((x) => T0 + x)); let run = 0; for (let d = T0 - 10; d < T0 + 1500; d++) { const wd = (((d + 3) % 7) + 7) % 7; if (wd >= 5 || h.has(d)) { if (++run > 4) return null } else run = 0 } return h }

describe('soundness against the simulator (independent of coverage.ts)', () => {
  const floorReq = fc.record({
    lines: fc.array(fc.record({ mat: fc.integer({ min: 30, max: 1200 }), lots: fc.integer({ min: 1, max: 1500 }), price: fc.integer({ min: 7000, max: 10_200 }), lag: fc.integer({ min: 0, max: 2 }), held: fc.boolean() }), { minLength: 1, maxLength: 3 }),
    principal: fc.integer({ min: 100_000, max: 15_000_000 }),
    horizon: fc.integer({ min: 200, max: 1300 }),
    charges: fc.array(fc.record({ at: fc.integer({ min: 1, max: 1300 }), amount: fc.integer({ min: 1, max: 400_000 }) }), { maxLength: 3 }),
    after: fc.oneof(fc.constant(null), fc.record({ rate: fc.integer({ min: 0, max: 600 }).map((v) => v / 1000), timing: fc.constantFrom('on_payout', 'yearly') })),
  }).map((x) => ({
    type: 'principal', as_of: AS_OF, currency: 'USD', principal_minor: x.principal, horizon: day(x.horizon), basis: 'nominal', tax_basis: x.after ? 'after_tax' : 'before_tax', budget_minor: 40_000_000,
    max_tax_rate: x.after?.rate ?? null, tax_timing: x.after?.timing ?? null,
    instruments: x.lines.map((l, k) => zc({ id: `Z${k}`, maturity: day(l.mat), payment_lag_business_days: l.lag })),
    positions: x.lines.map((l, k) => buy({ instrument_id: `Z${k}`, lots: l.lots, status: l.held ? 'held' : 'to_buy', limit_price_per_lot_minor: l.held ? null : l.price })),
    fees: x.charges.filter((c) => c.at <= x.horizon).map((c) => ({ due: day(c.at), amount_minor: c.amount })), risky: [],
  }))
  it('nominal: whatever admissible calendar comes, a certified promise pays every charge without selling the floor and holds the principal', () => {
    let certified = 0
    fc.assert(fc.property(floorReq, fc.uniqueArray(fc.integer({ min: 0, max: 1400 }), { maxLength: 40 }), (req, hol) => {
      const o = check(req)
      if (o.status !== 'CERTIFIED_BY_CONSTRUCTION') return
      const h = admissible(hol)
      if (!h) return
      certified++
      expect(simulatePrincipal(req, h, [])).toBeNull()
    }), { numRuns: 3000, seed: 20261124 })
    expect(certified).toBeGreaterThan(100)
  })
  it('real: a certified promise keeps its real after-tax value for every index ratio from 0.5 to 1,000,000', () => {
    const ratios: [bigint, bigint][] = [[1n, 2n], [1n, 1n], [109_273n, 100_000n], [3n, 1n], [1_000n, 1n], [1_000_000n, 1n]]
    let certified = 0
    fc.assert(fc.property(fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 7000, max: 10_200 }), fc.integer({ min: 100_000, max: 25_000_000 }), fc.integer({ min: 0, max: 600 }), fc.boolean(), (lots, price, principal, rate, after) => {
      const req = { ...pp({ basis: 'real', principal_minor: principal, risky: [], instruments: [tips()], positions: [buy({ instrument_id: 'TIPS', lots, limit_price_per_lot_minor: price })], budget_minor: 40_000_000 }), ...(after ? { tax_basis: 'after_tax', max_tax_rate: rate / 1000, tax_timing: 'on_payout' } : {}) }
      const o = check(req)
      if (o.status !== 'CERTIFIED_BY_CONSTRUCTION') return
      certified++
      expect(simulatePrincipal(req, new Set(), ratios)).toBeNull()
    }), { numRuns: 2000, seed: 7 })
    expect(certified).toBeGreaterThan(100)
  })
  it('the simulator can fail: the counterexamples that once passed fail it', () => {
    // H1: real after tax, the tax reserved on the nominal gain only (what r11-goa-1.1 and r12-goa-ts-1.1 certified)
    const h1 = { ...pp({ basis: 'real', risky: [], instruments: [tips()], positions: [buy({ instrument_id: 'TIPS', limit_price_per_lot_minor: 9_600 })] }), tax_basis: 'after_tax', max_tax_rate: 0.37, tax_timing: 'on_payout', principal_minor: 9_852_000 }
    expect(simulatePrincipal(h1, new Set(), [[109_273n, 100_000n]])).toMatch(/real value below 9852000 at index ratio 109273\/100000/)
    // PT-14: a charge on day 1, before the floor pays
    expect(simulatePrincipal(pp({ positions: [buy({ lots: 1010 })], fees: [{ due: '2026-11-25', amount_minor: 100_000 }] }), new Set(), [])).toMatch(/short 100000 on 2026-11-25/)
  })
  it('CVaR: a certified bound holds for every loss distribution the holdings allow, faces and charges included', () => {
    let certified = 0
    fc.assert(fc.property(fc.array(fc.record({ v: fc.integer({ min: 1, max: 10_000_000 }), kind: fc.constantFrom('zero', 'fund', 'usd'), faceBp: fc.integer({ min: 9_900, max: 10_300 }) }), { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 950 }), fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 2 ** 31 - 1 }), (hs, thr, charges, seed) => {
      const holdings = hs.map((h, k) => h.kind === 'zero' ? { id: `h${k}`, value_minor: h.v, currency: 'INR', kind: 'sovereign_zero', maturity: '2026-12-18', issuer_is_currency_sovereign: true, face_minor: Math.floor((h.v * h.faceBp) / 10_000) } : { id: `h${k}`, value_minor: h.v, currency: h.kind === 'usd' ? 'USD' : 'INR', kind: 'equity_fund' })
      const o = check(cv({ threshold: thr / 1000, holdings, charges_minor: charges }))
      if (o.status !== 'CERTIFIED_BY_CONSTRUCTION') return
      certified++
      const total = BigInt(hs.reduce((s, h) => s + h.v, 0))
      let a = seed >>> 0
      const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
      // 200 equally likely scenarios: zeros pay their face exactly; everything else loses nothing, all, or part
      const losses = Array.from({ length: 200 }, () => hs.reduce((s, h) => s + (h.kind === 'zero' ? BigInt(Math.max(0, h.v - Math.floor((h.v * h.faceBp) / 10_000))) : BigInt(Math.floor(h.v * [0, 1, u()][Math.floor(u() * 3)]!))), 0n) + BigInt(charges)).sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))
      const tail = losses.slice(0, 10).reduce((s, x) => s + x, 0n) // the worst 5% of 200
      expect(tail * 1000n <= BigInt(thr) * total * 10n).toBe(true) // mean of 10 <= thr/1000 x total
    }), { numRuns: 2000, seed: 3 })
    expect(certified).toBeGreaterThan(100)
  })
  it('never a weaker claim than asked: a real request is certified only as real, an after-tax one only after tax', () => {
    fc.assert(fc.property(fc.constantFrom('nominal', 'real'), fc.constantFrom('before_tax', 'after_tax'), fc.integer({ min: 1, max: 1500 }), fc.constantFrom('2029-11-15', '2029-11-30'), (basis, tax, lots, mat) => {
      const o = check(pp({ basis, tax_basis: tax, max_tax_rate: 0.2, tax_timing: 'on_payout', risky: [], instruments: [zc(), tips({ maturity: mat })], positions: [buy({ lots }), buy({ instrument_id: 'TIPS', lots, limit_price_per_lot_minor: 9_900 })] }))
      if (o.status === 'ABSTAIN') return
      expect(o.protected.basis).toBe(basis)
      expect(o.protected.tax_basis).toBe(tax)
      expect(String(o.protected.claim).startsWith(basis === 'real' ? 'Real' : 'Nominal')).toBe(true)
    }), { numRuns: 400, seed: 11 })
  })
})

describe('stored certificates and what may act on them (R13: no execution on invalid evidence)', () => {
  it('only the lab computes guarantee outcomes, and it stores none: every certificate is recomputed by the kernel in force', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const server = join(import.meta.dirname, '..', '..', 'server')
    // the checker directly, or through the kernel's one entry point (shared/kernel/index.ts exports it as checkCoverage)
    const importers = readdirSync(server).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && /kernel\/coverage(\.ts)?['"]|\bcheckCoverage\b/.test(readFileSync(join(server, f), 'utf8')))
    expect(importers).toEqual(['lab.ts'])
    const lab = readFileSync(join(server, 'lab.ts'), 'utf8')
    expect(lab).not.toMatch(/\.run\(|INSERT|UPDATE /) // reads and computes only; its one proposal (the mix) does not rest on a certificate
    expect(lab).not.toMatch(/storeProposal\([^)]*outcome/)
  })
})
