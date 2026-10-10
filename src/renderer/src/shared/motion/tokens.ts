/**
 * Quill motion tokens. The values are normative and mirror docs/MOTION.md §2
 * (and motion-tokens.json v2). A raw duration, curve, spring, distance, scale
 * or blur radius in a component is a QA failure (§7): import it from here.
 *
 * Units: DUR / STAGGER / WORD_VARIANTS times are in SECONDS (Motion's unit).
 * DUR_MS / HOLD are in milliseconds. Distances and blur radii are px.
 */

/* ------------------------------------------------------------------ */
/* Reduce Motion state (owned by MotionProvider, read by T()/WAAPI).   */
/* ------------------------------------------------------------------ */

let reducedNow = false
/** Internal: MotionProvider's store writes the live value here. */
export function _setReducedForTokens(v: boolean): void { reducedNow = v }
/** True while macOS Reduce Motion (or the main-process override) is on. */
export function isReducedMotion(): boolean { return reducedNow }

/* ------------------------------------------------------------------ */
/* 2.1 Durations                                                       */
/* ------------------------------------------------------------------ */

export const DUR_MS = {
  instant: 0, hoverIn: 60, flash: 80, micro: 100, tooltip: 125, fast: 150,
  hoverOut: 160, base: 200, moderate: 250, reveal: 300, expressive: 400, signature: 600
} as const
export type DurToken = keyof typeof DUR_MS

export const DUR = {
  instant: 0, hoverIn: 0.06, flash: 0.08, micro: 0.1, tooltip: 0.125, fast: 0.15,
  hoverOut: 0.16, base: 0.2, moderate: 0.25, reveal: 0.3, expressive: 0.4, signature: 0.6
} as const satisfies Record<DurToken, number>

/** Hard rules (§0). */
export const RULES = {
  everydayMaxMs: 250,
  signatureMaxMs: 600,
  maxBounceSpatial: 0.25,
  maxBounceGlyphPop: 0.4,
  exitToEntranceRatio: [0.4, 0.8]
} as const

/** Holds: timing, not motion. Unchanged under Reduce Motion (§5). ms. */
export const HOLD = {
  tooltipDelay: 500, tooltipGrace: 600, hoverIntentOpen: 80, hoverIntentClose: 300,
  successCheck: 180, notice: 4000, transformNotice: 1600, error: 6000, bannerSuccess: 400,
  highlight: 400, todoCheck: 450, copied: 1200, devicesSettle: 400, dwell: 350,
  coalesce: 120, pendingDelay: 150, partialThrottle: 100, closeTimeout: 300, spamWindow: 400,
  /** A menu or picker closes this long after a pick, so the selection move is seen (§4.1.10a, §4.4, §4.12). */
  pickClose: 120,
  /** Last resort for a `win:shown` that never arrives, when main can be asked (`win.shown()`). Not in the spec: a safety net, not a timing. */
  shownBackstop: 3000
} as const

/* ------------------------------------------------------------------ */
/* 2.2 Easing                                                          */
/* ------------------------------------------------------------------ */

export type Bezier = readonly [number, number, number, number]

export const EASE = {
  out: [0.23, 1, 0.32, 1],
  enter: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 0.8, 0.15],
  standard: [0.2, 0, 0, 1],
  drawer: [0.32, 0.72, 0, 1],
  inOut: [0.45, 0, 0.55, 1]
} as const satisfies Record<string, Bezier>
export type EaseToken = keyof typeof EASE | 'linear'

/** CSS string for an easing token (WAAPI and CSS transitions). */
export function cssEase(e: EaseToken | Bezier): string {
  if (e === 'linear') return 'linear'
  const b = typeof e === 'string' ? EASE[e] : e
  return `cubic-bezier(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]})`
}

/* ------------------------------------------------------------------ */
/* 2.3 Springs                                                         */
/* ------------------------------------------------------------------ */

export interface SpringToken {
  readonly type: 'spring'
  readonly visualDuration: number
  readonly bounce: number
}
const s = (visualDuration: number, bounce: number): SpringToken =>
  ({ type: 'spring', visualDuration, bounce }) as const

export const SPRING = {
  snap: s(0.15, 0),
  snappy: s(0.2, 0.1),
  ui: s(0.25, 0),
  fluid: s(0.25, 0.2),
  exit: s(0.2, 0),
  meter: s(0.28, 0),
  text: s(0.3, 0.3),
  gesture: s(0.3, 0.2),
  pop: s(0.32, 0.4),
  morph: s(0.34, 0.25),
  expressive: s(0.4, 0.25)
} as const
export type SpringName = keyof typeof SPRING

