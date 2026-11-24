/**
 * The on-chain vault, end to end through QED's own API, as the interface uses it.
 *
 *   node scripts/vault-journey.ts --isolated [report.json]   on its own scratch stack with fresh owners
 *
 * Since 22 November 2026 each household's vault is owned by its passkeys (an owner account on the local chain whose
 * signers they are; server/rail.ts), and every owner action is signed by the passkey over the digests the chain
 * checks. The journey creates a fresh passkey account (a software authenticator answering as Touch ID would), sets up
 * its vault and accepts it, and then, each time through the full path of exact terms, the passkey's signature, one
 * execution and the job's steps: signs a mandate, pays, promises and sets money aside, moves the owner's own money,
 * asks for a smaller venue set (which waits out the account's delay) and cancels it, converts inside the limits,
 * tries to convert outside them, runs an attack that must revert, repeats an execution to show it is the same job,
 * signs a standing policy and waits for the engine to tick it by itself, pauses and resumes, and has the vault
 * service re-hash its decision records. A second household then sets up its own vault and tries to reach the first.
 *
 * It starts its own vault service (with its own chain), engine and API on spare ports. The chain is local and the
 * tokens are valueless test tokens (tINR, 2 decimals, in the treasury; tUSD, 6 decimals, in the reserve).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approve, authenticatorFor, signUp, signVault, stepUp } from './lib/passkey-client.ts'

const here = dirname(fileURLToPath(import.meta.url))
const app = join(here, '..')
const isolated = process.argv.includes('--isolated')
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'vault-journey.json'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Approvals are passkey signatures, and the review account (made before passkeys) has none until its owner adds one
// in the interface; the journey therefore always runs on its own isolated stack with fresh passkey accounts.
if (!isolated) { console.error('Approvals need a passkey since R7. Run this journey with --isolated, which creates its own passkey accounts and stack.'); process.exit(2) }
const children: ChildProcess[] = []
const dir = mkdtempSync(join(tmpdir(), 'qed-vault-'))
const ports = { api: 5195, rail: 5187, anvil: 8587, economy: 8588 }
const base = `http://127.0.0.1:${ports.api}`
const origin = `http://localhost:${ports.api}`
{
  const env = {
    ...process.env, PATH: `${homedir()}/.foundry/bin:${process.env.PATH}`,
    QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(ports.api), QED_WEB_PORT: String(ports.api), QED_AI_PROVIDER: 'none',
    QED_RAIL_URL: `http://127.0.0.1:${ports.rail}`, QED_RAIL_TOKEN_FILE: join(dir, 'rail.token'),
    QED_RAIL_DATA: dir, QED_RAIL_PORT: String(ports.rail), QED_RAIL_ANVIL_PORT: String(ports.anvil), QED_RAIL_ECONOMY_ANVIL_PORT: String(ports.economy),
    // the shortest delay the owner account allows, so that a scheduled change can be seen waiting within the run
    QED_RAIL_ACCOUNT_DELAY_S: '60',
  }
  children.push(spawn(process.execPath, ['serve.ts'], { cwd: join(app, 'chain'), env, stdio: 'ignore' }))
  for (let i = 0; i < 240; i++) { try { const h = await fetch(`http://127.0.0.1:${ports.rail}/health`); if (h.status === 200 && ((await h.json()) as { ready?: boolean }).ready) break } catch { /* not up yet */ } await sleep(500) }
  for (const cmd of ['engine', 'api']) { children.push(spawn(process.execPath, [join(app, 'server', 'main.ts'), cmd], { cwd: app, env, stdio: 'ignore' })); if (cmd === 'engine') await sleep(800) }
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/api/health`)).status === 200) break } catch { /* not up yet */ } await sleep(500) }
  console.log(`Isolated stack in ${dir}: API ${ports.api}, vault service ${ports.rail}; its local chain is reached over a private socket and listens only on a port browsers refuse (F-14)`)
}
const ist = (ms: number): string => new Date(ms + 19_800_000).toISOString().replace('T', ' ').replace('Z', ' IST')
type J = Record<string, any>

function client() {
  let cookie = '', csrf = ''
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: J }> => {
    const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    const json = (await res.json().catch(() => ({}))) as J
    if (typeof json.csrf === 'string') csrf = json.csrf
    return { status: res.status, json }
  }
  return { call, ok: async (method: string, path: string, body?: unknown): Promise<J> => { const r = await call(method, path, body); if (r.status < 200 || r.status > 299) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.json).slice(0, 240)}`); return r.json } }
}
type Client = ReturnType<typeof client>
const me = client()
const passkey = authenticatorFor(ports.api)

