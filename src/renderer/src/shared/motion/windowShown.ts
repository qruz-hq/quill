import { useEffect, useSyncExternalStore } from 'react'
import { HOLD } from './tokens'

/* ------------------------------------------------------------------ */
/* Visibility gate for first-show entrances (§3.6)                     */
/* ------------------------------------------------------------------ */

/*
 * One store per renderer. In Electron the document cannot tell by itself when
 * the window reaches the screen: a window created with `show:false` paints
 * while hidden (paintWhenInitiallyHidden), so `document.visibilityState` is
 * already 'visible' at mount. Only main knows, and says so with `win:shown`.
 *
 * - Electron (`window.flow.win` exists): true at once when `win.shown()` says
 *   the window was already shown, else false until `win:shown` + one rAF. The
 *   listener is registered when this module loads, so a component that mounts
 *   after the show reads true at once. `hold.closeTimeout` after the first
 *   subscriber is the backstop for an event that never comes when main cannot
 *   be asked; with `win.shown()` it is `hold.shownBackstop`, a last resort.
 * - Plain browser (Motion Lab, headless harness without a `flow.win` stub):
 *   visibility is truthful there, so first `visible` + one rAF.
 */

let shown = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function mark(): void {
  if (shown) return
  shown = true
  if (timer !== null) { clearTimeout(timer); timer = null }
  listeners.forEach((l) => l())
}
/** One frame after the signal, so the initial frame is on screen before the entrance starts. */
const markNextFrame = (): void => { requestAnimationFrame(mark) }

const mainWin = typeof window !== 'undefined' ? window.flow?.win : undefined

if (mainWin) {
  // The preload asked main before any page script ran (the Flow Bar, a reload
  // of a visible window), and keeps the answer current from `win:shown`.
  if (mainWin.shown?.()) shown = true
  else mainWin.onShown(markNextFrame)
} else if (typeof document !== 'undefined') {
  if (document.visibilityState === 'visible') shown = true
  else {
    const onVis = (): void => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', onVis)
      markNextFrame()
    }
    document.addEventListener('visibilitychange', onVis)
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  // Backstop, Electron only: also covers a rAF that never fires.
  // With `win.shown()` main is authoritative (null = really not shown yet), so
  // a slow cold launch must not trip it: wait much longer. Without it (an older
  // preload, a stub) the page cannot ask, so `hold.closeTimeout` it is.
  if (mainWin && !shown && timer === null) {
    timer = setTimeout(mark, typeof mainWin.shown === 'function' ? HOLD.shownBackstop : HOLD.closeTimeout)
  }
  return () => { listeners.delete(cb) }
}
const getSnapshot = (): boolean => shown

/**
 * False until the window is really on screen, then true for good. First-show
 * entrances render their initial frame until this flips. True at mount only
 * when the window was already shown (main said so, or the backstop elapsed).
 *
 * `subscribeShown` is optional and kept for callers that pass `onWinShown`:
 * the store listens to main by itself.
 */
export function useWindowShown(subscribeShown?: (cb: () => void) => () => void): boolean {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => true)
  useEffect(() => {
    if (shown || !subscribeShown) return
    return subscribeShown(markNextFrame)
  }, [subscribeShown])
  return value
}

/**
 * The same gate outside React: calls `cb` once, when the window is shown (at
 * once if it already is). Returns an unsubscribe.
 */
export function whenWindowShown(cb: () => void): () => void {
  if (shown) { cb(); return () => {} }
  const once = (): void => { off(); cb() }
  const off = subscribe(once)
  return off
}
