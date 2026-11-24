#!/usr/bin/env node
/**
 * Writes the artifacts the local chain deploys (rail/bounties.ts reads them; nothing builds at run time), from the
 * Forge build in out/:
 *
 *   artifacts/QEDBountyBoard.json     the board: ABI, creation bytecode, the source's sha256 and the compiler settings
 *   artifacts/PositiveControls.json   the release's own positive controls (AcceptAnything, UnsoundMaximality) from the
 *                                     unmodified vendored suite vendor/contracts/test/Bounties.t.sol, for TESTS ONLY
 *                                     (QED_RAIL_BOUNTY_CONTROLS=1); the served wallet never opens them otherwise
 *
 * and checks that Forge's build of the release contracts the rail deploys from the release's embedded bytecode
 * (vendor/agent/src/abi/contracts.ts) is byte-identical to it, so that the Forge tests exercise exactly those judges.
 *
 *   SOLC_VERSION=0.8.26 forge build && node scripts/export-artifacts.mjs           write the artifacts
 *   SOLC_VERSION=0.8.26 forge build && node scripts/export-artifacts.mjs --check   compare only; exit 1 on any difference
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(HERE, "..", "vendor");
const check = process.argv.includes("--check");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const out = (file, name) => {
  const p = join(HERE, "out", file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`${p} is missing: run SOLC_VERSION=0.8.26 forge build first`);
  return JSON.parse(readFileSync(p, "utf8"));
};
const COMPILER = { solc: "0.8.26", evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true, bytecodeHash: "none", cborMetadata: false };
const forge = execFileSync("forge", ["--version"], { encoding: "utf8" }).split("\n")[0].trim();

const boardSource = readFileSync(join(HERE, "src", "QEDBountyBoard.sol"));
const board = out("QEDBountyBoard.sol", "QEDBountyBoard");
const boardArtifact = {
  contract: "QEDBountyBoard",
  source: "chain/bounties/src/QEDBountyBoard.sol",
  sourceSha256: sha256(boardSource),
  compiler: COMPILER,
  builtWith: forge,
  note: "Local research contract (R11 section 9). Deployed only on the wallet's local Anvil chain by rail/bounties.ts. Regenerate with scripts/export-artifacts.mjs after any change to the source; chain/test/bounties.test.ts checks the source hash.",
  abi: board.abi,
  bytecode: board.bytecode.object,
  bytecodeSha256: sha256(board.bytecode.object.toLowerCase()),
};

const suite = readFileSync(join(VENDOR, "contracts", "test", "Bounties.t.sol"));
const controls = {
  source: "chain/vendor/contracts/test/Bounties.t.sol (the release's suite, unmodified)",
  sourceSha256: sha256(suite),
  compiler: COMPILER,
  builtWith: forge,
  note: "TEST ONLY. The release's positive controls: a verifier that accepts anything, and a netting rule that under-reports by 7 tUSD. A bounty judged by either can be claimed. rail/bounties.ts opens them only when QED_RAIL_BOUNTY_CONTROLS=1, labelled as positive controls.",
  contracts: Object.fromEntries(["AcceptAnything", "UnsoundMaximality"].map((n) => {
    const a = out("Bounties.t.sol", n);
    return [n, { abi: a.abi, bytecode: a.bytecode.object, bytecodeSha256: sha256(a.bytecode.object.toLowerCase()) }];
  })),
};

// The release's embedded bytecode against Forge's build of the same vendored sources.
const embedded = readFileSync(join(VENDOR, "agent", "src", "abi", "contracts.ts"), "utf8");
const embeddedOf = (name) => {
  const m = embedded.match(new RegExp(`export const ${name}Bytecode = "(0x[0-9a-fA-F]+)"`));
  if (!m) throw new Error(`no ${name}Bytecode in the release's embedded ABI module`);
  return m[1].toLowerCase();
};
const identity = [
  ["OptimalityBounty.sol", "OptimalityBounty"],
  ["MaximalityBounty.sol", "MaximalityBounty"],
  ["MinVarianceVerifier.sol", "MinVarianceVerifier"],
  ["TestUSD.sol", "TestUSD"],
].map(([file, name]) => {
  const built = out(file, name).bytecode.object.toLowerCase();
  return { contract: name, identical: built === embeddedOf(name), forgeSha256: sha256(built), embeddedSha256: sha256(embeddedOf(name)) };
});

let problems = 0;
for (const r of identity) {
  console.log(`${r.identical ? "identical" : "DIFFERENT"}  ${r.contract}: Forge build ${r.forgeSha256.slice(0, 16)} vs release embedded ${r.embeddedSha256.slice(0, 16)}`);
  if (!r.identical) problems++;
}
const files = [["QEDBountyBoard.json", boardArtifact], ["PositiveControls.json", controls]];
for (const [name, value] of files) {
  const path = join(HERE, "artifacts", name);
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (check) {
    const same = existsSync(path) && readFileSync(path, "utf8") === text;
    console.log(`${same ? "up to date" : "STALE"}  artifacts/${name}`);
    if (!same) problems++;
  } else {
    writeFileSync(path, text);
    console.log(`wrote artifacts/${name} (${text.length} bytes; bytecode sha256 ${(value.bytecodeSha256 ?? "").slice(0, 16) || "per contract"})`);
  }
}
console.log(`board source sha256 ${boardArtifact.sourceSha256}; board bytecode sha256 ${boardArtifact.bytecodeSha256}`);
process.exit(problems ? 1 : 0);