/** Mass-1 stiffness/damping equivalents (§2.3): k = (2π/d)², c = 4π(1−bounce)/d. */
export function springPhysics(sp: SpringToken): { stiffness: number; damping: number; zeta: number } {
  const stiffness = (2 * Math.PI / sp.visualDuration) ** 2
  const damping = (4 * Math.PI * (1 - sp.bounce)) / sp.visualDuration
  return { stiffness, damping, zeta: damping / (2 * Math.sqrt(stiffness)) }
}

const linearCache = new Map<SpringToken, { easing: string; duration: number }>()
/**
 * A spring as a WAAPI/CSS `linear()` easing plus its settle duration (ms), for
 * transform tweens that must stay on the compositor (word y, width FLIPs).
 * Sampled from the closed-form damped oscillator, 0 → 1.
 */
export function springToLinear(sp: SpringToken): { easing: string; duration: number } {
  const hit = linearCache.get(sp)
  if (hit) return hit
  const { stiffness, damping } = springPhysics(sp)
  const w0 = Math.sqrt(stiffness)
  const zeta = damping / (2 * w0)
  const x = (t: number): number => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t))
    }
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  }
  // Settle: last time |1 − x| > 0.001, scanning 1 ms steps up to 2 s.
  let settle = 0
  for (let t = 0; t <= 2; t += 0.001) if (Math.abs(1 - x(t)) > 0.001) settle = t
  const duration = Math.ceil((settle + 0.001) * 1000)
  const n = 48
  const pts: string[] = []
  for (let i = 0; i <= n; i++) {
    const v = i === n ? 1 : x((duration / 1000) * (i / n))
    pts.push(v.toFixed(4))
  }
  const out = { easing: `linear(${pts.join(', ')})`, duration }
  linearCache.set(sp, out)
  return out
}

/* ------------------------------------------------------------------ */
/* T(): every Motion transition passes through this (§5 enforcement 2) */
/* ------------------------------------------------------------------ */

type AnyTransition = Record<string, unknown>

/** Tween helper: `tween('fast', 'out')` → `{ duration: .15, ease: [...] }`. */
export function tween(d: DurToken, e: EaseToken = 'out', delay = 0): AnyTransition {
  return { duration: DUR[d], ease: e === 'linear' ? 'linear' : EASE[e], ...(delay ? { delay } : {}) }
}

/**
 * Returns the transition unchanged, or `{ duration: 0 }` while Reduce Motion is
 * on. Use it for inline `transition` props and imperative `animate()` calls.
 */
export function T<X extends AnyTransition>(t: X): X | { duration: 0 } {
  return reducedNow ? { duration: 0 } : t
}

/* ------------------------------------------------------------------ */
/* 2.4 Stagger                                                         */
/* ------------------------------------------------------------------ */

export const STAGGER_CAP = {
  tight: 8, list: 8, handoff: 6, tiles: 7, title: 8, bodyCompact: 8, digits: 3,
  /** `stagger.tight` in the Todos panel: open items and group expand (§4.12). */
  panel: 6
} as const

/**
 * Bulk changes apply instantly, with no per-item motion, when more than this
 * many items change at once: search filters (§4.8, §4.9), the languages grid
 * (§4.7), the project autocomplete and `todos:changed` backfills (§4.12).
 */
export const INSTANT_CAP = { filter: 30, languages: 24, autocomplete: 8, bulk: 8 } as const

/** The single opacity dip that stands in for a bulk change: `from` → 1 over `dur.fast` (§4.12). */
export const BULK_DIP = { from: 0.6, duration: DUR.fast } as const

export const STAGGER = {
  tight: 0.015, list: 0.02, handoff: 0.02, tiles: 0.04, title: 0.03, bodyCompact: 0.012,
  digits: 0.02, ring: 0.006, flush: 0.02,
  /** Flow Bar live words: clamp(35, 0.55 × EMA / N, 90) ms → seconds. */
  stream: (n: number, emaMs: number): number =>
    Math.min(0.09, Math.max(0.035, (0.55 * emaMs) / 1000 / Math.max(1, n))),
  /** Fit-to-total. 0 means "reveal as one unit" (fitted < 12 ms). */
  fit: (n: number, perWord: number, start = 0, total = 0.6, max = 0.06): number => {
    if (n <= 1) return 0
    const v = Math.min(max, Math.max(0, (total - start - perWord) / (n - 1)))
    return v < 0.012 ? 0 : v
  }
} as const

/** Delay of item `i` with a capped stagger: items past the cap go with the last capped item. */
export function staggerDelay(i: number, step: number, cap = Infinity, start = 0): number {
  return start + Math.min(i, cap - 1) * step
}

export const STREAM = {
  emaAlpha: 0.3, emaSeedMs: 1500, maxD: 24, splitCap: 40, partialThrottleMs: 100,
  catchUpPerWord: 0.22, catchUpCap: 0.035,
  unconfirmedColor: 'color-mix(in srgb, var(--fg) 60%, transparent)'
} as const

