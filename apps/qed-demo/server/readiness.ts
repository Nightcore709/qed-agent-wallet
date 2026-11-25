/**
 * Readiness (R7-088, R7-098): what this build is, what it derives from, and why it is not ready for real money.
 *
 *   Build       the git revision the running code was started from, and whether its files differ from that revision.
 *   Release     the approved release this build's vault contracts and engines are copied from (chain/VENDORED.json).
 *   Blockers    every open risk of severity Critical or High in the risk register (docs/shared/RISK_REGISTER.md; the
 *               last row for an id is its standing, since the register is append-only), every evidence run on record
 *               with a failing step, every requirement of the register (register/r7.json) that is not met, and the
 *               standing facts that make it a test build. Medium and low risks are listed and do not block.
 *
 * The view never says "ready" while any blocker remains, and this build always has the standing ones: it runs on a
 * local test chain with valueless tokens and paper venues, and no one outside this work has reviewed it. The files are
 * read when asked, so the view follows the records as they change; a build without them says so.
 *
 * The page is read by the person using QED, while the registers are the team's working records, so the view never
 * passes on a register's own words (finish review, 23 Nov: the page printed a credential incident and the team's
 * deadlines). Each open risk is said in plain words written for it here (PLAIN), grouped by area, with its register id
 * one step down. An entry about the team's own operations (its accounts, credentials and keys, incidents, deployment,
 * billing, tools, documents and deadlines: OPERATIONS) is never shown, only counted, and so are the requirements of the
 * team's own working method. A risk with no plain words yet is counted, never quoted, and still blocks when it is
 * critical or high; a test fails until it is placed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(import.meta.dirname, '..')
const ROOT = join(APP, '..', '..')

export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Unknown'
export interface Risk { id: string; title: string; severity: Severity; severityText: string; status: string; open: boolean; updated: boolean }
export interface Blocker { kind: 'standing' | 'risk' | 'evidence' | 'requirement'; id: string; title: string; detail: string; severity: Severity; area?: string }
const ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low', 'Unknown']
const blocks = (s: Severity): boolean => s === 'Critical' || s === 'High'

/** "High (time-bound)", "High for any real-money path", "Med" and "High within the model" all have a severity first. */
export function severityOf(text: string): Severity {
  const t = text.trim().toLowerCase()
  if (t.startsWith('critical')) return 'Critical'
  if (t.startsWith('high')) return 'High'
  if (t.startsWith('med')) return 'Medium'
  if (t.startsWith('low')) return 'Low'
  return 'Unknown'
}
/** A risk stays open unless its standing starts with closed, fixed, retired, resolved, superseded, withdrawn or mitigated (not "partly"). */
export function isOpen(status: string): boolean {
  const s = status.trim().toLowerCase()
  if (/^(closed|fixed|retired|resolved|superseded|withdrawn|mitigated)\b/.test(s) && !/\bpartly\b|\bin part\b/.test(s)) return false
  return true
}

/** A cell an update leaves as it was: empty, a dash, or "n/a". */
const UNCHANGED = /^(|—|–|-|n\/a)$/i
/**
 * The risk register's rows, one per id, each at its latest standing. A later row for an id updates it, however it is
 * marked ("| RISK-034 (update, 20 Nov) | … |", or "| RISK-053 | (Update, 22 Nov) … |"): its severity and status replace
 * the earlier ones, and the title stays the original's. An update whose severity is a dash keeps the severity, and one
 * whose status is a dash or a note on wording ("Superseding note") keeps the standing.
 */
export function parseRisks(md: string): Risk[] {
  const byId = new Map<string, Risk>()
  for (const line of md.split('\n')) {
    const m = /^\|\s*(RISK-\d{3})(\s*\([^)]*\))?\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line)
    if (!m) continue
    const [, id, , title, sev, status] = m as unknown as [string, string, string | undefined, string, string, string]
    const was = byId.get(id)
    const severityText = was && UNCHANGED.test(sev.trim()) ? was.severityText : sev.trim()
    const standing = was && (UNCHANGED.test(status.trim()) || /^superseding note\b/i.test(status.trim())) ? was.status : status.trim()
    byId.set(id, { id, title: was ? was.title : title.trim(), severity: severityOf(severityText), severityText, status: standing, open: isOpen(standing), updated: !!was })
  }
  return [...byId.values()]
}

