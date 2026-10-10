import {
  useLayoutEffect, useRef, useState,
  type CSSProperties, type ElementType, type ReactNode
} from 'react'
import { filterBudget } from './filterBudget'
import { useReduceMotion } from './MotionProvider'
import { animateWord, currentOpacity, type AnimHandle, type WordKeyframes } from './waapi'
import {
  SPRING, STAGGER, STREAM, WORD_VARIANTS as V, headlineBlur, isReducedMotion, springToLinear, type WordVariant
} from './tokens'

/**
 * Per-word blur-fade for static UI copy (docs/MOTION.md §3.1–3.2):
 * blur → sharp + opacity + slight y, staggered per word, opacity leading blur.
 *
 * Variants: `headline` | `title` | `body` | `bodyCompact` split per word;
 * `titleUnit` | `label` | `block` animate as one unit (frequent surfaces).
 *
 * - Anatomy: token = leading space (plain text node) + inline-block word, so
 *   line breaks stay native and wrapping matches plain text.
 * - A11y (static copy): one sr-only real-text twin + one `aria-hidden` wrapper.
 *   `userContent` copy has no twin: the spans are the only text.
 * - Text changes swap: the old copy exits from its current values while the new
 *   copy enters (headline: +80 ms, delayed-start rule; units: +40 ms). At most
 *   two copies in the DOM.
 * - Live filters come from the 12-slot budget; at rest filter/transform are none.
 * - Reduce Motion: plain text, no spans, no motion.
 */

/** A string (split into words) or an inline component counted as one token (e.g. the `fn` keycap). */
export type BlurPart = string | { node: ReactNode; text: string }

export interface BlurWordsProps {
  text?: string
  parts?: BlurPart[]
  variant: WordVariant
  as?: ElementType
  /** Absolute start (s) inside the parent choreography. Headline > 0 uses the delayed-start rule. */
  delay?: number
  /** Fit-to-total end (s) for `fit` staggers. Default 0.6. */
  total?: number
  /** Explicit stagger (s), e.g. the hand-off's 40 ms. Overrides the variant's rule. */
  stagger?: number
  /** Animate on mount. Default: true for headline/title/body/bodyCompact/block, false for titleUnit/label. */
  initial?: boolean
  /** Hold the initial (hidden) frame, e.g. until the window is shown (§3.6). */
  hold?: boolean
  /** User content: no sr-only twin, no aria-hidden (§3.1). */
  userContent?: boolean
  /** Unit variants: animate the container's real width with `spring.ui` on swap. */
  animateWidth?: boolean
  className?: string
  style?: CSSProperties
  onSettled?: () => void
}

interface Layer { gen: number; parts: BlurPart[]; exiting: boolean; swap: boolean }

const SPLIT: Record<WordVariant, boolean> = {
  headline: true, title: true, body: true, bodyCompact: true, titleUnit: false, label: false, block: false
}
const INITIAL: Record<WordVariant, boolean> = {
  headline: true, title: true, body: true, bodyCompact: true, block: true, titleUnit: false, label: false
}

const partsOf = (text?: string, parts?: BlurPart[]): BlurPart[] => parts ?? (text != null ? [text] : [])
const plainOf = (parts: BlurPart[]): string =>
  parts.map((p) => (typeof p === 'string' ? p : p.text)).join(' ').replace(/\s+/g, ' ').trim()

function renderTokens(parts: BlurPart[], split: boolean): ReactNode {
  if (!split) {
    return (
      <span className="bw-unit">
        {parts.map((p, i) => (
          <span key={i}>{i > 0 ? ' ' : ''}{typeof p === 'string' ? p.trim() : p.node}</span>
        ))}
      </span>
    )
  }
  const toks: ReactNode[] = []
  let n = 0
  for (const p of parts) {
    const words = typeof p === 'string' ? p.trim().split(/\s+/).filter(Boolean) : [p.node]
    for (const w of words) {
      toks.push(
        <span className="bw-tok" key={n}>
          {n > 0 ? ' ' : ''}
          <span className="bw-word">{w}</span>
        </span>
      )
      n++
    }
  }
  return toks
}

