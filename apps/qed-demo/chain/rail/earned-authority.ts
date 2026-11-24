/**
 * K1 (R13; RISK-057): earned authority that cannot be manufactured beyond a stated cap. A layer over D7's credit
 * (rail/authority.ts). A settlement that D7 would credit, ⌊r·q⌋, is credited here at most that, and less when:
 *
 *   1. netting: the workspace sent the payer money before. Value of the vault's asset that left an address of C for an
 *      address X is set against X's later settlements to the workspace, in chain order, and only the rest counts.
 *      Lemma N: what counts from one payer is the high-water mark of its net contribution (paid by it, less sent to
 *      it), floored at zero. An owner's withdrawal routed straight back as a job from the address it went to earns
 *      nothing, and so does a round trip of the agent's own payment.
 *   2. the caps: in any L seconds of chain time, at most X_w of earned authority from all payers together, and at most
 *      X_c from any one payer address. A credit takes what both rooms leave, never more.
 *
 * Credits are taken in chain order, each at its settlement's position and block time (a time is never taken as
 * earlier than the one before it), each rounded down once, as D7 rounds. Only settlements with k confirmations are
 * given (finality on this chain; D-123).
 *
 * What no rule can rule out: two real people, or one person with an address QED cannot link, paying each other real
 * money. Every such payment is money that really arrived from outside, and a rule that sees only amounts, addresses
 * and times cannot tell it from a client's (R12, Theorem W(b)). The caps bound it: X_w in any window, X_c from any one
 * address. Netting catches only flows QED reads: one extra hop through an address the workspace never paid, or a
 * conversion through a venue, defeats it, and the caps are then the whole bound.
 *
 * Proof and assumptions: docs/research/qed-math-formal/20261124-k1-earned-authority.md (Theorem K1, Lemma N).
 */
import { floorQ, scaleQ, type Q } from "./authority.ts";

/** The caps, in base units of the vault's asset. */
export interface EarnedCap {
  /** L: the window, in seconds of chain time. */
  windowSeconds: number;
  /** X_w: the most earned authority from all payers together in any window. */
  perWindow: bigint;
  /** X_c: the most from any one payer address in any window. */
  perPayer: bigint;
}

/** One settlement's credit, and what was not counted and why. */
export interface EarnedCredit {
  id: string;
  payer: string;
  /** What the payer paid the workspace (q). */
  amount: bigint;
  /** Set against what the workspace had sent this payer and not yet set against anything. */
  netted: bigint;
  /** q − netted. */
  countable: bigint;
  /** ⌊r · countable⌋: what D7 would give for the countable part. */
  uncapped: bigint;
  /** What is credited: min(uncapped, the window's room, the payer's room), never below zero. */
  credit: bigint;
  /** The chain time it is counted at (its block's time, never earlier than the previous credit's). */
  time: bigint;
  /** Which cap held it back, when one did: the tighter room. */
  heldBy: "window" | "payer" | null;
}

const DAY = 86_400;
/** The caps when a configuration states none, in whole units of the asset: 1,000 in any 30 days, 250 from any one payer. */
export const DEFAULT_EARNED_CAP = { windowDays: 30, perWindowUnits: 1000n, perPayerUnits: 250n } as const;
export function defaultEarnedCap(decimals: number): EarnedCap {
  const one = 10n ** BigInt(decimals);
  return { windowSeconds: DEFAULT_EARNED_CAP.windowDays * DAY, perWindow: DEFAULT_EARNED_CAP.perWindowUnits * one, perPayer: DEFAULT_EARNED_CAP.perPayerUnits * one };
}

export function checkCap(cap: EarnedCap): EarnedCap {
  if (!Number.isSafeInteger(cap.windowSeconds) || cap.windowSeconds <= 0) throw new RangeError("the earned-authority window is a positive whole number of seconds");
  if (cap.perWindow < 0n || cap.perPayer < 0n) throw new RangeError("earned-authority caps are never negative");
  return cap;
}

/**
 * The netting and the caps over one history, fed in chain order: `sent` for every transfer of the vault's asset from an
 * address of C to an address outside C, `credit` for every settlement D7 would credit, once final.
 */
export class EarnedLedger {
  readonly cap: EarnedCap;
  readonly rate: Q;
  /** Per address: sent by the workspace and not yet set against a settlement. */
  readonly outstanding = new Map<string, bigint>();
  readonly credits: EarnedCredit[] = [];
  #start = 0; // first credit still inside the window that ends at the latest credit's time
  #inWindow = 0n;
  readonly #payerInWindow = new Map<string, bigint>();
  #last: bigint | null = null;

  constructor(cap: EarnedCap, rate: Q) {
    this.cap = checkCap(cap);
    if (rate.n < 0n || rate.n > rate.d) throw new RangeError("r must lie in [0, 1]");
    this.rate = rate;
  }

  /** Value of the vault's asset that left the workspace for `to`. */
  sent(to: string, amount: bigint): void {
    if (amount < 0n) throw new RangeError("a transfer is never negative");
    if (amount === 0n) return;
    this.outstanding.set(to, (this.outstanding.get(to) ?? 0n) + amount);
  }

  /** A final settlement of `amount` paid by `payer`, at chain time `time` (null: not known, counted with the previous one). */
  credit(id: string, payer: string, amount: bigint, time: bigint | null): EarnedCredit {
    if (amount < 0n) throw new RangeError("a settlement is never negative");
    const t = time === null ? (this.#last ?? 0n) : this.#last !== null && time < this.#last ? this.#last : time;
    this.#last = t;
    this.#slide(t);
    const owed = this.outstanding.get(payer) ?? 0n;
    const netted = owed < amount ? owed : amount;
    if (netted !== 0n) this.outstanding.set(payer, owed - netted);
    const countable = amount - netted;
    const uncapped = floorQ(scaleQ(countable, this.rate));
    const roomWindow = this.cap.perWindow - this.#inWindow, roomPayer = this.cap.perPayer - (this.#payerInWindow.get(payer) ?? 0n);
    const room = roomWindow < roomPayer ? roomWindow : roomPayer;
    let credit = uncapped < room ? uncapped : room;
    if (credit < 0n) credit = 0n;
    const heldBy = credit < uncapped ? (roomWindow <= roomPayer ? "window" : "payer") : null;
    const c: EarnedCredit = { id, payer, amount, netted, countable, uncapped, credit, time: t, heldBy };
    this.credits.push(c);
    this.#inWindow += credit;
    this.#payerInWindow.set(payer, (this.#payerInWindow.get(payer) ?? 0n) + credit);
    return c;
  }

  /** Drops from the running sums the credits no longer inside (t − L, t]. Times only move forward, so the start only does. */
  #slide(t: bigint): void {
    const L = BigInt(this.cap.windowSeconds);
    while (this.#start < this.credits.length && this.credits[this.#start]!.time <= t - L) {
      const old = this.credits[this.#start++]!;
      this.#inWindow -= old.credit;
      this.#payerInWindow.set(old.payer, this.#payerInWindow.get(old.payer)! - old.credit);
    }
  }

  get total(): bigint {
    return this.credits.reduce((s, c) => s + c.credit, 0n);
  }

  /** Credited in the window (now − L, now]. */
  inWindowAt(now: bigint): bigint {
    const L = BigInt(this.cap.windowSeconds);
    return this.credits.reduce((s, c) => (c.time > now - L && c.time <= now ? s + c.credit : s), 0n);
  }
}