// ------------------------------------------------------------------------------------------------ risks, in plain words

type Area = 'signing' | 'protection' | 'running' | 'wallet' | 'checking' | 'law' | 'privacy' | 'records' | 'build'
/** The areas, in the order the page shows them. */
const AREAS: [Area, string][] = [
  ['signing', 'Signing and who can act'], ['protection', 'What the protections promise'], ['running', 'When QED cannot act'],
  ['wallet', 'The on-chain wallet\'s earned limits'], ['checking', 'How it was checked'], ['law', 'Payments, law and licences'],
  ['privacy', 'Privacy and Ask'], ['records', 'Records and statements'], ['build', 'What this build is'],
]
/**
 * Each open risk that bears on the product, said for the person using it: what can go wrong, without the register's
 * references (decisions, evidence ids, documents, experiments, commits). Written from the register's latest row for the
 * id; when a risk's standing changes, its sentence is checked against the new row.
 */
const PLAIN: Record<string, [Area, string]> = {
  'RISK-005': ['build', 'It runs on a local test chain, and the wallet service signs in software on one computer: no secure hardware protects it, and nothing has been audited.'],
  'RISK-006': ['protection', 'The best-price check covers only simple pools and the venues you name, and does not catch front-running smaller than 1%.'],
  'RISK-014': ['protection', 'A move QED shows as safe can still be wrong when its picture of an instrument or of the household\'s money is wrong.'],
  'RISK-015': ['protection', 'The floor can be broken by a price gap larger than the limits assume, by QED not running when it has to act, or by manipulated prices.'],
  'RISK-018': ['protection', 'Debits that others can take on their own, such as mandates and card captures, can take the account below the floor; QED cannot stop them.'],
  'RISK-019': ['running', 'If a broker login lapses or a broker is down, QED cannot sell to keep you above the floor.'],
  'RISK-020': ['law', 'Suggesting or automating investment moves may need registration as an adviser or an algorithm provider in India and the US; none is held.'],
  'RISK-021': ['checking', 'The evidence that the floor holds comes from models written alongside the code, so a mistake they share would not show.'],
  'RISK-022': ['checking', 'The checker that approves a plan shares its author, its figures and its test cases with the planner that makes it.'],
  'RISK-023': ['signing', 'A compromised device or page could show you one thing while your passkey signs another; nothing outside the page confirms what you sign.'],
  'RISK-024': ['running', 'An exchange that switched off the agent\'s trading would also stop QED\'s protective selling.'],
  'RISK-025': ['protection', 'The worst case leaves out the tax due on gains and on selling, so it overstates what a taxable owner would keep.'],
  'RISK-026': ['protection', 'Words such as "protection" and "certified" can be read as guarantees, and they are not.'],
  'RISK-029': ['law', 'In India no verified way lets QED pay a card, rent or your own account without your approval each time, apart from bills up to ₹5,000 through UPI Circle.'],
  'RISK-031': ['protection', 'For households with little cash, QED can rarely find a move it can show to be safe.'],
  'RISK-032': ['checking', 'Some readings of loans and deposits are shared by both independent checkers, so checking one against the other cannot catch them.'],
  'RISK-034': ['protection', 'In the research model behind the limits, an agent can still move value out without it counting against its limit, through debts it creates or trades with a pool that colludes.'],
  'RISK-036': ['protection', 'A safety certificate worked out for figures that differ from the household\'s real money is false for that household.'],
  'RISK-037': ['protection', 'Some limits behind the worst case, such as 25% for an index fund and 15% for gold, have no calibration behind them.'],
  'RISK-038': ['running', 'A lapsed broker login can hold up every instruction, bills included, not only those that use that broker.'],
  'RISK-041': ['signing', 'An account that signs in with a password alone has no second factor, and the password cannot be changed here.'],
  'RISK-042': ['protection', 'What must stay in the bank covers only payments on record, 150 days ahead; a payment that comes into view later can raise it, and a run can then be refused.'],
  'RISK-043': ['running', 'QED runs on this computer: while it sleeps nothing runs, and what fell due is recorded as missed, never done late.'],
  // how far attacks through Ask have been tried against a real model is said once, under RISK-099
  'RISK-044': ['privacy', 'When you use Ask, a model sees a summary of your position.'],
  'RISK-046': ['law', 'The market data here may be used for the owner\'s own review only; showing it publicly would need each provider\'s permission.'],
  'RISK-048': ['wallet', 'On the on-chain wallet, a payment after a conversion of more than 10 test rupees is refused by the allowance rule it inherits.'],
  'RISK-049': ['protection', 'Where households share one trading pool, money flowing through it can take one of them below its floor even within the limits assumed.'],
  'RISK-050': ['checking', 'Tests passed while five faults in authority and safety were present; a reviewer from outside would be expected to find more.'],
  'RISK-051': ['records', 'Money you record by hand is not recognised as salary, so a salary recorded that way still counts as outstanding.'],
  'RISK-052': ['checking', 'The figures on each screen are checked by reading them, not by a test of each figure, and wrong figures have got through before.'],
  'RISK-053': ['signing', 'A stolen passkey can sign for the on-chain wallet until its removal takes effect, and if every device is lost and the recovery code stolen, no one can stop a recovery.'],
  'RISK-054': ['signing', 'In a shared workspace the chain enforces only the number of signatures set when the wallet was set up; a higher number asked for large amounts is checked by QED alone.'],
  'RISK-056': ['wallet', 'Two people paying each other through the escrow could each raise the other\'s earned limit.'],
  'RISK-057': ['wallet', 'Earned limits assume QED knows every address of every member; money sent back from an address it does not know could count as earned.'],
  'RISK-058': ['wallet', 'On the shared test chain, one participant can move the test market\'s prices far enough to stop every workspace\'s conversions.'],
  'RISK-066': ['records', 'You cannot export a statement yet, and Activity shows at most 300 actions.'],
  'RISK-068': ['signing', 'For five minutes after a passkey sign-in, a new passkey can be added without asking again, so a script running in the page then could add its own.'],
  'RISK-070': ['privacy', 'In a shared workspace every member can read a signed document\'s terms, including the reasons a model gave when it proposed them.'],
  'RISK-071': ['privacy', 'Typing a handle can confirm that an account with a wallet exists, and adding a member shows their name without asking them.'],
  'RISK-075': ['signing', 'A program holding your session could confirm a look-alike payee without showing you the warning, and proposals waiting for an adviser are stuck if that setting is turned off.'],
  'RISK-076': ['signing', 'A password can be phished, and on an account with no passkey yet it is the only key: whoever holds it could add the first passkey. Work prepared in a password session now says so where your passkey signs.'],
  'RISK-079': ['law', 'A link to a real bank that worked by using your bank login would make everything done through it count as your own instruction, mistakes included, under the banks\' terms and the law. QED holds no bank login, and none is planned.'],
  'RISK-084': ['wallet', 'Money the on-chain wallet earns through its escrow stays in the wallet: it does not reach your bank account\'s records, the split instruction never acts on it, and Home\'s figures leave it out.'],
  'RISK-086': ['build', 'On a slow phone some screens show their figures a little after their heading: Spend, Save, Grow and Protect took up to three seconds in a lab test.'],
  'RISK-087': ['protection', 'Payments that can be taken back after they settle, such as card charges and some bank returns, are not modelled yet: a reversal could take money that a reserve or an earned limit counted on.'],
  'RISK-088': ['protection', 'How far a holding could fall is measured from past prices. Real losses have reached two to three times such figures, so they are not a worst case.'],
  'RISK-089': ['running', 'If two copies of QED\'s engine were started on the same records, both could act; and a wallet request that times out is shown as not running, which invites pressing again.'],
  'RISK-091': ['build', 'Another program or another user account on the computer that runs QED, or a browser started with its port block lifted, can still reach the local test chain without a credential. Web pages in Chrome cannot; other browsers were not tried.'],
  'RISK-092': ['protection', 'Whoever funds a bounty must trust the judge they name: the bounty board has no way to give funds back, so a dishonest or absent judge means the funds are lost. Here they are valueless test tokens.'],
  'RISK-093': ['law', 'The tax collected when money is sent abroad is worked out from QED\'s reading of the Income-tax Act 2025 as amended in 2026 (2% for education or medical costs, 20% otherwise, above ₹10 lakh, from 1 April 2026), and none is worked out before that date. A misreading or a later amendment would show the wrong tax; it is a model, not tax advice.'],
  'RISK-094': ['law', 'Some rules here are not verified, or are modelled, because their source could not be read or gives no figure: the income-tax department\'s pages, the stock exchange\'s own site, freelance platforms\' escrow rules, the government-securities desk\'s hours and spread, nine of ten countries\' bank-account formats, GST on the exchange charge and the market regulator\'s fee, some countries\' weekends, and the tax on interest and on a bill\'s discount, which is not worked out. Each says so on screen.'],
  'RISK-096': ['law', 'The hosted copy runs outside India. It can serve a demonstration, but Indian rules require payment data to be stored in India, so it could not hold real payments; some market-data sources may also refuse to serve it there.'],
  'RISK-097': ['build', 'The rates for the UAE dirham and the Singapore dollar, every cross rate, and the prices on the paper exchange and the government-securities desk are synthetic and labelled so; a missed label could make them look like market data. In the worst case foreign balances count at 10% less, and those at synthetic rates count as nothing.'],
  'RISK-098': ['build', 'Money in other currencies is supported only in part: the on-chain wallet\'s limits are still counted in test rupees, a home currency other than the rupee is supported only in part, signed documents give exact amounts in any currency for instructions but not yet for payments, orders or limits, and the planners count days in Indian time.'],
  'RISK-099': ['privacy', 'Attacks through Ask have been tried against a real model only in part: the first 30 cases ran once and 23 of them again, and 31 newer cases have never run against one. In those runs QED accepted nothing it should have refused, but a model does not answer the same way twice.'],
  'RISK-100': ['checking', 'The released version was not checked in one uninterrupted run: the full browser suite last passed on a version that differs only in how new recovery codes are made and a warning on the Security screen, the journeys those touch passed again on the released version, and one check in Safari\'s engine fails.'],
  'RISK-101': ['checking', 'The newer contracts, the dispute escrow, the wallet\'s freeze and guardian changes and the bounty board, have had no independent audit: they rest on tests and reviews by agents of the same model family as their author.'],
  'RISK-102': ['wallet', 'The caps on the on-chain wallet\'s earned limits (1,000.00 test rupees in any 30 days, and 250.00 from any one payer) are set by whoever runs the service, not signed by you, so they could be raised without you; payments that can be reversed after they settle are not yet accounted for.'],
  'RISK-103': ['privacy', 'Erasing your data depends partly on whoever runs the service: sealed backup copies become unreadable within 132 days only if the expiry is run every day, which QED does not schedule; a purge needs an approver the operator names and has no screen; copies kept elsewhere are not reached; and nothing claims the data is physically erased.'],
  'RISK-104': ['protection', 'The paper escrow\'s time limits (seven days to review, three to respond, three for evidence, five to decide) and its even split when no one decides are choices made here, the mediator is simulated, and the platforms\' own escrow rules were not checked: a split is not a judgment of what is fair.'],
  'RISK-105': ['signing', 'In a business workspace, spending bands and each member\'s limit are checked by QED alone, not by the on-chain wallet: anyone who reaches the wallet service directly bypasses them, a request in test tokens has no rupee size for a limit to measure, and an approval prepared before a band changed is not checked again.'],
  'RISK-106': ['signing', 'On the on-chain wallet, withdrawing, setting money aside for a creditor, resuming after a pause and changing the guardian take effect as soon as enough passkeys sign, with no waiting time: where one passkey is enough, a stolen one can act until QED freezes it, and with exactly two passkeys a stolen one can cancel a recovery.'],
  'RISK-108': ['records', 'Some smaller faults are suspected but not shown to happen, and none is shown to move money: a computer clock set back could put a statement line in the wrong period; when a fund\'s payments could give more than one rate of return, two rates lying very close together can be missed; someone using your own address could use up its shared recovery allowance for an hour; while the engine is stopped, notices are shown but not escalated or summarised; and the calendar and the engine can count a future run a day apart.'],
  'RISK-109': ['checking', 'Comparisons with the earlier release were made by reading it, not by running it; and in a study set out in advance, none of eight strategies did better than an equal split after costs.'],
  'RISK-110': ['checking', 'Passkey journeys were tested only in Chrome-type browsers, with a simulated authenticator; Firefox and Safari\'s engine ran a smaller set without passkeys, and no real Safari, phone or screen reader was tried. On a 320-pixel screen with text at 200%, the price chart\'s break-even label runs past the edge.'],
  'RISK-111': ['build', 'Some services here are simulated and labelled so, and a reader who misses a label could take them for real: the shops an agent buys from, the two dealers in the work directory, the bank and the mediator, and messages, which this installation cannot send. The guard against a repeated purchase request counting twice has no test through the network.'],
  'RISK-112': ['signing', 'If every one of your passkeys is frozen, stopping a recovery your guardian co-signed depends on QED acting for you, and a server that had been taken over could ignore the request. The co-signer still checks every payment against your mandate on its own, and the guardian can withdraw the recovery.'],
  'RISK-113': ['build', 'If the wallet service were taken over, it could gain full control of its container until the next update, because it keeps the right to switch users; the other services, the co-signer among them, hold no such right.'],
  'RISK-114': ['build', 'Inside the service, the co-signer\'s account can reach the test chain, which asks for no credential, and the check that the services are kept apart takes one of its inputs from the wallet service it checks. The chain holds only valueless test tokens.'],
  'RISK-115': ['signing', 'Your saved recovery codes decide disputes between your passkeys: without one you cannot remove a stolen passkey, and one stolen passkey can remove your recovery contact, your password and an email address at once. The Security screen warns when two or fewer codes are left.'],
  'RISK-116': ['signing', 'Some screens can show an out-of-date time or an option that will be refused: after a recovery restarts, the wallet shows its earlier time until an attempt to finish it is refused; "Stop this recovery" is offered for recoveries your guardian did not co-sign, which the service refuses; and bounty boards and wallets set up under earlier versions keep their earlier code. The chain refuses a wrong action in each case.'],
  'RISK-117': ['build', 'In Safari\'s engine the page\'s security policy blocks some inline styles, which can change how a few details look; the check in that engine fails on these reports.'],
}
/**
 * Register entries about the team's own operations, never shown on the page: its accounts and credentials, an incident,
 * deployment and source hosting, billing, agent tooling and configuration, its documents, records and deadlines, this
 * computer's copies of the review data, and work that is not in this build (RISK-077: a research patch not applied).
 * Closed ones are listed too, in case one reopens.
 */
