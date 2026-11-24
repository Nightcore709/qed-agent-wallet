/**
 * The review and dispute step for work paid on the chain (R13, audit item E3): QEDDisputeEscrow (chain/disputes), a QED
 * contract in front of the release's ProofEscrow, which stays unmodified. Deployed once per shared chain from its
 * committed artifact (chain/disputes/artifacts/QEDDisputeEscrow.json; nothing builds at run time) by the host's deployer,
 * and recorded in the store. It has no owner and no admin: the deployer holds no power over it after deployment.
 *
 * What the chain enforces, and what QED does, is set out in chain/disputes/README.md, and step by step in rail/escrow.ts
 * (the dispute variant of each escrow step).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, parseEther, toHex, type Abi, type Address, type Hex, type LocalAccount } from "viem";
import { CHAIN_DIR } from "./config.ts";
import type { MarketAddresses } from "./deploy.ts";
import type { Store } from "./store.ts";

export const DISPUTE_ARTIFACT = join(CHAIN_DIR, "disputes", "artifacts", "QEDDisputeEscrow.json");

export interface DisputeArtifact { abi: Abi; bytecode: Hex; bytecodeSha256: string; sourceSha256: string }
export interface DisputeEscrowRecord { address: Address; proofEscrow: Address; deployBlock: string; artifact: { bytecodeSha256: string; sourceSha256: string }; at: string }
/** The record and the ABI the rail calls it with. */
export type DisputeEscrow = DisputeEscrowRecord & { abi: Abi };

export function loadDisputeArtifact(path = DISPUTE_ARTIFACT): DisputeArtifact {
  if (!existsSync(path)) throw new Error(`The dispute escrow's build (${path}) is missing: run scripts/export-artifacts.mjs in chain/disputes.`);
  const a = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(a.abi) || typeof a.bytecode !== "string" || !/^0x[0-9a-fA-F]{100,}$/.test(a.bytecode)) throw new Error("The dispute escrow's build has no ABI or bytecode.");
  return { abi: a.abi, bytecode: a.bytecode, bytecodeSha256: a.bytecodeSha256, sourceSha256: a.sourceSha256 };
}

/** The contract's own bounds and constants, as the rail checks terms before anything is signed. */
export const DISPUTE = { BPS: 10_000, MIN_PERIOD: 60, MAX_PERIOD: 60 * 86_400, MAY_PAY_PROVIDER: 1, MAY_REFUND_CLIENT: 2, MAY_SPLIT: 4 } as const;
export const DISPUTE_STATUS = ["none", "funded", "delivered", "disputed", "closed"] as const;
export const DISPUTE_OUTCOME = ["none", "accepted", "review-timeout", "decided", "decision-timeout", "provider-gave-way", "not-delivered"] as const;

export interface DisputeDeps {
  c: any;
  rpc: (method: string, params?: unknown[]) => Promise<unknown>;
  store: Store;
  deployer: LocalAccount;
  market: MarketAddresses;
  iso: () => string;
  checkpoint: () => Promise<void>;
}

/**
 * Deploys the dispute escrow in front of the market's ProofEscrow, or reuses the recorded one (it must exist on the
 * restored chain). The record is written only after the chain state holding it was checkpointed.
 */
export async function ensureDisputeEscrow(d: DisputeDeps): Promise<DisputeEscrow> {
  const art = loadDisputeArtifact();
  let rec = d.store.meta<DisputeEscrowRecord>("disputes");
  if (rec) {
    const code = await d.c.pub.getCode({ address: rec.address });
    if (!code || code.length <= 2) throw new Error("The store records a dispute escrow that the restored chain does not contain. Nothing was deployed over it.");
    if (getAddress(rec.proofEscrow) !== getAddress(d.market.escrow)) throw new Error("The recorded dispute escrow stands in front of another proof escrow. Nothing was deployed over it.");
    return { ...rec, abi: art.abi };
  }
  if ((await d.c.pub.getBalance({ address: d.deployer.address })) < parseEther("10")) await d.rpc("anvil_setBalance", [d.deployer.address, toHex(parseEther("1000"))]);
  const dep = await d.c.deploy(d.deployer, art.abi, art.bytecode, [d.market.escrow]);
  const address = getAddress(dep.address);
  const wired = getAddress((await d.c.pub.readContract({ address, abi: art.abi, functionName: "proofEscrow" })) as Address);
  if (wired !== getAddress(d.market.escrow)) throw new Error(`The dispute escrow at ${address} reports proof escrow ${wired}, not ${d.market.escrow}.`);
  rec = { address, proofEscrow: getAddress(d.market.escrow), deployBlock: dep.blockNumber.toString(), artifact: { bytecodeSha256: art.bytecodeSha256, sourceSha256: art.sourceSha256 }, at: d.iso() };
  await d.checkpoint();
  d.store.setMeta("disputes", rec);
  return { ...rec, abi: art.abi };
}
