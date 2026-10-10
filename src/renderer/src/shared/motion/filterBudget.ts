import { BLUR_CAP } from './tokens'

/**
 * Per-window allocator for live `filter` animations (§3.3, §3.5).
 *
 * Slots are taken per BATCH at schedule time (the first words in reading order
 * get filter keyframes, the rest animate opacity/transform only) and released
 * when each WAAPI animation settles (finish OR cancel) and on unmount. Never
 * counted on completion callbacks, which don't fire on interruption.
 */
class Pool {
  private active = 0
  constructor(readonly cap: number) {}
  /** Grants up to `k` slots; returns how many were granted. */
  take(k: number): number {
    const n = Math.max(0, Math.min(k, this.cap - this.active))
    this.active += n
    return n
  }
  release(n = 1): void { this.active = Math.max(0, this.active - n) }
  reset(): void { this.active = 0 }
  get inUse(): number { return this.active }
}

/** Live per-element filters (words, digits, small surfaces): 12 per window. */
export const filterBudget = new Pool(BLUR_CAP.live)
/** Large blurred surfaces (> 300 × 150: tiles, dialog, panel, Scratchpad card): 4 per window. */
export const largeSurfaceBudget = new Pool(BLUR_CAP.large)

/** True when an element counts as a large surface for the §3.5 cap. */
export function isLargeSurface(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > BLUR_CAP.largeSurfacePx.w && r.height > BLUR_CAP.largeSurfacePx.h
}

/** Releases one slot exactly once, whenever called (finish, cancel, unmount). */
export function onceRelease(pool: Pool = filterBudget): () => void {
  let done = false
  return () => { if (!done) { done = true; pool.release(1) } }
}

export type { Pool as FilterPool }
