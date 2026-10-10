import {
  useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode
} from 'react'
import { AnimatePresence, m, useIsPresent, type Transition, type Variants } from 'motion/react'
import { morphContent, rowInsert } from './presets'
import { DUR, EASE, SPRING, type BarBox, type SpringToken } from './tokens'

/**
 * Morph primitives (docs/MOTION.md §6.3 Layout):
 *
 * - `RealHeight` , measured 0 ↔ px ↔ auto height (banners, rows, step cards,
 *                   conditional fields, composer). Never `layout` for sizes with text.
 * - `RealWidth`  , real width follows content (chips, label swaps, action slots).
 * - `Indicator`  , text-free shared `layoutId` pill (nav, pane, radio, tab, date).
 * - `MorphContainer`, container transform (card → dialog, Try-it → Hero):
 *                   `layoutId` box with borderRadius in style + content cross-fade.
 * - `MorphBox`   , absolute geometry morph with NO layout projection (Flow Bar shape).
 * - `PresenceSwap`, keyed content swap (`popLayout`), exiting subtree inert.
 * - `ExitInert`  , sets `inert` + `pointer-events: none` from the first exit frame.
 */

/* ------------------------------------------------------------------ */
/* Inert while exiting (rule 9)                                        */
/* ------------------------------------------------------------------ */

/** Props that make an exiting subtree inert from its first exit frame. Call inside a presence child. */
export function useExitInert(): { inert?: boolean; style?: CSSProperties } {
  const present = useIsPresent()
  return present ? {} : { inert: true, style: { pointerEvents: 'none' } }
}

/* ------------------------------------------------------------------ */
/* RealHeight                                                          */
/* ------------------------------------------------------------------ */

export interface RealHeightProps {
  open: boolean
  children: ReactNode
  /** Content variants inside the clip (default: rowInsert = opacity + blur 4 → 0). */
  content?: Variants
  /** Animate when first mounted open (default false: present at first render renders at rest). */
  initial?: boolean
  /** Spring for opening (default `spring.ui`) and closing (default `spring.exit`). */
  openSpring?: SpringToken
  closeSpring?: SpringToken
  className?: string
  style?: CSSProperties
  onExited?: () => void
}

/**
 * Height 0 → measured → auto with `spring.ui`, closing with `spring.exit`.
 * Siblings reflow natively each frame (no `layout` on neighbours).
 */
export function RealHeight({
  open, children, content = rowInsert, initial = false,
  openSpring = SPRING.ui, closeSpring = SPRING.exit, className, style, onExited
}: RealHeightProps): React.JSX.Element {
  return (
    <AnimatePresence initial={initial} onExitComplete={onExited}>
      {open && (
        <RealHeightInner key="rh" className={className} style={style} openSpring={openSpring} closeSpring={closeSpring} content={content}>
          {children}
        </RealHeightInner>
      )}
    </AnimatePresence>
  )
}

function RealHeightInner({
  children, className, style, openSpring, closeSpring, content
}: { children: ReactNode; className?: string; style?: CSSProperties; openSpring: SpringToken; closeSpring: SpringToken; content: Variants }): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      className={className}
      inert={inert.inert}
      style={{ overflow: 'hidden', ...style, ...inert.style }}
      initial={{ height: 0 }}
      animate={{ height: 'auto', transition: openSpring }}
      exit={{ height: 0, transition: closeSpring }}
    >
      <m.div variants={content} initial="initial" animate="animate" exit="exit">
        {children}
      </m.div>
    </m.div>
  )
}

/* ------------------------------------------------------------------ */
/* RealWidth                                                           */
/* ------------------------------------------------------------------ */

