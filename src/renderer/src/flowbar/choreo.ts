import type { Transition } from 'motion/react'
import { DUR, DUR_MS, EASE, FLOWBAR, HOLD, SPRING, type DurToken, type EaseToken } from '../shared/motion'
import type { ExitKind, View } from './state'

/**
 * Flow Bar choreography (docs/MOTION.md §4.1). Every offset below is an
 * absolute time from a table in the spec (t = 0 is the trigger); durations,
 * curves and springs come from the shared tokens. Seconds unless named *Ms.
 */
export const AT = {
  /** §4.1.3: buttons radiate from Dictate; the shape closes after they are out. */
  capsule: { dictate: 0.02, side: 0.035, far: 0.05, shapeClose: 0.04 },
  /** §4.1.4 */
  rec: { dotPop: 0.06, wave: 0.06, timer: 0.12, pulse: 0.34 },
  /** §4.1.6: T0 of a card that first unfurls at stop, head and text at T0 + 120. */
  busy: { spinner: 0.08, track: 0.06, cardAtStopMs: 60, head: 0.12 },
  /** §4.1.8: send-out at 80, card opacity from 140, copy-fallback notice at 160. */
  done: { sendMs: 80, cardFade: 0.06, noticeMs: 160, collapseMs: DUR_MS.base + HOLD.successCheck },
  /** §4.1.9 */
  error: { glyph: 0.06, tile: 0.08, title: 0.08, ring: 0.1, body: 0.12, actions: 0.16, shapeDismiss: 0.08 },
  /** §4.1.10 */
  notice: { text: 0.06 }
} as const

/** Typed tween from tokens (same shape as the helper in shared/motion/presets). */
export function tw(d: DurToken, e: EaseToken = 'out', delay = 0): Transition {
  return {
    duration: DUR[d],
    ease: (e === 'linear' ? 'linear' : EASE[e]) as Transition['ease'],
    ...(delay ? { delay } : {})
  }
}

/** Gap between the bar's layers in every "Bar" frame of oQ6Qr. */
export const GAP = 8
/** Vertical centre of the window: cards, tooltips and the notice sit on it. */
export const MID_Y = FLOWBAR.window.height / 2

/** Shape geometry per view. Done keeps the busy pill until it collapses. */
export function shapeBox(view: View): (typeof FLOWBAR.shape)[keyof typeof FLOWBAR.shape] {
  return view === 'done' ? FLOWBAR.shape.busy : FLOWBAR.shape[view]
}

/**
 * Spring for a shape change (§2.3, §4.1.12): fluid for sliver to capsule,
 * morph between dictation states, exit for every terminal collapse.
 */
export function shapeTransition(from: View, to: View, exit: ExitKind | null): Transition {
  if (to === 'sliver') {
    if (from === 'capsule') return { ...SPRING.exit, delay: AT.capsule.shapeClose }
    if (from === 'error' && exit === 'dismiss') return { ...SPRING.exit, delay: AT.error.shapeDismiss }
    return SPRING.exit
  }
  if (to === 'capsule') return from === 'sliver' ? SPRING.fluid : SPRING.exit
  return SPRING.morph
}
