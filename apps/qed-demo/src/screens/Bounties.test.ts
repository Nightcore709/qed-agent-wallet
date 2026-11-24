/**
 * The words and arithmetic behind the bounties screen (src/screens/Bounties.tsx; R12 section 6, R10-008, R10-009):
 * each claim's state in the shared status words where they apply (DESIGN.md M12) and in the bounty's own words where
 * none does, with what the person can do next; each bounty's phase; every failure with its next step; the claim as
 * the person pastes it; the judge's ruling here compared with the answer recorded on Sepolia; amounts of test dollars
 * moved digit by digit, never through a float. Nothing here asks the server: every input is the API's own shape.
 */
import { describe, expect, it } from 'vitest'
import type { Job } from '../../chain/types.ts'
import { type Claim, claimWords, failureOf, jobWords, type LocalBounty, type Original, parseClaim, phaseWords, sameAsRecorded, say, span, steps, tusd, unavailableWords } from './Bounties.tsx'

// 24 Nov 2026, 09:00:00 UTC = 14:30:00 in India
const NOW = Date.UTC(2026, 10, 24, 9, 0, 0)
const S = NOW / 1000
const RESERVE = '0x57d6D9220000000000000000000000000000aB01'
const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const recipients = { reserve: RESERVE, ownerAccount: OWNER }
const at = (auto = false) => ({ now: NOW, auto, recipients })

const bounty = (over: Partial<LocalBounty> = {}): LocalBounty => ({
  id: '3', key: 'optimality-control', kind: 'optimality', role: 'positive-control', judge: OTHER,
  title: 'Positive control (tests only): the release\'s OptimalityBounty over a verifier that accepts anything',
  phase: 'open', pool: '1000000000', poolText: '1,000.00 tUSD', paid: '0', winner: null, recipient: null, contestEndsAt: null,
  periods: { revealDelaySeconds: 5, revealWindowSeconds: 60, contestSeconds: 8 }, selector: '0x88c7acb3', ...over,
})
const claim = (state: Claim['state'], over: Partial<Claim> = {}): Claim => ({
  claimId: `0x${'ab'.repeat(32)}`, bountyId: '3', key: 'optimality-control', state, claimant: OTHER, recipient: RESERVE, payTo: 'reserve',
  claimHash: `0x${'cd'.repeat(32)}`, claimBytes: 2980, seq: state === 'committing' ? '0' : '1',
  committed: state === 'committing' ? null : { seq: '1', at: S - 10, revealableAt: S + 5, expiresAt: S + 65, tx: `0x${'01'.repeat(32)}` },
  revealed: null, settled: null, contestEndsAt: null, createdAt: new Date(NOW - 11_000).toISOString(), paid: null, paidText: null, ...over,
})

