/**
 * Delegated limits and approval by amount band (R13, I1): QED enforces both; the chain's owner account has one count for every
 * action and no band or limit, and the workspace view says so.
 */
import { describe, expect, it } from 'vitest'
import { createApproval, openApprovals, signApproval } from './approvals.ts'
import { type Db, openDb } from './core.ts'
import { applyDueChanges, PROTECTION_DELAY_MS } from './passkeys.ts'
import { actor, addMember, createBusiness, enforcementOf, policyOf, requiredFor, type Role, setPolicy } from './workspaces.ts'

const T0 = Date.UTC(2026, 10, 20, 12, 0)
function person(db: Db, handle: string): string {
  const id = `usr_${handle}`
  db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, handle, handle, T0)
  db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, id, T0)
  return id
}
const sig = (personId: string, role: Role) => ({ personId, role, credentialId: `cred-${personId}`, evidence: { by: personId }, sessionHash: 'h'.repeat(64) })
const prepare = (db: Db, ws: string, by: string, role: Role, sizePaise: number, now = T0) =>
  actor.run({ personId: by, workspaceId: ws, role }, () => createApproval(db, ws, { purpose: 'action', subject: `action:${Math.random()}`, document: JSON.stringify({ pay: 'someone', sizePaise }) }, now))
const owner = (p: string) => ({ personId: p, role: 'owner' as Role })

function firm() {
  const db = openDb(':memory:')
  const asha = person(db, 'asha'), ravi = person(db, 'ravi'), meera = person(db, 'meera'), kiran = person(db, 'kiran'), op = person(db, 'op')
  const ws = createBusiness(db, asha, 'Asha Traders', T0)
  addMember(db, ws, owner(asha), 'ravi', 'approver', T0)
  addMember(db, ws, owner(asha), 'meera', 'approver', T0)
  addMember(db, ws, owner(asha), 'kiran', 'approver', T0)
  addMember(db, ws, owner(asha), 'op', 'operator', T0)
  return { db, ws, asha, ravi, meera, kiran, op }
}
const LAKH = 10_000_000 // paise

