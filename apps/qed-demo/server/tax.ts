/**
 * Tax statement (register R7-059): the realised gains of the ledger's FIFO lots (server/ledger.ts: `lots`, `realised`) by
 * Indian financial year and by asset class, short-term and long-term by each class's holding-period rule, with the rates
 * in force on each sale date, tax deducted at source, the charges already applied at execution, the set-off rules, and a
 * reconciliation of every figure to the ledger's postings (reconcileTax).
 *
 * MODELLED, NOT TAX ADVICE. The rule set below was read on 24 Nov 2026 from the Gazette of India's own text of the Acts (the
 * Income Tax Department's pages refuse automated reading, HTTP 403, so none of them is the source): the Finance (No. 2) Act 2024,
 * the Finance Act 2022, the Finance Act 2026, and the Income-tax Act 2025, which took the place of the 1961 Act from 1 April 2026
 * and re-enacts these rules under new section numbers (RULES.sources names both). This statement keeps the 1961 Act's section
 * names, as the Department's pages do. The one rule still not read from an Act's text is listed in RULES.notVerified.
 * Left out, and said on the statement: surcharge and cess; the person's slab rate (so slab-rate gains carry no tax figure);
 * indexation (a sale before 23 July 2024 of a non-equity fund held long is listed, not taxed).
 *
 * Amounts are paise and bigint throughout; the JSON carries them as decimal strings.
 */
import { fromAmountText } from '../shared/amount-text.ts'
import { inrExact } from '../shared/money.ts'
import { type Db, ist } from './core.ts'
import { instrument } from './registry.ts'

