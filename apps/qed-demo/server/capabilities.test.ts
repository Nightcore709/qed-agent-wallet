import { describe, expect, it } from 'vitest'
import { readCapabilities, STATUS_WORDS } from '../scripts/capabilities.ts'

describe('CAPABILITIES.md, the one mapping of the release\'s 86 capabilities to this build', () => {
  const c = readCapabilities()
  it('has 86 rows whose rail word equals chain/PARITY.md, and names only files, test titles and evidence steps that exist', () => {
    expect(c.problems).toEqual([])
    expect(c.rows.length).toBe(86)
    expect(STATUS_WORDS.reduce((n, w) => n + c.total[w]!, 0)).toBe(86)
  })
  it('its Counts section is the one its rows give (node scripts/capabilities.ts --write)', () => {
    expect(c.text.includes(`<!-- counts:start -->\n${c.block}\n<!-- counts:end -->`)).toBe(true)
  })
  it('claims Verified only where something ran here or the rail\'s row is Verified', () => {
    for (const r of c.rows.filter((x) => x.word === 'Verified')) expect(/`(server|shared|evidence)\//.test(r.evidence) || r.rail === 'Verified', r.id).toBe(true)
  })
})
