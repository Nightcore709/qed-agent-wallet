/**
 * Save's cash-flow chart (src/ui/score.tsx), fetched as its own chunk once Save has drawn its figure and controls
 * (DESIGN.md M11; R12 perf: on the phone profile Save's key figure waited for the chart's code, about half of Save's
 * own). Same props as `Score`; while the chart's code arrives, its title, its sentence, the rail beside it (Save's
 * what-if) and its foot are drawn at once, and the plot keeps its height, so nothing below it moves when it arrives.
 */
import { type ComponentProps, lazy, Suspense } from 'react'
import { Skel } from './page.tsx'
import type { Score as Drawn } from './score.tsx'

const Real = lazy(() => import('./score.tsx').then((m) => ({ default: m.Score })))
type Props = ComponentProps<typeof Drawn>

export function Score(props: Props) {
  return <Suspense fallback={<ScoreWaiting {...props} />}><Real {...props} /></Suspense>
}

/** The chart's frame while its code loads: the same grid as `Score` (score.css), with the plot as a shape of its height. */
function ScoreWaiting({ title, sub, rail, foot }: Props) {
  return (
    <div className={`sc ${rail ? 'with-rail' : ''}`}>
      <div className="sc-head"><div className="sc-title">{title}{sub ? <p>{sub}</p> : null}</div></div>
      <div className="sc-chart" aria-busy="true"><p className="loading-line">Drawing the chart</p><Skel h={320} r={14} /></div>
      {rail ? <div className="sc-rail">{rail}</div> : null}
      {foot ? <div className="sc-foot">{foot}</div> : null}
    </div>
  )
}
