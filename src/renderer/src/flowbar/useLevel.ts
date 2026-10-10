import { LEVEL } from '../shared/motion'

/** Smoothing of the measured gap between dictation:level events. */
const GAP_ALPHA = 0.3

/**
 * Level engine for the recording waveform (docs/MOTION.md §4.1.5, §2.7).
 *
 * One rAF loop for the window. Attack is immediate (`level = max(level, input)`),
 * release is `LEVEL.decay` per 16.7 ms, frame independent. Every
 * `LEVEL.tickMs` the history shifts by one bar. Lengths are written straight
 * to `style.width`: no Motion component per bar, no React render per frame.
 *
 * When events arrive slower than `LEVEL.minRateHz`, the level releases toward
 * the last sample (not toward silence) until the next one is due, so a sparse
 * feed reads as a smooth envelope and not a saw-tooth.
 *
 * Returns the stop function. Nothing runs after it: the idle bar has no rAF.
 */
export function runLevelEngine(bars: HTMLElement[]): () => void {
  const n = bars.length
  if (!n) return () => {}
  const hist = new Float32Array(n)
  const px = (v: number): string => `${LEVEL.floorPx + v * LEVEL.rangePx}px`

  let level = 0
  let sample = 0
  let sampleAt = -Infinity
  let fresh = false
  let gap: number = LEVEL.tickMs
  let lastEvent: number | null = null

  const off = window.flow.dictation.onLevel((v) => {
    const now = performance.now()
    if (lastEvent !== null) gap += GAP_ALPHA * (now - lastEvent - gap)
    lastEvent = now
    sample = Math.min(1, Math.max(0, v))
    sampleAt = now
    fresh = true
  })

  let raf = 0
  let last: number | null = null
  let acc = 0
  const frame = (t: number): void => {
    const dt = last === null ? LEVEL.frameMs : Math.max(0, t - last)
    last = t
    const slow = gap > 1000 / LEVEL.minRateHz
    const floor = slow && t - sampleAt < gap ? sample : 0
    level = floor + (level - floor) * Math.pow(LEVEL.decay, dt / LEVEL.frameMs)
    if (fresh) { level = Math.max(level, sample); fresh = false }

    acc += dt
    if (acc >= LEVEL.tickMs) {
      acc %= LEVEL.tickMs
      hist.copyWithin(0, 1)
      hist[n - 1] = level
      for (let i = 0; i < n; i++) bars[i].style.width = px(hist[i])
    } else {
      // The newest bar follows the live level every frame, so the first syllable shows at once.
      hist[n - 1] = level
      bars[n - 1].style.width = px(level)
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    off()
  }
}

/**
 * Reduce Motion meter feed (§5): the peak since the last tick, delivered at
 * `LEVEL.reducedHz`, no interpolation and no history.
 */
export function runLevelSampler(onPeak: (peak: number) => void): () => void {
  let peak = 0
  const off = window.flow.dictation.onLevel((v) => { peak = Math.max(peak, Math.min(1, Math.max(0, v))) })
  const id = setInterval(() => { onPeak(peak); peak = 0 }, 1000 / LEVEL.reducedHz)
  return () => { clearInterval(id); off() }
}
