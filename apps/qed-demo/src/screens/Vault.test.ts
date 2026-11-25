/**
 * The on-chain wallet's words and figures (design "Bounds", DESIGN.md B7; the finish review of 23 Nov before it): each
 * limit says which it is and which one binds; the theft figure adds up from the figures beside it; the wallet's screens
 * carry no internal decision codes and no token tickers (amounts in the owner's units, the contracts' own names one step
 * down); payees and venues read as a person names them; the mandate is drawn as a bound, one row per limit; setting the
 * wallet up is three steps; who owns it, its recovery key and its records are each one sentence with its figure. Nothing
 * here computes money of its own: every figure is the vault service's, carried through, and the only arithmetic is the
 * contract's own sum, recomputed to say which case applies, and the share of a limit used, for drawing.
 */
import { describe, expect, it } from 'vitest'
import type { LimitCheck, MandateView, VaultView } from '../../chain/types.ts'
import { between, bindingLimit, callWords, checkBy, chainLine, currencyHoldings, FINAL_WORDS, firstSentence, headline, inUnits, limitRows, limitWords, ownersLine, payeeName, payeesInWords, plain, quotaWords, reasonHead, receiveId, recordsLine, recordWords, recoveryLine, refusalHead, refusedBy, ROW_OF, sameAddress, setupSteps, share, splitSigners, stepName, theftSum, tokensInWords, venueName, venueReserves, whereWords } from './Vault.tsx'

const check = (id: string, remaining: string | null, pass = true, rule = id): LimitCheck => ({ id, rule, limit: remaining, used: null, remaining, pass })
/** The design fixture's checks (23 Nov): ₹2,500.00 a payment binds the contract's limits, ₹4.94 of budget binds a payment. */
const contract: LimitCheck[] = [check('amount', null), check('mandate-valid', null), check('per-conversion', '250000'), check('mandate-period', '598500'), check('mandate-lifetime', '1998500'), check('vault-daily', '998500'), check('free-buffer', '9997600'), check('not-paused', null)]
const payment: LimitCheck[] = [...contract, check('authority-budget', '494')]

const vault = (p: Partial<VaultView>): VaultView => ({ address: '0x1', token: 'tINR', decimals: 2, balance: '9998700', ringFenced: '600', free: '9998100', dailyCap: '1000000', spentInWindow: '1500', windowStart: 0, availableToday: '598500', worstCaseLoss24h: '1998500', worstCaseScope: '', paused: false, epoch: '0', openLiabilities: '2', owner: '0x2', agent: '0x3', cosigner: '0x4', guardian: '0x5', ...p })
const text = (parts: (string | { b: string })[]): string => parts.map((x) => (typeof x === 'string' ? x : x.b)).join('')

