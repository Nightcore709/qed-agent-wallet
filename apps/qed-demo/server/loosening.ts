/**
 * A change to the household's settings that weakens a protection waits out the protection delay (R13 section 4, for the
 * wait on payments to new payees; the mandate omissions audit, finding P1, for every protection the profile holds). It uses
 * the mechanism a lowering of a workspace's signing policy already uses (workspaces.ts setPolicy): a row in
 * scheduled_changes, applied by the engine's tick when its delay ends (passkeys.ts applyDueChanges), cancellable meanwhile
 * from any of the person's passkeys (passkeys.ts cancelScheduledChange), listed under Security and recovery.
 *
 * What weakens a protection, and so waits (PROTECTION_DELAY_MS, 72 hours):
 *   - a lower floor (line); income allowed to arrive less late (lateDays); fewer salaries allowed never to arrive
 *     (lostSalaries): what must stay in the bank, or above the floor, would be less;
 *   - a higher amount above which payments to a new payee wait, a shorter wait, or none (new-payee.ts);
 *   - household figures (salary, spending, instalments, their days) changed so that what must stay in the bank falls
 *     (liquidity.ts): it frees money for QED's instructions just as lowering the reserve's assumptions does.
 * Tightening takes effect at once: each protection moves at once to the stricter of what is in force and what is asked,
 * and figures that do not lower what must stay are saved at once. A request that does both is split. A request names the
 * values it wants for its keys, so it replaces what a waiting change would have set for those keys: a later tightening is
 * never undone by an earlier loosening falling due, and a loosening asked again starts its delay again.
 *
 * When a loosening is asked for, the person (in a business workspace, every member who may sign) and each of the person's
 * recovery contacts are told at once, as an urgent notice inside QED and on every confirmed address, through the outbox
 * this installation uses (passkeys.ts securityEvent, delivery.ts); the person is told again when it takes effect. A change
 * that loosens anything needs a fresh confirmation with a passkey, checked here again under the write lock, so that a
 * request that was a tightening when its session read the settings cannot become an unconfirmed loosening because another
 * request tightened them meanwhile. Everything runs in one transaction (BEGIN IMMEDIATE), so two requests, or a request
 * and the engine applying a change, are taken one after the other.
 */
import { AppError, bad, type Db, j, newId, parse } from './core.ts'
import { getProfile, PROFILE_KEYS, type Profile, type ProfileKey, saveProfile, validateProfile } from './household.ts'
import { billLowersReserve, liquidity } from './liquidity.ts'
import { HOLD_OFF } from './new-payee.ts'
import { activeContacts, handleOf, PROTECTION_DELAY_MS, securityEvent } from './passkeys.ts'
import { members } from './workspaces.ts'
import { homeMoneyExact } from '../shared/home-money.ts'

/** The scheduled change's kind (scheduled_changes.kind). */
export const LOOSEN_PROFILE = 'loosen-profile'
export type Change = Partial<Pick<Profile, ProfileKey>>

/** How strict a wait on new payees is: none at all is the least strict; otherwise the longer, the stricter. */
const waitStrictness = (hours: number): number => (hours === HOLD_OFF ? -1 : hours)
type Protection = 'line' | 'lateDays' | 'lostSalaries' | 'newPayeeHoldAbove' | 'newPayeeHoldHours'
/** For each protection, the stricter of two values. */
const STRICTER: Record<Protection, (a: number, b: number) => number> = {
  line: Math.max, lateDays: Math.max, lostSalaries: Math.max, newPayeeHoldAbove: Math.min,
  newPayeeHoldHours: (a, b) => (waitStrictness(a) >= waitStrictness(b) ? a : b),
}
const isProtection = (k: string): k is Protection => k in STRICTER
/** Household figures: facts rather than protections, which weaken one only through what must stay in the bank. */
const FIGURES = PROFILE_KEYS.filter((k) => !isProtection(k))

const pick = (from: Change, keys: readonly string[]): Change => Object.fromEntries(keys.filter((k) => from[k as ProfileKey] !== undefined).map((k) => [k, from[k as ProfileKey]]))

/**
 * What of a request takes effect now and what waits: each protection at the stricter of the present and the asked-for;
 * the figures now, unless together they lower what must stay in the bank (counted with the protections as they will be
 * now), in which case they wait together. `later` holds the asked-for values that differ from what is now in force.
 */
