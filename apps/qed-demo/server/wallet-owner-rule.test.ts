/**
 * R14: who may own a new on-chain wallet, and what each refusal on the way says.
 *
 * The rule (server/rail.ts ownerReadiness): a household's wallet is created with the person's passkeys that approve and
 * are past their first 24 hours (RISK-068, Q-062). An account's first passkey has no such wait (server/passkeys.ts
 * finishAddPasskey: there is no older passkey it could be taking authority from), so a person who opened the account with
 * a password adds a passkey and sets the wallet up in one sitting, and that passkey alone owns it. A passkey added beside
 * another one waits its 24 hours before it becomes a signer of anything: a session someone else got into must not put
 * their own passkey on the household's wallet. A passkey that signs in only (a recovery's, or one added after a password
 * reset) owns nothing until its authority is restored.
 *
 * Each state is checked both ways: what is refused, with words that say what is wrong and what to do, and that the same
 * request goes through once the reason is gone.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor, stepUp } from './auth.ts'
import { openDb, whenIst } from './core.ts'
import { beginAddPasskey, beginSignup, COOL_OFF_MS, finishAddPasskey, finishSignup, type RelyingParty, RESTRICTED_WORDS, signUpWithPassword } from './passkeys.ts'
import { type Asker, ownerReadiness, railOverview, railSetup } from './rail.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'qed.example', name: 'QED', origins: ['https://qed.example'] }
const META = { ip: '203.0.113.7', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 25, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
const PASSWORD = `${randomBytes(9).toString('base64url')} lantern`
type Db = ReturnType<typeof openDb>

// a stand-in for the wallet service: it records what it is asked to create
const created: { owner: { signers: { x: string; y: string }[]; threshold: number } }[] = []
let server: Server
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const reply = (status: number, json: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
      if (req.url === '/health') return reply(200, { ready: true, mode: 'multi-tenant' })
      if (req.method === 'POST' && req.url === '/workspaces') { const body = JSON.parse(raw) as (typeof created)[number] & { workspaceId: string }; created.push(body); return reply(201, { id: body.workspaceId, status: 'awaiting-acceptance', signers: body.owner.signers.map((k) => ({ ...k, role: 'member' })), threshold: 1 }) }
      return reply(404, { error: { code: 'unknown_workspace', message: 'Unknown workspace.' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'qed-owner-rule-'))
  writeFileSync(join(dir, 'rail.token'), randomBytes(24).toString('hex'), { mode: 0o600 })
  process.env.QED_RAIL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.QED_RAIL_TOKEN_FILE = join(dir, 'rail.token')
})
afterAll(async () => { delete process.env.QED_RAIL_URL; delete process.env.QED_RAIL_TOKEN_FILE; await new Promise<void>((r) => server.close(() => r())) })
beforeEach(() => { created.length = 0 })

const asker = (db: Db, personId: string, token: string, now: number): Asker => ({ workspaceId: personId, personId, role: 'owner', session: sessionFor(db, token, now)! })
const keyOf = (a: SoftAuthenticator) => ({ x: `0x${a.x.toString('hex')}`, y: `0x${a.y.toString('hex')}` })
async function passwordAccount(db: Db, handle: string) {
  const r = await signUpWithPassword(db, { handle, password: PASSWORD, displayName: 'Meera' }, META, T0)
  const personId = db.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)!.id
  return { personId, token: r.session.token }
}
async function addPasskey(db: Db, token: string, name: string, now: number): Promise<SoftAuthenticator> {
  const device = new SoftAuthenticator({ origin: RP.origins[0]!, rpId: RP.id })
  const s = sessionFor(db, token, now)!
  const b = await beginAddPasskey(db, RP, s, now)
  await finishAddPasskey(db, RP, s, { challengeId: b.challengeId, response: device.create(b.options as never), passkeyName: name }, META.ua, now)
  return device
}

describe('who may own a new on-chain wallet (R14)', () => {
  it('a password account has nothing to own a wallet with, and is told to add a passkey on this device first', async () => {
    const db = openDb(':memory:')
    const { personId, token } = await passwordAccount(db, 'meera')
    expect(ownerReadiness(db, personId, T0)).toEqual({ state: 'no-passkey' })
    const refusal = await railSetup(CFG, db, RP, asker(db, personId, token, T0), RP.origins[0], T0).catch((e: unknown) => e as { status: number; code: string; message: string })
    expect(refusal).toMatchObject({ status: 409, code: 'passkey_needed' })
    expect((refusal as { message: string }).message).toBe('This account has no passkey yet, and a wallet is owned by a passkey. Add a passkey on this device first: enter your password on the wallet\'s page and your device makes one. Then set the wallet up. Nothing was created.')
    expect(created).toHaveLength(0)
    // the wallet's page is told the same, before anyone presses anything
    expect(((await railOverview(CFG, db, RP, asker(db, personId, token, T0))) as { owner: unknown }).owner).toEqual({ state: 'no-passkey' })
  })

  it('its first passkey, added with the password, owns a new wallet at once and alone: no 24-hour wait, because no older passkey exists', async () => {
    const db = openDb(':memory:')
    const { personId, token } = await passwordAccount(db, 'meera')
    await stepUp(db, sessionFor(db, token, T0 + 1000)!, PASSWORD, META.ip, T0 + 1000)
    const laptop = await addPasskey(db, token, 'Laptop', T0 + 2000)
    expect(db.get<{ u: number | null }>('SELECT cool_off_until u FROM webauthn_credentials WHERE id = ?', laptop.id)!.u).toBeNull()
    expect(ownerReadiness(db, personId, T0 + 3000)).toEqual({ state: 'ready', passkeys: ['Laptop'] })
    const view = await railSetup(CFG, db, RP, asker(db, personId, token, T0 + 3000), RP.origins[0], T0 + 3000)
    expect(view.status).toBe('awaiting-acceptance')
    expect(created).toHaveLength(1)
    expect(created[0]!.owner).toEqual({ signers: [keyOf(laptop)], threshold: 1 })
  })

  it('a passkey added beside another waits its 24 hours: it is not made a signer of the new wallet, which the older passkey alone owns', async () => {
    const db = openDb(':memory:')
    const laptop = new SoftAuthenticator({ origin: RP.origins[0]!, rpId: RP.id })
    const b = await beginSignup(db, RP, { handle: 'asha', displayName: 'Asha' }, META.ip, T0)
    const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: laptop.create(b.options as never), passkeyName: 'Laptop' }, META, T0)
    const phone = await addPasskey(db, r.session.token, 'Phone', T0 + 1000)
    expect(ownerReadiness(db, r.personId, T0 + 2000)).toEqual({ state: 'ready', passkeys: ['Laptop'], waiting: [{ passkey: 'Phone', until: T0 + 1000 + COOL_OFF_MS }] })
    await railSetup(CFG, db, RP, asker(db, r.personId, r.session.token, T0 + 2000), RP.origins[0], T0 + 2000)
    expect(created[0]!.owner.signers).toEqual([keyOf(laptop)])
    expect(created[0]!.owner.signers).not.toContainEqual(keyOf(phone))
  })

  it('when every passkey that approves is in its first 24 hours, the set-up is refused with the passkey\'s name and the exact time it can go ahead, and goes ahead then', async () => {
    const db = openDb(':memory:')
    const laptop = new SoftAuthenticator({ origin: RP.origins[0]!, rpId: RP.id })
    const b = await beginSignup(db, RP, { handle: 'asha', displayName: 'Asha' }, META.ip, T0)
    const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: laptop.create(b.options as never), passkeyName: 'Laptop' }, META, T0)
    const phone = await addPasskey(db, r.session.token, 'Phone', T0 + 1000)
    // the older passkey is suspended (forced here: the product's own route for it is covered in passkeys.test.ts)
    db.run('UPDATE webauthn_credentials SET suspended_at = ? WHERE id = ?', T0 + 2000, laptop.id)
    const until = T0 + 1000 + COOL_OFF_MS
    expect(ownerReadiness(db, r.personId, T0 + 3000)).toEqual({ state: 'cooling-off', passkey: 'Phone', until })
    const refusal = await railSetup(CFG, db, RP, asker(db, r.personId, r.session.token, T0 + 3000), RP.origins[0], T0 + 3000).catch((e: unknown) => e as { status: number; code: string; message: string })
    expect(refusal).toMatchObject({ status: 409, code: 'passkey_cooling_off' })
    expect((refusal as { message: string }).message).toBe(`Phone was added to this account less than 24 hours ago, and a passkey can own a wallet only after its first 24 hours: someone who got into your session must not be able to put their own passkey on your wallet. Set the wallet up from ${whenIst(until)}. Nothing was created.`)
    expect(created).toHaveLength(0)
    await railSetup(CFG, db, RP, asker(db, r.personId, r.session.token, until), RP.origins[0], until)
    expect(created[0]!.owner.signers).toEqual([keyOf(phone)])
  })

  it('a passkey that signs in only owns nothing: the refusal says how its approval authority is restored', async () => {
    const db = openDb(':memory:')
    const { personId, token } = await passwordAccount(db, 'meera')
    // a password reset holds the account's authority (R12): a passkey added with that password signs in only
    db.run('UPDATE users SET authority_hold_at = ? WHERE id = ?', T0 + 500, personId)
    await stepUp(db, sessionFor(db, token, T0 + 1000)!, PASSWORD, META.ip, T0 + 1000)
    await addPasskey(db, token, 'Laptop', T0 + 2000)
    expect(ownerReadiness(db, personId, T0 + 3000)).toEqual({ state: 'signin-only' })
    const refusal = await railSetup(CFG, db, RP, asker(db, personId, token, T0 + 3000), RP.origins[0], T0 + 3000).catch((e: unknown) => e as { status: number; code: string; message: string })
    expect(refusal).toMatchObject({ status: 409, code: 'authority_restricted', message: RESTRICTED_WORDS })
    expect(created).toHaveLength(0)
  })
})
