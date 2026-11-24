/**
 * A child process for server/engine-lock.test.ts: one engine on a database file, in a process of its own, so that a test
 * can kill it outright (SIGKILL, as a crash, a power cut or a replaced container would) and start another engine.
 *
 *   node server/engine-fixture.ts <database> hold             start an engine and keep it running
 *   node server/engine-fixture.ts <database> pay-unanswered   also open a household and send a payment the paper rail
 *                                                              does not answer for two minutes (test payee timeout@paper)
 *
 * Prints one line on stdout: "ready" (with the payment's action id) once the state is reached, "locked" if the engine
 * was refused because another holds the database. No market data provider is contacted (live: false). Test use only.
 */
import { confirmApproval, createApproval } from './approvals.ts'
import { Engine, EngineLocked } from './engine.ts'
import { createAction, getAction } from './execute.ts'
import { DEFAULT_OPENING, openHousehold } from './household.ts'

const dbPath = process.argv[2]
const mode = process.argv[3] ?? 'hold'
if (!dbPath) { process.stdout.write('error no database given\n'); process.exit(2) }

const engine = new Engine({ dbPath }, { live: false })
try { engine.start() } catch (e) {
  process.stdout.write(e instanceof EngineLocked ? 'locked\n' : `error ${e instanceof Error ? e.message : String(e)}\n`)
  process.exit(3)
}

if (mode === 'pay-unanswered') {
  const now = Date.now(), userId = 'usr_fixture'
  engine.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, 'fixture', 'Fixture Owner', 'x', now)
  openHousehold(engine.db, userId, DEFAULT_OPENING, {}, now)
  const ap = createApproval(engine.db, userId, { purpose: 'action', subject: 'action:unanswered', document: 'Pay the test payee that does not answer', requiresStepUp: false }, now)
  confirmApproval(engine.db, userId, ap.id, { method: 'session', docHash: ap.doc_hash }, now)
  const act = createAction(engine.ctx, { userId, origin: 'owner', kind: 'payment', venue: 'paper-rail', economicId: 'unanswered', params: { payeeHandle: 'timeout@paper', payeeName: 'Test timeout', amount: '100000', purpose: 'spend' }, approvalId: ap.id })
  // The engine's own ticks (every second) plan, reserve and submit it; the rail then gives no answer.
  const wait = setInterval(() => {
    const a = getAction(engine.db, act.id)
    if (a?.state === 'working' && a.result.railState === 'unknown') { clearInterval(wait); process.stdout.write(`ready ${act.id}\n`) }
  }, 50)
} else process.stdout.write('ready\n')

process.on('SIGTERM', () => { engine.stop(); process.exit(0) })
