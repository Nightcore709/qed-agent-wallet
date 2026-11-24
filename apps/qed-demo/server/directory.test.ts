/**
 * The work directory (R13 E4; server/directory.ts): publishing offers and requests, quoting, comparing and choosing,
 * taking an offer, and the simulated workspaces beyond this installation, which are labelled and can never be chosen.
 * A chosen quote becomes the same draft job on the provider's side as its own form makes (server/earn-chain.ts), which
 * then goes through the escrow steps (server/earn-chain.test.ts, chain/test/escrow-earn.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { chooseQuote, closeListing, directoryView, publishListing, sendQuote, SIMULATED_NOTE, takeOffer } from './directory.ts'
import { beginSignup, finishSignup, type RelyingParty } from './passkeys.ts'
import { type Asker, railSetup } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()
const PROBLEM = { kind: 'custom', assets: [{ name: 'Alpha', volatilityBps: 1500 }, { name: 'Beta', volatilityBps: 3000 }] }
const REQUEST = { kind: 'request', title: 'Lowest-risk sleeve', detail: 'Two assets, certified.', problem: PROBLEM, amount: 30_000, deliverWithinHours: 24 }

beforeAll(async () => { await fake.start() })
afterAll(async () => { await fake.stop() })
beforeEach(() => { fake.reset() })

async function person(db: Db, handle: string, wallet = true): Promise<Asker> {
  const auth = new SoftAuthenticator({ origin: RP.origins[0]! })
  const b = await beginSignup(db, RP, { handle, displayName: handle[0]!.toUpperCase() + handle.slice(1) }, META.ip, T0)
  const r = await finishSignup(db, RP, { challengeId: b.challengeId, response: auth.create(b.options as never), passkeyName: `${handle}'s laptop` }, META, T0)
  const who = { workspaceId: r.personId, personId: r.personId, role: 'owner' as const, session: sessionFor(db, r.session.token, T0)! }
  if (wallet) await railSetup(CFG, db, RP, who, RP.origins[0], T0)
  return who
}
type V = ReturnType<typeof directoryView> & { listings: { id: string; simulated: boolean; by: Record<string, unknown>; yours: boolean; yourQuote: unknown }[]; mine: { id: string; state: string; quotes: { id: string; simulated: boolean; state: string; by: Record<string, unknown>; jobId: string | null }[] }[] }
const view = (db: Db, who: Asker) => directoryView(db, who.workspaceId) as V

describe('the work directory', () => {
  it('publishing: offers and requests of proof-checkable work, from a household with an on-chain wallet; checked before anything is stored', async () => {
    const db = openDb(':memory:')
    const ravi = await person(db, 'ravi'), kiran = await person(db, 'kiran', false)
    expect(() => publishListing(db, ravi.workspaceId, { ...REQUEST, kind: 'barter' }, T0)).toThrow(expect.objectContaining({ fields: expect.objectContaining({ kind: expect.any(String) }) }))
    expect(() => publishListing(db, ravi.workspaceId, { ...REQUEST, amount: 50, deliverWithinHours: 400 }, T0)).toThrow(expect.objectContaining({ fields: expect.objectContaining({ amount: expect.any(String), deliverWithinHours: expect.any(String) }) }))
    expect(() => publishListing(db, ravi.workspaceId, { ...REQUEST, problem: { kind: 'custom', assets: [] } }, T0)).toThrow(/2 to 6 assets/)
    expect(() => publishListing(db, kiran.workspaceId, REQUEST, T0)).toThrow(expect.objectContaining({ code: 'wallet_needed' }))
    const { id } = publishListing(db, ravi.workspaceId, REQUEST, T0)
    expect(db.get('SELECT kind, amount, state FROM directory_listings WHERE id = ?', id)).toEqual({ kind: 'request', amount: 30_000, state: 'open' })
    expect(view(db, kiran).listings.find((l) => l.id === id)).toMatchObject({ by: { handle: 'ravi' }, simulated: false })
  })

  it('a request: quotes from households here, two simulated ones beyond it, compared and one chosen; the job appears on the chosen provider\'s side and the rest are closed', async () => {
    const db = openDb(':memory:')
    const ravi = await person(db, 'ravi'), asha = await person(db, 'asha'), dev = await person(db, 'dev'), meera = await person(db, 'meera')
    const { id } = publishListing(db, ravi.workspaceId, REQUEST, T0)
    // the simulated quotes are labelled, derived from the budget, and cannot be chosen
    const sim = view(db, ravi).mine[0]!.quotes.filter((q) => q.simulated)
    expect(sim.map((q) => q.by.where)).toEqual(['Another QED installation (simulated)', 'Another QED installation (simulated)'])
    expect(() => chooseQuote(db, ravi.workspaceId, sim[0]!.id, T0)).toThrow(SIMULATED_NOTE)
    expect(() => sendQuote(db, ravi.workspaceId, id, { amount: 1000, deliverWithinHours: 2, note: '' }, T0)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => sendQuote(db, asha.workspaceId, 'sim-request-1', { amount: 1000, deliverWithinHours: 2, note: '' }, T0)).toThrow(SIMULATED_NOTE)
    sendQuote(db, asha.workspaceId, id, { amount: 28_000, deliverWithinHours: 12, note: 'First quote.' }, T0 + 1)
    const a = sendQuote(db, asha.workspaceId, id, { amount: 27_500, deliverWithinHours: 12, note: 'Better: same time, a little less.', dispute: { deciderHandle: 'meera' } }, T0 + 2)
    const d = sendQuote(db, dev.workspaceId, id, { amount: 26_000, deliverWithinHours: 48, note: 'Slower and cheaper.' }, T0 + 3)
    const mine = view(db, ravi).mine[0]!
    expect(mine.quotes.filter((q) => !q.simulated).map((q) => [q.by.handle, q.state])).toEqual([['asha', 'open'], ['dev', 'open']])
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'directory-quote'`, ravi.workspaceId)!.n).toBe(3)
    // only the requester chooses, once
    expect(() => chooseQuote(db, dev.workspaceId, a.id, T0)).toThrow(expect.objectContaining({ status: 404 }))
    const { jobId } = chooseQuote(db, ravi.workspaceId, a.id, T0 + 10)
    expect(() => chooseQuote(db, ravi.workspaceId, d.id, T0 + 11)).toThrow(expect.objectContaining({ code: 'closed' }))
    const job = db.get<{ user_id: string; client: string; meta_json: string }>('SELECT user_id, client, meta_json FROM earn_jobs WHERE id = ?', jobId)!
    expect(job).toMatchObject({ user_id: asha.workspaceId, client: '@ravi' })
    expect(JSON.parse(job.meta_json).chain).toMatchObject({ clientWorkspace: ravi.workspaceId, problem: PROBLEM, from: { directory: id }, dispute: { deciderWorkspace: meera.workspaceId, deciderHandle: 'meera', reviewSeconds: 7 * 86_400 } })
    expect(db.get('SELECT amount, state FROM earn_milestones WHERE job_id = ?', jobId)).toEqual({ amount: 27_500, state: 'chain-draft' })
    const after = view(db, ravi).mine[0]!
    expect(after.state).toBe('closed')
    expect(after.quotes.map((q) => [q.by.handle ?? q.by.name, q.state])).toEqual([['asha', 'chosen'], ['dev', 'not-chosen']])
    expect(after.quotes[0]!.by).toMatchObject({ handle: 'asha', name: 'Asha' }) // named to the client once chosen
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM notices WHERE user_id = ? AND kind = 'directory-chosen'`, asha.workspaceId)!.n).toBe(1)
  })

  it('an offer: another household takes it at its price; the offering household gets the job; a simulated offer cannot be taken; a closed listing takes nothing more', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    const { id } = publishListing(db, asha.workspaceId, { ...REQUEST, kind: 'offer', title: 'Certified weights, any two assets', amount: 20_000, deliverWithinHours: 6 }, T0)
    expect(() => takeOffer(db, asha.workspaceId, id, T0)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => takeOffer(db, ravi.workspaceId, 'sim-offer-1', T0)).toThrow(SIMULATED_NOTE)
    expect(() => sendQuote(db, ravi.workspaceId, id, { amount: 1000, deliverWithinHours: 2, note: '' }, T0)).toThrow(expect.objectContaining({ code: 'not_a_request' }))
    const { jobId } = takeOffer(db, ravi.workspaceId, id, T0 + 1)
    expect(db.get('SELECT user_id FROM earn_jobs WHERE id = ?', jobId)).toEqual({ user_id: asha.workspaceId })
    expect(db.get('SELECT amount FROM earn_milestones WHERE job_id = ?', jobId)).toEqual({ amount: 20_000 })
    closeListing(db, asha.workspaceId, id, T0 + 2)
    expect(() => takeOffer(db, ravi.workspaceId, id, T0 + 3)).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(view(db, ravi).listings.filter((l) => l.simulated).length).toBe(3)
  })
})
