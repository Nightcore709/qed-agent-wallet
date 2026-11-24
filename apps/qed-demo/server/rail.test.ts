/**
 * The wallet's side of the multi-tenant rail (server/rail.ts), against a recording stand-in for the rail's HTTP
 * contract (chain/README.md, "The multi-tenant HTTP contract (R7)"). The rail's own tests check the chain side: that
 * these assertions verify in QEDOwnerAccount. Here: what the wallet sends, to which workspace, and what it refuses.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { beginAddPasskey, beginSignup, finishAddPasskey, finishSignup, type RelyingParty } from './passkeys.ts'
import { addMember, createBusiness, setPolicy } from './workspaces.ts'
import { type Asker, railCurrenciesBegin, railExecute, railOverview, railPolicySchedule, railPropose, railRead, railRun, railSetup, railSignBegin, railSignFinish, railWorkspaceId, vaultOf } from './rail.ts'
import { clearStop, setStop } from './runner.ts'
import { SoftAuthenticator } from './softauthn.ts'
import type { Ctx } from './types.ts'
import { assetSetDigest, type AssetSetDocument } from '../shared/chain-assets.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175', 'http://localhost:5174'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 22, 9, 0)
type Db = ReturnType<typeof openDb>

// ------------------------------------------------------------------------------------------------ a recording rail
interface Seen { method: string; path: string; body: Record<string, unknown>; key: string | undefined; auth: string | undefined }
const seen: Seen[] = []
const workspaces = new Map<string, Record<string, unknown>>()
let activePolicyIn: string | null = null
/** The id the stand-in gives the active policy (a policy signed again gets a new one). */
let policyId = 7
let server: Server
const DIGEST = `0x${'ab'.repeat(32)}`
const TOKEN = randomBytes(24).toString('hex')

