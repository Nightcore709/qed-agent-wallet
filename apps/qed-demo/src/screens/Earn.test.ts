/**
 * The arithmetic behind the Earn screen (design "Meridian"): where each milestone's money sits on its job's route, where
 * it waits and on whom, what is held split by whose move it waits on, who acts next, and a kind of work's escrow by
 * part. Nothing here makes a figure of its own: every amount is a milestone's recorded amount, carried to one place, so
 * the parts add up to the paisa to what the jobs are worth.
 */
import { describe, expect, it } from 'vitest'
import { stateWord } from '../ui/kit.tsx'
import { stepIsTheirs, waitingWords } from '../ui/earn-chain.tsx'
import { splitOf, termsLines, type TermsDoc } from '../ui/earn-terms.tsx'
import { type Cast, chainPlace, deadlineWords, deciderWords, disputeDefaults, lineOf, lineWords, type Milestone, moveStatusWord, moveTone, nextMoves, offerWords, paperDefault, paperItems, paperPlace, paperThen, paperWhen, partWords, type PaperNext, partsOf, releasedHow, settledWords, STATIONS, standingOf, stepOf, stepWords, termsSummary, trackOf, whose, whoseMoveWords } from './Earn.tsx'

const DAY = 86_400_000
const paper = (state: string, amount: number, evidence_hash: string | null = null) => ({ amount, place: paperPlace({ state, evidence_hash }) })
const chain = (state: string, amount: number, actions: string[] = [], pending: { status: string; yours: boolean } | null = null) => ({ amount, place: chainPlace({ state, actions, pending }) })

describe('Earn: the step each milestone\'s money has reached on its job\'s line', () => {
  it('paper: in escrow when opened, delivered when submitted, at the decision when disputed, paid when released; gone back when refunded', () => {
    expect(stepOf(paperPlace({ state: 'funded', evidence_hash: null }))).toBe(1)
    expect(stepOf(paperPlace({ state: 'submitted', evidence_hash: 'h' }))).toBe(2)
    expect(stepOf(paperPlace({ state: 'disputed', evidence_hash: 'h' }))).toBe(3)
    expect(stepOf(paperPlace({ state: 'released', evidence_hash: 'h' }))).toBe(4)
    expect(stepOf(paperPlace({ state: 'refunded', evidence_hash: 'h' }))).toBeNull()
  })

  it('chain: before the offer as a draft, at the offer when offered or lapsed, in escrow when funded, paid when verified; gone back when refunded', () => {
    expect(stepOf(chainPlace({ state: 'chain-draft', actions: ['quote'], pending: null }))).toBe(-1)
    expect(stepOf(chainPlace({ state: 'chain-offered', actions: [], pending: null }))).toBe(0)
    expect(stepOf(chainPlace({ state: 'chain-expired', actions: ['quote'], pending: null }))).toBe(0)
    expect(stepOf(chainPlace({ state: 'chain-funded', actions: ['deliver', 'release'], pending: null }))).toBe(1)
    expect(stepOf(chainPlace({ state: 'chain-released', actions: [], pending: null }))).toBe(4)
    expect(stepOf(chainPlace({ state: 'chain-refunded', actions: [], pending: null }))).toBeNull()
  })
})

describe('Earn: a job\'s line puts each milestone\'s money at one step, and the steps add up to the job', () => {
  it('a paper job with a milestone in each state', () => {
    const items = [paper('released', 1_500_000, 'h'), paper('disputed', 2_500_000, 'h'), paper('refunded', 2_000_000), paper('funded', 800_000)]
    const l = lineOf('paper', items)
    expect(l.at.map((x) => x.amount)).toEqual([0, 800_000, 0, 2_500_000, 1_500_000])
    expect(l.at.map((x) => x.amount).reduce((a, b) => a + b, 0) + l.back).toBe(6_800_000)
    expect(l.back).toBe(2_000_000)
    expect(l.far).toBe(4)
    // amber where the move is yours, red where it is disputed, green where it was paid
    expect(l.at.map((x) => (x.amount ? x.tone : ''))).toEqual(['', 'you', '', 'void', 'ok'])
    expect(lineWords('provider', l)).toBe('₹8,000.00 in escrow, ₹25,000.00 disputed, ₹15,000.00 paid to you and ₹20,000.00 back to the client.')
  })

  it('a paper job just opened has passed the offer and the escrow, with all its money in escrow', () => {
    const l = lineOf('paper', [paper('funded', 1_200_000), paper('submitted', 1_800_000, 'h')])
    expect(l.far).toBe(2)
    expect(l.at.map((x) => x.amount)).toEqual([0, 1_200_000, 1_800_000, 0, 0])
    expect(lineWords('provider', l)).toBe('₹12,000.00 in escrow and ₹18,000.00 delivered, waiting for the client.')
  })

  it('a job on the chain: a draft waits before the offer, a lapsed offer keeps the colour of whose move it is, and the client reads it from its side', () => {
    const items = [chain('chain-released', 25_075), chain('chain-refunded', 4_000), chain('chain-funded', 12_000, ['deliver', 'release']), chain('chain-draft', 9_000, ['quote'])]
    const l = lineOf('chain', items)
    expect(l.at.map((x) => x.amount)).toEqual([9_000, 12_000, 0, 0, 25_075])
    expect(l.at[0]).toMatchObject({ early: true, tone: 'you' })
    expect(l.back).toBe(4_000)
    expect(lineWords('provider', l)).toBe('₹90.00 not offered yet, ₹120.00 in escrow, ₹250.75 paid to you and ₹40.00 back to the client.')
    const lapsed = lineOf('chain', [chain('chain-expired', 5_000, ['quote'])])
    expect(lapsed.at[0]).toMatchObject({ amount: 5_000, lapsed: true, tone: 'you' })
    expect(lineWords('provider', lapsed)).toBe('₹50.00 offered; the offer lapsed.')
    const theirs = lineOf('chain', [chain('chain-released', 25_075), chain('chain-refunded', 4_000), chain('chain-funded', 12_000)])
    expect(lineWords('client', theirs)).toBe('₹120.00 in escrow, ₹250.75 paid to them and ₹40.00 back to you.')
    expect(theirs.at[1]!.tone).toBe('them')
  })

  it('a job with nothing on it says so', () => {
    expect(lineWords('provider', lineOf('chain', []))).toBe('Nothing on this job yet.')
  })
})

