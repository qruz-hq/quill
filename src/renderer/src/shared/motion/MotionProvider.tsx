import { useSyncExternalStore, type ReactNode } from 'react'
import { LazyMotion, MotionConfig, MotionGlobalConfig, domMax, frameData, frameSteps, time } from 'motion/react'
import { SPRING, _setReducedForTokens } from './tokens'
import { finishAll } from './waapi'
import './motion.css'

/* ------------------------------------------------------------------ */
/* Reduce Motion store (§5). One per renderer, live, no relaunch.      */
/* ------------------------------------------------------------------ */

const QUERY = '(prefers-reduced-motion: reduce)'
const listeners = new Set<() => void>()
let override: boolean | null = null

const mql: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null

function compute(): boolean {
  if (override !== null) return override
  return mql?.matches ?? false
}

/*
 * Initial value before first paint: main passes `--reduce-motion=1` and the
 * preload sets `html[data-reduce-motion]` (§5 detection 2). The attribute only
 * seeds the value; the live matchMedia listener is authoritative afterwards.
 */
if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduce-motion')) {
  // Main may say "reduce" (e.g. shouldRenderRichAnimation = false) while the
  // media query doesn't; trust it until matchMedia reports a change.
  override = mql?.matches ? null : true
}

let current = compute()
apply(current)

function apply(v: boolean): void {
  _setReducedForTokens(v)
  MotionGlobalConfig.skipAnimations = v // §5 enforcement 1 (primary)
  if (typeof document !== 'undefined') {
    document.documentElement.toggleAttribute('data-reduce-motion', v)
    // Anything native already in flight jumps to its end state (WAAPI words,
    // CSS, Motion's accelerated animations).
    if (v) finishAll(document)
  }
}

/*
 * Motion keeps no public list of running animations, but every main-thread one
 * (springs on x/y/scale, layout, motion values) is ticked by its frameloop with
 * the frame's timestamp. Processing one frame an hour ahead, synchronously,
 * makes each of them resolve its final keyframe and complete. Manual timing is
 * on for that frame only, so an animation that has not ticked yet keeps its
 * start time. Infinite loops only change phase; their owners unmount them.
 */
const SETTLE_JUMP_MS = 3_600_000

function settleMotion(): void {
  if (frameData.isProcessing) { queueMicrotask(settleMotion); return } // called from inside a frame
  const manual = MotionGlobalConfig.useManualTiming
  const at = frameData.timestamp
  MotionGlobalConfig.useManualTiming = true
  try {
    // Twice: the second frame takes animations whose keyframes resolved in the first.
    for (let pass = 1; pass <= 2; pass++) {
      frameData.timestamp = at + pass * SETTLE_JUMP_MS
      time.set(frameData.timestamp)
      for (const step of Object.values(frameSteps)) step.process(frameData)
    }
  } finally {
    MotionGlobalConfig.useManualTiming = manual
    frameData.timestamp = at
    time.set(performance.now())
  }
}

function set(next: boolean): void {
  if (next === current) return
  current = next
  apply(next)
  // Live switch (§5): Motion's main-thread springs land in this task too, then
  // whatever their completions started natively.
  if (next && typeof document !== 'undefined') { settleMotion(); finishAll(document) }
  listeners.forEach((l) => l())
}

mql?.addEventListener('change', () => { override = null; set(compute()) })

/**
 * Main-process backstop (§5 detection 3): wire the `motion:reduced` broadcast
 * here. Pass `null` to hand control back to matchMedia.
 */
export function setReducedMotionOverride(v: boolean | null): void {
  override = v
  set(compute())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const getSnapshot = (): boolean => current

/** Live macOS Reduce Motion. Works with or without a provider above. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/* ------------------------------------------------------------------ */
/* Provider                                                            */
/* ------------------------------------------------------------------ */

/**
 * Wrap every renderer root (hub, flowbar, scratchpad, todos `main.tsx`).
 * `strict` LazyMotion: components must use `m.*`, never `motion.*`.
 * The default transition is our token (`spring.ui`), never Motion's defaults.
 */
export function MotionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const reduced = useReduceMotion()
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig
        transition={reduced ? { duration: 0 } : SPRING.ui}
        reducedMotion={reduced ? 'always' : 'never'}
        skipAnimations={reduced}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  )
}

/** Alias matching the spec's module name (§6.2 `MotionRoot.tsx`). */
export const MotionRoot = MotionProvider

/* The first-show gate (`useWindowShown`, §3.6) lives in ./windowShown. */

/** Live document visibility; live-update choreographies apply the end state while hidden. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { document.addEventListener('visibilitychange', cb); return () => document.removeEventListener('visibilitychange', cb) },
    () => document.visibilityState === 'visible',
    () => true
  )
}

/* ------------------------------------------------------------------ */
/* Input modality (§6.3 Keyboard)                                      */
/* ------------------------------------------------------------------ */

let modality: 'pointer' | 'keyboard' = 'pointer'
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { modality = 'pointer' }, true)
  document.addEventListener('keydown', () => { modality = 'keyboard' }, true)
}
/** Gate optional motion: keyboard-driven actions don't animate (menus, highlights). */
export const inputModality = (): 'pointer' | 'keyboard' => modality
