import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, m, useAnimate, type Transition, type Variants } from 'motion/react'
import { Icon, AppMark, type IconName } from '../shared/icons'
import { Button, Pill, type ButtonVariant, type StatusTone } from '../shared/ui'
import {
  BLUR, BlurWords, DIST, DUR, EASE, ENTRANCE, PRESET, RealWidth, SCALE, SPRING, STAGGER, WORD_VARIANTS,
  blurPx, filterBudget, isReducedMotion, onWinShown, useExitInert, useReduceMotion, useWindowShown, type SpringToken
} from '../shared/motion'
import { has, holdKeyFor, usePlatform, words } from '../shared/platform'
import { fmtBytes, pretty as prettyFor } from './settings/shared'
import { TryIt } from './onboarding/TryIt'
import { Download, GettingReady, useSpeechModel } from './onboarding/speechModel'
import './onboarding.css'

type Accent = 'violet' | 'tangerine' | 'lime' | 'cyan'
type StepId = 'mic' | 'ax' | 'model'
const STEPS: readonly StepId[] = ['mic', 'ax', 'model']
/** The expanded step, or 'none' when both are rows. */
type Open = StepId | 'none'
type Glyph = 'check' | 'error' | 'hourglass' | 'dot' | 'download'
type Status = { tone: StatusTone; label: string; glyph: Glyph }

/* Choreography offsets (docs/MOTION.md §4.6), in seconds. */
const AT = {
  hero: 0, headline: 0.1, headlineReentry: 0.04, step1: 0.12, step2: 0.15, tracker: 0.16, foot: 0.22,
  ring: 0.04, trackerCheck: 0.15, flipSwap: 0.2, doneSwap: 0.06, bodyIn: 0.12, footDone: 0.18
} as const

const ease = (e: readonly number[]): Transition['ease'] => e as unknown as Transition['ease']
const at = (d: number, e: readonly number[], delay = 0): Transition => ({ duration: d, ease: ease(e), delay })
const REST = { filter: 'none' } as const

/** Content blur of an entering tile (the tile itself carries opacity and y). */
const blurIn: Variants = {
  initial: (blur: number) => ({ filter: blurPx(blur) }),
  animate: () => ({
    filter: blurPx(0),
    transition: at(ENTRANCE.onboarding.filter, ENTRANCE.onboarding.ease, AT.hero),
    transitionEnd: REST
  })
}
const footIn: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: at(DUR.base, EASE.out, AT.foot) }
}
/* Blur budget (§3.5: 12 live filters per window). A swap of the expanded step
   changes many labels at once, and each of those is a BlurWords that takes
   its own slot from the shared pool. So the motion here holds at most ONE
   filter, on the surface that comes in (the step card, or the Try it tile),
   and that one is taken from the same pool before the swap (`custom` = it was
   granted). What leaves only fades: its 80 ms were never read as a blur. */

/** Expanded step content: in at t = 120 of the swap, out first. */
const cardSwap: Variants = {
  initial: (blur: boolean) => ({ opacity: 0, y: DIST.nudge, ...(blur ? { filter: blurPx(BLUR.sm) } : {}) }),
  animate: (blur: boolean) => ({
    opacity: 1, y: 0, ...(blur ? { filter: blurPx(0) } : {}),
    transition: at(DUR.base, EASE.out, AT.bodyIn), transitionEnd: blur ? REST : undefined
  }),
  exit: { opacity: 0, transition: at(DUR.flash, EASE.exit) }
}
const rowSwap: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: at(DUR.fast, EASE.out, DUR.flash) },
  exit: { opacity: 0, transition: at(DUR.flash, EASE.exit) }
}
/** "Tile / Try it" entering in the Done choreography. */
const tryIn: Variants = {
  initial: (blur: boolean) => ({
    opacity: 0, y: ENTRANCE.onboarding.y, scale: SCALE.press, ...(blur ? { filter: blurPx(BLUR.lg) } : {})
  }),
  animate: (blur: boolean) => ({
    opacity: 1, y: 0, scale: 1, ...(blur ? { filter: blurPx(0) } : {}),
    transition: {
      default: { ...ENTRANCE.onboarding.spring, delay: AT.doneSwap },
      opacity: at(ENTRANCE.onboarding.opacity, ENTRANCE.onboarding.ease, AT.doneSwap),
      filter: at(ENTRANCE.onboarding.filter, ENTRANCE.onboarding.ease, AT.doneSwap)
    },
    transitionEnd: blur ? REST : undefined
  }),
  exit: { opacity: 0, transition: at(DUR.micro, EASE.exit) }
}
/** Reduce Motion: a swap is one cut. No opacity ramp, no offset, no filter, on any frame. */
const CUT: Variants = {
  initial: { opacity: 1 },
  animate: { opacity: 1, transition: { duration: 0 } },
  exit: { opacity: 0, transition: { duration: 0 } }
}
/** How long the incoming surface holds its filter slot (ms): its delay, its blur, a frame of slack. */
const SLOT_MS = {
  card: (AT.bodyIn + DUR.base) * 1000 + 50,
  tryIt: (AT.doneSwap + ENTRANCE.onboarding.filter) * 1000 + 50
} as const
/** Chip glyphs: the granted check pops (`spring.pop`), the others swap small. */
const glyphOut = { opacity: 0, scale: 0, transition: at(DUR.flash, EASE.exit) }
const GLYPH: Record<'check' | 'other', Variants> = {
  check: { ...PRESET.signaturePop, exit: glyphOut },
  other: { ...PRESET.popIn, exit: glyphOut }
}
/** Tracker number to check: the digit swap at its small-size values (a 12 px
    glyph: it moves and fades, and leaves the blur slots to the words). */