/* ------------------------------------------------------------------ */
/* 2.5 Distance, scale, blur, ring                                     */
/* ------------------------------------------------------------------ */

export const DIST = { xs: 2, sm: 4, nudge: 6, md: 8, tile: 12, lg: 16, xl: 24 } as const
export const SCALE = {
  press: 0.97, pressIcon: 0.92, pressCard: 0.98, enter: 0.96, exit: 0.98, chip: 0.9,
  reveal: 0.85, exitIcon: 0.8, pop: 0.6, popSignature: 0.5, lift: 1.02, hoverBar: 1.06
} as const
export const BLUR = { xs: 2, label: 3, sm: 4, md: 6, lg: 8, max: 10 } as const
/** §3.5: live filters per window, large blurred surfaces per window. */
export const BLUR_CAP = { live: 12, large: 4, largeSurfacePx: { w: 300, h: 150 } } as const

/** `blur(Npx)` string; never animate to the keyword `none` (§3.1). */
export const blurPx = (px: number): string => `blur(${px}px)`

export const RING = {
  default: { scale: [1, 1.3], opacity: [0.5, 0], duration: 0.42, ease: EASE.out, repeat: 0 },
  dot: { scale: [1, 1.6], opacity: [0.6, 0], duration: 0.42, ease: EASE.out, repeat: 0 },
  promo: { scale: [1, 1.4], opacity: [0.6, 0], duration: 1.6, ease: EASE.out, repeat: 2 }
} as const

export const LOOP = {
  pulse: { opacity: [1, 0.45, 1], duration: 1.2, ease: EASE.inOut, repeat: Infinity },
  spin: { rotate: 360, duration: 0.7, ease: 'linear', repeat: Infinity },
  indeterminate: { segment: 0.3, duration: 1.1, ease: 'linear', repeat: Infinity },
  promo: { period: 1.6, cycles: 3 }
} as const

/* ------------------------------------------------------------------ */
/* 2.6 Elevation, 2.7 Level, 2.8 Entrance                              */
/* ------------------------------------------------------------------ */

export const Z = { e0: 0, e1: 1, e2: 100, toast: 200, scrim: 300, dialog: 310, drag: 400 } as const

export const LEVEL = {
  tickMs: 42, decay: 0.86, frameMs: 16.7, floorPx: 4, rangePx: 22, minRateHz: 24,
  reducedHz: 4, reducedSegments: 5
} as const

export const ENTRANCE = {
  tile: {
    opacity: 0.34, opacityEase: EASE.enter, blur: BLUR.lg, filter: 0.36, y: DIST.tile,
    scale: SCALE.pressCard, spring: SPRING.morph, stagger: STAGGER.tiles, blurredTiles: 4,
    order: ['hero', 'wordsToday', 'streak', 'wpm', 'mostUsed', 'recent', 'scratchpad']
  },
  handoff: {
    opacity: 0.3, opacityEase: EASE.enter, blur: BLUR.md, filter: 0.3, y: DIST.tile,
    spring: SPRING.ui, stagger: STAGGER.handoff, start: 0.12, blurredTiles: 3
  },
  onboarding: { opacity: 0.4, filter: 0.4, ease: EASE.enter, y: DIST.lg, spring: SPRING.morph }
} as const

/* ------------------------------------------------------------------ */
/* 3.2 Per-word variants (WORD_VARIANTS)                               */
/* Times in s. y/blur in px unless `*Fs` (× resolved font size).       */
/* ------------------------------------------------------------------ */

export const WORD_VARIANTS = {
  headline: {
    blurFs: 0.2, blurMin: 8, blurMax: 10, yFs: 0.25, opacity: 0.315, filter: 0.45,
    transform: SPRING.text, ease: EASE.enter,
    delayed: { perWord: 0.4, opacity: 0.28 },
    swapOut: { duration: 0.15, blur: 8, yFs: -0.15, ease: EASE.exit },
    newWordsStart: 0.08
  },
  title: { blur: 6, yFs: 0.18, opacity: 0.22, filter: 0.32, transform: 0.32, ease: EASE.out, stagger: STAGGER.title, cap: 8 },
  titleUnit: { blur: 4, yFs: 0.12, opacity: 0.16, filter: 0.2, transform: 0.2, ease: EASE.out, delay: 0.04, out: 0.08 },
  label: { blur: 3, yFs: 0, opacity: 0.11, filter: 0.16, ease: EASE.out, exit: 0.08, enterDelay: 0.04 },
  block: { blur: 3, yFs: 0, from: 0.35, opacity: 0.16, filter: 0.16, ease: EASE.out, exit: 0.08, exitBlur: 2, enterDelay: 0.04 },
  body: { blur: 4, yFs: 0.12, opacity: 0.16, filter: 0.24, transform: 0.24, ease: EASE.out, splitCap: 40 },
  bodyCompact: { blur: 4, yFs: 0.12, opacity: 0.11, filter: 0.16, transform: 0.16, ease: EASE.out, stagger: STAGGER.bodyCompact, cap: 8 },
  stream: { blur: 4, y: DIST.xs, opacity: 0.16, filter: 0.22, transform: 0.22, ease: EASE.out },
  reblur: { blur: 3, from: 0.45, duration: 0.24, ease: EASE.out },
  neighbour: { blur: 2, from: 0.7, duration: 0.16, ease: EASE.out },
  streamExit: { blur: 3, duration: 0.08, ease: EASE.exit },
  digits: {
    blur: 4, yFs: 0.35, enter: 0.22, exit: 0.15, enterEase: EASE.out, exitEase: EASE.exit,
    large: { minFontPx: 32, blur: 6, yFs: 0.3 },
    subtle: { blur: 2, yFs: 0.2, enter: 0.15, exit: 0.1 }
  }
} as const
export type WordVariant = 'headline' | 'title' | 'titleUnit' | 'label' | 'block' | 'body' | 'bodyCompact'

