/**
 * Correction (e): the co-signer in its own process with a key the rail never loads. Same unmodified PolicyEngine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { key, startRail } from "./helpers.ts";
import { devAccount } from "../rail/keys.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const until = async (f: () => Promise<boolean>, ms: number, label: string) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise((r) => setTimeout(r, 100)); } };

test("the co-signer is another process with its own random key; the rail knows only its address, and survives its death and a restart", { timeout: 240_000 }, async () => {
  const t = await startRail("cosigner-process", 18671, { cosigner: "process" });
  let dir = t.dir, stopped = false;
  try {
    await t.ready();
    const V = t.rail.v, A = t.rail.a;
    const s = await t.rail.state();
    const port = t.rail.cosigner as unknown as { pid: number | null };
    assert.equal(s.roles.cosignerIsolation, "separate-process");
    assert.ok(port.pid && port.pid !== process.pid, "a different operating-system process");
    assert.notEqual(s.roles.cosigner, devAccount("COSIGNER").address, "not the key anyone can derive from a public string");
    assert.equal(s.treasury.cosigner, s.roles.cosigner, "the vault was deployed with the process's own address");
    const keyFile = join(dir, "rail", "cosigner.key");
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    // one shared co-signer process, a key per workspace scope (R7): this rail's one workspace is "baseline"
    const secret = Object.values((JSON.parse(readFileSync(keyFile, "utf8")) as Record<string, Record<string, string>>).baseline)[0];
    assert.ok(/^0x[0-9a-f]{64}$/.test(secret));
    assert.ok(!JSON.stringify(t.rail.cosigner).includes(secret.slice(2)) && !JSON.stringify(Object.values(process.env)).includes(secret.slice(2)), "the rail's process holds no copy of the key");

    const job = await t.act("convert", { amount: "10" });
    assert.equal(job.result?.outcome, "executed", job.error ?? "");
    assert.equal((await t.rail.state()).lastTrade!.amountOut, "9107516", "the same figures: the engine is the same");
    assert.equal(job.steps[3].data!.isolation, "separate-process");
    for (const kind of ["redirect", "skim"] as const) assert.equal((await t.act("attack", { kind })).result!.outcome, "reverted");

    // the maker cannot forge a certificate: the key it could derive is not the registered co-signer
    const am = t.rail.activeMandate()!;
    const tp = await V.trader.planTrade(t.rail.pub, A.exec, A.usd, A.eur, 5_000_000n);
    const venueSetHash = await t.rail.read(A.exec, V.abi.QEDExecutionAbi, "venueSetHash");
    const order = { tokenOut: A.eur, recipient: A.reserve, minOut: 1n, tolerancePpm: 100, venueSetHash };
    const ts = await t.rail.chainNow();
    const cert = { mandateHash: am.hash, recipient: A.exec, amount: 5_000_000n, dueAt: 0n, intentId: `0x${"11".repeat(32)}`, evidenceHash: `0x${"22".repeat(32)}`, ref: V.trader.hashOrder(order as never), notBefore: ts - 60n, expiresAt: ts + 3600n, epoch: am.mandate.epoch };
    const forged = await V.eip712.signCertificate(devAccount("COSIGNER"), 31337, A.vault, cert as never);
    const err = await t.rail.c.simulateError(t.rail.K.OPERATOR.address, A.exec, V.chain.fn(V.abi.QEDExecutionAbi, "trade", [am.mandate, am.ownerSig, cert, forged, order, V.trader.hopsForChain(tp.plan.route), V.trader.pricesForChain(tp.plan.prices)]));
    assert.equal(err.name, "BadCosignerSignature");

    // standing policy and its supersession work through the process boundary
    assert.equal((await t.act("policy", { targetFree: "20" })).result?.outcome, "executed");
    assert.equal((await t.rail.waitForJob(t.rail.submit("policy-tick", {}, key()).jobId)).result?.outcome, "executed");

    // the co-signer process dies: the rail is not ready, then the process is started again with the same key and state
    const address = s.roles.cosigner, oldPid = port.pid!;
    process.kill(oldPid, "SIGKILL");
    await until(async () => !(await t.rail.health()).readiness.cosigner, 5_000, "unready without a co-signer");
    assert.equal((await t.rail.health()).ready, false);
    const after = await t.act("convert", { amount: "5" });
    assert.equal(after.result?.outcome, "executed", after.error ?? "");
    assert.notEqual(port.pid, oldPid);
    assert.equal(await t.rail.cosigner.address(), address, "the same key, read back by the new process");
    assert.equal((await t.rail.health()).ready, true);

    // rotation creates a new random key inside the co-signer; the old certificates die with the old key
    const rot = await t.act("rotate-key", { role: "cosigner" });
    assert.equal(rot.result?.outcome, "executed", rot.error ?? "");
    const rotated = (await t.rail.state()).roles.cosigner;
    assert.notEqual(rotated, address);
    assert.equal((await t.act("convert", { amount: "5" })).result?.outcome, "executed");

    await t.stop({ keep: true });
    stopped = true;
    const again = await startRail("cosigner-process", 18671, { dataDir: dir, cosigner: "process" });
    try {
      assert.equal((await again.rail.state()).roles.cosigner, rotated, "the rotated key is still the co-signer after a restart");
      assert.equal((await again.act("convert", { amount: "5" })).result?.outcome, "executed");
    } finally { await again.stop(); }
  } finally { if (!stopped) await t.stop(); }
});

test("a chain created under one co-signer arrangement is not started under the other: the rail says so and changes nothing", { timeout: 120_000 }, async () => {
  const made = await startRail("cosigner-mode", 18672, { cosigner: "in-process" });
  const dir = made.dir;
  let stopped = false;
  try {
    await made.ready();
    await made.act("convert", { amount: "10" });
    const registered = (await made.rail.state()).roles.cosigner;
    await made.stop({ keep: true });
    stopped = true;
    const { createRail } = await import("../rail/index.ts");
    const other = createRail({ dataDir: dir, anvilPort: 18672, economyAnvilPort: 19172, cosigner: "process" });
    try {
      await assert.rejects(() => other.start(), new RegExp(`registered co-signer is ${registered}.*QED_RAIL_COSIGNER`, "s"));
      const h = await other.health();
      assert.deepEqual([h.ready, h.readiness.rail], [false, "failed"]);
    } finally { await other.stop().catch(() => {}); }
    // started again the way it was created, it simply works
    const again = await startRail("cosigner-mode", 18672, { dataDir: dir, cosigner: "in-process" });
    try {
      assert.equal((await again.rail.state()).roles.cosigner, registered);
      assert.equal((await again.act("convert", { amount: "22.5" })).result?.outcome, "executed");
    } finally { await again.stop(); }
  } finally { if (!stopped) await made.stop(); }
});