const D = WORD_VARIANTS.digits
const trackGlyph: Variants = {
  initial: { opacity: 0, y: D.yFs * 12 },
  animate: (delay: number) => ({ opacity: 1, y: 0, transition: at(D.enter, D.enterEase, delay) }),
  exit: (delay: number) => ({ opacity: 0, y: -D.yFs * 12, transition: at(D.exit, D.exitEase, delay) })
}

const GLYPH_ICON: Record<Exclude<Glyph, 'dot'>, IconName> = {
  check: 'check', error: 'error', hourglass: 'hourglass', download: 'download'
}

/**
 * First-run setup (Onboarding: 1 · Microphone / denied, 2 · Accessibility,
 * 3 · Speech model, Done), and the place the hub banner, Settings › General and a refused dictation
 * send you back to. It covers the whole window, title bar included. Status is
 * polled while it is open, because the grant happens in System Settings and
 * nothing tells us when it lands.
 */
export default function Permissions({ firstRun, toggleShortcut, onDone, onOpenSettings }: {
  firstRun: boolean; toggleShortcut: string; onDone: () => void
  /** Closes this screen and opens a Settings pane (the Try it tile's mic problem). */
  onOpenSettings?: (pane: FlowSettingsPane) => void
}): React.JSX.Element {
  const [perms, setPerms] = useState<FlowPerms | null>(null)
  const platform = usePlatform()
  const w = words(platform.os)
  const pretty = (accel: string): string => prettyFor(accel, platform.os)
  // Step 2 exists only where the OS has an Accessibility grant (macOS). Without
  // it the speech model is step 2, and `perms.ax` is always true.
  const hasAx = has(platform, 'accessibility')
  // Without `insert` (Wayland) a dictation is copied, never typed.
  const typed = has(platform, 'insert')
  // The system Accessibility dialog only shows once; after that, open the pane.
  const [axAsked, setAxAsked] = useState(false)
  // Allow was clicked and the macOS prompt is up.
  const [micWaiting, setMicWaiting] = useState(false)
  const [holdKey, setHoldKey] = useState(63)
  const [open, setOpen] = useState<Open | null>(null)
  const [rings, setRings] = useState({ mic: 0, ax: 0, model: 0 })
  // Step 3. First run fetches the missing model by itself; a later visit only reports.
  const model = useSpeechModel(firstRun)
  const [said, setSaid] = useState('')
  const shown = useWindowShown(onWinShown)
  const reduced = useReduceMotion()
  const [, animate] = useAnimate()
  // Whether the surface coming in with the current swap holds a filter slot.
  const [blurIn1, setBlurIn1] = useState(false)

  const root = useRef<HTMLDivElement>(null)
  const boxes = useRef<Record<StepId, HTMLElement | null>>({ mic: null, ax: null, model: null })
  // Heights just before a swap, so each box animates from what is on screen.
  const from = useRef<{ h: Record<StepId, number>; spring: SpringToken } | null>(null)
  const runs = useRef({ mic: 0, ax: 0, model: 0 })
  // A grant auto-advances only when it follows a click made here, in this session.
  const acted = useRef({ mic: false, ax: false })
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const prev = useRef<{ mic: boolean; ax: boolean; model: boolean } | null>(null)
  const mounted = useRef(false)
  // Both were granted when the screen opened: Done renders at rest.
  const doneAtMount = useRef(false)

  useEffect(() => {
    const poll = (): void => void window.flow.perms.status().then(setPerms)
    poll()
    const t = setInterval(poll, 1000)
    const off = window.flow.perms.onChanged(setPerms)
    // Back from System Settings: start the result a beat after focus, so it is seen.
    let late: ReturnType<typeof setTimeout> | undefined
    const onFocus = (): void => { clearTimeout(late); late = setTimeout(poll, DUR.micro * 1000) }
    window.addEventListener('focus', onFocus)
    void window.flow.settings.get().then((s) => setHoldKey(s.holdKey))
    const pending = timers.current
    return () => {
      clearInterval(t); clearTimeout(late); off()
      window.removeEventListener('focus', onFocus)
      pending.forEach(clearTimeout)
      pending.clear()
    }
  }, [])

  // Capture phase, so Settings (also listening on document) sees it handled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (!firstRun) onDone()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [firstRun, onDone])

  const micOk = perms?.mic === 'granted' || perms?.mic === 'unknown'
  const micAsk = perms?.mic === 'not-determined'
  const micOff = !!perms && !micOk && !micAsk
  const axOk = !!perms?.ax
  const done = micOk && axOk
  const modelOk = model.ready
  const modelKnown = model.state !== 'checking'
  // Everything is in place: the Done screen can offer Try it.
  const allSet = done && modelOk
  const toggle = toggleShortcut || 'Control+Alt+D'
  const hold = holdKeyFor(holdKey, platform)
  const live = useRef({ micOk, axOk, modelOk, open })
  live.current = { micOk, axOk, modelOk, open }
  /** Where the flow goes once a step is settled: the first one still open. */
  const nextOpen = (now: { micOk: boolean; axOk: boolean; modelOk: boolean }): Open =>
    !now.micOk ? 'mic' : !now.axOk ? 'ax' : !now.modelOk ? 'model' : 'none'

  /** Swap the expanded step. Heights are read now and animated once the new layout is in. */
  const go = (next: Open, spring: SpringToken = SPRING.morph): void => {
    // One slot for what comes in, taken now: the labels that change with it take theirs after.
    const slot = isReducedMotion() ? 0 : filterBudget.take(1)
    setBlurIn1(slot === 1)
    if (slot) {
      const t = setTimeout(() => { timers.current.delete(t); filterBudget.release(1) }, next === 'none' ? SLOT_MS.tryIt : SLOT_MS.card)
      timers.current.add(t)
    }
    const h = (id: StepId): number => boxes.current[id]?.getBoundingClientRect().height ?? 0
    from.current = { h: { mic: h('mic'), ax: h('ax'), model: h('model') }, spring }
    setOpen(next)
  }
  const later = (fn: () => void, seconds: number): void => {
    if (isReducedMotion() || seconds <= 0) { fn(); return }
    const t = setTimeout(() => { timers.current.delete(t); fn() }, seconds * 1000)
    timers.current.add(t)
  }

  // First status: open the first step that still needs a grant.
  useEffect(() => {
    if (!perms || !modelKnown || open !== null) return
    doneAtMount.current = allSet
    prev.current = { mic: micOk, ax: axOk, model: modelOk }
    // A later visit with the model still on its way lands on Done ("Getting ready").
    setOpen(!micOk ? 'mic' : !axOk ? 'ax' : !modelOk && firstRun ? 'model' : 'none')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms, modelKnown])

  // The granted flip (§4.6.3) and Done (§4.6.4). The chip, tracker and headline
  // follow the status directly; only the card swap is held back.
  useEffect(() => {
    const was = prev.current
    if (!perms || !was) return
    prev.current = { mic: micOk, ax: axOk, model: modelOk }
    if (micOk) setMicWaiting(false)
    if (micOk && !was.mic && acted.current.mic) {
      setRings((r) => ({ ...r, mic: r.mic + 1 }))
      setSaid('Microphone allowed')
      later(() => {
        const now = live.current
        if (now.open === 'mic') go(nextOpen(now))
      }, AT.flipSwap)
    }
    if (axOk && !was.ax && acted.current.ax) {
      setRings((r) => ({ ...r, ax: r.ax + 1 }))
      setSaid(modelOk ? 'Accessibility allowed. You’re set.' : 'Accessibility allowed.')
      later(() => {
        const now = live.current
        if (now.open === 'ax' && now.micOk) go(nextOpen(now))
      }, AT.doneSwap)
    }
    // The model arrived: the same flip as a grant, then on to what is left.
    if (modelOk && !was.model) {
      setRings((r) => ({ ...r, model: r.model + 1 }))
      setSaid(done ? 'Speech model ready. You’re set.' : 'Speech model ready.')
      later(() => {
        const now = live.current
        if (now.open === 'model') go(nextOpen(now))
      }, AT.flipSwap)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOk, axOk, modelOk])

  // Step card and row trade real heights: measured, never a fixed number.
  useLayoutEffect(() => {
    const f = from.current
    from.current = null
    if (!f || isReducedMotion()) return
    for (const id of STEPS) {
      const el = boxes.current[id]
      if (!el) continue
      el.style.height = ''
      el.style.flex = ''
      const to = el.getBoundingClientRect().height
      if (Math.abs(to - f.h[id]) < 0.5) continue
      const run = ++runs.current[id]
      el.style.flex = 'none'
      void animate(el, { height: [f.h[id], to] }, f.spring).then(() => {
        if (runs.current[id] !== run) return
        el.style.height = ''
        el.style.flex = ''
      })
    }
  }, [open, animate])

  // Focus follows the expanded step's primary action, or the footer button.
  const focusPrimary = (): void => {
    const el = root.current?.querySelector<HTMLElement>('.ob-box.is-open [data-primary]:not(:disabled)')
      ?? root.current?.querySelector<HTMLElement>('.ob-foot .q-btn:not(:disabled)')
    el?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (open === null) return
    mounted.current = true
    focusPrimary()
  }, [open])
  // A status change can unmount the focused button; focus never falls to <body>.
  useEffect(() => {
    if (open !== null && !root.current?.contains(document.activeElement)) focusPrimary()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOk, axOk, micOff, model.state])

  const allowMic = async (): Promise<void> => {
    acted.current.mic = true
    setMicWaiting(true)
    try { setPerms(await window.flow.perms.requestMic()) } finally { setMicWaiting(false) }
  }
  const allowAx = async (): Promise<void> => {
    acted.current.ax = true
    if (axAsked) { window.flow.perms.open('ax'); return }
    setAxAsked(true)
    setPerms(await window.flow.perms.requestAx())
  }
  const openPane = (which: 'mic' | 'ax'): void => {
    acted.current[which] = true
    window.flow.perms.open(which)
  }

  // Out of setup and straight to a Settings pane.
  const leaveTo = (pane: FlowSettingsPane): void => {
    if (onOpenSettings) onOpenSettings(pane)
    else { onDone(); window.flow.hub.openSettings(pane) }
  }
  // Try it, mic problem: the input list.
  const micSettings = (): void => leaveTo('dictation')
  // The cloud needs a key, so the user lands where it is entered. The download stops.
  const useCloud = async (): Promise<void> => {
    await model.useCloud()
    leaveTo('models')
  }

  const header = (
    <header className="ob-tb">
      <div className="ob-tb__left">
        {/* The placeholder under the macOS traffic lights; Windows and Linux have their buttons on the right. */}
        {platform.windowControls === 'left' && <div className="ob-tb__lights" aria-hidden><span /><span /><span /></div>}
        <div className="ob-tb__brand">
          <AppMark size={20} active />
          <span className="ob-tb__wordmark">Quill</span>
        </div>
      </div>
      <div className="ob-tb__right">
        <span className="ob-mono">{firstRun ? 'SETUP' : 'PERMISSIONS'}</span>
      </div>
    </header>
  )
  const label = firstRun ? 'Before you dictate' : 'Permissions'

  if (!perms || !modelKnown || open === null) {
    return <div className="ob" role="dialog" aria-modal="true" aria-label={label}>{header}</div>
  }

  const modelStep = hasAx ? 3 : 2
  // "Both permissions are on." where there are two; the microphone alone elsewhere.
  const permsOn = hasAx ? 'Both permissions are on.' : 'The microphone is on.'
  const accent: Accent = open === 'mic' ? 'violet' : open === 'ax' ? 'tangerine' : open === 'model' ? 'cyan'
    : done ? 'lime' : micOk ? 'tangerine' : 'violet'
  const stopped = model.state === 'failed' || model.state === 'idle'
  const modelStatus: Status = modelOk ? { tone: 'granted', label: 'Ready', glyph: 'check' }
    : model.state === 'failed' ? { tone: 'missing', label: 'Failed', glyph: 'error' }
      : model.state === 'idle' ? { tone: 'missing', label: 'Not downloaded', glyph: 'error' }
        : { tone: 'checking', label: 'Downloading', glyph: 'download' }
  // Done, but the model is still on its way ("Try it · Getting ready").
  const almost = done && !modelOk && open === 'none'
  const micStatus: Status = micOk ? { tone: 'granted', label: 'Allowed', glyph: 'check' }
    : micWaiting ? { tone: 'checking', label: w.waiting, glyph: 'dot' }
      : micAsk ? { tone: 'checking', label: 'Not asked yet', glyph: 'hourglass' }
        : { tone: 'missing', label: 'Turned off', glyph: 'error' }
  const axStatus: Status = axOk ? { tone: 'granted', label: 'Allowed', glyph: 'check' }
    : axAsked ? { tone: 'checking', label: w.waiting, glyph: 'dot' }
      : { tone: 'checking', label: 'Not asked yet', glyph: 'hourglass' }

  // The entrance plays on first run only; a re-entry renders at rest.
  const enter = firstRun && !doneAtMount.current && !reduced
  const stage = enter ? (shown ? 'animate' : 'initial') : false
  const tile = (start: number, blur?: number): object => enter
    ? { variants: PRESET.onboardingTile, custom: { start, blur }, initial: 'initial', animate: stage }
    : { initial: false }
  const headlineDelay = mounted.current ? 0 : enter ? AT.headline : AT.headlineReentry

  // Footer: one note and one button, whose label and tone follow the state.
  const foot: { note: string; label: string; variant: ButtonVariant; act?: () => void; waiting?: boolean } = open === 'model' && !modelOk
    ? {
        note: stopped ? 'Try again, or use the cloud to keep going.' : 'Try it unlocks when the download finishes.',
        // Never a dead end: setup can be left here. The download carries on in
        // main, and the Dictation hero reports it until the model is there.
        label: stopped ? 'Continue anyway' : 'Continue while it downloads', variant: 'ghost', act: onDone
      }
    : !micOk
    ? firstRun
      // Never a dead end: a denied or restricted mic must not lock the hub away.
      // Onboarding is marked done and the hub shows its mic banner.
      ? { note: 'Quill can’t hear you until the microphone is allowed.', label: 'Continue without it', variant: 'ghost', act: onDone }
      : { note: 'Allow the microphone to continue.', label: 'Close', variant: 'ghost', act: onDone }
    : axOk
      ? {
          note: modelOk ? (hold ? 'All set. Hold the key, speak, let go.' : `All set. Press ${pretty(toggle)}, speak, press it again.`)
            : stopped ? 'Almost there. The speech model still has to be downloaded.'
              : 'Almost there. The speech model is still downloading.',
          label: 'Done', variant: 'primary', act: onDone
        }
      : open === 'mic'
        ? { note: 'Microphone allowed.', label: 'Continue', variant: 'primary', act: () => go(nextOpen({ micOk, axOk, modelOk })) }
        : {
            note: `Continue without it: ${pretty(toggle)} still works, and the text is copied for you to paste.`,
            // Skipping step 2 on first run still passes step 3 while the model is on its way.
            label: 'Continue without it', variant: 'ghost',
            act: firstRun && !modelOk && open !== 'none' ? () => go('model') : onDone
          }

  return (
    <div ref={root} className="ob" role="dialog" aria-modal="true" aria-label={label}>
      {header}

      <div className="ob-bento">
        {/* "Tile / Setup hero" */}
        <m.section className={`ob-hero ob-accent--${accent}`} {...tile(AT.hero)}>
          <div className="ob-hero__top">
            <m.span className="ob-hero__blur" {...(enter ? { variants: blurIn, custom: BLUR.lg, initial: 'initial', animate: stage } : {})}>
              <BlurWords variant="label" className="ob-mono ob-mono--ink" text={allSet ? 'SETUP COMPLETE' : almost ? 'SETUP' : 'BEFORE YOU DICTATE'} />
            </m.span>
            <BlurWords
              as="h1"
              variant="headline"
              className="ob-hero__headline"
              initial={!doneAtMount.current}
              hold={!shown}
              delay={headlineDelay}
              text={allSet ? 'You’re set.' : almost ? 'Almost there.' : hasAx ? 'Three steps, then talk.' : 'Two steps, then talk.'}
            />
            <m.div className="ob-hero__blur" {...(enter ? { variants: blurIn, custom: BLUR.lg, initial: 'initial', animate: stage } : {})}>
              <BlurWords
                as="p"
                variant="block"
                initial={false}
                className="ob-hero__body"
                text={allSet
                  ? `${permsOn} Quill sits in the background until you ${hold ? `hold ${hold.key}` : `press ${pretty(toggle)}`}.`
                  : almost
                    ? `${permsOn} ${stopped ? 'The speech model still has to be downloaded.' : 'The speech model is still downloading.'}`
                    : hasAx
                      ? 'Quill needs two permissions from macOS and a speech model. This screen updates as each one is ready.'
                      : 'Quill needs the microphone and a speech model. This screen updates as each one is ready.'}
              />
            </m.div>
          </div>
          <div className="ob-tracker">
            <TrackerStep
              i={0}
              n={1}
              label="Microphone"
              state={micOk ? 'done' : 'now'}
              text={micOk ? 'Allowed' : micOff ? 'Turned off' : 'Now'}
              delay={AT.trackerCheck}
              stage={stage}
              reduced={reduced}
            />
            {hasAx && (
              <TrackerStep
                i={1}
                n={2}
                label="Accessibility"
                state={axOk ? 'done' : open === 'ax' ? 'now' : 'next'}
                text={axOk ? 'Allowed' : open === 'ax' ? 'Now' : 'Next'}
                delay={0}
                stage={stage}
                reduced={reduced}
              />
            )}
            <TrackerStep
              i={hasAx ? 2 : 1}
              n={modelStep}
              label="Speech model"
              state={modelOk ? 'done' : open === 'model' ? 'now' : 'next'}
              text={modelOk ? 'Ready' : modelStatus.label}
              delay={AT.trackerCheck}
              stage={stage}
              reduced={reduced}
            />
          </div>
        </m.section>

        <div className="ob-steps">
          <StepBox
            boxRef={(el) => { boxes.current.mic = el }}
            n={1}
            of={modelStep}
            icon="microphone"
            accent="violet"
            open={open === 'mic'}
            rowTitle="Microphone"
            status={micStatus}
            ring={rings.mic}
            onExpand={!micOk ? () => go('mic', SPRING.ui) : undefined}
            motion={tile(AT.step1, BLUR.md)}
            blurIn={blurIn1}
            reduced={reduced}
            title="Let Quill listen"
            body={micOk
              ? 'Quill only listens while you are dictating.'
              : micOff
                ? platform.os === 'macos' ? 'Turned off for Quill. Switch it on under Privacy & Security › Microphone.'
                  : platform.os === 'windows' ? `Turned off in Windows. Let desktop apps use the microphone under ${w.micPath}.`
                    : `The microphone is not available. Check ${w.micPath}.`
                : `To hear you. Quill only listens while you are dictating${hold ? `: hold ${hold.key}, speak, let go` : ''}.`}
            note={micOff ? 'This screen updates as soon as you switch it on, no relaunch.' : undefined}
            actions={!micOk && (
              <ActionButton
                primary
                variant={micOff ? 'primary' : 'accent'}
                disabled={micWaiting}
                onClick={micOff ? () => openPane('mic') : () => void allowMic()}
                label={micOff ? w.openSettings : 'Allow microphone'}
              />
            )}
          />

          {hasAx && <StepBox
            boxRef={(el) => { boxes.current.ax = el }}
            n={2}
            of={modelStep}
            icon="accessibility"
            accent="tangerine"
            open={open === 'ax'}
            rowTitle="Accessibility"
            status={axStatus}
            ring={rings.ax}
            pill={!axOk ? 'Next' : undefined}
            onExpand={!axOk && micOk ? () => go('ax', SPRING.ui) : undefined}
            motion={tile(AT.step2, BLUR.sm)}
            blurIn={blurIn1}
            reduced={reduced}
            title="Let Quill type for you"
            body={axAsked
              ? 'Switch Quill on under Privacy & Security › Accessibility; it works straight away, no relaunch.'
              : 'For the hold-to-talk key and for typing your words into other apps.'}
            note={axAsked
              ? 'Already on? An update can stale the grant: remove Quill with −, then add it again.'
              : 'Without it, the hold key is inactive and dictations are copied instead of typed.'}
            actions={!axOk && (
              <>
                <ActionButton primary variant="accent" className="ob-btn--tangerine" onClick={() => void allowAx()} label="Allow" />
                <Button variant="ghost" onClick={() => openPane('ax')}>Open System Settings</Button>
              </>
            )}
          />}

          <StepBox
            boxRef={(el) => { boxes.current.model = el }}
            n={modelStep}
            of={modelStep}
            icon="chip"
            accent="cyan"
            open={open === 'model'}
            rowTitle={model.state === 'cloud' ? 'Using the cloud' : 'Speech model'}
            status={modelStatus}
            ring={rings.model}
            pill={model.state === 'downloading' ? `${model.percent}%` : undefined}
            progress={model.state === 'downloading' && model.total ? model.received / model.total : undefined}
            onExpand={!modelOk ? () => go('model', SPRING.ui) : undefined}
            motion={tile(AT.step2, BLUR.sm)}
            blurIn={blurIn1}
            reduced={reduced}
            title="Get the speech model"
            body={modelOk
              ? `The speech model is on ${w.device}.`
              : model.state === 'failed'
                ? 'The download stopped. Check your connection.'
                : `Quill transcribes on ${w.device}. It needs a speech model first: ${model.name}, ${fmtBytes(model.bytes)}, ${model.multilingual ? 'understands about 99 languages' : 'English only'}.`}
            extra={model.state === 'downloading' ? <Download model={model} className="ob-dl--card" /> : undefined}
            actions={!modelOk && (
              stopped ? (
                <>
                  <ActionButton
                    primary
                    variant="accent"
                    className="ob-btn--cyan"
                    onClick={model.start}
                    label={model.state === 'failed' ? 'Try again' : 'Download'}
                  />
                  <Button variant="ghost" onClick={() => void useCloud()}>Use the cloud instead</Button>
                </>
              ) : (
                <button type="button" className="ob-link" data-primary="" onClick={() => void useCloud()}>
                  Use the cloud instead
                </button>
              )
            )}
          />

          <AnimatePresence initial={!doneAtMount.current}>
            {done && open === 'none' && (
              <m.section
                key="try"
                className="ob-try"
                variants={reduced ? CUT : tryIn}
                custom={blurIn1}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {modelOk
                  ? <TryIt holdKey={hold?.key} toggle={toggle} typed={typed} onMicSettings={micSettings} />
                  : <GettingReady model={model} />}
              </m.section>
            )}
          </AnimatePresence>

          {/* "Footer" */}
          <m.div className="ob-foot" {...(enter ? { variants: footIn, initial: 'initial', animate: stage } : {})}>
            <BlurWords as="p" variant="block" initial={false} className="ob-foot__note" text={foot.note} />
            <ActionButton
              variant={foot.variant}
              className={foot.waiting ? 'ob-btn--waiting' : undefined}
              disabled={!foot.act}
              onClick={foot.act}
              label={foot.label}
              delay={done ? AT.footDone : 0}
            />
          </m.div>
        </div>
      </div>

      <span className="m-sr-only" role="status" aria-live="polite">{said}</span>
    </div>
  )
}