function reply(res: import('node:http').ServerResponse, status: number, json: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const path = req.url ?? '', method = req.method ?? ''
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      seen.push({ method, path, body, key: req.headers['idempotency-key'] as string | undefined, auth: req.headers.authorization })
      if (path === '/health') return reply(res, 200, { ready: true, mode: 'multi-tenant', workspaces: workspaces.size })
      if (method === 'POST' && path === '/workspaces') {
        const id = String(body.workspaceId)
        const was = workspaces.get(id)
        const owner = body.owner as { signers: { x: string; y: string }[]; threshold: number }
        const view = { id, status: 'awaiting-acceptance', ownerKind: 'passkey-account', ownerAccount: `0x${createHash('sha256').update(id).digest('hex').slice(0, 40)}`, signers: owner.signers.map((k) => ({ ...k, role: 'member' })), threshold: owner.threshold, asset: { symbol: 'tINR', decimals: 2 }, reserveAsset: { symbol: 'tUSD', decimals: 6 }, grant: null }
        workspaces.set(id, view)
        return reply(res, was ? 200 : 201, { ...view, duplicate: !!was })
      }
      const m = /^\/workspaces\/([a-z0-9-]+)(\/.*)?$/.exec(path)
      if (!m) return reply(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
      const ws = workspaces.get(m[1]!)
      if (!ws) return reply(res, 404, { error: { code: 'unknown_workspace', message: 'Unknown workspace.' } })
      const rest = m[2] ?? ''
      if (method === 'GET' && rest === '') return reply(res, 200, ws)
      if (method === 'GET' && rest === '/state') return reply(res, 200, { provisioned: false, policy: activePolicyIn === m[1] ? { id: policyId, status: 'active', targetMet: false } : null })
      if (method === 'GET' && rest === '/scheduled') return reply(res, 200, { scheduled: [] })
      if (method === 'GET' && rest === '/mandates') return reply(res, 200, { mandates: [], workspace: m[1] })
      if (method === 'POST' && rest === '/proposals') {
        const id = `prop-${randomBytes(6).toString('hex')}`
        return reply(res, 201, { id, kind: body.kind, summary: 'Accept ownership of this workspace\'s vault set.', termsHash: `sha256:${'cd'.repeat(32)}`, expiresAt: new Date(T0 + 600_000).toISOString(), network: 'local',
          terms: { kind: body.kind, toSign: [{ kind: 'execute', account: ws.ownerAccount, chainId: 31337, nonce: '0', deadline: String(T0 / 1000 + 1200), calls: [{ target: '0x0000000000000000000000000000000000000001', value: '0', data: '0x79ba5097', action: 'QEDVault (treasury).acceptOwnership' }], digest: DIGEST, threshold: Number((ws as { threshold?: number }).threshold ?? 1), note: 'The passkey signs this digest.' }] } })
      }
      if (method === 'POST' && /^\/proposals\/[^/]+\/execute$/.test(rest)) return reply(res, 202, { jobId: `job-${req.headers['idempotency-key']}`, status: 'accepted', duplicate: seen.filter((s) => s.key === req.headers['idempotency-key']).length > 1 })
      if (method === 'POST' && rest === '/policy/tick') return reply(res, 202, { jobId: 'job-tick', duplicate: false })
      return reply(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const dir = mkdtempSync(join(tmpdir(), 'qed-rail-test-'))
  writeFileSync(join(dir, 'rail.token'), TOKEN, { mode: 0o600 })
  process.env.QED_RAIL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.QED_RAIL_TOKEN_FILE = join(dir, 'rail.token')
})
afterAll(async () => { delete process.env.QED_RAIL_URL; delete process.env.QED_RAIL_TOKEN_FILE; await new Promise<void>((r) => server.close(() => r())) })
beforeEach(() => { seen.length = 0; workspaces.clear(); activePolicyIn = null; policyId = 7 })

const CFG = { dbPath: '/nowhere/qed.db' }
async function person(db: Db, handle: string, origin = RP.origins[0]!): Promise<{ auth: SoftAuthenticator; who: Asker }> {
  const auth = new SoftAuthenticator({ origin })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  const session = sessionFor(db, r.session.token, T0)!
  return { auth, who: { workspaceId: r.personId, personId: r.personId, role: 'owner', session } }
}
const b64u = (hex: string): string => Buffer.from(hex.slice(2), 'hex').toString('base64url')

describe('the vault: one rail workspace per household, owned by its passkeys', () => {
  it('sets up the vault with the person\'s passkeys as signers, one signature, the relying party and the origin in use', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await expect(railSetup(CFG, db, RP, who, 'http://evil.example', T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(railSetup(CFG, db, RP, { ...who, workspaceId: 'usr_someone_else' }, RP.origins[0], T0)).rejects.toMatchObject({ code: 'not_permitted' })
    const view = await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const sent = seen.find((s) => s.method === 'POST' && s.path === '/workspaces')!
    expect(sent.auth).toBe(`Bearer ${TOKEN}`)
    expect(sent.body).toEqual({
      workspaceId: railWorkspaceId(who.workspaceId),
      owner: { signers: [{ x: `0x${auth.x.toString('hex')}`, y: `0x${auth.y.toString('hex')}` }], threshold: 1 },
      rpIdHash: `0x${createHash('sha256').update('localhost').digest('hex')}`,
      origin: 'http://localhost:5175',
    })
    expect(railWorkspaceId(who.workspaceId)).toMatch(/^qed-[0-9a-f]{24}$/)
    expect(view.status).toBe('awaiting-acceptance')
    expect(vaultOf(db, who.workspaceId)?.request).toEqual(sent.body)
    // asked again (a lost reply): exactly the same body, and the rail answers with the same workspace
    workspaces.get(railWorkspaceId(who.workspaceId))!.status = 'deploying'
    await railSetup(CFG, db, RP, who, RP.origins[1], T0 + 1000)
    expect(seen.filter((s) => s.method === 'POST' && s.path === '/workspaces').map((s) => s.body)).toEqual([sent.body, sent.body])
    const o = await railOverview(CFG, db, RP, who)
    expect(o).toMatchObject({ available: true, setUp: true, origin: 'http://localhost:5175', passkeys: [{ name: 'asha\'s laptop', signer: true }] })
  })

  it('the passkey signs each digest the terms list, and the rail receives the assertions as the approval\'s sixth field', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    const p = await railPropose(CFG, db, who, { kind: 'provision', params: {} }, T0 + 1000)
    expect(p.sign).toEqual([{ item: 0, kind: 'execute', digest: DIGEST, signers: 1 }])
    const doc = JSON.parse(db.get<{ document: string }>('SELECT document FROM approvals WHERE id = ?', String(p.approvalId))!.document) as { vault: string; sign: unknown[] }
    expect(doc.vault).toBe(railWorkspaceId(who.workspaceId))
    // not yet signed: nothing can be sent
    await expect(railExecute(CFG, db, who, String((p.proposal as { id: string }).id), String(p.approvalId), T0 + 1500)).rejects.toMatchObject({ code: 'approval_missing' })
    const begin = await railSignBegin(db, RP, who, String(p.approvalId), T0 + 2000)
    expect(begin.challenges).toHaveLength(1)
    const options = begin.challenges[0]!.options as { challenge: string; allowCredentials: { id: string }[]; userVerification: string }
    expect(options.challenge).toBe(b64u(DIGEST))
    expect(options.allowCredentials.map((c) => c.id)).toEqual([auth.id])
    expect(options.userVerification).toBe('required')
    const done = await railSignFinish(CFG, db, RP, who, String(p.approvalId), [{ challengeId: begin.challenges[0]!.challengeId, response: auth.get(options) }], String(p.docHash), T0 + 3000)
    expect(done).toMatchObject({ complete: true, method: 'passkey' })
    const proposalId = String((p.proposal as { id: string }).id)
    const job = await railExecute(CFG, db, who, proposalId, String(p.approvalId), T0 + 4000)
    expect(job.jobId).toBe(`job-${String(p.approvalId)}`)
    const sent = seen.find((s) => s.path === `/workspaces/${railWorkspaceId(who.workspaceId)}/proposals/${proposalId}/execute`)!
    expect(sent.key).toBe(p.approvalId)
    const approval = sent.body.approval as Record<string, unknown>
    expect(Object.keys(approval).sort()).toEqual(['approvalId', 'confirmedAt', 'docHash', 'method', 'signatures', 'termsHash'])
    expect(approval).toMatchObject({ approvalId: p.approvalId, docHash: `sha256:${String(p.docHash)}`, termsHash: `sha256:${'cd'.repeat(32)}`, method: 'passkey' })
    const [entry] = approval.signatures as { assertions: { publicKey: { x: string; y: string }; authenticatorData: string; clientDataJSON: string; signature: string }[] }[]
    expect(entry!.assertions).toHaveLength(1)
    const a = entry!.assertions[0]!
    expect(a.publicKey).toEqual({ x: `0x${auth.x.toString('hex')}`, y: `0x${auth.y.toString('hex')}` })
    expect(JSON.parse(a.clientDataJSON)).toMatchObject({ type: 'webauthn.get', challenge: b64u(DIGEST), origin: 'http://localhost:5175' })
    expect(a.authenticatorData.slice(0, 66)).toBe(`0x${createHash('sha256').update('localhost').digest('hex')}`)
    expect(a.signature).toMatch(/^0x30[0-9a-f]+$/)
    // presented again after a lost reply: the same key, so the same job
    await railExecute(CFG, db, who, proposalId, String(p.approvalId), T0 + 5000)
    expect(seen.filter((s) => s.path.endsWith('/execute')).map((s) => s.key)).toEqual([p.approvalId, p.approvalId])
  })

  it('a signature made at another origin, or by a passkey that is not a signer, approves nothing', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await railSetup(CFG, db, RP, who, RP.origins[0], T0)
    // a passkey added after the vault was set up is not one of its signers
    const phone = new SoftAuthenticator({ origin: RP.origins[0]! })
    const add = await beginAddPasskey(db, RP, who.session, T0 + 100)
    await finishAddPasskey(db, RP, who.session, { challengeId: add.challengeId, response: phone.create(add.options as never), passkeyName: 'Phone' }, META.ua, T0 + 100)
    expect((await railOverview(CFG, db, RP, who)).passkeys).toMatchObject([{ name: 'asha\'s laptop', signer: true }, { name: 'Phone', signer: false }])
    const p = await railPropose(CFG, db, who, { kind: 'provision', params: {} }, T0 + 1000)
    const begin = await railSignBegin(db, RP, who, String(p.approvalId), T0 + 2000)
    const options = begin.challenges[0]!.options as { challenge: string; allowCredentials: { id: string }[] }
    expect(options.allowCredentials.map((c) => c.id)).toEqual([auth.id])
    await expect(railSignFinish(CFG, db, RP, who, String(p.approvalId), [{ challengeId: begin.challenges[0]!.challengeId, response: phone.get(options) }], String(p.docHash), T0 + 3000)).rejects.toMatchObject({ code: 'not_a_vault_signer' })
    // the development server's origin is accepted for passkeys, but the vault's account takes the one it was set up with
    const again = await railSignBegin(db, RP, who, String(p.approvalId), T0 + 4000)
    await expect(railSignFinish(CFG, db, RP, who, String(p.approvalId), [{ challengeId: again.challenges[0]!.challengeId, response: auth.get(again.challenges[0]!.options as never, { origin: 'http://localhost:5174' }) }], String(p.docHash), T0 + 5000)).rejects.toMatchObject({ code: 'vault_origin' })
    expect(db.get<{ confirmed_at: number | null }>('SELECT confirmed_at FROM approvals WHERE id = ?', String(p.approvalId))!.confirmed_at).toBeNull()
    expect(seen.some((s) => s.path.endsWith('/execute'))).toBe(false)
  })

  it('two households never reach each other\'s vault, and the scheduler ticks each active policy in its own workspace', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    // Ravi has no vault: nothing of Asha's is offered to him
    await expect(railRead(CFG, db, ravi.who, 'mandates', new URLSearchParams())).rejects.toMatchObject({ code: 'vault_not_set_up' })
    await railSetup(CFG, db, RP, ravi.who, RP.origins[0], T0)
    const ids = seen.filter((s) => s.path === '/workspaces').map((s) => String(s.body.workspaceId))
    expect(new Set(ids).size).toBe(2)
    expect((await railRead(CFG, db, ravi.who, 'mandates', new URLSearchParams())).workspace).toBe(railWorkspaceId(ravi.who.workspaceId))
    // Asha's approval cannot be used by Ravi, whatever proposal he names
    const p = await railPropose(CFG, db, asha.who, { kind: 'provision', params: {} }, T0 + 1000)
    await expect(railExecute(CFG, db, ravi.who, String((p.proposal as { id: string }).id), String(p.approvalId), T0 + 2000)).rejects.toMatchObject({ code: 'not_found' })
    await expect(railSignBegin(db, RP, ravi.who, String(p.approvalId), T0 + 2000)).rejects.toMatchObject({ code: 'not_found' })
    activePolicyIn = railWorkspaceId(asha.who.workspaceId)
    const did = await railPolicySchedule(CFG, db, T0 + 600_000)
    const ticks = seen.filter((s) => s.path.endsWith('/policy/tick'))
    expect(ticks.map((s) => s.path)).toEqual([`/workspaces/${railWorkspaceId(asha.who.workspaceId)}/policy/tick`])
    expect(ticks[0]!.key).toBe(`sched-7-${Math.floor((T0 + 600_000) / 300_000)}`)
    expect(did).toMatch(/^tick job-tick in qed-/)
  })

  it('the engine\'s half-minute pass ticks a policy signed just now, in its own slot, once: not asked again in that slot, a policy signed again is asked at once, and the next slot asks again (R13, Topic F)', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    activePolicyIn = railWorkspaceId(asha.who.workspaceId)
    const start = Math.ceil((T0 + 600_000) / 300_000) * 300_000, slot = start / 300_000
    const asked = new Set<string>()
    const ticks = () => seen.filter((s) => s.path.endsWith('/policy/tick')).map((s) => s.key)
    // signed a moment ago: the engine's next pass asks for its first tick, in this slot
    expect(await railPolicySchedule(CFG, db, start + 10_000, asked)).toMatch(/^tick job-tick in qed-/)
    // half a minute later, the same slot: nothing is asked again
    expect(await railPolicySchedule(CFG, db, start + 40_000, asked)).toBe('each active policy already asked for in this slot')
    // revoked and signed again within the slot (a new policy id): asked for at the next pass, not five minutes later
    policyId = 8
    expect(await railPolicySchedule(CFG, db, start + 70_000, asked)).toMatch(/^tick job-tick in qed-/)
    // the next slot: asked again, and the past slot's keys are forgotten
    await railPolicySchedule(CFG, db, start + 310_000, asked)
    expect(ticks()).toEqual([`sched-7-${slot}`, `sched-8-${slot}`, `sched-8-${slot + 1}`])
    expect([...asked]).toEqual([`sched-8-${slot + 1}`])
    // without the engine's set (a restart, a test) the slot's key is asked again; the vault service answers it with the same job
    await railPolicySchedule(CFG, db, start + 320_000)
    expect(ticks().at(-1)).toBe(`sched-8-${slot + 1}`)
  })

  it('"Stop everything" stops the vault\'s standing policy too: a stopped workspace is not ticked, in either stop mode, and is ticked again once resumed', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    activePolicyIn = railWorkspaceId(asha.who.workspaceId)
    const ctx = { db, clock: { now: () => T0 + 600_000 } } as unknown as Ctx
    const ticks = () => seen.filter((s) => s.path.endsWith('/policy/tick'))
    for (const keepProtective of [false, true]) {
      setStop(ctx, asha.who.workspaceId, 'Stopped by you', keepProtective)
      const did = await railPolicySchedule(CFG, db, T0 + 600_000)
      expect(ticks()).toEqual([])
      expect(did).toBe(`not ticked in ${railWorkspaceId(asha.who.workspaceId)}: paused by the owner`)
      clearStop(ctx, asha.who.workspaceId)
    }
    const did = await railPolicySchedule(CFG, db, T0 + 600_000)
    expect(ticks().map((s) => s.path)).toEqual([`/workspaces/${railWorkspaceId(asha.who.workspaceId)}/policy/tick`])
    expect(did).toMatch(/^tick job-tick in qed-/)
  })

  it('"Stop everything" also refuses a tick or a run asked for from the policy page, in either stop mode, before the vault service is asked; once resumed it goes through (R7-091)', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    activePolicyIn = railWorkspaceId(asha.who.workspaceId)
    const ctx = { db, clock: { now: () => T0 + 600_000 } } as unknown as Ctx
    const asked = () => seen.filter((s) => /\/policy\/(tick|run)$/.test(s.path))
    for (const keepProtective of [false, true]) {
      setStop(ctx, asha.who.workspaceId, 'Stopped by you', keepProtective)
      for (const what of ['policy/tick', 'policy/run']) await expect(railRun(CFG, db, asha.who, what, { key: `k-${what.replace('/', '-')}-${String(keepProtective)}` }, T0 + 600_000)).rejects.toMatchObject({ code: 'paused' })
      expect(asked()).toEqual([])
      clearStop(ctx, asha.who.workspaceId)
    }
    await railRun(CFG, db, asha.who, 'policy/tick', { key: 'k-after-resume' }, T0 + 600_000)
    expect(asked().map((s) => s.path)).toEqual([`/workspaces/${railWorkspaceId(asha.who.workspaceId)}/policy/tick`])
  })

  it('a shared workspace: one passkey per signing member, the workspace\'s count as the threshold; the last member\'s signature sends it with both', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    const ws = createBusiness(db, asha.who.personId, 'Traders', T0)
    const owner: Asker = { ...asha.who, workspaceId: ws, role: 'owner' }
    // a second member who may sign, and a policy of two signatures
    addMember(db, ws, { personId: asha.who.personId, role: 'owner' }, 'ravi', 'approver', T0)
    setPolicy(db, ws, { personId: asha.who.personId, role: 'owner' }, { signers: 2 }, T0)
    const second: Asker = { ...ravi.who, workspaceId: ws, role: 'approver' }
    await expect(railSetup(CFG, db, RP, second, RP.origins[0], T0)).rejects.toMatchObject({ code: 'not_permitted' })
    await railSetup(CFG, db, RP, owner, RP.origins[0], T0)
    const sent = seen.find((s) => s.method === 'POST' && s.path === '/workspaces')!
    const key = (a: SoftAuthenticator) => ({ x: `0x${a.x.toString('hex')}`, y: `0x${a.y.toString('hex')}` })
    const byX = (a: { x: string }, b: { x: string }) => a.x.localeCompare(b.x)
    const o = sent.body.owner as { signers: { x: string; y: string }[]; threshold: number; adminThreshold: number }
    expect({ ...o, signers: [...o.signers].sort(byX) }).toEqual({ signers: [key(asha.auth), key(ravi.auth)].sort(byX), threshold: 2, adminThreshold: 2 })
    expect(vaultOf(db, ws)?.members?.map((m) => m.personId).sort()).toEqual([asha.who.personId, ravi.who.personId].sort())
    // the owner prepares and signs: one of two, nothing is sent
    const p = await railPropose(CFG, db, owner, { kind: 'provision', params: {} }, T0 + 1000)
    expect(db.get<{ required_signers: number; expires_at: number }>('SELECT required_signers, expires_at FROM approvals WHERE id = ?', String(p.approvalId))).toMatchObject({ required_signers: 2 })
    const b1 = await railSignBegin(db, RP, owner, String(p.approvalId), T0 + 2000)
    expect((b1.challenges[0]!.options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id)).toEqual([asha.auth.id])
    const first = await railSignFinish(CFG, db, RP, owner, String(p.approvalId), [{ challengeId: b1.challenges[0]!.challengeId, response: asha.auth.get(b1.challenges[0]!.options as never) }], String(p.docHash), T0 + 3000)
    expect(first).toMatchObject({ complete: false, signed: 1, required: 2 })
    expect(seen.some((s) => s.path.endsWith('/execute'))).toBe(false)
    // the second member signs the same digest; the approval is complete and is sent with both assertions
    const b2 = await railSignBegin(db, RP, second, String(p.approvalId), T0 + 4000)
    const last = await railSignFinish(CFG, db, RP, second, String(p.approvalId), [{ challengeId: b2.challenges[0]!.challengeId, response: ravi.auth.get(b2.challenges[0]!.options as never) }], String(p.docHash), T0 + 5000)
    expect(last).toMatchObject({ complete: true, signed: 2, required: 2, jobId: `job-${String(p.approvalId)}` })
    const exec = seen.filter((s) => s.path.endsWith('/execute'))
    expect(exec).toHaveLength(1)
    const [entry] = (exec[0]!.body.approval as { signatures: { assertions: { publicKey: { x: string } }[] }[] }).signatures
    expect(entry!.assertions.map((a) => a.publicKey.x)).toEqual([key(asha.auth).x, key(ravi.auth).x])
  })
})


