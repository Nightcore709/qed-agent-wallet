/**
 * Netting between workspaces (R13, I2): claims both sides agree, a cycle whose terms are fixed and checked again, a payment each
 * payer signs under its own signing policy (bands and limits), and one all-or-nothing settlement in the paper bank.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval, signApproval } from './approvals.ts'
import { type Db } from './core.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'
import { balance, verifyLedger } from './ledger.ts'
import { agreeCycle, answerClaim, buildTerms, cancelCycle, cycleView, nettingView, preparePayment, proposeClaim, proposeCycle, settleIfReady, settlementPayments, verifyTerms, withdrawClaim } from './netting.ts'
import { makeKit, T0 } from './testkit.ts'
import { addMember, createBusiness, type Role, setPolicy } from './workspaces.ts'

const LAKH = 10_000_000
const sig = (personId: string, role: Role) => ({ personId, role, credentialId: `cred-${personId}`, evidence: { by: personId }, sessionHash: 'h'.repeat(64) })

function world() {
  const k = makeKit({ user: false })
  const db: Db = k.db
  const person = (handle: string): string => {
    const id = `usr_${handle}`
    db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, handle, handle, T0)
    db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, id, T0)
    return id
  }
  const asha = person('asha'), ravi = person('ravi'), meera = person('meera'), zoya = person('zoya')
  const biz = (name: string, by: string, bank = DEFAULT_OPENING.bank) => {
    const id = createBusiness(db, by, name, T0)
    openHousehold(db, id, { ...DEFAULT_OPENING, bank }, {}, T0)
    return { id, code: db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', id)!.handle }
  }
  const A = biz('Asha Traders', asha), B = biz('Ravi Exports', ravi), C = biz('Zoya Mills', zoya)
  addMember(db, B.id, { personId: ravi, role: 'owner' }, 'meera', 'approver', T0)
  const own = (p: string) => ({ personId: p, role: 'owner' as Role })
  /** A records "the other owes me", the other agrees. */
  const claim = (from: { id: string; code: string }, fromP: string, to: { id: string; code: string }, toP: string, dir: 'owed-to-me' | 'i-owe', paise: number, memo = 'invoice') => {
    const c = proposeClaim(db, from.id, own(fromP), { counterparty: to.code, direction: dir, amountPaise: paise, memo }, T0)
    return answerClaim(db, to.id, own(toP), c.id, true, T0 + 1)
  }
  return { k, db, asha, ravi, meera, zoya, A, B, C, own, claim }
}

describe('arithmetic', () => {
  it('nets two workspaces to one payment, and the checks fail on any tampering', () => {
    const t = buildTerms([{ id: 'c1', creditor: 'A', debtor: 'B', paise: 500, memo: 'x' }, { id: 'c2', creditor: 'B', debtor: 'A', paise: 320, memo: 'y' }], ['A', 'B'])
    expect(t.positions).toEqual({ A: 180, B: -180 })
    expect(t.payments).toEqual([{ from: 'B', to: 'A', paise: 180 }])
    expect(t).toMatchObject({ grossPaise: 820, paidPaise: 180, savedPaise: 640 })
    expect(verifyTerms(t)).toEqual([])
    expect(verifyTerms({ ...t, payments: [{ from: 'B', to: 'A', paise: 181 }] }).length).toBeGreaterThan(0)
    expect(verifyTerms({ ...t, positions: { A: 181, B: -181 } }).length).toBeGreaterThan(0)
    expect(verifyTerms({ ...t, payments: [{ from: 'A', to: 'B', paise: 180 }] }).length).toBeGreaterThan(0)
  })

  it('a ring of three debts nets to nothing; positions always add to nothing and the payments clear them (pseudo-random cases)', () => {
    const ring = buildTerms([{ id: '1', creditor: 'A', debtor: 'B', paise: 100, memo: '' }, { id: '2', creditor: 'B', debtor: 'C', paise: 100, memo: '' }, { id: '3', creditor: 'C', debtor: 'A', paise: 100, memo: '' }], ['A', 'B', 'C'])
    expect(ring.payments).toEqual([])
    expect(ring.savedPaise).toBe(300)
    let seed = 20261124
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return Math.floor((seed / 4294967296) * n) }
    for (let trial = 0; trial < 300; trial++) {
      const ps = ['P0', 'P1', 'P2', 'P3', 'P4'].slice(0, 2 + rnd(4))
      const claims = Array.from({ length: 1 + rnd(12) }, (_, i) => { const c = ps[rnd(ps.length)]!; let d = ps[rnd(ps.length)]!; if (d === c) d = ps[(ps.indexOf(c) + 1) % ps.length]!; return { id: `c${i}`, creditor: c, debtor: d, paise: 1 + rnd(1_000_000), memo: '' } })
      const t = buildTerms(claims, ps)
      expect(verifyTerms(t)).toEqual([])
      expect(t.payments.length).toBeLessThanOrEqual(ps.length - 1)
      expect(t.paidPaise).toBeLessThanOrEqual(t.grossPaise)
    }
    expect(settlementPayments({ A: 0, B: 0 })).toEqual([])
  })
})