describe('the eight currencies\' test tokens on the wallet tab (money-model S5)', () => {
  const JPY = { symbol: 'tJPY', decimals: 0 }, BHD = { symbol: 'tBHD', decimals: 3 }, EUR = { symbol: 'tEUR', decimals: 6 }
  it('a 0-decimal and a 3-decimal token: whole yen and dinars to the fils, in words beside the figure, never a sign that could read as money', () => {
    expect(headline('1628', JPY)).toEqual({ text: '1,628 test yen', exact: null })
    expect(headline('0', JPY).text).toBe('0 test yen')
    expect(headline('44', BHD)).toEqual({ text: '0.044 test dinars', exact: null })
    expect(headline('37600000', BHD).text).toBe('37,600.000 test dinars')
    // tEUR keeps its sign and is read to the cent, as before
    expect(headline('1095238095', EUR)).toEqual({ text: '€1,095.24', exact: '€1,095.238095' })
  })
  it('venues and the service\'s wording in each token\'s own units and words, with no tickers', () => {
    expect(venueReserves({ r0: '92000000000', token0: 'tEUR', r1: '15000000', token1: 'tJPY' })).toBe('€92,000.00 and 1,50,00,000 test yen')
    expect(venueName({ label: 'tEUR/tBHD · 0.30%', token0: 'tEUR', token1: 'tBHD', feeBps: 30 })).toBe('Euros and dinars, 0.30% fee')
    expect(inUnits('Converted 10.00 tEUR → 1,628 tJPY; the yen reserve holds tJPY')).toBe('Converted €10.00 → 1,628 test yen; the yen reserve holds test yen')
    expect(inUnits('tEUR/tJPY at 163.04 tJPY per tEUR')).toBe('test euros and test yen at 163.04 test yen per test euro')
  })
  it('balances by currency: each test token the wallet holds, over its treasury, its reserve and its own account', () => {
    const st = { treasury: vault({ token: 'tEUR', decimals: 6, balance: '1083738095' }), reserve: vault({ token: 'tJPY', decimals: 0, balance: '1628' }), ownerHolds: { asset: '109523809', reserveAsset: '0' } }
    expect(currencyHoldings(st)).toEqual([
      { symbol: 'tEUR', words: 'test euros', total: '€1,193.26', parts: [['In the treasury', '€1,083.74'], ['In your own account', '€109.52']] },
      { symbol: 'tJPY', words: 'test yen', total: '1,628 test yen', parts: [['In the reserve', '1,628 test yen'], ['In your own account', '0 test yen']] },
    ])
    // the default wallet reads as it always has
    const home = { treasury: vault({}), reserve: vault({ token: 'tUSD', decimals: 6, balance: '118987' }), ownerHolds: { asset: '1000000', reserveAsset: '0' } }
    expect(currencyHoldings(home).map((x) => [x.words, x.total])).toEqual([['test rupees', '₹1,09,987.00'], ['test dollars', '$0.12']])
  })
})

describe('one way of writing money on every wallet tab', () => {
  const INR = { symbol: 'tINR', decimals: 2 }, USD = { symbol: 'tUSD', decimals: 6 }, EUR = { symbol: 'tEUR', decimals: 6 }
  it('a headline figure is to the cent, rounded half up exactly from the raw units, with the exact figure kept when cents hide digits', () => {
    expect(headline('118987', USD)).toEqual({ text: '$0.12', exact: '$0.118987' })
    expect(headline('4881013', USD)).toEqual({ text: '$4.88', exact: '$4.881013' })
    expect(headline('115000', USD)).toEqual({ text: '$0.12', exact: '$0.115' })
    expect(headline('5000000', USD)).toEqual({ text: '$5.00', exact: null })
    expect(headline('9998700', INR)).toEqual({ text: '₹99,987.00', exact: null })
  })
  it('every amount grouped the Indian way, whatever its currency', () => {
    expect(headline('100000000000', USD).text).toBe('$1,00,000.00')
    expect(headline('50000000000', EUR).text).toBe('€50,000.00')
  })
  it('a venue\'s two reserves in one line, in one convention, without tickers', () => {
    expect(venueReserves({ r0: '840000000', token0: 'tINR', r1: '100000000000', token1: 'tUSD' })).toBe('₹84,00,000.00 and $1,00,000.00')
    expect(venueReserves({ r0: '126001000', token0: 'tINR', r1: '14999881013', token1: 'tUSD' })).toBe('₹12,60,010.00 and $14,999.88')
    expect(venueReserves({ r0: '736000000', token0: 'tEUR', r1: '800000000', token1: 'tUSD' })).toBe('€736.00 and $800.00')
  })
})

describe('the theft figure adds up from the figures beside it (QEDLens.blastRadius over 24 hours)', () => {
  it('with today\'s window open: what is left of today\'s limit plus a full day\'s limit when the window starts again', () => {
    expect(theftSum(vault({}))).toBe('₹9,985.00 left of today\'s limit, plus a full day\'s ₹10,000.00 once the daily window starts again within the 24 hours.')
  })
  it('with no window open (the last one ended, its spend still on record): the whole daily limit now and the same again', () => {
    expect(theftSum(vault({ spentInWindow: '1500', worstCaseLoss24h: '2000000' }))).toBe('The whole daily limit, ₹10,000.00, now, and the same again once the daily window starts again within the 24 hours.')
  })
  it('never more than is free', () => {
    expect(theftSum(vault({ free: '500000', worstCaseLoss24h: '500000' }))).toBe('Everything free in it, ₹5,000.00: the daily limits would allow more.')
  })
  it('nothing while it is stopped, without the word the paused stamp uses (the browser tests find that stamp by it)', () => {
    const s = theftSum(vault({ paused: true, worstCaseLoss24h: '0' }))
    expect(s).toBe('Nothing can leave until you resume it.')
    expect(s).not.toMatch(/paused/i)
  })
  it('a daily limit of nothing lets nothing leave (the reserve)', () => {
    expect(theftSum(vault({ token: 'tUSD', decimals: 6, dailyCap: '0', spentInWindow: '0', free: '118987', worstCaseLoss24h: '0' }))).toBe('With a daily limit of $0.00, nothing can leave.')
  })
  it('says nothing it cannot add up', () => {
    expect(theftSum(vault({ worstCaseLoss24h: '1234' }))).toBeNull()
  })
})

