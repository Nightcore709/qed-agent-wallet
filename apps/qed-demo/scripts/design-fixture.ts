/**
 * A design fixture: an isolated stack with one fresh passkey household that has realistic activity on both sides.
 * Paper household: bills, payments, purchases at live prices, standing instructions, earning work. On-chain vault (a
 * local chain on this QED installation, valueless test tokens): accepted, a mandate, a payment, a promise, money set aside, a
 * conversion and a standing policy. Everything is done through the public API with passkey approvals over exact
 * terms (a software authenticator answering as Touch ID would); nothing is written to the database directly, except, with
 * QED_FIXTURE_EARN_STATES=1, one paper job as the wallet recorded jobs before terms were recorded (see the paper escrow's states).
 *
 * The stack keeps running so the interface can be read and photographed (scripts/design-shots.ts). It never touches
 * the review database or the services on 5174 to 5176.
 *
 *   node scripts/design-fixture.ts [port]       default 5701; the vault service takes port + 1, its chains +3300/+3301
 *
 * QED_FIXTURE_ASK=scripted answers Ask with the browser suite's scripted test double (labelled as one on screen, never
 * a model) and asks it two questions, so Ask can be read with a conversation and its proposals.
 *
 * QED_FIXTURE_FUND_STATES=1 (on a presentation stack with the test stack's NAV control; see "fund states" below) adds a
 * liquid fund bought, allotted and partly redeemed, so Grow's bought-at and "Why it changed" and each fund order's states
 * can be read.
 *
 * QED_FIXTURE_EARN_STATES=1 adds work paid through the escrow on the chain with a second household (Rohan Mehta, his
 * own passkey and wallet), so Earn's states the plain fixture never reaches can be read (see "Earn's states" below):
 * an offer that lapses, a step waiting for the owner's signature, one waiting for the other side's, work in escrow
 * waiting on the owner, and work the owner pays for; and the paper escrow's deadlines and disputes (a refund to answer,
 * a dispute for the mediator to decide, a split, a delivery date). Sending the fixture SIGUSR2 stops the on-chain wallet's service
 * (Earn then says what it last read and that the service is not answering); SIGUSR2 again starts it on the same data.
 *
 * The landlord is added on the day and paid ₹25,000 at once, so the rent waits (a large first-day payment to a new payee,
 * server/new-payee.ts): Activity, Spend and its record show a payment on hold. QED_FIXTURE_PAYEE_STATES=1 also pays the
 * slow test payee (slow@paper) ₹800, which the rail leaves pending for 90 seconds and then settles: for those 90 seconds
 * its record shows the rail's bound, and afterwards how a dispute would be decided.
 *
 * Writes data/design-fixture.json (or QED_FIXTURE_FILE; git-ignored, mode 600): the address, the scratch folder and the fixture account's
 * session cookie, which the screenshot script reads. It is a session of a throwaway local account, not a credential
 * for any service. Stop the stack with Ctrl-C (or kill the process): the scratch folder is left for inspection.
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startExtraStack } from '../browser/support/stack.ts'
import { approve, authenticatorFor, signUp, signVault, stepUp } from './lib/passkey-client.ts'

type J = Record<string, any>
const port = Number(process.argv[2] ?? 5701)
const app = join(import.meta.dirname, '..')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DAY = 86_400_000

const scripted = process.env.QED_FIXTURE_ASK === 'scripted'
// QED_FIXTURE_WEB_PORT: a development server (Vite) on another port that proxies to this stack; the API then accepts
// that port's host and origin too (server/core.ts allowedHosts), as the review build accepts 5174.
const web: Record<string, string> = process.env.QED_FIXTURE_WEB_PORT ? { QED_WEB_PORT: process.env.QED_FIXTURE_WEB_PORT } : {}
const askEnv: Record<string, string> = scripted ? { QED_AI_PROVIDER: 'scripted', QED_AI_SCRIPT: join(app, 'browser', 'support', 'ask-script.json'), QED_TEST_STACK: '1' } : {}
// Earn's states use periods of seconds for one job (money a timeout leaves locked), which only an isolated test stack allows
const earnEnv: Record<string, string> = process.env.QED_FIXTURE_EARN_STATES === '1' ? { QED_TEST_STACK: '1' } : {}
// A fixture lives for hours while photographs are taken with its one session, so its sessions keep the local build's
// earlier lifetimes (12 hours idle, 7 days in all); the product's are NIST's AAL2 values, 1 hour and 24 hours (server/auth.ts).
const sessionEnv: Record<string, string> = { QED_SESSION_IDLE_MINUTES: '720', QED_SESSION_MAX_MINUTES: '10080' }
const s = await startExtraStack(port, { ...askEnv, ...web, ...earnEnv, ...sessionEnv }, { rail: true })
const base = s.base
let cookie = '', csrf = ''
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> {
  const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
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
const auth = authenticatorFor(port)
const log = (m: string) => console.log(`[fixture] ${m}`)
async function tryStep(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); log(`ok    ${name}`) } catch (e) { log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`) }
}

const asha = await signUp(ok, auth, 'asha.rao', 'Asha Rao')
// A salary of 1,80,000 and 9,00,000 in the bank, as the review household: the instructions below fit inside it.
await ok('POST', '/api/household', { opening: { bank: 90_000_000 }, profile: { income: 18_000_000 } })
log(`account created on ${base}`)

async function byHand(what: J): Promise<void> {
  const p = await ok('POST', '/api/actions/preview', what)
  if (!p.approvalId) throw new Error(`no approval: ${JSON.stringify(p).slice(0, 200)}`)
  await approve(ok, auth, String(p.approvalId), String(p.docHash))
  await ok('POST', '/api/actions', { approvalId: p.approvalId })
}
async function instruction(kind: string, params: J, authority: J): Promise<string> {
  const d = await ok('POST', '/api/programs', { kind, params, authority })
  const a = await ok('POST', `/api/programs/${String(d.programId)}/approval`, {})
  await approve(ok, auth, String(a.approvalId), String(a.docHash))
  await ok('POST', `/api/programs/${String(d.programId)}/activate`, { approvalId: a.approvalId })
  return String(d.programId)
}
/**
 * Add a payee as a person would: the paper bank's name check answers before it is saved, and anything but a match is
 * confirmed with the answer shown, as ticking "I checked this address with the payee myself" does (server/name-check.ts).
 */
