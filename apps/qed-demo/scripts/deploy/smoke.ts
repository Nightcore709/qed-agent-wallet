/**
 * The deployment smoke test, against a RUNNING stack (scripts/deploy/supervise.ts; docs/DEPLOY.md, "Rehearsal"): the
 * probes, then one owner signed up with a passkey made by the software authenticator the security suite uses
 * (server/softauthn.ts), a paper household, a payee, and a paper payment approved with that passkey and carried out by
 * the engine; then the on-chain wallet (R14): created with that passkey as its owner, accepted (the opening grant of test
 * tokens arrives), a mandate signed, a payment made on the chain, each followed to its finished job. Local rehearsals
 * only: on a real deployment the first owner signs up in a browser with a real passkey.
 *
 * The wallet part exists because no rehearsal ran it before 25 Nov 2026: on the deployed image the co-signer, running as
 * its own user, could not be configured for a new wallet, so every set-up failed in production while this script passed.
 * Run it against the IMAGE (a container started as production starts it), not only against a checkout.
 *
 *   node scripts/deploy/smoke.ts --base http://127.0.0.1:10200 --origin http://qed.localhost:10200 [--payee <handle>]
 *        [--amount <paise>] [--no-wait] [--no-wallet] [--out <report.json>]
 *
 * --no-wallet leaves the on-chain wallet out (a stack started with QED_WALLET=off; with --no-wait it is left out too).
 * --origin is the public origin the stack was started with (its host is sent as Host); --payee slow@paper leaves the
 * payment pending for 90 s (the restart rehearsal); --no-wait returns once the engine has it. Prints and writes a report
 * with ids, states and timings only: no cookie, token, key or recovery code.
 */
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { parseArgs } from 'node:util'
import { SoftAuthenticator } from '../../server/softauthn.ts'

const { values: v } = parseArgs({ options: { base: { type: 'string' }, origin: { type: 'string' }, payee: { type: 'string' }, amount: { type: 'string' }, 'no-wait': { type: 'boolean' }, 'no-wallet': { type: 'boolean' }, out: { type: 'string' }, handle: { type: 'string' } } })
if (!v.base || !v.origin) { console.error('Usage: node scripts/deploy/smoke.ts --base <http://127.0.0.1:port> --origin <public origin> [--payee h] [--amount paise] [--no-wait] [--out f]'); process.exit(2) }
const base = new URL(v.base), origin = v.origin.replace(/\/$/, ''), hostHeader = new URL(origin).host
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = performance.now()
const at = (): number => Math.round(performance.now() - t0)

interface Res { status: number; json: Record<string, any>; cookie: string | null }
let cookie = '', csrf = ''
function call(method: string, path: string, body?: unknown, host = hostHeader): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { host, origin, 'x-qed-client': 'web' }
    if (cookie) headers.cookie = cookie
    if (csrf) headers['x-qed-csrf'] = csrf
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)) }
    const r = request({ host: base.hostname, port: Number(base.port), method, path, headers, agent: false }, (res) => {
      let t = ''
      res.on('data', (c: Buffer) => { t += c.toString() })
      res.on('end', () => { let json: Record<string, any> = {}; try { json = JSON.parse(t) as Record<string, any> } catch { /* not JSON */ } const sc = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]; resolve({ status: res.statusCode ?? 0, json, cookie: sc ? sc.split(';')[0]! : null }) })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}
const must = (r: Res, what: string): Record<string, any> => { if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json }
/** As `must`, for the wallet's routes, which also answer 201 and 202. */
const done2xx = (r: Res, what: string): Record<string, any> => { if (r.status < 200 || r.status > 299) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); return r.json }
const report: Record<string, unknown> = { base: base.origin, origin, startedAt: new Date().toISOString(), steps: [] as unknown[] }
const step = (name: string, detail: Record<string, unknown>): void => { (report.steps as unknown[]).push({ name, atMs: at(), ...detail }); console.log(`${String(at()).padStart(6)} ms  ${name}  ${JSON.stringify(detail)}`) }