const OPERATIONS = new Set([
  'RISK-001', 'RISK-002', 'RISK-003', 'RISK-004', 'RISK-007', 'RISK-008', 'RISK-009', 'RISK-010', 'RISK-011', 'RISK-012', 'RISK-013',
  'RISK-016', 'RISK-017', 'RISK-027', 'RISK-033', 'RISK-039', 'RISK-045', 'RISK-047', 'RISK-061', 'RISK-062', 'RISK-077', 'RISK-078',
  // the release's bounty wording, the reading of F-059 and the Sepolia pools (the team's documents and an external testnet);
  // instrument_id's two meanings (engineering ahead of stage S3, nothing a person sees yet)
  'RISK-080', 'RISK-081', 'RISK-082', 'RISK-083',
  // the encryption work's faults before its merge (this computer's copies of the review data), and what restarting the
  // review build would change (the team's own operations)
  'RISK-085', 'RISK-090',
  // the hosting provider's configuration change and its date, the Node version on this computer, and the downtime of
  // each deployment (deployment, tools and deadlines: the team's own operations)
  'RISK-095', 'RISK-107', 'RISK-118',
  // R14: the release checks' labelled test accounts left on the hosted service (deployment) and the browser suite's
  // timing under heavy load on the team's computer (its own test tooling)
  'RISK-119', 'RISK-120',
  // account-access work that is not in this build yet (as RISK-077), and the vendored verifier's licence notice (the team's documents)
  'RISK-121', 'RISK-122',
])