describe('a claim\'s state: the shared status words where they apply, the bounty\'s own words where none does', () => {
  it('in the order a claim moves: Submitted, Pending, ready to reveal, Pending while it leads, Completed when it is paid', () => {
    const w = (c: Claim, b = bounty(), x = at()) => claimWords(c, b, x)
    expect([w(claim('committing')).word, w(claim('committing')).tone]).toEqual(['Submitted', undefined])
    expect([w(claim('committed')).word, w(claim('committed')).stage]).toEqual(['Pending', 'Committed'])
    expect([w(claim('revealable')).word, w(claim('revealable')).tone, w(claim('revealable')).act]).toEqual(['Ready to reveal', 'wait', 'reveal'])
    const leading = claim('leading', { revealed: { tx: `0x${'02'.repeat(32)}`, at: new Date(NOW - 2000).toISOString() }, contestEndsAt: S + 8 })
    expect([w(leading, bounty({ phase: 'contest', winner: OTHER, recipient: RESERVE, contestEndsAt: S + 8 })).word, w(leading, bounty({ phase: 'contest', winner: OTHER, recipient: RESERVE, contestEndsAt: S + 8 })).stage]).toEqual(['Pending', 'Leading'])
    const won = claim('won', { paid: '1000000000', paidText: '1,000.00 tUSD', settled: { tx: `0x${'03'.repeat(32)}`, payout: '1000000000', at: new Date(NOW).toISOString() } })
    expect([w(won).word, w(won).tone, w(won).stage, w(won).say]).toEqual(['Completed', 'ok', 'Won', '1,000.00 tUSD paid to your reserve vault.'])
    expect([w(claim('expired')).word, w(claim('expired')).tone]).toEqual(['Expired', 'plain'])
  })

  it('the states no shared word fits keep the bounty\'s words, and say why the claim is not paid', () => {
    const settled = bounty({ phase: 'settled', winner: OTHER, recipient: OTHER, paid: '1000000000', pool: '0', poolText: '0.00 tUSD' })
    expect([claimWords(claim('overtaken'), bounty({ phase: 'contest' }), at()).word, claimWords(claim('overtaken'), bounty({ phase: 'contest' }), at()).say]).toEqual(['Overtaken', 'An older commitment was revealed during the contest and took over. This claim will not be paid.'])
    expect(claimWords(claim('lost'), settled, at()).word).toBe('Lost')
    expect(claimWords(claim('lost'), settled, at()).say).toMatch(/older commitment won the contest/)
    expect(claimWords(claim('too-late'), settled, at()).word).toBe('Too late')
    expect(claimWords(claim('too-late'), settled, at()).say).toBe('It was never revealed, and it can no longer win: the bounty has been paid.')
    expect(claimWords(claim('too-late'), bounty({ phase: 'contest' }), at()).say).toBe('It was never revealed, and it can no longer win: a commitment older than it leads.')
    // nothing is sent for a claim that cannot win, and the screen says so
    expect(claimWords(claim('too-late'), settled, at()).next).toMatch(/never revealed, so nothing is sent/)
  })

  it('what the person can do next depends on whether this vault service reveals and settles on its own', () => {
    expect(claimWords(claim('committed'), bounty(), at(false)).next).toBe('Reveal it from 14:30:05, before 14:31:05: this vault service does not reveal claims on its own.')
    expect(claimWords(claim('committed'), bounty(), at(true)).next).toBe('Nothing to do: this vault service reveals it on its own from 14:30:05. You may reveal it yourself then.')
    expect(claimWords(claim('revealable'), bounty(), at(false)).next).toBe('Reveal it now. If it is not revealed by 14:31:05, it lapses and cannot be paid.')
    const leading = claim('leading', { revealed: { tx: `0x${'02'.repeat(32)}`, at: new Date(NOW).toISOString() }, contestEndsAt: S + 8 })
    const contest = claimWords(leading, bounty({ phase: 'contest', winner: OTHER, recipient: RESERVE, contestEndsAt: S + 8 }), at())
    expect([contest.act, contest.next]).toEqual([null, 'Wait for the contest to end at 14:30:08; then settle it. Anyone may settle; the board pays only the recorded recipient.'])
    const ready = claimWords(leading, bounty({ phase: 'settleable', winner: OTHER, recipient: RESERVE, contestEndsAt: S - 1 }), at())
    expect([ready.act, ready.next]).toEqual(['settle', 'Settle it now: the board pays 1,000.00 tUSD to your reserve vault. Anyone may settle; the board pays only the recorded recipient.'])
    expect(claimWords(leading, bounty({ phase: 'settleable', winner: OTHER, recipient: RESERVE, contestEndsAt: S - 1 }), at(true)).next).toMatch(/^This vault service settles it on its own in a moment/)
  })

  it('a lapsed commitment says what was lost (nothing) and whether committing again can still be paid', () => {
    const lapsed = claimWords(claim('expired'), bounty(), at())
    expect(lapsed.stage).toBe('Lapsed')
    expect(lapsed.say).toBe('It was not revealed before 14:31:05, so it can no longer be paid. Nothing was paid out and nothing was lost.')
    expect(lapsed.next).toBe('Commit it again: paste the claim into "Make a claim". A new commitment gets a new delay and a new reveal window.')
    expect(claimWords(claim('expired'), bounty({ phase: 'settled', paid: '1000000000', recipient: OTHER }), at()).next).toBe('The bounty is no longer open, so a new commitment could not be paid.')
  })

  it('a claim paid to the owner account says so', () => {
    const won = claim('won', { payTo: 'owner-account', recipient: OWNER, paidText: '1,000.00 tUSD', paid: '1000000000' })
    expect(claimWords(won, bounty({ phase: 'settled' }), at()).say).toBe('1,000.00 tUSD paid to your owner account.')
  })
})

