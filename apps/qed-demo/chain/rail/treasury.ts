/**
 * Operations on the main treasury besides conversion (baseline F-021, F-022, F-026, F-030, F-041). The release's
 * contracts always supported them; its app exposed none of them on the live treasury (baseline section 0.1).
 * Five are proposals the owner approves, executed from the approved terms like every other action:
 *
 *   pay          an agent payment to the approved payee under the mandate and a co-signer certificate: the release's
 *                unmodified PolicyEngine.evaluate ("owner-instructed": C1, C2, C3, C6, C9 to C12), sent by the operator
 *                key through QEDExecution.pay, which forwards it to the vault unchanged. With `dueInDays` it is a
 *                forward payment: the vault ring-fences the amount for the payee now and pays it when due.
 *   ring-fence   the owner ring-fences free funds for the creditor (QEDVault.ringFence). Irrevocable by the owner.
 *   withdraw     the owner withdraws free funds to the owner's own account (QEDVault.withdraw).
 *   deposit      the owner deposits from the owner's own account (TestUSD.approve, then QEDVault.deposit).
 *   venues       the owner names a new venue set out of the five deployed pools (QEDExecution.setVenues). Every order
 *                signed for the previous set becomes void (VenueSetChanged).
 *
 * One needs no approval, because the contract lets anyone do it and the owner agreed to it when the liability was
 * created (baseline F-022: "it pays on the due date without a new approval"):
 *
 *   settle       pays a due liability to its creditor (QEDVault.settle), also while the vault is paused.
 *
 * Fixed lists, as everywhere on the rail: the payee book has one external payee (CloudCo, the mandate's third
 * payee); withdrawals go to the owner's own address; venues are chosen among the five deployed pools. No address,
 * calldata or contract is ever taken from a request.
 *
 * Two limits that show here, stated rather than worked around:
 *   - the co-signer's C12. In the baseline-parity workspace it is the release's earned autonomy: 10 tUSD plus half of
 *     the revenue that settled into the vault through an escrow, every PaymentExecuted counted as spend, conversions
 *     included, so payments stop once conversions and payments together reach 10 tUSD. In a workspace it is the
 *     authority budget of R7 decision D7 (rail/authority-ledger.ts): payments to others consume it, a conversion only
 *     its cost against the reference, earnings and owner grants add to it. The preview shows the co-signer's figure.
 *   - while the policy contract is QEDExecution's operator, `pay` cannot be reached (baseline W-12).
 *
 * After an interruption none of these is run again: the job is resolved by looking its journaled transaction up on
 * the restored chain (RailService.lookupSent).
 */
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import type { AuthorityView, LiabilityView, LimitCheck, OpResult, PaymentLimits, ProposalKind } from "../types.ts";
import { notMet } from "./words.ts";
import { CHAIN_ID } from "./config.ts";
import type { OwnerAction } from "./keys.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";

const ser = <T = any>(v: unknown): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
const DAY = 86_400n;
/** The release's C12 (vendor/agent/src/roles/cosigner.ts:188): 10 tUSD + 50% of verified escrow revenue. The rail's main treasury has no escrow, so revenue is 0. */

const LIABILITY_STATUS = ["none", "open", "settled", "released"] as const;