/** A risk's standing in words, without the register's references. */
function standingOf(status: string): string {
  const s = status.trim().toLowerCase()
  if (/^known limitation/.test(s)) return 'A known limit of this build'
  if (/\bpartly\b|\bin part\b|\bnarrowed\b/.test(s)) return 'Partly dealt with'
  if (/^accepted/.test(s)) return 'Accepted for now'
  return 'Open'
}

interface Reason { id: string; says: string; severity: Severity; standing: string }
interface AreaView { id: Area; title: string; reasons: Reason[] }
function byArea(items: (Reason & { area: Area })[]): AreaView[] {
  return AREAS.map(([id, title]) => ({ id, title, reasons: items.filter((x) => x.area === id).sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.id.localeCompare(b.id)).map(({ area: _area, ...r }) => r) })).filter((a) => a.reasons.length)
}
/** The open risks as the page shows them: the team's own operations left out and counted, the rest in plain words by area. */
function riskView(risks: Risk[]) {
  const open = risks.filter((r) => r.open && !OPERATIONS.has(r.id))
  const described = open.filter((r) => PLAIN[r.id]).map((r) => ({ id: r.id, area: PLAIN[r.id]![0], says: PLAIN[r.id]![1], severity: r.severity, standing: standingOf(r.status) }))
  const undescribed = open.filter((r) => !PLAIN[r.id])
  const count = (sev: Severity) => open.filter((r) => r.severity === sev).length
  return {
    total: risks.length,
    open: { Critical: count('Critical'), High: count('High'), Medium: count('Medium'), Low: count('Low'), Unknown: count('Unknown') },
    blocking: open.filter((r) => blocks(r.severity)).length,
    operations: risks.filter((r) => r.open && OPERATIONS.has(r.id)).length,
    undescribed: undescribed.length,
    undescribedBlocking: undescribed.filter((r) => blocks(r.severity)),
    areas: byArea(described.filter((r) => blocks(r.severity))),
    lower: byArea(described.filter((r) => !blocks(r.severity))),
  }
}

