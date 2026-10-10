import { filterBudget, onceRelease, type FilterPool } from './filterBudget'
import { cssEase, isReducedMotion, springToLinear, type Bezier, type SpringToken } from './tokens'

/**
 * The word engine's only animation primitive (§5 enforcement 2: "direct WAAPI
 * calls go through animateWord()"). Opacity, filter and transform run as
 * separate native animations so each can have its own duration (opacity leads
 * the blur, §3.2) and all stay off the main thread.
 *
 * At rest nothing is left behind: entrances use `fill: 'backwards'`, so once
 * they finish the element falls back to its static style, `filter: none`,
 * `transform: none`, `opacity: 1`, and the compositor layer is released.
 */

export type Ease = Bezier | SpringToken | 'linear'

export interface Channel<V> {
  from: V
  to: V
  duration: number // s (ignored for springs; the spring's settle time is used)
  ease: Ease
  delay?: number // s, added to the handle's delay
}

export interface WordKeyframes {
  delay?: number // s
  opacity?: Channel<number>
  /** blur radius in px; skipped when no filter slot is granted. */
  blur?: Channel<number>
  /** translate in px. */
  y?: Channel<number>
  x?: Channel<number>
  /** 'backwards' for entrances (rest = static style), 'forwards' for exits. */
  fill?: FillMode
}

export interface AnimHandle {
  animations: Animation[]
  /** Resolves when every channel settled (finished or cancelled). */
  finished: Promise<void>
  cancel(): void
  /** Jump to the end state in this frame. */
  finish(): void
  /** Whether the filter channel actually ran (a budget slot was used). */
  filtered: boolean
}

const EMPTY: AnimHandle = {
  animations: [], finished: Promise.resolve(), cancel() {}, finish() {}, filtered: false
}

function timing(ch: Channel<unknown>, baseDelay: number, fill: FillMode): KeyframeAnimationOptions {
  const delay = (baseDelay + (ch.delay ?? 0)) * 1000
  if (typeof ch.ease === 'object' && !Array.isArray(ch.ease)) {
    const { easing, duration } = springToLinear(ch.ease as SpringToken)
    return { duration, easing, delay, fill }
  }
  return { duration: ch.duration * 1000, easing: cssEase(ch.ease as Bezier | 'linear'), delay, fill }
}

/**
 * Animates one element. `filterSlot` says whether the caller holds a budget
 * slot for the blur channel (it is released when the blur settles, exactly
 * once). Under Reduce Motion this is a no-op and releases the slot at once.
 */
export function animateWord(
  el: Element,
  k: WordKeyframes,
  filterSlot = false,
  pool: FilterPool = filterBudget
): AnimHandle {
  const release = filterSlot ? onceRelease(pool) : () => {}
  if (isReducedMotion() || typeof (el as HTMLElement).animate !== 'function') {
    release()
    return EMPTY
  }
  const fill = k.fill ?? 'backwards'
  const base = k.delay ?? 0
  const anims: Animation[] = []

  if (k.opacity) {
    anims.push(el.animate({ opacity: [k.opacity.from, k.opacity.to] }, timing(k.opacity, base, fill)))
  }
  let filtered = false
  if (k.blur && filterSlot) {
    const a = el.animate(
      { filter: [`blur(${k.blur.from}px)`, `blur(${k.blur.to}px)`] },
      timing(k.blur, base, fill)
    )
    a.finished.then(release, release)
    anims.push(a)
    filtered = true
  } else {
    release()
  }
  if (k.x || k.y) {
    const ch = (k.y ?? k.x)!
    const fx = k.x?.from ?? 0, tx = k.x?.to ?? 0
    const fy = k.y?.from ?? 0, ty = k.y?.to ?? 0
    anims.push(el.animate(
      { transform: [`translate(${fx}px, ${fy}px)`, `translate(${tx}px, ${ty}px)`] },
      timing(ch, base, fill)
    ))
  }

  const finished = Promise.all(anims.map((a) => a.finished.then(() => {}, () => {}))).then(() => {})
  return {
    animations: anims,
    finished,
    filtered,
    cancel() { anims.forEach((a) => a.cancel()); release() },
    finish() {
      anims.forEach((a) => { try { a.finish() } catch { a.cancel() } })
      release()
    }
  }
}

/** Current computed opacity, for exits that start "from the current value" (§6.3). */
export function currentOpacity(el: Element): number {
  const v = parseFloat(getComputedStyle(el).opacity)
  return Number.isFinite(v) ? v : 1
}

/** Settle every running animation in a subtree in this frame (send-out, reduce toggles). */
export function finishAll(root: Element | Document = document): void {
  const list = root instanceof Document ? root.getAnimations() : (root as Element).getAnimations({ subtree: true })
  for (const a of list) {
    try { a.finish() } catch { a.cancel() } // infinite loops can't finish
  }
}
