/**
 * R13 owner options on the wallet's side (server/rail.ts, server/rail-signers.ts), against the recording stand-in of the
 * rail's HTTP contract (server/rail-fake.ts). The rail's own test (chain/test/owner-options.test.ts) and the contract's
 * (chain/accounts/test/Guardian.t.sol, TimeLock.t.sol) show what the chain enforces; here, what QED collects, sends and
 * refuses:
 *   - two devices: a household whose vault needs two signatures signs each digest with two DIFFERENT passkeys of the
 *     person, one round per device; one device alone completes nothing and the same device twice is refused; the vault
 *     service receives both assertions; a cancellation still takes one;
 *   - the guardian: only an active recovery contact's passkey, a household's only, never on a wallet built before it;
 *     a recovery of a wallet with a guardian is relayed only after the contact co-signs it in their own session, with
 *     their guardian passkey and nobody else's; a contact can decline, and nothing is sent;
 *   - the time-lock: chosen at set-up and sent to the vault service; changed through the wallet's own rules; a wallet
 *     built before it says so.
 */
import { generateKeyPairSync, sign as ecSign } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { beginAddPasskey, beginSignup, finishAddPasskey, finishSignup, type RelyingParty } from './passkeys.ts'
import { createBusiness } from './workspaces.ts'
import { type Asker, railExecute, railPropose, railSetup, railSignBegin, railSignFinish, railWorkspaceId, rememberSigners } from './rail.ts'
import { beginGuardianCosign, beginGuardianWithdraw, beginVaultRecovery, declineGuardianCosign, finishGuardianCosign, finishGuardianWithdraw, finishVaultRecovery, guardianRequests, proposeGuardian, proposeTimeLock, stopVaultRecovery, vaultSignersView } from './rail-signers.ts'
import { FakeRail, fakeCancelDigest, fakeSignerId } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175', 'http://localhost:5174'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => { fake.reset() })

async function person(db: Db, handle: string): Promise<{ auth: SoftAuthenticator; who: Asker }> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  return { auth, who: { workspaceId: r.personId, personId: r.personId, role: 'owner', session: sessionFor(db, r.session.token, T0)! } }
}
async function addPasskey(db: Db, who: Asker, name: string): Promise<{ auth: SoftAuthenticator; id: string }> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginAddPasskey(db, RP, who.session, T0 + 100)
  const c = await finishAddPasskey(db, RP, who.session, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: name }, META.ua, T0 + 100)
  db.run('UPDATE webauthn_credentials SET cool_off_until = NULL WHERE id = ?', c.id) // past its 24-hour cool-off
  return { auth, id: c.id }
}
const keyOf = (a: SoftAuthenticator) => ({ x: `0x${a.x.toString('hex')}`, y: `0x${a.y.toString('hex')}` })
const allowed = (b: { challenges: { options: unknown }[] }) => (b.challenges[0]!.options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id)
const credId = (db: Db, a: SoftAuthenticator) => db.get<{ id: string }>('SELECT id FROM webauthn_credentials WHERE x = ?', a.x.toString('hex'))!.id
const fakeOf = (who: Asker) => fake.workspaces.get(railWorkspaceId(who.workspaceId))!
/** A household with a vault whose signers are the laptop and the phone, both the person's. */
async function household(db: Db, handle: string) {
  const p = await person(db, handle)
  const phone = await addPasskey(db, p.who, 'Phone')
  await railSetup(CFG, db, RP, p.who, RP.origins[0], T0 + 200)
  const w = fakeOf(p.who)
  for (const a of [phone.auth]) { const k = keyOf(a); w.signers.push({ signerId: fakeSignerId(k.x, k.y), x: k.x, y: k.y, role: 'member' }) }
  rememberSigners(db, p.who.workspaceId, { signers: w.signers, threshold: w.threshold, adminThreshold: w.adminThreshold }, T0 + 300)
  return { ...p, phone, w }
}
/** One person names another as recovery contact, accepted and in effect. */
function contactOf(db: Db, personId: string, contactId: string): void {
  db.run('INSERT INTO recovery_contacts (id, person_id, contact_id, requested_at, effective_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?)', `rc-${personId.slice(0, 6)}-${contactId.slice(0, 6)}`, personId, contactId, T0 - 10 * 86_400_000, T0 - 9 * 86_400_000, T0 - 9 * 86_400_000)
}
function recoveryKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const hex32 = (b: Buffer) => `0x${b.toString('hex').padStart(64, '0')}`
  const pub = { x: hex32(Buffer.from(jwk.x, 'base64url')), y: hex32(Buffer.from(jwk.y, 'base64url')) }
  const sign = (digest: string) => { const sig = ecSign('sha256', Buffer.from(digest.slice(2), 'hex'), { key: privateKey, dsaEncoding: 'ieee-p1363' }); return { r: hex32(sig.subarray(0, 32)), s: hex32(sig.subarray(32)) } }
  return { pub, sign }
}

