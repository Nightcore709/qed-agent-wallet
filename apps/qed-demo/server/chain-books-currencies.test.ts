/**
 * Money-model S5: the household's books of an on-chain wallet whose two test tokens are any of the shared chain's, at
 * 0, 2, 3, 6 or 18 decimals (server/chain-books.ts against the fake wallet service, server/rail-fake.ts). For random
 * histories of grants, payments, receipts, moves between the wallet's own holders and conversions, once every block has
 * its two confirmations:
 *   - conservation: every booked entry balances in its own token, and what the books hold of each token (the three
 *     holders together) is exactly what the chain's movements leave there;
 *   - the comparison with the service's balances agrees, in each token, with no difference;
 *   - decimals: each token is booked at its own scale and named in its own words, and its figure in words reads back to
 *     the same base units.
 * chain/test/currencies.test.ts runs the same books against a real chain with tEUR (6) and tJPY (0).
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalAddress } from '../shared/instrument.ts'
import { parseUnits, tokenBySymbol } from '../shared/chain-assets.ts'
import { compareChainBooks, syncChainBooks, tokenText } from './chain-books.ts'
import { balance, listEntries, verifyLedger } from './ledger.ts'
import { saveVault } from './rail.ts'
import { FakeRail, type FakeChain, type FakeLog } from './rail-fake.ts'
import { makeKit } from './testkit.ts'
import { testKeys } from './key-fixture.ts'

const fake = new FakeRail()
const CFG = { dbPath: '/nowhere/qed.db' }
const keyDir = mkdtempSync(join(tmpdir(), 'qed-books-fx-keys-'))
const keys = testKeys(keyDir)
const keyDirBefore = process.env.QED_KEY_DIR
beforeAll(async () => { process.env.QED_KEY_DIR = keys.dir; await fake.start() })
afterAll(async () => { await fake.stop(); if (keyDirBefore === undefined) delete process.env.QED_KEY_DIR; else process.env.QED_KEY_DIR = keyDirBefore; rmSync(keyDir, { recursive: true, force: true }) })

/** The shared chain's test tokens by their decimals: 0, 2, 3, 6 and 18. */
const BY_DECIMALS: Record<number, string[]> = { 0: ['tJPY'], 2: ['tINR', 'tGBP', 'tAED', 'tSGD'], 3: ['tBHD'], 6: ['tUSD', 'tEUR'], 18: ['tETH'] }
const token = fc.constantFrom(0, 2, 3, 6, 18).chain((d) => fc.constantFrom(...BY_DECIMALS[d]!).map((symbol) => ({ symbol, decimals: d })))
const pair = fc.tuple(token, token).filter(([a, b]) => a.symbol !== b.symbol).map(([asset, reserve]) => ({ asset, reserve }))
/** One transaction of a history, its amounts as fractions of the opening grant (so that every holder stays solvent). */
const step = fc.oneof(
  fc.record({ k: fc.constant('pay' as const), part: fc.integer({ min: 1, max: 50 }) }),
  fc.record({ k: fc.constant('withdraw' as const), part: fc.integer({ min: 1, max: 50 }) }),
  fc.record({ k: fc.constant('deposit' as const), part: fc.integer({ min: 1, max: 50 }) }),
  fc.record({ k: fc.constant('receive' as const), part: fc.integer({ min: 1, max: 50 }), reserve: fc.boolean() }),
  fc.record({ k: fc.constant('convert' as const), part: fc.integer({ min: 1, max: 50 }), restPart: fc.integer({ min: 0, max: 50 }), feeBps: fc.constantFrom(5, 30, 100) }),
)
const PLACES = ['treasury', 'reserve', 'owner'] as const

