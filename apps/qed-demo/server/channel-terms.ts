/**
 * Channel parameters (N-016, and N-004 on the paper side). A channel at an institution (an e-mandate, a variable recurring
 * payment consent, a data consent) is given terms that are derived from the signed instruction and are never wider than it:
 * the per-payment maximum, the period limit, the expiry and the scope. An institution applies a mandate's limits on its own, whatever
 * other limits the customer has set (RBI's e-mandate framework, EV-073), so the limits have to be right when the mandate is made.
 *
 * SIMULATED: the paper bank's own ceilings below are QED's stand-ins, not RBI's, the FCA's or any bank's figures.
 * derive() builds the terms; assertNoWider() refuses any set of terms wider than the instruction, whoever built them.
 * The remaining capacity of a mandate is at most the instruction's own remaining authority, which the reserve already counts
 * (liquidity.ts instructionCaps), so a mandate never commits money the reserve has not counted.
 */
import { type Db, newId, refused } from './core.ts'
import type { Authority } from './types.ts'

export type Channel = 'e-mandate' | 'vrp-consent' | 'data-consent'
export const CHANNELS: readonly Channel[] = ['e-mandate', 'vrp-consent', 'data-consent']
export interface Signed { maxPerRun: number; maxPerMonth: number; expiresAt: number; /** Payee addresses a payment channel may debit for, or the data categories a data channel may read. */ scope: string[] }
export interface ChannelTerms { channel: Channel; simulated: true; perPayment: number | null; perMonth: number | null; expiresAt: number; scope: string[] }

const DAY = 86_400_000
/** The paper bank's own ceilings, in paise and days. */
export const PAPER_CEILINGS: Record<Channel, { perPayment: number | null; perMonth: number | null; days: number }> = {
  'e-mandate': { perPayment: 10_000_000, perMonth: 50_000_000, days: 365 },
  'vrp-consent': { perPayment: 5_000_000, perMonth: 20_000_000, days: 365 },
  'data-consent': { perPayment: null, perMonth: null, days: 180 },
}
/** What a data consent may read: never payment initiation. */
export const DATA_SCOPES: readonly string[] = ['balances', 'transactions']

export function signedOf(a: Pick<Authority, 'maxPerRun' | 'maxPerMonth' | 'expiresAt'>, scope: string[]): Signed {
  return { maxPerRun: a.maxPerRun, maxPerMonth: a.maxPerMonth, expiresAt: a.expiresAt, scope }
}

/** The terms a channel is given for a signed instruction: the instruction's own limits, narrowed to the institution's ceilings, never widened. */
export function derive(channel: Channel, s: Signed, now: number): ChannelTerms {
  const c = PAPER_CEILINGS[channel]
  const expiresAt = Math.min(s.expiresAt, now + c.days * DAY)
  if (channel === 'data-consent') return { channel, simulated: true, perPayment: null, perMonth: null, expiresAt, scope: s.scope.filter((x) => DATA_SCOPES.includes(x)) }
  return { channel, simulated: true, perPayment: Math.min(s.maxPerRun, c.perPayment!), perMonth: Math.min(s.maxPerMonth, c.perMonth!), expiresAt, scope: [...s.scope] }
}

/** Refuses terms wider than the signed instruction on any of: per-payment maximum, period limit, expiry, scope. */
export function assertNoWider(t: ChannelTerms, s: Signed): void {
  const wider: string[] = []
  if (t.channel === 'data-consent') {
    if (t.perPayment !== null || t.perMonth !== null) wider.push('a data consent carries no payment limit')
    if (t.scope.some((x) => !DATA_SCOPES.includes(x))) wider.push('a data consent may read balances and transactions only')
  } else {
    if (t.perPayment === null || t.perPayment > s.maxPerRun) wider.push(`a payment maximum above the instruction's ${s.maxPerRun}`)
    if (t.perMonth === null || t.perMonth > s.maxPerMonth) wider.push(`a monthly limit above the instruction's ${s.maxPerMonth}`)
    if (t.scope.length === 0 || t.scope.some((x) => !s.scope.includes(x))) wider.push('a scope the instruction does not name')
  }
  if (t.expiresAt > s.expiresAt) wider.push('an expiry later than the instruction\'s')
  if (wider.length) throw refused('channel_wider', `That ${t.channel} would be wider than what you signed: ${wider.join('; ')}. Nothing was set up.`)
}

/** What is left of a channel's period limit after what has been used in the period (never below zero); null where it has no limit. */
export function remainingCapacity(t: ChannelTerms, usedThisMonth: number): number | null {
  return t.perMonth === null ? null : Math.max(0, t.perMonth - usedThisMonth)
}

/** Record a channel's terms for an instruction, after checking them against the signed instruction. Idempotent for the same instruction and channel. */
export function recordChannelTerms(db: Db, userId: string, programId: string, institution: string, t: ChannelTerms, s: Signed, reference: string | null, now: number): ChannelTerms {
  assertNoWider(t, s)
  db.run('INSERT OR IGNORE INTO channel_terms (id, user_id, program_id, channel, institution, reference, terms_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', newId('cht', now), userId, programId, t.channel, institution, reference, JSON.stringify(t), now)
  return t
}
export function channelTermsOf(db: Db, userId: string, programId: string): (ChannelTerms & { institution: string; reference: string | null; endedAt: number | null })[] {
  return db.all<{ channel: string; institution: string; reference: string | null; terms_json: string; ended_at: number | null }>('SELECT channel, institution, reference, terms_json, ended_at FROM channel_terms WHERE user_id = ? AND program_id = ? ORDER BY created_at', userId, programId)
    .map((r) => ({ ...(JSON.parse(r.terms_json) as ChannelTerms), institution: r.institution, reference: r.reference, endedAt: r.ended_at }))
}
