import { useEffect, useRef, useState } from 'react'
import { usePresence } from 'motion/react'
import { DUR_MS, FLOWBAR, LEVEL, STAGGER, useReduceMotion } from '../shared/motion'
import { AT } from './choreo'
import { runLevelEngine, runLevelSampler } from './useLevel'

const BARS = FLOWBAR.waveform.bars
const MID = (BARS - 1) / 2
/** Distance of bar `i` from the centre bar: the stagger ring it belongs to. */
const ringOf = (i: number): number => Math.abs(i - MID)

/**
 * Recording waveform (docs/MOTION.md §4.1.4, §4.1.5). Laid out vertically to
 * match the bar on the screen edge: bars stack top to bottom and grow sideways.
 * Under Reduce Motion it is replaced by the static 5-segment meter (§5).
 */
export default function Waveform(): React.JSX.Element {
  return useReduceMotion() ? <LevelMeter /> : <Bars />
}

/**
 * 15 bars. Lengths come from the level engine (direct style writes). Opacity
 * rings in from the centre on entry and collapses from the outside on exit,
 * `stagger.ring` apart, as CSS on tokens so nothing renders per frame.
 */
function Bars(): React.JSX.Element {
  const [present, safeToRemove] = usePresence()
  const els = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    if (!present) return
    return runLevelEngine(els.current.filter((el): el is HTMLSpanElement => el !== null))
  }, [present])

  // Exit: the collapse is a CSS transition; leave the DOM when the last ring is done.
  useEffect(() => {
    if (present) return
    const t = setTimeout(() => safeToRemove?.(), DUR_MS.micro + MID * STAGGER.ring * 1000)
    return () => clearTimeout(t)
  }, [present, safeToRemove])

  return (
    <div className={present ? 'wave' : 'wave wave--out'} aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        // Width, not scaleX: a transform would squash the round caps with the bar.
        <span
          key={i}
          ref={(el) => { els.current[i] = el }}
          className="wave__bar"
          style={{
            width: LEVEL.floorPx,
            animationDelay: `${AT.rec.wave + ringOf(i) * STAGGER.ring}s`,
            transitionDelay: `${(MID - ringOf(i)) * STAGGER.ring}s`
          }}
        />
      ))}
    </div>
  )
}

/** Reduce Motion: five segments, lit bottom up, updated at `LEVEL.reducedHz`. No motion. */
function LevelMeter(): React.JSX.Element {
  const n = LEVEL.reducedSegments
  const [lit, setLit] = useState(0)
  useEffect(() => runLevelSampler((peak) => setLit(Math.min(n, Math.round(peak * n)))), [n])
  return (
    <div className="meter" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={n - 1 - i < lit ? 'meter__seg meter__seg--on' : 'meter__seg'} />
      ))}
    </div>
  )
}
