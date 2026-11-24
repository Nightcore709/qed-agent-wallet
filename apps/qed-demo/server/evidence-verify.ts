/**
 * The evidence case format, its hashes, and its verification. Pure: no database, no service. Used by the API that
 * assembles cases (server/evidence.ts), by scripts/verify-evidence.ts, and by the judge journey.
 *
 * The verifier re-implements every definition it checks rather than importing the server's code, so that it does not
 * trust what it verifies: the receipt chain (server/receipts.ts), the approval challenge a passkey signs
 * (server/passkeys.ts approvalChallenge), the vault's terms hash (chain/terms.ts hashTerms) and its decision-record
 * chain (chain/rail/store.ts). server/evidence-verify.test.ts pins each re-implementation to the original.
 *
 * Offline it checks: every section's hash and the root; the receipt chain's links and the bodies it carries; each
 * vault decision record's hash; each signed document's hash and terms hash; each passkey signature (ES256) against
 * the recorded public key and the exact challenge it had to sign; the order of steps; and that the figures agree
 * across sections (what moved, the transactions' events, balances before and after, the ledger's postings, the
 * checks and the refusals). With an RPC endpoint, verifyOnChain re-reads every transaction receipt from the chain.
 *
 * What it cannot catch: a forger who rewrites a case and recomputes every hash produces a case that is consistent in
 * itself. Only an external anchor catches that: the chain (--rpc) for transactions, or a root or receipt-chain head
 * obtained independently (verify-evidence.ts --root, --head).
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { canonical } from '../shared/sha256.ts'

export const CASE_FORMAT = 'qed-evidence-case/v1'
export const SECTION_TITLES = {
  1: 'The owner\'s objective and the bounded authority granted earlier',
  2: 'What the model selected, and what it was given',
  3: 'The independent enforcement decision',
  4: 'Standing authority: what ran without a fresh owner signature',
  5: 'Balances, costs and consequence',
  6: 'Technical record',
  7: 'Changed inputs and the decisions they produced',
  8: 'Refusals that prevented execution',
} as const
export type SectionKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8'
export const SECTION_KEYS: SectionKey[] = ['1', '2', '3', '4', '5', '6', '7', '8']

type Json = Record<string, unknown>
export interface EvidenceCase {
  format: typeof CASE_FORMAT
  id: string
  kind: 'vault-job' | 'standing-run' | 'model-call'
  title: string
  outcome: string
  venue: 'local-chain' | 'ephemeral-chain' | 'paper' | 'none'
  workspace: string
  assembledAt: string
  sections: Record<SectionKey, Json>
  verification: Json
  redactions: { what: string; how: string; why: string }[]
  cannotProve: string[]
  hashes: { algorithm: string; sections: Record<SectionKey, string>; verification: string; redactions: string; cannotProve: string; root: string }
}
export type UnsealedCase = Omit<EvidenceCase, 'hashes'>

// ------------------------------------------------------------------------------------------------ the shapes checked
// The parts of a section the verifier reads. Everything else in a section is for people and is covered by its hash.

export interface CheckEntry { by: string; name: string; pass: boolean; detail: string; transient?: boolean; source?: { receipt?: string; step?: number; decision?: number } }
export interface StepEntry { seq: number; key: string; label: string; status: string; detail: string; at: string; data?: Json }
export interface DecisionEntry { n: number; at: string; kind: string; jobId: string | null; verdict: string; clock: unknown; approval: unknown; termsHash: string | null; record: unknown; evidenceHash: string | null; prevHash: string; hash: string }
export interface MovedEntry { what: string; asset: string; decimals: number; amount: string; from?: string; to?: string; text: string; evidence?: { tx?: string; event?: string; arg?: string; index?: number; entries?: number[] } }
export interface BalanceEntry { account: string; asset: string; decimals: number; before: string; after: string; delta: string; source: string }
export interface EntryLine { account: string; asset: string; amount: string }
export interface LedgerEntryView { seq: number; ref: string; kind: string; memo: string; lines: EntryLine[] }
export interface TxEntry { hash: string; chain: 'vault' | 'ephemeral'; status: string; block: string; gasUsed: string; from: string | null; to: string | null; events: { name: string; address?: string; args?: Json }[] }
export interface SignatureEntry { type: 'webauthn-es256'; credential: string; publicKey: { x: string; y: string }; challenge: string; challengeIs: string; authenticatorData: string; clientDataJSON: string; signature: string; rpId: string }
export interface AuthorityInstrument { kind: string; id: string; document?: { text: string; sha256: string }; terms?: unknown; termsHash?: string; approval?: { id: string; docHash: string } | null; signatures?: SignatureEntry[] }
export interface ChainEntry { seq: number; id: string; kind: string; subject: string; ts: number; prevHash: string; hash: string; body?: unknown }

export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
/** SHA-256 of the canonical JSON (sorted keys; shared/sha256.ts), so the interface can recompute it in the browser. */
export const partHash = (v: unknown): string => sha256hex(canonical(v))
const HASHING = 'SHA-256 of the canonical JSON of each part (keys sorted, no spaces: shared/sha256.ts canonical); the root covers the envelope and every part\'s hash'

