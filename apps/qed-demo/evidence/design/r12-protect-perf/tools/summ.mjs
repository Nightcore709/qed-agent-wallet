// Median and range (min to max) of each measure over the runs of one or more usable.ts outputs for a route.
import { readFileSync } from 'node:fs'
const [route, ...files] = process.argv.slice(2)
const runs = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).results[route].runs)
const s = (k) => { const v = runs.map((r) => r[k]).filter((x) => x !== null).map(Math.round).sort((a, b) => a - b); return v.length ? `${v[Math.floor(v.length / 2)]} (${v[0]}-${v[v.length - 1]})` : '-' }
console.log(`${route} n=${runs.length}: head ${s('head')} | figure ${s('figure')} | control ${s('control')} | press ${s('response')} | LCP ${s('lcp')}`)
