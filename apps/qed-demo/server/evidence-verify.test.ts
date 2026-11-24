/**
 * Verification of evidence cases (server/evidence-verify.ts): its independent re-implementations pinned to the code
 * they re-implement, a passkey assertion checked as a verifier would, and tampering caught: an amount, a refusal, a hash
 * and the order of records, each by its section hash and, after a forger recomputes every hash, by internal consistency
 * or an anchor. The vault half uses a case recorded by the judge journey on its isolated stack (server/evidence-fixture.ts).
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { hashTerms } from '../chain/terms.ts'
import { ask, draftProposals, viaScript } from './ai.ts'
import { confirmApproval } from './approvals.ts'
import { loadConfig } from './core.ts'
import { assembleCase } from './evidence.ts'
import { approvalChallengeHex, decisionHashOf, type EvidenceCase, partHash, receiptGenesis, receiptHashOf, sealCase, termsHashOf, verifyAssertion, verifyCase, verifyOnChain } from './evidence-verify.ts'
import { changeAmount, dropRefusal, reorderSteps, reseal, swapHash } from './evidence-tamper.ts'
import { RECORDED } from './evidence-fixture.ts'
import { stepAllActions } from './execute.ts'
import { approvalChallenge } from './passkeys.ts'
import { activateProgram, requestProgramApproval, saveDraft } from './programs.ts'
import { genesis, receiptHash, sha256hex } from './receipts.ts'
import { runTick, schedulerTick, triggerTick } from './runner.ts'
import { SoftAuthenticator } from './softauthn.ts'
import { makeKit, type Kit } from './testkit.ts'
import { canonical } from '../shared/sha256.ts'

const REPLIES = join(import.meta.dirname, '..', 'evidence', '20261122-judge-journey', 'scripted-double-replies.json')
type J = Record<string, any>

describe('the verifier\'s own definitions are the server\'s', () => {
  it('receipt chain, approval challenge, terms hash and the vault\'s decision records', () => {
    const body = { what: 'Buy ₹500 of Bitcoin', checks: [{ name: 'within-run-limit', ok: true }], n: 3 }
    expect(receiptGenesis('usr_x')).toBe(genesis('usr_x'))
    expect(receiptHashOf('ab'.repeat(32), body)).toBe(receiptHash('ab'.repeat(32), body))
    expect(approvalChallengeHex('apr_1', 'cd'.repeat(32))).toBe(Buffer.from(approvalChallenge('apr_1', 'cd'.repeat(32))).toString('hex'))
    const terms = { kind: 'policy', chainId: 31337, policy: { targetFree: '10000000', nonce: 'rail-policy-1' }, toSign: [{ digest: `0x${'01'.repeat(32)}`, threshold: 1 }] }
    expect(termsHashOf(terms)).toBe(hashTerms(terms))
    // The vault service wrote these records and their hashes; recomputing them here is the pin.
    const ds = RECORDED.decisions as Parameters<typeof decisionHashOf>[0][]
    expect(ds.length).toBeGreaterThan(2)
    for (const d of ds) expect(decisionHashOf(d)).toBe(d.hash)
  })
  it('a part\'s hash is SHA-256 of shared/sha256.ts canonical JSON, so the interface can recompute it', () => {
    const v = { b: [1, { d: 'x', c: null }], a: '₹' }
    expect(partHash(v)).toBe(createHash('sha256').update(canonical(v)).digest('hex'))
  })
})

describe('a passkey assertion, checked as a verifier would', () => {
  const challenge = sha256hex('qed/approval/v1\napr_test\n' + 'ef'.repeat(32))
  const auth = new SoftAuthenticator({ origin: 'http://localhost:5175' })
  const a = auth.get({ challenge: Buffer.from(challenge, 'hex').toString('base64url') }) as { response: { authenticatorData: string; clientDataJSON: string; signature: string } }
  const entry = { type: 'webauthn-es256' as const, credential: 'sha256:test', publicKey: { x: `0x${auth.x.toString('hex')}`, y: `0x${auth.y.toString('hex')}` }, challenge: `0x${challenge}`, challengeIs: 'approval challenge', authenticatorData: a.response.authenticatorData, clientDataJSON: Buffer.from(a.response.clientDataJSON, 'base64url').toString('utf8'), signature: a.response.signature, rpId: 'localhost' }
  it('verifies over the exact challenge, relying party and user verification', () => { expect(verifyAssertion(entry)).toBeNull() })
  it('refuses another challenge, another key, another relying party, or a changed signature', () => {
    expect(verifyAssertion({ ...entry, challenge: `0x${'00'.repeat(32)}` })).toMatch(/signed the challenge/)
    const other = new SoftAuthenticator({ origin: 'http://localhost:5175' })
    expect(verifyAssertion({ ...entry, publicKey: { x: `0x${other.x.toString('hex')}`, y: `0x${other.y.toString('hex')}` } })).toMatch(/does not verify/)
    expect(verifyAssertion({ ...entry, rpId: 'evil.example' })).toMatch(/another relying party/)
    const sig = Buffer.from(entry.signature, 'base64url'); sig.writeUInt8(sig.readUInt8(sig.length - 1) ^ 1, sig.length - 1)
    expect(verifyAssertion({ ...entry, signature: sig.toString('base64url') })).toMatch(/does not verify/)
  })
  it('the recorded vault signatures of the journey verify, each over a digest its terms list', () => {
    const c = RECORDED.tick as EvidenceCase
    const sigs = (c.sections['1'] as J).instruments.flatMap((i: J) => i.signatures)
    expect(sigs.length).toBeGreaterThanOrEqual(2)
    for (const s of sigs) expect(verifyAssertion(s)).toBeNull()
  })
})

// ------------------------------------------------------------------------------------------------ a paper case, tampered

async function cycle(k: Kit): Promise<void> {
  k.btc(6_600_000)
  schedulerTick(k.ctx); triggerTick(k.ctx); runTick(k.ctx)
  await stepAllActions(k.ctx)
  await k.venues.crypto.tick(); await k.venues.funds.tick(); await k.venues.rail.tick()
  await stepAllActions(k.ctx)
  runTick(k.ctx)
}
describe('tampering with a paper run\'s case', () => {
  let c: EvidenceCase
  beforeAll(async () => {
    const k = makeKit(); k.btc(6_600_000)
    const r = await ask(k.ctx, loadConfig({}), k.userId, k.userId, { question: 'Buy ₹500 of Bitcoin for me every minute, at most 2 times, and never more than ₹1,000 this month.' }, viaScript(REPLIES))
    const programId = draftProposals(k.ctx, k.userId, [r.proposals[0]!.id]).drafted[0]!.programId
    // a model's draft is "ask me each time" (A3/D2); the owner chooses "on its own" before signing
    const v = k.db.get<{ params_json: string; authority_json: string }>('SELECT params_json, authority_json FROM program_versions WHERE program_id = ? ORDER BY version DESC LIMIT 1', programId)!
    saveDraft(k.ctx, k.userId, { programId, params: JSON.parse(v.params_json), authority: { ...JSON.parse(v.authority_json), runMode: 'auto' } })
    const req = requestProgramApproval(k.ctx, k.userId, programId, ['schedule-over-limit'])
    confirmApproval(k.db, k.userId, req.approvalId, { method: 'password', docHash: sha256hex(req.draft.document) }, k.clock.now())
    activateProgram(k.ctx, k.userId, programId, req.approvalId)
    for (let t = 0; t < 150_000; t += 5000) { k.clock.advance(5000); await cycle(k) }
    const second = k.db.all<{ id: string }>(`SELECT id FROM runs WHERE program_id = ? AND state = 'done' ORDER BY due_at`, programId)[1]!
    c = await assembleCase({ db: k.db, workspaceId: k.userId, vault: null, now: k.clock.now(), ctx: k.ctx }, `run.${second.id}`)
  })
  it('as assembled, it verifies', () => { expect(verifyCase(c)).toMatchObject({ ok: true, failures: [] }) })
  it('an amount changed: caught by section 5\'s hash, and after resealing by the ledger\'s entries', () => {
    const t = changeAmount(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 5 \(Balances, costs and consequence\) hash mismatch: stated [0-9a-f]{10}…, computed [0-9a-f]{10}…$/)
    expect(verifyCase(reseal(t.case)).failures).toEqual([expect.stringMatching(/^section 5: paid for Bitcoin in rupees, fee included is \d+, but ledger entry #\d+ move -\d+ in bank$/)])
  })
  it('a receipt\'s hash swapped: caught by section 5\'s hash, and after resealing against the receipt chain', () => {
    const t = swapHash(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 5 .* hash mismatch/)
    expect(verifyCase(reseal(t.case)).failures[0]).toMatch(/^section 5 cites receipt rcp_\w+ as #2 with hash ababababab…, but the chain has #2 with hash [0-9a-f]{10}…$/)
  })
  it('two receipts reordered: caught by the hash of the verification part, and after resealing by the chain\'s order and links', () => {
    const t = reorderSteps(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^verification hash mismatch/)
    const f = verifyCase(reseal(t.case)).failures
    expect(f[0]).toBe('receipt chain: entry 1 has seq 2 (missing or reordered receipts)')
    expect(f).toContain('receipt chain: entry 2 has seq 1 (missing or reordered receipts)')
  })
  it('a check dropped from section 3: after resealing, the receipt in the chain still records it', () => {
    const t = JSON.parse(JSON.stringify(c)) as EvidenceCase
    ;(t.sections['3'] as J).checks = (t.sections['3'] as J).checks.filter((x: J) => x.name !== 'within-month-limit')
    expect(verifyCase(reseal(t)).failures).toEqual([expect.stringMatching(/^receipt rcp_\w+ records the check "within-month-limit" \(passed\), which section 3 leaves out$/)])
  })
  it('a resealed forgery passes alone, but not against an independently obtained root or receipt-chain head', () => {
    const forged = reseal(changeAmount(c)!.case)
    expect(verifyCase(forged, { root: c.hashes.root }).failures).toContain(`the case's root ${forged.hashes.root} is not the anchored root ${c.hashes.root}`)
    const rc = c.verification.receiptChain as J
    expect(verifyCase(c, { head: rc.server.head }).ok).toBe(true)
    expect(verifyCase(c, { head: 'ff'.repeat(32) }).failures[0]).toBe(`the anchored head ${'ff'.repeat(32)} is not in this case's receipt chain`)
  })
  it('a missing section, or a ninth, is named', () => {
    const t = JSON.parse(JSON.stringify(c)) as J
    delete t.sections['7']; t.sections['9'] = {}
    expect(verifyCase(t as EvidenceCase).failures[0]).toBe('missing section 7; unexpected section 9')
  })
})

// ------------------------------------------------------------------------------------------------ a vault case, tampered

describe('tampering with a vault case recorded on the judge journey\'s chain', () => {
  const c = RECORDED.tick as EvidenceCase
  const chain = RECORDED.chain as { chainId: string; receipts: Record<string, J> }
  const rpc = (receipts: Record<string, J>) => async (method: string, params: unknown[]): Promise<unknown> => method === 'eth_chainId' ? chain.chainId : method === 'eth_getTransactionReceipt' ? receipts[String(params[0])] ?? null : null
  it('as recorded, it verifies offline and against the chain\'s own receipt', async () => {
    expect(verifyCase(c)).toMatchObject({ ok: true, failures: [] })
    const on = await verifyOnChain(c, rpc(chain.receipts))
    expect(on.ok).toBe(true)
    expect(on.checks.find((x) => x.check.startsWith('transaction'))?.detail).toMatch(/success in block \d+; from, to and gas agree; \d+ event figures found in its logs/)
  })
  it('an amount changed: caught by its hash; resealed, by the transaction\'s BestExecution event', () => {
    const t = changeAmount(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 5 .* hash mismatch/)
    expect(verifyCase(reseal(t.case)).failures[0]).toMatch(/^section 5: tINR converted from the treasury \(step \d+\) is 25001, but the BestExecution event of transaction 0x[0-9a-f]{8}… records amountIn = 25000$/)
  })
  it('the transaction hash swapped: caught by its hash; resealed, because no step produced it', () => {
    const t = swapHash(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 6 \(Technical record\) hash mismatch/)
    const f = verifyCase(reseal(t.case)).failures.join(' | ')
    expect(f).toMatch(/a transaction 0x[0-9a-f]{8}… recorded in sections 3 or 5 is not in section 6's transactions/)
  })
  it('steps reordered: caught by its hash; resealed, by their sequence', () => {
    const t = reorderSteps(c)!
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 3 \(The independent enforcement decision\) hash mismatch/)
    expect(verifyCase(reseal(t.case)).failures[0]).toMatch(/^section 3: step "\w+" has seq \d+ after seq \d+ \(steps missing or reordered\)$/)
  })
  it('a related refusal dropped from section 8 is caught by the section\'s hash', () => {
    const t = dropRefusal(c)!
    expect(t.what).toMatch(/related refusal/)
    expect(verifyCase(t.case).failures[0]).toMatch(/^section 8 \(Refusals that prevented execution\) hash mismatch/)
  })
  it('a resealed forgery that changes an event\'s figure in both places is caught by the chain', async () => {
    const t = JSON.parse(JSON.stringify(c)) as EvidenceCase
    const tx = (t.sections['6'] as J).transactions[0]
    const be = tx.events.find((e: J) => e.name === 'BestExecution')
    be.args.amountOut = String(BigInt(be.args.amountOut) - 1n)
    for (const m of (t.sections['5'] as J).moved) if (m.evidence?.arg === 'amountOut') m.amount = be.args.amountOut
    const forged = reseal(t)
    expect(verifyCase(forged).ok).toBe(true)
    const on = await verifyOnChain(forged, rpc(chain.receipts))
    expect(on.failures[0]).toMatch(/^transaction 0x[0-9a-f]{8}… on chain: no log of 0x[0-9a-fA-F]{8}… carries the BestExecution figures/)
  })
  it('a receipt the chain does not have, or a different block, is named', async () => {
    expect((await verifyOnChain(c, rpc({}))).failures[0]).toMatch(/^the chain has no receipt for transaction 0x/)
    const h = Object.keys(chain.receipts)[0]!
    const moved = { ...chain.receipts, [h]: { ...chain.receipts[h], blockNumber: '0x1' } }
    expect((await verifyOnChain(c, rpc(moved))).failures[0]).toMatch(/block 1, recorded \d+/)
  })
  it('sealing is deterministic: the same content gives the same root', () => {
    expect(sealCase(c).hashes.root).toBe(c.hashes.root)
  })
})
