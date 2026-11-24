/**
 * Ownership and creditor operations of the release's QEDVault (R13, audit item S5; R7-050, R7-097; F-021, F-026), each
 * approved by the workspace's passkeys through its owner account (QEDOwnerAccount):
 *
 *   transfer-ownership  OWNER. Offers both vaults (treasury and reserve) to another workspace's owner account on this
 *                       installation. QEDVault.transferOwnership is a guarded call of the owner account, so it is only
 *                       scheduled: it runs after the account's delay, any one member can cancel it meanwhile
 *                       (cancel-change), and then anyone may apply it. Applied, it is an offer: the vaults change hands
 *                       only when the new owner accepts (two-step, QEDVault.acceptOwnership).
 *   accept-ownership    NEW OWNER. Accepts a vault of this installation offered to this owner account. At once.
 *   release-claim       CREDITOR. Forgives a liability another vault ring-fenced for this owner account
 *                       (QEDVault.release): the money returns to that vault's free funds, for good.
 *   assign-claim        CREDITOR. Moves such a liability to a new creditor (QEDVault.assign): this workspace's own
 *                       treasury vault, or another workspace's owner account here.
 *
 * The release lets a creditor release or assign at once. QED sends both through the owner account's delayed path
 * (scheduleCalls), like a transfer of ownership: a single stolen passkey could otherwise give a claim away unseen
 * (audit finding C-20), and the delay leaves any one member time to cancel it. The release's QEDVault has no call that
 * withdraws an applied offer of ownership: only another transferOwnership (to the zero address) clears it, and that
 * waits the same delay, during which the offer can still be accepted. QED says so before the passkey signs.
 *
 * Every party here is a workspace of this installation, owned by its own passkeys: QED offers no transfer or
 * assignment to an outside address in this build, so a mistyped address cannot receive a vault or a claim.
 */
import { getAddress, type Address } from "viem";
import type { OpResult, ProposalKind } from "../types.ts";
import { CHAIN_ID } from "./config.ts";
import type { OwnerAction } from "./keys.ts";
import type { PasskeyAccountOwner } from "./owner.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";

const STATUS = ["none", "open", "settled", "released"] as const;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const bad = (m: string) => new RailError("invalid_params", m, 422);

export interface VaultOwnership { vault: Address; which: "treasury" | "reserve"; owner: Address; pendingOwner: Address | null; pendingWorkspace: string | null; ownedByThisAccount: boolean; ownerWorkspace: string | null }
export interface OfferedVault { vault: Address; which: "treasury" | "reserve"; fromWorkspace: string; owner: Address; balance: string; balanceText: string }
export interface ClaimView { vault: Address; which: "treasury" | "reserve"; debtorWorkspace: string; liabilityId: string; creditor: Address; amount: string; amountText: string; dueAt: number; dueTime: string; status: (typeof STATUS)[number]; due: boolean; mine: boolean; assignedTo: Address | null }

