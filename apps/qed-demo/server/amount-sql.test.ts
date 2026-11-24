/**
 * Stage S3 of the global money model (ADR-0012): every SQL sum over an amount goes through amount_sum, an exact aggregate
 * registered on every connection; SQLite's own SUM is not used on an amount anywhere in the server.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fromAmountText } from '../shared/amount-text.ts'
import { registerAmountSql } from './amount-sql.ts'
import { openDb } from './core.ts'

const mem = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); registerAmountSql(d); return d }
const one = (d: DatabaseSync, sql: string, ...p: (string | number | bigint | null | Uint8Array)[]): unknown => (d.prepare(sql).get(...p) as { s: unknown } | undefined)?.s

describe('amount_sum: an exact sum of amounts, as text', () => {
  it('adds past 2^63 exactly, from text and from INTEGER columns, where SQLite\'s SUM fails or rounds', () => {
    const d = mem()
    d.exec('CREATE TABLE t (g TEXT, a INTEGER, x TEXT)')
    const ins = d.prepare('INSERT INTO t VALUES (?, ?, ?)')
    ins.run('g', 9_000_000_000_000_000_000n, '100000000000000000001')
    ins.run('g', 9_000_000_000_000_000_000n, '1')
    expect(one(d, 'SELECT amount_sum(a) s FROM t')).toBe('18000000000000000000')
    expect(one(d, 'SELECT amount_sum(x) s FROM t')).toBe('100000000000000000002')
    expect(() => one(d, 'SELECT SUM(a) s FROM t')).toThrow(/integer overflow/)
    expect(one(d, 'SELECT SUM(x) s FROM t')).toBe(1e20) // SQLite's own SUM over the text: a float, two units short
  })

  it('skips NULL as SUM does, and the sum of nothing is "0" rather than NULL', () => {
    const d = mem()
    d.exec(`CREATE TABLE t (g TEXT, x TEXT); INSERT INTO t VALUES ('a', NULL), ('b', '-7'), ('b', NULL)`)
    expect(one(d, `SELECT amount_sum(x) s FROM t WHERE g = 'a'`)).toBe('0')
    expect(one(d, `SELECT amount_sum(x) s FROM t WHERE g = 'none'`)).toBe('0')
    expect(d.prepare('SELECT g, amount_sum(x) s FROM t GROUP BY g ORDER BY g').all().map((r) => ({ ...r }))).toEqual([{ g: 'a', s: '0' }, { g: 'b', s: '-7' }])
    expect(d.prepare('SELECT g, (SELECT amount_sum(x) FROM t i WHERE i.g = o.g) s FROM t o GROUP BY g ORDER BY g').all().map((r) => ({ ...r }))).toEqual([{ g: 'a', s: '0' }, { g: 'b', s: '-7' }])
  })

  it('agrees with BigInt addition for any mix of text and INTEGER inputs (property)', () => {
    const amount = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n })
    const int64 = fc.bigInt({ min: -(2n ** 62n), max: 2n ** 62n })
    fc.assert(fc.property(fc.array(amount, { maxLength: 30 }), fc.array(int64, { maxLength: 30 }), (texts, ints) => {
      const d = mem()
      d.exec('CREATE TABLE t (a INTEGER, x TEXT)')
      for (const v of texts) d.prepare('INSERT INTO t (x) VALUES (?)').run(v.toString())
      for (const v of ints) d.prepare('INSERT INTO t (a) VALUES (?)').run(v)
      const ok = fromAmountText(one(d, 'SELECT amount_sum(x) s FROM t')) === texts.reduce((s, v) => s + v, 0n)
        && fromAmountText(one(d, 'SELECT amount_sum(a) s FROM t')) === ints.reduce((s, v) => s + v, 0n)
      d.close()
      return ok
    }), { numRuns: 200 })
  })

  it('never throws inside SQLite (Node 22 swallows an error raised there and returns no row); a value that is not an amount gives a refusal that readers reject', () => {
    const d = mem()
    for (const [sql, why] of [
      ['SELECT amount_sum(1.5) s', /a REAL value \(1\.5\)/],
      [`SELECT amount_sum('007') s`, /text that is not canonical \("007"\)/],
      [`SELECT amount_sum('-0') s`, /text that is not canonical/],
      [`SELECT amount_sum(x'35') s`, /a BLOB/],
    ] as const) {
      const s = one(d, sql)
      expect(typeof s, sql).toBe('string')
      expect(s, sql).toMatch(/^amount_sum refused /)
      expect(s, sql).toMatch(why)
      expect(() => fromAmountText(s, 'the sum'), sql).toThrow(/the sum is not an amount.*amount_sum refused/)
    }
    // The first refusal is kept, whatever follows it.
    d.exec(`CREATE TABLE t (i INTEGER, x); INSERT INTO t VALUES (1, '5'), (2, 2.5), (3, '6'), (4, 'abc')`)
    expect(one(d, 'SELECT amount_sum(x) s FROM (SELECT x FROM t ORDER BY i)')).toMatch(/a REAL value \(2\.5\)/)
    // A refused group is kept by a "!= '0'" filter, so a reader meets it and refuses it, rather than losing it.
    expect(d.prepare(`SELECT i FROM t GROUP BY i HAVING amount_sum(x) != '0' ORDER BY i`).all().map((r) => (r as { i: number }).i)).toEqual([1, 2, 3, 4])
  })

  it('is registered on every connection openDb makes, in memory and on file', () => {
    const d = openDb(':memory:')
    try { expect(d.get<{ s: string }>(`SELECT amount_sum(x) s FROM (SELECT '1' x UNION ALL SELECT '2')`)).toEqual({ s: '3' }) } finally { d.close() }
  })

  it('cannot be built into the schema (a view, a trigger or a CHECK), so any SQLite client can still open and check the database', () => {
    const d = mem()
    d.exec(`CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('1'); CREATE VIEW v AS SELECT amount_sum(x) s FROM t`)
    expect(() => d.prepare('SELECT s FROM v').get()).toThrow(/unsafe use of amount_sum/)
  })

  it('refuses a runtime that cannot register an aggregate, rather than fall back to SQLite\'s SUM', () => {
    expect(() => registerAmountSql({} as DatabaseSync)).toThrow(/amount_sum.*aggregate/)
  })
})

// ------------------------------------------------------------------------------------------------ the scan

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'server/amount-sql.test.ts'

/**
 * The text of every string and template literal in a TypeScript file (where its SQL is) and of every comment. A template's
 * `${…}` parts are code, read recursively; a regular expression literal is skipped. JavaScript outside literals (a helper
 * named sum(), say) is not SQL.
 */