export const RULES = {
  id: 'in-capital-gains-2026-11-24',
  asOf: '2026-11-24',
  label: 'Modelled, not tax advice',
  sources: [
    { id: 'S1', status: 'verified', claim: 'Short-term gain on listed equity and equity-oriented funds (section 111A): 15% for a transfer before 23 July 2024, 20% from 23 July 2024. Income-tax Act 2025 section 196(1)(i): 20%', clause: 'Finance (No. 2) Act 2024, section 29(a): "(a) at the rate of fifteen per cent. for any transfer which takes place before the 23rd day of July, 2024; and (b) at the rate of twenty per cent. ... on or after"', url: 'https://egazette.gov.in/WriteReadData/2024/256436.pdf', seen: '2026-11-24' },
    { id: 'S2', status: 'verified', claim: 'Long-term gain on other assets (section 112): 20% before 23 July 2024, 12.5% from then, without indexation (Income-tax Act 2025 section 197(1)(b): 12.5%). Section 112A: 10% before 23 July 2024, 12.5% from then, on the gain above ₹1,25,000, a limit that applies to the total of the long-term gains in the year', clause: 'Finance (No. 2) Act 2024, sections 30 and 31: "exceeding one lakh twenty-five thousand rupees ... (a) at the rate of ten per cent. ... before the 23rd day of July, 2024; and (b) ... twelve and one-half per cent. ... on or after the 23rd day of July, 2024: Provided that the limit of one lakh twenty-five thousand rupees shall apply on aggregate of the long-term capital gains under sub-clauses (a) and (b)". Income-tax Act 2025 section 198(2)(a): "exceeding ₹ 125000 at the rate of 12.5%"', url: 'https://egazette.gov.in/WriteReadData/2024/256436.pdf', seen: '2026-11-24' },
    { id: 'S3', status: 'verified', claim: 'Holding periods: a capital asset is short-term if held 24 months or less (36 months before 23 July 2024); 12 months or less for a listed security, a unit of the Unit Trust of India, a unit of an equity-oriented fund, or a zero-coupon bond', clause: 'Income-tax Act 2025 section 2(101)(a) and (b): "not more than twenty-four months ... as if for the words \'twenty-four months\', the words \'twelve months\' had been substituted". Finance (No. 2) Act 2024, section 3(b): in clause (42A), "for the words \'thirty-six months\', the words \'twenty-four months\'", from 23 July 2024', url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf', seen: '2026-11-24' },
    { id: 'S4', status: 'verified', claim: 'Section 50AA (Income-tax Act 2025 section 76): the gain on a unit of a specified mutual fund acquired on or after 1 April 2023 is a short-term gain, whatever the holding period. From 1 April 2026 a specified fund is one that invests more than 65% in debt and money market instruments, or 65% or more in such funds', clause: 'Finance (No. 2) Act 2024, section 21(b): "Specified Mutual Fund means, (a) a Mutual Fund by whatever name called, which invests more than sixty-five per cent. of its total proceeds in debt and money market instruments; or (b) a fund which invests sixty-five per cent. or more of its total proceeds in units of a fund referred to in sub-clause (a)", with effect from 1 April 2026; Income-tax Act 2025 section 76(5)(b)', url: 'https://egazette.gov.in/WriteReadData/2024/256436.pdf', seen: '2026-11-24' },
    { id: 'S5', status: 'verified', claim: 'Section 115BBH (Income-tax Act 2025 section 194, Table serial 4): income from transferring a virtual digital asset is taxed at 30%; no deduction except the cost of acquisition; no set-off of its loss against any other income, and no carry-forward', clause: 'Finance Act 2022, section 115BBH(1)(a) "at the rate of thirty per cent." and (2)(a), (b): "no set off of loss from transfer of the virtual digital asset ... shall be allowed against income ... and such loss shall not be allowed to be carried forward"', url: 'https://egazette.gov.in/WriteReadData/2022/234693.pdf', seen: '2026-11-24' },
    { id: 'S6', status: 'verified', claim: 'Section 194S (Income-tax Act 2025 section 393(1) Table serial 8(vi)): tax deducted at 1% of the consideration for the transfer of a virtual digital asset. The 1961 Act exempted a year\'s payments up to ₹10,000 (₹50,000 for a specified person); the 2025 Act\'s threshold is nil. The paper venue deducts on every sale', clause: 'Finance Act 2022, section 194S(1): "deduct an amount equal to one per cent. of such sum as income-tax thereon"; Income-tax Act 2025 section 393(1) Table, Sl. No. 8(vi): "Any sum by way of consideration for transfer of a virtual digital asset. Any person. Rate: 1% Threshold limit: Nil."', url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf', seen: '2026-11-24' },
    { id: 'S7', status: 'verified', claim: 'A capital loss is carried forward for at most eight tax years; a short-term loss sets off against any capital gain, a long-term loss only against long-term gain (Income-tax Act 2025 sections 108 and 111; section 74 of the 1961 Act)', clause: 'Income-tax Act 2025 section 111(1)(a)(i), (ii) and (2): "No loss shall be carried forward under this section for more than eight tax years immediately succeeding the tax year for which the loss was first computed."', url: 'https://egazette.gov.in/WriteReadData/2025/265620.pdf', seen: '2026-11-24' },
  ],
  notVerified: [
    'The ₹1,00,000 limit under section 112A for years before 2024-25 (the Finance Act 2018\'s text was not found in the Gazette; the 2024 Act\'s text confirms ₹1,25,000 from 2024-25 and 10% before 23 July 2024).',
    'The holding periods and the 15%, 20% and 10% rates for sales before 1 April 2026 are read from the Finance (No. 2) Act 2024\'s amendments and the Income-tax Act 2025\'s re-enactment; the 1961 Act\'s own text (sections 2(42A), 111A, 112, 112A as they stood) was not opened.',
    'Section 50AA\'s definition of a specified mutual fund before 1 April 2026: the 2024 Act replaces an earlier definition from that date, and the earlier text was not found, so which funds count for a sale before then is NOT VERIFIED.',
    'Which fund is "equity-oriented" or a "specified mutual fund" is taken from the fund\'s category in QED\'s registry, not from its portfolio.',
    'A venue fee paid when buying a virtual digital asset is treated as part of its cost; whether section 115BBH allows that is not checked.',
    'CBDT Circular 23/2022 (a virtual digital asset\'s loss and set-off) was not read: the Income Tax Department\'s site refused automated reading (HTTP 403). The statute text above is the source used.',
  ],
} as const

export type TaxClass = 'equity_fund' | 'debt_fund_50aa' | 'other_fund' | 'vda' | 'unclassified'
export const CLASS_NAME: Record<TaxClass, string> = {
  equity_fund: 'Equity-oriented funds', debt_fund_50aa: 'Debt funds bought on or after 1 April 2023', other_fund: 'Other funds', vda: 'Virtual digital assets', unclassified: 'Not classified',
}

const dateKey = (ts: number): number => { const t = ist(ts); return t.y * 10_000 + t.m * 100 + t.d }
export const fyOf = (ts: number): string => { const t = ist(ts); const y = t.m >= 4 ? t.y : t.y - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}` }
const fyStartYear = (fy: string): number => Number(fy.slice(0, 4))
/** The date n calendar months after a date (the day clamped to the month's end), as yyyymmdd. */
function plusMonths(key: number, n: number): number {
  const y = Math.floor(key / 10_000), m = Math.floor((key % 10_000) / 100), d = key % 100
  const total = y * 12 + (m - 1) + n, ny = Math.floor(total / 12), nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return ny * 10_000 + nm * 100 + Math.min(d, last)
}
/** Held for more than n months: the sale falls after the date n months on. */
const heldOver = (openedAt: number, soldAt: number, months: number): boolean => dateKey(soldAt) > plusMonths(dateKey(openedAt), months)

const NEW_RATES_FROM = 20_240_723
const DEBT_RULE_FROM = 20_230_401

export function classOf(db: Db, instrumentId: string, openedAt: number): TaxClass {
  const i = instrument(db, instrumentId)
  if (!i) return 'unclassified'
  if (i.kind === 'crypto_spot') return 'vda'
  // listed shares and an equity ETF are taxed as equity (the same rates apply); a gold ETF, a bill and a bond are not modelled
  // here (a bill's discount and a bond's coupon are income at the slab rate), so they are shown as unclassified, never guessed
  if (i.kind === 'equity' || (i.kind === 'etf' && i.meta.category === 'index-etf')) return 'equity_fund'
  if (i.kind !== 'mutual_fund') return 'unclassified'
  const c = i.meta.category
  if (c === 'index' || c === 'flexi' || c === 'arbitrage') return 'equity_fund'
  if (c === 'liquid' || c === 'overnight' || c === 'gilt' || c === 'money-market') return dateKey(openedAt) >= DEBT_RULE_FROM ? 'debt_fund_50aa' : 'other_fund'
  if (c === 'gold' || c === 'international') return 'other_fund'
  return 'unclassified'
}

export interface Treatment { term: 'short' | 'long'; section: string; rateBp: number | null; modelled: boolean; note: string }
/** The rule for one slice of a sale: its term, section and the rate in force on the sale date. */
export function treatment(cls: TaxClass, openedAt: number, soldAt: number): Treatment {
  const post = dateKey(soldAt) >= NEW_RATES_FROM
  if (cls === 'equity_fund') {
    if (heldOver(openedAt, soldAt, 12)) return { term: 'long', section: '112A', rateBp: post ? 1250 : 1000, modelled: true, note: 'Held more than 12 months' }
    return { term: 'short', section: '111A', rateBp: post ? 2000 : 1500, modelled: true, note: 'Held 12 months or less' }
  }
  if (cls === 'debt_fund_50aa') return { term: 'short', section: '50AA', rateBp: null, modelled: true, note: 'Deemed short-term whatever the holding period; taxed at your slab rate' }
  if (cls === 'other_fund') {
    if (post) return heldOver(openedAt, soldAt, 24) ? { term: 'long', section: '112', rateBp: 1250, modelled: true, note: 'Held more than 24 months; no indexation' } : { term: 'short', section: 'slab', rateBp: null, modelled: true, note: 'Held 24 months or less; taxed at your slab rate' }
    return heldOver(openedAt, soldAt, 36) ? { term: 'long', section: '112 (indexed)', rateBp: null, modelled: false, note: 'Sold before 23 July 2024 after more than 36 months: indexation applies and is not modelled' } : { term: 'short', section: 'slab', rateBp: null, modelled: true, note: 'Held 36 months or less (sold before 23 July 2024); taxed at your slab rate' }
  }
  if (cls === 'vda') return { term: 'short', section: '115BBH', rateBp: 3000, modelled: true, note: 'Virtual digital asset: 30%, no set-off of loss' }
  return { term: 'short', section: 'unclassified', rateBp: null, modelled: false, note: 'This instrument is not one the rule set covers' }
}

/** The exemption on long-term gains under section 112A in a year (paise). */
export const exemptionFor = (fy: string): bigint => (fyStartYear(fy) >= 2024 ? 12_500_000n : 10_000_000n)

// ------------------------------------------------------------------------------------------------ the statement

export interface Line { fy: string; cls: TaxClass; term: 'short' | 'long'; section: string; rateBp: number | null; modelled: boolean; proceeds: bigint; cost: bigint; gain: bigint; note: string }
export interface VdaTransfer { entryId: string; ts: number; instrumentId: string; consideration: bigint; cost: bigint; gain: bigint; saleFee: bigint; tds: bigint }
export interface Charge { fy: string; kind: 'stamp' | 'fee-buy' | 'fee-sell'; label: string; amount: bigint; treatment: string }
export interface SetOff { fy: string; from: string; against: string; amount: bigint; kind: 'current-year' | 'brought-forward' }
export interface TaxLine { fy: string; section: string; rateBp: number | null; taxable: bigint; tax: bigint | null; note: string }
export interface Carry { fy: string; term: 'short' | 'long'; amount: bigint; usableUntilFy: string }
export interface YearBlock {
  fy: string; assessmentYear: string
  lines: Line[]; vda: { transfers: VdaTransfer[]; gains: bigint; disallowedLoss: bigint; taxable: bigint; tax: bigint; saleFeesNotAllowed: bigint }
  charges: Charge[]; tds: { vda: bigint; creditNote: string }
  setOff: SetOff[]; exemption: { section: string; limit: bigint; used: bigint }
  tax: TaxLine[]; taxTotalFixedRates: bigint; slabGainsTaxable: bigint
  carriedForward: Carry[]; lapsed: Carry[]
  totals: { proceeds: bigint; cost: bigint; ledgerGain: bigint; gain: bigint }
}
export interface TaxStatement {
  generatedAt: number; label: typeof RULES.label; ruleSet: { id: string; asOf: string; sources: typeof RULES.sources; notVerified: typeof RULES.notVerified }
  assumptions: string[]; years: YearBlock[]
}

interface RealisedRow { id: number; instrument_id: string; ts: number; qty: string; proceeds: string; cost: string; opened_at: number; entry_id: string }
const big = (v: unknown, what: string): bigint => fromAmountText(v, what)

/** The posted amount of one account in one entry, summed (positive means a debit). */
function entryPosting(db: Db, entryId: string, code: string): bigint {
  return big(db.get<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.entry_id = ? AND a.code = ?`, entryId, code)?.s, `${code} in ${entryId}`)
}

