import { setReducedMotionOverride } from './MotionProvider'

/**
 * Connects this renderer to main's Reduce Motion signals (docs/MOTION.md §5).
 * Call once per window root, before render.
 *
 * - The launch value already arrived as html[data-reduce-motion] (preload,
 *   from `--reduce-motion=1`), which MotionProvider seeds from.
 * - Live: main re-reads `systemPreferences.getAnimationSettings()` on the
 *   NSWorkspace accessibility notification and broadcasts `motion:reduced`.
 *   `true` forces reduce; `false` hands control back to matchMedia, which
 *   stays authoritative.
 *
 * Safe outside Electron (the Motion Lab): `window.flow` is then missing.
 */
export function connectMainMotion(): () => void {
  const api = typeof window !== 'undefined' ? window.flow?.motion : undefined
  if (!api) return () => {}
  return api.onReduced((v) => setReducedMotionOverride(v ? true : null))
}

/**
 * Main's `win:shown` after show()/showInactive(), every show (re-shows too).
 * For the first-show gate use `useWindowShown()`, which already listens.
 */
export function onWinShown(cb: () => void): () => void {
  const api = typeof window !== 'undefined' ? window.flow?.win : undefined
  return api ? api.onShown(() => cb()) : () => {}
}
