/**
 * The wallet's side of a vault's signers and recovery (server/rail-signers.ts; RISK-053), against a recording stand-in
 * of the rail's HTTP contract (server/rail-fake.ts). The rail's own tests show what the chain accepts
 * (chain/test/signers.test.ts). Here: which passkey QED lets become a signer, what it sends, to which vault, what it
 * refuses, what a suspended passkey can no longer do through QED, that the recovery code never reaches the server,
 * and which workspaces QED declares linked for the authority budget.
 */
import { generateKeyPairSync, sign as ecSign, type KeyObject } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { beginAddPasskey, beginSignup, COOL_OFF_MS, finishAddPasskey, finishSignup, type RelyingParty, suspendPasskey } from './passkeys.ts'
import { addMember, createBusiness, setPolicy } from './workspaces.ts'
import { type Asker, railExecute, railOverview, railPolicySchedule, railPropose, railSetup, railSignBegin, railSignFinish, railWorkspaceId } from './rail.ts'
import { beginRecoveryKey, beginVaultRecovery, containPerson, finishVaultRecovery, proposeAddSigner, proposeRecoveryKey, proposeRemoveSigners, proposeThresholds, vaultSignersView } from './rail-signers.ts'
import { FakeRail, fakeSignerId, type FakeSigner } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'

// a saved code the person has not used (H2: suspending down to one passkey and new codes spend one)
const unusedCodeId = (db: import('./core.ts').Db, personId: string): string | undefined => db.get<{ id: string }>('SELECT id FROM recovery_codes WHERE person_id = ? AND used_at IS NULL AND replaced_at IS NULL LIMIT 1', personId)?.id

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175', 'http://localhost:5174'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 22, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => {
  fake.reset()
  // what the chain does when these run (chain/test/signers.test.ts shows it for real)
  fake.outcome['add-signer'] = (p, w) => { w.signers.push({ signerId: fakeSignerId(String(p!.params.x), String(p!.params.y)), x: String(p!.params.x), y: String(p!.params.y), role: p!.params.role as 'member' }); return { outcome: 'executed', summary: 'Added.', evidence: {} } }
  fake.outcome['remove-signers'] = (p, w) => { const changeId = `0x${'c1'.repeat(32)}`; w.scheduled.push({ changeId, kind: 'remove-signers', summary: 'Remove 1 signer', status: 'pending', readyAt: 1, targets: w.signers.filter((s) => (p!.params.signerIds as string[]).includes(s.signerId)) }); return { outcome: 'scheduled', summary: 'Scheduled.', evidence: { changeId, readyAt: 1 } } }
})

async function person(db: Db, handle: string): Promise<{ auth: SoftAuthenticator; who: Asker }> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  return { auth, who: { workspaceId: r.personId, personId: r.personId, role: 'owner', session: sessionFor(db, r.session.token, T0)! } }
}
/**
 * A passkey added to the account, past its 24-hour cool-off (server/passkeys.ts; RISK-068), as these tests are about vault
 * signers: `inCoolOff` keeps it in the cool-off for the test that is about that.
 */
