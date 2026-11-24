/**
 * REGISTER.md: the one requirements and evidence register (R7, mandate section 1).
 *
 *   node scripts/register.ts            check; print every problem; exit 1 if there is one
 *   node scripts/register.ts --write    also write REGISTER.md
 *
 * Sources: the inherited rows F-001 to F-086 come from CAPABILITIES.md (checked by scripts/capabilities.ts against
 * chain/PARITY.md) with each row's acceptance check from the release baseline (§7.1 of
 * docs/research/qed-systems-architect/20261118-release-feature-baseline.md); the R7 requirements, the requirements
 * discovered while building and the external dependencies come from register/r7.json.
 *
 * Checked here: unique ids; known sections, statuses and levels; every dependency names an entry or an external
 * dependency; every evidence item exists (a quoted test title must be in the test file, a quoted step in the evidence
 * file); every implementation path of a Met or Partly entry exists; an entry is Met only at or above the level it
 * needs, and (unless a document suffices) only with evidence that ran here. It does not check that the evidence
 * proves the claim: a reader has to.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readCapabilities, type Row } from './capabilities.ts'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(app, '..', '..')
const BASELINE = 'docs/research/qed-systems-architect/20261118-release-feature-baseline.md'
export const STATUSES = ['Met', 'Partly', 'Not met', 'Blocked', 'Owner decision', 'Not applicable'] as const
export const LEVELS = ['P', 'I', 'C', 'E', 'D', 'U', '-'] as const
const RANK: Record<string, number> = { '-': 0, U: 1, D: 2, E: 2, C: 3, I: 4, P: 5 }
const LEVEL_NAMES: Record<string, string> = {
  P: 'product journey in a browser', I: 'integration through the API on an isolated stack', C: 'component or unit test',
  E: 'experiment or research artefact', D: 'document or analysis', U: 'claimed, not verified', '-': 'nothing yet',
}
/** Evidence files written by scripts that drive the interface in a browser. */
// Files written by scripts that drive the integrated application in a real browser, as the browser suite does
const BROWSER_EVIDENCE = new Set(['evidence/20261120-away.json', 'evidence/20261120-accessibility.json', 'evidence/design/clear-final/report.json', 'evidence/design/measures-before/measures.json', 'evidence/design/measures-after/measures.json', 'evidence/design/checks-final/checks.json'])

interface Entry { id: string; section: string; title: string; acceptance: string; implementation: string[]; journey: string; evidence: string[]; deps: string[]; needs: string; level: string; status: string; note?: string }
interface Dependency { id: string; what: string; who: string; unblocks: string[] }
/** A view of readiness: the entries it rests on ("*" for all of them, inherited rows included) and its rule. */
interface View { id: string; title: string; rule: string; entries: string[] | '*' }
interface Source { about: string; dependencies: Dependency[]; sections: { id: string; title: string }[]; entries: Entry[]; views?: View[] }
export interface Register { problems: string[]; /** workspace-only citations, cited but not verified in a release */ notHere: string[]; inherited: (Row & { acceptance: string; level: string })[]; source: Source; markdown: string }

/** The baseline's acceptance check per F-row (the fifth cell of the §7.1 tables). */
function baselineAcceptance(): Map<string, string> {
  const text = readFileSync(join(repo, BASELINE), 'utf8')
  const start = text.indexOf('### 7.1'), end = text.indexOf('\n## 8', start)
  const out = new Map<string, string>()
  for (const line of text.slice(start, end > 0 ? end : undefined).split('\n')) {
    if (!/^\| F-\d{3} \|/.test(line)) continue
    const c = line.trim().replace(/^\|\s*/, '').replace(/\s*\|$/, '').split(' | ').map((x) => x.trim())
    out.set(c[0]!, c[4] ?? '')
  }
  return out
}

