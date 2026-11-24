/**
 * Contrast measurement from rendered, computed colours (not from the token file).
 *
 * - Colours are read with getComputedStyle; rgb()/rgba()/color(srgb …) are parsed directly, anything else is converted
 *   by drawing it on a 1×1 canvas.
 * - The background is the composite of every translucent background up the ancestor chain to the first opaque one.
 * - Ratios follow WCAG 2.x relative luminance. Text: 4.5:1 (3:1 at ≥ 24 px, or ≥ 18.66 px bold). UI and focus: 3:1.
 *
 * `measure` runs inside the page; it must not reference anything outside its own body.
 */
export type FgSource = 'color' | 'border' | 'outline' | 'shadow' | 'fill' | 'stroke' | 'before-border' | 'background'
export type BgSource = 'auto' | 'parent' | { selector: string; prop: 'background' | 'fill' }

export interface PairSpec {
  id: string
  group: string
  label: string
  selector: string
  kind: 'text' | 'ui'
  fg?: FgSource
  bg?: BgSource
}

export interface PairResult {
  id: string; group: string; label: string; selector: string; kind: 'text' | 'ui'
  found: boolean; fg: string; bg: string; ratio: number; threshold: number; pass: boolean; large: boolean; exempt: string
}

export interface SweepFailure { selector: string; text: string; fg: string; bg: string; ratio: number; threshold: number; fontSize: number; fontWeight: number }
export interface SweepResult { checked: number; min: number; failures: SweepFailure[] }

