import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode, type Ref
} from 'react'
import { createPartialFeed, type StreamWord } from './wordDiff'
import { filterBudget } from './filterBudget'
import { useReduceMotion } from './MotionProvider'
import { animateWord, finishAll, type AnimHandle } from './waapi'
import { DUR, EASE, SPRING, STAGGER, STREAM, WORD_VARIANTS, springToLinear } from './tokens'

/**
 * Live transcription with diffing (docs/MOTION.md §3.3): Flow Bar partials,
 * Try-it text, transform preview.
 *
 * - `text` is always the FULL running text of the current dictation.
 * - Only new words animate (stream enter, cadence-adaptive stagger); settled
 *   words never re-animate. A corrected word keeps its DOM node and re-blurs in
 *   place; a deleted word blurs out with its separator and the next word on the
 *   same line plays the neighbour re-blur.
 * - Unconfirmed words rest at 60 % `--fg` (colour, not opacity).
 * - Live filters come from the per-window 12-slot budget, per batch.
 * - Reduce Motion: plain text (confirmed text + one unconfirmed span), no motion.
 */

export interface BlurStreamHandle {
  /** Jump every in-flight word animation to rest in this frame (Done send-out, §4.1.8). */
  settle(): void
  /** Cancel (§4.1.11): every live word blurs out together over `dur.micro`. */
  exitAll(): Promise<void>
  element: HTMLElement | null
}

export interface BlurStreamProps {
  text: string
  /** `dictation:final`: last diff, flush unstarted words, confirm everything. */
  final?: boolean
  /**
   * Absolute start (s) of the catch-up reveal for words already present at
   * mount, e.g. T0 + 0.12 when the Partial card unfurls (§4.1.6). Default 0.
   */
  catchUpStart?: number
  /** Animate the text present at mount (default true). */
  initial?: boolean
  /** Flow Bar: the visual transcript is aria-hidden (§3.3 Accessibility). User content: leave false. */
  ariaHidden?: boolean
  className?: string
  style?: CSSProperties
  ref?: Ref<BlurStreamHandle>
}

interface Item extends StreamWord { exiting?: boolean }

interface Batch {
  seq: number
  inserted: string[]
  substituted: string[]
  deleted: string[]
  neighbours: Array<[deletedId: string, neighbourId: string]>
  catchUp: boolean
  block: boolean
  emaMs: number
}

const V = WORD_VARIANTS

