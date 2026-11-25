/**
 * The on-chain wallet, in design "Meridian" (DESIGN.md M1 to M11; the owner's R11 criterion for the wallet:
 * "straightforward ownership, provisioning, biometric access and recovery"). The page says, before anything else, who
 * owns the wallet and what each key may do; setting it up is a short guided checkout of three steps with the wallet
 * forming beside them; and every rule carries one of three marks (src/ui/enforced.tsx): what the wallet's contract on
 * the chain refuses ("Contract enforces"), what QED's co-signer or vault service refuses ("QED checks", which the chain
 * does not know), and what is only read ("Observed only"). Amounts are valueless test rupees and test dollars on a chain
 * that runs on this computer, and are said to be so wherever they appear.
 *
 * Plain words first: what the wallet holds, what QED may do with it (each limit a meter of what is left, in QED's tide),
 * what is set aside for whom, who must sign. Addresses, chain ids, hashes, block numbers and the contracts' names are one
 * step down, in disclosures. A job reads as a record: what was asked, the checks, the result, the references.
 *
 * Behind it: the approved release's contracts, unmodified, on a local test chain, with the release's own engines. A
 * wallet action follows the same path as everything else in QED: exact terms first, your approval of those terms with
 * your passkey, then one execution that can be followed step by step and read afterwards as a record. The approval
 * sheet is UX only: the passkey's signature over the exact digests is what the chain checks, never the gesture.
 */
import { createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useRef, useState } from 'react'
import { Check, Fingerprint, FlaskConical, KeyRound, ShieldAlert } from 'lucide-react'
import type { AttackInfo, DecisionRecord, HistoricalEvidence, HistoryEntry, Job, LiabilityView, LimitCheck, LimitsResult, MandateView, PaymentLimits, PolicyView, Proposal, ProposalKind, QuotaView, QuoteResult, RailState, ScenarioInfo, TickRecord, ToSign, VaultView } from '../../chain/types.ts'
import { api, fmt, navigate, useData, useNow } from '../lib/core.ts'
import { CHAIN_CURRENCIES, CHAIN_TOKENS, DEFAULT_ASSET_SET, TEST_TOKEN_SYMBOLS, tokenBySymbol, type AssetSet } from '../../shared/chain-assets.ts'
import { addFirstPasskey, confirmWithPasskey, deviceWords, passkeysAvailable, platformPasskeyAvailable, setUpVaultWithTokens, signForVault } from '../lib/passkey.ts'
import { EnforcedBy, EnforcementKey, type Enforcer } from '../ui/enforced.tsx'
import { ApprovalSheet, type PendingApproval } from '../ui/instrument.tsx'
import { Btn, Crumb, Field, Link, Loading, Mark, MoneyBar, Note, Problem, Src, Stamp, Swatch, useAction, useMasonry, useSession } from '../ui/kit.tsx'


interface Asset { symbol: string; decimals: number }
/** The rail's view of this household's workspace (chain/types.ts WorkspaceView, the parts shown here). */
interface Workspace { id: string; status: 'deploying' | 'awaiting-acceptance' | 'ready' | 'failed'; ownerAccount: string | null; ownerAccountBuild: { label: string; declaredReady: boolean } | null; signers: { signerId: string; role: 'member' | 'recovery' }[]; threshold: number | null; asset: Asset; reserveAsset: Asset; grant: { vault: string; ownerAccount: string; token: string } | null; createdAt: string }
interface ScheduledChange { changeId: string; kind: string; summary: string; status: 'pending' | 'applied' | 'cancelled'; readyAt: number; readyTime: string; ready: boolean }
/** As server/rail.ts OwnerReadiness: `ready` names the passkeys that become the wallet's signers; the others say what stands in the way. */
type OwnerReadiness =
  | { state: 'ready'; passkeys: string[]; waiting?: { passkey: string; until: number }[] }
  | { state: 'no-passkey' }
  | { state: 'signin-only' }
  | { state: 'cooling-off'; passkey: string; until: number }
interface Overview {
  available: boolean; reason?: string; custody: string
  /** Whether this household has a vault; `lost` when the vault service no longer knows the one it had (a new data folder). */
  setUp: boolean; lost?: boolean; canSetUp: boolean; whyNot?: string
  /** This person's passkeys that can sign today, and whether each is a signer of the vault. */
  passkeys: { id: string; name: string; signer: boolean | null }[]
  /** R14: for a household's own wallet, whether its passkeys can own one now and, if not, why (server/rail.ts ownerReadiness). */
  owner?: OwnerReadiness
  /** The one web origin the vault's owner account takes signatures from (fixed when it was set up). */
  origin: string | null; origins: string[]
  workspace: Workspace | null; state: RailState | null; scheduled: ScheduledChange[]
  health?: { network?: string; versions?: { release?: string; anvil?: string | null } }
  /** A shared workspace: the members who would sign (one passkey each) and how many must, and once set up, who signs. */
  shared?: boolean
  plan?: { threshold: number; members: { name: string; handle: string; role: string; passkey: string | null }[] }
  signers?: { name: string; passkey: string; you: boolean }[]
}
/** Who signs for the wallet's owner account, as the vault service reads it from the chain (GET /api/vault/signers). */
interface SignersView {
  threshold: number; adminThreshold: number; memberCount: number; delaySeconds: number; recoveryDelaySeconds: number
  /** Members' passkeys and recovery keys alike (server/rail-signers.ts vaultSignersView): a recovery key has no passkey, and is not an owner. */
  signers: { signerId: string; role: string; passkey?: { name: string; person: { name: string; handle: string }; you: boolean; state: string } | null; unknown?: boolean; pendingRemoval?: unknown; recoveryKey?: { registeredBy: string; registeredAt: number } | null; pendingRecovery?: string | null }[]
  recovery: { keys: number; hasKey: boolean }
  /** What the vault service warns of about who signs, in its own words (a passkey revoked in QED that the chain still accepts, a signer nobody here knows). */
  warnings?: string[]
}

/** The vault's two assets: the treasury's (test rupees in an owner's vault) and the reserve's (test dollars). */
const UNITS = { main: { symbol: 'tINR', decimals: 2 }, reserve: { symbol: 'tUSD', decimals: 6 } }
const Units = createContext<{ main: Asset; reserve: Asset }>(UNITS)
const useUnits = (): { main: Asset; reserve: Asset } => useContext(Units)
/** This household's vault as the rail describes it, for the parts of the screen that name its owner account. */
const Ws = createContext<Overview | null>(null)

// ------------------------------------------------------------------------------------------------ words and figures

/**
 * Raw token units (a decimal string) as a human amount. Exact: the digits are moved, never converted to a float. At least
 * `places` decimal places are written (two by default; a 0-decimal token none, a 3-decimal one three).
 */
function tok(raw: string | null | undefined, decimals = 6, locale = 'en-US', places = 2): string {
  if (raw == null || raw === '') return 'none'
  // Only a whole number of smallest units can be shown by moving digits. Anything else is shown as it came, never
  // allowed to break the page (a price vector of plain numbers once reached this function and did).
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return String(raw)
  const neg = raw.startsWith('-')
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, '0')
  // An 18-decimal token is shown to eight places: enough to tell amounts apart, without a line of digits.
  const int = decimals ? digits.slice(0, -decimals) : digits, frac = decimals ? digits.slice(-decimals).slice(0, 8).replace(/0+$/, '') : ''
  const shown = frac.padEnd(Math.min(places, decimals), '0')
  return `${neg ? '−' : ''}${BigInt(int).toLocaleString(locale)}${shown ? `.${shown}` : ''}`
}
/** A test token's decimals by its symbol (shared/chain-assets.ts: the eight currencies' tokens and tETH). */
const dec = (token: string): number => tokenBySymbol(token)?.decimals ?? (token === 'tETH' ? 18 : token === 'tINR' ? 2 : 6)
/** How many places a person reads of a token: its currency's minor unit (whole yen, dinars to the fils), two otherwise. */
const placesOf = (a: Asset): number => Math.min(a.decimals, tokenBySymbol(a.symbol)?.minor ?? 2)
/** An amount of one of the vault's assets, grouped the Indian way (1,00,000.00) whatever its currency: one convention on every wallet tab. */
const amt = (raw: string | null | undefined, a: Asset): string => tok(raw, a.decimals, 'en-IN', placesOf(a))
/** Parts per million, to two places at most, with the unit in the singular when it is one. */
const ppm = (n: number): string => { const x = Math.round(Number(n) * 100) / 100; return `${x} ${x === 1 ? 'part' : 'parts'} per million` }
/**
 * The proof's price vector in words. The planner reports a relative value per smallest unit of each token, with the
 * token being bought at exactly 1. Shown as what one whole token of each other kind is worth in that token.
 */
function pricesInWords(prices: Record<string, number>): string {
  const entries = Object.entries(prices).map(([k, v]) => [k, Number(v)] as const)
  const unit = entries.find(([, v]) => v === 1)?.[0]
  if (!unit) return entries.map(([k, v]) => `${k} ${v}`).join('; ')
  return entries.filter(([k]) => k !== unit).map(([k, v]) => { const p = v * 10 ** (dec(k) - dec(unit)); return `1 ${k} = ${Number.isFinite(p) ? p.toLocaleString('en-US', { maximumFractionDigits: p >= 100 ? 2 : 4 }) : 'not known'} ${unit}` }).join('; ')
}

const SIGN: Record<string, string> = { tINR: '₹', tUSD: '$', tEUR: '€' }
/** An amount field's prefix: the rupee sign of the shared style, the token's own sign, or none for a token without one (S5). */
const signOf = (a: Asset): { 'data-sign'?: string } => (a.symbol === 'tINR' ? {} : { 'data-sign': SIGN[a.symbol] ?? '' })
/** Every test token's words, from shared/chain-assets.ts (S5: the eight currencies' tokens and tETH). */
const UNIT_ONE: Record<string, string> = Object.fromEntries(TEST_TOKEN_SYMBOLS.map((t) => [t, tokenBySymbol(t)!.one]))
const UNIT_MANY: Record<string, string> = Object.fromEntries(TEST_TOKEN_SYMBOLS.map((t) => [t, tokenBySymbol(t)!.many]))
const TICKERS = `(${TEST_TOKEN_SYMBOLS.join('|')})`
const AMOUNT = String.raw`(?<![\w.,])(\d[\d,]*(?:\.\d+)?)`
const NUMBER = String.raw`(\d[\d,]*(?:\.\d+)?)`
const SIGNED = '(tINR|tUSD|tEUR)'
/**
 * The vault service's wording in the owner's units: an amount with a token's ticker is written with its currency sign
 * ("3.00 tINR" becomes "₹3.00", both ends of "1,00,000.00 → 99,997.00 tINR" and of "200–2,000 tINR" too), a ticker on
 * its own becomes its words ("tINR" becomes "test rupees"), money the contract "ring-fences" as a "liability" is money
 * set aside as a promise, and a transaction hash is shortened. Digits are moved, never recomputed; test ether, which has
 * no sign, keeps its words.
 */
/**
 * A record's headline, read alone, names the unit in words ("Paid 3.00 test rupees to CloudCo"), as Activity does: a
 * sign there would read as real money (R12 task comparison, T10-a). The wallet's own figures keep their signs, with the
 * unit said once beside them.
 */
export const tokensInWords = (text: string): string => text
  .replace(/₹(\d[\d,]*(?:\.\d+)?)/g, '$1 test rupees').replace(/\$(\d[\d,]*(?:\.\d+)?)/g, '$1 test dollars').replace(/€(\d[\d,]*(?:\.\d+)?)/g, '$1 test euros')
export function inUnits(text: string): string {
  return text
    .replace(new RegExp(`${AMOUNT} → ${NUMBER} (?:test )?${SIGNED}\\b`, 'g'), (_, a: string, b: string, t: string) => `${SIGN[t]}${a} → ${SIGN[t]}${b}`)
    .replace(new RegExp(`${AMOUNT}–${NUMBER} (?:test )?${SIGNED}\\b`, 'g'), (_, a: string, b: string, t: string) => `${SIGN[t]}${a}–${SIGN[t]}${b}`)
    .replace(new RegExp(`${AMOUNT} (?:test )?${SIGNED}\\b`, 'g'), (_, a: string, t: string) => `${SIGN[t]}${a}`)
    .replace(new RegExp(`\\bper ${TICKERS}\\b`, 'g'), (_, t: string) => `per ${UNIT_ONE[t]}`)
    .replace(new RegExp(`\\b${TICKERS}\\/${TICKERS}\\b`, 'g'), (_, a: string, b: string) => `${UNIT_MANY[a]} and ${UNIT_MANY[b]}`)
    .replace(new RegExp(`\\b(?:test )?${TICKERS}\\b`, 'g'), (_, t: string) => UNIT_MANY[t] ?? t)
    .replace(/\bring-fenced liabilities\b/g, 'money set aside for promises')
    .replace(/\b([Rr])ing-fenced?\b/g, (_, r: string) => (r === 'R' ? 'Set aside' : 'set aside'))
    .replace(/\bliability #(\d+)/g, 'promise $1')
    .replace(/\b0x([0-9a-fA-F]{4})[0-9a-fA-F]{56}([0-9a-fA-F]{4})\b/g, '0x$1…$2')
}
/**
 * The vault service's own wording, with times put into India time, references to internal documents removed (the
 * baseline's W-numbers, and the research decision D7 the authority budget comes from: "(R7 D7)", "R7 decision D7",
 * "D7 assumption A-ID"), the release's dot separators written as commas, and amounts in the owner's units (`inUnits`).
 */
export const plain = (text: string): string => inUnits(text.replace(/\b(0x[0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g, '$1…$2').replace(/\b(\d{1,3}(?:,\d{3})+|\d{4,})(\.\d+)?(?= (?:test )?tINR| → [\d,.]+ (?:test )?tINR)/g, (_, int: string, frac?: string) => `${Number(int.replace(/,/g, '')).toLocaleString('en-IN')}${frac ?? ''}`).replace(/\b[Tt]he rail\b/g, (m) => (m[0] === 'T' ? 'The vault service' : 'the vault service')).replace(/\s*\((?:baseline )?W-\d+\)/g, '').replace(/\s*\((?:R7 )?(?:decision )?D7\)/g, '').replace(/,\s*R7 (?:decision )?D7(?=\))/g, '').replace(/\bD7 assumption [A-Z]+(?:-[A-Z]+)*;\s*/g, '').replace(/\s+·\s+/g, ', ').replace(/\(recent-password\)/g, '(your password, entered a few minutes earlier)').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (t) => `${fmt.dayTime(Date.parse(t))} IST`))
const STEP: Record<string, string> = { interpret: 'The instruction is read', mandate: 'Checked against the mandate and the vault\'s limits', owner: 'Your approval and your passkey\'s signature, checked by your owner account on the chain', cosigner: 'The co-signer checks it against its own rules and signs', submit: 'Sent to the chain', reconcile: 'Balances compared before and after', decide: 'QED works out whether to convert, and how much', grant: 'The opening grant of test rupees arrives' }
/** A conversion carries a route and a proof the contract checks; the other operations do not, and must not be described as if they did. */
const STEP_TRADE: Record<string, string> = { cosigner: 'The co-signer works the trade out for itself and signs', plan: 'The route is found and its proof built', receipt: 'Mined: the contract checked the proof' }
const TRADES = new Set(['convert', 'attack', 'policy-tick', 'policy-run'])
/** A step's name as the owner reads it; what was mined is named by the service (it knows which transaction it was), without the contract's own names. */
export const stepName = (kind: string, s: { key: string; label: string; status: string }): string => {
  if (s.key === 'receipt' && !(TRADES.has(kind) && s.status === 'ok')) {
    const m = /^(?:QED\w*(?: \([^)]*\))?\.\w+ )?mined(?: \([^)]*\))?:?\s*(.*)$/i.exec(s.label)
    return m ? `Mined on the chain${m[1] ? `: ${plain(m[1])}` : ''}` : plain(s.label)
  }
  return (TRADES.has(kind) ? STEP_TRADE[s.key] : undefined) ?? STEP[s.key] ?? plain(s.label)
}
/** The vault service writes its verdicts in capitals (SENT, APPROVED). Shown as ordinary words. */
const verdict = (v: string | null | undefined): string => (v ? v.replace(/_/g, ' ').toLowerCase() : '')
/** How an approval was confirmed, in words. */
const how = (method: string): string => (method === 'recent-password' ? 'your password, entered a few minutes earlier' : method === 'password' ? 'your password' : method === 'passkey' ? 'your passkey' : method)
/** A sentence ends at a full stop followed by a capital: "promise 2" or "₹3.00 to" never ends one. */
const SENTENCE = /\.\s+(?=[A-Z“"(])/
/** The first sentence of a service summary, for a heading; the rest follows as a paragraph. */
export const firstSentence = (t: string): string => { const m = SENTENCE.exec(t); return m ? t.slice(0, m.index + 1) : t }
const rest = (t: string): string => { const m = SENTENCE.exec(t); return m ? t.slice(m.index + m[0].length) : '' }
const iso = (s: string | null | undefined): string => (s ? fmt.dayTime(Date.parse(s)) : '')
/** From one time to another, the day said once when both fall on it: "23 Nov, 18:30 to 18:55". */
export const between = (a: string, b: string): string => { const x = Date.parse(a), y = Date.parse(b); return fmt.day(x) === fmt.day(y) ? `${fmt.dayTime(x)} to ${fmt.time(y)}` : `${fmt.dayTime(x)} to ${fmt.dayTime(y)}` }
const secs = (s: number | string): string => fmt.dayTime(Number(s) * 1000)
const short = (a: string | null | undefined): string => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '')
const words = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()
const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase())
const usePoll = (reload: () => void, ms: number, on = true): void => { useEffect(() => { if (!on) return undefined; const t = setInterval(reload, ms); return () => clearInterval(t) }, [reload, ms, on]) }
const uuid = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-key`)

/** The owner's sections. The developer tools (attack tests, scenarios) are not among them: they sit in the test lab, reached from one quieter link beside these (finish review F1). */
const SUBS: [string, string][] = [['', 'Overview'], ['mandate', 'Mandate'], ['treasury', 'Pay and set aside'], ['convert', 'Convert'], ['policy', 'Automatic conversions'], ['records', 'Records']]
const LAB: [string, string][] = [['lab', 'Attack tests'], ['runs', 'Scenarios']]
const KIND: Record<string, string> = { provision: 'accept your wallet', 'cancel-change': 'cancel a scheduled change', 'apply-change': 'apply a scheduled change', grant: 'grant the agent more authority', 'earned-caps': 'set the caps on earned authority', mandate: 'sign a mandate', convert: 'convert into the reserve', attack: 'run an attack test', policy: 'sign a standing policy', 'policy-revoke': 'end the standing policy', scenario: 'run a scenario', pause: 'pause the wallet', 'guardian-pause': 'pause it with the guardian key', resume: 'resume the wallet', 'revoke-mandate': 'revoke the mandate', 'void-all': 'void every mandate', 'rotate-key': 'replace a key', 'add-signer': 'add a signer to your wallet', 'remove-signers': 'remove signers from your wallet', 'set-thresholds': 'change how many must sign', 'start-recovery': 'start a recovery of your wallet', 'escrow-quote': 'offer work through the escrow', 'escrow-fund': 'fund work through the escrow', 'escrow-deliver': 'deliver work to the escrow', 'escrow-release': 'release the client from the escrow', 'escrow-refund': 'refund an escrow job', 'escrow-accept': 'accept work in the dispute escrow', 'escrow-dispute': 'dispute work in the dispute escrow', 'escrow-evidence': 'add evidence to a dispute', 'escrow-decide': 'rule on a dispute', 'escrow-give-way': 'refund the client in full', 'escrow-finish': 'apply a timeout of the dispute escrow', 'transfer-ownership': 'offer your wallet to a new owner', 'accept-ownership': 'accept a wallet offered to you', 'release-claim': 'forgive money set aside for you', 'assign-claim': 'move a claim to a new creditor', pay: 'pay from the treasury', 'ring-fence': 'set money aside for a creditor', withdraw: 'withdraw to your own account', deposit: 'deposit from your own account', venues: 'name the venues', settle: 'pay a promise that fell due', 'policy-tick': 'one tick of the standing policy', 'policy-run': 'run the standing policy until its target is met', economy: 'a scripted economy', 'bounty-commit': 'commit a bounty claim', 'bounty-reveal': 'reveal a bounty claim', 'bounty-settle': 'settle a bounty' }
const OUTCOME: Record<string, [string, 'ok' | 'wait' | 'void' | 'plain']> = { executed: ['Completed', 'ok'], scheduled: ['Scheduled', 'wait'], refused: ['Refused by QED\'s checks; nothing sent', 'void'], reverted: ['Reverted on the chain', 'void'], 'no-action': ['No action needed', 'plain'], error: ['Do not retry', 'void'] }

/** A delay of the owner account, in hours or, in a labelled test setting, minutes. */
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`
const delay = (seconds: number): string => (seconds >= 3600 ? plural(Math.round(seconds / 3600), 'hour') : plural(Math.max(1, Math.round(seconds / 60)), 'minute'))
const during = (s: number): string => (s >= 86_400 ? plural(Math.round(s / 86_400), 'day') : delay(s))

/** A contract's own name for one of its calls, said as what it does: "QEDVault (treasury).pause" is "pause the treasury". */
const CONTRACT_WORDS: Record<string, string> = { QEDVault: 'vault', QEDExecution: 'conversion service', QEDTreasuryPolicy: 'policy contract', QEDOwnerAccount: 'owner account', ProofEscrow: 'escrow', QEDDisputeEscrow: 'dispute escrow' }
const CALL_WORDS: Record<string, (on: string) => string> = {
  acceptOwnership: (on) => `accept ownership of the ${on}`, pause: (on) => `pause the ${on}`, unpause: (on) => `resume the ${on}`,
  withdraw: (on) => `withdraw from the ${on} to your own account`, deposit: (on) => `deposit into the ${on} from your own account`,
  ringFence: (on) => `set money aside in the ${on} for a creditor`, revokeMandate: () => 'revoke the mandate', bumpEpoch: () => 'void every mandate and certificate', voidAll: () => 'void every mandate and certificate',
  setAgent: () => 'name the agent\'s key', setCosigner: () => 'name the checking key', setGuardian: () => 'name the guardian key', setVenues: () => 'name the venues a conversion may use',
  setOperator: () => 'name who may run conversions', setPolicy: () => 'put the standing policy in the policy contract', revoke: (on) => (on === 'policy contract' ? 'end the standing policy' : `revoke on the ${on}`),
  approve: () => 'let the escrow take the price', addSigner: () => 'add a signer', removeSigners: () => 'remove signers', setThresholds: () => 'change how many must sign', cancel: () => 'cancel a scheduled change', applyCalls: () => 'apply a scheduled change',
  // the dispute step (R13 E3) and ownership and claims (R13 S5)
  open: (on) => `open the job in the ${on}`, deliver: (on) => `deliver the certified work to the ${on}`, noteDelivered: () => 'start the client\'s review in the dispute escrow',
  accept: () => 'accept the work, so the dispute escrow pays the provider', dispute: () => 'dispute the work', addEvidence: () => 'add your evidence to the dispute', decide: () => 'rule on the dispute',
  giveWay: () => 'refund the client in full', reclaim: () => 'return the money to the client through the dispute escrow', refund: (on) => `refund the client from the ${on}`,
  transferOwnership: (on) => `offer the ${on} to a new owner`, release: () => 'forgive the money set aside for you', assign: () => 'move the claim to a new creditor',
}
export function callWords(action: string): string {
  const sched = /^QEDOwnerAccount\.scheduleCalls\((.*)\)$/.exec(action)
  if (sched) return `schedule, behind your account's delay: ${andList(sched[1]!.split(', ').map(callWords))}`
  const m = /^([A-Za-z0-9]+)(?: \(([^)]+)\))?\.([A-Za-z0-9]+)$/.exec(action)
  if (!m) return plain(action)
  const on = m[2] ?? CONTRACT_WORDS[m[1]!] ?? words(m[1]!)
  const f = CALL_WORDS[m[3]!]
  return f ? f(on) : `${words(m[3]!)} on the ${on}`
}

