/**
 * Mallory — the adversary. Every attack here is broadcast to the public chain so that its failure is
 * recorded in a permanent, independently checkable receipt. The threat model is deliberately extreme:
 * Mallory is assumed to have STOLEN the agent's key, and in the strongest scenarios ALSO the
 * independent co-signer's key. The only secret she never has is the owner's cold key.
 */
import { decodeFunctionData, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { QEDVaultAbi } from "../abi/contracts.js";
import type { Chain$ } from "../chain.js";
import { mandateHash, signCertificate, signMandate, type Certificate, type Mandate } from "../protocol/eip712.js";

export interface AttackKit {
  chain: Chain$;
  vault: Address;
  mallory: LocalAccount; // her own key
  stolenAgent: LocalAccount; // the agent hot key, assumed stolen
  stolenCosigner: LocalAccount; // the co-signer key, assumed stolen (strongest scenarios only)
  mandate: Mandate; // owner-signed, public once used
  ownerSig: Hex;
}

export async function now(c: Chain$) {
  return BigInt((await c.pub.getBlock()).timestamp);
}

export async function certFor(k: AttackKit, recipient: Address, amount: bigint, tag: string, dueAt = 0n): Promise<Certificate> {
  const t = await now(k.chain);
  const epoch = (await k.chain.pub.readContract({ address: k.vault, abi: QEDVaultAbi, functionName: "epoch" })) as bigint;
  return {
    mandateHash: mandateHash(k.mandate),
    recipient,
    amount,
    dueAt,
    intentId: keccak256(toHex(`mallory:${tag}:${t}`)),
    evidenceHash: keccak256(toHex(`no real decision record: ${tag}`)),
    ref: keccak256(toHex(tag)),
    notBefore: t - 60n,
    expiresAt: t + 7200n,
    epoch,
  };
}

/** Recovers the exact (mandate, certificate, signatures) the honest agent used, from public calldata. */
export async function harvestPayment(c: Chain$, txHash: Hex) {
  const tx = await c.pub.getTransaction({ hash: txHash });
  const d = decodeFunctionData({ abi: QEDVaultAbi, data: tx.input });
  const [m, ownerSig, cert, cosignerSig] = d.args as unknown as [Mandate, Hex, Certificate, Hex];
  return { m, ownerSig, cert, cosignerSig };
}

export const signAs = signCertificate;
export const forgeMandate = signMandate;