async function addPasskey(db: Db, who: Asker, name: string, at = T0 + 100, inCoolOff = false): Promise<{ auth: SoftAuthenticator; id: string }> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginAddPasskey(db, RP, who.session, at)
  const c = await finishAddPasskey(db, RP, who.session, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: name }, META.ua, at)
  if (!inCoolOff) db.run('UPDATE webauthn_credentials SET cool_off_until = NULL WHERE id = ?', c.id) // what 24 hours would leave
  return { auth, id: c.id }
}
const keyOf = (a: SoftAuthenticator) => ({ x: `0x${a.x.toString('hex')}`, y: `0x${a.y.toString('hex')}` })
const allowed = (b: { challenges: { options: unknown }[] }) => (b.challenges[0]!.options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id)
/** Every signer passkey signs; then QED sends it. */
async function signAndSend(db: Db, who: Asker, p: Record<string, unknown>, auth: SoftAuthenticator, at: number) {
  const begin = await railSignBegin(db, RP, who, String(p.approvalId), at)
  await railSignFinish(CFG, db, RP, who, String(p.approvalId), begin.challenges.map((c) => ({ challengeId: c.challengeId, response: auth.get(c.options as never) })), String(p.docHash), at + 1)
  return railExecute(CFG, db, who, String((p.proposal as { id: string }).id), String(p.approvalId), at + 2)
}
/** The signers view, as far as these tests read it. */
interface SignersOut { signers: { signerId: string; role: string; frozen?: boolean; passkey: { name: string; state: string; you: boolean } | null; unknown?: boolean }[]; canAdd: unknown[]; warnings: string[]; recovery: { keys: number } }
const signersView = async (db: Db, who: Asker) => (await vaultSignersView(CFG, db, who)) as unknown as SignersOut
const hex32 = (b: Buffer) => `0x${b.toString('hex').padStart(64, '0')}`
function recoveryKey(): { key: KeyObject; pub: { x: string; y: string }; sign: (digest: string) => { r: string; s: string } } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const pub = { x: hex32(Buffer.from(jwk.x, 'base64url')), y: hex32(Buffer.from(jwk.y, 'base64url')) }
  // what WebCrypto's ECDSA with SHA-256 gives: r||s over SHA-256 of the 32 digest bytes
  const sign = (digest: string) => { const sig = ecSign('sha256', Buffer.from(digest.slice(2), 'hex'), { key: privateKey, dsaEncoding: 'ieee-p1363' }); return { r: hex32(sig.subarray(0, 32)), s: hex32(sig.subarray(32)) } }
  return { key: privateKey, pub, sign }
}

