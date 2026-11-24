/**
 * Activity's rows for the on-chain wallet's books (Activity.tsx withBooks; server/chain-books.ts): each booked entry with
 * the time it took effect on the chain and the time QED entered it, the test-token label, each movement counted once,
 * and a disagreement between the books and the chain as a row of trouble with its figures.
 */
import { describe, expect, it } from 'vitest'
import type { ChainBooksView, ChainEntry } from '../lib/types.ts'
import { dayBookCsv, searchText, summarise, walletEvents, whoName, withBooks, type WalletJobLine } from './Activity.tsx'

const UNITS = { asset: { symbol: 'tINR', decimals: 2 }, reserve: { symbol: 'tUSD', decimals: 6 } }
const T = Date.parse('2026-11-24T10:00:00Z')
const holder = (amount: string) => ({ code: 'chain:treasury:x', name: 'On-chain wallet: treasury vault', asset: 'x', symbol: 'tINR', decimals: 2, words: 'test rupees', amount_text: amount, holder: true })
const other = (amount: string) => ({ code: 'chain:paid:x', name: 'Paid', asset: 'x', symbol: 'tINR', decimals: 2, words: 'test rupees', amount_text: amount, holder: false })
const entry = (o: Partial<ChainEntry>): ChainEntry => ({ seq: 1, entryTs: T + 60_000, effectiveTs: T, kind: 'chain-payment', memo: 'Paid CloudCo', txHash: '0xab', logIndex: 0, blockNumber: '12', blockTimestamp: T / 1000, jobId: null, escrow: null, counterparty: { kind: 'payee', label: 'CloudCo' }, recordedLate: false, reverses: null, lines: [holder('-350'), other('350')], ...o })
const books = (entries: ChainEntry[], comparison: ChainBooksView['comparison'] = null): ChainBooksView => ({ network: 'eip155:31337', words: 'valueless test tokens on a local chain', ordering: '', rule: '', assets: [], entries, comparison })
const payJob: WalletJobLine = { id: 'job-pay', kind: 'pay', status: 'done', createdAt: new Date(T - 5_000).toISOString(), proposalId: 'p', result: { outcome: 'executed', summary: 'Paid.', evidence: { payeeLabel: 'CloudCo', amount: '350' } } }

describe('the wallet\'s books in Activity', () => {
  it('a booked payment is told on its job\'s row with both its times and the label, and counted once', () => {
    const rows = withBooks(walletEvents([payJob], UNITS), books([entry({ jobId: 'job-pay' })]))
    expect(rows).toHaveLength(1)
    const d = rows[0]!.detail.join(' | ')
    expect(d).toMatch(/Paid CloudCo \(3\.50 test rupees out\): took effect 24 Nov 2026, 15:30:00 IST on the chain/)
    expect(d).toMatch(/entered in your books 24 Nov 2026, 15:31:00 IST/)
    expect(d).toMatch(/Test rupees: valueless test tokens on a local chain/)
    expect(summarise(rows).wallet.paid).toBe(350)
  })

  it('an escrow earning with no job of this wallet is a row of its own, its amount in words; no summary counts it as paid out or as the grant', () => {
    const e = entry({ seq: 7, kind: 'chain-escrow-earning', memo: 'Received for work: escrow job #7', escrow: { jobId: '7', event: 'settled', role: 'provider' }, counterparty: { kind: 'escrow', label: 'ProofEscrow' }, lines: [holder('2551'), { ...other('-2551'), code: 'chain:work-received:x' }] })
    const [row] = withBooks([], books([e]))
    expect(row).toMatchObject({ key: 'book:7', ts: T, amount: null, moved: false, after: 'Received for work', stamp: { tone: 'ok', word: 'In your books' }, unit: { kind: 'token', symbol: 'tINR', words: 'test rupees' } })
    expect(row!.detail.join(' ')).toMatch(/Received for work: escrow job #7 \(25\.51 test rupees in\): took effect .* on the chain.*entered in your books .*valueless test tokens on a local chain/)
    // with a delivery job of this wallet in the list, the earning is told on its row and no figure moves into the summary
    const deliver: WalletJobLine = { ...payJob, id: 'job-deliver', kind: 'escrow-deliver', result: { outcome: 'executed', summary: 'Delivered.', evidence: {} } }
    const rows = withBooks(walletEvents([payJob, deliver], UNITS), books([entry({ jobId: 'job-pay' }), { ...e, jobId: 'job-deliver' }]))
    expect(rows).toHaveLength(2)
    const s = summarise(rows).wallet
    expect([s.paid, s.arrived]).toEqual([350, 0])
  })

  it('a disagreement is a row of trouble with its figures; nothing was corrected', () => {
    const [row] = withBooks([], books([], { state: 'disagrees', at: T, block: 40, why: null, assets: [{ asset: 'x', symbol: 'tINR', decimals: 2, words: 'test rupees', books: '149650', inFlight: '0', chain: '149150', difference: '-500' }] }))
    expect(row).toMatchObject({ what: 'Your books and your on-chain wallet disagree', bucket: 'trouble', stamp: { tone: 'void', word: 'Books and chain disagree' }, after: 'Nothing was corrected' })
    expect(row!.detail.join(' | ')).toMatch(/the books hold 1,496.50 test rupees with 0.00 test rupees in flight; the chain holds 1,491.50 test rupees/)
  })

  it('a movement QED only saw on the chain is not labelled QED: it names the other party the books know, or the chain', () => {
    const lines = [holder('2551'), { ...other('-2551'), holder: false }]
    const paidTo = entry({ seq: 3, kind: 'chain-payment', memo: 'Paid CloudCo', counterparty: { kind: 'address', label: 'CloudCo' }, lines })
    const fromOutside = entry({ seq: 4, kind: 'chain-receipt', memo: 'Received from outside the wallet', counterparty: { kind: 'address', label: null }, lines })
    const escrow = entry({ seq: 5, kind: 'chain-escrow-earning', memo: 'Received for work: escrow job #5', counterparty: { kind: 'escrow', label: null }, lines })
    const faucet = entry({ seq: 6, kind: 'chain-grant', memo: 'Opening grant from the local chain\'s faucet', counterparty: { kind: 'faucet', label: null }, lines })
    const rows = withBooks([], books([paidTo, fromOutside, escrow, faucet]))
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(rows.every((r) => r.who === 'chain')).toBe(true)
    expect([byKey['book:3']!, byKey['book:4']!, byKey['book:5']!, byKey['book:6']!].map(whoName)).toEqual(['CloudCo', 'The chain', 'The escrow contract', 'The local chain\'s faucet'])
    // the file and the search say the same, never QED, for these rows
    const csv = dayBookCsv(rows)
    expect(csv).not.toMatch(/,QED,/)
    expect(csv).toMatch(/,CloudCo,Paid CloudCo,/)
    expect(searchText(byKey['book:4']!)).toContain('the chain')
    expect(searchText(byKey['book:4']!).split(' \u0001 ')).not.toContain('qed') // its actor word is not QED (its own "under" says QED entered it in the books, which is true)
  })

  it('what QED did itself still says QED: the comparison it makes, and the people\'s own payments say You', () => {
    const [row] = withBooks([], books([], { state: 'disagrees', at: T, block: 40, why: null, assets: [{ asset: 'x', symbol: 'tINR', decimals: 2, words: 'test rupees', books: '1', inFlight: '0', chain: '2', difference: '-1' }] }))
    expect(whoName(row!)).toBe('QED')
    expect(whoName({ who: 'you' })).toBe('You')
  })
})
