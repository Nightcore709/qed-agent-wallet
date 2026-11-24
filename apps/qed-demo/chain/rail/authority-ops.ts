/**
 * The owner's side of the authority budget (R7 decision D7; rail/authority-ledger.ts): a grant, and the caps on earned
 * authority.
 *
 *   grant   the owner adds to the agent's authority budget: a passkey signature (ERC-1271, through the owner account)
 *           over authorityGrantMessage, verified and kept by the co-signer. It moves no money and no transaction is
 *           sent. The budget reports it as granted, never as earned (spec section 2.3, "Owner grant (signed, by
 *           passkey)"). A retried job registers the same signed message again, which adds nothing.
 *
 *   earned-caps  (D-K1b, R13) the owner signs the two caps K1 puts on earned authority (rail/earned-authority.ts): how much
 *           counts as earned in any window of the operator's length, and how much from any one payer. Signed by passkey
 *           over earnedCapsMessage, as a grant; verified and kept by the co-signer. The operator's caps
 *           (QED_RAIL_EARNED_*) stay the ceiling: more than them is refused. A cap lower than the one in force applies at
 *           once; a higher one is a loosening and waits the owner account's protection delay (accountDelaySeconds, 72
 *           hours by default) before it counts, as the household's loosenings do (server/loosening.ts). It moves no money.
 *
 * Only where C12 is the authority budget: the baseline-parity workspace keeps the release's rule and refuses both.
 */
import type { OpResult, ProposalKind } from "../types.ts";
import { CHAIN_ID } from "./config.ts";
import { authorityGrantMessage, earnedCapsMessage, type CapName } from "./cosigner.ts";
import { RailError, type RailService } from "./service.ts";

