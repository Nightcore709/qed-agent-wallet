/**
 * A new passkey's cool-off (R13 hardening brief item 3; RISK-068, Q-062). A passkey added to an account cannot, for 24
 * hours, approve a request above ₹10,000, loosen a protection or add a signer; during those hours any older passkey removes
 * it at once (not after the 72-hour delay a removal otherwise waits), and the person is told when it is added and when it is
 * removed. Recovery's own rules stay as they are: a passkey a recovery registers signs in only, until its own restoration.
 *
 * Each rule is checked both ways: what the new passkey may not do in its first 24 hours, and that the same act is allowed
 * to an older passkey, or to the same passkey once its cool-off is over (so the check is not simply refusing everything).
 */
import { describe, expect, it } from 'vitest'
import { createApproval, signApproval } from './approvals.ts'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { changeProfile } from './loosening.ts'
import { DEFAULT_OPENING, getProfile, openHousehold } from './household.ts'
import { seedRegistry } from './registry.ts'
import {
  applyDueChanges, beginAddPasskey, beginLogin, beginReauth, beginSignup, COOL_OFF_MS, coolingOffUntil, finishAddPasskey, finishLogin, finishReauth, finishSignup,
  NEW_PASSKEY_LIMIT_PAISE, nominateContact, refuseCoolingOff, type RelyingParty, regenerateRecoveryCodes, scheduleRemovePasskey, securityView, settledCredentials,
} from './passkeys.ts'
import { sha256hex } from './receipts.ts'
import { SoftAuthenticator } from './softauthn.ts'

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 20, 10, 0)
type DB = ReturnType<typeof openDb>

async function account(db: DB) {
  seedRegistry(db, { presentation: true })
  const laptop = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle: 'asha', displayName: 'Asha' }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: laptop.create(b.options as never) }, META, T0)
  openHousehold(db, r.personId, DEFAULT_OPENING, {}, T0)
  return { laptop, personId: r.personId, token: r.session.token }
}
async function addPhone(db: DB, token: string, now: number): Promise<SoftAuthenticator> {
  const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
  const s = sessionFor(db, token, now)!
  const add = await beginAddPasskey(db, RP, s, now)
  await finishAddPasskey(db, RP, s, { challengeId: add.challengeId, response: phone.create(add.options as never), passkeyName: 'Phone' }, META.ua, now)
  return phone
}
async function signin(db: DB, auth: SoftAuthenticator, now: number): Promise<string> {
  const b = await beginLogin(db, RP, now)
  return (await finishLogin(db, RP, { challengeId: b.challengeId, response: auth.get(b.options as never) }, META, now)).token
}
/** A request of this size, signed with this authenticator's passkey over its own challenge. */
async function sign(db: DB, personId: string, auth: SoftAuthenticator, token: string, sizePaise: number, now: number) {
  const document = JSON.stringify({ v: 1, kind: 'payment', sizePaise, what: `pay ${sizePaise}` })
  const a = createApproval(db, personId, { purpose: 'action', subject: `action:test-${sizePaise}-${now}`, document }, now)
  const s = sessionFor(db, token, now)!
  const { approvalChallenge } = await import('./passkeys.ts')
  const b = await beginReauth(db, RP, personId, 'approval', approvalChallenge(a.id, a.doc_hash), { approvalId: a.id, docHash: a.doc_hash }, now)
  const v = await finishReauth(db, RP, s, 'approval', { challengeId: b.challengeId, response: auth.get(b.options as never) }, now)
  return signApproval(db, personId, a.id, { personId, role: 'owner', credentialId: v.credential.id, evidence: {}, sessionHash: s.sessionHash }, sha256hex(document), now)
}

