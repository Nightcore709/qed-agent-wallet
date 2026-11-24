/**
 * A recording stand-in for the chain rail's HTTP contract (chain/README.md: "The multi-tenant HTTP contract" and
 * "Signers, recovery and earning"), for the wallet's tests of server/rail-signers.ts and server/earn-chain.ts. It
 * keeps workspaces, proposals, jobs, scheduled changes and escrow jobs in memory, answers in the rail's shapes and
 * records every request. It checks nothing cryptographic: the rail's own tests (chain/test/signers.test.ts,
 * chain/test/escrow-earn.test.ts) show what the chain accepts. Test code only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Json = Record<string, unknown>
export interface Seen { method: string; path: string; body: Json; key: string | undefined }
export interface FakeSigner { signerId: string; x: string; y: string; role: 'member' | 'recovery' | 'guardian'; frozen?: boolean }
/** `sentinel` (R13): false stands for an owner account built before R13, which nothing can freeze. */
/**
 * `options` false: an account built before R13's owner options (no guardian, no time-lock); `guardian` the guardian's key
 * (also listed in `signers` with role guardian, as the chain lists it); `timeLock` its state; `request` the body that
 * created the workspace (so a test can read what the wallet asked for, such as the time-lock chosen at set-up).
 */
export interface FakeWorkspace { id: string; ownerAccount: string; vault: string; signers: FakeSigner[]; threshold: number; adminThreshold: number; scheduled: Json[]; links: Set<string>; chain?: FakeChain; sentinel?: boolean; options?: boolean; timeLock?: boolean; request?: Json }
export interface FakeProposal { id: string; ws: string; kind: string; params: Json; terms: Json; used: boolean; jobId: string | null }
export interface FakeJob { id: string; ws: string; kind: string; status: string; result: Json | null; error?: string; guidance?: string }

const hex = (s: string, n = 64) => `0x${createHash('sha256').update(s).digest('hex').slice(0, n)}`
/** The rail's signer id is keccak256(abi.encode(x, y)); the fake only needs an id that is stable for a key. */
export const fakeSignerId = (x: string, y: string) => hex(`signer:${BigInt(x).toString(16)}:${BigInt(y).toString(16)}`)
/** The withdraw digest this fake gives for a recovery (R13 review fix F1), so that a test can compare the passkey prompt with it. */
export const fakeCancelDigest = (railWorkspace: string, recoveryId: string) => hex(`cancel:${railWorkspace}:${recoveryId}`)
const pad = (v: string) => `0x${BigInt(v).toString(16).padStart(64, '0')}`

