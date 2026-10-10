/**
 * Motion presets for the recurring hub patterns (docs/MOTION.md §4). Each is a
 * plain Motion `Variants` object (states `initial` / `animate` / `exit`) or a
 * props bundle, built only from tokens. Use with `m.*` components:
 *
 *   <m.div variants={PRESET.popover('top')} initial="initial" animate="animate" exit="exit" />
 *
 * Reduce Motion is handled globally (MotionGlobalConfig.skipAnimations +
 * MotionConfig), so presets don't branch on it.
 *
 * Rules baked in: blur ends at `filter: none` (transitionEnd), exits are faster
 * than entrances and never longer than `dur.fast`, popovers never stagger rows,
 * bouncy springs never drive opacity/colour/clip-path.
 */
import type { Transition, Variants } from 'motion/react'
import { BLUR, DIST, DUR, EASE, ENTRANCE, LOOP, RING, SCALE, SPRING, STAGGER, STAGGER_CAP, WORD_VARIANTS, blurPx, staggerDelay } from './tokens'

const tw = (duration: number, ease: readonly number[] | 'linear', delay = 0): Transition =>
  ({ duration, ease: ease as Transition['ease'], ...(delay ? { delay } : {}) })
const out = (d: number, delay = 0): Transition => tw(d, EASE.out, delay)
const exitT = (d: number, delay = 0): Transition => tw(d, EASE.exit, delay)
const atRest = { filter: 'none' } as const

/* ------------------------------------------------------------------ */
/* Lists: fade-up stagger (first show only; never inside popovers)     */
/* ------------------------------------------------------------------ */

export interface FadeUpOptions {
  y?: number
  step?: number
  cap?: number
  start?: number
  duration?: number
  blur?: number
}

/**
 * Item variants; pass the item index as `custom`. Defaults = Recent rows on
 * first entrance (§4.3.1): `y 6 → 0`, `dur.base` `ease.out`, `stagger.list` cap 8.
 */
export function fadeUpStagger({
  y = DIST.nudge, step = STAGGER.list, cap = STAGGER_CAP.list, start = 0, duration = DUR.base, blur
}: FadeUpOptions = {}): Variants {
  return {
    initial: { opacity: 0, y, ...(blur ? { filter: blurPx(blur) } : {}) },
    animate: (i: number = 0) => ({
      opacity: 1, y: 0, ...(blur ? { filter: blurPx(0) } : {}),
      transition: out(duration, staggerDelay(i, step, cap, start)),
      transitionEnd: blur ? atRest : undefined
    }),
    exit: { opacity: 0, transition: exitT(DUR.micro) }
  }
}

/* ------------------------------------------------------------------ */
/* Menus, popovers, dropdowns, selects, autocomplete, date picker      */
/* ------------------------------------------------------------------ */

/**
 * Origin-aware popover/menu (§4.11): `opacity` `dur.fast`, `scale 0.96 → 1` +
 * `y ∓4` with `spring.ui` → 250. Exit 100 ms. `origin` = which side the trigger
 * is on. `blur` adds the mic picker's `blur(2px) → 0` (§4.4).
 * Set `transform-origin` on the element to the trigger side.
 */
export function popover(origin: 'top' | 'bottom' = 'top', opts: { blur?: boolean; fromScale?: number } = {}): Variants {
  const y = origin === 'top' ? -DIST.sm : DIST.sm
  return {
    initial: { opacity: 0, scale: opts.fromScale ?? SCALE.enter, y, ...(opts.blur ? { filter: blurPx(BLUR.xs) } : {}) },
    animate: {
      opacity: 1, scale: 1, y: 0, ...(opts.blur ? { filter: blurPx(0) } : {}),
      transition: { default: SPRING.ui, opacity: out(DUR.fast), filter: out(DUR.fast) },
      transitionEnd: opts.blur ? atRest : undefined
    },
    exit: { opacity: 0, scale: SCALE.exit, transition: exitT(DUR.micro) }
  }
}

/** Language menu on the Flow Bar opens sideways: `x +4 → 0` instead of y (§4.1.10a). */
export const sideMenu: Variants = {
  initial: { opacity: 0, scale: SCALE.enter, x: DIST.sm },
  animate: { opacity: 1, scale: 1, x: 0, transition: { default: SPRING.ui, opacity: out(DUR.fast) } },
  exit: { opacity: 0, scale: SCALE.exit, transition: exitT(DUR.micro) }
}

