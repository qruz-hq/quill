import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, m, useAnimate, useIsPresent, type TargetAndTransition, type Transition, type Variants } from 'motion/react'
import {
  BLUR, DIST, DUR, SPRING, STAGGER, STAGGER_CAP, blurPx, isReducedMotion, presets, staggerDelay, tween,
  type DurToken, type EaseToken, type SpringToken
} from '../shared/motion'

/* Motion helpers local to the Todos panel (docs/MOTION.md §4.12). Every value
   is a shared token; the only literals are the spec's own caps and offsets,
   named below. */

export const tw = (d: DurToken, e: EaseToken = 'out', delay = 0): Transition => tween(d, e, delay) as Transition
export const INSTANT: Transition = { duration: DUR.instant }

/** §4.12 Open: panel items stagger at `stagger.tight` from t = 30. */
const OPEN_START = 0.03
/** §4.12: content that enters inside a container whose height is opening starts at t = 50. */
export const AFTER_HEIGHT = 0.05
/** §4.12 Clear: the section collapses from t = 40; rows stagger from the bottom, capped at 8. */
export const CLEAR_COLLAPSE_DELAY = 0.04

/**
 * How something that mounts should enter:
 * - `stagger`: part of the panel's first paint (opacity + y 4, staggered).
 * - `insert`: arrived on its own (real height + content blur).
 * - `newgroup`: inside a project group that is itself inserting.
 * - `expand`: inside a section the user just expanded (opacity, staggered).
 * - `none`: at rest (bulk refresh).
 */
export type EnterMode = 'stagger' | 'insert' | 'newgroup' | 'expand' | 'none'

/** A mutable cell read once, at mount, by whatever mounts under it. */
export const EnterCtx = createContext<{ current: EnterMode }>({ current: 'insert' })
/** True once the window is on screen (first-show entrances hold until then). */
export const ShownCtx = createContext(true)

/** The mode this component mounted with, and a cell for its children that turns to `insert` once it is mounted. */
export function useEnter(forChildren: (mine: EnterMode) => EnterMode): { mode: EnterMode; cell: { current: EnterMode } } {
  const parent = useContext(EnterCtx)
  const [mode] = useState(() => parent.current)
  const cell = useRef<{ current: EnterMode }>(null as never)
  if (!cell.current) cell.current = { current: forChildren(mode) }
  useEffect(() => { cell.current.current = 'insert' }, [])
  return { mode, cell: cell.current }
}

const panelItem = presets.fadeUpStagger({ y: DIST.sm, step: STAGGER.tight, cap: STAGGER_CAP.panel, start: OPEN_START, duration: DUR.micro })
const expandItem = presets.fadeUpStagger({ y: 0, step: STAGGER.tight, cap: STAGGER_CAP.panel, duration: DUR.fast })

export type Leave = 'move' | 'delete' | 'clear'
export type ContentCustom = { index: number; pos: number; leave: Leave; fromEnd: number }

const call = (v: unknown, arg: unknown): TargetAndTransition =>
  (typeof v === 'function' ? (v as (a: unknown) => TargetAndTransition)(arg) : v) as TargetAndTransition

/** Row content exits: leaving for Completed fades; a delete slides out; Clear staggers from the bottom. */
const leave = (c: ContentCustom): TargetAndTransition => {
  if (c.leave === 'move') return { opacity: 0, transition: tw('micro', 'exit') }
  const del = presets.rowDelete.exit as TargetAndTransition
  if (c.leave === 'delete') return del
  return { ...del, transition: tw('micro', 'exit', staggerDelay(c.fromEnd, STAGGER.list, STAGGER_CAP.list)) }
}

/** Content-layer variants for each enter mode. `custom` is a ContentCustom. */
export const CONTENT: Record<EnterMode, Variants> = {
  stagger: {
    initial: panelItem.initial,
    animate: (c: ContentCustom) => call(panelItem.animate, c.index),
    cleared: leave, exit: leave
  },
  insert: { initial: presets.rowInsert.initial, animate: presets.rowInsert.animate, cleared: leave, exit: leave },
  newgroup: {
    initial: presets.rowInsert.initial,
    animate: { opacity: 1, filter: blurPx(0), transition: tw('base', 'out', AFTER_HEIGHT), transitionEnd: { filter: 'none' } },
    cleared: leave, exit: leave
  },
  expand: {
    initial: expandItem.initial,
    animate: (c: ContentCustom) => call(expandItem.animate, c.pos),
    cleared: leave, exit: leave
  },
  none: { initial: { opacity: 1 }, animate: { opacity: 1 }, cleared: leave, exit: leave }
}