/** Builds the enter keyframes for word `i` of `n`. */
function enterFor(variant: WordVariant, i: number, n: number, fs: number, start: number, total: number, explicitStagger?: number): WordKeyframes {
  switch (variant) {
    case 'headline': {
      const delayed = start > 0
      const perWord = delayed ? V.headline.delayed.perWord : V.headline.filter
      const opacity = delayed ? V.headline.delayed.opacity : V.headline.opacity
      const step = explicitStagger ?? STAGGER.fit(n, perWord, start, total)
      return {
        delay: start + i * step,
        opacity: { from: 0, to: 1, duration: opacity, ease: V.headline.ease },
        blur: { from: headlineBlur(fs), to: 0, duration: perWord, ease: V.headline.ease },
        y: { from: V.headline.yFs * fs, to: 0, duration: 0, ease: SPRING.text }
      }
    }
    case 'title': {
      const step = explicitStagger ?? V.title.stagger
      return {
        delay: start + Math.min(i, V.title.cap - 1) * step,
        opacity: { from: 0, to: 1, duration: V.title.opacity, ease: V.title.ease },
        blur: { from: V.title.blur, to: 0, duration: V.title.filter, ease: V.title.ease },
        y: { from: V.title.yFs * fs, to: 0, duration: V.title.transform, ease: V.title.ease }
      }
    }
    case 'body': {
      const capped = Math.min(n, STREAM.splitCap)
      const step = explicitStagger ?? STAGGER.fit(capped, V.body.filter, start, total)
      return {
        delay: start + Math.min(i, STREAM.splitCap - 1) * step,
        opacity: { from: 0, to: 1, duration: V.body.opacity, ease: V.body.ease },
        blur: { from: V.body.blur, to: 0, duration: V.body.filter, ease: V.body.ease },
        y: { from: V.body.yFs * fs, to: 0, duration: V.body.transform, ease: V.body.ease }
      }
    }
    case 'bodyCompact': {
      const step = explicitStagger ?? V.bodyCompact.stagger
      return {
        delay: start + Math.min(i, V.bodyCompact.cap - 1) * step,
        opacity: { from: 0, to: 1, duration: V.bodyCompact.opacity, ease: V.bodyCompact.ease },
        blur: { from: V.bodyCompact.blur, to: 0, duration: V.bodyCompact.filter, ease: V.bodyCompact.ease },
        y: { from: V.bodyCompact.yFs * fs, to: 0, duration: V.bodyCompact.transform, ease: V.bodyCompact.ease }
      }
    }
    case 'titleUnit':
      return {
        delay: start + V.titleUnit.delay,
        opacity: { from: 0, to: 1, duration: V.titleUnit.opacity, ease: V.titleUnit.ease },
        blur: { from: V.titleUnit.blur, to: 0, duration: V.titleUnit.filter, ease: V.titleUnit.ease },
        y: { from: V.titleUnit.yFs * fs, to: 0, duration: V.titleUnit.transform, ease: V.titleUnit.ease }
      }
    case 'label':
      return {
        delay: start,
        opacity: { from: 0, to: 1, duration: V.label.opacity, ease: V.label.ease },
        blur: { from: V.label.blur, to: 0, duration: V.label.filter, ease: V.label.ease }
      }
    case 'block':
      return {
        delay: start,
        opacity: { from: V.block.from, to: 1, duration: V.block.opacity, ease: V.block.ease },
        blur: { from: V.block.blur, to: 0, duration: V.block.filter, ease: V.block.ease }
      }
  }
}

/** Exit keyframes from the element's current opacity (§6.3 interruption rule). */
function exitFor(variant: WordVariant, from: number, fs: number): WordKeyframes {
  if (variant === 'headline') {
    const o = V.headline.swapOut
    return {
      fill: 'forwards',
      opacity: { from, to: 0, duration: o.duration, ease: o.ease },
      blur: { from: 0, to: o.blur, duration: o.duration, ease: o.ease },
      y: { from: 0, to: o.yFs * fs, duration: o.duration, ease: o.ease }
    }
  }
  if (variant === 'titleUnit') {
    return { fill: 'forwards', opacity: { from, to: 0, duration: V.titleUnit.out, ease: V.headline.swapOut.ease } }
  }
  const blur = variant === 'label' ? V.label.blur : V.block.exitBlur
  return {
    fill: 'forwards',
    opacity: { from, to: 0, duration: V.label.exit, ease: V.headline.swapOut.ease },
    blur: { from: 0, to: blur, duration: V.label.exit, ease: V.headline.swapOut.ease }
  }
}

