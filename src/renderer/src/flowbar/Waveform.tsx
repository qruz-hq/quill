import { useEffect, useRef, useState } from 'react'

const BARS = 15
const DECAY = 0.86
/** Bar thickness, and its length at rest — equal, so silence renders as a dot. */
const DOT = 3
/** Length at full level. */
const PEAK = 26

/**
 * Live level meter for the recording pill. Driven by real RMS from the Swift
 * helper; each frame shifts the history along so the bars scroll.
 *
 * Laid out vertically to match the Flow Bar's own orientation on the screen
 * edge: bars stack top-to-bottom and grow sideways. The level response is
 * deliberately unchanged from the original horizontal meter.
 */
export default function Waveform(): React.JSX.Element {
  const [bars, setBars] = useState<number[]>(() => new Array(BARS).fill(0.04))
  const level = useRef(0)

  useEffect(() => window.flow.dictation.onLevel((v) => { level.current = v }), [])

  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = (t: number): void => {
      // ~24fps keeps the motion readable rather than jittery.
      if (t - last > 42) {
        last = t
        setBars((prev) => {
          const next = prev.slice(1)
          next.push(Math.max(0.04, level.current))
          level.current *= DECAY
          return next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="wave" aria-hidden>
      {bars.map((v, i) => (
        // Animating width rather than scaleX matters: a transform squashes the
        // border-radius with the element, turning the pill into a rounded
        // square. Width keeps the caps perfectly round at every length.
        <span key={i} className="wave__bar" style={{ width: `${DOT + v * (PEAK - DOT)}px` }} />
      ))}
    </div>
  )
}