/** Real width follows the content's measured width with `spring.ui` (never layout scale on text). */
export function RealWidth({
  children, className, style, transition = SPRING.ui
}: { children: ReactNode; className?: string; style?: CSSProperties; transition?: Transition }): React.JSX.Element {
  const inner = useRef<HTMLSpanElement>(null)
  const [w, setW] = useState<number | 'auto'>('auto')
  useLayoutEffect(() => {
    const el = inner.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW(el.offsetWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <m.span
      className={className}
      initial={false}
      animate={{ width: w }}
      transition={transition}
      style={{ display: 'inline-block', overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'bottom', ...style }}
    >
      <span ref={inner} style={{ display: 'inline-block' }}>{children}</span>
    </m.span>
  )
}

/* ------------------------------------------------------------------ */
/* Indicator (text-free layoutId)                                      */
/* ------------------------------------------------------------------ */

/**
 * Shared selection indicator: `nav-active`, `pane-active`, `mic-radio`,
 * `pad-tab`, `pad-note-active`, `dp-selected`. Render it inside the active item
 * only, wrapped by a `LayoutGroup` (and `layoutDependency` = the active key).
 */
export function Indicator({
  layoutId, transition = SPRING.fluid, radius = 9999, className, style, dependency
}: {
  layoutId: string
  transition?: Transition
  radius?: number
  className?: string
  style?: CSSProperties
  dependency?: unknown
}): React.JSX.Element {
  return (
    <m.span
      layoutId={layoutId}
      layoutDependency={dependency}
      className={className}
      transition={transition}
      style={{ position: 'absolute', inset: 0, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  )
}

/* ------------------------------------------------------------------ */
/* MorphContainer (container transform)                                */
/* ------------------------------------------------------------------ */

export interface MorphContainerProps {
  layoutId: string
  /** Changing this cross-fades the content (out `dur.flash` blur 2, in at t = 120 blur 4 → 0). */
  contentKey: string
  children: ReactNode
  /** `spring.morph` opening, `spring.exit` closing back into the card. */
  closing?: boolean
  radius?: number
  className?: string
  style?: CSSProperties
}

/**
 * Card ⇄ dialog / Try-it → Hero. `borderRadius` and `boxShadow` live in
 * `style` so Motion scale-corrects them. Content cross-fades so text is never
 * scaled by projection.
 */
export function MorphContainer({
  layoutId, contentKey, children, closing = false, radius = 16, className, style
}: MorphContainerProps): React.JSX.Element {
  return (
    <m.div
      layoutId={layoutId}
      className={className}
      transition={closing ? SPRING.exit : SPRING.morph}
      style={{ borderRadius: radius, position: 'relative', ...style }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <m.div key={contentKey} variants={morphContent} initial="initial" animate="animate" exit="exit">
          {children}
        </m.div>
      </AnimatePresence>
    </m.div>
  )
}

/* ------------------------------------------------------------------ */
/* MorphBox (Flow Bar shape, no layout projection)                    */
/* ------------------------------------------------------------------ */

export interface MorphBoxProps {
  box: BarBox
  /** `spring.fluid` (sliver ⇄ capsule), `spring.morph` (state ↔ state), `spring.exit` (→ sliver). */
  transition: Transition
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Marks the element as a hit target for the click-through window (§4.1.1). */
  hit?: boolean
}

/**
 * An absolutely positioned layer in window coordinates whose `x`, `y`,
 * `width`, `height` and `borderRadius` animate directly. Springs retarget from
 * the current value and velocity on every state change (interruptible).
 */
export function MorphBox({ box, transition, children, className, style, hit = true }: MorphBoxProps): React.JSX.Element {
  return (
    <m.div
      data-hit={hit ? '' : undefined}
      className={className}
      initial={false}
      animate={{ x: box.x, y: box.y, width: box.width, height: box.height, borderRadius: box.borderRadius }}
      transition={transition}
      style={{ position: 'absolute', left: 0, top: 0, ...style }}
    >
      {children}
    </m.div>
  )
}

/* ------------------------------------------------------------------ */
/* PresenceSwap                                                        */
/* ------------------------------------------------------------------ */

/**
 * Keyed content swap with `popLayout` (exiting nodes leave the flow at once, so
 * nothing waits) and inert exits. Pass `custom` for direction-aware presets
 * (routeSwitch, paneSwitch, monthSwap).
 */
export function PresenceSwap({
  swapKey, variants, custom, children, className, style, initial = false, mode = 'popLayout'
}: {
  swapKey: string | number
  variants: Variants
  custom?: unknown
  children: ReactNode
  className?: string
  style?: CSSProperties
  initial?: boolean
  mode?: 'popLayout' | 'sync'
}): React.JSX.Element {
  return (
    <AnimatePresence mode={mode} initial={initial} custom={custom}>
      <SwapChild key={swapKey} variants={variants} custom={custom} className={className} style={style}>
        {children}
      </SwapChild>
    </AnimatePresence>
  )
}

function SwapChild({
  variants, custom, children, className, style, ref
}: {
  variants: Variants
  custom?: unknown
  children: ReactNode
  className?: string
  style?: CSSProperties
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      ref={ref}
      className={className}
      inert={inert.inert}
      style={{ ...style, ...inert.style }}
      variants={variants}
      custom={custom}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </m.div>
  )
}

/** Opacity-only fade used for disabled ↔ enabled and similar state tweens (§4.13). */
export const STATE_FADE: Transition = { duration: DUR.fast, ease: EASE.standard as unknown as Transition['ease'] }
