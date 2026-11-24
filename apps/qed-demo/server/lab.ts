/**
 * The Portfolio lab (R12): research, evaluation, construction, hedging, monitoring and certificates for the household's
 * own books, each figure labelled with where it comes from (shared/labTypes.ts). It computes and proposes; it never
 * trades. A change it suggests becomes a rules-origin proposal of the existing `rebalance` instruction, which the owner
 * opens as a draft, reads and signs with a passkey (the instruction and approval flow every instruction goes through);
 * that instruction then asks before every run.
 *
 *   GET  /api/lab                          books, monitoring, allocation, and the walk-forward on recorded NAVs
 *   GET  /api/lab/research                 the recorded R11 study (server/lab-research.json, with file hashes)
 *   GET  /api/lab/certificates?declared=1  guarantee-or-abstain on the household's own Save and Grow requests
 *   POST /api/lab/certificates/check       the checker on any request in its wire format (shared/kernel/coverage.ts)
 *   POST /api/lab/hedge                    a dollar liability: unhedged risk on recorded rates, and what hedging takes
 *   POST /api/lab/proposals/rebalance      the chosen mix (equal weight by default; risk parity or minimum variance when the owner
 *                                          chooses them: the allocator, R13 G6) with a 5-point band, as a proposal opened as a draft
 *
 * Tax rates here are QED's modelling of Indian rules, not verified against the Income-tax Act 2025 this session, and
 * not tax advice; each is labelled "modelled" where it appears. Nothing here is investment advice: QED holds no
 * investment adviser or portfolio manager registration, and the screen says so.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { draftProposals, storeProposal } from './ai.ts'
import { AppError, bad, type Config, type Db, ist, parse } from './core.ts'
import { monthlyRuns } from './household.ts'
import { instrument, term } from './registry.ts'
import type { Ctx } from './types.ts'
import { commitments, holdings, overview } from './valuation.ts'
import { checkCoverage as check, isoOf, dayNum, type CoverageOutcome as Outcome, type CoverageRequest as Request } from '../shared/kernel/index.ts'
import { ledoitWolf, minVariance, riskParity, type Series, sharpeDifference, type Strategy, walkForward } from '../shared/portfolio.ts'
import type { LabAllocation, LabBooks, LabCertificate, LabCertificates, LabEvaluation, LabHedge, LabHolding, LabLot, LabMonitor, LabTerm, LabTrade, LabView } from '../shared/labTypes.ts'

const DAY = 86_400_000
const RESEARCH_FILE = join(import.meta.dirname, 'lab-research.json')
let research: string | null = null
/** The recorded R11 study, as written by scripts/lab-evidence.ts (each source file's SHA-256 inside). */
export const labResearch = (): unknown => JSON.parse((research ??= readFileSync(RESEARCH_FILE, 'utf8')))

// ------------------------------------------------------------------------------------------------ what each holding is
const GROWTH_FUNDS = ['amfi:120716', 'amfi:120684', 'amfi:122639', 'amfi:148381', 'amfi:119788']
const LIQUID = 'amfi:118701'
const CASH_LIKE = new Set(['liquid', 'overnight', 'arbitrage'])
const HOUSE: Record<string, string> = { Parag: 'PPFAS', Motilal: 'Motilal Oswal', ICICI: 'ICICI Prudential', Nippon: 'Nippon India' }
const fundHouse = (name: string): string => { const w = name.split(' ')[0] ?? name; return HOUSE[w] ?? w }

/**
 * Tax classes as QED models them (status "modelled"): equity-oriented funds 20% within a year, 12.5% after, with
 * Rs 1.25 lakh of long-term gains a year exempt; funds of funds (international, gold) at the slab rate within two years
 * and 12.5% after; debt-like funds at the slab rate; virtual digital assets 30% with no set-off of losses and 1% TDS on
 * the sale. Slab rate taken as 30%; a 4% cess on all; surcharge left out.
 */
const CESS = 1.04, SLAB = 0.30
const TAX = {
  equity: { st: 0.20, lt: 0.125, ltDays: 365, exemption: 12_500_000, label: 'equity-oriented fund' },
  fof: { st: SLAB, lt: 0.125, ltDays: 730, exemption: 0, label: 'fund of funds (international or gold)' },
  debt: { st: SLAB, lt: SLAB, ltDays: Number.POSITIVE_INFINITY, exemption: 0, label: 'debt-like fund (slab rate)' },
  vda: { st: 0.30, lt: 0.30, ltDays: Number.POSITIVE_INFINITY, exemption: 0, label: 'virtual digital asset' },
} as const
type TaxClass = keyof typeof TAX
const taxClass = (kind: string, category: string): TaxClass => (kind === 'crypto_spot' ? 'vda' : ['index', 'flexi', 'arbitrage'].includes(category) ? 'equity' : ['international', 'gold'].includes(category) ? 'fof' : 'debt')

interface OpenLot { openedAt: number; qty: bigint; remaining: bigint; cost: bigint }
function openLots(db: Db, userId: string, instrumentId: string): OpenLot[] {
  return db.all<{ opened_at: number; qty: string; remaining: string; cost: string }>(
    'SELECT opened_at, CAST(qty AS TEXT) qty, CAST(remaining AS TEXT) remaining, CAST(cost AS TEXT) cost FROM lots WHERE user_id = ? AND instrument_id = ? AND remaining > 0 ORDER BY opened_at, id', userId, instrumentId)
    .map((l) => ({ openedAt: l.opened_at, qty: BigInt(l.qty), remaining: BigInt(l.remaining), cost: BigInt(l.cost) }))
}
/** Long-term gains already realised on equity-oriented funds this Indian financial year (for the exemption). */
function realisedEquityLtThisYear(db: Db, userId: string, now: number): number {
  const t = ist(now)
  const fyStart = Date.parse(`${t.m >= 4 ? t.y : t.y - 1}-04-01T00:00:00+05:30`)
  const rows = db.all<{ instrument_id: string; ts: number; opened_at: number; proceeds: number; cost: number }>('SELECT instrument_id, ts, opened_at, proceeds, cost FROM realised WHERE user_id = ? AND ts >= ?', userId, fyStart)
  let g = 0
  for (const r of rows) {
    const inst = instrument(db, r.instrument_id)
    if (!inst || taxClass(inst.kind, String(inst.meta.category ?? '')) !== 'equity') continue
    if (r.ts - r.opened_at > 365 * DAY) g += r.proceeds - r.cost
  }
  return Math.max(0, g)
}

