/**
 * Test tokens are never rupee money (R13; server/chain-books.ts). The on-chain wallet's tINR and tUSD are booked as assets of
 * their own (eip155:31337/erc20:<contract>), and no rupee total may include them:
 *   1. a scan of the server: every SQL sum over the ledger's amounts names the one account it sums, or is a whole-book
 *      check listed here with why it is not a rupee figure; and no SQL picks accounts by a pattern a chain account matches;
 *   2. every rupee figure the server gives (Home's overview, the worst case, what is free, the passbook, the statement,
 *      recorded spending, what is due) is the same before and after a large history of test tokens is booked;
 *   3. a scan of the interface: no rupee figure is formatted from a sum that mixes a chain balance with a rupee one.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syncChainBooks } from './chain-books.ts'
import { recordedSpending } from './household.ts'
import { liquidity } from './liquidity.ts'
import { saveVault } from './rail.ts'
import { FakeRail } from './rail-fake.ts'
import { periodOf } from '../shared/period.ts'
import { statement } from './statement.ts'
import { makeKit } from './testkit.ts'
import { commitments, overview, worstCase } from './valuation.ts'
import { homeView, passbook, sinceView } from './views.ts'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const filesUnder = (dir: string, ext: RegExp): string[] => readdirSync(join(APP, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === 'node_modules' ? [] : filesUnder(join(dir, e.name), ext)) : ext.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [])
/** The SQL in a file: its string and template literals (a template's ${…} becomes ?). Close enough for SQL, which lives in literals. */
const sqlOf = (src: string): string[] => [...src.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, '?'))

/**
 * Sums over the ledger that read more than one account, each with why it is not a rupee figure. Anything else that sums
 * postings, balances or holds must name its account. A new whole-book sum is added here only after reading it.
 */
const WHOLE_BOOK: Record<string, string> = {
  'server/ledger.ts|entry-balances': 'verifyLedger: whether each entry balances, grouped by asset (never a total across assets)',
  'server/ledger.ts|balance-cache': 'verifyLedger: each account\'s cached balance against its own postings',
  'server/ledger.ts|books-balance': 'verifyLedger: whether all postings in each asset sum to zero, grouped by asset',
}
const whichWholeBook = (sql: string): string | null =>
  /GROUP BY p\.entry_id, p\.asset_id/.test(sql) ? 'entry-balances' : /FROM accounts a JOIN balances b/.test(sql) && /p\.account_id = a\.id/.test(sql) ? 'balance-cache' : /GROUP BY p\.asset_id/.test(sql) ? 'books-balance' : null

