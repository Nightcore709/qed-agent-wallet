/**
 * WebAuthn assertions in the shape QEDOwnerAccount verifies on-chain (chain/accounts/src/QEDOwnerAccount.sol,
 * struct Assertion; OpenZeppelin 5.6.1 WebAuthn.verify).
 *
 * The rail receives what a browser returns from navigator.credentials.get (authenticatorData, clientDataJSON, a DER
 * signature) together with the member's registered public key, and turns it into the contract's struct:
 *   - signerId = keccak256(abi.encode(x, y));
 *   - r, s from the DER (or 64-byte r||s) signature, with s normalised to the lower half of the curve order, as the
 *     contract and OpenZeppelin require (the same signature, so the check is unchanged);
 *   - the BYTE offsets of `"type":"webauthn.get"`, `"challenge":"` and `"origin":"` in the UTF-8 clientDataJSON.
 * Nothing here decides validity: the account contract does, on-chain (isValidSignature, or a simulated execute).
 * The off-chain checks below only refuse malformed input early and say which challenge an assertion was made for.
 *
 * This file is the rail's own encoder for the interim. When chain/accounts publishes its TypeScript helpers and
 * declares the account ready, the wiring should switch to them (test/owner-account-wiring.test.ts).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const MAX_ASSERTIONS = 16; // the account's MAX_SIGNERS

/** What the backend forwards for one member's assertion. */
export interface PasskeyAssertionInput {
  publicKey: { x: Hex; y: Hex };
  authenticatorData: Hex;
  clientDataJSON: string;
  /** DER-encoded ECDSA signature as browsers return it, or 64 bytes r||s. */
  signature: Hex;
}

export interface ContractAssertion {
  signerId: Hex;
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  originIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
}

export const ASSERTION_TUPLE = {
  type: "tuple[]",
  components: [
    { name: "signerId", type: "bytes32" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
    { name: "challengeIndex", type: "uint256" },
    { name: "typeIndex", type: "uint256" },
    { name: "originIndex", type: "uint256" },
    { name: "authenticatorData", type: "bytes" },
    { name: "clientDataJSON", type: "string" },
  ],
} as const;

export class AssertionError extends Error {
  code = "approval_signature_malformed";
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hex32 = (x: unknown, what: string): bigint => {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(x)) throw new AssertionError(`${what} must be a 0x-prefixed hexadecimal number of at most 32 bytes.`);
  return BigInt(x);
};

export function signerIdOf(x: bigint, y: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [x, y]));
}

/** r and s from a DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) or from 64 bytes r||s. */
export function parseSignature(sig: Hex): { r: bigint; s: bigint } {
  if (typeof sig !== "string" || !/^0x([0-9a-fA-F]{2})+$/.test(sig)) throw new AssertionError("signature must be 0x-prefixed hexadecimal bytes.");
  const b = Buffer.from(sig.slice(2), "hex");
  if (b.length === 64) return { r: BigInt(`0x${b.subarray(0, 32).toString("hex")}`), s: BigInt(`0x${b.subarray(32).toString("hex")}`) };
  // DER: 30 len 02 lr r 02 ls s, with short-form lengths only (a P-256 signature is at most 72 bytes)
  if (b.length < 8 || b.length > 72 || b[0] !== 0x30 || b[1] !== b.length - 2 || b[2] !== 0x02) throw new AssertionError("signature is neither DER nor 64 bytes r||s.");
  const lr = b[3];
  if (4 + lr + 2 > b.length || b[4 + lr] !== 0x02) throw new AssertionError("signature is not well-formed DER.");
  const ls = b[5 + lr];
  if (6 + lr + ls !== b.length || lr < 1 || lr > 33 || ls < 1 || ls > 33) throw new AssertionError("signature is not well-formed DER.");
  const r = BigInt(`0x${b.subarray(4, 4 + lr).toString("hex")}`), s = BigInt(`0x${b.subarray(6 + lr).toString("hex")}`);
  return { r, s };
}

/** Byte offset of `needle` in the UTF-8 encoding of `json`, or -1. */
function byteIndex(json: string, needle: string): number {
  return Buffer.from(json, "utf8").indexOf(Buffer.from(needle, "utf8"));
}

/** The base64url (no padding) text of a 32-byte challenge, as it appears in clientDataJSON. */
export const challengeText = (digest: Hex): string => Buffer.from(digest.slice(2), "hex").toString("base64url");

/** The challenge an assertion was made for, read from its clientDataJSON (null when absent). */
export function assertedChallenge(clientDataJSON: string): string | null {
  const m = /"challenge":"([A-Za-z0-9_-]+)"/.exec(clientDataJSON);
  return m ? m[1] : null;
}

