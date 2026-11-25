/**
 * The wallet's refutation bounties (server/bounties.ts; R11 §9, R10-008, R10-009):
 *   - the two original 1,000-tUSD bounties are stated exactly: the limits equal the vendored contracts' constants, the
 *     five recorded claims and the funding come from the vendored Sepolia record, and the status is dated and never
 *     says the pools are unclaimed today;
 *   - the API routes reach only the asking household's vault workspace, need a session, forward the client's key as the
 *     idempotency key, pass the vault service's refusals through, and say plainly when there is no vault or no service.
 * Against the recording stand-in of the vault service (server/rail-fake.ts). The chain side, with a real service, a
 * mempool copier and the positive controls, is chain/test/bounties.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { loadConfig, openDb, AppError } from './core.ts'
import { startApi } from './api.ts'
import { beginSignup, finishSignup, type RelyingParty } from './passkeys.ts'
import { type Asker, railSetup, railWorkspaceId } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'
import { bountiesView, checkBountyClaim, LIMITS, originalBounties, revealBountyClaim, settleBounty, submitBountyClaim } from './bounties.ts'
import { authenticatorFor, signUp } from '../scripts/lib/passkey-client.ts'

const SRC = new URL('../chain/vendor/contracts/src/', import.meta.url)
const sol = (path: string) => readFileSync(new URL(path, SRC), 'utf8')
const constant = (text: string, name: string): bigint => {
  const m = new RegExp(`constant ${name} = ([^;]+);`).exec(text)
  if (!m) throw new Error(`no constant ${name}`)
  const v = m[1]!.trim()
  const shift = /^1 << (\d+)$/.exec(v)
  if (shift) return 1n << BigInt(shift[1]!)
  const exp = /^(\d+)e(\d+)$/.exec(v)
  return exp ? BigInt(exp[1]!) * 10n ** BigInt(exp[2]!) : BigInt(v)
}

describe('the two original bounties, stated exactly (R10-008)', () => {
  const list = originalBounties() as Record<string, any>[]
  const ob = list[0]!, mb = list[1]!

  it('the stated limits are the vendored contracts\' own constants', () => {
    const mv = sol('verifiers/MinVarianceVerifier.sol'), o = sol('bounties/OptimalityBounty.sol'), m = sol('bounties/MaximalityBounty.sol'), t = sol('TestUSD.sol')
    expect(BigInt(LIMITS.optimality.maxAssets)).toBe(constant(mv, 'MAX_N'))
    expect(BigInt(LIMITS.optimality.maxTolerance)).toBe(constant(mv, 'MAX_TOL'))
    expect(BigInt(LIMITS.optimality.maxMagnitude)).toBe(constant(mv, 'BOUND'))
    expect(BigInt(LIMITS.optimality.scale)).toBe(constant(mv, 'WAD'))
    expect(BigInt(LIMITS.optimality.scale)).toBe(constant(o, 'W'))
    expect(mv).toMatch(/n < 2 \|\| n > MAX_N/) // the verifier's own lower bound on n
    expect(BigInt(LIMITS.maximality.maxDebts)).toBe(constant(m, 'MAX_EDGES'))
    expect(BigInt(LIMITS.maximality.maxMembers)).toBe(constant(m, 'MAX_MEMBERS'))
    expect(BigInt(LIMITS.maximality.potentialBound)).toBe(constant(m, 'POT_BOUND'))
    expect(BigInt(LIMITS.maximality.yBound)).toBe(constant(m, 'Y_BOUND'))
    expect(m).toMatch(/m < 2 \|\| m > MAX_MEMBERS/)
    expect(m).toMatch(/d > type\(uint128\)\.max/)
    expect(BigInt(LIMITS.maximality.maxDebt)).toBe((1n << 128n) - 1n)
    expect(t).toMatch(/function decimals\(\) public pure override returns \(uint8\) \{\s*return 6;/)
    expect(LIMITS.token.pool).toBe('1000000000')
    // the words say the same numbers
    expect(ob.limits.join(' ')).toContain('n from 2 to 16 assets')
    expect(mb.limits.join(' ')).toContain('2 to 64 members and 1 to 128 debts')
  })

  it('the deployment, funding and five claims come from the vendored Sepolia record, and match EV-076', () => {
    expect([ob.address, mb.address]).toEqual(['0xfc2129f0432538d034c5307299022b3d369eb677', '0xd767782fc47eefdfc2d764dba1b2ec0a0b557d69'])
    expect([ob.funded.hash, ob.funded.block, ob.funded.at, ob.funded.amountText]).toEqual(['0x616b0fb1d9b09f0ff736eeeb36e50d6bc6a6c381f0eff9bc527c43a6b4303775', '11951197', '2026-10-19T22:41:24Z', '1,000.00 tUSD'])
    expect([mb.funded.hash, mb.funded.block, mb.funded.by]).toEqual(['0xdf74e4c85864f21000f822c2e9b1c42f964e2b89e2ed8079529c525a66bfd614', '11951199', 'Atlas'])
    const attempts = [...ob.attempts, ...mb.attempts]
    expect(attempts.map((a: any) => [a.step, a.status, a.from, a.error.name, a.error.args])).toEqual([
      ['BA1', 'reverted', '0x56D161255Ced6863698eA3c6a886982088fa30a8', 'TheoremHolds', ['-17427890834445872562219109117693616905377777777777792', '30005320910997774926000000000000000000000000000']],
      ['BA2', 'reverted', '0x56D161255Ced6863698eA3c6a886982088fa30a8', 'TheoremHolds', ['-33039999999997790320000000000000000000000000000', '30005320910997774926000000000000000000000000000']],
      ['BA3', 'reverted', '0x56D161255Ced6863698eA3c6a886982088fa30a8', 'DualityGapTooLarge', ['19113333333333332']],
      ['BM1', 'reverted', '0x56D161255Ced6863698eA3c6a886982088fa30a8', 'TheoremHolds', ['169000000', '162000000']],
      ['BM2', 'reverted', '0x56D161255Ced6863698eA3c6a886982088fa30a8', 'NetPositionChanged', ['0', '1000000']],
    ])
    expect(attempts.every((a: any) => a.at >= '2026-10-19T22:44:24Z' && a.at <= '2026-10-19T22:45:12Z')).toBe(true)
  })

  it('the status is dated and not re-verified; nothing says the pools are unclaimed today; the copying weakness is stated', () => {
    for (const b of list) {
      expect(b.status).toBe('Last recorded 22:45:45 UTC, 19 Oct 2026: 1,000 tUSD in the pool and no successful claim; not re-verified since. Reading Sepolia today needs the owner\'s approval (Q-072).')
      expect(b.pays).toMatch(/copied pending claim therefore pays the copier/)
    }
    const text = JSON.stringify(originalBounties())
    expect(text).not.toMatch(/unclaimed|still (full|unclaimed)|today: 1,000|front-runnable for profit"? (is|are) (true|correct)/i)
    expect(text).not.toMatch(/not front-runnable/i)
  })
})

// ------------------------------------------------------------------------------------------------ the API surface

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => fake.reset())

async function person(db: Db, handle: string): Promise<Asker> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  return { workspaceId: r.personId, personId: r.personId, role: 'owner', session: sessionFor(db, r.session.token, T0)! }
}
const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AppError)
const CLAIM = { calldata: `0x88c7acb3${'00'.repeat(64)}` }

describe('the bounty routes, against a stand-in vault service', () => {
  it('a household with no vault sees the two originals and why it cannot claim yet; claiming needs a vault', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    const v = await bountiesView(CFG, db, asha) as Record<string, any>
    expect(v.originals.map((b: any) => b.name)).toEqual(['OptimalityBounty', 'MaximalityBounty'])
    // the code says which next step applies (the bounties screen offers to set the vault up); the reason says it in words
    expect(v.local).toEqual({ available: false, code: 'vault_not_set_up', reason: expect.stringMatching(/no on-chain vault yet/) })
    expect((await fail(submitBountyClaim(CFG, db, asha, '1', { key: 'key-00000001', claim: CLAIM }, T0)))?.code).toBe('vault_not_set_up')
    expect(fake.seen.filter((s) => s.path.includes('/bounties'))).toEqual([])
  })

  it('every call names the asking household\'s own vault workspace, forwards its key, and is audited', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    await railSetup(CFG, db, RP, asha, RP.origins[0]!, T0)
    await railSetup(CFG, db, RP, ravi, RP.origins[0]!, T0)
    const ws = railWorkspaceId(asha.workspaceId)
    const v = await bountiesView(CFG, db, asha) as Record<string, any>
    expect([v.local.available, v.local.bounties.map((b: any) => b.id), v.local.claimant]).toEqual([true, ['1', '2'], expect.stringMatching(/^0x[0-9a-f]{40}$/)])
    expect((await checkBountyClaim(CFG, db, asha, '1', { claim: CLAIM }) as any).valid).toBe(false)
    const c = await submitBountyClaim(CFG, db, asha, '1', { key: 'key-00000001', claim: CLAIM, payTo: 'owner-account' }, T0)
    expect(c).toMatchObject({ kind: 'bounty-commit', status: 'accepted' })
    const id = `0x${'ab'.repeat(32)}`
    await revealBountyClaim(CFG, db, asha, id, { key: 'key-00000002' }, T0)
    await settleBounty(CFG, db, asha, '1', { key: 'key-00000003' }, T0)
    const sent = fake.seen.filter((s) => s.path.includes('/bounties'))
    expect(sent.map((s) => [s.method, s.path, s.key])).toEqual([
      ['GET', `/workspaces/${ws}/bounties`, undefined],
      ['POST', `/workspaces/${ws}/bounties/1/check`, undefined],
      ['POST', `/workspaces/${ws}/bounties/1/claims`, 'ui-key-00000001'],
      ['POST', `/workspaces/${ws}/bounties/claims/${id}/reveal`, 'ui-key-00000002'],
      ['POST', `/workspaces/${ws}/bounties/1/settle`, 'ui-key-00000003'],
    ])
    expect(sent[2]!.body).toEqual({ claim: CLAIM, payTo: 'owner-account' })
    expect(sent.every((s) => !s.path.includes(railWorkspaceId(ravi.workspaceId)))).toBe(true)
    const audited = db.all<{ action: string; subject: string }>('SELECT action, subject FROM audit WHERE action LIKE ? ORDER BY ts', 'bounty.%')
    expect(audited.map((a) => a.action)).toEqual(['bounty.claim', 'bounty.reveal', 'bounty.settle'])
  })

  it('refuses malformed requests before the vault service is asked, and passes its refusals through', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    await railSetup(CFG, db, RP, asha, RP.origins[0]!, T0)
    const before = fake.seen.length
    expect((await fail(submitBountyClaim(CFG, db, asha, '1', { claim: CLAIM }, T0)))?.message).toMatch(/missing its key/)
    expect((await fail(submitBountyClaim(CFG, db, asha, 'one', { key: 'key-00000001', claim: CLAIM }, T0)))?.message).toMatch(/by its number/)
    expect((await fail(submitBountyClaim(CFG, db, asha, '1', { key: 'key-00000001' }, T0)))?.message).toMatch(/Send the claim/)
    expect((await fail(submitBountyClaim(CFG, db, asha, '1', { key: 'key-00000001', claim: CLAIM, payTo: 'someone-else' }, T0)))?.fields).toEqual({ payTo: 'Choose where the payout goes.' })
    expect((await fail(revealBountyClaim(CFG, db, asha, '0x1234', { key: 'key-00000002' }, T0)))?.status).toBe(400)
    expect(fake.seen.length).toBe(before)
    fake.refuse.bounty = { status: 422, code: 'claim_rejected', message: 'The judge rejects this claim, so it cannot be paid: The theorem holds for this claim.' }
    const e = await fail(submitBountyClaim(CFG, db, asha, '1', { key: 'key-00000004', claim: CLAIM }, T0))
    expect([e?.status, e?.code, e?.message]).toEqual([422, 'claim_rejected', 'The judge rejects this claim, so it cannot be paid: The theorem holds for this claim.'])
    fake.up = false
    const v = await bountiesView(CFG, db, asha) as Record<string, any>
    // R14: said for the person in front of it (what is wrong, that nothing changed, what to do), not for whoever runs the service
    expect([v.originals.length, v.local.available, v.local.code, v.local.reason]).toEqual([2, false, 'rail_off', expect.stringMatching(/^The on-chain wallet's service is not answering.*Nothing was sent.*Try again in a minute\.$/)])
  })

  it('the originals do not depend on the vault service: a board that is off, or a vault the service no longer knows, is said with its code', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha')
    await railSetup(CFG, db, RP, asha, RP.origins[0]!, T0)
    // the service runs with its bounty board off (QED_RAIL_BOUNTIES=0) or failed to deploy it: its own state and reason
    fake.bountyStatus = { state: 'off', reason: 'The bounty board is turned off on this vault service.' }
    const off = await bountiesView(CFG, db, asha) as Record<string, any>
    expect([off.originals.length, off.local.available, off.local.code, off.local.reason]).toEqual([2, false, 'bounties_off', 'The bounty board is turned off on this vault service.'])
    fake.bountyStatus = null
    // the vault service was given a new data folder since: it answers 404 for this household's vault
    fake.workspaces.delete(railWorkspaceId(asha.workspaceId))
    const lost = await bountiesView(CFG, db, asha) as Record<string, any>
    expect([lost.originals.length, lost.local.available, lost.local.code]).toEqual([2, false, 'unknown_workspace'])
  })
})

describe('GET /api/bounties over HTTP', () => {
  const PORT = 20000 + Math.floor(Math.random() * 20000)
  const dir = mkdtempSync(join(tmpdir(), 'qed-bounties-api-'))
  let api: ReturnType<typeof startApi>
  beforeAll(() => { api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) })) })
  afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }) })

  it('needs a session; a signed-in person without a vault gets the originals and the reason', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/api/bounties`)).status).toBe(401)
    let cookie = '', csrf = ''
    const ok = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as Record<string, any>
      if (typeof json.csrf === 'string') csrf = json.csrf
      if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
      return json
    }
    await signUp(ok, authenticatorFor(PORT), 'bounty-a', 'Bounty A')
    const v = await ok('GET', '/api/bounties')
    expect([v.originals.length, v.local.available, v.originals[0].status]).toEqual([2, false, expect.stringMatching(/^Last recorded 22:45:45 UTC, 19 Oct 2026/)])
  })
})