/** A button whose label swaps in place (`label`) while its real width follows. */
function ActionButton({ label, delay = 0, primary, ...rest }: {
  label: string; delay?: number; primary?: boolean
  variant: ButtonVariant; className?: string; disabled?: boolean; onClick?: () => void
}): React.JSX.Element {
  return (
    <Button data-primary={primary ? '' : undefined} {...rest}>
      <BlurWords variant="label" animateWidth delay={delay} text={label} />
    </Button>
  )
}

/** One line of the hero's "Tracker": number (or check), label, state. */
function TrackerStep({ i, n, label, state, text, delay, stage, reduced }: {
  i: number; n: number; label: string; state: 'done' | 'now' | 'next'; text: string; reduced: boolean
  /** When the number gives way to the check, inside the granted flip. */
  delay: number; stage: 'initial' | 'animate' | false
}): React.JSX.Element {
  const enter = stage !== false
  return (
    <m.div
      className="ob-track"
      {...(enter
        ? {
            variants: PRESET.fadeUpStagger({ start: AT.tracker, step: STAGGER.list, duration: DUR.fast }),
            custom: i, initial: 'initial', animate: stage
          }
        : {})}
    >
      <span className={`ob-track__n is-${state}`}>
        <AnimatePresence mode="popLayout" initial={false} custom={delay}>
          <m.span
            key={state === 'done' ? 'check' : 'n'}
            className="ob-track__glyph"
            variants={reduced ? CUT : trackGlyph}
            custom={delay}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {state === 'done' ? <Icon name="check" active /> : n}
          </m.span>
        </AnimatePresence>
      </span>
      <span className="ob-track__label">{label}</span>
      <BlurWords variant="label" className="ob-track__state" delay={state === 'done' ? delay : 0} text={text} />
    </m.div>
  )
}

