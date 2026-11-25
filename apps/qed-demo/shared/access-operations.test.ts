/**
 * The five operations of account access and what each proof may do by itself (R14, Priority 1). The table is the one
 * place the server's words and the screens read from; these checks hold the owner's rule: a password, Google, an email
 * code or a signed-in session never approves money and never becomes authority over the wallet.
 */
import { describe, expect, it } from 'vitest'
import { GRANTS, OPERATIONS, ORDINARY_PROOFS, PROOFS, can, operationWords } from './access-operations.ts'

describe('the five operations of account access', () => {
  it('names five, in the owner\'s order, each with words of its own', () => {
    expect(OPERATIONS.map((o) => o.id)).toEqual(['enter', 'enrol-device', 'approve', 'recover-access', 'recover-wallet'])
    const titles = OPERATIONS.map((o) => o.title)
    expect(new Set(titles).size).toBe(5)
    for (const o of OPERATIONS) { expect(o.plain.length).toBeGreaterThan(40); expect(operationWords(o.id)).toBe(o) }
  })

  it('has an answer for every proof and operation', () => {
    for (const p of PROOFS) for (const o of OPERATIONS) expect(['yes', 'limited', 'no']).toContain(GRANTS[p.id][o.id].grant)
  })

  it('a password, Google, an email code and a signed-in session never approve and never recover wallet authority', () => {
    expect(ORDINARY_PROOFS).toEqual(['password', 'google', 'email-code', 'session'])
    for (const p of ORDINARY_PROOFS) {
      expect(can(p, 'approve')).toBe('no')
      expect(can(p, 'recover-wallet')).toBe('no')
    }
  })

  it('only a device with approval authority approves; a saved code and a device a recovery added do not', () => {
    for (const p of PROOFS) expect(can(p.id, 'approve')).toBe(p.id === 'device' ? 'yes' : 'no')
    expect(can('saved-code', 'recover-wallet')).toBe('no')
    expect(can('recovered-device', 'recover-wallet')).toBe('limited')
  })

  it('no single ordinary proof recovers access alone: each is at most one part of it', () => {
    for (const p of [...ORDINARY_PROOFS, 'saved-code'] as const) expect(can(p, 'recover-access')).not.toBe('yes')
  })

  it('an email code never enters the account, and a session never enrols a device by itself', () => {
    expect(can('email-code', 'enter')).toBe('no')
    expect(can('session', 'enrol-device')).toBe('no')
    expect(can('email-code', 'enrol-device')).toBe('no')
    // a password or Google, typed or confirmed again, enrols only the account's first device
    expect(GRANTS.password['enrol-device']).toMatchObject({ grant: 'limited' })
    expect(GRANTS.google['enrol-device']).toMatchObject({ grant: 'limited' })
  })
})