/** Headline blur: clamp(8, 0.2 × fs, 10) px. */
export const headlineBlur = (fs: number): number =>
  Math.min(WORD_VARIANTS.headline.blurMax, Math.max(WORD_VARIANTS.headline.blurMin, WORD_VARIANTS.headline.blurFs * fs))

/* ------------------------------------------------------------------ */
/* §4.1.2 Flow Bar geometry (window coordinates, 400 × 260)            */
/* ------------------------------------------------------------------ */

export interface BarBox { x: number; y: number; width: number; height: number; borderRadius: string }

export const FLOWBAR = {
  window: { width: 400, height: 260 },
  anchor: 'right-centre',
  sliverHitWidth: 12,
  hitPadding: 4,
  shape: {
    sliver: { x: 394, y: 98, width: 6, height: 64, borderRadius: '6px 0px 0px 6px' },
    capsule: { x: 348, y: 51, width: 44, height: 158, borderRadius: '22px 22px 22px 22px' },
    recording: { x: 348, y: 51.5, width: 44, height: 157, borderRadius: '22px 22px 22px 22px' },
    busy: { x: 348, y: 106, width: 44, height: 48, borderRadius: '22px 22px 22px 22px' },
    error: { x: 348, y: 108, width: 44, height: 44, borderRadius: '22px 22px 22px 22px' }
  } satisfies Record<string, BarBox>,
  buttons: { centreX: 370, size: 32, language: 73, dictate: 111, voiceNote: 149, scratchpad: 187 },
  recDot: { cx: 370, cy: 69.5, size: 8 },
  waveform: { x: 357, y: 83.5, width: 26, height: 87, bars: 15 },
  timer: { x: 357, y: 180.5 },
  spinner: { cx: 370, cy: 130, size: 16 },
  partialCard: { x: 36, y: 76.5, width: 304, height: 107, radius: 16, textBox: { width: 276, lines: 2, padding: 4 } },
  errorCard: { x: 36, y: 47, width: 304, height: 166, radius: 16 },
  notice: { width: 261, height: 40, y: 110, xNextToSliver: 125, xNextToCapsule: 79 },
  languageMenu: { width: 200, rightEdge: 340, rowHeight: 32, maxRows: 5, padding: 8, minY: 16, maxBottom: 244 }
} as const

/** Choreography totals (Appendix A), ms. For QA assertions. */
export const TOTALS_MS = {
  'flowBar.sliverToCapsule': 250, 'flowBar.capsuleToSliver': 240, 'flowBar.toRecording': 340,
  'flowBar.toBusy': 340, 'flowBar.done': 580, 'flowBar.doneCopyFallback': 410, 'flowBar.error': 520,
  'flowBar.noticeIn': 250, 'flowBar.noticeOut': 150, 'flowBar.cancel': 200,
  'hub.routeSwitch': 240, 'hub.firstBento': 600, 'hub.dictationAdded': 340, 'hub.popoverIn': 250,
  'hub.popoverOut': 100, 'hub.dialog': 250, 'hub.dialogFromCard': 340, 'hub.dialogClose': 100,
  'hub.dialogCloseIntoCard': 210, 'hub.toastIn': 250, 'hub.toastReplace': 190, 'hub.banner': 250,
  'onboarding.entrance': 600, 'onboarding.grantedFlip': 540, 'onboarding.done': 540,
  'onboarding.handoff': 580, 'settings.paneSwitch': 240, 'settings.toggle': 200,
  'todos.panelOpen': 250, 'todos.panelClose': 150, 'scratchpad.open': 250, 'scratchpad.close': 150,
  'scratchpad.voiceNoteReveal': 600
} as const
