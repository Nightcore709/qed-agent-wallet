/**
 * The paper household: the accounts a user starts with, their recorded profile, and the model the two no-regret
 * checkers run on.
 *
 * D-049: the checkers' household model is built here from the user's own recorded balances, profile and registered
 * commitments, never from a separate fixture, and every certificate lists which monthly outflows it counted.
 */
import { AppError, bad, type Db, j, parse } from './core.ts'
import { balance, ensureAccount, post } from './ledger.ts'
import { DEFAULT_HOLD_ABOVE, DEFAULT_HOLD_HOURS, HOLD_HOURS, isHoldHours } from './new-payee.ts'
import { term } from './registry.ts'
import { X5_DEFAULT, type X5Model } from '../shared/kernel/index.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { toNum } from '../shared/fixed.ts'
import { DEFAULT_ZONE, isZone, zonedInstant, zonedParts } from '../shared/zone.ts'
import { LEGAL_JURISDICTIONS } from './legal.ts'
import { type HomeBasis, fromRupeeFigure, homeBasis, homeCurrencyOfJson, homeRefusal } from './home-currency.ts'
import { UNITS_WORD } from '../shared/home-money.ts'
import { type Currency, isPaperCurrency, PAPER_CURRENCIES } from '../shared/currency.ts'
const PAPER_CURRENCY_LIST = PAPER_CURRENCIES.join(', ')

export interface Profile {
  setup: boolean
  /** Paise a month, credited on incomeDay (1 to 28). */
  income: number
  incomeDay: number
  /** Everyday spending the owner declares, paise a month. Certificates count this figure. */
  spending: number
  /** The protected floor ("worst case must stay above this"), in paise. */
  line: number
  personalLoanEmi: number
  homeLoanEmi: number
  emiDay: number
  /** What the bank reserve must withstand: income arriving up to this many days late (0 to 15)... */
  lateDays: number
  /** ...and this many salaries not arriving at all (0 to 3). */
  lostSalaries: number
  /**
   * A payee's first 24 hours (server/new-payee.ts): once what goes to it comes to more than this many paise, the payment
   * waits newPayeeHoldHours before it is sent (0: no wait, switched off). Changed only with a passkey (api.ts PATCH
   * /api/profile), never at set-up; a change that loosens either waits out the protection delay (new-payee-wait.ts).
   */
  newPayeeHoldAbove: number
  newPayeeHoldHours: number
  /**
   * R13: the household's own time zone (an IANA name; its schedules and statement dates are computed in it) and the
   * jurisdiction it lives in (what QED offers it; server/eligibility.ts). A household made before R13 has neither and reads
   * them as Asia/Kolkata and India (zoneOf, jurisdictionOf): nothing is written to it, and nothing changes for it.
   */
  timeZone?: string
  jurisdiction?: string
  /**
   * R13 S7: the currency every figure in this profile is held in, and its paper bank is kept in. Written only for a household
   * that chose a currency other than the rupee at set-up; absent means the rupee (homeCurrencyOf), and nothing is written to a
   * household made before. It is never changed after set-up (home-currency.ts). `homeBasis` is the rate and source its
   * starting figures were converted at.
   */
  homeCurrency?: Currency
  homeBasis?: HomeBasis
}

// The default floor sits below the default household's worst case (₹8,00,000 in the bank, less ₹1,20,000 on the card
// and ₹30,000 of instalments due within 30 days = ₹6,50,000), so a new household starts with a cushion of ₹1,50,000.
export const DEFAULT_PROFILE: Profile = { setup: false, income: 12_000_000, incomeDay: 1, spending: 7_000_000, line: 50_000_000, personalLoanEmi: 1_000_000, homeLoanEmi: 2_000_000, emiDay: 5, lateDays: 5, lostSalaries: 1, newPayeeHoldAbove: DEFAULT_HOLD_ABOVE, newPayeeHoldHours: DEFAULT_HOLD_HOURS }