export function splitChange(db: Db, workspaceId: string, cur: Profile, asked: Change, now: number): { now: Change; later: Change; lowersReserve: { before: number; after: number } | null } {
  const at: Change = {}, later: Change = {}
  for (const k of Object.keys(asked) as ProfileKey[]) {
    if (!isProtection(k)) continue
    const v = STRICTER[k](cur[k], asked[k]!)
    if (v !== cur[k]) at[k] = v
    if (v !== asked[k]) later[k] = asked[k]
  }
  const figures = FIGURES.filter((k) => asked[k] !== undefined && asked[k] !== cur[k])
  let lowersReserve: { before: number; after: number } | null = null
  if (figures.length) {
    const base: Profile = { ...cur, ...at }
    const before = liquidity(db, workspaceId, now, {}, base).need, after = liquidity(db, workspaceId, now, {}, { ...base, ...pick(asked, figures) }).need
    if (after < before) { lowersReserve = { before, after }; Object.assign(later, pick(asked, figures)) }
    else Object.assign(at, pick(asked, figures))
  }
  return { now: at, later, lowersReserve }
}

export interface PendingChange { id: string; requestedAt: number; effectiveAt: number; after: Change; before: Change }

/** The loosening waiting to take effect in this workspace, if one is (there is never more than one). */
export function pendingChange(db: Db, workspaceId: string): PendingChange | null {
  const c = db.get<{ id: string; requested_at: number; effective_at: number; detail_json: string }>(
    'SELECT id, requested_at, effective_at, detail_json FROM scheduled_changes WHERE workspace_id = ? AND kind = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at DESC LIMIT 1', workspaceId, LOOSEN_PROFILE)
  if (!c) return null
  const d = parse<{ after?: Change; before?: Change }>(c.detail_json, {})
  return { id: c.id, requestedAt: c.requested_at, effectiveAt: c.effective_at, after: d.after ?? {}, before: d.before ?? {} }
}

const SIGNING_ROLES = new Set(['owner', 'admin', 'approver'])
const rupees = (paise: number): string => homeMoneyExact(paise).replace(/\.00$/, '')

/**
 * Change the household's figures and protections, from a session the caller has checked may ask (api.ts). In one
 * transaction: the part that tightens, or weakens nothing, is saved; what the request names replaces what a waiting change
 * would have set; a part that loosens is scheduled, with everyone who must know told. Returns the profile now in force,
 * the keys saved now, and the change left waiting, if any (`deferred` when this request added to it).
 */
