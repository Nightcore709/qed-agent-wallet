/** Shapes of the API's read models, as the interface uses them. The server is the authority on these. */
import type { Period } from '../../shared/period.ts'
import type { AuthDoc } from '../ui/instrument.tsx'

export interface Fresh { ageMs: number; stale: boolean; usableForExecution: boolean; label: string }
export interface Holding {
  instrumentId: string; name: string; kind: string; asset: string; qty: string; baseScale: number; priceType: string | null; price: string | null
  priceSourceTs: number | null; priceRecvTs: number | null; provider: string | null; fresh: Fresh; value: number | null; cost: number
  limit: number; limitStatus: string; limitNote: string; worst: number | null; held: string
  /** What it was bought at, why it changed and its annual rate (server/performance.ts), sent by /api/home. */
  story?: HoldingStory
}
/** One open purchase: the day its units were allotted or filled, its NAV day (funds), its price, units bought and still held (atoms), and their cost in paise. */
export interface Purchase { at: number; navDate: string | null; price: string; bought: string; held: string; cost: number }
/**
 * Why a holding changed since it was first bought, in paise from the ledger: price movement on the units while held,
 * money added less money taken out, and costs (fees, stamp duty, taxes and rounding) add up exactly to `change`, its value now.
 */
export interface Why { since: number; added: number; takenOut: number; buys: number; sells: number; flows: number; movement: number; costs: number; fees: number; stamp: number; taxes: number; rounding: number; change: number }
/** The money-weighted annual rate (an XIRR on the dated cash flows), or why it is not shown. */
export interface Annual { method: 'xirr'; minDays: number; heldDays: number; rate: number | null; reason: 'young' | 'one-sided' | 'none' | 'several' | 'no-price' | 'unreconciled' | null }
export interface HoldingStory { purchases: Purchase[]; boughtAt: { price: string; purchases: number; first: number; last: number } | null; why: Why | null; annual: Annual }
export interface Commitment { kind: string; label: string; amount: number; dueAt: number; subject?: string; certain: boolean; runMode?: string }
export interface Worst { cash: number; deposits: number; setAside: number; inTransit: number; holdingsValue: number; holdingsWorst: number; card: number; reserves: number; gHat: number; line: number; cushion: number; valid: boolean; invalidReasons: string[]; illustrative: boolean; parts: { label: string; amount: number; note: string }[] }
/** What must stay in the bank for everything due, and why. Worked out by the server; see server/liquidity.ts. */
export interface Liquidity {
  asOf: number; today: string; horizonDays: number; available: number; need: number; free: number; short: number
  binding: { date: string; step: number; debits: number; inflows: number; parts: { kind: string; label: string; amount: number }[]; items: { step: number; date: string; kind: string; label: string; amount: number }[] } | null
  sustainable: boolean
  assumptions: { lateDays: number; lostSalaries: number; spending: number; income: number; incomeDay: number; firstCounted: { due: string; by: string } | null; late: { due: string; count: number; beyondAllowance: number } | null; lostSoFar: number; allowanceLeft: number }
  notCounted: string[]; path: { date: string; low: number }[]
}
export interface AuthorityEnvelope { windows: { days: number; most: number }[]; instructions: { id: string; title: string; kind: string; most: number[] }[] }
export interface Overview { asOf: number; bank: number; bankAvailable: number; bankHeld: number; deposits: number; setAside: number; holdingsValue: number; inTransit: number; paymentsInProgress: number; card: number; loans: number; /** Tax deducted at source: counted in netWorth (R13). */ taxCredit: number; netWorth: number; freeToUse: number; liquidity: Liquidity; worst: Worst; holdings: Holding[]; upcoming: Commitment[] }

