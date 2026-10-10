import { createContext, useContext, useEffect, useState, type ComponentProps, type CSSProperties } from 'react'
import { m, type Transition, type Variants } from 'motion/react'
import { Tile, TileTop } from '../shared/ui'
import {
  BlurNumber, EASE, ENTRANCE, TOTALS_MS, blurPx, isReducedMotion, onWinShown, presets, tween,
  useReduceMotion, useWindowShown, whenWindowShown
} from '../shared/motion'

/* Motion wiring of Hub, Dictation (docs/MOTION.md §4.3). The first entrance
   plays once per launch, on the hub's first show; every later mount of the
   screen (route back, recreated hub) renders at rest. */

/** Start times (s) inside the first entrance, §4.3.1 table. */
export const AT = { headline: 0.08, chip: 0.2, wave: 0.22, viz: 0.24 } as const
/** Offsets (ms) after a new row lands, §4.3.2: the row first, then what it changed. */
export const AFTER_ROW_MS = { counters: 80, longest: 160 } as const

export type Phase = 'hold' | 'play' | 'rest'

// Spent by the first screen that plays it, by a hub recreated in this launch
// (main passes firstShowDone), or by the window's first show passing while
// another route was up.
let spent = typeof window !== 'undefined' && window.flow?.win?.firstShowDone === true

// The budget starts when the window reaches the screen (only main knows when
// that is: the document reads `visible` while still hidden in Electron).
if (!spent) whenWindowShown(() => { setTimeout(() => { spent = true }, TOTALS_MS['hub.firstBento']) })

/**
 * `hold` while the window is still hidden (the initial frame), `play` from its
 * first show until the choreography's total, then `rest`. `wait` keeps it on
 * hold past the first show (the setup screen is covering the bento), so the
 * entrance plays once, when there is someone to see it.
 */
export function useFirstEntrance(wait = false): Phase {
  const reduced = useReduceMotion()
  const shown = useWindowShown(onWinShown)
  const [mine] = useState(() => !spent && !isReducedMotion())
  // The initial frame is always committed first, also in a window that is
  // already visible: the route layer's presence blocks `initial` on mount.
  const [started, setStarted] = useState(false)
  const [over, setOver] = useState(false)
  useEffect(() => {
    if (!mine || !shown || wait) return
    spent = true
    setStarted(true)
    const t = setTimeout(() => setOver(true), TOTALS_MS['hub.firstBento'])
    return () => clearTimeout(t)
  }, [mine, shown, wait])
  if (!mine || over || reduced) return 'rest'
  return started ? 'play' : 'hold'
}

const PhaseContext = createContext<Phase>('rest')
export const EntranceProvider = PhaseContext.Provider
export const usePhase = (): Phase => useContext(PhaseContext)

/**
 * Where an element stands in the entrance. It always commits its initial
 * frame before it plays, also when it mounts mid-entrance (its data arrived
 * late): the route layer's presence blocks `initial` on mount, so only a
 * change of `animate` is sure to run.
 * `entering` stays true for the length of the entrance this element joined.
 */
export function useEntranceStep(): { step: 'initial' | 'animate'; entering: boolean } {
  const phase = usePhase()
  const [joined] = useState(phase !== 'rest')
  const [go, setGo] = useState(false)
  useEffect(() => { if (joined && phase === 'play') setGo(true) }, [joined, phase])
  return { step: !joined || go || phase === 'rest' ? 'animate' : 'initial', entering: joined && phase !== 'rest' }
}

/**
 * Motion props for an element that takes part in the entrance. An element that
 * mounts at rest (a return visit) gets none at all, so it carries no motion
 * values: no `blur(0px)` left on a tile, no clip-path on the streak grid.
 */
export function useEntrance(variants: Variants): { variants?: Variants; initial?: 'initial'; animate?: 'initial' | 'animate' } {
  const { step } = useEntranceStep()
  const [joined] = useState(usePhase() !== 'rest')
  return joined ? { variants, initial: 'initial', animate: step } : {}
}

const MTile = m.create(Tile)
export const MTileTop = m.create(TileTop)

type TileName = (typeof ENTRANCE.tile.order)[number]

/**
 * A bento tile in the diagonal wave. `blur` defaults to the large-surface cap
 * (the first four tiles); the Hero passes false because its headline blurs per
 * word (rule 8) and blurs its Top and Bottom instead.
 */
export function EntranceTile({ name, blur, ...rest }: ComponentProps<typeof MTile> & { name: TileName; blur?: boolean }): React.JSX.Element {
  const i = ENTRANCE.tile.order.indexOf(name)
  return (
    <MTile
      custom={{ i, blur: blur ?? i < ENTRANCE.tile.blurredTiles }}
      {...useEntrance(presets.tileEntrance)}
      {...rest}
    />
  )
}

const ease = (e: readonly number[]): Transition['ease'] => e as unknown as Transition['ease']

/** The Hero's content blur, on its Top and Bottom (never on the headline). */
export const heroBlur: Variants = {
  initial: { filter: blurPx(ENTRANCE.tile.blur) },
  animate: {
    filter: blurPx(0),
    transition: { duration: ENTRANCE.tile.filter, ease: ease(EASE.enter) },
    transitionEnd: { filter: 'none' }
  }
}

/** Opacity only, `dur.fast`, from `at` seconds (Ready chip, mini wave). */
export const fadeAt = (at: number): Variants => ({
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tween('fast', 'out', at) }
})

/** Streak grid: one clip sweep, left to right, `dur.reveal` from t = 240. */
export const streakSweep: Variants = {
  initial: { clipPath: 'inset(0% 100% 0% 0%)' },
  animate: {
    clipPath: 'inset(0% 0% 0% 0%)',
    transition: tween('reveal', 'out', AT.viz),
    transitionEnd: { clipPath: 'none' }
  }
}

/**
 * The value, `ms` late when it changes. Used so a counter moves after the row
 * that caused it. Instant under Reduce Motion and while the window is hidden.
 */
export function useLagged<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    if (isReducedMotion() || document.visibilityState !== 'visible') { setShown(value); return }
    const t = setTimeout(() => setShown(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return shown
}

/* The bento's numerals are drawn with the fonts' proportional figures (vBtIm),
   so the digit slots keep them instead of BlurNumber's tabular default. */
const PROPORTIONAL: CSSProperties = { fontVariantNumeric: 'normal' }

/** A bento counter: only the digits that change move, never on mount. */
export function Count({ value, className }: { value: number; className?: string }): React.JSX.Element {
  return <BlurNumber value={value} className={className} style={PROPORTIONAL} />
}
