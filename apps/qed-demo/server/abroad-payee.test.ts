/**
 * Foreign payees (R13 second pass): an IBAN is checked for its country's length and layout from the IBAN registry's
 * structure, and a payee that imitates another of the owner's payees (name, IBAN, account) needs the owner's confirmation,
 * as a domestic one does (server/lookalike.ts). Paper only.
 */
import { describe, expect, it } from 'vitest'
import { abroadView, addAbroadPayee, COUNTRIES, ibanWithCheckDigits, prepareAbroad } from './abroad.ts'
import { checkIbanLayout, IBAN_REGISTRY, ibanRegistryNote } from './iban-registry.ts'
import { foreignLookalikes } from './abroad-lookalike.ts'
import { makeKit } from './testkit.ts'

const T1 = Date.parse('2026-11-25T05:00:00Z')
const kit = () => makeKit({ start: T1 })

// one valid BBAN for each IBAN country the build knows, written to the registry's structure
const BBAN: Record<string, string> = {
  GB: 'WEST12345698765432', DE: '370400440532013000', FR: '30006000011234567890189', NL: 'ABNA0417164300', IE: 'AIBK93115212345678',
  ES: '21000418450200051332', IT: 'X0542811101000000123456', AE: '0331234567890123456', BH: 'BMAG00001299123456', CH: '00762011623852957',
}

describe('the IBAN registry\'s length and layout, per country', () => {
  it('has a row for every country QED pays by IBAN, each with the registry\'s length', () => {
    const ibanCountries = Object.entries(COUNTRIES).filter(([, c]) => c.scheme === 'iban').map(([k]) => k).sort()
    expect(Object.keys(IBAN_REGISTRY).sort()).toEqual(ibanCountries)
    const lengths = Object.fromEntries(Object.entries(IBAN_REGISTRY).map(([k, v]) => [k, v.length]))
    expect(lengths).toEqual({ GB: 22, DE: 22, FR: 27, NL: 18, IE: 22, ES: 24, IT: 27, AE: 23, BH: 22, CH: 21 })
  })
  it('accepts a correctly written IBAN of each country (check digits made here, length and layout from the registry)', () => {
    for (const [c, bban] of Object.entries(BBAN)) {
      const iban = ibanWithCheckDigits(c, bban)
      expect(iban.length, c).toBe(IBAN_REGISTRY[c]!.length)
      expect(checkIbanLayout(iban), c).toBeNull()
    }
  })
  it('refuses an IBAN of the wrong length for its country even when its check digits are right', () => {
    const k = kit()
    for (const [c, bban] of Object.entries(BBAN)) {
      const long = ibanWithCheckDigits(c, `${bban}0`), short = ibanWithCheckDigits(c, bban.slice(0, -1))
      expect(checkIbanLayout(long), `${c} long`).toMatch(new RegExp(`${IBAN_REGISTRY[c]!.length} characters`))
      expect(checkIbanLayout(short), `${c} short`).toMatch(/characters/)
    }
    const cur = { DE: 'EUR', GB: 'GBP', BH: 'BHD' } as const
    for (const c of ['DE', 'GB', 'BH'] as const) {
      expect(() => addAbroadPayee(k.db, k.userId, { name: 'Some One', country: c, currency: cur[c], account: ibanWithCheckDigits(c, `${BBAN[c]}0`) }, k.clock.now())).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/characters/) }))
    }
  })
  it('refuses a layout the registry does not allow: letters where the bank code is digits, digits where it is letters', () => {
    expect(checkIbanLayout(ibanWithCheckDigits('DE', 'AB0400440532013000'))).toMatch(/digits/)
    expect(checkIbanLayout(ibanWithCheckDigits('GB', '12345698765432WEST'))).toMatch(/letters/)
    expect(checkIbanLayout(ibanWithCheckDigits('NL', '12340417164300'))).toMatch(/letters/)
  })
  it('is sent to the screen with each IBAN country, so the form says what length it checks and how far that is verified', () => {
    const k = kit()
    const countries = (abroadView(k.ctx, k.userId) as { countries: { code: string; ibanNote?: string; ibanLength?: number }[] }).countries
    expect(countries.find((c) => c.code === 'BH')).toMatchObject({ ibanLength: 22, ibanNote: expect.stringMatching(/Central Bank of Bahrain/) })
    expect(countries.find((c) => c.code === 'DE')!.ibanNote).toMatch(/NOT VERIFIED/)
    expect(countries.find((c) => c.code === 'US')!.ibanNote).toBeUndefined()
  })
  it('says where each row comes from: Bahrain from its central bank, the rest not read from the registry', () => {
    expect(IBAN_REGISTRY.BH!.verifiedBy).toMatch(/Central Bank of Bahrain/)
    expect(ibanRegistryNote('BH')).toMatch(/Central Bank of Bahrain.*22/)
    for (const c of Object.keys(IBAN_REGISTRY).filter((x) => x !== 'BH')) {
      expect(IBAN_REGISTRY[c]!.verifiedBy, c).toBeNull()
      expect(ibanRegistryNote(c), c).toMatch(/NOT VERIFIED/)
      expect(ibanRegistryNote(c), c).toMatch(/403/)
    }
  })
})

