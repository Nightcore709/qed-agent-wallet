/**
 * K2: the verification kernel's one entry point (shared/kernel/index.ts; apps/qed-demo/KERNEL.md).
 *
 * Behaviour unchanged: every name the entry point exports is the very object its defining module exports, so a caller
 * that moved to the entry point runs the same code on every input. The callers' own suites (x5.test.ts and
 * checkerB.test.ts on 255 fixtures each, coverage.test.ts, the programs and lab tests, chain/test/authority.test.ts on
 * the reference's 400 sequences) run unchanged against it.
 *
 * One entry point: no module outside the kernel imports a kernel module except through it; the server, the lab and
 * the co-signer's ledger import it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as rule from '../../chain/rail/authority.ts'
import * as k1 from '../../chain/rail/earned-authority.ts'
import * as B from './checkerB.ts'
import * as cov from './coverage.ts'
import * as kernel from './index.ts'
import * as x5 from './x5.ts'

const APP = join(import.meta.dirname, '..', '..')

describe('the kernel entry point (K2)', () => {
  it('re-exports each function and constant unchanged: the same objects as the modules that define them', () => {
    const same: [string, unknown, unknown][] = [
      ['exactCheck', kernel.exactCheck, x5.exactCheck], ['planLedger', kernel.planLedger, x5.ledger], ['planScenarios', kernel.planScenarios, x5.scenarios],
      ['validatePlan', kernel.validatePlan, x5.validatePlan], ['PLAN_KEYS', kernel.PLAN_KEYS, x5.PLAN_KEYS], ['DEBT_KEYS', kernel.DEBT_KEYS, x5.DEBT_KEYS],
      ['X5_DEFAULT', kernel.X5_DEFAULT, x5.X5_DEFAULT], ['ZERO_PLAN', kernel.ZERO_PLAN, x5.ZERO_PLAN],
      ['checkerB', kernel.checkerB, B.checkerB], ['CHECKER_B_AVAILABLE', kernel.CHECKER_B_AVAILABLE, B.CHECKER_B_AVAILABLE],
      ['checkCoverage', kernel.checkCoverage, cov.check], ['COVERAGE_CHECKER_VERSION', kernel.COVERAGE_CHECKER_VERSION, cov.CHECKER_VERSION],
      ['dayNum', kernel.dayNum, cov.dayNum], ['isoOf', kernel.isoOf, cov.isoOf], ['coverageRequestHash', kernel.coverageRequestHash, cov.requestHash],
      ['AuthorityBudget', kernel.AuthorityBudget, rule.AuthorityBudget], ['Refused', kernel.Refused, rule.Refused], ['replayAuthority', kernel.replayAuthority, rule.replay],
      ['RAISING_KINDS', kernel.RAISING_KINDS, rule.RAISING_KINDS], ['CIRCULAR_KINDS', kernel.CIRCULAR_KINDS, rule.CIRCULAR_KINDS],
      ['NUMERAIRE', kernel.NUMERAIRE, rule.NUMERAIRE], ['UNVALUED', kernel.UNVALUED, rule.UNVALUED], ['q', kernel.q, rule.q], ['parseQ', kernel.parseQ, rule.parseQ],
      ['showQ', kernel.showQ, rule.showQ], ['addQ', kernel.addQ, rule.addQ], ['subQ', kernel.subQ, rule.subQ], ['mulQ', kernel.mulQ, rule.mulQ], ['scaleQ', kernel.scaleQ, rule.scaleQ],
      ['cmpQ', kernel.cmpQ, rule.cmpQ], ['floorQ', kernel.floorQ, rule.floorQ], ['ceilQ', kernel.ceilQ, rule.ceilQ], ['band', kernel.band, rule.band], ['exactBand', kernel.exactBand, rule.exactBand],
      ['EarnedLedger', kernel.EarnedLedger, k1.EarnedLedger], ['checkEarnedCap', kernel.checkEarnedCap, k1.checkCap], ['defaultEarnedCap', kernel.defaultEarnedCap, k1.defaultEarnedCap],
      ['DEFAULT_EARNED_CAP', kernel.DEFAULT_EARNED_CAP, k1.DEFAULT_EARNED_CAP],
    ]
    for (const [name, viaKernel, original] of same) {
      expect(original, name).toBeDefined()
      expect(viaKernel, name).toBe(original)
    }
    // and nothing else: an export added to the entry point is added here too, with the module it comes from
    expect(Object.keys(kernel).sort()).toEqual(same.map(([n]) => n).sort())
  })

  it('is the only way in: no module outside the kernel imports a kernel module directly; the server, the lab and the co-signer\'s ledger import the entry point', () => {
    const KERNEL_FILES = ['shared/kernel/', 'chain/rail/authority.ts', 'chain/rail/earned-authority.ts']
    // tooling that compares the coverage checker's internals with the Python checker (the certificates specialist's)
    const TOOLING = ['scripts/coverage-differential.ts']
    const internal = /from\s+['"][^'"]*(?:kernel\/(?:x5|checkerB|coverage|coverageModel|coverageCompare|coverageGen)|rail\/authority|\.\/authority|earned-authority)\.ts['"]/
    const files: string[] = []
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === 'node_modules' || n === 'vendor' || n === '.build' || n.startsWith('.')) continue
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(relative(APP, p))
      }
    }
    for (const d of ['server', 'src', 'shared', 'scripts', 'chain/rail']) walk(join(APP, d))
    const outside = files.filter((f) => !KERNEL_FILES.some((k) => f.startsWith(k)) && !TOOLING.includes(f))
    const bypass = outside.filter((f) => internal.test(readFileSync(join(APP, f), 'utf8')))
    expect(bypass).toEqual([])
    for (const f of ['server/programs.ts', 'server/household.ts', 'server/lab.ts', 'chain/rail/authority-ledger.ts']) expect(readFileSync(join(APP, f), 'utf8'), f).toMatch(/shared\/kernel\/index\.ts['"]/)
    // the co-signer's engine (generated by chain/scripts/fork-cosigner.mjs) reaches C12's rules through that ledger
    expect(readFileSync(join(APP, 'chain/rail/cosigner-engine.ts'), 'utf8')).toMatch(/from "\.\/authority-ledger\.ts"/)
  })
})
