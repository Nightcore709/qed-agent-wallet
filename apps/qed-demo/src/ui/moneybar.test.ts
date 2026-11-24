/**
 * The money bar (DESIGN.md M14, R12): one component draws every bar of money in parts, at true scale, with the span of
 * what QED may move under the part it may come from. The owner objected to the copies it replaced ("fluorescent
 * committed-amount outlines and yellowish washes", R12 mandate section 2), so this also keeps them from coming back: no
 * screen draws its own bar, and the bar's styles light nothing, outline nothing but a shortfall and use no amber.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MoneyBar, Swatch } from './kit.tsx'

const draw = (props: Parameters<typeof MoneyBar>[0]) => renderToStaticMarkup(createElement(MoneyBar, props))

describe('the money bar', () => {
  it('draws the parts with a value, in order, each as wide as its value (true scale)', () => {
    const html = draw({ label: 'x', parts: [{ tone: 'free', value: 697_400_76 }, { tone: 'kept', value: 169_450_97 }, { tone: 'held', value: 0 }, { tone: 'short', value: 0 }] })
    const parts = [...html.matchAll(/class="mbar-part ([a-z]+)" style="flex-grow:(\d+)"/g)].map((m) => [m[1], Number(m[2])])
    expect(parts).toEqual([['free', 697_400_76], ['kept', 169_450_97]])
  })

  it('hangs the span of what QED may move under its part, as wide as the most it may move, never wider than the part', () => {
    const html = draw({ label: 'x', parts: [{ tone: 'free', value: 800, reach: 200 }, { tone: 'kept', value: 200 }] })
    expect(html).toMatch(/class="mbar has-reach"/)
    expect(html).toMatch(/class="mbar-part free" style="flex-grow:800"><span class="mbar-reach" style="width:25\.000%"><\/span><\/span>/)
    expect(draw({ label: 'x', parts: [{ tone: 'free', value: 100, reach: 900 }] })).toMatch(/mbar-reach" style="width:100\.000%"/)
    expect(draw({ label: 'x', parts: [{ tone: 'free', value: 100, reach: 0 }] })).not.toMatch(/mbar-reach|has-reach/)
  })

  it('is one image that says the whole bar; its key is that sentence made visible, hidden from a screen reader', () => {
    const html = draw({ label: '₹10.00 free and ₹5.00 kept.', parts: [{ tone: 'free', value: 1000 }, { tone: 'kept', value: 500 }], keys: [{ tone: 'free', text: 'Free' }, { text: 'No instruction can take it.' }] })
    expect(html).toMatch(/<div class="mbar-row" role="img" aria-label="₹10.00 free and ₹5.00 kept.">/)
    expect(html).toMatch(/<p class="mbar-key" aria-hidden="true"><span><i class="mbar-sw free" aria-hidden="true"><\/i><span>Free<\/span><\/span><span><span>No instruction can take it.<\/span><\/span><\/p>/)
  })

  it('draws an empty track, not nothing, when every part is zero', () => {
    expect(draw({ label: 'Nothing in the bank.', parts: [{ tone: 'free', value: 0 }] })).toMatch(/<span class="mbar-part none"><\/span>/)
  })

  it('gives a tile or a term the same material as its part', () => {
    expect(renderToStaticMarkup(createElement(Swatch, { tone: 'reach' }))).toBe('<i class="mbar-sw reach" aria-hidden="true"></i>')
  })
})

describe('no copy of the old bar comes back', () => {
  const src = join(import.meta.dirname, '..')
  const files = (dir: string, ext: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name), ext) : d.name.endsWith(ext) ? [join(dir, d.name)] : [])

  it('no screen draws its own bar of parts or its own bracket', () => {
    const own = files(join(src, 'screens'), '.tsx').filter((f) => /className="(bound|kept)"|className=\{`pay \$\{fromKeptOnly/.test(readFileSync(f, 'utf8')))
    expect(own).toEqual([])
  })

  it('the bar lights nothing, outlines nothing but a shortfall and uses no amber', () => {
    const css = readFileSync(join(src, 'styles', 'components.css'), 'utf8')
    const section = css.slice(css.indexOf('the money bar (kit.tsx MoneyBar'), css.indexOf('@media (forced-colors: active)', css.indexOf('the money bar (kit.tsx MoneyBar')))
    expect(section.length).toBeGreaterThan(500)
    expect(section).not.toMatch(/box-shadow|filter:|drop-shadow|var\(--due|var\(--qed\b|outline:/)
    // a border on any part but the shortfall (a hollow: money that is not there) and the span's ticks would be an outline
    const edge = /(^|[;{\s])border(-(top|right|bottom|left))?(-(width|style|color))?\s*:/
    for (const rule of section.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (edge.test(rule[2]!) && !/\.short\b|mbar-reach|mbar-sw\.reach/.test(rule[1]!)) throw new Error(`an outline on ${rule[1]!.trim()}`)
  })

  it('no stylesheet keeps the yellow wash for what is kept', () => {
    const washed = files(join(src, 'styles'), '.css').filter((f) => /var\(--hatch\),\s*color-mix\(in oklab, var\(--due\)/.test(readFileSync(f, 'utf8')))
    expect(washed).toEqual([])
  })
})
