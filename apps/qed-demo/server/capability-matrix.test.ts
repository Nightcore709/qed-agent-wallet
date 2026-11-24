/**
 * The capability matrix carries the architecture, integration and execution columns beside the jurisdiction ones
 * (audit GL7, R10-002): every capability the jurisdiction matrix names has a row here; every row says what it is
 * built on, what it is connected to, what ran, and what it still needs; every row that claims execution names evidence
 * that exists; and no row claims a real integration (D-070).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MATRIX_FILE } from './legal.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(APP, '..', '..')
const FILE = join(ROOT, 'docs', 'research', 'qed-engineer', '20261124-capability-matrix.json')
interface Row { id: string; journeys: string[]; architecture: string; integration: string[]; evidence: string[]; execution: string; dependencies: string[] }
const matrix = (): { meta: { real_integrations: string }; capabilities: Row[] } => JSON.parse(readFileSync(FILE, 'utf8'))
const jurisdiction = (): { id: string; name: string }[] => (JSON.parse(readFileSync(MATRIX_FILE, 'utf8')) as { capabilities: { id: string; name: string }[] }).capabilities

describe('the capability matrix has its architecture, integration and execution columns', () => {
  it('has a row for every capability of the jurisdiction matrix, and none for a capability it does not name', () => {
    expect(matrix().capabilities.map((c) => c.id)).toEqual(jurisdiction().map((c) => c.id))
  })
  it('fills every column of every row', () => {
    for (const c of matrix().capabilities) {
      expect(c.architecture.length, `${c.id} architecture`).toBeGreaterThan(10)
      expect(c.integration.length, `${c.id} integration`).toBeGreaterThan(0)
      expect(c.execution.length, `${c.id} execution`).toBeGreaterThan(0)
      expect(c.dependencies.length, `${c.id} dependencies`).toBeGreaterThan(0)
    }
  })
  it('names evidence that exists for every row that claims something ran, and none for a row that says none', () => {
    for (const c of matrix().capabilities) {
      const claims = !/^none/.test(c.execution)
      if (claims) expect(c.evidence.length, `${c.id} claims execution without evidence`).toBeGreaterThan(0)
      else expect(c.evidence, `${c.id} says none but lists evidence`).toEqual([])
      for (const e of c.evidence) expect(existsSync(join(APP, e)), `${c.id}: ${e}`).toBe(true)
    }
  })
  it('claims no real integration: every connection is paper, the local chain, a scripted economy, read-only observation or none', () => {
    expect(matrix().meta.real_integrations).toMatch(/^none/)
    for (const c of matrix().capabilities) for (const i of c.integration) expect(i, `${c.id}: ${i}`).toMatch(/paper|chain|scripted|observed|read only|none/i)
  })
  it('names journeys that the architecture note defines', () => {
    const note = readFileSync(join(ROOT, 'docs', 'research', 'qed-systems-architect', '20261123-capability-matrix.md'), 'utf8')
    for (const c of matrix().capabilities) for (const j of c.journeys) expect(note, `${c.id}: ${j}`).toContain(`| ${j} |`)
  })
})
