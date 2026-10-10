import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { AnimatePresence, m, useIsPresent, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon, type IconName } from '../shared/icons'
import { Keycap } from '../shared/ui/Keycap'
import {
  BLUR, BlurWords, DUR, DUR_MS, FLOWBAR, HOLD, SCALE, SPRING,
  presets, shapeRect, useBarHitTest, useReduceMotion, type BlurPart, type BlurStreamHandle
} from '../shared/motion'
import { Card } from './Card'
import { AT, GAP, MID_Y, shapeBox, shapeTransition, tw } from './choreo'
import {
  BarTooltip, BlurUnit, Check, LeaveContext, Spinner, TIP_H, Timer,
  glyphIn, useHold, useInitial, useTooltip, withoutBlur
} from './parts'
import { cardOf, initialState, reducer, viewOf, type BarState, type Phase } from './state'
import Waveform from './Waveform'

/* Flow Bar: design.pen "Flow Bar, States" (oQ6Qr), motion docs/MOTION.md §4.1.
   One fixed 400 × 260 transparent window. The bar is a single shape that
   morphs between sliver, capsule, recording, busy and error; every other layer
   is absolutely positioned in window coordinates around it. No layout or
   layoutId anywhere in here (§4.1.1). */

type Zone = 'bar' | 'card' | 'notice' | null

const zoneAt = (x: number, y: number): Zone =>
  (document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-zone]')?.dataset.zone as Zone | undefined) ?? null

/** When layers change under a resting pointer there is no mousemove: re-test here. */
const RETEST_MS = [0, DUR_MS.moderate, DUR_MS.signature]

