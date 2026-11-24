/**
 * R7-075: tenant isolation, tried on every route class. Over HTTP against the real API server, one person (A) has a household
 * and a business workspace with records of every kind this test can make; another person (B), signed in with a session of their
 * own, then tries to read and to change A's records through every route the API registers:
 *
 *   - every route with an identifier in its path, once for each identifier A's own reads revealed (payees, bills, approvals,
 *     actions, programs, workspaces, sessions, passkeys and the rest), with every method the route has;
 *   - every route without one, with a body that names A's identifiers in every field a handler might read them from;
 *   - B asking to switch into A's business workspace.
 * Nothing B receives may contain anything of A's (the identifiers, the payee, the memo, the business's name), and A's rows must be
 * byte for byte what they were: a digest of every table row that belongs to A, taken before and after. The routes come from
 * the source of server/api.ts, so a route added later is swept too; the test fails if the sweep did not reach each class.
 * Routes that end or create a session, or are open to anyone by design (sign-up, sign-in, recovery), are listed below with the
 * reason, and are covered by their own tests. No model is called (QED_AI_PROVIDER=none) and the vault service is not running.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { approve, authenticatorFor, signUp, stepUp } from '../scripts/lib/passkey-client.ts'
import { startApi } from './api.ts'
import { loadConfig } from './core.ts'

type J = Record<string, any>
const PORT = 20000 + Math.floor(Math.random() * 20000)
/** Routes left out of the sweep, each with why: they are open to anyone by design, or end B's own session and so would hide what follows. */
const LEFT_OUT: [RegExp, string][] = [
  [/^\/api\/auth\//, 'sign-up, sign-in, sign-out and passkey ceremonies: open to anyone by design, or end the session; tested in auth.test.ts and passkeys tests'],
  [/^\/api\/session$/, 'answers about the caller only'],
  [/^\/api\/security\/(recovery|contacts\/[^/]+\/(accept|decline))/, 'recovery is open to a person who has lost access, by design; tested in recovery tests'],
  [/^\/api\/workspaces$/, 'creates B\'s own workspace; the switch into A\'s is swept'],
  [/^\/api\/(health|ready|live)/, 'probes: no tenant data'],
]
const leftOut = (path: string): boolean => LEFT_OUT.some(([re]) => re.test(path))

const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const ROUTES = [...source.matchAll(/^route\('(GET|POST|PUT|PATCH|DELETE)', '([^']+)'/gm)].map((m) => ({ method: m[1]!, path: m[2]! }))
const classOf = (path: string): string => path.split('/')[2] ?? ''

describe('R7-075: tenant isolation on every route class', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-tenant-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT), QED_AI_PROVIDER: 'none', QED_TEST_STACK: '1', QED_REQUESTS_PER_MINUTE: '1000000' })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })

  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', ...(csrf ? { 'x-qed-csrf': csrf } : {}) } : {}) }, ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const text = await res.text()
      let json: J = {}
      try { json = JSON.parse(text) as J } catch { /* not JSON */ }
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json, text }
    }
    const ok = async (m: string, p: string, b?: unknown): Promise<J> => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${r.text}`); return r.json }
    return { call, ok }
  }

  /** A digest of every row that belongs to a workspace or person, in every table that names an owner, and the number of rows. */
  function snapshot(owner: string): { digest: string; rows: number } {
    const h = createHash('sha256'); let rows = 0
    for (const t of api.ctx.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
      if (['rate_limits', 'sessions', 'audit', 'events', 'access_log'].includes(t.name)) continue // other people's calls are logged here by design; not A's records
      const cols = api.ctx.db.all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => c.name)
      const key = ['user_id', 'workspace_id', 'person_id'].find((c) => cols.includes(c))
      if (!key) continue
      for (const r of api.ctx.db.all(`SELECT * FROM ${t.name} WHERE ${key} = ? ORDER BY rowid`, owner)) { h.update(t.name + JSON.stringify(r)); rows++ }
    }
    return { digest: h.digest('hex'), rows }
  }
  const ID = /\b[a-z]{2,5}_[A-Za-z0-9]{6,}\b/g
  const fill = (path: string, id: string): string => path.replace(/:[a-z]+/gi, encodeURIComponent(id))

  it('B reads nothing of A\'s and changes nothing of A\'s through any route, with any of A\'s identifiers', async () => {
    const authA = authenticatorFor(PORT), authB = authenticatorFor(PORT)
    const a = client(), b = client()
    const sa = await signUp(a.ok, authA, 'tenant-a', 'Tenant A Person'), sb = await signUp(b.ok, authB, 'tenant-b', 'Tenant B Person')
    await a.ok('POST', '/api/household', { opening: { bank: 200_000_000, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 }, profile: { income: 15_000_000, spending: 5_000_000, line: 20_000_000, personalLoanEmi: 0, homeLoanEmi: 0, lateDays: 5, lostSalaries: 1, incomeDay: 1, emiDay: 5 } })
    await b.ok('POST', '/api/household', { opening: { bank: 50_000_000, fd: 0, card: 0, personalLoan: 0, homeLoan: 0 }, profile: { income: 9_000_000, spending: 3_000_000, line: 10_000_000, personalLoanEmi: 0, homeLoanEmi: 0, lateDays: 5, lostSalaries: 1, incomeDay: 1, emiDay: 5 } })

    // A's records, in the household: a payee, a bill with a memo, a signed approval, the action it made, an instruction draft
    const payee = await a.ok('POST', '/api/payees', { name: 'Ravi Kumar', handle: 'ravi.kumar@upi', category: 'family' })
    const bill = await a.ok('POST', '/api/bills', { payeeId: payee.id, amount: 245_000, dueAt: Date.now() + 3 * 86_400_000, memo: 'TENANT-A-SECRET-MEMO' })
    const pv = await a.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount: 61_100 })
    await approve(a.ok, authA, pv.approvalId, pv.docHash)
    const action = await a.ok('POST', '/api/actions', { approvalId: pv.approvalId })
    const prog = await a.ok('POST', '/api/programs', { kind: 'bills', params: { payeeHandles: ['ravi.kumar@upi'], capPerBill: 300_000 }, authority: { expiresAt: Date.now() + 30 * 86_400_000, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    // and in a business of A's
    await stepUp(a.ok, authA)
    const ws = await a.ok('POST', '/api/workspaces', { name: 'TENANT-A-FIRM' })
    const wsId = String(ws.id ?? ws.workspaceId ?? ws.workspace?.id)
    const meera = await a.ok('POST', '/api/payees', { name: 'Meera Nair', handle: 'meera.nair@upi', category: 'supplier' })

    // everything A can see, from A's own reads of every route without a parameter, in the business and in the household
    const secrets = new Set<string>(['ravi.kumar@upi', 'meera.nair@upi', 'TENANT-A-SECRET-MEMO', 'TENANT-A-FIRM', 'Tenant A Person', 'tenant-a'])
    const ids = new Set<string>([payee.id, bill.id, pv.approvalId, action.id, prog.programId, meera.id, wsId, sa.userId].filter(Boolean).map(String))
    const harvest = async (): Promise<void> => {
      for (const r of ROUTES.filter((x) => x.method === 'GET' && !x.path.includes(':') && !leftOut(x.path))) {
        const got = await a.call('GET', r.path)
        if (got.status === 200) for (const m of got.text.matchAll(ID)) ids.add(m[0])
      }
    }
    await harvest()
    await a.ok('POST', `/api/workspaces/${wsId}/switch`)
    await harvest()
    await a.ok('POST', `/api/workspaces/${sa.userId}/switch`)
    expect(ids.size).toBeGreaterThan(8)
    // B's own identifiers are not A's: take them out, so a request for one's own record is not mistaken for a leak
    const mineB = new Set<string>([sb.userId])
    for (const r of ROUTES.filter((x) => x.method === 'GET' && !x.path.includes(':') && !leftOut(x.path))) { const got = await b.call('GET', r.path); if (got.status === 200) for (const m of got.text.matchAll(ID)) mineB.add(m[0]) }
    const aIds = [...ids].filter((i) => !mineB.has(i))
    expect(aIds).toContain(String(payee.id)); expect(aIds).toContain(String(action.id))

    const aBefore = snapshot(sa.userId), wsBefore = snapshot(wsId)
    expect(aBefore.rows).toBeGreaterThan(10)
    expect(snapshot(sa.userId)).toEqual(aBefore) // the snapshot is stable when nothing happens

    const leaks: string[] = [], tally: Record<string, { requests: number; refused: number; ok: number }> = {}
    const note = (cls: string, status: number): void => { const t = (tally[cls] ??= { requests: 0, refused: 0, ok: 0 }); t.requests++; if (status >= 400) t.refused++; else t.ok++ }
    const inspect = (label: string, status: number, text: string): void => {
      for (const s of secrets) if (text.includes(s)) leaks.push(`${label} -> ${status} contains A's ${JSON.stringify(s)}`)
      // an identifier of A's may be echoed by a refusal that repeats what was asked; in a successful answer it is a leak
      if (status < 300) for (const i of aIds) if (text.includes(i)) leaks.push(`${label} -> ${status} contains A's identifier ${i}`)
    }
    // positive control: the same check, run on what A's own session reads, does find A's markers (so an empty result for B means something)
    const control = await a.call('GET', '/api/payees')
    inspect('control GET /api/payees as A', control.status, control.text)
    expect(leaks.length).toBeGreaterThan(0)
    leaks.length = 0
    // every identifier field a handler might read from a body (the name, address and reason are B's own words: a handler that echoes them back is not a leak)
    const body = { id: payee.id, ...Object.fromEntries(['payeeId', 'billId', 'approvalId', 'actionId', 'programId', 'workspaceId', 'proposalId', 'runId', 'milestoneId', 'jobId', 'disputeId', 'receiptId', 'noticeId', 'sessionId', 'credentialId', 'passkeyId', 'contactId', 'linkId', 'caseId', 'ideaId', 'goalId', 'handle', 'name', 'amount', 'reason'].map((k) => [k, k === 'handle' ? 'b.attacker@upi' : k === 'amount' ? 1000 : k === 'reason' ? 'B says something went wrong' : k === 'name' ? 'B Attacker' : k === 'approvalId' ? pv.approvalId : k === 'actionId' ? action.id : k === 'programId' ? prog.programId : k === 'billId' ? bill.id : k === 'workspaceId' ? wsId : payee.id])) }

    // 1 · routes with an identifier in the path: each of A's identifiers, every method
    for (const r of ROUTES.filter((x) => x.path.includes(':') && !leftOut(x.path))) {
      for (const id of aIds) {
        const p = fill(r.path, id)
        const got = await b.call(r.method, p, r.method === 'GET' ? undefined : body)
        note(classOf(r.path), got.status); inspect(`${r.method} ${p}`, got.status, got.text)
      }
    }
    // 2 · routes without one: B reads and writes with A's identifiers in every field
    for (const r of ROUTES.filter((x) => !x.path.includes(':') && !leftOut(x.path))) {
      const got = await b.call(r.method, r.path, r.method === 'GET' ? undefined : body)
      note(classOf(r.path), got.status); inspect(`${r.method} ${r.path}`, got.status, got.text)
    }
    // 3 · B asks to switch into A's business: refused, and B's reads stay B's
    const sw = await b.call('POST', `/api/workspaces/${wsId}/switch`)
    expect(sw.status, sw.text).toBeGreaterThanOrEqual(400)
    const after = await b.call('GET', '/api/payees')
    expect(after.text).not.toContain('meera.nair@upi')

    expect(leaks).toEqual([])
    // A's records are what they were
    expect(snapshot(sa.userId)).toEqual(aBefore)
    expect(snapshot(wsId)).toEqual(wsBefore)
    // the sweep reached every class of route, and most requests were refused (a handful answer 200 with B's own, empty, data)
    const classes = new Set(ROUTES.filter((x) => !leftOut(x.path)).map((x) => classOf(x.path)))
    const missed = [...classes].filter((c) => !tally[c])
    expect(missed).toEqual([])
    const total = Object.values(tally).reduce((n, t) => n + t.requests, 0)
    expect(total).toBeGreaterThan(2000)
    console.log(`tenant isolation: ${ROUTES.length} routes (${ROUTES.length - ROUTES.filter((r) => !leftOut(r.path)).length} left out with reasons), ${classes.size} classes, ${total} requests as B, ${aIds.length} of A's identifiers; ${Object.entries(tally).map(([c, t]) => `${c}:${t.requests}/${t.ok}ok`).join(' ')}`)
  }, 300_000)
})