/** Project header content when its group inserts: opacity + blur 3 to 0, dur.fast at t = 50. */
export const HEADER_INSERT: Variants = {
  initial: { opacity: 0, filter: blurPx(BLUR.label) },
  animate: { opacity: 1, filter: blurPx(0), transition: tw('fast', 'out', AFTER_HEIGHT), transitionEnd: { filter: 'none' } },
  exit: { opacity: 0, transition: tw('micro', 'exit') }
}

/** Section content: rows fade together when it collapses. */
const SECTION_CONTENT: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 0, transition: tw('micro', 'exit') }
}

/** Description and meta inside a row: out micro; back in fast at t = 50. */
export const DETAIL: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tw('fast', 'out', AFTER_HEIGHT) },
  exit: { opacity: 0, transition: tw('micro', 'exit') }
}

/**
 * A box whose real height opens from 0 and closes to 0 (never a layout scale).
 * `gap` is the flex gap of the list it sits in: the box takes it along through
 * a negative margin, so nothing jumps when it unmounts. Must be the direct
 * child of an AnimatePresence. Overflow is clipped only while it moves.
 */
export function CollapseBox({
  children, gap = 0, enter = true, content = SECTION_CONTENT, custom, className,
  openSpring = SPRING.ui, closeSpring = SPRING.ui, closeDelay = 0, contentAnimate = 'animate'
}: {
  children: React.ReactNode
  gap?: number
  /** Animate the height in on mount. */
  enter?: boolean
  content?: Variants
  custom?: unknown
  className?: string
  openSpring?: SpringToken
  closeSpring?: SpringToken
  closeDelay?: number
  contentAnimate?: string
}): React.JSX.Element {
  const present = useIsPresent()
  const [settled, setSettled] = useState(!enter)
  return (
    <m.div
      inert={!present}
      style={{ overflow: present && settled ? 'visible' : 'hidden', pointerEvents: present ? undefined : 'none' }}
      initial={enter ? { height: 0, marginTop: -gap } : false}
      animate={{ height: 'auto', marginTop: 0, transition: openSpring }}
      exit={{ height: 0, marginTop: -gap, transition: { ...closeSpring, delay: closeDelay } }}
      onAnimationComplete={() => setSettled(true)}
    >
      <m.div className={className} variants={content} custom={custom} initial={enter ? 'initial' : false} animate={contentAnimate} exit="exit">
        {children}
      </m.div>
    </m.div>
  )
}

/** `CollapseBox` with its own presence: open from the start renders at rest. */
export function Collapse({ open, children, ...rest }: { open: boolean } & Parameters<typeof CollapseBox>[0]): React.JSX.Element {
  const first = useRef(true)
  useEffect(() => { first.current = false }, [])
  return (
    <AnimatePresence>
      {open && <CollapseBox key="box" {...rest} enter={!first.current}>{children}</CollapseBox>}
    </AnimatePresence>
  )
}

/**
 * A surface whose real height follows its content. At rest the height is
 * `auto` (typing a longer description never clips the caret line); when
 * `flip` changes (open / close) it springs from the old measured height to the
 * new one, then goes back to `auto`. A flip mid-flight starts from where it is.
 */
export function AutoHeight({ flip, closing, className, children }: {
  flip: unknown; closing: boolean; className?: string; children: React.ReactNode
}): React.JSX.Element {
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const inner = useRef<HTMLDivElement>(null)
  const natural = useRef<number | null>(null)       // content height before this commit
  const run = useRef(0)
  // Runs after layout effects, so a flip still sees the previous content's height.
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { natural.current = el.offsetHeight })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    const el = scope.current
    const to = inner.current?.offsetHeight ?? 0
    const from = el.style.height ? el.getBoundingClientRect().height : natural.current
    natural.current = to
    if (from === null || isReducedMotion() || Math.abs(from - to) < 0.5) return
    const mine = ++run.current
    el.style.overflow = 'hidden'
    el.style.height = `${from}px`                     // hold the old height until the first animated frame
    void animate(el, { height: [from, to] }, closing ? SPRING.exit : SPRING.ui).then(() => {
      if (mine !== run.current) return
      el.style.height = ''
      el.style.overflow = ''
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flip])
  return (
    <div ref={scope} className={className}>
      <div ref={inner}>{children}</div>
    </div>
  )
}
