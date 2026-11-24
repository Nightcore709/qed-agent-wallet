/**
 * The Portfolio lab (server/lab.ts) on a test household: two index funds and bitcoin bought in lots, recorded NAV
 * histories, bills due. All prices and NAVs here are SYNTHETIC fixtures that exercise the arithmetic; none is market data.
 */
import { describe, expect, it } from 'vitest'
import { requestHash, type Request } from '../shared/kernel/coverage.ts'
import fixtures from '../shared/kernel/coverage.fixtures.json'
import { addDays, ist } from './core.ts'
import { ensureAccount, openLot, post } from './ledger.ts'
import { checkCertificate, evaluation, hedgeWhatIf, labCertificates, labResearch, labView, optimiseMix, proposeRebalance } from './lab.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'

const DAY = 86_400_000
/** Hold `units` (thousandths) of a fund bought `daysAgo` for `cost` paise, as the paper fund registrar would book it. */
function holdFund(k: Kit, id: string, units: bigint, cost: bigint, daysAgo: number): void {
  const base = id.replace('amfi:', 'MF:')
  ensureAccount(k.db, k.userId, `pos:${id}`, 'asset', base, `Units of ${id}`, true)
  ensureAccount(k.db, k.userId, `trade:${base}`, 'trading', base, `${base} exchanged`, false)
  const ts = T0 - daysAgo * DAY
  const e = post(k.db, { userId: k.userId, ts, kind: 'buy', ref: `seed:${id}:${daysAgo}`, memo: 'seed', lines: [{ account: `pos:${id}`, amount: units }, { account: `trade:${base}`, amount: -units }, { account: 'trade:INR', amount: cost }, { account: 'bank', amount: -cost }] })
  openLot(k.db, k.userId, id, units, cost, ts, e.id)
}
/** A deterministic NAV path for every weekday of the last `days` days, ending at `last`. */
function navHistory(k: Kit, id: string, days: number, drift: number, wiggle: number, last: number): void {
  const today = ist(T0).date
  const pts: [string, number][] = []
  for (let d = days; d >= 1; d--) {
    const date = addDays(today, -d)
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (wd === 0 || wd === 6) continue
    pts.push([date, Math.exp(drift * (days - d) + wiggle * Math.sin(d / 3 + drift * 1000) + 0.3 * wiggle * Math.cos(d / 11))])
  }
  const scale = last / pts[pts.length - 1]![1]
  for (const [date, v] of pts) k.nav(id, date, (v * scale).toFixed(4))
}
function household(): Kit {
  const k = makeKit()
  navHistory(k, 'amfi:120716', 1100, 0.0004, 0.02, 250)
  navHistory(k, 'amfi:122639', 1100, 0.0005, 0.025, 80)
  navHistory(k, 'amfi:119788', 1100, 0.0003, 0.015, 30)
  navHistory(k, 'amfi:120684', 1100, 0.0004, 0.03, 70)
  navHistory(k, 'amfi:148381', 1100, 0.0005, 0.02, 20)
  navHistory(k, 'amfi:118701', 1100, 0.00018, 0.0002, 6000)
  // Nifty 50 bought 400 days ago at a third of today's NAV; the flexi fund 100 days ago
  holdFund(k, 'amfi:120716', 400_000n, 3_400_000n, 400) // 400 units, cost Rs 34,000, worth Rs 1,00,000 at 250
  holdFund(k, 'amfi:122639', 500_000n, 3_800_000n, 100) // 500 units, cost Rs 38,000, worth Rs 40,000 at 80
  return k
}