// ------------------------------------------------------------------------------------------------ the books
/** The workspace's holdings as the lab reads them (values, cost, lots, tax classes), for reports (institutional.ts). */
export const labBooks = (ctx: Ctx, userId: string, now: number): { books: LabBooks; holdings: LabHolding[] } => books(ctx, userId, now)
function books(ctx: Ctx, userId: string, now: number): { books: LabBooks; holdings: LabHolding[] } {
  const { db, market } = ctx
  const o = overview(db, market, userId, now)
  const hs = holdings(db, market, userId, now)
  const out: LabHolding[] = hs.map((h) => {
    const inst = instrument(db, h.instrumentId)!
    const category = inst.kind === 'crypto_spot' ? 'crypto' : String(inst.meta.category ?? 'fund')
    const lots = openLots(db, userId, h.instrumentId)
    const totalRemaining = lots.reduce((s, l) => s + l.remaining, 0n)
    const cls = taxClass(inst.kind, category)
    const lv: LabLot[] = lots.map((l) => {
      const cost = Number((l.cost * l.remaining) / (l.qty || 1n))
      const value = h.value === null || totalRemaining === 0n ? null : Math.round((h.value * Number(l.remaining)) / Number(totalRemaining))
      const days = Math.floor((now - l.openedAt) / DAY)
      return { openedAt: l.openedAt, days, cost, value, gain: value === null ? null : value - cost, taxClass: `${TAX[cls].label}, ${days > TAX[cls].ltDays ? 'long-term' : 'short-term'}` }
    })
    return {
      instrumentId: h.instrumentId, name: h.name, kind: inst.kind === 'crypto_spot' ? 'crypto' : 'fund', category, growth: !CASH_LIKE.has(category),
      value: h.value, cost: h.cost, gain: h.value === null ? null : h.value - h.cost, weight: null,
      payoutDays: inst.kind === 'crypto_spot' ? 0 : Number(inst.meta.payoutDays ?? 2), fundHouse: inst.kind === 'crypto_spot' ? 'CoinDCX (paper venue)' : fundHouse(inst.name),
      dollarLinked: inst.kind === 'crypto_spot' || category === 'international' || category === 'gold', limit: h.limit, limitStatus: h.limitStatus,
      price: h.price, priceAt: h.priceSourceTs ?? h.priceRecvTs, stale: h.fresh.stale, provider: h.provider, lots: lv,
    }
  })
  const growthValue = out.filter((h) => h.growth).reduce((s, h) => s + (h.value ?? 0), 0)
  for (const h of out) h.weight = h.growth && growthValue > 0 && h.value !== null ? h.value / growthValue : null
  const dues = commitments(db, userId, now, 30 * DAY)
  return {
    holdings: out,
    books: {
      bank: o.bank, bankAvailable: o.bankAvailable, deposits: o.deposits, card: o.card, loans: o.loans, freeToUse: o.freeToUse, netWorth: o.netWorth,
      due30: dues.filter((d) => d.certain).reduce((s, d) => s + d.amount, 0),
      dues: dues.map((d) => ({ label: d.label, amount: d.amount, dueAt: d.dueAt, certain: d.certain, kind: d.kind })),
      holdings: out,
      worst: { gHat: o.worst.gHat, line: o.worst.line, cushion: o.worst.cushion, illustrative: o.worst.illustrative, valid: o.worst.valid },
    },
  }
}

function monitor(b: LabBooks, hs: LabHolding[], now: number): LabMonitor {
  const growth = hs.filter((h) => h.growth && h.value !== null && h.value > 0)
  const total = growth.reduce((s, h) => s + h.value!, 0)
  const w = growth.map((h) => h.value! / (total || 1))
  const hhi = w.reduce((s, x) => s + x * x, 0)
  const largest = growth.length ? growth.reduce((a, h) => (h.value! > a.value! ? h : a)) : null
  const houses = new Map<string, number>()
  for (const h of growth) houses.set(h.fundHouse, (houses.get(h.fundHouse) ?? 0) + h.value! / (total || 1))
  const invested = hs.filter((h) => h.value !== null && h.value > 0)
  const within = (d: number) => invested.filter((h) => h.payoutDays <= d).reduce((s, h) => s + h.value!, 0)
  const due7 = b.dues.filter((d) => d.certain && d.dueAt <= now + 7 * DAY).reduce((s, d) => s + d.amount, 0)
  const dollar = growth.filter((h) => h.dollarLinked)
  return {
    growthValue: total,
    concentration: { largest: largest ? { name: largest.name, weight: largest.value! / (total || 1) } : null, hhi, effectiveN: hhi > 0 ? 1 / hhi : 0, byFundHouse: [...houses].map(([house, weight]) => ({ house, weight })).sort((a, c) => c.weight - a.weight), crypto: growth.filter((h) => h.kind === 'crypto').reduce((s, h) => s + h.value!, 0) / (total || 1) },
    liquidity: {
      steps: [
        { label: 'In your bank now', days: 0, amount: b.bankAvailable },
        { label: 'Within 1 business day', days: 1, amount: b.bankAvailable + within(1) },
        { label: 'Within 2 business days', days: 2, amount: b.bankAvailable + within(2) },
        { label: 'Within 3 business days', days: 3, amount: b.bankAvailable + within(3) },
      ],
      due7, due30: b.due30, free: b.freeToUse, short7: b.bankAvailable < due7, short30: b.bankAvailable + within(3) < b.due30,
    },
    dollar: { weight: dollar.reduce((s, h) => s + h.value!, 0) / (total || 1), amount: dollar.reduce((s, h) => s + h.value!, 0), names: dollar.map((h) => h.name) },
    stale: hs.filter((h) => h.stale).map((h) => h.name),
  }
}

// ------------------------------------------------------------------------------------------------ construction
const BAND_BPS = 500

// ------------------------------------------------------------------------------------------------ the allocator (R13, G6)
export type AllocPolicy = 'equal' | 'riskparity' | 'minvar'
export const ALLOC_POLICIES: readonly AllocPolicy[] = ['equal', 'riskparity', 'minvar']
const POLICY_TEXT: Record<AllocPolicy, string> = {
  equal: 'Equal shares of what you hold that can grow (1/N)',
  riskparity: 'Risk parity: shares chosen so each investment adds the same risk (from the last year of recorded NAVs)',
  minvar: 'Minimum variance, long only: the shares with the least variance (from the last year of recorded NAVs)',
}
/** The window of recorded daily values the optimisers read, and the fewest shared daily returns they will work from. */
export const ALLOC_LOOKBACK_DAYS = 365, ALLOC_MIN_OBSERVATIONS = 100
type Optimised = { ok: true; w: number[]; certified: boolean; cert: Record<string, number>; observations: number; from: string; to: string; shrinkage: number } | { ok: false; why: string }

/**
 * The risk-parity or minimum-variance mix of these investments from the trailing year of daily values this app recorded
 * (shrunk covariance, Ledoit and Wolf 2004), with the certificate of the solve: how far the answer is from satisfying its own
 * optimality conditions. It works only where every investment has recorded NAV history: a digital asset has none here, and
 * then it says so rather than guess. Conditional on its assumptions: past covariance, one window, no forecast of returns.
 */
