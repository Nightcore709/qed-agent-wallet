/**
 * R13 S8: the money-format scan. No file of the interface, the server or shared/ writes a household's money with the rupee
 * formatters (`inr`, `inrExact`, `inrCompact`, `fmt.inr`) unless it is a rupee-only feature named here with its reason; every
 * other file writes it through the home-currency formatter (shared/home-money.ts). The list is the codemod's own
 * (scripts/codemod-home-money.py KEEP_RUPEES), so the two cannot drift apart.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [] })
const SOURCES = ['src', 'server', 'shared'].flatMap((d) => files(join(ROOT, d)))

/** Rupee-only features and why they keep the explicit rupee formatters. */
const RUPEE_ONLY: Record<string, string> = {
  'shared/money.ts': 'the rupee formatters themselves',
  'shared/home-money.ts': 'writes the rupee through them, byte for byte', 'src/lib/core.ts': 'fmt.inr stays as the named rupee for the rupee-only screens below',
  
  'server/earn-chain.ts': "the chain rail's test rupees (tINR)", 'server/directory.ts': "the chain rail's test rupees (tINR)", 'server/escrow.ts': 'paper escrow, settled in rupees',
  'server/rfq.ts': 'rupee-quoted order books', 'server/netting.ts': 'the rupee desk', 'server/institutional.ts': 'the rupee desk', 'server/securities-books.ts': 'rupee-quoted securities',
  'server/tax.ts': 'Indian tax, in rupees', 'server/ideas.ts': 'ideas tested on rupee-quoted instruments', 'server/evidence.ts': 'rupee evidence cases',
  'src/ui/earn-chain.tsx': 'test rupees', 'src/ui/earn-directory.tsx': 'test rupees', 'src/ui/earn-terms.tsx': 'test rupees', 'src/ui/vault-ownership.tsx': 'test rupees', 'src/screens/WalletInline.tsx': 'test rupees',
  'src/screens/Earn.tsx': 'test rupees and paper escrow', 'src/screens/Idea.tsx': 'rupee-quoted instruments', 'src/screens/Lab.tsx': 'rupee-quoted instruments', 'src/screens/Desk.tsx': 'the rupee desk',
  'src/screens/Holdings.tsx': 'rupee-quoted holdings', 'src/screens/Watching.tsx': 'the watchlist writes a rupee-quoted instrument\'s price in rupees (a price, not a household balance)', 'src/screens/GrowCompare.tsx': 'rupee-quoted funds', 'src/screens/Tax.tsx': 'Indian tax, in rupees',
}
const RUPEE_CALL = /(?<![\w.$])(?:inr|inrExact|inrCompact)\s*\(|\bfmt\.inr\b/

describe('the money-format scan', () => {
  it('no file writes a household\'s money in rupees unless it is a rupee-only feature, named with its reason', () => {
    const offenders = SOURCES.filter((f) => !(relative(ROOT, f) in RUPEE_ONLY) && RUPEE_CALL.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f))
    expect(offenders).toEqual([])
  })
  it('every named rupee-only file exists and still uses the rupee formatters (a stale entry hides nothing)', () => {
    const stale = Object.keys(RUPEE_ONLY).filter((f) => !/^shared\/(money|home-money)\.ts$|^src\/lib\/core\.ts$/.test(f) && !SOURCES.some((p) => relative(ROOT, p) === f && RUPEE_CALL.test(readFileSync(p, 'utf8'))))
    expect(stale).toEqual([])
  })
  it('the codemod\'s list of rupee-only files is this one', () => {
    const py = readFileSync(join(ROOT, 'scripts', 'codemod-home-money.py'), 'utf8')
    const listed = py.slice(py.indexOf("KEEP_RUPEES = set('''") + 21, py.indexOf("'''.split())")).split(/\s+/).filter(Boolean).sort()
    const mine = Object.keys(RUPEE_ONLY).filter((f) => !/^shared\/(money|home-money)\.ts$/.test(f)).sort()
    expect(listed).toEqual(mine)
  })
  it('a template that puts a rupee sign before a computed figure is a rupee price, named here with its reason', () => {
    // a household's own figure goes through the formatter; these write the price or minimum of a rupee-quoted instrument or the rupee desk
    const found = new Set<string>()
    for (const f of SOURCES) { const rel = relative(ROOT, f); if (rel in RUPEE_ONLY) continue; if (readFileSync(f, 'utf8').split('\n').some((l) => /₹\$\{/.test(l))) found.add(rel) }
    expect([...found].sort()).toEqual(Object.keys(RUPEE_PRICES).sort())
  })
})

/** Files that write a rupee price or minimum of a rupee-quoted instrument, or a rupee leg of the rupee desk. */
const RUPEE_PRICES: Record<string, string> = {
  'src/ui/prices.ts': 'prices of rupee-quoted instruments', 'src/screens/Record.tsx': 'fills and NAVs of rupee-quoted instruments', 'src/screens/Evidence.tsx': 'the evidence cases are in rupees',
  'src/lib/fund-stages.ts': 'fund NAVs', 'server/fx.ts': 'the desk\'s rupee leg', 'server/programs.ts': 'minimum orders and the debt plan, kinds closed to other currencies',
  'server/owner.ts': 'minimum orders of rupee-quoted instruments (orders are closed to other currencies)', 'server/policy.ts': 'cross-checked prices of rupee-quoted instruments',
  'server/execute.ts': 'fund NAVs', 'server/venues.ts': 'venue minimums of rupee-quoted instruments', 'shared/ideaParse.ts': 'ideas, tested on rupee-quoted instruments',
}
