/**
 * THE CHECKER — an independent policy co-signer.
 *
 * Runs as its own process with its own key (COSIGNER_PK only). It never trusts the agent: it re-derives
 * every fact from the chain and from counterparty signatures, writes a complete decision record, hashes
 * it, and only then signs an EIP-712 Certificate that binds the exact payment terms AND the record's
 * hash. The vault refuses any payment without this certificate (for mandates with requireCosign).
 *
 * Maker–checker / four-eyes, a staple of bank payment operations, implemented for machines.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, keccak256, recoverMessageAddress, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { ProofEscrowAbi, QEDLensAbi, QEDVaultAbi } from "../abi/contracts.js";
import type { Chain$ } from "../chain.js";
import { mandateHash, signCertificate, type Certificate, type Mandate } from "../protocol/eip712.js";
import { canonical, hashRecord, invoiceDigest, type Invoice } from "../protocol/records.js";
import type { Check } from "../engine/economics.js";
import { POLICY } from "../engine/economics.js";
import { solve, type Hop } from "../engine/execution.js";
import { hashOrder, readVenues, type Order } from "./trader.js";
import { decideTranche, impactBps, observeTreasury, policyMessage, type TreasuryPolicy } from "./treasury.js";
import { QEDExecutionAbi } from "../abi/contracts.js";

export type CertRequest =
  | {
      kind: "purchase";
      mandate: Mandate;
      ownerSig: Hex;
      invoice: Invoice;
      vendorSig: Hex;
      jobId: string;
      rationale: string;
      brainEngine: string;
    }
  | {
      kind: "owner-instructed";
      mandate: Mandate;
      ownerSig: Hex;
      payee: Address;
      amount: bigint;
      dueInDays?: number;
      instruction: string;
      nonce: string;
      instructionSig: Hex;
    };

export interface CertResponse {
  approved: boolean;
  certificate?: Certificate;
  signature?: Hex;
  evidenceHash: Hex;
  recordPath: string;
  checks: Check[];
  reasons: string[];
}

/** An owner-confirmed conversion: the agent proposes, the owner signs the exact instruction. */
export interface TradeRequest {
  mandate: Mandate;
  ownerSig: Hex;
  module: Address;
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  amountIn: bigint;
  instruction: string;
  nonce: string;
  /** Either the owner's signature on this exact conversion… */
  instructionSig?: Hex;
  /** …or a standing owner-signed treasury policy under which the agent decided on its own. */
  policy?: TreasuryPolicy;
  policySig?: Hex;
  brainEngine: string;
}

export interface TradeResponse extends CertResponse {
  order?: Order;
  quote?: { amountOut: bigint; bound: bigint; route: Hop[] };
}

export const TRADE_POLICY = {
  slippageBps: 100, //       the order's floor: the co-signer's own optimal quote less 1%
  tolerancePpm: 1, //         best-execution tolerance written into the order
  maxRateDeviationBps: 300, //  quoted rate within 3% of the depth-weighted direct mid (manipulation screen)
  maxTolerancePpm: 100, //      τ grows with the honest router's own measured gap (dislocated markets), never beyond this
};

export const ownerTradeMessage = (vault: Address, amountIn: bigint, tokenIn: Address, tokenOut: Address, recipient: Address, nonce: string) =>
  `QED owner instruction\nvault: ${vault}\nconvert: ${amountIn.toString()} of ${tokenIn}\ninto: ${tokenOut}\nfor: ${recipient}\nnonce: ${nonce}`;

export const ownerInstructionMessage = (vault: Address, payee: Address, amount: bigint, dueInDays: number | undefined, nonce: string) =>
  `QED owner instruction\nvault: ${vault}\npay: ${payee}\namount: ${amount.toString()}\ndueInDays: ${dueInDays ?? 0}\nnonce: ${nonce}`;

