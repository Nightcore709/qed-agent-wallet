import { afterEach, describe, expect, it } from 'vitest'
import { en } from './i18n-en.ts'
import { type Catalogue, type Id, initialLocale, register, resolveLocale, setLocale, t, tn } from './i18n.ts'

/** A pseudo-locale: every English string accented and bracketed, so a string that did not go through t() stands out. */
const pseudo: Catalogue = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `[${v.replace(/[aeiou]/g, (c) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' })[c]!)}]`]))
register('en-XA', pseudo)
register('xx', { 'nav.home': 'Hxx' })
afterEach(() => setLocale('en', false))

describe('the translation layer', () => {
  it('English is complete: no id is empty and every plural has both forms', () => {
    for (const [k, v] of Object.entries(en)) expect(v.length, k).toBeGreaterThan(0)
    for (const k of Object.keys(en)) if (k.endsWith('.one')) expect(`${k.slice(0, -4)}.other` in en, k).toBe(true)
  })
  it('a registered locale answers, a partial one falls back to English for what it lacks', () => {
    setLocale('en-XA', false)
    expect(t('nav.home')).toBe('[Hómé]')
    setLocale('xx', false)
    expect(t('nav.home')).toBe('Hxx')
    expect(t('nav.spend')).toBe('Spend')
  })
  it('fills {values} and picks the plural form', () => {
    expect(tn('count.items', 1)).toBe('1 item')
    expect(tn('count.items', 12345)).toBe('12,345 items')
    expect(t('count.items.other', { n: 3 })).toBe('3 items')
    expect(t('count.items.other')).toBe('{n} items')
  })
  it('a missing id shows as itself, never blank', () => { expect(t('nope.id' as Id)).toBe('nope.id') })
  it('chooses the locale: a saved one, else the browser\'s languages in order, else English', () => {
    expect(resolveLocale('en-GB')).toBe('en')
    expect(resolveLocale('xx-YY')).toBe('xx')
    expect(initialLocale(null, ['fr-FR', 'xx-YY'])).toBe('xx')
    expect(initialLocale('en-XA', ['fr-FR'])).toBe('en-XA')
    expect(initialLocale('gone', ['fr-FR'])).toBe('en')
  })
})
