/**
 * Canonical terms and their hash: the binding between what the owner confirmed and what the rail signs.
 *
 * Dependency-free and erasable TypeScript, so the backend can import it on Node 26 without a loader:
 *   import { hashTerms, checkApproval } from "../chain/terms.ts";
 *
 * A proposal carries `terms` (the exact content to be signed or sent) and `termsHash = hashTerms(terms)`.
 * The backend shows the terms to the authenticated owner and returns an Approval whose `termsHash` equals it.
 * Before signing, the rail recomputes the hash from the terms it is about to use and refuses on any difference.
 */
import { createHash } from "node:crypto";
import type { Approval } from "./types.ts";

/** Sorted keys, bigints as decimal strings, undefined dropped, no floats that JSON cannot round-trip. */
export function canonicalTerms(x: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("terms may not contain a non-finite number");
      return v;
    }
    if (typeof v === "function" || typeof v === "symbol") throw new Error("terms may contain data only");
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(x));
}

export function hashTerms(terms: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalTerms(terms)).digest("hex");
}

export class ApprovalError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Checks an approval against the exact terms about to be signed. Throws ApprovalError; returns the approval,
 * narrowed to its five fields (and `signatures`, when the terms ask the owner's passkey to sign), when it binds.
 *   notBeforeMs   the terms did not exist before this time, so a confirmation cannot predate it
 *   notAfterMs    the proposal's expiry
 *   nowMs         current wall time; a confirmation from the future is refused (leewayMs allows clock jitter)
 *   signatures    "forbidden" (default: exactly five fields), "required" (a passkey-owned workspace whose terms carry
 *                 `toSign`: one entry per item, checked on-chain by the rail, not here), or "optional"
 */
export function checkApproval(approval: unknown, terms: unknown, window: { notBeforeMs: number; notAfterMs: number; nowMs: number; leewayMs?: number; signatures?: "forbidden" | "required" | "optional" }): Approval {
  const leeway = window.leewayMs ?? 5_000;
  const sigMode = window.signatures ?? "forbidden";
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) throw new ApprovalError("approval_required", "An owner approval object is required: { approvalId, docHash, termsHash, confirmedAt, method }.");
  const a = approval as Record<string, unknown>;
  const fields = ["approvalId", "docHash", "termsHash", "confirmedAt", "method"] as const;
  for (const f of fields) if (typeof a[f] !== "string" || !(a[f] as string).length || (a[f] as string).length > 200) throw new ApprovalError("approval_malformed", `Approval field ${f} must be a non-empty string of at most 200 characters.`);
  const allowed: readonly string[] = sigMode === "forbidden" ? fields : [...fields, "signatures"];
  if (Object.keys(a).some((k) => !allowed.includes(k))) throw new ApprovalError("approval_malformed", sigMode === "forbidden" ? "Approval has unexpected fields; supply exactly approvalId, docHash, termsHash, confirmedAt and method." : "Approval has unexpected fields; supply approvalId, docHash, termsHash, confirmedAt, method and signatures.");
  if (sigMode === "required" && a.signatures === undefined) throw new ApprovalError("approval_signature_missing", "These terms must be signed by the owner's passkey: the approval needs `signatures`, one entry { assertions: [...] } per item of terms.toSign, in order.");
  if (a.signatures !== undefined && (!Array.isArray(a.signatures) || a.signatures.length < 1 || a.signatures.length > 8 || a.signatures.some((s) => !s || typeof s !== "object" || Array.isArray(s)))) throw new ApprovalError("approval_malformed", "Approval field signatures must be a list of 1 to 8 entries { assertions: [...] }.");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(a.approvalId as string)) throw new ApprovalError("approval_malformed", "approvalId must be 1 to 128 characters of letters, digits, dot, underscore, colon or hyphen.");
  const expected = hashTerms(terms);
  if (a.termsHash !== expected) {
    throw new ApprovalError("approval_terms_mismatch", "The approval was given for different terms than the ones about to be signed. Nothing was signed or sent.", { approvedTermsHash: a.termsHash, termsHashToSign: expected });
  }
  const at = Date.parse(a.confirmedAt as string);
  if (!Number.isFinite(at)) throw new ApprovalError("approval_malformed", "confirmedAt must be an ISO-8601 time.");
  if (at > window.nowMs + leeway) throw new ApprovalError("approval_from_future", "The approval is dated in the future.", { confirmedAt: a.confirmedAt, now: new Date(window.nowMs).toISOString() });
  if (at < window.notBeforeMs - leeway) throw new ApprovalError("approval_predates_terms", "The approval is older than the terms it claims to approve.", { confirmedAt: a.confirmedAt, termsCreatedAt: new Date(window.notBeforeMs).toISOString() });
  if (at > window.notAfterMs) throw new ApprovalError("approval_after_expiry", "The approval was given after the proposal expired.", { confirmedAt: a.confirmedAt, expiredAt: new Date(window.notAfterMs).toISOString() });
  const out: Approval = { approvalId: a.approvalId as string, docHash: a.docHash as string, termsHash: a.termsHash as string, confirmedAt: a.confirmedAt as string, method: a.method as string };
  if (a.signatures !== undefined) out.signatures = a.signatures as unknown[];
  return out;
}
