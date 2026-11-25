/**
 * The investment idea's record as the server sends it and Grow draws it (R13, the central Grow journey). Money is in
 * paise; a per-rupee outcome is what one rupee put in would be worth at the end of a window, net of costs and modelled tax.
 */
import type { IdeaPlan, Question } from './ideaParse.ts'
import type { Difference, Stress } from './ideaEval.ts'

export type Verdict = 'yes' | 'no' | 'caution' | 'unknown'
export type JudgementKey = 'implementable' | 'affordable' | 'eligible' | 'compatible' | 'supported'
/** One of the five things kept apart: can QED place it, can the household pay for it, is it open to them, does it keep
 *  their own rules, and what the record shows. */
export interface Judgement { key: JudgementKey; title: string; verdict: Verdict; says: string }

export interface IdeaReadView {
  reading: { plan: IdeaPlan; heard: string[]; questions: Question[]; refusal: string | null }
  instrument: { id: string; name: string; kind: string } | null
  free: number
}

/** A plan judged on the same past windows as the idea: the idea itself, doing nothing, or an alternative. */
export interface Outcome {
  id: string; label: string; kind: 'idea' | 'cash' | 'liquid' | 'spread' | 'basket' | 'mix' | 'loan'
  /** per rupee: the middle outcome, the one only 1 window in 20 did worse than, the worst, and the share of windows that lost money */
  median: number | null; p05: number | null; worst: number | null; lostIn: number | null
  /** the money this plan would leave at the end, on the idea's amount (paise, median) */
  medianValue: number | null
  why: string
  /** the decision that carries it out here, if any */
  choice: ChoiceId | null
}
export interface Claim { vs: string; difference: Difference; says: string }
export interface Evidence {
  /** recorded: published prices this app recorded; synthetic: generated on this QED installation; none: no record of the idea */
  basis: 'recorded' | 'synthetic' | 'none'
  source: string
  horizonDays: number; windows: number; firstStart: string | null; lastStart: string | null
  outcomes: Outcome[]
  claims: Claim[]
  /** plain sentences: what the record can and cannot support */
  says: string[]
  notes: string[]
}
export type ChoiceId = 'order' | 'instruction' | 'alt:liquid' | 'alt:spread' | 'reject' | 'nothing'
export interface Choice { id: ChoiceId; label: string; allowed: boolean; why: string }
export interface Investigation {
  v: 1; at: number
  plan: IdeaPlan & { instrumentId: string; amount: number; cadence: 'once' | 'monthly' }
  instrument: { id: string; name: string; kind: string; category: string }
  title: string
  context: {
    bank: number; free: number; mustStay: number; mustStayBy: string | null; setAside: number; card: number; loans: number; personalLoan: number
    holdings: number; netWorth: number; worst: number; floor: number; illustrative: boolean; monthlySpare: number
    sameInForce: { id: string; title: string }[]
  }
  judgements: Judgement[]
  effects: { worstBefore: number; worstAfter: number; floor: number; freeBefore: number; freeAfter: number; marketShareBefore: number; marketShareAfter: number; largest: number | null; concentration: string | null }
  costs: { label: string; value: string; status: string }[]
  evidence: Evidence
  stress: (Stress & { on: number })[]
  case: { for: string[]; against: string[] }
  choices: Choice[]
  /** the run day and end of an instruction this would become, in words */
  schedule: string | null
}

export interface IdeaSummary { id: string; text: string; title: string; createdAt: number; state: IdeaState; choice: ChoiceId | null; revises: string | null }
export type IdeaState = 'open' | 'awaiting-signature' | 'acted' | 'declined' | 'no-action'
export interface IdeaEvent { at: number; kind: string; says: string }
export interface IdeaRecord extends IdeaSummary {
  investigation: Investigation
  hash: string
  reason: string | null
  decidedAt: number | null
  order: null | {
    approvalId: string; docHash: string; signed: boolean; method: string | null; signedAt: number | null; lapsed: boolean
    action: null | { id: string; state: string; what: string; checks: { rule: string; pass: boolean; detail?: string }[]; receiptId: string | null; result: Record<string, unknown>; times: Record<string, number> }
  }
  instruction: null | { programId: string; title: string; state: string; signed: boolean; contentHash: string | null; signedAt: number | null; runs: { done: number; waiting: number; refused: number }; actions: { id: string; state: string; what: string; receiptId: string | null }[] }
  monitor: null | {
    since: number; days: number; put: number; value: number | null; doNothing: number; liquid: number | null
    says: string
  }
  events: IdeaEvent[]
  revisedBy: string | null
}
export type DecideResult =
  | { kind: 'order'; ideaId: string; preview: Record<string, unknown> }
  | { kind: 'instruction'; ideaId: string; programId: string }
  | { kind: 'closed'; ideaId: string }
