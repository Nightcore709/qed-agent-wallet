/**
 * Three things that are not the same, kept apart for an on-chain conversion (R7-038, GL5):
 *
 *   indicative  a reading of the pools now (service.quote). It commits nobody: no floor, no certificate, no expiry.
 *   executable  what the co-signer signs when the owner has approved the conversion: a floor (the least the order may return),
 *               a tolerance and a certificate that is valid from notBefore to expiresAt. The vault contract refuses a certificate
 *               outside that window (QEDVault.CertificateNotActive), so expiry IS enforced on chain.
 *   fill        what the chain did: the output the mined transaction paid, against the proof's bound.
 *
 * The contract enforces the executable quote's expiry itself; the rail also looks at the clock before it sends, so an expired quote
 * is shown as expired and nothing is broadcast (and no gas is spent on a transaction the contract would revert). The vendored
 * contracts are not changed.
 */
import type { Hex } from "viem";

export type QuoteKind = "indicative" | "executable" | "fill";
export interface ExecutableQuote {
  kind: "executable";
  floor: string;
  tolerancePpm: number;
  /** Unix seconds. */
  validFrom: number;
  expiresAt: number;
  /** The certificate's ref: the hash of the order it commits to. */
  ref: Hex;
  enforcedBy: "contract";
  /** The vault's error when it refuses the certificate outside its window. */
  contractError: "CertificateNotActive";
}
export interface Fill { kind: "fill"; amountOut: string; bound: string; hash: Hex; block: string }

export function executableQuote(cert: { notBefore: bigint; expiresAt: bigint; ref: Hex }, order: { minOut: bigint; tolerancePpm: number }): ExecutableQuote {
  return { kind: "executable", floor: order.minOut.toString(), tolerancePpm: order.tolerancePpm, validFrom: Number(cert.notBefore), expiresAt: Number(cert.expiresAt), ref: cert.ref, enforcedBy: "contract", contractError: "CertificateNotActive" };
}

export type ExpiryVerdict = { state: "valid" } | { state: "expired"; at: string; late: number } | { state: "not-yet"; at: string };
/** The window is checked against the later of the rail's clock and the chain's, the way the contract reads block time (it never reads a clock behind the chain's). */
export function expiryVerdict(q: Pick<ExecutableQuote, "validFrom" | "expiresAt">, wallSeconds: number, chainSeconds: number): ExpiryVerdict {
  const now = Math.max(wallSeconds, chainSeconds);
  if (now > q.expiresAt) return { state: "expired", at: new Date(q.expiresAt * 1000).toISOString(), late: now - q.expiresAt };
  if (now < q.validFrom) return { state: "not-yet", at: new Date(q.validFrom * 1000).toISOString() };
  return { state: "valid" };
}
export const expiredText = (v: Extract<ExpiryVerdict, { state: "expired" }>): string => `The executable quote expired at ${v.at}, ${v.late} s ago. The wallet's contract refuses a certificate after that time (CertificateNotActive), so nothing was sent. Ask for a new quote.`;