try {
  let ready: Res | null = null
  // a build from before /api/ready (the rollback rehearsal's previous release) answers /api/health instead
  for (let i = 0; i < 240; i++) { try { ready = await call('GET', '/api/ready'); if (ready.status === 404) ready = await call('GET', '/api/health'); if (ready.status === 200) break } catch { /* not up */ } await sleep(250) }
  step('ready', { status: ready?.status ?? 0, ready: ready?.json.ready ?? null, checks: ready?.json.checks ?? null })
  step('live', { status: (await call('GET', '/api/live')).status })
  if (ready?.status !== 200) throw new Error('the stack did not become ready')

  const auth = new SoftAuthenticator({ origin, rpId: new URL(origin).hostname })
  const handle = v.handle ?? `owner${Date.now().toString(36)}`
  const b = must(await call('POST', '/api/auth/passkey/signup/begin', { handle, displayName: 'Rehearsal Owner' }), 'sign-up begin')
  const f = await call('POST', '/api/auth/passkey/signup/finish', { challengeId: b.challengeId, response: auth.create(b.options) })
  const fj = must(f, 'sign-up finish')
  cookie = f.cookie ?? ''
  csrf = String(fj.csrf)
  step('signed up with a passkey', { handle, userId: fj.userId, cookie: cookie.split('=')[0], recoveryCodes: Array.isArray(fj.recoveryCodes) ? fj.recoveryCodes.length : 0, rpId: b.options?.rp?.id })
  must(await call('POST', '/api/household', {}), 'household')
  step('paper household opened', {})
  // The paper bank's name check answers before a payee is saved, and does not know this address: as on the page, the
  // owner confirms exactly the answer shown (nameCheckAccepted names it) and adds it. (Without this the script stopped
  // here from the day the name check arrived, R13, until R14: it had not been run against the release.)
  const offered = { name: 'Rehearsal Landlord', handle: v.payee ?? 'rehearsal.landlord@upi', category: 'housing' }
  let added = await call('POST', '/api/payees', offered)
  const nameCheck = added.status === 409 && added.json.error?.code === 'payee_check' ? String(added.json.error.fields?.nameCheck ?? '') : null
  if (nameCheck) added = await call('POST', '/api/payees', { ...offered, nameCheckAccepted: nameCheck })
  const payee = must(added, 'payee')
  step('payee added', { payeeId: payee.id, nameCheck: nameCheck ?? 'match' })
  const amount = Number(v.amount ?? 123_400)
  const pv = must(await call('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: payee.id, amount }), 'preview')
  const pb = must(await call('POST', `/api/approvals/${pv.approvalId}/passkey`, {}), 'approval challenge')
  const conf = must(await call('POST', `/api/approvals/${pv.approvalId}/confirm`, { challengeId: pb.challengeId, response: auth.get(pb.options), docHash: pv.docHash }), 'approval confirm')
  step('payment approved with the passkey', { approvalId: pv.approvalId, amountPaise: amount, method: conf.method, complete: conf.complete })
  const act = must(await call('POST', '/api/actions', { approvalId: pv.approvalId }), 'submit')
  step('payment submitted to the engine', { actionId: act.id, state: act.state })
  report.actionId = act.id
  let last: Record<string, any> = act
  for (let i = 0; i < (v['no-wait'] ? 40 : 480); i++) {
    const a = (await call('GET', `/api/actions/${act.id}`)).json
    if (a && a.state) last = a
    if (v['no-wait'] && ['submitting', 'working', 'done'].includes(String(last.state))) break
    if (String(last.state) === 'done' || String(last.state) === 'failed') break
    await sleep(250)
  }
  step('payment as the engine left it', { state: last.state, economicId: last.economicId ?? null, receipt: last.receiptId ?? null, rail: (last.result as Record<string, unknown> | undefined)?.railState ?? null })
  const receipts = must(await call('GET', '/api/receipts'), 'receipts')
  step('receipts', { count: Array.isArray(receipts.receipts) ? receipts.receipts.length : null, chain: receipts.chain ?? receipts.verify ?? null })
  report.ok = v['no-wait'] ? true : String(last.state) === 'done'

  // ---- the on-chain wallet (R14): create, accept, mandate, pay; each signed by the passkey and followed to its job
  if (report.ok && !v['no-wait'] && !v['no-wallet']) {
    report.ok = false
    let w: Res | null = ready
    for (let i = 0; i < 720 && w?.json.checks?.wallet !== true; i++) { await sleep(250); w = await call('GET', '/api/ready') }
    if (w?.json.checks?.wallet !== true) throw new Error('the wallet service did not become ready in 3 minutes (use --no-wallet for a stack started with QED_WALLET=off)')
    // creating a wallet changes who holds authority: a fresh confirmation with the passkey first
    const su = must(await call('POST', '/api/auth/passkey/stepup/begin', {}), 'confirm begin')
    must(await call('POST', '/api/auth/passkey/stepup/finish', { challengeId: su.challengeId, response: auth.get(su.options) }), 'confirm finish')
    const created = done2xx(await call('POST', '/api/vault/setup', { origin }), 'wallet set-up')
    step('wallet created, owned by the passkey', { status: created.status, signers: Array.isArray(created.signers) ? created.signers.length : null, threshold: created.threshold ?? null })
    if (created.status !== 'awaiting-acceptance') throw new Error(`the wallet is ${String(created.status)}, not awaiting acceptance`)
    /** One wallet action as the wallet's page does it: exact terms, the passkey over each digest, one execution, its job. */
    const act = async (kind: string, params: Record<string, unknown>): Promise<Record<string, any>> => {
      const p = done2xx(await call('POST', '/api/vault/proposals', { kind, params }), `${kind}: terms`)
      const b = done2xx(await call('POST', `/api/vault/approvals/${p.approvalId}/sign/begin`, {}), `${kind}: sign begin`)
      const responses = (b.challenges as { challengeId: string; options: never }[]).map((c) => ({ challengeId: c.challengeId, response: auth.get(c.options) }))
      done2xx(await call('POST', `/api/vault/approvals/${p.approvalId}/sign`, { responses, docHash: p.docHash }), `${kind}: sign`)
      const a = done2xx(await call('POST', `/api/vault/proposals/${p.proposal.id}/execute`, { approvalId: p.approvalId }), `${kind}: execute`)
      let job: Record<string, any> = {}
      for (let i = 0; i < 720; i++) { job = (await call('GET', `/api/vault/jobs/${a.jobId}`)).json; if (['done', 'failed', 'interrupted', 'reorged'].includes(String(job.status))) break; await sleep(250) }
      step(`wallet: ${kind}`, { job: a.jobId, status: job.status ?? null, outcome: job.result?.outcome ?? null, summary: typeof job.result?.summary === 'string' ? job.result.summary.slice(0, 160) : null, error: typeof job.error === 'string' ? job.error.slice(0, 200) : null })
      if (job.status !== 'done' || job.result?.outcome !== 'executed') throw new Error(`wallet ${kind} did not finish as executed`)
      return job
    }
    await act('provision', {})
    const funded = must(await call('GET', '/api/vault'), 'wallet overview')
    step('wallet accepted: the opening grant arrived', { provisioned: funded.state?.provisioned ?? null, treasury: funded.state?.treasury?.balance ?? null, cosigner: funded.state?.roles?.cosignerIsolation ?? null })
    if (funded.state?.provisioned !== true || !(BigInt(funded.state?.treasury?.balance ?? 0) > 0n)) throw new Error('the accepted wallet holds no opening grant')
    await act('mandate', { maxPerPayment: '2500' })
    await act('pay', { payee: 'CloudCo', amount: '3' })
    const paid = must(await call('GET', '/api/vault'), 'wallet overview')
    step('wallet after the payment', { treasury: paid.state?.treasury?.balance ?? null, mandate: paid.state?.mandate?.status ?? null })
    if (!(BigInt(paid.state?.treasury?.balance ?? 0) < BigInt(funded.state.treasury.balance))) throw new Error('the payment did not leave the wallet')
    report.wallet = true
    report.ok = true
  }
} catch (e) {
  report.ok = false
  report.error = e instanceof Error ? e.message : String(e)
  console.error(`FAILED: ${report.error}`)
}
report.finishedAt = new Date().toISOString()
if (v.out) writeFileSync(v.out, `${JSON.stringify(report, null, 2)}\n`)
process.exit(report.ok ? 0 : 1)