export function measure(arg: { pairs: PairSpec[]; sweep: boolean }): { pairs: PairResult[]; sweep: SweepResult | null } {
  type RGBA = [number, number, number, number]
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const num = (v: string | undefined, scale = 1): number => (v === undefined ? 1 : v.endsWith('%') ? Number.parseFloat(v) / 100 : Number.parseFloat(v) * scale)
  const parse = (raw: string | null | undefined): RGBA | null => {
    const s = (raw ?? '').trim()
    if (!s || s === 'none' || s === 'currentcolor') return null
    if (s === 'transparent') return [0, 0, 0, 0]
    let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : num(m[4])]
    m = s.match(/^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/)
    if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : num(m[4])]
    if (!ctx) return null
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = 'rgba(0, 0, 0, 0)'
    ctx.fillStyle = s
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255]
  }
  const firstColor = (s: string): RGBA | null => {
    const m = s.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}\b)/i)
    return m ? parse(m[1]) : null
  }
  const over = (top: RGBA, bottom: RGBA): RGBA => {
    const a = top[3]
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]
  }
  const canvasColor = (): RGBA => {
    const c = parse(getComputedStyle(document.documentElement).backgroundColor)
    if (c && c[3] >= 1) return c
    return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? [18, 18, 18, 1] : [255, 255, 255, 1]
  }
  const effBg = (start: Element | null): RGBA => {
    const layers: RGBA[] = []
    for (let e: Element | null = start; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      const c = parse(cs.backgroundColor)
      const op = Number(cs.opacity)
      if (c && c[3] > 0) {
        layers.push([c[0], c[1], c[2], c[3] * op])
        if (c[3] >= 1 && op >= 1) break
      }
    }
    let bg = canvasColor()
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i] as RGBA, bg)
    return bg
  }
  const opacityProduct = (el: Element): number => {
    let p = 1
    for (let e: Element | null = el; e; e = e.parentElement) p *= Number(getComputedStyle(e).opacity)
    return p
  }
  const lum = (c: RGBA): number => {
    const ch = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }
  const ratio = (a: RGBA, b: RGBA): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
  }
  const hex = (c: RGBA): string => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  // Rules and marks are drawn by a border or stroke on a box that is 0 px tall (or wide) by design.
  const visible = (el: Element, flat = false): boolean => {
    const r = el.getBoundingClientRect()
    const tooSmall = flat ? r.width < 1 && r.height < 1 : r.width < 1 || r.height < 1
    if (tooSmall || r.bottom < 0 || r.right < 0) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('.visually-hidden')
  }
  const describe = (el: Element): string => {
    const parts: string[] = []
    let e: Element | null = el
    for (let i = 0; e && i < 3 && e !== document.body; i++, e = e.parentElement) {
      const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      parts.unshift(`${e.tagName.toLowerCase()}${cls}`)
    }
    return parts.join(' > ')
  }
  const isLarge = (el: Element): boolean => {
    const cs = getComputedStyle(el)
    const px = Number.parseFloat(cs.fontSize)
    const w = Number.parseInt(cs.fontWeight, 10)
    return px >= 24 || (px >= 18.66 && w >= 700)
  }
  const disabled = (el: Element): string => (el.closest('button[disabled], [aria-disabled="true"], fieldset[disabled]') ? 'disabled control (WCAG 1.4.3 exception)' : '')

  const pairs: PairResult[] = arg.pairs.map((p) => {
    const flat = p.fg === 'before-border' || p.fg === 'border' || p.fg === 'stroke'
    const el = Array.from(document.querySelectorAll(p.selector)).find((e) => visible(e, flat)) ?? null
    const base = { id: p.id, group: p.group, label: p.label, selector: p.selector, kind: p.kind }
    if (!el) return { ...base, found: false, fg: '', bg: '', ratio: 0, threshold: 0, pass: false, large: false, exempt: '' }
    const cs = getComputedStyle(el)
    const src = p.fg ?? 'color'
    let fg: RGBA | null =
      src === 'color' ? parse(cs.color)
        : src === 'border' ? parse(cs.borderTopWidth !== '0px' ? cs.borderTopColor : cs.borderLeftColor)
          : src === 'outline' ? (cs.outlineStyle === 'none' || Number.parseFloat(cs.outlineWidth) === 0 ? null : parse(cs.outlineColor))
            : src === 'shadow' ? firstColor(cs.boxShadow)
              : src === 'fill' ? parse(cs.fill)
                : src === 'stroke' ? parse(cs.stroke)
                  : src === 'before-border' ? parse(getComputedStyle(el, '::before').borderTopColor)
                    : parse(cs.backgroundColor)
    const bgSrc = p.bg ?? (src === 'background' || src === 'outline' ? 'parent' : 'auto')
    let bg: RGBA
    if (bgSrc === 'auto') bg = effBg(el)
    else if (bgSrc === 'parent') bg = effBg(el.parentElement)
    else {
      const other = Array.from(document.querySelectorAll(bgSrc.selector)).find((e) => visible(e)) ?? null
      if (!other) return { ...base, found: false, fg: '', bg: `missing ${bgSrc.selector}`, ratio: 0, threshold: 0, pass: false, large: false, exempt: '' }
      const ocs = getComputedStyle(other)
      const c = parse(bgSrc.prop === 'fill' ? ocs.fill : ocs.backgroundColor) ?? [0, 0, 0, 0]
      const alpha = c[3] * Number(ocs.opacity) * (bgSrc.prop === 'fill' ? Number(ocs.fillOpacity || '1') : 1)
      bg = over([c[0], c[1], c[2], alpha], effBg(other.parentElement))
    }
    if (!fg) return { ...base, found: true, fg: 'none', bg: hex(bg), ratio: 0, threshold: 0, pass: false, large: false, exempt: '' }
    const op = src === 'fill' || src === 'stroke' ? Number(cs.opacity) * Number((src === 'fill' ? cs.fillOpacity : cs.strokeOpacity) || '1') : opacityProduct(el)
    fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg)
    const large = p.kind === 'text' && isLarge(el)
    const threshold = p.kind === 'ui' ? 3 : large ? 3 : 4.5
    const r = ratio(fg, bg)
    const exempt = disabled(el)
    return { ...base, found: true, fg: hex(fg), bg: hex(bg), ratio: r, threshold, pass: r >= threshold, large, exempt }
  })

  let sweep: SweepResult | null = null
  if (arg.sweep) {
    const failures: SweepFailure[] = []
    let checked = 0
    let min = Number.POSITIVE_INFINITY
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.tagName === 'OPTION' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0)
      if (!hasText || !visible(el) || disabled(el)) continue
      const cs = getComputedStyle(el)
      const isSvgText = el instanceof SVGElement
      let fg = parse(isSvgText ? cs.fill : cs.color)
      if (!fg) continue
      const bg = effBg(isSvgText ? el.closest('svg')?.parentElement ?? null : el)
      fg = over([fg[0], fg[1], fg[2], fg[3] * opacityProduct(el)], bg)
      const r = ratio(fg, bg)
      const threshold = isLarge(el) ? 3 : 4.5
      checked++
      min = Math.min(min, r)
      if (r < threshold) failures.push({ selector: describe(el), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 50), fg: hex(fg), bg: hex(bg), ratio: r, threshold, fontSize: Number.parseFloat(cs.fontSize), fontWeight: Number.parseInt(cs.fontWeight, 10) })
    }
    sweep = { checked, min: Number.isFinite(min) ? min : 0, failures }
  }
  return { pairs, sweep }
}