const resolve = (p: string): string | null => (existsSync(join(app, p)) ? join(app, p) : existsSync(join(repo, p)) ? join(repo, p) : null)
// The public release (the app without the research workspace) leaves out what the register also cites from the workspace:
// the shared ledgers, standards mappings, research notes and experiments. The workspace runs every check in full; in a
// release a citation of such a path is listed in `notHere` (cited, not verified here), never passed off as checked.
const WORKSPACE = existsSync(join(repo, 'docs', 'shared', 'QED_CONTEXT.md'))
const WORKSPACE_ONLY = /^(\.\.\/\.\.\/)?(docs\/(shared|standards|research|setup|mandate)\/|experiments\/)/
const notHere: string[] = []
// Screenshots are left out of a release too: a cited screenshot folder or image is likewise cited, not verified there.
const SCREENSHOTS = /^evidence\/.*(\/|\.(png|jpe?g))$/
const elsewhere = (p: string): boolean => !WORKSPACE && (WORKSPACE_ONLY.test(p) || SCREENSHOTS.test(p)) && (notHere.push(p), true)

/** Same item syntax as CAPABILITIES.md: `file` or `file` › "start of a test title or step name". */
function checkEvidence(id: string, items: string[], problems: string[]): { ran: boolean; browser: boolean; api: boolean; test: boolean } {
  let ran = false, browser = false, api = false, test = false
  for (const item of items) {
    const m = /^`([^`]+)`(?: › "(.+))?$/.exec(item.trim())
    if (!m) { problems.push(`${id}: evidence item not understood: ${item.slice(0, 80)}`); continue }
    const file = m[1]!, quoted = m[2]?.replace(/"$/, '')
    const path = resolve(file)
    if (!path && elsewhere(file)) { if (!/\.(md)$/.test(file)) { ran = true; test = true } continue }
    if (!path) { problems.push(`${id}: evidence ${file} does not exist`); continue }
    if (quoted) {
      const body = readFileSync(path, 'utf8')
      const isTest = file.endsWith('.test.ts') || file.endsWith('.spec.ts')
      const found = isTest
        ? body.includes(`it('${quoted}`) || body.includes(`it("${quoted}`) || body.includes(`test('${quoted}`) || body.includes(`test("${quoted}`)
        : body.includes(`"${quoted}`) || body.includes(JSON.stringify(quoted).slice(0, -1))
      if (!found) problems.push(`${id}: ${file} has no ${isTest ? 'test' : 'step'} starting "${quoted}"`)
    }
    if (/\.(md)$/.test(file)) continue // a document is not something that ran
    ran = true
    // the R7 browser suite drives the built interface of an isolated stack: product-level evidence
    if (BROWSER_EVIDENCE.has(file) || (file.startsWith('browser/') && file.endsWith('.spec.ts'))) browser = true
    else if (file.startsWith('evidence/')) api = true
    else test = true
  }
  return { ran, browser, api, test }
}