describe('vault signers: who may become one, and what QED sends', () => {
  it('a passkey added in the last 24 hours is not made a signer until its cool-off ends (RISK-068, Q-062)', async () => {
    const db = openDb(':memory:')
    const { who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const phone = await addPasskey(db, who, 'Phone', T0 + 100, true)
    await expect(proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000)).rejects.toMatchObject({ status: 409, code: 'passkey_cooling_off' })
    expect((await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 100 + COOL_OFF_MS + 1)).approvalId).toBeTruthy()
  })

  it('adds a newly registered passkey of the same person: the current signers sign the exact terms; from then on it signs too', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const phone = await addPasskey(db, who, 'Phone')
    const v0 = await signersView(db, who)
    expect(v0.signers).toMatchObject([{ role: 'member', passkey: { name: 'asha\'s laptop', you: true, state: 'active' } }])
    expect(v0.canAdd).toEqual([{ credentialId: phone.id, name: 'Phone', person: { name: 'asha', handle: 'asha' } }])
    // someone else's passkey is never offered or accepted
    const ravi = await person(db, 'ravi')
    await expect(proposeAddSigner(CFG, db, who, { credentialId: ravi.auth.id }, T0 + 1000)).rejects.toMatchObject({ code: 'not_found' })
    await expect(proposeAddSigner(CFG, db, who, { credentialId: phone.id, role: 'recovery' }, T0 + 1000)).rejects.toMatchObject({ code: 'invalid' })
    const p = await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000)
    expect(fake.proposed('add-signer').map((x) => [x.ws, x.params])).toEqual([[railWorkspaceId(who.workspaceId), { ...keyOf(phone.auth), role: 'member' }]])
    const doc = JSON.parse(db.get<{ document: string }>('SELECT document FROM approvals WHERE id = ?', String(p.approvalId))!.document) as { passkey: { name: string; registeredAt: number } }
    expect(doc.passkey).toMatchObject({ name: 'Phone' })
    // only a passkey that is already a signer may sign the addition
    expect(allowed(await railSignBegin(db, RP, who, String(p.approvalId), T0 + 2000))).toEqual([auth.id])
    await signAndSend(db, who, p, auth, T0 + 3000)
    // the vault's signers are read again: the phone is one, and is offered for the next approval
    const v1 = await signersView(db, who)
    expect(v1.signers.map((s) => s.passkey?.name)).toEqual(['asha\'s laptop', 'Phone'])
    expect(v1.canAdd).toEqual([])
    expect((await railOverview(CFG, db, RP, who)).passkeys).toMatchObject([{ name: 'asha\'s laptop', signer: true }, { name: 'Phone', signer: true }])
    const next = await railPropose(CFG, db, who, { kind: 'pause', params: {} }, T0 + 4000)
    expect(allowed(await railSignBegin(db, RP, who, String(next.approvalId), T0 + 4100)).sort()).toEqual([auth.id, phone.id].sort())
    await expect(proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 5000)).rejects.toMatchObject({ code: 'already_a_signer' })
  })

  it('a suspended passkey: QED offers it for nothing, refuses to send what it signed before, and warns that the chain still counts it until its removal applies', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const phone = await addPasskey(db, who, 'Phone')
    await signAndSend(db, who, await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000), auth, T0 + 1100)
    await signersView(db, who)
    // the phone signs a pause, then is reported stolen and suspended before the pause is sent
    const p = await railPropose(CFG, db, who, { kind: 'pause', params: {} }, T0 + 2000)
    const begin = await railSignBegin(db, RP, who, String(p.approvalId), T0 + 2100)
    const viaPhone = begin.challenges.map((c) => ({ challengeId: c.challengeId, response: phone.auth.get(c.options as never) }))
    await railSignFinish(CFG, db, RP, who, String(p.approvalId), viaPhone, String(p.docHash), T0 + 2200)
    suspendPasskey(db, who.session, phone.id, T0 + 2300, unusedCodeId(db, who.session.userId))
    await expect(railExecute(CFG, db, who, String((p.proposal as { id: string }).id), String(p.approvalId), T0 + 2400)).rejects.toMatchObject({ code: 'signer_suspended' })
    expect(fake.sent('/execute').filter((s) => s.path.includes(String((p.proposal as { id: string }).id)))).toEqual([])
    // it is offered for nothing, cannot be added anywhere, and the view says what to do on the chain
    const p2 = await railPropose(CFG, db, who, { kind: 'pause', params: {} }, T0 + 2500)
    expect(allowed(await railSignBegin(db, RP, who, String(p2.approvalId), T0 + 2600))).toEqual([auth.id])
    const v = await signersView(db, who)
    expect(v.signers.find((s) => s.passkey?.name === 'Phone')).toMatchObject({ passkey: { state: 'suspended' } })
    expect(v.warnings.join(' ')).toMatch(/"Phone" is suspended in QED and still a signer on the chain\. QED is freezing it there/)
  })

  it('R13: suspending a passkey freezes it on the chain at once and once; the view and the history say what it can still do', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const phone = await addPasskey(db, who, 'Phone')
    await signAndSend(db, who, await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000), auth, T0 + 1100)
    expect(await containPerson(CFG, db, who.personId, T0 + 1200)).toEqual({ frozen: [], failed: [], unavailable: false })
    suspendPasskey(db, who.session, phone.id, T0 + 2300, unusedCodeId(db, who.session.userId))
    expect(await containPerson(CFG, db, who.personId, T0 + 2400)).toEqual({ frozen: ['Phone'], failed: [], unavailable: false })
    expect(fake.sent('/signers/freeze').map((x) => x.body)).toEqual([{ signerId: fakeSignerId(keyOf(phone.auth).x, keyOf(phone.auth).y) }])
    const v = await signersView(db, who)
    expect(v.signers.find((x) => x.passkey?.name === 'Phone')).toMatchObject({ frozen: true, passkey: { state: 'suspended' } })
    expect(v.signers.find((x) => x.passkey?.name === 'asha\'s laptop')).toMatchObject({ frozen: false })
    expect(v.warnings.join(' ')).toMatch(/"Phone" is suspended in QED and frozen on the chain: its signature moves no money and changes nothing/)
    // the engine's next round asks again: nothing more is sent for a member already frozen
    await containPerson(CFG, db, who.personId, T0 + 2500)
    expect(fake.sent('/signers/freeze')).toHaveLength(1)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-signer-frozen'`, who.workspaceId)!.n).toBe(1)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM security_events WHERE person_id = ? AND kind = 'vault-signer-frozen'`, who.personId)!.n).toBe(1)
  })

  it('R13: a wallet set up before QED could freeze a passkey: nothing is sent, and the view says the chain still accepts it', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'ravi')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    fake.workspaces.get(railWorkspaceId(who.workspaceId))!.sentinel = false
    const phone = await addPasskey(db, who, 'Phone')
    await signAndSend(db, who, await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000), auth, T0 + 1100)
    suspendPasskey(db, who.session, phone.id, T0 + 2300, unusedCodeId(db, who.session.userId))
    expect(await containPerson(CFG, db, who.personId, T0 + 2400)).toMatchObject({ frozen: [], unavailable: true })
    expect(fake.sent('/signers/freeze')).toEqual([])
    const v = await signersView(db, who)
    expect(v.warnings.join(' ')).toMatch(/set up before QED could freeze a passkey there: schedule its removal/)
  })

  it('removing a lost passkey is scheduled on the chain; QED never offers the removed passkey to cancel it, and never lets the last signers go', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const phone = await addPasskey(db, who, 'Phone')
    await signAndSend(db, who, await proposeAddSigner(CFG, db, who, { credentialId: phone.id }, T0 + 1000), auth, T0 + 1100)
    // a key on the account that is nobody's passkey here (added outside QED, for instance by a thief): shown, and removable with the others
    const w = fake.workspaces.get(railWorkspaceId(who.workspaceId))!
    const stray: FakeSigner = { signerId: fakeSignerId('0x01', '0x02'), x: `0x${'0'.repeat(63)}1`, y: `0x${'0'.repeat(63)}2`, role: 'member' }
    w.signers.push(stray)
    const v = await signersView(db, who)
    expect(v.signers.find((s) => s.signerId === stray.signerId)).toMatchObject({ passkey: null, unknown: true })
    expect(v.warnings.join(' ')).toMatch(/not a passkey of anyone in this workspace/)
    await expect(proposeRemoveSigners(CFG, db, who, { credentialIds: [auth.id, phone.id], signerIds: [stray.signerId] }, T0 + 2000)).rejects.toMatchObject({ code: 'would_break_quorum' })
    expect(fake.proposed('remove-signers')).toEqual([])
    const r = await proposeRemoveSigners(CFG, db, who, { credentialIds: [auth.id], signerIds: [stray.signerId] }, T0 + 2000)
    expect(fake.proposed('remove-signers')[0]!.params).toEqual({ signerIds: [fakeSignerId(keyOf(auth).x, keyOf(auth).y), stray.signerId].sort() })
    await signAndSend(db, who, r, phone.auth, T0 + 2100)
    // the laptop (removed) is not offered to cancel its own removal; the phone is
    const changeId = String(w.scheduled[0]!.changeId)
    const c = await railPropose(CFG, db, who, { kind: 'cancel-change', params: { changeId } }, T0 + 3000)
    expect(allowed(await railSignBegin(db, RP, who, String(c.approvalId), T0 + 3100))).toEqual([phone.id])
  })

  it('a shared workspace: one passkey per member on the vault, the admin threshold signs, and the chain\'s threshold never drops below the workspace\'s policy', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), kiran = await person(db, 'kiran')
    const ws = createBusiness(db, asha.who.personId, 'Traders', T0)
    const owner: Asker = { ...asha.who, workspaceId: ws, role: 'owner' }
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'ravi', 'approver', T0)
    setPolicy(db, ws, { personId: asha.who.personId, role: 'owner' }, { signers: 2 }, T0)
    await railSetup(CFG, db, RP, owner, RP.origins[0], T0)
    // Ravi's second passkey would let him count twice: refused
    const raviPhone = await addPasskey(db, ravi.who, 'Ravi phone')
    await expect(proposeAddSigner(CFG, db, owner, { credentialId: raviPhone.id }, T0 + 1000)).rejects.toMatchObject({ code: 'one_key_per_member' })
    // a member who joins later may become a signer; the admin threshold (2) must sign
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'kiran', 'approver', T0 + 500)
    expect((await signersView(db, owner)).canAdd).toEqual([{ credentialId: kiran.auth.id, name: 'kiran\'s laptop', person: { name: 'kiran', handle: 'kiran' } }])
    const p = await proposeAddSigner(CFG, db, owner, { credentialId: kiran.auth.id }, T0 + 1000)
    expect(db.get<{ required_signers: number }>('SELECT required_signers FROM approvals WHERE id = ?', String(p.approvalId))!.required_signers).toBe(2)
    // the chain's threshold may be lowered only as far as the workspace asks
    await expect(proposeThresholds(CFG, db, owner, { threshold: 1 }, T0 + 2000)).rejects.toMatchObject({ code: 'below_workspace_policy' })
    await expect(proposeThresholds(CFG, db, owner, { threshold: 3, adminThreshold: 2 }, T0 + 2000)).rejects.toMatchObject({ code: 'invalid' })
    await proposeThresholds(CFG, db, owner, { threshold: 2, adminThreshold: 2 }, T0 + 2000).catch((e: { code: string }) => expect(e.code).toBe('nothing_to_change'))
    // a viewer cannot change the vault's signers
    await expect(proposeAddSigner(CFG, db, { ...ravi.who, workspaceId: ws, role: 'viewer' }, { credentialId: kiran.auth.id }, T0 + 3000)).rejects.toMatchObject({ code: 'not_permitted' })
  })
})

