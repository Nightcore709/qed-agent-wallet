/**
 * D-K1b (R13): the caps K1 puts on earned authority (rail/earned-authority.ts) are the owner's, signed with the passkey
 * like a grant, under the operator's caps (QED_RAIL_EARNED_*), which stay the ceiling. A lower cap applies at once; a
 * higher one is a loosening and waits the owner account's protection delay (60 s on this test host; 72 hours by default)
 * before it counts; a lower cap signed meanwhile drops the waiting raise. On a real chain, through the co-signer.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashMessage, type Hex } from "viem";
import { key, startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";
import { encodeAssertions, toContractAssertion } from "../rail/webauthn.ts";
import { earnedCapsMessage } from "../rail/cosigner.ts";
import { withOwnerCaps, type D7Config } from "../rail/authority-ledger.ts";
import type { Rail } from "../rail/host.ts";
import type { AuthorityView } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const ana = new SoftwarePasskey(), bob = new SoftwarePasskey();
let h: TestHost, A: Rail;
const view = async () => (await A.cosigner.authority()) as AuthorityView;
const caps = async () => (await view()).earnedCaps!;

before(async () => {
  // the operator's caps: 1,000.00 tINR in any 30 days, 250.00 from any one payer (the defaults, stated)
  h = await startHost("earned-caps", 12486, { heartbeatMs: 3_600_000, authorityEarnedCap: { windowSeconds: 30 * 86_400, perWindow: 100_000n, perPayer: 25_000n } });
  A = await h.workspace("ana-caps", [ana]);
  for (const [k, p] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }]] as const) assert.equal((await h.act(A, k, p, [ana])).result?.outcome, "executed", k);
});
after(async () => { await h?.stop(); });

test("D-K1b: the owner's passkey-signed caps: a lower cap applies at once, a higher one waits the account's delay, a lower one meanwhile drops it; the operator's caps stay the ceiling", async () => {
  const c0 = await caps();
  assert.deepEqual([c0.ceiling, c0.owner, c0.inForce, c0.pending], [{ windowSeconds: 2_592_000, perWindow: "100000", perPayer: "25000" }, { perWindow: null, perPayer: null }, { perWindow: "100000", perPayer: "25000" }, []]);

  // lower both: at once, and the budget's own K1 limit is the owner's
  const lower = await h.act(A, "earned-caps", { perWindow: "500", perPayer: "100" }, [ana]);
  assert.equal(lower.result?.outcome, "executed", lower.error ?? lower.result?.summary);
  assert.equal(lower.result?.tx, undefined, "setting caps sends no transaction");
  let v = await view();
  assert.deepEqual([v.earnedCaps!.inForce, v.earnedLimit.perWindow, v.earnedLimit.perPayer, v.earnedCaps!.pending], [{ perWindow: "50000", perPayer: "10000" }, "50000", "10000", []]);

  // raise the window cap: it waits; nothing counts more until then
  const raise = await h.act(A, "earned-caps", { perWindow: "800", perPayer: "100" }, [ana]);
  assert.equal(raise.result?.outcome, "scheduled", raise.error ?? raise.result?.summary);
  assert.match(raise.result!.summary, /in any window: 800\.00 tINR from .*; 500\.00 tINR until then/);
  v = await view();
  assert.deepEqual([v.earnedCaps!.inForce.perWindow, v.earnedLimit.perWindow, v.earnedCaps!.pending.map((p) => [p.cap, p.value])], ["50000", "50000", [["perWindow", "80000"]]]);
  const due = v.earnedCaps!.pending[0]!.from;
  assert.ok(Math.abs(due - (Date.now() + 60_000)) < 30_000, `waits the account's delay of 60 s: ${due - Date.now()} ms`);
  assert.equal((await A.cosigner.earnedCaps(due - 1))!.inForce.perWindow, "50000", "not a moment before");
  assert.equal((await A.cosigner.earnedCaps(due))!.inForce.perWindow, "80000", "in force once the delay has ended");

  // a lower cap signed while the raise waits applies at once and drops it: an earlier loosening never undoes a later tightening
  assert.equal((await h.act(A, "earned-caps", { perWindow: "450", perPayer: "100" }, [ana])).result?.outcome, "executed");
  v = await view();
  assert.deepEqual([v.earnedCaps!.inForce.perWindow, v.earnedCaps!.pending], ["45000", []]);
  assert.equal((await A.cosigner.earnedCaps(due + 3_600_000))!.inForce.perWindow, "45000", "the dropped raise never comes into force");

  // above the operator's caps: refused before anything is prepared, and by the co-signer itself
  await assert.rejects(() => A.propose({ kind: "earned-caps", params: { perWindow: "1000.01", perPayer: "100" } }), (e: { code?: string }) => e.code === "above_ceiling");
  const above = earnedCapsMessage(A.a.vault, 2_592_000, 100_001n, 10_000n, `above-${key()}`);
  await assert.rejects(() => A.cosigner.registerCaps(above, "0x" as Hex, { nowMs: Date.now(), delaySeconds: 60 }), /above the operator's ceiling/);
  // another window than the installation's, a signature by someone who is not a signer, an ordinary key
  await assert.rejects(() => A.cosigner.registerCaps(earnedCapsMessage(A.a.vault, 3600, 1n, 1n, `window-${key()}`), "0x" as Hex, { nowMs: Date.now(), delaySeconds: 60 }), /installation's window is 2592000 seconds/);
  const forged = earnedCapsMessage(A.a.vault, 2_592_000, 100_000n, 25_000n, `forged-${key()}`);
  const hash = (await A.read(A.a.ownerAccount!, [{ type: "function", name: "replaySafeHash", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }], outputs: [{ name: "", type: "bytes32" }] }], "replaySafeHash", [hashMessage(forged)])) as Hex;
  await assert.rejects(() => A.cosigner.registerCaps(forged, encodeAssertions([toContractAssertion(bob.assert(hash))]), { nowMs: Date.now(), delaySeconds: 0 }), /not signed by the vault owner/);
  const byAgent = await A.K.OPERATOR.signMessage({ message: forged });
  await assert.rejects(() => A.cosigner.registerCaps(forged, byAgent, { nowMs: Date.now(), delaySeconds: 0 }), /not signed by the vault owner/);
  // the job's own signed caps, registered again (a retry): the same answer, nothing changes
  const rec = A.decisions(40).find((d) => d.kind === "owner-earned-caps")!.record as { message: string };
  const again = await A.cosigner.registerCaps(rec.message, "0x" as Hex, { nowMs: Date.now(), delaySeconds: 0 });
  assert.equal(again.duplicate, true);
  assert.equal((await caps()).inForce.perWindow, "45000");

  // a raise again, then the chain's clock past its delay: the budget's K1 limit follows (the engine reads the chain's time)
  assert.equal((await h.act(A, "earned-caps", { perWindow: "700", perPayer: "100" }, [ana])).result?.outcome, "scheduled");
  assert.equal((await view()).earnedLimit.perWindow, "45000");
  await A.rpc("evm_increaseTime", [61]);
  await A.rpc("evm_mine", []);
  assert.equal((await view()).earnedLimit.perWindow, "70000", "in force once the delay has ended on the chain's clock");
});

test("D-K1b: withOwnerCaps lowers the operator's caps and never raises them", () => {
  const cfg = { decimals: 2, earnedCap: { windowSeconds: 86_400, perWindow: "1000", perPayer: "300" } } as unknown as D7Config;
  const caps = (c: D7Config) => [c.earnedCap!.windowSeconds, c.earnedCap!.perWindow, c.earnedCap!.perPayer];
  assert.deepEqual(caps(withOwnerCaps(cfg, { perWindow: "400", perPayer: null })), [86_400, "400", "300"]);
  assert.deepEqual(caps(withOwnerCaps(cfg, { perWindow: "5000", perPayer: "5000" })), [86_400, "1000", "300"], "above the ceiling: the ceiling");
  assert.equal(withOwnerCaps(cfg, null), cfg);
  assert.equal(withOwnerCaps(cfg, { perWindow: null, perPayer: null }), cfg);
  assert.deepEqual(caps(withOwnerCaps(cfg, { perWindow: "0", perPayer: "0" })), [86_400, "0", "0"], "nothing counts as earned");
});
