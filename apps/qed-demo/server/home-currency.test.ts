/**
 * R13 S7: a household's home currency. The rupee is the default and writes nothing; another currency is chosen at set-up; its
 * books, profile, thresholds and every sentence are in it; the starting figures name the rate and source they were converted at;
 * parts of QED that price in rupees are closed to it with the reason; and it is never changed after set-up.
 */
import { describe, expect, it } from 'vitest'
import { balance, verifyLedger } from './ledger.ts'
import { account } from './ledger.ts'
import { defaultsFor, DEFAULT_OPENING, getProfile, homeCurrencyOf, openHousehold, saveProfile, validateProfile } from './household.ts'
import { basisWords, fromRupeeFigure, HOME_OFFERED, homeBasis, homeRefusal, inHomeCurrency, thresholdIn, withHome } from './home-currency.ts'
import { dayStart, liquidity, monthStart } from './liquidity.ts'
import { goalEnds, goalsView } from './goals.ts'
import { flatten, runJourney, screenViews } from './screen-text-fixture.ts'
import { makeKit, T0 } from './testkit.ts'
import { previewAction, addPayee } from './owner.ts'
import { buildDraft } from './programs.ts'
import { goalAccount } from './setaside.ts'
import { homeMoney, homeMoneyExact } from '../shared/home-money.ts'
import { isPaperCurrency, PAPER_CURRENCIES } from '../shared/currency.ts'

const gbp = () => { const d = defaultsFor('GBP'); return makeKit({ opening: d.opening, profile: { ...d.profile } }) }
const GOAL = { name: 'Holiday', target: 500_000, date: '2027-03-31' } // £5,000

describe('the rupee is the default and nothing is written for it', () => {
  it('a household with no home currency reads the rupee, and its stored profile has no such key', () => {
    const k = makeKit()
    expect(homeCurrencyOf(getProfile(k.db, k.userId))).toBe('INR')
    expect(k.db.get<{ p: string }>('SELECT profile_json p FROM users WHERE id = ?', k.userId)!.p).not.toContain('homeCurrency')
    expect(defaultsFor('INR').opening).toBe(DEFAULT_OPENING)
    expect(account(k.db, k.userId, 'bank')!.asset_id).toBe('INR')
  })
  it('choosing the rupee explicitly writes nothing either', () => {
    const k = makeKit({ profile: { homeCurrency: 'INR' } })
    expect(k.db.get<{ p: string }>('SELECT profile_json p FROM users WHERE id = ?', k.userId)!.p).not.toContain('homeCurrency')
  })
})

