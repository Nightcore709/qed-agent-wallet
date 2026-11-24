/**
 * A software passkey for the rail's tests: a P-256 key pair from node:crypto that answers like
 * navigator.credentials.get with user verification. authenticatorData = sha256(rpId) || flags (UP|UV) || signCount,
 * clientDataJSON serialised as browsers do ({"type","challenge","origin","crossOrigin"}), and a DER signature over
 * sha256(authenticatorData || sha256(clientDataJSON)). The private key never leaves this object.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Approval, PasskeyAssertion, Proposal, ToSign } from "../types.ts";
import { randomUUID } from "node:crypto";

type Hex = `0x${string}`;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export const RP_ID_HASH = `0x${sha256("localhost").toString("hex")}` as Hex;
export const ORIGIN = "http://localhost:5175";

export class SoftwarePasskey {
  readonly publicKey: { x: Hex; y: Hex };
  readonly #key: KeyObject;
  #counter = 0;
  readonly origin: string;
  readonly rpId: string;
  constructor(origin = ORIGIN, rpId = "localhost") {
    this.origin = origin;
    this.rpId = rpId;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.publicKey = { x: `0x${Buffer.from(jwk.x, "base64url").toString("hex")}`, y: `0x${Buffer.from(jwk.y, "base64url").toString("hex")}` };
  }
  /** An assertion over `challenge` (32 bytes). `flags` defaults to UP|UV; `origin`, `type` and `rpId` can be changed to test refusals. */
  assert(challenge: Hex, o: { flags?: number; origin?: string; type?: string; rpId?: string } = {}): PasskeyAssertion {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.#counter);
    const ad = Buffer.concat([sha256(o.rpId ?? this.rpId), Buffer.from([o.flags ?? 0x05]), counter]);
    const clientDataJSON = JSON.stringify({ type: o.type ?? "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), origin: o.origin ?? this.origin, crossOrigin: false });
    const der = sign("sha256", Buffer.concat([ad, sha256(clientDataJSON)]), { key: this.#key, dsaEncoding: "der" });
    return { publicKey: this.publicKey, authenticatorData: `0x${ad.toString("hex")}`, clientDataJSON, signature: `0x${der.toString("hex")}` };
  }
}

/** What the backend would send after the members confirmed exactly these terms with their passkeys. */
export function passkeyApproval(p: Proposal, signers: SoftwarePasskey[], now = Date.now(), over: Partial<Approval> = {}): Approval {
  const toSign = (p.terms.toSign as ToSign[] | undefined) ?? [];
  const base: Approval = { approvalId: `ap-${randomUUID()}`, docHash: `sha256:${"e".repeat(64)}`, termsHash: p.termsHash, confirmedAt: new Date(now).toISOString(), method: "passkey" };
  if (toSign.length) base.signatures = toSign.map((t) => ({ assertions: signers.map((k) => k.assert(t.digest)) }));
  return { ...base, ...over };
}
