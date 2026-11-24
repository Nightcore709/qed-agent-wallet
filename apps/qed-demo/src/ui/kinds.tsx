/**
 * The three kinds of protection, told apart the same way on every Protect page (the owner's R11 regression criterion:
 * "distinguish observations, configured policies and independently enforced protections"):
 *
 *  - watched   QED sees it and tells you. It stops nothing on its own.
 *  - set       a rule you chose. It is only as strong as whatever enforces it, which is named beside it.
 *  - enforced  something refuses what breaks the rule, whatever the model says: QED's server (fixed code), the
 *              co-signer (a second key in its own process) or the chain (the on-chain wallet's contract and its own
 *              account). The model behind Ask enforces nothing: it only proposes.
 *
 * A tag always carries its icon and its words; its material (a dashed edge for what has no force, a solid one for a
 * rule, an opaque one for what refuses) repeats the words and never replaces them. Styles: styles/screens/protect.css.
 */
import { Eye, Link2, LockKeyhole, Server, Signature, SlidersHorizontal } from 'lucide-react'

export type Kind = 'watched' | 'set' | 'enforced'
/** Who refuses what breaks a rule. */
export type Enforcer = 'server' | 'cosigner' | 'chain'

export const KIND_WORD: Record<Kind, string> = { watched: 'Watched', set: 'Set by you', enforced: 'Enforced' }
export const BY_WORD: Record<Enforcer, string> = { server: "QED's server", cosigner: 'the co-signer', chain: 'the chain' }

const KIND_ICON = { watched: Eye, set: SlidersHorizontal, enforced: LockKeyhole } as const
const BY_ICON = { server: Server, cosigner: Signature, chain: Link2 } as const

/** What kind a protection is, in words with its mark: "Watched", "Set by you", "Enforced by the chain". */
export function KindTag({ kind, by }: { kind: Kind; by?: Enforcer }) {
  const I = kind === 'enforced' && by ? BY_ICON[by] : KIND_ICON[kind]
  return <span className="pr-kind" data-kind={kind} data-by={by}><I aria-hidden="true" />{kind === 'enforced' && by ? `Enforced by ${BY_WORD[by]}` : KIND_WORD[kind]}</span>
}

/** A rule you set and who enforces it, as one pair of tags: "Set by you" then "Enforced by QED's server". */
export function SetAndEnforced({ by }: { by: Enforcer }) {
  return <span className="pr-kinds"><KindTag kind="set" /><KindTag kind="enforced" by={by} /></span>
}

/** The large mark at the head of a band of one kind. */
export function KindSeal({ kind }: { kind: Kind }) {
  const I = KIND_ICON[kind]
  return <span className="pr-seal" data-kind={kind} aria-hidden="true"><I /></span>
}