describe('the steps of a claim: commit, reveal after the delay, the contest, settlement', () => {
  it('each step is done, under way, still to come, missed, or no longer reachable', () => {
    const st = (c: Claim, b = bounty()) => steps(c, b, NOW).map((x) => x.state)
    expect(st(claim('committing'))).toEqual(['now', 'next', 'next', 'next'])
    expect(st(claim('committed'))).toEqual(['done', 'next', 'next', 'next'])
    expect(st(claim('revealable'))).toEqual(['done', 'now', 'next', 'next'])
    const leading = claim('leading', { revealed: { tx: `0x${'02'.repeat(32)}`, at: new Date(NOW).toISOString() }, contestEndsAt: S + 8 })
    expect(st(leading, bounty({ phase: 'contest', contestEndsAt: S + 8 }))).toEqual(['done', 'done', 'now', 'next'])
    expect(st(leading, bounty({ phase: 'settleable', contestEndsAt: S - 1 }))).toEqual(['done', 'done', 'done', 'now'])
    expect(st(claim('won', { revealed: { tx: '0x', at: new Date(NOW).toISOString() }, settled: { tx: '0x', payout: '1000000000', at: new Date(NOW).toISOString() } }))).toEqual(['done', 'done', 'done', 'done'])
    expect(st(claim('expired'))).toEqual(['done', 'missed', 'off', 'off'])
    expect(st(claim('overtaken'))).toEqual(['done', 'done', 'missed', 'off'])
    expect(st(claim('too-late'))).toEqual(['done', 'off', 'off', 'off'])
  })

  it('the reveal step names its window, from the delay to the expiry', () => {
    expect(steps(claim('committed'), bounty(), NOW)[1]!.detail).toBe('From 14:30:05 until 14:31:05')
  })
})

describe('a bounty\'s phase on this computer\'s chain', () => {
  it('open, in its contest, ready to settle, paid and closed; whether the recipient is this household', () => {
    expect(phaseWords(bounty(), at())).toEqual({ word: 'Open', tone: 'ok', open: true, say: 'Open for claims: 1,000.00 tUSD in the pool.' })
    const contest = phaseWords(bounty({ phase: 'contest', winner: OTHER, recipient: OTHER, contestEndsAt: S + 8 }), at())
    expect([contest.word, contest.open, contest.say]).toEqual(['Contest', false, 'A valid claim was revealed. Its claimant leads until 14:30:08 unless an older commitment is revealed before then; no new commitment is accepted.'])
    expect(phaseWords(bounty({ phase: 'settleable', winner: OTHER, recipient: RESERVE }), at()).say).toBe('The contest is over. Anyone may settle it; the board pays only the leading claimant\'s recipient, which is your reserve vault.')
    const closed = phaseWords(bounty({ phase: 'settled', winner: OTHER, recipient: OTHER, paid: '1000000000', pool: '0', poolText: '0.00 tUSD' }), at())
    expect([closed.word, closed.tone, closed.open, closed.say]).toEqual(['Paid and closed', 'plain', false, 'It paid 1,000.00 tUSD to another claimant\'s recipient (0x2222…2222) and takes no more claims.'])
  })
})

describe('every failure says what happened and what the person can do next', () => {
  const e = (status: number, code: string, message = 'm') => failureOf({ status, code, message })
  it('a claim the judge rejects: refused before anything was sent', () => {
    const f = e(422, 'claim_rejected', 'The judge rejects this claim, so it cannot be paid: The theorem holds for this claim.')
    expect(f.title).toBe('Refused by QED\'s checks: the judge rejects this claim')
    expect(f.say).toBe('The judge rejects this claim, so it cannot be paid: The theorem holds for this claim.')
    expect(f.next).toBe('Nothing was recorded or sent. A claim the judge rejects can never be paid: check a different claim.')
  })
  it('a bounty not open: a copy of a revealed claim, or a closed bounty, earns nothing', () => {
    const f = e(409, 'bounty_not_open', 'A valid claim has already been revealed for this bounty; a commitment recorded now would be younger than it and could not win.')
    expect(f.title).toBe('Refused by QED\'s checks: this bounty is not open')
    expect(f.next).toBe('Nothing was recorded or sent, and this claim earns nothing: only the commitment made first is paid. Choose a bounty that is open.')
  })
  it('no wallet yet, a vault the service no longer knows, a role that may not claim', () => {
    expect(e(409, 'vault_not_set_up').to).toEqual({ href: '/vault', label: 'Set up your on-chain wallet' })
    expect(e(404, 'unknown_workspace').to).toEqual({ href: '/vault', label: 'Set up your on-chain wallet again' })
    expect(e(403, 'not_permitted').next).toBe('Ask the workspace\'s owner or an operator to claim it.')
  })
  it('the wallet service not answering: nothing was sent; the answer lost: the same request again, never twice', () => {
    const off = e(503, 'rail_off', 'The on-chain vault service is not running on this computer.')
    expect([off.title, off.next]).toEqual(['The wallet service is not answering', 'Nothing was sent. Start the vault service, then try again.'])
    expect(e(503, 'rail_starting').title).toBe('The wallet service is starting')
    const lost = e(504, 'rail_outcome_unknown')
    expect(lost.title).toBe('The answer was lost: the outcome is not known yet')
    expect(lost.next).toBe('Press the same button again: it repeats this request under the same key, so it cannot happen twice.')
    expect(e(0, 'unreachable').next).toBe('Check that QED is running, then press the same button again: it repeats this request under the same key, so it cannot happen twice.')
  })
  it('a claim in a shape the judge does not take, and anything else: the service\'s own words', () => {
    expect(e(422, 'invalid_claim', 'calldata must be 0x-prefixed hex of whole bytes, alone.').next).toBe('Correct it and check it again. Nothing was sent.')
    expect(e(409, 'too_many_claims', 'This workspace holds 64 claims already.').say).toBe('This workspace holds 64 claims already.')
    expect(e(500, 'something_new', 'Something new went wrong.')).toMatchObject({ title: 'It could not be done', say: 'Something new went wrong.' })
  })
})

