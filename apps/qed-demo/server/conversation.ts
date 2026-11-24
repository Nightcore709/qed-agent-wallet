/**
 * Ask as a conversation (R7-092), and what QED's own code checks around every model reply.
 *
 *   Conversations  each question joins a conversation owned by one person acting in one workspace. Later turns carry
 *                  the earlier ones to the model, so a follow-up, a correction ("make it ₹3,000 instead") or "the
 *                  second one" is understood. A correction supersedes the earlier proposal; nothing is edited silently.
 *   Cancellation   "cancel", "never mind", "forget it" and the like withdraw the conversation's open proposals in QED's
 *                  own code, with no model call.
 *   Tokens         payees reach the model only as stable tokens ("payee-3fa9c1" for the address, "Payee 3fa9c1" for the
 *                  name), never their names or addresses (N-005). A token in what comes back is mapped to exactly that
 *                  payee, or left as it is and refused by validation.
 *   Grounding      every rupee figure in a reply is looked for, at the precision it was written, in the records the
 *                  model was given, the owner's own words in this conversation and the figures QED computed for its
 *                  proposals. A figure not found is shown as such. Percentages and other numbers are not checked.
 *   Records        the reply names the records it rests on (paths into the snapshot); QED resolves each to its value.
 *   Links          where to act, from a fixed list of the interface's own pages.
 */
import { createHash } from 'node:crypto'
import { AppError, type Db, newId, parse } from './core.ts'
import { amountText } from './programs.ts'

// ---------------------------------------------------------------------------------------------- payee tokens

export interface Tokens {
  /** Replace payee names and addresses in free text with their tokens. */
  redact(text: string): string
  /** Every string in a value: an address becomes its token, other text is redacted. */
  redactDeep<T>(v: T): T
  /** Tokens in text written for the owner become the payee's name. */
  restore(text: string): string
  /** Address tokens in instruction parameters become the real address; nothing else changes. */
  restoreParams<T>(v: T): T
  payees: { payee: string; category: string }[]
}

