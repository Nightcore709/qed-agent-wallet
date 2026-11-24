/** Canonical JSON + hashing for decision records, invoices and transcripts. */
import { keccak256, toHex, type Hex } from "viem";

export function canonical(x: unknown): string {
  const norm = (v: any): any => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(x));
}

export const hashRecord = (x: unknown): Hex => keccak256(toHex(canonical(x)));

export interface Invoice {
  invoiceId: string;
  productId: string;
  title: string;
  vendor: `0x${string}`;
  payTo: `0x${string}`;
  buyer: `0x${string}`;
  amount: string; // token units, string for JSON stability
  dataCommitment: Hex; // keccak256 of the problem spec this data produces
  jobId: string;
  issuedAt: number;
  expiresAt: number;
}

export const invoiceDigest = (inv: Invoice): Hex => hashRecord(inv);
