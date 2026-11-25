/**
 * R14, independent review of the wallet fix, M2: a set-up that stopped part of the way (the R13 outage: the co-signer
 * could not write its records, so every creation failed after the service had recorded it) is finished by the wallet
 * service exactly as it was first asked. A later press with other settings (here the time-lock) was answered "exists
 * with other settings", but the record here had already been rebuilt from that later press: the page would then show
 * settings, and ask for a passkey, that the chain will never hold. The record now goes back to the first request, and
 * the person is told in plain words what is happening and what to do.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessionFor, stepUp } from './auth.ts'
import { openDb } from './core.ts'
import { beginAddPasskey, finishAddPasskey, type RelyingParty, signUpWithPassword } from './passkeys.ts'
import { type Asker, railSetup, vaultOf } from './rail.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'qed.example', name: 'QED', origins: ['https://qed.example'] }
const META = { ip: '203.0.113.7', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) test' }
const T0 = Date.UTC(2026, 10, 25, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
const PASSWORD = `${randomBytes(9).toString('base64url')} lantern`

// A stand-in for the wallet service as it behaved in the outage and after the fix: the first creation is recorded and
// then fails; while unfinished the workspace is unknown to reads (404); the same request again finishes it; a different
// one is refused, exactly as chain/rail/host.ts createWorkspace refuses a different request hash.
let first: string | null = null
const posts: string[] = []
let server: Server
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const reply = (status: number, json: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
      if (req.url === '/health') return reply(200, { ready: true, mode: 'multi-tenant' })
      if (req.method === 'POST' && req.url === '/workspaces') {
        const body = JSON.parse(raw) as { workspaceId: string; owner: { signers: { x: string; y: string }[]; threshold: number }; timeLock?: boolean }
        const key = JSON.stringify({ owner: body.owner, timeLock: body.timeLock === true })
        posts.push(key)
        if (first === null) { first = key; return reply(500, { error: { code: 'internal', message: "EACCES: permission denied, mkdir '/data/app/rail/workspaces/x/records'" } }) }
        if (key !== first) return reply(409, { error: { code: 'workspace_exists', message: 'A workspace with this id already exists with a different owner or settings. Nothing was changed.' } })
        return reply(201, { id: body.workspaceId, status: 'awaiting-acceptance', signers: body.owner.signers.map((k) => ({ ...k, role: 'member' })), threshold: body.owner.threshold })
      }
      return reply(404, { error: { code: 'unknown_workspace', message: 'Unknown workspace.' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'qed-setup-conflict-'))
  writeFileSync(join(dir, 'rail.token'), randomBytes(24).toString('hex'), { mode: 0o600 })
  process.env.QED_RAIL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.QED_RAIL_TOKEN_FILE = join(dir, 'rail.token')
})
afterAll(async () => { delete process.env.QED_RAIL_URL; delete process.env.QED_RAIL_TOKEN_FILE; await new Promise<void>((r) => server.close(() => r())) })

describe('a wallet set-up that stopped part of the way (R14, review M2)', () => {
  it('a later press with other settings leaves the record on the first request, refuses in plain words, and the first request then finishes', async () => {
    const db = openDb(':memory:')
    const r = await signUpWithPassword(db, { handle: 'meera', password: PASSWORD, displayName: 'Meera' }, META, T0)
    const personId = db.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', 'meera')!.id
    const token = r.session.token
    await stepUp(db, sessionFor(db, token, T0 + 1000)!, PASSWORD, META.ip, T0 + 1000)
    const laptop = new SoftAuthenticator({ origin: RP.origins[0]!, rpId: RP.id })
    const b = await beginAddPasskey(db, RP, sessionFor(db, token, T0 + 2000)!, T0 + 2000)
    await finishAddPasskey(db, RP, sessionFor(db, token, T0 + 2000)!, { challengeId: b.challengeId, response: laptop.create(b.options as never), passkeyName: 'Laptop' }, META.ua, T0 + 2000)
    const who = (now: number): Asker => ({ workspaceId: personId, personId, role: 'owner', session: sessionFor(db, token, now)! })
    const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status: number; code: string; message: string })

    // 1 · the first press: recorded by the service, then its fault (the person is told it is not their device)
    expect(await fail(railSetup(CFG, db, RP, who(T0 + 3000), RP.origins[0], T0 + 3000))).toMatchObject({ status: 503, code: 'rail_unavailable' })
    const firstRecord = vaultOf(db, personId)!
    expect(firstRecord.request.timeLock).toBeUndefined()
    expect(firstRecord.credentialIds).toEqual([laptop.id])

    // 2 · a later press with the time-lock ticked: the service will finish the first request, so the record stays on it
    const refusal = await fail(railSetup(CFG, db, RP, who(T0 + 4000), RP.origins[0], T0 + 4000, { timeLock: true }))
    expect(refusal).toMatchObject({ status: 409, code: 'setup_unfinished' })
    expect(refusal!.message).toContain('finishing it with the settings and passkeys you chose then')
    expect(refusal!.message).toContain('Nothing was changed.')
    expect(refusal!.message).toContain('accept it with the passkey you used that first time')
    expect(vaultOf(db, personId)).toEqual(firstRecord)

    // 3 · the first request again finishes the wallet, owned by the passkey the record names
    const view = await railSetup(CFG, db, RP, who(T0 + 5000), RP.origins[0], T0 + 5000)
    expect(view.status).toBe('awaiting-acceptance')
    expect(vaultOf(db, personId)!.request).toEqual(firstRecord.request)
    expect(vaultOf(db, personId)!.credentialIds).toEqual([laptop.id])
    expect(posts).toHaveLength(3)
    expect(posts[2]).toBe(posts[0])
    expect(JSON.parse(posts[1]!).timeLock).toBe(true)
  })
})
