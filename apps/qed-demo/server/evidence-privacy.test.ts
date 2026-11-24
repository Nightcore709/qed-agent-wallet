/**
 * A question to Ask is its asker's (RISK-070, claims review F13). The Ask page lists only one's own conversations, and
 * an evidence case now keeps to the same rule: shown to another member of the workspace below admin, the question,
 * the earlier turns and the model's reply are replaced by their SHA-256, with who may read them. The asker, the owner
 * and admins read them in full. QED's own checks of the proposals stay visible to everyone in the workspace.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ask, listProposals, viaScript } from './ai.ts'
import { loadConfig } from './core.ts'
import { assembleCase } from './evidence.ts'
import { sha256hex } from './receipts.ts'
import { makeKit } from './testkit.ts'
import type { Role } from './workspaces.ts'

type J = Record<string, any>
const REPLIES = join(import.meta.dirname, '..', 'evidence', '20261122-judge-journey', 'scripted-double-replies.json')
const Q = 'Buy ₹500 of Bitcoin for me every minute, at most 2 times, and never more than ₹1,000 this month.'

async function setup() {
  const k = makeKit(); k.btc(6_600_000)
  const now = k.clock.now()
  for (const [id, role] of [['per_op', 'operator'], ['per_view', 'viewer'], ['per_admin', 'admin'], ['per_appr', 'approver']] as [string, Role][]) {
    k.db.run('INSERT INTO users (id, handle, display_name, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, id, `Person ${id}`, '!', now)
    k.db.run('INSERT INTO memberships (workspace_id, person_id, role, created_at) VALUES (?, ?, ?, ?)', k.userId, id, role, now)
  }
  // the operator asks; the case is then read by each member in turn
  const r = await ask(k.ctx, loadConfig({}), k.userId, 'per_op', { question: Q }, viaScript(REPLIES))
  const callId = k.db.get<{ id: string }>('SELECT id FROM ai_calls WHERE conversation_id = ?', r.conversationId)!.id
  const answer = String((JSON.parse(k.db.get<{ output_json: string }>('SELECT output_json FROM ai_calls WHERE id = ?', callId)!.output_json) as J).answer)
  expect(answer.length).toBeGreaterThan(20)
  const read = async (personId: string, role: Role): Promise<J> => assembleCase({ db: k.db, workspaceId: k.userId, vault: null, now: k.clock.now(), reader: { personId, role } }, `ask.${callId}`) as Promise<J>
  return { k, callId, read, answer }
}

describe('another member\'s question to Ask in an evidence case (RISK-070)', () => {
  it('a viewer and an approver who did not ask see the question and the reply as hashes only, with who may read them', async () => {
    const { read, answer } = await setup()
    for (const [who, role] of [['per_view', 'viewer'], ['per_appr', 'approver']] as [string, Role][]) {
      const c = await read(who, role)
      const text = JSON.stringify(c)
      // the question and the model's own words are gone; QED's title for the proposal stays, as /api/proposals shows it
      expect(text).not.toContain(Q)
      expect(text).not.toContain(answer)
      expect(c.sections[1].objective.text).toMatch(/asked by another member of this workspace/i)
      expect(c.sections[2].sent.questionSha256).toBe(sha256hex(Q))
      expect(c.sections[2].sent.question).toBeUndefined()
      expect(c.sections[2].output).toMatchObject({ withheld: true })
      expect(c.sections[2].withheld).toMatch(/the member who asked it, and the workspace's owners and admins/)
      // what QED made of the reply stays, as states only: no model-written title, and no warning that quotes the
      // owner's own figures (review finding 5)
      expect(c.sections[2].validation.length).toBeGreaterThan(0)
      for (const v of c.sections[2].validation) { expect(v.title).toBeUndefined(); expect(v.warnings).toBeUndefined() }
      expect(text).not.toMatch(/You wrote/)
    }
  })

  it('the proposals list shows a member below admin only proposals from their own conversations and QED\'s own suggestions (review finding 5)', async () => {
    const { k } = await setup()
    const ids = (personId: string, role: Role) => listProposals(k.db, k.userId, 30, { personId, role }).map((p) => p.id)
    const all = listProposals(k.db, k.userId, 30).map((p) => p.id)
    expect(all.length).toBeGreaterThan(0)
    expect(ids('per_view', 'viewer')).toEqual([])
    expect(ids('per_appr', 'approver')).toEqual([])
    expect(ids('per_op', 'operator')).toEqual(all)
    expect(ids('per_admin', 'admin')).toEqual(all)
  })

  it('the asker, an admin and the owner read the question and the reply in full', async () => {
    const { k, read } = await setup()
    for (const [who, role] of [['per_op', 'operator'], ['per_admin', 'admin'], [k.userId, 'owner']] as [string, Role][]) {
      const c = await read(who, role)
      expect(c.sections[1].objective.text).toBe(Q)
      expect(c.sections[2].sent.question).toBe(Q)
      expect(c.sections[2].output).not.toMatchObject({ withheld: true })
    }
  })
})