describe('the lab on a household', () => {
  it('reads the books: values, weights, lots and their tax classes, concentration and liquidity', () => {
    const k = household()
    const v = labView(k.ctx, { presentation: false }, k.userId, T0)
    const h = Object.fromEntries(v.books.holdings.map((x) => [x.instrumentId, x]))
    expect(h['amfi:120716']!.value).toBe(10_000_000)
    expect(h['amfi:122639']!.value).toBe(4_000_000)
    expect(h['amfi:120716']!.weight).toBeCloseTo(10 / 14, 12)
    expect(h['amfi:120716']!.lots[0]!.taxClass).toMatch(/equity-oriented fund, long-term/)
    expect(h['amfi:122639']!.lots[0]!.taxClass).toMatch(/short-term/)
    expect(v.monitor.concentration.effectiveN).toBeCloseTo(1 / ((10 / 14) ** 2 + (4 / 14) ** 2), 10)
    expect(v.monitor.concentration.byFundHouse.map((x) => x.house).sort()).toEqual(['PPFAS', 'UTI'])
    expect(v.monitor.liquidity.steps[2]!.amount).toBe(v.books.bankAvailable + 14_000_000) // both pay out in two business days
  })
  it('equal shares with a 5-point band: out of balance by 21 points, the sale is taxed lot by lot as modelled', () => {
    const k = household()
    const a = labView(k.ctx, { presentation: false }, k.userId, T0).allocation
    expect(a.legs.map((l) => l.target)).toEqual([0.5, 0.5])
    expect(a.outside).toBe(true)
    expect(a.drift).toBeCloseTo(10 / 14 - 0.5, 12)
    const sell = a.trades.find((t) => t.side === 'sell')!
    expect(sell.instrumentId).toBe('amfi:120716')
    expect(sell.amount).toBe(3_000_000) // to Rs 70,000 each
    // the lot is long-term: gain on Rs 30,000 of a Rs 1,00,000 holding that cost Rs 34,000 = Rs 19,800, inside the Rs 1.25 lakh exemption
    expect(sell.realisedGain).toBe(1_980_000)
    expect(sell.tax).toBe(0)
    expect(a.trades.find((t) => t.side === 'buy')!.fee).toBe(Math.ceil(3_000_000 * 0.00005))
    expect(a.params).toEqual({ legs: [{ instrumentId: 'amfi:120716', weightBps: 5000 }, { instrumentId: 'amfi:122639', weightBps: 5000 }], bandBps: 500, schedule: { type: 'daily', at: '11:00' } })
  })
  it('the walk-forward on recorded NAVs: four baselines, out of sample, net of stamp duty, each optimum certified', () => {
    const k = household()
    const e = evaluation(k.db, T0)
    if ('error' in e) throw new Error(e.error)
    expect(e.strategies.map((s) => s.id)).toEqual(['EW', 'B6040', 'RP', 'MINV'])
    expect(e.months.length).toBeGreaterThan(20)
    expect(e.months.every((m) => m < '2026-11')).toBe(true) // the month in progress is left out
    expect(e.source).toMatch(/values recorded by this app/)
    for (const s of e.strategies.filter((x) => x.id !== 'EW')) expect(s.vsEW).not.toBeNull()
    expect(e.strategies.find((s) => s.id === 'MINV')!.cert.kktResidual!).toBeLessThan(1e-9)
    expect(e.strategies.find((s) => s.id === 'RP')!.cert.maxRiskContributionDeviation!).toBeLessThan(1e-8)
    expect(e.verdict).toMatch(/months/)
    for (const s of e.strategies.filter((x) => x.vsEW)) expect(s.vsEW!.tooShort).toBe(e.months.length < 36)
  })
  it('opens the mix as a proposal and a draft instruction, and trades nothing', () => {
    const k = household()
    const p = proposeRebalance(k.ctx, { adviserReview: false }, k.userId, T0)
    expect(k.db.get('SELECT origin, kind, state FROM proposals WHERE id = ?', p.proposalId)).toEqual({ origin: 'rules', kind: 'rebalance', state: 'drafted' })
    expect(k.db.get<{ state: string; kind: string }>('SELECT state, kind FROM programs WHERE id = ?', p.programId)).toEqual({ state: 'draft', kind: 'rebalance' })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', k.userId)!.n).toBe(0)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL', k.userId)!.n).toBe(0)
    // a second mix is not proposed while one exists
    expect(() => proposeRebalance(k.ctx, { adviserReview: false }, k.userId, T0)).toThrow(/already have/)
  })
  it('nothing to balance with one holding or none', () => {
    const k = makeKit()
    const a = labView(k.ctx, { presentation: false }, k.userId, T0).allocation
    expect([a.proposable, a.why]).toEqual([false, 'You hold nothing that can grow yet, so there is no mix to keep in balance.'])
    expect(() => proposeRebalance(k.ctx, { adviserReview: false }, k.userId, T0)).toThrow(/nothing that can grow/)
  })
})

