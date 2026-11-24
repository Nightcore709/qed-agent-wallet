/**
 * The vault-signer and on-chain earning routes over HTTP (server/api.ts, the two marked blocks), against the real API
 * server and a recording stand-in of the rail (server/rail-fake.ts): GET /api/vault/signers is this feature's view and
 * not the generic vault read it would collide with; changing who signs needs a fresh passkey confirmation and an owner
 * or admin; a viewer cannot; GET /api/earn/chain answers in the session's own workspace.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { FakeRail } from './rail-fake.ts'
import { authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (a fixed port let one run's
// requests reach another's server). Was 9381.
const PORT = 20000 + Math.floor(Math.random() * 20000)
const fake = new FakeRail()

describe('the vault-signer and earning routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-signers-api-'))
  let api: ReturnType<typeof startApi>
  beforeAll(async () => {
    await fake.start()
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) }))
  })
  afterAll(async () => { api.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }

  it('GET /api/vault/signers is the signers view; adding a signer needs a fresh passkey confirmation and an owner or admin; a viewer is refused', async () => {
    const a = client(), ka = authenticatorFor(PORT)
    await signUp(a.ok, ka, 'signers-a', 'Owner A')
    await stepUp(a.ok, ka)
    await a.ok('POST', '/api/vault/setup', { origin: `http://localhost:${PORT}` })
    const v = await a.ok('GET', '/api/vault/signers')
    expect(v).toMatchObject({ setUp: true, threshold: 1, signers: [{ role: 'member', passkey: { you: true, state: 'active' } }] })
    // a second passkey of the same person
    const phone = authenticatorFor(PORT)
    const b = await a.ok('POST', '/api/security/passkeys/begin')
    const added = await a.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: phone.create(b.options), passkeyName: 'Phone' })
    // without a fresh confirmation: refused, nothing asked of the rail
    api.ctx.db.run('UPDATE sessions SET stepup_at = 0')
    const stale = await a.call('POST', '/api/vault/signers/add', { credentialId: added.passkey.id })
    expect([stale.status, stale.json.error?.code]).toEqual([401, 'stepup_required'])
    expect(fake.proposed('add-signer')).toEqual([])
    await stepUp(a.ok, ka)
    // in its first 24 hours the new passkey is not made a signer (RISK-068, Q-062); then, past its cool-off, it is
    const cooling = await a.call('POST', '/api/vault/signers/add', { credentialId: added.passkey.id })
    expect([cooling.status, cooling.json.error?.code]).toEqual([409, 'passkey_cooling_off'])
    api.ctx.db.run('UPDATE webauthn_credentials SET cool_off_until = NULL WHERE id = ?', added.passkey.id) // what 24 hours would leave
    const p = await a.ok('POST', '/api/vault/signers/add', { credentialId: added.passkey.id })
    expect(p).toMatchObject({ proposal: { kind: 'add-signer' }, requiresStepUp: true })
    expect(p.sign).toHaveLength(1)
    // the earning view, in the session's own workspace
    expect(await a.ok('GET', '/api/earn/chain')).toMatchObject({ reachable: true, asProvider: [], asClient: [] })
    // a viewer of a shared workspace cannot change its vault's signers
    const c = client(), kc = authenticatorFor(PORT)
    await signUp(c.ok, kc, 'signers-c', 'Viewer C')
    await stepUp(a.ok, ka)
    const ws = await a.ok('POST', '/api/workspaces', { name: 'Shared books' })
    await stepUp(a.ok, ka)
    await a.ok('POST', '/api/workspace/members', { handle: 'signers-c', role: 'viewer' })
    await c.ok('POST', `/api/workspaces/${String(ws.id)}/switch`)
    await stepUp(c.ok, kc)
    const no = await c.call('POST', '/api/vault/signers/add', { credentialId: added.passkey.id })
    expect([no.status, no.json.error?.code]).toEqual([403, 'not_permitted'])
  }, 30_000)

  // EV-071, item 1: Security asked for the signers of a wallet that did not exist, and the browser logged each 409 as an
  // error. The view Security already loads now says whether the session's workspace has a wallet, from the same record
  // the signers view checks, so the page asks only when there is one. The signers view answers exactly as before.
  it('GET /api/security says whether the session\'s workspace has an on-chain wallet; GET /api/vault/signers is unchanged', async () => {
    const a = client(), ka = authenticatorFor(PORT)
    await signUp(a.ok, ka, 'signers-n', 'Owner N')
    expect((await a.ok('GET', '/api/security')).wallet).toEqual({ setUp: false })
    const none = await a.call('GET', '/api/vault/signers')
    expect([none.status, none.json.error?.code]).toEqual([409, 'vault_not_set_up'])
    await stepUp(a.ok, ka)
    await a.ok('POST', '/api/vault/setup', { origin: `http://localhost:${PORT}` })
    expect((await a.ok('GET', '/api/security')).wallet).toEqual({ setUp: true })
    expect(await a.ok('GET', '/api/vault/signers')).toMatchObject({ setUp: true, signers: [{ role: 'member', passkey: { you: true } }] })
    // the session's workspace decides, not the person: a shared workspace without a wallet says so, although this
    // person's household has one, and its signers view still refuses as before
    await stepUp(a.ok, ka)
    const ws = await a.ok('POST', '/api/workspaces', { name: 'No wallet yet' })
    await a.ok('POST', `/api/workspaces/${String(ws.id)}/switch`)
    expect((await a.ok('GET', '/api/security')).wallet).toEqual({ setUp: false })
    const shared = await a.call('GET', '/api/vault/signers')
    expect([shared.status, shared.json.error?.code]).toEqual([409, 'vault_not_set_up'])
  }, 30_000)
})
