import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST, RELEASE_ID, RUNTIME_PATHS, computeIdentity, runtimeIdentity, stage, verifyRoot } from "../scripts/release-identity.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("the source fingerprint is deterministic and independent of timestamps and of the manifest itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "qed-identity-"));
  try {
    const a = computeIdentity(ROOT), b = computeIdentity(ROOT);
    assert.deepEqual(a.missing, []);
    assert.equal(a.digest, b.digest);
    assert.match(a.digest, /^[0-9a-f]{64}$/);
    const staged = stage(ROOT, join(dir, "s"));
    assert.equal(staged.digest, a.digest);
    utimesSync(join(dir, "s", "product/index.html"), new Date(0), new Date(0));
    const again = computeIdentity(join(dir, "s"));
    assert.equal(again.digest, a.digest, "mtime and the manifest file do not change the digest");
    assert.ok(!(MANIFEST in again.files));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the runtime allowlist covers frontend, backend, contract artifacts, circuits, evidence, configuration and lockfile", () => {
  const id = computeIdentity(ROOT);
  for (const f of ["product/index.html", "agent/scripts/demo-server.mjs", "agent/src/sandbox.ts", "agent/src/sandboxClock.ts", "agent/src/abi/contracts.ts",
    "contracts/src/QEDVault.sol", "circuits/build/private_minvar_final.zkey", "circuits/build/private_minvar_js/private_minvar.wasm",
    "evidence/ethereum-sepolia/manifest.json", "verification/sourcify.json", "package.json", "package-lock.json", "Dockerfile", ".dockerignore", "tsconfig.json"])
    assert.ok(f in id.files, `${f} is fingerprinted`);
  for (const f of Object.keys(id.files)) assert.doesNotMatch(f, /^(node_modules|out|cache|lib|review|_ASTRA_HANDOFF|presentation|evidence\/demo-runs)\//);
  assert.ok(RUNTIME_PATHS.includes("relay"));
});

test("verification refuses a changed, missing or extra file and a different release", () => {
  const dir = mkdtempSync(join(tmpdir(), "qed-identity-"));
  try {
    const s = join(dir, "s");
    stage(ROOT, s);
    assert.equal(verifyRoot(s).ok, true);
    assert.equal(runtimeIdentity(s).sourceVerified, true);
    assert.equal(runtimeIdentity(s).releaseId, RELEASE_ID);
    appendFileSync(join(s, "agent/src/sandboxClock.ts"), "\n// edit");
    assert.match(verifyRoot(s).problems.join(), /changed file agent\/src\/sandboxClock\.ts/);
    stage(ROOT, join(dir, "m"));
    unlinkSync(join(dir, "m", "circuits/build/private_minvar_final.zkey"));
    assert.match(verifyRoot(join(dir, "m")).problems.join(), /missing (runtime path|file) circuits\/build\/private_minvar_final\.zkey/);
    stage(ROOT, join(dir, "x"));
    writeFileSync(join(dir, "x", "agent/scripts/backdoor.mjs"), "export {}");
    assert.match(verifyRoot(join(dir, "x")).problems.join(), /unexpected file agent\/scripts\/backdoor\.mjs/);
    // Generated local-chain records and macOS metadata are never part of a release.
    writeFileSync(join(dir, "x", "relay", "outbox-31337.json"), "[]");
    writeFileSync(join(dir, "x", "agent", ".DS_Store"), "");
    assert.ok(!verifyRoot(join(dir, "x")).problems.some((p) => /31337|DS_Store/.test(p)));
    const manifest = JSON.parse(readFileSync(join(dir, "m", MANIFEST), "utf8"));
    writeFileSync(join(dir, "m", MANIFEST), JSON.stringify({ ...manifest, releaseId: "older-release" }));
    assert.match(verifyRoot(join(dir, "m")).problems.join(), /older-release/);
    assert.equal(runtimeIdentity(ROOT).sourceVerified, existsManifest(ROOT));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the image build re-verifies the manifest and the health endpoint reports the embedded identity", () => {
  const docker = read("Dockerfile");
  const copy = docker.indexOf("COPY --chown=node:node . ."), verify = docker.indexOf("RUN node agent/scripts/release-identity.mjs --verify");
  assert.ok(copy > 0 && verify > copy, "manifest verified after the source is copied into the image");
  assert.ok(verify < docker.indexOf("CMD "), "and before the image can start");
  const server = read("agent/scripts/demo-server.mjs");
  assert.match(server, /releaseId:RELEASE_ID,sourceDigest:IDENTITY\.sourceDigest,sourceVerified:IDENTITY\.sourceVerified/);
  assert.match(server, /import \{ RELEASE_ID, runtimeIdentity \} from "\.\/release-identity\.mjs"/);
});

function existsManifest(root) {
  try { readFileSync(join(root, MANIFEST)); return verifyRoot(root).ok; } catch { return false; }
}
