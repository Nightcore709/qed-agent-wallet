/**
 * The six configurable scenarios (baseline WF-6), the rail's time-moving scenario, and the historical evidence index
 * (WF-14).
 *
 * A release scenario is the release's own runWorkbench, unmodified: fresh contracts, fresh valueless tokens and fresh
 * roles per run. Every run is on an EPHEMERAL chain of its own (R7 D4; RailHost.ephemeral), destroyed afterwards, so
 * a scenario that mines blocks, waits for deadlines or moves time never touches the shared chain; the workspace's
 * vaults are compared before and after. Inputs are validated by the release's tool registry, so the bounds are the
 * release's. The owner's approval binds the exact inputs; no owner signature is made, because every scenario role is
 * the scenario's own.
 *
 * `liability_due` is the rail's own scenario (not one of the release's six): a liability ring-fenced for CloudCo,
 * refused as NotDueYet, then the ephemeral chain's clock is moved forward past the due date and it is settled. Moving
 * a chain's clock is exactly what may never happen on the shared chain, so it shows the isolation as well.
 *
 * The zero-knowledge scenario needs the GPL-3.0 tier, which is off by default (owner decision F-052): it is listed
 * as unavailable, with the reason, unless the rail was started with it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { checkApproval } from "../terms.ts";
import type { HistoricalEvidence, OpResult, ProposalKind, ScenarioInfo, StepStatus } from "../types.ts";
import { reading } from "./clock.ts";
import { CHAIN_ID } from "./config.ts";
import type { EphemeralChain } from "./host.ts";
import { historicalEvidence } from "./historical.ts";
import { seedRelease, workspaceFigures } from "./lab.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";

const BOUNDS: Record<Exclude<ScenarioInfo["tool"], "liability_due">, string> = {
  portfolio: "Escrow price above 0 and at most 25 tUSD; 2 to 6 annual volatilities of 1 to 100 percent; zero correlations.",
  private_portfolio: "Escrow price above 0 and at most 25 tUSD; exactly six annual volatilities of 1 to 100 percent; zero correlations.",
  clearing: "2 to 6 distinct member labels; 1 to 16 debts (debtor, creditor, tUSD), each above 0 and at most 1,000 tUSD, between two different listed members.",
  payment: "Above 0 and at most 10 tUSD, to CloudCo.",
  liability: "Above 0 and at most 95 tUSD, ring-fenced for CloudCo.",
  execution_bounty: "Above 0 and at most 25 tUSD in the bounty pool.",
};
export const SCENARIO_TOOLS = Object.keys(BOUNDS) as Exclude<ScenarioInfo["tool"], "liability_due">[];
const DUE_BOUNDS = "Above 0 and at most 95 tUSD, ring-fenced for CloudCo; due in 1 to 365 whole days. The ephemeral chain's clock is moved forward past the due date.";
const DUE_SCHEMA = { type: "object", properties: { amount: { type: "string", pattern: "^[0-9]+(\\.[0-9]{1,6})?$" }, dueInDays: { type: "integer", minimum: 1, maximum: 365 } }, required: ["amount", "dueInDays"], additionalProperties: false };
const ZK_REASON = "The zero-knowledge scenario needs GPL-3.0 components (snarkjs, circomlibjs, the generated Groth16 verifier) and a single-machine trusted setup. They are kept out of the default build pending owner decision F-052. To offer it: see zk-optional/README.md.";

export function installScenarios(rail: RailService) {
  const zkAvailable = () => rail.cfg.zk && existsSync(join(rail.cfg.vendorRoot, "agent/src/engine/privateMinvar.ts"));
  const list = (): ScenarioInfo[] => [...SCENARIO_TOOLS.map((tool) => {
    const c = (rail.v.capabilities.CAPABILITIES as Record<string, { label: string; schema: unknown }>)[tool];
    const available = tool !== "private_portfolio" || zkAvailable();
    return { tool, label: c.label, available, ...(available ? {} : { unavailableReason: ZK_REASON }), bounds: BOUNDS[tool], schema: c.schema, source: "release" as const, chain: "ephemeral" as const };
  }), { tool: "liability_due" as const, label: "A liability falls due (time moves on the run's own chain)", available: true, bounds: DUE_BOUNDS, schema: DUE_SCHEMA, source: "rail" as const, chain: "ephemeral" as const }];
  const dueInputs = (raw: unknown): { amount: string; dueInDays: number } => {
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join() !== "amount,dueInDays") throw new RailError("invalid_tool_input", "liability_due takes { amount, dueInDays }.", 422);
    const s = typeof o.amount === "string" ? rail.v.amounts.scanAmount(o.amount) : { kind: "invalid" as const };
    if (s.kind !== "valid" || s.raw <= 0n || s.raw > 95_000_000n) throw new RailError("invalid_tool_input", "amount must be an exact positive tUSD amount of at most 95, as a string.", 422);
    if (!Number.isInteger(o.dueInDays) || (o.dueInDays as number) < 1 || (o.dueInDays as number) > 365) throw new RailError("invalid_tool_input", "dueInDays must be a whole number from 1 to 365.", 422);
    return { amount: o.amount as string, dueInDays: o.dueInDays as number };
  };

  rail.proposers.set("scenario", async (p) => {
    if (Object.keys(p).sort().join() !== "parameters,tool" || typeof p.tool !== "string") throw new RailError("invalid_params", "Scenario parameters: { tool, parameters }.", 422);
    const tool = p.tool as ScenarioInfo["tool"];
    if (!(SCENARIO_TOOLS as string[]).includes(tool) && tool !== "liability_due") throw new RailError("unsupported_scenario", "Unsupported capability. No arbitrary scripts, destinations or RPC endpoints are accepted.", 422);
    if (tool === "private_portfolio" && !zkAvailable()) throw new RailError("zk_optional_disabled", ZK_REASON, 409);
    const parameters = tool === "liability_due" ? dueInputs(p.parameters) : rail.validateTool(tool, p.parameters);
    const description = tool === "liability_due" ? `A liability falls due: ${(parameters as { amount: string }).amount} tUSD ring-fenced for CloudCo, due in ${(parameters as { dueInDays: number }).dueInDays} day(s); the run's own chain is moved forward past the due date and the liability is settled.` : rail.v.capabilities.describeCapability(tool, parameters);
    const terms = { kind: "scenario", chainId: CHAIN_ID, genesisId: rail.genesisId, tool, parameters, description, isolation: "Runs on an ephemeral Anvil chain of its own with fresh contracts, fresh valueless test tokens and fresh roles, destroyed afterwards. This workspace's vaults, keys and authority, and the shared chain, are not involved." };
    return { terms, summary: `Isolated scenario · ${description}`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });

  rail.handlers.set("scenario", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    checkApproval(ctx.approval, t, ctx.window);
    const before = await workspaceFigures(rail);
    let r: any = null;
    await rail.host.ephemeral(ctx.jobId, async (e) => {
      ctx.clock = reading(Number((await e.c.pub.getBlock()).timestamp), rail.now(), rail.cfg.maxClockLeadSeconds);
      rail.store.appendDecision({ at: rail.iso(), kind: "owner-scenario", jobId: ctx.jobId, verdict: "CONFIRMED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { tool: t.tool, parameters: t.parameters, chain: "ephemeral", port: e.port } });
      if (t.tool === "liability_due") { r = await liabilityDue(ctx, e, t.parameters); return; }
      // execution_bounty needs a provisioned execution market; the others deploy everything they use themselves
      const market = t.tool === "execution_bounty" ? (await seedRelease(rail, e, ctx.jobId)).a : null;
      ctx.push({ key: "chain", label: "Ephemeral chain started", status: "info", detail: `A new Anvil on 127.0.0.1:${e.port}, only for this run${market ? ", with the release's execution market seeded under throwaway keys" : ""}. It is destroyed when the run ends.`, data: { port: e.port } });
      // The release writes scenario records relative to the working directory; point that at the data folder.
      const cwd = process.cwd();
      process.chdir(rail.cfg.railDir);
      try {
        r = await rail.v.workbench.runWorkbench(e.c, t.tool, t.parameters, (s: any) => ctx.push({ key: s.key, label: s.label, status: s.status as StepStatus, detail: s.detail, data: s.data }), market ? { exec: market.exec, usd: market.usd, eur: market.eur } : undefined);
      } finally { process.chdir(cwd); }
    });
    const after = await workspaceFigures(rail);
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    ctx.push({ key: "teardown", label: "Ephemeral chain destroyed", status: unchanged ? "info" : "refused", detail: unchanged ? "The run's chain is stopped and its folder deleted. This workspace's vaults are exactly as they were." : "WARNING: this workspace's vaults changed during an ephemeral run.", data: { before, after } });
    rail.record(ctx, { kind: "scenario", title: `${t.tool}: ${r.summary}`, outcome: unchanged ? r.outcome : "error", tx: r.tx });
    if (!unchanged) return { outcome: "error", summary: `${r.summary} WARNING: the main treasury changed during an isolated scenario.`, tx: r.tx, doNotRetry: true, evidence: { before, after } };
    return { outcome: r.outcome, summary: r.summary, tx: r.tx, evidence: { ...(r.evidence ?? {}), tool: t.tool, chain: "ephemeral", mainTreasuryUnchanged: true } };
  });

  /** The rail's time-moving scenario, on the ephemeral chain only. */
  async function liabilityDue(ctx: Ctx, e: EphemeralChain, p: { amount: string; dueInDays: number }) {
    const v = rail.v, A = v.abi, c = e.c, pub = c.pub, fn = v.chain.fn, fmt = (x: bigint) => v.amounts.formatMicro(x);
    const amount = (v.amounts.scanAmount(p.amount) as { raw: bigint }).raw;
    const seeded = await seedRelease(rail, e, ctx.jobId);
    const { a, K } = seeded;
    const shared0 = await rail.host.clock();
    ctx.push({ key: "chain", label: "Ephemeral chain started and seeded", status: "info", detail: `A new Anvil on 127.0.0.1:${e.port}, only for this run: the release's vault with 100 tUSD and throwaway keys. Its clock may be moved; the shared chain's may not.`, data: { port: e.port, network: seeded.network } });
    const send = async (purpose: string, who: typeof K.OWNER, data: Hex, expectRevertGas?: bigint) => {
      const fromBlock = (await pub.getBlockNumber()).toString();
      const id = rail.store.insertAttempt({ jobId: ctx.jobId, purpose: `ephemeral:${purpose}`, intentId: null, sender: who.address, target: a.vault, dataHash: keccak256(data), fromBlock, at: rail.iso(), network: seeded.network });
      const tx = expectRevertGas ? await c.sendExpectingRevert(who, a.vault, data, expectRevertGas) : await c.send(who, a.vault, data);
      rail.store.updateAttempt(id, { status: tx.status === "success" ? "mined-success" : "mined-revert", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), errorName: tx.error?.name ?? null, at: rail.iso() });
      rail.saveReceipt(ctx.jobId, tx, seeded.network);
      return tx;
    };
    const t0 = Number((await pub.getBlock()).timestamp);
    const dueAt = BigInt(t0) + BigInt(p.dueInDays) * 86_400n;
    const ring = await send("ring-fence", K.OWNER, fn(A.QEDVaultAbi, "ringFence", [K.CLOUDCO.address, amount, dueAt, keccak256(toHex(`lab-due-${ctx.jobId}`))]));
    const id = BigInt((ring.events.find((x: any) => x.name === "LiabilityCreated")!.args as any).id);
    ctx.push({ key: "ring-fence", label: `Liability #${id} ring-fenced`, status: "ok", detail: `${fmt(amount)} tUSD for CloudCo, due ${new Date(Number(dueAt) * 1000).toISOString()} (in ${p.dueInDays} day${p.dueInDays === 1 ? "" : "s"}).`, data: rail.txData(ring) });
    const early = await send("settle-before-due", K.LP1, fn(A.QEDVaultAbi, "settle", [id]), 300_000n);
    ctx.push({ key: "not-due", label: `Settlement before the due date: ${early.error?.name ?? "reverted"}`, status: "reverted", detail: `Mined as a revert in block ${early.blockNumber}: the vault pays nothing before the due date.`, data: rail.txData(early) });
    await e.anvil.rpc("evm_increaseTime", [toHex(p.dueInDays * 86_400 + 60)]);
    await e.anvil.rpc("evm_mine", []);
    const t1 = Number((await pub.getBlock()).timestamp);
    const shared1 = await rail.host.clock();
    ctx.push({ key: "time", label: `This chain's clock moved forward ${Math.round((t1 - t0) / 86_400)} days`, status: "info", detail: `evm_increaseTime on the ephemeral chain only: ${new Date(t0 * 1000).toISOString()} → ${new Date(t1 * 1000).toISOString()}. The shared chain's clock was read, not moved: ${shared0.chainSeconds} → ${shared1.chainSeconds} (wall ${shared1.wallTime}).`, data: { ephemeralBefore: t0, ephemeralAfter: t1, movedSeconds: t1 - t0, sharedChainBefore: shared0, sharedChainAfter: shared1 } });
    const bal = (w: `0x${string}`) => pub.readContract({ address: a.usd, abi: A.TestUSDAbi, functionName: "balanceOf", args: [w] }) as Promise<bigint>;
    const cb0 = await bal(K.CLOUDCO.address);
    const tx = await send("settle", K.LP1, fn(A.QEDVaultAbi, "settle", [id]));
    const cb1 = await bal(K.CLOUDCO.address);
    const ok = cb1 - cb0 === amount;
    ctx.push({ key: "settle", label: "Settled after the due date", status: ok ? "ok" : "refused", detail: ok ? `${fmt(amount)} tUSD reached CloudCo in block ${tx.blockNumber}; a third party sent it, as the contract allows.` : "The creditor's balance does not match the liability.", data: { ...rail.txData(tx), creditorBefore: cb0.toString(), creditorAfter: cb1.toString() } });
    const summary = ok ? `Liability #${id} of ${fmt(amount)} tUSD was refused as NotDueYet, then settled to CloudCo after the run's own chain moved forward ${p.dueInDays} day${p.dueInDays === 1 ? "" : "s"}.` : "The settlement did not reconcile.";
    return { outcome: ok ? "executed" : "error", summary, tx: rail.txBrief(tx), evidence: { liabilityId: id.toString(), amount: amount.toString(), dueAt: dueAt.toString(), notDueYet: early.error?.name ?? null, ephemeralClock: { before: t0, after: t1, movedSeconds: t1 - t0 }, sharedChainClock: { before: shared0.chainSeconds, after: shared1.chainSeconds }, creditorReceived: (cb1 - cb0).toString(), network: seeded.network } };
  }

  // ───────────── historical evidence (read-only; every row labelled) ─────────────
  let cache: HistoricalEvidence | null = null;
  const evidence = (): HistoricalEvidence => (cache ??= historicalEvidence(rail.cfg.vendorRoot));
  return { list, evidence, zkAvailable };
}