describe('no rupee total includes a test token', () => {
  const fake = new FakeRail()
  const dir = mkdtempSync(join(tmpdir(), 'qed-test-tokens-'))
  beforeAll(async () => { await fake.start() })
  afterAll(async () => { await fake.stop(); rmSync(dir, { recursive: true, force: true }) })

  it('scan: every SQL sum over the ledger\'s amounts names its account, or is a listed whole-book check; no SQL selects accounts by a pattern a chain account matches', () => {
    const files = filesUnder('server', /\.ts$/).filter((f) => f !== 'server/chain-books.ts' && f !== 'server/rail-fake.ts')
    const found: string[] = [], listed = new Set<string>()
    let sums = 0
    for (const f of files) {
      for (const sql of sqlOf(readFileSync(join(APP, f), 'utf8'))) {
        // an account chosen by a pattern: it must not be one a chain account ('chain:…') can match
        for (const m of sql.matchAll(/\bcode\s+(?:NOT\s+)?LIKE\s+'([^']*)'/gi)) {
          const re = new RegExp(`^${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`)
          if (re.test('chain:treasury:eip155:31337/erc20:0x0000000000000000000000000000000000000001')) found.push(`${f}: selects accounts by a pattern a chain account matches: ${m[0]}`)
        }
        if (!/\bamount_sum\s*\(/.test(sql) || !/\b(postings|balances|holds)\b/.test(sql)) continue
        sums++
        const oneAccount = /\baccount_id\s*=\s*\?/.test(sql) || /\.code\s*=\s*\?/.test(sql) || /\.code\s*=\s*'(?!chain:)[^']+'/.test(sql) || /\bref\s*=\s*\?/.test(sql)
        if (oneAccount) continue
        const w = whichWholeBook(sql)
        if (w && WHOLE_BOOK[`${f}|${w}`]) { listed.add(`${f}|${w}`); continue }
        found.push(`${f}: a sum over the ledger that names no account: ${sql.replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
    expect(found).toEqual([])
    expect([...listed].sort()).toEqual(Object.keys(WHOLE_BOOK).sort()) // the list holds nothing the code no longer has
    expect(sums).toBeGreaterThan(10) // the scan read the server's sums
  })

  it('every rupee figure the server gives is the same before and after a large history of test tokens is booked', async () => {
    const k = makeKit()
    const now = () => k.clock.now()
    const figures = () => {
      const home = homeView(k.db, k.market, k.userId, now()) as Record<string, unknown>
      return {
        overview: overview(k.db, k.market, k.userId, now()), worst: worstCase(k.db, k.market, k.userId, now()), liquidity: liquidity(k.db, k.userId, now()),
        passbook: passbook(k.db, k.userId, now(), 500), statement: statement(k.db, k.userId, now(), periodOf('all', now()), 500),
        spending: recordedSpending(k.db, k.userId, now()), due: commitments(k.db, k.userId, now(), 30 * 86_400_000), since: sinceView(k.db, k.userId, now() - 86_400_000, now()),
        homeOverview: home.overview, homeSpending: home.spending,
      }
    }
    const before = figures()
    // a history large enough that adding it anywhere would show: a crore of test rupees, payments, a conversion, earnings
    saveVault(k.db, k.userId, { railId: 'qed-rupees-000001', request: { workspaceId: 'qed-rupees-000001', owner: { signers: [], threshold: 1 }, rpIdHash: `0x${'00'.repeat(32)}`, origin: 'http://localhost:5175' }, credentialIds: [], createdAt: now(), createdBy: k.userId })
    const c = fake.addChain('qed-rupees-000001', Math.floor(now() / 1000) - 7200)
    c.tx([c.grant('treasury', 1_000_000_000n), c.grant('owner-account', 50_000_000n)])
    c.tx([c.pay(12_345_00n)])
    c.tx(c.convert({ amountIn: 840_000_00n, rIn: 840_000_000n, rOut: 100_000_000_000n }))
    c.tx([c.escrowEarning(250_75n, '4')])
    c.tx([c.receive(9_999n, 'tUSD', 'reserve')])
    c.tx([c.own('treasury', 'owner-account', 77_00n), c.escrowFund(77_00n, '5')])
    c.tx([c.escrowSettledForClient(77_00n, '5')])
    c.mine(2)
    const r = await syncChainBooks({ dbPath: join(dir, 'qed.db') }, k.db, k.userId, now())
    expect(r.posted).toBeGreaterThanOrEqual(10)
    expect(k.db.get<{ n: number }>(`SELECT COUNT(*) n FROM accounts WHERE user_id = ? AND code LIKE 'chain:%'`, k.userId)!.n).toBeGreaterThan(5)
    expect(figures()).toEqual(before)
  })

  it('scan: no screen formats a rupee figure from a sum that mixes a chain balance with a rupee one', () => {
    const chainField = /\b(treasury|reserve)\.(balance|free|ringFenced)\b|\bownerHolds\b|\bchainBooks\b/
    const rupeeField = /\bo\.(bank|holdingsValue|inTransit|deposits|setAside|netWorth|card|loans|freeToUse)\b|\bnetWorth\b|\bbankAvailable\b/
    const found: string[] = []
    for (const f of filesUnder('src', /\.tsx?$/)) {
      const src = readFileSync(join(APP, f), 'utf8')
      for (const m of src.matchAll(/fmt\.inr\(/g)) {
        let depth = 1, i = m.index + m[0].length
        while (i < src.length && depth > 0) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++ }
        const arg = src.slice(m.index + m[0].length, i - 1)
        if (chainField.test(arg) && rupeeField.test(arg)) found.push(`${f}: fmt.inr(${arg})`)
      }
    }
    expect(found).toEqual([])
  })
})