export function optimiseMix(db: Db, ids: string[], policy: 'riskparity' | 'minvar'): Optimised {
  const loaded = ids.map((id) => series(db, id))
  const missing = ids.filter((_, i) => !loaded[i])
  if (missing.length) return { ok: false, why: `This app has no recorded value history for ${missing.map((m) => instrument(db, m)?.name ?? m).join(', ')}, and ${policy === 'minvar' ? 'minimum variance' : 'risk parity'} needs at least 30 recorded values for every investment in the mix. Equal shares need none.` }
  const maps = loaded.map((l) => new Map(l!.s.dates.map((d, i) => [d, l!.s.values[i]!])))
  const common = [...maps[0]!.keys()].filter((d) => maps.every((m) => m.has(d))).sort()
  const end = common[common.length - 1]
  if (!end) return { ok: false, why: 'The investments share no dates with recorded values.' }
  const from = new Date(Date.parse(`${end}T00:00:00Z`) - ALLOC_LOOKBACK_DAYS * DAY).toISOString().slice(0, 10)
  const days = common.filter((d) => d >= from)
  const rows: number[][] = []
  for (let k = 1; k < days.length; k++) rows.push(maps.map((m) => m.get(days[k]!)! / m.get(days[k - 1]!)! - 1))
  if (rows.length < ALLOC_MIN_OBSERVATIONS) return { ok: false, why: `Only ${rows.length} daily returns are shared by every investment in the last year; at least ${ALLOC_MIN_OBSERVATIONS} are needed.` }
  const { S, shrinkage } = ledoitWolf(rows)
  if (policy === 'minvar') { const m = minVariance(S); return { ok: true, w: m.w, certified: m.kkt < 1e-6 && m.gap < 1e-6, cert: { kktResidual: m.kkt, dualityGap: m.gap }, observations: rows.length, from: days[0]!, to: end, shrinkage } }
  const r = riskParity(S)
  return { ok: true, w: r.w, certified: r.maxDev < 1e-6, cert: { maxRiskContributionDeviation: r.maxDev }, observations: rows.length, from: days[0]!, to: end, shrinkage }
}
/** Shares in basis points summing to 10,000, by largest remainder. */
function toBps(w: number[]): number[] {
  const raw = w.map((x) => x * 10_000), base = raw.map(Math.floor)
  let left = 10_000 - base.reduce((a, b) => a + b, 0)
  raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || a.i - b.i).forEach((o) => { if (left > 0) { base[o.i]!++; left-- } })
  return base
}

/**
 * Out of sample, on these investments only: the chosen method against equal weight, month by month, deciding each month end
 * from what was known then, net of the stamp duty a purchase pays. Months too few means no difference is claimed.
 */
function mixEvaluation(db: Db, ids: string[], policy: 'riskparity' | 'minvar', now: number): NonNullable<LabAllocation['evidence']>['outOfSample'] {
  const loaded = ids.map((id) => series(db, id))
  if (loaded.some((l) => !l)) return { months: 0, text: 'Not evaluated: not every investment has recorded value history.' }
  const ser = loaded.map((l) => l!.s)
  const strategies: Strategy[] = [
    { id: 'EW', label: 'Equal weight', assets: ids, weights: (S) => ({ w: S.map(() => 1 / S.length) }) },
    policy === 'minvar' ? { id: 'P', label: 'Minimum variance', assets: ids, weights: (S) => { const m = minVariance(S); return { w: m.w } } } : { id: 'P', label: 'Risk parity', assets: ids, weights: (S) => ({ w: riskParity(S).w }) },
  ]
  const span = Math.min(...ser.map((x) => Date.parse(`${x.dates[x.dates.length - 1]}T00:00:00Z`) - Date.parse(`${x.dates[0]}T00:00:00Z`))) / DAY
  const long = span > 3 * 365
  const res = walkForward(ser, strategies, { lookbackDays: long ? 365 : 120, minObservations: long ? 150 : 40, buyCost: 0.00005, tradeCost: 0, through: ist(now).date.slice(0, 7) })
  if ('error' in res) return { months: 0, text: `Not evaluated: ${res.error}.` }
  const ew = res.strategies[0]!, pp = res.strategies[1]!
  const d = sharpeDifference(pp.net, ew.net, res.rf, { reps: 1000, block: 3, seed: 20261124, minMonths: 36 })
  const name = policy === 'minvar' ? 'minimum variance' : 'risk parity'
  const text = d.tooShort
    ? `${res.months.length} recorded months are too short to tell ${name} from equal weight: no difference is claimed until there are 36. Over them the net Sharpe ratio was ${pp.metrics.sharpe.toFixed(2)} for ${name} and ${ew.metrics.sharpe.toFixed(2)} for equal weight.`
    : d.detectable
      ? `Over ${res.months.length} recorded months ${name} ${d.diff > 0 ? 'beat' : 'trailed'} equal weight on return for risk (net Sharpe ${pp.metrics.sharpe.toFixed(2)} against ${ew.metrics.sharpe.toFixed(2)}), by more than chance explains. One period: not a forecast.`
      : `Over ${res.months.length} recorded months the net Sharpe ratio of ${name} (${pp.metrics.sharpe.toFixed(2)}) is not detectably different from equal weight's (${ew.metrics.sharpe.toFixed(2)}); the record could only have detected a difference of about ${d.mde.toFixed(2)} a year.`
  return { months: res.months.length, sharpeEW: ew.metrics.sharpe, sharpeP: pp.metrics.sharpe, detectable: d.detectable, tooShort: d.tooShort, text }
}

/** What the R11 study found for this method, read from the recorded study (server/lab-research.json), never typed in. */
function studyLine(policy: 'riskparity' | 'minvar'): NonNullable<LabAllocation['evidence']>['study'] {
  const core = (labResearch() as { core: { months: number; from: string; to: string; strategies: { id: string; sharpe: number; maxDD: number; vsEW: { pFwer: number } | null }[] } }).core
  const p = core.strategies.find((x) => x.id === (policy === 'minvar' ? 'MINV_LW' : 'RP_LW')), ew = core.strategies.find((x) => x.id === 'EW')
  if (!p || !ew) return { text: 'The recorded study has no result for this method.' }
  return { sharpe: p.sharpe, sharpeEW: ew.sharpe, maxDD: p.maxDD, maxDDEW: ew.maxDD, pFwer: p.vsEW?.pFwer ?? null,
    text: `In the R11 study (${core.months} months, ${core.from} to ${core.to}, a historical simulation on US industry portfolios and Treasuries, net of costs) ${policy === 'minvar' ? 'minimum variance' : 'risk parity'} had a Sharpe ratio of ${p.sharpe.toFixed(2)} against ${ew.sharpe.toFixed(2)} for equal weight, and a worst drawdown of ${(p.maxDD * 100).toFixed(0)}% against ${(ew.maxDD * 100).toFixed(0)}%. The difference in Sharpe ratio is ${(p.vsEW?.pFwer ?? 1) > 0.05 ? 'not statistically distinguishable from equal weight' : 'statistically distinguishable from equal weight'} once all the strategies the study tried are counted (family-wise p = ${(p.vsEW?.pFwer ?? 1).toFixed(2)}). That is a different market, period and set of assets from yours.` }
}

