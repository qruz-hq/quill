import {
  DUR, EASE, animateWord, createPartialFeed, cssEase, currentOpacity, filterBudget,
  isReducedMotion, type AnimHandle
} from '../../shared/motion'
import { Pacer } from './pacer'

/* Storyboard H, "Try it: live words" (design.pen faHiK), as reworked after
   seeing it with real services: the words come in on a paced clock (pacer.ts)
   and sit on ONE line that slides left like a ticker. The values that are not
   shared tokens yet are named here, to be moved there. */
export const TRY_IT = {
  /** A new word: opacity 0 to 1, blur 6 to 0, x +10 to 0, about 220 ms ease-out. */
  enter: { blur: 6, x: 10, duration: 0.22, ease: EASE.out },
  /** It holds $lime this long (ms), then tweens to $fg over `dur.base` (CSS). */
  limeHoldMs: 400,
  /** The line makes room: one transform on the line, retargeted at each word. */
  slide: { duration: 0.22, ease: EASE.out },
  /** Opacity by age, newest first, as drawn in rBxrj; each step takes `dur.moderate`. */
  ageOpacity: [1, 1, 0.7, 0.45, 0.25],
  ageStep: { duration: DUR.moderate, ease: EASE.standard },
  /** A word corrected on screen: its text changes in place under a short dip. */
  correction: { to: 0.6, duration: 0.12 },
  /** Trail to sentence, and every other swap of the tile's content (s). */
  crossFade: DUR.moderate
} as const

interface Shown {
  id: string; el: HTMLElement; hold?: ReturnType<typeof setTimeout>; enter?: AnimHandle
  /** The opacity its age gives it, and the step that is taking it there. */
  target: number; step?: Animation
}

/**
 * The words heard, as a one-line ticker. It is fed the full running text of
 * each partial and diffs it by word. New words wait in the pacer and reach the
 * line one at a time; the newest sits at the right end of the track and the
 * line slides left to make room, older words fading under the track's left
 * edge (a CSS mask) until they are past it and removed.
 *
 * The DOM is written directly: the timing of each word must not wait on a render.
 */
export class Trail {
  private feed = createPartialFeed()
  private shown: Shown[] = []
  private pacer: Pacer<{ id: string }>
  private line: HTMLElement
  /** Width of the words already removed from the left: the line keeps its place without them. */
  private gone = 0
  private x = 0
  private slide: Animation | null = null
  private placed = false
  private dead = false

  /** `track` is the viewport (the tile's content width); the line is created inside it. */
  constructor(private track: HTMLElement) {
    this.line = document.createElement('div')
    this.line.className = 'ob-trail__line'
    track.appendChild(this.line)
    this.pacer = new Pacer<{ id: string }>((w) => this.land(w.id))
  }

  /** One partial (the whole text so far). */
  partial(text: string): void {
    if (this.dead) return
    const res = this.feed.push(text)
    if (!res) return
    for (const d of res.deleted) {
      if (this.pacer.remove(d.id)) continue
      const w = this.shown.find((s) => s.id === d.id)
      // A shown word the recogniser took back goes at once; the line closes up (place, below).
      if (w) this.remove(w)
    }
    const raw = new Map(res.words.map((w) => [w.id, w.raw]))
    let changed = res.deleted.length > 0
    for (const id of [...res.substituted, ...res.retexted]) {
      // A word still waiting needs nothing: it reads its text when it is released.
      const w = this.shown.find((s) => s.id === id)
      if (!w) continue
      w.el.textContent = raw.get(id) ?? ''
      changed = true
      // A correction on screen: no re-entry, a short dip while the text changes.
      if (res.substituted.includes(id) && !isReducedMotion()) {
        const at = currentOpacity(w.el)
        w.el.animate({ opacity: [at, at * TRY_IT.correction.to, at] }, { duration: TRY_IT.correction.duration * 1000, easing: 'linear' })
      }
    }
    if (changed) this.place()
    this.pacer.push(res.inserted.map((id) => ({ id })))
  }

  /** The dictation is over: the words still waiting come out quickly, then `done`. */
  flush(done: () => void): void { this.pacer.flush(done) }

  destroy(): void {
    this.dead = true
    this.pacer.clear()
    this.slide?.cancel()
    for (const w of this.shown) { clearTimeout(w.hold); w.step?.cancel(); w.enter?.cancel() }
  }

