/**
 * R13 least privilege (docs/LEAST-PRIVILEGE.md): with sealing on, the co-signer's process is given no key setting and
 * opens no keyring. The wallet service unseals cosigner.key and hands its bytes over an inherited pipe; a key the
 * co-signer makes comes back over IPC and is sealed by the service before it is used. Shown on a real rail with the
 * co-signer in its own process and Anvil on 127.0.0.1 (ports 12881 and 12882, or QED_TEST_ANVIL_PORT and the next):
 *   - the child's environment, read from the operating system, carries none of QED_KEY_DIR, QED_KEY_FILE, QED_KEK,
 *     QED_RAIL_SEAL or the key file's path, before and after a restart;
 *   - it still signs: conversions execute, which the vault accepts only with the co-signer's certificate;
 *   - killed, it is started again with the same key; a rotation's new key is stored sealed, and is still the co-signer
 *     after the whole rail restarts;
 *   - the key file never exists in plaintext, and what is sealed is exactly the keys the co-signer signs with.
 * Throwaway key folder; never the real keys.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { initKeys, openKeyring } from "../../server/key-config.ts";
import { startRail } from "./helpers.ts";

process.env.PATH = `${join(homedir(), ".foundry", "bin")}:${process.env.PATH}`;

/** A process's environment as the operating system holds it (Linux: /proc; macOS: ps -E). */
function environOf(pid: number): string {
  if (existsSync(`/proc/${pid}/environ`)) return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join("\n");
  return execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
}
const KEY_SETTINGS = ["QED_KEY_DIR=", "QED_KEY_FILE=", "QED_KEK=", "QED_RAIL_SEAL=", "QED_COSIGNER_KEYFILE=", "cosigner.key"];
function noKeySetting(pid: number, when: string): void {
  const env = environOf(pid);
  assert.match(env, /QED_COSIGNER_STATE=/, `the environment was read (${when})`);
  for (const k of KEY_SETTINGS) assert.ok(!env.includes(k), `the co-signer's environment carries ${k} (${when})`);
}

test("sealing on: the co-signer is given no key setting, receives its keys over a pipe, still signs, and survives a kill, a rotation and a restart", { timeout: 300_000 }, async () => {
  const keysRoot = mkdtempSync(join(tmpdir(), "qed-cosigner-pipe-"));
  const keyDir = join(keysRoot, "keys");
  initKeys({ env: { HOME: keysRoot, QED_KEY_DIR: keyDir }, purposes: ["wallet-secret"] });
  const added = { QED_RAIL_SEAL: "1", QED_KEY_DIR: keyDir, QED_KEY_FILE: join(keyDir, "qed.kek") };
  Object.assign(process.env, added);
  const port = Number(process.env.QED_TEST_ANVIL_PORT ?? 12881);
  const t = await startRail("cosigner-pipe", port, { cosigner: "process", economyAnvilPort: port + 1 });
  let stopped = false;
  try {
    await t.ready();
    const railDir = join(t.dir, "rail");
    const child = t.rail.cosigner as unknown as { pid: number | null };
    assert.ok(child.pid && child.pid !== process.pid, "a different operating-system process");
    noKeySetting(child.pid, "first start");

    // the keys exist only sealed, and they are the ones the co-signer signs with
    const ring = openKeyring("wallet-secret", { env: { HOME: keysRoot, QED_KEY_DIR: keyDir } });
    const sealedKeys = () => JSON.parse(ring.decrypt(readFileSync(join(railDir, "cosigner.key.sealed")), "qed-wallet-secret:cosigner.key").toString("utf8")) as Record<string, Record<string, `0x${string}`>>;
    const plaintext = () => readdirSync(railDir).filter((f) => f === "cosigner.key" || /cosigner\.key.*\.partial$/.test(f));
    assert.deepEqual(plaintext(), [], "no plaintext key file");
    const first = (await t.rail.state()).roles.cosigner;
    assert.equal(privateKeyToAccount(sealedKeys().baseline!["1"]!).address, first, "stored sealed before its address left the co-signer");

    // it still signs
    const job = await t.act("convert", { amount: "10" });
    assert.equal(job.result?.outcome, "executed", job.error ?? "");

    // killed: the rail starts it again and hands it the same key
    const oldPid = child.pid;
    process.kill(oldPid, "SIGKILL");
    for (let i = 0; (await t.rail.health()).readiness.cosigner; i++) {
      if (i > 50) throw new Error("the rail did not notice the co-signer's death");
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = await t.act("convert", { amount: "5" });
    assert.equal(after.result?.outcome, "executed", after.error ?? "");
    assert.ok(child.pid && child.pid !== oldPid, "a new process");
    assert.equal(await t.rail.cosigner.address(), first, "the same key, handed over again");
    noKeySetting(child.pid, "after a restart of the co-signer");

    // a rotation: the new key is made inside the co-signer and sealed by the rail before the rail learns its address
    const rot = await t.act("rotate-key", { role: "cosigner" });
    assert.equal(rot.result?.outcome, "executed", rot.error ?? "");
    const rotated = (await t.rail.state()).roles.cosigner;
    assert.notEqual(rotated, first);
    assert.equal(privateKeyToAccount(sealedKeys().baseline!["2"]!).address, rotated);
    assert.equal((await t.act("convert", { amount: "5" })).result?.outcome, "executed");
    assert.deepEqual(plaintext(), [], "still no plaintext key file");

    // the whole rail restarts: the rotated key is still the co-signer, and it signs
    await t.stop({ keep: true });
    stopped = true;
    const again = await startRail("cosigner-pipe", port, { dataDir: t.dir, cosigner: "process", economyAnvilPort: port + 1 });
    try {
      assert.equal((await again.rail.state()).roles.cosigner, rotated, "the rotated key after a restart");
      assert.equal((await again.act("convert", { amount: "5" })).result?.outcome, "executed");
      const p = (again.rail.cosigner as unknown as { pid: number | null }).pid!;
      noKeySetting(p, "after a restart of the rail");
      assert.deepEqual(plaintext(), [], "never a plaintext key file");
    } finally { await again.stop(); }
  } finally {
    if (!stopped) await t.stop();
    for (const k of Object.keys(added)) delete process.env[k];
    rmSync(keysRoot, { recursive: true, force: true });
  }
});
