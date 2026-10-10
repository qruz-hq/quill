import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, m, type TargetAndTransition } from 'motion/react'
import { Icon } from '../shared/icons'
import {
  BLUR, BlurStream, BlurWords, DIST, DUR, FLOWBAR, LOOP, SPRING, STAGGER, StreamViewport,
  presets, useExitInert, useReduceMotion, type BlurStreamHandle
} from '../shared/motion'
import { AT, MID_Y, tw } from './choreo'
import { BlurUnit, Timer, useInitial, useLeaveKind, type UnitExit } from './parts'
import type { BarError, CardKind, Stage } from './state'

/* Cards: Bar / Partial B2ifmT and Bar Error PWeE1 (w304, padding 14, radius-md).
   One surface for both: its height and y morph between them (§4.1.9), its
   content swaps. It unfurls from the pill side by clip-path (§4.1.6). */

const W = FLOWBAR.partialCard.width
/** Room for the card's shadow (0 10px 28px) inside the clip; 8 on the pill side while closed. */
const BLEED = 40
const CLIP_OPEN = `inset(-${BLEED}px -${BLEED}px -${BLEED}px -${BLEED}px)`
const CLIP_CLOSED = `inset(-${BLEED}px -8px -${BLEED}px ${W}px)`

/** Partial text: 13.5 / 1.45, two lines, plus the viewport's halo padding. */
const TEXT = { size: 13.5, leading: 1.45 }
const VIEW_H =
  FLOWBAR.partialCard.textBox.lines * TEXT.size * TEXT.leading + 2 * FLOWBAR.partialCard.textBox.padding

/** Old content leaving a card that stays (partial to error and back): `dur.flash`, blur 2.
    The content swap is its own presence group, so a card that leaves does not replay it. */
const SWAP_OUT: UnitExit = { duration: DUR.flash, blur: BLUR.xs }
/** Done: the text is sent toward the pill (§4.1.8, t = 80). */
const SEND_OUT: UnitExit = { duration: DUR.fast, blur: BLUR.sm, x: DIST.nudge }

export interface CardProps {
  id: number
  kind: CardKind
  /** T0 of the unfurl in seconds: 0, or what is left of 60 ms when it first appears at stop. */
  t0: number
  run: number
  recording: boolean
  busy: boolean
  stage: Stage
  partial: string
  final: boolean
  headNotice: FlowNotice | null
  startedAt: number | null
  stoppedAt: number | null
  error: BarError | null
  errorSeq: number
  streamRef: RefObject<BlurStreamHandle | null>
  onRetry: () => void
  onChangeModel: () => void
  onDismiss: () => void
  onFocusWithin: (v: boolean) => void
}

export function Card(p: CardProps): React.JSX.Element {
  const inert = useExitInert()
  const reduced = useReduceMotion()
  const leave = useLeaveKind(p.id)
  const [errorHeight, setErrorHeight] = useState<number>(FLOWBAR.errorCard.height)
  // The error card hugs its content (a long message must never be clipped);
  // the design's copy measures FLOWBAR.errorCard.height.
  const height = p.kind === 'error' ? errorHeight : FLOWBAR.partialCard.height
  const y = MID_Y - height / 2
  const isError = p.kind === 'error'

  return (
    <m.div
      className="fb-card"
      data-hit=""
      data-zone="card"
      data-hit-escape={isError ? '' : undefined}
      inert={inert.inert}
      style={inert.style}
      onFocus={() => p.onFocusWithin(true)}
      onBlur={() => p.onFocusWithin(false)}
      initial={reduced ? false : { clipPath: CLIP_CLOSED, x: DIST.md, opacity: 0, y, height }}
      animate={{ clipPath: CLIP_OPEN, x: 0, opacity: 1, y, height }}
      exit={{
        clipPath: CLIP_CLOSED,
        opacity: 0,
        transition: {
          clipPath: SPRING.exit,
          opacity: tw('fast', 'exit', leave === 'done' || leave === 'copied' ? AT.done.cardFade : 0)
        }
      }}
      transition={{
        // y and height: state to state (partial ↔ error). clip-path never bounces.
        default: SPRING.morph,
        clipPath: { ...SPRING.ui, delay: p.t0 },
        x: { ...SPRING.morph, delay: p.t0 },
        opacity: tw('micro', 'out', p.t0)
      }}
    >
      <div className="fb-card__clip">
        <AnimatePresence initial={false}>
          {isError && p.error
            ? (
                <ErrorContent
                  key={`error-${p.errorSeq}`}
                  error={p.error}
                  onHeight={setErrorHeight}
                  onRetry={p.onRetry}
                  onChangeModel={p.onChangeModel}
                  onDismiss={p.onDismiss}
                />
              )
            : <PartialContent key={`partial-${p.run}`} {...p} />}
        </AnimatePresence>
      </div>
    </m.div>
  )
}

/* ---------- Partial B2ifmT: head, live text, progress (gap 10) ---------- */