export function changeProfile(db: Db, by: { personId: string; workspaceId: string; fresh: boolean; beforeLoosening?: () => void }, asked: Change, now: number): { profile: Profile; applied: ProfileKey[]; waiting: PendingChange | null; deferred: boolean; replaced: string | null; contactsTold: number } {
  const errors = validateProfile(asked)
  if (Object.keys(errors).length) throw bad('Some profile values are not valid.', errors)
  const ws = by.workspaceId
  return db.tx(() => {
    const cur = getProfile(db, ws)
    const split = splitChange(db, ws, cur, asked, now)
    const deferred = Object.keys(split.later).length > 0
    if (deferred && !by.fresh) {
      throw new AppError(401, 'stepup_required', split.lowersReserve && Object.keys(split.later).every((k) => !isProtection(k))
        ? `This lowers what must stay in your bank account from ${rupees(split.lowersReserve.before)} to ${rupees(split.lowersReserve.after)}, which frees that money for QED's instructions. Confirm with your passkey to make the change.`
        : 'This weakens one of your protections. Confirm with your passkey to make the change.')
    }
    // a passkey in its first 24 hours loosens nothing (server/passkeys.ts refuseCoolingOff; RISK-068, Q-062)
    if (deferred) by.beforeLoosening?.()
    if (Object.keys(split.now).length) saveProfile(db, ws, split.now)
    const pending = pendingChange(db, ws)
    const named = Object.keys(asked)
    let replaced: string | null = null, waiting: PendingChange | null = pending, contactsTold = 0
    if (pending && (deferred || named.some((k) => k in pending.after))) {
      db.run(`UPDATE scheduled_changes SET cancelled_at = ?, cancelled_by = 'replaced' WHERE id = ? AND cancelled_at IS NULL AND applied_at IS NULL`, now, pending.id)
      replaced = pending.id
      waiting = null
    }
    const left = pending && replaced ? pick(pending.after, Object.keys(pending.after).filter((k) => !named.includes(k))) : {}
    const inForce = getProfile(db, ws)
    const schedule = (after: Change, requestedAt: number, effectiveAt: number): PendingChange => {
      const id = newId('chg', now), before = pick(inForce, Object.keys(after))
      db.run('INSERT INTO scheduled_changes (id, person_id, workspace_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, by.personId, ws, LOOSEN_PROFILE, ws, j({ after, before }), requestedAt, by.personId, effectiveAt)
      return { id, requestedAt, effectiveAt, after, before }
    }
    if (deferred) {
      // a loosening: its own full delay from now, with what was left of a change waiting before carried into it
      waiting = schedule({ ...left, ...split.later }, now, now + PROTECTION_DELAY_MS)
      const detail = { workspaceId: ws, changeId: waiting.id, effectiveAt: waiting.effectiveAt, after: waiting.after, before: waiting.before }
      const people = new Set([by.personId, ...(ws === by.personId ? [] : members(db, ws).filter((m) => SIGNING_ROLES.has(m.role)).map((m) => m.personId))])
      for (const person of people) securityEvent(db, person, 'profile-loosening-scheduled', detail, now)
      const contacts = activeContacts(db, by.personId, now)
      for (const c of contacts) securityEvent(db, c, 'contact-loosening-scheduled', { for: handleOf(db, by.personId), effectiveAt: waiting.effectiveAt }, now)
      contactsTold = contacts.length
    } else if (pending && replaced && Object.keys(left).length) {
      // what is left of the waiting change keeps its time and its request: nothing in it is new
      waiting = schedule(left, pending.requestedAt, pending.effectiveAt)
    }
    return { profile: inForce, applied: Object.keys(split.now) as ProfileKey[], waiting, deferred, replaced, contactsTold }
  })
}

// ------------------------------------------------------------------------------------------------ removing a bill the reserve counts

/** The scheduled change's kind for removing a bill that is counted in what must stay in the bank (scheduled_changes.kind). */
export const REMOVE_BILL = 'remove-bill'
export interface BillRemoval { id: string; billId: string; requestedAt: number; effectiveAt: number; reserve: { before: number; after: number } }

/** The removal waiting for this bill, if one is. */
export function pendingBillRemoval(db: Db, workspaceId: string, billId: string): BillRemoval | null {
  const c = db.get<{ id: string; requested_at: number; effective_at: number; detail_json: string }>(
    'SELECT id, requested_at, effective_at, detail_json FROM scheduled_changes WHERE workspace_id = ? AND kind = ? AND subject = ? AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at DESC LIMIT 1', workspaceId, REMOVE_BILL, billId)
  return c ? { id: c.id, billId, requestedAt: c.requested_at, effectiveAt: c.effective_at, reserve: parse<{ reserve?: { before: number; after: number } }>(c.detail_json, {}).reserve ?? { before: 0, after: 0 } } : null
}

/**
 * Remove a bill from a session the caller has checked may ask. A bill that is not counted in what must stay in the bank is
 * removed at once, as before. One that is counted frees money for QED's instructions when it goes, so, like every other
 * loosening, it needs a fresh passkey confirmation (checked here under the write lock) and then waits out the protection
 * delay: the bill stays, and its money stays kept, until the delay ends; any of the person's passkeys can cancel it
 * meanwhile (passkeys.ts cancelScheduledChange); the person, the members who may sign and the recovery contacts are told.
 * Asking again while one waits is the same request: it keeps its time.
 */
export function requestBillRemoval(db: Db, by: { personId: string; workspaceId: string; fresh: boolean; beforeLoosening?: () => void }, billId: string, now: number, remove: () => void): { removed: true } | { removed: false; waiting: BillRemoval; contactsTold: number } {
  const ws = by.workspaceId
  return db.tx(() => {
    const bill = db.get<{ state: string }>('SELECT state FROM bills WHERE id = ? AND user_id = ?', billId, ws)
    if (!bill || bill.state !== 'due') throw new AppError(409, 'bill_not_due', 'Only a bill that is still due can be removed.')
    const lower = billLowersReserve(db, ws, now, billId)
    if (!lower) { remove(); return { removed: true } }
    if (!by.fresh) throw new AppError(401, 'stepup_required', `Removing this bill lowers what must stay in your bank account by ${rupees(lower.before - lower.after)}. Confirm with your passkey to ask for it: the bill then stays for ${PROTECTION_DELAY_MS / 3600_000} hours, and any of your passkeys can cancel the removal meanwhile.`)
    by.beforeLoosening?.()
    const had = pendingBillRemoval(db, ws, billId)
    if (had) return { removed: false, waiting: had, contactsTold: 0 }
    const id = newId('chg', now), effectiveAt = now + PROTECTION_DELAY_MS
    db.run('INSERT INTO scheduled_changes (id, person_id, workspace_id, kind, subject, detail_json, requested_at, requested_by, effective_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, by.personId, ws, REMOVE_BILL, billId, j({ reserve: lower }), now, by.personId, effectiveAt)
    const detail = { workspaceId: ws, changeId: id, billId, effectiveAt, reserve: lower }
    const people = new Set([by.personId, ...(ws === by.personId ? [] : members(db, ws).filter((m) => SIGNING_ROLES.has(m.role)).map((m) => m.personId))])
    for (const person of people) securityEvent(db, person, 'bill-removal-scheduled', detail, now)
    const contacts = activeContacts(db, by.personId, now)
    for (const c of contacts) securityEvent(db, c, 'contact-loosening-scheduled', { for: handleOf(db, by.personId), effectiveAt }, now)
    return { removed: false, waiting: { id, billId, requestedAt: now, effectiveAt, reserve: lower }, contactsTold: contacts.length }
  })
}
