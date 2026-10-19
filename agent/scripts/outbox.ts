/**
 * Exports every signed transaction mined so far on the local replica (in canonical block order) to
 * relay/outbox-<chainId>.json. Safe to run repeatedly while the replica is still running.
 *   ANVIL_PORT=8546 tsx agent/scripts/outbox.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";

const port = Number(process.env.ANVIL_PORT ?? 8546);
const pub = createPublicClient({ transport: http(`http://127.0.0.1:${port}`) });

async function main() {
  const chainId = await pub.getChainId();
  const last = await pub.getBlockNumber();
  const outbox: any[] = [];
  for (let b = 1n; b <= last; b++) {
    const block = await pub.getBlock({ blockNumber: b, includeTransactions: true });
    for (const tx of block.transactions as any[]) {
      const raw = (await (pub as any).request({ method: "eth_getRawTransactionByHash", params: [tx.hash] })) as Hex;
      const r = await pub.getTransactionReceipt({ hash: tx.hash });
      const minGas = process.env.MIN_GAS ? BigInt(process.env.MIN_GAS) : 0n;
      if (BigInt(tx.gas) < minGas) throw new Error(`tx ${tx.hash} from ${tx.from} has gas ${tx.gas} < ${minGas} — refusing to export`);
      outbox.push({
        i: outbox.length,
        hash: tx.hash,
        gas: tx.gas.toString(),
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        shadowBlock: Number(b),
        shadowTimestamp: Number(block.timestamp),
        shadowStatus: r.status,
        shadowGasUsed: r.gasUsed.toString(),
        shadowLogs: r.logs.map((l) => ({ address: l.address.toLowerCase(), topics: l.topics, data: l.data })),
        contractAddress: r.contractAddress ?? null,
        raw,
      });
    }
  }
  mkdirSync("relay", { recursive: true });
  writeFileSync(`relay/outbox-${chainId}.json`, JSON.stringify(outbox, null, 1));
  console.log(`exported ${outbox.length} txs (blocks 1..${last}) → relay/outbox-${chainId}.json`);
}
main();
