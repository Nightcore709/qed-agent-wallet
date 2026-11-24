/**
 * F-085: the release's benchmarks B1 to B5 (vendor/benchmarks/run.ts, unmodified) re-run with their fixed seeds give
 * exactly the recorded vendor/benchmarks/results.json, byte for byte. The runner reads the recorded Sepolia evidence
 * (B5) from `evidence/` and writes `benchmarks/results.json`, both under its working folder; it runs in a temporary folder
 * that links `evidence/` to the vendored one, so the vendored tree is read and never written. No chain, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN } from "./helpers.ts";

test("F-085: the release's benchmarks B1 to B5, re-run with fixed seeds, reproduce results.json byte for byte", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "qed-f085-"));
  try {
    mkdirSync(join(dir, "benchmarks"));
    symlinkSync(join(CHAIN, "vendor", "evidence"), join(dir, "evidence"));
    // tsx as this package resolves it: the temporary folder has no node_modules of its own
    execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(CHAIN, "vendor", "benchmarks", "run.ts")], { cwd: dir, env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["ignore", "pipe", "pipe"], timeout: 280_000 });
    const got = readFileSync(join(dir, "benchmarks", "results.json"), "utf8"), want = readFileSync(join(CHAIN, "vendor", "benchmarks", "results.json"), "utf8");
    assert.equal(got.length, want.length, "the same length");
    assert.ok(got === want, "results.json reproduced byte for byte");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
