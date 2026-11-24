/**
 * The authority budget of R7 decision D7 ("an authority budget that circular activity cannot grow";
 * docs/r7/00-ARCHITECTURE-DECISIONS.md D7, with the corrections of experiments/r7/S1-science/D7-authority-budget.md
 * sections 2.1 to 2.4). A port, event for event, of the reference implementation
 * experiments/r7/S1-science/d7/budget.py: exact integers and exact fractions (bigint), outward rounding, nothing else.
 * test/authority.test.ts pins it to the reference's 400 cross-implementation sequences (d7/fixtures_d7.py).
 *
 * Quantities are integers in base units. A reference band gives, for one asset, numeraire base units per asset base
 * unit: lo ≤ mid ≤ hi. What leaves is valued at hi and rounded up; what arrives at lo and rounded down.
 *
 *   B (budget)     authority left, before holds. A (available) = B − Σ holds.
 *   pay            to an address outside C: B −= ⌈q·hi⌉. To C: nothing (a self-payment).
 *   convert        output to C: B −= ⌈max(0, q_in·hi_in − q_out·lo_out)⌉ (the "conservative" meter; the "mid" meter
 *                  exists only to reproduce its failure F4). Output elsewhere: a payment of the input, B −= ⌈q_in·hi_in⌉.
 *   hold           A −= amount. Settled outside C: B −= amount. Settled to C, refunded or released: A += amount.
 *   credit         a settlement paid to C by a client outside P, with k confirmations, once per job: B += ⌊r·q·lo⌋.
 *   reversal       value returned against a recorded debit: B += min(what it may still restore, ⌊q·lo⌋).
 *   fee            B −= ⌈v⌉.        grant   an owner-signed increase, B += g; never reported as earned.
 *   uncredit       a credited settlement removed by a reorganisation: B −= its credit (A may go below zero).
 * An event that would make A negative is refused and changes nothing, except in facts mode (`{ facts: true }`), used
 * when the events are a chain's history: what already happened is applied as it happened, and A may then be negative.
 *
 * C (control) are addresses from which value can leave only through this rule or by an owner action the agent cannot
 * perform; P (principal, P ⊇ C) every address any member controls. Receipts from P are never earnings. The agent key
 * is in P and never in C (F6).
 */

/** An exact fraction n/d with d > 0, in lowest terms. */
export interface Q { readonly n: bigint; readonly d: bigint }

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const toBig = (x: bigint | number): bigint => {
  if (typeof x === "bigint") return x;
  if (!Number.isSafeInteger(x)) throw new RangeError(`not an exact integer: ${x}`);
  return BigInt(x);
};
export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let N = toBig(n), D = toBig(d);
  if (D === 0n) throw new RangeError("a fraction's denominator is never zero");
  if (D < 0n) { N = -N; D = -D; }
  const g = gcd(N, D);
  return g > 1n ? { n: N / g, d: D / g } : { n: N, d: D };
}
/** "n/d" or "n", as the reference's fixtures write fractions. */
export function parseQ(s: string): Q {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`not a fraction: ${JSON.stringify(s).slice(0, 40)}`);
  return q(BigInt(m[1]!), m[2] === undefined ? 1n : BigInt(m[2]));
}
export const showQ = (x: Q) => (x.d === 1n ? `${x.n}` : `${x.n}/${x.d}`);
export const addQ = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const subQ = (a: Q, b: Q) => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mulQ = (a: Q, b: Q) => q(a.n * b.n, a.d * b.d);
/** qty · x for an integer qty. */
export const scaleQ = (qty: bigint, x: Q) => q(qty * x.n, x.d);
export const cmpQ = (a: Q, b: Q) => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0; };
/** Largest integer ≤ x (Python's x.numerator // x.denominator). */
export function floorQ(x: Q): bigint {
  const f = x.n / x.d; // truncates toward zero
  return x.n < 0n && f * x.d !== x.n ? f - 1n : f;
}
/** Smallest integer ≥ x. */
export const ceilQ = (x: Q): bigint => -floorQ(q(-x.n, x.d));
/** Round half up. Only to reproduce the rounding failure F5; never in the rule. */
export const nearestQ = (x: Q): bigint => floorQ(addQ(x, q(1n, 2n)));

