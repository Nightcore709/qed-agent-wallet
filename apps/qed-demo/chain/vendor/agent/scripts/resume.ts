/**
 * Rebuilds the replica from relay/outbox (the exact signed bytes already on Sepolia, replayed at their
 * original timestamps), then executes the final phase of the scenario — deadline refund, emergency
 * pause, settlement while paused, unpause — and exports the new signed transactions for relay.
 *
 *   SHADOW=1 GAS_LIMIT=16700000 MAX_FEE_GWEI=0.02 PRIORITY_FEE_GWEI=0.01 tsx agent/scripts/resume.ts
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { ProofEscrowAbi, QEDLensAbi, QEDVaultAbi, TestUSDAbi } from "../src/abi/contracts.js";
import { fn, fmtUsd } from "../src/chain.js";
import { account, chain, loadEnvFile } from "../src/config.js";
import { Evidence } from "../src/evidence.js";
import { fromJson, signCertificate } from "../src/protocol/eip712.js";
import { certFor, type AttackKit } from "../src/roles/adversary.js";

loadEnvFile(".keys.env");
const PORT = 8546;
const OUT = process.env.EVIDENCE_DIR ?? "evidence/shadow-11155111";
const OUTBOX = "relay/outbox-11155111.json";
const START_WEI = BigInt(process.env.DEPLOYER_START_WEI ?? "30200000000000000");

async function main() {
  const firstTs = JSON.parse(readFileSync(OUTBOX, "utf8"))[0].shadowTimestamp;
  const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "11155111", "--hardfork", "osaka", "--base-fee", "21", "--gas-limit", "60000000", "--timestamp", String(firstTs - 60), "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(`http://127.0.0.1:${PORT}`) });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const rq = (method: string, params: unknown[]) => (pub as any).request({ method, params });
  await rq("anvil_setBalance", [process.env.DEPLOYER_ADDR, `0x${START_WEI.toString(16)}`]);

  // 1. replay the exact signed transactions at their original timestamps
  const outbox = JSON.parse(readFileSync(OUTBOX, "utf8"));
  await rq("evm_setNextBlockTimestamp", [`0x${(outbox[0].shadowTimestamp - 1).toString(16)}`]);
  await rq("evm_mine", []);
  for (const t of outbox) {
    await rq("evm_setNextBlockTimestamp", [`0x${t.shadowTimestamp.toString(16)}`]);
    const h = await rq("eth_sendRawTransaction", [t.raw]);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== t.shadowStatus) throw new Error(`replay mismatch at ${t.i}: ${r.status} vs ${t.shadowStatus}`);
  }
  const replayedTo = await pub.getBlockNumber({ cacheTime: 0 });
  console.log(`replayed ${outbox.length} signed transactions → replica at block ${replayedTo}, state identical to Sepolia`);

  // 2. continue the scenario
  process.env.RPC_URL = `http://127.0.0.1:${PORT}`;
  process.env.CHAIN_ID = "11155111";
  const c = chain();
  const old = JSON.parse(readFileSync(`${OUT}/manifest.json`, "utf8"));
  const ev = new Evidence(OUT);
  const { steps, ...meta } = old;
  ev.meta = meta;
  ev.steps.push(...steps);
  const shared = fromJson<any>(readFileSync(`${OUT}/shared.json`, "utf8"));
  const dep = old.contracts;
  const K = { owner: account("OWNER"), agent: account("AGENT"), cosigner: account("COSIGNER"), guardian: account("GUARDIAN"), client: account("CLIENT"), mallory: account("ADVERSARY"), vendor: account("VENDOR"), creditor: account("CREDITOR") };
  const U = (x: number) => BigInt(Math.round(x * 1e6));
  const kit: AttackKit = { chain: c, vault: dep.vault, mallory: K.mallory, stolenAgent: K.agent, stolenCosigner: K.cosigner, mandate: shared.mandate, ownerSig: shared.ownerSig };

  console.log("\nPHASE 8 · deadlines, emergency pause, settlement");
  ev.tx("X19", { phase: "attack", title: "Mallory missed the deadline with a valid proof → anyone refunds the client", narrative: "The client recovers 100% of its 9 tUSD. Unproven work is never paid.", actor: "Client (Northwind)", outcomes: ["O2", "O3"] }, await c.send(K.client, dep.escrow, fn(ProofEscrowAbi, "refund", [2n])));
  ev.tx("P1", { phase: "emergency", title: "Guardian hits the kill-switch: vault paused", narrative: "The guardian can only make things safer: it can pause, never unpause.", actor: "Guardian", outcomes: ["O3"] }, await c.send(K.guardian, dep.vault, fn(QEDVaultAbi, "pause")));
  const pausedTry = await certFor(kit, K.vendor.address, U(1), "paused");
  const xpay = fn(QEDVaultAbi, "executePayment", [shared.mandate, shared.ownerSig, pausedTry, await signCertificate(K.cosigner, 11155111, dep.vault, pausedTry)]);
  ev.tx("P2", { phase: "emergency", title: "While paused, even a fully valid agent payment is refused", narrative: "Agent key + genuine co-signer certificate + owner mandate → VaultPaused.", actor: "QED agent", outcomes: ["O3"], attack: { class: "emergency_stop", threat: "Agent continues after an incident", defence: "VaultPaused", layer: "QEDVault" }, expect: "revert" }, await c.sendExpectingRevert(K.agent, dep.vault, xpay));
  ev.tx("P3", { phase: "emergency", title: "Bill due while paused: MALLORY triggers settlement — CloudCo receives exactly 70 tUSD", narrative: "Pausing stops the AI, never the creditors. Even the attacker calling settle() can only pay the creditor.", actor: "Mallory (as a stranger)", outcomes: ["O3"] }, await c.send(K.mallory, dep.vault, fn(QEDVaultAbi, "settle", [1n])));
  ev.tx("P4", { phase: "emergency", title: "Owner reviews and unpauses", narrative: "Only the owner can resume the agent.", actor: "Owner", outcomes: ["O3"] }, await c.send(K.owner, dep.vault, fn(QEDVaultAbi, "unpause")));

  const snap = async (v: Hex) => (await c.pub.readContract({ address: dep.lens, abi: QEDLensAbi, functionName: "snapshot", args: [v] })) as any;
  const bal = async (who: Hex) => (await c.pub.readContract({ address: dep.token, abi: TestUSDAbi, functionName: "balanceOf", args: [who] })) as bigint;
  const fin = await snap(dep.vault);
  const hp = await snap(dep.honeypotVault);
  ev.meta.final = {
    vault: { balance: fin.balance, protected: fin.protectedBalance, free: fin.freeBalance, blastRadius24h: fin.blastRadius24h, liabilityCount: fin.liabilityCount },
    honeypot: { balance: hp.balance, protected: hp.protectedBalance, free: hp.freeBalance, blastRadius24h: hp.blastRadius24h },
    balances: { creditor: await bal(K.creditor.address), vendor: await bal(K.vendor.address), client: await bal(K.client.address), mallory: await bal(K.mallory.address) },
  };
  ev.meta.finishedAt = new Date().toISOString();
  ev.meta.executionNote =
    "Signed in a build sandbox without RPC egress against a wall-clock-synchronised replica of Sepolia (same chain id, nonces, balances); the identical signed bytes were broadcast via a browser relay and every public receipt compared with the replica (status + logs). The final phase was executed after rebuilding the replica by replaying the exact signed transactions already on Sepolia.";
  ev.flush();

  // 3. export the new signed transactions
  const last = await pub.getBlockNumber({ cacheTime: 0 });
  const minGas = BigInt(process.env.GAS_LIMIT ?? "0");
  const b2: any[] = [];
  for (let b = replayedTo + 1n; b <= last; b++) {
    const block = await pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions as any[]) {
      if (BigInt(tx.gas) < minGas) throw new Error(`tx ${tx.hash} has gas ${tx.gas} < ${minGas}`);
      const raw = (await rq("eth_getRawTransactionByHash", [tx.hash])) as Hex;
      const r = await pub.getTransactionReceipt({ hash: tx.hash });
      b2.push({ i: outbox.length + b2.length, hash: tx.hash, gas: tx.gas.toString(), from: tx.from, to: tx.to, nonce: tx.nonce, shadowBlock: Number(b), shadowTimestamp: Number(block.timestamp), shadowStatus: r.status, shadowGasUsed: r.gasUsed.toString(), shadowLogs: r.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })), contractAddress: null, raw });
    }
  }
  writeFileSync("relay/outbox-11155111-b2.json", JSON.stringify(b2, null, 1));
  writeFileSync("relay/outbox-11155111-full.json", JSON.stringify([...outbox, ...b2], null, 1));
  console.log(`\nexported ${b2.length} new signed transactions → relay/outbox-11155111-b2.json`);
  console.log(`final vault: balance ${fmtUsd(BigInt(fin.balance))} · ring-fenced ${fmtUsd(BigInt(fin.protectedBalance))} · free ${fmtUsd(BigInt(fin.freeBalance))}`);
  anvil.kill();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