function allocation(ctx: Ctx, userId: string, hs: LabHolding[], now: number, policy: AllocPolicy = 'equal'): LabAllocation {
  const { db } = ctx
  const legsAll = hs.filter((h) => h.growth && h.value !== null && h.value > 0).sort((a, b) => b.value! - a.value!)
  const legs = legsAll.slice(0, 6)
  const existing = db.all<{ id: string; title: string; state: string }>(`SELECT id, title, state FROM programs WHERE user_id = ? AND kind = 'rebalance' AND state IN ('active', 'paused', 'draft') ORDER BY created_at DESC`, userId)
  const invest = db.all<{ title: string; params_json: string }>(`SELECT p.title, v.params_json FROM programs p JOIN program_versions v ON v.program_id = p.id AND v.version = COALESCE(p.live_version, v.version) WHERE p.user_id = ? AND p.kind = 'invest' AND p.state = 'active'`, userId)
  const empty = (why: string): LabAllocation => ({ policy, policyText: POLICY_TEXT[policy], bandBps: BAND_BPS, legs: [], drift: 0, outside: false, trades: [], taxTotal: 0, feeTotal: 0, tdsTotal: 0, newMoney: null, proposable: false, why, params: null, existing })
  if (legs.length < 2) return empty(legs.length === 0 ? 'You hold nothing that can grow yet, so there is no mix to keep in balance.' : 'You hold one investment that can grow; a mix needs at least two.')
  let legsUsed = legs
  let evidence: LabAllocation['evidence']
  let bps: number[]
  if (policy === 'equal') {
    bps = legs.map((_, i) => Math.floor(10_000 / legs.length) + (i < 10_000 % legs.length ? 1 : 0))
  } else {
    const opt = optimiseMix(db, legs.map((h) => h.instrumentId), policy)
    if (!opt.ok) return empty(opt.why)
    const raw = toBps(opt.w)
    // a leg the method gives no weight is left out of the instruction (it would otherwise be one share of nothing)
    legsUsed = legs.filter((_, i) => raw[i]! > 0)
    bps = raw.filter((x) => x > 0)
    if (legsUsed.length < 2) return empty(`${policy === 'minvar' ? 'Minimum variance' : 'Risk parity'} would put everything in one investment (${legs[raw.findIndex((x) => x > 0)]?.name ?? 'one'}), which is not a mix an instruction can keep. Equal shares are available.`)
    const left = legs.filter((_, i) => raw[i] === 0).map((h) => h.name)
    evidence = {
      method: POLICY_TEXT[policy], window: { from: opt.from, to: opt.to, observations: opt.observations }, shrinkage: opt.shrinkage, certified: opt.certified, certificate: opt.cert,
      outOfSample: mixEvaluation(db, legsUsed.map((h) => h.instrumentId), policy, now), study: studyLine(policy),
      leftOut: left,
      caveats: [
        'The shares come from last year\'s recorded covariance. They say nothing about future returns, and a mix chosen for low past risk can change when markets change.',
        'In the recorded study no optimiser beat equal weight with statistical confidence after costs; equal shares are the baseline this is measured against.',
        'Trades to reach the mix realise gains and cost tax and fees now (shown below, modelled). Nothing is traded until you sign the instruction, and it asks before every run.',
        ...(left.length ? [`The method gives nothing to ${left.join(', ')}, so the instruction leaves it alone; it does not sell it.`] : []),
      ],
    }
  }
  const total = legsUsed.reduce((s, h) => s + h.value!, 0)
  const rows = legsUsed.map((h, i) => { const weight = h.value! / total, target = bps[i]! / 10_000; return { instrumentId: h.instrumentId, name: h.name, value: h.value!, weight, target, drift: weight - target, trade: Math.round(total * target - h.value!) } })
  const drift = Math.max(...rows.map((r) => Math.abs(r.drift)))
  const outside = drift > BAND_BPS / 10_000
  const fee = String(term(db, 'fee.paper-crypto.taker')?.value.rate ?? '0.0059'), stamp = String(term(db, 'mf.stamp')?.value.rate ?? '0.00005'), tdsRate = String(term(db, 'tax.vda.tds')?.value.rate ?? '0.01')
  const feeStatus = `term on record, ${term(db, 'fee.paper-crypto.taker')?.status ?? 'modelled'}`, stampStatus = `term on record, ${term(db, 'mf.stamp')?.status ?? 'modelled'}`
  let exemption = Math.max(0, TAX.equity.exemption - realisedEquityLtThisYear(db, userId, now))
  const trades: LabTrade[] = []
  for (const r of rows) {
    if (r.trade === 0) continue
    const h = legsUsed.find((x) => x.instrumentId === r.instrumentId)!
    const crypto = h.kind === 'crypto'
    if (r.trade > 0) {
      const f = Math.ceil(r.trade * Number(crypto ? fee : stamp))
      trades.push({ instrumentId: r.instrumentId, name: r.name, side: 'buy', amount: r.trade, realisedGain: 0, tax: 0, taxNote: 'A purchase realises nothing.', fee: f, feeNote: crypto ? `venue fee ${(Number(fee) * 100).toFixed(2)}% (${feeStatus})` : `stamp duty ${(Number(stamp) * 100).toFixed(3)}% (${stampStatus})`, tds: 0 })
      continue
    }
    // sell first-in, first-out, each lot at its share of today's value
    let left = -r.trade, gain = 0, tax = 0
    const parts: string[] = []
    const cls = taxClass(crypto ? 'crypto_spot' : 'mutual_fund', h.category)
    for (const l of h.lots) {
      if (left <= 0 || l.value === null || l.value <= 0) continue
      const take = Math.min(left, l.value)
      const g = Math.round((l.gain ?? 0) * (take / l.value))
      left -= take
      gain += g
      const lt = l.days > TAX[cls].ltDays
      let taxable = Math.max(0, g)
      if (cls === 'equity' && lt) { const use = Math.min(exemption, taxable); exemption -= use; taxable -= use }
      tax += Math.round(taxable * (lt ? TAX[cls].lt : TAX[cls].st) * CESS)
      parts.push(`${lt ? 'long' : 'short'}-term ${g >= 0 ? 'gain' : 'loss'}`)
    }
    const f = crypto ? Math.ceil(-r.trade * Number(fee)) : 0
    trades.push({
      instrumentId: r.instrumentId, name: r.name, side: 'sell', amount: -r.trade, realisedGain: gain, tax, fee: f, tds: crypto ? Math.ceil(-r.trade * Number(tdsRate)) : 0,
      feeNote: crypto ? `venue fee ${(Number(fee) * 100).toFixed(2)}% (${feeStatus})` : 'no exit load modelled for this fund (check its scheme document)',
      taxNote: `${TAX[cls].label}: ${[...new Set(parts)].join(' and ') || 'no gain'}; modelled rate${cls === 'vda' ? ', losses not set off' : ''}`,
    })
  }
  const monthly = invest.reduce((s, p) => { const prm = parse<{ instrumentId?: string; amount?: number; schedule?: { type?: string; minutes?: number } }>(p.params_json, {}); return s + (typeof prm.amount === 'number' ? Math.round(prm.amount * monthlyRuns(prm.schedule)) : 0) }, 0)
  const gap = rows.filter((r) => r.trade > 0).reduce((s, r) => s + r.trade, 0)
  return {
    policy, policyText: POLICY_TEXT[policy], ...(evidence ? { evidence } : {}), bandBps: BAND_BPS, legs: rows, drift, outside, trades: outside ? trades : [],
    taxTotal: outside ? trades.reduce((s, t) => s + t.tax, 0) : 0, feeTotal: outside ? trades.reduce((s, t) => s + t.fee, 0) : 0, tdsTotal: outside ? trades.reduce((s, t) => s + t.tds, 0) : 0,
    newMoney: invest.length ? { monthly, gap, months: monthly > 0 ? Math.ceil(gap / monthly) : null, programs: invest.map((p) => p.title) } : null,
    proposable: existing.length === 0,
    why: existing.length ? `You already have ${existing.length === 1 ? 'an instruction' : 'instructions'} keeping a mix in balance (${existing.map((e) => `"${e.title}", ${e.state}`).join('; ')}).` : legsAll.length > 6 ? 'An instruction can hold six investments; the six largest are in this mix.' : '',
    params: { legs: rows.map((r, i) => ({ instrumentId: r.instrumentId, weightBps: bps[i]! })), bandBps: BAND_BPS, schedule: { type: 'daily', at: '11:00' } },
    existing,
  }
}

