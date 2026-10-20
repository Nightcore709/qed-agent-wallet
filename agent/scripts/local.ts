/**
 * Runs the full live scenario against a local anvil node.
 *
 *   npm run local                 → quick local run (chain 31337, short deadlines)
 *   SHADOW_OF=11155111 npm run local
 *        → builds an exact REPLICA of Ethereum Sepolia for our accounts (same chain id, same nonces,
 *          same ETH balances, wall-clock timestamps). Every transaction is signed by its role's own key.
 *          After the run, all signed transactions are exported in order to relay/outbox.json so the
 *          IDENTICAL bytes can be broadcast to the public network (scripts/relay.ts) — tx hashes in the
 *          evidence manifest are therefore the real public-chain hashes.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseEther, type Hex } from "viem";
import { ensureDevKeys, loadEnvFile } from "../src/config.js";

loadEnvFile(process.env.KEYS_FILE ?? ".keys.env");
if (process.env.EXTRA_KEYS) loadEnvFile(process.env.EXTRA_KEYS);
const SCRIPT = process.env.SCRIPT ?? "agent/scripts/live.ts";
const shadowOf = process.env.SHADOW_OF ? Number(process.env.SHADOW_OF) : undefined;
const chainId = shadowOf ?? 31337;
const port = Number(process.env.ANVIL_PORT ?? 8545);
const rpc = `http://127.0.0.1:${port}`;

async function main() {
  if (!shadowOf && !process.env.KEYS_FILE && ensureDevKeys()) console.log("no .keys.env found → using deterministic DEV keys (local chain only)");
  if (shadowOf && !process.env.DEPLOYER_PK) throw new Error("replica mode needs the real role keys in .keys.env");
  // ANVIL_GENESIS_TS: start the replica in the past, so earlier runs can be replayed at their original timestamps
  const genesis = process.env.ANVIL_GENESIS_TS ? ["--timestamp", process.env.ANVIL_GENESIS_TS] : [];
  const anvil = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--hardfork", "osaka", "--base-fee", "21", "--gas-limit", "60000000", ...genesis, "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(rpc) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // Same starting ETH as the real deployer (0.05 Sepolia ETH from the faucet); every other role starts at 0.
  const startBal = process.env.DEPLOYER_START_WEI ? BigInt(process.env.DEPLOYER_START_WEI) : parseEther(process.env.DEPLOYER_START_ETH ?? "0.05");
  if (process.env.DEPLOYER_ADDR) await (pub as any).request({ method: "anvil_setBalance", params: [process.env.DEPLOYER_ADDR, `0x${startBal.toString(16)}`] });
  if (process.env.DEPLOYER_START_NONCE) {
    // mirror the public chain exactly: nonces already used there must be used here too
    await (pub as any).request({ method: "anvil_setNonce", params: [process.env.DEPLOYER_ADDR, `0x${Number(process.env.DEPLOYER_START_NONCE).toString(16)}`] });
  }
  if (!process.env.ANVIL_GENESIS_TS) {
    await (pub as any).request({ method: "evm_setNextBlockTimestamp", params: [`0x${Math.floor(Date.now() / 1000).toString(16)}`] });
    await (pub as any).request({ method: "evm_mine", params: [] });
  }
  const startBlock = await pub.getBlockNumber();

  const env = {
    ...process.env,
    RPC_URL: rpc,
    CHAIN_ID: String(chainId),
    SHADOW: "1",
    MAX_FEE_GWEI: process.env.MAX_FEE_GWEI ?? "0.02",
    PRIORITY_FEE_GWEI: process.env.PRIORITY_FEE_GWEI ?? "0.01",
    GAS_LIMIT: process.env.GAS_LIMIT ?? (shadowOf ? "16700000" : ""),
    REQUIRE_FIXED_GAS: shadowOf ? "1" : "",
    LIABILITY_DELAY_S: process.env.LIABILITY_DELAY_S ?? (shadowOf ? "1800" : "90"),
    MALLORY_JOB_WINDOW_S: process.env.MALLORY_JOB_WINDOW_S ?? (shadowOf ? "1500" : "60"),
    EVIDENCE_DIR: process.env.EVIDENCE_DIR ?? (shadowOf ? `evidence/shadow-${chainId}` : "evidence/local"),
  };
  const code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", SCRIPT], { env, stdio: "inherit" });
    p.on("exit", (c) => resolve(c ?? 1));
  });

  if (shadowOf && code === 0) {
    // Export every signed transaction in canonical (block) order, with the replica's receipt.
    const last = await pub.getBlockNumber();
    const outbox: any[] = [];
    // OUTBOX_SKIP: leading transactions that were only replayed to rebuild state (already on the public chain)
    const skip = Number(process.env.OUTBOX_SKIP ?? 0);
    let seen = 0;
    for (let b = startBlock + 1n; b <= last; b++) {
      const block = await pub.getBlock({ blockNumber: b, includeTransactions: true });
      for (const tx of block.transactions as any[]) {
        if (seen++ < skip) continue;
        const raw = (await (pub as any).request({ method: "eth_getRawTransactionByHash", params: [tx.hash] })) as Hex;
        const r = await pub.getTransactionReceipt({ hash: tx.hash });
        outbox.push({
          i: outbox.length,
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          nonce: tx.nonce,
          shadowTimestamp: Number(block.timestamp),
          shadowStatus: r.status,
          shadowGasUsed: r.gasUsed.toString(),
          shadowLogs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })),
          contractAddress: r.contractAddress ?? null,
          raw,
        });
      }
    }
    mkdirSync("relay", { recursive: true });
    const outName = process.env.OUTBOX_NAME ?? `outbox-${chainId}`;
    writeFileSync(`relay/${outName}.json`, JSON.stringify(outbox, null, 1));
    console.log(`\nexported ${outbox.length} signed transactions → relay/${outName}.json`);
  }
  anvil.kill();
  process.exit(code);
}

main();