describe('claims', () => {
  it('both sides must agree; the one who recorded it cannot agree to it; a declined claim is never netted', () => {
    const w = world()
    const c = proposeClaim(w.db, w.A.id, w.own(w.asha), { counterparty: w.B.code, direction: 'owed-to-me', amountPaise: 3 * LAKH, memo: 'Invoice 14' }, T0)
    expect(c).toMatchObject({ creditor_ws: w.A.id, debtor_ws: w.B.id, state: 'proposed' })
    expect(() => answerClaim(w.db, w.A.id, w.own(w.asha), c.id, true, T0)).toThrow(/other workspace has to agree/)
    expect(() => answerClaim(w.db, w.B.id, { personId: w.ravi, role: 'operator' }, c.id, true, T0)).toThrow(/may sign/)
    expect(answerClaim(w.db, w.B.id, w.own(w.ravi), c.id, true, T0 + 1).state).toBe('agreed')
    const d = proposeClaim(w.db, w.A.id, w.own(w.asha), { counterparty: w.B.code, direction: 'i-owe', amountPaise: LAKH, memo: 'Disputed freight' }, T0)
    expect(answerClaim(w.db, w.B.id, w.own(w.ravi), d.id, false, T0 + 1).state).toBe('declined')
    const cycle = proposeCycle(w.db, w.A.id, w.own(w.asha), [w.B.code], T0 + 2)
    expect(cycle.claims).toHaveLength(1)
    expect(cycle.paidPaise).toBe(3 * LAKH)
  })

  it('refuses a claim against oneself, an unknown or unopened workspace, a bad amount, and a viewer', () => {
    const w = world()
    const base = { counterparty: w.B.code, direction: 'owed-to-me', amountPaise: LAKH, memo: 'x for y' }
    expect(() => proposeClaim(w.db, w.A.id, w.own(w.asha), { ...base, counterparty: w.A.code }, T0)).toThrow(/cannot owe itself/)
    expect(() => proposeClaim(w.db, w.A.id, w.own(w.asha), { ...base, counterparty: 'ws-nonesuch' }, T0)).toThrow(/No workspace has that code/)
    expect(() => proposeClaim(w.db, w.A.id, w.own(w.asha), { ...base, amountPaise: 0 }, T0)).toThrow(/above nothing/)
    expect(() => proposeClaim(w.db, w.A.id, w.own(w.asha), { ...base, memo: '' }, T0)).toThrow(/what it is for/)
    expect(() => proposeClaim(w.db, w.A.id, { personId: w.asha, role: 'viewer' }, base, T0)).toThrow(/cannot record/)
    const raw = w.db.get<{ id: string }>(`SELECT id FROM users WHERE kind = 'business' LIMIT 1`)!.id
    w.db.run('DELETE FROM accounts WHERE user_id = ? AND code = ?', raw, 'nothing')
    const c = proposeClaim(w.db, w.A.id, w.own(w.asha), base, T0)
    expect(withdrawClaim(w.db, w.A.id, w.own(w.asha), c.id, T0).state).toBe('withdrawn')
    expect(nettingView(w.db, w.A.id, T0).claims.find((x) => x.id === c.id)).toBeUndefined()
  })
})

