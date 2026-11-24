/**
 * The deployment smoke test, against a RUNNING stack (scripts/deploy/supervise.ts; docs/DEPLOY.md, "Rehearsal"): the
 * probes, then one owner signed up with a passkey made by the software authenticator the security suite uses
 * (server/softauthn.ts), a paper household, a payee, and a paper payment approved with that passkey and carried out by
 * the engine. Local rehearsals only: on a real deployment the first owner signs up in a browser with a real passkey.
 *
 *   node scripts/deploy/smoke.ts --base http://127.0.0.1:10200 --origin http://qed.localhost:10200 [--payee <handle>]
 *        [--amount <paise>] [--no-wait] [--out <report.json>]
 *
 * --origin is the public origin the stack was started with (its host is sent as Host); --payee slow@paper leaves the
 * payment pending for 90 s (the restart rehearsal); --no-wait returns once the engine has it. Prints and writes a report
 * with ids, states and timings only: no cookie, token, key or recovery code.
 */
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { parseArgs } from 'node:util'
import { SoftAuthenticator } from '../../server/softauthn.ts'

const { values: v } = parseArgs({ options: { base: { type: 'string' }, origin: { type: 'string' }, payee: { type: 'string' }, amount: { type: 'string' }, 'no-wait': { type: 'boolean' }, out: { type: 'string' }, handle: { type: 'string' } } })
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
  const payee = must(await call('POST', '/api/payees', { name: 'Rehearsal Landlord', handle: v.payee ?? 'rehearsal.landlord@upi', category: 'housing' }), 'payee')
  step('payee added', { payeeId: payee.id })
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
} catch (e) {
  report.ok = false
  report.error = e instanceof Error ? e.message : String(e)
  console.error(`FAILED: ${report.error}`)
}
report.finishedAt = new Date().toISOString()
if (v.out) writeFileSync(v.out, `${JSON.stringify(report, null, 2)}\n`)
process.exit(report.ok ? 0 : 1)
