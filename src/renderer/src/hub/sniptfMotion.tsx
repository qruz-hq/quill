import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode, type RefObject
} from 'react'
import { m } from 'motion/react'
import {
  DUR, DUR_MS, EASE, HOLD, SPRING, WORD_VARIANTS, animateWord, filterBudget, isReducedMotion, presets,
  useReduceMotion
} from '../shared/motion'

/* Motion pieces shared by the Snippets and Transforms screens and their
   dialogs (docs/MOTION.md §4.8, §4.13). Everything here is built from the
   shared tokens and presets; no raw durations or curves. */

/* ------------------------------------------------------------------ */
/* Press                                                               */
/* ------------------------------------------------------------------ */

/**
 * Press feedback for a shared (non-motion) button: `spring.snap` down on
 * pointerdown, `spring.snappy` back (§4.13). The wrapper takes the scale so the
 * button keeps its own styles; a disabled button swallows the pointer event,
 * so it never scales. Motion makes any `whileTap` element a tab stop; the
 * wrapper opts out, so Tab goes straight to the button inside.
 */
export function Press({ kind = 'button', className, children }: {
  kind?: 'button' | 'icon' | 'card'; className?: string; children: ReactNode
}): React.JSX.Element {
  return (
    <m.span className={`sm-press${className ? ' ' + className : ''}`} tabIndex={-1} {...presets.press(kind)}>
      {children}
    </m.span>
  )
}

/* ------------------------------------------------------------------ */
/* Text swap, highlight, real height                                   */
/* ------------------------------------------------------------------ */

/**
 * `block` re-reveal (opacity 0.35 to 1 with blur 3 to 0) on the returned ref
 * whenever `value` changes after mount. Used for row and card text that
 * ellipsizes or clamps, where per-word spans would break the truncation.
 */
export function useSwapReveal<E extends HTMLElement>(value: unknown): RefObject<E | null> {
  const ref = useRef<E>(null)
  const prev = useRef(value)
  useLayoutEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    const el = ref.current
    if (!el) return
    const B = WORD_VARIANTS.block
    animateWord(el, {
      opacity: { from: B.from, to: 1, duration: B.opacity, ease: B.ease },
      blur: { from: B.blur, to: 0, duration: B.filter, ease: B.ease }
    }, filterBudget.take(1) === 1)
  }, [value])
  return ref
}

/**
 * Update highlight (§4.8): appears instantly, holds `hold.highlight`, fades
 * over `dur.moderate`. Removed entirely under Reduce Motion (§5). Mount it with
 * a fresh `key` per update; clear that state in `onDone`, or a remount of the
 * row would replay it.
 */