/** The household's time zone, defaulting from its profile: India Standard Time when none was chosen. */
/** The zone rules' version this runtime computes local times with (stage S6: recorded beside what authority depends on). */
export const TZ_VERSION = process.versions.tz ?? 'unknown'
export const zoneOf = (p: Pick<Profile, 'timeZone'>): string => p.timeZone ?? DEFAULT_ZONE
/** The jurisdiction the household lives in, defaulting from its profile: India when none was chosen. */
/** The household's home currency: the rupee when none was written. */
export const homeCurrencyOf = (p: Pick<Profile, 'homeCurrency'>): Currency => (p.homeCurrency && isPaperCurrency(p.homeCurrency) ? p.homeCurrency : 'INR')
export const jurisdictionOf = (p: Pick<Profile, 'jurisdiction'>): string => p.jurisdiction ?? 'IN'
export const householdZone = (db: Db, userId: string): string => zoneOf(getProfile(db, userId))

/**
 * The example household in a currency: the rupee example as it is, another currency's converted once at the recorded rate
 * (home-currency.ts) with the rate and source returned beside it. Thresholds round down.
 */
export function defaultsFor(currency: Currency): { opening: OpeningBalances; profile: Profile; basis: HomeBasis | null } {
  if (currency === 'INR') return { opening: DEFAULT_OPENING, profile: DEFAULT_PROFILE, basis: null }
  const n = (v: number): number => fromRupeeFigure(v, currency, 'nearest')
  const o = DEFAULT_OPENING, p = DEFAULT_PROFILE
  return {
    opening: { bank: n(o.bank), fd: n(o.fd), card: n(o.card), personalLoan: n(o.personalLoan), homeLoan: n(o.homeLoan) },
    profile: { ...p, income: n(p.income), spending: n(p.spending), line: n(p.line), personalLoanEmi: n(p.personalLoanEmi), homeLoanEmi: n(p.homeLoanEmi), newPayeeHoldAbove: fromRupeeFigure(p.newPayeeHoldAbove, currency, 'down'), homeCurrency: currency },
    basis: homeBasis(currency),
  }
}

export interface OpeningBalances { bank: number; fd: number; card: number; personalLoan: number; homeLoan: number }
/** X5's household, so that the research checkers and the wallet describe the same family. */
export const DEFAULT_OPENING: OpeningBalances = { bank: 80_000_000, fd: 0, card: 12_000_000, personalLoan: 30_000_000, homeLoan: 200_000_000 }

const STANDARD: [string, 'asset' | 'liability' | 'income' | 'expense' | 'equity' | 'clearing' | 'trading', string, boolean][] = [
  ['bank', 'asset', 'Bank account', true],
  ['fd', 'asset', 'Fixed deposit', true],
  ['recv:mf', 'asset', 'Fund redemptions on their way', true],
  ['tds', 'asset', 'Tax already deducted (credit against your tax)', true],
  ['card', 'liability', 'Credit card', true],
  ['loan:personal', 'liability', 'Personal loan', true],
  ['loan:home', 'liability', 'Home loan', true],
  ['clear:pay', 'clearing', 'Payments in progress', true],
  ['clear:mf', 'clearing', 'Fund purchases awaiting units', true],
  ['trade:INR', 'trading', 'Rupees exchanged for holdings', false],
  ['eq:opening', 'equity', 'Opening position', false],
  ['inc:salary', 'income', 'Salary', false],
  ['inc:interest', 'income', 'Interest received', false],
  ['inc:earn', 'income', 'Earned from work', false],
  ['inc:other', 'income', 'Other money in', false],
  ['exp:spend', 'expense', 'Spending', false],
  ['exp:fees', 'expense', 'Fees and charges', false],
  ['exp:interest', 'expense', 'Interest paid', false],
  ['exp:stamp', 'expense', 'Stamp duty', false],
]

/** The household's accounts, each in its home currency (the rupee unless it chose another); `trade:INR` is rupees by name. */
export function ensureStandardAccounts(db: Db, userId: string, home: Currency = 'INR'): void {
  for (const [code, kind, name, nonneg] of STANDARD) ensureAccount(db, userId, code, kind, code === 'trade:INR' ? 'INR' : home, name, nonneg)
}

export function getProfile(db: Db, userId: string): Profile {
  const r = db.get<{ profile_json: string }>('SELECT profile_json FROM users WHERE id = ?', userId)
  return { ...DEFAULT_PROFILE, ...parse<Partial<Profile>>(r?.profile_json, {}) }
}