export function installTreasury(rail: RailService) {
  const fmt = (x: bigint | string) => rail.fmt(x);
  const S = () => rail.asset.symbol;
  /** The release's C12 base, 10 units of the vault's asset (10 tUSD in the baseline), as the co-signer counts it. */
  const earnedAllowance = () => 10n * 10n ** BigInt(rail.asset.decimals);
  /** Raw units as the plain decimal a request would carry ("20", "5.5", "0.000001"): the `amount` shown in the terms. */
  const human = (x: bigint) => { const d = rail.asset.decimals, s = x.toString().padStart(d + 1, "0"), frac = s.slice(-d).replace(/0+$/, ""); return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d); };
  const base = (kind: ProposalKind) => ({ kind, chainId: CHAIN_ID, genesisId: rail.genesisId, vault: rail.a.vault });
  const vaultAction = (fn: string, args: unknown[]): OwnerAction => ({ to: rail.a.vault, contract: "QEDVault (treasury)", function: fn, args });
  const only = (p: Record<string, unknown>, allowed: string[], kind: string) => { if (Object.keys(p).some((k) => !allowed.includes(k))) throw new RailError("invalid_params", `${kind} takes { ${allowed.join(", ")} } and nothing else.`, 422); };
  const days = (x: unknown, required: boolean): number => {
    if (x === undefined && !required) return 0;
    if (!Number.isInteger(x) || (x as number) < 1 || (x as number) > 365) throw new RailError("invalid_params", "dueInDays must be a whole number of days from 1 to 365 (the vault accepts due dates up to 365 days ahead).", 422);
    return x as number;
  };
  /** The owner's payee book for payments and ring-fenced funds: the mandate's one external payee. */
  const book = () => [{ label: "CloudCo", address: rail.K.CLOUDCO.address as Address }];
  const payee = (label: unknown) => {
    const hit = typeof label === "string" ? book().find((b) => b.label.toLowerCase() === label.trim().toLowerCase()) : undefined;
    if (!hit) throw new RailError("unknown_payee", `Payments and ring-fenced funds go to an approved payee from the owner's book, named by its label. This treasury's book has: ${book().map((b) => b.label).join(", ")}. No address is accepted.`, 422);
    return hit;
  };
  const labelOf = (a: Address) => book().find((b) => b.address === getAddress(a))?.label ?? null;
  /**
   * A ring-fence's creditor: an approved payee of the book, by its label, or (R13 S5) another workspace's owner account
   * on this installation, which can then release or assign the claim with its own passkeys (rail/ownership.ts). Agent
   * payments still go only to the book.
   */
  const creditorOf = (c: unknown) => {
    if (typeof c !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(c)) return payee(c);
    const w = rail.host.all().find((x) => x.id !== rail.id && x.a?.ownerAccount && getAddress(x.a.ownerAccount) === getAddress(c));
    if (!w) throw new RailError("unknown_creditor", "Money is set aside for an approved payee from the owner's book, named by its label, or for another workspace's owner account on this installation. That address is neither. Nothing was prepared.", 422);
    return { label: `QED account ${getAddress(c).slice(0, 10)}…`, address: getAddress(c) as Address };
  };
  const refuse = (ctx: Ctx, summary: string): OpResult => { rail.record(ctx, { kind: "refusal", title: summary, outcome: "refused" }); return { outcome: "refused", summary }; };
  const money = async (who: Address) => ({ vault: await rail.bal(rail.a.asset!, rail.a.vault), other: await rail.bal(rail.a.asset!, who), ringFenced: BigInt((await rail.snap(rail.a.vault)).protectedBalance) });
  const mismatch = (ctx: Ctx, kind: string, tx: any): OpResult => {
    const summary = `Transaction ${tx.hash} mined, but balance reconciliation failed. Do not retry; inspect the receipt.`;
    rail.record(ctx, { kind, title: summary, outcome: "error", tx: rail.txBrief(tx) });
    return { outcome: "error", summary, tx: rail.txBrief(tx), doNotRetry: true };
  };
  const ownerStep = (ctx: Ctx, what: string) => ctx.push({ key: "owner", label: "Owner approves the exact terms", status: "ok", detail: `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms: ${ctx.proposal!.termsHash}. ${rail.ownerWords(what)}`, data: { termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });
  const freeCheck = (amount: bigint, free: bigint): LimitCheck => ser({ id: "free-balance", rule: "Free treasury balance: ring-fenced money is untouchable, even by the owner", limit: free, used: null, remaining: free, pass: amount <= free });

  // ───────────── liabilities (read) ─────────────
  const ready = () => { if (rail.status !== "ready") throw new RailError(rail.status === "starting" ? "rail_starting" : "rail_unavailable", rail.status === "starting" ? "The local chain is still starting; try again in a few seconds." : `The local chain is unavailable: ${rail.error ?? rail.status}`, 503); };
  const liability = async (id: bigint): Promise<LiabilityView> => {
    ready();
    const l = (await rail.read(rail.a.vault, rail.v.abi.QEDVaultAbi, "getLiability", [id])) as { creditor: Address; amount: bigint; dueAt: bigint; status: number; createdBy: Address; memo: Hex };
    const status = LIABILITY_STATUS[Number(l.status)];
    if (!status || status === "none") throw new RailError("unknown_liability", `The treasury vault has no liability #${id}.`, 404);
    const by = getAddress(l.createdBy);
    return ser({ id: id.toString(), creditor: getAddress(l.creditor), creditorLabel: labelOf(l.creditor), amount: l.amount, dueAt: Number(l.dueAt), dueTime: new Date(Number(l.dueAt) * 1000).toISOString(), status, due: status === "open" && (await rail.chainNow()) >= l.dueAt, createdBy: by, createdByRole: by === getAddress(rail.owner.address) ? "owner" : by === rail.a.exec ? "agent" : "other", memo: l.memo });
  };
  const liabilities = async (): Promise<LiabilityView[]> => {
    ready();
    const n = Number((await rail.snap(rail.a.vault)).liabilityCount);
    const out: LiabilityView[] = [];
    for (let id = 1; id <= n; id++) out.push(await liability(BigInt(id)));
    return out;
  };

  // ───────────── pay: mandate, owner signature, co-signer certificate, QEDExecution.pay ─────────────
  /** What the vault has paid out under certificates so far: the release's C12 counts all of it, conversions included (baseline, or QED_RAIL_AUTHORITY=release). */
  const paidOut = async (): Promise<bigint> => {
    const logs = (await rail.pub.getContractEvents({ address: rail.a.vault, abi: rail.v.abi.QEDVaultAbi, eventName: "PaymentExecuted", fromBlock: BigInt(rail.a.deployBlock) })) as { args: { amount: bigint } }[];
    return logs.reduce((sum, e) => sum + BigInt(e.args.amount), 0n);
  };
  /**
   * The authority budget's check (R7 D7): the co-signer's own figures, read from it, so that the preview is the
   * computation the co-signer enforces. Every payment of the book goes to CloudCo, outside the workspace, so a payment
   * or a promise needs its whole amount available.
   */
  const authorityCheck = async (amount: bigint): Promise<{ check: LimitCheck; left: bigint; view: AuthorityView }> => {
    const view = (await rail.cosigner.authority()) as AuthorityView;
    if (view.rule !== "d7") throw new RailError("cosigner_rule_mismatch", "The co-signer does not apply the authority budget this workspace expects. Nothing was prepared.", 503);
    const available = BigInt(view.available), left = available > 0n ? available : 0n, limit = BigInt(view.granted) + BigInt(view.earned);
    const check: LimitCheck = ser({ id: "authority-budget", rule: `Authority budget (co-signer check C12, R7 decision D7): what leaves the workspace's control, at reference value, stays within what the owner granted and the workspace earned`, limit, used: limit - left, remaining: left, pass: amount <= left, detail: `${view.statement}. ${view.limits[0]}` });
    return { check, left, view };
  };
  /** The shared limits function plus the co-signer's C12, so that preview and enforcement agree. */
  const paymentChecks = async (amount: bigint): Promise<{ allowed: boolean; checks: LimitCheck[]; maximum: bigint; authority?: AuthorityView }> => {
    const lim = await rail.checkLimits(amount);
    const checks0 = lim.checks.map((c) => (c.id === "per-conversion" ? { ...c, rule: "Per-payment limit in the owner's signed mandate (the same limit as per conversion)" } : c));
    if (rail.authorityRule === "d7") {
      const a = await authorityCheck(amount), cap = BigInt(lim.maximum);
      return { allowed: lim.allowed && a.check.pass, checks: [...checks0, a.check], maximum: cap < a.left ? cap : a.left, authority: a.view };
    }
    const spent = await paidOut();
    const allowance = earnedAllowance(), left = allowance > spent ? allowance - spent : 0n;
    const autonomy: LimitCheck = ser({ id: "earned-autonomy", rule: `Earned autonomy (co-signer check C12): everything the vault has paid out, conversions included, plus this payment, stays within 10 ${S()} + 50% of verified escrow revenue`, limit: allowance, used: spent, remaining: left, pass: amount <= left, detail: rail.isBaseline ? "This treasury has no escrow, so its verified revenue is 0 and the allowance is 10 ${S()} in total." : `No escrow job has settled into this vault, so its verified revenue is 0 and the allowance is 10 ${S()} in total.` });
    const cap = BigInt(lim.maximum);
    return { allowed: lim.allowed && autonomy.pass, checks: [...checks0, autonomy], maximum: cap < left ? cap : left };
  };
  /**
   * The same checks for ?amount=, as a read: nothing is prepared, signed or sent, and no proposal is created.
   * `earned` is the co-signer's earned-autonomy figure on its own, and `maximum` the largest payment every rule
   * allows now, so that a screen can say both before anyone asks for terms. Without an amount it answers for the
   * smallest unit, which shows what is left.
   */
  const paymentLimits = async (amountText: string | null): Promise<PaymentLimits> => {
    ready();
    const amount = amountText === null || amountText.trim() === "" ? 1n : rail.raw(amountText, "Payment amount");
    const lim = await paymentChecks(amount);
    const e = lim.checks.find((c) => c.id === "earned-autonomy" || c.id === "authority-budget")!;
    return ser({ amount, allowed: lim.allowed, checks: lim.checks, maximum: lim.maximum, earned: { limit: e.limit, used: e.used, remaining: e.remaining }, mandate: rail.activeMandate() !== null, execution: "none", ...(lim.authority ? { authority: lim.authority } : {}) });
  };

  rail.proposers.set("pay", async (p) => {
    only(p, ["payee", "amount", "dueInDays"], "pay");
    const who = payee(p.payee), amount = rail.raw(p.amount, "Payment amount"), n = days(p.dueInDays, false);
    const am = rail.activeMandate();
    if (!am) throw new RailError("no_mandate", "No active mandate: the owner must sign one before a payment can be proposed.", 409);
    await rail.requireDirectPath();
    const lim = await paymentChecks(amount);
    const nonce = rail.nextNonce();
    const instruction = n ? `Promise ${who.label} ${human(amount)} ${S()}, due in ${n} day${n === 1 ? "" : "s"}` : `Pay ${who.label} ${human(amount)} ${S()}`;
    const terms = {
      ...base("pay"), token: rail.a.asset, payee: who.address, payeeLabel: who.label, amount: human(amount), amountRaw: amount.toString(), dueInDays: n, nonce, instruction,
      message: rail.v.cosigner.ownerInstructionMessage(rail.a.vault, who.address, amount, n || undefined, nonce),
      mandateVersion: am.version, mandateHash: am.hash, via: "QEDExecution.pay, which forwards to QEDVault.executePayment",
    };
    const summary = n
      ? `Forward payment: ring-fence ${fmt(amount)} ${S()} for ${who.label} now and pay it in ${n} day${n === 1 ? "" : "s"}, under mandate v${am.version} and a co-signer certificate. It counts against the caps now.`
      : `Pay ${fmt(amount)} ${S()} to ${who.label} from the treasury, under mandate v${am.version} and a co-signer certificate.`;
    return { terms, summary, allowed: lim.allowed, checks: lim.checks };
  });

  rail.handlers.set("pay", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, A = rail.v.abi;
    const amount = BigInt(t.amountRaw), n = Number(t.dueInDays), forward = n > 0, to = getAddress(t.payee);
    await rail.requireDirectPath();

    // 1 · signed limits, by the same function the preview used
    const am = rail.activeMandate();
    const lim = await paymentChecks(amount);
    const ok = lim.allowed && !!am && am.hash === t.mandateHash;
    ctx.push({ key: "mandate", label: "Signed mandate, vault limits and earned allowance", status: ok ? "ok" : "refused", detail: ok ? `Within the owner's mandate v${am!.version} (≤ ${fmt(am!.mandate.maxPerPayment)} ${S()} per payment, its period and lifetime totals), today's vault window, the free balance less the buffer, and the earned allowance.` : !lim.allowed ? lim.checks.filter((c) => !c.pass).map((c) => `${c.rule}${c.remaining !== null ? `: ${fmt(amount)} > ${fmt(c.remaining)} ${S()}` : c.detail ? `: ${c.detail}` : ""}`).join("; ") + ". The agent cannot raise a limit." : "The mandate changed after these terms were prepared. Prepare the payment again under the current mandate.", data: { checks: lim.checks } });
    // The summary names the kind of rule that stopped it: the co-signer's allowance is not one of the owner's signed limits.
    const broken = lim.checks.filter((c) => !c.pass).map((c) => c.id);
    const why = lim.allowed ? "was prepared under a mandate that has since changed" : broken.every((id) => id === "earned-autonomy") ? "is more than is left of the co-signer's earned allowance" : broken.every((id) => id === "authority-budget") ? "is more than is available of the agent's authority budget (co-signer check C12, R7 D7)" : "breaks the signed limits";
    if (!ok) return refuse(ctx, `Refused before signing: a payment of ${fmt(amount)} ${S()} to ${t.payeeLabel} ${why}. No transaction was sent.`);

    // 2 · the owner confirms this exact payment
    ctx.clock = await rail.align();
    const { signature: instructionSig } = await rail.owner.signMessage(t, ctx.approval, ctx.window);
    ctx.push({ key: "owner", label: "Owner confirms the exact payment", status: "ok", detail: rail.owner.kind === "passkey-account" ? `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The owner's passkey signed “${t.instruction}” for the owner account (ERC-1271 over the EIP-191 text, nonce ${t.nonce}), accepted by the account on chain.` : `Approval ${ctx.approval!.approvalId} (${ctx.approval!.method}) binds these exact terms. The rail's development owner key signs “${t.instruction}” (EIP-191, nonce ${t.nonce}).`, data: { signer: rail.owner.address, termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });

    // 3 · the co-signer re-derives every fact and signs a certificate for exactly this payee, amount and due date
    const r = await rail.cosigner.evaluatePayment({ kind: "owner-instructed", mandate: am!.mandate, ownerSig: am!.ownerSig, payee: to, amount, dueInDays: n || undefined, instruction: t.instruction, nonce: t.nonce, instructionSig });
    rail.keepDecision(ctx, "cosigner-payment", r);
    ctx.push({ key: "cosigner", label: "Independent co-signer checks and signs", status: r.approved ? "ok" : "refused", detail: r.approved ? `${r.checks.length} checks passed. Its certificate binds the payee, ${fmt(amount)} ${S()}, ${forward ? `the due date ${new Date(Number(r.certificate.dueAt) * 1000).toISOString()}` : "payment now"}, a single-use intent and the hash of its decision record.` : `Refused: ${notMet(r.reasons)}`, data: ser({ checks: r.checks, reasons: r.reasons, evidenceHash: r.evidenceHash, dueAt: r.certificate?.dueAt ?? null, isolation: rail.cosigner.isolation }) });
    if (!r.approved) return refuse(ctx, `The co-signer refused: ${notMet(r.reasons)}. No transaction was sent.`);

    // 4 · submit → receipt
    const before = await money(to);
    const submitSeq = ctx.push({ key: "submit", label: "Preflight and broadcast", status: "pending", detail: "Checking gas estimation before any transaction is broadcast. No hash exists yet." });
    const data = rail.v.chain.fn(A.QEDExecutionAbi, "pay", [am!.mandate, am!.ownerSig, r.certificate, r.signature]);
    const tx = await rail.send(ctx, "pay", rail.K.OPERATOR, rail.a.exec, data, { intentId: r.certificate.intentId, onBroadcast: (hash) => ctx.replace(submitSeq, { key: "submit", label: "Transaction broadcast", status: "ok", detail: `Broadcast acknowledged. Transaction ${hash}; awaiting mined receipt.`, data: { hash } }) });
    const liabilityId = BigInt((tx.events.find((e: any) => e.name === "PaymentExecuted")!.args as any).liabilityId);
    ctx.push({ key: "receipt", label: forward ? `Mined: liability #${liabilityId} created` : "Mined: the vault paid", status: "ok", detail: `Status success in block ${tx.blockNumber}, ${tx.gasUsed.toLocaleString("en-US")} gas. The vault checked the mandate, the certificate, the caps and solvency, then ${forward ? `ring-fenced ${fmt(amount)} ${S()} for ${t.payeeLabel}` : `transferred ${fmt(amount)} ${S()} to ${t.payeeLabel}`}.`, data: rail.txData(tx) });

    // 5 · reconcile
    const after = await money(to);
    const reconciled = forward
      ? after.vault === before.vault && after.other === before.other && after.ringFenced - before.ringFenced === amount && liabilityId > 0n
      : before.vault - after.vault === amount && after.other - before.other === amount && after.ringFenced === before.ringFenced && liabilityId === 0n;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: reconciled ? "ok" : "refused", detail: reconciled ? `Treasury ${fmt(before.vault)} → ${fmt(after.vault)} ${S()}; ${t.payeeLabel} ${fmt(before.other)} → ${fmt(after.other)} ${S()}; ring-fenced ${fmt(before.ringFenced)} → ${fmt(after.ringFenced)} ${S()}.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    const kind = forward ? "forward-payment" : "payment";
    if (!reconciled) return mismatch(ctx, kind, tx);
    const summary = forward
      ? `Promised ${fmt(amount)} ${S()} to ${t.payeeLabel}: ring-fenced as liability #${liabilityId}, due ${new Date(Number(r.certificate.dueAt) * 1000).toISOString()}. Free balance now ${fmt(after.vault - after.ringFenced)} ${S()}.`
      : `Paid ${fmt(amount)} ${S()} to ${t.payeeLabel}; treasury now ${fmt(after.vault)} ${S()}.`;
    rail.record(ctx, { kind, title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ payee: to, payeeLabel: t.payeeLabel, amount, dueInDays: n, dueAt: r.certificate.dueAt, liabilityId: forward ? liabilityId : null, cosignerChecks: r.checks.length, evidenceHash: r.evidenceHash }) };
  });
  rail.recoverers.set("pay", (job) => rail.lookupSent(job, "pay", "payment", "Payment"));

  // ───────────── ring-fence (owner) ─────────────
  rail.proposers.set("ring-fence", async (p) => {
    only(p, ["creditor", "amount", "dueInDays"], "ring-fence");
    const who = creditorOf(p.creditor), amount = rail.raw(p.amount, "Ring-fenced amount"), n = days(p.dueInDays, true);
    const free = BigInt((await rail.snap(rail.a.vault)).freeBalance);
    const dueAt = (await rail.chainNow()) + BigInt(n) * DAY;
    const memoText = `rail-ring-fence-${rail.genesisId}-${rail.store.next("ringFence")}`;
    const check = freeCheck(amount, free);
    const terms = {
      ...base("ring-fence"), creditor: who.address, creditorLabel: who.label, amount: human(amount), amountRaw: amount.toString(), dueInDays: n, dueAt: dueAt.toString(), memoText,
      actions: [vaultAction("ringFence", [who.address, amount.toString(), dueAt.toString(), keccak256(toHex(memoText))])],
      effect: "From the next block this amount can only ever reach the creditor: the agent cannot spend it and the owner cannot withdraw or release it. Anyone may settle it to the creditor once it is due, also while the vault is paused.",
    };
    return { terms, summary: `Ring-fence ${fmt(amount)} ${S()} of the treasury's free funds for ${who.label}, due ${new Date(Number(dueAt) * 1000).toISOString()} (in ${n} day${n === 1 ? "" : "s"}). Irrevocable by the owner.`, allowed: check.pass, checks: [check], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("ring-fence", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, amount = BigInt(t.amountRaw), to = getAddress(t.creditor);
    const free = BigInt((await rail.snap(rail.a.vault)).freeBalance);
    if (amount > free) return refuse(ctx, `Refused before sending: ${fmt(amount)} ${S()} cannot be ring-fenced, because only ${fmt(free)} ${S()} is free. The vault would answer SolvencyViolation. Nothing was sent.`);
    ownerStep(ctx, "QEDVault.ringFence");
    const before = await money(to);
    const tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi, (a) => [a[0], BigInt(a[1] as string), BigInt(a[2] as string), a[3]]);
    if (rail.scheduleOf(t)) {
      // R13: the account's time-lock is on: ringFence runs only after the account's delay (any member can cancel)
      const sch = await rail.recordScheduled(ctx, tx, { kind: "ring-fence", summary: `Ring-fence ${fmt(amount)} ${S()} for ${t.creditorLabel}`, data: { creditor: to, amount: amount.toString(), dueAt: t.dueAt } });
      return rail.scheduledOutcome(ctx, tx, `Ring-fencing ${fmt(amount)} ${S()} for ${t.creditorLabel} is approved and time-locked; nothing is set aside until it is applied.`, sch);
    }
    const id = BigInt((tx.events.find((e: any) => e.name === "LiabilityCreated")!.args as any).id);
    ctx.push({ key: "receipt", label: `QEDVault.ringFence mined: liability #${id}`, status: "ok", detail: `Owner transaction in block ${tx.blockNumber}. ${fmt(amount)} ${S()} is ring-fenced for ${t.creditorLabel} until ${new Date(Number(t.dueAt) * 1000).toISOString()}.`, data: rail.txData(tx) });
    const after = await money(to);
    const reconciled = after.vault === before.vault && after.other === before.other && after.ringFenced - before.ringFenced === amount;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: reconciled ? "ok" : "refused", detail: reconciled ? `Nothing left the vault. Ring-fenced ${fmt(before.ringFenced)} → ${fmt(after.ringFenced)} ${S()}; free ${fmt(before.vault - before.ringFenced)} → ${fmt(after.vault - after.ringFenced)} ${S()}.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    if (!reconciled) return mismatch(ctx, "ring-fence", tx);
    const summary = `Owner ring-fenced ${fmt(amount)} ${S()} for ${t.creditorLabel} as liability #${id}; free balance now ${fmt(after.vault - after.ringFenced)} ${S()}.`;
    rail.record(ctx, { kind: "ring-fence", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ liabilityId: id, creditor: to, amount, dueAt: t.dueAt }) };
  });
  rail.recoverers.set("ring-fence", (job) => rail.lookupSent(job, "owner:QEDVault (treasury).ringFence", "ring-fence", "Ring-fence"));

  // ───────────── settle (no approval: anyone may pay a due liability to its creditor) ─────────────
  const settleParams = (id: unknown): { id: string } => {
    if (typeof id !== "string" || !/^[1-9]\d{0,8}$/.test(id)) throw new RailError("invalid_params", "A liability is named by its number (1, 2, 3 …).", 422);
    return { id };
  };
  rail.handlers.set("settle", async (ctx): Promise<OpResult> => {
    const id = BigInt(settleParams(ctx.request?.id).id);
    const l = await liability(id);
    const amount = BigInt(l.amount), who = l.creditorLabel ?? l.creditor;
    const what = `Liability #${id} (${fmt(amount)} ${S()} for ${who})`;
    if (l.status !== "open") {
      ctx.push({ key: "liability", label: `Already ${l.status}`, status: "info", detail: `${what} is already ${l.status}. Nothing to do; nothing was sent.`, data: l as never });
      const summary = `${what} is already ${l.status}: nothing to do.`;
      rail.record(ctx, { kind: "settlement", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary };
    }
    if (!l.due) {
      ctx.push({ key: "liability", label: "Not due yet", status: "refused", detail: `${what} is due at ${l.dueTime}. Nothing was sent.`, data: l as never });
      return refuse(ctx, `${what} is not due until ${l.dueTime}; the vault would answer NotDueYet. Nothing was sent.`);
    }
    ctx.push({ key: "liability", label: "Open and due", status: "ok", detail: `${what} fell due at ${l.dueTime}. The contract lets anyone settle it, also while the vault is paused, and the money can only reach its creditor. No approval is needed: the owner agreed to it when the liability was created.`, data: l as never });
    const before = await money(l.creditor);
    const submitSeq = ctx.push({ key: "submit", label: "Preflight and broadcast", status: "pending", detail: "Checking gas estimation before any transaction is broadcast. No hash exists yet." });
    const tx = await rail.send(ctx, "settle", rail.K.OPERATOR, rail.a.vault, rail.v.chain.fn(rail.v.abi.QEDVaultAbi, "settle", [id]), { onBroadcast: (hash) => ctx.replace(submitSeq, { key: "submit", label: "Transaction broadcast", status: "ok", detail: `Broadcast acknowledged. Transaction ${hash}; awaiting mined receipt.`, data: { hash } }) });
    ctx.push({ key: "receipt", label: "QEDVault.settle mined", status: "ok", detail: `Status success in block ${tx.blockNumber}. ${fmt(amount)} ${S()} went to ${who}.`, data: rail.txData(tx) });
    const after = await money(l.creditor);
    const reconciled = before.vault - after.vault === amount && after.other - before.other === amount && before.ringFenced - after.ringFenced === amount;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: reconciled ? "ok" : "refused", detail: reconciled ? `Treasury ${fmt(before.vault)} → ${fmt(after.vault)} ${S()}; ${who} ${fmt(before.other)} → ${fmt(after.other)} ${S()}; ring-fenced ${fmt(before.ringFenced)} → ${fmt(after.ringFenced)} ${S()}.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    if (!reconciled) return mismatch(ctx, "settlement", tx);
    const summary = `Settled liability #${id}: ${fmt(amount)} ${S()} paid to ${who}; ring-fenced now ${fmt(after.ringFenced)} ${S()}.`;
    rail.record(ctx, { kind: "settlement", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ liabilityId: id, creditor: l.creditor, amount }) };
  });
  rail.recoverers.set("settle", (job) => rail.lookupSent(job, "settle", "settlement", "Settlement"));

  // ───────────── withdraw and deposit (owner) ─────────────
  rail.proposers.set("withdraw", async (p) => {
    only(p, ["amount"], "withdraw");
    const amount = rail.raw(p.amount, "Withdrawal amount"), to = getAddress(rail.owner.address);
    const check = freeCheck(amount, BigInt((await rail.snap(rail.a.vault)).freeBalance));
    const terms = { ...base("withdraw"), token: rail.a.asset, to, amount: human(amount), amountRaw: amount.toString(), actions: [vaultAction("withdraw", [to, amount.toString()])], effect: "Free funds leave the treasury vault for the owner's own account. Ring-fenced money cannot be withdrawn. The agent's limits follow the lower balance." };
    return { terms, summary: `Withdraw ${fmt(amount)} ${S()} of the treasury's free funds to the owner's own account ${to.slice(0, 10)}….`, allowed: check.pass, checks: [check], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("withdraw", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, amount = BigInt(t.amountRaw), to = getAddress(t.to);
    const free = BigInt((await rail.snap(rail.a.vault)).freeBalance);
    if (amount > free) return refuse(ctx, `Refused before sending: a withdrawal of ${fmt(amount)} ${S()} exceeds the free balance of ${fmt(free)} ${S()}. Ring-fenced money cannot be withdrawn, even by the owner; the vault would answer SolvencyViolation with both figures. Nothing was sent.`);
    ownerStep(ctx, "QEDVault.withdraw");
    const before = await money(to);
    const tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDVaultAbi, (a) => [a[0], BigInt(a[1] as string)]);
    if (rail.scheduleOf(t)) {
      // R13: the account's time-lock is on: the withdrawal runs only after the account's delay (any member can cancel)
      const sch = await rail.recordScheduled(ctx, tx, { kind: "withdraw", summary: `Withdraw ${fmt(amount)} ${S()} to the owner's own account`, data: { to, amount: amount.toString() } });
      return rail.scheduledOutcome(ctx, tx, `The withdrawal of ${fmt(amount)} ${S()} is approved and time-locked; nothing leaves the vault until it is applied.`, sch);
    }
    ctx.push({ key: "receipt", label: "QEDVault.withdraw mined", status: "ok", detail: `Owner transaction in block ${tx.blockNumber}.`, data: rail.txData(tx) });
    const after = await money(to);
    const reconciled = before.vault - after.vault === amount && after.other - before.other === amount && after.ringFenced === before.ringFenced;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: reconciled ? "ok" : "refused", detail: reconciled ? `Treasury ${fmt(before.vault)} → ${fmt(after.vault)} ${S()}; the owner's account ${fmt(before.other)} → ${fmt(after.other)} ${S()}.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    if (!reconciled) return mismatch(ctx, "withdrawal", tx);
    const summary = `Owner withdrew ${fmt(amount)} ${S()}; treasury now ${fmt(after.vault)} ${S()} (${fmt(after.vault - after.ringFenced)} free).`;
    rail.record(ctx, { kind: "withdrawal", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ to, amount }) };
  });
  rail.recoverers.set("withdraw", (job) => rail.lookupSent(job, "owner:QEDVault (treasury).withdraw", "withdrawal", "Withdrawal"));
  // R13: a time-locked withdrawal or ring-fence, once applied after the delay (the vault re-checks the free balance then)
  rail.applyHooks.set("withdraw", async (_ctx, d) => `${fmt(BigInt(d.amount))} ${S()} left the treasury vault for the owner's own account.`);
  rail.applyHooks.set("ring-fence", async (_ctx, d) => `${fmt(BigInt(d.amount))} ${S()} is ring-fenced for its creditor until ${new Date(Number(d.dueAt) * 1000).toISOString()}.`);

  const ownerBalanceCheck = (amount: bigint, held: bigint): LimitCheck => ser({ id: "owner-balance", rule: `${S()} held by the owner's own account`, limit: held, used: null, remaining: held, pass: amount <= held });
  rail.proposers.set("deposit", async (p) => {
    only(p, ["amount"], "deposit");
    const amount = rail.raw(p.amount, "Deposit amount"), from = getAddress(rail.owner.address);
    const check = ownerBalanceCheck(amount, await rail.bal(rail.a.asset!, from));
    const terms = {
      ...base("deposit"), token: rail.a.asset, from, amount: human(amount), amountRaw: amount.toString(),
      actions: [{ to: rail.a.asset!, contract: rail.assetContract, function: "approve", args: [rail.a.vault, amount.toString()] }, vaultAction("deposit", [amount.toString()])] as OwnerAction[],
      effect: "The owner's own account lets the vault take exactly this amount, and the vault takes it. The deposit is free funds.",
    };
    return { terms, summary: `Deposit ${fmt(amount)} ${S()} from the owner's own account ${from.slice(0, 10)}… into the treasury vault.`, allowed: check.pass, checks: [check], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("deposit", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, amount = BigInt(t.amountRaw), from = getAddress(t.from);
    const held = await rail.bal(rail.a.asset!, from);
    if (amount > held) return refuse(ctx, `Refused before sending: a deposit of ${fmt(amount)} ${S()} exceeds the ${fmt(held)} ${S()} the owner's own account holds. Nothing was sent.`);
    ownerStep(ctx, `${rail.assetContract.split(" ")[0]}.approve and QEDVault.deposit`);
    const before = await money(from);
    const approved = await rail.ownerSend(ctx, 0, rail.abiFor(rail.assetContract), (a) => [a[0], BigInt(a[1] as string)]);
    ctx.push({ key: "receipt", label: `${rail.assetContract.split(" ")[0]}.approve mined`, status: "ok", detail: `The vault may take exactly ${fmt(amount)} ${S()} from the owner's account (block ${approved.blockNumber}).`, data: rail.txData(approved) });
    const tx = await rail.ownerSend(ctx, 1, rail.v.abi.QEDVaultAbi, (a) => [BigInt(a[0] as string)]);
    ctx.push({ key: "receipt", label: "QEDVault.deposit mined", status: "ok", detail: `Owner transaction in block ${tx.blockNumber}.`, data: rail.txData(tx) });
    const after = await money(from);
    const reconciled = after.vault - before.vault === amount && before.other - after.other === amount && after.ringFenced === before.ringFenced;
    ctx.push({ key: "reconcile", label: "Balances reconciled", status: reconciled ? "ok" : "refused", detail: reconciled ? `Treasury ${fmt(before.vault)} → ${fmt(after.vault)} ${S()}; the owner's account ${fmt(before.other)} → ${fmt(after.other)} ${S()}.` : "Balance changes do not match the receipt.", data: ser({ before, after }) });
    if (!reconciled) return mismatch(ctx, "deposit", tx);
    const summary = `Owner deposited ${fmt(amount)} ${S()}; treasury now ${fmt(after.vault)} ${S()}.`;
    rail.record(ctx, { kind: "deposit", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: ser({ from, amount }) };
  });
  rail.recoverers.set("deposit", (job) => rail.lookupSent(job, "owner:QEDVault (treasury).deposit", "deposit", "Deposit"));

  // ───────────── venues (owner): a later change of the venue set ─────────────
  rail.proposers.set("venues", async (p) => {
    only(p, ["venues"], "venues");
    const list = p.venues as number[], total = rail.a.pools.length;
    if (!Array.isArray(list) || list.length < 1 || list.length > total || list.some((k, i) => !Number.isInteger(k) || k < 0 || k >= total || (i > 0 && k <= list[i - 1]))) throw new RailError("invalid_params", `venues takes { venues }: one to ${total} of the deployed pools by number (0 to ${total - 1}), in ascending order, each once.`, 422);
    const E = rail.venueDefs;
    const describe = (k: number) => ({ i: k, label: E[k]?.label ?? "not one of the deployed pools", pool: rail.a.pools[k] ?? null, feeBps: E[k]?.feeBps ?? null });
    const terms = {
      kind: "venues", chainId: CHAIN_ID, genesisId: rail.genesisId, execution: rail.a.exec,
      current: (await rail.namedVenues()).map(describe), venues: list.map(describe),
      actions: [{ to: rail.a.exec, contract: "QEDExecution", function: "setVenues", args: [list.map((k) => rail.a.pools[k]), list.map((k) => E[k].feeBps)] }] as OwnerAction[],
      effect: "The best-execution proof ranges over exactly these venues from the next block. Every order the co-signer signed for the previous set is void (VenueSetChanged). The Security Lab's attacks need all five.",
    };
    return { terms, summary: `Name ${list.length} venue${list.length === 1 ? "" : "s"} for the agent to trade on: ${list.map((k) => E[k].label).join("; ")}. Orders signed for the previous set become void.`, allowed: true, checks: [], replaces: ["venues"] as ProposalKind[] };
  });
  rail.handlers.set("venues", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, want = (t.venues as { i: number; label: string }[]).map((x) => x.i);
    const named = await rail.namedVenues();
    if (named.length === want.length && named.every((k, i) => k === want[i])) {
      ctx.push({ key: "receipt", label: "QEDExecution.setVenues already done", status: "info", detail: "This venue set is already the named one; not sent again." });
      const summary = "The venue set is already the one named in these terms: nothing to do.";
      rail.record(ctx, { kind: "venues", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary };
    }
    ownerStep(ctx, "QEDExecution.setVenues");
    const tx = await rail.ownerSend(ctx, 0, rail.v.abi.QEDExecutionAbi);
    if (rail.scheduleOf(t)) {
      // a passkey account names venues only after its delay (setVenues is a guarded call)
      const sch = await rail.recordScheduled(ctx, tx, { kind: "venues", summary: `Name ${want.length} venue${want.length === 1 ? "" : "s"}: ${(t.venues as { label: string }[]).map((x) => x.label).join("; ")}`, data: { venues: want } });
      return rail.scheduledOutcome(ctx, tx, `The new venue set (${want.length} venue${want.length === 1 ? "" : "s"}) is approved; the current set stays named until it is applied.`, sch);
    }
    const venueSetHash = (await rail.read(rail.a.exec, rail.v.abi.QEDExecutionAbi, "venueSetHash")) as Hex;
    ctx.push({ key: "receipt", label: "QEDExecution.setVenues mined", status: "ok", detail: `Owner transaction in block ${tx.blockNumber}. ${want.length} venue${want.length === 1 ? "" : "s"} named; venue-set hash ${venueSetHash}. Orders signed for the previous set are void.`, data: rail.txData(tx) });
    const summary = `Owner named ${want.length} venue${want.length === 1 ? "" : "s"}: ${(t.venues as { label: string }[]).map((x) => x.label).join("; ")}. Earlier orders are void.`;
    rail.record(ctx, { kind: "venues", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { venueSetHash, venues: want } };
  });
  rail.recoverers.set("venues", (job) => rail.lookupSent(job, "owner:QEDExecution.setVenues", "venues", "Venue set"));
  rail.applyHooks.set("venues", async (_ctx, d) => `Venues ${(d.venues as number[]).join(", ")} are named; orders signed for the previous set are void.`);

  return { liabilities, liability: (id: string) => liability(BigInt(settleParams(id).id)), settleParams, book, paymentLimits };
}
