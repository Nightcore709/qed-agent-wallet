/**
 * SECURITY.md 8j (c), R14 Priority 4B: removing a way back in (a recovery contact who has accepted, the password, a
 * confirmed email address) no longer takes effect at once on a passkey confirmation. Each becomes a scheduled change on the
 * mechanism every other weakening uses (scheduled_changes, applied by applyDueChanges, cancelled by cancelScheduledChange):
 * it waits PROTECTION_DELAY_MS, it is told at once to the person (security event, urgent notice, every confirmed address),
 * to the contact being removed and to the address being removed, and meanwhile any passkey of the person that can confirm,
 * or one of their saved codes from any of their sessions, cancels it. So one stolen passkey cannot strip the fallbacks
 * before the owner notices. What adds a way back in, a contact stepping down, a request nobody answered, an address never
 * confirmed, a phone number (notices only) and a change of password stay as they were.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { login, sessionFor, stepUp } from './auth.ts'
import { type Db, openDb } from './core.ts'
import { configureDelivery } from './delivery.ts'
import {
  acceptContact, applyDueChanges, beginAddPasskey, beginLogin, beginSignup, cancelScheduledChange, cancelScheduledChangeWithCode, changePassword,
  finishAddPasskey, finishLogin, finishSignup, issueContactCode, nominateContact, PROTECTION_DELAY_MS, type RelyingParty, removeContact, removePassword,
  scheduleRemovePasskey, securityView, signUpWithPassword, suspendPasskeyWithCode,
} from './passkeys.ts'
import { addAddress, confirmAddressByCode, confirmAddressByLink, removeAddress } from './recovery.ts'
import { SoftAuthenticator } from './softauthn.ts'

configureDelivery({ delivery: 'outbox', linkOrigin: 'http://localhost:5175' })

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 26, 6, 0)
const D = PROTECTION_DELAY_MS
/** A minute after a contact named at T0 became active. */
const T1 = T0 + D + 60_000

let ip = 0
async function person(db: Db, handle: string, now = T0) {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, `10.77.0.${++ip}`, now)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META, now)
  return { auth, id: r.personId, codes: r.recoveryCodes }
}
/** A session opened now with this passkey: a passkey sign-in is a fresh confirmation by it. */
async function signedIn(db: Db, auth: SoftAuthenticator, now: number) {
  const b = await beginLogin(db, RP, now)
  const n = await finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never) }, META, now)
  return (at = now) => sessionFor(db, n.token, at)!
}
/** Asha, and Ravi as her recovery contact: named and accepted at T0, active from T0 + D. */
async function withContact(db: Db) {
  const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
  const { linkId } = nominateContact(db, (await signedIn(db, asha.auth, T0))(), 'ravi', T0)
  acceptContact(db, (await signedIn(db, ravi.auth, T0))(), linkId, T0)
  return { asha, ravi, linkId }
}
/** Another passkey of the person, added at `now` from a session confirmed with `withAuth` (in its cool-off until now + 24 h). */
async function secondPasskey(db: Db, withAuth: SoftAuthenticator, now: number) {
  const s = (await signedIn(db, withAuth, now))()
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginAddPasskey(db, RP, s, now)
  const cred = await finishAddPasskey(db, RP, s, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META.ua, now)
  return { auth, id: cred.id }
}
const lastTo = (db: Db, to: string) => db.get<{ subject: string; body: string; purpose: string }>('SELECT subject, body, purpose FROM outbound_messages WHERE to_address = ? ORDER BY rowid DESC LIMIT 1', to)
const purposesTo = (db: Db, to: string) => db.all<{ purpose: string }>('SELECT purpose FROM outbound_messages WHERE to_address = ? ORDER BY rowid', to).map((m) => m.purpose)
/** An email address confirmed by its link; returns its id. */
function confirmedEmail(db: Db, s: ReturnType<typeof sessionFor>, address: string, now: number): string {
  const { id } = addAddress(db, s!, 'email', address, now)
  const token = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(lastTo(db, address)!.body)![1]!
  confirmAddressByLink(db, token, META.ip, now + 1)
  return id
}
const events = (db: Db, id: string) => db.all<{ kind: string }>('SELECT kind FROM security_events WHERE person_id = ? ORDER BY id', id).map((e) => e.kind)
const count = (list: string[], kind: string) => list.filter((k) => k === kind).length
const urgent = (db: Db, id: string) => db.all<{ subject: string }>(`SELECT subject FROM notices WHERE user_id = ? AND kind = 'security-change' ORDER BY ts, rowid`, id).map((n) => n.subject)
const waiting = (db: Db, id: string) => db.all<{ id: string; kind: string; subject: string; effective_at: number; requested_by: string | null }>('SELECT id, kind, subject, effective_at, requested_by FROM scheduled_changes WHERE person_id = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at', id)
const change = (db: Db, id: string) => db.get<{ kind: string; cancelled_at: number | null; cancelled_by: string | null; applied_at: number | null }>('SELECT kind, cancelled_at, cancelled_by, applied_at FROM scheduled_changes WHERE id = ?', id)!
const link = (db: Db, linkId: string) => db.get<{ removed_at: number | null; removed_by: string | null }>('SELECT removed_at, removed_by FROM recovery_contacts WHERE id = ?', linkId)!
const unusedCodes = (db: Db, id: string) => db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL', id)!.n
const pwHash = (db: Db, id: string) => db.get<{ pw_hash: string }>('SELECT pw_hash FROM users WHERE id = ?', id)!.pw_hash
type Scheduled = { scheduled: true; changeId: string; effectiveAt: number }
const scheduled = (r: unknown): Scheduled => { expect(r).toMatchObject({ scheduled: true, changeId: expect.stringMatching(/^chg_/), effectiveAt: expect.any(Number) }); return r as Scheduled }

