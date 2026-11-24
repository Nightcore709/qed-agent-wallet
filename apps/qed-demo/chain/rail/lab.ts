/**
 * The Security Lab and the scenarios' chains (R7 D4: nothing on the shared chain is ever attacked, time-shifted or
 * reset).
 *
 * Every Security Lab run happens on an ephemeral Anvil of its own (RailHost.ephemeral): a port the operating system
 * hands out, a throwaway folder, no saved state, destroyed when the run ends. It is seeded with what the attack
 * needs: the release's sandbox deployment (its five pools, both vaults, the execution module), deployed with RANDOM
 * throwaway keys so that no address or signature of it is valid on the shared chain; an owner of its own that
 * provisions it and signs the release sandbox's first mandate; and a co-signer of its own (the release's unmodified
 * PolicyEngine, in memory, random key). The workspace's vault, keys and owner are not involved, and no approval of the
 * workspace's owner is spent: the approval binds the run's terms, nothing more.
 *
 * What stays: the job's steps, the transactions' receipts (labelled with the ephemeral chain they were mined on),
 * the co-signer's decision record and a history line, all in the workspace that ran it.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAddress, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalTerms, checkApproval } from "../terms.ts";
import type { AttackInfo, OpResult, ProposalKind, StepStatus } from "../types.ts";
import { reading } from "./clock.ts";
import { CHAIN_ID } from "./config.ts";
import { CosignerCore, ScopeStateFile } from "./cosigner.ts";
import { deployReleaseSandbox, type Addresses, type SandboxKeys } from "./deploy.ts";
import { RailError } from "./errors.ts";
import type { EphemeralChain } from "./host.ts";
import { ATTACKS, ATTACK_KINDS, type Ctx, type RailService } from "./service.ts";

const ser = <T = any>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const throwaway = (): LocalAccount => privateKeyToAccount(`0x${randomBytes(32).toString("hex")}` as Hex);

export interface SeededRelease {
  e: EphemeralChain;
  a: Addresses;
  K: SandboxKeys & { OWNER: LocalAccount; CLOUDCO: LocalAccount };
  cosigner: CosignerCore;
  cosignerKey: LocalAccount;
  mandate: any;
  ownerSig: Hex;
  network: string;
}

/** A label for everything recorded from one ephemeral chain: it existed for one job, and is gone. */
export const ephemeralNetwork = (jobId: string, port: number) => `Ephemeral Anvil chain 31337 of job ${jobId} (127.0.0.1:${port}; destroyed after the run) · valueless test tokens · throwaway keys`;

/**
 * The release's sandbox on an ephemeral chain, provisioned and under a signed mandate, with random keys throughout.
 * The mandate is the release sandbox's first: ≤ 25 tUSD per payment, 100 a day, 200 in total, valid 7 days.
 */
export async function seedRelease(rail: RailService, e: EphemeralChain, jobId: string): Promise<SeededRelease> {
  const v = rail.v, A = v.abi, c = e.c, fn = v.chain.fn;
  const rpc = (method: string, params: unknown[] = []) => e.anvil.rpc(method, params);
  const K = { DEPLOYER: throwaway(), OWNER: throwaway(), OPERATOR: throwaway(), GUARDIAN: throwaway(), LP1: throwaway(), LP2: throwaway(), LP3: throwaway(), MALLORY: throwaway(), CLOUDCO: throwaway() };
  const cosignerKey = throwaway();
  const a = await deployReleaseSandbox(c, v, rpc, K, K.OWNER.address, cosignerKey.address);
  await c.send(K.OWNER, a.vault, fn(A.QEDVaultAbi, "setAgent", [a.exec]));
  await c.send(K.OWNER, a.exec, fn(A.QEDExecutionAbi, "setVenues", [a.pools, v.scenario.EXEC_VENUES.map((x: any) => x.feeBps)]));
  const cosigner = new CosignerCore(v, () => cosignerKey, new ScopeStateFile(join(e.dir, "cosigner-state.json")), "ephemeral");
  cosigner.configure({ rpcUrl: e.url, chainId: CHAIN_ID, vault: a.vault, lens: a.lens, escrow: a.vault, owner: K.OWNER.address, denylist: [K.MALLORY.address], deployBlock: a.deployBlock, recordsDir: join(e.dir, "records"), engine: "release" });
  const s = (await c.pub.readContract({ address: a.lens, abi: A.QEDLensAbi, functionName: "snapshot", args: [a.vault] })) as any;
  const now = BigInt((await c.pub.getBlock()).timestamp);
  const mandate = { vault: a.vault, agent: a.exec, payees: [a.exec, a.reserve, K.CLOUDCO.address], maxPerPayment: 25_000_000n, maxPerPeriod: 100_000_000n, period: 86_400n, maxTotal: 200_000_000n, validFrom: now - 60n, validUntil: now + 7n * 86_400n, epoch: BigInt(s.epoch), requireCosign: true, purpose: keccak256(toHex("Security Lab: the genuine order an attack starts from")), salt: keccak256(toHex(`qed-lab-${jobId}`)) };
  const ownerSig = (await v.eip712.signMandate(K.OWNER, CHAIN_ID, mandate as never)) as Hex;
  return { e, a, K, cosigner, cosignerKey, mandate, ownerSig, network: ephemeralNetwork(jobId, e.port) };
}