function partsOf(c: UnsealedCase): Omit<EvidenceCase['hashes'], 'root' | 'algorithm'> {
  return {
    sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, partHash(c.sections[k])])) as Record<SectionKey, string>,
    verification: partHash(c.verification), redactions: partHash(c.redactions), cannotProve: partHash(c.cannotProve),
  }
}
function rootOf(c: UnsealedCase, parts: Omit<EvidenceCase['hashes'], 'root' | 'algorithm'>): string {
  return partHash({ format: c.format, id: c.id, kind: c.kind, title: c.title, outcome: c.outcome, venue: c.venue, workspace: c.workspace, assembledAt: c.assembledAt, ...parts })
}
/** Adds the hashes: one per section, one per other part, and the root. */
export function sealCase(c: UnsealedCase): EvidenceCase {
  const { hashes: _drop, ...rest } = c as EvidenceCase
  const parts = partsOf(rest)
  return { ...rest, hashes: { algorithm: HASHING, ...parts, root: rootOf(rest, parts) } }
}

// ------------------------------------------------------------------------------------------------ re-implemented definitions

/** server/receipts.ts genesis and receiptHash. */
export const receiptGenesis = (workspace: string): string => sha256hex(`qed-receipts-v1:${workspace}`)
export const receiptHashOf = (prev: string, body: unknown): string => sha256hex(`${prev}\n${canonical(body)}`)
/** server/passkeys.ts approvalChallenge: what a passkey signs to approve one exact document. */
export const approvalChallengeHex = (approvalId: string, docHash: string): string => sha256hex(`qed/approval/v1\n${approvalId}\n${docHash}`)
/** chain/terms.ts hashTerms (its canonicalTerms equals shared canonical for JSON data). */
export const termsHashOf = (terms: unknown): string => `sha256:${partHash(terms)}`
/** chain/rail/store.ts: each decision record's hash covers the previous one and its own canonical body. */
export const decisionHashOf = (d: DecisionEntry): string =>
  sha256hex(`${d.prevHash}\n${canonical({ at: d.at, kind: d.kind, jobId: d.jobId, verdict: d.verdict, clock: d.clock ?? null, approval: d.approval ?? null, termsHash: d.termsHash ?? null, record: d.record, evidenceHash: d.evidenceHash ?? null })}`)

const b64u = (s: string): Buffer => Buffer.from(s, 'base64url')
const hexOrB64u = (s: string): Buffer => (/^0x[0-9a-fA-F]*$/.test(s) ? Buffer.from(s.slice(2), 'hex') : b64u(s))
const hex32 = (s: string): string => s.replace(/^0x/, '').toLowerCase().padStart(64, '0')