/** Select opens in place (selected row over the trigger): scale only, no y (§4.7). */
export const selectInPlace: Variants = {
  initial: { opacity: 0, scale: SCALE.enter },
  animate: { opacity: 1, scale: 1, transition: { default: SPRING.ui, opacity: out(DUR.fast) } },
  exit: { opacity: 0, scale: SCALE.exit, transition: exitT(DUR.micro) }
}

/** Project autocomplete (§4.12): scale 0.98 → 1 and y −4 → 0. */
export const autocomplete: Variants = popover('top', { fromScale: SCALE.exit })

/* ------------------------------------------------------------------ */
/* Dialog (+ scrim)                                                    */
/* ------------------------------------------------------------------ */

/** Dialog from a button (§4.8): scrim + content layer (a sibling of any glass). Total 250. */
export const dialog = {
  scrim: {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: out(DUR.base) },
    exit: { opacity: 0, transition: tw(DUR.fast, EASE.out) }
  } satisfies Variants,
  content: {
    initial: { opacity: 0, scale: SCALE.enter, y: DIST.md, filter: blurPx(BLUR.md) },
    animate: {
      opacity: 1, scale: 1, y: 0, filter: blurPx(0),
      transition: { default: SPRING.ui, opacity: out(DUR.fast), filter: out(DUR.base) },
      transitionEnd: atRest
    },
    exit: {
      opacity: 0, scale: SCALE.exit, filter: blurPx(BLUR.xs),
      transition: exitT(DUR.micro)
    }
  } satisfies Variants
}

/** Content cross-fade inside a container transform (card → dialog, Try-it → Hero). */
export const morphContent: Variants = {
  initial: { opacity: 0, filter: blurPx(BLUR.sm) },
  animate: { opacity: 1, filter: blurPx(0), transition: out(DUR.base, 0.12), transitionEnd: atRest },
  exit: { opacity: 0, filter: blurPx(BLUR.xs), transition: tw(DUR.flash, EASE.out) }
}

/* ------------------------------------------------------------------ */
/* Toast, banner, notice, tooltip                                      */
/* ------------------------------------------------------------------ */

/**
 * Toast (§4.10). Pass `custom="replace"` to the incoming toast while another
 * exits: the old exits upward in 100 ms and the new enters at t = 40 with
 * `spring.snap` (→ 190). One toast at a time.
 */
export const toast: Variants = {
  initial: { opacity: 0, y: DIST.lg, scale: SCALE.enter, filter: blurPx(BLUR.md) },
  animate: (mode?: 'replace') => mode === 'replace'
    ? {
        opacity: 1, y: 0, scale: 1, filter: blurPx(0),
        transition: { default: { ...SPRING.snap, delay: 0.04 }, opacity: out(DUR.fast, 0.04), filter: out(DUR.fast, 0.04) },
        transitionEnd: atRest
      }
    : {
        opacity: 1, y: 0, scale: 1, filter: blurPx(0),
        transition: { default: SPRING.fluid, opacity: out(DUR.fast), filter: out(DUR.base) },
        transitionEnd: atRest
      },
  exit: (mode?: 'replace') => mode === 'replace'
    ? { opacity: 0, y: -DIST.md, transition: exitT(DUR.micro) }
    : { opacity: 0, y: DIST.md, filter: blurPx(BLUR.sm), transition: exitT(DUR.fast) }
}

/** Banner content inside a `RealHeight` wrapper (§4.5): `block` + `y −6 → 0` at t = 60. */
export const bannerContent: Variants = {
  initial: { opacity: WORD_VARIANTS.block.from, y: -DIST.nudge, filter: blurPx(BLUR.label) },
  animate: {
    opacity: 1, y: 0, filter: blurPx(0),
    transition: { default: out(WORD_VARIANTS.block.opacity, 0.06) },
    transitionEnd: atRest
  },
  exit: { opacity: 0, transition: exitT(DUR.fast) }
}

/** Flow Bar notice pill (§4.1.10): enter 250, exit 150. Text plays `label` at t = 60 separately. */
export const notice: Variants = {
  initial: { opacity: 0, x: DIST.lg, scale: SCALE.enter, filter: blurPx(BLUR.sm) },
  animate: {
    opacity: 1, x: 0, scale: 1, filter: blurPx(0),
    transition: { default: SPRING.fluid, opacity: out(DUR.fast), filter: out(DUR.base) },
    transitionEnd: atRest
  },
  exit: { opacity: 0, x: DIST.tile, filter: blurPx(BLUR.sm), transition: exitT(DUR.fast) }
}