// ------------------------------------------------------------------------------------------------ requirements

interface Entry { id: string; title: string; status: string; needs: string; level: string; section: string }
interface Requirements { entries: Entry[]; sections: { id: string; title: string }[] }
function requirements(): Requirements {
  const p = join(APP, 'register', 'r7.json')
  if (!existsSync(p)) return { entries: [], sections: [] }
  const j = JSON.parse(readFileSync(p, 'utf8')) as Partial<Requirements>
  return { entries: j.entries ?? [], sections: j.sections ?? [] }
}
/**
 * Requirements of the team's own working method (section S1: checkpoints, leaving the release and its deployment and
 * credentials untouched, tools, launch, migration, completion) and entries about its keys, research programme and
 * logistics: never shown, only counted.
 */
const OWN_SECTIONS = new Set(['S1'])
const OWN_REQUIREMENTS = new Set(['R7-063', 'R7-064', 'R7-083', 'R7-115', 'N-013', 'R13-023', 'R13-026', 'R13-028', 'R13-029', 'R13-030', 'R13-062', 'R13-077'])
/** The levels of the requirements register, as checks a person can picture. */
const LEVEL: Record<string, string> = { P: 'a journey through the app in a browser', I: 'a test through the API', C: 'a component test', E: 'an experiment', D: 'a written analysis', U: 'a claim not yet verified' }
const STATUS: Record<string, string> = { Partly: 'Met in part', 'Not met': 'Not met', Blocked: 'Blocked on something outside this work', 'Owner decision': 'Waiting for the owner’s decision' }
/** Where a requirement stands and what would make it met, in words (its level is how it is checked so far; needs, the least that counts). */
function requirementWords(e: Entry): string {
  const said = STATUS[e.status] ?? e.status
  const needs = `It counts as met only with ${LEVEL[e.needs] ?? 'a check'}.`
  if (!e.level || e.level === '-') return `${said}, and nothing checks it yet. ${needs}`
  if (e.level === e.needs) return `${said}, checked so far by ${LEVEL[e.level] ?? 'a check'}.`
  return `${said}, checked so far by ${LEVEL[e.level] ?? 'a check'}. ${needs}`
}

