/**
 * R13 S5 on the rail: the release's QEDVault ownership transfer and a creditor's release or assignment of a claim, each
 * approved by the workspace's own passkeys through its owner account, on a real local chain:
 *   - a household can owe another: a ring-fence may name another workspace's owner account here as creditor;
 *   - only the creditor may release or assign; both wait the owner account's delay; one passkey cancels in between;
 *     applied, a release returns the money to the debtor vault's free funds and an assignment changes the creditor;
 *   - a transfer of ownership is scheduled behind the same delay, then is an offer the new owner accepts with its own
 *     passkeys (two-step); afterwards the old workspace's owner actions on that vault are refused before signing.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import type { Rail } from "../rail/host.ts";
import type { Job } from "../types.ts";
import type { ClaimView } from "../rail/ownership.ts";

let offset = 0;
let t: TestHost, A: Rail, B: Rail, C: Rail;
const pa = new SoftwarePasskey(), pb = new SoftwarePasskey(), pc = new SoftwarePasskey();
const ok = (j: Job, outcome = "executed") => assert.equal(j.result?.outcome, outcome, `${j.kind}: ${j.error ?? j.result?.summary}`);
const refusal = (code: string) => (e: { code?: string }) => e.code === code;
const DELAY = 60;
const free = async (ws: Rail) => BigInt((await ws.snap(ws.a.vault)).freeBalance);
const apply = async (ws: Rail, changeId: string) => ws.waitForJob(ws.submit("apply-change", ws.applyParams(changeId), key()).jobId);
const claim = async (ws: Rail, vault: string, id: string) => ((await ws.ownership.claims()) as ClaimView[]).find((c) => c.vault === getAddress(vault) && c.liabilityId === id);
async function ringFenceForB(amount: string): Promise<string> {
  const j = await t.act(A, "ring-fence", { creditor: B.a.ownerAccount, amount, dueInDays: 30 }, [pa]);
  ok(j);
  return String((j.result!.evidence as { liabilityId: string }).liabilityId);
}

before(async () => {
  t = await startHost("ownership", 11783, { economyAnvilPort: 11784, wallClock: () => Date.now() + offset, heartbeatMs: 3_600_000, accountDelaySeconds: DELAY });
  A = await t.workspace("owner-a", [pa]);
  B = await t.workspace("owner-b", [pb]);
  C = await t.workspace("owner-c", [pc]);
  for (const [ws, k] of [[A, pa], [B, pb], [C, pc]] as const) ok(await t.act(ws, "provision", {}, [k]));
});
after(async () => { await t?.stop(); });

test("a creditor's release: only the creditor, behind its owner account's delay, and the money returns to the debtor's free funds", async () => {
  await assert.rejects(() => A.propose({ kind: "ring-fence", params: { creditor: `0x${"7e".repeat(20)}`, amount: "1", dueInDays: 30 } }), refusal("unknown_creditor"));
  const id = await ringFenceForB("50");
  const c = await claim(B, A.a.vault, id);
  assert.deepEqual([c?.mine, c?.status, c?.amount, c?.debtorWorkspace], [true, "open", "5000", A.id]);
  await assert.rejects(() => C.propose({ kind: "release-claim", params: { vault: A.a.vault, liabilityId: id } }), refusal("not_the_creditor"));
  const free0 = await free(A);
  const p = await B.propose({ kind: "release-claim", params: { vault: A.a.vault, liabilityId: id } });
  const exec = (p.terms.toSign as { calls: { action: string }[]; schedule?: { delaySeconds: string } }[])[0]!;
  assert.deepEqual([exec.calls.map((x) => x.action), exec.schedule?.delaySeconds], [["QEDOwnerAccount.scheduleCalls(QEDVault (debtor treasury).release)"], String(DELAY)], "QED sends the release through the delayed path");
  B.cancelProposal(p.id);
  const j = await t.act(B, "release-claim", { vault: A.a.vault, liabilityId: id }, [pb]);
  ok(j, "scheduled");
  const changeId = String((j.result!.evidence as { changeId: string }).changeId);
  assert.equal((await claim(B, A.a.vault, id))?.status, "open", "nothing changes before the delay");
  ok(await apply(B, changeId), "refused");
  offset += (DELAY + 2) * 1000;
  ok(await apply(B, changeId));
  assert.equal((await claim(B, A.a.vault, id))?.status, "released");
  assert.equal((await free(A)) - free0, 5000n, "back in the debtor vault's free funds");
});

test("a creditor's assignment: one passkey cancels it during the delay; applied, the claim belongs to the new creditor", async () => {
  const id = await ringFenceForB("20");
  await assert.rejects(() => B.propose({ kind: "assign-claim", params: { vault: A.a.vault, liabilityId: id, newCreditor: `0x${"7e".repeat(20)}` } }), refusal("unknown_creditor"));
  const j = await t.act(B, "assign-claim", { vault: A.a.vault, liabilityId: id, newCreditor: C.a.ownerAccount }, [pb]);
  ok(j, "scheduled");
  ok(await t.act(B, "cancel-change", { changeId: (j.result!.evidence as { changeId: string }).changeId }, [pb]));
  offset += (DELAY + 2) * 1000;
  assert.equal((await claim(B, A.a.vault, id))?.creditor, getAddress(B.a.ownerAccount!), "the cancelled assignment never ran");
  const j2 = await t.act(B, "assign-claim", { vault: A.a.vault, liabilityId: id, newCreditor: B.a.vault }, [pb]);
  ok(j2, "scheduled");
  offset += (DELAY + 2) * 1000;
  ok(await apply(B, String((j2.result!.evidence as { changeId: string }).changeId)));
  const c = await claim(B, A.a.vault, id);
  assert.deepEqual([c?.mine, c?.assignedTo], [false, getAddress(B.a.vault)], "now paid straight into B's vault when due");
});

test("a transfer of ownership: scheduled behind the delay, an offer once applied, complete only when the new owner accepts; the old owner's actions are then refused", async () => {
  await assert.rejects(() => A.propose({ kind: "transfer-ownership", params: { newOwner: `0x${"7e".repeat(20)}` } }), refusal("unknown_owner"));
  await assert.rejects(() => A.propose({ kind: "transfer-ownership", params: { newOwner: A.a.ownerAccount } }), refusal("same_owner"));
  const p = await A.propose({ kind: "transfer-ownership", params: { newOwner: B.a.ownerAccount } });
  assert.equal(Number((p.terms as { delaySeconds: number }).delaySeconds), DELAY);
  A.cancelProposal(p.id);
  const j = await t.act(A, "transfer-ownership", { newOwner: B.a.ownerAccount }, [pa]);
  ok(j, "scheduled");
  assert.deepEqual((await A.ownership.state()).mine.map((m) => m.pendingOwner), [null, null], "nothing offered before the delay");
  offset += (DELAY + 2) * 1000;
  ok(await apply(A, String((j.result!.evidence as { changeId: string }).changeId)));
  const a1 = await A.ownership.state();
  assert.deepEqual(a1.mine.map((m) => [m.pendingOwner, m.ownedByThisAccount]), [[getAddress(B.a.ownerAccount!), true], [getAddress(B.a.ownerAccount!), true]], "an offer: A still owns both");
  const offered = (await B.ownership.state()).offeredToMe;
  assert.equal(offered.length, 2);
  await assert.rejects(() => C.propose({ kind: "accept-ownership", params: { vault: A.a.vault } }), refusal("not_offered"));
  ok(await t.act(B, "accept-ownership", { vault: A.a.vault }, [pb]));
  const a2 = await A.ownership.state();
  assert.deepEqual(a2.mine.map((m) => m.ownedByThisAccount), [false, true], "the treasury changed hands; the reserve is still only offered");
  assert.deepEqual((await B.ownership.state()).ownedHere.map((v) => v.vault), [getAddress(A.a.vault)]);
  await assert.rejects(() => A.propose({ kind: "withdraw", params: { amount: "1" } }), refusal("vault_transferred"));
});