export function installAuthority(rail: RailService) {
  const S = () => rail.asset.symbol;
  rail.proposers.set("grant", async (p) => {
    if (rail.authorityRule !== "d7") throw new RailError("authority_release_rule", "This workspace's co-signer applies the release's earned-allowance rule (C12), which has no owner grants. Nothing was prepared.", 409);
    if (Object.keys(p).some((k) => k !== "amount")) throw new RailError("invalid_params", "grant takes { amount } and nothing else.", 422);
    const amount = rail.raw(p.amount, "Grant amount");
    if (amount <= 0n) throw new RailError("invalid_amount", "A grant is a positive amount.", 422);
    const nonce = rail.nextNonce();
    const message = authorityGrantMessage(rail.a.vault, amount, nonce);
    const terms = {
      kind: "grant", chainId: CHAIN_ID, genesisId: rail.genesisId, vault: rail.a.vault, amount: rail.fmt(amount).replace(/,/g, ""), amountRaw: amount.toString(), nonce, message,
      effect: `Adds ${rail.fmt(amount)} ${S()} to the agent's authority budget (co-signer check C12, R7 decision D7), as granted and not earned. It moves no money and sends no transaction; the agent can then pay out, or spend on conversion costs, up to that much more, always within the mandate's own limits.`,
    };
    return { terms, summary: `Grant the agent ${rail.fmt(amount)} ${S()} more authority (granted, not earned). No money moves.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("grant", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const { signature } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
    ctx.push({ key: "owner", label: "Owner signs the grant", status: "ok", detail: rail.owner.kind === "passkey-account" ? `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The owner's passkey signed the grant's text for the owner account (ERC-1271 over the EIP-191 text, nonce ${t.nonce}), accepted by the account on chain.` : `Approval ${ctx.approval!.approvalId} binds these exact terms; the rail's development owner key signed the grant's text.`, data: { termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });
    const out = await rail.cosigner.registerGrant(t.message, signature);
    rail.store.appendDecision({ at: rail.iso(), kind: "owner-grant", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await rail.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { nonce: t.nonce, amount: t.amountRaw, message: t.message, grantedByOwner: out.granted, duplicate: out.duplicate } });
    ctx.push({ key: "cosigner", label: "The co-signer keeps the grant", status: "ok", detail: `The co-signer verified the owner's signature as the vault verifies it and keeps the grant: owner grants now total ${rail.fmt(out.granted)} ${S()}, reported as granted, never as earned.`, data: out });
    const summary = `Owner granted the agent ${rail.fmt(t.amountRaw)} ${S()} more authority (granted, not earned); owner grants now total ${rail.fmt(out.granted)} ${S()}. No money moved.`;
    rail.record(ctx, { kind: "grant", title: summary, outcome: "executed" });
    return { outcome: "executed", summary, evidence: { nonce: t.nonce, amount: t.amountRaw, granted: out.granted } };
  });
  rail.rerunnable.add("grant");

  // ───────────── D-K1b: the owner's caps on earned authority ─────────────
  const capWords: Record<CapName, string> = { perWindow: "in any window", perPayer: "from any one payer in a window" };
  const when = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  rail.proposers.set("earned-caps", async (p) => {
    if (rail.authorityRule !== "d7") throw new RailError("authority_release_rule", "This workspace's co-signer applies the release's earned-allowance rule (C12), which has no caps on earned authority. Nothing was prepared.", 409);
    if (Object.keys(p).some((k) => k !== "perWindow" && k !== "perPayer") || p.perWindow === undefined || p.perPayer === undefined) throw new RailError("invalid_params", "earned-caps takes { perWindow, perPayer } and nothing else.", 422);
    const now = rail.now();
    const view = await rail.cosigner.earnedCaps(now);
    if (!view) throw new RailError("authority_release_rule", "This workspace has no authority budget, so there are no caps to set. Nothing was prepared.", 409);
    const asked = { perWindow: rail.raw(p.perWindow, "The window cap"), perPayer: rail.raw(p.perPayer, "The per-payer cap") };
    for (const cap of ["perWindow", "perPayer"] as CapName[]) {
      if (asked[cap] < 0n) throw new RailError("invalid_amount", "A cap is zero or more.", 422);
      if (asked[cap] > BigInt(view.ceiling[cap])) throw new RailError("above_ceiling", `The installation allows at most ${rail.fmt(view.ceiling[cap])} ${S()} ${capWords[cap]}; a cap you sign can keep or lower that, not raise it. Nothing was prepared.`, 422);
    }
    const days = view.ceiling.windowSeconds / 86_400, windowText = Number.isInteger(days) ? `${days} days` : `${view.ceiling.windowSeconds} seconds`;
    const delay = rail.cfg.accountDelaySeconds, delayText = delay % 3600 === 0 ? `${delay / 3600} hours` : `${delay} seconds`;
    // what each cap will do, read now; the co-signer decides again when it registers them, on its own state
    const change = (["perWindow", "perPayer"] as CapName[]).map((cap) => {
      const inForce = BigInt(view.inForce[cap]), want = asked[cap], waiting = view.pending.find((x) => x.cap === cap);
      const was = `${rail.fmt(inForce)} ${S()} ${capWords[cap]}`;
      if (want < inForce) return { cap, effect: "lower" as const, text: `${capWords[cap]}: ${rail.fmt(want)} ${S()}, down from ${was}; applies at once${waiting ? ", and the raise waiting for this cap is dropped" : ""}.` };
      if (want === inForce) return { cap, effect: "keep" as const, text: `${capWords[cap]}: ${rail.fmt(want)} ${S()}, as now${waiting ? "; the raise waiting for this cap is dropped" : ""}.` };
      return { cap, effect: "raise" as const, text: `${capWords[cap]}: ${rail.fmt(want)} ${S()}, up from ${was}. A raise loosens a protection, so it waits ${delayText} (until about ${when(now + delay * 1000)}) before it counts; signing a lower cap before then stops it.` };
    });
    const nonce = rail.nextNonce();
    const message = earnedCapsMessage(rail.a.vault, view.ceiling.windowSeconds, asked.perWindow, asked.perPayer, nonce);
    const terms = {
      kind: "earned-caps", chainId: CHAIN_ID, genesisId: rail.genesisId, vault: rail.a.vault, windowSeconds: view.ceiling.windowSeconds,
      perWindow: rail.fmt(asked.perWindow).replace(/,/g, ""), perWindowRaw: asked.perWindow.toString(), perPayer: rail.fmt(asked.perPayer).replace(/,/g, ""), perPayerRaw: asked.perPayer.toString(),
      ceiling: { perWindow: view.ceiling.perWindow, perPayer: view.ceiling.perPayer }, delaySeconds: delay, nonce, message, changes: change,
      effect: `Earned authority (half of what clients outside your workspace pay, once final) counts at most ${rail.fmt(asked.perWindow)} ${S()} in any ${windowText} and at most ${rail.fmt(asked.perPayer)} ${S()} from any one payer in that time. ${change.map((c) => c.text).join(" ")} The installation's own caps (${rail.fmt(view.ceiling.perWindow)} and ${rail.fmt(view.ceiling.perPayer)} ${S()}) stay the most there can be. It moves no money and sends no transaction.`,
    };
    const raises = change.filter((c) => c.effect === "raise").length, lowers = change.filter((c) => c.effect === "lower").length;
    const summary = `Set the caps on earned authority to ${rail.fmt(asked.perWindow)} ${S()} in any ${windowText} and ${rail.fmt(asked.perPayer)} ${S()} from any one payer${raises ? `; ${raises === 2 ? "both raises wait" : "the raise waits"} ${delayText}` : ""}${lowers ? `; ${lowers === 2 ? "both lower at once" : "the lower one applies at once"}` : ""}. No money moves.`;
    return { terms, summary, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("earned-caps", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const { signature } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
    ctx.push({ key: "owner", label: "Owner signs the caps", status: "ok", detail: rail.owner.kind === "passkey-account" ? `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The owner's passkey signed the caps' text for the owner account (ERC-1271 over the EIP-191 text, nonce ${t.nonce}), accepted by the account on chain.` : `Approval ${ctx.approval!.approvalId} binds these exact terms; the rail's development owner key signed the caps' text.`, data: { termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });
    const out = await rail.cosigner.registerCaps(t.message, signature, { nowMs: rail.now(), delaySeconds: Number(t.delaySeconds) });
    rail.store.appendDecision({ at: rail.iso(), kind: "owner-earned-caps", jobId: ctx.jobId, verdict: "SIGNED", clock: ctx.clock ?? (await rail.clock()), approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { nonce: t.nonce, message: t.message, asked: { perWindow: t.perWindowRaw, perPayer: t.perPayerRaw }, outcome: out.outcome, inForce: out.inForce, pending: out.pending, duplicate: out.duplicate } });
    const said = (["perWindow", "perPayer"] as CapName[]).map((cap) => {
      const o = out.outcome[cap], p = out.pending.find((x) => x.cap === cap);
      return o === "raise-waits" && p ? `${capWords[cap]}: ${rail.fmt(p.value)} ${S()} from ${when(p.from)}; ${rail.fmt(out.inForce[cap])} ${S()} until then` : `${capWords[cap]}: ${rail.fmt(out.inForce[cap])} ${S()}${o === "lowered" ? ", lowered at once" : ""}`;
    });
    ctx.push({ key: "cosigner", label: "The co-signer keeps the caps", status: "ok", detail: `The co-signer verified the owner's signature as the vault verifies it and keeps the caps. Earned authority now counts at most ${said.join("; ")}. The installation's caps stay the ceiling.`, data: { ...out } as Record<string, unknown> });
    const waits = out.pending.length > 0;
    const summary = `Owner set the caps on earned authority: ${said.join("; ")}. No money moved.`;
    rail.record(ctx, { kind: "earned-caps", title: summary, outcome: waits ? "scheduled" : "executed" });
    return { outcome: waits ? "scheduled" : "executed", summary, evidence: { nonce: t.nonce, outcome: out.outcome, inForce: out.inForce, pending: out.pending, ceiling: out.ceiling } };
  });
  rail.rerunnable.add("earned-caps");
}