/** One digest the passkey signs, in words: what the chain will do or check with that signature. The digest and the calls' own names are one step down. */
function signsFor(t: ToSign): string {
  if (t.kind === 'cancel') return 'Cancelling the scheduled change named above. One of your passkeys is enough.'
  if (t.kind === 'erc1271') return t.purpose === 'mandate' ? 'The mandate above. The wallet checks your signature through your owner account before it accepts the mandate.' : t.purpose === 'quote' ? 'The offer above: its price, deadline, the client and the work. The escrow checks your signature through your owner account when the client funds it. Nothing moves when you sign.' : 'The exact text above. QED\'s co-signer and the wallet check your signature through your owner account before anything runs.'
  const later = t.schedule ? ` Of these, ${andList(t.schedule.calls.map((c) => callWords(c.action)))} only take effect after your account's delay of ${delay(Number(t.schedule.delaySeconds))}; any of your passkeys can cancel them until then.` : ''
  return `Your owner account runs ${t.calls.length === 1 ? 'this call' : `these ${t.calls.length} calls`}, once, before ${secs(t.deadline)}: ${andList(t.calls.map((c) => callWords(c.action)))}.${later}`
}
/** What the passkey signs, each digest in words, with the digest, its standard and the calls as the chain names them folded beneath. */
function SignsList({ toSign }: { toSign: ToSign[] }) {
  return (
    <div className="vt-signs">
      <h3>What your passkey signs</h3>
      <ol>{toSign.map((t, i) => (
        <li key={i}><span className="vt-signs-n" aria-hidden="true">{i + 1}</span><div className="vt-signs-t">{signsFor(t)}
          {/* the calls are written as plain text here, never as list items: a journey finds the digest's own item by its words */}
          <details className="vt-fold"><summary>As the chain sees it</summary>
            <dl className="kv small">
              {t.kind === 'execute' ? <><dt>Calls</dt><dd>{t.calls.map((c, k) => <span key={k} className="code vt-block">{c.action}</span>)}</dd>{t.schedule ? <><dt>After the delay</dt><dd>{t.schedule.calls.map((c, k) => <span key={k} className="code vt-block">{c.action}</span>)}</dd></> : null}</> : null}
              {t.kind === 'erc1271' ? <><dt>Standard</dt><dd>Checked through your owner account (ERC-1271)</dd></> : null}
              <dt>Digest</dt><dd className="code">{t.digest}</dd>
            </dl>
          </details>
        </div></li>
      ))}</ol>
    </div>
  )
}

/**
 * Who enforces each check of the vault service's limits (chain/rail/service.ts checkLimits; the co-signer's check C12 is
 * added by the payment-limits read): the mandate's validity and limits, the wallet's daily window and its pause are the
 * contract's; the authority budget, or the release's allowance, is the co-signer's. The input check, the free balance
 * less the co-signer's buffer and provisioning carry no mark: they are not one party's rule alone.
 */
const CHECK_BY: Record<string, Enforcer> = { 'mandate-valid': 'contract', 'per-conversion': 'contract', 'mandate-period': 'contract', 'mandate-lifetime': 'contract', 'vault-daily': 'contract', 'not-paused': 'contract', 'authority-budget': 'qed', 'earned-autonomy': 'qed' }
/** Who enforces one of the vault service's checks, when it is one party's rule alone; null otherwise. */
export const checkBy = (id: string): Enforcer | null => CHECK_BY[id] ?? null
/** Who refused a finished job: QED, before anything was sent (the chain never saw it), or the contract, as a revert on the chain. */
export const refusedBy = (r: { outcome: string; tx?: { status: string } } | null | undefined): Enforcer | null => (r?.outcome === 'refused' ? 'qed' : r?.tx?.status === 'reverted' ? 'contract' : null)
/**
 * The owner account's signers, split: its owners (members' passkeys, and signers QED does not know) and its recovery
 * keys, which are signers too but own nothing until a recovery they start has waited out its delay.
 */
export function splitSigners<T extends { role: string }>(signers: T[]): { members: T[]; keys: T[] } {
  return { members: signers.filter((s) => s.role !== 'recovery'), keys: signers.filter((s) => s.role === 'recovery') }
}

/** The limits a payment or a conversion was checked against: only the ones that cap an amount show figures. */
function Checks({ checks }: { checks: LimitCheck[] }) {
  const u = useUnits()
  const fig = (c: LimitCheck, raw: string | null): string => (raw === null || !(CAPS.has(c.id) || c.remaining !== null) ? '' : money(raw, u.main))
  return (
    <div className="ledger-wrap vt-limit-table" tabIndex={0} role="region" aria-label="The limits this was checked against"><table className="ledger">
      {/* four columns, not five: what is used is the small line under what is left, so the rule keeps room to be read */}
      <thead><tr><th scope="col">Limit</th><th scope="col" className="num">Allowed</th><th scope="col" className="num">Left</th><th scope="col">Result</th></tr></thead>
      <tbody>{checks.map((c) => <tr key={c.id}><td>{plain(c.rule)}{c.detail ? <span className="sub">{plain(c.detail)}</span> : null}{checkBy(c.id) ? <span className="sub"><EnforcedBy by={checkBy(c.id)!} /></span> : null}</td><td className="num" data-label="Allowed">{fig(c, c.limit)}</td><td className="num" data-label="Left">{fig(c, c.remaining)}{fig(c, c.used) ? <span className="sub">{fig(c, c.used)} used</span> : null}</td><td data-label="Result">{c.pass ? <span className="ok vt-res"><Mark pass />Within</span> : <strong className="void vt-res"><Mark pass={false} />Broken</strong>}</td></tr>)}</tbody>
    </table></div>
  )
}

/**
 * Where the terms take effect, with the chain's id when the terms carry it (R12 task comparison, T10-a), and for a payment
 * out, that it cannot be undone (T10-d): a mined transfer has no chargeback, and QED cannot recall it.
 */
export function whereWords(terms: Record<string, unknown> | undefined): string {
  const id = terms?.chainId
  return `On a local test chain on this computer${typeof id === 'number' || typeof id === 'string' ? ` (chain id ${id})` : ''}: the tokens have no value.`
}
/** The same, for a record: the chain's id read from the record's network ("Local Anvil chain 31337, …"). */
export const chainLine = (network: string | null | undefined): string => { const m = /\bchain (\d+)\b/i.exec(network ?? ''); return `On a local test chain on this computer${m ? ` (chain id ${m[1]})` : ''}; the tokens have no value.` }
const FINAL_KINDS = new Set(['pay', 'settle'])
export const FINAL_WORDS = 'On a real chain, once it is mined a payment cannot be reversed, by QED or by you: only whoever received it could send it back. Here the payee is a test account whose key is held on this computer.'
/** The exact terms of a vault action, as the owner approves them: the action in words, its limits, then what the passkey signs. */
function Terms({ p }: { p: Proposal }) {
  const { message, toSign, ...rest } = p.terms as Record<string, unknown> & { message?: unknown; toSign?: ToSign[] }
  const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
  return (
    <article className="instrument vt-terms" aria-label={plain(p.summary)}>
      <div className="i-head"><span>On-chain wallet: {KIND[p.kind] ?? p.kind}</span><span>Not signed yet</span></div>
      <div className="i-body">
        <p className="i-pay">{plain(p.summary)}</p>
        <p className="vt-terms-where">{whereWords(p.terms as Record<string, unknown>)}</p>
        {FINAL_KINDS.has(p.kind) ? <p className="vt-terms-where">{FINAL_WORDS}</p> : null}
        {!p.allowed ? <Note tone="void">Under the limits as they stand the wallet would refuse this. You can still send it; the refusal is then recorded.</Note> : null}
        {p.checks.length ? <Checks checks={p.checks} /> : null}
        {typeof message === 'string' ? <details className="vt-fold"><summary>The exact text your passkey signs</summary><pre className="vt-pre">{message}</pre></details> : null}
        {toSign?.length ? <SignsList toSign={toSign} />
          : <p className="vt-terms-note">Nothing here is signed for your vault's owner account: this runs with the vault service's own keys. Your passkey signs these terms as your approval.</p>}
        <details className="vt-fold"><summary>Every field of the terms ({Object.keys(rest).length})</summary>
          <dl className="kv small">{Object.entries(rest).map(([k, v]) => <div key={k} className="vt-contents"><dt>{words(k)}</dt><dd className="code">{show(v)}</dd></div>)}</dl>
          <p className="vt-terms-note">Their fingerprint is <span className="code">{p.termsHash.replace('sha256:', '').slice(0, 16)}</span>; the vault service recomputes it before it signs and refuses if it differs.</p>
        </details>
        <p className="vt-terms-note">These terms lapse {iso(p.expiresAt)}.</p>
      </div>
    </article>
  )
}

/**
 * A vault request as another member reviews it (Workspace, requests waiting for signatures): from its stored approval
 * document, what it does, the exact text if any, and what the passkey signs; every field on request.
 */
export function VaultRequest({ document }: { document: string }) {
  let d: { summary?: string; action?: string; terms?: Record<string, unknown> & { message?: unknown; toSign?: ToSign[] } }
  try { d = JSON.parse(document) as typeof d } catch { return <pre className="doc small">{document}</pre> }
  const { message, toSign, ...rest } = d.terms ?? {}
  return (
    <article className="instrument vt-terms" aria-label={plain(String(d.summary ?? ''))}>
      <div className="i-head"><span>On-chain wallet: {KIND[String(d.action)] ?? d.action}</span><span>Not signed by you yet</span></div>
      <div className="i-body">
        <p className="i-pay">{plain(String(d.summary ?? ''))}</p>
        <p className="vt-terms-where">{whereWords(d.terms)}</p>
        {FINAL_KINDS.has(String(d.action)) ? <p className="vt-terms-where">{FINAL_WORDS}</p> : null}
        {typeof message === 'string' ? <details className="vt-fold"><summary>The exact text your passkey signs</summary><pre className="vt-pre">{message}</pre></details> : null}
        {toSign?.length ? <SignsList toSign={toSign} /> : null}
        <details className="vt-fold"><summary>Every field of the terms ({Object.keys(rest).length})</summary>
          <dl className="kv small">{Object.entries(rest).map(([k, v]) => <div key={k} className="vt-contents"><dt>{words(k)}</dt><dd className="code">{typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>)}</dl></details>
      </div>
    </article>
  )
}

type VaultPending = PendingApproval & { proposal: Proposal; sign: { item: number }[]; devices?: number }
/** What the sheet says above the exact terms, for a feature that asks for a vault approval from its own page. */
export interface VaultApprovalShown { title: string; intro?: ReactNode }
/**
 * The vault's approval flow, for any route that prepares a vault approval (the generic proposals route, or a feature's
 * own: who signs for the wallet, its recovery key, work paid through the escrow). `start(path, body)` asks the route;
 * the sheet shows the exact terms; the passkey signs digest by digest; then the request is sent once. The default opens
 * the job's page; a feature that stays where it is passes `stay`, follows the job there and hears of its end through
 * `onDone`. Closing the sheet unsigned withdraws the request.
 */
export function useVaultApproval(opts: { stay?: boolean; onDone?: (job: Job) => void; onClosed?: (sent: boolean) => void } = {}): { start: (path: string, body?: unknown, shown?: VaultApprovalShown) => Promise<boolean>; busy: boolean; error: ReturnType<typeof useAction>['error']; sheet: ReactNode; job: Job | null; watch: (jobId: string) => void; clear: () => void } {
  const [pending, setPending] = useState<(VaultPending & { shown?: VaultApprovalShown | undefined }) | null>(null)
  const sent = useRef(false)
  // With `stay`, the page that asked follows the job itself until it finishes, then hears of it (onDone).
  const [watching, watch] = useState<string | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const done = useRef(opts.onDone)
  done.current = opts.onDone
  // told when the terms close: sent (approved and handed to the vault) or not (closed unsigned)
  const closed = useRef(opts.onClosed)
  closed.current = opts.onClosed
  useEffect(() => {
    if (!watching) return undefined
    let stop = false
    setJob(null)
    const tick = async (): Promise<void> => {
      try {
        const j = await api<Job>('GET', `/api/vault/jobs/${watching}`)
        if (stop) return
        setJob(j)
        if (j.status === 'done' || j.status === 'failed' || j.status === 'interrupted' || j.status === 'reorged') { done.current?.(j); return }
      } catch { /* the next tick asks again */ }
      if (!stop) setTimeout(() => void tick(), 1200)
    }
    void tick()
    return () => { stop = true }
  }, [watching])
  // a new request replaces whatever the last one's outcome said
  const act = useAction(async (path: string, body?: unknown, shown?: VaultApprovalShown) => { sent.current = false; watch(null); setJob(null); setPending({ ...(await api<VaultPending>('POST', path, body ?? {})), shown }) })
  // Terms that list digests for the chain are signed digest by digest; the others with one signature over the document.
  const digests = pending?.sign.length ?? 0
  const sheet = (
    <ApprovalSheet approval={pending} title={pending?.shown?.title ?? `Approve: ${KIND[pending?.proposal.kind ?? ''] ?? 'a wallet action'}`} action="Approve and send to the vault" signer={digests ? signForVault : undefined} prompts={Math.max(1, digests)} devices={pending?.devices ?? 1}
      onClose={(stillOpen) => { if (pending && !sent.current && !stillOpen) void api('POST', `/api/vault/proposals/${pending.proposal.id}/cancel`).catch(() => {}); setPending(null); if (!sent.current) closed.current?.(false) }}
      onApproved={async (approvalId) => { if (!pending) return; const a = await api<{ jobId: string }>('POST', `/api/vault/proposals/${pending.proposal.id}/execute`, { approvalId }); sent.current = true; setPending(null); closed.current?.(true); if (opts.stay) watch(a.jobId); else navigate(`/vault/job/${a.jobId}`) }}>
      {pending ? <>{pending.shown?.intro ? <div className="vt-sheet-intro">{pending.shown.intro}</div> : null}<Terms p={pending.proposal} /></> : null}
    </ApprovalSheet>
  )
  return { start: act.run, busy: act.busy, error: act.error, sheet, job, watch, clear: () => { watch(null); setJob(null); act.clear() } }
}

/**
 * R13: the wallet's own revoke-mandate request for a revocation that names the chain (server/api.ts
 * prepareChainRevocation), signed with the passkey through the wallet's approval flow. Loaded on demand by the
 * revocation's view (ui/revocation.tsx), so a page that shows a revocation does not wait for the wallet's page.
 */
export function RevokeMandateSigner({ revocationId, onDone }: { revocationId: string; onDone: () => void }) {
  const va = useVaultApproval({ stay: true, onDone: () => onDone(), onClosed: () => onDone() })
  return (
    <>
      <Btn tone="void-fill" busy={va.busy} onClick={() => void va.start(`/api/revocations/${revocationId}/chain`, {}, { title: 'Revoke the wallet\'s mandate', intro: 'This ends the wallet\'s one mandate for QED\'s agent, so no instruction can pay through the wallet until you sign a new one. Your passkey signs it for the wallet\'s owner account.' })}>Sign the wallet's revocation</Btn>
      <Problem error={va.error} />
      {va.sheet}
    </>
  )
}

/** Propose a vault action, show its exact terms for approval, then execute once and open the job. */
function useVaultAction(): { propose: (kind: ProposalKind, params?: Record<string, unknown>) => Promise<boolean>; busy: boolean; error: ReturnType<typeof useAction>['error']; sheet: ReactNode } {
  const v = useVaultApproval()
  return { propose: (kind, params) => v.start('/api/vault/proposals', { kind, params: params ?? {} }), busy: v.busy, error: v.error, sheet: v.sheet }
}

/** A vault amount as a person reads it, on every tab alike: test rupees with ₹ and Indian grouping, test dollars with $, test euros with €; the unit is said in words once, beside. */
const money = (raw: string | null | undefined, a: Asset): string => (SIGN[a.symbol] ? `${SIGN[a.symbol]}${amt(raw, a)}` : `${amt(raw, a)} ${unitWords(a.symbol)}`)
/** An exact amount of a named token, with its sign (a route's hops, a venue's reserves). */
const moneyOf = (raw: string | null | undefined, token: string): string => money(raw, { symbol: token, decimals: dec(token) })
/** "a, b and c". */
const andList = (w: string[]): string => (w.length < 2 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`)
const unitWords = (sym: string): string => UNIT_MANY[sym] ?? `test ${sym}`
/** "dollar reserve", "yen reserve": the reserve vault named by its token (shared/chain-assets.ts). */
const reserveWordsOf = (sym: string): string => tokenBySymbol(sym)?.reserveWords ?? 'reserve'
const lowerFirst = (s: string): string => s.replace(/^./, (c) => c.toLowerCase())
/**
 * A headline figure: to the cent, rounded half up exactly from the raw units (never through a float), and the exact
 * figure when the cents hide digits, to be shown one step down. Test dollars carry six decimals; a headline shows two.
 */
export function headline(raw: string, a: Asset): { text: string; exact: string | null } {
  // read to the currency's minor unit: the cent, a whole yen, the fils of a dinar (S5)
  const shown = placesOf(a)
  if (a.decimals <= shown || !/^-?\d+$/.test(raw)) return { text: money(raw, a), exact: null }
  const q = 10n ** BigInt(a.decimals - shown), n = BigInt(raw), neg = n < 0n, m = neg ? -n : n
  const c = (m + q / 2n) / q
  return { text: money(`${neg ? '-' : ''}${c}`, { symbol: a.symbol, decimals: shown }), exact: m % q === 0n ? null : money(raw, a) }
}
/** A venue's two reserves, each as a headline figure in its own currency: "₹84,00,000.00 and $1,00,000.00". */
export const venueReserves = (v: { r0: string; token0: string; r1: string; token1: string }): string => `${headline(v.r0, { symbol: v.token0, decimals: dec(v.token0) }).text} and ${headline(v.r1, { symbol: v.token1, decimals: dec(v.token1) }).text}`
const CURRENCY: Record<string, string> = { tINR: 'rupees', tUSD: 'dollars', tEUR: 'euros', tETH: 'ether', tGBP: 'pounds', tAED: 'dirhams', tSGD: 'Singapore dollars', tJPY: 'yen', tBHD: 'dinars' }
/** A venue as a person names it: "tINR/tUSD · 0.30% · deep" is "Rupees and dollars, 0.30% fee, deep". */
export function venueName(v: { label: string; token0: string; token1: string; feeBps: number }): string {
  const [pair, , ...more] = v.label.split(' · ')
  const t = /^(t[A-Z]+)\/(t[A-Z]+)$/.exec(pair ?? '')
  const a = t?.[1] ?? v.token0, b = t?.[2] ?? v.token1
  return [`${cap(CURRENCY[a] ?? unitWords(a))} and ${CURRENCY[b] ?? unitWords(b)}`, `${(v.feeBps / 100).toFixed(2)}% fee`, ...more.map((x) => plain(x))].join(', ')
}

/**
 * The contract's figure for "if its keys were stolen" (QEDLens.blastRadius over 24 hours) said as the sum it is: what is
 * left of the current daily window plus the whole daily limit for the window that opens again within the 24 hours (the
 * window is one day), never more than the free balance, and nothing while the vault is paused (the word "paused" is
 * left to the stamp beside it). Null when the figures add up to none of these: nothing is said that does not add up.
 */
export function theftSum(v: Pick<VaultView, 'token' | 'decimals' | 'paused' | 'dailyCap' | 'spentInWindow' | 'free' | 'worstCaseLoss24h'>): string | null {
  const a: Asset = { symbol: v.token, decimals: v.decimals }, m = (x: bigint): string => money(x.toString(), a)
  const worst = BigInt(v.worstCaseLoss24h), cap = BigInt(v.dailyCap), spent = BigInt(v.spentInWindow), free = BigInt(v.free)
  const left = cap > spent ? cap - spent : 0n
  if (v.paused) return worst === 0n ? 'Nothing can leave until you resume it.' : null
  if (cap === 0n) return worst === 0n ? `With a daily limit of ${m(0n)}, nothing can leave.` : null
  if (worst === left + cap) return `${m(left)} left of today's limit, plus a full day's ${m(cap)} once the daily window starts again within the 24 hours.`
  if (worst === 2n * cap) return `The whole daily limit, ${m(cap)}, now, and the same again once the daily window starts again within the 24 hours.`
  if (worst === free) return `Everything free in it, ${m(free)}: the daily limits would allow more.`
  return null
}

/** Checks that stop every payment whatever its amount, and checks that cap an amount (chain/rail/service.ts checkLimits, rail/treasury.ts). */
const STOPS = new Set(['provisioned', 'mandate-valid', 'not-paused'])
const CAPS = new Set(['per-conversion', 'mandate-period', 'mandate-lifetime', 'vault-daily', 'free-buffer', 'authority-budget', 'earned-autonomy'])
const LIMIT_WORDS: Record<string, string> = {
  'per-conversion': 'your mandate\'s limit for one payment', 'mandate-period': 'what is left of your mandate\'s limit for its period', 'mandate-lifetime': 'what is left of your mandate\'s limit over its life',
  'vault-daily': 'what is left of the wallet\'s daily limit', 'free-buffer': 'the free balance, less the small buffer the co-signer keeps', 'authority-budget': 'your authority budget', 'earned-autonomy': 'the co-signer\'s allowance',
  'not-paused': 'the wallet is paused', 'mandate-valid': 'no mandate is in force', provisioned: 'the vault is not accepted yet',
}
/** The check that sets a maximum the vault service reported: one that stops everything first, else the cap whose remainder it is. */
export function bindingLimit(checks: LimitCheck[], maximum: string): LimitCheck | null {
  const stop = checks.find((c) => STOPS.has(c.id) && !c.pass)
  if (stop) return stop
  const max = BigInt(maximum)
  return checks.find((c) => CAPS.has(c.id) && c.remaining !== null && BigInt(c.remaining) === max) ?? null
}
/** A limit in the owner's words. */
export const limitWords = (c: LimitCheck | null): string => (c ? LIMIT_WORDS[c.id] ?? lowerFirst(plain(c.rule)) : 'the lowest of your limits')
/** A co-signer refusal as a headline: its rule by name ("its authority budget rule"; the number stays in the record's checks), or null for anything else. */
const ruleName = (name: string): string => lowerFirst(name.replace(/\s*\((?:R\d+ )?(?:decision )?D\d+[^)]*\)/g, '').trim())
export function refusalHead(summary: string): string | null {
  const m = /^Co-signer refused: (C\d+) not met: ([^:]+):/.exec(summary)
  return m ? `The co-signer refused it under its ${ruleName(m[2]!)} rule` : null
}
/** The vault service's request limits (its quota classes) in plain words; a class it adds later keeps its own words. */
const QUOTA_WORDS: Record<string, string> = { proposals: 'Terms prepared for your approval', operations: 'Actions it accepted', economies: 'Scripted exchanges run in the test lab' }
export const quotaWords = (cls: string, counts: string): string => QUOTA_WORDS[cls] ?? counts.replace(/^./, (c) => c.toUpperCase())

/** What QED's co-signer will still let leave the treasury now: the authority budget left, or, where the service runs the release's rule, its allowance. */
interface Allows { left: string; kind: 'budget' | 'allowance' }
const allowsOf = (room: PaymentLimits | null | undefined): Allows | null => (room ? { left: room.earned.remaining, kind: room.authority ? 'budget' : 'allowance' } : null)

/** A payee of the mandate as the owner knows it; the contract's own names for its parts, said plainly. */
const RESERVE_PAYEE = /^(Dollar|Euro) reserve$/
export const payeeName = (label: string | undefined): string => (label ?? 'Unnamed').replace(/^QEDExecution \(conversion module\)$/, 'The conversion service, for conversions you approve').replace(RESERVE_PAYEE, (_, k: string) => `Your own ${k.toLowerCase()} reserve`)
const payeeInSentence = (label: string): string => (label === 'QEDExecution (conversion module)' ? 'the conversion service (for conversions you approve)' : label.replace(RESERVE_PAYEE, (_, k: string) => `your own ${k.toLowerCase()} reserve`))
/** The mandate's payees inside a sentence: "the conversion service (for conversions you approve), your own dollar reserve and CloudCo". */
export const payeesInWords = (labels: string[]): string => andList(labels.map(payeeInSentence))

// ------------------------------------------------------------------------------------------------ the bound, in rows

/** A share of a limit, 0 to 1, from raw units, for drawing: used ÷ limit, exactly in integers first. */
export function share(used: string | null, limit: string | null): number {
  if (used === null || limit === null || !/^\d+$/.test(used) || !/^\d+$/.test(limit)) return 0
  const l = BigInt(limit)
  if (l === 0n) return 1
  return Math.min(1, Number((BigInt(used) * 10_000n) / l) / 10_000)
}
/**
 * One limit of what QED may do, as a row of the bound: what the limit is, what has been used of it, what is left, and who
 * enforces it. The mandate's limits are the wallet's contract's; the authority budget (or the release's allowance) is the
 * co-signer's own check before it signs. Raw units of the treasury's asset; nothing is computed but the labels.
 */
export interface LimitRow { id: 'payment' | 'period' | 'lifetime' | 'daily' | 'budget'; label: string; note: string | null; by: 'contract' | 'cosigner'; limit: string; used: string | null; left: string | null }
/** The binding check's id as the row it belongs to. */
export const ROW_OF: Record<string, LimitRow['id']> = { 'per-conversion': 'payment', 'mandate-period': 'period', 'mandate-lifetime': 'lifetime', 'vault-daily': 'daily', 'authority-budget': 'budget', 'earned-autonomy': 'budget' }
export function limitRows(m: Pick<MandateView, 'fields' | 'usage'>, budget: { limit: string; used: string; remaining: string; kind: 'budget' | 'allowance' } | null): LimitRow[] {
  const u = m.usage, hours = Math.round(Number(m.fields.period) / 3600)
  const rows: LimitRow[] = [
    { id: 'payment', label: 'In one payment', note: 'Each payment or conversion on its own', by: 'contract', limit: u.perPayment.limit, used: null, left: null },
    { id: 'period', label: hours === 24 ? 'In any 24 hours' : `In any ${plural(hours, 'hour')}`, note: u.period.note ? plain(u.period.note) : null, by: 'contract', limit: u.period.limit, used: u.period.spent, left: u.period.remaining },
    { id: 'lifetime', label: `In all, until ${fmt.day(Number(m.fields.validUntil) * 1000)}`, note: 'Over the mandate\'s whole life', by: 'contract', limit: u.lifetime.limit, used: u.lifetime.spent, left: u.lifetime.remaining },
    { id: 'daily', label: 'The wallet\'s own daily limit', note: 'For every mandate together, in a one-day window', by: 'contract', limit: u.vaultDaily.limit, used: u.vaultDaily.spent, left: u.vaultDaily.remaining },
  ]
  if (budget) rows.push({ id: 'budget', label: budget.kind === 'budget' ? 'Your authority budget' : 'The co-signer\'s allowance', note: budget.kind === 'budget' ? 'What you granted, plus what the wallet earned from clients outside your workspace, less what has left your control' : 'A rule of the released system: a fixed amount plus half of what the wallet earned through an escrow', by: 'cosigner', limit: budget.limit, used: budget.used, left: budget.remaining })
  return rows
}

// ------------------------------------------------------------------------------------------------ who signs, the records, the set-up

/** A sentence with its figure set apart: plain strings and the parts to set in bold. */
type Part = string | { b: string }
export interface Line { parts: Part[]; tone?: 'wait' | 'void' }
const said = (parts: Part[]): string => parts.map((p) => (typeof p === 'string' ? p : p.b)).join('')
const Said = ({ parts }: { parts: Part[] }) => <>{parts.map((p, i) => (typeof p === 'string' ? p : <strong key={i}>{p.b}</strong>))}</>
/** Who owns the wallet: passkeys (a person's wallet) or members (a shared one) that sign for its owner account, and how many must. */
export function ownersLine(g: { shared: boolean; signers: number; threshold: number | null }): Line {
  const t = g.threshold ?? 1, n = g.signers
  if (g.shared) return { parts: [{ b: `${n} members' passkeys` }, ` own it: ${t === 1 ? 'any one of them can sign' : `${t} different members must sign`} as its owner.`] }
  if (n === 0) return { parts: [{ b: 'No passkey of yours' }, ' that can sign today owns it.'], tone: 'wait' }
  if (n === 1) return { parts: [{ b: 'Your passkey' }, ' owns it: nothing is done as its owner without your signature.'] }
  return { parts: [{ b: `Your ${n} passkeys` }, ` own it: ${t === 1 ? 'any one of them can sign' : `${t} of them must sign`} as its owner.`] }
}
/** The wallet's recovery key (Security, "Who can sign for your on-chain wallet"); null while it is read, 'unread' when the read failed. */
export function recoveryLine(rec: { hasKey: boolean; delaySeconds: number } | null | 'unread'): Line {
  if (!rec) return { parts: ['Reading the wallet\'s recovery key from the chain.'] }
  if (rec === 'unread') return { parts: ['Its recovery key could not be read just now. Security shows it.'], tone: 'wait' }
  if (rec.hasKey) return { parts: [{ b: 'A recovery key is set up' }, `: with it a new passkey can be added after ${during(rec.delaySeconds)}, unless a signer stops it.`] }
  return { parts: [{ b: 'No recovery key' }, ': if every passkey that signs for it is lost, no one can act for it again.'], tone: 'wait' }
}
/** The decision records as the vault service re-hashed them; null while it is read, 'unread' when the read failed. */
export function recordsLine(r: { ok: boolean; records: number; brokenAt: number | null } | null | 'unread'): Line {
  if (!r) return { parts: ['Reading the decision records.'] }
  if (r === 'unread') return { parts: ['The records could not be checked just now.'], tone: 'wait' }
  const count = `${r.records} decision record${r.records === 1 ? '' : 's'}`
  if (r.ok) return { parts: [{ b: count }, ', each chained to the one before. The chain is intact, checked again just now.'] }
  return { parts: [{ b: count }, `. The chain is broken at no. ${r.brokenAt ?? '?'}: a record at or before it was changed after it was written.`], tone: 'void' }
}
/** A decision record's kind, as what happened. */
const RECORD_WORDS: Record<string, string> = {
  'workspace created': 'The wallet was created and offered to your owner account', 'owner provision': 'You accepted the wallet', 'faucet grant': 'The opening grant of test rupees arrived',
  'owner mandate': 'You signed a mandate', 'cosigner payment': 'The co-signer checked a payment', 'cosigner trade': 'The co-signer checked a conversion', 'owner ring fence': 'You set money aside for a creditor',
  'owner policy': 'You signed a standing policy', 'policy decision': 'QED worked out a policy tick', 'cosigner policy trade': 'The co-signer checked a policy tranche', 'approval refused': 'An approval was refused',
  'owner pause': 'You paused the wallet', 'owner resume': 'You resumed the wallet', 'owner revoke mandate': 'You revoked the mandate', 'owner withdraw': 'You withdrew to your own account', 'owner deposit': 'You deposited from your own account',
}
export const recordWords = (kind: string): string => RECORD_WORDS[words(kind)] ?? cap(words(kind))

/** One step of setting the wallet up, with what it does for the owner. */
export interface SetupStep { id: 'create' | 'accept' | 'mandate'; title: string; does: string; state: 'done' | 'now' | 'next' }
/**
 * Setting the wallet up, as three steps: create it (owned by the passkeys), accept it (its opening grant arrives),
 * say what QED may do (a mandate). `stage` is the step the owner is at; 3 is done.
 */
export function setupSteps(stage: 0 | 1 | 2 | 3, shared: boolean, threshold: number, grant = 'test rupees'): SetupStep[] {
  const state = (i: number): SetupStep['state'] => (i < stage ? 'done' : i === stage ? 'now' : 'next')
  const who = threshold === 1 ? 'any one of them' : `${threshold} different members`
  return [
    { id: 'create', title: shared ? 'Create it, owned by your members' : 'Create it, owned by your passkey', does: shared ? `QED puts a wallet on a test chain on this computer and makes your members' passkeys its owners: ${who} must sign for anything it does as owner.` : 'QED puts a wallet on a test chain on this computer and makes your passkey its owner: nothing is done as its owner without your signature.', state: state(0) },
    { id: 'accept', title: 'Accept it', does: `${!shared ? 'One signature from your passkey takes' : threshold === 1 ? 'One member\'s passkey takes' : `The passkeys of ${threshold} different members take`} ownership. Then the opening grant of ${grant} arrives; until then it can only be read.`, state: state(1) },
    { id: 'mandate', title: 'Say what QED may do', does: 'Sign a mandate: the most in one payment, in a day and in all, and until when. Until you do, QED can pay no one from it.', state: state(2) },
  ]
}

// ------------------------------------------------------------------------------------------------ the page's frame

/** Where the wallet stands: no service, not set up, offered to its owner account and not accepted yet, or owned. */
type Stage = 'unavailable' | 'none' | 'offered' | 'owned'
/** A figure with its last two decimals set smaller, as on Home: the part read first, then the exact remainder. */
function Figure({ text }: { text: string }) {
  const dot = text.lastIndexOf('.')
  return dot < 0 ? <>{text}</> : <>{text.slice(0, dot)}<span className="paise">{text.slice(dot)}</span></>
}

/**
 * The page's head, drawn before any of the wallet's data (DESIGN.md M11): the title, what the wallet is and the section
 * tabs are the same at every stage, so the largest text on a phone's first screen never waits for the vault service.
 * Only the stage stamp waits for it, in a slot whose height is kept meanwhile.
 */
function Head({ sub, state, stage, nav }: { sub: string; state?: RailState | null; stage: Stage | null; nav: boolean }) {
  const { main, reserve } = useUnits()
  const paused = !!state?.treasury.paused
  const bar = useRef<HTMLElement>(null)
  // On a phone the sections are one row that scrolls sideways: the current one is brought into view, and an edge with
  // more beyond it fades (data-more), as the shell's own section tabs do (kit.tsx SectionNav).
  useEffect(() => {
    const n = bar.current
    if (!n) return undefined
    const cur = n.querySelector<HTMLElement>('[aria-current]')
    if (cur && n.scrollWidth > n.clientWidth) {
      const left = cur.getBoundingClientRect().left - n.getBoundingClientRect().left + n.scrollLeft
      n.scrollLeft = Math.max(0, left - (n.clientWidth - cur.offsetWidth) / 2)
    }
    const edges = () => { n.dataset.more = [n.scrollLeft > 1 ? 'left' : '', n.scrollLeft + n.clientWidth < n.scrollWidth - 1 ? 'right' : ''].join(' ').trim() }
    edges()
    n.addEventListener('scroll', edges, { passive: true })
    window.addEventListener('resize', edges)
    return () => { n.removeEventListener('scroll', edges); window.removeEventListener('resize', edges) }
  }, [sub, nav])
  return (
    <>
      <header className="page-head vt-head">
        <div className="vt-head-text">
          <h1>On-chain wallet.<span className="dim"> Test money, owned by passkey.</span></h1><p><Src kind="chain" /></p>
          <p>{cap(unitWords(main.symbol))} and {unitWords(reserve.symbol)} on a chain that runs on this computer; they have no value. QED may pay from it only inside the limits of a mandate you sign, and the wallet's own contract enforces them.</p>
        </div>
        <div className="vt-head-state">
          {stage === 'owned' && state ? <Stamp tone={paused ? 'wait' : 'ok'}>{paused ? 'Paused' : 'Running'} on a local test chain</Stamp>
            : stage === 'offered' ? <Stamp tone="wait">Waiting for you to accept it</Stamp>
            : stage === 'none' ? <Stamp tone="plain">Not set up yet</Stamp>
            : stage === 'unavailable' ? <Stamp tone="wait">Vault service not reachable</Stamp> : null}
        </div>
      </header>
      {nav ? (
        <nav ref={bar} className="vt-nav" aria-label="On-chain wallet sections">
          <div className="vt-tabs">{SUBS.map(([s, w]) => <Link key={s} to={s ? `/vault/${s}` : '/vault'} current={sub === s}>{w}</Link>)}</div>
          {/* the lab's own page is "page"; inside the lab on its other page, the entry is the current section ("true") */}
          <a className="vt-lab-link" href="/vault/lab" aria-current={sub === 'lab' ? 'page' : LAB.some(([s]) => s === sub) ? 'true' : undefined} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate('/vault/lab') }}><FlaskConical aria-hidden="true" />Test lab</a>
        </nav>
      ) : null}
      {state && !state.clock.withinLimit ? <Note tone="void" title="Transactions are refused until the clocks agree">The chain's clock is ahead of this computer's ({secs(state.clock.chainSeconds)}), so the wallet refuses every transaction until they agree.</Note> : null}
    </>
  )
}

