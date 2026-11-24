/**
 * K1: earned authority cannot be manufactured beyond its stated cap (chain/rail/earned-authority.ts; Theorem K1 and
 * Lemma N in docs/research/qed-math-formal/20261124-k1-earned-authority.md, with Z3 checks beside it).
 *
 * Part A checks the rule itself against brute-force oracles on arbitrary histories (times may go backwards, payers
 * repeat, caps and windows vary). Part B drives the co-signer's own replay (buildLedger over decoded logs) through
 * the attacks: self-dealing, round trips, recycling through an address QED cannot link, two households paying each
 * other, and arbitrary mixes. "No sequence raises the budget beyond the stated cap" is B5.
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildLedger, earnedCapOf, eventsFromLogs, viewOf, type AuthorityLogs, type D7Config } from '../../chain/rail/authority-ledger.ts'
import { EarnedLedger, floorQ, parseQ, scaleQ, type EarnedCap, type Q } from './index.ts'

const RUNS = 300
type Address = `0x${string}`
type Hex = `0x${string}`

// ───────────── Part A: the rule against oracles ─────────────
type Ev = { kind: 'sent'; who: number; amount: bigint } | { kind: 'credit'; who: number; amount: bigint; time: bigint | null }
const evArb: fc.Arbitrary<Ev> = fc.oneof(
  fc.record({ kind: fc.constant('sent' as const), who: fc.nat(3), amount: fc.bigInt({ min: 0n, max: 5_000n }) }),
  fc.record({ kind: fc.constant('credit' as const), who: fc.nat(3), amount: fc.bigInt({ min: 0n, max: 5_000n }), time: fc.option(fc.bigInt({ min: 0n, max: 600n }), { nil: null }) }),
)
const capArb = fc.record({ windowSeconds: fc.integer({ min: 1, max: 250 }), perWindow: fc.bigInt({ min: 0n, max: 4_000n }), perPayer: fc.bigInt({ min: 0n, max: 4_000n }) })
const rateArb = fc.constantFrom('0', '1/3', '1/2', '2/3', '1')

function replay(cap: EarnedCap, r: Q, evs: Ev[]) {
  const k = new EarnedLedger(cap, r)
  const given: (bigint | null)[] = []
  for (const e of evs) {
    if (e.kind === 'sent') k.sent(`p${e.who}`, e.amount)
    else { k.credit(`c${given.length}`, `p${e.who}`, e.amount, e.time); given.push(e.time) }
  }
  return { k, given }
}

describe('K1, the rule: every claim of Theorem K1 against a brute-force oracle', () => {
  it('K1.1: a credit is never more than D7 gives (⌊r·q⌋), and never below zero; netted + countable = what was paid', () => {
    fc.assert(fc.property(capArb, rateArb, fc.array(evArb, { maxLength: 40 }), (cap, rs, evs) => {
      const r = parseQ(rs), { k } = replay(cap, r, evs)
      for (const c of k.credits) {
        expect(c.netted + c.countable).toBe(c.amount)
        expect(c.uncapped).toBe(floorQ(scaleQ(c.countable, r)))
        expect(c.credit >= 0n && c.credit <= c.uncapped && c.uncapped <= floorQ(scaleQ(c.amount, r))).toBe(true)
      }
    }), { numRuns: RUNS })
  })

  it('K1.2 and K1.3: in every window (s − L, s], at most X_w from all payers and X_c from any one; times are clamped never to go back', () => {
    fc.assert(fc.property(capArb, rateArb, fc.array(evArb, { maxLength: 40 }), fc.array(fc.bigInt({ min: -50n, max: 900n }), { maxLength: 6 }), (cap, rs, evs, extra) => {
      const { k, given } = replay(cap, parseQ(rs), evs), L = BigInt(cap.windowSeconds)
      k.credits.forEach((c, i) => {
        if (i > 0) expect(c.time >= k.credits[i - 1]!.time).toBe(true)
        if (given[i] !== null && given[i] !== undefined) expect(c.time >= given[i]!).toBe(true)
      })
      // every window that can hold a credit ends at some credit's time, plus arbitrary ends
      for (const s of [...k.credits.map((c) => c.time), ...extra]) {
        const inW = k.credits.filter((c) => c.time > s - L && c.time <= s)
        expect(inW.reduce((x, c) => x + c.credit, 0n) <= cap.perWindow).toBe(true)
        for (const p of new Set(inW.map((c) => c.payer))) expect(inW.filter((c) => c.payer === p).reduce((x, c) => x + c.credit, 0n) <= cap.perPayer).toBe(true)
        expect(k.inWindowAt(s)).toBe(inW.reduce((x, c) => x + c.credit, 0n))
      }
    }), { numRuns: RUNS })
  })

  it('K1.4: over any span of chain time, the total earned is at most X_w · (1 + ⌊span / L⌋)', () => {
    fc.assert(fc.property(capArb, rateArb, fc.array(evArb, { maxLength: 40 }), (cap, rs, evs) => {
      const { k } = replay(cap, parseQ(rs), evs)
      if (!k.credits.length) return
      const span = k.credits.at(-1)!.time - k.credits[0]!.time
      expect(k.total <= cap.perWindow * (1n + span / BigInt(cap.windowSeconds))).toBe(true)
    }), { numRuns: RUNS })
  })

  it('Lemma N: what counts from a payer is the high-water mark of its net contribution (paid by it, less sent to it), floored at zero', () => {
    fc.assert(fc.property(capArb, rateArb, fc.array(evArb, { maxLength: 40 }), (cap, rs, evs) => {
      const { k } = replay(cap, parseQ(rs), evs)
      for (const who of [0, 1, 2, 3]) {
        let net = 0n, peak = 0n
        for (const e of evs) if (e.who === who) { net += e.kind === 'credit' ? e.amount : -e.amount; if (net > peak) peak = net }
        expect(k.credits.filter((c) => c.payer === `p${who}`).reduce((x, c) => x + c.countable, 0n)).toBe(peak)
      }
    }), { numRuns: RUNS })
  })

  it('appending events never lowers an earlier credit (the earned figure only grows as the chain grows)', () => {
    fc.assert(fc.property(capArb, rateArb, fc.array(evArb, { maxLength: 30 }), fc.array(evArb, { maxLength: 15 }), (cap, rs, a, b) => {
      const r = parseQ(rs), short = replay(cap, r, a).k, long = replay(cap, r, [...a, ...b]).k
      short.credits.forEach((c, i) => expect(long.credits[i]!.credit).toBe(c.credit))
      expect(long.total >= short.total).toBe(true)
    }), { numRuns: RUNS })
  })

  it('refuses a window that is not a positive whole number of seconds, negative caps and r outside [0, 1]', () => {
    expect(() => new EarnedLedger({ windowSeconds: 0, perWindow: 1n, perPayer: 1n }, parseQ('1/2'))).toThrow(RangeError)
    expect(() => new EarnedLedger({ windowSeconds: 1.5, perWindow: 1n, perPayer: 1n }, parseQ('1/2'))).toThrow(RangeError)
    expect(() => new EarnedLedger({ windowSeconds: 10, perWindow: -1n, perPayer: 1n }, parseQ('1/2'))).toThrow(RangeError)
    expect(() => new EarnedLedger({ windowSeconds: 10, perWindow: 1n, perPayer: 1n }, parseQ('3/2'))).toThrow(RangeError)
  })
})

// ───────────── Part B: the co-signer's replay (buildLedger) under attack ─────────────
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const VAULT = a(1), RESERVE = a(2), OWNER = a(3), EXEC = a(4), AGENT = a(6), ESCROW = a(8), INR = a(10), LINKED = a(30)
const DAY = 86_400n
// 2 decimals; B0 = 10.00; r = 1/2; k = 2; at most 20.00 earned in any 30 days and 8.00 from any one payer
const CAP = { windowSeconds: 30 * 86_400, perWindow: '2000', perPayer: '800' }
const cfgOf = (vault: Address, owner: Address, over: Partial<D7Config> = {}): D7Config => ({
  vault, asset: INR, symbol: 'tINR', decimals: 2, execution: [EXEC], escrow: ESCROW, base: '1000', rate: '1/2', confirmations: 2,
  control: [vault, RESERVE, owner], principal: [vault, RESERVE, owner, EXEC, AGENT, LINKED], references: [], earnedCap: CAP, ...over,
})
const cfg = cfgOf(VAULT, OWNER)

/** A history as the chain records it, built in order; every settlement is far below the latest block (final). */
class Chain {
  logs: AuthorityLogs = { payments: [], liabilitySettled: [], liabilityReleased: [], executions: [], jobsOpened: [], jobsSettled: [], transfers: [] }
  block = 10
  index = 0
  job = 0n
  private at(address: Address) { const b = this.block++; return { blockNumber: BigInt(b), logIndex: this.index++, transactionHash: `0x${b.toString(16).padStart(64, '0')}` as Hex, address } }
  /** The workspace's asset leaves an address of C for `to` (a payment, an owner's withdrawal, the owner account's transfer). */
  sent(from: Address, to: Address, value: bigint) { this.logs.transfers!.push({ ...this.at(INR), args: { from, to, value } }) }
  /** The agent's payment from the vault: the vault's event and the token's transfer. */
  pay(vault: Address, to: Address, amount: bigint) {
    this.logs.payments.push({ ...this.at(vault), args: { intentId: `0x${(this.index + 1).toString(16).padStart(64, '0')}` as Hex, recipient: to, amount, liabilityId: 0n } })
    this.sent(vault, to, amount)
  }
  /** A job paid by `client` into `payee`, settled at chain time `time`. */
  earn(client: Address, payee: Address, price: bigint, time: bigint) {
    const jobId = ++this.job
    this.logs.jobsOpened.push({ ...this.at(ESCROW), args: { jobId, client, payee, token: INR, price } })
    this.logs.jobsSettled.push({ ...this.at(ESCROW), blockTimestamp: time, args: { jobId, payee, price } })
  }
}
const ledger = (c: D7Config, ch: Chain, now = 10n ** 9n, grants: { nonce: string; amount: string; at: string }[] = []) =>
  buildLedger(c, eventsFromLogs(c, ch.logs), { latestBlock: 10_000_000n, grants, reservations: [], now, epoch: 0n })
