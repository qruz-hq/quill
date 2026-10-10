import { useEffect, useRef } from 'react'

export type BarHitOptions = {
  /**
   * Custom hit predicate for the element under the pointer. Default:
   * `el.closest('[data-hit]')`. Only the temporary legacy bridge in
   * flowbar/main.tsx overrides it.
   */
  test?: (el: Element | null) => boolean
  /**
   * True when Esc should dismiss what is under the pointer (the error card).
   * Default: `el.closest('[data-hit-escape]')`. Main then registers a global
   * Esc and delivers it on `window.flow.bar.onEscape`.
   */
  escapeTest?: (el: Element | null) => boolean
}

const defaultTest = (el: Element | null): boolean => !!el?.closest('[data-hit]')
const defaultEscape = (el: Element | null): boolean => !!el?.closest('[data-hit-escape]')

/**
 * Renderer half of the Flow Bar click-through window (docs/MOTION.md §4.1.1).
 *
 * Main creates a fixed 400 × 260 transparent window with
 * `setIgnoreMouseEvents(true, { forward: true })`. Forwarded `mousemove`s
 * still reach the renderer; this hook hit-tests them against `[data-hit]`
 * elements and reports changes, so main can toggle ignore on/off:
 *
 *   useBarHitTest((hit, escape) => window.flow.bar.setHit(hit, { escape }))
 *
 * `false` is sent on the next move or `mouseleave` without a hit, and on window
 * `blur` (no timers: when the pointer is still there is no event).
 * Mark the shape, cards, notice pill, language menu and interactive children
 * with `data-hit`; never tooltips. Mark the error card `data-hit-escape` too.
 */
export function useBarHitTest(onChange: (hit: boolean, escape: boolean) => void, opts: BarHitOptions = {}): void {
  const last = useRef<string | null>(null)
  const cb = useRef(onChange)
  cb.current = onChange
  const o = useRef(opts)
  o.current = opts
  useEffect(() => {
    const send = (hit: boolean, escape: boolean): void => {
      const key = `${hit}:${escape}`
      if (last.current === key) return
      last.current = key
      cb.current(hit, escape)
    }
    const onMove = (e: MouseEvent): void => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const hit = (o.current.test ?? defaultTest)(el)
      send(hit, hit && (o.current.escapeTest ?? defaultEscape)(el))
    }
    const off = (): void => send(false, false)
    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', off)
    window.addEventListener('blur', off)
    // Main's backstop forced click-through without a `false` from here (a
    // missed mouseleave). Forget what was sent, so the next hover reports
    // `true` again instead of being swallowed as a repeat.
    const offReset = window.flow?.bar?.onHitReset?.(() => { last.current = null })
    return () => {
      offReset?.()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', off)
      window.removeEventListener('blur', off)
    }
  }, [])
}

/** The shape rect main polls against at 30 Hz as a backstop (`bar:shape-rect`, published on every settle). */
export function shapeRect(el: Element | null): { x: number; y: number; width: number; height: number } | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