/** An account with a password and a first passkey (which brought its codes), an active contact, and a confirmed address. */
async function passwordAccount(db: Db, handle: string, password: string) {
  const made = await signUpWithPassword(db, { handle, password, displayName: handle }, { ip: `10.78.0.${++ip}`, ua: META.ua }, T0)
  const typed = sessionFor(db, made.session.token, T0)! // the sign-up's own password entry unlocks the first passkey
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginAddPasskey(db, RP, typed, T0)
  const cred = await finishAddPasskey(db, RP, typed, { challengeId: b.challengeId, response: auth.create(b.options as never) }, META.ua, T0)
  const ravi = await person(db, `${handle}-ravi`)
  const { linkId } = nominateContact(db, (await signedIn(db, auth, T0))(), `${handle}-ravi`, T0)
  acceptContact(db, (await signedIn(db, ravi.auth, T0))(), linkId, T0)
  const email = confirmedEmail(db, (await signedIn(db, auth, T0))(), `${handle}@gmail.com`, T0)
  return { auth, id: made.personId, codes: cred.recoveryCodes!, linkId, ravi, email }
}

describe('8j (c): ending a recovery contact waits the protection delay', () => {
  it('is scheduled, not done; both sides are told at once; the contact keeps the role until it applies, once', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId } = await withContact(db)
    const s = (await signedIn(db, asha.auth, T1))()
    const r = scheduled(removeContact(db, s, linkId, T1))
    expect(r.effectiveAt).toBe(T1 + D)
    expect(link(db, linkId).removed_at).toBeNull()
    expect(waiting(db, asha.id)).toEqual([expect.objectContaining({ id: r.changeId, kind: 'remove-contact', subject: linkId, effective_at: T1 + D })])
    // told at once: the person (history and an urgent notice), and the contact being removed
    expect(events(db, asha.id)).toContain('recovery-contact-removal-scheduled')
    expect(urgent(db, asha.id)).toContain('recovery-contact-removal-scheduled')
    expect(events(db, ravi.id)).toContain('contact-role-ending-scheduled')
    expect(urgent(db, ravi.id)).toContain('contact-role-ending-scheduled')
    // the screen shows it waiting and until when; the contact still counts, and can still issue a code
    const view = securityView(db, s, T1 + 1) as { contacts: { active: boolean; removalScheduledFor: number | null; removalChangeId: string | null }[]; secondMethod: { contacts: number } }
    expect(view.contacts[0]).toMatchObject({ active: true, removalScheduledFor: T1 + D, removalChangeId: r.changeId })
    expect(view.secondMethod.contacts).toBe(1)
    expect(issueContactCode(db, (await signedIn(db, ravi.auth, T1 + 2))(), linkId, T1 + 2).code).toMatch(/^[A-Z2-9]{4}-/)
    // the contact's own screen says when the role ends
    const theirs = securityView(db, (await signedIn(db, ravi.auth, T1 + 3))(), T1 + 3) as { trustedBy: { endingAt: number | null }[] }
    expect(theirs.trustedBy[0]!.endingAt).toBe(T1 + D)
    // asked again while it waits: refused, the first keeps its time
    expect(() => removeContact(db, s, linkId, T1 + 4)).toThrow(expect.objectContaining({ code: 'already_scheduled' }))
    // not before its time; then once
    expect(applyDueChanges(db, T1 + D - 1)).toBe(0)
    expect(link(db, linkId).removed_at).toBeNull()
    expect(applyDueChanges(db, T1 + D)).toBe(1)
    expect(link(db, linkId)).toEqual({ removed_at: T1 + D, removed_by: asha.id })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_codes WHERE link_id = ? AND used_at IS NULL AND replaced_at IS NULL', linkId)!.n).toBe(0)
    expect(applyDueChanges(db, T1 + D + 1)).toBe(0)
    expect(count(events(db, asha.id), 'recovery-contact-ended')).toBe(1)
    expect(count(events(db, ravi.id), 'recovery-contact-role-ended')).toBe(1)
    expect(change(db, r.changeId)).toMatchObject({ applied_at: T1 + D, cancelled_at: null })
  })

  it('a request nobody answered is withdrawn at once, and a contact stepping down leaves at once, as before', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), mina = await person(db, 'mina')
    const { linkId } = nominateContact(db, (await signedIn(db, asha.auth, T0))(), 'ravi', T0)
    expect(removeContact(db, (await signedIn(db, asha.auth, T0 + 10))(), linkId, T0 + 10)).toEqual({ removed: true })
    expect(link(db, linkId).removed_at).toBe(T0 + 10)
    const second = nominateContact(db, (await signedIn(db, asha.auth, T0 + 20))(), 'mina', T0 + 20).linkId
    acceptContact(db, (await signedIn(db, mina.auth, T0 + 30))(), second, T0 + 30)
    expect(removeContact(db, (await signedIn(db, mina.auth, T1))(), second, T1)).toEqual({ removed: true })
    expect(link(db, second).removed_at).toBe(T1)
    expect(waiting(db, asha.id)).toEqual([])
    void ravi
  })
})