/**
 * Open the lab's mix as a proposal, then as a draft instruction the owner reads and signs (nothing trades before). The
 * allocator (R13, G6) proposes; it never trades. With risk parity or minimum variance the draft carries the method, the
 * certificate of the solve, the out-of-sample result on these investments and the R11 study's caveats in its own words.
 */
export function proposeRebalance(ctx: Ctx, cfg: Pick<Config, 'adviserReview'>, userId: string, now: number, policy: AllocPolicy = 'equal'): { proposalId: string; programId: string; title: string } {
  const { holdings: hs } = books(ctx, userId, now)
  const a = allocation(ctx, userId, hs, now, policy)
  if (!a.params || !a.proposable) throw new AppError(409, 'not_proposable', a.why || 'There is no mix to propose.')
  const e = a.evidence
  const rationale = policy === 'equal'
    ? `Equal shares of the ${a.legs.length} investments you hold that can grow, traded back only when one drifts more than 5 percentage points from its share. In the R11 study (1972-2026, a historical simulation) no optimiser beat equal weight net of costs, and for a taxed household a 5-point band raised the after-tax value of equal weight by about 12% against monthly rebalancing. It asks you before every run; nothing trades until you sign it.`
    : (() => {
      const o = e!.outOfSample, st = e!.study
      const oos = o.sharpeP === undefined ? 'Out of sample: not evaluated.' : `Out of sample on your ${o.months} recorded months: net Sharpe ${o.sharpeP.toFixed(2)} against ${o.sharpeEW!.toFixed(2)} for equal shares, ${o.tooShort ? 'too few months to claim a difference' : o.detectable ? 'a difference beyond chance' : 'not detectably different'}.`
      const study = st.sharpe === undefined ? '' : ` R11 study (1972-2026, US data, a simulation): Sharpe ${st.sharpe.toFixed(2)} against ${st.sharpeEW!.toFixed(2)}, ${st.pFwer != null && st.pFwer > 0.05 ? 'not distinguishable from equal weight' : 'distinguishable from equal weight'} once every strategy tried is counted (p ${st.pFwer == null ? 'n/a' : st.pFwer.toFixed(2)}).`
      return `${policy === 'minvar' ? 'Minimum variance' : 'Risk parity'} from last year's recorded values; its own optimality check ${e!.certified ? 'passed' : 'FAILED'}. Nothing trades until you sign; it asks before every run. ${oos}${study} Past risk, not a forecast; QED's own calculation, not advice. Shares: ${a.legs.map((l) => `${l.name.split(' ').slice(0, 3).join(' ')} ${(l.target * 100).toFixed(1)}%`).join('; ')}.`
    })()
  const p = storeProposal(ctx, userId, null, 'rules', 'rebalance', policy === 'equal' ? 'Keep what can grow in equal shares, with a 5-point band' : `Keep what can grow in ${policy === 'minvar' ? 'minimum-variance' : 'risk-parity'} shares, with a 5-point band`, rationale, a.params, 'approve', now)
  if (p.state === 'invalid') throw new AppError(409, 'invalid_proposal', p.invalidReason ?? 'The proposal is not valid.')
  const d = draftProposals(ctx, userId, [p.id], cfg)
  const first = d.drafted[0]
  if (!first) throw new AppError(409, 'not_drafted', d.skipped[0]?.reason ?? 'The proposal could not be opened as a draft.')
  return { proposalId: p.id, programId: first.programId, title: first.title }
}

// ------------------------------------------------------------------------------------------------ evaluation on recorded NAVs
function series(db: Db, id: string): { s: Series; sources: Set<string> } | null {
  const inst = instrument(db, id)
  if (!inst) return null
  const rows = db.all<{ value_date: string; value: string; source: string }>('SELECT value_date, value, source FROM daily_values WHERE instrument_id = ? ORDER BY value_date', id)
  if (rows.length < 30) return null
  return { s: { id, name: inst.name.replace(/ \(.*\)$/, ''), dates: rows.map((r) => r.value_date), values: rows.map((r) => Number(r.value)) }, sources: new Set(rows.map((r) => r.source)) }
}
const sourceText = (sources: Set<string>): { text: string; synthetic: boolean } => {
  if (sources.has('synthetic')) return { text: 'synthetic NAVs generated on this computer (presentation mode)', synthetic: true }
  if ([...sources].some((s) => s.startsWith('mfapi') || s.startsWith('amfi'))) return { text: 'published NAVs recorded by this app (AMFI; earlier history back-filled from mfapi.in)', synthetic: false }
  return { text: `values recorded by this app (${[...sources].join(', ')})`, synthetic: !![...sources].find((s) => s === 'test') }
}
let evalCache: { key: string; value: LabEvaluation | { error: string; source: string } } | null = null

