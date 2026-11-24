/**
 * Incident response as callable operations (baseline M-03, WF-16): pause, guardian pause, resume, revoke one
 * mandate, void all, and key rotation. The contracts always supported them; the release's app exposed none
 * (baseline W-03). Each is a proposal the owner (or, for one of them, the guardian) approves; the transaction sent is
 * the action written in the approved terms.
 *
 * Effect on queued work: a paused vault and a revoked or voided mandate fail the shared limits check, so an approved
 * but unsent conversion and every policy tick are refused before any signature (tested in test/admin.test.ts).
 * There is no delay on these changes; the baseline's proposal of time-locks for protection-reducing changes
 * (W-14) is not implemented here.
 */
import { getAddress, parseEther, toHex, type Address } from "viem";
import { checkApproval } from "../terms.ts";
import type { OpResult, ProposalKind } from "../types.ts";
import { CHAIN_ID } from "./config.ts";
import type { OwnerAction } from "./keys.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";

export function installAdmin(rail: RailService) {
  const vault = (fn: string, args: unknown[] = []): OwnerAction => ({ to: rail.a.vault, contract: "QEDVault (treasury)", function: fn, args });
  const reserve = (fn: string, args: unknown[] = []): OwnerAction => ({ to: rail.a.reserve, contract: `QEDVault (${rail.reserveName})`, function: fn, args });
  const base = (kind: ProposalKind) => ({ kind, chainId: CHAIN_ID, genesisId: rail.genesisId, vault: rail.a.vault });
  const none = (p: Record<string, unknown>, kind: string) => { if (Object.keys(p).length) throw new RailError("invalid_params", `${kind} takes no parameters.`, 422); };
  const done = (ctx: Ctx, kind: string, title: string, tx: any): OpResult => {
    rail.record(ctx, { kind, title, outcome: "executed", tx: tx ? rail.txBrief(tx) : undefined });
    return { outcome: "executed", summary: title, tx: tx ? rail.txBrief(tx) : undefined };
  };
  const paused = async () => (await rail.read(rail.a.vault, rail.v.abi.QEDVaultAbi, "paused")) as boolean;

  // ───────────── pause, guardian pause, resume ─────────────
  rail.proposers.set("pause", async (p) => { none(p, "pause"); return { terms: { ...base("pause"), actions: [vault("pause")], effect: "The agent can make no payment or conversion from the treasury until the owner resumes. Liabilities that fall due are still settled to their creditors." }, summary: "Pause the treasury vault: the agent stops at once; creditors are still paid.", allowed: true, checks: [], replaces: ["pause"] as ProposalKind[] }; });
  rail.handlers.set("pause", async (ctx) => {
    let tx: any = null;
    if (!(await paused())) { tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi); ctx.push({ key: "receipt", label: "QEDVault.pause mined", status: "ok", detail: `Paused by the owner in block ${tx.blockNumber}. Agent payments now revert with VaultPaused; only the owner can resume.`, data: rail.txData(tx) }); }
    else ctx.push({ key: "receipt", label: "Already paused", status: "info", detail: "Not sent again." });
    return done(ctx, "pause", "Owner paused the treasury vault: the agent is stopped; creditors are still paid", tx);
  });

  rail.proposers.set("guardian-pause", async (p) => { none(p, "guardian-pause"); return { terms: { ...base("guardian-pause"), guardian: rail.K.GUARDIAN.address, call: vault("pause"), effect: "The guardian can stop the agent. The guardian cannot resume it: only the owner can." }, summary: "Guardian pause: the guardian's key stops the agent. Only the owner can resume.", allowed: true, checks: [], replaces: ["guardian-pause"] as ProposalKind[] }; });
  rail.handlers.set("guardian-pause", async (ctx) => {
    const approval = checkApproval(ctx.approval, ctx.terms, ctx.window);
    let tx: any = null;
    if (!(await paused())) {
      tx = await rail.send(ctx, "guardian:QEDVault.pause", rail.K.GUARDIAN, rail.a.vault, rail.v.chain.fn(rail.v.abi.QEDVaultAbi, "pause"));
      ctx.push({ key: "receipt", label: "QEDVault.pause mined", status: "ok", detail: `Paused by the guardian key ${rail.K.GUARDIAN.address.slice(0, 10)}… in block ${tx.blockNumber}. The guardian cannot unpause (the contract answers NotOwner).`, data: rail.txData(tx) });
    } else ctx.push({ key: "receipt", label: "Already paused", status: "info", detail: "Not sent again." });
    rail.store.appendDecision({ at: rail.iso(), kind: "guardian-pause", jobId: ctx.jobId, verdict: "SENT", clock: ctx.clock ?? (await rail.clock()), approval, termsHash: ctx.proposal!.termsHash, record: { guardian: rail.K.GUARDIAN.address, tx: tx ? rail.txBrief(tx) : null } });
    return done(ctx, "pause", "Guardian paused the treasury vault: the agent is stopped; only the owner can resume", tx);
  });

  rail.proposers.set("resume", async (p) => { none(p, "resume"); return { terms: { ...base("resume"), actions: [vault("unpause")], effect: "The agent may act again within the signed mandate." }, summary: "Resume the treasury vault (owner only).", allowed: true, checks: [], replaces: ["resume"] as ProposalKind[] }; });
  rail.handlers.set("resume", async (ctx) => {
    let tx: any = null;
    if ((await paused()) && rail.scheduleOf(ctx.terms)) {
      // R13: the account's time-lock is on: resuming waits the account's delay; pausing again stays immediate
      tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi);
      const sch = await rail.recordScheduled(ctx, tx, { kind: "resume", summary: "Resume the treasury vault" });
      return rail.scheduledOutcome(ctx, tx, "Resuming the treasury vault is approved and time-locked; the agent stays stopped until it is applied.", sch);
    }
    if (await paused()) { tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi); ctx.push({ key: "receipt", label: "QEDVault.unpause mined", status: "ok", detail: `Resumed by the owner in block ${tx.blockNumber}.`, data: rail.txData(tx) }); }
    else ctx.push({ key: "receipt", label: "Not paused", status: "info", detail: "Nothing to resume; not sent." });
    return done(ctx, "pause", "Owner resumed the treasury vault", tx);
  });

  // ───────────── revoke one mandate, void all ─────────────
  rail.proposers.set("revoke-mandate", async (p) => {
    none(p, "revoke-mandate");
    const am = rail.activeMandate();
    if (!am) throw new RailError("no_mandate", "There is no active mandate to revoke.", 409);
    return { terms: { ...base("revoke-mandate"), version: am.version, mandateHash: am.hash, actions: [vault("revokeMandate", [am.hash])], effect: "The vault rejects this mandate from the next block. Nothing is signed in its place: the agent can do nothing until the owner signs a new mandate." }, summary: `Revoke mandate v${am.version} on-chain without signing a new one.`, allowed: true, checks: [], replaces: ["revoke-mandate", "mandate"] as ProposalKind[] };
  });
  rail.handlers.set("revoke-mandate", async (ctx) => {
    const t = ctx.terms;
    const [, , , revoked] = (await rail.read(rail.a.vault, rail.v.abi.QEDVaultAbi, "mandateState", [t.mandateHash])) as [bigint, bigint, bigint, boolean];
    let tx: any = null;
    if (!revoked) { tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi); ctx.push({ key: "receipt", label: "QEDVault.revokeMandate mined", status: "ok", detail: `Mandate v${t.version} revoked in block ${tx.blockNumber}; the vault now answers MandateIsRevoked.`, data: rail.txData(tx) }); }
    rail.store.endMandate(t.version, "revoked", rail.iso(), tx?.hash ?? null);
    return done(ctx, "mandate", `Owner revoked mandate v${t.version}; no mandate is active`, tx);
  });

  rail.proposers.set("void-all", async (p) => {
    none(p, "void-all");
    const epoch = BigInt((await rail.read(rail.a.vault, rail.v.abi.QEDVaultAbi, "epoch")) as bigint).toString();
    return { terms: { ...base("void-all"), currentEpoch: epoch, actions: [vault("bumpEpoch")], effect: "Every mandate and every co-signer certificate issued so far becomes void at once. A new mandate must be signed before the agent can act." }, summary: `Void all: bump the vault's epoch from ${epoch}; every outstanding mandate and certificate becomes void.`, allowed: true, checks: [], replaces: ["void-all", "mandate"] as ProposalKind[] };
  });
  rail.handlers.set("void-all", async (ctx) => {
    const t = ctx.terms;
    const epoch = BigInt((await rail.read(rail.a.vault, rail.v.abi.QEDVaultAbi, "epoch")) as bigint).toString();
    let tx: any = null;
    // bumpEpoch is not idempotent: send it only while the vault is still at the epoch the owner approved.
    if (epoch === t.currentEpoch) { tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi); ctx.push({ key: "receipt", label: "QEDVault.bumpEpoch mined", status: "ok", detail: `Epoch ${t.currentEpoch} → ${BigInt(t.currentEpoch) + 1n} in block ${tx.blockNumber}. Every earlier mandate and certificate is void (StaleEpoch).`, data: rail.txData(tx) }); }
    else ctx.push({ key: "receipt", label: "Epoch already bumped", status: "info", detail: "Not sent again." });
    rail.store.endAllMandates("voided", rail.iso(), tx?.hash ?? null);
    return done(ctx, "mandate", "Owner voided all authority: every mandate and certificate is void; no mandate is active", tx);
  });

  // ───────────── key rotation ─────────────
  rail.proposers.set("rotate-key", async (p) => {
    const role = p.role;
    if (Object.keys(p).length !== 1 || (role !== "operator" && role !== "guardian" && role !== "cosigner")) throw new RailError("invalid_params", "rotate-key takes { role }: \"operator\", \"guardian\" or \"cosigner\".", 422);
    const s = await rail.snap(rail.a.vault);
    let from: Address, to: Address, actions: OwnerAction[], version: number | null = null, note: string;
    if (role === "operator") {
      await rail.requireDirectPath();
      version = (rail.store.meta<number>("keyVersion:OPERATOR") ?? 1) + 1;
      from = rail.K.OPERATOR.address; to = rail.roleKey("OPERATOR", version).address;
      actions = [{ to: rail.a.exec, contract: "QEDExecution", function: "setOperator", args: [to] }, reserve("setAgent", [to])];
      note = "The old operator key can no longer trade (NotOperator).";
    } else if (role === "guardian") {
      version = (rail.store.meta<number>("keyVersion:GUARDIAN") ?? 1) + 1;
      from = getAddress(s.guardian); to = rail.roleKey("GUARDIAN", version).address;
      actions = [vault("setGuardian", [to]), reserve("setGuardian", [to])];
      note = "The old guardian key can no longer pause.";
    } else {
      from = getAddress(s.cosigner); to = await rail.cosigner.prepareRotation();
      actions = [vault("setCosigner", [to]), reserve("setCosigner", [to])];
      note = "Every certificate the old co-signer key signed becomes invalid (BadCosignerSignature).";
    }
    return { terms: { ...base("rotate-key"), role, from, to, keyVersion: version, actions, effect: note }, summary: `Rotate the ${role} key: ${from.slice(0, 10)}… → ${to.slice(0, 10)}…. ${note} ${rail.isBaseline ? "Development keys on the local chain." : "Keys derived from this installation's secret; none of them can act as the owner."}`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  /** What happens when a rotation takes effect: at once, or when its scheduled change is applied. */
  const commitRotation = async (role: string, to: string, keyVersion: number | null) => {
    if (role === "operator") { rail.store.setMeta("keyVersion:OPERATOR", keyVersion); rail.K.OPERATOR = rail.roleKey("OPERATOR", keyVersion!); }
    else if (role === "guardian") { rail.store.setMeta("keyVersion:GUARDIAN", keyVersion); rail.K.GUARDIAN = rail.roleKey("GUARDIAN", keyVersion!); }
    else {
      const now = await rail.cosigner.commitRotation(to as Address);
      if (getAddress(now) !== getAddress(to)) throw new RailError("rotation_mismatch", "The co-signer did not switch to the approved key.", 409);
    }
  };
  rail.applyHooks.set("resume", async () => "The treasury vault is resumed: the agent may act again within the signed mandate.");
  rail.applyHooks.set("rotate-key", async (_ctx, d) => { await commitRotation(d.role, d.to, d.keyVersion); return `The ${d.role} key is now ${String(d.to).slice(0, 10)}…; the old key no longer works.`; });
  rail.handlers.set("rotate-key", async (ctx) => {
    const t = ctx.terms, A = rail.v.abi;
    const acts = t.actions as OwnerAction[];
    if (t.role !== "cosigner") await rail.rpc("anvil_setBalance", [t.to, toHex(parseEther("10"))]);
    // A passkey account runs the operator and co-signer setters only after its delay (guarded calls): schedule them.
    if (rail.scheduleOf(t)) {
      const tx = await rail.ownerSend(ctx, 0, A.QEDVaultAbi);
      const sch = await rail.recordScheduled(ctx, tx, { kind: "rotate-key", summary: `Rotate the ${t.role} key to ${String(t.to).slice(0, 10)}…`, data: { role: t.role, to: t.to, keyVersion: t.keyVersion } });
      return rail.scheduledOutcome(ctx, tx, `The ${t.role} key rotation to ${String(t.to).slice(0, 10)}… is approved; the old key keeps working until it is applied.`, sch);
    }
    let last: any = null;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i], abi = a.contract === "QEDExecution" ? A.QEDExecutionAbi : A.QEDVaultAbi;
      const getter = a.function === "setOperator" ? "operator" : a.function === "setAgent" ? "agent" : a.function === "setGuardian" ? "guardian" : "cosigner";
      if (getAddress((await rail.read(a.to, abi, getter)) as Address) === getAddress(t.to)) { ctx.push({ key: "receipt", label: `${a.contract}.${a.function} already done`, status: "info", detail: "Not sent again." }); continue; }
      last = await rail.ownerSend(ctx, i, abi);
      ctx.push({ key: "receipt", label: `${a.contract}.${a.function} mined`, status: "ok", detail: `Owner transaction in block ${last.blockNumber}.`, data: rail.txData(last) });
    }
    await commitRotation(t.role, t.to, t.keyVersion);
    return done(ctx, "rotate-key", `Owner rotated the ${t.role} key to ${String(t.to).slice(0, 10)}…; the old key no longer works`, last);
  });
  for (const k of ["pause", "guardian-pause", "resume", "revoke-mandate", "void-all", "rotate-key"] as const) rail.rerunnable.add(k);
}
