/**
 * Chain access for every role. One small abstraction over viem that:
 *   • sends a transaction from a role's OWN key and waits for the receipt;
 *   • can deliberately broadcast a transaction that is expected to REVERT (so that attacks leave
 *     permanent, independently checkable failure receipts on the public chain), after first
 *     capturing the exact custom error via simulation;
 *   • decodes every event and custom error against the QED ABIs.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeDeployData,
  defineChain,
  encodeFunctionData,
  http,
  BaseError,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { MaximalityBountyAbi, QEDExecutionAbi, CPMMPoolAbi, ExecutionBountyAbi, QEDTreasuryPolicyAbi, MinVarianceVerifierAbi, OptimalityBountyAbi, PrivateMinVarianceVerifierAbi, ProofEscrowAbi, QEDClearingAbi, QEDVaultAbi, TestUSDAbi } from "./abi/contracts.js";

export const ALL_ABIS: Abi[] = [QEDVaultAbi as Abi, ProofEscrowAbi as Abi, MinVarianceVerifierAbi as Abi, QEDClearingAbi as Abi, TestUSDAbi as Abi, PrivateMinVarianceVerifierAbi as Abi, OptimalityBountyAbi as Abi, MaximalityBountyAbi as Abi, QEDExecutionAbi as Abi, CPMMPoolAbi as Abi, ExecutionBountyAbi as Abi, QEDTreasuryPolicyAbi as Abi];

export const baseSepolia = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://base-sepolia.blockscout.com" } },
  testnet: true,
});

export function chainFor(chainId: number, rpcUrl: string): Chain {
  if (chainId === 84532) return { ...baseSepolia, rpcUrls: { default: { http: [rpcUrl] } } };
  return defineChain({
    id: chainId,
    name: chainId === 31337 ? "Anvil" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface DecodedEvent {
  name: string;
  args: Record<string, unknown>;
  address: Address;
}

export interface DecodedError {
  name: string;
  args: readonly unknown[];
  selector: Hex;
}

export interface TxResult {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  from: Address;
  to: Address | null;
  events: DecodedEvent[];
  error?: DecodedError;
}

export interface FeeOverride {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Optional fixed gas limit for every transaction (GAS_LIMIT env). Used for networks whose gas schedule
 *  differs from the local EVM used for simulation (e.g. Sepolia's state-creation repricing): only gas
 *  actually used is charged, and our contracts contain no gas-dependent logic. */
const FIXED_GAS = process.env.GAS_LIMIT ? BigInt(process.env.GAS_LIMIT) : undefined;
if (process.env.REQUIRE_FIXED_GAS === "1" && !FIXED_GAS) {
  // Fail fast: a process that will broadcast to a network with a different gas schedule must never
  // fall back to local estimates (this exact mistake once cost a test run an out-of-gas revert).
  throw new Error("REQUIRE_FIXED_GAS=1 but GAS_LIMIT is not set in this process");
}

