/**
 * R7 decision D7, change 4 of scripts/fork-cosigner.mjs (experiments/r8/D7-validation, F-R8-4): a conversion's
 * certificate lives 15 minutes under the authority budget, so the worst case it reserves is released within minutes
 * when the conversion never executes (for example when an outside trade between the agent's plan and its block makes
 * the chain revert it with NotBestExecution). Under the release's rule the certificate keeps the release's 4 hours.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { startHost, type TestHost } from "./helpers.ts";
import { SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import { D7_CONVERSION_CERTIFICATE_SECONDS } from "../rail/cosigner-engine.ts";
import type { Rail } from "../rail/host.ts";
import type { AuthorityView } from "../types.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const ana = new SoftwarePasskey();
const clock = { offset: 0 };
let h: TestHost, A: Rail;
const view = async () => (await A.cosigner.authority()) as AuthorityView;

/** A conversion certificate the co-signer signs and nobody sends. */
async function unsentConversion(t: TestHost, ws: Rail, signer: SoftwarePasskey, amount: string) {
  const am = ws.activeMandate()!;
  const p = await ws.propose({ kind: "convert", params: { amount } });
  const terms = p.terms as any;
  const { signature } = await ws.owner.signMessage(terms, passkeyApproval(p, [signer], ws.now()), { notBeforeMs: Date.parse(p.createdAt), notAfterMs: Date.parse(p.expiresAt), nowMs: ws.now() });
  const r = await ws.cosigner.evaluateTrade({ mandate: am.mandate, ownerSig: am.ownerSig, module: ws.a.exec, tokenIn: ws.a.asset, tokenOut: ws.a.reserveAsset, recipient: ws.a.reserve, amountIn: BigInt(terms.amountIn), instruction: terms.instruction, nonce: terms.nonce, instructionSig: signature, brainEngine: "test" });
  ws.cancelProposal(p.id);
  void t;
  return r;
}

before(async () => {
  h = await startHost("authority-certificate-lifetime", 18785, { heartbeatMs: 3_600_000, wallClock: () => Date.now() + clock.offset });
  A = await h.workspace("ana-home", [ana]);
  for (const [k, p] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }]] as const) assert.equal((await h.act(A, k, p, [ana])).result?.outcome, "executed", k);
});
after(async () => { await h?.stop(); });

test("under the authority budget a conversion's certificate lives 15 minutes; its reservation lapses with it", async () => {
  assert.equal(D7_CONVERSION_CERTIFICATE_SECONDS, 900);
  const v0 = await view();
  const r = await unsentConversion(h, A, ana, "100");
  assert.equal(r.approved, true, r.reasons?.join("; "));
  const life = Number(r.certificate!.expiresAt - r.certificate!.notBefore) - 60;
  assert.equal(life, 900, "expiresAt = the co-signer's now + 15 minutes (notBefore is now − 60 s)");
  const v1 = await view();
  assert.ok(BigInt(v1.reserved) > 0n && BigInt(v0.available) - BigInt(v1.available) === BigInt(v1.reserved), "its worst case is reserved");
  clock.offset += 14 * 60_000;
  await h.host.tick();
  assert.equal((await view()).reserved, v1.reserved, "still reserved after 14 minutes: the certificate can still be used");
  clock.offset += 2 * 60_000;
  await h.host.tick();
  const v2 = await view();
  assert.deepEqual([v2.reserved, v2.available], ["0", v0.available], "after 16 minutes the certificate has expired and nothing is reserved");
});

test("a payment's certificate keeps the release's 2 hours; under the release's rule a conversion's keeps 4 hours", async () => {
  // a payment certificate under the authority budget: unchanged
  assert.equal((await h.act(A, "mandate", { maxPerPayment: "2500" }, [ana])).result?.outcome, "executed");
  const am = A.activeMandate()!;
  const p = await A.propose({ kind: "pay", params: { payee: "CloudCo", amount: "1" } });
  const t = p.terms as any;
  const { signature } = await A.owner.signMessage(t, passkeyApproval(p, [ana], A.now()), { notBeforeMs: Date.parse(p.createdAt), notAfterMs: Date.parse(p.expiresAt), nowMs: A.now() });
  const pay = await A.cosigner.evaluatePayment({ kind: "owner-instructed", mandate: am.mandate, ownerSig: am.ownerSig, payee: t.payee, amount: BigInt(t.amountRaw), instruction: t.instruction, nonce: t.nonce, instructionSig: signature });
  A.cancelProposal(p.id);
  assert.equal(Number(pay.certificate!.expiresAt - pay.certificate!.notBefore) - 60, 2 * 3600);
  // the release's rule
  const t2 = await startHost("authority-certificate-lifetime-release", 18787, { heartbeatMs: 3_600_000, authority: "release" });
  try {
    const cara = new SoftwarePasskey();
    const R = await t2.workspace("cara-home", [cara]);
    for (const [k, prm] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }]] as const) assert.equal((await t2.act(R, k, prm, [cara])).result?.outcome, "executed", k);
    const r = await unsentConversion(t2, R, cara, "5");
    assert.equal(r.approved, true, r.reasons?.join("; "));
    assert.equal(Number(r.certificate!.expiresAt - r.certificate!.notBefore) - 60, 4 * 3600);
  } finally { await t2.stop(); }
});
