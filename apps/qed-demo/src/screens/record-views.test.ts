/**
 * The arithmetic and wording behind the Activity, Record, Earn and Evidence screens (design "Bounds"): each row of the day
 * book says what happened, who acted, under which instruction or authority, and what moved, in its own unit; the
 * figures above it add up to the rows; a record reads its bound from the limits its checks recorded; a case is readable
 * without token tickers or raw addresses and says what kind of evidence it is. Nothing here computes money of its own:
 * every figure is a record's figure, carried through.
 */
import { describe, expect, it } from 'vitest'
import type { ActionView, Dispute, PassbookLine, RunView } from '../lib/types.ts'
import { amountText, byDay, closeSpellings, DAY_BOOK_ORDER, findFrom, findQuery, dayBookCsv, detailText, directionOf, type Filters, foldRepeats, inForce, inRanges, matches, matchesQuery, netRows, NO_FILTER, NO_RANGES, partsLine, periodStart, queryTerms, type Ranges, rangesFrom, signed, summarise, toEvents, tokenFigure, walletEvents, type DayEvent, type WalletJobLine } from './Activity.tsx'
import { chainPlace as earnChainPlace, moveTone, paperPlace, stageName } from './Earn.tsx'
import { authorityLine, caseText, checkWords, executedWords, executionOf, groupCases, groupRelated, nothingMovedLine, orderChecks, plainBy, readable, reconciledWords, units, whatHappened } from './Evidence.tsx'
import { boundsOf, chainPlace, plainReason, rupeesIn, slippageWords, standing } from './Record.tsx'
import { NEEDS_ATTENTION } from '../ui/kit.tsx'
import { receiptOutcome } from '../ui/records.ts'

const IST = 19_800_000
/** A moment given as India time, "2026-11-22 23:12". */
const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
const NOW = at('2026-11-22 23:31')

type Act = ActionView & { programTitle?: string | null }
const ok = (name: string) => ({ name, ok: true, detail: 'fine' })
const payment = (p: Partial<Act> = {}): Act => ({
  id: 'act_pay', kind: 'payment', origin: 'owner', venue: 'paper-rail', state: 'done', runId: null, programId: null, economicId: 'man_1', what: 'Pay ₹25,000 to Meera Nair',
  params: { payeeName: 'Meera Nair', payeeHandle: 'meera.nair@upi', amount: '2500000', memo: 'Rent for November' }, instrument: null,
  decision: { decidedAt: at('2026-11-22 23:12'), checks: ['owner-approved', 'funds-available', 'worst-case-stays-above-floor', 'stays-liquid', 'started-in-time'].map(ok) },
  result: { movedPaise: '2500000', rail: 'upi' }, times: {}, reconState: 'reconciled', receiptId: 'rcp_1', approvalId: 'apr_1', error: null, createdAt: at('2026-11-22 23:12'), updatedAt: at('2026-11-22 23:12'), programTitle: null, ...p,
})
const line = (p: Partial<PassbookLine>): PassbookLine => ({ seq: 2, ts: at('2026-11-22 23:12'), effectiveTs: at('2026-11-22 23:12'), kind: 'payment-sent', memo: 'To Meera Nair: Rent for November', amount: -2500000, balance: 87500000, actor: 'you', actionId: 'act_pay', receiptId: 'rcp_1', programId: null, programTitle: null, recordedLate: false, ...p })
const run = (p: Partial<RunView>): RunView => ({ id: 'run_1', programId: 'prg_inv', version: 1, occurrence: 'o1', state: 'missed', trigger: {}, dueAt: at('2026-11-22 02:00'), createdAt: 0, startedAt: null, finishedAt: null, deadlineAt: null, reason: 'The engine was not running.', willDo: [], programTitle: 'Invest ₹1,000 in UTI Nifty 50 Index Fund', ...p })
const only = (events: DayEvent[], key: string): DayEvent => { const e = events.find((x) => x.key === key); if (!e) throw new Error(`no event ${key}`); return e }

describe('Activity: each row says what happened, who acted, under what, and what moved', () => {
  it('a payment you made says who was paid, what it left in the bank, its checks and its receipt', () => {
    const e = only(toEvents({ actions: [payment()], runs: [] }, [line({})]), 'act_pay')
    expect([e.who, e.what, e.under]).toEqual(['you', 'Paid Meera Nair', 'Your approval'])
    expect([e.amount, e.moved, e.after]).toEqual([-2500000, true, '₹8,75,000.00 after'])
    expect(e.receipt).toBe(true)
    expect(e.detail).toEqual(['Rent for November, by UPI', '5 of 5 checks passed', 'The venue\'s record agrees'])
    expect([e.account, e.kind, e.bucket, e.to]).toEqual(['bank', 'payment', 'done', '/record/act_pay'])
  })

  it('a payment QED refused under an instruction is QED\'s, under that instruction, names the check, and says nothing moved', () => {
    const refused = payment({ id: 'act_ref', origin: 'program', programId: 'prg_bills', programTitle: 'Pay bills from 2 payees up to ₹3,000 each', state: 'blocked', params: { payeeName: 'City Power', amount: '612000' }, result: {}, reconState: 'not_applicable', receiptId: 'rcp_2', error: 'It is above the ₹3,000 cap.', decision: { decidedAt: 1, checks: [ok('program-active'), { name: 'within-run-limit', ok: false, detail: '₹6,120 is above ₹3,000.' }] } })
    const e = only(toEvents({ actions: [refused], runs: [] }, []), 'act_ref')
    expect([e.who, e.what, e.under]).toEqual(['qed', 'Payment to City Power', 'Pay bills from 2 payees up to ₹3,000 each'])
    expect([e.amount, e.moved, e.after]).toEqual([612000, false, 'Nothing moved'])
    expect(e.detail).toContain('Refused on 1 of 2 checks: within the limit for one run')
    expect([e.bucket, e.trouble]).toEqual(['trouble', true])
  })

  it('says when a finished action has not yet been compared with the venue, and says nothing of a venue it never reached', () => {
    expect(only(toEvents({ actions: [payment({ reconState: 'open' })], runs: [] }, []), 'act_pay').detail).toContain('Not yet compared with the venue\'s record')
    expect(only(toEvents({ actions: [payment({ state: 'blocked', reconState: 'not_applicable', result: {} })], runs: [] }, []), 'act_pay').detail.join(' ')).not.toMatch(/venue/)
  })

  it('a finished payment whose venue record differs is trouble, never plain done', () => {
    const e = only(toEvents({ actions: [payment({ reconState: 'break' })], runs: [] }, [line({})]), 'act_pay')
    expect([e.trouble, e.bucket]).toEqual([true, 'trouble'])
    expect(e.detail).toContain('The venue\'s record differs from your ledger')
  })

  it('an order you placed says what was bought, by the bank line it made; one still in progress says it was asked for', () => {
    const buy = payment({ id: 'act_buy', kind: 'order', venue: 'paper-crypto', what: 'Buy ₹3,000 of Bitcoin in rupees', params: { side: 'buy', type: 'market', amount: '300000', instrumentId: 'coindcx:BTCINR' }, instrument: { id: 'coindcx:BTCINR', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }, result: { movedPaise: '296798', filledQty: '46000' } })
    const e = only(toEvents({ actions: [buy], runs: [] }, [line({ seq: 3, actionId: 'act_buy', amount: -296798, balance: 87203202 })]), 'act_buy')
    expect([e.what, e.amount, e.after, e.detail[0]]).toEqual(['Bought Bitcoin in rupees', -296798, '₹8,72,032.02 after', '0.00046 BTC'])
    const fund = only(toEvents({ actions: [buy, payment({ id: 'act_mf', kind: 'order', state: 'working', params: { side: 'buy', amount: '500000' }, instrument: { id: 'amfi:1', name: 'UTI Nifty 50 Index Fund', kind: 'mutual_fund', baseAsset: 'UNITS', baseScale: 3 }, result: {} })], runs: [] }, []), 'act_mf')
    expect([fund.what, fund.bucket, fund.after]).toEqual(['Order to invest in UTI Nifty 50 Index Fund', 'waiting', 'Not settled yet'])
  })

  it('a payment waiting for your approval is waiting, and nothing has moved', () => {
    const e = only(toEvents({ actions: [payment({ state: 'awaiting_approval', receiptId: null, result: {} })], runs: [] }, []), 'act_pay')
    expect([e.what, e.waiting, e.trouble, e.moved, e.after]).toEqual(['Payment to Meera Nair', true, false, false, 'Nothing has moved'])
  })

  it('the missed runs of one instruction on one day are one row, under that instruction, and another day is another', () => {
    const runs = [run({ id: 'r1', dueAt: at('2026-11-22 01:00') }), run({ id: 'r2', dueAt: at('2026-11-22 02:00') }), run({ id: 'r3', dueAt: at('2026-11-22 03:00') }), run({ id: 'r4', dueAt: at('2026-11-21 23:50') })]
    const events = toEvents({ actions: [], runs }, [])
    expect(events).toHaveLength(2)
    const many = events.find((e) => e.what === 'Missed 3 runs')!
    expect([many.who, many.under, many.state, many.trouble, many.kind, many.to]).toEqual(['qed', 'Invest ₹1,000 in UTI Nifty 50 Index Fund', 'missed', true, 'run', '/instructions/prg_inv'])
    expect(many.detail).toEqual(['Due from 01:00 to 03:00', 'For each: The engine was not running'])
    expect(detailText(many.detail)).toBe('Due from 01:00 to 03:00. For each: The engine was not running.')
    expect(events.find((e) => e !== many)!.what).toBe('Missed a run')
  })

  it('a dispute you raised is a row of yours, waiting while it is open, and moves nothing itself', () => {
    const d: Dispute = { id: 'dsp_1', action_id: 'act_pay', state: 'open', reason: 'Wrong amount.', resolution: null, created_at: at('2026-11-22 23:20'), updated_at: at('2026-11-22 23:20') }
    const e = only(toEvents({ actions: [payment()], runs: [], disputes: [d] }, [line({})]), 'dsp_1')
    expect([e.who, e.what, e.to, e.waiting, e.kind, e.amount]).toEqual(['you', 'Disputed the payment to Meera Nair', '/record/act_pay', true, 'dispute', null])
    expect(e.stamp).toEqual({ tone: 'wait', word: 'Dispute open' })
    expect(e.detail).toEqual(['You said: “Wrong amount”', 'A dispute pack for it (approval, receipts, timeline, payee, bank reference) is on its record'])
  })

  it('groups rows by India day, newest first, named as a person says them', () => {
    const events = toEvents({ actions: [payment({ id: 'a', createdAt: at('2026-11-22 00:10') }), payment({ id: 'b', createdAt: at('2026-11-21 23:50') }), payment({ id: 'c', createdAt: at('2026-11-18 09:00') })], runs: [] }, [])
    const days = byDay(events, NOW)
    expect(days.map((d) => [d.name, d.events.map((e) => e.key)])).toEqual([['Today', ['a']], ['Yesterday', ['b']], ['Wednesday 18 November', ['c']]])
    expect(days[0]!.date).toBe('Sunday 22 November')
  })

  it('filters by account, who acted, kind and state, and the filters combine', () => {
    const events = [...toEvents({ actions: [payment(), payment({ id: 'q', origin: 'program', state: 'failed', error: 'The rail declined it.' }), payment({ id: 'w', state: 'working', result: { railState: 'unknown' } })], runs: [run({ id: 'r9' })] }, []), ...walletEvents([job({})], UNITS)]
    const keys = (f: Partial<typeof NO_FILTER>) => events.filter(matches({ ...NO_FILTER, ...f })).map((e) => e.key).sort()
    expect(keys({})).toHaveLength(5)
    expect(keys({ account: 'wallet' })).toEqual(['job:j1'])
    expect(keys({ who: 'qed', account: 'bank' })).toEqual(['q', 'r9'])
    expect(keys({ state: 'waiting' })).toEqual(['w'])
    expect(keys({ kind: 'run' })).toEqual(['r9'])
    expect(keys({ state: 'trouble', kind: 'payment' })).toEqual(['q'])
  })
})