describe('which limit binds, named', () => {
  it('the contract\'s limits: the mandate\'s limit for one payment, at ₹2,500.00', () => {
    const b = bindingLimit(contract, '250000')
    expect(b?.id).toBe('per-conversion')
    expect(limitWords(b)).toBe('your mandate\'s limit for one payment')
  })
  it('a payment: the authority budget, lower than every limit of the contract', () => {
    const b = bindingLimit(payment, '494')
    expect(b?.id).toBe('authority-budget')
    expect(limitWords(b)).toBe('your authority budget')
  })
  it('a check that stops everything binds before any amount', () => {
    expect(limitWords(bindingLimit([...contract.slice(0, -1), check('not-paused', null, false)], '0'))).toBe('the wallet is paused')
    expect(limitWords(bindingLimit([check('amount', null), check('mandate-valid', null, false), check('vault-daily', '998500')], '0'))).toBe('no mandate is in force')
  })
  it('each of the other limits in words', () => {
    for (const [id, words] of [['mandate-period', 'what is left of your mandate\'s limit for its period'], ['mandate-lifetime', 'what is left of your mandate\'s limit over its life'], ['vault-daily', 'what is left of the wallet\'s daily limit'], ['free-buffer', 'the free balance, less the small buffer the co-signer keeps'], ['earned-autonomy', 'the co-signer\'s allowance']] as const) {
      expect(limitWords(bindingLimit([check(id, '7')], '7'))).toBe(words)
    }
    expect(limitWords(null)).toBe('the lowest of your limits')
  })
})

describe('no internal decision codes on the wallet\'s screens', () => {
  it('drops the decision references and keeps the rule and its sense', () => {
    expect(plain('Authority budget (co-signer check C12, R7 decision D7): what leaves the workspace')).toBe('Authority budget (co-signer check C12): what leaves the workspace')
    expect(plain('Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion\'s cost')).toBe('Co-signer refused: C12 not met: Authority budget: this conversion\'s cost')
    expect(plain('One of them is your authority budget (R7 decision D7): what you granted')).toBe('One of them is your authority budget: what you granted')
    expect(plain('(D7 assumption A-ID; a second workspace counts as its own only when it shares a passkey)')).toBe('(a second workspace counts as its own only when it shares a passkey)')
    expect(plain('more than is available of the agent\'s authority budget (co-signer check C12, R7 D7)')).toBe('more than is available of the agent\'s authority budget (co-signer check C12)')
  })
  it('still does what it did: references to internal documents removed, dot separators as commas', () => {
    expect(plain('Within the vault\'s daily cap (baseline W-09) · checked')).toBe('Within the vault\'s daily cap, checked')
  })
  it('a co-signer refusal as a headline: the rule\'s number and its name, without codes', () => {
    expect(refusalHead(plain('Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion\'s cost against the reference'))).toBe('The co-signer refused it under its authority budget rule')
    // without plain() first too: neither the rule's number nor the research decision reaches the headline
    expect(refusalHead('Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion\'s cost')).toBe('The co-signer refused it under its authority budget rule')
    expect(refusalHead('Converted 10.00 tINR')).toBeNull()
  })
  it('the vault service\'s request limits in plain words', () => {
    expect(quotaWords('proposals', 'proposals prepared')).toBe('Terms prepared for your approval')
    expect(quotaWords('operations', 'operations accepted')).toBe('Actions it accepted')
    expect(quotaWords('economies', 'scripted economies started')).toBe('Scripted exchanges run in the test lab')
    expect(quotaWords('other', 'something new')).toBe('Something new')
  })
})

