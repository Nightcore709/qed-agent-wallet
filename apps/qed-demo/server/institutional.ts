/**
 * The institutional reporting cycle for portfolios (R13, I3 and G8): a report for each workspace (client), what each holding
 * contributed, model portfolios offered to several workspaces, and the owner's signature before anything changes.
 *
 * WHAT THIS IS NOT. It is QED's own capability, built and described here, and not a regulated portfolio-management service.
 * QED holds no portfolio-manager, investment-adviser or fund-manager registration, runs no discretionary mandate, and does not
 * assess whether a model suits a client. A model is a set of target shares its owner chose; offering it to a workspace changes
 * nothing there. The workspace's own owner or admin accepts the offer, which makes a draft instruction; that workspace's
 * signers read and sign it with their passkeys (the usual approval, under that workspace's own signing policy) before anything
 * is put in force, and the instruction then asks before every run. No one but a workspace's own signers can trade in it.
 *
 * The cycle, as the report shows it: accounting (the books check themselves), reporting (this report), compliance (QED's own
 * watch levels and the model's drift), outcomes (gain, costs, price returns on recorded values). Every figure carries its
 * source; none is a forecast.
 */
import { AppError, audit, bad, type Config, type Db, j, newId, notFound, parse } from './core.ts'
import { storeProposal, draftProposals } from './ai.ts'
import { labBooks } from './lab.ts'
import { verifyLedger } from './ledger.ts'
import { notice } from './execute.ts'
import { instrument } from './registry.ts'
import { sha256hex } from './receipts.ts'
import type { Ctx } from './types.ts'
import { canAdminister, canSign, listWorkspaces, type Role } from './workspaces.ts'
import { inrExact } from '../shared/money.ts'
import { canonical } from '../shared/sha256.ts'

export const SCOPE_NOTE = 'QED\'s own reporting capability. Not a regulated portfolio-management service: QED holds no portfolio-manager, investment-adviser or fund-manager registration, runs no mandate on anyone\'s behalf and does not judge whether a model suits a client. Figures come from this workspace\'s own books and the values this app recorded; none is a forecast.'
const DAY = 86_400_000
/** QED's own watch levels, not a regulator's limits. */
export const WATCH = { largestHoldingShare: 0.4, modelBandBps: 500 }

export interface Who { personId: string; role: Role }
export interface ModelLeg { instrumentId: string; weightBps: number }
interface ModelRow { id: string; owner_ws: string; name: string; version: number; weights_json: string; basis_json: string; created_by: string; created_at: number; retired_at: number | null }
interface OfferRow { id: string; model_id: string; offered_by_ws: string; client_ws: string; offered_by: string; offered_at: number; state: string; decided_by: string | null; decided_at: number | null; program_id: string | null }

const nameOf = (db: Db, ws: string): string => db.get<{ display_name: string }>('SELECT display_name FROM users WHERE id = ?', ws)?.display_name ?? ws
const ws_ = (db: Db, code: unknown): { id: string; name: string } => {
  const h = typeof code === 'string' ? code.trim().toLowerCase() : ''
  const u = h ? db.get<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE handle = ?', h) : undefined
  if (!u) throw new AppError(404, 'not_found', `No workspace has the code ${h || '(empty)'}.`)
  return { id: u.id, name: u.display_name }
}

