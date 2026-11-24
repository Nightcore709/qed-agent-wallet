/**
 * The data rights over HTTP against the real API server: export, access log, and deletion with a passkey step-up, the delay
 * and its cancellation.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { applyDueDeletions, eraseAccount, purgeCandidates } from './records.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)

describe('data rights routes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-records-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json, headers: res.headers }
    }
    const ok = async (m: string, p: string, b?: unknown): Promise<J> => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json }
    return { call, ok }
  }

  it('exports, logs the sign-in, and deletes only after a passkey confirmation, the delay and no cancellation', async () => {
    const c = client(), key = authenticatorFor(PORT)
    const made = await signUp(c.ok, key, `rec-${PORT}`, 'Record Keeper')
    await c.ok('POST', '/api/household', { opening: { bank: 5_000_000, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 } }).catch(() => undefined)

    const view = await c.ok('GET', '/api/data')
    expect(view.deletion.pending).toBeNull()
    expect(view.accessLog.some((e: J) => e.kind === 'sign-in')).toBe(true)
    expect(view.schedule.length).toBeGreaterThan(40)

    const exp = await c.call('GET', '/api/data/export')
    expect(exp.status).toBe(200)
    expect(exp.headers.get('content-disposition')).toContain('qed-my-data.json')
    expect(exp.json.tables.users[0].handle).toBe(`rec-${PORT}`)
    expect(JSON.stringify(exp.json.tables)).not.toContain('pw_hash')
    expect((await c.ok('GET', '/api/data')).accessLog.some((e: J) => e.kind === 'export')).toBe(true)

    // not without a fresh passkey confirmation
    await new Promise((r) => setTimeout(r, 0))
    api.ctx.db.run('UPDATE sessions SET stepup_at = NULL, stepup_method = NULL WHERE user_id = ?', made.userId)
    const refused = await c.call('POST', '/api/data/deletion', { confirm: 'delete my account' })
    expect([refused.status, refused.json.error?.code]).toEqual([401, 'stepup_required'])
    await stepUp(c.ok, key)
    const wrong = await c.call('POST', '/api/data/deletion', { confirm: 'yes' })
    expect(wrong.status).toBe(400)
    const asked = await c.ok('POST', '/api/data/deletion', { confirm: 'delete my account' })
    expect(asked.effectiveAt).toBeGreaterThan(Date.now())
    expect((await c.ok('GET', '/api/data')).deletion.pending).not.toBeNull()

    // cancelled, then asked again
    await c.ok('POST', '/api/data/deletion/cancel')
    expect((await c.ok('GET', '/api/data')).deletion.pending).toBeNull()
    await c.ok('POST', '/api/data/deletion', { confirm: 'delete my account' })
    expect(applyDueDeletions(api.ctx.db, Date.now())).toBe(0)
    expect(applyDueDeletions(api.ctx.db, Date.now() + 8 * 86_400_000)).toBe(1)
    const after = await c.call('GET', '/api/data')
    expect(after.status).toBe(401)
    expect(api.ctx.db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', made.userId)!.handle).toBe(`erased-${made.userId}`)
  })

  it('records the address of a passkey sign-in, sealed like the password path', async () => {
    const c = client(), key = authenticatorFor(PORT)
    await signUp(c.ok, key, `ip-${PORT}`, 'Ip Person')
    const entry = (await c.ok('GET', '/api/data')).accessLog.find((e: J) => e.kind === 'sign-in')
    expect(entry.method).toBe('passkey')
    expect(entry.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
    const raw = api.ctx.db.get<{ detail_sealed: string }>(`SELECT detail_sealed FROM access_log WHERE kind = 'sign-in' ORDER BY id DESC LIMIT 1`)!.detail_sealed
    expect(raw).not.toContain('127.0.0.1')
    // the step-up that follows is logged with its address too
    await stepUp(c.ok, key)
    expect((await c.ok('GET', '/api/data')).accessLog.find((e: J) => e.kind === 'step-up').ip).toBeTruthy()
  })

  it('shows a person the reads of their workspace by another member', async () => {
    const owner = client(), peer = client(), ka = authenticatorFor(PORT), kb = authenticatorFor(PORT)
    await signUp(owner.ok, ka, `own-${PORT}`, 'Owner A')
    await signUp(peer.ok, kb, `peer-${PORT}`, 'Peer B')
    await stepUp(owner.ok, ka)
    const ws = (await owner.ok('POST', '/api/workspaces', { name: 'Shared Studio' })).id as string
    await owner.ok('POST', '/api/workspace/members', { handle: `peer-${PORT}`, role: 'viewer' })
    await peer.ok('POST', `/api/workspaces/${ws}/switch`)
    expect((await peer.call('GET', '/api/needs-you')).status).toBe(200)
    const seen = (await owner.ok('GET', '/api/data')).accessLog.find((e: J) => e.kind === 'member-read')
    expect(seen).toMatchObject({ by: 'Peer B', role: 'viewer', workspace: ws })
    // the peer's own log says nothing of it
    expect((await peer.ok('GET', '/api/data')).accessLog.some((e: J) => e.kind === 'member-read')).toBe(false)
  })

  it('purges only for a named approver with a fresh passkey, one person at a time, against the preview', async () => {
    const op = client(), opKey = authenticatorFor(PORT)
    const handle = `purger-${PORT}`
    await signUp(op.ok, opKey, handle, 'Purge Approver')
    const gone = client(), goneKey = authenticatorFor(PORT)
    const g = await signUp(gone.ok, goneKey, `gone-${PORT}`, 'Gone Person')
    const db = api.ctx.db
    db.run(`INSERT INTO payees (id, user_id, name, handle, category, created_at) VALUES ('pay_g', ?, 'Asha Rao', 'asha@bank', 'person', ?)`, g.userId, Date.now())
    eraseAccount(db, g.userId, Date.now(), Date.now())
    db.run('UPDATE erasures SET retain_until = ? WHERE person_id = ?', Date.now() - 1000, g.userId)
    // nobody is named: nothing is shown and nothing runs
    delete process.env.QED_PURGE_APPROVERS
    expect((await op.call('GET', '/api/records/purge')).status).toBe(403)
    process.env.QED_PURGE_APPROVERS = handle
    try {
      const list = await op.ok('GET', '/api/records/purge')
      const cand = list.candidates.find((x: J) => x.personId === g.userId)
      expect(cand.rows).toBeGreaterThan(0)
      // a person who is not named cannot see it
      const other = client(); await signUp(other.ok, authenticatorFor(PORT), `other-${PORT}`, 'Other')
      expect((await other.call('GET', '/api/records/purge')).status).toBe(403)
      // no fresh passkey confirmation: refused
      db.run('UPDATE sessions SET stepup_at = NULL, stepup_method = NULL WHERE user_id = ?', (db.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', handle)!).id)
      const no = await op.call('POST', '/api/records/purge', { personId: g.userId, previewDigest: cand.previewDigest })
      expect([no.status, no.json.error?.code]).toEqual([401, 'stepup_required'])
      await stepUp(op.ok, opKey)
      const stale = await op.call('POST', '/api/records/purge', { personId: g.userId, previewDigest: 'nope' })
      expect([stale.status, stale.json.error?.code]).toEqual([409, 'preview_changed'])
      const done = await op.ok('POST', '/api/records/purge', { personId: g.userId, previewDigest: cand.previewDigest })
      expect(done.removed.payees).toBe(1)
      expect(purgeCandidates(db, Date.now())).toEqual([])
      expect(db.get<{ approved_by: string }>('SELECT approved_by FROM purge_runs WHERE person_id = ?', g.userId)!.approved_by).not.toBe(g.userId)
    } finally { delete process.env.QED_PURGE_APPROVERS }
  })
})