describe('payees as a person names them', () => {
  it('in a list', () => {
    expect(payeeName('QEDExecution (conversion module)')).toBe('The conversion service, for conversions you approve')
    expect(payeeName('Dollar reserve')).toBe('Your own dollar reserve')
    expect(payeeName('Euro reserve')).toBe('Your own euro reserve')
    expect(payeeName('CloudCo')).toBe('CloudCo')
  })
  it('in a sentence', () => {
    expect(payeesInWords(['QEDExecution (conversion module)', 'Dollar reserve', 'CloudCo'])).toBe('the conversion service (for conversions you approve), your own dollar reserve and CloudCo')
    expect(payeesInWords(['CloudCo'])).toBe('CloudCo')
    expect(payeesInWords([])).toBe('')
  })
})

describe('who owns it, its recovery key and its records, each one sentence with its figure set apart', () => {
  it('who owns it: one passkey, several, a shared wallet, none', () => {
    expect(text(ownersLine({ shared: false, signers: 1, threshold: 1 }).parts)).toBe('Your passkey owns it: nothing is done as its owner without your signature.')
    expect(text(ownersLine({ shared: false, signers: 2, threshold: 1 }).parts)).toBe('Your 2 passkeys own it: any one of them can sign as its owner.')
    expect(text(ownersLine({ shared: true, signers: 3, threshold: 2 }).parts)).toBe('3 members\' passkeys own it: 2 different members must sign as its owner.')
    const none = ownersLine({ shared: false, signers: 0, threshold: 1 })
    expect(text(none.parts)).toBe('No passkey of yours that can sign today owns it.')
    expect(none.tone).toBe('wait')
    for (const l of [ownersLine({ shared: false, signers: 1, threshold: 1 }), none]) expect(l.parts.some((p) => typeof p !== 'string')).toBe(true)
  })
  it('the recovery key: none (waiting on the owner), set up, still being read, a read that failed (never read as fine)', () => {
    const no = recoveryLine({ hasKey: false, delaySeconds: 259200 })
    expect(text(no.parts)).toBe('No recovery key: if every passkey that signs for it is lost, no one can act for it again.')
    expect(no.tone).toBe('wait')
    const yes = recoveryLine({ hasKey: true, delaySeconds: 259200 })
    expect(text(yes.parts)).toBe('A recovery key is set up: with it a new passkey can be added after 3 days, unless a signer stops it.')
    expect(yes.tone).toBeUndefined()
    expect(text(recoveryLine(null).parts)).toBe('Reading the wallet\'s recovery key from the chain.')
    const failed = recoveryLine('unread')
    expect(text(failed.parts)).toBe('Its recovery key could not be read just now. Security shows it.')
    expect(failed.tone).toBe('wait')
  })
  it('the records: intact, broken, being read, not checked', () => {
    expect(text(recordsLine({ ok: true, records: 53, brokenAt: null }).parts)).toBe('53 decision records, each chained to the one before. The chain is intact, checked again just now.')
    const broken = recordsLine({ ok: false, records: 53, brokenAt: 12 })
    expect(text(broken.parts)).toBe('53 decision records. The chain is broken at no. 12: a record at or before it was changed after it was written.')
    expect(broken.tone).toBe('void')
    expect(text(recordsLine(null).parts)).toBe('Reading the decision records.')
    const failed = recordsLine('unread')
    expect(text(failed.parts)).toBe('The records could not be checked just now.')
    expect(failed.tone).toBe('wait')
  })
  it('a decision record says what happened, and an unknown kind keeps its own words', () => {
    expect(recordWords('owner_provision')).toBe('You accepted the wallet')
    expect(recordWords('faucet-grant')).toBe('The opening grant of test rupees arrived')
    expect(recordWords('cosignerPolicyTrade')).toBe('The co-signer checked a policy tranche')
    expect(recordWords('something-new')).toBe('Something new')
  })
})

