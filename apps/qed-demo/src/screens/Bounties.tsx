/**
 * Refutation bounties (R12 section 6; R10-008, R10-009), in design "Meridian" (DESIGN.md M1 to M13). Two bounties of
 * the release each pay their pool to whoever refutes one of QED's theorems. The page keeps three things apart:
 *
 *   - what the two bounties state: each one's theorem, what refutes it, its limits and whom it pays, exactly as the
 *     server serves them from the release's contracts and record (server/bounties.ts), never retyped here;
 *   - what this build runs on a test chain on this computer: the same two contracts, unmodified, judge each claim
 *     behind a board that pays only the committed finder (chain/rail/bounties.ts, QEDBountyBoard); a household checks
 *     a claim with the judge (nothing recorded or sent), commits it, reveals it after the delay, waits out the
 *     contest and settles; each claim's state is said in the shared status words where they apply (M12);
 *   - what was recorded on Sepolia on 19 Oct 2026: the deployments, the funding and the five claims, labelled
 *     historical and not re-verified. Nothing here reads, claims or funds the Sepolia contracts.
 *
 * No passkey is asked (the server's design, server/api.ts): a claim is made by the household's claimant key, which the
 * vault service uses only for bounty claims and which holds no authority over the wallet. Every step the vault service
 * takes is sent under an idempotency key; the key is reused only when an answer was lost, so a step can never happen
 * twice. Every token is a valueless test token. The head is drawn before any data (M11).
 */
import { ArrowRight, Check, Clock, FlaskConical, History, Minus, RefreshCw, X } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Job } from '../../chain/types.ts'
import { api, ApiError, fmt, useData, useNow } from '../lib/core.ts'
import { Btn, Crumb, Field, Link, Loading, Note, Problem, Stamp, useAction } from '../ui/kit.tsx'

// ------------------------------------------------------------------------------------------------ the API's shapes

/** A transaction of the vendored Sepolia record (server/bounties.ts `tx`). */
export interface Tx { step: string; title: string; by: string; from: string; hash: string; block: string; at: string; status: string; gasUsed: string; error?: { name: string; args: string[] } }
/** One of the two original bounties as stated and recorded (server/bounties.ts `originalBounties`). */
export interface Original { key: string; name: string; network: string; address: string; verifier?: string; token: string; theorem: string; invites: string; test: string; limits: string[]; pays: string; funded: Tx & { amount: string; amountText: string }; deployed: Tx; attempts: Tx[]; status: string }
/** A bounty on this computer's board (chain/rail/bounties.ts `board`). */
export interface LocalBounty { id: string; key: string; kind: 'optimality' | 'maximality'; role: 'original' | 'positive-control'; judge: string; title: string; phase: 'none' | 'open' | 'contest' | 'settleable' | 'settled'; pool: string; poolText: string; paid: string; winner: string | null; recipient: string | null; contestEndsAt: number | null; periods: { revealDelaySeconds: number; revealWindowSeconds: number; contestSeconds: number }; selector: string }
export type ClaimState = 'committing' | 'committed' | 'revealable' | 'leading' | 'overtaken' | 'won' | 'lost' | 'expired' | 'too-late'
/** One of this household's claims, its state read from the chain (chain/rail/bounties.ts `claims`). The salt is never sent. */
export interface Claim { claimId: string; bountyId: string; key: string; state: ClaimState; claimant: string; recipient: string; payTo: 'reserve' | 'owner-account'; claimHash: string; claimBytes: number; seq: string; committed: { seq: string; at: number; revealableAt: number; expiresAt: number; tx: string } | null; revealed: { tx: string; at: string } | null; settled: { tx: string; payout: string; at: string } | null; contestEndsAt: number | null; createdAt: string; paid: string | null; paidText: string | null }
export interface Recipients { reserve: string; ownerAccount: string | null }
/** The vault service's part: the board and this household's claims, or (`available: false`) why not, with its code. */
export interface Local { available: boolean; code?: string; reason?: string | null; status?: string; auto?: boolean; board?: string | null; chainId?: number; token?: string; domain?: { name: string; version: string; chainId: number; verifyingContract: string; separator: string }; claimType?: string; deployBlock?: string; artifact?: { bytecodeSha256: string; sourceSha256: string }; bounties?: LocalBounty[]; claimant?: string | null; recipients?: Recipients; claims?: Claim[] }
export interface View { originals: Original[]; local: Local; howItPays: string; scope: string }
/** The judge's ruling on a claim, asked on this computer's chain; nothing recorded or sent. */
export interface CheckResult { bountyId: string; key: string; role: string; valid: boolean; claimHash: string; claimBytes: number; error?: { name: string; args: string[]; words: string }; words: string }
type Tone = 'ok' | 'wait' | 'void' | 'plain' | 'info' | undefined
interface Ctx { now: number; auto: boolean; recipients: Recipients | null }

// ------------------------------------------------------------------------------------------------ words and figures