// the on-chain wallet's jobs, as its records page lists them (chain/types.ts Job, the parts a row reads)
const UNITS = { asset: { symbol: 'tINR', decimals: 2 }, reserve: { symbol: 'tUSD', decimals: 6 } }
const job = (p: Partial<WalletJobLine> & { evidence?: Record<string, unknown>; outcome?: string; summary?: string }): WalletJobLine => ({
  id: p.id ?? 'j1', kind: p.kind ?? 'pay', status: p.status ?? 'done', createdAt: p.createdAt ?? new Date(at('2026-11-22 23:00')).toISOString(), proposalId: p.proposalId === undefined ? 'prop_1' : p.proposalId, error: null,
  result: p.result === null ? null : { outcome: p.outcome ?? 'executed', summary: p.summary ?? 'Paid 3.00 tINR to CloudCo; treasury now 99,997.00 tINR.', tx: { block: '59' }, evidence: p.evidence ?? { payeeLabel: 'CloudCo', amount: '300', dueInDays: 0, dueAt: '0', liabilityId: null } },
})

describe('Activity: the on-chain wallet\'s records are rows of the same day book, in their own unit', () => {
  it('a payment you signed left the wallet, in test rupees named in words, with the job page as its record', () => {
    const e = walletEvents([job({})], UNITS)[0]!
    expect([e.account, e.who, e.what, e.under, e.kind]).toEqual(['wallet', 'you', 'Paid CloudCo', 'Your signature on these terms', 'payment'])
    expect([e.amount, e.moved, e.after, e.to]).toEqual([-300, true, 'Left the wallet', '/vault/job/j1'])
    expect(amountText(e.amount!, e.unit, e.moved)).toBe('−3.00 test rupees')
    // the block it was mined in is a reference, on the job's own page, not a word of the day book
    expect(e.detail).toEqual(['Paid 3.00 test rupees to CloudCo; treasury now 99,997.00 test rupees'])
  })

  it('a promise is set aside, not paid: a payment with a liability and a due day stays in the wallet', () => {
    const e = walletEvents([job({ evidence: { payeeLabel: 'CloudCo', amount: '200', dueInDays: 30, dueAt: String(Math.floor(at('2026-12-22 23:00') / 1000)), liabilityId: '1' } })], UNITS)[0]!
    expect([e.what, e.amount, e.moved, e.after]).toEqual(['Promised CloudCo a payment', 200, false, 'Set aside, due 22 Dec'])
  })

  it('a bounty this household won is money into the reserve, kept apart from conversions; one it did not win moves nothing', () => {
    const won = walletEvents([job({ kind: 'bounty-settle', summary: 'Settled bounty 3: the board paid 1000.0 tUSD to 0xabc, this workspace\'s recipient.', evidence: { bountyId: '3', payout: '1000000000', ours: true } })], UNITS)[0]!
    expect([won.what, won.kind, won.amount, won.moved, won.after]).toEqual(['Settled a bounty', 'payment', null, true, 'Paid into the reserve by the bounty'])
    expect(amountText(won.received!.amount, won.received!.unit, true)).toBe('+1,000.00 test dollars')
    const lost = walletEvents([job({ kind: 'bounty-settle', evidence: { bountyId: '3', payout: '1000000000', ours: false } })], UNITS)[0]!
    expect([lost.received, lost.moved]).toEqual([null, false])
    const conv = walletEvents([job({ kind: 'convert', evidence: { amountIn: '1000', amountOut: '118987' } })], UNITS)[0]!
    const sum = summarise([won, conv]).wallet
    expect([sum.received, sum.bountyIn]).toEqual([118987, 1000000000])
  })

  it('a conversion shows what left in test rupees and what came back in test dollars', () => {
    const e = walletEvents([job({ kind: 'convert', summary: 'Converted 10.00 tINR → 0.118987 tUSD', evidence: { amountIn: '1000', amountOut: '118987' } })], UNITS)[0]!
    expect([e.what, e.kind, e.amount, e.after]).toEqual(['Converted test rupees into test dollars', 'order', -1000, 'Into the reserve'])
    expect(amountText(e.received!.amount, e.received!.unit, true)).toBe('+0.118987 test dollars')
  })

  it('a tick of the standing policy is QED\'s, under the policy; a refusal names the co-signer\'s rule and moves nothing', () => {
    const e = walletEvents([job({ kind: 'policy-tick', proposalId: null, outcome: 'refused', summary: 'Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion fits in what the owner granted', evidence: {} })], UNITS)[0]!
    expect([e.who, e.under, e.what, e.kind, e.bucket]).toEqual(['qed', 'The standing policy you signed', 'Top-up of the reserve', 'run', 'trouble'])
    expect([e.amount, e.after, e.stamp?.word]).toEqual([null, 'Nothing moved', 'Refused by QED\'s checks'])
    expect(e.detail[0]).toBe('The co-signer refused it under its authority budget rule')
  })

  it('a signed mandate is a change of authority that moves nothing; a job still running is waiting', () => {
    const [m, r] = walletEvents([job({ id: 'm', kind: 'mandate', createdAt: new Date(at('2026-11-22 23:01')).toISOString(), summary: 'Owner signed mandate v1', evidence: { version: 1 } }), job({ id: 'r', kind: 'pay', status: 'running', result: null })], UNITS)
    expect([m!.what, m!.kind, m!.after, m!.amount]).toEqual(['Signed a mandate', 'authority', 'Nothing moved', null])
    expect([r!.what, r!.bucket, r!.stamp?.word]).toEqual(['Payment to a payee', 'waiting', 'Pending'])
  })

  it('writes token amounts digit by digit, at least to the paisa, never through a float', () => {
    expect(tokenFigure(10000000, 2)).toBe('1,00,000.00')
    expect(tokenFigure(118987, 6, 'tUSD')).toBe('0.118987')
    expect(tokenFigure(-300, 2)).toBe('−3.00')
  })
})

