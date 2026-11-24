/**
 * Counts the parity register (PARITY.md) by status word, per section and in total, and checks what the owner's rule
 * asks of it: a row is Verified only if something ran. So every row whose status starts with "Verified" must name a
 * test, and every test the register names must exist.
 *
 *   node scripts/parity-counts.mjs           print the counts and any problem; exit 1 on a problem
 *   node scripts/parity-counts.mjs --write   also rewrite the block between the counts markers in PARITY.md
 *
 * Reference forms it understands in the Evidence column:
 *   `core.test.ts` › "conversion: the eight visible steps"   a test of this package whose title starts with these words
 *   `quota.test.ts`                                          a whole test file of this package
 *   gate `QEDVault.t.sol` 36/36                              a suite of the release, run unmodified in the parity gate
 *
 * It does not run anything and cannot tell whether a test exercises what its row says; that was checked by reading
 * (see "How this register was checked" in PARITY.md). test/contract.test.ts runs these checks with every `npm test`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const STATUS_WORDS = ["Verified", "Partly", "Not done", "Awaiting owner decision", "Backend", "Interface"];
export const START = "<!-- parity-counts:start (written by scripts/parity-counts.mjs --write; do not edit by hand) -->";
export const END = "<!-- parity-counts:end -->";

const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [e.name])) : []);

export function readParity(pkg = PKG) {
  const text = readFileSync(join(pkg, "PARITY.md"), "utf8");
  const problems = [];
  const sections = [];
  const rows = [];
  let section = null;
  for (const line of text.split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) { section = /^[A-Z][.,]/.test(h[1]) ? { name: h[1], counts: Object.fromEntries(STATUS_WORDS.map((w) => [w, 0])), rows: 0 } : null; if (section) sections.push(section); continue; }
    const m = /^\| (F-\d{3}) \|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const cells = m[2].split(" | ").map((c) => c.trim());
    if (cells.length !== 3) { problems.push(`${m[1]}: expected four cells, found ${cells.length + 1}`); continue; }
    if (!section) { problems.push(`${m[1]}: row outside a lettered section`); continue; }
    const [, evidence, status] = cells;
    const word = STATUS_WORDS.find((w) => status === w || status.startsWith(`${w} `) || status.startsWith(`${w}:`) || status.startsWith(`${w}.`) || status.startsWith(`${w},`));
    if (!word) { problems.push(`${m[1]}: status does not start with one of the status words: "${status.slice(0, 40)}"`); continue; }
    section.counts[word]++;
    section.rows++;
    rows.push({ id: m[1], evidence, status, word });
  }
  const ids = rows.map((r) => r.id);
  for (let n = 1; n <= 86; n++) { const id = `F-${String(n).padStart(3, "0")}`; const c = ids.filter((x) => x === id).length; if (c !== 1) problems.push(`${id}: appears ${c} times`); }

  // every test the register names must exist; every Verified row must name one
  const mine = new Map(readdirSync(join(pkg, "test")).filter((f) => f.endsWith(".test.ts")).map((f) => [f, [...readFileSync(join(pkg, "test", f), "utf8").matchAll(/^test\("((?:[^"\\]|\\.)*)"/gm)].map((t) => t[1])]));
  const release = new Set([...walk(join(pkg, "vendor", "agent", "test")), ...walk(join(pkg, "vendor", "contracts", "test")), ...walk(join(pkg, "zk-optional", "vendor"))]);
  let named = 0;
  for (const r of rows) {
    const gate = [...r.evidence.matchAll(/gate `([^`]+)`/g)].map((g) => g[1]);
    for (const g of gate) if (!release.has(g) && existsSync(join(pkg, "vendor"))) problems.push(`${r.id}: the gate suite ${g} is not a test file of the vendored release`);
    // a file, then any number of › "title" that belong to it, until the next file is named
    let file = null, own = 0;
    for (const [, f, title] of r.evidence.replace(/gate `[^`]+`/g, "").matchAll(/`([A-Za-z0-9-]+\.test\.ts)`|› "([^"]+)"/g)) {
      if (f) { file = f; own++; named++; if (!mine.has(f)) problems.push(`${r.id}: names ${f}, which is not a test file of this package`); continue; }
      if (!file) { problems.push(`${r.id}: the title "${title}" follows no test file`); continue; }
      if (mine.has(file) && !mine.get(file).some((t) => t.startsWith(title))) problems.push(`${r.id}: ${file} has no test whose title starts with "${title}"`);
    }
    if (r.word === "Verified" && !gate.length && !own) problems.push(`${r.id}: Verified, but its evidence names no test`);
  }

  const total = Object.fromEntries(STATUS_WORDS.map((w) => [w, sections.reduce((a, s) => a + s.counts[w], 0)]));
  const line = (name, n, c, bold = false) => `| ${[name, n, ...STATUS_WORDS.map((w) => c[w])].map((x) => (bold ? `**${x}**` : x)).join(" | ")} |`;
  const table = [`| Section | Rows | ${STATUS_WORDS.join(" | ")} |`, `|---|${"---|".repeat(STATUS_WORDS.length + 1)}`, ...sections.map((s) => line(s.name, s.rows, s.counts)), line("All", rows.length, total, true)].join("\n");
  const block = `${START}\n${table}\n${END}`;
  return { text, rows, sections, total, table, block, problems, namedTests: named };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = readParity();
  if (process.argv.includes("--write")) {
    const a = p.text.indexOf(START), b = p.text.indexOf(END);
    if (a < 0 || b < a) { console.error("PARITY.md has no counts markers"); process.exit(1); }
    writeFileSync(join(PKG, "PARITY.md"), p.text.slice(0, a) + p.block + p.text.slice(b + END.length));
  }
  console.log(p.table);
  console.log(`\n${p.rows.length} rows; ${p.namedTests} references to test files of this package${p.problems.length ? "" : ", every file and every quoted title found"}.`);
  if (p.problems.length) { console.error(`\nPROBLEMS (${p.problems.length}):\n  ${p.problems.join("\n  ")}`); process.exit(1); }
}