export function taxStatement(db: Db, userId: string, now: number): TaxStatement {
  const rows = db.all<RealisedRow>('SELECT id, instrument_id, ts, CAST(qty AS TEXT) qty, CAST(proceeds AS TEXT) proceeds, CAST(cost AS TEXT) cost, opened_at, entry_id FROM realised WHERE user_id = ? ORDER BY ts, id', userId)
  const years = new Map<string, { lines: Map<string, Line>; vda: Map<string, VdaTransfer>; vdaRows: Map<string, { proceeds: bigint; cost: bigint; ts: number; inst: string }>; charges: Charge[]; slices: { cls: TaxClass; t: Treatment; gain: bigint }[] }>()
  const yr = (fy: string) => { let y = years.get(fy); if (!y) { y = { lines: new Map(), vda: new Map(), vdaRows: new Map(), charges: [], slices: [] }; years.set(fy, y) } return y }

  for (const r of rows) {
    const fy = fyOf(r.ts), cls = classOf(db, r.instrument_id, r.opened_at), t = treatment(cls, r.opened_at, r.ts)
    const proceeds = big(r.proceeds, `realised ${r.id}`), cost = big(r.cost, `realised ${r.id}`), y = yr(fy)
    const key = `${cls}|${t.term}|${t.section}|${t.rateBp}|${t.modelled}`
    const l = y.lines.get(key) ?? { fy, cls, term: t.term, section: t.section, rateBp: t.rateBp, modelled: t.modelled, proceeds: 0n, cost: 0n, gain: 0n, note: t.note }
    l.proceeds += proceeds; l.cost += cost; l.gain += proceeds - cost
    y.lines.set(key, l)
    if (cls === 'vda') { const v = y.vdaRows.get(r.entry_id) ?? { proceeds: 0n, cost: 0n, ts: r.ts, inst: r.instrument_id }; v.proceeds += proceeds; v.cost += cost; y.vdaRows.set(r.entry_id, v) }
    else y.slices.push({ cls, t, gain: proceeds - cost })
  }

  // Charges and tax deducted at source, from the ledger's own entries (as executed; nothing is recomputed here).
  const entries = db.all<{ id: string; kind: string; effective_ts: number }>(`SELECT id, kind, effective_ts FROM entries WHERE user_id = ? AND kind IN ('buy', 'sell', 'fund-units-allotted', 'fund-units-redeemed') ORDER BY seq`, userId)
  const tdsByFy = new Map<string, bigint>()
  const chargeSum = new Map<string, bigint>()
  for (const e of entries) {
    const fy = fyOf(e.effective_ts), y = yr(fy)
    const fee = entryPosting(db, e.id, 'exp:fees'), stamp = entryPosting(db, e.id, 'exp:stamp'), tds = entryPosting(db, e.id, 'tds')
    if (stamp !== 0n) chargeSum.set(`${fy}|stamp`, (chargeSum.get(`${fy}|stamp`) ?? 0n) + stamp)
    if (fee !== 0n) { const k = `${fy}|${e.kind === 'buy' ? 'fee-buy' : 'fee-sell'}`; chargeSum.set(k, (chargeSum.get(k) ?? 0n) + fee) }
    if (tds !== 0n) tdsByFy.set(fy, (tdsByFy.get(fy) ?? 0n) + tds)
    const v = y.vdaRows.get(e.id)
    if (v) y.vda.set(e.id, { entryId: e.id, ts: v.ts, instrumentId: v.inst, consideration: v.proceeds + fee, cost: v.cost, gain: v.proceeds + fee - v.cost, saleFee: fee, tds })
    else if (tds !== 0n) yr(fy)
  }
  for (const [k, amount] of chargeSum) {
    const [fy, kind] = k.split('|') as [string, Charge['kind']]
    yr(fy).charges.push(kind === 'stamp'
      ? { fy, kind, label: 'Stamp duty on fund purchases', amount, treatment: 'Already applied at execution; part of the cost of the units' }
      : kind === 'fee-buy'
        ? { fy, kind, label: 'Venue fees on purchases', amount, treatment: 'Already applied at execution; part of the cost of the coins' }
        : { fy, kind, label: 'Venue fees and exit loads on sales', amount, treatment: 'Already applied at execution; taken from the proceeds of a fund sale. On a virtual digital asset it is not allowed against the income (section 115BBH) and is added back below' })
  }
  for (const fy of tdsByFy.keys()) yr(fy)

  // Year by year, oldest first: set-off, brought-forward losses, the exemption, the tax.
  const pools: { st: { fy: string; amount: bigint }[]; lt: { fy: string; amount: bigint }[] } = { st: [], lt: [] }
  const blocks: YearBlock[] = []
  for (const fy of [...years.keys()].sort()) {
    const y = years.get(fy)!, lines = [...y.lines.values()].sort((a, b) => a.cls.localeCompare(b.cls) || a.term.localeCompare(b.term) || a.section.localeCompare(b.section))
    // Virtual digital assets: tax on each transfer's gain; a loss on one transfer is set off against nothing (section 115BBH).
    const transfers = [...y.vda.values()].sort((a, b) => a.ts - b.ts)
    const vGain = transfers.reduce((s, t) => s + (t.gain > 0n ? t.gain : 0n), 0n), vLoss = transfers.reduce((s, t) => s + (t.gain < 0n ? -t.gain : 0n), 0n)
    const vda = { transfers, gains: vGain, disallowedLoss: vLoss, taxable: vGain, tax: roundBp(vGain, 3000), saleFeesNotAllowed: transfers.reduce((s, t) => s + t.saleFee, 0n) }

    // Everything but virtual digital assets, by bucket.
    type B = { id: string; label: string; term: 'short' | 'long'; section: string; rateBp: number | null; modelled: boolean; net: bigint; left: bigint }
    const buckets = new Map<string, B>()
    for (const s of y.slices) {
      const id = `${s.t.term}|${s.t.section}|${s.t.rateBp ?? 'slab'}`
      const b = buckets.get(id) ?? { id, label: `${s.t.term === 'short' ? 'Short-term' : 'Long-term'}, section ${s.t.section}${s.t.rateBp === null ? ' (slab rate)' : ` at ${s.t.rateBp / 100}%`}`, term: s.t.term, section: s.t.section, rateBp: s.t.rateBp, modelled: s.t.modelled, net: 0n, left: 0n }
      b.net += s.gain; buckets.set(id, b)
    }
    // Set off the highest rate first (slab rate counted highest: it is the most a person can pay); a long-term loss only against long-term gains.
    const order = (term: 'short' | 'long'): B[] => [...buckets.values()].filter((b) => b.term === term && b.modelled).sort((a, b) => (b.rateBp === null ? 99_999 : b.rateBp) - (a.rateBp === null ? 99_999 : a.rateBp) || (a.section === '112A' ? 1 : 0) - (b.section === '112A' ? 1 : 0))
    for (const b of buckets.values()) b.left = b.net > 0n && b.modelled ? b.net : 0n
    const setOff: SetOff[] = []
    const absorb = (loss: bigint, against: B[], from: string, kind: SetOff['kind']): bigint => {
      for (const b of against) { if (loss <= 0n) break; const take = loss < b.left ? loss : b.left; if (take > 0n) { b.left -= take; loss -= take; setOff.push({ fy, from, against: b.label, amount: take, kind }) } }
      return loss
    }
    const loss = (term: 'short' | 'long'): bigint => [...buckets.values()].filter((b) => b.term === term && b.modelled && b.net < 0n).reduce((s, b) => s - b.net, 0n)
    const labelOf = (term: 'short' | 'long') => `Loss of ${fy}, ${term}-term`
    let ltLeft = absorb(loss('long'), order('long'), labelOf('long'), 'current-year')
    let stLeft = absorb(loss('short'), [...order('short'), ...order('long')], labelOf('short'), 'current-year')
    // Losses brought forward: eight assessment years, oldest first; long-term first against long-term gains.
    const lapsed: Carry[] = []
    for (const kind of ['lt', 'st'] as const) {
      const pool = pools[kind]
      for (const p of [...pool]) {
        if (fyStartYear(fy) - fyStartYear(p.fy) > 8) { lapsed.push({ fy: p.fy, term: kind === 'st' ? 'short' : 'long', amount: p.amount, usableUntilFy: addFy(p.fy, 8) }); pool.splice(pool.indexOf(p), 1); continue }
        const left = absorb(p.amount, kind === 'lt' ? order('long') : [...order('short'), ...order('long')], `Loss of ${p.fy}, ${kind === 'st' ? 'short' : 'long'}-term`, 'brought-forward')
        p.amount = left
      }
      pools[kind] = pool.filter((p) => p.amount > 0n)
    }
    if (ltLeft > 0n) pools.lt.push({ fy, amount: ltLeft })
    if (stLeft > 0n) pools.st.push({ fy, amount: stLeft })
    ltLeft = 0n; stLeft = 0n
    const carriedForward: Carry[] = [...pools.st.map((p): Carry => ({ fy: p.fy, term: 'short', amount: p.amount, usableUntilFy: addFy(p.fy, 8) })), ...pools.lt.map((p): Carry => ({ fy: p.fy, term: 'long', amount: p.amount, usableUntilFy: addFy(p.fy, 8) }))]

    // The exemption on section 112A, then the tax at the rate of each bucket.
    const limit = exemptionFor(fy)
    let exemptionLeft = limit
    const taxLines: TaxLine[] = []
    let fixed = vda.tax, slab = 0n
    if (vda.taxable > 0n || transfers.length) taxLines.push({ fy, section: '115BBH', rateBp: 3000, taxable: vda.taxable, tax: vda.tax, note: 'Each transfer on its own: no loss is set off, even against another virtual digital asset' })
    for (const b of [...buckets.values()].sort((a, b) => (b.rateBp ?? 0) - (a.rateBp ?? 0))) {
      if (!b.modelled) { taxLines.push({ fy, section: b.section, rateBp: null, taxable: b.net > 0n ? b.net : 0n, tax: null, note: 'Not modelled' }); continue }
      let taxable = b.left
      if (b.section === '112A' && taxable > 0n) { const use = taxable < exemptionLeft ? taxable : exemptionLeft; taxable -= use; exemptionLeft -= use }
      if (b.rateBp === null) { slab += taxable; taxLines.push({ fy, section: b.section, rateBp: null, taxable, tax: null, note: 'Taxed at your slab rate, which QED does not know' }); continue }
      const tax = roundBp(taxable, b.rateBp); fixed += tax
      taxLines.push({ fy, section: b.section, rateBp: b.rateBp, taxable, tax, note: b.section === '112A' ? `After the exemption of ${inrExact(limit)} a year` : '' })
    }
    const totals = lines.reduce((s, l) => ({ proceeds: s.proceeds + l.proceeds, cost: s.cost + l.cost, ledgerGain: s.ledgerGain + l.gain }), { proceeds: 0n, cost: 0n, ledgerGain: 0n })
    blocks.push({
      fy, assessmentYear: addFy(fy, 1), lines, vda, charges: y.charges.sort((a, b) => a.kind.localeCompare(b.kind)), tds: { vda: tdsByFy.get(fy) ?? 0n, creditNote: 'Section 194S: 1% of the consideration, deducted when a virtual digital asset is sold; a credit against the tax on it' },
      setOff, exemption: { section: '112A', limit, used: limit - exemptionLeft }, tax: taxLines, taxTotalFixedRates: fixed, slabGainsTaxable: slab, carriedForward, lapsed,
      totals: { ...totals, gain: totals.ledgerGain + vda.saleFeesNotAllowed },
    })
  }
  return {
    generatedAt: now, label: RULES.label, ruleSet: { id: RULES.id, asOf: RULES.asOf, sources: RULES.sources, notVerified: RULES.notVerified },
    assumptions: [
      'Rates are those in force on each sale date; the rule set is dated ' + RULES.asOf + '.',
      'Tax is shown at the section\'s own rate, before surcharge and the 4% cess. Gains taxed at your slab rate are shown without a tax figure.',
      'FIFO lots from the ledger give each sale\'s cost; the financial year runs 1 April to 31 March (India Standard Time).',
      'Losses are set off against the highest rate first, within the year, then brought forward; a loss is assumed to have been reported in time to be carried forward.',
      'The gain on a virtual digital asset is taxed transfer by transfer; the venue fee on a sale is added back to the consideration because only cost of acquisition is allowed.',
      'The paper venues and funds in this build are simulated, so these are the tax figures of simulated trades.',
    ],
    years: blocks,
  }
}

