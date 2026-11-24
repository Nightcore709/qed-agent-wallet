/**
 * agent/scripts/local.ts (the scripted-economy runner behind /api/run) must always use a fresh Anvil chain and
 * must not leave one behind. Found 23 Oct 2026: a runner stopped with SIGTERM orphaned its Anvil on the port, and
 * every later run silently reused that stale chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const listening = (port) => new Promise((resolve) => {
  const s = connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
function runner(port, script) {
  const child = spawn(process.execPath, ["--import", "tsx", "agent/scripts/local.ts"], {
    env: { ...process.env, ANVIL_PORT: String(port), KEYS_FILE: "/nonexistent", SCRIPT: script, QED_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, log: () => out };
}

test("the runner refuses a port that already has a chain instead of reusing it", { timeout: 60_000 }, async () => {
  const blocker = createServer().listen(18693, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    const r = runner(18693, "agent/scripts/fixtures.ts");
    const { code } = await r.exited;
    assert.equal(code, 1);
    assert.match(r.log(), /FATAL Anvil port 18693 is already in use; refusing to run on an existing chain/);
  } finally {
    blocker.close();
  }
});

test("stopping the runner also stops its Anvil chain and its scenario process", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "qed-runner-"));
  const marker = join(dir, "scenario.pid");
  const script = join(dir, "wait.mjs");
  writeFileSync(script, `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},String(process.pid));setTimeout(()=>{},60000);`);
  const r = runner(18694, script);
  try {
    let pid;
    for (let i = 0; i < 200 && !pid; i++) {
      await sleep(100);
      try { pid = Number((await import("node:fs")).readFileSync(marker, "utf8")); } catch {}
    }
    assert.ok(pid, `scenario started: ${r.log()}`);
    assert.equal(await listening(18694), true, "runner's Anvil is up");
    r.child.kill("SIGTERM");
    const { code } = await r.exited;
    assert.equal(code, 143);
    let anvilUp = true;
    for (let i = 0; i < 50 && anvilUp; i++) { await sleep(100); anvilUp = await listening(18694); }
    assert.equal(anvilUp, false, "Anvil was stopped with the runner");
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) { await sleep(100); try { process.kill(pid, 0); } catch { alive = false; } }
    assert.equal(alive, false, "scenario process was stopped with the runner");
  } finally {
    r.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