describe('the allocator (R13, G6): risk parity and minimum variance proposed as a draft, never traded', () => {
  it('equal shares stay the default; the optimisers are chosen, not assumed', () => {
    const k = household()
    expect(labView(k.ctx, { presentation: false }, k.userId, T0).allocation.policy).toBe('equal')
    expect(labView(k.ctx, { presentation: false }, k.userId, T0).allocation.evidence).toBeUndefined()
  })
  it('risk parity: shares from the last year of recorded NAVs, with the solve\'s certificate, the out-of-sample result and the study\'s caveats', () => {
    const k = household()
    const a = labView(k.ctx, { presentation: false }, k.userId, T0, 'riskparity').allocation
    expect(a.policy).toBe('riskparity')
    expect(a.params!.legs.reduce((s, l) => s + l.weightBps, 0)).toBe(10_000)
    expect(a.legs.map((l) => l.target).every((t) => t > 0 && t < 1)).toBe(true)
    const e = a.evidence!
    expect(e.certified).toBe(true)
    expect(e.certificate.maxRiskContributionDeviation!).toBeLessThan(1e-6)
    expect(e.window.observations).toBeGreaterThanOrEqual(100)
    expect(e.outOfSample.text).toMatch(/recorded months/)
    expect(e.study.text).toMatch(/R11 study.*not statistically distinguishable|R11 study.*Sharpe ratio/)
    expect(e.caveats.join(' ')).toMatch(/say nothing about future returns/)
    expect(e.caveats.join(' ')).toMatch(/no optimiser beat equal weight/)
    // the figures quoted from the study are the recorded ones
    const rp = (labResearch() as { core: { strategies: { id: string; sharpe: number }[] } }).core.strategies.find((x) => x.id === 'RP_LW')!
    expect(e.study.sharpe).toBe(rp.sharpe)
  })
  it('minimum variance is certified when it is proposable, and refused in words when it would put everything in one investment', () => {
    const k = household()
    const a = labView(k.ctx, { presentation: false }, k.userId, T0, 'minvar').allocation
    expect(a.policy).toBe('minvar')
    if (a.params) { expect(a.evidence!.certified).toBe(true); expect(a.params.legs.reduce((s, l) => s + l.weightBps, 0)).toBe(10_000) }
    else expect(a.why).toMatch(/one investment|nothing|recorded/)
  })
  it('proposes the chosen mix as a draft instruction carrying its evidence; nothing is approved, ordered or traded', () => {
    const k = household()
    const p = proposeRebalance(k.ctx, { adviserReview: false }, k.userId, T0, 'riskparity')
    const row = k.db.get<{ rationale: string; params_json: string; state: string }>('SELECT rationale, params_json, state FROM proposals WHERE id = ?', p.proposalId)!
    expect(row.state).toBe('drafted')
    expect(row.rationale).toMatch(/Risk parity/)
    expect(row.rationale).toMatch(/optimality check/)
    expect(row.rationale).toMatch(/Nothing trades until you sign/)
    expect(row.rationale).toMatch(/not advice/)
    expect(row.rationale).toMatch(/R11 study/)
    expect(row.rationale).toMatch(/Out of sample/)
    expect(k.db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', p.programId)!.state).toBe('draft')
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', k.userId)!.n).toBe(0)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM pv_orders WHERE user_id = ?', k.userId)!.n).toBe(0)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL', k.userId)!.n).toBe(0)
  })
  it('an investment with no recorded value history cannot be optimised: it says so instead of guessing', () => {
    const k = household()
    const r = optimiseMix(k.db, ['amfi:120716', 'coindcx:BTCINR'], 'riskparity')
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/no recorded value history/) })
    // too little shared history
    const short = makeKit()
    navHistory(short, 'amfi:120716', 70, 0.0004, 0.02, 250)
    navHistory(short, 'amfi:122639', 70, 0.0005, 0.025, 80)
    expect(optimiseMix(short.db, ['amfi:120716', 'amfi:122639'], 'minvar')).toMatchObject({ ok: false, why: expect.stringMatching(/daily returns/) })
  })
})