function scanSource(src: string): { literals: string[]; comments: string[] } {
  const literals: string[] = [], comments: string[] = []
  let i = 0
  const regexMayStart = (): boolean => {
    let k = i - 1
    while (k >= 0 && /\s/.test(src[k]!)) k--
    if (k < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(src[k]!)) return true
    const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, k - 12), k + 1))?.[1]
    return !!word && ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'].includes(word)
  }
  const code = (stopAtBrace: boolean): void => {
    let depth = 0
    while (i < src.length) {
      const c = src[i]!, n = src[i + 1]
      if (c === '/' && n === '/') { const e = src.indexOf('\n', i); comments.push(src.slice(i, e < 0 ? src.length : e)); i = e < 0 ? src.length : e; continue }
      if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); comments.push(src.slice(i, e < 0 ? src.length : e + 2)); i = e < 0 ? src.length : e + 2; continue }
      if (c === '/' && regexMayStart()) {
        let inClass = false
        for (i++; i < src.length && src[i] !== '\n'; i++) {
          if (src[i] === '\\') { i++; continue }
          if (src[i] === '[') inClass = true
          else if (src[i] === ']') inClass = false
          else if (src[i] === '/' && !inClass) { i++; break }
        }
        continue
      }
      if (c === "'" || c === '"') { i++; let s = ''; while (i < src.length && src[i] !== c) { if (src[i] === '\\') { s += src[i + 1] ?? ''; i += 2 } else s += src[i++] } i++; literals.push(s); continue }
      if (c === '`') { i++; template(); continue }
      if (stopAtBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { i++; return } depth-- } }
      i++
    }
  }
  const template = (): void => {
    let s = ''
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1] ?? ''; i += 2 } else if (src[i] === '$' && src[i + 1] === '{') { i += 2; s += '?'; code(true) } else s += src[i++]
    }
    i++
    literals.push(s)
  }
  code(false)
  return { literals, comments }
}
const literals = (src: string): string[] => scanSource(src).literals