describe('Earn: a kind of work\'s escrow, by part, adds up to the paisa', () => {
  it('paid, held, gone back and not funded yet are each milestone\'s own amount, once', () => {
    const items = [chain('chain-released', 25_075), chain('chain-refunded', 4_000), chain('chain-funded', 12_000), chain('chain-offered', 5_000), chain('chain-draft', 9_000, ['quote'])]
    const p = partsOf(items)
    expect(p).toEqual({ paid: 25_075, held: 12_000, back: 4_000, open: 14_000 })
    expect(p.paid + p.held + p.back + p.open).toBe(items.reduce((t, x) => t + x.amount, 0))
  })

  it('on paper, a submitted or disputed milestone is still held: nothing is the owner\'s until it is released', () => {
    expect(partsOf([paper('funded', 800_000), paper('submitted', 1_800_000, 'h'), paper('disputed', 2_500_000, 'h')])).toEqual({ paid: 0, held: 5_100_000, back: 0, open: 0 })
    expect(partsOf([paper('released', 1_500_000, 'h'), paper('refunded', 2_000_000)])).toEqual({ paid: 1_500_000, held: 0, back: 2_000_000, open: 0 })
  })
})

describe('Earn: each milestone on its route, where it waits and in whose colour', () => {
  const p = (state: string, evidence_hash: string | null = null) => trackOf(paperPlace({ state, evidence_hash }))
  const c = (state: string, actions: string[] = [], pending: { status: string; yours: boolean } | null = null) => trackOf(chainPlace({ state, actions, pending }))

  it('paper: in escrow it waits for your work; submitted, for the client; disputed, at the decision in red; paid at the end; returned from where it stood', () => {
    expect(p('funded')).toEqual({ reach: 1, next: 2, tone: 'you', end: null, early: false, lapsed: false })
    expect(p('submitted', 'h')).toEqual({ reach: 2, next: 3, tone: 'them', end: null, early: false, lapsed: false })
    expect(p('disputed', 'h')).toEqual({ reach: 2, next: 3, tone: 'void', end: null, early: false, lapsed: false })
    expect(p('released', 'h')).toEqual({ reach: 4, next: null, tone: 'none', end: 'paid', early: false, lapsed: false })
    expect(p('refunded', 'h')).toMatchObject({ reach: 2, next: null, end: 'back' })
    expect(p('refunded')).toMatchObject({ reach: 1, next: null, end: 'back' })
  })

  it('chain: a draft waits before the offer, a lapsed offer at the offer again, an offer for the funding, funded money for the work, from each side', () => {
    expect(c('chain-draft', ['quote'])).toEqual({ reach: -1, next: 0, tone: 'you', end: null, early: true, lapsed: false })
    expect(c('chain-expired', ['quote'])).toEqual({ reach: -1, next: 0, tone: 'you', end: null, early: false, lapsed: true })
    expect(c('chain-offered')).toMatchObject({ reach: 0, next: 1, tone: 'them' })
    expect(c('chain-offered', ['fund'])).toMatchObject({ reach: 0, next: 1, tone: 'you' })
    expect(c('chain-funded', ['deliver', 'release'])).toMatchObject({ reach: 1, next: 2, tone: 'you' })
    expect(c('chain-funded')).toMatchObject({ reach: 1, next: 2, tone: 'them' })
    expect(c('chain-funded', [], { status: 'sending', yours: true })).toMatchObject({ reach: 1, next: 2, tone: 'them' })
    expect(c('chain-released')).toMatchObject({ reach: 4, next: null, end: 'paid' })
    expect(c('chain-refunded')).toMatchObject({ reach: 1, next: null, end: 'back' })
  })

  it('the route has five stations on each kind of work, and none is named as a stamp is (the browser journeys count the stamps)', () => {
    expect(STATIONS.paper).toEqual(['Offer', 'Escrow', 'Work', 'Decision', 'Settled'])
    expect(STATIONS.chain).toEqual(['Offer', 'Escrow', 'Work', 'Check', 'Settled'])
    const stamps = ['Not offered yet', 'Offered', 'Offer lapsed', 'In escrow', 'Paid, verified', 'Refunded', 'Work submitted', 'Released to you', 'Disputed', 'Refunded to the client']
    for (const n of [...STATIONS.paper, ...STATIONS.chain]) expect(stamps).not.toContain(n)
  })
})

describe('Earn: what is held, split by whose move it waits on, adds up to what partsOf holds', () => {
  it('yours, the client\'s and disputed are each milestone\'s own amount, once; paid and back are the same figures as partsOf\'s', () => {
    const items = [paper('funded', 1_200_000), paper('submitted', 1_800_000, 'h'), paper('disputed', 2_200_000, 'h'), paper('released', 800_000, 'h'), paper('released', 650_000, 'h'), paper('refunded', 600_000)]
    const s = standingOf(items)
    expect(s).toEqual({ paid: 1_450_000, you: 1_200_000, them: 1_800_000, disputed: 2_200_000, back: 600_000, open: 0, youN: 1, themN: 1, disputedN: 1 })
    const parts = partsOf(items)
    expect(s.you + s.them + s.disputed).toBe(parts.held)
    expect([s.paid, s.back, s.open]).toEqual([parts.paid, parts.back, parts.open])
    expect(s.paid + s.you + s.them + s.disputed + s.back + s.open).toBe(items.reduce((t, x) => t + x.amount, 0))
  })

  it('on the chain an offer not funded yet is open, never held', () => {
    expect(standingOf([chain('chain-offered', 5_000), chain('chain-draft', 9_000, ['quote']), chain('chain-funded', 4_000, ['deliver', 'release'])])).toMatchObject({ open: 14_000, you: 4_000, them: 0, youN: 1 })
  })
})

