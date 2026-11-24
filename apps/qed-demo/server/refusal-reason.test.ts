/**
 * The notice on Home for a standing policy that keeps being refused (server/rail.ts, R7-111 F6) says why in one
 * sentence: the co-signer's rule by its name, never its number, a research reference or the vault's full record with
 * its addresses and tickers.
 */
import { describe, expect, it } from 'vitest'
import { refusalReason } from './rail.ts'

describe('refusalReason', () => {
  it('names the co-signer rule and leaves out the record', () => {
    const s = "Co-signer refused: C12 not met: Authority budget (R7 D7): this conversion's cost against the reference fits in what the owner granted: 410.36 tINR into tUSD for 0x45cbe43539dF5Fcf5829c8Ff431319Df8E62e8Cc, an account of the workspace"
    expect(refusalReason(s)).toBe('The co-signer refused the latest under its authority budget rule.')
  })
  it('otherwise keeps the first sentence, with addresses in words, and ends it', () => {
    expect(refusalReason('Reverted by 0x45cbe43539dF5Fcf5829c8Ff431319Df8E62e8Cc. More detail follows.')).toBe('The latest was refused: Reverted by an account.')
    expect(refusalReason('slippage too high')).toBe('The latest was refused: slippage too high.')
    expect(refusalReason(undefined)).toBe('The latest was refused.')
  })
  it('caps a long first sentence', () => {
    expect(refusalReason('x'.repeat(400)).length).toBeLessThan(200)
  })
})
