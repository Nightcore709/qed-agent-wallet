/**
 * R14 (the production failure of 25 Nov 2026): in the deployed image the co-signer runs as its own user (R13 review fix
 * F3), which cannot enter the wallet service's data folder. Its decision records were still pointed into that folder
 * (<data>/rail/workspaces/<id>/records), so configuring the co-signer for a new workspace failed with EACCES and no
 * wallet could be set up. A co-signer that has a folder of its own (QED_COSIGNER_STATE_DIR) keeps its records there.
 *
 * The same user cannot enter the folder of the chain's own socket either (F-14), so it could not read the chain: every
 * payment and conversion, which it must certify, failed too. Given a folder for it (QED_COSIGNER_CHAIN_DIR), the wallet
 * service opens the chain's read-only door there and the co-signer reads the chain through it and nothing else.
 *
 * Another user cannot be had in a test without root, so this checks the property that makes the container work: with
 * the co-signer in its own process and its own folder, a workspace is created, accepted, given a mandate and pays, and
 * the co-signer has written nothing inside the wallet service's data folder: its state and every decision record are in
 * its own folder. The container itself is checked by scripts/deploy/isolation-check.ts and scripts/deploy/smoke.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startHost } from "./helpers.ts";
import { SoftwarePasskey } from "./passkey.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;
const PORT = Number(process.env.QED_CHAIN_TEST_PORT ?? 18790);

test("a co-signer with its own folder writes its state and every decision record there, and nothing in the wallet service's data folder", { timeout: 300_000 }, async () => {
  const own = mkdtempSync(join(tmpdir(), "qed-cosigner-own-"));
  const doorDir = mkdtempSync(join(tmpdir(), "qed-door-"));
  const before = process.env.QED_COSIGNER_STATE_DIR, beforeDoor = process.env.QED_COSIGNER_CHAIN_DIR;
  process.env.QED_COSIGNER_STATE_DIR = own;
  process.env.QED_COSIGNER_CHAIN_DIR = doorDir;
  const h = await startHost("cosigner-own-folder", PORT, { cosigner: "process", economyAnvilPort: PORT + 1 });
  try {
    const alice = new SoftwarePasskey();
    const ws = await h.workspace("alice-home", [alice]);
    assert.equal(ws.summary.status, "awaiting-acceptance");
    assert.equal((await ws.state()).roles.cosignerIsolation, "separate-process");
    // accept, mandate, a grant of authority, a payment and a conversion: the last two are certified by the co-signer, which reads the chain for them
    for (const [kind, params] of [["provision", {}], ["mandate", { maxPerPayment: "2500" }], ["grant", { amount: "100" }], ["pay", { payee: "CloudCo", amount: "3.5" }], ["convert", { amount: "840" }]] as const) {
      const job = await h.act(ws, kind, params, [alice]);
      assert.equal(job.result?.outcome, "executed", `${kind}: ${job.error ?? ""}`);
    }
    // the payment was co-signed: its decision record is the co-signer's, in the co-signer's own folder
    const mine = join(own, "records", "alice-home");
    const records = readdirSync(mine).filter((f) => /^0x[0-9a-f]{64}\.json$/.test(f));
    assert.ok(records.length >= 1, "the co-signer's decision record is in its own folder");
    assert.ok(existsSync(join(own, "cosigner-state.json")), "its replay state is there too");
    // and nothing of the co-signer's is inside the wallet service's data folder
    const workspaceRecords = join(h.dir, "rail", "workspaces", "alice-home", "records");
    assert.deepEqual(existsSync(workspaceRecords) ? readdirSync(workspaceRecords) : [], [], "no co-signer record in the workspace's folder");
    assert.equal(existsSync(join(h.dir, "rail", "cosigner-state.json")), false, "no co-signer state in the wallet service's folder");
    // the co-signer read the chain through the read-only door, and asked it for nothing the door refuses
    const door = h.host.chainDoor!;
    assert.ok(door && door.path.startsWith(doorDir), "the door is in the folder given for it");
    assert.equal(statSync(door.path).mode & 0o777, 0o660);
    assert.ok(door.forwarded() > 0, "the co-signer's reads went through the door");
    assert.deepEqual(door.refused(), [], "the co-signer needs nothing the door refuses");
    // the wallet service still holds each verdict's record, in its own store, as the co-signer returned it
    const decided = ws.decisions(50).filter((d) => d.evidenceHash);
    assert.ok(decided.some((d) => records.includes(`${d.evidenceHash}.json`)), "the stored decision names the co-signer's record");
  } finally {
    await h.stop();
    rmSync(own, { recursive: true, force: true });
    if (before === undefined) delete process.env.QED_COSIGNER_STATE_DIR; else process.env.QED_COSIGNER_STATE_DIR = before;
    rmSync(doorDir, { recursive: true, force: true });
    if (beforeDoor === undefined) delete process.env.QED_COSIGNER_CHAIN_DIR; else process.env.QED_COSIGNER_CHAIN_DIR = beforeDoor;
  }
});
