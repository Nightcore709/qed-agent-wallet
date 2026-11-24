/**
 * Every change that weakens a protection waits out the protection delay (R13 section 4 for the wait on new payees; the
 * mandate omissions audit, finding P1, for the floor, the bank reserve's assumptions and figures that lower what must stay):
 * tightening takes effect at once; loosening only when the delay ends, cancellable meanwhile from any of the person's
 * passkeys, through the mechanism a lowering of a workspace's signing policy uses (scheduled_changes, applyDueChanges,
 * cancelScheduledChange). The person and their recovery contacts are told when it is asked for; the person again when it
 * takes effect. Until then the stricter setting decides everything. Two requests racing, a cancel racing the engine's
 * apply, and a restart in between are taken one after the other, through the database's write lock.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { DEFAULT_OPENING, getProfile, openHousehold } from './household.ts'
import { liquidity } from './liquidity.ts'
import { changeProfile, LOOSEN_PROFILE, pendingChange, splitChange } from './loosening.ts'
import { holdFor } from './new-payee.ts'
import { addPayee } from './owner.ts'
import { applyDueChanges, cancelScheduledChange, PROTECTION_DELAY_MS } from './passkeys.ts'
import { seedRegistry } from './registry.ts'
import { makeKit, T0, type Kit } from './testkit.ts'
import { addMember, createBusiness } from './workspaces.ts'

const H = 3600_000
const USER = 'usr_test'
const settingsOf = (db: Db, keys: readonly string[]) => { const p = getProfile(db, USER) as unknown as Record<string, number>; return Object.fromEntries(keys.map((k) => [k, p[k]])) }
const hold = (k: Kit) => settingsOf(k.db, ['newPayeeHoldAbove', 'newPayeeHoldHours'])
const events = (db: Db, personId: string) => db.all<{ kind: string; detail_json: string }>('SELECT kind, detail_json FROM security_events WHERE person_id = ? ORDER BY id', personId)
const notices = (db: Db, personId: string) => db.all<{ kind: string; title: string; body: string }>(`SELECT kind, title, body FROM notices WHERE user_id = ? AND kind = 'security-change' ORDER BY ts`, personId)
const by = (fresh = true) => ({ personId: USER, workspaceId: USER, fresh })
const session = (fresh: boolean, now: number): Session => ({ userId: USER, csrf: 'c', sessionHash: 'a'.repeat(64), stepUpFresh: fresh, passwordStepUpFresh: false, expiresAt: now + H, authMethod: 'passkey', credentialId: null, workspaceId: USER })
/** A recovery contact in force for the owner (accepted, its own delay over). */
function contact(db: Db, now: number, handle = 'helper'): string {
  const id = `usr_${handle}`
  db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, handle, 'Helper', 'x', now)
  db.run('INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?)', `rcl_${handle}`, USER, id, now - 100 * H, now - 20 * H, now - 90 * H)
  return id
}

describe('which part of a change tightens, and which loosens', () => {
  it('each protection takes the stricter of the two now; the request waits only for what it loosens', () => {
    const k = makeKit()
    const cur = getProfile(k.db, USER), now = k.clock.now()
    const split = (asked: Record<string, number>) => { const s = splitChange(k.db, USER, cur, asked, now); return { now: s.now, later: s.later } }
    expect(split({ newPayeeHoldAbove: 500_000, newPayeeHoldHours: 48 })).toEqual({ now: { newPayeeHoldAbove: 500_000, newPayeeHoldHours: 48 }, later: {} })
    expect(split({ newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4 })).toEqual({ now: {}, later: { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4 } })
    expect(split({ newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 48 })).toEqual({ now: { newPayeeHoldHours: 48 }, later: { newPayeeHoldAbove: 5_000_000 } })
    // no wait at all is the least strict
    expect(split({ newPayeeHoldHours: 0 })).toEqual({ now: {}, later: { newPayeeHoldHours: 0 } })
    expect(splitChange(k.db, USER, { ...cur, newPayeeHoldHours: 0 }, { newPayeeHoldHours: 1 }, now)).toMatchObject({ now: { newPayeeHoldHours: 1 }, later: {} })
    // the floor and the reserve's assumptions: lower is looser
    expect(split({ line: cur.line + 100_000, lateDays: cur.lateDays + 2 })).toEqual({ now: { line: cur.line + 100_000, lateDays: cur.lateDays + 2 }, later: {} })
    expect(split({ line: cur.line - 100_000, lostSalaries: 0 })).toEqual({ now: {}, later: { line: cur.line - 100_000, lostSalaries: 0 } })
    expect(split({ line: cur.line - 100_000, lateDays: cur.lateDays + 1 })).toEqual({ now: { lateDays: cur.lateDays + 1 }, later: { line: cur.line - 100_000 } })
  })

  it('household figures take effect at once unless together they lower what must stay in the bank', () => {
    const k = makeKit()
    const cur = getProfile(k.db, USER), now = k.clock.now()
    const more = splitChange(k.db, USER, cur, { spending: cur.spending + 1_000_000, income: cur.income + 500_000 }, now)
    expect(more).toMatchObject({ now: { spending: cur.spending + 1_000_000, income: cur.income + 500_000 }, later: {}, lowersReserve: null })
    const less = splitChange(k.db, USER, cur, { spending: cur.spending - 1_000_000, income: cur.income + 500_000 }, now)
    expect(less.now).toEqual({})
    expect(less.later).toEqual({ spending: cur.spending - 1_000_000, income: cur.income + 500_000 })
    expect(less.lowersReserve!.after).toBeLessThan(less.lowersReserve!.before)
    expect(less.lowersReserve!.before).toBe(liquidity(k.db, USER, now).need)
  })
})

