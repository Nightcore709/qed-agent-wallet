/**
 * A small translation layer for the interface's own strings.
 *
 * - English is the complete source catalogue (`i18n-en.ts`); another locale may be partial and falls back to English
 *   for any id it lacks, then to the id itself, so a missing string is visible and never blank.
 * - `{name}` in a string is replaced from the values given; `tn` picks `id.one` or `id.other` by the locale's plural rule.
 * - The locale comes from the person's saved choice, then the browser's language, among the catalogues registered. No
 *   translation is shipped yet: a catalogue is added with `register` once a person who reads that language has reviewed
 *   it, so the interface never shows an unchecked translation of a financial sentence.
 * - It sets the page's `lang`, so a screen reader pronounces it correctly.
 * Not covered, on purpose: numbers, dates and money (formatted by `fmt` with Intl), and text that comes from the server.
 */
import { useSyncExternalStore } from 'react'
import { en } from './i18n-en.ts'

export type Id = keyof typeof en
export type Catalogue = Partial<Record<Id, string>>
export type Vars = Record<string, string | number>

const catalogues = new Map<string, Catalogue>([['en', en]])
const listeners = new Set<() => void>()
const KEY = 'qed.locale'
let current = 'en'

const base = (l: string): string => l.split('-')[0]!.toLowerCase()
/** The registered locale that best matches a language tag: the exact tag, then its language, else English. */
export function resolveLocale(tag: string | null | undefined): string {
  if (!tag) return 'en'
  if (catalogues.has(tag)) return tag
  const b = base(tag)
  for (const k of catalogues.keys()) if (base(k) === b) return k
  return 'en'
}

export function getLocale(): string { return current }
export function locales(): string[] { return [...catalogues.keys()] }

export function setLocale(tag: string, save = true): void {
  current = resolveLocale(tag)
  if (typeof document !== 'undefined') document.documentElement.lang = current === 'en' ? 'en-IN' : current
  if (save) { try { localStorage.setItem(KEY, current) } catch { /* private mode: the choice lasts for the page */ } }
  for (const l of listeners) l()
}

export function register(tag: string, catalogue: Catalogue): void { catalogues.set(tag, catalogue) }

/** The locale to start in: a saved choice, else the browser's languages in order. */
export function initialLocale(saved: string | null, languages: readonly string[]): string {
  if (saved && catalogues.has(saved)) return saved
  for (const l of languages) { const r = resolveLocale(l); if (r !== 'en' || base(l) === 'en') return r }
  return 'en'
}

export function t(id: Id, vars?: Vars): string {
  const s = catalogues.get(current)?.[id] ?? en[id] ?? id
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

type PluralBase = { [K in Id]: K extends `${infer B}.one` ? B : never }[Id]
export function tn(id: PluralBase, n: number): string {
  const rule = new Intl.PluralRules(current === 'en' ? 'en-IN' : current).select(n)
  const key = (`${id}.${rule}` in en ? `${id}.${rule}` : `${id}.other`) as Id
  return t(key, { n: new Intl.NumberFormat(current === 'en' ? 'en-IN' : current).format(n) })
}

const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
/** In a component: re-renders when the locale changes. */
export function useT(): { t: typeof t; tn: typeof tn; locale: string } {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale)
  return { t, tn, locale }
}

if (typeof window !== 'undefined') {
  let saved: string | null = null
  try { saved = localStorage.getItem(KEY) } catch { /* no storage */ }
  const first = initialLocale(saved, navigator.languages ?? [navigator.language])
  if (first !== 'en') setLocale(first, false)
}
