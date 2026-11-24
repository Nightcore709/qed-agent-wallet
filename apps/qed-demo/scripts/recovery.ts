/**
 * Failure and recovery, live, against an isolated copy of QED.
 *
 *   node scripts/recovery.ts [report.json]
 *
 * It starts its own engine and API on a scratch database, then breaks things on purpose and records what happened:
 *
 *   1. The engine is killed outright while a payment is in flight. On restart the gap is recorded, the payment
 *      settles once, and the books agree with the rail.
 *   2. An order is approved while the engine is down. The engine returns 30 seconds later to stale prices: the
 *      order waits for a fresh price, then executes once.
 *   3. An instruction is revoked while one of its runs is waiting for approval. The run is cancelled, cannot be
 *      approved afterwards, and no further run starts.
 *   4. The API is killed. The engine keeps executing a scheduled instruction without it.
 *   5. An order is approved while the engine is down, and the engine stays down for longer than the start limit.
 *      On restart the order is refused, not sent late.
 *
 * Prices are live public market data; the money is paper. The whole run takes about ten minutes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { registerAmountSql } from '../server/amount-sql.ts'
import { fromAmountText } from '../shared/amount-text.ts'
import { toNum } from '../shared/fixed.ts'
import { approve, authenticatorFor, signUp } from './lib/passkey-client.ts'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const out = process.argv[2] ?? 'recovery.json'
const port = Number(process.env.QED_RECOVERY_PORT ?? 5197)
const dir = mkdtempSync(join(tmpdir(), 'qed-recovery-'))
const dbPath = join(dir, 'qed.db')
const env = { ...process.env, QED_DB: dbPath, QED_API_PORT: String(port), QED_WEB_PORT: String(port), QED_AI_PROVIDER: 'none' }
const base = `http://127.0.0.1:${port}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ist = (ms: number | null | undefined): string | null => (ms == null ? null : new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST'))

const procs: Record<string, ChildProcess | undefined> = {}
const stderr: string[] = []
function start(cmd: 'engine' | 'api'): void {
  const c = spawn(process.execPath, [join(app, 'server', 'main.ts'), cmd], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stderr?.on('data', (d: Buffer) => { const s = d.toString(); if (!s.includes('ExperimentalWarning') && !s.includes('--trace-warnings')) stderr.push(`[${cmd}] ${s.trim().slice(0, 300)}`) })
  procs[cmd] = c
}
/** Kill without warning, as a crash or a power cut would. The process gets no chance to tidy up. */
async function crash(cmd: 'engine' | 'api'): Promise<number> { const at = Date.now(); procs[cmd]?.kill('SIGKILL'); procs[cmd] = undefined; await sleep(300); return at }

let cookie = '', csrf = ''
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> }
}
const ok = async (method: string, path: string, body?: unknown): Promise<Record<string, any>> => { const r = await call(method, path, body); if (r.status !== 200) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r.json }
// Amounts are read from their text and summed with amount_sum, as the server does (stage S3): the INTEGER copy is NULL past 64 bits.
function q<T = Record<string, any>>(sql: string, ...p: (string | number)[]): T[] { const d = new DatabaseSync(dbPath, { readOnly: true }); registerAmountSql(d); try { return d.prepare(sql).all(...p) as T[] } finally { d.close() } }
const one = <T = Record<string, any>>(sql: string, ...p: (string | number)[]): T | undefined => q<T>(sql, ...p)[0]
async function until<T>(what: () => T | undefined | null | false, ms: number, every = 500): Promise<T | null> { const end = Date.now() + ms; for (;;) { const v = what(); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }
const healthy = async (): Promise<number> => { try { return (await fetch(`${base}/api/health`)).status } catch { return 0 } }

interface Step { scenario: string; name: string; expected: string; observed: string; pass: boolean; at: string | null }
const steps: Step[] = []
function step(scenario: string, name: string, expected: string, observed: string, pass: boolean): void {
  steps.push({ scenario, name, expected, observed, pass, at: ist(Date.now()) })
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${scenario}] ${name}  (${observed})`)
}
// The owner's passkey (a software authenticator answering as Touch ID would). Every approval is its signature.
const passkey = authenticatorFor(port)
async function approveAndSend(body: Record<string, unknown>): Promise<string> {
  const pv = await ok('POST', '/api/actions/preview', body)
  await approve(ok, passkey, String(pv.approvalId), String(pv.docHash))
  return String((await ok('POST', '/api/actions', { approvalId: pv.approvalId })).id)
}
async function sign(kind: string, params: unknown, authority: Record<string, unknown>): Promise<string> {
  const d = await ok('POST', '/api/programs', { kind, params, authority: { expiresAt: Date.now() + 2 * 86_400_000, ...authority } })
  // A run every minute asks for far more each month than the monthly limit allows (R7-093): the owner accepts that
  // later runs in a month will be refused, and that acceptance becomes part of the document the passkey signs. The
  // scenarios here last minutes and stay far inside the limit.
  const a = await ok('POST', `/api/programs/${String(d.programId)}/approval`, { acknowledge: ['schedule-over-limit'] })
  await approve(ok, passkey, String(a.approvalId), String(a.docHash))
  await ok('POST', `/api/programs/${String(d.programId)}/activate`, { approvalId: a.approvalId })
  return String(d.programId)
}
const action = (id: string) => one<{ state: string; error: string | null; times_json: string; result_json: string; policy_json: string; recon_state: string; receipt_id: string | null; created_at: number }>('SELECT state, error, times_json, result_json, policy_json, recon_state, receipt_id, created_at FROM actions WHERE id = ?', id)
const bank = (): number => toNum(fromAmountText(one<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.code = 'bank'`)?.t ?? '0', 'the bank balance'))

