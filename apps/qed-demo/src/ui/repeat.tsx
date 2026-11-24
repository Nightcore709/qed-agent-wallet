/**
 * A payment held because it repeats an earlier one (server/duplicates.ts): what the rule is, why this one was held, and the
 * two things the person can do, which the server enforces: confirm it with a fresh passkey confirmation, or cancel it.
 * Shown on the payment's card after signing, on its record and in Activity.
 */
import { api } from '../lib/core.ts'
import type { ActionView } from '../lib/types.ts'
import { Btn, Problem, useAction, useStepUpWhenAsked } from './kit.tsx'

/** The rule, as the server states it on the sheet (server/duplicates.ts DUPLICATE_RULE). */
export const REPEAT_RULE = 'A payment that repeats an earlier one is held for your confirmation before it is sent: the same bill, or the same payee and the same amount within 24 hours. You confirm it with your passkey, or cancel it; if you do neither within 48 hours it is cancelled and nothing is sent.'

/** Whether the payment is held waiting for the person's confirmation of a repeat. */
export const awaitsRepeat = (a: Pick<ActionView, 'state' | 'result'>): boolean => a.state === 'held' && !!a.result.awaitingConfirmation && typeof a.result.duplicateConfirmedAt !== 'number'

export function RepeatHeld({ a, onChanged }: { a: ActionView; onChanged: () => void }) {
  const w = a.result.awaitingConfirmation as { why?: string }
  const confirm = useStepUpWhenAsked(async () => { await api('POST', `/api/actions/${a.id}/confirm-repeat`); onChanged() })
  const cancel = useAction(async () => { await api('POST', `/api/actions/${a.id}/cancel`); onChanged() })
  return (
    <div className="repeat-held" role="group" aria-label="This payment repeats an earlier one">
      <p className="repeat-why">{w.why}</p>
      <div className="repeat-acts">
        <Btn tone="fill" busy={confirm.busy} onClick={() => void confirm.run()}>Send it anyway, I meant to pay twice</Btn>
        <Btn tone="void" busy={cancel.busy} onClick={() => void cancel.run()}>Cancel this payment</Btn>
      </div>
      {confirm.field ? <div className="note">{confirm.field}</div> : null}
      <Problem error={confirm.error ?? cancel.error} />
    </div>
  )
}