/** Offset (s) of the incoming copy on a swap. */
const swapOffset = (variant: WordVariant): number =>
  variant === 'headline' ? V.headline.newWordsStart : V.label.enterDelay

export function BlurWords({
  text, parts: partsProp, variant, as: As = 'span', delay = 0, total = 0.6, stagger,
  initial, hold = false, userContent = false, animateWidth = false, className, style, onSettled
}: BlurWordsProps): React.JSX.Element {
  const reduced = useReduceMotion()
  const parts = partsOf(text, partsProp)
  const plain = plainOf(parts)
  const split = SPLIT[variant]
  const animateInitial = initial ?? INITIAL[variant]

  const rootRef = useRef<HTMLElement>(null)
  const layerEls = useRef(new Map<number, HTMLElement>())
  const handles = useRef(new Map<number, AnimHandle[]>())
  const gen = useRef(0)
  const lastPlain = useRef(plain)
  const ranGen = useRef(-1)
  const widthFrom = useRef<number | null>(null)
  const restWidth = useRef<number | null>(null)
  const widthAnim = useRef<Animation | null>(null)

  const [layers, setLayers] = useState<Layer[]>(() => [{ gen: 0, parts, exiting: false, swap: false }])
  const layersRef = useRef(layers)
  layersRef.current = layers

  /*
   * Real width, part 1: remember the root's width while the copy is unchanged.
   * By the time a text change reaches a layout effect the new copy is already
   * in the DOM, so the swap's "from" has to be known beforehand. Measured on
   * every commit that keeps the copy, and on resize (fonts loading).
   */
  const measureRest = (): void => {
    const root = rootRef.current
    if (!root || widthAnim.current?.playState === 'running') return
    restWidth.current = root.getBoundingClientRect().width
  }
  useLayoutEffect(() => {
    if (animateWidth && !reduced && plain === lastPlain.current) measureRest()
  })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!animateWidth || reduced || !root || typeof ResizeObserver === 'undefined') return
    // Never fires between a text change and its layout effects, so it cannot record the new copy too early.
    const ro = new ResizeObserver(measureRest)
    ro.observe(root)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animateWidth, reduced])

  // Text changed → the live copy becomes the exiting one (an older exiting copy is dropped).
  useLayoutEffect(() => {
    if (plain === lastPlain.current) return
    lastPlain.current = plain
    if (animateWidth && !reduced && rootRef.current) {
      // Mid-swap the root still shows the animated width: start from there (§6.3).
      widthFrom.current = widthAnim.current?.playState === 'running'
        ? rootRef.current.getBoundingClientRect().width
        : restWidth.current
    }
    const live = layersRef.current.find((l) => !l.exiting)
    // Drop instantly: a previous exiting copy.
    for (const l of layersRef.current) if (l.exiting) handles.current.get(l.gen)?.forEach((h) => h.cancel())
    const next: Layer[] = []
    if (live && !reduced) next.push({ ...live, exiting: true })
    next.push({ gen: ++gen.current, parts, exiting: false, swap: true })
    setLayers(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plain])

  // Run enter/exit for the newest generation once it is committed (and not held).
  useLayoutEffect(() => {
    const live = layers.find((l) => !l.exiting)
    if (!live || reduced) return
    const el = layerEls.current.get(live.gen)
    if (!el) return
    const shouldAnimate = live.swap || animateInitial
    if (!shouldAnimate) { ranGen.current = live.gen; return }
    if (ranGen.current === live.gen) return
    if (hold) { el.style.opacity = '0'; return } // initial frame while hidden
    el.style.opacity = ''
    ranGen.current = live.gen

    const run = (): void => {
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16
      const start = delay + (live.swap && layers.some((l) => l.exiting) ? swapOffset(variant) : 0)
      const targets = Array.from(el.querySelectorAll<HTMLElement>(split ? '.bw-word' : '.bw-unit'))
      const n = targets.length
      let slots = filterBudget.take(Math.min(n, variant === 'body' ? STREAM.splitCap : n))
      const hs: AnimHandle[] = targets.map((t, i) => {
        const k = enterFor(variant, i, n, fs, start, total, stagger)
        const ok = slots > 0 && !(variant === 'body' && i >= STREAM.splitCap)
        if (ok) slots--
        return animateWord(t, k, ok)
      })
      if (slots > 0) filterBudget.release(slots)
      handles.current.set(live.gen, hs)
      if (onSettled) Promise.all(hs.map((h) => h.finished)).then(onSettled)

      // Exiting copy: from its current values, then removed.
      const ex = layers.find((l) => l.exiting)
      const exEl = ex && layerEls.current.get(ex.gen)
      if (ex && exEl) {
        const exTargets = Array.from(exEl.querySelectorAll<HTMLElement>(split ? '.bw-word' : '.bw-unit'))
        const from = exTargets.map(currentOpacity)
        handles.current.get(ex.gen)?.forEach((h) => h.cancel())
        let xs = filterBudget.take(exTargets.length)
        const xh = exTargets.map((t, i) => {
          const ok = xs > 0; if (ok) xs--
          return animateWord(t, exitFor(variant, from[i], fs), ok)
        })
        if (xs > 0) filterBudget.release(xs)
        handles.current.set(ex.gen, xh)
        Promise.all(xh.map((h) => h.finished)).then(() => {
          handles.current.delete(ex.gen)
          setLayers((ls) => ls.filter((l) => l.gen !== ex.gen))
        })
      }

      // Real width (unit variants): old → new with spring.ui, then back to auto.
      const root = rootRef.current
      if (animateWidth && root && widthFrom.current != null) {
        widthAnim.current?.cancel()
        widthAnim.current = null
        const to = root.getBoundingClientRect().width
        const from0 = widthFrom.current
        widthFrom.current = null
        restWidth.current = to
        if (!isReducedMotion() && Math.abs(to - from0) > 0.5 && typeof root.animate === 'function') {
          const { easing, duration } = springToLinear(SPRING.ui)
          widthAnim.current = root.animate({ width: [`${from0}px`, `${to}px`] }, { duration, easing })
        }
      }
    }

    if (document.fonts && document.fonts.status !== 'loaded') {
      el.style.opacity = '0'
      document.fonts.ready.then(() => { el.style.opacity = ''; run() })
    } else run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, hold, reduced])

  // Unmount: release every slot.
  useLayoutEffect(() => () => {
    handles.current.forEach((hs) => hs.forEach((h) => h.cancel()))
    handles.current.clear()
    ranGen.current = -1
    widthAnim.current?.cancel()
    widthAnim.current = null
  }, [])

  if (reduced) {
    return (
      <As className={className} style={style}>
        {parts.map((p, i) => (
          <span key={i}>{i > 0 ? ' ' : ''}{typeof p === 'string' ? p.trim() : p.node}</span>
        ))}
      </As>
    )
  }

  const rootStyle: CSSProperties | undefined = animateWidth
    ? { display: 'inline-block', whiteSpace: 'nowrap', verticalAlign: 'bottom', ...style }
    : style
  const body = layers.map((l) => (
    <span
      key={l.gen}
      className="bw-layer"
      data-exiting={l.exiting ? '' : undefined}
      ref={(el) => { if (el) layerEls.current.set(l.gen, el); else layerEls.current.delete(l.gen) }}
    >
      {/* The live copy always renders the current parts (fresh inline nodes). */}
      {renderTokens(l.exiting ? l.parts : parts, split)}
    </span>
  ))

  return (
    <As ref={rootRef} className={`bw-root${className ? ' ' + className : ''}`} style={rootStyle}>
      {userContent ? body : (
        <>
          <span className="m-sr-only">{plain}</span>
          <span className="bw" aria-hidden="true">{body}</span>
        </>
      )}
    </As>
  )
}
