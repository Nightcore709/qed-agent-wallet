/**
 * Finds a class that one stylesheet defines on its own (a rule whose selector is just `.name`, or `.name` plus
 * pseudo-classes) while another stylesheet defines the same bare class. With the styles split per screen
 * (src/styles/screens/*.css) and every file loaded on every page, such a pair is a collision: the later file
 * silently restyles the shared class everywhere. It found `.grow` (the Grow page's root) overriding the shared
 * `.grow` utility on 23 Nov 2026.
 *
 *   node scripts/css-collisions.ts          exit 1 when a collision or a modifier leak is found
 *
 * Only bare selectors are compared; a class used as part of a longer selector (`.home .grow`) is scoped and is not
 * a collision. Selectors inside @media blocks count too. Rules inside the same file are not compared, nor is a rule
 * that sets only `font-variant-numeric` (base.css applies tabular figures to a list of classes).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..', 'src', 'styles')
const files = [...readdirSync(root).filter((f) => f.endsWith('.css')).map((f) => join(root, f)), ...readdirSync(join(root, 'screens')).filter((f) => f.endsWith('.css')).map((f) => join(root, 'screens', f))]

const defs = new Map<string, Set<string>>()
for (const f of files) {
  const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  // every selector list that opens a block (at-rules excluded), with the block's declarations
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}?/g)) {
    const list = m[1]!.trim()
    if (!list || list.startsWith('@')) continue
    // a list that sets only tabular figures (base.css) is a typographic utility over many classes, not a definition
    if (/^\s*font-variant-numeric:[^;]*;?\s*$/.test(m[2] ?? '')) continue
    for (const sel of list.split(',').map((x) => x.trim())) {
      const bare = /^\.([a-zA-Z][\w-]*)(?::[\w-]+(?:\([^)]*\))?)*$/.exec(sel)
      if (!bare) continue
      const name = bare[1]!
      if (!defs.has(name)) defs.set(name, new Set())
      defs.get(name)!.add(relative(root, f))
    }
  }
}

// A second kind (R11: Save's score.css defined `.sc-head { grid-area: head }` bare, and Security's own stylesheet used
// `.sc-head`, scoped, for its heading; the bare rule placed the heading in a grid area Security does not have): a
// prefixed class (`xx-name`) that a screen's own stylesheet defines bare must not appear in any other stylesheet.
// The shared sheets (tokens, base, components, shell, legacy, app) may define classes every screen uses.
const SHARED = new Set(['tokens.css', 'base.css', 'components.css', 'shell.css', 'legacy.css', 'app.css'])
const uses = new Map<string, Set<string>>()
for (const f of files) {
  const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const list = m[1]!.trim()
    if (!list || list.startsWith('@')) continue
    for (const c of list.matchAll(/\.([a-zA-Z][\w-]*)/g)) { const n = c[1]!; if (!uses.has(n)) uses.set(n, new Set()); uses.get(n)!.add(relative(root, f)) }
  }
}
// parts one screen styles and another shows on purpose, each with its reason
const SHARED_PARTS = new Map([
  ['g-k', 'screens/save.css: the reserve figures that Safeguards also shows'],
  ['g-v', 'screens/save.css: the reserve figures that Safeguards also shows'],
])
const borrowed: [string, string, string[]][] = []
for (const [name, where] of defs) {
  if (!name.includes('-') || SHARED_PARTS.has(name)) continue
  for (const owner of where) {
    if (SHARED.has(owner)) continue
    const others = [...(uses.get(name) ?? [])].filter((u) => u !== owner)
    if (others.length) borrowed.push([name, owner, others])
  }
}

// A third kind (R12: Earn's `.er-pos.solo` put the class `solo` on an element, and the shell's bare `.solo`, a full-screen
// layout, made the panel 994 px tall; and the readiness page's section root `.lg` restyled every `.btn.lg`, `.orb.lg` and
// `.hold.lg`): a class used as a modifier (after the first class of a compound selector) that another stylesheet
// defines bare gets that rule too, everywhere. The shared state and layout classes below are meant to be combined so.
const MODIFIERS = new Set(['wait', 'void', 'in', 'ok', 'board', 'loss', 'gain', 'due', 'form-grid', 'small', 'narrow-only', 'muted', 'empty'])
const leaks: [string, string, string[]][] = []
for (const f of files) {
  const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const list = m[1]!.trim()
    if (!list || list.startsWith('@')) continue
    for (const sel of list.split(',').map((x) => x.trim())) for (const part of sel.split(/[\s>+~]+/)) {
      for (const mod of [...part.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((c) => c[1]!).slice(1)) {
        if (MODIFIERS.has(mod)) continue
        const where = [...(defs.get(mod) ?? [])].filter((w) => w !== relative(root, f))
        if (where.length && !leaks.some(([n, s2]) => n === mod && s2 === part)) leaks.push([mod, part, where])
      }
    }
  }
}

const clashes = [...defs].filter(([, where]) => where.size > 1).sort(([a], [b]) => a.localeCompare(b))
for (const [name, where] of clashes) console.log(`.${name}: ${[...where].join(', ')}`)
for (const [name, owner, others] of borrowed.sort(([a], [b]) => a.localeCompare(b))) console.log(`.${name}: defined bare in ${owner}, also used in ${others.join(', ')}`)
for (const [mod, part, where] of leaks.sort(([a], [b]) => a.localeCompare(b))) console.log(`.${mod}: a modifier in ${part}, but defined bare in ${where.join(', ')}`)
const n = clashes.length + borrowed.length + leaks.length
console.log(n ? `${clashes.length} class${clashes.length === 1 ? '' : 'es'} defined bare in more than one stylesheet; ${borrowed.length} screen class${borrowed.length === 1 ? '' : 'es'} used by another stylesheet; ${leaks.length} modifier${leaks.length === 1 ? '' : 's'} defined bare elsewhere` : 'No class is defined bare in more than one stylesheet, and no modifier is defined bare elsewhere')
process.exit(n ? 1 : 0)
