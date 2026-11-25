/**
 * R14 (Priority 3), Spend and Save: an isolated stack with four throwaway passkey households, so the two screens can be
 * read as rendered with and without data, for a rupee household and a US-dollar one.
 *
 *   inr-empty  the rupee example, nothing added (the owner's screenshots 7 to 19 are of this state)
 *   inr-data   payees, bills on record, a payment, a goal, a saving instruction, a conversion into dollars, a goal in
 *              yen, a payee abroad, a mandate for the simulated services
 *   usd-empty  the same example opened in US dollars, nothing added
 *   usd-data   payees, bills, a payment, a goal
 *   inr-chain  the rupee example with its on-chain wallet set up on this stack's local chain (valueless test tokens), a
 *              mandate and a standing policy, so Spend's on-chain mode and Save's "Set aside on the chain" show their forms
 *
 * Everything goes through the public API with passkey approvals over exact terms (a software authenticator answering as
 * Touch ID would). Nothing is written to a database directly. Paper money only.
 *
 *   node scripts/r14-spend-save-fixture.ts [port]     default QED_BROWSER_PORT or 13700; the vault service takes port + 1
 *
 * Writes data/r14-spend-save-fixture.json (git-ignored, mode 600): the address and each household's session cookie, which
 * scripts/r14-spend-save-shots.ts reads. They are sessions of throwaway local accounts, not credentials for any service.
 * The stack keeps running until the process is stopped.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startExtraStack } from '../browser/support/stack.ts'
import { approve, authenticatorFor, signUp, signVault, stepUp } from './lib/passkey-client.ts'

type J = Record<string, any>
const port = Number(process.argv[2] ?? process.env.QED_BROWSER_PORT ?? 13700)
const app = join(import.meta.dirname, '..')
const DAY = 86_400_000
const now = Date.now()
const log = (m: string) => console.log(`[r14 fixture] ${m}`)
const isoIn = (days: number): string => new Date(now + days * DAY + 19_800_000).toISOString().slice(0, 10)

const s = await startExtraStack(port, { QED_SESSION_IDLE_MINUTES: '720', QED_SESSION_MAX_MINUTES: '10080' }, { rail: true })

/** One household's own session: its cookie, its CSRF token and its passkey. */
function session() {
  let cookie = '', csrf = ''
  const auth = authenticatorFor(port)
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> {
    const res = await fetch(s.base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }
  async function ok(method: string, path: string, body?: unknown): Promise<J> {
    const r = await call(method, path, body)
    if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`)
    return r.json
  }
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => { try { await fn(); log(`ok    ${name}`) } catch (e) { log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`) } }
  const signed = async (p: J): Promise<string> => { if (!p.approvalId) throw new Error(`no approval: ${JSON.stringify(p).slice(0, 200)}`); await approve(ok, auth, String(p.approvalId), String(p.docHash)); return String(p.approvalId) }
  const byHand = async (what: J): Promise<void> => { await ok('POST', '/api/actions', { approvalId: await signed(await ok('POST', '/api/actions/preview', what)) }) }
  const instruction = async (kind: string, params: J, authority: J): Promise<string> => {
    const d = await ok('POST', '/api/programs', { kind, params, authority })
    await ok('POST', `/api/programs/${String(d.programId)}/activate`, { approvalId: await signed(await ok('POST', `/api/programs/${String(d.programId)}/approval`, {})) })
    return String(d.programId)
  }
  /** As a person adds a payee: anything but a name match is confirmed with the answer shown (server/name-check.ts). */
  const payee = async (name: string, handle: string, category: string): Promise<string> => {
    const first = await call('POST', '/api/payees', { name, handle, category })
    if (first.status === 200) return String(first.json.id)
    const said = first.json.error?.fields?.nameCheck
    if (first.status !== 409 || typeof said !== 'string') throw new Error(`POST /api/payees -> ${first.status} ${JSON.stringify(first.json).slice(0, 300)}`)
    return String((await ok('POST', '/api/payees', { name, handle, category, nameCheckAccepted: said })).id)
  }
  /** One step on the on-chain wallet: propose it, sign its exact terms digest by digest, send it, wait until it is done. */
  const chain = async (kind: string, params: J = {}): Promise<J> => {
    const p = await ok('POST', '/api/vault/proposals', { kind, params })
    if ((p.sign as unknown[]).length) await signVault(ok, auth, String(p.approvalId), String(p.docHash))
    else await approve(ok, auth, String(p.approvalId), String(p.docHash))
    const a = await ok('POST', `/api/vault/proposals/${String(p.proposal.id)}/execute`, { approvalId: p.approvalId })
    for (let i = 0; i < 240; i++) { const j = await ok('GET', `/api/vault/jobs/${String(a.jobId)}`); if (j.status !== 'accepted' && j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 500)) }
    throw new Error(`the wallet's ${kind} did not finish`)
  }
  return { ok, call, auth, step, signed, byHand, instruction, payee, chain, cookie: () => cookie }
}

const out: Record<string, { cookie: string; note: string }> = {}