try {
  console.log(`Scratch database: ${dbPath}; services on port ${port}`)
  start('engine'); start('api')
  await until(() => undefined, 1500)
  for (let i = 0; i < 60 && (await healthy()) !== 200; i++) await sleep(500)
  csrf = (await signUp(ok, passkey, 'recovery', 'Recovery Test')).csrf
  await ok('POST', '/api/household', {})
  const fresh = await until(() => one(`SELECT 1 x FROM quotes WHERE instrument_id = 'coindcx:BTCINR' AND price_type = 'ask' AND recv_ts > ?`, Date.now() - 10_000), 40_000)
  step('setup', 'services up and a live rupee price for bitcoin is arriving', 'a quote under 10 seconds old', fresh ? 'fresh quote on record' : 'no fresh quote within 40 s', !!fresh)

  // ---------------------------------------------------------------- 1 and 2: crash with a payment in flight; an order approved while down
  const slow = await ok('POST', '/api/payees', { name: 'Slow payee', handle: 'slow@paper', category: 'other', nameCheckAccepted: 'no_match' })
  const before = bank()
  const seqBefore = Number(one<{ m: number | null }>('SELECT MAX(seq) m FROM entries')?.m ?? 0)
  const payId = await approveAndSend({ kind: 'payment', purpose: 'spend', payeeId: slow.id, amount: 80_000 })
  const working = await until(() => (action(payId)?.state === 'working' ? action(payId) : null), 15_000)
  step('1 crash mid-payment', 'the payment reached the rail and is pending there', 'action working, rail pending', `action ${action(payId)?.state}; rail ${String(one(`SELECT state FROM pv_payments`)?.state)}`, !!working && one(`SELECT state FROM pv_payments`)?.state === 'pending')
  const killedAt = await crash('engine')
  const orderId = await approveAndSend({ kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 50_000, maxSlippageBps: 200 })
  step('2 approved while down', 'the API records the approved order but nothing executes it', 'action planned, no venue order', `action ${action(orderId)?.state}; venue orders ${q('SELECT 1 FROM pv_orders').length}`, action(orderId)?.state === 'planned' && q('SELECT 1 FROM pv_orders').length === 0)
  await sleep(30_000)
  const h = await healthy()
  step('1 crash mid-payment', 'with the engine dead the API says so', 'health 503', `health ${h}`, h === 503)
  const stillPending = one(`SELECT state FROM pv_payments`)?.state
  start('engine')
  const restartedAt = Date.now()
  const gap = await until(() => one<{ from_ts: number; to_ts: number; note: string }>('SELECT from_ts, to_ts, note FROM downtime ORDER BY id DESC LIMIT 1'), 15_000)
  step('1 crash mid-payment', 'on restart the engine writes down the time it was not running', 'one gap of about 30 seconds', gap ? `${ist(gap.from_ts)} to ${ist(gap.to_ts)} (${((gap.to_ts - gap.from_ts) / 1000).toFixed(0)} s): ${gap.note}` : 'no gap recorded', !!gap && gap.to_ts - gap.from_ts > 20_000 && stillPending === 'pending')

  const ordered = await until(() => { const a = action(orderId); return a && a.state !== 'planned' && a.state !== 'submitting' && a.state !== 'working' ? a : null }, 60_000)
  const ot = JSON.parse(ordered?.times_json ?? '{}') as Record<string, number>
  const orr = JSON.parse(ordered?.result_json ?? '{}') as Record<string, unknown>
  step('2 approved while down', 'back on stale prices, the order waits for a fresh one and then executes once', 'done; one venue order; decided after the restart', `${ordered?.state ?? 'not finished'}; venue orders ${q('SELECT 1 FROM pv_orders').length}; asked ${ist(ordered?.created_at)}, decided ${ist(ot.decided)}, ${ot.decided ? ((ot.decided - (ordered?.created_at ?? 0)) / 1000).toFixed(1) : '?'} s after it was asked for${orr.waitingFor ? `; it waited because: ${String(orr.waitingFor)}` : '; a fresh price was already there on the first check'}`, ordered?.state === 'done' && q('SELECT 1 FROM pv_orders').length === 1 && (ot.decided ?? 0) >= restartedAt)

  const settled = await until(() => (action(payId)?.state === 'done' ? action(payId) : null), 110_000)
  const pt = JSON.parse(settled?.times_json ?? '{}') as Record<string, number>
  const entries = q<{ ref: string }>(`SELECT ref FROM entries WHERE ref LIKE 'pay:%' ORDER BY seq`).map((e) => e.ref.split(':').pop())
  step('1 crash mid-payment', 'the payment settles once after the restart, and the books agree with the rail', 'done; entries out and settle once each; reconciled; receipt issued', `${settled?.state ?? action(payId)?.state}; entries ${entries.join(', ')}; compared with the rail: ${settled?.recon_state}; receipt ${settled?.receipt_id ? 'issued' : 'none'}; settled ${pt.executed ? ((pt.executed - killedAt) / 1000).toFixed(0) : '?'} s after the crash`, settled?.state === 'done' && entries.join(',') === 'out,settle' && q('SELECT 1 FROM pv_payments').length === 1)
  await until(() => (action(payId)?.recon_state === 'reconciled' ? true : null), 10_000)
  // What left the bank through each kind of entry since the scenario began, from the ledger itself. The purchase's cost
  // depends on the lot size the venue fills (₹500 asked buys whole steps of the coin, fee included), so it is read from
  // its own entries, not expected inside a fixed window.
  const bankOut = (kind: string): number => -toNum(fromAmountText(one<{ s: string }>(`SELECT amount_sum(p.amount_text) s FROM postings p JOIN accounts a ON a.id = p.account_id JOIN entries e ON e.id = p.entry_id WHERE a.code = 'bank' AND e.seq > ? AND e.kind = ?`, seqBefore, kind)?.s, `what left the bank by ${kind}`))
  const paid = bankOut('payment-sent'), bought = bankOut('buy'), moved = before - bank()
  step('1 crash mid-payment', 'exactly the payment and the purchase left the bank account', 'bank lower by ₹800 plus exactly what the buy entries took; the buy cost at most the ₹500 asked', `bank moved by ${(moved / 100).toFixed(2)} rupees: payment ${(paid / 100).toFixed(2)}, purchase ${(bought / 100).toFixed(2)}`, paid === 80_000 && bought > 0 && bought <= 50_000 && moved === paid + bought)

  // ---------------------------------------------------------------- 3: revocation beats a waiting run
  const asking = await sign('invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 20_000, maxPerMonth: 400_000, runMode: 'approve' })
  const waiting = await until(() => one<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'awaiting_approval'`, asking), 90_000)
  step('3 revoked while waiting', 'the instruction asks before its first run', 'a run waiting for approval', waiting ? `run ${waiting.id} is waiting` : 'no run appeared', !!waiting)
  await ok('POST', `/api/programs/${asking}/revoke`)
  const cancelled = await until(() => one<{ state: string; reason: string }>(`SELECT state, reason FROM runs WHERE id = ? AND state = 'cancelled'`, waiting?.id ?? ''), 10_000)
  const late = await call('POST', `/api/runs/${waiting?.id ?? 'x'}/approval`)
  step('3 revoked while waiting', 'revoking cancels the waiting run at once, and it can no longer be approved', 'run cancelled; approval request refused', `run ${cancelled?.state ?? 'not cancelled'}: ${cancelled?.reason ?? ''}; approval request afterwards: ${late.status} ${String(late.json?.error?.code ?? '')}`, cancelled?.state === 'cancelled' && late.status !== 200)

  // ---------------------------------------------------------------- 4: the API dies, the engine carries on
  const auto = await sign('invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 1 } }, { maxPerRun: 20_000, maxPerMonth: 400_000, runMode: 'auto' })
  const apiDown = await crash('api')
  await sleep(75_000)
  const apiHealth = await healthy()
  const ranBlind = q<{ state: string; started_at: number }>('SELECT state, started_at FROM runs WHERE program_id = ? AND started_at > ?', auto, apiDown)
  start('api')
  for (let i = 0; i < 40 && (await healthy()) !== 200; i++) await sleep(500)
  step('4 API down', 'with the API dead the engine still runs the instruction on schedule', 'API unreachable; at least one run done in that time', `API health ${apiHealth || 'unreachable'}; runs started while it was down: ${ranBlind.map((x) => `${x.state} at ${ist(x.started_at)?.slice(11, 19)}`).join(', ') || 'none'}`, apiHealth === 0 && ranBlind.some((x) => x.state === 'done'))
  const afterRevoke = q('SELECT 1 FROM runs WHERE program_id = ? AND created_at > ?', asking, Date.now() - 150_000 + 1).length
  const revokedActions = q('SELECT 1 FROM actions WHERE program_id = ?', asking).length
  step('3 revoked while waiting', 'minutes later the revoked instruction has started nothing and executed nothing', 'no action ever created for it', `${revokedActions} actions; state ${String(one('SELECT state FROM programs WHERE id = ?', asking)?.state)}`, revokedActions === 0 && afterRevoke <= 1)
  await ok('POST', `/api/programs/${auto}/revoke`)

  // ---------------------------------------------------------------- 5: approved while down, and down for too long
  await sleep(4000)
  const bank5 = bank(), orders5 = q('SELECT 1 FROM pv_orders').length
  await crash('engine')
  const lateId = await approveAndSend({ kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 50_000, maxSlippageBps: 200 })
  console.log('      engine down; waiting 165 seconds so the order is past its start limit …')
  await sleep(165_000)
  start('engine')
  const refused = await until(() => (action(lateId)?.state === 'blocked' || action(lateId)?.state === 'done' ? action(lateId) : null), 30_000)
  const failing = ((JSON.parse(refused?.policy_json ?? '{}') as { checks?: { name: string; ok: boolean }[] }).checks ?? []).filter((c) => !c.ok).map((c) => c.name)
  step('5 too late to start', 'an order the engine could not start within its limit is refused, not sent late', 'refused on started-in-time; no venue order; bank unchanged', `${refused?.state ?? action(lateId)?.state}: ${refused?.error ?? ''} Failing checks: ${failing.join(', ') || 'none'}; new venue orders ${q('SELECT 1 FROM pv_orders').length - orders5}; bank moved by ${bank() - bank5} paise`, refused?.state === 'blocked' && failing.includes('started-in-time') && q('SELECT 1 FROM pv_orders').length === orders5 && bank() === bank5)

  // ---------------------------------------------------------------- the books after all of it
  await sleep(4000)
  const unbalanced = q(`SELECT entry_id FROM postings GROUP BY entry_id, asset_id HAVING amount_sum(amount_text) != '0'`).length
  const dupRefs = q('SELECT economic_id FROM actions GROUP BY economic_id HAVING COUNT(*) > 1').length + q('SELECT client_ref FROM pv_orders GROUP BY client_ref HAVING COUNT(*) > 1').length + q('SELECT client_ref FROM pv_payments GROUP BY client_ref HAVING COUNT(*) > 1').length
  const breaks = q(`SELECT 1 FROM actions WHERE recon_state = 'break'`).length
  const openHolds = q('SELECT 1 FROM holds WHERE released_at IS NULL').length
  const receipts = q<{ seq: number }>('SELECT seq FROM receipts ORDER BY seq').map((r) => r.seq)
  step('integrity', 'after two crashes of the engine and one of the API the records are whole', 'every entry balances; no reference used twice; nothing disagrees with a venue; nothing left reserved; receipt numbers unbroken', `${unbalanced} unbalanced entries; ${dupRefs} duplicated references; ${breaks} records disagreeing with a venue; ${openHolds} reservations still open; ${receipts.length} receipts numbered ${receipts[0] ?? '-'} to ${receipts[receipts.length - 1] ?? '-'}`, unbalanced === 0 && dupRefs === 0 && breaks === 0 && openHolds === 0 && receipts.every((s, i) => s === i + 1))
  const gaps = q<{ from_ts: number; to_ts: number }>('SELECT from_ts, to_ts FROM downtime ORDER BY id')
  step('integrity', 'both periods without an engine are on record', 'two gaps', gaps.map((g) => `${((g.to_ts - g.from_ts) / 1000).toFixed(0)} s`).join(', ') || 'none', gaps.length === 2)
} catch (e) {
  step('harness', 'the scenarios ran to the end', 'no exception', e instanceof Error ? `${e.message} ${e.stack?.split('\n').slice(1, 3).join(' ')}` : String(e), false)
} finally {
  for (const c of Object.values(procs)) c?.kill('SIGTERM')
}

const failed = steps.filter((s) => !s.pass)
writeFileSync(out, `${JSON.stringify({ what: 'QED failure and recovery, live on an isolated scratch copy', producedAt: ist(Date.now()), howToReproduce: 'node scripts/recovery.ts <report.json>', passed: steps.length - failed.length, failed: failed.length, steps, serviceErrorOutput: stderr.slice(0, 20) }, null, 1)}\n`)
console.log(`\n${steps.length - failed.length} passed, ${failed.length} failed. Report: ${out}`)
await sleep(500)
process.exit(failed.length ? 1 : 0)
