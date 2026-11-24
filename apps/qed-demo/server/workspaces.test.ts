import { describe, expect, it } from 'vitest'
import { createApproval, openApprovals, signApproval } from './approvals.ts'
import { type Db, openDb } from './core.ts'
import type { Session } from './auth.ts'
import { applyDueChanges, cancelScheduledChange, PROTECTION_DELAY_MS, securityView } from './passkeys.ts'
import { actor, addMember, createBusiness, listWorkspaces, members, policyOf, type Role, setPolicy } from './workspaces.ts'

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

describe('business workspaces', () => {
  it('a business has members with roles; nobody grants a role above their own, and only owners and admins add members', () => {
    const db = openDb(':memory:')
    const asha = person(db, 'asha'), ravi = person(db, 'ravi'), meera = person(db, 'meera')
    const ws = createBusiness(db, asha, 'Asha Traders', T0)
    expect(listWorkspaces(db, asha).map((w) => [w.kind, w.role])).toEqual([['person', 'owner'], ['business', 'owner']])
    addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'admin', T0 + 1)
    expect(() => addMember(db, ws, { personId: ravi, role: 'admin' }, 'meera', 'owner', T0 + 2)).toThrow(/above your own/)
    addMember(db, ws, { personId: ravi, role: 'admin' }, 'meera', 'operator', T0 + 2)
    expect(() => addMember(db, ws, { personId: meera, role: 'operator' }, 'asha', 'viewer', T0)).toThrow(/owner or an admin/)
    expect(() => addMember(db, ws, { personId: asha, role: 'owner' }, 'nobody', 'viewer', T0)).toThrow(/Nobody has that handle/)
    expect(() => addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'viewer', T0)).toThrow(/already a member/)
    expect(members(db, ws).map((m) => [m.handle, m.role])).toEqual([['asha', 'owner'], ['ravi', 'admin'], ['meera', 'operator']])
    // a personal workspace never needs more than its owner
    expect(policyOf(db, asha)).toMatchObject({ signers: 1, makerChecker: false })
  })

  it('two members must sign when the policy says so; whoever prepared it cannot be one of them; a member signs once; a viewer never', () => {
    const db = openDb(':memory:')
    const asha = person(db, 'asha'), ravi = person(db, 'ravi'), meera = person(db, 'meera'), vik = person(db, 'vik')
    const ws = createBusiness(db, asha, 'Asha Traders', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'approver', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'meera', 'approver', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'vik', 'viewer', T0)
    expect(setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 2, makerChecker: true }, T0)).toMatchObject({ applied: true, effectiveAt: null })
    const a = prepare(db, ws, asha, 'owner', 500_000)
    expect(a.required_signers).toBe(2)
    expect(a.created_by).toBe(asha)
    expect(() => signApproval(db, ws, a.id, sig(asha, 'owner'), a.doc_hash, T0)).toThrow(/you prepared this request/i)
    expect(() => signApproval(db, ws, a.id, sig(vik, 'viewer'), a.doc_hash, T0)).toThrow(/not sign/)
    expect(() => signApproval(db, ws, a.id, sig(ravi, 'approver'), 'sha256:other', T0)).toThrow(/does not match/)
    const one = signApproval(db, ws, a.id, sig(ravi, 'approver'), a.doc_hash, T0 + 1000)
    expect(one).toMatchObject({ complete: false, signed: 1, required: 2 })
    expect(one.approval.confirmed_at).toBeNull()
    expect(() => signApproval(db, ws, a.id, sig(ravi, 'approver'), a.doc_hash, T0 + 2000)).toThrow(/already signed/)
    expect(openApprovals(db, ws, meera, 'approver', T0 + 2000)).toMatchObject([{ id: a.id, signed: 1, required: 2, canSign: true }])
    expect(openApprovals(db, ws, asha, 'owner', T0 + 2000)).toMatchObject([{ id: a.id, canSign: false, why: 'You prepared it; another member signs.' }])
    const two = signApproval(db, ws, a.id, sig(meera, 'approver'), a.doc_hash, T0 + 3000)
    expect(two).toMatchObject({ complete: true, signed: 2, required: 2 })
    expect(two.approval.confirmed_at).toBe(T0 + 3000)
    expect(two.approval.method).toBe('passkey')
    expect(openApprovals(db, ws, meera, 'approver', T0 + 4000)).toEqual([])
  })

  it('a larger amount needs more signers when the policy says so', () => {
    const db = openDb(':memory:')
    const asha = person(db, 'asha'), ravi = person(db, 'ravi'), meera = person(db, 'meera')
    const ws = createBusiness(db, asha, 'Asha Traders', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'approver', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'meera', 'approver', T0)
    setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 1, largePaise: 10_000_000, largeSigners: 3 }, T0)
    expect(prepare(db, ws, asha, 'owner', 9_999_999).required_signers).toBe(1)
    expect(prepare(db, ws, asha, 'owner', 10_000_000).required_signers).toBe(3)
  })

  it('a policy no member set could meet is refused; lowering waits out the delay and a signer can cancel it', () => {
    const db = openDb(':memory:')
    const asha = person(db, 'asha'), ravi = person(db, 'ravi')
    const ws = createBusiness(db, asha, 'Asha Traders', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'approver', T0)
    expect(() => setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 2, makerChecker: true }, T0)).toThrow(/more signers than this workspace has/)
    setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 2 }, T0)
    expect(policyOf(db, ws).signers).toBe(2)
    expect(() => setPolicy(db, ws, { personId: ravi, role: 'approver' }, { signers: 1 }, T0)).toThrow(/owner or an admin/)
    const low = setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 1 }, T0)
    expect(low).toMatchObject({ applied: false, effectiveAt: T0 + PROTECTION_DELAY_MS })
    expect(policyOf(db, ws).signers).toBe(2) // unchanged during the delay
    expect(applyDueChanges(db, T0 + PROTECTION_DELAY_MS + 1)).toBe(1)
    expect(policyOf(db, ws).signers).toBe(1)
  })

  it('a scheduled lowering is shown, with its id, to every member who may sign, and any of them can cancel it', () => {
    const db = openDb(':memory:')
    const asha = person(db, 'asha'), ravi = person(db, 'ravi'), vik = person(db, 'vik')
    const ws = createBusiness(db, asha, 'Asha Traders', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'ravi', 'approver', T0)
    addMember(db, ws, { personId: asha, role: 'owner' }, 'vik', 'viewer', T0)
    setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 2 }, T0)
    const low = setPolicy(db, ws, { personId: asha, role: 'owner' }, { signers: 1 }, T0)
    const session = (personId: string): Session => ({ userId: personId, csrf: 'x', sessionHash: personId.padEnd(64, '0'), stepUpFresh: true, passwordStepUpFresh: false, expiresAt: T0 + 1e9, authMethod: 'passkey', credentialId: null, workspaceId: personId })
    const pending = (p: string) => (securityView(db, session(p), T0 + 1) as { scheduled: { id: string; kind: string; workspace_name: string }[] }).scheduled
    expect(pending(ravi)).toEqual([expect.objectContaining({ id: low.changeId, kind: 'lower-policy', workspace_name: 'Asha Traders' })])
    expect(pending(vik)).toEqual([]) // a viewer cannot sign, so cannot cancel either
    expect(db.get<{ detail_json: string }>('SELECT detail_json FROM security_events WHERE person_id = ? AND kind = ?', ravi, 'policy-lowering-scheduled')!.detail_json).toContain(low.changeId!)
    cancelScheduledChange(db, session(ravi), low.changeId!, T0 + 2)
    expect(applyDueChanges(db, T0 + PROTECTION_DELAY_MS + 1)).toBe(0)
    expect(policyOf(db, ws).signers).toBe(2)
  })
})
