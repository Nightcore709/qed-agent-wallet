/**
 * Work prepared in a session opened with a password says so (RISK-076's last item). A password can be phished and a
 * passkey cannot: a phished password could prepare a payee and a payment that the owner then approves believing it was
 * their own work. Each payee, bill, instruction draft and approval request records how the session that prepared it was
 * opened, and when, from the server's own session record; the document the passkey signs carries a plain sentence for
 * each part prepared in a password session; the approval's view gives those sentences to the approval sheet, which shows
 * them before the passkey is asked; and the approval's record keeps them. Work prepared with a passkey reads as before.
 *
 * Over HTTP against the real API server (and a recording stand-in of the vault service), except the last test, which
 * drives the engine's own run planning with the test kit.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inrExact } from '../shared/money.ts'
import { startApi } from './api.ts'
import { confirmApproval } from './approvals.ts'
import { loadConfig } from './core.ts'
import { assembleCase } from './evidence.ts'
import { verifyCase } from './evidence-verify.ts'
import { stepAllActions } from './execute.ts'
import { addBill, addPayee } from './owner.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { FakeRail } from './rail-fake.ts'
import { sha256hex } from './receipts.ts'
import { requestRunApproval, runTick, schedulerTick, triggerTick } from './runner.ts'
import { makeKit } from './testkit.ts'
import { actor } from './workspaces.ts'
import { applyDueChanges, PROTECTION_DELAY_MS } from './passkeys.ts'
import { approve, authenticatorFor, signIn, stepUp } from '../scripts/lib/passkey-client.ts'

type J = Record<string, any>
// A port of its own for each run: suites in other worktrees run the same files at the same time (a fixed port let one run's
// requests reach another's server). Was 9437.
const PORT = 20000 + Math.floor(Math.random() * 20000)
const PW = 'a long enough pass phrase for this test'
const DAY = 86_400_000
const fake = new FakeRail()

/** "14:02 IST on 23 Nov 2026", worked out here apart from the server's own formatter. */
function atIst(ms: number): string {
  const t = new Date(ms + 330 * 60_000), p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getUTCHours())}:${p(t.getUTCMinutes())} IST on ${t.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]} ${t.getUTCFullYear()}`
}

describe('work prepared in a password session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qed-prepared-'))
  let api: ReturnType<typeof startApi>
  beforeAll(async () => {
    await fake.start()
    api = startApi(loadConfig({ QED_DB: join(dir, 'qed.db'), QED_API_PORT: String(PORT) }))
  })
  afterAll(async () => { api.close(); await fake.stop(); rmSync(dir, { recursive: true, force: true }) })
  function client() {
    let cookie = '', csrf = ''
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-qed-client': 'web', 'x-qed-csrf': csrf } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) })
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]!
      const json = (await res.json().catch(() => ({}))) as J
      if (typeof json.csrf === 'string') csrf = json.csrf
      return { status: res.status, json }
    }
    return { call, ok: async (m: string, p: string, b?: unknown) => { const r = await call(m, p, b); if (r.status >= 300) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`); return r.json } }
  }
  const doc = (r: J): J => JSON.parse(String(r.document)) as J
  const row = (kind: string, subject: string) => api.ctx.db.get<{ method: string; at: number; person_id: string; workspace_id: string }>('SELECT method, at, person_id, workspace_id FROM prepared WHERE kind = ? AND subject = ?', kind, subject)
  /** An account opened with a password that then added a passkey, with one session opened each way. */
  async function account(handle: string, name: string) {
    const first = client(), key = authenticatorFor(PORT)
    const made = await first.ok('POST', '/api/auth/signup', { handle, password: PW, displayName: name })
    const b = await first.ok('POST', '/api/security/passkeys/begin')
    await first.ok('POST', '/api/security/passkeys/finish', { challengeId: b.challengeId, response: key.create(b.options) })
    const pk = client(); await signIn(pk.ok, key)
    const pw = client(); await pw.ok('POST', '/api/auth/login', { handle, password: PW })
    return { userId: String(made.userId), key, pk, pw }
  }

  it('a payee, a payment, a bill and an instruction draft prepared in a password session say so in what the passkey signs; the same work prepared with a passkey reads as before', async () => {
    const { userId, key, pk, pw } = await account('prep-a', 'Prepared Person')
    expect([(await pk.ok('GET', '/api/session')).authMethod, (await pw.ok('GET', '/api/session')).authMethod]).toEqual(['passkey', 'password'])
    await pk.ok('POST', '/api/household', { opening: { bank: 90_000_000 }, profile: { income: 18_000_000 } })

    // A payee from each kind of session: each records the session's method and the time, for the person who acted.
    const look = await pw.ok('POST', '/api/payees', { name: 'Look Alike', handle: 'look.alike@upi', category: 'other', nameCheckAccepted: 'unknown' })
    const shop = await pk.ok('POST', '/api/payees', { name: 'Corner Shop', handle: 'corner.shop@upi', category: 'other', nameCheckAccepted: 'unknown' })
    const lookRow = row('payee', String(look.id))!, shopRow = row('payee', String(shop.id))!
    expect([lookRow.method, lookRow.person_id, lookRow.workspace_id, shopRow.method]).toEqual(['password', userId, userId, 'passkey'])
    const payeeLine = `The payee Look Alike (look.alike@upi) was added in a password session at ${atIst(lookRow.at)}, not with a passkey.`
    // The passkey holder is told, in the account's security history; a payee added with the passkey tells nothing.
    const told = ((await pk.ok('GET', '/api/security')).events as J[]).filter((e) => e.kind === 'payee-added-in-password-session')
    expect(told.map((e) => [e.detail.payee, e.detail.at])).toEqual([['Look Alike (look.alike@upi)', lookRow.at]])

    // A payment prepared in the password session: the request and its payee, in the document and in the approval's view.
    const asked = await pw.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: look.id, amount: 50_000 })
    const requestLine = `Prepared in a password session at ${atIst(row('approval', String(asked.approvalId))!.at)}, not with a passkey.`
    expect(doc(asked).prepared).toEqual([requestLine, payeeLine])
    expect((await pk.ok('GET', `/api/approvals/${String(asked.approvalId)}`)).prepared).toEqual([requestLine, payeeLine])

    // The owner prepares a payment to the same payee with the passkey: the payee's sentence only. Signed and carried
    // out, the approval's record keeps it.
    const mine = await pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: look.id, amount: 40_000 })
    expect(doc(mine).prepared).toEqual([payeeLine])
    await approve(pk.ok, key, String(mine.approvalId), String(mine.docHash))
    await pk.ok('POST', '/api/actions', { approvalId: mine.approvalId })
    const kept = api.ctx.db.get<{ document: string; method: string }>('SELECT document, method FROM approvals WHERE id = ?', String(mine.approvalId))!
    expect([JSON.parse(kept.document).prepared, kept.method]).toEqual([[payeeLine], 'passkey'])

    // To a payee added with the passkey: the document is as it was before, and the view says nothing.
    const plain = await pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: shop.id, amount: 30_000 })
    expect('prepared' in doc(plain)).toBe(false)
    expect((await pk.ok('GET', `/api/approvals/${String(plain.approvalId)}`)).prepared).toEqual([])

    // A bill added in the password session, paid by hand with the passkey.
    const bill = await pw.ok('POST', '/api/bills', { payeeId: shop.id, amount: 61_200, dueAt: Date.now() + 2 * DAY, memo: 'Arrears' })
    expect(row('bill', String(bill.id))!.method).toBe('password')
    const billLine = `The bill "Arrears" for ${inrExact(61_200)} to Corner Shop was added in a password session at ${atIst(row('bill', String(bill.id))!.at)}, not with a passkey.`
    const payBill = await pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', billId: bill.id, amount: 61_200 })
    expect(doc(payBill).prepared).toEqual([billLine])

    // An instruction drafted in the password session, sent for approval, signed with the passkey and put in force: the
    // draft and the payee it names are said in what was signed, and the live version keeps it.
    const draft = await pw.ok('POST', '/api/programs', { kind: 'bills', params: { payeeHandles: ['look.alike@upi', 'corner.shop@upi'], capPerBill: 300_000, leadMinutes: 0 }, authority: { expiresAt: Date.now() + 30 * DAY, runMode: 'notify', noticeSec: 3600, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const draftLine = `This draft was saved in a password session at ${atIst(row('program-version', `${String(draft.programId)}@1`)!.at)}, not with a passkey.`
    const sent = await pk.ok('POST', `/api/programs/${String(draft.programId)}/approval`, {})
    expect(doc(sent).prepared).toEqual([draftLine, payeeLine])
    expect(sent.doc.prepared).toEqual([draftLine, payeeLine])
    await approve(pk.ok, key, String(sent.approvalId), String(sent.docHash))
    await pk.ok('POST', `/api/programs/${String(draft.programId)}/activate`, { approvalId: sent.approvalId })
    const live = api.ctx.db.get<{ document: string }>(`SELECT document FROM program_versions WHERE program_id = ? AND state = 'live'`, String(draft.programId))!
    expect(JSON.parse(live.document).prepared).toEqual([draftLine, payeeLine])

    // The same instruction drafted with the passkey: nothing new in what is signed.
    const own = await pk.ok('POST', '/api/programs', { kind: 'bills', params: { payeeHandles: ['corner.shop@upi'], capPerBill: 300_000, leadMinutes: 0 }, authority: { expiresAt: Date.now() + 30 * DAY, runMode: 'notify', noticeSec: 3600, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const ownSent = await pk.ok('POST', `/api/programs/${String(own.programId)}/approval`, {})
    expect('prepared' in doc(ownSent)).toBe(false)
  }, 30_000)

  it('the record comes from the session, never from the request, and is never changed or removed', async () => {
    const { pk, pw } = await account('prep-b', 'Careful Person')
    await pk.ok('POST', '/api/household', { opening: { bank: 90_000_000 } })
    // Whatever a request says about itself is ignored.
    const y = await pw.ok('POST', '/api/payees', { name: 'Claims Passkey', handle: 'claims.passkey@upi', category: 'other', authMethod: 'passkey', method: 'passkey', prepared: [], nameCheckAccepted: 'unknown' })
    expect(row('payee', String(y.id))!.method).toBe('password')
    const p = await pw.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 10_000, prepared: [], authMethod: 'passkey' })
    expect(doc(p).prepared).toHaveLength(2)
    const q = await pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 10_000, prepared: ['Prepared with a passkey.'] })
    expect(doc(q).prepared).toEqual([expect.stringMatching(/^The payee Claims Passkey \(claims\.passkey@upi\) was added in a password session at /)])
    // Written once: neither changed nor removed afterwards.
    expect(() => api.ctx.db.run(`UPDATE prepared SET method = 'passkey' WHERE subject = ?`, String(y.id))).toThrow(/append-only/)
    expect(() => api.ctx.db.run('DELETE FROM prepared WHERE subject = ?', String(y.id))).toThrow(/append-only/)
    expect(row('payee', String(y.id))!.method).toBe('password')
  }, 30_000)

  it('a request to the on-chain wallet prepared in a password session says so in its document; one prepared with a passkey does not', async () => {
    const { key, pk, pw } = await account('prep-c', 'Wallet Person')
    await stepUp(pk.ok, key)
    await pk.ok('POST', '/api/vault/setup', { origin: `http://localhost:${PORT}` })
    const a = await pw.ok('POST', '/api/vault/proposals', { kind: 'pay', params: { payee: 'CloudCo', amount: '3' } })
    const line = `Prepared in a password session at ${atIst(row('approval', String(a.approvalId))!.at)}, not with a passkey.`
    const seen = await pk.ok('GET', `/api/approvals/${String(a.approvalId)}`)
    expect([doc(seen).prepared, seen.prepared]).toEqual([[line], [line]])
    const b = await pk.ok('POST', '/api/vault/proposals', { kind: 'pay', params: { payee: 'CloudCo', amount: '3' } })
    const plain = await pk.ok('GET', `/api/approvals/${String(b.approvalId)}`)
    expect(['prepared' in doc(plain), plain.prepared]).toEqual([false, []])
  }, 30_000)

  it('in a business workspace the sentence names the member who prepared it, and every member is told', async () => {
    const boss = await account('prep-boss', 'Bina Boss'), clerk = await account('prep-clerk', 'Kiran Clerk')
    await stepUp(boss.pk.ok, boss.key)
    const ws = await boss.pk.ok('POST', '/api/workspaces', { name: 'Shop books' })
    await boss.pk.ok('POST', `/api/workspaces/${String(ws.id)}/switch`)
    await stepUp(boss.pk.ok, boss.key)
    await boss.pk.ok('POST', '/api/workspace/members', { handle: 'prep-clerk', role: 'admin' })
    // giving a member authority waits out the protection delay (Q-048): applied here as its end would apply it
    applyDueChanges(api.ctx.db, Date.now() + PROTECTION_DELAY_MS + 1000)
    await boss.pk.ok('POST', '/api/household', { opening: { bank: 90_000_000 } })
    await clerk.pw.ok('POST', `/api/workspaces/${String(ws.id)}/switch`)
    const y = await clerk.pw.ok('POST', '/api/payees', { name: 'Supplier', handle: 'supplier@upi', category: 'other', nameCheckAccepted: 'unknown' })
    const r = row('payee', String(y.id))!
    expect([r.method, r.person_id, r.workspace_id]).toEqual(['password', clerk.userId, String(ws.id)])
    const p = await boss.pk.ok('POST', '/api/actions/preview', { kind: 'payment', purpose: 'spend', payeeId: y.id, amount: 20_000 })
    expect(doc(p).prepared).toEqual([`The payee Supplier (supplier@upi) was added by Kiran Clerk (@prep-clerk) in a password session at ${atIst(r.at)}, not with a passkey.`])
    for (const who of [boss, clerk]) {
      const told = ((await who.pk.ok('GET', '/api/security')).events as J[]).filter((e) => e.kind === 'payee-added-in-password-session')
      expect(told.map((e) => [e.detail.payee, e.detail.workspace, e.detail.by])).toEqual([['Supplier (supplier@upi)', 'Shop books', 'prep-clerk']])
    }
  }, 30_000)
})