describe('choosing a home currency at set-up', () => {
  it('opens the paper bank in it, converts the starting figures once, and keeps the rate and source', () => {
    const k = gbp()
    const p = getProfile(k.db, k.userId)
    expect(p.homeCurrency).toBe('GBP')
    expect(account(k.db, k.userId, 'bank')!.asset_id).toBe('GBP')
    expect(account(k.db, k.userId, 'bank')!.instrument_id).toBe('iso4217:GBP')
    // ₹8,00,000 at 123.1363 rupees to the pound is £6,497, rounded to two significant figures: £6,500
    expect(balance(k.db, k.userId, 'bank')).toBe(650_000n)
    expect(p.homeBasis).toMatchObject({ currency: 'GBP', rupeesPerUnit: '123.1363', label: 'historical' })
    expect(p.homeBasis!.source).toContain('FBIL reference rate as at 1.00 pm IST on 18 Nov 2026')
    expect(basisWords(p.homeBasis!)).toContain('123.1363 rupees to one Pound sterling')
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })
  it('rounds figures to the nearest and thresholds down, to two significant figures', () => {
    expect(fromRupeeFigure(80_000_000, 'GBP', 'nearest')).toBe(650_000)
    expect(fromRupeeFigure(1_000_000, 'GBP', 'down')).toBe(8_100) // ₹10,000 is £81.21: £81, never above
    expect(thresholdIn('GBP', 1_000_000)).toBe(8_100)
    expect(thresholdIn('INR', 1_000_000)).toBe(1_000_000)
    for (const c of PAPER_CURRENCIES.filter((x) => x !== 'INR')) expect(homeBasis(c)!.rupeesPerUnit).toMatch(/^\d/)
    expect(homeBasis('AED')!.label).toBe('synthetic')
  })
  it('offers the currencies counted in hundredths, and refuses the yen and the dinar with the reason', () => {
    expect(HOME_OFFERED).toEqual(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'])
    expect(homeRefusal('JPY')).toMatch(/not one hundredth/)
    expect(validateProfile({ homeCurrency: 'BHD' }).homeCurrency).toMatch(/Bahraini dinar cannot be a home currency yet/)
    expect(validateProfile({ homeCurrency: 'XXX' as never }).homeCurrency).toMatch(/Choose one of/)
    expect(() => makeKit({ profile: { homeCurrency: 'JPY' } })).toThrow(/not valid/)
  })
  it('says what to enter in the currency\'s own words', () => {
    expect(validateProfile({ income: -1 }, 'GBP').income).toBe('Enter monthly income as a whole number of pounds.')
    expect(validateProfile({ income: -1 }).income).toBe('Enter monthly income as a whole number of rupees.')
  })
  it('the home currency is not among the figures a person changes afterwards', () => {
    const k = gbp()
    saveProfile(k.db, k.userId, { income: 200_000 })
    expect(getProfile(k.db, k.userId).homeCurrency).toBe('GBP')
  })
})

describe('a GBP household reads pounds, saves for a goal and pays', () => {
  it('writes every figure in pounds: no rupee sign, no rupee word in its screens', async () => {
    const k = gbp()
    await inHomeCurrency('GBP', () => runJourney(k, { goal: GOAL, pay: 15_000 }))
    const text = inHomeCurrency('GBP', () => flatten(screenViews(k)).join('\n'))
    expect(text).toContain('£')
    expect(text.split('\n').filter((l) => l.includes('₹'))).toEqual([])
    expect(text).toContain('£150')                       // the payment
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    expect(balance(k.db, k.userId, goalAccount(k.db.get<{ id: string }>(`SELECT id FROM programs WHERE kind = 'goal'`)!.id))).toBeGreaterThan(0n)
  })
  it('the goal\'s own account is kept in pounds', async () => {
    const k = gbp()
    const d = inHomeCurrency('GBP', () => buildDraft(k.ctx, k.userId, 'goal', GOAL, { maxPerRun: 99_000_000, maxPerMonth: 99_000_000, expiresAt: T0 + 300 * 86_400_000 }, T0))
    expect(d.title).toBe('Save £5,000 for Holiday by 31 Mar 2027')
    expect(d.analysis.headline).toMatch(/^£\d[\d,]* a month reaches £5,000 by 31 Mar 2027$/)
  })
  it('the reserve, the floor and the profile figures are held in pounds', () => {
    const k = gbp()
    const l = liquidity(k.db, k.userId, k.clock.now())
    expect(getProfile(k.db, k.userId).line).toBe(fromRupeeFigure(50_000_000, 'GBP', 'nearest')) // £4,100
    expect(l.available).toBeGreaterThan(0)
    expect(inHomeCurrency('GBP', () => homeMoney(getProfile(k.db, k.userId).line))).toBe('£4,100')
  })
  it('a payment above the step-up threshold in pounds needs the passkey, below it does not', async () => {
    const k = gbp()
    const payee = addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, k.clock.now())
    const small = await inHomeCurrency('GBP', () => previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 5_000 }))
    const large = await inHomeCurrency('GBP', () => previewAction(k.ctx, k.userId, { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 9_000 }))
    expect(small.requiresStepUp).toBe(false)
    expect(large.requiresStepUp).toBe(true) // £90 is above the £81 that stands for ₹10,000
  })
})

