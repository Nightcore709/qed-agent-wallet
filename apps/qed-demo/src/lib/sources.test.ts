/**
 * Every money figure names its source, and no test token reads as money (R7-031, R7-032; audit GL4).
 *
 * A scan of the interface's own source (parsed, not searched): every screen file that formats a money figure is in the
 * registry of src/lib/sources.ts, which the page note under each page is built from, and names the sources its code
 * reads from (test-chain figures, market prices, fund values). A figure of test tokens formatted as rupees must sit with
 * the words "test" in the same element, and the wallet's screens carry the test-chain label inline.
 * The scan finds a fault when there is one (checked below against sources written to fail).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'rolldown/experimental'
import { describe, expect, it } from 'vitest'
import { SCREEN_SOURCES, screenFileOf, SOURCES, sourcesOfPath, TEST_TOKEN_WORDS } from './sources.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
type N = { type: string; start: number; end: number; [k: string]: any }
const kids = (n: N): N[] => { const o: N[] = []; for (const k in n) { const v = n[k]; if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') o.push(x) } else if (v && typeof v.type === 'string') o.push(v) } return o }
const nameOf = (n: N): string => n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' ? `${nameOf(n.object)}.${nameOf(n.property)}` : ''
/** The functions that turn an amount into a money figure for the screen. */
const MONEY = /^(fmt\.(inr|signed|words)|rupees|out|inn|headline|inUnits)$/
/** A chain figure formatted by the wallet's code or by rupee formatting. */
const CHAIN = /\b(treasury|ownerHolds|chainBooks|tINR|tUSD)\b|\bw?\.reserve\b|\bv\.reserve\b/
/** Figures worked out from market prices, and from a fund's published value, as the code names them. */
const MARKET = /\bholdingsValue\b|\bholdingsWorst\b|\blivePrice\b|\bquotes?\b|\bmark\b/
const FUND = /\bnav\b|\binTransit\b|\bunits\b/i

/** The money calls in a tsx source, each with its text, whether it is inside JSX, and the source of its nearest JSX element. */
export function moneyCalls(file: string, src: string): { line: number; arg: string; element: string }[] {
  const prog = parseSync(file, src, { lang: 'tsx' }).program as N
  const out: { line: number; arg: string; element: string }[] = []
  const walk = (n: N, anc: N[]) => {
    if (n.type === 'CallExpression' && MONEY.test(nameOf(n.callee))) {
      const el = [...anc].reverse().find((a) => a.type === 'JSXElement')
      if (el) out.push({ line: src.slice(0, n.start).split('\n').length, arg: src.slice(n.start, n.end), element: src.slice(el.start, el.end) })
    }
    for (const c of kids(n)) walk(c, [...anc, n])
  }
  walk(prog, [])
  return out
}

/** What is wrong with a screen file, by this scan: not registered, or not naming a source its code reads from. */
export function sourceFaults(base: string, src: string, registry: Record<string, string[]>): string[] {
  const faults: string[] = []
  const calls = moneyCalls(base, src)
  if (!calls.length) return faults
  const kinds = registry[base]
  if (!kinds) return [`${base}: formats money (${calls.length} figures) but names no source`]
  for (const k of kinds) if (!(k in SOURCES)) faults.push(`${base}: unknown source "${k}"`)
  if (calls.some((c) => CHAIN.test(c.arg)) && !kinds.includes('chain')) faults.push(`${base}: formats test-chain figures but does not name the test chain`)
  if (calls.some((c) => MARKET.test(c.arg)) && !kinds.some((k) => ['market', 'historical', 'synthetic'].includes(k))) faults.push(`${base}: formats prices but names no market, past or scenario source`)
  if (calls.some((c) => FUND.test(c.arg)) && !kinds.includes('fund')) faults.push(`${base}: formats fund values but does not name the fund value source`)
  // a test-chain figure written as rupees: the same element says "test"
  for (const c of calls) if (CHAIN.test(c.arg) && /^fmt\./.test(c.arg) && !/test|Src kind="chain"/i.test(c.element)) faults.push(`${base}:${c.line}: a test-token figure is formatted as rupees without the word "test" beside it`)
  return faults
}

const files = (d: string): string[] => readdirSync(join(APP, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : /\.tsx$/.test(e.name) ? [join(d, e.name)] : [])

describe('every money figure names its source (R7-031)', () => {
  it('every screen file that formats money is in the registry and names the sources its code reads', () => {
    const faults = files('src/screens').flatMap((f) => sourceFaults(f.split('/').pop()!, readFileSync(join(APP, f), 'utf8'), SCREEN_SOURCES))
    expect(faults).toEqual([])
  })
  it('the registry names only screens that exist', () => {
    const have = new Set(files('src/screens').map((f) => f.split('/').pop()!))
    expect(Object.keys(SCREEN_SOURCES).filter((k) => !have.has(k))).toEqual([])
  })
  it('finds a figure with no source, a test chain unnamed, and a test token shown as rupees', () => {
    const plain = 'export const A = () => <p>{fmt.inr(5)}</p>'
    expect(sourceFaults('A.tsx', plain, {})).toEqual(['A.tsx: formats money (1 figures) but names no source'])
    expect(sourceFaults('A.tsx', plain, { 'A.tsx': ['paper'] })).toEqual([])
    const chain = 'export const A = () => <p>{fmt.inr(Number(v.treasury.balance))}</p>'
    expect(sourceFaults('A.tsx', chain, { 'A.tsx': ['paper'] }).some((f) => /does not name the test chain/.test(f))).toBe(true)
    expect(sourceFaults('A.tsx', chain, { 'A.tsx': ['chain'] })).toEqual([expect.stringMatching(/test-token figure is formatted as rupees/)])
    const labelled = 'export const A = () => <p>{fmt.inr(Number(v.treasury.balance))} in test rupees</p>'
    expect(sourceFaults('A.tsx', labelled, { 'A.tsx': ['chain'] })).toEqual([])
    expect(sourceFaults('A.tsx', 'x = <p>{fmt.inr(o.holdingsValue)}</p>', { 'A.tsx': ['paper'] })[0]).toMatch(/names no market/)
  })
  it('the wallet screens carry the test-chain label inline, and the chain label says what the tokens are not', () => {
    for (const f of ['src/screens/Vault.tsx', 'src/screens/WalletInline.tsx']) expect(readFileSync(join(APP, f), 'utf8'), f).toContain('<Src kind="chain"')
    expect(SOURCES.chain.says).toMatch(/no value/)
    expect(SOURCES.chain.says).toMatch(/not rupees/)
    expect(SOURCES.chain.says).toMatch(/not a security/)
    expect(TEST_TOKEN_WORDS).toMatch(/test/)
  })
  it('a page shows the sources of its screen: the home page names the paper bank and the test chain; a page with no money names none', () => {
    expect(screenFileOf('/')).toBe('Home.tsx')
    expect(sourcesOfPath('/')).toEqual(expect.arrayContaining(['paper', 'chain']))
    expect(screenFileOf('/record/abc')).toBe('Record.tsx')
    expect(screenFileOf('/record/abc/pack')).toBe('DisputePack.tsx')
    expect(sourcesOfPath('/more')).toEqual([])
  })
})