describe('Earn: who acts next, one sequence: every move the owner makes, in any part, the soonest deadline first, then the others\'', () => {
  // as GET /api/earn gives them (server/escrow.ts nextOf): who acts next, the step, its deadline, and what its terms then do
  const NEXT: Record<string, PaperNext | null> = {
    funded: { actor: 'earner', step: 'submit', by: null, then: { kind: 'stays' } },
    submitted: { actor: 'client', step: 'review', by: Date.parse('2026-11-27T03:06:00.000Z'), then: { kind: 'release', toEarner: 1_800_000, toClient: 0 } },
    disputed: { actor: 'earner', step: 'answer-dispute', by: Date.parse('2026-11-25T09:00:00.000Z'), then: { kind: 'refund', toEarner: 0, toClient: 2_200_000 } },
    released: null, refunded: null,
  }
  const ms = (id: string, state: string, amount: number) => ({ id, title: id, amount, state, evidence_hash: state === 'funded' ? null : 'h', updated_at: 0, next: NEXT[state] ?? null })
  const paperJobs = [{ id: 'j1', title: 'Accounts', client: 'Lakeview Studio', state: 'open', created_at: 0, milestones: [ms('books', 'submitted', 1_800_000), ms('filing', 'funded', 1_200_000), ms('audit', 'released', 800_000)] }]
  const cm = (id: string, state: string, actions: string[], extra: Record<string, unknown> = {}) => ({ id, title: id, amount: 4_000, state, status: '', since: 0, deliverWithinHours: 24, deliverBy: '2026-11-26T03:06:00.000Z', offerValidUntil: '2026-11-25T03:06:00.000Z', escrowJobId: null, quoteHash: null, pending: null, last: null, txs: { opened: null, settled: null, refunded: null }, evidence: null, actions, ...extra })
  const waiting = (action: string, yours: boolean, expiresAt: string | null = null) => ({ pending: { action, approvalId: 'a', proposalId: 'p', jobId: null, status: 'awaiting-signature', yours, expiresAt } })
  const chainView = {
    reachable: true,
    asProvider: [{ id: 'c1', title: 'Mix', state: 'open', createdAt: 0, problem: { kind: 'helix' }, client: { name: null, handle: 'rohan' }, milestones: [cm('offered', 'chain-offered', []), cm('deliver', 'chain-funded', ['deliver', 'release']), cm('signing', 'chain-draft', [], waiting('quote', true))] }],
    asClient: [{ id: 'c2', title: 'Helix', state: 'open', createdAt: 0, problem: { kind: 'helix' }, provider: { name: 'Second household', handle: 'second' }, milestones: [cm('fund', 'chain-offered', ['fund']), cm('wait', 'chain-funded', [])] }],
  }

  it('yours first, in any part you play, the soonest open deadline first, then the page; names whose move it is apart from the move; keeps the client\'s name out until they fund (RISK-071)', () => {
    const moves = nextMoves(paperJobs, chainView as never)
    // yours: funding (until 25 Nov), delivery (by 26 Nov), the paper client's review (until 27 Nov), then the two without a deadline in page order
    expect(moves.map((m) => [m.id, m.who])).toEqual([['fund', 'you'], ['deliver', 'you'], ['books', 'client'], ['filing', 'earner'], ['signing', 'you'], ['offered', 'other'], ['wait', 'other']])
    expect(moves.find((m) => m.id === 'offered')).toMatchObject({ name: '@rohan', what: 'Funds it from their wallet', status: 'working', by: { word: 'until', at: '2026-11-25T03:06:00.000Z' } })
    expect(moves.find((m) => m.id === 'wait')).toMatchObject({ name: 'Second household', what: 'Delivers the work', by: { word: 'by', at: '2026-11-26T03:06:00.000Z' } })
    expect(moves.find((m) => m.id === 'deliver')).toMatchObject({ what: 'Deliver the work', status: 'working', by: { word: 'by', at: '2026-11-26T03:06:00.000Z' } })
    expect(moves.find((m) => m.id === 'fund')).toMatchObject({ what: 'Fund it from your wallet', status: 'working', by: { word: 'until', at: '2026-11-25T03:06:00.000Z' } })
    expect(moves.find((m) => m.id === 'books')).toMatchObject({ what: 'Accept the work or dispute it', status: 'submitting', by: { word: 'until', at: '2026-11-27T03:06:00.000Z' }, then: 'If not, it is released to you then' })
    expect(moves.find((m) => m.id === 'filing')).toMatchObject({ what: 'Submit the work', status: 'working', by: null, none: 'Any time: the job has no delivery date', then: 'If not, it stays in escrow, and the client may ask for it back at any time' })
    // paid work has no next move, and chain amounts are said to be test rupees
    expect(moves.some((m) => m.id === 'audit')).toBe(false)
    expect(moves.filter((m) => m.test).map((m) => m.id)).toEqual(['fund', 'deliver', 'signing', 'offered', 'wait'])
  })

  it('a step waiting for the owner\'s own signature: theirs to sign, awaiting approval, and when it lapses by itself, which puts it first', () => {
    const view = { ...chainView, asProvider: [{ ...chainView.asProvider[0]!, milestones: [cm('deliver', 'chain-funded', ['deliver', 'release']), cm('signing', 'chain-draft', [], waiting('quote', true, '2026-11-24T07:40:00.000Z'))] }], asClient: [] }
    const moves = nextMoves([], view as never)
    expect(moves.map((m) => m.id)).toEqual(['signing', 'deliver'])
    expect(moves[0]).toMatchObject({ who: 'you', name: null, what: 'Sign the offer', status: 'awaiting_approval', by: { word: 'lapses', at: '2026-11-24T07:40:00.000Z' } })
  })

  it('a step waiting for the other side\'s signature, and one being recorded on the chain, wait on others', () => {
    const view = { ...chainView, asProvider: [{ ...chainView.asProvider[0]!, milestones: [cm('theirs', 'chain-offered', [], waiting('fund', false)), cm('sending', 'chain-funded', [], { pending: { action: 'deliver', approvalId: 'a', proposalId: 'p', jobId: 'j', status: 'sending', yours: true } })] }], asClient: [] }
    expect(nextMoves([], view as never)).toMatchObject([
      { id: 'theirs', who: 'other', name: '@rohan', what: 'Signs the funding', status: 'awaiting_theirs', by: null },
      { id: 'sending', who: 'other', name: 'The chain', what: 'Records the delivery', status: 'submitting' },
    ])
  })

  it('an offer that lapsed: the provider\'s move is to offer it again; the client waits on the provider; both say when it lapsed', () => {
    const mine = { ...chainView, asProvider: [{ ...chainView.asProvider[0]!, milestones: [cm('lapsed', 'chain-expired', ['quote'])] }], asClient: [] }
    expect(nextMoves([], mine as never)).toEqual([{ id: 'lapsed', who: 'you', name: null, what: 'Offer it again', title: 'lapsed', job: 'Mix', amount: 4_000, test: true, status: 'expired', by: { word: 'lapsed', at: '2026-11-25T03:06:00.000Z' }, then: null }])
    const theirs = { ...chainView, asProvider: [], asClient: [{ ...chainView.asClient[0]!, milestones: [cm('lapsed', 'chain-expired', [])] }] }
    expect(nextMoves([], theirs as never)).toMatchObject([{ id: 'lapsed', who: 'other', name: 'Second household', what: 'Can offer it again', status: 'expired', by: { word: 'lapsed' } }])
    // a lapsed deadline is not an open one: it does not put the step ahead of one that is still running
    const both = { ...chainView, asProvider: [{ ...chainView.asProvider[0]!, milestones: [cm('lapsed', 'chain-expired', ['quote']), cm('deliver', 'chain-funded', ['deliver', 'release'])] }], asClient: [] }
    expect(nextMoves([], both as never).map((m) => m.id)).toEqual(['deliver', 'lapsed'])
  })

  it('while the on-chain wallet\'s service does not answer, nobody\'s move on the chain is known: those come last, as unknown; paid ones have none', () => {
    const down = { ...chainView, reachable: false, asProvider: [{ ...chainView.asProvider[0]!, milestones: [cm('deliver', 'chain-funded', []), cm('paid', 'chain-released', []), cm('signing', 'chain-draft', [], waiting('quote', true))] }], asClient: [] }
    expect(nextMoves(paperJobs, down as never).map((m) => [m.id, m.who])).toEqual([['books', 'client'], ['filing', 'earner'], ['deliver', 'unknown'], ['signing', 'unknown']])
    expect(nextMoves([], down as never)[0]).toMatchObject({ what: 'Not known until the on-chain wallet\'s service answers', status: null, by: null })
  })

  it('a paper dispute names whose answer it waits on, by when and what its terms do without it; then the mediator\'s; finished work leaves nobody a move', () => {
    const disputed = [{ ...paperJobs[0]!, milestones: [ms('doc', 'disputed', 2_200_000)] }]
    expect(nextMoves(disputed, null)).toEqual([{ id: 'doc', who: 'earner', name: null, what: 'Answer the dispute with evidence', title: 'doc', job: 'Accounts', amount: 2_200_000, test: false, status: 'disputed', by: { word: 'by', at: '2026-11-25T09:00:00.000Z' }, then: 'If not, it goes back to the client then' }])
    // the split the terms state, in the exact paise the server worked out: never a half the page works out itself
    const heard = [{ ...paperJobs[0]!, milestones: [{ ...ms('doc', 'disputed', 1_800_001), next: { actor: 'mediator', step: 'decide', by: Date.parse('2026-11-27T09:00:00.000Z'), then: { kind: 'split', toEarner: 540_001, toClient: 1_260_000 } } as PaperNext }] }]
    expect(nextMoves(heard, null)[0]).toMatchObject({ who: 'mediator', what: 'Decide the dispute', status: 'disputed', by: { word: 'by' }, then: 'If not, it is split then: ₹5,400.01 to you, ₹12,600.00 to the client' })
    // a deadline passed before the engine applied it: the escrow's own step, named by the period that ended, waiting on no one
    const due = [{ ...paperJobs[0]!, milestones: [{ ...ms('doc', 'submitted', 100), next: { actor: 'rule', step: 'review-ended', by: Date.parse('2026-11-23T09:00:00.000Z'), then: { kind: 'refund', toEarner: 0, toClient: 100 } } as PaperNext }] }]
    expect(nextMoves(due, null)).toMatchObject([{ who: 'other', name: 'QED\'s paper escrow', what: 'Applies the terms: the client\'s review has ended', by: { word: 'was due' }, then: 'It goes back to the client' }])
    expect(nextMoves([{ ...paperJobs[0]!, milestones: [ms('a', 'released', 1), ms('b', 'refunded', 1)] }], null)).toEqual([])
  })

  it('a milestone from before terms: both sides\' move, with no agreed deadline, and nothing on its own until they agree terms', () => {
    const legacy = [{ ...paperJobs[0]!, milestones: [{ ...ms('old', 'submitted', 1_800_000), legacy: true, next: { actor: 'both', step: 'agree-terms', by: null, then: { kind: 'nothing' } } as PaperNext }] }]
    expect(nextMoves(legacy, null)).toEqual([{ id: 'old', who: 'both', name: null, what: 'Agree terms for it', title: 'old', job: 'Accounts', amount: 1_800_000, test: false, status: 'no_terms', by: null, none: 'No agreed deadline', then: 'If not, nothing happens on its own until both sides agree terms' }])
    // terms proposed by one side: still no deadline until the other accepts them
    const proposed = [{ ...legacy[0]!, milestones: [{ ...legacy[0]!.milestones[0]!, next: { actor: 'both', step: 'accept-terms', by: null, then: { kind: 'nothing' } } as PaperNext }] }]
    expect(nextMoves(proposed, null)[0]).toMatchObject({ what: 'Accept the terms proposed, or propose others', status: 'terms_proposed', none: 'No agreed deadline' })
    // a period that ran out with the terms keeping it locked: both sides' move, no deadline left
    const locked = [{ ...paperJobs[0]!, milestones: [{ ...ms('lk', 'submitted', 100), next: { actor: 'both', step: 'agree-outcome', by: null, then: { kind: 'locked' } } as PaperNext }] }]
    expect(nextMoves(locked, null)[0]).toMatchObject({ who: 'both', what: 'Agree how to settle it', status: 'locked', none: 'No deadline left: the terms keep it locked', then: 'If not, nothing happens on its own: it stays locked in escrow' })
  })

  it('in a business workspace a step is yours only in a part you play; another member\'s is named, from the terms it runs under', () => {
    const roleNames = { earner: 'Esha', client: 'Chitra', mediator: 'Mohan' }
    const terms = { roleNames } as never
    const job = [{ ...paperJobs[0]!, terms, milestones: [{ ...ms('books', 'submitted', 1_800_000), you: ['earner'] as const, terms }, { ...ms('filing', 'funded', 1_200_000), you: ['earner'] as const, terms }] }]
    expect(nextMoves(job as never, null).map((m) => [m.id, m.who, m.name])).toEqual([['filing', 'earner', null], ['books', 'other', 'Chitra']])
  })
})