/** Sends one transaction on the ephemeral chain, journaled in the workspace like every transaction, its receipt labelled. */
async function sendOn(rail: RailService, ctx: Ctx, seeded: SeededRelease, purpose: string, account: LocalAccount, to: Address, data: Hex, opts: { intentId?: Hex; expectRevertGas?: bigint } = {}) {
  const c = seeded.e.c;
  const fromBlock = (await c.pub.getBlockNumber()).toString();
  const attempt = rail.store.insertAttempt({ jobId: ctx.jobId, purpose: `ephemeral:${purpose}`, intentId: opts.intentId ?? null, sender: account.address, target: to, dataHash: keccak256(data), fromBlock, at: rail.iso(), network: seeded.network });
  try {
    const tx = opts.expectRevertGas ? await c.sendExpectingRevert(account, to, data, opts.expectRevertGas) : await c.send(account, to, data);
    rail.store.updateAttempt(attempt, { status: tx.status === "success" ? "mined-success" : "mined-revert", txHash: tx.hash, blockNumber: tx.blockNumber.toString(), errorName: tx.error?.name ?? null, at: rail.iso() });
    rail.saveReceipt(ctx.jobId, tx, seeded.network);
    return tx;
  } catch (e) {
    rail.store.updateAttempt(attempt, { status: "failed", errorName: String((e as Error).message ?? e).slice(0, 120), at: rail.iso() });
    throw e;
  }
}

/** The figures of the workspace's own vaults that an ephemeral run must leave exactly as they were. */
export async function workspaceFigures(rail: RailService) {
  const s = await rail.state();
  return [s.treasury.balance, s.treasury.spentInWindow, s.reserve.balance, s.mandate?.usage.lifetime.spent ?? "0"];
}