describe('the vault\'s recovery key: the code stays on the owner\'s device', () => {
  it('registers a recovery key from its public key and a proof that the device holds it; a code is never accepted', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const b = beginRecoveryKey(db, who, T0 + 100)
    expect(b.derivation).toMatchObject({ code: { characters: 26, alphabet: 'Crockford base 32', bits: 130 }, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: 'QEDOwnerAccount recovery v1', bytes: 48 } })
    const rk = recoveryKey()
    // a proof over something else, or any field that could carry the code, is refused before the rail is asked
    await expect(proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(`0x${'00'.repeat(32)}`) }, T0 + 200)).rejects.toMatchObject({ code: 'recovery_key_proof' })
    await expect(proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(b.challenge), code: 'ABCDE-FGHJK' }, T0 + 200)).rejects.toMatchObject({ code: 'invalid' })
    const p = await proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(b.challenge) }, T0 + 300)
    expect(fake.proposed('add-signer').map((x) => x.params)).toEqual([{ x: rk.pub.x, y: rk.pub.y, role: 'recovery' }])
    expect(JSON.stringify(fake.seen)).not.toMatch(/"code"/)
    // the challenge works once
    await expect(proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(b.challenge) }, T0 + 400)).rejects.toMatchObject({ code: 'not_found' })
    await signAndSend(db, who, p, auth, T0 + 500)
    expect((await signersView(db, who)).recovery).toMatchObject({ keys: 1 })
  })

  it('recovers the vault for a new passkey of the same person: a fresh digest, the key\'s signature checked here first, then the rail; idempotent; members are told', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const rk = recoveryKey()
    const b = beginRecoveryKey(db, who, T0 + 100)
    await signAndSend(db, who, await proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(b.challenge) }, T0 + 200), auth, T0 + 300)
    // the laptop is lost: a new passkey (after QED's own account recovery, or one never added to the vault)
    const fresh = await addPasskey(db, who, 'New phone', T0 + 1000)
    await expect(beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: auth.id }, T0 + 2000)).rejects.toMatchObject({ code: 'already_a_signer' })
    await expect(beginVaultRecovery(CFG, db, RP, who, { recoveryKey: recoveryKey().pub, credentialId: fresh.id }, T0 + 2000)).rejects.toMatchObject({ code: 'not_a_recovery_key' })
    const r = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2000)
    // R13: the confirmation is offered to the passkey being added, and to no other
    expect((r.confirm.options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id)).toEqual([fresh.id])
    const by = (a: SoftAuthenticator, req = r) => ({ challengeId: req.confirm.challengeId, response: a.get(req.confirm.options as never) })
    const asked = fake.seen.find((s) => s.path.includes('/recovery/digest'))!
    const q = new URL(`http://x${asked.path}`).searchParams
    expect([q.get('recoverySignerId'), q.get('x'), q.get('y')]).toEqual([fakeSignerId(rk.pub.x, rk.pub.y), keyOf(fresh.auth).x, keyOf(fresh.auth).y])
    expect(Number(q.get('deadline'))).toBeGreaterThan(Math.floor((T0 + 2000) / 1000))
    expect(r).toMatchObject({ digest: expect.stringMatching(/^0x[0-9a-f]{64}$/), recoveryDelaySeconds: 259_200 })
    // another key's signature is refused here, before the rail is asked
    await expect(finishVaultRecovery(CFG, db, RP, who, { requestId: r.requestId, signature: recoveryKey().sign(r.digest), confirmation: by(fresh.auth) }, T0 + 2100)).rejects.toMatchObject({ code: 'recovery_signature' })
    expect(fake.sent('/recoveries')).toEqual([])
    const s1 = await finishVaultRecovery(CFG, db, RP, who, { requestId: r.requestId, signature: rk.sign(r.digest), confirmation: by(fresh.auth) }, T0 + 2200)
    // a lost reply asked again: the same job, nothing new relayed, no second confirmation needed
    const s2 = await finishVaultRecovery(CFG, db, RP, who, { requestId: r.requestId, signature: rk.sign(r.digest) }, T0 + 2300)
    const sent = fake.sent('/recoveries')
    expect(sent.map((s) => s.key)).toEqual([`vrec-${r.requestId}`, `vrec-${r.requestId}`])
    expect(sent[0]!.body).toMatchObject({ recoverySignerId: fakeSignerId(rk.pub.x, rk.pub.y), newKey: keyOf(fresh.auth), deadline: r.deadline })
    expect(s2.jobId).toBe(s1.jobId)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'vault-recovery'`, who.workspaceId)!.n).toBe(1)
  })
})

describe('links for the authority budget (R7 D7, A-ID): workspaces with a member in common', () => {
  it('relays a vault recovery only when the passkey being added confirms it, over this very request (R13)', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'ravi')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const rk = recoveryKey()
    const b = beginRecoveryKey(db, who, T0 + 100)
    await signAndSend(db, who, await proposeRecoveryKey(CFG, db, who, { challengeId: b.challengeId, publicKey: rk.pub, proof: rk.sign(b.challenge) }, T0 + 200), auth, T0 + 300)
    const fresh = await addPasskey(db, who, 'New phone', T0 + 1000)
    const r = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2000)
    // another of the same person's passkeys (the laptop, a signer already) answers the confirmation: refused, nothing sent
    await expect(finishVaultRecovery(CFG, db, RP, who, { requestId: r.requestId, signature: rk.sign(r.digest), confirmation: { challengeId: r.confirm.challengeId, response: auth.get(r.confirm.options as never) } }, T0 + 2100)).rejects.toMatchObject({ code: 'confirm_with_added_passkey' })
    // no confirmation at all: refused
    const r2 = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2200)
    await expect(finishVaultRecovery(CFG, db, RP, who, { requestId: r2.requestId, signature: rk.sign(r2.digest) }, T0 + 2300)).rejects.toMatchObject({ code: 'confirmation_needed' })
    // the right passkey, but over another request's challenge: refused
    const r3 = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2400)
    const r4 = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2500)
    await expect(finishVaultRecovery(CFG, db, RP, who, { requestId: r4.requestId, signature: rk.sign(r4.digest), confirmation: { challengeId: r3.confirm.challengeId, response: fresh.auth.get(r3.confirm.options as never) } }, T0 + 2600)).rejects.toMatchObject({ code: 'confirm_with_added_passkey' })
    expect(fake.sent('/recoveries')).toEqual([])
    // the passkey being added confirms this request: relayed once
    const r5 = await beginVaultRecovery(CFG, db, RP, who, { recoveryKey: rk.pub, credentialId: fresh.id }, T0 + 2700)
    await finishVaultRecovery(CFG, db, RP, who, { requestId: r5.requestId, signature: rk.sign(r5.digest), confirmation: { challengeId: r5.confirm.challengeId, response: fresh.auth.get(r5.confirm.options as never) } }, T0 + 2800)
    expect(fake.sent('/recoveries').map((s) => s.key)).toEqual([`vrec-${r5.requestId}`])
  })

  it('declares every vault that shares a member, at set-up and whenever the scheduler runs, only when there is something new', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    await railSetup(CFG, db, RP, ravi.who, RP.origins[0], T0)
    const ws = createBusiness(db, asha.who.personId, 'Traders', T0)
    await railSetup(CFG, db, RP, { ...asha.who, workspaceId: ws, role: 'owner' }, RP.origins[0], T0)
    // the pairs declared, from whichever side declared them
    const pairs = () => new Set(fake.sent('/links').flatMap((s) => (s.body.workspaces as string[]).map((o) => [s.path.split('/')[2], o].sort().join(' & '))))
    const pair = (a: string, b: string) => [railWorkspaceId(a), railWorkspaceId(b)].sort().join(' & ')
    expect([...pairs()]).toEqual([pair(ws, asha.who.personId)])
    await railPolicySchedule(CFG, db, T0 + 600_000)
    expect(fake.sent('/links')).toHaveLength(1)
    // Ravi joins the business, even as a viewer: his household is linked from now on, and stays linked
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'ravi', 'viewer', T0 + 1000)
    await railPolicySchedule(CFG, db, T0 + 900_000)
    expect([...pairs()].sort()).toEqual([pair(ws, asha.who.personId), pair(ws, ravi.who.personId)].sort())
    expect(fake.sent('/links')).toHaveLength(2)
    expect(pairs().has(pair(asha.who.personId, ravi.who.personId))).toBe(false)
  })
})

// The R13 security review's leads on the vault requests (docs/SECURITY-REVIEW-R13.md section 4); scripts/security.ts runs
// these by their check ids and records each as one of its checks.
describe('R13 lead checks: vault requests', () => {
  const required = (db: Db, p: Record<string, unknown>) => db.get<{ required_signers: number }>('SELECT required_signers FROM approvals WHERE id = ?', String(p.approvalId))!.required_signers

  it('R18 (L-03): in a business, a vault request needs the workspace\'s own number of signatures when it is larger than the chain\'s threshold; a request that only stops something needs no more than the chain asks', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'); await person(db, 'ravi')
    const ws = createBusiness(db, asha.who.personId, 'Traders', T0)
    const owner: Asker = { ...asha.who, workspaceId: ws, role: 'owner' }
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'ravi', 'approver', T0)
    await railSetup(CFG, db, RP, owner, RP.origins[0], T0) // the workspace asks for one signature: the chain's threshold is 1
    setPolicy(db, ws, { personId: asha.who.personId, role: 'owner' }, { signers: 2 }, T0 + 100) // raised afterwards: in force at once
    expect(required(db, await railPropose(CFG, db, owner, { kind: 'convert', params: { amount: '10' } }, T0 + 200))).toBe(2)
    expect(required(db, await railPropose(CFG, db, owner, { kind: 'pause', params: {} }, T0 + 300))).toBe(1)
  })

  it('R16 (L-01): one person cannot spend the vault service\'s host-wide budgets through many workspaces: four vault set-ups a day, and 480 requests an hour over all their workspaces', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const wss = [0, 1, 2, 3, 4].map((i) => createBusiness(db, asha.who.personId, `Shell ${i}`, T0 + i))
    const as = (ws: string): Asker => ({ ...asha.who, workspaceId: ws, role: 'owner' })
    for (const ws of wss.slice(0, 4)) await railSetup(CFG, db, RP, as(ws), RP.origins[0], T0 + 10)
    await expect(railSetup(CFG, db, RP, as(wss[4]!), RP.origins[0], T0 + 20)).rejects.toMatchObject({ code: 'too_many' })
    // the next hour: two workspaces' worth of requests (240 each), then a third workspace's first is one too many
    const later = T0 + 2 * 3600_000
    for (const ws of wss.slice(0, 2)) for (let i = 0; i < 240; i++) await railPropose(CFG, db, as(ws), { kind: 'convert', params: { amount: '1' } }, later + i)
    await expect(railPropose(CFG, db, as(wss[2]!), { kind: 'convert', params: { amount: '1' } }, later + 1000)).rejects.toMatchObject({ code: 'too_many' })
  }, 60_000)
})