/** Every SQLite aggregate call that sums an amount the inexact way, with its argument. */
function inexactSums(sql: string): { fn: string; arg: string }[] {
  const found: { fn: string; arg: string }[] = []
  for (const m of sql.matchAll(/(?<![\w.])(sum|total|avg)\s*\(/gi)) {
    let depth = 1, j = m.index + m[0].length
    const start = j
    while (j < sql.length && depth > 0) { if (sql[j] === '(') depth++; else if (sql[j] === ')') depth--; j++ }
    found.push({ fn: m[1]!.toUpperCase(), arg: sql.slice(start, j - 1).replace(/\s+/g, ' ').trim() })
  }
  return found
}

/**
 * Every SUM(, TOTAL( or AVG( the scan meets that is not a sum over an amount, each with why, keyed by file and call. A new
 * one is added here only after reading it: every SQL sum over an amount (postings, balances, holds, lots, realised, bills,
 * the paper venues' books) uses amount_sum, and TOTAL and AVG (floating point) are not used in SQL at all.
 */
const NOT_AMOUNTS: Record<string, string> = {
  "server/views.ts|SUM(state IN ('done', 'partial'))": 'counts runs by state (a boolean is 0 or 1)',
  "server/views.ts|SUM(state = 'missed')": 'counts runs by state',
  "server/views.ts|SUM(state IN ('blocked', 'failed'))": 'counts runs by state',
  "server/views.ts|SUM(state IN ('awaiting_approval', 'objection_window'))": 'counts runs by state',
  'server/views.ts|SUM(MIN(to_ts, ?) - MAX(from_ts, ?))': 'milliseconds of engine downtime',
  'server/views.ts|SUM(to_ts - MAX(from_ts, ?))': 'milliseconds of engine downtime',
  'scripts/design-compare.ts|TOTAL(light and dark)': 'words in a Markdown table of a design report, not SQL',
  "server/ask-models.ts|SUM(CASE WHEN state = 'settled' THEN COALESCE(cost_micros, reserved_micros) ELSE reserved_micros END)": 'US$ millionths the model requests cost (INTEGER columns), not a money amount of the books',
}

/**
 * What the scans read: the server, and the scripts and browser tests, which open connections of their own to the databases
 * they check (review of 8e9929b: their integrity checks still summed the INTEGER copy with SQLite's SUM).
 */
const SCANNED = ['server', 'scripts', 'browser'] as const
const filesUnder = (dir: string): string[] => readdirSync(join(APP, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'node_modules' ? [] : filesUnder(join(dir, e.name))) : /\.(ts|sql)$/.test(e.name) ? [join(dir, e.name)] : [])
const scannedFiles = (): string[] => SCANNED.flatMap((d) => filesUnder(d)).filter((f) => f !== SELF)
const sqlOf = (file: string): string[] => {
  const src = readFileSync(join(APP, file), 'utf8')
  return file.endsWith('.sql') ? [src.replace(/--[^\n]*/g, '')] : literals(src)
}

describe('no SQL sum over an amount bypasses amount_sum (scan of apps/qed-demo server/, scripts/ and browser/)', () => {
  it('the literal reader finds SQL in quotes and templates, across lines and around ${…}, and ignores code, comments and regular expressions', () => {
    const src = "const a = sum(xs) // SUM(amount) in a comment\n/* SUM(p.amount) */ db.get(`SELECT SUM(\n p.amount) s FROM postings p WHERE x IN (${ids.map(() => '?').join(',')})`)\nconst q = p.replace(/'/g, \"''\") / 2\nconst b = 'select total(qty) from t'"
    expect(literals(src).flatMap(inexactSums)).toEqual([{ fn: 'SUM', arg: 'p.amount' }, { fn: 'TOTAL', arg: 'qty' }])
    expect(inexactSums("SELECT amount_sum(p.amount_text) s, x.sum(1), Sum (qty) q")).toEqual([{ fn: 'SUM', arg: 'qty' }])
  })

  it('every SUM( and amount_sum( in a scanned file is read as SQL or as a comment, so a misread file cannot hide a sum', () => {
    for (const f of scannedFiles().filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(APP, f), 'utf8')
      const { literals: l, comments: c } = scanSource(src)
      for (const re of [/SUM\s*\(/g, /amount_sum\s*\(/g]) {
        const count = (s: string): number => (s.match(re) ?? []).length
        expect(l.reduce((n, s) => n + count(s), 0) + c.reduce((n, s) => n + count(s), 0), `${f} ${re}`).toBe(count(src))
      }
    }
  })

  it('every SUM(, TOTAL( and AVG( in the server, the scripts and the browser tests is listed as not over an amount', () => {
    const files = scannedFiles()
    const found: string[] = [], listed = new Set<string>()
    let amountSums = 0
    for (const f of files) {
      for (const sql of sqlOf(f)) {
        amountSums += (sql.match(/\bamount_sum\s*\(/g) ?? []).length
        for (const s of inexactSums(sql)) { const key = `${f}|${s.fn}(${s.arg})`; if (NOT_AMOUNTS[key]) listed.add(key); else found.push(`${f}: ${s.fn}(${s.arg})`) }
      }
    }
    expect(found).toEqual([])
    expect([...listed].sort()).toEqual(Object.keys(NOT_AMOUNTS).sort()) // the list holds nothing the code no longer has
    for (const d of SCANNED) expect(files.filter((f) => f.startsWith(`${d}/`)).length, d).toBeGreaterThan(d === 'server' ? 100 : 15) // each folder was read
    expect(amountSums).toBeGreaterThan(25) // and the sums it reads are there, through amount_sum
  })

  it('no amount_sum result is compared with a number in SQL (its text "0" is not equal to the integer 0)', () => {
    const found: string[] = []
    for (const f of scannedFiles()) {
      for (const sql of sqlOf(f)) {
        for (const m of sql.matchAll(/\bamount_sum\s*\(/g)) {
          let depth = 1, j = m.index + m[0].length
          while (j < sql.length && depth > 0) { if (sql[j] === '(') depth++; else if (sql[j] === ')') depth--; j++ }
          if (/^\s*(=|==|!=|<>|<=|>=|<|>|\+|-|\*|\/)\s*[-+]?\d/.test(sql.slice(j))) found.push(`${f}: ${sql.slice(m.index, j + 12).replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(found).toEqual([])
  })

  it('outside the server, no SQL that reads postings, balances or holds names the INTEGER copy amount: it reads amount_text', () => {
    // The copy is NULL past 64 bits (Number(null) is 0) and node:sqlite throws reading it past 2^53 as a number. The server
    // writes the copy and verifyLedger compares it with the text; the scripts and browser tests have no reason to read it.
    const found: string[] = []
    let reads = 0
    for (const f of scannedFiles().filter((x) => !x.startsWith('server/'))) {
      for (const sql of sqlOf(f)) {
        if (!/\b(FROM|JOIN)\s+(postings|balances|holds)\b/i.test(sql)) continue
        reads++
        if (/\bamount\b/.test(sql)) found.push(`${f}: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
    expect(found).toEqual([])
    expect(reads).toBeGreaterThan(5) // the scripts' and tests' reads of the three tables were found
  })
})