/** Hub tooltip (§4.11): after `hold.tooltipDelay`, scale 0.97 → 1, `dur.tooltip`. */
export const tooltip: Variants = {
  initial: { opacity: 0, scale: SCALE.press },
  animate: { opacity: 1, scale: 1, transition: out(DUR.tooltip) },
  exit: { opacity: 0, transition: tw(DUR.flash, EASE.out) }
}

/** Flow Bar tooltip: also slides out from the bar, `x +6 → 0` (§4.1.3). Move between buttons with `spring.fluid` on y. */
export const barTooltip: Variants = {
  initial: { opacity: 0, scale: SCALE.press, x: DIST.nudge },
  animate: { opacity: 1, scale: 1, x: 0, transition: out(DUR.tooltip) },
  exit: { opacity: 0, transition: tw(DUR.flash, EASE.out) }
}

/* ------------------------------------------------------------------ */
/* Route / pane switches (shared axis, no page blur)                   */
/* ------------------------------------------------------------------ */

/**
 * Route switch (§4.2): pass `custom = +1 | −1` (nav index direction) to both the
 * AnimatePresence and the page. Outgoing `dur.flash`; incoming at t = 30:
 * opacity `dur.fast` + `x ±6 → 0` `spring.snap` (→ 180). Use `mode="popLayout"`.
 */
export const routeSwitch: Variants = {
  initial: (dir: number = 1) => ({ opacity: 0, x: DIST.nudge * Math.sign(dir || 1) }),
  animate: { opacity: 1, x: 0, transition: { default: { ...SPRING.snap, delay: 0.03 }, opacity: out(DUR.fast, 0.03) } },
  exit: { opacity: 0, transition: exitT(DUR.flash) }
}

/** Settings pane switch (§4.7): same, on Y with `dist.md`. */
export const paneSwitch: Variants = {
  initial: (dir: number = 1) => ({ opacity: 0, y: DIST.md * Math.sign(dir || 1) }),
  animate: { opacity: 1, y: 0, transition: { default: { ...SPRING.snap, delay: 0.03 }, opacity: out(DUR.fast, 0.03) } },
  exit: { opacity: 0, transition: exitT(DUR.flash) }
}

/** Date-picker month swap (§4.12): `custom = +1 | −1`. */
export const monthSwap: Variants = {
  initial: (dir: number = 1) => ({ opacity: 0, x: DIST.lg * dir, filter: blurPx(BLUR.xs) }),
  animate: {
    opacity: 1, x: 0, filter: blurPx(0),
    transition: { default: SPRING.ui, opacity: out(DUR.fast), filter: out(DUR.fast) },
    transitionEnd: atRest
  },
  exit: (dir: number = 1) => ({ opacity: 0, x: -DIST.lg * dir, transition: exitT(DUR.micro) })
}

/** Editor content cross-fade on tab switch: no blur, no y (§4.9). */
export const crossFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: out(DUR.fast) },
  exit: { opacity: 0, transition: exitT(DUR.flash) }
}

/* ------------------------------------------------------------------ */
/* Tiles: bento first entrance, hand-off, onboarding                   */
/* ------------------------------------------------------------------ */

export interface TileCustom { i: number; blur?: boolean; start?: number }

/**
 * Bento first entrance (§4.3.1) on each tile's CONTENT layer (never a glass
 * parent). `custom = { i, blur }`; blur only for the first 4 large tiles.
 */
export const tileEntrance: Variants = {
  initial: ({ blur }: TileCustom = { i: 0 }) => ({
    opacity: 0, y: ENTRANCE.tile.y, scale: ENTRANCE.tile.scale, ...(blur ? { filter: blurPx(ENTRANCE.tile.blur) } : {})
  }),
  animate: ({ i, blur, start = 0 }: TileCustom = { i: 0 }) => {
    const delay = start + Math.min(i, STAGGER_CAP.tiles - 1) * ENTRANCE.tile.stagger
    return {
      opacity: 1, y: 0, scale: 1, ...(blur ? { filter: blurPx(0) } : {}),
      transition: {
        default: { ...ENTRANCE.tile.spring, delay },
        opacity: tw(ENTRANCE.tile.opacity, ENTRANCE.tile.opacityEase, delay),
        filter: tw(ENTRANCE.tile.filter, EASE.enter, delay)
      },
      transitionEnd: blur ? atRest : undefined
    }
  }
}

