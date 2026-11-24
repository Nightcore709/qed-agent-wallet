/**
 * The rail's chain clients look again for a receipt every LOCAL_RECEIPT_POLL_MS (rail/chain-socket.ts quickReceipts),
 * not every 4 s. Anvil's automatic mining is turned off, a transaction is sent, and the chain mines it 300 ms after the
 * broadcast: the client the rail builds has its receipt within a second. The control is the same vendored client
 * unwrapped, as the rail built it before: its first look misses and it waits for viem's 4 s poll, which is what the
 * assertion on the wrapped client would catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { freshDir } from "./helpers.ts";
import { Anvil } from "../rail/anvil.ts";
import { LOCAL_RECEIPT_POLL_MS, quickReceipts } from "../rail/chain-socket.ts";
import { CHAIN_ID } from "../rail/config.ts";
import { Chain$ } from "../vendor/agent/src/chain.ts";

const BIN = join(homedir(), ".foundry", "bin", "anvil");
// Anvil's first default development account: a published test key, holding only this local chain's valueless ether
const DEV = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const MINED_AFTER_MS = 300;

/** Milliseconds from the broadcast to `send` returning, the chain mining the transaction MINED_AFTER_MS after the broadcast. */
async function sendMinedLater(c: Chain$, anvil: Anvil): Promise<number> {
  await anvil.rpc("evm_setAutomine", [false]);
  let broadcastAt = 0;
  await c.send(DEV, "0x000000000000000000000000000000000000dEaD", "0x", { onBroadcast: () => { broadcastAt = Date.now(); setTimeout(() => void anvil.rpc("evm_mine", []), MINED_AFTER_MS); } });
  return Date.now() - broadcastAt;
}

test("a receipt is found within a poll of the rail's interval, not viem's 4 s, when the chain mines after the first look", async () => {
  const dir = freshDir("quick-receipts");
  const anvil = new Anvil({ bin: BIN, stateFile: join(dir, "never-written.hex"), pidFile: join(dir, "anvil.pid") });
  await anvil.start();
  try {
    const quick = await sendMinedLater(quickReceipts(new Chain$(anvil.url, CHAIN_ID)), anvil);
    const control = await sendMinedLater(new Chain$(anvil.url, CHAIN_ID), anvil);
    assert.ok(quick >= MINED_AFTER_MS && quick < MINED_AFTER_MS + 5 * LOCAL_RECEIPT_POLL_MS, `the rail's client waited ${quick} ms`);
    assert.ok(control >= 3_500, `the control (viem's default) waited ${control} ms; the check above would not tell the two apart`);
  } finally {
    await anvil.stop();
  }
});