/** D7 alone: the same history with no transfers read and no caps (what the wallet credited before K1). */
const d7Alone = (c: D7Config, ch: Chain) => ledger({ ...c, earnedCap: { windowSeconds: 1, perWindow: '1000000000000', perPayer: '1000000000000' } }, Object.assign(new Chain(), { logs: { ...ch.logs, transfers: [] } }))
/** The cap over `span` seconds of chain time: X_w · (1 + ⌊span / L⌋). */
const capOver = (span: bigint) => 2_000n * (1n + span / BigInt(CAP.windowSeconds))

describe('K1, the co-signer\'s replay: no sequence raises the budget beyond the stated cap', () => {
  it('self-dealing: jobs paid by the workspace\'s own accounts, its agent key or a linked workspace never raise the budget, however many', () => {
    fc.assert(fc.property(fc.array(fc.record({ who: fc.constantFrom(VAULT, OWNER, AGENT, LINKED, RESERVE), price: fc.bigInt({ min: 1n, max: 100_000n }), day: fc.nat(200) }), { maxLength: 30 }), (jobs) => {
      const ch = new Chain()
      for (const j of jobs) ch.earn(j.who, VAULT, j.price, BigInt(j.day) * DAY)
      const l = ledger(cfg, ch)
      expect([l.earned, l.budget]).toEqual([0n, 1000n])
    }), { numRuns: 100 })
  })

  it('round trips: money the workspace sends an address and that address pays straight back earns nothing, by an owner\'s withdrawal or the agent\'s payment; under D7 alone the same loop earns half of every lap (RISK-057)', () => {
    const X = a(0xbeef)
    const ch = new Chain()
    for (let lap = 0; lap < 30; lap++) {
      if (lap % 2) ch.sent(VAULT, X, 10_000n) // the owner withdraws 100.00 tINR to X
      else ch.sent(OWNER, X, 10_000n) //         or the owner account sends it
      ch.earn(X, VAULT, 10_000n, BigInt(lap) * DAY) // X pays it back as a job
    }
    const l = ledger(cfg, ch), alone = d7Alone(cfg, ch)
    expect([l.earned, l.budget]).toEqual([0n, 1000n])
    expect(alone.earned).toBe(30n * 5_000n) // the counterexample K1 closes: 1,500.00 tINR of authority from 100.00 recycled
    expect(l.earnedCredits.every((c) => c.netted === c.amount && c.credit === 0n)).toBe(true)
    // the agent's own payments round-tripped are netted too
    const p = new Chain()
    for (let lap = 0; lap < 10; lap++) { p.pay(VAULT, X, 5_000n); p.earn(X, VAULT, 5_000n, BigInt(lap) * DAY) }
    expect(ledger(cfg, p).earned).toBe(0n)
    // property: whatever the order and sizes, an address that never pays more than it was sent counts nothing
    fc.assert(fc.property(fc.array(fc.record({ out: fc.bigInt({ min: 0n, max: 50_000n }), back: fc.nat(100), day: fc.nat(400) }), { maxLength: 25 }), (laps) => {
      const ch2 = new Chain()
      let owed = 0n
      for (const x of laps) {
        ch2.sent(OWNER, X, x.out); owed += x.out
        const back = (owed * BigInt(x.back)) / 100n
        if (back > 0n) { ch2.earn(X, VAULT, back, BigInt(x.day) * DAY); owed -= back }
      }
      expect(ledger(cfg, ch2).earned).toBe(0n)
    }), { numRuns: 100 })
  })

  it('recycling through addresses QED cannot link (an extra hop it does not read): within X_c per payer and X_w in any window, never more', () => {
    fc.assert(fc.property(fc.array(fc.record({ hop: fc.nat(40), price: fc.bigInt({ min: 1n, max: 60_000n }), day: fc.nat(180) }), { minLength: 1, maxLength: 40 }), (laps) => {
      const ch = new Chain()
      const sorted = [...laps].sort((x, y) => x.day - y.day)
      for (const x of sorted) {
        ch.sent(VAULT, a(0x5000), x.price) // the owner withdraws to an address of their own...
        ch.earn(a(0x6000 + x.hop), VAULT, x.price, BigInt(x.day) * DAY) // ...it reaches a fresh address QED never saw, which pays a job
      }
      const l = ledger(cfg, ch), span = BigInt(sorted.at(-1)!.day - sorted[0]!.day) * DAY
      expect(l.earned <= capOver(span)).toBe(true)
      expect(l.budget <= 1000n + capOver(span)).toBe(true)
      const L = BigInt(CAP.windowSeconds)
      for (const c of l.earnedCredits) {
        const w = l.earnedCredits.filter((d) => d.time > c.time - L && d.time <= c.time)
        expect(w.reduce((s, d) => s + d.credit, 0n) <= 2_000n).toBe(true)
        expect(w.filter((d) => d.payer === c.payer).reduce((s, d) => s + d.credit, 0n) <= 800n).toBe(true)
      }
      expect(l.earned <= d7Alone(cfg, ch).earned).toBe(true)
    }), { numRuns: 150 })
  })

  it('collusion between two households: each pays the other\'s workspace in a loop with money withdrawn from its own; each budget stays within its cap', () => {
    const VB = a(0x101), OB = a(0x103), cfgB = cfgOf(VB, OB)
    fc.assert(fc.property(fc.array(fc.record({ price: fc.bigInt({ min: 1n, max: 100_000n }), gap: fc.nat(5), fresh: fc.boolean() }), { minLength: 1, maxLength: 40 }), (laps) => {
      const ch = new Chain()
      let day = 0n, n = 0
      for (const x of laps) {
        day += BigInt(x.gap)
        const pa = x.fresh ? a(0x7000 + n) : a(0x7000), pb = x.fresh ? a(0x8000 + n) : a(0x8000)
        n++
        ch.sent(OWNER, pa, x.price); ch.earn(pa, VB, x.price, day * DAY) // A's owner pays B's workspace with A's money
        ch.sent(OB, pb, x.price); ch.earn(pb, VAULT, x.price, day * DAY) //  and B's owner pays A's with B's
      }
      const span = day * DAY
      for (const [c, l] of [[cfg, ledger(cfg, ch)], [cfgB, ledger(cfgB, ch)]] as const) {
        expect(l.earned <= capOver(span)).toBe(true)
        expect(l.budget <= BigInt(c.base) + capOver(span)).toBe(true)
      }
    }), { numRuns: 150 })
  })

  it('B5, any mix: agent payments, transfers out, jobs from anyone (own accounts included), grants, over months: budget ≤ B0 + grants + X_w · (1 + ⌊span / L⌋), and never more earned than D7 alone', () => {
    const who = fc.constantFrom(a(0x9001), a(0x9002), a(0x9003), OWNER, AGENT, LINKED, a(0x9004))
    const step = fc.oneof(
      fc.record({ k: fc.constant('pay' as const), to: who, amount: fc.bigInt({ min: 0n, max: 30_000n }) }),
      fc.record({ k: fc.constant('sent' as const), from: fc.constantFrom(VAULT, OWNER), to: who, amount: fc.bigInt({ min: 0n, max: 30_000n }) }),
      fc.record({ k: fc.constant('job' as const), from: who, price: fc.bigInt({ min: 0n, max: 90_000n }), gap: fc.nat(20) }),
      fc.record({ k: fc.constant('grant' as const), amount: fc.bigInt({ min: 0n, max: 5_000n }) }),
    )
    fc.assert(fc.property(fc.array(step, { maxLength: 50 }), (steps) => {
      const ch = new Chain(), grants: { nonce: string; amount: string; at: string }[] = []
      let day = 0n, first: bigint | null = null
      for (const s of steps) {
        if (s.k === 'pay') ch.pay(VAULT, s.to, s.amount)
        else if (s.k === 'sent') ch.sent(s.from, s.to, s.amount)
        else if (s.k === 'grant') grants.push({ nonce: `g${grants.length}`, amount: s.amount.toString(), at: 't' })
        else { day += BigInt(s.gap); first ??= day; ch.earn(s.from, VAULT, s.price, day * DAY) }
      }
      const l = ledger(cfg, ch, 10n ** 9n, grants), G = grants.reduce((x, g) => x + BigInt(g.amount), 0n)
      const span = first === null ? 0n : (day - first) * DAY
      expect(l.earned <= capOver(span)).toBe(true)
      expect(l.budget <= 1000n + G + capOver(span)).toBe(true)
      expect(l.earned <= ledger({ ...cfg, earnedCap: { windowSeconds: 1, perWindow: '1000000000000', perPayer: '1000000000000' } }, Object.assign(new Chain(), { logs: { ...ch.logs, transfers: [] } }), 10n ** 9n, grants).earned).toBe(true)
    }), { numRuns: 200 })
  })

  it('a settlement counts only once final; the cap and what it held back are stated wherever the figure appears', () => {
    const ch = new Chain()
    ch.earn(a(0x9100), VAULT, 1_000n, 0n) //   5.00 earned
    ch.earn(a(0x9100), VAULT, 1_000n, 10n) //  3.00 more: the payer's 8.00 is reached, 2.00 held back
    const fin = ledger(cfg, ch)
    expect([fin.earned, fin.earnedCredits.map((c) => [c.credit, c.heldBy])]).toEqual([800n, [[500n, null], [300n, 'payer']]])
    const pending = buildLedger(cfg, eventsFromLogs(cfg, ch.logs), { latestBlock: BigInt(ch.block - 1), grants: [], reservations: [], now: 100n, epoch: 0n })
    expect([pending.earned, pending.pendingCredits.length]).toEqual([500n, 1]) // the last settlement has one confirmation
    const v = viewOf(cfg, fin)
    expect(v.earnedLimit).toEqual({ windowSeconds: 30 * 86_400, perWindow: '2000', perPayer: '800', inWindow: '0', netted: '0', heldBack: '200' })
    expect(v.statement).toMatch(/^\d+\.\d{2} tINR available = granted 10\.00 \(base 10\.00, owner grants 0\.00\) \+ earned 8\.00 − used /)
    expect(v.statement).toMatch(/earned authority counts at most 20\.00 tINR in any 30 days, at most 8\.00 tINR from any one payer, and nothing of what this workspace had sent the payer first/)
    expect(v.limits[0]).toMatch(/at most 20\.00 tINR in any 30 days/)
    expect(v.limits[0]).toMatch(/two people paying each other real money cannot be told apart/)
    // a configuration that states no cap gets the defaults: 1,000 units in any 30 days, 250 from any one payer
    expect(earnedCapOf({ decimals: 2 })).toEqual({ windowSeconds: 30 * 86_400, perWindow: 100_000n, perPayer: 25_000n })
  })
})