describe('a run the engine planned', () => {
  it('asks approval for paying a bill added in a password session, says so in what is signed, and the run\'s evidence keeps it', async () => {
    const k = makeKit()
    const as = <T>(authMethod: string, fn: () => T): T => actor.run({ personId: k.userId, workspaceId: k.userId, role: 'owner', authMethod, session: authMethod }, fn)
    const cycle = async (): Promise<void> => { schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx); await stepAllActions(k.ctx); await k.venues.rail.tick(); await stepAllActions(k.ctx); runTick(k.ctx) }
    const power = as('passkey', () => addPayee(k.db, k.userId, { name: 'City Power', handle: 'power@upi', category: 'utility', nameCheckAccepted: 'unknown' }, k.clock.now()))
    // The instruction is drafted in a password session and signed with the passkey: its signed document says so.
    const draftAt = k.clock.now()
    const d = as('password', () => saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: ['power@upi'], capPerBill: 300_000, leadMinutes: 0 }, authority: { expiresAt: k.clock.now() + 30 * DAY, runMode: 'approve', maxPerRun: 300_000, maxPerMonth: 1_000_000 } }))
    const draftLine = `This draft was saved in a password session at ${atIst(draftAt)}, not with a passkey.`
    const req = as('passkey', () => requestProgramApproval(k.ctx, k.userId, d.programId))
    expect((JSON.parse(req.draft.document) as J).prepared).toEqual([draftLine])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'passkey', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, d.programId, req.approvalId)
    // A bill added in a password session falls due; the instruction asks each time.
    const billAt = k.clock.now()
    as('password', () => addBill(k.db, k.userId, { payeeId: power.id, amount: 245_000, dueAt: k.clock.now() + 60_000, memo: 'November' }, billAt))
    for (let t = 0; t < 120_000; t += 5000) { k.clock.advance(5000); await cycle() }
    const run = k.db.get<{ id: string; state: string }>('SELECT id, state FROM runs WHERE program_id = ?', d.programId)!
    expect(run.state).toBe('awaiting_approval')
    // Whoever opens the run's approval, it pays the bill added in a password session, and its document says so.
    const billLine = `The bill "November" for ${inrExact(245_000)} to City Power was added in a password session at ${atIst(billAt)}, not with a passkey.`
    const ask = as('passkey', () => requestRunApproval(k.ctx, k.userId, run.id))
    expect((JSON.parse(ask.document) as J).prepared).toEqual([billLine])
    // and the signed document names, for the action, who is paid, how much, in what, by which route and what follows
    expect((JSON.parse(ask.document) as J).lines).toEqual([{ to: expect.stringMatching(/^City Power \(power@upi\)$/), amount: inrExact(245_000).replace('.00', ''), asset: 'Indian rupees, from your bank account', route: expect.stringMatching(/on the paper bank$/), once: 'It leaves your bank on paper when the run is sent; a payment that has gone is not recalled.' }])
    confirmApproval(k.db, k.userId, ask.approvalId, { method: 'passkey', docHash: ask.docHash }, k.clock.now())
    for (let t = 0; t < 60_000; t += 5000) { k.clock.advance(5000); await cycle() }
    expect(k.db.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id)!.state).toBe('done')
    // The run's evidence keeps both: the instruction's signed document and the run's own signature.
    const c = await assembleCase({ db: k.db, workspaceId: k.userId, vault: null, now: k.clock.now(), ctx: k.ctx }, `run.${run.id}`)
    expect(verifyCase(c)).toMatchObject({ ok: true, failures: [] })
    expect(((c.sections['1'] as J).instruments[0] as J).documentAsSigned.prepared).toEqual([draftLine])
    expect(((c.sections['4'] as J).signaturesUsed as J[]).map((s) => s.prepared ?? null)).toEqual([null, [billLine]])
  })
})
