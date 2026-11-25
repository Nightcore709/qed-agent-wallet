/**
 * The HTTP API. One small server on the loopback interface, written directly on node:http so that every byte of
 * request handling is in this file.
 *
 * Defences applied to every request before any handler runs:
 *   - Host must be one of the configured local names (stops DNS rebinding against a localhost service).
 *   - A cross-site Origin or Sec-Fetch-Site is refused.
 *   - Anything that changes state needs the session cookie (HttpOnly, SameSite=Strict) and a matching CSRF header,
 *     must be JSON, and is limited to 64 KB.
 *   - Every object is loaded with the signed-in owner's id in the query; there is no route that takes a user id.
 *   - Errors that are not the caller's fault are logged here and returned without internal detail.
 * The API never executes money movements itself. It records intent; the engine process executes.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { extname, join, normalize, sep } from 'node:path'
import { confirmPayee, openOneOff } from './ask-kinds.ts'
import { canAdminister } from './workspaces.ts'
import { ask, conversationView, detectProvider, draftProposals, listProposals, ruleSuggestions } from './ai.ts'
import { askModelsView, modelService, sessionKeyOf, startModelCatalog } from './ask-models.ts'
import { listConversations } from './conversation.ts'
import { homeMoneyExact } from '../shared/home-money.ts'
import { basisWords, HOME_OFFERED, householdHome, INR_ONLY_REASON, withHome } from './home-currency.ts'
import { CURRENCY_NAMES, isPaperCurrency } from '../shared/currency.ts'
import { cancelApproval, getApproval, openApprovals, renewable, renewApproval, signApproval, type Approval } from './approvals.ts'
import { stopPreview } from './stop-preview.ts'
import { pauseWithCode } from './stop-with-code.ts'
import { actor, changeRole, createBusiness, enforcementOf, listWorkspaces, members, membership, pendingGrants, policyOf, type PolicyPatch, removeMember, requestMember, type Role, setPolicy, switchWorkspace } from './workspaces.ts'
import { IDLE_MS, login, logout, logoutEverywhere, rateLimit, type Session, sessionFor, STEPUP_MS, stepUp } from './auth.ts'
import {
  acceptContact, approvalChallenge, authorityOf, beginAddPasskey, beginLogin, beginReauth, beginRecoveryPasskey, beginSignup, cancelRecovery, cancelScheduledChange, changePassword,
  finishAddPasskey, finishLogin, finishReauth, finishRecoveryPasskey, finishSignup, hasApprovingPasskey, hasPasskey, issueContactCode, nominateContact, regenerateRecoveryCodesWithCode,
  PROTECTION_DELAY_MS, RECOVERY_DELAY_MS, refuseCoolingOff, relyingParty, removeContact, removePassword, restrictedError, revokeSession, signOutOtherSessions, scheduleRemovePasskey, scheduleUnsuspend, securityView, signUpWithPassword, startRecovery, suspendPasskeyWithCode, removePasskeyWithCode,
} from './passkeys.ts'
import {
  addAddress, beginAuthorityRequest, beginRecoveryFromLink, cancelAuthorityRequest, confirmAddressByCode, confirmAddressByLink, contactCancel, contactCancelLoosening, contactPause, finishAuthorityRequest,
  finishRecoveryFromLink, grantAuthorityNow, recoveryLinkState, removeAddress, requestPasswordReset, requestRecoveryLink, resetLinkState, resetPassword, startRecoveryFromLink,
} from './recovery.ts'
import { configureDelivery, outboxView } from './delivery.ts'
import { APP_ROOT, AppError, audit, bad, type Config, type Db, emit, notFound, openDb, parse, systemClock } from './core.ts'
import { assertPresentationDb, syntheticBook } from './synthetic.ts'
import { engineStatus } from './engine.ts'
import { apiStorageFailure, incidentsFor, recoverStorage } from './incident-watch.ts'
import { storageErrorKind } from './incidents.ts'
import { cancelAction, confirmRepeat, dismissNotice, stepAction } from './execute.ts'
import { acknowledge, isWhoCanAct, notifyView, setPrefs } from './notify.ts'
import { defaultsFor, DEFAULT_OPENING, DEFAULT_PROFILE, getProfile, homeCurrencyOf, householdZone, openHousehold, type OpeningBalances, PROFILE_KEYS } from './household.ts'
import { listAccounts, listEntries, verifyLedger } from './ledger.ts'
import { authorityEnvelope, billLowersReserve, liquidity, runCalendar } from './liquidity.ts'

const rupees = homeMoneyExact
import { Market } from './market.ts'
import { addBill, addPayee, billPaymentUnderWay, cancelBill, checkNewPayee, clientDecision, createJob, openDispute, previewAction, recordMoneyIn, submitApprovedAction, submitMilestone } from './owner.ts'
import { acceptJobTerms, acceptTerms, addEvidence, decide, earnerStep, paperView, previewProposal, previewTerms, proposeTerms, settleByAgreement } from './escrow.ts'
import { testHoldMs } from './new-payee.ts'
import { changeProfile, pendingBillRemoval, pendingChange, requestBillRemoval } from './loosening.ts'
import { disputePack } from './dispute-pack.ts'
import { releasePause } from './dispute-pause.ts'
import { INSTITUTION_TERMS } from './institution-terms.ts'
import { institutionsView, setUpInstitution } from './institution-setup.ts'
import { CANNOT_CANCEL, DETECTION_RULE, markCancelMyself, stopSubscription, subscriptions } from './subscriptions.ts'
import { chainAnswered, chainNothingToRevoke, chainPrepared, chainSent, revocations, revokeEverywhere } from './revocation.ts'
import { activateProgram, buildDraft, contradictionsOf, currentAnalysis, discardDraft, kindCatalogue, loadProgram, pauseProgram, requestProgramApproval, resumeProgram, saveDraft } from './programs.ts'
import { preparedIn } from './prepared.ts'
import { legalView } from './legal.ts'
import { readiness } from './readiness.ts'
import { log } from './log.ts'
import { CostMeter, costBudget, RefusalMonitor } from './guard.ts'
import { publicReport, readinessReport, walletProbe } from './probes.ts'
import { announceCapsRaise, type Asker, at, proposeOnRail, rail, railApplyChange, railCancel, railExecute, railItem, railLanguage, railOverview, railPropose, railRead, railRun, railSettle, railSetup, railCurrenciesBegin, railSignBegin, railSignFinish, vaultOf } from './rail.ts'
import { getReceipt, listReceipts, verifyChain } from './receipts.ts'
import { lastRecon, reconcileUser } from './recon.ts'
import { chainBooksView, chainClosings, closeReplacedChain, closingPreview, compareChainBooks, prepareClosing } from './chain-books.ts'
import { seedRegistry } from './registry.ts'
import { cancelRun, clearStop, requestRunApproval, setStop } from './runner.ts'
import type { Ctx } from './types.ts'
import { buildVenues } from './venues.ts'
import { compare, riskEstimate } from './benchmark.ts'
import { holdings } from './valuation.ts'
import { actionView, history, homeView, listActions, listPrograms, marketView, needsYou, noticesView, passbook, programDetail, recordView, runView, sinceView, systemView } from './views.ts'
import { periodFromQuery, spanFromQuery, statement } from './statement.ts'
import { reconcileTax, taxCsv, taxJson, taxStatement } from './tax.ts'
import { cancelDeletion, dataRightsView, exportPerson, logAccess, logMemberRead, purgeApprovers, purgeCandidates, requestDeletion, runPurge } from './records.ts'
import { goalsView, goalView, prepareRelease, releaseSetAside } from './goals.ts'
import { activateMandate, commerceState, compareQuotes, prepareMandate, purchase as buyService, purchaseView, revokeMandate, settledPayment } from './commerce.ts'
import { setSimServices, type SimServices, startSimServices } from './commerce-sim.ts'
import { convertApproved, moneyView, prepareConversion } from './fx.ts'
import { addFxGoal, fxGoalsView, removeFxGoal } from './fx-goals.ts'
import { abroadView, addAbroadPayee, payAbroad, paymentView, prepareAbroad } from './abroad.ts'
import { decideReview, requireReviewer, reviewQueue } from './adviser.ts'
import { agreeCycle, answerClaim, cancelCycle, nettingView, preparePayment, proposeClaim, proposeCycle, settleIfReady, withdrawClaim } from './netting.ts'
import { listQuotes, requestQuotes } from './rfq.ts'
import { answerOffer, clientReport, createModel, modelsView, offerModel, reportsAcross, SCOPE_NOTE } from './institutional.ts'
import { ALLOC_POLICIES, type AllocPolicy, checkCertificate, hedgeWhatIf, labCertificates, labResearch, labView, proposeRebalance } from './lab.ts'
import { addWatch, removeWatch, watchlistView } from './watchlist.ts'
import { createIdea, decide as decideIdea, ideaRecord, listIdeas, readWithAnswers } from './ideas.ts'

const MAX_BODY = 64 * 1024
type Json = Record<string, unknown>
/**
 * userId is the WORKSPACE the request acts in (every financial table's user_id); personId is the person signed in;
 * role is the person's role in that workspace. A personal workspace is the person's own row, with role owner.
 */
interface Req { ctx: Ctx; cfg: Config; db: Db; now: number; userId: string; personId: string; role: Role; session: Session; body: Json; query: URLSearchParams; params: string[]; ip: string; req: IncomingMessage; res: ServerResponse }
type Handler = (r: Req) => unknown | Promise<unknown>
/** 'person': about the signed-in person, not a workspace (sign-in, security, which workspace). Otherwise the least role. */
type Need = Role | 'person'
interface Route { method: string; path: string; re: RegExp; auth: boolean; fn: Handler; need: Need; async: boolean }

/** The parts of QED that price or settle in rupees (rupee instruments, the rupee desk, payments abroad, the chain's test rupees, paper escrow, agent purchases). */
const RUPEE_ONLY = /^\/api\/(fx|abroad|desk|vault|earn|bounties|chain-books|commerce|ideas|lab|wallet-proposals|revocations)(\/|$)/
/** Screens that show only those parts: read-closed too, with the same reason (the wallet and earning panels, shown on other pages, stay readable and show nothing set up). */
const RUPEE_ONLY_READS = /^\/api\/(fx|money|abroad|desk|bounties|chain-books|commerce|ideas|lab)(\/|$)/
const routes: Route[] = []
/**
 * Whether a handler is an async function. A synchronous handler that changes something runs in one transaction (brief item
 * 2, below in startApi); an async one awaits outside work (a passkey's verification, a password hash, the wallet service, a
 * model) and keeps its writes in transactions of its own, because one SQLite connection cannot hold a transaction open
 * across an await without other requests' statements joining it.
 */
const isAsync = (fn: Handler): boolean => fn.constructor.name === 'AsyncFunction'
const PERSON_ROUTES = /^\/api\/(auth|security|workspaces|session)(\/|$)|^\/api\/approvals\/[^/]+\/(passkey|confirm)$/
/** The least role for a route that changes something in a workspace (looking needs only membership). */
const ADMIN_ROUTES = /^\/api\/(household|profile|payees|bills|stop\/clear)(\/|$)/
const route = (method: string, path: string, fn: Handler, auth = true, need?: Need): void => {
  const n: Need = need ?? (PERSON_ROUTES.test(path) ? 'person' : method === 'GET' ? 'viewer' : ADMIN_ROUTES.test(path) ? 'admin' : path === '/api/stop' ? 'approver' : 'operator')
  routes.push({ method, path, re: new RegExp(`^${path.replace(/:[a-z]+/gi, '([A-Za-z0-9_.:@#-]+)')}$`), auth, fn, need: n, async: isAsync(fn) })
}
/**
 * The API's permission table, read from the routes themselves (ASVS 5.0 V8.1.1, V8.2.1): each route's method and path,
 * whether it needs a session, the least role it needs (or 'person': about the signed-in person, in any workspace), and the
 * further checks its handler makes before it acts. docs/PERMISSIONS.md is generated from it (scripts/permissions.ts) and
 * server/permissions.test.ts holds the two equal, so the document cannot drift from what is enforced.
 */
export function routeTable(): { method: string; path: string; session: boolean; least: Need; checks: string[]; transaction: 'one' | 'own' | 'reads' }[] {
  // A call, as written or as a test runner rewrites an imported one: `name(` or `(0, module.name)(`.
  const calls = (name: string): RegExp => new RegExp(`\\b${name}\\)?\\(`)
  const CHECKS: [RegExp, string][] = [
    [calls('requireSettled'), 'fresh passkey, past its cool-off'], [calls('requireStepUp'), 'fresh passkey'], [calls('guardProtective'), 'protective: approver and a passkey'],
    [calls('mayClearWhoCanAct'), 'who-can-act notice: owner or admin, a passkey'], [calls('purgeApprover'), 'named purge approver'], [calls('reviewer'), 'adviser credential'],
    [calls('ownProposal'), 'own proposal, or owner or admin'], [calls('requireSetup'), 'household set up'], [calls('rateLimit'), 'rate limit'], [calls('uniform'), 'uniform answer and time'],
  ]
  // A synchronous handler that returns what an async function returns waits too: its work after that function's first wait
  // is outside the request's transaction. The names of the server's async functions, read from its modules, tell them apart.
  const asyncNames = new Set<string>(['uniform'])
  for (const f of readdirSync(HERE_SERVER).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    for (const m of readFileSync(join(HERE_SERVER, f), 'utf8').matchAll(/export async function (\w+)|(?:const|let) (\w+) = async\b/g)) asyncNames.add((m[1] ?? m[2])!)
  }
  const waits = (src: string): boolean => [...asyncNames].some((n) => calls(n).test(src))
  return routes.map((x) => {
    const src = x.fn.toString()
    const checks = CHECKS.filter(([re]) => re.test(src)).map(([, w]) => w).filter((w, _i, all) => !(w === 'fresh passkey' && all.includes('fresh passkey, past its cool-off')))
    return { method: x.method, path: x.path, session: x.auth, least: x.need, checks, transaction: x.method === 'GET' ? 'reads' : x.async || waits(src) ? 'own' : 'one' }
  })
}
const HERE_SERVER = join(APP_ROOT, 'server')
const RANK: Record<Role, number> = { owner: 4, admin: 3, approver: 2, operator: 1, viewer: 0 }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const requireStepUp = (r: Req): void => {
  if (r.session.stepUpFresh) return
  // A passkey that signs in only (registered by a recovery, or added after a password reset) never confirms: a session
  // opened with one, or an account with no other, is told why and what to do (R12; review H2).
  if (r.session.signinOnly || (!hasApprovingPasskey(r.db, r.session.userId) && hasPasskey(r.db, r.session.userId))) throw restrictedError()
  throw new AppError(401, 'stepup_required', hasPasskey(r.db, r.session.userId) ? 'Confirm with your passkey to continue.' : 'This needs a passkey, and this account has none yet. Add one under Security and recovery.')
}
/**
 * A fresh passkey confirmation, by a passkey past its first 24 hours (R13 hardening; RISK-068, Q-062): what loosening a
 * protection, adding a signer or resuming something paused needs. `what` finishes the sentence "it cannot ...".
 */
const requireSettled = (r: Req, what: string): void => { requireStepUp(r); refuseCoolingOff(r.db, r.session, what, r.now) }
/**
 * A session that cannot confirm anything by itself: opened with a password (D-094: a password can be phished), or with a
 * passkey that signs in only (R12: one a recovery registered, or one added after a password reset). Every rule written
 * for a password session holds for both (review H2).
 */
const weakSession = (s: Session): boolean => s.authMethod === 'password' || s.signinOnly === true
/** How the acting session was opened, as work it prepares records it (prepared.ts): a sign-in-only passkey is said apart. */
const preparedMethod = (s: Session): string => (s.signinOnly ? 'signin-passkey' : s.authMethod)
/**
 * Whether this session may clear a notice of a change to who can act (notify.ts isWhoCanAct), by acknowledging or by
 * dismissing it: a session opened with a passkey that can approve, or a fresh confirmation by one; or, in the person's own
 * workspace, any session of a person who has no passkey at all (the password is then their only credential). Never a
 * password or sign-in-only session of a person who has a passkey, and never one in a business workspace, whose other
 * members rely on the notice (review M3: the rule read the workspace's id, which in a business has no passkey).
 */
function maySettleSecurity(r: Req): boolean {
  if (r.session.stepUpFresh || !weakSession(r.session)) return true
  return r.userId === r.personId && !hasPasskey(r.db, r.personId)
}
/**
 * The answers that must not say whether an account exists take at least this long, so that their time says nothing
 * either (OWASP Forgot Password Cheat Sheet, "Forgot password request": consistent response times).
 */
const UNIFORM_MS = 450
async function uniform<T>(fn: () => T | Promise<T>): Promise<T> {
  const t0 = Date.now()
  // awaited inside, so that an answer that takes a password hash is timed to its end (review L4)
  try { return await fn() } finally { const left = UNIFORM_MS - (Date.now() - t0); if (left > 0) await new Promise((r) => setTimeout(r, left)) }
}
/**
 * A session opened with a password, or with a passkey that signs in only, cannot switch protection off (the D-094 review,
 * M3; R12 review H2): pausing or revoking an instruction that sells to protect (an exit or a floor), or cancelling one of
 * its runs, needs a confirmation by a passkey that can approve. A session opened with one does these as before.
 */
const PROTECTIVE_KINDS = new Set(['exit', 'floor'])
const guardProtective = (r: Req, programId: string | undefined): void => {
  if (!programId) return
  const p = r.db.get<{ kind: string }>('SELECT kind FROM programs WHERE id = ? AND user_id = ?', programId, r.userId)
  if (!p || !PROTECTIVE_KINDS.has(p.kind)) return
  // Switching protection off is a signer's decision: an operator prepares and cannot sign, as the workspace-wide stop
  // needs an approver and clearing it an admin (R13 review, R11: an operator revoked a business's floor instruction).
  if (RANK[r.role] < RANK.approver) throw new AppError(403, 'not_permitted', `Your role in this workspace (${r.role}) cannot switch protection off. An approver, an admin or the owner can.`)
  if (weakSession(r.session)) requireStepUp(r)
}
/** The instruction a run belongs to, in this workspace. */
const runProgram = (r: Req, runId: string): string | undefined => r.db.get<{ program_id: string }>('SELECT program_id FROM runs WHERE id = ? AND user_id = ?', runId, r.userId)?.program_id
/** Whether a request to approve `subject` waits now (asking again would withdraw it: approvals.ts createApproval). */
const waiting = (r: Req, subject: string): boolean => !!r.db.get('SELECT 1 FROM approvals WHERE user_id = ? AND subject = ? AND confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?', r.userId, subject, r.now)

/**
 * A model's proposal is its asker's (RISK-070; the proposals list shows a member only their own): only the member who
 * asked, an owner or an admin dismisses it, drafts from it or starts an instruction from it (R13 review, lead L-06). A
 * proposal no person asked for (a rule's suggestion) is the workspace's. Returns the id; an id that is not one, not this
 * workspace's or not the reader's is "not found" (lead L-09: an id of any length was stored as the instruction's origin).
 */
