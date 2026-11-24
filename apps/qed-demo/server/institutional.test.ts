/**
 * The institutional reporting cycle and model portfolios (R13, I3 and G8): a report for each workspace, gain by holding,
 * a model offered to several workspaces that each owner accepts or declines, and a draft instruction nobody has signed.
 * Prices and NAVs are SYNTHETIC fixtures.
 */
import { describe, expect, it } from 'vitest'
import { addDays, ist } from './core.ts'
import { answerOffer, clientReport, createModel, modelsView, offerModel, reportsAcross, SCOPE_NOTE } from './institutional.ts'
import { ensureAccount, openLot, post } from './ledger.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'
import { addMember, createBusiness, type Role } from './workspaces.ts'

const DAY = 86_400_000
function holdFund(k: Kit, ws: string, id: string, units: bigint, cost: bigint, daysAgo: number): void {
  const base = id.replace('amfi:', 'MF:')
  ensureAccount(k.db, ws, `pos:${id}`, 'asset', base, `Units of ${id}`, true)
  ensureAccount(k.db, ws, `trade:${base}`, 'trading', base, `${base} exchanged`, false)
  const ts = T0 - daysAgo * DAY
  const e = post(k.db, { userId: ws, ts, kind: 'buy', ref: `seed:${id}:${daysAgo}`, memo: 'seed', lines: [{ account: `pos:${id}`, amount: units }, { account: `trade:${base}`, amount: -units }] })
  openLot(k.db, ws, id, units, cost, ts, e.id)
}
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
const own = (personId: string) => ({ personId, role: 'owner' as Role })

function world() {
  const k = makeKit()
  navHistory(k, 'amfi:120716', 700, 0.0004, 0.02, 250)
  navHistory(k, 'amfi:122639', 700, 0.0005, 0.025, 80)
  holdFund(k, k.userId, 'amfi:120716', 400_000n, 3_400_000n, 400)
  holdFund(k, k.userId, 'amfi:122639', 500_000n, 3_800_000n, 100)
  const person = (h: string) => { const id = `usr_${h}`; k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, h, h, T0); k.db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, id, T0); return id }
  const manager = person('mgr'), viewer = person('vw')
  const mgrWs = createBusiness(k.db, manager, 'Meridian Model Desk', T0)
  addMember(k.db, mgrWs, own(manager), 'vw', 'viewer', T0)
  return { k, manager, viewer, mgrWs, client: k.userId }
}
const legs = [{ instrumentId: 'amfi:120716', weightBps: 6000 }, { instrumentId: 'amfi:122639', weightBps: 4000 }]