describe('8j (c): removing a confirmed email address waits the protection delay', () => {
  it('is scheduled; every channel and the address itself are told at once; it applies once, and its links stop then', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const s0 = (await signedIn(db, asha.auth, T0))()
    const first = confirmedEmail(db, s0, 'asha@gmail.com', T0)
    confirmedEmail(db, s0, 'asha.work@example.in', T0)
    const s = (await signedIn(db, asha.auth, T1))()
    const r = scheduled(removeAddress(db, s, first, T1))
    expect(r.effectiveAt).toBe(T1 + D)
    expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', first)).toEqual({ removed_at: null })
    expect(events(db, asha.id)).toContain('email-removal-scheduled')
    expect(urgent(db, asha.id)).toContain('email-removal-scheduled')
    // the address being removed hears of it, and so does every other confirmed address, with the time
    for (const to of ['asha@gmail.com', 'asha.work@example.in']) {
      expect(lastTo(db, to)).toMatchObject({ purpose: 'notice:email-removal-scheduled', subject: 'QED: An email address is to be removed from your account' })
      expect(lastTo(db, to)!.body).toContain('IST')
    }
    const view = securityView(db, s, T1 + 1) as { addresses: { id: string; removalScheduledFor: number | null; removalChangeId: string | null }[] }
    expect(view.addresses.find((a) => a.id === first)).toMatchObject({ removalScheduledFor: T1 + D, removalChangeId: r.changeId })
    expect(() => removeAddress(db, s, first, T1 + 2)).toThrow(expect.objectContaining({ code: 'already_scheduled' }))
    expect(applyDueChanges(db, T1 + D - 1)).toBe(0)
    expect(applyDueChanges(db, T1 + D)).toBe(1)
    expect(db.get('SELECT removed_at, removed_reason FROM contact_points WHERE id = ?', first)).toEqual({ removed_at: T1 + D, removed_reason: 'removed by the owner' })
    // told once more, and then nothing: it is no longer one of the account's addresses
    expect(lastTo(db, 'asha@gmail.com')).toMatchObject({ purpose: 'notice:email-removed' })
    expect(count(purposesTo(db, 'asha@gmail.com'), 'notice:email-removed')).toBe(1)
    expect(applyDueChanges(db, T1 + D + 5)).toBe(0)
    expect(count(events(db, asha.id), 'email-removed')).toBe(1)
  })

  it('an address never confirmed is removed at once, as before', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const s = (await signedIn(db, asha.auth, T0))()
    const { id: unconfirmed } = addAddress(db, s, 'email', 'asha.new@gmail.com', T0)
    expect(removeAddress(db, s, unconfirmed, T0 + 1)).toEqual({ removed: true })
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM contact_points WHERE person_id = ? AND removed_at IS NULL', asha.id)!.n).toBe(0)
    expect(waiting(db, asha.id)).toEqual([])
  })

  it('RISK-125: a confirmed phone number waits the protection delay like an email address, is told at once, and can be cancelled', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const s = (await signedIn(db, asha.auth, T0))()
    const phone = addAddress(db, s, 'phone', '+919876543210', T0 + 2)
    const six = /is (\d{6})\./.exec(lastTo(db, '+919876543210')!.body)![1]!
    confirmAddressByCode(db, s, phone.id, six, T0 + 3)
    const r = scheduled(removeAddress(db, (await signedIn(db, asha.auth, T0 + 4))(), phone.id, T0 + 4))
    expect(r.effectiveAt).toBe(T0 + 4 + D)
    expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', phone.id)).toEqual({ removed_at: null })
    expect(waiting(db, asha.id)).toEqual([expect.objectContaining({ id: r.changeId, kind: 'remove-address', subject: phone.id })])
    expect(events(db, asha.id)).toContain('phone-removal-scheduled')
    expect(urgent(db, asha.id)).toContain('phone-removal-scheduled')
    expect(purposesTo(db, '+919876543210')).toContain('notice:phone-removal-scheduled') // the number itself is told, as every channel
    // asking twice schedules once
    const again0 = (await signedIn(db, asha.auth, T0 + 5))()
    expect(() => removeAddress(db, again0, phone.id, T0 + 5)).toThrow(expect.objectContaining({ code: 'already_scheduled' }))
    // a passkey cancels it: the number stays
    await cancelScheduledChangeWithCode(db, (await signedIn(db, asha.auth, T0 + 6))(), r.changeId, undefined, T0 + 6)
    expect(applyDueChanges(db, T0 + 4 + D)).toBe(0)
    expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', phone.id)).toEqual({ removed_at: null })
    // asked again and left alone, it is removed when the delay ends, once, and the number is told
    const again = scheduled(removeAddress(db, (await signedIn(db, asha.auth, T0 + 10))(), phone.id, T0 + 10))
    expect(applyDueChanges(db, again.effectiveAt)).toBe(1)
    expect(db.get<{ removed_at: number | null }>('SELECT removed_at FROM contact_points WHERE id = ?', phone.id)!.removed_at).toBe(again.effectiveAt)
    expect(count(events(db, asha.id), 'phone-removed')).toBe(1)
  })

  it('RISK-125: a saved code that cancels a scheduled removal raises an urgent notice and a message on every channel; a passkey does not', async () => {
    const db = openDb(':memory:')
    const { asha, linkId } = await withContact(db)
    confirmedEmail(db, (await signedIn(db, asha.auth, T0))(), 'asha@gmail.com', T0)
    const first = scheduled(removeContact(db, (await signedIn(db, asha.auth, T1))(), linkId, T1))
    await cancelScheduledChangeWithCode(db, (await signedIn(db, asha.auth, T1 + 10))(), first.changeId, undefined, T1 + 10)
    expect(urgent(db, asha.id)).not.toContain('change-cancelled') // by a passkey: history only, as before
    const second = scheduled(removeContact(db, (await signedIn(db, asha.auth, T1 + 20))(), linkId, T1 + 20))
    const stale = (await signedIn(db, asha.auth, T1 + 30))(T1 + 30 + 10 * 60_000)
    const before = purposesTo(db, 'asha@gmail.com').filter((x) => x === 'notice:change-cancelled').length
    await cancelScheduledChangeWithCode(db, stale, second.changeId, asha.codes[3], T1 + 30 + 10 * 60_000)
    expect(urgent(db, asha.id)).toContain('change-cancelled')
    const n = db.get<{ title: string; body: string; level: string }>(`SELECT title, body, level FROM notices WHERE user_id = ? AND kind = 'security-change' AND subject = 'change-cancelled'`, asha.id)!
    expect(n.title).toMatch(/saved code was used to cancel/i)
    expect(n.level).toBe('action')
    expect(n.body).toMatch(/not a passkey/)
    expect(purposesTo(db, 'asha@gmail.com').filter((x) => x === 'notice:change-cancelled').length).toBe(before + 1)
    expect(lastTo(db, 'asha@gmail.com')!.body).toMatch(/saved code was used to cancel/i)
  })

  it('changing an address cannot be used to remove the old one at once: the new one is added, the old one waits', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const old = confirmedEmail(db, (await signedIn(db, asha.auth, T0))(), 'asha@gmail.com', T0)
    // someone with a passkey of hers asks to replace it with an address of their own, and confirms that one
    addAddress(db, (await signedIn(db, asha.auth, T1))(), 'email', 'not.asha@gmail.com', T1, old)
    const token = /\/verify-email#token=([A-Za-z0-9_-]+)/.exec(lastTo(db, 'not.asha@gmail.com')!.body)![1]!
    confirmAddressByLink(db, token, META.ip, T1 + 10)
    // the new address is confirmed (adding is as before); the old one stays until the delay ends, and was told so
    expect(db.get<{ verified_at: number | null }>(`SELECT verified_at FROM contact_points WHERE address = 'not.asha@gmail.com'`)!.verified_at).toBe(T1 + 10)
    expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', old)).toEqual({ removed_at: null })
    expect(waiting(db, asha.id)).toEqual([expect.objectContaining({ kind: 'remove-address', subject: old, effective_at: T1 + 10 + D })])
    expect(purposesTo(db, 'asha@gmail.com')).toContain('notice:email-removal-scheduled')
    // the owner, with her passkey, cancels it: the old address stays
    const r = waiting(db, asha.id)[0]!
    await cancelScheduledChangeWithCode(db, (await signedIn(db, asha.auth, T1 + 20))(), r.id, undefined, T1 + 20)
    expect(applyDueChanges(db, T1 + 10 + D)).toBe(0)
    expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', old)).toEqual({ removed_at: null })
  })
})