export function BlurStream({
  text, final = false, catchUpStart = 0, initial = true, ariaHidden = false, className, style, ref
}: BlurStreamProps): React.JSX.Element {
  const reduced = useReduceMotion()
  const rootRef = useRef<HTMLDivElement>(null)

  const feed = useRef(createPartialFeed())
  const itemsRef = useRef<Item[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [batch, setBatch] = useState<Batch | null>(null)
  const seq = useRef(0)
  const mountedText = useRef(true) // the first non-empty text uses catch-up
  const ema = useRef<number>(STREAM.emaSeedMs)
  const lastAt = useRef<number | null>(null)

  const nodes = useRef(new Map<string, HTMLElement>())
  const refCbs = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const handles = useRef(new Map<string, AnimHandle[]>())
  const startAt = useRef(new Map<string, number>()) // performance.now() ms of scheduled start
  const exitTimers = useRef(new Set<string>())

  const nodeRef = useCallback((id: string) => {
    let cb = refCbs.current.get(id)
    if (!cb) {
      cb = (el) => { if (el) nodes.current.set(id, el); else { nodes.current.delete(id); refCbs.current.delete(id) } }
      refCbs.current.set(id, cb)
    }
    return cb
  }, [])

  const track = (id: string, h: AnimHandle): void => {
    const list = handles.current.get(id)
    if (list) list.push(h); else handles.current.set(id, [h])
  }
  const cancelWord = (id: string): void => {
    handles.current.get(id)?.forEach((h) => h.cancel())
    handles.current.delete(id)
    startAt.current.delete(id)
  }
  const cancelAll = (): void => {
    for (const id of [...handles.current.keys()]) cancelWord(id)
  }

  const commitItems = (next: Item[]): void => { itemsRef.current = next; setItems(next) }

  /* ---- A: diff each partial into the display list ---- */
  useLayoutEffect(() => {
    if (!text.trim()) {
      const had = feed.current.words.length || itemsRef.current.length
      feed.current.reset()
      if (had) {
        cancelAll()
        commitItems([])
        mountedText.current = true
        lastAt.current = null
        ema.current = STREAM.emaSeedMs
      }
      return
    }
    // Null: this input is already applied (StrictMode's second effect run, or
    // only `reduced` changed). Running it again would confirm every word and
    // replace the catch-up batch with an empty one.
    const res = feed.current.push(text, final)
    if (!res) return
    const changed = res.inserted.length || res.substituted.length || res.deleted.length ||
      res.retexted.length || res.words.some((w, i) => w.confirmed !== res.prev[i]?.confirmed)
    if (!changed && res.prev.length === res.words.length) return

    // Cadence EMA (α 0.3, seed 1500 ms).
    const now = performance.now()
    if (lastAt.current !== null) {
      ema.current = STREAM.emaAlpha * (now - lastAt.current) + (1 - STREAM.emaAlpha) * ema.current
    }
    lastAt.current = now

    // Display list: live words + exiting words anchored after their predecessor.
    const prevItems = itemsRef.current
    const live = new Set(res.words.map((w) => w.id))
    const deletedIds = new Set(res.deleted.map((d) => d.id))
    const anchored = new Map<string | null, Item[]>()
    let anchor: string | null = null
    for (const it of prevItems) {
      if (live.has(it.id)) { anchor = it.id; continue }
      if (it.exiting || deletedIds.has(it.id)) {
        const list = anchored.get(anchor) ?? []
        list.push({ ...it, exiting: true })
        anchored.set(anchor, list)
      }
    }
    const next: Item[] = [...(reduced ? [] : anchored.get(null) ?? [])]
    for (const w of res.words) {
      next.push(w)
      if (!reduced) next.push(...(anchored.get(w.id) ?? []))
    }
    commitItems(next)

    const catchUp = mountedText.current && initial
    const animateNow = initial || !mountedText.current
    mountedText.current = false
    if (reduced || !animateNow) return
    setBatch({
      seq: ++seq.current,
      inserted: res.inserted,
      substituted: res.substituted,
      deleted: res.deleted.map((d) => d.id),
      neighbours: [...res.neighbourOf],
      catchUp,
      block: res.overflow,
      emaMs: ema.current
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, final, reduced])

  /* ---- B: run the batch on the committed DOM ---- */
  const ran = useRef(0)
  useLayoutEffect(() => {
    if (!batch || ran.current === batch.seq || reduced) return
    ran.current = batch.seq
    const now = performance.now()
    const order = new Map(itemsRef.current.map((it, i) => [it.id, i]))
    const isLive = (id: string): boolean => {
      const it = itemsRef.current[order.get(id) ?? -1]
      return !!it && !it.exiting
    }

    // Flush: words scheduled but not yet started are re-timed at 20 ms (no queue).
    const flush: string[] = []
    for (const [id, t] of startAt.current) {
      if (t > now) { cancelWord(id); if (isLive(id)) flush.push(id) }
    }
    const subs = batch.substituted.filter((id) => !flush.includes(id))
    const enter = [...new Set([...flush, ...batch.inserted])].filter(isLive)
      .sort((a, b) => order.get(a)! - order.get(b)!)

    // Pacing.
    const nNew = enter.length - flush.length
    let step: number
    let block = batch.block
    let base = 0
    if (batch.catchUp) {
      step = Math.min(STREAM.catchUpCap, STAGGER.fit(enter.length, STREAM.catchUpPerWord, catchUpStart))
      if (step === 0 && enter.length > 1) block = true
      base = catchUpStart
    } else {
      step = STAGGER.stream(Math.max(1, nNew), batch.emaMs)
    }

    // Filter budget, allocated per batch in reading order: subs, enters, exits.
    const wanted = subs.length + enter.length + batch.deleted.length
    let slots = filterBudget.take(wanted)
    const slot = (): boolean => (slots > 0 ? (slots--, true) : false)

    // Substitutions: re-blur in place, no y, no remount.
    for (const id of subs) {
      const el = nodes.current.get(id); if (!el) continue
      cancelWord(id)
      track(id, animateWord(el, {
        opacity: { from: V.reblur.from, to: 1, duration: V.reblur.duration, ease: V.reblur.ease },
        blur: { from: V.reblur.blur, to: 0, duration: V.reblur.duration, ease: V.reblur.ease }
      }, slot()))
    }

    // Enters.
    let fi = 0
    enter.forEach((id, i) => {
      const el = nodes.current.get(id); if (!el) return
      const isFlush = fi < flush.length && flush.includes(id)
      let delay: number
      if (block) delay = base
      else if (isFlush) delay = (fi++) * STAGGER.flush
      else delay = base + flush.length * STAGGER.flush + (i - flush.length) * step
      startAt.current.set(id, now + delay * 1000)
      const k = block
        ? {
            delay,
            opacity: { from: V.block.from, to: 1, duration: V.block.opacity, ease: V.block.ease },
            blur: { from: V.stream.blur, to: 0, duration: V.block.filter, ease: V.block.ease }
          }
        : {
            delay,
            opacity: { from: 0, to: 1, duration: V.stream.opacity, ease: V.stream.ease },
            blur: { from: V.stream.blur, to: 0, duration: V.stream.filter, ease: V.stream.ease },
            y: { from: V.stream.y, to: 0, duration: V.stream.transform, ease: V.stream.ease }
          }
      const h = animateWord(el, k, slot())
      h.finished.then(() => { if (startAt.current.get(id) === now + delay * 1000) startAt.current.delete(id) })
      track(id, h)
    })

    // Same-line check for neighbour re-blurs, measured before any exit starts
    // (a running filter makes the exiting token the offsetParent).
    const sameLine = new Map<string, boolean>()
    for (const [d, n] of batch.neighbours) {
      const del = nodes.current.get(d), el = nodes.current.get(n)
      if (!del || !el) continue
      const a = del.getBoundingClientRect(), b = el.getBoundingClientRect()
      sameLine.set(d, Math.abs(a.top - b.top) < Math.max(1, a.height / 2))
    }

    // Deletes: exit with the separator (the whole token), then leave the DOM.
    const tokOf = (el: HTMLElement): HTMLElement => (el.parentElement as HTMLElement) ?? el
    for (const id of batch.deleted) {
      const el = nodes.current.get(id)
      cancelWord(id)
      if (!el) continue
      const h = animateWord(tokOf(el), {
        fill: 'forwards',
        opacity: { from: 1, to: 0, duration: DUR.flash, ease: V.streamExit.ease },
        blur: { from: 0, to: V.streamExit.blur, duration: V.streamExit.duration, ease: V.streamExit.ease }
      }, slot())
      track(id, h)
      exitTimers.current.add(id)
      h.finished.then(() => {
        exitTimers.current.delete(id)
        handles.current.delete(id)
        commitItems(itemsRef.current.filter((it) => it.id !== id))
      })
    }

    // Slots this batch asked for but didn't use go straight back.
    if (slots > 0) filterBudget.release(slots)

    // Neighbour re-blur: the first word after a deletion, on the same line only.
    const busy = new Set([...subs, ...enter])
    const extra = batch.neighbours.filter(([, n]) => !busy.has(n))
    let nslots = filterBudget.take(extra.length)
    for (const [d, n] of extra) {
      const el = nodes.current.get(n)
      const ok = nslots > 0
      if (ok) nslots--
      if (!el || !sameLine.get(d)) { if (ok) filterBudget.release(1); continue }
      track(n, animateWord(el, {
        opacity: { from: V.neighbour.from, to: 1, duration: V.neighbour.duration, ease: V.neighbour.ease },
        blur: { from: V.neighbour.blur, to: 0, duration: V.neighbour.duration, ease: V.neighbour.ease }
      }, ok))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch])

  /* ---- Unmount: release every slot ---- */
  useEffect(() => () => { cancelAll(); ran.current = 0 }, [])

  /* ---- Reduce Motion turned on: settle instantly and drop exiting tokens ---- */
  useLayoutEffect(() => {
    if (!reduced) return
    cancelAll()
    if (itemsRef.current.some((i) => i.exiting)) commitItems(itemsRef.current.filter((i) => !i.exiting))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  useImperativeHandle(ref, () => ({
    element: rootRef.current,
    settle() {
      if (rootRef.current) finishAll(rootRef.current)
      startAt.current.clear()
    },
    exitAll() {
      const live = itemsRef.current.filter((i) => !i.exiting)
      let slots = filterBudget.take(live.length)
      const hs = live.map((it) => {
        const el = nodes.current.get(it.id)
        cancelWord(it.id)
        if (!el) return null
        const ok = slots > 0; if (ok) slots--
        return animateWord(el, {
          fill: 'forwards',
          opacity: { from: 1, to: 0, duration: DUR.micro, ease: EASE.exit },
          blur: { from: 0, to: V.stream.blur, duration: DUR.micro, ease: EASE.exit }
        }, ok)
      })
      return Promise.all(hs.map((h) => h?.finished)).then(() => {})
    }
  }), [])

  /* ---- Render ---- */
  if (reduced) {
    const firstUnconf = items.findIndex((w) => !w.confirmed)
    const head = (firstUnconf < 0 ? items : items.slice(0, firstUnconf)).map((w) => w.raw).join(' ')
    const tail = firstUnconf < 0 ? '' : items.slice(firstUnconf).map((w) => w.raw).join(' ')
    return (
      <div ref={rootRef} className={className} style={style} aria-hidden={ariaHidden || undefined}>
        {head}{head && tail ? ' ' : ''}{tail && <span className="bw-unconf">{tail}</span>}
      </div>
    )
  }

  const out: ReactNode[] = []
  items.forEach((it, i) => {
    out.push(
      <span className="bw-tok" key={it.id}>
        {i > 0 ? ' ' : ''}
        <span
          ref={nodeRef(it.id)}
          className={it.confirmed || it.exiting ? 'bw-word' : 'bw-word bw-unconf'}
          aria-hidden={it.exiting || undefined}
        >
          {it.raw}
        </span>
      </span>
    )
  })
  return (
    <div ref={rootRef} className={className} style={style} aria-hidden={ariaHidden || undefined}>
      {out}
    </div>
  )
}

/**
 * Fixed-height, bottom-anchored clip box for a stream (§3.3 Overflow): 4 px
 * padding for blur halos, a 12 px top mask, and older lines scroll up, when a
 * new line starts, the text block's y animates by exactly the added height with
 * `spring.ui` (no overshoot). Word spans never get `layout`.
 */
export function StreamViewport({
  height, children, className, style
}: { height: number; children: ReactNode; className?: string; style?: CSSProperties }): React.JSX.Element {
  const inner = useRef<HTMLDivElement>(null)
  const reduced = useReduceMotion()
  const last = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      const prev = last.current
      last.current = h
      if (prev === null || reduced || h <= prev) return
      const { easing, duration } = springToLinear(SPRING.ui)
      el.animate({ transform: [`translateY(${h - prev}px)`, 'translateY(0px)'] }, { duration, easing })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [reduced])
  return (
    <div className={`bw-viewport${className ? ' ' + className : ''}`} style={{ height, ...style }}>
      <div ref={inner}>{children}</div>
    </div>
  )
}