export function Highlight({ className, onDone }: { className: string; onDone?: () => void }): React.JSX.Element | null {
  const reduced = useReduceMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const [done, setDone] = useState(false)
  // WAAPI, not a Motion `initial`: rows that were present when their list first
  // rendered sit in a presence context that suppresses `initial` for good.
  useLayoutEffect(() => {
    let live = true
    const end = (): void => { if (live) { setDone(true); onDone?.() } }
    const el = ref.current
    if (!el) { end(); return }
    const h = animateWord(el, {
      fill: 'forwards',
      opacity: { from: 1, to: 0, duration: DUR.moderate, ease: EASE.out, delay: HOLD.highlight / 1000 }
    })
    void h.finished.then(end)
    return () => { live = false; h.cancel() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (reduced || done) return null
  return <span ref={ref} aria-hidden="true" className={className} />
}

/** Real height follows the content's measured height with `spring.ui` (never `layout` on text). */
export function FollowHeight({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  const inner = useRef<HTMLDivElement>(null)
  const [h, setH] = useState<number | 'auto'>('auto')
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <m.div className={className} initial={false} animate={{ height: h }} transition={SPRING.ui} style={{ overflow: 'hidden' }}>
      <div ref={inner}>{children}</div>
    </m.div>
  )
}

/**
 * Completion thresholds for the layout springs of the card and dialog morph.
 * The curves are still `spring.morph` / `spring.exit`; this only lets Motion
 * report "done" once the box is within 0.2 % of its travel, instead of trailing
 * a sub-pixel tail for a few hundred ms while the list update (on close) and
 * the dialog's selection indicators (on open) wait on it.
 */
export const MORPH_SETTLE = { restDelta: 2, restSpeed: 60 } as const

/* ------------------------------------------------------------------ */
/* Dialog host                                                         */
/* ------------------------------------------------------------------ */

export interface DialogOpen<V> {
  value: V
  /** Presence key: a new one per open, so a reopen never reuses an exiting dialog. */
  key: number
  /** The trigger's centre in viewport px (`transform-origin` of a button dialog). */
  origin: { x: number; y: number } | null
  /** Set when the dialog is a container transform of a card (`layoutId`). */
  morphId?: string
}

export interface DialogHost<V> {
  open: DialogOpen<V> | null
  /** The card a morph dialog is closing back into, until its exit completes. */
  returning: string | null
  /** `from` gives the origin; focus returns to `focus` (default: `from`). */
  show: (value: V, from: Element | null, opts?: { morphId?: string; focus?: HTMLElement | null }) => void
  /** Closes now; `then` is the list update that follows the close (§4.8 "Save"). */
  close: (then?: () => void) => void
  /** Pass to the dialog's `AnimatePresence onExitComplete`. */
  settled: () => void
}

/**
 * Open/close state for one dialog at a time.
 *
 * - Focus returns to the trigger at t = 0 of the close (§6.3).
 * - The list update that follows a Save or Delete runs at t = 80 for a button
 *   dialog. For a card morph it waits for the exit to complete: updating the
 *   grid mid-flight would remount the card the dialog is morphing back into.
 * - While an exit is in flight, new opens are ignored (it lasts at most the
 *   close spring), so two dialogs never share a `layoutId`.
 */
export function useDialogHost<V>(): DialogHost<V> {
  const [open, setOpen] = useState<DialogOpen<V> | null>(null)
  const [returning, setReturning] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const seq = useRef(0)
  const closing = useRef(false)
  const closeSeq = useRef(0)
  const trigger = useRef<HTMLElement | null>(null)
  const after = useRef<(() => void)[]>([])
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const later = useCallback((fn: () => void, ms: number): void => {
    const t = setTimeout(() => { timers.current.delete(t); fn() }, ms)
    timers.current.add(t)
  }, [])
  useEffect(() => () => { timers.current.forEach(clearTimeout) }, [])

  const settled = useCallback(() => {
    if (!closing.current) return
    closing.current = false
    setReturning(null)
    const fns = after.current
    after.current = []
    fns.forEach((fn) => fn())
  }, [])

  const show = useCallback<DialogHost<V>['show']>((value, from, opts) => {
    if (openRef.current || closing.current) return
    const r = from?.getBoundingClientRect()
    trigger.current = opts?.focus ?? (from instanceof HTMLElement ? from : null)
    setOpen({
      value,
      key: ++seq.current,
      origin: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
      morphId: opts?.morphId
    })
  }, [])

  const close = useCallback<DialogHost<V>['close']>((then) => {
    const cur = openRef.current
    if (!cur) return
    openRef.current = null
    closing.current = true
    const reduced = isReducedMotion()
    if (then) {
      if (cur.morphId && !reduced) after.current.push(then)
      else later(then, reduced ? 0 : DUR_MS.flash)
    }
    setReturning(cur.morphId ?? null)
    setOpen(null)
    // Backstop: if the exit never reports back, unlock after the longest choreography.
    const id = ++closeSeq.current
    later(() => { if (closeSeq.current === id) settled() }, DUR_MS.signature)
  }, [later, settled])

  // Focus back to the trigger at t = 0. A morphed card is hidden until the
  // commit after the close, so retry on the next frame.
  useLayoutEffect(() => {
    if (open) return
    const el = trigger.current
    if (!el) return
    trigger.current = null
    const go = (): boolean => {
      if (!el.isConnected) return true
      el.focus({ preventScroll: true })
      return document.activeElement === el
    }
    if (go()) return
    const raf = requestAnimationFrame(() => { if (!go()) requestAnimationFrame(go) })
    return () => cancelAnimationFrame(raf)
  }, [open])

  return { open, returning, show, close, settled }
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

/** Re-renders once a minute while mounted, for relative times. */
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}