describe('amount bands', () => {
  it('the highest band an amount reaches sets how many members must sign; below every band the base count applies', () => {
    const { db, ws, asha } = firm()
    setPolicy(db, ws, owner(asha), { signers: 1, bands: [{ fromPaise: 5 * LAKH, signers: 2 }, { fromPaise: 20 * LAKH, signers: 3 }] }, T0)
    expect([1, 5 * LAKH - 1, 5 * LAKH, 20 * LAKH - 1, 20 * LAKH, 900 * LAKH].map((n) => requiredFor(policyOf(db, ws), n))).toEqual([1, 1, 2, 2, 3, 3])
    expect(prepare(db, ws, asha, 'owner', 4 * LAKH).required_signers).toBe(1)
    expect(prepare(db, ws, asha, 'owner', 7 * LAKH).required_signers).toBe(2)
    expect(prepare(db, ws, asha, 'owner', 25 * LAKH).required_signers).toBe(3)
  })

  it('an approval above a band is not in force until that many distinct members have signed it', () => {
    const { db, ws, asha, ravi, meera, kiran } = firm()
    setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 2 }] }, T0)
    const a = prepare(db, ws, asha, 'owner', 6 * LAKH)
    expect(signApproval(db, ws, a.id, sig(ravi, 'approver'), a.doc_hash, T0 + 1).complete).toBe(false)
    expect(() => signApproval(db, ws, a.id, sig(ravi, 'approver'), a.doc_hash, T0 + 2)).toThrow(/already signed/)
    const done = signApproval(db, ws, a.id, sig(meera, 'approver'), a.doc_hash, T0 + 3)
    expect(done).toMatchObject({ complete: true, signed: 2, required: 2 })
    // and below the band one signature is enough
    const small = prepare(db, ws, asha, 'owner', 4 * LAKH)
    expect(signApproval(db, ws, small.id, sig(kiran, 'approver'), small.doc_hash, T0 + 4).complete).toBe(true)
  })

  it('a band no signers could meet is refused; bands must rise with the amount and are limited in number', () => {
    const { db, ws, asha } = firm()
    expect(() => setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: LAKH, signers: 5 }] }, T0)).toThrow(/needs 5 signatures, but only 4 members/)
    expect(() => setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 3 }, { fromPaise: 9 * LAKH, signers: 2 }] }, T0)).toThrow(/cannot ask for fewer/)
    expect(() => setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 2 }, { fromPaise: 5 * LAKH, signers: 3 }] }, T0)).toThrow(/same amount/)
    expect(() => setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 0, signers: 2 }] }, T0)).toThrow(/amount above zero/)
    expect(() => setPolicy(db, ws, owner(asha), { bands: Array.from({ length: 7 }, (_, i) => ({ fromPaise: (i + 1) * LAKH, signers: 2 })) }, T0)).toThrow(/At most 6/)
  })

  it('adding or raising a band takes effect at once; removing or weakening one waits out the delay and can be cancelled', () => {
    const { db, ws, asha } = firm()
    expect(setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 2 }] }, T0)).toMatchObject({ applied: true })
    expect(setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 3 }] }, T0)).toMatchObject({ applied: true })
    expect(setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 3 }, { fromPaise: 50 * LAKH, signers: 4 }] }, T0)).toMatchObject({ applied: true })
    // a higher starting amount means fewer approvals reach the band: weaker
    const weaker = setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 8 * LAKH, signers: 3 }, { fromPaise: 50 * LAKH, signers: 4 }] }, T0)
    expect(weaker).toMatchObject({ applied: false, effectiveAt: T0 + PROTECTION_DELAY_MS })
    expect(policyOf(db, ws).bands[0]!.fromPaise).toBe(5 * LAKH)
    expect(applyDueChanges(db, T0 + PROTECTION_DELAY_MS + 1)).toBe(1)
    expect(policyOf(db, ws).bands.map((b) => b.fromPaise)).toEqual([8 * LAKH, 50 * LAKH])
    // taking every band away is a lowering too
    expect(setPolicy(db, ws, owner(asha), { bands: [] }, T0 + 2 * PROTECTION_DELAY_MS)).toMatchObject({ applied: false })
  })
})

