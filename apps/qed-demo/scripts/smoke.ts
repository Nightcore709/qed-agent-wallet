/**
 * Live smoke test: starts a real engine and a real API on a fresh scratch database, then walks one owner through
 * sign-up, household set-up, a previewed and approved purchase against the live order book, and the checks that
 * follow it (ledger, reconciliation, receipt chain). It uses live public market data and paper money only.
 *
 *   node scripts/smoke.ts            run the journey and stop
 *   node scripts/smoke.ts --keep     leave the two services running afterwards and print how to reach them
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const keep = process.argv.includes('--keep')
const port = Number(process.env.QED_SMOKE_PORT ?? 5199)
const dir = mkdtempSync(join(tmpdir(), 'qed-smoke-'))
const env = { ...process.env, QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(port), QED_WEB_PORT: String(port) }
const base = `http://127.0.0.1:${port}`

const children: ChildProcess[] = []
function start(cmd: string): ChildProcess {
  const c = spawn(process.execPath, [join(app, 'server', 'main.ts'), cmd], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] })
  c.stdout?.on('data', (d: Buffer) => process.stdout.write(`  [${cmd}] ${d.toString()}`))
  c.stderr?.on('data', (d: Buffer) => { const s = d.toString(); if (!s.includes('ExperimentalWarning')) process.stdout.write(`  [${cmd}!] ${s}`) })
  children.push(c)
  return c
}
const stopAll = () => { for (const c of children) c.kill('SIGTERM') }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let cookie = '', csrf = ''
async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  const json = (await res.json()) as T & { error?: { code: string; message: string } }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error?.code}: ${json.error?.message}`)
  return json
}
const inr = (paise: unknown) => `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
let failed = 0
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed++ }

try {
  console.log(`Scratch database: ${env.QED_DB}`)
  start('engine'); start('api')
  for (let i = 0; i < 40; i++) { try { const h = await fetch(`${base}/api/health`); if (h.ok) break } catch { /* not up yet */ } await sleep(500) }
  await sleep(6000) // let the first prices arrive

  const password = randomBytes(15).toString('base64url')
  const reg = await call<{ csrf: string }>('POST', '/api/auth/register', { handle: 'smoke', displayName: 'Smoke Test', password })
  csrf = reg.csrf
  check('register and sign in', !!csrf)
  await call('POST', '/api/household', {})
  const home = await call<{ overview: { bank: number; freeToUse: number; worst: { gHat: number; line: number } }; engine: { running: boolean } }>('GET', '/api/home')
  check('household opened', home.overview.bank === 80_000_000, `bank ${inr(home.overview.bank)}, worst case ${inr(home.overview.worst.gHat)}, floor ${inr(home.overview.worst.line)}`)
  check('engine heartbeat visible to the API', home.engine.running)

  const market = await call<{ instruments: { id: string; quotes: Record<string, { price: string; ageMs: number; stale: boolean; provider: string }> }[]; providers: { provider: string; state: string }[] }>('GET', '/api/market')
  const btc = market.instruments.find((i) => i.id === 'coindcx:BTCINR')
  check('live INR order-book quote', !!btc?.quotes.bid && !btc.quotes.bid.stale, btc?.quotes.bid ? `bid ${btc.quotes.bid.price} ask ${btc.quotes.ask?.price}, ${Math.round(btc.quotes.bid.ageMs)} ms old` : 'none')
  console.log(`      providers: ${market.providers.map((p) => `${p.provider}=${p.state}`).join(', ')}`)

  const wrongCsrf = await fetch(`${base}/api/stop`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-qed-csrf': 'nope' }, body: '{}' })
  check('a request without the right CSRF token is refused', wrongCsrf.status === 403)
  // fetch() will not send a forged Host header, so this one goes through node:http directly.
  const wrongHost = await new Promise<number>((resolve) => { const rq = request({ host: '127.0.0.1', port, path: '/api/session', headers: { host: 'evil.example' } }, (rs) => { rs.resume(); resolve(rs.statusCode ?? 0) }); rq.on('error', () => resolve(0)); rq.end() })
  check('a request for another host name is refused', wrongHost === 421)

  const preview = await call<{ approvalId: string; docHash: string; summary: string; requiresStepUp: boolean; lines: { label: string; value: string }[]; warnings: string[] }>('POST', '/api/actions/preview', { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 100_000 })
  console.log(`      preview: ${preview.summary}`)
  for (const l of preview.lines) console.log(`        ${l.label}: ${l.value}`)
  const bad = await fetch(`${base}/api/approvals/${preview.approvalId}/confirm`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-qed-csrf': csrf }, body: JSON.stringify({ docHash: '0'.repeat(64) }) })
  check('confirming a different document than the one shown is refused', bad.status === 409)
  await call('POST', `/api/approvals/${preview.approvalId}/confirm`, { docHash: preview.docHash })
  const act = await call<{ id: string }>('POST', '/api/actions', { approvalId: preview.approvalId })
  const again = await fetch(`${base}/api/actions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-qed-csrf': csrf }, body: JSON.stringify({ approvalId: preview.approvalId }) })
  const againJson = (await again.json()) as { id?: string }
  check('submitting the same approval twice creates one action', again.status === 409 || againJson.id === act.id)

  type ActionView = { state: string; reconState: string; receiptId: string | null; error: string | null; result: Record<string, unknown>; times: Record<string, number>; decision: { checks?: { name: string; ok: boolean; detail: string }[] } }
  let a = await call<ActionView>('GET', `/api/actions/${act.id}`)
  for (let i = 0; i < 30 && !a.receiptId; i++) { await sleep(1000); a = await call<ActionView>('GET', `/api/actions/${act.id}`) }
  check('order executed against the live book', a.state === 'done' || a.state === 'partial', `${a.state}; filled ${Number(a.result.filledQty) / 1e8} BTC for ${inr(a.result.filledAmount)}, fee ${inr(a.result.fees)}${a.error ? `; ${a.error}` : ''}`)
  check('reconciled against the venue record', a.reconState === 'reconciled')
  const t = a.times
  console.log(`      times (ms): decided→submitted ${t.submitted! - t.decided!}, submitted→executed ${t.executed! - t.submitted!}, executed→reconciled ${t.reconciled! - t.executed!}`)
  for (const c of a.decision.checks ?? []) console.log(`        ${c.ok ? 'ok ' : 'NO '} ${c.name}: ${c.detail}`)

  const receipts = await call<{ chain: { ok: boolean; count: number }; receipts: { kind: string }[] }>('GET', '/api/receipts')
  check('receipt issued and chain intact', receipts.chain.ok && receipts.chain.count >= 1, `${receipts.chain.count} receipt(s)`)
  const after = await call<{ overview: { bank: number; holdings: { name: string; qty: string; value: number; fresh: { ageMs: number } }[] }; recon: { ok: boolean } | null }>('GET', '/api/home')
  check('holding appears and revalues at the live bid', after.overview.holdings.length === 1, after.overview.holdings.map((h) => `${h.qty} ${h.name} = ${inr(h.value)}`).join('; '))
  check('money left the bank account exactly once', after.overview.bank === 80_000_000 - Number(a.result.movedPaise), `bank ${inr(after.overview.bank)}`)

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.')
  if (keep) { console.log(`\nServices left running. Interface/API: ${base}  (database ${env.QED_DB}). Stop them with Ctrl-C.`); await new Promise(() => {}) }
} catch (e) {
  console.error('Smoke test stopped:', e instanceof Error ? e.message : e)
  failed++
} finally {
  if (!keep) stopAll()
}
process.exitCode = failed ? 1 : 0