function PartialContent(p: CardProps): React.JSX.Element {
  const reduced = useReduceMotion()
  const leave = useLeaveKind(p.id)
  // The stream mounts empty and takes the text one synchronous pass later, so
  // its first partial is a single diff (the catch-up reveal) under StrictMode too.
  const [armed, setArmed] = useState(false)
  useLayoutEffect(() => setArmed(true), [])
  const label = p.headNotice?.short
    ?? (p.recording ? 'LISTENING' : p.stage === 'polishing' ? 'POLISHING' : 'TRANSCRIBING')
  const track = FLOWBAR.partialCard.textBox.width
  const segment = track * LOOP.indeterminate.segment

  return (
    <BlurUnit className="fb-card__content fb-partial" exit={SWAP_OUT}>
      <BlurUnit
        className="fb-partial__head"
        enter={{ delay: p.t0 + AT.busy.head, duration: DUR.fast, blur: BLUR.sm }}
      >
        <div className={p.headNotice ? 'fb-partial__state fb-partial__state--notice' : 'fb-partial__state'}>
          <Icon name="waveform" active />
          <BlurWords className="fb-partial__label" variant="label" animateWidth text={label} />
        </div>
        <span className="fb-partial__time" aria-hidden>
          <Timer from={p.startedAt} to={p.recording ? null : p.stoppedAt} />
        </span>
      </BlurUnit>

      <BlurUnit className="fb-partial__body" out={leave === 'done' || leave === 'copied' ? SEND_OUT : null}>
        <StreamViewport className="fb-partial__view" height={VIEW_H}>
          <BlurStream
            ref={p.streamRef}
            className="fb-partial__text"
            style={{ fontSize: TEXT.size, lineHeight: TEXT.leading }}
            text={armed ? p.partial : ''}
            final={p.final}
            catchUpStart={p.t0 + AT.busy.head}
            ariaHidden
          />
        </StreamViewport>
      </BlurUnit>

      {/* Progress vL8N6: the slot is reserved while recording, so the card keeps its height across the stop. */}
      <div className="fb-partial__progress" aria-hidden>
        <m.div
          className="fb-partial__track"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: p.busy ? 1 : 0 }}
          transition={tw('fast', 'out', p.busy ? AT.busy.track : 0)}
        >
          {/* No real progress to report: `loop.indeterminate`. Reduce Motion keeps the static track. */}
          {p.busy && !reduced && (
            <m.span
              className="fb-partial__fill"
              style={{ width: segment }}
              initial={{ x: -segment }}
              animate={{ x: track }}
              transition={{ duration: LOOP.indeterminate.duration, ease: 'linear', repeat: Infinity }}
            />
          )}
        </m.div>
      </div>
    </BlurUnit>
  )
}

/* ---------- Bar Error PWeE1: head, message, actions (gap 12) ---------- */

function ErrorContent({
  error, onHeight, onRetry, onChangeModel, onDismiss
}: {
  error: BarError
  onHeight: (h: number) => void
  onRetry: () => void
  onChangeModel: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const reduced = useReduceMotion()
  const root = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    onHeight(el.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [onHeight])

  const ring = presets.ring()
  const actions = presets.fadeUpStagger({ y: DIST.sm, step: STAGGER.list, start: AT.error.actions })
  const press = presets.press('button')
  const initial = useInitial('initial')
  let i = 0

  return (
    <BlurUnit ref={root} className="fb-card__content fb-error" exit={SWAP_OUT}>
      <div className="fb-error__head">
        <m.div
          className="fb-error__tile"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={tw('fast', 'out', AT.error.tile)}
        >
          <Icon name="error" active />
          {/* Attention without a shake: one ring (§2.5). Removed under Reduce Motion. */}
          {!reduced && (
            <m.span
              className="fb-error__ring"
              initial={ring.initial as TargetAndTransition}
              animate={ring.animate as TargetAndTransition}
              transition={{ ...ring.transition, delay: AT.error.ring }}
            />
          )}
        </m.div>
        <div className="fb-error__text">
          <BlurWords className="fb-error__title" variant="title" delay={AT.error.title} text={error.title} />
          {error.meta && (
            <BlurWords className="fb-error__meta" variant="block" delay={AT.error.body} text={error.meta} />
          )}
        </div>
      </div>
      {error.body && (
        <BlurWords as="p" className="fb-error__message" variant="block" delay={AT.error.body} text={error.body} />
      )}
      <div className="fb-error__actions">
        {error.retry && (
          <m.button
            type="button" className="fb-error__retry" onClick={onRetry}
            variants={actions} custom={i++} initial={initial} animate="animate" {...press}
          >
            <Icon name="retry" />
            <span className="fb-error__retry-label">Try again</span>
          </m.button>
        )}
        {error.changeModel && (
          <m.button
            type="button" className="fb-error__change" onClick={onChangeModel}
            variants={actions} custom={i++} initial={initial} animate="animate" {...press}
          >
            <span className="fb-error__change-label">Change model</span>
          </m.button>
        )}
        <span className="fb-error__spacer" />
        <m.button
          type="button" className="fb-error__esc" onClick={onDismiss} aria-label="Dismiss"
          variants={actions} custom={i++} initial={initial} animate="animate"
        >
          esc
        </m.button>
      </div>
    </BlurUnit>
  )
}