export function installLab(rail: RailService) {
  rail.proposers.set("attack", async (p) => {
    const kind = p.kind as AttackInfo["kind"];
    if (Object.keys(p).length !== 1 || !ATTACK_KINDS.includes(kind)) throw new RailError("unknown_attack", "Unknown attack.", 422);
    const terms = {
      kind: "attack", chainId: CHAIN_ID, genesisId: rail.genesisId, attack: kind, ...ATTACKS[kind],
      genuineOrder: { amount: "10", amountIn: "10000000", tokenIn: "tUSD", tokenOut: "tEUR", mandate: "the release sandbox's first mandate: ≤ 25 tUSD per payment, 100 a day, 200 in total, co-signature required" },
      isolation: "Runs on an ephemeral Anvil chain of its own, seeded with the release's contracts and throwaway keys (its own owner, agent and co-signer), and destroyed afterwards. This workspace's vault, keys and owner, and the shared chain, are not involved.",
    };
    return { terms, summary: `Security Lab · ${ATTACKS[kind].title}. On an ephemeral chain of its own: a genuine order for 10 tUSD that its own owner signs and its own co-signer certifies, then the altered transaction, which must revert with ${ATTACKS[kind].expect}.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });

  rail.handlers.set("attack", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, kind = t.attack as AttackInfo["kind"], AT = ATTACKS[kind], v = rail.v, T = v.trader, X = v.execution;
    checkApproval(ctx.approval, t, ctx.window);
    const before = await workspaceFigures(rail);
    let out: OpResult | null = null;
    await rail.host.ephemeral(ctx.jobId, async (e) => {
      const seeded = await seedRelease(rail, e, ctx.jobId);
      const { a, K } = seeded, c = e.c, pub = c.pub, fmt = (x: bigint) => v.amounts.formatMicro(x);
      const { usd, eur, eth, reserve, exec, vault } = a;
      ctx.clock = reading(Number((await pub.getBlock()).timestamp), rail.now(), rail.cfg.maxClockLeadSeconds);
      ctx.push({ key: "chain", label: "Ephemeral chain started and seeded", status: "info", detail: `A new Anvil on 127.0.0.1:${e.port}, only for this run: the release's sandbox deployed with throwaway keys (vault ${vault.slice(0, 10)}…), provisioned by its own owner, under the release sandbox's first mandate, with a co-signer of its own. Nothing here is valid on the shared chain, and the chain is destroyed when the run ends.`, data: { port: e.port, network: seeded.network, vault, execution: exec, cosigner: seeded.cosignerKey.address } });
      const amountIn = 10_000_000n, nonce = `lab-${ctx.jobId}`;
      const instructionSig = (await K.OWNER.signMessage({ message: v.cosigner.ownerTradeMessage(vault, amountIn, usd, eur, reserve, nonce) })) as Hex;
      const r = await seeded.cosigner.evaluateTrade({ mandate: seeded.mandate, ownerSig: seeded.ownerSig, module: exec, tokenIn: usd, tokenOut: eur, recipient: reserve, amountIn, instruction: `Security lab: genuine order for ${fmt(amountIn)} tUSD`, nonce, instructionSig, brainEngine: "security lab" });
      rail.keepDecision(ctx, "cosigner-trade", r);
      if (!r.approved) throw new RailError("cosigner_refused", `The ephemeral co-signer refused the genuine order: ${r.reasons.join("; ")}`, 409);
      ctx.push({ key: "cosigner", label: "Genuine co-signed order", status: "ok", detail: `The run's own owner signed ${fmt(amountIn)} tUSD → tEUR; its own co-signer signed an order with floor ${fmt(r.order!.minOut)} tEUR. The attacker now holds a real certificate, valid on this ephemeral chain only.`, data: ser({ floor: r.order!.minOut, orderHash: T.hashOrder(r.order!), evidenceHash: r.evidenceHash }) });
      const tp = await T.planTrade(pub, exec, usd, eur, amountIn);
      const vs = tp.venues;
      let route: any[] = tp.plan.route, prices: Map<string, bigint> = tp.plan.prices, order: any = r.order!, who: LocalAccount = K.OPERATOR;
      if (kind === "inferior-route") route = X.optimalDirectOnly(vs, usd, eur, amountIn)!.route;
      if (kind === "single-pool") route = X.bestSingleVenue(vs, usd, eur, amountIn)!;
      if (kind === "skim") {
        route = tp.plan.route.map((h: any) => ({ ...h }));
        const src = route.filter((h) => h.amountIn > 0n && (h.zeroForOne ? vs[h.venue].token0 : vs[h.venue].token1) === usd).sort((x, y) => (x.amountIn > y.amountIn ? -1 : 1));
        if (src.length >= 2) { const shift = src[0].amountIn / 20n; src[0].amountIn -= shift; src[1].amountIn += shift; }
      }
      if (kind === "forged-proof") {
        route = X.optimalDirectOnly(vs, usd, eur, amountIn)!.route;
        const directProof = X.solve(vs.filter((x: any) => x.token0 !== eth && x.token1 !== eth), usd, eur, amountIn).prices;
        prices = new Map(tp.plan.prices);
        prices.set(usd.toLowerCase(), directProof.get(usd.toLowerCase())!);
        prices.set(eth.toLowerCase(), (tp.plan.prices.get(eth.toLowerCase())! * 9n) / 10n);
      }
      if (kind === "redirect") order = { ...r.order!, recipient: K.MALLORY.address };
      if (kind === "stolen-order") who = K.MALLORY;
      const sim = X.simulate(vs, route, usd, eur, amountIn).amountOut as bigint;
      const honest = tp.plan.sim.amountOut as bigint;
      ctx.push({ key: "attack", label: "Malicious transaction built", status: "info", detail: `${AT.title}. ${["inferior-route", "skim", "forged-proof", "single-pool"].includes(kind) ? `It would deliver ${fmt(sim)} tEUR instead of ${fmt(honest)} (−${((Number(honest - sim) / Number(honest)) * 1e4).toFixed(2)} bps), above the 1% floor a slippage-only wallet would accept.` : ""} Sent with a fixed gas limit so it is mined, not just simulated.`, data: ser({ simulatedOut: sim, honestOut: honest, floor: r.order!.minOut }) });
      const bal = (token: Address, w: Address) => pub.readContract({ address: token, abi: v.abi.TestUSDAbi, functionName: "balanceOf", args: [w] }) as Promise<bigint>;
      const balances = async () => ser({ treasuryUsd: await bal(usd, vault), reserveEur: await bal(eur, reserve), moduleUsd: await bal(usd, exec), moduleEur: await bal(eur, exec), attackerUsd: await bal(usd, K.MALLORY.address), attackerEur: await bal(eur, K.MALLORY.address), spentInWindow: ((await pub.readContract({ address: a.lens, abi: v.abi.QEDLensAbi, functionName: "snapshot", args: [vault] })) as any).spentInWindow });
      const b0 = await balances();
      const data = v.chain.fn(v.abi.QEDExecutionAbi, "trade", [seeded.mandate, seeded.ownerSig, r.certificate, r.signature, order, T.hopsForChain(route), T.pricesForChain(prices as never)]);
      const tx = await sendOn(rail, ctx, seeded, `attack:${kind}`, who, exec, data, { intentId: r.certificate!.intentId, expectRevertGas: 2_000_000n });
      const b1 = await balances();
      const unchanged = canonicalTerms(b0) === canonicalTerms(b1);
      const intentUsed = (await pub.readContract({ address: vault, abi: v.abi.QEDVaultAbi, functionName: "intentUsed", args: [r.certificate!.intentId] })) as boolean;
      const err = tx.error?.name ?? "reverted";
      ctx.push({ key: "receipt", label: `Mined and reverted: ${err}`, status: "reverted", detail: `Status reverted in block ${tx.blockNumber} of the ephemeral chain (${tx.gasUsed.toLocaleString("en-US")} gas paid by the attacker). Defence: ${AT.layer}. ${unchanged ? "Nothing moved: every balance and the spending window are unchanged." : "WARNING: a balance changed."}`, data: { ...rail.txData(tx), network: seeded.network, expected: AT.expect, matchesExpectation: err === AT.expect, balancesBefore: b0, balancesAfter: b1, balancesUnchanged: unchanged, certificateConsumed: intentUsed } });
      const summary = `${AT.title} → reverted on-chain with ${err} (on an ephemeral chain of its own).`;
      const evidence = { attack: kind, expected: AT.expect, error: err, matchesExpectation: err === AT.expect, balancesUnchanged: unchanged, certificateConsumed: intentUsed, balances: b1, chain: "ephemeral", network: seeded.network };
      rail.record(ctx, { kind: "attack", title: summary, outcome: unchanged ? "reverted" : "error", tx: rail.txBrief(tx) });
      out = unchanged ? { outcome: "reverted", summary, tx: rail.txBrief(tx), evidence } : { outcome: "error", summary: `${summary} A balance changed: inspect the receipt.`, tx: rail.txBrief(tx), doNotRetry: true, evidence };
    });
    const after = await workspaceFigures(rail);
    const workspaceUnchanged = JSON.stringify(before) === JSON.stringify(after);
    ctx.push({ key: "teardown", label: "Ephemeral chain destroyed", status: workspaceUnchanged ? "info" : "refused", detail: workspaceUnchanged ? "The run's chain is stopped and its folder deleted. This workspace's vaults are exactly as they were." : "WARNING: this workspace's vault figures changed during an ephemeral run.", data: { before, after, workspaceUnchanged } });
    const res = out! as OpResult;
    res.evidence = { ...(res.evidence ?? {}), workspaceUnchanged };
    if (!workspaceUnchanged) return { ...res, outcome: "error", doNotRetry: true };
    return res;
  });
}

export type StepEmit = (s: { key: string; label: string; status: StepStatus; detail: string; data?: Record<string, unknown> }) => void;
