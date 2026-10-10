import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ElementType } from 'react'
import { filterBudget } from './filterBudget'
import { useReduceMotion } from './MotionProvider'
import { animateWord, currentOpacity } from './waapi'
import { HOLD, SPRING, STAGGER, STAGGER_CAP, WORD_VARIANTS, springToLinear } from './tokens'

/**
 * Digit blur-swap for counters (docs/MOTION.md §3.4).
 *
 * - Each character has its own slot keyed by position-from-right; only changed
 *   glyphs animate. Old glyph exits (blur + y away), new glyph enters (blur → sharp
 *   + y from the trend side). Trend = sign(new − old), so falling WPM rolls down.
 * - Changed digits stagger 20 ms right → left, capped at 3 (rest with the 3rd).
 * - Width changes (99 → 100) animate the wrapper's real width with `spring.ui`.
 * - Updates closer than `hold.coalesce` (120 ms) merge; only the latest animates.
 * - No count-up on mount; the value renders at rest.
 * - A11y: sr-only formatted value + aria-hidden glyphs. Never put a 1 Hz timer
 *   inside a live region.
 * - Reduce Motion: the formatted string, no slots.
 */

export type BlurNumberSize = 'auto' | 'default' | 'large' | 'subtle'

export interface BlurNumberProps {
  value: number
  /** Default: `Intl.NumberFormat` with grouping. Timer: `(s) => m:ss`. */
  format?: (v: number) => string
  /** `auto` picks `large` at ≥ 32 px type, else `default`. `subtle` for timers, %, word counts. */
  size?: BlurNumberSize
  as?: ElementType
  className?: string
  style?: CSSProperties
  /** Hide the sr-only twin when the surrounding label already reads the value. */
  srText?: string | false
}

interface Glyph { key: string; pos: number; char: string; exiting?: boolean }

const defaultFormat = new Intl.NumberFormat(undefined, { useGrouping: true })
let glyphSeq = 0

function toGlyphs(str: string): Glyph[] {
  const n = str.length
  return Array.from(str, (char, i) => ({ key: `g${++glyphSeq}`, pos: n - 1 - i, char }))
}

/** Coalesce rapid updates: apply now if the last apply was ≥ `ms` ago, else at the window end. */
function useCoalesced(value: number, ms: number): number {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const now = performance.now()
    const wait = last.current + ms - now
    if (wait <= 0) { last.current = now; setShown(value); return }
    const t = setTimeout(() => { last.current = performance.now(); setShown(value) }, wait)
    return () => clearTimeout(t)
  }, [value, ms])
  return shown
}

