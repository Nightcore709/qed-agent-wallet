/**
 * Giving a member authority is a loosening under the 72-hour rule; narrowing applies at once (R13 hardening brief item 4,
 * Q-048 as decided). A member added as an operator, approver, admin or owner, or a member's role raised, waits out the
 * protection delay, any member who may sign can cancel it meanwhile, and every member who may sign, the person who asked
 * and that person's recovery contacts are told. A viewer (who may only look) is added at once. Lowering a role or removing
 * a member takes effect at once and withdraws a grant still waiting for them.
 */
import { describe, expect, it } from 'vitest'
import { type Session } from './auth.ts'
import { openDb } from './core.ts'
import { applyDueChanges, cancelScheduledChange, PROTECTION_DELAY_MS } from './passkeys.ts'
import { addMember, changeRole, createBusiness, membership, pendingGrants, policyMet, removeMember, requestMember, setPolicy } from './workspaces.ts'

const T0 = Date.UTC(2026, 10, 24, 6, 0)
type DB = ReturnType<typeof openDb>
function people(db: DB, ...handles: string[]): Record<string, string> {
  const ids: Record<string, string> = {}
  for (const h of handles) { ids[h] = `usr_${h}`; db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, ids[h], h, h, T0) }
  return ids
}
const session = (personId: string): Session => ({ userId: personId, csrf: 'x', sessionHash: `${personId}-session-hash`, stepUpFresh: true, passwordStepUpFresh: false, expiresAt: T0 + 86_400_000, authMethod: 'passkey', credentialId: null, workspaceId: personId, confirmedBy: null })
const kinds = (db: DB, person: string) => db.all<{ kind: string }>('SELECT kind FROM security_events WHERE person_id = ? ORDER BY id', person).map((e) => e.kind)