describe('no token tickers on the wallet\'s screens: amounts in the owner\'s units, digits moved and never recomputed', () => {
  it('an amount with a ticker takes its currency sign', () => {
    expect(inUnits('Paid 3.00 tINR to CloudCo; treasury now 99,997.00 tINR.')).toBe('Paid ₹3.00 to CloudCo; treasury now ₹99,997.00.')
    expect(inUnits('Converted 10.00 tINR → 0.118987 tUSD; bound 0.118988; reserve now 0.118987 tUSD.')).toBe('Converted ₹10.00 → $0.118987; bound 0.118988; reserve now $0.118987.')
    expect(inUnits('the opening grant of 1,00,000.00 test tINR arrived')).toBe('the opening grant of ₹1,00,000.00 arrived')
    expect(inUnits('Pay CloudCo 3 tINR')).toBe('Pay CloudCo ₹3')
  })
  it('both ends of a change and of a range', () => {
    expect(inUnits('Treasury 1,00,000.00 → 99,997.00 tINR; CloudCo 0.00 → 3.00 tINR.')).toBe('Treasury ₹1,00,000.00 → ₹99,997.00; CloudCo ₹0.00 → ₹3.00.')
    expect(inUnits('keep ≥ 5.00 tUSD free in the dollar reserve; tranches 200–2,000 tINR')).toBe('keep ≥ $5.00 free in the dollar reserve; tranches ₹200–₹2,000')
  })
  it('a ticker on its own, a pair and a rate in words', () => {
    expect(inUnits('Convert surplus tINR into the dollar reserve')).toBe('Convert surplus test rupees into the dollar reserve')
    expect(inUnits('410.36 tINR into tUSD')).toBe('₹410.36 into test dollars')
    expect(inUnits('tINR/tUSD at 84.00 tINR per tUSD')).toBe('test rupees and test dollars at ₹84.00 per test dollar')
    expect(inUnits('Opening grant of test tINR')).toBe('Opening grant of test rupees')
  })
  it('money the contract ring-fences as a liability is money set aside as a promise; a transaction hash is shortened', () => {
    expect(inUnits('Owner ring-fenced 4.00 tINR for CloudCo as liability #2')).toBe('Owner set aside ₹4.00 for CloudCo as promise 2')
    expect(inUnits('Reserve buffer above ring-fenced liabilities preserved')).toBe('Reserve buffer above money set aside for promises preserved')
    expect(inUnits('Transaction 0xb3cc8e7c615f044be9c9e1a8e384c678f24109d1f654ed2dd14252723d108fa3; awaiting')).toBe('Transaction 0xb3cc…8fa3; awaiting')
  })
  it('plain() does it too, after its own cleaning, and a heading stops at a real sentence end', () => {
    expect(plain('Promised 2.00 tINR to CloudCo: ring-fenced as liability #1, due 2026-12-23T12:59:24.000Z. Free balance now 99,995.00 tINR.')).toBe('Promised ₹2.00 to CloudCo: set aside as promise 1, due 23 Dec, 18:29 IST. Free balance now ₹99,995.00.')
    expect(firstSentence(plain('Owner ring-fenced 4.00 tINR for CloudCo as liability #2; free balance now 99,991.00 tINR.'))).toBe('Owner set aside ₹4.00 for CloudCo as promise 2; free balance now ₹99,991.00.')
    expect(firstSentence('Promised ₹2.00: promise 1, due 23 Dec. Free balance now ₹5.00.')).toBe('Promised ₹2.00: promise 1, due 23 Dec.')
  })
  it('a venue as a person names it', () => {
    expect(venueName({ label: 'tINR/tUSD · 0.30% · deep', token0: 'tINR', token1: 'tUSD', feeBps: 30 })).toBe('Rupees and dollars, 0.30% fee, deep')
    expect(venueName({ label: 'tUSD/tEUR · 0.30% · deep (the release\'s pool)', token0: 'tEUR', token1: 'tUSD', feeBps: 30 })).toBe('Dollars and euros, 0.30% fee, deep (the release\'s pool)')
    expect(venueName({ label: 'tINR/tEUR · 0.30%', token0: 'tINR', token1: 'tEUR', feeBps: 30 })).toBe('Rupees and euros, 0.30% fee')
  })
  it('a call the owner account runs, said as what it does; the scheduled ones too', () => {
    expect(callWords('QEDVault (treasury).acceptOwnership')).toBe('accept ownership of the treasury')
    expect(callWords('QEDVault (dollar reserve).acceptOwnership')).toBe('accept ownership of the dollar reserve')
    expect(callWords('QEDVault (treasury).pause')).toBe('pause the treasury')
    expect(callWords('QEDVault (treasury).withdraw')).toBe('withdraw from the treasury to your own account')
    expect(callWords('QEDOwnerAccount.scheduleCalls(QEDVault (treasury).setAgent, QEDExecution.setVenues)')).toBe('schedule, behind your account\'s delay: name the agent\'s key and name the venues a conversion may use')
    expect(callWords('QEDTreasuryPolicy.revoke')).toBe('end the standing policy')
    expect(callWords('QEDVault (treasury).somethingNew')).toBe('something new on the treasury')
  })
  it('a refused step in one line: the co-signer\'s rule by number and name; a long reason is never cut, it goes one step down', () => {
    expect(reasonHead('Refused: C12 not met: Authority budget (R7 D7): this conversion\'s cost against the reference fits in 410.36 tINR')).toBe('Refused under the co-signer\'s authority budget rule.')
    expect(reasonHead('The vault is paused. Nothing was sent.')).toBe('The vault is paused.')
    expect(reasonHead(`${'A very long reason with an amount of 12,345.67 tINR in it '.repeat(5)}end.`)).toBeNull()
  })
  it('a range of times says the day once when both fall on it', () => {
    expect(between('2026-11-23T13:00:00.000Z', '2026-11-23T13:25:00.000Z')).toBe('23 Nov, 18:30 to 18:55')
    expect(between('2026-11-23T13:00:00.000Z', '2026-11-24T13:25:00.000Z')).toBe('23 Nov, 18:30 to 24 Nov, 18:55')
  })
  it('a step is named for what it did, without the contract\'s names', () => {
    expect(stepName('provision', { key: 'receipt', label: 'QEDVault.acceptOwnership mined (both vaults)', status: 'ok' })).toBe('Mined on the chain')
    expect(stepName('ring-fence', { key: 'receipt', label: 'QEDVault.ringFence mined: liability #2', status: 'ok' })).toBe('Mined on the chain: promise 2')
    expect(stepName('pay', { key: 'receipt', label: 'Mined: the vault paid', status: 'ok' })).toBe('Mined on the chain: the vault paid')
    expect(stepName('convert', { key: 'receipt', label: 'Mined: the chain checked the proof', status: 'ok' })).toBe('Mined: the contract checked the proof')
    expect(stepName('provision', { key: 'grant', label: 'Opening grant of test tINR', status: 'ok' })).toBe('The opening grant of test rupees arrives')
  })
})

