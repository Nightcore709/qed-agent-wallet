/**
 * QED Sandbox — one persistent local chain that the browser app operates on, step by step.
 *
 * Boots Anvil (chain 31337, valueless tokens), deploys the same best-execution economy as Run 4 (three tokens,
 * five owner-approved constant-product venues, the unchanged QEDVault as tUSD treasury and as tEUR reserve,
 * QEDExecution as the vault's agent), and keeps it running. Every operation is the real QED pipeline:
 *
 *   language model (or labelled offline parser) → guard → mandate limits → owner confirmation (sandbox owner key)
 *   → independent co-signer (PolicyEngine re-quotes and signs an order) → certified route + dual prices
 *   → QEDExecution.trade on-chain → receipt → reconciliation against the reserve's balance.
 *
 * Nothing here can sign with a real key: every role key is a deterministic development key derived in-process,
 * valid only on this disposable chain. The AI never sees a key; it can only propose.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, keccak256, parseEther, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CPMMPoolAbi, CPMMPoolBytecode, QEDExecutionAbi, QEDExecutionBytecode, QEDLensAbi, QEDLensBytecode, QEDVaultAbi, QEDVaultBytecode, TestTokenAbi, TestTokenBytecode, TestUSDAbi, TestUSDBytecode } from "./abi/contracts.js";
import { Chain$, fn, type TxResult } from "./chain.js";
import { bestSingleVenue, optimalDirectOnly, simulate, solve, type Hop } from "./engine/execution.js";
import { DECIMALS, EXEC_VENUES, raw, type Sym } from "./engine/executionScenario.js";
import { POLICY } from "./engine/economics.js";
import { decide, hashOrder, hopsForChain, planTrade, pricesForChain, readVenues, type Order, type TradePlan } from "./roles/trader.js";
import { PolicyEngine, ownerTradeMessage, type TradeResponse } from "./roles/cosigner.js";
import { decideTranche, observeTreasury, policyMessage, type TreasuryPolicy } from "./roles/treasury.js";
import { mandateHash, signMandate, type Mandate } from "./protocol/eip712.js";
import { guard, makeBrain, type Brain, type ChatContext, type PayeeBookEntry } from "./brain/index.js";

/** Exactly one explicit tUSD amount in the text (6 decimals at most), else undefined. */
export function explicitAmount(text: string): bigint | undefined {
  const ms = [...text.matchAll(/(?:\$\s*)?\b(\d{1,7}(?:\.\d{1,6})?)\s*(?:t?usd|dollars?)?(?![\d.])/gi)].map((m) => m[1]);
  const uniq = [...new Set(ms.map(Number))];
  if (uniq.length !== 1) return undefined;
  const [w, f = ""] = ms[0].split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

const ROLES = ["DEPLOYER", "OWNER", "OPERATOR", "COSIGNER", "GUARDIAN", "LP1", "LP2", "LP3", "MALLORY", "CLOUDCO"] as const;
type Role = (typeof ROLES)[number];
const CHAIN_ID = 31337;
const U = (x: number) => raw("tUSD", x);
export const fmt6 = (x: bigint) => (Number(x) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const ppm = (out: bigint, bound: bigint) => (bound > 0n ? (Number(bound - out) / Number(bound)) * 1e6 : 0);
export const ser = (v: unknown): any => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export type StepStatus = "ok" | "refused" | "reverted" | "pending" | "info";
export interface Step {
  key: string; // interpret | mandate | owner | cosigner | plan | submit | receipt | reconcile | decide | attack
  label: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
  at: string;
}
export type Emit = (s: Step) => void;
export interface OpResult {
  outcome: "executed" | "refused" | "reverted" | "no-action" | "error";
  summary: string;
  steps: Step[];
  tx?: { hash: Hex; status: string; block: string; gasUsed: string; error?: string };
}
export interface HistoryEntry {
  n: number;
  at: string;
  kind: "conversion" | "policy-tick" | "attack" | "mandate" | "policy" | "refusal" | "reset";
  title: string;
  outcome: OpResult["outcome"];
  tx?: OpResult["tx"];
  trade?: { amountIn: string; amountOut: string; bound: string; gapPpm: number; hops: number; venues: number[] };
}

const ATTACKS = {
  "inferior-route": { title: "Route over the direct pools only (what a single-pair router would pick)", expect: "NotBestExecution", layer: "QEDExecution: realised output below the dual bound" },
  skim: { title: "Skim: the optimal route with 5% of one leg moved", expect: "NotBestExecution", layer: "QEDExecution: 1 ppm tolerance" },
  "forged-proof": { title: "“Forged proof”: prices chosen to make the direct route look optimal", expect: "NotBestExecution", layer: "Weak duality: any price vector is a valid upper bound" },
  "single-pool": { title: "Everything through one pool (the naive router)", expect: "NotBestExecution", layer: "Dual bound (and the co-signed floor, if the output falls below it)" },
  redirect: { title: "Redirect the order's output to Mallory", expect: "OrderMismatch", layer: "Co-signer certificate commits to the order hash" },
  "stolen-order": { title: "Mallory replays the genuine co-signed order without the agent key", expect: "NotOperator", layer: "Only the operator key may trade" },
} as const;
export type AttackKind = keyof typeof ATTACKS;
export const ATTACK_KINDS = Object.keys(ATTACKS) as AttackKind[];

export class Sandbox {
  status: "starting" | "ready" | "failed" = "starting";
  error: string | null = null;
  startedAt = new Date().toISOString();
  resets = 0;
  history: HistoryEntry[] = [];
  lastTrade: Record<string, unknown> | null = null;
  brain: Brain = makeBrain();
  private anvil?: ChildProcess;
  private c!: Chain$;
  private K!: Record<Role, LocalAccount>;
  private a!: { usd: Address; eur: Address; eth: Address; lens: Address; vault: Address; reserve: Address; exec: Address; pools: Address[]; deployBlock: bigint };
  private snapshotId: Hex | null = null;
  private mandate!: Mandate;
  private ownerSig!: Hex;
  private mandateVersion = 1;
  private policy: TreasuryPolicy | null = null;
  private policySig: Hex | null = null;
  private policyTicks = 0;
  private cosigner!: PolicyEngine;
  private book!: PayeeBookEntry[];
  private nonceN = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private port = Number(process.env.QED_SANDBOX_PORT ?? 8745), private recordsDir = process.env.QED_SANDBOX_RECORDS ?? "evidence/demo-runs/sandbox") {}

  // ───────────────────────────── lifecycle ─────────────────────────────
  async start(): Promise<void> {
    try {
      mkdirSync(`${this.recordsDir}/records`, { recursive: true });
      this.anvil = spawn("anvil", ["--port", String(this.port), "--chain-id", String(CHAIN_ID), "--hardfork", "osaka", "--base-fee", "21", "--gas-limit", "60000000", "--silent"], { stdio: "ignore" });
      this.anvil.on("exit", (code) => {
        if (this.status !== "failed") {
          this.status = "failed";
          this.error = `local chain exited (${code})`;
        }
      });
      const rpcUrl = `http://127.0.0.1:${this.port}`;
      this.c = new Chain$(rpcUrl, CHAIN_ID, { maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 10_000_000n });
      for (let i = 0; i < 150; i++) {
        try {
          await this.c.pub.getChainId();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      this.K = Object.fromEntries(ROLES.map((r) => [r, privateKeyToAccount(keccak256(toHex(`qed-sandbox-${r}`)))])) as Record<Role, LocalAccount>;
      await this.deploy();
      this.snapshotId = await this.rpc("evm_snapshot", []);
      await this.signMandate(25);
      this.status = "ready";
    } catch (e) {
      this.status = "failed";
      this.error = (e as Error).message.slice(0, 300);
      throw e;
    }
  }

  stop() {
    this.anvil?.kill("SIGTERM");
  }

  private rpc(method: string, params: unknown[]): Promise<any> {
    return (this.c.pub as any).request({ method, params });
  }

  private async deploy() {
    const { c, K } = this;
    for (const r of ["DEPLOYER", "OWNER", "OPERATOR", "LP1", "LP2", "LP3", "MALLORY"] as const) await this.rpc("anvil_setBalance", [K[r].address, toHex(parseEther("10"))]);
    const usd = getAddress((await c.deploy(K.DEPLOYER, TestUSDAbi as any, TestUSDBytecode as Hex)).address);
    const lens = getAddress((await c.deploy(K.DEPLOYER, QEDLensAbi as any, QEDLensBytecode as Hex)).address);
    const eurD = await c.deploy(K.DEPLOYER, TestTokenAbi as any, TestTokenBytecode as Hex, ["QED Test Euro", "tEUR", 6]);
    const eur = getAddress(eurD.address);
    const eth = getAddress((await c.deploy(K.DEPLOYER, TestTokenAbi as any, TestTokenBytecode as Hex, ["QED Test Ether", "tETH", 18])).address);
    const TOK: Record<Sym, Address> = { tUSD: usd, tEUR: eur, tETH: eth };
    const pools: Address[] = [];
    for (const v of EXEC_VENUES) pools.push(getAddress((await c.deploy(K.DEPLOYER, CPMMPoolAbi as any, CPMMPoolBytecode as Hex, [TOK[v.a], TOK[v.b], v.feeBps])).address));
    const vault = getAddress((await c.deploy(K.DEPLOYER, QEDVaultAbi as any, QEDVaultBytecode as Hex, [usd, K.OWNER.address, K.OPERATOR.address, K.COSIGNER.address, K.GUARDIAN.address, U(100)])).address);
    const reserve = getAddress((await c.deploy(K.DEPLOYER, QEDVaultAbi as any, QEDVaultBytecode as Hex, [eur, K.OWNER.address, K.OPERATOR.address, K.COSIGNER.address, K.GUARDIAN.address, 0n])).address);
    const exec = getAddress((await c.deploy(K.DEPLOYER, QEDExecutionAbi as any, QEDExecutionBytecode as Hex, [vault, K.OPERATOR.address])).address);
    await c.send(K.OWNER, vault, fn(QEDVaultAbi, "setAgent", [exec]));
    await c.send(K.OWNER, exec, fn(QEDExecutionAbi, "setVenues", [pools, EXEC_VENUES.map((v) => v.feeBps)]));
    for (const lp of ["LP1", "LP2", "LP3"] as const) await c.send(K[lp], usd, fn(TestUSDAbi, "faucet"));
    const usdSource: Record<number, Role> = { 0: "LP1", 1: "LP2", 2: "LP2", 4: "LP3" };
    for (const [i, v] of EXEC_VENUES.entries()) {
      for (const [sym, amt] of [[v.a, v.ra], [v.b, v.rb]] as const) {
        const r = raw(sym, amt);
        if (sym === "tUSD") await c.send(K[usdSource[i]], usd, fn(TestUSDAbi, "transfer", [pools[i], r]));
        else await c.send(K.DEPLOYER, TOK[sym], fn(TestTokenAbi, "mint", [pools[i], r]));
      }
      await c.send(K.DEPLOYER, pools[i], fn(CPMMPoolAbi, "sync"));
    }
    await c.send(K.LP3, usd, fn(TestUSDAbi, "transfer", [vault, U(100)]));
    this.a = { usd, eur, eth, lens, vault, reserve, exec, pools, deployBlock: eurD.blockNumber };
    this.book = [
      { label: "Euro reserve", aliases: ["euro reserve", "eur reserve", "reserve", "euro", "teur", "eur"], address: reserve, approved: true },
      { label: "CloudCo", aliases: ["cloudco", "cloud co"], address: K.CLOUDCO.address, approved: true },
    ];
    this.newCosigner();
  }

  private newCosigner() {
    this.cosigner = new PolicyEngine(this.c, this.K.COSIGNER, { vault: this.a.vault, lens: this.a.lens, escrow: this.a.vault, owner: this.K.OWNER.address, vendorKeys: {}, catalogPrices: {}, denylist: [this.K.MALLORY.address], deployBlock: this.a.deployBlock, recordsDir: `${this.recordsDir}/records` } as any);
  }

  /** Serialise every chain-mutating operation: one shared sandbox, one writer at a time. */
  exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.status !== "ready") return Promise.reject(new Error(this.status === "starting" ? "The sandbox chain is still starting; try again in a few seconds." : `The sandbox chain is unavailable: ${this.error}`));
    if (this.pending >= 4) return Promise.reject(new Error("The sandbox is busy with other requests; try again shortly."));
    this.pending++;
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => undefined).finally(() => this.pending--);
    return run;
  }

  private record(e: Omit<HistoryEntry, "n" | "at">) {
    this.history.push({ n: this.history.length + 1, at: new Date().toISOString(), ...e });
    if (this.history.length > 200) this.history.shift();
  }

  async reset(): Promise<OpResult> {
    return this.exclusive(async () => {
      if (!this.snapshotId) throw new Error("no snapshot");
      await this.rpc("evm_revert", [this.snapshotId]);
      this.snapshotId = await this.rpc("evm_snapshot", []);
      this.resets++;
      this.history = [];
      this.lastTrade = null;
      this.policy = null;
      this.policySig = null;
      this.policyTicks = 0;
      this.mandateVersion = 0;
      this.newCosigner();
      await this.signMandate(25);
      this.record({ kind: "reset", title: "Sandbox reset to its initial state: 100 tUSD in the treasury, empty euro reserve, mandate v1 (≤ 25 tUSD per conversion)", outcome: "no-action" });
      return { outcome: "no-action", summary: "Sandbox reset.", steps: [] };
    });
  }

  // ───────────────────────────── owner authority ─────────────────────────────
  private async signMandate(maxPerPayment: number) {
    const now = BigInt((await this.c.pub.getBlock()).timestamp);
    this.mandateVersion++;
    this.mandate = {
      vault: this.a.vault,
      agent: this.a.exec,
      payees: [this.a.exec, this.a.reserve, this.K.CLOUDCO.address],
      maxPerPayment: U(maxPerPayment),
      maxPerPeriod: U(100),
      period: 86_400n,
      maxTotal: U(200),
      validFrom: now - 60n,
      validUntil: now + 7n * 86_400n,
      epoch: 0n,
      requireCosign: true,
      purpose: keccak256(toHex("Convert surplus tUSD into the euro operating reserve, with best execution proved on-chain")),
      salt: keccak256(toHex(`qed-sandbox-mandate-${this.resets}-${this.mandateVersion}`)),
    } as Mandate;
    this.ownerSig = await signMandate(this.K.OWNER, CHAIN_ID, this.mandate);
  }

  /** The sandbox owner signs a new mandate. Bounded by the vault's own on-chain daily cap (100 tUSD). */
  async setMandate(maxPerPayment: number): Promise<OpResult> {
    if (!(maxPerPayment >= 1 && maxPerPayment <= 100 && Number.isFinite(maxPerPayment))) throw new Error("The sandbox owner may sign a per-conversion limit between 1 and 100 tUSD (the vault's on-chain daily cap is 100).");
    return this.exclusive(async () => {
      const prev = Number(this.mandate.maxPerPayment) / 1e6;
      await this.signMandate(Math.round(maxPerPayment * 1e6) / 1e6);
      const title = `Owner signed mandate v${this.mandateVersion}: ≤ ${maxPerPayment} tUSD per conversion (was ${prev}), ≤ 100 a day, payees unchanged`;
      this.record({ kind: "mandate", title, outcome: "executed" });
      const step: Step = { key: "owner", label: "Owner signs mandate (EIP-712)", status: "ok", detail: `Signed by the sandbox owner key ${this.K.OWNER.address.slice(0, 10)}… held by this demo server. In production the owner signs in their own wallet; the AI can never do this.`, data: { mandateHash: mandateHash(this.mandate) }, at: new Date().toISOString() };
      return { outcome: "executed", summary: title, steps: [step] };
    });
  }

  /** The sandbox owner signs a standing treasury policy (EIP-191), as in Run 4c. */
  async setPolicy(targetFree: number): Promise<OpResult> {
    if (!(targetFree >= 2 && targetFree <= 80)) throw new Error("Choose a reserve target between 2 and 80 tEUR.");
    return this.exclusive(async () => {
      const now = BigInt((await this.c.pub.getBlock()).timestamp);
      this.policyTicks = 0;
      this.policy = { vault: this.a.vault, reserve: this.a.reserve, tokenIn: this.a.usd, tokenOut: this.a.eur, targetFree: BigInt(Math.round(targetFree * 1e6)), maxTranche: 25_000_000n, minTranche: 2_000_000n, maxImpactBps: 150, validUntil: now + 30n * 86_400n, nonce: `sandbox-policy-${this.resets}-${this.history.length}` };
      this.policySig = await this.K.OWNER.signMessage({ message: policyMessage(this.policy) });
      const title = `Owner signed a standing policy: keep ≥ ${targetFree} tEUR free in the euro reserve; tranches 2–25 tUSD; ≤ 1.5% execution cost`;
      this.record({ kind: "policy", title, outcome: "executed" });
      return { outcome: "executed", summary: title, steps: [{ key: "owner", label: "Owner signs standing policy (EIP-191)", status: "ok", detail: "From now on the agent decides when and how much to convert. The co-signer re-derives every decision before it signs.", at: new Date().toISOString() }] };
    });
  }

  // ───────────────────────────── reads ─────────────────────────────
  private async snap(v: Address) {
    return (await this.c.pub.readContract({ address: this.a.lens, abi: QEDLensAbi, functionName: "snapshot", args: [v] })) as any;
  }
  private async bal(t: Address, who: Address) {
    return (await this.c.pub.readContract({ address: t, abi: TestUSDAbi, functionName: "balanceOf", args: [who] })) as bigint;
  }
  private async context(): Promise<ChatContext> {
    const s = await this.snap(this.a.vault);
    return { balance: s.balance, protectedBalance: s.protectedBalance, free: s.freeBalance, blastRadius24h: s.blastRadius24h, dailyCap: s.dailyCap, spentInWindow: s.spentInWindow, paused: s.paused, payees: this.book };
  }

  async state() {
    if (this.status !== "ready") return { status: this.status, error: this.error };
    const [v, r, block, venues] = await Promise.all([this.snap(this.a.vault), this.snap(this.a.reserve), this.c.pub.getBlock(), readVenues(this.c.pub, this.a.exec)]);
    const sym = (t: Address) => (getAddress(t) === this.a.usd ? "tUSD" : getAddress(t) === this.a.eur ? "tEUR" : "tETH");
    const windowLeft = (() => {
      const cap = v.dailyCap < this.mandate.maxPerPeriod ? v.dailyCap : this.mandate.maxPerPeriod;
      return cap > v.spentInWindow ? cap - v.spentInWindow : 0n;
    })();
    return ser({
      status: this.status,
      network: { chainId: CHAIN_ID, name: "QED sandbox · local Anvil chain", block: block.number, timestamp: block.timestamp, valueless: true },
      startedAt: this.startedAt,
      resets: this.resets,
      ai: { engine: this.brain.engine, live: this.brain.engine.startsWith("anthropic") },
      roles: { owner: this.K.OWNER.address, agent: this.K.OPERATOR.address, cosigner: this.K.COSIGNER.address, attacker: this.K.MALLORY.address, creditor: this.K.CLOUDCO.address },
      contracts: { vault: this.a.vault, reserve: this.a.reserve, execution: this.a.exec, tUSD: this.a.usd, tEUR: this.a.eur, tETH: this.a.eth, lens: this.a.lens },
      treasury: { token: "tUSD", balance: v.balance, ringFenced: v.protectedBalance, free: v.freeBalance, dailyCap: v.dailyCap, spentInWindow: v.spentInWindow, blastRadius24h: v.blastRadius24h, paused: v.paused, availableToday: windowLeft },
      reserve: { token: "tEUR", balance: r.balance, ringFenced: r.protectedBalance, free: r.freeBalance },
      mandate: { version: this.mandateVersion, hash: mandateHash(this.mandate), maxPerPayment: this.mandate.maxPerPayment, maxPerPeriod: this.mandate.maxPerPeriod, maxTotal: this.mandate.maxTotal, validUntil: this.mandate.validUntil, requireCosign: true, payees: ["QEDExecution (conversion module)", "Euro reserve", "CloudCo"] },
      policy: this.policy ? { targetFree: this.policy.targetFree, minTranche: this.policy.minTranche, maxTranche: this.policy.maxTranche, maxImpactBps: this.policy.maxImpactBps, ticks: this.policyTicks } : null,
      venues: venues.map((x, i) => ({ i, label: EXEC_VENUES[i].label, pool: this.a.pools[i], feeBps: x.feeBps, token0: sym(x.token0), token1: sym(x.token1), r0: x.r0, r1: x.r1 })),
      lastTrade: this.lastTrade,
      history: this.history.slice(-40).reverse(),
      attacks: ATTACK_KINDS.map((k) => ({ kind: k, ...ATTACKS[k] })),
    });
  }

  /** What would happen to a conversion of `amount` under the signed limits — without sending anything. */
  async checkLimits(amount: bigint) {
    const ctx = await this.context();
    const cap = ctx.dailyCap < this.mandate.maxPerPeriod ? ctx.dailyCap : this.mandate.maxPerPeriod;
    const windowLeft = cap > ctx.spentInWindow ? cap - ctx.spentInWindow : 0n;
    const checks = [
      { rule: "Per-conversion limit in the owner's signed mandate", limit: this.mandate.maxPerPayment, pass: amount <= this.mandate.maxPerPayment },
      { rule: "Left in today's spending window (vault cap and mandate)", limit: windowLeft, pass: amount <= windowLeft },
      { rule: `Free treasury balance, keeping the ${fmt6(POLICY.reserveBuffer)} tUSD buffer the co-signer requires`, limit: ctx.free > POLICY.reserveBuffer ? ctx.free - POLICY.reserveBuffer : 0n, pass: amount + POLICY.reserveBuffer <= ctx.free },
      { rule: "Amount is positive and at most 6 decimals", limit: 1n, pass: amount > 0n },
    ];
    return { amount, checks, allowed: checks.every((c) => c.pass) };
  }

  /** The language layer reads an instruction against live treasury state; it can only propose. */
  async interpret(text: string) {
    const ctx = await this.context();
    const { result, transcript } = await this.brain.interpret(text, ctx, "owner");
    const g = guard(text, result, ctx, this.mandate.maxPerPayment);
    return { g, transcript };
  }

  // ───────────────────────────── conversion: the full pipeline ─────────────────────────────
  async convert(instruction: string, emit: Emit = () => {}): Promise<OpResult> {
    return this.exclusive(() => this.convertInner(instruction, emit));
  }

  private async convertInner(instruction: string, emit: Emit): Promise<OpResult> {
    const steps: Step[] = [];
    const push = (s: Omit<Step, "at">) => {
      const st = { ...s, at: new Date().toISOString() };
      steps.push(st);
      emit(st);
      return st;
    };
    const refuse = (summary: string): OpResult => {
      this.record({ kind: "refusal", title: summary, outcome: "refused" });
      return { outcome: "refused", summary, steps };
    };
    const { usd, eur, reserve, exec, vault } = this.a;

    // 1 · language layer
    const { g, transcript } = await this.interpret(instruction);
    const p = g.proposal;
    // The owner's own number governs: if the language layer clamped or changed it, we check (and refuse) the
    // amount the owner wrote rather than silently executing a different one.
    const explicit = explicitAmount(instruction);
    const toReserve = (p && p.kind === "pay" && p.payee && getAddress(p.payee) === reserve) || (explicit !== undefined && /\b(convert|move|swap|exchange|top ?up|put)\b/i.test(instruction) && /\b(t?eur|euros?|reserve)\b/i.test(instruction));
    const amountIn = explicit ?? (p && p.kind === "pay" ? p.amount : undefined);
    const dangerous = (g.flags || []).filter((f) => ["privilege_escalation", "data_extraction", "prompt_injection", "induced_transfer"].includes(f));
    const isConversion = !!toReserve && !!amountIn && amountIn > 0n && dangerous.length === 0;
    push({ key: "interpret", label: "AI interprets the instruction", status: isConversion ? "ok" : "refused", detail: isConversion ? `${transcript.engine} reads: convert ${fmt6(amountIn!)} tUSD into the euro reserve (an approved payee from the owner's book). It proposes; it cannot sign.` : `${transcript.engine} did not produce an acceptable conversion into the euro reserve${dangerous.length ? ` (flagged: ${dangerous.join(", ")})` : ""}: ${g.reply}`, data: { engine: transcript.engine, intent: g.intent, flags: g.flags } });
    if (!isConversion) return refuse(`No conversion: ${g.reply}`);

    // 2 · signed limits
    const lim = await this.checkLimits(amountIn);
    push({ key: "mandate", label: "Signed mandate and vault limits", status: lim.allowed ? "ok" : "refused", detail: lim.allowed ? `Within the owner's mandate v${this.mandateVersion}: ≤ ${fmt6(this.mandate.maxPerPayment)} tUSD per conversion, today's window and the free balance.` : lim.checks.filter((c) => !c.pass).map((c) => `${c.rule}: ${fmt6(amountIn)} > ${fmt6(c.limit)} tUSD`).join("; ") + ". The AI cannot raise a limit; only the owner can sign a new mandate.", data: ser({ checks: lim.checks }) });
    if (!lim.allowed) return refuse(`Refused before signing: ${fmt6(amountIn)} tUSD breaks the signed limits. No transaction was sent.`);

    // 3 · owner confirms this exact conversion
    const nonce = `sandbox-${this.resets}-${++this.nonceN}`;
    const instructionSig = await this.K.OWNER.signMessage({ message: ownerTradeMessage(vault, amountIn, usd, eur, reserve, nonce) });
    push({ key: "owner", label: "Owner confirms the exact conversion", status: "ok", detail: `Sandbox owner key signs “${fmt6(amountIn)} tUSD → tEUR into the euro reserve” (EIP-191, nonce ${nonce}).`, data: { signer: this.K.OWNER.address } });

    // 4 · independent co-signer
    const r: TradeResponse = await this.cosigner.evaluateTrade({ mandate: this.mandate, ownerSig: this.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn, instruction, nonce, instructionSig, brainEngine: transcript.engine });
    push({ key: "cosigner", label: "Independent co-signer re-derives and signs", status: r.approved ? "ok" : "refused", detail: r.approved ? `${r.checks.length} checks passed. Its own optimal quote: ${fmt6(r.quote!.amountOut)} tEUR. It signs an order with floor ${fmt6(r.order!.minOut)} tEUR and tolerance τ = ${r.order!.tolerancePpm} ppm; the route is left to the agent.` : `Refused: ${r.reasons.join("; ")}`, data: ser({ checks: r.checks, reasons: r.reasons, floor: r.order?.minOut, quote: r.quote?.amountOut, tolerancePpm: r.order?.tolerancePpm, orderHash: r.order ? hashOrder(r.order) : null, evidenceHash: r.evidenceHash }) });
    if (!r.approved) return refuse(`The co-signer refused: ${r.reasons.join("; ")}. No transaction was sent.`);

    // 5 · route + proof
    const tp = await planTrade(this.c.pub, exec, usd, eur, amountIn);
    const d = decide(tp, r.order!);
    push({ key: "plan", label: "Agent routes and builds the proof", status: d.submit ? "ok" : "refused", detail: `${tp.plan.route.filter((h) => h.amountIn > 0n).length} hops over ${new Set(tp.plan.route.map((h) => h.venue)).size} venues, expected ${fmt6(tp.plan.sim.amountOut)} tEUR. Dual prices give an upper bound of ${fmt6(tp.onchainBound)} tEUR on what any route over the five venues could return (gap ${tp.plan.gapPpm.toFixed(3)} ppm). ${d.submit ? "Pre-flighted against the contract." : d.reasons.join("; ")}`, data: this.planData(tp) });
    if (!d.submit) return refuse(`The agent declined to submit: ${d.reasons.join("; ")}`);

    // 6 · submit → receipt
    const before = { reserve: await this.bal(eur, reserve), vault: await this.bal(usd, vault) };
    push({ key: "submit", label: "Transaction submitted", status: "pending", detail: "QEDExecution.trade(mandate, owner signature, certificate, co-signature, order, route, prices) from the agent's key.", data: {} });
    const tx = await this.c.send(this.K.OPERATOR, exec, fn(QEDExecutionAbi, "trade", [this.mandate, this.ownerSig, r.certificate, r.signature, r.order, hopsForChain(tp.plan.route), pricesForChain(tp.plan.prices)]));
    const be = tx.events.find((e) => e.name === "BestExecution")!.args as any;
    const out = BigInt(be.amountOut), bound = BigInt(be.bound);
    push({ key: "receipt", label: "Mined: the chain checked the proof", status: "ok", detail: `Status success in block ${tx.blockNumber}, ${tx.gasUsed.toLocaleString("en-US")} gas. BestExecution: ${fmt6(amountIn)} tUSD → ${fmt6(out)} tEUR, on-chain bound ${fmt6(bound)} (${ppm(out, bound).toFixed(3)} ppm below the bound; accepted only within τ).`, data: this.txData(tx) });

    // 7 · reconcile
    const after = { reserve: await this.bal(eur, reserve), vault: await this.bal(usd, vault) };
    const ok = after.reserve - before.reserve === out && before.vault - after.vault === amountIn && (await this.bal(eur, exec)) === 0n && (await this.bal(usd, exec)) === 0n;
    push({ key: "reconcile", label: "Balances reconciled", status: ok ? "ok" : "refused", detail: ok ? `Treasury ${fmt6(before.vault)} → ${fmt6(after.vault)} tUSD; euro reserve ${fmt6(before.reserve)} → ${fmt6(after.reserve)} tEUR. The module holds nothing.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });

    this.lastTrade = ser({ at: new Date().toISOString(), instruction, amountIn, amountOut: out, bound, gapPpm: ppm(out, bound), floor: r.order!.minOut, tolerancePpm: r.order!.tolerancePpm, hash: tx.hash, block: tx.blockNumber, gasUsed: tx.gasUsed, plan: this.planData(tp), cosignerChecks: r.checks.length, engine: transcript.engine });
    const t = { amountIn: amountIn.toString(), amountOut: out.toString(), bound: bound.toString(), gapPpm: ppm(out, bound), hops: tp.plan.route.filter((h) => h.amountIn > 0n).length, venues: [...new Set(tp.plan.route.map((h) => h.venue))] };
    const summary = `Converted ${fmt6(amountIn)} tUSD → ${fmt6(out)} tEUR; bound ${fmt6(bound)}; reserve now ${fmt6(after.reserve)} tEUR.`;
    this.record({ kind: "conversion", title: summary, outcome: "executed", tx: this.txBrief(tx), trade: t });
    return { outcome: "executed", summary, steps, tx: this.txBrief(tx) };
  }

  // ───────────────────────────── treasury policy: one autonomous tick ─────────────────────────────
  async policyTick(emit: Emit = () => {}): Promise<OpResult> {
    return this.exclusive(async () => {
      const steps: Step[] = [];
      const push = (s: Omit<Step, "at">) => {
        const st = { ...s, at: new Date().toISOString() };
        steps.push(st);
        emit(st);
      };
      if (!this.policy || !this.policySig) throw new Error("No standing policy yet: the owner must sign one first.");
      const policy = this.policy;
      const { usd, eur, reserve, exec } = this.a;
      const view = await observeTreasury(this.c.pub, policy, exec, POLICY.reserveBuffer);
      const d = decideTranche(view.venues, policy, view.reserveFree, view.available, this.mandate.maxPerPayment);
      this.policyTicks++;
      const cands = `need ${d.candidates.need === null ? "more than any allowed tranche" : fmt6(d.candidates.need)}, impact limit ${fmt6(d.candidates.impact)}, policy cap ${fmt6(d.candidates.policyCap)}, mandate cap ${fmt6(d.candidates.mandateCap)}, free funds ${fmt6(d.candidates.freeFunds)}`;
      push({ key: "decide", label: "Agent observes and decides", status: d.action === "convert" ? "ok" : "info", detail: d.action === "convert" ? `Reserve has ${fmt6(view.reserveFree)} tEUR free, short ${fmt6(d.shortfall)}. X = min(${cands}) = ${fmt6(d.amountIn)} tUSD, limited by ${d.limitedBy}.` : d.action === "none" ? `Reserve has ${fmt6(view.reserveFree)} tEUR free: the ${fmt6(policy.targetFree)} tEUR target is met. Nothing to do, no transaction, no gas.` : `Short ${fmt6(d.shortfall)} tEUR but waiting: ${d.reason.replace(/^wait: /, "")}.`, data: ser({ decision: d }) });
      if (d.action !== "convert") {
        const summary = d.action === "none" ? `Tick ${this.policyTicks}: target met (${fmt6(view.reserveFree)} tEUR free); the agent stops.` : `Tick ${this.policyTicks}: the agent waits (${d.reason.replace(/^wait: /, "")}).`;
        this.record({ kind: "policy-tick", title: summary, outcome: "no-action" });
        return { outcome: "no-action", summary, steps };
      }
      const nonce = `${policy.nonce}:tick-${this.policyTicks}`;
      const r = await this.cosigner.evaluateTrade({ mandate: this.mandate, ownerSig: this.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn: d.amountIn, instruction: `policy tick ${this.policyTicks}`, nonce, policy, policySig: this.policySig, brainEngine: "deterministic policy" });
      push({ key: "cosigner", label: "Co-signer re-derives the same decision", status: r.approved ? "ok" : "refused", detail: r.approved ? `${r.checks.length} checks, including the shortfall, the tranche rule and the execution cost. Order floor ${fmt6(r.order!.minOut)} tEUR, τ = ${r.order!.tolerancePpm} ppm.` : `Refused: ${r.reasons.join("; ")}`, data: ser({ checks: r.checks, reasons: r.reasons }) });
      if (!r.approved) {
        this.record({ kind: "policy-tick", title: `Tick ${this.policyTicks}: co-signer refused (${r.reasons[0]})`, outcome: "refused" });
        return { outcome: "refused", summary: `Co-signer refused: ${r.reasons.join("; ")}`, steps };
      }
      const tp = await planTrade(this.c.pub, exec, usd, eur, d.amountIn);
      const go = decide(tp, r.order!);
      push({ key: "plan", label: "Agent routes and builds the proof", status: go.submit ? "ok" : "refused", detail: `Expected ${fmt6(tp.plan.sim.amountOut)} tEUR, bound ${fmt6(tp.onchainBound)}.`, data: this.planData(tp) });
      if (!go.submit) return { outcome: "refused", summary: go.reasons.join("; "), steps };
      push({ key: "submit", label: "Transaction submitted", status: "pending", detail: "Agent-initiated under the standing policy.", data: {} });
      const tx = await this.c.send(this.K.OPERATOR, exec, fn(QEDExecutionAbi, "trade", [this.mandate, this.ownerSig, r.certificate, r.signature, r.order, hopsForChain(tp.plan.route), pricesForChain(tp.plan.prices)]));
      const be = tx.events.find((e) => e.name === "BestExecution")!.args as any;
      const out = BigInt(be.amountOut), bound = BigInt(be.bound);
      push({ key: "receipt", label: "Mined: the chain checked the proof", status: "ok", detail: `Block ${tx.blockNumber}, ${tx.gasUsed.toLocaleString("en-US")} gas. ${fmt6(d.amountIn)} tUSD → ${fmt6(out)} tEUR, bound ${fmt6(bound)}.`, data: this.txData(tx) });
      const after = (await this.c.pub.readContract({ address: reserve, abi: QEDVaultAbi, functionName: "freeBalance" })) as bigint;
      const ok = after - view.reserveFree === out;
      push({ key: "reconcile", label: "Reserve re-read", status: ok ? "ok" : "refused", detail: `Free tEUR ${fmt6(view.reserveFree)} → ${fmt6(after)} (target ${fmt6(policy.targetFree)}).`, data: ser({ before: view.reserveFree, after }) });
      this.lastTrade = ser({ at: new Date().toISOString(), instruction: `standing policy, tick ${this.policyTicks}`, amountIn: d.amountIn, amountOut: out, bound, gapPpm: ppm(out, bound), floor: r.order!.minOut, tolerancePpm: r.order!.tolerancePpm, hash: tx.hash, block: tx.blockNumber, gasUsed: tx.gasUsed, plan: this.planData(tp), cosignerChecks: r.checks.length, engine: "deterministic policy" });
      const summary = `Tick ${this.policyTicks}: converted ${fmt6(d.amountIn)} tUSD → ${fmt6(out)} tEUR (limited by ${d.limitedBy}); reserve free ${fmt6(after)} tEUR.`;
      this.record({ kind: "policy-tick", title: summary, outcome: "executed", tx: this.txBrief(tx), trade: { amountIn: d.amountIn.toString(), amountOut: out.toString(), bound: bound.toString(), gapPpm: ppm(out, bound), hops: tp.plan.route.filter((h) => h.amountIn > 0n).length, venues: [...new Set(tp.plan.route.map((h) => h.venue))] } });
      return { outcome: "executed", summary, steps, tx: this.txBrief(tx) };
    });
  }

  // ───────────────────────────── security lab: real reverted transactions ─────────────────────────────
  async attack(kind: AttackKind, emit: Emit = () => {}): Promise<OpResult> {
    if (!ATTACK_KINDS.includes(kind)) throw new Error("Unknown attack.");
    return this.exclusive(async () => {
      const steps: Step[] = [];
      const push = (s: Omit<Step, "at">) => {
        const st = { ...s, at: new Date().toISOString() };
        steps.push(st);
        emit(st);
      };
      const { usd, eur, eth, reserve, exec, vault } = this.a;
      const A = ATTACKS[kind];
      const amountIn = this.mandate.maxPerPayment < U(10) ? this.mandate.maxPerPayment : U(10);
      const lim = await this.checkLimits(amountIn);
      if (!lim.allowed) throw new Error("The treasury has no room left for a genuine order today; reset the sandbox first.");
      const nonce = `sandbox-${this.resets}-${++this.nonceN}`;
      const instructionSig = await this.K.OWNER.signMessage({ message: ownerTradeMessage(vault, amountIn, usd, eur, reserve, nonce) });
      const r = await this.cosigner.evaluateTrade({ mandate: this.mandate, ownerSig: this.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn, instruction: `Security lab: genuine order for ${fmt6(amountIn)} tUSD`, nonce, instructionSig, brainEngine: "security lab" });
      if (!r.approved) throw new Error(`co-signer refused the genuine order: ${r.reasons.join("; ")}`);
      push({ key: "cosigner", label: "Genuine co-signed order", status: "ok", detail: `The owner approved ${fmt6(amountIn)} tUSD → tEUR; the co-signer signed an order with floor ${fmt6(r.order!.minOut)} tEUR. The attacker now holds a real certificate.`, data: ser({ floor: r.order!.minOut, orderHash: hashOrder(r.order!) }) });
      const tp = await planTrade(this.c.pub, exec, usd, eur, amountIn);
      const v = tp.venues;
      let route: Hop[] = tp.plan.route, prices = tp.plan.prices, order: Order = r.order!, who = this.K.OPERATOR;
      if (kind === "inferior-route") route = optimalDirectOnly(v, usd, eur, amountIn)!.route;
      if (kind === "single-pool") route = bestSingleVenue(v, usd, eur, amountIn)!;
      if (kind === "skim") {
        route = tp.plan.route.map((h) => ({ ...h }));
        const src = route.filter((h) => h.amountIn > 0n && (h.zeroForOne ? v[h.venue].token0 : v[h.venue].token1) === usd).sort((a, b) => (a.amountIn > b.amountIn ? -1 : 1));
        if (src.length >= 2) {
          const shift = src[0].amountIn / 20n;
          src[0].amountIn -= shift;
          src[1].amountIn += shift;
        }
      }
      if (kind === "forged-proof") {
        route = optimalDirectOnly(v, usd, eur, amountIn)!.route;
        const directProof = solve(v.filter((x) => x.token0 !== eth && x.token1 !== eth), usd, eur, amountIn).prices;
        prices = new Map(tp.plan.prices);
        prices.set(usd.toLowerCase(), directProof.get(usd.toLowerCase())!);
        prices.set(eth.toLowerCase(), (tp.plan.prices.get(eth.toLowerCase())! * 9n) / 10n);
      }
      if (kind === "redirect") order = { ...r.order!, recipient: this.K.MALLORY.address };
      if (kind === "stolen-order") who = this.K.MALLORY;
      const sim = simulate(v, route, usd, eur, amountIn).amountOut;
      const honest = tp.plan.sim.amountOut;
      push({ key: "attack", label: "Malicious transaction built", status: "info", detail: `${A.title}. ${["inferior-route", "skim", "forged-proof", "single-pool"].includes(kind) ? `It would deliver ${fmt6(sim)} tEUR instead of ${fmt6(honest)} (−${((Number(honest - sim) / Number(honest)) * 1e4).toFixed(2)} bps), above the 1% floor a slippage-only wallet would accept.` : ""} Sent with a fixed gas limit so it is mined, not just simulated.`, data: ser({ simulatedOut: sim, honestOut: honest, floor: r.order!.minOut }) });
      const tx = await this.c.sendExpectingRevert(who, exec, fn(QEDExecutionAbi, "trade", [this.mandate, this.ownerSig, r.certificate, r.signature, order, hopsForChain(route), pricesForChain(prices)]), 2_000_000n);
      const err = tx.error?.name ?? "reverted";
      push({ key: "receipt", label: `Mined and reverted: ${err}`, status: "reverted", detail: `Status reverted in block ${tx.blockNumber} (${tx.gasUsed.toLocaleString("en-US")} gas paid by the attacker). Defence: ${A.layer}. Nothing moved.`, data: this.txData(tx) });
      const summary = `${A.title} → reverted on-chain with ${err}.`;
      this.record({ kind: "attack", title: summary, outcome: "reverted", tx: this.txBrief(tx) });
      return { outcome: "reverted", summary, steps, tx: this.txBrief(tx) };
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────
  private planData(tp: TradePlan) {
    const sym = (t: Address) => (getAddress(t) === this.a.usd ? "tUSD" : getAddress(t) === this.a.eur ? "tEUR" : "tETH");
    return ser({
      expectedOut: tp.plan.sim.amountOut,
      bound: tp.onchainBound,
      gapPpm: tp.plan.gapPpm,
      sweeps: tp.plan.iterations,
      hops: tp.plan.sim.perHop.map((h) => ({ venue: h.venue, label: EXEC_VENUES[h.venue].label, tokenIn: sym(h.tokenIn), tokenOut: sym(h.tokenOut), amountIn: h.amountIn, amountOut: h.amountOut })),
      prices: Object.fromEntries(Object.entries(tp.plan.nu).map(([k, x]) => [sym(k as Address), x])),
      alternatives: tp.alternatives.map((a) => ({ policy: a.policy, description: a.description, amountOut: a.amountOut, shortfallBps: a.shortfallBps, passesFloor: a.passesFloor ?? null })),
    });
  }
  private txData(tx: TxResult) {
    return ser({ hash: tx.hash, status: tx.status, block: tx.blockNumber, gasUsed: tx.gasUsed, from: tx.from, to: tx.to, error: tx.error?.name ?? null, errorArgs: tx.error?.args ?? null, events: tx.events.map((e) => ({ name: e.name, args: e.args })) });
  }
  private txBrief(tx: TxResult) {
    return { hash: tx.hash, status: tx.status, block: tx.blockNumber.toString(), gasUsed: tx.gasUsed.toString(), ...(tx.error ? { error: tx.error.name } : {}) };
  }
  /** Receipt straight from the chain, for independent re-checking in the browser. */
  async receipt(hash: Hex) {
    const r = await this.c.pub.getTransactionReceipt({ hash });
    return ser({ hash, status: r.status, block: r.blockNumber, gasUsed: r.gasUsed, from: r.from, to: r.to, logs: r.logs.length });
  }
}
