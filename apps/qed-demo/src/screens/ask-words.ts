/**
 * Who answered a turn of Ask, in words (src/screens/Ask.tsx). On the Anthropic API the turn's usage carries the kind of
 * question, the requests made and what they cost (server/ask-models.ts CallRecord); the model named is the one the
 * response reported, not the one asked for.
 */
export interface Engine { provider: string; model: string; latencyMs: number; usage?: { tier?: string; costUsd?: number; attempts?: { model: string; outcome: string }[] } }

/** A model id as a person reads it: "claude-opus-5-5" is Claude Opus 5.5; any other id is shown as it is. */
export function modelWords(id: string): string {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(id)
  return m ? `Claude ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]!.replace('-', '.')}` : id
}
/** US$ with two decimals, three below a cent so that a small call does not read as nothing. */
export const usdWords = (v: number): string => `US$${v > 0 && v < 0.01 ? v.toFixed(3) : v.toFixed(2)}`

/** Who wrote a turn's words: QED's own code, the scripted test double (never called a model), or the model that answered. */
export function writtenBy(e: Engine): string {
  if (e.provider === 'qed') return 'Handled by QED\'s own code; no model was asked'
  if (e.provider === 'scripted') return 'Written by a scripted test double, not a model'
  const u = e.usage
  // a request that got no answer before this one: the model asked first, and why it did not answer
  const first = (u?.attempts ?? []).filter((a) => !['answered', 'refused', 'unusable'].includes(a.outcome))
  return [
    `Answered by ${modelWords(e.model)} in ${(e.latencyMs / 1000).toFixed(1)} seconds`,
    ...(u?.tier ? [`a ${u.tier} question`] : []),
    ...(typeof u?.costUsd === 'number' ? [usdWords(u.costUsd)] : []),
    ...(first.length ? [`after ${first.map((a) => `${modelWords(a.model)} (${a.outcome.replace(/_/g, ' ')})`).join(', ')}`] : []),
  ].join(' · ')
}
