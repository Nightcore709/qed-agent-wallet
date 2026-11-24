/**
 * Development keys of the local rail, and the one object allowed to use the owner's.
 *
 * Every key here is a DEVELOPMENT key derived from a public string, exactly as the release's sandbox derives them
 * (keccak256("qed-sandbox-<ROLE>")), so contract addresses match the release's sandbox. Anyone can derive them;
 * they are valid only on the disposable local chain and must never hold value.
 *
 * The owner's key is never handed out. OwnerSigner signs or sends only what an approval binds: it recomputes the
 * hash of the terms it is given and refuses unless the approval carries that hash (terms.ts → checkApproval), then
 * signs the message or sends the action that is literally part of those terms.
 */
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import { encodeFunctionData, keccak256, toHex, type Abi, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { checkApproval } from "../terms.ts";
import type { Approval } from "../types.ts";
import { readSecret, sealingOn, type SecretOptions, writeSecret } from "./sealed-at-rest.ts";

export const ROLES = ["DEPLOYER", "OWNER", "OPERATOR", "COSIGNER", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY", "CLOUDCO"] as const;
export type Role = (typeof ROLES)[number];

/** Version 1 is the release's sandbox derivation; later versions exist only for key rotation on the rail. */
export function devAccount(role: Role, version = 1): LocalAccount {
  return privateKeyToAccount(keccak256(toHex(version === 1 ? `qed-sandbox-${role}` : `qed-rail-${role}-v${version}`)));
}

// ───────────────────────────── keys that are not derivable from public strings ─────────────────────────────

/**
 * The installation's master secret: 32 random bytes, created once in the rail's data folder and never printed, sent or
 * logged. Every key of the multi-tenant host (its deployer, liquidity and faucet keys, and each workspace's deployer,
 * agent, guardian and relayer keys) is derived from it with HKDF-SHA256 (RFC 5869). None of them can act as a workspace
 * owner: owners are passkey accounts whose signers are P-256 keys held by authenticators.
 *
 * At rest it is sealed under the key-encryption key when sealing is on (QED_RAIL_SEAL=1; sealed-at-rest.ts), and is
 * then never written in plaintext; otherwise it is a plaintext file of mode 600, as before. `mustExist`: the chain was
 * created with a master secret (its genesis is recorded), so a missing one is an error, never replaced by a new one,
 * which would silently change every derived key (independent review of 09db70b, M-4).
 */
export function loadOrCreateMasterSecret(path: string, o: SecretOptions & { mustExist?: boolean } = {}): Buffer {
  const seal = o.seal ?? sealingOn();
  const validate = (b: Buffer): void => {
    if (!/^[0-9a-f]{64}$/.test(b.toString("utf8").trim())) throw new Error(`The master secret in ${path} is not 32 bytes of hex; it was left unchanged. Nothing was derived from it.`);
  };
  let bytes = readSecret(path, { ...o, seal, validate });
  if (!bytes) {
    if (o.mustExist) throw new Error(`The wallet service's master secret is missing (neither ${basename(path)} nor ${basename(path)}.sealed is in ${dirname(path)}), but its chain was created with one, so a new one was not made in its place. Restore the files from the newest wallet-service archive (docs/ENCRYPTION.md section 9).`);
    mkdirSync(dirname(path), { recursive: true });
    bytes = Buffer.from(randomBytes(32).toString("hex") + "\n", "utf8");
    writeSecret(path, bytes, { ...o, seal, fresh: true });
  } else if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
  }
  return Buffer.from(bytes.toString("utf8").trim(), "hex");
}

/**
 * A check value for the master secret, recorded with the chain's genesis: a domain-separated SHA-256 prefix, so a start
 * with a different secret (a lost one replaced, or a planted one) is refused instead of deriving other keys.
 */
export const masterCheckOf = (master: Buffer): string => createHash("sha256").update("qed-rail/master-check/1\n").update(master).digest("hex").slice(0, 32);

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HKDF_SALT = Buffer.from("qed-rail/v1/key-derivation", "utf8");

/**
 * A secp256k1 account from HKDF-SHA256(master, salt, info). `info` names the purpose, e.g.
 * "workspace:acme:agent:v2". An output outside 1..n-1 (probability about 2^-128) is retried with a counter.
 */
export function derivedAccount(master: Buffer, info: string): LocalAccount {
  if (master.length !== 32) throw new Error("the master secret must be 32 bytes");
  for (let i = 0; i < 16; i++) {
    const okm = Buffer.from(hkdfSync("sha256", master, HKDF_SALT, Buffer.from(i ? `${info}#${i}` : info, "utf8"), 32));
    const k = BigInt(`0x${okm.toString("hex")}`);
    if (k > 0n && k < SECP256K1_N) return privateKeyToAccount(`0x${okm.toString("hex")}` as Hex);
  }
  throw new Error("key derivation failed");
}

export interface ApprovalWindow {
  notBeforeMs: number;
  notAfterMs: number;
  nowMs: number;
}
export interface OwnerAction {
  to: Address;
  contract: string;
  function: string;
  args: unknown[];
  /** Run through the owner account's delayed path (scheduleCalls) although the call is not guarded: QED's choice for
   *  a step that gives something away (R13 S5, a creditor's release or assignment). Ignored by a development owner. */
  schedule?: boolean;
}
type Sender = { send: (account: LocalAccount, to: Address, data: Hex, opts?: Record<string, unknown>) => Promise<any> };
type MandateSigner = (owner: LocalAccount, chainId: number, mandate: any) => Promise<Hex>;

export class OwnerSigner {
  #account: LocalAccount;
  readonly address: Address;
  constructor(account: LocalAccount) {
    this.#account = account;
    this.address = account.address;
  }

  /** EIP-191 signature over `terms.message`, the exact text the owner confirmed. */
  async signMessage(terms: { message: string }, approval: unknown, window: ApprovalWindow): Promise<{ signature: Hex; approval: Approval }> {
    const a = checkApproval(approval, terms, window);
    if (typeof terms.message !== "string" || !terms.message.length) throw new Error("terms carry no message to sign");
    return { signature: await this.#account.signMessage({ message: terms.message }), approval: a };
  }

  /** EIP-712 signature over `terms.mandate`, the thirteen fields the owner confirmed. */
  async signMandate(terms: { chainId: number; mandate: Record<string, unknown> }, approval: unknown, window: ApprovalWindow, sign: MandateSigner, toMandate: (fields: Record<string, unknown>) => unknown): Promise<{ signature: Hex; approval: Approval }> {
    const a = checkApproval(approval, terms, window);
    return { signature: await sign(this.#account, terms.chainId, toMandate(terms.mandate)), approval: a };
  }

  /** Sends `terms.actions[index]` as an owner transaction. The calldata is encoded here from the approved terms. */
  async sendAction(terms: { actions: OwnerAction[] }, index: number, approval: unknown, window: ApprovalWindow, abi: Abi, chain: Sender, decodeArgs: (args: unknown[]) => unknown[] = (x) => x): Promise<{ tx: any; approval: Approval }> {
    const a = checkApproval(approval, terms, window);
    const action = terms.actions?.[index];
    if (!action) throw new Error("the approved terms contain no such action");
    const data = encodeFunctionData({ abi, functionName: action.function, args: decodeArgs(action.args) } as never);
    return { tx: await chain.send(this.#account, action.to, data), approval: a };
  }
}
