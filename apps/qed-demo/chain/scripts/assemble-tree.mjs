/**
 * Assembles a disposable working copy of the vendored tree, so that nothing ever writes into vendor/.
 *
 *   node scripts/assemble-tree.mjs --dest <dir> [--with-zk] [--link-node-modules]
 *
 * The committed tree (vendor/) is copied file by file; with --with-zk the zk-optional tier is laid over it
 * (zk-optional/vendor/ must have been created by zk-optional/enable.mjs). The copy is then checked against the
 * recorded SHA-256 of every file. Build output, run evidence and Foundry caches land in the copy and are thrown
 * away with it.
 *
 * --link-node-modules adds <dest>/node_modules as a folder of symbolic links to the installed packages of this
 * package (and of zk-optional/ with --with-zk). Only release tests that stage the tree elsewhere need it.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

export function assembleTree({ dest, withZk = false, linkNodeModules = false }) {
  const root = resolve(dest);
  if (!root.startsWith(PKG + "/")) throw new Error("The destination must be inside this package (so that module resolution finds its node_modules).");
  if (root.startsWith(join(PKG, "vendor"))) throw new Error("Refusing to assemble into vendor/.");
  rmSync(root, { recursive: true, force: true });
  const tiers = [{ manifest: join(PKG, "VENDORED.json"), from: join(PKG, "vendor") }];
  if (withZk) {
    const from = join(PKG, "zk-optional", "vendor");
    if (!existsSync(from)) throw new Error("The zk-optional tier is not enabled. Run: node zk-optional/enable.mjs --accept-gpl-3.0");
    tiers.push({ manifest: join(PKG, "zk-optional", "VENDORED-ZK.json"), from });
  }
  let files = 0;
  for (const t of tiers) {
    for (const e of JSON.parse(readFileSync(t.manifest, "utf8")).files) {
      const src = join(t.from, e.source), out = join(root, e.source);
      const buf = readFileSync(src);
      if (sha256(buf) !== e.sha256) throw new Error(`vendored file changed since it was recorded: ${e.source}`);
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(src, out);
      files++;
    }
  }
  if (linkNodeModules) {
    const nm = join(root, "node_modules");
    mkdirSync(nm, { recursive: true });
    const sources = [join(PKG, "node_modules"), ...(withZk ? [join(PKG, "zk-optional", "node_modules")] : [])];
    for (const src of sources) {
      if (!existsSync(src)) continue;
      for (const name of readdirSync(src)) {
        if (name.startsWith(".") && name !== ".bin") continue;
        if (name.startsWith("@")) {
          mkdirSync(join(nm, name), { recursive: true });
          for (const sub of readdirSync(join(src, name))) if (!existsSync(join(nm, name, sub))) symlinkSync(join(src, name, sub), join(nm, name, sub));
        } else if (!existsSync(join(nm, name))) symlinkSync(join(src, name), join(nm, name));
      }
    }
  }
  return { root, files, withZk };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (!arg("--dest")) throw new Error("usage: node scripts/assemble-tree.mjs --dest <dir> [--with-zk] [--link-node-modules]");
    console.log(JSON.stringify(assembleTree({ dest: arg("--dest"), withZk: args.includes("--with-zk"), linkNodeModules: args.includes("--link-node-modules") })));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