export function evaluation(db: Db, now: number): LabEvaluation | { error: string; source: string } {
  const loaded = [...GROWTH_FUNDS, LIQUID].map((id) => series(db, id)).filter((x): x is NonNullable<typeof x> => !!x)
  const key = loaded.map((l) => `${l.s.id}:${l.s.dates.length}:${l.s.dates[l.s.dates.length - 1]}`).join('|') + `|${ist(now).date.slice(0, 7)}`
  if (evalCache?.key === key) return evalCache.value
  const value = evaluate(loaded, now)
  evalCache = { key, value }
  return value
}
function evaluate(loaded: { s: Series; sources: Set<string> }[], now: number): LabEvaluation | { error: string; source: string } {
  const all = new Set<string>(loaded.flatMap((l) => [...l.sources]))
  const src = sourceText(all)
  const risky = loaded.filter((l) => GROWTH_FUNDS.includes(l.s.id)).map((l) => l.s)
  const liquid = loaded.find((l) => l.s.id === LIQUID)?.s ?? null
  if (risky.length < 2) return { error: `This app has recorded NAVs for ${risky.length} of the five growth funds it lists; a comparison needs at least two.`, source: src.text }
  const span = Math.min(...risky.map((s) => Date.parse(`${s.dates[s.dates.length - 1]}T00:00:00Z`) - Date.parse(`${s.dates[0]}T00:00:00Z`))) / DAY
  const long = span > 3 * 365
  const ids = risky.map((s) => s.id)
  const nifty = ids.includes('amfi:120716') && liquid ? 'amfi:120716' : null
  const strategies: Strategy[] = [
    { id: 'EW', label: 'Equal weight (1/N)', assets: ids, weights: (S) => ({ w: S.map(() => 1 / S.length) }) },
    ...(nifty ? [{ id: 'B6040', label: '60/40 Nifty 50 index and liquid fund', assets: [nifty, LIQUID], weights: () => ({ w: [0.6, 0.4] }) } satisfies Strategy] : []),
    { id: 'RP', label: 'Risk parity (equal risk contribution)', assets: ids, weights: (S) => { const r = riskParity(S); return { w: r.w, cert: { maxRiskContributionDeviation: r.maxDev } } } },
    { id: 'MINV', label: 'Minimum variance (long only)', assets: ids, weights: (S) => { const m = minVariance(S); return { w: m.w, cert: { kktResidual: m.kkt, dualityGap: m.gap } } } },
  ]
  const res = walkForward([...risky, ...(liquid ? [liquid] : [])], strategies, { lookbackDays: long ? 365 : 120, minObservations: long ? 150 : 40, buyCost: 0.00005, tradeCost: 0, through: ist(now).date.slice(0, 7), rf: liquid })
  if ('error' in res) return { error: res.error, source: src.text }
  const ew = res.strategies.find((s) => s.id === 'EW')!
  const strategiesOut = res.strategies.map((s) => ({
    id: s.id, label: s.label, assets: s.assets, metrics: s.metrics, turnover: s.turnover, costDrag: s.costDrag, path: s.path, cert: s.cert, weightsLast: s.weightsLast,
    vsEW: s.id === 'EW' ? null : sharpeDifference(s.net, ew.net, res.rf, { reps: 1000, block: 3, seed: 20261124, familyAlpha: 0.05 / (res.strategies.length - 1), minMonths: 36 }),
  }))
  const det = strategiesOut.filter((s) => s.vsEW?.detectable)
  const mde = Math.max(...strategiesOut.filter((s) => s.vsEW).map((s) => s.vsEW!.mde))
  const k = strategiesOut.length - 1
  const verdict = res.months.length < 36
    ? `${res.months.length} months are too short to tell these strategies apart: no difference is claimed until there are 36. ${src.synthetic ? 'The prices are synthetic, so this shows the method, not markets.' : 'Not a forecast.'}`
    : det.length
      ? `On these ${res.months.length} months, ${det.map((s) => `${s.label} ${s.vsEW!.diff > 0 ? 'beat' : 'trailed'} equal weight`).join('; ')} on return for risk, by more than chance explains with all ${k} comparisons counted. ${src.synthetic ? 'The prices are synthetic, so this says nothing about markets. ' : ''}One period of history: not a forecast.`
      : `On these ${res.months.length} months no strategy's net Sharpe ratio differs detectably from equal weight's (all ${k} comparisons counted); the record could only have detected a difference of about ${mde.toFixed(2)} a year. ${src.synthetic ? 'The prices are synthetic, so this says nothing about markets.' : 'That agrees with the 54-year study, and is not a forecast.'}`
  return {
    basis: 'simulation', source: src.text, synthetic: src.synthetic, months: res.months, lookbackDays: res.lookbackDays, observations: res.observations,
    assets: res.universe.map((id) => ({ id, name: [...risky, ...(liquid ? [liquid] : [])].find((s) => s.id === id)!.name })), rf: `${res.rfLabel} (its own monthly return)`,
    costs: { buy: 0.00005, trade: 0, note: 'Stamp duty of 0.005% on every purchase (a verified term); no exit loads modelled; funds trade at NAV, so no spread.' },
    strategies: strategiesOut, verdict,
  }
}