const tokenOf = (payeeId: string): string => createHash('sha256').update(`qed/payee-token/v1\n${payeeId}`).digest('hex').slice(0, 6)
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The text as a whole word: not inside a longer name, address or number. */
/** A name as a whole word, as payee names are matched for redaction (exported for the vault's book, server/ai.ts). */
export const wordRe = (s: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}@._-])${escapeRe(s)}(?![\\p{L}\\p{N}@_-]|\\.[\\p{L}\\p{N}])`, 'giu')

export function tokensFor(db: Db, userId: string): Tokens {
  const list = db.all<{ id: string; name: string; handle: string; category: string }>('SELECT id, name, handle, category FROM payees WHERE user_id = ? ORDER BY created_at, id', userId)
    .map((p) => { const t = tokenOf(p.id); return { ...p, handleToken: `payee-${t}`, nameToken: `Payee ${t}` } })
  // Longest first, so "Ramesh Kumar" is replaced before "Ramesh" could be.
  const swaps = list.flatMap((p) => [{ re: wordRe(p.handle), to: p.handleToken, len: p.handle.length }, ...(p.name.trim().length >= 2 ? [{ re: wordRe(p.name.trim()), to: p.nameToken, len: p.name.trim().length }] : [])])
    .sort((a, b) => b.len - a.len)
  const byToken = new Map(list.map((p) => [p.handleToken, p]))
  const byHandle = new Map(list.map((p) => [p.handle.toLowerCase(), p]))
  const redact = (text: string): string => swaps.reduce((t, s) => t.replace(s.re, s.to), text)
  const redactDeep = <T>(v: T): T => {
    if (typeof v === 'string') { const p = byHandle.get(v.toLowerCase()); return (p ? p.handleToken : redact(v)) as T }
    if (Array.isArray(v)) return v.map(redactDeep) as T
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T
    return v
  }
  const restore = (text: string): string => text.replace(/\b[Pp]ayee[ -]([0-9a-f]{6})\b/g, (m, t: string) => byToken.get(`payee-${t}`)?.name ?? m)
  const restoreParams = <T>(v: T): T => {
    if (typeof v === 'string') return (byToken.get(v)?.handle ?? v) as T
    if (Array.isArray(v)) return v.map(restoreParams) as T
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, restoreParams(x)])) as T
    return v
  }
  return { redact, redactDeep, restore, restoreParams, payees: list.map((p) => ({ payee: p.handleToken, category: p.category })) }
}

// ---------------------------------------------------------------------------------------------- cancellation

/**
 * A message that is only a cancellation. Bare "stop" and bare "no" are left to the model: "stop" may mean "Stop
 * everything", and "no" may answer a question the reply asked.
 */
const CANCEL = /^(?:(?:no[,.!]?\s+)?(?:please\s+)?(?:cancel|withdraw|drop|scrap|discard|undo)(?:\s+(?:it|that|this|them|those|these|both|all(?:\s+of\s+(?:it|them))?|everything|the\s+(?:last\s+one|proposals?|suggestions?|lot)))?(?:\s+please)?|never\s*mind|forget\s+(?:it|that|them|everything|about\s+(?:it|that|them))|no[,.!]?\s+(?:thanks|thank\s+you)|(?:i\s+)?(?:don'?t|do\s+not)\s+(?:want|do)\s+(?:it|that|this|them|any\s+of\s+(?:it|them|this|that)))[.!]*$/i
export const isCancellation = (q: string): boolean => CANCEL.test(q.trim().replace(/\s+/g, ' '))

// ---------------------------------------------------------------------------------------------- grounding

export interface Written { text: string; paise: number; step: number }
// L, lakh and lac are 1,00,000; Cr and crore 1,00,00,000 (C4: "1.5L" is how many people write ₹1,50,000).
const unitOf = (u?: string): number => (!u ? 1 : /^cr/i.test(u) ? 1e7 : /^l/i.test(u) ? 1e5 : /^k$/i.test(u) ? 1e3 : 1)
/** Rupee amounts written in text, each with the precision it was written to (₹1.5 lakh is to the nearest ₹10,000). */
export function writtenRupees(text: string): Written[] {
  const out: (Written & { at: number; end: number })[] = []
  const take = (re: RegExp): void => {
    for (const m of text.matchAll(re)) {
      const at = m.index!, end = at + m[0].length
      if (out.some((o) => at < o.end && end > o.at)) continue
      const num = m[1]!.replace(/,/g, ''), dec = (num.split('.')[1] ?? '').length, unit = unitOf(m[2])
      const paise = Math.round(Number(num) * unit * 100), step = Math.max(1, Math.round(10 ** -dec * unit * 100))
      if (Number.isFinite(paise) && paise > 0) out.push({ text: m[0].trim(), paise, step, at, end })
    }
  }
  take(/(?:₹|\bRs\.?|\bINR)\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(lakhs?|lacs?|crores?|cr|l|k)\b)?/gi)
  take(/\b(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|l)?\s*rupees?\b/gi)
  take(/\b(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr|l)\b/gi)
  return out.sort((a, b) => a.at - b.at).map(({ text: t, paise, step }) => ({ text: t, paise, step }))
}

/** Every number in a value, scaled (rupees to paise is 100). */
export function numbersIn(v: unknown, scale: number, out: number[] = []): number[] {
  if (typeof v === 'number' && Number.isFinite(v)) out.push(Math.round(v * scale))
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, scale, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, scale, out)
  return out
}

export interface Grounding { checked: number; ungrounded: { text: string; paise: number }[] }
/**
 * Which rupee figures in the text are found among the known values. A figure matches a value within half the step it
 * was written to, and never more than 5% of the figure: "₹2 lakh" is not a fair way to write ₹1,51,000.
 */
export function groundingOf(text: string, known: Iterable<number>): Grounding {
  const values = [...new Set(known)].map((v) => Math.abs(v))
  const figures = writtenRupees(text)
  const ungrounded = figures.filter((f) => { const tol = Math.max(0.5, Math.min(f.step / 2, f.paise * 0.05)); return !values.some((v) => Math.abs(v - f.paise) <= tol) })
  return { checked: figures.length, ungrounded: ungrounded.map(({ text: t, paise }) => ({ text: t, paise })) }
}

// ---------------------------------------------------------------------------------------------- records cited

export interface Cite { path: string; label: string; value: string }
const LABELS: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^position\.bank$/, 'Bank balance'], [/^position\.fixedDeposit$/, 'Fixed deposits'], [/^position\.holdingsValue$/, 'Value of holdings'],
  [/^position\.bankReserve\.mustStayForWhatIsDue$/, 'Must stay in the bank for what is due'], [/^position\.bankReserve\.freeBeyondThat$/, 'Free in the bank beyond that'],
  [/^position\.bankReserve\.shortBy$/, 'Short of what is due by'], [/^position\.creditCardOwed$/, 'Credit card owed'], [/^position\.personalLoanOwed$/, 'Personal loan owed'],
  [/^position\.homeLoanOwed$/, 'Home loan owed'], [/^position\.worstCase$/, 'Worst case'], [/^position\.floor$/, 'Your floor'], [/^position\.cushionAboveFloor$/, 'Cushion above your floor'],
  [/^profile\.monthlyIncome$/, 'Monthly income, as recorded'], [/^profile\.monthlyEverydaySpending$/, 'Everyday spending a month, as recorded'],
  [/^profile\.personalLoanInstalment$/, 'Personal loan instalment'], [/^profile\.homeLoanInstalment$/, 'Home loan instalment'],
  [/^cashFlow\.monthlySpareAfterOutflowsAndInstalments$/, 'Spare each month after outflows and instalments'],
  [/^dueInNext30Days\[\d+\]/, 'Due in the next 30 days'], [/^holdings\[\d+\]/, 'Holding'], [/^instruments\[\d+\]/, 'Instrument'],
  [/^programs\[\d+\]/, 'Standing instruction'], [/^cashFlow\.countedMonthlyOutflows\[\d+\]/, 'Counted monthly outflow'], [/^rates\./, 'Rate'],
]
/** Numbers in the snapshot that are not rupee amounts (rates are under 'rates.' and are shown as written). */
const NOT_RUPEES = new Set(['quantity', 'priceAgeSeconds', 'incomeLateDays', 'salariesLost', 'limitUsedForWorstCase', 'count'])

function walk(data: unknown, path: string): { ok: boolean; value: unknown; last: string } {
  const parts = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!)
  let cur: unknown = data
  for (const p of parts) {
    // Own properties only (X11): "constructor", "toString" or "__proto__" are not records of the snapshot.
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return { ok: false, value: undefined, last: p }
    cur = (cur as Record<string, unknown>)[p]
  }
  return { ok: parts.length > 0, value: cur, last: parts.at(-1) ?? '' }
}

/** Resolve the paths a reply cited into the snapshot it was given, for display with their values. */
export function resolveCites(data: Record<string, unknown>, paths: string[], restore: (s: string) => string): { cites: Cite[]; unresolved: string[] } {
  const cites: Cite[] = [], unresolved: string[] = []
  for (const path of [...new Set(paths)].slice(0, 8)) {
    const w = walk(data, path)
    if (!w.ok || w.value === undefined || w.value === null) { unresolved.push(path); continue }
    const label = LABELS.find(([re]) => re.test(path))
    const v = w.value
    // Only what JSON can carry is a record; anything else is unresolved, never shown (X11).
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') { unresolved.push(path); continue }
    let value: string
    if (typeof v === 'number') value = NOT_RUPEES.has(w.last) || path.startsWith('rates.') ? String(v) : amountText(Math.round(v * 100))
    else if (typeof v === 'string') value = restore(v)
    else if (Array.isArray(v)) value = `${v.length} entries`
    else {
      const o = v as Record<string, unknown>
      if (typeof o.what === 'string' && typeof o.rupees === 'number') value = `${restore(o.what)}: ${amountText(Math.round(o.rupees * 100))}${typeof o.due === 'string' ? `, due ${o.due.slice(0, 10)}` : ''}`
      else if (typeof o.name === 'string' && typeof o.value === 'number') value = `${o.name}: ${amountText(Math.round(o.value * 100))}`
      else if (typeof o.name === 'string' && typeof o.price === 'number') value = `${o.name}: price ${amountText(Math.round(o.price * 100))}`
      else if (typeof o.title === 'string') value = restore(o.title)
      else { const text = JSON.stringify(o); if (typeof text !== 'string') { unresolved.push(path); continue } value = restore(text).slice(0, 140) }
    }
    cites.push({ path, label: label ? (typeof label[1] === 'string' ? label[1] : label[1](label[0].exec(path)!)) : path, value })
  }
  return { cites, unresolved }
}

// ---------------------------------------------------------------------------------------------- where to act

export const LINKS = {
  'new-instruction': { to: '/instructions/new', label: 'Write a standing instruction' },
  instructions: { to: '/instructions', label: 'Your standing instructions' },
  pay: { to: '/pay', label: 'Pay someone' },
  holdings: { to: '/holdings', label: 'Holdings' },
  earn: { to: '/earn', label: 'Earn' },
  passbook: { to: '/', label: 'Passbook' },
  activity: { to: '/activity', label: 'What QED did' },
  safeguards: { to: '/safeguards', label: 'Your floor and reserve' },
  security: { to: '/security', label: 'Security' },
  workspace: { to: '/workspace', label: 'Workspace and approvals' },
} as const
export type LinkId = keyof typeof LINKS
export const LINK_IDS = Object.keys(LINKS) as [LinkId, ...LinkId[]]
export const linksOf = (ids: readonly string[]): { to: string; label: string }[] => [...new Set(ids)].filter((id): id is LinkId => id in LINKS).slice(0, 3).map((id) => ({ ...LINKS[id] }))

// ---------------------------------------------------------------------------------------------- conversations

export interface ConversationRow { id: string; user_id: string; person_id: string; title: string; created_at: number; updated_at: number }

/** A conversation of this person in this workspace; anyone else's is not found. */
export function loadConversation(db: Db, userId: string, personId: string, id: unknown): ConversationRow {
  const c = typeof id === 'string' ? db.get<ConversationRow>('SELECT * FROM conversations WHERE id = ? AND user_id = ? AND person_id = ?', id, userId, personId) : undefined
  if (!c) throw new AppError(404, 'not_found', 'That conversation was not found.')
  return c
}

export function createConversation(db: Db, userId: string, personId: string, question: string, now: number): string {
  const id = newId('cnv', now)
  const title = question.replace(/\s+/g, ' ').trim().slice(0, 80)
  db.run('INSERT INTO conversations (id, user_id, person_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, userId, personId, title, now, now)
  return id
}

/** Proposals of this conversation that a later turn may correct or withdraw, each titled as its card shows it (QED's own title). */
export function openProposals(db: Db, conversationId: string): Map<string, { id: string; title: string; state: string; kind: string }> {
  return new Map(db.all<{ id: string; title: string; state: string; kind: string }>(`SELECT id, COALESCE(json_extract(analysis_json, '$.title'), title) title, state, kind FROM proposals WHERE conversation_id = ? AND state IN ('new', 'invalid', 'drafted') ORDER BY ts, rowid`, conversationId).map((p) => [p.id, p]))
}

/** The owner's own rupee figures in every earlier question of the conversation (paise). */
export function earlierQuestions(db: Db, conversationId: string): string[] {
  return db.all<{ question: string }>('SELECT question FROM conversation_turns WHERE conversation_id = ? ORDER BY ts, rowid', conversationId).map((t) => t.question)
}

/**
 * The earlier turns as the model saw them: each question exactly as it was sent and each reply exactly as the model
 * returned it, both already in tokens, so nothing here depends on this turn being able to turn labels into tokens; each
 * proposal with its id and state, newest six. When the wallet's book cannot be read this turn (`walletTerms` false), a
 * wallet proposal goes without its terms, since its stored terms carry the book's labels (claims review F6: nothing
 * sent to a model names a payee, N-005).
 */
export function historyFor(db: Db, conversationId: string, tokens: Tokens, limit = 6, walletTerms = true): unknown[] {
  const turns = db.all<{ id: string; question: string; answer: string | null; refusal: string | null; kind: string; ai_call_id: string | null }>('SELECT id, question, answer, refusal, kind, ai_call_id FROM conversation_turns WHERE conversation_id = ? AND kind != \'guard\' ORDER BY ts DESC, rowid DESC LIMIT ?', conversationId, limit).reverse()
  return turns.map((t, i) => {
    const call = t.ai_call_id ? db.get<{ sent_json: string | null; output_json: string | null }>('SELECT sent_json, output_json FROM ai_calls WHERE id = ?', t.ai_call_id) : undefined
    const asSent = parse<{ question?: string }>(call?.sent_json ?? null, {}).question
    const returned = parse<{ answer?: string }>(call?.output_json ?? null, {}).answer
    const props = db.all<{ id: string; kind: string; title: string; state: string; params_json: string }>('SELECT id, kind, title, state, params_json FROM proposals WHERE turn_id = ? ORDER BY ts, rowid', t.id)
    const unsure = !walletTerms && (props.some((p) => p.kind.startsWith('wallet-')) || asSent === undefined)
    return {
      turn: i + 1,
      owner: (typeof asSent === 'string' ? asSent : unsure ? '(a question not repeated while the wallet\'s book cannot be read)' : tokens.redact(t.question)).slice(0, 600),
      reply: (typeof returned === 'string' ? returned : unsure ? '(a reply not repeated while the wallet\'s book cannot be read)' : tokens.redact(t.answer ?? t.refusal ?? '')).slice(0, 900),
      ...(t.kind === 'cancel' ? { handledBy: 'QED withdrew the open proposals; no model was asked' } : {}),
      proposals: props.map((p) => {
        if (!walletTerms && p.kind.startsWith('wallet-')) return { id: p.id, kind: p.kind, state: p.state }
        const pj = parse<{ params?: unknown; authority?: unknown }>(p.params_json, {})
        return { id: p.id, kind: p.kind, title: tokens.redact(p.title), state: p.state, params: tokens.redactDeep(pj.params ?? {}), limits: pj.authority ?? null }
      }),
    }
  })
}

export function listConversations(db: Db, userId: string, personId: string): { id: string; title: string; createdAt: number; updatedAt: number; turns: number }[] {
  return db.all<ConversationRow & { turns: number }>(`SELECT c.*, (SELECT COUNT(*) FROM conversation_turns t WHERE t.conversation_id = c.id) turns FROM conversations c WHERE c.user_id = ? AND c.person_id = ? ORDER BY c.updated_at DESC LIMIT 30`, userId, personId)
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, turns: c.turns }))
}
