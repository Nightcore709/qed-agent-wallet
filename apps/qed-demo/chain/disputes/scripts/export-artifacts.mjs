#!/usr/bin/env node
/**
 * Writes the artifact the local chain deploys (rail/disputes.ts reads it; nothing builds at run time), from the Forge
 * build in out/:
 *
 *   artifacts/QEDDisputeEscrow.json   the dispute escrow: ABI, creation bytecode, the source's sha256 and the compiler
 *
 * and checks that Forge's build of the release's ProofEscrow (the contract the tests put the dispute escrow in front of)
 * is byte-identical to the release's embedded bytecode (vendor/agent/src/abi/contracts.ts), which the rail deploys.
 *
 *   SOLC_VERSION=0.8.26 forge build && node scripts/export-artifacts.mjs           write the artifact
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

const source = readFileSync(join(HERE, "src", "QEDDisputeEscrow.sol"));
const built = out("QEDDisputeEscrow.sol", "QEDDisputeEscrow");
const artifact = {
  contract: "QEDDisputeEscrow",
  source: "chain/disputes/src/QEDDisputeEscrow.sol",
  sourceSha256: sha256(source),
  compiler: COMPILER,
  builtWith: forge,
  note: "Local research contract (R13, audit item E3): a review and dispute step in front of the release's unmodified ProofEscrow. Deployed only on the wallet's local Anvil chain by rail/disputes.ts. Regenerate with scripts/export-artifacts.mjs after any change to the source; chain/test/disputes.test.ts checks the source hash. Not audited.",
  abi: built.abi,
  bytecode: built.bytecode.object,
  bytecodeSha256: sha256(built.bytecode.object.toLowerCase()),
};

const embedded = readFileSync(join(VENDOR, "agent", "src", "abi", "contracts.ts"), "utf8");
const m = embedded.match(/export const ProofEscrowBytecode = "(0x[0-9a-fA-F]+)"/);
if (!m) throw new Error("no ProofEscrowBytecode in the release's embedded ABI module");
const forgeEscrow = out("ProofEscrow.sol", "ProofEscrow").bytecode.object.toLowerCase();
const identical = forgeEscrow === m[1].toLowerCase();
let problems = identical ? 0 : 1;
console.log(`${identical ? "identical" : "DIFFERENT"}  ProofEscrow: Forge build ${sha256(forgeEscrow).slice(0, 16)} vs release embedded ${sha256(m[1].toLowerCase()).slice(0, 16)}`);

const path = join(HERE, "artifacts", "QEDDisputeEscrow.json");
const text = `${JSON.stringify(artifact, null, 1)}\n`;
if (check) {
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  console.log(`${same ? "up to date" : "STALE"}  artifacts/QEDDisputeEscrow.json`);
  if (!same) problems++;
} else {
  writeFileSync(path, text);
  console.log(`wrote artifacts/QEDDisputeEscrow.json (${text.length} bytes; bytecode sha256 ${artifact.bytecodeSha256.slice(0, 16)})`);
}
console.log(`source sha256 ${artifact.sourceSha256}; bytecode sha256 ${artifact.bytecodeSha256}`);
process.exit(problems ? 1 : 0);