describe('the mandate drawn as a bound: one row per limit, with what is used, what is left and who enforces it', () => {
  /** The design fixture's mandate (23 Nov): ₹2,500.00 a payment, ₹6,000.00 a day, ₹20,000.00 in all, ₹15.00 used. */
  const mandate: Pick<MandateView, 'fields' | 'usage'> = {
    fields: { vault: '0x1', agent: '0x2', payees: [], maxPerPayment: '250000', maxPerPeriod: '600000', period: '86400', maxTotal: '2000000', validFrom: '1795438703', validUntil: '1798030763', epoch: '0', requireCosign: true, purpose: '0x', salt: '0x' },
    usage: { perPayment: { limit: '250000' }, period: { limit: '600000', spent: '1500', remaining: '598500', periodStart: 0, seconds: 86400, note: 'Fixed window: it restarts at the first payment after the previous window ended (baseline W-13).' }, lifetime: { limit: '2000000', spent: '1500', remaining: '1998500' }, validity: { validFrom: 1795438703, validUntil: 1798030763, active: true, secondsLeft: 2591958 }, vaultDaily: { limit: '1000000', spent: '1500', remaining: '998500', note: '' }, revokedOnChain: false, epochCurrent: true },
  }
  it('the contract\'s four limits, then the co-signer\'s budget', () => {
    const rows = limitRows(mandate, { limit: '1000', used: '506', remaining: '494', kind: 'budget' })
    expect(rows.map((r) => r.id)).toEqual(['payment', 'period', 'lifetime', 'daily', 'budget'])
    expect(rows.map((r) => r.label)).toEqual(['In one payment', 'In any 24 hours', 'In all, until 23 Dec', 'The wallet\'s own daily limit', 'Your authority budget'])
    expect(rows.map((r) => r.by)).toEqual(['contract', 'contract', 'contract', 'contract', 'cosigner'])
    expect(rows.map((r) => [r.limit, r.used, r.left])).toEqual([['250000', null, null], ['600000', '1500', '598500'], ['2000000', '1500', '1998500'], ['1000000', '1500', '998500'], ['1000', '506', '494']])
    expect(rows[1]!.note).toBe('Fixed window: it restarts at the first payment after the previous window ended.')
  })
  it('the release\'s allowance in place of the budget, and no row for it while it is read', () => {
    expect(limitRows(mandate, { limit: '1000', used: '0', remaining: '1000', kind: 'allowance' })[4]!.label).toBe('The co-signer\'s allowance')
    expect(limitRows(mandate, null).map((r) => r.id)).toEqual(['payment', 'period', 'lifetime', 'daily'])
  })
  it('the binding check names its row', () => {
    expect(ROW_OF[bindingLimit(payment, '494')!.id]).toBe('budget')
    expect(ROW_OF[bindingLimit(contract, '250000')!.id]).toBe('payment')
  })
  it('the share used, exactly in integers, never past the limit', () => {
    expect(share('1500', '600000')).toBe(0.0025)
    expect(share('506', '1000')).toBe(0.506)
    expect(share('700', '600')).toBe(1)
    expect(share(null, '600')).toBe(0)
    expect(share('1', '0')).toBe(1)
  })
})

