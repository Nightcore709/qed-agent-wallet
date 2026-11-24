/**
 * RISK-053 on the rail: a workspace's signers and recovery through QEDOwnerAccount's own mechanisms, on a real local
 * chain (the owner-account build chain/accounts/READY.json declares; delays of 60 s; an injected wall clock moves past
 * them and the chain follows it forward, as test/workspaces.test.ts does):
 *   - adding a member passkey needs the admin threshold's assertions over the exact execute digest and is immediate
 *     (the contract makes it so); a passkey that is not yet a member cannot add itself; the same key twice is refused;
 *   - removing a signer is scheduled; it is refused before the delay and applied after it; the passkey it removes
 *     cannot cancel it, another member can; the rail and, independently, the account refuse a removal that would leave
 *     fewer members than the admin threshold (so never zero);
 *   - raising a threshold is immediate; lowering one is scheduled, cancellable by one member, applied after the delay;
 *   - a recovery key derived from a recovery code (chain/accounts RecoveryKey): added at once; another code's signature
 *     is refused with nothing sent; the right one starts a recovery that is finished only after the recovery delay,
 *     and then the new passkey signs; a second recovery is cancelled by a member, which spends its key;
 *   - R7 D7: a key that was ever a signer of two workspaces keeps them linked in the authority budget's principal set
 *     after it is removed from one; links the wallet declares are kept on both sides and are only ever added.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { generateRecoveryCode, RecoveryKey } from "../accounts/webauthn.ts";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { toContractAssertion } from "../rail/webauthn.ts";
import type { Rail } from "../rail/host.ts";
import type { Job } from "../types.ts";

const hex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
let offset = 0;
let t: TestHost, W: Rail;
const laptop = new SoftwarePasskey(), phone = new SoftwarePasskey();
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string, words?: RegExp) => (e: { code?: string; message?: string }) => e.code === code && (!words || words.test(e.message ?? ""));
const apply = async (ws: Rail, changeId: Hex) => ws.waitForJob(ws.submit("apply-change", ws.applyParams(changeId), key()).jobId);
const pendingOf = async (ws: Rail, kind: string) => (await ws.scheduled()).filter((c) => c.kind === kind && c.status === "pending");

before(async () => {
  const port = Number(process.env.QED_TEST_ANVIL_PORT ?? 9351);
  t = await startHost("signers", port, { economyAnvilPort: port + 1, wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000 });
  W = await t.workspace("sig-home", [laptop]);
  ok(await t.act(W, "provision", {}, [laptop]));
});
after(async () => { await t?.stop(); });

test("adding a member passkey: the admin threshold signs the exact digest, it applies at once, and the new passkey then signs alone", async () => {
  const v0 = await W.signers.view();
  assert.deepEqual([v0.memberCount, v0.threshold, v0.adminThreshold, v0.delaySeconds, v0.recoveryDelaySeconds], [1, 1, 1, 60, 60]);
  const params = { x: phone.publicKey.x, y: phone.publicKey.y, role: "member" };
  // the phone cannot add itself: it is not a member yet, and the account checks that on chain before anything is stored
  const p = await W.propose({ kind: "add-signer", params });
  const toSign = (p.terms.toSign as { kind: string; threshold: number; calls: { action: string }[] }[])[0];
  assert.deepEqual([toSign.kind, toSign.threshold, toSign.calls.map((c) => c.action)], ["execute", 1, ["QEDOwnerAccount.addSigner"]]);
  await assert.rejects(() => W.executeChecked(p.id, passkeyApproval(p, [phone], W.now()), key()), refusal("approval_signature_invalid", /NotAMember/));
  // the laptop (the current admin threshold) adds it: immediate
  const added = await t.act(W, "add-signer", params, [laptop]);
  ok(added);
  assert.equal((added.result!.evidence as { role: string }).role, "member");
  const v1 = await W.signers.view();
  assert.deepEqual([v1.memberCount, v1.signers.map((s) => s.role).sort()], [2, ["member", "member"]]);
  assert.deepEqual(W.view().signers.length, 2, "the workspace view follows the chain");
  // the new passkey acts alone (threshold 1), and the same key cannot be added twice
  ok(await t.act(W, "pause", {}, [phone]));
  ok(await t.act(W, "resume", {}, [phone]));
  await assert.rejects(() => W.propose({ kind: "add-signer", params }), refusal("signer_exists"));
});

test("thresholds: raising is immediate; lowering is scheduled, one member cancels it, and it applies only after the delay", async () => {
  ok(await t.act(W, "set-thresholds", { threshold: 2, adminThreshold: 2 }, [laptop]));
  assert.deepEqual([(await W.signers.view()).threshold, (await W.signers.view()).adminThreshold], [2, 2]);
  // one passkey alone is no longer enough
  const lone = await W.propose({ kind: "pause", params: {} });
  await assert.rejects(() => W.executeChecked(lone.id, passkeyApproval(lone, [laptop], W.now()), key()), refusal("approval_signature_invalid", /NotEnoughApprovals/));
  W.cancelProposal(lone.id);
  // lowering needs both (admin threshold 2) and waits
  ok(await t.act(W, "set-thresholds", { threshold: 1, adminThreshold: 1 }, [laptop, phone]), "scheduled");
  let [low] = await pendingOf(W, "set-thresholds");
  assert.ok(low, "listed as a pending change");
  ok(await t.act(W, "cancel-change", { changeId: low.changeId }, [phone]));
  assert.equal((await W.scheduled()).find((c) => c.changeId === low.changeId)!.status, "cancelled");
  ok(await t.act(W, "set-thresholds", { threshold: 1, adminThreshold: 1 }, [laptop, phone]), "scheduled");
  [low] = await pendingOf(W, "set-thresholds");
  ok(await apply(W, low.changeId), "refused");
  offset += 61_000;
  ok(await apply(W, low.changeId));
  assert.deepEqual([(await W.signers.view()).threshold, (await W.signers.view()).adminThreshold], [1, 1]);
});

test("removing a signer: scheduled; the passkey it removes cannot cancel it; refused before the delay, applied after; never below the admin threshold", async () => {
  const laptopId = (await W.signers.view()).signers.find((s) => s.x === laptop.publicKey.x.toLowerCase())!.signerId;
  const phoneId = (await W.signers.view()).signers.find((s) => s.x === phone.publicKey.x.toLowerCase())!.signerId;
  // R13 review fix F2: with the phone the only other member, nobody but the remover could cancel it: refused, by the rail
  // and by the account itself; a third passkey counts once it has been a member for the delay
  await assert.rejects(() => W.propose({ kind: "remove-signers", params: { signerIds: [laptopId] } }), refusal("no_canceller_left", /freeze the passkey first/i));
  {
    const acct = W.a.ownerAccount!, abi = (W.owner as any).abi;
    const calls = [{ target: acct, value: 0n, data: encodeFunctionData({ abi, functionName: "removeSigners", args: [[laptopId]] }) }];
    const nonce = (await W.read(acct, abi, "nonce")) as bigint, deadline = BigInt(Math.floor(W.now() / 1000) + 600);
    const digest = (await W.read(acct, abi, "executeDigest", [calls, nonce, deadline])) as Hex;
    const err = await (W.owner as any).preflight(encodeFunctionData({ abi, functionName: "execute", args: [calls, nonce, deadline, [toContractAssertion(phone.assert(digest))]] }));
    assert.deepEqual([err?.name, err?.inner?.name], ["CallFailed", "NoCancellerLeft"], "the account refuses it itself");
  }
  const tablet = new SoftwarePasskey();
  ok(await t.act(W, "add-signer", { x: tablet.publicKey.x, y: tablet.publicKey.y, role: "member" }, [phone]));
  const tabletId = (await W.signers.view()).signers.find((s) => s.x === tablet.publicKey.x.toLowerCase())!.signerId;
  await assert.rejects(() => W.propose({ kind: "remove-signers", params: { signerIds: [laptopId] } }), refusal("no_canceller_left"));
  offset += 61_000;
  const sch = await t.act(W, "remove-signers", { signerIds: [laptopId] }, [phone]);
  ok(sch, "scheduled");
  const [rm] = await pendingOf(W, "remove-signers");
  assert.equal(rm.changeId, (sch.result!.evidence as { changeId: string }).changeId);
  assert.equal((await W.signers.view()).signers.find((s) => s.signerId === laptopId)!.pendingRemoval, rm.changeId);
  await assert.rejects(() => W.propose({ kind: "remove-signers", params: { signerIds: [laptopId] } }), refusal("removal_already_scheduled"));
  // the laptop cannot cancel its own removal (a stolen passkey cannot veto it); it still works until the removal applies
  const c = await W.propose({ kind: "cancel-change", params: { changeId: rm.changeId } });
  await assert.rejects(() => W.executeChecked(c.id, passkeyApproval(c, [laptop], W.now()), key()), refusal("cannot_cancel_own_removal"));
  W.cancelProposal(c.id);
  ok(await t.act(W, "pause", {}, [laptop]));
  ok(await t.act(W, "resume", {}, [laptop]));
  ok(await apply(W, rm.changeId), "refused");
  offset += 61_000;
  ok(await apply(W, rm.changeId));
  const v = await W.signers.view();
  assert.deepEqual([v.memberCount, v.signers.map((s) => s.signerId).sort()], [2, [phoneId, tabletId].sort()]);
  const gone = await W.propose({ kind: "pause", params: {} });
  await assert.rejects(() => W.executeChecked(gone.id, passkeyApproval(gone, [laptop], W.now()), key()), refusal("approval_signature_invalid", /NotAMember/));
  W.cancelProposal(gone.id);
  // the last members cannot be removed: the rail refuses, and so does the account itself, whoever relays it
  const both = [phoneId, tabletId].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  await assert.rejects(() => W.propose({ kind: "remove-signers", params: { signerIds: both } }), refusal("would_break_quorum"));
  const acct = W.a.ownerAccount!, abi = (W.owner as any).abi;
  const calls = [{ target: acct, value: 0n, data: encodeFunctionData({ abi, functionName: "removeSigners", args: [both] }) }];
  const nonce = (await W.read(acct, abi, "nonce")) as bigint, deadline = BigInt(Math.floor(W.now() / 1000) + 600);
  const digest = (await W.read(acct, abi, "executeDigest", [calls, nonce, deadline])) as Hex;
  const err = await (W.owner as any).preflight(encodeFunctionData({ abi, functionName: "execute", args: [calls, nonce, deadline, [toContractAssertion(phone.assert(digest))]] }));
  assert.deepEqual([err?.name, err?.inner?.name], ["CallFailed", "InvalidThresholds"], "the account refuses it itself");
});

test("a recovery key from a recovery code: added at once; another code is refused with nothing sent; the right one adds the new passkey only after the recovery delay; a member's cancel spends a key", async () => {
  const code = generateRecoveryCode(), rk = new RecoveryKey(code);
  ok(await t.act(W, "add-signer", { x: hex(rk.x), y: hex(rk.y), role: "recovery" }, [phone]));
  const rid = rk.signerId.toLowerCase();
  assert.equal((await W.signers.view()).signers.find((s) => s.signerId === rid)?.role, "recovery");
  // the phone is lost; a new passkey on another device
  const fresh = new SoftwarePasskey();
  const deadline = String(Math.floor(W.now() / 1000) + 600);
  const q = new URLSearchParams({ recoverySignerId: rid, x: fresh.publicKey.x, y: fresh.publicKey.y, deadline });
  const d = await W.signers.digest(q);
  assert.equal(d.recoveryDelaySeconds, 60);
  // a signature by another code's key is refused before anything is sent
  const wrong = new RecoveryKey(generateRecoveryCode()).signDigest(d.digest);
  const bad = await W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rid, newKey: fresh.publicKey, deadline, signature: wrong }), key()).jobId);
  ok(bad, "refused");
  assert.match(bad.result!.summary, /does not verify/);
  // the right code starts it; nothing is added before the delay
  const started = await W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rid, newKey: fresh.publicKey, deadline, signature: rk.signDigest(d.digest) }), key()).jobId);
  ok(started, "scheduled");
  const recoveryId = (started.result!.evidence as { recoveryId: Hex }).recoveryId;
  assert.deepEqual((await pendingOf(W, "recovery")).map((c) => c.changeId), [recoveryId]);
  await assert.rejects(() => W.signers.digest(q), refusal("recovery_pending"), "one recovery per key at a time");
  ok(await apply(W, recoveryId), "refused");
  assert.equal((await W.signers.view()).memberCount, 2, "the phone and the tablet (the removal test's third passkey, R13 review fix F2)");
  offset += 61_000;
  ok(await apply(W, recoveryId));
  const v = await W.signers.view();
  assert.deepEqual([v.memberCount, v.signers.some((s) => s.signerId === rid)], [3, false], "the new passkey is a member; the recovery key is gone");
  ok(await t.act(W, "pause", {}, [fresh]));
  ok(await t.act(W, "resume", {}, [fresh]));
  // a second recovery key, used by someone else: the member cancels the recovery, which spends the key
  const rk2 = new RecoveryKey(generateRecoveryCode());
  ok(await t.act(W, "add-signer", { x: hex(rk2.x), y: hex(rk2.y), role: "recovery" }, [fresh]));
  const thief = new SoftwarePasskey();
  const d2 = await W.signers.digest(new URLSearchParams({ recoverySignerId: rk2.signerId, x: thief.publicKey.x, y: thief.publicKey.y, deadline }));
  const s2 = await W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rk2.signerId, newKey: thief.publicKey, deadline, signature: rk2.signDigest(d2.digest) }), key()).jobId);
  ok(s2, "scheduled");
  const r2 = (s2.result!.evidence as { recoveryId: Hex }).recoveryId;
  ok(await t.act(W, "cancel-change", { changeId: r2 }, [fresh]));
  const abi = (W.owner as any).abi, acct = W.a.ownerAccount!;
  assert.equal(Number(((await W.read(acct, abi, "getSigner", [rk2.signerId])) as { role: number }).role), 0, "the cancelled recovery's key is removed");
  assert.equal(await W.read(acct, abi, "spentRecoveryKey", [rk2.signerId]), true, "and can never be a recovery key again");
  offset += 61_000;
  ok(await apply(W, r2), "no-action");
  assert.equal((await W.signers.view()).signers.some((s) => s.x === thief.publicKey.x.toLowerCase()), false, "the thief's key never became a signer");
});

test("R7 D7: a key that was ever a signer of two workspaces keeps them linked after it leaves one; declared links are kept both ways and only added", async () => {
  const other = new SoftwarePasskey(), stranger = new SoftwarePasskey();
  const X = await t.workspace("sig-shop", [other]), Y = await t.workspace("sig-stranger", [stranger]);
  for (const [ws, k] of [[X, other], [Y, stranger]] as const) ok(await t.act(ws, "provision", {}, [k]));
  const P = (id: string) => new Set(t.host.d7ConfigOf(id)!.principal.map((a) => getAddress(a)));
  assert.equal(P("sig-home").has(getAddress(X.a.vault)), false, "not linked yet");
  // the shop's passkey joins the home vault (signed by the phone, still a member), then leaves it again
  ok(await t.act(W, "add-signer", { x: other.publicKey.x, y: other.publicKey.y, role: "member" }, [phone]));
  assert.equal(P("sig-home").has(getAddress(X.a.vault)), true, "linked while it is a signer of both");
  const otherId = (await W.signers.view()).signers.find((s) => s.x === other.publicKey.x.toLowerCase())!.signerId;
  ok(await t.act(W, "remove-signers", { signerIds: [otherId] }, [phone]), "scheduled");
  offset += 61_000;
  ok(await apply(W, (await pendingOf(W, "remove-signers"))[0].changeId));
  assert.equal((await W.signers.view()).signers.some((s) => s.signerId === otherId), false);
  assert.equal(P("sig-home").has(getAddress(X.a.vault)), true, "still linked: the same person held a key of both");
  assert.equal(P("sig-shop").has(getAddress(W.a.vault)), true, "both ways");
  // a link the wallet declares (a member in common): kept on both sides, idempotent, never removed
  assert.equal(P("sig-home").has(getAddress(Y.a.vault)), false);
  const first = await t.host.addLinks("sig-home", ["sig-stranger", "nobody-here"]);
  assert.deepEqual([first.added, first.unknown], [["sig-stranger"], ["nobody-here"]]);
  assert.equal(P("sig-home").has(getAddress(Y.a.vault)), true);
  assert.equal(P("sig-stranger").has(getAddress(W.a.vault)), true);
  assert.deepEqual((await t.host.addLinks("sig-stranger", ["sig-home"])).added, [], "already linked: nothing added");
  assert.ok((await t.host.addLinks("sig-home", [])).linked.includes("sig-stranger"), "an empty list removes nothing");
});