/** Reference bounds for one asset: numeraire base units per asset base unit. */
export interface Band { readonly lo: Q; readonly mid: Q; readonly hi: Q }
export function band(lo: Q, mid: Q, hi: Q): Band {
  if (!(lo.n >= 0n && cmpQ(lo, mid) <= 0 && cmpQ(mid, hi) <= 0)) throw new RangeError(`a band must satisfy 0 ≤ lo ≤ mid ≤ hi, got ${showQ(lo)}, ${showQ(mid)}, ${showQ(hi)}`);
  return { lo, mid, hi };
}
export const exactBand = (price: Q) => band(price, price, price);
/** The numeraire values itself exactly. */
export const NUMERAIRE: Band = exactBand(q(1n));
/** An asset with no reference: what arrives in it is worth nothing to the budget, what leaves in it cannot be valued (refuse it). */
export const UNVALUED: Band = exactBand(q(0n));

export type Meter = "conservative" | "mid";
export type Rounding = "safe" | "nearest";
export interface Params {
  /** B0: owner-granted, unearned. */
  base: bigint;
  /** r: the stated rate at which settled earnings add (theorem T3 needs r ≤ 1). */
  rate: Q;
  /** k: a settlement counts once it has k confirmations. */
  confirmations: number;
  meter?: Meter;
  rounding?: Rounding;
}

