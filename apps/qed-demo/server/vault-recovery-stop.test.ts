/**
 * R13 H1: who may stop a pending co-signed recovery through QED (POST /api/vault/recoveries/:id/stop, which has the vault
 * service's sentinel key send QEDOwnerAccount.stopRecovery). Over HTTP: a person with a fresh confirmation by a passkey
 * that is neither suspended nor removed gets past the checks (here to "no vault yet": the vault service's part is
 * chain/test/owner-options.test.ts and server/owner-options.test.ts); a stale confirmation, a password session and a
 * suspended passkey do not.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { authenticatorFor, signUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (RISK-078).
const PORT = 20000 + Math.floor(Math.random() * 20000)
const RID = `0x${'ab'.repeat(32)}`

describe('stopping a co-signed recovery through QED (H1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-stop-recovery-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, code: (json as { error?: { code?: string } }).error?.code ?? null }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf }, body: JSON.stringify(b ?? {}) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!; const json = (await res.json()) as J; if (typeof json.csrf === 'string') csrf = json.csrf; if (res.status >= 300) throw new Error(`${m} ${p} -> ${res.status} ${JSON.stringify(json)}`); return json } }
  }
  const stop = (c: ReturnType<typeof client>, id = RID) => c.call('POST', `/api/vault/recoveries/${id}/stop`)

  it('needs a session, and then a fresh confirmation by a usable passkey; a password session cannot', async () => {
    expect((await stop(client())).status).toBe(401)
    // a password-only person: no passkey, so no confirmation that counts
    const pw = client()
    await pw.ok('POST', '/api/auth/signup', { handle: 'stop-pw', password: 'a long enough pass phrase', displayName: 'Password Person' })
    expect(await stop(pw)).toEqual({ status: 401, code: 'stepup_required' })
    // a passkey person whose confirmation is older than five minutes
    const pk = client()
    await signUp(pk.ok, authenticatorFor(PORT), 'stop-pk', 'Passkey Person')
    api.ctx.db.run('UPDATE sessions SET stepup_at = 0')
    expect(await stop(pk)).toEqual({ status: 401, code: 'stepup_required' })
    // confirmed afresh, but with a passkey that has since been suspended
    api.ctx.db.run(`UPDATE sessions SET stepup_at = ?, stepup_method = 'passkey', stepup_credential_id = credential_id`, Date.now())
    api.ctx.db.run('UPDATE webauthn_credentials SET suspended_at = ? WHERE person_id = (SELECT id FROM users WHERE handle = ?)', Date.now(), 'stop-pk')
    expect(await stop(pk)).toEqual({ status: 409, code: 'passkey_not_usable' })
    // the same confirmation with the passkey usable again: past every check, to the vault (none is set up here)
    api.ctx.db.run('UPDATE webauthn_credentials SET suspended_at = NULL WHERE person_id = (SELECT id FROM users WHERE handle = ?)', 'stop-pk')
    expect(await stop(pk)).toEqual({ status: 409, code: 'vault_not_set_up' })
    // and a malformed recovery id is refused before anything else is asked
    expect((await stop(pk, 'nonsense')).status).toBe(400)
  })
})
