import { describe, expect, it } from 'vitest'
import { reconcileTax, RULES, taxCsv, taxJson, taxStatement, treatment } from './tax.ts'
import { at, GOLD, LIQUID, NIFTY, trades } from './tax-fixture.ts'
import { type Kit, makeKit } from './testkit.ts'

const books = new WeakMap<Kit, ReturnType<typeof trades>>()
const T = (k: Kit) => { let t = books.get(k); if (!t) { t = trades(k.db, k.userId); books.set(k, t) } return t }
const buyCoin = (k: Kit, ...a: Parameters<ReturnType<typeof trades>['buyCoin']>): void => T(k).buyCoin(...a)
const sellCoin = (k: Kit, ...a: Parameters<ReturnType<typeof trades>['sellCoin']>): void => T(k).sellCoin(...a)
const buyFund = (k: Kit, ...a: Parameters<ReturnType<typeof trades>['buyFund']>): void => T(k).buyFund(...a)
const sellFund = (k: Kit, ...a: Parameters<ReturnType<typeof trades>['sellFund']>): void => T(k).sellFund(...a)
const year = (k: Kit, fy: string) => taxStatement(k.db, k.userId, at('2027-04-02')).years.find((y) => y.fy === fy)!

describe('the rules in force on the sale date', () => {
  const sold = (d: string) => at(d)
  it('listed equity and equity funds: more than 12 months is long-term; the rates change on 23 July 2024', () => {
    expect(treatment('equity_fund', at('2025-01-10'), sold('2026-01-10'))).toMatchObject({ term: 'short', section: '111A', rateBp: 2000 })
    expect(treatment('equity_fund', at('2025-01-10'), sold('2026-01-11'))).toMatchObject({ term: 'long', section: '112A', rateBp: 1250 })
    expect(treatment('equity_fund', at('2023-01-10'), sold('2024-07-22'))).toMatchObject({ term: 'long', rateBp: 1000 })
    expect(treatment('equity_fund', at('2024-01-10'), sold('2024-07-22'))).toMatchObject({ term: 'short', rateBp: 1500 })
    expect(treatment('equity_fund', at('2024-01-10'), sold('2024-07-23'))).toMatchObject({ term: 'short', rateBp: 2000 })
  })
  it('debt funds bought on or after 1 April 2023 are always short-term at the slab rate', () => {
    expect(treatment('debt_fund_50aa', at('2023-04-01'), sold('2026-11-01'))).toMatchObject({ term: 'short', section: '50AA', rateBp: null })
  })
  it('other funds: more than 24 months is long-term at 12.5%; a long sale before 23 July 2024 is listed but not taxed', () => {
    expect(treatment('other_fund', at('2024-11-01'), sold('2026-11-01'))).toMatchObject({ term: 'short', rateBp: null })
    expect(treatment('other_fund', at('2024-11-01'), sold('2026-11-02'))).toMatchObject({ term: 'long', section: '112', rateBp: 1250 })
    expect(treatment('other_fund', at('2019-01-01'), sold('2024-01-01'))).toMatchObject({ term: 'long', modelled: false })
  })
  it('virtual digital assets: 30%, whatever the holding period', () => {
    expect(treatment('vda', at('2020-01-01'), sold('2026-11-01'))).toMatchObject({ section: '115BBH', rateBp: 3000 })
  })
  it('states its date, its label and that it is not verified in full', () => {
    expect(RULES.asOf).toBe('2026-11-24')
    expect(RULES.label).toBe('Modelled, not tax advice')
    expect(RULES.sources.every((s) => s.url.startsWith('https://') && s.seen === '2026-11-24')).toBe(true)
    expect(RULES.notVerified.length).toBeGreaterThan(0)
  })
  it('cites the Gazette of India for each rule it holds (the Department\'s own pages refuse automated reading), with the clause, and names what is still not verified', () => {
    for (const x of RULES.sources) {
      expect(x.url, x.id).toMatch(/^https:\/\/egazette\.gov\.in\/WriteReadData\/20\d\d\/\d+\.pdf$/)
      expect(x.status, x.id).toBe('verified')
      expect(x.clause.length, x.id).toBeGreaterThan(60)
    }
    expect(RULES.sources.map((x) => x.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'])
    const stated = RULES.notVerified.join(' ')
    expect(stated).toMatch(/₹1,00,000 limit under section 112A/)
    expect(stated).toMatch(/specified mutual fund before 1 April 2026/)
    expect(stated).toMatch(/Circular 23\/2022 .* not read/)
  })
})

describe('the statement, reconciled to the ledger', () => {
  function world(): Kit {
    const k = makeKit()
    buyCoin(k, '2026-04-10', 100_000_000n, 1_000_000n, 5_900n)       // cost 1,005,900
    sellCoin(k, '2026-06-10', 40_000_000n, 800_000n, 4_720n)          // cost 402,360; consideration 800,000; gain 397,640 + fee 4,720 added back
    sellCoin(k, '2026-07-10', 60_000_000n, 300_000n, 1_770n)          // cost 603,540; a loss
    buyFund(k, NIFTY, '2025-01-10', 1_000_000n, 20_000_000n)
    sellFund(k, NIFTY, '2026-08-01', 1_000_000n, 40_000_000n)         // long-term equity: gain about 19.99m, over the 1.25m-rupee exemption
    buyFund(k, GOLD, '2026-02-01', 1_000_000n, 5_000_000n)
    sellFund(k, GOLD, '2026-09-01', 1_000_000n, 4_000_000n, 1_000n)   // short-term loss on a fund taxed at the slab rate
    buyFund(k, LIQUID, '2026-05-01', 1_000_000n, 10_000_000n)
    sellFund(k, LIQUID, '2026-10-01', 1_000_000n, 10_300_000n)        // 50AA: short-term, slab
    return k
  }

  it('reconciles every figure to the ledger', () => {
    const k = world()
    const s = taxStatement(k.db, k.userId, at('2026-11-24'))
    expect(reconcileTax(k.db, k.userId, s)).toMatchObject({ ok: true, breaks: [] })
    expect(s.years.map((y) => y.fy)).toEqual(['2024-25', '2025-26', '2026-27'])
  })

  it('groups by class, term and section, with the gain of each', () => {
    const y = year(world(), '2026-27')
    const line = (cls: string, section: string) => y.lines.find((l) => l.cls === cls && l.section === section)!
    expect(line('equity_fund', '112A')).toMatchObject({ term: 'long', rateBp: 1250, proceeds: 40_000_000n })
    expect(line('equity_fund', '112A').cost).toBe(20_000_000n + 20_000_000n / 20_000n)
    expect(line('debt_fund_50aa', '50AA')).toMatchObject({ term: 'short', rateBp: null })
    expect(line('other_fund', 'slab').gain).toBe(3_999_000n - 5_000_250n)
    expect(y.lines.filter((l) => l.cls === 'vda')).toHaveLength(1)
  })

  it('taxes each virtual digital asset sale on its own: a loss is not set off, and the sale fee is added back', () => {
    const y = year(world(), '2026-27')
    expect(y.vda.transfers).toHaveLength(2)
    const [a, b] = y.vda.transfers
    expect(a!.gain).toBe(800_000n - 402_360n)
    expect(b!.gain).toBe(300_000n - 603_540n)
    expect(y.vda.taxable).toBe(a!.gain)
    expect(y.vda.disallowedLoss).toBe(-b!.gain)
    expect(y.vda.tax).toBe((a!.gain * 3000n + 5000n) / 10_000n)
    expect(y.vda.saleFeesNotAllowed).toBe(4_720n + 1_770n)
    expect(y.tds.vda).toBe(8_000n + 3_000n)
  })

  it('lists the stamp duty and venue fees as applied at execution', () => {
    const y = year(world(), '2026-27')
    expect(y.charges.find((c) => c.kind === 'stamp')!.amount).toBe(500n) // the other two purchases fall in earlier years
    expect(y.charges.find((c) => c.kind === 'fee-buy')!.amount).toBe(5_900n)
    expect(y.charges.find((c) => c.kind === 'fee-sell')!.amount).toBe(4_720n + 1_770n + 1_000n)
  })

  it('sets the short-term loss off against the short-term gain at the slab rate, and applies the exemption to section 112A', () => {
    const y = year(world(), '2026-27')
    const used = y.setOff.filter((s) => s.kind === 'current-year').reduce((t, s) => t + s.amount, 0n)
    expect(used).toBe(1_001_250n)
    expect(y.exemption).toMatchObject({ section: '112A', limit: 12_500_000n, used: 12_500_000n })
    const t112a = y.tax.find((t) => t.section === '112A')!
    expect(t112a.taxable).toBe(40_000_000n - 20_001_000n - 701_750n - 12_500_000n)
    expect(t112a.tax).toBe((t112a.taxable * 1250n + 5000n) / 10_000n)
    expect(y.tax.find((t) => t.section === '50AA')!.tax).toBeNull()
  })

  it('carries an unabsorbed loss to the next year and sets it off there', () => {
    const k = makeKit()
    buyFund(k, GOLD, '2026-02-01', 2_000_000n, 10_000_000n)
    sellFund(k, GOLD, '2027-02-01', 1_000_000n, 3_000_000n)           // short-term loss in 2026-27, nothing to set it against
    buyFund(k, LIQUID, '2027-05-01', 1_000_000n, 10_000_000n)
    sellFund(k, LIQUID, '2027-08-01', 1_000_000n, 11_000_000n)        // 2027-28: slab gain
    const s = taxStatement(k.db, k.userId, at('2027-12-01'))
    const y1 = s.years.find((y) => y.fy === '2026-27'), y2 = s.years.find((y) => y.fy === '2027-28')
    expect(y1!.carriedForward).toHaveLength(1)
    expect(y1!.carriedForward[0]).toMatchObject({ term: 'short', fy: '2026-27', usableUntilFy: '2034-35' })
    expect(y2!.setOff.some((x) => x.kind === 'brought-forward' && x.from.includes('2026-27'))).toBe(true)
    expect(reconcileTax(k.db, k.userId, s).ok).toBe(true)
  })

  it('finds a break when a lot or a sale no longer agrees with the ledger', () => {
    const k = world()
    k.db.run('UPDATE lots SET cost = cost + 100 WHERE rowid = (SELECT MIN(rowid) FROM lots)')
    k.db.run('UPDATE realised SET proceeds = proceeds + 7 WHERE rowid = (SELECT MIN(rowid) FROM realised)')
    const r = reconcileTax(k.db, k.userId, taxStatement(k.db, k.userId, at('2026-11-24')))
    expect(r.ok).toBe(false)
    expect(r.breaks.map((b) => b.check)).toEqual(expect.arrayContaining(['lot-cost-matches-entry', 'proceeds-match-entry']))
  })

  it('finds a break when the tax deducted is not 1% of the sale', () => {
    const k = makeKit()
    buyCoin(k, '2026-04-10', 100_000_000n, 1_000_000n, 5_900n)
    sellCoin(k, '2026-06-10', 100_000_000n, 2_000_000n, 11_800n, 5_000n)
    expect(reconcileTax(k.db, k.userId, taxStatement(k.db, k.userId, at('2026-11-24'))).breaks.map((b) => b.check)).toContain('tds-rate')
  })

  it('exports CSV and JSON with the label and the rule set date, and a cell never starts a formula', () => {
    const k = world()
    const s = taxStatement(k.db, k.userId, at('2026-11-24')), r = reconcileTax(k.db, k.userId, s)
    const csv = taxCsv(s, r), json = JSON.parse(taxJson(s, r))
    expect(csv.split('\r\n')[1]).toContain('Modelled, not tax advice')
    expect(csv).toContain('2026-11-24')
    expect(json.label).toBe('Modelled, not tax advice')
    expect(json.ruleSet.asOf).toBe('2026-11-24')
    expect(json.reconciliation.ok).toBe(true)
    expect(json.years.find((y: { fy: string }) => y.fy === '2026-27').vda.tax).toBe(String(year(k, '2026-27').vda.tax))
    expect(csv.split('\r\n').every((row) => !/^[=+@]/.test(row))).toBe(true)
  })
})
