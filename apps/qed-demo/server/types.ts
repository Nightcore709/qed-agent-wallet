/** Shared server types: the execution context, program authority, and the stored shapes of runs and actions. */
import { type Clock, type Db, parse } from './core.ts'
import type { Market } from './market.ts'
import type { OrderType, RailName, Side, Venues } from './venues.ts'

export interface Ctx { db: Db; clock: Clock; market: Market; venues: Venues }

export type RunMode = 'auto' | 'approve' | 'notify'
export type Pillar = 'spend' | 'save' | 'grow' | 'earn' | 'protect'

/** The envelope the owner signs: what a program may move, how often, until when, and whether it asks first. */
export interface Authority {
  /** Paise per run. */
  maxPerRun: number
  /** Paise per IST calendar day, or null for no separate daily cap. */
  maxPerDay: number | null
  /** Paise per IST calendar month. */
  maxPerMonth: number
  /** Authority ends at this instant; nothing runs afterwards. */
  expiresAt: number
  /** auto: runs without asking. approve: asks before every run. notify: tells you first and runs unless you object in time. */
  runMode: RunMode
  /** Length of the objection window for notify mode, seconds. */
  noticeSec: number
  /** Largest price movement from the best quote that a market order may accept, in basis points. */
  maxSlippageBps: number
  /** Stop after this many completed runs, or null for no count limit. */
  maxRuns: number | null
}

/**
 * When something runs. `zone` is the IANA zone its clock times ("09:00", a weekday, a day of the month) are read in. A schedule
 * that states none is India Standard Time: that is what every signed document before format 2 meant (stage S4).
 */
export type Schedule = (
  | { type: 'every'; minutes: number }
  | { type: 'daily'; at: string }
  | { type: 'weekly'; weekday: number; at: string }
  | { type: 'monthly'; day: number; at: string }
  | { type: 'once'; at: number }
) & { zone?: string }

export interface OrderParams {
  instrumentId: string; side: Side; type: OrderType
  /** Atoms as decimal text. */
  qty?: string; amount?: string
  limitPrice?: string; stopPrice?: string; maxSlippageBps?: number; sellAll?: boolean
  purpose: string
  /** A withdrawal plan's sale: the rupees it was asked to bring in, which its limits are counted in (policy.ts). */
  swpPaise?: string
  /** A sale that reduces risk (floor controller, protective exit). Never blocked by spending caps or the emergency stop. */
  protective?: boolean
}
export interface PaymentParams {
  payeeHandle: string; payeeName: string; amount: string; rail?: RailName
  purpose: 'spend' | 'bill' | 'card' | 'loan:personal' | 'loan:home' | 'fd' | 'goal'
  /** Extra charge taken with the payment (a loan prepayment charge), atoms as decimal text. */
  charge?: string
  billId?: string; memo?: string
  /** A purchase QED makes within the owner's commerce mandate (server/commerce.ts): written only by the server, re-checked by the policy. */
  commerce?: { purchaseId: string; serviceId: string; sku: string }
  /** For a contribution to a goal's set-aside (purpose 'goal'): the goal's instruction, whose set-aside it fills. */
  goalId?: string
  /**
   * A payment to a new payee that must wait before it is sent (server/new-payee.ts): when it may be sent, and why, as the
   * signed terms say. Written only by the server when it prepares the terms; the action is built from those terms.
   * payeeId: the payee the terms were signed for (R13): one removed, added again or renamed while it waits is not paid.
   */
  hold?: { until: number; why: string; payeeId?: string }
}

/** 'held': approved, its money set aside, waiting until its terms' time before it is sent (a payment to a new payee). */
export type ActionState = 'planned' | 'held' | 'blocked' | 'awaiting_approval' | 'submitting' | 'working' | 'done' | 'partial' | 'rejected' | 'failed' | 'cancelled' | 'expired'
export const TERMINAL_ACTION: ReadonlySet<ActionState> = new Set(['blocked', 'done', 'partial', 'rejected', 'failed', 'cancelled', 'expired'])

/** One recorded check. `transient` marks a failure that can clear by itself within seconds (stale data), as opposed to a refusal on the merits. */
export interface Check { name: string; ok: boolean; detail: string; transient?: boolean }
export interface Decision { allowed: boolean; needsApproval: boolean; checks: Check[]; decidedAt: number }

export interface ActionRow {
  id: string; user_id: string; run_id: string | null; program_id: string | null; origin: 'program' | 'owner' | 'commerce'; kind: 'order' | 'payment'; venue: string; economic_id: string
  state: ActionState; params: OrderParams | PaymentParams; policy: Partial<Decision>; result: Record<string, unknown>; times: Record<string, number>
  recon_state: 'open' | 'reconciled' | 'break' | 'not_applicable'; receipt_id: string | null; approval_id: string | null; attempt: number; error: string | null; created_at: number; updated_at: number
}

export function actionFromRow(r: Record<string, unknown>): ActionRow {
  return {
    id: String(r.id), user_id: String(r.user_id), run_id: (r.run_id as string | null) ?? null, program_id: (r.program_id as string | null) ?? null, origin: r.origin as ActionRow['origin'],
    kind: r.kind as ActionRow['kind'], venue: String(r.venue), economic_id: String(r.economic_id), state: r.state as ActionState,
    params: parse<OrderParams | PaymentParams>(r.params_json, {} as OrderParams), policy: parse<Partial<Decision>>(r.policy_json, {}), result: parse<Record<string, unknown>>(r.result_json, {}),
    times: parse<Record<string, number>>(r.times_json, {}), recon_state: r.recon_state as ActionRow['recon_state'], receipt_id: (r.receipt_id as string | null) ?? null,
    approval_id: (r.approval_id as string | null) ?? null, attempt: Number(r.attempt), error: (r.error as string | null) ?? null, created_at: Number(r.created_at), updated_at: Number(r.updated_at),
  }
}

export type RunState = 'due' | 'awaiting_approval' | 'objection_window' | 'executing' | 'done' | 'partial' | 'failed' | 'blocked' | 'skipped' | 'cancelled' | 'expired' | 'missed'
export const TERMINAL_RUN: ReadonlySet<RunState> = new Set(['done', 'partial', 'failed', 'blocked', 'skipped', 'cancelled', 'expired', 'missed'])

export interface PlannedAction { kind: 'order' | 'payment'; venue: string; params: OrderParams | PaymentParams; summary: string }