describe('R13 owner options on the wallet\'s side', () => {
  it('two devices: each digest is signed by two different passkeys of the person, one device per round; one alone completes nothing; the vault service receives both', async () => {
    const db = openDb(':memory:')
    const h = await household(db, 'asha')
    h.w.threshold = 2; h.w.adminThreshold = 2 // "Require two of your devices", as the chain now holds it
    const p = await railPropose(CFG, db, h.who, { kind: 'pause' }, T0 + 400) as Record<string, unknown> & { approvalId: string; docHash: string; devices: number; proposal: { id: string } }
    expect(p.devices).toBe(2)
    // round 1: both passkeys are offered; the laptop signs; nothing is approved yet
    const b1 = await railSignBegin(db, RP, h.who, p.approvalId, T0 + 410)
    expect(b1.devices).toEqual({ needed: 2, done: 0 })
    expect(allowed(b1).sort()).toEqual([credId(db, h.auth), h.phone.id].sort())
    const r1 = await railSignFinish(CFG, db, RP, h.who, p.approvalId, b1.challenges.map((c) => ({ challengeId: c.challengeId, response: h.auth.get(c.options as never) })), p.docHash, T0 + 420)
    expect([r1.complete, r1.confirmedAt, (r1.devices as { next?: string }).next]).toEqual([false, null, 'another-device'])
    await expect(railExecute(CFG, db, h.who, p.proposal.id, p.approvalId, T0 + 425)).rejects.toMatchObject({ code: 'approval_missing' })
    // round 2: only the phone is offered; the laptop again is refused
    const b2 = await railSignBegin(db, RP, h.who, p.approvalId, T0 + 430)
    expect(b2.devices).toEqual({ needed: 2, done: 1 })
    expect(allowed(b2)).toEqual([h.phone.id])
    await expect(railSignFinish(CFG, db, RP, h.who, p.approvalId, b2.challenges.map((c) => ({ challengeId: c.challengeId, response: h.auth.get(c.options as never) })), p.docHash, T0 + 440)).rejects.toMatchObject({ code: expect.stringMatching(/same_device|not_allowed|unknown_credential|passkey/) })
    const b3 = await railSignBegin(db, RP, h.who, p.approvalId, T0 + 450)
    const r2 = await railSignFinish(CFG, db, RP, h.who, p.approvalId, b3.challenges.map((c) => ({ challengeId: c.challengeId, response: h.phone.auth.get(c.options as never) })), p.docHash, T0 + 460)
    expect([r2.complete, r2.devices]).toEqual([true, { needed: 2, done: 2 }])
    await railExecute(CFG, db, h.who, p.proposal.id, p.approvalId, T0 + 470)
    const sent = fake.seen.find((x) => x.path.endsWith(`/proposals/${p.proposal.id}/execute`))!.body as { approval: { signatures: { assertions: { publicKey: { x: string } }[] }[] } }
    expect(sent.approval.signatures[0]!.assertions.map((a) => a.publicKey.x).sort()).toEqual([keyOf(h.auth).x, keyOf(h.phone.auth).x].sort())
    // a cancellation still takes exactly one passkey
    h.w.scheduled.push({ changeId: `0x${'c2'.repeat(32)}`, kind: 'set-thresholds', summary: 'Lower the thresholds', status: 'pending', readyAt: 1 })
    const c = await railPropose(CFG, db, h.who, { kind: 'cancel-change', params: { changeId: `0x${'c2'.repeat(32)}` } }, T0 + 500) as Record<string, unknown> & { approvalId: string; docHash: string; devices: number }
    expect(c.devices).toBe(1)
    const cb = await railSignBegin(db, RP, h.who, c.approvalId, T0 + 510)
    const cr = await railSignFinish(CFG, db, RP, h.who, c.approvalId, cb.challenges.map((x) => ({ challengeId: x.challengeId, response: h.phone.auth.get(x.options as never) })), c.docHash, T0 + 520)
    expect(cr.complete).toBe(true)
  })

  it('the guardian: only an active recovery contact\'s passkey, a household\'s only, and never on a wallet built before it', async () => {
    const db = openDb(':memory:')
    const h = await household(db, 'bina')
    const friend = await person(db, 'chand'), stranger = await person(db, 'dev')
    contactOf(db, h.who.personId, friend.who.personId)
    await expect(proposeGuardian(CFG, db, h.who, { contactId: stranger.who.personId }, T0 + 600)).rejects.toMatchObject({ status: 404 })
    const out = await proposeGuardian(CFG, db, h.who, { contactId: friend.who.personId }, T0 + 600) as { proposal: { kind: string } }
    expect(out.proposal.kind).toBe('set-guardian')
    const asked = fake.seen.find((x) => x.path.endsWith('/proposals') && (x.body as { kind?: string }).kind === 'set-guardian')!.body as { params: { x: string; y: string } }
    expect(asked.params).toEqual(keyOf(friend.auth)) // the contact's passkey, as a public key: nothing of theirs is signed
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-guardian-named'`, friend.who.personId)!.n).toBe(1)
    const view = await vaultSignersView(CFG, db, h.who) as { options: { supported: boolean; guardian: { offered: boolean; contacts: { contactId: string }[] }; twoDevices: { offered: boolean; possible: boolean }; timeLock: { offered: boolean; on: boolean } } }
    expect([view.options.supported, view.options.guardian.offered, view.options.guardian.contacts.map((c) => c.contactId), view.options.twoDevices.possible, view.options.timeLock.on]).toEqual([true, true, [friend.who.personId], true, false])
    // a business's wallet: no guardian (it is a person's recovery contact)
    const bizId = createBusiness(db, h.who.personId, 'Bina Traders', T0 + 700)
    const bizWho: Asker = { ...h.who, workspaceId: bizId }
    await railSetup(CFG, db, RP, bizWho, RP.origins[0], T0 + 710).catch(() => undefined)
    await expect(proposeGuardian(CFG, db, bizWho, { contactId: friend.who.personId }, T0 + 720)).rejects.toMatchObject({ code: expect.stringMatching(/household_only|vault_not_set_up|not_permitted/) })
    // a wallet built before the options: refused, and the view says it gains nothing
    h.w.options = false
    await expect(proposeGuardian(CFG, db, h.who, { contactId: friend.who.personId }, T0 + 800)).rejects.toMatchObject({ code: 'owner_options_unavailable' })
    await expect(proposeTimeLock(CFG, db, h.who, { on: true }, T0 + 800)).rejects.toMatchObject({ code: 'owner_options_unavailable' })
    const old = await vaultSignersView(CFG, db, h.who) as { options: { supported: boolean; why: string } }
    expect(old.options.supported).toBe(false)
    expect(old.options.why).toMatch(/keeps the bytecode it was created with and gains nothing/)
  })

  it('a recovery of a wallet with a guardian is relayed only after the contact co-signs it, with the guardian passkey alone; a decline sends nothing', async () => {
    const db = openDb(':memory:')
    const h = await household(db, 'esha')
    const friend = await person(db, 'faiz'), other = await person(db, 'gita')
    contactOf(db, h.who.personId, friend.who.personId)
    const rk = recoveryKey(), g = keyOf(friend.auth)
    h.w.signers.push({ signerId: fakeSignerId(rk.pub.x, rk.pub.y), x: rk.pub.x, y: rk.pub.y, role: 'recovery' })
    h.w.signers.push({ signerId: fakeSignerId(g.x, g.y), x: g.x, y: g.y, role: 'guardian' }) // the chain's guardian, as set behind the delay
    // the person recovers onto a new passkey; the guardian is named, and the window is a day
    const fresh = await addPasskey(db, h.who, 'New phone')
    const begin = await beginVaultRecovery(CFG, db, RP, h.who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 1000) as { requestId: string; digest: string; deadline: string; confirm: { challengeId: string; options: unknown }; guardian?: { person: string } }
    expect(begin.guardian?.person).toBe('faiz')
    expect(Number(begin.deadline) - Math.floor((T0 + 1000) / 1000)).toBe(23 * 3600)
    const conf = { challengeId: begin.confirm.challengeId, response: fresh.auth.get(begin.confirm.options as never) }
    const codeSig = rk.sign(begin.digest)
    const waiting = await finishVaultRecovery(CFG, db, RP, h.who, { requestId: begin.requestId, signature: codeSig, confirmation: conf }, T0 + 1010)
    expect(waiting).toMatchObject({ requestId: begin.requestId, awaitingGuardian: { person: 'faiz' } })
    expect(fake.seen.some((x) => x.path.endsWith('/recoveries')), 'nothing relayed before the guardian co-signs').toBe(false)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-guardian-request'`, friend.who.personId)!.n).toBe(1)
    // only the guardian sees it and can answer it
    expect((guardianRequests(db, other.who, T0 + 1020) as { requests: unknown[] }).requests).toEqual([])
    await expect(beginGuardianCosign(db, RP, other.who, begin.requestId, T0 + 1020)).rejects.toMatchObject({ status: 404 })
    expect((guardianRequests(db, friend.who, T0 + 1020) as { requests: { requestId: string; from: { name: string } }[] }).requests.map((r) => [r.requestId, r.from.name])).toEqual([[begin.requestId, 'esha']])
    // the contact co-signs with the guardian passkey: offered to it alone, over the recovery's own digest
    const cb = await beginGuardianCosign(db, RP, friend.who, begin.requestId, T0 + 1030) as { challengeId: string; options: { allowCredentials: { id: string }[]; challenge: string } }
    expect(cb.options.allowCredentials.map((c) => c.id)).toEqual([credId(db, friend.auth)])
    expect(Buffer.from(cb.options.challenge, 'base64url').toString('hex')).toBe(begin.digest.slice(2))
    const done = await finishGuardianCosign(CFG, db, RP, friend.who, begin.requestId, { challengeId: cb.challengeId, response: friend.auth.get(cb.options as never) }, T0 + 1040) as { jobId: string }
    expect(done.jobId).toBeTruthy()
    const relayed = fake.seen.find((x) => x.path.endsWith('/recoveries'))!.body as { cosign: { publicKey: { x: string } }; signature: { r: string } }
    expect([relayed.cosign.publicKey.x, relayed.signature]).toEqual([g.x, codeSig]) // the guardian's key, and the code's signature as the person gave it
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-recovery' AND title LIKE '%co-signed%'`, h.who.workspaceId)!.n).toBe(1)
    // R13 review fix F1: the contact, misled, withdraws the co-signature: its own passkey only, over the cancel digest the vault
    // service gives for that recovery; the household is told; withdrawing twice is refused
    expect((guardianRequests(db, friend.who, T0 + 1050) as { cosigned: { requestId: string }[] }).cosigned.map((r) => r.requestId)).toEqual([begin.requestId])
    expect((guardianRequests(db, other.who, T0 + 1050) as { cosigned: unknown[] }).cosigned).toEqual([])
    await expect(beginGuardianWithdraw(CFG, db, RP, other.who, begin.requestId, T0 + 1050)).rejects.toMatchObject({ status: 404 })
    const wb = await beginGuardianWithdraw(CFG, db, RP, friend.who, begin.requestId, T0 + 1060) as { challengeId: string; options: { allowCredentials: { id: string }[]; challenge: string } }
    expect(wb.options.allowCredentials.map((c) => c.id)).toEqual([credId(db, friend.auth)])
    const recId = ((fake.jobs.get(done.jobId)!.result as { evidence: { recoveryId: string } }).evidence.recoveryId)
    expect(Buffer.from(wb.options.challenge, 'base64url').toString('hex')).toBe(fakeCancelDigest(railWorkspaceId(h.who.workspaceId), recId).slice(2))
    const wd = await finishGuardianWithdraw(CFG, db, RP, friend.who, begin.requestId, { challengeId: wb.challengeId, response: friend.auth.get(wb.options as never) }, T0 + 1070) as { jobId: string }
    expect(fake.jobs.get(wd.jobId)!.result).toMatchObject({ outcome: 'executed' })
    expect((fake.sent(`/recoveries/${recId}/withdraw`)[0]!.body as { assertion: { publicKey: { x: string } } }).assertion.publicKey.x).toBe(g.x)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-recovery' AND title LIKE '%withdrew%'`, h.who.workspaceId)!.n).toBe(1)
    expect((guardianRequests(db, friend.who, T0 + 1080) as { cosigned: unknown[] }).cosigned).toEqual([])
    await expect(beginGuardianWithdraw(CFG, db, RP, friend.who, begin.requestId, T0 + 1080)).rejects.toMatchObject({ code: 'already_withdrawn' })
    // a second recovery the contact declines: nothing is sent
    const rk2 = recoveryKey()
    h.w.signers.push({ signerId: fakeSignerId(rk2.pub.x, rk2.pub.y), x: rk2.pub.x, y: rk2.pub.y, role: 'recovery' })
    const fresh2 = await addPasskey(db, h.who, 'Tablet')
    const b2 = await beginVaultRecovery(CFG, db, RP, h.who, { recoveryKey: rk2.pub, credentialId: fresh2.id }, T0 + 2000) as { requestId: string; digest: string; confirm: { challengeId: string; options: unknown } }
    await finishVaultRecovery(CFG, db, RP, h.who, { requestId: b2.requestId, signature: rk2.sign(b2.digest), confirmation: { challengeId: b2.confirm.challengeId, response: fresh2.auth.get(b2.confirm.options as never) } }, T0 + 2010)
    expect(declineGuardianCosign(db, friend.who, b2.requestId, T0 + 2020)).toEqual({ requestId: b2.requestId, declined: true })
    expect(fake.seen.filter((x) => x.path.endsWith('/recoveries')).length).toBe(1)
    await expect(beginGuardianCosign(db, RP, friend.who, b2.requestId, T0 + 2030)).rejects.toMatchObject({ code: 'request_closed' })
  })

  it('H1: the household stops a recovery its guardian co-signed, through QED, with a fresh confirmation by a usable passkey', async () => {
    const db = openDb(':memory:')
    const h = await household(db, 'hana')
    const friend = await person(db, 'ivan')
    contactOf(db, h.who.personId, friend.who.personId)
    const rk = recoveryKey(), g = keyOf(friend.auth)
    h.w.signers.push({ signerId: fakeSignerId(rk.pub.x, rk.pub.y), x: rk.pub.x, y: rk.pub.y, role: 'recovery' })
    h.w.signers.push({ signerId: fakeSignerId(g.x, g.y), x: g.x, y: g.y, role: 'guardian' })
    const fresh = await addPasskey(db, h.who, 'New phone')
    const begin = await beginVaultRecovery(CFG, db, RP, h.who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 1000) as { requestId: string; digest: string; confirm: { challengeId: string; options: unknown } }
    await finishVaultRecovery(CFG, db, RP, h.who, { requestId: begin.requestId, signature: rk.sign(begin.digest), confirmation: { challengeId: begin.confirm.challengeId, response: fresh.auth.get(begin.confirm.options as never) } }, T0 + 1010)
    const cb = await beginGuardianCosign(db, RP, friend.who, begin.requestId, T0 + 1020) as { challengeId: string; options: unknown }
    const done = await finishGuardianCosign(CFG, db, RP, friend.who, begin.requestId, { challengeId: cb.challengeId, response: friend.auth.get(cb.options as never) }, T0 + 1030) as { jobId: string }
    const recId = (fake.jobs.get(done.jobId)!.result as { evidence: { recoveryId: string } }).evidence.recoveryId
    // confirmed afresh by the laptop: the vault service's sentinel key stops it, and the household is told
    const laptop = db.get<{ id: string }>('SELECT id FROM webauthn_credentials WHERE person_id = ? ORDER BY created_at LIMIT 1', h.who.personId)!.id
    const confirmed = (credentialId: string) => ({ ...h.who, session: { ...h.who.session, stepUpFresh: true, confirmedBy: credentialId } })
    const stopped = await stopVaultRecovery(CFG, db, confirmed(laptop), recId, T0 + 1040) as { jobId: string }
    expect(fake.jobs.get(stopped.jobId)!.result).toMatchObject({ outcome: 'executed', evidence: { recoveryId: recId } })
    expect(fake.sent(`/recoveries/${recId}/stop`).length).toBe(1)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-recovery' AND title LIKE '%stopped%'`, h.who.workspaceId)!.n).toBe(1)
    // not twice; never with a suspended passkey's confirmation, and never for someone else's vault
    await expect(stopVaultRecovery(CFG, db, confirmed(laptop), recId, T0 + 1050)).rejects.toMatchObject({ code: 'stop_refused' })
    // each attempt carries its own idempotency key, so a refused attempt is never replayed to a later one (re-check of H1)
    const stopKeys = fake.sent(`/recoveries/${recId}/stop`).map((x) => x.key ?? '')
    for (const k of stopKeys) expect(k).toMatch(new RegExp(`^vst-${recId}-[0-9a-f]{16}$`))
    expect(new Set(stopKeys).size).toBe(stopKeys.length)
    db.run('UPDATE webauthn_credentials SET suspended_at = ? WHERE id = ?', T0 + 1060, laptop)
    await expect(stopVaultRecovery(CFG, db, confirmed(laptop), recId, T0 + 1070)).rejects.toMatchObject({ code: 'passkey_not_usable' })
    const theirs = { ...friend.who, workspaceId: h.who.workspaceId, session: { ...friend.who.session, stepUpFresh: true, confirmedBy: credId(db, friend.auth) } }
    await expect(stopVaultRecovery(CFG, db, theirs, recId, T0 + 1080)).rejects.toMatchObject({ status: 403 })
  })

  it('the time-lock: chosen at set-up and sent to the vault service; changed through the wallet\'s rules; refused when it would change nothing', async () => {
    const db = openDb(':memory:')
    const p = await person(db, 'hari')
    await expect(railSetup(CFG, db, RP, p.who, RP.origins[0], T0 + 100, { timeLock: 'yes' })).rejects.toMatchObject({ message: 'timeLock is true or false.' })
    await railSetup(CFG, db, RP, p.who, RP.origins[0], T0 + 100, { timeLock: true })
    const w = fakeOf(p.who)
    expect(w.request?.timeLock).toBe(true)
    await expect(proposeTimeLock(CFG, db, p.who, { on: true }, T0 + 200)).rejects.toMatchObject({ code: 'nothing_to_change' })
    const off = await proposeTimeLock(CFG, db, p.who, { on: false }, T0 + 200) as { proposal: { kind: string; terms: { on: boolean } } }
    expect([off.proposal.kind, off.proposal.terms.on]).toEqual(['set-time-lock', false])
    await expect(proposeTimeLock(CFG, db, p.who, { on: 'no' }, T0 + 200)).rejects.toMatchObject({ message: 'The time-lock is { on: true } or { on: false }.' })
    // a wallet set up without it sends no time-lock field at all (the request every earlier wallet sent)
    const q = await person(db, 'isha')
    await railSetup(CFG, db, RP, q.who, RP.origins[0], T0 + 100)
    expect('timeLock' in (fakeOf(q.who).request ?? {})).toBe(false)
  })

  it('a guardian on the chain is never counted as one of the household\'s signers', async () => {
    const db = openDb(':memory:')
    const h = await household(db, 'jaya')
    const friend = await person(db, 'kabir')
    const g = keyOf(friend.auth)
    const v = rememberSigners(db, h.who.workspaceId, { signers: [...h.w.signers, { x: g.x, y: g.y, role: 'guardian' }], threshold: 1, adminThreshold: 1 }, T0 + 500)!
    expect(v.current!.signers.find((k) => k.x === g.x)?.role).toBe('guardian')
  })
})
