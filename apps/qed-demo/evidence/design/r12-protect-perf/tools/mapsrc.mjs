// Which source files a built chunk holds, by the size of each source's original text.
import { readFileSync } from 'node:fs'
for (const f of process.argv.slice(2)) {
  const m = JSON.parse(readFileSync(f, 'utf8'))
  const rows = m.sources.map((s, i) => [s.replace(/^.*?\/(src|node_modules|chain|shared)\//, '$1/'), (m.sourcesContent?.[i] ?? '').length]).sort((a, b) => b[1] - a[1])
  console.log(`== ${f.split('/').pop()} (${rows.length} sources)`)
  for (const [s, n] of rows.slice(0, 12)) console.log(String(n).padStart(8), s)
}