const isPaise = (v: unknown, max = 100_000_000_000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max

/** The figures and protections a person may change after set-up (api.ts PATCH /api/profile; loosening.ts). */
export const PROFILE_KEYS = ['income', 'incomeDay', 'spending', 'line', 'personalLoanEmi', 'homeLoanEmi', 'emiDay', 'lateDays', 'lostSalaries', 'newPayeeHoldAbove', 'newPayeeHoldHours'] as const
export type ProfileKey = typeof PROFILE_KEYS[number]

export function validateProfile(p: Partial<Profile>, home: Currency = 'INR'): Record<string, string> {
  const e: Record<string, string> = {}
  const u = UNITS_WORD[home]
  if (p.income !== undefined && !isPaise(p.income)) e.income = `Enter monthly income as a whole number of ${u}.`
  if (p.spending !== undefined && !isPaise(p.spending)) e.spending = `Enter monthly spending as a whole number of ${u}.`
  if (p.line !== undefined && !isPaise(p.line)) e.line = `Enter the floor as a whole number of ${u}.`
  if (p.personalLoanEmi !== undefined && !isPaise(p.personalLoanEmi)) e.personalLoanEmi = `Enter the instalment as a whole number of ${u}.`
  if (p.homeLoanEmi !== undefined && !isPaise(p.homeLoanEmi)) e.homeLoanEmi = `Enter the instalment as a whole number of ${u}.`
  for (const k of ['incomeDay', 'emiDay'] as const) if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k]! >= 1 && p[k]! <= 28)) e[k] = 'Choose a day from 1 to 28.'
  if (p.lateDays !== undefined && !(Number.isInteger(p.lateDays) && p.lateDays >= 0 && p.lateDays <= 15)) e.lateDays = 'Choose from 0 to 15 days.'
  if (p.lostSalaries !== undefined && !(Number.isInteger(p.lostSalaries) && p.lostSalaries >= 0 && p.lostSalaries <= 3)) e.lostSalaries = 'Choose from 0 to 3 salaries.'
  if (p.newPayeeHoldAbove !== undefined && !isPaise(p.newPayeeHoldAbove)) e.newPayeeHoldAbove = `Enter the amount as a whole number of ${u}.`
  if (p.newPayeeHoldHours !== undefined && !isHoldHours(p.newPayeeHoldHours)) e.newPayeeHoldHours = `Choose ${HOLD_HOURS.slice(0, -1).join(', ')} or ${HOLD_HOURS.at(-1)} hours, or no wait.`
  if (p.timeZone !== undefined && !isZone(p.timeZone)) e.timeZone = 'Choose a time zone by its name, such as Asia/Kolkata or Europe/London.'
  if (p.homeCurrency !== undefined) e.homeCurrency = !isPaperCurrency(p.homeCurrency) ? `Choose one of ${PAPER_CURRENCY_LIST}.` : homeRefusal(p.homeCurrency) ?? ''
  if (e.homeCurrency === '') delete e.homeCurrency
  if (p.jurisdiction !== undefined && !(LEGAL_JURISDICTIONS as readonly string[]).includes(p.jurisdiction)) e.jurisdiction = `Choose one of ${LEGAL_JURISDICTIONS.join(', ')}.`
  return e
}

export function saveProfile(db: Db, userId: string, patch: Partial<Profile>): Profile {
  const errors = validateProfile(patch, homeCurrencyOf(getProfile(db, userId)))
  if (Object.keys(errors).length) throw bad('Some profile values are not valid.', errors)
  const next = { ...getProfile(db, userId), ...patch }
  db.run('UPDATE users SET profile_json = ? WHERE id = ?', j(next), userId)
  return next
}

