/**
 * Rebuilding public state on a local replica by replaying signed transactions byte for byte.
 *
 * Later runs build on earlier ones (Run 4b on Run 4, Run 4c on both). The replica starts from the exact pre-state
 * of the first run (the runtime code of the main-run token and lens, every signer's nonce and ETH), then replays the
 * relayed outboxes in order. Every replayed transaction must produce the same hash and status as on Sepolia, so the
 * replica's state is Sepolia's state at the end of those runs.
 */
import { readFileSync } from "node:fs";
import { toHex, type Address, type Hex } from "viem";
import { QEDLensBytecode, TestUSDBytecode } from "./abi/contracts.js";
import type { Chain$ } from "./chain.js";

export interface StartState {
  [address: string]: { nonce: number; wei: string };
}

export async function rebuildFromOutboxes(c: Chain$, main: { token: Address; lens: Address }, start: StartState, outboxes: string[]): Promise<number> {
  const rpc = (method: string, params: unknown[]) => (c.pub as any).request({ method, params });
  const runtime = async (bytecode: Hex) => (await c.pub.call({ data: bytecode })).data as Hex;
  await rpc("anvil_setCode", [main.token, await runtime(TestUSDBytecode as Hex)]);
  await rpc("anvil_setCode", [main.lens, await runtime(QEDLensBytecode as Hex)]);
  for (const [addr, s] of Object.entries(start)) {
    await rpc("anvil_setNonce", [addr, toHex(s.nonce)]);
    await rpc("anvil_setBalance", [addr, toHex(BigInt(s.wei))]);
  }
  let n = 0;
  for (const file of outboxes) {
    for (const t of JSON.parse(readFileSync(file, "utf8"))) {
      await c.syncClock();
      const h = (await rpc("eth_sendRawTransaction", [t.raw])) as Hex;
      const r = await c.pub.waitForTransactionReceipt({ hash: h });
      if (h.toLowerCase() !== t.hash.toLowerCase() || r.status !== t.shadowStatus) throw new Error(`replay of ${file} diverged at ${t.i}: ${r.status} vs ${t.shadowStatus}`);
      n++;
    }
  }
  return n;
}