/** One WebAuthn ES256 assertion: the signature over authenticatorData ‖ SHA-256(clientDataJSON) under the public key, the challenge, the relying party, and user verification. */
export function verifyAssertion(s: SignatureEntry): string | null {
  let client: { type?: string; challenge?: string; origin?: string }
  try { client = JSON.parse(s.clientDataJSON) as typeof client } catch { return 'its clientDataJSON is not JSON' }
  if (client.type !== 'webauthn.get') return `its clientDataJSON type is ${String(client.type)}, not webauthn.get`
  const challenge = b64u(String(client.challenge ?? '')).toString('hex')
  if (challenge !== s.challenge.replace(/^0x/, '').toLowerCase()) return `it signed the challenge ${challenge.slice(0, 16)}…, not ${s.challenge.replace(/^0x/, '').slice(0, 16)}… (${s.challengeIs})`
  const auth = hexOrB64u(s.authenticatorData)
  if (auth.length < 37) return 'its authenticatorData is too short'
  if (auth.subarray(0, 32).toString('hex') !== sha256hex(s.rpId)) return `its authenticatorData is for another relying party than ${s.rpId}`
  if ((auth[32]! & 0x05) !== 0x05) return 'its authenticatorData does not show user presence and verification'
  let key
  try { key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(hex32(s.publicKey.x), 'hex').toString('base64url'), y: Buffer.from(hex32(s.publicKey.y), 'hex').toString('base64url') }, format: 'jwk' }) } catch { return 'its public key is not a P-256 point' }
  const sig = hexOrB64u(s.signature)
  const data = Buffer.concat([auth, createHash('sha256').update(s.clientDataJSON, 'utf8').digest()])
  const ok = verifySignature('sha256', data, { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig)
  return ok ? null : 'the ES256 signature does not verify against the recorded public key'
}

// ------------------------------------------------------------------------------------------------ verification

export interface Finding { ok: boolean; check: string; detail: string }
export interface VerifyResult { ok: boolean; failures: string[]; checks: Finding[] }

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const big = (v: unknown): bigint | null => { try { return typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? BigInt(v) : null } catch { return null } }
const TX = /0x[0-9a-fA-F]{64}/g
const short = (h: string): string => `${h.slice(0, 10)}…`