const addFy = (fy: string, n: number): string => { const y = fyStartYear(fy) + n; return `${y}-${String((y + 1) % 100).padStart(2, '0')}` }
/** amount × rate (basis points), rounded half up; never below zero. */
function roundBp(amount: bigint, bp: number): bigint { return amount <= 0n ? 0n : (amount * BigInt(bp) + 5_000n) / 10_000n }

// ------------------------------------------------------------------------------------------------ reconciliation

export interface TaxBreak { check: string; detail: string }
/**
 * Compare the statement with the ledger by other routes: each sale's proceeds with the entry's own postings, each lot's cost
 * with the entry that opened it, the statement's totals with the realised table, tax deducted with the 'tds' account, stamp
 * duty with the 'exp:stamp' account, and the tax deducted with 1% of each virtual digital asset sale.
 */
export function reconcileTax(db: Db, userId: string, stmt: TaxStatement): { ok: boolean; breaks: TaxBreak[]; checked: Record<string, string> } {
  const breaks: TaxBreak[] = []
  const sumYears = (f: (y: YearBlock) => bigint): bigint => stmt.years.reduce((s, y) => s + f(y), 0n)
  // 1. each sale entry: proceeds = what was exchanged less the fee, from the entry's own postings
  const sales = db.all<{ entry_id: string; p: string }>('SELECT entry_id, amount_sum(CAST(proceeds AS TEXT)) p FROM realised WHERE user_id = ? GROUP BY entry_id', userId)
  for (const s of sales) {
    const exchanged = -entryPosting(db, s.entry_id, 'trade:INR'), fee = entryPosting(db, s.entry_id, 'exp:fees')
    if (big(s.p, 'proceeds') !== exchanged - fee) breaks.push({ check: 'proceeds-match-entry', detail: `entry ${s.entry_id}: the lots realised ${s.p} but the entry exchanged ${exchanged} less a fee of ${fee}` })
  }
  // 2. each lot's cost = what the opening entry paid
  for (const l of db.all<{ id: string; entry_id: string; c: string }>('SELECT id, entry_id, CAST(cost AS TEXT) c FROM lots WHERE user_id = ?', userId)) {
    const paid = entryPosting(db, l.entry_id, 'trade:INR') + entryPosting(db, l.entry_id, 'exp:fees') + entryPosting(db, l.entry_id, 'exp:stamp')
    if (big(l.c, `lot ${l.id}`) !== paid) breaks.push({ check: 'lot-cost-matches-entry', detail: `lot ${l.id}: cost ${l.c} but entry ${l.entry_id} paid ${paid}` })
  }
  // 3. statement totals = the realised table
  const tbl = db.get<{ p: string; c: string }>('SELECT amount_sum(CAST(proceeds AS TEXT)) p, amount_sum(CAST(cost AS TEXT)) c FROM realised WHERE user_id = ?', userId)!
  const sp = sumYears((y) => y.totals.proceeds), sc = sumYears((y) => y.totals.cost)
  if (sp !== big(tbl.p, 'proceeds')) breaks.push({ check: 'proceeds-total', detail: `statement ${sp}, realised table ${tbl.p}` })
  if (sc !== big(tbl.c, 'cost')) breaks.push({ check: 'cost-total', detail: `statement ${sc}, realised table ${tbl.c}` })
  // 4. tax deducted at source = the 'tds' account
  const tdsAcc = db.get<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'tds'`, userId)?.t
  const tds = sumYears((y) => y.tds.vda)
  if (tds !== (tdsAcc === undefined ? 0n : big(tdsAcc, 'tds'))) breaks.push({ check: 'tds-total', detail: `statement ${tds}, the tds account holds ${tdsAcc ?? '0'}` })
  // 5. stamp duty = the exp:stamp account
  const stampAcc = db.get<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.user_id = ? AND a.code = 'exp:stamp'`, userId)?.t
  const stamp = sumYears((y) => y.charges.filter((c) => c.kind === 'stamp').reduce((s, c) => s + c.amount, 0n))
  if (stamp !== (stampAcc === undefined ? 0n : big(stampAcc, 'stamp'))) breaks.push({ check: 'stamp-total', detail: `statement ${stamp}, the exp:stamp account holds ${stampAcc ?? '0'}` })
  // 6. the deduction was 1% of each virtual digital asset sale, rounded up as the venue does
  for (const y of stmt.years) for (const t of y.vda.transfers) {
    const expected = (t.consideration + 99n) / 100n
    if (t.tds !== expected) breaks.push({ check: 'tds-rate', detail: `sale ${t.entryId}: ${t.tds} deducted, 1% of ${t.consideration} is ${expected}` })
  }
  // 7. every year's lines add to its totals, and the gain identity holds
  for (const y of stmt.years) {
    const g = y.lines.reduce((s, l) => s + l.gain, 0n)
    if (g !== y.totals.ledgerGain || y.totals.gain !== g + y.vda.saleFeesNotAllowed) breaks.push({ check: 'year-total', detail: `${y.fy}: lines give ${g}, totals say ${y.totals.ledgerGain}` })
    const vsum = y.vda.transfers.reduce((s, t) => s + t.gain, 0n)
    const vlines = y.lines.filter((l) => l.cls === 'vda').reduce((s, l) => s + l.gain, 0n)
    if (vsum !== vlines + y.vda.saleFeesNotAllowed) breaks.push({ check: 'vda-transfers', detail: `${y.fy}: the transfers gain ${vsum}, the lines gain ${vlines} plus fees ${y.vda.saleFeesNotAllowed}` })
  }
  return { ok: breaks.length === 0, breaks, checked: { proceeds: sp.toString(), cost: sc.toString(), tds: tds.toString(), stamp: stamp.toString() } }
}

