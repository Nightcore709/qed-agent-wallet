/**
 * The wallet service's secrets sealed at rest (rail/sealed-at-rest.ts; docs/ENCRYPTION.md section 9), on the real service
 * process with the co-signer in its own process: started with QED_RAIL_SEAL=1 and a throwaway key folder, it seals the
 * plaintext master secret it finds, creates the co-signer's keys sealed, keeps the keyring's copy beside them and the
 * folder locked while it runs, derives the same addresses after a restart, refuses a different or missing master secret
 * (making none in its place), and without the key-encryption key it does not start and removes nothing. Never the real
 * keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initKeys, openKeyring } from "../../server/key-config.ts";
import { writeSecret } from "../rail/sealed-at-rest.ts";
import { freshDir, key } from "./helpers.ts";
import { startService, type Service } from "./service-helper.ts";
import { RP_ID_HASH, SoftwarePasskey, passkeyApproval } from "./passkey.ts";
import type { Accepted, Job, Proposal, RailState, WorkspaceView } from "../types.ts";

async function act(s: Service, ws: string, kind: string, signers: SoftwarePasskey[]): Promise<Job> {
  const p = await s.call<Proposal>("POST", `/workspaces/${ws}/proposals`, { kind, params: {} });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const a = await s.call<Accepted>("POST", `/workspaces/${ws}/proposals/${p.data.id}/execute`, { approval: passkeyApproval(p.data, signers) }, { "Idempotency-Key": key() });
  assert.equal(a.status, 202, JSON.stringify(a.data));
  for (let i = 0; i < 900; i++) {
    const j = (await s.call<Job>("GET", `/workspaces/${ws}/jobs/${a.data.jobId}`)).data;
    if (["done", "failed", "interrupted"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
}

/** A start that must be refused: the service stays up answering 503 and logs why; this waits for that line, then stops it. */
async function refused(dir: string, env: Record<string, string>, pattern: RegExp): Promise<void> {
  const t = await startService("svc-sealed", 15397, 18997, { dir, env, workspace: null, waitReady: false, listenMs: 120_000 });
  try {
    await t.until(async () => /\[rail\] failed to start/.test(t.log()), 180_000, "the refusal");
    assert.match(t.log(), pattern);
    assert.notEqual((await fetch(`http://127.0.0.1:${t.port}/health`)).status, 200, "a refused service is never ready");
  } finally {
    await t.stop("SIGTERM");
  }
}

