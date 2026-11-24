/**
 * Removing a bill that lowers what must stay in the bank is a loosening (mandate omissions audit, finding P1, same class):
 * it needs a fresh passkey and then waits out the protection delay, cancellable from any passkey, through
 * server/loosening.ts. A bill the reserve does not count is removed at once, as before.
 */
import { describe, expect, it } from 'vitest'
import type { Session } from './auth.ts'
import { istInstant } from './core.ts'
import { billLowersReserve, liquidity } from './liquidity.ts'
import { pendingBillRemoval, REMOVE_BILL, requestBillRemoval } from './loosening.ts'
import { cancelBill } from './owner.ts'
import { applyDueChanges, cancelScheduledChange, PROTECTION_DELAY_MS } from './passkeys.ts'
import { makeKit, T0, type Kit } from './testkit.ts'

const H = 3600_000, USER = 'usr_test'
const payee = (k: Kit, handle: string): string => { const id = `pay_${handle.replace(/\W/g, '')}`; k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, 'Payee', handle, 'utility', T0 - 30 * 86_400_000, T0); return id }
const bill = (k: Kit, payeeId: string, amount: number, dueAt: number): string => { const id = `bill_${amount}_${dueAt}`; k.db.run("INSERT INTO bills (id, user_id, payee_id, amount, due_at, memo, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'due', ?)", id, k.userId, payeeId, amount, dueAt, '', T0); return id }
const by = (fresh: boolean) => ({ personId: USER, workspaceId: USER, fresh })
const session = (fresh: boolean, now: number): Session => ({ userId: USER, csrf: 'c', sessionHash: 'a'.repeat(64), stepUpFresh: fresh, passwordStepUpFresh: false, expiresAt: now + H, authMethod: 'passkey', credentialId: null, workspaceId: USER })
const state = (k: Kit, id: string) => k.db.get<{ state: string }>('SELECT state FROM bills WHERE id = ?', id)!.state
const remove = (k: Kit, id: string) => () => cancelBill(k.db, USER, id, k.clock.now())

describe('removing a bill the reserve counts', () => {
  it('needs a fresh passkey, and does nothing without one', () => {
    const k = makeKit()
    const b = bill(k, payee(k, 'power@upi'), 1_100_000, istInstant('2026-12-01', '10:00'))
    expect(() => requestBillRemoval(k.db, by(false), b, T0, remove(k, b))).toThrow(/Confirm with your passkey/)
    expect(state(k, b)).toBe('due')
    expect(pendingBillRemoval(k.db, USER, b)).toBeNull()
  })

  it('requested: the bill stays and its money stays kept, for 72 hours; the person is told; asking again is the same request', () => {
    const k = makeKit()
    const b = bill(k, payee(k, 'power@upi'), 1_100_000, istInstant('2026-12-01', '10:00'))
    const need = liquidity(k.db, USER, T0).need
    const r = requestBillRemoval(k.db, by(true), b, T0, remove(k, b))
    expect(r).toMatchObject({ removed: false, waiting: { billId: b, requestedAt: T0, effectiveAt: T0 + PROTECTION_DELAY_MS } })
    expect(state(k, b)).toBe('due')
    expect(liquidity(k.db, USER, T0 + H).need).toBe(need)
    expect(k.db.all<{ kind: string }>('SELECT kind FROM security_events WHERE person_id = ?', USER).map((e) => e.kind)).toContain('bill-removal-scheduled')
    const again = requestBillRemoval(k.db, by(true), b, T0 + H, remove(k, b))
    expect(again).toMatchObject({ removed: false, waiting: { effectiveAt: T0 + PROTECTION_DELAY_MS } })
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM scheduled_changes WHERE kind = ?`, REMOVE_BILL)!.n).toBe(1)
    // the engine applying nothing early
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS - 1)).toBe(0)
    expect(state(k, b)).toBe('due')
  })

  it('cancelled from a passkey while it waits: the bill stays for good, and the engine never applies it', () => {
    const k = makeKit()
    const b = bill(k, payee(k, 'power@upi'), 1_100_000, istInstant('2026-12-01', '10:00'))
    const r = requestBillRemoval(k.db, by(true), b, T0, remove(k, b))
    if (r.removed) throw new Error('expected a waiting removal')
    expect(() => cancelScheduledChange(k.db, session(false, T0 + H), r.waiting.id, T0 + H)).toThrow(/Confirm with one of your passkeys/)
    cancelScheduledChange(k.db, session(true, T0 + H), r.waiting.id, T0 + H)
    expect(pendingBillRemoval(k.db, USER, b)).toBeNull()
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS + H)).toBe(0)
    expect(state(k, b)).toBe('due')
  })

  it('applied when its delay ends: the bill is removed, the reserve falls, the person is told once', () => {
    const k = makeKit()
    const b = bill(k, payee(k, 'power@upi'), 1_100_000, istInstant('2026-12-01', '10:00'))
    const before = liquidity(k.db, USER, T0).need
    requestBillRemoval(k.db, by(true), b, T0, remove(k, b))
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS)).toBe(1)
    expect(state(k, b)).toBe('cancelled')
    expect(liquidity(k.db, USER, T0 + PROTECTION_DELAY_MS).need).toBeLessThan(before)
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS + H)).toBe(0)
    expect(k.db.all<{ kind: string }>(`SELECT kind FROM security_events WHERE person_id = ? AND kind = 'bill-removed'`, USER)).toHaveLength(1)
  })

  it('is not applied when the bill is no longer due by then, and the change is closed as no longer valid', () => {
    const k = makeKit()
    const b = bill(k, payee(k, 'power@upi'), 1_100_000, istInstant('2026-12-01', '10:00'))
    requestBillRemoval(k.db, by(true), b, T0, remove(k, b))
    k.db.run(`UPDATE bills SET state = 'paid' WHERE id = ?`, b)
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS)).toBe(0)
    expect(state(k, b)).toBe('paid')
    expect(k.db.get<{ cancelled_by: string }>(`SELECT cancelled_by FROM scheduled_changes WHERE kind = ?`, REMOVE_BILL)!.cancelled_by).toBe('no-longer-valid')
  })

  it('a bill the reserve does not count is removed at once, without a passkey, as before', () => {
    const k = makeKit()
    const far = bill(k, payee(k, 'net@upi'), 500_000, istInstant('2027-02-20', '10:00'))
    expect(billLowersReserve(k.db, USER, T0, far)).toBeNull()
    expect(requestBillRemoval(k.db, by(false), far, T0, remove(k, far))).toEqual({ removed: true })
    expect(state(k, far)).toBe('cancelled')
  })

  it('only a bill that is due can be asked about', () => {
    const k = makeKit()
    expect(() => requestBillRemoval(k.db, by(true), 'nope', T0, () => {})).toThrow(/still due/)
  })
})
