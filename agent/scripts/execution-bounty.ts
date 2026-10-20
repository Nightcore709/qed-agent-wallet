/**
 * Run 4b — money on the best-execution theorem. Builds on Run 4's public state:
 *
 *   KEYS_FILE=.keys.env.execution EXTRA_KEYS=.keys.env.clearing SCRIPT=agent/scripts/execution-bounty.ts \
 *     SHADOW_OF=11155111 START_STATE='{…}' OUTBOX_SKIP=52 OUTBOX_NAME=outbox-11155111-execution-bounty \
 *     EVIDENCE_DIR=evidence/shadow-execution-bounty npx tsx agent/scripts/local.ts
 *
 * The replica first replays Run 4's 52 signed transactions byte for byte (so its state is Sepolia's),
 * then: a fresh liquidity provider funds ExecutionBounty with 1,000 tUSD from the faucet, and Mallory
 * tries to collect it with the optimal route, with "forged" prices, and with the whole pool at once.
 * Only the new transactions are exported (OUTBOX_SKIP). Replica of Sepolia only: the replayed bytes
 * carry Sepolia's chain id.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { getAddress, keccak256, parseEther, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExecutionBountyAbi, ExecutionBountyBytecode, TestUSDAbi } from "../src/abi/contracts.js";
import { rebuildFromOutboxes } from "../src/replica.js";
import { fn, fmtUsd } from "../src/chain.js";
import { chain, EXPLORERS, loadEnvFile, NETWORK_NAMES, rpcConfig } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { optimalDirectOnly, solve, PRICE_ONE } from "../src/engine/execution.js";
import { hopsForChain, pricesForChain, readVenues } from "../src/roles/trader.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env.execution");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const { chainId, rpcUrl } = rpcConfig();
if (chainId !== 11155111 || process.env.SHADOW !== "1") throw new Error("execution-bounty.ts runs only on a replica of Sepolia (it replays Run 4's signed bytes)");
const K = Object.fromEntries(["DEPLOYER", "LP4", "MALLORY"].map((r) => [r, privateKeyToAccount(process.env[`${r}_PK`] as Hex)])) as Record<"DEPLOYER" | "LP4" | "MALLORY", LocalAccount>;

const OUT = process.env.EVIDENCE_DIR ?? "evidence/shadow-execution-bounty";
mkdirSync(OUT, { recursive: true });
const c = chain();
const ev = new Evidence(OUT);
const MAIN = JSON.parse(readFileSync("evidence/ethereum-sepolia/manifest.json", "utf8")).contracts;
const RUN4 = JSON.parse(readFileSync("evidence/ethereum-sepolia/execution/manifest.json", "utf8"));

async function rebuildRun4() {
  const n = await rebuildFromOutboxes(c, MAIN, JSON.parse(process.env.START_STATE ?? "{}"), ["relay/outbox-11155111-execution.json"]);
  console.log(`replayed Run 4: ${n} signed transactions, identical hashes and statuses`);
}

async function main() {
  console.log(`\nQED Execute — bounty on Theorem 12.3 · replica of ${NETWORK_NAMES[chainId]} via ${rpcUrl}\n`);
  await rebuildRun4();
  const k = RUN4.contracts as { usd: Address; eur: Address; eth: Address; execution: Address; reserve: Address };
  ev.meta = { schema: "qed.evidence/v1", run: "execution-bounty", network: { chainId, name: NETWORK_NAMES[chainId], explorer: EXPLORERS[chainId] }, startedAt: new Date().toISOString(), actors: { deployer: K.DEPLOYER.address, lp4: K.LP4.address, mallory: K.MALLORY.address } };

  const b = await c.deploy(K.DEPLOYER, ExecutionBountyAbi as any, ExecutionBountyBytecode as Hex, [k.execution, k.usd]);
  ev.tx("XB1", { phase: "bounty", title: "Deploy ExecutionBounty on the live QEDExecution", narrative: "Pays everything it holds to anyone whose route, on the live venues, beats the bound that the deployed module computes for the same input and prices.", actor: "Deployer", outcomes: ["O3", "O4"] }, b);
  ev.tx("XB2", { phase: "bounty", title: "Deployer sends Sepolia ETH for gas to a fourth liquidity provider", narrative: "Gas only.", actor: "Deployer", outcomes: ["O4"] }, await c.send(K.DEPLOYER, K.LP4.address, "0x", { value: parseEther("0.002"), gas: 21_000n }));
  ev.tx("XB3", { phase: "bounty", title: "LP4 draws 1,000 tUSD from the public faucet", narrative: "The bounty is funded from the same faucet anyone can use.", actor: "LP4", outcomes: ["O4"] }, await c.send(K.LP4, k.usd, fn(TestUSDAbi, "faucet")));
  ev.tx("XB4", { phase: "bounty", title: "LP4 funds the execution bounty: 1,000 tUSD", narrative: "Money on Theorem 12.3: no route beats B(ν).", actor: "LP4", outcomes: ["O4"] }, await c.send(K.LP4, k.usd, fn(TestUSDAbi, "transfer", [b.address, 1_000_000_000n])));

  const venues = await readVenues(c.pub, k.execution);
  const atk = (id: string, title: string, threat: string, data: Hex) =>
    c.sendExpectingRevert(K.MALLORY, b.address, data, 3_000_000n).then((r) =>
      ev.tx(id, { phase: "bounty", title, narrative: `${threat} → the contract recomputes the bound with the deployed module and executes the route on its own funds: TheoremHolds(output, bound)`, actor: "Mallory", outcomes: ["O3"], attack: { class: "theorem_refutation", threat, defence: "Weak duality, path deficiency and upward rounding: TheoremHolds", layer: "ExecutionBounty" }, expect: "revert" }, r),
    );
  const A = 20_000_000n;
  const opt = solve(venues, k.usd, k.eur, A);
  await atk("XA1", `Mallory claims with the optimal route for 20 tUSD (${(Number(opt.sim.amountOut) / 1e6).toFixed(6)} tEUR) and its own price proof`, "Beat the bound with the best route there is", fn(ExecutionBountyAbi, "claim", [A, k.eur, pricesForChain(opt.prices), hopsForChain(opt.route)]));
  const direct = optimalDirectOnly(venues, k.usd, k.eur, A)!.route;
  const lowered = new Map(opt.prices);
  lowered.set(getAddress(k.usd).toLowerCase(), (opt.prices.get(getAddress(k.usd).toLowerCase())! * 97n) / 100n);
  await atk("XA2", "…with prices lowered 3% to shrink the bound", "Choose prices that understate the bound", fn(ExecutionBountyAbi, "claim", [A, k.eur, pricesForChain(lowered), hopsForChain(direct)]));
  const big = 1_000_000_000n;
  const optBig = solve(venues, k.usd, k.eur, big);
  await atk("XA3", `…with the whole 1,000 tUSD pool in one optimal trade (${(Number(optBig.sim.amountOut) / 1e6).toFixed(2)} tEUR)`, "Look for rounding or overflow trouble at size", fn(ExecutionBountyAbi, "claim", [big, k.eur, pricesForChain(optBig.prices), hopsForChain(optBig.route)]));

  const pool = (await c.pub.readContract({ address: k.usd, abi: TestUSDAbi, functionName: "balanceOf", args: [b.address] })) as bigint;
  ev.meta.contracts = { executionBounty: b.address, execution: k.execution, usd: k.usd, eur: k.eur, deployBlock: b.blockNumber.toString() };
  ev.meta.final = { pool: pool.toString(), attempts: 3, refuted: 0, priceOne: PRICE_ONE.toString() };
  ev.meta.finishedAt = new Date().toISOString();
  ev.flush();
  console.log(`\nDONE. ${fmtUsd(pool)} tUSD unclaimed; three refutation attempts reverted.`);
  void keccak256;
}

main().catch((e) => {
  console.error("\nFATAL", e);
  process.exitCode = 1;
});