// ------------------------------------------------------------------------------------------------ evidence, build, release

/**
 * Evidence files on record that say how many steps passed and failed: each JSON file in evidence/, and the summary.json
 * of each folder directly inside it (a run that writes many files keeps its counts there, e.g. the judge journey).
 * Deeper folders are not read: a run moved aside (superseded-dirty/ and the like) is not evidence of this build.
 */
function evidence(): { file: string; passed: number; failed: number; producedAt: string | null }[] {
  const dir = join(APP, 'evidence')
  if (!existsSync(dir)) return []
  const out = []
  const files = [
    ...readdirSync(dir).filter((x) => x.endsWith('.json')),
    ...readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'summary.json'))).map((d) => `${d.name}/summary.json`),
  ].sort()
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { passed?: unknown; failed?: unknown; producedAt?: unknown }
      if (typeof j.passed === 'number' && typeof j.failed === 'number') out.push({ file: `evidence/${f}`, passed: j.passed, failed: j.failed, producedAt: typeof j.producedAt === 'string' ? j.producedAt : null })
    } catch { /* not a run summary */ }
  }
  return out
}

let build: { revision: string | null; dirty: boolean | null; at: number } | null = null
/**
 * Read once per process: the code that is running is the code that was there when it started. From git in a checkout;
 * in a container image, which has no git, from QED_REVISION, which the image build records (apps/qed-demo/Dockerfile);
 * whether that tree had uncommitted changes is then unknown (null).
 */