export function verifyCase(c: EvidenceCase, anchors: { root?: string; head?: string } = {}): VerifyResult {
  const checks: Finding[] = []
  const add = (check: string, ok: boolean, detail: string): void => { checks.push({ ok, check, detail }) }
  const fail = (check: string, detail: string): void => add(check, false, detail)
  const S = (k: SectionKey): Json => (c.sections?.[k] ?? {}) as Json
  const name = (k: SectionKey): string => `section ${k} (${SECTION_TITLES[k]})`

  // ---- structure
  if (c.format !== CASE_FORMAT) fail('format', `format is ${String(c.format)}, not ${CASE_FORMAT}`)
  const missing = SECTION_KEYS.filter((k) => !c.sections || typeof c.sections[k] !== 'object' || c.sections[k] === null)
  const extra = Object.keys(c.sections ?? {}).filter((k) => !SECTION_KEYS.includes(k as SectionKey))
  if (missing.length || extra.length) fail('sections', `${missing.length ? `missing section${missing.length === 1 ? '' : 's'} ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `unexpected section${extra.length === 1 ? '' : 's'} ${extra.join(', ')}` : ''}`)
  if (!c.hashes?.sections) { fail('hashes', 'the case carries no hashes'); return done(checks) }

  // ---- hashes
  for (const k of SECTION_KEYS) {
    if (missing.includes(k)) continue
    const got = partHash(c.sections[k])
    add(`hash of section ${k}`, got === c.hashes.sections[k], got === c.hashes.sections[k] ? got : `${name(k)} hash mismatch: stated ${short(String(c.hashes.sections[k]))}, computed ${short(got)}`)
  }
  for (const part of ['verification', 'redactions', 'cannotProve'] as const) {
    const got = partHash(c[part])
    add(`hash of ${part}`, got === c.hashes[part], got === c.hashes[part] ? got : `${part} hash mismatch: stated ${short(String(c.hashes[part]))}, computed ${short(got)}`)
  }
  const parts = { sections: c.hashes.sections, verification: c.hashes.verification, redactions: c.hashes.redactions, cannotProve: c.hashes.cannotProve }
  const root = partHash({ format: c.format, id: c.id, kind: c.kind, title: c.title, outcome: c.outcome, venue: c.venue, workspace: c.workspace, assembledAt: c.assembledAt, ...parts })
  add('root hash', root === c.hashes.root, root === c.hashes.root ? root : `root hash mismatch: stated ${short(String(c.hashes.root))}, computed ${short(root)}`)
  // An anchor is compared by eye with a root kept elsewhere: both are printed whole.
  if (anchors.root) add('root against the anchor', anchors.root === c.hashes.root, anchors.root === c.hashes.root ? 'equal' : `the case's root ${c.hashes.root} is not the anchored root ${anchors.root}`)

  // ---- the wallet's receipt chain
  const rc = (c.verification?.receiptChain ?? null) as { genesis?: string; server?: { ok?: boolean; count?: number; head?: string }; entries?: ChainEntry[] } | null
  const chainById = new Map<string, ChainEntry>()
  if (rc) {
    const entries = arr<ChainEntry>(rc.entries)
    const genesis = receiptGenesis(c.workspace)
    if (rc.genesis !== genesis) fail('receipt chain genesis', `the stated genesis ${short(String(rc.genesis))} is not SHA-256("qed-receipts-v1:${c.workspace}") = ${short(genesis)}`)
    let prev = genesis, bad = 0
    entries.forEach((e, i) => {
      chainById.set(e.id, e)
      if (e.seq !== i + 1) { fail('receipt chain order', `receipt chain: entry ${i + 1} has seq ${e.seq} (missing or reordered receipts)`); bad++ }
      if (e.prevHash !== prev) { fail('receipt chain links', `receipt chain: receipt #${e.seq} names ${short(e.prevHash)} as its predecessor, but the receipt before it hashes to ${short(prev)}`); bad++ }
      if (e.body !== undefined && receiptHashOf(e.prevHash, e.body) !== e.hash) { fail('receipt bodies', `receipt chain: the body of receipt #${e.seq} (${e.id}) does not hash to its recorded hash ${short(e.hash)}`); bad++ }
      prev = e.hash
    })
    if (rc.server?.count === entries.length && rc.server.head && rc.server.head !== prev) { fail('receipt chain head', `receipt chain: its last receipt hashes to ${short(prev)}, but the head stated by the server is ${short(rc.server.head)}`); bad++ }
    if (anchors.head && entries.length) add('receipt chain against the anchor', entries.some((e) => e.hash === anchors.head) || prev === anchors.head, `the anchored head ${anchors.head} ${entries.some((e) => e.hash === anchors.head) ? 'is in' : 'is not in'} this case's receipt chain`)
    if (rc.server && rc.server.ok !== true) fail('receipt chain (server)', 'the server reported the receipt chain broken when the case was assembled')
    if (!bad) add('receipt chain', true, `${entries.length} receipt${entries.length === 1 ? '' : 's'} linked from the genesis; ${entries.filter((e) => e.body !== undefined).length} bodies re-hashed`)
  }

  // ---- the snapshot the model was sent, when the call kept it (N-009): it hashes to the context hash recorded with the call
  const sent = ((S('2').sent ?? {}) as Json)
  if (sent.data !== undefined && typeof sent.snapshotSha256 === 'string') {
    const got = sha256hex(JSON.stringify(sent.data))
    add('snapshot sent to the model', got === sent.snapshotSha256, got === sent.snapshotSha256 ? `DATA, as sent, hashes to the recorded context hash ${short(got)}` : `section 2: the snapshot sent to the model hashes to ${short(got)}, not the context hash recorded with the call ${short(sent.snapshotSha256)}`)
  }

  // ---- signed authority: documents, terms, passkeys
  for (const inst of arr<AuthorityInstrument>(S('1').instruments)) {
    if (inst.document) {
      const got = sha256hex(inst.document.text)
      add(`document of ${inst.kind} ${inst.id}`, got === inst.document.sha256, got === inst.document.sha256 ? got : `section 1: the signed document of ${inst.kind} ${inst.id} hashes to ${short(got)}, not the stated ${short(inst.document.sha256)}`)
      if (inst.approval && inst.approval.docHash !== inst.document.sha256) fail(`approval of ${inst.kind} ${inst.id}`, `section 1: approval ${inst.approval.id} was given for document ${short(inst.approval.docHash)}, not for ${short(inst.document.sha256)}`)
    }
    if (inst.terms !== undefined && inst.termsHash) {
      const got = termsHashOf(inst.terms)
      add(`terms of ${inst.kind} ${inst.id}`, got === inst.termsHash, got === inst.termsHash ? got : `section 1: the terms of ${inst.kind} ${inst.id} hash to ${got.slice(0, 17)}…, not the stated ${inst.termsHash.slice(0, 17)}…`)
    }
    for (const [i, s] of arr<SignatureEntry>(inst.signatures).entries()) {
      const why = verifyAssertion(s)
      add(`passkey signature ${i + 1} on ${inst.kind} ${inst.id}`, why === null, why === null ? `ES256 by ${s.credential} over ${s.challengeIs}` : `section 1: passkey signature ${i + 1} on ${inst.kind} ${inst.id}: ${why}`)
      if (inst.approval && s.challengeIs.startsWith('approval') && s.challenge.replace(/^0x/, '') !== approvalChallengeHex(inst.approval.id, inst.approval.docHash)) fail(`challenge of signature ${i + 1} on ${inst.kind} ${inst.id}`, `section 1: signature ${i + 1} on ${inst.kind} ${inst.id} signed a challenge that is not SHA-256("qed/approval/v1\\n${inst.approval.id}\\n<document hash>")`)
      if (s.challengeIs.startsWith('owner-account digest')) {
        const digests = arr<{ digest?: string }>((inst.terms as { toSign?: unknown } | undefined)?.toSign).map((t) => String(t.digest).toLowerCase())
        if (!digests.includes(s.challenge.toLowerCase())) fail(`challenge of signature ${i + 1} on ${inst.kind} ${inst.id}`, `section 1: signature ${i + 1} on ${inst.kind} ${inst.id} signed ${short(s.challenge)}, which is not one of the digests its terms list for the chain`)
      }
    }
  }

  // ---- the vault's decision records
  const decisions = [...arr<DecisionEntry>(S('3').decisionRecords), ...arr<DecisionEntry>(S('1').decisionRecords)]
  const seenN = new Set<number>()
  for (const d of decisions) {
    if (seenN.has(d.n)) continue
    seenN.add(d.n)
    const got = decisionHashOf(d)
    if (got !== d.hash) fail('vault decision records', `vault decision record #${d.n} (${d.kind}, ${d.verdict}) does not hash to its recorded hash ${short(d.hash)}`)
  }
  if (decisions.length && checks.every((x) => x.check !== 'vault decision records')) add('vault decision records', true, `${seenN.size} record${seenN.size === 1 ? '' : 's'} re-hashed`)

  // ---- steps in order
  const steps = arr<StepEntry>(S('3').steps)
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!, b = steps[i]!
    if (b.seq !== a.seq + 1) fail('step order', `section 3: step "${b.key}" has seq ${b.seq} after seq ${a.seq} (steps missing or reordered)`)
    else if (Date.parse(b.at) < Date.parse(a.at)) fail('step order', `section 3: step "${b.key}" (seq ${b.seq}) is dated ${b.at}, before step "${a.key}" at ${a.at}`)
  }
  if (steps.length && !checks.some((x) => x.check === 'step order')) add('step order', true, `${steps.length} steps in sequence`)

  // ---- checks, refusals and the outcome agree
  const s3checks = arr<CheckEntry>(S('3').checks)
  const failing = s3checks.filter((x) => !x.pass)
  const refusedHere = arr<{ check: string }>(S('8').thisCase)
  const executed = S('5').executed === true
  if (c.outcome === 'executed') {
    if (failing.length) fail('outcome and checks', `the case says executed, but section 3 records ${failing.length} failed check${failing.length === 1 ? '' : 's'} (${failing.map((x) => x.name).join(', ')})`)
    if (!executed) fail('outcome and balances', 'the case says executed, but section 5 says nothing was executed')
  }
  if (c.outcome === 'refused' || c.outcome === 'reverted' || c.outcome === 'failed' || c.outcome === 'invalid') {
    if (!failing.length) fail('outcome and checks', `the case says ${c.outcome}, but section 3 records no failed check`)
    if (executed && c.outcome !== 'reverted') fail('outcome and balances', `the case says ${c.outcome}, but section 5 says it was executed`)
  }
  const names = (xs: { name?: string; check?: string }[]) => xs.map((x) => String(x.name ?? x.check)).sort().join(', ')
  if (names(failing) !== names(refusedHere)) fail('refusals', `section 8 lists ${refusedHere.length} refusal${refusedHere.length === 1 ? '' : 's'} for this case (${names(refusedHere) || 'none'}), but section 3 records ${failing.length} failed check${failing.length === 1 ? '' : 's'} (${names(failing) || 'none'})`)
  for (const st of steps.filter((x) => x.status === 'refused' || x.status === 'reverted')) {
    if (!failing.some((x) => x.source?.step === st.seq)) fail('refusals', `section 3: step "${st.key}" (seq ${st.seq}) was ${st.status}, but no failed check records it`)
  }
  for (const d of arr<DecisionEntry>(S('3').decisionRecords)) if (d.verdict === 'REFUSED' && c.outcome === 'executed') fail('outcome and decisions', `vault decision record #${d.n} (${d.kind}) is REFUSED, but the case says executed`)
  // A paper action's checks are also in its receipt, inside the hash chain.
  for (const x of s3checks.filter((y) => y.source?.receipt)) {
    const e = chainById.get(x.source!.receipt!)
    const body = e?.body as { decision?: { checks?: { name: string; ok: boolean; detail: string }[] } } | undefined
    if (!e || !body) { fail('checks against receipts', `section 3: check "${x.name}" cites receipt ${x.source!.receipt}, which this case's receipt chain does not carry`); continue }
    const r = body.decision?.checks?.find((y) => y.name === x.name)
    if (!r || r.ok !== x.pass || r.detail !== x.detail) fail('checks against receipts', `section 3: check "${x.name}" (${x.pass ? 'passed' : 'failed'}) differs from the receipt ${e.id}, which records it as ${r ? `${r.ok ? 'passed' : 'failed'}: ${r.detail}` : 'absent'}`)
  }
  for (const e of chainById.values()) {
    const body = e.body as { decision?: { checks?: { name: string; ok: boolean }[] } } | undefined
    if (!body?.decision?.checks || !s3checks.some((x) => x.source?.receipt === e.id)) continue
    for (const r of body.decision.checks) if (!s3checks.some((x) => x.source?.receipt === e.id && x.name === r.name)) fail('checks against receipts', `receipt ${e.id} records the check "${r.name}" (${r.ok ? 'passed' : 'failed'}), which section 3 leaves out`)
  }

  // ---- receipts cited by section 5 are the chain's own
  for (const r of arr<{ id: string; hash: string | null; seq: number | null }>(S('5').receipts)) {
    const e = chainById.get(r.id)
    if (!e) fail('receipts', `section 5 cites receipt ${r.id}, which this case's receipt chain does not carry`)
    else if (e.hash !== r.hash || e.seq !== r.seq) fail('receipts', `section 5 cites receipt ${r.id} as #${String(r.seq)} with hash ${short(String(r.hash))}, but the chain has #${e.seq} with hash ${short(e.hash)}`)
  }

  // ---- transactions: every hash accounted for, the same everywhere
  const txs = arr<TxEntry>(S('6').transactions)
  const listed = new Set(txs.map((t) => t.hash.toLowerCase()))
  const mentioned = new Set<string>()
  for (const st of steps) for (const h of JSON.stringify(st.data ?? {}).match(TX) ?? []) if (st.data && (st.data as Json).hash === h) mentioned.add(h.toLowerCase())
  for (const m of arr<MovedEntry>(S('5').moved)) if (m.evidence?.tx) mentioned.add(m.evidence.tx.toLowerCase())
  for (const h of mentioned) if (!listed.has(h)) fail('transactions', `a transaction ${short(h)} recorded in sections 3 or 5 is not in section 6's transactions`)
  for (const t of txs) if (t.chain === 'vault' && !mentioned.has(t.hash.toLowerCase()) && !steps.some((st) => JSON.stringify(st).toLowerCase().includes(t.hash.toLowerCase()))) fail('transactions', `section 6 lists transaction ${short(t.hash)}, which no step of section 3 produced`)

  // ---- figures: what moved, against the transactions' events and the ledger
  const entries = arr<LedgerEntryView>(S('5').entries)
  for (const m of arr<MovedEntry>(S('5').moved)) {
    if (big(m.amount) === null) { fail('figures', `section 5: "${m.what}" has no amount`); continue }
    if (m.evidence?.tx && m.evidence.event && m.evidence.arg) {
      const t = txs.find((x) => x.hash.toLowerCase() === m.evidence!.tx!.toLowerCase())
      const ev = m.evidence.index !== undefined ? (t?.events[m.evidence.index]?.name === m.evidence.event ? t.events[m.evidence.index] : undefined) : t?.events.find((e) => e.name === m.evidence!.event)
      const v = ev?.args?.[m.evidence.arg]
      if (!t || !ev || String(v) !== m.amount) fail('figures', `section 5: ${m.what} is ${m.amount}, but the ${m.evidence.event} event of transaction ${short(m.evidence.tx)} records ${m.evidence.arg} = ${v === undefined ? 'nothing' : String(v)}`)
    }
    if (m.evidence?.entries?.length) {
      const account = m.from ?? m.to
      const got = m.evidence.entries.map((n) => entries.find((x) => x.seq === n)).flatMap((e) => e?.lines.filter((l) => l.account === account && l.asset === m.asset) ?? []).reduce((s, l) => s + (big(l.amount) ?? 0n), 0n)
      const abs = got < 0n ? -got : got
      if (abs !== big(m.amount)) fail('figures', `section 5: ${m.what} is ${m.amount}, but ledger entr${m.evidence.entries.length === 1 ? 'y' : 'ies'} #${m.evidence.entries.join(', #')} move ${got} in ${String(account)}`)
    }
  }
  for (const e of entries) {
    const per = new Map<string, bigint>()
    for (const l of e.lines) per.set(l.asset, (per.get(l.asset) ?? 0n) + (big(l.amount) ?? 0n))
    for (const [asset, s] of per) if (s !== 0n) fail('ledger', `section 5: ledger entry #${e.seq} (${e.kind}) does not balance in ${asset}: its lines sum to ${s}`)
  }
  for (const b of arr<BalanceEntry>(S('5').balances)) {
    const before = big(b.before), after = big(b.after), delta = big(b.delta)
    if (before === null || after === null || delta === null || after - before !== delta) { fail('balances', `section 5: ${b.account} goes from ${b.before} to ${b.after}, which is not the stated change of ${b.delta}`); continue }
    if (b.source === 'ledger' && entries.length) {
      const sum = entries.flatMap((e) => e.lines).filter((l) => l.account === b.account && l.asset === b.asset).reduce((s, l) => s + (big(l.amount) ?? 0n), 0n)
      if (sum !== delta && -sum !== delta) fail('balances', `section 5: ${b.account} changes by ${b.delta}, but this case's ledger entries move ${sum} in it`)
    }
  }
  const costs = (S('5').costs ?? null) as { ledgerAgrees?: boolean; cashBooked?: string; cashExpected?: string } | null
  if (costs && costs.ledgerAgrees === true && costs.cashBooked !== costs.cashExpected) fail('costs', `section 5: the costs say the ledger agrees, but it booked ${String(costs.cashBooked)} against ${String(costs.cashExpected)} expected`)
  if (!checks.some((x) => !x.ok && ['figures', 'ledger', 'balances', 'costs'].includes(x.check)) && (arr(S('5').moved).length || entries.length || arr(S('5').balances).length)) add('figures', true, `${arr(S('5').moved).length} amounts, ${entries.length} ledger entries and ${arr(S('5').balances).length} balances agree`)

  return done(checks)
}
function done(checks: Finding[]): VerifyResult { const failures = checks.filter((x) => !x.ok).map((x) => x.detail); return { ok: failures.length === 0, failures, checks } }