export interface Check { name: string; ok: boolean; detail: string }
export interface ActionView {
  id: string; kind: 'order' | 'payment'; origin: 'owner' | 'program' | 'commerce'; venue: string; state: string; runId: string | null; programId: string | null; economicId: string; what: string
  params: Record<string, unknown> & { side?: string; type?: string; instrumentId?: string; amount?: string; qty?: string; payeeHandle?: string; payeeName?: string; purpose?: string; memo?: string; hold?: { until: number; why: string } }
  instrument: { id: string; name: string; kind: string; baseAsset: string; baseScale: number } | null
  decision: { decidedAt?: number; checks?: Check[] }; result: Record<string, unknown>; times: Record<string, number>; reconState: string; receiptId: string | null; approvalId: string | null; error: string | null; createdAt: number; updatedAt: number
  /** Payments only (server/views.ts): the latest dispute, and why a dispute pack can be made for it (server/dispute-pack.ts), if it can */
  dispute?: Dispute | null; packReason?: 'disputed' | 'unknown-outcome' | 'overdue' | 'reconciliation-break' | 'failed' | null
}
/** What happened between two moments, from the records. */
export interface Since { from: number; to: number; done: number; missed: number; refused: number; failed: number; lapsed: number; byInstruction: { id: string; title: string; n: number; moved: number }[]; byHand: number; downtime: { gaps: number; ms: number }; refusedWhy: { reason: string | null; title: string }[] }
export interface Dispute { id: string; action_id?: string; state: string; reason: string; resolution: string | null; created_at: number; updated_at: number }
/** One action together with what it ran under. */
export interface RecordView extends ActionView {
  program: { id: string; title: string; kind: string; state: string; version: number | null; contentHash: string | null; signedAt: number | null } | null
  run: { id: string; occurrence: string; dueAt: number; state: string } | null
  approval: { id: string; purpose: string; docHash: string; method: string | null; confirmedAt: number | null } | null
  disputes: Dispute[]
}
export interface RunView { id: string; programId: string; version: number; occurrence: string; state: string; trigger: Record<string, unknown>; dueAt: number; createdAt: number; startedAt: number | null; finishedAt: number | null; deadlineAt: number | null; reason: string | null; willDo: string[]; actions?: ActionView[]; programTitle?: string; programKind?: string }
export interface Authority { maxPerRun: number; maxPerDay: number | null; maxPerMonth: number; expiresAt: number; runMode: 'auto' | 'approve' | 'notify'; noticeSec: number; maxSlippageBps: number; maxRuns: number | null }
export interface Figure { label: string; value: string; basis: string; note?: string }
export interface Analysis { tier: 'certified' | 'bounded' | 'each-time'; tierReason: string; headline: string; figures: Figure[]; consequences: string[]; warnings: string[]; refusals: string[]; worst?: { before: number; after: number; line: number; illustrative: boolean; valid: boolean }; certificate?: Record<string, unknown>; preview?: Record<string, unknown>; computedAt: number }
export interface ProgramSummary {
  id: string; kind: string; pillar: string; title: string; state: string; liveVersion: number | null; hasDraft: boolean; nextDueAt: number | null; pausedReason: string | null; origin: string; createdAt: number; updatedAt: number
  authority: Authority | null; params: Record<string, unknown>; scheduleText: string | null; following: number[]; ceiling: number | null; tier: string | null; tierReason: string | null; headline: string | null; contentHash: string | null; approvedAt: number | null
  usedThisMonth: number | null; lastRun: RunView | null; counts: { done: number; missed: number; refused: number; waiting: number }; watching: { since: number; why: string } | null; lastChecked: number | null; lastBid: number | null; high: number | null
}
export interface ProgramVersion { version: number; state: string; createdAt: number; approvedAt: number | null; approvalId: string | null; approvalMethod: string | null; contentHash: string; params: Record<string, unknown>; authority: Authority; analysis: Analysis; doc: AuthDoc; document: string }
export interface RunCalendar { days: { date: string; runs: number; amount: number; state: 'none' | 'coming' | 'limit' | 'ended'; by?: 'day' | 'month' | 'runs' }[]; months: { month: string; limit: number; used: number; scheduled: number }[]; perRun: number; fixed: boolean; asks: boolean; endsOn: string; limitOn: string | null; limitBy: 'day' | 'month' | 'runs' | null; runs: number; total: number }
export interface ProgramDetail extends ProgramSummary { /** What follows from the version in force, worked out now; null when nothing is in force. */ current: Analysis | null; /** The coming weeks of a scheduled instruction, day by day; null when it waits for an event. */ calendar: RunCalendar | null; versions: ProgramVersion[]; events: { id: number; ts: number; kind: string; actor: string; detail: Record<string, unknown> }[]; runs: RunView[]; /** A savings goal's standing, for an instruction of the kind "goal" (server/goals.ts). */ goal?: GoalView | null }
/**
 * A savings goal as the server works it out (server/goals.ts): where it stands by the stated rule, the monthly figure,
 * and, when it is behind, the remedies in figures that reach it when followed. The interface works out none of it.
 */