describe('8j (c): removing the password waits the protection delay', { timeout: 90_000 }, () => {
  it('is scheduled; the password keeps working until it applies; then its checks are made again and its sessions end', async () => {
    const db = openDb(':memory:')
    const PW = 'a removable long phrase'
    const a = await passwordAccount(db, 'meera', PW)
    const thief = await login(db, { handle: 'meera', password: PW }, META, T1) // a phished password
    const before = pwHash(db, a.id)
    const r = scheduled(removePassword(db, (await signedIn(db, a.auth, T1))(), META.ip, T1))
    expect(r.effectiveAt).toBe(T1 + D)
    expect(pwHash(db, a.id)).toBe(before)
    expect(events(db, a.id)).toContain('password-removal-scheduled')
    expect(urgent(db, a.id)).toContain('password-removal-scheduled')
    expect(purposesTo(db, 'meera@gmail.com')).toContain('notice:password-removal-scheduled')
    const view = securityView(db, (await signedIn(db, a.auth, T1 + 1))(), T1 + 1) as { password: { set: boolean; removalScheduledFor?: number | null; removalChangeId?: string | null } }
    expect(view.password).toMatchObject({ set: true, removalScheduledFor: T1 + D, removalChangeId: r.changeId })
    // still signs in while it waits
    expect((await login(db, { handle: 'meera', password: PW }, META, T1 + 2)).userId).toBe(a.id)
    // asked again while it waits: refused, the first keeps its time
    const again = (await signedIn(db, a.auth, T1 + 3))()
    expect(() => removePassword(db, again, META.ip, T1 + 3)).toThrow(expect.objectContaining({ code: 'already_scheduled' }))
    expect(applyDueChanges(db, T1 + D - 1)).toBe(0)
    expect(pwHash(db, a.id)).toBe(before)
    expect(applyDueChanges(db, T1 + D)).toBe(1)
    expect(pwHash(db, a.id)).toBe('!')
    expect(sessionFor(db, thief.token, T1 + D)).toBeNull()
    expect(count(events(db, a.id), 'password-removed')).toBe(1)
    await expect(login(db, { handle: 'meera', password: PW }, META, T1 + D + 1)).rejects.toMatchObject({ code: 'bad_credentials' })
    expect(applyDueChanges(db, T1 + D + 2)).toBe(0)
  })

  it('a password changed while the removal waits is not removed by it (the later change wins); nor is one whose way back has gone', async () => {
    const db = openDb(':memory:')
    const a = await passwordAccount(db, 'nila', 'the first long phrase')
    const r = scheduled(removePassword(db, (await signedIn(db, a.auth, T1))(), META.ip, T1))
    await changePassword(db, (await signedIn(db, a.auth, T1 + 10))(), { password: 'a second long phrase' }, META.ip, T1 + 10)
    const changed = pwHash(db, a.id)
    expect(applyDueChanges(db, T1 + D)).toBe(0)
    expect(pwHash(db, a.id)).toBe(changed)
    expect(change(db, r.changeId)).toMatchObject({ cancelled_by: 'password-changed', applied_at: null })
    // asked again; then the only contact steps down (at once): without the password a recovery would have no second proof
    const again = scheduled(removePassword(db, (await signedIn(db, a.auth, T1 + D + 10))(), META.ip, T1 + D + 10))
    removeContact(db, (await signedIn(db, a.ravi.auth, T1 + D + 20))(), a.linkId, T1 + D + 20)
    expect(applyDueChanges(db, T1 + 2 * D + 10)).toBe(0)
    expect(pwHash(db, a.id)).toBe(changed)
    expect(change(db, again.changeId)).toMatchObject({ cancelled_by: 'no-longer-valid', applied_at: null })
    expect(events(db, a.id)).toContain('password-removal-lapsed')
  })
})

