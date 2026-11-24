/**
 * A workspace's signers and recovery (RISK-053), through QEDOwnerAccount's own mechanisms (chain/accounts). Nothing
 * here changes the contract; every rule below is the contract's, and the rail only prepares, relays and records.
 *
 *   add-signer      addSigner(x, y, role) inside execute, approved by the ADMIN threshold of member passkeys over the
 *                   exact execute digest (which names the key). Immediate, because the contract makes it so: adding a
 *                   signer lowers no threshold, and adminThreshold >= threshold always holds, so members fewer than
 *                   the threshold can never add a member and then reach it. A member is a passkey; a recovery key is
 *                   a raw P-256 key whose holder can only start a recovery (below).
 *   remove-signers  removeSigners(ids) inside execute (admin threshold): protection-reducing, so the account only
 *                   SCHEDULES it behind its delay; any member it does not remove can cancel it (cancel-change), and
 *                   anyone applies it once due (applyChange through POST /scheduled/:id/apply). The account refuses,
 *                   when scheduled and again when applied, a removal that would leave fewer members than the admin
 *                   threshold: never fewer than the threshold, never zero.
 *   set-thresholds  setThresholds(threshold, adminThreshold) inside execute (admin threshold): raising either is
 *                   immediate; lowering either is scheduled like a removal, and re-checked when applied.
 *   start-recovery  a recovery key's raw P-256 signature (ECDSA/SHA-256) over recoveryDigest(key, newX, newY,
 *                   deadline) starts a recovery that adds ONE member after recoveryDelay. No member signs it; any one
 *                   member can cancel it (cancel-change), which also burns the key; anyone finishes it once due
 *                   (finishRecovery through POST /scheduled/:id/apply). The key is spent by the attempt.
 *   freeze-signer   (R13) the wallet asks, when it has suspended a passkey, and the workspace's sentinel key sends
 *                   QEDOwnerAccount.freeze(signerId): from the next block that member's approval no longer counts for
 *                   execute or ERC-1271 (no payment, mandate or change), while it keeps its veto (cancel) and may still
 *                   stop things (protect). The sentinel key can do nothing else on the account; only the admin quorum
 *                   of unfrozen members unfreezes (an execute of unfreeze). Accounts built before R13 have no sentinel:
 *                   for them this is refused, and nothing on the chain contains the passkey until its removal applies.
 *   set-guardian    (R13) setGuardian(x, y) inside execute (admin threshold): always SCHEDULED behind the delay, any
 *                   member can cancel. The guardian is a passkey of the person's recovery contact: while one is set, a
 *                   recovery starts only with its WebAuthn assertion over the same recovery digest (startCosignedRecovery),
 *                   and a frozen member cannot cancel a recovery it co-signed. It approves, cancels and stops nothing.
 *                   { remove: true } schedules its removal (setGuardian(0, 0)).
 *   set-time-lock   (R13) setTimeLock(on) inside execute (admin threshold): on is immediate; off is scheduled behind the
 *                   delay. While on, the vaults' withdraw, ringFence, unpause and setGuardian are scheduled like guarded
 *                   calls (owner.ts prepare). Accounts built before R13 have neither option and gain nothing.
 *
 * The rail never holds a key that can satisfy the account and never sees a recovery code: it receives public keys,
 * assertions and signatures, and it cannot change what they cover (the execute digest covers the calls, nonce and
 * deadline; the recovery digest covers the recovery key, the new key and the deadline).
 */
import { createPublicKey } from "node:crypto";
import { encodeFunctionData, type Hex } from "viem";
import type { OpResult, ProposalKind, RecoveryDigest, ScheduledChange, SignersView } from "../types.ts";
import { CHAIN_ID } from "./config.ts";
import type { OwnerAction } from "./keys.ts";
import { accountTakesContainment, type PasskeyAccountOwner } from "./owner.ts";
import { RailError, type Ctx, type RailService } from "./service.ts";
import { parse } from "./store.ts";
import { AssertionError, assertionsFor, signerIdOf, type ContractAssertion } from "./webauthn.ts";

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const ROLE = { member: 1, recovery: 2 } as const;
const ROLE_NAME = ["none", "member", "recovery", "guardian"] as const;
const ZERO32 = /^0x0{64}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const hex32 = (x: bigint): Hex => `0x${x.toString(16).padStart(64, "0")}`;
const bad = (m: string) => new RailError("invalid_params", m, 422);

/** A P-256 public key from { x, y } (0x hex, at most 32 bytes each), checked to be on the curve. */
export function p256Key(k: unknown, what = "key"): { x: Hex; y: Hex } {
  const o = k as Record<string, unknown> | null;
  const ok = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v);
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((z) => z !== "x" && z !== "y") || !ok(o.x) || !ok(o.y)) throw bad(`${what} must be { x, y }: a P-256 public key, each coordinate 0x-prefixed hex of at most 32 bytes.`);
  const x = hex32(BigInt(o.x as string)), y = hex32(BigInt(o.y as string));
  try { createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(x.slice(2), "hex").toString("base64url"), y: Buffer.from(y.slice(2), "hex").toString("base64url") }, format: "jwk" }); } catch { throw bad(`${what} is not a point on the P-256 curve.`); }
  return { x, y };
}