export function toContractAssertion(a: unknown): ContractAssertion {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new AssertionError("each assertion is { publicKey: { x, y }, authenticatorData, clientDataJSON, signature }.");
  const o = a as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["publicKey", "authenticatorData", "clientDataJSON", "signature"].includes(k))) throw new AssertionError("an assertion has exactly publicKey, authenticatorData, clientDataJSON and signature.");
  const pk = o.publicKey as Record<string, unknown> | undefined;
  if (!pk || typeof pk !== "object") throw new AssertionError("publicKey must be { x, y } (hex).");
  const x = hex32(pk.x, "publicKey.x"), y = hex32(pk.y, "publicKey.y");
  const ad = o.authenticatorData;
  if (typeof ad !== "string" || !/^0x([0-9a-fA-F]{2}){37,512}$/.test(ad)) throw new AssertionError("authenticatorData must be hex of 37 to 512 bytes.");
  const json = o.clientDataJSON;
  if (typeof json !== "string" || json.length < 20 || json.length > 2048) throw new AssertionError("clientDataJSON must be the exact text the browser produced (20 to 2,048 characters).");
  const typeIndex = byteIndex(json, '"type":"webauthn.get"'), challengeIndex = byteIndex(json, '"challenge":"'), originIndex = byteIndex(json, '"origin":"');
  if (typeIndex < 0 || challengeIndex < 0 || originIndex < 0) throw new AssertionError('clientDataJSON must contain "type":"webauthn.get", "challenge" and "origin".');
  let { r, s } = parseSignature(o.signature as Hex);
  if (r <= 0n || r >= P256_N || s <= 0n || s >= P256_N) throw new AssertionError("signature values are out of range.");
  if (s > P256_N / 2n) s = P256_N - s;
  return { signerId: signerIdOf(x, y), r: word(r), s: word(s), challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), originIndex: BigInt(originIndex), authenticatorData: ad as Hex, clientDataJSON: json };
}

/**
 * One passkey assertion checked off the chain, as the owner account checks one (QEDOwnerAccount: type "webauthn.get",
 * the challenge, the origin, the relying party's hash, user presence and user verification, a backed-up credential
 * eligible for backup, and the P-256 signature over authenticatorData || SHA-256(clientDataJSON)). For what must be signed
 * before any account exists to ask: a workspace's currency set (S5), checked before anything is deployed for it.
 * Returns null when the assertion holds, otherwise why not.
 */
export function verifyAssertionOffChain(a: PasskeyAssertionInput, expect: { digest: Hex; rpIdHash: Hex; origin: string; key: { x: Hex; y: Hex } }): string | null {
  let c: ContractAssertion;
  try { c = toContractAssertion(a); } catch (e) { return (e as Error).message; }
  if (BigInt(a.publicKey.x) !== BigInt(expect.key.x) || BigInt(a.publicKey.y) !== BigInt(expect.key.y)) return "the assertion names another passkey";
  let client: { type?: unknown; challenge?: unknown; origin?: unknown };
  try { client = JSON.parse(c.clientDataJSON); } catch { return "clientDataJSON is not JSON"; }
  if (client.type !== "webauthn.get") return 'it is not an assertion ("type":"webauthn.get")';
  if (client.challenge !== challengeText(expect.digest)) return "it was made for another challenge than these terms' digest";
  if (client.origin !== expect.origin) return `it was made at ${String(client.origin)}, not at the workspace's origin ${expect.origin}`;
  const ad = Buffer.from(c.authenticatorData.slice(2), "hex");
  if (`0x${ad.subarray(0, 32).toString("hex")}` !== expect.rpIdHash.toLowerCase()) return "it was made for another relying party";
  const flags = ad[32];
  if (!(flags & 0x01)) return "the passkey did not record user presence";
  if (!(flags & 0x04)) return "the passkey did not record user verification";
  if (flags & 0x10 && !(flags & 0x08)) return "the passkey says it is backed up but not eligible for backup";
  const jwk = { kty: "EC", crv: "P-256", x: Buffer.from(word(BigInt(expect.key.x)).slice(2), "hex").toString("base64url"), y: Buffer.from(word(BigInt(expect.key.y)).slice(2), "hex").toString("base64url") };
  const signed = Buffer.concat([ad, createHash("sha256").update(c.clientDataJSON, "utf8").digest()]);
  const sig = Buffer.from(c.r.slice(2) + c.s.slice(2), "hex"); // r || s, s already in the lower half
  try {
    if (!verify("sha256", signed, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, sig)) return "the signature does not verify with this passkey's key";
  } catch { return "the signature does not verify with this passkey's key"; }
  return null;
}

/** Assertions sorted by strictly increasing signerId, as the contract requires; a repeated signer is refused here. */
export function sortAssertions(list: ContractAssertion[]): ContractAssertion[] {
  const out = [...list].sort((p, q) => (BigInt(p.signerId) < BigInt(q.signerId) ? -1 : BigInt(p.signerId) > BigInt(q.signerId) ? 1 : 0));
  for (let i = 1; i < out.length; i++) if (out[i].signerId === out[i - 1].signerId) throw new AssertionError("the same passkey signed twice; each member counts once.");
  return out;
}

/** abi.encode(Assertion[]): the ERC-1271 signature bytes the account decodes. */
export function encodeAssertions(list: ContractAssertion[]): Hex {
  return encodeAbiParameters([ASSERTION_TUPLE], [list.map((a) => ({ ...a }))] as never);
}

/** One approval entry: { assertions: [...] } with 1 to 16 assertions, each made for `digest`. */
export function assertionsFor(entry: unknown, digest: Hex): ContractAssertion[] {
  const e = entry as { assertions?: unknown } | null;
  if (!e || typeof e !== "object" || Array.isArray(e) || !Array.isArray(e.assertions) || Object.keys(e).some((k) => k !== "assertions")) throw new AssertionError("each signature entry is { assertions: [...] }.");
  if (e.assertions.length < 1 || e.assertions.length > MAX_ASSERTIONS) throw new AssertionError(`a signature entry carries 1 to ${MAX_ASSERTIONS} assertions.`);
  const list = e.assertions.map(toContractAssertion);
  const want = challengeText(digest);
  for (const a of list) {
    const got = assertedChallenge(a.clientDataJSON);
    if (got !== want) throw Object.assign(new AssertionError(`An assertion was made for challenge ${got ?? "(none)"}, not for ${want} (the digest these terms ask the passkey to sign). Nothing was sent.`), { code: "approval_signature_mismatch" });
  }
  return sortAssertions(list);
}
