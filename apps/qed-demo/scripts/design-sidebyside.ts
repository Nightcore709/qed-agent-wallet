/**
 * Writes a local page that shows the same screens from several photograph runs of scripts/design-shots.ts side by
 * side, so a design can be compared with the ones before it as rendered. The page links the photographs by relative
 * path (nothing is copied or uploaded); open it from disk.
 *
 *   node scripts/design-sidebyside.ts <out-label> <label=Title> [<label=Title> ...] [--width 1440] [--theme light] [--screens home,pay,...]
 *
 * e.g. node scripts/design-sidebyside.ts proof-final baseline-20261122="Before Clear" clear-final-2=Clear proof-final=Proof
 * writes evidence/design/proof-final/side-by-side-1440-light.html. A screen missing from a run is shown as missing.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'evidence', 'design')
const args = process.argv.slice(2)
const opt = (k: string, d: string): string => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? d : d }
const out = args[0]
const runs = args.slice(1).filter((a, i, all) => a.includes('=') && !all[i - 1]?.startsWith('--')).map((a) => { const [label, ...t] = a.split('='); return { label: label!, title: t.join('=') } })
if (!out || runs.length < 2) throw new Error('usage: node scripts/design-sidebyside.ts <out-label> <label=Title> <label=Title> ...')
const width = opt('width', '1440'), theme = opt('theme', 'light')
const screens = opt('screens', 'welcome,home,pay,save,holdings,earn,protect,activity,ask,vault,security').split(',')
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

const rows = screens.map((s) => {
  const cells = runs.map((r) => {
    const file = `${s}-${width}-${theme}.png`
    const rel = r.label === out ? file : `../${r.label}/${file}`
    return existsSync(join(dir, r.label, file))
      ? `<figure><a href="${esc(rel)}"><img src="${esc(rel)}" alt="${esc(`${r.title}: ${s}`)}" loading="lazy"></a><figcaption>${esc(r.title)}</figcaption></figure>`
      : `<figure class="missing"><div>Not photographed in this run</div><figcaption>${esc(r.title)}</figcaption></figure>`
  }).join('')
  return `<section><h2>${esc(s)}</h2><div class="row" style="--n:${runs.length}">${cells}</div></section>`
}).join('\n')

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Side by side</title>
<style>
:root { color-scheme: light dark; --bg: #f4f6f5; --ink: #17201d; --muted: #5d6b66; --card: #fff; --rule: #d9e0dd; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1513; --ink: #e8eeeb; --muted: #9aa8a2; --card: #18201d; --rule: #2a3531; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; }
main { padding: 24px 16px 64px; max-width: 2200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } p.lede { color: var(--muted); margin: 0 0 24px; max-width: 80ch; }
h2 { font-size: 16px; margin: 32px 0 8px; text-transform: none; }
.row { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 12px; align-items: start; }
figure { margin: 0; background: var(--card); border: 1px solid var(--rule); border-radius: 10px; overflow: hidden; }
figure img { display: block; width: 100%; height: auto; }
figcaption { padding: 6px 10px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--rule); }
.missing div { padding: 48px 12px; text-align: center; color: var(--muted); }
@media (max-width: 760px) { .row { grid-template-columns: 1fr; } }
</style></head>
<body><main>
<h1>The same screens, ${esc(runs.map((r) => r.title).join(', '))}</h1>
<p class="lede">Photographs at ${esc(width)} px, ${esc(theme)} theme, taken by scripts/design-shots.ts from the design fixture. Each image opens at full size. Written ${new Date().toLocaleDateString('en-CA')}.</p>
${rows}
</main></body></html>
`
const file = `side-by-side-${width}-${theme}.html`
writeFileSync(join(dir, out, file), html)
console.log(`written evidence/design/${out}/${file} (${screens.length} screens, ${runs.length} runs)`)