describe('certificates for the household\'s own requests', () => {
  it('Save: no guarantee by construction from a bank balance; a contractual one when the bank covers; nothing without the declaration', () => {
    const k = household()
    const ts = T0 + 3 * DAY
    k.db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_power', ?, 'City Power', 'power@upi', 'utility', ?)`, k.userId, T0)
    k.db.run(`INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES ('bil_1', ?, 'pay_power', 245000, ?, 'Electricity', 'due', ?)`, k.userId, ts, T0)
    const undeclared = labCertificates(k.ctx, k.userId, T0, { declared: false })
    expect(undeclared.cases.find((c) => c.id === 'save-bank')!.outcome.reasons.map((r) => r.code).sort()).toEqual(['FEES_NOT_DECLARED', 'TAXES_NOT_DECLARED'])
    const c = labCertificates(k.ctx, k.userId, T0, { declared: true })
    const byId = Object.fromEntries(c.cases.map((x) => [x.id, x]))
    expect(byId['save-guarantee']!.outcome.status).toBe('ABSTAIN')
    expect(byId['save-guarantee']!.outcome.reasons.map((r) => r.code)).toContain('BANK_CASH_NOT_BY_CONSTRUCTION')
    expect(byId['save-bank']!.outcome.status).toBe('CERTIFIED_CONTRACTUAL')
    expect(byId['grow-cvar']!.outcome.status).toBe('ABSTAIN')
    expect(byId['grow-principal']!.outcome.reasons.map((r) => r.code)).toEqual(['FLOOR_SHORT'])
    expect(byId['grow-principal-floor']!.outcome.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(byId['grow-principal-floor']!.basis).toBe('illustration')
    // every certificate is bound to the exact request it answers
    for (const x of c.cases) expect(x.outcome.request_hash).toBe(requestHash(x.request as Request))
  })
  it('the check endpoint answers any request in the wire format, as the recorded research case was answered', () => {
    const rec = (fixtures.recorded as { name: string; request: unknown; expect: { status: string; request_hash: string } }[]).find((c) => c.name === 'usd_tuition')!
    const o = checkCertificate(rec.request)
    expect([o.status, o.request_hash]).toEqual([rec.expect.status, rec.expect.request_hash])
    expect(checkCertificate({ type: 'reserve' }).status).toBe('ABSTAIN')
    expect(() => checkCertificate(null)).toThrow(/request object/)
    expect(() => checkCertificate({ type: 'cvar', scenario_returns: new Array(1300).fill(0) })).toThrow(/1,200/)
  })
  it('the research evidence carries the file hashes it came from', () => {
    const r = labResearch() as { source: { files: { path: string; sha256: string }[] }; core: { months: number } }
    expect(r.core.months).toBe(656)
    expect(r.source.files.length).toBeGreaterThan(10)
    expect(r.source.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
  })
})

describe('a dollar liability', () => {
  it('measures the unhedged risk on recorded rates and certifies the bill hedge by construction', () => {
    const k = household()
    navHistory(k, 'ecb:USDINR', 700, 0.00008, 0.01, 92.5)
    const h = hedgeWhatIf(k.ctx, { usd: 25_000, due: addDays(ist(T0).date, 200) }, T0)
    expect(h.fx!.windows).toBeGreaterThanOrEqual(30)
    expect(h.unhedged).not.toBeNull()
    expect(h.unhedged!.pShort).toBeGreaterThanOrEqual(0)
    expect(h.hedged.lots).toBe(250)
    expect(h.certificate.status).toBe('CERTIFIED_BY_CONSTRUCTION')
    expect(h.notes.join(' ')).toMatch(/cannot buy US Treasury bills/)
  })
  it('refuses what it cannot answer', () => {
    const k = makeKit()
    expect(() => hedgeWhatIf(k.ctx, { usd: 5, due: '2027-06-01' }, T0)).toThrow(/dollar amount/)
    expect(() => hedgeWhatIf(k.ctx, { usd: 25_000, due: addDays(ist(T0).date, 10) }, T0)).toThrow(/between 30 days/)
    const h = hedgeWhatIf(k.ctx, { usd: 25_000, due: addDays(ist(T0).date, 120) }, T0)
    expect(h.unhedged).toBeNull()
    expect(h.notes.join(' ')).toMatch(/not recorded the dollar/)
  })
})