export interface CosignerConfig {
  vault: Address;
  lens: Address;
  escrow: Address;
  owner: Address;
  vendorKeys: Record<string, Address>; // payee address → address that must sign its invoices
  catalogPrices: Record<string, bigint>; // productId → published price
  denylist: Address[];
  deployBlock: bigint;
  recordsDir: string;
}

const fmt = (x: bigint) => (Number(x) / 1e6).toFixed(2);

export class PolicyEngine {
  private seenInvoices = new Set<string>();
  private seenNonces = new Set<string>();
  constructor(
    private chain: Chain$,
    private key: LocalAccount,
    private cfg: CosignerConfig,
  ) {
    mkdirSync(cfg.recordsDir, { recursive: true });
  }

  get address() {
    return this.key.address;
  }

  async evaluate(req: CertRequest): Promise<CertResponse> {
    const pub = this.chain.pub;
    const block = await pub.getBlock();
    const now = Number(block.timestamp);
    const snap = (await pub.readContract({ address: this.cfg.lens, abi: QEDLensAbi, functionName: "snapshot", args: [this.cfg.vault] })) as any;
    const mHash = mandateHash(req.mandate);
    const checks: Check[] = [];
    const add = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });

    // C1–C3: authority (re-verified independently of the agent and of the vault)
    const digest = (await pub.readContract({ address: this.cfg.lens, abi: QEDLensAbi, functionName: "mandateDigest", args: [this.cfg.vault, req.mandate as any] } as any)) as Hex;
    const { recoverAddress } = await import("viem");
    const signer = await recoverAddress({ hash: digest, signature: req.ownerSig }).catch(() => "0x0" as Address);
    add("C1", "Mandate signed by the vault owner", getAddress(signer) === getAddress(snap.owner), `recovered ${signer}`);
    add("C2", "Mandate active and current epoch", now >= Number(req.mandate.validFrom) && now <= Number(req.mandate.validUntil) && BigInt(snap.epoch) === req.mandate.epoch, `epoch ${snap.epoch}, valid until ${new Date(Number(req.mandate.validUntil) * 1000).toISOString()}`);

    let payee: Address;
    let amount: bigint;
    let dueAt = 0n;
    let ref: Hex;
    let intentId: Hex;
    let summary: Record<string, unknown>;

    if (req.kind === "purchase") {
      const inv = req.invoice;
      payee = getAddress(inv.payTo);
      amount = BigInt(inv.amount);
      ref = keccak256(toHex(inv.invoiceId));
      intentId = keccak256(toHex(`purchase:${inv.invoiceId}:${req.jobId}`));
      summary = { kind: "purchase", invoice: inv, jobId: req.jobId, rationale: req.rationale, brainEngine: req.brainEngine };

      // C3–C6: counterparty authentication, invoice integrity, price sanity, replay
      const expectedSigner = this.cfg.vendorKeys[payee.toLowerCase()];
      const invSigner = await recoverMessageAddress({ message: { raw: invoiceDigest(inv) }, signature: req.vendorSig }).catch(() => "0x0" as Address);
      add("C3", "Invoice signed by the payee's registered key", !!expectedSigner && getAddress(invSigner) === getAddress(expectedSigner), `invoice signer ${invSigner}`);
      add("C4", "Invoice addressed to this vault, not expired", getAddress(inv.buyer) === getAddress(this.cfg.vault) && now <= inv.expiresAt, `buyer ${inv.buyer}, expires ${new Date(inv.expiresAt * 1000).toISOString()}`);
      const listPrice = this.cfg.catalogPrices[inv.productId];
      add("C5", "Price equals the vendor's published list price", listPrice !== undefined && amount <= listPrice, `invoice ${fmt(amount)} vs list ${listPrice !== undefined ? fmt(listPrice) : "n/a"}`);
      add("C6", "Invoice not seen before", !this.seenInvoices.has(inv.invoiceId), inv.invoiceId);

      // C7–C8: economic justification — spend only to earn, on data the job actually needs
      const job = (await pub.readContract({ address: this.cfg.escrow, abi: ProofEscrowAbi, functionName: "getJob", args: [BigInt(req.jobId)] })) as any;
      const jobOk = Number(job.status) === 1 && getAddress(job.payee) === getAddress(this.cfg.vault);
      add("C7", "Funded escrow job exists for this vault and covers the cost with margin", jobOk && BigInt(job.price) * BigInt(10_000 - POLICY.minMarginBps) / 10_000n >= amount, `job #${req.jobId}: status ${job.status}, price ${fmt(BigInt(job.price ?? 0))}, cost ${fmt(amount)}`);
      add("C8", "Purchased data is exactly what the job's committed spec requires", jobOk && job.specHash === inv.dataCommitment, `job spec ${job.specHash?.slice(0, 10)}… vs data ${inv.dataCommitment.slice(0, 10)}…`);
    } else {
      payee = getAddress(req.payee);
      amount = req.amount;
      ref = keccak256(toHex(`owner-instruction:${req.nonce}`));
      intentId = keccak256(toHex(`owner:${req.nonce}`));
      dueAt = req.dueInDays ? BigInt(now + req.dueInDays * 86_400) : 0n;
      summary = { kind: "owner-instructed", instruction: req.instruction, payee, amount, dueInDays: req.dueInDays ?? 0, nonce: req.nonce };
      const msg = ownerInstructionMessage(this.cfg.vault, payee, amount, req.dueInDays, req.nonce);
      const s = await recoverMessageAddress({ message: msg, signature: req.instructionSig }).catch(() => "0x0" as Address);
      add("C3", "Instruction confirmed by the owner's signature", getAddress(s) === getAddress(snap.owner), `instruction signer ${s}`);
      add("C6", "Instruction nonce not seen before", !this.seenNonces.has(req.nonce), req.nonce);
    }

    // C9–C12: scope, solvency, screening, earned autonomy
    add("C9", "Payee is listed in the owner's mandate", req.mandate.payees.some((p) => getAddress(p) === payee), payee);
    const free = BigInt(snap.freeBalance);
    add("C10", "Reserve buffer above ring-fenced liabilities preserved", free - amount >= POLICY.reserveBuffer, `free ${fmt(free)} − ${fmt(amount)} = ${fmt(free - amount)} ≥ ${fmt(POLICY.reserveBuffer)} (ring-fenced ${fmt(BigInt(snap.protectedBalance))})`);
    add("C11", "Sanctions / deny-list screening", !this.cfg.denylist.some((d) => getAddress(d) === payee), "payee not on deny-list");
    const { revenue, spent } = await this.trackRecord();
    const allowance = 10_000_000n + revenue / 2n;
    add("C12", "Earned autonomy: discretionary spend ≤ 10 + 50% of VERIFIED revenue", spent + amount <= allowance, `spent ${fmt(spent)} + ${fmt(amount)} ≤ allowance ${fmt(allowance)} (verified revenue ${fmt(revenue)})`);

    const approved = checks.every((c) => c.pass);
    const core = {
      schema: "qed.decision-record/v1",
      cosigner: this.key.address,
      chainId: this.chain.chainId,
      vault: this.cfg.vault,
      block: { number: block.number, timestamp: now },
      mandateHash: mHash,
      request: summary,
      payment: { payee, amount, dueAt, intentId, ref },
      treasury: { balance: snap.balance, protected: snap.protectedBalance, free: snap.freeBalance, spentInWindow: snap.spentInWindow, dailyCap: snap.dailyCap, blastRadius24h: snap.blastRadius24h },
      checks,
      verdict: approved ? "APPROVED" : "REFUSED",
    };
    const evidenceHash = hashRecord(core);
    const reasons = checks.filter((c) => !c.pass).map((c) => `${c.id} ${c.name}: ${c.detail}`);
    let certificate: Certificate | undefined;
    let signature: Hex | undefined;
    if (approved) {
      certificate = {
        mandateHash: mHash,
        recipient: payee,
        amount,
        dueAt,
        intentId,
        evidenceHash,
        ref,
        notBefore: BigInt(now - 60),
        expiresAt: BigInt(now + 2 * 3600),
        epoch: req.mandate.epoch,
      };
      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);
      if (req.kind === "purchase") this.seenInvoices.add(req.invoice.invoiceId);
      else this.seenNonces.add(req.nonce);
    }
    const recordPath = `${this.cfg.recordsDir}/${evidenceHash}.json`;
    writeFileSync(recordPath, JSON.stringify({ core: JSON.parse(canonical(core)), canonical: canonical(core), evidenceHash, certificate: certificate ? JSON.parse(canonical(certificate)) : null, signature: signature ?? null }, null, 2));
    return { approved, certificate, signature, evidenceHash, recordPath, checks, reasons };
  }

  /**
   * Reviews a conversion. The co-signer does not trust the agent's plan: it reads the venues itself,
   * solves the routing problem itself, and writes ITS quote (less the slippage allowance) into the
   * order as the floor. The route and the proof stay the agent's job; the chain checks them.
   */
  async evaluateTrade(req: TradeRequest): Promise<TradeResponse> {
    const pub = this.chain.pub;
    const block = await pub.getBlock();
    const now = Number(block.timestamp);
    const snap = (await pub.readContract({ address: this.cfg.lens, abi: QEDLensAbi, functionName: "snapshot", args: [this.cfg.vault] })) as any;
    const mHash = mandateHash(req.mandate);
    const checks: Check[] = [];
    const add = (id: string, name: string, pass: boolean, detail: string) => checks.push({ id, name, pass, detail });
    const { recoverAddress } = await import("viem");
    const digest = (await pub.readContract({ address: this.cfg.lens, abi: QEDLensAbi, functionName: "mandateDigest", args: [this.cfg.vault, req.mandate as any] } as any)) as Hex;
    const signer = await recoverAddress({ hash: digest, signature: req.ownerSig }).catch(() => "0x0" as Address);
    add("C1", "Mandate signed by the vault owner", getAddress(signer) === getAddress(snap.owner), `recovered ${signer}`);
    add("C2", "Mandate active and current epoch", now >= Number(req.mandate.validFrom) && now <= Number(req.mandate.validUntil) && BigInt(snap.epoch) === req.mandate.epoch, `epoch ${snap.epoch}`);
    let policyCheck: { amountIn: bigint; reason: string } | undefined;
    if (req.policy) {
      const p = req.policy;
      const s = await recoverMessageAddress({ message: policyMessage(p), signature: req.policySig ?? "0x" }).catch(() => "0x0" as Address);
      const fits = getAddress(p.vault) === getAddress(this.cfg.vault) && getAddress(p.reserve) === getAddress(req.recipient) && getAddress(p.tokenIn) === getAddress(req.tokenIn) && getAddress(p.tokenOut) === getAddress(req.tokenOut);
      add("C3", "Standing treasury policy signed by the owner, current, and covering this conversion", getAddress(s) === getAddress(snap.owner) && BigInt(now) <= p.validUntil && fits, `policy signer ${s}, valid until ${new Date(Number(p.validUntil) * 1000).toISOString()}`);
      // P1–P2: the co-signer re-derives the agent's decision from the chain and the policy, and allows no more
      const view = await observeTreasury(pub, p, req.module, POLICY.reserveBuffer);
      const own = decideTranche(view.venues, p, view.reserveFree, view.available, req.mandate.maxPerPayment);
      policyCheck = { amountIn: own.amountIn, reason: own.reason };
      add("P1", "Independent decision under the policy: a shortfall exists and a tranche is due", own.action === "convert", `reserve free ${view.reserveFree} vs target ${p.targetFree}; ${own.reason}`);
      add("P2", "Requested tranche no larger than the co-signer's own decision", own.action === "convert" && req.amountIn <= own.amountIn && req.amountIn >= p.minTranche, `requested ${req.amountIn} ≤ allowed ${own.amountIn}`);
      const ib = impactBps(view.venues, req.tokenIn, req.tokenOut, req.amountIn);
      add("P3", "Execution cost within the policy's impact limit", ib <= p.maxImpactBps, `${ib.toFixed(1)} bps ≤ ${p.maxImpactBps} bps`);
    } else {
      const msg = ownerTradeMessage(this.cfg.vault, req.amountIn, req.tokenIn, req.tokenOut, req.recipient, req.nonce);
      const s = await recoverMessageAddress({ message: msg, signature: req.instructionSig ?? "0x" }).catch(() => "0x0" as Address);
      add("C3", "Conversion confirmed by the owner's signature", getAddress(s) === getAddress(snap.owner), `instruction signer ${s}`);
    }
    add("C6", "Instruction nonce not seen before", !this.seenNonces.has(req.nonce), req.nonce);
    add("C9", "Recipient is listed in the owner's mandate", req.mandate.payees.some((p) => getAddress(p) === getAddress(req.recipient)), req.recipient);
    add("C9b", "Execution module is the vault's agent and a mandate payee", getAddress(snap.agent) === getAddress(req.module) && req.mandate.payees.some((p) => getAddress(p) === getAddress(req.module)), `agent ${snap.agent}`);
    const free = BigInt(snap.freeBalance);
    add("C10", "Reserve buffer above ring-fenced liabilities preserved", free - req.amountIn >= POLICY.reserveBuffer, `free ${fmt(free)} − ${fmt(req.amountIn)} = ${fmt(free - req.amountIn)} ≥ ${fmt(POLICY.reserveBuffer)}`);
    add("C11", "Sanctions / deny-list screening", !this.cfg.denylist.some((d) => getAddress(d) === getAddress(req.recipient)), "recipient not on deny-list");

    // T1–T3: an independent quote, a manipulation screen, and the venue set the proof must range over
    const venues = await readVenues(pub, req.module);
    const venueSetHash = (await pub.readContract({ address: req.module, abi: QEDExecutionAbi, functionName: "venueSetHash" })) as Hex;
    const own = solve(venues, req.tokenIn, req.tokenOut, req.amountIn);
    add("T1", "Independent re-quote: own optimal route executes", own.sim.ok && own.sim.amountOut > 0n, `own route ${own.route.length} hops → ${own.sim.amountOut} (bound ${own.bound}, gap ${own.gapPpm.toFixed(3)} ppm)`);
    // T2: the quoted rate must sit close to the depth-weighted mid price of the direct venues — a screen
    // against venues pushed off-market before signing (it cannot see a manipulation of every venue at once).
    const direct = venues.filter((v) => [v.token0, v.token1].map((x) => x.toLowerCase()).sort().join() === [req.tokenIn, req.tokenOut].map((x) => x.toLowerCase()).sort().join());
    const depth = (v: (typeof venues)[number]) => Number(v.token0.toLowerCase() === req.tokenIn.toLowerCase() ? v.r0 : v.r1);
    const mid = (v: (typeof venues)[number]) => (v.token0.toLowerCase() === req.tokenIn.toLowerCase() ? Number(v.r1) / Number(v.r0) : Number(v.r0) / Number(v.r1));
    const wMid = direct.reduce((a, v) => a + mid(v) * depth(v), 0) / Math.max(1, direct.reduce((a, v) => a + depth(v), 0));
    const rate = Number(own.sim.amountOut) / Number(req.amountIn);
    const deviation = wMid > 0 ? Math.abs(rate / wMid - 1) * 10_000 : Infinity;
    add("T2", "Quoted rate close to the venues' depth-weighted mid (manipulation screen)", deviation <= TRADE_POLICY.maxRateDeviationBps, `rate ${rate.toFixed(6)} vs weighted mid ${wMid.toFixed(6)}: ${deviation.toFixed(1)} bps (limit ${TRADE_POLICY.maxRateDeviationBps})`);
    add("T3", "Order commits to the current venue set", /^0x[0-9a-f]{64}$/i.test(venueSetHash), venueSetHash);

    const order: Order = {
      tokenOut: getAddress(req.tokenOut),
      recipient: getAddress(req.recipient),
      minOut: (own.sim.amountOut * BigInt(10_000 - TRADE_POLICY.slippageBps)) / 10_000n,
      // τ: 1 ppm normally; on a dislocated market the honest route itself cannot get closer than its measured gap
      // (an arbitrage leg must be split in time), so τ follows twice that gap, capped.
      tolerancePpm: Math.min(TRADE_POLICY.maxTolerancePpm, Math.max(TRADE_POLICY.tolerancePpm, Math.ceil(2 * own.gapPpm))),
      venueSetHash,
    };
    const approved = checks.every((c) => c.pass);
    const intentId = keccak256(toHex(`trade:${req.nonce}`));
    const ref = hashOrder(order);
    const core = {
      schema: "qed.decision-record/v1",
      cosigner: this.key.address,
      chainId: this.chain.chainId,
      vault: this.cfg.vault,
      block: { number: block.number, timestamp: now },
      mandateHash: mHash,
      request: { kind: req.policy ? "policy-trade" : "trade", instruction: req.instruction, brainEngine: req.brainEngine, nonce: req.nonce, tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, recipient: req.recipient, policy: req.policy ?? null, policyDecision: policyCheck ?? null },
      quote: { amountOut: own.sim.amountOut, bound: own.bound, gapPpm: own.gapPpm, route: own.route, nu: own.nu },
      order,
      payment: { payee: req.module, amount: req.amountIn, dueAt: 0n, intentId, ref },
      treasury: { balance: snap.balance, protected: snap.protectedBalance, free: snap.freeBalance, spentInWindow: snap.spentInWindow, dailyCap: snap.dailyCap, blastRadius24h: snap.blastRadius24h },
      checks,
      verdict: approved ? "APPROVED" : "REFUSED",
    };
    const evidenceHash = hashRecord(core);
    let certificate: Certificate | undefined;
    let signature: Hex | undefined;
    if (approved) {
      certificate = { mandateHash: mHash, recipient: getAddress(req.module), amount: req.amountIn, dueAt: 0n, intentId, evidenceHash, ref, notBefore: BigInt(now - 60), expiresAt: BigInt(now + 4 * 3600), epoch: req.mandate.epoch };
      signature = await signCertificate(this.key, this.chain.chainId, this.cfg.vault, certificate);
      this.seenNonces.add(req.nonce);
    }
    const recordPath = `${this.cfg.recordsDir}/${evidenceHash}.json`;
    writeFileSync(recordPath, JSON.stringify({ core: JSON.parse(canonical(core)), canonical: canonical(core), evidenceHash, certificate: certificate ? JSON.parse(canonical(certificate)) : null, signature: signature ?? null }, null, 2));
    return { approved, certificate, signature, evidenceHash, recordPath, checks, reasons: checks.filter((c) => !c.pass).map((c) => `${c.id} ${c.name}: ${c.detail}`), order, quote: { amountOut: own.sim.amountOut, bound: own.bound, route: own.route } };
  }

  /** Verified revenue = escrow settlements INTO the vault; spend = agent payments OUT of it. */
  private async trackRecord(): Promise<{ revenue: bigint; spent: bigint }> {
    const pub = this.chain.pub;
    const settled = await pub.getContractEvents({ address: this.cfg.escrow, abi: ProofEscrowAbi, eventName: "JobSettled", fromBlock: this.cfg.deployBlock });
    const paid = await pub.getContractEvents({ address: this.cfg.vault, abi: QEDVaultAbi, eventName: "PaymentExecuted", fromBlock: this.cfg.deployBlock });
    let revenue = 0n;
    for (const e of settled as any[]) if (getAddress(e.args.payee) === getAddress(this.cfg.vault)) revenue += BigInt(e.args.price);
    let spent = 0n;
    for (const e of paid as any[]) spent += BigInt(e.args.amount);
    return { revenue, spent };
  }
}
