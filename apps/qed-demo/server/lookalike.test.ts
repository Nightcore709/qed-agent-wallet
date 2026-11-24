/**
 * Look-alike payees (adversarial corpus X01, RISK-073): a payee that imitates another of the owner's payees is caught
 * when it is added (the owner must confirm they checked it), and every payment or instruction that would pay it says
 * what it looks like, in the document the owner signs.
 */
import { describe, expect, it } from 'vitest'
import { addPayee, previewAction } from './owner.ts'
import { buildDraft, requestProgramApproval, saveDraft } from './programs.ts'
import { addWarning, distance, lookalikes, lookalikeWarning, mixedScript, skeleton } from './lookalike.ts'
import { makeKit } from './testkit.ts'

const REAL = { name: 'BESCOM Electricity', handle: 'bescom.power@okaxis' }
const FAKE = { name: 'BЕSCOМ Electricity', handle: 'bescom.power@okaxls' } // Cyrillic Е and М; l for i

describe('look-alike names and addresses', () => {
  it('a name written with Cyrillic letters has the Latin name\'s skeleton, and is marked as mixing alphabets', () => {
    expect(FAKE.name).not.toBe(REAL.name)
    expect(skeleton(FAKE.name)).toBe(skeleton(REAL.name))
    expect(mixedScript(FAKE.name)).toBe(true)
    expect(mixedScript(REAL.name)).toBe(false)
    expect(mixedScript('राम Electricals')).toBe(false) // two alphabets in two words is an ordinary name
  })

  it('digits for letters, rn for m, accents and invisible characters do not hide a look-alike', () => {
    expect(skeleton('paytm.bi11s')).toBe(skeleton('paytm.bills'))
    expect(skeleton('0kaxis')).toBe(skeleton('okaxis'))
    expect(skeleton('rnobile')).toBe(skeleton('mobile'))
    expect(skeleton('Méera​Nair')).toBe(skeleton('Meera Nair'))
  })

  it('edit distance counts a swap of two neighbours as one', () => {
    expect(distance('okaxis', 'okaxls')).toBe(1)
    expect(distance('okaxis', 'okaixs')).toBe(1)
    expect(distance('amma@upi', 'appa@upi')).toBe(2)
  })

  it('the homoglyph payee resembles the real one, with both reasons', () => {
    const [s] = lookalikes(FAKE, [REAL, { name: 'Sunrise Apartments', handle: 'sunrise.rent@okhdfc' }])
    expect(s).toMatchObject({ handle: REAL.handle })
    expect(s!.why.join(' ')).toMatch(/letters from another alphabet/)
    expect(s!.why.join(' ')).toMatch(/its address looks the same, written with look-alike characters \(bescom\.power@okaxls, not bescom\.power@okaxis\)/)
    expect(lookalikeWarning(FAKE, [REAL])).toMatch(/^BЕSCOМ Electricity \(bescom\.power@okaxls\) looks like BESCOM Electricity \(bescom\.power@okaxis\), another of your payees/)
  })

  it('the same name at another bank, or the same address in look-alike characters, is caught', () => {
    expect(lookalikes({ name: 'BESCOM', handle: 'bescom.power@ybl' }, [REAL])[0]!.why.join(' ')).toMatch(/same name at a different bank \(@ybl, not @okaxis\)/)
    expect(lookalikes({ name: 'Bills', handle: 'bescom.p0wer@0kaxis' }, [REAL])[0]!.why.join(' ')).toMatch(/address looks the same/)
    expect(lookalikes({ name: 'BESCOM Electricity', handle: 'payments@bescom' }, [REAL])[0]!.why).toEqual(['it has the same name, at a different address'])
  })

  it('an all-capitals name, a name one letter off and nearly the same address at another bank are caught (review finding 4)', () => {
    expect(skeleton('BESCOM ELECTRICITY')).toBe(skeleton('BESCOM Electricity'))
    expect(lookalikes({ name: 'BESCOM ELECTRICITY', handle: 'payments@bescom' }, [REAL])[0]!.why).toEqual(['it has the same name, at a different address'])
    const [near] = lookalikes({ name: 'Sunrise Apartment', handle: 'sunrise.rents@ybl' }, [{ name: 'Sunrise Apartments', handle: 'sunrise.rent@okhdfc' }])
    expect(near!.why.join(' ')).toMatch(/its name differs by one character/)
    expect(near!.why.join(' ')).toMatch(/its address has nearly the same name at a different bank \(@ybl, not @okhdfc\)/)
  })

  it('unrelated payees and short addresses two letters apart are left alone', () => {
    expect(lookalikes({ name: 'Asha Rao', handle: 'asha.rao@okhdfc' }, [REAL])).toEqual([])
    expect(lookalikes({ name: 'Appa', handle: 'appa@upi' }, [{ name: 'Amma', handle: 'amma@upi' }])).toEqual([])
    expect(addWarning({ name: 'Asha Rao', handle: 'asha.rao@okhdfc' }, [REAL])).toBeNull()
  })
})