// ------------------------------------------------------------------------------------------------ models
/** Add a model (or a new version of one the workspace already has: the old version is kept as it was). Needs a member who may sign. */
export function createModel(db: Db, ws: string, by: Who, input: { name?: unknown; legs?: unknown }, now: number): NonNullable<ReturnType<typeof modelView>> {
  if (!canSign(by.role)) throw new AppError(403, 'not_permitted', 'Only a member who may sign can publish a model portfolio.')
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : ''
  if (name.length < 2) throw bad('Give the model a name.', { name: 'At least two characters.' })
  const legs = Array.isArray(input.legs) ? input.legs as Record<string, unknown>[] : []
  if (legs.length < 2 || legs.length > 6) throw bad('A model holds between two and six investments.', { legs: 'Two to six.' })
  const out: ModelLeg[] = legs.map((l) => ({ instrumentId: String(l.instrumentId ?? ''), weightBps: Number(l.weightBps) }))
  for (const l of out) {
    if (!instrument(db, l.instrumentId)) throw bad(`${l.instrumentId || 'An investment'} is not one this app lists.`, { legs: 'Unknown investment.' })
    if (!Number.isInteger(l.weightBps) || l.weightBps < 1 || l.weightBps > 9_999) throw bad('Each share must be between 0.01% and 99.99%.', { legs: 'Out of range.' })
  }
  if (new Set(out.map((l) => l.instrumentId)).size !== out.length) throw bad('Each investment appears once.', { legs: 'Repeated.' })
  if (out.reduce((s, l) => s + l.weightBps, 0) !== 10_000) throw bad('The shares must add up to 100%.', { legs: 'Not 100%.' })
  const version = (db.get<{ v: number | null }>('SELECT MAX(version) v FROM model_portfolios WHERE owner_ws = ? AND name = ?', ws, name)?.v ?? 0) + 1
  const id = newId('mdl', now)
  const basis = { chosenBy: 'the model\'s owner', note: 'Target shares the owner chose. QED did not choose them, does not assess whether they suit any client, and does not forecast their return.' }
  db.tx(() => {
    db.run('UPDATE model_portfolios SET retired_at = ? WHERE owner_ws = ? AND name = ? AND retired_at IS NULL', now, ws, name)
    db.run('INSERT INTO model_portfolios (id, owner_ws, name, version, weights_json, basis_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, ws, name, version, j(out), j(basis), by.personId, now)
    audit(db, now, ws, 'owner', 'model.publish', id, { name, version, legs: out, by: by.personId })
  })
  return modelView(db, ws, id)!
}

function modelView(db: Db, ws: string, id: string) {
  const m = db.get<ModelRow>('SELECT * FROM model_portfolios WHERE id = ? AND owner_ws = ?', id, ws)
  if (!m) return undefined
  return modelOut(db, m, true)
}
function modelOut(db: Db, m: ModelRow, withOffers: boolean) {
  const legs = parse<ModelLeg[]>(m.weights_json, [])
  return {
    id: m.id, name: m.name, version: m.version, createdAt: m.created_at, retired: m.retired_at !== null, owner: nameOf(db, m.owner_ws),
    legs: legs.map((l) => ({ ...l, name: instrument(db, l.instrumentId)?.name ?? l.instrumentId })), basis: parse<{ note: string }>(m.basis_json, { note: '' }).note,
    ...(withOffers ? { offers: db.all<OfferRow>('SELECT * FROM model_offers WHERE model_id = ? ORDER BY offered_at', m.id).map((o) => ({ id: o.id, client: nameOf(db, o.client_ws), state: o.state, decidedAt: o.decided_at })) } : {}),
  }
}

/** Offer a model to workspaces by code. Changes nothing in them: it appears on their desk for their owner or admin to accept or decline. */
export function offerModel(db: Db, ws: string, by: Who, modelId: string, codes: unknown, now: number): { offered: { client: string; offerId: string }[]; skipped: { code: string; why: string }[] } {
  if (!canSign(by.role)) throw new AppError(403, 'not_permitted', 'Only a member who may sign can offer a model.')
  const m = db.get<ModelRow>('SELECT * FROM model_portfolios WHERE id = ? AND owner_ws = ?', modelId, ws)
  if (!m) throw notFound('That model')
  if (m.retired_at !== null) throw new AppError(409, 'retired', 'That version was replaced by a newer one. Offer the newer one.')
  const list = Array.isArray(codes) ? codes.slice(0, 20) : []
  if (!list.length) throw bad('Name the workspaces to offer it to.', { codes: 'Give at least one code.' })
  const offered: { client: string; offerId: string }[] = [], skipped: { code: string; why: string }[] = []
  for (const code of list) {
    let c: { id: string; name: string }
    try { c = ws_(db, code) } catch (e) { skipped.push({ code: String(code), why: e instanceof Error ? e.message : 'Not found.' }); continue }
    if (c.id === ws) { skipped.push({ code: String(code), why: 'That is this workspace.' }); continue }
    if (db.get('SELECT 1 FROM model_offers WHERE model_id = ? AND client_ws = ?', modelId, c.id)) { skipped.push({ code: String(code), why: 'Already offered this version.' }); continue }
    const id = newId('mof', now)
    db.run(`INSERT INTO model_offers (id, model_id, offered_by_ws, client_ws, offered_by, offered_at, state) VALUES (?, ?, ?, ?, ?, ?, 'offered')`, id, modelId, ws, c.id, by.personId, now)
    notice(db, c.id, { level: 'info', kind: 'model.offered', title: `${nameOf(db, ws)} offered you a model portfolio`, body: `"${m.name}" (version ${m.version}). Nothing changes until your owner or an admin accepts it, and then you sign the instruction it makes.`, subject: id, dedupe: `model.offered:${id}` }, now)
    audit(db, now, ws, 'owner', 'model.offer', id, { model: modelId, client: c.id, by: by.personId })
    offered.push({ client: c.name, offerId: id })
  }
  return { offered, skipped }
}

/**
 * The client workspace's answer. Accepting makes a draft rebalance instruction in THIS workspace from the model's shares (the
 * same instruction the lab proposes), which this workspace's signers read and sign: until they do, nothing is in force and
 * nothing trades. Only an owner or admin of the client workspace can accept.
 */
export function answerOffer(ctx: Ctx, cfg: Pick<Config, 'adviserReview'>, ws: string, by: Who, offerId: string, accept: boolean, now: number): { state: string; programId: string | null } {
  const { db } = ctx
  const o = db.get<OfferRow>('SELECT * FROM model_offers WHERE id = ? AND client_ws = ?', offerId, ws)
  if (!o) throw notFound('That offer')
  if (!canAdminister(by.role)) throw new AppError(403, 'not_permitted', 'Only an owner or admin of this workspace can accept or decline a model.')
  if (o.state !== 'offered') throw new AppError(409, 'not_open', 'That offer was already answered.')
  const m = db.get<ModelRow>('SELECT * FROM model_portfolios WHERE id = ?', o.model_id)!
  if (!accept) {
    db.run(`UPDATE model_offers SET state = 'declined', decided_by = ?, decided_at = ? WHERE id = ?`, by.personId, now, offerId)
    audit(db, now, ws, 'owner', 'model.decline', offerId, { by: by.personId })
    return { state: 'declined', programId: null }
  }
  if (m.retired_at !== null) throw new AppError(409, 'retired', 'The owner has published a newer version since. Ask for the newer offer.')
  const live = db.all<{ title: string; state: string }>(`SELECT title, state FROM programs WHERE user_id = ? AND kind = 'rebalance' AND state IN ('active', 'paused', 'draft')`, ws)
  if (live.length) throw new AppError(409, 'has_rebalance', `This workspace already has an instruction keeping a mix in balance ("${live[0]!.title}", ${live[0]!.state}). Revoke or finish it first, so two do not pull against each other.`)
  const legs = parse<ModelLeg[]>(m.weights_json, [])
  const rationale = `Target shares set by ${nameOf(db, m.owner_ws)} in their model "${m.name}", version ${m.version}: ${legs.map((l) => `${(l.weightBps / 100).toFixed(2)}% ${instrument(db, l.instrumentId)?.name ?? l.instrumentId}`).join('; ')}. Traded back only when one drifts more than 5 percentage points from its share. QED did not choose these shares and does not judge whether they suit this workspace; nothing is a forecast. It asks before every run, and nothing trades until this workspace's signers sign it.`
  const p = storeProposal(ctx, ws, null, 'rules', 'rebalance', `Keep to ${nameOf(db, m.owner_ws)}'s model "${m.name}"`, rationale, { legs, bandBps: WATCH.modelBandBps, schedule: { type: 'daily', at: '11:00' } }, 'approve', now)
  if (p.state === 'invalid') throw new AppError(409, 'invalid_proposal', p.invalidReason ?? 'The model cannot be made into an instruction here.')
  const d = draftProposals(ctx, ws, [p.id], cfg)
  const first = d.drafted[0]
  if (!first) throw new AppError(409, 'not_drafted', d.skipped[0]?.reason ?? 'The model could not be opened as a draft.')
  db.run(`UPDATE model_offers SET state = 'accepted', decided_by = ?, decided_at = ?, program_id = ? WHERE id = ?`, by.personId, now, first.programId, offerId)
  audit(db, now, ws, 'owner', 'model.accept', offerId, { by: by.personId, programId: first.programId })
  return { state: 'accepted', programId: first.programId }
}

/** What a workspace sees on its desk: models it owns (with each offer's state), and offers made to it. */
export function modelsView(db: Db, ws: string) {
  const owned = db.all<ModelRow>('SELECT * FROM model_portfolios WHERE owner_ws = ? ORDER BY name, version DESC', ws).map((m) => modelOut(db, m, true))
  const received = db.all<OfferRow>('SELECT * FROM model_offers WHERE client_ws = ? ORDER BY offered_at DESC', ws).map((o) => {
    const m = db.get<ModelRow>('SELECT * FROM model_portfolios WHERE id = ?', o.model_id)!
    return { id: o.id, state: o.state, offeredAt: o.offered_at, from: nameOf(db, o.offered_by_ws), model: modelOut(db, m, false), programId: o.program_id, current: m.retired_at === null }
  })
  return { owned, received, scope: SCOPE_NOTE }
}

// ------------------------------------------------------------------------------------------------ the report
const inr = (paise: number): string => inrExact(paise)

/**
 * One workspace's report for a period: books, holdings, what each contributed, compliance checks and outcomes. Every number
 * says where it comes from. Attribution here is a breakdown of gain by holding on the books' cost basis (realised in the period
 * plus unrealised now), and the active weight against the model the workspace accepted, if any. It is not a time-weighted
 * return and does not claim to follow a performance-measurement standard.
 */
export function clientReport(ctx: Ctx, ws: string, days: number, now: number) {
  const { db } = ctx
  const from = now - days * DAY
  const { books, holdings } = labBooks(ctx, ws, now)
  const total = holdings.reduce((s, h) => s + (h.value ?? 0), 0)
  const realised = db.all<{ instrument_id: string; proceeds: number; cost: number }>('SELECT instrument_id, proceeds, cost FROM realised WHERE user_id = ? AND ts >= ? AND ts <= ?', ws, from, now)
  const realisedBy = new Map<string, number>()
  for (const r of realised) realisedBy.set(r.instrument_id, (realisedBy.get(r.instrument_id) ?? 0) + r.proceeds - r.cost)
  // each expense account on its own: a sum over the ledger names the one account it adds (test-tokens.test.ts)
  const spent = (code: string): number => Number(db.get<{ s: string | null }>(`SELECT COALESCE(amount_sum(p.amount_text), '0') s FROM postings p JOIN accounts a ON a.id = p.account_id JOIN entries e ON e.id = p.entry_id WHERE a.user_id = ? AND a.code = ? AND e.ts >= ? AND e.ts <= ?`, ws, code, from, now)?.s ?? 0)
  const fees = spent('exp:fees') + spent('exp:stamp')
  const price = (id: string): number | null => {
    const a = db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date <= ? ORDER BY value_date DESC LIMIT 1', id, new Date(from).toISOString().slice(0, 10))
    const b = db.get<{ value: string }>('SELECT value FROM daily_values WHERE instrument_id = ? AND value_date <= ? ORDER BY value_date DESC LIMIT 1', id, new Date(now).toISOString().slice(0, 10))
    return a && b && Number(a.value) > 0 ? Number(b.value) / Number(a.value) - 1 : null
  }
  const gains = holdings.map((h) => ({ h, realised: realisedBy.get(h.instrumentId) ?? 0, unrealised: h.gain ?? 0 }))
  const gainTotal = gains.reduce((s, g) => s + g.realised + g.unrealised, 0)
  // the model this workspace accepted and has not since replaced, for the active weights
  const accepted = db.get<{ model_id: string }>(`SELECT model_id FROM model_offers WHERE client_ws = ? AND state = 'accepted' ORDER BY decided_at DESC LIMIT 1`, ws)
  const model = accepted ? db.get<ModelRow>('SELECT * FROM model_portfolios WHERE id = ?', accepted.model_id) : undefined
  const target = new Map((model ? parse<ModelLeg[]>(model.weights_json, []) : []).map((l) => [l.instrumentId, l.weightBps / 10_000]))
  const growth = holdings.filter((h) => h.growth && h.value !== null && h.value > 0)
  const growthTotal = growth.reduce((s, h) => s + h.value!, 0)
  const weightOf = (id: string): number => (growthTotal > 0 ? (growth.find((h) => h.instrumentId === id)?.value ?? 0) / growthTotal : 0)
  const active = model ? [...new Set([...target.keys(), ...growth.map((h) => h.instrumentId)])].map((id) => ({ instrumentId: id, name: instrument(db, id)?.name ?? id, weightBps: Math.round(weightOf(id) * 10_000), targetBps: Math.round((target.get(id) ?? 0) * 10_000), activeBps: Math.round((weightOf(id) - (target.get(id) ?? 0)) * 10_000) })) : []
  const breaks = verifyLedger(db, ws)
  const largest = growth.length ? growth.reduce((a, h) => (h.value! > a.value! ? h : a)) : null
  const programs = db.all<{ state: string; n: number }>('SELECT state, COUNT(*) n FROM programs WHERE user_id = ? GROUP BY state', ws)
  const maxActive = active.length ? Math.max(...active.map((a) => Math.abs(a.activeBps))) : null
  const checks: { id: string; ok: boolean | null; text: string; basis: string }[] = [
    { id: 'books', ok: breaks.length === 0, text: breaks.length === 0 ? 'The books check themselves: every entry balances, balances equal their postings, nothing is below zero, lots equal holdings.' : `The books have ${breaks.length} break${breaks.length === 1 ? '' : 's'}: ${breaks[0]!.check}.`, basis: 'books (verifyLedger)' },
    { id: 'concentration', ok: largest ? largest.value! / growthTotal <= WATCH.largestHoldingShare : null, text: largest ? `Largest holding that can grow: ${largest.name}, ${((largest.value! / growthTotal) * 100).toFixed(1)}% (QED's own watch level ${WATCH.largestHoldingShare * 100}%, not a regulatory limit).` : 'Nothing that can grow is held.', basis: 'books and recorded prices' },
    { id: 'prices', ok: holdings.every((h) => !h.stale), text: holdings.some((h) => h.stale) ? `Prices out of date for ${holdings.filter((h) => h.stale).map((h) => h.name).join(', ')}.` : 'Every holding has a current price.', basis: 'recorded prices' },
    { id: 'model', ok: maxActive === null ? null : maxActive <= WATCH.modelBandBps, text: maxActive === null ? 'No model has been accepted by this workspace.' : `Largest active weight against the accepted model "${model!.name}" (v${model!.version}): ${(maxActive / 100).toFixed(1)} points (band ${WATCH.modelBandBps / 100} points).`, basis: 'books and the accepted model' },
    { id: 'signing', ok: null, text: `Instructions in this workspace: ${programs.map((p) => `${p.n} ${p.state}`).join(', ') || 'none'}. Each was, or must be, signed by this workspace's own signers; none acts without asking.`, basis: 'instructions' },
  ]
  const body = {
    workspace: { id: ws, name: nameOf(db, ws) }, period: { from, to: now, days }, asOf: now, scope: SCOPE_NOTE,
    accounting: { ok: breaks.length === 0, breaks: breaks.length, note: 'Books: double-entry ledger, append-only; value as this app priced each holding.' },
    holdings: holdings.map((h) => ({ instrumentId: h.instrumentId, name: h.name, value: h.value, cost: h.cost, gain: h.gain, shareBps: total > 0 && h.value !== null ? Math.round((h.value / total) * 10_000) : null, priceReturn: price(h.instrumentId), stale: h.stale })),
    totals: { value: total, bank: books.bank, netWorth: books.netWorth },
    attribution: {
      method: 'Gain by holding on the books\' cost basis: realised in the period plus unrealised now. Not a time-weighted return.',
      rows: gains.map((g) => ({ instrumentId: g.h.instrumentId, name: g.h.name, realised: g.realised, unrealised: g.unrealised, total: g.realised + g.unrealised, shareOfGainBps: gainTotal !== 0 ? Math.round(((g.realised + g.unrealised) / gainTotal) * 10_000) : null })),
      gain: gainTotal, costs: Math.abs(fees), costsNote: 'Fees and stamp duty booked in the period.', model: model ? { name: model.name, version: model.version, owner: nameOf(db, model.owner_ws), active } : null,
    },
    compliance: checks,
    outcomes: { realisedInPeriod: gains.reduce((s, g) => s + g.realised, 0), unrealisedNow: gains.reduce((s, g) => s + g.unrealised, 0), costs: Math.abs(fees), summary: `${inr(gainTotal)} of gain on cost (${inr(gains.reduce((s, g) => s + g.realised, 0))} realised in the last ${days} days, ${inr(gains.reduce((s, g) => s + g.unrealised, 0))} unrealised), after ${inr(Math.abs(fees))} of fees and stamp duty in the period.` },
  }
  return { ...body, fingerprint: sha256hex(canonical(body)) }
}

/** The report of every workspace the person belongs to: one row per client. */
export function reportsAcross(ctx: Ctx, personId: string, days: number, now: number) {
  return listWorkspaces(ctx.db, personId).map((w) => {
    try {
      const r = clientReport(ctx, w.id, days, now)
      return { id: w.id, name: w.name, kind: w.kind, role: w.role, ok: true as const, value: r.totals.value, gain: r.attribution.gain, costs: r.outcomes.costs, flags: r.compliance.filter((c) => c.ok === false).map((c) => c.id), fingerprint: r.fingerprint }
    } catch (e) {
      return { id: w.id, name: w.name, kind: w.kind, role: w.role, ok: false as const, why: e instanceof Error ? e.message : 'The report could not be made.' }
    }
  })
}