async function household(key: string, handle: string, name: string, currency: 'INR' | 'USD', withData: boolean, withChain = false): Promise<void> {
  const h = session()
  await signUp(h.ok, h.auth, handle, name)
  // another home currency opens with the example's figures converted at the recorded rate, as the set-up screen does
  const d = currency === 'INR' ? null : await h.ok('GET', `/api/household/defaults?currency=${currency}`)
  await h.ok('POST', '/api/household', d ? { opening: d.opening, profile: { ...d.profile, homeCurrency: currency } } : {})
  log(`${key}: household open (${currency})`)
  if (withData) {
    let power = '', fibre = '', landlord = ''
    await h.step(`${key}: payees`, async () => {
      power = await h.payee('City Power', 'citypower@upi', 'utilities')
      fibre = await h.payee('Fibre Broadband', 'fibre@upi', 'utilities')
      landlord = await h.payee('Meera Nair', 'meera.nair@upi', 'housing')
    })
    const unit = currency === 'INR' ? 1 : 90 // paise to cents, about ninety rupees to the dollar
    await h.step(`${key}: a payment by hand`, () => h.byHand({ kind: 'payment', purpose: 'spend', payeeId: fibre, amount: Math.round(99_900 / unit), memo: 'Broadband, November' }))
    await h.step(`${key}: bills on record`, async () => {
      await h.ok('POST', '/api/bills', { payeeId: power, amount: Math.round(245_000 / unit), dueAt: now + 26 * 3600_000, memo: 'Electricity, November' })
      await h.ok('POST', '/api/bills', { payeeId: fibre, amount: Math.round(99_900 / unit), dueAt: now + 2 * DAY, memo: 'Broadband, December' })
      await h.ok('POST', '/api/bills', { payeeId: landlord, amount: Math.round(2_500_000 / unit), dueAt: now + 5 * DAY, memo: 'Rent for December' })
    })
    await h.step(`${key}: an instruction that pays bills`, () => h.instruction('bills', { payeeHandles: ['citypower@upi', 'fibre@upi'], capPerBill: Math.round(300_000 / unit) }, { expiresAt: now + 30 * DAY, runMode: 'auto', maxPerRun: Math.round(300_000 / unit), maxPerMonth: Math.round(900_000 / unit) }))
    await h.step(`${key}: a goal`, async () => {
      const id = await h.instruction('goal', { name: 'Holiday in March', target: Math.round(5_000_000 / unit), date: isoIn(127) }, {})
      await h.byHand({ kind: 'payment', purpose: 'goal', goalId: id, amount: Math.round(500_000 / unit) })
    })
    if (currency === 'INR') {
      await h.step(`${key}: a saving instruction`, () => h.instruction('sweep', { instrumentId: 'amfi:118701', keep: 30_000_000, minMove: 1_000_000, schedule: { type: 'daily', at: '12:45' } }, { expiresAt: now + 60 * DAY, runMode: 'approve', maxPerRun: 5_000_000, maxPerMonth: 20_000_000 }))
      await h.step(`${key}: rupees changed into US dollars`, async () => { await h.ok('POST', '/api/fx/convert', { approvalId: await h.signed(await h.ok('POST', '/api/fx/quote', { sell: 'INR', buy: 'USD', amount: '250', fixed: 'buy' })) }) })
      await h.step(`${key}: a goal in yen`, () => h.ok('POST', '/api/fx/goals', { name: 'Trip to Kyoto', currency: 'JPY', target: '300000', by: isoIn(240) }))
      await h.step(`${key}: a payee abroad`, () => h.ok('POST', '/api/abroad/payees', { name: 'Anika Rao', country: 'US', currency: 'USD', account: '123456789012', routing: '021000021' }))
      await h.step(`${key}: a mandate for the simulated services`, async () => { await h.ok('POST', '/api/commerce/mandate/activate', { approvalId: await h.signed(await h.ok('POST', '/api/commerce/mandate', { perPurchase: 5000, perMonth: 10000, services: ((await h.ok('GET', '/api/commerce')).services as J[]).map((x) => x.id), days: 30 })) }) })
      await h.step(`${key}: a purchase inside the mandate`, async () => { const c = await h.ok('GET', '/api/commerce'); await h.ok('POST', '/api/commerce/purchases', { sku: String((c.products as J[])[0]!.sku), idempotencyKey: `r14-${key}` }) })
    }
  }
  if (withChain) {
    await h.step(`${key}: on-chain wallet set up and accepted`, async () => {
      await stepUp(h.ok, h.auth)
      await h.ok('POST', '/api/vault/setup', { origin: s.base })
      const j = await h.chain('provision')
      if (j.result?.outcome !== 'executed') throw new Error(`provision ${String(j.status)} ${String(j.error ?? '')}`)
    })
    await h.step(`${key}: wallet mandate`, () => h.chain('mandate', { maxPerPayment: '2500', maxPerPeriod: '6000', maxTotal: '20000', validDays: 30 }))
    await h.step(`${key}: wallet standing policy`, () => h.chain('policy', { targetFree: '5' }))
  }
  out[key] = { cookie: h.cookie(), note: `${name} (${handle}), ${currency}, ${withData ? 'with data' : 'nothing added'}${withChain ? ', on-chain wallet set up' : ''}` }
}

await household('inr-empty', 'r14empty', 'Asha Rao', 'INR', false)
await household('inr-data', 'r14data', 'Asha Rao', 'INR', true)
await household('usd-empty', 'r14usd', 'Dana Cole', 'USD', false)
await household('usd-data', 'r14usddata', 'Dana Cole', 'USD', true)
await household('inr-chain', 'r14chain', 'Asha Rao', 'INR', false, true)

const file = process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'r14-spend-save-fixture.json')
writeFileSync(file, `${JSON.stringify({ base: s.base, port, dir: s.dir, households: out, at: new Date().toISOString(), note: 'Sessions of throwaway local fixture accounts on an isolated stack. Not credentials for any service.' }, null, 1)}\n`, { mode: 0o600 })
log(`ready: ${s.base} (scratch ${s.dir}); sessions in ${file}. Stop the process to stop the stack.`)
const stop = async () => { await s.stop(); process.exit(0) }
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
setInterval(() => undefined, 60_000)
