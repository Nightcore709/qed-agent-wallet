/**
 * THE MAKER — the QED autonomous agent.
 *
 *   observe  → RFQs from other agents (HTTP) and funded jobs (chain events)
 *   reason   → language layer (LLM or offline) → deterministic Guard → deterministic economics
 *   act      → sign quotes; buy inputs through co-signed certificates; solve; deliver with a proof
 *   explain  → every decision is a record whose hash is anchored on-chain
 *
 * The agent holds ONE key (AGENT_PK). That key can call exactly one vault function
 * (executePayment) and can only succeed with an owner-signed mandate plus an independent co-signer
 * certificate, inside the vault's solvency invariant. Everything below is therefore allowed to be
 * wrong, manipulated or compromised without putting protected funds at risk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress, keccak256, recoverMessageAddress, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { ProofEscrowAbi, QEDVaultAbi } from "../abi/contracts.js";
import { fn, fmtUsd, type Chain$, type TxResult } from "../chain.js";
import { evaluateJob, type JobEvaluation } from "../engine/economics.js";
import { certify, checkCertificate, wadToNumber, type MinVarSpec } from "../engine/minvar.js";
import { encodeSolution, encodeSpec } from "../engine/riskModel.js";
import { guard, type Brain, type ChatContext, type PayeeBookEntry, type Proposal } from "../brain/index.js";
import { call } from "../net.js";
import { signQuote, type Certificate, type Mandate, type Quote } from "../protocol/eip712.js";
import { hashRecord, type Invoice } from "../protocol/records.js";
import type { CertRequest, CertResponse } from "./cosigner.js";

export interface AgentConfig {
  vault: Address;
  escrow: Address;
  verifier: Address;
  token: Address;
  mandate: Mandate;
  ownerSig: Hex;
  vendorUrl: string;
  cosignerUrl: string;
  payees: PayeeBookEntry[];
  deployBlock: bigint;
  recordsDir: string;
}

export interface Rfq {
  from: Address;
  text: string;
  request: {
    kind: "min-variance-portfolio";
    productId: string;
    specCommitment: Hex;
    budget: bigint;
    deliverWithinHours: number;
  };
}

export interface RfqResponse {
  accepted: boolean;
  quote?: Quote;
  signature?: Hex;
  evaluation?: JobEvaluation;
  flags: string[];
  notes: string[];
  rationale: string;
  recordHash: Hex;
  engine?: string;
}

export interface FulfilmentReport {
  jobId: string;
  invoice: Invoice;
  cert: CertResponse;
  paymentTx: TxResult;
  weights: { asset: string; weight: number }[];
  variance: number;
  volatility: number;
  certificateReport: { ok: boolean; maxStationarityResidual: string; dualityGap: string; maxPsdResidual: string; optimalityBound: number };
  deliverTx: TxResult;
  recordHash: Hex;
}

export class QEDAgent {
  private seenJobs = new Set<string>();
  private pending?: Proposal;
  private lastDecision?: string;
  private decisions: string[] = [];
  readonly log: string[] = [];

  constructor(
    private chain: Chain$,
    private key: LocalAccount,
    private brain: Brain,
    private cfg: AgentConfig,
  ) {
    mkdirSync(cfg.recordsDir, { recursive: true });
  }

  get address() {
    return this.key.address;
  }

  private say(s: string) {
    const line = `[agent] ${s}`;
    this.log.push(line);
    console.log(line);
  }

  private record(kind: string, body: unknown): Hex {
    const h = hashRecord({ kind, body });
    writeFileSync(`${this.cfg.recordsDir}/${kind}-${h.slice(2, 12)}.json`, JSON.stringify({ kind, hash: h, body }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return h;
  }

  async treasury() {
    const s = (await this.chain.pub.readContract({ address: this.cfg.vault, abi: QEDVaultAbi, functionName: "snapshot" })) as any;
    return {
      balance: BigInt(s.balance),
      protectedBalance: BigInt(s.protectedBalance),
      free: BigInt(s.freeBalance),
      dailyCap: BigInt(s.dailyCap),
      spentInWindow: BigInt(s.spentInWindow),
      blastRadius24h: BigInt(s.blastRadius24h),
      paused: Boolean(s.paused),
    };
  }

  async chatContext(): Promise<ChatContext> {
    const t = await this.treasury();
    return { ...t, payees: this.cfg.payees, pending: this.pending, lastDecision: this.lastDecision, decisions: this.decisions };
  }

  // ───────────────────────────────── 1. counterparty RFQs ─────────────────────────────────

  async handleRfq(rfq: Rfq): Promise<RfqResponse> {
    const ctx = await this.chatContext();
    const { result, transcript } = await this.brain.interpret(rfq.text, ctx, "counterparty");
    const g = guard(rfq.text, result, ctx, this.cfg.mandate.maxPerPayment);
    const notes: string[] = [];
    if (g.flags.includes("prompt_injection")) notes.push("Embedded instructions detected in the RFQ and ignored: counterparty text is data, never commands.");
    if (g.flags.includes("induced_transfer")) notes.push("Payment bait detected (unsolicited transfer request) — no payment proposed; only typed, quoted work is considered.");

    // Only the TYPED request fields drive economics; free text never does.
    const catalog = await call<any>(`${this.cfg.vendorUrl}/catalog`);
    const product = catalog.products.find((p: any) => p.productId === rfq.request.productId);
    const supported = rfq.request.kind === "min-variance-portfolio" && !!product && product.dataCommitment === rfq.request.specCommitment;
    const t = await this.treasury();
    const evaluation = evaluateJob(t, product ? [{ label: product.title, amount: BigInt(product.price) }] : [], rfq.request.budget, rfq.request.deliverWithinHours);
    const accepted = supported && evaluation.accept;
    let quote: Quote | undefined;
    let signature: Hex | undefined;
    if (accepted) {
      const now = Number((await this.chain.pub.getBlock()).timestamp);
      quote = {
        provider: this.key.address,
        payee: this.cfg.vault,
        client: getAddress(rfq.from),
        token: this.cfg.token,
        price: evaluation.price,
        verifier: this.cfg.verifier,
        specHash: rfq.request.specCommitment,
        deliverBy: BigInt(now + rfq.request.deliverWithinHours * 3600),
        validUntil: BigInt(now + 2 * 3600),
        quoteId: keccak256(toHex(`quote:${rfq.from}:${now}:${Math.random()}`)),
      };
      signature = await signQuote(this.key, this.chain.chainId, this.cfg.escrow, quote);
    }
    const rationale = !supported
      ? "Declined: unsupported problem or unknown data commitment."
      : `${evaluation.reason} Quote binds price, payee (my vault), the verifier and the exact problem hash; the client cannot alter any of them.`;
    const recordHash = this.record("rfq", { rfq, brain: transcript, guardFlags: g.flags, notes, evaluation, quote, signature, accepted, rationale });
    this.say(`RFQ from ${rfq.from}: ${accepted ? `QUOTED ${fmtUsd(evaluation.price)} tUSD` : "DECLINED"}${notes.length ? ` · ${notes.length} security note(s)` : ""}`);
    return { accepted, quote, signature, evaluation, flags: g.flags, notes, rationale, recordHash, engine: transcript.engine };
  }

  // ───────────────────────────────── 2. autonomous fulfilment ─────────────────────────────────

  /** Polls the escrow for funded jobs that name this agent as provider and fulfils each once. */
  async pollJobs(): Promise<FulfilmentReport[]> {
    const logs = (await this.chain.pub.getContractEvents({ address: this.cfg.escrow, abi: ProofEscrowAbi, eventName: "JobOpened", fromBlock: this.cfg.deployBlock })) as any[];
    const out: FulfilmentReport[] = [];
    for (const l of logs) {
      const id = String(l.args.jobId);
      if (this.seenJobs.has(id) || getAddress(l.args.provider) !== getAddress(this.key.address)) continue;
      this.seenJobs.add(id);
      out.push(await this.fulfil(id));
    }
    return out;
  }

  async fulfil(jobId: string): Promise<FulfilmentReport> {
    this.say(`job #${jobId} funded on-chain → fulfilling`);
    // (a) buy the licensed input through the certified payment pipeline
    const { invoice, signature: vendorSig } = await call<{ invoice: Invoice; signature: Hex }>(`${this.cfg.vendorUrl}/invoice`, { productId: "helix-risk-model-2026-10", buyer: this.cfg.vault, jobId });
    const rationale = `Job #${jobId} requires the Helix model committed in its spec; buying it for ${fmtUsd(BigInt(invoice.amount))} tUSD to earn the escrowed fee.`;
    const req: CertRequest = { kind: "purchase", mandate: this.cfg.mandate, ownerSig: this.cfg.ownerSig, invoice, vendorSig, jobId, rationale, brainEngine: this.brain.engine };
    const cert = await call<CertResponse>(`${this.cfg.cosignerUrl}/certify`, req);
    if (!cert.approved || !cert.certificate || !cert.signature) throw new Error(`co-signer refused: ${cert.reasons.join("; ")}`);
    this.say(`co-signer approved invoice ${invoice.invoiceId} (evidence ${cert.evidenceHash.slice(0, 10)}…) → executing payment with my own key`);
    const paymentTx = await this.executePayment(cert.certificate, cert.signature);
    this.say(`paid ${fmtUsd(BigInt(invoice.amount))} tUSD to vendor · tx ${paymentTx.hash}`);

    // (b) receive data; verify it is exactly what the job committed to
    const { payload, signature: dataSig } = await call<any>(`${this.cfg.vendorUrl}/deliver`, { invoiceId: invoice.invoiceId });
    const dataSigner = await recoverMessageAddress({ message: JSON.stringify(payload), signature: dataSig });
    if (getAddress(dataSigner) !== getAddress(invoice.vendor)) throw new Error("data not signed by vendor");
    const spec: MinVarSpec = { n: payload.n, cov: payload.cov.map(BigInt), tol: BigInt(payload.tol), universe: payload.universe };
    const specBytes = encodeSpec(spec);
    if (keccak256(specBytes) !== invoice.dataCommitment) throw new Error("delivered data does not match the committed spec");

    // (c) solve + certify (exact support enumeration → KKT multipliers + Cholesky witness)
    const t0 = performance.now();
    const sol = certify(spec);
    const solveMs = performance.now() - t0;
    const rep = checkCertificate(spec, sol);
    if (!rep.ok) throw new Error(`local certificate check failed: ${rep.violations.join(",")}`);
    const solution = encodeSolution(sol);
    // (d) pre-flight against the on-chain checker, then deliver
    await this.chain.pub.readContract({ address: this.cfg.escrow, abi: ProofEscrowAbi, functionName: "check", args: [BigInt(jobId), specBytes, solution] });
    const deliverTx = await this.chain.send(this.key, this.cfg.escrow, fn(ProofEscrowAbi, "deliver", [BigInt(jobId), specBytes, solution]));
    const weights = sol.w.map((w, i) => ({ asset: payload.assets[i], weight: wadToNumber(w) }));
    const variance = wadToNumber(rep.variance);
    this.say(`delivered certified optimum (σ = ${(Math.sqrt(variance) * 100).toFixed(2)}%, solved in ${solveMs.toFixed(1)} ms) · escrow settled · tx ${deliverTx.hash}`);
    this.lastDecision =
      `For job #${jobId} I bought the Helix risk model (${fmtUsd(BigInt(invoice.amount))} tUSD, invoice ${invoice.invoiceId}) because the client's spec commits to exactly that data; ` +
      `the co-signer verified 12 checks (record ${cert.evidenceHash.slice(0, 10)}…). I solved the minimum-variance portfolio — ${weights.filter((w) => w.weight > 0).map((w) => `${w.asset} ${(w.weight * 100).toFixed(1)}%`).join(", ")} — ` +
      `and the escrow's on-chain KKT check accepted the proof and paid the fee into the vault.`;
    this.decisions.push(this.lastDecision);
    const report: Omit<FulfilmentReport, "recordHash"> = {
      jobId,
      invoice,
      cert,
      paymentTx,
      weights,
      variance,
      volatility: Math.sqrt(variance),
      certificateReport: {
        ok: rep.ok,
        maxStationarityResidual: rep.maxStationarityResidual.toString(),
        dualityGap: rep.dualityGap.toString(),
        maxPsdResidual: rep.maxPsdResidual.toString(),
        optimalityBound: rep.optimalityBound,
      },
      deliverTx,
    };
    const recordHash = this.record("fulfilment", { ...report, solveMs, solution: { w: sol.w, nu: sol.nu, mu: sol.mu, support: sol.support } });
    return { ...report, recordHash };
  }

  async executePayment(c: Certificate, cosignerSig: Hex): Promise<TxResult> {
    return this.chain.send(this.key, this.cfg.vault, fn(QEDVaultAbi, "executePayment", [this.cfg.mandate, this.cfg.ownerSig, c, cosignerSig]));
  }

  // ───────────────────────────────── 3. owner console ─────────────────────────────────

  /**
   * One conversational turn with the owner. Value-moving actions require a signed confirmation:
   * the console signs the exact instruction with the OWNER key (the agent never holds it), and the
   * co-signer verifies that signature before certifying.
   */
  async chat(message: string, confirmation?: { nonce: string; signature: Hex }) {
    const ctx = await this.chatContext();
    const { result, transcript } = await this.brain.interpret(message, ctx, "owner");
    const g = guard(message, result, ctx, this.cfg.mandate.maxPerPayment);
    let executed: { tx: TxResult; cert: CertResponse } | undefined;
    let reply = g.reply;

    if (g.intent === "cancel") this.pending = undefined;
    else if (g.intent === "confirm" && this.pending?.kind === "pay" && this.pending.amount && this.pending.payee) {
      if (!confirmation) {
        reply = "To execute I need your owner signature on the exact instruction (the console asks your wallet to sign it).";
      } else {
        const p = this.pending;
        const req: CertRequest = {
          kind: "owner-instructed",
          mandate: this.cfg.mandate,
          ownerSig: this.cfg.ownerSig,
          payee: p.payee!,
          amount: p.amount!,
          dueInDays: p.dueInDays,
          instruction: p.memo ?? message,
          nonce: confirmation.nonce,
          instructionSig: confirmation.signature,
        };
        const cert = await call<CertResponse>(`${this.cfg.cosignerUrl}/certify`, req);
        if (!cert.approved || !cert.certificate || !cert.signature) {
          reply = `The independent co-signer refused: ${cert.reasons.join("; ")}. Nothing was sent.`;
        } else {
          const tx = await this.executePayment(cert.certificate, cert.signature);
          executed = { tx, cert };
          const t = await this.treasury();
          reply = `Done. ${fmtUsd(p.amount!)} tUSD ${p.dueInDays ? `ring-fenced for ${p.payeeLabel}, due in ${p.dueInDays} day(s)` : `paid to ${p.payeeLabel}`}. Tx ${tx.hash.slice(0, 10)}… · free balance now ${fmtUsd(t.free)} tUSD · ring-fenced ${fmtUsd(t.protectedBalance)} tUSD.`;
          this.lastDecision = `I executed your signed instruction to ${p.dueInDays ? "promise" : "pay"} ${p.payeeLabel} ${fmtUsd(p.amount!)} tUSD${p.dueInDays ? ` (ring-fenced, due in ${p.dueInDays} days)` : ""} after the co-signer passed ${cert.checks.length} checks (record ${cert.evidenceHash.slice(0, 10)}…).`;
          this.decisions.push(this.lastDecision);
        }
        this.pending = undefined;
      }
    } else if (g.needsConfirmation && g.proposal) {
      this.pending = g.proposal;
    } else if (g.proposal?.kind === "pay" && g.clarify) {
      this.pending = g.proposal; // remember partial intent so the next turn can complete it
    } else if (!g.proposal && (g.intent === "pay" || g.intent === "reveal_secret" || g.intent === "raise_limits")) {
      this.pending = undefined;
    }

    const recordHash = this.record("chat", { message, brain: transcript, guard: { intent: g.intent, flags: g.flags, notes: g.guardNotes, needsConfirmation: g.needsConfirmation }, reply, executed: executed ? { tx: executed.tx.hash, evidenceHash: executed.cert.evidenceHash } : undefined });
    return { reply, intent: g.intent, flags: g.flags, needsConfirmation: g.needsConfirmation, pending: this.pending, executed, recordHash, engine: transcript.engine };
  }
}