describe('Earn: a step\'s status is said in the shared words (DESIGN.md M12) wherever they say it', () => {
  it('pending, submitted, awaiting your approval, expired and draft are kit.tsx\'s own words; Earn keeps its own for the rest', () => {
    for (const s of ['working', 'submitting', 'awaiting_approval', 'expired', 'draft'] as const) expect(moveStatusWord(s)).toBe(stateWord(s))
    expect(['working', 'submitting', 'awaiting_approval', 'expired', 'draft'].map((s) => moveStatusWord(s as never))).toEqual(['Pending', 'Submitted', 'Awaiting your approval', 'Expired', 'Draft'])
    expect((['disputed', 'awaiting_theirs', 'refund_asked', 'terms_proposed', 'locked', 'no_terms'] as const).map(moveStatusWord)).toEqual(['Disputed', 'Awaiting their approval', 'Refund asked', 'Terms proposed', 'Locked in escrow', 'No agreed terms'])
  })

  it('a deadline names a near day: today, tomorrow, or the date (India time)', () => {
    const now = Date.parse('2026-11-24T06:00:00.000Z') // 11:30 in India
    expect(deadlineWords({ word: 'lapses', at: '2026-11-24T07:34:00.000Z' }, now)).toBe('Lapses today, 13:04')
    expect(deadlineWords({ word: 'until', at: '2026-11-25T07:24:00.000Z' }, now)).toBe('Until tomorrow, 12:54')
    expect(deadlineWords({ word: 'by', at: '2026-11-27T07:24:00.000Z' }, now)).toBe('By Fri 27 Nov, 12:54')
    expect(deadlineWords({ word: 'lapsed', at: '2026-11-23T08:09:00.000Z' }, now)).toBe('Lapsed yesterday, 13:39')
  })
})