export interface GoalView {
  id: string; title: string; state: string; status: 'draft' | 'on-track' | 'behind' | 'reached' | 'date-passed' | 'stopped'; paused: boolean; hasDraft: boolean
  name: string; target: number; date: string; day: number; monthly: number; growthBps: number; runMode: string | null; noticeSec: number
  setAside: number; onItsWay: number
  waiting: { runId: string; amount: number; state: string; deadline: number | null } | null
  scheduled: { count: number; amount: number; first: string | null; last: string | null }
  next: number | null; growth: number; projected: number; shortfall: number
  remedies: { more: { extra: number; monthly: number } | null; later: { date: string } | null; now: { amount: number } | null } | null
  remedyText: string | null; resumeEnough: boolean | null; rule: string; ifNothing: string; latest: string
}
export interface GoalsView { goals: GoalView[]; defaultDay: number; salaryDay: number | null; latest: string; today: string }
export interface Draft { kind: string; pillar: string; title: string; params: Record<string, unknown>; authority: Authority; analysis: Analysis; doc: AuthDoc; contentHash: string }

export interface NeedsYou { type: 'approve-run' | 'object-run' | 'pay-bill' | 'milestone-disputed' | 'milestone-refund' | 'milestone-locked' | 'account-safety' | 'goal-behind'; title: string; detail: string; deadline: number | null; ifNothing: string; runId?: string; programId?: string; billId?: string; milestoneId?: string }
export interface Notice { id: string; ts: number; level: 'action' | 'warning' | 'info'; kind: string; title: string; body: string; subject: string | null; count: number; firstTs: number }
export interface Home {
  overview: Overview; profile: { income: number; incomeDay: number; spending: number; line: number; personalLoanEmi: number; homeLoanEmi: number; emiDay: number; lateDays: number; lostSalaries: number; newPayeeHoldAbove: number; newPayeeHoldHours: number }
  needsYou: NeedsYou[]; notices: Notice[]; programs: ProgramSummary[]; inFlight: ActionView[]
  recon: { ts: number; ok: boolean; checked: string[]; repaired: string[]; inFlight: string[]; breaks: string[] } | null; receipts: { ok: boolean; count: number; brokenAt: number | null; head: string }
  engine: { running: boolean; lastBeat: number | null; startedAt: number | null }; stop: { at: number; reason: string | null; protectiveContinues?: boolean } | null
  spending: { recorded30d: number; assumedMonthly: number; exceeds: boolean }; downtime: { from_ts: number; to_ts: number; missed_runs: number }[]
  /** The on-chain wallet in the books: the last comparison with the wallet service (server/chain-books.ts). Test tokens, never in a rupee figure. */
  chainBooks?: { comparison: ChainComparison | null; words: string }
}
/** The books of one test token against the wallet service's balance (server/chain-books.ts AssetFigures): exact integer text in the token's smallest unit. */
export interface ChainAssetFigures { asset: string; symbol: string; decimals: number; words: string; books: string; inFlight: string; chain: string | null; difference: string | null }
export interface ChainComparison { state: 'agrees' | 'disagrees' | 'unknown'; at: number; block: number | null; assets: ChainAssetFigures[]; why: string | null }
/** One entry of the on-chain wallet's books: `effectiveTs` is its block's time, `entryTs` when QED entered it. */
export interface ChainEntry {
  seq: number; entryTs: number; effectiveTs: number; kind: string; memo: string; txHash: string | null; logIndex: number | null; blockNumber: string | null; blockTimestamp: number | null
  jobId: string | null; escrow: { jobId: string; event: string; role: string } | null; counterparty: { kind: string; label: string | null } | null; recordedLate: boolean; reverses: string | null
  lines: { code: string; name: string; asset: string; symbol: string; decimals: number; words: string; amount_text: string; holder: boolean }[]
}
/** GET /api/chain-books. */
export interface ChainBooksView { network: string; words: string; ordering: string; rule: string; assets: { asset: string; symbol: string; decimals: number; words: string; books: string }[]; entries: ChainEntry[]; comparison: ChainComparison | null }
/** One line of the bank statement: `ts` when it was entered, `effectiveTs` when the event took effect; `amount_text` and `balance_text` are exact (the numbers are null past 2^53). */
export interface PassbookLine { seq: number; ts: number; effectiveTs: number; kind: string; memo: string; amount: number; amount_text?: string; balance: number; balance_text?: string; actor: string; actionId: string | null; receiptId: string | null; programId: string | null; programTitle: string | null; recordedLate: boolean; /** An instalment refused on its day for want of money and taken when the money came (R13). */ takenLate?: boolean; /** When a late line was due or took effect, as the ledger recorded it. */ scheduledAt?: number | null; /** The ledger's own words for why it is late. */ lateReason?: string | null }
export interface PassbookView { balance: number; lines: PassbookLine[]; expected: { dueAt: number; label: string; amount: number; kind: string; certain: boolean; subject: string | null; by: { id: string; title: string; runMode?: string } | null; unpaid: string | null; runMode: string | null }[] }
/**
 * The statement for a chosen period (GET /api/passbook?period=, server/statement.ts): the balance at its start, money in
 * and out, the balance at its end (each exact as text), the period's latest lines, and what is expected while it runs.
 */
