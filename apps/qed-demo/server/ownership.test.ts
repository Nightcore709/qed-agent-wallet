/**
 * Ownership transfer and a creditor's release or assignment from the Vault screen (R13 S5; server/ownership.ts), against
 * the recording stand-in of the vault service (server/rail-fake.ts). The chain side, with the owner account's delay, the
 * cancellation and the two-step acceptance, is chain/test/ownership.test.ts. Here: the other household is named by its
 * handle and resolved to its account, never typed as an address; what each request asks the vault service for; the
 * view's names; and the refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sessionFor } from './auth.ts'
import { openDb } from './core.ts'
import { ownershipView, proposeAccept, proposeAssign, proposePromise, proposeRelease, proposeTransfer } from './ownership.ts'
import { beginSignup, finishSignup, type RelyingParty } from './passkeys.ts'
import { type Asker, railSetup, railWorkspaceId } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { SoftAuthenticator } from './softauthn.ts'

const RP: RelyingParty = { id: 'localhost', name: 'QED', origins: ['http://localhost:5175'] }
const META = { ip: '127.0.0.1', ua: 'Mozilla/5.0 test' }
const T0 = Date.UTC(2026, 10, 24, 9, 0)
const CFG = { dbPath: '/nowhere/qed.db' }
type Db = ReturnType<typeof openDb>
const fake = new FakeRail()

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
const ws = (who: Asker) => fake.workspaces.get(railWorkspaceId(who.workspaceId))!

describe('ownership and claims from the Vault screen', () => {
  it('a transfer names the other household by handle and asks the vault service for exactly its account; self, unknown and walletless are refused alike', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), kiran = await person(db, 'kiran', false)
    await expect(proposeTransfer(CFG, db, asha, { handle: 'asha' }, T0)).rejects.toMatchObject({ code: 'same_household' })
    const nobody = await proposeTransfer(CFG, db, asha, { handle: 'nobody' }, T0).catch((e) => e)
    const walletless = await proposeTransfer(CFG, db, asha, { handle: '@kiran' }, T0).catch((e) => e)
    expect([nobody.code, nobody.message]).toEqual([walletless.code, walletless.message])
    await expect(proposeTransfer(CFG, db, asha, { handle: 'ravi', newOwner: '0x0' }, T0)).rejects.toMatchObject({ code: 'invalid' })
    const p = await proposeTransfer(CFG, db, asha, { handle: '@Ravi' }, T0)
    expect(fake.proposed('transfer-ownership').map((x) => [x.ws, x.params])).toEqual([[ws(asha).id, { newOwner: ws(ravi).ownerAccount }]])
    expect(JSON.parse(db.get<{ document: string }>('SELECT document FROM approvals WHERE id = ?', String(p.approvalId))!.document).ownership).toEqual({ to: '@ravi', what: 'both vaults of this wallet, with everything in them' })
    void kiran
  })

  it('a creditor releases a claim, or assigns it to its own vault or another household; a promise to another household names its account', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi'), meera = await person(db, 'meera')
    const vault = `0x${'ab'.repeat(20)}`
    await expect(proposeRelease(CFG, db, ravi, { vault, liabilityId: 'x' }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await proposeRelease(CFG, db, ravi, { vault, liabilityId: '3' }, T0)
    await proposeAssign(CFG, db, ravi, { vault, liabilityId: '3', to: 'my-vault' }, T0)
    await proposeAssign(CFG, db, ravi, { vault, liabilityId: '3', to: 'meera' }, T0)
    expect(fake.proposed('release-claim').map((x) => x.params)).toEqual([{ vault, liabilityId: '3' }])
    expect(fake.proposed('assign-claim').map((x) => x.params.newCreditor)).toEqual([ws(ravi).vault, ws(meera).ownerAccount])
    await expect(proposePromise(CFG, db, asha, { handle: 'ravi', amount: '0', dueInDays: 30 }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await expect(proposePromise(CFG, db, asha, { handle: 'ravi', amount: '50', dueInDays: 0 }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await proposePromise(CFG, db, asha, { handle: 'ravi', amount: '50.25', dueInDays: 30 }, T0)
    expect(fake.proposed('ring-fence').map((x) => x.params)).toEqual([{ creditor: ws(ravi).ownerAccount, amount: '50.25', dueInDays: 30 }])
    await expect(proposeAccept(CFG, db, ravi, { vault: 'nope' }, T0)).rejects.toMatchObject({ code: 'invalid' })
    await proposeAccept(CFG, db, ravi, { vault }, T0)
    expect(fake.proposed('accept-ownership').map((x) => x.params)).toEqual([{ vault }])
  })

  it('the view: an offer this household made is shown by the handle it went to; who offered a wallet or owes money is shown by name', async () => {
    const db = openDb(':memory:')
    const asha = await person(db, 'asha'), ravi = await person(db, 'ravi')
    fake.ownership.set(ws(asha).id, { delaySeconds: 60, mine: [{ vault: ws(asha).vault, which: 'treasury', owner: ws(asha).ownerAccount, pendingOwner: ws(ravi).ownerAccount, pendingWorkspace: ws(ravi).id, ownedByThisAccount: true, ownerWorkspace: ws(asha).id }], offeredToMe: [], ownedHere: [] })
    fake.ownership.set(ws(ravi).id, { delaySeconds: 60, mine: [], offeredToMe: [{ vault: ws(asha).vault, which: 'treasury', fromWorkspace: ws(asha).id, owner: ws(asha).ownerAccount, balance: '500000' }], ownedHere: [] })
    fake.claims.set(ws(ravi).id, [{ vault: ws(asha).vault, which: 'treasury', debtorWorkspace: ws(asha).id, liabilityId: '1', creditor: ws(ravi).ownerAccount, amount: '5000', dueAt: 1_800_000_000, status: 'open', due: false, mine: true, assignedTo: null }])
    const a = await ownershipView(CFG, db, asha) as { delaySeconds: number; mine: { offeredTo: unknown; ownedByYou: boolean }[] }
    expect(a).toMatchObject({ delaySeconds: 60, mine: [{ ownedByYou: true, offeredTo: { handle: 'ravi' } }] })
    expect(JSON.stringify(a.mine)).not.toMatch(/Ravi/)
    const r = await ownershipView(CFG, db, ravi) as { offeredToYou: { from: unknown }[]; claims: { debtor: unknown; yours: boolean; amount: string }[] }
    expect(r.offeredToYou[0]!.from).toEqual({ name: 'Asha', handle: 'asha' })
    expect(r.claims[0]).toMatchObject({ debtor: { name: 'Asha', handle: 'asha' }, yours: true, amount: '5000' })
  })
})
