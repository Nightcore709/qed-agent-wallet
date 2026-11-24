/**
 * Stage S3 of the global money model: API responses keep every number the interface reads, wherever a JavaScript number
 * holds it exactly, and add the exact text beside each amount that comes from the ledger. GET /api/accounts: raw_text.
 * GET /api/passbook: balance_text, and each line's amount_text and balance_text. GET /api/ledger: each line's amount_text.
 * Holdings: qtyAtomsText. Past 2^53 the number is null (never a rounded number) and the text is the figure.
 */
import { describe, expect, it } from 'vitest'
import { createAction } from './execute.ts'
import { DEFAULT_OPENING } from './household.ts'
import { listAccounts, listEntries, post } from './ledger.ts'
import { makeKit, settle, T0 } from './testkit.ts'
import { holdings } from './valuation.ts'
import { passbook } from './views.ts'

interface Line { amount: number | null; amount_text: string; balance: number | null; balance_text: string }
const book = (k: ReturnType<typeof makeKit>) => passbook(k.db, k.userId, k.clock.now()) as unknown as { balance: number | null; balance_text: string; lines: Line[] }

describe('amounts in API responses: the number where exact, the text always', () => {
  it('a rupee household reads as before: the same numbers, each with its exact text beside it', () => {
    const k = makeKit()
    post(k.db, { userId: k.userId, ts: T0, kind: 'spend', ref: 'rent', memo: 'Rent', lines: [{ account: 'exp:spend', amount: 2_500_000n }, { account: 'bank', amount: -2_500_000n }] })
    const pb = book(k)
    expect(pb.balance).toBe(DEFAULT_OPENING.bank - 2_500_000)
    expect(pb.balance_text).toBe(String(DEFAULT_OPENING.bank - 2_500_000))
    expect(pb.lines.length).toBeGreaterThan(1)
    for (const [i, l] of pb.lines.entries()) {
      expect(typeof l.amount).toBe('number')
      expect(l.amount_text).toBe(String(l.amount))
      expect(l.balance_text).toBe(String(l.balance))
      if (i + 1 < pb.lines.length) expect(pb.lines[i + 1]!.balance).toBe(l.balance! - l.amount!) // newest first: each line's balance less its amount is the one before
    }
    const accounts = listAccounts(k.db, k.userId)
    expect(accounts).toHaveLength(19)
    for (const a of accounts) {
      expect(Object.keys(a)).toEqual(['code', 'kind', 'asset', 'name', 'raw', 'raw_text'])
      expect(typeof a.raw).toBe('number')
      expect(a.raw_text).toBe(String(a.raw))
    }
    expect(accounts.find((a) => a.code === 'bank')).toMatchObject({ raw: DEFAULT_OPENING.bank - 2_500_000 })
    const lines = listEntries(k.db, k.userId).flatMap((e) => e.lines)
    expect(lines.length).toBeGreaterThan(2)
    for (const l of lines) {
      expect(Object.keys(l)).toEqual(['code', 'name', 'asset', 'amount', 'amount_text'])
      expect(l.amount_text).toBe(String(l.amount))
    }
  })

  it('past 2^53 the number is null rather than rounded, and the text is exact', () => {
    const k = makeKit()
    const huge = (1n << 60n) + 3n // paise: a number would round it
    post(k.db, { userId: k.userId, ts: T0, kind: 'income', ref: 'windfall', memo: 'Windfall', lines: [{ account: 'bank', amount: huge }, { account: 'inc:salary', amount: -huge }] })
    const total = BigInt(DEFAULT_OPENING.bank) + huge
    const pb = book(k)
    expect([pb.balance, pb.balance_text]).toEqual([null, total.toString()])
    expect(pb.lines[0]).toMatchObject({ amount: null, amount_text: huge.toString(), balance: null, balance_text: total.toString() })
    expect(pb.lines[1]).toMatchObject({ balance: DEFAULT_OPENING.bank, balance_text: String(DEFAULT_OPENING.bank) })
    expect(listAccounts(k.db, k.userId).find((a) => a.code === 'bank')).toMatchObject({ raw: null, raw_text: total.toString() })
    expect(listAccounts(k.db, k.userId).find((a) => a.code === 'inc:salary')).toMatchObject({ raw: null, raw_text: (-huge).toString() })
    expect(listEntries(k.db, k.userId, { limit: 1 })[0]!.lines).toEqual([
      expect.objectContaining({ code: 'bank', amount: null, amount_text: huge.toString() }),
      expect.objectContaining({ code: 'inc:salary', amount: null, amount_text: (-huge).toString() }),
    ])
  })

  it('a holding gives its quantity in atoms as text beside the number', async () => {
    const k = makeKit()
    k.btc(6_600_000)
    createAction(k.ctx, { userId: k.userId, origin: 'owner', kind: 'order', venue: 'paper-crypto', economicId: 'buy-1', params: { instrumentId: 'coindcx:BTCINR', side: 'buy', type: 'market', amount: '1000000', maxSlippageBps: 100, purpose: 'manual' }, approvalId: k.approveOwner('action:buy-1') })
    await settle(k)
    const h = holdings(k.db, k.market, k.userId, k.clock.now()).find((x) => x.instrumentId === 'coindcx:BTCINR')!
    expect(h.qtyAtoms).toBeGreaterThan(0)
    expect(h.qtyAtomsText).toBe(String(h.qtyAtoms))
  })
})
