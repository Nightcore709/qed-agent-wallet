/**
 * While QED is paused, an instruction the pause holds says so instead of its next run (R12 task comparison, gap 15):
 * every instruction is held, except protective selling when the owner chose to keep it running.
 */
import { describe, expect, it } from 'vitest'
import type { ProgramSummary } from './types.ts'
import { heldByPause, statusLine } from './words.ts'

const NOW = Date.parse('2026-11-24T15:00:00+05:30')
const program = (kind: string, over: Partial<ProgramSummary> = {}): ProgramSummary => ({ kind, state: 'active', nextDueAt: NOW + 86_400_000, pausedReason: null, watching: null, lastChecked: null, ...over } as unknown as ProgramSummary)

describe('the pause in an instruction\'s status', () => {
  it('holds every instruction, and protective selling only when it was not kept running', () => {
    expect(heldByPause('invest', null)).toBe(false)
    expect(heldByPause('invest', { protectiveContinues: false })).toBe(true)
    expect(heldByPause('invest', { protectiveContinues: true })).toBe(true)
    expect(heldByPause('floor', { protectiveContinues: false })).toBe(true)
    expect(heldByPause('floor', { protectiveContinues: true })).toBe(false)
    expect(heldByPause('exit', { protectiveContinues: true })).toBe(false)
  })
  it('says the pause instead of the next run, and leaves drafts, paused and ended instructions as they were', () => {
    expect(statusLine(program('invest'), NOW)).toMatch(/^Next run /)
    expect(statusLine(program('invest'), NOW, { protectiveContinues: false })).toBe('QED is paused: no run starts until you resume it.')
    expect(statusLine(program('exit', { nextDueAt: null }), NOW, { protectiveContinues: true })).toMatch(/^Watching the price/)
    expect(statusLine(program('invest', { state: 'draft' }), NOW, { protectiveContinues: false })).toMatch(/^Drafted, not signed/)
    expect(statusLine(program('invest', { state: 'paused' }), NOW, { protectiveContinues: false })).toMatch(/^Paused\. No new runs start\./)
    expect(statusLine(program('invest', { state: 'revoked' }), NOW, { protectiveContinues: false })).toMatch(/It can no longer act\.$/)
  })
})