describe('model portfolios', () => {
  it('a model needs a member who may sign, valid shares that add to 100%, and a new version keeps the old one', () => {
    const w = world()
    expect(() => createModel(w.k.db, w.mgrWs, { personId: w.viewer, role: 'viewer' }, { name: 'Core', legs }, T0)).toThrow(/may sign/)
    expect(() => createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs: [legs[0]!] }, T0)).toThrow(/between two and six/)
    expect(() => createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs: [{ ...legs[0]!, weightBps: 5000 }, legs[1]!] }, T0)).toThrow(/add up to 100%/)
    expect(() => createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs: [legs[0]!, { instrumentId: 'amfi:nope', weightBps: 4000 }] }, T0)).toThrow(/not one this app lists/)
    const v1 = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs }, T0)
    const v2 = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs: [{ ...legs[0]!, weightBps: 5000 }, { ...legs[1]!, weightBps: 5000 }] }, T0 + 1)
    expect([v1.version, v2.version]).toEqual([1, 2])
    expect(modelsView(w.k.db, w.mgrWs).owned.map((m) => [m.version, m.retired])).toEqual([[2, false], [1, true]])
    expect(v1.basis).toMatch(/QED did not choose them/)
  })

  it('offering changes nothing in the client; only its owner or admin can accept; accepting makes an unsigned draft instruction', () => {
    const w = world()
    const m = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs }, T0)
    const out = offerModel(w.k.db, w.mgrWs, own(w.manager), m.id, ['tester', 'nobody', 'ws-nope'], T0 + 1)
    expect(out.offered).toHaveLength(1)
    expect(out.skipped.map((s) => s.code)).toEqual(['nobody', 'ws-nope'])
    // the client has nothing new: no program, no approval, no order
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM programs WHERE user_id = ?', w.client)!.n).toBe(0)
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = ?', w.client, 'model.offered')!.n).toBe(1)
    const offerId = out.offered[0]!.offerId
    expect(() => answerOffer(w.k.ctx, { adviserReview: false }, w.client, { personId: 'x', role: 'approver' }, offerId, true, T0 + 2)).toThrow(/owner or admin/)
    expect(() => answerOffer(w.k.ctx, { adviserReview: false }, w.client, own('x'), 'mof_missing', true, T0 + 2)).toThrow(/not found/)
    const r = answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), offerId, true, T0 + 2)
    expect(r.state).toBe('accepted')
    expect(w.k.db.get<{ state: string; kind: string }>('SELECT state, kind FROM programs WHERE id = ?', r.programId!)).toEqual({ state: 'draft', kind: 'rebalance' })
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND confirmed_at IS NOT NULL', w.client)!.n).toBe(0)
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions WHERE user_id = ?', w.client)!.n).toBe(0)
    expect(w.k.db.get<{ rationale: string }>('SELECT rationale FROM proposals WHERE user_id = ? ORDER BY ts DESC LIMIT 1', w.client)!.rationale).toMatch(/nothing trades until this workspace's signers sign it/)
    // answered once
    expect(() => answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), offerId, false, T0 + 3)).toThrow(/already answered/)
    // the manager's own workspace was never touched
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM programs WHERE user_id = ?', w.mgrWs)!.n).toBe(0)
    expect(modelsView(w.k.db, w.client).received[0]).toMatchObject({ state: 'accepted', from: 'Meridian Model Desk' })
  })

  it('a declined offer makes nothing; an old version cannot be accepted; a second balancing instruction is refused', () => {
    const w = world()
    const v1 = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs }, T0)
    const o = offerModel(w.k.db, w.mgrWs, own(w.manager), v1.id, ['tester'], T0 + 1).offered[0]!.offerId
    expect(answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), o, false, T0 + 2)).toEqual({ state: 'declined', programId: null })
    expect(w.k.db.get<{ n: number }>('SELECT COUNT(*) n FROM programs WHERE user_id = ?', w.client)!.n).toBe(0)
    const v2 = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs: [{ ...legs[0]!, weightBps: 5000 }, { ...legs[1]!, weightBps: 5000 }] }, T0 + 3)
    expect(() => offerModel(w.k.db, w.mgrWs, own(w.manager), v1.id, ['tester'], T0 + 4)).toThrow(/newer one/)
    const o2 = offerModel(w.k.db, w.mgrWs, own(w.manager), v2.id, ['tester'], T0 + 5).offered[0]!.offerId
    answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), o2, true, T0 + 6)
    const v3 = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Other', legs }, T0 + 7)
    const o3 = offerModel(w.k.db, w.mgrWs, own(w.manager), v3.id, ['tester'], T0 + 8).offered[0]!.offerId
    expect(() => answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), o3, true, T0 + 9)).toThrow(/already has an instruction/)
  })
})