function ownProposal(r: Req, raw: unknown): string {
  const id = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(raw) ? raw : null
  const p = id ? r.db.get<{ asker: string | null }>(`SELECT c.person_id asker FROM proposals p LEFT JOIN ai_calls a ON a.id = p.ai_call_id AND a.user_id = p.user_id
      LEFT JOIN conversations c ON c.id = COALESCE(p.conversation_id, a.conversation_id) AND c.user_id = p.user_id WHERE p.id = ? AND p.user_id = ?`, id, r.userId) : undefined
  if (!id || !p || (p.asker !== null && p.asker !== r.personId && RANK[r.role] < RANK.admin)) throw notFound('That proposal')
  return id
}

/**
 * Clearing a notice of a change to who can act (acknowledging or dismissing it clears it for every member): a session
 * that may settle security (maySettleSecurity, review M3) and, in a shared workspace, an owner or an admin who is not the
 * member whose action it reports (R13 review, lead L-10: an operator, or the approver who started a vault recovery,
 * could clear the warning meant for the others).
 */
function mayClearWhoCanAct(r: Req, noticeId: string): void {
  if (!maySettleSecurity(r)) throw whoCanActRefused()
  if (r.db.get<{ kind: string }>('SELECT kind FROM users WHERE id = ?', r.userId)?.kind !== 'business') return
  const n = r.db.get<{ kind: string; subject: string | null; dedupe: string }>('SELECT kind, subject, dedupe FROM notices WHERE id = ? AND user_id = ?', noticeId, r.userId)
  const about = n?.kind === 'escalation' ? r.db.get<{ dedupe: string }>('SELECT dedupe FROM notices WHERE id = ? AND user_id = ?', n.subject ?? '', r.userId) : n
  if (RANK[r.role] < RANK.admin || (about?.dedupe ?? '').endsWith(`:by:${r.personId}`)) throw new AppError(403, 'not_permitted', 'In a shared workspace, an owner or an admin other than the member who made the change clears a notice of a change to who can act.')
}
const whoCanActRefused = (): AppError => new AppError(401, 'stepup_required', 'Confirm with one of your passkeys to clear a notice of a change to who can act. A session opened with a password, or with a passkey that signs in only, cannot clear it.')
const rp = (r: Req) => relyingParty(r.cfg)
const ua = (r: Req): string => str(r.req.headers['user-agent'])
const requireSetup = (r: Req): void => { if (!getProfile(r.db, r.userId).setup) throw new AppError(409, 'not_set_up', 'Set up your paper household first.') }

// ------------------------------------------------------------------------------------------------ account
// A new account is created with a passkey, or with a handle and a password (D-094). A password session can read
// everything, set up the household and add its first passkey; it approves nothing, because every approval below is a
// passkey signature over the exact terms.
route('POST', '/api/auth/signup', async (r) => {
  const out = await signUpWithPassword(r.db, { handle: r.body.handle, password: r.body.password, displayName: r.body.displayName }, { ip: r.ip, ua: ua(r) }, r.now)
  signedIn(r, out.session.token, out.session.expiresAt)
  return { userId: out.personId, csrf: out.session.csrf, recoveryCodes: out.recoveryCodes }
}, false)
route('POST', '/api/auth/passkey/signup/begin', (r) => beginSignup(r.db, rp(r), { handle: r.body.handle, displayName: r.body.displayName }, r.ip, r.now), false)
route('POST', '/api/auth/passkey/signup/finish', async (r) => {
  const out = await finishSignup(r.db, rp(r), { challengeId: r.body.challengeId, response: r.body.response, passkeyName: r.body.passkeyName }, { ip: r.ip, ua: ua(r) }, r.now)
  signedIn(r, out.session.token, out.session.expiresAt)
  return { userId: out.personId, csrf: out.session.csrf, recoveryCodes: out.recoveryCodes }
}, false)
route('POST', '/api/auth/passkey/login/begin', (r) => beginLogin(r.db, rp(r), r.now), false)
route('POST', '/api/auth/passkey/login/finish', async (r) => {
  const s = await finishLogin(r.db, rp(r), { challengeId: r.body.challengeId, response: r.body.response }, { ip: r.ip, ua: ua(r) }, r.now)
  signedIn(r, s.token, s.expiresAt)
  return { userId: s.userId, csrf: s.csrf }
}, false)
route('POST', '/api/auth/passkey/stepup/begin', (r) => beginReauth(r.db, rp(r), r.session.userId, 'stepup', null, {}, r.now))
route('POST', '/api/auth/passkey/stepup/finish', async (r) => { await finishReauth(r.db, rp(r), r.session, 'stepup', { challengeId: r.body.challengeId, response: r.body.response }, r.now, r.ip); return { ok: true, freshForMs: STEPUP_MS } })
// The backup path's start answers every handle alike, and no sooner than the same floor as the email requests (review L4).
route('POST', '/api/auth/recovery/start', (r) => uniform(() => startRecovery(r.db, { handle: r.body.handle, code: r.body.code, contactCode: r.body.contactCode, password: r.body.password }, r.ip, r.now)), false)
// A lost or stolen device: a saved recovery code pauses QED (all but protective selling) from the signed-out page; it
// opens no session, resumes nothing and moves no money; the same answer whether or not it matched (server/stop-with-code.ts).
route('POST', '/api/auth/pause-with-code', (r) => uniform(() => pauseWithCode(r.ctx, { handle: r.body.handle, code: r.body.code }, r.ip)), false)
route('POST', '/api/auth/recovery/passkey/begin', (r) => beginRecoveryPasskey(r.db, rp(r), r.body.reference, r.now), false)
route('POST', '/api/auth/recovery/passkey/finish', async (r) => {
  const { session: s, recoveryCodes, authority } = await finishRecoveryPasskey(r.db, rp(r), { challengeId: r.body.challengeId, response: r.body.response, passkeyName: r.body.passkeyName }, { ip: r.ip, ua: ua(r) }, r.now)
  signedIn(r, s.token, s.expiresAt)
  // The used saved code is gone and the others are replaced: the new set is shown once, now. The new passkey signs in only.
  return { userId: s.userId, csrf: s.csrf, recoveryCodes, authority }
}, false)

// --- R12: password reset, account recovery by email, and the approval authority a recovered passkey asks for ---
// Password reset (an account with a password and no passkey): the request's answer is the same for every identifier
// and takes the same time; the link (by email only) sets a new password and signs every session out.
route('POST', '/api/auth/password/forgot', (r) => uniform(() => requestPasswordReset(r.db, r.body.identifier, r.ip, r.now)), false)
route('POST', '/api/auth/password/reset/state', (r) => resetLinkState(r.db, r.body.token, r.now), false)
route('POST', '/api/auth/password/reset', (r) => resetPassword(r.db, { token: r.body.token, password: r.body.password, confirm: r.body.confirm }, r.ip, r.now), false)
// Account recovery (every passkey lost): a link by email, then a second proof, then a wait, then a new passkey that signs
// in only. The saved codes and a contact's code without email stay as the backup path above.
route('POST', '/api/auth/recovery/link', (r) => uniform(() => requestRecoveryLink(r.db, r.body.identifier, r.ip, r.now)), false)
route('POST', '/api/auth/recovery/link/state', (r) => recoveryLinkState(r.db, r.body.token, r.now), false)
route('POST', '/api/auth/recovery/link/start', (r) => startRecoveryFromLink(r.db, { token: r.body.token, code: r.body.code, contactCode: r.body.contactCode, password: r.body.password }, r.ip, r.now), false)
// The link and the finishing key the starting browser kept (review H1): neither alone finishes a recovery.
route('POST', '/api/auth/recovery/link/passkey/begin', (r) => beginRecoveryFromLink(r.db, rp(r), { token: r.body.token, finishKey: r.body.finishKey }, r.now), false)
route('POST', '/api/auth/recovery/link/passkey/finish', async (r) => {
  const { session: s, recoveryCodes, authority } = await finishRecoveryFromLink(r.db, rp(r), { challengeId: r.body.challengeId, response: r.body.response, passkeyName: r.body.passkeyName }, { ip: r.ip, ua: ua(r) }, r.now)
  signedIn(r, s.token, s.expiresAt)
  return { userId: s.userId, csrf: s.csrf, recoveryCodes, authority }
}, false)
// Confirming an email address with the link sent to it: the link proves the mailbox, so no session is needed.
route('POST', '/api/auth/email/confirm', (r) => confirmAddressByLink(r.db, r.body.token, r.ip, r.now), false)
// The local test outbox's developer page (server/delivery.ts): only while the outbox is the delivery, which a public
// origin refuses. Every message in it is simulated; the answer says so first.
route('GET', '/api/dev/outbox', (r) => { if (r.cfg.delivery !== 'outbox') throw notFound('The developer outbox'); return outboxView(r.db, Number(r.query.get('limit')) || 60) }, false)

