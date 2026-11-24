/**
 * The Protect screens' own logic, apart from what they draw: resuming an instruction from a session opened with a
 * password (the server answers 401 stepup_required, server/api.ts and server/password-session-routes.test.ts) is
 * confirmed with the passkey and tried once more, and an account without a passkey is told the server's reason; what
 * is left of a monthly limit never goes below nothing; a near date is said as a person says it, in India time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/core.ts', async (original) => ({ ...(await original<typeof import('../lib/core.ts')>()), api: vi.fn() }))
vi.mock('../lib/passkey.ts', async (original) => ({ ...(await original<typeof import('../lib/passkey.ts')>()), confirmWithPasskey: vi.fn(async () => {}) }))

const { api, ApiError } = await import('../lib/core.ts')
const { confirmWithPasskey } = await import('../lib/passkey.ts')
const { affectedWords, monthLeft, nearDay, resumeInstruction } = await import('./Protect.tsx')
type Summary = Parameters<typeof monthLeft>[0]

const call = vi.mocked(api)
const confirm = vi.mocked(confirmWithPasskey)
const stepUp = () => new ApiError(401, 'stepup_required', 'Confirm with your passkey to continue.')
beforeEach(() => { call.mockReset(); confirm.mockClear() })

describe('resuming an instruction', () => {
  it('resumes at once in a session opened with a passkey', async () => {
    call.mockResolvedValueOnce({ program: {} })
    await resumeInstruction('prg_1', true)
    expect(call.mock.calls).toEqual([['POST', '/api/programs/prg_1/resume']])
    expect(confirm).not.toHaveBeenCalled()
  })

  it('confirms with the passkey and tries once more when the server asks for it', async () => {
    call.mockRejectedValueOnce(stepUp()).mockResolvedValueOnce({ program: {} })
    await resumeInstruction('prg_1', true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(call.mock.calls).toEqual([['POST', '/api/programs/prg_1/resume'], ['POST', '/api/programs/prg_1/resume']])
  })

  it('tells an account without a passkey the server\'s reason, and asks for no confirmation it cannot give', async () => {
    call.mockRejectedValueOnce(stepUp())
    await expect(resumeInstruction('prg_1', false)).rejects.toMatchObject({ code: 'stepup_required', message: 'Confirm with your passkey to continue.' })
    expect(confirm).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('tries only once more: a second refusal is shown, not retried', async () => {
    call.mockRejectedValueOnce(stepUp()).mockRejectedValueOnce(stepUp())
    await expect(resumeInstruction('prg_1', undefined)).rejects.toMatchObject({ code: 'stepup_required' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('passes any other refusal through untouched', async () => {
    call.mockRejectedValueOnce(new ApiError(409, 'not_paused', 'This instruction is not paused.'))
    await expect(resumeInstruction('prg_1', true)).rejects.toMatchObject({ code: 'not_paused' })
    expect(confirm).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('stops if the passkey confirmation is refused, and sends nothing more', async () => {
    call.mockRejectedValueOnce(stepUp())
    confirm.mockRejectedValueOnce(new ApiError(0, 'passkey_cancelled', 'The passkey prompt was closed before it finished. Nothing was signed.'))
    await expect(resumeInstruction('prg_1', true)).rejects.toMatchObject({ code: 'passkey_cancelled' })
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('what is left of a monthly limit', () => {
  const p = (maxPerMonth: number, usedThisMonth: number | null): Summary => ({ authority: { maxPerMonth }, usedThisMonth } as unknown as Summary)
  it('is the signed limit less what the policy check has counted this month', () => {
    expect(monthLeft(p(3_100_000, 100_000))).toEqual({ left: 3_000_000, of: 3_100_000 })
  })
  it('never goes below nothing, even when more was counted than the limit', () => {
    expect(monthLeft(p(1_000_000, 1_250_000))).toEqual({ left: 0, of: 1_000_000 })
  })
  it('is not stated when nothing has been counted', () => {
    expect(monthLeft(p(1_000_000, null))).toBeNull()
    expect(monthLeft({ authority: null, usedThisMonth: 0 } as unknown as Summary)).toBeNull()
  })
})

describe('a near date, in India time', () => {
  const IST = 19_800_000
  const at = (s: string): number => Date.parse(`${s.replace(' ', 'T')}:00Z`) - IST
  const now = at('2026-11-23 00:20')
  it('says today, tomorrow and yesterday by the calendar day in India, not by 24-hour distance', () => {
    expect(nearDay(at('2026-11-23 10:30'), now)).toBe('Today')
    expect(nearDay(at('2026-11-24 00:05'), now)).toBe('Tomorrow')
    expect(nearDay(at('2026-11-22 23:59'), now)).toBe('Yesterday')
  })
  it('names the weekday and date further out', () => {
    expect(nearDay(at('2026-11-26 09:00'), now)).toBe('Thu 26 Nov')
  })
})

describe('what an incident cost, in words', () => {
  it('names each kind, in the singular and the plural, and says when nothing was lost', () => {
    expect(affectedWords({ missedRuns: 1 })).toBe('1 missed run')
    expect(affectedWords({ missedRuns: 3, failedRequests: 2 })).toBe('3 missed runs, 2 requests not saved')
    expect(affectedWords({ missedTicks: 2, differences: 1 })).toBe('2 missed wallet ticks, 1 difference with a venue')
    expect(affectedWords({})).toBe('Nothing lost')
    expect(affectedWords({ missedRuns: 0 })).toBe('Nothing lost')
  })
  it('seeded failure: false when QED_SEED_FAIL=1', () => { expect(process.env.QED_SEED_FAIL === '1').toBe(false) })
})