describe('giving a member authority waits out the protection delay (Q-048)', () => {
  it('a member added with authority is not a member until the delay ends; then they are, and everyone is told', () => {
    const db = openDb(':memory:')
    const p = people(db, 'asha', 'ravi', 'meera', 'vik')
    const ws = createBusiness(db, p.asha!, 'Asha Traders', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'meera', 'approver', T0)
    const g = requestMember(db, ws, { personId: p.asha!, role: 'owner' }, 'ravi', 'approver', T0 + 1)
    expect(g).toMatchObject({ applied: false, effectiveAt: T0 + 1 + PROTECTION_DELAY_MS })
    expect(membership(db, ws, p.ravi!)).toBeUndefined()
    expect(pendingGrants(db, ws)).toMatchObject([{ personId: p.ravi, role: 'approver', before: null }])
    // told at once: the asker and every member who may sign; the person to be added too
    expect(kinds(db, p.asha!)).toContain('member-grant-scheduled')
    expect(kinds(db, p.meera!)).toContain('member-grant-scheduled')
    expect(kinds(db, p.ravi!)).toContain('workspace-role-pending')
    expect(applyDueChanges(db, T0 + PROTECTION_DELAY_MS)).toBe(0)
    expect(applyDueChanges(db, T0 + 1 + PROTECTION_DELAY_MS)).toBe(1)
    expect(membership(db, ws, p.ravi!)).toEqual({ role: 'approver' })
    expect(kinds(db, p.ravi!)).toContain('member-granted')
    expect(kinds(db, p.meera!)).toContain('member-granted')
    // a viewer grants no authority: added at once
    expect(requestMember(db, ws, { personId: p.asha!, role: 'owner' }, 'vik', 'viewer', T0 + 2)).toMatchObject({ applied: true })
    expect(membership(db, ws, p.vik!)).toEqual({ role: 'viewer' })
  })

  it('raising a role waits; lowering one and removing a member apply at once and withdraw what waited', () => {
    const db = openDb(':memory:')
    const p = people(db, 'asha', 'ravi', 'meera')
    const ws = createBusiness(db, p.asha!, 'Asha Traders', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'ravi', 'viewer', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'meera', 'approver', T0)
    const up = changeRole(db, ws, { personId: p.asha!, role: 'owner' }, p.ravi!, 'admin', T0 + 1)
    expect(up).toMatchObject({ applied: false })
    expect(membership(db, ws, p.ravi!)).toEqual({ role: 'viewer' })
    // lowering meera applies now; then ravi's raise is withdrawn by removing him
    expect(changeRole(db, ws, { personId: p.asha!, role: 'owner' }, p.meera!, 'operator', T0 + 2)).toMatchObject({ applied: true })
    expect(membership(db, ws, p.meera!)).toEqual({ role: 'operator' })
    removeMember(db, ws, { personId: p.asha!, role: 'owner' }, p.ravi!, T0 + 3)
    expect(membership(db, ws, p.ravi!)).toBeUndefined()
    expect(pendingGrants(db, ws)).toEqual([])
    expect(applyDueChanges(db, T0 + 1 + PROTECTION_DELAY_MS)).toBe(0)
    expect(membership(db, ws, p.ravi!)).toBeUndefined()
    // a workspace keeps one owner
    expect(() => removeMember(db, ws, { personId: p.asha!, role: 'owner' }, p.asha!, T0 + 4)).toThrow(/at least one owner/)
    expect(() => changeRole(db, ws, { personId: p.asha!, role: 'owner' }, p.asha!, 'admin', T0 + 4)).toThrow(/at least one owner/)
  })

  it('any member who may sign cancels a waiting grant; the grant lapses if whoever asked may no longer give it', () => {
    const db = openDb(':memory:')
    const p = people(db, 'asha', 'ravi', 'meera', 'omar')
    const ws = createBusiness(db, p.asha!, 'Asha Traders', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'ravi', 'admin', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'meera', 'approver', T0)
    const g = requestMember(db, ws, { personId: p.ravi!, role: 'admin' }, 'omar', 'operator', T0 + 1)
    cancelScheduledChange(db, session(p.meera!), g.changeId!, T0 + 2)
    expect(applyDueChanges(db, T0 + 1 + PROTECTION_DELAY_MS)).toBe(0)
    expect(membership(db, ws, p.omar!)).toBeUndefined()
    // asked again, then the asker is lowered to viewer: the grant lapses when due
    requestMember(db, ws, { personId: p.ravi!, role: 'admin' }, 'omar', 'operator', T0 + 3)
    changeRole(db, ws, { personId: p.asha!, role: 'owner' }, p.ravi!, 'viewer', T0 + 4)
    expect(applyDueChanges(db, T0 + 3 + PROTECTION_DELAY_MS)).toBe(0)
    expect(membership(db, ws, p.omar!)).toBeUndefined()
    expect(db.get('SELECT 1 FROM audit WHERE action = ? AND subject = ?', 'member.grant-lapsed', p.omar!)).toBeTruthy()
  })

  it('refuses a role above the asker\'s own, and a passkey in its cool-off (beforeLoosening) gives nothing', () => {
    const db = openDb(':memory:')
    const p = people(db, 'asha', 'ravi', 'meera')
    const ws = createBusiness(db, p.asha!, 'Asha Traders', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'ravi', 'admin', T0)
    expect(() => requestMember(db, ws, { personId: p.ravi!, role: 'admin' }, 'meera', 'owner', T0)).toThrow(/above your own/)
    expect(() => requestMember(db, ws, { personId: p.asha!, role: 'owner', beforeLoosening: () => { throw new Error('cooling off') } }, 'meera', 'approver', T0)).toThrow(/cooling off/)
    expect(pendingGrants(db, ws)).toEqual([])
    // a viewer is not a grant: the guard is not asked
    requestMember(db, ws, { personId: p.asha!, role: 'owner', beforeLoosening: () => { throw new Error('cooling off') } }, 'meera', 'viewer', T0)
    expect(membership(db, ws, p.meera!)).toEqual({ role: 'viewer' })
  })

  it('says when a narrowing leaves the signing policy unmet, and applies it all the same', () => {
    const db = openDb(':memory:')
    const p = people(db, 'asha', 'ravi')
    const ws = createBusiness(db, p.asha!, 'Asha Traders', T0)
    addMember(db, ws, { personId: p.asha!, role: 'owner' }, 'ravi', 'approver', T0)
    setPolicy(db, ws, { personId: p.asha!, role: 'owner' }, { signers: 2 }, T0)
    expect(policyMet(db, ws)).toBe(true)
    expect(changeRole(db, ws, { personId: p.asha!, role: 'owner' }, p.ravi!, 'viewer', T0 + 1)).toMatchObject({ applied: true, policyMet: false })
  })
})
