/**
 * The art behind the glass folders (DESIGN.md M1, "Glass Folder Cards"): a field of gradient noise folded into itself
 * twice (domain warping), coloured through a palette of the theme's own colours (tokens.css, read at run time, so the
 * art follows night and day), and lit as the surface of a liquid. Nothing is fetched and nothing in it carries
 * information: it is material, like the atmosphere's light.
 *
 * The functions down to `paintJob` are pure and the same on every machine (folder-art.test.ts). The painter at the end
 * needs a document: it spends at most a few milliseconds a frame, shares one picture between every folder that asks
 * for the same recipe, and is never started on the plain look (html[data-fx="plain"]) or with forced colours.
 */

/** A colour as 0 to 255 red, green and blue. */
export type Rgb = readonly [number, number, number]

export interface Recipe {
  /** The colours the field passes through, in order (two or more). */
  colors: readonly Rgb[]
  /** The size of the forms: lower is larger and calmer. */
  scale: number
  /** How hard the field folds into itself. */
  warp: number
  /** The direction the forms flow in, in radians. */
  angle: number
  /** The light's highlight on the surface, 0 to 1. */
  gloss: number
  /** Pulls the forms along the flow, like a long exposure. */
  streak?: boolean
}

// ------------------------------------------------------------------------------------------------ numbers

/** A seedable generator (xorshift32): the same numbers for the same seed on every machine. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x2545f491
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** A stable 32-bit number for a piece of text (FNV-1a), so a folder's art follows its name. */
export function textSeed(t: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Sixty-four unit directions, turned a little off the axes so no lattice line shows. */
const DIRS = 64
const GX = new Float64Array(DIRS), GY = new Float64Array(DIRS)
for (let i = 0; i < DIRS; i++) { const a = ((i + 0.37) / DIRS) * Math.PI * 2; GX[i] = Math.cos(a); GY[i] = Math.sin(a) }

/** The direction at one lattice point: an integer hash of the point and the seed, no table of permutations. */
function corner(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x2c1b3c6d) ^ Math.imul(iy, 0x297a2d39) ^ seed
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) & (DIRS - 1)
}

/** Gradient noise, about −0.7 to 0.7, smooth to the second derivative (a quintic blend), so the lighting has no seams. */
export function noise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi
  const a = corner(xi, yi, seed), b = corner(xi + 1, yi, seed), c = corner(xi, yi + 1, seed), d = corner(xi + 1, yi + 1, seed)
  const va = GX[a]! * fx + GY[a]! * fy
  const vb = GX[b]! * (fx - 1) + GY[b]! * fy
  const vc = GX[c]! * fx + GY[c]! * (fy - 1)
  const vd = GX[d]! * (fx - 1) + GY[d]! * (fy - 1)
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  return va + u * (vb - va) + v * (vc - va + u * (vd - vc - vb + va))
}

/** Octaves of noise, each twice as fine and half as strong, turned between octaves so their lattices never line up. */
export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, seed + i * 7919)
    const nx = 1.74 * x - 0.95 * y + 5.3
    y = 0.95 * x + 1.74 * y - 2.9
    x = nx
    amp *= 0.5
  }
  return sum
}

// ------------------------------------------------------------------------------------------------ the picture

export interface ArtJob {
  width: number; height: number
  /** RGBA, ready for `new ImageData(pixels, width, height)`. */
  pixels: Uint8ClampedArray
  /** Works out up to `rows` more rows of the field; true once the picture is finished. */
  step: (rows: number) => boolean
}

const smooth = (t: number): number => t * t * (3 - 2 * t)

/**
 * The picture, as a job that can be spread over frames. The field at each point p is fbm(p + k·r), where r is itself
 * fbm of a point moved by q, and q is fbm of p: each fold feeds the next, which makes the marbling. The field is then
 * stretched by its own 3rd and 97th percentiles so every seed spans the palette, coloured, and lit: its slope is the
 * surface's tilt, which gives a soft diffuse light from the upper left, a tight highlight and faint combed lines along
 * the contours.
 */
