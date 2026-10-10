import { useEffect, useRef } from 'react'

const BANDS = 28
/** Bar heights in px: at rest, and the travel above it at full level (3 to 24). */
const REST = 3
const TRAVEL = 21
/** Reduce Motion: the bars step to the latest reading this often (ms). */
const REDUCED_STEP_MS = 250

/**
 * The microphone as a spectrum: low pitch on the left, high on the right
 * (Settings, Dictation "Input level" and the onboarding Try it tile).
 * Heights are written straight to the bars. The helper sends about 30 frames
 * a second while the mic is open, and that must not re-render the owner.
 * The owner styles the row and the bars; a moving bar gets `is-lit`.
 */
export function SpectrumBars({ className, barClassName }: {
  className: string; barClassName: string
}): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const bars = Array.from(row.current?.children ?? []) as HTMLElement[]
    const target = new Float32Array(BANDS)
    const shown = new Float32Array(BANDS)
    let raf = 0
    let last = 0
    let painted = 0
    const paint = (): void => bars.forEach((bar, i) => {
      bar.style.height = `${REST + shown[i] * TRAVEL}px`
      bar.classList.toggle('is-lit', shown[i] > 0.04)
    })
    const tick = (t: number): void => {
      raf = 0
      const dt = Math.min(64, t - (last || t))
      last = t
      let again = false
      if (document.documentElement.hasAttribute('data-reduce-motion')) {
        // No easing: the bars step to the latest reading four times a second.
        shown.set(target)
        if (t - painted >= REDUCED_STEP_MS) { paint(); painted = t } else again = true
      } else {
        for (let i = 0; i < BANDS; i++) {
          // Up at once, down gently, so a syllable is seen and not a flicker.
          const next = target[i] >= shown[i] ? target[i] : Math.max(target[i], shown[i] - dt / 260)
          if (Math.abs(next - shown[i]) > 0.002) again = true
          shown[i] = next
        }
        paint()
      }
      if (again) raf = requestAnimationFrame(tick)
    }
    const kick = (): void => { if (!raf) { last = 0; raf = requestAnimationFrame(tick) } }
    const quiet = (): void => { target.fill(0); kick() }
    const offBands = window.flow.mic.onSpectrum((bands) => {
      for (let i = 0; i < BANDS; i++) target[i] = bands[i] ?? 0
      kick()
    })
    const offState = window.flow.dictation.onState((s) => { if (s === 'idle') quiet() })
    const offTest = window.flow.mic.onTest((t) => { if (t.state === 'ended') quiet() })
    paint()
    return () => { offBands(); offState(); offTest(); cancelAnimationFrame(raf) }
  }, [])
  return (
    <div className={className} aria-hidden ref={row}>
      {Array.from({ length: BANDS }, (_, i) => <span key={i} className={barClassName} />)}
    </div>
  )
}