/** The event would take more than is available. Nothing changed. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export interface Entry { kind: string; opId: string; deltaBudget: bigint; deltaAvailable: bigint }

export class AuthorityBudget {
  readonly params: Required<Params>;
  readonly control: ReadonlySet<string>;
  readonly principal: ReadonlySet<string>;
  /** In facts mode nothing is refused: the events are a history that already happened. */
  readonly facts: boolean;
  budget: bigint;
  readonly holds = new Map<string, { amount: bigint; counterparty: string }>();
  /** Per debit id, how much of it a later reversal may still restore. */
  readonly restorable = new Map<string, bigint>();
  /** Per job id, the credit it gave. */
  readonly credited = new Map<string, bigint>();
  readonly log: Entry[] = [];

  constructor(params: Params, control: Iterable<string>, principal: Iterable<string>, opts: { facts?: boolean } = {}) {
    if (params.base < 0n || params.rate.n < 0n || params.confirmations < 0 || !Number.isInteger(params.confirmations)) throw new RangeError("base, rate and confirmations must be non-negative");
    this.params = { meter: "conservative", rounding: "safe", ...params };
    this.control = new Set(control);
    this.principal = new Set(principal);
    for (const c of this.control) if (!this.principal.has(c)) throw new RangeError("every address in control must also be in principal");
    this.facts = opts.facts === true;
    this.budget = params.base;
  }

  // ───────────── helpers ─────────────
  get available(): bigint {
    let held = 0n;
    for (const h of this.holds.values()) held += h.amount;
    return this.budget - held;
  }
  private up(x: Q): bigint { return this.params.rounding === "safe" ? ceilQ(x) : nearestQ(x); }
  private down(x: Q): bigint { return this.params.rounding === "safe" ? floorQ(x) : nearestQ(x); }
  /** Every event returns its change in AVAILABLE authority (what admission uses); the log keeps both. */
  protected record(kind: string, opId: string, dBudget: bigint, dAvail: bigint): bigint {
    this.log.push({ kind, opId, deltaBudget: dBudget, deltaAvailable: dAvail });
    return dAvail;
  }
  private debit(kind: string, opId: string, amount: bigint): bigint {
    if (amount < 0n) throw new RangeError("a debit is never negative");
    if (!this.facts && amount > this.available) throw new Refused(`${kind} ${opId}: needs ${amount}, available ${this.available}`);
    this.budget -= amount;
    if (amount !== 0n) this.restorable.set(opId, (this.restorable.get(opId) ?? 0n) + amount);
    return this.record(kind, opId, -amount, -amount);
  }
  private nonNegative(...xs: bigint[]) { if (xs.some((x) => x < 0n)) throw new RangeError("quantities must be non-negative"); }

  // ───────────── events ─────────────
  /** A payment of qty base units of an asset. */
  pay(opId: string, to: string, qty: bigint, b: Band = NUMERAIRE): bigint {
    this.nonNegative(qty);
    if (this.control.has(to)) return this.record("self-payment", opId, 0n, 0n);
    return this.debit("pay", opId, this.up(scaleQ(qty, b.hi)));
  }
  /** A conversion. If its output goes outside control it is a payment of the input. */
  convert(opId: string, qtyIn: bigint, bandIn: Band, qtyOut: bigint, bandOut: Band, recipient: string): bigint {
    this.nonNegative(qtyIn, qtyOut);
    if (!this.control.has(recipient)) return this.debit("convert-and-pay", opId, this.up(scaleQ(qtyIn, bandIn.hi)));
    const cost = this.params.meter === "conservative" ? subQ(scaleQ(qtyIn, bandIn.hi), scaleQ(qtyOut, bandOut.lo)) : subQ(scaleQ(qtyIn, bandIn.mid), scaleQ(qtyOut, bandOut.mid));
    return this.debit("convert", opId, this.up(cost.n < 0n ? q(0n) : cost));
  }
  /** Commits `amount` (numeraire) to an external obligation that may come back. */
  hold(holdId: string, amount: bigint, counterparty: string): bigint {
    if (amount < 0n || this.holds.has(holdId)) throw new RangeError("bad hold");
    if (this.control.has(counterparty)) throw new RangeError("a hold to an address in control is not an obligation to anyone else");
    if (!this.facts && amount > this.available) throw new Refused(`hold ${holdId}: needs ${amount}, available ${this.available}`);
    this.holds.set(holdId, { amount, counterparty });
    return this.record("hold", holdId, 0n, -amount);
  }
  /** The held money is paid out. To an address in control nothing left the workspace. */
  settleHold(holdId: string, payee: string): bigint {
    const h = this.holds.get(holdId);
    if (!h) throw new RangeError(`no hold ${holdId}`);
    this.holds.delete(holdId);
    if (this.control.has(payee)) return this.record("hold-to-self", holdId, 0n, h.amount);
    this.budget -= h.amount;
    this.restorable.set(holdId, (this.restorable.get(holdId) ?? 0n) + h.amount);
    return this.record("hold-settled", holdId, -h.amount, 0n);
  }
  /** The held money came back (refund, the creditor released the claim). */
  releaseHold(holdId: string): bigint {
    const h = this.holds.get(holdId);
    if (!h) throw new RangeError(`no hold ${holdId}`);
    this.holds.delete(holdId);
    return this.record("hold-released", holdId, 0n, h.amount);
  }
  /**
   * A settled job that paid the workspace. Returns the credit given (0 when it does not qualify). `atMost` (K1,
   * rail/earned-authority.ts) lowers the credit to what the earned-authority netting and caps leave; it never raises it.
   */
  credit(jobId: string, client: string, payee: string, qty: bigint, b: Band, confirmations: number, atMost?: bigint): bigint {
    this.nonNegative(qty);
    const qualifies = this.control.has(payee) && !this.principal.has(client) && confirmations >= this.params.confirmations && !this.credited.has(jobId);
    if (!qualifies) return this.record("receipt-not-earnings", jobId, 0n, 0n);
    let c = this.down(mulQ(scaleQ(qty, this.params.rate), b.lo));
    if (atMost !== undefined && atMost < c) c = atMost < 0n ? 0n : atMost;
    this.credited.set(jobId, c);
    this.budget += c;
    return this.record("credit", jobId, c, c);
  }
  /** A credited settlement vanished in a reorganisation deeper than the confirmations. */
  uncredit(jobId: string): bigint {
    const c = this.credited.get(jobId) ?? 0n;
    this.credited.delete(jobId);
    this.budget -= c;
    return this.record("uncredit", jobId, -c, -c);
  }
  /** Value returned against an earlier debit. Restores at most what that debit took and what came back. */
  reversal(debitId: string, qty: bigint, b: Band = NUMERAIRE): bigint {
    const left = this.restorable.get(debitId) ?? 0n;
    let r = this.down(scaleQ(qty, b.lo));
    if (left < r) r = left;
    if (r < 0n) r = 0n;
    if (r !== 0n) this.restorable.set(debitId, left - r);
    this.budget += r;
    return this.record("reversal", debitId, r, r);
  }
  fee(opId: string, value: Q | bigint): bigint {
    return this.debit("fee", opId, this.up(typeof value === "bigint" ? q(value) : value));
  }
  /** An owner-signed increase. Not earned; reported separately. */
  grant(opId: string, amount: bigint): bigint {
    if (amount < 0n) throw new RangeError("a grant is non-negative");
    this.budget += amount;
    return this.record("grant", opId, amount, amount);
  }
}

/** The only event kinds that may raise the budget (theorem T1). */
export const RAISING_KINDS: ReadonlySet<string> = new Set(["credit", "reversal", "grant"]);
/** Events that are circular by their classification: conversions, self-payments, self-dealt escrow, own refunds. */
export const CIRCULAR_KINDS: ReadonlySet<string> = new Set(["self-payment", "convert", "hold", "hold-to-self", "hold-released", "receipt-not-earnings"]);

/** Independent recomputation of (budget, available) from the log alone: B0 plus the sum of recorded changes. */
export function replay(params: Params, log: readonly Entry[]): { budget: bigint; available: bigint } {
  let budget = params.base, available = params.base;
  for (const e of log) { budget += e.deltaBudget; available += e.deltaAvailable; }
  return { budget, available };
}