describe('where the owner meets a look-alike payee', () => {
  const setup = () => {
    const k = makeKit()
    const real = addPayee(k.db, k.userId, REAL, k.clock.now())
    return { k, real }
  }

  it('adding a look-alike is refused until the owner confirms they checked it, naming the payee it imitates; the confirmation is audited', () => {
    const { k } = setup()
    expect(() => addPayee(k.db, k.userId, FAKE, k.clock.now())).toThrow(expect.objectContaining({ code: 'lookalike', message: expect.stringMatching(/looks like one you already have: BESCOM Electricity \(bescom\.power@okaxis\)/) }))
    expect(k.db.get<{ n: number }>('SELECT COUNT(*) n FROM payees WHERE user_id = ?', k.userId)!.n).toBe(1)
    const fake = addPayee(k.db, k.userId, { ...FAKE, lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())
    expect(fake.handle).toBe(FAKE.handle)
    const a = k.db.get<{ detail_json: string }>("SELECT detail_json FROM audit WHERE action = 'payee.add' AND subject = ?", fake.id)
    expect(JSON.parse(a!.detail_json)).toMatchObject({ handle: FAKE.handle, lookalikeOf: [REAL.handle] })
  })

  it('an ordinary payee needs no confirmation', () => {
    const { k } = setup()
    expect(addPayee(k.db, k.userId, { name: 'Sunrise Apartments', handle: 'sunrise.rent@okhdfc' }, k.clock.now()).handle).toBe('sunrise.rent@okhdfc')
  })

  it('a payment to the look-alike says what it looks like, in the document the passkey signs; a payment to the real one does not', async () => {
    const { k, real } = setup()
    const fake = addPayee(k.db, k.userId, { ...FAKE, lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())
    const pv = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'spend', payeeId: fake.id })
    expect(pv.warnings.join(' ')).toMatch(/looks like BESCOM Electricity \(bescom\.power@okaxis\)/)
    expect(pv.summary).toBe('Pay ₹2,450 to BЕSCOМ Electricity (bescom.power@okaxls)') // a homoglyph name looks the same: the address is shown
    expect((JSON.parse(pv.document) as { warnings: string[] }).warnings.join(' ')).toMatch(/looks like BESCOM Electricity/)
    // the real payee resembles the look-alike too, and says so: the owner may not know which one is which
    const back = await previewAction(k.ctx, k.userId, { kind: 'payment', amount: 245_000, purpose: 'spend', payeeId: real.id })
    expect(back.warnings.join(' ')).toMatch(/looks like BЕSCOМ Electricity \(bescom\.power@okaxls\)/)
  })

  it('an instruction to pay the look-alike\'s bills warns before it is signed, in the document the passkey signs (review finding 3)', () => {
    const { k } = setup()
    addPayee(k.db, k.userId, { ...FAKE, lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())
    const d = buildDraft(k.ctx, k.userId, 'bills', { payeeHandles: [FAKE.handle], capPerBill: 300_000 }, undefined, k.clock.now())
    expect(d.analysis.warnings.join(' ')).toMatch(/BЕSCOМ Electricity \(bescom\.power@okaxls\) looks like BESCOM Electricity \(bescom\.power@okaxis\)/)
    const saved = saveDraft(k.ctx, k.userId, { kind: 'bills', params: { payeeHandles: [FAKE.handle], capPerBill: 300_000 }, authority: { expiresAt: k.clock.now() + 30 * 86_400_000, maxPerRun: 300_000, maxPerMonth: 1_000_000 } })
    const signed = JSON.parse(requestProgramApproval(k.ctx, k.userId, saved.programId, []).draft.document) as { payeesLookAlike?: string[] }
    expect(signed.payeesLookAlike?.join(' ')).toMatch(/looks like BESCOM Electricity \(bescom\.power@okaxis\)/)
  })
})

// R13 review, R10: the comparison was the full edit-distance table for every pair (about 0.2 ms each), on the API's
// thread. It is now computed near the diagonal only; for every value a caller compares (at or under its cap) it must be
// the same number, and anything larger is cap + 1. The reference below is the full table, as it was.
describe('look-alike checks stay cheap (R13 review, R10)', () => {
  const full = (a: string, b: string): number => {
    const A = [...a], B = [...b]
    let prev2: number[] = [], prev = Array.from({ length: B.length + 1 }, (_, j) => j)
    for (let i = 1; i <= A.length; i++) {
      const cur = [i]
      for (let j = 1; j <= B.length; j++) {
        let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1))
        if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) v = Math.min(v, prev2[j - 2]! + 1)
        cur.push(v)
      }
      prev2 = prev; prev = cur
    }
    return prev[B.length]!
  }
  it('the banded distance equals the full table at or under the cap, and is cap + 1 above it', () => {
    let seed = 7
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
    const word = (): string => Array.from({ length: rand(12) }, () => 'abcde'[rand(5)]).join('')
    const mutate = (w: string): string => { let x = w; for (let k = rand(4); k > 0; k--) { const at = rand(x.length + 1), op = rand(4); x = op === 0 ? x.slice(0, at) + 'abcde'[rand(5)] + x.slice(at) : op === 1 ? x.slice(0, at) + x.slice(at + 1) : op === 2 && at + 1 < x.length ? x.slice(0, at) + x[at + 1] + x[at] + x.slice(at + 2) : x.slice(0, at) + 'abcde'[rand(5)] + x.slice(at + 1) } return x }
    for (let n = 0; n < 4000; n++) {
      const a = word(), b = rand(3) ? mutate(a) : word()
      for (const cap of [1, 2, 3]) expect(distance(a, b, cap)).toBe(Math.min(full(a, b), cap + 1))
    }
  })
  it('a workspace keeps at most 500 payees, and the 500th is added quickly', () => {
    const k = makeKit()
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) addPayee(k.db, k.userId, { name: `Payee number ${i + 1}`, handle: `payee${i + 1}.number@okaxis`, category: 'other', lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())
    expect(performance.now() - t0).toBeLessThan(15_000)
    expect(() => addPayee(k.db, k.userId, { name: 'One More Payee', handle: 'one.more@okaxis', category: 'other', lookalikeChecked: true, nameCheckAccepted: 'unknown' }, k.clock.now())).toThrow(/500 payees/)
  }, 30_000)
})