export function installOwnership(rail: RailService) {
  const owner = () => {
    if (rail.owner.kind !== "passkey-account" || !rail.host.market) throw new RailError("unsupported_proposal", "Ownership and creditor operations need a workspace owned by a passkey account on the multi-tenant rail.", 422);
    return rail.owner as PasskeyAccountOwner;
  };
  const A = () => rail.v.abi;
  const S = () => rail.asset.symbol, fmt = (x: bigint | string) => rail.fmt(x);
  const readV = (v: Address, fn: string, args: unknown[] = []) => rail.read(v, A().QEDVaultAbi, fn, args);
  const zero = (a: string) => /^0x0+$/.test(a);
  const delay = async () => Number(await owner().read("delay"));
  const span = (x: number) => (x % 86_400 === 0 ? `${x / 86_400} day${x === 86_400 ? "" : "s"}` : x % 3600 === 0 ? `${x / 3600} hour${x === 3600 ? "" : "s"}` : x % 60 === 0 ? `${x / 60} minute${x === 60 ? "" : "s"}` : `${x} seconds`);
  /** Every vault of this installation: each workspace's treasury and reserve, with whose they are. */
  const vaults = () => rail.host.all().filter((w) => w.a?.vault && w.a?.ownerAccount).flatMap((w) => [{ vault: getAddress(w.a.vault), which: "treasury" as const, ws: w.id }, ...(w.a.reserve ? [{ vault: getAddress(w.a.reserve), which: "reserve" as const, ws: w.id }] : [])]);
  const workspaceOfAccount = (a: Address) => rail.host.all().find((w) => w.a?.ownerAccount && getAddress(w.a.ownerAccount) === getAddress(a)) ?? null;
  const vaultOf = (raw: unknown) => {
    if (typeof raw !== "string" || !ADDR.test(raw)) throw bad("vault is a vault's address.");
    const hit = vaults().find((v) => v.vault === getAddress(raw));
    if (!hit) throw new RailError("unknown_vault", "That is not a vault of this installation.", 404);
    return hit;
  };
  const only = (p: Record<string, unknown>, keys: string[], kind: string) => { if (Object.keys(p).some((k) => !keys.includes(k)) || keys.some((k) => !(k in p))) throw bad(`${kind} takes { ${keys.join(", ")} }.`); };
  const proposal = (terms: Record<string, unknown>, summary: string) => ({ terms, summary, allowed: true, checks: [], replaces: [] as ProposalKind[] });
  const base = (kind: string) => ({ kind, chainId: CHAIN_ID, genesisId: rail.genesisId, account: owner().address });
  const ownerStep = (ctx: Ctx, what: string) => ctx.push({ key: "owner", label: "Your passkeys approved the exact terms", status: "ok", detail: `Approval ${ctx.approval!.approvalId} binds these exact terms: ${ctx.proposal!.termsHash}. ${rail.ownerWords(what)}`, data: { termsHash: ctx.proposal!.termsHash, approvalId: ctx.approval!.approvalId } });

  // ───────────── OWNER: offer both vaults to a new owner, behind the account's delay ─────────────
  rail.proposers.set("transfer-ownership", async (p) => {
    const o = owner();
    only(p, ["newOwner"], "transfer-ownership");
    if (typeof p.newOwner !== "string" || !ADDR.test(p.newOwner)) throw bad("newOwner is the new owner's owner account address.");
    const to = getAddress(p.newOwner), ws = workspaceOfAccount(to);
    if (to === o.address) throw new RailError("same_owner", "These vaults already belong to this owner account. Nothing was prepared.", 422);
    if (!ws) throw new RailError("unknown_owner", "QED transfers a wallet only to another workspace of this installation, owned by its own passkeys, which must then accept it. Nothing was prepared.", 422);
    const mine = [{ v: getAddress(rail.a.vault), which: "treasury" }, ...(rail.a.reserve ? [{ v: getAddress(rail.a.reserve), which: "reserve" }] : [])];
    for (const m of mine) if (getAddress(await readV(m.v, "owner")) !== o.address) throw new RailError("vault_transferred", `The ${m.which} vault no longer belongs to this owner account. Nothing was prepared.`, 409);
    const d = await delay();
    const actions: OwnerAction[] = mine.map((m) => ({ to: m.v, contract: `QEDVault (${m.which})`, function: "transferOwnership", args: [to] }));
    const terms = {
      ...base("transfer-ownership"), newOwner: to, newOwnerWorkspace: ws.id, vaults: mine.map((m) => ({ vault: m.v, which: m.which })), delaySeconds: d, actions,
      effect: `Offers both vaults, with everything they hold and every owner power over them (and through them over the execution and policy contracts), to the owner account ${to.slice(0, 10)}…. QEDVault.transferOwnership is a guarded call: it is only scheduled now and runs after this account's delay of ${span(d)}; until then any one of your passkeys can cancel it. Once applied it is an offer: the vaults change hands only when the new owner accepts with its own passkeys. After that, your passkeys no longer control them, and QED refuses every owner action on them. The release has no call that withdraws an applied offer except another transfer (to nobody), which waits the same delay, during which the offer can still be accepted.`,
    };
    return proposal(terms, `Offer both vaults to ${to.slice(0, 10)}… after the owner account's delay of ${span(d)}; the transfer completes only when that account accepts.`);
  });
  rail.handlers.set("transfer-ownership", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    ownerStep(ctx, "the scheduling");
    const tx = await rail.ownerSend(ctx, 0, A().QEDVaultAbi);
    const sch = await rail.recordScheduled(ctx, tx, { kind: "transfer-ownership", summary: `Offer both vaults to ${String(t.newOwner).slice(0, 10)}…`, data: { newOwner: t.newOwner, newOwnerWorkspace: t.newOwnerWorkspace } });
    return rail.scheduledOutcome(ctx, tx, `Scheduled the offer of both vaults to ${String(t.newOwner).slice(0, 10)}….`, sch);
  });
  rail.applyHooks.set("transfer-ownership", async (_ctx, data) => `Both vaults are now offered to ${String(data.newOwner).slice(0, 10)}…; they change hands when that account accepts.`);

  // ───────────── NEW OWNER: accept a vault offered to this account ─────────────
  rail.proposers.set("accept-ownership", async (p) => {
    const o = owner();
    only(p, ["vault"], "accept-ownership");
    const v = vaultOf(p.vault);
    const pending = getAddress(await readV(v.vault, "pendingOwner"));
    if (pending !== o.address) throw new RailError("not_offered", "That vault is not offered to this owner account. Nothing was prepared.", 409);
    const from = getAddress(await readV(v.vault, "owner"));
    const balance = await rail.bal(getAddress(await readV(v.vault, "asset")), v.vault);
    const terms = { ...base("accept-ownership"), vault: v.vault, which: v.which, fromOwner: from, fromWorkspace: v.ws, actions: [{ to: v.vault, contract: `QEDVault (offered ${v.which})`, function: "acceptOwnership", args: [] }] as OwnerAction[], effect: `This owner account becomes the owner of the ${v.which} vault ${v.vault.slice(0, 10)}…, which holds ${fmt(balance)} of its token, at once. Its previous owner's passkeys no longer control it. Its money stays in the vault, ring-fenced promises included; QED shows the vault with this workspace, and does not yet manage a second vault set from one workspace.` };
    return proposal(terms, `Accept ownership of the ${v.which} vault ${v.vault.slice(0, 10)}… offered to this account.`);
  });
  rail.handlers.set("accept-ownership", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, v = getAddress(t.vault);
    if (getAddress(await readV(v, "pendingOwner")) !== owner().address) {
      const summary = getAddress(await readV(v, "owner")) === owner().address ? "This account already owns that vault; nothing was sent." : "That vault is no longer offered to this account; nothing was sent.";
      rail.record(ctx, { kind: "ownership", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary };
    }
    ownerStep(ctx, "the acceptance");
    const tx = await rail.ownerSend(ctx, 0, A().QEDVaultAbi);
    const now = getAddress(await readV(v, "owner"));
    if (now !== owner().address) throw new RailError("not_accepted", `Transaction ${tx.hash} did not make this account the owner. Inspect its receipt.`, 409);
    const summary = `This owner account now owns the ${t.which} vault ${v.slice(0, 10)}…, accepted from ${String(t.fromOwner).slice(0, 10)}….`;
    ctx.push({ key: "receipt", label: "QEDVault.acceptOwnership mined", status: "ok", detail: `${summary} Block ${tx.blockNumber}.`, data: rail.txData(tx) });
    rail.record(ctx, { kind: "ownership", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { vault: v, owner: now } };
  });
  rail.recoverers.set("accept-ownership", (job) => rail.lookupSent(job, "owner:QEDVault (offered treasury).acceptOwnership", "ownership", "Ownership accepted").then((r) => r ?? rail.lookupSent(job, "owner:QEDVault (offered reserve).acceptOwnership", "ownership", "Ownership accepted")));

  // ───────────── CREDITOR: release or assign a claim another vault holds for this account ─────────────
  async function claimFor(p: Record<string, unknown>, keys: string[], kind: string) {
    const o = owner();
    only(p, keys, kind);
    const v = vaultOf(p.vault);
    if (typeof p.liabilityId !== "string" || !/^\d{1,9}$/.test(p.liabilityId) || p.liabilityId === "0") throw bad("liabilityId is the liability's number in that vault.");
    const l = (await readV(v.vault, "getLiability", [BigInt(p.liabilityId)])) as { creditor: Address; amount: bigint; dueAt: bigint; status: number };
    const status = STATUS[Number(l.status)] ?? "none";
    if (status === "none") throw new RailError("unknown_liability", "That vault has no such liability.", 404);
    if (getAddress(l.creditor) !== o.address) throw new RailError("not_the_creditor", "Only the liability's creditor may release or assign it, and this account is not its creditor. Nothing was prepared.", 409);
    if (status !== "open") throw new RailError("liability_not_open", `This liability is ${status}: there is nothing to release or assign. Nothing was prepared.`, 409);
    return { o, v, l, id: p.liabilityId, d: await delay() };
  }
  rail.proposers.set("release-claim", async (p) => {
    const c = await claimFor(p, ["vault", "liabilityId"], "release-claim");
    const terms = { ...base("release-claim"), vault: c.v.vault, which: c.v.which, debtorWorkspace: c.v.ws, liabilityId: c.id, amount: fmt(c.l.amount).replace(/,/g, ""), amountRaw: c.l.amount.toString(), dueAt: Number(c.l.dueAt), delaySeconds: c.d, actions: [{ to: c.v.vault, contract: `QEDVault (debtor ${c.v.which})`, function: "release", args: [c.id], schedule: true }] as OwnerAction[], effect: `Forgives liability #${c.id}: ${fmt(c.l.amount)} ${S()} the vault ${c.v.vault.slice(0, 10)}… holds for this account goes back to that vault's free funds, for good. QED schedules it behind this owner account's delay of ${span(c.d)}, during which any one of your passkeys can cancel it; then anyone may apply it. If the liability is paid to you before then, the release does nothing.` };
    return proposal(terms, `Release liability #${c.id} (${fmt(c.l.amount)} ${S()}) that ${c.v.vault.slice(0, 10)}… holds for you, after the owner account's delay of ${span(c.d)}.`);
  });
  rail.proposers.set("assign-claim", async (p) => {
    const c = await claimFor(p, ["vault", "liabilityId", "newCreditor"], "assign-claim");
    if (typeof p.newCreditor !== "string" || !ADDR.test(p.newCreditor)) throw bad("newCreditor is the new creditor's address.");
    const to = getAddress(p.newCreditor);
    const own = to === getAddress(rail.a.vault), other = workspaceOfAccount(to);
    if (to === c.o.address) throw new RailError("same_creditor", "This account is already the creditor. Nothing was prepared.", 422);
    if (!own && (!other || other.id === rail.id)) throw new RailError("unknown_creditor", "QED assigns a claim to this workspace's own treasury vault or to another workspace's owner account on this installation, nothing else. Nothing was prepared.", 422);
    const terms = { ...base("assign-claim"), vault: c.v.vault, which: c.v.which, debtorWorkspace: c.v.ws, liabilityId: c.id, amount: fmt(c.l.amount).replace(/,/g, ""), amountRaw: c.l.amount.toString(), dueAt: Number(c.l.dueAt), newCreditor: to, newCreditorIs: own ? "this workspace's treasury vault" : `the owner account of workspace ${other!.id}`, delaySeconds: c.d, actions: [{ to: c.v.vault, contract: `QEDVault (debtor ${c.v.which})`, function: "assign", args: [c.id, to] , schedule: true }] as OwnerAction[], effect: `Assigns liability #${c.id} (${fmt(c.l.amount)} ${S()}, due ${new Date(Number(c.l.dueAt) * 1000).toISOString()}) to ${own ? "this workspace's treasury vault: when it is paid, the money goes straight into the vault" : `the owner account ${to.slice(0, 10)}…: from then on only it is paid, and only it may release or assign the claim`}. QED schedules it behind this owner account's delay of ${span(c.d)}, during which any one of your passkeys can cancel it; then anyone may apply it.` };
    return proposal(terms, `Assign liability #${c.id} (${fmt(c.l.amount)} ${S()}) to ${own ? "your treasury vault" : `${to.slice(0, 10)}…`}, after the owner account's delay of ${span(c.d)}.`);
  });
  for (const [kind, verb] of [["release-claim", "Release"], ["assign-claim", "Assign"]] as const) {
    rail.handlers.set(kind, async (ctx): Promise<OpResult> => {
      const t = ctx.terms;
      ownerStep(ctx, "the scheduling");
      const tx = await rail.ownerSend(ctx, 0, A().QEDVaultAbi);
      const sch = await rail.recordScheduled(ctx, tx, { kind, summary: `${verb} liability #${t.liabilityId} of ${String(t.vault).slice(0, 10)}…${kind === "assign-claim" ? ` to ${String(t.newCreditor).slice(0, 10)}…` : ""}`, data: { vault: t.vault, liabilityId: t.liabilityId, ...(t.newCreditor ? { newCreditor: t.newCreditor } : {}) } });
      return rail.scheduledOutcome(ctx, tx, `Scheduled: ${verb.toLowerCase()} liability #${t.liabilityId} (${fmt(t.amountRaw)} ${S()}).`, sch);
    });
    rail.applyHooks.set(kind, async (_ctx, data) => kind === "release-claim" ? `Liability #${data.liabilityId} is released: its money is back in the debtor vault's free funds.` : `Liability #${data.liabilityId} now belongs to ${String(data.newCreditor).slice(0, 10)}….`);
  }

  // ───────────── reads ─────────────
  /** This workspace's two vaults (who owns them, what is offered) and the vaults of this installation offered to it. */
  async function state(): Promise<{ delaySeconds: number; mine: VaultOwnership[]; offeredToMe: OfferedVault[]; ownedHere: OfferedVault[] }> {
    const o = owner();
    const all = vaults();
    const mine: VaultOwnership[] = [];
    const offeredToMe: OfferedVault[] = [], ownedHere: OfferedVault[] = [];
    for (const v of all) {
      const [ow, pe] = [getAddress(await readV(v.vault, "owner")), getAddress(await readV(v.vault, "pendingOwner"))];
      if (v.ws === rail.id) mine.push({ vault: v.vault, which: v.which, owner: ow, pendingOwner: zero(pe) ? null : pe, pendingWorkspace: zero(pe) ? null : workspaceOfAccount(pe)?.id ?? null, ownedByThisAccount: ow === o.address, ownerWorkspace: workspaceOfAccount(ow)?.id ?? null });
      else if (pe === o.address || ow === o.address) {
        const bal = await rail.bal(getAddress(await readV(v.vault, "asset")), v.vault);
        (ow === o.address ? ownedHere : offeredToMe).push({ vault: v.vault, which: v.which, fromWorkspace: v.ws, owner: ow, balance: bal.toString(), balanceText: fmt(bal) });
      }
    }
    return { delaySeconds: await delay(), mine, offeredToMe, ownedHere };
  }
  /** Liabilities of any vault here that name, or named, this owner account as creditor: claims it can release or assign. */
  async function claims(): Promise<ClaimView[]> {
    const o = owner();
    const out: ClaimView[] = [];
    const now = await rail.chainNow();
    for (const v of vaults()) {
      const ev = (eventName: string, args: Record<string, unknown>) => rail.pub.getContractEvents({ address: v.vault, abi: A().QEDVaultAbi, eventName, args, fromBlock: 0n } as never) as Promise<any[]>;
      const [created, assignedIn, assignedOut] = await Promise.all([ev("LiabilityCreated", { creditor: o.address }), ev("LiabilityAssigned", { to: o.address }), ev("LiabilityAssigned", { from: o.address })]);
      const ids = new Set<string>([...created, ...assignedIn, ...assignedOut].map((e) => e.args.id.toString()));
      for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
        const l = (await readV(v.vault, "getLiability", [BigInt(id)])) as { creditor: Address; amount: bigint; dueAt: bigint; status: number };
        const status = STATUS[Number(l.status)] ?? "none";
        const mine = getAddress(l.creditor) === o.address;
        out.push({ vault: v.vault, which: v.which, debtorWorkspace: v.ws, liabilityId: id, creditor: getAddress(l.creditor), amount: l.amount.toString(), amountText: `${fmt(l.amount)} ${S()}`, dueAt: Number(l.dueAt), dueTime: new Date(Number(l.dueAt) * 1000).toISOString(), status, due: status === "open" && now >= l.dueAt, mine, assignedTo: mine ? null : getAddress(l.creditor) });
      }
    }
    return out;
  }

  return { state, claims };
}