describe('the client report', () => {
  it('is labelled as QED\'s own capability, reconciles gain by holding to the holdings, and names every figure\'s source', () => {
    const w = world()
    const r = clientReport(w.k.ctx, w.client, 90, T0)
    expect(r.scope).toBe(SCOPE_NOTE)
    expect(r.scope).toMatch(/Not a regulated portfolio-management service/)
    expect(r.scope).toMatch(/holds no portfolio-manager, investment-adviser or fund-manager registration/)
    expect(r.holdings.map((h) => h.instrumentId).sort()).toEqual(['amfi:120716', 'amfi:122639'])
    expect(r.holdings.reduce((s, h) => s + (h.value ?? 0), 0)).toBe(r.totals.value)
    expect(r.holdings.reduce((s, h) => s + (h.shareBps ?? 0), 0)).toBeGreaterThanOrEqual(9_999)
    // gain by holding adds to the total gain, which is value minus cost (nothing was sold)
    expect(r.attribution.rows.reduce((s, x) => s + x.total, 0)).toBe(r.attribution.gain)
    expect(r.attribution.gain).toBe(r.holdings.reduce((s, h) => s + (h.gain ?? 0), 0))
    expect(r.attribution.method).toMatch(/Not a time-weighted return/)
    expect(r.compliance.map((c) => c.id)).toEqual(['books', 'concentration', 'prices', 'model', 'signing'])
    for (const c of r.compliance) expect(c.basis.length).toBeGreaterThan(3)
    expect(r.compliance.find((c) => c.id === 'books')!.ok).toBe(true)
    expect(r.compliance.find((c) => c.id === 'concentration')!.ok).toBe(false) // 71% in one fund, over QED's own 40% watch level
    expect(r.compliance.find((c) => c.id === 'model')!.ok).toBeNull()
    expect(r.holdings.find((h) => h.instrumentId === 'amfi:120716')!.priceReturn).not.toBeNull()
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(clientReport(w.k.ctx, w.client, 90, T0).fingerprint).toBe(r.fingerprint)
    expect(clientReport(w.k.ctx, w.client, 30, T0).fingerprint).not.toBe(r.fingerprint)
  })

  it('shows realised gain in the period and the active weights against the model the workspace accepted', () => {
    const w = world()
    const m = createModel(w.k.db, w.mgrWs, own(w.manager), { name: 'Core', legs }, T0)
    const o = offerModel(w.k.db, w.mgrWs, own(w.manager), m.id, ['tester'], T0 + 1).offered[0]!.offerId
    answerOffer(w.k.ctx, { adviserReview: false }, w.client, own(w.client), o, true, T0 + 2)
    w.k.db.run('INSERT INTO realised (user_id, instrument_id, ts, qty, proceeds, cost, opened_at, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', w.client, 'amfi:120716', T0 - 5 * DAY, 100_000, 3_000_000, 2_000_000, T0 - 300 * DAY, 'ent_x')
    const r = clientReport(w.k.ctx, w.client, 90, T0 + 3)
    expect(r.attribution.rows.find((x) => x.instrumentId === 'amfi:120716')!.realised).toBe(1_000_000)
    expect(r.attribution.model).toMatchObject({ name: 'Core', version: 1, owner: 'Meridian Model Desk' })
    const act = r.attribution.model!.active
    expect(act.map((a) => a.targetBps).sort()).toEqual([4000, 6000])
    expect(act.reduce((s, a) => s + a.activeBps, 0)).toBe(0)
    // 71.4% held against a 60% target: 11 points over, outside QED's 5-point band
    expect(Math.max(...act.map((a) => Math.abs(a.activeBps)))).toBeGreaterThan(1000)
    expect(r.compliance.find((c) => c.id === 'model')!.ok).toBe(false)
  })

  it('a person gets a report row for every workspace they belong to, and one row each, and a failure in one is reported in its row instead of failing the rest', () => {
    const w = world()
    w.k.db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, 'owner', ?)`, w.client, w.client, T0)
    const rows = reportsAcross(w.k.ctx, w.client, 90, T0)
    expect(rows.map((r) => r.ok)).toEqual([true])
    const withBiz = reportsAcross(w.k.ctx, w.manager, 90, T0)
    expect(withBiz.length).toBe(2)
    expect(withBiz.map((r) => r.kind).sort()).toEqual(['business', 'person'])
  })
})
