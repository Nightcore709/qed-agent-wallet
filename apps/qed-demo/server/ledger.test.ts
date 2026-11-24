import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fromAmountText, INT64_MAX, INT64_MIN, int64OrNull } from '../shared/amount-text.ts'
import { testTokenFixtures } from '../shared/instrument.ts'
import type { Db } from './core.ts'
import { DEFAULT_OPENING } from './household.ts'
import { available, balance, consumeHold, consumeLots, ensureAccount, heldAmount, InsufficientFunds, openCost, openLot, placeHold, post, releaseHold, verifyLedger } from './ledger.ts'
import { type Kit, makeKit, T0 } from './testkit.ts'

describe('ledger', () => {
  it('opens the paper household with balanced books', () => {
    const k = makeKit()
    expect(balance(k.db, k.userId, 'bank')).toBe(BigInt(DEFAULT_OPENING.bank))
    expect(balance(k.db, k.userId, 'card')).toBe(BigInt(DEFAULT_OPENING.card))
    expect(balance(k.db, k.userId, 'loan:home')).toBe(BigInt(DEFAULT_OPENING.homeLoan))
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('refuses an entry that does not balance, and changes nothing', () => {
    const k = makeKit()
    const before = balance(k.db, k.userId, 'bank')
    expect(() => post(k.db, { userId: k.userId, ts: T0, kind: 't', ref: 'bad', memo: 'unbalanced', lines: [{ account: 'bank', amount: -100n }, { account: 'exp:spend', amount: 99n }] })).toThrow(/does not balance/)
    expect(balance(k.db, k.userId, 'bank')).toBe(before)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('is idempotent on the reference: the same event posted twice moves money once', () => {
    const k = makeKit()
    const e = { userId: k.userId, ts: T0, kind: 'spend', ref: 'pay:1', memo: 'rent', lines: [{ account: 'exp:spend', amount: 2_500_000n }, { account: 'bank', amount: -2_500_000n }] }
    const a = post(k.db, e), b = post(k.db, e)
    expect(a.duplicate).toBe(false)
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
    expect(balance(k.db, k.userId, 'bank')).toBe(BigInt(DEFAULT_OPENING.bank) - 2_500_000n)
  })

  it('never lets cash, holdings or a debt go below zero', () => {
    const k = makeKit()
    const tooMuch = BigInt(DEFAULT_OPENING.bank) + 1n
    expect(() => post(k.db, { userId: k.userId, ts: T0, kind: 'spend', ref: 'over', memo: 'x', lines: [{ account: 'exp:spend', amount: tooMuch }, { account: 'bank', amount: -tooMuch }] })).toThrow(InsufficientFunds)
    const overpay = BigInt(DEFAULT_OPENING.card) + 100n
    expect(() => post(k.db, { userId: k.userId, ts: T0, kind: 'card', ref: 'overpay', memo: 'x', lines: [{ account: 'card', amount: overpay }, { account: 'bank', amount: -overpay }] })).toThrow(InsufficientFunds)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('holds reserve money: spending cannot dip into what an order in flight needs', () => {
    const k = makeKit()
    const bank = BigInt(DEFAULT_OPENING.bank)
    placeHold(k.db, k.userId, 'bank', bank - 1000n, 'order', 'h1', T0)
    expect(available(k.db, k.userId, 'bank')).toBe(1000n)
    expect(() => placeHold(k.db, k.userId, 'bank', 2000n, 'order', 'h2', T0)).toThrow(InsufficientFunds)
    expect(() => post(k.db, { userId: k.userId, ts: T0, kind: 'spend', ref: 's1', memo: 'x', lines: [{ account: 'exp:spend', amount: 2000n }, { account: 'bank', amount: -2000n }] })).toThrow(InsufficientFunds)
    // the same hold reference is not placed twice
    placeHold(k.db, k.userId, 'bank', bank - 1000n, 'order', 'h1', T0)
    expect(available(k.db, k.userId, 'bank')).toBe(1000n)
    // an entry that consumes part of the hold may spend it
    post(k.db, { userId: k.userId, ts: T0, kind: 'buy', ref: 'b1', memo: 'x', consumeHolds: [{ ref: 'h1', amount: 5000n }], lines: [{ account: 'exp:fees', amount: 5000n }, { account: 'bank', amount: -5000n }] })
    expect(available(k.db, k.userId, 'bank')).toBe(1000n)
    releaseHold(k.db, k.userId, 'h1', T0)
    expect(available(k.db, k.userId, 'bank')).toBe(bank - 5000n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('the database itself refuses to edit or delete history', () => {
    const k = makeKit()
    expect(() => k.db.run('UPDATE postings SET amount = amount + 1')).toThrow(/append-only/)
    expect(() => k.db.run('DELETE FROM entries')).toThrow(/append-only/)
    expect(() => k.db.run("UPDATE entries SET memo = 'x'")).toThrow(/append-only/)
  })

  it('verifyLedger detects a tampered balance cache', () => {
    const k = makeKit()
    // Both columns, as the database's own check requires since v6: a change to one of them alone is refused (below).
    k.db.run("UPDATE balances SET amount = amount + 500, amount_text = CAST(amount + 500 AS TEXT) WHERE account_id = (SELECT id FROM accounts WHERE user_id = ? AND code = 'bank')", k.userId)
    const breaks = verifyLedger(k.db, k.userId)
    expect(breaks.some((b) => b.check === 'balance-cache')).toBe(true)
  })

  it('first-in-first-out lots: cost and proceeds are conserved to the paisa', () => {
    const k = makeKit()
    ensureAccount(k.db, k.userId, 'pos:coindcx:BTCINR', 'asset', 'BTC', 'Bitcoin', true)
    ensureAccount(k.db, k.userId, 'trade:BTC', 'trading', 'BTC', 'BTC exchanged', false)
    const buy = (ref: string, qty: bigint, cost: bigint, ts: number) => {
      const e = post(k.db, { userId: k.userId, ts, kind: 'buy', ref, memo: 'buy', lines: [{ account: 'pos:coindcx:BTCINR', amount: qty }, { account: 'trade:BTC', amount: -qty }, { account: 'trade:INR', amount: cost }, { account: 'bank', amount: -cost }] })
      openLot(k.db, k.userId, 'coindcx:BTCINR', qty, cost, ts, e.id)
    }
    buy('b1', 100_000n, 660_000n, T0)
    buy('b2', 300_000n, 2_010_001n, T0 + 1000)
    const e = post(k.db, { userId: k.userId, ts: T0 + 2000, kind: 'sell', ref: 's1', memo: 'sell', lines: [{ account: 'trade:BTC', amount: 250_000n }, { account: 'pos:coindcx:BTCINR', amount: -250_000n }, { account: 'bank', amount: 1_700_000n }, { account: 'trade:INR', amount: -1_700_000n }] })
    const cost = consumeLots(k.db, k.userId, 'coindcx:BTCINR', 250_000n, 1_700_000n, T0 + 2000, e.id)
    // all of lot 1 (660,000) plus half of lot 2 (1,005,000)
    expect(cost).toBe(660_000n + 1_005_000n)
    const realised = k.db.all<{ proceeds: number; cost: number; qty: number }>('SELECT proceeds, cost, qty FROM realised ORDER BY id')
    expect(realised.reduce((s, r) => s + r.proceeds, 0)).toBe(1_700_000)
    expect(realised.reduce((s, r) => s + r.qty, 0)).toBe(250_000)
    expect(openCost(k.db, k.userId, 'coindcx:BTCINR')).toEqual({ qty: 150_000n, cost: 1_005_000n })
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    expect(() => consumeLots(k.db, k.userId, 'coindcx:BTCINR', 999_999n, 1n, T0, e.id)).toThrow(/do not cover/)
  })

  it('any sequence of valid postings keeps every invariant (property)', () => {
    fc.assert(fc.property(fc.array(fc.record({ kind: fc.constantFrom('spend', 'income', 'card', 'fd'), amount: fc.integer({ min: 1, max: 30_000_000 }) }), { maxLength: 40 }), (ops) => {
      const k = makeKit()
      let n = 0
      for (const op of ops) {
        const a = BigInt(op.amount)
        const lines = op.kind === 'spend' ? [{ account: 'exp:spend', amount: a }, { account: 'bank', amount: -a }]
          : op.kind === 'income' ? [{ account: 'bank', amount: a }, { account: 'inc:salary', amount: -a }]
          : op.kind === 'card' ? [{ account: 'card', amount: a }, { account: 'bank', amount: -a }]
          : [{ account: 'fd', amount: a }, { account: 'bank', amount: -a }]
        try { post(k.db, { userId: k.userId, ts: T0 + n, kind: op.kind, ref: `op${n++}`, memo: op.kind, lines }) } catch (e) { if (!(e instanceof InsufficientFunds)) throw e }
      }
      expect(verifyLedger(k.db, k.userId)).toEqual([])
      expect(balance(k.db, k.userId, 'bank') >= 0n).toBe(true)
      expect(balance(k.db, k.userId, 'card') >= 0n).toBe(true)
      k.db.close()
    }), { numRuns: 60 })
  })

  it('any sequence of paying, reserving, settling and releasing keeps what is available equal to the balance less what is reserved, and never below zero (property)', () => {
    // The reserved amounts are tracked here by the test itself, not read back from the ledger, and compared after every step.
    fc.assert(fc.property(fc.array(fc.record({ kind: fc.constantFrom('pay', 'reserve', 'settle', 'release', 'income'), amount: fc.integer({ min: 1, max: 40_000_000 }), pick: fc.nat(8) }), { maxLength: 50 }), (ops) => {
      const k = makeKit()
      const open = new Map<string, bigint>()
      let n = 0, refusals = 0
      for (const op of ops) {
        const a = BigInt(op.amount); n++
        const refs = [...open.keys()]
        try {
          if (op.kind === 'pay') post(k.db, { userId: k.userId, ts: T0 + n, kind: 'spend', ref: `p${n}`, memo: 'pay', lines: [{ account: 'exp:spend', amount: a }, { account: 'bank', amount: -a }] })
          else if (op.kind === 'income') post(k.db, { userId: k.userId, ts: T0 + n, kind: 'income', ref: `i${n}`, memo: 'income', lines: [{ account: 'bank', amount: a }, { account: 'inc:salary', amount: -a }] })
          else if (op.kind === 'reserve') { placeHold(k.db, k.userId, 'bank', a, 'order', `h${n}`, T0 + n); open.set(`h${n}`, a) }
          else if (refs.length) {
            const ref = refs[op.pick % refs.length]!, held = open.get(ref)!
            if (op.kind === 'release') { releaseHold(k.db, k.userId, ref, T0 + n); open.delete(ref) }
            else {
              const use = a < held ? a : held
              post(k.db, { userId: k.userId, ts: T0 + n, kind: 'buy', ref: `s${n}`, memo: 'settle', consumeHolds: [{ ref, amount: use }], lines: [{ account: 'exp:fees', amount: use }, { account: 'bank', amount: -use }] })
              if (use === held) open.delete(ref); else open.set(ref, held - use)
            }
          }
        } catch (e) { if (!(e instanceof InsufficientFunds)) throw e; refusals++ }
        const reserved = [...open.values()].reduce((x, y) => x + y, 0n)
        const bal = balance(k.db, k.userId, 'bank')
        expect(available(k.db, k.userId, 'bank')).toBe(bal - reserved)
        expect(bal - reserved >= 0n).toBe(true)
      }
      expect(verifyLedger(k.db, k.userId)).toEqual([])
      k.db.close()
      return refusals >= 0
    }), { numRuns: 80 })
  })
})

// ------------------------------------------------------------------------------------------------ any precision (stage S3)

/** tETH, the release's 18-decimal test token, as a labelled fixture on the local chain (shared/instrument.ts); not money. */
const TETH = testTokenFixtures('eip155:31337', { tINR: `0x${'1'.repeat(40)}`, tUSD: `0x${'2'.repeat(40)}`, tEUR: `0x${'3'.repeat(40)}`, tETH: `0x${'4'.repeat(40)}` }).find((t) => t.symbol === 'tETH')!
const TWO_63 = 1n << 63n

/**
 * A household with books in tETH as well. No 18-decimal asset is in the registry yet (chain instruments join the books in
 * a later stage), so ensureAccount refuses one; these rows are written as it writes them: both ids, a zero balance.
 */
function tokenKit(): Kit {
  const k = makeKit()
  k.db.run('INSERT INTO assets (id, kind, name, scale) VALUES (?, ?, ?, ?)', 'tETH', 'crypto', TETH.name, TETH.exponent)
  for (const [code, kind, nonneg] of [['wallet:tETH', 'asset', 1], ['inc:tETH', 'income', 0], ['exp:tETH', 'expense', 0]] as const) {
    k.db.run('INSERT INTO accounts (id, user_id, code, kind, asset_id, instrument_id, name, nonneg, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `acc_${code}`, k.userId, code, kind, 'tETH', TETH.id, code, nonneg, '{}')
    k.db.run(`INSERT INTO balances (account_id, amount, amount_text) VALUES (?, 0, '0')`, `acc_${code}`)
  }
  return k
}
const income = (k: Kit, ref: string, a: bigint) => post(k.db, { userId: k.userId, ts: T0, kind: 'income', ref, memo: ref, lines: [{ account: 'wallet:tETH', amount: a }, { account: 'inc:tETH', amount: -a }] })
const pay = (k: Kit, ref: string, a: bigint, hold?: string) => post(k.db, { userId: k.userId, ts: T0, kind: 'spend', ref, memo: ref, ...(hold ? { consumeHolds: [{ ref: hold, amount: a }] } : {}), lines: [{ account: 'exp:tETH', amount: a }, { account: 'wallet:tETH', amount: -a }] })
/** The INTEGER copy of an account's balance, read as text: past 2^53 a number would not be exact. */
const copyOf = (db: Db, code: string): string | null => db.get<{ a: string | null }>(`SELECT CAST(b.amount AS TEXT) a FROM balances b JOIN accounts c ON c.id = b.account_id WHERE c.code = ?`, code)!.a
const textOf = (db: Db, code: string): string => db.get<{ t: string }>(`SELECT b.amount_text t FROM balances b JOIN accounts c ON c.id = b.account_id WHERE c.code = ?`, code)!.t
/** Every row of the three tables: the INTEGER copy is the amount when it fits 64 bits, and NULL when it does not. */
function copiesAgree(db: Db): number {
  let past = 0
  for (const t of ['postings', 'balances', 'holds']) {
    for (const r of db.all<{ a: string | null; t: string }>(`SELECT CAST(amount AS TEXT) a, amount_text t FROM ${t}`)) {
      const v = fromAmountText(r.t)
      expect(r.a, `${t} ${r.t}`).toBe(int64OrNull(v)?.toString() ?? null)
      if (r.a === null) past++
    }
  }
  return past
}

describe('the ledger at any precision: an 18-decimal token with amounts above 2^63 (stage S3)', () => {
  it('posts, holds and verifies amounts SQLite\'s INTEGER cannot hold, to the last unit', () => {
    const k = tokenKit()
    const million = 1_000_000n * 10n ** 18n // a million tokens: 10^24 units, far past 2^63 (9.22 tokens)
    income(k, 'i1', million)
    expect(balance(k.db, k.userId, 'wallet:tETH')).toBe(million)
    expect(balance(k.db, k.userId, 'inc:tETH')).toBe(million)
    expect(textOf(k.db, 'inc:tETH')).toBe('-1000000000000000000000000')
    placeHold(k.db, k.userId, 'wallet:tETH', million - 7n, 'order', 'h-big', T0)
    expect(heldAmount(k.db, k.userId, 'wallet:tETH')).toBe(million - 7n)
    expect(available(k.db, k.userId, 'wallet:tETH')).toBe(7n)
    expect(() => pay(k, 'p-over', 8n)).toThrow(InsufficientFunds)
    pay(k, 'p1', million - 10n, 'h-big') // uses all but 3 units of the reservation
    expect(heldAmount(k.db, k.userId, 'wallet:tETH')).toBe(3n)
    expect(balance(k.db, k.userId, 'wallet:tETH')).toBe(10n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    expect(copiesAgree(k.db)).toBeGreaterThan(0)
  })

  it('a balance crossing 2^63 keeps its exact text; its INTEGER copy leaves at the edge and returns below it, on both sides of zero', () => {
    const k = tokenKit()
    income(k, 'i1', INT64_MAX)
    expect([copyOf(k.db, 'wallet:tETH'), copyOf(k.db, 'inc:tETH')]).toEqual([INT64_MAX.toString(), (-INT64_MAX).toString()])
    income(k, 'i2', 1n) // the wallet at 2^63 has no INTEGER copy; the income account at -2^63 still has one
    expect([textOf(k.db, 'wallet:tETH'), copyOf(k.db, 'wallet:tETH')]).toEqual(['9223372036854775808', null])
    expect(copyOf(k.db, 'inc:tETH')).toBe(INT64_MIN.toString())
    income(k, 'i3', 1n)
    expect([textOf(k.db, 'inc:tETH'), copyOf(k.db, 'inc:tETH')]).toEqual(['-9223372036854775809', null])
    pay(k, 'p1', 2n) // back to 2^63 - 1: the copy is written again
    expect(copyOf(k.db, 'wallet:tETH')).toBe(INT64_MAX.toString())
    expect(balance(k.db, k.userId, 'wallet:tETH')).toBe(INT64_MAX)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    copiesAgree(k.db)
  })

  it('any sequence of income, payments, reservations, settlements and releases keeps every invariant and equals BigInt arithmetic, around and far above 2^63 (property)', () => {
    let runsPast = 0
    const amount = fc.oneof(
      fc.bigInt({ min: 1n, max: 10n ** 6n }),
      fc.bigInt({ min: INT64_MAX - 10n ** 6n, max: INT64_MAX + 10n ** 6n }),
      fc.bigInt({ min: 1n, max: 10n ** 24n }),
    )
    fc.assert(fc.property(fc.array(fc.record({ kind: fc.constantFrom('income', 'pay', 'reserve', 'settle', 'release'), amount, pick: fc.nat(8) }), { maxLength: 40 }), (ops) => {
      const k = tokenKit()
      let wallet = 0n, earned = 0n, spent = 0n, n = 0, peak = 0n
      const open = new Map<string, bigint>()
      for (const op of ops) {
        n++
        const a = op.amount, refs = [...open.keys()]
        try {
          if (op.kind === 'income') { income(k, `i${n}`, a); wallet += a; earned += a }
          else if (op.kind === 'pay') { pay(k, `p${n}`, a); wallet -= a; spent += a }
          else if (op.kind === 'reserve') { placeHold(k.db, k.userId, 'wallet:tETH', a, 'order', `h${n}`, T0 + n); open.set(`h${n}`, a) }
          else if (refs.length) {
            const ref = refs[op.pick % refs.length]!, held = open.get(ref)!
            if (op.kind === 'release') { releaseHold(k.db, k.userId, ref, T0 + n); open.delete(ref) }
            else {
              const use = a < held ? a : held
              pay(k, `s${n}`, use, ref); wallet -= use; spent += use
              if (use === held) open.delete(ref); else open.set(ref, held - use)
            }
          }
        } catch (e) { if (!(e instanceof InsufficientFunds)) throw e }
        const reserved = [...open.values()].reduce((x, y) => x + y, 0n)
        expect(balance(k.db, k.userId, 'wallet:tETH')).toBe(wallet)
        expect(heldAmount(k.db, k.userId, 'wallet:tETH')).toBe(reserved)
        expect(available(k.db, k.userId, 'wallet:tETH')).toBe(wallet - reserved)
        expect(wallet - reserved >= 0n).toBe(true)
        if (wallet > peak) peak = wallet
      }
      expect(balance(k.db, k.userId, 'inc:tETH')).toBe(earned)
      expect(balance(k.db, k.userId, 'exp:tETH')).toBe(spent)
      expect(verifyLedger(k.db, k.userId)).toEqual([])
      copiesAgree(k.db)
      if (peak >= TWO_63) runsPast++
      k.db.close()
    }), { numRuns: 80 })
    expect(runsPast).toBeGreaterThan(10) // the property did reach past 2^63, many times
  })

  it('a reservation used up in parts keeps its exact remainder, and its INTEGER copy once the remainder fits 64 bits', () => {
    const k = tokenKit()
    income(k, 'i1', 10n ** 21n)
    placeHold(k.db, k.userId, 'wallet:tETH', 10n ** 20n + 7n, 'order', 'h1', T0)
    expect(k.db.get(`SELECT CAST(amount AS TEXT) a, amount_text t FROM holds WHERE ref = 'h1'`)).toEqual({ a: null, t: '100000000000000000007' })
    consumeHold(k.db, k.userId, 'h1', 10n ** 20n, T0)
    expect(k.db.get(`SELECT CAST(amount AS TEXT) a, amount_text t, released_at r FROM holds WHERE ref = 'h1'`)).toEqual({ a: '7', t: '7', r: null })
    consumeHold(k.db, k.userId, 'h1', 7n, T0)
    expect(k.db.get(`SELECT released_at r FROM holds WHERE ref = 'h1'`)).toEqual({ r: T0 })
    expect(heldAmount(k.db, k.userId, 'wallet:tETH')).toBe(0n)
    expect(verifyLedger(k.db, k.userId)).toEqual([])
  })

  it('the database refuses a row whose two columns disagree or whose text is not canonical', () => {
    const k = makeKit()
    const acc = k.db.get<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ? AND code = 'bank'`, k.userId)!.id
    const entry = k.db.get<{ id: string }>('SELECT id FROM entries WHERE user_id = ? LIMIT 1', k.userId)!.id
    expect(() => k.db.run('UPDATE balances SET amount = amount + 1 WHERE account_id = ?', acc)).toThrow(/CHECK constraint failed/)
    expect(() => k.db.run(`UPDATE balances SET amount_text = '0' || amount_text WHERE account_id = ?`, acc)).toThrow(/CHECK constraint failed/)
    for (const [amount, text] of [[5, '6'], [null, '5'], [5, '05'], [5, '+5'], [5, ' 5'], [null, '1e20'], [0, '-0'], [null, '-'], [null, `1${'0'.repeat(78)}`], [Number.MAX_SAFE_INTEGER, '9223372036854775808']] as const)
      expect(() => k.db.run('INSERT INTO postings (entry_id, account_id, asset_id, amount, instrument_id, amount_text) VALUES (?, ?, ?, ?, ?, ?)', entry, acc, 'INR', amount, 'iso4217:INR', text), `${amount} ${text}`).toThrow(/CHECK constraint failed/)
    for (const text of ['0', '-5', '05'])
      expect(() => k.db.run(`INSERT INTO holds (id, user_id, account_id, amount, reason, ref, created_at, amount_text) VALUES ('h', ?, ?, NULL, 'x', 'x', 0, ?)`, k.userId, acc, text), text).toThrow(/CHECK constraint failed/)
  })

  it('the database refuses amount text holding a NUL byte in postings, balances and holds (GLOB, length and substr stop at a NUL; CAST and = read past it)', () => {
    const k = makeKit()
    const acc = k.db.get<{ id: string }>(`SELECT id FROM accounts WHERE user_id = ? AND code = 'bank'`, k.userId)!.id
    const entry = k.db.get<{ id: string }>('SELECT id FROM entries WHERE user_id = ? LIMIT 1', k.userId)!.id
    // Each with the copy NULL: the copy the CHECKs require for text that does not survive a round trip through 64 bits.
    // The first five were accepted before the guard (review of 8e9929b).
    for (const t of ['1\u0000x', '7\u0000-1', `5\u0000${'9'.repeat(200)}`, '1\u0000', '-1\u0000abc', '\u00005']) {
      const shown = JSON.stringify(t)
      expect(() => k.db.run('INSERT INTO postings (entry_id, account_id, asset_id, instrument_id, amount, amount_text) VALUES (?, ?, ?, ?, NULL, ?)', entry, acc, 'INR', 'iso4217:INR', t), `postings ${shown}`).toThrow(/CHECK constraint failed/)
      expect(() => k.db.run('UPDATE balances SET amount = NULL, amount_text = ? WHERE account_id = ?', t, acc), `balances ${shown}`).toThrow(/CHECK constraint failed/)
      expect(() => k.db.run(`INSERT INTO holds (id, user_id, account_id, amount, amount_text, reason, ref, created_at) VALUES ('h_nul', ?, ?, NULL, ?, 'x', 'nul', 0)`, k.userId, acc, t), `holds ${shown}`).toThrow(/CHECK constraint failed/)
    }
    expect(verifyLedger(k.db, k.userId)).toEqual([])
    // Written with the checks switched off, it is reported, not read as a number.
    k.db.exec('PRAGMA ignore_check_constraints = ON')
    k.db.run('UPDATE balances SET amount = NULL, amount_text = ? WHERE account_id = ?', '1\u0000x', acc)
    k.db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(verifyLedger(k.db, k.userId)).toEqual([expect.objectContaining({ check: 'amount-text', detail: expect.stringMatching(/balance of bank is not an amount.*\\u0000x/) })])
  })

  it('verifyLedger reports amount text written past the database\'s checks, rather than failing on it or passing it', () => {
    const k = makeKit()
    const bank = `(SELECT id FROM accounts WHERE user_id = '${k.userId}' AND code = 'bank')`
    k.db.exec('PRAGMA ignore_check_constraints = ON')
    k.db.run(`UPDATE balances SET amount_text = '0' || amount_text WHERE account_id = ${bank}`)
    k.db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(verifyLedger(k.db, k.userId)).toEqual([expect.objectContaining({ check: 'amount-text', detail: expect.stringMatching(/balance of bank/) })])
    const k2 = makeKit()
    k2.db.exec('PRAGMA ignore_check_constraints = ON')
    k2.db.run(`UPDATE balances SET amount = amount + 1 WHERE account_id = (SELECT id FROM accounts WHERE user_id = ? AND code = 'card')`, k2.userId)
    k2.db.exec('PRAGMA ignore_check_constraints = OFF')
    expect(verifyLedger(k2.db, k2.userId)).toEqual([expect.objectContaining({ check: 'amount-text', detail: expect.stringMatching(/balance of card.*64-bit copy/) })])
  })

  it('tax lots are written and read as exact integers up to 2^63 - 1, and refuse more rather than round', () => {
    const k = tokenKit()
    const e = income(k, 'i1', 1n)
    const qty = (1n << 62n) + 1n, cost = (1n << 53n) + 1n // neither is exact as a JavaScript number
    openLot(k.db, k.userId, 'fixture:tETH', qty, cost, T0, e.id)
    expect(openCost(k.db, k.userId, 'fixture:tETH')).toEqual({ qty, cost })
    expect(consumeLots(k.db, k.userId, 'fixture:tETH', qty - 1n, cost, T0 + 1, e.id)).toBe(cost * (qty - 1n) / qty)
    expect(k.db.get(`SELECT CAST(qty AS TEXT) q, CAST(proceeds AS TEXT) p FROM realised`)).toEqual({ q: (qty - 1n).toString(), p: cost.toString() })
    expect(openCost(k.db, k.userId, 'fixture:tETH').qty).toBe(1n)
    expect(() => openLot(k.db, k.userId, 'fixture:tETH', TWO_63, 1n, T0, e.id)).toThrow(/too large/)
  })
})
