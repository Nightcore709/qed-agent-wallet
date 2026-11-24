/**
 * Receipts: one hash-chained record per finished action, refusal or authority change. Each receipt's hash covers its
 * own body and the previous receipt's hash, so a later edit or deletion anywhere in the chain is detectable.
 * The same canonical form and SHA-256 are implemented in the browser (shared/sha256.ts), so a reader can re-verify
 * a receipt without trusting this server.
 */
import { createHash } from 'node:crypto'
import { type Db, emit, j, newId, parse } from './core.ts'
import { canonical } from '../shared/sha256.ts'

export const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
export const genesis = (userId: string): string => sha256hex(`qed-receipts-v1:${userId}`)
export const receiptHash = (prev: string, body: unknown): string => sha256hex(`${prev}\n${canonical(body)}`)

export interface Receipt { id: string; seq: number; ts: number; kind: string; subject: string; body: Record<string, unknown>; prev_hash: string; hash: string }

export function issueReceipt(db: Db, userId: string, kind: string, subject: string, body: Record<string, unknown>, now: number): Receipt {
  return db.tx(() => {
    const last = db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM receipts WHERE user_id = ? ORDER BY seq DESC LIMIT 1', userId)
    const seq = (last?.seq ?? 0) + 1
    const prev = last?.hash ?? genesis(userId)
    const id = newId('rcp', now)
    const full = { ...body, receipt: { id, seq, kind, subject, issuedAt: now, execution: 'paper: no real money moved' } }
    const hash = receiptHash(prev, full)
    db.run('INSERT INTO receipts (id, user_id, seq, ts, kind, subject, body_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, userId, seq, now, kind, subject, j(full), prev, hash)
    emit(db, now, userId, 'receipt', { id, seq, kind, subject })
    return { id, seq, ts: now, kind, subject, body: full, prev_hash: prev, hash }
  })
}

export function listReceipts(db: Db, userId: string, limit = 100, beforeSeq = Number.MAX_SAFE_INTEGER): Receipt[] {
  return db.all<Record<string, unknown>>('SELECT * FROM receipts WHERE user_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', userId, beforeSeq, Math.min(Math.max(limit, 1), 500)).map(row)
}
export function getReceipt(db: Db, userId: string, id: string): Receipt | undefined {
  const r = db.get<Record<string, unknown>>('SELECT * FROM receipts WHERE user_id = ? AND id = ?', userId, id)
  return r ? row(r) : undefined
}
const row = (r: Record<string, unknown>): Receipt => ({ id: String(r.id), seq: Number(r.seq), ts: Number(r.ts), kind: String(r.kind), subject: String(r.subject), body: parse<Record<string, unknown>>(r.body_json, {}), prev_hash: String(r.prev_hash), hash: String(r.hash) })

/** Recompute the whole chain for one user. */
export function verifyChain(db: Db, userId: string): { ok: boolean; count: number; brokenAt: number | null; head: string } {
  let prev = genesis(userId)
  let expect = 1
  const rows = db.all<{ seq: number; body_json: string; prev_hash: string; hash: string }>('SELECT seq, body_json, prev_hash, hash FROM receipts WHERE user_id = ? ORDER BY seq', userId)
  for (const r of rows) {
    if (r.seq !== expect || r.prev_hash !== prev || receiptHash(prev, JSON.parse(r.body_json)) !== r.hash) return { ok: false, count: rows.length, brokenAt: r.seq, head: prev }
    prev = r.hash
    expect++
  }
  return { ok: true, count: rows.length, brokenAt: null, head: prev }
}
