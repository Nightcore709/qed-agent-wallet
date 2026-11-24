/**
 * Run 4d — the owner's policy becomes a contract. QEDTreasuryPolicy is made QEDExecution's operator, so the agent's
 * hot key can trade only through it, and the chain itself refuses a conversion when the reserve needs nothing, when
 * the tranche is outside the owner's bounds, when it cost more than κ against the mid price, or when it provably
 * converted more than the shortfall required. The attacks below are signed with the co-signer's real key, as if it
 * were stolen too: only the contract stands between them and the treasury.
 *
 *   ANVIL_GENESIS_TS=<before Run 4> KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing \
 *     SCRIPT=agent/scripts/execute-policy-chain.ts SHADOW_OF=11155111 START_STATE='{…}' OUTBOX_SKIP=65 \
 *     OUTBOX_NAME=outbox-11155111-execution-policy-chain EVIDENCE_DIR=evidence/shadow-execution-policy-chain \
 *     npx tsx agent/scripts/local.ts
 *
 * Replica of Sepolia only: it replays Runs 4, 4b and 4c at their original timestamps (their certificates have
 * since expired), then acts at wall-clock time.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, parseTransaction, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QEDExecutionAbi } from "../src/abi/contracts.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { rebuildFromOutboxes } from "../src/replica.js";
import { PolicyEngine } from "../src/roles/cosigner.js";
import { runPolicyContractPhases } from "./policy-phases.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.execution");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const { chainId, rpcUrl } = rpcConfig();
if (chainId !== 11155111 || process.env.SHADOW !== "1") throw new Error("execute-policy-chain.ts runs only on a replica of Sepolia (it replays Runs 4, 4b and 4c)");
const ROLES = ["DEPLOYER", "OWNER", "OPERATOR", "COSIGNER"] as const;
const K = Object.fromEntries(ROLES.map((r) => [r, privateKeyToAccount(process.env[`${r}_PK`] as Hex)])) as Record<(typeof ROLES)[number], LocalAccount>;

const OUT = process.env.EVIDENCE_DIR ?? "evidence/shadow-execution-policy-chain";
mkdirSync(`${OUT}/records`, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8")).contracts;
const RUN4 = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/manifest.json", "utf8"));
const RECEIPTS = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/receipts.json", "utf8"));
const k = RUN4.contracts as { usd: Address; eur: Address; eth: Address; pools: Address[]; vault: Address; reserve: Address; execution: Address; lens: Address };
const fmt = (x: bigint) => (Number(x) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** The mandate and owner signature of Run 4, recovered from E1's signed bytes. */
function run4Mandate(): { mandate: any; ownerSig: Hex } {
  const outbox = JSON.parse(readFileSync("relay/outbox-11155111-execution.json", "utf8"));
  const e1 = RUN4.steps.find((s: any) => s.id === "E1");
  const raw = outbox.find((t: any) => t.hash.toLowerCase() === e1.tx.hash.toLowerCase()).raw as Hex;
  const { args } = decodeFunctionData({ abi: QEDExecutionAbi, data: parseTransaction(raw).data as Hex }) as any;
  return { mandate: args[0], ownerSig: args[1] };
}

async function main() {
  console.log(`\nQED Execute — the policy becomes a contract · replica of ${NETWORK_NAMES[chainId]} via ${rpcUrl}\n`);
  const times = Object.fromEntries(RECEIPTS.transactions.map((r: any) => [r.hash.toLowerCase(), Number(r.timestamp)]));
  const n = await rebuildFromOutboxes(c, MAIN, JSON.parse(process.env.START_STATE ?? "{}"), ["relay/outbox-11155111-execution.json", "relay/outbox-11155111-execution-bounty.json", "relay/outbox-11155111-execution-policy.json"], times);
  console.log(`replayed Runs 4, 4b and 4c at their original timestamps: ${n} signed transactions, identical hashes and statuses`);
  ev.meta = { schema: "qed.evidence/v1", run: "execution-policy-chain", network: { chainId, name: NETWORK_NAMES[chainId], explorer: EXPLORERS[chainId] }, startedAt: new Date().toISOString(), actors: { deployer: K.DEPLOYER.address, owner: K.OWNER.address, operator: K.OPERATOR.address, cosigner: K.COSIGNER.address } };

  const { mandate, ownerSig } = run4Mandate();
  const cosigner = new PolicyEngine(c, K.COSIGNER, { vault: k.vault, lens: k.lens, escrow: getAddress(MAIN.escrow), owner: K.OWNER.address, vendorKeys: {}, catalogPrices: {}, denylist: [], deployBlock: 0n, recordsDir: `${OUT}/records` });
  const r4d = await runPolicyContractPhases({ c, ev, K, k, cosigner, mandate, ownerSig, out: OUT, chainId, target: BigInt(process.env.POLICY_TARGET ?? 55_000_000) });
  ev.meta.contracts = { ...r4d.contracts, execution: k.execution, reserve: k.reserve };
  ev.meta.policyChain = r4d.policyChain;
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. reserve free ${fmt(r4d.after)}; four policy violations refused by the contract.`);
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
