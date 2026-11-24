/**
 * Every type size comes from Meridian's scale (DESIGN.md M2): text 12, 13, 15, 17; headings 16, 20, 30; display, figure
 * and statement sizes that follow the window between fixed steps; each a `--t-` token in tokens.css. (Earlier: Proof's
 * and Bounds' scales.) On 23 Nov 2026 the stylesheets held 170 literal sizes off that scale in
 * 18 values (12.5 px most often) and a screen showed 10.7 distinct sizes on average; this keeps them from coming
 * back. A size that is neither a token nor one of the exceptions named below (each named in DESIGN.md P2) fails, and
 * so does a `--t-` token set anywhere but once in tokens.css. It reads the stylesheets only: a size the browser gives
 * by default (a bare small, sub or sup) is outside it; every small the interface draws has a rule of its own (checked
 * in the browser on 25 screens at 1440 and 390 px on 23 Nov).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const root = import.meta.dirname
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : d.name.endsWith('.css') ? [join(dir, d.name)] : [])
const css = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

// The sizes that are not a step, each relative to something on purpose (file, value, how many times it appears).
const EXCEPTIONS: [string, string, number][] = [
  ['base.css', '.56em', 1], // a figure's paise, set at .56 of the figure they belong to
  ['base.css', 'max(var(--t-micro), .86em)', 1], // an identifier in the system monospace, .86 of its line, never under 12 px
  ['base.css', '1.2em', 1], // a recovery code shown once, larger than the line that introduces it
  ['screens/home.css', '.42em', 1], // the hero figure's paise (Home), .42 of the figure: at 88 px, .56 would compete with it
  // Grow's lead figures on a phone (the worth, the room above the floor, the price record's latest price), at their step
  // unless the person's text size would push them past the panel (at 200% text on a 390 px phone they clipped): then
  // held to the width; every other text still grows
  ['screens/grow.css', 'min(var(--t-fig-hero-sm), 13vw)', 1],
  ['screens/grow.css', 'min(var(--t-fig-m), 9.5vw)', 1],
  // at 200% text on a phone, what cannot wrap or grow (a fixed bar's labels, the chart's axis, a
  // display heading, a figure) is held to the width; every other text still grows
  ['horizon.css', 'min(var(--t-micro), 14px)', 1],
  ['shell.css', 'min(var(--t-micro), 13px)', 1],
  ['screens/save.css', 'min(var(--t-fig-hero-sm), 10vw)', 1],
  ['screens/save.css', 'min(var(--t-fig-m), 8.5vw)', 1],
  ['components.css', 'min(var(--t-display), 12vw)', 1],
]

function sizes(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g)) out.push(m[1]!.trim())
  for (const m of text.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)) {
    const v = m[1]!.trim()
    if (v === 'inherit') continue
    // the shorthand's size is the part before its "/line-height", or the token before the family
    const size = /(var\(--[\w-]+\)|[\d.]+(?:px|em|rem|%))(?:\/[^\s]+)?\s+var\(--(?:font|mono)\)/.exec(v)
    out.push(size ? size[1]! : `unparsed shorthand: ${v}`)
  }
  return out
}

it('every font size outside tokens.css is a --t- token or a named exception', () => {
  const strays: string[] = []
  const seen = new Map<string, number>()
  for (const f of files(root)) {
    const name = relative(root, f)
    if (name === 'tokens.css') continue
    for (const v of sizes(css(f))) {
      if (/^var\(--t-[\w-]+\)$/.test(v)) continue
      const key = `${name} ${v}`
      if (EXCEPTIONS.some(([file, value]) => file === name && value === v)) { seen.set(key, (seen.get(key) ?? 0) + 1); continue }
      strays.push(key)
    }
  }
  expect(strays, `sizes off the scale (use a --t- token from tokens.css): ${strays.join('; ')}`).toEqual([])
  for (const [file, value, n] of EXCEPTIONS) expect(seen.get(`${file} ${value}`) ?? 0, `${file} ${value}`).toBe(n)
})

it('no stylesheet but tokens.css sets a --t- token (a rule like ".dense { --t-body: 14px }" would pass the test above)', () => {
  const set: string[] = []
  for (const f of files(root)) {
    const name = relative(root, f)
    if (name === 'tokens.css') continue
    for (const m of css(f).matchAll(/(?:^|[;{\s])(--t-[\w-]+)\s*:/g)) set.push(`${name} ${m[1]}`)
  }
  expect(set).toEqual([])
})

it('the type tokens are the Meridian scale (D-109 replaced Bounds\'), each set once', () => {
  const pairs = [...css(join(root, 'tokens.css')).matchAll(/(--t-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const)
  const tokens = Object.fromEntries(pairs)
  expect(pairs.length, 'a --t- token set twice in tokens.css (in a media query, say) would change the scale at some widths').toBe(Object.keys(tokens).length)
  expect(tokens).toEqual({
    // in rem so a larger browser text size enlarges every step (24 Nov, R11 feedback: "enlarged text")
    '--t-micro': '.75rem', '--t-small': '.8125rem', '--t-body': '.9375rem', '--t-lead': '1.0625rem', '--t-h3': '1rem', '--t-h2': '1.25rem', '--t-h1': '1.875rem',
    '--t-display': 'clamp(2.25rem, 4.4vw, 4rem)',
    '--t-fig-s': '1.375rem', '--t-fig-m': '1.875rem', '--t-fig-l': '2.75rem', '--t-fig-xl': '4rem',
    '--t-fig-hero': 'clamp(3rem, 6vw, 5.5rem)', '--t-fig-hero-sm': 'clamp(2.5rem, 12.5vw, 3.5rem)',
    '--t-statement': 'clamp(2.75rem, 5.2vw, 5.25rem)', '--t-statement-sm': 'clamp(1.875rem, 9vw, 2.75rem)',
    // R12: three figure steps that never outgrow their panel (container units): at 24 px text on a phone the hero
    // pushed Home 19 px wider than the window. Each is one of the steps above, capped by its container's width.
    '--t-fig-hero-fit': 'min(var(--t-fig-hero-sm), 15.5cqi)', '--t-fig-l-fit': 'min(var(--t-fig-l), 15.5cqi)', '--t-fig-m-fit': 'min(var(--t-fig-m), 11cqi)',
  })
})