const IST = 19_800_000
const sameDay = (a: number, b: number): boolean => Math.floor((a + IST) / 86_400_000) === Math.floor((b + IST) / 86_400_000)
/** A time in India time, to the second (the bounties' periods are seconds on a test chain); the day only when it is not today. */
export const clock = (ms: number, now: number): string => (sameDay(ms, now) ? fmt.time(ms, true) : `${fmt.day(ms)}, ${fmt.time(ms, true)}`)
const sec = (s: number | null | undefined, now: number): string => (s ? clock(s * 1000, now) : '')
/** A recorded time, as the record has it: in UTC. */
const utc = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 19)} UTC` }
/** An address or hash, shortened the way the service's words are: 0x and four characters each side. */
export const short = (h: string | null | undefined): string => (h && h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h ?? '')
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`
/** A period of the board in words: whole days, hours or minutes when it is one, seconds otherwise. */
export const span = (s: number): string => (s >= 86_400 && s % 86_400 === 0 ? plural(s / 86_400, 'day') : s >= 3600 && s % 3600 === 0 ? plural(s / 3600, 'hour') : s >= 60 && s % 60 === 0 ? plural(s / 60, 'minute') : plural(s, 'second'))
/** Test dollars from micro-units, digit by digit (six decimals, at least two shown): never through a float. */
export function tusd(raw: string | null | undefined): string {
  if (raw == null || !/^-?\d+$/.test(raw)) return raw ?? ''
  const neg = raw.startsWith('-')
  const digits = (neg ? raw.slice(1) : raw).padStart(7, '0')
  const int = digits.slice(0, -6).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = digits.slice(-6).replace(/0+$/, '').padEnd(2, '0')
  return `${neg ? '−' : ''}${int}.${frac} tUSD`
}
/** The vault service's words as a person reads them: its times in India time, its addresses and hashes shortened. */
export const say = (text: string): string => text
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (t) => { const ms = Date.parse(t); return `${fmt.day(ms)}, ${fmt.time(ms, true)} IST` })
  .replace(/\b0x([0-9a-fA-F]{4})[0-9a-fA-F]{56}([0-9a-fA-F]{4})\b/g, '0x$1…$2')
  .replace(/\b0x([0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g, '0x$1…$2')
const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase()
/** Whose recipient an address is: this household's reserve vault, its owner account, or another claimant's. */
const whose = (addr: string | null, r: Recipients | null): string => (r && same(addr, r.reserve) ? 'your reserve vault' : r && same(addr, r.ownerAccount) ? 'your owner account' : `another claimant's recipient (${short(addr)})`)
const toWhom = (c: Claim): string => (c.payTo === 'owner-account' ? 'your owner account' : 'your reserve vault')
/** A bounty's name: the contract's own for the originals; for a positive control, what it is. */
export function bountyName(b: LocalBounty): { name: string; more: string } {
  const i = b.title.indexOf(':')
  return i < 0 ? { name: b.title, more: '' } : { name: b.title.slice(0, i), more: b.title.slice(i + 1).trim() }
}

// ------------------------------------------------------------------------------------------------ a claim, a bounty

/**
 * A claim's state: the shared status word where one applies (M12: Submitted, Pending, Completed, Expired), the bounty's
 * own word where none does (ready to reveal, overtaken, lost, too late); the stage in the bounty's words; what it means;
 * what the person can do next, which depends on whether this vault service reveals and settles on its own; and the one
 * action the screen offers for it.
 */
export function claimWords(c: Claim, b: LocalBounty | undefined, x: Ctx): { stage: string; word: string; tone: Tone; say: string; next: string; act: 'reveal' | 'settle' | null } {
  const t = (s: number | null | undefined) => sec(s, x.now)
  const k = c.committed
  const ends = c.contestEndsAt ?? b?.contestEndsAt ?? null
  const anyone = 'Anyone may settle; the board pays only the recorded recipient.'
  switch (c.state) {
    case 'committing': return { stage: 'Committing', word: 'Submitted', tone: undefined, act: null, say: 'Your commitment is on its way to the chain. It carries a fingerprint of the claim only; the claim stays private.', next: 'Nothing to do: it shows as committed once the chain has it.' }
    case 'committed': return {
      stage: 'Committed', word: 'Pending', tone: undefined, act: null,
      say: `Commitment #${c.seq} is on the chain. The claim stays private until it is revealed.`,
      next: x.auto ? `Nothing to do: this vault service reveals it on its own from ${t(k?.revealableAt)}. You may reveal it yourself then.` : `Reveal it from ${t(k?.revealableAt)}, before ${t(k?.expiresAt)}: this vault service does not reveal claims on its own.`,
    }
    case 'revealable': return {
      stage: 'Ready to reveal', word: 'Ready to reveal', tone: 'wait', act: 'reveal',
      say: `Commitment #${c.seq} may be revealed now, until ${t(k?.expiresAt)}. Revealing it makes the claim public; your commitment, recorded before anyone could see the claim, decides who is paid.`,
      next: x.auto ? `Reveal it now, or let this vault service reveal it in a moment. If it is not revealed by ${t(k?.expiresAt)}, it lapses and cannot be paid.` : `Reveal it now. If it is not revealed by ${t(k?.expiresAt)}, it lapses and cannot be paid.`,
    }
    case 'leading': {
      const settle = b?.phase === 'settleable'
      return {
        stage: 'Leading', word: 'Pending', tone: undefined, act: settle ? 'settle' : null,
        say: `The judge accepted the revealed claim. The pool, ${tusd(b?.pool ?? '1000000000')}, goes to ${toWhom(c)} at settlement${ends ? `, from ${t(ends)}` : ''}, unless an older commitment is revealed before then.`,
        next: settle
          ? (x.auto ? `This vault service settles it on its own in a moment; you may settle it now. ${anyone}` : `Settle it now: the board pays ${tusd(b?.pool ?? '1000000000')} to ${toWhom(c)}. ${anyone}`)
          : (x.auto ? `Nothing to do: this vault service settles it on its own when the contest ends at ${t(ends)}.` : `Wait for the contest to end at ${t(ends)}; then settle it. ${anyone}`),
      }
    }
    case 'overtaken': return { stage: 'Overtaken', word: 'Overtaken', tone: 'plain', act: null, say: 'An older commitment was revealed during the contest and took over. This claim will not be paid.', next: 'Nothing to do: only the oldest valid commitment is paid.' }
    case 'won': return { stage: 'Won', word: 'Completed', tone: 'ok', act: null, say: `${c.paidText ?? tusd(c.paid)} paid to ${toWhom(c)}.`, next: `Nothing to do. It is in ${toWhom(c)} on this computer's chain, in test dollars with no value.` }
    case 'lost': return { stage: 'Lost', word: 'Lost', tone: 'plain', act: null, say: 'It was revealed, but an older commitment won the contest; the pool went to its recipient.', next: 'Nothing to do: only the oldest valid commitment is paid.' }
    case 'expired': return {
      stage: 'Lapsed', word: 'Expired', tone: 'plain', act: null,
      say: `It was not revealed before ${t(k?.expiresAt)}, so it can no longer be paid. Nothing was paid out and nothing was lost.`,
      next: b?.phase === 'open' ? 'Commit it again: paste the claim into "Make a claim". A new commitment gets a new delay and a new reveal window.' : 'The bounty is no longer open, so a new commitment could not be paid.',
    }
    case 'too-late': return { stage: 'Too late', word: 'Too late', tone: 'plain', act: null, say: `It was never revealed, and it can no longer win: ${b?.phase === 'settled' ? 'the bounty has been paid' : 'a commitment older than it leads'}.`, next: 'Nothing to do: a claim that can no longer win is never revealed, so nothing is sent.' }
    default: return { stage: String(c.state), word: String(c.state), tone: 'plain', act: null, say: '', next: '' }
  }
}

export type StepState = 'done' | 'now' | 'next' | 'missed' | 'off'
/** The four steps of a claim (commit, reveal after the delay, the contest, settlement), each done, under way, to come, missed or out of reach. */
export function steps(c: Claim, b: LocalBounty | undefined, now: number): { key: string; label: string; detail: string; state: StepState }[] {
  const t = (s: number | null | undefined) => sec(s, now)
  const k = c.committed
  const p = b?.periods
  const ends = c.contestEndsAt ?? b?.contestEndsAt ?? null
  const S: Record<ClaimState, [StepState, StepState, StepState, StepState]> = {
    committing: ['now', 'next', 'next', 'next'], committed: ['done', 'next', 'next', 'next'], revealable: ['done', 'now', 'next', 'next'],
    leading: b?.phase === 'settleable' ? ['done', 'done', 'done', 'now'] : ['done', 'done', 'now', 'next'], won: ['done', 'done', 'done', 'done'],
    overtaken: ['done', 'done', 'missed', 'off'], lost: ['done', 'done', 'missed', 'off'], expired: ['done', 'missed', 'off', 'off'], 'too-late': ['done', 'off', 'off', 'off'],
  }
  const st = S[c.state] ?? ['next', 'next', 'next', 'next']
  return [
    { key: 'commit', label: 'Committed', state: st[0], detail: k ? `Commitment #${k.seq}, ${t(k.at)}` : 'Being recorded' },
    { key: 'reveal', label: 'Revealed', state: st[1], detail: c.revealed ? `${clock(Date.parse(c.revealed.at), now)}` : k ? `From ${t(k.revealableAt)} until ${t(k.expiresAt)}` : p ? `${span(p.revealDelaySeconds)} after it is committed` : '' },
    { key: 'contest', label: 'Contest', state: st[2], detail: ends ? `Until ${t(ends)}` : p ? `${span(p.contestSeconds)} after the first valid reveal` : '' },
    { key: 'settle', label: 'Settled', state: st[3], detail: c.settled ? `${tusd(c.settled.payout)} paid, ${clock(Date.parse(c.settled.at), now)}` : 'Anyone may settle once the contest is over' },
  ]
}

/** A bounty's phase on this computer's board, and whether it takes a claim now. */
export function phaseWords(b: LocalBounty, x: Ctx): { word: string; tone: Tone; say: string; open: boolean } {
  switch (b.phase) {
    case 'open': return { word: 'Open', tone: 'ok', open: true, say: `Open for claims: ${b.poolText} in the pool.` }
    case 'contest': return { word: 'Contest', tone: 'wait', open: false, say: `A valid claim was revealed. Its claimant leads until ${sec(b.contestEndsAt, x.now)} unless an older commitment is revealed before then; no new commitment is accepted.` }
    case 'settleable': return { word: 'Ready to settle', tone: 'wait', open: false, say: `The contest is over. Anyone may settle it; the board pays only the leading claimant's recipient, which is ${whose(b.recipient, x.recipients)}.` }
    case 'settled': return { word: 'Paid and closed', tone: 'plain', open: false, say: `It paid ${tusd(b.paid)} to ${whose(b.recipient, x.recipients)} and takes no more claims.` }
    default: return { word: 'Not opened', tone: 'plain', open: false, say: 'This bounty has not been opened on the board.' }
  }
}

// ------------------------------------------------------------------------------------------------ failures

const SAME_KEY = 'it repeats this request under the same key, so it cannot happen twice.'
/** What went wrong with a request, and what the person can do next. */
export function failureOf(e: { status: number; code: string; message: string }): { title: string; say: string; next: string; to?: { href: string; label: string } } {
  switch (e.code) {
    case 'claim_rejected': return { title: 'Refused by QED\'s checks: the judge rejects this claim', say: e.message, next: 'Nothing was recorded or sent. A claim the judge rejects can never be paid: check a different claim.' }
    case 'bounty_not_open': return { title: 'Refused by QED\'s checks: this bounty is not open', say: e.message, next: 'Nothing was recorded or sent, and this claim earns nothing: only the commitment made first is paid. Choose a bounty that is open.' }
    case 'vault_not_set_up': return { title: 'Your household has no on-chain wallet yet', say: e.message, next: 'A claim is made by a key of its vault service and the pool is paid into the wallet.', to: { href: '/vault', label: 'Set up your on-chain wallet' } }
    case 'unknown_workspace': return { title: 'The vault service no longer knows this wallet', say: 'Its data was replaced since the wallet was set up.', next: 'Set the wallet up again; the old wallet\'s claims stay with the old data.', to: { href: '/vault', label: 'Set up your on-chain wallet again' } }
    case 'not_permitted': return { title: 'Your role cannot do this', say: e.message, next: 'Ask the workspace\'s owner or an operator to claim it.' }
    case 'rail_off': case 'rail_unavailable': case 'rail_misconfigured': case 'bounties_unavailable': return { title: 'The wallet service is not answering', say: e.message, next: 'Nothing was sent. Start the vault service, then try again.' }
    case 'rail_starting': return { title: 'The wallet service is starting', say: e.message, next: 'Nothing was sent. Try again in a moment.' }
    case 'rail_outcome_unknown': return { title: 'The answer was lost: the outcome is not known yet', say: e.message, next: `Press the same button again: ${SAME_KEY}` }
    case 'unreachable': return { title: 'QED is not answering', say: e.message, next: `Check that QED is running, then press the same button again: ${SAME_KEY}` }
    case 'invalid_claim': case 'invalid': return { title: 'The claim is not in a shape the judge takes', say: e.message, next: 'Correct it and check it again. Nothing was sent.' }
    case 'too_large': return { title: 'This claim is too large for one request', say: e.message, next: 'Send the claim\'s fields instead of its calldata: they are shorter.' }
    case 'unknown_bounty': return { title: 'This bounty is not on this chain', say: e.message, next: 'Read the chain again to see the bounties it has.' }
    case 'unknown_claim': return { title: 'This claim is not on record for this household', say: e.message, next: 'Read the chain again to see this household\'s claims.' }
    case 'too_many_claims': return { title: 'This household holds as many claims as it may', say: e.message, next: 'Nothing was recorded or sent.' }
    default: return { title: 'It could not be done', say: e.message, next: 'Nothing was confirmed. Try again; if it happens again, the vault service\'s records say why.' }
  }
}

/** The vault service's part of the page when it cannot answer for this household: why, what still stands, what to do. */
export function unavailableWords(l: { code?: string; reason?: string | null }): { title: string; say: string; next: string; to?: { href: string; label: string }; retry: boolean } {
  const stands = 'The bounties\' statements and the Sepolia record on this page do not depend on it.'
  const reason = l.reason ?? ''
  switch (l.code) {
    case 'vault_not_set_up': return { title: 'Set up your on-chain wallet to claim', say: reason, next: `Set it up, then come back here to make a claim. ${stands}`, to: { href: '/vault', label: 'Set up your on-chain wallet' }, retry: false }
    case 'unknown_workspace': return { title: 'The vault service no longer knows this wallet', say: 'Its data was replaced since the wallet was set up.', next: 'Set the wallet up again to claim.', to: { href: '/vault', label: 'Set up your on-chain wallet again' }, retry: false }
    case 'bounties_off': return { title: 'The bounty board is turned off on this vault service', say: reason || 'It was started with its bounty board turned off.', next: stands, retry: false }
    case 'bounties_unavailable': return { title: 'The bounty board is not on this chain', say: reason || 'The vault service could not set it up.', next: `${stands} Its records say why.`, retry: true }
    case 'rail_starting': return { title: 'The wallet service is starting', say: reason, next: `${stands} Try again in a moment.`, retry: true }
    case 'rail_off': case 'rail_unavailable': case 'rail_misconfigured': case 'rail_refused': return { title: 'The wallet service is not answering', say: reason, next: `${stands} Your claims are kept by the service and its chain; a claim must still be revealed before it lapses, so start the service again before then.`, retry: true }
    default: return { title: 'The bounties on this computer cannot be shown', say: reason, next: stands, retry: true }
  }
}

/** A step of the vault service as it runs and as it ended, in the shared status words. */
export function jobWords(j: Job): { finished: boolean; word: string; tone: Tone; say: string } {
  if (j.status === 'accepted') return { finished: false, word: 'Submitted', tone: undefined, say: 'Sent to the vault service; it has not started yet.' }
  if (j.status === 'running' || j.status === 'confirming') return { finished: false, word: 'Pending', tone: undefined, say: 'The vault service is working on it on the chain.' }
  if (j.status === 'failed') return { finished: true, word: 'Failed', tone: 'void', say: say(j.error ?? 'It stopped with an error.') }
  if (j.status === 'interrupted') return { finished: true, word: 'Needs attention', tone: 'void', say: say(`The vault service stopped while this ran.${j.guidance ? ` ${j.guidance}` : ''}`) }
  if (j.status === 'reorged') return { finished: true, word: 'Not done', tone: 'void', say: say(`${j.error ?? 'A reorganisation of the chain replaced the block that held its transaction.'}${j.guidance ? ` ${j.guidance}` : ''}`) }
  const r = j.result
  const text = say(r?.summary ?? '')
  switch (r?.outcome) {
    case 'executed': return { finished: true, word: 'Completed', tone: 'ok', say: text }
    case 'refused': return { finished: true, word: 'Refused by QED\'s checks; nothing sent', tone: 'void', say: text }
    case 'no-action': return { finished: true, word: 'No action needed', tone: 'plain', say: text }
    case 'reverted': return { finished: true, word: 'Reverted on the chain', tone: 'void', say: text }
    default: return { finished: true, word: 'Failed', tone: 'void', say: text || 'It ended without a result.' }
  }
}

// ------------------------------------------------------------------------------------------------ the claim as pasted

/** The most a claim's text may be: the API takes 64 KiB a request, and the request carries the claim and a little more. */
const MAX_CLAIM_TEXT = 60_000
const SHAPE = '{ "calldata": "0x…" } or the fields of the judge\'s claim'
/** The claim as the person pastes it: a JSON object, or the judge's calldata alone. Refused here, in words, otherwise. */
export function parseClaim(text: string): { claim: Record<string, unknown> } | { error: string } {
  const t = text.trim()
  if (!t) return { error: `Paste the claim: ${SHAPE}.` }
  if (t.length > MAX_CLAIM_TEXT) return { error: 'This claim is larger than one request to this wallet may be (60,000 characters). Its fields are shorter than its calldata: send the fields.' }
  if (/^0x/i.test(t)) {
    if (!/^0x[0-9a-f]*$/i.test(t)) return { error: 'Calldata is 0x and whole bytes of hexadecimal.' }
    if ((t.length - 2) % 2) return { error: 'Calldata is 0x and whole bytes of hexadecimal: this has an odd number of digits.' }
    return { claim: { calldata: t.toLowerCase() } }
  }
  let v: unknown
  try { v = JSON.parse(t) } catch { return { error: `This is not valid JSON. A claim is ${SHAPE}, every integer a decimal string.` } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `A claim is one JSON object: ${SHAPE}.` }
  return { claim: v as Record<string, unknown> }
}

/**
 * The judge's ruling on this computer, beside the record: when a claim to an original bounty is refused with exactly
 * the error and the figures recorded on Sepolia for one of the five claims, that recorded claim is named.
 */
export function sameAsRecorded(check: CheckResult, b: LocalBounty | undefined, originals: Original[]): Tx | null {
  if (check.valid || !check.error || !b || b.role !== 'original') return null
  const o = originals.find((x) => x.key === b.key)
  const e = check.error
  return o?.attempts.find((a) => a.error?.name === e.name && a.error.args.length === e.args.length && a.error.args.every((v, i) => v === e.args[i])) ?? null
}

// ------------------------------------------------------------------------------------------------ steps of the vault service

const newKey = (): string => `bounty-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lost = (e: unknown): boolean => e instanceof ApiError && (e.code === 'rail_outcome_unknown' || e.code === 'unreachable')

/**
 * One step sent to the vault service (commit, reveal, settle) and followed to its end. Each press is a new request
 * under a new key, except after a lost answer: pressing again then repeats the same request under the same key, which
 * the vault service answers with the job it already started, so the step never happens twice.
 */
function useStep(onEnd: (job: Job | null) => void) {
  const [job, setJob] = useState<Job | null>(null)
  const kept = useRef<{ id: string; key: string } | null>(null)
  const alive = useRef(true)
  // set on every mount: React's StrictMode mounts, unmounts and mounts again in development
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const end = useRef(onEnd)
  end.current = onEnd
  const act = useAction(async (path: string, body: Record<string, unknown>) => {
    setJob(null)
    const id = `${path} ${JSON.stringify(body)}`
    const key = kept.current?.id === id ? kept.current.key : newKey()
    kept.current = { id, key }
    let a: { jobId: string }
    try { a = await api<{ jobId: string }>('POST', path, { ...body, key }) } catch (e) { if (!lost(e)) kept.current = null; throw e }
    kept.current = null
    let j: Job | null = null
    for (let i = 0; i < 400 && alive.current; i++) {
      try { j = await api<Job>('GET', `/api/vault/jobs/${a.jobId}`); if (alive.current) setJob(j) } catch { /* the next read asks again */ }
      if (j && jobWords(j).finished) break
      await pause(i < 20 ? 500 : 1500)
    }
    if (alive.current) end.current(j)
  })
  return { run: act.run, busy: act.busy, error: act.error, job, clear: () => { act.clear(); setJob(null) } }
}

// ------------------------------------------------------------------------------------------------ parts of the page

function Failure({ e }: { e: ApiError }) {
  const f = failureOf(e)
  return (
    <Note tone="void" title={f.title}>
      <p>{say(f.say)}</p>
      <p><strong>What you can do:</strong> <span>{f.next}</span></p>
      {f.to ? <p className="bt-note-acts"><Link to={f.to.href} className="btn sm">{f.to.label}<ArrowRight aria-hidden="true" /></Link></p> : null}
    </Note>
  )
}

function JobLine({ job }: { job: Job }) {
  const w = jobWords(job)
  return <div className="bt-job"><Stamp tone={w.tone}>{w.word}</Stamp>{w.say ? <span>{w.say}</span> : null}</div>
}

const STEP_ICON: Record<StepState, typeof Check> = { done: Check, now: Clock, next: Minus, missed: X, off: Minus }
const STEP_WORD: Record<StepState, string> = { done: 'done', now: 'now', next: 'to come', missed: 'missed', off: 'out of reach' }
function Steps({ c, b, now }: { c: Claim; b: LocalBounty | undefined; now: number }) {
  return (
    <ol className="bt-steps" aria-label="The steps of this claim">
      {steps(c, b, now).map((s) => {
        const I = STEP_ICON[s.state]
        return <li key={s.key} className={`bt-step ${s.state}`}><span className="bt-step-dot" aria-hidden="true"><I /></span><span className="bt-step-t"><strong>{s.label}</strong><span className="sr-only">, {STEP_WORD[s.state]}</span><span className="bt-step-d">{s.detail}</span></span></li>
      })}
    </ol>
  )
}

/** One of this household's claims: its state, its four steps, what to do next, and the one action that applies. */
function ClaimCard({ c, b, x, onChange }: { c: Claim; b: LocalBounty | undefined; x: Ctx; onChange: () => void }) {
  const w = claimWords(c, b, x)
  const step = useStep(onChange)
  const n = b ? bountyName(b) : { name: `Bounty ${c.bountyId}`, more: '' }
  const id = `bt-c-${c.claimId.slice(2, 12)}`
  return (
    <li>
      <article className={`bt-claim ${c.state}`} aria-labelledby={id}>
        <div className="bt-claim-top">
          <h3 id={id}>Bounty {c.bountyId}: {n.name}</h3>
          <Stamp tone={w.tone}>{w.word}</Stamp>
        </div>
        <p className="bt-claim-say"><strong>{w.stage}.</strong> <span>{w.say}</span></p>
        <Steps c={c} b={b} now={x.now} />
        <p className="bt-claim-next"><strong>What you can do:</strong> <span>{w.next}</span></p>
        {w.act ? (
          <div className="bt-claim-act">
            {w.act === 'reveal'
              ? <Btn tone="fill" busy={step.busy} onClick={() => void step.run(`/api/bounties/claims/${c.claimId}/reveal`, {})}>Reveal the claim</Btn>
              : <Btn tone="fill" busy={step.busy} onClick={() => void step.run(`/api/bounties/${c.bountyId}/settle`, {})}>Settle and pay</Btn>}
          </div>
        ) : null}
        <div aria-live="polite">{step.job ? <JobLine job={step.job} /> : null}</div>
        {step.error ? <Failure e={step.error} /> : null}
        <details className="bt-fold">
          <summary>As the chain sees it</summary>
          <dl className="kv small">
            <dt>Claim</dt><dd className="code">{c.claimId}</dd>
            <dt>Commitment</dt><dd>#{c.seq}{c.committed ? <>, transaction <span className="code bt-ref">{short(c.committed.tx)}</span></> : null}</dd>
            <dt>Claim's fingerprint</dt><dd><span className="code">{c.claimHash}</span> ({c.claimBytes.toLocaleString('en-US')} bytes)</dd>
            <dt>Claimant key</dt><dd className="code">{c.claimant}</dd>
            <dt>Paid to</dt><dd>{toWhom(c)}, <span className="code">{c.recipient}</span></dd>
            {c.revealed ? <><dt>Revealed</dt><dd>transaction <span className="code bt-ref">{short(c.revealed.tx)}</span></dd></> : null}
            {c.settled ? <><dt>Settled</dt><dd>transaction <span className="code bt-ref">{short(c.settled.tx)}</span></dd></> : null}
          </dl>
        </details>
      </article>
    </li>
  )
}

/** The form: which bounty, the claim, where the pool goes; the judge's ruling first (nothing sent), then the commitment. */
function MakeClaim({ v, x, pick, setPick, onChange, field }: { v: View; x: Ctx; pick: string | null; setPick: (id: string) => void; onChange: () => void; field: RefObject<HTMLTextAreaElement | null> }) {
  const bounties = v.local.bounties ?? []
  const chosen = bounties.find((b) => b.id === pick) ?? bounties.find((b) => b.phase === 'open') ?? bounties[0]
  const [text, setText] = useState('')
  const [payTo, setPayTo] = useState<'reserve' | 'owner-account'>('reserve')
  const [bad, setBad] = useState<string | null>(null)
  const [ruling, setRuling] = useState<{ for: string; r: CheckResult } | null>(null)
  const [made, setMade] = useState<{ bountyId: string; seq: string; revealableAt: number; summary: string } | null>(null)
  const inputs = `${chosen?.id ?? ''}\n${text}`
  const check = useAction(async () => {
    const p = parseClaim(text)
    if ('error' in p) { setBad(p.error); return }
    setBad(null)
    setRuling({ for: inputs, r: await api<CheckResult>('POST', `/api/bounties/${chosen!.id}/check`, { claim: p.claim }) })
  })
  const commit = useStep((job) => {
    const ev = job?.result?.evidence as { seq?: string; revealableAt?: number; bountyId?: string } | undefined
    if (job?.status === 'done' && job.result?.outcome === 'executed' && ev?.seq) {
      setMade({ bountyId: ev.bountyId ?? chosen?.id ?? '', seq: ev.seq, revealableAt: Number(ev.revealableAt ?? 0), summary: job.result.summary })
      setText(''); setRuling(null)
    }
    onChange()
  })
  // a refusal because the bounty is not open any more: the board is read again, so the page shows its phase
  useEffect(() => { if (commit.error && ['bounty_not_open', 'unknown_bounty', 'vault_not_set_up', 'unknown_workspace'].includes(commit.error.code)) onChange() }, [commit.error, onChange])
  if (!chosen) return null
  const phase = phaseWords(chosen, x)
  const shown = ruling && ruling.for === inputs ? ruling.r : null
  const recorded = shown ? sameAsRecorded(shown, chosen, v.originals) : null
  const submit = () => {
    const p = parseClaim(text)
    if ('error' in p) { setBad(p.error); return }
    setBad(null); setMade(null)
    void commit.run(`/api/bounties/${chosen.id}/claims`, { claim: p.claim, payTo })
  }
  return (
    <section className="panel bt-make" id="make-a-claim" aria-labelledby="bt-make-h">
      <div className="panel-head"><h2 id="bt-make-h">Make a claim</h2><p>Ask the judge first: nothing is recorded or sent.</p></div>
      <form className="bt-form" onSubmit={(e) => { e.preventDefault(); void check.run() }}>
        <fieldset className="choice bt-pick">
          <legend className="legend">Which bounty</legend>
          {bounties.map((b) => {
            const n = bountyName(b), p = phaseWords(b, x)
            return (
              <label key={b.id}>
                <input type="radio" name="bt-bounty" value={b.id} checked={b.id === chosen.id} onChange={() => { setPick(b.id); setMade(null); commit.clear() }} />
                <b>Bounty {b.id}: {n.name}</b>
                <small>{p.word}{b.phase === 'open' ? `, ${b.poolText} in the pool` : ''}{b.role === 'positive-control' ? '. A positive control for tests: its judge can be refuted on purpose' : ''}</small>
              </label>
            )
          })}
        </fieldset>
        <Field label="The claim" hint={'As JSON: { "calldata": "0x…" }, or the fields of the judge\'s claim, every integer a decimal string. See "What a claim looks like" below.'} error={bad ?? undefined}>
          {(p) => <textarea {...p} ref={field} className="input bt-text" rows={7} spellCheck={false} autoComplete="off" value={text} onChange={(e) => { setText(e.target.value); setBad(null) }} />}
        </Field>
        <fieldset className="choice bt-payto">
          <legend className="legend">If it wins, the pool goes to</legend>
          <label><input type="radio" name="bt-payto" value="reserve" checked={payTo === 'reserve'} onChange={() => setPayTo('reserve')} /><b>Your reserve vault</b><small>The wallet's test-dollar vault{v.local.recipients ? <>, <span className="code bt-ref">{short(v.local.recipients.reserve)}</span></> : null}</small></label>
          <label><input type="radio" name="bt-payto" value="owner-account" disabled={!v.local.recipients?.ownerAccount} checked={payTo === 'owner-account'} onChange={() => setPayTo('owner-account')} /><b>Your owner account</b><small>{v.local.recipients?.ownerAccount ? <>The account your passkeys sign for, <span className="code bt-ref">{short(v.local.recipients.ownerAccount)}</span></> : 'Not available until your wallet is accepted'}</small></label>
        </fieldset>
        <div className="bt-form-acts">
          <Btn type="submit" busy={check.busy}>Check with the judge</Btn>
          {phase.open ? <Btn tone="fill" busy={commit.busy} onClick={submit}>Commit the claim</Btn> : null}
        </div>
        {!phase.open ? <p className="bt-closed small"><strong>Bounty {chosen.id} takes no claim now.</strong> {phase.say} A claim committed now could not be paid; the judge can still be asked.</p> : <p className="small faint">Committing records only a fingerprint of the claim on the chain. No passkey is asked: the claim is made by this household's claimant key, which holds no authority over your wallet.</p>}
      </form>
      <div aria-live="polite" className="bt-results">
        {check.error ? <Failure e={check.error} /> : null}
        {shown ? (
          shown.valid
            ? <Note tone="ok" title="The judge accepts this claim: it refutes the theorem"><p>Nothing was recorded or sent. {phase.open ? 'Commit it to claim the pool: until it is committed, anyone who finds the same refutation can commit before you.' : 'This bounty is not open, so a commitment made now would earn nothing.'}</p><p className="small">The claim's fingerprint is <span className="code bt-ref">{short(shown.claimHash)}</span> ({shown.claimBytes.toLocaleString('en-US')} bytes).</p></Note>
            : <Note tone="void" title="The judge rejects this claim: it does not refute the theorem">
                <p>{say(shown.error?.words ?? shown.words)}</p>
                <p><strong>What you can do:</strong> nothing was recorded or sent, and a claim the judge rejects is never committed. Check a different claim.</p>
                {shown.error ? <p className="small">As the judge says it: <span className="code">{shown.error.name}({shown.error.args.join(', ')})</span></p> : null}
                {recorded ? <p className="bt-same"><History aria-hidden="true" /><span>Reproduced on this computer: the judge here gives exactly the answer recorded on Sepolia for claim {recorded.step} on {utc(recorded.at)} (historical, not re-verified).</span></p> : null}
              </Note>
        ) : null}
        {commit.job && !made ? <JobLine job={commit.job} /> : null}
        {commit.error ? <Failure e={commit.error} /> : null}
        {made ? <Note tone="ok" title={`Committed to bounty ${made.bountyId} as commitment #${made.seq}`}><p>{say(made.summary)}</p><p>It is listed under "Your claims".</p></Note> : null}
      </div>
      <details className="bt-fold">
        <summary>What a claim looks like</summary>
        <div className="bt-shapes small">
          <p>The judge's <span className="code">claim</span> call as calldata: <span className="code">{'{ "calldata": "0x…" }'}</span>, or its fields, every integer a decimal string, exactly as the contracts take them (W = 10¹⁸; amounts in micro-tUSD):</p>
          <p>OptimalityBounty: <span className="code">{'{ "spec": { "n", "cov", "tol", "universe"? }, "certificate": { "w", "nu", "mu", "L" }, "x" }'}</span></p>
          <p>MaximalityBounty: <span className="code">{'{ "economy": { "members", "debtor", "creditor", "d" }, "certified": { "x", "potential", "y" }, "larger" }'}</span></p>
        </div>
      </details>
    </section>
  )
}