export function buildIdentity(env: NodeJS.ProcessEnv = process.env): { revision: string | null; dirty: boolean | null } {
  if (!build) {
    const git = (args: string[]): string | null => { try { return execFileSync('git', args, { cwd: APP, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
    const revision = git(['rev-parse', 'HEAD'])
    const recorded = env.QED_REVISION && /^[0-9a-f]{7,40}$/.test(env.QED_REVISION) ? env.QED_REVISION : null
    if (revision === null && recorded) build = { revision: recorded, dirty: null, at: Date.now() }
    else { const status = git(['status', '--porcelain', '--', '.']); build = { revision, dirty: status === null ? null : status.length > 0, at: Date.now() } }
  }
  return { revision: build.revision, dirty: build.dirty }
}
function release(): { id: string | null; manifestDigest: string | null; files: number | null } {
  try {
    const v = JSON.parse(readFileSync(join(APP, 'chain', 'VENDORED.json'), 'utf8')) as { release?: { id?: string; savedManifestDigest?: string; savedManifestFileCount?: number } }
    return { id: v.release?.id ?? null, manifestDigest: v.release?.savedManifestDigest ?? null, files: v.release?.savedManifestFileCount ?? null }
  } catch { return { id: null, manifestDigest: null, files: null } }
}

/** These hold whatever the records say: they are what this build is. */
const STANDING: Blocker[] = [
  { kind: 'standing', id: 'test-build', title: 'A test build: valueless tokens on a local chain, paper venues and a paper bank', detail: 'Nothing here moves money. Connecting real accounts, a public chain or a hosted service each needs the owner\'s separate decision.', severity: 'Critical' },
  { kind: 'standing', id: 'no-independent-review', title: 'No one outside this work has reviewed it', detail: 'Every review so far was by an agent of the same model family as the author. An independent security assessment and an audit of the contracts are required before any real money.', severity: 'Critical' },
]

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The view. `sources` stands in for the registers when given (tests): the risk register's text (null: no register in
 * this build) and the requirements register's entries and sections.
 */
export function readiness(sources: { risks?: string | null; requirements?: Requirements } = {}): Record<string, unknown> {
  const riskFile = join(ROOT, 'docs', 'shared', 'RISK_REGISTER.md')
  const md = sources.risks !== undefined ? sources.risks : existsSync(riskFile) ? readFileSync(riskFile, 'utf8') : null
  const risks = md === null ? null : riskView(parseRisks(md))
  const reg = sources.requirements ?? requirements()
  const reqs = reg.entries.filter((e) => !OWN_SECTIONS.has(e.section) && !OWN_REQUIREMENTS.has(e.id))
  const areaOf = (section: string): string => (reg.sections.find((s) => s.id === section)?.title ?? 'Other requirements').replace(/\s*\((?:mandate )?sections? [^)]*\)\s*$/i, '')
  const runs = evidence()
  const blockers: Blocker[] = [...STANDING]
  for (const a of risks?.areas ?? []) for (const r of a.reasons) blockers.push({ kind: 'risk', id: r.id, title: r.says, detail: r.standing, severity: r.severity, area: a.title })
  const unplaced = risks?.undescribedBlocking ?? []
  if (unplaced.length) blockers.push({ kind: 'risk', id: 'not-yet-described', title: `${plural(unplaced.length, 'open critical or high risk')} in the register ${unplaced.length === 1 ? 'is' : 'are'} not yet described on this page`, detail: `${unplaced.length === 1 ? 'It counts' : 'They count'} as a reason this build is not ready until ${unplaced.length === 1 ? 'it is' : 'they are'}.`, severity: unplaced.some((r) => r.severity === 'Critical') ? 'Critical' : 'High' })
  const failing = runs.filter((e) => e.failed > 0)
  for (const e of failing) blockers.push({ kind: 'evidence', id: e.file, title: `${plural(e.failed, 'failing step')} in ${e.file}`, detail: `${e.passed} passed, ${e.failed} failed${e.producedAt ? `, ${e.producedAt}` : ''}.`, severity: 'High' })
  const unmet = reqs.filter((e) => e.status !== 'Met' && e.status !== 'Not applicable')
  for (const e of unmet) blockers.push({ kind: 'requirement', id: e.id, title: e.title, detail: requirementWords(e), severity: e.status === 'Blocked' || e.status === 'Not met' ? 'High' : 'Medium', area: areaOf(e.section) })
  const riskCount = risks?.blocking ?? 0
  const total = STANDING.length + riskCount + failing.length + unmet.length
  return {
    ready: false,
    verdict: 'Not ready for real money',
    because: `${plural(total, 'blocker')}: ${STANDING.length} standing, ${plural(riskCount, 'open critical or high risk')}, ${plural(failing.length, 'failing evidence run')}, and ${plural(unmet.length, 'requirement')} not yet met (${unmet.filter((e) => e.status === 'Partly').length} of them in part).`,
    build: buildIdentity(),
    release: release(),
    risks: risks === null ? null : { total: risks.total, open: risks.open, blocking: risks.blocking, operations: risks.operations, undescribed: risks.undescribed, undescribedBlocking: unplaced.length, areas: risks.areas, lower: risks.lower },
    requirements: { total: reqs.length, met: reqs.filter((e) => e.status === 'Met').length, partly: reqs.filter((e) => e.status === 'Partly').length, notMet: reqs.filter((e) => e.status === 'Not met').length, blocked: reqs.filter((e) => e.status === 'Blocked').length, operations: reg.entries.length - reqs.length },
    evidence: runs,
    blockers,
  }
}
