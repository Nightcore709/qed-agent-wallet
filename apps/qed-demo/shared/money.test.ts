import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inr, inrCompact, inrExact, inrWords } from './money.ts'

describe('money formatting', () => {
  it('uses Indian grouping', () => {
    expect(inr(80_000_000)).toBe('₹8,00,000')
    expect(inr(-5_000_000)).toBe('−₹50,000')
    expect(inr(2_258_553, { sign: 'always' })).toBe('+₹22,586')
    expect(inr(2_258_553, { paise: true })).toBe('₹22,585.53')
    expect(inr(0, { sign: 'always' })).toBe('₹0')
  })
  it('writes a sum in running text as whole rupees or to the paisa, never with one decimal place', () => {
    expect(inrExact(245_000)).toBe('₹2,450')
    expect(inrExact(19_483)).toBe('₹194.83')
    expect(inrExact(19_480)).toBe('₹194.80') // not ₹194.8
    expect(inrExact(80_610_880)).toBe('₹8,06,108.80')
    expect(inrExact(5)).toBe('₹0.05')
    expect(inrExact(-500)).toBe('−₹5')
    expect(inrExact(-174_420n)).toBe('−₹1,744.20')
    expect(inrExact(123_456_789_012_345_678n)).toBe('₹1,23,45,67,89,01,23,456.78') // beyond what a float holds exactly
    expect(inrExact(1_520_833.33)).toBe('₹15,208.33') // a fraction of a paisa is rounded away
    expect(inrExact(Number.NaN)).toBe('₹—')
  })
  it('compacts lakh and crore', () => {
    expect(inrCompact(80_000_000)).toBe('₹8 lakh')
    expect(inrCompact(214_000_000)).toBe('₹21.4 lakh')
    expect(inrCompact(1_250_000_000)).toBe('₹1.25 crore')
  })
  it('spells amounts in Indian units', () => {
    expect(inrWords(80_000_000)).toBe('eight lakh rupees')
    expect(inrWords(2_258_600)).toBe('twenty-two thousand five hundred eighty-six rupees')
  })
})

describe('one place formats a sum', () => {
  // Nine places on the server once formatted rupees on their own, each with "at most two decimals" and no minimum,
  // and each could write ₹8,06,108.8. A sum now goes through this file. A price is not a sum (DESIGN.md, Figures):
  // it is written as the venue quotes it, so a line that formats a price or a quote itself is allowed.
  it('no file of the server or the interface puts a rupee sign in front of a number it formats itself', () => {
    const app = join(dirname(fileURLToPath(import.meta.url)), '..')
    const files = (dir: string): string[] => readdirSync(join(app, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : [])
    const found: string[] = []
    for (const f of [...files('server'), ...files('src')]) {
      readFileSync(join(app, f), 'utf8').split('\n').forEach((line, i) => {
        if (/₹\$\{[^`]*?\.(toLocaleString|toFixed)\(/.test(line) && !/price|quote/i.test(line)) found.push(`${f}:${i + 1}`)
      })
    }
    expect(found).toEqual([])
    expect(files('server').length).toBeGreaterThan(20) // the scan did read the server
  })
})