describe('a new passkey cools off for 24 hours (RISK-068, Q-062)', () => {
  it('approves up to ₹10,000 at once, nothing above it until the cool-off ends; an older passkey approves above it meanwhile', async () => {
    const db = openDb(':memory:')
    const { laptop, personId, token } = await account(db)
    const phone = await addPhone(db, token, T0 + 1000)
    const phoneToken = await signin(db, phone, T0 + 2000)
    expect((await sign(db, personId, phone, phoneToken, NEW_PASSKEY_LIMIT_PAISE, T0 + 3000)).complete).toBe(true)
    await expect(sign(db, personId, phone, phoneToken, NEW_PASSKEY_LIMIT_PAISE + 1, T0 + 4000)).rejects.toMatchObject({ status: 409, code: 'passkey_cooling_off' })
    // nothing of the refused signature was kept
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM approval_signatures s JOIN approvals a ON a.id = s.approval_id WHERE a.subject LIKE ?`, `action:test-${NEW_PASSKEY_LIMIT_PAISE + 1}-%`)!.n).toBe(0)
    // the older passkey signs the same size at once
    const laptopToken = await signin(db, laptop, T0 + 5000)
    expect((await sign(db, personId, laptop, laptopToken, 50_000_000, T0 + 6000)).complete).toBe(true)
    // once the cool-off is over, the phone signs any size
    const after = T0 + 1000 + COOL_OFF_MS + 1
    expect((await sign(db, personId, phone, await signin(db, phone, after), 50_000_000, after + 1)).complete).toBe(true)
  })

  it('loosens no protection and makes no new codes or recovery contacts while it cools off; an older passkey can', async () => {
    const db = openDb(':memory:')
    const { laptop, personId, token } = await account(db)
    const phone = await addPhone(db, token, T0 + 1000)
    const s = sessionFor(db, await signin(db, phone, T0 + 2000), T0 + 2000)!
    expect(s.confirmedBy).toBe(phone.id)
    const line = getProfile(db, personId).line
    const loosen = (sess: typeof s, now: number) => changeProfile(db, { personId, workspaceId: personId, fresh: sess.stepUpFresh, beforeLoosening: () => refuseCoolingOff(db, sess, 'loosen a protection', now) }, { line: Math.max(0, line - 100_000) }, now)
    expect(() => loosen(s, T0 + 2000)).toThrow(/cannot loosen a protection/)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM scheduled_changes WHERE kind = 'loosen-profile'`)!.n).toBe(0)
    // tightening is not loosening: allowed at once
    changeProfile(db, { personId, workspaceId: personId, fresh: true, beforeLoosening: () => refuseCoolingOff(db, s, 'loosen a protection', T0 + 2000) }, { line: line + 100_000 }, T0 + 2000)
    expect(getProfile(db, personId).line).toBe(line + 100_000)
    expect(() => regenerateRecoveryCodes(db, s, T0 + 2000)).toThrow(/cannot make new saved codes/)
    expect(() => nominateContact(db, s, 'nobody', T0 + 2000)).toThrow(/cannot name a recovery contact/)
    // the older passkey loosens: it is scheduled, as every loosening is
    const ls = sessionFor(db, await signin(db, laptop, T0 + 3000), T0 + 3000)!
    expect(loosen(ls, T0 + 3000).waiting).not.toBeNull()
    expect(regenerateRecoveryCodes(db, ls, T0 + 3000, unusedCodeId(db, ls.userId))).toHaveLength(10)
  })

  it('becomes no vault signer while it cools off', async () => {
    const db = openDb(':memory:')
    const { laptop, personId, token } = await account(db)
    const phone = await addPhone(db, token, T0 + 1000)
    expect(settledCredentials(db, personId, T0 + 2000).map((c) => c.id)).toEqual([laptop.id])
    expect(settledCredentials(db, personId, T0 + 1000 + COOL_OFF_MS).map((c) => c.id).sort()).toEqual([laptop.id, phone.id].sort())
  })

  it('an older passkey removes it at once, its sessions end, and the person is told; it cannot remove the older one', async () => {
    const db = openDb(':memory:')
    const { laptop, personId, token } = await account(db)
    const phone = await addPhone(db, token, T0 + 1000)
    const phoneToken = await signin(db, phone, T0 + 2000)
    const ps = sessionFor(db, phoneToken, T0 + 2000)!
    // the new passkey cannot ask for the older one's removal
    expect(() => scheduleRemovePasskey(db, ps, laptop.id, T0 + 2000)).toThrow(/cannot remove another passkey/)
    const ls = sessionFor(db, await signin(db, laptop, T0 + 3000), T0 + 3000)!
    // H2: at once only with a saved code (unusedCodeId stands in for one matched by removePasskeyWithCode); without one it
    // would be scheduled like any removal, which the test of removePasskeyWithCode shows
    const out = scheduleRemovePasskey(db, ls, phone.id, T0 + 3000, unusedCodeId(db, ls.userId))
    expect(out).toMatchObject({ removed: true, changeId: null, effectiveAt: T0 + 3000 })
    expect(db.get<{ removed_at: number | null }>('SELECT removed_at FROM webauthn_credentials WHERE id = ?', phone.id)!.removed_at).toBe(T0 + 3000)
    expect(sessionFor(db, phoneToken, T0 + 3001)).toBeNull()
    // told: on adding (with the cool-off said), and on its removal, as urgent notices
    const kinds = db.all<{ kind: string }>('SELECT kind FROM security_events WHERE person_id = ? ORDER BY id', personId).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['passkey-added', 'passkey-removed-in-cool-off']))
    const notices = db.all<{ title: string; body: string }>(`SELECT title, body FROM notices WHERE user_id = ? AND kind = 'security-change' ORDER BY ts`, personId)
    expect(notices.find((n) => /was added/.test(n.title))?.body).toMatch(/first 24 hours it cannot approve payments above ₹10,000/)
    expect(notices.some((n) => /newly added passkey was removed/.test(n.title))).toBe(true)
  })

  it('after its cool-off, removing it waits the protection delay again, as for any passkey', async () => {
    const db = openDb(':memory:')
    const { laptop, token } = await account(db)
    const phone = await addPhone(db, token, T0 + 1000)
    const after = T0 + 1000 + COOL_OFF_MS + 1
    expect(coolingOffUntil(db, phone.id, after)).toBeNull()
    const ls = sessionFor(db, await signin(db, laptop, after), after)!
    const out = scheduleRemovePasskey(db, ls, phone.id, after)
    expect(out.removed).toBeUndefined()
    expect(out.changeId).not.toBeNull()
    expect(applyDueChanges(db, after + 1)).toBe(0)
  })

  it('the account\'s first passkey has none, and Security shows each passkey\'s cool-off', async () => {
    const db = openDb(':memory:')
    const { laptop, personId, token } = await account(db)
    expect(coolingOffUntil(db, laptop.id, T0)).toBeNull()
    const phone = await addPhone(db, token, T0 + 1000)
    const view = securityView(db, sessionFor(db, token, T0 + 2000)!, T0 + 2000) as { passkeys: { id: string; coolOffUntil: number | null }[]; delays: { coolOffMs: number; newPasskeyLimitPaise: number } }
    expect(view.passkeys.find((p) => p.id === laptop.id)!.coolOffUntil).toBeNull()
    expect(view.passkeys.find((p) => p.id === phone.id)!.coolOffUntil).toBe(T0 + 1000 + COOL_OFF_MS)
    expect(view.delays).toMatchObject({ coolOffMs: COOL_OFF_MS, newPasskeyLimitPaise: NEW_PASSKEY_LIMIT_PAISE })
    expect(personId).toBeTruthy()
  })

  it('a session whose confirmation is fresh but whose passkey is unknown (from before schema v8, part r) confirms again', () => {
    expect(() => refuseCoolingOff(openDb(':memory:'), { stepUpFresh: true, confirmedBy: null }, 'loosen a protection', T0)).toThrow(/Confirm with one of your passkeys again/)
  })
})