describe('what works in rupees only is closed to it, with the reason', () => {
  it('orders and instructions that buy, sell or plan debt are refused', async () => {
    const k = gbp()
    await expect(previewAction(k.ctx, k.userId, { kind: 'order', side: 'buy', instrumentId: 'amfi:120716', amount: 10_000 })).rejects.toThrow(/works in rupees only, and your home currency is Pound sterling \(GBP\)/)
    expect(() => buildDraft(k.ctx, k.userId, 'invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'every', minutes: 5 } }, {}, T0)).toThrow(/works in rupees only/)
  })
  it('a rupee household is not refused anything by it', () => {
    const k = makeKit()
    expect(withHome(k.db, k.userId, () => homeMoneyExact(123_450))).toBe('₹1,234.50')
  })
})

describe('the text of every home currency', () => {
  it('writes each at its own minor unit, with its own sign where one is unambiguous', () => {
    const t = (c: string, v: number) => inHomeCurrency(c as never, () => homeMoney(v))
    expect(t('INR', 123456789)).toBe('₹12,34,568')
    expect(t('GBP', 123456789)).toBe('£1,234,568')
    expect(t('EUR', -5050)).toBe('−€51')
    expect(t('USD', 5000)).toBe('USD 50')
    expect(isPaperCurrency('GBP')).toBe(true)
  })
  it('a household whose profile is read outside its context still reads the rupee by default', () => {
    expect(homeMoney(123_400)).toBe('₹1,234')
  })
})

describe('the planners count their days in the household zone (S6)', () => {
  // 23:30 UTC on 1 July 2026: 00:30 on 2 July in London (summer time) and 05:00 on 2 July in India; 04:30 on 1 July in New York
  const NOW = Date.parse('2026-07-01T23:30:00Z')
  const lq = (zone: string) => { const k = makeKit({ start: NOW, profile: { timeZone: zone } }); return { k, l: withHome(k.db, k.userId, () => liquidity(k.db, k.userId, NOW)) } }
  it('liquidity\'s today and the day and month an instruction counts from follow the zone', () => {
    expect(lq('Asia/Kolkata').l.today).toBe('2026-07-02')
    expect(lq('Europe/London').l.today).toBe('2026-07-02')
    expect(lq('America/New_York').l.today).toBe('2026-07-01')
    const ny = makeKit({ start: NOW, profile: { timeZone: 'America/New_York' } })
    expect(new Date(withHome(ny.db, ny.userId, () => dayStart(NOW))).toISOString()).toBe('2026-07-01T04:00:00.000Z')
    expect(new Date(withHome(ny.db, ny.userId, () => monthStart(NOW))).toISOString()).toBe('2026-07-01T04:00:00.000Z')
    const kol = makeKit({ start: NOW })
    expect(new Date(dayStart(NOW)).toISOString()).toBe('2026-07-01T18:30:00.000Z') // India's day, as it always was
    expect(withHome(kol.db, kol.userId, () => dayStart(NOW))).toBe(dayStart(NOW))
  })
  it('a goal\'s last day ends at 23:59 in the household\'s zone, and its dates fall in it', () => {
    const lon = makeKit({ start: NOW, profile: { timeZone: 'Europe/London' } })
    expect(new Date(withHome(lon.db, lon.userId, () => goalEnds('2027-03-31'))).toISOString()).toBe('2027-03-31T22:59:00.000Z') // BST began 28 Mar
    expect(new Date(withHome(lon.db, lon.userId, () => goalEnds('2027-01-31'))).toISOString()).toBe('2027-01-31T23:59:00.000Z') // winter: UTC
    expect(new Date(goalEnds('2027-03-31')).toISOString()).toBe('2027-03-31T18:29:00.000Z')
    const g = withHome(lon.db, lon.userId, () => goalsView(lon.db, lon.userId, NOW))
    expect(g.defaultDay).toBeGreaterThan(0)
  })
})