describe('Earn: a milestone on the chain while the on-chain wallet\'s service does not answer', () => {
  const m = { state: 'chain-funded', actions: [] as string[], pending: null }
  it('is nobody\'s move: never drawn or said as the client\'s, in no one\'s colour', () => {
    const p = chainPlace(m, false)
    expect(p).toEqual({ at: 1, end: null, turn: 'unknown' })
    expect(whose(p, 'provider', false)).toBe('Whose move: not known')
    expect(trackOf(p)).toMatchObject({ reach: 1, next: 2, tone: 'none' })
    expect(moveTone(p)).toBe('plain')
    // the same milestone, answered for, is the client's move again
    expect(whose(chainPlace(m), 'provider', false)).toBe('The client\'s move')
  })
  it('a finished milestone stays finished, and the owner\'s own waiting request is not claimed as their move', () => {
    expect(chainPlace({ state: 'chain-released', actions: [], pending: null }, false).turn).toBe('none')
    expect(chainPlace({ state: 'chain-draft', actions: [], pending: { status: 'awaiting-signature', yours: true } }, false).turn).toBe('unknown')
  })
})

describe('Earn: a step waiting for a signature, said plainly with what happens next', () => {
  const base = { approvalId: 'a', proposalId: 'p', jobId: null }
  it('the owner\'s own: nothing moves until their passkey signs it, and when it lapses by itself if it has a time', () => {
    expect(waitingWords({ ...base, action: 'quote', status: 'awaiting-signature', yours: true, expiresAt: '2026-11-24T07:34:00.000Z' }, 'Rohan Mehta')).toBe('You asked to offer it and have not signed yet. Nothing moves until your passkey signs it; if you leave it, the request lapses by itself at 13:04.')
    expect(waitingWords({ ...base, action: 'fund', status: 'awaiting-signature', yours: true }, 'Asha')).toBe('You asked to fund it and have not signed yet. Nothing moves until your passkey signs it; if you leave it, the request lapses by itself.')
  })
  it('the other side\'s: whose signature it waits for, and that nothing moves without it; never when they asked', () => {
    expect(waitingWords({ ...base, action: 'fund', status: 'awaiting-signature', yours: false, expiresAt: null }, 'Rohan Mehta')).toBe('Rohan Mehta has asked to fund it and has not signed yet. Nothing moves until they do.')
    expect(waitingWords({ ...base, jobId: 'j', action: 'deliver', status: 'sending', yours: true }, 'Rohan Mehta')).toBe('Being recorded on the chain: the delivery.')
  })
})

describe('Earn: whose a step on the chain is, from each side, so an unsigned step is named as the owner\'s or the other side\'s', () => {
  it('the client funds; the provider offers, delivers and releases; either refunds', () => {
    expect(['quote', 'fund', 'deliver', 'release', 'refund'].map((a) => stepIsTheirs('provider', a))).toEqual([false, true, false, false, false])
    expect(['quote', 'fund', 'deliver', 'release', 'refund'].map((a) => stepIsTheirs('client', a))).toEqual([true, false, true, true, false])
  })
})

