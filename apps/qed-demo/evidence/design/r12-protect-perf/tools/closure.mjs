// The static import closure of a source file (relative imports only; `import type` and dynamic import() do not count).
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const root = process.argv[2]
function closure(file, seen = new Set()) {
  if (seen.has(file)) return seen
  seen.add(file)
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm)) {
    const p = resolve(dirname(file), m[1])
    if (existsSync(p)) closure(p, seen)
  }
  return seen
}
for (const s of process.argv.slice(3)) {
  const c = [...closure(join(root, s))].map((f) => f.slice(root.length + 1))
  console.log(s.padEnd(28), c.filter((f) => /Vault\.tsx|WalletInline\.tsx|Protect\.tsx|Security\.tsx/.test(f) && f !== s).join(' ') || '-')
}