// ------------------------------------------------------------------------------------------------ security
// `wallet`: whether the workspace this session acts in has an on-chain wallet, read from the record GET /api/vault/signers
// needs (and GET /api/vault already reports to any member), so that Security asks for signers only when there are some
// (EV-071: it asked anyway, and each 409 was logged in the browser as an error).
route('GET', '/api/security', (r) => ({ ...(securityView(r.db, r.session, r.now) as Json), wallet: { setUp: vaultOf(r.db, r.userId) !== null } }))
route('POST', '/api/security/passkeys/begin', (r) => beginAddPasskey(r.db, rp(r), r.session, r.now))
route('POST', '/api/security/passkeys/finish', async (r) => { const c = await finishAddPasskey(r.db, rp(r), r.session, { challengeId: r.body.challengeId, response: r.body.response, passkeyName: r.body.passkeyName }, ua(r), r.now); return { passkey: { id: c.id, name: c.name } } })
route('POST', '/api/security/passkeys/:id/remove', (r) => removePasskeyWithCode(r.db, r.session, r.params[0]!, (r.body as { code?: unknown } | undefined)?.code, r.now))
// R13: suspending a passkey also freezes it at once on every on-chain wallet it signs for (server/rail-signers.ts
// containPerson; retried on the engine's vault round when the vault service cannot be reached).
route('POST', '/api/security/passkeys/:id/suspend', async (r) => { await suspendPasskeyWithCode(r.db, r.session, r.params[0]!, (r.body as { code?: unknown } | undefined)?.code, r.now); const wallet = await (await import('./rail-signers.ts')).containPerson(r.cfg, r.db, r.session.userId, r.now).catch(() => null); return { ok: true, ...(wallet ? { wallet } : {}) } })
route('POST', '/api/security/passkeys/:id/unsuspend', (r) => scheduleUnsuspend(r.db, r.session, r.params[0]!, r.now))
route('POST', '/api/security/contacts', (r) => nominateContact(r.db, r.session, r.body.handle, r.now))
route('POST', '/api/security/contacts/:id/accept', (r) => { acceptContact(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/security/contacts/:id/remove', (r) => { removeContact(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/security/contacts/:id/code', (r) => issueContactCode(r.db, r.session, r.params[0]!, r.now))
route('POST', '/api/security/changes/:id/cancel', (r) => { cancelScheduledChange(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/security/recovery-codes', async (r) => ({ codes: await regenerateRecoveryCodesWithCode(r.db, r.session, (r.body as { code?: unknown } | undefined)?.code, r.now) }))
// The cancelled recovery spent a saved code: the answer carries the new set, shown once.
route('POST', '/api/security/recoveries/:id/cancel', (r) => cancelRecovery(r.db, r.session, r.params[0]!, r.now))
route('POST', '/api/security/sessions/end-others', (r) => ({ ended: signOutOtherSessions(r.db, r.session, r.now) }))
route('POST', '/api/security/sessions/:id/revoke', (r) => { revokeSession(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
// Addresses outside QED (R12): email (notices now; a reset or a recovery after the protection delay) and a phone number
// (short security notices only). Adding or removing one takes the account's strongest confirmation.
route('POST', '/api/security/addresses', (r) => addAddress(r.db, r.session, r.body.kind === 'phone' ? 'phone' : 'email', r.body.address, r.now, r.body.replaces ?? undefined))
route('POST', '/api/security/addresses/:id/confirm', (r) => confirmAddressByCode(r.db, r.session, r.params[0]!, r.body.code, r.now))
route('POST', '/api/security/addresses/:id/remove', (r) => { removeAddress(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
// Approval authority for a passkey that signs in only: asked with that passkey, given after the protection delay unless
// stopped; stopped by that passkey's own session or any passkey with authority; granted at once only by such a passkey.
route('POST', '/api/security/authority/begin', (r) => beginAuthorityRequest(r.db, rp(r), r.session, r.now))
route('POST', '/api/security/authority/finish', (r) => finishAuthorityRequest(r.db, rp(r), r.session, { challengeId: r.body.challengeId, response: r.body.response }, r.now))
route('POST', '/api/security/authority/:id/cancel', (r) => { cancelAuthorityRequest(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/security/authority/:id/grant', (r) => { grantAuthorityNow(r.db, r.session, r.params[0]!, r.now); return { ok: true } })
// A recovery contact stops a recovery, or a request for approval authority, of the person who trusts them.
route('POST', '/api/security/contacts/:id/cancel-recovery', (r) => contactCancel(r.db, r.session, r.params[0]!, r.now))
route('POST', '/api/security/contacts/:id/cancel-loosening', (r) => contactCancelLoosening(r.db, r.session, r.params[0]!, r.now))
// a recovery contact pauses QED for the person who trusts them (all but protective selling); only that person resumes it
route('POST', '/api/security/contacts/:id/pause', (r) => contactPause(r.ctx, r.session, r.params[0]!))
// The password (RISK-076): changing it takes the account's strongest confirmation (a passkey when it has one, otherwise
// the current password in the same request); removing it takes a passkey and leaves a way back in. Either ends every
// other session, and the answer says how many.
route('POST', '/api/security/password', async (r) => ({ ok: true, ...(await changePassword(r.db, r.session, { current: r.body.current, password: r.body.password }, r.ip, r.now)) }))
route('POST', '/api/security/password/remove', (r) => ({ ok: true, ...removePassword(r.db, r.session, r.ip, r.now) }))
route('POST', '/api/auth/login', async (r) => {
  const s = await login(r.db, { handle: r.body.handle, password: r.body.password }, { ip: r.ip, ua: str(r.req.headers['user-agent']) }, r.now)
  signedIn(r, s.token, s.expiresAt)
  return { userId: s.userId, csrf: s.csrf }
}, false)
// Signing out is recorded (ASVS 5.0 V16.3.1), and the browser is asked to drop what it cached for this site (V14.3.1;
// Clear-Site-Data "cache": not "storage", which holds a signed-out recovery's finishing key and the person's display choices).
route('POST', '/api/auth/logout', (r) => { const who = logout(r.db, cookieOf(r.req, r.cfg.cookieName), r.now); if (who) audit(r.db, r.now, who, 'owner', 'logout', who, {}, r.ip); clearCookie(r); r.res.setHeader('Clear-Site-Data', '"cache"'); return { ok: true } })
// Sessions belong to the person, not to the workspace the session acts in: with r.userId (the workspace) a session acting
// in a business ended nobody and still answered 200 (R13 review, R01).
route('POST', '/api/auth/logout-everywhere', (r) => { requireStepUp(r); const n = logoutEverywhere(r.db, r.personId, r.now); clearCookie(r); r.res.setHeader('Clear-Site-Data', '"cache"'); audit(r.db, r.now, r.personId, 'owner', 'sessions.revoke-all', null, { n }, r.ip); return { ended: n } })
route('POST', '/api/auth/stepup', async (r) => { await stepUp(r.db, r.session, r.body.password, r.ip, r.now); return { ok: true, freshForMs: 5 * 60_000 } })
route('GET', '/api/session', (r) => {
  const s = sessionFor(r.db, cookieOf(r.req, r.cfg.cookieName), r.now)
  // delivery: 'outbox' when messages go to the local test outbox (nothing is sent; the interface says so and links to it).
  // delays: how long a recovery and a protection-lowering change wait on this installation (said on the recovery pages).
  // newPayeeHoldTestMs: a test stack's shortened wait on payments to new payees (new-payee.ts), which the interface says
  const delays = { recoveryMs: RECOVERY_DELAY_MS, protectionMs: PROTECTION_DELAY_MS, newPayeeHoldTestMs: testHoldMs() }
  // Signed out, the reply names no backend component (ASVS 5.0 V13.4.6): which model provider is configured is told only
  // to a signed-in person.
  if (!s) return { authenticated: false, presentation: r.cfg.presentation, delivery: r.cfg.delivery, delays, defaults: { opening: DEFAULT_OPENING, profile: DEFAULT_PROFILE } }
  const u = r.db.get<{ id: string; handle: string; display_name: string; created_at: number }>('SELECT id, handle, display_name, created_at FROM users WHERE id = ?', s.userId)!
  const m = membership(r.db, s.workspaceId, s.userId)
  const wsId = m ? s.workspaceId : s.userId
  const w = r.db.get<{ id: string; display_name: string; kind: string; stop_at: number | null; stop_reason: string | null; stop_protective: number }>('SELECT id, display_name, kind, stop_at, stop_reason, stop_protective FROM users WHERE id = ?', wsId)!
  const profile = getProfile(r.db, wsId)
  return {
    authenticated: true, presentation: r.cfg.presentation, delivery: r.cfg.delivery, delays, csrf: s.csrf, stepUpFresh: s.stepUpFresh, sessionExpiresAt: s.expiresAt, authMethod: s.authMethod, hasPasskey: hasPasskey(r.db, s.userId),
    // R12: 'restricted' while every passkey signs in only (after a recovery); the request for authority, if one waits.
    authority: authorityOf(r.db, s.userId),
    // The authority of the passkey this session was opened with: 'signin' when it was registered by a recovery (or after a
    // password reset), even while the account's other passkeys can still approve (the device that lost them may be away).
    passkeyAuthority: s.credentialId ? r.db.get<{ authority: string }>('SELECT authority FROM webauthn_credentials WHERE id = ?', s.credentialId)?.authority ?? null : null,
    // a change that loosens a protection, waiting out its delay (loosening.ts): Safeguards shows it, with its cancel
    profileChange: pendingChange(r.db, wsId),
    authorityRequest: r.db.get<{ id: string; effective_at: number }>(`SELECT id, effective_at FROM scheduled_changes WHERE person_id = ? AND kind = 'restore-authority' AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at DESC LIMIT 1`, s.userId) ?? null,
    openRecoveries: r.db.get<{ n: number }>('SELECT COUNT(*) n FROM recovery_requests WHERE person_id = ? AND cancelled_at IS NULL AND completed_at IS NULL', s.userId)?.n ?? 0,
    user: { id: u.id, handle: u.handle, displayName: u.display_name, createdAt: u.created_at }, setup: profile.setup, profile, homeCurrency: homeCurrencyOf(profile),
    workspace: { id: w.id, name: w.display_name, kind: w.kind, role: m?.role ?? 'owner', policy: policyOf(r.db, w.id) },
    workspaces: listWorkspaces(r.db, s.userId),
    stop: w.stop_at ? { at: w.stop_at, reason: w.stop_reason, protectiveContinues: w.stop_protective === 1 } : null, ai: detectProvider(r.cfg), engine: engineStatus(r.db, r.now), defaults: { opening: DEFAULT_OPENING, profile: DEFAULT_PROFILE }, homeCurrencies: HOME_OFFERED.map((c) => ({ code: c, name: CURRENCY_NAMES[c] })),
    sessions: r.db.all('SELECT created_at, last_seen_at, ua, (id_hash = ?) current FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC', s.sessionHash, s.userId, r.now),
  }
}, false)

// The example household in a currency, with the rate and source it was converted at (home-currency.ts); read before set-up.
route('GET', '/api/household/defaults', (r) => {
  const c = r.query.get('currency') ?? 'INR'
  if (!isPaperCurrency(c) || !HOME_OFFERED.includes(c)) throw bad('Choose a home currency from the list.', { homeCurrency: `Choose one of ${HOME_OFFERED.join(', ')}.` })
  const d = defaultsFor(c)
  return { currency: c, opening: d.opening, profile: d.profile, basis: d.basis, basisWords: d.basis ? basisWords(d.basis) : null }
})
route('POST', '/api/household', (r) => {
  const o = (r.body.opening ?? {}) as Json
  const opening: OpeningBalances = { bank: Number(o.bank ?? DEFAULT_OPENING.bank), fd: Number(o.fd ?? 0), card: Number(o.card ?? DEFAULT_OPENING.card), personalLoan: Number(o.personalLoan ?? DEFAULT_OPENING.personalLoan), homeLoan: Number(o.homeLoan ?? DEFAULT_OPENING.homeLoan) }
  const profile = openHousehold(r.db, r.userId, opening, (r.body.profile ?? {}) as Json, r.now)
  audit(r.db, r.now, r.userId, 'owner', 'household.open', null, { opening, homeCurrency: homeCurrencyOf(profile) }, r.ip)
  return { profile }
})
route('PATCH', '/api/profile', (r) => {
  requireSetup(r)
  const before = getProfile(r.db, r.userId)
  const patch = r.body as Partial<typeof before>
  // The home currency is chosen at set-up. Its books are kept in it, so changing it means converting every balance; that is not built,
  // and a request is refused with the reason rather than ignored (it would be a loosening, with the protection delay's wait, if it were).
  if ((patch as Json).homeCurrency !== undefined && (patch as Json).homeCurrency !== homeCurrencyOf(before)) throw new AppError(409, 'home_currency_fixed', `Your home currency is ${CURRENCY_NAMES[homeCurrencyOf(before)]} (${homeCurrencyOf(before)}) and your paper bank is kept in it. Changing it would mean converting every balance and every record, which QED does not do yet, so it is not offered.`)
  // Lowering the floor, or asking the bank reserve to withstand less, weakens protection, so it needs a fresh passkey confirmation;
  // strengthening either, or changing other figures, does not.
  const weaker = (k: 'line' | 'lateDays' | 'lostSalaries'): boolean => typeof patch[k] === 'number' && patch[k]! < before[k]
  if (weaker('line') || weaker('lateDays') || weaker('lostSalaries')) requireStepUp(r)
  // The wait on payments to new payees (new-payee.ts) is changed only with a passkey's fresh confirmation, never by a
  // session opened with a password, whichever way it moves: a person talked into paying is the one the wait protects, and
  // a phished password must not be able to switch it off or move it.
  const holdChange = (['newPayeeHoldAbove', 'newPayeeHoldHours'] as const).some((k) => patch[k] !== undefined && patch[k] !== before[k])
  if (holdChange) requireStepUp(r)
  const asked: Partial<typeof before> = {}
  for (const k of PROFILE_KEYS) if (patch[k] !== undefined) (asked as Json)[k] = patch[k]
  // What tightens takes effect at once; what loosens (a lower floor, a smaller reserve, figures that lower what must stay,
  // less of a wait on new payees) only after the protection delay, cancellable meanwhile from any passkey, with the person
  // and their recovery contacts told (loosening.ts, which checks the passkey again under the write lock). Any other change
  // that lowers what must stay in the bank frees money for instructions just as those do, so it needs the passkey too.
  const out = changeProfile(r.db, { personId: r.personId, workspaceId: r.userId, fresh: r.session.stepUpFresh, beforeLoosening: () => refuseCoolingOff(r.db, r.session, 'loosen a protection', r.now) }, asked, r.now)
  audit(r.db, r.now, r.userId, 'owner', 'profile.update', null, { changed: Object.keys(asked), applied: out.applied,
    ...(out.deferred || out.replaced ? { waiting: out.waiting ? { changeId: out.waiting.id, effectiveAt: out.waiting.effectiveAt, after: out.waiting.after, before: out.waiting.before } : null, deferred: out.deferred, replaced: out.replaced, contactsTold: out.contactsTold } : {}),
    ...(holdChange ? { newPayeeHold: { before: { above: before.newPayeeHoldAbove, hours: before.newPayeeHoldHours }, asked: { above: asked.newPayeeHoldAbove ?? before.newPayeeHoldAbove, hours: asked.newPayeeHoldHours ?? before.newPayeeHoldHours }, now: { above: out.profile.newPayeeHoldAbove, hours: out.profile.newPayeeHoldHours } } } : {}) }, r.ip)
  emit(r.db, r.now, r.userId, 'profile', {})
  return { profile: out.profile, waiting: out.waiting, deferred: out.deferred }
})

// ------------------------------------------------------------------------------------------------ reading
route('GET', '/api/home', (r) => { requireSetup(r); return homeView(r.db, r.ctx.market, r.userId, r.now) })
route('GET', '/api/liquidity', (r) => { requireSetup(r); return { liquidity: liquidity(r.db, r.userId, r.now), envelope: authorityEnvelope(r.db, r.userId, r.now) } })
// ?period= (week, month, last-month, all; dates with ?first= and ?last=) reads the statement for that period (server/statement.ts)
route('GET', '/api/passbook', (r) => { requireSetup(r); const limit = Number(r.query.get('limit')) || 80; return r.query.has('period') ? statement(r.db, r.userId, r.now, periodFromQuery(r.query, r.now, householdZone(r.db, r.userId)), limit) : passbook(r.db, r.userId, r.now, limit) })
// The tax statement (server/tax.ts): modelled, not tax advice. csv=1 adds the CSV text beside the statement.
route('GET', '/api/tax', (r) => {
  const s = taxStatement(r.db, r.userId, r.now), recon = reconcileTax(r.db, r.userId, s)
  return { ...(JSON.parse(taxJson(s, recon)) as Json), ...(r.query.has('csv') ? { csv: taxCsv(s, recon) } : {}) }
})
// The person's data rights (server/records.ts): about the signed-in person, not a workspace.
route('GET', '/api/data', (r) => dataRightsView(r.db, r.personId, r.now), true, 'person')
route('GET', '/api/data/export', (r) => {
  const x = exportPerson(r.db, r.personId, r.now)
  logAccess(r.db, r.personId, 'export', { ip: r.ip, ua: ua(r) }, r.now)
  attachment(r, 'qed-my-data.json')
  return x
}, true, 'person')
route('POST', '/api/data/deletion', (r) => { requireStepUp(r); return requestDeletion(r.db, r.personId, r.body.confirm, r.now) }, true, 'person')
// The purge of an erased person's financial records after their retention period (server/records.ts): only a person the
// installation names (QED_PURGE_APPROVERS) sees it, each run is approved with a fresh passkey for one person and the preview
// they were shown, and nothing runs it on a timer.
const purgeApprover = (r: Req): void => {
  const h = r.db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', r.personId)?.handle.toLowerCase()
  if (!h || !purgeApprovers().includes(h)) throw new AppError(403, 'not_permitted', 'Only a person the installation names as a purge approver can see or approve a purge.')
}
route('GET', '/api/records/purge', (r) => { purgeApprover(r); return { candidates: purgeCandidates(r.db, r.now), now: r.now } }, true, 'person')
route('POST', '/api/records/purge', (r) => { purgeApprover(r); requireStepUp(r); return runPurge(r.db, r.personId, str(r.body.personId), r.body.previewDigest, r.now) }, true, 'person')
route('POST', '/api/data/deletion/cancel', (r) => { cancelDeletion(r.db, r.personId, r.now); return { ok: true } }, true, 'person')
route('GET', '/api/market', (r) => marketView(r.db, r.ctx.market, r.now))
// Grow's watchlist (server/watchlist.ts): the household's own list of names, each row built from the market data QED holds, with its
// source, time and observed or synthetic. Any member reads it; changing it needs the operator role (the default for a change). It
// is readable and keepable in any home currency: it holds no money and places no order (buying stays the ticket's, with its approval).
route('GET', '/api/watchlist', (r) => { requireSetup(r); return watchlistView(r.db, r.ctx.market, r.userId, r.now) })
route('POST', '/api/watchlist', (r) => {
  requireSetup(r)
  if (!rateLimit(r.db, `watchlist:${r.personId}`, 120, 3600_000, r.now)) throw new AppError(429, 'too_many', 'That is 120 changes to the watchlist in an hour. Wait a while.')
  const out = addWatch(r.db, r.ctx.market, r.userId, r.role, str(r.body.instrumentId), r.now, r.ip)
  if (out.added) emit(r.db, r.now, r.userId, 'watchlist', {})
  return out
})
route('POST', '/api/watchlist/remove', (r) => {
  requireSetup(r)
  if (!rateLimit(r.db, `watchlist:${r.personId}`, 120, 3600_000, r.now)) throw new AppError(429, 'too_many', 'That is 120 changes to the watchlist in an hour. Wait a while.')
  const out = removeWatch(r.db, r.userId, r.role, str(r.body.instrumentId), r.now, r.ip)
  if (out.removed) emit(r.db, r.now, r.userId, 'watchlist', {})
  return out
})
// Grow: holdings against a benchmark the owner chooses (none is chosen for them), and the risk estimates (benchmark.ts)
route('GET', '/api/grow/compare', (r) => { requireSetup(r); const hs = holdings(r.db, r.ctx.market, r.userId, r.now); return { comparison: compare(r.db, r.userId, hs, r.query.get('benchmark') || null, r.now), risk: riskEstimate(r.db, hs) } })
route('GET', '/api/market/history', (r) => history(r.db, str(r.query.get('id')), { days: Number(r.query.get('days')) || undefined, hours: Number(r.query.get('hours')) || undefined }))
route('GET', '/api/engine', (r) => ({ engine: engineStatus(r.db, r.now) }))
// Faults and how they ended: open ones, and the last few resolved (server/incidents.ts, R13 RE6).
route('GET', '/api/incidents', (r) => incidentsFor(r.db, r.now))
route('GET', '/api/system', (r) => ({ ...systemView(r.db, r.userId, r.now), recon: lastRecon(r.db, r.userId), receipts: verifyChain(r.db, r.userId), ledger: { breaks: verifyLedger(r.db, r.userId) }, ai: detectProvider(r.cfg) }))
route('GET', '/api/needs-you', (r) => ({ items: needsYou(r.db, r.userId, r.now), notices: noticesView(r.db, r.userId, r.now) }))
route('POST', '/api/notices/:id/read', (r) => { r.db.run('UPDATE notices SET read_at = ? WHERE id = ? AND user_id = ?', r.now, r.params[0]!, r.userId); return { ok: true } })
// A notice of a change to who can act is not dismissed by a session that may not settle it either (review M3).
route('POST', '/api/notices/:id/dismiss', (r) => {
  if (isWhoCanAct(r.db, r.userId, r.params[0]!)) mayClearWhoCanAct(r, r.params[0]!)
  dismissNotice(r.db, r.userId, r.params[0]!, r.now); return { ok: true }
})
// Notifications (notify.ts, R10-006): settings, what waits for an acknowledgement, what is held, the latest digests.
route('GET', '/api/notify', (r) => notifyView(r.db, r.userId, r.now))
route('POST', '/api/notify/prefs', (r) => ({ prefs: setPrefs(r.db, r.userId, (r.body ?? {}) as Record<string, unknown>, r.now) }))
// A change to who can act is cleared only by a session that could not have been opened with a phished password or a
// recovered passkey: maySettleSecurity. The same rule for acknowledging and for dismissing (review M3).
route('POST', '/api/notices/:id/ack', (r) => { if (isWhoCanAct(r.db, r.userId, r.params[0]!)) mayClearWhoCanAct(r, r.params[0]!); acknowledge(r.db, r.userId, r.params[0]!, r.now, { settleSecurity: maySettleSecurity(r) }); return { ok: true } })
route('GET', '/api/ledger', (r) => ({ entries: listEntries(r.db, r.userId, { limit: Number(r.query.get('limit')) || 60, beforeSeq: Number(r.query.get('before')) || undefined, account: r.query.get('account') ?? undefined }) }))
route('GET', '/api/accounts', (r) => ({ accounts: listAccounts(r.db, r.userId) }))
route('GET', '/api/receipts', (r) => ({ receipts: listReceipts(r.db, r.userId, Number(r.query.get('limit')) || 60, Number(r.query.get('before')) || undefined), chain: verifyChain(r.db, r.userId) }))
route('GET', '/api/receipts/:id', (r) => { const x = getReceipt(r.db, r.userId, r.params[0]!); if (!x) throw notFound('That receipt'); return x })
route('GET', '/api/since', (r) => { requireSetup(r); return sinceView(r.db, r.userId, Number(r.query.get('ts')), r.now) })
// ?first= and ?last= (India dates, as Activity's date filter chooses them; either end may be open) read only what falls in
// those days: actions by when they were made, runs by when they were due (the time their row shows), disputes by when they
// were raised. Without them, the latest of each, as before.
route('GET', '/api/activity', (r) => {
  const span = spanFromQuery(r.query, householdZone(r.db, r.userId))
  const from = span?.from ?? 0, to = span?.to ?? Number.MAX_SAFE_INTEGER
  return {
    actions: (() => { const titles = new Map(r.db.all<{ id: string; title: string }>('SELECT id, title FROM programs WHERE user_id = ?', r.userId).map((p) => [p.id, p.title])); return listActions(r.db, r.userId, { limit: Number(r.query.get('limit')) || 80, before: Number(r.query.get('before')) || undefined, now: r.now, ...(span ? { from, to } : {}) }).map((a) => ({ ...a, programTitle: a.programId ? titles.get(String(a.programId)) ?? null : null })) })(),
    runs: (span
      ? r.db.all<Json>(`SELECT r.*, p.title program_title, p.kind program_kind FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.user_id = ? AND r.due_at >= ? AND r.due_at < ? ORDER BY r.due_at DESC LIMIT 80`, r.userId, from, to)
      : r.db.all<Json>(`SELECT r.*, p.title program_title, p.kind program_kind FROM runs r JOIN programs p ON p.id = r.program_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 80`, r.userId)).map((x) => ({ ...runView(r.db, x, false), programTitle: x.program_title, programKind: x.program_kind })),
    disputes: r.db.all('SELECT id, action_id, state, reason, resolution, created_at, updated_at FROM disputes WHERE user_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 40', r.userId, from, to),
  }
})
route('GET', '/api/actions/:id', (r) => { const a = recordView(r.db, r.userId, r.params[0]!); if (!a) throw notFound('That action'); return a })

// ------------------------------------------------------------------------------------------------ programs
route('GET', '/api/programs', (r) => ({ programs: listPrograms(r.db, r.userId, r.now), kinds: kindCatalogue() }))
route('GET', '/api/programs/:id', (r) => { const p = programDetail(r.db, r.userId, r.params[0]!, r.now); if (!p) throw notFound('That instruction'); return { ...p, current: currentAnalysis(r.ctx, r.userId, r.params[0]!, r.now), calendar: runCalendar(r.db, r.userId, r.params[0]!, r.now), goal: p.kind === 'goal' ? goalView(r.db, r.userId, r.params[0]!, r.now) : null } })
route('POST', '/api/programs/preview', (r) => { requireSetup(r); const d = buildDraft(r.ctx, r.userId, str(r.body.kind), r.body.params, r.body.authority, r.now); return { draft: { ...d, document: undefined } } })
route('POST', '/api/programs', (r) => { requireSetup(r); const from = r.body.proposalId === undefined || r.body.proposalId === null ? null : ownProposal(r, r.body.proposalId); const d = saveDraft(r.ctx, r.userId, { kind: str(r.body.kind), params: r.body.params, authority: r.body.authority, origin: from ? `proposal:${from}` : 'owner' }); if (from) r.db.run(`UPDATE proposals SET state = 'drafted' WHERE id = ? AND user_id = ?`, from, r.userId); return { programId: d.programId, version: d.version, contradictions: contradictionsOf(r.db, r.userId, d.programId, d.draft.kind, d.draft.params, d.draft.authority) } })
// A saved draft comes back with its contradictions, so the interface asks the owner to resolve them before it asks
// for signing; the approval route still refuses an unresolved one.
route('POST', '/api/programs/:id/draft', (r) => { const d = saveDraft(r.ctx, r.userId, { programId: r.params[0]!, params: r.body.params, authority: r.body.authority }); return { programId: d.programId, version: d.version, contradictions: contradictionsOf(r.db, r.userId, d.programId, d.draft.kind, d.draft.params, d.draft.authority) } })
route('POST', '/api/programs/:id/approval', (r) => { const a = requestProgramApproval(r.ctx, r.userId, r.params[0]!, Array.isArray(r.body.acknowledge) ? (r.body.acknowledge as unknown[]).filter((x): x is string => typeof x === 'string') : []); return { approvalId: a.approvalId, version: a.version, document: a.draft.document, doc: a.draft.doc, docHash: a.draft.contentHash, analysis: a.draft.analysis, expiresAt: a.expiresAt, requiresStepUp: true } })
route('POST', '/api/programs/:id/activate', (r) => ({ program: activateProgram(r.ctx, r.userId, r.params[0]!, str(r.body.approvalId)) }))
route('POST', '/api/programs/:id/pause', (r) => { guardProtective(r, r.params[0]); return { program: pauseProgram(r.ctx, r.userId, r.params[0]!) } })
// Resuming restores spending authority the owner paused, so it needs a fresh passkey confirmation from every session, one
// opened with a passkey included (Q-059, decided in the R13 hardening brief: "never a passkey session alone"), by a passkey
// past its first 24 hours (RISK-068). A session opened with a password, or with a passkey that signs in only, confirms
// with a passkey that can approve, as before (D-094, review H2). It takes a member who may sign: an operator could resume
// what the owner had paused (R13 review, R11).
route('POST', '/api/programs/:id/resume', (r) => { requireSettled(r, 'resume a paused instruction'); return { program: resumeProgram(r.ctx, r.userId, r.params[0]!) } }, true, 'approver')
// Revoking reaches every channel the instruction reaches, and each channel's answer is recorded (revocation.ts; finding S7)
// R13: when the revocation names the wallet's on-chain mandate, the wallet's own revoke-mandate proposal is prepared at once
// for the person to sign with their passkey (chainProposal, the wallet route's answer); it can be prepared again after it lapses.
route('POST', '/api/programs/:id/revoke', async (r) => {
  guardProtective(r, r.params[0])
  let revocation = revokeEverywhere(r.ctx, r.userId, r.params[0]!, vaultOf(r.db, r.userId) !== null)
  const waiting = revocation?.channels.find((c) => c.channel === 'chain' && c.state === 'needs-you' && !c.reference)
  const chainProposal = revocation && waiting ? await prepareChainRevocation(r, revocation.id).catch(() => null) : null
  if (revocation) revocation = revocations(r.db, r.userId).find((x) => x.id === revocation!.id) ?? revocation
  return { program: loadProgram(r.db, r.userId, r.params[0]!), revocation, chainProposal }
})
route('POST', '/api/revocations/:id/chain', async (r) => {
  const rev = revocations(r.db, r.userId).find((x) => x.id === r.params[0])
  if (!rev || !rev.channels.some((c) => c.channel === 'chain' && c.state === 'needs-you')) throw new AppError(404, 'not_found', 'No revocation of yours is waiting for the wallet\'s mandate to be revoked.')
  const out = await prepareChainRevocation(r, rev.id)
  if (!out) throw new AppError(409, 'nothing_to_revoke', 'The wallet has no mandate in force for QED\'s agent, or did not answer. Look at the revocation again.')
  return out
})
route('GET', '/api/revocations', async (r) => {
  // a revocation given to the chain is acknowledged only when the chain's own job reports it done (rail.ts railItem)
  for (const c of r.db.all<{ reference: string }>(`SELECT DISTINCT c.reference FROM revocation_channels c JOIN revocations v ON v.id = c.revocation_id WHERE v.user_id = ? AND c.channel = 'chain' AND c.state = 'sent' AND c.reference IS NOT NULL`, r.userId)) {
    try { const job = await railItem(r.cfg, r.db, asker(r), 'jobs', c.reference); chainAnswered(r.db, r.userId, { id: c.reference, status: String(job.status ?? '') }, r.now) } catch { /* the chain did not answer: it stays 'sent', not revoked */ }
  }
  return { revocations: revocations(r.db, r.userId) }
})
route('POST', '/api/programs/:id/discard-draft', (r) => { discardDraft(r.ctx, r.userId, r.params[0]!); return { ok: true } })

// ------------------------------------------------------------------------------------------------ savings goals (goals.ts)
// A goal is an instruction of the kind "goal", written and signed through the routes above. These read where each goal
// stands, and release a set-aside back to the bank account: prepared as exact terms, and made only once the owner's
// passkey has confirmed them (POST /api/approvals/:id/confirm), once.
route('GET', '/api/goals', (r) => { requireSetup(r); return goalsView(r.db, r.userId, r.now) })
route('POST', '/api/goals/:id/release/prepare', (r) => prepareRelease(r.ctx, r.userId, r.params[0]!, { amount: r.body.amount }))
route('POST', '/api/goals/:id/release', (r) => releaseSetAside(r.ctx, r.userId, r.params[0]!, str(r.body.approvalId)))

// Asking again withdraws the request already waiting (approvals.ts createApproval): for a run of a protective instruction
// that stops the sale, so it takes what cancelling the run takes (R13 review, lead L-12). A first request withdraws nothing.
route('POST', '/api/runs/:id/approval', (r) => { if (waiting(r, `run:${r.params[0]!}`)) guardProtective(r, runProgram(r, r.params[0]!)); return requestRunApproval(r.ctx, r.userId, r.params[0]!) })
route('POST', '/api/runs/:id/cancel', (r) => { guardProtective(r, r.db.get<{ program_id: string }>('SELECT program_id FROM runs WHERE id = ? AND user_id = ?', r.params[0]!, r.userId)?.program_id); return { run: cancelRun(r.ctx, r.userId, r.params[0]!) } })

// ------------------------------------------------------------------------------------------------ workspaces
route('GET', '/api/workspaces', (r) => ({ current: r.userId, workspaces: listWorkspaces(r.db, r.personId) }))
route('POST', '/api/workspaces', (r) => { requireStepUp(r); const id = createBusiness(r.db, r.personId, r.body.name, r.now); switchWorkspace(r.db, r.session.sessionHash, r.personId, id); return { id } })
route('POST', '/api/workspaces/:id/switch', (r) => { switchWorkspace(r.db, r.session.sessionHash, r.personId, r.params[0]!); return { ok: true } })
route('GET', '/api/workspace', (r) => ({ id: r.userId, role: r.role, policy: policyOf(r.db, r.userId), members: members(r.db, r.userId),
  // who checks the rule: the chain's count on a vault's actions, and QED alone for bands and limits (workspaces.ts enforcementOf)
  enforcement: enforcementOf((() => { const v = vaultOf(r.db, r.userId); return v ? { threshold: v.current?.threshold ?? v.request.owner.threshold } : null })()),
  code: r.db.get<{ handle: string }>('SELECT handle FROM users WHERE id = ?', r.userId)?.handle ?? null,
  // A lowering of the policy that is waiting out its delay: shown here, where any member who may sign can cancel it.
  pending: r.db.all<{ id: string; effective_at: number; requested_at: number; detail_json: string; person_id: string }>(`SELECT id, effective_at, requested_at, detail_json, person_id FROM scheduled_changes WHERE workspace_id = ? AND kind = 'lower-policy' AND cancelled_at IS NULL AND applied_at IS NULL ORDER BY requested_at`, r.userId)
    .map((c) => ({ id: c.id, effectiveAt: c.effective_at, requestedAt: c.requested_at, requestedBy: c.person_id, ...parse<{ policy?: unknown; before?: unknown }>(c.detail_json, {}) })),
  // members to be given authority, waiting out the delay; any member who may sign cancels one (POST /api/security/changes/:id/cancel)
  grants: pendingGrants(r.db, r.userId) }))
// Adding someone, or changing who must sign, is a change of authority: a fresh passkey confirmation first. Giving a member
// authority (any role but viewer, or a raised role) is a loosening under the 72-hour rule (workspaces.ts requestMember;
// Q-048 as decided): it waits, any member who may sign can cancel it, and everyone is told. Narrowing applies at once.
const memberBy = (r: Req) => ({ personId: r.personId, role: r.role, beforeLoosening: () => refuseCoolingOff(r.db, r.session, 'give a member authority', r.now) })
route('POST', '/api/workspace/members', (r) => { requireStepUp(r); const grant = requestMember(r.db, r.userId, memberBy(r), r.body.handle, r.body.role, r.now); return { members: members(r.db, r.userId), grant, grants: pendingGrants(r.db, r.userId) } }, true, 'admin')
route('POST', '/api/workspace/members/:id/role', (r) => { requireStepUp(r); const out = changeRole(r.db, r.userId, memberBy(r), r.params[0]!, r.body.role, r.now); return { ...out, members: members(r.db, r.userId), grants: pendingGrants(r.db, r.userId) } }, true, 'admin')
// Removing a member takes access away: at once, with a fresh confirmation; a member may also leave.
route('POST', '/api/workspace/members/:id/remove', (r) => { requireStepUp(r); const out = removeMember(r.db, r.userId, { personId: r.personId, role: r.role }, r.params[0]!, r.now); return { ...out, members: members(r.db, r.userId) } }, true, 'viewer')
route('POST', '/api/workspace/policy', (r) => {
  requireStepUp(r)
  const next = r.body as Json
  const patch: PolicyPatch = {
    ...(typeof next.signers === 'number' ? { signers: next.signers } : {}), ...(typeof next.makerChecker === 'boolean' ? { makerChecker: next.makerChecker } : {}),
    ...(next.largePaise === null || typeof next.largePaise === 'number' ? { largePaise: next.largePaise as number | null } : {}), ...(next.largeSigners === null || typeof next.largeSigners === 'number' ? { largeSigners: next.largeSigners as number | null } : {}),
    // amount bands replace the list; a member's limit is a number of paise, or null to remove it (workspaces.ts setPolicy)
    ...(Array.isArray(next.bands) ? { bands: (next.bands as Json[]).map((b) => ({ fromPaise: Number(b.fromPaise), signers: Number(b.signers) })) } : {}),
    ...(next.limits && typeof next.limits === 'object' && !Array.isArray(next.limits) ? { limits: Object.fromEntries(Object.entries(next.limits as Json).map(([k, v]) => [k, v === null ? null : Number(v)])) } : {}),
  }
  return setPolicy(r.db, r.userId, { personId: r.personId, role: r.role, beforeLoosening: () => refuseCoolingOff(r.db, r.session, 'lower the signing policy', r.now) }, patch, r.now)
}, true, 'admin')

// ------------------------------------------------------------------------------------------------ the institutional desk (R13)
// Netting between workspaces (netting.ts), requests for quotes (rfq.ts), model portfolios and reports (institutional.ts). QED's own
// capability, labelled as such on every screen; the paper bank and the simulated dealers are labelled simulated.
const whoOf = (r: Req): { personId: string; role: Role } => ({ personId: r.personId, role: r.role })
route('GET', '/api/desk/netting', (r) => nettingView(r.db, r.userId, r.now))
route('POST', '/api/desk/netting/claims', (r) => proposeClaim(r.db, r.userId, whoOf(r), r.body, r.now))
route('POST', '/api/desk/netting/claims/:id/agree', (r) => answerClaim(r.db, r.userId, whoOf(r), r.params[0]!, true, r.now))
route('POST', '/api/desk/netting/claims/:id/decline', (r) => answerClaim(r.db, r.userId, whoOf(r), r.params[0]!, false, r.now))
route('POST', '/api/desk/netting/claims/:id/withdraw', (r) => withdrawClaim(r.db, r.userId, whoOf(r), r.params[0]!, r.now))
route('POST', '/api/desk/netting/cycles', (r) => proposeCycle(r.db, r.userId, whoOf(r), r.body.counterparties, r.now))
route('POST', '/api/desk/netting/cycles/:id/agree', (r) => agreeCycle(r.db, r.userId, whoOf(r), r.params[0]!, r.body.fingerprint, r.now))
route('POST', '/api/desk/netting/cycles/:id/cancel', (r) => cancelCycle(r.db, r.userId, whoOf(r), r.params[0]!, r.now))
route('POST', '/api/desk/netting/cycles/:id/pay', (r) => preparePayment(r.db, r.userId, whoOf(r), r.params[0]!, r.now))
route('POST', '/api/desk/netting/cycles/:id/settle', (r) => settleIfReady(r.db, r.userId, r.params[0]!, r.now))
route('GET', '/api/desk/rfq', (r) => ({ quotes: listQuotes(r.db, r.userId) }))
route('POST', '/api/desk/rfq', async (r) => { requireSetup(r); return requestQuotes(r.ctx, r.userId, whoOf(r), r.body, r.now) })
route('GET', '/api/desk/models', (r) => modelsView(r.db, r.userId))
route('POST', '/api/desk/models', (r) => createModel(r.db, r.userId, whoOf(r), r.body, r.now))
route('POST', '/api/desk/models/:id/offer', (r) => offerModel(r.db, r.userId, whoOf(r), r.params[0]!, r.body.codes, r.now))
route('POST', '/api/desk/offers/:id/accept', (r) => answerOffer(r.ctx, r.cfg, r.userId, whoOf(r), r.params[0]!, true, r.now))
route('POST', '/api/desk/offers/:id/decline', (r) => answerOffer(r.ctx, r.cfg, r.userId, whoOf(r), r.params[0]!, false, r.now))
const reportDays = (v: unknown): number => { const n = Number(v); return Number.isInteger(n) && n >= 7 && n <= 3650 ? n : 90 }
route('GET', '/api/desk/report', (r) => { requireSetup(r); return clientReport(r.ctx, r.userId, reportDays(r.query.get('days')), r.now) })
route('GET', '/api/desk/reports', (r) => ({ scope: SCOPE_NOTE, days: reportDays(r.query.get('days')), reports: reportsAcross(r.ctx, r.personId, reportDays(r.query.get('days')), r.now) }))

// ------------------------------------------------------------------------------------------------ approvals
route('GET', '/api/approvals/open', (r) => ({ approvals: openApprovals(r.db, r.userId, r.personId, r.role, r.now) }))
// `prepared`: the sentences the document carries about what a password session prepared (RISK-076), for the approval
// sheet to show before the passkey is asked.
route('GET', '/api/approvals/:id', (r) => { const a = getApproval(r.db, r.userId, r.params[0]!); if (!a) throw notFound('That approval'); return { id: a.id, serverNow: r.now, renewable: renewable(r.db, a, r.now), purpose: a.purpose, subject: a.subject, document: a.document, docHash: a.doc_hash, expiresAt: a.expires_at, confirmedAt: a.confirmed_at, consumedAt: a.consumed_at, cancelledAt: a.cancelled_at, requiresStepUp: a.requires_stepup === 1, prepared: preparedIn(a.document) } })
// Every approval is the person's passkey signing the exact terms (R7, D3 layer 2): the challenge is derived from the
// approval's id and the hash of its document, so the signature covers those terms and nothing else. There is no
// password or session-only approval through the API.
route('POST', '/api/approvals/:id/passkey', (r) => {
  const a = getApproval(r.db, r.userId, r.params[0]!)
  if (!a) throw notFound('That approval')
  return beginReauth(r.db, rp(r), r.session.userId, 'approval', approvalChallenge(a.id, a.doc_hash), { approvalId: a.id, docHash: a.doc_hash }, r.now)
})
route('POST', '/api/approvals/:id/confirm', async (r) => {
  const a = getApproval(r.db, r.userId, r.params[0]!)
  if (!a) throw notFound('That approval')
  if (r.body.challengeId === undefined || r.body.response === undefined) {
    if (hasPasskey(r.db, r.session.userId) && !hasApprovingPasskey(r.db, r.session.userId)) throw restrictedError()
    throw new AppError(401, hasPasskey(r.db, r.session.userId) ? 'passkey_required' : 'passkey_needed', hasPasskey(r.db, r.session.userId) ? 'Approve with your passkey.' : 'Add a passkey to this account first. Approvals need one.')
  }
  const v = await finishReauth(r.db, rp(r), r.session, 'approval', { challengeId: r.body.challengeId, response: r.body.response }, r.now)
  if (v.context.approvalId !== a.id || v.context.docHash !== a.doc_hash) throw new AppError(409, 'approval_mismatch', 'That signature was made for something else. Nothing was approved.')
  const resp = r.body.response as { response?: { authenticatorData?: string; clientDataJSON?: string; signature?: string } }
  const evidence = { credentialId: v.credential.id, challenge: v.challenge, authenticatorData: resp.response?.authenticatorData, clientDataJSON: resp.response?.clientDataJSON, signature: resp.response?.signature }
  const s = signApproval(r.db, r.userId, a.id, { personId: r.personId, role: r.role, credentialId: v.credential.id, evidence, sessionHash: r.session.sessionHash }, str(r.body.docHash), r.now)
  // In a business workspace the last signer may be on another screen than the maker: the request is carried out here.
  if (s.complete && s.required > 1) await completeMultiSigned(r, s.approval)
  // A netting payment's last signature settles the cycle when every other workspace's side is ready too (netting.ts).
  const cycle = s.complete && s.approval.purpose === 'netting' ? /^netting:([^:]+):/.exec(s.approval.subject)?.[1] : undefined
  const settlement = cycle ? settleIfReady(r.db, r.userId, cycle, r.now) : undefined
  return { id: a.id, confirmedAt: s.approval.confirmed_at, method: 'passkey', complete: s.complete, signed: s.signed, required: s.required, ...(settlement ? { settlement } : {}) }
})
route('POST', '/api/approvals/:id/cancel', (r) => {
  const a = getApproval(r.db, r.userId, r.params[0]!)
  if (!a) throw notFound('That approval')
  // withdrawing a protective sale's request stops the sale: the rule for cancelling its run (lead L-12)
  const run = /^run:(.+)$/.exec(a.subject)?.[1]
  if (run) guardProtective(r, runProgram(r, run))
  cancelApproval(r.db, r.userId, r.params[0]!, r.now); return { ok: true }
})
// Keep a request open (WCAG 2.2.1): the same document again, open for the usual time, replacing this one; a request
// whose time is part of its terms says why it cannot be kept open (server/approvals.ts renewTtl).
route('POST', '/api/approvals/:id/renew', (r) => { const a = renewApproval(r.db, r.userId, r.params[0]!, r.now); return { approvalId: a.id, docHash: a.doc_hash, expiresAt: a.expires_at } })

// ------------------------------------------------------------------------------------------------ doing things by hand
route('POST', '/api/actions/preview', async (r) => { requireSetup(r); return previewAction(r.ctx, r.userId, r.body) })
route('POST', '/api/actions', (r) => { const a = submitApprovedAction(r.ctx, r.userId, str(r.body.approvalId)); return actionView(r.db, r.db.get<Json>('SELECT * FROM actions WHERE id = ?', a.id)!) })
route('POST', '/api/actions/:id/cancel', (r) => { const a = cancelAction(r.ctx, r.userId, r.params[0]!); return actionView(r.db, r.db.get<Json>('SELECT * FROM actions WHERE id = ?', a.id)!) })
// A payment held because it repeats an earlier one is sent only after this, with a fresh passkey confirmation (duplicates.ts)
route('POST', '/api/actions/:id/confirm-repeat', async (r) => { requireStepUp(r); confirmRepeat(r.ctx, r.userId, r.params[0]!); const a = await stepAction(r.ctx, r.params[0]!); return actionView(r.db, r.db.get<Json>('SELECT * FROM actions WHERE id = ?', a.id)!) })
// A dispute pack for a payment that is disputed or whose outcome is not known (dispute-pack.ts; finding S6), and as a download
route('GET', '/api/actions/:id/dispute-pack', (r) => disputePack(r.db, r.userId, r.params[0]!, r.now))
route('GET', '/api/actions/:id/dispute-pack/export', (r) => {
  const p = disputePack(r.db, r.userId, r.params[0]!, r.now)
  attachment(r, `qed-dispute-pack-${p.payment.actionId}.json`)
  return p
})
// The pause a reported problem puts on QED's own payments on that rail (dispute-pause.ts; N-018): released only by the person,
// with a fresh passkey confirmation past its cool-off, as resuming after a stop is.
route('POST', '/api/dispute-pauses/:id/release', (r) => { requireSettled(r, 'release the pause'); return { pause: releasePause(r.ctx, r.userId, r.personId, r.params[0]!) } }, true, 'admin')
// The institutions QED can be set up with, every one of them SIMULATED, each with its terms summary shown before connecting;
// real banks appear as references with no connection (institution-terms.ts, N-015). Setting one up records the workspace's bank
// entitlements, mapped from its roles, and for a US business the acknowledged Article 4A disclosure (institution-setup.ts, N-020).
route('GET', '/api/institutions', (r) => institutionsView(r.db, r.userId, INSTITUTION_TERMS))
route('POST', '/api/institutions/:id/setup', (r) => { requireStepUp(r); return { setup: setUpInstitution(r.db, { workspaceId: r.userId, personId: r.personId, role: r.role }, { ...r.body, institution: r.params[0] }, r.now) } }, true, 'admin')
// Subscriptions found in the payment history, and what the person decides about each (subscriptions.ts; finding S3)
route('GET', '/api/subscriptions', (r) => ({ rule: DETECTION_RULE, cannotCancel: CANNOT_CANCEL, subscriptions: subscriptions(r.db, r.userId, r.now) }))
route('POST', '/api/subscriptions/stop', (r) => stopSubscription(r.ctx, r.userId, str(r.body.payeeHandle), vaultOf(r.db, r.userId) !== null))
route('POST', '/api/subscriptions/cancel-myself', (r) => { markCancelMyself(r.ctx, r.userId, str(r.body.payeeHandle)); return { ok: true } })
route('POST', '/api/actions/:id/dispute', (r) => openDispute(r.ctx, r.userId, r.params[0]!, r.body.reason))
// each payee with what the paper bank's name check answered when it was added (name-check.ts), shown before any payment
// ------------------------------------------------------------------------------------------------ agent commerce (R13, S2)
// QED buys from simulated paywalled services, on the paper rail, within a mandate the owner signs with the passkey.
route('GET', '/api/commerce', (r) => commerceState(r.ctx, r.userId))
route('POST', '/api/commerce/mandate', (r) => { requireSetup(r); const m = prepareMandate(r.ctx, r.userId, r.body); return { approvalId: m.approvalId, document: m.document, docHash: m.docHash, expiresAt: m.expiresAt, requiresStepUp: m.requiresStepUp, terms: m.terms } }, true, 'approver')
route('POST', '/api/commerce/mandate/activate', (r) => ({ mandate: activateMandate(r.ctx, r.userId, str(r.body.approvalId)) }), true, 'approver')
route('POST', '/api/commerce/mandate/revoke', (r) => revokeMandate(r.ctx, r.userId), true, 'approver')
route('POST', '/api/commerce/quotes', async (r) => { requireSetup(r); const { raw: _raw, ...c } = await compareQuotes(r.ctx, r.userId, str(r.body.sku)); return c }, true, 'approver')
route('POST', '/api/commerce/purchases', async (r) => { requireSetup(r); return buyService(r.ctx, r.userId, { sku: r.body.sku, serviceId: r.body.serviceId, idempotencyKey: r.body.idempotencyKey ?? (str(r.req.headers['idempotency-key']) || undefined) }) }, true, 'approver')
route('GET', '/api/commerce/purchases/:id', (r) => { const p = purchaseView(r.db, r.userId, r.params[0]!); if (!p) throw notFound('That purchase'); return p })
route('GET', '/api/payees', (r) => ({ payees: r.db.all('SELECT id, name, handle, category, created_at, verified_at, name_check, registered_name FROM payees WHERE user_id = ? ORDER BY name', r.userId) }))
route('POST', '/api/payees', (r) => addPayee(r.db, r.userId, r.body, r.now))
// asked before adding: what the paper bank's name check and the look-alike check would need confirmed; nothing is saved
route('POST', '/api/payees/check', (r) => checkNewPayee(r.db, r.userId, r.body))

// ------------------------------------------------------------------------------------------------ other currencies and payments abroad (R13)
// Balances by currency and a priced total that names its rates (fx.ts); the paper desk's executable quotes, approved with
// the passkey through /api/approvals like every other request, and filled once; payees abroad, paper routes, and payments
// that are refused with the reason, never rerouted (abroad.ts). Paper only.
route('GET', '/api/money', (r) => { requireSetup(r); return { ...moneyView(r.ctx, r.userId), ...fxGoalsView(r.ctx, r.userId) } })
route('POST', '/api/fx/goals', (r) => { requireSetup(r); return addFxGoal(r.db, r.userId, r.body, r.now) })
route('POST', '/api/fx/goals/:id/remove', (r) => { requireSetup(r); removeFxGoal(r.db, r.userId, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/fx/quote', (r) => { requireSetup(r); return prepareConversion(r.ctx, r.userId, r.body) })
route('POST', '/api/fx/convert', (r) => { requireSetup(r); return convertApproved(r.ctx, r.userId, str(r.body.approvalId)) })
route('GET', '/api/abroad', (r) => { requireSetup(r); return abroadView(r.ctx, r.userId) })
route('POST', '/api/abroad/payees', (r) => { requireSetup(r); return addAbroadPayee(r.db, r.userId, r.body, r.now) })
route('POST', '/api/abroad/prepare', (r) => { requireSetup(r); return prepareAbroad(r.ctx, r.userId, r.body) })
route('POST', '/api/abroad/pay', (r) => { requireSetup(r); return payAbroad(r.ctx, r.userId, str(r.body.approvalId)) })
route('GET', '/api/abroad/payments/:id', (r) => { const p = paymentView(r.db, r.userId, r.params[0]!); if (!p) throw notFound('That payment'); return p })
// each bill says when a payment for it is under way (paying), so it is not offered for payment twice (R12 task comparison)
route('GET', '/api/bills', (r) => ({ bills: r.db.all<Record<string, unknown> & { id: string; state: string }>(`SELECT b.id, b.amount, b.due_at, b.memo, b.state, b.action_id, b.created_at, y.id payee_id, y.name payee_name, y.handle payee_handle FROM bills b JOIN payees y ON y.id = b.payee_id WHERE b.user_id = ? ORDER BY b.due_at DESC LIMIT 200`, r.userId).map((b) => ({ ...b, paying: b.state === 'due' || b.state === 'failed' ? billPaymentUnderWay(r.db, r.userId, b.id) ?? null : null, removal: b.state === 'due' ? pendingBillRemoval(r.db, r.userId, b.id) : null })) }))
route('POST', '/api/bills', (r) => addBill(r.db, r.userId, r.body, r.now))
route('POST', '/api/bills/:id/cancel', (r) => {
  // A bill that is counted in what must stay cannot be dropped at once: removing it frees its money, so it needs a fresh
  // passkey and waits out the protection delay, cancellable from any passkey (loosening.ts requestBillRemoval).
  const out = requestBillRemoval(r.db, { personId: r.personId, workspaceId: r.userId, fresh: r.session.stepUpFresh, beforeLoosening: () => refuseCoolingOff(r.db, r.session, 'remove a bill your reserve counts', r.now) }, r.params[0]!, r.now, () => cancelBill(r.db, r.userId, r.params[0]!, r.now))
  audit(r.db, r.now, r.userId, 'owner', 'bill.remove-request', r.params[0]!, out.removed ? { removed: true } : { waiting: out.waiting.id, effectiveAt: out.waiting.effectiveAt, contactsTold: out.contactsTold }, r.ip)
  return out.removed ? { ok: true } : { ok: true, waiting: { changeId: out.waiting.id, effectiveAt: out.waiting.effectiveAt, reserve: out.waiting.reserve }, contactsTold: out.contactsTold }
})
route('POST', '/api/money-in', (r) => { requireSetup(r); return recordMoneyIn(r.ctx, r.userId, r.body) })
// a household first: what the escrow pays the earner is posted to its bank account
route('POST', '/api/earn/jobs', (r) => { requireSetup(r); return createJob(r.db, r.userId, r.body, r.now) })
route('POST', '/api/earn/milestones/:id/submit', async (r) => (await submitMilestone(r.db, r.userId, r.params[0]!, r.body.evidence, r.now)) ?? { ok: true })
route('POST', '/api/earn/milestones/:id/client', async (r) => (await clientDecision(r.ctx, r.userId, r.params[0]!, r.body.decision, r.body)) ?? { ok: true })

// --- paper escrow: terms both sides accept, deadlines and defaults from them, two-sided disputes (R12 gap 16, R13 section 2) ---
// GET /api/earn: the policies a job chooses from (each default with its reason and source), every job and milestone, each
// paper job's accepted terms with their fingerprint, and each paper milestone with its deadline (from its terms and the
// step that started it), dispute, recorded steps, who acts next (actor, step, deadline, what happens on inaction) and the
// moves open to each role. POST /api/earn/terms/preview gives the complete terms a new job would be opened on and their
// fingerprint; POST /api/earn/jobs opens it only with that fingerprint and both sides' acceptance (server/escrow.ts). A
// business workspace's client member accepts a job's terms with /jobs/:id/accept. The earner's steps, evidence from either
// side, the simulated mediator's decision, settling by agreement, and terms for a milestone opened before terms were
// recorded (one side reads them with /terms/preview and proposes them by their fingerprint; the other accepts them by
// it). Each step is refused from anyone but the member who plays its role. The engine applies each timeout outcome the
// terms state (escrowTick).
route('GET', '/api/earn', (r) => paperView(r.db, r.userId, r.now))
route('POST', '/api/earn/terms/preview', (r) => { requireSetup(r); return previewTerms(r.db, r.userId, r.body, r.now) })
route('POST', '/api/earn/jobs/:id/accept', (r) => { acceptJobTerms(r.ctx, r.userId, r.params[0]!, r.body); return { ok: true } })
route('POST', '/api/earn/milestones/:id/earner', (r) => { earnerStep(r.ctx, r.userId, r.params[0]!, r.body.step, r.body); return { ok: true } })
route('POST', '/api/earn/milestones/:id/evidence', (r) => { addEvidence(r.ctx, r.userId, r.params[0]!, r.body); return { ok: true } })
route('POST', '/api/earn/milestones/:id/decide', (r) => { decide(r.ctx, r.userId, r.params[0]!, r.body); return { ok: true } })
route('POST', '/api/earn/milestones/:id/settle', (r) => settleByAgreement(r.ctx, r.userId, r.params[0]!, r.body))
route('POST', '/api/earn/milestones/:id/terms/preview', (r) => previewProposal(r.db, r.userId, r.params[0]!, r.body, r.now))
route('POST', '/api/earn/milestones/:id/terms', (r) => proposeTerms(r.ctx, r.userId, r.params[0]!, r.body))
route('POST', '/api/earn/milestones/:id/terms/accept', (r) => { acceptTerms(r.ctx, r.userId, r.params[0]!, r.body); return { ok: true } })
// --- end paper escrow ---

// A session opened with a password, without a fresh passkey confirmation, pauses everything but protective selling: it
// cannot switch protection off (the D-094 review, M3). The answer says which pause took effect. A session opened with a
// passkey that signs in only is told so when it asks to switch protective selling off (review H2): it may pause the rest.
route('POST', '/api/stop', (r) => {
  if (r.body.keepProtective === false && r.session.signinOnly && !r.session.stepUpFresh) throw new AppError(409, 'authority_restricted', 'This session was opened with a passkey that signs in only, so it cannot switch protective selling off. Pause everything except protective selling, or ask for approval authority under Security and recovery.')
  const keep = r.body.keepProtective === true || (weakSession(r.session) && !r.session.stepUpFresh)
  // the answer is the pause that holds afterwards: one already in force is only ever tightened (runner.ts setStop)
  // its reason is never taken from the request, so a pause cannot be put in someone else's name
  const held = setStop(r.ctx, r.userId, 'Paused by you', keep)
  return { ok: true, keptProtective: held.keptProtective }
})
route('POST', '/api/stop/clear', (r) => { requireSettled(r, 'resume QED'); clearStop(r.ctx, r.userId); return { ok: true } })
// What pausing would change in the next two weeks, for the pause sheet: the runs and bills QED would not do, and what
// happens anyway (server/stop-preview.ts).
route('GET', '/api/stop/preview', (r) => stopPreview(r.db, r.userId, r.now))

// ------------------------------------------------------------------------------------------------ readiness
// What this build is, what it derives from, and why it is not ready for real money (R7-088, R7-098). See readiness.ts.
route('GET', '/api/readiness', () => readiness())
// where QED could move real money, and what each capability needs in each country (N-022; server/legal.ts)
route('GET', '/api/legal', () => legalView())

// --- vault signers and recovery (RISK-053) ---
// Who signs for this workspace's vault, and how it is recovered (server/rail-signers.ts). The vault's owner account
// decides on the chain: adding a signer applies at once (its admin threshold signs the exact terms); removing one or
// lowering a threshold waits the account's delay and any other signer can cancel; a recovery adds one passkey after the
// recovery delay. Changing who signs is a change of authority: a fresh passkey confirmation first. The approvals these
// return are signed and sent with the vault routes below (/api/vault/approvals/:id/sign/begin, /sign, then
// /api/vault/proposals/:id/execute); scheduled changes are cancelled (cancel-change) and applied (/api/vault/scheduled/:id/apply)
// there too. Registered before GET /api/vault/:name, which would otherwise take /api/vault/signers. The module is loaded
// here so that every line of this feature stays inside this block.
const vaultSigners = () => import('./rail-signers.ts')
const signersAsker = (r: Req): Asker => ({ workspaceId: r.userId, personId: r.personId, role: r.role, session: r.session })
route('GET', '/api/vault/signers', async (r) => (await vaultSigners()).vaultSignersView(r.cfg, r.db, signersAsker(r)))
route('POST', '/api/vault/signers/add', async (r) => { requireSettled(r, 'add a signer'); return (await vaultSigners()).proposeAddSigner(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
route('POST', '/api/vault/signers/remove', async (r) => { requireSettled(r, 'remove a signer'); return (await vaultSigners()).proposeRemoveSigners(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
route('POST', '/api/vault/signers/thresholds', async (r) => { requireSettled(r, 'change how many signers must sign'); return (await vaultSigners()).proposeThresholds(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
route('POST', '/api/vault/recovery-keys/begin', async (r) => { requireSettled(r, 'add a recovery key'); return (await vaultSigners()).beginRecoveryKey(r.db, signersAsker(r), r.now) }, true, 'admin')
route('POST', '/api/vault/recovery-keys', async (r) => { requireSettled(r, 'add a recovery key'); return (await vaultSigners()).proposeRecoveryKey(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
// R13: a recovery is relayed only once the passkey it adds has confirmed that very request (rail-signers.ts).
route('POST', '/api/vault/recovery/begin', async (r) => { requireSettled(r, 'recover the vault'); return (await vaultSigners()).beginVaultRecovery(r.cfg, r.db, rp(r), signersAsker(r), r.body, r.now) }, true, 'approver')
route('POST', '/api/vault/recovery', async (r) => { requireSettled(r, 'recover the vault'); return (await vaultSigners()).finishVaultRecovery(r.cfg, r.db, rp(r), signersAsker(r), r.body, r.now) }, true, 'approver')
// R13 owner options: the guardian (a recovery contact's passkey, behind the delay) and the time-lock (on at once, off
// after the delay); "Require two of your devices" is the thresholds route above at 2 and 2. A guardian's own requests are
// answered in the guardian's session, whatever workspace it has open: they belong to the person, not to a workspace.
route('POST', '/api/vault/signers/guardian', async (r) => { requireSettled(r, 'change the wallet\'s guardian'); return (await vaultSigners()).proposeGuardian(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
route('POST', '/api/vault/signers/time-lock', async (r) => { requireSettled(r, 'change the wallet\'s time-lock'); return (await vaultSigners()).proposeTimeLock(r.cfg, r.db, signersAsker(r), r.body, r.now) }, true, 'admin')
route('GET', '/api/vault/guardian/requests', async (r) => (await vaultSigners()).guardianRequests(r.db, signersAsker(r), r.now), true, 'person')
route('POST', '/api/vault/guardian/requests/:id/cosign/begin', async (r) => { requireSettled(r, 'co-sign a recovery'); return (await vaultSigners()).beginGuardianCosign(r.db, rp(r), signersAsker(r), r.params[0], r.now) }, true, 'person')
route('POST', '/api/vault/guardian/requests/:id/cosign', async (r) => { requireSettled(r, 'co-sign a recovery'); return (await vaultSigners()).finishGuardianCosign(r.cfg, r.db, rp(r), signersAsker(r), r.params[0], r.body, r.now) }, true, 'person')
route('POST', '/api/vault/guardian/requests/:id/decline', async (r) => (await vaultSigners()).declineGuardianCosign(r.db, signersAsker(r), r.params[0], r.now), true, 'person')
// R13 review fix F1: the guardian withdraws a co-signature it gave (cancels that recovery on the chain); protective, so no cool-off
route('POST', '/api/vault/guardian/requests/:id/withdraw/begin', async (r) => (await vaultSigners()).beginGuardianWithdraw(r.cfg, r.db, rp(r), signersAsker(r), r.params[0], r.now), true, 'person')
// R13 H1: a person who may sign for the vault stops a pending co-signed recovery through QED (the sentinel key); protective,
// so no cool-off, but a fresh confirmation with a passkey that is neither suspended nor removed (checked in the function)
route('POST', '/api/vault/recoveries/:id/stop', async (r) => { requireStepUp(r); return (await vaultSigners()).stopVaultRecovery(r.cfg, r.db, signersAsker(r), r.params[0], r.now) }, true, 'approver')
route('POST', '/api/vault/guardian/requests/:id/withdraw', async (r) => (await vaultSigners()).finishGuardianWithdraw(r.cfg, r.db, rp(r), signersAsker(r), r.params[0], r.body, r.now), true, 'person')
// --- end vault signers and recovery (RISK-053) ---

// --- refutation bounties (R11 §9; R10-008, R10-009) ---
// GET /api/bounties: the release's two original 1,000-tUSD bounties as they were stated and recorded (dated, not
// re-verified; D-104), and this installation's local board with the household's claims. A claim is checked, committed,
// revealed and settled through the vault service (server/bounties.ts); each POST takes { key } and returns the vault
// service's job, followed with GET /api/vault/jobs/:id. Nothing here reaches a public network.
const bounties = () => import('./bounties.ts')
const bountyAsker = (r: Req): Asker => ({ workspaceId: r.userId, personId: r.personId, role: r.role, session: r.session })
route('GET', '/api/bounties', async (r) => (await bounties()).bountiesView(r.cfg, r.db, bountyAsker(r)))
route('POST', '/api/bounties/:id/check', async (r) => (await bounties()).checkBountyClaim(r.cfg, r.db, bountyAsker(r), r.params[0]!, r.body))
route('POST', '/api/bounties/:id/claims', async (r) => (await bounties()).submitBountyClaim(r.cfg, r.db, bountyAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/bounties/claims/:id/reveal', async (r) => (await bounties()).revealBountyClaim(r.cfg, r.db, bountyAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/bounties/:id/settle', async (r) => (await bounties()).settleBounty(r.cfg, r.db, bountyAsker(r), r.params[0]!, r.body, r.now))
// --- end refutation bounties ---

// --- earning on the chain (R7-054) ---
// The Earn journey on the chain (server/earn-chain.ts): the same jobs and milestones as GET /api/earn, each milestone one
// job of the release's proof escrow between this workspace's vault and the client's. quote, fund, deliver and release
// return an approval for the vault's passkeys, signed and sent with the vault routes (/api/vault/approvals/:id/sign/begin,
// /sign, /api/vault/proposals/:id/execute); GET /api/earn/chain reads every state back from the vault service first. A
// proof escrow has no acceptance and no dispute: /client answers why and refunds after the deadline. The module is
// loaded here so that every line of this feature stays inside this block.
const earnChain = () => import('./earn-chain.ts')
const earnAsker = (r: Req): Asker => ({ workspaceId: r.userId, personId: r.personId, role: r.role, session: r.session })
route('GET', '/api/earn/chain', async (r) => (await earnChain()).earnChainView(r.cfg, r.db, earnAsker(r), r.now))
route('POST', '/api/earn/chain/problems/preview', async (r) => (await earnChain()).previewChainProblem(r.cfg, r.db, earnAsker(r), r.body))
route('POST', '/api/earn/chain/jobs', async (r) => (await earnChain()).createChainJob(r.cfg, r.db, earnAsker(r), r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/quote', async (r) => (await earnChain()).quoteChainMilestone(r.cfg, r.db, earnAsker(r), r.params[0]!, r.now))
route('POST', '/api/earn/chain/milestones/:id/fund', async (r) => (await earnChain()).fundChainMilestone(r.cfg, r.db, earnAsker(r), r.params[0]!, r.now))
route('POST', '/api/earn/chain/milestones/:id/deliver', async (r) => (await earnChain()).deliverChainMilestone(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/release', async (r) => (await earnChain()).releaseChainMilestone(r.cfg, r.db, earnAsker(r), r.params[0]!, r.now))
route('POST', '/api/earn/chain/milestones/:id/refund', async (r) => (await earnChain()).refundChainMilestone(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/client', async (r) => (await earnChain()).chainClientDecision(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body.decision, r.body, r.now))
// The work directory (R13 E4, server/directory.ts): publish an offer or a request, quote on a request, choose a quote or
// take an offer; choosing creates the job on the provider's side, which then goes through the escrow steps above.
const directory = () => import('./directory.ts')
route('GET', '/api/earn/directory', async (r) => (await directory()).directoryView(r.db, r.userId))
route('POST', '/api/earn/directory/listings', async (r) => { requireSetup(r); return (await directory()).publishListing(r.db, r.userId, r.body, r.now) })
route('POST', '/api/earn/directory/listings/:id/close', async (r) => { (await directory()).closeListing(r.db, r.userId, r.params[0]!, r.now); return { ok: true } })
route('POST', '/api/earn/directory/listings/:id/quotes', async (r) => (await directory()).sendQuote(r.db, r.userId, r.params[0]!, r.body, r.now))
route('POST', '/api/earn/directory/listings/:id/take', async (r) => (await directory()).takeOffer(r.db, r.userId, r.params[0]!, r.now))
route('POST', '/api/earn/directory/quotes/:id/choose', async (r) => (await directory()).chooseQuote(r.db, r.userId, r.params[0]!, r.now))
// The dispute step in front of the proof escrow (R13 E3, server/earn-chain.ts): the client accepts or disputes verified
// work, either side adds evidence, the named decider rules, the provider gives way; each opens a passkey approval of the
// vault service's exact terms. A timeout is applied by anyone once due (no passkey: the dispute escrow lets anyone).
route('POST', '/api/earn/chain/milestones/:id/accept', async (r) => (await earnChain()).acceptChainWork(r.cfg, r.db, earnAsker(r), r.params[0]!, r.now))
route('POST', '/api/earn/chain/milestones/:id/dispute', async (r) => (await earnChain()).disputeChainWork(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/evidence', async (r) => (await earnChain()).addChainEvidence(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/decide', async (r) => (await earnChain()).decideChainDispute(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/earn/chain/milestones/:id/give-way', async (r) => (await earnChain()).giveWayChainWork(r.cfg, r.db, earnAsker(r), r.params[0]!, r.now))
route('POST', '/api/earn/chain/milestones/:id/finish', async (r) => (await earnChain()).finishChainWork(r.cfg, r.db, earnAsker(r), r.params[0]!, r.body, r.now))
// --- end earning on the chain (R7-054) ---

// ------------------------------------------------------------------------------------------------ the on-chain vault
// The approved release's contracts on a local test chain, reached through the chain rail service. See rail.ts.
// Each household's vault is its own workspace of the rail, owned by an account whose signers are its passkeys.
const asker = (r: Req): Asker => ({ workspaceId: r.userId, personId: r.personId, role: r.role, session: r.session })
/**
 * R13: the wallet's revoke-mandate proposal for a revocation that names the chain, through the wallet's own route
 * (rail.ts proposeOnRail): returned for the person to sign; the channel records it. If the wallet's state shows no
 * mandate in force, the channel is answered with that instead. Null when nothing was prepared.
 */
async function prepareChainRevocation(r: Req, revocationId: string): Promise<Record<string, unknown> | null> {
  const v = vaultOf(r.db, r.userId)
  if (!v) return null
  const st = await rail(r.cfg, 'GET', at(v, '/state')).catch(() => null)
  if (!st || st.status !== 200) return null
  const m = st.json.mandate as { version?: number; status?: string; usage?: { perPayment?: { limit?: string }; period?: { limit?: string }; lifetime?: { limit?: string }; validity?: { validUntil?: number } } } | null
  if (!m || m.status !== 'active') { chainNothingToRevoke(r.db, r.userId, revocationId, m ? `its mandate is ${m.status}` : 'it has none', r.now); return null }
  const words = `mandate v${m.version ?? '?'}, valid until ${m.usage?.validity?.validUntil ? new Date(m.usage.validity.validUntil * 1000).toISOString() : 'its end'}`
  const out = await proposeOnRail(r.cfg, r.db, asker(r), 'revoke-mandate', {}, r.now, { revocation: revocationId, remains: 'This ends the wallet\'s one mandate for QED\'s agent: no instruction can pay through the wallet until you sign a new one.' })
  chainPrepared(r.db, r.userId, revocationId, { approvalId: String(out.approvalId), expiresAt: Number(out.expiresAt), mandate: words }, r.now)
  return out
}
// --- ownership transfer and a creditor's release or assignment (R13 S5; server/ownership.ts) ---
// Each opens a passkey approval of the vault service's exact terms; transfer, release and assignment wait the owner
// account's delay on the chain, and a transfer completes only when the other household accepts.
const ownership = () => import('./ownership.ts')
route('GET', '/api/vault/ownership', async (r) => (await ownership()).ownershipView(r.cfg, r.db, asker(r)))
route('POST', '/api/vault/ownership/transfer', async (r) => { requireStepUp(r); return (await ownership()).proposeTransfer(r.cfg, r.db, asker(r), r.body, r.now) }, true, 'owner')
route('POST', '/api/vault/ownership/accept', async (r) => { requireStepUp(r); return (await ownership()).proposeAccept(r.cfg, r.db, asker(r), r.body, r.now) }, true, 'owner')
route('POST', '/api/vault/claims/release', async (r) => { requireStepUp(r); return (await ownership()).proposeRelease(r.cfg, r.db, asker(r), r.body, r.now) }, true, 'owner')
route('POST', '/api/vault/claims/assign', async (r) => { requireStepUp(r); return (await ownership()).proposeAssign(r.cfg, r.db, asker(r), r.body, r.now) }, true, 'owner')
route('POST', '/api/vault/claims/promise', async (r) => { requireStepUp(r); return (await ownership()).proposePromise(r.cfg, r.db, asker(r), r.body, r.now) }, true, 'owner')
// --- end ownership (R13 S5) ---
route('GET', '/api/vault', (r) => railOverview(r.cfg, r.db, rp(r), asker(r)))
// The on-chain wallet in the books (server/chain-books.ts): each test token's balance, each entry with the block's time and
// the time QED entered it, and the last comparison with the wallet service. Comparing again on demand books what is final
// first, stores the comparison and records it in the reconciliation; it never corrects the books.
route('GET', '/api/chain-books', (r) => chainBooksView(r.db, r.userId, r.now))
route('POST', '/api/chain-books/reconcile', async (r) => {
  if (!rateLimit(r.db, `chain-books:${r.userId}`, 60, 3600_000, r.now)) throw new AppError(429, 'too_many', 'That is 60 comparisons in an hour. Wait a while; QED also compares every half minute.')
  const comparison = await compareChainBooks(r.cfg, r.db, r.userId, r.now)
  reconcileUser(r.ctx, r.userId)
  emit(r.db, r.now, r.userId, 'recon', { chain: comparison.state })
  return { comparison, view: chainBooksView(r.db, r.userId, r.now) }
})
// A wallet service now on another chain (its data folder replaced) leaves the books disagreeing for good. The owner can close
// the old chain's books: shown first (nothing changes), then an approval of exactly that preview, confirmed with a passkey,
// then the closing itself: one entry, recorded and audited, never automatic (chain-books.ts closeReplacedChain).
route('GET', '/api/chain-books/closing', async (r) => ({ preview: await closingPreview(r.cfg, r.db, r.userId), closings: chainClosings(r.db, r.userId) }))
route('POST', '/api/chain-books/closing/prepare', (r) => prepareClosing(r.cfg, r.db, r.userId, r.now), true, 'owner')
route('POST', '/api/chain-books/closing', async (r) => {
  const out = await closeReplacedChain(r.cfg, r.db, r.userId, r.personId, str(r.body.approvalId), r.now)
  emit(r.db, r.now, r.userId, 'recon', { chain: 'closed' })
  return out
}, true, 'owner')
// Setting up registers the person's passkeys as the owner account's signers: a fresh passkey confirmation first.
route('POST', '/api/vault/setup', (r) => { requireSettled(r, 'set up a vault'); return railSetup(r.cfg, r.db, rp(r), asker(r), r.body.origin, r.now, { currencies: r.body.currencies, challengeId: r.body.challengeId, response: r.body.response, timeLock: r.body.timeLock }) }, true, 'owner')
// Money-model S5: test tokens other than the default, signed by the owner's passkey before the vault is set up with them.
route('POST', '/api/vault/currencies/begin', (r) => { requireSettled(r, 'set up a vault'); return railCurrenciesBegin(r.db, rp(r), asker(r), r.body.origin, r.body.currencies, r.now) }, true, 'owner')
route('GET', '/api/vault/jobs/:id', (r) => railItem(r.cfg, r.db, asker(r), 'jobs', r.params[0]!))
route('GET', '/api/vault/proposals/:id', (r) => railItem(r.cfg, r.db, asker(r), 'proposals', r.params[0]!))
route('GET', '/api/vault/receipts/:id', (r) => railItem(r.cfg, r.db, asker(r), 'receipts', r.params[0]!))
route('GET', '/api/vault/:name', (r) => railRead(r.cfg, r.db, asker(r), r.params[0]!, r.query))
route('POST', '/api/vault/proposals', (r) => railPropose(r.cfg, r.db, asker(r), r.body, r.now))
// The passkey signs each digest the terms list for the chain (one prompt per digest); see rail.ts.
route('POST', '/api/vault/approvals/:id/sign/begin', (r) => railSignBegin(r.db, rp(r), asker(r), r.params[0]!, r.now))
route('POST', '/api/vault/approvals/:id/sign', (r) => railSignFinish(r.cfg, r.db, rp(r), asker(r), r.params[0]!, r.body.responses, str(r.body.docHash), r.now))
route('POST', '/api/vault/proposals/:id/execute', async (r) => {
  const out = await railExecute(r.cfg, r.db, asker(r), r.params[0]!, str(r.body.approvalId), r.now)
  // the wallet's own "revoke the mandate", given to the chain: a revocation that named the chain now waits for its job (revocation.ts)
  const ap = r.db.get<{ document: string }>(`SELECT document FROM approvals WHERE id = ? AND user_id = ?`, str(r.body.approvalId), r.userId)
  if (ap && (JSON.parse(ap.document) as { action?: string }).action === 'revoke-mandate' && typeof out.jobId === 'string') chainSent(r.db, r.userId, out.jobId, r.now)
  // D-K1b: a raise of the earned caps is a loosening: told at once, and again when it takes effect (rail.ts, vault-watch.ts)
  if (ap && typeof out.jobId === 'string' && !out.duplicate) announceCapsRaise(r.db, asker(r), JSON.parse(ap.document) as { action?: string; terms?: unknown }, out.jobId, r.now)
  return out
})
route('POST', '/api/vault/proposals/:id/cancel', (r) => railCancel(r.cfg, r.db, asker(r), r.params[0]!))
route('POST', '/api/vault/scheduled/:id/apply', (r) => railApplyChange(r.cfg, r.db, asker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/vault/run/policy-tick', (r) => railRun(r.cfg, r.db, asker(r), 'policy/tick', r.body, r.now))
route('POST', '/api/vault/run/policy-run', (r) => railRun(r.cfg, r.db, asker(r), 'policy/run', r.body, r.now))
route('POST', '/api/vault/run/economy', (r) => railRun(r.cfg, r.db, asker(r), 'economies/run', r.body, r.now))
route('POST', '/api/vault/liabilities/:id/settle', (r) => railSettle(r.cfg, r.db, asker(r), r.params[0]!, r.body, r.now))
route('POST', '/api/vault/language/:fn', (r) => railLanguage(r.cfg, r.db, asker(r), r.params[0]!, r.body, r.now))

// ------------------------------------------------------------------------------------------------ proposals
// Ask is a conversation owned by the person asking, in the workspace they act in.
route('POST', '/api/ask', async (r) => { requireSetup(r); return ask(r.ctx, r.cfg, r.userId, r.personId, { question: r.body.question, conversationId: r.body.conversationId, clarification: r.body.clarification, session: r.session.sessionHash }) })
route('GET', '/api/conversations', (r) => ({ conversations: listConversations(r.db, r.userId, r.personId) }))
route('GET', '/api/conversations/:id', (r) => conversationView(r.db, r.userId, r.personId, r.params[0]))
// A request for several things becomes several drafts at once; each is checked as if typed by hand and does nothing until signed.
// another member's proposal is answered as one that does not exist: skipped, "Not found." (lead L-06)
route('POST', '/api/proposals/drafts', (r) => {
  requireSetup(r)
  if (!Array.isArray(r.body.ids)) return draftProposals(r.ctx, r.userId, r.body.ids, r.cfg)
  const ids = r.body.ids as unknown[]
  const hidden = ids.filter((id) => typeof id === 'string' && r.db.get('SELECT 1 FROM proposals WHERE id = ? AND user_id = ?', id, r.userId) && (() => { try { ownProposal(r, id); return false } catch { return true } })()) as string[]
  if (hidden.length && hidden.length === ids.length) return { drafted: [], skipped: hidden.map((proposalId) => ({ proposalId, reason: 'Not found.' })) }
  const out = draftProposals(r.ctx, r.userId, ids.filter((id) => !hidden.includes(id as string)), r.cfg)
  return { ...out, skipped: [...out.skipped, ...hidden.map((proposalId) => ({ proposalId, reason: 'Not found.' }))] }
})
// --- N-006: the registered adviser's review queue (production setting; absent unless QED_ADVISER_REVIEW=1 and
// QED_ADVISER_TOKEN are set). The reviewer is not a workspace member: their credential is a header, not a session.
const reviewer = (r: Req): void => {
  // the credential is checked first and only failures are counted, so wrong guesses from one address are limited
  // without locking the real reviewer out behind a shared proxy address (review finding 7)
  try { requireReviewer(r.cfg, r.req.headers['x-qed-adviser']) } catch (e) {
    if (e instanceof AppError && e.code === 'reviewer_only' && !rateLimit(r.db, `adviser-fail:${r.ip}`, 30, 3600_000, r.now)) throw new AppError(429, 'too_many', 'Too many wrong credentials for the review queue from this address; try again later.')
    throw e
  }
}
route('GET', '/api/adviser/queue', (r) => { reviewer(r); return { queue: reviewQueue(r.db) } }, false)
route('POST', '/api/adviser/reviews/:id', (r) => { reviewer(r); return decideReview(r.db, r.params[0]!, r.body, r.now) }, false)
route('GET', '/api/proposals', (r) => ({ proposals: listProposals(r.db, r.userId, 30, { personId: r.personId, role: r.role }), ai: detectProvider(r.cfg), models: askModels(r), observed: r.db.get('SELECT ts, provider, model, latency_ms FROM ai_calls WHERE user_id = ? AND ok = 1 ORDER BY ts DESC LIMIT 1', r.userId) ?? null }))
/** On the Anthropic API: the models in order, where a question would go now, and the spending limits as they stand for this person and sign-in (server/ask-models.ts). Null on any other provider. */
const askModels = (r: Req) => (detectProvider(r.cfg).provider === 'anthropic-sdk' ? askModelsView(r.db, r.cfg.askModels, modelService(r.cfg.askModels).catalog, { userId: r.userId, personId: r.personId, sessionKey: sessionKeyOf(r.session.sessionHash) }, r.now) : null)
// An Ask proposal of a one-off kind is opened into the same preview and passkey approval a request of the owner's own makes
// (a payment, an order), the payee check, or Grow's idea journey (server/ask-kinds.ts). Nothing is sent from here.
route('POST', '/api/proposals/:id/open', async (r) => { requireSetup(r); return openOneOff(r.ctx, r.userId, r.params[0]!, { personId: r.personId, admin: canAdminister(r.role) }) })
route('POST', '/api/proposals/:id/confirm-payee', (r) => { requireSetup(r); return confirmPayee(r.ctx, r.userId, r.params[0]!, r.body, { personId: r.personId, admin: canAdminister(r.role) }) }, true, 'admin')
route('POST', '/api/proposals/suggest', (r) => { requireSetup(r); return { proposals: ruleSuggestions(r.ctx, r.userId) } })
route('POST', '/api/proposals/:id/dismiss', (r) => { r.db.run(`UPDATE proposals SET state = 'dismissed' WHERE id = ? AND user_id = ?`, ownProposal(r, r.params[0]), r.userId); return { ok: true } })

// --- the Portfolio lab (R12, server/lab.ts) ---
// Reads and pure computations need only membership; opening the lab's mix as a proposal is an operator's step, and
// the instruction it drafts still needs the owner's passkey signature before anything can trade.
const allocPolicy = (v: unknown): AllocPolicy => (typeof v === 'string' && (ALLOC_POLICIES as readonly string[]).includes(v) ? (v as AllocPolicy) : 'equal')
route('GET', '/api/lab', (r) => { requireSetup(r); return labView(r.ctx, r.cfg, r.userId, r.now, allocPolicy(r.query.get('policy'))) })
route('GET', '/api/lab/research', () => labResearch())
route('GET', '/api/lab/certificates', (r) => { requireSetup(r); return labCertificates(r.ctx, r.userId, r.now, { declared: r.query.get('declared') === '1' }) })
// Each check runs on this one thread: twenty a minute for a person, sixty for everyone together (R13 review, R13).
route('POST', '/api/lab/certificates/check', (r) => {
  if (!rateLimit(r.db, `lab-check:${r.personId}`, 20, 60_000, r.now) || !rateLimit(r.db, 'lab-check:all', 60, 60_000, r.now)) throw new AppError(429, 'too_many', 'Too many certificate checks in the last minute. Try again in a minute.')
  return { outcome: checkCertificate(r.body) }
}, true, 'viewer')
route('POST', '/api/lab/hedge', (r) => { requireSetup(r); return hedgeWhatIf(r.ctx, r.body, r.now) }, true, 'viewer')
route('POST', '/api/lab/proposals/rebalance', (r) => { requireSetup(r); return proposeRebalance(r.ctx, r.cfg, r.userId, r.now, allocPolicy(r.body.policy)) })

// --- investment ideas (R13, Grow's central journey; server/ideas.ts) ---
// Reading an idea and investigating it change no money. Going ahead hands the exact order or instruction to the approval
// flows above: nothing is signed or sent here, and the owner's passkey signs what was prepared.
route('POST', '/api/ideas/read', (r) => { requireSetup(r); return readWithAnswers(r.ctx, r.userId, r.body.text, r.body.answers, r.now) }, true, 'viewer')
route('POST', '/api/ideas', async (r) => { requireSetup(r); return createIdea(r.ctx, r.userId, r.body, r.now) })
route('GET', '/api/ideas', (r) => { requireSetup(r); return { ideas: listIdeas(r.db, r.userId) } })
route('GET', '/api/ideas/:id', (r) => { requireSetup(r); return ideaRecord(r.ctx, r.userId, r.params[0]!, r.now) })
route('POST', '/api/ideas/:id/decide', async (r) => { requireSetup(r); return decideIdea(r.ctx, r.userId, r.params[0]!, r.body, r.now) })

// --- evidence cases (Topic F) ---
// Evidence cases assembled from this workspace's own records (server/evidence.ts): the list, one case, and one case as
// a JSON download. Reading needs only membership (viewer). Every read names the workspace the request acts in, and a
// vault job is read through that workspace's own vault, so another workspace's case is "not found", never shown.
// The module is loaded here so that every line of this feature stays inside this block.
const evidenceCases = () => import('./evidence.ts')
const evidenceOptions = async (r: Req) => ({ db: r.db, workspaceId: r.userId, vault: (await evidenceCases()).railSource(r.cfg, r.db, rp(r), asker(r)), now: r.now, ctx: r.ctx, ai: r.cfg, rpId: rp(r).id, reader: { personId: r.personId, role: r.role } })
// R7-098: the release's recorded evidence, read from the vendored release, before any wallet is set up
let historicalCache: unknown = null
route('GET', '/api/evidence/historical', async () => (historicalCache ??= (await import('../chain/rail/historical.ts')).historicalEvidence(join(APP_ROOT, 'chain', 'vendor'))))
route('GET', '/api/evidence/cases', async (r) => (await evidenceCases()).listCases(r.db, r.userId, (await evidenceOptions(r)).vault))
route('GET', '/api/evidence/cases/:id', async (r) => (await evidenceCases()).assembleCase(await evidenceOptions(r), r.params[0]!))
route('GET', '/api/evidence/cases/:id/export', async (r) => {
  const c = await (await evidenceCases()).assembleCase(await evidenceOptions(r), r.params[0]!)
  attachment(r, `qed-evidence-${c.id}.json`)
  return c
})
// --- end evidence cases (Topic F) ---

// --- the judge's walk-through (Topic F, R11-018) ---
// One connected account of the newest decision Ask made for the household's on-chain wallet, from this workspace's own
// records (server/judge.ts). Reads only: the screen acts through the routes above, under their checks, and nothing here
// moves money. Runs recorded earlier with a real model are read from evidence/ and served exactly as recorded, for the
// browser to check. The module is loaded here so that every line of this feature stays inside this block.
const judge = () => import('./judge.ts')
route('GET', '/api/judge', async (r) => (await judge()).judgeIndex({ db: r.db, workspaceId: r.userId, vault: (await evidenceCases()).railSource(r.cfg, r.db, rp(r), asker(r)), now: r.now, presentation: r.cfg.presentation, provider: detectProvider(r.cfg), models: askModels(r), reader: { personId: r.personId, role: r.role } }))
route('GET', '/api/judge/recorded', async () => ({ runs: (await judge()).recordedRuns(join(APP_ROOT, 'evidence')) }))
route('GET', '/api/judge/recorded/:run/cases/:id', async (r) => (await judge()).recordedCase(join(APP_ROOT, 'evidence'), r.params[0]!, r.params[1]!))
// the live run of the 30 original adversarial cases and its diagnosis, where they are kept (docs/research; read only)
route('GET', '/api/judge/adversarial', async () => { const j = await judge(), root = join(APP_ROOT, '..', '..'); return { evaluation: j.adversarialEvaluation(root), rerun: j.adversarialRerun(root) } })
// --- end the judge's walk-through ---

// --- model-proposed wallet actions (N-009) ---
// A proposal from Ask for the on-chain vault (kinds wallet-policy, wallet-pay, wallet-ring-fence) becomes the vault's
// exact terms for the owner's passkey: checked again on the vault's figures now, then proposed through server/rail.ts
// (server/ai.ts draftWalletProposal). The answer is what POST /api/vault/proposals answers, so the vault routes above
// sign it (/api/vault/approvals/:id/sign/begin, /sign) and send it (/api/vault/proposals/:id/execute). Preparing terms
// is an operator's step, as for any vault proposal. The module is loaded here so every line of this feature stays here.
const walletProposals = () => import('./ai.ts')
route('POST', '/api/wallet-proposals/:id/draft', async (r) => { requireSetup(r); return (await walletProposals()).draftWalletProposal(r.cfg, r.db, asker(r), r.params[0]!, r.now) })
// --- end model-proposed wallet actions (N-009) ---

// ------------------------------------------------------------------------------------------------ plumbing

/** The session token from the cookie of this name: `qed_session` locally, `__Host-qed_session` under HTTPS (Config.cookieName). */
function cookieOf(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('=') }
  return undefined
}
function setCookie(r: Req, token: string, expiresAt: number): void {
  r.res.setHeader('Set-Cookie', `${r.cfg.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((expiresAt - r.now) / 1000)}${r.cfg.secureCookies ? '; Secure' : ''}`)
}
/**
 * A sign-in's new session: the session this browser presented, if any, ends first (ASVS 5.0 V7.2.4: a new token on every
 * authentication, and the current one terminated), so a token someone planted or copied before the sign-in opens nothing.
 */
function signedIn(r: Req, token: string, expiresAt: number): void {
  const before = cookieOf(r.req, r.cfg.cookieName)
  if (before) { const who = logout(r.db, before, r.now); if (who) audit(r.db, r.now, who, 'system', 'session.replaced-by-sign-in', who, {}, r.ip) }
  setCookie(r, token, expiresAt)
}
/**
 * A download's name (ASVS 5.0 V5.4.1, V5.4.2): made by the server from its own ids, never from what the request says, and
 * written as RFC 6266 asks: a plain ASCII `filename` with anything else replaced, and the same name percent-encoded in
 * `filename*`, so no character can end the header or start another parameter.
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120) || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name.slice(0, 120)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}
const attachment = (r: Req, name: string): void => { r.res.setHeader('Content-Disposition', contentDisposition(name)) }
/** The CSRF header against the session's token, in constant time (ASVS 5.0 V11.2.4). */
function csrfMatches(header: unknown, expected: string): boolean {
  if (typeof header !== 'string') return false
  const a = Buffer.from(header, 'utf8'), b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
function clearCookie(r: Req): void { r.res.setHeader('Set-Cookie', `${r.cfg.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${r.cfg.secureCookies ? '; Secure' : ''}`) }

/**
 * The client's address, for rate limits and the audit log. Without proxies, the socket's. Behind `hops` reverse proxies
 * that each append the address they received from to X-Forwarded-For, the client's is the hops-th entry from the right;
 * anything to its left was written by the client and is not trusted. Too few entries: the proxies are not as configured,
 * so the socket's address is used (limits then fall on the proxy's address: stricter, never looser for one client).
 */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, hops: number): string {
  const socket = req.socket.remoteAddress ?? 'unknown'
  if (hops <= 0) return socket
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return xff.length >= hops ? xff[xff.length - hops]! : socket
}

/** Plain HTTP (locally, or behind a proxy that ends TLS), or HTTPS from the configured PEM files: TLS 1.2 at least. */
function serve(cfg: Config, handler: RequestListener): Server {
  if (!cfg.tls) return createServer(handler)
  return createHttpsServer({ cert: readFileSync(cfg.tls.certFile), key: readFileSync(cfg.tls.keyFile), minVersion: 'TLSv1.2' }, handler)
}

/**
 * Headers on every response (ASVS 5.0 V3.4). The Content-Security-Policy differs by what the response is:
 *   - API answers (JSON, the event stream, errors) are data, never a document: nothing may load or run (`default-src 'none'`).
 *   - The interface's page (index.html) gets a policy of its own, with a nonce made for that one response (pagePolicy):
 *     a script runs only if it carries the nonce or is imported by one that does (a module's imports inherit its nonce,
 *     HTML's fetch options), so a script element added later without it is blocked, inline or not; not 'strict-dynamic',
 *     which Chrome lets a script element added by any script run (seen in browser/tests/csp.spec.ts), and not 'self',
 *     which the nonce makes unnecessary. Styles only from this origin or with the nonce; no 'unsafe-inline' anywhere (React
 *     sets styles through the CSSOM, which style-src does not govern). Violations are reported to /api/csp-report.
 *   - Other files of the interface (scripts, styles, fonts, images) keep STATIC_POLICY.
 * Permissions-Policy switches off every powerful feature the wallet does not use; passkeys (publickey-credentials-*) stay
 * this origin's own.
 */
const REPORTING = '/api/csp-report'
const API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const STATIC_POLICY = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; report-uri ${REPORTING}`
export const pagePolicy = (nonce: string): string => `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; report-uri ${REPORTING}`
/** Trusted Types, reported and not yet enforced: what would break is measured first (report-only). */
const TRUSTED_TYPES_REPORT = `require-trusted-types-for 'script'; report-uri ${REPORTING}`
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'accelerometer=(), ambient-light-sensor=(), autoplay=(), bluetooth=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=(), xr-spatial-tracking=(), publickey-credentials-create=(self), publickey-credentials-get=(self)',
  'Content-Security-Policy': API_POLICY,
}
/**
 * Reports go to report-uri only. Chrome, given a report-to group as well, sends through the Reporting API instead, in
 * batches up to a minute late; report-uri reports are sent at once, by every current browser.
 */
const FILE_HEADERS: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Security-Policy': STATIC_POLICY }
/** The placeholder the build writes in every nonce attribute of index.html (vite.config.ts html.cspNonce). */
export const NONCE_PLACEHOLDER = 'qedcspnonce0'
function send(res: ServerResponse, status: number, body: unknown): void {
  // the error code, for the refusal log (server/guard.ts), read when the answer is finished
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  if (typeof code === 'string') (res as ServerResponse & { qedCode?: string }).qedCode = code
  const text = JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
/**
 * A successful read's JSON, compressed when the browser accepts it and it is worth it (R11, RISK-086: on the phone
 * profile /api/home, /api/vault and /api/market were 18 to 27 KB each, sent as they were, and crowded the screen's own
 * code on a slow link). Never a response that carries a secret beside data a page can influence (the session and its
 * CSRF token, sign-in and step-up), so a compression side channel (BREACH) has nothing to read.
 */
export function compressibleRead(method: string, pathname: string): boolean {
  return method === 'GET' && !/^\/api\/(session|auth|security\/stepup|events|health|dev)\b/.test(pathname)
}
function sendRead(res: ServerResponse, body: unknown, acceptEncoding: string): void {
  const text = JSON.stringify(body)
  const enc = text.length >= 1024 ? (/\bbr\b/.test(acceptEncoding) ? 'br' : /\bgzip\b/.test(acceptEncoding) ? 'gzip' : null) : null
  if (!enc) return send(res, 200, body)
  const out = enc === 'br' ? brotliCompressSync(text, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(text, { level: 6 })
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': enc, Vary: 'Accept-Encoding', 'Content-Length': out.length })
  res.end(out)
}
function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new AppError(413, 'too_large', 'That request is too large.')); req.destroy() } else chunks.push(c) })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object'); resolve(v as Json) }
      catch { reject(bad('The request body is not valid JSON.')) }
    })
    req.on('error', () => reject(bad('The request could not be read.')))
  })
}

/**
 * The only kinds of file the interface is served as (ASVS 5.0 V13.4.7): a file of any other kind in the build folder is
 * refused (404), never sent as application/octet-stream. Source maps (.map) are not among them (V13.4.2): the build keeps
 * them beside the files, unreferenced (vite.config.ts sourcemap 'hidden'), for a developer to use locally; they are never
 * served. Every text type names its character set (V4.1.1).
 */
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.ttf': 'font/ttf', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json; charset=utf-8' }
/**
 * The built interface is sent compressed when the browser accepts it (Brotli, else gzip): on a phone's link the 1 MB of
 * script and 300 KB of styles are what LCP waits for (R11, the throttled measure: 9.1 s uncompressed). Each file is
 * compressed once per build (keyed by its path, size and modification time) and kept in memory; the folder is small.
 */
const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.webmanifest'])
/** Which encoding a file is sent in: Brotli if accepted, else gzip, for text the browser can decompress; else none. */
export function encodingFor(acceptEncoding: string, file: string): 'br' | 'gzip' | null {
  if (!COMPRESSIBLE.has(extname(file).toLowerCase())) return null
  return /\bbr\b/.test(acceptEncoding) ? 'br' : /\bgzip\b/.test(acceptEncoding) ? 'gzip' : null
}
const packed = new Map<string, Buffer>()
export function compressed(file: string, encoding: 'br' | 'gzip'): Buffer {
  const st = statSync(file)
  const key = `${encoding}:${file}:${st.size}:${st.mtimeMs}`
  let b = packed.get(key)
  if (!b) {
    const raw = readFileSync(file)
    b = encoding === 'br' ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : gzipSync(raw, { level: 9 })
    if (packed.size > 400) packed.clear()
    packed.set(key, b)
  }
  return b
}
function serveStatic(cfg: Config, pathname: string, res: ServerResponse, acceptEncoding = ''): void {
  const root = cfg.webDist
  let rel: string
  // A malformed percent-encoding is the caller's fault: 400, not a thrown URIError, a 500 and a stack trace in the log
  // for every such request (this side is served before the throttle; R13 review, R12).
  try { rel = decodeURIComponent(pathname) } catch { res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Bad request.'); return }
  if (rel.includes('\0')) rel = '/'
  let file = normalize(join(root, rel))
  // Never leave the built interface's folder, whatever the path says.
  if (file !== root && !file.startsWith(root + sep)) file = join(root, 'index.html')
  const notFoundFile = (): void => { res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Not found.') }
  // A file whose kind the interface is not served as (a source map, anything unexpected in the folder) is refused.
  const ext = extname(rel).toLowerCase()
  if (ext === '.map') return notFoundFile()
  if (!existsSync(file) || !statSync(file).isFile()) {
    // A route of the interface gets the page. A missing file does not: answering a script or stylesheet request
    // with the page would hide the fault and leave the screen blank. Only a file type the interface is built from counts
    // as a file: a route whose last part merely contains a dot (an evidence case id, vault.<uuid>) is a route.
    if (MIME[ext] && existsSync(join(root, 'index.html'))) return notFoundFile()
    file = join(root, 'index.html')
  }
  if (!existsSync(file)) { res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('The interface has not been built yet. Run "npm run build", or use "npm run dev".'); return }
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return notFoundFile()
  if (file === join(root, 'index.html')) return servePage(file, res)
  const immutable = file.includes(`${sep}assets${sep}`)
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  const enc = encodingFor(acceptEncoding, file)
  if (enc) {
    const body = compressed(file, enc)
    res.writeHead(200, { ...FILE_HEADERS, 'Content-Type': type, 'Cache-Control': cache, 'Content-Encoding': enc, Vary: 'Accept-Encoding', 'Content-Length': body.length })
    res.end(body)
    return
  }
  res.writeHead(200, { ...FILE_HEADERS, 'Content-Type': type, 'Cache-Control': cache, Vary: 'Accept-Encoding' })
  createReadStream(file).pipe(res)
}

/**
 * The interface's page, with a nonce made for this response alone in every script, style and preload tag the build marked
 * (vite.config.ts html.cspNonce writes NONCE_PLACEHOLDER there and in the csp-nonce meta tag that Vite's own preload helper
 * reads), and the matching policy (pagePolicy). Never stored by the browser or a proxy: the next load has a new nonce. A page
 * built before this (no placeholder) gets the static policy, which also allows no inline script or style.
 */
function servePage(file: string, res: ServerResponse): void {
  const html = readFileSync(file, 'utf8')
  if (!html.includes(NONCE_PLACEHOLDER)) {
    res.writeHead(200, { ...FILE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy-Report-Only': TRUSTED_TYPES_REPORT })
    res.end(html)
    return
  }
  const nonce = randomBytes(18).toString('base64url')
  const body = html.split(NONCE_PLACEHOLDER).join(nonce)
  res.writeHead(200, { ...FILE_HEADERS, 'Content-Security-Policy': pagePolicy(nonce), 'Content-Security-Policy-Report-Only': TRUSTED_TYPES_REPORT, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Where browsers report what the page's Content-Security-Policy blocked (ASVS 5.0 V3.4.7): both report formats
 * (report-uri's application/csp-report and the Reporting API's application/reports+json). Taken before the session, CSRF
 * and JSON checks, because a browser sends a report by itself, with none of the interface's headers. It stores nothing:
 * each report is one `csp-violation` line in the operational log (the directive, and the blocked and reporting addresses
 * without their query strings, server/log.ts), with a limit per address and for everyone, and a body of at most 16 KB.
 */
const reports = { perIp: new Map<string, { t: number; n: number }>(), all: { t: 0, n: 0 } }
export const REPORTS_PER_IP_MINUTE = 30, REPORTS_ALL_MINUTE = 300
function cspReport(req: IncomingMessage, res: ServerResponse, ip: string, now: number): void {
  const done = (status: number): void => { res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }); res.end() }
  const mine = reports.perIp.get(ip)
  if (!mine || now - mine.t >= 60_000) reports.perIp.set(ip, { t: now, n: 0 })
  if (now - reports.all.t >= 60_000) reports.all = { t: now, n: 0 }
  if (reports.perIp.size > 5000) reports.perIp.clear()
  if (++reports.perIp.get(ip)!.n > REPORTS_PER_IP_MINUTE || ++reports.all.n > REPORTS_ALL_MINUTE) { req.resume(); return done(429) }
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/(csp-report|reports\+json|json)\b/.test(type)) { req.resume(); return done(415) }
  const chunks: Buffer[] = []
  let size = 0, over = false
  req.on('data', (c: Buffer) => { size += c.length; if (size > 16 * 1024) { over = true; req.destroy() } else chunks.push(c) })
  req.on('error', () => { if (!res.headersSent) done(400) })
  req.on('end', () => {
    if (over) return done(413)
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return done(400) }
    const list = Array.isArray(parsed) ? parsed.map((x) => (x as { body?: unknown })?.body ?? {}) : [((parsed as { 'csp-report'?: unknown })?.['csp-report'] ?? parsed)]
    for (const b of list.slice(0, 10) as Record<string, unknown>[]) {
      const pick = (...ks: string[]): string => { for (const k of ks) if (typeof b?.[k] === 'string') return (b[k] as string).slice(0, 300); return '' }
      log('api', 'warn', 'csp-violation', { directive: pick('effectiveDirective', 'effective-directive', 'violated-directive'), blocked: pick('blockedURL', 'blocked-uri'), document: pick('documentURL', 'document-uri'), source: pick('sourceFile', 'source-file'), line: typeof b?.lineNumber === 'number' ? b.lineNumber : typeof b?.['line-number'] === 'number' ? b['line-number'] : undefined, disposition: pick('disposition'), ip })
    }
    done(204)
  })
}

// A small in-memory limiter for the whole API, per address. The durable limits (sign-in, questions) are in the database.
const hits = new Map<string, { t: number; n: number }>()
function throttled(ip: string, now: number, perMinute: number): boolean {
  const h = hits.get(ip)
  if (!h || now - h.t > 60_000) { hits.set(ip, { t: now, n: 1 }); return false }
  return ++h.n > perMinute
}

const streams = new Map<string, number>()
/**
 * The live event stream of one session. Each tick first reads the session again and closes the stream once it has
 * ended (signed out, ended from another session, ended by a change of password, lapsed): checked only when it opened,
 * a stream would go on carrying the account's activity to a browser that is no longer signed in (the review of
 * RISK-076's change, L1).
 */
function openStream(ctx: Ctx, userId: string, sessionHash: string, req: IncomingMessage, res: ServerResponse, live: Set<ServerResponse>): void {
  const open = streams.get(userId) ?? 0
  if (open >= 6) { send(res, 429, { error: { code: 'too_many', message: 'Too many live connections for this account.' } }); return }
  streams.set(userId, open + 1)
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  let lastId = ctx.db.get<{ m: number | null }>('SELECT MAX(id) m FROM events')?.m ?? 0
  let lastQuote = ctx.clock.now()
  let beat = 0
  res.write(`event: hello\ndata: ${JSON.stringify({ now: ctx.clock.now() })}\n\n`)
  const timer = setInterval(() => {
    try {
      const now = ctx.clock.now()
      const live = ctx.db.get<{ revoked_at: number | null; expires_at: number; last_seen_at: number }>('SELECT revoked_at, expires_at, last_seen_at FROM sessions WHERE id_hash = ?', sessionHash)
      if (!live || live.revoked_at !== null || now > live.expires_at || now - live.last_seen_at > IDLE_MS) { close(); res.end(); return }
      const evs = ctx.db.all<{ id: number; ts: number; type: string; payload_json: string }>('SELECT id, ts, type, payload_json FROM events WHERE id > ? AND (user_id IS NULL OR user_id = ?) ORDER BY id LIMIT 200', lastId, userId)
      for (const e of evs) { lastId = e.id; res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ts: e.ts, ...parse<Json>(e.payload_json, {}) })}\n\n`) }
      const qs = ctx.db.all<{ instrument_id: string; price_type: string; price: string; source_ts: number | null; recv_ts: number }>('SELECT instrument_id, price_type, price, source_ts, recv_ts FROM quotes WHERE recv_ts > ?', lastQuote)
      if (qs.length) { lastQuote = Math.max(...qs.map((q) => q.recv_ts)); res.write(`event: quotes\ndata: ${JSON.stringify({ now, q: qs.map((q) => [q.instrument_id, q.price_type, q.price, q.source_ts, q.recv_ts]) })}\n\n`) }
      if (++beat % 10 === 0) res.write(`event: beat\ndata: ${JSON.stringify({ now, engine: engineStatus(ctx.db, now) })}\n\n`)
    } catch { /* the next tick tries again */ }
  }, 1000)
  let closed = false
  live.add(res)
  const close = () => { if (closed) return; closed = true; clearInterval(timer); live.delete(res); streams.set(userId, Math.max(0, (streams.get(userId) ?? 1) - 1)) }
  req.on('close', close)
}

/** The probes, answered before sessions and routes (server/probes.ts). A platform's health-check host reaches these only. */
const PROBES = new Set(['/api/live', '/api/ready', '/api/health'])

export interface Api {
  server: Server
  ctx: Ctx
  /** Stop at once: tests, and the local build's old behaviour. */
  close(): void
  /**
   * Stop on SIGTERM (docs/DEPLOY.md, "Graceful shutdown"): stop accepting connections; answer any request that still
   * arrives on an open connection 503 "draining" (readiness says not ready); end the live event streams (the page
   * reconnects to the next process); let requests under way finish for up to `graceMs`; then close every connection and
   * the database. `abandoned` counts requests cut off when the grace ran out: a change either committed in its own
   * transaction or did not, and the interface says so on a lost answer.
   */
  drain(graceMs: number): Promise<{ abandoned: number; waitedMs: number }>
}

export function startApi(cfg: Config): Api {
  configureDelivery(cfg)
  const db = openDb(cfg.dbPath)
  if (cfg.presentation) assertPresentationDb(db)
  seedRegistry(db, { presentation: cfg.presentation })
  const market = new Market(db, systemClock)
  const ctx: Ctx = { db, clock: systemClock, market, venues: buildVenues(db, market, systemClock, cfg.presentation ? syntheticBook : undefined) }
  const allowedOrigins = new Set(cfg.allowedOrigins)
  const live = new Set<ServerResponse>()
  // the API thread's time, per address and per person (lead L-14), and the refusal log and alert (server/guard.ts)
  const meter = new CostMeter(costBudget())
  const refusals = new RefusalMonitor(db)
  const wallet = walletProbe({ dbPath: cfg.dbPath })
  // Ask on the Anthropic API: the models this key may use, read now and every QED_AI_MODELS_REFRESH_MIN (GET /v1/models,
  // which uses no tokens); requests a stopped process left in flight are closed at what was reserved for them.
  const stopModels = detectProvider(cfg).provider === 'anthropic-sdk' ? startModelCatalog(db, cfg.askModels, () => systemClock.now()) : () => {}
  // The two simulated paywalled services agent commerce buys from (commerce-sim.ts): on the loopback address, ports chosen by the system.
  let sim: SimServices | null = null
  void startSimServices(settledPayment(db)).then((s) => { if (!dbOpen) { void s.close(); return } sim = s; setSimServices(s) }).catch(() => { /* commerce then answers 503: the services are not running */ })
  let draining = false
  let inflight = 0

  const server = serve(cfg, (req, res) => {
    inflight++
    let counted = true
    res.once('close', () => { if (counted) { counted = false; inflight-- } })
    let person: string | null = null
    const now0 = systemClock.now(), ip0 = clientIp(req, cfg.trustProxyHops)
    res.once('finish', () => { try { refusals.record(now0, { status: res.statusCode, code: (res as ServerResponse & { qedCode?: string }).qedCode ?? String(res.statusCode), method: req.method ?? 'GET', path: (req.url ?? '/').split('?')[0]!.slice(0, 200), ip: ip0, person }) } catch { /* the log must not fail a request */ } })
    void (async () => {
      const now = now0
      const ip = ip0
      let t0 = 0
      refusals.tick(now)
      // Every response under HTTPS carries HSTS, refusals and redirects included (merged into each writeHead).
      if (cfg.hsts) res.setHeader('Strict-Transport-Security', cfg.hsts)
      try {
        const host = str(req.headers.host)
        if (!cfg.allowedHosts.includes(host)) return send(res, 421, { error: { code: 'wrong_host', message: 'This service answers only on its local address.' } })
        const url = new URL(req.url ?? '/', `http://${host}`)
        const method = req.method ?? 'GET'
        // A platform's health-check host name reaches the probes and nothing else.
        if (cfg.probeHosts.includes(host) && !PROBES.has(url.pathname)) return send(res, 421, { error: { code: 'wrong_host', message: 'This host name answers the health probes only.' } })
        if (draining && url.pathname !== '/api/ready') { res.setHeader('Connection', 'close'); return send(res, 503, { error: { code: 'draining', message: 'QED is restarting. Try again in a moment; nothing was received.' } }) }
        // Passkeys need a domain as relying-party id, so the interface lives at localhost; a page opened at 127.0.0.1 is
        // sent there. API calls are not redirected (a page at the right address never makes them at the wrong one).
        if (host.startsWith('127.0.0.1:') && !url.pathname.startsWith('/api/') && (method === 'GET' || method === 'HEAD')) {
          res.writeHead(308, { Location: `http://localhost:${host.split(':')[1]}${url.pathname}${url.search}` }); res.end(); return
        }
        if (!url.pathname.startsWith('/api/')) {
          if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: { code: 'method', message: 'Not allowed.' } })
          return serveStatic(cfg, url.pathname, res, String(req.headers['accept-encoding'] ?? ''))
        }
        // Browsers report the page's policy violations here by themselves, without the interface's headers (cspReport).
        if (url.pathname === REPORTING && method === 'POST') return cspReport(req, res, ip, now)
        if (throttled(ip, now, cfg.requestsPerMinute)) return send(res, 429, { error: { code: 'too_many', message: 'Too many requests. Wait a moment.' } })
        const costly = (key: string): boolean => {
          const wait = meter.retryAfterMs(key, now)
          if (!wait) return false
          res.setHeader('Retry-After', String(Math.ceil(wait / 1000)))
          send(res, 429, { error: { code: 'too_costly', message: 'QED is busy answering your earlier requests. Wait a minute and try again.' } })
          return true
        }
        if (costly(`ip:${ip}`)) return
        const origin = req.headers.origin
        const site = req.headers['sec-fetch-site']
        if ((typeof origin === 'string' && !allowedOrigins.has(origin)) || (typeof site === 'string' && site !== 'same-origin' && site !== 'none')) return send(res, 403, { error: { code: 'cross_site', message: 'Requests from other sites are refused.' } })

        if (method === 'GET' && url.pathname === '/api/events') {
          const s = sessionFor(db, cookieOf(req, cfg.cookieName), now)
          if (!s) return send(res, 401, { error: { code: 'signed_out', message: 'Sign in to continue.' } })
          return openStream(ctx, s.userId, s.sessionHash, req, res, live)
        }
        if (method === 'GET' && url.pathname === '/api/health') {
          const e = engineStatus(db, now)
          // Under a public origin a stranger sees whether the engine runs, not its process (PRODUCTION.md section 10).
          if (cfg.publicOrigin) return send(res, e.running ? 200 : 503, { ok: e.running, engine: { running: e.running }, now })
          // `interfaces` is how many live interface connections this API holds right now, for any owner. Zero means no page is open.
          recoverStorage(db, now)
          return send(res, e.running ? 200 : 503, { ok: e.running, engine: e, now, interfaces: [...streams.values()].reduce((s, n) => s + n, 0) })
        }
        if (method === 'GET' && url.pathname === '/api/live') return send(res, 200, { live: true, now })
        if (method === 'GET' && url.pathname === '/api/ready') {
          if (draining) res.setHeader('Connection', 'close')
          const r = readinessReport({ db, now, draining, wallet: await wallet(), requireWallet: cfg.readyRequiresWallet })
          return send(res, r.ready ? 200 : 503, cfg.publicOrigin ? publicReport(r) : { ...r, now })
        }

        let match: RegExpExecArray | null = null
        const rt = routes.find((x) => x.method === method && (match = x.re.exec(url.pathname)) !== null)
        if (!rt || !match) return send(res, 404, { error: { code: 'not_found', message: 'There is nothing at that address.' } })
        const changing = method !== 'GET'
        if (changing && Number(req.headers['content-length'] ?? 0) > 0 && !str(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: { code: 'json_only', message: 'Send JSON.' } })
        const session = sessionFor(db, cookieOf(req, cfg.cookieName), now)
        if (rt.auth) {
          if (!session) return send(res, 401, { error: { code: 'signed_out', message: 'Sign in to continue.' } })
          if (changing && !csrfMatches(req.headers['x-qed-csrf'], session.csrf)) return send(res, 403, { error: { code: 'csrf', message: 'This request did not come from the QED interface.' } })
          person = session.userId
          if (costly(`person:${session.userId}`)) return
        } else if (changing && typeof origin !== 'string' && typeof site !== 'string' && str(req.headers['x-qed-client']) !== 'web') {
          // Sign-in and registration carry no session yet; require the interface's own header so a plain form post cannot reach them.
          return send(res, 403, { error: { code: 'csrf', message: 'This request did not come from the QED interface.' } })
        }
        const body = changing ? await readBody(req) : {}
        // The workspace this request acts in: the session's choice if the person is still a member, else their own.
        let workspaceId = session?.userId ?? '', role: Role = 'owner'
        if (session) {
          const m = membership(db, session.workspaceId, session.userId)
          if (m) { workspaceId = session.workspaceId; role = m.role }
          else { workspaceId = session.userId; role = membership(db, session.userId, session.userId)?.role ?? 'owner' }
          if (rt.need !== 'person' && RANK[role] < RANK[rt.need]) return send(res, 403, { error: { code: 'not_permitted', message: `Your role in this workspace (${role}) cannot do this.` } })
        }
        // A member who reads a workspace that is not their own leaves an entry in the access log of the people it belongs to.
        if (session && method === 'GET' && workspaceId !== session.userId && rt.need !== 'person') logMemberRead(db, workspaceId, session.userId, role, url.pathname, now)
        const r: Req = { ctx, cfg, db, now, userId: workspaceId, personId: session?.userId ?? '', role, session: session ?? ({} as Session), body, query: url.searchParams, params: (match as RegExpExecArray).slice(1), ip, req, res }
        // Brief item 2: a request that changes something is one transaction. A synchronous handler runs inside BEGIN
        // IMMEDIATE ... COMMIT, so a failure part-way (a full disk, a refusal after a first write) leaves nothing of it; its
        // rate-limit counts are kept apart and survive the rollback (Db.keep). An async handler keeps its writes in
        // transactions of its own after each wait (isAsync).
        // Everything written for this request reads in the home currency (and counts days in the zone) of the household it acts for
        // (home-currency.ts), and a part of QED that works in rupees only is closed to a household whose home currency is another:
        // refused, never converted.
        if (session && (changing ? RUPEE_ONLY : RUPEE_ONLY_READS).test(url.pathname)) { const home = householdHome(db, workspaceId); if (home !== 'INR') return send(res, 409, { error: { code: 'rupees_only', message: INR_ONLY_REASON(home, 'This part of QED') } }) }
        const call = (): unknown => (session ? withHome(db, workspaceId, () => rt.fn(r)) : rt.fn(r))
        const invoke = (): unknown => (changing && !rt.async ? db.tx(call) : call())
        t0 = performance.now()
        const pending = session ? actor.run({ personId: session.userId, workspaceId, role, authMethod: preparedMethod(session), session: session.sessionHash.slice(0, 12) }, invoke) : invoke()
        const heldMs = performance.now() - t0
        const out = await pending
        const t1 = performance.now()
        if (!res.headersSent) {
          if (compressibleRead(method, url.pathname)) sendRead(res, out ?? { ok: true }, String(req.headers['accept-encoding'] ?? ''))
          else send(res, 200, out ?? { ok: true })
        }
        // the thread's time this request held: its handler's synchronous part and the writing of its answer (lead L-14)
        const cost = heldMs + (performance.now() - t1)
        meter.charge(`ip:${ip}`, now, cost)
        if (session) meter.charge(`person:${session.userId}`, now, cost)
        t0 = 0
      } catch (e) {
        // a refused or failed request held the thread too, until it threw (lead L-14): it is charged the same way
        if (t0) { const cost = performance.now() - t0; meter.charge(`ip:${ip}`, now, cost); if (person) meter.charge(`person:${person}`, now, cost) }
        if (res.headersSent) { res.end(); return }
        // The disk is full or failed: the request was rolled back whole. Say so plainly, and keep a record of the fault.
        const storage = storageErrorKind(e)
        // a fixed event and the route as a field, never the query string (ASVS 5.0 V1.3.10, V16.4.1: no request text in a format string)
        if (storage) { log('api', 'error', 'storage fault', { kind: storage, method: req.method, path: (req.url ?? '/').split('?')[0] }); return send(res, 507, { error: { code: storage === 'full' ? 'storage_full' : 'storage_error', message: apiStorageFailure(db, now, storage, `${req.method} ${(req.url ?? '').split('?')[0]}`) } }) }
        if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message, ...(e.fields ? { fields: e.fields } : {}) } })
        // The route, never the query string or the body; the error's class and message, redacted (server/log.ts).
        log('api', 'error', 'request failed', { method: req.method, path: (req.url ?? '/').split('?')[0], error: e instanceof Error ? e : String(e), stack: e instanceof Error ? e.stack?.split('\n').slice(1, 4).map((l) => l.trim()).join(' < ') : undefined })
        send(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server. Nothing was changed by this request unless the page says otherwise.' } })
      }
    })()
  })
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 10_000
  server.maxHeadersCount = 60
  server.listen(cfg.apiPort, cfg.host)
  let dbOpen = true
  const closeDb = (): void => { if (dbOpen) { dbOpen = false; stopModels(); void sim?.close(); setSimServices(null); db.close() } }
  return {
    server, ctx,
    close: () => { draining = true; server.close(); server.closeAllConnections?.(); closeDb() },
    drain: async (graceMs) => {
      const t0 = performance.now()
      if (!draining) { draining = true; server.close() }
      for (const r of live) { try { r.end() } catch { /* already gone */ } }
      server.closeIdleConnections?.()
      while (inflight > 0 && performance.now() - t0 < graceMs) { await new Promise((r) => setTimeout(r, 25)); server.closeIdleConnections?.() }
      const abandoned = inflight
      server.closeAllConnections?.()
      closeDb()
      return { abandoned, waitedMs: Math.round(performance.now() - t0) }
    },
  }
}

/**
 * When the last of several members signs, the request is carried out here rather than by the screen that prepared it,
 * because the last signer may be anywhere. A request that cannot be carried out any more (its figures changed, it was
 * withdrawn) says so to the signer; the signatures stay on record.
 */
async function completeMultiSigned(r: Req, a: Approval): Promise<void> {
  if (a.purpose === 'action') { submitApprovedAction(r.ctx, r.userId, a.id); return }
  const m = /^program:([^@]+)@\d+$/.exec(a.subject)
  if (a.purpose === 'program-version' && m) { activateProgram(r.ctx, r.userId, m[1]!, a.id) }
  if (a.purpose === 'goal-release') releaseSetAside(r.ctx, r.userId, String((JSON.parse(a.document) as { goalId?: unknown }).goalId ?? ''), a.id)
}

