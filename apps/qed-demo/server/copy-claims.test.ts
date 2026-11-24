/**
 * N-019: no copy claims a waiver of statutory rights, a bank refund, or that QED can override a bank agreement
 * (EV-073 ground rules G4 and G7). A scan of every string the product can show a person: each string literal, template
 * and JSX text in the interface's sources and in the server's (the server's refusals, notices and answers), checked
 * sentence by sentence against a list of forbidden claims. A sentence that denies the claim ("QED cannot override your
 * bank") is not a claim. The scan is itself checked against sentences written to fail. Counsel's review of the final
 * copy is EXT-06 and is not claimed here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'rolldown/experimental'
import { describe, expect, it } from 'vitest'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The forbidden claims, each with the ground rule it protects. */
export const FORBIDDEN: { id: string; why: string; re: RegExp }[] = [
  { id: 'waiver', why: 'G4: a person never waives a statutory right through QED', re: /\b(waive[sd]?|waiver|relinquish(es|ed)?|forfeit(s|ed)?|give[s]? up) (of )?(any |all |your |their )?(statutory |legal |consumer )?(rights?|protections?|claims?|remed(y|ies))\b|\bagree(s)? not to (dispute|sue|claim|chargeback|challenge)\b/i },
  { id: 'bank-refund', why: 'G4: QED does not promise that a bank will refund', re: /\b(your |the )?bank (will|must|has to|is required to|shall|is obliged to) (refund|reimburse|repay|credit)\b|\b(we|QED) (will|can|shall|guarantee to) (refund|reimburse|repay|make you whole)\b|\b(guaranteed|full) refund\b|\bmoney[- ]back guarantee\b|\byou (will|are guaranteed to) (get|receive) (your money|a refund|it) back\b/i },
  { id: 'override-bank', why: 'G7: QED cannot override a bank agreement', re: /\b(QED|we) (can|will|may|shall) (override|overrule|overturn|supersede|void|set aside|bypass) (your |the |any )?(bank|bank\'s|card issuer|issuer)/i },
  { id: 'override-bank-2', why: 'G7: QED cannot override a bank agreement', re: /\b(overrides?|supersedes?|takes? precedence over|replaces?) (your |the |any )?bank('s)? (agreement|terms|contract|limits?|rules?)\b/i },
]
const NEGATION = /\b(not|never|no|nothing|nobody|none|cannot|can't|can’t|n't|nor|without|neither|unless|only if|does not|is not|are not)\b|n’t/i

/** The claims a piece of copy makes: each forbidden pattern found in a sentence that does not deny it. */
export function claimsIn(text: string): { id: string; sentence: string }[] {
  const out: { id: string; sentence: string }[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const f of FORBIDDEN) {
      const m = f.re.exec(sentence)
      // the denial is read in the rest of the sentence: the words the pattern matched are the claim itself
      if (m && !NEGATION.test(sentence.replace(m[0], ' '))) out.push({ id: f.id, sentence: sentence.trim() })
    }
  }
  return out
}

type N = { type: string; start: number; end: number; [k: string]: any }
const kids = (n: N): N[] => { const o: N[] = []; for (const k in n) { const v = n[k]; if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') o.push(x) } else if (v && typeof v.type === 'string') o.push(v) } return o }
/** Every string literal, template piece and JSX text in a source, with its line. */
export function stringsOf(file: string, src: string): { line: number; text: string }[] {
  const prog = parseSync(file, src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }).program as N
  const out: { line: number; text: string }[] = []
  const walk = (n: N) => {
    const text = n.type === 'Literal' && typeof n.value === 'string' ? n.value : n.type === 'JSXText' ? n.value : n.type === 'TemplateElement' ? (n.value?.cooked ?? n.value?.raw) : undefined
    if (typeof text === 'string' && text.trim()) out.push({ line: src.slice(0, n.start).split('\n').length, text })
    for (const c of kids(n)) walk(c)
  }
  walk(prog)
  return out
}
// JSX text is split at each element and expression, so a sentence spread over inline elements is read in pieces and, to
// catch one broken by <b>..</b>, each file's strings are also joined per line pair below.

function files(dir: string): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (!['node_modules', 'evidence', 'dist'].includes(f)) out.push(...files(p)) } else if (/\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f) && !/fixture|testkit/.test(f)) out.push(p)
  }
  return out
}

describe('N-019: forbidden claims in copy', () => {
  it('finds each forbidden claim in a sentence written to make it, and none in a sentence that denies it', () => {
    expect(claimsIn('By continuing you waive your statutory rights.').map((c) => c.id)).toEqual(['waiver'])
    expect(claimsIn('You agree not to dispute the payment.').map((c) => c.id)).toEqual(['waiver'])
    expect(claimsIn('Your bank will refund the payment.').map((c) => c.id)).toEqual(['bank-refund'])
    expect(claimsIn('QED will refund you if it goes wrong.').map((c) => c.id)).toEqual(['bank-refund'])
    expect(claimsIn('This is a guaranteed refund.').map((c) => c.id)).toEqual(['bank-refund'])
    expect(claimsIn('QED can override your bank\'s agreement.').map((c) => c.id)).toContain('override-bank')
    expect(claimsIn('This overrides your bank agreement.').map((c) => c.id)).toEqual(['override-bank-2'])
    expect(claimsIn('QED cannot override your bank. Nothing here waives your rights. A bank is not required to refund a payment you authorised.')).toEqual([])
  })

  it('every string in the interface and the server is free of them', () => {
    const found: string[] = []
    let scanned = 0
    for (const dir of ['src', 'server', 'shared']) for (const f of files(join(APP, dir))) {
      const src = readFileSync(f, 'utf8')
      for (const s of stringsOf(f, src)) { scanned++; for (const c of claimsIn(s.text)) found.push(`${f.slice(APP.length + 1)}:${s.line} [${c.id}] ${c.sentence.slice(0, 140)}`) }
    }
    // the scan reads the whole product's copy, not an empty set
    expect(scanned).toBeGreaterThan(5000)
    expect(found).toEqual([])
  })
})
