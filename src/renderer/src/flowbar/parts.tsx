import {
  createContext, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type Ref
} from 'react'
import { m, useIsPresent, usePresence, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import {
  BlurNumber, EASE, HOLD, SCALE, SPRING, animateWord, currentOpacity, filterBudget, formatTimer,
  presets, useReduceMotion, type AnimHandle
} from '../shared/motion'
import { MID_Y, tw } from './choreo'
import type { ExitKind } from './state'

/* ------------------------------------------------------------------ */
/* Which card is leaving, and how                                      */
/* ------------------------------------------------------------------ */

/**
 * An exiting card renders from its last props, so the reason it left travels
 * by context: `useLeaveKind(cardId)` is the exit kind while that card is the
 * one leaving, and null while it is alive (a content swap inside it).
 */
export const LeaveContext = createContext<{ id: number; kind: ExitKind } | null>(null)
export function useLeaveKind(cardId: number): ExitKind | null {
  const leave = useContext(LeaveContext)
  return leave && leave.id === cardId ? leave.kind : null
}

/* ------------------------------------------------------------------ */
/* BlurUnit: one element, opacity + blur as a unit, on the 12 budget   */
/* ------------------------------------------------------------------ */

export interface UnitEnter { delay?: number; duration: number; blur?: number }
export interface UnitExit { duration: number; blur?: number; x?: number }

/**
 * A unit that fades (and optionally blurs) in on mount and out on exit, through
 * the shared word engine: `animateWord` takes a slot from the window's 12
 * filter budget, skips the blur when none is free, releases on settle and does
 * nothing under Reduce Motion. At rest the element has `filter: none`.
 */
export function BlurUnit({
  as: As = 'div', enter, exit, out = null, children, ref, ...rest
}: {
  as?: 'div' | 'span'
  enter?: UnitEnter
  /** Played when the unit itself is removed from an AnimatePresence. */
  exit?: UnitExit | null
  /** Played when it turns non-null while the unit stays mounted (its surface is leaving around it). */
  out?: UnitExit | null
  children?: ReactNode
  ref?: Ref<HTMLElement>
  className?: string
  style?: CSSProperties
  role?: string
  'aria-hidden'?: boolean
}): React.JSX.Element {
  const el = useRef<HTMLElement | null>(null)
  const [present, safeToRemove] = usePresence()
  const handle = useRef<AnimHandle | null>(null)
  const exitRef = useRef(exit)
  exitRef.current = exit

  useLayoutEffect(() => {
    const node = el.current
    if (!node || !enter) return
    const { delay = 0, duration, blur } = enter
    handle.current = animateWord(node, {
      delay,
      opacity: { from: 0, to: 1, duration, ease: EASE.out },
      blur: blur ? { from: blur, to: 0, duration, ease: EASE.out } : undefined
    }, blur ? filterBudget.take(1) === 1 : false)
    return () => { handle.current?.cancel(); handle.current = null }
    // Mount only: the entrance never replays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Leaves from its current opacity (§6.3); the entrance, if still running, is dropped.
  const leave = (x: UnitExit): AnimHandle | null => {
    const node = el.current
    if (!node) return null
    const from = currentOpacity(node)
    handle.current?.cancel()
    handle.current = animateWord(node, {
      fill: 'forwards',
      opacity: { from, to: 0, duration: x.duration, ease: EASE.exit },
      blur: x.blur ? { from: 0, to: x.blur, duration: x.duration, ease: EASE.exit } : undefined,
      x: x.x ? { from: 0, to: x.x, duration: x.duration, ease: EASE.exit } : undefined
    }, x.blur ? filterBudget.take(1) === 1 : false)
    return handle.current
  }

  useLayoutEffect(() => {
    if (present) return
    const h = exitRef.current ? leave(exitRef.current) : null
    if (!h) { safeToRemove?.(); return }
    void h.finished.then(() => safeToRemove?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, safeToRemove])

  const going = out !== null
  useLayoutEffect(() => {
    if (out) leave(out)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [going])

  const setRef = (node: HTMLElement | null): void => {
    el.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }
  return <As ref={setRef} {...rest}>{children}</As>
}

/* ------------------------------------------------------------------ */
/* Reduce Motion: no first frame to animate from                       */
/* ------------------------------------------------------------------ */

type Plain = Record<string, unknown>
const sharp = (v: unknown): unknown => {
  if (typeof v !== 'object' || v === null) return v
  const { filter: _filter, transitionEnd: _end, ...rest } = v as Plain
  return rest
}
/** The same variants with no `filter` key at all, for Reduce Motion (nothing may carry a filter, §5). */
export function withoutBlur(variants: Variants): Variants {
  const out: Plain = {}
  for (const [k, v] of Object.entries(variants)) {
    out[k] = typeof v === 'function' ? (...a: unknown[]) => sharp((v as (...x: unknown[]) => unknown)(...a)) : sharp(v)
  }
  return out as Variants
}

/**
 * `initial` for an entering layer. Reduce Motion mounts it at its end state
 * (`false`), so not even one frame of the hidden first keyframe is painted.
 */
export function useInitial<I>(initial: I): I | false {
  return useReduceMotion() ? false : initial
}

/* ------------------------------------------------------------------ */
/* Timer                                                               */
/* ------------------------------------------------------------------ */

/** m:ss from `from` to `to` (or to now while `to` is null). A leaf, so its 4 Hz tick renders nothing else. */
export function Timer({ from, to }: { from: number | null; to: number | null }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (to !== null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [to, from])
  const ms = from === null ? 0 : Math.max(0, (to ?? now) - from)
  // Never announced (§3.4): no sr-only twin, and callers keep it out of live regions.
  return <BlurNumber value={Math.floor(ms / 1000)} format={formatTimer} size="subtle" srText={false} />
}

/* ------------------------------------------------------------------ */
/* Pill glyphs                                                         */
/* ------------------------------------------------------------------ */

/** Spinner / error icon entering the pill: `scale.exitIcon` to 1 on `spring.snappy`. */
export function glyphIn(delay: number, opacity = true): Variants {
  return {
    initial: { scale: SCALE.exitIcon, ...(opacity ? { opacity: 0 } : {}) },
    animate: {
      scale: 1, ...(opacity ? { opacity: 1 } : {}),
      transition: { default: { ...SPRING.snappy, delay }, opacity: tw('fast', 'out', delay) }
    },
    exit: { opacity: 0, transition: tw('flash', 'out') }
  }
}

/**
 * Busy Pill "Spinner": 16 ring, innerRadius 0.78 (1.76 thick), $bar-line track,
 * $cyan 110 degree arc, on `loop.spin`. Reduce Motion: a static busy glyph.
 */
export function Spinner(): React.JSX.Element {
  const reduced = useReduceMotion()
  if (reduced) return <Icon name="ellipsis" className="fb-spinner fb-spinner--static" />
  const w = 8 * (1 - 0.78)
  const r = 8 - w / 2
  const c = 2 * Math.PI * r
  return (
    <m.span className="fb-spinner" {...presets.spin}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
        <circle className="fb-spinner__track" cx="8" cy="8" r={r} strokeWidth={w} fill="none" />
        <circle
          className="fb-spinner__arc" cx="8" cy="8" r={r} strokeWidth={w} fill="none"
          strokeDasharray={`${(c * 110) / 360} ${c}`}
          transform="rotate(-60 8 8)"
        />
      </svg>
    </m.span>
  )
}

/** Done check: the centre line of the 16 px `check` glyph, so it can stroke in (`presets.checkStroke`). */
export function Check(): React.JSX.Element {
  return (
    <svg className="fb-check" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <m.path
        d="M3 9.5L4 10.5Q5 11.5 6 10.5L12.5 4"
        stroke="currentColor" strokeWidth="1.5"
        variants={presets.checkStroke}
      />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */

const TIP = presets.barTooltip
const { transition: tipTween, ...tipTo } = TIP.animate as TargetAndTransition
/** Tooltip iIu70 is 28 high; `centre` is the y it is centred on. */
export const TIP_H = 28

/**
 * Bar tooltip (§4.1.3): slides out from the bar (`presets.barTooltip`), then
 * follows the hovered button on `spring.fluid`. `instant` skips the entrance
 * (inside `hold.tooltipGrace`). Render inside an AnimatePresence.
 */
export function BarTooltip({
  centre = MID_Y, instant = false, onClick, label, children
}: {
  centre?: number
  instant?: boolean
  /** Makes it the interactive Cancel pill (a button, a hit target). */
  onClick?: () => void
  label?: string
  children: ReactNode
}): React.JSX.Element {
  const present = useIsPresent()
  const reduced = useReduceMotion()
  const y = centre - TIP_H / 2
  const initial = instant || reduced ? false : { ...(TIP.initial as TargetAndTransition), y }
  const animate: TargetAndTransition = { ...tipTo, y, transition: { default: tipTween, y: SPRING.fluid } }
  const exit = TIP.exit as TargetAndTransition
  return onClick
    ? (
        <m.button
          className="fb-tooltip" initial={initial} animate={animate} exit={exit} inert={!present}
          type="button" data-hit="" data-zone="bar" onClick={onClick} aria-label={label}
        >
          {children}
        </m.button>
      )
    : (
        <m.div className="fb-tooltip" initial={initial} animate={animate} exit={exit} inert={!present} role="tooltip">
          {children}
        </m.div>
      )
}

/**
 * Tooltip timing: the first one waits `hold.tooltipDelay`; moving to another
 * target swaps at once; for `hold.tooltipGrace` after a close the next opens
 * with no delay and no animation.
 */
export function useTooltip(target: number | null): { index: number; instant: boolean } | null {
  const [shown, setShown] = useState<{ index: number; instant: boolean } | null>(null)
  const closedAt = useRef(-Infinity)
  useEffect(() => {
    if (target === null) {
      if (shown) { closedAt.current = performance.now(); setShown(null) }
      return
    }
    if (shown) {
      if (shown.index !== target) setShown({ index: target, instant: shown.instant })
      return
    }
    if (performance.now() - closedAt.current < HOLD.tooltipGrace) {
      setShown({ index: target, instant: true })
      return
    }
    const t = setTimeout(() => setShown({ index: target, instant: false }), HOLD.tooltipDelay)
    return () => clearTimeout(t)
  }, [target, shown])
  return shown
}

/* ------------------------------------------------------------------ */
/* Holds                                                               */
/* ------------------------------------------------------------------ */

/**
 * Auto-dismiss hold that pauses (keeps its remaining time) while `paused`:
 * notices and errors pause on hover and focus-within (§6.3, WCAG 2.2.1).
 * Restarts whenever `key` changes; `ms` null means no hold.
 */
export function useHold(key: unknown, ms: number | null, paused: boolean, onDone: () => void): void {
  const left = useRef(0)
  const cb = useRef(onDone)
  cb.current = onDone
  useEffect(() => { left.current = ms ?? 0 }, [key, ms])
  useEffect(() => {
    if (ms === null || paused) return
    const t0 = performance.now()
    const id = setTimeout(() => cb.current(), left.current)
    return () => {
      clearTimeout(id)
      left.current = Math.max(0, left.current - (performance.now() - t0))
    }
  }, [key, ms, paused])
}
