/**
 * Checks CAPABILITIES.md, the one mapping from the release's 86 capabilities to this build, against the files it
 * names, and keeps its Counts section.
 *
 *   node scripts/capabilities.ts            check; prints every problem and exits 1 if there is one
 *   node scripts/capabilities.ts --write    also rewrite the Counts section from the rows
 *
 * What is checked: 86 rows, F-001 to F-086, each once and in order, six cells each; the Rail word of every row is
 * the status word of the same row in chain/PARITY.md, so the two files cannot drift apart; every file a row names
 * exists; every quoted test title is in the test file named before it, and every quoted step is in the evidence
 * file named before it; a row is Verified only if it names something that ran here, or the rail's row is Verified.
 * It does not check that a test proves what the row says. A person has to read the row for that.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RAIL_WORDS = ['Verified', 'Partly', 'Not done', 'Awaiting owner decision', 'Backend', 'Interface']
export const STATUS_WORDS = ['Verified', 'Partly', 'Not done', 'Owner decision']

export interface Row { id: string; capability: string; wallet: string; rail: string; evidence: string; status: string; word: string; section: string }
export interface Capabilities { rows: Row[]; problems: string[]; total: Record<string, number>; block: string; text: string }

const wordOf = (cell: string, words: string[]): string | null => words.find((w) => cell === w || cell.startsWith(`${w} `) || cell.startsWith(`${w}.`) || cell.startsWith(`${w},`) || cell.startsWith(`${w}:`)) ?? null
const cellsOf = (line: string): string[] => line.trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '').split(' | ').map((c) => c.trim())

export function readCapabilities(root: string = app): Capabilities {
  const text = readFileSync(join(root, 'CAPABILITIES.md'), 'utf8')
  const problems: string[] = []
  const railStatus = new Map<string, string>()
  for (const line of readFileSync(join(root, 'chain', 'PARITY.md'), 'utf8').split('\n')) {
    if (!/^\| F-\d{3} \|/.test(line)) continue
    const c = cellsOf(line)
    railStatus.set(c[0]!, wordOf(c[c.length - 1]!, RAIL_WORDS) ?? '?')
  }
  const rows: Row[] = []
  let section = ''
  const cache = new Map<string, string>()
  const read = (p: string): string => { if (!cache.has(p)) cache.set(p, readFileSync(join(root, p), 'utf8')); return cache.get(p)! }
  for (const line of text.split('\n')) {
    const h = /^## (.+)$/.exec(line)
    if (h) { section = h[1]!; continue }
    if (!/^\| F-\d{3} \|/.test(line)) continue
    const c = cellsOf(line)
    if (c.length !== 6) { problems.push(`${c[0]}: ${c.length} cells, expected 6 (a cell may not contain " | ")`); continue }
    const [id, capability, wallet, rail, evidence, status] = c as [string, string, string, string, string, string]
    const word = wordOf(status, STATUS_WORDS)
    if (!word) problems.push(`${id}: the status does not start with one of: ${STATUS_WORDS.join(', ')}`)
    if (!RAIL_WORDS.includes(rail)) problems.push(`${id}: the Rail cell "${rail}" is not one of the rail's status words`)
    else if (railStatus.get(id) !== rail) problems.push(`${id}: Rail says "${rail}" but chain/PARITY.md says "${railStatus.get(id) ?? 'nothing'}"`)

    // every file named anywhere in the row exists
    for (const cell of [wallet, evidence, status]) for (const m of cell.matchAll(/`([A-Za-z0-9_.\/-]+\.(?:ts|tsx|md|json|mjs|sol))`/g)) if (!existsSync(join(root, m[1]!))) problems.push(`${id}: names ${m[1]}, which does not exist`)
    // evidence items: a file, optionally followed by › "the start of a test title or of a step's name"
    let ranHere = false
    for (const item of evidence.split('; ')) {
      const m = /^`([^`]+)`(?: › "(.+)")?$/.exec(item.trim())
      if (!m) { problems.push(`${id}: evidence item not understood: ${item.trim().slice(0, 80)}`); continue }
      const [, file, quoted] = m as unknown as [string, string, string | undefined]
      if (!existsSync(join(root, file))) continue // reported above
      if (file !== 'chain/PARITY.md') ranHere = true
      if (!quoted) continue
      const body = read(file)
      // unit tests (*.test.ts) and the browser journeys (*.spec.ts) are cited by the start of a test's title
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) { if (![`it('`, `it("`, `test('`, `test("`].some((p) => body.includes(`${p}${quoted}`))) problems.push(`${id}: no test in ${file} has a title starting "${quoted}"`) }
      else if (!body.includes(`"${quoted}`) && !body.includes(JSON.stringify(quoted).slice(0, -1))) problems.push(`${id}: ${file} has no step or check starting "${quoted}"`)
    }
    if (word === 'Verified' && !ranHere && rail !== 'Verified') problems.push(`${id}: Verified, but it names nothing that ran here and the rail's row is "${rail}"`)
    rows.push({ id, capability, wallet, rail, evidence, status, word: word ?? '?', section })
  }
  const want = Array.from({ length: 86 }, (_, i) => `F-${String(i + 1).padStart(3, '0')}`)
  if (rows.map((r) => r.id).join(',') !== want.join(',')) problems.push(`rows are not exactly F-001 to F-086 in order (found ${rows.length})`)

  const total: Record<string, number> = Object.fromEntries(STATUS_WORDS.map((w) => [w, 0]))
  for (const r of rows) total[r.word] = (total[r.word] ?? 0) + 1
  const sections = [...new Set(rows.map((r) => r.section))]
  const block = [
    `| Section | ${STATUS_WORDS.join(' | ')} | Rows |`, `|---|${STATUS_WORDS.map(() => '---:').join('|')}|---:|`,
    ...sections.map((s) => { const rs = rows.filter((r) => r.section === s); return `| ${s} | ${STATUS_WORDS.map((w) => rs.filter((r) => r.word === w).length).join(' | ')} | ${rs.length} |` }),
    `| **All** | ${STATUS_WORDS.map((w) => `**${total[w]}**`).join(' | ')} | **${rows.length}** |`,
    '', `Of the ${total.Verified} Verified rows, ${rows.filter((r) => r.word === 'Verified' && !/`(server|shared|evidence)\//.test(r.evidence)).length} rest on the rail's register alone (the wallet reaches them through the Vault and nothing of the wallet's own ran them).`,
  ].join('\n')
  return { rows, problems, total, block, text }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const c = readCapabilities()
  if (process.argv.includes('--write')) {
    const next = c.text.replace(/<!-- counts:start -->[\s\S]*<!-- counts:end -->/, `<!-- counts:start -->\n${c.block}\n<!-- counts:end -->`)
    if (next !== c.text) writeFileSync(join(app, 'CAPABILITIES.md'), next)
  }
  for (const p of c.problems) console.log(`PROBLEM  ${p}`)
  console.log(`${c.rows.length} rows; ${STATUS_WORDS.map((w) => `${w} ${c.total[w]}`).join(', ')}; ${c.problems.length} problem${c.problems.length === 1 ? '' : 's'}.`)
  process.exit(c.problems.length ? 1 : 0)
}
