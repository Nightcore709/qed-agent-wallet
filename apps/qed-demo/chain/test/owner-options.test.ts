/**
 * R13 owner options on the rail, on a real local chain (the owner-account build chain/accounts/READY.json declares;
 * delays of 60 s; an injected wall clock moves past them and the chain follows it forward, as test/signers.test.ts does).
 * Anvil on 127.0.0.1, ports 12883 and 12884 (or QED_TEST_ANVIL_PORT and the next), stopped by the test.
 *   - the time-lock, chosen at setup: withdraw, ring-fence and resume are scheduled behind the account's delay instead
 *     of running at once; any one member cancels; once due anyone applies them and the vault checks them then; funding
 *     an escrow job from the vault is refused with the reason; off waits the delay, on is immediate, and without it the
 *     same withdrawal runs at once;
 *   - the guardian: set only behind the delay; while it is set, a recovery starts only with its passkey's co-signature
 *     over the same recovery (another passkey's, or none, is refused with nothing sent); a passkey QED froze cannot
 *     cancel a recovery the guardian co-signed; removing the guardian waits the delay too, and then a code alone starts
 *     a recovery again.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { generateRecoveryCode, RecoveryKey } from "../accounts/webauthn.ts";
import { key, startHost, type TestHost } from "./helpers.ts";
import { passkeyApproval, RP_ID_HASH, SoftwarePasskey } from "./passkey.ts";
import { signerIdOf } from "../rail/webauthn.ts";
import type { Rail } from "../rail/host.ts";
import type { Job } from "../types.ts";

const hex = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
let offset = 0;
let t: TestHost;
const port = Number(process.env.QED_TEST_ANVIL_PORT ?? 12883);
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string, words?: RegExp) => (e: { code?: string; message?: string }) => e.code === code && (!words || words.test(e.message ?? ""));
const apply = async (ws: Rail, changeId: Hex) => ws.waitForJob(ws.submit("apply-change", ws.applyParams(changeId), key()).jobId);
const pendingOf = async (ws: Rail, kind: string) => (await ws.scheduled()).filter((c) => c.kind === kind && c.status === "pending");
const free = async (ws: Rail) => BigInt((await ws.snap(ws.a.vault)).freeBalance);
const paused = async (ws: Rail) => (await ws.read(ws.a.vault, ws.v.abi.QEDVaultAbi, "paused")) as boolean;
const idOf = (k: SoftwarePasskey) => signerIdOf(BigInt(k.publicKey.x), BigInt(k.publicKey.y)).toLowerCase() as Hex;

before(async () => {
  t = await startHost("owner-options", port, { economyAnvilPort: port + 1, wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000 });
});
after(async () => { await t?.stop(); });

test("the time-lock chosen at setup: withdraw, ring-fence and resume wait the delay and any member cancels; escrow funding is refused; off waits, on is immediate", async () => {
  const laptop = new SoftwarePasskey(), phone = new SoftwarePasskey();
  await t.host.createWorkspace({ workspaceId: "tl-home", owner: { signers: [laptop.publicKey, phone.publicKey], threshold: 1, adminThreshold: 1 }, rpIdHash: RP_ID_HASH, timeLock: true });
  const W = t.host.workspace("tl-home")!;
  ok(await t.act(W, "provision", {}, [laptop]));
  const v = await W.signers.view();
  assert.deepEqual([v.timeLock.supported, v.timeLock.on, v.timeLock.calls.length, v.guardian.supported, v.guardian.signerId], [true, true, 8, true, null]);
  assert.ok(v.rules.some((r) => /time-lock is on/.test(r)));

  // withdraw: the terms say it is scheduled; nothing leaves the vault until it is applied
  const five = W.raw("5", "amount");
  const before0 = await free(W);
  const p = await W.propose({ kind: "withdraw", params: { amount: "5" } });
  const ex = (p.terms.toSign as { kind: string; timeLocked?: boolean; schedule?: { calls: { action: string }[] } }[])[0]!;
  assert.deepEqual([ex.timeLocked, ex.schedule?.calls.map((c) => c.action)], [true, ["QEDVault (treasury).withdraw"]]);
  const accepted = await W.executeChecked(p.id, passkeyApproval(p, [laptop], W.now()), key());
  ok(await W.waitForJob(accepted.jobId), "scheduled");
  assert.equal(await free(W), before0, "nothing left yet");
  const [wd] = await pendingOf(W, "withdraw");
  ok(await apply(W, wd!.changeId), "refused");
  offset += 61_000;
  ok(await apply(W, wd!.changeId));
  assert.equal(before0 - (await free(W)), five, "withdrawn after the delay");

  // a second one, cancelled by the other passkey: it never runs
  ok(await t.act(W, "withdraw", { amount: "5" }, [laptop]), "scheduled");
  const [wd2] = await pendingOf(W, "withdraw");
  ok(await t.act(W, "cancel-change", { changeId: wd2!.changeId }, [phone]));
  offset += 61_000;
  ok(await apply(W, wd2!.changeId), "no-action");
  assert.equal(before0 - (await free(W)), five, "the cancelled withdrawal never ran");

  // ring-fence: scheduled as well
  ok(await t.act(W, "ring-fence", { creditor: "CloudCo", amount: "3", dueInDays: 7 }, [laptop]), "scheduled");
  assert.equal((await pendingOf(W, "ring-fence")).length, 1);

  // pause stays immediate; resume waits the delay
  ok(await t.act(W, "pause", {}, [phone]));
  assert.equal(await paused(W), true);
  ok(await t.act(W, "resume", {}, [laptop]), "scheduled");
  assert.equal(await paused(W), true, "still paused until applied");
  const [rs] = await pendingOf(W, "resume");
  offset += 61_000;
  ok(await apply(W, rs!.changeId));
  assert.equal(await paused(W), false);

  // escrow funding from the vault would need an immediate withdrawal: refused with the reason, nothing prepared
  await assert.rejects(() => W.propose({ kind: "escrow-fund", params: {} }), refusal("time_locked", /time-lock is on/));

  // off: scheduled behind the delay (one member can cancel); on: at once
  ok(await t.act(W, "set-time-lock", { on: false }, [laptop]), "scheduled");
  const [off] = await pendingOf(W, "set-time-lock");
  assert.equal((await W.signers.view()).timeLock.on, true, "still on until it applies");
  await assert.rejects(() => W.propose({ kind: "set-time-lock", params: { on: false } }), refusal("time_lock_change_pending"));
  offset += 61_000;
  ok(await apply(W, off!.changeId));
  assert.equal((await W.signers.view()).timeLock.on, false);
  const before1 = await free(W);
  ok(await t.act(W, "withdraw", { amount: "5" }, [laptop]), "executed");
  assert.equal(before1 - (await free(W)), five, "without the time-lock it runs at once");
  ok(await t.act(W, "set-time-lock", { on: true }, [phone]), "executed");
  assert.equal((await W.signers.view()).timeLock.on, true, "on at once");
  await assert.rejects(() => W.propose({ kind: "set-time-lock", params: { on: true } }), refusal("nothing_to_change"));
});

test("the guardian: set behind the delay; a recovery needs its co-signature; a frozen passkey cannot cancel a co-signed recovery; removing it waits too", async () => {
  const laptop = new SoftwarePasskey(), phone = new SoftwarePasskey(), contact = new SoftwarePasskey();
  // two devices, both needed (design D-l), and a recovery code
  await t.host.createWorkspace({ workspaceId: "gd-home", owner: { signers: [laptop.publicKey, phone.publicKey], threshold: 2, adminThreshold: 2 }, rpIdHash: RP_ID_HASH });
  const W = t.host.workspace("gd-home")!;
  ok(await t.act(W, "provision", {}, [laptop, phone]));
  const rk = new RecoveryKey(generateRecoveryCode());
  ok(await t.act(W, "add-signer", { x: hex(rk.x), y: hex(rk.y), role: "recovery" }, [laptop, phone]));
  const rid = rk.signerId.toLowerCase() as Hex;

  // a member's own passkey cannot be the guardian; the contact's is scheduled, not set
  await assert.rejects(() => W.propose({ kind: "set-guardian", params: phone.publicKey }), refusal("signer_exists"));
  ok(await t.act(W, "set-guardian", contact.publicKey, [laptop, phone]), "scheduled");
  assert.equal((await W.signers.view()).guardian.signerId, null, "nothing at once");
  await assert.rejects(() => W.propose({ kind: "set-guardian", params: contact.publicKey }), refusal("guardian_change_pending"));
  const [sg] = await pendingOf(W, "set-guardian");
  ok(await apply(W, sg!.changeId), "refused");
  offset += 61_000;
  ok(await apply(W, sg!.changeId));
  let v = await W.signers.view();
  assert.deepEqual([v.guardian.signerId, v.signers.find((s) => s.signerId === idOf(contact))?.role, v.memberCount], [idOf(contact), "guardian", 2]);

  // the phone is stolen: QED suspends it and the sentinel freezes it; the laptop alone cannot reach threshold 2
  ok(await W.waitForJob(W.submit("freeze-signer", W.signers.freezeParams({ signerId: idOf(phone) }), key()).jobId));
  const fresh = new SoftwarePasskey();
  const deadline = String(Math.floor(W.now() / 1000) + 600);
  const d = await W.signers.digest(new URLSearchParams({ recoverySignerId: rid, x: fresh.publicKey.x, y: fresh.publicKey.y, deadline }));
  assert.equal(d.guardian?.signerId, idOf(contact), "the digest names the guardian that must co-sign it");
  const start = (extra: Record<string, unknown>) => W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rid, newKey: fresh.publicKey, deadline, signature: rk.signDigest(d.digest), ...extra }), key()).jobId);
  // the code alone: refused, nothing sent, the code not spent
  const alone = await start({});
  ok(alone, "refused");
  assert.match(alone.result!.summary, /has a guardian/);
  // another passkey's co-signature (the laptop's): refused
  const notGuardian = await start({ cosign: laptop.assert(d.digest) });
  ok(notGuardian, "refused");
  assert.match(notGuardian.result!.summary, /not this account's guardian/);
  assert.equal(await W.read(W.a.ownerAccount!, (W.owner as any).abi, "spentRecoveryKey", [rid]), false, "the code is not spent by a refused attempt");
  // the contact's co-signature over this very recovery: it starts, co-signed
  const started = await start({ cosign: contact.assert(d.digest) });
  ok(started, "scheduled");
  const recoveryId = (started.result!.evidence as { recoveryId: Hex; cosignedBy: string }).recoveryId;
  assert.equal((started.result!.evidence as { cosignedBy: string }).cosignedBy, idOf(contact));
  // the frozen (stolen) passkey cannot cancel it; the account itself refuses
  const c = await W.propose({ kind: "cancel-change", params: { changeId: recoveryId } });
  await assert.rejects(() => W.executeChecked(c.id, passkeyApproval(c, [phone], W.now()), key()), refusal("frozen_cannot_cancel"));
  W.cancelProposal(c.id);
  offset += 61_000;
  ok(await apply(W, recoveryId));
  v = await W.signers.view();
  assert.ok(v.signers.some((s) => s.signerId === idOf(fresh) && s.role === "member"), "the recovered passkey is a member");
  // the laptop and the recovered passkey reach threshold 2 again
  ok(await t.act(W, "pause", {}, [laptop, fresh]));

  // removing the guardian waits the delay; then a code alone starts a recovery again
  ok(await t.act(W, "set-guardian", { remove: true }, [laptop, fresh]), "scheduled");
  const [rmg] = await pendingOf(W, "set-guardian");
  offset += 61_000;
  ok(await apply(W, rmg!.changeId));
  v = await W.signers.view();
  assert.deepEqual([v.guardian.signerId, v.signers.some((s) => s.role === "guardian")], [null, false]);
  const rk2 = new RecoveryKey(generateRecoveryCode());
  ok(await t.act(W, "add-signer", { x: hex(rk2.x), y: hex(rk2.y), role: "recovery" }, [laptop, fresh]));
  const other = new SoftwarePasskey();
  const d2 = await W.signers.digest(new URLSearchParams({ recoverySignerId: rk2.signerId, x: other.publicKey.x, y: other.publicKey.y, deadline: String(Math.floor(W.now() / 1000) + 600) }));
  assert.equal(d2.guardian, null);
  ok(await W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rk2.signerId, newKey: other.publicKey, deadline: d2.deadline, signature: rk2.signDigest(d2.digest) }), key()).jobId), "scheduled");
});

test("R13 review fixes and H1: with every passkey frozen, the guardian withdraws, QED stops (the sentinel), or the recovery finishes after its whole delay", async () => {
  const laptop = new SoftwarePasskey(), contact = new SoftwarePasskey();
  // one device and three recovery codes: the household a proper freeze leaves with no unfrozen passkey
  await t.host.createWorkspace({ workspaceId: "gw-home", owner: { signers: [laptop.publicKey], threshold: 1, adminThreshold: 1 }, rpIdHash: RP_ID_HASH });
  const W = t.host.workspace("gw-home")!;
  ok(await t.act(W, "provision", {}, [laptop]));
  const codes = [0, 1, 2].map(() => new RecoveryKey(generateRecoveryCode()));
  for (const rk of codes) ok(await t.act(W, "add-signer", { x: hex(rk.x), y: hex(rk.y), role: "recovery" }, [laptop]));
  ok(await t.act(W, "set-guardian", contact.publicKey, [laptop]), "scheduled");
  offset += 61_000;
  ok(await apply(W, (await pendingOf(W, "set-guardian"))[0]!.changeId));
  // the only device is stolen and frozen by the wallet's sentinel key
  ok(await W.waitForJob(W.submit("freeze-signer", W.signers.freezeParams({ signerId: idOf(laptop) }), key()).jobId));
  const abi = (W.owner as any).abi, acct = W.a.ownerAccount!;
  const start = async (rk: RecoveryKey, fresh: SoftwarePasskey) => {
    const rid = rk.signerId.toLowerCase() as Hex, deadline = String(Math.floor(W.now() / 1000) + 600);
    const d = await W.signers.digest(new URLSearchParams({ recoverySignerId: rid, x: fresh.publicKey.x, y: fresh.publicKey.y, deadline }));
    const started = await W.waitForJob(W.submit("start-recovery", W.signers.recoveryParams({ recoverySignerId: rid, newKey: fresh.publicKey, deadline, signature: rk.signDigest(d.digest), cosign: contact.assert(d.digest) }), key()).jobId);
    ok(started, "scheduled");
    return { recoveryId: (started.result!.evidence as { recoveryId: Hex }).recoveryId, digest: d.digest };
  };
  const gone = async (recoveryId: Hex, rk: RecoveryKey) => {
    assert.equal(((await W.read(acct, abi, "getRecovery", [recoveryId])) as { readyAt: bigint }).readyAt, 0n, "the recovery is gone");
    assert.equal(Number(((await W.read(acct, abi, "getSigner", [rk.signerId])) as { role: number }).role), 0, "its recovery key is spent");
    assert.deepEqual((await W.scheduled()).filter((c) => c.changeId === recoveryId).map((c) => c.status), ["cancelled"]);
  };

  // 1. the guardian (phished, or having changed its mind) withdraws: only its own passkey, over this recovery's cancel digest
  const r1 = await start(codes[0]!, new SoftwarePasskey());
  const wd = await W.signers.withdrawDigest(r1.recoveryId);
  assert.equal(wd.guardian, idOf(contact));
  const withdraw = (assertion: unknown) => W.waitForJob(W.submit("guardian-withdraw", W.signers.withdrawParams(r1.recoveryId, { assertion }), key()).jobId);
  const byLaptop = await withdraw(laptop.assert(wd.digest));
  ok(byLaptop, "refused");
  assert.match(byLaptop.result!.summary, /not this account's guardian/);
  ok(await withdraw(contact.assert(r1.digest)), "refused");
  ok(await withdraw(contact.assert(wd.digest)));
  await gone(r1.recoveryId, codes[0]!);
  await assert.rejects(() => W.signers.withdrawDigest(r1.recoveryId), refusal("change_not_pending"));

  // 2. H1: the household stops a recovery through QED: the wallet's sentinel key, the one challenger left
  const r2 = await start(codes[1]!, new SoftwarePasskey());
  const stop = () => W.waitForJob(W.submit("sentinel-stop", W.signers.stopParams(r2.recoveryId, {}), key()).jobId);
  const stopped = await stop();
  ok(stopped);
  assert.match(stopped.result!.summary, /QED stopped the recovery/);
  await gone(r2.recoveryId, codes[1]!);
  const again = await stop();
  ok(again, "refused");
  assert.match(again.result!.summary, /no such pending recovery/);

  // 3. H1: left alone, the recovery finishes after its whole delay, because QED could have stopped it throughout; the
  //    household then has an unfrozen passkey again (no permanent hold)
  const fresh = new SoftwarePasskey();
  const r3 = await start(codes[2]!, fresh);
  ok(await apply(W, r3.recoveryId), "refused");
  offset += 61_000;
  ok(await apply(W, r3.recoveryId));
  const v = await W.signers.view();
  assert.ok(v.signers.some((s) => s.signerId === idOf(fresh) && s.role === "member" && !s.frozen), "the recovered passkey is an unfrozen member");
  ok(await t.act(W, "pause", {}, [fresh]));
});