describe('setting the wallet up is three steps, each saying what it does for the owner', () => {
  it('create, accept, say what QED may do; the step the owner is at is now', () => {
    const steps = setupSteps(1, false, 1)
    expect(steps.map((s) => s.title)).toEqual(['Create it, owned by your passkey', 'Accept it', 'Say what QED may do'])
    expect(steps.map((s) => s.state)).toEqual(['done', 'now', 'next'])
    expect(steps[1]!.does).toBe('One signature from your passkey takes ownership. Then the opening grant of test rupees arrives; until then it can only be read.')
    expect(steps[2]!.does).toBe('Sign a mandate: the most in one payment, in a day and in all, and until when. Until you do, QED can pay no one from it.')
    expect(setupSteps(3, false, 1).every((s) => s.state === 'done')).toBe(true)
  })
  it('a shared wallet names its members and how many must sign', () => {
    const steps = setupSteps(0, true, 2)
    expect(steps[0]!.title).toBe('Create it, owned by your members')
    expect(steps[0]!.does).toBe('QED puts a wallet on a test chain on this QED installation and makes your members\' passkeys its owners: 2 different members must sign for anything it does as owner.')
    expect(steps[1]!.does).toBe('The passkeys of 2 different members take ownership. Then the opening grant of test rupees arrives; until then it can only be read.')
  })
})