// ------------------------------------------------------------------------------------------------ against the chain

type Rpc = (method: string, params: unknown[]) => Promise<unknown>
export function jsonRpc(url: string, fetchFn: typeof fetch = fetch): Rpc {
  let id = 0
  return async (method, params) => {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10_000) })
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } }
    if (j.error) throw new Error(`${method}: ${j.error.message ?? 'error'}`)
    return j.result
  }
}
/** A value as the 32-byte word a log would carry it in, or null for a value that is not one word (a struct, a list). */
function word(v: unknown): string | null {
  if (typeof v === 'boolean') return (v ? 1n : 0n).toString(16).padStart(64, '0')
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v).toString(16).padStart(64, '0')
  if (typeof v !== 'string') return null
  if (/^-?\d+$/.test(v)) { const n = BigInt(v); return (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0') }
  if (/^0x[0-9a-fA-F]{40}$/.test(v) || /^0x[0-9a-fA-F]{64}$/.test(v)) return hex32(v)
  return null
}

/** Re-read every transaction of the vault's chain listed in section 6 and compare status, block, addresses, gas and each event's figures. */
export async function verifyOnChain(c: EvidenceCase, rpc: string | Rpc): Promise<VerifyResult> {
  const call = typeof rpc === 'string' ? jsonRpc(rpc) : rpc
  const checks: Finding[] = []
  const add = (check: string, ok: boolean, detail: string): void => { checks.push({ ok, check, detail }) }
  const s6 = (c.sections?.['6'] ?? {}) as { chain?: { chainId?: number }; transactions?: TxEntry[] }
  const txs = arr<TxEntry>(s6.transactions)
  if (!txs.length) { add('transactions', true, 'this case lists no transaction to re-read'); return done(checks) }
  try {
    const chainId = Number(BigInt(String(await call('eth_chainId', []))))
    add('chain id', chainId === s6.chain?.chainId, chainId === s6.chain?.chainId ? `chain ${chainId}` : `the RPC endpoint serves chain ${chainId}; the case is for chain ${String(s6.chain?.chainId)}`)
  } catch (e) { add('chain id', false, `the RPC endpoint did not answer: ${(e as Error).message}`); return done(checks) }
  for (const t of txs) {
    if (t.chain !== 'vault') { add(`transaction ${short(t.hash)}`, true, 'on an ephemeral chain that no longer exists: not re-read; the vault service\'s record is all there is'); continue }
    const r = (await call('eth_getTransactionReceipt', [t.hash]).catch(() => null)) as { status?: string; blockNumber?: string; from?: string; to?: string; gasUsed?: string; logs?: { address: string; topics: string[]; data: string }[] } | null
    if (!r) { add(`transaction ${short(t.hash)}`, false, `the chain has no receipt for transaction ${short(t.hash)}`); continue }
    const diffs: string[] = []
    const status = r.status === '0x1' ? 'success' : 'reverted'
    if (status !== t.status) diffs.push(`status ${status}, recorded ${t.status}`)
    if (BigInt(r.blockNumber ?? '0x0').toString() !== t.block) diffs.push(`block ${BigInt(r.blockNumber ?? '0x0')}, recorded ${t.block}`)
    if (t.from && r.from?.toLowerCase() !== t.from.toLowerCase()) diffs.push(`from ${String(r.from)}, recorded ${t.from}`)
    if (t.to && r.to?.toLowerCase() !== t.to.toLowerCase()) diffs.push(`to ${String(r.to)}, recorded ${t.to}`)
    if (BigInt(r.gasUsed ?? '0x0').toString() !== t.gasUsed) diffs.push(`gas ${BigInt(r.gasUsed ?? '0x0')}, recorded ${t.gasUsed}`)
    let compared = 0
    for (const ev of t.events) {
      const logs = (r.logs ?? []).filter((l) => !ev.address || l.address.toLowerCase() === ev.address.toLowerCase())
      const values = Object.entries(ev.args ?? {}).map(([k, v]) => [k, word(v)] as const).filter((x): x is readonly [string, string] => x[1] !== null)
      const found = logs.some((l) => { const words = [...l.topics.slice(1).map((x) => hex32(x)), ...(l.data.replace(/^0x/, '').match(/.{64}/g) ?? [])]; return values.every(([, w]) => words.includes(w)) })
      if (!found) diffs.push(`no log of ${ev.address ? short(ev.address) : 'any contract'} carries the ${ev.name} figures (${values.map(([k]) => k).join(', ')})`)
      compared += values.length
    }
    add(`transaction ${short(t.hash)}`, diffs.length === 0, diffs.length ? `transaction ${short(t.hash)} on chain: ${diffs.join('; ')}` : `${status} in block ${t.block}; from, to and gas agree; ${compared} event figures found in its logs`)
  }
  return done(checks)
}