test("sealed at rest: a plaintext master secret is sealed at start, the co-signer's keys are created sealed, a restart derives the same addresses, a different or missing master secret is refused, and without the key-encryption key the service does not start", { timeout: 900_000 }, async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "qed-rail-keys-"));
  const keyDir = join(keysRoot, "keys");
  initKeys({ env: { HOME: keysRoot, QED_KEY_DIR: keyDir }, purposes: ["wallet-secret"] });
  const env = { QED_RAIL_MODE: "multi-tenant", QED_RAIL_SEAL: "1", QED_KEY_DIR: keyDir, QED_RAIL_ACCOUNT_DELAY_S: "60", QED_RAIL_ACCOUNT_RECOVERY_DELAY_S: "60" };
  const dir = freshDir("svc-sealed");
  const rail = join(dir, "rail");
  mkdirSync(rail, { recursive: true });
  writeFileSync(join(rail, "master.key"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 }); // as before sealing
  const owner = new SoftwarePasskey();
  let s: Service | null = await startService("svc-sealed", 15397, 18997, { dir, env, workspace: null, listenMs: 120_000 });
  try {
    assert.equal((await s.call("GET", "/health")).data.ready, true);
    assert.deepEqual([existsSync(join(rail, "master.key")), existsSync(join(rail, "master.key.sealed"))], [false, true], "the plaintext master secret was sealed and removed");
    const created = await s.call<WorkspaceView>("POST", "/workspaces", { workspaceId: "sealed-home", owner: owner.publicKey, rpIdHash: RP_ID_HASH });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const prov = await act(s, "sealed-home", "provision", [owner]);
    assert.equal(prov.result?.outcome, "executed", prov.error ?? "");
    const before = (await s.call<RailState>("GET", "/workspaces/sealed-home/state")).data;
    assert.equal(before.roles.cosignerIsolation, "separate-process");
    assert.deepEqual([existsSync(join(rail, "cosigner.key")), existsSync(join(rail, "cosigner.key.sealed"))], [false, true], "the co-signer's keys exist only sealed");
    const sealedMaster = readFileSync(join(rail, "master.key.sealed"));
    await s.stop("SIGTERM");
    s = null;

    // a restart: the same secrets open, so every derived and co-signer address is the same
    s = await startService("svc-sealed", 15397, 18997, { dir, env, workspace: null, listenMs: 120_000 });
    const after = (await s.call<RailState>("GET", "/workspaces/sealed-home/state")).data;
    assert.deepEqual([after.roles.operator, after.roles.cosigner, after.roles.guardian, after.contracts.vault, after.contracts.ownerAccount], [before.roles.operator, before.roles.cosigner, before.roles.guardian, before.contracts.vault, before.contracts.ownerAccount]);
    assert.ok(readFileSync(join(rail, "master.key.sealed")).equals(sealedMaster), "an unchanged secret is not re-sealed");
    assert.deepEqual([existsSync(join(rail, "master.key")), existsSync(join(rail, "cosigner.key"))], [false, false]);
    assert.ok(existsSync(join(rail, "keyring.json")), "the keyring's copy is beside the sealed secrets");
    const holder = Number(readFileSync(join(rail, "sealing.lock"), "utf8").trim());
    assert.ok(Number.isInteger(holder) && holder > 1 && holder !== process.pid, "the running service holds the folder's lock");
    process.kill(holder, 0); // alive
    await s.stop("SIGTERM");
    s = null;
    assert.equal(existsSync(join(rail, "sealing.lock")), false, "the lock is released on stop");

    // a different master secret (a planted or swapped one) is refused, and so is a missing one; nothing is made instead
    const ring = openKeyring("wallet-secret", { env: { HOME: keysRoot, QED_KEY_DIR: keyDir } });
    const elsewhere = join(dir, "elsewhere");
    writeSecret(join(elsewhere, "master.key"), Buffer.from(`${randomBytes(32).toString("hex")}\n`), { seal: true, ring: () => ring, fresh: true });
    copyFileSync(join(rail, "master.key.sealed"), join(dir, "master.key.sealed.kept"));
    copyFileSync(join(elsewhere, "master.key.sealed"), join(rail, "master.key.sealed"));
    await refused(dir, env, /not the one its chain was created with/);
    rmSync(join(rail, "master.key.sealed"));
    await refused(dir, env, /master secret is missing/);
    assert.deepEqual([existsSync(join(rail, "master.key")), existsSync(join(rail, "master.key.sealed"))], [false, false], "no new secret was made");
    copyFileSync(join(dir, "master.key.sealed.kept"), join(rail, "master.key.sealed"));
    s = await startService("svc-sealed", 15397, 18997, { dir, env, workspace: null, listenMs: 120_000 });
    assert.equal((await s.call<RailState>("GET", "/workspaces/sealed-home/state")).data.roles.operator, before.roles.operator, "the restored secret works again");
    await s.stop("SIGTERM");
    s = null;

    // without the key-encryption key: refuses to start, writes no plaintext and removes nothing
    rmSync(join(keyDir, "qed.kek"));
    await refused(dir, env, /key-encryption key/);
    assert.deepEqual([existsSync(join(rail, "master.key")), existsSync(join(rail, "master.key.sealed")), existsSync(join(rail, "cosigner.key.sealed"))], [false, true, true]);
  } finally {
    if (s) await s.stop("SIGTERM");
    rmSync(keysRoot, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