// The R13 security review's lead L-08 (docs/SECURITY-REVIEW-R13.md section 4); scripts/security.ts runs this by its check
// id and records it as one of its checks.
describe('R13 lead checks: what the scheduler records', () => {
  it('R21 (L-08): each workspace\'s tick, or its pause, is recorded as that workspace\'s own event, naming only its own vault', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    await railSetup(CFG, db, RP, asha.who, RP.origins[0], T0)
    await railSetup(CFG, db, RP, ravi.who, RP.origins[0], T0)
    activePolicyIn = railWorkspaceId(asha.who.workspaceId)
    setStop({ db, clock: { now: () => T0 + 600_000 } } as unknown as Ctx, ravi.who.workspaceId, 'Stopped by you', false)
    await railPolicySchedule(CFG, db, T0 + 600_000)
    const evs = db.all<{ user_id: string | null; payload_json: string }>(`SELECT user_id, payload_json FROM events WHERE type = 'vault'`)
    const a = railWorkspaceId(asha.who.workspaceId), r = railWorkspaceId(ravi.who.workspaceId)
    const of = (ws: string) => evs.filter((e) => e.user_id === ws).map((e) => e.payload_json)
    expect(of(asha.who.workspaceId)).toEqual([expect.stringContaining(`tick job-tick in ${a}`)])
    expect(of(ravi.who.workspaceId)).toEqual([expect.stringContaining(`not ticked in ${r}: paused by the owner`)])
    expect(of(asha.who.workspaceId).some((p) => p.includes(r)) || of(ravi.who.workspaceId).some((p) => p.includes(a))).toBe(false)
    expect(evs.filter((e) => e.user_id === null)).toEqual([])
  })
})