// ------------------------------------------------------------------------------------------------ export

/** JSON-safe: bigints as decimal strings. */
export const taxJson = (stmt: TaxStatement, recon: ReturnType<typeof reconcileTax>): string => JSON.stringify({ ...stmt, reconciliation: recon }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** One row per figure; amounts in paise. The first row is the label and the rule set's date. */
export function taxCsv(stmt: TaxStatement, recon: ReturnType<typeof reconcileTax>): string {
  const out: unknown[][] = [['record', 'financial_year', 'class', 'term', 'section', 'rate_percent', 'proceeds_paise', 'cost_paise', 'amount_paise', 'note']]
  out.push(['label', '', '', '', '', '', '', '', '', `${stmt.label}. Rule set ${stmt.ruleSet.id} dated ${stmt.ruleSet.asOf}. Amounts in paise.`])
  for (const y of stmt.years) {
    for (const l of y.lines) out.push(['realised', y.fy, CLASS_NAME[l.cls], l.term, l.section, l.rateBp === null ? 'slab' : l.rateBp / 100, l.proceeds, l.cost, l.gain, l.note])
    for (const t of y.vda.transfers) out.push(['vda-transfer', y.fy, CLASS_NAME.vda, '', '115BBH', 30, t.consideration, t.cost, t.gain, `${t.instrumentId}; fee not allowed ${t.saleFee}; tds ${t.tds}; entry ${t.entryId}`])
    for (const s of y.setOff) out.push(['set-off', y.fy, '', '', '', '', '', '', s.amount, `${s.from} against ${s.against} (${s.kind})`])
    out.push(['exemption', y.fy, '', 'long', y.exemption.section, '', '', '', y.exemption.used, `limit ${y.exemption.limit}`])
    for (const t of y.tax) out.push(['tax', y.fy, '', '', t.section, t.rateBp === null ? 'slab' : t.rateBp / 100, '', '', t.tax === null ? '' : t.tax, `taxable ${t.taxable}. ${t.note}`])
    out.push(['tds', y.fy, CLASS_NAME.vda, '', '194S', 1, '', '', y.tds.vda, 'Credit against the tax on virtual digital assets'])
    for (const c of y.charges) out.push(['charge', y.fy, '', '', '', '', '', '', c.amount, `${c.label}. ${c.treatment}`])
    for (const c of y.carriedForward) out.push(['carried-forward', y.fy, '', c.term, '74', '', '', '', c.amount, `from ${c.fy}; usable until ${c.usableUntilFy}`])
    for (const c of y.lapsed) out.push(['lapsed', y.fy, '', c.term, '74', '', '', '', c.amount, `from ${c.fy}`])
  }
  out.push(['reconciliation', '', '', '', '', '', '', '', recon.ok ? 'ok' : 'break', recon.breaks.map((b) => `${b.check}: ${b.detail}`).join(' | ')])
  return out.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