export interface StatementView {
  balance: number | null; balance_text: string; period: Period; opened: number | null
  opening: number | null; opening_text: string; moneyIn: number | null; moneyIn_text: string; moneyOut: number | null; moneyOut_text: string; closing: number | null; closing_text: string
  linesIn: number; linesOut: number; /** Lines in this period stamped earlier than a line entered before them. */ backdated: number; count: number; more: boolean; lines: PassbookLine[]; expected: PassbookView['expected']
}

export interface Quote { price: string; size: string | null; sourceTs: number | null; precision: string; recvTs: number; provider: string; ageMs: number; stale: boolean; usableForExecution: boolean; label: string }
export interface MarketInstrument { id: string; kind: string; name: string; base: string; quote: string; provider: string; venue: string; tradable: boolean; baseScale: number; meta: Record<string, unknown> & { category?: string; note?: string; minNotional?: string; qtyStep?: string; cutoff?: string; payoutDays?: number }; quotes: Record<string, Quote> }
/** One row of the household's watchlist (server/watchlist.ts): a price with its source, time and basis, and the change since it was added. */
export interface WatchItem {
  instrumentId: string; name: string; kind: string; quote: string; tradable: boolean; priceType: string; price: string | null
  provider: string; basis: 'observed' | 'synthetic'; precision: string | null; at: number | null; recvTs: number | null; ageMs: number | null; stale: boolean; status: string
  addedAt: number; addedPrice: string | null; addedProvider: string | null; addedPriceAt: number | null
  change: string | null; changePct: number | null; changeNote: string | null
}
export interface Watchlist { items: WatchItem[]; count: number; max: number }
export interface Term { id: string; kind: string; name: string; value: Record<string, unknown>; source: string; source_url: string | null; as_of: string; status: string }
export interface Market { asOf: number; instruments: MarketInstrument[]; providers: { provider: string; state: string; since: number; last_ok: number | null; last_error: string | null; last_error_at: number | null; messages: number; reconnects: number }[]; clock: { ts: number; reference: string; offset_ms: number; uncertainty_ms: number } | null; terms: Term[]; notOffered?: { id: string; name: string; reason: string }[] }
export interface Receipt { id: string; seq: number; ts: number; kind: string; subject: string; body: Record<string, unknown>; prev_hash: string; hash: string }
export interface ActionPreview { quote: { at: number; validUntil: number | null; source: string; best: string; indicative: boolean } | null; approvalId: string; document: string; docHash: string; expiresAt: number; requiresStepUp: boolean; summary: string; lines: { label: string; value: string; basis: string; note?: string }[]; warnings: string[]; worst: { before: number; after: number; line: number } }
export interface Proposal { id: string; origin: 'model' | 'rules'; kind: string; title: string; rationale: string; params: Record<string, unknown>; runMode: string | null; authority?: Partial<Authority> | null; state: string; invalidReason: string | null; ts: number; analysis: { tier: string; tierReason: string; headline: string; figures: Figure[]; warnings: string[]; refusals: string[]; title: string; pillar: string; ceilingPaise?: number | null; expiresAt?: number } | null }