/** The bounties on this computer's board, each with its phase; a contest that is over can be settled by anyone. */
function Board({ v, x, onPick, onChange }: { v: View; x: Ctx; onPick: (id: string) => void; onChange: () => void }) {
  const l = v.local
  return (
    <section className="panel bt-board" aria-labelledby="bt-board-h">
      <div className="panel-head">
        <h2 id="bt-board-h">On this computer's chain</h2>
        <Btn tone="quiet" small onClick={onChange}><RefreshCw aria-hidden="true" />Read the chain again</Btn>
      </div>
      <p className="bt-board-say">The same two contracts, unmodified, judge each claim; a board holds each pool and pays only the claimant who committed first. Chain {l.chainId ?? 31337} runs on this computer; tUSD are test dollars with no value.</p>
      <ul className="bt-bounties">{(l.bounties ?? []).map((b) => <BoardRow key={b.id} b={b} x={x} onPick={onPick} onChange={onChange} />)}</ul>
      <details className="bt-fold">
        <summary>As the chain sees it</summary>
        <dl className="kv small">
          <dt>Board</dt><dd className="code">{l.board}</dd>
          {l.domain ? <><dt>Commitments bound to</dt><dd>"{l.domain.name}", version {l.domain.version}, chain {l.domain.chainId}, separator <span className="code bt-ref">{short(l.domain.separator)}</span></dd></> : null}
          {l.claimType ? <><dt>A commitment signs</dt><dd className="code">{l.claimType}</dd></> : null}
          {l.claimant ? <><dt>Your claimant key</dt><dd className="code">{l.claimant}</dd></> : null}
          {l.artifact ? <><dt>Board's build</dt><dd>bytecode <span className="code">{l.artifact.bytecodeSha256.slice(0, 16)}</span>, source <span className="code">{l.artifact.sourceSha256.slice(0, 16)}</span> (sha256)</dd></> : null}
        </dl>
      </details>
    </section>
  )
}
function BoardRow({ b, x, onPick, onChange }: { b: LocalBounty; x: Ctx; onPick: (id: string) => void; onChange: () => void }) {
  const p = phaseWords(b, x)
  const n = bountyName(b)
  const settle = useStep(onChange)
  const id = `bt-b-${b.id}`
  return (
    <li className={`bt-bounty ${b.phase}`} aria-labelledby={id}>
      <div className="bt-bounty-top"><h3 id={id}>Bounty {b.id}: {n.name}</h3><Stamp tone={p.tone}>{p.word}</Stamp></div>
      {b.role === 'positive-control' ? <p className="bt-control"><FlaskConical aria-hidden="true" /><span>{n.more.replace(/^./, (ch) => ch.toUpperCase())}. A positive control for tests, opened only on a test stack: its judge can be refuted on purpose, so a real payout can be shown.</span></p> : null}
      <p className="bt-bounty-say">{p.say}</p>
      <p className="small faint">Revealed from {span(b.periods.revealDelaySeconds)} after it is committed, within {span(b.periods.revealWindowSeconds)}; contest {span(b.periods.contestSeconds)}.</p>
      {p.open ? <Btn small onClick={() => onPick(b.id)}>Claim bounty {b.id}</Btn> : null}
      {b.phase === 'settleable' ? <Btn small busy={settle.busy} onClick={() => void settle.run(`/api/bounties/${b.id}/settle`, {})}>Settle bounty {b.id}</Btn> : null}
      <div aria-live="polite">{settle.job ? <JobLine job={settle.job} /> : null}</div>
      {settle.error ? <Failure e={settle.error} /> : null}
    </li>
  )
}

/** Why a copier gets nothing: the four steps in plain words, then the limits. */
function Protection({ v }: { v: View }) {
  const auto = v.local.auto
  return (
    <section className="panel bt-guard" aria-labelledby="bt-guard-h">
      <div className="panel-head"><h2 id="bt-guard-h">Why a copier gets nothing</h2></div>
      <p className="bt-guard-lead">{v.howItPays}</p>
      <ol className="bt-flow">
        <li><strong>Commit</strong><span>The claim is sealed before anyone sees it: the chain records only a fingerprint of it, bound to your claimant key, where the pool goes, a secret that stays with the vault service, the bounty, the chain and the board.</span></li>
        <li><strong>Reveal, after a short delay</strong><span>Only now does the claim become public. A copier who reads your pending reveal and gets its copy mined first is refused: the board works the fingerprint out again with the copier as the claimant, and no such commitment exists. Naming itself as the recipient changes the fingerprint too.</span></li>
        <li><strong>The contest</strong><span>For a short window after the first valid reveal, only an older commitment can take over, and no new commitment is accepted. A copier's own commitment, made after it saw your claim, is younger than yours.</span></li>
        <li><strong>Settle</strong><span>Anyone may settle once the contest is over; the board pays only the recorded recipient, once. The judge itself holds nothing, so a claim sent straight to it pays nothing.</span></li>
      </ol>
      <div className="bt-guard-foot">
        <p className="small"><strong>Limits.</strong> The protection holds if your reveal is mined within the delay plus the contest of being sent, and before your commitment lapses; on this computer the vault service runs the chain itself. The vault service sees your claim before it commits it, so you rely on it not to claim first; anyone may instead commit from their own key straight to the board.</p>
        {auto === undefined ? null : <p className="small">{auto ? 'This vault service reveals your claims as soon as they may be revealed and settles your winning ones, so a claim does not depend on this page being open.' : 'This vault service is set not to reveal or settle on its own: reveal each claim before it lapses, and settle it once its contest is over.'}</p>}
      </div>
    </section>
  )
}

/** One bounty's statement, exactly as served; then where it stands on this computer's chain. */
function Statement({ o, here, x, onPick }: { o: Original; here: LocalBounty | undefined; x: Ctx; onPick: (id: string) => void }) {
  const p = here ? phaseWords(here, x) : null
  return (
    <article className="panel bt-st" aria-labelledby={`bt-st-${o.key}`}>
      <div className="bt-st-top"><h3 id={`bt-st-${o.key}`}>{o.name}</h3><span className="bt-pool">1,000 tUSD</span></div>
      <dl className="bt-st-dl">
        <dt>The theorem</dt><dd>{o.theorem}</dd>
        <dt>What refutes it</dt><dd>{o.invites}</dd>
        <dt>Its limits</dt><dd><ul className="bt-limits">{o.limits.map((l) => <li key={l}>{l}</li>)}</ul></dd>
        <dt>Whom the contract pays</dt><dd>{o.pays}</dd>
      </dl>
      <details className="bt-fold"><summary>The exact test, in the contract's integers</summary><p className="bt-test">{o.test}</p></details>
      {here && p ? (
        <div className="bt-st-here">
          <p><strong>On this computer's chain:</strong> bounty {here.id}, <Stamp tone={p.tone}>{p.word}</Stamp> {here.phase === 'open' ? `${here.poolText} in the pool. The same contract only judges here: the board pays the committed finder.` : p.say}</p>
          {p.open ? <Btn small onClick={() => onPick(here.id)}>Claim bounty {here.id}</Btn> : null}
        </div>
      ) : null}
    </article>
  )
}

/** What was recorded on Sepolia on 19 Oct 2026, kept apart from what this computer runs; dated and not re-verified. */
function Recorded({ v }: { v: View }) {
  return (
    <section className="bt-past" aria-labelledby="bt-past-h">
      <div className="section-head"><h2 id="bt-past-h">Recorded on Sepolia, 19 October 2026</h2><span className="stamp bt-label"><History aria-hidden="true" />Historical; not re-verified</span></div>
      <p className="bt-past-say">{v.scope} The record is the release's own, kept byte for byte with this build.</p>
      <div className="bt-pair">
        {v.originals.map((o) => (
          <article key={o.key} className="panel bt-past-card" aria-labelledby={`bt-past-${o.key}`}>
            <h3 id={`bt-past-${o.key}`}>{o.name} on Sepolia</h3>
            <p className="bt-past-status">{o.status}</p>
            <dl className="kv small">
              <dt>Network</dt><dd>{o.network}</dd>
              <dt>Contract</dt><dd className="code">{o.address}</dd>
              <dt>Deployed</dt><dd>{utc(o.deployed.at)}, block {o.deployed.block}, by {o.deployed.by}; transaction <span className="code bt-ref">{short(o.deployed.hash)}</span></dd>
              <dt>Funded</dt><dd>{o.funded.amountText}, {utc(o.funded.at)}, block {o.funded.block}, by {o.funded.by}; transaction <span className="code bt-ref">{short(o.funded.hash)}</span></dd>
            </dl>
            <h4 className="bt-tries-h">Claims recorded against it</h4>
            <ol className="bt-tries">
              {o.attempts.map((a) => (
                <li key={a.step}>
                  <div className="bt-try-top"><strong>{a.step}</strong><span className="small faint">{utc(a.at)}, block {a.block}</span><Stamp tone="void">Reverted</Stamp></div>
                  <p className="small">{a.error ? <>The judge refused it: <span className="code bt-args">{a.error.name}({a.error.args.join(', ')})</span></> : a.status}</p>
                  <p className="small faint">From <span className="code bt-ref">{short(a.from)}</span>; transaction <span className="code bt-ref">{short(a.hash)}</span></p>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the screen

const LIVE = new Set<ClaimState>(['committing', 'committed', 'revealable', 'leading'])

export function BountiesScreen() {
  const view = useData<View>('/api/bounties')
  const now = useNow(1000)
  const [pick, setPick] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const claims = view.data?.local.claims ?? []
  // While a claim of this household moves on its own (committing, its delay, its reveal window, its contest), the chain
  // is read again every few seconds; otherwise only when the person acts or asks to.
  const moving = claims.some((c) => LIVE.has(c.state))
  const reload = view.reload
  useEffect(() => { if (!moving) return undefined; const t = setInterval(reload, 2500); return () => clearInterval(t) }, [moving, reload])
  const head = (
    <header className="page-head bt-head">
      <div>
        <Crumb to="/earn">Earn</Crumb>
        <h1>Refutation bounties</h1>
        <p>Two of the release's bounties pay their pool to whoever shows that one of QED's theorems is false. Here a claim is checked by the bounty's own contract and paid only to the household that committed it first.</p>
      </div>
      <span className="stamp bt-label"><FlaskConical aria-hidden="true" />Test chain on this computer; tokens of no value</span>
    </header>
  )
  if (!view.data) return <div className="bt">{head}{view.error ? <div className="bt-load-failed"><Problem error={view.error} /><Btn small onClick={reload}>Try again</Btn></div> : <div className="page-wait"><Loading what="Reading the bounties" /></div>}</div>
  const v = view.data
  const l = v.local
  const x: Ctx = { now, auto: l.auto === true, recipients: l.recipients ?? null }
  const byId = new Map((l.bounties ?? []).map((b) => [b.id, b]))
  const onPick = (id: string) => { setPick(id); requestAnimationFrame(() => { document.getElementById('make-a-claim')?.scrollIntoView({ block: 'start' }); field.current?.focus({ preventScroll: true }) }) }
  const down = l.available ? null : unavailableWords(l)
  return (
    <div className="bt">
      {head}
      {down ? (
        <Note tone={down.to ? 'wait' : 'void'} title={down.title}>
          {down.say ? <p>{say(down.say)}</p> : null}
          <p><strong>What you can do:</strong> <span>{down.next}</span></p>
          {down.to || down.retry ? <p className="bt-note-acts">{down.to ? <Link to={down.to.href} className="btn sm">{down.to.label}<ArrowRight aria-hidden="true" /></Link> : null}{down.retry ? <Btn small onClick={reload}>Try again</Btn> : null}</p> : null}
        </Note>
      ) : null}
      {view.error ? <div className="bt-load-failed"><Problem error={view.error} /><Btn small onClick={reload}>Try again</Btn></div> : null}
      {claims.length ? (
        <section className="bt-mine" aria-labelledby="bt-mine-h">
          <div className="section-head"><h2 id="bt-mine-h">Your claims</h2><p className="small">Newest first, each read from the chain.</p></div>
          <ul className="bt-claims">{claims.map((c) => <ClaimCard key={c.claimId} c={c} b={byId.get(c.bountyId)} x={x} onChange={reload} />)}</ul>
        </section>
      ) : null}
      <section className="bt-said" aria-labelledby="bt-said-h">
        <div className="section-head"><h2 id="bt-said-h">What the two bounties state</h2><p className="small">As the release's contracts and record state them, served unchanged; the limits are the contracts' own constants.</p></div>
        <div className="bt-pair">{v.originals.map((o) => <Statement key={o.key} o={o} here={(l.bounties ?? []).find((b) => b.key === o.key)} x={x} onPick={onPick} />)}</div>
      </section>
      {l.available ? (
        <div className="bt-work">
          <MakeClaim v={v} x={x} pick={pick} setPick={setPick} onChange={reload} field={field} />
          <Board v={v} x={x} onPick={onPick} onChange={reload} />
        </div>
      ) : null}
      <Protection v={v} />
      <Recorded v={v} />
    </div>
  )
}