const span = (s: number) => (s % 86_400 === 0 ? `${s / 86_400} day${s === 86_400 ? "" : "s"}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? "" : "s"}` : s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

export function installSigners(rail: RailService) {
  const owner = () => {
    if (rail.owner.kind !== "passkey-account") throw new RailError("unsupported_proposal", "Only a workspace owned by a passkey account (QEDOwnerAccount) has signers to manage.", 422);
    return rail.owner as PasskeyAccountOwner;
  };
  const account = () => owner().address;
  /** Whether this workspace's account build has R13's sentinel and protect (accounts created before it do not). */
  const contained = () => accountTakesContainment(owner().abi);
  /** Whether this workspace's account build has R13's owner options: a guardian and the time-lock (earlier ones do not). */
  const options = () => owner().hasOwnerOptions;
  /** Whether this workspace's account build has the R13 review fixes (a removal must leave members able to cancel it). */
  const reviewFixes = () => (owner().abi as readonly { type: string; name?: string }[]).some((x) => x.type === "error" && x.name === "NoCancellerLeft");
  const read = (fn: string, args: unknown[] = []) => owner().read(fn, args);
  const accountAction = (fn: string, args: unknown[]): OwnerAction => ({ to: account(), contract: "QEDOwnerAccount", function: fn, args });
  const base = (kind: ProposalKind) => ({ kind, chainId: CHAIN_ID, genesisId: rail.genesisId, account: account() });

  /** The signer set as the chain holds it now. */
  async function current() {
    const ids = (await read("signerIds")) as Hex[];
    const signers = await Promise.all(ids.map(async (id) => {
      const s = (await read("getSigner", [id])) as { x: bigint; y: bigint; role: number; serial: bigint; frozen?: boolean; since?: bigint };
      return { signerId: id.toLowerCase() as Hex, x: hex32(s.x), y: hex32(s.y), role: ROLE_NAME[Number(s.role)] as "member" | "recovery" | "guardian", serial: s.serial.toString(), frozen: s.frozen === true, since: Number(s.since ?? 0n) };
    }));
    const [threshold, adminThreshold, memberCount, delay, recoveryDelay] = (await Promise.all(["threshold", "adminThreshold", "memberCount", "delay", "recoveryDelay"].map((f) => read(f)))) as bigint[];
    // R13: the account's sentinel (zero when it has none, null when its build predates R13)
    const sentinel = contained() ? ((await read("sentinel")) as string).toLowerCase() : null;
    // R13: the guardian's signer id (null when none) and the time-lock; both absent before R13
    const g = options() ? ((await read("guardian")) as string).toLowerCase() : null;
    const timeLocked = options() ? ((await read("timeLocked")) as boolean) : false;
    return { signers, threshold: Number(threshold), adminThreshold: Number(adminThreshold), memberCount: Number(memberCount), delaySeconds: Number(delay), recoveryDelaySeconds: Number(recoveryDelay), sentinel, guardian: g && !ZERO32.test(g) ? (g as Hex) : null, timeLocked };
  }
  /** Pending changes of the signer set, as this rail recorded them and the chain still holds them. */
  async function pending(): Promise<ScheduledChange[]> {
    return (await rail.scheduled()).filter((c) => c.status === "pending" && ["remove-signers", "set-thresholds", "recovery", "set-guardian", "set-time-lock"].includes(c.kind));
  }

  /** Refreshes the workspace view's signers and thresholds from the chain, and the host's record of every signer ever (R7 D7). */
  async function refresh(): Promise<void> {
    if (rail.owner.kind !== "passkey-account") return;
    const c = await current();
    rail.summary.signers = c.signers.filter((s) => s.role !== "guardian").map((s) => ({ signerId: s.signerId, x: s.x, y: s.y, role: s.role as "member" | "recovery" }));
    rail.summary.threshold = c.threshold;
    rail.summary.adminThreshold = c.adminThreshold;
    await rail.host.syncSignerHistory(rail.id);
  }

  async function view(): Promise<SignersView> {
    rail.host.requireReady();
    const o = owner();
    const c = await current();
    const p = await pending();
    const removal = new Map<string, Hex>(), recovering = new Map<string, Hex>();
    for (const ch of p) {
      const d = (parse<{ data?: { ids?: string[]; recoverySignerId?: string } }>(rail.store.scheduled(ch.changeId)?.hook as string) ?? {}).data ?? {};
      if (ch.kind === "remove-signers") for (const id of d.ids ?? []) removal.set(id.toLowerCase(), ch.changeId);
      if (ch.kind === "recovery" && d.recoverySignerId) recovering.set(d.recoverySignerId.toLowerCase(), ch.changeId);
    }
    await rail.host.syncSignerHistory(rail.id);
    return {
      account: o.address,
      signers: c.signers.map((s) => ({ ...s, pendingRemoval: removal.get(s.signerId) ?? null, pendingRecovery: recovering.get(s.signerId) ?? null })),
      threshold: c.threshold, adminThreshold: c.adminThreshold, memberCount: c.memberCount, delaySeconds: c.delaySeconds, recoveryDelaySeconds: c.recoveryDelaySeconds,
      // R13: whether this service can freeze a member of this account at once (its own sentinel key is the account's)
      containment: { sentinel: c.sentinel, byThisService: !!c.sentinel && !!rail.sentinel && c.sentinel === rail.sentinel.address.toLowerCase(), protect: contained() },
      guardian: (() => { const k = c.guardian ? c.signers.find((s) => s.signerId === c.guardian) : undefined; return { supported: options(), signerId: c.guardian, x: k?.x ?? null, y: k?.y ?? null }; })(),
      timeLock: { supported: options(), on: c.timeLocked, calls: o.lockable.map((g) => ({ target: g.target as `0x${string}`, selector: g.selector })) },
      pending: p,
      everSigners: rail.host.everSigners(rail.id),
      rules: [
        `Adding a signer takes ${c.adminThreshold} member signature${c.adminThreshold === 1 ? "" : "s"} over the exact terms and applies at once: the contract makes it immediate because it lowers no threshold.`,
        `Removing signers or lowering a threshold takes ${c.adminThreshold} member signature${c.adminThreshold === 1 ? "" : "s"} and waits ${span(c.delaySeconds)}; any member it does not remove can cancel it meanwhile. The account never lets the members fall below the admin threshold.${reviewFixes() ? ` Removing a passkey that is not frozen also needs more than ${c.adminThreshold} other member${c.adminThreshold === 1 ? "" : "s"}, each a member for at least ${span(c.delaySeconds)}, left to cancel it.` : ""}`,
        `A recovery key can only start a recovery that adds one passkey after ${span(c.recoveryDelaySeconds)}; any member can cancel it, which spends the key.`,
        ...(contained() ? ["A passkey the wallet suspends is frozen on this account at once by the service's sentinel key: from then its signature moves no money and changes nothing; it can still cancel a change and stop things (pause, revoke a mandate). That key can do nothing else, and only the unfrozen signers can unfreeze."] : ["This account was set up before the wallet could freeze a passkey on the chain: a suspended passkey stays a full signer here until its removal applies."]),
        ...(options()
          ? [
            c.guardian ? `A guardian (a recovery contact's passkey) is set: a recovery starts only with its co-signature over the same recovery, and a frozen passkey cannot cancel a co-signed recovery.${reviewFixes() ? ` The guardian can withdraw its co-signature until the recovery finishes. A co-signed recovery finishes only after ${span(c.recoveryDelaySeconds)} during which some member was not frozen, or during which this account's sentinel (QED's key), unchanged, could stop it: QED stops it at a member's request (POST …/recoveries/:id/stop). With every member frozen and no such sentinel it waits and cannot finish.` : ""} It approves and stops nothing. Replacing or removing it waits the delay.` : "No guardian is set: a recovery code alone starts a recovery, which any member, frozen or not, can cancel. Setting a guardian waits the delay.",
            c.timeLocked ? `The time-lock is on: withdrawing, ring-fencing, resuming the vault and replacing its guardian wait ${span(c.delaySeconds)}, during which any member can cancel. Turning it off waits the same delay${reviewFixes() ? "; turning it on again voids any pending change that would turn it off" : ""}.` : "The time-lock is off: withdrawing, ring-fencing, resuming the vault and replacing its guardian run at once at the threshold. Turning it on applies at once.",
          ]
          : ["This account was set up before guardians and the time-lock existed: it keeps its bytecode and gains neither (a new wallet is needed for them)."]),
      ],
    };
  }

  // ───────────── add a member passkey or a recovery key (immediate) ─────────────
  rail.proposers.set("add-signer", async (p) => {
    owner();
    if (Object.keys(p).some((k) => !["x", "y", "role"].includes(k))) throw bad("add-signer takes { x, y, role } and nothing else.");
    const role = p.role === "member" || p.role === "recovery" ? p.role : null;
    if (!role) throw bad("role must be \"member\" (a passkey) or \"recovery\" (a recovery key).");
    const key = p256Key({ x: p.x, y: p.y }, "The signer");
    const signerId = signerIdOf(BigInt(key.x), BigInt(key.y)).toLowerCase() as Hex;
    const c = await current();
    if (c.signers.some((s) => s.signerId === signerId)) throw new RailError("signer_exists", "That key is already a signer of this owner account. Nothing was prepared.", 409);
    if (c.signers.length >= 16) throw new RailError("too_many_signers", "The owner account holds at most 16 signers (members and recovery keys together). Remove one first. Nothing was prepared.", 409);
    if (role === "recovery" && ((await read("spentRecoveryKey", [signerId])) as boolean)) throw new RailError("recovery_key_spent", "That recovery key was used or cancelled once and can never be a recovery key again. Make a new one. Nothing was prepared.", 409);
    const after = { members: c.memberCount + (role === "member" ? 1 : 0), threshold: c.threshold, adminThreshold: c.adminThreshold };
    const terms = {
      ...base("add-signer"), signer: { signerId, x: key.x, y: key.y, role },
      before: { members: c.memberCount, threshold: c.threshold, adminThreshold: c.adminThreshold }, after,
      actions: [accountAction("addSigner", [key.x, key.y, ROLE[role]])],
      effect: role === "member"
        ? `This passkey becomes a member of the owner account in the next block, at once: the contract applies additions immediately because they lower no threshold. From then on it counts towards the threshold (${c.threshold}) like the other ${c.memberCount} member${c.memberCount === 1 ? "" : "s"}. To take it away later is a removal, which waits the account's delay.`
        : `This recovery key is added at once. It can do one thing only: start a recovery that adds one passkey as a member after ${span(c.recoveryDelaySeconds)}, during which any member can cancel it; it is spent by that one attempt. It cannot approve, sign or cancel anything.`,
    };
    return { terms, summary: role === "member" ? `Add a passkey (${signerId.slice(0, 10)}…) as a member of the owner account, at once.` : `Add a recovery key (${signerId.slice(0, 10)}…) to the owner account, at once.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("add-signer", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, id = String(t.signer.signerId).toLowerCase();
    const known = (await current()).signers.find((s) => s.signerId === id);
    if (known) {
      const summary = `That key is already a ${known.role === "member" ? "member" : "recovery key"} of the owner account; nothing was sent.`;
      rail.record(ctx, { kind: "signers", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary, evidence: { signerId: id, role: known.role } };
    }
    const tx = await rail.ownerSend(ctx, 0, owner().abi);
    const added = (await owner().eventsIn(tx.hash, "SignerAdded")).find((e) => String(e.args.signerId).toLowerCase() === id);
    if (!added) throw new RailError("signer_not_added", `Transaction ${tx.hash} did not add the signer. Inspect its receipt.`, 409);
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.addSigner mined", status: "ok", detail: `Added in block ${tx.blockNumber} as a ${t.signer.role === "member" ? "member" : "recovery key"} (serial ${added.args.serial}). ${rail.ownerWords("the addition")}`, data: rail.txData(tx) });
    await refresh();
    const summary = t.signer.role === "member" ? `Added a passkey (${id.slice(0, 10)}…) as a member of the owner account; ${t.after.members} member${t.after.members === 1 ? "" : "s"} now, threshold ${t.after.threshold}.` : `Added a recovery key (${id.slice(0, 10)}…) to the owner account.`;
    rail.record(ctx, { kind: "signers", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { signerId: id, role: t.signer.role, serial: String(added.args.serial) } };
  });
  rail.rerunnable.add("add-signer");

  /** After a scheduling transaction: the account's ChangeScheduled event, recorded as a pending change. */
  async function recordAccountChange(ctx: Ctx, tx: any, kind: "remove-signers" | "set-thresholds" | "set-guardian" | "set-time-lock", summary: string, data: Record<string, unknown>) {
    const ev = (await owner().eventsIn(tx.hash, "ChangeScheduled"))[0];
    if (!ev) throw new RailError("schedule_not_found", `Transaction ${tx.hash} did not schedule the change. Inspect its receipt.`, 409);
    const changeId = String(ev.args.changeId).toLowerCase() as Hex, readyAt = Number(ev.args.readyAt);
    rail.store.insertScheduled({ changeId, kind, summary, calls: [], readyAt, hook: { kind, data }, proposalId: ctx.proposal!.id, jobId: ctx.jobId, at: rail.iso() });
    rail.store.appendDecision({ at: rail.iso(), kind: "owner-scheduled", jobId: ctx.jobId, verdict: "SCHEDULED", clock: ctx.clock, approval: ctx.approval, termsHash: ctx.proposal!.termsHash, record: { changeId, readyAt, kind, data } });
    ctx.push({ key: "scheduled", label: "Scheduled behind the owner account's delay", status: "info", detail: `${summary}: the owner account recorded it but applies it only from ${new Date(readyAt * 1000).toISOString()}. Until then any member it does not remove can cancel it with a passkey (proposal kind cancel-change); after it, anyone may apply it (POST /workspaces/${rail.id}/scheduled/${changeId}/apply). Nothing changed yet.`, data: { changeId, readyAt } });
    return rail.scheduledOutcome(ctx, tx, `${summary}.`, { changeId, readyAt });
  }

  // ───────────── remove signers (scheduled) ─────────────
  rail.proposers.set("remove-signers", async (p) => {
    owner();
    if (Object.keys(p).some((k) => k !== "signerIds")) throw bad("remove-signers takes { signerIds } and nothing else.");
    const raw = p.signerIds;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16 || raw.some((x) => typeof x !== "string" || !HEX32.test(x))) throw bad("signerIds lists 1 to 16 signer ids, each 0x followed by 64 hexadecimal characters.");
    const ids = [...new Set(raw.map((x) => (x as string).toLowerCase()))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)) as Hex[];
    if (ids.length !== raw.length) throw bad("signerIds must not repeat an id.");
    const c = await current();
    const targets = ids.map((id) => c.signers.find((s) => s.signerId === id) ?? null);
    const missing = ids.filter((_, i) => !targets[i]);
    if (missing.length) throw new RailError("unknown_signer", `Not a signer of this owner account: ${missing.join(", ")}. Nothing was prepared.`, 404);
    const scheduledFor = new Set<string>();
    for (const ch of await pending()) if (ch.kind === "remove-signers") for (const id of (parse<{ data?: { ids?: string[] } }>(rail.store.scheduled(ch.changeId)?.hook as string)?.data?.ids ?? [])) scheduledFor.add(id.toLowerCase());
    const again = ids.filter((id) => scheduledFor.has(id));
    if (again.length) throw new RailError("removal_already_scheduled", `A removal of ${again.join(", ")} is already scheduled. Nothing was prepared.`, 409);
    const membersLeft = c.memberCount - targets.filter((s) => s!.role === "member").length;
    if (membersLeft < c.adminThreshold) throw new RailError("would_break_quorum", `This would leave ${membersLeft} member${membersLeft === 1 ? "" : "s"}, and the owner account needs at least ${c.adminThreshold} (its admin threshold; its threshold is ${c.threshold}). Add a passkey first, or lower the thresholds first. Nothing was prepared.`, 409, { membersLeft, threshold: c.threshold, adminThreshold: c.adminThreshold });
    // R13 review fix F2: naming a member that is not frozen needs more members it does not name, each a member for at
    // least the delay (or since the account was created), than the admin threshold: one of them can cancel it
    if (reviewFixes() && targets.some((s) => s!.role === "member" && !s!.frozen)) {
      const now = Number(await rail.chainNow());
      const witnesses = c.signers.filter((s) => s.role === "member" && !ids.includes(s.signerId) && (s.since === 0 || s.since + c.delaySeconds <= now)).length;
      if (witnesses <= c.adminThreshold) throw new RailError("no_canceller_left", `The owner account schedules the removal of a passkey that is not frozen only if more than ${c.adminThreshold} other member${c.adminThreshold === 1 ? "" : "s"}, each a member for at least ${span(c.delaySeconds)}, remain to cancel it; ${witnesses} would. Freeze the passkey first (suspend it in QED), or add another passkey and wait ${span(c.delaySeconds)}. Nothing was prepared.`, 409, { witnesses, adminThreshold: c.adminThreshold });
    }
    const terms = {
      ...base("remove-signers"), remove: targets.map((s) => ({ signerId: s!.signerId, role: s!.role, x: s!.x, y: s!.y })),
      before: { members: c.memberCount, threshold: c.threshold, adminThreshold: c.adminThreshold }, after: { members: membersLeft, threshold: c.threshold, adminThreshold: c.adminThreshold },
      delaySeconds: c.delaySeconds, actions: [accountAction("removeSigners", [ids])],
      effect: `Scheduled, not immediate: removing a signer reduces protection, so the owner account applies it only after ${span(c.delaySeconds)}. Until then the signers keep working, and any member that this removes cannot cancel it; any other member can. The account re-checks when it applies that at least ${c.adminThreshold} member${c.adminThreshold === 1 ? "" : "s"} remain.`,
    };
    return { terms, summary: `Remove ${ids.length} signer${ids.length === 1 ? "" : "s"} from the owner account after ${span(c.delaySeconds)} (${membersLeft} member${membersLeft === 1 ? "" : "s"} would remain).`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("remove-signers", async (ctx): Promise<OpResult> => {
    const t = ctx.terms, targets = t.remove as { signerId: string; x: string; y: string; role: string }[], ids = targets.map((s) => s.signerId);
    // the next block carries the rail's clock: the account judges how long each member has been one by it (R13 review fix F2)
    ctx.clock = await rail.align();
    const tx = await rail.ownerSend(ctx, 0, owner().abi);
    return recordAccountChange(ctx, tx, "remove-signers", `Remove ${ids.length} signer${ids.length === 1 ? "" : "s"} (${ids.map((x) => `${x.slice(0, 10)}…`).join(", ")})`, { ids, keys: targets.map((s) => ({ signerId: s.signerId, x: s.x, y: s.y, role: s.role })) });
  });

  // ───────────── thresholds: raise at once, lower after the delay ─────────────
  rail.proposers.set("set-thresholds", async (p) => {
    owner();
    if (Object.keys(p).some((k) => !["threshold", "adminThreshold"].includes(k))) throw bad("set-thresholds takes { threshold, adminThreshold? } and nothing else.");
    const c = await current();
    const t = p.threshold, a = p.adminThreshold === undefined ? p.threshold : p.adminThreshold;
    if (!Number.isInteger(t) || !Number.isInteger(a) || (t as number) < 1 || (t as number) > (a as number) || (a as number) > c.memberCount) throw new RailError("invalid_thresholds", `Thresholds must satisfy 1 ≤ threshold ≤ admin threshold ≤ members (${c.memberCount}). Nothing was prepared.`, 422, { members: c.memberCount });
    const T = t as number, A = a as number;
    if (T === c.threshold && A === c.adminThreshold) throw new RailError("nothing_to_change", `The thresholds are already ${T} and ${A}. Nothing was prepared.`, 409);
    const immediate = T >= c.threshold && A >= c.adminThreshold;
    const terms = {
      ...base("set-thresholds"), before: { threshold: c.threshold, adminThreshold: c.adminThreshold, members: c.memberCount }, after: { threshold: T, adminThreshold: A, members: c.memberCount },
      immediate, delaySeconds: c.delaySeconds, actions: [accountAction("setThresholds", [T, A])],
      effect: immediate ? `At once: raising a threshold adds protection. From the next block every approval needs ${T} member signature${T === 1 ? "" : "s"}, and changes to the account itself ${A}.` : `Scheduled, not immediate: lowering a threshold reduces protection, so the owner account applies it only after ${span(c.delaySeconds)}, and only if the thresholds are still ${c.threshold} and ${c.adminThreshold} then. Any member can cancel it meanwhile.`,
    };
    return { terms, summary: `${immediate ? "Raise" : "Lower"} the owner account's thresholds from ${c.threshold}/${c.adminThreshold} to ${T}/${A}${immediate ? ", at once" : ` after ${span(c.delaySeconds)}`}.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("set-thresholds", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const tx = await rail.ownerSend(ctx, 0, owner().abi);
    const changed = (await owner().eventsIn(tx.hash, "ThresholdsChanged"))[0];
    if (changed) {
      ctx.push({ key: "receipt", label: "QEDOwnerAccount.setThresholds mined", status: "ok", detail: `Thresholds ${t.after.threshold} and ${t.after.adminThreshold} from block ${tx.blockNumber}.`, data: rail.txData(tx) });
      await refresh();
      const summary = `Raised the owner account's thresholds to ${t.after.threshold} (approvals) and ${t.after.adminThreshold} (changes to the account).`;
      rail.record(ctx, { kind: "signers", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
      return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { threshold: t.after.threshold, adminThreshold: t.after.adminThreshold } };
    }
    return recordAccountChange(ctx, tx, "set-thresholds", `Lower the thresholds to ${t.after.threshold} and ${t.after.adminThreshold}`, { threshold: t.after.threshold, adminThreshold: t.after.adminThreshold });
  });

  // ───────────── R13: the guardian (always behind the delay) ─────────────
  const noOptions = () => new RailError("owner_options_unavailable", "This workspace's owner account was set up before guardians and the time-lock existed: it keeps its bytecode and gains neither. A new wallet (a new account and vault set) has them. Nothing was prepared.", 409);
  rail.proposers.set("set-guardian", async (p) => {
    owner();
    if (!options()) throw noOptions();
    const remove = p.remove === true;
    if (remove ? Object.keys(p).some((k) => k !== "remove") : Object.keys(p).some((k) => !["x", "y"].includes(k))) throw bad("set-guardian takes { x, y } (the guardian's passkey) or { remove: true }, and nothing else.");
    const c = await current();
    const key = remove ? null : p256Key({ x: p.x, y: p.y }, "The guardian's passkey");
    const id = key ? (signerIdOf(BigInt(key.x), BigInt(key.y)).toLowerCase() as Hex) : null;
    if (remove && !c.guardian) throw new RailError("no_guardian", "This owner account has no guardian to remove. Nothing was prepared.", 409);
    if (id && id === c.guardian) throw new RailError("already_guardian", "That passkey is already the guardian. Nothing was prepared.", 409);
    if (id && c.signers.some((s) => s.signerId === id)) throw new RailError("signer_exists", "That passkey already signs for this owner account (or is one of its recovery keys): a guardian must be someone else's passkey. Nothing was prepared.", 409);
    if (key && c.signers.length >= 16 && !c.guardian) throw new RailError("too_many_signers", "The owner account holds at most 16 signers, the guardian included. Remove one first. Nothing was prepared.", 409);
    for (const ch of await pending()) if (ch.kind === "set-guardian") throw new RailError("guardian_change_pending", "A change of the guardian is already scheduled: cancel it or let it apply first. Nothing was prepared.", 409, { changeId: ch.changeId });
    const terms = {
      ...base("set-guardian"), guardian: key ? { signerId: id, x: key.x, y: key.y } : null, before: { guardian: c.guardian }, delaySeconds: c.delaySeconds,
      actions: [accountAction("setGuardian", key ? [key.x, key.y] : ["0", "0"])],
      effect: key
        ? `Scheduled, not immediate: the owner account sets this guardian only after ${span(c.delaySeconds)}, and only if the guardian is still ${c.guardian ? "the current one" : "unset"} then; any member can cancel meanwhile. From then a recovery code alone starts no recovery: the guardian's passkey must co-sign the same recovery, and a frozen passkey cannot cancel a recovery the guardian co-signed. The guardian cannot approve, cancel or stop anything. If the guardian cannot be reached, no recovery can start until the members replace it.`
        : `Scheduled, not immediate: the guardian is removed after ${span(c.delaySeconds)}; any member can cancel meanwhile. From then a recovery code alone starts a recovery again, which any member, frozen or not, can cancel.`,
    };
    return { terms, summary: key ? `Set a guardian (${id!.slice(0, 10)}…) for recoveries of the owner account, after ${span(c.delaySeconds)}.` : `Remove the guardian (${c.guardian!.slice(0, 10)}…) of the owner account, after ${span(c.delaySeconds)}.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("set-guardian", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const tx = await rail.ownerSend(ctx, 0, owner().abi);
    return recordAccountChange(ctx, tx, "set-guardian", t.guardian ? `Set the guardian to ${String(t.guardian.signerId).slice(0, 10)}…` : "Remove the guardian", { guardian: t.guardian ?? null });
  });

  // ───────────── R13: the time-lock (on at once, off after the delay) ─────────────
  rail.proposers.set("set-time-lock", async (p) => {
    owner();
    if (!options()) throw noOptions();
    if (Object.keys(p).some((k) => k !== "on") || typeof p.on !== "boolean") throw bad("set-time-lock takes { on: true | false } and nothing else.");
    const c = await current();
    if (p.on === c.timeLocked) throw new RailError("nothing_to_change", `The time-lock is already ${c.timeLocked ? "on" : "off"}. Nothing was prepared.`, 409);
    for (const ch of await pending()) if (ch.kind === "set-time-lock") throw new RailError("time_lock_change_pending", "Turning the time-lock off is already scheduled: cancel it or let it apply first. Nothing was prepared.", 409, { changeId: ch.changeId });
    const on = p.on;
    const terms = {
      ...base("set-time-lock"), on, before: { on: c.timeLocked }, immediate: on, delaySeconds: c.delaySeconds, calls: owner().lockable.map((g) => ({ target: g.target, selector: g.selector, reason: g.reason })),
      actions: [accountAction("setTimeLock", [on])],
      effect: on
        ? `At once: from the next block, withdrawing free funds, ring-fencing them for a creditor, resuming the vault after a pause and replacing the vault's guardian each wait ${span(c.delaySeconds)} (any member can cancel them meanwhile), on both vaults. Pausing, revoking mandates and payments under a signed mandate are not affected. Funding an escrow job from the vault is refused while it is on (its withdrawal would wait).`
        : `Scheduled, not immediate: turning the time-lock off removes protection, so the owner account applies it only after ${span(c.delaySeconds)}; any member can cancel it meanwhile. Until then those calls keep waiting the delay.`,
    };
    return { terms, summary: on ? "Turn the time-lock on, at once: withdraw, ring-fence, resume and the vault's guardian then wait the account's delay." : `Turn the time-lock off after ${span(c.delaySeconds)}.`, allowed: true, checks: [], replaces: [] as ProposalKind[] };
  });
  rail.handlers.set("set-time-lock", async (ctx): Promise<OpResult> => {
    const t = ctx.terms;
    const tx = await rail.ownerSend(ctx, 0, owner().abi);
    const changed = (await owner().eventsIn(tx.hash, "TimeLockChanged"))[0];
    if (changed) {
      ctx.push({ key: "receipt", label: "QEDOwnerAccount.setTimeLock mined", status: "ok", detail: `The time-lock is ${changed.args.on ? "on" : "off"} from block ${tx.blockNumber}.`, data: rail.txData(tx) });
      await refresh();
      const summary = changed.args.on ? "Turned the time-lock on: withdraw, ring-fence, resume and the vault's guardian now wait the owner account's delay." : "The time-lock is off.";
      rail.record(ctx, { kind: "signers", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
      return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { timeLocked: changed.args.on === true } };
    }
    return recordAccountChange(ctx, tx, "set-time-lock", "Turn the time-lock off", { on: t.on });
  });

  // a scheduling transaction found on the restored chain after a restart: its change is recorded, it is not sent again
  for (const kind of ["set-guardian", "set-time-lock"] as const) {
    rail.recoverers.set(kind, async (job) => {
      const found = await rail.lookupSent(job, "owner:QEDOwnerAccount." + (kind === "set-guardian" ? "setGuardian" : "setTimeLock"), "signers", kind === "set-guardian" ? "Guardian change scheduled" : "Time-lock changed");
      if (!found?.tx) return found;
      const ev = (await owner().eventsIn(found.tx.hash, "ChangeScheduled"))[0];
      if (ev) {
        const row = rail.store.job(job.id as string)!;
        const terms = parse<any>(rail.store.proposal(row.proposal_id as string)?.terms as string) ?? {};
        const data = kind === "set-guardian" ? { guardian: terms.guardian ?? null } : { on: terms.on };
        rail.store.insertScheduled({ changeId: String(ev.args.changeId).toLowerCase(), kind, summary: kind === "set-guardian" ? (terms.guardian ? "Set the guardian" : "Remove the guardian") : "Turn the time-lock off", calls: [], readyAt: Number(ev.args.readyAt), hook: { kind, data }, proposalId: String(row.proposal_id), jobId: String(job.id), at: rail.iso() });
        return { ...found, outcome: "scheduled", evidence: { changeId: String(ev.args.changeId).toLowerCase(), readyAt: Number(ev.args.readyAt), recovered: true } };
      }
      return found;
    });
  }
  for (const kind of ["remove-signers", "set-thresholds"] as const) {
    rail.recoverers.set(kind, async (job) => {
      const found = await rail.lookupSent(job, "owner:QEDOwnerAccount." + (kind === "remove-signers" ? "removeSigners" : "setThresholds"), "signers", kind === "remove-signers" ? "Removal scheduled" : "Thresholds changed");
      if (!found?.tx) return found;
      const ev = (await owner().eventsIn(found.tx.hash, "ChangeScheduled"))[0];
      if (ev) {
        const row = rail.store.job(job.id as string)!;
        const terms = parse<any>(rail.store.proposal(row.proposal_id as string)?.terms as string) ?? {};
        const data = kind === "remove-signers" ? { ids: (terms.remove ?? []).map((s: { signerId: string }) => s.signerId) } : { threshold: terms.after?.threshold, adminThreshold: terms.after?.adminThreshold };
        rail.store.insertScheduled({ changeId: String(ev.args.changeId).toLowerCase(), kind, summary: kind === "remove-signers" ? `Remove ${data.ids?.length ?? 0} signer(s)` : "Lower the thresholds", calls: [], readyAt: Number(ev.args.readyAt), hook: { kind, data }, proposalId: String(row.proposal_id), jobId: String(job.id), at: rail.iso() });
        return { ...found, outcome: "scheduled", evidence: { changeId: String(ev.args.changeId).toLowerCase(), readyAt: Number(ev.args.readyAt), recovered: true } };
      }
      return found;
    });
  }

  // ───────────── recovery: the digest a recovery key signs, and starting it ─────────────
  /** GET /recovery/digest?recoverySignerId=&x=&y=&deadline= — what the recovery key must sign for exactly this recovery. */
  async function digest(q: URLSearchParams): Promise<RecoveryDigest> {
    rail.host.requireReady();
    const o = owner();
    const rid = q.get("recoverySignerId") ?? "";
    if (!HEX32.test(rid)) throw new RailError("invalid_query", "recoverySignerId is 0x followed by 64 hexadecimal characters.", 422);
    const key = p256Key({ x: q.get("x") ?? "", y: q.get("y") ?? "" }, "The new passkey's key");
    const d = q.get("deadline") ?? "";
    const now = await rail.chainNow();
    if (!/^\d{1,12}$/.test(d) || BigInt(d) <= now || BigInt(d) > now + 86_400n) throw new RailError("invalid_query", `deadline is a time in Unix seconds after the chain's time (${now}) and at most one day later.`, 422);
    await checkRecovery(rid.toLowerCase() as Hex, key);
    const r = await current();
    const value = (await read("recoveryDigest", [rid, BigInt(key.x), BigInt(key.y), BigInt(d)])) as Hex;
    const gk = r.guardian ? r.signers.find((s) => s.signerId === r.guardian) : undefined;
    return { account: o.address, chainId: CHAIN_ID, recoverySignerId: rid.toLowerCase() as Hex, newKey: key, newSignerId: signerIdOf(BigInt(key.x), BigInt(key.y)).toLowerCase() as Hex, deadline: d, digest: value, recoveryDelaySeconds: r.recoveryDelaySeconds,
      guardian: gk ? { signerId: gk.signerId, x: gk.x, y: gk.y } : null,
      note: `The recovery key signs these 32 bytes with ECDSA P-256 over SHA-256 (WebCrypto's ECDSA with SHA-256 gives exactly that): it commits to this account on this chain, this recovery key, this new passkey and this deadline.${gk ? " This account has a guardian: its passkey must sign the same 32 bytes as a WebAuthn challenge, or the recovery does not start; a frozen member then cannot cancel it." : ""} The new passkey becomes a member after ${span(r.recoveryDelaySeconds)}, unless a member cancels.` };
  }
  /** Refuses, in words, a recovery the account would refuse: not a recovery key, one already under way, a key already a signer. */
  async function checkRecovery(rid: Hex, key: { x: Hex; y: Hex }): Promise<void> {
    const s = (await read("getSigner", [rid])) as { role: number };
    if (Number(s.role) !== ROLE.recovery) throw new RailError("not_a_recovery_key", (await read("spentRecoveryKey", [rid])) ? "That recovery key was already used or cancelled: it can start no recovery. Nothing was prepared." : "That key is not a recovery key of this vault's owner account. Nothing was prepared.", 409);
    const already = (await read("pendingRecoveryOf", [rid])) as Hex;
    if (!/^0x0+$/.test(already)) throw new RailError("recovery_pending", `A recovery with this key is already under way (${already}). Nothing was prepared.`, 409, { recoveryId: already });
    const nid = signerIdOf(BigInt(key.x), BigInt(key.y)).toLowerCase() as Hex;
    if (Number(((await read("getSigner", [nid])) as { role: number }).role) !== 0) throw new RailError("signer_exists", "That passkey is already a signer of this owner account: there is nothing to recover. Nothing was prepared.", 409);
  }
  /** Validates the body of POST /recoveries before anything is stored. */
  function recoveryParams(body: unknown): Record<string, unknown> {
    owner();
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Object.keys(b).some((k) => !["recoverySignerId", "newKey", "deadline", "signature", "cosign"].includes(k))) throw bad("A recovery takes { recoverySignerId, newKey: { x, y }, deadline, signature: { r, s }, cosign? } and nothing else (cosign: the guardian's passkey assertion over the same digest, when the account has a guardian).");
    if (typeof b.recoverySignerId !== "string" || !HEX32.test(b.recoverySignerId)) throw bad("recoverySignerId is 0x followed by 64 hexadecimal characters.");
    const key = p256Key(b.newKey, "newKey");
    if (typeof b.deadline !== "string" || !/^\d{1,12}$/.test(b.deadline)) throw bad("deadline is a time in Unix seconds, as a decimal string.");
    const sig = b.signature as Record<string, unknown> | null;
    if (!sig || typeof sig !== "object" || typeof sig.r !== "string" || typeof sig.s !== "string" || !HEX32.test(sig.r) || !HEX32.test(sig.s)) throw bad("signature is { r, s }, each 0x followed by 64 hexadecimal characters (the raw P-256 signature).");
    // the account takes only the low-s form; the other is the same signature, so the rail may normalise it
    const r = BigInt(sig.r), s0 = BigInt(sig.s), s = s0 > P256_N / 2n ? P256_N - s0 : s0;
    if (r === 0n || r >= P256_N || s === 0n) throw bad("signature is not a valid P-256 signature.");
    // R13: the guardian's assertion, as the browser returned it; checked against the digest in the handler
    if (b.cosign !== undefined && (!b.cosign || typeof b.cosign !== "object" || Array.isArray(b.cosign))) throw bad("cosign is the guardian's passkey assertion: { publicKey: { x, y }, authenticatorData, clientDataJSON, signature }.");
    return { recoverySignerId: b.recoverySignerId.toLowerCase(), newKey: key, deadline: b.deadline, signature: { r: hex32(r), s: hex32(s) }, ...(b.cosign ? { cosign: b.cosign } : {}) };
  }
  rail.handlers.set("start-recovery", async (ctx): Promise<OpResult> => {
    const o = owner(), req = ctx.request as { recoverySignerId: Hex; newKey: { x: Hex; y: Hex }; deadline: string; signature: { r: Hex; s: Hex }; cosign?: unknown };
    const refuse = (summary: string): OpResult => { ctx.push({ key: "recovery", label: "Refused before sending", status: "refused", detail: summary }); rail.record(ctx, { kind: "recovery", title: summary, outcome: "refused" }); return { outcome: "refused", summary }; };
    try { await checkRecovery(req.recoverySignerId, req.newKey); } catch (e) { if (e instanceof RailError) return refuse(e.message.replace("Nothing was prepared.", "Nothing was sent.")); throw e; }
    // R13: with a guardian, the recovery starts only with its assertion over the same digest (startCosignedRecovery)
    const guardianId = options() ? (await current()).guardian : null;
    let cosign: ContractAssertion | null = null;
    if (guardianId && !req.cosign) return refuse("This account has a guardian: the recovery starts only with the guardian's passkey signing the same recovery. Nothing was sent.");
    if (!guardianId && req.cosign) return refuse("This account has no guardian, so a co-signature does not apply: start the recovery with the code alone. Nothing was sent.");
    if (guardianId) {
      const digest = (await read("recoveryDigest", [req.recoverySignerId, BigInt(req.newKey.x), BigInt(req.newKey.y), BigInt(req.deadline)])) as Hex;
      try { cosign = assertionsFor({ assertions: [req.cosign] }, digest)[0]!; } catch (e) { if (e instanceof AssertionError) return refuse(`The guardian's co-signature is not over this recovery: ${e.message}`); throw e; }
      if (cosign.signerId.toLowerCase() !== guardianId) return refuse("That co-signature was made by a passkey that is not this account's guardian. Nothing was sent.");
    }
    const data = cosign
      ? encodeFunctionData({ abi: o.abi, functionName: "startCosignedRecovery", args: [req.recoverySignerId, BigInt(req.newKey.x), BigInt(req.newKey.y), BigInt(req.deadline), req.signature.r, req.signature.s, cosign] } as never)
      : encodeFunctionData({ abi: o.abi, functionName: "startRecovery", args: [req.recoverySignerId, BigInt(req.newKey.x), BigInt(req.newKey.y), BigInt(req.deadline), req.signature.r, req.signature.s] } as never);
    ctx.clock = await rail.align();
    const err = await o.preflight(data);
    if (err) {
      const words: Record<string, string> = {
        InvalidRecoverySignature: "The recovery key's signature does not verify for exactly this recovery: the code is not this vault's, or the signature was made for other terms. Nothing was sent.",
        Expired: "The recovery signature's deadline has passed. Ask for a new digest and sign again. Nothing was sent.",
        DeadlineTooFar: "The recovery signature's deadline is more than a day ahead: the account accepts a recovery signature only within a day of its deadline. Ask for a new digest and sign again. Nothing was sent.",
        NotARecoverySigner: "That key is not a recovery key of this vault's owner account. Nothing was sent.",
        RecoveryAlreadyPending: "A recovery with this key is already under way. Nothing was sent.",
        SignerExists: "That passkey is already a signer: there is nothing to recover. Nothing was sent.",
        InvalidPublicKey: "The new passkey's key is not a point on the P-256 curve. Nothing was sent.",
        GuardianRequired: "This account has a guardian: the recovery starts only with the guardian's co-signature. Nothing was sent.",
        NotGuardian: "That co-signature is not the guardian's. Nothing was sent.",
        InvalidAssertion: "The guardian's co-signature does not verify for exactly this recovery (another recovery, another origin, or no user verification). Nothing was sent.",
      };
      return refuse(words[err.name] ?? `The owner account refused to start this recovery: ${err.name}(${err.args.map(String).join(", ")}). Nothing was sent.`);
    }
    ctx.push({ key: "recovery", label: cosign ? "Recovery key's signature and the guardian's co-signature checked" : "Recovery key's signature checked", status: "ok", detail: cosign ? "The owner account accepts the recovery key's raw P-256 signature and the guardian's passkey assertion over the same recovery digest (simulated). No member signed this; the rail relays it and pays its gas. A frozen member cannot cancel it." : "The owner account accepts the recovery key's raw P-256 signature over its recovery digest (simulated). No member signed this; the rail relays it and pays its gas." });
    const tx = await rail.send(ctx, cosign ? "relay:QEDOwnerAccount.startCosignedRecovery" : "relay:QEDOwnerAccount.startRecovery", rail.relayer!, o.address, data);
    const ev = (await o.eventsIn(tx.hash, "RecoveryStarted"))[0];
    if (!ev) throw new RailError("recovery_not_started", `Transaction ${tx.hash} did not start the recovery. Inspect its receipt.`, 409);
    const recoveryId = String(ev.args.recoveryId).toLowerCase() as Hex, readyAt = Number(ev.args.readyAt), newSignerId = String(ev.args.newSignerId).toLowerCase();
    const summary = `Recovery: add the passkey ${newSignerId.slice(0, 10)}… as a member`;
    rail.store.insertScheduled({ changeId: recoveryId, kind: "recovery", summary, calls: [], readyAt, hook: { kind: "recovery", data: { recoverySignerId: req.recoverySignerId, newSignerId, newKey: req.newKey, ...(cosign ? { cosignedBy: guardianId } : {}) } }, proposalId: "", jobId: ctx.jobId, at: rail.iso() });
    rail.store.appendDecision({ at: rail.iso(), kind: "recovery-started", jobId: ctx.jobId, verdict: "SCHEDULED", clock: ctx.clock, record: { recoveryId, readyAt, recoverySignerId: req.recoverySignerId, newSignerId, newKey: req.newKey, deadline: req.deadline, ...(cosign ? { cosignedBy: guardianId } : {}), tx: rail.txBrief(tx) } });
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.startRecovery mined", status: "ok", detail: `Started in block ${tx.blockNumber}: the recovery key is spent; the new passkey becomes a member from ${new Date(readyAt * 1000).toISOString()} unless a member cancels (proposal kind cancel-change, change ${recoveryId}). Then anyone may finish it (POST /workspaces/${rail.id}/scheduled/${recoveryId}/apply).`, data: rail.txData(tx) });
    rail.record(ctx, { kind: "recovery", title: `${summary}: started; it can be finished from ${new Date(readyAt * 1000).toISOString()} unless a member cancels.`, outcome: "scheduled", tx: rail.txBrief(tx) });
    return { outcome: "scheduled", summary: `${summary}. Started${cosign ? ", co-signed by the guardian" : ""}: it can be finished from ${new Date(readyAt * 1000).toISOString()}; any ${cosign ? "unfrozen " : ""}member can cancel it until then.`, tx: rail.txBrief(tx), evidence: { recoveryId, readyAt, newSignerId, changeId: recoveryId, ...(cosign ? { cosignedBy: guardianId } : {}) } };
  });
  rail.recoverers.set("start-recovery", async (job) => (await rail.lookupSent(job, "relay:QEDOwnerAccount.startRecovery", "recovery", "Recovery started")) ?? rail.lookupSent(job, "relay:QEDOwnerAccount.startCosignedRecovery", "recovery", "Recovery started"));

  // ───────────── R13: freeze a member at once (the sentinel; no approval, it moves nothing) ─────────────
  /** Validates the body of POST /signers/freeze: { signerId }. */
  function freezeParams(body: unknown): Record<string, unknown> {
    owner();
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Object.keys(b).some((k) => k !== "signerId") || typeof b.signerId !== "string" || !HEX32.test(b.signerId)) throw bad("A freeze takes { signerId } and nothing else: 0x followed by 64 hexadecimal characters.");
    if (!contained()) throw new RailError("no_sentinel", "This workspace's owner account was built before R13: it has no sentinel, so nothing can freeze a member on the chain. Its removal, which waits the account's delay, is the only way to take a key away.", 409);
    return { signerId: b.signerId.toLowerCase() };
  }
  rail.handlers.set("freeze-signer", async (ctx): Promise<OpResult> => {
    const o = owner(), id = (ctx.request as { signerId: Hex }).signerId;
    const refuse = (summary: string): OpResult => { ctx.push({ key: "freeze", label: "Refused before sending", status: "refused", detail: summary }); rail.record(ctx, { kind: "signers", title: summary, outcome: "refused" }); return { outcome: "refused", summary }; };
    const c = await current();
    if (!rail.sentinel || c.sentinel !== rail.sentinel.address.toLowerCase()) return refuse("This service's sentinel key is not the owner account's sentinel (the household removed or replaced it): nothing was sent.");
    const s = c.signers.find((x) => x.signerId === id);
    if (!s || s.role !== "member") return refuse("That key is not a member of the owner account: there is nothing to freeze. Nothing was sent.");
    if (s.frozen) {
      const summary = `The member ${id.slice(0, 10)}… is already frozen on the chain; nothing was sent.`;
      rail.record(ctx, { kind: "signers", title: summary, outcome: "no-action" });
      return { outcome: "no-action", summary, evidence: { signerId: id, frozen: true } };
    }
    const data = encodeFunctionData({ abi: o.abi, functionName: "freeze", args: [id] } as never);
    ctx.clock = await rail.align();
    try { await rail.pub.call({ account: rail.sentinel.address, to: o.address, data, blockTag: "pending" } as never); } catch (e) { return refuse(`The owner account refused the freeze: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 160)}. Nothing was sent.`); }
    const tx = await rail.send(ctx, "sentinel:QEDOwnerAccount.freeze", rail.sentinel, o.address, data);
    if (!(await o.eventsIn(tx.hash, "SignerFrozen")).some((e) => String(e.args.signerId).toLowerCase() === id)) throw new RailError("freeze_not_recorded", `Transaction ${tx.hash} did not freeze the member. Inspect its receipt.`, 409);
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.freeze mined", status: "ok", detail: `Frozen in block ${tx.blockNumber}: from now this member's approval counts for no payment, mandate or change; it can still cancel a change and stop things. Only the admin quorum of unfrozen members can unfreeze it. The sentinel key that sent this can do nothing else on the account.`, data: rail.txData(tx) });
    const summary = `Froze the member ${id.slice(0, 10)}… on the chain at once: it can no longer approve anything that moves money or changes the account.`;
    rail.record(ctx, { kind: "signers", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind: "signer-frozen", jobId: ctx.jobId, verdict: "FROZEN", clock: ctx.clock, record: { signerId: id, sentinel: rail.sentinel.address, tx: rail.txBrief(tx) } });
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { signerId: id, frozen: true } };
  });
  rail.recoverers.set("freeze-signer", (job) => rail.lookupSent(job, "sentinel:QEDOwnerAccount.freeze", "signers", "Member frozen"));

  // ───────────── R13 review fix F1: the guardian withdraws its co-signature (cancels a recovery it co-signed) ─────────────
  const recoveryIdOf = (v: unknown): Hex => { if (typeof v !== "string" || !HEX32.test(v)) throw bad("A recovery is named by its id: 0x followed by 64 hexadecimal characters."); return v.toLowerCase() as Hex; };
  /** GET /recoveries/:recoveryId/withdraw-digest: the challenge the guardian's passkey signs to withdraw its co-signature. */
  async function withdrawDigest(recoveryId: unknown) {
    const id = recoveryIdOf(recoveryId), o = owner();
    if (!options()) throw new RailError("owner_options_unavailable", "This workspace's owner account was set up before guardians existed: there is no co-signature to withdraw.", 409);
    const r = (await read("getRecovery", [id])) as { readyAt: bigint; cosigned: boolean };
    if (r.readyAt === 0n) throw new RailError("change_not_pending", "The owner account holds no such pending recovery (it finished or was cancelled).", 409);
    if (!r.cosigned) throw new RailError("not_cosigned", "The guardian did not co-sign this recovery, so it cannot withdraw it; any member can cancel it.", 409);
    return { account: o.address, chainId: CHAIN_ID, recoveryId: id, digest: (await read("cancelDigest", [id])) as Hex, guardian: (await current()).guardian, note: "The guardian's passkey signs these 32 bytes as a WebAuthn challenge (the account's cancel digest for this recovery). The account then drops the recovery and spends its recovery key; nothing else can be cancelled with it." };
  }
  /** Validates POST /recoveries/:recoveryId/withdraw: { assertion }, the guardian's passkey assertion over the withdraw digest. */
  function withdrawParams(recoveryId: unknown, body: unknown): Record<string, unknown> {
    owner();
    const id = recoveryIdOf(recoveryId);
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "assertion") || !b.assertion || typeof b.assertion !== "object") throw bad("A withdrawal takes { assertion } and nothing else: the guardian's passkey assertion over the account's cancel digest for this recovery.");
    return { recoveryId: id, assertion: b.assertion };
  }
  rail.handlers.set("guardian-withdraw", async (ctx): Promise<OpResult> => {
    const o = owner(), req = ctx.request as { recoveryId: Hex; assertion: unknown };
    const refuse = (summary: string): OpResult => {
      ctx.push({ key: "withdraw", label: "Refused", status: "refused", detail: summary });
      rail.record(ctx, { kind: "recovery", title: summary, outcome: "refused" });
      return { outcome: "refused", summary };
    };
    if (!options()) return refuse("This workspace's owner account was set up before guardians existed: there is no co-signature to withdraw. Nothing was sent.");
    const r = (await read("getRecovery", [req.recoveryId])) as { readyAt: bigint; cosigned: boolean };
    if (r.readyAt === 0n) return refuse("The owner account holds no such pending recovery (it finished or was cancelled). Nothing was sent.");
    if (!r.cosigned) return refuse("The guardian did not co-sign this recovery, so it cannot withdraw it; any member can cancel it. Nothing was sent.");
    const guardianId = (await current()).guardian;
    if (!guardianId) return refuse("This account has no guardian now. Nothing was sent.");
    const digest = (await read("cancelDigest", [req.recoveryId])) as Hex;
    let a: ContractAssertion;
    try { a = assertionsFor({ assertions: [req.assertion] }, digest)[0]!; } catch (e) { if (e instanceof AssertionError) return refuse(`The guardian's assertion is not over this withdrawal: ${e.message}`); throw e; }
    if (a.signerId.toLowerCase() !== guardianId) return refuse("That assertion was made by a passkey that is not this account's guardian. Nothing was sent.");
    const data = encodeFunctionData({ abi: o.abi, functionName: "cancel", args: [req.recoveryId, a] } as never);
    ctx.clock = await rail.align();
    const err = await o.preflight(data);
    if (err) return refuse(`The owner account refused the withdrawal: ${err.name}(${err.args.map(String).join(", ")}). Nothing was sent.`);
    const tx = await rail.send(ctx, "relay:QEDOwnerAccount.cancel(guardian)", rail.relayer!, o.address, data);
    if (!(await o.eventsIn(tx.hash, "RecoveryCancelled")).some((e) => String(e.args.recoveryId).toLowerCase() === req.recoveryId)) throw new RailError("withdraw_not_recorded", `Transaction ${tx.hash} did not cancel the recovery. Inspect its receipt.`, 409);
    if (rail.store.scheduled(req.recoveryId)) rail.store.finishScheduled(req.recoveryId, "cancelled", ctx.jobId, rail.iso());
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.cancel mined", status: "ok", detail: `The guardian withdrew its co-signature in block ${tx.blockNumber}: the recovery is dropped and the recovery key that started it is spent.`, data: rail.txData(tx) });
    const summary = `The guardian withdrew its co-signature: the recovery ${req.recoveryId.slice(0, 10)}… is cancelled and its recovery key spent.`;
    rail.record(ctx, { kind: "recovery", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind: "recovery-withdrawn", jobId: ctx.jobId, verdict: "CANCELLED", clock: ctx.clock, record: { recoveryId: req.recoveryId, guardian: guardianId, tx: rail.txBrief(tx) } });
    await refresh();
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { recoveryId: req.recoveryId, withdrawnBy: guardianId } };
  });
  rail.recoverers.set("guardian-withdraw", (job) => rail.lookupSent(job, "relay:QEDOwnerAccount.cancel(guardian)", "recovery", "Co-signature withdrawn"));

  // ───────────── R13 H1: the sentinel stops a pending co-signed recovery (the owner's way to challenge it through QED) ─────────────
  /** Validates POST /recoveries/:recoveryId/stop: {}. The server decides who may ask; this wallet's sentinel key sends it. */
  function stopParams(recoveryId: unknown, body: unknown): Record<string, unknown> {
    owner();
    const id = recoveryIdOf(recoveryId);
    if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) throw bad("Stopping a recovery takes {} and nothing else.");
    return { recoveryId: id };
  }
  rail.handlers.set("sentinel-stop", async (ctx): Promise<OpResult> => {
    const o = owner(), req = ctx.request as { recoveryId: Hex };
    const refuse = (summary: string): OpResult => {
      ctx.push({ key: "stop", label: "Refused", status: "refused", detail: summary });
      rail.record(ctx, { kind: "recovery", title: summary, outcome: "refused" });
      return { outcome: "refused", summary };
    };
    if (!(o.abi as readonly { type: string; name?: string }[]).some((x) => x.type === "function" && x.name === "stopRecovery")) return refuse("This wallet's owner account was set up before QED could stop a recovery: a passkey that is not frozen can cancel it, and the guardian can withdraw its co-signature. Nothing was sent.");
    const onChain = String(await read("sentinel")).toLowerCase(), sk = rail.sentinel;
    if (!sk || onChain !== sk.address.toLowerCase()) return refuse(/^0x0{40}$/.test(onChain) ? "This account has no sentinel now, so QED cannot stop the recovery: a passkey that is not frozen can cancel it, and the guardian can withdraw its co-signature. Nothing was sent." : "This account's sentinel is not this wallet service's key, so QED cannot stop the recovery. Nothing was sent.");
    const r = (await read("getRecovery", [req.recoveryId])) as { readyAt: bigint; cosigned: boolean };
    if (r.readyAt === 0n) return refuse("The owner account holds no such pending recovery (it finished or was cancelled). Nothing was sent.");
    if (!r.cosigned) return refuse("The guardian did not co-sign this recovery: any member, frozen or not, can cancel it, and QED stops only a recovery the guardian co-signed. Nothing was sent.");
    const data = encodeFunctionData({ abi: o.abi, functionName: "stopRecovery", args: [req.recoveryId] } as never);
    ctx.clock = await rail.align();
    try { await rail.pub.call({ account: sk.address, to: o.address, data, blockTag: "pending" } as never); } catch (e) { return refuse(`The owner account refused to stop it: ${String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 160)}. Nothing was sent.`); }
    const tx = await rail.send(ctx, "sentinel:QEDOwnerAccount.stopRecovery", sk, o.address, data);
    if (!(await o.eventsIn(tx.hash, "RecoveryCancelled")).some((e) => String(e.args.recoveryId).toLowerCase() === req.recoveryId)) throw new RailError("stop_not_recorded", `Transaction ${tx.hash} did not stop the recovery. Inspect its receipt.`, 409);
    if (rail.store.scheduled(req.recoveryId)) rail.store.finishScheduled(req.recoveryId, "cancelled", ctx.jobId, rail.iso());
    ctx.push({ key: "receipt", label: "QEDOwnerAccount.stopRecovery mined", status: "ok", detail: `Stopped in block ${tx.blockNumber} with this wallet's sentinel key: the recovery is dropped and the recovery key that started it is spent. The sentinel key can stop only a recovery the guardian co-signed, and can approve or move nothing.`, data: rail.txData(tx) });
    const summary = `QED stopped the recovery ${req.recoveryId.slice(0, 10)}… with this wallet's sentinel key: it is cancelled and its recovery key spent.`;
    rail.record(ctx, { kind: "recovery", title: summary, outcome: "executed", tx: rail.txBrief(tx) });
    rail.store.appendDecision({ at: rail.iso(), kind: "recovery-stopped", jobId: ctx.jobId, verdict: "CANCELLED", clock: ctx.clock, record: { recoveryId: req.recoveryId, sentinel: sk.address, tx: rail.txBrief(tx) } });
    await refresh();
    return { outcome: "executed", summary, tx: rail.txBrief(tx), evidence: { recoveryId: req.recoveryId, stoppedBy: sk.address } };
  });
  rail.recoverers.set("sentinel-stop", (job) => rail.lookupSent(job, "sentinel:QEDOwnerAccount.stopRecovery", "recovery", "Recovery stopped"));

  // after the delay: the account itself changed; refresh the view and the host's record of every signer (R7 D7)
  rail.applyHooks.set("remove-signers", async () => { await refresh(); return "The removed keys are no longer signers."; });
  rail.applyHooks.set("set-thresholds", async (_ctx, d) => { await refresh(); return `The thresholds are now ${d.threshold} and ${d.adminThreshold}.`; });
  rail.applyHooks.set("recovery", async (_ctx, d) => { await refresh(); return `The passkey ${String(d.newSignerId).slice(0, 10)}… is now a member; the recovery key that started it is gone.`; });
  rail.applyHooks.set("set-guardian", async (_ctx, d) => { await refresh(); return d.guardian ? `The guardian is now ${String(d.guardian.signerId).slice(0, 10)}…: recoveries need its co-signature.` : "The account has no guardian: a recovery code alone starts a recovery again."; });
  rail.applyHooks.set("set-time-lock", async () => { await refresh(); return "The time-lock is off: withdraw, ring-fence, resume and the vault's guardian run at once again."; });

  return { view, refresh, digest, recoveryParams, freezeParams, withdrawDigest, withdrawParams, stopParams, current };
}