describe('a foreign payee that looks like another', () => {
  const de = (name: string, bban: string) => ({ name, country: 'DE', scheme: 'iban' as const, account: ibanWithCheckDigits('DE', bban), bank: null })
  const known = [{ id: 'p1', ...de('Anita Rao', '370400440532013000') }]

  it('is found by name: the same name at another account, look-alike letters, one character apart', () => {
    expect(foreignLookalikes(de('Anita Rao', '370400440532013011'), known)[0]!.why.join(' ')).toMatch(/same name, at a different account/)
    expect(foreignLookalikes(de('Аnita Rao', '100100100000000001'), known)[0]!.why.join(' ')).toMatch(/letters from another alphabet/)
    expect(foreignLookalikes(de('Anita Rau', '100100100000000001'), known)[0]!.why.join(' ')).toMatch(/differs by one character/)
  })
  it('is found by IBAN: one or two characters apart, or the same account number at a different bank', () => {
    expect(foreignLookalikes(de('Bruno Keller', '370400440532013001'), known)[0]!.why.join(' ')).toMatch(/IBAN differs by one character/)
    expect(foreignLookalikes(de('Bruno Keller', '370400440532013021'), known)[0]!.why.join(' ')).toMatch(/IBAN differs by two characters/)
    expect(foreignLookalikes(de('Bruno Keller', '100100100532013000'), known)[0]!.why.join(' ')).toMatch(/same account number at a different bank/)
  })
  it('is found by routing and account for a US payee', () => {
    const us = (name: string, routing: string, account: string) => ({ name, country: 'US', scheme: 'aba' as const, account: `${routing} ${account}`, bank: null })
    const others = [{ id: 'u1', ...us('Dana Hill', '021000021', '123456789') }]
    expect(foreignLookalikes(us('Erin Cole', '011000015', '123456789'), others)[0]!.why.join(' ')).toMatch(/same account number at a different bank/)
    expect(foreignLookalikes(us('Erin Cole', '021000021', '123456788'), others)[0]!.why.join(' ')).toMatch(/account number differs by one character/)
  })
  it('is not found for an unrelated payee', () => {
    expect(foreignLookalikes(de('Bruno Keller', '100100100000000001'), known)).toEqual([])
  })
})

describe('adding a payee that looks like one the owner has', () => {
  it('needs the owner to confirm, and records that they did; the payment says what it looks like', () => {
    const k = kit()
    addAbroadPayee(k.db, k.userId, { name: 'Anita Rao', country: 'DE', currency: 'EUR', account: ibanWithCheckDigits('DE', BBAN.DE!) }, k.clock.now())
    const twin = { name: 'Anita Rao', country: 'DE', currency: 'EUR', account: ibanWithCheckDigits('DE', '370400440532013001') }
    expect(() => addAbroadPayee(k.db, k.userId, twin, k.clock.now())).toThrow(expect.objectContaining({ code: 'lookalike', message: expect.stringMatching(/looks like Anita Rao/) }))
    const added = addAbroadPayee(k.db, k.userId, { ...twin, confirmLookalike: true }, k.clock.now())
    const audited = k.db.all<{ detail_json: string }>(`SELECT detail_json FROM audit WHERE action = 'abroad.payee.add' AND subject = ?`, added.id)
    expect(JSON.parse(audited[0]!.detail_json)).toMatchObject({ lookalikeConfirmed: true })
    const pv = prepareAbroad(k.ctx, k.userId, { payeeId: added.id, amount: '100.00', purpose: 'family', from: 'INR' })
    expect(pv.warnings.join(' ')).toMatch(/looks like Anita Rao/)
    expect(JSON.parse(pv.document).warnings.join(' ')).toMatch(/looks like Anita Rao/)
  })
})