/** What this device will ask for when the passkey signs, in its own words; QED receives a signature only. */
function Device({ times = 1 }: { times?: number }) {
  return <p className="vt-device"><span className="vt-device-i" aria-hidden="true"><Fingerprint /></span><span>Your device will ask for {deviceWords()}{times > 1 ? `, ${plural(times, 'time')}` : ''}. QED never receives your fingerprint, face or PIN: only a signature.</span></p>
}

// ------------------------------------------------------------------------------------------------ setting it up: a short guided checkout

const RAIL: Record<SetupStep['id'], string> = { create: 'Create', accept: 'Accept', mandate: 'What QED may do' }

/**
 * The short guided flow that sets the wallet up, as a checkout (the Spend journey's pattern): a progress rail and three
 * numbered steps on the left, the current one open with its action; on the right the wallet as it forms, each fact
 * ticked once it is true.
 */
function SetupFlow({ stage, shared, threshold, title, intro, done, summary, children }: { stage: 0 | 1 | 2; shared: boolean; threshold: number; title: string; intro: string; done?: Partial<Record<SetupStep['id'], string>>; summary: ReactNode; children: ReactNode }) {
  // the treasury's token: the wallet's once it exists; before that, the one the owner has chosen (S5)
  const { main } = useUnits()
  const steps = setupSteps(stage, shared, threshold, unitWords(main.symbol))
  const WORD = { done: 'Done', now: 'Now', next: 'Then' } as const
  return (
    <div className="vt-setup">
      <section className="panel vt-setup-flow" aria-labelledby="su-h">
        <div className="vt-setup-head">
          <div className="vt-setup-title"><h2 id="su-h">{title}</h2><p>{intro}</p></div>
          {/* the same three steps as the list below, drawn as a rail: the list carries them for a screen reader */}
          <ol className="vt-rail" aria-hidden="true">{steps.map((s, i) => <li key={s.id} className={s.state}><i>{s.state === 'done' ? <Check /> : i + 1}</i><span>{RAIL[s.id]}</span></li>)}</ol>
        </div>
        <ol className="vt-steps">
          {steps.map((s, i) => (
            <li key={s.id} className={`vt-step ${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
              <span className="vt-step-n" aria-hidden="true">{s.state === 'done' ? <Check /> : i + 1}</span>
              <div className="vt-step-body">
                <div className="vt-step-top"><h3 id={s.id === 'mandate' ? 'vm-h' : undefined}>{s.title}</h3><span className="vt-step-state">{WORD[s.state]}</span></div>
                <p className="vt-step-does">{s.state === 'done' && done?.[s.id] ? done[s.id] : s.does}</p>
                {s.state === 'now' ? <div className="vt-step-act">{children}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel vt-setup-sum" aria-labelledby="vs-sum-h">{summary}</section>
    </div>
  )
}

/** The wallet as it forms during set-up: who signs, where, what it holds, what QED may do and its recovery. */
function SetupSummary({ stage, o }: { stage: 0 | 1 | 2; o: Overview }) {
  const { main } = useUnits()
  const st = o.state
  const shared = !!o.plan || !!o.shared
  const threshold = o.workspace?.threshold ?? o.plan?.threshold ?? 1
  const signing = o.passkeys.filter((p) => p.signer)
  const who: ReactNode = shared
    ? (o.plan ? <>One passkey of each member who may sign: {o.plan.members.map((m) => `${m.name} (${m.passkey ?? 'no passkey yet'})`).join(', ')}. {o.plan.threshold} different members must sign, checked by the chain itself.</>
      : o.signers?.length ? <>{andList(o.signers.map((m) => `${m.you ? 'you' : m.name} (${m.passkey})`))}; {threshold === 1 ? 'any one of them can sign' : `${threshold} different members must sign`}, checked by the chain itself.</> : 'Your members\' passkeys, as the chain names them.')
    : stage === 0 ? (o.owner?.state === 'ready' ? <>{andList(o.owner.passkeys.map((n) => `“${n}”`))}: {o.owner.passkeys.length === 1 ? 'your passkey' : 'your passkeys'}. One signature is enough.{o.owner.waiting?.length ? ` ${andList(o.owner.waiting.map((w) => `“${w.passkey}”`))} ${o.owner.waiting.length === 1 ? 'was' : 'were'} added less than 24 hours ago and can be made a signer later, under Security.` : ''}</>
      : o.owner ? 'No passkey yet that can own it: see the first step.'
      : <>{o.passkeys.length ? o.passkeys.map((p) => p.name).join(', ') : 'None yet'}: the passkeys this account can use today. One signature is enough.</>)
    : <>{signing.length ? andList(signing.map((p) => `“${p.name}”`)) : 'Your passkey'}. One signature is enough, checked by the chain itself.</>
  const rows: { k: string; v: ReactNode; done: boolean }[] = [
    { k: 'Who can sign', v: who, done: stage > 0 },
    { k: 'Where you can sign', v: stage === 0 || !o.origin ? 'On this web address only. The wallet checks the address of every signature, and it is fixed now.' : <>At <span className="code">{o.origin}</span> only. The wallet checks the address of every signature.</>, done: stage > 0 },
    { k: 'What it holds', v: stage < 2 || !st ? `Nothing yet. Accepting it brings the opening grant of ${unitWords(main.symbol)}.` : <><b>{headline(st.treasury.balance, main).text}</b> in {unitWords(main.symbol)}, the opening grant.</>, done: stage === 2 },
    { k: 'What QED may do', v: 'Nothing, until you sign a mandate.', done: false },
    { k: 'If every passkey is lost', v: 'No recovery key yet. One can be added under Security once the wallet is yours.', done: false },
  ]
  return (
    <>
      <div className="vt-sum-head"><h2 id="vs-sum-h">Your wallet</h2><span className="vt-test">Test tokens, no value</span></div>
      <dl className="vt-sum">
        {rows.map((r) => <div key={r.k} className={r.done ? 'done' : ''}><dt><span className="vt-sum-mark" aria-hidden="true">{r.done ? <Check /> : null}</span>{r.k}</dt><dd>{r.v}</dd></div>)}
      </dl>
      <p className="vt-sum-foot">A chain that runs on this computer: not a public chain, and nothing on it has any value.</p>
    </>
  )
}

/**
 * R14: what stands between this account and a wallet it can own, said where the person is, with the way through on the
 * same page. A wallet is owned by a passkey, so:
 *   - an account opened with a password makes its first passkey here (the password again, then the device's own check);
 *     that passkey has no 24-hour wait, because the account has no older passkey whose authority it could be taking;
 *   - a browser that cannot make passkeys, or a device with no screen lock for one, is told exactly that and what to use;
 *   - a passkey that signs in only, or one in its first 24 hours beside an older one, is told why and from when.
 * Nothing here decides anything: the server's rule does (server/rail.ts ownerReadiness), and refuses the same way.
 */
function OwnerGate({ owner, reload }: { owner: OwnerReadiness | undefined; reload: () => void }) {
  const session = useSession()
  const [pw, setPw] = useState('')
  // whether this device can hold a passkey itself; null until the browser has answered (and where it cannot say)
  const [builtIn, setBuiltIn] = useState<boolean | null>(null)
  useEffect(() => { let on = true; void platformPasskeyAvailable().then((v) => { if (on) setBuiltIn(v) }); return () => { on = false } }, [])
  const add = useAction(async () => { await addFirstPasskey(pw); setPw(''); await session.reload(); reload() })
  if (!owner || owner.state === 'ready') return null
  if (owner.state === 'signin-only') return (
    <Note tone="wait" title="Your passkey signs you in, but cannot own a wallet yet">
      It was added by a recovery or after a password reset, so for now it signs you in only. Ask for its approval authority under <Link to="/security">Security and recovery</Link>: it takes effect after a wait in which every device and address of yours is told and can stop it. Then come back here and set the wallet up.
    </Note>
  )
  if (owner.state === 'cooling-off') return (
    <Note tone="wait" title={`You can set the wallet up from ${fmt.dayTime(owner.until)}`}>
      “{owner.passkey}” was added to this account less than 24 hours ago, and a passkey can own a wallet only after its first 24 hours: someone who got into your session must not be able to put their own passkey on your wallet. Nothing else needs doing; come back then.
    </Note>
  )
  if (!passkeysAvailable()) return (
    <Note tone="void" title="This browser cannot make a passkey">
      A wallet is owned by a passkey, and this browser has no support for them (or this page is not open over a secure connection). Open QED in a current Chrome, Safari, Edge or Firefox, on a phone or computer with a screen lock, and sign in there with your handle and password: your account is the same everywhere. Until then you can use everything that needs no approval.
    </Note>
  )
  return (
    <div className="vt-gate" role="group" aria-labelledby="vt-gate-h">
      <h4 id="vt-gate-h">First, a passkey on this device</h4>
      <p>This account signs in with a password, and a wallet is owned by a passkey: a key your device keeps and unlocks with {deviceWords()}. Enter your password and your device makes one. It then signs in for you and approves what you pay.</p>
      {builtIn === false ? <Note tone="wait" title="This device has no screen lock a passkey can use">It has no fingerprint, face check or PIN set up for passkeys. You can still make one: when you continue, your browser offers a phone nearby (scan its code with the phone&apos;s camera) or a security key with a PIN. Or turn on this device&apos;s screen lock (Touch ID, Windows Hello or a PIN) and come back.</Note> : null}
      <form className="vt-gate-form" onSubmit={(e) => { e.preventDefault(); if (pw) void add.run() }}>
        <Field label="Your password" hint="Asked again because a passkey is added only right after it is typed.">{(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
        <div><Btn tone="fill" type="submit" busy={add.busy} disabled={!pw}><Fingerprint aria-hidden="true" />Create a passkey on this device</Btn></div>
      </form>
      <Problem error={add.error} />
    </div>
  )
}

/**
 * Setting up a household's vault. The rail deploys an owner account whose signers are this person's passkeys and a
 * vault set offered to it; the person then accepts it with their passkey (the `provision` proposal).
 */
function SetUp({ o, reload }: { o: Overview; reload: () => void }) {
  const here = typeof location === 'undefined' ? '' : location.origin
  // R13: chosen at set-up, off unless asked for; changeable under Security (on at once, off after the wallet's delay)
  const [timeLock, setTimeLock] = useState(false)
  // Money-model S5: the wallet's test tokens; the default unless the owner chooses and signs others
  const [tokens, setTokens] = useState<AssetSet>({ ...DEFAULT_ASSET_SET })
  const chosen = tokens.treasury !== DEFAULT_ASSET_SET.treasury || tokens.reserve !== DEFAULT_ASSET_SET.reserve || tokens.route !== DEFAULT_ASSET_SET.route
  const distinct = new Set([tokens.treasury, tokens.reserve, tokens.route]).size === 3
  const go = useAction(async () => {
    // Registering passkeys as the signers of an account that will own funds is a change of authority: a fresh passkey confirmation first.
    await confirmWithPasskey()
    if (chosen) await setUpVaultWithTokens(here, tokens, timeLock)
    else await api('POST', '/api/vault/setup', { origin: here, ...(timeLock ? { timeLock: true } : {}) })
    reload()
  })
  const ws = o.workspace
  if (!o.canSetUp) return <Note tone="wait" title="This workspace has no wallet yet">{o.whyNot}</Note>
  const allowed = o.origins.includes(here)
  const missing = o.plan?.members.filter((m) => !m.passkey) ?? []
  const shared = !!o.plan
  // a household's wallet needs a passkey of its owner that can own one now (server/rail.ts ownerReadiness); a shared one, its members'
  const ownerReady = shared ? o.passkeys.length > 0 : o.owner ? o.owner.state === 'ready' : o.passkeys.length > 0
  const unit = (c: AssetSet['treasury']): Asset => ({ symbol: CHAIN_TOKENS[c].symbol, decimals: CHAIN_TOKENS[c].decimals })
  return (
    <Units.Provider value={{ main: unit(tokens.treasury), reserve: unit(tokens.reserve) }}>
    <SetupFlow stage={0} shared={shared} threshold={o.plan?.threshold ?? 1} title={shared ? 'Set up this workspace\'s wallet' : 'Set up your wallet'}
      intro={`Three steps. ${shared ? 'Your members\' passkeys' : 'Your passkey'} signs each one over the exact terms, and the vault service holds no key that could stand in for ${shared ? 'them' : 'it'}.`}
      summary={<SetupSummary stage={0} o={o} />}>
      {o.lost ? <Note tone="wait" title="Your earlier wallet is no longer on the vault service">The service on this computer was started with a new data folder, so the chain that held your wallet is gone. Its tokens were valueless test tokens. Setting up makes a new wallet.</Note> : null}
      {ws?.status === 'failed' ? <Note tone="void" title="Setting up stopped before it finished">Nothing of yours was at stake: the wallet holds nothing until you accept it. Try again; each step that already happened is skipped.</Note> : null}
      {ws?.status === 'deploying' ? <Note tone="wait" title="Your wallet is being created">This takes a few seconds. If it does not finish, try again: each step that already happened is skipped.</Note> : null}
      {!allowed ? <Note tone="void">This page is at {here}, which QED does not accept for passkeys. Open QED at {o.origins.join(' or ')}.</Note> : null}
      {missing.length ? <Note tone="wait">{missing.map((m) => m.name).join(', ')} {missing.length === 1 ? 'has' : 'have'} no passkey that can sign yet. Every member who may sign needs one before the wallet is set up.</Note> : null}
      {/* a greyed button must say why, and the way through is on this page (R14): no trip to another screen, no dead end */}
      {!shared ? <OwnerGate owner={o.owner} reload={reload} /> : null}
      {ownerReady ? <Device /> : null}
      {!shared ? (
        <details className="vt-fold">
          <summary>Test tokens: {CHAIN_TOKENS[tokens.treasury].many}, {CHAIN_TOKENS[tokens.reserve].many} and {CHAIN_TOKENS[tokens.route].many}{chosen ? ', your choice' : ', the usual ones'}</summary>
          <p className="vt-fold-p">The wallet holds valueless test tokens on the chain on this computer: its treasury one kind, its reserve another, and conversions may pass through a third. You may choose them from the eight currencies QED&apos;s paper bank holds. Nothing chooses them for you: other tokens than the usual ones are used only once your passkey signs them, as a second prompt, and they are fixed when the wallet is created. None of them is money, and choosing them opens no way to move real money.</p>
          {(['treasury', 'reserve', 'route'] as const).map((k) => (
            <Field key={k} label={k === 'treasury' ? 'The treasury holds' : k === 'reserve' ? 'The reserve holds' : 'Conversions may pass through'}>
              {(p) => <select {...p} className="input" value={tokens[k]} onChange={(e) => setTokens({ ...tokens, [k]: e.target.value as AssetSet['treasury'] })}>{CHAIN_CURRENCIES.map((c) => <option key={c} value={c}>{cap(CHAIN_TOKENS[c].many)} ({c})</option>)}</select>}
            </Field>
          ))}
          {!distinct ? <Note tone="void">Choose three different currencies.</Note> : null}
        </details>
      ) : null}
      <label className="row small vt-timelock"><input type="checkbox" checked={timeLock} onChange={(e) => setTimeLock(e.target.checked)} /> Time-lock withdrawals and resuming: withdrawing, setting money aside for a creditor, resuming after a pause and replacing the vault's guardian then wait the wallet's delay, and any signer can cancel them. You can change this later under Security; turning it off waits the delay.</label>
      <div><Btn tone="fill" className="lg" busy={go.busy} disabled={!ownerReady || !allowed || missing.length > 0 || !distinct} onClick={() => void go.run()}><Fingerprint aria-hidden="true" />{chosen ? 'Confirm with your passkey, sign the test tokens and set it up' : 'Confirm with your passkey and set it up'}</Btn></div>
      <Problem error={go.error} />
      <details className="vt-fold"><summary>More about signers, and the address</summary><p className="vt-fold-p">{shared ? 'Each member\'s signer is the first passkey they registered that can sign today. A member or a passkey added later is not a signer until it is made one under Security, "Who can sign for your on-chain wallet". A larger number of signatures this workspace asks for above a size is checked by QED, not by the chain.' : 'A passkey you add later is not a signer until you make it one under Security, "Who can sign for your on-chain wallet".'} Signatures are accepted from <span className="code">{here}</span> only.</p></details>
    </SetupFlow>
    </Units.Provider>
  )
}

/** The second step: the wallet exists and is offered to its owner account; one signature accepts it. */
function Accept({ o, shared, threshold }: { o: Overview; shared: boolean; threshold: number }) {
  const va = useVaultAction()
  return (
    <>
      <SetupFlow stage={1} shared={shared} threshold={threshold} title="Your wallet is waiting for you to accept it" intro="It is created and offered to your owner account. Until you accept it, nothing but reading is possible."
        done={{ create: `Created ${iso(o.workspace?.createdAt)}, owned by ${shared ? 'your members\' passkeys' : 'your passkey'}.` }} summary={<SetupSummary stage={1} o={o} />}>
        <Device />
        <div><Btn tone="fill" className="lg" busy={va.busy} onClick={() => void va.propose('provision')}><Fingerprint aria-hidden="true" />Review it and accept with your passkey</Btn></div>
        <Problem error={va.error} />
        <details className="vt-fold"><summary>Who controls it, in technical terms</summary><p className="vt-fold-p">{o.custody}</p><Custody o={o} /></details>
      </SetupFlow>
      {va.sheet}
    </>
  )
}

/** The mandate's fields, signed together: how much in one payment, in a day, in all, and for how many days. */
function MandateForm({ st, first }: { st: RailState; first: boolean }) {
  const va = useVaultAction()
  const { main } = useUnits()
  const [per, setPer] = useState('2500'), [period, setPeriod] = useState(''), [total, setTotal] = useState(''), [days, setDays] = useState('7')
  const sign = () => void va.propose('mandate', { maxPerPayment: per.trim(), ...(period.trim() ? { maxPerPeriod: period.trim() } : {}), ...(total.trim() ? { maxTotal: total.trim() } : {}), ...(days.trim() ? { validDays: Number(days) } : {}) })
  return (
    <>
      <form className="vt-mform" onSubmit={(e) => { e.preventDefault(); sign() }}>
        <div className="form-grid vt-mgrid">
          <Field label={`Most in one payment, in ${unitWords(main.symbol)}`} hint={`Up to the wallet's daily limit of ${money(st.treasury.dailyCap, main)}.`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={per} onChange={(e) => setPer(e.target.value)} /></div>}</Field>
          <Field label={`Most in a day, in ${unitWords(main.symbol)}`} hint="Optional.">{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={period} onChange={(e) => setPeriod(e.target.value)} /></div>}</Field>
          <Field label={`Most over its whole life, in ${unitWords(main.symbol)}`} hint="Optional.">{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></div>}</Field>
          <Field label="Valid for how many days" hint="1 to 30.">{(p) => <input {...p} className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
        </div>
        <div className="vt-form-foot"><Btn tone="fill" type="submit" busy={va.busy}>See the exact mandate</Btn><p>{first ? 'Nothing is signed until you approve the exact mandate with your passkey. A limit you leave empty is set by the vault service and shown before you sign.' : 'Signing a new one revokes the one in force, on the chain, first.'}</p></div>
        <Problem error={va.error} />
      </form>
      {va.sheet}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ the overview: what it holds

/**
 * A vault's money. The treasury leads the page: its balance as the hero, the bar of what is free and what is set aside
 * with QED's bracket over the most it may still move, and the three parts as tiles. The reserve is a small card. The
 * paused stamp is the only place the word appears inside an account (the browser journeys find it there by that word).
 */
function Account({ v, name, unit, lead, bound = 0n, until = null, mandate = false }: { v: VaultView; name: string; unit: string; lead?: boolean; bound?: bigint; until?: number | null; mandate?: boolean }) {
  const a: Asset = { symbol: v.token, decimals: v.decimals }
  // every figure to the cent; the balance's exact figure, when the cents hide digits, on a quiet line below it
  const m = (raw: string | null | undefined): string => headline(raw ?? '0', a).text
  const top = headline(v.balance, a)
  const promised = v.openLiabilities !== '0' ? <small>for {v.openLiabilities} promised payment{v.openLiabilities === '1' ? '' : 's'}</small> : null
  const head = <div className="va-head"><h3>{name}</h3><span className="va-unit">{unit}</span>{v.paused ? <Stamp tone="wait">Paused</Stamp> : null}</div>
  if (!lead) {
    return (
      <section className="vault-acct vt-mini" aria-label={name}>
        {head}
        <p className="lead">{top.text}</p>
        {top.exact ? <p className="va-exact">Exactly {top.exact}</p> : null}
        <dl className="va-lines">
          <div><dt>Free</dt><dd>{m(v.free)}</dd></div>
          <div><dt>Set aside for promises</dt><dd>{m(v.ringFenced)}{promised}</dd></div>
        </dl>
      </section>
    )
  }
  const when = until ? ` before ${fmt.day(until)}` : ''
  // what QED may still move, said without the word the paused stamp uses
  const mayWhy = !mandate ? 'No mandate is in force' : v.paused ? 'Until you resume the wallet' : bound > 0n ? `At most${when}, from the free part only` : BigInt(v.free) === 0n ? 'Nothing in the treasury is free' : 'Your mandate allows nothing more in all'
  return (
    <section className="vault-acct primary" aria-label={name}>
      <div className="vt-acct-top">{head}<span className="vt-acct-note">Valueless test tokens on a chain on this computer</span></div>
      <p className="lead" data-resolve=""><Figure text={top.text} /></p>
      {top.exact ? <p className="va-exact">Exactly {top.exact}</p> : null}
      <TreasuryBar v={v} bound={bound} when={when} />
      <dl className="va-lines vt-tiles">
        <div className="tile"><dt><Swatch tone="free" />Free</dt><dd className="vt-tile-v">{m(v.free)}</dd><dd className="vt-tile-s">Payments and withdrawals come from this part</dd></div>
        <div className="tile"><dt><Swatch tone="kept" />Set aside for promises</dt><dd className="vt-tile-v">{m(v.ringFenced)}</dd><dd className="vt-tile-s">{v.openLiabilities !== '0' ? `For ${v.openLiabilities} promised payment${v.openLiabilities === '1' ? '' : 's'}; only ever payable to whom it was promised` : 'Only ever payable to whom it was promised'}</dd></div>
        <div className="tile vt-qed"><dt><Swatch tone="reach" />QED may move</dt><dd className="vt-tile-v">{bound > 0n ? m(bound.toString()) : 'Nothing'}</dd><dd className="vt-tile-s">{mayWhy}</dd></div>
      </dl>
    </section>
  )
}

/**
 * The treasury at true scale on the money bar (DESIGN.md M14): what is free, what is set aside for promises, and the span
 * of the most QED may still move under the free part it must come from.
 */
function TreasuryBar({ v, bound, when }: { v: VaultView; bound: bigint; when: string }) {
  const a: Asset = { symbol: v.token, decimals: v.decimals }, m = (x: bigint): string => headline(x.toString(), a).text
  const free = BigInt(v.free), kept = BigInt(v.ringFenced), total = BigInt(v.balance)
  const label = `${m(free)} free and ${m(kept)} set aside: ${m(total)} in the treasury. ${bound > 0n ? `Your mandate lets QED move at most ${m(bound)} more${when}, from the free part only.` : 'QED may move nothing from it now.'}`
  return <MoneyBar className="vt-bar" label={label} parts={[{ tone: 'free', value: Number(free), reach: Number(bound) }, { tone: 'kept', value: Number(kept) }]} />
}

/**
 * Money-model S5: what the wallet holds of each of its test tokens, over its three holders (the treasury holds only its
 * own token, the reserve only its own; the owner's own account may hold both). Each in its own decimals and words.
 */
export function currencyHoldings(st: Pick<RailState, 'treasury' | 'reserve' | 'ownerHolds'>): { symbol: string; words: string; total: string; parts: [string, string][] }[] {
  const line = (v: Pick<VaultView, 'token' | 'decimals' | 'balance'>, where: string, own: string) => {
    const a: Asset = { symbol: v.token, decimals: v.decimals }, h = (raw: string) => headline(raw, a).text
    return { symbol: v.token, words: unitWords(v.token), total: h((BigInt(v.balance) + BigInt(own)).toString()), parts: [[where, h(v.balance)], ['In your own account', h(own)]] as [string, string][] }
  }
  return [line(st.treasury, 'In the treasury', st.ownerHolds?.asset ?? '0'), line(st.reserve, 'In the reserve', st.ownerHolds?.reserveAsset ?? '0')]
}

/** The panel the overview leads with: the treasury, then the reserve and the owner's own account on the same chain. */
function Holds({ st, active, col }: { st: RailState; active: MandateView | null; col: string }) {
  const { main } = useUnits()
  const t = st.treasury
  const left = active ? BigInt(active.usage.lifetime.remaining) : 0n
  const bound = active && !t.paused ? (left < BigInt(t.free) ? left : BigInt(t.free)) : 0n
  const byCurrency = currencyHoldings(st)
  return (
    <section data-col={col} className="panel vt-hold" aria-labelledby="wh-h">
      <h2 id="wh-h" className="sr">What the wallet holds</h2>
      <Account v={t} name="Treasury" unit={unitWords(t.token)} lead bound={bound} until={active ? active.usage.validity.validUntil * 1000 : null} mandate={!!active} />
      <p className="vt-also-k">Also on this chain</p>
      <div className="vt-also">
        <Account v={st.reserve} name="Reserve" unit={unitWords(st.reserve.token)} />
        <div className="vt-mini vt-ownacct">
          <div className="va-head"><p className="vt-mini-h">Your own account on the chain</p></div>
          <p className="vt-mini-v">{headline(st.ownerHolds?.asset ?? '0', main).text}</p>
          {(st.ownerHolds?.reserveAsset ?? '0') !== '0' ? <p className="vt-mini-s">and {headline(st.ownerHolds!.reserveAsset, { symbol: st.reserve.token, decimals: st.reserve.decimals }).text}</p> : null}
          <p className="vt-mini-s">Outside the wallet: refunds and your withdrawals land here</p>
        </div>
      </div>
      <p className="vt-also-k" id="wh-cur">By currency</p>
      <dl className="va-lines vt-bycur" aria-labelledby="wh-cur">
        {byCurrency.map((c) => <div key={c.symbol}><dt>{cap(c.words)}</dt><dd>{c.total}<small>{c.parts.map(([w, x]) => `${w.replace(/^In /, 'in ')} ${x}`).join('; ')}</small></dd></div>)}
      </dl>
      <p className="vt-mini-s">Valueless test tokens on a chain on this computer, one per currency, each counted in its own units; never added together and never money.</p>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the overview: what QED may do

/** One limit of what QED may do, as a tile: the limit, what is left as a meter in QED's tide, what is used, who enforces it. */
function LimitTile({ r, a, binds }: { r: LimitRow; a: Asset; binds: boolean }) {
  const m = (raw: string): string => headline(raw, a).text
  const left = r.left === null ? null : r.limit === '0' ? 0 : share(r.left, r.limit)
  return (
    <li className={`tile vt-lim ${binds ? 'binds' : ''}`}>
      <p className="vt-lim-k">{r.label}{binds ? <span className="vt-binds">Binds now</span> : null}</p>
      <p className="vt-lim-v">{r.left !== null ? <>{m(r.left)}<small> left</small></> : <>{m(r.limit)}<small> at most</small></>}</p>
      {left !== null ? <span className="meter" aria-hidden="true"><i style={{ width: `${(left * 100).toFixed(2)}%` }} /></span> : null}
      <p className="vt-lim-s">{r.left !== null ? `${m(r.used ?? '0')} used of ${m(r.limit)}` : 'Each payment or conversion on its own'}</p>
      {r.note && r.id !== 'payment' ? <p className="vt-lim-n">{r.note.replace(/\.+$/, '')}.</p> : null}
      <EnforcedBy by={r.by === 'contract' ? 'contract' : 'qed'} />
    </li>
  )
}

/** What QED may do with the wallet: the most it may pay now, the mandate's limits as meters, to whom, on its own, and the worst case if QED's keys were stolen. */
function MayDo({ st, room, col }: { st: RailState; room: { data: PaymentLimits | null; error: unknown }; col: string }) {
  const { main, reserve } = useUnits()
  const now = useNow(60_000)
  const m = st.mandate?.status === 'active' ? st.mandate : null
  const t = st.treasury
  const worst = theftSum(t)
  const scope = lowerFirst(plain(t.worstCaseScope).replace(/,? within the vault's daily cap\./, ', up to the daily limit in each daily window.'))
  // QEDLens.blastRadius counts the pause, the free balance and the daily limit's window, not the mandate: an upper bound
  const worstLine = (
    <div className="vt-worst">
      <span className="vt-worst-i" aria-hidden="true"><ShieldAlert /></span>
      <div className="vt-worst-t">
        <p>{m ? <><strong>If QED's two keys were stolen</strong>, at most</> : <>Even so, the contract's own upper bound <strong>if QED's two keys were stolen</strong> is</>} <strong className="vt-worst-v">{headline(t.worstCaseLoss24h, main).text}</strong> {m ? 'could leave in 24 hours' : 'in 24 hours'}{worst ? `: ${lowerFirst(worst)}` : '.'}</p>
        <details className="vt-fold"><summary>What this figure covers</summary><p className="vt-fold-p">The contract's own figure for the worst case in which both keys QED's service uses, to pay and to check payments, are stolen: {scope} It counts the wallet's daily limit and its free balance, whether or not a mandate is in force, so it is an upper bound.</p></details>
      </div>
    </div>
  )
  if (!m) {
    return (
      <section data-col={col} className="panel vt-may" aria-labelledby="wm-h">
        <div className="panel-head"><h2 id="wm-h">What QED may do with it</h2></div>
        <div className="vt-now"><p className="vt-now-k">The most QED may pay now</p><p className="vt-now-v">Nothing</p>
          <p className="vt-now-s">{st.mandate ? `Your mandate, version ${st.mandate.version}, is ${st.mandate.status}` : 'No mandate is in force'}, so QED can pay no one from it. <a href="#vm-h">Sign a mandate</a></p></div>
        {worstLine}
      </section>
    )
  }
  const budget = room.data ? { ...room.data.earned, kind: room.data.authority ? 'budget' as const : 'allowance' as const } : null
  const rows = limitRows(m, budget)
  const binds = room.data ? bindingLimit(room.data.checks, room.data.maximum) : null
  const bindsRow = binds ? ROW_OF[binds.id] ?? null : null
  const v = m.usage.validity, from = v.validFrom * 1000, until = v.validUntil * 1000
  const elapsed = until > from ? Math.min(1, Math.max(0, (now - from) / (until - from))) : 1
  const daysLeft = Math.max(0, Math.round((until - now) / 86_400_000))
  const policy = st.policy?.status === 'active' ? st.policy : null
  return (
    <section data-col={col} className="panel vt-may" aria-labelledby="wm-h">
      <div className="panel-head"><h2 id="wm-h">What QED may do with it</h2><p>Your mandate, version {m.version}, signed {iso(m.signedAt)}. <Link to="/vault/mandate">Read the mandate</Link></p></div>
      <div className="vt-now">
        <p className="vt-now-k">The most QED may pay in one payment now</p>
        <p className="vt-now-v" data-resolve="">{t.paused ? 'Nothing' : room.data ? <Figure text={money(room.data.maximum, main)} /> : room.error ? 'Not read' : <span className="skel vt-skel" aria-hidden="true" />}</p>
        <p className="vt-now-s">{t.paused ? 'Until you resume the wallet.' : room.data ? `Set by ${limitWords(binds)}.` : room.error ? 'What can be paid now could not be read just now.' : 'Reading what can be paid now.'}</p>
      </div>
      <EnforcementKey />
      <ul className="vt-lims">
        {rows.map((r) => <LimitTile key={r.id} r={r} a={main} binds={!t.paused && bindsRow === r.id} />)}
        <li className="tile vt-lim vt-time">
          <p className="vt-lim-k">Until {fmt.day(until)}, {fmt.time(until)}</p>
          <p className="vt-lim-v">{v.active ? <>{plural(daysLeft, 'day')}<small> left</small></> : 'Not in force now'}</p>
          <span className="meter vt-meter-time" aria-hidden="true"><i style={{ width: `${((1 - elapsed) * 100).toFixed(2)}%` }} /></span>
          <p className="vt-lim-s">{v.active ? 'Of the mandate\'s time' : 'Outside its window'}; signed {fmt.day(from)}</p>
          <p className="vt-lim-n">After it ends QED can pay no one until you sign another.</p>
          <EnforcedBy by="contract" />
        </li>
      </ul>
      <dl className="vt-scope">
        <div><dt>Only to</dt><dd><span>{cap(payeesInWords(m.payeeLabels))}.</span><EnforcedBy by="contract" /></dd></div>
        {policy ? (
          <div><dt>On its own</dt><dd><span>Your standing policy keeps at least {headline(policy.targetFree, reserve).text} free in the {reserveWordsOf(reserve.symbol)}, converting {money(policy.minTranche, main)} to {money(policy.maxTranche, main)} at a time when it falls short{policy.targetMet ? '' : `, short by ${headline(policy.shortfall, reserve).text} now`}, inside the limits above. {policy.enforcement === 'contract' ? 'A policy contract on the chain refuses any other tranche.' : 'QED\'s co-signer works each tranche out again before it signs.'} Every five minutes while QED runs; pausing QED stops it. <Link to="/vault/policy">Automatic conversions</Link></span>
            <EnforcedBy by={policy.enforcement === 'contract' ? 'contract' : 'qed'} /></dd></div>
        ) : null}
      </dl>
      {worstLine}
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the overview: who owns it

/** Who signs for the wallet's owner account, as the vault service reads it from the chain, with what the service warns of. */
type Signer = SignersView['signers'][number]
const signerName = (s: Signer): string => (s.passkey ? `${s.passkey.you ? 'Your' : `${s.passkey.person.name}'s`} passkey “${s.passkey.name}”` : 'A signer QED does not know')

/**
 * Who may do what with the wallet, each with who enforces it. Every sentence is one the wallet's pages already make
 * (the mandate, the keys, the promises, the delay); nothing here grants or checks anything.
 */
function Roles({ o, st, keys, recDelay, allows }: { o: Overview; st: RailState; keys: number; recDelay: number | null; allows: Allows['kind'] | null }) {
  const m = st.mandate?.status === 'active' ? st.mandate : null
  const rows: { who: string; does: string; by: Enforcer }[] = [
    { who: o.shared ? 'Your members' : 'You', does: 'As its owner: sign mandates, pause and resume it, set money aside, move your own money in and out, and change who signs.', by: 'contract' },
    { who: 'QED\'s paying key', does: m ? `Pays only under your mandate: within its limits and only to the payees it names${m.fields.requireCosign ? ', each time with a certificate from the co-signer that works once' : ''}.` : 'Can pay no one: no mandate is in force.', by: 'contract' },
    { who: 'QED\'s co-signer', does: `Checks each payment and conversion against eight rules of its own${allows === 'budget' ? ', your authority budget among them,' : allows === 'allowance' ? ', its allowance among them,' : ''} before it signs.${st.roles.cosignerIsolation === 'separate-process' ? ' Its key is held in its own process.' : ''}`, by: 'qed' },
    { who: 'The guardian key', does: 'Can pause the wallet. It cannot resume it.', by: 'contract' },
    ...(keys && recDelay !== null ? [{ who: 'Your recovery key', does: `Can add a new passkey as a signer after ${during(recDelay)}, unless a signer stops it.`, by: 'contract' as const }] : []),
    { who: 'Anyone', does: 'Can pay a promise that has fallen due, to its creditor only, even while the wallet is paused, and can apply a scheduled change once its delay has passed, exactly as you approved it.', by: 'contract' },
  ]
  return <ul className="vt-roles">{rows.map((r) => <li key={r.who}><p className="vt-role-who">{r.who}</p><p className="vt-role-does">{r.does}</p><EnforcedBy by={r.by} /></li>)}</ul>
}

/** Who owns the wallet: how many must sign, its signers, its recovery key, the delay that protects it, and who may do what. */
function Owners({ o, st, signers, allows, col, flagged }: { o: Overview; st: RailState; signers: { data: SignersView | null; error: unknown }; allows: Allows['kind'] | null; col: string; flagged: boolean }) {
  const d = signers.data
  const split = d ? splitSigners(d.signers) : null
  const members = split?.members ?? null, keys = split?.keys ?? []
  // recovery keys are signers of the owner account, not its owners: they are counted apart
  const count = members ? members.length : o.signers ? o.signers.length : o.passkeys.filter((p) => p.signer).length
  const threshold = d?.threshold ?? o.workspace?.threshold ?? 1
  const owners = ownersLine({ shared: !!o.shared, signers: count, threshold: d?.threshold ?? o.workspace?.threshold ?? null })
  const rec = recoveryLine(d ? { hasKey: d.recovery.hasKey, delaySeconds: d.recoveryDelaySeconds } : signers.error ? 'unread' : null)
  const notSigners = o.signers ? [] : o.passkeys.filter((p) => !p.signer)
  // the service's own warnings about who signs, except the missing recovery key, which "Needs you" already says
  const warnings = (d?.warnings ?? []).filter((w) => !/no recovery key/i.test(w))
  return (
    <section data-col={col} className="panel vt-own" aria-labelledby="ww-h">
      <div className="panel-head"><h2 id="ww-h">Who owns it</h2><p>Checked by the wallet's own account on the chain</p></div>
      <div className="vt-own-lead">
        <p className="vt-own-v" data-resolve="">{threshold}<small> of {count}</small></p>
        <p className="vt-own-k">{o.shared ? 'members must sign' : count === 1 ? 'passkey must sign' : 'passkeys must sign'} for anything it does as owner</p>
      </div>
      <p className="vt-own-line" data-tone={owners.tone}><Said parts={owners.parts} /></p>
      {members || keys.length ? (
        <ul className="vt-signers">
          {(members ?? []).map((s) => <li key={s.signerId}><span className="vt-signer-i" aria-hidden="true"><Fingerprint /></span><span className="vt-signer-n">{signerName(s)}</span>{s.passkey?.you ? <span className="vt-you">You</span> : null}{s.pendingRemoval ? <Stamp tone="wait">Being removed</Stamp> : null}</li>)}
          {keys.map((k) => <li key={k.signerId} className="rec"><span className="vt-signer-i" aria-hidden="true"><KeyRound /></span><span className="vt-signer-n">Recovery key{k.recoveryKey ? `, set up by ${k.recoveryKey.registeredBy} on ${fmt.day(k.recoveryKey.registeredAt)}` : ''}</span>{k.pendingRecovery ? <Stamp tone="wait">Recovery under way</Stamp> : null}</li>)}
        </ul>
      ) : o.signers?.length ? <p className="vt-own-names">{o.signers.map((m) => `${m.you ? 'You' : m.name} (${m.passkey})`).join('; ')}</p> : null}
      {/* said plainly here when "Needs you" already carries the warning (flagged), so it is not raised twice */}
      <p className="vt-own-line" data-tone={flagged ? undefined : rec.tone}><Said parts={rec.parts} /></p>
      {d ? <p className="vt-own-line">Changes that could weaken it, such as removing a signer, wait <strong>{delay(d.delaySeconds)}</strong>; any signer can stop them meanwhile.{d.adminThreshold !== d.threshold ? ` Changing who signs needs ${d.adminThreshold} signatures.` : ''}</p> : null}
      {notSigners.length ? <p className="vt-own-line" data-tone="wait">Not a signer: {notSigners.map((p) => `“${p.name}”`).join(', ')}, added after the wallet was set up. It can be made one under Security.</p> : null}
      {warnings.map((w) => <p key={w} className="vt-own-line" data-tone="wait">{w}</p>)}
      <h3 className="vt-sub-h">Who may do what</h3>
      <Roles o={o} st={st} keys={keys.length} recDelay={d?.recoveryDelaySeconds ?? null} allows={allows} />
      <p className="vt-foot"><Link to="/security#wallet-signers">Change who signs, or set up a recovery key, in Security</Link></p>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ the overview: the rest

/** The wallet's own stop controls (its contract's pause; the one QED pause control is in the top bar), and changing what it allows. */
function StopRows({ st, col }: { st: RailState; col: string }) {
  const va = useVaultAction()
  const [role, setRole] = useState('operator')
  const paused = st.treasury.paused
  return (
    <section data-col={col} className="panel vt-stop" aria-labelledby="wc-h">
      <div className="panel-head"><h2 id="wc-h">Stop or change it</h2><p>Each takes effect on the chain as soon as it is recorded there</p></div>
      <ul className="vt-acts">
        <li className={`tile ${paused ? 'vt-on' : ''}`}><p className="vt-act-k">{paused ? 'Resume' : 'Pause'}</p>
          <p className="vt-act-s">{paused ? 'The wallet is paused: QED can pay no one from it until you resume it. Someone you promised money can still collect what is set aside for them.' : 'While the wallet is paused QED can pay no one from it. Someone you promised money can still collect what is set aside for them.'}</p>
          <div className="vt-act-go">{paused ? <Btn tone="fill" busy={va.busy} onClick={() => void va.propose('resume')}>Resume the wallet</Btn> : <Btn busy={va.busy} onClick={() => void va.propose('pause')}>Pause the wallet</Btn>}</div></li>
        {st.mandate?.status === 'active' ? <li className="tile"><p className="vt-act-k">Revoke</p><p className="vt-act-s">Revoking the mandate takes back what QED may do: it can then pay no one until you sign another.</p>
          <div className="vt-act-go"><Btn busy={va.busy} onClick={() => void va.propose('revoke-mandate')}>Revoke the mandate</Btn></div></li> : null}
        <li className="tile"><p className="vt-act-k">New limits</p><p className="vt-act-s">A new mandate with other limits replaces the one in force, on the chain, when you sign it.</p>
          <div className="vt-act-go"><Link className="btn" to="/vault/mandate">Change the limits</Link></div></li>
      </ul>
      <details className="vt-fold vt-keys"><summary>If a key may be compromised</summary>
        <ul className="vt-rows">
          {!paused ? <li><span className="vt-rn"><span>The guardian key can pause and cannot resume: a second way to stop it if yours is unavailable.</span></span><span className="vt-ra"><Btn busy={va.busy} onClick={() => void va.propose('guardian-pause')}>Pause with the guardian key</Btn></span></li> : null}
          <li><span className="vt-rn"><span>Everything issued so far stops working at once.</span></span><span className="vt-ra"><Btn tone="void" busy={va.busy} onClick={() => void va.propose('void-all')}>Void every mandate and certificate</Btn></span></li>
          <li><span className="vt-rn"><span>{role === 'guardian' ? 'The guardian key is replaced at once.' : "It takes effect only after your owner account's delay; any of your passkeys can cancel it until then, and the old key keeps working meanwhile."}</span></span>
            <span className="vt-ra"><select className="input vt-select" aria-label="Which key to replace" value={role} onChange={(e) => setRole(e.target.value)}><option value="operator">QED's paying key</option><option value="cosigner">The checking key</option><option value="guardian">The guardian key</option></select><Btn busy={va.busy} onClick={() => void va.propose('rotate-key', { role })}>Replace it</Btn></span></li>
        </ul>
      </details>
      <Problem error={va.error} />
      {va.sheet}
    </section>
  )
}

/** Money set aside for creditors: for whom, how much, when it falls due, and who set it aside. */
function SetAside({ liabs, col }: { liabs: { data: { liabilities: LiabilityView[] } | null; error: Parameters<typeof Problem>[0]['error'] }; col: string }) {
  const { main } = useUnits()
  const open = (liabs.data?.liabilities ?? []).filter((l) => l.status === 'open')
  const closed = (liabs.data?.liabilities ?? []).length - open.length
  return (
    <section data-col={col} className="panel vt-promises" aria-labelledby="wa-h">
      <div className="panel-head"><h2 id="wa-h">Set aside, and for whom</h2><EnforcedBy by="contract" /></div>
      <p className="vt-panel-say">Payable only to them, by anyone once due.</p>
      {!liabs.data ? (liabs.error ? <Problem error={liabs.error} /> : <Loading what="Reading the promises" />) : open.length === 0 ? <p className="vt-empty">Nothing is set aside for anyone. A payment for a later day, or money you set aside, appears here.</p> : (
        <ul className="vt-rows">{open.map((l) => (
          <li key={l.id}>
            <span className="vt-rn"><b>{l.creditorLabel ?? `A creditor, ${short(l.creditor)}`}</b><span>{l.createdByRole === 'owner' ? 'Set aside by you' : l.createdByRole === 'agent' ? 'Promised by QED under your mandate' : 'Set aside by another account'}; due {fmt.day(l.dueAt * 1000)}</span></span>
            <span className="vt-rv">{money(l.amount, main)}<small>{l.due ? 'Due: anyone can pay it now' : 'Not due yet'}</small></span>
          </li>
        ))}</ul>
      )}
      <p className="vt-foot"><Link to="/vault/treasury">Pay, set aside or pay a promise</Link>{closed ? <span>{closed} paid or released earlier</span> : null}</p>
    </section>
  )
}

/** Who can act as the vault's owner, and where: the account's signers and the one web address it takes signatures from. */
function Custody({ o }: { o: Overview }) {
  const ws = o.workspace
  const signers = o.passkeys.filter((p) => p.signer)
  const here = typeof location === 'undefined' ? '' : location.origin
  if (!ws) return null
  return (
    <dl className="kv small">
      <dt>Owner account</dt><dd><span className="code">{ws.ownerAccount ?? 'none'}</span> <span className="faint">{ws.ownerAccountBuild?.declaredReady ? 'research code: declared ready after its own tests, not audited' : ws.ownerAccountBuild ? <strong className="void">{ws.ownerAccountBuild.label}</strong> : ''}</span></dd>
      <dt>Its signers</dt><dd>{o.signers ? o.signers.map((m) => `${m.you ? 'you' : m.name} (${m.passkey})`).join(', ') : signers.length ? signers.map((p) => p.name).join(', ') : 'None of your passkeys that can sign today'}; {ws.threshold === 1 ? 'one signature is enough' : `${ws.threshold ?? '?'} different members must sign`}.</dd>
      <dt>Signatures from</dt><dd><span className="code">{o.origin}</span> only{o.origin && here && o.origin !== here ? <strong className="void">. You are at {here}: open QED at {o.origin} to sign for your wallet.</strong> : ''}</dd>
    </dl>
  )
}

/** The chain, the contracts and the keys behind the wallet, one step down. */
function Technical({ o, st }: { o: Overview; st: RailState }) {
  return (
    <details className="vt-fold vt-tech"><summary>Who controls it, in technical terms</summary>
      <p className="vt-fold-p">{o.custody}</p>
      <dl className="kv small">
        <dt>Chain</dt><dd>Local test chain {st.network.chainId}, on this computer. Latest block {st.network.block}, timed {secs(st.clock.chainSeconds)}. Not a public chain; no value.</dd>
        <dt>Wallet contract</dt><dd className="code">{st.contracts.vault}</dd>
        <dt>Reserve contract</dt><dd className="code">{st.contracts.reserve}</dd>
        <dt>QED's paying key</dt><dd className="code">{st.roles.operator}</dd>
        <dt>Checking key</dt><dd><span className="code">{st.roles.cosigner}</span> <span className="faint">{st.roles.cosignerIsolation === 'separate-process' ? 'held in its own process' : 'held in the same process'}</span></dd>
        <dt>Guardian key</dt><dd><span className="code">{st.roles.guardian}</span> <span className="faint">can pause, cannot resume</span></dd>
      </dl>
      <Custody o={o} />
    </details>
  )
}

/** Changes behind the owner account's delay: cancellable by any one signer until then, then applied by anyone. */
function Scheduled({ list, col }: { list: ScheduledChange[]; col: string }) {
  const va = useVaultAction()
  const apply = useAction(async (id: string) => { const a = await api<{ jobId: string }>('POST', `/api/vault/scheduled/${id}/apply`, { key: uuid() }); navigate(`/vault/job/${a.jobId}`) })
  const shown = list.filter((c) => c.status === 'pending').concat(list.filter((c) => c.status !== 'pending').slice(0, 5))
  if (!shown.length) return null
  const pending = list.filter((c) => c.status === 'pending').length
  return (
    <section data-col={col} className={`panel vt-sched ${pending ? 'waits' : ''}`} aria-labelledby="vs-h">
      <div className="panel-head"><h2 id="vs-h">Changes waiting out the delay</h2><p>{pending} pending</p></div>
      <p className="vt-panel-say">A change that could weaken the wallet's protection (its agent, co-signer, venues, limits or owner) runs only after your owner account's delay. Until then any of your passkeys can cancel it; after it, anyone may apply it, exactly as you approved it.</p>
      <ul className="vt-rows">{shown.map((c) => (
        <li key={c.changeId}><span className="vt-rn"><b>{plain(c.summary)}</b><span>{c.status === 'pending' ? (c.ready ? 'Its delay has passed: it can be applied now.' : `Can be applied from ${iso(c.readyTime)}.`) : c.status === 'applied' ? 'Applied.' : 'Cancelled.'}</span></span>
          <span className="vt-ra">{c.status === 'pending' ? (c.ready ? <Btn busy={apply.busy} onClick={() => void apply.run(c.changeId)}>Apply it</Btn> : <Btn tone="void" busy={va.busy} onClick={() => void va.propose('cancel-change', { changeId: c.changeId })}>Cancel it</Btn>) : <Stamp tone={c.status === 'applied' ? 'ok' : 'plain'}>{c.status === 'applied' ? 'Applied' : 'Cancelled'}</Stamp>}</span></li>))}</ul>
      <Problem error={apply.error ?? va.error} />
      {va.sheet}
    </section>
  )
}

interface Need { key: string; tone: 'due' | 'loss'; title: string; text: string; act: ReactNode }
function Needs({ needs, col }: { needs: Need[]; col: string }) {
  return (
    <section data-col={col} className="panel vt-needs" aria-labelledby="wn-h">
      <div className="panel-head"><h2 id="wn-h">Needs you</h2><span className="count" aria-label={`${needs.length} item${needs.length === 1 ? '' : 's'}`}>{needs.length}</span></div>
      <div className="vt-need-list">{needs.map((n) => <article key={n.key} className={`vt-need ${n.tone}`}><div className="vt-need-t"><h3>{n.title}</h3><p>{n.text}</p></div><div className="vt-need-acts">{n.act}</div></article>)}</div>
    </section>
  )
}

/** Ownership transfer and claims (R13 S5): its own module, loaded after the wallet's first screen has drawn. */
const OwnershipPanel = lazy(() => import('../ui/vault-ownership.tsx').then((m) => ({ default: m.OwnershipPanel })))

function VaultHome({ o, reload }: { o: Overview; reload: () => void }) {
  const st = o.state!
  const { main } = useUnits()
  const active = st.mandate?.status === 'active' ? st.mandate : null
  // what QED's co-signer will still allow: the same read "Pay and set aside" makes, so both screens give one answer
  const room = useData<PaymentLimits>(st.provisioned && active ? '/api/vault/payment-limits' : null, ['vault'])
  const signers = useData<SignersView>(st.provisioned ? '/api/vault/signers' : null, ['vault'])
  const ver = useData<{ ok: boolean; records: number; brokenAt: number | null }>(st.provisioned ? '/api/vault/decisions-verify' : null, ['vault'])
  const liabs = useData<{ liabilities: LiabilityView[] }>(st.provisioned ? '/api/vault/liabilities' : null, ['vault'])
  usePoll(reload, 5000)
  const board = useMasonry()
  const shared = !!o.shared, threshold = o.workspace?.threshold ?? o.plan?.threshold ?? 1
  if (!st.provisioned) return <Accept o={o} shared={shared} threshold={threshold} />
  const rec = recoveryLine(signers.data ? { hasKey: signers.data.recovery.hasKey, delaySeconds: signers.data.recoveryDelaySeconds } : signers.error ? 'unread' : null)
  const records = recordsLine(ver.data ?? (ver.error ? 'unread' : null))
  const here = typeof location === 'undefined' ? '' : location.origin
  const needs: Need[] = []
  if (o.origin && here && o.origin !== here) needs.push({ key: 'origin', tone: 'loss', title: 'Your passkey cannot sign for the wallet from this address', text: `The wallet takes signatures from ${o.origin} only, and this page is at ${here}.`, act: <a className="btn sm" href={`${o.origin}/vault`}>Open QED there</a> })
  if (ver.data && !ver.data.ok) needs.push({ key: 'records', tone: 'loss', title: `The records are broken at no. ${ver.data.brokenAt ?? '?'}`, text: 'A record at or before it was changed after it was written.', act: <Link className="btn sm" to="/vault/records">Open the records</Link> })
  if (signers.data && !signers.data.recovery.hasKey) needs.push({ key: 'recovery', tone: 'due', title: 'No recovery key', text: 'If every passkey that signs for the wallet is lost, no one can act for it again.', act: <Link className="btn sm" to="/security#wallet-signers">Set up a recovery key</Link> })
  return (
    <>
      {!active ? (
        <SetupFlow stage={2} shared={shared} threshold={threshold} title="Say what QED may do with it" intro="One step left: until you sign a mandate, QED can pay no one from your wallet."
          done={{ create: `Created, owned by ${shared ? 'your members\' passkeys' : 'your passkey'}.`, accept: `Accepted: ${headline(st.treasury.balance, main).text} of ${unitWords(main.symbol)} in the treasury.` }} summary={<SetupSummary stage={2} o={o} />}>
          <Device />
          <MandateForm st={st} first />
        </SetupFlow>
      ) : null}
      <div className="board vt-board" ref={board}>
        <Holds col="1" st={st} active={active} />
        {needs.length ? <Needs col="2" needs={needs} /> : null}
        <MayDo col="1" st={st} room={room} />
        <Scheduled col="2" list={o.scheduled} />
        <Owners col="2" o={o} st={st} signers={signers} allows={allowsOf(room.data)?.kind ?? null} flagged={needs.some((n) => n.key === 'recovery')} />
        <StopRows col="1" st={st} />
        <SetAside col="2" liabs={liabs} />
        <Suspense fallback={null}><OwnershipPanel col="1" /></Suspense>
        <section data-col="2" className="panel vt-recs" aria-labelledby="wr-h">
          <div className="panel-head"><h2 id="wr-h">Records</h2><EnforcedBy by="seen" /></div>
          <p className="vt-recs-line" data-tone={records.tone}><Said parts={records.parts} /></p>
          {rec.tone && !needs.some((n) => n.key === 'recovery') ? <p className="vt-recs-line" data-tone={rec.tone}><Said parts={rec.parts} /></p> : null}
          <Technical o={o} st={st} />
          <p className="vt-foot"><Link to="/vault/records">Open the records</Link></p>
        </section>
      </div>
    </>
  )
}

// ------------------------------------------------------------------------------------------------ the mandate

function MandateDoc({ m }: { m: MandateView }) {
  const f = m.fields, u = m.usage
  const { main } = useUnits()
  const account = useContext(Ws)?.workspace?.ownerAccount
  // in force is a settled state, drawn with its check; a toneless stamp is something still in progress (the clock)
  const tone = m.status === 'active' ? 'ok' as const : m.status === 'superseded' || m.status === 'expired' ? 'plain' as const : 'void' as const
  return (
    <article id="vh-mandate" className={`instrument vt-doc ${m.status === 'active' ? 'inforce' : ''}`} aria-label={`Mandate version ${m.version}`}>
      <div className="i-head"><span>On-chain mandate, version {m.version}</span><span>Signed {iso(m.signedAt)}</span></div>
      <div className="i-body">
        <p className="i-pay">QED may pay from this wallet, in {unitWords(main.symbol)}, only to the payees named below.</p>
        {m.purposeText ? <p className="i-words">{plain(m.purposeText)}</p> : null}
        <p className="crossing"><span className="vt-bracket" aria-hidden="true" />Not over {money(f.maxTotal, main)} in all before {secs(f.validUntil)}</p>
        <dl className="clauses">
          <dt>Limits</dt><dd><ul><li>At most {money(f.maxPerPayment, main)} in one payment.</li><li>At most {money(f.maxPerPeriod, main)} in any {Math.round(Number(f.period) / 3600)} hours: {money(u.period.spent, main)} used, {money(u.period.remaining, main)} left. <span className="faint">{plain(u.period.note)}</span></li><li>At most {money(f.maxTotal, main)} over its whole life: {money(u.lifetime.spent, main)} used, {money(u.lifetime.remaining, main)} left.</li><li>The wallet's own daily cap of {money(u.vaultDaily.limit, main)} applies as well: {money(u.vaultDaily.remaining, main)} left today.</li></ul><EnforcedBy by="contract" /></dd>
          <dt>Payees</dt><dd><ul>{f.payees.map((p, i) => <li key={p}>{payeeName(m.payeeLabels[i])}</li>)}</ul><EnforcedBy by="contract" /></dd>
          <dt>Only if</dt><dd>{f.requireCosign ? <>A separate checking service certifies each payment against these limits first; each certificate works once. <EnforcedBy by="contract" /></> : 'No second check is required.'}</dd>
          <dt>Never</dt><dd className="never"><ul><li>Pay anyone not named above.</li><li>Touch money set aside for a promised payment.</li><li>Act while the wallet is paused, or after this mandate is revoked or voided.</li></ul><EnforcedBy by="contract" /></dd>
          <dt>Valid</dt><dd>From {secs(f.validFrom)} to {secs(f.validUntil)}. {u.validity.active ? `${Math.max(0, Math.round(u.validity.secondsLeft / 3600))} hours left.` : 'Not in its window now.'}</dd>
          <dt>Stopping</dt><dd>You can revoke this mandate, void every mandate at once, or pause the wallet. Each takes effect on the chain as soon as it is recorded there.</dd>
        </dl>
        <div className="i-sign">
          <div className="signature"><div className="name">Signed with your passkey</div><small>{iso(m.signedAt)}. The wallet's contract checked the signature before accepting the mandate.</small>
            <details className="vt-fold"><summary>Technical record</summary><dl className="kv small">
              <dt>Owner account</dt><dd className="code">{account ?? 'none'}</dd>
              <dt>Approval</dt><dd className="code">{m.approvalId ?? 'none'}</dd>
              <dt>Mandate hash</dt><dd className="code">{m.hash}</dd>
              <dt>Standards</dt><dd>EIP-712 typed data, checked through the owner account (ERC-1271)</dd>
              <dt>Payee addresses</dt><dd>{f.payees.map((p, i) => <div key={p}>{payeeName(m.payeeLabels[i])}: <span className="code">{p}</span></div>)}</dd>
            </dl></details>
          </div>
          <Stamp big tone={tone} sub={m.status === 'active' ? 'enforced by the contract' : undefined}>{m.status === 'active' ? 'In force' : cap(m.status)}</Stamp>
        </div>
      </div>
    </article>
  )
}

/** The mandate's own page: the signed document beside revoking it, a new mandate and the earlier versions. */
function MandatePage({ st }: { st: RailState }) {
  const va = useVaultAction()
  const { main } = useUnits()
  const mandates = useData<{ mandates: MandateView[] }>('/api/vault/mandates', ['vault'])
  const active = st.mandate?.status === 'active' ? st.mandate : null
  const older = (mandates.data?.mandates ?? []).filter((m) => m.version !== st.mandate?.version)
  return (
    <div className="vt-split">
      <div className="vt-col">
        {st.mandate ? <MandateDoc m={st.mandate} /> : <Note tone="wait" title="No mandate is in force">QED can pay no one from the wallet until you sign one beside this.</Note>}
      </div>
      <div className="vt-col">
        {active ? (
          <section className="panel" aria-labelledby="mr-h">
            <div className="panel-head"><h2 id="mr-h">Revoke it</h2><EnforcedBy by="contract" /></div>
            <p className="vt-panel-say">It takes effect on the chain as soon as it is recorded there. QED can then pay no one from the wallet until you sign another mandate. Money already set aside for a creditor stays theirs.</p>
            <div className="vt-go"><Btn busy={va.busy} onClick={() => void va.propose('revoke-mandate')}>Revoke the mandate</Btn></div>
            <Problem error={va.error} />
          </section>
        ) : null}
        <section className="panel" aria-labelledby="mn-h">
          <div className="panel-head"><h2 id="mn-h">{active ? 'Sign a new mandate' : 'Sign a mandate'}</h2><p>{active ? 'It replaces the one in force' : 'It names what QED may pay, to whom, and until when'}</p></div>
          <MandateForm st={st} first={!active} />
        </section>
        {older.length ? (
          <section className="panel" aria-labelledby="mo-h">
            <div className="panel-head"><h2 id="mo-h">Earlier mandates</h2><p>{older.length} before this one</p></div>
            <ul className="vt-rows">{older.map((m) => <li key={m.version}><span className="vt-rn"><b>Version {m.version}</b><span>{cap(m.status)}; signed {iso(m.signedAt)}</span></span><span className="vt-rv">{money(m.fields.maxPerPayment, main)}<small>a payment</small></span></li>)}</ul>
          </section>
        ) : null}
      </div>
      {va.sheet}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ pay and set aside

/** The one external payee in the owner's book on this test chain. The vault accepts a label from the book, never an address. */
const PAYEE = 'CloudCo'

/**
 * The treasury beyond conversion: a payment to an approved payee now or as a promise for a later day, money set
 * aside for a creditor, the owner's own money in and out, the promises the vault holds, and the venues a conversion
 * may use. Each goes the same way as everything else: exact terms, your approval, one execution you can follow.
 * Paying a promise that has fallen due needs no approval: the contract lets anyone do that, and only to its creditor.
 */
/**
 * Receiving (R12 task comparison, T10-b): the address of the owner's own account on this chain, written with the chain
 * before it in the chain-agnostic form (CAIP-10: eip155, the chain's id, then the address), so it cannot be taken for an
 * address on another chain; shown in groups of four to read aloud, with a copy button and a check that compares an
 * address someone gave you with this one (letters compared without regard to case, as addresses are). Test tokens sent
 * there arrive in the owner's own account; a deposit moves them into the wallet.
 */
export const receiveId = (chainId: number, address: string): string => `eip155:${chainId}:${address}`
export const sameAddress = (given: string, chainId: number, address: string): boolean => {
  const g = given.trim().toLowerCase()
  return g === address.toLowerCase() || g === receiveId(chainId, address).toLowerCase()
}
function Receive({ st }: { st: RailState }) {
  const id = receiveId(st.network.chainId, st.roles.owner)
  const [copied, setCopied] = useState(false)
  const [given, setGiven] = useState('')
  const copy = useAction(async () => { await navigator.clipboard.writeText(id); setCopied(true) })
  const verdict = given.trim() ? sameAddress(given, st.network.chainId, st.roles.owner) : null
  return (
    <section data-col="2" className="panel vt-receive" aria-labelledby="rc-h">
      <div className="panel-head"><h2 id="rc-h">Receive</h2></div>
      <p className="vt-say">Test tokens sent to this address arrive in your own account on this chain; a deposit moves them into the wallet. It is on the local test chain, id {st.network.chainId}, on this computer: nothing on a public chain can reach it, and the tokens have no value.</p>
      <p className="vt-rc-id code"><span className="sr">{id}</span><span aria-hidden="true">{id.split(':').slice(0, 2).join(':')}:</span>{(st.roles.owner.slice(2).match(/.{1,4}/g) ?? []).map((g, i) => <span key={i} aria-hidden="true">{i === 0 ? `0x${g}` : g}</span>)}</p>
      <div className="vt-go"><Btn busy={copy.busy} onClick={() => void copy.run()}>{copied ? 'Copied' : 'Copy the address'}</Btn></div>
      {copy.error ? <Problem error={copy.error} /> : null}
      <Field label="Check an address you were given" hint="Paste it here to compare it with this one before you share it or send to it.">{(p) => <input {...p} className="input code" spellCheck={false} autoComplete="off" value={given} onChange={(e) => setGiven(e.target.value)} />}</Field>
      <p className={`vt-rc-verdict ${verdict === null ? '' : verdict ? 'ok' : 'due'}`} role="status">{verdict === null ? '' : verdict ? (given.trim().toLowerCase().startsWith('eip155:') ? 'It is this address.' : `It is this address. It names no chain: it is for the local test chain, id ${st.network.chainId}.`) : 'It is not this address. Do not use it.'}</p>
    </section>
  )
}

function Treasury({ st }: { st: RailState }) {
  const va = useVaultAction()
  const { main } = useUnits()
  const m = (raw: string | null | undefined): string => money(raw, main)
  const liabs = useData<{ liabilities: LiabilityView[] }>('/api/vault/liabilities')
  const quota = useData<QuotaView>('/api/vault/quota')
  // What a payment may be right now, read without preparing anything: the co-signer's figure (the lower of your limits
  // and its own check C12), and the contract's limits on their own, so that the screen can say which of them binds.
  const room = useData<PaymentLimits>(st.mandate ? '/api/vault/payment-limits' : null, ['vault'])
  const lim = useData<{ maximum: string; checks: LimitCheck[] }>(st.mandate ? '/api/vault/maximum' : null, ['vault'])
  const [pay, setPay] = useState('3'), [later, setLater] = useState('')
  const [hold, setHold] = useState('5'), [holdDays, setHoldDays] = useState('30')
  const [move, setMove] = useState('100'), [give, setGive] = useState('20')
  // D-K1b: the caps on earned authority, as the owner signs them (blank: the figure in force, kept)
  const [capW, setCapW] = useState(''), [capP, setCapP] = useState('')
  const named = new Set(st.venues.map((v) => v.i))
  const [chosen, setChosen] = useState<number[] | null>(null)
  const picks = chosen ?? [...named].sort((a, b) => a - b)
  const settle = useAction(async (id: string) => { const a = await api<{ jobId: string }>('POST', `/api/vault/liabilities/${id}/settle`, { key: uuid() }); navigate(`/vault/job/${a.jobId}`) })
  const board = useMasonry()
  usePoll(liabs.reload, 6000)
  usePoll(room.reload, 6000, !!st.mandate)
  const t = st.treasury
  const most = room.data ? BigInt(room.data.maximum) : null
  // The co-signer's check C12: the authority budget in every owner's vault, unless the service runs the release's rule.
  const auth = room.data?.authority
  // finish review F2: which limit binds a payment now, and which of the contract's limits sets their figure
  const binds = room.data ? bindingLimit(room.data.checks, room.data.maximum) : null
  const contractBinds = lim.data ? bindingLimit(lim.data.checks, lim.data.maximum) : null
  // The rule that leaves the least room, in the service's own words, for when nothing can be paid.
  const stops = room.data ? room.data.checks.filter((c) => !c.pass) : []
  const days = (v: string): number | null => (/^\d{1,3}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 365 ? Number(v) : null)
  // An entry in "days" that is not a whole number from 1 to 365 is an error. It must never be read as "pay now".
  const laterBad = later.trim() !== '' && days(later) === null
  const unchanged = picks.length === named.size && picks.every((i) => named.has(i))
  const list = liabs.data?.liabilities ?? []
  // Every deployed pool by its number. The pools on record are the named ones; a pool that is not named can only be re-added by number.
  const pools = [0, 1, 2, 3, 4].map((i) => ({ i, v: st.venues.find((x) => x.i === i) }))
  return (
    <>
      {/* the Overview's way of writing money: ₹ on the figure, the unit in words once (finish review F4) */}
      <dl className="vt-figs">
        <div className="tile vt-fig-lead"><dt>Free in the treasury</dt><dd className="vt-fig-v"><Figure text={m(t.free)} /></dd><dd className="vt-fig-s">of {m(t.balance)} in it, in {unitWords(main.symbol)}</dd></div>
        <div className="tile"><dt>Set aside for creditors</dt><dd className="vt-fig-v">{m(t.ringFenced)}</dd><dd className="vt-fig-s">Payable only to them</dd></div>
        <div className="tile vt-qed"><dt>Most that can be paid now</dt><dd className="vt-fig-v">{!st.mandate ? 'Nothing' : room.data ? m(room.data.maximum) : <span className="skel vt-skel" aria-hidden="true" />}</dd><dd className="vt-fig-s">{!st.mandate ? 'No mandate is in force' : room.error ? 'Could not be read just now' : !room.data ? 'Reading your limits' : `Set by ${limitWords(binds)}`}</dd></div>
      </dl>

      <div className="board vt-board" ref={board}>
        <section data-col="1" className="panel vt-pay" aria-labelledby="tp-h">
          <div className="panel-head"><h2 id="tp-h">Pay {PAYEE}</h2><p>The one outside payee your mandate names</p></div>
          <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); if (laterBad) return; void va.propose('pay', { payee: PAYEE, amount: pay.trim(), ...(days(later) ? { dueInDays: days(later) } : {}) }) }}>
            <div className="form-grid vt-two">
              <Field label={`How much, in ${unitWords(main.symbol)}`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={pay} onChange={(e) => setPay(e.target.value)} /></div>}</Field>
              <Field label="Pay it in this many days" error={laterBad ? 'Enter a whole number of days from 1 to 365, or leave it empty.' : undefined}>{(p) => <input {...p} className="input" inputMode="numeric" placeholder="Now" value={later} onChange={(e) => setLater(e.target.value)} />}</Field>
            </div>
            <p className="vt-say">Leave the days empty to pay now. With a number, nothing leaves yet: the amount is set aside for {PAYEE} and counts against your limits at once.</p>
            <h3 className="vt-sub-h">It must fit both of these</h3>
            {room.data ? (
              <div className="vt-fits">
                {/* the two checks a payment must fit, apart: the contract's limits, then the co-signer's budget; the tile above is the lower */}
                <div className="vt-fit">
                  <EnforcedBy by="contract" />
                  <dl><dt>Your limits allow</dt><dd>{lim.data ? <><strong>{m(lim.data.maximum)}</strong> in one payment now, set by {limitWords(contractBinds)}. The wallet's contract enforces them, whatever QED does.</> : lim.error ? 'Could not be read just now.' : 'Reading them.'}</dd></dl>
                </div>
                <div className="vt-fit qed">
                  <EnforcedBy by="qed" />
                  {auth ? <dl>
                    <dt>Your authority budget</dt><dd><strong>{m(auth.available)}</strong> available now, of {m((BigInt(auth.granted) + BigInt(auth.earned)).toString())} granted and earned</dd>
                    <dt>Made of</dt><dd>{m(auth.granted)} granted ({m(auth.base)} to start, {m(auth.grants)} by you) and {m(auth.earned)} earned from clients outside your workspace{auth.earnedLimit ? <>, which counts at most {m(auth.earnedLimit.perWindow)} in any {auth.earnedLimit.windowSeconds % 86_400 === 0 ? `${String(auth.earnedLimit.windowSeconds / 86_400)} days` : `${String(Math.round(auth.earnedLimit.windowSeconds / 3_600))} hours`} and {m(auth.earnedLimit.perPayer)} from any one payer</> : null}</dd>
                    <dt>Taken by</dt><dd>payments {m(auth.usedBy.payments)}; the real cost of conversions {m(auth.usedBy.conversions)}; promises paid {m(auth.usedBy.promisesPaid)}; promises not yet paid {m(auth.held)}; certificates signed and not yet used {m(auth.reserved)}</dd>
                  </dl> : <dl><dt>The co-signer's allowance</dt><dd>{m(room.data.earned.remaining)} of {m(room.data.earned.limit)} left; {m(room.data.earned.used)} has been paid out, conversions included</dd></dl>}
                </div>
              </div>
            ) : room.error ? <Problem error={room.error} /> : !st.mandate ? <p className="vt-say">No mandate is in force, so nothing can be paid. <Link to="/vault/mandate">Sign a mandate</Link></p> : <Loading what="Reading your limits" />}
            {!room.data ? null : auth ? <div className="vt-say vt-stack">
              <p>The lower figure binds. Your limits are enforced by the wallet's contract, whatever QED does. Your authority budget is checked by QED's co-signer, among eight rules of its own, before it signs: what you granted, plus what the wallet has verifiably earned from clients outside your workspace, less what has left your control. Then the agent's key sends it.</p>
              <details className="vt-fold"><summary>How the budget is worked out</summary><p className="vt-fold-p">A conversion takes only its real cost against a fixed reference price, so converting back and forth, or paying yourself, cannot raise it. {plain(auth.statement)}</p></details>
              {auth.limits.length ? <details className="vt-fold"><summary>What these figures do not say</summary><ul className="vt-bullets">{auth.limits.map((l, i) => <li key={i}>{plain(l)}</li>)}</ul></details> : null}
            </div>
              : <p className="vt-say">The agent's key sends it, under your mandate, after the co-signer has checked it against eight rules of its own. One of them is this allowance: a rule of the released system, kept as it was, that lets a treasury pay out {m(room.data.earned.limit)} plus half of what it has verifiably earned through an escrow; conversions count against it too. This vault service runs that rule instead of the authority budget.</p>}
            {most === 0n ? <Note tone="void">A payment now would be refused{BigInt(room.data!.earned.remaining) === 0n ? (auth ? ', because your authority budget has nothing left: you can grant more below' : ', because the co-signer\'s allowance is used up') : stops.length ? `: ${stops.map((c) => lowerFirst(plain(c.rule))).join('; ')}` : ''}. You can still ask for the terms and send it: the refusal is recorded and nothing is paid.</Note> : null}
            <div className="vt-go"><Btn tone="fill" type="submit" busy={va.busy} disabled={!st.mandate || laterBad}>See the exact terms</Btn></div>
          </form>
        </section>

        <section data-col="2" className="panel" aria-labelledby="tl-h">
          <div className="panel-head"><h2 id="tl-h">Promises the wallet holds</h2><p>{list.filter((l) => l.status === 'open').length} open</p></div>
          {!liabs.data ? (liabs.error ? <Problem error={liabs.error} /> : <Loading what="Reading the promises" />) : list.length === 0 ? <p className="vt-empty">Nothing is set aside for anyone. A payment for a later day, or money you set aside, appears here.</p> : (
            // rows, not a table: a table here scrolled sideways on a phone inside a box the keyboard could not reach (axe, scrollable-region-focusable)
            <ul className="vt-rows">{list.map((l) => (
              <li key={l.id}>
                <span className="vt-rn"><b>{l.creditorLabel ?? short(l.creditor)}</b><span>Promise {l.id}, {l.createdByRole === 'owner' ? 'set aside by you as owner' : l.createdByRole === 'agent' ? 'made by QED under your mandate' : `made by ${short(l.createdBy)}`}; due {secs(l.dueAt)}</span></span>
                <span className="vt-rv">{m(l.amount)}</span>
                <span className="vt-ra">{l.status === 'open' ? (l.due ? <Btn busy={settle.busy} onClick={() => void settle.run(l.id)}>Pay it now</Btn> : <Stamp tone="plain">Not due yet</Stamp>) : <Stamp tone={l.status === 'settled' ? 'ok' : 'plain'}>{l.status === 'settled' ? 'Paid' : 'Released'}</Stamp>}</span>
              </li>
            ))}</ul>
          )}
          <Problem error={settle.error} />
          <p className="vt-after"><EnforcedBy by="contract" /> A promise that has fallen due can be paid by anyone, to its creditor only, even while the wallet is paused. That is why paying one asks for no approval.</p>
        </section>

        <section data-col="1" className="panel" aria-labelledby="th-h">
          <div className="panel-head"><h2 id="th-h">Set money aside for a creditor</h2><p>Your own act as owner, not the agent's</p></div>
          <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void va.propose('ring-fence', { creditor: PAYEE, amount: hold.trim(), dueInDays: days(holdDays) ?? 30 }) }}>
            <div className="form-grid vt-two">
              <Field label={`How much to hold, in ${unitWords(main.symbol)}`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={hold} onChange={(e) => setHold(e.target.value)} /></div>}</Field>
              <Field label="Due in this many days" error={days(holdDays) ? undefined : 'Enter a whole number of days from 1 to 365.'}>{(p) => <input {...p} className="input" inputMode="numeric" value={holdDays} onChange={(e) => setHoldDays(e.target.value)} />}</Field>
            </div>
            <div className="vt-means"><EnforcedBy by="contract" /><p>Money set aside cannot be taken back, by you or by anyone, and can only ever be paid to that creditor, by anyone once it falls due, even while the wallet is paused. It does not use the agent's limits.</p></div>
            <div className="vt-go"><Btn type="submit" busy={va.busy} disabled={!days(holdDays)}>See the exact terms</Btn></div>
          </form>
        </section>

        {auth ? <section data-col="2" className="panel" aria-labelledby="tg-h">
          <div className="panel-head"><h2 id="tg-h">Grant the agent more authority</h2><EnforcedBy by="qed" /></div>
          <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void va.propose('grant', { amount: give.trim() }) }}>
            <Field label={`How much, in ${unitWords(main.symbol)}`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={give} onChange={(e) => setGive(e.target.value)} /></div>}</Field>
            <p className="vt-say">It raises what the agent may let leave your control (payments to others, and the real cost of conversions), within your mandate's limits. It moves no money, and it is shown apart from what the wallet has earned.</p>
            <div className="vt-go"><Btn type="submit" busy={va.busy}>See the exact grant</Btn></div>
          </form>
        </section> : null}

        {auth?.earnedCaps ? (() => {
          const c = auth.earnedCaps, days = c.ceiling.windowSeconds / 86_400
          const span = Number.isInteger(days) ? `${days} days` : `${c.ceiling.windowSeconds} seconds`
          const mine = c.owner.perWindow !== null || c.owner.perPayer !== null
          const units = (raw: string) => (Number(raw) / 10 ** auth.asset.decimals).toFixed(auth.asset.decimals)
          const delay = c.delaySeconds === null ? 'the account\'s delay' : c.delaySeconds % 3600 === 0 ? `${c.delaySeconds / 3600} hours` : `${c.delaySeconds} seconds`
          return (
            <section data-col="1" className="panel" aria-labelledby="tc-h">
              <div className="panel-head"><h2 id="tc-h">Caps on earned authority</h2><EnforcedBy by="qed" /></div>
              <p className="vt-say">Half of what clients outside your workspace pay into the wallet, once final, adds to the agent's authority. At most {m(c.inForce.perWindow)} of it counts in any {span}, and at most {m(c.inForce.perPayer)} from any one payer in that time: {mine ? 'the caps you signed, under the installation\'s' : 'the installation\'s caps; you have not signed your own'}.</p>
              {c.pending.length ? <Note tone="wait" title={c.pending.length === 1 ? 'A raise is waiting' : 'Two raises are waiting'}>{c.pending.map((x) => `${x.cap === 'perWindow' ? `In any ${span}` : 'From any one payer'}: ${m(x.value)}, from ${fmt.dayTime(x.from)}`).join('; ')}. Until then the caps above apply. Signing a lower cap before then stops it.</Note> : null}
              <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void va.propose('earned-caps', { perWindow: (capW.trim() || units(c.inForce.perWindow)), perPayer: (capP.trim() || units(c.inForce.perPayer)) }) }}>
                <div className="form-grid vt-two">
                  <Field label={`In any ${span}, at most (${unitWords(main.symbol)})`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" placeholder={units(c.inForce.perWindow)} value={capW} onChange={(e) => setCapW(e.target.value)} /></div>}</Field>
                  <Field label={`From any one payer, at most (${unitWords(main.symbol)})`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" placeholder={units(c.inForce.perPayer)} value={capP} onChange={(e) => setCapP(e.target.value)} /></div>}</Field>
                </div>
                <p className="vt-say">A lower cap applies at once. A higher one loosens a protection, so it waits {delay} before it counts, and you and your recovery contacts are told when it is asked for; you are told again when it takes effect. The installation's caps, {m(c.ceiling.perWindow)} and {m(c.ceiling.perPayer)}, are the most there can be. Your passkey signs the caps; nothing moves.</p>
                <div className="vt-go"><Btn type="submit" busy={va.busy}>See the exact caps</Btn></div>
              </form>
            </section>
          )
        })() : null}

        <section data-col="2" className="panel" aria-labelledby="tm-h">
          <div className="panel-head"><h2 id="tm-h">Your own money, in and out</h2></div>
          <form className="vt-act-form" onSubmit={(e) => e.preventDefault()}>
            <Field label={`How much, in ${unitWords(main.symbol)}`}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={move} onChange={(e) => setMove(e.target.value)} /></div>}</Field>
            <p className="vt-say">Between the wallet and your own account on this chain. A withdrawal can take free money only: what is set aside for creditors stays. Your own account holds {m(st.ownerHolds?.asset ?? '0')} now, outside the wallet: escrow refunds and your withdrawals land there.</p>
            <div className="vt-go"><Btn busy={va.busy} onClick={() => void va.propose('deposit', { amount: move.trim() })}>Deposit</Btn><Btn busy={va.busy} onClick={() => void va.propose('withdraw', { amount: move.trim() })}>Withdraw</Btn></div>
          </form>
        </section>

        <Receive st={st} />

        <section data-col="1" className="panel" aria-labelledby="tv-h">
          <div className="panel-head"><h2 id="tv-h">Venues a conversion may use</h2><p>{named.size} of {pools.length} named now</p></div>
          <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void va.propose('venues', { venues: picks }) }}>
            <fieldset><legend className="sr">Pools to name</legend>
              <div className="vt-picks">{pools.map(({ i, v }) => (
                <label key={i}><input type="checkbox" checked={picks.includes(i)} onChange={(e) => setChosen(e.target.checked ? [...picks, i].sort((a, b) => a - b) : picks.filter((x) => x !== i))} /><span><b>{v ? venueName(v) : `Pool ${i}`}</b><small>{v ? 'Named now' : 'Not named now'}</small></span></label>
              ))}</div>
            </fieldset>
            <div className="vt-form-foot"><Btn type="submit" busy={va.busy} disabled={picks.length === 0 || unchanged}>See the exact terms</Btn><p>{picks.length === 0 ? 'Name at least one pool. ' : unchanged ? 'Tick or untick a pool to name a different set. ' : ''}A new set takes effect only after your owner account's delay, and any of your passkeys can cancel it until then. Once applied it voids every order signed for the old set.</p></div>
          </form>
        </section>

        <section data-col="2" className="panel" aria-labelledby="tq-h">
          <div className="panel-head"><h2 id="tq-h">How much the vault service accepts</h2><EnforcedBy by="qed" /></div>
          {quota.data ? <p className="vt-panel-say">In any {Math.round(quota.data.windowSeconds / 60)} minutes, whoever asks; past that it refuses and says when to try again.</p> : null}
          {quota.data ? <ul className="vt-quota">{quota.data.classes.map((c) => <li key={c.class}><span>{quotaWords(c.class, c.counts)}</span><b>{c.used} of {c.limit}</b>{c.remaining === 0 && c.nextFreeAt ? <small>The next is allowed {iso(c.nextFreeAt)}</small> : null}</li>)}</ul>
            : quota.error ? <Problem error={quota.error} /> : <Loading />}
        </section>
      </div>
      <Problem error={va.error} />
      {va.sheet}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ convert

function Convert({ st }: { st: RailState }) {
  const va = useVaultAction()
  const { main, reserve } = useUnits()
  const m = (raw: string | null | undefined): string => money(raw, main)
  // a dollar figure set apart is to the cent; its exact figure is one step down, in the details beneath it
  const cents = (raw: string | null | undefined): string => headline(raw ?? '0', reserve).text, exact = (raw: string | null | undefined): string => money(raw, reserve)
  const [amount, setAmount] = useState('10')
  const [said, setSaid] = useState('')
  const [reading, setReading] = useState<{ refused?: string; topic?: string; note?: string } | null>(null)
  const [res, setRes] = useState<{ limits: LimitsResult; quote: QuoteResult | null; amount: string } | null>(null)
  // finish review F2: the contract's limits (what one conversion may be, whatever QED does) and what QED's co-signer
  // allows (the authority budget, against which a conversion counts only its real cost), each named, from the same
  // reads the Overview and "Pay and set aside" make
  const max = useData<{ maximum: string; checks: LimitCheck[]; note: string }>('/api/vault/maximum', ['vault'])
  const room = useData<PaymentLimits>(st.mandate ? '/api/vault/payment-limits' : null, ['vault'])
  const board = useMasonry()
  // no polling here: both reads refresh on the wallet's own events (['vault']); four 6-second polls added for them
  // pushed the browser suite's parallel journeys over the API's 1,500 requests a minute per address
  const binds = max.data ? bindingLimit(max.data.checks, max.data.maximum) : null
  const allows = allowsOf(room.data)
  const check = useAction(async (a: string) => {
    const limits = await api<LimitsResult>('GET', `/api/vault/limits?amount=${encodeURIComponent(a)}`)
    const quote = await api<QuoteResult>('GET', `/api/vault/quote?amount=${encodeURIComponent(a)}`).catch(() => null)
    setRes({ limits, quote, amount: a })
  })
  // The release's own guard, topic list and strict amount reader, run on the vault service. They read; they never act.
  const read = useAction(async () => {
    setReading(null)
    const g = await api<{ refused: boolean; reply: string }>('POST', '/api/vault/language/screen', { message: said })
    if (g.refused) { setReading({ refused: g.reply }); return }
    const a = await api<{ kind: string; text?: string; reason?: string }>('POST', '/api/vault/language/amount', { text: said })
    if (a.kind === 'valid' && a.text) { setAmount(a.text); setReading({ note: `Read as ${a.text} ${unitWords(main.symbol)}, exactly as you wrote it. Checked below; nothing is sent until you approve.` }); await check.run(a.text); return }
    const t = await api<{ topic: string | null; knowledge: { answer: string } | null }>('POST', '/api/vault/language/topic', { message: said })
    setReading(t.knowledge ? { topic: plain(t.knowledge.answer) } : { note: a.kind === 'ambiguous' || a.kind === 'invalid' ? `No single exact amount could be read: ${a.reason ?? 'say it as a plain number such as 12.5'}.` : 'No amount and no known question were found in that. Say an amount such as "convert 12.5", or use the box beside it.' })
  })
  const q = res?.quote, t = st.lastTrade
  const hop = (h: { amountIn: string; tokenIn: string; amountOut: string; tokenOut: string; label: string }, i: number) => <span key={i} className="vt-block">{moneyOf(h.amountIn, h.tokenIn)} to {moneyOf(h.amountOut, h.tokenOut)} at {inUnits(plain(h.label))}</span>
  const symbols = [...new Set(st.venues.flatMap((v) => [v.token0, v.token1]))].filter((x) => SIGN[x])
  return (
    <>
      <dl className="vt-figs">
        <div className="tile vt-fig-lead"><dt>Your limits allow, in one conversion</dt><dd className="vt-fig-v">{max.data ? <Figure text={m(max.data.maximum)} /> : <span className="skel vt-skel" aria-hidden="true" />}</dd><dd className="vt-fig-s">{max.error ? 'Could not be read just now' : max.data ? `Set by ${limitWords(binds)}` : 'Reading your limits'}</dd></div>
        <div className="tile vt-qed"><dt>{allows?.kind === 'allowance' ? 'The co-signer\'s allowance' : 'Authority budget left'}</dt><dd className="vt-fig-v">{!st.mandate ? 'Nothing' : allows ? m(allows.left) : <span className="skel vt-skel" aria-hidden="true" />}</dd><dd className="vt-fig-s">{room.error ? 'Could not be read just now' : allows?.kind === 'allowance' ? 'Counts a conversion\'s whole amount' : 'Counts a conversion\'s real cost, not its amount'}</dd></div>
        <div className="tile"><dt>Free in the treasury</dt><dd className="vt-fig-v">{m(st.treasury.free)}</dd><dd className="vt-fig-s">In {unitWords(main.symbol)}; {cents(st.reserve.free)} free in the {reserveWordsOf(reserve.symbol)}</dd></div>
      </dl>
      <div className="board vt-board" ref={board}>
        <section data-col="1" className="panel" aria-labelledby="cv-h">
          <div className="panel-head"><h2 id="cv-h">Convert into the {reserveWordsOf(reserve.symbol)}</h2><p>{cap(unitWords(main.symbol))} into {unitWords(reserve.symbol)}, at a price read now and checked again when it is sent</p></div>
          <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void check.run(amount.trim()) }}>
            <div className="form-grid vt-two">
              <Field label={`Convert how much, in ${unitWords(main.symbol)}`} hint={max.data ? `Up to ${m(max.data.maximum)} under your limits now.` : undefined} error={check.error?.fields.amount}>{(p) => <div className="money" {...signOf(main)}><input {...p} className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>}</Field>
              <Field label="Or say it in words" hint="Read by fixed rules on the vault service, not by a model.">{(p) => <input {...p} className="input" value={said} placeholder="convert 12.5" onChange={(e) => setSaid(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && said.trim().length > 1) { e.preventDefault(); void read.run() } }} />}</Field>
            </div>
            {reading?.refused ? <Note tone="void" title="Refused by the guard">{reading.refused}</Note> : null}
            {reading?.topic ? <Note tone="qed" title="From the fixed explanations">{reading.topic}</Note> : null}
            {reading?.note ? <p className="vt-say">{reading.note}</p> : null}
            <h3 className="vt-sub-h">It must fit both of these</h3>
            {max.data && allows ? (
              <div className="vt-fits">
                <div className="vt-fit"><EnforcedBy by="contract" /><p>Your limits cap the amount: <strong>{m(max.data.maximum)}</strong> now, set by {limitWords(binds)}. The wallet's contract enforces them, whatever QED does, and refuses any execution further from the provable best than the order allows.</p></div>
                <div className="vt-fit qed"><EnforcedBy by="qed" /><p>{allows.kind === 'budget'
                  ? <>QED's co-signer then counts only the conversion's real cost against a fixed reference price (at worst, what goes in less the least the order accepts back) and signs only if that fits in the <strong>{m(allows.left)}</strong> of your authority budget left.</>
                  : <>QED's co-signer also counts the whole amount against its allowance, <strong>{m(allows.left)}</strong> left, so the lower of the two binds.</>}</p></div>
              </div>
            ) : !st.mandate ? <p className="vt-say">No mandate is in force, so nothing can be converted. <Link to="/vault/mandate">Sign a mandate</Link></p> : <Loading what="Reading your limits" />}
            <div className="vt-go"><Btn tone="fill" type="submit" busy={check.busy}>Check the limits and get a quote</Btn>{said.trim().length > 1 ? <Btn busy={read.busy} onClick={() => void read.run()}>Read my words</Btn> : null}</div>
            {check.error && !check.error.fields.amount ? <Problem error={check.error} /> : null}<Problem error={read.error} />
          </form>
        </section>

        {res ? (
          <section data-col="1" className="panel vt-quote" aria-labelledby="cq-h">
            <div className="panel-head"><h2 id="cq-h">{m(res.limits.amount)}: {res.limits.allowed ? 'inside your limits' : 'outside a limit'}</h2><EnforcedBy by="seen" label="Reading only" /></div>
            <p className="vt-panel-say">An indicative quote: a reading of the pools now. It is not an offer and has no expiry. The executable quote, with its floor and the time it is valid until, is made only when you approve, and the fill is what the chain then did. Nothing was signed.</p>
            <div className="vt-stack">
              <Checks checks={res.limits.checks} />
              {q?.allowed && q.expectedOut ? <>
                <dl className="vt-quote-figs">
                  <div><dt>You would receive about</dt><dd><strong>{cents(q.expectedOut)}</strong> in {unitWords(reserve.symbol)}</dd></div>
                  <div><dt>The best that is provably possible</dt><dd><strong>{cents(q.bound)}</strong> <span className="faint">The contract refuses any execution further from it than the order allows.</span></dd></div>
                </dl>
                {allows ? <p className="vt-say">When it is sent, QED's co-signer also checks it against {allows.kind === 'budget' ? <>your authority budget ({m(allows.left)} left), counting only its real cost</> : <>its allowance ({m(allows.left)} left), counting its whole amount</>}. This reading does not include that check.</p> : null}
                <details className="vt-fold"><summary>How the quote was worked out</summary>
                  <dl className="kv small">
                    <dt>Expected, exactly</dt><dd>{exact(q.expectedOut)}</dd>
                    <dt>Provable best, exactly</dt><dd>{exact(q.bound)}{q.gapPpm == null ? '' : `; the route found is within ${ppm(q.gapPpm)} of it`}</dd>
                    <dt>Route</dt><dd>{(q.plan?.hops ?? []).map(hop)}</dd>
                    <dt>Against simpler routers</dt><dd>{(q.plan?.alternatives ?? []).map((a) => <span key={a.policy} className="vt-block">{a.description}: {exact(a.amountOut)}, {(a.shortfallBps / 100).toFixed(2)}% worse{a.passesFloor === false ? '; the contract would refuse it' : ''}</span>)}</dd>
                    <dt>Where the quote comes from</dt><dd>{q.source.provider}, {q.source.instrument}, {q.source.priceType}; block {q.source.block}, received {iso(q.source.receivedAt)}. {q.source.freshness}</dd>
                  </dl>
                  <p className="vt-fold-p">{plain(q.notice)}</p>
                </details>
              </> : q && !q.allowed ? <Note tone="void">No figures are quoted for an amount the limits do not allow.</Note> : null}
              <div className="vt-go"><Btn tone="fill" busy={va.busy} onClick={() => void va.propose('convert', { amount: res.amount })}>{res.limits.allowed ? 'See the exact order and approve it' : 'Send it anyway and record the refusal'}</Btn></div>
              <Problem error={va.error} />
            </div>
          </section>
        ) : null}

        <section data-col="2" className="panel" aria-labelledby="lt-h">
          <div className="panel-head"><h2 id="lt-h">The last conversion</h2>{t ? <Link to={`/vault/job/${t.jobId}`}>Its record</Link> : null}</div>
          {t ? <>
            {/* finish review F4: the plain result here; block numbers and parts per million one step down */}
            <p className="vt-last-v">{m(t.amountIn)} <span className="faint">into</span> {cents(t.amountOut)}</p>
            <p className="vt-say">{iso(t.at)}. The contract checked its proof of best execution before it let it through; the best provably possible was {cents(t.bound)}.</p>
            <details className="vt-fold"><summary>Chain details</summary>
              <dl className="kv small">
                <dt>Received, exactly</dt><dd>{exact(t.amountOut)}</dd>
                <dt>Block</dt><dd>{t.block}</dd>
                <dt>Provable best</dt><dd>{exact(t.bound)}; this was {ppm(t.gapPpm)} from it</dd>
                <dt>Executable quote (signed before it was sent)</dt><dd>{t.executable ? `Floor ${exact(t.executable.floor)}, valid from ${iso(new Date(t.executable.validFrom * 1000).toISOString())} until ${iso(new Date(t.executable.expiresAt * 1000).toISOString())}. The wallet's contract refuses it after that time.` : `Floor ${exact(t.floor)}.`} Tolerance {ppm(t.tolerancePpm)}; {t.cosignerChecks} checks passed</dd>
                <dt>Fill (what the chain paid)</dt><dd>{exact(t.fill?.amountOut ?? t.amountOut)}, at or above the floor, in block {t.fill?.block ?? t.block}</dd>
                <dt>Route</dt><dd>{t.plan.hops.map(hop)}</dd>
                <dt>Prices in the proof</dt><dd>{pricesInWords(t.plan.prices)}</dd>
                <dt>Read by</dt><dd>{t.engine === 'offline-deterministic' ? 'The release\'s fixed parser. No model was involved' : t.engine}</dd>
              </dl>
            </details>
          </> : <p className="vt-empty">Nothing has been converted yet. A conversion you approve appears here with its proof.</p>}
        </section>
        <section data-col="2" className="panel" aria-labelledby="cn-h">
          <div className="panel-head"><h2 id="cn-h">The venues you named</h2><EnforcedBy by="contract" /></div>
          <p className="vt-panel-say">A conversion may use only these pools; their reserves are read from the chain.</p>
          <ul className="vt-venues">{st.venues.map((v) => <li key={v.i}><b>{venueName(v)}</b><span>{venueReserves(v)}</span></li>)}</ul>
          <p className="vt-foot vt-foot-say">{symbols.length ? `${cap(andList(symbols.map((x) => `${SIGN[x]} is ${unitWords(x)}`)))}. ` : ''}The only fee is each venue's own. QED adds none, and on this local chain gas is paid by the service.</p>
        </section>
      </div>
      {va.sheet}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ automatic conversions

/** A tick as the vault service records it; `summary` is the outcome in words (present on every tick, not in the shared type). */
type Tick = TickRecord & { summary?: string }
const CANDIDATE: Record<string, string> = { need: 'need', impact: 'impact', 'policy cap': 'policyCap', 'mandate cap': 'mandateCap', 'free funds': 'freeFunds' }
const LIMITED: Record<string, string> = { need: 'as much as the shortfall needed', impact: 'the most its cost limit allowed', 'policy cap': "the policy's largest tranche", 'mandate cap': "the mandate's limit for one payment", 'free funds': 'all the free funds' }

/** Why a tick came out as it did, in one sentence: the co-signer's rule when it refused, else the first sentence. */
function tickWhy(t: Tick): string | null {
  const s = plain(t.summary ?? '')
  const head = refusalHead(s)
  if (head) return `${head}.`
  if (t.outcome === 'executed' || t.outcome === 'no-action') return null
  const first = firstSentence(s)
  return first ? first : null
}

/**
 * The standing policy's ticks, newest first, with repeats folded: consecutive ticks that asked for the same tranche
 * and ended the same way are one row ("7 ticks, from ... to ..."). Each row says what the agent asked for and why it
 * stopped there, and why the result was what it was; the figures it weighed and each tick's job sit behind a disclosure.
 */
function TickLog({ ticks }: { ticks: Tick[] }) {
  const { main } = useUnits()
  const m = (raw: string | null | undefined): string => money(raw, main)
  const groups: Tick[][] = []
  for (const t of ticks) {
    const g = groups[groups.length - 1], h = g?.[0]
    if (h && h.action === t.action && h.amountIn === t.amountIn && h.outcome === t.outcome && tickWhy(h) === tickWhy(t)) g.push(t)
    else groups.push([t])
  }
  return (
    <ol className="vt-ticks">
      {groups.map((g) => {
        const t = g[0]!, last = g[g.length - 1]!, why = tickWhy(t)
        const asked = t.action === 'convert' ? `Asked to convert ${m(t.amountIn)}, ${LIMITED[t.limitedBy ?? ''] ?? `limited by ${t.limitedBy}`}`
          : t.action === 'wait' ? (t.limitedBy === 'impact' ? 'Waited: the market was too thin for the smallest tranche within its cost limit'
            : `Waited: only ${m(t.limitedBy ? (t.candidates as unknown as Record<string, string | null>)[CANDIDATE[t.limitedBy] ?? ''] : null)} could be converted (${LIMITED[t.limitedBy ?? ''] ?? t.limitedBy}), less than the smallest tranche`)
          : 'Nothing to do: the reserve was at its target'
        return (
          <li key={t.n}>
            <div className="vt-tick-when">{g.length > 1 ? <><b>{g.length} ticks</b><span>{between(last.at, t.at)}</span></> : <><b>Tick {t.n}</b><span>{iso(t.at)}</span></>}</div>
            <div className="vt-tick-what">
              <p className="vt-tick-asked">{asked}.</p>
              {why ? <p className="vt-tick-why">{why}</p> : null}
              <details className="vt-fold">
                <summary>What it weighed{g.length > 1 ? ', and each tick' : ''}</summary>
                <dl className="kv vt-tick-figs">
                  <dt>The shortfall needed</dt><dd className="num">{t.candidates.need === null ? 'More than any allowed tranche' : m(t.candidates.need)}</dd>
                  <dt>Its cost limit allowed</dt><dd className="num">{m(t.candidates.impact)}</dd>
                  <dt>The policy's largest tranche</dt><dd className="num">{m(t.candidates.policyCap)}</dd>
                  <dt>The mandate's limit for one payment</dt><dd className="num">{m(t.candidates.mandateCap)}</dd>
                  <dt>Free funds</dt><dd className="num">{m(t.candidates.freeFunds)}</dd>
                </dl>
                {t.summary ? <p className="vt-fold-p wrap-any">{plain(t.summary)}</p> : null}
                <ul className="vt-jobs">{g.map((k) => <li key={k.n}><Link to={`/vault/job/${k.jobId}`}>Tick {k.n}, {iso(k.at)}</Link></li>)}</ul>
              </details>
            </div>
            <div className="vt-tick-out"><Stamp tone={OUTCOME[t.outcome]?.[1] ?? 'plain'}>{OUTCOME[t.outcome]?.[0] ?? t.outcome}</Stamp></div>
          </li>
        )
      })}
    </ol>
  )
}

function Policy({ st }: { st: RailState }) {
  const va = useVaultAction()
  const { main, reserve } = useUnits()
  // the Overview's way of writing money: ₹ and $ on the figure, the unit in words; dollar figures to the cent
  const m = (raw: string | null | undefined): string => money(raw, main), cents = (raw: string | null | undefined): string => headline(raw ?? '0', reserve).text
  const pol = useData<{ policy: PolicyView | null; ticks: TickRecord[] }>('/api/vault/policy?limit=20')
  usePoll(pol.reload, 5000)
  const [target, setTarget] = useState('5'), [enforcement, setEnforcement] = useState<'cosigner' | 'contract'>('cosigner'), [slack, setSlack] = useState('10')
  const run = useAction(async (what: 'policy-tick' | 'policy-run') => { const a = await api<{ jobId: string }>('POST', `/api/vault/run/${what}`, { key: uuid() }); navigate(`/vault/job/${a.jobId}`) })
  const p = pol.data?.policy ?? st.policy
  const active = p && p.status === 'active' ? p : null
  const ticks = pol.data?.ticks ?? []
  const form = (
    <form className="vt-act-form" onSubmit={(e) => { e.preventDefault(); void va.propose('policy', { targetFree: target.trim(), enforcement, ...(enforcement === 'contract' ? { needSlackBps: Number(slack) } : {}) }) }}>
      <Field label={`Keep this much free in the reserve, in ${unitWords(reserve.symbol)}`} hint="The vault service states the bounds if it is outside them.">{(f) => <input {...f} className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
      <fieldset className="vt-enf"><legend className="legend">Enforced by</legend>
        <div className="choice">
          <label><input type="radio" name="enf" checked={enforcement === 'cosigner'} onChange={() => setEnforcement('cosigner')} /><b>The co-signer</b><small>It refuses any tranche the policy does not call for. Direct conversions stay available.</small></label>
          <label><input type="radio" name="enf" checked={enforcement === 'contract'} onChange={() => setEnforcement('contract')} /><b>A contract on the chain</b><small>The chain itself refuses anything else. It takes effect only after your owner account's delay; direct conversions are unavailable while it is wired.</small></label>
        </div>
      </fieldset>
      {enforcement === 'contract' ? <Field label="Slack, in basis points" hint="1 to 1000. Zero is refused: a policy with no slack can stall on rounding.">{(f) => <input {...f} className="input" inputMode="numeric" value={slack} onChange={(e) => setSlack(e.target.value)} />}</Field> : null}
      <div className="vt-go"><Btn tone="fill" type="submit" busy={va.busy}>See the exact policy</Btn></div>
    </form>
  )
  return (
    <>
      <div className="vt-split">
        <div className="vt-col">
          {active ? (
            <article className="instrument inforce vt-doc" aria-label="Standing policy">
              <div className="i-head"><span>Standing policy no. {active.id}</span><span>Signed {iso(active.signedAt)}</span></div>
              <div className="i-body">
                <p className="i-pay">Keep at least {cents(active.targetFree)} free in the reserve, converting {unitWords(main.symbol)} in tranches when it falls short.</p>
                <p className="crossing"><span className="vt-bracket" aria-hidden="true" />Each tranche {m(active.minTranche)} to {m(active.maxTranche)}, until {secs(active.validUntil)}</p>
                <dl className="clauses">
                  <dt>Now</dt><dd>{active.targetMet ? 'The target is met. Nothing to do.' : `Short by ${cents(active.shortfall)}; the reserve has ${cents(active.reserveFree)} free.`} {active.ticks} tick{active.ticks === 1 ? '' : 's'} so far.</dd>
                  <dt>Only if</dt><dd>A tranche costs no more than {(active.maxImpactBps / 100).toFixed(2)}% against the mid price, fits the mandate and the free funds, and the co-signer derives the same tranche for itself.</dd>
                  <dt>Enforced by</dt><dd>{active.enforcement === 'contract' ? `A policy contract on the chain, with ${active.needSlackBps ?? 0} basis points of slack. While it is wired, direct conversions and the attack tests are unavailable.` : 'The independent co-signer, which refuses any tranche the policy does not call for.'} <EnforcedBy by={active.enforcement === 'contract' ? 'contract' : 'qed'} /></dd>
                  <dt>How</dt><dd>QED's engine asks for one tick every five minutes, with no page open. Each tick converts one tranche, waits, or does nothing. Pausing QED stops it.</dd>
                </dl>
                {/* finish review F4: the standards, the nonce and the contract's address one step down, as on the mandate */}
                <div className="i-sign"><div className="signature"><div className="name">Signed with your passkey</div><small>{iso(active.signedAt)}. The co-signer keeps the signed text and works each tranche out from it again before it signs.</small>
                  <details className="vt-fold"><summary>Technical record</summary><dl className="kv small">
                    <dt>Standards</dt><dd>Signed text (EIP-191), checked through your owner account (ERC-1271)</dd>
                    <dt>Nonce</dt><dd className="code">{active.nonce}</dd>
                    {active.enforcement === 'contract' && active.policyContract ? <><dt>Policy contract</dt><dd className="code">{active.policyContract}</dd></> : null}
                  </dl></details>
                </div><Stamp big tone="ok" sub={active.enforcement === 'contract' ? 'enforced by contract' : 'enforced by the co-signer'}>In force</Stamp></div>
              </div>
              <div className="counterfoil vt-policy-acts"><Btn busy={run.busy} onClick={() => void run.run('policy-tick')}>Tick once now</Btn><Btn busy={run.busy} onClick={() => void run.run('policy-run')}>Run until the target is met</Btn><Btn tone="void" busy={va.busy} onClick={() => void va.propose('policy-revoke')}>End the policy</Btn></div>
            </article>
          ) : <Note tone="wait" title="No standing policy is in force">Sign one and the reserve is kept topped up without you, inside the mandate's limits.</Note>}
          <Problem error={run.error ?? va.error} />
        </div>
        <div className="vt-col">
          {active ? (
            <details className="panel vt-more"><summary>Sign a different policy <span>It replaces the one in force; the old one is refused from then on</span></summary>{form}</details>
          ) : (
            <section className="panel" aria-labelledby="ps-h"><div className="panel-head"><h2 id="ps-h">Sign a standing policy</h2><p>One signature, then tranches without you</p></div>{form}</section>
          )}
        </div>
      </div>
      <section className="panel" aria-labelledby="pt-h">
        <div className="panel-head"><h2 id="pt-h">Every tick, with what it weighed</h2><p>{ticks.length ? 'Newest first; repeats folded' : ''}</p></div>
        {ticks.length === 0 ? <p className="vt-empty">No tick has run yet. Once a policy is signed, QED's engine ticks it every five minutes and each tick appears here.</p> : <TickLog ticks={pol.data!.ticks} />}
      </section>
      {va.sheet}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ the test lab

/**
 * The test lab's own head (finish review F1): what it is for, and its two pages, reached from the one "Test lab" link
 * beside the owner's sections. Nothing here touches the owner's vault: every run has a throwaway chain of its own.
 */
function LabHead({ sub }: { sub: string }) {
  return (
    <section className="vt-lab-head" aria-labelledby="lab-h">
      <div className="vt-lab-intro">
        <h2 id="lab-h">Test lab</h2>
        <p>For checking the wallet's defences and trying whole exchanges. Each run uses a throwaway chain with contracts and keys of its own: your wallet and its money are not involved.</p>
      </div>
      <nav className="vt-tabs vt-lab-tabs" aria-label="Test lab sections">{LAB.map(([s, w]) => <Link key={s} to={`/vault/${s}`} current={sub === s}>{w}</Link>)}</nav>
    </section>
  )
}

function Lab() {
  const va = useVaultAction()
  const attacks = useData<{ attacks: AttackInfo[] }>('/api/vault/attacks')
  const hist = useData<{ history: HistoryEntry[] }>('/api/vault/history?limit=80')
  const ran = (hist.data?.history ?? []).filter((h) => h.kind === 'attack')
  return (
    <section className="panel" aria-labelledby="la-h">
      <div className="panel-head"><h2 id="la-h">Attack tests</h2><p>Each must be refused; the run proves it was</p></div>
      <p className="vt-panel-say">Each attack runs on a throwaway copy of the release's vault. It starts from a genuine, co-signed order and then cheats in one specific way, is mined for real, must revert, and that copy's balances are compared before and after. You approve the run's terms; nothing is signed for your owner account.</p>
      {!attacks.data ? (attacks.error ? <Problem error={attacks.error} /> : <Loading />) : (
        <ul className="vt-rows">{attacks.data.attacks.map((a) => { const last = ran.find((h) => h.title.toLowerCase().includes(a.title.toLowerCase().slice(0, 12))); return (
          <li key={a.kind}><span className="vt-rn"><b>{a.title}</b><span>Should be stopped by {a.layer}, with <span className="code">{a.expect}</span>.{last ? <> Last run {iso(last.at)}: <Link to={`/vault/job/${last.jobId}`}>{OUTCOME[last.outcome]?.[0] ?? last.outcome}</Link></> : null}</span></span><span className="vt-ra"><Btn busy={va.busy} onClick={() => void va.propose('attack', { kind: a.kind })}>Run this attack</Btn></span></li>) })}</ul>
      )}
      <Problem error={va.error} />
      {va.sheet}
    </section>
  )
}

function exampleOf(schema: unknown): unknown {
  const s = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown; minItems?: number; minimum?: number; pattern?: string; enum?: unknown[]; default?: unknown }
  if (s.default !== undefined) return s.default
  if (s.enum?.length) return s.enum[0]
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, exampleOf(v)]))
  if (s.type === 'array') return Array.from({ length: Math.max(1, s.minItems ?? 1) }, (_, i) => { const x = exampleOf(s.items); return typeof x === 'number' ? x + i * 10 : x })
  if (s.type === 'number' || s.type === 'integer') return Math.max(s.minimum ?? 1, 20)
  if (s.type === 'boolean') return false
  return s.pattern?.includes('[0-9]') ? '5' : ''
}

function Runs() {
  const va = useVaultAction()
  const sc = useData<{ scenarios: ScenarioInfo[] }>('/api/vault/scenarios')
  const ec = useData<{ economies: { scenario: string; title: string; label: string; available: boolean; takesInstruction: boolean; running: boolean }[]; running: string | null }>('/api/vault/economies')
  usePoll(ec.reload, 4000)
  const [params, setParams] = useState<Record<string, string>>({})
  const [bad, setBad] = useState<Record<string, string>>({})
  const [instruction, setInstruction] = useState('')
  const run = useAction(async (scenario: string, takes: boolean) => { const a = await api<{ jobId: string }>('POST', '/api/vault/run/economy', { key: uuid(), scenario, ...(takes && instruction.trim() ? { instruction: instruction.trim() } : {}) }); navigate(`/vault/job/${a.jobId}`) })
  const start = (s: ScenarioInfo) => { let parsed: unknown; try { parsed = JSON.parse(params[s.tool] ?? JSON.stringify(exampleOf(s.schema))) } catch { setBad((b) => ({ ...b, [s.tool]: 'That is not valid JSON.' })); return } setBad((b) => ({ ...b, [s.tool]: '' })); void va.propose('scenario', { tool: s.tool, parameters: parsed }) }
  return (
    <>
      <section className="panel" aria-labelledby="ec-h">
        <div className="panel-head"><h2 id="ec-h">Scripted economies</h2><p>Labelled scripted: fixed parties act out a whole exchange on the chain</p></div>
        {!ec.data ? (ec.error ? <Problem error={ec.error} /> : <Loading />) : (
          <ul className="vt-rows">{ec.data.economies.map((e) => (
            <li key={e.scenario}><span className="vt-rn"><b>{e.title} <Stamp tone="plain">Scripted</Stamp></b>{!e.available ? <span className="wait">Not available in this build: it needs the optional zero-knowledge components, which wait on your licence decision.</span> : null}
              {e.takesInstruction && e.available ? <span className="vt-inline-field"><Field label="Instruction for the agent in the script" hint="Optional. The script's agent reads it with the release's fixed parser, for example: Convert 20 tUSD to tEUR.">{(p) => <input {...p} className="input" value={instruction} onChange={(x) => setInstruction(x.target.value)} />}</Field></span> : null}</span>
              <span className="vt-ra"><Btn busy={run.busy} disabled={!e.available || !!ec.data!.running} onClick={() => void run.run(e.scenario, e.takesInstruction)}>{e.running ? 'Running' : 'Run it'}</Btn></span></li>))}</ul>
        )}
        {ec.data?.running ? <p className="vt-after">One script runs at a time. “{ec.data.running}” is running now.</p> : null}
        <Problem error={run.error} />
      </section>
      <section className="panel" aria-labelledby="sc-h">
        <div className="panel-head"><h2 id="sc-h">Scenarios you set up yourself</h2><p>Fresh contracts and parties on a throwaway chain each time; your wallet is not involved</p></div>
        {!sc.data ? (sc.error ? <Problem error={sc.error} /> : <Loading />) : (
          <ul className="vt-rows">{sc.data.scenarios.map((s) => (
            <li key={s.tool} className="vt-scenario">
              <span className="vt-rn"><b>{plain(s.label)}</b><span>{s.bounds}</span>{!s.available ? <span className="wait">{s.unavailableReason}</span> : null}
                {/* A focused textarea is scrolled only as far as its caret, which left its lower half under the tab bar at
                    640 by 360 (a 1280 by 720 window at 200%): it brings itself wholly into view, inside the page's scroll padding for the bars. */}
                {s.available ? <span className="vt-inline-field"><Field label="Its parameters" hint="As JSON. The vault service checks them against the bounds above." error={bad[s.tool] || undefined}>{(p) => <textarea {...p} className="input code vt-json" rows={2} spellCheck={false} value={params[s.tool] ?? JSON.stringify(exampleOf(s.schema))} onFocus={(e) => { const t = e.currentTarget; requestAnimationFrame(() => { if (document.activeElement === t) t.scrollIntoView({ block: 'nearest' }) }) }} onChange={(e) => setParams((x) => ({ ...x, [s.tool]: e.target.value }))} />}</Field></span> : null}</span>
              <span className="vt-ra"><Btn busy={va.busy} disabled={!s.available} onClick={() => start(s)}>See the terms and run it</Btn></span>
            </li>))}</ul>
        )}
        <Problem error={va.error} />
      </section>
      {va.sheet}
    </>
  )
}

// ------------------------------------------------------------------------------------------------ records

/** A job's summary as a headline: the co-signer's rule when it refused, else the summary's first sentence. */
function jobHead(j: Job): string {
  const s = j.result?.summary ? plain(j.result.summary) : cap(KIND[j.kind] ?? j.kind)
  const head = refusalHead(s)
  if (head) return head
  if (s.length <= 160) return s
  return firstSentence(s).slice(0, 200)
}

/**
 * What the vault was asked to do, newest first, with repeats folded: consecutive jobs of the same kind that ended the
 * same way for the same reason are one row. A long record keeps its full text behind a disclosure, with a link to
 * each job.
 */
function JobList({ jobs }: { jobs: Job[] }) {
  const state = (j: Job): string => j.result?.outcome ?? j.status
  const groups: Job[][] = []
  for (const j of jobs) {
    const g = groups[groups.length - 1], h = g?.[0]
    if (h && h.kind === j.kind && state(h) === state(j) && jobHead(h) === jobHead(j)) g.push(j)
    else groups.push([j])
  }
  return (
    <ul className="vt-rows vt-joblist">{groups.map((g) => {
      const j = g[0]!, last = g[g.length - 1]!, head = jobHead(j), full = j.result?.summary ? plain(j.result.summary) : null
      const when = g.length > 1 ? `${g.length} times, ${between(last.createdAt, j.createdAt)}` : iso(j.createdAt)
      return (
        <li key={j.id}>
          <span className="vt-rn">
            <Link to={`/vault/job/${j.id}`} className="vt-job-t">{head}</Link>
            <span>{cap(KIND[j.kind] ?? j.kind)}, {when}{j.error ? `. ${j.error}` : ''}</span>
            {(full && full !== head) || g.length > 1 ? (
              <details className="vt-fold"><summary>{full && full !== head ? 'The full record' : 'Each time'}{full && full !== head && g.length > 1 ? ', and each time' : ''}</summary>
                {full && full !== head ? <p className="vt-fold-p wrap-any">{full}</p> : null}
                {g.length > 1 ? <ul className="vt-jobs">{g.map((k) => <li key={k.id}><Link to={`/vault/job/${k.id}`}>{iso(k.createdAt)}</Link></li>)}</ul> : null}
              </details>
            ) : null}
          </span>
          <span className="vt-ra">{j.result ? <Stamp tone={OUTCOME[j.result.outcome]?.[1] ?? 'plain'}>{OUTCOME[j.result.outcome]?.[0] ?? j.result.outcome}</Stamp> : <Stamp tone={j.status === 'failed' || j.status === 'interrupted' ? 'void' : j.status === 'accepted' || j.status === 'running' ? undefined : 'plain'}>{cap(j.status)}</Stamp>}</span>
        </li>
      )
    })}</ul>
  )
}

function Records() {
  const dec = useData<{ decisions: DecisionRecord[] }>('/api/vault/decisions?limit=40')
  const ver = useData<{ ok: boolean; records: number; brokenAt: number | null; head: string }>('/api/vault/decisions-verify')
  const jobs = useData<{ jobs: Job[] }>('/api/vault/jobs?limit=30')
  const ev = useData<HistoricalEvidence>('/api/vault/evidence')
  const decisions = dec.data?.decisions ?? []
  return (
    <>
      <section className="panel vt-decisions" aria-labelledby="rd-h">
        <div className="panel-head"><h2 id="rd-h">Decision records</h2><EnforcedBy by="seen" /></div>
        <p className="vt-panel-say">Every approval, verdict and refusal, each chained to the one before. The chain shows a record changed after it was written; it does not stop the change.</p>
        <p className="vt-chain">{ver.data ? (ver.data.ok ? <><Stamp tone="ok">Chain intact</Stamp> <span>{ver.data.records} records, re-hashed by the vault service just now.</span></> : <><Stamp tone="void">Broken at no. {ver.data.brokenAt}</Stamp> <span>A record at or before that number was changed after it was written.</span></>) : ver.error ? <span className="wait">The chain could not be checked just now.</span> : <span className="faint">Checking the chain.</span>}</p>
        {decisions.length ? (
          <div className="ledger-wrap vt-flat" tabIndex={0} role="region" aria-label="Decision records; scroll sideways on a narrow screen"><table className="ledger">
            <thead><tr><th scope="col">No.</th><th scope="col">When</th><th scope="col">What happened</th><th scope="col">Verdict</th></tr></thead>
            <tbody>{decisions.map((d) => <tr key={d.n}><td>{d.n}</td><td className="date">{iso(d.at)}</td><td>{d.jobId ? <Link to={`/vault/job/${d.jobId}`}>{recordWords(d.kind)}</Link> : recordWords(d.kind)}{d.approval ? <span className="sub">{d.jobId ? `Approved by you with ${how(d.approval.method)}, ${iso(d.approval.confirmedAt)}` : `Under your approval of ${iso(d.approval.confirmedAt)}, with ${how(d.approval.method)}`}</span> : null}</td><td>{cap(verdict(d.verdict))}</td></tr>)}</tbody>
          </table></div>
        ) : dec.error ? <Problem error={dec.error} /> : dec.data ? <p className="vt-empty">No decision has been recorded yet.</p> : <Loading what="Reading the records" />}
        {decisions.length ? (
          <details className="vt-fold"><summary>Their fingerprints, and the approvals</summary>
            {ver.data ? <p className="vt-fold-p">Latest fingerprint <span className="code">{fmt.hash(ver.data.head.replace(/^sha256:|^0x/, ''))}</span>.</p> : null}
            <dl className="kv small">{decisions.map((d) => <div key={d.n} className="vt-contents"><dt>No. {d.n}, {words(d.kind)}</dt><dd><span className="code">{fmt.hash(d.hash.replace(/^sha256:|^0x/, ''))}</span>{d.approval ? <> under approval <span className="code">{d.approval.approvalId}</span></> : null}</dd></div>)}</dl>
          </details>
        ) : null}
      </section>
      <div className="vt-split even">
        <section className="panel" aria-labelledby="rj-h">
          <div className="panel-head"><h2 id="rj-h">Everything the wallet was asked to do</h2><p>Newest first; repeats folded</p></div>
          {jobs.data?.jobs.length ? <JobList jobs={jobs.data.jobs} /> : jobs.error ? <Problem error={jobs.error} /> : jobs.data ? <p className="vt-empty">Nothing yet. Each action you approve appears here, with its record.</p> : <Loading />}
        </section>
        <section className="panel" aria-labelledby="re-h">
          <div className="panel-head"><h2 id="re-h">Historical evidence from the public test network</h2><Stamp tone="plain">Historical</Stamp></div>
          {ev.data ? <>
            <p className="vt-panel-say">{ev.data.note} These are records of what the approved release did on {ev.data.network.replace(/\s*\(chain \d+\)/, '')} in the past: {ev.data.counts.transactions} transactions, of which {ev.data.counts.reverted} reverted as intended, and {ev.data.counts.contracts} contracts. They are shown from the saved files. Nothing here was checked against that network today.</p>
            <details className="vt-fold"><summary>Show the {ev.data.counts.transactions} transactions</summary>
              <p className="vt-fold-p">On {ev.data.network}.</p>
              <div className="ledger-wrap vt-flat" tabIndex={0} role="region" aria-label="Historical transactions; scroll sideways on a narrow screen"><table className="ledger">
                <thead><tr><th scope="col">Run</th><th scope="col">Step</th><th scope="col">Result</th><th scope="col" className="wide-only">Transaction</th></tr></thead>
                <tbody>{ev.data.transactions.map((t) => <tr key={`${t.run}-${t.id}-${t.hash}`}><td className="small">{t.run}</td><td>{t.title}<span className="sub">{t.phase}{t.expect ? `; expected ${t.expect}` : ''}</span></td><td className={t.status === 'reverted' ? 'small void' : 'small'}>{t.status}{t.error ? `: ${t.error}` : ''}</td><td className="wide-only code small">{short(t.hash)}</td></tr>)}</tbody>
              </table></div></details>
          </> : ev.error ? <Problem error={ev.error} /> : <Loading />}
        </section>
      </div>
    </>
  )
}

// ------------------------------------------------------------------------------------------------ the screen

export function VaultScreen({ sub }: { sub: string }) {
  const o = useData<Overview>('/api/vault', ['vault'])
  const d = o.data, st = d?.state ?? null, ws = d?.workspace ?? null
  const stage: Stage | null = !d ? (o.error ? 'unavailable' : null) : !d.available ? 'unavailable'
    : !d.setUp || !ws || ws.status === 'deploying' || ws.status === 'failed' || !st ? 'none' : st.provisioned ? 'owned' : 'offered'
  let body: ReactNode
  if (!d) body = o.error ? <Problem error={o.error} /> : <div className="page-wait"><Loading what="Reaching the vault service" /></div>
  else if (!d.available) {
    body = <>
      <Note tone="wait" title="The on-chain wallet's service is not answering">{d.reason}</Note>
      <p className="vt-say">Nothing in your wallet has changed: its test tokens stay on its chain, and nothing can move them without your passkey. Everything else in QED works without this service.</p>
      <div><Btn onClick={o.reload}>Try again</Btn></div>
      <details className="vt-fold"><summary>If you run this QED yourself</summary><p className="vt-fold-p">The wallet is a separate service from QED&apos;s engine, because it runs a local chain. On a development machine, start it in a terminal: <code>cd apps/qed-demo/chain && npm start</code>. On a deployment, its log says why it stopped.</p></details>
    </>
  } else if (stage === 'none' || !st) body = <SetUp o={d} reload={o.reload} />
  else if (sub !== '' && sub !== 'records' && !st.provisioned) body = <Note tone="wait">Your wallet is not accepted yet. <Link to="/vault">Accept it first.</Link></Note>
  else {
    body = sub === '' ? <VaultHome o={d} reload={o.reload} />
      : sub === 'mandate' ? <MandatePage st={st} />
      : sub === 'treasury' ? <Treasury st={st} />
      : sub === 'convert' ? <Convert st={st} />
      : sub === 'policy' ? <Policy st={st} />
      : sub === 'lab' ? <><LabHead sub={sub} /><Lab /></>
      : sub === 'runs' ? <><LabHead sub={sub} /><Runs /></>
      : sub === 'records' ? <Records />
      : <p>There is no such section. <Link to="/vault">Back to the wallet</Link></p>
  }
  // One tree at every stage (DESIGN.md M11): the head keeps its place, and its nodes, from the first frame to the data,
  // so it is painted once and never replaced; only the body below it changes. Its tabs show while the service is read.
  return (
    <Ws.Provider value={d ?? null}><Units.Provider value={ws ? { main: ws.asset, reserve: ws.reserveAsset } : UNITS}>
      <div className="vt">
        <Head sub={sub} state={stage === 'owned' || stage === 'offered' ? st : null} stage={stage} nav={stage === null || stage === 'owned'} />
        {body}
      </div>
    </Units.Provider></Ws.Provider>
  )
}

// ------------------------------------------------------------------------------------------------ a job, as a record

/**
 * A refused step's reason in one line: the co-signer's rule and its name, else the reason's first sentence when it is
 * short. Null when the first sentence is long: it is then shown whole one step down, never cut (it can carry amounts).
 */
export function reasonHead(detail: string): string | null {
  const s = plain(detail)
  const m = /^(?:Co-signer )?[Rr]efused: (C\d+) not met: ([^:]+):/.exec(s)
  if (m) return `Refused under the co-signer's ${ruleName(m[2]!)} rule.`
  const f = firstSentence(s)
  return f.length <= 220 ? f : null
}

/** Who asked for a job, in words: the owner with the passkey, QED under a standing policy, or anyone, where the contract allows it. */
const askedBy = (kind: string): string => (kind === 'policy-tick' || kind === 'policy-run' ? 'QED, under the standing policy you signed' : kind === 'settle' ? 'Anyone may: a promise that has fallen due is paid to its creditor only' : kind === 'apply-change' ? 'Anyone may, once the delay has passed: the change is applied exactly as you approved it' : kind === 'attack' || kind === 'scenario' || kind === 'economy' ? 'You, in the test lab: it runs on a throwaway chain' : 'You')

export function VaultJobScreen({ id }: { id: string }) {
  const job = useData<Job>(`/api/vault/jobs/${id}`)
  const live = !job.data || job.data.status === 'accepted' || job.data.status === 'running' || job.data.status === 'confirming'
  usePoll(job.reload, 1200, live)
  const dec = useData<{ decisions: DecisionRecord[] }>(job.data && !live ? `/api/vault/decisions?jobId=${id}` : null)
  const board = useMasonry()
  if (!job.data) {
    return (
      <div className="vt vt-job">
        <header className="page-head vt-job-head"><div><Crumb to="/vault">On-chain wallet</Crumb>{job.error ? null : <div className="skel vt-skel-h1" aria-hidden="true" />}<p className="vt-job-when">On a test chain on this computer; the tokens have no value.</p></div></header>
        {job.error ? <><Problem error={job.error} /><p><Link to="/vault">Back to the wallet</Link></p></> : <Loading what="Opening the record" />}
      </div>
    )
  }
  const j = job.data, r = j.result
  const out = r ? OUTCOME[r.outcome] ?? [r.outcome, 'plain' as const] : null
  const summary = r?.summary ? plain(r.summary) : null
  const title = tokensInWords(summary ? (refusalHead(summary) ?? firstSentence(summary)) : cap(KIND[j.kind] ?? j.kind))
  const more = summary ? (refusalHead(summary) ? '' : rest(summary)) : ''
  const approval = dec.data?.decisions.find((d) => d.approval)?.approval ?? null
  const signedWords = /“([^”]+)”/.exec(j.steps.find((s) => s.key === 'owner')?.detail ?? '')?.[1] ?? null
  const failed = j.steps.filter((s) => s.status === 'refused' || s.status === 'reverted')
  const done = j.steps.filter((s) => s.status === 'ok' || s.status === 'info').length
  const balances = j.steps.find((s) => s.key === 'reconcile' && s.status === 'ok')
  return (
    <div className="vt vt-job">
      <header className="page-head vt-job-head">
        <div><Crumb to="/vault">On-chain wallet</Crumb><h1>{title}</h1><p><Src kind="chain" /></p>{more ? <p className="wrap-any">{more}</p> : null}<p className="vt-job-when">Asked {iso(j.createdAt)}{j.finishedAt ? `, finished ${iso(j.finishedAt)}` : ''}. {chainLine(j.network)}</p></div>
        {j.status === 'confirming' ? <Stamp big>Confirming</Stamp> : j.status === 'reorged' ? <Stamp big tone="void">Not done</Stamp> : out ? <Stamp big tone={out[1]}>{out[0]}</Stamp> : <Stamp big tone={j.status === 'failed' || j.status === 'interrupted' ? 'void' : live ? undefined : 'plain'}>{live ? 'Running' : cap(j.status)}</Stamp>}
      </header>
      {j.status === 'confirming' ? <Note tone="wait" title="Mined, waiting for its confirmations">Its transaction is in block {j.confirmations?.block ?? 'not read yet'}, with {j.confirmations?.have ?? 0} of the {j.confirmations?.need ?? 2} confirmations an operation needs before QED reports it done (the block itself counts as one). If a reorganisation of the chain replaces that block first, it is reported as not done, never as done.</Note> : null}
      {j.error ? <Note tone="void" title={j.status === 'interrupted' ? 'The service stopped while this was running' : j.status === 'reorged' ? 'A reorganisation of the chain undid it' : 'It stopped with an error'}>{plain(j.error)}{j.guidance ? <span className="vt-block">{plain(j.guidance)}</span> : null}</Note> : null}
      {r?.doNotRetry ? <Note tone="void" title="Do not send this again">The transaction was mined but the balances afterwards did not match what was expected. Sending it again could move money twice. Look at the receipt and the records first.</Note> : null}
      <div className="board vt-board vt-job-board" ref={board}>
        <section data-col="1" className="panel vt-asked" aria-labelledby="ja-h">
          <h2 id="ja-h" className="vt-rec-h">What was asked</h2>
          <p className="vt-asked-what"><strong>{cap(KIND[j.kind] ?? j.kind)}</strong>{signedWords ? <>: <span>“{plain(signedWords)}”</span></> : null}</p>
          <p className="vt-say">{askedBy(j.kind)}{approval ? `, approved with ${how(approval.method)} ${iso(approval.confirmedAt)}` : ''}.</p>
        </section>
        <section data-col="2" className="panel vt-checks-panel" aria-labelledby="jc-h">
          <h2 id="jc-h" className="vt-rec-h">The checks</h2>
          <p className="vt-say" aria-live="polite">{live ? 'Updating as it runs.' : failed.length ? `${done} of ${j.steps.length} steps passed; ${failed.length} did not.` : `${j.steps.length} step${j.steps.length === 1 ? '' : 's'}, each passed.`}</p>
          <ol className="vt-checks">
            {j.steps.map((s) => {
              const bad = s.status === 'refused' || s.status === 'reverted'
              return (
                <li key={s.seq} className={bad ? 'bad' : s.status === 'pending' ? 'todo' : ''}>
                  <span className="vt-check-mark">{s.status === 'pending' ? <span className="vt-ring" aria-hidden="true" /> : <Mark pass={!bad} />}</span>
                  <span className="vt-check"><span>{stepName(j.kind, s)}{bad ? <strong className="void">: {s.status}</strong> : null}<span className="sr">{bad ? '' : s.status === 'pending' ? ', waiting' : ', passed'}</span></span>
                    {bad ? <><span className="vt-why">{reasonHead(s.detail) ?? 'Its reason, in the vault service\'s words, is below.'}</span><details className="vt-fold"><summary>Its full reason</summary><p className="vt-fold-p wrap-any">{plain(s.detail)}</p></details></> : null}</span>
                  <time dateTime={s.at}>{fmt.time(Date.parse(s.at), true)}</time>
                </li>
              )
            })}
            {live ? <li className="todo"><span className="vt-check-mark"><span className="vt-ring" aria-hidden="true" /></span><span className="vt-check"><span>Waiting for the next step</span></span></li> : null}
          </ol>
          <details className="vt-fold"><summary>Each step as the vault service recorded it</summary>
            <ol className="vt-steps-said">{j.steps.map((s) => <li key={s.seq}><b>{plain(s.label)}</b><span className="t">{fmt.precise(Date.parse(s.at))}</span><span className="wrap-any">{plain(s.detail)}</span></li>)}</ol>
          </details>
        </section>
        <section data-col="1" className="panel vt-result" aria-labelledby="jr-h">
          <h2 id="jr-h" className="vt-rec-h">The result</h2>
          <p className="vt-result-line">{out ? <Stamp tone={out[1]}>{out[0]}</Stamp> : <Stamp tone={live ? undefined : 'plain'}>{live ? 'Running' : cap(j.status)}</Stamp>} {r?.tx ? (r.tx.status === 'success' ? 'Mined on the chain, and it succeeded.' : `Mined on the chain as a revert${r.tx.error ? `: ${plain(r.tx.error)}` : ''}. Nothing moved.`) : r ? 'Nothing was sent to the chain for this.' : live ? <span className="faint">It is still running; this page follows it.</span> : null}</p>
          {/* who refused it: QED's checks before anything was sent (the chain never saw it), or the contract on the chain */}
          {refusedBy(r) === 'qed' ? <p className="vt-result-by"><EnforcedBy by="qed" /><span>QED refused it before anything was sent: the chain never saw it.</span></p>
            : refusedBy(r) === 'contract' ? <p className="vt-result-by"><EnforcedBy by="contract" /><span>The wallet's contract refused it on the chain.</span></p> : null}
          {balances ? <p className="vt-say"><span className="faint">Balances: </span>{plain(balances.detail)}</p> : null}
          {summary && title !== firstSentence(summary) ? <details className="vt-fold"><summary>The vault service's own words</summary><p className="vt-fold-p wrap-any">{summary}</p></details> : null}
        </section>
        <section data-col="1" className="panel vt-refs" aria-labelledby="jx-h">
          <h2 id="jx-h" className="vt-rec-h">References</h2>
          <details className="vt-fold"><summary>The transaction, the records and the evidence</summary>
            <dl className="kv small">
              {r?.tx ? <>
                <dt>Transaction</dt><dd><span className="code">{r.tx.hash}</span> <Btn small onClick={() => void navigator.clipboard?.writeText(r.tx!.hash).catch(() => {})}>Copy the hash</Btn></dd>
                <dt>Result on the chain</dt><dd className={r.tx.status === 'reverted' ? 'void' : ''}>{r.tx.status === 'success' ? 'Mined and succeeded' : `Mined as a revert${r.tx.error ? `: ${r.tx.error}` : ''}`}</dd>
                <dt>Block</dt><dd>{r.tx.block}</dd>
                <dt>Gas used</dt><dd>{Number(r.tx.gasUsed).toLocaleString('en-US')} <span className="faint">paid by the service; the local chain's gas has no value</span></dd>
              </> : null}
              {(dec.data?.decisions ?? []).map((d) => <div key={d.n} className="vt-contents"><dt>Record no. {d.n}</dt><dd>{recordWords(d.kind)}, {verdict(d.verdict)}, {iso(d.at)}{d.approval ? `, under approval ${d.approval.approvalId}, confirmed with ${how(d.approval.method)}` : ''}. Fingerprint <span className="code">{fmt.hash(d.hash.replace(/^sha256:|^0x/, ''))}</span></dd></div>)}
              <dt>Network</dt><dd>{plain(j.network)}</dd>
              <dt>Record</dt><dd className="code">{j.id}</dd>
            </dl>
            {r?.evidence ? <details className="vt-fold"><summary>The evidence stored with the result</summary><pre className="vt-pre">{JSON.stringify(r.evidence, null, 2)}</pre></details> : null}
          </details>
        </section>
      </div>
    </div>
  )
}