describe('Activity: the period shown, the folds, and what the rows came to', () => {
  it('the period starts where every list read is complete: a list that came back as long as asked may stop short', () => {
    expect(periodStart([{ count: 4, asked: 100, oldest: 10 }, { count: 9, asked: 200, oldest: 20 }])).toBeNull()
    expect(periodStart([{ count: 100, asked: 100, oldest: 10 }, { count: 9, asked: 200, oldest: 20 }])).toBe(10)
    expect(periodStart([{ count: 100, asked: 100, oldest: 10 }, { count: 200, asked: 200, oldest: 30 }])).toBe(30)
  })

  it('folds the same thing done again in a row, on one day, keeping every instance; a different state breaks the run', () => {
    const buy = (id: string, t: string, state = 'done') => payment({ id, origin: 'program', programTitle: 'Invest ₹200', kind: 'order', state, createdAt: at(t), params: { side: 'buy', amount: '20000' }, instrument: { id: 'b', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }, result: { movedPaise: '19500' } })
    const events = toEvents({ actions: [buy('a', '2026-11-22 10:10'), buy('b', '2026-11-22 10:05'), buy('c', '2026-11-22 10:00', 'blocked'), buy('d', '2026-11-21 23:55')], runs: [] }, [])
    expect(foldRepeats(events).map((g) => g.all.map((e) => e.key))).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('the bank\'s figures add up: out by you plus out by QED, in, and every order and payment in exactly one state', () => {
    const buy = payment({ id: 'act_buy', kind: 'order', what: 'Buy', params: { side: 'buy', amount: '300000' }, instrument: { id: 'b', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }, result: { movedPaise: '296798', filledQty: '46000' }, receiptId: 'rcp_2' })
    const sold = payment({ id: 'act_sell', kind: 'order', origin: 'program', programTitle: 'Protect', params: { side: 'sell', qty: '1000' }, instrument: { id: 'b', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }, result: { movedPaise: '50000' }, receiptId: 'rcp_4' })
    const refused = payment({ id: 'q1', origin: 'program', state: 'blocked', result: {}, receiptId: 'rcp_3', reconState: 'not_applicable' })
    const failed = payment({ id: 'q2', state: 'failed', result: {}, receiptId: null })
    const waiting = payment({ id: 'q3', state: 'working', result: {}, receiptId: null })
    const cancelled = payment({ id: 'q4', state: 'cancelled', result: {}, receiptId: 'rcp_5' })
    const events = toEvents({ actions: [payment(), buy, sold, refused, failed, waiting, cancelled], runs: [run({ id: 'r9' })] }, [line({}), line({ seq: 3, actionId: 'act_buy', amount: -296798, balance: 87203202 }), line({ seq: 4, actionId: 'act_sell', amount: 50000, balance: 87253202 })])
    const b = summarise(events).bank
    expect(b).toMatchObject({ actions: 7, byYou: 5, byQed: 2, done: 3, waiting: 1, trouble: 2, other: 1, outByYou: 2796798, outByQed: 0, inByYou: 0, inByQed: 50000, finished: 6, receipts: 5, runs: 1, disputes: 0 })
    expect(b.done + b.waiting + b.trouble + b.other).toBe(b.actions)
    expect(b.byYou + b.byQed).toBe(b.actions)
    expect(partsLine([[b.done, 'done'], [b.waiting, 'waiting'], [b.trouble, 'refused, failed or partly done'], [b.other, 'cancelled']])).toBe('3 done + 1 waiting + 2 refused, failed or partly done + 1 cancelled')
    expect(partsLine([[0, 'done']])).toBe('none')
    // the net change as a statement: every total is the sum of its row, the net row the sum of the two above it, column
    // by column, and the net is what came in less what went out
    const rows = netRows(b)
    expect(rows.map((r) => [r.k, r.you, r.qed, r.all])).toEqual([['in', 0, 50000, 50000], ['out', -2796798, 0, -2796798], ['net', -2796798, 50000, -2746798]])
    for (const r of rows) expect(r.you + r.qed).toBe(r.all)
    for (const c of ['you', 'qed', 'all'] as const) expect(rows[0]![c] + rows[1]![c]).toBe(rows[2]![c])
    expect(rows[2]!.all).toBe(b.inByYou + b.inByQed - b.outByYou - b.outByQed)
    expect([signed(50000), signed(-2796798), signed(0)]).toEqual(['+₹500.00', '−₹27,967.98', '₹0.00'])
  })

  it('the wallet\'s figures are its own, in its unit: paid out, set aside, converted and what that delivered', () => {
    const w = summarise(walletEvents([
      job({ id: 'p' }),
      job({ id: 'pr', evidence: { payeeLabel: 'CloudCo', amount: '200', dueInDays: 30, dueAt: '1798030757', liabilityId: '1' } }),
      job({ id: 'rf', kind: 'ring-fence', evidence: { amount: '400', dueAt: '1798030758' } }),
      job({ id: 'cv', kind: 'convert', evidence: { amountIn: '1000', amountOut: '118987' } }),
      job({ id: 't', kind: 'policy-tick', proposalId: null, outcome: 'refused', evidence: {} }),
    ], UNITS)).wallet
    expect(w).toMatchObject({ rows: 5, byYou: 4, byQed: 1, done: 4, trouble: 1, paid: 300, setAside: 600, converted: 1000, received: 118987 })
  })
})

describe('Record: the bound, what is not known, and the receipt\'s place in the chain', () => {
  it('reads the limits from the checks\' own words: used before, this action, and the limit', () => {
    expect(rupeesIn('₹1,200.00 used this month plus ₹200.00 against ₹25,000.00.')).toEqual([120000, 20000, 2500000])
    expect(boundsOf([
      { name: 'within-run-limit', ok: true, detail: '₹200.00 against ₹200.00 per run.' },
      { name: 'within-month-limit', ok: false, detail: '₹24,900.00 used this month plus ₹200.00 against ₹25,000.00.' },
      { name: 'funds-available', ok: true, detail: '₹200.00 needed; ₹9,00,000.00 available in the bank account.' },
    ])).toEqual([{ per: 'month', used: 2490000, size: 20000, limit: 2500000, ok: false }, { per: 'run', used: 0, size: 20000, limit: 20000, ok: true }])
    // words of another form are not read as a bound
    expect(boundsOf([{ name: 'within-day-limit', ok: true, detail: 'No daily limit.' }])).toEqual([])
  })

  it('says what is not known or only partly done in those words, above everything else', () => {
    expect(standing({ kind: 'payment', state: 'working', reconState: 'open', result: { railState: 'unknown' } })?.title).toBe('Not known yet')
    expect(standing({ kind: 'order', state: 'partial', reconState: 'reconciled', result: {} })?.title).toBe('Partly completed')
    expect(standing({ kind: 'payment', state: 'done', reconState: 'break', result: {} })).toMatchObject({ tone: 'void', title: 'Needs attention' })
    expect(standing({ kind: 'payment', state: 'done', reconState: 'reconciled', result: {} })).toBeNull()
  })

  it('places a receipt in the chain the server verified', () => {
    expect(chainPlace(2, { ok: true, count: 3, brokenAt: null, head: 'h' })).toBe('No. 2 of 3 in your chain; it follows no. 1, and the chain is intact')
    expect(chainPlace(1, { ok: false, count: 3, brokenAt: 2, head: 'h' }, false)).toBe('1 of 3 in your chain; it is the first in the chain, and the chain is broken at no. 2')
    expect(chainPlace(5, null)).toBe('No. 5 in your chain; it follows no. 4')
  })
})

describe('Earn: each milestone sits at one place on one lifecycle', () => {
  it('places paper milestones: escrow, submitted, disputed, paid, refunded', () => {
    expect(paperPlace({ state: 'funded', evidence_hash: null })).toEqual({ at: 1, end: null, turn: 'you' })
    expect(paperPlace({ state: 'submitted', evidence_hash: 'h' })).toEqual({ at: 2, end: null, turn: 'them' })
    expect(paperPlace({ state: 'disputed', evidence_hash: 'h' })).toEqual({ at: 2, end: 'disputed', turn: 'them' })
    expect(paperPlace({ state: 'released', evidence_hash: 'h' })).toEqual({ at: 3, end: null, turn: 'none' })
    expect(paperPlace({ state: 'refunded', evidence_hash: 'h' })).toEqual({ at: 2, end: 'refunded', turn: 'none' })
    expect(paperPlace({ state: 'refunded', evidence_hash: null })).toEqual({ at: 1, end: 'refunded', turn: 'none' })
  })

  it('places milestones on the chain by their state and whose turn the service says it is', () => {
    expect(earnChainPlace({ state: 'chain-draft', actions: ['quote'], pending: null })).toEqual({ at: -1, end: null, turn: 'you' })
    expect(earnChainPlace({ state: 'chain-offered', actions: [], pending: null })).toEqual({ at: 0, end: null, turn: 'them' })
    expect(earnChainPlace({ state: 'chain-offered', actions: ['fund'], pending: null })).toEqual({ at: 0, end: null, turn: 'you' })
    expect(earnChainPlace({ state: 'chain-expired', actions: ['quote'], pending: null })).toEqual({ at: 0, end: 'lapsed', turn: 'you' })
    expect(earnChainPlace({ state: 'chain-funded', actions: ['deliver', 'release'], pending: null })).toEqual({ at: 1, end: null, turn: 'you' })
    expect(earnChainPlace({ state: 'chain-funded', actions: [], pending: null })).toEqual({ at: 1, end: null, turn: 'them' })
    expect(earnChainPlace({ state: 'chain-released', actions: [], pending: null })).toEqual({ at: 3, end: null, turn: 'none' })
    expect(earnChainPlace({ state: 'chain-refunded', actions: [], pending: null })).toEqual({ at: 1, end: 'refunded', turn: 'none' })
    expect(earnChainPlace({ state: 'chain-funded', actions: [], pending: { status: 'awaiting-signature', yours: true } })).toEqual({ at: 1, end: null, turn: 'you' })
    expect(earnChainPlace({ state: 'chain-funded', actions: [], pending: { status: 'sending', yours: true } })).toEqual({ at: 1, end: null, turn: 'them' })
  })
})

describe('Earn: the colours say whose move it is, and the stage has a name on a phone', () => {
  it('colours a milestone\'s stamp as its ring: marigold when the next move is yours, blue when it is the other side\'s', () => {
    expect(moveTone(paperPlace({ state: 'funded', evidence_hash: null }))).toBe('wait')
    expect(moveTone(paperPlace({ state: 'submitted', evidence_hash: 'h' }))).toBe('info')
    expect(moveTone(earnChainPlace({ state: 'chain-funded', actions: ['deliver', 'release'], pending: null }))).toBe('wait')
    expect(moveTone(earnChainPlace({ state: 'chain-funded', actions: [], pending: null }))).toBe('info')
    expect(moveTone(earnChainPlace({ state: 'chain-offered', actions: [], pending: null }))).toBe('info')
    expect(moveTone(earnChainPlace({ state: 'chain-draft', actions: ['quote'], pending: null }))).toBe('wait')
    expect(moveTone(earnChainPlace({ state: 'chain-expired', actions: ['quote'], pending: null }))).toBe('wait')
    // a dispute is red and money paid is green whoever moves next; money gone back to the client is neither
    expect(moveTone(paperPlace({ state: 'disputed', evidence_hash: 'h' }))).toBe('void')
    expect(moveTone(paperPlace({ state: 'released', evidence_hash: 'h' }))).toBe('ok')
    expect(moveTone(earnChainPlace({ state: 'chain-released', actions: [], pending: null }))).toBe('ok')
    expect(moveTone(paperPlace({ state: 'refunded', evidence_hash: 'h' }))).toBe('plain')
  })

  it('names the stage a milestone has reached, for the track on a phone', () => {
    expect(stageName(earnChainPlace({ state: 'chain-draft', actions: ['quote'], pending: null }))).toBe('Not offered yet')
    expect(stageName(earnChainPlace({ state: 'chain-offered', actions: [], pending: null }))).toBe('Offered')
    expect(stageName(earnChainPlace({ state: 'chain-expired', actions: ['quote'], pending: null }))).toBe('Offer lapsed')
    expect(stageName(paperPlace({ state: 'funded', evidence_hash: null }))).toBe('In escrow')
    expect(stageName(paperPlace({ state: 'submitted', evidence_hash: 'h' }))).toBe('Work submitted')
    expect(stageName(paperPlace({ state: 'disputed', evidence_hash: 'h' }))).toBe('Disputed')
    expect(stageName(paperPlace({ state: 'refunded', evidence_hash: 'h' }))).toBe('Refunded')
    expect(stageName(paperPlace({ state: 'released', evidence_hash: 'h' }))).toBe('Paid')
  })
})

describe('Evidence: a case reads plainly, and identical cases fold into one row', () => {
  it('writes test tokens as words, drops raw addresses and gives times in India time', () => {
    expect(readable('Paid 3.00 tINR to CloudCo; treasury now 99,997.00 tINR.')).toBe('Paid 3.00 test rupees to CloudCo; treasury now 99,997.00 test rupees.')
    expect(readable('this conversion fits: 410.36 tINR into tUSD for 0x39F2cE71e85A')).toBe('this conversion fits: 410.36 test rupees into test dollars')
    // rupees grouped the Indian way, as everywhere else in the app
    expect(readable('the opening grant of 100,000.00 test tINR arrived')).toBe('the opening grant of 1,00,000.00 test rupees arrived')
    expect(readable('Converted 1234567.5 tINR → 0.11 tUSD; tranches 200–2,000 tINR')).toBe('Converted 12,34,567.5 test rupees → 0.11 test dollars; tranches 200–2,000 test rupees')
    expect(readable('ring-fenced as liability #1, due 2026-12-22T17:42:19.000Z. Free')).toBe('ring-fenced as liability #1, due 22 Dec, 23:12. Free')
  })

  it('keeps file names, commands and register ids out of the readable words (they stay in each section\'s technical detail)', () => {
    expect(readable('Compare its root with one obtained independently (verify-evidence.ts --root), check the receipt-chain head against a fresh read (--head), or re-read the transactions from the chain (--rpc).')).toBe('Compare its root with one obtained independently, check the receipt-chain head against a fresh read, or re-read the transactions from the chain.')
    expect(readable('No one outside this work has reviewed the code that made these records (server/readiness.ts lists this as a standing blocker).')).toBe('No one outside this work has reviewed the code that made these records.')
    expect(readable('replaced by tokens before sending (N-005); shown as sent')).toBe('replaced by tokens before sending; shown as sent')
    expect(readable('Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion fits')).toBe('Co-signer refused: C12 not met: Authority budget: this conversion fits')
    expect(readable('the release\'s deterministic policy code (roles/treasury.ts decideTranche); the co-signer re-derived it')).toBe('the release\'s deterministic policy code; the co-signer re-derived it')
    expect(readable('Not re-verified here (the verifier needs a public RPC: owner decision F-063). The rail never contacts it.')).toBe('Not re-verified here (the verifier needs a public RPC). The rail never contacts it.')
  })

  it('says what each check does, and who checked, in words', () => {
    expect(checkWords('Keep 10 test dollars in the dollar reserve: vault-available')).toBe('Keep 10 test dollars in the dollar reserve: the on-chain wallet answered')
    expect(checkWords('Keep 10 test dollars in the dollar reserve: reserve-target-range')).toBe('Keep 10 test dollars in the dollar reserve: the reserve target is within what the wallet accepts')
    expect(checkWords('mandate-active')).toBe('A signed mandate is in force')
    expect(checkWords('within-run-limit')).toBe('Within the limit for one run')
    expect(checkWords('C12: Authority budget (R7 D7)')).toBe('Authority budget, the co-signer\'s rule C12')
    expect(checkWords('proposal-valid: Invest ₹1,000 a month')).toBe('Invest ₹1,000 a month: the proposal is valid')
    expect(checkWords('some-new-check')).toBe('Some new check')
    // the vault service's own steps, as its records name them
    expect(checkWords('cosigner')).toBe('The co-signer\'s own rules are met')
    expect(checkWords('decide')).toBe('The agent works out the tranche')
    expect(checkWords('reconcile')).toBe('Balances agree before and after')
    expect(plainBy('co-signer')).toBe('the co-signer')
    expect(plainBy('reconciliation')).toBe('comparing balances before and after')
    expect(plainBy('validation (server/ai.ts checkWallet, on the vault service\'s own figures)')).toBe('QED, on the vault service\'s own figures')
    expect(plainBy('validation (server/ai.ts storeProposal, then server/programs.ts buildDraft)')).toBe('QED, as it stores and drafts the proposal')
    expect(plainBy('engine (server/policy.ts decide)')).toBe('QED\'s engine')
    expect(plainBy('model boundary (server/ai.ts)')).toBe('QED\'s guard around the model')
    expect(plainBy('co-signer (decision record #11)')).toBe('the co-signer, in its decision record no. 11')
    expect(plainBy('vault service')).toBe('the vault service')
  })

  it('says what happened once: the record\'s own words when they say why nothing moved, never the same sentence twice', () => {
    expect(whatHappened('proposed', null, 'Nothing moved: no proposal of this call was signed.')).toBe('Nothing moved: no proposal of this call was signed.')
    expect(whatHappened('proposed', null, 'This call moved nothing itself. What ran later, under the signed instruction, is in that instruction\'s run cases.')).toBe('This call moved nothing itself. What ran later, under the signed instruction, is in that instruction\'s run cases.')
    expect(whatHappened('blocked', null, 'Refused before anything was sent: It is above the ₹3,000 cap.')).toBe('Nothing moved: it was refused before anything was sent. It is above the ₹3,000 cap.')
    expect(whatHappened('refused', null, 'Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion fits')).toBe('Nothing moved: it was refused before anything was sent. Co-signer refused.')
    expect(whatHappened('failed', null, 'failed: The rail declined it. Money returned.')).toBe('Nothing moved. The rail declined it.')
    expect(whatHappened('no-action', null, 'Nothing to do: the reserve was at its target')).toBe('Nothing moved. Nothing to do.')
    expect(whatHappened('done', null, '')).toBe('Nothing moved.')
    expect(whatHappened('executed', '₹25,000.00 from A to B', 'Done: paid')).toBe('₹25,000.00 from A to B')
  })

  it('does not say "Nothing moved" above the record\'s own sentence that says it', () => {
    expect(nothingMovedLine('Nothing moved: no proposal of this call was signed.')).toBeNull()
    expect(nothingMovedLine('This call moved nothing itself. What ran later is in its run cases.')).toBeNull()
    expect(nothingMovedLine('Co-signer refused: C12 not met')).toBe('Nothing moved.')
    expect(nothingMovedLine(null)).toBe('Nothing moved.')
  })

  it('says something ran under earlier authority only when something ran', () => {
    expect(authorityLine({ freshOwnerSignature: false, ranUnder: [] })).toBeNull()
    expect(authorityLine({})).toBeNull()
    expect(authorityLine({ freshOwnerSignature: false, ranUnder: [{ kind: 'standing-policy' }] })).toBe('No fresh owner signature: it ran under authority signed earlier.')
    expect(authorityLine({ freshOwnerSignature: true, ranUnder: [] })).toBe('A fresh owner signature was needed for this.')
  })

  it('folds consecutive cases with the same title and outcome, newest first, and keeps every case', () => {
    const c = (id: string, title: string, outcome = 'refused') => ({ id, kind: 'vault-job' as const, title, outcome, at: '2026-11-22T18:00:00.000Z', venue: 'local-chain' as const, model: null, standingAuthority: true })
    const groups = groupCases([c('a', 'Refused'), c('b', 'Refused'), c('c', 'Refused'), c('d', 'Paid', 'executed'), c('e', 'Refused')])
    expect(groups.map((g) => [g.lead.id, g.all.map((x) => x.id)])).toEqual([['a', ['a', 'b', 'c']], ['d', ['d']], ['e', ['e']]])
  })
})

describe('Evidence: what kind of evidence each case is, and what executed and reconciled, in the case\'s own figures', () => {
  it('names each kind of execution as the owner\'s directive asks: local chain, paper (simulated), a throwaway chain, nothing sent', () => {
    expect(executionOf('local-chain').word).toBe('Local test chain')
    expect(executionOf('paper').says).toMatch(/^Simulated/)
    expect(executionOf('ephemeral-chain').says).toMatch(/only its record remains/)
    expect(executionOf('none').word).toBe('Nothing sent')
  })

  it('says what executed: the transactions and their blocks, a paper fill, or nothing', () => {
    expect(executedWords({ outcome: 'executed', venue: 'local-chain' }, { executed: true }, { transactions: [{ status: 'success', block: '59', chain: 'vault' }] })).toBe('One transaction on the local test chain on this QED installation; 1 of 1 succeeded, in block 59.')
    expect(executedWords({ outcome: 'executed', venue: 'paper' }, { executed: true }, { venue: { kind: 'paper' }, transactions: [] })).toMatch(/^Filled by a paper venue/)
    expect(executedWords({ outcome: 'refused', venue: 'local-chain' }, { executed: false }, { transactions: [] })).toBe('Nothing: it was refused before anything was sent.')
  })

  it('says what reconciled, from the case\'s own verification, and never calls a broken chain intact', () => {
    const v = { receiptChain: { server: { ok: true, count: 3, brokenAt: null } }, ledger: { breaks: [] } }
    expect(reconciledWords({ reconciliation: [{ state: 'reconciled', breaks: [] }] }, {}, v)).toBe('The venue\'s own record agrees with the ledger. The receipt chain (3 receipts) and the ledger were intact when the case was assembled.')
    expect(reconciledWords({}, { balances: [{ source: 'the vault service, re-read from the chain after the transaction' }] }, { ...v, vaultDecisions: { server: { ok: false, records: 9, brokenAt: 4 } } })).toBe('The balances were re-read from the chain after the transaction. The receipt chain (3 receipts) and the ledger were intact when the case was assembled. The wallet\'s decision records are broken at no. 4.')
  })

  it('writes a token amount with its unit in words, at least to the paisa', () => {
    expect(units('300', 2, 'tINR')).toBe('3.00 test rupees')
    expect(units('-10000000', 2, 'tINR')).toBe('−1,00,000.00 test rupees')
    expect(units('118987', 6, 'tUSD')).toBe('0.118987 test dollars')
    expect(units('19492', 2, 'INR')).toBe('₹194.92')
  })
})

describe('Record and evidence: long lists fold, and a reason stays plain', () => {
  it('keeps the approved document\'s fingerprint out of a check\'s plain reason, and leaves other reasons as recorded', () => {
    expect(plainReason('Confirmed by passkey; document 936395aa7c5d…')).toBe('Confirmed by passkey; the document you approved')
    expect(plainReason('₹25,000.00 needed; ₹8,97,000.00 available in the bank account.')).toBe('₹25,000.00 needed; ₹8,97,000.00 available in the bank account.')
  })

  it('puts the checks that failed first, each group in its recorded order', () => {
    const k = (name: string, pass: boolean) => ({ name, pass })
    expect(orderChecks([k('a', true), k('b', false), k('c', true), k('d', false)]).map((x) => x.name)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('groups related refusals by what was refused, newest first, keeping every case', () => {
    const r = (caseId: string, what: string, at: string) => ({ caseId, what, at })
    const groups = groupRelated([r('1', 'policy-tick', '2026-11-22T18:00:00Z'), r('2', 'cosigner-policy-trade', '2026-11-22T18:00:01Z'), r('3', 'policy-tick', '2026-11-22T18:05:00Z'), r('4', 'cosigner-policy-trade', '2026-11-22T18:05:01Z'), r('5', 'policy-tick', '2026-11-22T17:55:00Z')])
    expect(groups.map((g) => [g.key, g.items.map((x) => x.caseId)])).toEqual([['policy-tick', ['3', '1', '5']], ['cosigner-policy-trade', ['4', '2']]])
  })
})

describe('Activity: finding a row, and taking the rows away', () => {
  const rows = (): DayEvent[] => [...toEvents({ actions: [payment(), payment({ id: 'act_q', origin: 'program', programTitle: 'Pay bills from 2 payees up to ₹3,000 each', params: { payeeName: 'City Power', amount: '612000', memo: '=HYPERLINK("x")' }, result: { movedPaise: '612000', rail: 'imps' }, receiptId: null, createdAt: at('2026-11-22 23:20') })], runs: [] }, [line({})]), ...walletEvents([job({})], UNITS)]

  it('reads a figure without its sign, rupee sign or separators, and a word in lower case', () => {
    expect(queryTerms('₹25,000  Meera')).toEqual(['25000', 'meera'])
    expect(queryTerms('−3.00 refused')).toEqual(['3.00', 'refused'])
  })

  it('finds a row by its payee, its amount written any way, its rail, who acted and its state, every word at once', () => {
    const keys = (q: string) => rows().filter(matchesQuery(q)).map((e) => e.key).sort()
    expect(keys('meera')).toEqual(['act_pay'])
    for (const q of ['25000', '25,000', '₹25,000.00', 'upi rent']) expect(keys(q), q).toEqual(['act_pay'])
    expect(keys('3.00 test rupees')).toEqual(['job:j1'])
    expect(keys('qed')).toEqual(['act_q'])
    expect(keys('completed')).toEqual(['act_pay', 'act_q', 'job:j1'])
    expect(keys('meera qed')).toEqual([])
    expect(keys('')).toHaveLength(3)
  })

  it('writes the rows oldest first, money out and in apart, each figure exact, and a typed cell that could run as a formula as text', () => {
    const csv = dayBookCsv(rows())
    const lines = csv.trimEnd().split('\r\n')
    // the first column says which time orders the rows: when each was asked for, fell due or was raised (R13)
    expect(lines[0]).toBe('"Asked for, due or raised (IST)",Account,Who acted,What,Details,Under,Out,In,"Asked, nothing moved",Unit,Came back,Came back unit,After,State,Record,Receipt')
    expect(lines).toHaveLength(4)
    // the wallet's payment (23:00) first, then Meera (23:12), then City Power (23:20)
    expect(lines[1]).toMatch(/^2026-11-22T23:00:00\.000\+05:30,On-chain wallet,You,Paid CloudCo,/)
    expect(lines[1]).toContain(',3.00,,,tINR (test rupees of no value),')
    expect(lines[2]).toMatch(/^2026-11-22T23:12:00\.000\+05:30,Bank account,You,Paid Meera Nair,/)
    expect(lines[2]).toContain(',25000.00,,,INR,,,"₹8,75,000.00 after",Completed,/record/act_pay,/receipts/rcp_1')
    // a memo someone typed is text, never a formula, and its quotes are doubled
    expect(lines[3]).toContain('"\'=HYPERLINK(""x""), by IMPS. 5 of 5 checks passed')
  })
})

describe('Evidence, the receipt: the words a search reads, the reference, and a receipt that needs attention', () => {
  it('searches a case by its title as read, its kind, how it ended and where it ran', () => {
    const t = caseText({ id: 'vault.1', kind: 'vault-job', title: 'Paid 3.00 tINR to CloudCo', outcome: 'executed', at: null, venue: 'local-chain', model: null, standingAuthority: false })
    for (const w of ['3.00 test rupees', 'on-chain wallet', 'completed', 'local test chain', 'no model']) expect(t, w).toContain(w)
  })

  it('says how the average price sat against its reference, and exactly at it when it did', () => {
    expect(slippageWords(0)).toBe('; exactly at the reference')
    expect(slippageWords(12)).toBe('; 0.120% worse than the reference')
    expect(slippageWords(-5)).toBe('; 0.050% better than the reference')
    expect(slippageWords(null)).toBe('')
  })

  it('never says a receipt is done when the venue\'s record differs', () => {
    expect(receiptOutcome({ outcome: 'done', reconciliation: { state: 'break' } })).toEqual([NEEDS_ATTENTION, 'void'])
    expect(receiptOutcome({ outcome: 'done', reconciliation: { state: 'reconciled' } })).toEqual(['Completed', 'ok'])
    expect(receiptOutcome({ outcome: 'blocked' })).toEqual(['Refused by QED\'s checks', 'void'])
  })
})

// ------------------------------------------------------------------------------------------------ R12 task comparison, gap 9 and the copy fix

/**
 * Every template a row's details are built from, each once: payments and orders in every state the engine records, the
 * runs that sent nothing (alone and folded, with one reason and with several), disputes, and the wallet's jobs.
 */
function everyDetail(): DayEvent[] {
  const btc = { id: 'coindcx:BTCINR', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }
  const fund = { id: 'amfi:120716', name: 'UTI Nifty 50 Index Fund', kind: 'mutual_fund', baseAsset: 'UNITS', baseScale: 3 }
  const order = (p: Partial<Act>): Act => payment({ kind: 'order', venue: 'paper-crypto', params: { side: 'buy', type: 'market', amount: '300000', instrumentId: btc.id }, instrument: btc, result: {}, reconState: 'not_applicable', ...p })
  const refusedOn = { decidedAt: 1, checks: [ok('program-active'), { name: 'within-run-limit', ok: false, detail: '₹6,120 is above ₹3,000.' }] }
  const actions: Act[] = [
    payment(), payment({ id: 'p-open', reconState: 'open' }), payment({ id: 'p-break', reconState: 'break' }),
    payment({ id: 'p-unknown', state: 'working', result: { railState: 'unknown' } }),
    payment({ id: 'p-rail', state: 'working', result: { rail: 'upi', railNote: 'The rail is slow today.' } }),
    payment({ id: 'p-sending', state: 'submitting', result: {} }),
    payment({ id: 'p-failed', state: 'failed', error: 'The rail declined it. Nothing left your bank.', result: {} }),
    payment({ id: 'p-refused', state: 'blocked', decision: refusedOn, result: {} }),
    payment({ id: 'p-waiting', state: 'planned', result: { waitingFor: 'a fresh price from CoinDCX.' } }),
    payment({ id: 'p-planned', state: 'planned', result: {} }),
    order({ id: 'o-fund-buy', instrument: fund, params: { side: 'buy', type: 'nav', amount: '500000' }, state: 'working', result: { navEntitledFrom: '25 Nov 2026' } }),
    order({ id: 'o-fund-paid', instrument: fund, params: { side: 'sell', type: 'nav' }, state: 'working', result: { payoutAt: at('2026-11-25 09:00') } }),
    order({ id: 'o-fund-held', instrument: fund, params: { side: 'sell', type: 'nav' }, state: 'working', result: {} }),
    order({ id: 'o-stop-note', params: { side: 'sell', type: 'stop', stopPrice: '6000000' }, state: 'working', result: { venueNote: 'Resting at the venue. It sells at ₹60,00,000 or less.' } }),
    order({ id: 'o-stop', params: { side: 'sell', type: 'stop' }, state: 'working', result: {} }),
    order({ id: 'o-limit', params: { side: 'buy', type: 'limit' }, state: 'working', result: {} }),
    order({ id: 'o-venue', state: 'working', result: {} }),
    order({ id: 'o-filled', state: 'done', result: { movedPaise: '296798', filledQty: '46000' }, reconState: 'reconciled' }),
    order({ id: 'o-partial', state: 'partial', error: 'Only part filled. The rest was cancelled.', result: { movedPaise: '100000', filledQty: '10000' }, reconState: 'open' }),
    order({ id: 'o-expired', state: 'expired', error: 'It lapsed before the venue answered.', result: {} }),
    order({ id: 'o-cancelled', state: 'cancelled', error: 'You cancelled it.', result: {} }),
    order({ id: 'o-rejected', state: 'rejected', error: 'The venue rejected it: the price moved.', result: {} }),
  ]
  const runs = [
    run({ id: 'r-1', reason: 'The engine was not running.' }), run({ id: 'r-2', dueAt: at('2026-11-22 03:00'), reason: 'The engine was not running.' }),
    run({ id: 'r-3', programId: 'prg_b', state: 'skipped', reason: 'Nothing to do today.' }), run({ id: 'r-4', programId: 'prg_b', state: 'skipped', dueAt: at('2026-11-22 04:00'), reason: 'The fund was closed.' }),
    run({ id: 'r-5', programId: 'prg_c', state: 'expired', reason: 'You did not answer in time.' }), run({ id: 'r-6', programId: 'prg_d', state: 'cancelled', reason: null }),
    run({ id: 'r-7', programId: 'prg_e', state: 'blocked', reason: 'It is above the ₹3,000 cap.' }), run({ id: 'r-8', programId: 'prg_f', state: 'failed', reason: 'The venue was down; try later.' }),
  ]
  const disputes: Dispute[] = [
    { id: 'd-open', action_id: 'act_pay', state: 'open', reason: 'Wrong amount.', resolution: null, created_at: at('2026-11-22 23:20'), updated_at: at('2026-11-22 23:20') },
    { id: 'd-refund', action_id: 'act_pay', state: 'resolved_refund', reason: 'Charged twice', resolution: 'Refunded in full. The payee agreed.', created_at: at('2026-11-22 23:21'), updated_at: at('2026-11-22 23:30') },
    { id: 'd-stands', action_id: 'act_pay', state: 'resolved_stands', reason: 'Not delivered', resolution: 'The payment stands.', created_at: at('2026-11-22 23:22'), updated_at: at('2026-11-22 23:40') },
  ]
  const jobs = [
    job({}), job({ id: 'j-refused', kind: 'policy-tick', proposalId: null, outcome: 'refused', summary: 'Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion fits', evidence: {} }),
    job({ id: 'j-error', outcome: 'error', summary: 'The chain did not answer. Nothing was sent.', evidence: {} }),
    { ...job({ id: 'j-failed', status: 'failed', result: null }), error: 'The vault service stopped. Ask again later.' },
  ]
  return [...toEvents({ actions, runs, disputes }, [line({})]), ...walletEvents(jobs, UNITS)]
}

describe('Activity: a row\'s details read as sentences, every template, with no doubled punctuation', () => {
  it('each detail is a fragment without its own closing punctuation; the joiner adds one full stop between them', () => {
    const events = everyDetail()
    expect(events.length).toBeGreaterThan(30)
    for (const e of events) for (const d of e.detail) expect(d, `${e.key}: “${d}”`).not.toMatch(/[.;,:\s]$/)
    // the one the comparison found: a fund bought and not yet allotted (now said as its registrar's stage), then its checks
    expect(detailText(only(events, 'o-fund-buy').detail)).toBe('Order with the registrar. 5 of 5 checks passed.')
  })

  it('neither the day book nor its CSV file says ".." or ". ." or ",." anywhere', () => {
    const events = everyDetail()
    const doubled = /\.\.|\.\s+\.|[,;:]\s*\.|\.\s*[,;]|\s\.(?!\d)/
    for (const e of events) expect(detailText(e.detail), e.key).not.toMatch(doubled)
    // each cell of the file (a comma between cells is the file's, not the text's)
    const cells = (l: string): string[] => [...l.matchAll(/("((?:[^"]|"")*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]!))
    const csv = dayBookCsv(events)
    for (const l of csv.trimEnd().split('\r\n')) for (const c of cells(l)) expect(c).not.toMatch(doubled)
    expect(csv).toContain(',Order with the registrar. 5 of 5 checks passed.,')
  })
})

describe('Activity: search forgives a slip of the finger in a name, and only where a name is long enough', () => {
  const rows = (): DayEvent[] => [
    ...toEvents({ actions: [
      payment(),
      payment({ id: 'act_btc', kind: 'order', venue: 'paper-crypto', params: { side: 'buy', type: 'market', amount: '300000', instrumentId: 'coindcx:BTCINR' }, instrument: { id: 'coindcx:BTCINR', name: 'Bitcoin in rupees', kind: 'crypto', baseAsset: 'BTC', baseScale: 8 }, result: { movedPaise: '300000', filledQty: '46000' } }),
      payment({ id: 'act_power', params: { payeeName: 'Bharatpur Electricity', amount: '612000' }, result: { movedPaise: '612000', rail: 'imps' } }),
    ], runs: [] }, [line({})]),
    ...walletEvents([job({})], UNITS),
  ]
  const keys = (q: string) => rows().filter(matchesQuery(q)).map((e) => e.key).sort()

  it('"Meera Nari" finds Meera Nair and "bitcon" finds bitcoin: one edit for a word of 4 to 7 letters, a swap counted as one', () => {
    expect(keys('Meera Nari')).toEqual(['act_pay'])
    expect(keys('nari')).toEqual(['act_pay'])
    expect(keys('bitcon')).toEqual(['act_btc'])
    expect(keys('mera')).toEqual(['act_pay'])
    expect(keys('cloudoc')).toEqual(['job:j1'])
  })

  it('two edits for a word of 8 letters or more, never for a shorter one', () => {
    expect(keys('elektrcity')).toEqual(['act_power'])
    expect(keys('bltcon')).toEqual([]) // six letters, two edits from bitcoin
  })

  it('a short word is matched as typed, never loosely, so a short search does not find everything', () => {
    expect(keys('bit')).toEqual(['act_btc'])
    expect(keys('bjt')).toEqual([])
    expect(keys('nai')).toEqual(['act_pay'])
    expect(keys('nar')).toEqual([]) // three letters, not said as typed
    expect(keys('xair')).toEqual(['act_pay']) // four letters, one edit from Nair
    expect(keys('xxxx')).toEqual([])
  })

  it('figures are matched exactly: a wrong digit finds nothing', () => {
    expect(keys('25000')).toEqual(['act_pay'])
    expect(keys('25001')).toEqual([])
  })

  it('names the close spellings it used, so the person sees why a row was found', () => {
    expect(closeSpellings('Meera Nari', rows())).toEqual([['nari', 'nair']])
    expect(closeSpellings('bitcon', rows())).toEqual([['bitcon', 'bitcoin']])
    expect(closeSpellings('meera', rows())).toEqual([])
  })
})

describe('Activity: three more filters, by date, by amount and by direction', () => {
  const rows = (): DayEvent[] => [
    ...toEvents({ actions: [
      payment({ id: 'big', createdAt: at('2026-11-20 10:00') }),
      payment({ id: 'small', params: { payeeName: 'City Power', amount: '99900' }, result: { movedPaise: '99900', rail: 'upi' }, createdAt: at('2026-11-21 00:00') }),
      payment({ id: 'refused', state: 'blocked', params: { payeeName: 'City Power', amount: '612000' }, result: {}, createdAt: at('2026-11-21 23:59') }),
    ], runs: [run({ id: 'r9', dueAt: at('2026-11-22 02:00') })] }, [line({ actionId: 'big' }), line({ seq: 3, actionId: 'small', amount: -99900, balance: 87400100 })]),
    ...walletEvents([job({}), job({ id: 'grant', kind: 'provision', proposalId: null, evidence: { grant: { vault: '10000000' } }, createdAt: new Date(at('2026-11-19 09:00')).toISOString() })], UNITS),
  ]
  const keys = (f: Partial<Filters>, r: Partial<Ranges> = {}) => rows().filter(matches({ ...NO_FILTER, ...f })).filter(inRanges({ ...NO_RANGES, ...r })).map((e) => e.key).sort()

  it('money in and money out are the rows that moved money that way; a row that moved nothing is neither', () => {
    expect(rows().map((e) => [e.key, directionOf(e)]).sort()).toEqual([['big', 'out'], ['job:grant', 'in'], ['job:j1', 'out'], ['r9', null], ['refused', null], ['small', 'out']])
    expect(keys({ direction: 'in' })).toEqual(['job:grant'])
    expect(keys({ direction: 'out' })).toEqual(['big', 'job:j1', 'small'])
    expect(keys({ direction: 'out', account: 'bank' })).toEqual(['big', 'small'])
  })

  it('an amount range keeps rows whose amount, in rupees (test rupees on the wallet), lies within it, ends included, exactly', () => {
    expect(keys({}, { min: 99_900 })).toEqual(['big', 'job:grant', 'refused', 'small'])
    expect(keys({}, { min: 99_901 })).toEqual(['big', 'job:grant', 'refused'])
    expect(keys({}, { max: 300 })).toEqual(['job:j1'])
    expect(keys({}, { min: 100_000, max: 2_500_000 })).toEqual(['big', 'refused'])
    expect(keys({ direction: 'out' }, { min: 100_000 })).toEqual(['big'])
  })

  it('a date range keeps rows from 00:00 IST of its first day to the end of its last, either end may be open', () => {
    expect(keys({}, { first: '2026-11-21', last: '2026-11-21' })).toEqual(['refused', 'small'])
    expect(keys({}, { first: '2026-11-21' })).toEqual(['job:j1', 'r9', 'refused', 'small'])
    expect(keys({}, { last: '2026-11-20' })).toEqual(['big', 'job:grant'])
    expect(keys({}, { first: '2026-11-25', last: '2026-11-30' })).toEqual([])
  })

  it('reads the four fields as typed; a field that is not an amount or a date, or a pair the wrong way round, is not applied and says why', () => {
    expect(rangesFrom({ min: '1,000', max: '₹25000', first: '2026-11-02', last: '2026-11-08' })).toEqual({ ranges: { min: 100_000, max: 2_500_000, first: '2026-11-02', last: '2026-11-08' }, errors: {} })
    expect(rangesFrom({ min: '', max: '', first: '', last: '' })).toEqual({ ranges: NO_RANGES, errors: {} })
    expect(rangesFrom({ min: 'ten', max: '250.505', first: '', last: '' })).toEqual({ ranges: NO_RANGES, errors: { min: 'Give an amount in rupees, like 1,500 or 250.50.', max: 'Give an amount in rupees, like 1,500 or 250.50.' } })
    expect(rangesFrom({ min: '5,000', max: '500', first: '', last: '' })).toEqual({ ranges: NO_RANGES, errors: { max: 'The most, ₹500, is less than the least, ₹5,000.' } })
    expect(rangesFrom({ min: '', max: '', first: '2026-11-10', last: '2026-11-02' })).toEqual({ ranges: NO_RANGES, errors: { last: 'The last day, 2 Nov 2026, is before the first day, 10 Nov 2026.' } })
    expect(rangesFrom({ min: '', max: '', first: '2026-11-10', last: '' }).ranges).toEqual({ ...NO_RANGES, first: '2026-11-10' })
  })

  it('names every filter in force in words, each one removable, the search first', () => {
    const f: Filters = { ...NO_FILTER, account: 'bank', direction: 'out' }
    expect(inForce(f, { ...NO_RANGES, min: 100_000, max: 2_500_000, first: '2026-11-02', last: '2026-11-08' }, ' Meera  Nari ').map((x) => [x.key, x.words])).toEqual([
      ['q', 'Search: “Meera Nari”'], ['account', 'Account: Bank account'], ['direction', 'Direction: Money out'],
      ['amount', 'Amount: ₹1,000 to ₹25,000'], ['dates', 'Dates: 2 Nov 2026 to 8 Nov 2026'],
    ])
    expect(inForce(NO_FILTER, { ...NO_RANGES, min: 50 }, '').map((x) => x.words)).toEqual(['Amount: at least ₹0.50'])
    expect(inForce(NO_FILTER, { ...NO_RANGES, last: '2026-11-08' }, '').map((x) => x.words)).toEqual(['Dates: up to 8 Nov 2026'])
    expect(inForce(NO_FILTER, NO_RANGES, '   ')).toEqual([])
  })
})

describe('Activity: the day book file says which days it covers and what was chosen', () => {
  it('opens with the period, the rows chosen and when it was read, then the table', () => {
    const events = toEvents({ actions: [payment()], runs: [] }, [line({})])
    const csv = dayBookCsv(events, { period: '2 November 2026 to 8 November 2026', rows: 'Search: “meera”; Direction: Money out', readAt: '24 Nov 2026, 16:31 IST' })
    const lines = csv.trimEnd().split('\r\n')
    // and the order of its rows, stated, not left to be guessed (R13)
    expect(lines.slice(0, 5)).toEqual(['Day book,2 November 2026 to 8 November 2026 (India Standard Time)', 'Rows,Search: “meera”; Direction: Money out', 'Read at,"24 Nov 2026, 16:31 IST"', `Order,"${DAY_BOOK_ORDER}"`, ''])
    expect(DAY_BOOK_ORDER).toMatch(/^Oldest first, by when each was asked for, fell due or was raised/)
    expect(lines[5]).toMatch(/^"Asked for, due or raised \(IST\)",Account,/)
    expect(lines).toHaveLength(7)
  })
})

describe('Activity: the search and filters in the address, so a link, a reload and Back keep them', () => {
  const read = (s: string) => findFrom(new URLSearchParams(s))
  it('reads the search, each filter it knows and the four fields; anything else is left out', () => {
    expect(read('')).toEqual({ q: '', f: NO_FILTER, rt: { min: '', max: '', first: '', last: '' } })
    expect(read('q=Meera+Nari&account=bank&direction=out&min=1%2C000&first=2026-11-02')).toEqual({ q: 'Meera Nari', f: { ...NO_FILTER, account: 'bank', direction: 'out' }, rt: { min: '1,000', max: '', first: '2026-11-02', last: '' } })
    expect(read('who=someone&kind=all&state=nonsense&direction=sideways').f).toEqual(NO_FILTER)
  })

  it('writes only what differs from showing everything, in a fixed order, and reads back what it wrote', () => {
    const s = { q: 'bitcon', f: { ...NO_FILTER, who: 'qed' as const, direction: 'in' as const }, rt: { min: '', max: '5000', first: '', last: '2026-11-08' } }
    expect(findQuery(s)).toBe('q=bitcon&who=qed&direction=in&max=5000&last=2026-11-08')
    expect(read(findQuery(s))).toEqual(s)
    expect(findQuery({ q: '', f: NO_FILTER, rt: { min: '', max: '', first: '', last: '' } })).toBe('')
  })
})
