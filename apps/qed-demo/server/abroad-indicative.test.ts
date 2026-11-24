/**
 * A payment abroad for a workspace that needs several signers (R13 second pass, item 2). Several members cannot sign within a
 * quote's 60 seconds, so such a payment is priced as INDICATIVE, as orders are (owner.ts): the document states an indicative
 * rate and a price band, the members sign that, and when it is sent QED asks the desk for a fresh quote and sends it only if
 * it costs no more than the band's ceiling; otherwise it refuses, and nothing moves. Paper only.
 */
import { describe, expect, it } from 'vitest'
import { addAbroadPayee, INDICATIVE_BAND_BPS, payAbroad, prepareAbroad, reconcileAbroad } from './abroad.ts'
import { confirmApproval, getApproval, MULTI_SIGNER_TTL_MS } from './approvals.ts'
import { balance, verifyLedger } from './ledger.ts'
import { makeKit } from './testkit.ts'

const T1 = Date.parse('2026-11-25T05:00:00Z')
const MIN = 60_000

function setup(signers: number) {
  const k = makeKit({ start: T1 })
  if (signers > 1) k.db.run(`UPDATE users SET kind = 'business', policy_json = ? WHERE id = ?`, JSON.stringify({ signers }), k.userId)
  const p = addAbroadPayee(k.db, k.userId, { name: 'Anita Rao', country: 'US', currency: 'USD', routing: '021000021', account: '123456789' }, k.clock.now())
  const ask = () => prepareAbroad(k.ctx, k.userId, { payeeId: p.id, amount: '1000.00', purpose: 'family', from: 'INR' })
  const sign = (pv: { approvalId: string; docHash: string }) => confirmApproval(k.db, k.userId, pv.approvalId, { method: 'passkey', docHash: pv.docHash }, k.clock.now())
  return { k, p, ask, sign }
}

describe('a payment abroad that needs more than one signature', () => {
  it('is priced as indicative: a band and a ceiling in the signed document, no 60-second quote, an approval that stays open', () => {
    const { k, ask } = setup(2)
    const pv = ask()
    const d = JSON.parse(pv.document)
    expect(d.v).toBe(2)
    expect(d.quote.indicative).toMatchObject({ bandBps: INDICATIVE_BAND_BPS })
    const sell = BigInt(d.quote.sell.minor)
    expect(BigInt(d.quote.indicative.ceiling.minor)).toBe(sell + (sell * BigInt(INDICATIVE_BAND_BPS) + 9_999n) / 10_000n)
    expect(d.quote.expiresAt).toBeGreaterThan(k.clock.now() + 60_000)
    expect(getApproval(k.db, k.userId, pv.approvalId)!.expires_at).toBe(k.clock.now() + MULTI_SIGNER_TTL_MS)
    expect(pv.expiresAt).toBe(k.clock.now() + MULTI_SIGNER_TTL_MS)
    // what the signers are shown: the band, the ceiling and what happens outside it; the size the policy measures is the ceiling
    const labels = pv.lines.map((l) => l.label)
    expect(labels).toEqual(expect.arrayContaining(['Price band', 'Approval open until']))
    expect(labels).not.toContain('Quote expires')
    expect(pv.lines.find((l) => l.label === 'Price band')!.note).toMatch(/refused/)
    expect(d.sizePaise).toBe(Number(BigInt(d.quote.indicative.ceiling.minor) + 50_000n))
    expect(d.note).toMatch(/fresh quote/)
  })

  it('sends at a fresh quote inside the band, however long the signers took, and books that quote\'s terms', () => {
    const { k, ask, sign } = setup(2)
    const pv = ask()
    const d = JSON.parse(pv.document)
    k.clock.advance(20 * MIN) // several members, well past a 60-second quote
    k.quote('ecb:USDINR', 'reference', '93.5000') // a slightly higher fresh reference, still inside the band
    sign(pv)
    k.clock.advance(2 * MIN)
    const before = balance(k.db, k.userId, 'bank')
    const paid = payAbroad(k.ctx, k.userId, pv.approvalId)
    expect(paid).toMatchObject({ state: 'in_transit', amountText: 'USD 1,000.00', duplicate: false })
    const spent = before - balance(k.db, k.userId, 'bank')
    expect(spent).toBeLessThanOrEqual(BigInt(d.quote.indicative.ceiling.minor) + 50_000n)
    expect(spent).toBeGreaterThan(BigInt(d.quote.sell.minor) + 50_000n) // the dearer fresh reference was paid, not the indicative figure
    expect(balance(k.db, k.userId, 'xb:USD')).toBe(100_000n)
    expect(reconcileAbroad(k.db, k.userId, paid.id)).toMatchObject({ state: 'reconciled', breaks: [] })
    expect(paid.debitText).not.toBe('')
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    expect(payAbroad(k.ctx, k.userId, pv.approvalId)).toMatchObject({ id: paid.id, duplicate: true })
  })

  it('refuses when the fresh price is outside the band, and moves nothing', () => {
    const { k, ask, sign } = setup(2)
    const pv = ask()
    sign(pv)
    k.clock.advance(2 * MIN)
    k.quote('ecb:USDINR', 'reference', '99.0000') // about 6% dearer: far outside a 1% band
    const before = balance(k.db, k.userId, 'bank')
    expect(() => payAbroad(k.ctx, k.userId, pv.approvalId)).toThrow(expect.objectContaining({ code: 'outside_band', message: expect.stringMatching(/Nothing was sent/) }))
    expect(balance(k.db, k.userId, 'bank')).toBe(before)
    expect(balance(k.db, k.userId, 'xb:USD')).toBe(0n)
    // the approval is not spent: with the price back inside the band it can still be used
    k.quote('ecb:USDINR', 'reference', '93.4000')
    expect(payAbroad(k.ctx, k.userId, pv.approvalId)).toMatchObject({ state: 'in_transit' })
  })

  it('a payment that needs one signature keeps its 60-second quote and exact terms', () => {
    const { k, ask, sign } = setup(1)
    const pv = ask()
    const d = JSON.parse(pv.document)
    expect(d.quote.indicative).toBeUndefined()
    expect(d.quote.expiresAt).toBe(k.clock.now() + 60_000)
    sign(pv)
    k.clock.advance(61_000)
    expect(() => payAbroad(k.ctx, k.userId, pv.approvalId)).toThrow(expect.objectContaining({ code: 'quote_expired' }))
  })
})