describe('the books of a wallet in any two test tokens, at 0, 2, 3, 6 and 18 decimals', () => {
  it('book every movement once, balanced in its own token, and agree with the chain in each token', async () => {
    let n = 0
    await fc.assert(fc.asyncProperty(pair, fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.array(step, { minLength: 1, maxLength: 10 }), async (p, unitsGranted, steps) => {
      const k = makeKit()
      const railId = `qed-books-fx-${String(++n).padStart(5, '0')}`
      saveVault(k.db, k.userId, { railId, request: { workspaceId: railId, owner: { signers: [], threshold: 1 }, rpIdHash: `0x${'00'.repeat(32)}`, origin: 'http://localhost:5175' }, credentialIds: [], createdAt: k.clock.now(), createdBy: k.userId })
      const c: FakeChain = fake.addChain(railId, Math.floor(k.clock.now() / 1000) - 3600, p)
      const A = p.asset.symbol, R = p.reserve.symbol
      // the opening grant: whole tokens of the treasury's asset, at its own scale
      const grant = unitsGranted * 10n ** BigInt(p.asset.decimals)
      c.tx([c.grant('treasury', grant), c.grant('owner-account', grant / 10n + 1n)], { jobId: 'job-provision' })
      for (const s of steps) {
        const treasury = c.balance(A, 'treasury'), owner = c.balance(A, 'owner-account')
        const of = (x: bigint, part: number) => (x * BigInt(part)) / 100n
        const logs: FakeLog[] = []
        if (s.k === 'pay' && of(treasury, s.part) > 0n) logs.push(c.pay(of(treasury, s.part)))
        if (s.k === 'withdraw' && of(treasury, s.part) > 0n) logs.push(c.own('treasury', 'owner-account', of(treasury, s.part)))
        if (s.k === 'deposit' && of(owner, s.part) > 0n) logs.push(c.own('owner-account', 'treasury', of(owner, s.part)))
        if (s.k === 'receive') logs.push(c.receive(1n + of(grant, s.part), s.reserve ? R : A, s.reserve ? 'reserve' : 'treasury'))
        if (s.k === 'convert' && of(treasury, s.part) > 1n) {
          const amountIn = of(treasury, s.part), rest = (amountIn * BigInt(s.restPart)) / 100n
          logs.push(...c.convert({ amountIn, rest: rest < amountIn ? rest : 0n, feeBps: s.feeBps, rIn: grant * 100n + 1n, rOut: 10n ** BigInt(p.reserve.decimals + 9) }))
        }
        if (logs.length) c.tx(logs, { jobId: `job-${s.k}` })
      }
      c.mine(1) // the last transaction's block now has its two confirmations
      k.clock.advance(60_000)
      const synced = await syncChainBooks(CFG, k.db, k.userId, k.clock.now())
      expect(synced.state).toBe('synced')
      expect(verifyLedger(k.db, k.userId)).toEqual([])
      const entries = listEntries(k.db, k.userId, { limit: 500 }).filter((e) => e.kind.startsWith('chain-'))
      for (const e of entries) {
        const sums = new Map<string, bigint>()
        for (const l of e.lines) sums.set(l.asset, (sums.get(l.asset) ?? 0n) + BigInt(l.amount_text))
        for (const [asset, sum] of sums) expect(sum, `${e.ref} in ${asset}`).toBe(0n)
      }
      // conservation: the books hold of each token exactly what the movements leave with the three holders
      for (const sym of [A, R]) {
        const asset = `eip155:31337/erc20:${canonicalAddress(c.tokens[sym]!.address)}`
        const books = PLACES.reduce((t, place) => t + balance(k.db, k.userId, `chain:${place}:${asset}`), 0n)
        expect(books, sym).toBe(c.balance(sym, 'treasury') + c.balance(sym, 'reserve') + c.balance(sym, 'owner-account'))
      }
      const cmp = await compareChainBooks(CFG, k.db, k.userId, k.clock.now())
      expect(cmp.state, JSON.stringify(cmp)).toBe('agrees')
      for (const a of cmp.assets) {
        const t = c.tokens[a.symbol]!
        expect([a.decimals, a.difference, a.words]).toEqual([t.decimals, '0', tokenBySymbol(a.symbol)!.many])
        // the figure in words, read back, is the same base units at the token's own decimals
        const text = tokenText(BigInt(a.books), a.decimals, a.symbol)
        const plain = text.replace(` ${a.words}`, '').replace(/,/g, '').replace(/^−/, '')
        expect(parseUnits(plain, a.decimals), text).toBe(BigInt(a.books) < 0n ? -BigInt(a.books) : BigInt(a.books))
      }
    }), { numRuns: 25 })
  }, 120_000)
})
