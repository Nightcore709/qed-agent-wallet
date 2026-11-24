/**
 * Who enforces a rule, said beside it (DESIGN.md "Meridian"; the owner's R11 criterion for the wallet: what the contract
 * itself refuses must be told apart from what QED's server checks and from what is only observed). Three marks, each a
 * word and an icon, never a colour alone:
 *
 *  - contract: the wallet's contract on the chain refuses anything outside the rule, whatever QED does;
 *  - qed:      QED's co-signer or vault service refuses to sign or to send; the chain itself does not know the rule;
 *  - seen:     a reading, from the chain or from the records; it stops nothing.
 *
 * A mark is a label. It is not a control and it authorises nothing: what enforces is the contract, or QED's service.
 * Styles: src/styles/screens/vault.css (`vt-by`, `vt-key`).
 */
import { Blocks, Eye } from 'lucide-react'
import { Seal } from './kit.tsx'

export type Enforcer = 'contract' | 'qed' | 'seen'

export const ENFORCER: Record<Enforcer, { short: string; long: string }> = {
  contract: { short: 'Contract enforces', long: 'The wallet\'s contract on the chain refuses anything outside it, whatever QED does.' },
  qed: { short: 'QED checks', long: 'QED\'s co-signer or vault service refuses to sign or send. The chain itself does not know this rule.' },
  seen: { short: 'Observed only', long: 'A reading, from the chain or the records. It stops nothing.' },
}

/** The mark: who enforces the rule it stands beside. */
export function EnforcedBy({ by, label }: { by: Enforcer; label?: string }) {
  return (
    <span className={`vt-by ${by}`}>
      {by === 'contract' ? <Blocks aria-hidden="true" /> : by === 'qed' ? <Seal /> : <Eye aria-hidden="true" />}
      {label ?? ENFORCER[by].short}
    </span>
  )
}

/** The three marks with what each means, said once where the marks are first used. */
export function EnforcementKey({ only }: { only?: Enforcer[] }) {
  const kinds: Enforcer[] = only ?? ['contract', 'qed', 'seen']
  return (
    <dl className="vt-key">
      {kinds.map((k) => <div key={k}><dt><EnforcedBy by={k} /></dt><dd>{ENFORCER[k].long}</dd></div>)}
    </dl>
  )
}