export class Chain$ {
  readonly pub: PublicClient;
  readonly chain: Chain;
  constructor(
    readonly rpcUrl: string,
    readonly chainId: number,
    readonly fees?: FeeOverride,
    readonly confirmations = 1,
  ) {
    this.chain = chainFor(chainId, rpcUrl);
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpcUrl, { retryCount: 6, retryDelay: 800 }) }) as PublicClient;
  }

  wallet(account: LocalAccount) {
    return createWalletClient({ account, chain: this.chain, transport: http(this.rpcUrl, { retryCount: 6, retryDelay: 800 }) });
  }

  /** Shadow mode: keep the local replica's clock on wall-clock time so signed validity windows behave
   *  exactly as they will on the public chain when the same signed bytes are relayed. */
  async syncClock() {
    if (process.env.SHADOW !== "1") return;
    const latest = await this.pub.getBlock();
    const target = Math.max(Math.floor(Date.now() / 1000), Number(latest.timestamp) + 1);
    await (this.pub as any).request({ method: "evm_setNextBlockTimestamp", params: [`0x${target.toString(16)}`] });
  }

  /** Deploy a contract from `account` and require success. */
  async deploy(account: LocalAccount, abi: Abi, bytecode: Hex, args: readonly unknown[] = []): Promise<TxResult & { address: Address }> {
    const data = (args.length ? encodeDeployData({ abi, bytecode, args } as any) : bytecode) as Hex;
    await this.syncClock();
    const est = await this.pub.estimateGas({ account, data });
    const hash = await this.wallet(account).sendTransaction({ account, chain: this.chain, data, gas: FIXED_GAS ?? (est * 12n) / 10n + 50_000n, ...(this.fees ?? {}) } as any);
    const r = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 180_000 });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deployment ${hash} failed`);
    return { ...this.toResult(r, account.address), address: r.contractAddress };
  }

  /** Send and require success. */
  async send(account: LocalAccount, to: Address, data: Hex, opts: { value?: bigint; gas?: bigint } = {}): Promise<TxResult> {
    await this.syncClock();
    const est = opts.gas ?? (await this.pub.estimateGas({ account, to, data, value: opts.value }));
    const gas = FIXED_GAS ?? opts.gas ?? (est * 13n) / 10n + 20_000n;
    const hash = await this.wallet(account).sendTransaction({
      account,
      chain: this.chain,
      to,
      data,
      value: opts.value,
      gas,
      ...(this.fees ?? {}),
    });
    const r = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 180_000 });
    const res = this.toResult(r, account.address);
    if (res.status !== "success") throw new Error(`transaction ${hash} reverted unexpectedly`);
    return res;
  }

  /**
   * Broadcast a transaction that MUST revert. First simulates it to capture the precise custom error,
   * then sends it on-chain with an explicit gas limit so the failure is recorded in a public receipt.
   */
  async sendExpectingRevert(account: LocalAccount, to: Address, data: Hex, gasArg = 700_000n): Promise<TxResult> {
    const gas = FIXED_GAS ?? gasArg;
    const error = await this.simulateError(account.address, to, data);
    if (!error) throw new Error("expected a revert but simulation succeeded — refusing to broadcast");
    await this.syncClock();
    const hash = await this.wallet(account).sendTransaction({ account, chain: this.chain, to, data, gas, ...(this.fees ?? {}) });
    const r = await this.pub.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: 180_000 });
    const res = this.toResult(r, account.address);
    if (res.status !== "reverted") throw new Error(`transaction ${hash} was expected to revert but succeeded`);
    res.error = error;
    return res;
  }

  /** Returns the decoded custom error a call would revert with, or undefined if it would succeed. */
  async simulateError(from: Address, to: Address, data: Hex, blockNumber?: bigint): Promise<DecodedError | undefined> {
    try {
      await this.pub.call({ account: from, to, data, gas: 3_000_000n, ...(blockNumber !== undefined ? { blockNumber } : {}) });
      return undefined;
    } catch (e) {
      return decodeRevert(e);
    }
  }

  toResult(r: TransactionReceipt, from: Address): TxResult {
    return {
      hash: r.transactionHash,
      status: r.status,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      from,
      to: r.to,
      events: decodeLogs(r.logs as any),
    };
  }
}

export function decodeLogs(logs: { address: Address; data: Hex; topics: [Hex, ...Hex[]] }[]): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of logs) {
    for (const abi of ALL_ABIS) {
      try {
        const d = decodeEventLog({ abi, data: log.data, topics: log.topics });
        out.push({ name: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown>, address: log.address });
        break;
      } catch {
        /* try next ABI */
      }
    }
  }
  return out;
}

export function decodeRevert(e: unknown): DecodedError {
  let data: Hex | undefined;
  if (e instanceof BaseError) {
    const inner = e.walk((x: any) => typeof x?.data === "string" && x.data.startsWith("0x")) as any;
    data = inner?.data;
  }
  if (!data && typeof (e as any)?.data === "string") data = (e as any).data;
  if (!data || data === "0x") return { name: "UnknownRevert", args: [String((e as any)?.message ?? e).slice(0, 200)], selector: "0x" as Hex };
  for (const abi of ALL_ABIS) {
    try {
      const d = decodeErrorResult({ abi, data });
      return { name: d.errorName, args: (d.args ?? []) as readonly unknown[], selector: data.slice(0, 10) as Hex };
    } catch {
      /* next */
    }
  }
  return { name: "UndecodedRevert", args: [data], selector: data.slice(0, 10) as Hex };
}

export const fn = <A extends Abi>(abi: A, functionName: string, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: abi as Abi, functionName, args } as any);

export const fmtUsd = (x: bigint): string => {
  const neg = x < 0n;
  const v = neg ? -x : x;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${frac}`;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
