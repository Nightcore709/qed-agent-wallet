/**
 * The standing treasury policy (baseline WF-4, M-20, M-21): the owner signs a reserve target once; each tick the
 * agent decides X = min(need, impact, policy cap, mandate cap, free funds), the co-signer re-derives it, and the
 * trade is proved on-chain. The release's own functions make every decision (roles/treasury.ts); this file adds:
 *
 *   - ticks that a backend scheduler calls (POST /policy/tick), and a server-side "run until the target is met" with
 *     stop conditions (POST /policy/run), instead of a loop in a browser tab (baseline W-07, F-046);
 *   - the five candidates of every tick stored durably;
 *   - supersession: a new policy or a revocation is registered with the co-signer under the owner's signature, and
 *     an older policy is refused from then on (baseline W-02);
 *   - optional enforcement by the unmodified QEDTreasuryPolicy contract ("contract" mode, baseline X-06, F-045):
 *     the owner sets the policy on-chain and makes the contract QEDExecution's operator. A zero over-conversion
 *     slack is refused here because the contract accepts it and can then never finish (baseline W-11). While the
 *     contract is the operator, direct conversions and the Security Lab are unavailable (baseline W-12); ending the
 *     policy restores them.
 */
import { fromInr } from "../../shared/chain-assets.ts";
import { getAddress, type Address, type Hex } from "viem";
import type { OpResult, PolicyView, ProposalKind, TickRecord, TrancheCandidates } from "../types.ts";
import { notMet } from "./words.ts";
import { CHAIN_ID } from "./config.ts";
import { policySequence, revocationMessage } from "./cosigner.ts";
import type { OwnerAction } from "./keys.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";
import { parse, type Row } from "./store.ts";

const ser = <T = any>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const ppm = (out: bigint, bound: bigint) => (bound > 0n ? (Number(bound - out) / Number(bound)) * 1e6 : 0);
const IMPACT_BPS = 150, DEFAULT_SLACK_BPS = 10;
/**
 * Tranche bounds in the treasury's asset: the release's 2 to 25 tUSD in the baseline; 200 to 2,000 tINR in a workspace,
 * about the same value at the test pools' synthetic 84 tINR per tUSD (deploy.ts → INR_VENUES). S5: a workspace whose
 * treasury holds another test token takes the same bounds carried into it at the genesis rates, rounded down
 * (shared/chain-assets.ts fromInr; unchanged for tINR).
 */
const trancheBounds = (rail: RailService) => (rail.isBaseline ? { min: 2_000_000n, max: 25_000_000n } : { min: fromInr(20_000n, rail.currencies.treasury), max: fromInr(200_000n, rail.currencies.treasury) });

export interface ActivePolicy { id: number; row: Row; policy: any; sig: Hex; enforcement: "cosigner" | "contract"; needSlackBps: number | null }