describe('Earn: the paper escrow under terms both sides accepted, as the page reads it (R13 section 2)', () => {
  const base = { id: 'm', title: 'Books closed', amount: 1_800_001, evidence_hash: 'h', updated_at: Date.parse('2026-11-25T06:00:00.000Z') }
  /** Terms as the server stores them (server/escrow.ts Terms), the stated defaults unless given. */
  const terms = (over: Partial<TermsDoc> = {}): TermsDoc => ({
    version: 2, job: { title: 'Accounts', client: 'Lakeview Studio' }, milestones: [{ title: 'Books closed', amount: 1_800_001 }], deliverBy: null,
    review: { ms: 7 * DAY, onTimeout: { kind: 'release' } }, answer: { ms: 3 * DAY, onTimeout: { kind: 'refund' } },
    evidence: { ms: 3 * DAY, onTimeout: { kind: 'raiser' } }, decision: { ms: 5 * DAY, onTimeout: { kind: 'split', earnerPct: 50 } },
    mediator: { simulated: true, may: ['release', 'refund', 'split'] }, roles: { earner: 'u', client: 'u', mediator: 'u' }, rounding: 'client-part-down', ...over,
  })
  const household: Cast = { names: null, you: ['earner', 'client', 'mediator'] }
  const business: Cast = { names: { earner: 'Esha', client: 'Chitra', mediator: 'Mohan' }, you: ['mediator'] }

  it('a refund asked for waits on your answer in escrow; a dispute over a refund waits at the decision without having passed the work; proposed terms are an offer not yet funded', () => {
    expect(paperPlace({ state: 'refund-asked', evidence_hash: null })).toEqual({ at: 1, end: null, turn: 'you' })
    expect(trackOf(paperPlace({ state: 'disputed', evidence_hash: null }))).toMatchObject({ reach: 1, next: 3, tone: 'void' })
    // in a dispute, the move is yours when your answer is the one awaited, the other side's otherwise
    expect(paperPlace({ state: 'disputed', evidence_hash: 'h', next: { actor: 'earner', step: 'answer-dispute', by: 1, then: { kind: 'refund' } } }).turn).toBe('you')
    expect(paperPlace({ state: 'disputed', evidence_hash: 'h', next: { actor: 'mediator', step: 'decide', by: 1, then: { kind: 'split' } } }).turn).toBe('them')
    // both sides' move (terms to agree, or money a timeout left locked) is the household's, which plays each
    expect(paperPlace({ state: 'submitted', evidence_hash: 'h', next: { actor: 'both', step: 'agree-terms', by: null, then: { kind: 'nothing' } } }).turn).toBe('you')
    expect(partsOf([{ amount: 5_000, place: paperPlace({ state: 'proposed', evidence_hash: null }) }])).toEqual({ paid: 0, held: 0, back: 0, open: 5_000 })
  })

  it('a split is two parts, paid and back, that add up to the paisa to the milestone, and one milestone on its job', () => {
    const items = paperItems({ ...base, state: 'split', paid: 1_500_000, back: 300_001 })
    expect(items.map((x) => x.amount)).toEqual([1_500_000, 300_001])
    expect(partsOf(items)).toEqual({ paid: 1_500_000, held: 0, back: 300_001, open: 0 })
    expect(lineWords('provider', lineOf('paper', items))).toBe('₹15,000.00 paid to you and ₹3,000.01 back to the client.')
    expect(paperItems({ ...base, state: 'submitted' })).toEqual([{ amount: 1_800_001, place: { at: 2, end: null, turn: 'them' } }])
  })

  it('a stated split is rounded as the server rounds it: the client\'s part down to the paisa, the earner the rest', () => {
    expect(splitOf(1_800_001, 50)).toEqual({ earner: 900_001, client: 900_000 })
    expect(splitOf(1_800_001, 30)).toEqual({ earner: 540_001, client: 1_260_000 })
    expect(splitOf(1, 50)).toEqual({ earner: 1, client: 0 })
    for (const [amount, pct] of [[1_800_001, 1], [7, 99], [100_000_000_000, 33]] as const) { const p = splitOf(amount, pct); expect(p.earner + p.client).toBe(amount) }
  })

  it('a job\'s terms in one line: the review and what its end does, and the delivery date or none', () => {
    const now = Date.parse('2026-11-18T05:00:00.000Z') // Wed 18 Nov, 10:30 in India
    expect(termsSummary(terms(), now)).toBe('The client reviews submitted work for 7 days; with no answer by then, it is released to you. No delivery date.')
    expect(termsSummary(terms({ review: { ms: DAY, onTimeout: { kind: 'split', earnerPct: 30 } }, deliverBy: Date.parse('2026-11-20T18:29:59.999Z') }), now)).toBe('The client reviews submitted work for 1 day; with no answer by then, it is split, 30% to you: ₹5,400.01 to you and ₹12,600.00 to the client. Deliver by Fri 20 Nov, 23:59.')
    expect(termsSummary(terms({ review: { ms: 8000, onTimeout: { kind: 'locked' } }, test: true }), now)).toBe('The client reviews submitted work for 8 seconds; with no answer by then, it stays locked in escrow until both sides agree. No delivery date.')
  })

  it('the complete terms state every period, when it starts and what its end does; who decides, its powers and its limits; who plays each part; the rounding; and never call a split fair', () => {
    const now = Date.parse('2026-11-18T05:00:00.000Z')
    const rows = termsLines(terms(), now, null)
    expect(rows.map((r) => r.key)).toEqual(['milestones', 'delivery', 'review', 'answer', 'evidence', 'decision', 'mediator', 'roles', 'rounding'])
    const at = (k: string) => rows.find((r) => r.key === k)!.value
    expect(at('review')).toBe('7 days, from each submission of the work. If the client neither accepts nor disputes by then: it is released to you.')
    expect(at('evidence')).toBe('3 days, from the dispute, for each side. If the other side sends no evidence by then: the side that raised the dispute has its way.')
    expect(at('decision')).toBe('5 days, from the dispute. If the mediator has not decided by then: it is split, 50% to you: ₹9,000.01 to you and ₹9,000.00 to the client.')
    expect(at('mediator')).toMatch(/^A simulated mediator, played by you\. .*only as these terms allow, and no other money\. It is not an arbitrator, a court or a regulated dispute service, and its decision binds no one outside this practice build\.$/)
    expect(termsLines(terms(), now, { earner: 'Esha', client: 'Chitra', mediator: 'Mohan' }).find((r) => r.key === 'roles')!.value).toBe('The earner: Esha. The paper client: Chitra. The mediator: Mohan. Each step is taken only by its member.')
    expect(termsLines(terms({ test: true }), now, null).at(-1)!.key).toBe('test')
    for (const r of rows) expect(r.value).not.toMatch(/\bfair\b|independent|arbitrat(ed|ion)\b|court-approved|regulated by/i)
  })

  it('who acts next on a milestone, by when, and what its terms do if nobody acts: each default in words, with its exact paise', () => {
    const now = Date.parse('2026-11-24T06:00:00.000Z')
    const n = (actor: PaperNext['actor'], step: string, then: PaperNext['then'], by: number | null = null): PaperNext => ({ actor, step, by, then })
    expect(paperDefault(n('earner', 'submit', { kind: 'stays' }))).toEqual({ label: 'If not', text: 'It stays in escrow, and the client may ask for it back at any time' })
    expect(paperDefault(n('earner', 'submit-late', { kind: 'client-may-take-now' }, 1))).toEqual({ label: 'Meanwhile', text: 'The client may ask for the money back now; until they do, you can still submit it' })
    expect(paperThen(n('client', 'review', { kind: 'release', toEarner: 9, toClient: 0 }, 1))).toBe('If not, it is released to you then')
    expect(paperThen(n('earner', 'answer-refund', { kind: 'split', toEarner: 540_001, toClient: 1_260_000 }, 1))).toBe('If not, it is split then: ₹5,400.01 to you, ₹12,600.00 to the client')
    expect(paperThen(n('mediator', 'decide', { kind: 'locked' }, 1))).toBe('If not, it stays locked in escrow then, until both sides agree')
    expect(paperDefault(n('rule', 'decision-ended', { kind: 'refund', toEarner: 0, toClient: 9 }, 1))).toEqual({ label: 'Then', text: 'It goes back to the client' })
    expect(paperThen(n('both', 'agree-terms', { kind: 'nothing' }))).toBe('If not, nothing happens on its own until both sides agree terms')
    expect(paperThen(n('client', 'accept-job-terms', { kind: 'not-funded' }))).toBe('If not, nothing is in escrow until the paper client accepts')
    // the deadline, or why there is none
    expect(paperWhen(n('client', 'review', { kind: 'release' }, Date.parse('2026-11-27T03:06:00.000Z')), now)).toBe('Until Fri 27 Nov, 08:36')
    expect(paperWhen(n('both', 'agree-terms', { kind: 'nothing' }), now)).toBe('No agreed deadline')
    expect(paperWhen(n('earner', 'submit', { kind: 'stays' }), now)).toBe('Any time: the job has no delivery date')
    expect(paperWhen(n('both', 'agree-outcome', { kind: 'locked' }), now)).toBe('No deadline left: the terms keep it locked')
  })

  it('each part is named as the household plays it, or as the member a business\'s terms name; whose move says it in words', () => {
    expect(['earner', 'client', 'mediator', 'both', 'rule'].map((p) => partWords(p, household))).toEqual(['You', 'You, as the paper client', 'You, as the simulated mediator', 'Both sides, each played by you', 'QED\'s paper escrow'])
    expect(['earner', 'client', 'mediator', 'both'].map((p) => partWords(p, business))).toEqual(['Esha, as the earner', 'Chitra, as the paper client', 'You, as the simulated mediator', 'Both sides: Esha and Chitra'])
    const next = (actor: PaperNext['actor']): PaperNext => ({ actor, step: 'x', by: null, then: { kind: 'nothing' } })
    expect((['earner', 'client', 'mediator', 'both', 'rule'] as const).map((a) => whoseMoveWords(next(a), household))).toEqual(['Your move', 'The client\'s move, played by you', 'The mediator\'s move, played by you', 'Both sides\' move, each played by you', 'Due now: the escrow applies its terms'])
    expect((['earner', 'client', 'mediator'] as const).map((a) => whoseMoveWords(next(a), business))).toEqual(['Esha\'s move', 'Chitra\'s move', 'Your move, as the mediator'])
    expect(whoseMoveWords(null, household)).toBe('Finished')
  })

  it('every step on record reads as what its part did, with the reason, the evidence and the figures, and never as a code', () => {
    const at = 0
    const w = (step: string, actor: string, detail: Record<string, unknown> = {}) => stepWords({ ts: at, actor, step, detail })
    expect(w('opened', 'client', { amount: 1_800_001, termsHash: 'f'.repeat(64) })).toBe('Accepted the terms and put ₹18,000.01 in escrow')
    expect(w('opened', 'client', { amount: 1_800_001 })).toBe('Put ₹18,000.01 in escrow')
    expect(w('submitted', 'earner', { late: true })).toBe('Submitted the work, after the delivery date')
    expect(w('disputed', 'client', { against: 'work', reason: 'Not reconciled.' })).toBe('Disputed the work: “Not reconciled.”')
    expect(w('disputed', 'client', { against: 'work', noTerms: true })).toBe('Disputed the work. With no agreed terms, no mediator decides it')
    expect(w('disputed', 'earner', { against: 'refund', reason: 'Half done.' })).toBe('Disputed the client taking the money back: “Half done.”')
    expect(w('decided', 'mediator', { outcome: 'split', toEarner: 1_500_000, toClient: 300_001 })).toBe('Decided: ₹15,000.00 to you, ₹3,000.01 to the client')
    expect(w('timed-out', 'rule', { period: 'review', outcome: 'refunded', toEarner: 0, toClient: 1_800_001 })).toBe('Applied the accepted terms when the client\'s review ran out: refunded to the client, ₹18,000.01')
    expect(w('timed-out', 'rule', { period: 'decision', outcome: 'split', toEarner: 900_001, toClient: 900_000 })).toBe('Applied the accepted terms when the mediator\'s deadline passed with no decision: ₹9,000.01 to you, ₹9,000.00 to the client')
    expect(w('locked', 'rule', { period: 'review' })).toBe('Kept it locked in escrow when the client\'s review ran out, as the accepted terms say')
    expect(w('took-back', 'client')).toBe('Took the money back, as the terms it was opened on allowed')
    expect(w('terms-proposed', 'earner')).toBe('Proposed terms for it, accepting them')
    expect(w('terms-agreed', 'client')).toBe('Accepted the terms proposed: they bind it from now')
    expect(w('offered-settlement', 'earner', { outcome: 'split', toEarner: 600_000, toClient: 600_000 })).toBe('Offered to settle: ₹6,000.00 to you, ₹6,000.00 to the client')
    expect(w('settled-by-agreement', 'client', { outcome: 'released', toEarner: 9, toClient: 0 })).toBe('Offered the same as the other side, settling it: released to you, ₹0.09')
    expect(w('some-future-step', 'earner')).toBe('Took a step on it')
  })

  it('a settled milestone says how it ended, in the ledger\'s figures', () => {
    const m = (state: string, steps: { step: string; actor: string; detail?: Record<string, unknown> }[], paid = 0, back = 0): Milestone => ({ ...base, state, paid, back, steps: steps.map((s) => ({ ts: 0, detail: {}, ...s })) })
    const day = '25 Nov'
    expect(settledWords(m('split', [{ step: 'offered-settlement', actor: 'earner' }, { step: 'settled-by-agreement', actor: 'client' }], 900_001, 900_000))).toBe(`Split on ${day}, by agreement between the two sides: ₹9,000.01 paid into your bank account, ₹9,000.00 back to the client.`)
    expect(settledWords(m('refunded', [{ step: 'timed-out', actor: 'rule', detail: { period: 'answer' } }], 0, 1_800_001))).toBe(`Returned to the client on ${day}, by the accepted terms, when the time to answer the request for the money back ran out. Nothing was paid to you.`)
    expect(settledWords(m('released', [{ step: 'accepted', actor: 'client' }], 1_800_001))).toBe(`Paid into your bank account on ${day}, when the client accepted the work, and recorded as earnings.`)
    expect(settledWords(m('refunded', [{ step: 'took-back', actor: 'client' }], 0, 1_800_001))).toBe(`Returned to the client on ${day}, when the client took it back. Nothing was paid to you.`)
  })

  it('a dispute says what its terms do if nobody acts: the evidence period\'s outcome while one side is unheard, then only the decision\'s', () => {
    const raised = Date.parse('2026-11-24T12:13:00.000Z') // Tue 24 Nov, 17:43 in India
    const t = terms()
    expect(disputeDefaults(1_800_001, 'client', t, raised, false, raised)).toBe('If you do not answer by Fri 27 Nov, 17:43, it goes back to the client. With no decision by Sun 29 Nov, 17:43, it is split, 50% to you: ₹9,000.01 to you and ₹9,000.00 to the client.')
    expect(disputeDefaults(1_800_001, 'earner', t, raised, false, raised)).toBe('If the client, played by you, does not answer by Fri 27 Nov, 17:43, it is released to you. With no decision by Sun 29 Nov, 17:43, it is split, 50% to you: ₹9,000.01 to you and ₹9,000.00 to the client.')
    expect(disputeDefaults(1_800_001, 'client', t, raised, true, raised)).toBe('With no decision by Sun 29 Nov, 17:43, it is split, 50% to you: ₹9,000.01 to you and ₹9,000.00 to the client.')
    // the outcomes the terms chose, not the usual ones
    expect(disputeDefaults(1_800_001, 'client', terms({ evidence: { ms: 3 * DAY, onTimeout: { kind: 'locked' } }, decision: { ms: 5 * DAY, onTimeout: { kind: 'release' } } }), raised, false, raised)).toBe('If you do not answer by Fri 27 Nov, 17:43, it stays locked in escrow until both sides agree. With no decision by Sun 29 Nov, 17:43, it is released to you.')
    // in a business, the member who has not answered, by name
    expect(disputeDefaults(1_800_001, 'client', t, raised, false, raised, business)).toMatch(/^If Esha does not answer by Fri 27 Nov, 17:43, it goes back to the client\./)
    // a deadline tomorrow is said as tomorrow, in a sentence
    expect(disputeDefaults(1_800_001, 'client', t, raised, false, Date.parse('2026-11-26T12:13:00.000Z'))).toMatch(/^If you do not answer by tomorrow, 17:43,/)
  })

  it('the decider is named as simulated, with its powers and limits, played by the household or a named member, and never as an arbitrator, a court or a regulated service', () => {
    expect(deciderWords(household)).toBe('A simulated mediator, played by you. Once both sides are heard it may release this milestone to the earner, refund it to the client or split it between the two in whole paise, as the accepted terms allow, and move no other money. It is not an arbitrator, a court or a regulated dispute service, and its decision binds no one outside this practice build.')
    expect(deciderWords(business, ['split'])).toMatch(/^A simulated mediator, played by Mohan\. Once both sides are heard it may split it between the two in whole paise, as the accepted terms allow/)
  })

  it('an offer to settle reads in exact paise', () => {
    expect(offerWords({ outcome: 'split', toEarner: 600_000, toClient: 600_001, at: 0 })).toBe('₹6,000.00 to the earner, ₹6,000.01 to the client')
    expect(offerWords({ outcome: 'refunded', toEarner: 0, toClient: 9, at: 0 })).toBe('all of it back to the client, ₹0.09')
  })

  it('money in says how each release came about: the client, the terms at the end of a period, the mediator, or an agreement', () => {
    expect(releasedHow({ decidedBy: 'client', outcome: 'released' })).toBe('Released from escrow when the client (played by you) accepted the work')
    expect(releasedHow({ decidedBy: 'rule', outcome: 'released', period: 'review' })).toBe('Released from escrow by the job\'s terms at the end of the client\'s review, with no answer')
    expect(releasedHow({ decidedBy: 'rule', outcome: 'released', period: 'evidence', disputeId: 'd', recordedLate: true })).toBe('Released from escrow by the job\'s terms as the dispute was not answered in time, recorded late')
    expect(releasedHow({ decidedBy: 'rule', outcome: 'split', period: 'decision', disputeId: 'd' })).toBe('Your part of a split the job\'s terms set as no decision came in time')
    expect(releasedHow({ decidedBy: 'mediator', outcome: 'split' })).toBe('Your part of the split the simulated mediator, played by you, decided')
    expect(releasedHow({ decidedBy: 'agreement', outcome: 'split' })).toBe('Your part of a settlement both sides agreed')
    // entries from before the terms named their period say what they always said
    expect(releasedHow({ decidedBy: 'rule', outcome: 'released' })).toBe('Released from escrow by its stated rule at the end of the client\'s review, with no answer')
    expect(releasedHow({})).toBe('Released from escrow when the client (played by you) accepted the work')
  })
})