/** Permission state chip: one pill whose real width follows its label. */
function PermChip({ status }: { status: Status }): React.JSX.Element {
  return (
    <span className={`q-status q-status--${status.tone} ob-chip`}>
      <RealWidth style={{ overflow: 'clip', overflowClipMargin: 6 }}>
        <span className="ob-chip__in">
          <span className="ob-chip__slot">
            <AnimatePresence mode="popLayout" initial={false}>
              <m.span
                key={status.glyph}
                className="ob-chip__glyph"
                variants={status.glyph === 'check' ? GLYPH.check : GLYPH.other}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {status.glyph === 'dot'
                  ? <m.span className="ob-chip__dot" {...PRESET.pulse} />
                  : <Icon name={GLYPH_ICON[status.glyph]} />}
              </m.span>
            </AnimatePresence>
          </span>
          <BlurWords variant="label" text={status.label} />
        </span>
      </RealWidth>
    </span>
  )
}

/**
 * One permission: "Permission Step" (E29iO) when expanded, "Permission Row"
 * (FalvR) when collapsed. The box keeps its place and trades real height; the
 * two layouts cross-fade inside it.
 */
function StepBox({ boxRef, n, of, icon, accent, open, rowTitle, status, ring, pill, progress, onExpand, motion, title, body, note, extra, actions, blurIn, reduced }: {
  boxRef: (el: HTMLElement | null) => void
  n: number
  /** How many steps there are here: three on macOS, two where there is no Accessibility grant. */
  of: number
  icon: 'microphone' | 'accessibility' | 'chip'; accent: Accent; open: boolean
  rowTitle: string; status: Status
  /** Bumped once per grant made here: one ring on the icon tile. */
  ring: number
  /** Collapsed: a plain pill in place of the status chip ("Next", "33%"). */
  pill?: string
  /** Collapsed, 0 to 1: the 3 px bar along the row's bottom edge ("Progress" tufbC). */
  progress?: number
  onExpand?: () => void
  motion: object
  title: string; body: string; note?: string
  /** Under the body, in the note's place (the "Download" block). */
  extra?: ReactNode
  actions: ReactNode
  /** The card coming in holds the swap's one filter slot. */
  blurIn: boolean
  reduced: boolean
}): React.JSX.Element {
  return (
    <m.section ref={boxRef} className={`ob-box ${open ? 'is-open' : 'is-closed'}`} {...motion}>
      <AnimatePresence mode="popLayout" initial={false}>
        {open ? (
          <Swap key="card" className="ob-step" variants={reduced ? CUT : cardSwap} custom={blurIn}>
            <div className="ob-step__head">
              <span className={`ob-step__tile ob-accent--${accent}`}>
                <Icon name={icon} size={32} active />
                {ring > 0 && <m.span key={ring} className="ob-step__ring" aria-hidden {...ringProps} />}
              </span>
              <PermChip status={status} />
            </div>
            <div className="ob-step__text">
              <span className="ob-step__n">STEP {n} OF {of}</span>
              <h2 className="ob-step__title">{title}</h2>
              <BlurWords as="p" variant="block" initial={false} className="ob-step__body" text={body} />
              {note && <BlurWords as="p" variant="block" initial={false} className="ob-step__note" text={note} />}
              {extra}
            </div>
            <div className="ob-step__actions">{actions}</div>
          </Swap>
        ) : (
          <Swap key="row" className={`ob-row ${onExpand ? 'is-link' : ''}`} variants={reduced ? CUT : rowSwap} onActivate={onExpand}>
            <span className="ob-row__tile"><Icon name={icon} size={20} /></span>
            <div className="ob-row__text">
              <span className="ob-mono">STEP {n} OF {of}</span>
              <span className="ob-row__title">{rowTitle}</span>
            </div>
            {pill ? <Pill className="ob-row__pill">{pill}</Pill> : <PermChip status={status} />}
          </Swap>
        )}
      </AnimatePresence>
      {!open && progress !== undefined && (
        <div className="ob-row__bar" aria-hidden>
          <span className="ob-row__fill" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </m.section>
  )
}

const RING = PRESET.ring()
const ringProps = {
  initial: RING.initial as { scale: number; opacity: number },
  animate: RING.animate as { scale: number; opacity: number },
  transition: { ...RING.transition, delay: AT.ring }
}

/** The card or row inside a step box; inert from its first exit frame. */
function Swap({ className, variants, custom, children, onActivate, ref }: {
  className: string; variants: Variants; custom?: boolean; children: ReactNode
  /** Makes the whole layout a button (a collapsed row that can be expanded). */
  onActivate?: () => void
  ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      ref={ref}
      className={className}
      inert={inert.inert}
      style={inert.style}
      variants={variants}
      custom={custom}
      initial="initial"
      animate="animate"
      exit="exit"
      {...(onActivate
        ? {
            role: 'button', tabIndex: 0, onClick: onActivate,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() }
            }
          }
        : {})}
    >
      {children}
    </m.div>
  )
}
