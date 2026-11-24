/**
 * What the Portfolio lab's API returns (server/lab.ts) and its screen reads (src/screens/Lab.tsx). Every figure says
 * where it comes from: `basis` is one of "books" (the household's own ledger and latest prices), "simulation" (computed
 * here, now, from prices this app recorded), "research" (the recorded R11 study, never re-run here), "modelled"
 * (QED's stated assumption, such as a tax rate not verified this session) or "illustration" (what something would
 * take, which this app cannot do). Money is integer paise unless a field says otherwise.
 */
import type { CoverageOutcome as Outcome } from './kernel/index.ts'
import type { Metrics } from './portfolio.ts'

export type Basis = 'books' | 'simulation' | 'research' | 'modelled' | 'illustration' | 'indicative'

export interface LabLot { openedAt: number; days: number; cost: number; value: number | null; gain: number | null; taxClass: string }
export interface LabHolding {
  instrumentId: string; name: string; kind: 'fund' | 'crypto'; category: string; growth: boolean
  value: number | null; cost: number; gain: number | null; weight: number | null
  payoutDays: number; fundHouse: string; dollarLinked: boolean; limit: number; limitStatus: string
  price: string | null; priceAt: number | null; stale: boolean; provider: string | null; lots: LabLot[]
}
export interface LabTrade {
  instrumentId: string; name: string; side: 'buy' | 'sell'; amount: number
  realisedGain: number; tax: number; taxNote: string; fee: number; feeNote: string; tds: number
}
/** The allocator's evidence for a mix other than equal shares (R13, G6): how it was solved, how it did out of sample, what the study found. */
export interface LabAllocationEvidence {
  method: string; window: { from: string; to: string; observations: number }; shrinkage: number
  certified: boolean; certificate: Record<string, number>
  outOfSample: { months: number; sharpeEW?: number; sharpeP?: number; detectable?: boolean; tooShort?: boolean; text: string }
  study: { sharpe?: number; sharpeEW?: number; maxDD?: number; maxDDEW?: number; pFwer?: number | null; text: string }
  leftOut: string[]; caveats: string[]
}
export interface LabAllocation {
  policy: 'equal' | 'riskparity' | 'minvar'; policyText: string; bandBps: number
  evidence?: LabAllocationEvidence
  legs: { instrumentId: string; name: string; value: number; weight: number; target: number; drift: number; trade: number }[]
  drift: number; outside: boolean
  trades: LabTrade[]; taxTotal: number; feeTotal: number; tdsTotal: number
  newMoney: { monthly: number; gap: number; months: number | null; programs: string[] } | null
  proposable: boolean; why: string
  params: { legs: { instrumentId: string; weightBps: number }[]; bandBps: number; schedule: { type: 'daily'; at: string } } | null
  existing: { id: string; title: string; state: string }[]
}
export interface LabMonitor {
  growthValue: number
  concentration: { largest: { name: string; weight: number } | null; hhi: number; effectiveN: number; byFundHouse: { house: string; weight: number }[]; crypto: number }
  liquidity: { steps: { label: string; days: number; amount: number }[]; due7: number; due30: number; free: number; short7: boolean; short30: boolean }
  dollar: { weight: number; amount: number; names: string[] }
  stale: string[]
}
export interface LabBooks {
  bank: number; bankAvailable: number; deposits: number; card: number; loans: number; freeToUse: number; netWorth: number
  due30: number; dues: { label: string; amount: number; dueAt: number; certain: boolean; kind: string }[]
  holdings: LabHolding[]
  worst: { gHat: number; line: number; cushion: number; illustrative: boolean; valid: boolean }
}
export interface LabStrategy {
  id: string; label: string; assets: string[]; metrics: Metrics; turnover: number; costDrag: number; path: number[]
  cert: Record<string, number>; weightsLast: Record<string, number>
  vsEW: { diff: number; lo: number; hi: number; se: number; mde: number; detectable: boolean; tooShort: boolean } | null
}
export interface LabEvaluation {
  basis: 'simulation'; source: string; synthetic: boolean
  months: string[]; lookbackDays: number; observations: number
  assets: { id: string; name: string }[]; rf: string
  costs: { buy: number; trade: number; note: string }
  strategies: LabStrategy[]
  verdict: string
}
export interface LabTerm { id: string; name: string; value: string; status: string; source: string }
export interface LabView {
  asOf: number
  presentation: boolean
  books: LabBooks
  monitor: LabMonitor
  allocation: LabAllocation
  evaluation: LabEvaluation | { error: string; source: string }
  terms: LabTerm[]
}
export interface LabCertificate {
  id: string; pillar: 'save' | 'grow'; title: string; plain: string; basis: Basis
  assumptions: string[]; request: unknown; outcome: Outcome
}
export interface LabCertificates { asOf: number; declared: boolean; cases: LabCertificate[]; notes: string[] }
export interface LabHedge {
  usd: number; due: string; days: number
  fx: { source: string; synthetic: boolean; from: string; to: string; latest: number; latestDate: string; windows: number } | null
  unhedged: { pShort: number; mean: number; cvar95: number; worst: number; growth: string } | null
  hedged: { maturity: string; lots: number; limitPerLot: number; costUsd: number; costInr: number | null; rate: { source: string; value: number; date: string } | null }
  certificate: Outcome
  notes: string[]
}
