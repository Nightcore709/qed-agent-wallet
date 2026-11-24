/**
 * Adding a payee runs the paper bank's name check before the payee is saved (R12 task comparison, gap 4). A match is added
 * at once. A close match, no match or could not check is shown and needs the owner's own confirmation, the same one a
 * look-alike needs ("I checked this address with the payee myself, not from a message or a call"), given for exactly the
 * answer shown: the server refuses a confirmation of another answer. On a close match the owner may take the name the
 * paper bank holds instead, which is then a match. The answer is kept with the payee and audited.
 */
import { describe, expect, it } from 'vitest'
import { addPayee, checkNewPayee } from './owner.ts'
import { makeKit } from './testkit.ts'

const payeeRow = (k: ReturnType<typeof makeKit>, handle: string) => k.db.get<{ name: string; name_check: string | null; registered_name: string | null }>('SELECT name, name_check, registered_name FROM payees WHERE user_id = ? AND handle = ?', k.userId, handle)
const audited = (k: ReturnType<typeof makeKit>) => k.db.all<{ detail_json: string }>(`SELECT detail_json FROM audit WHERE user_id = ? AND action = 'payee.add' ORDER BY id`, k.userId).map((r) => JSON.parse(r.detail_json) as Record<string, unknown>)

describe('the name check when a payee is added', () => {
  it('a match is added at once, with the name the paper bank holds kept beside it', () => {
    const k = makeKit()
    addPayee(k.db, k.userId, { name: 'ravi kumar', handle: 'ravi.kumar@upi', category: 'family' }, k.clock.now())
    expect(payeeRow(k, 'ravi.kumar@upi')).toEqual({ name: 'ravi kumar', name_check: 'match', registered_name: 'Ravi Kumar' })
    expect(audited(k).at(-1)).toMatchObject({ handle: 'ravi.kumar@upi', nameCheck: 'match' })
  })

  for (const [what, name, handle, outcome, registered] of [
    ['a close match', 'Ravi Kumaar', 'ravi.kumar@upi', 'close', 'Ravi Kumar'],
    ['no match', 'Safe Account Services', 'ravi.kumar@upi', 'no_match', null],
    ['an address the paper bank does not know', 'Corner Shop', 'corner.shop@upi', 'unknown', null],
    ['a check that does not answer', 'Anyone', 'nocheck@paper', 'no_answer', null],
  ] as const) {
    it(`${what} is shown and not saved until the owner confirms that answer`, () => {
      const k = makeKit()
      let err: { code?: string; message?: string; fields?: Record<string, string> } = {}
      try { addPayee(k.db, k.userId, { name, handle, category: 'other' }, k.clock.now()) } catch (e) { err = e as typeof err }
      expect(err.code).toBe('payee_check')
      expect(err.fields).toEqual({ nameCheck: outcome, ...(registered ? { registeredName: registered } : {}) })
      expect(err.message).toMatch(/paper bank/)
      expect(payeeRow(k, handle)).toBeUndefined()
      // a confirmation of another answer than the one shown is refused: it never covers something not shown
      const other = outcome === 'unknown' ? 'no_match' : 'unknown'
      expect(() => addPayee(k.db, k.userId, { name, handle, category: 'other', nameCheckAccepted: other }, k.clock.now())).toThrow(expect.objectContaining({ code: 'payee_check' }))
      expect(() => addPayee(k.db, k.userId, { name, handle, category: 'other', nameCheckAccepted: true }, k.clock.now())).toThrow(expect.objectContaining({ code: 'payee_check' }))
      addPayee(k.db, k.userId, { name, handle, category: 'other', nameCheckAccepted: outcome }, k.clock.now())
      expect(payeeRow(k, handle)).toEqual({ name, name_check: outcome, registered_name: registered })
      expect(audited(k).at(-1)).toMatchObject({ nameCheck: outcome, nameCheckConfirmed: true })
    })
  }

  it('on a close match the name the paper bank holds can be taken instead, which is a match and needs no confirmation', () => {
    const k = makeKit()
    let err: { fields?: Record<string, string> } = {}
    try { addPayee(k.db, k.userId, { name: 'R. Kumar', handle: 'ravi.kumar@upi' }, k.clock.now()) } catch (e) { err = e as typeof err }
    expect(err.fields?.registeredName).toBe('Ravi Kumar')
    addPayee(k.db, k.userId, { name: err.fields!.registeredName, handle: 'ravi.kumar@upi' }, k.clock.now())
    expect(payeeRow(k, 'ravi.kumar@upi')).toEqual({ name: 'Ravi Kumar', name_check: 'match', registered_name: 'Ravi Kumar' })
  })

  it('a look-alike that the paper bank also cannot check shows both, and needs both confirmed', () => {
    const k = makeKit()
    addPayee(k.db, k.userId, { name: 'BESCOM Electricity', handle: 'bescom.power@okaxis', category: 'utilities' }, k.clock.now())
    const fake = { name: 'BЕSCOМ Electricity', handle: 'bescom.power@okaxls', category: 'utilities' }
    let err: { code?: string; message?: string; fields?: Record<string, string> } = {}
    try { addPayee(k.db, k.userId, fake, k.clock.now()) } catch (e) { err = e as typeof err }
    expect(err.code).toBe('lookalike')
    expect(err.message).toMatch(/looks like one you already have: BESCOM Electricity \(bescom\.power@okaxis\)/)
    expect(err.fields).toMatchObject({ nameCheck: 'unknown', lookalike: expect.stringMatching(/looks like one you already have/) })
    expect(() => addPayee(k.db, k.userId, { ...fake, lookalikeChecked: true }, k.clock.now())).toThrow(expect.objectContaining({ code: 'payee_check' }))
    expect(() => addPayee(k.db, k.userId, { ...fake, nameCheckAccepted: 'unknown' }, k.clock.now())).toThrow(expect.objectContaining({ code: 'lookalike' }))
    addPayee(k.db, k.userId, { ...fake, lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())
    expect(payeeRow(k, 'bescom.power@okaxls')).toMatchObject({ name_check: 'unknown' })
    // the real one, which the paper bank knows, was a match and was added at once
    expect(payeeRow(k, 'bescom.power@okaxis')).toMatchObject({ name_check: 'match', registered_name: 'BESCOM Electricity' })
  })
})

describe('asking first, without saving (POST /api/payees/check)', () => {
  it('answers what adding would need confirmed, saves nothing, and an answer that needs nothing can be added at once', () => {
    const k = makeKit()
    expect(checkNewPayee(k.db, k.userId, { name: 'Ravi Kumaar', handle: 'ravi.kumar@upi' })).toEqual({ nameCheck: { outcome: 'close', registeredName: 'Ravi Kumar', message: expect.stringMatching(/^The paper bank holds a slightly different name for ravi\.kumar@upi: Ravi Kumar, not Ravi Kumaar\./) }, lookalike: null, needsConfirmation: true })
    expect(checkNewPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi' })).toEqual({ nameCheck: { outcome: 'match', registeredName: 'Ravi Kumar', message: null }, lookalike: null, needsConfirmation: false })
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM payees')!.n).toBe(0)
    addPayee(k.db, k.userId, { name: 'BESCOM Electricity', handle: 'bescom.power@okaxis' }, k.clock.now())
    const look = checkNewPayee(k.db, k.userId, { name: 'BЕSCOМ Electricity', handle: 'bescom.power@okaxls' })
    expect(look).toMatchObject({ nameCheck: { outcome: 'unknown', registeredName: null }, lookalike: expect.stringMatching(/looks like one you already have/), needsConfirmation: true })
  })
  it('checks the fields as adding does, and says when the address is already a payee', () => {
    const k = makeKit()
    expect(() => checkNewPayee(k.db, k.userId, { name: 'R', handle: 'not an address' })).toThrow(expect.objectContaining({ code: 'invalid', fields: { name: 'Enter the payee\'s name.', handle: 'Enter a payment address such as name@bank.' } }))
    addPayee(k.db, k.userId, { name: 'Ravi Kumar', handle: 'ravi.kumar@upi' }, k.clock.now())
    expect(() => checkNewPayee(k.db, k.userId, { name: 'Ravi', handle: 'ravi.kumar@upi' })).toThrow(expect.objectContaining({ code: 'exists' }))
  })
})