export function installPolicy(rail: RailService) {
  const toPolicy = (f: any) => ({ vault: f.vault, reserve: f.reserve, tokenIn: f.tokenIn, tokenOut: f.tokenOut, targetFree: BigInt(f.targetFree), maxTranche: BigInt(f.maxTranche), minTranche: BigInt(f.minTranche), maxImpactBps: Number(f.maxImpactBps), validUntil: BigInt(f.validUntil), nonce: f.nonce });
  const active = (): ActivePolicy | null => {
    const row = rail.store.activePolicy();
    if (!row) return null;
    return { id: Number(row.id), row, policy: toPolicy(parse(row.policy)), sig: row.policy_sig as Hex, enforcement: row.enforcement as "cosigner" | "contract", needSlackBps: row.need_slack_bps === null ? null : Number(row.need_slack_bps) };
  };
  const operator = async () => getAddress((await rail.read(rail.a.exec, rail.v.abi.QEDExecutionAbi, "operator")) as Address);
  const contractWired = async () => !!rail.a.treasuryPolicy && (await operator()) === rail.a.treasuryPolicy;
  const candidates = (c: any): TrancheCandidates => ser({ need: c.need, impact: c.impact, policyCap: c.policyCap, mandateCap: c.mandateCap, freeFunds: c.freeFunds });

  rail.policyView = async (): Promise<PolicyView | null> => {
    const ap = active();
    if (!ap) return null;
    const free = (await rail.read(rail.a.reserve, rail.v.abi.QEDVaultAbi, "freeBalance")) as bigint;
    const short = ap.policy.targetFree > free ? ap.policy.targetFree - free : 0n;
    const expired = (await rail.chainNow()) > ap.policy.validUntil;
    return ser({ id: ap.id, status: expired ? "expired" : "active", enforcement: ap.enforcement, targetFree: ap.policy.targetFree, minTranche: ap.policy.minTranche, maxTranche: ap.policy.maxTranche, maxImpactBps: ap.policy.maxImpactBps, needSlackBps: ap.needSlackBps, validUntil: Number(ap.policy.validUntil), nonce: ap.policy.nonce, message: ap.row.message, signedAt: ap.row.signed_at, ticks: Number(ap.row.ticks), reserveFree: free, shortfall: short, targetMet: short === 0n, policyContract: ap.enforcement === "contract" ? rail.a.treasuryPolicy : null });
  };

  // ───────────── owner signs a policy ─────────────
  rail.proposers.set("policy", async (p) => {
    if (Object.keys(p).some((k) => !["targetFree", "enforcement", "needSlackBps"].includes(k))) throw new RailError("invalid_params", "Policy parameters: targetFree (required); optionally enforcement (\"cosigner\" or \"contract\") and, for \"contract\", needSlackBps.", 422);
    const target = rail.raw(p.targetFree, "Reserve target", rail.reserveAsset.decimals);
    const RU = 10n ** BigInt(rail.reserveAsset.decimals);
    if (target < 2n * RU || target > 80n * RU) throw new RailError("invalid_params", `Choose a reserve target between 2 and 80 ${rail.reserveAsset.symbol}.`, 422);
    const enforcement = p.enforcement === undefined ? "cosigner" : p.enforcement;
    if (enforcement !== "cosigner" && enforcement !== "contract") throw new RailError("invalid_params", "enforcement must be \"cosigner\" or \"contract\".", 422);
    let slack: number | null = null;
    if (enforcement === "contract") {
      slack = p.needSlackBps === undefined ? DEFAULT_SLACK_BPS : Number(p.needSlackBps);
      if (!Number.isInteger(slack) || slack > 1000 || slack < 0) throw new RailError("invalid_params", "needSlackBps must be a whole number from 1 to 1000.", 422);
      if (slack === 0) throw new RailError("zero_slack_refused", "A zero over-conversion slack is refused: the contract accepts it, but then every tranche that reaches the target reverts with OverConversion, so the target can never be met (baseline W-11). Use at least 1 basis point.", 422);
    } else if (p.needSlackBps !== undefined) throw new RailError("invalid_params", "needSlackBps applies to contract enforcement only.", 422);
    if (!rail.activeMandate()) throw new RailError("no_mandate", "No active mandate: the owner must sign one before a standing policy.", 409);
    const now = await rail.chainNow();
    const seq = rail.store.next("policySequence");
    const prev = active();
    const policy = { vault: rail.a.vault, reserve: rail.a.reserve, tokenIn: rail.a.asset, tokenOut: rail.a.reserveAsset, targetFree: target.toString(), maxTranche: trancheBounds(rail).max.toString(), minTranche: trancheBounds(rail).min.toString(), maxImpactBps: IMPACT_BPS, validUntil: (now + 30n * 86_400n).toString(), nonce: `rail-policy-${rail.genesisId!.slice(0, 8)}-${seq}` };
    const wired = await contractWired();
    const actions: OwnerAction[] = [];
    if (enforcement === "contract") {
      actions.push({ to: rail.a.treasuryPolicy!, contract: "QEDTreasuryPolicy", function: "setPolicy", args: [{ targetFree: policy.targetFree, minTranche: policy.minTranche, maxTranche: policy.maxTranche, maxImpactBps: IMPACT_BPS, needSlackBps: slack, validUntil: policy.validUntil }] });
      actions.push({ to: rail.a.exec, contract: "QEDExecution", function: "setOperator", args: [rail.a.treasuryPolicy] });
    } else if (wired) {
      actions.push({ to: rail.a.treasuryPolicy!, contract: "QEDTreasuryPolicy", function: "revoke", args: [] });
      actions.push({ to: rail.a.exec, contract: "QEDExecution", function: "setOperator", args: [rail.K.OPERATOR.address] });
    }
    const terms = { kind: "policy", chainId: CHAIN_ID, genesisId: rail.genesisId, sequence: seq, policy, message: rail.v.treasury.policyMessage(toPolicy(policy) as never), enforcement, needSlackBps: slack, supersedes: prev ? { id: prev.id, nonce: prev.policy.nonce } : null, actions };
    const how = enforcement === "contract" ? ` Enforced on-chain by QEDTreasuryPolicy (at most ${slack! / 100}% over-conversion); while it is wired, direct conversions and the Security Lab are unavailable.` : " Enforced by the co-signer, which re-derives every tranche.";
    return { terms, summary: `Standing policy: keep ≥ ${rail.fmtR(target)} ${rail.reserveAsset.symbol} free in the ${rail.reserveName}; tranches ${rail.fmt(trancheBounds(rail).min)}–${rail.fmt(trancheBounds(rail).max)} ${rail.asset.symbol}; ≤ ${IMPACT_BPS / 100}% execution cost; valid 30 days.${how}${prev ? " Replaces the current policy." : ""}`, allowed: true, checks: [], replaces: ["policy"] as ProposalKind[] };
  });

  const ownerActions = async (ctx: Ctx) => {
    const A = rail.v.abi;
    const acts = ctx.terms.actions as OwnerAction[];
    let last: any = null;
    if (rail.scheduleOf(ctx.terms)) {
      // A passkey batch: one execute runs the immediate calls (QEDTreasuryPolicy.revoke) and schedules the guarded
      // ones (setPolicy, setOperator) behind the owner account's delay.
      last = await rail.ownerSend(ctx, 0, A.QEDExecutionAbi);
      for (let i = 0; i < acts.length; i++) ctx.push({ key: rail.isScheduled(ctx.terms, i) ? "scheduled" : "receipt", label: `${acts[i].contract}.${acts[i].function} ${rail.isScheduled(ctx.terms, i) ? "scheduled" : "mined"}`, status: rail.isScheduled(ctx.terms, i) ? "info" : "ok", detail: rail.isScheduled(ctx.terms, i) ? "A guarded call: it runs only after the owner account's delay." : `Owner transaction in block ${last.blockNumber}.`, data: rail.txData(last) });
      return last;
    }
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      if (a.function === "setOperator" && (await operator()) === getAddress(a.args[0] as Address)) { ctx.push({ key: "receipt", label: "QEDExecution.setOperator already done", status: "info", detail: "Not sent again." }); continue; }
      const abi = a.contract === "QEDTreasuryPolicy" ? A.QEDTreasuryPolicyAbi : A.QEDExecutionAbi;
      const decode = a.function === "setPolicy" ? (args: unknown[]) => { const x = args[0] as any; return [{ targetFree: BigInt(x.targetFree), minTranche: BigInt(x.minTranche), maxTranche: BigInt(x.maxTranche), maxImpactBps: x.maxImpactBps, needSlackBps: x.needSlackBps, validUntil: BigInt(x.validUntil) }]; } : undefined;
      last = await rail.ownerSend(ctx, i, abi, decode);
      ctx.push({ key: "receipt", label: `${a.contract}.${a.function} mined`, status: "ok", detail: `Owner transaction in block ${last.blockNumber}.`, data: rail.txData(last) });
    }
    return last;
  };

  /** The policy takes effect: the co-signer registers the owner's signature and the store records it as the active one. */
  const activate = async (t: any, signature: Hex, approvalId: string, jobId: string, clock: unknown, termsHash: string) => {
    await rail.cosigner.registerPolicy(toPolicy(t.policy), signature);
    if (!rail.store.policies().find((r) => r.nonce === t.policy.nonce)) {
      rail.store.tx(() => {
        rail.store.endActivePolicies("superseded", rail.iso());
        rail.store.insertPolicy({ nonce: t.policy.nonce, policy: t.policy, message: t.message, policySig: signature, enforcement: t.enforcement, needSlackBps: t.needSlackBps, signedAt: rail.iso(), approvalId });
      });
      rail.store.appendDecision({ at: rail.iso(), kind: "owner-policy", jobId, verdict: "SIGNED", clock: clock ?? (await rail.clock()), termsHash, record: { sequence: t.sequence, policy: t.policy, enforcement: t.enforcement, needSlackBps: t.needSlackBps, supersedes: t.supersedes } });
    }
  };
  rail.applyHooks.set("policy", async (ctx, d) => { await activate(d.terms, d.signature, d.approvalId, ctx.jobId, ctx.clock, d.termsHash); return "The standing policy is in force; the co-signer refuses every older one."; });
  rail.applyHooks.set("policy-revoke", async () => "QEDExecution's operator is the agent key again: direct conversions are possible.");
  rail.handlers.set("policy", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const current = active();
    const existing = rail.store.policies().find((r) => r.nonce === t.policy.nonce);
    if (!existing && (t.supersedes?.id ?? null) !== (current?.id ?? null)) throw new RailError("policy_changed", "Another policy was signed or ended after these terms were prepared. Nothing was signed; prepare the policy again.", 409);
    if (rail.scheduleOf(t)) {
      // the owner's signature on the text is checked now (ERC-1271); the policy takes effect when the change is applied
      const { signature } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
      const lastTx = await ownerActions(ctx);
      const sch = await rail.recordScheduled(ctx, lastTx, { kind: "policy", summary: `Standing policy: keep ≥ ${rail.fmtR(t.policy.targetFree)} ${rail.reserveAsset.symbol} free in the ${rail.reserveName}${t.enforcement === "contract" ? ", enforced by the policy contract" : ""}`, data: { terms: t, signature, approvalId: ctx.approval!.approvalId, termsHash: ctx.proposal!.termsHash } });
      return rail.scheduledOutcome(ctx, lastTx, "The standing policy is signed by the owner's passkey; the current policy stays in force until the change is applied.", sch);
    }
    const lastTx = await ownerActions(ctx);
    const { signature } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
    await rail.cosigner.registerPolicy(toPolicy(t.policy), signature);
    if (!existing) {
      rail.store.tx(() => {
        rail.store.endActivePolicies("superseded", rail.iso());
        rail.store.insertPolicy({ nonce: t.policy.nonce, policy: t.policy, message: t.message, policySig: signature, enforcement: t.enforcement, needSlackBps: t.needSlackBps, signedAt: rail.iso(), approvalId: ctx.approval!.approvalId });
      });
      rail.store.appendDecision({ at: rail.iso(), kind: "owner-policy", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await rail.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { sequence: t.sequence, policy: t.policy, enforcement: t.enforcement, needSlackBps: t.needSlackBps, supersedes: t.supersedes } });
    }
    ctx.push({ key: "owner", label: "Owner signs standing policy (EIP-191)", status: "ok", detail: `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds this exact text. From now on the agent decides when and how much to convert; the co-signer re-derives every decision before it signs${t.enforcement === "contract" ? ", and the policy contract checks it again when the trade executes" : ""}.${t.supersedes ? " The previous policy is superseded: the co-signer refuses it from now on." : ""}`, data: { sequence: t.sequence, termsHash: ctx.proposal!.termsHash } });
    const title = `Owner signed a standing policy: keep ≥ ${rail.fmtR(t.policy.targetFree)} ${rail.reserveAsset.symbol} free in the ${rail.reserveName}; tranches ${rail.whole(trancheBounds(rail).min)}–${rail.whole(trancheBounds(rail).max)} ${rail.asset.symbol}; ≤ 1.5% execution cost${t.enforcement === "contract" ? "; enforced by the policy contract" : ""}`;
    rail.record(ctx, { kind: "policy", title, outcome: "executed", tx: lastTx ? rail.txBrief(lastTx) : undefined });
    return { outcome: "executed", summary: title, tx: lastTx ? rail.txBrief(lastTx) : undefined, evidence: { sequence: t.sequence, enforcement: t.enforcement } };
  });

  rail.proposers.set("policy-revoke", async (p) => {
    if (Object.keys(p).length) throw new RailError("invalid_params", "policy-revoke takes no parameters.", 422);
    const ap = active();
    if (!ap) throw new RailError("no_policy", "There is no standing policy to end.", 409);
    const through = policySequence(ap.policy.nonce)!;
    const actions: OwnerAction[] = (await contractWired()) ? [{ to: rail.a.treasuryPolicy!, contract: "QEDTreasuryPolicy", function: "revoke", args: [] }, { to: rail.a.exec, contract: "QEDExecution", function: "setOperator", args: [rail.K.OPERATOR.address] }] : [];
    const terms = { kind: "policy-revoke", chainId: CHAIN_ID, genesisId: rail.genesisId, policyId: ap.id, nonce: ap.policy.nonce, sequence: through, message: revocationMessage(rail.a.vault, through), actions };
    return { terms, summary: `End the standing policy (target ${rail.fmtR(ap.policy.targetFree)} ${rail.reserveAsset.symbol}). The co-signer refuses it from then on${actions.length ? "; the policy contract is revoked and the operator key becomes QEDExecution's operator again" : ""}.`, allowed: true, checks: [], replaces: ["policy-revoke"] as ProposalKind[] };
  });
  rail.handlers.set("policy-revoke", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const lastTx = await ownerActions(ctx);
    // the revocation itself is immediate; giving the operator role back to the agent key waits for the delay
    if (rail.scheduleOf(t)) await rail.recordScheduled(ctx, lastTx, { kind: "policy-revoke", summary: "Make the agent key QEDExecution's operator again (direct conversions)" });
    const { signature } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
    const out = await rail.cosigner.revokePolicies(t.message, signature);
    rail.store.endActivePolicies("revoked", rail.iso());
    rail.store.appendDecision({ at: rail.iso(), kind: "owner-policy-revoke", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await rail.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { nonce: t.nonce, revokedThrough: out.revokedThrough } });
    ctx.push({ key: "owner", label: "Owner ends the standing policy", status: "ok", detail: `Approval ${ctx.approval!.approvalId} binds the revocation. The co-signer verified the owner's signature and refuses every policy through sequence ${out.revokedThrough}.`, data: { revokedThrough: out.revokedThrough } });
    const title = "Owner ended the standing policy; the agent no longer converts on its own";
    rail.record(ctx, { kind: "policy", title, outcome: "executed", tx: lastTx ? rail.txBrief(lastTx) : undefined });
    return { outcome: "executed", summary: title, tx: lastTx ? rail.txBrief(lastTx) : undefined };
  });
  rail.rerunnable.add("policy").add("policy-revoke");

  // ───────────── one tick ─────────────
  type TickOut = OpResult & { action: "convert" | "wait" | "none"; tick: number };
  async function tickOnce(ctx: Ctx): Promise<TickOut> {
    const { v, a, pub, fmt, fmtR } = rail;
    const S = rail.asset.symbol, R = rail.reserveAsset.symbol;
    const T = v.trader, A = v.abi;
    const ap = active();
    if (!ap) throw new RailError("no_policy", "No standing policy yet: the owner must sign one first.", 409);
    const am = rail.activeMandate();
    if (!am) throw new RailError("no_mandate", "No active mandate: the standing policy cannot act without one.", 409);
    const policy = ap.policy;
    ctx.clock = await rail.align();
    const view = await v.treasury.observeTreasury(pub, policy, a.exec, rail.reserveBuffer);
    const d = v.treasury.decideTranche(view.venues, policy, view.reserveFree, view.available, am.mandate.maxPerPayment);
    const n = rail.store.bumpPolicyTicks(ap.id);
    const cands = `need ${d.candidates.need === null ? "more than any allowed tranche" : fmt(d.candidates.need)}, impact limit ${fmt(d.candidates.impact)}, policy cap ${fmt(d.candidates.policyCap)}, mandate cap ${fmt(d.candidates.mandateCap)}, free funds ${fmt(d.candidates.freeFunds)}`;
    const base = { n, policyId: ap.id, action: d.action, amountIn: d.amountIn.toString(), shortfall: d.shortfall.toString(), reserveFree: view.reserveFree.toString(), limitedBy: d.limitedBy ?? null, candidates: candidates(d.candidates), reason: d.reason };
    rail.store.appendDecision({ at: rail.iso(), kind: "policy-decision", jobId: ctx.jobId, verdict: d.action.toUpperCase(), clock: ctx.clock, record: ser({ tick: n, policyNonce: policy.nonce, reserveFree: view.reserveFree, available: view.available, decision: d }) });
    const finish = (r: OpResult): TickOut => {
      rail.store.insertTick(ap.id, rail.iso(), { ...base, outcome: r.outcome, summary: r.summary, tx: r.tx ?? null }, ctx.jobId);
      return { ...r, action: d.action, tick: n };
    };
    ctx.push({ key: "decide", label: "Agent observes and decides", status: d.action === "convert" ? "ok" : "info", detail: d.action === "convert" ? `Reserve has ${fmtR(view.reserveFree)} ${R} free, short ${fmtR(d.shortfall)}. X = min(${cands}) = ${fmt(d.amountIn)} ${S}, limited by ${d.limitedBy}.` : d.action === "none" ? `Reserve has ${fmtR(view.reserveFree)} ${R} free: the ${fmtR(policy.targetFree)} ${R} target is met. Nothing to do, no transaction, no gas.` : `Short ${fmtR(d.shortfall)} ${R} but waiting: ${d.reason.replace(/^wait: /, "")}.`, data: ser({ tick: n, decision: d }) });
    if (d.action !== "convert") {
      const summary = d.action === "none" ? `Tick ${n}: target met (${fmtR(view.reserveFree)} ${R} free); the agent stops.` : `Tick ${n}: the agent waits (${d.reason.replace(/^wait: /, "")}).`;
      rail.record(ctx, { kind: "policy-tick", title: summary, outcome: "no-action" });
      return finish({ outcome: "no-action", summary });
    }
    // The same limits function the preview uses: a tranche the mandate cannot pay for is refused here, by name.
    const lim = await rail.checkLimits(d.amountIn);
    if (!lim.allowed) {
      const why = lim.checks.filter((c) => !c.pass).map((c) => c.rule).join("; ");
      ctx.push({ key: "mandate", label: "Signed mandate and vault limits", status: "refused", detail: `${fmt(d.amountIn)} ${S} breaks: ${why}. The agent cannot raise a limit.`, data: { checks: lim.checks } });
      const summary = `Tick ${n}: refused before signing (${why}). No transaction was sent.`;
      rail.record(ctx, { kind: "policy-tick", title: summary, outcome: "refused" });
      return finish({ outcome: "refused", summary });
    }
    const nonce = `${policy.nonce}:tick-${n}`;
    const r = await rail.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: a.exec, tokenIn: a.asset!, tokenOut: a.reserveAsset!, recipient: a.reserve, amountIn: d.amountIn, instruction: `policy tick ${n}`, nonce, policy, policySig: ap.sig, brainEngine: "deterministic policy" });
    rail.keepDecision(ctx, "cosigner-policy-trade", r);
    ctx.push({ key: "cosigner", label: "Co-signer re-derives the same decision", status: r.approved ? "ok" : "refused", detail: r.approved ? `${r.checks.length} checks, including the shortfall, the tranche rule and the execution cost. Order floor ${fmtR(r.order!.minOut)} ${R}, τ = ${r.order!.tolerancePpm} ppm.` : `Refused: ${notMet(r.reasons)}`, data: ser({ checks: r.checks, reasons: r.reasons, evidenceHash: r.evidenceHash }) });
    if (!r.approved) {
      rail.record(ctx, { kind: "policy-tick", title: `Tick ${n}: co-signer refused (${notMet([r.reasons[0]!])})`, outcome: "refused" });
      return finish({ outcome: "refused", summary: `Co-signer refused: ${notMet(r.reasons)}` });
    }
    const tp = await T.planTrade(pub, a.exec, a.asset!, a.reserveAsset!, d.amountIn);
    const go = T.decide(tp, r.order!);
    ctx.push({ key: "plan", label: "Agent routes and builds the proof", status: go.submit ? "ok" : "refused", detail: `Expected ${fmtR(tp.plan.sim.amountOut)} ${R}, bound ${fmtR(tp.onchainBound)}.`, data: rail.planData(tp) as never });
    if (!go.submit) return finish({ outcome: "refused", summary: go.reasons.join("; ") });
    const viaContract = ap.enforcement === "contract";
    const submitSeq = ctx.push({ key: "submit", label: "Preflight and broadcast", status: "pending", detail: `Preflight under the standing policy${viaContract ? " through the policy contract" : ""}; no transaction hash yet.` });
    const args = [am.mandate, am.ownerSig, r.certificate, r.signature, r.order, T.hopsForChain(tp.plan.route), T.pricesForChain(tp.plan.prices)];
    const data = viaContract ? v.chain.fn(A.QEDTreasuryPolicyAbi, "convert", args) : v.chain.fn(A.QEDExecutionAbi, "trade", args);
    const tx = await rail.send(ctx, "trade", rail.K.OPERATOR, viaContract ? a.treasuryPolicy! : a.exec, data, { intentId: r.certificate!.intentId, onBroadcast: (hash) => ctx.replace(submitSeq, { key: "submit", label: "Transaction broadcast", status: "ok", detail: `Broadcast acknowledged. Transaction ${hash}; awaiting mined receipt.`, data: { hash } }) });
    const be = tx.events.find((e: any) => e.name === "BestExecution")!.args as any;
    const out = BigInt(be.amountOut), bound = BigInt(be.bound);
    const pc = tx.events.find((e: any) => e.name === "PolicyConversion")?.args as any;
    ctx.push({ key: "receipt", label: "Mined: the chain checked the proof", status: "ok", detail: `Block ${tx.blockNumber}, ${tx.gasUsed.toLocaleString("en-US")} gas. ${fmt(d.amountIn)} ${S} → ${fmtR(out)} ${R}, bound ${fmtR(bound)}.${pc ? ` The policy contract's clauses held (mid-price reference ${fmtR(BigInt(pc.midOut))} ${R}).` : ""}`, data: rail.txData(tx) });
    const after = (await rail.read(a.reserve, A.QEDVaultAbi, "freeBalance")) as bigint;
    const ok = after - view.reserveFree === out;
    ctx.push({ key: "reconcile", label: "Reserve re-read", status: ok ? "ok" : "refused", detail: `Free ${R} ${fmtR(view.reserveFree)} → ${fmtR(after)} (target ${fmtR(policy.targetFree)}).`, data: ser({ before: view.reserveFree, after }) });
    if (!ok) {
      const summary = `Transaction ${tx.hash} mined, but reserve reconciliation failed. Do not retry; inspect the receipt.`;
      rail.record(ctx, { kind: "policy-tick", title: summary, outcome: "error", tx: rail.txBrief(tx) });
      return finish({ outcome: "error", summary, tx: rail.txBrief(tx), doNotRetry: true });
    }
    rail.store.setMeta("lastTrade", ser({ at: rail.iso(), instruction: `standing policy, tick ${n}`, amountIn: d.amountIn, amountOut: out, bound, gapPpm: ppm(out, bound), floor: r.order!.minOut, tolerancePpm: r.order!.tolerancePpm, hash: tx.hash, block: tx.blockNumber, gasUsed: tx.gasUsed, plan: rail.planData(tp), cosignerChecks: r.checks.length, engine: "deterministic policy", jobId: ctx.jobId }));
    const summary = `Tick ${n}: converted ${fmt(d.amountIn)} ${S} → ${fmtR(out)} ${R} (limited by ${d.limitedBy}); reserve free ${fmtR(after)} ${R}.`;
    rail.record(ctx, { kind: "policy-tick", title: summary, outcome: "executed", tx: rail.txBrief(tx), trade: { amountIn: d.amountIn.toString(), amountOut: out.toString(), bound: bound.toString(), gapPpm: ppm(out, bound), hops: tp.plan.route.filter((h: any) => h.amountIn > 0n).length, venues: [...new Set(tp.plan.route.map((h: any) => h.venue))] } });
    return finish({ outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ tick: n, amountIn: d.amountIn, amountOut: out, bound, limitedBy: d.limitedBy, candidates: candidates(d.candidates), enforcement: ap.enforcement }) });
  }

  rail.handlers.set("policy-tick", async (ctx) => { const { action: _a, tick: _t, ...r } = await tickOnce(ctx); return r; });
  rail.recoverers.set("policy-tick", (job) => rail.lookupTrade(job, "policy-tick"));
  rail.recoverers.set("policy-run", (job) => rail.lookupTrade(job, "policy-tick"));

  // ───────────── run until the target is met, on the server ─────────────
  /** Stop conditions of a server-side run, checked when the request is accepted and again when it runs. */
  const runParams = (body: any): { maxTicks: number; maxSeconds: number } => {
    const req = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    if (Object.keys(req).some((k) => !["maxTicks", "maxSeconds"].includes(k))) throw new RailError("invalid_params", "A run takes { maxTicks?, maxSeconds? }.", 422);
    const maxTicks = req.maxTicks === undefined ? 6 : req.maxTicks, maxSeconds = req.maxSeconds === undefined ? 120 : req.maxSeconds;
    if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 12 || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 600) throw new RailError("invalid_params", "maxTicks must be 1 to 12 and maxSeconds 1 to 600.", 422);
    return { maxTicks, maxSeconds };
  };
  rail.handlers.set("policy-run", async (ctx): Promise<OpResult> => {
    const { maxTicks, maxSeconds } = runParams(ctx.request);
    const started = rail.now();
    const ran: { tick: number; action: string; outcome: string; summary: string; tx?: unknown }[] = [];
    let stop = "", last: TickOut | null = null;
    while (!stop) {
      if (ran.length >= maxTicks) { stop = `the limit of ${maxTicks} ticks was reached`; break; }
      if (rail.now() - started > maxSeconds * 1000) { stop = `the time limit of ${maxSeconds} s was reached`; break; }
      last = await tickOnce(ctx);
      ran.push({ tick: last.tick, action: last.action, outcome: last.outcome, summary: last.summary, tx: last.tx });
      if (last.action === "none") stop = "the target is met";
      else if (last.action === "wait") stop = "the agent waits: no tranche is allowed right now";
      else if (last.outcome === "refused") stop = "a tick was refused";
      else if (last.outcome !== "executed") stop = "a tick ended in an error";
    }
    const executed = ran.filter((t) => t.outcome === "executed").length;
    const view = await rail.policyView();
    const summary = `Ran ${ran.length} tick${ran.length === 1 ? "" : "s"} (${executed} conversion${executed === 1 ? "" : "s"}); stopped because ${stop}. Reserve free ${view ? rail.fmtR(view.reserveFree) : "?"} ${rail.reserveAsset.symbol}${view ? ` of the ${rail.fmtR(view.targetFree)} target` : ""}.`;
    rail.record(ctx, { kind: "policy-run", title: summary, outcome: last?.doNotRetry ? "error" : executed ? "executed" : "no-action" });
    return { outcome: last?.doNotRetry ? "error" : executed ? "executed" : last?.outcome === "refused" ? "refused" : "no-action", summary, tx: [...ran].reverse().find((t) => t.tx)?.tx as OpResult["tx"], doNotRetry: last?.doNotRetry, evidence: { ticks: ran, stopReason: stop, targetMet: view?.targetMet ?? false, conversions: executed } };
  });

  return {
    active,
    runParams,
    ticks: (limit = 30): TickRecord[] => rail.store.ticks(Math.min(Math.max(1, limit), 200)).map((r) => ({ at: r.at as string, jobId: r.job_id as string, ...(parse<Omit<TickRecord, "at" | "jobId">>(r.record)!) })),
  };
}
