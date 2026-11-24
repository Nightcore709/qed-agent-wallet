/**
 * Test helpers: a local Anvil per test file (127.0.0.1 only, stopped when the file ends), a minimal JSON-RPC
 * client, artifacts. Anvil's unlocked development accounts are its published test keys on a throwaway chain.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abiEncode, bytesToHex, encodeCall, keccak256 } from '../webauthn.ts';
import type { Hex } from '../webauthn.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port free on 127.0.0.1: any, or the first free one in QED_ANVIL_PORTS ("from-to"), when a run must keep to a range. */
async function freePort(): Promise<number> {
  const range = /^(\d+)-(\d+)$/.exec(process.env.QED_ANVIL_PORTS ?? '');
  for (let want = range ? Number(range[1]) : 0; want <= (range ? Number(range[2]) : 0); want++) {
    const srv = createServer();
    srv.listen(want, '127.0.0.1');
    const ok = await new Promise<boolean>((resolve) => { srv.once('listening', () => resolve(true)); srv.once('error', () => resolve(false)); });
    if (!ok) continue;
    const port = (srv.address() as { port: number }).port;
    srv.close();
    await once(srv, 'close');
    if (!range || !used.has(port)) { used.add(port); return port; }
  }
  throw new Error(`no free port in QED_ANVIL_PORTS=${process.env.QED_ANVIL_PORTS}`);
}
const used = new Set<number>();

export interface Chain {
  url: string;
  chainId: bigint;
  proc: ChildProcess;
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();
process.once('exit', () => {
  for (const p of running) p.kill('SIGKILL');
});

export async function startAnvil(opts: { hardfork: string; chainId: number }): Promise<Chain> {
  const port = await freePort();
  const proc = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--hardfork', opts.hardfork, '--chain-id', String(opts.chainId), '--silent'],
    { stdio: 'ignore' },
  );
  running.add(proc);
  const url = `http://127.0.0.1:${port}`;
  let ok = false;
  for (let i = 0; i < 150 && !ok; i++) {
    try {
      await rpc(url, 'eth_chainId', []);
      ok = true;
    } catch {
      await sleep(100);
    }
  }
  if (!ok) throw new Error('anvil did not start');
  return {
    url,
    chainId: BigInt(opts.chainId),
    proc,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        await once(proc, 'exit');
      }
      running.delete(proc);
    },
  };
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: Hex | undefined;
  constructor(message: string, code: number, data: unknown) {
    super(message);
    this.code = code;
    this.data = typeof data === 'string' && data.startsWith('0x') ? (data as Hex) : undefined;
  }
}

export async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } };
  if (body.error) throw new RpcError(body.error.message, body.error.code, body.error.data);
  return body.result;
}

const qty = (v: bigint | number): Hex => `0x${BigInt(v).toString(16)}`;

export interface Receipt {
  status: Hex;
  gasUsed: Hex;
  contractAddress: Hex | null;
  transactionHash: Hex;
  blockNumber: Hex;
  logs: { address: Hex; topics: Hex[]; data: Hex }[];
}

export async function send(url: string, tx: { from: Hex; to?: Hex; data?: Hex; value?: bigint; gas?: bigint }): Promise<Receipt> {
  const hash: Hex = await rpc(url, 'eth_sendTransaction', [
    {
      from: tx.from,
      ...(tx.to ? { to: tx.to } : {}),
      data: tx.data ?? '0x',
      ...(tx.value ? { value: qty(tx.value) } : {}),
      ...(tx.gas ? { gas: qty(tx.gas) } : {}),
    },
  ]);
  for (let i = 0; i < 100; i++) {
    const r = (await rpc(url, 'eth_getTransactionReceipt', [hash])) as Receipt | null;
    if (r) return r;
    await sleep(20);
  }
  throw new Error(`no receipt for ${hash}`);
}

export async function call(url: string, tx: { from?: Hex; to: Hex; data: Hex }): Promise<Hex> {
  return rpc(url, 'eth_call', [{ ...(tx.from ? { from: tx.from } : {}), to: tx.to, data: tx.data }, 'latest']);
}

/** eth_call that must revert; returns the revert data. */
export async function revertData(url: string, tx: { from?: Hex; to: Hex; data: Hex }): Promise<Hex> {
  try {
    const out = await call(url, tx);
    throw new Error(`expected a revert, got ${out.slice(0, 74)}`);
  } catch (e) {
    if (e instanceof RpcError && e.data) return e.data;
    throw e;
  }
}

export async function deploy(url: string, from: Hex, creation: Hex, args: Hex = '0x'): Promise<{ address: Hex; receipt: Receipt }> {
  const receipt = await send(url, { from, data: (creation + args.slice(2)) as Hex, gas: 15_000_000n });
  if (receipt.status !== '0x1' || !receipt.contractAddress) throw new Error(`deployment failed: ${receipt.transactionHash}`);
  return { address: receipt.contractAddress, receipt };
}

export function artifact(file: string, name: string): Hex {
  const j = JSON.parse(readFileSync(join(ROOT, 'out', file, `${name}.json`), 'utf8')) as { bytecode: { object: Hex } };
  return j.bytecode.object;
}

/** Creation bytecode recorded with the release, as vendored in this workspace. */
export function releaseBytecode(name: 'QEDVault' | 'TestUSD' | 'QEDExecution' | 'QEDTreasuryPolicy'): Hex {
  const ts = readFileSync(join(ROOT, '..', 'vendor', 'agent', 'src', 'abi', 'contracts.ts'), 'utf8');
  const m = ts.match(new RegExp(`export const ${name}Bytecode = "(0x[0-9a-fA-F]+)"`));
  if (!m) throw new Error(`no ${name}Bytecode in contracts.ts`);
  return m[1] as Hex;
}

export async function increaseTime(url: string, seconds: bigint): Promise<void> {
  await rpc(url, 'evm_increaseTime', [Number(seconds)]);
  await rpc(url, 'evm_mine', []);
}

export async function now(url: string): Promise<bigint> {
  const b = (await rpc(url, 'eth_getBlockByNumber', ['latest', false])) as { timestamp: Hex };
  return BigInt(b.timestamp);
}

export const word = (h: Hex, i = 0): bigint => BigInt(`0x${h.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
export const wordHex = (h: Hex, i = 0): Hex => `0x${h.slice(2 + 64 * i, 2 + 64 * (i + 1))}`;
export const asAddress = (h: Hex, i = 0): Hex => `0x${h.slice(2 + 64 * i + 24, 2 + 64 * (i + 1))}`;

export function errorData(signature: string, types: string[] = [], values: unknown[] = []): Hex {
  return bytesToHex(new Uint8Array([...keccak256(signature).slice(0, 4), ...abiEncode(types, values)]));
}

export const view = async (url: string, to: Hex, signature: string, values: unknown[] = []): Promise<Hex> =>
  call(url, { to, data: encodeCall(signature, values) });