describe('the wallet service\'s part of the page, when it cannot answer for this household', () => {
  it('no vault yet: set it up; not running or starting: the statements and the record do not depend on it', () => {
    expect(unavailableWords({ code: 'vault_not_set_up', reason: 'This household has no on-chain vault yet.' })).toMatchObject({ title: 'Set up your on-chain wallet to claim', to: { href: '/vault', label: 'Set up your on-chain wallet' }, retry: false })
    // the next step is an action and what still stands, never the reason again
    expect(unavailableWords({ code: 'vault_not_set_up', reason: 'This household has no on-chain vault yet.' }).next).toBe('Set it up, then come back here to make a claim. The bounties\' statements and the Sepolia record on this page do not depend on it.')
    const off = unavailableWords({ code: 'rail_off', reason: 'The on-chain vault service is not running on this computer.' })
    expect([off.title, off.retry]).toEqual(['The wallet service is not answering', true])
    expect(off.next).toBe('The bounties\' statements and the Sepolia record on this page do not depend on it. Your claims are kept by the service and its chain; a claim must still be revealed before it lapses, so start the service again before then.')
    expect(unavailableWords({ code: 'bounties_off', reason: null }).title).toBe('The bounty board is turned off on this vault service')
    expect(unavailableWords({ code: 'unknown_workspace', reason: 'Unknown workspace.' }).to?.href).toBe('/vault')
  })
})

describe('the claim as the person pastes it', () => {
  it('a JSON object, or the judge\'s calldata alone', () => {
    expect(parseClaim('{ "calldata": "0x88c7acb3" }')).toEqual({ claim: { calldata: '0x88c7acb3' } })
    expect(parseClaim('  0x88C7ACB3\n')).toEqual({ claim: { calldata: '0x88c7acb3' } })
    expect(parseClaim('{"economy":{"members":"5"},"certified":{},"larger":[]}')).toEqual({ claim: { economy: { members: '5' }, certified: {}, larger: [] } })
  })
  it('anything else is refused here, with what a claim is', () => {
    expect(parseClaim('   ')).toEqual({ error: 'Paste the claim: { "calldata": "0x…" } or the fields of the judge\'s claim.' })
    expect(parseClaim('{ calldata: 0x12 }')).toEqual({ error: 'This is not valid JSON. A claim is { "calldata": "0x…" } or the fields of the judge\'s claim, every integer a decimal string.' })
    expect(parseClaim('[1, 2]')).toEqual({ error: 'A claim is one JSON object: { "calldata": "0x…" } or the fields of the judge\'s claim.' })
    expect(parseClaim('0x123')).toEqual({ error: 'Calldata is 0x and whole bytes of hexadecimal: this has an odd number of digits.' })
    expect(parseClaim(`{"calldata":"0x${'00'.repeat(40_000)}"}`)).toEqual({ error: 'This claim is larger than one request to this wallet may be (60,000 characters). Its fields are shorter than its calldata: send the fields.' })
  })
})