/** Bento in the onboarding hand-off (§4.6.5): from t = 120, 20 ms stagger, `spring.ui`, blur 6 on 3 tiles. */
export const handoffTile: Variants = {
  initial: ({ blur }: TileCustom = { i: 0 }) => ({
    opacity: 0, y: ENTRANCE.handoff.y, ...(blur ? { filter: blurPx(ENTRANCE.handoff.blur) } : {})
  }),
  animate: ({ i, blur }: TileCustom = { i: 0 }) => {
    const delay = ENTRANCE.handoff.start + Math.min(i, STAGGER_CAP.handoff - 1) * ENTRANCE.handoff.stagger
    return {
      opacity: 1, y: 0, ...(blur ? { filter: blurPx(0) } : {}),
      transition: {
        default: { ...ENTRANCE.handoff.spring, delay },
        opacity: tw(ENTRANCE.handoff.opacity, ENTRANCE.handoff.opacityEase, delay),
        filter: tw(ENTRANCE.handoff.filter, EASE.enter, delay)
      },
      transitionEnd: blur ? atRest : undefined
    }
  }
}

/** Onboarding tiles (§4.6.1): `custom = { i: 0, start (s), blur (px) }`. */
export const onboardingTile: Variants = {
  initial: ({ blur }: { blur?: number } = {}) => ({ opacity: 0, y: ENTRANCE.onboarding.y, ...(blur ? { filter: blurPx(blur) } : {}) }),
  animate: ({ start = 0, blur }: { start?: number; blur?: number } = {}) => ({
    opacity: 1, y: 0, ...(blur ? { filter: blurPx(0) } : {}),
    transition: {
      default: { ...ENTRANCE.onboarding.spring, delay: start },
      opacity: tw(ENTRANCE.onboarding.opacity, ENTRANCE.onboarding.ease, start),
      filter: tw(ENTRANCE.onboarding.filter, ENTRANCE.onboarding.ease, start)
    },
    transitionEnd: blur ? atRest : undefined
  })
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** Row/card content on insert (inside `RealHeight`): opacity + blur 4 → 0, `dur.base`. */
export const rowInsert: Variants = {
  initial: { opacity: 0, filter: blurPx(BLUR.sm) },
  animate: { opacity: 1, filter: blurPx(0), transition: out(DUR.base), transitionEnd: atRest },
  exit: { opacity: 0, transition: exitT(DUR.micro) }
}

/** Recent row on `dictations:added` (§4.3.2): content `y −6 → 0`, `dur.base`. */
export const recentRowInsert: Variants = {
  initial: { opacity: 0, y: -DIST.nudge },
  animate: { opacity: 1, y: 0, transition: out(DUR.base) },
  exit: { opacity: 0, transition: exitT(DUR.micro) }
}

/** Row delete (§4.3.2/§4.8/§4.12): `x → −8`, blur 2, `dur.micro` `ease.exit`; height collapses via RealHeight (`spring.exit`). */
export const rowDelete: Variants = {
  initial: { opacity: 1, x: 0 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -DIST.md, filter: blurPx(BLUR.xs), transition: exitT(DUR.micro) }
}

/** Card delete: `scale → 0.96` instead of x (§4.8). */
export const cardDelete: Variants = {
  initial: { opacity: 1, scale: 1 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: SCALE.enter, filter: blurPx(BLUR.xs), transition: exitT(DUR.micro) }
}

/** Filtered-out cards (search): `scale → 0.98`, `dur.micro`; survivors use `layout="position"`. */
export const filterOut: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: out(DUR.fast) },
  exit: { opacity: 0, scale: SCALE.exit, transition: exitT(DUR.micro) }
}

/** Row actions reveal on hover (instant on :focus-within, do that in CSS). */
export const rowActions: Variants = {
  initial: { opacity: 0, x: DIST.sm },
  animate: { opacity: 1, x: 0, transition: out(DUR.micro) },
  exit: { opacity: 0, transition: tw(DUR.flash, EASE.out) }
}

/* ------------------------------------------------------------------ */
/* Glyph pops, chips, badges                                           */
/* ------------------------------------------------------------------ */

/** Badges, checkbox fills, selection circles: `scale 0.6 → 1` `spring.snappy`. */
export const popIn: Variants = {
  initial: { opacity: 0, scale: SCALE.pop },
  animate: { opacity: 1, scale: 1, transition: { default: SPRING.snappy, opacity: out(DUR.micro) } },
  exit: { opacity: 0, scale: SCALE.pop, transition: exitT(DUR.micro) }
}