/** Create the paper household once: accounts, opening balances and the recorded profile. All money here is paper. */
export function openHousehold(db: Db, userId: string, opening: OpeningBalances, profile: Partial<Profile>, now: number): Profile {
  for (const [k, v] of Object.entries(opening)) if (!isPaise(v)) throw bad(`Opening balance "${k}" must be a whole number of paise.`)
  // The home currency is chosen here and only here. The rupee is written as nothing: a household of rupees is the one that has none.
  const chosen = profile.homeCurrency
  const refused = chosen === undefined ? {} : validateProfile({ homeCurrency: chosen })
  if (Object.keys(refused).length) throw bad('Some profile values are not valid.', refused)
  const home: Currency = chosen ?? 'INR'
  return db.tx(() => {
    if (getProfile(db, userId).setup) throw new AppError(409, 'already_set_up', 'This household is already set up.')
    ensureStandardAccounts(db, userId, home)
    const lines: { account: string; amount: bigint }[] = []
    let equity = 0n
    const add = (account: string, amount: number, debit: boolean) => {
      if (amount <= 0) return
      const a = BigInt(amount)
      lines.push({ account, amount: debit ? a : -a })
      equity += debit ? -a : a
    }
    add('bank', opening.bank, true)
    add('fd', opening.fd, true)
    add('card', opening.card, false)
    add('loan:personal', opening.personalLoan, false)
    add('loan:home', opening.homeLoan, false)
    if (lines.length) {
      lines.push({ account: 'eq:opening', amount: equity })
      post(db, { userId, ts: now, kind: 'opening', ref: 'opening', memo: 'Paper household opened (no real money)', meta: { paper: true }, lines })
    }
    // The wait on payments to new payees is a safeguard changed only with a passkey: set-up, which a password session may do,
    // starts it at its defaults whatever the request says (server/new-payee.ts).
    const { newPayeeHoldAbove: _above, newPayeeHoldHours: _hours, homeCurrency: _home, homeBasis: _basis, ...figures } = profile
    if (home === 'INR') return saveProfile(db, userId, { ...figures, setup: true })
    // Another home currency: every figure the request left out starts at the example's, converted at the recorded rate, and the
    // rate and its source are kept with the profile. Validated in the chosen currency's words.
    const d = defaultsFor(home)
    const { setup: _s, ...example } = d.profile
    const errors = validateProfile(figures, home)
    if (Object.keys(errors).length) throw bad('Some profile values are not valid.', errors)
    const next = { ...getProfile(db, userId), ...example, ...figures, homeCurrency: home, homeBasis: d.basis!, setup: true }
    db.run('UPDATE users SET profile_json = ? WHERE id = ?', j(next), userId)
    return next
  })
}