describe('who enforces each rule, told apart (Meridian; the owner\'s R11 criterion: what the contract refuses, what QED checks, what is only observed)', () => {
  it('the mandate\'s validity and limits, the wallet\'s daily window and its pause are the contract\'s; the authority budget and the release\'s allowance are QED\'s co-signer\'s', () => {
    for (const id of ['mandate-valid', 'per-conversion', 'mandate-period', 'mandate-lifetime', 'vault-daily', 'not-paused']) expect(checkBy(id)).toBe('contract')
    for (const id of ['authority-budget', 'earned-autonomy']) expect(checkBy(id)).toBe('qed')
  })
  it('a check that is not one party\'s rule alone carries no mark: the input, the free balance less the co-signer\'s buffer, provisioning', () => {
    for (const id of ['amount', 'free-buffer', 'provisioned', 'something-new']) expect(checkBy(id)).toBeNull()
  })
  it('a refusal with nothing sent was QED\'s, a revert on the chain the contract\'s, anything else neither', () => {
    expect(refusedBy({ outcome: 'refused' })).toBe('qed')
    expect(refusedBy({ outcome: 'reverted', tx: { status: 'reverted' } })).toBe('contract')
    expect(refusedBy({ outcome: 'executed', tx: { status: 'success' } })).toBeNull()
    expect(refusedBy({ outcome: 'no-action' })).toBeNull()
    expect(refusedBy(null)).toBeNull()
  })
  it('a recovery key is a signer of the owner account but never one of its owners, so it is never counted as a passkey that owns the wallet', () => {
    const s = splitSigners([{ role: 'member', id: 'a' }, { role: 'recovery', id: 'r' }, { role: 'member', id: 'b' }])
    expect(s.members.map((x) => x.id)).toEqual(['a', 'b'])
    expect(s.keys.map((x) => x.id)).toEqual(['r'])
    // with one passkey and a recovery key, the wallet is owned by one passkey, as the owners' line says
    expect(text(ownersLine({ shared: false, signers: splitSigners([{ role: 'member' }, { role: 'recovery' }]).members.length, threshold: 1 }).parts)).toBe('Your passkey owns it: nothing is done as its owner without your signature.')
  })
})

describe('the chain, in words (R12 task comparison, T10)', () => {
  it('names the chain with its id when the terms carry it, and says a payment out cannot be undone', () => {
    expect(whereWords({ chainId: 31337 })).toBe('On a local test chain on this QED installation (chain id 31337): the tokens have no value.')
    expect(whereWords({})).toBe('On a local test chain on this QED installation: the tokens have no value.')
    expect(FINAL_WORDS).toMatch(/On a real chain, once it is mined a payment cannot be reversed, by QED or by you/)
    expect(FINAL_WORDS).toMatch(/whose key is held on this QED installation/)
    expect(chainLine('Local Anvil chain 31337, valueless test tokens')).toBe('On a local test chain on this QED installation (chain id 31337); the tokens have no value.')
    expect(chainLine(undefined)).toBe('On a local test chain on this QED installation; the tokens have no value.')
  })
  it('writes test tokens in words in a record headline, so it never reads as real money', () => {
    expect(tokensInWords('Paid ₹3.00 to CloudCo')).toBe('Paid 3.00 test rupees to CloudCo')
    expect(tokensInWords('Converted ₹1,00,000.00 → $1,191.42')).toBe('Converted 1,00,000.00 test rupees → 1,191.42 test dollars')
    expect(tokensInWords('Paused the wallet')).toBe('Paused the wallet')
  })
  it('gives the receiving address with the chain before it, and checks an address it is given', () => {
    const owner = '0x45cbe43539dF5Fcf5829c8Ff431319Df8E62e8Cc'
    expect(receiveId(31337, owner)).toBe(`eip155:31337:${owner}`)
    expect(sameAddress(owner.toLowerCase(), 31337, owner)).toBe(true)
    expect(sameAddress(` eip155:31337:${owner} `, 31337, owner)).toBe(true)
    expect(sameAddress(`eip155:1:${owner}`, 31337, owner)).toBe(false) // the same address on another chain is another address
    expect(sameAddress(owner.replace(/c$/i, 'd'), 31337, owner)).toBe(false)
  })
})

describe('the sentences that send a person to the wallet (R14)', () => {
  it('none is drawn on a grid: a sentence with its link inside it is a paragraph, or its link and its ending become rows of their own', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const here = join(import.meta.dirname, '..')
    const inline = readFileSync(join(here, 'screens', 'WalletInline.tsx'), 'utf8')
    // `vt-inline` is a grid for the parts' forms; on a <p> it made "Set it up" and ", then use it from here." two more rows
    expect(inline).not.toMatch(/<p className="[^"]*\bvt-inline\b/)
    expect(inline.match(/<p className="vt-wmissing">/g)?.length).toBe(4)
    const css = readFileSync(join(here, 'styles', 'screens', 'vault.css'), 'utf8')
    expect(css).toMatch(/\.vt-wmissing \{ display: block;/)
  })
})