export function BlurNumber({
  value, format, size = 'auto', as: As = 'span', className, style, srText
}: BlurNumberProps): React.JSX.Element {
  const reduced = useReduceMotion()
  const shown = useCoalesced(value, reduced ? 0 : HOLD.coalesce)
  const fmt = format ?? ((v: number) => defaultFormat.format(v))
  const str = fmt(shown)

  const rootRef = useRef<HTMLElement>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const [glyphs, setGlyphs] = useState<Glyph[]>(() => toGlyphs(str))
  const glyphsRef = useRef(glyphs)
  glyphsRef.current = glyphs
  const prev = useRef({ value: shown, str })
  const pending = useRef<{ enter: Glyph[]; exit: Glyph[]; trend: number; width: number } | null>(null)

  // Diff the formatted string by position-from-right.
  useLayoutEffect(() => {
    if (str === prev.current.str) return
    const trend = Math.sign(shown - prev.current.value) || 1
    prev.current = { value: shown, str }
    const width = rootRef.current?.getBoundingClientRect().width ?? 0
    const live = glyphsRef.current.filter((g) => !g.exiting)
    const byPos = new Map(live.map((g) => [g.pos, g]))
    const n = str.length
    const next: Glyph[] = []
    const enter: Glyph[] = [], exit: Glyph[] = []
    Array.from(str).forEach((char, i) => {
      const pos = n - 1 - i
      const cur = byPos.get(pos)
      if (cur && cur.char === char) { next.push(cur); return }
      if (cur) { const x = { ...cur, exiting: true }; next.push(x); exit.push(x) }
      const g = { key: `g${++glyphSeq}`, pos, char }
      next.push(g); enter.push(g)
    })
    for (const g of live) if (g.pos >= n) { const x = { ...g, exiting: true }; next.push(x); exit.push(x) }
    pending.current = { enter, exit, trend, width }
    setGlyphs(next)
  }, [str, shown])

  // Animate the committed change.
  useLayoutEffect(() => {
    const p = pending.current
    if (!p) return
    pending.current = null
    if (reduced) {
      if (p.exit.length) setGlyphs((gs) => gs.filter((g) => !g.exiting))
      return
    }
    const root = rootRef.current
    const fs = root ? parseFloat(getComputedStyle(root).fontSize) || 16 : 16
    const D = WORD_VARIANTS.digits
    const kind = size === 'auto' ? (fs >= D.large.minFontPx ? 'large' : 'default') : size
    const blur = kind === 'large' ? D.large.blur : kind === 'subtle' ? D.subtle.blur : D.blur
    const y = (kind === 'large' ? D.large.yFs : kind === 'subtle' ? D.subtle.yFs : D.yFs) * fs * p.trend
    const enterDur = kind === 'subtle' ? D.subtle.enter : D.enter
    const exitDur = kind === 'subtle' ? D.subtle.exit : D.exit

    // Right → left: rank by position, capped at 3.
    const rank = (pos: number, list: Glyph[]): number => {
      const sorted = [...new Set(list.map((g) => g.pos))].sort((a, b) => a - b)
      return Math.min(sorted.indexOf(pos), STAGGER_CAP.digits - 1)
    }
    let slots = filterBudget.take(p.enter.length + p.exit.length)
    const slot = (): boolean => (slots > 0 ? (slots--, true) : false)

    for (const g of p.exit) {
      const el = els.current.get(g.key); if (!el) continue
      const from = currentOpacity(el)
      const h = animateWord(el, {
        fill: 'forwards',
        delay: rank(g.pos, p.exit) * STAGGER.digits,
        opacity: { from, to: 0, duration: exitDur, ease: D.exitEase },
        blur: { from: 0, to: blur, duration: exitDur, ease: D.exitEase },
        y: { from: 0, to: -y, duration: exitDur, ease: D.exitEase }
      }, slot())
      h.finished.then(() => setGlyphs((gs) => gs.filter((x) => x.key !== g.key)))
    }
    for (const g of p.enter) {
      const el = els.current.get(g.key); if (!el) continue
      animateWord(el, {
        delay: rank(g.pos, p.enter) * STAGGER.digits,
        opacity: { from: 0, to: 1, duration: enterDur, ease: D.enterEase },
        blur: { from: blur, to: 0, duration: enterDur, ease: D.enterEase },
        y: { from: y, to: 0, duration: enterDur, ease: D.enterEase }
      }, slot())
    }
    if (slots > 0) filterBudget.release(slots)

    // Real width with spring.ui (exiting glyphs are absolute, so this is the new width).
    if (root) {
      const to = root.getBoundingClientRect().width
      if (Math.abs(to - p.width) > 0.5 && p.width > 0) {
        const { easing, duration } = springToLinear(SPRING.ui)
        root.animate({ width: [`${p.width}px`, `${to}px`] }, { duration, easing })
      }
    }
  }, [glyphs, reduced, size])

  // Group glyphs into slots, left → right (highest position first).
  const slotsView = useMemo(() => {
    const byPos = new Map<number, Glyph[]>()
    for (const g of glyphs) {
      const l = byPos.get(g.pos) ?? []
      l.push(g); byPos.set(g.pos, l)
    }
    return [...byPos.entries()].sort((a, b) => b[0] - a[0])
  }, [glyphs])

  if (reduced) {
    return <As className={className} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{str}</As>
  }

  return (
    <As ref={rootRef} className={`bn${className ? ' ' + className : ''}`} style={style}>
      {srText !== false && <span className="m-sr-only">{srText ?? str}</span>}
      <span className="bn-glyphs" aria-hidden="true">
        {slotsView.map(([pos, gs]) => (
          <span className="bn-slot" key={`s${pos}`}>
            {gs.map((g) => (
              <span
                key={g.key}
                className="bn-glyph"
                data-exiting={g.exiting ? '' : undefined}
                ref={(el) => { if (el) els.current.set(g.key, el); else els.current.delete(g.key) }}
              >
                {g.char}
              </span>
            ))}
          </span>
        ))}
      </span>
    </As>
  )
}

/** m:ss for the 1 Hz recording timer (use with `size="subtle"`). */
export const formatTimer = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