export function paintJob(width: number, height: number, recipe: Recipe, seed: number): ArtJob {
  const w = Math.max(2, Math.round(width)), h = Math.max(2, Math.round(height))
  const colors = recipe.colors.length >= 2 ? recipe.colors : ([[24, 22, 20], [236, 230, 220]] as const)
  const last = colors.length - 1
  const r = seeded(seed ^ 0x5bd1e995)
  const ox = r() * 40 + 3, oy = r() * 40 + 7
  const turn = recipe.angle + (r() - 0.5) * 0.6
  const ca = Math.cos(turn), sa = Math.sin(turn)
  const k = recipe.warp, sc = recipe.scale, m = Math.min(w, h)
  const s1 = (seed * 31 + 11) >>> 0, s2 = (seed * 17 + 101) >>> 0, s3 = (seed * 13 + 997) >>> 0
  const F = new Float32Array(w * h), Q = new Float32Array(w * h)
  const pixels = new Uint8ClampedArray(w * h * 4)
  let row = 0

  const fieldRow = (y: number) => {
    for (let x = 0; x < w; x++) {
      const u = (x - w / 2) / m, v = (y - h / 2) / m
      let px = (u * ca - v * sa) * sc, py = (u * sa + v * ca) * sc
      if (recipe.streak) { px *= 0.18; py *= 2.4 }
      px += ox; py += oy
      const qx = fbm(px, py, 3, s1), qy = fbm(px + 4.7, py + 1.9, 3, s1)
      const rx = fbm(px + k * qx + 1.3, py + k * qy + 8.1, 3, s2), ry = fbm(px + k * qx + 7.7, py + k * qy + 3.4, 3, s2)
      F[y * w + x] = fbm(px + k * rx, py + k * ry, 4, s3)
      Q[y * w + x] = Math.hypot(qx, qy)
    }
  }

  const shade = () => {
    const sample: number[] = []
    const stride = Math.max(1, Math.floor(F.length / 3000))
    for (let i = 0; i < F.length; i += stride) sample.push(F[i]!)
    sample.sort((a, b) => a - b)
    const lo = sample[Math.floor(sample.length * 0.03)]!, hi = sample[Math.floor(sample.length * 0.97)]!
    const span = 1 / (hi - lo || 1)
    // light from the upper left, a little in front; the half vector for the highlight
    const lx = -0.5, ly = -0.62, lz = 0.6, ll = Math.hypot(lx, ly, lz)
    const hx = lx / ll, hy = ly / ll, hz = lz / ll + 1, hl = Math.hypot(hx, hy, hz)
    const tilt = span * m * 0.011
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        let t = (F[i]! - lo) * span
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const at = t * last, j = Math.min(last - 1, Math.floor(at)), f = smooth(at - j)
        const a = colors[j]!, b = colors[j + 1]!
        const gx = (F[x < w - 1 ? i + 1 : i]! - F[x > 0 ? i - 1 : i]!) * tilt
        const gy = (F[y < h - 1 ? i + w : i]! - F[y > 0 ? i - w : i]!) * tilt
        const nl = Math.hypot(gx, gy, 1)
        const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl
        const diffuse = 0.8 + 0.32 * ((nx * lx + ny * ly + nz * lz) / ll)
        const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 28) * recipe.gloss * 210
        const comb = 1 + 0.03 * Math.sin(t * 140 + Q[i]! * 18)
        const lit = diffuse * comb
        pixels[i * 4] = (a[0] + (b[0] - a[0]) * f) * lit + spec
        pixels[i * 4 + 1] = (a[1] + (b[1] - a[1]) * f) * lit + spec
        pixels[i * 4 + 2] = (a[2] + (b[2] - a[2]) * f) * lit + spec
        pixels[i * 4 + 3] = 255
      }
    }
  }

  const step = (rows: number): boolean => {
    if (row >= h) return true
    const end = Math.min(h, row + Math.max(1, rows))
    while (row < end) fieldRow(row++)
    if (row < h) return false
    shade()
    return true
  }
  return { width: w, height: h, pixels, step }
}

// ------------------------------------------------------------------------------------------------ the theme's colours

/** A CSS colour as red, green and blue, or null; any alpha is dropped (the art is opaque). */
export function parseRgb(css: string): Rgb | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

let probe: CanvasRenderingContext2D | null = null
/**
 * The theme's colours for the given custom properties, as the page computes them now. Each value (an oklch() in
 * tokens.css) is drawn into a one-pixel canvas, which turns any colour the browser knows into red, green and blue.
 */
export function themeColors(names: readonly string[], el: Element = document.documentElement): Rgb[] {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return []
  const style = getComputedStyle(el)
  const out: Rgb[] = []
  for (const n of names) {
    const raw = style.getPropertyValue(n).trim().replace(/\s*\/\s*[\d.]+%?\s*\)$/, ')')
    if (!raw) continue
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = '#000'
    probe.fillStyle = raw
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    out.push([d[0]!, d[1]!, d[2]!])
  }
  return out
}

// ------------------------------------------------------------------------------------------------ the painter

/** Whether art should be painted at all: not on the plain look, not with forced colours, and only with a canvas. */
export function artAllowed(): boolean {
  if (typeof document === 'undefined') return false
  if (document.documentElement.dataset.fx === 'plain') return false
  if (typeof matchMedia !== 'undefined' && (matchMedia('(forced-colors: active)').matches || matchMedia('(prefers-reduced-transparency: reduce)').matches)) return false
  return true
}

const pictures = new Map<string, Promise<HTMLCanvasElement>>()
const waiting: { job: ArtJob; done: (c: HTMLCanvasElement) => void }[] = []
let pumping = false

function pump(): void {
  if (pumping) return
  pumping = true
  const tick = () => {
    const until = performance.now() + 6
    while (waiting.length && performance.now() < until) {
      const head = waiting[0]!
      if (!head.job.step(3)) continue
      waiting.shift()
      const c = document.createElement('canvas')
      c.width = head.job.width; c.height = head.job.height
      c.getContext('2d')?.putImageData(new ImageData(head.job.pixels as Uint8ClampedArray<ArrayBuffer>, c.width, c.height), 0, 0)
      head.done(c)
    }
    if (waiting.length) requestAnimationFrame(tick)
    else pumping = false
  }
  requestAnimationFrame(tick)
}

/** The picture for a recipe and size: painted once, a few rows a frame, then shared by everything that asks for it. */
export function paint(recipe: Recipe, seed: number, width: number, height: number): Promise<HTMLCanvasElement> {
  const key = JSON.stringify([recipe, seed, Math.round(width), Math.round(height)])
  let p = pictures.get(key)
  if (!p) {
    p = new Promise<HTMLCanvasElement>((done) => { waiting.push({ job: paintJob(width, height, recipe, seed), done }); pump() })
    pictures.set(key, p)
    // a long session with many theme changes keeps only the latest pictures
    if (pictures.size > 24) pictures.delete(pictures.keys().next().value!)
  }
  return p
}