async function payee(name: string, handle: string, category: string): Promise<string> {
  const first = await call('POST', '/api/payees', { name, handle, category })
  if (first.status === 200) return String(first.json.id)
  const said = first.json.error?.fields?.nameCheck
  if (first.status !== 409 || typeof said !== 'string') throw new Error(`POST /api/payees -> ${first.status} ${JSON.stringify(first.json).slice(0, 300)}`)
  return String((await ok('POST', '/api/payees', { name, handle, category, nameCheckAccepted: said })).id)
}
/** How much of an instrument the household holds, as its ledger account reads through the public API (base units). */
const held = async (instrumentId: string): Promise<bigint> => BigInt(String(((await ok('GET', '/api/accounts')).accounts as J[]).find((a) => a.code === `pos:${instrumentId}`)?.raw ?? 0))

const now = Date.now()
let power = '', fibre = '', landlord = ''
await tryStep('payees', async () => {
  power = await payee('City Power', 'citypower@upi', 'utility')
  fibre = await payee('Fibre Broadband', 'fibre@upi', 'utility')
  landlord = await payee('Meera Nair', 'meera.nair@upi', 'rent')
})
await tryStep('bought bitcoin by hand', () => byHand({ kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', amount: 300_000 }))
await tryStep('bought an index fund by hand', () => byHand({ kind: 'order', instrumentId: 'amfi:120716', side: 'buy', amount: 500_000 }))
await tryStep('paid the rent by hand', () => byHand({ kind: 'payment', purpose: 'spend', payeeId: landlord, amount: 2_500_000, memo: 'Rent for November' }))
if (process.env.QED_FIXTURE_PAYEE_STATES === '1') await tryStep('a payment the rail leaves pending, then settles', async () => {
  const slow = await payee('Slow Test Account', 'slow@paper', 'other')
  await byHand({ kind: 'payment', purpose: 'spend', payeeId: slow, amount: 80_000, memo: 'Pending for 90 seconds' })
})
await tryStep('bills', async () => {
  await ok('POST', '/api/bills', { payeeId: power, amount: 245_000, dueAt: now + 26 * 3600_000, memo: 'Electricity, November' })
  await ok('POST', '/api/bills', { payeeId: fibre, amount: 99_900, dueAt: now + 2 * DAY, memo: 'Broadband, December' })
  await ok('POST', '/api/bills', { payeeId: power, amount: 612_000, dueAt: now + 5 * DAY, memo: 'Electricity arrears' })
})
/** Open a paper job as the household does: read its complete terms, then accept them by their fingerprint, as earner and as client. */
async function openPaperJob(terms: J): Promise<J> {
  const read = await ok('POST', '/api/earn/terms/preview', terms)
  return ok('POST', '/api/earn/jobs', { ...terms, termsHash: read.hash, accept: { earner: true, client: true } })
}
await tryStep('earning work with a submitted milestone', async () => {
  const job = await openPaperJob({ title: 'Quarterly accounts for Lakeview Studio', client: 'Lakeview Studio', milestones: [{ title: 'Books closed for the quarter', amount: 1_800_000 }, { title: 'Filing prepared', amount: 1_200_000 }] })
  const earn = await ok('GET', '/api/earn')
  const first = (earn.jobs as J[]).find((j) => j.id === job.id)?.milestones?.[0]
  if (first) await ok('POST', `/api/earn/milestones/${String(first.id)}/submit`, { evidence: 'Trial balance and ledger export for July to September, shared with the client on 19 November.' })
})
// Since R12 (task comparison, gap 14) an instruction asks each time unless the owner chooses; these protective and
// certified ones were seeded to run on their own, and say so.
await tryStep('floor instruction', () => instruction('floor', { buffer: 0 }, { expiresAt: now + 60 * DAY, runMode: 'auto' }))
await tryStep('bills instruction', () => instruction('bills', { payeeHandles: ['citypower@upi', 'fibre@upi'], capPerBill: 300_000, leadMinutes: 0 }, { expiresAt: now + 90 * DAY, runMode: 'notify', noticeSec: 3600, maxPerRun: 300_000, maxPerMonth: 1_000_000 }))
// ₹200 a run (a bitcoin order needs about that: the venue's ₹100 minimum in whole steps, and its fee) every six hours
// asks about ₹24,000 a month, inside its ₹25,000 limit. Every hour asked about ₹1,44,000, and the contradiction check
// (rightly) held the draft. The first run is at the next whole minute.
await tryStep('bitcoin every six hours', () => instruction('invest', { instrumentId: 'coindcx:BTCINR', amount: 20_000, schedule: { type: 'every', minutes: 360 } }, { expiresAt: now + 5 * DAY, runMode: 'auto', maxPerRun: 20_000, maxPerMonth: 2_500_000 }))
await tryStep('index fund daily, asks first', () => instruction('invest', { instrumentId: 'amfi:120716', amount: 100_000, schedule: { type: 'daily', at: '10:30' } }, { expiresAt: now + 30 * DAY, runMode: 'approve', maxPerRun: 100_000, maxPerMonth: 3_100_000 }))
// It protects the bitcoin bought by hand above, which the engine fills on its own tick: until then there is nothing to
// protect, and the exit is refused. Wait (at most a minute) until the ledger holds it.
await tryStep('protective sale', async () => {
  for (let i = 0; i < 120 && (await held('coindcx:BTCINR')) <= 0n; i++) await sleep(500)
  await instruction('exit', { instrumentId: 'coindcx:BTCINR', mode: 'trail', trailPct: 4, sellBps: 10_000 }, { expiresAt: now + 14 * DAY, runMode: 'auto' })
})

// Saving for goals (R12 task comparison, gap 5): one on track at QED's monthly figure, and one signed at a monthly
// figure below what reaches it, so Save and Home show a goal that is behind with its remedies in figures.
const isoIn = (days: number): string => new Date(now + days * DAY + 19_800_000).toISOString().slice(0, 10)
await tryStep('a goal on track, with ₹5,000 set aside by hand', async () => {
  const id = await instruction('goal', { name: 'Holiday in Goa', target: 5_000_000, date: isoIn(127) }, {})
  await byHand({ kind: 'payment', purpose: 'goal', goalId: id, amount: 500_000 })
})
await tryStep('a goal behind', () => instruction('goal', { name: 'School fees', target: 12_000_000, date: isoIn(215), amount: 1_200_000 }, {}))

// The on-chain vault: set up (a fresh passkey confirmation), accepted, then exact terms signed digest by digest.
async function job(id: string): Promise<J> { for (let i = 0; i < 240; i++) { const j = await ok('GET', `/api/vault/jobs/${id}`); if (j.status !== 'accepted' && j.status !== 'running') return j; await sleep(500) } throw new Error(`job ${id} did not finish`) }
async function act(kind: string, params: J = {}): Promise<J> {
  const p = await ok('POST', '/api/vault/proposals', { kind, params })
  if ((p.sign as unknown[]).length) await signVault(ok, auth, String(p.approvalId), String(p.docHash))
  else await approve(ok, auth, String(p.approvalId), String(p.docHash))
  const a = await ok('POST', `/api/vault/proposals/${String(p.proposal.id)}/execute`, { approvalId: p.approvalId })
  const j = await job(String(a.jobId))
  return j
}
await tryStep('vault set up and accepted', async () => {
  await stepUp(ok, auth)
  await ok('POST', '/api/vault/setup', { origin: base })
  const j = await act('provision')
  if (j.result?.outcome !== 'executed') throw new Error(`provision ${String(j.status)} ${String(j.error ?? '')}`)
})
await tryStep('vault mandate', () => act('mandate', { maxPerPayment: '2500', maxPerPeriod: '6000', maxTotal: '20000', validDays: 30 }))
await tryStep('vault payment', () => act('pay', { payee: 'CloudCo', amount: '3' }))
await tryStep('vault promise and money set aside', async () => { await act('pay', { payee: 'CloudCo', amount: '2', dueInDays: 30 }); await act('ring-fence', { creditor: 'CloudCo', amount: '4', dueInDays: 30 }) })
await tryStep('vault conversion', () => act('convert', { amount: '10' }))
await tryStep('vault standing policy', () => act('policy', { targetFree: '5' }))

// ------------------------------------------------------------------------------------------------ Earn's states (opt-in)
/*
 * QED_FIXTURE_EARN_STATES=1. One job from Asha to Rohan Mehta (another household on this stack, with its own passkey
 * and wallet), each milestone left in a state the plain fixture never reaches, all through the public API:
 *  - "Certified weights": offered for the shortest time the product allows (deliver within 1 hour, so the offer stands
 *    45 minutes; the API and the vault service both refuse anything shorter). It lapses 45 minutes after it is signed;
 *    nothing here makes it lapse sooner, so the fixture logs when it will.
 *  - "Second opinion": Asha asked to offer it and has not signed (waiting for the owner's signature).
 *  - "Rebalancing note": offered and signed; Rohan asked to fund it and has not signed (waiting for the other side).
 *  - "Quarterly check": funded by Rohan from his wallet; Asha's move is to deliver the work.
 * And one job from Rohan to Asha ("Tax-lot review"), offered and signed: Asha's move as the client is to fund it.
 * A request waiting for a signature lapses after ten minutes (the vault service's proposals do); the fixture asks
 * again within a minute of it lapsing, while it runs, so both stay open. SIGUSR2 stops and starts the on-chain wallet's service.
 */
type Ok = (method: string, path: string, body?: unknown) => Promise<J>
/** A session of its own (its own cookie and CSRF token), for the second household. */
function session(): Ok {
  let jar = '', token = ''
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { ...(jar ? { cookie: jar } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': token } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
    const set = res.headers.get('set-cookie')
    if (set) jar = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') token = json.csrf
    if (res.status < 200 || res.status > 299) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    return json
  }
}
/** Ask for a step, sign its exact terms with the household's own passkey, send it, and wait until the vault service has done it. */
async function signed(o: Ok, a: ReturnType<typeof authenticatorFor>, path: string, body: J = {}): Promise<J> {
  const p = await o('POST', path, body)
  if ((p.sign as unknown[]).length) await signVault(o, a, String(p.approvalId), String(p.docHash))
  else await approve(o, a, String(p.approvalId), String(p.docHash))
  const x = await o('POST', `/api/vault/proposals/${String(p.proposal.id)}/execute`, { approvalId: p.approvalId })
  for (let i = 0; i < 240; i++) {
    const jb = await o('GET', `/api/vault/jobs/${String(x.jobId)}`)
    if (jb.status !== 'accepted' && jb.status !== 'running') {
      if (jb.result?.outcome !== 'executed') throw new Error(`${path}: ${String(jb.status)} ${String(jb.result?.outcome ?? '')} ${String(jb.error ?? '')}`)
      return jb
    }
    await sleep(500)
  }
  throw new Error(`${path} did not finish`)
}
const earnStates = process.env.QED_FIXTURE_EARN_STATES === '1'
const earn: J = {}
let reaskWaiting: (() => Promise<void>) | null = null
if (earnStates) await tryStep('earn states on the chain, with a second household', async () => {
  const rohan = session(), rAuth = authenticatorFor(port)
  await signUp(rohan, rAuth, 'rohan.mehta', 'Rohan Mehta')
  await stepUp(rohan, rAuth)
  await rohan('POST', '/api/vault/setup', { origin: base })
  await signed(rohan, rAuth, '/api/vault/proposals', { kind: 'provision', params: {} })
  await stepUp(ok, auth)
  const created = await ok('POST', '/api/earn/chain/jobs', {
    key: 'fixture-earn-states-family-fund', title: 'Lowest-risk mix for the family fund', clientHandle: 'rohan.mehta',
    problem: { kind: 'custom', assets: [{ name: 'Index fund', volatilityBps: 1500 }, { name: 'Gold', volatilityBps: 1600 }, { name: 'Bitcoin', volatilityBps: 6000 }] },
    milestones: [
      { title: 'Certified weights', amount: 25_075, deliverWithinHours: 1, validForHours: 1 },
      { title: 'Second opinion', amount: 4_000, deliverWithinHours: 48, validForHours: 24 },
      { title: 'Rebalancing note', amount: 9_000, deliverWithinHours: 48, validForHours: 24 },
      { title: 'Quarterly check', amount: 12_000, deliverWithinHours: 72, validForHours: 24 },
    ],
  })
  const [lapsing, mine, theirs, funded] = (created.milestones as { id: string }[]).map((m) => m.id)
  const step = (id: string, what: string) => `/api/earn/chain/milestones/${id}/${what}`
  // the shortest offer first, so its 45 minutes start as early as they can
  await signed(ok, auth, step(lapsing!, 'quote'))
  await signed(ok, auth, step(theirs!, 'quote'))
  await signed(ok, auth, step(funded!, 'quote'))
  await rohan('GET', '/api/earn/chain') // read back from the chain: the three are offered
  await stepUp(rohan, rAuth)
  await signed(rohan, rAuth, step(funded!, 'fund'))
  await rohan('GET', '/api/earn/chain')
  await rohan('POST', step(theirs!, 'fund'), {}) // asked for, never signed: waits for Rohan's signature
  await ok('POST', step(mine!, 'quote'), {}) // asked for, never signed: waits for Asha's own
  // the other way round: Rohan offers work to Asha, who funds it as the client
  const back = await rohan('POST', '/api/earn/chain/jobs', { key: 'fixture-earn-states-tax-lots', title: 'Tax-lot review', clientHandle: 'asha.rao', problem: { kind: 'helix' }, milestones: [{ title: 'Lots matched to the statement', amount: 15_000, deliverWithinHours: 48, validForHours: 24 }] })
  await signed(rohan, rAuth, step((back.milestones as { id: string }[])[0]!.id, 'quote'))
  const view = await ok('GET', '/api/earn/chain')
  const lapse = ((view.asProvider as J[]).flatMap((x) => x.milestones as J[]).find((m) => m.id === lapsing)?.offerValidUntil ?? null) as string | null
  Object.assign(earn, { lapsing, mine, theirs, funded, lapsesAt: lapse })
  log(`the offer on "Certified weights" lapses at ${lapse ?? '(unknown)'} (45 minutes after it was signed)`)
  // keep both requests for a signature open while the fixture runs: they lapse after ten minutes, so ask again
  reaskWaiting = async () => {
    const a = await ok('GET', '/api/earn/chain')
    const m2 = (a.asProvider as J[]).flatMap((x) => x.milestones as J[]).find((m) => m.id === mine)
    if (m2 && !m2.pending && (m2.actions as string[]).includes('quote')) await ok('POST', step(mine!, 'quote'), {})
    const r = await rohan('GET', '/api/earn/chain')
    const m3 = (r.asClient as J[]).flatMap((x) => x.milestones as J[]).find((m) => m.id === theirs)
    if (m3 && !m3.pending && (m3.actions as string[]).includes('fund')) await rohan('POST', step(theirs!, 'fund'), {})
  }
})

// ------------------------------------------------------------------------------------------------ fund states (opt-in)
/*
 * QED_FIXTURE_FUND_STATES=1, on a presentation stack (QED_PRESENTATION=1) with the test stack's control that publishes a
 * day's synthetic NAVs now (QED_TEST_STACK=1 and QED_TEST_SYNTHETIC_NAV_FILE, server/synthetic.ts): a liquid fund is
 * bought by hand, its NAV day is published through the control so its units are allotted, and part of it is then
 * redeemed. Grow shows a fund holding with what it was bought at and why it changed; Home and the records show fund
 * orders in their states (the redemption and, after 15:00, the index fund bought above wait for a later day's NAV).
 * Writing a later day into the control's file publishes that one too, once that day has come (a NAV is the close of its
 * own day; the stack's clock is brought forward through QED_TEST_CLOCK_FILE): the redemption is then redeemed and its
 * money is on its way, and Why it changed has money taken out and an exit load.
 */
const fundStates = process.env.QED_FIXTURE_FUND_STATES === '1'
if (fundStates) await tryStep('fund states: a liquid fund bought, allotted at its published NAV, and part of it redeemed', async () => {
  const navFile = process.env.QED_TEST_SYNTHETIC_NAV_FILE
  if (!navFile || process.env.QED_TEST_STACK !== '1') throw new Error('needs QED_TEST_STACK=1 and QED_TEST_SYNTHETIC_NAV_FILE (and QED_PRESENTATION=1)')
  await byHand({ kind: 'order', instrumentId: 'amfi:118701', side: 'buy', amount: 2_000_000 })
  let day = ''
  for (let i = 0; i < 120 && !day; i++) {
    const a = ((await ok('GET', '/api/activity?limit=20')).actions as J[]).find((x) => x.params?.instrumentId === 'amfi:118701' && x.params?.side === 'buy' && x.result?.navEntitledFrom)
    if (a) day = String(a.result.navEntitledFrom); else await sleep(500)
  }
  if (!day) throw new Error('the registrar never gave the liquid fund order its NAV day')
  // A NAV is the close of its own day: the control publishes none for a day that has not come (R13; until then this step
  // published it at once, and the units were allotted the day before their NAV). Friday after 13:30 and Saturday are
  // entitled to Sunday's: the stack's clock is brought to that evening when QED_TEST_CLOCK_FILE was given to this run.
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10)
  if (day > today) {
    const clockFile = process.env.QED_TEST_CLOCK_FILE
    if (!clockFile) throw new Error(`the order is entitled to the NAV for ${day}, a day that has not come: run on a weekday before 13:30 IST, or give the run QED_TEST_CLOCK_FILE so the stack's clock can be brought to that evening`)
    writeFileSync(clockFile, String(Math.max(0, Date.parse(`${day}T21:00:00+05:30`) - Date.now())))
  }
  writeFileSync(navFile, day)
  for (let i = 0; i < 120 && (await held('amfi:118701')) <= 0n; i++) await sleep(500)
  if ((await held('amfi:118701')) <= 0n) throw new Error(`no units allotted at the NAV for ${day}`)
  await byHand({ kind: 'order', instrumentId: 'amfi:118701', side: 'sell', qty: '50' })
  log(`fund states: liquid fund allotted at the NAV for ${day}; 50 units being redeemed; write a later day into ${navFile} to publish its NAV once that day has come (bring the clock there through QED_TEST_CLOCK_FILE)`)
})

/*
 * The paper escrow's states (R13 section 2), also with QED_FIXTURE_EARN_STATES=1, on jobs of Asha's own, each opened on
 * terms read and accepted by their fingerprint: work in review; the client asking for the money back (Asha's time to
 * agree or dispute); a dispute both sides have answered (the simulated mediator's move, played by Asha); one settled by
 * the mediator's split; a job with a delivery date; money a timeout left locked (a review of 5 seconds whose terms keep
 * the money locked, which only this isolated stack allows), with a settlement one side has offered. And one job as the
 * wallet recorded it before terms were recorded, written directly into this fixture's own database (its one direct
 * write), so the page can be read with a milestone that has no agreed deadline.
 */
if (earnStates) await tryStep('paper escrow states: a refund to answer, a dispute to decide, a split, a delivery date, money locked, a record from before terms', async () => {
  const job = await openPaperJob({ title: 'Website copy for Meera Nair', client: 'Meera Nair', reviewDays: 3, milestones: [{ title: 'Home page draft', amount: 450_000 }, { title: 'About page', amount: 250_000 }, { title: 'Product pages', amount: 900_001 }, { title: 'Final edit', amount: 300_000 }] })
  const ids = (((await ok('GET', '/api/earn')).jobs as J[]).find((j) => j.id === job.id)!.milestones as J[]).map((m) => String(m.id))
  const [draft, about, product, final] = ids as [string, string, string, string]
  const step = (id: string, what: string, body: J) => ok('POST', `/api/earn/milestones/${id}/${what}`, body)
  await step(draft, 'submit', { evidence: 'Draft shared with the client on 24 November.' })
  await step(about, 'client', { decision: 'refund' })
  for (const id of [product, final]) {
    await step(id, 'submit', { evidence: 'Pages delivered as a shared document.' })
    await step(id, 'client', { decision: 'dispute', reason: 'Two product pages still carry last year\'s prices.' })
    await step(id, 'evidence', { side: 'earner', text: 'The prices came from the sheet the client sent on 18 November.' })
  }
  await step(final, 'decide', { outcome: 'split', earnerPaise: 200_000 })
  await openPaperJob({ title: 'Annual report layout', client: 'Lakeview Studio', reviewDays: 7, deliverBy: new Date(now + 5 * DAY + 19_800_000).toISOString().slice(0, 10), milestones: [{ title: 'Layout and type', amount: 1_500_000 }] })
  const lockedJob = await openPaperJob({ title: 'Product photographs', client: 'Kavya Iyer', testSeconds: { review: 5 }, onTimeout: { review: { kind: 'locked' } }, milestones: [{ title: 'Retouched set', amount: 600_001 }] })
  const shoot = String((((await ok('GET', '/api/earn')).jobs as J[]).find((j) => j.id === lockedJob.id)!.milestones as J[])[0]!.id)
  await step(shoot, 'submit', { evidence: 'Forty retouched photographs, shared as a folder.' })
  await sleep(9000) // the 5-second review runs out and the engine leaves the money locked, as the terms say
  await step(shoot, 'settle', { side: 'earner', outcome: 'split', earnerPaise: 450_000 })
  const db = new DatabaseSync(s.db)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare(`INSERT INTO earn_jobs (id, user_id, title, client, state, created_at, meta_json) VALUES ('job_fixture_before_terms', ?, 'Bookkeeping for Lakeview Studio', 'Lakeview Studio', 'open', ?, '{"paperClient":true}')`).run(asha.userId, now - 30 * DAY)
    db.prepare(`INSERT INTO earn_milestones (id, job_id, user_id, title, amount, state, evidence_hash, updated_at) VALUES ('mil_fixture_before_terms', 'job_fixture_before_terms', ?, 'Books closed for October', 1800000, 'submitted', ?, ?)`).run(asha.userId, 'ab'.repeat(32), now - 20 * DAY)
  } finally { db.close() }
})

await sleep(4000)
const home = await ok('GET', '/api/home')
if (scripted) {
  await tryStep('ask: invest and park', async () => { const r = await ok('POST', '/api/ask', { question: 'Invest ₹2,000 every month in the Nifty 50 index fund, and park my idle cash.' }); await ok('POST', '/api/ask', { question: 'Keep 10 test dollars in my dollar reserve', conversationId: r.conversationId }) })
}
log(`home: bank ${String(home.overview?.bank)} paise; free ${String(home.overview?.freeToUse)}; programs ${(home.programs as J[]).length}; needs you ${(home.needsYou as J[]).length}`)
writeFileSync(process.env.QED_FIXTURE_FILE ?? join(app, 'data', 'design-fixture.json'), `${JSON.stringify({ base, port, dir: s.dir, cookie, csrf, at: new Date().toISOString(), ...(earnStates ? { earn } : {}), note: 'Session of a throwaway local fixture account on an isolated stack. Not a credential for any service.' }, null, 1)}\n`, { mode: 0o600 })
log(`ready: ${base} (scratch ${s.dir}). Ctrl-C to stop.`)
const stop = async () => { await s.stop(); process.exit(0) }
process.on('SIGINT', () => { void stop() }); process.on('SIGTERM', () => { void stop() })
if (earnStates) {
  let serviceDown = false, toggling = false
  setInterval(() => { if (!serviceDown && reaskWaiting) reaskWaiting().catch((e: unknown) => log(`asking again for the waiting signatures failed: ${e instanceof Error ? e.message : String(e)}`)) }, 60_000)
  process.on('SIGUSR2', () => {
    if (toggling) return
    toggling = true
    void (serviceDown ? s.railUp() : s.railDown()).then(() => { serviceDown = !serviceDown; log(serviceDown ? 'the on-chain wallet\'s service is stopped (SIGUSR2 starts it again)' : 'the on-chain wallet\'s service is running again') }, (e: unknown) => log(`SIGUSR2 failed: ${e instanceof Error ? e.message : String(e)}`)).finally(() => { toggling = false })
  })
}
setInterval(() => {}, 1 << 30)