describe('test tokens other than the default (money-model S5): chosen at setup, under the owner\'s passkey signature', () => {
  const SET = { treasury: 'EUR', reserve: 'JPY', route: 'BHD' }
  it('are sent only with the owner\'s assertion over exactly that configuration; the default needs none, and nothing is sent for a refusal', async () => {
    const db = openDb(':memory:')
    const { auth, who } = await person(db, 'asha')
    await expect(railSetup(CFG, db, RP, who, RP.origins[0], T0, { currencies: SET })).rejects.toMatchObject({ code: 'currencies_not_signed' })
    await expect(railCurrenciesBegin(db, RP, who, RP.origins[0], { treasury: 'INR', reserve: 'USD', route: 'EUR' }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(railCurrenciesBegin(db, RP, who, RP.origins[0], { treasury: 'EUR', reserve: 'EUR', route: 'BHD' }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(railCurrenciesBegin(db, RP, who, 'http://evil.example', SET, T0)).rejects.toMatchObject({ code: 'invalid' })
    expect(seen.filter((s) => s.path === '/workspaces')).toEqual([])
    const b = await railCurrenciesBegin(db, RP, who, RP.origins[0], SET, T0) as { document: AssetSetDocument; digest: string; challengeId: string; options: { challenge: string } }
    expect(b.document).toMatchObject({ kind: 'qed/workspace-currencies/v1', workspaceId: railWorkspaceId(who.workspaceId), realMoney: false, currencies: SET, origin: RP.origins[0] })
    expect(b.digest).toBe(assetSetDigest(b.document))
    expect(b.options.challenge, 'the passkey signs the configuration\'s digest').toBe(b64u(b.digest))
    // a signature over another set does not choose this one
    const other = await railCurrenciesBegin(db, RP, who, RP.origins[0], { treasury: 'GBP', reserve: 'JPY', route: 'BHD' }, T0) as { challengeId: string; options: unknown }
    await expect(railSetup(CFG, db, RP, who, RP.origins[0], T0, { currencies: SET, challengeId: other.challengeId, response: auth.get(other.options as never) })).rejects.toMatchObject({ code: 'currencies_mismatch' })
    expect(seen.filter((s) => s.path === '/workspaces')).toEqual([])
    await railSetup(CFG, db, RP, who, RP.origins[0], T0 + 1000, { currencies: SET, challengeId: b.challengeId, response: auth.get(b.options as never) })
    const sent = seen.find((s) => s.method === 'POST' && s.path === '/workspaces')!
    expect(sent.body.currencies).toEqual(SET)
    const [a] = (sent.body.authorization as { assertions: { publicKey: unknown; clientDataJSON: string }[] }).assertions
    expect(a!.publicKey).toEqual({ x: `0x${auth.x.toString('hex')}`, y: `0x${auth.y.toString('hex')}` })
    expect(JSON.parse(a!.clientDataJSON)).toMatchObject({ type: 'webauthn.get', challenge: b64u(b.digest), origin: RP.origins[0] })
    expect(vaultOf(db, who.workspaceId)?.request).toEqual(sent.body)
    // the vault's test tokens are fixed once it is set up
    await expect(railCurrenciesBegin(db, RP, who, RP.origins[0], SET, T0 + 2000)).rejects.toMatchObject({ code: 'vault_exists' })
  })

  it('a shared workspace keeps the default test tokens for now: one owner\'s signature would choose for every member', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const ws = createBusiness(db, asha.who.personId, 'Traders', T0)
    const owner: Asker = { ...asha.who, workspaceId: ws, role: 'owner' }
    await expect(railCurrenciesBegin(db, RP, owner, RP.origins[0], SET, T0)).rejects.toMatchObject({ code: 'currencies_shared' })
    await expect(railSetup(CFG, db, RP, owner, RP.origins[0], T0, { currencies: SET })).rejects.toMatchObject({ code: 'currencies_shared' })
    expect(seen.filter((s) => s.path === '/workspaces')).toEqual([])
  })
})
