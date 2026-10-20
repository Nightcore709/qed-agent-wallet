/**
 * Run 4c — the agent decides. A standing owner-signed treasury policy; the agent observes the chain, decides
 * whether and how much to convert, sizes each tranche to the market's depth, gets the co-signer to re-derive the
 * same decision, trades with best execution proved on-chain, and stops when the objective is met.
 *
 *   KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing SCRIPT=agent/scripts/execute-policy.ts \
 *     SHADOW_OF=11155111 START_STATE='{…}' OUTBOX_SKIP=59 OUTBOX_NAME=outbox-11155111-execution-policy \
 *     EVIDENCE_DIR=evidence/shadow-execution-policy npx tsx agent/scripts/local.ts
 *
 * Replica of Sepolia only: it first replays Runs 4 and 4b byte for byte, then acts.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, parseTransaction, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QEDExecutionAbi, TestTokenAbi } from "../src/abi/contracts.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { rebuildFromOutboxes } from "../src/replica.js";
import { PolicyEngine } from "../src/roles/cosigner.js";
import { runPolicyPhases } from "./policy-phases.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.execution");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const { chainId, rpcUrl } = rpcConfig();
if (chainId !== 11155111 || process.env.SHADOW !== "1") throw new Error("execute-policy.ts runs only on a replica of Sepolia (it replays Runs 4 and 4b)");
const ROLES = ["OWNER", "OPERATOR", "COSIGNER", "MALLORY"] as const;
const K = Object.fromEntries(ROLES.map((r) => [r, privateKeyToAccount(process.env[`${r}_PK`] as Hex)])) as Record<(typeof ROLES)[number], LocalAccount>;

const OUT = process.env.EVIDENCE_DIR ?? "evidence/shadow-execution-policy";
mkdirSync(`${OUT}/records`, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8")).contracts;
const RUN4 = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/manifest.json", "utf8"));
const k = RUN4.contracts as { usd: Address; eur: Address; eth: Address; pools: Address[]; vault: Address; reserve: Address; execution: Address; lens: Address };

/** The mandate and owner signature of Run 4, recovered from E1's signed bytes. */
function run4Mandate(): { mandate: any; ownerSig: Hex } {
  const outbox = JSON.parse(readFileSync("relay/outbox-11155111-execution.json", "utf8"));
  const e1 = RUN4.steps.find((s: any) => s.id === "E1");
  const raw = outbox.find((t: any) => t.hash.toLowerCase() === e1.tx.hash.toLowerCase()).raw as Hex;
  const { args } = decodeFunctionData({ abi: QEDExecutionAbi, data: parseTransaction(raw).data as Hex }) as any;
  return { mandate: args[0], ownerSig: args[1] };
}

async function main() {
  console.log(`\nQED Execute — the agent decides · replica of ${NETWORK_NAMES[chainId]} via ${rpcUrl}\n`);
  const n = await rebuildFromOutboxes(c, MAIN, JSON.parse(process.env.START_STATE ?? "{}"), ["relay/outbox-11155111-execution.json", "relay/outbox-11155111-execution-bounty.json"]);
  console.log(`replayed Runs 4 and 4b: ${n} signed transactions, identical hashes and statuses`);
  ev.meta = { schema: "qed.evidence/v1", run: "execution-policy", network: { chainId, name: NETWORK_NAMES[chainId], explorer: EXPLORERS[chainId] }, startedAt: new Date().toISOString(), actors: Object.fromEntries(ROLES.map((r) => [r.toLowerCase(), K[r].address])) };

  const bal = async (t: Address, a: Address) => (await c.pub.readContract({ address: t, abi: TestTokenAbi, functionName: "balanceOf", args: [a] })) as bigint;
  const malloryEur = await bal(k.eur, K.MALLORY.address);
  const { mandate, ownerSig } = run4Mandate();
  const cosigner = new PolicyEngine(c, K.COSIGNER, { vault: k.vault, lens: k.lens, escrow: getAddress(MAIN.escrow), owner: K.OWNER.address, vendorKeys: {}, catalogPrices: {}, denylist: [K.MALLORY.address], deployBlock: 0n, recordsDir: `${OUT}/records` });
  // Mallory took 25.196509 tEUR from venue 0 and the rest from venue 1 in M2 and M4 (Run 4)
  const { policy, ticks } = await runPolicyPhases({ c, ev, K, k, cosigner, mandate, ownerSig, out: OUT, chainId, unwind: [[0, 25_196_509n], [1, malloryEur - 25_196_509n]] });

  ev.meta.contracts = { ...k };
  ev.meta.policy = { ...policy, targetFree: policy.targetFree.toString(), maxTranche: policy.maxTranche.toString(), minTranche: policy.minTranche.toString(), validUntil: policy.validUntil.toString() };
  ev.meta.ticks = ticks;
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log("\nDONE.", JSON.stringify(ticks.map((x: any) => [x.tick, x.action, x.amountIn, x.limitedBy])));
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