/** Signature glyph pops ≤ 24 px (granted check, done check): `scale 0.5 → 1` `spring.pop`. */
export const signaturePop: Variants = {
  initial: { opacity: 0, scale: SCALE.popSignature },
  animate: { opacity: 1, scale: 1, transition: { default: SPRING.pop, opacity: out(DUR.fast) } },
  exit: { opacity: 0, transition: tw(DUR.flash, EASE.out) }
}

/** Status chips, `@Project` token: `scale 0.9 → 1` `spring.snappy`. */
export const chipIn: Variants = {
  initial: { opacity: 0, scale: SCALE.chip },
  animate: { opacity: 1, scale: 1, transition: { default: SPRING.snappy, opacity: out(DUR.fast) } },
  exit: { opacity: 0, scale: SCALE.chip, transition: exitT(DUR.micro) }
}

/** Check stroke: use on an `m.path` (`pathLength 0 → 1`, `dur.base` `ease.out`). */
export const checkStroke: Variants = {
  initial: { pathLength: 0 },
  animate: { pathLength: 1, transition: out(DUR.base) }
}

/* ------------------------------------------------------------------ */
/* Press / hover props                                                 */
/* ------------------------------------------------------------------ */

/**
 * Press feedback (§4.13): `spring.snap` on pointerdown, release with `spring.snappy`.
 * Spread onto an `m.*` element: `<m.button {...press('button')} />`. Rows never scale.
 */
export function press(kind: 'button' | 'icon' | 'card' = 'button'): {
  whileTap: { scale: number; transition: Transition }
  transition: Transition
} {
  const scale = kind === 'icon' ? SCALE.pressIcon : kind === 'card' ? SCALE.pressCard : SCALE.press
  return { whileTap: { scale, transition: SPRING.snap }, transition: SPRING.snappy }
}

/** Flow Bar buttons are the only hover-scale (1.06, `spring.snappy`). */
export const barButtonHover = { whileHover: { scale: SCALE.hoverBar, transition: SPRING.snappy } } as const

/** Flow Bar capsule buttons reveal: Dictate 20, Language + Voice note 35, Scratchpad 50 ms (`custom` = delay s). */
export const capsuleButton: Variants = {
  initial: { opacity: 0, scale: SCALE.reveal, filter: blurPx(BLUR.label) },
  animate: (delay: number = 0) => ({
    opacity: 1, scale: 1, filter: blurPx(0),
    transition: { default: { ...SPRING.snap, delay }, opacity: out(DUR.micro, delay), filter: out(DUR.fast, delay) },
    transitionEnd: atRest
  }),
  exit: { opacity: 0, scale: SCALE.exitIcon, transition: exitT(DUR.micro) }
}

/* ------------------------------------------------------------------ */
/* Loops and rings                                                     */
/* ------------------------------------------------------------------ */

/** `loop.pulse` (rec dot, listening, waiting). Static solid dot under Reduce Motion. */
export const pulse = {
  animate: { opacity: [...LOOP.pulse.opacity] },
  transition: { duration: LOOP.pulse.duration, ease: EASE.inOut as unknown as Transition['ease'], repeat: Infinity }
}

/** `loop.spin` for spinners (only while work is in flight). */
export const spin = {
  animate: { rotate: LOOP.spin.rotate },
  transition: { duration: LOOP.spin.duration, ease: 'linear' as const, repeat: Infinity }
}

/** One attention ring on an outline layer (`::after`-like span). Never repeats except `promo` (3 cycles). */
export function ring(kind: keyof typeof RING = 'default'): { initial: object; animate: object; transition: Transition } {
  const r = RING[kind]
  return {
    initial: { scale: r.scale[0], opacity: r.opacity[0] },
    animate: { scale: r.scale[1], opacity: r.opacity[1] },
    transition: { duration: r.duration, ease: r.ease as unknown as Transition['ease'], repeat: r.repeat }
  }
}

/** Real-height transitions, open vs close (§2.3: terminal collapses use `spring.exit`). */
export const HEIGHT = { open: SPRING.ui, close: SPRING.exit } as const

export const PRESET = {
  fadeUpStagger, popover, sideMenu, selectInPlace, autocomplete, dialog, morphContent, toast,
  bannerContent, notice, tooltip, barTooltip, routeSwitch, paneSwitch, monthSwap, crossFade,
  tileEntrance, handoffTile, onboardingTile, rowInsert, recentRowInsert, rowDelete, cardDelete,
  filterOut, rowActions, popIn, signaturePop, chipIn, checkStroke, press, barButtonHover,
  capsuleButton, pulse, spin, ring, HEIGHT
} as const
