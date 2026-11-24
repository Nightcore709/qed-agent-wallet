/**
 * The rail's own TypeScript must be erasable (types only): Node 26 can then strip it without a transpiler, and the
 * backend can import types.ts, terms.ts and language/index.ts directly. Vendored release code is exempt; that is
 * why it needs the tsx loader. Uses Node's own strip-only checker, so the rule is exactly Node's.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = [];
const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
for (const f of ["serve.ts", "types.ts", "terms.ts"]) try { statSync(join(PKG, f)); files.push(join(PKG, f)); } catch { /* not written yet */ }
for (const d of ["rail", "language", "test"]) try { walk(join(PKG, d)); } catch { /* not written yet */ }
const bad = [];
for (const f of files) {
  try { stripTypeScriptTypes(readFileSync(f, "utf8"), { mode: "strip" }); } catch (e) { bad.push(`${f.slice(PKG.length + 1)}: ${String(e.message).split("\n")[0]}`); }
}
console.log(bad.length ? `NOT ERASABLE (${bad.length}):\n  ${bad.join("\n  ")}` : `erasable TypeScript only: ${files.length} files checked`);
process.exit(bad.length ? 1 : 0);
