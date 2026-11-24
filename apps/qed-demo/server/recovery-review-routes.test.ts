/**
 * The independent review of R12's recovery (24 Nov 2026), over HTTP against the real API server. Each test was written to
 * fail on the reviewed revision (7888c1b) and pass with its fix:
 *   H2  a session opened with a passkey that signs in only (a recovered one) is no better than a password session: it
 *       cannot switch protection off, resume spending authority, or prepare work without saying so
 *   M3  a password or sign-in-only session clears no notice of a change to who can act, by acknowledging or by
 *       dismissing it, in the person's own workspace or in a business workspace
 *   L4  the backup recovery start answers in the same time floor as the other requests that must not reveal an account
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { notice } from './execute.ts'
import { authenticatorFor, signIn, signUp, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)
const PW = 'a long enough pass phrase for review'

/** "14:02 IST on 24 Nov 2026", worked out here apart from the server's own formatter. */
function atIst(ms: number): string {
  const t = new Date(ms + 330 * 60_000), p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())} IST on ${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

function client(port: number) {
  let cookie = '', csrf = ''
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }
  return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
}

describe('the review of R12 over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-recovery-review-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_WEB_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  const refused = async (c: ReturnType<typeof client>, m: string, p: string, b?: unknown) => { const r = await c.call(m, p, b); return [r.status, r.json.error?.code] }
  const row = (kind: string, subject: string) => api.ctx.db.get<{ method: string; at: number }>('SELECT method, at FROM prepared WHERE kind = ? AND subject = ?', kind, subject)

  /**
   * An account whose first passkey approves (it stays on a device the owner lost) and whose second was registered by a
   * recovery, so it signs in only: the session opened with the second is the one a recovery leaves the person with.
   */
  async function recovered(handle: string) {
    const first = client(PORT), lost = authenticatorFor(PORT), found = authenticatorFor(PORT)
    const made = await signUp(first.ok, lost, handle, 'Recovered Person')
    await first.ok('POST', '/api/household', { opening: { bank: 90_000_000 } })
    const b = await first.ok('POST', '/api/security/passkeys/begin')
    await first.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: found.create(b.options) })
    api.ctx.db.run(`UPDATE webauthn_credentials SET authority = 'signin', authority_reason = 'recovery' WHERE id = ?`, found.id)
    const s = client(PORT); await signIn(s.ok, found)
    return { userId: made.userId, first, lost, s }
  }
  const program = (userId: string, id: string, kind: string, state: string) => api.ctx.db.run(`INSERT INTO programs (id, user_id, kind, pillar, title, state, live_version, origin, created_at, updated_at) VALUES (?, ?, ?, 'protect', ?, ?, 1, 'owner', ?, ?)`, id, userId, kind, `A ${kind} instruction`, state, Date.now(), Date.now())

  it('H2: a sign-in-only passkey session cannot pause, revoke or resume protection, nor switch protective selling off', async () => {
    const { userId, first, lost, s } = await recovered('rev-h2')
    expect(await s.ok('GET', '/api/session')).toMatchObject({ authMethod: 'passkey', passkeyAuthority: 'signin', authority: 'full', stepUpFresh: false })
    program(userId, 'prg_rev_floor', 'floor', 'active')
    program(userId, 'prg_rev_exit', 'exit', 'active')
    program(userId, 'prg_rev_paused', 'bills', 'paused')
    expect(await refused(s, 'POST', '/api/programs/prg_rev_floor/pause')).toEqual([409, 'authority_restricted'])
    expect(await refused(s, 'POST', '/api/programs/prg_rev_exit/revoke')).toEqual([409, 'authority_restricted'])
    expect(await refused(s, 'POST', '/api/programs/prg_rev_paused/resume')).toEqual([409, 'authority_restricted'])
    expect(await refused(s, 'POST', '/api/stop', { reason: 'testing', keepProtective: false })).toEqual([409, 'authority_restricted'])
    expect(api.ctx.db.get<{ state: string }>('SELECT state FROM programs WHERE id = ?', 'prg_rev_floor')!.state).toBe('active')
    expect(api.ctx.db.get<{ stop_at: number | null }>('SELECT stop_at FROM users WHERE id = ?', userId)!.stop_at).toBeNull()
    // pausing everything but protective selling is protective, and allowed
    expect(await s.ok('POST', '/api/stop', { reason: 'testing', keepProtective: true })).toMatchObject({ keptProtective: true })
    // the same pause of a protective instruction from a session with a passkey that approves reaches the instruction
    await stepUp(first.ok, lost)
    expect((await first.ok('POST', '/api/programs/prg_rev_floor/pause')).program.state).toBe('paused')
  }, 60_000)

  it('H2: a payee and a payment prepared in a sign-in-only passkey session say so in what the passkey signs, and the payee is told', async () => {
    const { s, first } = await recovered('rev-h2b')
    const look = await s.ok('POST', '/api/payees', { name: 'Look Alike', handle: 'look.alike@upi', category: 'other', nameCheckAccepted: 'unknown' })
    const payee = row('payee', String(look.id))!
    expect(payee.method).toBe('signin-passkey')
    const payeeLine = `The payee Look Alike (look.alike@upi) was added in a sign-in-only passkey session at ${atIst(payee.at)}, not with a passkey that can approve.`
    const asked = await s.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: look.id, amount: 50_000 })
    const requestLine = `Prepared in a sign-in-only passkey session at ${atIst(row('approval', String(asked.approvalId))!.at)}, not with a passkey that can approve.`
    expect((JSON.parse(String(asked.document)) as J).prepared).toEqual([requestLine, payeeLine])
    const told = ((await first.ok('GET', '/api/security')).events as J[]).filter((e) => e.kind === 'payee-added-in-signin-session')
    expect(told.map((e) => e.detail.payee)).toEqual(['Look Alike (look.alike@upi)'])
  }, 60_000)

  it('M3: in the person\'s own workspace, a password session and a sign-in-only session neither acknowledge nor dismiss a notice of who can act', async () => {
    const owner = client(PORT), key = authenticatorFor(PORT)
    const made = await owner.ok('POST', '/api/auth/signup', { handle: 'rev-m3a', password: PW, displayName: 'Notice Person' })
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const pw = client(PORT); await pw.ok('POST', '/api/auth/login', { handle: 'rev-m3a', password: PW })
    const found = authenticatorFor(PORT)
    await stepUp(owner.ok, key)
    const b2 = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b2.challengeId, response: found.create(b2.options) })
    api.ctx.db.run(`UPDATE webauthn_credentials SET authority = 'signin', authority_reason = 'recovery' WHERE id = ?`, found.id)
    const so = client(PORT); await signIn(so.ok, found)
    const ws = String(made.userId)
    notice(api.ctx.db, ws, { level: 'warning', kind: 'vault-signer-added', title: 'A passkey was added as a signer of the vault', body: 'If nobody here added it, remove it.', dedupe: 'rev-m3a-signer' }, Date.now())
    const id = api.ctx.db.get<{ id: string }>(`SELECT id FROM notices WHERE user_id = ? AND dedupe = 'rev-m3a-signer'`, ws)!.id
    for (const c of [pw, so]) {
      expect(await refused(c, 'POST', `/api/notices/${id}/dismiss`)).toEqual([401, 'stepup_required'])
      expect(await refused(c, 'POST', `/api/notices/${id}/ack`)).toEqual([401, 'stepup_required'])
    }
    expect(api.ctx.db.get<{ resolved_at: number | null }>('SELECT resolved_at FROM notices WHERE id = ?', id)!.resolved_at).toBeNull()
    // a session opened with the passkey that approves dismisses it
    const pk = client(PORT); await signIn(pk.ok, key)
    await pk.ok('POST', `/api/notices/${id}/dismiss`)
    expect(api.ctx.db.get<{ resolved_at: number | null }>('SELECT resolved_at FROM notices WHERE id = ?', id)!.resolved_at).not.toBeNull()
  }, 90_000)

  it('M3: in a business workspace, a member\'s password session neither acknowledges nor dismisses a notice of who can act', async () => {
    const owner = client(PORT), key = authenticatorFor(PORT)
    await owner.ok('POST', '/api/auth/signup', { handle: 'rev-m3b', password: PW, displayName: 'Business Person' })
    const b = await owner.ok('POST', '/api/security/passkeys/begin')
    await owner.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    await stepUp(owner.ok, key)
    const { id: biz } = await owner.ok('POST', '/api/workspaces', { name: 'Review Traders' })
    const pw = client(PORT); await pw.ok('POST', '/api/auth/login', { handle: 'rev-m3b', password: PW })
    await pw.ok('POST', `/api/workspaces/${String(biz)}/switch`)
    expect((await pw.ok('GET', '/api/session')).workspace).toMatchObject({ id: biz, kind: 'business' })
    notice(api.ctx.db, String(biz), { level: 'warning', kind: 'vault-recovery', title: 'A recovery of the vault has started', body: 'If nobody here started it, cancel it.', dedupe: 'rev-m3b-recovery' }, Date.now())
    const id = api.ctx.db.get<{ id: string }>(`SELECT id FROM notices WHERE user_id = ? AND dedupe = 'rev-m3b-recovery'`, String(biz))!.id
    expect(await refused(pw, 'POST', `/api/notices/${id}/ack`)).toEqual([401, 'stepup_required'])
    expect(await refused(pw, 'POST', `/api/notices/${id}/dismiss`)).toEqual([401, 'stepup_required'])
    expect(api.ctx.db.get<{ resolved_at: number | null; acked: number | null }>('SELECT n.resolved_at, d.acked_at acked FROM notices n LEFT JOIN notice_delivery d ON d.notice_id = n.id WHERE n.id = ?', id)).toEqual({ resolved_at: null, acked: null })
    // the owner's passkey session in the business acknowledges it
    await owner.ok('POST', `/api/notices/${id}/ack`)
  }, 90_000)

  it('L4: the backup recovery start takes the same time floor for an account that does not exist', async () => {
    const t0 = Date.now()
    const r = await client(PORT).call('POST', '/api/auth/recovery/start', { handle: 'no-such-person-here', code: 'ABCD-EFGH-JKLM-NPQR', password: 'some password typed here' })
    const ms = Date.now() - t0
    expect(r.status).toBe(200)
    expect(r.json.reference).toMatch(/^rec_/)
    expect(ms).toBeGreaterThanOrEqual(440)
  }, 30_000)
})
