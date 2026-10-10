/**
 * Pacing queue for live words. Speech services deliver words in batches (one
 * update a second carrying four words, or a burst every second and a half);
 * shown as they arrive, they read as stutter. The pacer takes whatever comes
 * in and hands the words out ONE AT A TIME on a steady clock, timed so the
 * queue runs dry just as the next batch is due.
 *
 * No DOM and no framework in here: the owner passes what to do with a released
 * item, and (for tests) the clock.
 */

export const PACE = {
  /** Expected time between batches before any has been seen (ms). */
  seedMs: 1000,
  /** Weight of the newest gap in the running average of the time between batches. */
  alpha: 0.3,
  /** No two releases are closer than this, and none waits longer than `maxMs` (ms). */
  minMs: 90,
  maxMs: 320,
  /** With more than this many waiting, release at `minMs` until it is back under. */
  rushAbove: 8,
  /** Never hold more than this: older waiting items are dropped, they would be stale on arrival. */
  maxQueue: 16,
  /** flush(): the rest goes out this far apart, for at most this long; what is left is dropped (ms). */
  flushStepMs: 40,
  flushBudgetMs: 400
} as const

export interface PacerClock {
  now(): number
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realClock: PacerClock = {
  now: () => performance.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

export class Pacer<T extends { id: string }> {
  private queue: T[] = []
  private ema: number
  private lastBatch: number | null = null
  private measured = false
  private lastRelease = -Infinity
  private timer: unknown = null
  private flushing: (() => void) | null = null
  private stopped = false

  constructor(
    private readonly release: (item: T) => void,
    private readonly clock: PacerClock = realClock,
    private readonly pace: typeof PACE = PACE
  ) {
    this.ema = pace.seedMs
  }

  /** How many items are waiting. */
  get size(): number { return this.queue.length }

  /**
   * The wait before the next release (ms). What is waiting is spread over the
   * time left until the next batch is expected, with one more slot kept for
   * that batch's first word, so the rhythm carries across batches instead of
   * bunching at each arrival. A batch that is overdue leaves a whole average
   * gap to spread over.
   */
  get interval(): number {
    const n = this.queue.length
    if (n > this.pace.rushAbove) return this.pace.minMs
    const left = this.lastBatch === null ? this.ema : this.lastBatch + this.ema - this.clock.now()
    const span = left > 0 ? left : this.ema
    return Math.min(this.pace.maxMs, Math.max(this.pace.minMs, span / (n + 1)))
  }

  /** One batch, in reading order. The first item after an empty queue goes out at once. */
  push(items: readonly T[]): void {
    if (this.stopped || this.flushing || !items.length) return
    const now = this.clock.now()
    if (this.lastBatch !== null) {
      const gap = now - this.lastBatch
      // The first real gap replaces the guess outright; later ones are averaged in.
      this.ema = this.measured ? this.ema + this.pace.alpha * (gap - this.ema) : gap
      this.measured = true
    }
    this.lastBatch = now
    this.queue.push(...items)
    if (this.queue.length > this.pace.maxQueue) this.queue.splice(0, this.queue.length - this.pace.maxQueue)
    // "At once", but never closer than `minMs` to the release before it.
    if (this.timer === null) this.wait(this.lastRelease + this.pace.minMs - now)
  }

  /** A correction to an item that is still waiting. False when it is not in the queue (already out, or never in). */
  replace(id: string, item: T): boolean {
    const i = this.queue.findIndex((q) => q.id === id)
    if (i < 0) return false
    this.queue[i] = item
    return true
  }

  /** Takes a waiting item out. False when it is not in the queue. */
  remove(id: string): boolean {
    const i = this.queue.findIndex((q) => q.id === id)
    if (i < 0) return false
    this.queue.splice(i, 1)
    return true
  }

  /**
   * The stream is over: what is still waiting goes out quickly (`flushStepMs`
   * apart, `flushBudgetMs` at most, the rest dropped), then `done` is called.
   * Nothing more is accepted afterwards.
   */
  flush(done: () => void): void {
    if (this.stopped) { done(); return }
    if (this.flushing) return
    this.flushing = done
    if (this.timer !== null) { this.clock.clear(this.timer); this.timer = null }
    this.queue.length = Math.min(this.queue.length, Math.floor(this.pace.flushBudgetMs / this.pace.flushStepMs))
    this.tick()
  }

  /** Stops everything; nothing more is released. */
  clear(): void {
    this.stopped = true
    if (this.timer !== null) { this.clock.clear(this.timer); this.timer = null }
    this.queue = []
    this.flushing = null
  }

  private wait(ms: number): void {
    if (ms <= 0) { this.tick(); return }
    this.timer = this.clock.set(() => { this.timer = null; this.tick() }, ms)
  }

  private tick(): void {
    const item = this.queue.shift()
    if (item) {
      this.lastRelease = this.clock.now()
      this.release(item)
    }
    if (this.stopped) return
    if (this.queue.length) {
      // Set through the clock even at 0 so a release never re-enters another.
      this.timer = this.clock.set(() => { this.timer = null; this.tick() }, this.flushing ? this.pace.flushStepMs : this.interval)
    } else if (this.flushing) {
      const done = this.flushing
      this.flushing = null
      this.stopped = true
      done()
    }
  }
}