describe('what this build reproduces locally, beside what was recorded on Sepolia', () => {
  const tx = (step: string, name: string, args: string[]) => ({ step, title: step, by: 'Deployer', from: OTHER, hash: `0x${'aa'.repeat(32)}`, block: '11951210', at: '2026-10-19T22:44:24Z', status: 'reverted', gasUsed: '1', error: { name, args } })
  const originals = [
    { key: 'optimality', attempts: [tx('BA1', 'TheoremHolds', ['-1', '2'])] },
    { key: 'maximality', attempts: [tx('BM1', 'TheoremHolds', ['169000000', '162000000']), tx('BM2', 'NetPositionChanged', ['0', '1000000'])] },
  ] as unknown as Original[]
  const check = (name: string, args: string[]) => ({ bountyId: '2', key: 'maximality', role: 'original', valid: false, claimHash: '0x', claimBytes: 1, error: { name, args, words: 'w' }, words: 'w' })
  it('the judge here gives exactly the answer recorded for a claim on Sepolia: the recorded step is named', () => {
    expect(sameAsRecorded(check('TheoremHolds', ['169000000', '162000000']), bounty({ id: '2', key: 'maximality', kind: 'maximality', role: 'original' }), originals)?.step).toBe('BM1')
  })
  it('different figures, an accepted claim or a positive control are not the recorded answer', () => {
    expect(sameAsRecorded(check('TheoremHolds', ['169000000', '162000001']), bounty({ id: '2', key: 'maximality', kind: 'maximality', role: 'original' }), originals)).toBeNull()
    expect(sameAsRecorded({ ...check('x', []), valid: true }, bounty({ id: '2', key: 'maximality', kind: 'maximality', role: 'original' }), originals)).toBeNull()
    expect(sameAsRecorded(check('TheoremHolds', ['169000000', '162000000']), bounty({ id: '4', key: 'maximality-control', kind: 'maximality', role: 'positive-control' }), originals)).toBeNull()
  })
})

describe('a step of the vault service, followed until it finishes', () => {
  const job = (over: Partial<Job>): Job => ({ id: 'j', kind: 'bounty-reveal', status: 'running', createdAt: '', startedAt: null, finishedAt: null, proposalId: null, steps: [], result: null, error: null, network: 'local', ...over })
  it('running, completed, refused before anything was sent, no action, failed, interrupted', () => {
    expect(jobWords(job({ status: 'accepted' }))).toMatchObject({ finished: false, word: 'Submitted' })
    expect(jobWords(job({ status: 'running' }))).toMatchObject({ finished: false, word: 'Pending' })
    expect(jobWords(job({ status: 'done', result: { outcome: 'executed', summary: 'Revealed claim 0xaa788116… on bounty 3.' } }))).toEqual({ finished: true, word: 'Completed', tone: 'ok', say: 'Revealed claim 0xaa788116… on bounty 3.' })
    const refused = jobWords(job({ status: 'done', result: { outcome: 'refused', summary: 'The reveal of claim 0xaa788116… was refused before sending: This commitment may be revealed from 2026-11-24T09:00:05.000Z.' } }))
    expect([refused.word, refused.tone, refused.say]).toEqual(['Refused by QED\'s checks; nothing sent', 'void', 'The reveal of claim 0xaa788116… was refused before sending: This commitment may be revealed from 24 Nov, 14:30:05 IST.'])
    expect(jobWords(job({ status: 'done', result: { outcome: 'no-action', summary: 'Already revealed; nothing was sent.' } })).word).toBe('No action needed')
    expect(jobWords(job({ status: 'failed', error: 'The chain refused the transaction.' }))).toMatchObject({ finished: true, word: 'Failed', tone: 'void', say: 'The chain refused the transaction.' })
    expect(jobWords(job({ status: 'interrupted', guidance: 'Resolved from the chain when the service restarts.' }))).toMatchObject({ finished: true, word: 'Needs attention', say: 'The vault service stopped while this ran. Resolved from the chain when the service restarts.' })
  })
})

describe('the service\'s words and figures, as a person reads them', () => {
  it('times in India time, addresses and hashes shortened; nothing else changed', () => {
    expect(say('It may be revealed from 2026-11-24T09:00:05.000Z until 2026-11-25T09:00:05.000Z; by 0xDB9892D5a1b2c3d4e5f60718293a4b5c6d7e8f90.')).toBe('It may be revealed from 24 Nov, 14:30:05 IST until 25 Nov, 14:30:05 IST; by 0xDB98…8f90.')
    expect(say(`Claim 0x${'ab'.repeat(32)} on bounty 3.`)).toBe('Claim 0xabab…abab on bounty 3.')
  })
  it('test dollars moved digit by digit: six decimals, at least two shown, never through a float', () => {
    expect(tusd('1000000000')).toBe('1,000.00 tUSD')
    expect(tusd('1500000')).toBe('1.50 tUSD')
    expect(tusd('1')).toBe('0.000001 tUSD')
    expect(tusd('123456789012345678901234567890')).toBe('123,456,789,012,345,678,901,234.56789 tUSD')
    expect(tusd('0')).toBe('0.00 tUSD')
  })
  it('periods in words', () => {
    expect([span(1), span(5), span(60), span(300), span(3600), span(86_400), span(172_800)]).toEqual(['1 second', '5 seconds', '1 minute', '5 minutes', '1 hour', '1 day', '2 days'])
  })
})