describe('a cycle and its settlement', () => {
  it('B owes A 3,00,000 and A owes B 1,20,000: B pays the net 1,80,000 once, after both agree and B signs; both books move and still balance', () => {
    const w = world()
    w.claim(w.A, w.asha, w.B, w.ravi, 'owed-to-me', 3 * LAKH, 'Invoice 14')
    w.claim(w.A, w.asha, w.B, w.ravi, 'i-owe', 1.2 * LAKH, 'Freight 9')
    const cy = proposeCycle(w.db, w.A.id, w.own(w.asha), [w.B.code], T0 + 10)
    expect(cy).toMatchObject({ grossPaise: 4.2 * LAKH, paidPaise: 1.8 * LAKH, savedPaise: 2.4 * LAKH })
    expect(cy.payments).toEqual([{ from: 'Ravi Exports', to: 'Asha Traders', paise: 1.8 * LAKH, mine: false }])
    expect(cy.checks).toHaveLength(3)
    // nothing can be signed before the other workspace has agreed to these exact terms
    expect(() => preparePayment(w.db, w.B.id, w.own(w.ravi), cy.id, T0 + 11)).toThrow(/has not agreed/)
    expect(() => agreeCycle(w.db, w.B.id, w.own(w.ravi), cy.id, 'a-different-fingerprint', T0 + 11)).toThrow(/does not match/)
    agreeCycle(w.db, w.B.id, w.own(w.ravi), cy.id, cy.fingerprint, T0 + 12)
    // A pays nothing in this cycle
    expect(() => preparePayment(w.db, w.A.id, w.own(w.asha), cy.id, T0 + 13)).toThrow(/pays nothing/)
    expect(settleIfReady(w.db, w.A.id, cy.id, T0 + 13)).toMatchObject({ settled: false, reason: expect.stringMatching(/Waiting for Ravi Exports to sign/) })
    const before = { a: balance(w.db, w.A.id, 'bank'), b: balance(w.db, w.B.id, 'bank') }
    const p = preparePayment(w.db, w.B.id, w.own(w.ravi), cy.id, T0 + 14)
    expect(p.required).toBe(1)
    const s = signApproval(w.db, w.B.id, p.approvalId, sig(w.ravi, 'owner'), p.docHash, T0 + 15)
    expect(s.complete).toBe(true)
    expect(settleIfReady(w.db, w.A.id, cy.id, T0 + 16)).toEqual({ settled: true, reason: null })
    expect(balance(w.db, w.A.id, 'bank')).toBe(before.a + BigInt(1.8 * LAKH))
    expect(balance(w.db, w.B.id, 'bank')).toBe(before.b - BigInt(1.8 * LAKH))
    expect(verifyLedger(w.db, w.A.id)).toEqual([])
    expect(verifyLedger(w.db, w.B.id)).toEqual([])
    expect(w.db.get<{ state: string }>('SELECT state FROM netting_cycles WHERE id = ?', cy.id)!.state).toBe('settled')
    expect(w.db.all('SELECT state FROM netting_claims WHERE cycle_id = ?', cy.id).every((r) => (r as { state: string }).state === 'netted')).toBe(true)
    // once: a second settlement changes nothing, and the signed approval is spent
    expect(settleIfReady(w.db, w.B.id, cy.id, T0 + 17)).toEqual({ settled: true, reason: null })
    expect(balance(w.db, w.B.id, 'bank')).toBe(before.b - BigInt(1.8 * LAKH))
    expect(w.db.get<{ memo: string; meta_json: string }>(`SELECT memo, meta_json FROM entries WHERE user_id = ? AND kind = 'netting'`, w.B.id)!.memo).toMatch(/Paper bank, simulated/)
  })

  it('the payer\'s amount band decides how many members sign: above it two sign, and the cycle settles only after the second', () => {
    const w = world()
    setPolicy(w.db, w.B.id, w.own(w.ravi), { bands: [{ fromPaise: 1 * LAKH, signers: 2 }] }, T0)
    w.claim(w.A, w.asha, w.B, w.ravi, 'owed-to-me', 3 * LAKH)
    const cy = proposeCycle(w.db, w.A.id, w.own(w.asha), [w.B.code], T0 + 10)
    agreeCycle(w.db, w.B.id, w.own(w.ravi), cy.id, cy.fingerprint, T0 + 11)
    const p = preparePayment(w.db, w.B.id, w.own(w.ravi), cy.id, T0 + 12)
    expect(p.required).toBe(2)
    expect(signApproval(w.db, w.B.id, p.approvalId, sig(w.ravi, 'owner'), p.docHash, T0 + 13).complete).toBe(false)
    expect(settleIfReady(w.db, w.A.id, cy.id, T0 + 14).settled).toBe(false)
    expect(signApproval(w.db, w.B.id, p.approvalId, sig(w.meera, 'approver'), p.docHash, T0 + 15).complete).toBe(true)
    expect(settleIfReady(w.db, w.A.id, cy.id, T0 + 16).settled).toBe(true)
  })

  it('a member whose limit is below the payment cannot sign it', () => {
    const w = world()
    setPolicy(w.db, w.B.id, w.own(w.ravi), { limits: { [w.meera]: 1 * LAKH } }, T0)
    w.claim(w.A, w.asha, w.B, w.ravi, 'owed-to-me', 3 * LAKH)
    const cy = proposeCycle(w.db, w.A.id, w.own(w.asha), [w.B.code], T0 + 10)
    agreeCycle(w.db, w.B.id, w.own(w.ravi), cy.id, cy.fingerprint, T0 + 11)
    const p = preparePayment(w.db, w.B.id, w.own(w.ravi), cy.id, T0 + 12)
    expect(() => signApproval(w.db, w.B.id, p.approvalId, sig(w.meera, 'approver'), p.docHash, T0 + 13)).toThrow(/above your limit of ₹1,00,000/)
  })

  it('three workspaces clear together: only the net positions move, in one transaction that fails whole if any payer is short', () => {
    const w = world()
    // A is owed 5 by B, B is owed 4 by C, C is owed 3 by A: A +2, B -1, C -1 (in lakh)
    w.claim(w.A, w.asha, w.B, w.ravi, 'owed-to-me', 5 * LAKH)
    w.claim(w.B, w.ravi, w.C, w.zoya, 'owed-to-me', 4 * LAKH)
    w.claim(w.C, w.zoya, w.A, w.asha, 'owed-to-me', 3 * LAKH)
    const cy = proposeCycle(w.db, w.A.id, w.own(w.asha), [w.B.code, w.C.code], T0 + 10)
    expect(cy).toMatchObject({ grossPaise: 12 * LAKH, paidPaise: 2 * LAKH, savedPaise: 10 * LAKH })
    expect(cy.participants.map((p) => [p.name, p.position])).toEqual(expect.arrayContaining([['Asha Traders', 2 * LAKH], ['Ravi Exports', -1 * LAKH], ['Zoya Mills', -1 * LAKH]]))
    agreeCycle(w.db, w.B.id, w.own(w.ravi), cy.id, cy.fingerprint, T0 + 11)
    agreeCycle(w.db, w.C.id, w.own(w.zoya), cy.id, cy.fingerprint, T0 + 11)
    const pb = preparePayment(w.db, w.B.id, w.own(w.ravi), cy.id, T0 + 12)
    const pc = preparePayment(w.db, w.C.id, w.own(w.zoya), cy.id, T0 + 12)
    // C's bank empties before the cycle settles: nothing posts anywhere
    signApproval(w.db, w.B.id, pb.approvalId, sig(w.ravi, 'owner'), pb.docHash, T0 + 13)
    signApproval(w.db, w.C.id, pc.approvalId, sig(w.zoya, 'owner'), pc.docHash, T0 + 13)
    const snap = [w.A.id, w.B.id, w.C.id].map((id) => balance(w.db, id, 'bank'))
    w.db.run(`UPDATE balances SET amount = 0, amount_text = '0' WHERE account_id = (SELECT id FROM accounts WHERE user_id = ? AND code = 'bank')`, w.C.id)
    const r = settleIfReady(w.db, w.A.id, cy.id, T0 + 14)
    expect(r.settled).toBe(false)
    expect(balance(w.db, w.A.id, 'bank')).toBe(snap[0])
    expect(balance(w.db, w.B.id, 'bank')).toBe(snap[1])
    expect(w.db.get<{ state: string }>('SELECT state FROM netting_cycles WHERE id = ?', cy.id)!.state).toBe('open')
  })

  it('a payer that would break its own reserve cannot settle; an old signature lapses; a cancelled cycle frees its claims', () => {
    const w = world()
    const poor = (() => { const id = createBusiness(w.db, w.zoya, 'Poor Co', T0); openHousehold(w.db, id, { ...DEFAULT_OPENING, bank: 12 * LAKH }, {}, T0); return { id, code: w.db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', id)!.handle } })()
    w.claim(w.A, w.asha, poor, w.zoya, 'owed-to-me', 11 * LAKH)
    const cy = proposeCycle(w.db, w.A.id, w.own(w.asha), [poor.code], T0 + 10)
    agreeCycle(w.db, poor.id, w.own(w.zoya), cy.id, cy.fingerprint, T0 + 11)
    const p = preparePayment(w.db, poor.id, w.own(w.zoya), cy.id, T0 + 12)
    signApproval(w.db, poor.id, p.approvalId, sig(w.zoya, 'owner'), p.docHash, T0 + 13)
    // five minutes and one second later the signature has lapsed
    expect(settleIfReady(w.db, w.A.id, cy.id, T0 + 13 + 5 * 60_000 + 1)).toMatchObject({ settled: false, reason: expect.stringMatching(/five minutes/) })
    // inside the time the bank holds it, but paying would leave too little for what falls due: refused, nothing posts, the signature is not spent
    const a0 = balance(w.db, w.A.id, 'bank'), p0 = balance(w.db, poor.id, 'bank')
    const r = settleIfReady(w.db, w.A.id, cy.id, T0 + 14)
    expect(r.settled).toBe(false)
    expect(r.reason).toMatch(/going below what it must keep|below zero|reserved/)
    expect([balance(w.db, w.A.id, 'bank'), balance(w.db, poor.id, 'bank')]).toEqual([a0, p0])
    expect(w.db.get<{ consumed_at: number | null }>('SELECT consumed_at FROM approvals WHERE id = ?', p.approvalId)!.consumed_at).toBeNull()
    const cancelled = cancelCycle(w.db, w.A.id, w.own(w.asha), cy.id, T0 + 20)
    expect(cancelled?.state).toBe('cancelled')
    expect(w.db.get<{ state: string }>('SELECT state FROM netting_claims WHERE creditor_ws = ?', w.A.id)!.state).toBe('agreed')
    expect(w.db.get<{ cancelled_at: number | null }>('SELECT cancelled_at FROM approvals WHERE id = ?', p.approvalId)!.cancelled_at).not.toBeNull()
    expect(cycleView(w.db, w.A.id, cy.id, T0 + 21)!.open).toBe(false)
  })
})
