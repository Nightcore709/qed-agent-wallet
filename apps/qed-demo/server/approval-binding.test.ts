/**
 * What an owner's passkey signature on an approval covers (R7-072). The passkey signs a challenge made from the
 * approval's id and the hash of its document (server/passkeys.ts approvalChallenge; the API accepts no other way to
 * confirm, server/api.ts), and the action that runs is read from that same document after its hash is checked again
 * (server/owner.ts submitApprovedAction). So a term is bound exactly when the document states it. One test per term:
 * a different value gives a different document hash, hence a different challenge, so a signature over the first covers
 * nothing else; and editing the stored document after it was signed stops the action before anything is created.
 *
 * Scope: the paper household, where the server is the authority; a process that can rewrite both the document and its
 * hash in the database is not stopped by this check. On the on-chain wallet the contract checks the passkey over its
 * own digests (R7-071), which a server or database compromise cannot satisfy.
 */
import { describe, expect, it } from 'vitest'
import { confirmApproval } from './approvals.ts'
import { previewAction, submitApprovedAction } from './owner.ts'
import { approvalChallenge } from './passkeys.ts'
import { type Kit, makeKit } from './testkit.ts'

const payee = (k: Kit, handle: string, name: string): string => {
  const id = `pay_${handle.replace(/\W/g, '')}`
  k.db.run('INSERT INTO payees (id, user_id, name, handle, category, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, k.userId, name, handle, 'other', k.clock.now(), k.clock.now())
  return id
}
const actions = (k: Kit) => k.db.get<{ n: number }>('SELECT COUNT(*) n FROM actions')!.n
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
type Doc = { action: { kind: string; venue: string; params: Record<string, unknown> }; estimate: { label: string; value: string }[]; quote?: { validUntil: number } }

describe('a passkey signature on a payment covers each of its terms (R7-072)', () => {
  const setup = () => {
    const k = makeKit()
    return { k, meera: payee(k, 'meera.nair@upi', 'Meera Nair'), shop: payee(k, 'shop@upi', 'A shop') }
  }
  const terms = { kind: 'payment', amount: 250_000, purpose: 'spend', memo: 'Rent for November' }

  it('the document names the operation, the amount, the recipient by name and address, the note, the purpose, the venue and what leaves the account', async () => {
    const { k, meera } = setup()
    const pv = await previewAction(k.ctx, k.userId, { ...terms, payeeId: meera })
    const d = JSON.parse(pv.document) as Doc
    expect(d.action).toMatchObject({ kind: 'payment', venue: 'paper-rail', params: { amount: '250000', payeeHandle: 'meera.nair@upi', payeeName: 'Meera Nair', memo: 'Rent for November', purpose: 'spend' } })
    expect(d.estimate.find((e) => /leaves/i.test(e.label))?.value).toBe('₹2,500.00')
  })

  it.each([
    ['the amount', { amount: 250_100 }],
    ['the recipient', { payeeId: 'shop' }],
    ['the note', { memo: 'Rent for December' }],
  ])('a different %s gives a different document hash, so a signature over the first covers nothing else', async (_, change) => {
    const { k, meera, shop } = setup()
    const first = await previewAction(k.ctx, k.userId, { ...terms, payeeId: meera })
    const other = await previewAction(k.ctx, k.userId, { ...terms, payeeId: meera, ...change, ...('payeeId' in change ? { payeeId: shop } : {}) })
    expect(other.docHash).not.toBe(first.docHash)
    expect(hex(approvalChallenge(first.approvalId, other.docHash))).not.toBe(hex(approvalChallenge(first.approvalId, first.docHash)))
    // the server holds the first document: confirming it with the other's hash is refused
    expect(() => confirmApproval(k.db, k.userId, first.approvalId, { method: 'passkey', docHash: other.docHash }, k.clock.now())).toThrow(/does not match/)
  })

  const edits: [string, (d: Doc) => void][] = [
    ['the amount', (d) => { d.action.params.amount = '2500000' }],
    ['the recipient\'s address', (d) => { d.action.params.payeeHandle = 'attacker@upi' }],
    ['the recipient\'s name', (d) => { d.action.params.payeeName = 'Someone else' }],
    ['the note', (d) => { d.action.params.memo = 'Changed' }],
    ['the purpose', (d) => { d.action.params.purpose = 'card' }],
    ['the venue', (d) => { d.action.venue = 'paper-crypto' }],
    ['the operation', (d) => { d.action.kind = 'order' }],
    ['what leaves the account', (d) => { d.estimate[0]!.value = '₹1.00' }],
  ]
  it.each(edits)('editing %s in the stored document after it was signed stops the payment; nothing is created', async (_, edit) => {
    const { k, meera } = setup()
    const pv = await previewAction(k.ctx, k.userId, { ...terms, payeeId: meera })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const d = JSON.parse(pv.document) as Doc
    edit(d)
    k.db.run('UPDATE approvals SET document = ? WHERE id = ?', JSON.stringify(d), pv.approvalId)
    expect(() => submitApprovedAction(k.ctx, k.userId, pv.approvalId)).toThrow(/does not match its hash/)
    expect(actions(k)).toBe(0)
  })

  it('the same document, unedited, creates its payment once (the control for the cases above)', async () => {
    const { k, meera } = setup()
    const pv = await previewAction(k.ctx, k.userId, { ...terms, payeeId: meera })
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const first = submitApprovedAction(k.ctx, k.userId, pv.approvalId)
    // sent again before it runs, it returns the payment that exists (after it runs, server/execute.test.ts: "already been used")
    expect(submitApprovedAction(k.ctx, k.userId, pv.approvalId).id).toBe(first.id)
    expect(actions(k)).toBe(1)
  })
})

describe('a passkey signature on an order covers the asset, side, amount and the quote\'s expiry (R7-072)', () => {
  const order = { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: 500_000 }

  it('the document names the asset, the side, the amount and until when its price holds', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, order)
    const d = JSON.parse(pv.document) as Doc
    expect(d.action).toMatchObject({ kind: 'order', params: { instrumentId: 'coindcx:BTCINR', side: 'buy', amount: '500000' } })
    expect(d.quote?.validUntil).toBe(pv.expiresAt)
  })

  const edits: [string, (d: Doc) => void][] = [
    ['the asset', (d) => { d.action.params.instrumentId = 'coindcx:ETHINR' }],
    ['the side', (d) => { d.action.params.side = 'sell' }],
    ['the amount', (d) => { d.action.params.amount = '5000000' }],
    ['the quote\'s expiry', (d) => { d.quote!.validUntil += 3_600_000 }],
    ['the slippage it tolerates', (d) => { d.action.params.maxSlippageBps = 500 }],
  ]
  it.each(edits)('editing %s after it was signed stops the order; nothing is created', async (_, edit) => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, order)
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const d = JSON.parse(pv.document) as Doc
    edit(d)
    k.db.run('UPDATE approvals SET document = ? WHERE id = ?', JSON.stringify(d), pv.approvalId)
    expect(() => submitApprovedAction(k.ctx, k.userId, pv.approvalId)).toThrow(/does not match its hash/)
    expect(actions(k)).toBe(0)
  })
})

describe('a passkey signature on a limit order covers its limit price (R7-072)', () => {
  const order = { kind: 'order', instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'limit', amount: 500_000, limitPrice: '6500000' }
  it('the document names the limit price and the slippage tolerated', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, order)
    expect((JSON.parse(pv.document) as Doc).action.params).toMatchObject({ type: 'limit', limitPrice: '6500000', maxSlippageBps: 100 })
  })
  it('editing the limit price after it was signed stops the order; nothing is created', async () => {
    const k = makeKit(); k.btc(6_600_000)
    const pv = await previewAction(k.ctx, k.userId, order)
    confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
    const d = JSON.parse(pv.document) as Doc
    d.action.params.limitPrice = '9900000'
    k.db.run('UPDATE approvals SET document = ? WHERE id = ?', JSON.stringify(d), pv.approvalId)
    expect(() => submitApprovedAction(k.ctx, k.userId, pv.approvalId)).toThrow(/does not match its hash/)
    expect(actions(k)).toBe(0)
  })
})