export default function FlowBar(): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { phase } = state
  const view = viewOf(state)
  const card = cardOf(state)
  const box = shapeBox(view)

  const phaseRef = useRef<Phase>(phase)
  phaseRef.current = phase
  const doneAtRef = useRef(state.doneAt)
  doneAtRef.current = state.doneAt

  /* ---- IPC: main owns dictation, the bar reflects it ---- */
  useEffect(() => {
    const d = window.flow.dictation
    const offs = [
      d.onState((value) => dispatch({ type: 'state', value, now: Date.now() })),
      d.onStage((value) => dispatch({ type: 'stage', value, now: Date.now() })),
      // Always the full running text, never a delta.
      d.onPartial((text) => dispatch({ type: 'partial', text })),
      d.onError((message) => dispatch({ type: 'error', message, now: Date.now() }))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Notices. The copy fallback lands right after "done": no check, the card
  // sends out and the notice enters at t = 160 of that choreography (§4.1.8).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.flow.dictation.onNotice((notice) => {
      if (phaseRef.current === 'done' && notice.kind === 'copied') {
        const wait = Math.max(0, AT.done.noticeMs - (Date.now() - (doneAtRef.current ?? 0)))
        dispatch({ type: 'copied' })
        clearTimeout(timer)
        timer = setTimeout(() => dispatch({ type: 'notice', notice }), wait)
      } else {
        dispatch({ type: 'notice', notice })
      }
    })
    return () => { off(); clearTimeout(timer) }
  }, [])

  const toggleDictation = useCallback(async () => {
    if (phaseRef.current === 'recording') await window.flow.dictation.stop()
    else await window.flow.dictation.start()
  }, [])

  // Practice (onboarding "Try it"): pill only. Read at mount, then follow changes.
  useEffect(() => {
    // Optional until the preload ships these two.
    const d = window.flow.dictation as typeof window.flow.dictation & {
      practice?: () => Promise<boolean>
      onPractice?: (cb: (on: boolean) => void) => () => void
    }
    let live = true
    void d.practice?.().then((on) => { if (live && on) dispatch({ type: 'practice', on: true }) })
    const off = d.onPractice?.((on) => dispatch({ type: 'practice', on }))
    return () => { live = false; off?.() }
  }, [])

  // Hands-free latch (double-tap fn): the pill tooltip reads "Stop · fn" (§4.1.3).
  // A recording that never latches sends nothing, so every new one starts unlatched.
  const [latched, setLatched] = useState(false)
  useEffect(() => {
    const d = window.flow.dictation
    let live = true
    void d.latched().then((v) => { if (live && v) setLatched(true) })
    const offs = [d.onLatched(setLatched), d.onState((s) => { if (s === 'recording') setLatched(false) })]
    return () => { live = false; offs.forEach((off) => off()) }
  }, [])

  // Main broadcasts state idle + stage idle on cancel, which is what collapses the bar.
  const cancel = useCallback(() => { void window.flow.dictation.cancel() }, [])
  const dismissError = useCallback(() => dispatch({ type: 'dismiss-error' }), [])
  // Global Esc reaches the bar only while the pointer is over the error card.
  useEffect(() => window.flow.bar.onEscape(dismissError), [dismissError])

  const retry = useCallback(async () => {
    // Re-runs the kept recording (Error to Busy). With nothing kept, record again.
    if (!(await window.flow.dictation.retry())) await window.flow.dictation.start()
  }, [])
  const changeModel = useCallback(() => {
    dispatch({ type: 'dismiss-error' })
    window.flow.hub.openSettings('models')
  }, [])

  /* ---- Click-through window: hit test + pointer zones ---- */
  useBarHitTest((hit, escape) => window.flow.bar.setHit(hit, { escape }))

  const [over, setOver] = useState<Zone>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (e.isTrusted) pointer.current = { x: e.clientX, y: e.clientY }
      setOver(zoneAt(e.clientX, e.clientY))
    }
    const onOut = (): void => { pointer.current = null; setOver(null) }
    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onOut)
    window.addEventListener('blur', onOut)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onOut)
      window.removeEventListener('blur', onOut)
    }
  }, [])
  useEffect(() => {
    const ids = RETEST_MS.map((ms) => setTimeout(() => {
      const p = pointer.current
      if (p) document.dispatchEvent(new MouseEvent('mousemove', { clientX: p.x, clientY: p.y }))
    }, ms))
    return () => ids.forEach(clearTimeout)
  }, [view, card, state.notice])

  // Hover intent lives on the shape's zone, not on the 400 × 260 window.
  const onBar = over === 'bar'
  useEffect(() => {
    if (onBar === state.hover) return
    const t = setTimeout(
      () => dispatch({ type: 'hover', hover: onBar }),
      onBar ? HOLD.hoverIntentOpen : HOLD.hoverIntentClose
    )
    return () => clearTimeout(t)
  }, [onBar, state.hover])

  /* ---- Shape rect for main's 30 Hz backstop: the target now, the measured box on settle ---- */
  const shapeEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    window.flow.bar.setShapeRect({ x: box.x, y: box.y, width: box.width, height: box.height })
  }, [box])
  const publishShape = useCallback(() => {
    window.flow.bar.setShapeRect(shapeRect(shapeEl.current))
  }, [])

  /* ---- Done (§4.1.8): send the card at 80, collapse after the check's hold ---- */
  useEffect(() => {
    if (phase !== 'done') return
    const send = setTimeout(() => dispatch({ type: 'send' }), AT.done.sendMs)
    const end = setTimeout(() => dispatch({ type: 'done-end' }), AT.done.collapseMs)
    return () => { clearTimeout(send); clearTimeout(end) }
  }, [phase, state.doneAt])

  /* ---- Stream hand-offs: nothing carries a filter past a send-out, a swap or a cancel ---- */
  const streamRef = useRef<BlurStreamHandle | null>(null)
  useLayoutEffect(() => {
    if (state.sent || phase === 'error') streamRef.current?.settle()
  }, [state.sent, phase])
  useLayoutEffect(() => {
    if (state.leave?.kind === 'cancel') void streamRef.current?.exitAll()
  }, [state.leave])

  /* ---- Holds: paused on hover and focus-within ---- */
  const [cardFocus, setCardFocus] = useState(false)
  useHold(state.errorSeq, phase === 'error' ? HOLD.error : null, over === 'card' || cardFocus, dismissError)
  useHold(
    state.noticeSeq,
    state.notice ? state.notice.holdMs : null,
    over !== null,
    () => dispatch({ type: 'dismiss-notice' })
  )

  // T0 of a card that first appears at stop: the pill starts shrinking first (§4.1.6).
  const cardT0 = useRef(0)
  const lastCard = useRef(-1)
  if (card && lastCard.current !== state.cardId) {
    lastCard.current = state.cardId
    cardT0.current = phase === 'busy' && state.stoppedAt !== null
      ? Math.max(0, AT.busy.cardAtStopMs - (Date.now() - state.stoppedAt)) / 1000
      : 0
  }

  const recording = phase === 'recording'
  // Cancel · esc sits beside the pill; when the card takes that place it slides above it.
  const cancelY = card === 'partial' ? FLOWBAR.partialCard.y - GAP - TIP_H / 2 : MID_Y
  const zone = phase === 'error' ? 'card' : 'bar'

  return (
    <LeaveContext.Provider value={state.leave}>
      <div className={`fb fb--${view}`}>
        {/* The one live region: state words only, never the transcript (§3.3). */}
        <div className="m-sr-only" role="status" aria-live="polite">{statusText(state)}</div>

        <m.div
          ref={shapeEl}
          className={`fb-shape fb-shape--${view}`}
          data-hit=""
          data-zone={zone}
          data-hit-escape={phase === 'error' ? '' : undefined}
          initial={false}
          animate={{ x: box.x, y: box.y, width: box.width, height: box.height, borderRadius: box.borderRadius }}
          transition={shapeTransition(state.from, view, state.exit)}
          onAnimationComplete={publishShape}
        >
          <span className="fb-shape__shadow" />
          <span className="fb-shape__ring" />
        </m.div>
        {/* The 8 px between the bar and the screen edge stays part of it, so a
            pointer resting on the edge does not flip capsule and sliver. */}
        {view !== 'sliver' && (
          <div
            className="fb-edge"
            data-hit=""
            data-zone={zone}
            data-hit-escape={phase === 'error' ? '' : undefined}
            style={{ top: box.y, height: box.height }}
          />
        )}

        <Capsule
          open={view === 'capsule'}
          handoff={recording}
          pointerOnBar={onBar}
          onDictate={() => { void toggleDictation() }}
        />

        <AnimatePresence>
          {recording && <RecDot key={state.run} fromCapsule={state.fromCapsule} />}
        </AnimatePresence>
        <AnimatePresence>
          {recording && <Waveform key={state.run} />}
        </AnimatePresence>
        <AnimatePresence>
          {recording && (
            <BlurUnit
              key={state.run}
              className="fb-timer"
              aria-hidden
              enter={{ delay: AT.rec.timer, duration: DUR.base, blur: BLUR.sm }}
              exit={{ duration: DUR.flash, blur: BLUR.sm }}
            >
              <Timer from={state.startedAt} to={null} />
            </BlurUnit>
          )}
        </AnimatePresence>
        {recording && (
          <button
            type="button" className="fb-stop" data-hit="" data-zone="bar"
            onClick={() => { void toggleDictation() }} aria-label="Stop dictation"
          />
        )}
        <AnimatePresence>
          {recording && (
            <BarTooltip
              key="cancel"
              centre={cancelY}
              onClick={latched ? () => { void toggleDictation() } : cancel}
              label={latched ? 'Stop dictation' : 'Cancel dictation'}
            >
              <BlurWords className="fb-tooltip__label" variant="label" animateWidth text={latched ? 'Stop' : 'Cancel'} />
              <Keycap size="sm" className="fb-key">{latched ? 'fn' : 'esc'}</Keycap>
            </BarTooltip>
          )}
        </AnimatePresence>

        <PillGlyph phase={phase} />
        {phase === 'error' && (
          <button
            type="button" className="fb-pillbtn" data-hit="" data-zone="card" data-hit-escape=""
            onClick={dismissError} aria-label="Dismiss error"
          />
        )}

        <AnimatePresence>
          {card && (
            <Card
              key={state.cardId}
              id={state.cardId}
              kind={card}
              t0={cardT0.current}
              run={state.run}
              recording={recording}
              busy={phase === 'busy' || phase === 'done'}
              stage={state.stage}
              partial={state.partial}
              final={phase === 'done'}
              headNotice={state.headNotice}
              startedAt={state.startedAt}
              stoppedAt={state.stoppedAt}
              error={state.error}
              errorSeq={state.errorSeq}
              streamRef={streamRef}
              onRetry={() => { void retry() }}
              onChangeModel={changeModel}
              onDismiss={dismissError}
              onFocusWithin={setCardFocus}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {state.notice && <NoticePill key="notice" notice={state.notice} shapeX={box.x} />}
        </AnimatePresence>
      </div>
    </LeaveContext.Provider>
  )
}

/** State words for the live region. The transcript is never announced by the bar. */
function statusText(s: BarState): string {
  if (s.phase === 'recording') return s.headNotice ? `Recording. ${s.headNotice.text}` : 'Recording'
  if (s.phase === 'busy') {
    const word = s.stage === 'polishing' ? 'Polishing' : 'Transcribing'
    return s.headNotice ? `${word}. ${s.headNotice.text}` : word
  }
  if (s.phase === 'done') return 'Done'
  if (s.phase === 'error' && s.error) return [s.error.title, s.error.body].filter(Boolean).join('. ')
  return s.notice?.text ?? ''
}

/* ---------- Hover: Capsule r2Yqh (4 Bar Buttons) + Tooltip iIu70 ---------- */

type BarAction = { id: string; label: string; key: string; icon: IconName; y: number; delay: number; primary?: boolean; run: () => void }

// Dictate hands off to the rec dot: it leaves in the frame the dot mounts (§4.1.4).
const dictateButton: Variants = {
  ...presets.capsuleButton,
  exit: (mode?: unknown) =>
    mode === 'handoff'
      ? { opacity: 0, transition: { duration: DUR.instant } }
      : presets.capsuleButton.exit as TargetAndTransition
}

function Capsule({
  open, handoff, pointerOnBar, onDictate
}: { open: boolean; handoff: boolean; pointerOnBar: boolean; onDictate: () => void }): React.JSX.Element {
  const [hot, setHot] = useState<number | null>(null)
  const [keys, setKeys] = useState<{ note: string; pad: string }>({ note: '', pad: '' })

  // Shortcuts can be rebound in Settings: read them each time the capsule opens.
  useEffect(() => {
    if (!open) { setHot(null); return }
    let live = true
    void window.flow.settings.get().then((p) => {
      if (live) setKeys({ note: accel(p.noteShortcut), pad: accel(p.padShortcut) })
    })
    return () => { live = false }
  }, [open])

  const B = FLOWBAR.buttons
  const actions: BarAction[] = [
    { id: 'language', label: 'Change language', key: '', icon: 'globe', y: B.language, delay: AT.capsule.side, run: () => window.flow.hub.openSettings('languages') },
    { id: 'dictate', label: 'Dictate', key: 'fn', icon: 'microphone', y: B.dictate, delay: AT.capsule.dictate, primary: true, run: onDictate },
    { id: 'note', label: 'New note', key: keys.note, icon: 'note-plus', y: B.voiceNote, delay: AT.capsule.side, run: () => void window.flow.dictation.startVoiceNote() },
    { id: 'pad', label: 'Scratchpad', key: keys.pad, icon: 'notepad', y: B.scratchpad, delay: AT.capsule.far, run: () => window.flow.pad.open() }
  ]
  // The tooltip follows the last hovered button for as long as the pointer is on the bar.
  const tip = useTooltip(open && pointerOnBar ? hot : null)
  const tipAction = tip ? actions[tip.index] : null

  return (
    <>
      <AnimatePresence custom={handoff ? 'handoff' : undefined}>
        {open && actions.map((a, i) => (
          <CapsuleButton key={a.id} action={a} onHot={() => setHot(i)} />
        ))}
      </AnimatePresence>
      <AnimatePresence>
        {tip && tipAction && (
          <BarTooltip key="tip" centre={tipAction.y} instant={tip.instant}>
            <BlurWords className="fb-tooltip__label" variant="label" animateWidth text={tipAction.label} />
            {tipAction.key && <Keycap size="sm" className="fb-key">{tipAction.key}</Keycap>}
          </BarTooltip>
        )}
      </AnimatePresence>
    </>
  )
}

/** Bar Button FYQUc / Primary KXQWr: 32 round, at its slot in window coordinates. */
function CapsuleButton({ action: a, onHot }: { action: BarAction; onHot: () => void }): React.JSX.Element {
  const present = useIsPresent()
  const reduced = useReduceMotion()
  const B = FLOWBAR.buttons
  const variants = a.primary ? dictateButton : presets.capsuleButton
  return (
    <m.button
      type="button"
      className={a.primary ? 'fb-btn fb-btn--primary m-hover' : 'fb-btn m-hover'}
      data-hit=""
      data-zone="bar"
      inert={!present}
      style={{ left: B.centreX - B.size / 2, top: a.y - B.size / 2 }}
      variants={reduced ? withoutBlur(variants) : variants}
      custom={a.delay}
      initial={reduced ? false : 'initial'}
      animate="animate"
      exit="exit"
      {...presets.barButtonHover}
      {...presets.press('icon')}
      onClick={a.run}
      onMouseEnter={onHot}
      onFocus={onHot}
      aria-label={a.label}
    >
      <Icon name={a.icon} active={a.primary} />
    </m.button>
  )
}

/* ---------- Recording: rec dot (§4.1.4) ---------- */

/**
 * From the capsule the dot IS the Dictate button: it mounts as the 32 px violet
 * circle and shrinks into the rec slot on `spring.morph` while its colour
 * tweens to error. From idle it pops in at its slot. Then `loop.pulse`.
 */
function RecDot({ fromCapsule }: { fromCapsule: boolean }): React.JSX.Element {
  const reduced = useReduceMotion()
  const [handoff] = useState(fromCapsule)
  const B = FLOWBAR.buttons
  const D = FLOWBAR.recDot
  const slot = { x: D.cx - D.size / 2, y: D.cy - D.size / 2, width: D.size, height: D.size }
  const button = { x: B.centreX - B.size / 2, y: B.dictate - B.size / 2, width: B.size, height: B.size }
  return (
    <>
      <m.div
        className="fb-dot"
        aria-hidden
        initial={reduced ? false : handoff ? { ...button, opacity: 1, scale: 1 } : { ...slot, opacity: 0, scale: SCALE.pop }}
        animate={{ ...slot, opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: SCALE.pop, transition: tw('flash', 'exit') }}
        transition={handoff
          ? SPRING.morph
          : { default: { ...SPRING.snappy, delay: AT.rec.dotPop }, opacity: tw('micro', 'out', AT.rec.dotPop) }}
      >
        <m.span
          className="fb-dot__fill"
          initial={reduced ? false : { backgroundColor: handoff ? 'var(--violet)' : 'var(--bar-error)' }}
          animate={{
            backgroundColor: 'var(--bar-error)',
            // Reduce Motion: a static solid dot.
            ...(reduced ? {} : presets.pulse.animate)
          }}
          transition={{
            backgroundColor: tw('base', 'standard'),
            opacity: { ...presets.pulse.transition, delay: AT.rec.pulse }
          }}
        />
      </m.div>
      {handoff && !reduced && (
        <m.span
          className="fb-dot__mic"
          aria-hidden
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={tw('flash', 'out')}
        >
          <Icon name="microphone" active />
        </m.span>
      )}
    </>
  )
}

/* ---------- Pill glyph: spinner, check, error icon, centred in the pill ---------- */

function PillGlyph({ phase }: { phase: Phase }): React.JSX.Element {
  const initial = useInitial('initial')
  return (
    <div className="fb-glyph">
      <AnimatePresence>
        {phase === 'busy' && (
          <m.span
            key="spinner" className="fb-glyph__item" aria-hidden
            variants={glyphIn(AT.busy.spinner)} initial={initial} animate="animate" exit="exit"
          >
            <Spinner />
          </m.span>
        )}
        {phase === 'done' && (
          <m.span
            key="check" className="fb-glyph__item fb-glyph__item--done" aria-hidden
            variants={presets.signaturePop} initial={initial} animate="animate" exit="exit"
          >
            <Check />
          </m.span>
        )}
        {phase === 'error' && (
          <m.span
            key="error" className="fb-glyph__item fb-glyph__item--error" aria-hidden
            variants={glyphIn(AT.error.glyph, false)} initial={initial} animate="animate" exit="exit"
          >
            <BlurUnit as="span" className="fb-glyph__blur" enter={{ delay: AT.error.glyph, duration: DUR.fast, blur: BLUR.label }}>
              <Icon name="error" active />
            </BlurUnit>
          </m.span>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ---------- Bar / Notice lPWEY (§4.1.10) ---------- */

const NOTICE_ICON: Record<FlowNoticeKind, IconName> = {
  'copied': 'paste',
  'transform-applied': 'sparkle',
  'cleanup-failed': 'warning',
  'key-fallback': 'info',
  'cloud-fallback': 'info'
}

/** The design's copy fallback sets the shortcut as a key. Other kinds are plain text. */
function noticeParts(n: FlowNotice): BlurPart[] {
  if (n.kind !== 'copied') return [n.text]
  return ['Copied, press', { node: <Keycap size="sm" className="fb-key">⌘ V</Keycap>, text: '⌘V' }, 'to paste']
}

/**
 * Anchored 8 px left of the current shape; when the shape changes (sliver to
 * capsule) the anchor follows on `spring.fluid`. A new notice replaces the text
 * in place (`label` swap, real width), with no exit and enter.
 */
function NoticePill({ notice, shapeX }: { notice: FlowNotice; shapeX: number }): React.JSX.Element {
  const present = useIsPresent()
  const reduced = useReduceMotion()
  return (
    <m.div
      className="fb-notice-anchor"
      initial={false}
      animate={{ x: -(FLOWBAR.window.width - shapeX + GAP) }}
      transition={SPRING.fluid}
    >
      <m.div
        className="fb-notice"
        data-hit=""
        data-zone="notice"
        inert={!present}
        variants={reduced ? withoutBlur(presets.notice) : presets.notice}
        initial={reduced ? false : 'initial'}
        animate="animate"
        exit="exit"
      >
        <div className="fb-notice__tile"><Icon name={NOTICE_ICON[notice.kind]} /></div>
        <BlurWords
          className="fb-notice__text"
          variant="label"
          initial
          animateWidth
          delay={AT.notice.text}
          parts={noticeParts(notice)}
        />
      </m.div>
    </m.div>
  )
}

/* ---------- bits ---------- */

/** Electron accelerator to keycap text ("Alt+M" becomes "⌥ M"). */
function accel(a: string | undefined): string {
  if (!a) return ''
  const map: Record<string, string> = {
    CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Super: '⌘', Meta: '⌘',
    Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', AltGr: '⌥', Shift: '⇧'
  }
  return a.split('+').map((k) => map[k] ?? (k.length === 1 ? k.toUpperCase() : k)).join(' ')
}