// ------------------------------------------------------------------------------------------------ the view
export function labView(ctx: Ctx, cfg: Pick<Config, 'presentation'>, userId: string, now: number, policy: AllocPolicy = 'equal'): LabView {
  const { books: b, holdings: hs } = books(ctx, userId, now)
  const terms: LabTerm[] = ['tax.vda.tds', 'fee.paper-crypto.taker', 'mf.stamp', 'mf.exitload.none'].map((id) => term(ctx.db, id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ({ id: t.id, name: t.name, value: JSON.stringify(t.value), status: t.status, source: t.source }))
  terms.push({ id: 'lab.tax.model', name: 'Capital gains tax as modelled here: equity-oriented funds 20% within a year, 12.5% after (Rs 1.25 lakh a year exempt); international and gold funds of funds at the slab rate within two years, 12.5% after; debt-like funds at the slab rate; digital assets 30%, no loss set-off. Slab taken as 30%, 4% cess on all, no surcharge.', value: '', status: 'modelled', source: 'QED modelling of Indian rules as known to this agent; not verified against the Income-tax Act 2025 this session; not tax advice' })
  return { asOf: now, presentation: cfg.presentation, books: b, monitor: monitor(b, hs, now), allocation: allocation(ctx, userId, hs, now, policy), evaluation: evaluation(ctx.db, now), terms }
}

// ------------------------------------------------------------------------------------------------ certificates
const DICGC = 50_000_000
/** The household's own Save and Grow requests, each checked by the guarantee-or-abstain kernel. */
export function labCertificates(ctx: Ctx, userId: string, now: number, opts: { declared: boolean }): LabCertificates {
  const { db } = ctx
  const today = ist(now).date
  const { books: b, holdings: hs } = books(ctx, userId, now)
  const notes: string[] = []
  const due = commitments(db, userId, now, 30 * DAY).filter((c) => c.certain)
  const dueToday = due.filter((c) => ist(c.dueAt).date <= today)
  if (dueToday.length) notes.push(`${dueToday.length} payment${dueToday.length === 1 ? ' is' : 's are'} due today; nothing can be certified to pay ${dueToday.length === 1 ? 'it' : 'them'} in time, so ${dueToday.length === 1 ? 'it is' : 'they are'} left out and shown here instead.`)
  const progs = commitments(db, userId, now, 30 * DAY).filter((c) => !c.certain)
  if (progs.length) notes.push(`${progs.length} planned purchase${progs.length === 1 ? '' : 's'} by your instructions ${progs.length === 1 ? 'is' : 'are'} not obligations (you can stop them), so ${progs.length === 1 ? 'it is' : 'they are'} not in the reserve.`)
  const obligations = due.filter((c) => ist(c.dueAt).date > today).map((c, k) => ({ id: `${c.kind}-${k + 1}`, due: ist(c.dueAt).date, currency: 'INR', amount_minor: c.amount, payee: c.label, kind: 'payment' }))
  const declared = opts.declared
  const reserveBase = { type: 'reserve' as const, as_of: today, currency: 'INR', horizon_days: 30, obligations, positions: [], instruments: [], fees_declared: declared, taxes_declared: declared, settlement_bank: 'your paper bank account (simulated)' }
  const cases: LabCertificate[] = []
  const add = (c: Omit<LabCertificate, 'outcome'> & { request: Request }) => cases.push({ ...c, outcome: check(c.request) })
  // R13 (review L3): with nothing due, a reserve covers nothing, and the screen says so rather than "holds"
  if (!obligations.length) notes.push('Nothing on your books falls due in the next 30 days, so the reserves below have nothing to cover.')
  add({
    id: 'save-guarantee', pillar: 'save', basis: 'books', title: 'Everything due in the next 30 days, covered by construction',
    plain: 'Would rest on government bills maturing in time to pay each bill, not on a bank\'s promise; each payment would still pass through your bank for a few days.',
    assumptions: ['Your paper books hold no government bills, so nothing can count by construction.', declared ? 'You declared that every fee and tax due in the period is listed.' : 'You have not declared that every fee and tax due in the period is listed.'],
    request: { ...reserveBase, accept: ['by_construction'], bank_cash_minor: Math.max(0, b.bankAvailable), bank_name: 'your paper bank (simulated)', bank_insured_minor: DICGC },
  })
  add({
    id: 'save-bank', pillar: 'save', basis: 'books', title: 'Everything due in the next 30 days, from money already in your bank',
    plain: 'Holds if your bank honours your balance: a contractual promise of the bank, not a guarantee by construction.',
    assumptions: ['Payments go by UPI, which runs every day of the year, so no non-business-day buffer is applied.', 'Deposit insurance of Rs 5 lakh per depositor per bank (DICGC) is as declared here; it was not verified this session.', declared ? 'You declared that every fee and tax due in the period is listed.' : 'You have not declared that every fee and tax due in the period is listed.'],
    request: { ...reserveBase, accept: ['by_construction', 'contractual'], bank_cash_minor: Math.max(0, b.bankAvailable), bank_name: 'your paper bank (simulated)', bank_insured_minor: DICGC, max_nonbusiness_run_days: 0, payment_lead_business_days: 0 },
  })
  // Grow: the investments' worst month
  const invested = hs.filter((h) => h.value !== null && h.value > 0)
  if (invested.length) {
    const total = invested.reduce((s, h) => s + h.value!, 0)
    const crypto = invested.filter((h) => h.kind === 'crypto')
    const returns = crypto.length ? null : bookReturns(db, invested.map((h) => ({ id: h.instrumentId, weight: h.value! / total })))
    if (crypto.length) notes.push(`A model bound needs years of monthly prices for every holding; this app has recorded ${crypto.map((h) => h.name).join(' and ')} only while it has been running, so no model can be fitted.`)
    add({
      id: 'grow-cvar', pillar: 'grow', basis: 'books', title: 'Does a model put the average of your worst months under a 10% loss? (95% CVaR: an estimate, never a limit)',
      plain: 'Only a model could say this of investments that can fall, and a model bound is never a guarantee.',
      assumptions: ['Every investment here can lose up to its whole value within the month (limited liability, no leverage).', returns ? `Scenario returns: the book at today's weights over ${returns.months} recorded months.` : 'No scenario returns: not enough recorded history.'],
      request: { type: 'cvar', as_of: today, base_currency: 'INR', level: 0.95, horizon_end: isoOf(dayNum(today) + 30), threshold: 0.1, accept: ['by_construction', 'model_bound'], window: 60, model: 'fhs_ewma', scenario_source: returns ? `this book at today's weights, ${returns.from} to ${returns.to}` : '', scenario_returns: returns?.r ?? null, holdings: invested.map((h) => ({ id: h.name, value_minor: h.value!, currency: 'INR', kind: h.kind === 'crypto' ? 'equity_fund' : h.category === 'liquid' || h.category === 'overnight' ? 'money_market_fund' : 'equity_fund' })) },
    })
    const horizon = isoOf(dayNum(today) + 3 * 365)
    add({
      id: 'grow-principal', pillar: 'grow', basis: 'books', title: `What you have invested today is still there in three years (${horizon}), before tax`,
      plain: 'Needs a floor of government zero-coupon securities maturing by then; your books hold none.',
      assumptions: ['Nominal rupees, before tax: inflation is not protected.'],
      request: { type: 'principal', as_of: today, currency: 'INR', principal_minor: total, horizon, basis: 'nominal', tax_basis: 'before_tax', budget_minor: total, positions: [], instruments: [], risky: invested.map((h) => ({ id: h.name, value_minor: h.value!, currency: 'INR', limited_liability: true })) },
    })
    // what it would take, as an illustration: a GoI zero bought now at an indicative yield
    const y = 0.055, matDay = dayNum(horizon) - 4
    const lots = Math.ceil(total / 1_000_000), face = 1_000_000
    const price = Math.ceil((face / Math.pow(1 + y, (matDay - dayNum(today)) / 365)) * 1.001)
    add({
      id: 'grow-principal-floor', pillar: 'grow', basis: 'illustration', title: 'The same promise, if a government floor were bought (illustration)',
      plain: 'What it would take by construction. QED cannot buy government securities in this app, so this is an illustration, not an offer.',
      assumptions: [`An indicative price from a 5.50% yield (the RBI policy rate on 19 Oct 2026, BIS, used in the R11 study as a yield proxy; not a quote) plus 0.1%.`, 'Lots of Rs 10,000 face (to verify against RBI Retail Direct terms).', 'Only what the floor does not cost can stay invested; the risky part can be worth nothing.'],
      request: { type: 'principal', as_of: today, currency: 'INR', principal_minor: total, horizon, basis: 'nominal', tax_basis: 'before_tax', budget_minor: total, positions: [{ instrument_id: `IN-ZC-${isoOf(matDay)}`, lots, custody: 'RBI Retail Direct (Government securities account), not connected to this app', custody_kind: 'sovereign_registry', status: 'to_buy', limit_price_per_lot_minor: price }], instruments: [{ id: `IN-ZC-${isoOf(matDay)}`, kind: 'sovereign_zero', currency: 'INR', issuer: 'Government of India', issuer_is_currency_sovereign: true, maturity: isoOf(matDay), face_per_lot_minor: face, source: 'illustration: an indicative zero-coupon maturing four days before the horizon' }], risky: [] },
    })
  }
  return { asOf: now, declared, cases, notes }
}

/** Monthly returns of a book of funds at today's weights, over the months every fund has. */
function bookReturns(db: Db, legs: { id: string; weight: number }[]): { r: number[]; months: number; from: string; to: string } | null {
  const ends = legs.map((l) => { const s = series(db, l.id); if (!s) return null; const m = new Map<string, number>(); s.s.dates.forEach((d, i) => m.set(d.slice(0, 7), s.s.values[i]!)); return m })
  if (ends.some((e) => !e)) return null
  const months = [...ends[0]!.keys()].filter((m) => ends.every((e) => e!.has(m))).sort().slice(0, -1)
  if (months.length < 3) return null
  const r: number[] = []
  for (let k = 1; k < months.length; k++) r.push(legs.reduce((s, l, i) => s + l.weight * (ends[i]!.get(months[k]!)! / ends[i]!.get(months[k - 1]!)! - 1), 0))
  return { r, months: r.length, from: months[1]!, to: months[months.length - 1]! }
}

/** Replications times window that one certificate check may ask for (R13 review, R13). */
export const MAX_BOOTSTRAP_WORK = 600_000
/** The kernel on a caller's own request (wire format). Bounded in size; never throws on a malformed request. */
export function checkCertificate(body: unknown): Outcome {
  if (!body || typeof body !== 'object') throw bad('Send a request object: { "type": "reserve" | "principal" | "cvar", ... }.')
  const size = JSON.stringify(body).length
  if (size > 60_000) throw bad('That request is larger than this endpoint checks (60 KB).')
  const r = body as { type?: unknown; scenario_returns?: unknown; obligations?: unknown; positions?: unknown }
  if (Array.isArray(r.scenario_returns) && r.scenario_returns.length > 1200) throw bad('At most 1,200 scenario returns.')
  if ((Array.isArray(r.obligations) && r.obligations.length > 500) || (Array.isArray(r.positions) && r.positions.length > 500)) throw bad('At most 500 obligations and 500 positions.')
  const b = body as { bootstrap_reps?: unknown; window?: unknown }
  if (typeof b.bootstrap_reps === 'number' && b.bootstrap_reps > 5000) throw bad('At most 5,000 bootstrap replications.')
  // The bootstrap runs on the API's one thread: its work grows as replications times the window, and the largest the
  // bounds above allowed (5,000 x 1,176) held every other request for about 2.4 s (R13 review, R13). The kernel's own
  // defaults (2,000 x 120) are well inside this.
  const reps = typeof b.bootstrap_reps === 'number' ? b.bootstrap_reps : 2000, window = typeof b.window === 'number' ? b.window : 120
  if (r.type === 'cvar' && reps * window > MAX_BOOTSTRAP_WORK) throw bad(`At most ${MAX_BOOTSTRAP_WORK.toLocaleString('en-IN')} bootstrap replications times the window (for example 2,000 replications of a 300-scenario window).`)
  return check(body)
}

// ------------------------------------------------------------------------------------------------ a dollar liability
export function hedgeWhatIf(ctx: Ctx, body: unknown, now: number): LabHedge {
  const { db } = ctx
  const o = (body ?? {}) as { usd?: unknown; due?: unknown }
  const today = ist(now).date
  if (typeof o.usd !== 'number' || !Number.isFinite(o.usd) || o.usd < 100 || o.usd > 10_000_000) throw bad('Name a dollar amount from 100 to 10,000,000.', { usd: 'From USD 100 to USD 10,000,000.' })
  if (typeof o.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.due) || Number.isNaN(Date.parse(o.due))) throw bad('Name the date the dollars are due.', { due: 'A date, YYYY-MM-DD.' })
  const days = dayNum(o.due) - dayNum(today)
  if (days < 30 || days > 3 * 365) throw bad('Choose a due date between 30 days and three years from today.', { due: 'Between 30 days and three years from today.' })
  const usdCents = Math.round(o.usd * 100)
  const notes: string[] = []
  // unhedged: rupees set aside today in the liquid fund, converted on the due date, over every window the records allow
  const fx = series(db, 'ecb:USDINR'), lq = series(db, LIQUID)
  let fxView: LabHedge['fx'] = null, unhedged: LabHedge['unhedged'] = null
  if (fx) {
    const latest = fx.s.values[fx.s.values.length - 1]!
    const src = sourceText(fx.sources)
    const at = (s: Series, date: string): number | null => { let lo = 0, hi = s.dates.length - 1, ans = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.dates[mid]! <= date) { ans = mid; lo = mid + 1 } else hi = mid - 1 } return ans < 0 ? null : s.values[ans]! }
    const shortfalls: number[] = []
    for (let i = 0; i < fx.s.dates.length; i++) {
      const start = fx.s.dates[i]!, end = isoOf(dayNum(start) + days)
      if (end > fx.s.dates[fx.s.dates.length - 1]!) break
      const f0 = fx.s.values[i]!, f1 = at(fx.s, end)!
      const g = lq ? ((at(lq.s, end) ?? NaN) / (at(lq.s, start) ?? NaN)) : 1
      if (!Number.isFinite(g)) continue
      shortfalls.push(1 - g / (f1 / f0))
    }
    const fxText = fx.sources.has('frankfurter') ? 'ECB reference rates (via Frankfurter) recorded by this app; the first 400 days back-filled' : src.text.replace('NAVs', 'rates')
    fxView = { source: fxText, synthetic: src.synthetic, from: fx.s.dates[0]!, to: fx.s.dates[fx.s.dates.length - 1]!, latest, latestDate: fx.s.dates[fx.s.dates.length - 1]!, windows: shortfalls.length }
    if (shortfalls.length >= 30) {
      const sorted = [...shortfalls].sort((a, b) => b - a), k = Math.max(1, Math.round(0.05 * sorted.length))
      unhedged = { pShort: shortfalls.filter((x) => x > 0).length / shortfalls.length, mean: shortfalls.reduce((s, x) => s + x, 0) / shortfalls.length, cvar95: sorted.slice(0, k).reduce((s, x) => s + x, 0) / k, worst: sorted[0]!, growth: lq ? 'the liquid fund\'s recorded NAV' : 'nothing (no liquid fund NAVs recorded)' }
      notes.push('The windows overlap, so they are not independent observations; treat the share of shortfalls as a description of this record, not a probability.')
    } else notes.push(`This app has recorded ${fx.s.dates.length} days of the dollar's reference rate, enough for ${shortfalls.length} windows of ${days} days; at least 30 are needed to describe the unhedged risk here. The R11 study's 25-year table is shown instead.`)
  } else notes.push('This app has not recorded the dollar\'s reference rate, so the unhedged risk cannot be measured here. The R11 study\'s 25-year table is shown instead.')
  // hedged by construction: US Treasury bills maturing so their cash arrives before the funding deadline
  const sofr = db.get<{ value: string; value_date: string; source: string }>(`SELECT value, value_date, source FROM daily_values WHERE instrument_id = 'nyfed:SOFR' ORDER BY value_date DESC LIMIT 1`)
  const rate = sofr ? { source: sofr.source === 'synthetic' ? 'synthetic SOFR (presentation mode)' : 'SOFR, New York Fed, as recorded by this app', value: Number(sofr.value) / 100, date: sofr.value_date } : null
  const y = rate?.value ?? 0.0432
  if (!rate) notes.push('No US rate recorded here: the bill is priced at the 3-month Treasury yield of 4.32% (H.15, 20 Nov 2026) from the R11 study.')
  let mat = dayNum(o.due) - 13
  while (((mat + 3) % 7 + 7) % 7 !== 3) mat-- // the Thursday on or before (US bills mostly mature on Thursdays)
  const lots = Math.ceil(usdCents / 10_000)
  const price = 10_000 / (1 + (y * (mat - dayNum(today))) / 360)
  const limit = Math.ceil(price * 1.001)
  const request: Request = {
    type: 'reserve', as_of: today, currency: 'USD', horizon_days: days, obligations: [{ id: 'usd-liability', due: o.due, currency: 'USD', amount_minor: usdCents, payee: 'the dollar payment you named' }],
    positions: [{ instrument_id: `US-TB-${isoOf(mat)}`, lots, custody: 'a US custodian (not available in this app)', custody_kind: 'custodian', status: 'to_buy', limit_price_per_lot_minor: limit }],
    instruments: [{ id: `US-TB-${isoOf(mat)}`, kind: 'sovereign_zero', currency: 'USD', issuer: 'United States Treasury', issuer_is_currency_sovereign: true, maturity: isoOf(mat), face_per_lot_minor: 10_000, source: 'indicative: a weekly Thursday grid and a money-market price from the rate shown; not a quote' }],
    settlement_bank: 'a dollar payment account (not held in this app)', bank_insured_minor: 0,
  }
  const costUsd = lots * limit
  notes.push('QED cannot buy US Treasury bills or hold dollars at a US custodian in this app. The on-chain wallet\'s test dollars have no value and hedge nothing.')
  return {
    usd: o.usd, due: o.due, days, fx: fxView, unhedged,
    hedged: { maturity: isoOf(mat), lots, limitPerLot: limit, costUsd, costInr: fxView ? Math.round(costUsd * fxView.latest * 1.0025) : null, rate },
    certificate: check(request), notes,
  }
}
