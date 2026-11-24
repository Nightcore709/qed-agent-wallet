/**
 * The paper escrow's routes over HTTP (server/api.ts, the marked block "paper escrow"), against the real API server: terms
 * previewed and accepted by their fingerprint, the job's terms on the earn view, a dispute raised by each side, evidence,
 * the simulated mediator's decision, settling by agreement, terms agreed for a milestone opened before terms were recorded,
 * a step out of turn refused with its reason, and another household kept out. No engine runs here (the deadlines are
 * server/escrow.test.ts's).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'
import { authenticatorFor, signUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// a port of its own for each run: other worktrees run the same files at the same time
const PORT = 20000 + Math.floor(Math.random() * 20000)
const DAY = 86_400_000

describe('the paper escrow over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-escrow-api-'))
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
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }
  const milestone = (v: J, id: string): J => (v.jobs as J[]).flatMap((j) => j.milestones as J[]).find((m) => m.id === id)!

  it('a job opened on terms read and accepted by their fingerprint; disputes by each side; the mediator\'s split; settling by agreement; terms agreed for older work; steps out of turn and another household refused', async () => {
    const a = client(), b = client()
    const handleA = `escrow-a-${PORT}`
    await signUp(a.ok, authenticatorFor(PORT), handleA, 'Owner A')
    await signUp(b.ok, authenticatorFor(PORT), `escrow-b-${PORT}`, 'Owner B')
    const job = { title: 'Quarterly accounts', client: 'Lakeview Studio', reviewDays: 3, onTimeout: { decision: { kind: 'locked' } }, milestones: [{ title: 'Books closed', amount: 1_800_001 }, { title: 'Filing prepared', amount: 1_200_000 }] }
    // no household yet: nothing could be paid into it, so no job is opened
    expect((await a.call('POST', '/api/earn/terms/preview', job)).json.error?.code).toBe('not_set_up')
    await a.ok('POST', '/api/household', {})
    await b.ok('POST', '/api/household', {})
    // periods in seconds belong to test stacks; this API is not one
    expect((await a.call('POST', '/api/earn/terms/preview', { ...job, testSeconds: { review: 8 } })).json.error?.fields?.testSeconds).toMatch(/test stack/)
    const p = await a.ok('POST', '/api/earn/terms/preview', job)
    expect(p.terms).toMatchObject({ version: 2, review: { ms: 3 * DAY, onTimeout: { kind: 'release' } }, decision: { ms: 5 * DAY, onTimeout: { kind: 'locked' } }, mediator: { simulated: true } })
    expect((await a.call('POST', '/api/earn/jobs', { ...job, termsHash: p.hash, accept: { earner: true } })).json.error?.fields?.accept).toMatch(/paper client/)
    expect((await a.call('POST', '/api/earn/jobs', { ...job, reviewDays: 4, termsHash: p.hash, accept: { earner: true, client: true } })).json.error?.code).toBe('terms_changed')
    const { id: jobId } = await a.ok('POST', '/api/earn/jobs', { ...job, termsHash: p.hash, accept: { earner: true, client: true } })
    let v = await a.ok('GET', '/api/earn')
    expect(v.policy.review).toMatchObject({ days: { default: 7, min: 1, max: 14 }, onTimeout: { kind: 'release' } })
    const j = (v.jobs as J[]).find((x) => x.id === jobId)!
    expect(j.terms).toMatchObject({ hash: p.hash, version: 2, terms: p.terms, accepts: [{ side: 'earner' }, { side: 'client' }] })
    const [books, filing] = (j.milestones as J[]).map((m) => String(m.id))
    expect(milestone(v, books!)).toMatchObject({ state: 'funded', legacy: false, terms: { hash: p.hash }, next: { actor: 'earner', step: 'submit', by: null, then: { kind: 'stays' } }, steps: [{ actor: 'client', step: 'opened' }] })

    // the client disputes the work; the earner answers; the mediator splits it
    await a.ok('POST', `/api/earn/milestones/${books}/submit`, { evidence: 'Trial balance and ledger export.' })
    await a.ok('POST', `/api/earn/milestones/${books}/client`, { decision: 'dispute', reason: 'Two accounts were not reconciled.' })
    const early = await a.call('POST', `/api/earn/milestones/${books}/decide`, { outcome: 'released' })
    expect([early.status, early.json.error?.code]).toEqual([409, 'not_heard'])
    await a.ok('POST', `/api/earn/milestones/${books}/evidence`, { side: 'earner', text: 'The difference is a cheque the client has not deposited.' })
    await a.ok('POST', `/api/earn/milestones/${books}/decide`, { outcome: 'split', earnerPaise: 1_500_000 })
    v = await a.ok('GET', '/api/earn')
    expect(milestone(v, books!)).toMatchObject({ state: 'split', paid: 1_500_000, back: 300_001, next: null, dispute: { raisedBy: 'client', state: 'decided', toEarner: 1_500_000, toClient: 300_001, decidedBy: 'mediator' } })

    // the client asks for the money back; the earner disputes it; the two settle by agreement instead
    await a.ok('POST', `/api/earn/milestones/${filing}/client`, { decision: 'refund' })
    await a.ok('POST', `/api/earn/milestones/${filing}/earner`, { step: 'dispute', reason: 'The client agreed to wait for the filing.' })
    expect(await a.ok('POST', `/api/earn/milestones/${filing}/settle`, { side: 'earner', outcome: 'split', earnerPaise: 600_000 })).toEqual({ settled: false })
    v = await a.ok('GET', '/api/earn')
    expect(milestone(v, filing!)).toMatchObject({ state: 'disputed', offers: { earner: { outcome: 'split', toEarner: 600_000, toClient: 600_000 }, client: null } })
    expect(await a.ok('POST', `/api/earn/milestones/${filing}/settle`, { side: 'client', outcome: 'split', earnerPaise: 600_000 })).toEqual({ settled: true })
    v = await a.ok('GET', '/api/earn')
    expect(milestone(v, filing!)).toMatchObject({ state: 'split', paid: 600_000, back: 600_000, dispute: { decidedBy: 'agreement' } })

    // work from before terms were recorded: no deadline, nothing on its own, until both sides agree terms
    const ws = api.ctx.db.get<{ id: string }>('SELECT id FROM users WHERE handle = ?', handleA)!.id
    api.ctx.db.run(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES ('job_old', ?, 'Quarterly accounts for Lakeview Studio', 'Lakeview Studio', 'open', 1, '{"paperClient":true}')`, ws)
    api.ctx.db.run(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, evidence_hash, updated_at) VALUES ('mil_old', 'job_old', ?, 'Books closed for the quarter', 1800000, 'submitted', 'aa', 1)`, ws)
    v = await a.ok('GET', '/api/earn')
    expect(milestone(v, 'mil_old')).toMatchObject({ legacy: true, dueAt: null, next: { actor: 'both', step: 'agree-terms', then: { kind: 'nothing' } } })
    expect((await a.call('POST', '/api/earn/milestones/mil_old/evidence', { side: 'earner', text: 'Here it is.' })).json.error?.code).toBe('no_terms')
    const read = await a.ok('POST', '/api/earn/milestones/mil_old/terms/preview', { side: 'earner' })
    expect(read.terms).toMatchObject({ milestones: [{ title: 'Books closed for the quarter', amount: 1_800_000 }], review: { ms: 7 * DAY } })
    expect((await a.call('POST', '/api/earn/milestones/mil_old/terms', { side: 'earner', reviewDays: 6, termsHash: read.hash })).json.error?.code).toBe('terms_changed')
    const t = await a.ok('POST', '/api/earn/milestones/mil_old/terms', { side: 'earner', termsHash: read.hash })
    expect(t.hash).toBe(read.hash)
    v = await a.ok('GET', '/api/earn')
    expect(milestone(v, 'mil_old')).toMatchObject({ proposal: { by: 'earner', hash: t.hash }, next: { actor: 'both', step: 'accept-terms' } })
    await a.ok('POST', '/api/earn/milestones/mil_old/terms/accept', { side: 'client', hash: t.hash })
    v = await a.ok('GET', '/api/earn')
    const old = milestone(v, 'mil_old')
    expect(old).toMatchObject({ legacy: false, terms: { hash: t.hash }, next: { actor: 'client', step: 'review', then: { kind: 'release', toEarner: 1_800_000 } } })
    expect(old.dueAt).toBeGreaterThan(Date.now() + 7 * DAY - 60_000)

    // another household is told it does not exist, whatever it asks
    for (const [path, body] of [[`/api/earn/milestones/${filing}/client`, { decision: 'accept' }], ['/api/earn/milestones/mil_old/settle', { side: 'client', outcome: 'released' }], ['/api/earn/milestones/mil_old/terms', { side: 'client' }], ['/api/earn/milestones/mil_old/terms/preview', { side: 'client' }], [`/api/earn/milestones/${books}/decide`, { outcome: 'refunded' }]] as const) {
      const r = await b.call('POST', path, body)
      expect([path, r.status]).toEqual([path, 404])
    }
    expect(((await b.ok('GET', '/api/earn')).jobs as J[])).toEqual([])
  }, 60_000)
})