  /** The pacer released a word: it enters at the right end and the line makes room. */
  private land(id: string): void {
    if (this.dead) return
    const words = this.feed.words
    const index = words.findIndex((w) => w.id === id)
    if (index < 0) return
    const el = document.createElement('span')
    el.className = 'ob-trail__word is-new'
    el.textContent = words[index].raw
    // Reading order: before the first shown word that follows it in the text.
    const after = this.shown.findIndex((s) => words.findIndex((w) => w.id === s.id) > index)
    const w: Shown = { id, el, target: 1 }
    if (after < 0) { this.line.appendChild(el); this.shown.push(w) }
    else { this.line.insertBefore(el, this.shown[after].el); this.shown.splice(after, 0, w) }

    const e = TRY_IT.enter
    w.enter = animateWord(el, {
      opacity: { from: 0, to: 1, duration: e.duration, ease: e.ease },
      blur: { from: e.blur, to: 0, duration: e.duration, ease: e.ease },
      x: { from: e.x, to: 0, duration: e.duration, ease: e.ease }
    }, filterBudget.take(1) === 1)
    w.hold = setTimeout(() => el.classList.remove('is-new'), TRY_IT.limeHoldMs)

    this.sweep()
    this.place()
    this.age()
  }

  /** Words whose right edge is past the track's left edge are gone for good. */
  private sweep(): void {
    const x = this.currentX()
    while (this.shown.length > 1) {
      const w = this.shown[0]
      if (this.gone + w.el.offsetLeft + w.el.offsetWidth + x >= 0) break
      // The line keeps its place: what the word and its gap took is added to its left.
      this.gone += this.shown[1].el.offsetLeft - w.el.offsetLeft
      this.remove(w)
    }
    this.line.style.left = `${this.gone}px`
  }

  /**
   * Where the line sits. Shorter than the track: centred, growing from the
   * middle. Longer: its right end at the track's right end, the rest sliding
   * out to the left. One transform, started from where the line is now.
   */
  private place(): void {
    const track = this.track.clientWidth
    const length = this.gone + this.line.offsetWidth
    const to = length <= track ? (track - length) / 2 : track - length
    const from = this.currentX()
    this.x = to
    this.slide?.cancel()
    this.slide = null
    this.line.style.transform = `translateX(${to}px)`
    // The first word is simply there, in the middle: there is nothing to slide from.
    const first = !this.placed
    this.placed = true
    if (first || isReducedMotion() || Math.abs(to - from) < 0.5) return
    this.slide = this.line.animate(
      { transform: [`translateX(${from}px)`, `translateX(${to}px)`] },
      { duration: TRY_IT.slide.duration * 1000, easing: cssEase(TRY_IT.slide.ease) }
    )
  }

  /** The line's x right now, mid-slide included. */
  private currentX(): number {
    if (this.slide?.playState !== 'running') return this.x
    const t = getComputedStyle(this.line).transform
    return t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : this.x
  }

  /**
   * Each word's opacity follows its distance from the newest. A step starts
   * from the opacity the word has now, also when it is still entering.
   */
  private age(): void {
    const n = this.shown.length
    const steps = TRY_IT.ageOpacity
    const reduced = isReducedMotion()
    this.shown.forEach((w, i) => {
      const to = steps[Math.min(n - 1 - i, steps.length - 1)]
      if (to === w.target) return
      const from = currentOpacity(w.el)
      w.target = to
      w.step?.cancel()
      // The entrance's opacity channel gives way; its blur and slide run on.
      w.enter?.animations.forEach((x) => {
        if ((x.effect as KeyframeEffect | null)?.getKeyframes().some((k) => 'opacity' in k)) x.cancel()
      })
      w.el.style.opacity = String(to)
      if (reduced) return
      w.step = w.el.animate({ opacity: [from, to] }, {
        duration: TRY_IT.ageStep.duration * 1000, easing: cssEase(TRY_IT.ageStep.ease)
      })
    })
  }

  private remove(w: Shown): void {
    this.shown = this.shown.filter((s) => s !== w)
    clearTimeout(w.hold)
    w.step?.cancel()
    w.enter?.cancel()
    w.el.remove()
  }
}