interface Step { name: string; expected: string; observed: string; pass: boolean; at: string }
const steps: Step[] = []
function step(name: string, expected: string, observed: string, pass: boolean): void { steps.push({ name, expected, observed, pass, at: ist(Date.now()) }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${observed})`) }
/** Raw units as a human amount: test rupees have 2 decimals, test dollars 6. */
const inr = (raw: unknown): string => (Number(raw ?? 0) / 100).toFixed(2)
const usd = (raw: unknown): string => (Number(raw ?? 0) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')

async function job(c: Client, id: string): Promise<J> { for (let i = 0; i < 240; i++) { const j = await c.ok('GET', `/api/vault/jobs/${id}`); if (j.status !== 'accepted' && j.status !== 'running') return j; await sleep(500) } throw new Error(`job ${id} did not finish`) }
/**
 * Exact terms, the passkey's signature, one execution. Terms that list digests for the chain are signed digest by
 * digest; terms with nothing for the chain (an attack on a throwaway chain) with one signature over the document.
 */
async function act(kind: string, params: J = {}, c: Client = me, auth = passkey): Promise<{ job: J; proposal: J; approvalId: string; signed: number }> {
  const p = await c.ok('POST', '/api/vault/proposals', { kind, params })
  const digests = (p.sign as unknown[]).length
  if (digests) await signVault(c.ok, auth, String(p.approvalId), String(p.docHash))
  else await approve(c.ok, auth, String(p.approvalId), String(p.docHash))
  const a = await c.ok('POST', `/api/vault/proposals/${String(p.proposal.id)}/execute`, { approvalId: p.approvalId })
  return { job: await job(c, String(a.jobId)), proposal: p.proposal as J, approvalId: String(p.approvalId), signed: digests }
}
const outcome = (j: J): string => `${String(j.status)}${j.result ? `: ${String(j.result.outcome)}` : ''}${j.error ? ` (${String(j.error).slice(0, 140)})` : ''}`
/** A fresh household with a passkey whose vault is set up (after a fresh passkey confirmation) and not yet accepted. */
async function household(c: Client, auth: ReturnType<typeof authenticatorFor>, handle: string): Promise<J> {
  await signUp(c.ok, auth, handle, handle)
  await c.ok('POST', '/api/household', {})
  await stepUp(c.ok, auth)
  return c.ok('POST', '/api/vault/setup', { origin })
}

let firstProposal = '', firstApproval = ''
let v: J = {}
try {
  const ws = await household(me, passkey, 'vault-owner')
  v = await me.ok('GET', '/api/vault')
  step('the vault service answers through QED\'s API', 'available, multi-tenant, and this household has a vault', `available ${String(v.available)}; mode ${String(v.health?.mode)}; set up ${String(v.setUp)}; ${String(v.health?.network ?? v.reason ?? '')}`, v.available === true && v.health?.mode === 'multi-tenant' && v.setUp === true)
  step('setting up the vault: an owner account whose one signer is this passkey', 'awaiting acceptance; a passkey account; one signer, this passkey; signatures from this origin', `status ${String(ws.status)}; owner ${String(ws.ownerKind)} ${String(ws.ownerAccount).slice(0, 10)}…; signers ${(v.passkeys as J[]).filter((p) => p.signer).length} of ${(v.passkeys as J[]).length}; threshold ${String(ws.threshold)}; origin ${String(v.origin)}`,
    ws.status === 'awaiting-acceptance' && ws.ownerKind === 'passkey-account' && (v.passkeys as J[]).length === 1 && (v.passkeys as J[])[0]!.signer === true && ws.threshold === 1 && v.origin === origin)

  const acc = await act('provision')
  v = await me.ok('GET', '/api/vault')
  step('accepting the vault: the passkey signs the owner account\'s digest of the two acceptOwnership calls', 'executed with one passkey signature; the opening grant of 1,00,000.00 tINR arrives only now', `${outcome(acc.job)}; ${acc.signed} digest signed; treasury ${inr(v.state.treasury.balance)} ${String(v.state.treasury.token)}`, acc.job.result?.outcome === 'executed' && acc.signed === 1 && v.state.treasury.balance === '10000000' && v.state.treasury.token === 'tINR')

  // Sized for a tINR vault: a standing policy's tranche is 200 to 2,000 tINR there, so a mandate of 25 would leave it nothing to do.
  const m = await act('mandate', { maxPerPayment: '250', maxPerPeriod: '600', maxTotal: '2000', validDays: 7 })
  v = await me.ok('GET', '/api/vault')
  step('signing a mandate', 'executed; an active mandate of 250 a payment, 600 a day, 2,000 in all, signed by the passkey through the owner account (ERC-1271)', `${outcome(m.job)}; version ${String(v.state.mandate?.version)}, ${inr(v.state.mandate?.fields.maxPerPayment)} / ${inr(v.state.mandate?.fields.maxPerPeriod)} / ${inr(v.state.mandate?.fields.maxTotal)} tINR; ${m.signed} digest signed`,
    m.job.result?.outcome === 'executed' && v.state.mandate?.status === 'active' && v.state.mandate?.fields.maxPerPayment === '25000' && m.signed === 1)
  step('the approval that signed it is on the mandate', 'the mandate carries this approval\'s id', `mandate approval ${String(v.state.mandate?.approvalId).slice(0, 18)}; used ${m.approvalId.slice(0, 18)}`, v.state.mandate?.approvalId === m.approvalId)

  // ---- the treasury beyond conversion: payment, promise, money set aside, the owner's own money, venues
  {
    const t0 = v.state.treasury
    const paid = await act('pay', { payee: 'CloudCo', amount: '3' })
    v = await me.ok('GET', '/api/vault')
    firstProposal = String(paid.proposal.id); firstApproval = paid.approvalId
    step('a payment to the one approved outside payee', 'executed; 3 tINR leaves the treasury', `${outcome(paid.job)}; treasury ${inr(t0.balance)} to ${inr(v.state.treasury.balance)}; transaction ${String(paid.job.result?.tx?.hash ?? '').slice(0, 12)}… in block ${String(paid.job.result?.tx?.block ?? '')}`, paid.job.result?.outcome === 'executed' && BigInt(t0.balance) - BigInt(v.state.treasury.balance) === 300n)
    const stranger = await me.call('POST', '/api/vault/proposals', { kind: 'pay', params: { payee: 'Somebody Else', amount: '1' } })
    step('a payment to a name that is not in the owner\'s book', 'refused before any terms exist', `${stranger.status} ${String(stranger.json.error?.code ?? '')}`, stranger.status === 422 && stranger.json.error?.code === 'unknown_payee')
    const promised = await act('pay', { payee: 'CloudCo', amount: '2', dueInDays: 30 })
    const held = await act('ring-fence', { creditor: 'CloudCo', amount: '4', dueInDays: 30 })
    const t1 = (await me.ok('GET', '/api/vault')).state.treasury
    const ls = (await me.ok('GET', '/api/vault/liabilities')).liabilities as J[]
    const open = ls.filter((l) => l.status === 'open')
    step('a payment promised for a later day, and money the owner sets aside for a creditor', 'both executed; two open promises of 2 and 4 tINR; 6 tINR no longer free; nothing has left', `${outcome(promised.job)}; ${outcome(held.job)}; open ${open.map((l) => `${inr(l.amount)} due ${String(l.dueAt)}`).join(', ')}; ring-fenced ${inr(t1.ringFenced)}; balance ${inr(t1.balance)}`,
      promised.job.result?.outcome === 'executed' && held.job.result?.outcome === 'executed' && open.length === 2 && BigInt(t1.ringFenced) === 600n && t1.balance === v.state.treasury.balance)
    // What a payment may be, as a read. The payment of 3 and the promise of 2 count against the co-signer's allowance; the owner's own ring-fence does not.
    const room = await me.ok('GET', '/api/vault/payment-limits')
    const over = await me.ok('GET', '/api/vault/payment-limits?amount=5.01')
    const budgetAfter = ((await me.ok('GET', '/api/vault/quota')).classes as J[]).map((c) => Number(c.used)).join(',')
    const again2 = await me.ok('GET', '/api/vault/payment-limits')
    const budgetLater = ((await me.ok('GET', '/api/vault/quota')).classes as J[]).map((c) => Number(c.used)).join(',')
    step('what a payment may be, read without preparing anything', '5 of the co-signer\'s 10 tINR left; 5 is the most payable; one unit more is refused; reading uses none of the service\'s budget', `left ${inr(room.earned?.remaining)} of ${inr(room.earned?.limit)}; most ${inr(room.maximum)}; 5.01 allowed ${String(over.allowed)}; budget ${budgetAfter} then ${budgetLater}`,
      room.earned?.remaining === '500' && room.earned?.used === '500' && room.maximum === '500' && room.allowed === true && over.allowed === false && again2.maximum === room.maximum && budgetAfter === budgetLater)
    const early = await me.ok('POST', `/api/vault/liabilities/${String(open[0]!.id)}/settle`, { key: `journey-${randomBytes(8).toString('hex')}` })
    const ej = await job(me, String(early.jobId))
    step('paying a promise before it is due', 'refused; nothing sent', outcome(ej), ej.result?.outcome === 'refused')
    const outJ = await act('withdraw', { amount: '5' })
    const mid = (await me.ok('GET', '/api/vault')).state.treasury
    const back = await act('deposit', { amount: '5' })
    const t2 = (await me.ok('GET', '/api/vault')).state.treasury
    const tooMuch = await act('withdraw', { amount: '100000000' })
    step('the owner\'s own money out and back in; more than is free is refused', '5 tINR out to the owner account, 5 back, and the oversized withdrawal sends nothing', `withdraw ${outcome(outJ.job)} (${inr(t1.balance)} to ${inr(mid.balance)}); deposit ${outcome(back.job)} (${inr(t2.balance)}); oversized ${outcome(tooMuch.job)}`,
      outJ.job.result?.outcome === 'executed' && back.job.result?.outcome === 'executed' && BigInt(t1.balance) - BigInt(mid.balance) === 500n && t2.balance === t1.balance && tooMuch.job.result?.outcome !== 'executed')
    // Naming venues is a guarded call of the owner account: it is scheduled behind the delay, not run at once.
    const fewer = await act('venues', { venues: [0, 1, 2] })
    const sched = ((await me.ok('GET', '/api/vault/scheduled')).scheduled as J[])
    const pending = sched.find((c) => c.status === 'pending' && c.kind === 'venues')
    const namedMeanwhile = ((await me.ok('GET', '/api/vault')).state.venues as J[]).length
    const cancel = pending ? await act('cancel-change', { changeId: pending.changeId }) : null
    const after = ((await me.ok('GET', '/api/vault/scheduled')).scheduled as J[]).find((c) => c.changeId === pending?.changeId)
    step('naming a smaller venue set waits out the owner account\'s delay, and one passkey cancels it', 'scheduled, not run; five venues still named meanwhile; one passkey signature cancels it; still five named', `${outcome(fewer.job)}; change ${String(pending?.changeId ?? 'none').slice(0, 12)}… ready ${String(pending?.readyTime ?? '')}; named meanwhile ${namedMeanwhile}; cancel ${cancel ? outcome(cancel.job) : 'not tried'}; change now ${String(after?.status ?? '?')}`,
      fewer.job.result?.outcome === 'scheduled' && !!pending && namedMeanwhile === 5 && cancel?.job.result?.outcome === 'executed' && after?.status === 'cancelled')
    const q = await me.ok('GET', '/api/vault/quota')
    step('the vault service keeps its own budget', 'a count of what was used in the rolling hour, per class', (q.classes as J[]).map((c) => `${String(c.class)} ${String(c.used)}/${String(c.limit)}`).join('; '), Array.isArray(q.classes) && (q.classes as J[]).some((c) => Number(c.used) > 0))
    v = await me.ok('GET', '/api/vault')
  }

  const before = BigInt(v.state.reserve.balance)
  const lim = await me.ok('GET', '/api/vault/limits?amount=10')
  const quote = await me.ok('GET', '/api/vault/quote?amount=10')
  step('a limit check and a quote read without signing anything', 'allowed; expected output and the provable bound', `allowed ${String(lim.allowed)}; expected ${usd(quote.expectedOut)} tUSD, bound ${usd(quote.bound)}, ${String(quote.gapPpm)} ppm apart; source ${String(quote.source?.provider)}`, lim.allowed === true && BigInt(quote.expectedOut ?? 0) > 0n && BigInt(quote.bound ?? 0) >= BigInt(quote.expectedOut ?? 0))
  const c = await act('convert', { amount: '10' })
  v = await me.ok('GET', '/api/vault')
  const gained = BigInt(v.state.reserve.balance) - before
  step('a conversion inside the limits', 'executed in eight steps; the reserve gains what the receipt says', `${outcome(c.job)}; ${c.job.steps.length} steps (${(c.job.steps as J[]).map((s) => String(s.key)).join(', ')}); reserve +${usd(gained)} tUSD; last trade ${usd(v.state.lastTrade?.amountOut)}`,
    c.job.result?.outcome === 'executed' && c.job.steps.length === 8 && gained > 0n && String(gained) === String(v.state.lastTrade?.amountOut))

  const again = await me.call('POST', `/api/vault/proposals/${String(c.proposal.id)}/execute`, { approvalId: c.approvalId })
  v = await me.ok('GET', '/api/vault')
  step('sending the same approved conversion again', 'the same job, and no second conversion', `${again.status}; duplicate ${String(again.json.duplicate)}; job ${again.json.jobId === c.job.id ? 'the same' : 'different'}; reserve still +${usd(BigInt(v.state.reserve.balance) - before)}`, again.json.jobId === c.job.id && again.json.duplicate === true && BigInt(v.state.reserve.balance) - before === gained)

  const big = await act('convert', { amount: '300' })
  step('a conversion above the mandate\'s limit for one payment', 'refused with the rule named; no transaction', `${outcome(big.job)}; proposal allowed ${String(big.proposal.allowed)}; failing rule: ${String((big.proposal.checks as J[]).find((x) => !x.pass)?.rule ?? 'none')}; transaction ${big.job.result?.tx ? 'sent' : 'none'}`, big.job.result?.outcome === 'refused' && big.proposal.allowed === false && !big.job.result?.tx)

  const tBefore = v.state.treasury.balance
  const atk = await act('attack', { kind: 'skim' })
  v = await me.ok('GET', '/api/vault')
  step('an attack that skims the output of a genuine order', 'mined as a revert on a throwaway chain of its own; this vault unchanged', `${outcome(atk.job)}; ${String(atk.job.result?.tx?.status ?? 'no tx')} ${String(atk.job.result?.tx?.error ?? '').slice(0, 60)}; ${String(atk.job.result?.summary ?? '').slice(0, 120)}; treasury ${v.state.treasury.balance === tBefore ? 'unchanged' : 'changed'}`,
    atk.job.result?.outcome === 'reverted' && v.state.treasury.balance === tBefore)

  const pol = await act('policy', { targetFree: '5' })
  // The policy is signed once. From here QED's engine asks the vault service for one tick in every five-minute slot,
  // by itself. This script asks for none and holds no connection open; it only reads until a tick appears.
  {
    const signedAt = Date.now()
    let own: J | null = null
    for (let i = 0; i < 72 && !own; i++) { await sleep(5000); const seen = await me.ok('GET', '/api/vault/policy?limit=5'); own = (seen.ticks as J[] | undefined)?.[0] ?? null }
    const waited = Math.round((Date.now() - signedAt) / 1000)
    const ownJob = own?.jobId ? await job(me, String(own.jobId)) : null
    step('the engine ticks the standing policy by itself, with no request from an interface', 'within one five-minute slot a tick appears that nothing but the engine asked for; it converts a tranche, waits, or finds the target met', own ? `after ${waited} s: tick ${String(own.n ?? '')} ${ownJob ? outcome(ownJob) : ''}; decision "${String(own.action ?? '')}": ${String(own.reason ?? '')}${own.amountIn && own.amountIn !== '0' ? `; tranche ${inr(own.amountIn)} tINR` : ''}${own.limitedBy ? `; limited by ${String(own.limitedBy)}` : ''}` : `no tick after ${waited} s`, !!own && !!ownJob && ownJob.status === 'done')
  }
  const tick = await me.ok('POST', '/api/vault/run/policy-tick', { key: `journey-${randomBytes(8).toString('hex')}` })
  const tj = await job(me, String(tick.jobId))
  const pv = await me.ok('GET', '/api/vault/policy?limit=5')
  step('a standing policy, then one tick under it without a new signature', 'policy active, signed by the passkey through the owner account; the tick converts a tranche, waits, or finds the target met', `${outcome(pol.job)}; ${pol.signed} digest signed; policy ${String(pv.policy?.status)} target ${usd(pv.policy?.targetFree)} tUSD; tick ${outcome(tj)}; decision "${String(pv.ticks?.[0]?.action ?? '')}": ${String(pv.ticks?.[0]?.reason ?? '')}; reserve now ${usd(pv.policy?.reserveFree)} tUSD free`,
    pol.job.result?.outcome === 'executed' && pol.signed >= 1 && pv.policy?.status === 'active' && tj.status === 'done')

  const pause = await act('pause')
  const blocked = await act('convert', { amount: '5' })
  const resume = await act('resume')
  step('pause, try to convert, resume', 'paused; the conversion does not go through; resumed', `pause ${outcome(pause.job)}; conversion while paused ${outcome(blocked.job)}; resume ${outcome(resume.job)}`, pause.job.result?.outcome === 'executed' && blocked.job.result?.outcome !== 'executed' && resume.job.result?.outcome === 'executed')

  // The authority budget (R7 decision D7, the co-signer's check C12 in every owner's vault): a conversion takes only its
  // real cost against the reference, so after the conversions above what is left still pays; beyond it, C12 refuses;
  // a grant signed by the passkey adds to it, reported apart from earnings.
  const a7 = (await me.ok('GET', '/api/vault/payment-limits')).authority as J | undefined
  const converted = BigInt(c.job.result?.evidence?.amountIn ?? 1000) // at least the 10 tINR conversion; tranches add to it
  const small = await act('pay', { payee: 'CloudCo', amount: '1' })
  step('a payment after conversions: they took only their real cost, so a payment within what is left goes through', 'the budget is the authority budget; conversions have taken a small part of what they converted; a 1 tINR payment executes', `rule ${String(a7?.rule)}; available ${inr(a7?.available)} of ${inr(a7?.budget)}; conversions took ${inr(a7?.usedBy?.conversions)} (10 tINR and more converted); payment ${outcome(small.job)}`,
    a7?.rule === 'd7' && BigInt(a7.usedBy.conversions) > 0n && BigInt(a7.usedBy.conversions) < converted && small.job.result?.outcome === 'executed')
  const left = BigInt(((await me.ok('GET', '/api/vault/payment-limits')).authority as J).available)
  const beyond = left + 100n
  const beyondText = `${beyond / 100n}.${String(beyond % 100n).padStart(2, '0')}`
  const tBefore7 = (await me.ok('GET', '/api/vault')).state.treasury.balance
  const over = await act('pay', { payee: 'CloudCo', amount: beyondText })
  step('a payment beyond what the authority budget has left is refused, naming it', 'refused before signing, with the co-signer\'s check C12 named; nothing leaves', `${beyondText} tINR against ${inr(left)} available: ${outcome(over.job)}; ${String(over.job.result?.summary ?? '').slice(0, 160)}`,
    over.job.result?.outcome === 'refused' && /authority budget \(co-signer check C12/.test(String(over.job.result?.summary ?? '')) && (await me.ok('GET', '/api/vault')).state.treasury.balance === tBefore7)
  const g0 = (await me.ok('GET', '/api/vault/payment-limits')).authority as J
  const granted = await act('grant', { amount: '20' })
  const g1 = (await me.ok('GET', '/api/vault/payment-limits')).authority as J
  const tAfterGrant = (await me.ok('GET', '/api/vault')).state.treasury.balance
  step('the owner grants the agent 20 tINR more authority with the passkey', 'executed with one passkey signature through the owner account; granted rises by exactly 20 tINR, earned is unchanged, no money moves', `${outcome(granted.job)}; ${granted.signed} digest signed; granted ${inr(g0.granted)} to ${inr(g1.granted)}; earned ${inr(g0.earned)} to ${inr(g1.earned)}; treasury ${tAfterGrant === tBefore7 ? 'unchanged' : 'changed'}`,
    granted.job.result?.outcome === 'executed' && granted.signed === 1 && BigInt(g1.granted) - BigInt(g0.granted) === 2000n && g1.earned === g0.earned && tAfterGrant === tBefore7)
  const again7 = await act('pay', { payee: 'CloudCo', amount: beyondText })
  step('after the grant the same payment goes through', 'executed; the treasury pays exactly that amount', `${outcome(again7.job)}; treasury ${inr(tAfterGrant)} to ${inr((await me.ok('GET', '/api/vault')).state.treasury.balance)}`,
    again7.job.result?.outcome === 'executed' && BigInt(tAfterGrant) - BigInt((await me.ok('GET', '/api/vault')).state.treasury.balance) === beyond)

  const ver = await me.ok('GET', '/api/vault/decisions-verify')
  step('the vault service re-hashes its decision records', 'chain intact', `ok ${String(ver.ok)}; ${String(ver.records)} records`, ver.ok === true && Number(ver.records) > 5)

  // A second household: its own vault, and no way to reach the first one's.
  const firstBefore = (await me.ok('GET', '/api/vault')).state.treasury.balance
  const other = client(), otherKey = authenticatorFor(ports.api)
  const ows = await household(other, otherKey, `visitor-${randomBytes(3).toString('hex')}`)
  const accepted = await act('provision', {}, other, otherKey)
  const seen = await other.ok('GET', '/api/vault')
  const nameIt = await other.call('GET', `/api/vault/proposals/${firstProposal}`)
  const useIt = await other.call('POST', `/api/vault/proposals/${firstProposal}/execute`, { approvalId: firstApproval })
  const mine = await me.ok('GET', '/api/vault')
  step('another owner of this installation cannot read or use the vault', 'the second household gets its own vault and owner account; naming the first one\'s proposal or approval finds nothing; the first vault is unchanged', `second vault ${String(ows.id).slice(0, 14)}… owner ${String(seen.workspace?.ownerAccount).slice(0, 10)}… (${outcome(accepted.job)}; treasury ${inr(seen.state?.treasury.balance)}); first ${String(mine.workspace?.id).slice(0, 14)}… owner ${String(mine.workspace?.ownerAccount).slice(0, 10)}…; naming its proposal ${nameIt.status} ${String(nameIt.json.error?.code ?? '')}; using its approval ${useIt.status} ${String(useIt.json.error?.code ?? '')}`,
    accepted.job.result?.outcome === 'executed' && seen.workspace?.id !== mine.workspace?.id && seen.workspace?.ownerAccount !== mine.workspace?.ownerAccount && seen.state?.treasury.balance === '10000000' && nameIt.status === 404 && useIt.status === 404 && mine.state?.treasury.balance === firstBefore)
} catch (e) {
  step('the journey ran to the end', 'no exception', e instanceof Error ? e.message : String(e), false)
}
const failed = steps.filter((s) => !s.pass)
writeFileSync(out, `${JSON.stringify({ what: 'QED on-chain vault journey through the backend API: each household\'s vault owned by its passkeys', producedAt: ist(Date.now()), api: base, howToReproduce: 'node scripts/vault-journey.ts --isolated <report.json> (starts its own vault service, chain, engine and API)', passed: steps.length - failed.length, failed: failed.length, steps }, null, 1)}\n`)
console.log(`\n${steps.length - failed.length} passed, ${failed.length} failed. Report: ${out}`)
for (const c of children) c.kill('SIGTERM')
await sleep(1500)
process.exit(failed.length ? 1 : 0)