describe('delegated limits', () => {
  it('a member cannot sign above their limit, though their role may sign; the open request says why', () => {
    const { db, ws, asha, ravi, meera } = firm()
    setPolicy(db, ws, owner(asha), { limits: { [ravi]: 3 * LAKH } }, T0)
    const big = prepare(db, ws, asha, 'owner', 4 * LAKH)
    expect(() => signApproval(db, ws, big.id, sig(ravi, 'approver'), big.doc_hash, T0 + 1)).toThrow(/above your limit of ₹3,00,000/)
    const small = prepare(db, ws, asha, 'owner', 3 * LAKH)
    expect(signApproval(db, ws, small.id, sig(ravi, 'approver'), small.doc_hash, T0 + 2).complete).toBe(true)
    // a member with no limit signs the large one
    expect(signApproval(db, ws, big.id, sig(meera, 'approver'), big.doc_hash, T0 + 3).complete).toBe(true)
    // the queue marks it for the limited member
    setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 2 * LAKH, signers: 2 }] }, T0)
    const two = prepare(db, ws, asha, 'owner', 5 * LAKH)
    expect(openApprovals(db, ws, ravi, 'approver', T0 + 5).find((o) => o.id === two.id)).toMatchObject({ canSign: false, why: expect.stringMatching(/Above your limit of ₹3,00,000/) })
    expect(openApprovals(db, ws, meera, 'approver', T0 + 5).find((o) => o.id === two.id)).toMatchObject({ canSign: true })
  })

  it('a limit also bounds what a member may prepare', () => {
    const { db, ws, asha, op } = firm()
    setPolicy(db, ws, owner(asha), { limits: { [op]: 1 * LAKH } }, T0)
    expect(() => prepare(db, ws, op, 'operator', 2 * LAKH)).toThrow(/above your limit of ₹1,00,000/)
    expect(prepare(db, ws, op, 'operator', 1 * LAKH).created_by).toBe(op)
  })

  it('bands and limits together: a band is refused where too few members have a limit that reaches it', () => {
    const { db, ws, asha, ravi, meera, kiran } = firm()
    setPolicy(db, ws, owner(asha), { limits: { [ravi]: 2 * LAKH, [meera]: 2 * LAKH, [kiran]: 2 * LAKH } }, T0)
    // asha (an owner) is the only signer without a limit: a band of two from ₹5 lakh could not be met
    expect(() => setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 2 }] }, T0)).toThrow(/only 1 member who may sign has a limit that reaches it/)
    // a band within the limits is fine
    expect(setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 1 * LAKH, signers: 2 }] }, T0)).toMatchObject({ applied: true })
  })

  it('setting or lowering a limit is immediate; raising or removing one waits and any signer can cancel it; only members can have one', () => {
    const { db, ws, asha, ravi } = firm()
    expect(setPolicy(db, ws, owner(asha), { limits: { [ravi]: 5 * LAKH } }, T0)).toMatchObject({ applied: true })
    expect(setPolicy(db, ws, owner(asha), { limits: { [ravi]: 2 * LAKH } }, T0)).toMatchObject({ applied: true })
    const up = setPolicy(db, ws, owner(asha), { limits: { [ravi]: 9 * LAKH } }, T0)
    expect(up).toMatchObject({ applied: false })
    expect(policyOf(db, ws).limits[ravi]).toBe(2 * LAKH)
    expect(setPolicy(db, ws, owner(asha), { limits: { [ravi]: null } }, T0)).toMatchObject({ applied: false })
    expect(applyDueChanges(db, T0 + PROTECTION_DELAY_MS + 1)).toBeGreaterThanOrEqual(1)
    expect(() => setPolicy(db, ws, owner(asha), { limits: { usr_nobody: LAKH } }, T0)).toThrow(/member of this workspace/)
    expect(() => setPolicy(db, ws, owner(asha), { limits: { [ravi]: -5 } }, T0)).toThrow(/whole number of paise/)
    expect(() => setPolicy(db, ws, { personId: ravi, role: 'approver' }, { limits: { [ravi]: 1 } }, T0)).toThrow(/owner or an admin/)
  })

  it('a lowering that waited lapses if the policy changed in the meantime (bands and limits count)', () => {
    const { db, ws, asha, ravi } = firm()
    setPolicy(db, ws, owner(asha), { bands: [{ fromPaise: 5 * LAKH, signers: 3 }] }, T0)
    const low = setPolicy(db, ws, owner(asha), { bands: [] }, T0)
    expect(low.applied).toBe(false)
    // a raise applies at once while the lowering waits
    setPolicy(db, ws, owner(asha), { limits: { [ravi]: 1 * LAKH } }, T0 + 1)
    applyDueChanges(db, T0 + PROTECTION_DELAY_MS + 5)
    expect(policyOf(db, ws).bands).toHaveLength(1)
  })
})

describe('who checks what', () => {
  it('with a vault the chain checks its signature count only; bands and limits are said to be QED\'s alone', () => {
    const e = enforcementOf({ threshold: 2 })
    expect(e.chain).toMatchObject({ threshold: 2 })
    expect(e.chain.checks[0]).toMatch(/2 distinct member signatures on every action/)
    expect(e.qedAlone.join(' ')).toMatch(/bands/)
    expect(e.qedAlone.join(' ')).toMatch(/limit/)
    expect(e.note).toMatch(/no amount bands and no member limits, so QED alone checks those/)
    expect(enforcementOf(null).chain.checks).toEqual([])
    expect(enforcementOf(null).note).toMatch(/no on-chain vault: QED alone/)
  })
})