export function buildRegister(): Register {
  const problems: string[] = []
  const caps = readCapabilities()
  problems.push(...caps.problems.map((p) => `CAPABILITIES.md: ${p}`))
  const acc = baselineAcceptance()
  const inherited = caps.rows.map((r) => {
    const items = r.evidence.split('; ')
    const ev = checkEvidence(r.id, items, [])
    const level = ev.browser ? 'P' : ev.api ? 'I' : ev.test || r.evidence.includes('chain/PARITY.md') ? 'C' : '-'
    if (!acc.get(r.id)) problems.push(`${r.id}: no acceptance check found in the baseline`)
    return { ...r, acceptance: acc.get(r.id) ?? '', level }
  })

  const source = JSON.parse(readFileSync(join(app, 'register', 'r7.json'), 'utf8')) as Source
  const ids = new Set<string>([...inherited.map((r) => r.id), ...source.dependencies.map((d) => d.id)])
  const sections = new Set(source.sections.map((s) => s.id))
  for (const e of source.entries) {
    if (ids.has(e.id)) problems.push(`${e.id}: id used twice`)
    ids.add(e.id)
  }
  for (const d of source.dependencies) for (const u of d.unblocks) if (!source.entries.some((e) => e.id === u)) problems.push(`${d.id}: unblocks ${u}, which is not an entry`)
  for (const e of source.entries) {
    if (!sections.has(e.section)) problems.push(`${e.id}: unknown section ${e.section}`)
    if (!(STATUSES as readonly string[]).includes(e.status)) problems.push(`${e.id}: unknown status "${e.status}"`)
    if (!(LEVELS as readonly string[]).includes(e.level)) problems.push(`${e.id}: unknown level "${e.level}"`)
    if (!(LEVELS as readonly string[]).includes(e.needs) || e.needs === '-' || e.needs === 'U') problems.push(`${e.id}: "needs" must be P, I, C, E or D`)
    for (const d of e.deps) if (!ids.has(d)) problems.push(`${e.id}: depends on ${d}, which is not in the register`)
    if (!e.title || !e.acceptance || !e.journey) problems.push(`${e.id}: title, acceptance and journey are required`)
    if (e.status === 'Met' || e.status === 'Partly') for (const p of e.implementation) if (!resolve(p) && !elsewhere(p)) problems.push(`${e.id}: implementation ${p} does not exist`)
    const ev = checkEvidence(e.id, e.evidence, problems)
    const strongest = ev.browser ? 'P' : ev.api ? 'I' : ev.test ? 'C' : e.evidence.length ? 'D' : '-'
    if (RANK[e.level]! > RANK[strongest]! && !(e.level === 'E' && e.evidence.length) && !(e.level === 'U')) problems.push(`${e.id}: level ${e.level} is stronger than its evidence shows (${strongest})`)
    if (e.status === 'Met') {
      if (RANK[e.level]! < RANK[e.needs]!) problems.push(`${e.id}: Met at level ${e.level}, but it needs ${e.needs}`)
      if (!['D', 'E'].includes(e.needs) && !ev.ran) problems.push(`${e.id}: Met, but no evidence that ran here`)
    }
    if (e.status === 'Blocked' && !e.deps.some((d) => d.startsWith('EXT-'))) problems.push(`${e.id}: Blocked, but it names no external dependency`)
  }
  for (const v of source.views ?? []) {
    if (v.entries === '*') continue
    for (const id of v.entries) if (!source.entries.some((e) => e.id === id) && !inherited.some((r) => r.id === id)) problems.push(`${v.id}: lists ${id}, which is not in the register`)
  }
  return { problems, notHere: [...new Set(notHere)], inherited, source, markdown: render(inherited, source) }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
const code = (xs: string[]): string => xs.map((x) => `\`${x}\``).join(', ') || '—'

function render(inherited: Register['inherited'], s: Source): string {
  const out: string[] = []
  out.push('# Requirements and evidence register', '',
    'The one register for QED (R7 mandate, section 1): the 86 capabilities inherited from the approved release, the R7',
    'requirements, the requirements discovered while building, and the external dependencies that block some of them.',
    '**Generated** by `node scripts/register.ts --write` from `CAPABILITIES.md` (inherited rows), the release baseline',
    '(their acceptance checks) and `register/r7.json` (everything else). Edit the sources, not this file; a test fails',
    'when this file and its sources disagree.', '',
    `Levels: ${Object.entries(LEVEL_NAMES).map(([k, v]) => `**${k}** ${v}`).join('; ')}. An entry is Met only at or above`,
    'the level it needs, so a journey verified only by component tests is not Met.', '')

  // summary
  const groups: { name: string; rows: { status: string; level: string }[] }[] = [
    { name: 'Inherited capabilities (F-001 to F-086)', rows: inherited.map((r) => ({ status: r.word === 'Verified' ? 'Met' : r.word === 'Not done' ? 'Not met' : r.word, level: r.level })) },
    ...s.sections.map((sec) => ({ name: sec.title, rows: s.entries.filter((e) => e.section === sec.id) })),
  ]
  out.push('## Summary', '', `| Group | ${STATUSES.join(' | ')} | Entries |`, `|---|${STATUSES.map(() => '---:').join('|')}|---:|`)
  const all: { status: string }[] = []
  for (const g of groups) { all.push(...g.rows); out.push(`| ${g.name} | ${STATUSES.map((st) => g.rows.filter((r) => r.status === st).length).join(' | ')} | ${g.rows.length} |`) }
  out.push(`| **All** | ${STATUSES.map((st) => `**${all.filter((r) => r.status === st).length}**`).join(' | ')} | **${all.length}** |`, '',
    'Inherited rows are counted by their status against the release baseline\'s acceptance check (Verified is counted as',
    'Met). R7 adds gates on top of them (for example R7-030: every core journey on the chain), so an inherited row that is',
    'Met can still be part of an R7 entry that is not.', '')

  if (s.views?.length) {
    const statusOf = (id: string): string => s.entries.find((e) => e.id === id)?.status ?? (() => { const r = inherited.find((x) => x.id === id); return r ? (r.word === 'Verified' ? 'Met' : r.word === 'Not done' ? 'Not met' : r.word) : 'Not met' })()
    out.push('## Three views of readiness', '',
      'Three separate questions, each answered from the same entries. A view is ready only when every entry it lists is Met at',
      'the level it needs; passing one view never passes another.', '',
      `| View | ${STATUSES.slice(0, 5).join(' | ')} | Entries | Ready |`, `|---|${STATUSES.slice(0, 5).map(() => '---:').join('|')}|---:|---|`)
    const listed = (v: View): string[] => (v.entries === '*' ? [...inherited.map((r) => r.id), ...s.entries.map((e) => e.id)] : v.entries)
    for (const v of s.views) {
      const st = listed(v).map(statusOf)
      out.push(`| ${cell(v.title)} | ${STATUSES.slice(0, 5).map((x) => st.filter((y) => y === x).length).join(' | ')} | ${st.length} | ${st.every((x) => x === 'Met' || x === 'Not applicable') ? '**Yes**' : `**No**: ${st.filter((x) => x !== 'Met' && x !== 'Not applicable').length} open`} |`)
    }
    out.push('')
    for (const v of s.views) {
      const ids = listed(v)
      const open = ids.filter((id) => !['Met', 'Not applicable'].includes(statusOf(id)))
      out.push(`### ${v.title}`, '', cell(v.rule), '', v.entries === '*' ? `All ${ids.length} entries. Open: ${open.length}; they are listed in the sections below.` : `Open: ${open.map((id) => `${id} (${statusOf(id)})`).join(', ') || 'none'}. Met: ${ids.filter((id) => statusOf(id) === 'Met').join(', ') || 'none'}.`, '')
    }
  }

  out.push('## External dependencies', '', 'Each blocks the entries it names until the action is taken. Independent preparation is done first.', '',
    '| ID | What is needed | Who | Blocks |', '|---|---|---|---|',
    ...s.dependencies.map((d) => `| ${d.id} | ${cell(d.what)} | ${cell(d.who)} | ${d.unblocks.join(', ')} |`), '')

  for (const sec of s.sections) {
    const rows = s.entries.filter((e) => e.section === sec.id)
    out.push(`## ${sec.title}`, '', '| ID | Requirement | Acceptance | Implementation | Journey | Evidence | Depends on | Level (needs) | Status |', '|---|---|---|---|---|---|---|---|---|')
    for (const e of rows) out.push(`| ${e.id} | ${cell(e.title)} | ${cell(e.acceptance)} | ${code(e.implementation)} | ${cell(e.journey)} | ${cell(e.evidence.join('; ') || '—')} | ${e.deps.join(', ') || '—'} | ${e.level} (${e.needs}) | **${e.status}**${e.note ? `: ${cell(e.note)}` : ''} |`)
    out.push('')
  }

  out.push('## Inherited capabilities', '', 'Implementation, evidence and status are those of `CAPABILITIES.md`; the acceptance check is the baseline\'s.', '',
    '| ID | Capability | Acceptance check (baseline) | Implementation | Evidence | Level | Status |', '|---|---|---|---|---|---|---|')
  for (const r of inherited) out.push(`| ${r.id} | ${cell(r.capability)} | ${cell(r.acceptance)} | ${cell(r.wallet)} (rail: ${r.rail}) | ${cell(r.evidence)} | ${r.level} | ${cell(r.status)} |`)
  out.push('')
  return out.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = buildRegister()
  if (process.argv.includes('--write')) writeFileSync(join(app, 'REGISTER.md'), r.markdown)
  for (const p of r.problems) console.log(`PROBLEM  ${p}`)
  const st = (x: string) => r.source.entries.filter((e) => e.status === x).length
  console.log(`${r.inherited.length} inherited rows and ${r.source.entries.length} R7 and discovered entries; R7: ${STATUSES.map((s) => `${s} ${st(s)}`).join(', ')}; ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}.`)
  process.exit(r.problems.length ? 1 : 0)
}
