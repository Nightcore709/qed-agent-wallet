/**
 * Creates one review account on the running services and gives it a realistic set of standing instructions, bills,
 * a job and a few hand-made actions, all through the public API with real approvals. Nothing is inserted into the
 * database directly. Prices are live; money is paper.
 *
 *   node scripts/seed-review.ts          (the engine and the API must be running)
 *
 * The account's handle and a randomly generated password are written to data/review-account.json, which is not
 * committed. Running it again signs in to the same account and adds nothing that already exists.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = `http://127.0.0.1:${process.env.QED_API_PORT ?? 5175}`
const credFile = join(app, 'data', 'review-account.json')
const DAY = 86_400_000

let cookie = '', csrf = ''
async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  const json = (await res.json()) as T & { error?: { code: string; message: string; fields?: Record<string, string> } }
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${json.error?.code}: ${json.error?.message} ${JSON.stringify(json.error?.fields ?? {})}`)
  return json
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (s: string) => console.log(s)

const cred = existsSync(credFile) ? (JSON.parse(readFileSync(credFile, 'utf8')) as { handle: string; password: string }) : { handle: 'review', password: randomBytes(15).toString('base64url') }
if (!existsSync(credFile)) {
  const r = await call<{ csrf: string }>('POST', '/api/auth/register', { handle: cred.handle, displayName: 'Review household', password: cred.password })
  csrf = r.csrf
  writeFileSync(credFile, JSON.stringify({ ...cred, note: 'Local paper-money review account. Not a real credential for any service.' }, null, 1), { mode: 0o600 })
  log(`Created account "${cred.handle}". Its password is in ${credFile}.`)
} else {
  // The credentials file outlives the database: after "npm run reset" the account has to be created again under them.
  const r = await call<{ csrf?: string }>('POST', '/api/auth/login', { handle: cred.handle, password: cred.password }, [401])
  if (r.csrf) { csrf = r.csrf; log(`Signed in to "${cred.handle}".`) }
  else { csrf = (await call<{ csrf: string }>('POST', '/api/auth/register', { handle: cred.handle, displayName: 'Review household', password: cred.password })).csrf; log(`Created account "${cred.handle}" again, with the password already in ${credFile}.`) }
}
const session = await call<{ setup: boolean }>('GET', '/api/session')
// A salary of ₹1,80,000 so that the instructions below fit inside what the household has to spare each month:
// ₹70,000 of spending, ₹30,000 of instalments, about ₹30,400 into the index fund, at most ₹25,000 into bitcoin, and the bills.
// ₹9,00,000 in the bank, because the certified card repayment below must leave no approved scenario worse off,
// and one of those scenarios is six months without income together with a ₹1,50,000 medical bill.
if (!session.setup) { await call('POST', '/api/household', { opening: { bank: 90_000_000 }, profile: { income: 18_000_000 } }); log('Opened the paper household (₹9,00,000 in the bank, ₹1,20,000 on the card, two loans, a salary of ₹1,80,000).') }

const programs = (await call<{ programs: { kind: string; state: string; title: string }[] }>('GET', '/api/programs')).programs
const has = (kind: string) => programs.some((p) => p.kind === kind && ['active', 'paused', 'draft', 'completed'].includes(p.state))

async function instruction(kind: string, params: unknown, authority: Record<string, unknown>): Promise<void> {
  if (has(kind) && kind !== 'invest') { log(`  already have a "${kind}" instruction`); return }
  const d = await call<{ programId: string }>('POST', '/api/programs', { kind, params, authority })
  const a = await call<{ approvalId: string; docHash: string; doc: { title: string } }>('POST', `/api/programs/${d.programId}/approval`, {}, [409])
  if (!a.approvalId) { log(`  could not be approved: ${JSON.stringify(a)}`); return }
  await call('POST', `/api/approvals/${a.approvalId}/confirm`, { docHash: a.docHash, password: cred.password })
  await call('POST', `/api/programs/${d.programId}/activate`, { approvalId: a.approvalId })
  log(`  signed and activated: ${a.doc.title}`)
}
async function byHand(what: Record<string, unknown>): Promise<string | null> {
  const p = await call<{ approvalId?: string; docHash?: string; summary?: string; error?: { message: string } }>('POST', '/api/actions/preview', what, [400, 409])
  if (!p.approvalId) { log(`  not possible: ${p.error?.message}`); return null }
  await call('POST', `/api/approvals/${p.approvalId}/confirm`, { docHash: p.docHash, password: cred.password })
  const a = await call<{ id: string }>('POST', '/api/actions', { approvalId: p.approvalId })
  log(`  approved by hand: ${p.summary}`)
  return a.id
}

const acts = (await call<{ actions: unknown[] }>('GET', '/api/activity')).actions
if (acts.length === 0) {
  log('By hand:')
  await byHand({ kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 300_000 })
  await byHand({ kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 500_000 })
  const now = Date.now()
  // the paper bank's name check answers before a payee is saved; anything but a match is confirmed with the answer shown,
  // as a person ticks "I checked this address with the payee myself" (server/name-check.ts). 409 "exists" stays allowed.
  const mk = async (name: string, handle: string, category: string) => {
    const first = await call<{ id?: string; error?: { fields?: Record<string, string> } }>('POST', '/api/payees', { name, handle, category }, [409])
    const said = first.error?.fields?.nameCheck
    return first.id ?? (said ? (await call<{ id: string }>('POST', '/api/payees', { name, handle, category, nameCheckAccepted: said }, [409])).id : undefined)
  }
  const power = await mk('City Power', 'citypower@upi', 'utility'), fibre = await mk('Fibre Broadband', 'fibre@upi', 'utility'), landlord = await mk('Meera Nair (landlord)', 'meera.nair@upi', 'rent')
  const refuse = await mk('Test payee that declines', 'decline@paper', 'test'), slow = await mk('Test payee that settles late', 'slow@paper', 'test')
  if (landlord) await byHand({ kind: 'payment', purpose: 'spend', payeeId: landlord, amount: 2_500_000, memo: 'Rent for November' })
  if (refuse) await byHand({ kind: 'payment', purpose: 'spend', payeeId: refuse, amount: 150_000, memo: 'A payment that will be declined' })
  if (slow) await byHand({ kind: 'payment', purpose: 'spend', payeeId: slow, amount: 80_000, memo: 'A payment that stays pending for 90 seconds' })
  if (power) await call('POST', '/api/bills', { payeeId: power, amount: 245_000, dueAt: now + 26 * 3600_000, memo: 'Electricity, November' })
  if (fibre) await call('POST', '/api/bills', { payeeId: fibre, amount: 99_900, dueAt: now + 2 * DAY, memo: 'Broadband, December' })
  if (power) await call('POST', '/api/bills', { payeeId: power, amount: 612_000, dueAt: now + 5 * DAY, memo: 'Electricity arrears (above the cap)' })
  // a paper job opens only on terms read first and accepted by their fingerprint, for both sides (the household plays the client)
  const jobTerms = { title: 'Quarterly accounts for Lakeview Studio', client: 'Lakeview Studio', milestones: [{ title: 'Books closed for the quarter', amount: 1_800_000 }, { title: 'Filing prepared', amount: 1_200_000 }] }
  const read = await call<{ hash: string }>('POST', '/api/earn/terms/preview', jobTerms)
  const job = await call<{ id: string }>('POST', '/api/earn/jobs', { ...jobTerms, termsHash: read.hash, accept: { earner: true, client: true } })
  const earn = await call<{ jobs: { id: string; milestones: { id: string }[] }[] }>('GET', '/api/earn')
  const first = earn.jobs.find((j) => j.id === job.id)?.milestones[0]
  if (first) await call('POST', `/api/earn/milestones/${first.id}/submit`, { evidence: 'Trial balance and ledger export for July to September, shared with the client on 19 November.' })
  await sleep(4000)
}

log('Standing instructions:')
const now = Date.now()
// Since R12 (task comparison, gap 14) an instruction asks each time unless the owner chooses; these protective and
// certified ones were seeded to run on their own, and say so.
await instruction('paydown', { plan: { card: 50_000 } }, { expiresAt: now + DAY, runMode: 'auto' })
// The repayment is certified on the household as it stands now and is checked again when it runs. It is given time to
// run before the investing instructions below are signed: their monthly outflows would change what the check counts.
for (let i = 0; i < 30; i++) {
  const p = (await call<{ programs: { kind: string; state: string }[] }>('GET', '/api/programs')).programs.find((x) => x.kind === 'paydown')
  if (!p || p.state === 'completed') { log(`  the card repayment has ${p ? 'run' : 'not been signed'}`); break }
  await sleep(1000)
}
await instruction('floor', { buffer: 0 }, { expiresAt: now + 60 * DAY, runMode: 'auto' })
await instruction('bills', { payeeHandles: ['citypower@upi', 'fibre@upi'], capPerBill: 300_000, leadMinutes: 0 }, { expiresAt: now + 90 * DAY, runMode: 'notify', noticeSec: 3600, maxPerRun: 300_000, maxPerMonth: 1_000_000 })
if (!programs.some((p) => p.kind === 'invest')) {
  // ₹200 every hour for five days is 120 runs and ₹24,000: inside the ₹25,000 monthly limit, so no run is refused for the limit.
  await instruction('invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 60 } }, { expiresAt: now + 5 * DAY, runMode: 'auto', maxPerRun: 20_000, maxPerMonth: 2_500_000 })
  await instruction('invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'daily', at: '10:30' } }, { expiresAt: now + 30 * DAY, runMode: 'approve', maxPerRun: 100_000, maxPerMonth: 3_100_000 })
}
await instruction('exit', { instrumentId: 'coindcx:BTCINR', mode: 'trail', trailPct: 4, sellBps: 10_000 }, { expiresAt: now + 14 * DAY, runMode: 'auto' })
await instruction('sweep', { instrumentId: 'amfi:118701', keep: 30_000_000, minMove: 1_000_000, schedule: { type: 'daily', at: '12:45' } }, { expiresAt: now + 60 * DAY, runMode: 'approve', maxPerRun: 50_000_000, maxPerMonth: 200_000_000 })
await instruction('split', { rules: [{ to: 'fund', instrumentId: 'amfi:120716', shareBps: 1000 }, { to: 'card', shareBps: 1500 }], minIncome: 500_000 }, { expiresAt: now + 120 * DAY, runMode: 'notify', noticeSec: 600, maxPerRun: 5_000_000, maxPerMonth: 10_000_000 })

await sleep(6000)
const home = await call<{ overview: { bank: number; freeToUse: number; holdingsValue: number; card: number; worst: { gHat: number; line: number } }; needsYou: unknown[]; programs: { title: string; state: string }[] }>('GET', '/api/home')
const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
log(`\nNow: bank ${inr(home.overview.bank)}, free to use ${inr(home.overview.freeToUse)}, holdings ${inr(home.overview.holdingsValue)}, card ${inr(home.overview.card)}, worst case ${inr(home.overview.worst.gHat)} against a floor of ${inr(home.overview.worst.line)}.`)
log(`Instructions: ${home.programs.map((p) => `${p.title} [${p.state}]`).join(' | ')}`)
log(`Waiting on the owner: ${home.needsYou.length} item(s).`)