export class FakeRail {
  readonly seen: Seen[] = []
  readonly workspaces = new Map<string, FakeWorkspace>()
  readonly proposals = new Map<string, FakeProposal>()
  readonly jobs = new Map<string, FakeJob>()
  /** Escrow jobs by number, with the workspaces that are parties to each. */
  readonly escrow = new Map<string, Json & { parties: string[] }>()
  /** How a job of a kind ends (default: executed, no evidence), and what it changes in the fake's state. */
  outcome: Record<string, (p: FakeProposal | null, ws: FakeWorkspace, body: Json) => Json> = {}
  /** Awaited before each request is answered (tests hold an answer back to interleave two of QED's operations). */
  before: ((method: string, path: string) => Promise<void>) | null = null
  /** A refusal the next proposal of a kind answers with, instead of a proposal. */
  refuse: Record<string, { status: number; code: string; message: string }> = {}
  /** The local bounty board's bounties, as GET /workspaces/:id/bounties lists them. */
  bounties: Json[] = [{ id: '1', key: 'optimality', role: 'original', phase: 'open', pool: '1000000000' }, { id: '2', key: 'maximality', role: 'original', phase: 'open', pool: '1000000000' }]
  /** Set: the board is not deployed ("off" with QED_RAIL_BOUNTIES=0, or "unavailable"), answered as the rail's board() does. */
  bountyStatus: { state: string; reason: string | null } | null = null
  /** R13 S5: GET /ownership and GET /claims of each workspace, as the test sets them (chain/test/ownership.test.ts shows the real ones). */
  ownership = new Map<string, Json>()
  claims = new Map<string, Json[]>()
  /** False: every route answers as if the service were not running (the socket closes). */
  up = true
  private server!: Server
  private token = randomBytes(24).toString('hex')
  private n = 0

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (!this.up) { res.destroy(); return }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = raw ? (JSON.parse(raw) as Json) : {}
        this.seen.push({ method: req.method ?? '', path: url.pathname + url.search, body, key: req.headers['idempotency-key'] as string | undefined })
        const go = (): void => { try { this.route(req.method ?? 'GET', url, body, req.headers['idempotency-key'] as string | undefined, res) } catch (e) { reply(res, 500, { error: { code: 'fake_error', message: String(e) } }) }
        }
        if (this.before) void this.before(req.method ?? 'GET', url.pathname).then(go, go)
        else go()
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    const dir = mkdtempSync(join(tmpdir(), 'qed-rail-fake-'))
    writeFileSync(join(dir, 'rail.token'), this.token, { mode: 0o600 })
    process.env.QED_RAIL_URL = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    process.env.QED_RAIL_TOKEN_FILE = join(dir, 'rail.token')
  }
  async stop(): Promise<void> {
    delete process.env.QED_RAIL_URL
    delete process.env.QED_RAIL_TOKEN_FILE
    await new Promise<void>((r) => this.server.close(() => r()))
  }
  reset(): void {
    this.seen.length = 0; this.workspaces.clear(); this.proposals.clear(); this.jobs.clear(); this.escrow.clear(); this.outcome = {}; this.refuse = {}; this.up = true; this.bountyStatus = null; this.before = null
    this.ownership.clear(); this.claims.clear()
  }
  /** A ready workspace whose wallet is on a fake chain (FakeChain): its /state and /movements answer from that chain. */
  addChain(id: string, startSec: number, pair?: FakePair): FakeChain {
    const chain = new FakeChain(id, startSec, pair)
    this.workspaces.set(id, { id, ownerAccount: chain.holders['owner-account'], vault: chain.holders.treasury, signers: [], threshold: 1, adminThreshold: 1, scheduled: [], links: new Set(), chain })
    return chain
  }
  /** Requests of one kind of proposal, in order. */
  proposed(kind: string): FakeProposal[] { return [...this.proposals.values()].filter((p) => p.kind === kind) }
  sent(pathEnd: string): Seen[] { return this.seen.filter((s) => s.method === 'POST' && s.path.endsWith(pathEnd)) }

  private job(ws: string, kind: string, result: Json | null, status = 'done'): FakeJob {
    const id = `job-${++this.n}-${randomBytes(4).toString('hex')}`
    const j: FakeJob = { id, ws, kind, status, result }
    this.jobs.set(id, j)
    return j
  }
  private view(w: FakeWorkspace): Json {
    return { id: w.id, status: 'ready', ownerKind: 'passkey-account', ownerAccount: w.ownerAccount, signers: w.signers.map((s) => ({ ...s })), threshold: w.threshold, adminThreshold: w.adminThreshold, contracts: { ownerAccount: w.ownerAccount, vault: w.vault }, asset: w.chain ? { symbol: w.chain.assetSym, decimals: w.chain.tokens[w.chain.assetSym]!.decimals } : { symbol: 'tINR', decimals: 2 }, reserveAsset: w.chain ? { symbol: w.chain.reserveSym, decimals: w.chain.tokens[w.chain.reserveSym]!.decimals } : { symbol: 'tUSD', decimals: 6 }, grant: null }
  }

  private route(method: string, url: URL, body: Json, key: string | undefined, res: ServerResponse): void {
    const path = url.pathname
    if (path === '/health') return reply(res, 200, { ready: true, mode: 'multi-tenant', workspaces: this.workspaces.size })
    if (method === 'POST' && path === '/workspaces') {
      const id = String(body.workspaceId)
      const was = this.workspaces.get(id)
      if (was) return reply(res, 200, { ...this.view(was), duplicate: true })
      const owner = body.owner as { signers?: { x: string; y: string }[]; threshold?: number; adminThreshold?: number; x?: string; y?: string }
      const members = owner.signers ?? [{ x: owner.x!, y: owner.y! }]
      const w: FakeWorkspace = { id, ownerAccount: `0x${hex(`acct:${id}`, 40).slice(2)}`, vault: `0x${hex(`vault:${id}`, 40).slice(2)}`, signers: members.map((k) => ({ signerId: fakeSignerId(k.x, k.y), x: pad(k.x), y: pad(k.y), role: 'member' })), threshold: owner.threshold ?? 1, adminThreshold: owner.adminThreshold ?? owner.threshold ?? 1, scheduled: [], links: new Set(), timeLock: body.timeLock === true, request: body }
      this.workspaces.set(id, w)
      return reply(res, 201, { ...this.view(w), status: 'awaiting-acceptance', duplicate: false })
    }
    const m = /^\/workspaces\/([a-z0-9-]+)(\/.*)?$/.exec(path)
    if (!m) return reply(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
    const w = this.workspaces.get(m[1]!)
    if (!w) return reply(res, 404, { error: { code: 'unknown_workspace', message: 'Unknown workspace.' } })
    const rest = m[2] ?? ''
    if (method === 'GET' && rest === '') return reply(res, 200, this.view(w))
    if (method === 'GET' && rest === '/state') return reply(res, 200, w.chain ? w.chain.state() : { provisioned: true, policy: null })
    if (method === 'GET' && rest === '/movements') {
      if (!w.chain) return reply(res, 422, { error: { code: 'unsupported_read', message: 'No chain in this fake workspace.' } })
      const q = url.searchParams
      if ([q.get('fromBlock'), q.get('toBlock'), ...(q.get('blocks') ?? '').split(',').filter(Boolean)].some((v) => v !== null && v !== '' && !/^\d{1,12}$/.test(v))) return reply(res, 422, { error: { code: 'invalid_query', message: 'A block number.' } })
      return reply(res, 200, w.chain.movements(q))
    }
    if (method === 'GET' && rest === '/scheduled') return reply(res, 200, { scheduled: w.scheduled })
    if (method === 'GET' && rest === '/ownership') return reply(res, 200, this.ownership.get(w.id) ?? { delaySeconds: 259_200, mine: [{ vault: w.vault, which: 'treasury', owner: w.ownerAccount, pendingOwner: null, pendingWorkspace: null, ownedByThisAccount: true, ownerWorkspace: w.id }], offeredToMe: [], ownedHere: [] })
    if (method === 'GET' && rest === '/claims') return reply(res, 200, { claims: this.claims.get(w.id) ?? [] })
    // R13 E3: a timeout of the dispute escrow, applied by the rail's relayer (outcome['escrow-finish'])
    const dfm = /^\/disputes\/(\d+)\/finish$/.exec(rest)
    if (method === 'POST' && dfm) {
      if (!key) return reply(res, 400, { error: { code: 'idempotency_key_required', message: 'Every state-changing request needs an Idempotency-Key.' } })
      const job = this.job(w.id, 'escrow-finish', (this.outcome['escrow-finish'] ?? (() => ({ outcome: 'executed', summary: 'Applied the timeout.', evidence: { disputeJobId: dfm[1] } })))(null, w, body))
      return reply(res, 202, { jobId: job.id, kind: 'escrow-finish', status: 'accepted', duplicate: false })
    }
    if (method === 'GET' && rest === '/signers') {
      const g = w.signers.find((s) => s.role === 'guardian') ?? null, opts = w.options !== false
      return reply(res, 200, { guardian: { supported: opts, signerId: g?.signerId ?? null, x: g?.x ?? null, y: g?.y ?? null }, timeLock: { supported: opts, on: opts && w.timeLock === true, calls: [] }, account: w.ownerAccount, containment: { sentinel: w.sentinel === false ? null : `0x${'5e'.repeat(20)}`, byThisService: w.sentinel !== false, protect: w.sentinel !== false }, signers: w.signers.map((s) => ({ ...s, frozen: s.frozen === true, serial: '1', pendingRemoval: (w.scheduled.find((c) => c.kind === 'remove-signers' && c.status === 'pending' && (c.targets as FakeSigner[]).some((t) => t.signerId === s.signerId))?.changeId as string) ?? null, pendingRecovery: null })), threshold: w.threshold, adminThreshold: w.adminThreshold, memberCount: w.signers.filter((s) => s.role === 'member').length, delaySeconds: 259_200, recoveryDelaySeconds: 259_200, pending: w.scheduled.filter((c) => c.status === 'pending'), everSigners: w.signers.map((s) => s.signerId), rules: [] })
    }
    if (method === 'POST' && rest === '/proposals') {
      const kind = String(body.kind), params = (body.params ?? {}) as Json
      const r = this.refuse[kind]
      if (r) { delete this.refuse[kind]; return reply(res, r.status, { error: { code: r.code, message: r.message } }) }
      const id = `prop-${++this.n}-${randomBytes(4).toString('hex')}`
      const self = ['add-signer', 'remove-signers', 'set-thresholds', 'set-guardian', 'set-time-lock'].includes(kind)
      const item = kind === 'cancel-change' ? { kind: 'cancel', digest: hex(`d:${id}`), threshold: 1 } : kind === 'escrow-quote' ? { kind: 'erc1271', purpose: 'quote', digest: hex(`d:${id}`), threshold: w.threshold } : { kind: 'execute', digest: hex(`d:${id}`), threshold: self ? w.adminThreshold : w.threshold, calls: [] }
      const change = kind === 'cancel-change' ? w.scheduled.find((c) => c.changeId === params.changeId) : undefined
      const terms: Json = { kind, ...params, ...(change ? { change: { kind: change.kind, summary: change.summary, ...(change.kind === 'remove-signers' ? { targets: (change.targets as FakeSigner[]).map((t) => ({ signerId: t.signerId, x: t.x, y: t.y })) } : {}) } } : {}), toSign: [item] }
      const p: FakeProposal = { id, ws: w.id, kind, params, terms, used: false, jobId: null }
      this.proposals.set(id, p)
      return reply(res, 201, { id, kind, status: 'open', summary: `A ${kind} proposal.`, terms, termsHash: `sha256:${hex(`t:${id}`).slice(2)}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), network: 'local' })
    }
    let pm = /^\/proposals\/([^/]+)$/.exec(rest)
    if (method === 'GET' && pm) {
      const p = this.proposals.get(pm[1]!)
      if (!p || p.ws !== w.id) return reply(res, 404, { error: { code: 'unknown_proposal', message: 'Unknown proposal.' } })
      return reply(res, 200, { id: p.id, kind: p.kind, status: p.used ? 'used' : 'open', terms: p.terms, ...(p.jobId ? { jobId: p.jobId } : {}) })
    }
    pm = /^\/proposals\/([^/]+)\/execute$/.exec(rest)
    if (method === 'POST' && pm) {
      const p = this.proposals.get(pm[1]!)
      if (!p || p.ws !== w.id) return reply(res, 404, { error: { code: 'unknown_proposal', message: 'Unknown proposal.' } })
      if (p.used) { const j = this.jobs.get(p.jobId!)!; return reply(res, 202, { jobId: j.id, kind: p.kind, status: j.status, duplicate: true }) }
      const result = (this.outcome[p.kind] ?? (() => ({ outcome: 'executed', summary: `${p.kind} done.`, evidence: {} })))(p, w, body)
      const j = this.job(w.id, p.kind, result)
      p.used = true; p.jobId = j.id
      return reply(res, 202, { jobId: j.id, kind: p.kind, status: 'accepted', duplicate: false })
    }
    const jm = /^\/jobs\/([^/]+)$/.exec(rest)
    if (method === 'GET' && jm) {
      const j = this.jobs.get(jm[1]!)
      if (!j || j.ws !== w.id) return reply(res, 404, { error: { code: 'unknown_job', message: 'Unknown job.' } })
      return reply(res, 200, { id: j.id, kind: j.kind, status: j.status, result: j.result, error: j.error ?? null, guidance: j.guidance })
    }
    if (method === 'GET' && rest === '/recovery/digest') {
      const q = url.searchParams
      const rid = q.get('recoverySignerId') ?? ''
      if (!w.signers.some((s) => s.signerId === rid && s.role === 'recovery')) return reply(res, 409, { error: { code: 'not_a_recovery_key', message: 'That key is not a recovery key of this vault\'s owner account. Nothing was prepared.' } })
      const g = w.signers.find((s) => s.role === 'guardian')
      return reply(res, 200, { account: w.ownerAccount, chainId: 31337, recoverySignerId: rid, newKey: { x: q.get('x'), y: q.get('y') }, newSignerId: fakeSignerId(q.get('x')!, q.get('y')!), deadline: q.get('deadline'), digest: hex(`recovery:${w.id}:${rid}:${q.get('x')}:${q.get('y')}:${q.get('deadline')}`), recoveryDelaySeconds: 259_200, guardian: g ? { signerId: g.signerId, x: g.x, y: g.y } : null, note: 'The recovery key signs these 32 bytes.' })
    }
    // R13: the sentinel's freeze, as chain/test/containment.test.ts shows it for real: a member only; again is no-action
    if (method === 'POST' && rest === '/signers/freeze') {
      if (w.sentinel === false) return reply(res, 409, { error: { code: 'no_sentinel', message: 'This workspace\'s owner account was built before R13: it has no sentinel.' } })
      const prior = this.seen.filter((s) => s.key === key && s.path.endsWith('/signers/freeze'))
      if (prior.length > 1) { const j = [...this.jobs.values()].find((x) => x.kind === 'freeze-signer' && x.ws === w.id)!; return reply(res, 202, { jobId: j.id, kind: 'freeze-signer', status: j.status, duplicate: true }) }
      const s = w.signers.find((x) => x.signerId === String(body.signerId).toLowerCase() && x.role === 'member')
      const result = !s ? { outcome: 'refused', summary: 'That key is not a member of the owner account.' } : s.frozen ? { outcome: 'no-action', summary: 'Already frozen.', evidence: { signerId: s.signerId, frozen: true } } : (s.frozen = true, { outcome: 'executed', summary: 'Froze the member on the chain at once.', evidence: { signerId: s.signerId, frozen: true } })
      const j = this.job(w.id, 'freeze-signer', result)
      return reply(res, 202, { jobId: j.id, kind: 'freeze-signer', status: 'accepted', duplicate: false })
    }
    if (method === 'POST' && rest === '/recoveries') {
      const prior = this.seen.filter((s) => s.key === key && s.path.endsWith('/recoveries'))
      if (prior.length > 1) { const j = [...this.jobs.values()].find((x) => x.kind === 'start-recovery' && x.ws === w.id)!; return reply(res, 202, { jobId: j.id, kind: 'start-recovery', status: j.status, duplicate: true }) }
      // R13: with a guardian the rail refuses a recovery without its co-signature (chain/test/owner-options.test.ts)
      const g = w.signers.find((s) => s.role === 'guardian')
      const cosign = body.cosign as { publicKey?: { x?: string } } | undefined
      const result = g && (!cosign || pad(String(cosign.publicKey?.x ?? '0x0')) !== g.x) ? { outcome: 'refused', summary: 'This account has a guardian: the recovery starts only with the guardian\'s co-signature. Nothing was sent.' }
        : (this.outcome['start-recovery'] ?? (() => ({ outcome: 'scheduled', summary: 'Recovery started.', evidence: { recoveryId: hex(`rec:${key}`), readyAt: Math.floor(Date.now() / 1000) + 259_200, ...(g ? { cosignedBy: g.signerId } : {}) } })))(null, w, body)
      const j = this.job(w.id, 'start-recovery', result)
      return reply(res, 202, { jobId: j.id, kind: 'start-recovery', status: 'accepted', duplicate: false })
    }
    // R13 review fix F1: the guardian withdraws its co-signature, as chain/test/owner-options.test.ts shows it for real:
    // only a recovery started co-signed and not yet withdrawn; only the guardian's own passkey
    // R13 H1: the sentinel stops a pending co-signed recovery, as chain/test/owner-options.test.ts shows it for real
    const sm = /^\/recoveries\/(0x[0-9a-f]{64})\/stop$/.exec(rest)
    if (method === 'POST' && sm) {
      const started = [...this.jobs.values()].find((x) => x.kind === 'start-recovery' && x.ws === w.id && (x.result as { evidence?: { recoveryId?: string } } | null)?.evidence?.recoveryId === sm[1])
      const cosigned = !!(started?.result as { evidence?: { cosignedBy?: string } } | null)?.evidence?.cosignedBy
      const ended = [...this.jobs.values()].some((x) => (x.kind === 'guardian-withdraw' || x.kind === 'sentinel-stop') && x.ws === w.id && (x.result as { outcome?: string; evidence?: { recoveryId?: string } } | null)?.outcome === 'executed' && (x.result as { evidence?: { recoveryId?: string } }).evidence?.recoveryId === sm[1])
      const result = !started || ended ? { outcome: 'refused', summary: 'The owner account holds no such pending recovery (it finished or was cancelled). Nothing was sent.' }
        : !cosigned ? { outcome: 'refused', summary: 'The guardian did not co-sign this recovery: any member can cancel it. Nothing was sent.' }
          : { outcome: 'executed', summary: 'QED stopped the recovery with this wallet\'s sentinel key.', evidence: { recoveryId: sm[1], stoppedBy: '0x5e' } }
      const j = this.job(w.id, 'sentinel-stop', result)
      return reply(res, 202, { jobId: j.id, kind: 'sentinel-stop', status: 'accepted', duplicate: false })
    }
    const wm = /^\/recoveries\/(0x[0-9a-f]{64})\/(withdraw-digest|withdraw)$/.exec(rest)
    if (wm) {
      const started = [...this.jobs.values()].find((x) => x.kind === 'start-recovery' && x.ws === w.id && (x.result as { evidence?: { recoveryId?: string } } | null)?.evidence?.recoveryId === wm[1])
      const ev = (started?.result as { evidence?: { cosignedBy?: string } } | null)?.evidence
      const withdrawn = [...this.jobs.values()].some((x) => x.kind === 'guardian-withdraw' && x.ws === w.id && (x.result as { outcome?: string; evidence?: { recoveryId?: string } } | null)?.evidence?.recoveryId === wm[1])
      if (!started || withdrawn) return reply(res, 409, { error: { code: 'change_not_pending', message: 'The owner account holds no such pending recovery (it finished or was cancelled).' } })
      if (!ev?.cosignedBy) return reply(res, 409, { error: { code: 'not_cosigned', message: 'The guardian did not co-sign this recovery, so it cannot withdraw it; any member can cancel it.' } })
      if (method === 'GET' && wm[2] === 'withdraw-digest') return reply(res, 200, { account: w.ownerAccount, chainId: 31337, recoveryId: wm[1], digest: fakeCancelDigest(w.id, wm[1]!), guardian: ev.cosignedBy, note: 'The guardian\'s passkey signs these 32 bytes.' })
      if (method === 'POST' && wm[2] === 'withdraw') {
        const g = w.signers.find((s) => s.role === 'guardian')
        const a = body.assertion as { publicKey?: { x?: string } } | undefined
        const result = !g || pad(String(a?.publicKey?.x ?? '0x0')) !== g.x ? { outcome: 'refused', summary: 'That assertion was made by a passkey that is not this account\'s guardian. Nothing was sent.' }
          : { outcome: 'executed', summary: 'The guardian withdrew its co-signature.', evidence: { recoveryId: wm[1], withdrawnBy: g.signerId } }
        const j = this.job(w.id, 'guardian-withdraw', result)
        return reply(res, 202, { jobId: j.id, kind: 'guardian-withdraw', status: 'accepted', duplicate: false })
      }
    }
    if (method === 'POST' && rest === '/links') {
      const ids = (body.workspaces as string[] | undefined) ?? []
      const added: string[] = [], unknown: string[] = []
      for (const o of ids) {
        const other = this.workspaces.get(o)
        if (!other) { unknown.push(o); continue }
        if (!w.links.has(o)) { w.links.add(o); other.links.add(w.id); added.push(o) }
      }
      return reply(res, 200, { linked: [...w.links].sort(), added, unknown })
    }
    if (method === 'GET' && rest === '/escrow/jobs') {
      const qh = url.searchParams.get('quoteHash')
      return reply(res, 200, { jobs: [...this.escrow.values()].filter((j) => j.parties.includes(w.id) && (!qh || j.quoteHash === qh)).map(({ parties: _p, ...j }) => j) })
    }
    const em = /^\/escrow\/jobs\/([^/]+)(\/refund)?$/.exec(rest)
    if (em) {
      const j = this.escrow.get(em[1]!)
      if (!j || !j.parties.includes(w.id)) return reply(res, 404, { error: { code: 'unknown_escrow_job', message: 'This workspace is not a party to that escrow job.' } })
      if (method === 'GET' && !em[2]) { const { parties: _p, ...out } = j; return reply(res, 200, out) }
      if (method === 'POST' && em[2]) {
        const result = (this.outcome['escrow-refund'] ?? (() => ({ outcome: 'executed', summary: 'Refunded.', evidence: { escrowJobId: em[1] } })))(null, w, body)
        const job = this.job(w.id, 'escrow-refund', result)
        return reply(res, 202, { jobId: job.id, kind: 'escrow-refund', status: 'accepted', duplicate: false })
      }
    }
    // the refutation bounties (chain/README.md, "Refutation bounties"): a canned board; claims, reveals and settlements
    // are jobs that finish at once (outcome['bounty-commit'], …); chain/test/bounties.test.ts shows the real ones
    if (method === 'GET' && rest === '/bounties' && this.bountyStatus) return reply(res, 200, { status: this.bountyStatus.state, reason: this.bountyStatus.reason, board: null, bounties: [], claimant: null, claims: [] })
    if (method === 'GET' && rest === '/bounties') return reply(res, 200, { status: 'ready', board: `0x${hex('board', 40).slice(2)}`, chainId: 31337, token: `0x${hex('tusd', 40).slice(2)}`, bounties: this.bounties, claimant: `0x${hex(`claimant:${w.id}`, 40).slice(2)}`, recipients: { reserve: `0x${hex(`reserve:${w.id}`, 40).slice(2)}`, ownerAccount: w.ownerAccount }, claims: [] })
    const bm = /^\/bounties\/(?:(\d+)\/(check|claims|settle)|claims\/(0x[0-9a-f]{64})\/reveal)$/.exec(rest)
    if (method === 'POST' && bm) {
      const r = this.refuse.bounty
      if (r) { delete this.refuse.bounty; return reply(res, r.status, { error: { code: r.code, message: r.message } }) }
      if (bm[2] === 'check') return reply(res, 200, { bountyId: bm[1], valid: false, error: { name: 'TheoremHolds', args: ['-1', '1'], words: 'The theorem holds for this claim.' } })
      if (!key) return reply(res, 400, { error: { code: 'idempotency_key_required', message: 'Every state-changing request needs an Idempotency-Key.' } })
      const kind = bm[2] === 'claims' ? 'bounty-commit' : bm[2] === 'settle' ? 'bounty-settle' : 'bounty-reveal'
      const job = this.job(w.id, kind, (this.outcome[kind] ?? (() => ({ outcome: 'executed', summary: `${kind}: done.`, evidence: {} })))(null, w, body))
      return reply(res, 202, { jobId: job.id, kind, status: 'accepted', duplicate: false })
    }
    return reply(res, 404, { error: { code: 'not_found', message: 'No such route.' } })
  }
}

function reply(res: ServerResponse, status: number, json: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)) }

// ------------------------------------------------------------------------------------------------ a wallet's chain

type Role = 'treasury' | 'reserve' | 'owner-account'
type Sym = string
/** A fake wallet's two tokens: the treasury's and the reserve's, each with its decimals. */
export interface FakePair { asset: { symbol: string; decimals: number }; reserve: { symbol: string; decimals: number } }
const DEFAULT_PAIR: FakePair = { asset: { symbol: 'tINR', decimals: 2 }, reserve: { symbol: 'tUSD', decimals: 6 } }
/** One movement as GET /workspaces/:id/movements lists it (chain/rail/movements.ts MovementView). */
export interface FakeMove {
  txHash: string; logIndex: number; blockNumber: string; blockHash: string; blockTimestamp: number; confirmations?: number
  kind: 'transfer' | 'escrow-settled'; token: string; symbol: string; decimals: number; amount: string
  from: string; to: string; fromRole: Role | null; toRole: Role | null
  counterparty: { address: string; kind: string; label: string | null }
  jobId: string | null; escrow: Json | null; conversion: Json | null
}
/** A log before it is mined: what a transaction does. */
export type FakeLog = Omit<FakeMove, 'txHash' | 'logIndex' | 'blockNumber' | 'blockHash' | 'blockTimestamp' | 'confirmations' | 'jobId'>
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`
const fakeAddress = (s: string) => `0x${createHash('sha256').update(s).digest('hex').slice(0, 40)}`

/**
 * A wallet's chain as the rail reads it: blocks with their hashes and times, and the movements of the wallet's three holders
 * in its two tokens (chain/rail/movements.ts). /state's balances are computed from the movements, so they agree with the
 * books unless `stateOffset` makes them disagree. Blocks can be replaced from a height on (a reorganisation, or a chain
 * restored from an older state) and the genesis changed (a new data folder). Test code only.
 */
export class FakeChain {
  genesisId: string
  readonly tokens: Record<Sym, { symbol: Sym; address: string; decimals: number }>
  /** The treasury's token and the reserve's (tINR and tUSD unless another pair is given: money-model S5). */
  readonly assetSym: Sym
  readonly reserveSym: Sym
  readonly holders: Record<Role, string>
  readonly exec: string
  readonly escrow: string
  readonly payee: string
  blocks: { number: number; hash: string; timestamp: number }[]
  /** Added to the balance /state reports for a token (in its treasury or reserve vault): the chain then disagrees with the books. */
  stateOffset: Partial<Record<Sym, bigint>> = {}
  private moves: (FakeMove & { block: number })[] = []
  private fork = 0
  private n = 0
  private time: number
  readonly seed: string
  constructor(seed: string, startSec: number, pair: FakePair = DEFAULT_PAIR) {
    this.seed = seed
    this.genesisId = `genesis-${seed}`
    this.time = startSec
    this.assetSym = pair.asset.symbol
    this.reserveSym = pair.reserve.symbol
    this.tokens = { [pair.asset.symbol]: { symbol: pair.asset.symbol, address: fakeAddress(`token:${pair.asset.symbol}`), decimals: pair.asset.decimals }, [pair.reserve.symbol]: { symbol: pair.reserve.symbol, address: fakeAddress(`token:${pair.reserve.symbol}`), decimals: pair.reserve.decimals } }
    this.holders = { treasury: fakeAddress(`vault:${seed}`), reserve: fakeAddress(`reserve:${seed}`), 'owner-account': fakeAddress(`acct:${seed}`) }
    this.exec = fakeAddress(`exec:${seed}`)
    this.escrow = fakeAddress('escrow')
    this.payee = fakeAddress('cloudco')
    this.blocks = [{ number: 0, hash: hex(`${seed}:block:0`), timestamp: startSec }]
  }
  get head(): { number: number; hash: string; timestamp: number } { return this.blocks[this.blocks.length - 1]! }
  private block(): { number: number; hash: string; timestamp: number } {
    this.time += 12
    const b = { number: this.head.number + 1, hash: hex(`${this.seed}:block:${this.head.number + 1}:fork:${this.fork}`), timestamp: this.time }
    this.blocks.push(b)
    return b
  }
  /** Empty blocks, so that what came before gains confirmations. */
  mine(n = 1): void { for (let i = 0; i < n; i++) this.block() }
  /** One transaction in a block of its own; returns its hash. */
  tx(logs: FakeLog[], opts: { jobId?: string | null } = {}): string {
    const b = this.block()
    const txHash = hex(`${this.seed}:tx:${++this.n}`)
    logs.forEach((l, i) => this.moves.push({ ...l, txHash, logIndex: i, blockNumber: String(b.number), blockHash: b.hash, blockTimestamp: b.timestamp, jobId: opts.jobId ?? null, block: b.number }))
    return txHash
  }
  /** The chain from `fromBlock` on is replaced: those blocks and their movements are gone; `again` lists transactions mined again, together in the first new block. */
  reorg(fromBlock: number, again: string[] = []): void {
    const dropped = this.moves.filter((m) => m.block >= fromBlock)
    this.moves = this.moves.filter((m) => m.block < fromBlock)
    this.blocks = this.blocks.filter((b) => b.number < fromBlock)
    this.time = this.head.timestamp
    this.fork++
    if (!again.length) return
    const b = this.block()
    let i = 0
    for (const m of dropped.filter((x) => again.includes(x.txHash))) this.moves.push({ ...m, logIndex: i++, blockNumber: String(b.number), blockHash: b.hash, blockTimestamp: b.timestamp, block: b.number })
  }

  // what a transaction can do, as its logs
  private t(sym: Sym, amount: bigint, from: string, to: string, cp: { address: string; kind: string; label: string | null }, more: Partial<FakeLog> = {}): FakeLog {
    const role = (a: string) => (Object.entries(this.holders).find(([, x]) => x === a)?.[0] as Role | undefined) ?? null
    return { kind: 'transfer', token: this.tokens[sym]!.address, symbol: sym, decimals: this.tokens[sym]!.decimals, amount: amount.toString(), from, to, fromRole: role(from), toRole: role(to), counterparty: cp, escrow: null, conversion: null, ...more }
  }
  grant(to: Role, amount: bigint): FakeLog { return this.t(this.assetSym, amount, ZERO_ADDRESS, this.holders[to], { address: ZERO_ADDRESS, kind: 'faucet', label: 'The local chain\'s faucet' }) }
  pay(amount: bigint, label = 'CloudCo'): FakeLog { return this.t(this.assetSym, amount, this.holders.treasury, this.payee, { address: this.payee, kind: 'payee', label }) }
  own(from: Role, to: Role, amount: bigint, sym: Sym = this.assetSym): FakeLog { return this.t(sym, amount, this.holders[from], this.holders[to], { address: this.holders[to], kind: 'own', label: null }) }
  receive(amount: bigint, sym: Sym = this.assetSym, to: Role = 'treasury'): FakeLog { const a = fakeAddress('outside'); return this.t(sym, amount, a, this.holders[to], { address: a, kind: 'outside', label: null }) }
  escrowFund(amount: bigint, jobId: string): FakeLog { return this.t(this.assetSym, amount, this.holders['owner-account'], this.escrow, { address: this.escrow, kind: 'escrow', label: 'ProofEscrow' }, { escrow: { jobId, event: 'opened', role: 'client' } }) }
  escrowEarning(amount: bigint, jobId: string): FakeLog { return this.t(this.assetSym, amount, this.escrow, this.holders.treasury, { address: this.escrow, kind: 'escrow', label: 'ProofEscrow' }, { escrow: { jobId, event: 'settled', role: 'provider' } }) }
  escrowRefund(amount: bigint, jobId: string): FakeLog { return this.t(this.assetSym, amount, this.escrow, this.holders['owner-account'], { address: this.escrow, kind: 'escrow', label: 'ProofEscrow' }, { escrow: { jobId, event: 'refunded', role: 'client' } }) }
  /** The escrow paid the provider of work this wallet commissioned: nothing of the wallet's moves. */
  escrowSettledForClient(amount: bigint, jobId: string): FakeLog {
    const provider = fakeAddress('provider-vault')
    return { ...this.t(this.assetSym, amount, this.escrow, provider, { address: provider, kind: 'workspace', label: null }), kind: 'escrow-settled', escrow: { jobId, event: 'settled', role: 'client' } }
  }
  /**
   * A conversion of tINR into tUSD through one constant-product pool, as QEDExecution makes it: the treasury pays the
   * execution module `amountIn`, the module swaps what it spends (the pool's output by its own formula) and returns the rest.
   * `hops: false` leaves the pool's records out (as for a route the rail cannot read).
   */
  convert(o: { amountIn: bigint; rest?: bigint; feeBps?: number; rIn: bigint; rOut: bigint; hops?: boolean }): FakeLog[] {
    const rest = o.rest ?? 0n, spent = o.amountIn - rest, f = BigInt(o.feeBps ?? 30)
    const inWithFee = spent * (10_000n - f)
    const out = (inWithFee * o.rOut) / (o.rIn * 10_000n + inWithFee)
    const pool = fakeAddress('pool:tINR/tUSD')
    const hops = o.hops === false ? [] : [{ pool, label: 'Rupee-dollar pool', feeBps: Number(f), tokenIn: this.tokens[this.assetSym]!.address, tokenOut: this.tokens[this.reserveSym]!.address, amountIn: spent.toString(), amountOut: out.toString(), reserveInBefore: o.rIn.toString(), reserveOutBefore: o.rOut.toString() }]
    const conversion = { hops, amountIn: o.amountIn.toString(), spent: spent.toString(), amountOut: out.toString(), tokenOut: this.tokens[this.reserveSym]!.address }
    const cp = { address: this.exec, kind: 'conversion', label: 'QEDExecution' }
    return [
      this.t(this.assetSym, o.amountIn, this.holders.treasury, this.exec, cp, { conversion }),
      ...(rest > 0n ? [this.t(this.assetSym, rest, this.exec, this.holders.treasury, cp, { conversion })] : []),
      this.t(this.reserveSym, out, this.exec, this.holders.reserve, cp, { conversion }),
    ]
  }

  /** A holder's balance of a token, from the movements on the chain now. */
  balance(sym: Sym, role: Role): bigint {
    let b = 0n
    for (const m of this.moves) {
      if (m.kind !== 'transfer' || m.symbol !== sym) continue
      if (m.toRole === role) b += BigInt(m.amount)
      if (m.fromRole === role) b -= BigInt(m.amount)
    }
    return b
  }
  /** GET /workspaces/:id/state, as far as the wallet's books read it. */
  state(): Json {
    const off = (s: Sym) => this.stateOffset[s] ?? 0n, A = this.assetSym, R = this.reserveSym
    return {
      status: 'ready', provisioned: true, policy: null, genesisId: this.genesisId,
      network: { chainId: 31337, name: 'Local Anvil chain 31337 · valueless test tokens (fake)', block: String(this.head.number), timestamp: this.head.timestamp, valueless: true },
      contracts: { asset: this.tokens[this.assetSym]!.address, reserveAsset: this.tokens[this.reserveSym]!.address, vault: this.holders.treasury, reserve: this.holders.reserve, ownerAccount: this.holders['owner-account'] },
      treasury: { token: A, decimals: this.tokens[A]!.decimals, balance: (this.balance(A, 'treasury') + off(A)).toString(), ringFenced: '0', free: '0', paused: false },
      reserve: { token: R, decimals: this.tokens[R]!.decimals, balance: (this.balance(R, 'reserve') + off(R)).toString(), ringFenced: '0', free: '0', paused: false },
      ownerHolds: { asset: this.balance(A, 'owner-account').toString(), reserveAsset: this.balance(R, 'owner-account').toString() },
    }
  }
  /** GET /workspaces/:id/movements. */
  movements(q: URLSearchParams): Json {
    const head = this.head.number
    const from = q.get('fromBlock') ? Number(q.get('fromBlock')) : 0
    const to = Math.min(q.get('toBlock') ? Number(q.get('toBlock')) : head, head)
    const list = this.moves.filter((m) => m.block >= from && m.block <= to).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
      .map(({ block, ...m }) => ({ ...m, confirmations: head - block + 1 }))
    const canonical: Record<string, string | null> = {}
    for (const s of (q.get('blocks') ?? '').split(',').filter(Boolean)) canonical[s] = this.blocks.find((b) => b.number === Number(s))?.hash ?? null
    return {
      network: 'eip155:31337', chainId: 31337, genesisId: this.genesisId,
      head: { number: String(head), hash: this.head.hash, timestamp: this.head.timestamp },
      range: { from: String(from), to: String(from > to ? from - 1 : to), complete: true },
      finality: { kind: 'confirmations', depth: 2, source: 'fake' },
      holders: (Object.keys(this.holders) as Role[]).map((role) => ({ role, address: this.holders[role] })),
      tokens: Object.values(this.tokens), movements: list, canonical,
    }
  }
}