describe('8j (c): cancelling, and who may', { timeout: 90_000 }, () => {
  it('any other passkey of the person cancels it; so does one of their saved codes, from any session, and the code is not used up', async () => {
    const db = openDb(':memory:')
    const { asha, ravi, linkId } = await withContact(db)
    const phone = await secondPasskey(db, asha.auth, T0 + 1000) // past its cool-off by T1
    const first = scheduled(removeContact(db, (await signedIn(db, asha.auth, T1))(), linkId, T1))
    // the other passkey cancels
    await cancelScheduledChangeWithCode(db, (await signedIn(db, phone.auth, T1 + 10))(), first.changeId, undefined, T1 + 10)
    expect(change(db, first.changeId)).toMatchObject({ cancelled_at: T1 + 10, applied_at: null })
    expect(events(db, asha.id)).toContain('change-cancelled')
    // asked again; this time cancelled from a session whose confirmation has lapsed, with a saved code
    const second = scheduled(removeContact(db, (await signedIn(db, asha.auth, T1 + 20))(), linkId, T1 + 20))
    const stale = (await signedIn(db, asha.auth, T1 + 30))(T1 + 30 + 10 * 60_000)
    expect(stale.stepUpFresh).toBe(false)
    await expect(cancelScheduledChangeWithCode(db, stale, second.changeId, undefined, T1 + 30 + 10 * 60_000)).rejects.toMatchObject({ code: 'stepup_required' })
    await expect(cancelScheduledChangeWithCode(db, stale, second.changeId, 'AAAA-BBBB-CCCC-DDDD', T1 + 30 + 10 * 60_000)).rejects.toMatchObject({ status: 403, code: 'code_wrong' })
    expect(change(db, second.changeId).cancelled_at).toBeNull()
    // another person's session and code do not reach it
    await expect(cancelScheduledChangeWithCode(db, (await signedIn(db, ravi.auth, T1 + 40))(T1 + 40 + 10 * 60_000), second.changeId, ravi.codes[0], T1 + 40 + 10 * 60_000)).rejects.toMatchObject({ status: 404 })
    const left = unusedCodes(db, asha.id)
    await cancelScheduledChangeWithCode(db, stale, second.changeId, asha.codes[3], T1 + 30 + 10 * 60_000)
    expect(change(db, second.changeId)).toMatchObject({ cancelled_at: T1 + 30 + 10 * 60_000, cancelled_by: expect.stringMatching(/^saved-code:/), applied_at: null })
    expect(unusedCodes(db, asha.id)).toBe(left)
    expect(applyDueChanges(db, T1 + 20 + D)).toBe(0)
    expect(link(db, linkId).removed_at).toBeNull()
    // a saved code cancels only these removals: a passkey's removal is still cancelled by a passkey alone, as before
    const pk = scheduleRemovePasskey(db, (await signedIn(db, asha.auth, T1 + 50))(), phone.id, T1 + 50)
    const stale2 = (await signedIn(db, asha.auth, T1 + 60))(T1 + 60 + 10 * 60_000)
    await expect(cancelScheduledChangeWithCode(db, stale2, pk.changeId!, asha.codes[4], T1 + 60 + 10 * 60_000)).rejects.toMatchObject({ code: 'stepup_required' })
    expect(change(db, pk.changeId!).cancelled_at).toBeNull()
  })

  it('a password session can neither schedule these nor cancel them without a saved code', async () => {
    const db = openDb(':memory:')
    const PW = 'a phished long phrase'
    const a = await passwordAccount(db, 'tara', PW)
    const n = await login(db, { handle: 'tara', password: PW }, META, T1)
    const thief = () => sessionFor(db, n.token, T1)!
    await stepUp(db, thief(), PW, META.ip, T1) // the password typed again: still no passkey confirmation
    expect(() => removeContact(db, thief(), a.linkId, T1)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(() => removeAddress(db, thief(), a.email, T1)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(() => removePassword(db, thief(), META.ip, T1)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(waiting(db, a.id)).toEqual([])
    // the owner schedules one with the passkey; the password session cannot cancel it
    const r = scheduled(removeContact(db, (await signedIn(db, a.auth, T1 + 1))(), a.linkId, T1 + 1))
    await expect(cancelScheduledChangeWithCode(db, thief(), r.changeId, undefined, T1 + 2)).rejects.toMatchObject({ code: 'stepup_required' })
    expect(() => cancelScheduledChange(db, thief(), r.changeId, T1 + 2)).toThrow(expect.objectContaining({ code: 'stepup_required' }))
    expect(change(db, r.changeId).cancelled_at).toBeNull()
  })

  it('suspending the passkey that asked cancels what it asked for', async () => {
    const db = openDb(':memory:')
    const { asha, linkId } = await withContact(db)
    const stolen = await secondPasskey(db, asha.auth, T0 + 1000) // past its cool-off by T1
    const r = scheduled(removeContact(db, (await signedIn(db, stolen.auth, T1))(), linkId, T1))
    expect(waiting(db, asha.id)[0]!.requested_by).toBe(stolen.id)
    await suspendPasskeyWithCode(db, (await signedIn(db, asha.auth, T1 + 10))(), stolen.id, asha.codes[0], T1 + 10)
    expect(change(db, r.changeId)).toMatchObject({ cancelled_by: 'requester-suspended', applied_at: null })
    expect(applyDueChanges(db, T1 + D)).toBe(0)
    expect(link(db, linkId).removed_at).toBeNull()
  })
})

describe('8j (c): a scheduled removal survives a restart and applies exactly once', () => {
  it('written to the database file, it is applied by the next process when its time comes, once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qed-fallback-'))
    try {
      const path = join(dir, 'qed.db')
      let db = openDb(path)
      const { asha, linkId } = await withContact(db)
      const s = (await signedIn(db, asha.auth, T0))()
      const email = confirmedEmail(db, s, 'asha@gmail.com', T0)
      const s1 = (await signedIn(db, asha.auth, T1))()
      scheduled(removeContact(db, s1, linkId, T1))
      scheduled(removeAddress(db, s1, email, T1))
      db.close()
      // a restart before its time applies nothing
      db = openDb(path)
      expect(applyDueChanges(db, T1 + D - 1)).toBe(0)
      db.close()
      // a later process applies both, once
      db = openDb(path)
      expect(applyDueChanges(db, T1 + D)).toBe(2)
      expect(applyDueChanges(db, T1 + D + 1)).toBe(0)
      db.close()
      db = openDb(path)
      expect(applyDueChanges(db, T1 + D + 2)).toBe(0)
      expect(link(db, linkId).removed_at).toBe(T1 + D)
      expect(db.get('SELECT removed_at FROM contact_points WHERE id = ?', email)).toEqual({ removed_at: T1 + D })
      expect(count(events(db, asha.id), 'recovery-contact-ended')).toBe(1)
      expect(count(events(db, asha.id), 'email-removed')).toBe(1)
      db.close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
