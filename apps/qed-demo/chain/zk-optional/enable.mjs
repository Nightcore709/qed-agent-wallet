/**
 * Enables the optional zero-knowledge module. OFF BY DEFAULT.
 *
 *   node zk-optional/enable.mjs --accept-gpl-3.0 [--release <dir>]     copy the 17 files, verify every hash
 *   node zk-optional/enable.mjs --status                               say whether it is enabled
 *   node zk-optional/enable.mjs --disable                              remove the copied files and build trees
 *
 * What it does: copies the files listed in VENDORED-ZK.json out of the approved release (which is only read) into
 * zk-optional/vendor/, checking each against its recorded SHA-256. That folder is git-ignored. It does not install
 * anything; after it, run `npm ci --ignore-scripts` inside zk-optional/ to install snarkjs and circomlibjs.
 *
 * Why it is separate: these parts are GPL-3.0 (snarkjs, circomlibjs, circomlib templates, the generated
 * Groth16Verifier.sol) or link GPL-3.0 packages, and they come with a single-machine trusted setup. Whether they
 * belong in the product is owner decision F-052. Enabling is a deliberate act and needs the flag below.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const RELEASE = resolve(arg("--release") ?? join(homedir(), "qed-approved-release"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const manifest = JSON.parse(readFileSync(join(HERE, "VENDORED-ZK.json"), "utf8"));
const vendor = join(HERE, "vendor");

function status() {
  const present = manifest.files.filter((e) => existsSync(join(vendor, e.source)));
  const intact = present.filter((e) => sha256(readFileSync(join(vendor, e.source))) === e.sha256);
  return {
    filesListed: manifest.files.length,
    filesPresent: present.length,
    filesIntact: intact.length,
    packagesInstalled: existsSync(join(HERE, "node_modules", "snarkjs")) && existsSync(join(HERE, "node_modules", "circomlibjs")),
    enabled: intact.length === manifest.files.length && existsSync(join(HERE, "node_modules", "snarkjs")) && existsSync(join(HERE, "node_modules", "circomlibjs")),
  };
}

if (args.includes("--status")) {
  console.log(JSON.stringify(status(), null, 1));
} else if (args.includes("--disable")) {
  rmSync(vendor, { recursive: true, force: true });
  rmSync(join(HERE, ".build"), { recursive: true, force: true });
  console.log("zk-optional: copied files and build trees removed. To remove the packages too: rm -rf zk-optional/node_modules");
} else if (args.includes("--accept-gpl-3.0")) {
  if (!existsSync(join(RELEASE, "agent/src/abi/contracts.ts"))) {
    console.error(`Release folder not found at ${RELEASE}`);
    process.exit(1);
  }
  for (const e of manifest.files) {
    const src = join(RELEASE, e.source);
    const buf = readFileSync(src);
    if (sha256(buf) !== e.sha256) {
      console.error(`Refusing: ${e.source} in the release no longer matches its recorded SHA-256.`);
      process.exit(1);
    }
    const out = join(vendor, e.source);
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(src, out);
  }
  const s = status();
  console.log(`zk-optional: ${s.filesIntact}/${s.filesListed} files copied and verified into zk-optional/vendor/ (git-ignored).`);
  console.log(s.packagesInstalled ? "Packages already installed." : "Next: cd zk-optional && npm ci --ignore-scripts   (installs snarkjs 0.7.5 and circomlibjs 0.1.7, GPL-3.0)");
  console.log("Then start the rail with QED_RAIL_ZK=1 to offer the private-portfolio scenario and the privacy economy.");
} else {
  console.error("Nothing done. The zero-knowledge module is GPL-3.0 and off by default.\nTo enable: node zk-optional/enable.mjs --accept-gpl-3.0\nTo inspect: node zk-optional/enable.mjs --status");
  process.exit(2);
}