describe('changing a protection', () => {
  it('tightening takes effect at once, schedules nothing, and needs no fresh passkey confirmation', () => {
    const k = makeKit()
    const cur = getProfile(k.db, USER)
    const r = changeProfile(k.db, by(false), { newPayeeHoldAbove: 500_000, newPayeeHoldHours: 48, line: cur.line + 100_000 }, k.clock.now())
    expect(r).toMatchObject({ applied: ['newPayeeHoldAbove', 'newPayeeHoldHours', 'line'], waiting: null, deferred: false })
    expect(settingsOf(k.db, ['newPayeeHoldAbove', 'newPayeeHoldHours', 'line'])).toEqual({ newPayeeHoldAbove: 500_000, newPayeeHoldHours: 48, line: cur.line + 100_000 })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM scheduled_changes')!.n).toBe(0)
    expect(events(k.db, USER).map((e) => e.kind)).not.toContain('profile-loosening-scheduled')
  })

  it('loosening waits out the protection delay, needs a fresh passkey confirmation, and the person and their recovery contacts are told at once', () => {
    const k = makeKit()
    const t0 = k.clock.now(), cur = getProfile(k.db, USER)
    const helper = contact(k.db, t0)
    expect(() => changeProfile(k.db, by(false), { line: cur.line - 100_000 }, t0)).toThrow(/weakens one of your protections\. Confirm with your passkey/)
    expect(() => changeProfile(k.db, by(false), { spending: cur.spending - 1_000_000 }, t0)).toThrow(/^This lowers what must stay in your bank account from ₹[\d,]+(\.\d\d)? to ₹[\d,]+(\.\d\d)?, which frees that money for QED's instructions\. Confirm with your passkey to make the change\.$/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM scheduled_changes')!.n).toBe(0)
    const r = changeProfile(k.db, by(), { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4, line: cur.line - 100_000 }, t0)
    expect(r).toMatchObject({ applied: [], deferred: true, contactsTold: 1 })
    expect(r.waiting).toEqual({ id: expect.stringMatching(/^chg/), requestedAt: t0, effectiveAt: t0 + PROTECTION_DELAY_MS, after: { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4, line: cur.line - 100_000 }, before: { newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24, line: cur.line } })
    expect(pendingChange(k.db, USER)).toEqual(r.waiting)
    expect(hold(k)).toEqual({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24 })
    expect(getProfile(k.db, USER).line).toBe(cur.line)
    expect(k.db.get('SELECT kind, person_id, workspace_id, subject FROM scheduled_changes')).toEqual({ kind: LOOSEN_PROFILE, person_id: USER, workspace_id: USER, subject: USER })
    // the person: in the security history and as an urgent notice inside QED (securityEvent also sends it to every confirmed address)
    expect(events(k.db, USER).at(-1)).toMatchObject({ kind: 'profile-loosening-scheduled' })
    expect(JSON.parse(events(k.db, USER).at(-1)!.detail_json)).toMatchObject({ effectiveAt: t0 + PROTECTION_DELAY_MS, after: r.waiting!.after, before: r.waiting!.before })
    expect(notices(k.db, USER).at(-1)).toMatchObject({ title: 'A change that loosens your protections is scheduled', body: expect.stringContaining('any of your passkeys can cancel it') })
    // the recovery contact: who asked, and what to do
    expect(events(k.db, helper).map((e) => e.kind)).toEqual(['contact-loosening-scheduled'])
    expect(JSON.parse(events(k.db, helper)[0]!.detail_json)).toEqual({ for: 'tester', effectiveAt: t0 + PROTECTION_DELAY_MS })
    expect(notices(k.db, helper)).toEqual([expect.objectContaining({ title: 'Someone you are a recovery contact for is loosening a protection', body: expect.stringContaining('call them on a number you already have') })])
  })

  it('until the delay ends the stricter setting decides; when it ends the change applies once, and the person is told again', () => {
    const k = makeKit()
    const y = addPayee(k.db, USER, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' }, k.clock.now())
    const t0 = k.clock.now()
    changeProfile(k.db, by(), { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4 }, t0)
    expect(holdFor(k.db, USER, getProfile(k.db, USER), y.handle, 2_000_000n, t0)).toMatchObject({ above: 1_000_000, until: t0 + 24 * H })
    expect(applyDueChanges(k.db, t0 + PROTECTION_DELAY_MS - 1000)).toBe(0)
    expect(hold(k)).toEqual({ newPayeeHoldAbove: 1_000_000, newPayeeHoldHours: 24 })
    const at = t0 + PROTECTION_DELAY_MS
    expect(applyDueChanges(k.db, at)).toBe(1)
    expect(applyDueChanges(k.db, at + 1000)).toBe(0)
    expect(hold(k)).toEqual({ newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 4 })
    expect(pendingChange(k.db, USER)).toBeNull()
    expect(events(k.db, USER).at(-1)).toMatchObject({ kind: 'profile-loosened' })
    expect(notices(k.db, USER).at(-1)).toMatchObject({ title: 'A change that loosens your protections took effect' })
    expect(k.db.get(`SELECT action, subject FROM audit WHERE action = 'profile.loosen'`)).toEqual({ action: 'profile.loosen', subject: expect.stringMatching(/^chg/) })
    const z = addPayee(k.db, USER, { name: 'Meera Nair', handle: 'meera.nair@upi', category: 'family' }, at)
    expect(holdFor(k.db, USER, getProfile(k.db, USER), z.handle, 2_000_000n, at)).toBeNull()
    expect(holdFor(k.db, USER, getProfile(k.db, USER), z.handle, 6_000_000n, at)).toMatchObject({ above: 5_000_000, until: at + 4 * H })
  })

  it('any passkey of the person can cancel it while it waits; a session without a fresh passkey confirmation cannot', () => {
    const k = makeKit()
    const t0 = k.clock.now()
    const r = changeProfile(k.db, by(), { lostSalaries: 0 }, t0)
    expect(() => cancelScheduledChange(k.db, session(false, t0 + H), r.waiting!.id, t0 + H)).toThrow(/Confirm with one of your passkeys/)
    cancelScheduledChange(k.db, session(true, t0 + H), r.waiting!.id, t0 + H)
    expect(pendingChange(k.db, USER)).toBeNull()
    expect(applyDueChanges(k.db, t0 + PROTECTION_DELAY_MS + H)).toBe(0)
    expect(getProfile(k.db, USER).lostSalaries).toBe(1)
    // once applied, it cannot be cancelled
    const s = changeProfile(k.db, by(), { lostSalaries: 0 }, t0 + 2 * H)
    applyDueChanges(k.db, s.waiting!.effectiveAt)
    expect(() => cancelScheduledChange(k.db, session(true, s.waiting!.effectiveAt), s.waiting!.id, s.waiting!.effectiveAt)).toThrow(/already took effect/)
  })

  it('a newer request decides the keys it names: a later tightening is never undone by an earlier loosening falling due', () => {
    const k = makeKit()
    const t0 = k.clock.now(), cur = getProfile(k.db, USER)
    const first = changeProfile(k.db, by(), { newPayeeHoldAbove: 5_000_000, line: cur.line - 100_000 }, t0)
    // the hold is tightened an hour later: the waiting change keeps only the floor, at its own time
    const second = changeProfile(k.db, by(false), { newPayeeHoldAbove: 500_000 }, t0 + H)
    expect(second).toMatchObject({ applied: ['newPayeeHoldAbove'], deferred: false, replaced: first.waiting!.id })
    expect(second.waiting).toMatchObject({ requestedAt: t0, effectiveAt: first.waiting!.effectiveAt, after: { line: cur.line - 100_000 } })
    expect(k.db.get('SELECT cancelled_by FROM scheduled_changes WHERE id = ?', first.waiting!.id)).toEqual({ cancelled_by: 'replaced' })
    applyDueChanges(k.db, first.waiting!.effectiveAt)
    expect(settingsOf(k.db, ['newPayeeHoldAbove', 'line'])).toEqual({ newPayeeHoldAbove: 500_000, line: cur.line - 100_000 })
    // a loosening asked again starts its own delay, and carries what was still waiting with it
    const third = changeProfile(k.db, by(), { lateDays: 0 }, t0 + 80 * H)
    const fourth = changeProfile(k.db, by(), { newPayeeHoldHours: 1 }, t0 + 81 * H)
    expect(fourth.waiting).toMatchObject({ effectiveAt: t0 + 81 * H + PROTECTION_DELAY_MS, after: { lateDays: 0, newPayeeHoldHours: 1 } })
    expect(k.db.get('SELECT cancelled_by FROM scheduled_changes WHERE id = ?', third.waiting!.id)).toEqual({ cancelled_by: 'replaced' })
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM scheduled_changes WHERE cancelled_at IS NULL AND applied_at IS NULL`)!.n).toBe(1)
  })

  it('switching the wait on new payees off is a loosening; once it applies nothing to a new payee waits; on again is at once', () => {
    const k = makeKit()
    const t0 = k.clock.now()
    expect(changeProfile(k.db, by(), { newPayeeHoldHours: 0 }, t0).waiting).toMatchObject({ after: { newPayeeHoldHours: 0 } })
    applyDueChanges(k.db, t0 + PROTECTION_DELAY_MS)
    const z = addPayee(k.db, USER, { name: 'Meera Nair', handle: 'meera.nair@upi', category: 'family' }, t0 + PROTECTION_DELAY_MS)
    expect(holdFor(k.db, USER, getProfile(k.db, USER), z.handle, 99_000_000n, t0 + PROTECTION_DELAY_MS)).toBeNull()
    expect(changeProfile(k.db, by(false), { newPayeeHoldHours: 24 }, t0 + PROTECTION_DELAY_MS + H)).toMatchObject({ applied: ['newPayeeHoldHours'], waiting: null })
    expect(holdFor(k.db, USER, getProfile(k.db, USER), z.handle, 2_000_000n, t0 + PROTECTION_DELAY_MS + H)).not.toBeNull()
  })

  it('a value off the list is refused before anything is saved or scheduled; a damaged change is not applied', () => {
    const k = makeKit()
    const t0 = k.clock.now()
    expect(() => changeProfile(k.db, by(), { newPayeeHoldAbove: 5_000_000, newPayeeHoldHours: 5 }, t0)).toThrow(/not valid/)
    expect(() => changeProfile(k.db, by(), { line: -1 }, t0)).toThrow(/not valid/)
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM scheduled_changes')!.n).toBe(0)
    const r = changeProfile(k.db, by(), { newPayeeHoldAbove: 5_000_000 }, t0)
    k.db.run(`UPDATE scheduled_changes SET detail_json = '{"after":{"newPayeeHoldAbove":5000000,"setup":false}}' WHERE id = ?`, r.waiting!.id)
    expect(applyDueChanges(k.db, t0 + PROTECTION_DELAY_MS)).toBe(0)
    expect(k.db.get('SELECT cancelled_by FROM scheduled_changes WHERE id = ?', r.waiting!.id)).toEqual({ cancelled_by: 'no-longer-valid' })
    expect(getProfile(k.db, USER)).toMatchObject({ setup: true, newPayeeHoldAbove: 1_000_000 })
  })
})

describe('a business workspace', () => {
  /** A business with an owner, an admin, an approver, an operator and a viewer, whose own household is open. */
  function business() {
    const k = makeKit()
    const people: Record<string, string> = {}
    for (const h of ['asha', 'ravi', 'meera', 'omar', 'vik']) {
      const id = `usr_${h}`
      k.db.run(`INSERT INTO users (id, handle, display_name, pw_hash, created_at, kind) VALUES (?, ?, ?, '!', ?, 'person')`, id, h, h, T0)
      k.db.run(`INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, 'owner', ?)`, id, id, T0)
      people[h] = id
    }
    const ws = createBusiness(k.db, people.asha!, 'Asha Traders', T0)
    for (const [h, role] of [['ravi', 'admin'], ['meera', 'approver'], ['omar', 'operator'], ['vik', 'viewer']] as const) addMember(k.db, ws, { personId: people.asha!, role: 'owner' }, h, role, T0)
    openHousehold(k.db, ws, DEFAULT_OPENING, {}, T0)
    const sess = (who: string, fresh = true): Session => ({ ...session(fresh, T0), userId: people[who]!, workspaceId: ws })
    return { k, ws, people, sess }
  }

  it('a loosening waits the 72 hours, and every member who may sign is told; those who may not, and the owner\'s recovery contacts of others, are not', () => {
    const { k, ws, people } = business()
    const r = changeProfile(k.db, { personId: people.asha!, workspaceId: ws, fresh: true }, { lostSalaries: 0 }, T0)
    expect(r).toMatchObject({ deferred: true, applied: [] })
    expect(r.waiting!.effectiveAt).toBe(T0 + PROTECTION_DELAY_MS)
    expect(PROTECTION_DELAY_MS).toBe(72 * H)
    expect(getProfile(k.db, ws).lostSalaries).toBe(1)
    expect(k.db.get('SELECT kind, person_id, workspace_id FROM scheduled_changes')).toEqual({ kind: LOOSEN_PROFILE, person_id: people.asha, workspace_id: ws })
    const told = (who: string) => events(k.db, people[who]!).filter((e) => e.kind === 'profile-loosening-scheduled')
    for (const who of ['asha', 'ravi', 'meera']) {
      expect(told(who), who).toHaveLength(1)
      expect(JSON.parse(told(who)[0]!.detail_json)).toMatchObject({ workspaceId: ws, changeId: r.waiting!.id, effectiveAt: T0 + PROTECTION_DELAY_MS })
    }
    for (const who of ['omar', 'vik']) expect(told(who), who).toEqual([])
  })

  it('any member who may sign can cancel it while it waits, with a fresh passkey; an operator or a viewer cannot; the change then never applies', () => {
    const { k, ws, people, sess } = business()
    const r = changeProfile(k.db, { personId: people.asha!, workspaceId: ws, fresh: true }, { lostSalaries: 0 }, T0)
    const id = r.waiting!.id
    expect(() => cancelScheduledChange(k.db, sess('meera', false), id, T0 + H)).toThrow(/Confirm with one of your passkeys/)
    for (const who of ['omar', 'vik']) expect(() => cancelScheduledChange(k.db, sess(who), id, T0 + H), who).toThrow(/not found/)
    expect(pendingChange(k.db, ws)).not.toBeNull()
    // an approver, who did not ask for it, cancels
    cancelScheduledChange(k.db, sess('meera'), id, T0 + 2 * H)
    expect(pendingChange(k.db, ws)).toBeNull()
    expect(k.db.get('SELECT cancelled_at FROM scheduled_changes WHERE id = ?', id)).toEqual({ cancelled_at: T0 + 2 * H })
    expect(events(k.db, people.meera!).at(-1)).toMatchObject({ kind: 'change-cancelled' })
    expect(applyDueChanges(k.db, T0 + PROTECTION_DELAY_MS + H)).toBe(0)
    expect(getProfile(k.db, ws).lostSalaries).toBe(1)
  })

  it('applies when no signer cancels, and the signers are told again', () => {
    const { k, ws, people } = business()
    const r = changeProfile(k.db, { personId: people.asha!, workspaceId: ws, fresh: true }, { lostSalaries: 0 }, T0)
    expect(applyDueChanges(k.db, r.waiting!.effectiveAt - 1)).toBe(0)
    expect(applyDueChanges(k.db, r.waiting!.effectiveAt)).toBe(1)
    expect(getProfile(k.db, ws).lostSalaries).toBe(0)
    expect(events(k.db, people.ravi!).map((e) => e.kind)).toContain('profile-loosened')
  })

  it('a session without a fresh passkey cannot ask for a loosening in the workspace at all', () => {
    const { k, ws, people } = business()
    expect(() => changeProfile(k.db, { personId: people.asha!, workspaceId: ws, fresh: false }, { lostSalaries: 0 }, T0)).toThrow(/Confirm with your passkey/)
    expect(k.db.get('SELECT 1 FROM scheduled_changes')).toBeUndefined()
  })
})

describe('two processes on one database: the API and the engine', () => {
  // Two connections to one file, as the API and the engine have. A process's transaction is preceded by the other's, as
  // happens when it commits between this one's read and its write: wrapping `tx` runs the other's step first.
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  function file(): { path: string; open: () => Db } {
    const dir = mkdtempSync(join(tmpdir(), 'qed-loosen-')); dirs.push(dir)
    const path = join(dir, 'qed.db')
    const db = openDb(path)
    seedRegistry(db)
    db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', USER, 'tester', 'Test Owner', 'x', T0)
    openHousehold(db, USER, DEFAULT_OPENING, {}, T0)
    db.close()
    return { path, open: () => openDb(path) }
  }
  /** Run `first` (another process's step) just before this connection's next transaction begins. */
  function before(db: Db, first: () => void): void {
    const tx = db.tx.bind(db)
    let done = false
    db.tx = <T>(fn: () => T): T => { if (!done) { done = true; first() } return tx(fn) }
  }

  it('two requests racing: the later one reads what the earlier one wrote, so an earlier loosening cannot undo it', () => {
    const f = file()
    const a = f.open(), b = f.open()
    const line = getProfile(a, USER).line
    // B (a passkey session) lowers the floor; A, whose request was read before B's committed, raises it
    before(a, () => { changeProfile(b, by(), { line: line - 100_000 }, T0) })
    const r = changeProfile(a, by(false), { line: line + 100_000 }, T0 + 1000)
    expect(r).toMatchObject({ applied: ['line'], waiting: null })
    expect(pendingChange(a, USER)).toBeNull()
    expect(applyDueChanges(a, T0 + PROTECTION_DELAY_MS + H)).toBe(0)
    expect(getProfile(b, USER).line).toBe(line + 100_000)
    a.close(); b.close()
  })

  it('two requests racing: one that was a tightening when its session read the settings is refused once it would loosen them', () => {
    const f = file()
    const a = f.open(), b = f.open()
    const line = getProfile(a, USER).line
    // A, a session with no fresh passkey confirmation, asks for a floor above today's; B raised it further first
    before(a, () => { changeProfile(b, by(false), { line: line + 200_000 }, T0) })
    expect(() => changeProfile(a, by(false), { line: line + 100_000 }, T0 + 1000)).toThrow(/Confirm with your passkey/)
    expect(getProfile(a, USER).line).toBe(line + 200_000)
    expect(pendingChange(a, USER)).toBeNull()
    a.close(); b.close()
  })

  it('a cancel that lands while the engine is applying the change wins: it is not applied, and the row says cancelled', () => {
    const f = file()
    const api = f.open(), engine = f.open()
    const r = changeProfile(api, by(), { lostSalaries: 0 }, T0)
    const due = r.waiting!.effectiveAt
    // the engine has listed the due changes; the API's cancel commits before the engine's transaction for it begins
    before(engine, () => { cancelScheduledChange(api, session(true, due), r.waiting!.id, due) })
    expect(applyDueChanges(engine, due)).toBe(0)
    expect(getProfile(engine, USER).lostSalaries).toBe(1)
    expect(engine.get('SELECT cancelled_at IS NOT NULL cancelled, applied_at FROM scheduled_changes WHERE id = ?', r.waiting!.id)).toEqual({ cancelled: 1, applied_at: null })
    expect(events(engine, USER).map((e) => e.kind)).not.toContain('profile-loosened')
    api.close(); engine.close()
  })

  it('a restart in between: a waiting change survives it and applies when due; one cancelled before it stays cancelled', () => {
    const f = file()
    let db = f.open()
    const keep = changeProfile(db, by(), { lateDays: 0 }, T0)
    db.close()
    // the API and the engine restarted: the change is still waiting, and nothing applied it early
    db = f.open()
    expect(pendingChange(db, USER)).toMatchObject({ id: keep.waiting!.id, after: { lateDays: 0 } })
    expect(applyDueChanges(db, T0 + H)).toBe(0)
    // the engine was down when it fell due: it applies when the engine next runs
    expect(applyDueChanges(db, keep.waiting!.effectiveAt + 5 * H)).toBe(1)
    expect(getProfile(db, USER).lateDays).toBe(0)
    const drop = changeProfile(db, by(), { lostSalaries: 0 }, T0 + 100 * H)
    cancelScheduledChange(db, session(true, T0 + 101 * H), drop.waiting!.id, T0 + 101 * H)
    db.close()
    db = f.open()
    expect(applyDueChanges(db, drop.waiting!.effectiveAt + H)).toBe(0)
    expect(getProfile(db, USER).lostSalaries).toBe(1)
    db.close()
  })
})