/** The next instant a monthly event on `day` at `hm` in a zone (India when none) falls strictly after `after`. */
export function nextMonthly(after: number, day: number, hm: string, zone: string = DEFAULT_ZONE): number {
  const t = zonedParts(after, zone)
  const p = (n: number) => String(n).padStart(2, '0')
  let y = t.y, m = t.m
  for (let i = 0; i < 3; i++) {
    const at = zonedInstant(`${y}-${p(m)}-${p(day)}`, hm, zone)
    if (at > after) return at
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  throw new Error('nextMonthly: no instant found')
}

export interface CountedOutflow { label: string; monthly: number; source: string }
export interface HouseholdModel { model: X5Model; s0: number; counted: CountedOutflow[]; notCounted: string[]; asOf: number }

const rupees = (paise: bigint | number): number => Number(paise) / 100
const box = (v: unknown, d: [number, number]): [number, number] => (Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : d)

/**
 * Build the checkers' model from what is on record for this user now. Monthly outflows counted: the declared
 * everyday spending, every registered bill falling due in the next 30 days, and every active investing program's
 * monthly amount. Loan instalments are modelled separately by the checkers (as EMIs). `exceptProgramId` leaves one
 * instruction out: when that instruction itself is being sized, what is spare "before this" must not already count it.
 */
export function householdModel(db: Db, userId: string, now: number, exceptProgramId = ''): HouseholdModel {
  const p = getProfile(db, userId)
  const counted: CountedOutflow[] = [{ label: 'Everyday spending (your figure)', monthly: p.spending, source: 'profile' }]
  const bills = db.get<{ s: string; n: number }>(`SELECT amount_sum(amount) s, COUNT(*) n FROM bills WHERE user_id = ? AND state IN ('due', 'scheduled') AND due_at <= ?`, userId, now + 30 * 86_400_000)
  const billsDue = toNum(fromAmountText(bills?.s, 'the bills due in the next 30 days'))
  if (bills && billsDue > 0) counted.push({ label: `Registered bills due in the next 30 days (${bills.n})`, monthly: billsDue, source: 'bills' })
  const progs = db.all<{ title: string; params_json: string; authority_json: string }>(
    `SELECT p.title, v.params_json, v.authority_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = p.live_version WHERE p.user_id = ? AND p.state = 'active' AND p.kind = 'invest' AND p.id != ?`, userId, exceptProgramId)
  for (const g of progs) {
    const prm = parse<{ amount?: number; schedule?: { type?: string; minutes?: number } }>(g.params_json, {})
    const cap = parse<{ maxPerMonth?: number }>(g.authority_json, {}).maxPerMonth
    // What the schedule asks for, but never more than the monthly limit the owner signed: runs beyond it are refused.
    const perMonth = Math.min(monthlyRuns(prm.schedule) * (prm.amount ?? 0), typeof cap === 'number' ? cap : Number.POSITIVE_INFINITY)
    if (perMonth > 0) counted.push({ label: `Investing instruction: ${g.title}`, monthly: Math.round(perMonth), source: 'program' })
  }
  const expenses = counted.reduce((s, c) => s + c.monthly, 0)
  const sav = term(db, 'rate.savings')?.value, card = term(db, 'rate.card')?.value, home = term(db, 'rate.loan.home')?.value, fd = term(db, 'rate.fd')?.value, pl = term(db, 'rate.loan.personal')?.value
  const model: X5Model = {
    ...X5_DEFAULT,
    s0: rupees(balance(db, userId, 'bank')),
    debt: { card: rupees(balance(db, userId, 'card')), personal_loan: rupees(balance(db, userId, 'loan:personal')), home_loan: rupees(balance(db, userId, 'loan:home')) },
    income: rupees(p.income),
    expenses: rupees(expenses),
    plEmi: rupees(p.personalLoanEmi),
    hlEmi: rupees(p.homeLoanEmi),
    plRate: Number(pl?.apr ?? X5_DEFAULT.plRate),
    prepayPenalty: { ...X5_DEFAULT.prepayPenalty, personal_loan: Number(pl?.prepayCharge ?? X5_DEFAULT.prepayPenalty.personal_loan) },
    fdRate: Number(fd?.apr ?? X5_DEFAULT.fdRate),
    fdBreak: Number(fd?.breakPenalty ?? X5_DEFAULT.fdBreak),
    rateBoxes: {
      sav: box(sav?.box, X5_DEFAULT.rateBoxes.sav), card: box(card?.box, X5_DEFAULT.rateBoxes.card),
      home_loan: box(home?.box, X5_DEFAULT.rateBoxes.home_loan), liquid_fund: X5_DEFAULT.rateBoxes.liquid_fund,
    },
  }
  return {
    model, s0: model.s0, counted, asOf: now,
    notCounted: ['One-off payments you make by hand', 'Bills that are not registered here', 'Tax on interest and gains', 'Hardships that start later than month 1 (the approved scenarios start them in month 1)'],
  }
}

/** How many times a schedule fires in an average month. */
export function monthlyRuns(s: { type?: string; minutes?: number } | undefined): number {
  if (!s) return 0
  if (s.type === 'monthly') return 1
  if (s.type === 'weekly') return 52 / 12
  if (s.type === 'daily') return 365 / 12
  if (s.type === 'every' && typeof s.minutes === 'number' && s.minutes > 0) return (30 * 24 * 60) / s.minutes
  return 0
}

/** Recorded outflows over the trailing 30 days, to compare with what certificates assume (RISK-036). */
export function recordedSpending(db: Db, userId: string, now: number): number {
  const r = db.get<{ s: string }>(
    `SELECT amount_sum(p.amount_text) s FROM postings p JOIN entries e ON e.id = p.entry_id JOIN accounts a ON a.id = p.account_id
     WHERE e.user_id = ? AND a.code = 'exp:spend' AND e.effective_ts > ?`, userId, now - 30 * 86_400_000)
  return toNum(fromAmountText(r?.s, 'the spending of the last 30 days'))
}
